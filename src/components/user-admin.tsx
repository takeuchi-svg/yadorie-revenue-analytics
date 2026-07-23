'use client'

import { useCallback, useEffect, useState } from 'react'
import { useFacility } from '@/lib/facility-context'
import { supabase } from '@/lib/supabase/client'
import { useToast } from '@/components/toast'

/* eslint-disable @typescript-eslint/no-explicit-any */
interface UserRow { user_id: string; email: string; role: string; can_view_wage?: boolean; facilities: string[] }

export default function UserAdmin() {
  const { facilities } = useFacility()
  const toast = useToast()
  const [users, setUsers] = useState<UserRow[]>([])
  const [busy, setBusy] = useState(false)
  // 新規
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [role, setRole] = useState('member')
  const [newFacs, setNewFacs] = useState<Set<string>>(new Set())
  const [issued, setIssued] = useState<{ email: string; password: string } | null>(null)  // 発行直後の資格情報（コピー用）
  // 編集中の宿割当
  const [editFacs, setEditFacs] = useState<Record<string, Set<string>>>({})

  const call = useCallback(async (action: string, payload: any = {}) => {
    const { data: { session } } = await supabase.auth.getSession()
    const res = await fetch('/api/admin/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session?.access_token}` },
      body: JSON.stringify({ action, ...payload }),
    })
    return res.json()
  }, [])

  const reload = useCallback(async () => {
    const r = await call('list')
    if (r.error) { toast(r.error, 'error'); return }
    setUsers(r.users ?? [])
    const ef: Record<string, Set<string>> = {}
    ;(r.users ?? []).forEach((u: UserRow) => { ef[u.user_id] = new Set(u.facilities) })
    setEditFacs(ef)
  }, [call])

  useEffect(() => { reload() }, [reload])

  // 強いランダム初期パスワードを生成（本人が初回ログイン後に変更する前提）
  const genPassword = () => {
    const chars = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789'
    const rnd = new Uint32Array(14); crypto.getRandomValues(rnd)
    setPassword(Array.from(rnd, (n) => chars[n % chars.length]).join(''))
  }

  // 推奨: 初期パスワードで即時発行（メールリンク不要＝法人メールでも確実）
  const issueWithPassword = async () => {
    if (!email) { toast('メールアドレスを入力してください', 'error'); return }
    if (!password || password.length < 8) { toast('初期パスワードは8文字以上で入力（「自動生成」も使えます）', 'error'); return }
    setBusy(true)
    const r = await call('create', { email, password, role, facilities: [...newFacs] })
    setBusy(false)
    if (r.error) { toast('エラー: ' + r.error, 'error'); return }
    setIssued({ email, password })  // コピー用に表示（トーストではなく残す）
    toast('アカウントを発行しました'); setEmail(''); setPassword(''); setRole('member'); setNewFacs(new Set())
    reload()
  }

  // 補助: 招待メール（本人がリンクからパスワード設定）。法人メールはリンク先読み消費で失敗しやすい
  const sendInvite = async () => {
    if (!email) { toast('メールアドレスを入力してください', 'error'); return }
    if (!confirm('招待メールを送信します。\n\n会社のメールセキュリティ（SafeLinks等）がリンクを先に開くと「リンク無効/期限切れ」になり失敗することがあります。\n法人メール宛では「初期パスワードで発行」が確実です。\n\nこのまま招待メールを送りますか？')) return
    setBusy(true)
    const r = await call('invite', { email, role, facilities: [...newFacs], redirectTo: `${window.location.origin}/reset-password` })
    setBusy(false)
    if (r.error) { toast('エラー: ' + r.error, 'error'); return }
    toast(`${email} に招待メールを送信しました`); setEmail(''); setPassword(''); setRole('member'); setNewFacs(new Set())
    reload()
  }

  const sendReset = async (targetEmail: string) => {
    setBusy(true)
    const r = await call('sendReset', { email: targetEmail, redirectTo: `${window.location.origin}/reset-password` })
    setBusy(false)
    toast(r.error ? 'エラー: ' + r.error : `${targetEmail} に再設定メールを送信しました`, r.error ? 'error' : 'success')
  }

  const toggle = (set: Set<string>, f: string) => { const n = new Set(set); n.has(f) ? n.delete(f) : n.add(f); return n }

  return (
    <section className="card p-6 mt-6">
      <h2 className="text-lg font-semibold mb-4">ユーザー管理（管理者のみ）</h2>

      {/* 新規発行 */}
      <div className="mb-6 rounded-md p-4" style={{ background: 'var(--surface2)' }}>
        <h3 className="text-sm font-semibold mb-1">アカウント発行</h3>
        <p className="text-[11px] mb-3" style={{ color: 'var(--text-dim)' }}>
          <b>推奨は「初期パスワードで発行」</b>（メールリンク不要で確実）。発行後に表示される<b>メール＋初期パスワード</b>を本人へ伝え、ログイン画面から直接ログインしてもらいます（初回ログイン後に本人がパスワード変更）。
        </p>
        <div className="flex flex-wrap gap-2 mb-1 items-center">
          <input className="field px-3 py-1.5 text-sm" placeholder="メールアドレス" value={email} onChange={(e) => setEmail(e.target.value)} />
          <input className="field px-3 py-1.5 text-sm" placeholder="初期パスワード（8文字以上）" value={password} onChange={(e) => setPassword(e.target.value)} />
          <button onClick={genPassword} type="button" disabled={busy} className="px-3 py-1.5 rounded-md text-xs disabled:opacity-50" style={{ border: '1px solid var(--border)', color: 'var(--text-dim)' }} title="強いパスワードを自動生成">🔑 自動生成</button>
          <select className="field px-3 py-1.5 text-sm" value={role} onChange={(e) => setRole(e.target.value)}>
            <option value="member">一般（指定宿のみ）</option>
            <option value="admin">管理者（全宿＋ユーザー管理）</option>
          </select>
          <button onClick={issueWithPassword} disabled={busy} className="px-4 py-1.5 rounded-md text-sm text-white disabled:opacity-50" style={{ background: 'var(--accent)' }}>
            発行（パスワード設定）
          </button>
          <button onClick={sendInvite} type="button" disabled={busy} className="px-3 py-1.5 rounded-md text-xs disabled:opacity-50" style={{ border: '1px solid var(--border)', color: 'var(--text-dim)' }} title="本人がリンクからパスワード設定。法人メールでは失敗しやすい">招待メールで送る</button>
        </div>
        <p className="text-[11px] mb-3" style={{ color: 'var(--text-dim)' }}>
          「招待メールで送る」は本人がリンクからパスワードを設定する方式ですが、<b>会社のメールセキュリティ（SafeLinks等）がリンクを先に開くと「リンク無効/期限切れ」で失敗</b>することがあります。法人メール宛では上の初期パスワード発行が確実です。
        </p>
        {issued && (
          <div className="rounded-md p-3 mb-3 text-sm" style={{ background: 'var(--surface)', border: '1px solid var(--accent)' }}>
            <div className="font-semibold mb-1" style={{ color: 'var(--accent)' }}>発行しました（本人へ共有してください）</div>
            <div className="font-mono text-xs" style={{ color: 'var(--text)' }}>メール: {issued.email}<br />初期パスワード: {issued.password}</div>
            <div className="flex gap-2 mt-2">
              <button type="button" onClick={() => { navigator.clipboard?.writeText(`ログイン: ${window.location.origin}/login\nメール: ${issued.email}\n初期パスワード: ${issued.password}`); toast('ログイン情報をコピーしました') }}
                className="px-2 py-1 rounded text-xs text-white" style={{ background: 'var(--accent)' }}>ログイン情報をコピー</button>
              <button type="button" onClick={() => setIssued(null)} className="px-2 py-1 rounded text-xs" style={{ border: '1px solid var(--border)', color: 'var(--text-dim)' }}>閉じる</button>
            </div>
          </div>
        )}
        {role === 'member' && (
          <div>
            <p className="text-xs mb-1" style={{ color: 'var(--text-dim)' }}>閲覧できる宿を選択:</p>
            <div className="grid grid-cols-2 md:grid-cols-3 gap-x-3 gap-y-1 max-h-40 overflow-y-auto text-xs">
              {facilities.map((f) => (
                <label key={f.facility} className="flex items-center gap-1.5 cursor-pointer">
                  <input type="checkbox" checked={newFacs.has(f.facility)} onChange={() => setNewFacs(toggle(newFacs, f.facility))} />
                  {f.short_name || f.name}
                </label>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* 一覧 */}
      <div className="space-y-3">
        {users.length === 0 && <p className="text-sm" style={{ color: 'var(--text-dim)' }}>ユーザーがいません（または app_user テーブル未作成）。</p>}
        {users.map((u) => (
          <div key={u.user_id} className="rounded-md p-3" style={{ border: '1px solid var(--border)' }}>
            <div className="flex items-center gap-2 mb-2 flex-wrap">
              <span className="text-sm font-medium">{u.email}</span>
              {u.role === 'owner' ? (
                <span className="text-xs px-2 py-1 rounded-md font-semibold" style={{ background: 'var(--accent)', color: '#fff' }}>オーナー</span>
              ) : (
                <select className="field px-2 py-1 text-xs" value={u.role}
                  onChange={async (e) => { await call('setRole', { user_id: u.user_id, role: e.target.value }); toast('権限を変更しました'); reload() }}>
                  <option value="member">一般</option>
                  <option value="admin">管理者</option>
                </select>
              )}
              {u.role === 'member' && (
                <label className="flex items-center gap-1 text-xs cursor-pointer" style={{ color: 'var(--text-dim)' }} title="ON: 割当宿の従業員の賃金・個人別人件費を閲覧/編集できる">
                  <input type="checkbox" checked={!!u.can_view_wage}
                    onChange={async (e) => { await call('setWagePerm', { user_id: u.user_id, can_view_wage: e.target.checked }); toast('給与閲覧権限を変更しました'); reload() }} />
                  給与閲覧
                </label>
              )}
              <button onClick={() => sendReset(u.email)} disabled={busy}
                className="ml-auto text-xs px-2 py-1 rounded-md disabled:opacity-50" style={{ color: 'var(--text-dim)', border: '1px solid var(--border)' }}
                title="このユーザーにパスワード再設定メールを送信">再設定メール</button>
              <button onClick={async () => { if (confirm(`${u.email} を削除しますか？`)) { await call('delete', { user_id: u.user_id }); toast(`${u.email} を削除しました`); reload() } }}
                className="text-xs px-2 py-1 rounded-md" style={{ color: 'var(--red)', border: '1px solid var(--border)' }}>削除</button>
            </div>
            {u.role === 'member' && (
              <div>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-x-3 gap-y-1 text-xs mb-2">
                  {facilities.map((f) => (
                    <label key={f.facility} className="flex items-center gap-1.5 cursor-pointer">
                      <input type="checkbox" checked={editFacs[u.user_id]?.has(f.facility) ?? false}
                        onChange={() => setEditFacs((prev) => ({ ...prev, [u.user_id]: toggle(prev[u.user_id] ?? new Set(), f.facility) }))} />
                      {f.short_name || f.name}
                    </label>
                  ))}
                </div>
                <button onClick={async () => { await call('setFacilities', { user_id: u.user_id, facilities: [...(editFacs[u.user_id] ?? [])] }); toast('宿割当を保存しました'); reload() }}
                  className="text-xs px-3 py-1 rounded-md text-white" style={{ background: 'var(--accent)' }}>宿割当を保存</button>
              </div>
            )}
            {(u.role === 'admin' || u.role === 'owner') && (
              <p className="text-xs" style={{ color: 'var(--text-dim)' }}>
                全宿を閲覧できます{u.role === 'owner' ? '（オーナー: AIナレッジ・プロンプトの編集権限を持ちます）' : ''}
              </p>
            )}
          </div>
        ))}
      </div>

    </section>
  )
}
