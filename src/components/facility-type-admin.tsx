'use client'

// 宿タイプ一括設定（管理者向け）。全宿のタイプを1画面で割り当てて保存。
// 保存先: dim_facility_profile.facility_type（灯の基準PL照合・横断比較に使用）。
import { useEffect, useState } from 'react'
import { useFacility } from '@/lib/facility-context'
import { supabase } from '@/lib/supabase/client'
import { FACILITY_TYPES } from '@/lib/facility-profile-def'
import { useToast } from '@/components/toast'

export default function FacilityTypeAdmin() {
  const { facilities } = useFacility()
  const toast = useToast()
  const [types, setTypes] = useState<Record<string, string>>({})
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    supabase.from('dim_facility_profile').select('facility, facility_type').then(({ data }) => {
      const m: Record<string, string> = {}
      ;((data as { facility: string; facility_type: string | null }[]) ?? []).forEach((r) => { if (r.facility_type) m[r.facility] = r.facility_type })
      setTypes(m)
    })
  }, [])

  const setType = (f: string, v: string) => { setTypes((p) => ({ ...p, [f]: v })); setDirty(true) }

  const save = async () => {
    setSaving(true)
    // 宿タイプ列のみをupsert（他のプロフィール列は触らない）
    const rows = facilities.map((f) => ({ facility: f.facility, facility_type: types[f.facility] || null, updated_at: new Date().toISOString() }))
    const { error } = await supabase.from('dim_facility_profile').upsert(rows, { onConflict: 'facility' })
    setSaving(false)
    toast(error ? 'エラー: ' + error.message : '宿タイプを保存しました', error ? 'error' : 'success')
    if (!error) setDirty(false)
  }

  const unsetCount = facilities.filter((f) => !types[f.facility]).length

  return (
    <section className="card p-6 mt-6">
      <div className="flex items-center justify-between mb-1 flex-wrap gap-2">
        <h2 className="text-lg font-semibold">宿タイプ一括設定</h2>
        <button onClick={save} disabled={saving || !dirty}
          className="px-4 py-1.5 bg-[var(--accent)] text-white rounded-md text-sm hover:opacity-90 disabled:opacity-50">
          {dirty ? '保存' : '保存済み'}
        </button>
      </div>
      <p className="text-xs mb-3" style={{ color: 'var(--text-dim)' }}>
        各宿のタイプ（7区分）を設定します。灯が基準PL（宿タイプ別の目標水準）に照らして水準評価するのに使います。
        {unsetCount > 0 && <span style={{ color: 'var(--red)' }}>　未設定 {unsetCount} 宿</span>}
      </p>

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr style={{ color: 'var(--text-dim)' }}>
              <th className="text-left font-medium px-2 py-1">宿</th>
              <th className="text-left font-medium px-2 py-1">タイプ</th>
            </tr>
          </thead>
          <tbody>
            {facilities.map((f) => (
              <tr key={f.facility} style={{ borderTop: '1px solid var(--border)' }}>
                <td className="px-2 py-1.5">
                  <span className="font-medium">{f.short_name || f.name || f.facility}</span>
                  <span className="ml-1 text-[10px]" style={{ color: 'var(--text-dim)' }}>{f.facility}</span>
                </td>
                <td className="px-2 py-1.5">
                  <select className="field px-3 py-1.5 text-sm" style={{ minWidth: 180 }}
                    value={types[f.facility] ?? ''} onChange={(e) => setType(f.facility, e.target.value)}>
                    <option value="">（未設定）</option>
                    {FACILITY_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
                  </select>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

    </section>
  )
}
