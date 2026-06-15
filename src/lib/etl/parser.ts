import Papa from 'papaparse'
import * as XLSX from 'xlsx'

export function decodeCp932(buffer: ArrayBuffer): string {
  const decoder = new TextDecoder('shift_jis')
  return decoder.decode(buffer)
}

export function parseCsv(text: string): Record<string, string>[] {
  if (text.charCodeAt(0) === 0xfeff) {
    text = text.slice(1)
  }

  const result = Papa.parse<Record<string, string>>(text, {
    header: true,
    skipEmptyLines: true,
    transformHeader: (h: string) => h.trim(),
  })

  return result.data
}

export function parseFileToRows(buffer: ArrayBuffer, fileName: string): Record<string, string>[] {
  const lower = fileName.toLowerCase()

  if (lower.endsWith('.csv')) {
    const text = decodeCp932(buffer)
    return parseCsv(text)
  }

  throw new Error(`Unsupported file format: ${fileName}`)
}

export function parseXlsx(buffer: ArrayBuffer): XLSX.WorkBook {
  return XLSX.read(buffer, { type: 'array' })
}

export function parseNum(v: unknown): number {
  if (v === null || v === undefined) return 0
  if (typeof v === 'number') return v
  const s = String(v).replace(/"/g, '').replace(/,/g, '').trim()
  if (s === '' || s === '-') return 0
  const n = parseFloat(s)
  return isNaN(n) ? 0 : n
}

export function parseInt10(v: unknown): number {
  return Math.floor(parseNum(v))
}

export function parseDate(v: unknown): string | null {
  if (!v) return null
  const s = String(v).trim()
  if (!s) return null

  // YYYY/MM/DD or YYYY-MM-DD
  const m = s.match(/(\d{4})[/\-](\d{1,2})[/\-](\d{1,2})/)
  if (m) {
    return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`
  }

  return null
}

export function extractSourceMonth(fileName: string): string | null {
  const m = fileName.match(/(20\d{2})[_\-]([01]?\d)/)
  if (m) {
    return `${m[1]}-${m[2].padStart(2, '0')}`
  }
  return null
}
