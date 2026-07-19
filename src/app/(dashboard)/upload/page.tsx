'use client'

import { useState, useCallback } from 'react'
import {
  detectFileType,
  estimateFacility,
  parseFileToRows,
  parseXlsx,
  parseRateSheet,
  transformByType,
  decodeCp932,
} from '@/lib/etl'
import type { DetectionResult, UploadPayload, UploadResult } from '@/lib/etl'
import { parsePlCsv } from '@/lib/etl/pl-parser'
import { parseAttendanceHtml, type FacilityMapping } from '@/lib/etl/attendance-parser'
import { parseReviewCsv, type ReviewInsert } from '@/lib/etl/review-parser'
import { supabase } from '@/lib/supabase/client'
import { fetchAll } from '@/lib/supabase/fetch-all'
import { useFacility } from '@/lib/facility-context'

// Supabaseのエラーは Error インスタンスでないため、メッセージを確実に取り出す
const errMsg = (e: unknown): string =>
  e instanceof Error ? e.message
    : (e && typeof e === 'object' && 'message' in e) ? String((e as { message: unknown }).message)
    : String(e)

interface PlEntry { name: string; fy: string; rows: number; status: 'processing' | 'done' | 'error'; error?: string }
interface AttEntry { name: string; workDate: string; rows: number; staff: number; skipped?: number; status: 'processing' | 'done' | 'error'; error?: string }
// クチコミ: ドロップ→プレビュー(pending)→確定でUPSERT
interface RevEntry { name: string; source: string; rows: ReviewInsert[]; skipped: number; minDate: string | null; maxDate: string | null; status: 'pending' | 'done' | 'error'; inserted?: number; error?: string }

interface FileEntry {
  file: File
  detection: DetectionResult | null
  facility: string | null
  status: 'pending' | 'processing' | 'done' | 'error'
  result?: UploadResult
  error?: string
}

export default function UploadPage() {
  const { facilities: allowedFacilities } = useFacility()  // 権限のある宿のみ（RLSと整合）
  const [files, setFiles] = useState<FileEntry[]>([])
  const [facilityList, setFacilityList] = useState<
    { facility: string; name: string; short_name: string | null; rooms_json: unknown }[]
  >([])
  const [uploading, setUploading] = useState(false)
  const [globalFacility, setGlobalFacility] = useState<string>('')
  const [tab, setTab] = useState<'sales' | 'pl' | 'attendance' | 'review'>('sales')
  const [plFiles, setPlFiles] = useState<PlEntry[]>([])
  const [plUploading, setPlUploading] = useState(false)
  const [attFiles, setAttFiles] = useState<AttEntry[]>([])
  const [attUploading, setAttUploading] = useState(false)
  // クチコミ取込
  const [revFiles, setRevFiles] = useState<RevEntry[]>([])
  const [revUploading, setRevUploading] = useState(false)
  // 楽天 集計値フォーム（宿カルテ転記）
  const [rkMonth, setRkMonth] = useState(() => { const d = new Date(); d.setMonth(d.getMonth() - 1); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}` })
  const [rkCount, setRkCount] = useState<number | ''>('')
  const [rkAvg, setRkAvg] = useState<number | ''>('')
  const [rkAxes, setRkAxes] = useState<Record<string, number | ''>>({ 'サービス': '', '立地': '', '部屋': '', '設備・アメニティ': '', '風呂': '', '食事': '' })
  const [rkRanking, setRkRanking] = useState('')
  const [rkMsg, setRkMsg] = useState('')

  // クチコミCSV: ドロップ時にパースしてプレビュー（確定までDBに書かない）
  const handleRevFiles = async (fileList: FileList | null) => {
    if (!fileList || fileList.length === 0) return
    const facility = globalFacility
    if (!facility) { alert('上部の「デフォルト宿」を選択してください（クチコミの帰属宿）'); return }
    for (const file of Array.from(fileList)) {
      try {
        const text = decodeCp932(await file.arrayBuffer())
        const r = parseReviewCsv(text, facility)
        setRevFiles((prev) => [...prev, { name: file.name, source: r.source === 'jalan' ? 'じゃらん' : '一休', rows: r.rows, skipped: r.skipped, minDate: r.minDate, maxDate: r.maxDate, status: 'pending' }])
      } catch (err) {
        setRevFiles((prev) => [...prev, { name: file.name, source: '不明', rows: [], skipped: 0, minDate: null, maxDate: null, status: 'error', error: errMsg(err) }])
      }
    }
  }

  // プレビュー確定 → UPSERT（facility,source,source_review_id で重複排除）
  const commitReviews = async () => {
    setRevUploading(true)
    for (const entry of revFiles) {
      if (entry.status !== 'pending' || entry.rows.length === 0) continue
      const upd = (patch: Partial<RevEntry>) => setRevFiles((prev) => prev.map((p) => (p === entry ? { ...p, ...patch } : p)))
      try {
        let inserted = 0
        for (let i = 0; i < entry.rows.length; i += 200) {
          const { error, count } = await supabase.from('raw_review')
            .upsert(entry.rows.slice(i, i + 200), { onConflict: 'facility,source,source_review_id', count: 'exact' })
          if (error) throw error
          inserted += count ?? 0
        }
        upd({ status: 'done', inserted })
      } catch (err) {
        upd({ status: 'error', error: errMsg(err) })
      }
    }
    setRevUploading(false)
  }

  // 楽天 集計値の保存
  const saveRakuten = async () => {
    const facility = globalFacility
    if (!facility) { setRkMsg('デフォルト宿を選択してください'); return }
    if (!rkMonth) { setRkMsg('対象月を選択してください'); return }
    const axis: Record<string, number> = {}
    for (const [k, v] of Object.entries(rkAxes)) if (v !== '') axis[k] = Number(v)
    const { error } = await supabase.from('raw_review_summary').upsert({
      facility, source: 'rakuten', month: rkMonth,
      review_count: rkCount === '' ? null : Number(rkCount),
      overall_avg: rkAvg === '' ? null : Number(rkAvg),
      axis_scores: Object.keys(axis).length ? axis : null,
      area_ranking: rkRanking || null,
    }, { onConflict: 'facility,source,month' })
    setRkMsg(error ? `Error: ${error.message}` : `楽天集計値を保存しました（${rkMonth}）`)
  }

  // 勤怠CSV（Touch On Time / HTML）取込: 全宿一括。宿選択は不要。
  const handleAttFiles = async (fileList: FileList | null) => {
    if (!fileList || fileList.length === 0) return
    setAttUploading(true)
    // 宿マッピングをDBから取得（データ駆動。宿追加はdim_facility_mappingに行追加で完結）
    let mapping: FacilityMapping | undefined
    try {
      const { data } = await supabase.from('dim_facility_mapping').select('attendance_code, attendance_name, facility')
      const rows = (data as { attendance_code: string; attendance_name: string | null; facility: string | null }[]) ?? []
      if (rows.length) {
        const code: Record<string, string> = {}
        const name: [string, string][] = []
        for (const r of rows) {
          if (r.facility) {
            code[r.attendance_code] = r.facility
            if (r.attendance_name && r.facility !== 'HQ') name.push([r.attendance_name, r.facility])
          }
        }
        mapping = { code, name }
      }
    } catch { /* 取得不可時はパーサー内蔵の既定マップにフォールバック */ }
    // ファイル名順（=日付順）で安定処理
    const list = Array.from(fileList).sort((a, b) => a.name.localeCompare(b.name))
    for (const file of list) {
      const entry: AttEntry = { name: file.name, workDate: '', rows: 0, staff: 0, status: 'processing' }
      setAttFiles((prev) => [...prev, entry])
      const upd = (patch: Partial<AttEntry>) => setAttFiles((prev) => prev.map((p) => (p === entry ? { ...p, ...patch } : p)))
      try {
        const html = await file.text() // UTF-8
        const { workDate, rows, staff } = parseAttendanceHtml(html, file.name, mapping)
        if (!workDate || rows.length === 0) throw new Error('勤怠を解析できませんでした（フォーマット要確認）')
        // 従業員マスタ upsert（新規社員番号を追加）
        const staffPayload = staff.map((s) => ({ ...s, updated_at: new Date().toISOString() }))
        for (let i = 0; i < staffPayload.length; i += 500) {
          const { error } = await supabase.from('dim_staff').upsert(staffPayload.slice(i, i + 500), { onConflict: 'staff_code' })
          if (error) throw error
        }
        // 日次勤怠 upsert（未マッピング宿=nullの行は除外。同日同宿は上書き）
        const attPayload = rows.filter((r) => r.work_facility != null)
        const unmapped = rows.length - attPayload.length
        for (let i = 0; i < attPayload.length; i += 500) {
          const { error } = await supabase.from('raw_attendance_daily').upsert(attPayload.slice(i, i + 500), { onConflict: 'staff_code,work_date,work_facility' })
          if (error) throw error
        }
        upd({ workDate, rows: attPayload.length, staff: staff.length, skipped: unmapped, status: 'done' })
      } catch (err) {
        upd({ status: 'error', error: errMsg(err) })
      }
    }
    await refreshMarts()
    setAttUploading(false)
  }

  const handlePlFiles = async (fileList: FileList | null) => {
    if (!fileList || fileList.length === 0) return
    if (facilityList.length === 0) await loadFacilities()
    const facility = globalFacility
    if (!facility) { alert('上部の「デフォルト宿」を選択してください'); return }
    setPlUploading(true)
    for (const file of Array.from(fileList)) {
      const entry: PlEntry = { name: file.name, fy: '', rows: 0, status: 'processing' }
      setPlFiles((prev) => [...prev, entry])
      const upd = (patch: Partial<PlEntry>) => setPlFiles((prev) => prev.map((p) => (p === entry ? { ...p, ...patch } : p)))
      try {
        const text = decodeCp932(await file.arrayBuffer())
        const { fiscalYear, rows } = parsePlCsv(text)
        if (!fiscalYear || rows.length === 0) throw new Error('PLを解析できませんでした（フォーマット要確認）')
        const payload = rows.map((r) => ({ ...r, facility }))
        // 上書き: 同一 宿×年度 を削除してから投入
        await supabase.from('actual_monthly').delete().eq('facility', facility).eq('fiscal_year', fiscalYear)
        for (let i = 0; i < payload.length; i += 500) {
          const { error } = await supabase.from('actual_monthly').insert(payload.slice(i, i + 500))
          if (error) throw error
        }
        upd({ fy: fiscalYear, rows: payload.length, status: 'done' })
      } catch (err) {
        upd({ status: 'error', error: errMsg(err) })
      }
    }
    await refreshMarts()
    setPlUploading(false)
  }

  // マテリアライズドビュー導入時、取込後に集計を更新（未導入＝関数なしなら無害にスキップ）
  const refreshMarts = async () => { try { await supabase.rpc('refresh_all_marts') } catch { /* matview未導入時は無視 */ } }

  const loadFacilities = useCallback(async () => {
    const { data } = await supabase
      .from('dim_facility')
      .select('facility, name, short_name, rooms_json')
      .order('facility')
    // 権限のある宿のみ表示（memberが書込不可の宿を選んでRLSエラーになるのを防ぐ）
    const allowed = new Set(allowedFacilities.map((f) => f.facility))
    const list = ((data ?? []) as { facility: string; name: string; short_name: string | null; rooms_json: unknown }[])
      .filter((f) => allowed.size === 0 || allowed.has(f.facility))
    setFacilityList(list)
    return list
  }, [allowedFacilities])

  const handleDrop = useCallback(
    async (e: React.DragEvent) => {
      e.preventDefault()
      let facilities = facilityList
      if (facilities.length === 0) {
        facilities = await loadFacilities()
      }

      const droppedFiles = Array.from(e.dataTransfer.files)
      const entries: FileEntry[] = droppedFiles.map((file) => {
        const detection = detectFileType(file.name)
        const facility = detection
          ? (estimateFacility(file.name, facilities) ?? globalFacility) || null
          : null
        return { file, detection, facility, status: 'pending' as const }
      })

      setFiles((prev) => [...prev, ...entries])
    },
    [facilityList, globalFacility, loadFacilities]
  )

  const handleFileInput = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      if (!e.target.files) return
      let facilities = facilityList
      if (facilities.length === 0) {
        facilities = await loadFacilities()
      }

      const selectedFiles = Array.from(e.target.files)
      const entries: FileEntry[] = selectedFiles.map((file) => {
        const detection = detectFileType(file.name)
        const facility = detection
          ? (estimateFacility(file.name, facilities) ?? globalFacility) || null
          : null
        return { file, detection, facility, status: 'pending' as const }
      })

      setFiles((prev) => [...prev, ...entries])
      e.target.value = ''
    },
    [facilityList, globalFacility, loadFacilities]
  )

  const setFileFacility = (index: number, facility: string) => {
    setFiles((prev) =>
      prev.map((f, i) => (i === index ? { ...f, facility } : f))
    )
  }

  const removeFile = (index: number) => {
    setFiles((prev) => prev.filter((_, i) => i !== index))
  }

  const executeUpload = async () => {
    setUploading(true)
    const payloads: UploadPayload[] = []
    const fileIndexMap: number[] = []

    // Mark all as processing
    setFiles((prev) => prev.map((f) => (f.status === 'pending' ? { ...f, status: 'processing' as const } : f)))

    for (let i = 0; i < files.length; i++) {
      const entry = files[i]
      if (entry.status !== 'pending' && entry.status !== 'processing') continue
      if (!entry.detection || !entry.facility) {
        const isLincoln = entry.file.name.includes('予約検索')
        setFiles((prev) =>
          prev.map((f, idx) =>
            idx === i ? { ...f, status: 'error', error: isLincoln
              ? 'リンカーン（予約検索）は廃止されました。ステイシーの「予約情報」CSVをご利用ください'
              : '宿またはファイル種別が未設定' } : f
          )
        )
        continue
      }

      try {
        const buffer = await entry.file.arrayBuffer()

        if (entry.detection.type === 'rate_sheet') {
          const workbook = parseXlsx(buffer)
          const facilityData = facilityList.find((f) => f.facility === entry.facility)
          const rooms = Array.isArray(facilityData?.rooms_json)
            ? (facilityData.rooms_json as { name: string }[])
            : []
          const payload = parseRateSheet(workbook, entry.facility, rooms)
          payloads.push(payload)
          fileIndexMap.push(i)
        } else {
          const rows = parseFileToRows(buffer, entry.file.name)
          const payload = transformByType(
            entry.detection.type,
            rows,
            entry.facility,
            entry.file.name
          )
          payloads.push(payload)
          fileIndexMap.push(i)
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        setFiles((prev) =>
          prev.map((f, idx) => (idx === i ? { ...f, status: 'error', error: message } : f))
        )
      }
    }

    if (payloads.length > 0) {
      const BATCH_SIZE = 500
      const UPSERT_KEYS: Record<string, string> = {
        raw_reservation: 'facility,pms_id',
      }

      const results: UploadResult[] = []
      const resvFacilities = new Set<string>()  // M3: 取込後に snapshot_onhand へ断面追記する施設

      for (const payload of payloads) {
        const { table, data } = payload
        if (!data || data.length === 0) {
          results.push({ table, inserted: 0, error: 'No data' })
          continue
        }
        try {
          let totalInserted = 0
          let warning: string | undefined
          const onConflict = UPSERT_KEYS[table] || ''

          // M3: 予約情報の取込バリデーション（非ブロッキング）
          if (table === 'raw_reservation') {
            const fac = (data[0] as Record<string, unknown>).facility as string
            const sourceMonth = (data[0] as Record<string, unknown>).source_month as string | null
            resvFacilities.add(fac)
            const warns: string[] = []
            // 全ステータス出力チェック: キャンセル行が0なら全ステータス出力でない可能性
            const cxlCount = (data as Record<string, unknown>[]).filter((r) => r.status === 'キャンセル').length
            if (cxlCount === 0) warns.push('キャンセル行が0件です。全ステータス出力でない可能性（ブッキングカーブの再構築が狂います）')
            // 確定実績の変更検知: 同一source_monthの既存C/Oと精算額を突合
            if (sourceMonth) {
              try {
                const existing = await fetchAll<{ pms_id: number; revenue_settled: number | null; status: string | null }>(
                  () => supabase.from('raw_reservation').select('pms_id, revenue_settled, status').eq('facility', fac).eq('source_month', sourceMonth))
                const exMap = new Map(existing.map((e) => [e.pms_id, e]))
                let changed = 0
                for (const r of data as Record<string, unknown>[]) {
                  const e = exMap.get(r.pms_id as number)
                  if (e && e.status === 'C/O' && (e.revenue_settled ?? 0) !== ((r.revenue_settled as number | null) ?? 0)) changed++
                }
                if (changed > 0) warns.push(`確定済(C/O)の精算額が${changed}件変化しています。誤ったCSV（古い出力・別期間）の可能性。差分をご確認ください`)
              } catch { /* 検知失敗は取込を止めない */ }
            }
            if (warns.length) warning = warns.join(' / ')
          }

          // Tables without simple unique keys: delete existing data before insert
          const DELETE_BEFORE_INSERT = ['raw_basic_product', 'raw_other_product', 'raw_payment', 'raw_rate_snapshot', 'raw_room_sales']
          if (DELETE_BEFORE_INSERT.includes(table) && data.length > 0) {
            const facility = (data[0] as Record<string, unknown>).facility as string
            if (table === 'raw_rate_snapshot') {
              const snapshotDates = [...new Set(data.map((r: Record<string, unknown>) => r.snapshot_date))]
              for (const sd of snapshotDates) {
                await supabase.from(table).delete().eq('facility', facility).eq('snapshot_date', sd)
              }
            } else {
              const sourceMonth = (data[0] as Record<string, unknown>).source_month as string
              if (!sourceMonth) {
                // source_month はファイル名から抽出。無いと既存分を消せず再取込のたびに明細が倍加するため中止する
                throw new Error('ファイル名から対象年月を特定できないため取込を中止しました（重複防止）。ファイル名に「2026_05」等の年月を含めてください')
              }
              await supabase.from(table).delete().eq('facility', facility).eq('source_month', sourceMonth)
            }
          }

          for (let i = 0; i < data.length; i += BATCH_SIZE) {
            const batch = data.slice(i, i + BATCH_SIZE)
            if (onConflict) {
              const { error, count } = await supabase
                .from(table)
                .upsert(batch, { onConflict, ignoreDuplicates: false, count: 'exact' })
              if (error) throw error
              totalInserted += count ?? batch.length
            } else {
              const { error, count } = await supabase
                .from(table)
                .insert(batch, { count: 'exact' })
              if (error) throw error
              totalInserted += count ?? batch.length
            }
          }
          results.push({ table, inserted: totalInserted, skipped: payload.skipped, warning })
        } catch (err) {
          const message = err instanceof Error ? err.message
            : (err && typeof err === 'object' && 'message' in err) ? String((err as { message: unknown }).message)
            : String(err)
          results.push({ table, inserted: 0, error: message })
        }
      }

      setFiles((prev) =>
        prev.map((f, idx) => {
          const payloadIdx = fileIndexMap.indexOf(idx)
          if (payloadIdx < 0) return f
          const result = results[payloadIdx]
          if (!result) return f
          return {
            ...f,
            status: result.error ? 'error' : 'done',
            result,
            error: result.error,
          } as FileEntry
        })
      )

      // M3: 予約情報を取り込んだ施設は、取込後の mart_onhand（＝現在のオンハンド断面）を
      //     snapshot_onhand に当日断面として追記する（追記専用・同日再取込は上書き）。
      //     全upsert後に施設単位で1回だけ実行（ファイル分割による二重計上/上書きを防ぐ）。
      const snapDate = new Date().toISOString().slice(0, 10)
      for (const fac of resvFacilities) {
        try {
          const oh = await fetchAll<{ stay_date: string; channel: string; rooms: number | null; guests: number | null; revenue: number | null }>(
            () => supabase.from('mart_onhand').select('stay_date, channel, rooms, guests, revenue').eq('facility', fac))
          const snap = oh.map((o) => ({ facility: fac, snapshot_date: snapDate, stay_date: o.stay_date, channel: o.channel ?? '不明', rooms: o.rooms, guests: o.guests, revenue: o.revenue }))
          for (let i = 0; i < snap.length; i += 500) {
            await supabase.from('snapshot_onhand').upsert(snap.slice(i, i + 500), { onConflict: 'facility,snapshot_date,stay_date,channel' })
          }
        } catch { /* 断面追記の失敗は取込自体を止めない */ }
      }
    }

    await refreshMarts()
    setUploading(false)
  }

  const pendingCount = files.filter((f) => f.status === 'pending' || f.status === 'processing').length
  const doneCount = files.filter((f) => f.status === 'done').length
  const errorCount = files.filter((f) => f.status === 'error').length

  return (
    <div className="min-h-screen p-6" style={{ background: 'var(--bg)' }}>
      <div className="max-w-4xl mx-auto">
        {/* Tabs */}
        <div className="flex gap-1 mb-5">
          {([['sales', '売上データ'], ['pl', 'PL実績'], ['attendance', '勤怠'], ['review', 'クチコミ']] as const).map(([k, label]) => (
            <button key={k} onClick={() => setTab(k)} className="px-4 py-1.5 rounded-md text-sm"
              style={{ background: tab === k ? 'var(--accent)' : 'var(--surface)', color: tab === k ? '#fff' : 'var(--text-dim)', border: '1px solid var(--border)' }}>
              {label}
            </button>
          ))}
        </div>

        {/* Facility selector（勤怠は全宿一括のため不要） */}
        <div className="mb-4 flex items-center gap-4" style={{ display: tab === 'attendance' ? 'none' : undefined }}>
          <label className="text-sm font-medium" style={{ color: 'var(--text-dim)' }}>デフォルト宿:</label>
          <select
            className="field px-3 py-1.5 text-sm"
            value={globalFacility}
            onChange={(e) => setGlobalFacility(e.target.value)}
            onFocus={() => { if (facilityList.length === 0) loadFacilities() }}
          >
            <option value="">選択してください</option>
            {facilityList.map((f) => (
              <option key={f.facility} value={f.facility}>
                {f.name} ({f.facility})
              </option>
            ))}
          </select>
        </div>

        {tab === 'sales' && (<>
        {/* アップロード種別ガイド（枠外） */}
        <div className="card p-4 mb-4" style={{ borderColor: 'var(--border)' }}>
          <div className="text-xs font-semibold mb-2" style={{ color: 'var(--text-dim)' }}>アップロードの種類</div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-sm">
            <div>
              <div className="font-medium mb-0.5">❶ 実績アップロード<span className="text-[10px] font-normal ml-1 px-1.5 py-0.5 rounded" style={{ background: 'var(--surface2)', color: 'var(--text-dim)' }}>月1・確定締め</span></div>
              <p className="text-xs" style={{ color: 'var(--text-dim)' }}>ステイシー（基本商品情報・その他商品情報・入金情報・販売数集計表・予約情報）＋ 在庫レート表</p>
            </div>
            <div>
              <div className="font-medium mb-0.5">❷ オンハンドアップロード<span className="text-[10px] font-normal ml-1 px-1.5 py-0.5 rounded" style={{ background: 'var(--surface2)', color: 'var(--text-dim)' }}>週1・鮮度</span></div>
              <p className="text-xs" style={{ color: 'var(--text-dim)' }}>ステイシー（予約情報のみ）を当月〜予約が入っている最終月まで数本</p>
            </div>
          </div>
          <ul className="mt-2 text-[11px] space-y-0.5" style={{ color: 'var(--text-dim)' }}>
            <li>・予約情報は必ず<strong style={{ color: 'var(--text)' }}>全ステータス（C/O＋キャンセル＋全て）</strong>で出力（キャンセル日が欠けるとブッキングカーブの再構築が狂います）</li>
            <li>・ファイル名に対象年月（例「2026_05」）を含める（重複防止・過去分の上書きに使用）</li>
            <li>・確定済み（C/O）の過去実績が再取込で変化すると警告が出ます（誤ったCSVの検知）</li>
          </ul>
        </div>

        {/* Drop zone */}
        <div
          className="border-2 border-dashed rounded-lg p-12 text-center transition-colors card"
          style={{ borderColor: 'var(--border)' }}
          onDragOver={(e) => e.preventDefault()}
          onDrop={handleDrop}
        >
          <div className="mb-4" style={{ color: 'var(--text-dim)' }}>
            <svg className="mx-auto h-12 w-12" style={{ color: 'var(--text-dim)' }} fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
            </svg>
          </div>
          <p className="mb-2">CSVファイル / Excelファイルをドラッグ＆ドロップ</p>
          <p className="text-sm mb-4" style={{ color: 'var(--text-dim)' }}>ステイシー（PMS）各種 + レート表</p>
          <label className="cursor-pointer inline-block px-4 py-2 text-white rounded-md text-sm hover:opacity-90" style={{ background: 'var(--accent)' }}>
            ファイルを選択
            <input type="file" className="hidden" multiple accept=".csv,.xlsx" onChange={handleFileInput} />
          </label>
        </div>

        {/* File list */}
        {files.length > 0 && (
          <div className="mt-6">
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-lg font-semibold">
                ファイル一覧 ({files.length}件)
              </h2>
              <div className="flex gap-3 text-sm">
                {doneCount > 0 && <span style={{ color: 'var(--green)' }}>{doneCount}件 完了</span>}
                {errorCount > 0 && <span style={{ color: 'var(--red)' }}>{errorCount}件 エラー</span>}
              </div>
            </div>

            <div className="space-y-2">
              {files.map((entry, idx) => (
                <div
                  key={idx}
                  className={`border rounded-lg p-3 flex items-center gap-3 ${
                    entry.status === 'done'
                      ? 'bg-green-500/10 border-green-500/40'
                      : entry.status === 'error'
                        ? 'bg-red-500/10 border-red-500/40'
                        : 'bg-[var(--surface)] border-[var(--border)]'
                  }`}
                >
                  {/* Status icon */}
                  <div className="flex-shrink-0 w-6">
                    {entry.status === 'done' && <span className="text-green-500">&#10003;</span>}
                    {entry.status === 'error' && <span className="text-red-500">&#10007;</span>}
                    {entry.status === 'processing' && (
                      <span className="inline-block w-4 h-4 border-2 border-blue-400 border-t-transparent rounded-full animate-spin" />
                    )}
                  </div>

                  {/* File info */}
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium truncate">{entry.file.name}</p>
                    <div className="flex gap-2 text-xs mt-0.5" style={{ color: 'var(--text-dim)' }}>
                      <span className="px-1.5 py-0.5 rounded" style={{ background: 'var(--surface2)' }}>
                        {entry.detection?.type ?? '不明'}
                      </span>
                      {entry.result && (
                        <span>{entry.result.inserted}件 投入</span>
                      )}
                      {entry.result?.skipped ? (
                        <span style={{ color: 'var(--yellow)' }} title="ヘッダー不一致・必須項目欠落等で変換できなかった行。件数が多い場合はフォーマットを確認してください">
                          ⚠ {entry.result.skipped}行スキップ
                        </span>
                      ) : null}
                      {entry.result?.warning ? (
                        <span style={{ color: 'var(--red)' }} title="取込は完了していますが確認が必要です">
                          ⚠ {entry.result.warning}
                        </span>
                      ) : null}
                      {entry.error && (
                        <span className="truncate" style={{ color: 'var(--red)' }}>{entry.error}</span>
                      )}
                    </div>
                  </div>

                  {/* Facility selector per file */}
                  <select
                    className="field px-2 py-1 text-xs w-28"
                    value={entry.facility ?? ''}
                    onChange={(e) => setFileFacility(idx, e.target.value)}
                    disabled={entry.status === 'done' || entry.status === 'processing'}
                  >
                    <option value="">宿</option>
                    {facilityList.map((f) => (
                      <option key={f.facility} value={f.facility}>
                        {f.short_name ?? f.facility}
                      </option>
                    ))}
                  </select>

                  {/* Remove button */}
                  {entry.status === 'pending' && (
                    <button
                      className="text-sm hover:opacity-70"
                      style={{ color: 'var(--text-dim)' }}
                      onClick={() => removeFile(idx)}
                    >
                      &#10005;
                    </button>
                  )}
                </div>
              ))}
            </div>

            {/* Upload button */}
            {pendingCount > 0 && (
              <button
                className="mt-4 w-full py-3 text-white rounded-lg font-medium hover:opacity-90 disabled:opacity-50"
                style={{ background: 'var(--accent)' }}
                onClick={executeUpload}
                disabled={uploading || pendingCount === 0}
              >
                {uploading ? '処理中...' : `${pendingCount}件をアップロード`}
              </button>
            )}
          </div>
        )}
        </>)}

        {tab === 'pl' && (
          <>
            <p className="text-sm mb-3" style={{ color: 'var(--text-dim)' }}>
              月次推移：損益計算書のCSVをアップロードします（会計の実績）。年度はファイル内の期間から自動判定し、
              <strong>同一宿×年度を上書き</strong>します。実績が入っている月のみ取り込みます（進行期の未来月はスキップ）。
            </p>
            <label
              className="border-2 border-dashed rounded-lg p-12 text-center transition-colors card block cursor-pointer"
              style={{ borderColor: 'var(--border)' }}
            >
              <p className="mb-2">損益計算書CSVをドロップ / クリックして選択</p>
              <p className="text-sm" style={{ color: 'var(--text-dim)' }}>例: 月次推移：損益計算書_…（2025年04月～2026年03月）.csv</p>
              <input type="file" className="hidden" multiple accept=".csv" onChange={(e) => { handlePlFiles(e.target.files); e.target.value = '' }} />
            </label>

            {plFiles.length > 0 && (
              <div className="mt-6 space-y-2">
                {plFiles.map((p, i) => (
                  <div key={i} className={`border rounded-lg p-3 flex items-center gap-3 ${p.status === 'done' ? 'bg-green-500/10 border-green-500/40' : p.status === 'error' ? 'bg-red-500/10 border-red-500/40' : 'bg-[var(--surface)] border-[var(--border)]'}`}>
                    <div className="w-6 flex-shrink-0">
                      {p.status === 'done' && <span className="text-green-500">&#10003;</span>}
                      {p.status === 'error' && <span className="text-red-500">&#10007;</span>}
                      {p.status === 'processing' && <span className="inline-block w-4 h-4 border-2 border-blue-400 border-t-transparent rounded-full animate-spin" />}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium truncate">{p.name}</p>
                      <div className="text-xs mt-0.5" style={{ color: 'var(--text-dim)' }}>
                        {p.status === 'done' && `${p.fy}年度 ・ ${p.rows}行 投入（上書き）`}
                        {p.status === 'error' && <span style={{ color: 'var(--red)' }}>{p.error}</span>}
                        {p.status === 'processing' && '処理中...'}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
            {plUploading && <p className="text-xs mt-2" style={{ color: 'var(--text-dim)' }}>アップロード中...</p>}
          </>
        )}

        {tab === 'attendance' && (
          <>
            <p className="text-sm mb-3" style={{ color: 'var(--text-dim)' }}>
              勤怠CSV（Touch On Time の日次出力／拡張子.xls・実体HTML）を取り込みます。
              <strong>1ファイル＝1日分・全宿</strong>。月末に1ヶ月分（約30ファイル）をまとめて選択してください。
              宿マッピング・ヘルプ按分は自動。<strong>同日同宿はUPSERT（上書き）</strong>のため再取込しても重複しません。
            </p>
            <label
              className="border-2 border-dashed rounded-lg p-12 text-center transition-colors card block cursor-pointer"
              style={{ borderColor: 'var(--border)' }}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => { e.preventDefault(); handleAttFiles(e.dataTransfer.files) }}
            >
              <p className="mb-2">勤怠ファイル（.xls）をドロップ / クリックして選択（複数可）</p>
              <p className="text-sm" style={{ color: 'var(--text-dim)' }}>例: working_daily_working_list20260624142552.xls</p>
              <input type="file" className="hidden" multiple accept=".xls,.html,.htm" onChange={(e) => { handleAttFiles(e.target.files); e.target.value = '' }} />
            </label>

            {attFiles.length > 0 && (
              <div className="mt-6 space-y-2">
                {attFiles.map((p, i) => (
                  <div key={i} className={`border rounded-lg p-3 flex items-center gap-3 ${p.status === 'done' ? 'bg-green-500/10 border-green-500/40' : p.status === 'error' ? 'bg-red-500/10 border-red-500/40' : 'bg-[var(--surface)] border-[var(--border)]'}`}>
                    <div className="w-6 flex-shrink-0">
                      {p.status === 'done' && <span className="text-green-500">&#10003;</span>}
                      {p.status === 'error' && <span className="text-red-500">&#10007;</span>}
                      {p.status === 'processing' && <span className="inline-block w-4 h-4 border-2 border-blue-400 border-t-transparent rounded-full animate-spin" />}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium truncate">{p.name}</p>
                      <div className="text-xs mt-0.5" style={{ color: 'var(--text-dim)' }}>
                        {p.status === 'done' && (<>
                          {p.workDate} ・ {p.rows}件投入 ・ 従業員{p.staff}名
                          {p.skipped ? <span style={{ color: 'var(--yellow)' }}>　⚠ 未マッピング所属 {p.skipped}行スキップ（新宿/新部署の可能性。要マッピング追加）</span> : null}
                        </>)}
                        {p.status === 'error' && <span style={{ color: 'var(--red)' }}>{p.error}</span>}
                        {p.status === 'processing' && '処理中...'}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
            {attUploading && <p className="text-xs mt-2" style={{ color: 'var(--text-dim)' }}>アップロード中...</p>}
          </>
        )}

        {tab === 'review' && (
          <>
            <p className="text-sm mb-3" style={{ color: 'var(--text-dim)' }}>
              じゃらん・一休のクチコミCSVを取り込みます（ファイル内容から自動判別）。
              <strong>ドロップ→プレビュー確認→「取込確定」</strong>の順。同一クチコミは上書き（重複しません）。
              帰属宿は上部の「デフォルト宿」です。
            </p>
            <label
              className="border-2 border-dashed rounded-lg p-10 text-center transition-colors card block cursor-pointer"
              style={{ borderColor: 'var(--border)' }}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => { e.preventDefault(); handleRevFiles(e.dataTransfer.files) }}
            >
              <p className="mb-2">クチコミCSVをドロップ / クリックして選択（複数可）</p>
              <p className="text-sm" style={{ color: 'var(--text-dim)' }}>じゃらん=クチコミ/アンケート結果DL ・ 一休=クチコミダウンロード</p>
              <input type="file" className="hidden" multiple accept=".csv" onChange={(e) => { handleRevFiles(e.target.files); e.target.value = '' }} />
            </label>

            {revFiles.length > 0 && (
              <div className="mt-5 space-y-2">
                {revFiles.map((p, i) => (
                  <div key={i} className={`border rounded-lg p-3 flex items-center gap-3 ${p.status === 'done' ? 'bg-green-500/10 border-green-500/40' : p.status === 'error' ? 'bg-red-500/10 border-red-500/40' : 'bg-[var(--surface)] border-[var(--border)]'}`}>
                    <div className="w-6 flex-shrink-0">
                      {p.status === 'done' && <span className="text-green-500">&#10003;</span>}
                      {p.status === 'error' && <span className="text-red-500">&#10007;</span>}
                      {p.status === 'pending' && <span style={{ color: 'var(--yellow)' }}>◎</span>}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium truncate">{p.name}
                        <span className="ml-2 text-[10px] px-1.5 py-0.5 rounded" style={{ background: 'var(--surface2)', color: 'var(--text-dim)' }}>{p.source}</span>
                      </p>
                      <div className="text-xs mt-0.5" style={{ color: 'var(--text-dim)' }}>
                        {p.status === 'pending' && `プレビュー: ${p.rows.length}件（${p.minDate ?? '-'} 〜 ${p.maxDate ?? '-'}）`}
                        {p.status === 'pending' && p.skipped > 0 && <span style={{ color: 'var(--yellow)' }}>　⚠ NG {p.skipped}行（ID/投稿日なし）</span>}
                        {p.status === 'done' && `${p.inserted}件 取込（UPSERT）`}
                        {p.status === 'error' && <span style={{ color: 'var(--red)' }}>{p.error}</span>}
                      </div>
                    </div>
                    {p.status === 'pending' && (
                      <button className="text-sm hover:opacity-70" style={{ color: 'var(--text-dim)' }}
                        onClick={() => setRevFiles((prev) => prev.filter((_, idx) => idx !== i))}>&#10005;</button>
                    )}
                  </div>
                ))}
                {revFiles.some((p) => p.status === 'pending') && (
                  <button onClick={commitReviews} disabled={revUploading}
                    className="w-full py-3 text-white rounded-lg font-medium hover:opacity-90 disabled:opacity-50"
                    style={{ background: 'var(--accent)' }}>
                    {revUploading ? '取込中...' : `プレビュー ${revFiles.filter((p) => p.status === 'pending').reduce((s, p) => s + p.rows.length, 0)}件を取込確定`}
                  </button>
                )}
              </div>
            )}

            {/* 楽天: 宿カルテ集計値の月次転記（個別DL不可のため） */}
            <div className="card p-5 mt-6">
              <h3 className="text-sm font-semibold mb-1">楽天トラベル 集計値（宿カルテ転記・月次）</h3>
              <p className="text-xs mb-3" style={{ color: 'var(--text-dim)' }}>
                楽天は個別クチコミのDLができないため、宿カルテ「口コミ分析」の集計値を月1回転記します（同月は上書き）。
              </p>
              <div className="flex items-end gap-3 flex-wrap mb-3">
                <div>
                  <label className="block text-xs mb-1" style={{ color: 'var(--text-dim)' }}>対象月</label>
                  <input type="month" className="field px-3 py-1.5 text-sm" value={rkMonth} onChange={(e) => setRkMonth(e.target.value)} />
                </div>
                <div>
                  <label className="block text-xs mb-1" style={{ color: 'var(--text-dim)' }}>当月件数</label>
                  <input type="number" min={0} className="field px-3 py-1.5 text-sm w-24" value={rkCount} onChange={(e) => setRkCount(e.target.value === '' ? '' : Number(e.target.value))} />
                </div>
                <div>
                  <label className="block text-xs mb-1" style={{ color: 'var(--text-dim)' }}>総合評価</label>
                  <input type="number" min={0} max={5} step="0.01" className="field px-3 py-1.5 text-sm w-24" value={rkAvg} onChange={(e) => setRkAvg(e.target.value === '' ? '' : Number(e.target.value))} />
                </div>
                <div className="flex-1 min-w-40">
                  <label className="block text-xs mb-1" style={{ color: 'var(--text-dim)' }}>エリア順位（任意）</label>
                  <input type="text" className="field px-3 py-1.5 text-sm w-full" placeholder="例: 54位/104宿" value={rkRanking} onChange={(e) => setRkRanking(e.target.value)} />
                </div>
              </div>
              <div className="grid grid-cols-3 sm:grid-cols-6 gap-3 mb-3">
                {Object.keys(rkAxes).map((k) => (
                  <div key={k}>
                    <label className="block text-xs mb-1" style={{ color: 'var(--text-dim)' }}>{k}</label>
                    <input type="number" min={0} max={5} step="0.1" className="field px-2 py-1.5 text-sm w-full"
                      value={rkAxes[k]} onChange={(e) => setRkAxes((prev) => ({ ...prev, [k]: e.target.value === '' ? '' : Number(e.target.value) }))} />
                  </div>
                ))}
              </div>
              <div className="flex items-center gap-3">
                <button onClick={saveRakuten} className="px-4 py-2 text-white rounded-md text-sm hover:opacity-90" style={{ background: 'var(--accent)' }}>保存</button>
                {rkMsg && <span className="text-xs" style={{ color: rkMsg.startsWith('Error') ? 'var(--red)' : 'var(--green)' }}>{rkMsg}</span>}
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
