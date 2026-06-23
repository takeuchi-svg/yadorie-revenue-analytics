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

const OTA_LIST = ['楽天トラベル', 'じゃらん', '一休', 'Booking.com', 'Expedia', '自社HP'] as const
const OTA_METRICS = [
  { key: 'ad_cost', label: '広告費' },
  { key: 'commission', label: '手数料' },
  { key: 'coupon', label: 'クーポン負担' },
] as const

export default function SettingsPage() {
  const { current, currentFacility, isAdmin } = useFacility()
  const [totalRooms, setTotalRooms] = useState<number | ''>('')
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
      <h1 className="text-2xl font-bold mb-6">Settings</h1>

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
