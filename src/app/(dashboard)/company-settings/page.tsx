'use client'

// 全社設定（全社Core・owner限定）: 従業員賃金設定 / 宿タイプ一括設定 / ユーザー管理。
// 各宿固有の設定は「宿プロフィール」(/profile)へ。
import { useEffect, useState } from 'react'
import { useFacility } from '@/lib/facility-context'
import { supabase } from '@/lib/supabase/client'
import { FacilitySelect } from '@/components/facility-select'
import UserAdmin from '@/components/user-admin'
import FacilityTypeAdmin from '@/components/facility-type-admin'
import { useToast } from '@/components/toast'

interface StaffWage {
  staff_code: string
  name: string | null
  employment_type: string | null
  is_spot: boolean | null
  wage_type: string | null
  hourly_wage: number | null
  monthly_salary: number | null
  deemed_ot_hours: number | null
  contracted_monthly_hours: number | null
}

export default function CompanySettingsPage() {
  const { isOwner, facilities } = useFacility()
  const toast = useToast()
  // 賃金設定の対象宿（全社モードには宿セレクタが無いので、この画面内で選ぶ）
  const [wageFacility, setWageFacility] = useState('')
  const [saving, setSaving] = useState(false)
  const [staffWages, setStaffWages] = useState<StaffWage[]>([])
  const [wagePermitted, setWagePermitted] = useState(true)

  useEffect(() => { if (!wageFacility && facilities.length) setWageFacility(facilities[0].facility) }, [facilities, wageFacility])

  useEffect(() => {
    if (!wageFacility || !isOwner) return
    ;(async () => {
      try {
        const { data: { user } } = await supabase.auth.getUser()
        if (user) {
          const { data: au } = await supabase.from('app_user').select('role, can_view_wage').eq('user_id', user.id).maybeSingle()
          setWagePermitted(au?.role === 'admin' || au?.role === 'owner' || !!au?.can_view_wage)
        }
      } catch { /* 判定不能時はUI表示のみ許可（DB側RLSが実防御） */ }
      const { data: staff } = await supabase.from('dim_staff')
        .select('staff_code, name, employment_type, is_spot')
        .eq('home_facility', wageFacility).order('staff_code')
      const codes = ((staff as { staff_code: string }[]) ?? []).map((s) => s.staff_code)
      const wageMap: Record<string, Partial<StaffWage>> = {}
      if (codes.length) {
        const { data: wages } = await supabase.from('dim_staff_wage')
          .select('staff_code, wage_type, hourly_wage, monthly_salary, deemed_ot_hours, contracted_monthly_hours')
          .in('staff_code', codes)
        ;((wages as StaffWage[]) ?? []).forEach((w) => { wageMap[w.staff_code] = w })
      }
      setStaffWages((((staff as StaffWage[]) ?? [])).map((s) => ({
        ...s,
        wage_type: wageMap[s.staff_code]?.wage_type ?? null,
        hourly_wage: wageMap[s.staff_code]?.hourly_wage ?? null,
        monthly_salary: wageMap[s.staff_code]?.monthly_salary ?? null,
        deemed_ot_hours: wageMap[s.staff_code]?.deemed_ot_hours ?? null,
        contracted_monthly_hours: wageMap[s.staff_code]?.contracted_monthly_hours ?? null,
      })))
    })()
  }, [wageFacility, isOwner])

  const updateWage = (code: string, patch: Partial<StaffWage>) =>
    setStaffWages((prev) => prev.map((s) => (s.staff_code === code ? { ...s, ...patch } : s)))

  const saveStaffWages = async () => {
    setSaving(true)
    const wageRows = staffWages.map((s) => ({
      staff_code: s.staff_code,
      wage_type: s.wage_type || null,
      hourly_wage: s.hourly_wage,
      monthly_salary: s.monthly_salary,
      deemed_ot_hours: s.deemed_ot_hours ?? 0,
      contracted_monthly_hours: s.contracted_monthly_hours,
      updated_at: new Date().toISOString(),
    }))
    const spotRows = staffWages.map((s) => ({ staff_code: s.staff_code, is_spot: !!s.is_spot, updated_at: new Date().toISOString() }))
    const { error } = await supabase.from('dim_staff_wage').upsert(wageRows, { onConflict: 'staff_code' })
    const { error: e2 } = await supabase.from('dim_staff').upsert(spotRows, { onConflict: 'staff_code' })
    const err = error ?? e2
    toast(err ? `エラー: ${err.message}` : `賃金設定を保存しました（${wageRows.length}名）`, err ? 'error' : 'success')
    setSaving(false)
  }

  if (!isOwner) return (
    <div className="p-6">
      <div className="card p-6 text-sm" style={{ color: 'var(--text-dim)' }}>
        全社設定は<strong>オーナーのみ</strong>が利用できます。
      </div>
    </div>
  )

  const wageFacilityName = facilities.find((f) => f.facility === wageFacility)?.name ?? wageFacility

  return (
    <div className="p-6 max-w-4xl">
      <div className="mb-4">
        <h1 className="text-lg font-semibold">全社設定</h1>
        <p className="text-xs mt-0.5" style={{ color: 'var(--text-dim)' }}>賃金・宿タイプ・ユーザーの横断管理。各宿固有の設定は「各宿」タブの宿プロフィールへ。</p>
      </div>

      {/* 従業員 賃金設定（宿ごと。全社モードには宿セレクタが無いのでここで選ぶ） */}
      <section className="card p-6">
        <div className="flex items-center justify-between mb-2 flex-wrap gap-2">
          <h2 className="text-lg font-semibold">従業員 賃金設定</h2>
          <button onClick={saveStaffWages} disabled={saving}
            className="px-4 py-1.5 bg-[var(--accent)] text-white rounded-md text-sm hover:opacity-90 disabled:opacity-50">保存</button>
        </div>
        <div className="mb-3">
          <label className="block text-[10px] mb-1 tracking-wide" style={{ color: 'var(--text-dim)' }}>対象の宿</label>
          <div className="min-w-56 inline-block"><FacilitySelect options={facilities} value={wageFacility} onChange={setWageFacility} /></div>
        </div>
        <p className="text-xs mb-3" style={{ color: 'var(--text-dim)' }}>
          人件費・残業の計算に使用（{wageFacilityName} 所属 {staffWages.length}名）。
          <strong>月給者</strong>は月所定・見込み残業が必須（残業単価=月給÷月所定×1.25、見込み超過分のみ残業代）。時給者は時給のみ。
        </p>
        {!wagePermitted && (
          <p className="text-sm mb-3 p-3 rounded-md" style={{ background: 'var(--surface2)', color: 'var(--text-dim)' }}>
            給与閲覧権限がないため賃金は表示されません（管理者がユーザー管理の「給与閲覧」で付与できます）。
          </p>
        )}
        <div className="overflow-x-auto">
          <table className="w-full text-sm whitespace-nowrap">
            <thead>
              <tr className="text-left" style={{ color: 'var(--text-dim)' }}>
                <th className="px-2 py-2">社員</th>
                <th className="px-2 py-2">区分</th>
                <th className="px-2 py-2 text-right">時給</th>
                <th className="px-2 py-2 text-right">月給</th>
                <th className="px-2 py-2 text-right">月所定h</th>
                <th className="px-2 py-2 text-right">見込残業h</th>
                <th className="px-2 py-2 text-center">スポット</th>
              </tr>
            </thead>
            <tbody>
              {staffWages.map((s) => (
                <tr key={s.staff_code} style={{ borderTop: '1px solid var(--border)' }}>
                  <td className="px-2 py-1.5">
                    <span className="font-medium">{s.name ?? s.staff_code}</span>
                    <span className="ml-1 text-[10px]" style={{ color: 'var(--text-dim)' }}>{s.staff_code}</span>
                  </td>
                  <td className="px-2 py-1.5">
                    <select className="field px-2 py-1 text-xs w-20" value={s.wage_type ?? ''}
                      onChange={(e) => updateWage(s.staff_code, { wage_type: e.target.value || null })}>
                      <option value="">未設定</option>
                      <option value="時給">時給</option>
                      <option value="月給">月給</option>
                    </select>
                  </td>
                  <td className="px-2 py-1.5 text-right">
                    <input type="number" min={0} className="field px-2 py-1 text-xs w-24 text-right"
                      value={s.hourly_wage ?? ''} disabled={s.wage_type === '月給'}
                      onChange={(e) => updateWage(s.staff_code, { hourly_wage: e.target.value === '' ? null : Number(e.target.value) })} />
                  </td>
                  <td className="px-2 py-1.5 text-right">
                    <input type="number" min={0} className="field px-2 py-1 text-xs w-28 text-right"
                      value={s.monthly_salary ?? ''} disabled={s.wage_type !== '月給'}
                      onChange={(e) => updateWage(s.staff_code, { monthly_salary: e.target.value === '' ? null : Number(e.target.value) })} />
                  </td>
                  <td className="px-2 py-1.5 text-right">
                    <input type="number" min={0} step="0.1" className="field px-2 py-1 text-xs w-20 text-right"
                      value={s.contracted_monthly_hours ?? ''} disabled={s.wage_type !== '月給'}
                      onChange={(e) => updateWage(s.staff_code, { contracted_monthly_hours: e.target.value === '' ? null : Number(e.target.value) })} />
                  </td>
                  <td className="px-2 py-1.5 text-right">
                    <input type="number" min={0} step="0.1" className="field px-2 py-1 text-xs w-20 text-right"
                      value={s.deemed_ot_hours ?? ''} disabled={s.wage_type !== '月給'}
                      onChange={(e) => updateWage(s.staff_code, { deemed_ot_hours: e.target.value === '' ? null : Number(e.target.value) })} />
                  </td>
                  <td className="px-2 py-1.5 text-center">
                    <input type="checkbox" checked={!!s.is_spot}
                      onChange={(e) => updateWage(s.staff_code, { is_spot: e.target.checked })} />
                  </td>
                </tr>
              ))}
              {staffWages.length === 0 && (
                <tr><td colSpan={7} className="px-2 py-4 text-center" style={{ color: 'var(--text-dim)' }}>この宿所属の従業員がいません（勤怠取込で登録されます）。</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      {/* 宿タイプ一括設定・ユーザー管理 */}
      <FacilityTypeAdmin />
      <UserAdmin />
    </div>
  )
}
