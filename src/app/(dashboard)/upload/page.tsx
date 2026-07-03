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
import { parseAttendanceHtml } from '@/lib/etl/attendance-parser'
import { supabase } from '@/lib/supabase/client'

interface PlEntry { name: string; fy: string; rows: number; status: 'processing' | 'done' | 'error'; error?: string }
interface AttEntry { name: string; workDate: string; rows: number; staff: number; skipped?: number; status: 'processing' | 'done' | 'error'; error?: string }

interface FileEntry {
  file: File
  detection: DetectionResult | null
  facility: string | null
  status: 'pending' | 'processing' | 'done' | 'error'
  result?: UploadResult
  error?: string
}

export default function UploadPage() {
  const [files, setFiles] = useState<FileEntry[]>([])
  const [facilityList, setFacilityList] = useState<
    { facility: string; name: string; short_name: string | null; rooms_json: unknown }[]
  >([])
  const [uploading, setUploading] = useState(false)
  const [globalFacility, setGlobalFacility] = useState<string>('')
  const [tab, setTab] = useState<'sales' | 'pl' | 'attendance'>('sales')
  const [plFiles, setPlFiles] = useState<PlEntry[]>([])
  const [plUploading, setPlUploading] = useState(false)
  const [attFiles, setAttFiles] = useState<AttEntry[]>([])
  const [attUploading, setAttUploading] = useState(false)

  // 勤怠CSV（Touch On Time / HTML）取込: 全施設一括。施設選択は不要。
  const handleAttFiles = async (fileList: FileList | null) => {
    if (!fileList || fileList.length === 0) return
    setAttUploading(true)
    // ファイル名順（=日付順）で安定処理
    const list = Array.from(fileList).sort((a, b) => a.name.localeCompare(b.name))
    for (const file of list) {
      const entry: AttEntry = { name: file.name, workDate: '', rows: 0, staff: 0, status: 'processing' }
      setAttFiles((prev) => [...prev, entry])
      const upd = (patch: Partial<AttEntry>) => setAttFiles((prev) => prev.map((p) => (p === entry ? { ...p, ...patch } : p)))
      try {
        const html = await file.text() // UTF-8
        const { workDate, rows, staff } = parseAttendanceHtml(html, file.name)
        if (!workDate || rows.length === 0) throw new Error('勤怠を解析できませんでした（フォーマット要確認）')
        // 従業員マスタ upsert（新規社員番号を追加）
        const staffPayload = staff.map((s) => ({ ...s, updated_at: new Date().toISOString() }))
        for (let i = 0; i < staffPayload.length; i += 500) {
          const { error } = await supabase.from('dim_staff').upsert(staffPayload.slice(i, i + 500), { onConflict: 'staff_code' })
          if (error) throw error
        }
        // 日次勤怠 upsert（未マッピング施設=nullの行は除外。同日同施設は上書き）
        const attPayload = rows.filter((r) => r.work_facility != null)
        const unmapped = rows.length - attPayload.length
        for (let i = 0; i < attPayload.length; i += 500) {
          const { error } = await supabase.from('raw_attendance_daily').upsert(attPayload.slice(i, i + 500), { onConflict: 'staff_code,work_date,work_facility' })
          if (error) throw error
        }
        upd({ workDate, rows: attPayload.length, staff: staff.length, skipped: unmapped, status: 'done' })
      } catch (err) {
        upd({ status: 'error', error: err instanceof Error ? err.message : String(err) })
      }
    }
    setAttUploading(false)
  }

  const handlePlFiles = async (fileList: FileList | null) => {
    if (!fileList || fileList.length === 0) return
    if (facilityList.length === 0) await loadFacilities()
    const facility = globalFacility
    if (!facility) { alert('上部の「デフォルト施設」を選択してください'); return }
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
        // 上書き: 同一 施設×年度 を削除してから投入
        await supabase.from('actual_monthly').delete().eq('facility', facility).eq('fiscal_year', fiscalYear)
        for (let i = 0; i < payload.length; i += 500) {
          const { error } = await supabase.from('actual_monthly').insert(payload.slice(i, i + 500))
          if (error) throw error
        }
        upd({ fy: fiscalYear, rows: payload.length, status: 'done' })
      } catch (err) {
        upd({ status: 'error', error: err instanceof Error ? err.message : String(err) })
      }
    }
    setPlUploading(false)
  }

  const loadFacilities = useCallback(async () => {
    const { data } = await supabase
      .from('dim_facility')
      .select('facility, name, short_name, rooms_json')
      .order('facility')
    if (data) setFacilityList(data)
    return data ?? []
  }, [])

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
        setFiles((prev) =>
          prev.map((f, idx) =>
            idx === i ? { ...f, status: 'error', error: '施設またはファイル種別が未設定' } : f
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
        raw_booking_event: 'facility,notify_no',
      }

      const results: UploadResult[] = []

      for (const payload of payloads) {
        const { table, data } = payload
        if (!data || data.length === 0) {
          results.push({ table, inserted: 0, error: 'No data' })
          continue
        }
        try {
          let totalInserted = 0
          const onConflict = UPSERT_KEYS[table] || ''

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
          results.push({ table, inserted: totalInserted, skipped: payload.skipped })
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
    }

    setUploading(false)
  }

  const pendingCount = files.filter((f) => f.status === 'pending' || f.status === 'processing').length
  const doneCount = files.filter((f) => f.status === 'done').length
  const errorCount = files.filter((f) => f.status === 'error').length

  return (
    <div className="min-h-screen p-6" style={{ background: 'var(--bg)' }}>
      <div className="max-w-4xl mx-auto">
        <h1 className="text-2xl font-bold mb-4">データアップロード</h1>

        {/* Tabs */}
        <div className="flex gap-1 mb-5">
          {([['sales', '売上データ'], ['pl', 'PL実績'], ['attendance', '勤怠']] as const).map(([k, label]) => (
            <button key={k} onClick={() => setTab(k)} className="px-4 py-1.5 rounded-md text-sm"
              style={{ background: tab === k ? 'var(--accent)' : 'var(--surface)', color: tab === k ? '#fff' : 'var(--text-dim)', border: '1px solid var(--border)' }}>
              {label}
            </button>
          ))}
        </div>

        {/* Facility selector（勤怠は全施設一括のため不要） */}
        <div className="mb-4 flex items-center gap-4" style={{ display: tab === 'attendance' ? 'none' : undefined }}>
          <label className="text-sm font-medium" style={{ color: 'var(--text-dim)' }}>デフォルト施設:</label>
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
          <p className="text-sm mb-4" style={{ color: 'var(--text-dim)' }}>PMS 5本 + Lincoln 2本 + レート表 1本</p>
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
                    <option value="">施設</option>
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
              <strong>同一施設×年度を上書き</strong>します。実績が入っている月のみ取り込みます（進行期の未来月はスキップ）。
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
              <strong>1ファイル＝1日分・全施設</strong>。月末に1ヶ月分（約30ファイル）をまとめて選択してください。
              施設マッピング・ヘルプ按分は自動。<strong>同日同施設はUPSERT（上書き）</strong>のため再取込しても重複しません。
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
                          {p.skipped ? <span style={{ color: 'var(--yellow)' }}>　⚠ 未マッピング所属 {p.skipped}行スキップ（新施設/新部署の可能性。要マッピング追加）</span> : null}
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
      </div>
    </div>
  )
}
