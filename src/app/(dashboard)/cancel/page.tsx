'use client'

// CX＆LT分析（ステイシー予約情報ベース）。取消率=取消÷全予約、LT=checkin−予約日。
// 上部で「キャンセル」「リードタイム」を切替。前年比較つき（当月以降のオンハンド月は前年同日比較）。
import { useEffect, useMemo, useState } from 'react'
import { useFacility } from '@/lib/facility-context'
import { supabase } from '@/lib/supabase/client'
import { fetchAll } from '@/lib/supabase/fetch-all'
import {
  BarChart, Bar, ComposedChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, Legend, CartesianGrid, ReferenceArea,
} from 'recharts'
import { fmtNum, fmtYen, pct, CHART_AXIS, chartTooltip, channelColor } from '@/lib/ui'
import { Loading, Empty, LoadError } from '@/components/page-bits'
import type { ReservationRow as Resv } from '@/lib/db-types'

// 正規化イベント。isBooking=全予約(取消含む), isCancel=取消
type CxlEv = {
  isBooking: boolean; isCancel: boolean; checkin: string | null; lt: number | null
  channel: string; plan: string; revenue: number; rooms: number; guests: number
  bookingDate: string | null; cancelDate: string | null
}

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
const todayISO = () => new Date().toISOString().slice(0, 10)
const shiftYr = (k: string) => `${Number(k.slice(0, 4)) - 1}${k.slice(4)}`

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
  const [view, setView] = useState<'cxl' | 'lt'>('cxl')
  const [data, setData] = useState<Resv[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')

  useEffect(() => {
    if (!current) return
    setLoading(true); setLoadError('')
    const cut = new Date(); cut.setMonth(cut.getMonth() - 24)
    const cutoff = cut.toISOString().slice(0, 10)
    fetchAll<Resv>(() => supabase.from('raw_reservation')
      .select('status, checkin, booking_date, cancel_date, channel, plan, revenue_settled, revenue_net, guests_total, nights, room_count')
      .eq('facility', current).gte('checkin', cutoff).order('id'))
      .then((rows) => setData(rows ?? []))
      .catch((e: unknown) => setLoadError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false))
  }, [current])
  const resv = data

  const all = useMemo<CxlEv[]>(() => resv
    .filter((r) => !EXCLUDE_STATUS.has(r.status ?? ''))
    .map((r) => {
      const n = Math.max(r.nights ?? 1, 1)
      return {
        isBooking: true, isCancel: r.status === 'キャンセル', checkin: r.checkin,
        lt: daysBetween(r.checkin, r.booking_date ?? null),
        channel: r.channel || '不明', plan: r.plan || '不明',
        revenue: (r.revenue_net ?? r.revenue_settled) || 0, rooms: n, guests: (r.guests_total || 0) * n,
        bookingDate: r.booking_date ?? null, cancelDate: (r as { cancel_date?: string | null }).cancel_date ?? null,
      }
    }), [resv])

  const months = useMemo(() => [...new Set(all.map((e) => e.checkin?.slice(0, 7)).filter(Boolean))].sort().reverse() as string[], [all])
  const scope = useMemo(() => all.filter((e) => month === 'all' || e.checkin?.slice(0, 7) === month), [all, month])

  const bookings = scope.filter((e) => e.isBooking)
  const cancels = scope.filter((e) => e.isCancel)
  const bk = bookings.length, cx = cancels.length
  const cxlRate = bk > 0 ? cx / bk : null
  const cxlAmount = cancels.reduce((s, e) => s + e.revenue, 0)
  const netBookings = bk - cx

  // 前年比較（月選択時のみ）。当月以降（オンハンド）は前年同日時点で再構築、過去月は前年の最終値。
  const curYm = todayISO().slice(0, 7)
  const prevPoint = shiftYr(todayISO())
  const isOnhandSel = month !== 'all' && month >= curYm
  const prev = useMemo(() => {
    if (month === 'all') return null
    const pm = shiftYr(month)
    const prevScope = all.filter((e) => e.checkin?.slice(0, 7) === pm)
    const pBookings = prevScope.filter((e) => !isOnhandSel || (e.bookingDate != null && e.bookingDate <= prevPoint))
    const pCancels = pBookings.filter((e) => e.isCancel && (!isOnhandSel || (e.cancelDate != null && e.cancelDate <= prevPoint)))
    const pBk = pBookings.length, pCx = pCancels.length
    return {
      pm, bk: pBk, cx: pCx,
      rate: pBk > 0 ? pCx / pBk : null,
      amount: pCancels.reduce((s, e) => s + e.revenue, 0),
      net: pBk - pCx,
      bookingsList: pBookings, cancelsList: pCancels,
    }
  }, [all, month, isOnhandSel, prevPoint])
  const prevLabel = isOnhandSel ? '前年同日' : '前年'

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

  // LT分布（選択月に連動）＋前年（月選択時のみ・破線）
  const dist = useMemo(() => {
    const maxLt = 120
    const arr = Array.from({ length: maxLt + 1 }, (_, d) => ({ lt: d, 予約: 0, 取消: 0, '予約(前年)': null as number | null, '取消(前年)': null as number | null }))
    let bkOver = 0, cxOver = 0, pBkOver = 0, pCxOver = 0
    scope.forEach((e) => {
      if (e.lt == null) return
      if (e.isBooking) { if (e.lt <= maxLt) (arr[e.lt] as any).予約++; else bkOver++ }
      if (e.isCancel) { if (e.lt <= maxLt) (arr[e.lt] as any).取消++; else cxOver++ }
    })
    if (prev) {
      arr.forEach((a) => { a['予約(前年)'] = 0; a['取消(前年)'] = 0 })
      prev.bookingsList.forEach((e) => { if (e.lt == null) return; if (e.lt <= maxLt) (arr[e.lt] as any)['予約(前年)']++; else pBkOver++ })
      prev.cancelsList.forEach((e) => { if (e.lt == null) return; if (e.lt <= maxLt) (arr[e.lt] as any)['取消(前年)']++; else pCxOver++ })
    }
    arr.push({ lt: 999, 予約: bkOver, 取消: cxOver, '予約(前年)': prev ? pBkOver : null, '取消(前年)': prev ? pCxOver : null } as any)
    return arr
  }, [scope, prev])

  const selTrendLabel = month !== 'all' ? month.slice(2) : null

  return (
    <div className="p-6">
      <div className="flex items-center gap-3 mb-4 flex-wrap">
        {/* 画面切替 */}
        <div className="flex rounded-md overflow-hidden" style={{ border: '1px solid var(--border)' }}>
          {([['cxl', 'キャンセル'], ['lt', 'リードタイム']] as const).map(([v, l]) => (
            <button key={v} onClick={() => setView(v)} className="px-4 py-1.5 text-xs font-medium"
              style={{ background: view === v ? 'var(--accent)' : 'var(--surface)', color: view === v ? '#fff' : 'var(--text-dim)' }}>{l}</button>
          ))}
        </div>
        <select className="field px-3 py-1.5 text-sm" value={month} onChange={(e) => setMonth(e.target.value)}>
          <option value="all">全期間</option>
          {months.map((m) => <option key={m} value={m}>{m}</option>)}
        </select>
        {isOnhandSel && (
          <span className="text-[10px] px-2 py-1 rounded" style={{ background: 'var(--yellow)', color: '#3d2b1f' }}>
            この月はオンハンド（宿泊前）。前年比較は前年同日（{prevPoint}）時点です
          </span>
        )}
      </div>

      {loading ? <Loading /> : loadError ? <LoadError message={loadError} /> : all.length === 0 ? (
        <Empty message="ステイシー予約情報CSVを /upload からアップロードしてください" />
      ) : view === 'cxl' ? (
        <>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
            <Kpi label="取消率" value={pct(cxlRate)} accent sub={prev ? `${prevLabel}: ${pct(prev.rate)}` : undefined} />
            <Kpi label="取消件数" value={fmtNum(cx)} sub={prev ? `${prevLabel}: ${fmtNum(prev.cx)}` : undefined} />
            <Kpi label="取消金額" value={fmtYen(cxlAmount)} sub={prev ? `${prevLabel}: ${fmtYen(prev.amount)}` : undefined} />
            <Kpi label="ネット予約" value={fmtNum(netBookings)} sub={prev ? `${prevLabel}: ${fmtNum(prev.net)}（${prev.net > 0 ? pct(netBookings / prev.net) : '-'}）` : undefined} />
          </div>

          <div className="card p-4 mb-6">
            <h2 className="text-sm font-semibold mb-1">取消率の月次推移（全期間・チェックイン月）</h2>
            <p className="text-xs mb-3" style={{ color: 'var(--text-dim)' }}>棒＝予約数(青)・取消数(橙)、折れ線＝取消率。この推移は全期間の俯瞰用（選択月はハイライト表示）。</p>
            <ResponsiveContainer width="100%" height={300}>
              <ComposedChart data={trend} margin={{ top: 5, right: 10, bottom: 5, left: 0 }}>
                <CartesianGrid stroke="#e7dac6" vertical={false} />
                <XAxis dataKey="month" {...CHART_AXIS} />
                <YAxis yAxisId="l" {...CHART_AXIS} allowDecimals={false} />
                <YAxis yAxisId="r" orientation="right" {...CHART_AXIS} tickFormatter={(v) => `${v}%`} />
                <Tooltip {...chartTooltip} formatter={(v: any, n: any) => (n === '取消率' ? `${v}%` : fmtNum(Number(v)))} />
                <Legend wrapperStyle={{ fontSize: 11 }} />
                {selTrendLabel && <ReferenceArea yAxisId="l" x1={selTrendLabel} x2={selTrendLabel} fill="var(--accent)" fillOpacity={0.12} />}
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
          <p className="text-xs" style={{ color: 'var(--text-dim)' }}>
            取消率=取消÷全予約（販売不可・空部屋は除外）。{prevLabel}比較は月選択時に表示（当月以降は前年同日時点＝予約日・キャンセル日から再構築）。
          </p>
        </>
      ) : (
        <>
          <div className="card p-4 mb-6">
            <h2 className="text-sm font-semibold mb-3">
              リードタイム分布（予約=青 / 取消=橙、横軸=チェックインまでの日数）{month !== 'all' ? `｜${month}` : '｜全期間'}
              {prev && <span className="text-xs font-normal ml-2" style={{ color: 'var(--text-dim)' }}>破線＝{prevLabel}（{prev.pm}）</span>}
            </h2>
            <ResponsiveContainer width="100%" height={300}>
              <ComposedChart data={dist} margin={{ top: 5, right: 10, bottom: 5, left: 0 }}>
                <CartesianGrid stroke="#e7dac6" vertical={false} />
                <XAxis dataKey="lt" {...CHART_AXIS} interval={9} tickFormatter={(v) => (v === 999 ? '120+' : v)} />
                <YAxis {...CHART_AXIS} allowDecimals={false} />
                <Tooltip {...chartTooltip} labelFormatter={(v) => (v === 999 ? '120日以上前' : `${v}日前`)} />
                <Legend wrapperStyle={{ fontSize: 11 }} />
                <Bar dataKey="予約" fill="#378ADD" />
                <Bar dataKey="取消" fill="#D85A30" />
                {prev && <Line dataKey="予約(前年)" stroke="#1d5fa8" strokeWidth={1.5} strokeDasharray="4 3" dot={false} />}
                {prev && <Line dataKey="取消(前年)" stroke="#8f3418" strokeWidth={1.5} strokeDasharray="4 3" dot={false} />}
              </ComposedChart>
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
            リードタイム=チェックイン日−予約日。分布・表は選択月（またはallで全期間）に連動。室単価・客単価は室泊・人泊あたり。
            ステイシー予約情報ベース（全チャネル＝直予約・電話・エージェント含む・直近24ヶ月）。
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

function Kpi({ label, value, accent, sub }: { label: string; value: string; accent?: boolean; sub?: string }) {
  return (
    <div className="card p-4">
      <p className="text-xs mb-1" style={{ color: 'var(--text-dim)' }}>{label}</p>
      <p className="text-xl font-bold" style={{ color: accent ? 'var(--accent)' : 'var(--text)' }}>{value}</p>
      {sub && <p className="text-[11px] mt-0.5" style={{ color: 'var(--text-dim)' }}>{sub}</p>}
    </div>
  )
}
