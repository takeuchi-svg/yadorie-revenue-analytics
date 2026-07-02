'use client'

import { useEffect, useState } from 'react'
import { useFacility } from '@/lib/facility-context'
import { supabase } from '@/lib/supabase/client'
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
  wage_type: string | null
  hourly_wage: number | null
  monthly_salary: number | null
  deemed_ot_hours: number | null
  contracted_monthly_hours: number | null
  is_spot: boolean | null
}

const OTA_LIST = ['楽天トラベル', 'じゃらん', '一休', 'Booking.com', 'Expedia', '自社HP'] as const
const OTA_METRICS = [
  { key: 'ad_cost', label: '広告費' },
  { key: 'commission', label: '手数料' },
  { key: 'coupon', label: 'クーポン負担' },
] as const

// 年度(4月開始)の12ヶ月 'YYYY-MM' を返す
function fyMonths(fy: string): string[] {
  const y = Number(fy)
  if (!y) return []
  const out: string[] = []
  for (let m = 4; m <= 12; m++) out.push(`${y}-${String(m).padStart(2, '0')}`)
  for (let m = 1; m <= 3; m++) out.push(`${y + 1}-${String(m).padStart(2, '0')}`)
  return out
}

export default function SettingsPage() {
  const { current, currentFacility, isAdmin, facilities, setCurrent } = useFacility()
  const [totalRooms, setTotalRooms] = useState<number | ''>('')
  const [otaData, setOtaData] = useState<OtaRow[]>([])
  const [otaMonth, setOtaMonth] = useState(() => {
    const now = new Date()
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
  })
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState('')
  // 稼働日数
  const [opFys, setOpFys] = useState<string[]>([])
  const [opFy, setOpFy] = useState('')
  const [opDays, setOpDays] = useState<Record<string, number | ''>>({})
  // 従業員 賃金設定（シフト・労務）
  const [staffWages, setStaffWages] = useState<StaffWage[]>([])
  // 生産性手動入力
  const [prodMonth, setProdMonth] = useState(() => {
    const now = new Date()
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
  })
  const [deemedPay, setDeemedPay] = useState<number | ''>('')
  const [dispatchHours, setDispatchHours] = useState<number | ''>('')
  const [dispatchNotes, setDispatchNotes] = useState('')

  useEffect(() => {
    if (!current) return
    setTotalRooms(currentFacility?.total_rooms ?? '')
  }, [current, currentFacility])

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

  // 稼働日数: 利用可能な年度を budget_monthly から取得
  useEffect(() => {
    if (!current) return
    supabase.from('budget_monthly').select('fiscal_year').eq('facility', current).then(({ data }) => {
      const fys = [...new Set(((data as { fiscal_year: string }[]) ?? []).map((r) => r.fiscal_year))].sort().reverse()
      setOpFys(fys)
      setOpFy((prev) => (fys.includes(prev) ? prev : fys[0] ?? ''))
    })
  }, [current])

  // 稼働日数: 選択年度の値を読み込み
  useEffect(() => {
    if (!current || !opFy) return
    const months = fyMonths(opFy)
    supabase.from('dim_operating_days').select('month, days').eq('facility', current).in('month', months)
      .then(({ data }) => {
        const map: Record<string, number | ''> = {}
        months.forEach((m) => { map[m] = '' })
        ;((data as { month: string; days: number | null }[]) ?? []).forEach((r) => { map[r.month] = r.days ?? '' })
        setOpDays(map)
      })
  }, [current, opFy])

  const saveOpDays = async () => {
    setSaving(true); setMessage('')
    const rows = Object.entries(opDays)
      .filter(([, v]) => v !== '' && v != null)
      .map(([month, days]) => ({ facility: current, month, days: Number(days) }))
    if (rows.length === 0) { setMessage('稼働日数が未入力です'); setSaving(false); return }
    const { error } = await supabase.from('dim_operating_days').upsert(rows, { onConflict: 'facility,month' })
    setMessage(error ? `Error: ${error.message}` : '稼働日数を保存しました')
    setSaving(false)
  }

  // 生産性手動入力: 選択施設×月の値を読み込み
  useEffect(() => {
    if (!current || !prodMonth) return
    supabase.from('dim_productivity_manual').select('*').eq('facility', current).eq('month', prodMonth).maybeSingle()
      .then(({ data }) => {
        const r = data as { deemed_overtime_excess_pay: number | null; dispatch_work_hours: number | null; dispatch_other_notes: string | null } | null
        setDeemedPay(r?.deemed_overtime_excess_pay ?? '')
        setDispatchHours(r?.dispatch_work_hours ?? '')
        setDispatchNotes(r?.dispatch_other_notes ?? '')
      })
  }, [current, prodMonth])

  // 従業員 賃金設定: 選択施設(home_facility)の従業員を読み込み
  useEffect(() => {
    if (!current) return
    supabase.from('dim_staff')
      .select('staff_code, name, employment_type, wage_type, hourly_wage, monthly_salary, deemed_ot_hours, contracted_monthly_hours, is_spot')
      .eq('home_facility', current).order('staff_code')
      .then(({ data }) => setStaffWages(((data as StaffWage[]) ?? [])))
  }, [current])

  const updateWage = (code: string, patch: Partial<StaffWage>) =>
    setStaffWages((prev) => prev.map((s) => (s.staff_code === code ? { ...s, ...patch } : s)))

  const saveStaffWages = async () => {
    setSaving(true); setMessage('')
    const rows = staffWages.map((s) => ({
      staff_code: s.staff_code,
      wage_type: s.wage_type || null,
      hourly_wage: s.hourly_wage,
      monthly_salary: s.monthly_salary,
      deemed_ot_hours: s.deemed_ot_hours ?? 0,
      contracted_monthly_hours: s.contracted_monthly_hours,
      is_spot: !!s.is_spot,
      updated_at: new Date().toISOString(),
    }))
    const { error } = await supabase.from('dim_staff').upsert(rows, { onConflict: 'staff_code' })
    setMessage(error ? `Error: ${error.message}` : `賃金設定を保存しました（${rows.length}名）`)
    setSaving(false)
  }

  const saveProd = async () => {
    setSaving(true); setMessage('')
    const { error } = await supabase.from('dim_productivity_manual').upsert({
      facility: current, month: prodMonth,
      deemed_overtime_excess_pay: deemedPay === '' ? 0 : Number(deemedPay),
      dispatch_work_hours: dispatchHours === '' ? 0 : Number(dispatchHours),
      dispatch_other_notes: dispatchNotes || null,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'facility,month' })
    setMessage(error ? `Error: ${error.message}` : '生産性手動入力を保存しました')
    setSaving(false)
  }

  const saveFacility = async () => {
    setSaving(true)
    setMessage('')
    const { error } = await supabase
      .from('dim_facility')
      .update({ total_rooms: totalRooms || null, updated_at: new Date().toISOString() })
      .eq('facility', current)
    setMessage(error ? `Error: ${error.message}` : '保存しました')
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
          <select className="field px-3 py-1.5 text-sm min-w-56" value={current} onChange={(e) => setCurrent(e.target.value)}>
            {facilities.map((f) => (
              <option key={f.facility} value={f.facility}>{f.name}</option>
            ))}
          </select>
        </div>
      </div>

      {/* Facility master */}
      <section className="card p-6 mb-6">
        <h2 className="text-lg font-semibold mb-4">施設マスタ: {currentFacility?.name}</h2>
        <div className="flex items-end gap-4">
          <div>
            <label className="block text-sm font-medium mb-1" style={{ color: 'var(--text-dim)' }}>総客室数</label>
            <input
              type="number"
              className="field px-3 py-2 text-sm w-32"
              value={totalRooms}
              onChange={(e) => setTotalRooms(e.target.value === '' ? '' : Number(e.target.value))}
            />
          </div>
          <button
            onClick={saveFacility}
            disabled={saving}
            className="px-4 py-2 bg-[var(--accent)] text-white rounded-md text-sm hover:opacity-90 disabled:opacity-50"
          >
            保存
          </button>
        </div>
      </section>

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

      {/* 稼働日数 */}
      <section className="card p-6 mt-6">
        <div className="flex items-center justify-between mb-2 flex-wrap gap-2">
          <h2 className="text-lg font-semibold">稼働日数（月別）</h2>
          <div className="flex items-center gap-2">
            {opFys.length > 0 && (
              <select className="field px-3 py-1.5 text-sm" value={opFy} onChange={(e) => setOpFy(e.target.value)}>
                {opFys.map((y) => <option key={y} value={y}>{y}年度</option>)}
              </select>
            )}
            <button onClick={saveOpDays} disabled={saving}
              className="px-4 py-1.5 bg-[var(--accent)] text-white rounded-md text-sm hover:opacity-90 disabled:opacity-50">保存</button>
          </div>
        </div>
        <p className="text-xs mb-3" style={{ color: 'var(--text-dim)' }}>予実管理の在庫数（＝総客室数 {currentFacility?.total_rooms ?? '-'} × 稼働日数）の算出に使用します。</p>
        <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-6 gap-3">
          {fyMonths(opFy).map((m) => (
            <div key={m}>
              <label className="block text-xs mb-1" style={{ color: 'var(--text-dim)' }}>{m.slice(5)}月（{m.slice(0, 4)}）</label>
              <input type="number" min={0} max={31} className="field px-2 py-1.5 text-sm w-full"
                value={opDays[m] ?? ''}
                onChange={(e) => setOpDays((p) => ({ ...p, [m]: e.target.value === '' ? '' : Number(e.target.value) }))} />
            </div>
          ))}
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

      {/* 生産性手動入力 */}
      <section className="card p-6 mt-6">
        <div className="flex items-center justify-between mb-2 flex-wrap gap-2">
          <h2 className="text-lg font-semibold">生産性 手動入力（月別）</h2>
          <div className="flex items-center gap-2">
            <input type="month" className="field px-3 py-1.5 text-sm" value={prodMonth} onChange={(e) => setProdMonth(e.target.value)} />
            <button onClick={saveProd} disabled={saving}
              className="px-4 py-1.5 bg-[var(--accent)] text-white rounded-md text-sm hover:opacity-90 disabled:opacity-50">保存</button>
          </div>
        </div>
        <p className="text-xs mb-3" style={{ color: 'var(--text-dim)' }}>生産性ページのKPIに反映します（勤怠CSVからは算出できない指標）。</p>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div>
            <label className="block text-sm font-medium mb-1" style={{ color: 'var(--text-dim)' }}>みなし残業超の残業代（円）</label>
            <input type="number" min={0} className="field px-3 py-2 text-sm w-full"
              value={deemedPay} onChange={(e) => setDeemedPay(e.target.value === '' ? '' : Number(e.target.value))} />
          </div>
          <div>
            <label className="block text-sm font-medium mb-1" style={{ color: 'var(--text-dim)' }}>派遣・その他の労働時間（時間）</label>
            <input type="number" min={0} step="0.1" className="field px-3 py-2 text-sm w-full"
              value={dispatchHours} onChange={(e) => setDispatchHours(e.target.value === '' ? '' : Number(e.target.value))} />
          </div>
          <div>
            <label className="block text-sm font-medium mb-1" style={{ color: 'var(--text-dim)' }}>備考</label>
            <input type="text" className="field px-3 py-2 text-sm w-full"
              value={dispatchNotes} onChange={(e) => setDispatchNotes(e.target.value)} />
          </div>
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
