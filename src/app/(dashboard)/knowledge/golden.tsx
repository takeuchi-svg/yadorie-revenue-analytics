'use client'

// ゴールデン質問セット（K40）。プロンプト/ナレッジ公開前の品質チェック。
// 代表質問を灯に一括実行し、質問／期待される回答／灯の実回答 を並べて目視確認する（自動採点はしない）。
// 閲覧・実行=admin以上／編集=owner。質問はDB管理（golden_question）。
import { useCallback, useEffect, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { supabase } from '@/lib/supabase/client'

/* eslint-disable @typescript-eslint/no-explicit-any */
interface GRow { id: number; category: string; question: string; expectation: string; facility: string | null; sort_order: number; is_active: boolean }
type Ans = { loading: boolean; text: string; error?: string }

const CATS: [string, string][] = [
  ['kpi_def', 'KPI定義'], ['salary_guard', '給与守秘'], ['ng_proposal', 'NG提案回避'],
  ['cross_compare', '横断比較'], ['tone', '口調'],
]
const catLabel = (c: string) => CATS.find(([k]) => k === c)?.[1] ?? c
const catColor = (c: string) => c === 'salary_guard' ? 'var(--red)' : c === 'ng_proposal' ? 'var(--yellow)' : 'var(--accent)'

const empty: Partial<GRow> = { category: 'kpi_def', question: '', expectation: '', facility: '', sort_order: 0, is_active: true }

// 一括チェック画面では chart コードブロック（生JSON）は目視の邪魔なので、注記に置き換える
const cleanAnswer = (t: string) => t.replace(/```chart[\s\S]*?```/g, '\n_📊（グラフ出力あり・本番チャットでは図として表示されます）_\n')

export default function GoldenTab() {
  const [rows, setRows] = useState<GRow[]>([])
  const [canEdit, setCanEdit] = useState(false)
  const [ans, setAns] = useState<Record<number, Ans>>({})
  const [running, setRunning] = useState(false)
  const [msg, setMsg] = useState('')
  const [edit, setEdit] = useState<Partial<GRow> | null>(null)  // null=閉 / {id?...}=編集

  const call = useCallback(async (payload: any) => {
    const { data: { session } } = await supabase.auth.getSession()
    const res = await fetch('/api/admin/knowledge', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session?.access_token}` },
      body: JSON.stringify(payload),
    })
    return res.json()
  }, [])

  const load = useCallback(async () => {
    const r = await call({ action: 'goldenList' })
    if (r.error) { setMsg(r.error); return }
    setRows(r.rows ?? []); setCanEdit(!!r.canEdit)
  }, [call])
  useEffect(() => { load() }, [load])

  const runOne = useCallback(async (row: GRow) => {
    setAns((a) => ({ ...a, [row.id]: { loading: true, text: '' } }))
    const r = await call({ action: 'goldenRun', question: row.question, facility: row.facility || '' })
    setAns((a) => ({ ...a, [row.id]: { loading: false, text: r.answer ?? '', error: r.error } }))
  }, [call])

  const runAll = async () => {
    setRunning(true); setMsg('')
    for (const row of rows.filter((x) => x.is_active)) await runOne(row)  // 逐次実行（タイムアウト回避）
    setRunning(false); setMsg('一括実行が完了しました。回答を目視で確認してください。')
  }

  const save = async () => {
    if (!edit) return
    const r = await call({ action: 'goldenSave', id: edit.id, fields: edit })
    if (r.error) { setMsg('エラー: ' + r.error); return }
    setEdit(null); setMsg('保存しました'); load()
  }
  const del = async (id: number) => {
    if (!confirm('この質問を削除します。よろしいですか？')) return
    const r = await call({ action: 'goldenDelete', id })
    if (r.error) { setMsg('エラー: ' + r.error); return }
    setMsg('削除しました'); load()
  }

  return (
    <div>
      <div className="flex items-center gap-2 mb-3 flex-wrap">
        <p className="text-sm" style={{ color: 'var(--text-dim)' }}>
          公開前チェック用。灯に一括実行し、<b>期待される回答</b>と<b>灯の実回答</b>を見比べます（自動採点なし）。
        </p>
        <div className="ml-auto flex gap-2">
          {canEdit && <button onClick={() => setEdit({ ...empty })} className="px-3 py-1.5 rounded-md text-sm" style={{ border: '1px solid var(--border)', color: 'var(--text)' }}>＋ 質問を追加</button>}
          <button onClick={runAll} disabled={running || rows.length === 0}
            className="px-4 py-1.5 rounded-md text-sm text-white disabled:opacity-40" style={{ background: 'var(--accent)' }}>
            {running ? '実行中…' : '一括実行'}
          </button>
        </div>
      </div>

      <div className="space-y-3">
        {rows.map((row) => {
          const a = ans[row.id]
          return (
            <div key={row.id} className="card p-3" style={{ opacity: row.is_active ? 1 : 0.5 }}>
              <div className="flex items-start gap-2 mb-2">
                <span className="text-[10px] px-2 py-0.5 rounded shrink-0" style={{ background: catColor(row.category), color: '#fff' }}>{catLabel(row.category)}</span>
                <div className="flex-1">
                  <p className="text-sm font-medium">{row.question}</p>
                  {row.facility && <span className="text-[10px]" style={{ color: 'var(--text-dim)' }}>宿: {row.facility}</span>}
                </div>
                <button onClick={() => runOne(row)} disabled={a?.loading} className="px-2 py-1 rounded text-xs shrink-0" style={{ border: '1px solid var(--border)', color: 'var(--accent)' }}>{a?.loading ? '…' : '実行'}</button>
                {canEdit && <button onClick={() => setEdit({ ...row })} className="px-2 py-1 rounded text-xs shrink-0" style={{ border: '1px solid var(--border)', color: 'var(--text-dim)' }}>編集</button>}
                {canEdit && <button onClick={() => del(row.id)} className="px-2 py-1 rounded text-xs shrink-0" style={{ border: '1px solid var(--red)', color: 'var(--red)' }}>削除</button>}
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                <div className="rounded-md p-2 text-xs" style={{ background: 'var(--surface2)' }}>
                  <p className="font-semibold mb-1" style={{ color: 'var(--text-dim)' }}>期待される回答</p>
                  <p style={{ whiteSpace: 'pre-wrap' }}>{row.expectation}</p>
                </div>
                <div className="rounded-md p-2 text-xs" style={{ border: '1px solid var(--border)', background: 'var(--bg)' }}>
                  <p className="font-semibold mb-1" style={{ color: 'var(--text-dim)' }}>灯の実回答</p>
                  {a?.loading ? <p style={{ color: 'var(--text-dim)' }}>実行中…</p>
                    : a?.error ? <p style={{ color: 'var(--red)' }}>エラー: {a.error}</p>
                    : a?.text ? <div className="aimd"><ReactMarkdown remarkPlugins={[remarkGfm]}>{cleanAnswer(a.text)}</ReactMarkdown></div>
                    : <p style={{ color: 'var(--text-dim)' }}>（未実行）</p>}
                </div>
              </div>
            </div>
          )
        })}
        {rows.length === 0 && <p className="text-sm" style={{ color: 'var(--text-dim)' }}>質問がありません。SQL（ai_knowledge_k40.sql）を適用すると12問が入ります。</p>}
      </div>

      {msg && <p className="text-sm mt-3" style={{ color: msg.startsWith('エラー') ? 'var(--red)' : 'var(--green)' }}>{msg}</p>}

      {/* 編集モーダル */}
      {edit && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: 'rgba(0,0,0,.5)' }} onClick={() => setEdit(null)}>
          <div className="card p-5 w-full max-w-lg" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-base font-semibold mb-3">{edit.id ? '質問を編集' : '質問を追加'}</h3>
            <div className="space-y-3">
              <div>
                <label className="block text-[11px] mb-1" style={{ color: 'var(--text-dim)' }}>カテゴリ</label>
                <select value={edit.category} onChange={(e) => setEdit({ ...edit, category: e.target.value })} className="field w-full text-sm p-2">
                  {CATS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-[11px] mb-1" style={{ color: 'var(--text-dim)' }}>質問 *</label>
                <textarea value={edit.question} onChange={(e) => setEdit({ ...edit, question: e.target.value })} className="field w-full text-sm p-2" style={{ minHeight: 60 }} />
              </div>
              <div>
                <label className="block text-[11px] mb-1" style={{ color: 'var(--text-dim)' }}>期待される回答の性質 *</label>
                <textarea value={edit.expectation} onChange={(e) => setEdit({ ...edit, expectation: e.target.value })} className="field w-full text-sm p-2" style={{ minHeight: 70 }} />
              </div>
              <div className="flex gap-3">
                <div className="flex-1">
                  <label className="block text-[11px] mb-1" style={{ color: 'var(--text-dim)' }}>宿（空=既定FRY）</label>
                  <input value={edit.facility ?? ''} onChange={(e) => setEdit({ ...edit, facility: e.target.value })} className="field w-full text-sm p-2" />
                </div>
                <div style={{ width: 90 }}>
                  <label className="block text-[11px] mb-1" style={{ color: 'var(--text-dim)' }}>並び順</label>
                  <input type="number" value={edit.sort_order ?? 0} onChange={(e) => setEdit({ ...edit, sort_order: Number(e.target.value) })} className="field w-full text-sm p-2" />
                </div>
                <label className="flex items-end gap-1 text-xs pb-2">
                  <input type="checkbox" checked={edit.is_active !== false} onChange={(e) => setEdit({ ...edit, is_active: e.target.checked })} /> 有効
                </label>
              </div>
            </div>
            <div className="flex justify-end gap-2 mt-4">
              <button onClick={() => setEdit(null)} className="px-4 py-1.5 rounded-md text-sm" style={{ border: '1px solid var(--border)', color: 'var(--text-dim)' }}>キャンセル</button>
              <button onClick={save} className="px-4 py-1.5 rounded-md text-sm text-white" style={{ background: 'var(--accent)' }}>保存</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
