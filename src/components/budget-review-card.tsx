'use client'

// B6 灯の予算レビュー カード。予算ページ下部に表示。作った予算を灯が伴走レビュー（自動生成はしない）。
import { useCallback, useEffect, useState } from 'react'
import { useFacility } from '@/lib/facility-context'
import { AssistantContent, SparkleIcon } from '@/components/ai-drawer'
import { loadBudgetReview, generateBudgetReview } from '@/lib/budget-review'

export default function BudgetReviewCard({ fy }: { fy: number | null }) {
  const { current } = useFacility()
  const [content, setContent] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  useEffect(() => {
    if (!current || fy == null) { setContent(''); return }
    ;(async () => { setContent(await loadBudgetReview(current, fy)) })()
  }, [current, fy])

  const gen = useCallback(async () => {
    if (!current || fy == null) return
    setBusy(true); setErr('')
    try { const { content: c, error } = await generateBudgetReview(current, fy); if (error) setErr(error); setContent(c) }
    catch (e) { setErr(e instanceof Error ? e.message : String(e)) } finally { setBusy(false) }
  }, [current, fy])

  return (
    <div className="card p-4 mt-6" style={{ borderColor: 'var(--accent)' }}>
      <div className="flex items-center gap-2 mb-2">
        <SparkleIcon size={16} />
        <h3 className="text-sm font-semibold">灯の予算レビュー（{fy}年度）</h3>
        <button onClick={gen} disabled={busy || fy == null} className="ml-auto text-xs px-3 py-1 rounded-md text-white disabled:opacity-40" style={{ background: 'var(--accent)' }}>
          {busy ? 'レビュー中…' : content ? '↻ 再レビュー' : 'レビューしてもらう'}
        </button>
      </div>
      {err && <p className="text-sm" style={{ color: 'var(--red)' }}>エラー: {err}</p>}
      {busy ? (
        <p className="text-sm" style={{ color: 'var(--text-dim)' }}>灯が{fy}年度の予算を、前年・基準PL・宿の意図と照らしています…</p>
      ) : content ? (
        <AssistantContent content={content} />
      ) : (
        <p className="text-sm" style={{ color: 'var(--text-dim)' }}>予算を作り終えたら「レビューしてもらう」を押すと、灯が乖離や整合性を伴走トーンで指摘します（灯は代わりに予算を作りません）。</p>
      )}
    </div>
  )
}
