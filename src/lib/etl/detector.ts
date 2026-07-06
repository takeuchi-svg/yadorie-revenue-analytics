import type { FileType, DetectionResult } from './types'

const DETECTION_RULES: { keyword: string; ext: string; type: FileType }[] = [
  { keyword: '販売数集計表', ext: '.csv', type: 'staysee_room_sales' },
  { keyword: 'その他商品情報', ext: '.csv', type: 'staysee_other' },
  { keyword: '基本商品情報', ext: '.csv', type: 'staysee_basic' },
  { keyword: '予約情報', ext: '.csv', type: 'staysee_reservation' },
  { keyword: '入金情報', ext: '.csv', type: 'staysee_payment' },
  // リンカーン（予約検索）は2026-07廃止＝ステイシー予約情報へ一本化。取込判定から除外。
  //   既存の raw_booking_event データはDBに残置（履歴閲覧用）。誤取込防止のため下でエラー表示。
  { keyword: 'レートチェック', ext: '.xlsx', type: 'rate_sheet' },
]

export function detectFileType(fileName: string): DetectionResult | null {
  const lower = fileName.toLowerCase()

  for (const rule of DETECTION_RULES) {
    if (fileName.includes(rule.keyword) && lower.endsWith(rule.ext)) {
      return { type: rule.type, fileName }
    }
  }

  if (lower.endsWith('.xlsx')) {
    return { type: 'rate_sheet', fileName }
  }

  return null
}

export function estimateFacility(
  fileName: string,
  facilities: { facility: string; name: string; short_name: string | null }[]
): string | null {
  const normalized = fileName.replace(/[\s_　]+/g, '')

  let best: { code: string; score: number } | null = null

  for (const f of facilities) {
    for (const [idx, candidate] of [f.name, f.short_name].entries()) {
      if (!candidate) continue
      const n = candidate.replace(/[\s_　]+/g, '')
      if (!n) continue
      if (normalized.includes(n)) {
        const score = n.length * (idx === 0 ? 2 : 1)
        if (!best || score > best.score) {
          best = { code: f.facility, score }
        }
      }
    }
  }

  return best?.code ?? null
}
