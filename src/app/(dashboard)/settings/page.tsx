'use client'

import { useEffect, useState } from 'react'
import { useFacility } from '@/lib/facility-context'
import { supabase } from '@/lib/supabase/client'
import { FacilitySelect } from '@/components/facility-select'
import UserAdmin from '@/components/user-admin'

interface OtaRow {
  id?: number
  facility: string
  month: string
  ota: string
  metric: string
  value: number | null
}

interface StaffWage {
  staff_code: string
  name: string | null
  employment_type: string | null
  is_spot: boolean | null
  // 賃金（dim_staff_wage。給与閲覧権限がないと読めない）
  wage_type: string | null
  hourly_wage: number | null
  monthly_salary: number | null
  deemed_ot_hours: number | null
  contracted_monthly_hours: number | null
}

const OTA_LIST = ['楽天トラベル', 'じゃらん', '一休', 'Booking.com', 'Expedia', '自社HP'] as const
const OTA_METRICS = [
  { key: 'ad_cost', label: '広告費' },
  { key: 'commission', label: '手数料' },
  { key: 'coupon', label: 'クーポン負担' },
] as const

export default function SettingsPage() {
  const { current, currentFacility, isAdmin, facilities, setCurrent } = useFacility()
  const [otaData, setOtaData] = useState<OtaRow[]>([])
  const [otaMonth, setOtaMonth] = useState(() => {
    const now = new Date()
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
  })
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState('')
  // 従業員 賃金設定（シフト・労務）
  const [staffWages, setStaffWages] = useState<StaffWage[]>([])
  const [wagePermitted, setWagePermitted] = useState(true)
  // 生産性手動入力
  const [prodMonth, setProdMonth] = useState(() => {
    const now = new Date()
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
  })
  const [dispatchNotes, setDispatchNotes] = useState('')

  useEffect(() => {
    if (!current || !otaMonth) return
    supabase
      .from('dim_ota_marketing')
      .select('*')
      .eq('facility', current)
      .eq('month', otaMonth)
      .then(({ data }) => {
        const rows = (data as OtaRow[]) ?? []
        const full: OtaRow[] = []
        for (const ota of OTA_LIST) {
          for (const m of OTA_METRICS) {
            const existing = rows.find((r) => r.ota === ota && r.metric === m.key)
            full.push(existing ?? { facility: current, month: otaMonth, ota, metric: m.key, value: null })
          }
        }
        setOtaData(full)
      })
  }, [current, otaMonth])

  // 生産性メモ: 選択施設×月の値を読み込み
  // ※「みなし残業超の残業代」「派遣・その他の労働時間」の手入力はT13で廃止
  //   （勤怠・賃金から mart_labor_cost_monthly で自動算出。二重計上防止のため入力欄は撤去）
  useEffect(() => {
    if (!current || !prodMonth) return
    supabase.from('dim_productivity_manual').select('dispatch_other_notes').eq('facility', current).eq('month', prodMonth).maybeSingle()
      .then(({ data }) => {
        setDispatchNotes((data as { dispatch_other_notes: string | null } | null)?.dispatch_other_notes ?? '')
      })
  }, [current, prodMonth])

  // 従業員 賃金設定: 従業員(dim_staff) + 賃金(dim_staff_wage・給与権限者のみ読める) をマージ
  useEffect(() => {
    if (!current) return
    ;(async () => {
      // 自分の給与閲覧権限（app_userは本人行のみ読める）
      try {
        const { data: { user } } = await supabase.auth.getUser()
        if (user) {
          const { data: au } = await supabase.from('app_user').select('role, can_view_wage').eq('user_id', user.id).maybeSingle()
          setWagePermitted(au?.role === 'admin' || !!au?.can_view_wage)
        }
      } catch { /* 判定不能時はUI表示のみ許可（DB側RLSが実防御） */ }
      const { data: staff } = await supabase.from('dim_staff')
        .select('staff_code, name, employment_type, is_spot')
        .eq('home_facility', current).order('staff_code')
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
  }, [current])

  const updateWage = (code: string, patch: Partial<StaffWage>) =>
    setStaffWages((prev) => prev.map((s) => (s.staff_code === code ? { ...s, ...patch } : s)))

  const saveStaffWages = async () => {
    setSaving(true); setMessage('')
    // 賃金 → dim_staff_wage / スポットフラグ → dim_staff
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
    setMessage(err ? `Error: ${err.message}` : `賃金設定を保存しました（${wageRows.length}名）`)
    setSaving(false)
  }

  const saveProd = async () => {
    setSaving(true); setMessage('')
    const { error } = await supabase.from('dim_productivity_manual').upsert({
      facility: current, month: prodMonth,
      dispatch_other_notes: dispatchNotes || null,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'facility,month' })
    setMessage(error ? `Error: ${error.message}` : 'メモを保存しました')
    setSaving(false)
  }

  const updateOta = (ota: string, metric: string, value: string) => {
    setOtaData(otaData.map((r) =>
      r.ota === ota && r.metric === metric
        ? { ...r, value: value === '' ? null : Number(value) }
        : r
    ))
  }

  const saveOta = async () => {
    setSaving(true)
    setMessage('')
    const rows = otaData.filter((r) => r.value !== null)
    if (rows.length === 0) {
      setMessage('入力データがありません')
      setSaving(false)
      return
    }
    const { error } = await supabase
      .from('dim_ota_marketing')
      .upsert(rows.map((r) => ({
        facility: r.facility,
        month: r.month,
        ota: r.ota,
        metric: r.metric,
        value: r.value,
      })), { onConflict: 'facility,month,ota,metric' })
    setMessage(error ? `Error: ${error.message}` : 'OTAマーケティング費用を保存しました')
    setSaving(false)
  }

  return (
    <div className="p-6 max-w-4xl">
      <div className="flex items-end justify-between mb-6 flex-wrap gap-3">
        <h1 className="text-2xl font-bold">Settings</h1>
        <div>
          <label className="block text-[10px] mb-1 tracking-wide" style={{ color: 'var(--text-dim)' }}>設定対象の施設</label>
          <div className="min-w-56"><FacilitySelect options={facilities} value={current} onChange={setCurrent} /></div>
        </div>
      </div>

      {/* 施設マスタ(総客室数)・施設プロフィールは「ビュー → 施設プロフィール」ページへ移設 */}
      <p className="text-xs mb-4" style={{ color: 'var(--text-dim)' }}>
        総客室数・施設プロフィールの編集は <a href="/profile" style={{ color: 'var(--accent)' }}>施設プロフィール</a> ページに移動しました。
      </p>

      {/* OTA Marketing */}
      <section className="card p-6 mt-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold">OTAマーケティング費用</h2>
          <div className="flex items-center gap-2">
            <input
              type="month"
              className="field px-3 py-1.5 text-sm"
              value={otaMonth}
              onChange={(e) => setOtaMonth(e.target.value)}
            />
            <button
              onClick={saveOta}
              disabled={saving}
              className="px-4 py-1.5 bg-[var(--accent)] text-white rounded-md text-sm hover:opacity-90 disabled:opacity-50"
            >
              保存
            </button>
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-[var(--surface2)] text-left text-[var(--text-dim)]">
                <th className="px-3 py-2">OTA</th>
                {OTA_METRICS.map((m) => (
                  <th key={m.key} className="px-3 py-2">{m.label}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {OTA_LIST.map((ota) => (
                <tr key={ota} style={{ borderTop: '1px solid var(--border)' }}>
                  <td className="px-3 py-1.5 font-medium whitespace-nowrap">{ota}</td>
                  {OTA_METRICS.map((m) => {
                    const row = otaData.find((r) => r.ota === ota && r.metric === m.key)
                    return (
                      <td key={m.key} className="px-3 py-1.5">
                        <input
                          type="number"
                          className="field px-2 py-1 text-sm w-28"
                          value={row?.value ?? ''}
                          onChange={(e) => updateOta(ota, m.key, e.target.value)}
                        />
                      </td>
                    )
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* 従業員 賃金設定（シフト・労務） */}
      <section className="card p-6 mt-6">
        <div className="flex items-center justify-between mb-2 flex-wrap gap-2">
          <h2 className="text-lg font-semibold">従業員 賃金設定（シフト・労務）</h2>
          <button onClick={saveStaffWages} disabled={saving}
            className="px-4 py-1.5 bg-[var(--accent)] text-white rounded-md text-sm hover:opacity-90 disabled:opacity-50">保存</button>
        </div>
        <p className="text-xs mb-3" style={{ color: 'var(--text-dim)' }}>
          人件費・残業の計算に使用（{currentFacility?.name ?? current} 所属 {staffWages.length}名）。
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
                <tr><td colSpan={7} className="px-2 py-4 text-center" style={{ color: 'var(--text-dim)' }}>この施設所属の従業員がいません（勤怠取込で登録されます）。</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      {/* 生産性メモ（旧: 手動入力。2項目はT13で自動算出に切替済み） */}
      <section className="card p-6 mt-6">
        <div className="flex items-center justify-between mb-2 flex-wrap gap-2">
          <h2 className="text-lg font-semibold">生産性 メモ（月別）</h2>
          <div className="flex items-center gap-2">
            <input type="month" className="field px-3 py-1.5 text-sm" value={prodMonth} onChange={(e) => setProdMonth(e.target.value)} />
            <button onClick={saveProd} disabled={saving}
              className="px-4 py-1.5 bg-[var(--accent)] text-white rounded-md text-sm hover:opacity-90 disabled:opacity-50">保存</button>
          </div>
        </div>
        <p className="text-xs mb-3" style={{ color: 'var(--text-dim)' }}>
          「みなし残業超の残業代」「派遣・その他の労働時間」は、勤怠実績と賃金設定から<strong>自動算出</strong>に切り替わりました（手入力は廃止・二重計上防止）。ここでは補足メモのみ残せます。
        </p>
        <div>
          <label className="block text-sm font-medium mb-1" style={{ color: 'var(--text-dim)' }}>備考（派遣・その他に関するメモ）</label>
          <input type="text" className="field px-3 py-2 text-sm w-full"
            value={dispatchNotes} onChange={(e) => setDispatchNotes(e.target.value)} />
        </div>
      </section>

      {message && (
        <p className={`mt-4 text-sm ${message.startsWith('Error') ? 'text-red-600' : 'text-green-600'}`}>
          {message}
        </p>
      )}

      {/* ユーザー管理（管理者のみ） */}
      {isAdmin && <UserAdmin />}
    </div>
  )
}
