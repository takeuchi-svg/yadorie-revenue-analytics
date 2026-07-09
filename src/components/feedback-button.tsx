'use client'

// 改善要望の送信ボタン（第3弾A）。灯の回答の下などに置く。全ユーザーが送信可。
import { useState } from 'react'
import { supabase } from '@/lib/supabase/client'

export default function FeedbackButton(
  { source, question, answer, facility }:
  { source: 'chat' | 'summary' | 'issue'; question: string; answer: string; facility?: string },
) {
  const [open, setOpen] = useState(false)
  const [comment, setComment] = useState('')
  const [busy, setBusy] = useState(false)
  const [sent, setSent] = useState(false)

  const submit = async () => {
    setBusy(true)
    try {
      const { data: { session } } = await supabase.auth.getSession()
      await fetch('/api/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(session ? { Authorization: `Bearer ${session.access_token}` } : {}) },
        body: JSON.stringify({ action: 'submit', source, question, answer, comment, facility }),
      })
      setSent(true); setOpen(false)
    } finally { setBusy(false) }
  }

  if (sent) return <span className="text-[10px]" style={{ color: 'var(--text-dim)' }}>✓ 改善要望を送信しました。ありがとうございます</span>

  if (!open) {
    return (
      <button onClick={() => setOpen(true)} className="text-[10px] hover:opacity-80" style={{ color: 'var(--text-dim)' }}
        title="この回答がイマイチなら、克樹さんに改善要望として送れます">
        ⚑ 改善要望
      </button>
    )
  }
  return (
    <div className="mt-1 w-full max-w-[320px] space-y-1">
      <textarea value={comment} onChange={(e) => setComment(e.target.value)} rows={2}
        placeholder="どこがイマイチでしたか？（任意。空でも送れます）"
        className="field w-full text-xs p-1.5" />
      <div className="flex gap-1">
        <button onClick={submit} disabled={busy} className="text-[10px] px-2 py-0.5 rounded text-white disabled:opacity-50" style={{ background: 'var(--accent)' }}>送信</button>
        <button onClick={() => setOpen(false)} className="text-[10px] px-2 py-0.5 rounded" style={{ border: '1px solid var(--border)', color: 'var(--text-dim)' }}>やめる</button>
      </div>
    </div>
  )
}
