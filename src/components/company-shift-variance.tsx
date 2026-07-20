'use client'

// 全社タブ シフト予実サマリー（SV07）。施設×月の予実（計画h/実績h/差/調整後差異/人件費影響/理由入力率）。
// ソート可・行クリックで各宿の「シフト予実分析」へ遷移（宿モードに切替）。owner/本部のみ（page側でガード）。
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useFacility } from '@/lib/facility-context'
import { supabase } from '@/lib/supabase/client'
import { fetchAll } from '@/lib/supabase/fetch-all'
import { fmtYen, pct } from '@/lib/ui'
import type { MonthlyRow } from '@/lib/shift/variance'

const h = (min: number | null | undefined) => (min == null ? '—' : `${(min / 60).toFixed(1)}h`)
const hSign = (min: number | null | undefined) => (min == null ? '—' : `${min >= 0 ? '+' : ''}${(min / 60).toFixed(1)}h`)
const thisMonth = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}` }

type SortKey = 'name' | 'final_plan_min' | 'actual_min' | 'variance_min' | 'ops_over_min' | 'cost' | 'reason_rate'

export default function CompanyShiftVariance() {
  const router = useRouter()
  const { facilities, setCurrent, setMode } = useFacility()
  const [month, setMonth] = useState(thisMonth())
  const [months, setMonths] = useState<string[]>([])
  const [rows, setRows] = useState<MonthlyRow[]>([])
  const [loading, setLoading] = useState(true)
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({ key: 'ops_over_min', desc: true })

  const nameOf = useCallback((f: string) => facilities.find((x) => x.facility === f)?.name ?? f, [facilities])

  useEffect(() => {
    supabase.from('mart_shift_variance_monthly').select('ym').order('ym', { ascending: false }).limit(500)
      .then(({ data }) => setMonths([...new Set(((data as { ym: string }[]) ?? []).map((r) => r.ym.slice(0, 7)))]))
  }, [])
  useEffect(() => {
    setLoading(true)
    fetchAll<MonthlyRow>(() => supabase.from('mart_shift_variance_monthly').select('*').eq('ym', `${month}-01`))
      .then((r) => setRows(r ?? [])).catch(() => setRows([])).finally(() => setLoading(false))
  }, [month])

  const costOf = (r: MonthlyRow) => (r.cost_impact_hourly ?? 0) + (r.cost_impact_monthly_ot ?? 0)
  const reasonRate = (r: MonthlyRow) => (r.exception_days ? (r.reason_entered_days ?? 0) / r.exception_days : null)

  const sorted = useMemo(() => {
    const val = (r: MonthlyRow): number | string => {
      switch (sort.key) {
        case 'name': return nameOf(r.facility)
        case 'cost': return costOf(r)
        case 'reason_rate': return reasonRate(r) ?? -1
        default: return (r[sort.key] as number) ?? -Infinity
      }
    }
    return [...rows].sort((a, b) => {
      const va = val(a), vb = val(b)
      const c = typeof va === 'string' ? String(va).localeCompare(String(vb)) : (va as number) - (vb as number)
      return sort.desc ? -c : c
    })
  }, [rows, sort, nameOf])

  const goFacility = (f: string) => { setCurrent(f); setMode('facility'); router.push('/shift-variance') }
  const th = (key: SortKey, label: string, right = true) => (
    <th className={`px-3 py-2 ${right ? 'text-right' : ''} cursor-pointer select-none whitespace-nowrap`} onClick={() => setSort((s) => ({ key, desc: s.key === key ? !s.desc : true }))}>
      {label}{sort.key === key ? (sort.desc ? ' ▼' : ' ▲') : ''}
    </th>
  )

  // 全社合計
  const tot = useMemo(() => rows.reduce((s, r) => ({
    plan: s.plan + (r.final_plan_min ?? 0), act: s.act + (r.actual_min ?? 0), varc: s.varc + (r.variance_min ?? 0),
    ops: s.ops + (r.ops_over_min ?? 0), cost: s.cost + costOf(r), exc: s.exc + (r.exception_days ?? 0), rea: s.rea + (r.reason_entered_days ?? 0),
  }), { plan: 0, act: 0, varc: 0, ops: 0, cost: 0, exc: 0, rea: 0 }), [rows])

  return (
    <section className="mt-8">
      <div className="flex items-center gap-3 mb-2 flex-wrap">
        <h2 className="text-base font-semibold">シフト予実（施設×月）</h2>
        <select className="field px-3 py-1.5 text-sm" value={month} onChange={(e) => setMonth(e.target.value)}>
          {[...new Set([month, ...months])].sort().reverse().map((m) => <option key={m} value={m}>{m}</option>)}
        </select>
        <span className="text-xs" style={{ color: 'var(--text-dim)' }}>計画超過＝実績−計画／調整後差異＝需要増を控除した超過／理由入力率＝入力済÷例外日。行クリックで各宿へ。</span>
      </div>
      <div className="card overflow-x-auto">
        <table className="w-full text-sm whitespace-nowrap">
          <thead>
            <tr style={{ background: 'var(--surface2)', color: 'var(--text-dim)' }} className="text-left">
              {th('name', '宿', false)}
              {th('final_plan_min', '計画')}
              {th('actual_min', '実績')}
              {th('variance_min', '計画超過')}
              {th('ops_over_min', '調整後差異')}
              {th('cost', '人件費影響')}
              {th('reason_rate', '理由入力率')}
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={7} className="px-3 py-6 text-center" style={{ color: 'var(--text-dim)' }}>読み込み中…</td></tr>
            ) : sorted.length === 0 ? (
              <tr><td colSpan={7} className="px-3 py-6 text-center" style={{ color: 'var(--text-dim)' }}>{month} のシフト予実データがありません（各宿でシフト公開＋勤怠取込後に表示）。</td></tr>
            ) : sorted.map((r) => {
              const rr = reasonRate(r)
              return (
                <tr key={r.facility} onClick={() => goFacility(r.facility)} className="cursor-pointer" style={{ borderTop: '1px solid var(--border)' }}
                  onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--surface2)')} onMouseLeave={(e) => (e.currentTarget.style.background = '')}>
                  <td className="px-3 py-2 font-medium">{nameOf(r.facility)}</td>
                  <td className="px-3 py-2 text-right">{h(r.final_plan_min)}</td>
                  <td className="px-3 py-2 text-right">{h(r.actual_min)}</td>
                  <td className="px-3 py-2 text-right" style={{ color: (r.variance_min ?? 0) > 0 ? 'var(--red)' : (r.variance_min ?? 0) < 0 ? 'var(--green)' : undefined }}>{hSign(r.variance_min)}</td>
                  <td className="px-3 py-2 text-right" style={{ color: (r.ops_over_min ?? 0) > 0 ? 'var(--red)' : undefined }}>{hSign(r.ops_over_min)}</td>
                  <td className="px-3 py-2 text-right">{fmtYen(costOf(r))}</td>
                  <td className="px-3 py-2 text-right" style={{ color: rr == null ? 'var(--text-dim)' : rr >= 1 ? 'var(--green)' : rr >= 0.5 ? undefined : 'var(--red)' }}>
                    {rr == null ? '—' : pct(rr)}<span className="text-[10px] ml-1" style={{ color: 'var(--text-dim)' }}>({r.reason_entered_days ?? 0}/{r.exception_days ?? 0})</span>
                  </td>
                </tr>
              )
            })}
            {!loading && sorted.length > 0 && (
              <tr style={{ borderTop: '2px solid var(--border)', background: 'var(--surface2)' }} className="font-semibold">
                <td className="px-3 py-2">全社合計</td>
                <td className="px-3 py-2 text-right">{h(tot.plan)}</td>
                <td className="px-3 py-2 text-right">{h(tot.act)}</td>
                <td className="px-3 py-2 text-right">{hSign(tot.varc)}</td>
                <td className="px-3 py-2 text-right">{hSign(tot.ops)}</td>
                <td className="px-3 py-2 text-right">{fmtYen(tot.cost)}</td>
                <td className="px-3 py-2 text-right">{tot.exc ? pct(tot.rea / tot.exc) : '—'}<span className="text-[10px] ml-1" style={{ color: 'var(--text-dim)' }}>({tot.rea}/{tot.exc})</span></td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  )
}
