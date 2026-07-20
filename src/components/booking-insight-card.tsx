'use client'

// M8 灯の予約日ベース所見カード（/booking 上部）。前年比の異変検知・OTA/室数/単価の分解・施策照合。
// 要因（在庫か料金か）の断定はしない＝検知と照合まで。自動生成はせず、押したときだけ生成（キャッシュ）。
import { useCallback, useEffect, useState } from 'react'
import { useFacility } from '@/lib/facility-context'
import { AssistantContent, SparkleIcon } from '@/components/ai-drawer'
import { loadBookingInsight, generateBookingInsight } from '@/lib/booking-insight'

const thisMonth = () => { const n = new Date(); return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, '0')}` }

export default function BookingInsightCard() {
  const { current } = useFacility()
  const asOf = thisMonth()
  const [content, setContent] = useState('')
  const [updatedAt, setUpdatedAt] = useState<string | undefined>()
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  useEffect(() => {
    if (!current) { setContent(''); return }
    ;(async () => { const { content: c, updatedAt: u } = await loadBookingInsight(current, asOf); setContent(c); setUpdatedAt(u) })()
  }, [current, asOf])

  const gen = useCallback(async () => {
    if (!current) return
    setBusy(true); setErr('')
    try { const { content: c, error } = await generateBookingInsight(current, asOf); if (error) setErr(error); if (c) { setContent(c); setUpdatedAt(new Date().toISOString()) } }
    catch (e) { setErr(e instanceof Error ? e.message : String(e)) } finally { setBusy(false) }
  }, [current, asOf])

  return (
    <div className="card p-4 mb-4" style={{ borderColor: 'var(--accent)' }}>
      <div className="flex items-center gap-2 mb-2">
        <SparkleIcon size={16} />
        <h3 className="text-sm font-semibold">灯の所見（実績＋オンハンドの異変検知）</h3>
        {updatedAt && <span className="text-[10px]" style={{ color: 'var(--text-dim)' }}>{new Date(updatedAt).toLocaleDateString('ja-JP')}</span>}
        <button onClick={gen} disabled={busy} className="ml-auto text-xs px-3 py-1 rounded-md text-white disabled:opacity-40" style={{ background: 'var(--accent)' }}>
          {busy ? '分析中…' : content ? '↻ 再分析' : '灯に見てもらう'}
        </button>
      </div>
      {err && <p className="text-sm" style={{ color: 'var(--red)' }}>エラー: {err}</p>}
      {busy ? (
        <p className="text-sm" style={{ color: 'var(--text-dim)' }}>灯が予約日ベースの動きを前年・施策と照らしています…</p>
      ) : content ? (
        <AssistantContent content={content} />
      ) : (
        <p className="text-sm" style={{ color: 'var(--text-dim)' }}>「灯に見てもらう」を押すと、前年比で目立つ動き（どの月の予約分・どのOTA・室数か単価か）を拾い、当時と前年同期の施策を照合します。要因の断定はしません（在庫か料金かは人が判断）。</p>
      )}
    </div>
  )
}
