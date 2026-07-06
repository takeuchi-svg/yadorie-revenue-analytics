'use client'

import { useMemo, useState } from 'react'
import { useFacility } from '@/lib/facility-context'
import { supabase } from '@/lib/supabase/client'
import { fetchAll } from '@/lib/supabase/fetch-all'
import { useFacilityData } from '@/lib/use-facility-data'
import {
  BarChart, Bar, ComposedChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, Legend, CartesianGrid,
} from 'recharts'
import { fmtNum, fmtYen, pct, CHART_AXIS, chartTooltip, channelColor } from '@/lib/ui'
import { Loading, Empty, LoadError } from '@/components/page-bits'
import type { BookingEventRow as Ev } from '@/lib/db-types'


const lt = (e: Ev) => {
  if (!e.checkin || !e.received_at) return null
  const d = Math.floor((new Date(e.checkin + 'T00:00:00Z').getTime() - new Date(e.received_at + 'T00:00:00Z').getTime()) / 86400000)
  return d < 0 ? 0 : d
}
const BUCKETS: { label: string; lo: number; hi: number }[] = [
  { label: 'A) 0-6日前', lo: 0, hi: 6 }, { label: 'B) 7-13日前', lo: 7, hi: 13 },
  { label: 'C) 14-20日前', lo: 14, hi: 20 }, { label: 'D) 21-27日前', lo: 21, hi: 27 },
  { label: 'E) 28-34日前', lo: 28, hi: 34 }, { label: 'F) 35-55日前', lo: 35, hi: 55 },
  { label: 'G) 56-83日前', lo: 56, hi: 83 }, { label: 'H) 84-111日前', lo: 84, hi: 111 },
  { label: 'I) 112日以上前', lo: 112, hi: Infinity },
]

// 取消率 = 取消 ÷ 全予約（取消された予約も予約としてカウント）
type Agg = { name: string; bookings: number; cancels: number; cancelAmount: number; rate: number | null }
function cxlBy(events: Ev[], keyOf: (e: Ev) => string | null): Agg[] {
  const m = new Map<string, { bookings: number; cancels: number; cancelAmount: number }>()
  for (const e of events) {
    const k = keyOf(e); if (k == null) continue
    const g = m.get(k) ?? { bookings: 0, cancels: 0, cancelAmount: 0 }
    if (e.event_type === '予約') g.bookings++
    else if (e.event_type === '取消') { g.cancels++; g.cancelAmount += e.amount_gross || 0 }
    m.set(k, g)
  }
  return [...m.entries()].map(([name, v]) => ({
    name, ...v, rate: v.bookings > 0 ? v.cancels / v.bookings : null,
  }))
}

export default function CancelPage() {
  const { current, currentFacility } = useFacility()
  const [month, setMonth] = useState('all')

  const { data, loading, error: loadError } = useFacilityData<Ev[]>((facility) => {
    // 直近24ヶ月（チェックイン基準）に制限。全履歴フェッチは運用年数とともに際限なく重くなるため
    const cut = new Date(); cut.setMonth(cut.getMonth() - 24)
    const cutoff = cut.toISOString().slice(0, 10)
    return fetchAll<Ev>(() => supabase.from('raw_booking_event')
      .select('event_type, channel, plan, checkin, received_at, amount_gross, rooms, guests_total, nights')
      .eq('facility', facility).gte('checkin', cutoff).order('id'))
  })
  const events = useMemo(() => data ?? [], [data])
  const rn = (e: Ev) => (e.rooms || 0) * Math.max(e.nights ?? 1, 1)
  const gn = (e: Ev) => (e.guests_total || 0) * Math.max(e.nights ?? 1, 1)

  const months = useMemo(() => [...new Set(events.map((e) => e.checkin?.slice(0, 7)).filter(Boolean))].sort().reverse() as string[], [events])

  const scope = useMemo(() => events.filter((e) => month === 'all' || e.checkin?.slice(0, 7) === month), [events, month])
  const bookings = scope.filter((e) => e.event_type === '予約')
  const cancels = scope.filter((e) => e.event_type === '取消')

  const bk = bookings.length, cx = cancels.length
  const cxlRate = bk > 0 ? cx / bk : null
  const cxlAmount = cancels.reduce((s, e) => s + (e.amount_gross || 0), 0)
  const netBookings = bk - cx

  // 月次推移（全期間・チェックイン月ごと）。予約数/取消数の棒 + 取消率の折れ線
  const trend = useMemo(() => {
    const rows = cxlBy(events, (e) => e.checkin?.slice(0, 7) ?? null)
    return rows
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((r) => ({ month: r.name.slice(2), 予約: r.bookings, 取消: r.cancels, 取消率: r.rate != null ? Math.round(r.rate * 1000) / 10 : null }))
  }, [events])

  // チャネル別（選択月）
  const byChannel = useMemo(() => cxlBy(scope, (e) => e.channel || '不明').sort((a, b) => b.bookings - a.bookings), [scope])
  // プラン別（選択月・上位15）
  const byPlan = useMemo(() => cxlBy(scope, (e) => e.plan || '不明').sort((a, b) => b.bookings - a.bookings).slice(0, 15), [scope])

  // LT分析テーブル（予約ベース） + 取消。室数・人数は室泊・人泊
  const totalRooms = bookings.reduce((s, e) => s + rn(e), 0)
  const ltTable = BUCKETS.map((b) => {
    const bb = bookings.filter((e) => { const d = lt(e); return d != null && d >= b.lo && d <= b.hi })
    const cc = cancels.filter((e) => { const d = lt(e); return d != null && d >= b.lo && d <= b.hi })
    const revenue = bb.reduce((s, e) => s + (e.amount_gross || 0), 0)
    const rooms = bb.reduce((s, e) => s + rn(e), 0)
    const guests = bb.reduce((s, e) => s + gn(e), 0)
    return {
      label: b.label, bookings: bb.length, revenue, rooms, guests,
      roomShare: totalRooms > 0 ? rooms / totalRooms : null,
      adr: rooms > 0 ? Math.round(revenue / rooms) : null,
      guestUnit: guests > 0 ? Math.round(revenue / guests) : null,
      companion: rooms > 0 ? guests / rooms : null,
      cancels: cc.length,
      cxlRate: bb.length > 0 ? cc.length / bb.length : null,
    }
  })

  // LT分布チャート（日別: 予約 vs 取消）
  const dist = useMemo(() => {
    const maxLt = 120
    const arr = Array.from({ length: maxLt + 1 }, (_, d) => ({ lt: d, 予約: 0, 取消: 0 }))
    let bkOver = 0, cxOver = 0
    scope.forEach((e) => {
      const d = lt(e); if (d == null) return
      const key = e.event_type === '取消' ? '取消' : e.event_type === '予約' ? '予約' : null
      if (!key) return
      if (d <= maxLt) (arr[d] as any)[key]++
      else { if (key === '予約') bkOver++; else cxOver++ }
    })
    arr.push({ lt: 999, 予約: bkOver, 取消: cxOver } as any)
    return arr
  }, [scope])

  return (
    <div className="p-6">
      <div className="flex items-end justify-between mb-4 flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold mb-1">CXL ＆ LT分析</h1>
          <p className="text-sm" style={{ color: 'var(--text-dim)' }}>{currentFacility?.name ?? current}・チェックイン{month === 'all' ? '全期間' : month}</p>
        </div>
        <select className="field px-3 py-1.5 text-sm" value={month} onChange={(e) => setMonth(e.target.value)}>
          <option value="all">全期間</option>
          {months.map((m) => <option key={m} value={m}>{m}</option>)}
        </select>
      </div>

      {loading ? <Loading /> : loadError ? <LoadError message={loadError} /> : events.length === 0 ? (
        <Empty message="Lincoln予約検索CSVを /upload からアップロードしてください" />
      ) : (
        <>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
            <Kpi label="取消率" value={pct(cxlRate)} accent />
            <Kpi label="取消件数" value={fmtNum(cx)} />
            <Kpi label="取消金額" value={fmtYen(cxlAmount)} />
            <Kpi label="ネット予約" value={fmtNum(netBookings)} />
          </div>

          {/* 月次推移（全期間） */}
          <div className="card p-4 mb-6">
            <h2 className="text-sm font-semibold mb-1">取消率の月次推移（全期間・チェックイン月）</h2>
            <p className="text-xs mb-3" style={{ color: 'var(--text-dim)' }}>棒＝予約数(青)・取消数(橙)、折れ線＝取消率。月選択に関わらず全期間を表示。</p>
            <ResponsiveContainer width="100%" height={300}>
              <ComposedChart data={trend} margin={{ top: 5, right: 10, bottom: 5, left: 0 }}>
                <CartesianGrid stroke="#e7dac6" vertical={false} />
                <XAxis dataKey="month" {...CHART_AXIS} />
                <YAxis yAxisId="l" {...CHART_AXIS} allowDecimals={false} />
                <YAxis yAxisId="r" orientation="right" {...CHART_AXIS} tickFormatter={(v) => `${v}%`} />
                <Tooltip {...chartTooltip} formatter={(v: any, n: any) => (n === '取消率' ? `${v}%` : fmtNum(Number(v)))} />
                <Legend wrapperStyle={{ fontSize: 11 }} />
                <Bar yAxisId="l" dataKey="予約" fill="#378ADD" />
                <Bar yAxisId="l" dataKey="取消" fill="#D85A30" />
                <Line yAxisId="r" dataKey="取消率" stroke="#C0392B" strokeWidth={2} dot={{ r: 2 }} />
              </ComposedChart>
            </ResponsiveContainer>
          </div>

          {/* チャネル別 / プラン別 分解 */}
          <div className="grid grid-cols-1 xl:grid-cols-2 gap-6 mb-6">
            <BreakdownTable title="チャネル別" dim="チャネル" rows={byChannel} colored month={month} />
            <BreakdownTable title="プラン別（上位15）" dim="プラン" rows={byPlan} month={month} truncate />
          </div>

          {/* LT分布 */}
          <div className="card p-4 mb-6">
            <h2 className="text-sm font-semibold mb-3">リードタイム分布（予約=青 / 取消=橙、横軸=チェックインまでの日数）</h2>
            <ResponsiveContainer width="100%" height={300}>
              <BarChart data={dist} margin={{ top: 5, right: 10, bottom: 5, left: 0 }}>
                <CartesianGrid stroke="#e7dac6" vertical={false} />
                <XAxis dataKey="lt" {...CHART_AXIS} interval={9} tickFormatter={(v) => (v === 999 ? '120+' : v)} />
                <YAxis {...CHART_AXIS} allowDecimals={false} />
                <Tooltip {...chartTooltip} labelFormatter={(v) => (v === 999 ? '120日以上前' : `${v}日前`)} />
                <Legend wrapperStyle={{ fontSize: 11 }} />
                <Bar dataKey="予約" fill="#378ADD" />
                <Bar dataKey="取消" fill="#D85A30" />
              </BarChart>
            </ResponsiveContainer>
          </div>

          {/* LT分析テーブル */}
          <div className="card overflow-x-auto">
            <table className="w-full text-sm whitespace-nowrap">
              <thead>
                <tr style={{ background: 'var(--surface2)', color: 'var(--text-dim)' }} className="text-left">
                  <th className="px-3 py-3">リードタイム</th>
                  <th className="px-3 py-3 text-right">予約数</th>
                  <th className="px-3 py-3 text-right">売上</th>
                  <th className="px-3 py-3 text-right">室泊数</th>
                  <th className="px-3 py-3 text-right">室泊シェア</th>
                  <th className="px-3 py-3 text-right">室単価</th>
                  <th className="px-3 py-3 text-right">人泊数</th>
                  <th className="px-3 py-3 text-right">客単価</th>
                  <th className="px-3 py-3 text-right">同伴比率</th>
                  <th className="px-3 py-3 text-right">取消数</th>
                  <th className="px-3 py-3 text-right">取消率</th>
                </tr>
              </thead>
              <tbody>
                {ltTable.map((r) => (
                  <tr key={r.label} style={{ borderTop: '1px solid var(--border)' }}>
                    <td className="px-3 py-2 font-medium">{r.label}</td>
                    <td className="px-3 py-2 text-right">{fmtNum(r.bookings)}</td>
                    <td className="px-3 py-2 text-right">{fmtNum(r.revenue)}</td>
                    <td className="px-3 py-2 text-right">{fmtNum(r.rooms)}</td>
                    <td className="px-3 py-2 text-right" style={{ color: 'var(--text-dim)' }}>{pct(r.roomShare)}</td>
                    <td className="px-3 py-2 text-right">{fmtNum(r.adr)}</td>
                    <td className="px-3 py-2 text-right">{fmtNum(r.guests)}</td>
                    <td className="px-3 py-2 text-right">{fmtNum(r.guestUnit)}</td>
                    <td className="px-3 py-2 text-right">{r.companion?.toFixed(2) ?? '-'}</td>
                    <td className="px-3 py-2 text-right">{fmtNum(r.cancels)}</td>
                    <td className="px-3 py-2 text-right" style={{ color: r.cxlRate && r.cxlRate >= 0.3 ? 'var(--red)' : undefined }}>{pct(r.cxlRate)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-xs mt-2" style={{ color: 'var(--text-dim)' }}>
            リードタイム=チェックイン日−予約受信日。予約・取消はLincoln通知ベース（直近24ヶ月）。取消率=取消÷全予約。室単価・客単価は室泊・人泊あたり。
          </p>
        </>
      )}
    </div>
  )
}

function BreakdownTable({ title, dim, rows, colored, truncate, month }: {
  title: string; dim: string; rows: Agg[]; colored?: boolean; truncate?: boolean; month: string
}) {
  return (
    <div className="card overflow-x-auto">
      <div className="px-3 pt-3 flex items-baseline justify-between">
        <h2 className="text-sm font-semibold">{title}</h2>
        <span className="text-[10px]" style={{ color: 'var(--text-dim)' }}>{month === 'all' ? '全期間' : month}</span>
      </div>
      <table className="w-full text-sm whitespace-nowrap mt-2">
        <thead>
          <tr style={{ background: 'var(--surface2)', color: 'var(--text-dim)' }} className="text-left">
            <th className="px-3 py-2">{dim}</th>
            <th className="px-3 py-2 text-right">予約数</th>
            <th className="px-3 py-2 text-right">取消数</th>
            <th className="px-3 py-2 text-right">取消率</th>
            <th className="px-3 py-2 text-right">取消金額</th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && (
            <tr><td colSpan={5} className="px-3 py-3 text-center" style={{ color: 'var(--text-dim)' }}>データなし</td></tr>
          )}
          {rows.map((r) => (
            <tr key={r.name} style={{ borderTop: '1px solid var(--border)' }}>
              <td className="px-3 py-2 font-medium" style={truncate ? { maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis' } : undefined}>
                <span className="inline-flex items-center gap-1.5">
                  {colored && <span className="inline-block w-2 h-2 rounded-full" style={{ background: channelColor(r.name) }} />}
                  {truncate ? r.name.slice(0, 32) : r.name}
                </span>
              </td>
              <td className="px-3 py-2 text-right">{fmtNum(r.bookings)}</td>
              <td className="px-3 py-2 text-right">{fmtNum(r.cancels)}</td>
              <td className="px-3 py-2 text-right font-medium" style={{ color: r.rate != null && r.rate >= 0.3 ? 'var(--red)' : undefined }}>{pct(r.rate)}</td>
              <td className="px-3 py-2 text-right" style={{ color: 'var(--text-dim)' }}>{fmtYen(r.cancelAmount)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function Kpi({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="card p-4">
      <p className="text-xs mb-1" style={{ color: 'var(--text-dim)' }}>{label}</p>
      <p className="text-xl font-bold" style={{ color: accent ? 'var(--accent)' : 'var(--text)' }}>{value}</p>
    </div>
  )
}
