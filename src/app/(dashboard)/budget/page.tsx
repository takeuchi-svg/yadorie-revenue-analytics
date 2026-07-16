'use client'

// 予算作成: 日別売上予算 / 月次PL予算 / 修繕投資計画 / 人員計画。年度(FY)は共有。
// 予算ロック(鍵締め): budget_lock に (facility, fiscal_year) があればロック=編集不可。施錠/解錠は owner のみ。
import { useEffect, useState } from 'react'
import { useFacility } from '@/lib/facility-context'
import { supabase } from '@/lib/supabase/client'
import { fetchAll } from '@/lib/supabase/fetch-all'
import { useToast } from '@/components/toast'
import BudgetDaily from '@/components/budget-daily'
import BudgetPL from '@/components/budget-pl'
import BudgetReviewCard from '@/components/budget-review-card'

/* eslint-disable @typescript-eslint/no-explicit-any */
function ComingSoon({ label }: { label: string }) {
  return <div className="card p-8 mt-4 text-center text-sm" style={{ color: 'var(--text-dim)' }}>「{label}」は準備中です。</div>
}

export default function BudgetPage() {
  const { current, isOwner } = useFacility()
  const toast = useToast()
  const [tab, setTab] = useState<'daily' | 'pl' | 'capex' | 'staffing'>('daily')
  const [fyList, setFyList] = useState<number[]>([])
  const [fy, setFy] = useState<number | null>(null)
  const [lockedYears, setLockedYears] = useState<Set<string>>(new Set())

  useEffect(() => {
    if (!current) return
    ;(async () => {
      const [d, m, lk] = await Promise.all([
        fetchAll(() => supabase.from('budget_daily').select('fiscal_year').eq('facility', current).eq('version', '当初')).catch(() => []),
        fetchAll(() => supabase.from('budget_monthly').select('fiscal_year').eq('facility', current).eq('version', '当初')).catch(() => []),
        fetchAll(() => supabase.from('budget_lock').select('fiscal_year').eq('facility', current)).catch(() => []),
      ])
      const ys = [...new Set([...(d as any[] ?? []), ...(m as any[] ?? [])].map((r) => Number(r.fiscal_year)).filter(Number.isFinite))].sort((a, b) => a - b)
      const nextFy = (ys.length ? ys[ys.length - 1] : new Date().getFullYear()) + 1
      const opts = [...new Set([...ys, nextFy])].sort((a, b) => b - a)
      setFyList(opts)
      setFy((f) => (f && opts.includes(f) ? f : nextFy))
      setLockedYears(new Set(((lk as any[]) ?? []).map((r) => String(r.fiscal_year))))
    })()
  }, [current])

  const locked = fy != null && lockedYears.has(String(fy))

  const setLock = async (lock: boolean) => {
    if (!current || fy == null || !isOwner) return
    if (lock) {
      const { data: { user } } = await supabase.auth.getUser()
      const { error } = await supabase.from('budget_lock').upsert({ facility: current, fiscal_year: String(fy), locked_by: user?.email ?? null }, { onConflict: 'facility,fiscal_year' })
      if (error) { toast(`エラー: ${error.message}`, 'error'); return }
      setLockedYears((s) => new Set(s).add(String(fy)))
      toast(`${fy}年度を施錠しました（編集不可）`, 'success')
    } else {
      const { error } = await supabase.from('budget_lock').delete().eq('facility', current).eq('fiscal_year', String(fy))
      if (error) { toast(`エラー: ${error.message}`, 'error'); return }
      setLockedYears((s) => { const n = new Set(s); n.delete(String(fy)); return n })
      toast(`${fy}年度を解錠しました（編集可）`, 'success')
    }
  }

  return (
    <div className="p-6">
      <div className="flex gap-1 mb-1 flex-wrap items-center">
        {([['daily', '日別売上予算'], ['pl', '月次PL予算'], ['capex', '修繕投資計画'], ['staffing', '人員計画']] as const).map(([t, label]) => (
          <button key={t} onClick={() => setTab(t)} className="px-4 py-1.5 rounded-md text-sm"
            style={{ background: tab === t ? 'var(--accent)' : 'var(--surface2)', color: tab === t ? '#fff' : 'var(--text-dim)' }}>
            {label}{(t === 'capex' || t === 'staffing') && <span className="ml-1 text-[9px]">準備中</span>}
          </button>
        ))}
        {(tab === 'daily' || tab === 'pl') && fy != null && (
          <span className="ml-auto flex items-center gap-2">
            {locked && <span className="text-[11px] px-2 py-0.5 rounded" style={{ background: 'var(--surface2)', color: 'var(--text-dim)' }}>🔒 {fy}年度は確定（ロック中）</span>}
            {isOwner && (
              <button onClick={() => setLock(!locked)} className="text-xs px-3 py-1 rounded-md" style={{ background: 'var(--surface2)', color: 'var(--text)', border: '1px solid var(--border)' }}>
                {locked ? '解錠する' : '施錠する（確定）'}
              </button>
            )}
          </span>
        )}
      </div>
      {tab === 'daily' && <BudgetDaily fy={fy} fyList={fyList} onFy={setFy} locked={locked} />}
      {tab === 'pl' && <BudgetPL fy={fy} fyList={fyList} onFy={setFy} locked={locked} />}
      {tab === 'capex' && <ComingSoon label="修繕投資計画" />}
      {tab === 'staffing' && <ComingSoon label="人員計画" />}
      {(tab === 'daily' || tab === 'pl') && <BudgetReviewCard fy={fy} />}
    </div>
  )
}
