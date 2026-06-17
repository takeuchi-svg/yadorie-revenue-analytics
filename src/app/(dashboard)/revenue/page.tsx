'use client'

import { useEffect, useState } from 'react'
import { useFacility } from '@/lib/facility-context'
import { supabase } from '@/lib/supabase/client'
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell,
  ComposedChart, Line, Legend,
} from 'recharts'
import { fmtYen, fmtNum, pct, CHART_AXIS, chartTooltip, channelColor } from '@/lib/ui'
import { Loading, Empty } from '@/components/page-bits'

const TABS = ['チャネル', '客室', 'プラン', '曜日', '喫食', 'GS', 'ADR帯'] as const
type Tab = (typeof TABS)[number]

const DOW_JP: Record<string, string> = { Mon: '月', Tue: '火', Wed: '水', Thu: '木', Fri: '金', Sat: '土', Sun: '日' }
const DOW_ORDER = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
const GS_ORDER = ['1名', '2名', '3名', '4名', '5名以上']
const BAND_ORDER = ['〜¥30K', '¥30-50K', '¥50-70K', '¥70-100K', '¥100K〜']

/* eslint-disable @typescript-eslint/no-explicit-any */
export default function RevenuePage() {
  const { current, currentFacility } = useFacility()
  const [tab, setTab] = useState<Tab>('チャネル')
  const [month, setMonth] = useState('')
  const [loading, setLoading] = useState(true)
  const [data, setData] = useState<Record<string, any[]>>({})

  useEffect(() => {
    if (!current) return
    setLoading(true)
    Promise.all([
      supabase.from('mart_channel_monthly').select('*').eq('facility', current),
      supabase.from('mart_room_monthly').select('*').eq('facility', current),
      supabase.from('mart_plan_monthly').select('*').eq('facility', current),
      supabase.from('mart_daily').select('*').eq('facility', current),
      supabase.from('mart_meal_monthly').select('*').eq('facility', current),
      supabase.from('mart_gs_monthly').select('*').eq('facility', current),
      supabase.from('mart_adr_band_monthly').select('*').eq('facility', current),
    ]).then(([ch, room, plan, daily, meal, gs, adr]) => {
      setData({
        channel: ch.data ?? [], room: room.data ?? [], plan: plan.data ?? [],
        daily: daily.data ?? [], meal: meal.data ?? [], gs: gs.data ?? [], adr: adr.data ?? [],
      })
      const months = [...new Set([...(ch.data ?? []), ...(daily.data ?? [])].map((r: any) => r.month ?? (r.date ? String(r.date).slice(0, 7) : null)).filter(Boolean))].sort().reverse()
      setMonth((m) => m || months[0] || '')
      setLoading(false)
    })
  }, [current])

  const allMonths = [...new Set([
    ...(data.channel ?? []).map((r) => r.month),
    ...(data.daily ?? []).map((r: any) => String(r.date).slice(0, 7)),
  ].filter(Boolean))].sort().reverse()

  return (
    <div className="p-6">
      <div className="flex items-end justify-between mb-4">
        <div>
          <h1 className="text-2xl font-bold mb-1">Revenue</h1>
          <p className="text-sm" style={{ color: 'var(--text-dim)' }}>{currentFacility?.name ?? current}</p>
        </div>
        {allMonths.length > 0 && (
          <select className="field px-3 py-1.5 text-sm" value={month} onChange={(e) => setMonth(e.target.value)}>
            {allMonths.map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
        )}
      </div>

      {/* Tabs */}
      <div className="flex gap-1 mb-5 flex-wrap">
        {TABS.map((t) => (
          <button key={t} onClick={() => setTab(t)} className="px-3 py-1.5 rounded-md text-sm"
            style={{ background: tab === t ? 'var(--accent)' : 'var(--surface)', color: tab === t ? '#fff' : 'var(--text-dim)', border: '1px solid var(--border)' }}>
            {t}
          </button>
        ))}
      </div>

      {loading ? <Loading /> : (
        <>
          {tab === 'チャネル' && <ChannelTab rows={(data.channel ?? []).filter((r) => r.month === month)} />}
          {tab === '客室' && <RoomTab rows={(data.room ?? []).filter((r) => r.month === month)} />}
          {tab === 'プラン' && <PlanTab rows={(data.plan ?? []).filter((r) => r.month === month)} />}
          {tab === '曜日' && <DowTab rows={(data.daily ?? []).filter((r: any) => String(r.date).slice(0, 7) === month)} />}
          {tab === '喫食' && <MealTab rows={(data.meal ?? []).filter((r) => r.month === month)} />}
          {tab === 'GS' && <GsTab rows={(data.gs ?? []).filter((r) => r.month === month)} />}
          {tab === 'ADR帯' && <AdrBandTab rows={(data.adr ?? []).filter((r) => r.month === month)} />}
        </>
      )}
    </div>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="card p-4 mb-4">
      <h2 className="text-sm font-semibold mb-3">{title}</h2>
      {children}
    </div>
  )
}

function TableShell({ headers, children }: { headers: string[]; children: React.ReactNode }) {
  return (
    <div className="card overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr style={{ background: 'var(--surface2)', color: 'var(--text-dim)' }} className="text-left">
            {headers.map((h, i) => <th key={i} className={`px-4 py-3 ${i > 0 ? 'text-right' : ''}`}>{h}</th>)}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  )
}

/* ---- チャネル ---- */
function ChannelTab({ rows }: { rows: any[] }) {
  if (rows.length === 0) return <Empty message="この月のデータがありません" />
  const total = rows.reduce((s, r) => s + (r.revenue || 0), 0)
  const sorted = [...rows].sort((a, b) => (b.revenue || 0) - (a.revenue || 0))
  const chart = sorted.map((r) => ({ name: r.channel || 'その他', revenue: r.revenue || 0 }))
  return (
    <>
      <Section title="チャネル別売上">
        <ResponsiveContainer width="100%" height={260}>
          <BarChart data={chart} layout="vertical" margin={{ left: 20 }}>
            <XAxis type="number" {...CHART_AXIS} tickFormatter={(v) => `${Math.round(v / 1e6)}M`} />
            <YAxis type="category" dataKey="name" {...CHART_AXIS} width={90} />
            <Tooltip {...chartTooltip} formatter={(v) => fmtYen(Number(v))} />
            <Bar dataKey="revenue" radius={[0, 4, 4, 0]}>
              {chart.map((d, i) => <Cell key={i} fill={channelColor(d.name, i)} />)}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </Section>
      <TableShell headers={['チャネル', '売上', '構成比', '室数', '客数', 'ADR', '客単価']}>
        {sorted.map((r, i) => (
          <tr key={i} style={{ borderTop: '1px solid var(--border)' }}>
            <td className="px-4 py-2 font-medium">{r.channel || '不明'}</td>
            <td className="px-4 py-2 text-right">{fmtNum(r.revenue)}</td>
            <td className="px-4 py-2 text-right" style={{ color: 'var(--text-dim)' }}>{total > 0 ? pct((r.revenue || 0) / total) : '-'}</td>
            <td className="px-4 py-2 text-right">{fmtNum(r.rooms)}</td>
            <td className="px-4 py-2 text-right">{fmtNum(r.guests)}</td>
            <td className="px-4 py-2 text-right">{fmtNum(r.adr)}</td>
            <td className="px-4 py-2 text-right">{fmtNum(r.guest_unit)}</td>
          </tr>
        ))}
      </TableShell>
    </>
  )
}

/* ---- 客室 ---- */
function RoomTab({ rows }: { rows: any[] }) {
  if (rows.length === 0) return <Empty message="この月のデータがありません" />
  const sorted = [...rows].sort((a, b) => (b.revenue || 0) - (a.revenue || 0))
  const chart = sorted.map((r) => ({ name: r.room || '不明', revenue: r.revenue || 0 }))
  return (
    <>
      <Section title="客室別売上">
        <ResponsiveContainer width="100%" height={Math.max(220, chart.length * 32)}>
          <BarChart data={chart} layout="vertical" margin={{ left: 30 }}>
            <XAxis type="number" {...CHART_AXIS} tickFormatter={(v) => `${Math.round(v / 1e6)}M`} />
            <YAxis type="category" dataKey="name" {...CHART_AXIS} width={110} />
            <Tooltip {...chartTooltip} formatter={(v) => fmtYen(Number(v))} />
            <Bar dataKey="revenue" fill="var(--accent)" radius={[0, 4, 4, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </Section>
      <TableShell headers={['客室', '売上', '室数', '客数', 'ADR', '同伴']}>
        {sorted.map((r, i) => (
          <tr key={i} style={{ borderTop: '1px solid var(--border)' }}>
            <td className="px-4 py-2 font-medium">{r.room || '不明'}</td>
            <td className="px-4 py-2 text-right">{fmtNum(r.revenue)}</td>
            <td className="px-4 py-2 text-right">{fmtNum(r.rooms_sold)}</td>
            <td className="px-4 py-2 text-right">{fmtNum(r.guests)}</td>
            <td className="px-4 py-2 text-right">{fmtNum(r.adr)}</td>
            <td className="px-4 py-2 text-right">{r.companion?.toFixed(2) ?? '-'}</td>
          </tr>
        ))}
      </TableShell>
    </>
  )
}

/* ---- プラン ---- */
function PlanTab({ rows }: { rows: any[] }) {
  if (rows.length === 0) return <Empty message="この月のデータがありません（プランはLincoln予約由来）" />
  const sorted = [...rows].sort((a, b) => (b.revenue || 0) - (a.revenue || 0)).slice(0, 15)
  const chart = sorted.map((r) => ({ name: (r.plan || '不明').slice(0, 18), revenue: r.revenue || 0 }))
  return (
    <>
      <Section title="プラン別売上 TOP15">
        <ResponsiveContainer width="100%" height={Math.max(240, chart.length * 30)}>
          <BarChart data={chart} layout="vertical" margin={{ left: 30 }}>
            <XAxis type="number" {...CHART_AXIS} tickFormatter={(v) => `${Math.round(v / 1e6)}M`} />
            <YAxis type="category" dataKey="name" {...CHART_AXIS} width={140} tick={{ fill: '#8b8fa3', fontSize: 10 }} />
            <Tooltip {...chartTooltip} formatter={(v) => fmtYen(Number(v))} />
            <Bar dataKey="revenue" fill="var(--accent)" radius={[0, 4, 4, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </Section>
      <TableShell headers={['プラン', '予約数', '売上', '室数', 'ADR']}>
        {sorted.map((r, i) => (
          <tr key={i} style={{ borderTop: '1px solid var(--border)' }}>
            <td className="px-4 py-2">{r.plan || '不明'}</td>
            <td className="px-4 py-2 text-right">{fmtNum(r.bookings)}</td>
            <td className="px-4 py-2 text-right">{fmtNum(r.revenue)}</td>
            <td className="px-4 py-2 text-right">{fmtNum(r.rooms_total)}</td>
            <td className="px-4 py-2 text-right">{fmtNum(r.adr)}</td>
          </tr>
        ))}
      </TableShell>
    </>
  )
}

/* ---- 曜日 ---- */
function DowTab({ rows }: { rows: any[] }) {
  if (rows.length === 0) return <Empty message="この月のデータがありません" />
  const agg = DOW_ORDER.map((dow) => {
    const days = rows.filter((r) => r.dow === dow)
    const revenue = days.reduce((s, r) => s + (r.revenue || 0), 0)
    const rooms = days.reduce((s, r) => s + (r.rooms_sold || 0), 0)
    return { name: DOW_JP[dow] ?? dow, revenue, adr: rooms > 0 ? Math.round(revenue / rooms) : 0 }
  })
  return (
    <Section title="曜日別 売上 + ADR">
      <ResponsiveContainer width="100%" height={300}>
        <ComposedChart data={agg}>
          <XAxis dataKey="name" {...CHART_AXIS} />
          <YAxis yAxisId="l" {...CHART_AXIS} tickFormatter={(v) => `${Math.round(v / 1e6)}M`} />
          <YAxis yAxisId="r" orientation="right" {...CHART_AXIS} tickFormatter={(v) => `${Math.round(v / 1000)}k`} />
          <Tooltip {...chartTooltip} formatter={(v) => fmtYen(Number(v))} />
          <Legend wrapperStyle={{ fontSize: 11 }} />
          <Bar yAxisId="l" dataKey="revenue" name="売上" fill="var(--accent)" radius={[4, 4, 0, 0]} />
          <Line yAxisId="r" dataKey="adr" name="ADR" stroke="var(--yellow)" strokeWidth={2} dot={{ r: 3 }} />
        </ComposedChart>
      </ResponsiveContainer>
    </Section>
  )
}

/* ---- 喫食 ---- */
function MealTab({ rows }: { rows: any[] }) {
  if (rows.length === 0) return <Empty message="この月のデータがありません" />
  const sorted = [...rows].sort((a, b) => (b.guests || 0) - (a.guests || 0))
  return (
    <TableShell headers={['喫食タイプ', '人数', '客単価']}>
      {sorted.map((r, i) => (
        <tr key={i} style={{ borderTop: '1px solid var(--border)' }}>
          <td className="px-4 py-2 font-medium">{r.meal_type || '不明'}</td>
          <td className="px-4 py-2 text-right">{fmtNum(r.guests)}</td>
          <td className="px-4 py-2 text-right">{fmtNum(r.guest_unit)}</td>
        </tr>
      ))}
    </TableShell>
  )
}

/* ---- GS ---- */
function GsTab({ rows }: { rows: any[] }) {
  if (rows.length === 0) return <Empty message="この月のデータがありません" />
  const ordered = GS_ORDER.map((g) => rows.find((r) => r.group_size === g)).filter(Boolean) as any[]
  const chart = ordered.map((r) => ({ name: r.group_size, revenue: r.revenue || 0 }))
  return (
    <>
      <Section title="グループサイズ別売上">
        <ResponsiveContainer width="100%" height={240}>
          <BarChart data={chart}>
            <XAxis dataKey="name" {...CHART_AXIS} />
            <YAxis {...CHART_AXIS} tickFormatter={(v) => `${Math.round(v / 1e6)}M`} />
            <Tooltip {...chartTooltip} formatter={(v) => fmtYen(Number(v))} />
            <Bar dataKey="revenue" fill="var(--accent)" radius={[4, 4, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </Section>
      <TableShell headers={['グループサイズ', '予約数', '売上', '室数', 'ADR']}>
        {ordered.map((r, i) => (
          <tr key={i} style={{ borderTop: '1px solid var(--border)' }}>
            <td className="px-4 py-2 font-medium">{r.group_size}</td>
            <td className="px-4 py-2 text-right">{fmtNum(r.bookings)}</td>
            <td className="px-4 py-2 text-right">{fmtNum(r.revenue)}</td>
            <td className="px-4 py-2 text-right">{fmtNum(r.rooms_total)}</td>
            <td className="px-4 py-2 text-right">{fmtNum(r.adr)}</td>
          </tr>
        ))}
      </TableShell>
    </>
  )
}

/* ---- ADR帯 ---- */
function AdrBandTab({ rows }: { rows: any[] }) {
  if (rows.length === 0) return <Empty message="この月のデータがありません" />
  const ordered = BAND_ORDER.map((b) => rows.find((r) => r.band === b)).filter(Boolean) as any[]
  const chart = ordered.map((r) => ({ name: r.band, bookings: r.bookings || 0, adr: r.adr || 0 }))
  return (
    <>
      <Section title="ADR帯 分布">
        <ResponsiveContainer width="100%" height={260}>
          <ComposedChart data={chart}>
            <XAxis dataKey="name" {...CHART_AXIS} />
            <YAxis yAxisId="l" {...CHART_AXIS} allowDecimals={false} />
            <YAxis yAxisId="r" orientation="right" {...CHART_AXIS} tickFormatter={(v) => `${Math.round(v / 1000)}k`} />
            <Tooltip {...chartTooltip} />
            <Legend wrapperStyle={{ fontSize: 11 }} />
            <Bar yAxisId="l" dataKey="bookings" name="予約数" fill="var(--accent)" radius={[4, 4, 0, 0]} />
            <Line yAxisId="r" dataKey="adr" name="ADR" stroke="var(--yellow)" strokeWidth={2} dot={{ r: 3 }} />
          </ComposedChart>
        </ResponsiveContainer>
      </Section>
      <TableShell headers={['ADR帯', '予約数', '売上', '室数', 'ADR']}>
        {ordered.map((r, i) => (
          <tr key={i} style={{ borderTop: '1px solid var(--border)' }}>
            <td className="px-4 py-2 font-medium">{r.band}</td>
            <td className="px-4 py-2 text-right">{fmtNum(r.bookings)}</td>
            <td className="px-4 py-2 text-right">{fmtNum(r.revenue)}</td>
            <td className="px-4 py-2 text-right">{fmtNum(r.rooms_total)}</td>
            <td className="px-4 py-2 text-right">{fmtNum(r.adr)}</td>
          </tr>
        ))}
      </TableShell>
    </>
  )
}
