'use client'

import { useEffect, useMemo, useState } from 'react'
import { useFacility } from '@/lib/facility-context'
import { supabase } from '@/lib/supabase/client'
import { fmtNum, pct } from '@/lib/ui'
import { Loading, Empty } from '@/components/page-bits'

/* eslint-disable @typescript-eslint/no-explicit-any */
interface BRow { fiscal_year: string; month: string; category: string | null; item_code: string; item_name: string; amount: number | null; sort_order: number | null }
interface ARow { fiscal_year: string; month: string; item_code: string; actual: number | null; prior_amount: number | null }

const CATS = ['売上', '原価', '人件費', '販売管理費', 'GOP', 'EBITDA', '営業損益']

async function fetchAll(build: () => any): Promise<any[]> {
  const size = 1000; let frm = 0; let all: any[] = []
  for (let i = 0; i < 50; i++) {
    const { data, error } = await build().range(frm, frm + size - 1)
    if (error || !data || data.length === 0) break
    all = all.concat(data); if (data.length < size) break; frm += size
  }
  return all
}

export default function YojitsuPage() {
  const { current, currentFacility } = useFacility()
  const [budget, setBudget] = useState<BRow[]>([])
  const [actual, setActual] = useState<ARow[]>([])
  const [fy, setFy] = useState('')
  const [month, setMonth] = useState('')
  const [view, setView] = useState<'month' | 'year'>('month')
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!current) return
    setLoading(true)
    Promise.all([
      fetchAll(() => supabase.from('budget_monthly').select('fiscal_year, month, category, item_code, item_name, amount, sort_order').eq('facility', current).order('id')),
      fetchAll(() => supabase.from('actual_monthly').select('fiscal_year, month, item_code, actual, prior_amount').eq('facility', current).order('id')),
    ]).then(([b, a]) => {
      setBudget((b as BRow[]) ?? [])
      setActual((a as ARow[]) ?? [])
      setLoading(false)
    })
  }, [current])

  const fys = useMemo(() => [...new Set(budget.map((b) => b.fiscal_year))].sort().reverse(), [budget])
  useEffect(() => { if (fys.length && !fys.includes(fy)) setFy(fys[0]) }, [fys, fy])

  const months = useMemo(() => [...new Set(budget.filter((b) => b.fiscal_year === fy).map((b) => b.month))].sort(), [budget, fy])
  useEffect(() => { if (months.length && !months.includes(month)) setMonth(months[0]) }, [months, month])

  // 項目順（budget の sort_order）
  const items = useMemo(() => {
    const seen = new Set<string>(); const list: { code: string; name: string; category: string | null }[] = []
    for (const b of budget.filter((x) => x.fiscal_year === fy).sort((a, z) => (a.sort_order ?? 0) - (z.sort_order ?? 0))) {
      if (seen.has(b.item_code)) continue; seen.add(b.item_code)
      list.push({ code: b.item_code, name: b.item_name, category: b.category })
    }
    return list
  }, [budget, fy])

  const bMap = useMemo(() => { const m: Record<string, number | null> = {}; budget.forEach((b) => { if (b.fiscal_year === fy && b.month === month) m[b.item_code] = b.amount }); return m }, [budget, fy, month])
  const aMap = useMemo(() => { const m: Record<string, ARow> = {}; actual.forEach((a) => { if (a.fiscal_year === fy && a.month === month) m[a.item_code] = a }); return m }, [actual, fy, month])

  // 年度ビュー用: item_code → month → {budget, actual}
  const yearMap = useMemo(() => {
    const m: Record<string, Record<string, { b: number | null; a: number | null }>> = {}
    budget.forEach((x) => { if (x.fiscal_year === fy) { (m[x.item_code] ??= {})[x.month] = { b: x.amount, a: (m[x.item_code]?.[x.month]?.a) ?? null } } })
    actual.forEach((x) => { if (x.fiscal_year === fy) { (m[x.item_code] ??= {})[x.month] = { b: (m[x.item_code]?.[x.month]?.b) ?? null, a: x.actual } } })
    return m
  }, [budget, actual, fy])

  const hasActual = actual.some((a) => a.fiscal_year === fy)

  return (
    <div className="p-6">
      <div className="flex items-end justify-between mb-4 flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold mb-1">予実管理</h1>
          <p className="text-sm" style={{ color: 'var(--text-dim)' }}>{currentFacility?.name ?? current}</p>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex rounded-md overflow-hidden" style={{ border: '1px solid var(--border)' }}>
            {(['month', 'year'] as const).map((v) => (
              <button key={v} onClick={() => setView(v)} className="px-3 py-1.5 text-xs"
                style={{ background: view === v ? 'var(--accent)' : 'var(--surface)', color: view === v ? '#fff' : 'var(--text-dim)' }}>
                {v === 'month' ? '単月' : '年度'}
              </button>
            ))}
          </div>
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
                {items.map((it) => {
                  const b = bMap[it.code] ?? null
                  const a = aMap[it.code]
                  const act = a?.actual ?? null
                  const prior = a?.prior_amount ?? null
                  const diff = act != null && b != null ? act - b : null
                  const rate = act != null && b ? act / b : null
                  const yoy = act != null && prior ? act / prior : null
                  const isCat = CATS.includes(it.name.trim())
                  return (
                    <tr key={it.code} style={{ borderTop: '1px solid var(--border)', background: isCat ? 'var(--surface2)' : undefined }}>
                      <td className={`px-4 py-2 whitespace-nowrap ${isCat ? 'font-semibold' : ''}`}>{it.name}</td>
                      <td className="px-4 py-2 text-right">{fmtNum(act)}</td>
                      <td className="px-4 py-2 text-right" style={{ color: 'var(--text-dim)' }}>{fmtNum(b)}</td>
                      <td className="px-4 py-2 text-right" style={{ color: diff == null ? undefined : diff >= 0 ? 'var(--green)' : 'var(--red)' }}>
                        {diff == null ? '-' : (diff >= 0 ? '+' : '') + fmtNum(diff)}
                      </td>
                      <td className="px-4 py-2 text-right" style={{ color: rate == null ? undefined : rate >= 1 ? 'var(--green)' : 'var(--red)' }}>{pct(rate)}</td>
                      <td className="px-4 py-2 text-right" style={{ color: 'var(--text-dim)' }}>{fmtNum(prior)}</td>
                      <td className="px-4 py-2 text-right">{pct(yoy)}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
          ) : (
          /* 年度ビュー: 項目固定 + 12ヶ月横スクロール（各セル 実績/達成率） */
          <div className="card overflow-hidden">
            <div className="flex">
              <table className="text-sm shrink-0" style={{ borderRight: '2px solid var(--border)' }}>
                <thead>
                  <tr style={{ background: 'var(--surface2)', color: 'var(--text-dim)' }} className="text-left">
                    <th className="px-4 h-12 whitespace-nowrap">項目</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((it) => {
                    const isCat = CATS.includes(it.name.trim())
                    return (
                      <tr key={it.code} style={{ borderTop: '1px solid var(--border)', background: isCat ? 'var(--surface2)' : undefined }}>
                        <td className={`px-4 h-12 whitespace-nowrap ${isCat ? 'font-semibold' : ''}`}>{it.name}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
              <div className="overflow-x-auto flex-1">
                <table className="text-sm">
                  <thead>
                    <tr style={{ background: 'var(--surface2)', color: 'var(--text-dim)' }} className="text-center">
                      {months.map((m) => <th key={m} className="px-3 h-12 text-right whitespace-nowrap" style={{ minWidth: 96 }}>{m.slice(5)}月</th>)}
                    </tr>
                  </thead>
                  <tbody>
                    {items.map((it) => {
                      const isCat = CATS.includes(it.name.trim())
                      return (
                        <tr key={it.code} style={{ borderTop: '1px solid var(--border)', background: isCat ? 'var(--surface2)' : undefined }}>
                          {months.map((m) => {
                            const cell = yearMap[it.code]?.[m]
                            const a = cell?.a ?? null, b = cell?.b ?? null
                            const rate = a != null && b ? a / b : null
                            return (
                              <td key={m} className="px-3 h-12 text-right whitespace-nowrap" style={{ minWidth: 96 }}>
                                <div>{fmtNum(a)}</div>
                                <div className="text-[10px]" style={{ color: rate == null ? 'var(--text-dim)' : rate >= 1 ? 'var(--green)' : 'var(--red)' }}>{rate == null ? '' : pct(rate)}</div>
                              </td>
                            )
                          })}
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
          )}
          <p className="text-xs mt-2" style={{ color: 'var(--text-dim)' }}>
            予算=月次計画、実績・昨年=実績アップロード由来。{view === 'year' ? '各セル上=実績、下=達成率（実績÷予算）。' : '達成率=実績÷予算、前年比=実績÷昨年。'}
          </p>
        </>
      )}
    </div>
  )
}
