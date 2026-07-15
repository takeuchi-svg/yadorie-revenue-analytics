// 全社Core: 全施設横断の集計データ層。
//
// 設計:
// - PL（売上・営業利益・GOP・人件費）は施設ごとに pl-compute の makePlResolver を適用して算出する。
//   → 予実ページ(yojitsu)と同一コードなので、全社の数字は施設別合計と構造的に一致する。
// - OCC/客単価/生産性/満足度/NPS は各martを全施設一括fetch（ownerはRLSで全件取得）。
// - 全店/既存店/新店は facility-class（13ヶ月ルール）で当月を基準に区分。
// - 比率の全社集計は「率の平均」ではなく Σ分子 / Σ分母 で再計算する（規模差で歪めない）。
//
// 定義メモ（要確認・PL分析に寄せた既定値）:
// - 人件費率 = 人件費(PL labor_total) ÷ 売上。生産性ページの固定コードではなくPLの人件費categoryに統一。
// - OCC = 全日ベース(occ_calendar_days)。全社集計は Σ販売室数 / Σ(客室数 × 当月暦日数)。
// - 満足度 = mart_guest_feedback_3mo の web/overall 平滑値（クチコミ総合）。アンケート統合は今後の精緻化。
// - 生産性 = 売上(mart) ÷ 総労働時間(勤怠)。勤怠のある月のみ。

import type { SupabaseClient } from '@supabase/supabase-js'
import { fetchAll } from '@/lib/supabase/fetch-all'
import { makePlResolver, priorYM, type BudgetRow, type ActualRow } from '@/lib/pl-compute'
import { classifyFacility, inScope, type FacilityClass, type StoreScope } from '@/lib/company/facility-class'

/* ===== 型 ===== */
// 実績/予算/前年 の三つ組
export interface Triple { act: number | null; bud: number | null; prior: number | null }

export interface FacilityMetrics {
  facility: string
  name: string
  facilityType: string | null
  openingDate: string | null
  cls: FacilityClass
  // PL（施設ごとに pl-compute で算出）
  sales: Triple
  operatingIncome: Triple
  gop: Triple
  labor: Triple                 // 人件費(PL labor_total)
  // 稼働・単価（全日ベース）
  roomsSold: number | null      // 当月販売室数（OCC全社再計算用）
  totalRooms: number | null     // 当月客室数
  occ: number | null            // 全日ベース稼働率（実績・当月）
  occPrior: number | null
  revenue: number | null        // 売上実績(mart。客単価/生産性の分子)
  guests: number | null         // 人泊（客単価全社再計算用）
  guestUnit: number | null      // 客単価(人泊単価・当月)
  guestUnitPrior: number | null
  // 生産性
  workHours: number | null      // 総労働時間（当月・勤怠）
  // 満足度・NPS
  satisfaction: number | null   // クチコミ総合(平滑, 当月)
  satisfactionN: number | null
  nps: number | null
  npsN: number | null
}

export interface CompanyDataset {
  targetMonth: string           // 'YYYY-MM'
  priorMonth: string
  facilities: FacilityMetrics[]
}

/* ===== ヘルパ ===== */
const fyOf = (ym: string): number => { const y = +ym.slice(0, 4), m = +ym.slice(5, 7); return m >= 4 ? y : y - 1 }
const daysInMonth = (ym: string): number => new Date(+ym.slice(0, 4), +ym.slice(5, 7), 0).getDate()
const num = (v: unknown): number | null => (v == null ? null : Number(v))

/* ===== fetch + 施設別メトリクス構築 ===== */
export async function loadCompanyData(sb: SupabaseClient, targetMonth: string): Promise<CompanyDataset> {
  const priorMonth = priorYM(targetMonth)
  const targetFY = fyOf(targetMonth)
  const fyList = [String(targetFY), String(targetFY - 1)]   // 予算・当月実績=targetFY / 前年実績=targetFY-1
  const monthList = [targetMonth, priorMonth]

  const [dimFac, dimProf, budget, actual, occ, kpi, labor, feedback, nps] = await Promise.all([
    fetchAll(() => sb.from('dim_facility').select('facility, name, total_rooms, opening_date')),
    fetchAll(() => sb.from('dim_facility_profile').select('facility, facility_type')),
    fetchAll(() => sb.from('budget_monthly').select('facility, fiscal_year, month, category, item_code, item_name, amount, sort_order').in('fiscal_year', fyList).order('id')),
    fetchAll(() => sb.from('actual_monthly').select('facility, fiscal_year, month, item_code, actual').in('fiscal_year', fyList).order('id')),
    fetchAll(() => sb.from('mart_occupancy_monthly').select('facility, month, rooms_sold, total_rooms, occ, occ_calendar_days').in('month', monthList)),
    fetchAll(() => sb.from('mart_monthly_kpi').select('facility, month, revenue, guests, guest_unit').in('month', monthList)),
    fetchAll(() => sb.from('mart_labor_monthly').select('facility, month, total_work_hours').eq('month', targetMonth)),
    fetchAll(() => sb.from('mart_guest_feedback_3mo').select('facility, month, channel, axis_code, n, raw_avg, smoothed_avg').eq('month', targetMonth).eq('channel', 'web').eq('axis_code', 'overall')),
    fetchAll(() => sb.from('mart_nps').select('facility, month, n, nps_score').eq('month', targetMonth)),
  ])

  /* eslint-disable @typescript-eslint/no-explicit-any */
  const profByFac = new Map<string, string | null>()
  ;((dimProf as any[]) ?? []).forEach((r) => profByFac.set(r.facility, r.facility_type ?? null))

  // 施設ごとに budget/actual をまとめる
  const budByFac = new Map<string, BudgetRow[]>()
  ;((budget as any[]) ?? []).forEach((r) => { const a = budByFac.get(r.facility) ?? []; a.push(r); budByFac.set(r.facility, a) })
  const actByFac = new Map<string, ActualRow[]>()
  ;((actual as any[]) ?? []).forEach((r) => { const a = actByFac.get(r.facility) ?? []; a.push(r); actByFac.set(r.facility, a) })

  const occByFac = new Map<string, Record<string, any>>()
  ;((occ as any[]) ?? []).forEach((r) => { const o = occByFac.get(r.facility) ?? {}; o[r.month] = r; occByFac.set(r.facility, o) })
  const kpiByFac = new Map<string, Record<string, any>>()
  ;((kpi as any[]) ?? []).forEach((r) => { const o = kpiByFac.get(r.facility) ?? {}; o[r.month] = r; kpiByFac.set(r.facility, o) })
  const laborByFac = new Map<string, any>()
  ;((labor as any[]) ?? []).forEach((r) => laborByFac.set(r.facility, r))
  const fbByFac = new Map<string, any>()
  ;((feedback as any[]) ?? []).forEach((r) => fbByFac.set(r.facility, r))
  const npsByFac = new Map<string, any>()
  ;((nps as any[]) ?? []).forEach((r) => npsByFac.set(r.facility, r))

  const facilities: FacilityMetrics[] = ((dimFac as any[]) ?? []).map((f) => {
    const facBud = budByFac.get(f.facility) ?? []
    const facAct = actByFac.get(f.facility) ?? []
    // PL: 当該FYで pl-compute（budgetが無い施設は items/laborCodes が定義できずPL再計算不可 → null）
    const R = makePlResolver({ budget: facBud, actual: facAct, fy: String(targetFY) })
    const hasBudget = facBud.some((b) => b.fiscal_year === String(targetFY))
    const triple = (code: string): Triple => hasBudget
      ? { act: R.getActual(code, targetMonth), bud: R.getBudget(code, targetMonth), prior: R.getActual(code, priorMonth) }
      : { act: null, bud: null, prior: null }

    const occT = occByFac.get(f.facility)?.[targetMonth]
    const occP = occByFac.get(f.facility)?.[priorMonth]
    const kpiT = kpiByFac.get(f.facility)?.[targetMonth]
    const kpiP = kpiByFac.get(f.facility)?.[priorMonth]
    const fb = fbByFac.get(f.facility)
    const npsRow = npsByFac.get(f.facility)

    return {
      facility: f.facility,
      name: f.name ?? f.facility,
      facilityType: profByFac.get(f.facility) ?? null,
      openingDate: f.opening_date ?? null,
      cls: classifyFacility(f.opening_date ?? null, targetMonth),
      sales: triple('sales_total'),
      operatingIncome: triple('operating_income'),
      gop: triple('gop'),
      labor: triple('labor_total'),
      roomsSold: num(occT?.rooms_sold),
      totalRooms: num(occT?.total_rooms) ?? num(f.total_rooms),
      occ: num(occT?.occ_calendar_days) ?? num(occT?.occ),
      occPrior: num(occP?.occ_calendar_days) ?? num(occP?.occ),
      revenue: num(kpiT?.revenue),
      guests: num(kpiT?.guests),
      guestUnit: num(kpiT?.guest_unit),
      guestUnitPrior: num(kpiP?.guest_unit),
      workHours: num(laborByFac.get(f.facility)?.total_work_hours),
      satisfaction: num(fb?.smoothed_avg) ?? num(fb?.raw_avg),
      satisfactionN: num(fb?.n),
      nps: num(npsRow?.nps_score),
      npsN: num(npsRow?.n),
    }
  })

  return { targetMonth, priorMonth, facilities }
}

/* ===== スコープ集計（全店/既存店/新店） ===== */
export interface ScopeAggregate {
  scope: StoreScope
  count: number
  sales: Triple
  operatingIncome: Triple
  gop: Triple
  labor: Triple
  laborRatio: number | null      // Σ人件費 / Σ売上（実績）
  gopRatio: number | null        // ΣGOP / Σ売上（実績）
  occ: number | null             // Σ販売室数 / Σ(客室数×暦日数)
  guestUnit: number | null       // Σ売上 / Σ人泊
  revenuePerHour: number | null  // Σ売上 / Σ総労働時間（生産性）
  satisfaction: number | null    // n加重平均
  nps: number | null             // n加重平均
}

const sumTriple = (rows: FacilityMetrics[], pick: (m: FacilityMetrics) => Triple): Triple => {
  const add = (get: (t: Triple) => number | null): number | null => {
    let s = 0, any = false
    for (const r of rows) { const v = get(pick(r)); if (v != null) { s += v; any = true } }
    return any ? s : null
  }
  return { act: add((t) => t.act), bud: add((t) => t.bud), prior: add((t) => t.prior) }
}
const ratio = (a: number | null, b: number | null): number | null => (a != null && b ? a / b : null)
const sumBy = (rows: FacilityMetrics[], get: (m: FacilityMetrics) => number | null): number | null => {
  let s = 0, any = false
  for (const r of rows) { const v = get(r); if (v != null) { s += v; any = true } }
  return any ? s : null
}
const weightedAvg = (rows: FacilityMetrics[], val: (m: FacilityMetrics) => number | null, wt: (m: FacilityMetrics) => number | null): number | null => {
  let sw = 0, swv = 0, any = false
  for (const r of rows) { const v = val(r), w = wt(r); if (v != null && w != null && w > 0) { sw += w; swv += w * v; any = true } }
  return any && sw ? swv / sw : null
}

export function aggregateScope(ds: CompanyDataset, scope: StoreScope): ScopeAggregate {
  const rows = ds.facilities.filter((m) => inScope(m.cls, scope))
  const days = daysInMonth(ds.targetMonth)
  const sales = sumTriple(rows, (m) => m.sales)
  const gop = sumTriple(rows, (m) => m.gop)
  const labor = sumTriple(rows, (m) => m.labor)
  // OCC全社 = Σ販売室数 / Σ(客室数×暦日数)。客室数が無い施設は分母に入れない（分子も除外）。
  const occRows = rows.filter((m) => m.roomsSold != null && m.totalRooms != null)
  const occDen = sumBy(occRows, (m) => (m.totalRooms as number) * days)
  const occNum = sumBy(occRows, (m) => m.roomsSold)
  return {
    scope,
    count: rows.length,
    sales,
    operatingIncome: sumTriple(rows, (m) => m.operatingIncome),
    gop,
    labor,
    laborRatio: ratio(labor.act, sales.act),
    gopRatio: ratio(gop.act, sales.act),
    occ: ratio(occNum, occDen),
    guestUnit: ratio(sumBy(rows, (m) => m.revenue), sumBy(rows, (m) => m.guests)),
    revenuePerHour: ratio(sumBy(rows, (m) => m.revenue), sumBy(rows, (m) => m.workHours)),
    satisfaction: weightedAvg(rows, (m) => m.satisfaction, (m) => m.satisfactionN),
    nps: weightedAvg(rows, (m) => m.nps, (m) => m.npsN),
  }
}
