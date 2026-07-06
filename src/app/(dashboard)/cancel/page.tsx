'use client'

// CXL＆LT分析。データ元をステイシー(PMS予約情報)／リンカーン(サイトコントローラ)で切替可能。
// ステイシー一本化への安全移行(並走)期間用。両ソースの取消率を並べて確認できる。
import { useEffect, useMemo, useState } from 'react'
import { useFacility } from '@/lib/facility-context'
import { supabase } from '@/lib/supabase/client'
import { fetchAll } from '@/lib/supabase/fetch-all'
import {
  BarChart, Bar, ComposedChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, Legend, CartesianGrid,
} from 'recharts'
import { fmtNum, fmtYen, pct, CHART_AXIS, chartTooltip, channelColor } from '@/lib/ui'
import { Loading, Empty, LoadError } from '@/components/page-bits'
import type { BookingEventRow as Ev, ReservationRow as Resv } from '@/lib/db-types'

// 正規化イベント（両ソース共通）。isBooking=全予約(取消含む), isCancel=取消
type CxlEv = { isBooking: boolean; isCancel: boolean; checkin: string | null; lt: number | null; channel: string; plan: string; revenue: number; rooms: number; guests: number }

const daysBetween = (checkin: string | null, other: string | null): number | null => {
  if (!checkin || !other) return null
  const d = Math.floor((new Date(checkin + 'T00:00:00Z').getTime() - new Date(other + 'T00:00:00Z').getTime()) / 86400000)
  return d < 0 ? 0 : d
}
const BUCKETS: { label: string; lo: number; hi: number }[] = [
  { label: 'A) 0-6日前', lo: 0, hi: 6 }, { label: 'B) 7-13日前', lo: 7, hi: 13 },
  { label: 'C) 14-20日前', lo: 14, hi: 20 }, { label: 'D) 21-27日前', lo: 21, hi: 27 },
  { label: 'E) 28-34日前', lo: 28, hi: 34 }, { label: 'F) 35-55日前', lo: 35, hi: 55 },
  { label: 'G) 56-83日前', lo: 56, hi: 83 }, { label: 'H) 84-111日前', lo: 84, hi: 111 },
  { label: 'I) 112日以上前', lo: 112, hi: Infinity },
]
const EXCLUDE_STATUS = new Set(['販売不可', '空部屋'])  // 予約とみなさない

type Agg = { name: string; bookings: number; cancels: number; cancelAmount: number; rate: number | null }
function cxlBy(evs: CxlEv[], keyOf: (e: CxlEv) => string): Agg[] {
  const m = new Map<string, { bookings: number; cancels: number; cancelAmount: number }>()
  for (const e of evs) {
    const k = keyOf(e)
    const g = m.get(k) ?? { bookings: 0, cancels: 0, cancelAmount: 0 }
    if (e.isBooking) g.bookings++
    if (e.isCancel) { g.cancels++; g.cancelAmount += e.revenue }
    m.set(k, g)
  }
  return [...m.entries()].map(([name, v]) => ({ name, ...v, rate: v.bookings > 0 ? v.cancels / v.bookings : null }))
}

export default function CancelPage() {
  const { current, currentFacility } = useFacility()
  const [month, setMonth] = useState('all')
  const [src, setSrc] = useState<'staysee' | 'lincoln'>('staysee')
  const [resv, setResv] = useState<Resv[]>([])
  const [events, setEvents] = useState<Ev[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')

  useEffect(() => {
    if (!current) return
    setLoading(true); setLoadError('')
    const cut = new Date(); cut.setMonth(cut.getMonth() - 24)
    const cutoff = cut.toISOString().slice(0, 10)
    Promise.all([
      fetchAll<Resv>(() => supabase.from('raw_reservation')
        .select('status, checkin, booking_date, channel, plan, revenue_settled, guests_total, nights, room_count')
        .eq('facility', current).gte('checkin', cutoff).order('id')),
      fetchAll<Ev>(() => supabase.from('raw_booking_event')
        .select('event_type, channel, plan, checkin, received_at, amount_gross, rooms, guests_total, nights')
        .eq('facility', current).gte('checkin', cutoff).order('id')),
    ]).then(([rv, ev]) => { setResv((rv as Resv[]) ?? []); setEvents((ev as Ev[]) ?? []) })
      .catch((e: unknown) => setLoadError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false))
  }, [current])

  // 両ソースを正規化
  const stayseeEv = useMemo<CxlEv[]>(() => resv
    .filter((r) => !EXCLUDE_STATUS.has(r.status ?? ''))
    .map((r) => {
      const n = Math.max(r.nights ?? 1, 1)
      return {
        isBooking: true, isCancel: r.status === 'キャンセル', checkin: r.checkin,
        lt: daysBetween(r.checkin, r.booking_date ?? null),
        channel: r.channel || '不明', plan: r.plan || '不明',
        revenue: r.revenue_settled || 0, rooms: (r.room_count ?? 1) * n, guests: (r.guests_total || 0) * n,
      }
    }), [resv])
  const lincolnEv = useMemo<CxlEv[]>(() => events
    .filter((e) => e.event_type === '予約' || e.event_type === '取消')
    .map((e) => {
      const n = Math.max(e.nights ?? 1, 1)
      return {
        isBooking: e.event_type === '予約', isCancel: e.event_type === '取消', checkin: e.checkin,
        lt: daysBetween(e.checkin, e.received_at ?? null),
        channel: e.channel || '不明', plan: e.plan || '不明',
        revenue: e.amount_gross || 0, rooms: (e.rooms || 0) * n, guests: (e.guests_total || 0) * n,
      }
    }), [events])

  const all = src === 'staysee' ? stayseeEv : lincolnEv
  const months = useMemo(() => [...new Set(all.map((e) => e.checkin?.slice(0, 7)).filter(Boolean))].sort().reverse() as string[], [all])
  const inMonth = (e: CxlEv) => month === 'all' || e.checkin?.slice(0, 7) === month
  const scope = useMemo(() => all.filter(inMonth), [all, month])

  // 並走確認: 両ソースの取消率（同じ月スコープ）
  const rateOf = (evs: CxlEv[]) => {
    const s = evs.filter(inMonth); const bk = s.filter((e) => e.isBooking).length; const cx = s.filter((e) => e.isCancel).length
    return bk > 0 ? cx / bk : null
  }
  const rateStaysee = useMemo(() => rateOf(stayseeEv), [stayseeEv, month])
  const rateLincoln = useMemo(() => rateOf(lincolnEv), [lincolnEv, month])

  const bookings = scope.filter((e) => e.isBooking)
  const cancels = scope.filter((e) => e.isCancel)
  const bk = bookings.length, cx = cancels.length
  const cxlRate = bk > 0 ? cx / bk : null
  const cxlAmount = cancels.reduce((s, e) => s + e.revenue, 0)
  const netBookings = bk - cx

  const trend = useMemo(() => cxlBy(all, (e) => e.checkin?.slice(0, 7) ?? '')
    .filter((r) => r.name)
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((r) => ({ month: r.name.slice(2), 予約: r.bookings, 取消: r.cancels, 取消率: r.rate != null ? Math.round(r.rate * 1000) / 10 : null })), [all])

  const byChannel = useMemo(() => cxlBy(scope, (e) => e.channel).sort((a, b) => b.bookings - a.bookings), [scope])
  const byPlan = useMemo(() => cxlBy(scope, (e) => e.plan).sort((a, b) => b.bookings - a.bookings).slice(0, 15), [scope])

  const totalRooms = bookings.reduce((s, e) => s + e.rooms, 0)
  const ltTable = BUCKETS.map((b) => {
    const bb = bookings.filter((e) => e.lt != null && e.lt >= b.lo && e.lt <= b.hi)
    const cc = cancels.filter((e) => e.lt != null && e.lt >= b.lo && e.lt <= b.hi)
    const revenue = bb.reduce((s, e) => s + e.revenue, 0)
    const rooms = bb.reduce((s, e) => s + e.rooms, 0)
    const guests = bb.reduce((s, e) => s + e.guests, 0)
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

  const dist = useMemo(() => {
    const maxLt = 120
    const arr = Array.from({ length: maxLt + 1 }, (_, d) => ({ lt: d, 予約: 0, 取消: 0 }))
    let bkOver = 0, cxOver = 0
    scope.forEach((e) => {
      if (e.lt == null) return
      if (e.isBooking) { if (e.lt <= maxLt) (arr[e.lt] as any).予約++; else bkOver++ }
      if (e.isCancel) { if (e.lt <= maxLt) (arr[e.lt] as any).取消++; else cxOver++ }
    })
    arr.push({ lt: 999, 予約: bkOver, 取消: cxOver } as any)
    return arr
  }, [scope])

  const srcLabel = src === 'staysee' ? 'ステイシー（PMS予約情報）' : 'リンカーン（サイトコントローラ）'
  const ltBasis = src === 'staysee' ? '予約日' : '予約受信日'

  return (
    <div className="p-6">
      <div className="flex items-end justify-between mb-3 flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold mb-1">CXL ＆ LT分析</h1>
          <p className="text-sm" style={{ color: 'var(--text-dim)' }}>{currentFacility?.name ?? current}・チェックイン{month === 'all' ? '全期間' : month}・{srcLabel}</p>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex rounded-md overflow-hidden" style={{ border: '1px solid var(--border)' }}>
            {(['staysee', 'lincoln'] as const).map((s) => (
              <button key={s} onClick={() => setSrc(s)}
                className="px-3 py-1.5 text-xs"
                style={{ background: src === s ? 'var(--accent)' : 'transparent', color: src === s ? '#fff' : 'var(--text-dim)' }}>
                {s === 'staysee' ? 'ステイシー' : 'リンカーン(旧)'}
              </button>
            ))}
          </div>
          <select className="field px-3 py-1.5 text-sm" value={month} onChange={(e) => setMonth(e.target.value)}>
            <option value="all">全期間</option>
            {months.map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
        </div>
      </div>

      {/* 並走確認バッジ */}
      <div className="flex items-center gap-3 mb-5 text-xs flex-wrap">
        <span style={{ color: 'var(--text-dim)' }}>取消率 並走確認（{month === 'all' ? '全期間' : month}）:</span>
        <span className="px-2 py-1 rounded-md" style={{ background: src === 'staysee' ? 'var(--accent)' : 'var(--surface)', color: src === 'staysee' ? '#fff' : 'var(--text)', border: '1px solid var(--border)' }}>
          ステイシー <strong>{pct(rateStaysee)}</strong>
        </span>
        <span className="px-2 py-1 rounded-md" style={{ background: src === 'lincoln' ? 'var(--accent)' : 'var(--surface)', color: src === 'lincoln' ? '#fff' : 'var(--text)', border: '1px solid var(--border)' }}>
          リンカーン <strong>{pct(rateLincoln)}</strong>
        </span>
        {rateStaysee != null && rateLincoln != null && (
          <span style={{ color: 'var(--text-dim)' }}>差 {((rateStaysee - rateLincoln) * 100).toFixed(1)}pt</span>
        )}
      </div>

      {loading ? <Loading /> : loadError ? <LoadError message={loadError} /> : all.length === 0 ? (
        <Empty message={src === 'staysee' ? 'ステイシー予約情報CSVを /upload からアップロードしてください' : 'Lincoln予約検索CSVを /upload からアップロードしてください'} />
      ) : (
        <>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
            <Kpi label="取消率" value={pct(cxlRate)} accent />
            <Kpi label="取消件数" value={fmtNum(cx)} />
            <Kpi label="取消金額" value={fmtYen(cxlAmount)} />
            <Kpi label="ネット予約" value={fmtNum(netBookings)} />
          </div>

          <div className="card p-4 mb-6">
            <h2 className="text-sm font-semibold mb-1">取消率の月次推移（全期間・チェックイン月）</h2>
            <p className="text-xs mb-3" style={{ color: 'var(--text-dim)' }}>棒＝予約数(青)・取消数(橙)、折れ線＝取消率。データ元＝{srcLabel}。</p>
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

          <div className="grid grid-cols-1 xl:grid-cols-2 gap-6 mb-6">
            <BreakdownTable title="チャネル別" dim="チャネル" rows={byChannel} colored month={month} />
            <BreakdownTable title="プラン別（上位15）" dim="プラン" rows={byPlan} month={month} truncate />
          </div>

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
            リードタイム=チェックイン日−{ltBasis}。取消率=取消÷全予約。室単価・客単価は室泊・人泊あたり。
            {src === 'staysee'
              ? 'ステイシーは全チャネル（直予約・電話・エージェント含む）を捕捉。予約=キャンセル含む全予約（販売不可・空部屋は除外）。'
              : 'リンカーンはOTA通知ベース（直予約・電話の取消は捕捉されません）。'}
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
