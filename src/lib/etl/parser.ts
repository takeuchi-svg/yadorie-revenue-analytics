import Papa from 'papaparse'
import * as XLSX from 'xlsx'

// 文字コード自動判定: 正しいUTF-8ならUTF-8、そうでなければCP932(Shift_JIS)。
// 従来はCP932固定で、UTF-8ファイルを黙って文字化け→全行スキップさせていたのを防ぐ。
export function decodeCp932(buffer: ArrayBuffer): string {
  try {
    // CP932の日本語テキストが偶然「妥当なUTF-8」になることはほぼ無い
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer)
  } catch {
    const text = new TextDecoder('shift_jis').decode(buffer)
    // 双方で解釈不能（別エンコーディング/バイナリ）の検出
    const bad = (text.match(/�/g) ?? []).length
    if (bad > 5 && bad > text.length * 0.001) {
      throw new Error('文字コードを認識できません（UTF-8/Shift_JIS以外の可能性）。ファイルを確認してください')
    }
    return text
  }
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

  // YYYY/MM/DD or YYYY-MM-DD (with optional time)
  const m = s.match(/(\d{4})[/\-](\d{1,2})[/\-](\d{1,2})/)
  if (m) {
    return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`
  }

  // YYYYMMDD (Lincoln format)
  const m2 = s.match(/^(\d{4})(\d{2})(\d{2})$/)
  if (m2) {
    return `${m2[1]}-${m2[2]}-${m2[3]}`
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
