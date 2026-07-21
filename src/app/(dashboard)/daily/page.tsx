'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useFacility } from '@/lib/facility-context'
import { supabase } from '@/lib/supabase/client'
import { fetchAll } from '@/lib/supabase/fetch-all'
import { fmtNum, fmtYen, pct } from '@/lib/ui'
import { Loading, Empty, LoadError } from '@/components/page-bits'
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from 'recharts'

const DOW = ['日', '月', '火', '水', '木', '金', '土']
const ALIVE = new Set(['未確認', '予約確定', '重要予約', 'C/O'])

/* ---------- date utils (UTC) ---------- */
function addDays(dateStr: string, k: number): string {
  const d = new Date(dateStr + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + k); return d.toISOString().slice(0, 10)
}
function prevYear(dateStr: string): string {
  const d = new Date(dateStr + 'T00:00:00Z'); d.setUTCFullYear(d.getUTCFullYear() - 1); return d.toISOString().slice(0, 10)
}
function enumerateDates(from: string, to: string): string[] {
  const out: string[] = []; let d = from; let g = 0
  while (d <= to && g < 1200) { out.push(d); d = addDays(d, 1); g++ }
  return out
}
function lastDayOfMonth(ym: string): string {
  const [y, m] = ym.split('-').map(Number)
  return `${ym}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, '0')}`
}
const dowOf = (d: string) => new Date(d + 'T00:00:00Z').getUTCDay()
const mmdd = (d: string) => { const [, m, dd] = d.split('-'); return `${+m}/${+dd}` }
// 前年同日（曜日合わせ・-364日）。実績もオンハンドも比較はこの軸で統一。
const priorDay = (d: string) => addDays(d, -364)

/* ---------- rank gradient (大きいほど赤く濃く) ---------- */
function rankColor(rank: number | null | undefined): string {
  if (rank === null || rank === undefined) return 'transparent'
  const lo = 18, hi = 42
  const t = Math.max(0, Math.min(1, (rank - lo) / (hi - lo)))
  const hue = 140 * (1 - t)          // 緑140 → 赤0
  const light = 55 - 20 * t          // 高ランクほど暗く
  return `hsl(${hue.toFixed(0)}, 78%, ${light.toFixed(0)}%)`
}

/* ---------- KPI 定義 ---------- */
type Metrics = { sold: number; revenue: number; guests: number; guestUnit: number | null; occ: number | null; adr: number | null; companion: number | null; revpar: number | null }
const ZERO: Metrics = { sold: 0, revenue: 0, guests: 0, guestUnit: null, occ: null, adr: null, companion: null, revpar: null }
// sold/revenue/guests と客室数(cap)から派生指標を組み立てる（実績・オンハンド・予算・前年で共通利用）
function derive(sold: number, revenue: number, guests: number, cap: number): Metrics {
  const rev = Math.round(revenue)
  return {
    sold, revenue: rev, guests,
    guestUnit: guests > 0 ? Math.round(rev / guests) : null,
    occ: cap > 0 ? sold / cap : null,
    adr: sold > 0 ? Math.round(rev / sold) : null,
    companion: sold > 0 ? guests / sold : null,
    revpar: cap > 0 ? Math.round(rev / cap) : null,
  }
}

// グラフ用（¥付き）
const KPIS: { key: keyof Metrics; label: string; color: string; fmt: (v: any) => string }[] = [
  { key: 'revenue', label: '売上', color: '#22c55e', fmt: (v) => fmtYen(v) },
  { key: 'sold', label: '室数', color: '#6366f1', fmt: (v) => fmtNum(v) },
  { key: 'guests', label: '人数', color: '#f59e0b', fmt: (v) => fmtNum(v) },
  { key: 'guestUnit', label: '客単価', color: '#ef4444', fmt: (v) => fmtYen(v) },
  { key: 'adr', label: '室単価', color: '#a855f7', fmt: (v) => fmtYen(v) },
  { key: 'occ', label: '稼働率', color: '#06b6d4', fmt: (v) => pct(v) },
  { key: 'companion', label: '同伴係数', color: '#84cc16', fmt: (v) => (v == null ? '-' : Number(v).toFixed(2)) },
  { key: 'revpar', label: 'RevPAR', color: '#ec4899', fmt: (v) => fmtYen(v) },
]
// 表用（¥なし・元の見た目に合わせる）
const COLS: { key: keyof Metrics; label: string; fmt: (v: any) => string }[] = [
  { key: 'revenue', label: '売上', fmt: (v) => fmtNum(v) },
  { key: 'sold', label: '室数', fmt: (v) => fmtNum(v) },
  { key: 'guests', label: '人数', fmt: (v) => fmtNum(v) },
  { key: 'guestUnit', label: '客単価', fmt: (v) => fmtNum(v) },
  { key: 'adr', label: '室単価', fmt: (v) => fmtNum(v) },
  { key: 'occ', label: '稼働率', fmt: (v) => pct(v) },
  { key: 'companion', label: '同伴係数', fmt: (v) => (v == null ? '-' : Number(v).toFixed(2)) },
  { key: 'revpar', label: 'RevPAR', fmt: (v) => fmtNum(v) },
]
/* eslint-disable @typescript-eslint/no-explicit-any */

interface Res { checkin: string; nights: number | null; revenue_settled: number | null; guests_total: number | null; status: string | null; booking_date: string | null; cancel_date: string | null }
interface RateRow { snapshot_date: string; stay_date: string; rate_rank: number | null }
type CmpMode = 'budget' | 'py' | 'none'
type Agg = { r: number; g: number; v: number }  // rooms / guests / revenue

export default function DailyPage() {
  const { current, currentFacility } = useFacility()
  const totalRooms = currentFacility?.total_rooms ?? 0
  const [roomsByMonth, setRoomsByMonth] = useState<Record<string, number>>({})
  const roomsFor = useCallback((d: string) => roomsByMonth[d.slice(0, 7)] ?? totalRooms, [roomsByMonth, totalRooms])

  const today = useMemo(() => new Date().toISOString().slice(0, 10), [])
  const tPrev = useMemo(() => addDays(today, -364), [today])
  const isOnhand = useCallback((d: string) => d >= today, [today])

  const [soldMap, setSoldMap] = useState<Record<string, number>>({})   // 実績室数（販売数集計表）
  const [revMap, setRevMap] = useState<Record<string, number>>({})     // 実績売上（C/O）
  const [guestMap, setGuestMap] = useState<Record<string, number>>({}) // 実績人数（C/O）
  const [ohMap, setOhMap] = useState<Record<string, Agg>>({})          // オンハンド（mart_onhand・現在の入り）
  const [poMap, setPoMap] = useState<Record<string, Agg>>({})          // 前年オンハンド（前年同日時点の入り）
  const [budgetMap, setBudgetMap] = useState<Record<string, Metrics>>({})
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [rates, setRates] = useState<RateRow[]>([])
  const [loadingBase, setLoadingBase] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [loadingRange, setLoadingRange] = useState(false)

  // KPI 表示制御
  const [visible, setVisible] = useState<Set<string>>(new Set(KPIS.map((k) => k.key)))
  const [showBudget, setShowBudget] = useState(true)
  const [showPY, setShowPY] = useState(false)
  const [showPM, setShowPM] = useState(false)
  const [cmpMode, setCmpMode] = useState<CmpMode>('budget')  // 表の比較列

  useEffect(() => {
    if (!current) return
    setLoadingBase(true)
    Promise.all([
      fetchAll(() => supabase.from('mart_occupancy_daily').select('date, rooms_sold').eq('facility', current).order('date')),
      fetchAll(() => supabase.from('raw_reservation').select('checkin, nights, revenue_settled, guests_total, status, booking_date, cancel_date').eq('facility', current).order('id')),
      fetchAll(() => supabase.from('budget_daily').select('date, rooms_sold, occ, companion, guests, guest_unit, room_unit, total_revenue').eq('facility', current).eq('version', '当初').order('date')),
      supabase.from('dim_operating_days').select('month, rooms').eq('facility', current).then((r) => r),
      fetchAll(() => supabase.from('mart_onhand').select('stay_date, rooms, guests, revenue').eq('facility', current)),
    ]).then(([sales, res, bud, od, onhand]) => {
      const rbm: Record<string, number> = {}
      ;(((od as any)?.data as { month: string; rooms: number | null }[]) ?? []).forEach((r) => { if (r.rooms != null) rbm[r.month] = r.rooms })
      setRoomsByMonth(rbm)
      const roomsAt = (d: string) => rbm[d.slice(0, 7)] ?? totalRooms

      // 実績室数（販売数集計表＝室数の正）
      const sMap: Record<string, number> = {}
      for (const r of sales as any[]) sMap[r.date] = r.rooms_sold ?? 0

      // 予約明細を1回読み、C/O実績（売上・人数）と 前年オンハンド（前年同日時点の入り）を同時に作る
      const aliveAt = (r: Res, T: string) => !!r.booking_date && r.booking_date <= T && (r.status !== 'キャンセル' || (!!r.cancel_date && r.cancel_date > T))
      const rMap: Record<string, number> = {}; const gMap: Record<string, number> = {}
      const po: Record<string, Agg> = {}
      for (const r of res as Res[]) {
        const nights = Math.max(r.nights ?? 1, 1)
        const per = (r.revenue_settled ?? 0) / nights
        const isCO = r.status === 'C/O'
        const alivePrev = aliveAt(r, tPrev)   // 前年同日時点で生存していた予約
        if (!isCO && !alivePrev) continue
        for (let k = 0; k < nights; k++) {
          const d = addDays(r.checkin, k)
          if (isCO) {
            rMap[d] = (rMap[d] ?? 0) + per
            gMap[d] = (gMap[d] ?? 0) + (r.guests_total ?? 0)
          }
          if (alivePrev) {
            const a = (po[d] ??= { r: 0, g: 0, v: 0 })
            a.r += 1; a.g += (r.guests_total ?? 0); a.v += per   // 1室/泊（mart_onhandと整合）
          }
        }
      }

      // 現在のオンハンド（mart_onhand・当日以降の宿泊日）
      const oh: Record<string, Agg> = {}
      for (const r of onhand as any[]) {
        const a = (oh[r.stay_date] ??= { r: 0, g: 0, v: 0 })
        a.r += r.rooms ?? 0; a.g += r.guests ?? 0; a.v += r.revenue ?? 0
      }

      const bMap: Record<string, Metrics> = {}
      for (const b of bud as any[]) {
        const rev = Number(b.total_revenue ?? 0), sold = Number(b.rooms_sold ?? 0), guests = Number(b.guests ?? 0)
        bMap[b.date] = {
          sold, revenue: Math.round(rev), guests,
          guestUnit: b.guest_unit != null ? Math.round(Number(b.guest_unit)) : (guests > 0 ? Math.round(rev / guests) : null),
          occ: b.occ != null ? Number(b.occ) : (roomsAt(b.date) > 0 ? sold / roomsAt(b.date) : null),
          adr: b.room_unit != null ? Math.round(Number(b.room_unit)) : (sold > 0 ? Math.round(rev / sold) : null),
          companion: b.companion != null ? Number(b.companion) : (sold > 0 ? guests / sold : null),
          revpar: roomsAt(b.date) > 0 ? Math.round(rev / roomsAt(b.date)) : null,
        }
      }
      setSoldMap(sMap); setRevMap(rMap); setGuestMap(gMap); setOhMap(oh); setPoMap(po); setBudgetMap(bMap)

      // 既定範囲: ?month= があればその月、無ければ当月（1ヶ月分）
      const urlMonth = new URLSearchParams(window.location.search).get('month')
      const ym = (urlMonth && /^\d{4}-\d{2}$/.test(urlMonth)) ? urlMonth : today.slice(0, 7)
      setFrom(`${ym}-01`); setTo(lastDayOfMonth(ym))
    }).catch((e) => setLoadError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoadingBase(false))
  }, [current, totalRooms, tPrev, today])

  // 範囲のレートランク
  useEffect(() => {
    if (!current || !from || !to) return
    setLoadingRange(true)
    fetchAll(() => supabase.from('raw_rate_snapshot').select('snapshot_date, stay_date, rate_rank')
      .eq('facility', current).eq('scope', 'total').gte('stay_date', from).lte('stay_date', to).order('id'))
      .then((data) => { setRates(data as RateRow[]) })
      .catch((e) => setLoadError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoadingRange(false))
  }, [current, from, to])

  // 実績（その日）
  const actualFor = useCallback((d: string): Metrics | null => {
    if (!(d in soldMap || d in revMap)) return null
    return derive(soldMap[d] ?? 0, revMap[d] ?? 0, guestMap[d] ?? 0, roomsFor(d))
  }, [soldMap, revMap, guestMap, roomsFor])
  // 現在のオンハンド（その日）
  const onhandFor = useCallback((d: string): Metrics | null => {
    const a = ohMap[d]; if (!a) return null
    return derive(a.r, a.v, a.g, roomsFor(d))
  }, [ohMap, roomsFor])
  // 前年オンハンド（前年同日時点の入り。d の前年同日で引く）
  const priorOnhandFor = useCallback((d: string): Metrics | null => {
    const a = poMap[priorDay(d)]; if (!a) return null
    return derive(a.r, a.v, a.g, roomsFor(priorDay(d)))
  }, [poMap, roomsFor])

  // その日の 現在値／比較相手（予算・前年）を、実績日かオンハンド日かで出し分け
  const cellFor = useCallback((d: string): { kind: 'actual' | 'onhand'; cur: Metrics; py: Metrics | null; bud: Metrics | null } => {
    if (isOnhand(d)) {
      return { kind: 'onhand', cur: onhandFor(d) ?? ZERO, py: priorOnhandFor(d), bud: budgetMap[d] ?? null }
    }
    return { kind: 'actual', cur: actualFor(d) ?? ZERO, py: actualFor(priorDay(d)), bud: budgetMap[d] ?? null }
  }, [isOnhand, onhandFor, priorOnhandFor, actualFor, budgetMap])

  const model = useMemo(() => {
    if (!from || !to || from > to) return null
    const dates = enumerateDates(from, to)
    const rows = dates.map((d) => ({ date: d, ...cellFor(d) }))

    // レートランク列
    const snapSet = new Set<string>(); const rankMap: Record<string, Record<string, number | null>> = {}
    for (const rt of rates) { snapSet.add(rt.snapshot_date); (rankMap[rt.stay_date] ??= {})[rt.snapshot_date] = rt.rate_rank }
    const snapshots = [...snapSet].sort()

    // 合計/平均（現在・予算・前年を別々に積んで派生）
    const acc = (pick: (r: typeof rows[number]) => Metrics | null, capOf: (r: typeof rows[number]) => number) => {
      let sold = 0, rev = 0, g = 0, cap = 0
      for (const r of rows) { const m = pick(r); if (!m) continue; sold += m.sold; rev += m.revenue; g += m.guests; cap += capOf(r) }
      return derive(sold, rev, g, cap)
    }
    const capCur = (r: typeof rows[number]) => roomsFor(r.date)
    const capPrior = (r: typeof rows[number]) => roomsFor(priorDay(r.date))
    const total = {
      cur: acc((r) => r.cur, capCur),
      py: acc((r) => r.py, capPrior),
      bud: acc((r) => r.bud, capCur),
    }
    const hasOnhand = rows.some((r) => r.kind === 'onhand')
    return { dates, rows, snapshots, rankMap, total, hasOnhand }
  }, [from, to, cellFor, rates, roomsFor])

  // 折れ線グラフ（実線=現在=実績/オンハンド自動切替）
  const curLineFor = useCallback((d: string) => (isOnhand(d) ? onhandFor(d) : actualFor(d)), [isOnhand, onhandFor, actualFor])
  const chart = useMemo(() => {
    if (!model) return []
    const raw = model.dates.map((d) => {
      const cur = curLineFor(d)
      const py = showPY ? (isOnhand(d) ? priorOnhandFor(d) : actualFor(priorDay(d))) : null
      const pm = showPM ? actualFor(prevYear(d)) : null
      const bg = showBudget ? (budgetMap[d] ?? null) : null
      const o: any = { label: mmdd(d) }
      for (const k of KPIS) {
        o[`${k.key}__r`] = cur ? cur[k.key] : null
        o[`${k.key}_py__r`] = py ? py[k.key] : null
        o[`${k.key}_pm__r`] = pm ? pm[k.key] : null
        o[`${k.key}_bg__r`] = bg ? bg[k.key] : null
      }
      return o
    })
    for (const k of KPIS) {
      let max = 0
      for (const o of raw) for (const sfx of ['__r', '_py__r', '_pm__r', '_bg__r']) { const v = o[`${k.key}${sfx}`]; if (v != null) max = Math.max(max, Math.abs(v)) }
      for (const o of raw) {
        o[k.key] = o[`${k.key}__r`] != null && max > 0 ? (o[`${k.key}__r`] / max) * 100 : null
        o[`${k.key}_py`] = o[`${k.key}_py__r`] != null && max > 0 ? (o[`${k.key}_py__r`] / max) * 100 : null
        o[`${k.key}_pm`] = o[`${k.key}_pm__r`] != null && max > 0 ? (o[`${k.key}_pm__r`] / max) * 100 : null
        o[`${k.key}_bg`] = o[`${k.key}_bg__r`] != null && max > 0 ? (o[`${k.key}_bg__r`] / max) * 100 : null
      }
    }
    return raw
  }, [model, curLineFor, isOnhand, priorOnhandFor, actualFor, showPY, showPM, showBudget, budgetMap])

  const HROW = 'h-9', HHEAD = 'h-11'
  const toggle = (key: string) => setVisible((prev) => { const n = new Set(prev); n.has(key) ? n.delete(key) : n.add(key); return n })

  // 比較セル（現在値の下に小さく：予算比 or 前年比）
  const ratioLabel = cmpMode === 'budget' ? '予' : '前'
  const cmpVal = (cell: { py: Metrics | null; bud: Metrics | null }, key: keyof Metrics): number | null =>
    cmpMode === 'none' ? null : (cmpMode === 'budget' ? cell.bud?.[key] ?? null : cell.py?.[key] ?? null)
  function RatioLine({ cur, comp }: { cur: number | null; comp: number | null }) {
    if (cmpMode === 'none') return null
    if (cur == null || comp == null || comp === 0) return <div className="text-[9px] leading-none" style={{ color: 'var(--text-dim)' }}>{ratioLabel}-</div>
    const r = Math.round((cur / comp) * 100)
    const good = r >= 100
    return <div className="text-[9px] leading-none" style={{ color: good ? 'var(--green)' : 'var(--red)' }}>{ratioLabel}{r}%</div>
  }

  return (
    <div className="p-6">
      <div className="flex items-end justify-between mb-4 flex-wrap gap-3">
        <div className="flex items-center gap-2 flex-wrap">
          <input type="date" className="field px-3 py-1.5 text-sm" value={from} onChange={(e) => setFrom(e.target.value)} />
          <span style={{ color: 'var(--text-dim)' }}>〜</span>
          <input type="date" className="field px-3 py-1.5 text-sm" value={to} onChange={(e) => setTo(e.target.value)} />
          {/* 表の比較トグル */}
          <div className="flex rounded-md overflow-hidden ml-2" style={{ border: '1px solid var(--border)' }}>
            {([['budget', '予算比'], ['py', '前年比'], ['none', '比較なし']] as [CmpMode, string][]).map(([m, lbl]) => (
              <button key={m} onClick={() => setCmpMode(m)} className="px-3 py-1.5 text-xs"
                style={{ background: cmpMode === m ? 'var(--accent)' : 'var(--surface)', color: cmpMode === m ? '#fff' : 'var(--text-dim)' }}>{lbl}</button>
            ))}
          </div>
        </div>
      </div>

      {loadingBase ? <Loading /> : loadError ? <LoadError message={loadError} /> : (Object.keys(soldMap).length === 0 && Object.keys(ohMap).length === 0) ? (
        <Empty message="販売数集計表を /upload からアップロードしてください（オンハンドはステイシー取込で表示されます）" />
      ) : !model || model.rows.length === 0 ? (
        <p style={{ color: 'var(--text-dim)' }}>範囲を選択してください</p>
      ) : (
        <>
          {/* KPI 折れ線グラフ */}
          <div className="card p-4 mb-4">
            <div className="flex items-center justify-between mb-2 flex-wrap gap-2">
              <h2 className="text-sm font-semibold">KPI推移（指数: 各指標の期間内最大=100）</h2>
            </div>
            <div className="flex flex-wrap gap-x-4 gap-y-1 mb-3 text-xs">
              {KPIS.map((k) => (
                <label key={k.key} className="flex items-center gap-1.5 cursor-pointer">
                  <input type="checkbox" checked={visible.has(k.key)} onChange={() => toggle(k.key)} />
                  <span style={{ color: k.color }}>●</span>{k.label}
                </label>
              ))}
              <span style={{ color: 'var(--border)' }}>|</span>
              <label className="flex items-center gap-1.5 cursor-pointer">
                <input type="checkbox" checked={showBudget} onChange={() => setShowBudget((v) => !v)} />予算
              </label>
              <label className="flex items-center gap-1.5 cursor-pointer">
                <input type="checkbox" checked={showPY} onChange={() => setShowPY((v) => !v)} />前年同日（曜日合わせ）
              </label>
              <label className="flex items-center gap-1.5 cursor-pointer">
                <input type="checkbox" checked={showPM} onChange={() => setShowPM((v) => !v)} />前年同月
              </label>
            </div>
            <ResponsiveContainer width="100%" height={300}>
              <LineChart data={chart} margin={{ top: 5, right: 10, bottom: 5, left: 0 }}>
                <CartesianGrid stroke="#e7dac6" vertical={false} />
                <XAxis dataKey="label" tick={{ fill: '#927e6a', fontSize: 10 }} axisLine={{ stroke: '#e7dac6' }} tickLine={{ stroke: '#e7dac6' }} interval="preserveStartEnd" minTickGap={20} />
                <YAxis tick={{ fill: '#927e6a', fontSize: 10 }} axisLine={{ stroke: '#e7dac6' }} tickLine={{ stroke: '#e7dac6' }} domain={[0, 100]} tickFormatter={(v) => `${v}`} />
                <Tooltip content={<KpiTooltip />} />
                {KPIS.filter((k) => visible.has(k.key)).map((k) => (
                  <Line key={k.key} dataKey={k.key} name={k.label} stroke={k.color} dot={false} strokeWidth={2} connectNulls={false} isAnimationActive={false} />
                ))}
                {showBudget && KPIS.filter((k) => visible.has(k.key)).map((k) => (
                  <Line key={k.key + '_bg'} dataKey={`${k.key}_bg`} stroke={k.color} dot={false} strokeWidth={1.5} strokeDasharray="6 4" strokeOpacity={0.6} connectNulls={false} isAnimationActive={false} />
                ))}
                {showPY && KPIS.filter((k) => visible.has(k.key)).map((k) => (
                  <Line key={k.key + '_py'} dataKey={`${k.key}_py`} stroke={k.color} dot={false} strokeWidth={1.5} strokeDasharray="5 3" strokeOpacity={0.7} connectNulls={false} isAnimationActive={false} />
                ))}
                {showPM && KPIS.filter((k) => visible.has(k.key)).map((k) => (
                  <Line key={k.key + '_pm'} dataKey={`${k.key}_pm`} stroke={k.color} dot={false} strokeWidth={1.5} strokeDasharray="1 3" strokeOpacity={0.55} connectNulls={false} isAnimationActive={false} />
                ))}
              </LineChart>
            </ResponsiveContainer>
            <p className="text-[10px] mt-1" style={{ color: 'var(--text-dim)' }}>
              実線=現在（実績→オンハンド自動切替）/ 破線=予算 / 破線=前年同日 / 点線=前年同月。各線は指標ごとに正規化（実値はホバー）。
            </p>
          </div>

          {/* 表 */}
          <div className="card overflow-hidden">
            <div className="flex">
              <table className="text-sm shrink-0" style={{ borderRight: '2px solid var(--border)' }}>
                <thead>
                  <tr style={{ background: 'var(--surface2)', color: 'var(--text-dim)' }} className="text-left">
                    <th className={`px-3 ${HHEAD} whitespace-nowrap`}>日付</th>
                    {COLS.map((c) => (
                      <th key={c.key} className={`px-3 ${HHEAD} text-right whitespace-nowrap`}>{c.label}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {model.rows.map((row) => {
                    const dw = dowOf(row.date)
                    const dcolor = dw === 0 ? 'var(--red)' : dw === 6 ? '#378ADD' : 'var(--text)'
                    const oh = row.kind === 'onhand'
                    return (
                      <tr key={row.date} style={{ borderTop: '1px solid var(--border)', background: oh ? 'color-mix(in srgb, var(--accent) 5%, transparent)' : undefined }}>
                        <td className={`px-3 ${HROW} whitespace-nowrap font-medium`} style={{ color: dcolor }}>
                          {mmdd(row.date)}({DOW[dw]})
                          {oh && <span className="ml-1.5 text-[8px] px-1 py-0.5 rounded align-middle" style={{ background: 'var(--accent)', color: '#fff' }}>オンハンド</span>}
                        </td>
                        {COLS.map((c) => (
                          <td key={c.key} className={`px-3 ${HROW} text-right align-middle`}>
                            <div className="leading-tight">{c.fmt(row.cur[c.key])}</div>
                            <RatioLine cur={row.cur[c.key] as number | null} comp={cmpVal(row, c.key)} />
                          </td>
                        ))}
                      </tr>
                    )
                  })}
                  <tr style={{ borderTop: '2px solid var(--border)', background: 'var(--surface2)' }} className="font-semibold">
                    <td className={`px-3 ${HHEAD} whitespace-nowrap`}>合計/平均</td>
                    {COLS.map((c) => (
                      <td key={c.key} className={`px-3 ${HHEAD} text-right align-middle`}>
                        <div className="leading-tight">{c.fmt(model.total.cur[c.key])}</div>
                        <RatioLine cur={model.total.cur[c.key] as number | null} comp={cmpMode === 'budget' ? (model.total.bud[c.key] as number | null) : (model.total.py[c.key] as number | null)} />
                      </td>
                    ))}
                  </tr>
                </tbody>
              </table>

              <div className="overflow-x-auto flex-1">
                {model.snapshots.length === 0 ? (
                  <div className={`px-4 ${HHEAD} flex items-center text-xs`} style={{ color: 'var(--text-dim)' }}>
                    {loadingRange ? '読み込み中...' : 'この範囲の在庫レート表データがありません'}
                  </div>
                ) : (
                  <table className="text-sm">
                    <thead>
                      <tr style={{ background: 'var(--surface2)', color: 'var(--text-dim)' }} className="text-center">
                        {model.snapshots.map((s, i) => (
                          <th key={s} className={`px-2 ${HHEAD} whitespace-nowrap`} style={{ minWidth: 54 }}>{i === 0 ? 'スタート' : mmdd(s)}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {model.rows.map((row) => (
                        <tr key={row.date} style={{ borderTop: '1px solid var(--border)' }}>
                          {model.snapshots.map((s) => {
                            const rank = model.rankMap[row.date]?.[s] ?? null
                            return (
                              <td key={s} className={`px-2 ${HROW} text-center`} style={{ background: rankColor(rank), color: rank != null ? '#fff' : undefined, minWidth: 54 }}>
                                {rank ?? ''}
                              </td>
                            )
                          })}
                        </tr>
                      ))}
                      <tr style={{ borderTop: '2px solid var(--border)', background: 'var(--surface2)' }}>
                        {model.snapshots.map((s) => <td key={s} className={`px-2 ${HHEAD}`} />)}
                      </tr>
                    </tbody>
                  </table>
                )}
              </div>
            </div>
          </div>

          {/* 凡例 */}
          <div className="flex items-center gap-4 mt-3 text-xs flex-wrap" style={{ color: 'var(--text-dim)' }}>
            <div className="flex items-center gap-2">
              <span>料金ランク</span><span>低</span>
              <span style={{ display: 'inline-block', width: 160, height: 12, borderRadius: 4, background: 'linear-gradient(90deg, hsl(140,78%,55%), hsl(70,78%,45%), hsl(0,78%,35%))' }} />
              <span>高</span>
            </div>
            {cmpMode !== 'none' && (
              <span>
                各数値の下=<b style={{ color: 'var(--text)' }}>{cmpMode === 'budget' ? '予算比' : '前年比'}</b>
                （<span style={{ color: 'var(--green)' }}>緑</span>=100%以上/<span style={{ color: 'var(--red)' }}>赤</span>=未達）。
                {cmpMode === 'py' && '実績日=前年同日（曜日合わせ）／オンハンド日=前年同日比（1年前の同時点の入り）。'}
              </span>
            )}
            {model.hasOnhand && <span>薄い色の行＝<b style={{ color: 'var(--text)' }}>オンハンド</b>（当日以降・現在の予約の入り）。</span>}
          </div>
        </>
      )}
    </div>
  )
}

function KpiTooltip({ active, payload, label }: any) {
  if (!active || !payload || payload.length === 0) return null
  return (
    <div style={{ background: '#ffffff', border: '1px solid #e7dac6', borderRadius: 8, padding: '8px 10px', fontSize: 12 }}>
      <div style={{ color: '#927e6a', marginBottom: 4 }}>{label}</div>
      {payload.map((p: any, i: number) => {
        const dk: string = p.dataKey
        const suffix = dk.endsWith('_py') ? '（前年同日）' : dk.endsWith('_pm') ? '（前年同月）' : dk.endsWith('_bg') ? '（予算）' : ''
        const base = dk.replace(/_(py|pm|bg)$/, '')
        const kpi = KPIS.find((k) => k.key === base)
        if (!kpi) return null
        const real = p.payload[`${dk}__r`]
        if (real == null) return null
        return (
          <div key={i} style={{ color: '#3d2b1f', display: 'flex', gap: 6, alignItems: 'center' }}>
            <span style={{ color: kpi.color }}>●</span>{kpi.label}{suffix}: {kpi.fmt(real)}
          </div>
        )
      })}
    </div>
  )
}
