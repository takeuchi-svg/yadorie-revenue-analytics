'use client'

import { useEffect, useState } from 'react'
import { useFacility } from '@/lib/facility-context'
import { supabase } from '@/lib/supabase/client'

interface BudgetRow {
  id?: number
  facility: string
  month: string
  operating_days: number | null
  total_inventory: number | null
  revenue_budget: number | null
  rooms_budget: number | null
  guests_budget: number | null
}

interface OtaRow {
  id?: number
  facility: string
  month: string
  ota: string
  metric: string
  value: number | null
}

const OTA_LIST = ['楽天トラベル', 'じゃらん', '一休', 'Booking.com', 'Expedia', '自社HP'] as const
const OTA_METRICS = [
  { key: 'ad_cost', label: '広告費' },
  { key: 'commission', label: '手数料' },
  { key: 'coupon', label: 'クーポン負担' },
] as const

export default function SettingsPage() {
  const { current, currentFacility } = useFacility()
  const [totalRooms, setTotalRooms] = useState<number | ''>('')
  const [budgets, setBudgets] = useState<BudgetRow[]>([])
  const [otaData, setOtaData] = useState<OtaRow[]>([])
  const [otaMonth, setOtaMonth] = useState(() => {
    const now = new Date()
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
  })
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState('')

  useEffect(() => {
    if (!current) return
    setTotalRooms(currentFacility?.total_rooms ?? '')
    supabase
      .from('dim_budget')
      .select('*')
      .eq('facility', current)
      .order('month')
      .then(({ data }) => setBudgets((data as BudgetRow[]) ?? []))
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

  const addBudgetMonth = () => {
    const lastMonth = budgets.length > 0 ? budgets[budgets.length - 1].month : ''
    let nextMonth = ''
    if (lastMonth) {
      const [y, m] = lastMonth.split('-').map(Number)
      const nm = m === 12 ? 1 : m + 1
      const ny = m === 12 ? y + 1 : y
      nextMonth = `${ny}-${String(nm).padStart(2, '0')}`
    } else {
      const now = new Date()
      nextMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
    }
    setBudgets([...budgets, {
      facility: current,
      month: nextMonth,
      operating_days: null,
      total_inventory: null,
      revenue_budget: null,
      rooms_budget: null,
      guests_budget: null,
    }])
  }

  const updateBudget = (idx: number, field: keyof BudgetRow, value: string) => {
    setBudgets(budgets.map((b, i) =>
      i === idx ? { ...b, [field]: value === '' ? null : Number(value) } : b
    ))
  }

  const saveBudgets = async () => {
    setSaving(true)
    setMessage('')
    const { error } = await supabase
      .from('dim_budget')
      .upsert(budgets.map((b) => ({
        facility: b.facility,
        month: b.month,
        operating_days: b.operating_days,
        total_inventory: b.total_inventory,
        revenue_budget: b.revenue_budget,
        rooms_budget: b.rooms_budget,
        guests_budget: b.guests_budget,
      })), { onConflict: 'facility,month' })
    setMessage(error ? `Error: ${error.message}` : '予算を保存しました')
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
      <h1 className="text-2xl font-bold text-gray-900 mb-6">Settings</h1>

      {/* Facility master */}
      <section className="bg-white rounded-lg shadow p-6 mb-6">
        <h2 className="text-lg font-semibold mb-4">施設マスタ: {currentFacility?.name}</h2>
        <div className="flex items-end gap-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">総客室数</label>
            <input
              type="number"
              className="border border-gray-300 rounded-md px-3 py-2 text-sm w-32"
              value={totalRooms}
              onChange={(e) => setTotalRooms(e.target.value === '' ? '' : Number(e.target.value))}
            />
          </div>
          <button
            onClick={saveFacility}
            disabled={saving}
            className="px-4 py-2 bg-blue-600 text-white rounded-md text-sm hover:bg-blue-700 disabled:opacity-50"
          >
            保存
          </button>
        </div>
      </section>

      {/* Budget */}
      <section className="bg-white rounded-lg shadow p-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold">月別予算</h2>
          <div className="flex gap-2">
            <button
              onClick={addBudgetMonth}
              className="px-3 py-1.5 border border-gray-300 rounded-md text-sm hover:bg-gray-50"
            >
              + 月追加
            </button>
            <button
              onClick={saveBudgets}
              disabled={saving}
              className="px-4 py-1.5 bg-blue-600 text-white rounded-md text-sm hover:bg-blue-700 disabled:opacity-50"
            >
              予算保存
            </button>
          </div>
        </div>

        {budgets.length === 0 ? (
          <p className="text-sm text-gray-400">予算データなし。「+ 月追加」で追加してください。</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-gray-50 border-b text-left text-gray-600">
                  <th className="px-3 py-2">月</th>
                  <th className="px-3 py-2">営業日数</th>
                  <th className="px-3 py-2">供給室数</th>
                  <th className="px-3 py-2">売上予算</th>
                  <th className="px-3 py-2">室数予算</th>
                  <th className="px-3 py-2">客数予算</th>
                </tr>
              </thead>
              <tbody>
                {budgets.map((b, idx) => (
                  <tr key={b.month} className="border-b">
                    <td className="px-3 py-1.5 font-medium">{b.month}</td>
                    {(['operating_days', 'total_inventory', 'revenue_budget', 'rooms_budget', 'guests_budget'] as const).map((field) => (
                      <td key={field} className="px-3 py-1.5">
                        <input
                          type="number"
                          className="border border-gray-200 rounded px-2 py-1 text-sm w-24"
                          value={b[field] ?? ''}
                          onChange={(e) => updateBudget(idx, field, e.target.value)}
                        />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* OTA Marketing */}
      <section className="bg-white rounded-lg shadow p-6 mt-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold">OTAマーケティング費用</h2>
          <div className="flex items-center gap-2">
            <input
              type="month"
              className="border border-gray-300 rounded-md px-3 py-1.5 text-sm"
              value={otaMonth}
              onChange={(e) => setOtaMonth(e.target.value)}
            />
            <button
              onClick={saveOta}
              disabled={saving}
              className="px-4 py-1.5 bg-blue-600 text-white rounded-md text-sm hover:bg-blue-700 disabled:opacity-50"
            >
              保存
            </button>
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-50 border-b text-left text-gray-600">
                <th className="px-3 py-2">OTA</th>
                {OTA_METRICS.map((m) => (
                  <th key={m.key} className="px-3 py-2">{m.label}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {OTA_LIST.map((ota) => (
                <tr key={ota} className="border-b">
                  <td className="px-3 py-1.5 font-medium whitespace-nowrap">{ota}</td>
                  {OTA_METRICS.map((m) => {
                    const row = otaData.find((r) => r.ota === ota && r.metric === m.key)
                    return (
                      <td key={m.key} className="px-3 py-1.5">
                        <input
                          type="number"
                          className="border border-gray-200 rounded px-2 py-1 text-sm w-28"
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

      {message && (
        <p className={`mt-4 text-sm ${message.startsWith('Error') ? 'text-red-600' : 'text-green-600'}`}>
          {message}
        </p>
      )}
    </div>
  )
}
