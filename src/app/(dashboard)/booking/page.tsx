'use client'

// 予約日ベース分析（M5）— 「施策を打ったら予約がどう動いたか」を予約日の軸で見る。
// OTA別の積み上げ棒＋前年同日の線＋施策帯オーバーレイ。要件定義書_予約日ベース分析_施策記録 §3.1。
import { useEffect, useMemo, useState } from 'react'
import { useFacility } from '@/lib/facility-context'
import { supabase } from '@/lib/supabase/client'
import { fetchAll } from '@/lib/supabase/fetch-all'
import {
  ComposedChart, Bar, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, Legend, CartesianGrid, ReferenceArea,
} from 'recharts'
import { fmtNum, fmtYen, CHART_AXIS, chartTooltip, channelColor } from '@/lib/ui'
import { Loading, Empty, LoadError } from '@/components/page-bits'

interface FlowRow {
  flow_date: string; channel: string
  new_reservations: number | null; new_room_nights: number | null; new_revenue: number | null
  cxl_reservations: number | null; cxl_room_nights: number | null; cxl_revenue: number | null
  net_reservations: number | null; net_room_nights: number | null; net_revenue: number | null
}
interface Action {
  id: number; channel: string | null; action_type: string; title: string
  start_date: string; end_date: string | null; cost: number | null; memo: string | null; decided_date: string | null
}

type Mode = 'day' | 'month'
type Metric = 'reservations' | 'room_nights' | 'revenue'
type Basis = 'new' | 'net'

const METRIC_LABEL: Record<Metric, string> = { reservations: '予約件数', room_nights: '室泊', revenue: '金額' }
const ACTION_COLOR: Record<string, string> = {
  広告: '#D85A30', クーポン: '#1D9E75', セール参加: '#378ADD', ランク変更: '#7F77DD', プラン: '#C99A2E', その他: '#888780',
}
const TOP_CHANNELS = 6
const shiftYr = (k: string) => `${Number(k.slice(0, 4)) - 1}${k.slice(4)}`
const fmtMetric = (v: number, m: Metric) => (m === 'revenue' ? fmtYen(v) : fmtNum(v))

export default function BookingPage() {
  const { current } = useFacility()
  const [flow, setFlow] = useState<FlowRow[]>([])
  const [actions, setActions] = useState<Action[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')

  const [mode, setMode] = useState<Mode>('month')
  const [metric, setMetric] = useState<Metric>('room_nights')
  const [basis, setBasis] = useState<Basis>('new')
  const [dayMonth, setDayMonth] = useState('')  // 日別のときの対象月

  useEffect(() => {
    if (!current) return
    setLoading(true); setLoadError('')
    Promise.all([
      fetchAll<FlowRow>(() => supabase.from('mart_booking_flow').select('*').eq('facility', current)),
      fetchAll<Action>(() => supabase.from('raw_marketing_action')
        .select('id, channel, action_type, title, start_date, end_date, cost, memo, decided_date').eq('facility', current)),
    ]).then(([f, a]) => { setFlow(f ?? []); setActions(a ?? []) })
      .catch((e: unknown) => setLoadError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false))
  }, [current])

  // 指標セレクタ
  const valOf = (r: FlowRow): number => {
    const key = `${basis}_${metric}` as keyof FlowRow
    return (r[key] as number | null) ?? 0
  }

  // 日別の対象月候補
  const monthOptions = useMemo(
    () => [...new Set(flow.map((r) => r.flow_date.slice(0, 7)))].sort().reverse(), [flow])
  const activeDayMonth = dayMonth || monthOptions[0] || ''

  // チャネルのランキング（全期間・新規室泊で安定的に決める。上位TOP_CHANNELS＋その他）
  const channelRank = useMemo(() => {
    const t: Record<string, number> = {}
    for (const r of flow) t[r.channel] = (t[r.channel] ?? 0) + (r.new_room_nights ?? 0)
    return [...Object.entries(t)].sort((a, b) => b[1] - a[1]).map(([c]) => c)
  }, [flow])
  const topChannels = channelRank.slice(0, TOP_CHANNELS)
  const hasOther = channelRank.length > TOP_CHANNELS
  const channels = hasOther ? [...topChannels, 'その他'] : topChannels
  const chanKey = (c: string) => (topChannels.includes(c) ? c : 'その他')

  const bucketOf = (d: string) => (mode === 'month' ? d.slice(0, 7) : d)

  // 全バケツ×チャネルの値（前年線のため全期間で集計）＋バケツ合計
  const { perBucket, totalByBucket } = useMemo(() => {
    const per: Record<string, Record<string, number>> = {}
    const tot: Record<string, number> = {}
    for (const r of flow) {
      const b = bucketOf(r.flow_date)
      const v = valOf(r)
      ;(per[b] ??= {})
      const ck = chanKey(r.channel)
      per[b][ck] = (per[b][ck] ?? 0) + v
      tot[b] = (tot[b] ?? 0) + v
    }
    return { perBucket: per, totalByBucket: tot }
  }, [flow, mode, metric, basis, channelRank])  // eslint-disable-line react-hooks/exhaustive-deps

  // 表示バケツ
  const buckets = useMemo(() => {
    if (mode === 'month') return Object.keys(perBucket).sort()
    // 日別: 対象月の1日〜末日
    if (!activeDayMonth) return []
    const [y, m] = activeDayMonth.split('-').map(Number)
    const days = new Date(y, m, 0).getDate()
    return Array.from({ length: days }, (_, i) => `${activeDayMonth}-${String(i + 1).padStart(2, '0')}`)
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

  // 表示範囲に重なる施策（帯オーバーレイ用）
  const rangeFrom = buckets[0] ?? ''
  const rangeTo = buckets[buckets.length - 1] ?? ''
  const visibleActions = useMemo(() => actions.filter((a) => {
    const s = mode === 'month' ? a.start_date.slice(0, 7) : a.start_date
    const e = mode === 'month' ? (a.end_date ?? a.start_date).slice(0, 7) : (a.end_date ?? a.start_date)
    return e >= rangeFrom && s <= rangeTo
  }).sort((a, b) => a.start_date.localeCompare(b.start_date)), [actions, mode, rangeFrom, rangeTo])

  // 施策の帯を、表示バケツの端にクリップして x1/x2 を求める
  const bandFor = (a: Action): { x1: string; x2: string } | null => {
    const s = mode === 'month' ? a.start_date.slice(0, 7) : a.start_date
    const e = mode === 'month' ? (a.end_date ?? a.start_date).slice(0, 7) : (a.end_date ?? a.start_date)
    const inRange = buckets.filter((b) => b >= s && b <= e)
    if (inRange.length === 0) return null
    const disp = (b: string) => (mode === 'month' ? b.slice(2) : b.slice(8))
    return { x1: disp(inRange[0]), x2: disp(inRange[inRange.length - 1]) }
  }

  return (
    <div className="p-6">
      {/* コントロール */}
      <div className="flex items-center gap-2 mb-4 flex-wrap">
        <Seg value={mode} set={setMode} opts={[['month', '月別'], ['day', '日別']]} />
        <Seg value={metric} set={setMetric} opts={[['reservations', '件数'], ['room_nights', '室泊'], ['revenue', '金額']]} />
        <Seg value={basis} set={setBasis} opts={[['new', '新規'], ['net', 'ネット']]} />
        {mode === 'day' && monthOptions.length > 0 && (
          <select className="field px-3 py-1.5 text-sm" value={activeDayMonth} onChange={(e) => setDayMonth(e.target.value)}>
            {monthOptions.map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
        )}
        <span className="text-xs" style={{ color: 'var(--text-dim)' }}>
          予約日ベース・{basis === 'net' ? 'ネット（キャンセル相殺）' : '新規予約'}・{METRIC_LABEL[metric]}
        </span>
      </div>

      {loading ? <Loading /> : loadError ? <LoadError message={loadError} /> : flow.length === 0 ? (
        <Empty message="予約情報CSV（全ステータス）を /upload から取り込むと、予約日ベースの動きが表示されます。" />
      ) : (
        <>
          {/* 施策帯の凡例（範囲内） */}
          {visibleActions.length > 0 && (
            <div className="flex items-center gap-2 mb-2 flex-wrap">
              <span className="text-[10px]" style={{ color: 'var(--text-dim)' }}>施策帯:</span>
              {visibleActions.map((a) => (
                <span key={a.id} title={`${a.start_date}${a.end_date && a.end_date !== a.start_date ? ` 〜 ${a.end_date}` : ''}${a.cost != null ? ` / ${fmtYen(a.cost)}` : ''}${a.memo ? ` / ${a.memo}` : ''}`}
                  className="text-[10px] px-1.5 py-0.5 rounded text-white" style={{ background: ACTION_COLOR[a.action_type] ?? '#888780' }}>
                  {a.title}
                </span>
              ))}
            </div>
          )}

          <div className="card p-4 mb-4">
            {hasData ? (
              <ResponsiveContainer width="100%" height={380}>
                <ComposedChart data={chartData} margin={{ top: 8, right: 12, bottom: 5, left: metric === 'revenue' ? 8 : -14 }}>
                  <CartesianGrid stroke="#e7dac6" vertical={false} />
                  <XAxis dataKey="bucket" {...CHART_AXIS} interval={mode === 'day' ? 2 : Math.max(0, Math.floor(chartData.length / 16))} />
                  <YAxis {...CHART_AXIS} allowDecimals={false} tickFormatter={metric === 'revenue' ? (v) => `${Math.round(Number(v) / 10000)}万` : undefined} />
                  <Tooltip {...chartTooltip}
                    labelFormatter={(l: any, p: any) => (p?.[0]?.payload?.full ?? l)}
                    formatter={(v: any, n: any) => [fmtMetric(Number(v), metric), n]} />
                  <Legend wrapperStyle={{ fontSize: 11 }} />
                  {/* 施策帯オーバーレイ */}
                  {visibleActions.map((a) => {
                    const band = bandFor(a)
                    if (!band) return null
                    return <ReferenceArea key={a.id} x1={band.x1} x2={band.x2}
                      fill={ACTION_COLOR[a.action_type] ?? '#888780'} fillOpacity={0.10} ifOverflow="extendDomain" />
                  })}
                  {channels.map((c) => (
                    <Bar key={c} dataKey={c} stackId="s" maxBarSize={mode === 'day' ? 20 : 30}
                      fill={c === 'その他' ? '#B4B2A9' : channelColor(c)} />
                  ))}
                  <Line dataKey="前年" name="前年同期" stroke="#C0392B" strokeWidth={2} dot={false} connectNulls />
                </ComposedChart>
              </ResponsiveContainer>
            ) : <p className="text-sm py-16 text-center" style={{ color: 'var(--text-dim)' }}>この範囲に予約日ベースのデータがありません。</p>}
            <p className="text-[10px] mt-1" style={{ color: 'var(--text-dim)' }}>
              棒＝OTA別{METRIC_LABEL[metric]}（{basis === 'net' ? 'ネット' : '新規'}・予約日で計上）、赤線＝前年同期。上部の帯＝施策の実行期間。
              {basis === 'net' && ' ネットはキャンセル日で相殺（cancel_dateの取込後に有効）。'}
            </p>
          </div>

          {/* 範囲内の施策一覧 */}
          {visibleActions.length > 0 && (
            <div className="card overflow-x-auto">
              <table className="w-full text-sm whitespace-nowrap">
                <thead>
                  <tr style={{ background: 'var(--surface2)', color: 'var(--text-dim)' }} className="text-left">
                    <th className="px-3 py-2">種類</th><th className="px-3 py-2">チャネル</th><th className="px-3 py-2">施策</th>
                    <th className="px-3 py-2">実行期間</th><th className="px-3 py-2">判断日</th><th className="px-3 py-2 text-right">費用</th><th className="px-3 py-2">メモ</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleActions.map((a) => (
                    <tr key={a.id} style={{ borderTop: '1px solid var(--border)' }}>
                      <td className="px-3 py-2"><span className="text-[10px] px-1.5 py-0.5 rounded text-white" style={{ background: ACTION_COLOR[a.action_type] ?? '#888780' }}>{a.action_type}</span></td>
                      <td className="px-3 py-2 text-xs">
                        <span className="inline-flex items-center gap-1"><span className="inline-block w-2 h-2 rounded-full" style={{ background: a.channel && a.channel !== '全体' ? channelColor(a.channel) : '#B4B2A9' }} />{a.channel ?? '全体'}</span>
                      </td>
                      <td className="px-3 py-2 font-medium">{a.title}</td>
                      <td className="px-3 py-2 text-xs" style={{ color: 'var(--text-dim)' }}>{a.start_date}{a.end_date && a.end_date !== a.start_date ? ` 〜 ${a.end_date}` : ''}</td>
                      <td className="px-3 py-2 text-xs" style={{ color: 'var(--text-dim)' }}>{a.decided_date ?? '-'}</td>
                      <td className="px-3 py-2 text-right text-xs">{a.cost != null ? fmtYen(a.cost) : '-'}</td>
                      <td className="px-3 py-2 text-xs" style={{ color: 'var(--text-dim)', maxWidth: 280, overflow: 'hidden', textOverflow: 'ellipsis' }}>{a.memo ?? ''}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="text-xs mt-2" style={{ color: 'var(--text-dim)' }}>
            前年同期＝予約日を1年前にずらした同バケツの合計。施策の記録は「施策記録」画面から。要因の判断（在庫か料金か）は人が行います（灯は分解と照合まで）。
          </p>
        </>
      )}
    </div>
  )
}

function Seg<T extends string>({ value, set, opts }: { value: T; set: (v: T) => void; opts: [T, string][] }) {
  return (
    <div className="flex rounded-md overflow-hidden" style={{ border: '1px solid var(--border)' }}>
      {opts.map(([v, label]) => (
        <button key={v} onClick={() => set(v)} className="px-3 py-1.5 text-xs"
          style={{ background: value === v ? 'var(--accent)' : 'var(--surface)', color: value === v ? '#fff' : 'var(--text-dim)' }}>
          {label}
        </button>
      ))}
    </div>
  )
}
