'use client'

import { useEffect, useMemo, useState } from 'react'
import {
  ComposedChart, Bar, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid,
} from 'recharts'
import { useFacility } from '@/lib/facility-context'
import { supabase } from '@/lib/supabase/client'
import { fetchAll } from '@/lib/supabase/fetch-all'
import { fmtNum, fmtYen, pct, CHART_AXIS, chartTooltip } from '@/lib/ui'
import { Loading, Empty, LoadError } from '@/components/page-bits'

/* eslint-disable @typescript-eslint/no-explicit-any */
interface LaborRow { month: string; staff_count_monthly: number | null; parttime_count: number | null; total_work_hours: number | null; total_overtime_hours: number | null }
interface KpiRow { month: string; revenue: number | null; guests: number | null; rooms_sold: number | null }
interface ActRow { month: string; item_code: string; item_name: string; actual: number | null }
// T13: みなし残業超残業代・派遣時間は手入力(dim_productivity_manual)から
// 勤怠×賃金の自動算出(mart_labor_cost_monthly)へ切替済み
interface LaborCostRow { month: string; deemed_ot_excess_pay: number | null; spot_hours: number | null }

// 人件費 = 以下のitem_name合計（+ 外注費（人材） or 実績合算「外注費」）
const LABOR_NAMES = ['給料手当', '賞与', '通勤費', '法定福利費', '福利厚生費', '雑給']

const fyOf = (ym: string) => { const y = +ym.slice(0, 4), m = +ym.slice(5, 7); return m >= 4 ? y : y - 1 }
const fyMonths = (fy: number): string[] => {
  const out: string[] = []
  for (let m = 4; m <= 12; m++) out.push(`${fy}-${String(m).padStart(2, '0')}`)
  for (let m = 1; m <= 3; m++) out.push(`${fy + 1}-${String(m).padStart(2, '0')}`)
  return out
}
const priorYM = (ym: string) => `${+ym.slice(0, 4) - 1}-${ym.slice(5)}`

// 生産性の構成要素（合算可能な素データ）
type Agg = {
  laborCost: number; plSales: number          // PL（全月）
  workHours: number; overtime: number          // 勤怠（労働月のみ）
  staffSum: number; parttimeSum: number; n: number
  pRevenue: number; pGross: number; pRooms: number; pGuests: number // 労働月のみ（mart由来）
  dispatchHours: number; deemedPay: number      // 勤怠×賃金から自動算出(mart_labor_cost_monthly)
}
const ZERO: Agg = { laborCost: 0, plSales: 0, workHours: 0, overtime: 0, staffSum: 0, parttimeSum: 0, n: 0, pRevenue: 0, pGross: 0, pRooms: 0, pGuests: 0, dispatchHours: 0, deemedPay: 0 }

type Kind = 'pct' | 'yen' | 'hours' | 'hours2' | 'count' | 'perYen'
const KPIS: { code: string; name: string; kind: Kind; up: boolean | null; card?: boolean }[] = [
  { code: 'labor_cost_ratio', name: '売上高人件費率', kind: 'pct', up: false, card: true },
  { code: 'total_work_hours', name: '総労働時間', kind: 'hours', up: null, card: true },
  { code: 'revenue_per_hour', name: '従業員1人1時間あたりの売上', kind: 'yen', up: true, card: true },
  { code: 'value_added_per_hour', name: '従業員1人1時間あたりの付加価値', kind: 'yen', up: true, card: true },
  { code: 'staff_count', name: '社員数（月給）', kind: 'count', up: null, card: true },
  { code: 'parttime_count', name: 'アルバイト数（時給）', kind: 'count', up: null, card: true },
  { code: 'total_overtime', name: '総残業時間', kind: 'hours', up: false, card: true },
  { code: 'hours_per_room', name: '1部屋あたりの労働時間', kind: 'hours2', up: false, card: true },
  { code: 'avg_overtime', name: '月給社員1人あたり平均残業時間', kind: 'hours2', up: false },
  { code: 'hours_per_guest', name: '顧客1人あたりの労働時間', kind: 'hours2', up: false },
  { code: 'dispatch_hours', name: '労働時間（派遣・その他）', kind: 'hours', up: null },
  { code: 'deemed_pay', name: 'みなし残業超の残業代', kind: 'perYen', up: false },
]

function calc(code: string, a: Agg): number | null {
  const div = (x: number, d: number) => (d ? x / d : null)
  const staff = a.n ? a.staffSum / a.n : 0
  switch (code) {
    case 'labor_cost_ratio': return div(a.laborCost, a.plSales)
    case 'total_work_hours': return a.n ? a.workHours : null
    case 'revenue_per_hour': return div(a.pRevenue, a.workHours)
    case 'value_added_per_hour': return div(a.pGross, a.workHours)
    case 'staff_count': return a.n ? Math.round(staff) : null
    case 'parttime_count': return a.n ? Math.round(a.parttimeSum / a.n) : null
    case 'total_overtime': return a.n ? a.overtime : null
    case 'hours_per_room': return div(a.workHours, a.pRooms)
    case 'avg_overtime': return staff ? a.overtime / staff : null
    case 'hours_per_guest': return div(a.workHours, a.pGuests)
    case 'dispatch_hours': return a.dispatchHours || null
    case 'deemed_pay': return a.deemedPay || null
  }
  return null
}

const fmtKpi = (kind: Kind, v: number | null): string => {
  if (v == null) return '-'
  switch (kind) {
    case 'pct': return pct(v)
    case 'yen': return fmtYen(v)
    case 'perYen': return fmtYen(v)
    case 'hours': return fmtNum(v) + 'h'
    case 'hours2': return v.toFixed(2) + 'h'
    case 'count': return fmtNum(v) + '名'
  }
}
const goodColor = (cur: number | null, prior: number | null, up: boolean | null) => {
  if (up == null || cur == null || prior == null || prior === 0) return 'var(--text-dim)'
  return (cur >= prior) === up ? 'var(--green)' : 'var(--red)'
}

export default function ProductivityPage() {
  const { current, currentFacility } = useFacility()
  const [labor, setLabor] = useState<LaborRow[]>([])
  const [kpi, setKpi] = useState<KpiRow[]>([])
  const [actual, setActual] = useState<ActRow[]>([])
  const [laborCost, setLaborCost] = useState<LaborCostRow[]>([])
  const [fy, setFy] = useState<number | null>(null)
  const [month, setMonth] = useState('')
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')

  useEffect(() => {
    if (!current) return
    setLoading(true)
    Promise.all([
      fetchAll(() => supabase.from('mart_labor_monthly').select('month, staff_count_monthly, parttime_count, total_work_hours, total_overtime_hours').eq('facility', current)),
      fetchAll(() => supabase.from('mart_monthly_kpi').select('month, revenue, guests, rooms_sold').eq('facility', current)),
      fetchAll(() => supabase.from('actual_monthly').select('month, item_code, item_name, actual').eq('facility', current).order('id')),
      supabase.from('mart_labor_cost_monthly').select('month, deemed_ot_excess_pay, spot_hours').eq('facility', current).then((r) => r),
    ]).then(([l, k, a, m]: any[]) => {
      setLabor((l as LaborRow[]) ?? [])
      setKpi((k as KpiRow[]) ?? [])
      setActual((a as ActRow[]) ?? [])
      setLaborCost(((m?.data as LaborCostRow[]) ?? []))
    }).catch((e: unknown) => setLoadError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false))
  }, [current])

  // ルックアップ
  const laborMap = useMemo(() => { const o: Record<string, LaborRow> = {}; labor.forEach((r) => { o[r.month] = r }); return o }, [labor])
  const kpiMap = useMemo(() => { const o: Record<string, KpiRow> = {}; kpi.forEach((r) => { o[r.month] = r }); return o }, [kpi])
  const costMap = useMemo(() => { const o: Record<string, LaborCostRow> = {}; laborCost.forEach((r) => { o[r.month] = r }); return o }, [laborCost])
  // actual: month → {byName, byCode}
  const actMap = useMemo(() => {
    const o: Record<string, { name: Record<string, number>; code: Record<string, number> }> = {}
    for (const r of actual) {
      const m = (o[r.month] ??= { name: {}, code: {} })
      if (r.actual != null) { m.name[r.item_name] = (m.name[r.item_name] ?? 0) + r.actual; m.code[r.item_code] = (m.code[r.item_code] ?? 0) + r.actual }
    }
    return o
  }, [actual])

  // 単月の構成要素を取得
  const aggOf = (ym: string): Agg => {
    const a: Agg = { ...ZERO }
    const am = actMap[ym]
    if (am) {
      let lc = 0
      for (const nm of LABOR_NAMES) lc += am.name[nm] ?? 0
      lc += am.name['外注費（人材）'] ?? am.name['外注費'] ?? 0
      a.laborCost = lc
      a.plSales = am.code['sales_total'] ?? 0
      a.pGross = (am.code['sales_total'] ?? 0) - (am.code['cogs_total'] ?? 0)
    }
    const km = kpiMap[ym]
    const lm = laborMap[ym]
    if (lm && (lm.total_work_hours ?? 0) > 0) {
      a.workHours = lm.total_work_hours ?? 0
      a.overtime = lm.total_overtime_hours ?? 0
      a.staffSum = lm.staff_count_monthly ?? 0
      a.parttimeSum = lm.parttime_count ?? 0
      a.n = 1
      a.pRevenue = km?.revenue ?? 0
      a.pRooms = km?.rooms_sold ?? 0
      a.pGuests = km?.guests ?? 0
    }
    const cm = costMap[ym]  // T13: 勤怠×賃金からの自動算出値
    a.dispatchHours = cm?.spot_hours ?? 0
    a.deemedPay = cm?.deemed_ot_excess_pay ?? 0
    return a
  }

  const sumAgg = (months: string[]): Agg => {
    const out: Agg = { ...ZERO }
    for (const ym of months) {
      const a = aggOf(ym)
      out.laborCost += a.laborCost; out.plSales += a.plSales
      out.dispatchHours += a.dispatchHours; out.deemedPay += a.deemedPay
      if (a.n) {
        out.workHours += a.workHours; out.overtime += a.overtime
        out.staffSum += a.staffSum; out.parttimeSum += a.parttimeSum; out.n += 1
        out.pRevenue += a.pRevenue; out.pGross += a.pGross; out.pRooms += a.pRooms; out.pGuests += a.pGuests
      }
    }
    return out
  }

  // 年度・月リスト
  const allMonths = useMemo(() => {
    const s = new Set<string>()
    labor.forEach((r) => s.add(r.month)); kpi.forEach((r) => s.add(r.month)); actual.forEach((r) => s.add(r.month))
    return [...s].sort()
  }, [labor, kpi, actual])
  const fys = useMemo(() => [...new Set(allMonths.map(fyOf))].sort((x, y) => y - x), [allMonths])
  useEffect(() => { if (fys.length && (fy == null || !fys.includes(fy))) setFy(fys[0]) }, [fys, fy])

  const months = useMemo(() => (fy == null ? [] : fyMonths(fy)), [fy])
  const laborMonths = useMemo(() => months.filter((m) => (laborMap[m]?.total_work_hours ?? 0) > 0), [months, laborMap])
  // 選択月: 労働データのある最新月 → 無ければデータのある最新月 → 年度先頭
  useEffect(() => {
    if (!months.length) return
    if (months.includes(month)) return
    const withData = months.filter((m) => laborMap[m] || kpiMap[m] || actMap[m])
    setMonth(laborMonths[laborMonths.length - 1] ?? withData[withData.length - 1] ?? months[0])
  }, [months, laborMonths, month, laborMap, kpiMap, actMap])

  const monthAgg = useMemo(() => (month ? aggOf(month) : { ...ZERO }), [month, aggOf])
  const priorAgg = useMemo(() => (month ? aggOf(priorYM(month)) : { ...ZERO }), [month, aggOf])
  const yearAgg = useMemo(() => sumAgg(months), [months, sumAgg])

  const cardKpis = KPIS.filter((k) => k.card)

  // 月次推移チャート（1人1時間あたり売上）
  const chartData = useMemo(() => months.map((m) => ({
    month: m.slice(5) + '月',
    cur: calc('revenue_per_hour', aggOf(m)),
    prev: calc('revenue_per_hour', aggOf(priorYM(m))),
  })), [months, aggOf])
  const hasChart = chartData.some((d) => d.cur != null)
  const hasPrev = chartData.some((d) => d.prev != null)

  return (
    <div className="p-6">
      <div className="flex items-end justify-between mb-4 flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold mb-1">生産性</h1>
          <p className="text-sm" style={{ color: 'var(--text-dim)' }}>{currentFacility?.name ?? current}</p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-[10px] px-2 py-1 rounded" style={{ background: 'var(--surface2)', color: 'var(--text-dim)' }}>勤怠 + PL + 売上</span>
          {fys.length > 0 && (
            <select className="field px-3 py-1.5 text-sm" value={fy ?? ''} onChange={(e) => setFy(Number(e.target.value))}>
              {fys.map((y) => <option key={y} value={y}>{y}年度</option>)}
            </select>
          )}
          {months.length > 0 && (
            <select className="field px-3 py-1.5 text-sm" value={month} onChange={(e) => setMonth(e.target.value)}>
              {months.map((m) => <option key={m} value={m}>{m}{laborMap[m] ? '' : '（勤怠なし）'}</option>)}
            </select>
          )}
        </div>
      </div>

      {loading ? <Loading /> : loadError ? <LoadError message={loadError} /> : allMonths.length === 0 ? (
        <Empty message="データがありません。勤怠CSV・PL・売上を取り込んでください。" />
      ) : (
        <>
          {laborMonths.length === 0 && (
            <div className="card p-3 mb-4 text-sm" style={{ borderColor: 'var(--yellow)', color: 'var(--text-dim)' }}>
              この年度の勤怠データ（労働時間）が未取込です。アップロード→「勤怠」から取り込むと労働生産性KPIが表示されます。
            </div>
          )}

          {/* KPIカード（選択月。サブは前年同月比） */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
            {cardKpis.map((k) => {
              const cur = calc(k.code, monthAgg)
              const prior = calc(k.code, priorAgg)
              const yoy = cur != null && prior ? cur / prior : null
              return (
                <div key={k.code} className="card p-4">
                  <div className="text-xs mb-1" style={{ color: 'var(--text-dim)' }}>{k.name}</div>
                  <div className="text-xl font-bold">{fmtKpi(k.kind, cur)}</div>
                  <div className="text-[11px] mt-1" style={{ color: goodColor(cur, prior, k.up) }}>
                    {yoy != null ? `前年比 ${pct(yoy)}` : <span style={{ color: 'var(--text-dim)' }}>前年比 -</span>}
                  </div>
                </div>
              )
            })}
          </div>

          {/* 月次推移: 1人1時間あたり売上 */}
          <div className="card p-4 mb-6">
            <div className="text-sm font-semibold mb-3">月次推移：従業員1人1時間あたりの売上</div>
            {hasChart ? (
              <ResponsiveContainer width="100%" height={260}>
                <ComposedChart data={chartData} margin={{ top: 8, right: 8, bottom: 0, left: 8 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#efe6d6" vertical={false} />
                  <XAxis dataKey="month" {...CHART_AXIS} />
                  <YAxis {...CHART_AXIS} tickFormatter={(v) => `¥${fmtNum(v)}`} width={64} />
                  <Tooltip {...chartTooltip} formatter={(v: any) => (v == null ? '-' : fmtYen(v as number))} />
                  <Bar dataKey="cur" name="今年度" fill="#D85A30" radius={[3, 3, 0, 0]} maxBarSize={36} />
                  {hasPrev && <Line dataKey="prev" name="前年度" stroke="#7F77DD" strokeWidth={2} dot={false} />}
                </ComposedChart>
              </ResponsiveContainer>
            ) : (
              <p className="text-sm py-8 text-center" style={{ color: 'var(--text-dim)' }}>勤怠データが入ると表示されます。</p>
            )}
          </div>

          {/* 年度表（項目×月 + 年度合計、サブ行=前年比） */}
          <div className="text-sm font-semibold mb-2">年度推移（{fy}年度）</div>
          <div className="card overflow-auto" style={{ maxHeight: 'calc(100vh - 220px)' }}>
            <table className="w-full text-sm border-separate" style={{ borderSpacing: 0 }}>
              <thead>
                <tr style={{ color: 'var(--text-dim)' }}>
                  <th className="px-4 h-12 whitespace-nowrap text-left sticky left-0 top-0 z-30" style={{ background: 'var(--surface2)', borderRight: '2px solid var(--border)' }}>項目</th>
                  {months.map((m) => {
                    const has = (laborMap[m]?.total_work_hours ?? 0) > 0
                    return (
                      <th key={m} className="px-3 h-12 text-right whitespace-nowrap sticky top-0 z-20" style={{ minWidth: 96, background: 'var(--surface2)' }}>
                        <div style={{ color: has ? 'var(--accent)' : 'var(--text-dim)', fontWeight: has ? 600 : 400 }}>{m.slice(5)}月</div>
                      </th>
                    )
                  })}
                  <th className="px-3 h-12 text-right whitespace-nowrap sticky top-0 z-20" style={{ minWidth: 110, background: 'var(--surface)', borderLeft: '2px solid var(--border)' }}>
                    <div className="font-semibold" style={{ color: 'var(--text)' }}>年度</div>
                  </th>
                </tr>
              </thead>
              <tbody>
                {KPIS.map((k) => {
                  const yv = calc(k.code, yearAgg)
                  return (
                    <tr key={k.code}>
                      <td className="px-4 h-12 whitespace-nowrap sticky left-0 z-10" style={{ background: 'var(--surface)', borderTop: '1px solid var(--border)', borderRight: '2px solid var(--border)', color: 'var(--text-dim)' }}>{k.name}</td>
                      {months.map((m) => {
                        const cur = calc(k.code, aggOf(m))
                        const prior = calc(k.code, aggOf(priorYM(m)))
                        const yoy = cur != null && prior ? cur / prior : null
                        return (
                          <td key={m} className="px-3 h-12 text-right whitespace-nowrap" style={{ minWidth: 96, borderTop: '1px solid var(--border)' }}>
                            <div>{fmtKpi(k.kind, cur)}</div>
                            <div className="text-[10px]" style={{ color: goodColor(cur, prior, k.up) }}>{yoy != null ? pct(yoy) : ''}</div>
                          </td>
                        )
                      })}
                      <td className="px-3 h-12 text-right whitespace-nowrap" style={{ minWidth: 110, background: 'var(--surface)', borderLeft: '2px solid var(--border)', borderTop: '1px solid var(--border)' }}>
                        <div className="font-semibold">{fmtKpi(k.kind, yv)}</div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>

          <p className="text-xs mt-2" style={{ color: 'var(--text-dim)' }}>
            分子（売上・客数・販売室数）は売上実績mart、人件費・付加価値（売上総利益）はPL実績(actual_monthly)、労働時間・人数は勤怠(mart_labor_monthly)。
            人件費=給料手当+賞与+通勤費+法定福利費+福利厚生費+雑給+外注費（人材）。売上高人件費率はPL基準。
            ヘルプ勤務は計上先施設へ、本社部門(HQ)は除外。年度の人数は月平均、比率・原単位は年度合算から再計算。前年比は前年同月の勤怠データがある月のみ表示。
          </p>
        </>
      )}
    </div>
  )
}
