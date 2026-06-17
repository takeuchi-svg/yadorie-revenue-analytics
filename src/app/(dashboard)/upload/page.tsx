'use client'

import { useState, useCallback } from 'react'
import {
  detectFileType,
  estimateFacility,
  parseFileToRows,
  parseXlsx,
  parseRateSheet,
  transformByType,
} from '@/lib/etl'
import type { DetectionResult, UploadPayload, UploadResult } from '@/lib/etl'
import { supabase } from '@/lib/supabase/client'

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
          if (payload.data.length === 0) {
            const sheetNames = workbook.SheetNames.join(', ')
            console.warn(`[rate_sheet] 0 rows. Sheets: ${sheetNames}`)
          }
          payloads.push(payload)
          fileIndexMap.push(i)
        } else {
          const rows = parseFileToRows(buffer, entry.file.name)
          if (rows.length > 0) {
            console.log(`[${entry.detection.type}] headers:`, Object.keys(rows[0]))
            console.log(`[${entry.detection.type}] sample row:`, rows[0])
          } else {
            console.warn(`[${entry.detection.type}] CSV parsed to 0 rows`)
          }
          const payload = transformByType(
            entry.detection.type,
            rows,
            entry.facility,
            entry.file.name
          )
          if (payload.data.length === 0 && rows.length > 0) {
            console.warn(`[${entry.detection.type}] transform produced 0 rows from ${rows.length} CSV rows. Headers: ${Object.keys(rows[0]).join(', ')}`)
          }
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
              if (sourceMonth) {
                await supabase.from(table).delete().eq('facility', facility).eq('source_month', sourceMonth)
              }
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
          results.push({ table, inserted: totalInserted })
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
        <h1 className="text-2xl font-bold mb-6">データアップロード</h1>

        {/* Facility selector */}
        <div className="mb-4 flex items-center gap-4">
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
      </div>
    </div>
  )
}
