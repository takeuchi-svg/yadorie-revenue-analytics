// 全社Core: 全店 / 既存店 / 新店 の区分判定（13ヶ月ルール）
//
// 既存店 = 開業/取得から13ヶ月以上経過（前年同月が揃い前年比が意味を持つ）
// 新店   = 12ヶ月以内（前年同月が存在しない → 前年比は出さず実績のみ）
// 区分不明 = opening_date 未設定（当面は既存/新店の切替対象から外し「全店」でのみ集計）
//
// 基準は「当月(targetMonth, 'YYYY-MM')」。開業13ヶ月で新店→既存店へ自動繰り入れ（手組み不要）。

export type FacilityClass = 'existing' | 'new' | 'unknown'
export type StoreScope = 'all' | 'existing' | 'new'

// 'YYYY-MM' → 月インデックス（年*12+月）。差分を月数で扱う。
function monthIndex(ym: string): number {
  const y = Number(ym.slice(0, 4))
  const m = Number(ym.slice(5, 7))
  return y * 12 + (m - 1)
}

// date/日付文字列(YYYY-MM-DD 等) → 'YYYY-MM'
function toYm(d: string | Date): string {
  if (d instanceof Date) return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
  return d.slice(0, 7)
}

// 開業日と当月から、経過月数（当月 - 開業月）を返す。開業月=0。
export function monthsSinceOpening(openingDate: string | Date | null | undefined, targetMonth: string): number | null {
  if (!openingDate) return null
  return monthIndex(targetMonth) - monthIndex(toYm(openingDate))
}

// 区分判定（13ヶ月ルール）。未設定は 'unknown'。
export function classifyFacility(openingDate: string | Date | null | undefined, targetMonth: string): FacilityClass {
  const elapsed = monthsSinceOpening(openingDate, targetMonth)
  if (elapsed == null) return 'unknown'
  return elapsed >= 13 ? 'existing' : 'new'
}

// 指定スコープに含まれるか。'all'=区分不明も含む全施設。
export function inScope(cls: FacilityClass, scope: StoreScope): boolean {
  if (scope === 'all') return true
  return cls === scope
}

// 新店（前年比を非表示にすべきか）。区分不明は前年データ有無に委ねるため false。
export function hidesYoY(cls: FacilityClass): boolean {
  return cls === 'new'
}

export const STORE_SCOPE_LABEL: Record<StoreScope, string> = {
  all: '全店',
  existing: '既存店',
  new: '新店',
}
