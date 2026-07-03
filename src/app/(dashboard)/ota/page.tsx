'use client'

import { useState } from 'react'
import { useFacility } from '@/lib/facility-context'
import { supabase } from '@/lib/supabase/client'
import { fetchAll } from '@/lib/supabase/fetch-all'
import { useFacilityData } from '@/lib/use-facility-data'
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell } from 'recharts'
import { fmtYen, CHART_AXIS, chartTooltip, channelColor } from '@/lib/ui'
import { PageHeader, Loading, Empty, LoadError, NotConnected } from '@/components/page-bits'
import type { ChannelRow } from '@/lib/db-types'

const TABS = ['サマリ', '楽天', 'じゃらん', '一休', 'Booking', 'Expedia']

export default function OtaPage() {
  const { current, currentFacility } = useFacility()
  const [month, setMonth] = useState('')
  const [tab, setTab] = useState('サマリ')

  const { data, loading, error } = useFacilityData<ChannelRow[]>((facility) =>
    fetchAll<ChannelRow>(() => supabase.from('mart_channel_monthly').select('month, channel, revenue, rooms').eq('facility', facility)))
  const rows = data ?? []

  const months = [...new Set(rows.map((r) => r.month))].sort().reverse() as string[]
  const activeMonth = month || months[0] || ''
  const monthRows = rows.filter((r) => r.month === activeMonth && (r.revenue ?? 0) > 0)
    .sort((a, b) => (b.revenue || 0) - (a.revenue || 0))
  const chartData = monthRows.map((r) => ({ name: r.channel || 'その他', revenue: r.revenue || 0 }))

  return (
    <div className="p-6">
      <PageHeader title="OTA Marketing" subtitle={currentFacility?.name ?? current} month={activeMonth} months={months} onMonth={setMonth} />

      {/* Sub tabs */}
      <div className="flex gap-1 mb-4 flex-wrap">
        {TABS.map((t) => (
          <button key={t} onClick={() => setTab(t)} className="px-3 py-1.5 rounded-md text-sm"
            style={{ background: tab === t ? 'var(--accent)' : 'var(--surface)', color: tab === t ? '#fff' : 'var(--text-dim)', border: '1px solid var(--border)' }}>
            {t}
          </button>
        ))}
      </div>

      {loading ? <Loading /> : error ? <LoadError message={error} /> : tab !== 'サマリ' ? (
        <NotConnected message={`${tab} の個別指標（PV/CVR/広告費/ランキング等）は将来対応予定です。設定画面のOTAマーケ入力で手動データを登録できます。`} />
      ) : rows.length === 0 ? <Empty /> : (
        <div className="card p-4">
          <h2 className="text-sm font-semibold mb-3">チャネル別予約売上（{activeMonth}）</h2>
          {chartData.length === 0 ? <p className="text-sm py-12 text-center" style={{ color: 'var(--text-dim)' }}>データなし</p> : (
            <ResponsiveContainer width="100%" height={320}>
              <BarChart data={chartData} layout="vertical" margin={{ left: 30 }}>
                <XAxis type="number" {...CHART_AXIS} tickFormatter={(v) => `${Math.round(v / 1e6)}M`} />
                <YAxis type="category" dataKey="name" {...CHART_AXIS} width={90} />
                <Tooltip {...chartTooltip} formatter={(v) => fmtYen(Number(v))} />
                <Bar dataKey="revenue" radius={[0, 4, 4, 0]}>
                  {chartData.map((d, i) => <Cell key={d.name} fill={channelColor(d.name, i)} />)}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          )}
        </div>
      )}
    </div>
  )
}
