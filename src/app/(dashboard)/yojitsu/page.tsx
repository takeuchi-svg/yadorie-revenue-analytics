'use client'

import { useEffect, useMemo, useState } from 'react'
import { useFacility } from '@/lib/facility-context'
import { supabase } from '@/lib/supabase/client'
import { fetchAll } from '@/lib/supabase/fetch-all'
import { fmtNum, pct } from '@/lib/ui'
import { Loading, Empty, LoadError } from '@/components/page-bits'

/* eslint-disable @typescript-eslint/no-explicit-any */
interface BRow { fiscal_year: string; month: string; category: string | null; item_code: string; item_name: string; amount: number | null; sort_order: number | null }
interface ARow { fiscal_year: string; month: string; item_code: string; actual: number | null }
interface KpiRow { month: string; guests: number | null; adr: number | null; guest_unit: number | null; companion: number | null }
interface OccRow { month: string; rooms_sold: number | null; occ: number | null; operating_days: number | null }

// 折りたたみ対象カテゴリと、その集計行コード
const COLLAPSIBLE: Record<string, string> = { '売上': 'sales_total', '原価': 'cogs_total', '人件費': 'labor_total', '販売管理費': 'sga_total' }
// 集計行（太字・背景）
const CAT_TOTALS = new Set(['sales_total', 'cogs_total', 'labor_total', 'sga_total', 'gop', 'ebitda', 'operating_income'])
// 売上実績(mart)から取得するKPI
const KPI_SALES = new Set(['稼働率', '販売室数', '同伴係数', '宿泊客数', '客単価', '室単価'])
// %表示の行
const PERCENT_CODES = new Set(['稼働率', '食材原価率'])
// 着地年度合計を「合計」せず再計算する比率行
const RECOMPUTE_CODES = new Set(['稼働率', '客単価', '室単価', '同伴係数'])
// 年度合計を空欄にする行
const BLANK_YEAR_CODES = new Set(['食材原価率'])


const k = (ym: string, code: string) => `${ym}|${code}`
const priorYM = (ym: string) => `${Number(ym.slice(0, 4)) - 1}-${ym.slice(5)}`

/* ===== 損益分岐点・原価分析（固変分解） =====
   原価は全額変動費。水道光熱費は変動30%（固定70%）。賞与は計上月そのまま固定費。
   固定費は「総費用 − 変動費」の残差で算出（各項目の固変ラベルと一致し二重計上を防ぐ）。 */
const WATER_VAR_RATIO = 0.30
// 変動費の非原価項目（原価=cogs_totalは別途全額変動として加算）
const COST_VAR_ITEMS = ['雑給', '広告宣伝費', '販売促進費', '消耗品費', '修繕費', 'リネン費', '送客手数料', 'カード手数料', '雑費']

type Agg = { sales: number | null; oi: number | null; gop: number | null; guests: number | null; rooms: number | null; varC: number | null }

// 資源解決関数 g(code) から変動費を算出（cogsが無い月は null）
function varCostFrom(g: (code: string) => number | null): number | null {
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

const aggFrom = (g: (code: string) => number | null): Agg => ({
  sales: g('sales_total'), oi: g('operating_income'), gop: g('gop'),
  guests: g('宿泊客数'), rooms: g('販売室数'), varC: varCostFrom(g),
})

// 損益関連KPI（kind: 表示形式 / up: 高いほど良い）
const DERIVED: { code: string; name: string; kind: 'yen' | 'pct'; up: boolean }[] = [
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

function calcDeriv(code: string, a: Agg): number | null {
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

const fmtDerivVal = (kind: 'yen' | 'pct', v: number | null) => (v == null ? '-' : kind === 'pct' ? pct(v) : fmtNum(v))
const fmtDerivDiff = (kind: 'yen' | 'pct', v: number | null) => {
  if (v == null) return '-'
  const s = v >= 0 ? '+' : ''
  return kind === 'pct' ? s + (v * 100).toFixed(1) + 'pt' : s + fmtNum(v)
}
// 良し悪しの色（up=高いほど良い）
const goodColor = (v: number | null, base: number, up: boolean) =>
  v == null ? undefined : (v >= base) === up ? 'var(--green)' : 'var(--red)'

export default function YojitsuPage() {
  const { current, currentFacility } = useFacility()
  const [budget, setBudget] = useState<BRow[]>([])
  const [actual, setActual] = useState<ARow[]>([])
  const [kpi, setKpi] = useState<KpiRow[]>([])
  const [occ, setOcc] = useState<OccRow[]>([])
  const [opRooms, setOpRooms] = useState<Record<string, number>>({})  // 月別客室数の上書き（稼働日数は稼働率martから自動）
  const [fy, setFy] = useState('')
  const [month, setMonth] = useState('')
  const [view, setView] = useState<'month' | 'year'>('month')
  const [yCmp, setYCmp] = useState<'予算差異' | '予算比' | '昨対比'>('予算差異')
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')

  const totalRooms = currentFacility?.total_rooms ?? null

  useEffect(() => {
    if (!current) return
    setLoading(true)
    Promise.all([
      fetchAll(() => supabase.from('budget_monthly').select('fiscal_year, month, category, item_code, item_name, amount, sort_order').eq('facility', current).order('id')),
      fetchAll(() => supabase.from('actual_monthly').select('fiscal_year, month, item_code, actual').eq('facility', current).order('id')),
      fetchAll(() => supabase.from('mart_monthly_kpi').select('month, guests, adr, guest_unit, companion').eq('facility', current)),
      fetchAll(() => supabase.from('mart_occupancy_monthly').select('month, rooms_sold, occ, operating_days').eq('facility', current)),
      supabase.from('dim_operating_days').select('month, rooms').eq('facility', current).then((r) => r),
    ]).then(([b, a, kp, oc, od]: any[]) => {
      setBudget((b as BRow[]) ?? [])
      setActual((a as ARow[]) ?? [])
      setKpi((kp as KpiRow[]) ?? [])
      setOcc((oc as OccRow[]) ?? [])
      const rm: Record<string, number> = {}
      ;((od?.data as { month: string; rooms: number | null }[]) ?? []).forEach((r) => {
        if (r.rooms != null) rm[r.month] = r.rooms  // 月別客室数の上書き（改装等）
      })
      setOpRooms(rm)
    }).catch((e: unknown) => setLoadError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false))
  }, [current])

  const fys = useMemo(() => [...new Set(budget.map((b) => b.fiscal_year))].sort().reverse(), [budget])
  useEffect(() => { if (fys.length && !fys.includes(fy)) setFy(fys[0]) }, [fys, fy])

  const months = useMemo(() => [...new Set(budget.filter((b) => b.fiscal_year === fy).map((b) => b.month))].sort(), [budget, fy])
  useEffect(() => { if (months.length && !months.includes(month)) setMonth(months[0]) }, [months, month])

  // 項目（budget の sort_order 順）
  const items = useMemo(() => {
    const seen = new Set<string>(); const list: { code: string; name: string; category: string | null }[] = []
    for (const b of budget.filter((x) => x.fiscal_year === fy).sort((a, z) => (a.sort_order ?? 0) - (z.sort_order ?? 0))) {
      if (seen.has(b.item_code)) continue; seen.add(b.item_code)
      list.push({ code: b.item_code, name: b.item_name, category: b.category })
    }
    return list
  }, [budget, fy])

  // 人件費・販管費の明細コード（実績集計の再計算に使用）
  const laborCodes = useMemo(() => {
    const s = new Set(items.filter((i) => i.category === '人件費' && i.code !== 'labor_total').map((i) => i.code))
    s.add('外注費') // 実績側の総外注費
    return [...s]
  }, [items])
  const sgaCodes = useMemo(() => items.filter((i) => i.category === '販売管理費' && i.code !== 'sga_total').map((i) => i.code), [items])

  // ---- ルックアップマップ ----
  const budgetMap = useMemo(() => { const m: Record<string, number | null> = {}; budget.forEach((b) => { m[k(b.month, b.item_code)] = b.amount }); return m }, [budget])
  const actualMap = useMemo(() => { const m: Record<string, number | null> = {}; actual.forEach((a) => { m[k(a.month, a.item_code)] = a.actual }); return m }, [actual])
  const actualMonths = useMemo(() => new Set(actual.map((a) => a.month)), [actual])
  const kpiMap = useMemo(() => { const m: Record<string, KpiRow> = {}; kpi.forEach((r) => { m[r.month] = r }); return m }, [kpi])
  const occMap = useMemo(() => { const m: Record<string, OccRow> = {}; occ.forEach((r) => { m[r.month] = r }); return m }, [occ])

  const getBudget = (code: string, ym: string): number | null => budgetMap[k(ym, code)] ?? null
  const getDays = (ym: string): number | null => occMap[ym]?.operating_days ?? null  // 稼働日数=販売実績のある日数（martで自動算出）
  const sumActualRaw = (codes: string[], ym: string): number =>
    codes.reduce((s, c) => s + (actualMap[k(ym, c)] ?? 0), 0)

  // 実績（集計行は明細から再計算、KPIは売上実績から取得）
  const getActual = (code: string, ym: string): number | null => {
    if (!actualMonths.has(ym)) return null
    switch (code) {
      case '稼働率': return occMap[ym]?.occ ?? null
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

  // 着地（実績がある月は実績、無い月は予算）
  const landingFor = (code: string, ym: string): number | null =>
    actualMonths.has(ym) ? getActual(code, ym) : getBudget(code, ym)

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

  // 表示フォーマット
  const fmtVal = (code: string, v: number | null): string => {
    if (v == null) return '-'
    if (PERCENT_CODES.has(code)) return pct(v)
    if (code === '同伴係数') return v.toFixed(2)
    return fmtNum(v)
  }
  const fmtDiff = (code: string, v: number | null): string => {
    if (v == null) return '-'
    const sign = v >= 0 ? '+' : ''
    if (PERCENT_CODES.has(code)) return sign + (v * 100).toFixed(1) + 'pt'
    if (code === '同伴係数') return sign + v.toFixed(2)
    return sign + fmtNum(v)
  }

  const toggle = (cat: string) => setCollapsed((p) => { const n = new Set(p); n.has(cat) ? n.delete(cat) : n.add(cat); return n })
  const isHidden = (it: { code: string; category: string | null }) =>
    it.category != null && it.category in COLLAPSIBLE && collapsed.has(it.category) && it.code !== COLLAPSIBLE[it.category]

  const visibleItems = items.filter((it) => !isHidden(it))

  // ---- 損益分岐点・原価分析の集計 ----
  // 単月（実績/予算/前年）
  const derivA = aggFrom((c) => getActual(c, month))
  const derivB = aggFrom((c) => getBudget(c, month))
  const derivP = aggFrom((c) => getActual(c, priorYM(month)))
  // 年度: 月別Agg（実績/予算/前年）と年度集計
  const actAggByMonth: Record<string, Agg> = {}
  const budAggByMonth: Record<string, Agg> = {}
  const priorAggByMonth: Record<string, Agg> = {}
  for (const m of months) {
    actAggByMonth[m] = aggFrom((c) => getActual(c, m))
    budAggByMonth[m] = aggFrom((c) => getBudget(c, m))
    priorAggByMonth[m] = aggFrom((c) => getActual(c, priorYM(m)))
  }
  const sumAgg = (resolve: (m: string) => (c: string) => number | null): Agg => {
    let sales = 0, oi = 0, gop = 0, guests = 0, rooms = 0, varC = 0
    for (const m of months) {
      const g = resolve(m)
      sales += g('sales_total') ?? 0
      oi += g('operating_income') ?? 0
      gop += g('gop') ?? 0
      guests += g('宿泊客数') ?? 0
      rooms += g('販売室数') ?? 0
      varC += varCostFrom(g) ?? 0
    }
    return { sales, oi, gop, guests, rooms, varC }
  }
  const derivYearLand = sumAgg((m) => (c) => landingFor(c, m))
  const derivYearBudget = sumAgg((m) => (c) => getBudget(c, m))

  return (
    <div className="p-6">
      <div className="flex items-end justify-between mb-4 flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold mb-1">予実管理</h1>
          <p className="text-sm" style={{ color: 'var(--text-dim)' }}>{currentFacility?.name ?? current}</p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <div className="flex rounded-md overflow-hidden" style={{ border: '1px solid var(--border)' }}>
            {(['month', 'year'] as const).map((v) => (
              <button key={v} onClick={() => setView(v)} className="px-3 py-1.5 text-xs"
                style={{ background: view === v ? 'var(--accent)' : 'var(--surface)', color: view === v ? '#fff' : 'var(--text-dim)' }}>
                {v === 'month' ? '単月' : '年度'}
              </button>
            ))}
          </div>
          {view === 'year' && (
            <div className="flex rounded-md overflow-hidden" style={{ border: '1px solid var(--border)' }}>
              {(['予算差異', '予算比', '昨対比'] as const).map((c) => (
                <button key={c} onClick={() => setYCmp(c)} className="px-3 py-1.5 text-xs"
                  style={{ background: yCmp === c ? 'var(--accent)' : 'var(--surface)', color: yCmp === c ? '#fff' : 'var(--text-dim)' }}>
                  {c}
                </button>
              ))}
            </div>
          )}
          {fys.length > 0 && (
            <select className="field px-3 py-1.5 text-sm" value={fy} onChange={(e) => setFy(e.target.value)}>
              {fys.map((y) => <option key={y} value={y}>{y}年度</option>)}
            </select>
          )}
          {view === 'month' && months.length > 0 && (
            <select className="field px-3 py-1.5 text-sm" value={month} onChange={(e) => setMonth(e.target.value)}>
              {months.map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
          )}
        </div>
      </div>

      {loading ? <Loading /> : loadError ? <LoadError message={loadError} /> : budget.length === 0 ? (
        <Empty message="予算データが未取込です。計画スプレッドシートから取り込んでください。" />
      ) : (
        <>
          {!hasActual && (
            <div className="card p-3 mb-4 text-sm" style={{ borderColor: 'var(--yellow)', color: 'var(--text-dim)' }}>
              この年度の実績データ（actual_monthly）が未取込です。予算のみ表示します。
            </div>
          )}

          {view === 'month' ? (
            /* ===== 単月ビュー ===== */
            <>
            <div className="card overflow-auto" style={{ maxHeight: 'calc(100vh - 200px)' }}>
              <table className="w-full text-sm">
                <thead className="[&_th]:sticky [&_th]:top-0 [&_th]:z-10 [&_th]:bg-[var(--surface2)]">
                  <tr style={{ color: 'var(--text-dim)' }} className="text-left">
                    <th className="px-4 py-3 whitespace-nowrap">項目（{month}）</th>
                    <th className="px-4 py-3 text-right">実績</th>
                    <th className="px-4 py-3 text-right">予算</th>
                    <th className="px-4 py-3 text-right">予算差異</th>
                    <th className="px-4 py-3 text-right">達成率</th>
                    <th className="px-4 py-3 text-right">昨年</th>
                    <th className="px-4 py-3 text-right">前年比</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleItems.map((it) => {
                    const b = getBudget(it.code, month)
                    const a = getActual(it.code, month)
                    const prior = getActual(it.code, priorYM(month))
                    const diff = a != null && b != null ? a - b : null
                    const rate = a != null && b ? a / b : null
                    const yoy = a != null && prior ? a / prior : null
                    const isTotal = CAT_TOTALS.has(it.code)
                    const cat = it.category && it.category in COLLAPSIBLE ? it.category : null
                    const isGroupHead = cat != null && it.code === COLLAPSIBLE[cat]
                    return (
                      <tr key={it.code} style={{ borderTop: '1px solid var(--border)', background: isTotal ? 'var(--surface2)' : undefined }}>
                        <td className={`px-4 py-2 whitespace-nowrap ${isTotal ? 'font-semibold' : ''}`}>
                          {isGroupHead ? (
                            <button onClick={() => toggle(cat!)} className="flex items-center gap-1.5">
                              <span style={{ color: 'var(--text-dim)', width: 12, display: 'inline-block' }}>{collapsed.has(cat!) ? '▸' : '▾'}</span>
                              {it.name}
                            </button>
                          ) : (
                            <span className={isTotal ? '' : 'pl-4'} style={{ color: isTotal ? undefined : 'var(--text-dim)' }}>{it.name}</span>
                          )}
                        </td>
                        <td className="px-4 py-2 text-right">{fmtVal(it.code, a)}</td>
                        <td className="px-4 py-2 text-right" style={{ color: 'var(--text-dim)' }}>{fmtVal(it.code, b)}</td>
                        <td className="px-4 py-2 text-right" style={{ color: diff == null ? undefined : diff >= 0 ? 'var(--green)' : 'var(--red)' }}>{fmtDiff(it.code, diff)}</td>
                        <td className="px-4 py-2 text-right" style={{ color: rate == null ? undefined : rate >= 1 ? 'var(--green)' : 'var(--red)' }}>{pct(rate)}</td>
                        <td className="px-4 py-2 text-right" style={{ color: 'var(--text-dim)' }}>{fmtVal(it.code, prior)}</td>
                        <td className="px-4 py-2 text-right">{pct(yoy)}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>

            {/* ===== 損益分岐点・原価分析（単月） ===== */}
            <div className="text-sm font-semibold mt-6 mb-2" style={{ color: 'var(--text)' }}>損益分岐点・原価分析</div>
            <div className="card overflow-auto" style={{ maxHeight: 'calc(100vh - 200px)' }}>
              <table className="w-full text-sm">
                <thead className="[&_th]:sticky [&_th]:top-0 [&_th]:z-10 [&_th]:bg-[var(--surface2)]">
                  <tr style={{ color: 'var(--text-dim)' }} className="text-left">
                    <th className="px-4 py-3 whitespace-nowrap">項目（{month}）</th>
                    <th className="px-4 py-3 text-right">実績</th>
                    <th className="px-4 py-3 text-right">予算</th>
                    <th className="px-4 py-3 text-right">予算差異</th>
                    <th className="px-4 py-3 text-right">達成率</th>
                    <th className="px-4 py-3 text-right">昨年</th>
                    <th className="px-4 py-3 text-right">前年比</th>
                  </tr>
                </thead>
                <tbody>
                  {DERIVED.map((d) => {
                    const a = calcDeriv(d.code, derivA)
                    const b = calcDeriv(d.code, derivB)
                    const prior = calcDeriv(d.code, derivP)
                    const diff = a != null && b != null ? a - b : null
                    const rate = a != null && b ? a / b : null
                    const yoy = a != null && prior ? a / prior : null
                    return (
                      <tr key={d.code} style={{ borderTop: '1px solid var(--border)' }}>
                        <td className="px-4 py-2 whitespace-nowrap" style={{ color: 'var(--text-dim)' }}>{d.name}</td>
                        <td className="px-4 py-2 text-right">{fmtDerivVal(d.kind, a)}</td>
                        <td className="px-4 py-2 text-right" style={{ color: 'var(--text-dim)' }}>{fmtDerivVal(d.kind, b)}</td>
                        <td className="px-4 py-2 text-right" style={{ color: goodColor(diff, 0, d.up) }}>{fmtDerivDiff(d.kind, diff)}</td>
                        <td className="px-4 py-2 text-right" style={{ color: goodColor(rate, 1, d.up) }}>{pct(rate)}</td>
                        <td className="px-4 py-2 text-right" style={{ color: 'var(--text-dim)' }}>{fmtDerivVal(d.kind, prior)}</td>
                        <td className="px-4 py-2 text-right">{pct(yoy)}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
            </>
          ) : (
            /* ===== 年度ビュー ===== */
            <>
              <div className="flex items-center gap-4 mb-2 text-xs" style={{ color: 'var(--text-dim)' }}>
                <span className="flex items-center gap-1"><span style={{ width: 10, height: 10, background: 'var(--accent)', borderRadius: 2, display: 'inline-block' }} />実績</span>
                <span className="flex items-center gap-1"><span style={{ width: 10, height: 10, background: 'var(--border)', borderRadius: 2, display: 'inline-block' }} />予算（着地見込み）</span>
                <span>上段=実績／予算、下段={yCmp}</span>
              </div>
              <div className="card overflow-auto" style={{ maxHeight: 'calc(100vh - 220px)' }}>
                <table className="w-full text-sm border-separate" style={{ borderSpacing: 0 }}>
                  <thead>
                    <tr style={{ color: 'var(--text-dim)' }}>
                      <th className="px-4 h-14 whitespace-nowrap text-left sticky left-0 top-0 z-30"
                        style={{ background: 'var(--surface2)', borderRight: '2px solid var(--border)' }}>項目</th>
                      {months.map((m) => {
                        const act = actualMonths.has(m)
                        return (
                          <th key={m} className="px-3 h-14 text-right whitespace-nowrap sticky top-0 z-20" style={{ minWidth: 104, background: 'var(--surface2)' }}>
                            <div style={{ color: act ? 'var(--accent)' : 'var(--text-dim)', fontWeight: act ? 600 : 400 }}>{m.slice(5)}月</div>
                            <div className="text-[10px]">{act ? '実績' : '予算'}</div>
                          </th>
                        )
                      })}
                      <th className="px-3 h-14 text-right whitespace-nowrap sticky top-0 z-20" style={{ minWidth: 116, background: 'var(--surface)', borderLeft: '2px solid var(--border)' }}>
                        <div className="font-semibold" style={{ color: 'var(--text)' }}>年度合計</div>
                        <div className="text-[10px]">着地見込み</div>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {visibleItems.map((it) => {
                      const isTotal = CAT_TOTALS.has(it.code)
                      const cat = it.category && it.category in COLLAPSIBLE ? it.category : null
                      const isGroupHead = cat != null && it.code === COLLAPSIBLE[cat]
                      const rowBg = isTotal ? 'var(--surface2)' : 'var(--surface)'
                      const land = yearLanding(it.code)
                      const yb = yearBudget(it.code)
                      const ydiff = land != null && yb != null ? land - yb : null
                      return (
                        <tr key={it.code} style={{ background: isTotal ? 'var(--surface2)' : undefined }}>
                          <td className={`px-4 h-14 whitespace-nowrap sticky left-0 z-10 ${isTotal ? 'font-semibold' : ''}`}
                            style={{ background: rowBg, borderTop: '1px solid var(--border)', borderRight: '2px solid var(--border)' }}>
                            {isGroupHead ? (
                              <button onClick={() => toggle(cat!)} className="flex items-center gap-1.5">
                                <span style={{ color: 'var(--text-dim)', width: 12, display: 'inline-block' }}>{collapsed.has(cat!) ? '▸' : '▾'}</span>
                                {it.name}
                              </button>
                            ) : (
                              <span className={isTotal ? '' : 'pl-4'} style={{ color: isTotal ? undefined : 'var(--text-dim)' }}>{it.name}</span>
                            )}
                          </td>
                          {months.map((m) => {
                            const act = actualMonths.has(m)
                            const a = getActual(it.code, m)
                            const b = getBudget(it.code, m)
                            const top = act ? a : b
                            let sub = ''
                            let subColor = 'var(--text-dim)'
                            if (act && a != null) {
                              if (yCmp === '予算差異') {
                                const d = b != null ? a - b : null
                                sub = fmtDiff(it.code, d); subColor = d == null ? 'var(--text-dim)' : d >= 0 ? 'var(--green)' : 'var(--red)'
                              } else if (yCmp === '予算比') {
                                const r = b ? a / b : null; sub = pct(r); subColor = r == null ? 'var(--text-dim)' : r >= 1 ? 'var(--green)' : 'var(--red)'
                              } else {
                                const p = getActual(it.code, priorYM(m)); const r = p ? a / p : null; sub = pct(r); subColor = r == null ? 'var(--text-dim)' : r >= 1 ? 'var(--green)' : 'var(--red)'
                              }
                            }
                            return (
                              <td key={m} className="px-3 h-14 text-right whitespace-nowrap" style={{ minWidth: 104, borderTop: '1px solid var(--border)' }}>
                                <div style={{ color: act ? 'var(--text)' : 'var(--text-dim)', fontStyle: act ? undefined : 'italic' }}>{fmtVal(it.code, top)}</div>
                                <div className="text-[10px]" style={{ color: subColor }}>{sub}</div>
                              </td>
                            )
                          })}
                          <td className="px-3 h-14 text-right whitespace-nowrap" style={{ minWidth: 116, background: 'var(--surface)', borderLeft: '2px solid var(--border)', borderTop: '1px solid var(--border)' }}>
                            <div className={isTotal ? 'font-semibold' : ''}>{fmtVal(it.code, land)}</div>
                            <div className="text-[10px]" style={{ color: ydiff == null ? 'var(--text-dim)' : ydiff >= 0 ? 'var(--green)' : 'var(--red)' }}>{ydiff == null ? '' : fmtDiff(it.code, ydiff)}</div>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>

              {/* ===== 損益分岐点・原価分析（年度） ===== */}
              <div className="text-sm font-semibold mt-6 mb-2" style={{ color: 'var(--text)' }}>損益分岐点・原価分析</div>
              <div className="card overflow-auto" style={{ maxHeight: 'calc(100vh - 220px)' }}>
                <table className="w-full text-sm border-separate" style={{ borderSpacing: 0 }}>
                  <thead>
                    <tr style={{ color: 'var(--text-dim)' }}>
                      <th className="px-4 h-14 whitespace-nowrap text-left sticky left-0 top-0 z-30"
                        style={{ background: 'var(--surface2)', borderRight: '2px solid var(--border)' }}>項目</th>
                      {months.map((m) => {
                        const act = actualMonths.has(m)
                        return (
                          <th key={m} className="px-3 h-14 text-right whitespace-nowrap sticky top-0 z-20" style={{ minWidth: 104, background: 'var(--surface2)' }}>
                            <div style={{ color: act ? 'var(--accent)' : 'var(--text-dim)', fontWeight: act ? 600 : 400 }}>{m.slice(5)}月</div>
                            <div className="text-[10px]">{act ? '実績' : '予算'}</div>
                          </th>
                        )
                      })}
                      <th className="px-3 h-14 text-right whitespace-nowrap sticky top-0 z-20" style={{ minWidth: 116, background: 'var(--surface)', borderLeft: '2px solid var(--border)' }}>
                        <div className="font-semibold" style={{ color: 'var(--text)' }}>年度合計</div>
                        <div className="text-[10px]">着地見込み</div>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {DERIVED.map((d) => {
                      const land = calcDeriv(d.code, derivYearLand)
                      const yb = calcDeriv(d.code, derivYearBudget)
                      const ydiff = land != null && yb != null ? land - yb : null
                      return (
                        <tr key={d.code}>
                          <td className="px-4 h-14 whitespace-nowrap sticky left-0 z-10"
                            style={{ background: 'var(--surface)', borderTop: '1px solid var(--border)', borderRight: '2px solid var(--border)', color: 'var(--text-dim)' }}>{d.name}</td>
                          {months.map((m) => {
                            const act = actualMonths.has(m)
                            const top = calcDeriv(d.code, act ? actAggByMonth[m] : budAggByMonth[m])
                            let sub = ''
                            let subColor = 'var(--text-dim)'
                            if (act && top != null) {
                              if (yCmp === '予算差異') {
                                const bv = calcDeriv(d.code, budAggByMonth[m]); const dd = bv != null ? top - bv : null
                                sub = fmtDerivDiff(d.kind, dd); subColor = goodColor(dd, 0, d.up) ?? 'var(--text-dim)'
                              } else if (yCmp === '予算比') {
                                const bv = calcDeriv(d.code, budAggByMonth[m]); const r = bv ? top / bv : null
                                sub = pct(r); subColor = goodColor(r, 1, d.up) ?? 'var(--text-dim)'
                              } else {
                                const pv = calcDeriv(d.code, priorAggByMonth[m]); const r = pv ? top / pv : null
                                sub = pct(r); subColor = goodColor(r, 1, d.up) ?? 'var(--text-dim)'
                              }
                            }
                            return (
                              <td key={m} className="px-3 h-14 text-right whitespace-nowrap" style={{ minWidth: 104, borderTop: '1px solid var(--border)' }}>
                                <div style={{ color: act ? 'var(--text)' : 'var(--text-dim)', fontStyle: act ? undefined : 'italic' }}>{fmtDerivVal(d.kind, top)}</div>
                                <div className="text-[10px]" style={{ color: subColor }}>{sub}</div>
                              </td>
                            )
                          })}
                          <td className="px-3 h-14 text-right whitespace-nowrap" style={{ minWidth: 116, background: 'var(--surface)', borderLeft: '2px solid var(--border)', borderTop: '1px solid var(--border)' }}>
                            <div>{fmtDerivVal(d.kind, land)}</div>
                            <div className="text-[10px]" style={{ color: goodColor(ydiff, 0, d.up) ?? 'var(--text-dim)' }}>{ydiff == null ? '' : fmtDerivDiff(d.kind, ydiff)}</div>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            </>
          )}

          <p className="text-xs mt-2" style={{ color: 'var(--text-dim)' }}>
            予算=月次計画、実績=アップロード由来（集計行は明細から再計算）。KPI（稼働率・販売室数・客数・単価等）は売上実績、在庫数=客室数×稼働日数（稼働日数=販売実績のある日数を自動算出。改装等で部屋数が変わる月は設定で客室数を上書き可）。
            {view === 'year' && ' 年度合計=着地見込み（実績月は実績、未到来月は予算）。下段の年度合計差異は対予算。'}
            <br />
            損益分岐点・原価分析: 原価=全額変動費／水道光熱費=変動30%・固定70%／賞与=計上月のまま固定費。総費用=売上−営業利益、固定費=総費用−変動費。限界利益率=(売上−変動費)/売上、損益分岐点売上高=固定費/限界利益率。1人あたり=÷宿泊客数、1部屋あたり=÷販売室数。
          </p>
        </>
      )}
    </div>
  )
}
