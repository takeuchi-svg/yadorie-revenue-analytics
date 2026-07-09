'use client'

// 改善要望の閲覧・対応（第3弾A・オーナー専用）。灯の回答への支配人フィードバックを一覧・対応。
import { useCallback, useEffect, useState } from 'react'
import { supabase } from '@/lib/supabase/client'
import { AssistantContent } from '@/components/ai-drawer'

/* eslint-disable @typescript-eslint/no-explicit-any */
interface FRow {
  id: number; facility: string | null; created_by: string | null; source: string
  question: string | null; answer: string | null; comment: string | null
  status: string; owner_note: string | null; created_at: string
}
const SRC: Record<string, string> = { chat: 'チャット', summary: '実績サマリ', issue: '課題と対策' }
const STATUS: [string, string][] = [['new', '新規'], ['reviewing', '対応中'], ['done', '完了']]
const statusColor = (s: string) => s === 'done' ? 'var(--green)' : s === 'reviewing' ? 'var(--yellow)' : 'var(--accent)'

export default function FeedbackTab() {
  const [rows, setRows] = useState<FRow[]>([])
  const [filter, setFilter] = useState<string>('all')
  const [openId, setOpenId] = useState<number | null>(null)
  const [note, setNote] = useState('')
  const [msg, setMsg] = useState('')

  const call = useCallback(async (payload: any) => {
    const { data: { session } } = await supabase.auth.getSession()
    const res = await fetch('/api/feedback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session?.access_token}` },
      body: JSON.stringify(payload),
    })
    return res.json()
  }, [])

  const load = useCallback(async () => {
    const r = await call({ action: 'list' })
    if (r.error) { setMsg(r.error); return }
    setRows(r.rows ?? [])
  }, [call])
  useEffect(() => { load() }, [load])

  const shown = rows.filter((r) => filter === 'all' || r.status === filter)
  const counts = { new: rows.filter((r) => r.status === 'new').length, all: rows.length }

  const open = (r: FRow) => { setOpenId(openId === r.id ? null : r.id); setNote(r.owner_note ?? ''); setMsg('') }
  const setStatus = async (r: FRow, status: string) => {
    const res = await call({ action: 'update', id: r.id, status })
    if (res.error) { setMsg('エラー: ' + res.error); return }
    load()
  }
  const saveNote = async (r: FRow) => {
    const res = await call({ action: 'update', id: r.id, owner_note: note })
    if (res.error) { setMsg('エラー: ' + res.error); return }
    setMsg('対応メモを保存しました'); load()
  }
  const del = async (r: FRow) => {
    if (!confirm('この改善要望を削除しますか？')) return
    const res = await call({ action: 'delete', id: r.id })
    if (res.error) { setMsg('エラー: ' + res.error); return }
    setOpenId(null); load()
  }

  return (
    <div>
      <div className="flex items-center gap-2 mb-3 flex-wrap">
        <p className="text-sm" style={{ color: 'var(--text-dim)' }}>
          支配人から届いた「灯の回答への改善要望」です（{counts.all}件・未対応 {counts.new}件）。
        </p>
        <div className="ml-auto flex gap-1">
          {[['all', 'すべて'], ...STATUS].map(([k, l]) => (
            <button key={k} onClick={() => setFilter(k)} className="px-2.5 py-1 rounded-md text-xs"
              style={{ background: filter === k ? 'var(--accent)' : 'var(--surface2)', color: filter === k ? '#fff' : 'var(--text-dim)' }}>{l}</button>
          ))}
        </div>
      </div>

      {shown.length === 0 ? (
        <p className="text-sm py-8 text-center" style={{ color: 'var(--text-dim)' }}>該当する改善要望はありません。</p>
      ) : (
        <div className="space-y-2">
          {shown.map((r) => (
            <div key={r.id} className="card p-3">
              <div className="flex items-center gap-2 flex-wrap cursor-pointer" onClick={() => open(r)}>
                <span className="text-[10px] px-1.5 py-0.5 rounded text-white" style={{ background: statusColor(r.status) }}>{STATUS.find(([s]) => s === r.status)?.[1] ?? r.status}</span>
                <span className="text-[10px] px-1.5 py-0.5 rounded" style={{ background: 'var(--surface2)', color: 'var(--text-dim)' }}>{SRC[r.source] ?? r.source}</span>
                <span className="text-sm flex-1 truncate">{r.comment || r.question || '（コメントなし）'}</span>
                <span className="text-[10px]" style={{ color: 'var(--text-dim)' }}>{r.facility ?? '-'} / {r.created_by ?? '-'} / {new Date(r.created_at).toLocaleString('ja-JP')}</span>
              </div>

              {openId === r.id && (
                <div className="mt-3 pt-3 space-y-3" style={{ borderTop: '1px solid var(--border)' }}>
                  {r.comment && <div><p className="text-[11px] font-semibold mb-1" style={{ color: 'var(--text-dim)' }}>送信者コメント</p><p className="text-sm" style={{ whiteSpace: 'pre-wrap' }}>{r.comment}</p></div>}
                  <div><p className="text-[11px] font-semibold mb-1" style={{ color: 'var(--text-dim)' }}>対象の質問</p><p className="text-sm" style={{ whiteSpace: 'pre-wrap' }}>{r.question || '-'}</p></div>
                  <div>
                    <p className="text-[11px] font-semibold mb-1" style={{ color: 'var(--text-dim)' }}>灯の回答</p>
                    <div className="rounded-md p-2" style={{ background: 'var(--surface2)' }}>{r.answer ? <AssistantContent content={r.answer} /> : <span className="text-sm" style={{ color: 'var(--text-dim)' }}>-</span>}</div>
                  </div>
                  <div>
                    <p className="text-[11px] font-semibold mb-1" style={{ color: 'var(--text-dim)' }}>対応</p>
                    <div className="flex items-center gap-1 mb-2 flex-wrap">
                      {STATUS.map(([s, l]) => (
                        <button key={s} onClick={() => setStatus(r, s)} className="px-2.5 py-1 rounded-md text-xs"
                          style={{ background: r.status === s ? statusColor(s) : 'var(--surface2)', color: r.status === s ? '#fff' : 'var(--text-dim)' }}>{l}</button>
                      ))}
                      <button onClick={() => del(r)} className="ml-auto px-2 py-1 rounded-md text-xs" style={{ border: '1px solid var(--red)', color: 'var(--red)' }}>削除</button>
                    </div>
                    <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} placeholder="対応メモ（例: chat_systemの◯◯を修正済み）" className="field w-full text-sm p-2" />
                    <button onClick={() => saveNote(r)} className="mt-1 px-3 py-1 rounded-md text-xs" style={{ border: '1px solid var(--border)', color: 'var(--text)' }}>メモを保存</button>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
      {msg && <p className="text-sm mt-3" style={{ color: msg.startsWith('エラー') ? 'var(--red)' : 'var(--green)' }}>{msg}</p>}
    </div>
  )
}
