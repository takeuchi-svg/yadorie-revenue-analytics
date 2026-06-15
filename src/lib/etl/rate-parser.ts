import * as XLSX from 'xlsx'
import type { RawRateSnapshot, UploadPayload } from './types'

const DOW_MAP: Record<number, string> = {
  0: '日', 1: '月', 2: '火', 3: '水', 4: '木', 5: '金', 6: '土',
}

interface FacilityRooms {
  name: string
  type?: string
}

export function parseRateSheet(
  workbook: XLSX.WorkBook,
  facility: string,
  rooms: FacilityRooms[]
): UploadPayload {
  const allSnapshots: RawRateSnapshot[] = []

  for (const sheetName of workbook.SheetNames) {
    // Only process sheets with 8-digit date names (YYYYMMDD)
    if (!/^\d{8}$/.test(sheetName)) continue

    const snapshotDate = `${sheetName.slice(0, 4)}-${sheetName.slice(4, 6)}-${sheetName.slice(6, 8)}`
    const sheet = workbook.Sheets[sheetName]
    if (!sheet) continue

    const snapshots = parseSheet(sheet, facility, snapshotDate, rooms)
    allSnapshots.push(...snapshots)
  }

  return { table: 'raw_rate_snapshot', data: allSnapshots as unknown as Record<string, unknown>[] }
}

function parseSheet(
  sheet: XLSX.WorkSheet,
  facility: string,
  snapshotDate: string,
  rooms: FacilityRooms[]
): RawRateSnapshot[] {
  const range = XLSX.utils.decode_range(sheet['!ref'] || 'A1')
  const results: RawRateSnapshot[] = []
  const year = parseInt(snapshotDate.slice(0, 4), 10)

  const dateRow = findDateRow(sheet, range, year)
  if (dateRow < 0) return results

  const dateCols = extractDateColumns(sheet, dateRow, range, year)
  if (dateCols.length === 0) return results

  const anchors = findAnchors(sheet, range, snapshotDate)

  // Parse total-level data
  if (anchors.rateRank >= 0) {
    for (const dc of dateCols) {
      const rateVal = getCellValue(sheet, anchors.rateRank, dc.col)
      const remainVal = anchors.remaining >= 0 ? getCellValue(sheet, anchors.remaining, dc.col) : null
      const soldVal = anchors.sold >= 0 ? getCellValue(sheet, anchors.sold, dc.col) : null

      const d = new Date(dc.date)
      results.push({
        facility,
        snapshot_date: snapshotDate,
        stay_date: dc.date,
        dow: DOW_MAP[d.getDay()] ?? null,
        scope: 'total',
        room: null,
        rate_rank: parseIntOrNull(rateVal),
        remaining: parseRemaining(remainVal),
        sold: parseIntOrNull(soldVal),
        flag_lastmin: false,
        flag_sudomari: false,
        flag_breakfast: false,
        flag_2mei_cut: false,
        flag_card: false,
      })
    }
  }

  // Parse flags
  const flagRows = findFlagRows(sheet, range)
  for (const dc of dateCols) {
    const existing = results.find(
      (r) => r.stay_date === dc.date && r.scope === 'total'
    )
    if (!existing) continue

    if (flagRows.lastmin >= 0) existing.flag_lastmin = isFlagSet(sheet, flagRows.lastmin, dc.col)
    if (flagRows.sudomari >= 0) existing.flag_sudomari = isFlagSet(sheet, flagRows.sudomari, dc.col)
    if (flagRows.breakfast >= 0) existing.flag_breakfast = isFlagSet(sheet, flagRows.breakfast, dc.col)
    if (flagRows.cut2mei >= 0) existing.flag_2mei_cut = isFlagSet(sheet, flagRows.cut2mei, dc.col)
    if (flagRows.card >= 0) existing.flag_card = isFlagSet(sheet, flagRows.card, dc.col)
  }

  // Parse room-level data
  for (const room of rooms) {
    const roomRow = findRoomRow(sheet, range, room.name)
    if (roomRow < 0) continue

    for (const dc of dateCols) {
      const val = getCellValue(sheet, roomRow, dc.col)
      const d = new Date(dc.date)
      results.push({
        facility,
        snapshot_date: snapshotDate,
        stay_date: dc.date,
        dow: DOW_MAP[d.getDay()] ?? null,
        scope: 'room',
        room: room.name,
        rate_rank: null,
        remaining: parseRemaining(val),
        sold: null,
        flag_lastmin: false,
        flag_sudomari: false,
        flag_breakfast: false,
        flag_2mei_cut: false,
        flag_card: false,
      })
    }
  }

  return results
}

// ============================================================
// Anchor search helpers
// ============================================================

function findDateRow(sheet: XLSX.WorkSheet, range: XLSX.Range, year: number): number {
  for (let r = 0; r <= Math.min(30, range.e.r); r++) {
    for (let c = 2; c <= Math.min(10, range.e.c); c++) {
      const val = getCellValue(sheet, r, c)
      if (val !== null && tryParseDate(val, year) !== null) return r
    }
  }
  return -1
}

function extractDateColumns(
  sheet: XLSX.WorkSheet,
  row: number,
  range: XLSX.Range,
  year: number
): { col: number; date: string }[] {
  const cols: { col: number; date: string }[] = []
  for (let c = 2; c <= range.e.c; c++) {
    const val = getCellValue(sheet, row, c)
    const date = tryParseDate(val, year)
    if (date) {
      cols.push({ col: c, date })
    }
  }
  return cols
}

function findAnchors(sheet: XLSX.WorkSheet, range: XLSX.Range, snapshotDate: string) {
  const result = { rateRank: -1, remaining: -1, sold: -1 }
  let rateStart = -1, remainStart = -1, soldStart = -1

  for (let r = 0; r <= range.e.r; r++) {
    const val = String(getCellValue(sheet, r, 1) ?? '').trim()
    if (val.startsWith('料金ランク')) rateStart = r
    else if (val.startsWith('総残室数') || val.startsWith('残室数')) remainStart = r
    else if (val.startsWith('総販売数') || val.startsWith('販売数')) soldStart = r
  }

  result.rateRank = findSnapshotSubRow(sheet, rateStart, snapshotDate)
  result.remaining = findSnapshotSubRow(sheet, remainStart, snapshotDate)
  result.sold = findSnapshotSubRow(sheet, soldStart, snapshotDate)

  return result
}

function findSnapshotSubRow(sheet: XLSX.WorkSheet, startRow: number, snapshotDate: string): number {
  if (startRow < 0) return -1
  // Each anchor has multiple sub-rows with snapshot dates in column C.
  // Find the sub-row matching snapshotDate, or use the last one.
  let lastDataRow = startRow
  for (let r = startRow; r <= startRow + 10; r++) {
    const cVal = String(getCellValue(sheet, r, 2) ?? '').trim()
    if (!cVal) continue
    // Check if this sub-row's date matches the snapshot
    const parsed = cVal.match(/(\d{4})[/\-](\d{1,2})[/\-](\d{1,2})/)
    if (parsed) {
      const rowDate = `${parsed[1]}-${parsed[2].padStart(2, '0')}-${parsed[3].padStart(2, '0')}`
      lastDataRow = r
      if (rowDate === snapshotDate) return r
    }
  }
  return lastDataRow
}

function findFlagRows(sheet: XLSX.WorkSheet, range: XLSX.Range) {
  const result = { lastmin: -1, sudomari: -1, breakfast: -1, cut2mei: -1, card: -1 }

  for (let r = 0; r <= range.e.r; r++) {
    const val = String(getCellValue(sheet, r, 1) ?? '').trim()
    if (val.includes('直前割') || val.includes('直前')) result.lastmin = r
    else if (val.includes('素泊')) result.sudomari = r
    else if (val.includes('朝食')) result.breakfast = r
    else if (val.includes('2名カット') || val.includes('2名')) result.cut2mei = r
    else if (val.includes('カード')) result.card = r
  }

  return result
}

function findRoomRow(sheet: XLSX.WorkSheet, range: XLSX.Range, roomName: string): number {
  for (let r = 0; r <= range.e.r; r++) {
    const val = String(getCellValue(sheet, r, 0) ?? '').trim() // A column
    if (val === roomName || val.includes(roomName)) return r
  }
  return -1
}

// ============================================================
// Cell value helpers
// ============================================================

function getCellValue(sheet: XLSX.WorkSheet, row: number, col: number): unknown {
  const addr = XLSX.utils.encode_cell({ r: row, c: col })
  const cell = sheet[addr]
  if (!cell) return null
  return cell.v ?? null
}

function tryParseDate(val: unknown, year?: number): string | null {
  if (val === null || val === undefined) return null

  if (typeof val === 'number') {
    const d = excelDateToISO(val)
    if (d) return d
  }

  const s = String(val).trim()
  const m = s.match(/(\d{4})[/\-](\d{1,2})[/\-](\d{1,2})/)
  if (m) {
    return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`
  }

  // M/D format — use year from sheet name
  const m2 = s.match(/^(\d{1,2})[/](\d{1,2})$/)
  if (m2 && year) {
    const month = m2[1].padStart(2, '0')
    const day = m2[2].padStart(2, '0')
    return `${year}-${month}-${day}`
  }

  return null
}

function excelDateToISO(serial: number): string | null {
  if (serial < 1 || serial > 100000) return null
  // Excel epoch: Jan 0, 1900 (with Lotus 1-2-3 leap year bug)
  const utcDays = serial - 25569
  const d = new Date(utcDays * 86400 * 1000)
  if (isNaN(d.getTime())) return null
  return d.toISOString().slice(0, 10)
}

function parseIntOrNull(val: unknown): number | null {
  if (val === null || val === undefined) return null
  const n = typeof val === 'number' ? val : parseInt(String(val).replace(/,/g, ''), 10)
  return isNaN(n) ? null : n
}

function parseRemaining(val: unknown): number | null {
  if (val === null || val === undefined) return null
  const s = String(val).trim()
  if (s === '止' || s === '×' || s === 'x') return -1
  return parseIntOrNull(val)
}

function isFlagSet(sheet: XLSX.WorkSheet, row: number, col: number): boolean {
  const val = getCellValue(sheet, row, col)
  if (val === null || val === undefined) return false
  const s = String(val).trim()
  return s === '○' || s === '◯' || s === 'O' || s === '1' || s === 'TRUE'
}
