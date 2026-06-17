'use client'

import { useEffect, useState } from 'react'
import { useFacility } from '@/lib/facility-context'
import { supabase } from '@/lib/supabase/client'

interface ChannelRow {
  channel: string | null
  revenue: number | null
  rooms: number | null
  guests: number | null
  adr: number | null
  guest_unit: number | null
}

function fmt(n: number | null | undefined): string {
  if (n === null || n === undefined) return '-'
  return Math.round(n).toLocaleString()
}

export default function RevenuePage() {
  const { current, currentFacility } = useFacility()
  const [channels, setChannels] = useState<ChannelRow[]>([])
  const [months, setMonths] = useState<string[]>([])
  const [selectedMonth, setSelectedMonth] = useState('')
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!current) return
    supabase
      .from('mart_channel_monthly')
      .select('month')
      .eq('facility', current)
      .order('month', { ascending: false })
      .then(({ data }) => {
        const unique = [...new Set((data ?? []).map((r) => r.month))]
        setMonths(unique)
        if (unique.length > 0 && !selectedMonth) setSelectedMonth(unique[0])
      })
  }, [current, selectedMonth])

  useEffect(() => {
    if (!current || !selectedMonth) {
      setLoading(false)
      return
    }
    setLoading(true)
    supabase
      .from('mart_channel_monthly')
      .select('*')
      .eq('facility', current)
      .eq('month', selectedMonth)
      .order('revenue', { ascending: false })
      .then(({ data }) => {
        setChannels((data as ChannelRow[]) ?? [])
        setLoading(false)
      })
  }, [current, selectedMonth])

  const totalRevenue = channels.reduce((s, c) => s + (c.revenue ?? 0), 0)

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold">Revenue</h1>
          <p className="text-sm" style={{ color: 'var(--text-dim)' }}>{currentFacility?.name ?? current}</p>
        </div>
        <select
          className="field px-3 py-1.5 text-sm"
          value={selectedMonth}
          onChange={(e) => setSelectedMonth(e.target.value)}
        >
          {months.map((m) => (
            <option key={m} value={m}>{m}</option>
          ))}
        </select>
      </div>

      {loading ? (
        <p style={{ color: 'var(--text-dim)' }}>読み込み中...</p>
      ) : channels.length === 0 ? (
        <div className="card p-6 text-center" style={{ borderColor: 'var(--yellow)' }}>
          <p className="font-medium" style={{ color: 'var(--yellow)' }}>データ未登録</p>
        </div>
      ) : (
        <div className="card overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr style={{ background: 'var(--surface2)', color: 'var(--text-dim)' }} className="text-left">
                <th className="px-4 py-3">チャネル</th>
                <th className="px-4 py-3 text-right">売上</th>
                <th className="px-4 py-3 text-right">構成比</th>
                <th className="px-4 py-3 text-right">室数</th>
                <th className="px-4 py-3 text-right">客数</th>
                <th className="px-4 py-3 text-right">ADR</th>
                <th className="px-4 py-3 text-right">客単価</th>
              </tr>
            </thead>
            <tbody>
              {channels.map((row, i) => (
                <tr key={i} style={{ borderTop: '1px solid var(--border)' }}>
                  <td className="px-4 py-2 font-medium">{row.channel ?? '不明'}</td>
                  <td className="px-4 py-2 text-right">{fmt(row.revenue)}</td>
                  <td className="px-4 py-2 text-right" style={{ color: 'var(--text-dim)' }}>
                    {totalRevenue > 0
                      ? ((((row.revenue ?? 0) / totalRevenue) * 100).toFixed(1) + '%')
                      : '-'}
                  </td>
                  <td className="px-4 py-2 text-right">{fmt(row.rooms)}</td>
                  <td className="px-4 py-2 text-right">{fmt(row.guests)}</td>
                  <td className="px-4 py-2 text-right">{fmt(row.adr)}</td>
                  <td className="px-4 py-2 text-right">{fmt(row.guest_unit)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
