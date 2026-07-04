'use client'

import { useEffect, useMemo, useState } from 'react'
import { useFacility } from '@/lib/facility-context'
import { supabase } from '@/lib/supabase/client'
import { fetchAll } from '@/lib/supabase/fetch-all'
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell,
  ComposedChart, Line, Legend,
} from 'recharts'
import { fmtYen, fmtNum, pct, CHART_AXIS, chartTooltip, channelColor } from '@/lib/ui'
import { Loading, Empty, LoadError } from '@/components/page-bits'

const TABS = ['チャネル', '客室', '居住地', 'プラン', '曜日', '喫食', 'GS', 'ADR帯'] as const
type Tab = (typeof TABS)[number]
const LINCOLN_TABS: Tab[] = ['プラン', '曜日', 'GS', 'ADR帯']
const MEAL_ORDER = ['2食付', '朝食付', '夕食のみ', '素泊り', 'その他']

const DOW_JP: Record<string, string> = { Mon: '月', Tue: '火', Wed: '水', Thu: '木', Fri: '金', Sat: '土', Sun: '日' }
const DOW_ORDER = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
const GS_ORDER = ['1名', '2名', '3名', '4名', '5名以上']
const BAND_ORDER = ['〜¥30,000', '¥30,000–50,000', '¥50,000–70,000', '¥70,000–100,000', '¥100,000〜']

/* eslint-disable @typescript-eslint/no-explicit-any */
interface Ev { checkin: string | null; received_at: string | null; plan: string | null; rooms: number | null; guests_total: number | null; amount_gross: number | null; nights: number | null }
interface Resv { checkin: string | null; prefecture: string | null; revenue_settled: number | null; nights: number | null; guests_total: number | null }
interface Row { name: string; revenue: number; rooms: number; guests: number; count?: number }


const gsLabel = (g: number) => (g <= 1 ? '1名' : g >= 5 ? '5名以上' : `${g}名`)
const bandLabel = (adr: number) =>
  adr < 30000 ? '〜¥30,000' : adr < 50000 ? '¥30,000–50,000' : adr < 70000 ? '¥50,000–70,000' : adr < 100000 ? '¥70,000–100,000' : '¥100,000〜'
const yenAxis = (v: any) => Number(v).toLocaleString()

export default function RevenuePage() {
  const { current, currentFacility } = useFacility()
  const [tab, setTab] = useState<Tab>('チャネル')
  const [basis, setBasis] = useState<'ci' | 'booking'>('ci')
  const [month, setMonth] = useState('')
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [data, setData] = useState<Record<string, any[]>>({})
  const [events, setEvents] = useState<Ev[]>([])
  const [resv, setResv] = useState<Resv[]>([])
  const [capByType, setCapByType] = useState<Record<string, number>>({})

  useEffect(() => {
    if (!current) return
    setLoading(true)
    Promise.all([
      supabase.from('mart_channel_monthly').select('*').eq('facility', current),
      supabase.from('mart_room_monthly').select('*').eq('facility', current),
      supabase.from('mart_room_type_monthly').select('*').eq('facility', current),
      supabase.from('mart_meal_monthly').select('*').eq('facility', current),
      fetchAll(() => supabase.from('raw_booking_event').select('checkin, received_at, plan, rooms, guests_total, amount_gross, nights')
        .eq('facility', current).eq('event_type', '予約').order('id')),
      fetchAll(() => supabase.from('raw_reservation').select('checkin, prefecture, revenue_settled, nights, guests_total')
        .eq('facility', current).eq('status', 'C/O').order('id')),
      fetchAll(() => supabase.from('raw_room_sales').select('room_type, sold, stay_date').eq('facility', current).eq('scope', 'type').order('id')),
    ]).then(([ch, room, rtype, meal, ev, rv, rsType]) => {
      setData({ channel: ch.data ?? [], room: room.data ?? [], rtype: rtype.data ?? [], meal: meal.data ?? [] })
      setEvents((ev as Ev[]) ?? [])
      setResv((rv as Resv[]) ?? [])
      // 部屋タイプ別 室数（=日次最大販売室数の推定）
      const cap: Record<string, number> = {}
      ;(rsType as any[]).forEach((r) => { cap[r.room_type] = Math.max(cap[r.room_type] || 0, Number(r.sold) || 0) })
      setCapByType(cap)
    }).catch((e) => setLoadError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false))
  }, [current])

  const isLincoln = LINCOLN_TABS.includes(tab)
  const dateField: keyof Ev = basis === 'ci' ? 'checkin' : 'received_at'

  const months = useMemo(() => {
    let ms: string[]
    if (isLincoln) {
      ms = events.map((e) => (e[dateField] as string | null)?.slice(0, 7)).filter(Boolean) as string[]
    } else {
      // PMS系タブは全ソースの月を統合
      ms = [
        ...(data.channel ?? []), ...(data.room ?? []), ...(data.meal ?? []),
      ].map((r: any) => r.month).filter(Boolean)
      ms = ms.concat(resv.map((r) => r.checkin?.slice(0, 7)).filter(Boolean) as string[])
    }
    return [...new Set(ms)].sort().reverse()
  }, [isLincoln, dateField, events, data, resv])

  useEffect(() => { if (months.length > 0 && !months.includes(month)) setMonth(months[0]) }, [months, month])

  const monthEvents = useMemo(
    () => events.filter((e) => (e[dateField] as string | null)?.slice(0, 7) === month),
    [events, dateField, month]
  )
  const residenceRows = useMemo(() => {
    const m = new Map<string, Row>()
    for (const r of resv) {
      if (r.checkin?.slice(0, 7) !== month) continue
      const k = r.prefecture || '不明'
      const g = m.get(k) ?? { name: k, revenue: 0, rooms: 0, guests: 0 }
      // rooms=室泊(1予約行=1部屋×泊数), guests=人泊
      g.revenue += r.revenue_settled || 0; g.rooms += r.nights || 0
      g.guests += (r.guests_total || 0) * Math.max(r.nights ?? 1, 1)
      m.set(k, g)
    }
    return [...m.values()].sort((a, b) => b.revenue - a.revenue)
  }, [resv, month])

  return (
    <div className="p-6">
      <div className="flex items-end justify-between mb-4 flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold mb-1">Revenue</h1>
          <p className="text-sm" style={{ color: 'var(--text-dim)' }}>{currentFacility?.name ?? current}</p>
        </div>
        <div className="flex items-center gap-3">
          <div className="flex rounded-md overflow-hidden" style={{ border: '1px solid var(--border)', opacity: isLincoln ? 1 : 0.4 }}>
            {(['ci', 'booking'] as const).map((b) => (
              <button key={b} disabled={!isLincoln} onClick={() => setBasis(b)} className="px-3 py-1.5 text-xs"
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

      {loading ? <Loading /> : loadError ? <LoadError message={loadError} /> : (
        <>
          {tab === 'チャネル' && <ChannelTab rows={pmsRows(data.channel, month, 'channel')} />}
          {tab === '客室' && <RoomTab rooms={pmsRows(data.room, month, 'room')} types={pmsRows(data.rtype, month, 'room_type')} typeMonthly={data.rtype ?? []} capByType={capByType} />}
          {tab === '居住地' && <ResidenceTab rows={residenceRows} />}
          {tab === 'プラン' && <PlanTab events={monthEvents} />}
          {tab === '曜日' && <DowTab events={monthEvents} dateField={dateField} />}
          {tab === '喫食' && <MealTab rows={(data.meal ?? []).filter((r) => r.month === month)} allMeal={data.meal ?? []} />}
          {tab === 'GS' && <GsTab events={monthEvents} />}
          {tab === 'ADR帯' && <AdrBandTab events={monthEvents} />}
        </>
      )}
    </div>
  )
}

/* mart rows → 統一Row */
function pmsRows(src: any[] | undefined, month: string, kind: 'channel' | 'room' | 'room_type'): Row[] {
  return (src ?? []).filter((r) => r.month === month).map((r) => ({
    name: (kind === 'channel' ? r.channel : kind === 'room' ? r.room : r.room_type) || '不明',
    revenue: r.revenue || 0,
    rooms: (kind === 'channel' ? r.rooms : r.rooms_sold) || 0,
    guests: r.guests || 0,
  }))
}
function aggEvents(events: Ev[], keyFn: (e: Ev) => string | null): Row[] {
  const m = new Map<string, Row>()
  for (const e of events) {
    const k = keyFn(e); if (k == null) continue
    const g = m.get(k) ?? { name: k, revenue: 0, rooms: 0, guests: 0, count: 0 }
    // rooms=室泊(部屋数×泊数), guests=人泊。ADR・客単価を1泊あたりに揃える
    const n = Math.max(e.nights ?? 1, 1)
    g.revenue += e.amount_gross || 0; g.rooms += (e.rooms || 0) * n; g.guests += (e.guests_total || 0) * n; g.count! += 1
    m.set(k, g)
  }
  return [...m.values()]
}

/* 共通 */
function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return <div className="card p-4 mb-4"><h2 className="text-sm font-semibold mb-3">{title}</h2>{children}</div>
}
function KpiTable({ dim, rows, countLabel }: { dim: string; rows: Row[]; countLabel?: string }) {
  const total = rows.reduce((s, r) => s + (r.revenue || 0), 0)
  const headers = [dim, ...(countLabel ? [countLabel] : []), '売上', '構成比', '室泊数', '人泊数', 'ADR', '客単価', 'GS']
  return (
    <div className="card overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr style={{ background: 'var(--surface2)', color: 'var(--text-dim)' }} className="text-left">
            {headers.map((h, i) => <th key={i} className={`px-4 py-3 ${i > 0 ? 'text-right' : ''}`}>{h}</th>)}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => {
            const adr = r.rooms > 0 ? r.revenue / r.rooms : 0
            const gu = r.guests > 0 ? r.revenue / r.guests : 0
            const gs = r.rooms > 0 ? r.guests / r.rooms : 0
            return (
              <tr key={i} style={{ borderTop: '1px solid var(--border)' }}>
                <td className="px-4 py-2 font-medium">{r.name}</td>
                {countLabel && <td className="px-4 py-2 text-right">{fmtNum(r.count)}</td>}
                <td className="px-4 py-2 text-right">{fmtNum(r.revenue)}</td>
                <td className="px-4 py-2 text-right" style={{ color: 'var(--text-dim)' }}>{total > 0 ? pct(r.revenue / total) : '-'}</td>
                <td className="px-4 py-2 text-right">{fmtNum(r.rooms)}</td>
                <td className="px-4 py-2 text-right">{fmtNum(r.guests)}</td>
                <td className="px-4 py-2 text-right">{fmtNum(adr)}</td>
                <td className="px-4 py-2 text-right">{fmtNum(gu)}</td>
                <td className="px-4 py-2 text-right">{gs > 0 ? gs.toFixed(2) : '-'}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

/* ---- チャネル（横軸1円単位）---- */
function ChannelTab({ rows }: { rows: Row[] }) {
  if (rows.length === 0) return <Empty message="この月のデータがありません" />
  const sorted = [...rows].sort((a, b) => b.revenue - a.revenue)
  return (
    <>
      <Section title="チャネル別売上">
        <ResponsiveContainer width="100%" height={280}>
          <BarChart data={sorted} layout="vertical" margin={{ left: 20, right: 30 }}>
            <XAxis type="number" {...CHART_AXIS} tickFormatter={yenAxis} />
            <YAxis type="category" dataKey="name" {...CHART_AXIS} width={90} />
            <Tooltip {...chartTooltip} formatter={(v) => fmtYen(Number(v))} />
            <Bar dataKey="revenue" radius={[0, 4, 4, 0]}>
              {sorted.map((d, i) => <Cell key={i} fill={channelColor(d.name, i)} />)}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </Section>
      <KpiTable dim="チャネル" rows={sorted} />
    </>
  )
}

/* ---- 客室（部屋名 + 部屋タイプ）---- */
const TYPE_COLORS = ['#6366f1', '#22c55e', '#f59e0b', '#ef4444', '#06b6d4', '#a855f7']
const daysInMonth = (ym: string) => { const [y, m] = ym.split('-').map(Number); return new Date(y, m, 0).getDate() }

function RoomTab({ rooms, types, typeMonthly, capByType }: { rooms: Row[]; types: Row[]; typeMonthly: any[]; capByType: Record<string, number> }) {
  const r = [...rooms].sort((a, b) => b.revenue - a.revenue)
  const t = [...types].sort((a, b) => b.revenue - a.revenue)

  // 部屋タイプ別 月次トレンド（直近12ヶ月）: 稼働率 と ADR
  const typeNames = [...new Set(typeMonthly.map((x) => x.room_type).filter(Boolean))]
  const allMonths = [...new Set(typeMonthly.map((x) => x.month).filter(Boolean))].sort().slice(-12)
  const lookup: Record<string, any> = {}
  typeMonthly.forEach((x) => { lookup[x.month + '|' + x.room_type] = x })
  const occData = allMonths.map((m) => {
    const o: any = { month: m.slice(2) }
    typeNames.forEach((tp) => {
      const row = lookup[m + '|' + tp]
      const cap = capByType[tp]
      o[tp] = row && cap ? Math.round((Number(row.rooms_sold) / (cap * daysInMonth(m))) * 1000) / 10 : null
    })
    return o
  })
  const adrData = allMonths.map((m) => {
    const o: any = { month: m.slice(2) }
    typeNames.forEach((tp) => { const row = lookup[m + '|' + tp]; o[tp] = row ? Number(row.adr) : null })
    return o
  })

  return (
    <>
      {typeNames.length > 0 && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-4">
          <div className="card p-4">
            <h2 className="text-sm font-semibold mb-3">部屋タイプ別 稼働率（月次・直近12ヶ月）</h2>
            <ResponsiveContainer width="100%" height={260}>
              <ComposedChart data={occData}>
                <XAxis dataKey="month" {...CHART_AXIS} />
                <YAxis {...CHART_AXIS} tickFormatter={(v) => `${v}%`} />
                <Tooltip {...chartTooltip} formatter={(v) => (v == null ? '-' : `${v}%`)} />
                <Legend wrapperStyle={{ fontSize: 10 }} />
                {typeNames.map((tp, i) => (
                  <Line key={tp} dataKey={tp} name={tp} stroke={TYPE_COLORS[i % TYPE_COLORS.length]} strokeWidth={2} dot={{ r: 2 }} connectNulls />
                ))}
              </ComposedChart>
            </ResponsiveContainer>
          </div>
          <div className="card p-4">
            <h2 className="text-sm font-semibold mb-3">部屋タイプ別 ADR（月次・直近12ヶ月）</h2>
            <ResponsiveContainer width="100%" height={260}>
              <ComposedChart data={adrData}>
                <XAxis dataKey="month" {...CHART_AXIS} />
                <YAxis {...CHART_AXIS} tickFormatter={(v) => `${Math.round(v / 1000)}k`} />
                <Tooltip {...chartTooltip} formatter={(v) => fmtYen(Number(v))} />
                <Legend wrapperStyle={{ fontSize: 10 }} />
                {typeNames.map((tp, i) => (
                  <Line key={tp} dataKey={tp} name={tp} stroke={TYPE_COLORS[i % TYPE_COLORS.length]} strokeWidth={2} dot={{ r: 2 }} connectNulls />
                ))}
              </ComposedChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}
      {rooms.length === 0 && types.length === 0 ? <Empty message="この月のデータがありません" /> : (
      <>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-4">
        <div className="card p-4">
          <h2 className="text-sm font-semibold mb-3">客室別売上</h2>
          <ResponsiveContainer width="100%" height={Math.max(220, r.length * 30)}>
            <BarChart data={r} layout="vertical" margin={{ left: 30 }}>
              <XAxis type="number" {...CHART_AXIS} tickFormatter={(v) => `${Math.round(v / 1e6)}M`} />
              <YAxis type="category" dataKey="name" {...CHART_AXIS} width={100} />
              <Tooltip {...chartTooltip} formatter={(v) => fmtYen(Number(v))} />
              <Bar dataKey="revenue" fill="var(--accent)" radius={[0, 4, 4, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
        <div className="card p-4">
          <h2 className="text-sm font-semibold mb-3">部屋タイプ別売上</h2>
          <ResponsiveContainer width="100%" height={Math.max(220, t.length * 30)}>
            <BarChart data={t} layout="vertical" margin={{ left: 30 }}>
              <XAxis type="number" {...CHART_AXIS} tickFormatter={(v) => `${Math.round(v / 1e6)}M`} />
              <YAxis type="category" dataKey="name" {...CHART_AXIS} width={120} tick={{ fill: '#927e6a', fontSize: 10 }} />
              <Tooltip {...chartTooltip} formatter={(v) => fmtYen(Number(v))} />
              <Bar dataKey="revenue" fill="#22c55e" radius={[0, 4, 4, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>
      <h3 className="text-sm font-semibold mb-2">客室別</h3>
      <div className="mb-4"><KpiTable dim="客室" rows={r} /></div>
      <h3 className="text-sm font-semibold mb-2">部屋タイプ別</h3>
      <KpiTable dim="部屋タイプ" rows={t} />
      </>
      )}
    </>
  )
}

/* ---- 居住地（都道府県・外国は国単位）---- */
function ResidenceTab({ rows }: { rows: Row[] }) {
  if (rows.length === 0) return <Empty message="この月のデータがありません" />
  const chart = rows.slice(0, 15).map((r) => ({ name: r.name, revenue: r.revenue }))
  return (
    <>
      <Section title="居住地別売上 TOP15（都道府県／外国は国単位）">
        <ResponsiveContainer width="100%" height={Math.max(240, chart.length * 28)}>
          <BarChart data={chart} layout="vertical" margin={{ left: 20 }}>
            <XAxis type="number" {...CHART_AXIS} tickFormatter={(v) => `${Math.round(v / 1e6)}M`} />
            <YAxis type="category" dataKey="name" {...CHART_AXIS} width={80} />
            <Tooltip {...chartTooltip} formatter={(v) => fmtYen(Number(v))} />
            <Bar dataKey="revenue" fill="var(--accent)" radius={[0, 4, 4, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </Section>
      <KpiTable dim="居住地" rows={rows} />
    </>
  )
}

/* ---- プラン ---- */
function PlanTab({ events }: { events: Ev[] }) {
  if (events.length === 0) return <Empty message="この月のデータがありません" />
  const rows = aggEvents(events, (e) => e.plan || '不明').sort((a, b) => b.revenue - a.revenue).slice(0, 15)
  const chart = rows.map((r) => ({ name: r.name.slice(0, 18), revenue: r.revenue }))
  return (
    <>
      <Section title="プラン別売上 TOP15">
        <ResponsiveContainer width="100%" height={Math.max(240, chart.length * 30)}>
          <BarChart data={chart} layout="vertical" margin={{ left: 30 }}>
            <XAxis type="number" {...CHART_AXIS} tickFormatter={(v) => `${Math.round(v / 1e6)}M`} />
            <YAxis type="category" dataKey="name" {...CHART_AXIS} width={140} tick={{ fill: '#927e6a', fontSize: 10 }} />
            <Tooltip {...chartTooltip} formatter={(v) => fmtYen(Number(v))} />
            <Bar dataKey="revenue" fill="var(--accent)" radius={[0, 4, 4, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </Section>
      <KpiTable dim="プラン" rows={rows} countLabel="予約数" />
    </>
  )
}

/* ---- 曜日（表追加）---- */
function DowTab({ events, dateField }: { events: Ev[]; dateField: keyof Ev }) {
  if (events.length === 0) return <Empty message="この月のデータがありません" />
  const dowOf = (e: Ev) => {
    const ds = e[dateField] as string | null; if (!ds) return null
    return DOW_ORDER[(new Date(ds + 'T00:00:00').getDay() + 6) % 7]
  }
  const byDow = aggEvents(events, dowOf)
  const rows: Row[] = DOW_ORDER.map((d) => byDow.find((x) => x.name === d) ?? { name: d, revenue: 0, rooms: 0, guests: 0, count: 0 })
    .map((x) => ({ ...x, name: DOW_JP[x.name] ?? x.name }))
  const chart = rows.map((x) => ({ name: x.name, revenue: x.revenue, adr: x.rooms > 0 ? Math.round(x.revenue / x.rooms) : 0 }))
  return (
    <>
      <Section title="曜日別 売上 + ADR">
        <ResponsiveContainer width="100%" height={300}>
          <ComposedChart data={chart}>
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
      <KpiTable dim="曜日" rows={rows} countLabel="予約数" />
    </>
  )
}

/* ---- 喫食（予約単位）---- */
function MealTab({ rows, allMeal }: { rows: any[]; allMeal: any[] }) {
  const unified: Row[] = rows.map((r) => ({ name: r.meal_type || '不明', revenue: r.revenue || 0, rooms: r.rooms || 0, guests: r.guests || 0, count: r.reservations || 0 }))
    .sort((a, b) => (b.count || 0) - (a.count || 0))
  const chart = unified.map((r) => ({ name: r.name, count: r.count || 0 }))

  // 月次構成比（予約数ベース）: 行=月, 列=喫食タイプ
  const monthsAll = [...new Set((allMeal ?? []).map((r) => r.month))].sort().reverse()
  const compRows = monthsAll.map((mo) => {
    const mrows = (allMeal ?? []).filter((r) => r.month === mo)
    const total = mrows.reduce((s, r) => s + (r.reservations || 0), 0)
    const byType: Record<string, number> = {}
    mrows.forEach((r) => { byType[r.meal_type] = (byType[r.meal_type] || 0) + (r.reservations || 0) })
    return { month: mo, total, byType }
  })

  return (
    <>
      {rows.length > 0 && (
        <>
          <Section title="喫食タイプ別 予約数（予約単位）">
            <ResponsiveContainer width="100%" height={240}>
              <BarChart data={chart}>
                <XAxis dataKey="name" {...CHART_AXIS} />
                <YAxis {...CHART_AXIS} allowDecimals={false} />
                <Tooltip {...chartTooltip} />
                <Bar dataKey="count" name="予約数" fill="var(--accent)" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </Section>
          <div className="mb-6"><KpiTable dim="喫食タイプ" rows={unified} countLabel="予約数" /></div>
        </>
      )}

      <h3 className="text-sm font-semibold mb-2">月次 喫食構成比（予約数ベース）</h3>
      {compRows.length === 0 ? <Empty /> : (
        <div className="card overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr style={{ background: 'var(--surface2)', color: 'var(--text-dim)' }} className="text-left">
                <th className="px-4 py-3">月</th>
                {MEAL_ORDER.map((m) => <th key={m} className="px-4 py-3 text-right">{m}</th>)}
                <th className="px-4 py-3 text-right">予約数</th>
              </tr>
            </thead>
            <tbody>
              {compRows.map((r) => (
                <tr key={r.month} style={{ borderTop: '1px solid var(--border)' }}>
                  <td className="px-4 py-2 font-medium">{r.month}</td>
                  {MEAL_ORDER.map((m) => (
                    <td key={m} className="px-4 py-2 text-right">
                      {r.total > 0 && r.byType[m] ? pct(r.byType[m] / r.total) : '-'}
                    </td>
                  ))}
                  <td className="px-4 py-2 text-right" style={{ color: 'var(--text-dim)' }}>{fmtNum(r.total)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  )
}

/* ---- GS ---- */
function GsTab({ events }: { events: Ev[] }) {
  if (events.length === 0) return <Empty message="この月のデータがありません" />
  const by = aggEvents(events, (e) => gsLabel(Math.round((e.guests_total || 0) / Math.max(e.rooms || 1, 1))))
  const rows: Row[] = GS_ORDER.map((g) => by.find((x) => x.name === g)).filter(Boolean) as Row[]
  const chart = rows.map((r) => ({ name: r.name, revenue: r.revenue }))
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
      <KpiTable dim="グループサイズ" rows={rows} countLabel="予約数" />
    </>
  )
}

/* ---- ADR帯（1円単位）---- */
function AdrBandTab({ events }: { events: Ev[] }) {
  if (events.length === 0) return <Empty message="この月のデータがありません" />
  const by = aggEvents(events.filter((e) => (e.rooms || 0) > 0),
    (e) => bandLabel((e.amount_gross || 0) / ((e.rooms || 1) * Math.max(e.nights ?? 1, 1))))  // ADR=1室1泊あたり
  const rows: Row[] = BAND_ORDER.map((b) => by.find((x) => x.name === b)).filter(Boolean) as Row[]
  const chart = rows.map((r) => ({ name: r.name, count: r.count || 0, adr: r.rooms > 0 ? Math.round(r.revenue / r.rooms) : 0 }))
  return (
    <>
      <Section title="ADR帯 分布">
        <ResponsiveContainer width="100%" height={300}>
          <ComposedChart data={chart} margin={{ bottom: 20 }}>
            <XAxis dataKey="name" {...CHART_AXIS} interval={0} angle={-15} textAnchor="end" height={60} tick={{ fill: '#927e6a', fontSize: 10 }} />
            <YAxis yAxisId="l" {...CHART_AXIS} allowDecimals={false} />
            <YAxis yAxisId="r" orientation="right" {...CHART_AXIS} tickFormatter={yenAxis} width={70} />
            <Tooltip {...chartTooltip} formatter={(v) => fmtYen(Number(v))} />
            <Legend wrapperStyle={{ fontSize: 11 }} />
            <Bar yAxisId="l" dataKey="count" name="予約数" fill="var(--accent)" radius={[4, 4, 0, 0]} />
            <Line yAxisId="r" dataKey="adr" name="ADR" stroke="var(--yellow)" strokeWidth={2} dot={{ r: 3 }} />
          </ComposedChart>
        </ResponsiveContainer>
      </Section>
      <KpiTable dim="ADR帯" rows={rows} countLabel="予約数" />
    </>
  )
}
