'use client'

// 予約日ベース分析（M5-M7）— 「施策を打ったら予約がどう動いたか」を予約日の軸で見る。
//  タブ1 積み上げ(M5): OTA別積み上げ棒＋前年同期線＋施策帯
//  タブ2 前年同日比較(M6): 予約日/宿泊日ベースの当年vs前年、月クリックでOTA→室数/単価→施策のドリルダウン
//  タブ3 ブッキングカーブ(M7): 宿泊月のD-n軌跡を予約日×キャンセル日から再構築、前年同月を重ねる
// 要因の判断（在庫か料金か）は人。灯は分解と照合まで（要件§4）。
import { useEffect, useMemo, useState, Fragment } from 'react'
import { useFacility } from '@/lib/facility-context'
import { supabase } from '@/lib/supabase/client'
import { fetchAll } from '@/lib/supabase/fetch-all'
import {
  ComposedChart, Bar, Line, LineChart, XAxis, YAxis, Tooltip, ResponsiveContainer, Legend, CartesianGrid, ReferenceArea,
} from 'recharts'
import { fmtNum, fmtYen, pct, CHART_AXIS, chartTooltip, channelColor } from '@/lib/ui'
import { Loading, Empty, LoadError } from '@/components/page-bits'

interface FlowRow {
  flow_date: string; channel: string
  new_reservations: number | null; new_room_nights: number | null; new_revenue: number | null
  cxl_reservations: number | null; cxl_room_nights: number | null; cxl_revenue: number | null
  net_reservations: number | null; net_room_nights: number | null; net_revenue: number | null
}
interface CurveRow { stay_date: string; channel: string; booking_date: string | null; cancel_date: string | null; lead_days: number | null; rooms: number | null; revenue: number | null }
interface OnhandRow { stay_date: string; channel: string; rooms: number | null; guests: number | null; revenue: number | null }
interface Action {
  id: number; channel: string | null; action_type: string; title: string
  start_date: string; end_date: string | null; cost: number | null; memo: string | null; decided_date: string | null
}

type Metric = 'reservations' | 'room_nights' | 'revenue'
const METRIC_LABEL: Record<Metric, string> = { reservations: '予約件数', room_nights: '室泊', revenue: '金額' }
const ACTION_COLOR: Record<string, string> = {
  広告: '#D85A30', クーポン: '#1D9E75', セール参加: '#378ADD', ランク変更: '#7F77DD', プラン: '#C99A2E', その他: '#888780',
}
const TOP_CHANNELS = 6
const shiftYr = (k: string) => `${Number(k.slice(0, 4)) - 1}${k.slice(4)}`
const fmtMetric = (v: number, m: Metric) => (m === 'revenue' ? fmtYen(v) : fmtNum(v))
const daysBetween = (a: string, b: string) => Math.round((Date.parse(a + 'T00:00:00Z') - Date.parse(b + 'T00:00:00Z')) / 86400000)

export default function BookingPage() {
  const { current } = useFacility()
  const [flow, setFlow] = useState<FlowRow[]>([])
  const [actions, setActions] = useState<Action[]>([])
  const [curve, setCurve] = useState<CurveRow[] | null>(null)
  const [onhand, setOnhand] = useState<OnhandRow[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [view, setView] = useState<'stack' | 'yoy' | 'curve' | 'onhand'>('stack')

  useEffect(() => {
    if (!current) return
    setLoading(true); setLoadError(''); setCurve(null); setOnhand(null)
    Promise.all([
      fetchAll<FlowRow>(() => supabase.from('mart_booking_flow').select('*').eq('facility', current)),
      fetchAll<Action>(() => supabase.from('raw_marketing_action')
        .select('id, channel, action_type, title, start_date, end_date, cost, memo, decided_date').eq('facility', current)),
    ]).then(([f, a]) => { setFlow(f ?? []); setActions(a ?? []) })
      .catch((e: unknown) => setLoadError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false))
  }, [current])

  // 宿泊日ベース/カーブは重いので必要時のみ取得
  useEffect(() => {
    if (!current || !(view === 'yoy' || view === 'curve') || curve !== null) return
    fetchAll<CurveRow>(() => supabase.from('mart_booking_curve')
      .select('stay_date, channel, booking_date, cancel_date, lead_days, rooms, revenue').eq('facility', current))
      .then((c) => setCurve(c ?? [])).catch(() => setCurve([]))
  }, [current, view, curve])
  useEffect(() => {
    if (!current || view !== 'onhand' || onhand !== null) return
    fetchAll<OnhandRow>(() => supabase.from('mart_onhand').select('stay_date, channel, rooms, guests, revenue').eq('facility', current))
      .then((o) => setOnhand(o ?? [])).catch(() => setOnhand([]))
  }, [current, view, onhand])

  return (
    <div className="p-6">
      <div className="flex rounded-md overflow-hidden mb-4 w-fit" style={{ border: '1px solid var(--border)' }}>
        {([['stack', '予約日ベース積み上げ'], ['yoy', '前年同日比較'], ['curve', 'ブッキングカーブ'], ['onhand', 'オンハンド断面']] as const).map(([v, l]) => (
          <button key={v} onClick={() => setView(v)} className="px-4 py-1.5 text-xs font-medium"
            style={{ background: view === v ? 'var(--accent)' : 'var(--surface)', color: view === v ? '#fff' : 'var(--text-dim)' }}>{l}</button>
        ))}
      </div>

      {loading ? <Loading /> : loadError ? <LoadError message={loadError} /> : flow.length === 0 && (curve?.length ?? 0) === 0 ? (
        <Empty message="予約情報CSV（全ステータス）を /upload から取り込むと、予約日ベースの動きが表示されます。" />
      ) : view === 'stack' ? <StackView flow={flow} actions={actions} />
        : view === 'yoy' ? <YoyView flow={flow} curve={curve} actions={actions} />
        : view === 'curve' ? <CurveView curve={curve} />
        : <OnhandView onhand={onhand} />}
    </div>
  )
}

// ============================================================
// M5: 予約日ベース積み上げ
// ============================================================
function StackView({ flow, actions }: { flow: FlowRow[]; actions: Action[] }) {
  const [mode, setMode] = useState<'day' | 'month'>('month')
  const [metric, setMetric] = useState<Metric>('room_nights')
  const [basis, setBasis] = useState<'new' | 'net'>('new')
  const [dayMonth, setDayMonth] = useState('')

  const valOf = (r: FlowRow) => (r[`${basis}_${metric}` as keyof FlowRow] as number | null) ?? 0
  const monthOptions = useMemo(() => [...new Set(flow.map((r) => r.flow_date.slice(0, 7)))].sort().reverse(), [flow])
  const activeDayMonth = dayMonth || monthOptions[0] || ''

  const channelRank = useMemo(() => {
    const t: Record<string, number> = {}
    for (const r of flow) t[r.channel] = (t[r.channel] ?? 0) + (r.new_room_nights ?? 0)
    return [...Object.entries(t)].sort((a, b) => b[1] - a[1]).map(([c]) => c)
  }, [flow])
  const topChannels = channelRank.slice(0, TOP_CHANNELS)
  const channels = channelRank.length > TOP_CHANNELS ? [...topChannels, 'その他'] : topChannels
  const chanKey = (c: string) => (topChannels.includes(c) ? c : 'その他')
  const bucketOf = (d: string) => (mode === 'month' ? d.slice(0, 7) : d)

  const { perBucket, totalByBucket } = useMemo(() => {
    const per: Record<string, Record<string, number>> = {}; const tot: Record<string, number> = {}
    for (const r of flow) {
      const b = bucketOf(r.flow_date); const v = valOf(r); const ck = chanKey(r.channel)
      ;(per[b] ??= {}); per[b][ck] = (per[b][ck] ?? 0) + v; tot[b] = (tot[b] ?? 0) + v
    }
    return { perBucket: per, totalByBucket: tot }
  }, [flow, mode, metric, basis, channelRank])  // eslint-disable-line react-hooks/exhaustive-deps

  const buckets = useMemo(() => {
    if (mode === 'month') return Object.keys(perBucket).sort()
    if (!activeDayMonth) return []
    const [y, m] = activeDayMonth.split('-').map(Number)
    return Array.from({ length: new Date(y, m, 0).getDate() }, (_, i) => `${activeDayMonth}-${String(i + 1).padStart(2, '0')}`)
  }, [mode, perBucket, activeDayMonth])

  const chartData = useMemo(() => buckets.map((b) => {
    const row: Record<string, string | number | null> = { bucket: mode === 'month' ? b.slice(2) : b.slice(8), full: b }
    const per = perBucket[b] ?? {}
    for (const c of channels) row[c] = per[c] ?? 0
    const prev = totalByBucket[shiftYr(b)]
    row['前年'] = prev != null ? prev : null
    return row
  }), [buckets, perBucket, totalByBucket, channels, mode])

  const hasData = chartData.some((d) => channels.some((c) => (d[c] as number) !== 0))
  const rangeFrom = buckets[0] ?? ''; const rangeTo = buckets[buckets.length - 1] ?? ''
  const visibleActions = useMemo(() => actions.filter((a) => {
    const s = mode === 'month' ? a.start_date.slice(0, 7) : a.start_date
    const e = mode === 'month' ? (a.end_date ?? a.start_date).slice(0, 7) : (a.end_date ?? a.start_date)
    return e >= rangeFrom && s <= rangeTo
  }).sort((a, b) => a.start_date.localeCompare(b.start_date)), [actions, mode, rangeFrom, rangeTo])
  const bandFor = (a: Action) => {
    const s = mode === 'month' ? a.start_date.slice(0, 7) : a.start_date
    const e = mode === 'month' ? (a.end_date ?? a.start_date).slice(0, 7) : (a.end_date ?? a.start_date)
    const inR = buckets.filter((b) => b >= s && b <= e); if (!inR.length) return null
    const disp = (b: string) => (mode === 'month' ? b.slice(2) : b.slice(8))
    return { x1: disp(inR[0]), x2: disp(inR[inR.length - 1]) }
  }

  return (
    <>
      <div className="flex items-center gap-2 mb-4 flex-wrap">
        <Seg value={mode} set={setMode} opts={[['month', '月別'], ['day', '日別']]} />
        <Seg value={metric} set={setMetric} opts={[['reservations', '件数'], ['room_nights', '室泊'], ['revenue', '金額']]} />
        <Seg value={basis} set={setBasis} opts={[['new', '新規'], ['net', 'ネット']]} />
        {mode === 'day' && monthOptions.length > 0 && (
          <select className="field px-3 py-1.5 text-sm" value={activeDayMonth} onChange={(e) => setDayMonth(e.target.value)}>
            {monthOptions.map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
        )}
      </div>
      {visibleActions.length > 0 && (
        <div className="flex items-center gap-2 mb-2 flex-wrap">
          <span className="text-[10px]" style={{ color: 'var(--text-dim)' }}>施策帯:</span>
          {visibleActions.map((a) => (
            <span key={a.id} title={`${a.start_date}${a.end_date && a.end_date !== a.start_date ? ` 〜 ${a.end_date}` : ''}${a.memo ? ` / ${a.memo}` : ''}`}
              className="text-[10px] px-1.5 py-0.5 rounded text-white" style={{ background: ACTION_COLOR[a.action_type] ?? '#888780' }}>{a.title}</span>
          ))}
        </div>
      )}
      <div className="card p-4">
        {hasData ? (
          <ResponsiveContainer width="100%" height={380}>
            <ComposedChart data={chartData} margin={{ top: 8, right: 12, bottom: 5, left: metric === 'revenue' ? 8 : -14 }}>
              <CartesianGrid stroke="#e7dac6" vertical={false} />
              <XAxis dataKey="bucket" {...CHART_AXIS} interval={mode === 'day' ? 2 : Math.max(0, Math.floor(chartData.length / 16))} />
              <YAxis {...CHART_AXIS} allowDecimals={false} tickFormatter={metric === 'revenue' ? (v) => `${Math.round(Number(v) / 10000)}万` : undefined} />
              <Tooltip {...chartTooltip} labelFormatter={(l: any, p: any) => (p?.[0]?.payload?.full ?? l)} formatter={(v: any, n: any) => [fmtMetric(Number(v), metric), n]} />
              <Legend wrapperStyle={{ fontSize: 11 }} />
              {visibleActions.map((a) => { const b = bandFor(a); return b ? <ReferenceArea key={a.id} x1={b.x1} x2={b.x2} fill={ACTION_COLOR[a.action_type] ?? '#888780'} fillOpacity={0.10} ifOverflow="extendDomain" /> : null })}
              {channels.map((c) => <Bar key={c} dataKey={c} stackId="s" maxBarSize={mode === 'day' ? 20 : 30} fill={c === 'その他' ? '#B4B2A9' : channelColor(c)} />)}
              <Line dataKey="前年" name="前年同期" stroke="#C0392B" strokeWidth={2} dot={false} connectNulls />
            </ComposedChart>
          </ResponsiveContainer>
        ) : <p className="text-sm py-16 text-center" style={{ color: 'var(--text-dim)' }}>この範囲に予約日ベースのデータがありません。</p>}
        <p className="text-[10px] mt-1" style={{ color: 'var(--text-dim)' }}>
          棒＝OTA別{METRIC_LABEL[metric]}（{basis === 'net' ? 'ネット' : '新規'}・予約日で計上）、赤線＝前年同期、帯＝施策の実行期間。
          {basis === 'net' && ' ネットはキャンセル日で相殺（cancel_date取込後に有効）。'}
        </p>
      </div>
    </>
  )
}

// ============================================================
// M6: 前年同日比較 ＋ ドリルダウン
// ============================================================
function YoyView({ flow, curve, actions }: { flow: FlowRow[]; curve: CurveRow[] | null; actions: Action[] }) {
  const [basis, setBasis] = useState<'booking' | 'stay'>('booking')
  const [metric, setMetric] = useState<'room_nights' | 'revenue'>('room_nights')
  const [openMonth, setOpenMonth] = useState<string | null>(null)

  const needCurve = basis === 'stay'
  // 月×チャネルの値（予約日ベース=flow新規 / 宿泊日ベース=curveの未キャンセル）
  const byMonthChannel = useMemo(() => {
    const m: Record<string, Record<string, number>> = {}
    const add = (mon: string, ch: string, v: number) => { (m[mon] ??= {}); m[mon][ch] = (m[mon][ch] ?? 0) + v }
    if (basis === 'booking') {
      for (const r of flow) add(r.flow_date.slice(0, 7), r.channel, (metric === 'room_nights' ? r.new_room_nights : r.new_revenue) ?? 0)
    } else {
      for (const r of (curve ?? [])) { if (r.cancel_date) continue; add(r.stay_date.slice(0, 7), r.channel, (metric === 'room_nights' ? (r.rooms ?? 0) : (r.revenue ?? 0))) }
    }
    return m
  }, [flow, curve, basis, metric])

  const totalOf = (mon: string) => Object.values(byMonthChannel[mon] ?? {}).reduce((s, v) => s + v, 0)
  const months = useMemo(() => Object.keys(byMonthChannel).filter((mon) => totalOf(mon) > 0).sort().reverse(), [byMonthChannel])  // eslint-disable-line react-hooks/exhaustive-deps

  if (needCurve && curve === null) return <p className="text-sm py-16 text-center" style={{ color: 'var(--text-dim)' }}>宿泊日ベースを集計中…</p>

  return (
    <>
      <div className="flex items-center gap-2 mb-4 flex-wrap">
        <Seg value={basis} set={setBasis} opts={[['booking', '予約日ベース'], ['stay', '宿泊日ベース']]} />
        <Seg value={metric} set={setMetric} opts={[['room_nights', '室泊'], ['revenue', '金額']]} />
        <span className="text-xs" style={{ color: 'var(--text-dim)' }}>
          {basis === 'booking' ? '予約日で計上（施策の効き）' : '宿泊日で計上（現在の入り・未キャンセル）'}・当年 vs 前年
        </span>
      </div>
      <div className="card overflow-x-auto">
        <table className="w-full text-sm whitespace-nowrap">
          <thead>
            <tr style={{ background: 'var(--surface2)', color: 'var(--text-dim)' }} className="text-left">
              <th className="px-3 py-2">月</th>
              <th className="px-3 py-2 text-right">当年</th>
              <th className="px-3 py-2 text-right">前年</th>
              <th className="px-3 py-2 text-right">差分</th>
              <th className="px-3 py-2 text-right">前年比</th>
              <th className="px-3 py-2"></th>
            </tr>
          </thead>
          <tbody>
            {months.map((mon) => {
              const cur = totalOf(mon); const prev = totalOf(shiftYr(mon))
              const diff = cur - prev; const ratio = prev > 0 ? cur / prev : null
              const open = openMonth === mon
              return (
                <Fragment key={mon}>
                  <tr style={{ borderTop: '1px solid var(--border)', cursor: 'pointer' }} onClick={() => setOpenMonth(open ? null : mon)}>
                    <td className="px-3 py-2 font-medium">{mon} <span className="text-[10px]" style={{ color: 'var(--text-dim)' }}>{open ? '▲' : '▼'}</span></td>
                    <td className="px-3 py-2 text-right font-medium">{fmtMetric(cur, metric)}</td>
                    <td className="px-3 py-2 text-right" style={{ color: 'var(--text-dim)' }}>{prev ? fmtMetric(prev, metric) : '-'}</td>
                    <td className="px-3 py-2 text-right" style={{ color: diff < 0 ? 'var(--red)' : 'var(--green)' }}>{prev ? (diff >= 0 ? '+' : '') + fmtMetric(diff, metric) : '-'}</td>
                    <td className="px-3 py-2 text-right" style={{ color: ratio != null && ratio < 1 ? 'var(--red)' : undefined }}>{ratio != null ? pct(ratio) : '-'}</td>
                    <td className="px-3 py-2"></td>
                  </tr>
                  {open && (
                    <tr>
                      <td colSpan={6} className="px-3 pb-3" style={{ background: 'var(--surface2)' }}>
                        <Drilldown mon={mon} basis={basis} metric={metric} byMonthChannel={byMonthChannel} flow={flow} curve={curve} actions={actions} />
                      </td>
                    </tr>
                  )}
                </Fragment>
              )
            })}
          </tbody>
        </table>
      </div>
      <p className="text-xs mt-2" style={{ color: 'var(--text-dim)' }}>
        月をクリックでOTA別分解→室数/単価分解→施策照合。前年比が落ちた月は、どのOTAが・室数か単価かを見て、当時の施策と前年同月の施策を照合します。要因の判断は人が行います。
      </p>
    </>
  )
}

function Drilldown({ mon, basis, metric, byMonthChannel, flow, curve, actions }: {
  mon: string; basis: 'booking' | 'stay'; metric: 'room_nights' | 'revenue'
  byMonthChannel: Record<string, Record<string, number>>; flow: FlowRow[]; curve: CurveRow[] | null; actions: Action[]
}) {
  const prevMon = shiftYr(mon)
  // OTA別: 室泊・金額の当年/前年（単価=金額/室泊）
  const rnRev = (m: string) => {
    const acc: Record<string, { rn: number; rev: number }> = {}
    if (basis === 'booking') for (const r of flow) { if (r.flow_date.slice(0, 7) !== m) continue; (acc[r.channel] ??= { rn: 0, rev: 0 }); acc[r.channel].rn += r.new_room_nights ?? 0; acc[r.channel].rev += r.new_revenue ?? 0 }
    else for (const r of (curve ?? [])) { if (r.cancel_date || r.stay_date.slice(0, 7) !== m) continue; (acc[r.channel] ??= { rn: 0, rev: 0 }); acc[r.channel].rn += r.rooms ?? 0; acc[r.channel].rev += r.revenue ?? 0 }
    return acc
  }
  const cur = rnRev(mon); const prev = rnRev(prevMon)
  const chans = [...new Set([...Object.keys(cur), ...Object.keys(prev)])]
    .sort((a, b) => ((cur[b]?.[metric === 'revenue' ? 'rev' : 'rn'] ?? 0) - (cur[a]?.[metric === 'revenue' ? 'rev' : 'rn'] ?? 0)))
  const adr = (x?: { rn: number; rev: number }) => (x && x.rn > 0 ? Math.round(x.rev / x.rn) : null)
  const actIn = (m: string) => actions.filter((a) => a.start_date.slice(0, 7) <= m && (a.end_date ?? a.start_date).slice(0, 7) >= m)

  return (
    <div className="py-2 grid grid-cols-1 lg:grid-cols-2 gap-4">
      <div>
        <div className="text-xs font-semibold mb-1">OTA別 分解（室数 × 単価）</div>
        <table className="w-full text-xs">
          <thead><tr style={{ color: 'var(--text-dim)' }} className="text-left">
            <th className="py-1">OTA</th><th className="py-1 text-right">当年室泊</th><th className="py-1 text-right">前年室泊</th><th className="py-1 text-right">当年単価</th><th className="py-1 text-right">前年単価</th>
          </tr></thead>
          <tbody>
            {chans.map((c) => {
              const cRn = cur[c]?.rn ?? 0, pRn = prev[c]?.rn ?? 0
              return (
                <tr key={c} style={{ borderTop: '1px solid var(--border)' }}>
                  <td className="py-1"><span className="inline-flex items-center gap-1"><span className="inline-block w-2 h-2 rounded-full" style={{ background: channelColor(c) }} />{c}</span></td>
                  <td className="py-1 text-right font-medium">{fmtNum(cRn)}</td>
                  <td className="py-1 text-right" style={{ color: 'var(--text-dim)' }}>{fmtNum(pRn)}</td>
                  <td className="py-1 text-right">{adr(cur[c]) != null ? fmtYen(adr(cur[c])!) : '-'}</td>
                  <td className="py-1 text-right" style={{ color: 'var(--text-dim)' }}>{adr(prev[c]) != null ? fmtYen(adr(prev[c])!) : '-'}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      <div>
        <div className="text-xs font-semibold mb-1">施策照合（当時 と 前年同月）</div>
        <div className="text-[11px] mb-1" style={{ color: 'var(--text-dim)' }}>▼ {mon}（当年）</div>
        <ActionList list={actIn(mon)} />
        <div className="text-[11px] mt-2 mb-1" style={{ color: 'var(--text-dim)' }}>▼ {prevMon}（前年同月）</div>
        <ActionList list={actIn(prevMon)} />
      </div>
    </div>
  )
}

function ActionList({ list }: { list: Action[] }) {
  if (list.length === 0) return <p className="text-[11px]" style={{ color: 'var(--text-dim)' }}>施策の記録なし</p>
  return (
    <div className="flex flex-col gap-1">
      {list.map((a) => (
        <div key={a.id} className="flex items-center gap-2 text-[11px]">
          <span className="px-1 py-0.5 rounded text-white text-[9px]" style={{ background: ACTION_COLOR[a.action_type] ?? '#888780' }}>{a.action_type}</span>
          <span className="font-medium">{a.title}</span>
          <span style={{ color: 'var(--text-dim)' }}>{a.start_date.slice(5)}{a.end_date && a.end_date !== a.start_date ? `〜${a.end_date.slice(5)}` : ''}{a.channel && a.channel !== '全体' ? `・${a.channel}` : ''}</span>
        </div>
      ))}
    </div>
  )
}

// ============================================================
// M7: ブッキングカーブ（宿泊月のD-n軌跡を再構築、前年同月を重ねる）
// ============================================================
function CurveView({ curve }: { curve: CurveRow[] | null }) {
  const [stayMonth, setStayMonth] = useState('')
  const [unit, setUnit] = useState<'rooms' | 'revenue'>('rooms')
  const MAXK = 120

  const monthOptions = useMemo(() => curve === null ? [] : [...new Set(curve.map((r) => r.stay_date.slice(0, 7)))].sort().reverse(), [curve])
  const active = stayMonth || monthOptions.find((m) => m >= new Date().toISOString().slice(0, 7)) || monthOptions[0] || ''

  // 宿泊月mの、時点D-k（k=0..MAXK）に在庫していた室数/金額を再構築
  const curveFor = (m: string): number[] => {
    const arr = new Array(MAXK + 1).fill(0)
    for (const r of (curve ?? [])) {
      if (r.stay_date.slice(0, 7) !== m || !r.booking_date) continue
      const lead = r.lead_days ?? daysBetween(r.stay_date, r.booking_date)
      if (lead < 0) continue
      const cancelLead = r.cancel_date ? daysBetween(r.stay_date, r.cancel_date) : null  // 宿泊日−キャンセル日
      const val = unit === 'revenue' ? (r.revenue ?? 0) : (r.rooms ?? 1)
      // 時点D-k で在庫: 予約済(lead>=k) かつ 未キャンセル(cancelなし or cancelLead<k)
      const upTo = Math.min(lead, MAXK)
      for (let k = 0; k <= upTo; k++) {
        if (cancelLead != null && cancelLead >= k) continue
        arr[k] += val
      }
    }
    return arr
  }

  const data = useMemo(() => {
    if (!active) return []
    const cur = curveFor(active); const prev = curveFor(shiftYr(active))
    const out: { k: string; kn: number; 当年: number | null; 前年: number | null }[] = []
    for (let k = MAXK; k >= 0; k--) out.push({ k: k === 0 ? '当日' : `D-${k}`, kn: k, 当年: cur[k], 前年: prev.some((x) => x > 0) ? prev[k] : null })
    return out
  }, [curve, active, unit])  // eslint-disable-line react-hooks/exhaustive-deps

  const hasData = data.some((d) => (d.当年 ?? 0) > 0)
  if (curve === null) return <p className="text-sm py-16 text-center" style={{ color: 'var(--text-dim)' }}>カーブを再構築中…</p>

  return (
    <>
      <div className="flex items-center gap-2 mb-4 flex-wrap">
        <select className="field px-3 py-1.5 text-sm" value={active} onChange={(e) => setStayMonth(e.target.value)}>
          {monthOptions.map((m) => <option key={m} value={m}>{m}（宿泊月）</option>)}
        </select>
        <Seg value={unit} set={setUnit} opts={[['rooms', '室数'], ['revenue', '金額']]} />
        <span className="text-xs" style={{ color: 'var(--text-dim)' }}>予約日×キャンセル日から各時点の在庫を再構築（毎日の取得は不要）</span>
      </div>
      <div className="card p-4">
        {hasData ? (
          <ResponsiveContainer width="100%" height={380}>
            <LineChart data={data} margin={{ top: 8, right: 12, bottom: 5, left: unit === 'revenue' ? 8 : -14 }}>
              <CartesianGrid stroke="#e7dac6" vertical={false} />
              <XAxis dataKey="k" {...CHART_AXIS} interval={9} />
              <YAxis {...CHART_AXIS} allowDecimals={false} tickFormatter={unit === 'revenue' ? (v) => `${Math.round(Number(v) / 10000)}万` : undefined} />
              <Tooltip {...chartTooltip} formatter={(v: any, n: any) => [unit === 'revenue' ? fmtYen(Number(v)) : `${fmtNum(Number(v))}室`, n]} />
              <Legend wrapperStyle={{ fontSize: 11 }} />
              <Line dataKey="当年" stroke="#D85A30" strokeWidth={2} dot={false} />
              <Line dataKey="前年" stroke="#7F77DD" strokeWidth={2} strokeDasharray="4 3" dot={false} connectNulls />
            </LineChart>
          </ResponsiveContainer>
        ) : <p className="text-sm py-16 text-center" style={{ color: 'var(--text-dim)' }}>この宿泊月のカーブデータがありません（予約情報CSVの取込状況によります）。</p>}
        <p className="text-[10px] mt-1" style={{ color: 'var(--text-dim)' }}>
          横軸＝宿泊日までの日数（左=先／右=当日）、縦軸＝その時点で入っていた{unit === 'revenue' ? '金額' : '室数'}。
          橙=当年、紫破線=前年同月。前年同日のD-nと当年のD-nを重ねて「入りの速さ」を比較できます。
        </p>
      </div>
    </>
  )
}

// ============================================================
// M8: オンハンド断面（宿泊日×OTA別の現在の入り。mart_onhand）
// ============================================================
function OnhandView({ onhand }: { onhand: OnhandRow[] | null }) {
  const [mode, setMode] = useState<'day' | 'month'>('month')
  const [metric, setMetric] = useState<'rooms' | 'revenue'>('rooms')
  const [dayMonth, setDayMonth] = useState('')

  const rows = onhand ?? []
  const monthOptions = useMemo(() => [...new Set(rows.map((r) => r.stay_date.slice(0, 7)))].sort(), [rows])
  const activeDayMonth = dayMonth || monthOptions[0] || ''

  const channelRank = useMemo(() => {
    const t: Record<string, number> = {}
    for (const r of rows) t[r.channel] = (t[r.channel] ?? 0) + (r.rooms ?? 0)
    return [...Object.entries(t)].sort((a, b) => b[1] - a[1]).map(([c]) => c)
  }, [rows])
  const topChannels = channelRank.slice(0, TOP_CHANNELS)
  const channels = channelRank.length > TOP_CHANNELS ? [...topChannels, 'その他'] : topChannels
  const chanKey = (c: string) => (topChannels.includes(c) ? c : 'その他')
  const valOf = (r: OnhandRow) => (metric === 'revenue' ? (r.revenue ?? 0) : (r.rooms ?? 0))
  const bucketOf = (d: string) => (mode === 'month' ? d.slice(0, 7) : d)

  const perBucket = useMemo(() => {
    const per: Record<string, Record<string, number>> = {}
    for (const r of rows) { const b = bucketOf(r.stay_date); (per[b] ??= {}); const ck = chanKey(r.channel); per[b][ck] = (per[b][ck] ?? 0) + valOf(r) }
    return per
  }, [rows, mode, metric, channelRank])  // eslint-disable-line react-hooks/exhaustive-deps

  const buckets = useMemo(() => {
    if (mode === 'month') return Object.keys(perBucket).sort()
    if (!activeDayMonth) return []
    const [y, m] = activeDayMonth.split('-').map(Number)
    return Array.from({ length: new Date(y, m, 0).getDate() }, (_, i) => `${activeDayMonth}-${String(i + 1).padStart(2, '0')}`)
  }, [mode, perBucket, activeDayMonth])

  const chartData = useMemo(() => buckets.map((b) => {
    const row: Record<string, string | number> = { bucket: mode === 'month' ? b.slice(2) : b.slice(8), full: b }
    const per = perBucket[b] ?? {}
    for (const c of channels) row[c] = per[c] ?? 0
    return row
  }), [buckets, perBucket, channels, mode])
  const hasData = chartData.some((d) => channels.some((c) => (d[c] as number) !== 0))

  if (onhand === null) return <p className="text-sm py-16 text-center" style={{ color: 'var(--text-dim)' }}>オンハンド断面を集計中…</p>

  return (
    <>
      <div className="flex items-center gap-2 mb-4 flex-wrap">
        <Seg value={mode} set={setMode} opts={[['month', '月別'], ['day', '日別']]} />
        <Seg value={metric} set={setMetric} opts={[['rooms', '室数'], ['revenue', '金額']]} />
        {mode === 'day' && monthOptions.length > 0 && (
          <select className="field px-3 py-1.5 text-sm" value={activeDayMonth} onChange={(e) => setDayMonth(e.target.value)}>
            {monthOptions.map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
        )}
        <span className="text-xs" style={{ color: 'var(--text-dim)' }}>宿泊日×OTA別・今日以降・未キャンセルの現在の入り</span>
      </div>
      <div className="card p-4">
        {hasData ? (
          <ResponsiveContainer width="100%" height={380}>
            <ComposedChart data={chartData} margin={{ top: 8, right: 12, bottom: 5, left: metric === 'revenue' ? 8 : -14 }}>
              <CartesianGrid stroke="#e7dac6" vertical={false} />
              <XAxis dataKey="bucket" {...CHART_AXIS} interval={mode === 'day' ? 2 : Math.max(0, Math.floor(chartData.length / 16))} />
              <YAxis {...CHART_AXIS} allowDecimals={false} tickFormatter={metric === 'revenue' ? (v) => `${Math.round(Number(v) / 10000)}万` : undefined} />
              <Tooltip {...chartTooltip} labelFormatter={(l: any, p: any) => (p?.[0]?.payload?.full ?? l)} formatter={(v: any, n: any) => [metric === 'revenue' ? fmtYen(Number(v)) : `${fmtNum(Number(v))}室`, n]} />
              <Legend wrapperStyle={{ fontSize: 11 }} />
              {channels.map((c) => <Bar key={c} dataKey={c} stackId="s" maxBarSize={mode === 'day' ? 20 : 30} fill={c === 'その他' ? '#B4B2A9' : channelColor(c)} />)}
            </ComposedChart>
          </ResponsiveContainer>
        ) : <p className="text-sm py-16 text-center" style={{ color: 'var(--text-dim)' }}>今日以降のオンハンドがありません（将来月の予約情報CSVを取り込むと表示されます）。</p>}
        <p className="text-[10px] mt-1" style={{ color: 'var(--text-dim)' }}>
          棒＝OTA別の{metric === 'revenue' ? '金額' : '室数'}（宿泊日で計上・未キャンセル）。前年同時点比較は snapshot_onhand の蓄積後に有効化予定。
        </p>
      </div>
    </>
  )
}

function Seg<T extends string>({ value, set, opts }: { value: T; set: (v: T) => void; opts: [T, string][] }) {
  return (
    <div className="flex rounded-md overflow-hidden" style={{ border: '1px solid var(--border)' }}>
      {opts.map(([v, label]) => (
        <button key={v} onClick={() => set(v)} className="px-3 py-1.5 text-xs"
          style={{ background: value === v ? 'var(--accent)' : 'var(--surface)', color: value === v ? '#fff' : 'var(--text-dim)' }}>{label}</button>
      ))}
    </div>
  )
}
