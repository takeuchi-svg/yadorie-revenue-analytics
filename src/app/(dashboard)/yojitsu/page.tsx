'use client'

import { useEffect, useMemo, useState } from 'react'
import { useFacility } from '@/lib/facility-context'
import { supabase } from '@/lib/supabase/client'
import { fmtNum, pct } from '@/lib/ui'
import { Loading, Empty } from '@/components/page-bits'

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

async function fetchAll(build: () => any): Promise<any[]> {
  const size = 1000; let frm = 0; let all: any[] = []
  for (let i = 0; i < 50; i++) {
    const { data, error } = await build().range(frm, frm + size - 1)
    if (error || !data || data.length === 0) break
    all = all.concat(data); if (data.length < size) break; frm += size
  }
  return all
}

const k = (ym: string, code: string) => `${ym}|${code}`
const priorYM = (ym: string) => `${Number(ym.slice(0, 4)) - 1}-${ym.slice(5)}`

export default function YojitsuPage() {
  const { current, currentFacility } = useFacility()
  const [budget, setBudget] = useState<BRow[]>([])
  const [actual, setActual] = useState<ARow[]>([])
  const [kpi, setKpi] = useState<KpiRow[]>([])
  const [occ, setOcc] = useState<OccRow[]>([])
  const [opDays, setOpDays] = useState<Record<string, number>>({})
  const [fy, setFy] = useState('')
  const [month, setMonth] = useState('')
  const [view, setView] = useState<'month' | 'year'>('month')
  const [yCmp, setYCmp] = useState<'予算差異' | '予算比' | '昨対比'>('予算差異')
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const [loading, setLoading] = useState(true)

  const totalRooms = currentFacility?.total_rooms ?? null

  useEffect(() => {
    if (!current) return
    setLoading(true)
    Promise.all([
      fetchAll(() => supabase.from('budget_monthly').select('fiscal_year, month, category, item_code, item_name, amount, sort_order').eq('facility', current).order('id')),
      fetchAll(() => supabase.from('actual_monthly').select('fiscal_year, month, item_code, actual').eq('facility', current).order('id')),
      fetchAll(() => supabase.from('mart_monthly_kpi').select('month, guests, adr, guest_unit, companion').eq('facility', current)),
      fetchAll(() => supabase.from('mart_occupancy_monthly').select('month, rooms_sold, occ, operating_days').eq('facility', current)),
      supabase.from('dim_operating_days').select('month, days').eq('facility', current).then((r) => r),
    ]).then(([b, a, kp, oc, od]: any[]) => {
      setBudget((b as BRow[]) ?? [])
      setActual((a as ARow[]) ?? [])
      setKpi((kp as KpiRow[]) ?? [])
      setOcc((oc as OccRow[]) ?? [])
      const m: Record<string, number> = {}
      ;((od?.data as { month: string; days: number | null }[]) ?? []).forEach((r) => { if (r.days != null) m[r.month] = r.days })
      setOpDays(m)
      setLoading(false)
    })
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
  const getDays = (ym: string): number | null => opDays[ym] ?? occMap[ym]?.operating_days ?? null
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
      case '在庫数': { const d = getDays(ym); return totalRooms != null && d != null ? totalRooms * d : null }
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

      {loading ? <Loading /> : budget.length === 0 ? (
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
            <div className="card overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr style={{ background: 'var(--surface2)', color: 'var(--text-dim)' }} className="text-left">
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
          ) : (
            /* ===== 年度ビュー ===== */
            <>
              <div className="flex items-center gap-4 mb-2 text-xs" style={{ color: 'var(--text-dim)' }}>
                <span className="flex items-center gap-1"><span style={{ width: 10, height: 10, background: 'var(--accent)', borderRadius: 2, display: 'inline-block' }} />実績</span>
                <span className="flex items-center gap-1"><span style={{ width: 10, height: 10, background: 'var(--border)', borderRadius: 2, display: 'inline-block' }} />予算（着地見込み）</span>
                <span>上段=実績／予算、下段={yCmp}</span>
              </div>
              <div className="card overflow-hidden">
                <div className="flex">
                  {/* 固定: 項目列 */}
                  <table className="text-sm shrink-0" style={{ borderRight: '2px solid var(--border)' }}>
                    <thead>
                      <tr style={{ background: 'var(--surface2)', color: 'var(--text-dim)' }} className="text-left">
                        <th className="px-4 h-14 whitespace-nowrap">項目</th>
                      </tr>
                    </thead>
                    <tbody>
                      {visibleItems.map((it) => {
                        const isTotal = CAT_TOTALS.has(it.code)
                        const cat = it.category && it.category in COLLAPSIBLE ? it.category : null
                        const isGroupHead = cat != null && it.code === COLLAPSIBLE[cat]
                        return (
                          <tr key={it.code} style={{ borderTop: '1px solid var(--border)', background: isTotal ? 'var(--surface2)' : undefined }}>
                            <td className={`px-4 h-14 whitespace-nowrap ${isTotal ? 'font-semibold' : ''}`}>
                              {isGroupHead ? (
                                <button onClick={() => toggle(cat!)} className="flex items-center gap-1.5">
                                  <span style={{ color: 'var(--text-dim)', width: 12, display: 'inline-block' }}>{collapsed.has(cat!) ? '▸' : '▾'}</span>
                                  {it.name}
                                </button>
                              ) : (
                                <span className={isTotal ? '' : 'pl-4'} style={{ color: isTotal ? undefined : 'var(--text-dim)' }}>{it.name}</span>
                              )}
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                  {/* スクロール: 各月 + 年度合計 */}
                  <div className="overflow-x-auto flex-1">
                    <table className="text-sm">
                      <thead>
                        <tr style={{ background: 'var(--surface2)', color: 'var(--text-dim)' }}>
                          {months.map((m) => {
                            const act = actualMonths.has(m)
                            return (
                              <th key={m} className="px-3 h-14 text-right whitespace-nowrap" style={{ minWidth: 104 }}>
                                <div style={{ color: act ? 'var(--accent)' : 'var(--text-dim)', fontWeight: act ? 600 : 400 }}>{m.slice(5)}月</div>
                                <div className="text-[10px]">{act ? '実績' : '予算'}</div>
                              </th>
                            )
                          })}
                          <th className="px-3 h-14 text-right whitespace-nowrap" style={{ minWidth: 116, background: 'var(--surface)', borderLeft: '2px solid var(--border)' }}>
                            <div className="font-semibold" style={{ color: 'var(--text)' }}>年度合計</div>
                            <div className="text-[10px]">着地見込み</div>
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {visibleItems.map((it) => {
                          const isTotal = CAT_TOTALS.has(it.code)
                          const land = yearLanding(it.code)
                          const yb = yearBudget(it.code)
                          const ydiff = land != null && yb != null ? land - yb : null
                          return (
                            <tr key={it.code} style={{ borderTop: '1px solid var(--border)', background: isTotal ? 'var(--surface2)' : undefined }}>
                              {months.map((m) => {
                                const act = actualMonths.has(m)
                                const a = getActual(it.code, m)
                                const b = getBudget(it.code, m)
                                const top = act ? a : b
                                let sub: string = ''
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
                                  <td key={m} className="px-3 h-14 text-right whitespace-nowrap" style={{ minWidth: 104 }}>
                                    <div style={{ color: act ? 'var(--text)' : 'var(--text-dim)', fontStyle: act ? undefined : 'italic' }}>{fmtVal(it.code, top)}</div>
                                    <div className="text-[10px]" style={{ color: subColor }}>{sub}</div>
                                  </td>
                                )
                              })}
                              <td className="px-3 h-14 text-right whitespace-nowrap" style={{ minWidth: 116, background: 'var(--surface)', borderLeft: '2px solid var(--border)' }}>
                                <div className={isTotal ? 'font-semibold' : ''}>{fmtVal(it.code, land)}</div>
                                <div className="text-[10px]" style={{ color: ydiff == null ? 'var(--text-dim)' : ydiff >= 0 ? 'var(--green)' : 'var(--red)' }}>{ydiff == null ? '' : fmtDiff(it.code, ydiff)}</div>
                              </td>
                            </tr>
                          )
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>
              </div>
            </>
          )}

          <p className="text-xs mt-2" style={{ color: 'var(--text-dim)' }}>
            予算=月次計画、実績=アップロード由来（集計行は明細から再計算）。KPI（稼働率・販売室数・客数・単価等）は売上実績、在庫数=総客室数×稼働日数（稼働日数は設定で入力）。
            {view === 'year' && ' 年度合計=着地見込み（実績月は実績、未到来月は予算）。下段の年度合計差異は対予算。'}
          </p>
        </>
      )}
    </div>
  )
}
