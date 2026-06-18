'use client'

import { useEffect, useMemo, useState } from 'react'
import { useFacility } from '@/lib/facility-context'
import { supabase } from '@/lib/supabase/client'
import { fmtNum, fmtYen, pct } from '@/lib/ui'
import { Loading, Empty } from '@/components/page-bits'
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from 'recharts'

const DOW = ['日', '月', '火', '水', '木', '金', '土']

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
const KPIS: { key: keyof Metrics; label: string; color: string; fmt: (v: any) => string }[] = [
  { key: 'sold', label: '販売室数', color: '#6366f1', fmt: (v) => fmtNum(v) },
  { key: 'revenue', label: '売上', color: '#22c55e', fmt: (v) => fmtYen(v) },
  { key: 'guests', label: '人数', color: '#f59e0b', fmt: (v) => fmtNum(v) },
  { key: 'guestUnit', label: '客単価', color: '#ef4444', fmt: (v) => fmtYen(v) },
  { key: 'occ', label: '稼働率', color: '#06b6d4', fmt: (v) => pct(v) },
  { key: 'adr', label: 'ADR', color: '#a855f7', fmt: (v) => fmtYen(v) },
  { key: 'companion', label: '同伴係数', color: '#84cc16', fmt: (v) => (v == null ? '-' : Number(v).toFixed(2)) },
  { key: 'revpar', label: 'RevPAR', color: '#ec4899', fmt: (v) => fmtYen(v) },
]
/* eslint-disable @typescript-eslint/no-explicit-any */

interface Res { checkin: string; nights: number | null; revenue_settled: number | null; guests_total: number | null }
interface RateRow { snapshot_date: string; stay_date: string; rate_rank: number | null }

async function fetchAll(build: () => any): Promise<any[]> {
  const size = 1000; let frm = 0; let all: any[] = []
  for (let i = 0; i < 50; i++) {
    const { data, error } = await build().range(frm, frm + size - 1)
    if (error || !data || data.length === 0) break
    all = all.concat(data)
    if (data.length < size) break
    frm += size
  }
  return all
}

export default function DailyPage() {
  const { current, currentFacility } = useFacility()
  const totalRooms = currentFacility?.total_rooms ?? 0

  const [soldMap, setSoldMap] = useState<Record<string, number>>({})
  const [revMap, setRevMap] = useState<Record<string, number>>({})
  const [guestMap, setGuestMap] = useState<Record<string, number>>({})
  const [budgetMap, setBudgetMap] = useState<Record<string, Metrics>>({})
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [rates, setRates] = useState<RateRow[]>([])
  const [loadingBase, setLoadingBase] = useState(true)
  const [loadingRange, setLoadingRange] = useState(false)

  // KPI 表示制御
  const [visible, setVisible] = useState<Set<string>>(new Set(KPIS.map((k) => k.key)))
  const [showBudget, setShowBudget] = useState(true)  // 予算
  const [showPY, setShowPY] = useState(false)   // 前年同日（曜日合わせ）
  const [showPM, setShowPM] = useState(false)   // 前年同月

  // 1) 全販売室数 + 全予約 + 予算（全期間） → 既定範囲
  useEffect(() => {
    if (!current) return
    setLoadingBase(true)
    Promise.all([
      fetchAll(() => supabase.from('mart_occupancy_daily').select('date, rooms_sold').eq('facility', current).order('date')),
      fetchAll(() => supabase.from('raw_reservation').select('checkin, nights, revenue_settled, guests_total').eq('facility', current).eq('status', 'C/O').order('id')),
      fetchAll(() => supabase.from('budget_daily').select('date, rooms_sold, occ, companion, guests, guest_unit, room_unit, total_revenue').eq('facility', current).order('date')),
    ]).then(([sales, res, bud]) => {
      const sMap: Record<string, number> = {}
      for (const r of sales as any[]) sMap[r.date] = r.rooms_sold ?? 0
      const rMap: Record<string, number> = {}; const gMap: Record<string, number> = {}
      for (const r of res as Res[]) {
        const nights = Math.max(r.nights ?? 1, 1)
        const per = (r.revenue_settled ?? 0) / nights
        for (let k = 0; k < nights; k++) {
          const d = addDays(r.checkin, k)
          rMap[d] = (rMap[d] ?? 0) + per
          gMap[d] = (gMap[d] ?? 0) + (r.guests_total ?? 0)
        }
      }
      const bMap: Record<string, Metrics> = {}
      for (const b of bud as any[]) {
        const rev = Number(b.total_revenue ?? 0), sold = Number(b.rooms_sold ?? 0), guests = Number(b.guests ?? 0)
        bMap[b.date] = {
          sold, revenue: Math.round(rev), guests,
          guestUnit: b.guest_unit != null ? Math.round(Number(b.guest_unit)) : (guests > 0 ? Math.round(rev / guests) : null),
          occ: b.occ != null ? Number(b.occ) : (totalRooms > 0 ? sold / totalRooms : null),
          adr: b.room_unit != null ? Math.round(Number(b.room_unit)) : (sold > 0 ? Math.round(rev / sold) : null),
          companion: b.companion != null ? Number(b.companion) : (sold > 0 ? guests / sold : null),
          revpar: totalRooms > 0 ? Math.round(rev / totalRooms) : null,
        }
      }
      setSoldMap(sMap); setRevMap(rMap); setGuestMap(gMap); setBudgetMap(bMap)
      const dates = Object.keys(sMap).sort()
      if (dates.length > 0) {
        const latest = dates[dates.length - 1].slice(0, 7)
        setFrom(`${latest}-01`); setTo(lastDayOfMonth(latest))
      }
      setLoadingBase(false)
    })
  }, [current, totalRooms])

  // 2) 範囲のレートランク（全件ページネーション）
  useEffect(() => {
    if (!current || !from || !to) return
    setLoadingRange(true)
    fetchAll(() => supabase.from('raw_rate_snapshot').select('snapshot_date, stay_date, rate_rank')
      .eq('facility', current).eq('scope', 'total').gte('stay_date', from).lte('stay_date', to).order('id'))
      .then((data) => { setRates(data as RateRow[]); setLoadingRange(false) })
  }, [current, from, to])

  const metricsFor = useMemo(() => (d: string): Metrics | null => {
    const has = d in soldMap || d in revMap
    if (!has) return null
    const sold = soldMap[d] ?? 0, revenue = Math.round(revMap[d] ?? 0), guests = guestMap[d] ?? 0
    return {
      sold, revenue, guests,
      guestUnit: guests > 0 ? Math.round(revenue / guests) : null,
      occ: totalRooms > 0 ? sold / totalRooms : null,
      adr: sold > 0 ? Math.round(revenue / sold) : null,
      companion: sold > 0 ? guests / sold : null,
      revpar: totalRooms > 0 ? Math.round(revenue / totalRooms) : null,
    }
  }, [soldMap, revMap, guestMap, totalRooms])

  const model = useMemo(() => {
    if (!from || !to || from > to) return null
    const dates = enumerateDates(from, to)
    const rows = dates.map((d) => ({ date: d, m: metricsFor(d) ?? { sold: 0, revenue: 0, guests: 0, guestUnit: null, occ: null, adr: null, companion: null, revpar: null } }))

    // レートランク列
    const snapSet = new Set<string>(); const rankMap: Record<string, Record<string, number | null>> = {}
    for (const rt of rates) { snapSet.add(rt.snapshot_date); (rankMap[rt.stay_date] ??= {})[rt.snapshot_date] = rt.rate_rank }
    const snapshots = [...snapSet].sort()

    // 合計
    const sumSold = rows.reduce((s, r) => s + r.m.sold, 0)
    const sumRev = rows.reduce((s, r) => s + r.m.revenue, 0)
    const sumGuests = rows.reduce((s, r) => s + r.m.guests, 0)
    const cap = totalRooms * rows.length
    const total: Metrics = {
      sold: sumSold, revenue: sumRev, guests: sumGuests,
      guestUnit: sumGuests > 0 ? Math.round(sumRev / sumGuests) : null,
      occ: cap > 0 ? sumSold / cap : null,
      adr: sumSold > 0 ? Math.round(sumRev / sumSold) : null,
      companion: sumSold > 0 ? sumGuests / sumSold : null,
      revpar: cap > 0 ? Math.round(sumRev / cap) : null,
    }
    return { dates, rows, snapshots, rankMap, total }
  }, [from, to, metricsFor, rates, totalRooms])

  // 折れ線グラフ用データ（KPIごとに期間内最大=100で正規化、ツールチップは実値）
  const chart = useMemo(() => {
    if (!model) return []
    const raw = model.dates.map((d) => {
      const cur = metricsFor(d)
      const py = showPY ? metricsFor(addDays(d, -364)) : null
      const pm = showPM ? metricsFor(prevYear(d)) : null
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
  }, [model, metricsFor, showPY, showPM, showBudget, budgetMap])

  const budgetRange = useMemo(() => {
    if (!model) return null
    let rev = 0, sold = 0, has = false
    for (const { date } of model.rows) { const b = budgetMap[date]; if (b) { has = true; rev += b.revenue || 0; sold += b.sold || 0 } }
    return has ? { rev, sold } : null
  }, [model, budgetMap])

  const HROW = 'h-9', HHEAD = 'h-11'
  const toggle = (key: string) => setVisible((prev) => { const n = new Set(prev); n.has(key) ? n.delete(key) : n.add(key); return n })

  return (
    <div className="p-6">
      <div className="flex items-end justify-between mb-4 flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold mb-1">日別売上</h1>
          <p className="text-sm" style={{ color: 'var(--text-dim)' }}>{currentFacility?.name ?? current}</p>
        </div>
        <div className="flex items-center gap-2">
          <input type="date" className="field px-3 py-1.5 text-sm" value={from} onChange={(e) => setFrom(e.target.value)} />
          <span style={{ color: 'var(--text-dim)' }}>〜</span>
          <input type="date" className="field px-3 py-1.5 text-sm" value={to} onChange={(e) => setTo(e.target.value)} />
        </div>
      </div>

      {loadingBase ? <Loading /> : Object.keys(soldMap).length === 0 ? (
        <Empty message="販売数集計表を /upload からアップロードしてください" />
      ) : !model || model.rows.length === 0 ? (
        <p style={{ color: 'var(--text-dim)' }}>範囲を選択してください</p>
      ) : (
        <>
          {/* 範囲サマリ（実績 vs 予算） */}
          {budgetRange && (
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
              <div className="card p-3">
                <p className="text-xs mb-1" style={{ color: 'var(--text-dim)' }}>売上（実績／予算）</p>
                <p className="text-lg font-bold">{fmtNum(model.total.revenue)} <span className="text-xs" style={{ color: 'var(--text-dim)' }}>/ {fmtNum(budgetRange.rev)}</span></p>
              </div>
              <div className="card p-3">
                <p className="text-xs mb-1" style={{ color: 'var(--text-dim)' }}>売上 達成率</p>
                <p className="text-lg font-bold" style={{ color: 'var(--accent)' }}>{budgetRange.rev > 0 ? pct(model.total.revenue / budgetRange.rev) : '-'}</p>
              </div>
              <div className="card p-3">
                <p className="text-xs mb-1" style={{ color: 'var(--text-dim)' }}>販売室数（実績／予算）</p>
                <p className="text-lg font-bold">{fmtNum(model.total.sold)} <span className="text-xs" style={{ color: 'var(--text-dim)' }}>/ {fmtNum(budgetRange.sold)}</span></p>
              </div>
              <div className="card p-3">
                <p className="text-xs mb-1" style={{ color: 'var(--text-dim)' }}>販売室数 達成率</p>
                <p className="text-lg font-bold" style={{ color: 'var(--accent)' }}>{budgetRange.sold > 0 ? pct(model.total.sold / budgetRange.sold) : '-'}</p>
              </div>
            </div>
          )}

          {/* KPI 折れ線グラフ */}
          <div className="card p-4 mb-4">
            <div className="flex items-center justify-between mb-2 flex-wrap gap-2">
              <h2 className="text-sm font-semibold">KPI推移（指数: 各指標の期間内最大=100）</h2>
            </div>
            {/* チェックボックス */}
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
                <CartesianGrid stroke="#2e3347" vertical={false} />
                <XAxis dataKey="label" tick={{ fill: '#8b8fa3', fontSize: 10 }} axisLine={{ stroke: '#2e3347' }} tickLine={{ stroke: '#2e3347' }} interval="preserveStartEnd" minTickGap={20} />
                <YAxis tick={{ fill: '#8b8fa3', fontSize: 10 }} axisLine={{ stroke: '#2e3347' }} tickLine={{ stroke: '#2e3347' }} domain={[0, 100]} tickFormatter={(v) => `${v}`} />
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
              実線=実績 / 破線=予算 / 破線=前年同日 / 点線=前年同月。各線は指標ごとに正規化（実値はホバーで表示）。
            </p>
          </div>

          {/* 表 */}
          <div className="card overflow-hidden">
            <div className="flex">
              <table className="text-sm shrink-0" style={{ borderRight: '2px solid var(--border)' }}>
                <thead>
                  <tr style={{ background: 'var(--surface2)', color: 'var(--text-dim)' }} className="text-left">
                    <th className={`px-3 ${HHEAD} whitespace-nowrap`}>日付</th>
                    {['販売室数', '売上', '人数', '客単価', '稼働率', 'ADR', '同伴係数', 'RevPAR'].map((h) => (
                      <th key={h} className={`px-3 ${HHEAD} text-right whitespace-nowrap`}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {model.rows.map(({ date, m }) => {
                    const dw = dowOf(date)
                    const dcolor = dw === 0 ? 'var(--red)' : dw === 6 ? '#378ADD' : 'var(--text)'
                    return (
                      <tr key={date} style={{ borderTop: '1px solid var(--border)' }}>
                        <td className={`px-3 ${HROW} whitespace-nowrap font-medium`} style={{ color: dcolor }}>{mmdd(date)}({DOW[dw]})</td>
                        <td className={`px-3 ${HROW} text-right`}>{fmtNum(m.sold)}</td>
                        <td className={`px-3 ${HROW} text-right`}>{fmtNum(m.revenue)}</td>
                        <td className={`px-3 ${HROW} text-right`}>{fmtNum(m.guests)}</td>
                        <td className={`px-3 ${HROW} text-right`}>{fmtNum(m.guestUnit)}</td>
                        <td className={`px-3 ${HROW} text-right`}>{pct(m.occ)}</td>
                        <td className={`px-3 ${HROW} text-right`}>{fmtNum(m.adr)}</td>
                        <td className={`px-3 ${HROW} text-right`}>{m.companion?.toFixed(2) ?? '-'}</td>
                        <td className={`px-3 ${HROW} text-right`}>{fmtNum(m.revpar)}</td>
                      </tr>
                    )
                  })}
                  <tr style={{ borderTop: '2px solid var(--border)', background: 'var(--surface2)' }} className="font-semibold">
                    <td className={`px-3 ${HHEAD} whitespace-nowrap`}>合計/平均</td>
                    <td className={`px-3 ${HHEAD} text-right`}>{fmtNum(model.total.sold)}</td>
                    <td className={`px-3 ${HHEAD} text-right`}>{fmtNum(model.total.revenue)}</td>
                    <td className={`px-3 ${HHEAD} text-right`}>{fmtNum(model.total.guests)}</td>
                    <td className={`px-3 ${HHEAD} text-right`}>{fmtNum(model.total.guestUnit)}</td>
                    <td className={`px-3 ${HHEAD} text-right`}>{pct(model.total.occ)}</td>
                    <td className={`px-3 ${HHEAD} text-right`}>{fmtNum(model.total.adr)}</td>
                    <td className={`px-3 ${HHEAD} text-right`}>{model.total.companion?.toFixed(2) ?? '-'}</td>
                    <td className={`px-3 ${HHEAD} text-right`}>{fmtNum(model.total.revpar)}</td>
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
                      {model.rows.map(({ date }) => (
                        <tr key={date} style={{ borderTop: '1px solid var(--border)' }}>
                          {model.snapshots.map((s) => {
                            const rank = model.rankMap[date]?.[s] ?? null
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

          {/* ランク凡例（グラデーション） */}
          <div className="flex items-center gap-2 mt-3 text-xs" style={{ color: 'var(--text-dim)' }}>
            <span>料金ランク</span>
            <span>低</span>
            <span style={{ display: 'inline-block', width: 160, height: 12, borderRadius: 4, background: 'linear-gradient(90deg, hsl(140,78%,55%), hsl(70,78%,45%), hsl(0,78%,35%))' }} />
            <span>高</span>
          </div>
        </>
      )}
    </div>
  )
}

function KpiTooltip({ active, payload, label }: any) {
  if (!active || !payload || payload.length === 0) return null
  return (
    <div style={{ background: '#1a1d27', border: '1px solid #2e3347', borderRadius: 8, padding: '8px 10px', fontSize: 12 }}>
      <div style={{ color: '#8b8fa3', marginBottom: 4 }}>{label}</div>
      {payload.map((p: any, i: number) => {
        const dk: string = p.dataKey
        const suffix = dk.endsWith('_py') ? '（前年同日）' : dk.endsWith('_pm') ? '（前年同月）' : dk.endsWith('_bg') ? '（予算）' : ''
        const base = dk.replace(/_(py|pm|bg)$/, '')
        const kpi = KPIS.find((k) => k.key === base)
        if (!kpi) return null
        const real = p.payload[`${dk}__r`]
        if (real == null) return null
        return (
          <div key={i} style={{ color: '#e4e6f0', display: 'flex', gap: 6, alignItems: 'center' }}>
            <span style={{ color: kpi.color }}>●</span>{kpi.label}{suffix}: {kpi.fmt(real)}
          </div>
        )
      })}
    </div>
  )
}
