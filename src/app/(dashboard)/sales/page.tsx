'use client'

// 売上状況 — 売上分析の入口（宿泊月の軸）。確定実績から先々のオンハンドまでを一気通貫で見る。
// グラフ=チャネル別売上の積み上げ（実数）＋予算線＋前年同日線。表=月次売上と前年同日比/予算比/前年比。
// 月クリックで深堀（チャネル別・部屋タイプ別・プラン別・日別）。予約日の軸（施策の効き）は /booking が担当。
import { useEffect, useMemo, useState, Fragment } from 'react'
import Link from 'next/link'
import { useFacility } from '@/lib/facility-context'
import { supabase } from '@/lib/supabase/client'
import { fetchAll } from '@/lib/supabase/fetch-all'
import {
  ComposedChart, Bar, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, Legend, CartesianGrid,
} from 'recharts'
import { fmtNum, fmtYen, pct, CHART_AXIS, chartTooltip, channelColor } from '@/lib/ui'
import { Loading, Empty, LoadError } from '@/components/page-bits'
import BookingInsightCard from '@/components/booking-insight-card'

interface Resv {
  checkin: string; nights: number | null; revenue_settled: number | null; revenue_net?: number | null; channel: string | null
  status: string | null; booking_date: string | null; cancel_date: string | null
  room_type: string | null; plan: string | null; guests_total: number | null
}
interface BudgetRow { month: string; revenue_budget: number | null }

const ALIVE = new Set(['未確認', '予約確定', '重要予約', 'C/O'])  // 非キャンセル＝売上として生きている予約
const TOP_CHANNELS = 6

const todayISO = () => new Date().toISOString().slice(0, 10)
const fyOf = (ym: string) => { const y = +ym.slice(0, 4), m = +ym.slice(5, 7); return m >= 4 ? y : y - 1 }
const fyMonths = (fy: number) => {
  const out: string[] = []
  for (let m = 4; m <= 12; m++) out.push(`${fy}-${String(m).padStart(2, '0')}`)
  for (let m = 1; m <= 3; m++) out.push(`${fy + 1}-${String(m).padStart(2, '0')}`)
  return out
}
const shiftYr = (k: string) => `${+k.slice(0, 4) - 1}${k.slice(4)}`

export default function SalesStatusPage() {
  const { current } = useFacility()
  const thisFy = fyOf(todayISO().slice(0, 7))
  const [fy, setFy] = useState(thisFy)
  const [resv, setResv] = useState<Resv[]>([])
  const [budget, setBudget] = useState<Record<string, number>>({})
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [openMonth, setOpenMonth] = useState<string | null>(null)

  useEffect(() => {
    if (!current) return
    setLoading(true); setLoadError(''); setOpenMonth(null)
    const from = `${fy - 1}-04-01`, to = `${fy + 1}-03-31`  // 前年度も同時取得（前年比・前年同日用）
    Promise.all([
      fetchAll<Resv>(() => supabase.from('raw_reservation')
        .select('checkin, nights, revenue_settled, revenue_net, channel, status, booking_date, cancel_date, room_type, plan, guests_total')
        .eq('facility', current).gte('checkin', from).lte('checkin', to)),
      fetchAll<BudgetRow>(() => supabase.from('mart_budget_daily_monthly').select('month, revenue_budget').eq('facility', current)),
    ]).then(([rs, bs]) => {
      setResv(rs ?? [])
      const bm: Record<string, number> = {}
      ;(bs ?? []).forEach((b) => { if (b.revenue_budget != null) bm[b.month] = b.revenue_budget })
      setBudget(bm)
    }).catch((e: unknown) => setLoadError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false))
  }, [current, fy])

  // 前年同日の基準時点＝ちょうど1年前の今日
  const prevPoint = useMemo(() => shiftYr(todayISO()), [])
  const aliveNow = (r: Resv) => ALIVE.has(r.status ?? '')
  // 前年同日: その時点で入っていた予約（予約済み かつ 未キャンセル）。予約日なし・キャンセル日不明の取消は除外
  const aliveAt = (r: Resv, T: string) =>
    !!r.booking_date && r.booking_date <= T && (r.status !== 'キャンセル' || (!!r.cancel_date && r.cancel_date > T))

  // 月次集計（1パス）: cur=生存予約の売上（実年月キー・前年分も入る） / prevSame=前年同日時点の売上
  const agg = useMemo(() => {
    const cur: Record<string, { total: number; byCh: Record<string, number> }> = {}
    const prevSame: Record<string, number> = {}
    for (const r of resv) {
      const m = r.checkin.slice(0, 7); const rev = (r.revenue_net ?? r.revenue_settled) ?? 0
      if (aliveNow(r)) {
        ;(cur[m] ??= { total: 0, byCh: {} }); cur[m].total += rev
        const ch = r.channel || '不明'; cur[m].byCh[ch] = (cur[m].byCh[ch] ?? 0) + rev
      }
      if (aliveAt(r, prevPoint)) prevSame[m] = (prevSame[m] ?? 0) + rev
    }
    return { cur, prevSame }
  }, [resv, prevPoint])  // eslint-disable-line react-hooks/exhaustive-deps

  const months = useMemo(() => fyMonths(fy), [fy])
  const rows = useMemo(() => months.map((m) => {
    const pm = shiftYr(m)
    return {
      m,
      sales: agg.cur[m]?.total ?? 0,
      byCh: agg.cur[m]?.byCh ?? {},
      prevSame: agg.prevSame[pm] ?? 0,
      prevSales: agg.cur[pm]?.total ?? 0,
      bud: budget[m] ?? null,
    }
  }), [months, agg, budget])
  const hasData = rows.some((r) => r.sales > 0 || r.prevSales > 0)

  // 合計行
  const tot = useMemo(() => {
    const sales = rows.reduce((s, r) => s + r.sales, 0)
    const prevSame = rows.reduce((s, r) => s + r.prevSame, 0)
    const prevSales = rows.reduce((s, r) => s + r.prevSales, 0)
    const bud = rows.reduce((s, r) => s + (r.bud ?? 0), 0)
    return { sales, prevSame, prevSales, bud }
  }, [rows])

  // チャネルランク（当年度の売上・上位6＋その他）
  const channelRank = useMemo(() => {
    const t: Record<string, number> = {}
    for (const r of rows) for (const [ch, v] of Object.entries(r.byCh)) t[ch] = (t[ch] ?? 0) + v
    return Object.entries(t).sort((a, b) => b[1] - a[1]).map(([c]) => c)
  }, [rows])
  const topChannels = channelRank.slice(0, TOP_CHANNELS)
  const channels = channelRank.length > TOP_CHANNELS ? [...topChannels, 'その他'] : topChannels

  const chartData = useMemo(() => rows.map((r) => {
    const row: Record<string, string | number | null> = { month: r.m.slice(2), full: r.m }
    for (const c of channels) row[c] = 0
    for (const [ch, v] of Object.entries(r.byCh)) {
      const k = topChannels.includes(ch) ? ch : 'その他'
      row[k] = (row[k] as number) + v
    }
    row['予算'] = r.bud
    row['前年同日'] = r.prevSame > 0 ? r.prevSame : null
    return row
  }), [rows, channels, topChannels])

  const cm = todayISO().slice(0, 7)
  const ratioColor = (v: number | null) => (v == null ? undefined : v >= 1 ? 'var(--green)' : v >= 0.9 ? undefined : 'var(--red)')

  return (
    <div className="p-6">
      <BookingInsightCard />

      <div className="flex items-center gap-2 mb-4 flex-wrap">
        <select className="field px-3 py-1.5 text-sm" value={fy} onChange={(e) => setFy(Number(e.target.value))}>
          {[thisFy + 1, thisFy, thisFy - 1, thisFy - 2, thisFy - 3].map((y) => <option key={y} value={y}>{y}年度</option>)}
        </select>
        <span className="text-xs" style={{ color: 'var(--text-dim)' }}>
          宿泊月の売上（過去月=実績・当月以降=オンハンド）。前年同日={prevPoint}時点の前年の入り。
        </span>
      </div>

      {loading ? <Loading /> : loadError ? <LoadError message={loadError} /> : !hasData ? (
        <Empty message="この年度の予約データがありません。予約情報CSV（全ステータス）を /upload から取り込んでください。" />
      ) : (
        <>
          {/* グラフ: チャネル別売上の積み上げ＋予算線＋前年同日線（実数のみ） */}
          <div className="card p-4 mb-4">
            <ResponsiveContainer width="100%" height={360}>
              <ComposedChart data={chartData} margin={{ top: 8, right: 12, bottom: 5, left: 8 }}>
                <CartesianGrid stroke="#e7dac6" vertical={false} />
                <XAxis dataKey="month" {...CHART_AXIS} />
                <YAxis {...CHART_AXIS} tickFormatter={(v) => `${Math.round(Number(v) / 10000)}万`} />
                <Tooltip {...chartTooltip} labelFormatter={(l: any, p: any) => (p?.[0]?.payload?.full ?? l)} formatter={(v: any, n: any) => [fmtYen(Number(v)), n]} />
                <Legend wrapperStyle={{ fontSize: 11 }} />
                {channels.map((c) => (
                  <Bar key={c} dataKey={c} stackId="s" maxBarSize={34} fill={c === 'その他' ? '#B4B2A9' : channelColor(c)} />
                ))}
                <Line dataKey="予算" stroke="#8d7b64" strokeWidth={2} dot={false} connectNulls />
                <Line dataKey="前年同日" stroke="#C0392B" strokeWidth={2} strokeDasharray="5 3" dot={false} connectNulls />
              </ComposedChart>
            </ResponsiveContainer>
            <p className="text-[10px] mt-1" style={{ color: 'var(--text-dim)' }}>
              棒＝チャネル別売上（実数）、実線＝予算売上、赤破線＝前年同日売上（1年前の同じ日に入っていた前年の予約）。
            </p>
          </div>

          {/* 月次表 */}
          <div className="card overflow-x-auto">
            <table className="w-full text-sm whitespace-nowrap">
              <thead>
                <tr style={{ background: 'var(--surface2)', color: 'var(--text-dim)' }} className="text-left">
                  <th className="px-3 py-2">月</th>
                  <th className="px-3 py-2 text-right">売上</th>
                  <th className="px-3 py-2 text-right">前年同日売上</th>
                  <th className="px-3 py-2 text-right">前年同日比</th>
                  <th className="px-3 py-2 text-right">予算売上</th>
                  <th className="px-3 py-2 text-right">予算比</th>
                  <th className="px-3 py-2 text-right">前年売上</th>
                  <th className="px-3 py-2 text-right">前年比</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const open = openMonth === r.m
                  const rSame = r.prevSame > 0 ? r.sales / r.prevSame : null
                  const rBud = r.bud ? r.sales / r.bud : null
                  const rPrev = r.prevSales > 0 ? r.sales / r.prevSales : null
                  const future = r.m >= cm
                  return (
                    <Fragment key={r.m}>
                      <tr style={{ borderTop: '1px solid var(--border)', cursor: 'pointer', background: future ? 'rgba(216,90,48,0.04)' : undefined }}
                        onClick={() => setOpenMonth(open ? null : r.m)}>
                        <td className="px-3 py-2 font-medium">
                          {r.m}
                          {future && <span className="ml-1 text-[9px] px-1 py-0.5 rounded" style={{ background: 'var(--surface2)', color: 'var(--text-dim)' }}>OH</span>}
                          <span className="ml-1 text-[10px]" style={{ color: 'var(--text-dim)' }}>{open ? '▲' : '▼'}</span>
                        </td>
                        <td className="px-3 py-2 text-right font-medium">{fmtYen(r.sales)}</td>
                        <td className="px-3 py-2 text-right" style={{ color: 'var(--text-dim)' }}>{r.prevSame > 0 ? fmtYen(r.prevSame) : '-'}</td>
                        <td className="px-3 py-2 text-right" style={{ color: ratioColor(rSame) }}>{rSame != null ? pct(rSame) : '-'}</td>
                        <td className="px-3 py-2 text-right" style={{ color: 'var(--text-dim)' }}>{r.bud != null ? fmtYen(r.bud) : '-'}</td>
                        <td className="px-3 py-2 text-right" style={{ color: ratioColor(rBud) }}>{rBud != null ? pct(rBud) : '-'}</td>
                        <td className="px-3 py-2 text-right" style={{ color: 'var(--text-dim)' }}>{r.prevSales > 0 ? fmtYen(r.prevSales) : '-'}</td>
                        <td className="px-3 py-2 text-right" style={{ color: ratioColor(rPrev) }}>{rPrev != null ? pct(rPrev) : '-'}</td>
                      </tr>
                      {open && (
                        <tr>
                          <td colSpan={8} className="px-3 pb-3" style={{ background: 'var(--surface2)' }}>
                            <SalesDrill mon={r.m} resv={resv} prevPoint={prevPoint} />
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  )
                })}
                <tr style={{ borderTop: '2px solid var(--border)', background: 'var(--surface2)' }}>
                  <td className="px-3 py-2 font-bold">年度合計</td>
                  <td className="px-3 py-2 text-right font-bold">{fmtYen(tot.sales)}</td>
                  <td className="px-3 py-2 text-right" style={{ color: 'var(--text-dim)' }}>{tot.prevSame > 0 ? fmtYen(tot.prevSame) : '-'}</td>
                  <td className="px-3 py-2 text-right font-medium" style={{ color: ratioColor(tot.prevSame > 0 ? tot.sales / tot.prevSame : null) }}>{tot.prevSame > 0 ? pct(tot.sales / tot.prevSame) : '-'}</td>
                  <td className="px-3 py-2 text-right" style={{ color: 'var(--text-dim)' }}>{tot.bud > 0 ? fmtYen(tot.bud) : '-'}</td>
                  <td className="px-3 py-2 text-right font-medium" style={{ color: ratioColor(tot.bud > 0 ? tot.sales / tot.bud : null) }}>{tot.bud > 0 ? pct(tot.sales / tot.bud) : '-'}</td>
                  <td className="px-3 py-2 text-right" style={{ color: 'var(--text-dim)' }}>{tot.prevSales > 0 ? fmtYen(tot.prevSales) : '-'}</td>
                  <td className="px-3 py-2 text-right font-medium" style={{ color: ratioColor(tot.prevSales > 0 ? tot.sales / tot.prevSales : null) }}>{tot.prevSales > 0 ? pct(tot.sales / tot.prevSales) : '-'}</td>
                </tr>
              </tbody>
            </table>
          </div>
          <p className="text-xs mt-2" style={{ color: 'var(--text-dim)' }}>
            売上＝非キャンセル予約（未確認・確定・重要・C/O）の精算額をチェックイン月に計上（OH＝当月以降のオンハンド）。
            前年同日＝前年の同じ日付時点の入りを予約日×キャンセル日から再構築（予約日の記録がある予約のみ。終了月は前年売上とほぼ一致）。
            予算＝日別売上予算の月次ロールアップ。月クリックでチャネル別・部屋タイプ別の深堀。
          </p>
        </>
      )}
    </div>
  )
}

// ============================================================
// 月ドリルダウン: 日別チャネル積み上げ＋チャネル別(当年vs前年同日)＋部屋タイプ/プラン別＋リンク
// ============================================================
function SalesDrill({ mon, resv, prevPoint }: { mon: string; resv: Resv[]; prevPoint: string }) {
  const pm = shiftYr(mon)
  const aliveNow = (r: Resv) => ALIVE.has(r.status ?? '')
  const aliveAt = (r: Resv, T: string) =>
    !!r.booking_date && r.booking_date <= T && (r.status !== 'キャンセル' || (!!r.cancel_date && r.cancel_date > T))

  // 月サマリ: 客単価・室単価・稼働率（当年 vs 前年同日）。在庫=客室数×日数（設定の月別客室数を反映）
  const { current, currentFacility } = useFacility()
  const [odRooms, setOdRooms] = useState<Record<string, number>>({})
  useEffect(() => {
    if (!current) return
    supabase.from('dim_operating_days').select('month, rooms').eq('facility', current).in('month', [mon, pm])
      .then(({ data }) => {
        const o: Record<string, number> = {}
        for (const r of (data ?? []) as { month: string; rooms: number | null }[]) if (r.rooms != null) o[r.month] = r.rooms
        setOdRooms(o)
      })
  }, [current, mon, pm])
  const kpiSum = (pred: (r: Resv) => boolean) => {
    let rev = 0, rn = 0, gn = 0
    for (const r of resv) { if (!pred(r)) continue; const n = Math.max(r.nights ?? 1, 1); rev += (r.revenue_net ?? r.revenue_settled) ?? 0; rn += n; gn += (r.guests_total ?? 0) * n }
    return { rev, rn, gn }
  }
  const kCur = kpiSum((r) => r.checkin.slice(0, 7) === mon && aliveNow(r))
  const kPrev = kpiSum((r) => r.checkin.slice(0, 7) === pm && aliveAt(r, prevPoint))
  const dimDays = (ym: string) => { const [y, m2] = ym.split('-').map(Number); return new Date(y, m2, 0).getDate() }
  const invOf = (ym: string) => { const rooms = odRooms[ym] ?? currentFacility?.total_rooms ?? null; return rooms != null ? rooms * dimDays(ym) : null }
  const occCur = invOf(mon) ? kCur.rn / invOf(mon)! : null
  const occPrev = invOf(pm) ? kPrev.rn / invOf(pm)! : null

  // 日別チャネル積み上げ（当該月・泊分割・売上を泊数按分）
  const daily = useMemo(() => {
    const acc: Record<string, Record<string, number>> = {}
    for (const r of resv) {
      if (!aliveNow(r)) continue
      const n = Math.max(r.nights ?? 1, 1)
      const perNight = ((r.revenue_net ?? r.revenue_settled) ?? 0) / n
      const base = new Date(r.checkin + 'T00:00:00Z')
      for (let i = 0; i < n; i++) {
        const d = new Date(base); d.setUTCDate(d.getUTCDate() + i)
        const iso = d.toISOString().slice(0, 10)
        if (iso.slice(0, 7) !== mon) continue
        const ch = r.channel || '不明'
        ;(acc[iso] ??= {}); acc[iso][ch] = (acc[iso][ch] ?? 0) + perNight
      }
    }
    return acc
  }, [resv, mon])  // eslint-disable-line react-hooks/exhaustive-deps

  const dayChannels = useMemo(() => {
    const t: Record<string, number> = {}
    for (const per of Object.values(daily)) for (const [ch, v] of Object.entries(per)) t[ch] = (t[ch] ?? 0) + v
    return Object.entries(t).sort((a, b) => b[1] - a[1]).map(([c]) => c).slice(0, TOP_CHANNELS)
  }, [daily])

  const dayChart = useMemo(() => {
    const [y, m] = mon.split('-').map(Number)
    const days = new Date(y, m, 0).getDate()
    return Array.from({ length: days }, (_, i) => {
      const iso = `${mon}-${String(i + 1).padStart(2, '0')}`
      const row: Record<string, string | number> = { d: String(i + 1), full: iso }
      const per = daily[iso] ?? {}
      for (const c of dayChannels) row[c] = Math.round(per[c] ?? 0)
      let other = 0
      for (const [ch, v] of Object.entries(per)) if (!dayChannels.includes(ch)) other += v
      row['その他'] = Math.round(other)
      return row
    })
  }, [daily, dayChannels, mon])

  // チャネル別: 当年（売上/室泊/単価） vs 前年同日（売上/室泊/単価）
  const byChannel = useMemo(() => {
    const acc: Record<string, { rev: number; rn: number; pRev: number; pRn: number }> = {}
    for (const r of resv) {
      const cm2 = r.checkin.slice(0, 7)
      const ch = r.channel || '不明'
      const n = Math.max(r.nights ?? 1, 1)
      if (cm2 === mon && aliveNow(r)) { (acc[ch] ??= { rev: 0, rn: 0, pRev: 0, pRn: 0 }); acc[ch].rev += (r.revenue_net ?? r.revenue_settled) ?? 0; acc[ch].rn += n }
      if (cm2 === pm && aliveAt(r, prevPoint)) { (acc[ch] ??= { rev: 0, rn: 0, pRev: 0, pRn: 0 }); acc[ch].pRev += (r.revenue_net ?? r.revenue_settled) ?? 0; acc[ch].pRn += n }
    }
    return Object.entries(acc).sort((a, b) => b[1].rev - a[1].rev)
  }, [resv, mon, pm, prevPoint])  // eslint-disable-line react-hooks/exhaustive-deps

  // 部屋タイプ別・プラン別（室泊: 当年 vs 前年最終・上位8）
  // 部屋タイプ別・プラン別: 前年は「前年同日時点」で再構築（今と同じ土俵で比較）
  const ptRows = (key: 'room_type' | 'plan') => {
    const cm2: Record<string, number> = {}; const pm2: Record<string, number> = {}
    for (const r of resv) {
      const mm = r.checkin.slice(0, 7); const k = (r[key] as string) || '不明'
      const n = Math.max(r.nights ?? 1, 1)
      if (mm === mon && aliveNow(r)) cm2[k] = (cm2[k] ?? 0) + n
      if (mm === pm && aliveAt(r, prevPoint)) pm2[k] = (pm2[k] ?? 0) + n
    }
    return [...new Set([...Object.keys(cm2), ...Object.keys(pm2)])]
      .map((k) => ({ name: k, cur: cm2[k] ?? 0, prev: pm2[k] ?? 0 }))
      .sort((a, b) => b.cur - a.cur).slice(0, 8)
  }
  const unit = (rev: number, rn: number) => (rn > 0 ? Math.round(rev / rn) : null)

  return (
    <div className="py-2 space-y-4">
      {/* 客単価・室単価・稼働率（当年 vs 前年同日） */}
      <div>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <KpiMini label="客単価" cur={kCur.gn > 0 ? kCur.rev / kCur.gn : null} prev={kPrev.gn > 0 ? kPrev.rev / kPrev.gn : null} fmt={(v) => fmtYen(Math.round(v))} />
          <KpiMini label="室単価" cur={kCur.rn > 0 ? kCur.rev / kCur.rn : null} prev={kPrev.rn > 0 ? kPrev.rev / kPrev.rn : null} fmt={(v) => fmtYen(Math.round(v))} />
          <KpiMini label="稼働率" cur={occCur} prev={occPrev} fmt={(v) => pct(v)} />
        </div>
        <p className="text-[10px] mt-1" style={{ color: 'var(--text-dim)' }}>
          客単価=売上÷人泊、室単価=売上÷室泊、稼働率=室泊÷在庫（客室数×日数・設定の月別客室数を反映）。前年はいずれも前年同日時点。
        </p>
      </div>

      {/* 日別チャネル積み上げ */}
      <div>
        <div className="text-xs font-semibold mb-1">{mon} 日別売上（チャネル積み上げ・泊按分）</div>
        <ResponsiveContainer width="100%" height={180}>
          <ComposedChart data={dayChart} margin={{ top: 4, right: 8, bottom: 0, left: 8 }}>
            <CartesianGrid stroke="#e7dac6" vertical={false} />
            <XAxis dataKey="d" {...CHART_AXIS} interval={2} />
            <YAxis {...CHART_AXIS} tickFormatter={(v) => `${Math.round(Number(v) / 10000)}万`} />
            <Tooltip {...chartTooltip} labelFormatter={(l: any, p: any) => (p?.[0]?.payload?.full ?? l)} formatter={(v: any, n: any) => [fmtYen(Number(v)), n]} />
            {[...dayChannels, 'その他'].map((c) => (
              <Bar key={c} dataKey={c} stackId="s" maxBarSize={16} fill={c === 'その他' ? '#B4B2A9' : channelColor(c)} />
            ))}
          </ComposedChart>
        </ResponsiveContainer>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* チャネル別 当年 vs 前年同日 */}
        <div>
          <div className="text-xs font-semibold mb-1">チャネル別（当年 vs 前年同日）</div>
          <table className="w-full text-xs">
            <thead><tr style={{ color: 'var(--text-dim)' }} className="text-left">
              <th className="py-1">チャネル</th><th className="py-1 text-right">売上</th><th className="py-1 text-right">前年同日</th>
              <th className="py-1 text-right">室泊</th><th className="py-1 text-right">前年同日</th>
              <th className="py-1 text-right">単価</th><th className="py-1 text-right">前年同日</th>
            </tr></thead>
            <tbody>
              {byChannel.map(([ch, v]) => (
                <tr key={ch} style={{ borderTop: '1px solid var(--border)' }}>
                  <td className="py-1"><span className="inline-flex items-center gap-1"><span className="inline-block w-2 h-2 rounded-full" style={{ background: channelColor(ch) }} />{ch}</span></td>
                  <td className="py-1 text-right font-medium">{fmtYen(v.rev)}</td>
                  <td className="py-1 text-right" style={{ color: v.pRev > 0 && v.rev < v.pRev ? 'var(--red)' : 'var(--text-dim)' }}>{v.pRev > 0 ? fmtYen(v.pRev) : '-'}</td>
                  <td className="py-1 text-right">{fmtNum(v.rn)}</td>
                  <td className="py-1 text-right" style={{ color: 'var(--text-dim)' }}>{v.pRn > 0 ? fmtNum(v.pRn) : '-'}</td>
                  <td className="py-1 text-right">{unit(v.rev, v.rn) != null ? fmtNum(unit(v.rev, v.rn)) : '-'}</td>
                  <td className="py-1 text-right" style={{ color: 'var(--text-dim)' }}>{unit(v.pRev, v.pRn) != null ? fmtNum(unit(v.pRev, v.pRn)) : '-'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {/* 部屋タイプ別・プラン別 */}
        <div className="space-y-3">
          <MiniPt title="部屋タイプ別（室泊・当年 vs 前年同日）" rows={ptRows('room_type')} />
          <MiniPt title="プラン別（室泊・上位8・当年 vs 前年同日）" rows={ptRows('plan')} />
        </div>
      </div>

      <div className="flex items-center gap-2 text-xs flex-wrap">
        <span style={{ color: 'var(--text-dim)' }}>{mon} を詳しく →</span>
        <Link href={`/revenue?month=${mon}`} className="px-2.5 py-1 rounded-md" style={{ background: 'var(--surface)', border: '1px solid var(--border)', color: 'var(--accent)' }}>
          月別売上分析
        </Link>
        <Link href={`/sameday?month=${mon}`} className="px-2.5 py-1 rounded-md" style={{ background: 'var(--surface)', border: '1px solid var(--border)', color: 'var(--accent)' }}>
          前年同日分析
        </Link>
        <Link href={`/daily?month=${mon}`} className="px-2.5 py-1 rounded-md" style={{ background: 'var(--surface)', border: '1px solid var(--border)', color: 'var(--accent)' }}>
          日別売上分析
        </Link>
      </div>
    </div>
  )
}

function KpiMini({ label, cur, prev, fmt }: { label: string; cur: number | null; prev: number | null; fmt: (v: number) => string }) {
  const ratio = cur != null && prev != null && prev > 0 ? cur / prev : null
  return (
    <div className="rounded-md px-3 py-2" style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}>
      <div className="text-[10px]" style={{ color: 'var(--text-dim)' }}>{label}（当年 / 前年同日）</div>
      <div className="text-sm font-semibold">
        {cur != null ? fmt(cur) : '-'}
        <span className="text-xs font-normal ml-1" style={{ color: 'var(--text-dim)' }}>/ {prev != null ? fmt(prev) : '-'}</span>
        {ratio != null && <span className="text-xs ml-2 font-medium" style={{ color: ratio >= 1 ? 'var(--green)' : 'var(--red)' }}>{pct(ratio)}</span>}
      </div>
    </div>
  )
}

function MiniPt({ title, rows }: { title: string; rows: { name: string; cur: number; prev: number }[] }) {
  return (
    <div>
      <div className="text-xs font-semibold mb-1">{title}</div>
      {rows.length === 0 ? <p className="text-[11px]" style={{ color: 'var(--text-dim)' }}>データなし</p> : (
        <table className="w-full text-xs">
          <thead><tr style={{ color: 'var(--text-dim)' }} className="text-left">
            <th className="py-1">名称</th><th className="py-1 text-right">当年</th><th className="py-1 text-right">前年同日</th><th className="py-1 text-right">前年同日比</th>
          </tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.name} style={{ borderTop: '1px solid var(--border)' }}>
                <td className="py-1" style={{ maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.name.slice(0, 24)}</td>
                <td className="py-1 text-right font-medium">{fmtNum(r.cur)}</td>
                <td className="py-1 text-right" style={{ color: 'var(--text-dim)' }}>{fmtNum(r.prev)}</td>
                <td className="py-1 text-right" style={{ color: r.prev > 0 && r.cur < r.prev ? 'var(--red)' : undefined }}>{r.prev > 0 ? pct(r.cur / r.prev) : '-'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}
