'use client'

// 予算作成: 日別売上予算 / 月次PL予算 の2タブ。年度(FY)は両タブで共有。
import { useEffect, useState } from 'react'
import { useFacility } from '@/lib/facility-context'
import { supabase } from '@/lib/supabase/client'
import { fetchAll } from '@/lib/supabase/fetch-all'
import BudgetDaily from '@/components/budget-daily'
import BudgetPL from '@/components/budget-pl'

/* eslint-disable @typescript-eslint/no-explicit-any */
export default function BudgetPage() {
  const { current } = useFacility()
  const [tab, setTab] = useState<'daily' | 'pl'>('daily')
  const [fyList, setFyList] = useState<number[]>([])
  const [fy, setFy] = useState<number | null>(null)

  // 年度候補: 既存の当初予算(日別・月次)のFY ＋ 来期(最大+1)。デフォルトは来期。
  useEffect(() => {
    if (!current) return
    ;(async () => {
      const [d, m] = await Promise.all([
        fetchAll(() => supabase.from('budget_daily').select('fiscal_year').eq('facility', current).eq('version', '当初')).catch(() => []),
        fetchAll(() => supabase.from('budget_monthly').select('fiscal_year').eq('facility', current).eq('version', '当初')).catch(() => []),
      ])
      const ys = [...new Set([...(d as any[] ?? []), ...(m as any[] ?? [])].map((r) => Number(r.fiscal_year)).filter(Number.isFinite))].sort((a, b) => a - b)
      const nextFy = (ys.length ? ys[ys.length - 1] : new Date().getFullYear()) + 1
      const opts = [...new Set([...ys, nextFy])].sort((a, b) => b - a)
      setFyList(opts)
      setFy((f) => (f && opts.includes(f) ? f : nextFy))
    })()
  }, [current])

  return (
    <div className="p-6">
      <div className="flex gap-1 mb-1">
        {([['daily', '日別売上予算'], ['pl', '月次PL予算']] as const).map(([t, label]) => (
          <button key={t} onClick={() => setTab(t)} className="px-4 py-1.5 rounded-md text-sm"
            style={{ background: tab === t ? 'var(--accent)' : 'var(--surface2)', color: tab === t ? '#fff' : 'var(--text-dim)' }}>
            {label}
          </button>
        ))}
      </div>
      {tab === 'daily' ? <BudgetDaily fy={fy} fyList={fyList} onFy={setFy} /> : <BudgetPL fy={fy} fyList={fyList} onFy={setFy} />}
    </div>
  )
}
