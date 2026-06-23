'use client'

import { useCallback, useEffect, useState } from 'react'
import { useFacility } from '@/lib/facility-context'
import { supabase } from '@/lib/supabase/client'

/* eslint-disable @typescript-eslint/no-explicit-any */
interface UserRow { user_id: string; email: string; role: string; facilities: string[] }

export default function UserAdmin() {
  const { facilities } = useFacility()
  const [users, setUsers] = useState<UserRow[]>([])
  const [msg, setMsg] = useState('')
  const [busy, setBusy] = useState(false)
  // 新規
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [role, setRole] = useState('member')
  const [newFacs, setNewFacs] = useState<Set<string>>(new Set())
  // 編集中の施設割当
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
    if (r.error) { setMsg(r.error); return }
    setUsers(r.users ?? [])
    const ef: Record<string, Set<string>> = {}
    ;(r.users ?? []).forEach((u: UserRow) => { ef[u.user_id] = new Set(u.facilities) })
    setEditFacs(ef)
  }, [call])

  useEffect(() => { reload() }, [reload])

  const create = async () => {
    if (!email || !password) { setMsg('メールとパスワードを入力してください'); return }
    setBusy(true); setMsg('')
    const r = await call('create', { email, password, role, facilities: [...newFacs] })
    setBusy(false)
    if (r.error) { setMsg('エラー: ' + r.error); return }
    setMsg('発行しました'); setEmail(''); setPassword(''); setRole('member'); setNewFacs(new Set())
    reload()
  }

  const toggle = (set: Set<string>, f: string) => { const n = new Set(set); n.has(f) ? n.delete(f) : n.add(f); return n }

  return (
    <section className="card p-6 mt-6">
      <h2 className="text-lg font-semibold mb-4">ユーザー管理（管理者のみ）</h2>

      {/* 新規発行 */}
      <div className="mb-6 rounded-md p-4" style={{ background: 'var(--surface2)' }}>
        <h3 className="text-sm font-semibold mb-3">アカウント発行</h3>
        <div className="flex flex-wrap gap-2 mb-3">
          <input className="field px-3 py-1.5 text-sm" placeholder="メールアドレス" value={email} onChange={(e) => setEmail(e.target.value)} />
          <input className="field px-3 py-1.5 text-sm" placeholder="初期パスワード" value={password} onChange={(e) => setPassword(e.target.value)} />
          <select className="field px-3 py-1.5 text-sm" value={role} onChange={(e) => setRole(e.target.value)}>
            <option value="member">一般（指定施設のみ）</option>
            <option value="admin">管理者（全施設＋ユーザー管理）</option>
          </select>
          <button onClick={create} disabled={busy} className="px-4 py-1.5 rounded-md text-sm text-white disabled:opacity-50" style={{ background: 'var(--accent)' }}>発行</button>
        </div>
        {role === 'member' && (
          <div>
            <p className="text-xs mb-1" style={{ color: 'var(--text-dim)' }}>閲覧できる施設を選択:</p>
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
              <select className="field px-2 py-1 text-xs" value={u.role}
                onChange={async (e) => { await call('setRole', { user_id: u.user_id, role: e.target.value }); reload() }}>
                <option value="member">一般</option>
                <option value="admin">管理者</option>
              </select>
              <button onClick={async () => { if (confirm(`${u.email} を削除しますか？`)) { await call('delete', { user_id: u.user_id }); reload() } }}
                className="ml-auto text-xs px-2 py-1 rounded-md" style={{ color: 'var(--red)', border: '1px solid var(--border)' }}>削除</button>
            </div>
            {u.role !== 'admin' && (
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
                <button onClick={async () => { await call('setFacilities', { user_id: u.user_id, facilities: [...(editFacs[u.user_id] ?? [])] }); setMsg('施設割当を保存しました'); reload() }}
                  className="text-xs px-3 py-1 rounded-md text-white" style={{ background: 'var(--accent)' }}>施設割当を保存</button>
              </div>
            )}
            {u.role === 'admin' && <p className="text-xs" style={{ color: 'var(--text-dim)' }}>全施設を閲覧できます</p>}
          </div>
        ))}
      </div>

      {msg && <p className="text-sm mt-3" style={{ color: msg.startsWith('エラー') ? 'var(--red)' : 'var(--green)' }}>{msg}</p>}
    </section>
  )
}
