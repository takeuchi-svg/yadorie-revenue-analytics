'use client'

import { useEffect, useMemo, useState } from 'react'
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
const LINCOLN_TABS: Tab[] = ['プラン', '曜日', 'GS', 'ADR帯'] // 予約/CI日トグル対象

const DOW_JP: Record<string, string> = { Mon: '月', Tue: '火', Wed: '水', Thu: '木', Fri: '金', Sat: '土', Sun: '日' }
const GS_ORDER = ['1名', '2名', '3名', '4名', '5名以上']
const BAND_ORDER = ['〜¥30K', '¥30-50K', '¥50-70K', '¥70-100K', '¥100K〜']

/* eslint-disable @typescript-eslint/no-explicit-any */

interface Ev { checkin: string | null; received_at: string | null; plan: string | null; rooms: number | null; guests_total: number | null; amount_gross: number | null }

export default function RevenuePage() {
  const { current, currentFacility } = useFacility()
  const [tab, setTab] = useState<Tab>('チャネル')
  const [basis, setBasis] = useState<'ci' | 'booking'>('ci')
  const [month, setMonth] = useState('')
  const [loading, setLoading] = useState(true)
  const [data, setData] = useState<Record<string, any[]>>({})
  const [events, setEvents] = useState<Ev[]>([])

  useEffect(() => {
    if (!current) return
    setLoading(true)
    Promise.all([
      supabase.from('mart_channel_monthly').select('*').eq('facility', current),
      supabase.from('mart_room_monthly').select('*').eq('facility', current),
      supabase.from('mart_meal_monthly').select('*').eq('facility', current),
      supabase.from('raw_booking_event').select('checkin, received_at, plan, rooms, guests_total, amount_gross')
        .eq('facility', current).eq('event_type', '予約').limit(20000),
    ]).then(([ch, room, meal, ev]) => {
      setData({ channel: ch.data ?? [], room: room.data ?? [], meal: meal.data ?? [] })
      setEvents((ev.data as Ev[]) ?? [])
      setLoading(false)
    })
  }, [current])

  const isLincoln = LINCOLN_TABS.includes(tab)
  const dateField: keyof Ev = basis === 'ci' ? 'checkin' : 'received_at'

  // 月リスト（タブと基準で変わる）
  const months = useMemo(() => {
    let ms: string[]
    if (isLincoln) {
      ms = events.map((e) => (e[dateField] as string | null)?.slice(0, 7)).filter(Boolean) as string[]
    } else {
      const src = tab === 'チャネル' ? data.channel : tab === '客室' ? data.room : data.meal
      ms = (src ?? []).map((r: any) => r.month).filter(Boolean)
    }
    return [...new Set(ms)].sort().reverse()
  }, [isLincoln, dateField, events, tab, data])

  // 月が現在リストに無ければ最新へ
  useEffect(() => {
    if (months.length > 0 && !months.includes(month)) setMonth(months[0])
  }, [months, month])

  const monthEvents = useMemo(
    () => events.filter((e) => (e[dateField] as string | null)?.slice(0, 7) === month),
    [events, dateField, month]
  )

  return (
    <div className="p-6">
      <div className="flex items-end justify-between mb-4 flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold mb-1">Revenue</h1>
          <p className="text-sm" style={{ color: 'var(--text-dim)' }}>{currentFacility?.name ?? current}</p>
        </div>
        <div className="flex items-center gap-3">
          {/* CI/予約日 トグル */}
          <div className="flex rounded-md overflow-hidden" style={{ border: '1px solid var(--border)', opacity: isLincoln ? 1 : 0.4 }}>
            {(['ci', 'booking'] as const).map((b) => (
              <button key={b} disabled={!isLincoln} onClick={() => setBasis(b)}
                className="px-3 py-1.5 text-xs"
                style={{ background: basis === b ? 'var(--accent)' : 'var(--surface)', color: basis === b ? '#fff' : 'var(--text-dim)', cursor: isLincoln ? 'pointer' : 'not-allowed' }}>
                {b === 'ci' ? 'CI日ベース' : '予約日ベース'}
              </button>
            ))}
          </div>
          {months.length > 0 && (
            <select className="field px-3 py-1.5 text-sm" value={month} onChange={(e) => setMonth(e.target.value)}>
              {months.map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
          )}
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 mb-2 flex-wrap">
        {TABS.map((t) => (
          <button key={t} onClick={() => setTab(t)} className="px-3 py-1.5 rounded-md text-sm"
            style={{ background: tab === t ? 'var(--accent)' : 'var(--surface)', color: tab === t ? '#fff' : 'var(--text-dim)', border: '1px solid var(--border)' }}>
            {t}
          </button>
        ))}
      </div>
      <p className="text-xs mb-4" style={{ color: 'var(--text-dim)' }}>
        {isLincoln
          ? `${basis === 'ci' ? 'CI日（チェックイン月）' : '予約日（受信月）'}ベース・Lincoln予約データ`
          : 'CI日（チェックイン月）ベース・PMS予約データ（このタブは日付基準の切替なし）'}
      </p>

      {loading ? <Loading /> : (
        <>
          {tab === 'チャネル' && <ChannelTab rows={(data.channel ?? []).filter((r) => r.month === month)} />}
          {tab === '客室' && <RoomTab rows={(data.room ?? []).filter((r) => r.month === month)} />}
          {tab === '喫食' && <MealTab rows={(data.meal ?? []).filter((r) => r.month === month)} />}
          {tab === 'プラン' && <PlanTab events={monthEvents} />}
          {tab === '曜日' && <DowTab events={monthEvents} dateField={dateField} />}
          {tab === 'GS' && <GsTab events={monthEvents} />}
          {tab === 'ADR帯' && <AdrBandTab events={monthEvents} />}
        </>
      )}
    </div>
  )
}

/* ---- 共通 ---- */
function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return <div className="card p-4 mb-4"><h2 className="text-sm font-semibold mb-3">{title}</h2>{children}</div>
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
const gsLabel = (g: number) => (g <= 1 ? '1名' : g >= 5 ? '5名以上' : `${g}名`)
const bandLabel = (adr: number) =>
  adr < 30000 ? '〜¥30K' : adr < 50000 ? '¥30-50K' : adr < 70000 ? '¥50-70K' : adr < 100000 ? '¥70-100K' : '¥100K〜'

/* ---- チャネル（PMS, CI固定）---- */
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

/* ---- 客室（PMS, CI固定）---- */
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

/* ---- 喫食（PMS, CI固定）---- */
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

/* ---- プラン（Lincoln, トグル対象）---- */
function PlanTab({ events }: { events: Ev[] }) {
  if (events.length === 0) return <Empty message="この月のデータがありません" />
  const map = new Map<string, { revenue: number; rooms: number; guests: number; bookings: number }>()
  for (const e of events) {
    const k = e.plan || '不明'
    const g = map.get(k) ?? { revenue: 0, rooms: 0, guests: 0, bookings: 0 }
    g.revenue += e.amount_gross || 0; g.rooms += e.rooms || 0; g.guests += e.guests_total || 0; g.bookings += 1
    map.set(k, g)
  }
  const rows = [...map.entries()].map(([plan, v]) => ({ plan, ...v, adr: v.rooms > 0 ? Math.round(v.revenue / v.rooms) : 0 }))
    .sort((a, b) => b.revenue - a.revenue).slice(0, 15)
  const chart = rows.map((r) => ({ name: r.plan.slice(0, 18), revenue: r.revenue }))
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
        {rows.map((r, i) => (
          <tr key={i} style={{ borderTop: '1px solid var(--border)' }}>
            <td className="px-4 py-2">{r.plan}</td>
            <td className="px-4 py-2 text-right">{fmtNum(r.bookings)}</td>
            <td className="px-4 py-2 text-right">{fmtNum(r.revenue)}</td>
            <td className="px-4 py-2 text-right">{fmtNum(r.rooms)}</td>
            <td className="px-4 py-2 text-right">{fmtNum(r.adr)}</td>
          </tr>
        ))}
      </TableShell>
    </>
  )
}

/* ---- 曜日（Lincoln, トグル対象）---- */
function DowTab({ events, dateField }: { events: Ev[]; dateField: keyof Ev }) {
  if (events.length === 0) return <Empty message="この月のデータがありません" />
  const order = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
  const acc: Record<string, { revenue: number; rooms: number }> = {}
  for (const e of events) {
    const ds = e[dateField] as string | null
    if (!ds) continue
    const d = new Date(ds + 'T00:00:00')
    const key = order[(d.getDay() + 6) % 7] // Mon=0
    const g = acc[key] ?? { revenue: 0, rooms: 0 }
    g.revenue += e.amount_gross || 0; g.rooms += e.rooms || 0
    acc[key] = g
  }
  const agg = order.map((dow) => {
    const g = acc[dow] ?? { revenue: 0, rooms: 0 }
    return { name: DOW_JP[dow], revenue: g.revenue, adr: g.rooms > 0 ? Math.round(g.revenue / g.rooms) : 0 }
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

/* ---- GS（Lincoln, トグル対象）---- */
function GsTab({ events }: { events: Ev[] }) {
  if (events.length === 0) return <Empty message="この月のデータがありません" />
  const map = new Map<string, { revenue: number; rooms: number; bookings: number }>()
  for (const e of events) {
    const gs = gsLabel(Math.round((e.guests_total || 0) / Math.max(e.rooms || 1, 1)))
    const g = map.get(gs) ?? { revenue: 0, rooms: 0, bookings: 0 }
    g.revenue += e.amount_gross || 0; g.rooms += e.rooms || 0; g.bookings += 1
    map.set(gs, g)
  }
  const rows = GS_ORDER.map((gs) => {
    const v = map.get(gs); if (!v) return null
    return { group_size: gs, ...v, adr: v.rooms > 0 ? Math.round(v.revenue / v.rooms) : 0 }
  }).filter(Boolean) as any[]
  const chart = rows.map((r) => ({ name: r.group_size, revenue: r.revenue }))
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
        {rows.map((r, i) => (
          <tr key={i} style={{ borderTop: '1px solid var(--border)' }}>
            <td className="px-4 py-2 font-medium">{r.group_size}</td>
            <td className="px-4 py-2 text-right">{fmtNum(r.bookings)}</td>
            <td className="px-4 py-2 text-right">{fmtNum(r.revenue)}</td>
            <td className="px-4 py-2 text-right">{fmtNum(r.rooms)}</td>
            <td className="px-4 py-2 text-right">{fmtNum(r.adr)}</td>
          </tr>
        ))}
      </TableShell>
    </>
  )
}

/* ---- ADR帯（Lincoln, トグル対象）---- */
function AdrBandTab({ events }: { events: Ev[] }) {
  if (events.length === 0) return <Empty message="この月のデータがありません" />
  const map = new Map<string, { revenue: number; rooms: number; bookings: number }>()
  for (const e of events) {
    if (!e.rooms || e.rooms <= 0) continue
    const band = bandLabel((e.amount_gross || 0) / e.rooms)
    const g = map.get(band) ?? { revenue: 0, rooms: 0, bookings: 0 }
    g.revenue += e.amount_gross || 0; g.rooms += e.rooms || 0; g.bookings += 1
    map.set(band, g)
  }
  const rows = BAND_ORDER.map((band) => {
    const v = map.get(band); if (!v) return null
    return { band, ...v, adr: v.rooms > 0 ? Math.round(v.revenue / v.rooms) : 0 }
  }).filter(Boolean) as any[]
  const chart = rows.map((r) => ({ name: r.band, bookings: r.bookings, adr: r.adr }))
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
        {rows.map((r, i) => (
          <tr key={i} style={{ borderTop: '1px solid var(--border)' }}>
            <td className="px-4 py-2 font-medium">{r.band}</td>
            <td className="px-4 py-2 text-right">{fmtNum(r.bookings)}</td>
            <td className="px-4 py-2 text-right">{fmtNum(r.revenue)}</td>
            <td className="px-4 py-2 text-right">{fmtNum(r.rooms)}</td>
            <td className="px-4 py-2 text-right">{fmtNum(r.adr)}</td>
          </tr>
        ))}
      </TableShell>
    </>
  )
}
