// PL再計算の唯一の正（SSOT）。予実ページ(yojitsu)と全社Core(company)が同じロジックを共有する。
//
// なぜ共有するか: 実績PLには gop/営業利益 の行が無く（freee由来PLは全費目が売上高categoryに入る等）、
// 売上 − 原価 − 人件費明細合算 − 販管費明細合算 で毎回再計算する必要がある。外注費の二重科目・
// 賃借料(旅館)/減価償却費の減算も含む。この再計算をSQLや別実装で書き直すと単施設ページと数字がズレるため、
// 全社集計は「施設ごとにこの関数を適用して足し合わせる」ことで施設別合計との一致を構造的に保証する。

import { fmtNum, pct } from '@/lib/ui'

/* ===== 型 ===== */
export interface BudgetRow { fiscal_year: string; month: string; category: string | null; item_code: string; item_name: string; amount: number | null; sort_order: number | null }
export interface ActualRow { fiscal_year: string; month: string; item_code: string; actual: number | null }
export interface KpiRow { month: string; guests: number | null; adr: number | null; guest_unit: number | null; companion: number | null }
export interface OccRow { month: string; rooms_sold: number | null; occ: number | null; occ_calendar_days?: number | null; operating_days: number | null }

/* ===== 表示分類の定数 ===== */
// 折りたたみ対象カテゴリと、その集計行コード
export const COLLAPSIBLE: Record<string, string> = { '売上': 'sales_total', '原価': 'cogs_total', '人件費': 'labor_total', '販売管理費': 'sga_total' }
// 集計行（太字・背景）
export const CAT_TOTALS = new Set(['sales_total', 'cogs_total', 'labor_total', 'sga_total', 'gop', 'ebitda', 'operating_income'])
// 売上実績(mart)から取得するKPI
export const KPI_SALES = new Set(['稼働率', '販売室数', '同伴係数', '宿泊客数', '客単価', '室単価'])
// %表示の行
export const PERCENT_CODES = new Set(['稼働率', '食材原価率'])
// 着地年度合計を「合計」せず再計算する比率行
export const RECOMPUTE_CODES = new Set(['稼働率', '客単価', '室単価', '同伴係数'])
// 年度合計を空欄にする行
export const BLANK_YEAR_CODES = new Set(['食材原価率'])

/* ===== キー・月ヘルパ ===== */
export const k = (ym: string, code: string) => `${ym}|${code}`
export const priorYM = (ym: string) => `${Number(ym.slice(0, 4)) - 1}-${ym.slice(5)}`

/* ===== 損益分岐点・原価分析（固変分解） =====
   原価は全額変動費。水道光熱費は変動30%（固定70%）。賞与は計上月そのまま固定費。
   固定費は「総費用 − 変動費」の残差で算出（各項目の固変ラベルと一致し二重計上を防ぐ）。 */
export const WATER_VAR_RATIO = 0.30
// 変動費の非原価項目（原価=cogs_totalは別途全額変動として加算）
export const COST_VAR_ITEMS = ['雑給', '広告宣伝費', '販売促進費', '消耗品費', '修繕費', 'リネン費', '送客手数料', 'カード手数料', '雑費']

export type Agg = { sales: number | null; oi: number | null; gop: number | null; guests: number | null; rooms: number | null; varC: number | null }

// 資源解決関数 g(code) から変動費を算出（cogsが無い月は null）
export function varCostFrom(g: (code: string) => number | null): number | null {
  const cogs = g('cogs_total')
  if (cogs == null) return null
  let v = cogs // 原価は全額変動
  for (const c of COST_VAR_ITEMS) v += g(c) ?? 0
  // 外注費（変動）: 「外注費」と「外注費（人材/清掃/その他）」は別科目のため全て合算
  // （実績は外注費＋外注費（人材）が併存、予算は分割科目のみ — フォールバックだと人材分が漏れる）
  v += (g('外注費') ?? 0) + (g('外注費_人材_') ?? 0) + (g('外注費_清掃_') ?? 0) + (g('外注費_その他_') ?? 0)
  // 水道光熱費の変動分（30%）
  v += (g('水道光熱費') ?? 0) * WATER_VAR_RATIO
  return v
}

export const aggFrom = (g: (code: string) => number | null): Agg => ({
  sales: g('sales_total'), oi: g('operating_income'), gop: g('gop'),
  guests: g('宿泊客数'), rooms: g('販売室数'), varC: varCostFrom(g),
})

// 損益関連KPI（kind: 表示形式 / up: 高いほど良い）
export const DERIVED: { code: string; name: string; kind: 'yen' | 'pct'; up: boolean }[] = [
  { code: 'bep_sales', name: '損益分岐点売上高', kind: 'yen', up: false },
  { code: 'bep_ratio', name: '損益分岐点比率', kind: 'pct', up: false },
  { code: 'fixed_cost', name: '固定費', kind: 'yen', up: false },
  { code: 'var_cost', name: '変動費', kind: 'yen', up: false },
  { code: 'var_ratio', name: '変動費率', kind: 'pct', up: false },
  { code: 'cm_ratio', name: '限界利益率', kind: 'pct', up: true },
  { code: 'cost_per_guest', name: 'お客様1人あたりの費用', kind: 'yen', up: false },
  { code: 'varcost_per_guest', name: 'お客様1人あたりの変動費', kind: 'yen', up: false },
  { code: 'cost_per_room', name: '1部屋あたりの費用', kind: 'yen', up: false },
  { code: 'varcost_per_room', name: '1部屋あたりの変動費', kind: 'yen', up: false },
  { code: 'gop_per_guest', name: 'お客様1人あたりのGOP', kind: 'yen', up: true },
  { code: 'oi_per_guest', name: 'お客様1人あたりの営業利益', kind: 'yen', up: true },
]

export function calcDeriv(code: string, a: Agg): number | null {
  const { sales, oi, gop, guests, rooms, varC } = a
  const totalC = sales != null && oi != null ? sales - oi : null // 総費用 = 売上 − 営業利益
  const fixedC = totalC != null && varC != null ? totalC - varC : null
  const cmRatio = varC != null && sales ? (sales - varC) / sales : null // 限界利益率
  const div = (x: number | null, d: number | null | undefined) => (x != null && d ? x / d : null)
  switch (code) {
    case 'var_cost': return varC
    case 'fixed_cost': return fixedC
    case 'var_ratio': return div(varC, sales)
    case 'cm_ratio': return cmRatio
    case 'bep_sales': return fixedC != null && cmRatio ? fixedC / cmRatio : null
    case 'bep_ratio': return fixedC != null && cmRatio && sales ? fixedC / cmRatio / sales : null
    case 'cost_per_guest': return div(totalC, guests)
    case 'varcost_per_guest': return div(varC, guests)
    case 'cost_per_room': return div(totalC, rooms)
    case 'varcost_per_room': return div(varC, rooms)
    case 'gop_per_guest': return div(gop, guests)
    case 'oi_per_guest': return div(oi, guests)
  }
  return null
}

/* ===== 表示フォーマッタ（コード別の桁・単位ルールを一元化） ===== */
export const fmtVal = (code: string, v: number | null): string => {
  if (v == null) return '-'
  if (PERCENT_CODES.has(code)) return pct(v)
  if (code === '同伴係数') return v.toFixed(2)
  return fmtNum(v)
}
export const fmtDiff = (code: string, v: number | null): string => {
  if (v == null) return '-'
  const sign = v >= 0 ? '+' : ''
  if (PERCENT_CODES.has(code)) return sign + (v * 100).toFixed(1) + 'pt'
  if (code === '同伴係数') return sign + v.toFixed(2)
  return sign + fmtNum(v)
}
export const fmtDerivVal = (kind: 'yen' | 'pct', v: number | null) => (v == null ? '-' : kind === 'pct' ? pct(v) : fmtNum(v))
export const fmtDerivDiff = (kind: 'yen' | 'pct', v: number | null) => {
  if (v == null) return '-'
  const s = v >= 0 ? '+' : ''
  return kind === 'pct' ? s + (v * 100).toFixed(1) + 'pt' : s + fmtNum(v)
}
// 良し悪しの色（up=高いほど良い）
export const goodColor = (v: number | null, base: number, up: boolean) =>
  v == null ? undefined : (v >= base) === up ? 'var(--green)' : 'var(--red)'

/* ===== PLリゾルバ（1施設・1年度分） =====
   予算+実績の生行 + KPI/稼働mart + 月別客室数上書き + 総客室数 を渡すと、
   yojitsu と同一の getBudget / getActual / landingFor 等を返す。全社集計はこれを施設ごとに使う。 */
export interface PlResolverInput {
  budget: BudgetRow[]
  actual: ActualRow[]
  kpi?: KpiRow[]
  occ?: OccRow[]
  opRooms?: Record<string, number>  // 月別客室数の上書き（改装等）
  totalRooms?: number | null
  fy: string
  forecast?: BudgetRow[]            // 見込(budget_monthly version='見込')。着地の残月に使う（実績＞見込＞予算）
}

export interface PlResolver {
  items: { code: string; name: string; category: string | null }[]
  laborCodes: string[]
  sgaCodes: string[]
  months: string[]
  actualMonths: Set<string>
  hasActual: boolean
  getBudget: (code: string, ym: string) => number | null
  getActual: (code: string, ym: string) => number | null
  landingFor: (code: string, ym: string) => number | null
  yearLanding: (code: string) => number | null
  yearBudget: (code: string) => number | null
}

export function makePlResolver({ budget, actual, kpi = [], occ = [], opRooms = {}, totalRooms = null, fy, forecast = [] }: PlResolverInput): PlResolver {
  // 項目（budget の sort_order 順）
  const seen = new Set<string>()
  const items: { code: string; name: string; category: string | null }[] = []
  for (const b of budget.filter((x) => x.fiscal_year === fy).sort((a, z) => (a.sort_order ?? 0) - (z.sort_order ?? 0))) {
    if (seen.has(b.item_code)) continue
    seen.add(b.item_code)
    items.push({ code: b.item_code, name: b.item_name, category: b.category })
  }

  // 人件費・販管費の明細コード（実績集計の再計算に使用）
  const laborSet = new Set(items.filter((i) => i.category === '人件費' && i.code !== 'labor_total').map((i) => i.code))
  laborSet.add('外注費') // 実績側の総外注費
  const laborCodes = [...laborSet]
  const sgaCodes = items.filter((i) => i.category === '販売管理費' && i.code !== 'sga_total').map((i) => i.code)

  // ルックアップマップ
  const budgetMap: Record<string, number | null> = {}
  budget.forEach((b) => { budgetMap[k(b.month, b.item_code)] = b.amount })
  const actualMap: Record<string, number | null> = {}
  actual.forEach((a) => { actualMap[k(a.month, a.item_code)] = a.actual })
  const actualMonths = new Set(actual.map((a) => a.month))
  const forecastMap: Record<string, number | null> = {}
  forecast.forEach((b) => { forecastMap[k(b.month, b.item_code)] = b.amount })
  const hasForecast = forecast.length > 0
  const kpiMap: Record<string, KpiRow> = {}
  kpi.forEach((r) => { kpiMap[r.month] = r })
  const occMap: Record<string, OccRow> = {}
  occ.forEach((r) => { occMap[r.month] = r })

  const months = [...new Set(budget.filter((b) => b.fiscal_year === fy).map((b) => b.month))].sort()

  const getBudget = (code: string, ym: string): number | null => budgetMap[k(ym, code)] ?? null
  const getDays = (ym: string): number | null => occMap[ym]?.operating_days ?? null
  const sumActualRaw = (codes: string[], ym: string): number => codes.reduce((s, c) => s + (actualMap[k(ym, c)] ?? 0), 0)

  // 実績（集計行は明細から再計算、KPIは売上実績から取得）
  const getActual = (code: string, ym: string): number | null => {
    if (!actualMonths.has(ym)) return null
    switch (code) {
      case '稼働率': return occMap[ym]?.occ_calendar_days ?? occMap[ym]?.occ ?? null   // 全日ベース優先
      case '販売室数': return occMap[ym]?.rooms_sold ?? null
      case '宿泊客数': return kpiMap[ym]?.guests ?? null
      case '客単価': return kpiMap[ym]?.guest_unit ?? null
      case '室単価': return kpiMap[ym]?.adr ?? null
      case '同伴係数': return kpiMap[ym]?.companion ?? null
      case '稼働日数': return getDays(ym)
      case '在庫数': { const d = getDays(ym); const r = opRooms[ym] ?? totalRooms; return r != null && d != null ? r * d : null }
      case '食材原価率': return null // 実績比率は定義が曖昧なため空欄（予算のみ表示）
      case 'labor_total': return sumActualRaw(laborCodes, ym)
      case 'sga_total': return sumActualRaw(sgaCodes, ym)
      case 'gop': {
        const s = actualMap[k(ym, 'sales_total')], c = actualMap[k(ym, 'cogs_total')]
        if (s == null || c == null) return null
        return s - c - sumActualRaw(laborCodes, ym) - sumActualRaw(sgaCodes, ym)
      }
      case 'ebitda': {
        const g = getActual('gop', ym); if (g == null) return null
        return g - (actualMap[k(ym, '賃借料_旅館_')] ?? 0)
      }
      case 'operating_income': {
        const e = getActual('ebitda', ym); if (e == null) return null
        return e - (actualMap[k(ym, '減価償却費')] ?? 0)
      }
      default: return actualMap[k(ym, code)] ?? null
    }
  }

  // 着地（実績がある月は実績、無い月は「見込があれば見込・無ければ予算」）。実績＞見込＞予算。
  const landingFor = (code: string, ym: string): number | null => {
    if (actualMonths.has(ym)) return getActual(code, ym)
    const f = forecastMap[k(ym, code)]
    return f != null ? f : getBudget(code, ym)
  }
  void hasForecast

  const sumLanding = (code: string): number => months.reduce((s, m) => s + (landingFor(code, m) ?? 0), 0)
  const sumBudgetYear = (code: string): number => months.reduce((s, m) => s + (getBudget(code, m) ?? 0), 0)

  // 年度合計（着地）
  const yearLanding = (code: string): number | null => {
    if (BLANK_YEAR_CODES.has(code)) return null
    if (RECOMPUTE_CODES.has(code)) {
      const div = (a: number, b: number) => (b ? a / b : null)
      if (code === '稼働率') return div(sumLanding('販売室数'), sumLanding('在庫数'))
      if (code === '客単価') return div(sumLanding('sales_total'), sumLanding('宿泊客数'))
      if (code === '室単価') return div(sumLanding('sales_total'), sumLanding('販売室数'))
      if (code === '同伴係数') return div(sumLanding('宿泊客数'), sumLanding('販売室数'))
    }
    return sumLanding(code)
  }
  const yearBudget = (code: string): number | null => {
    if (BLANK_YEAR_CODES.has(code) || RECOMPUTE_CODES.has(code)) return null
    return sumBudgetYear(code)
  }

  const hasActual = actual.some((a) => a.fiscal_year === fy)

  return { items, laborCodes, sgaCodes, months, actualMonths, hasActual, getBudget, getActual, landingFor, yearLanding, yearBudget }
}
