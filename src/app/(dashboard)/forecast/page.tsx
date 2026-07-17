'use client'

// B8 見込（着地見込）。着地見込 = 実績(確定月) ＋ 見込(残月)。確定月は実績を自動表示（読取）、
// 残月は編集（当初予算を既定）。保存は budget_monthly version='見込'。オンハンド(予約の入り)を残月の参考に表示。
// 予実(yojitsu)は version='見込' の着地に、pl-compute の landingFor(実績＞見込＞予算)で反映される。
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useFacility } from '@/lib/facility-context'
import { supabase } from '@/lib/supabase/client'
import { fetchAll } from '@/lib/supabase/fetch-all'
import { fmtNum } from '@/lib/ui'
import { useToast } from '@/components/toast'
import { Loading } from '@/components/page-bits'
import { makePlResolver, type BudgetRow, type ActualRow, type KpiRow, type OccRow } from '@/lib/pl-compute'

/* eslint-disable @typescript-eslint/no-explicit-any */
const num = (s: string): number | null => (s.trim() === '' ? null : (Number.isFinite(Number(s)) ? Number(s) : null))
const fyOf = (ym: string) => { const y = +ym.slice(0, 4), m = +ym.slice(5, 7); return m >= 4 ? y : y - 1 }
const fyMonths = (fy: number): string[] => {
  const out: string[] = []
  for (let m = 4; m <= 12; m++) out.push(`${fy}-${String(m).padStart(2, '0')}`)
  for (let m = 1; m <= 3; m++) out.push(`${fy + 1}-${String(m).padStart(2, '0')}`)
  return out
}
const K = (m: string, code: string) => `${m}|${code}`

// 見込で持つ行（集計中心）。input=残月に手入力、calc=自動。
const ROWS = [
  { code: 'sales_total', name: '売上高', cat: '売上', so: 10, input: true },
  { code: 'cogs_total', name: '原価', cat: '原価', so: 20, input: true },
  { code: 'labor_total', name: '人件費', cat: '人件費', so: 30, input: true },
  { code: 'sga_total', name: '販売管理費', cat: '販売管理費', so: 40, input: true },
  { code: 'gop', name: 'GOP', cat: 'GOP', so: 50, calc: true },
  { code: '賃借料_旅館_', name: '賃借料（旅館）', cat: 'GOP', so: 60, input: true },
  { code: 'ebitda', name: 'EBITDA', cat: 'EBITDA', so: 70, calc: true },
  { code: '減価償却費', name: '減価償却費', cat: 'EBITDA', so: 80, input: true },
  { code: 'operating_income', name: '営業損益', cat: '営業損益', so: 90, calc: true },
] as const

export default function ForecastPage() {
  const { current, currentFacility } = useFacility()
  const toast = useToast()
  const [budget, setBudget] = useState<BudgetRow[]>([])
  const [actual, setActual] = useState<ActualRow[]>([])
  const [kpi, setKpi] = useState<KpiRow[]>([])
  const [occ, setOcc] = useState<OccRow[]>([])
  const [onhand, setOnhand] = useState<Record<string, number | null>>({})
  const [inp, setInp] = useState<Record<string, string>>({})
  const [fys, setFys] = useState<string[]>([])
  const [fy, setFy] = useState<number | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)

  const totalRooms = currentFacility?.total_rooms ?? null
  const months = useMemo(() => (fy == null ? [] : fyMonths(fy)), [fy])

  const load = useCallback(async () => {
    if (!current) return
    setLoading(true)
    try {
      const [b, a, kp, oc, fc, oh] = await Promise.all([
        fetchAll(() => supabase.from('budget_monthly').select('fiscal_year, month, category, item_code, item_name, amount, sort_order').eq('facility', current).eq('version', '当初').order('id')).catch(() => []),
        fetchAll(() => supabase.from('actual_monthly').select('fiscal_year, month, item_code, actual').eq('facility', current).order('id')).catch(() => []),
        fetchAll(() => supabase.from('mart_monthly_kpi').select('month, guests, adr, guest_unit, companion').eq('facility', current)).catch(() => []),
        fetchAll(() => supabase.from('mart_occupancy_monthly').select('month, rooms_sold, occ, occ_calendar_days, operating_days').eq('facility', current)).catch(() => []),
        fetchAll(() => supabase.from('budget_monthly').select('month, item_code, amount').eq('facility', current).eq('version', '見込')).catch(() => []),
        fetchAll(() => supabase.from('mart_onhand_monthly').select('month, revenue').eq('facility', current)).catch(() => []),
      ])
      setBudget((b as BudgetRow[]) ?? []); setActual((a as ActualRow[]) ?? []); setKpi((kp as KpiRow[]) ?? []); setOcc((oc as OccRow[]) ?? [])
      const oim: Record<string, string> = {}
      ;((fc as any[]) ?? []).forEach((r) => { if (r.amount != null) oim[K(r.month, r.item_code)] = String(r.amount) })
      setInp(oim)
      const ohm: Record<string, number | null> = {}
      ;((oh as any[]) ?? []).forEach((r) => { ohm[r.month] = r.revenue })
      setOnhand(ohm)
      const yset = [...new Set(((b as any[]) ?? []).map((r) => Number(r.fiscal_year)).filter(Number.isFinite))].sort((x, y) => y - x)
      setFys(yset.map(String))
      setFy((f) => (f != null && yset.includes(f) ? f : (yset[0] ?? fyOf(new Date().toISOString().slice(0, 7)))))
    } finally { setLoading(false) }
  }, [current])
  useEffect(() => { load() }, [load])

  const R = useMemo(() => makePlResolver({ budget, actual, kpi, occ, totalRooms, fy: String(fy ?? '') }), [budget, actual, kpi, occ, totalRooms, fy])
  const confirmed = (m: string) => R.actualMonths.has(m)

  // 見込値: 確定月=実績、残月=入力(無ければ当初予算)。集計は自動。
  function fval(m: string, code: string): number | null {
    if (confirmed(m)) return R.getActual(code, m)
    if (code === 'gop') return (fval(m, 'sales_total') ?? 0) - (fval(m, 'cogs_total') ?? 0) - (fval(m, 'labor_total') ?? 0) - (fval(m, 'sga_total') ?? 0)
    if (code === 'ebitda') return (fval(m, 'gop') ?? 0) - (fval(m, '賃借料_旅館_') ?? 0)
    if (code === 'operating_income') return (fval(m, 'ebitda') ?? 0) - (fval(m, '減価償却費') ?? 0)
    const v = num(inp[K(m, code)] ?? '')
    return v != null ? v : R.getBudget(code, m)
  }
  const setCell = (m: string, code: string, v: string) => setInp((p) => ({ ...p, [K(m, code)]: v }))
  const landing = (code: string) => months.reduce((s, m) => s + (fval(m, code) ?? 0), 0)

  const save = async () => {
    if (!current || fy == null) return
    setSaving(true)
    const rows: any[] = []
    for (const m of months) for (const r of ROWS) {
      const v = fval(m, r.code)
      rows.push({ facility: current, fiscal_year: String(fy), month: m, version: '見込', category: r.cat, item_code: r.code, item_name: r.name, amount: v == null ? null : Math.round(v), sort_order: r.so })
    }
    const { error } = await supabase.from('budget_monthly').upsert(rows, { onConflict: 'facility,fiscal_year,month,item_code,version' })
    toast(error ? `エラー: ${error.message}` : `${fy}年度の見込を保存しました（予実の着地に反映）`, error ? 'error' : 'success')
    setSaving(false)
  }

  if (!current) return <div className="p-6 text-sm" style={{ color: 'var(--text-dim)' }}>宿を選択してください。</div>

  return (
    <div className="p-6">
      <div className="flex items-center gap-2 flex-wrap mb-2">
        <h1 className="text-sm font-semibold">見込（着地見込）</h1>
        {fys.length > 0 && (
          <select className="field px-3 py-1.5 text-sm" value={fy ?? ''} onChange={(e) => setFy(Number(e.target.value))}>
            {fys.map((y) => <option key={y} value={y}>{y}年度</option>)}
          </select>
        )}
        <button onClick={save} disabled={saving} className="ml-auto px-4 py-1.5 rounded-md text-sm text-white disabled:opacity-50" style={{ background: 'var(--accent)' }}>{saving ? '保存中…' : '見込を保存'}</button>
      </div>
      <p className="text-[11px] mb-2" style={{ color: 'var(--text-dim)' }}>
        着地見込＝実績（確定月・自動）＋見込（残月・編集可、当初予算が既定）。残月は<span style={{ color: '#2563eb' }}>青</span>で入力。GOP・EBITDA・営業損益は自動。売上の下はオンハンド（現時点の予約売上）参考。保存すると予実（PL）の「着地」に反映されます。
      </p>

      {loading ? <Loading /> : (
        <div className="card overflow-auto" style={{ maxHeight: 'calc(100vh - 200px)' }}>
          <table className="text-xs border-separate" style={{ borderSpacing: 0, minWidth: 1200 }}>
            <thead>
              <tr style={{ color: 'var(--text-dim)' }}>
                <th className="px-3 py-2 text-left whitespace-nowrap sticky left-0 top-0 z-30" style={{ background: 'var(--surface2)', borderRight: '2px solid var(--border)' }}>項目</th>
                {months.map((m) => (
                  <th key={m} className="px-2 py-2 text-right whitespace-nowrap sticky top-0 z-20" style={{ background: 'var(--surface2)', minWidth: 92 }}>
                    <div style={{ color: confirmed(m) ? 'var(--accent)' : 'var(--text-dim)' }}>{m.slice(5)}月</div>
                    <div className="text-[9px]">{confirmed(m) ? '実績' : '見込'}</div>
                  </th>
                ))}
                <th className="px-2 py-2 text-right whitespace-nowrap sticky top-0 z-20" style={{ background: 'var(--surface)', minWidth: 108, borderLeft: '2px solid var(--border)' }}>着地見込</th>
              </tr>
            </thead>
            <tbody>
              {ROWS.map((r) => {
                const total = ['sales_total', 'gop', 'ebitda', 'operating_income'].includes(r.code)
                return (
                  <tr key={r.code} style={{ background: total ? 'var(--surface2)' : undefined }}>
                    <td className={`px-3 py-1.5 whitespace-nowrap sticky left-0 z-10 ${total ? 'font-semibold' : ''}`} style={{ background: total ? 'var(--surface2)' : 'var(--surface)', borderRight: '2px solid var(--border)', borderTop: '1px solid var(--border)', color: total ? undefined : 'var(--text-dim)' }}>{r.name}</td>
                    {months.map((m) => {
                      const v = fval(m, r.code)
                      const editable = !confirmed(m) && (r as any).input
                      return (
                        <td key={m} className="px-1 py-1 text-right align-top" style={{ borderTop: '1px solid var(--border)' }}>
                          {editable ? (
                            <input className="field px-1 py-0.5 text-xs text-right w-full" style={{ color: '#2563eb', minWidth: 72 }} value={inp[K(m, r.code)] ?? ''} placeholder={R.getBudget(r.code, m) == null ? '' : fmtNum(R.getBudget(r.code, m))} onChange={(e) => setCell(m, r.code, e.target.value)} />
                          ) : (
                            <div className={`px-1 ${total ? 'font-semibold' : ''}`} style={{ color: confirmed(m) ? 'var(--text)' : undefined }}>{v == null ? '—' : fmtNum(v)}</div>
                          )}
                          {r.code === 'sales_total' && !confirmed(m) && onhand[m] != null && (
                            <div className="text-[9px]" style={{ color: 'var(--text-dim)' }}>オンハンド {fmtNum(onhand[m])}</div>
                          )}
                        </td>
                      )
                    })}
                    <td className="px-2 py-1.5 text-right whitespace-nowrap" style={{ background: 'var(--surface)', borderLeft: '2px solid var(--border)', borderTop: '1px solid var(--border)' }}>
                      <span className={total ? 'font-semibold' : ''}>{fmtNum(landing(r.code))}</span>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
