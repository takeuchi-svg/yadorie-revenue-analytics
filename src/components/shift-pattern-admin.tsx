'use client'

// 各宿設定 → シフトパターン管理。dim_shift_pattern の「この宿のパターン」を追加/編集/削除。
// 全社共通パターン(facility=NULL)は参照のみ表示。シフト管理画面はこの宿＋全社共通を読み込む。
import { useCallback, useEffect, useState } from 'react'
import { useFacility } from '@/lib/facility-context'
import { supabase } from '@/lib/supabase/client'
import { useToast } from '@/components/toast'
import { Loading } from '@/components/page-bits'

/* eslint-disable @typescript-eslint/no-explicit-any */
interface Role { role_id: number; role_name: string }
interface Pat {
  pattern_id?: number; pattern_type: string; name: string
  start_time: string; end_time: string; break_minutes: string
  default_role_id: string; is_paid: boolean; color: string; sort_order: string; is_active: boolean
  facility: string | null
}
const TYPES = ['勤務', '休日']
const hhmm = (t: string | null) => (t ? String(t).slice(0, 5) : '')
const blank = (facility: string, so: number): Pat => ({
  pattern_type: '勤務', name: '', start_time: '', end_time: '', break_minutes: '0',
  default_role_id: '', is_paid: false, color: '#7F77DD', sort_order: String(so), is_active: true, facility,
})

export default function ShiftPatternAdmin() {
  const { current } = useFacility()
  const toast = useToast()
  const [rows, setRows] = useState<Pat[]>([])
  const [globals, setGlobals] = useState<Pat[]>([])
  const [roles, setRoles] = useState<Role[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [delIds, setDelIds] = useState<number[]>([])

  const load = useCallback(async () => {
    if (!current) return
    setLoading(true); setDelIds([])
    const [pat, rl] = await Promise.all([
      supabase.from('dim_shift_pattern').select('*').or(`facility.is.null,facility.eq.${current}`).order('sort_order').then((r) => r),
      supabase.from('dim_role').select('role_id, role_name').eq('is_active', true).order('sort_order').then((r) => r),
    ])
    const all = ((pat as any).data ?? []) as any[]
    const toPat = (p: any): Pat => ({
      pattern_id: p.pattern_id, pattern_type: p.pattern_type ?? '勤務', name: p.name ?? '',
      start_time: hhmm(p.start_time), end_time: hhmm(p.end_time), break_minutes: String(p.break_minutes ?? 0),
      default_role_id: p.default_role_id != null ? String(p.default_role_id) : '', is_paid: !!p.is_paid,
      color: p.color ?? '#7F77DD', sort_order: String(p.sort_order ?? 0), is_active: !!p.is_active, facility: p.facility,
    })
    setGlobals(all.filter((p) => p.facility == null).map(toPat))
    setRows(all.filter((p) => p.facility === current).map(toPat))
    setRoles(((rl as any).data ?? []) as Role[])
    setLoading(false)
  }, [current])
  useEffect(() => { load() }, [load])

  const setCell = (i: number, k: keyof Pat, v: any) => setRows((p) => p.map((r, idx) => idx === i ? { ...r, [k]: v } : r))
  const addRow = () => setRows((p) => [...p, blank(current, (p.length ? Math.max(...p.map((r) => Number(r.sort_order) || 0)) : 0) + 1)])
  const removeRow = (i: number) => setRows((p) => { const r = p[i]; if (r.pattern_id) setDelIds((d) => [...d, r.pattern_id!]); return p.filter((_, idx) => idx !== i) })

  const save = async () => {
    if (!current) return
    for (const r of rows) if (!r.name.trim()) { toast('パターン名を入力してください', 'error'); return }
    setSaving(true)
    try {
      if (delIds.length) await supabase.from('dim_shift_pattern').delete().in('pattern_id', delIds)
      const toDb = (r: Pat) => ({
        pattern_type: r.pattern_type, name: r.name.trim(),
        start_time: r.start_time || null, end_time: r.end_time || null,
        break_minutes: Number(r.break_minutes) || 0,
        default_role_id: r.default_role_id ? Number(r.default_role_id) : null,
        is_paid: r.is_paid, color: r.color || null, sort_order: Number(r.sort_order) || 0, is_active: r.is_active,
        facility: current,
      })
      const existing = rows.filter((r) => r.pattern_id).map((r) => ({ pattern_id: r.pattern_id, ...toDb(r) }))
      const fresh = rows.filter((r) => !r.pattern_id).map(toDb)
      if (existing.length) { const { error } = await supabase.from('dim_shift_pattern').upsert(existing, { onConflict: 'pattern_id' }); if (error) throw error }
      if (fresh.length) { const { error } = await supabase.from('dim_shift_pattern').insert(fresh); if (error) throw error }
      toast('シフトパターンを保存しました')
      load()
    } catch (e: any) { toast(`エラー: ${e.message ?? e}`, 'error') } finally { setSaving(false) }
  }

  if (loading) return <Loading />
  const inp = 'field px-1.5 py-1 text-xs'

  return (
    <section className="card p-5">
      <div className="flex items-center justify-between mb-1 flex-wrap gap-2">
        <h2 className="text-lg font-semibold">シフトパターン</h2>
        <div className="flex gap-2">
          <button onClick={addRow} className="text-xs px-3 py-1.5 rounded-md" style={{ background: 'var(--surface2)', color: 'var(--text)' }}>＋パターン追加</button>
          <button onClick={save} disabled={saving} className="px-4 py-1.5 rounded-md text-sm text-white disabled:opacity-50" style={{ background: 'var(--accent)' }}>{saving ? '保存中…' : '保存'}</button>
        </div>
      </div>
      <p className="text-xs mb-3" style={{ color: 'var(--text-dim)' }}>この宿のシフトパターンを追加・編集します。シフト管理画面で選べるようになります。全社共通パターンは下に参照表示（編集は全社設定側）。</p>

      <div className="overflow-x-auto">
        <table className="w-full text-xs whitespace-nowrap">
          <thead>
            <tr className="text-left" style={{ color: 'var(--text-dim)' }}>
              <th className="px-2 py-2">種別</th><th className="px-2 py-2">名称</th><th className="px-2 py-2">開始</th><th className="px-2 py-2">終了</th>
              <th className="px-2 py-2 text-right">休憩(分)</th><th className="px-2 py-2">既定の役割</th><th className="px-2 py-2 text-center">有給</th>
              <th className="px-2 py-2">色</th><th className="px-2 py-2 text-right">表示順</th><th className="px-2 py-2 text-center">有効</th><th className="px-2 py-2"></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i} style={{ borderTop: '1px solid var(--border)' }}>
                <td className="px-1 py-1"><select className={`${inp} w-16`} value={r.pattern_type} onChange={(e) => setCell(i, 'pattern_type', e.target.value)}>{TYPES.map((t) => <option key={t}>{t}</option>)}</select></td>
                <td className="px-1 py-1"><input className={`${inp} w-40`} value={r.name} placeholder="例: 早番 / 遅番 / 公休" onChange={(e) => setCell(i, 'name', e.target.value)} /></td>
                <td className="px-1 py-1"><input type="time" className={`${inp} w-24`} value={r.start_time} onChange={(e) => setCell(i, 'start_time', e.target.value)} /></td>
                <td className="px-1 py-1"><input type="time" className={`${inp} w-24`} value={r.end_time} onChange={(e) => setCell(i, 'end_time', e.target.value)} /></td>
                <td className="px-1 py-1 text-right"><input type="number" min={0} className={`${inp} w-16 text-right`} value={r.break_minutes} onChange={(e) => setCell(i, 'break_minutes', e.target.value)} /></td>
                <td className="px-1 py-1"><select className={`${inp} w-28`} value={r.default_role_id} onChange={(e) => setCell(i, 'default_role_id', e.target.value)}><option value="">—</option>{roles.map((rl) => <option key={rl.role_id} value={rl.role_id}>{rl.role_name}</option>)}</select></td>
                <td className="px-1 py-1 text-center"><input type="checkbox" checked={r.is_paid} onChange={(e) => setCell(i, 'is_paid', e.target.checked)} /></td>
                <td className="px-1 py-1"><input type="color" className="w-8 h-7 p-0 border rounded" style={{ borderColor: 'var(--border)' }} value={r.color} onChange={(e) => setCell(i, 'color', e.target.value)} /></td>
                <td className="px-1 py-1 text-right"><input type="number" className={`${inp} w-14 text-right`} value={r.sort_order} onChange={(e) => setCell(i, 'sort_order', e.target.value)} /></td>
                <td className="px-1 py-1 text-center"><input type="checkbox" checked={r.is_active} onChange={(e) => setCell(i, 'is_active', e.target.checked)} /></td>
                <td className="px-1 py-1 text-center"><button onClick={() => removeRow(i)} className="text-[13px]" style={{ color: 'var(--red)' }} title="削除">×</button></td>
              </tr>
            ))}
            {rows.length === 0 && <tr><td colSpan={11} className="px-2 py-4 text-center" style={{ color: 'var(--text-dim)' }}>この宿のパターンはまだありません。「＋パターン追加」で作成してください。</td></tr>}
          </tbody>
        </table>
      </div>

      {globals.length > 0 && (
        <div className="mt-4">
          <div className="text-xs font-semibold mb-1" style={{ color: 'var(--text-dim)' }}>全社共通パターン（参照のみ・シフト管理でも選べます）</div>
          <div className="flex flex-wrap gap-2">
            {globals.map((g) => (
              <span key={g.pattern_id} className="inline-flex items-center gap-1.5 text-[11px] px-2 py-1 rounded" style={{ background: 'var(--surface2)', color: 'var(--text-dim)' }}>
                <span className="inline-block w-2.5 h-2.5 rounded-full" style={{ background: g.color || '#B4B2A9' }} />
                {g.name}{g.start_time ? `（${g.start_time}–${g.end_time}）` : ''}{g.pattern_type === '休日' ? '・休日' : ''}
              </span>
            ))}
          </div>
        </div>
      )}
    </section>
  )
}
