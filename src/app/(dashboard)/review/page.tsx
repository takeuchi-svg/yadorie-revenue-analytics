'use client'

// クチコミ・満足度分析（C3）
// 仕様: docs/要件定義書_クチコミ満足度分析 §3。平滑化スコア主表示・n<5は参考値バッジ・データ0はフォールバック。
import { useEffect, useMemo, useState } from 'react'
import {
  ResponsiveContainer, LineChart, Line, XAxis, YAxis, Tooltip, CartesianGrid,
  BarChart, Bar, Cell, RadarChart, Radar, PolarGrid, PolarAngleAxis, PolarRadiusAxis, Legend,
} from 'recharts'
import { useFacility } from '@/lib/facility-context'
import { supabase } from '@/lib/supabase/client'
import { fetchAll } from '@/lib/supabase/fetch-all'
import { useFacilityData } from '@/lib/use-facility-data'
import { fmtNum, CHART_AXIS, chartTooltip } from '@/lib/ui'
import { Loading, Empty, LoadError } from '@/components/page-bits'

/* eslint-disable @typescript-eslint/no-explicit-any */
interface ReviewRow {
  id: number; source: string; source_review_id: string; booking_no: string | null
  review_date: string; stay_date: string | null
  overall_rating: number | null; rating_scale: number
  sub_ratings: Record<string, string | number> | null
  title: string | null; body: string | null
  reviewer_attr: Record<string, any> | null
}
interface FeedbackRow { month: string; channel: string; axis_code: string; n: number; raw_avg: number | null; smoothed_avg: number | null; is_low_sample: boolean }
interface NpsRow { month: string; n: number; nps_score: number | null; promoters: number; passives: number; detractors: number }
interface TopicRow { month: string; topic_code: string; topic_label: string | null; negative_mentions: number; positive_mentions: number; source_kinds: number }
interface Insight {
  topic_code: string; topic_label: string | null; problem: string | null
  evidence: { quote: string; source: string; review_date: string | null; rating: number | null }[] | null
  solutions: { title: string; detail: string; effort: string }[] | null
}
interface SummaryRow { month: string; review_count: number | null; overall_avg: number | null; axis_scores: Record<string, number> | null; area_ranking: string | null }
interface AxisMap { source: string; source_key: string; axis_code: string }

const AXIS_LABEL: Record<string, string> = {
  overall: '総合', room: '部屋', bath: '風呂', dinner: '夕食', breakfast: '朝食',
  meal: '食事', service: '接客', clean: '清潔感', relax: 'くつろぎ',
  facility_equip: '設備', location: '立地',
}
const RADAR_AXES = ['overall', 'room', 'bath', 'dinner', 'breakfast', 'service', 'clean', 'relax']
const SRC_LABEL: Record<string, string> = { jalan: 'じゃらん', ikyu: '一休', rakuten: '楽天', google: 'Google', survey: 'アンケート' }
const SRC_COLOR: Record<string, string> = { jalan: '#1D9E75', ikyu: '#7F77DD', rakuten: '#378ADD', google: '#E24B4A', survey: '#D85A30' }

const monthsBack = (m: string, k: number): string[] => {
  const y = +m.slice(0, 4), mo = +m.slice(5, 7); const out: string[] = []
  for (let i = 0; i < k; i++) { const d = new Date(Date.UTC(y, mo - 1 - i, 1)); out.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`) }
  return out
}
const shiftYear = (m: string) => `${+m.slice(0, 4) - 1}-${m.slice(5)}`

export default function ReviewPage() {
  const { current, currentFacility } = useFacility()
  const [month, setMonth] = useState('')
  const [mode, setMode] = useState<'1' | '3' | '12'>('3')
  const [srcFilter, setSrcFilter] = useState<Set<string>>(new Set())  // 空=全て
  const [trendAxis, setTrendAxis] = useState('overall')
  const [openBody, setOpenBody] = useState<number | null>(null)
  const [analyzing, setAnalyzing] = useState(false)
  const [analyzeMsg, setAnalyzeMsg] = useState('')
  const [insights, setInsights] = useState<Insight[]>([])
  const [insightBusy, setInsightBusy] = useState(false)
  const [insightMsg, setInsightMsg] = useState('')

  const { data, loading, error, reload } = useFacilityData<{
    reviews: ReviewRow[]; fb: FeedbackRow[]; fb3: FeedbackRow[]
    nps: NpsRow[]; topics: TopicRow[]; rakuten: SummaryRow[]; axisMap: AxisMap[]
  }>(async (f) => {
    const [reviews, fb, fb3, nps, topics, rakuten, axisMap] = await Promise.all([
      fetchAll<ReviewRow>(() => supabase.from('raw_review')
        .select('id, source, source_review_id, booking_no, review_date, stay_date, overall_rating, rating_scale, sub_ratings, title, body, reviewer_attr')
        .eq('facility', f).order('review_date', { ascending: false })),
      fetchAll<FeedbackRow>(() => supabase.from('mart_guest_feedback').select('month, channel, axis_code, n, raw_avg, smoothed_avg, is_low_sample').eq('facility', f)),
      fetchAll<FeedbackRow>(() => supabase.from('mart_guest_feedback_3mo').select('month, channel, axis_code, n, raw_avg, smoothed_avg, is_low_sample').eq('facility', f)),
      fetchAll<NpsRow>(() => supabase.from('mart_nps').select('month, n, nps_score, promoters, passives, detractors').eq('facility', f)),
      fetchAll<TopicRow>(() => supabase.from('mart_improvement_topics').select('month, topic_code, topic_label, negative_mentions, positive_mentions, source_kinds').eq('facility', f)),
      fetchAll<SummaryRow>(() => supabase.from('raw_review_summary').select('month, review_count, overall_avg, axis_scores, area_ranking').eq('facility', f)),
      fetchAll<AxisMap>(() => supabase.from('dim_axis_mapping').select('source, source_key, axis_code')),
    ])
    return { reviews, fb, fb3, nps, topics, rakuten, axisMap }
  })

  const reviews = useMemo(() => data?.reviews ?? [], [data])
  const months = useMemo(() => {
    const s = new Set<string>()
    reviews.forEach((r) => s.add(r.review_date.slice(0, 7)))
    ;(data?.nps ?? []).forEach((r) => s.add(r.month))
    ;(data?.rakuten ?? []).forEach((r) => s.add(r.month))
    return [...s].sort().reverse()
  }, [reviews, data])
  const activeMonth = month || months[0] || ''
  const windowMonths = useMemo(() => (activeMonth ? monthsBack(activeMonth, +mode) : []), [activeMonth, mode])
  const winSet = useMemo(() => new Set(windowMonths), [windowMonths])
  const prevWinSet = useMemo(() => new Set(windowMonths.map(shiftYear)), [windowMonths])

  // 統一軸マップ: source|source_key → axis_code
  const axisOf = useMemo(() => {
    const m: Record<string, string> = {}
    ;(data?.axisMap ?? []).forEach((r) => { m[`${r.source}|${r.source_key}`] = r.axis_code })
    return m
  }, [data])

  // 期間内レビュー（ソースフィルタ適用）
  const srcOk = (s: string) => srcFilter.size === 0 || srcFilter.has(s)
  const winReviews = useMemo(() => reviews.filter((r) => winSet.has(r.review_date.slice(0, 7)) && srcOk(r.source)), [reviews, winSet, srcFilter])

  // 軸スコア集計（期間×任意のフィルタ）: web=raw_reviewから直接 / survey=mart経由
  const axisAgg = (monthSet: Set<string>): Record<string, { sum: number; n: number }> => {
    const acc: Record<string, { sum: number; n: number }> = {}
    const add = (axis: string, score: number) => { (acc[axis] ??= { sum: 0, n: 0 }); acc[axis].sum += score; acc[axis].n += 1 }
    for (const r of reviews) {
      if (!monthSet.has(r.review_date.slice(0, 7)) || !srcOk(r.source)) continue
      if (r.overall_rating != null) add('overall', r.overall_rating * 5 / r.rating_scale)
      for (const [k, v] of Object.entries(r.sub_ratings ?? {})) {
        const axis = axisOf[`${r.source}|${k}`]; const num = typeof v === 'number' ? v : parseFloat(String(v))
        if (axis && !isNaN(num)) add(axis, num * 5 / r.rating_scale)
      }
    }
    if (srcFilter.size === 0 || srcFilter.has('survey')) {
      for (const f of (data?.fb ?? [])) {
        if (f.channel !== 'survey' || !monthSet.has(f.month) || f.raw_avg == null) continue
        ;(acc[f.axis_code] ??= { sum: 0, n: 0 }); acc[f.axis_code].sum += f.raw_avg * f.n; acc[f.axis_code].n += f.n
      }
    }
    return acc
  }
  const curAxis = useMemo(() => axisAgg(winSet), [winSet, reviews, data, srcFilter, axisOf])   // eslint-disable-line react-hooks/exhaustive-deps
  const prevAxis = useMemo(() => axisAgg(prevWinSet), [prevWinSet, reviews, data, srcFilter, axisOf])  // eslint-disable-line react-hooks/exhaustive-deps

  // 平滑化スコア（3ヶ月ローリングmart。選択月・web+surveyをn加重）
  const smoothedAt = (m: string, axis: string): { v: number | null; n: number; low: boolean } => {
    const rows = (data?.fb3 ?? []).filter((r) => r.month === m && r.axis_code === axis)
    let sum = 0, n = 0, low = true
    for (const r of rows) { const s = r.smoothed_avg ?? r.raw_avg; if (s == null) continue; sum += s * r.n; n += r.n; low = low && r.is_low_sample }
    return { v: n ? sum / n : null, n, low: low || n < 5 }
  }

  // KPIカード
  const kOverall = smoothedAt(activeMonth, 'overall')
  const npsWin = (data?.nps ?? []).filter((r) => winSet.has(r.month))
  const npsAgg = useMemo(() => {
    const n = npsWin.reduce((s, r) => s + r.n, 0)
    const pro = npsWin.reduce((s, r) => s + r.promoters, 0), det = npsWin.reduce((s, r) => s + r.detractors, 0)
    return { n, score: n ? Math.round(1000 * (pro - det) / n) / 10 : null, pro, det, pas: npsWin.reduce((s, r) => s + r.passives, 0) }
  }, [npsWin])
  const srcCounts = useMemo(() => {
    const c: Record<string, number> = {}
    winReviews.forEach((r) => { c[r.source] = (c[r.source] ?? 0) + 1 })
    return c
  }, [winReviews])
  const topicsWin = useMemo(() => {
    const acc: Record<string, { label: string; neg: number; pos: number; kinds: number }> = {}
    for (const t of (data?.topics ?? [])) {
      if (!winSet.has(t.month) || t.topic_code === '_none') continue
      const a = (acc[t.topic_code] ??= { label: t.topic_label ?? t.topic_code, neg: 0, pos: 0, kinds: 1 })
      a.neg += t.negative_mentions; a.pos += t.positive_mentions; a.kinds = Math.max(a.kinds, t.source_kinds)
    }
    return Object.entries(acc).map(([code, v]) => ({ code, ...v })).sort((a, b) => b.neg - a.neg)
  }, [data, winSet])

  // レーダー
  const radarData = RADAR_AXES.map((a) => ({
    axis: AXIS_LABEL[a],
    cur: curAxis[a]?.n ? +(curAxis[a].sum / curAxis[a].n).toFixed(2) : null,
    prev: prevAxis[a]?.n ? +(prevAxis[a].sum / prevAxis[a].n).toFixed(2) : null,
  }))
  const hasRadar = radarData.some((d) => d.cur != null)

  // 軸推移（3moローリング・全期間）
  const trendData = useMemo(() => {
    const ms = [...new Set((data?.fb3 ?? []).map((r) => r.month))].sort()
    return ms.map((m) => { const s = smoothedAt(m, trendAxis); return { month: m.slice(2), score: s.v != null ? +s.v.toFixed(2) : null, low: s.low } })
  }, [data, trendAxis])  // eslint-disable-line react-hooks/exhaustive-deps

  // ソース別比較（選択軸・期間）
  const srcCompare = useMemo(() => {
    const acc: Record<string, { sum: number; n: number }> = {}
    for (const r of reviews) {
      if (!winSet.has(r.review_date.slice(0, 7))) continue
      let v: number | null = null
      if (trendAxis === 'overall') v = r.overall_rating != null ? r.overall_rating * 5 / r.rating_scale : null
      else for (const [k, val] of Object.entries(r.sub_ratings ?? {})) {
        if (axisOf[`${r.source}|${k}`] === trendAxis) { const num = typeof val === 'number' ? val : parseFloat(String(val)); if (!isNaN(num)) v = num * 5 / r.rating_scale }
      }
      if (v == null) continue
      ;(acc[r.source] ??= { sum: 0, n: 0 }); acc[r.source].sum += v; acc[r.source].n += 1
    }
    // アンケート（mart）
    for (const f of (data?.fb ?? [])) {
      if (f.channel !== 'survey' || !winSet.has(f.month) || f.axis_code !== trendAxis || f.raw_avg == null) continue
      ;(acc['survey'] ??= { sum: 0, n: 0 }); acc['survey'].sum += f.raw_avg * f.n; acc['survey'].n += f.n
    }
    // 楽天（集計値・平滑化対象外）
    const rk = (data?.rakuten ?? []).filter((r) => winSet.has(r.month))
    if (rk.length) {
      let sum = 0, n = 0
      for (const r of rk) {
        const val = trendAxis === 'overall' ? r.overall_avg
          : Object.entries(r.axis_scores ?? {}).find(([k]) => axisOf[`rakuten|${k}`] === trendAxis)?.[1]
        if (val != null) { sum += Number(val); n += 1 }
      }
      if (n) (acc['rakuten'] ??= { sum: 0, n: 0 }), acc['rakuten'].sum += sum, acc['rakuten'].n += n
    }
    return Object.entries(acc).map(([s, v]) => ({ source: s, name: SRC_LABEL[s] ?? s, score: +(v.sum / v.n).toFixed(2), n: v.n }))
      .sort((a, b) => b.score - a.score)
  }, [reviews, data, winSet, trendAxis, axisOf])

  const npsTrend = useMemo(() => (data?.nps ?? []).slice().sort((a, b) => a.month.localeCompare(b.month)).map((r) => ({ month: r.month.slice(2), nps: r.nps_score })), [data])

  // 改善レポートのキャッシュ読込（宿×終端月×ウィンドウ）
  useEffect(() => {
    if (!current || !activeMonth) { setInsights([]); return }
    supabase.from('raw_improvement_insight')
      .select('topic_code, topic_label, problem, evidence, solutions')
      .eq('facility', current).eq('month', activeMonth).eq('window_months', +mode)
      .then(({ data }) => { setInsights((data as Insight[]) ?? []); setInsightMsg('') })
  }, [current, activeMonth, mode])

  // 改善レポート生成（課題の特定＋実引用＋解決策①②③）
  const genInsight = async (force: boolean) => {
    setInsightBusy(true); setInsightMsg('レポート生成中…（十数秒かかります）')
    try {
      const { data: { session } } = await supabase.auth.getSession()
      const res = await fetch('/api/review-insight', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(session ? { Authorization: `Bearer ${session.access_token}` } : {}) },
        body: JSON.stringify({ facility: current, month: activeMonth, window: +mode, force }),
      })
      const d = await res.json()
      if (!res.ok || d.error) throw new Error(d.error || '生成に失敗しました')
      setInsights(d.insights ?? [])
      setInsightMsg(d.cached ? '' : '生成しました')
    } catch (e) {
      setInsightMsg('Error: ' + (e instanceof Error ? e.message : String(e)))
    } finally { setInsightBusy(false) }
  }

  // AI定性分析（C4）: 未分析テキストが無くなるまでバッチAPIを繰り返し呼ぶ
  const runAnalyze = async () => {
    setAnalyzing(true); setAnalyzeMsg('分析中…')
    try {
      const { data: { session } } = await supabase.auth.getSession()
      const headers = { 'Content-Type': 'application/json', ...(session ? { Authorization: `Bearer ${session.access_token}` } : {}) }
      let doneCount = 0
      for (let i = 0; i < 40; i++) {  // 8件/回 × 40 = 最大320テキスト/実行
        const res = await fetch('/api/review-analyze', { method: 'POST', headers, body: JSON.stringify({ facility: current }) })
        const d = await res.json()
        if (!res.ok || d.error) throw new Error(d.error || '分析に失敗しました')
        doneCount += d.analyzed
        setAnalyzeMsg(`分析中… ${doneCount}件完了 / 残り${d.remaining}件`)
        if (d.remaining === 0) break
      }
      setAnalyzeMsg(doneCount === 0 ? '未分析のテキストはありません（すべて分析済み）' : `完了: ${doneCount}件を分析しました`)
      reload()
    } catch (e) {
      setAnalyzeMsg('Error: ' + (e instanceof Error ? e.message : String(e)))
    } finally { setAnalyzing(false) }
  }

  const modeLabel = mode === '1' ? '単月' : mode === '3' ? '3ヶ月' : '12ヶ月'
  const badge = (low: boolean) => low && <span className="ml-1 text-[9px] px-1 py-0.5 rounded" style={{ background: 'var(--yellow)', color: '#3d2b1f' }}>参考値</span>

  return (
    <div className="p-6">
      <div className="flex items-end justify-between mb-4 flex-wrap gap-3">
        <div className="flex items-center gap-2 flex-wrap">
          <div className="flex rounded-md overflow-hidden" style={{ border: '1px solid var(--border)' }}>
            {(['1', '3', '12'] as const).map((v) => (
              <button key={v} onClick={() => setMode(v)} className="px-3 py-1.5 text-xs"
                style={{ background: mode === v ? 'var(--accent)' : 'var(--surface)', color: mode === v ? '#fff' : 'var(--text-dim)' }}>
                {v === '1' ? '単月' : v === '3' ? '3ヶ月' : '年'}
              </button>
            ))}
          </div>
          {months.length > 0 && (
            <select className="field px-3 py-1.5 text-sm" value={activeMonth} onChange={(e) => setMonth(e.target.value)}>
              {months.map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
          )}
        </div>
      </div>

      {/* ソースフィルタ */}
      <div className="flex items-center gap-1.5 mb-4 flex-wrap">
        <button onClick={() => setSrcFilter(new Set())} className="px-2.5 py-1 rounded-full text-xs"
          style={{ background: srcFilter.size === 0 ? 'var(--accent)' : 'var(--surface)', color: srcFilter.size === 0 ? '#fff' : 'var(--text-dim)', border: '1px solid var(--border)' }}>全て</button>
        {Object.entries(SRC_LABEL).map(([k, label]) => (
          <button key={k} onClick={() => setSrcFilter((prev) => { const n = new Set(prev); n.has(k) ? n.delete(k) : n.add(k); return n })}
            className="px-2.5 py-1 rounded-full text-xs"
            style={{ background: srcFilter.has(k) ? SRC_COLOR[k] : 'var(--surface)', color: srcFilter.has(k) ? '#fff' : 'var(--text-dim)', border: `1px solid ${srcFilter.has(k) ? SRC_COLOR[k] : 'var(--border)'}` }}>
            {label}
          </button>
        ))}
      </div>

      {loading ? <Loading /> : error ? <LoadError message={error} /> : months.length === 0 ? (
        <Empty message="クチコミが未取込です。アップロード→「クチコミ」からじゃらん/一休CSVを取り込んでください。" />
      ) : (
        <>
          {/* KPIカード */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-5">
            <div className="card p-4">
              <div className="text-xs mb-1" style={{ color: 'var(--text-dim)' }}>総合評価（3ヶ月平滑化）{badge(kOverall.low)}</div>
              <div className="text-2xl font-bold">{kOverall.v != null ? kOverall.v.toFixed(2) : '-'}<span className="text-sm font-normal" style={{ color: 'var(--text-dim)' }}> /5</span></div>
              <div className="text-[10px] mt-0.5" style={{ color: 'var(--text-dim)' }}>n={kOverall.n}</div>
            </div>
            <div className="card p-4">
              <div className="text-xs mb-1" style={{ color: 'var(--text-dim)' }}>NPS（アンケート）</div>
              <div className="text-2xl font-bold">{npsAgg.score != null ? npsAgg.score : '-'}</div>
              <div className="text-[10px] mt-0.5" style={{ color: 'var(--text-dim)' }}>{npsAgg.n ? `n=${npsAgg.n}` : 'アンケート未取込'}</div>
            </div>
            <div className="card p-4">
              <div className="text-xs mb-1" style={{ color: 'var(--text-dim)' }}>レビュー数（{modeLabel}）</div>
              <div className="text-2xl font-bold">{fmtNum(winReviews.length)}</div>
              <div className="text-[10px] mt-0.5" style={{ color: 'var(--text-dim)' }}>
                {Object.entries(srcCounts).map(([s, c]) => `${SRC_LABEL[s] ?? s}${c}`).join(' / ') || '-'}
              </div>
            </div>
            <div className="card p-4">
              <div className="text-xs mb-1" style={{ color: 'var(--text-dim)' }}>改善候補 1位</div>
              <div className="text-lg font-bold truncate">{topicsWin[0]?.label ?? '-'}</div>
              <div className="text-[10px] mt-0.5" style={{ color: 'var(--text-dim)' }}>{topicsWin[0] ? `ネガ言及 ${topicsWin[0].neg}件` : 'AI分析 未実行（C4）'}</div>
            </div>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-4">
            {/* レーダー */}
            <div className="card p-4">
              <h2 className="text-sm font-semibold mb-2">評価軸レーダー（{modeLabel} vs 前年同期間）</h2>
              {hasRadar ? (
                <ResponsiveContainer width="100%" height={280}>
                  <RadarChart data={radarData} outerRadius="70%">
                    <PolarGrid stroke="#e7dac6" />
                    <PolarAngleAxis dataKey="axis" tick={{ fill: '#927e6a', fontSize: 11 }} />
                    <PolarRadiusAxis domain={[0, 5]} tick={{ fill: '#927e6a', fontSize: 9 }} tickCount={6} />
                    <Radar name="当期間" dataKey="cur" stroke="#D85A30" fill="#D85A30" fillOpacity={0.25} />
                    <Radar name="前年同期間" dataKey="prev" stroke="#7F77DD" fill="#7F77DD" fillOpacity={0.10} />
                    <Legend wrapperStyle={{ fontSize: 11 }} />
                    <Tooltip {...chartTooltip} />
                  </RadarChart>
                </ResponsiveContainer>
              ) : <p className="text-sm py-10 text-center" style={{ color: 'var(--text-dim)' }}>データなし</p>}
            </div>

            {/* 軸別推移 */}
            <div className="card p-4">
              <div className="flex items-center justify-between mb-2">
                <h2 className="text-sm font-semibold">軸別スコア推移（3ヶ月ローリング）</h2>
                <select className="field px-2 py-1 text-xs" value={trendAxis} onChange={(e) => setTrendAxis(e.target.value)}>
                  {Object.entries(AXIS_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                </select>
              </div>
              {trendData.some((d) => d.score != null) ? (
                <ResponsiveContainer width="100%" height={252}>
                  <LineChart data={trendData} margin={{ top: 6, right: 8, bottom: 0, left: -18 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#efe6d6" vertical={false} />
                    <XAxis dataKey="month" {...CHART_AXIS} />
                    <YAxis domain={[1, 5]} {...CHART_AXIS} />
                    <Tooltip {...chartTooltip} />
                    <Line dataKey="score" name={AXIS_LABEL[trendAxis]} stroke="#D85A30" strokeWidth={2}
                      dot={(p: any) => <circle key={p.index} cx={p.cx} cy={p.cy} r={3} fill={p.payload.low ? '#faf9f5' : '#D85A30'} stroke="#D85A30" />} />
                  </LineChart>
                </ResponsiveContainer>
              ) : <p className="text-sm py-10 text-center" style={{ color: 'var(--text-dim)' }}>データなし</p>}
              <p className="text-[10px]" style={{ color: 'var(--text-dim)' }}>白抜き点=参考値（n&lt;5）</p>
            </div>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-4">
            {/* ソース別比較 */}
            <div className="card p-4">
              <h2 className="text-sm font-semibold mb-2">ソース別比較（{AXIS_LABEL[trendAxis]}・{modeLabel}）</h2>
              {srcCompare.length ? (
                <ResponsiveContainer width="100%" height={Math.max(140, srcCompare.length * 44)}>
                  <BarChart data={srcCompare} layout="vertical" margin={{ left: 30, right: 24 }}>
                    <XAxis type="number" domain={[0, 5]} {...CHART_AXIS} />
                    <YAxis type="category" dataKey="name" {...CHART_AXIS} width={70} />
                    <Tooltip {...chartTooltip} formatter={(v: any, _n: any, p: any) => [`${v}（n=${p.payload.n}）`, 'スコア']} />
                    <Bar dataKey="score" radius={[0, 4, 4, 0]} maxBarSize={22}>
                      {srcCompare.map((d) => <Cell key={d.source} fill={SRC_COLOR[d.source] ?? '#888780'} />)}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              ) : <p className="text-sm py-10 text-center" style={{ color: 'var(--text-dim)' }}>データなし</p>}
              <p className="text-[10px]" style={{ color: 'var(--text-dim)' }}>楽天は宿カルテ集計値（平滑化対象外）。アンケートとWEBのギャップ発見用。</p>
            </div>

            {/* NPS内訳（アンケート） */}
            <div className="card p-4">
              <h2 className="text-sm font-semibold mb-2">NPS内訳・推移（アンケート）</h2>
              {npsAgg.n > 0 ? (
                <>
                  <div className="flex h-6 rounded overflow-hidden text-[10px] text-white mb-1">
                    {npsAgg.pro > 0 && <div className="flex items-center justify-center" style={{ width: `${100 * npsAgg.pro / npsAgg.n}%`, background: 'var(--green)' }}>推奨{npsAgg.pro}</div>}
                    {npsAgg.pas > 0 && <div className="flex items-center justify-center" style={{ width: `${100 * npsAgg.pas / npsAgg.n}%`, background: '#B4B2A9' }}>中立{npsAgg.pas}</div>}
                    {npsAgg.det > 0 && <div className="flex items-center justify-center" style={{ width: `${100 * npsAgg.det / npsAgg.n}%`, background: 'var(--red)' }}>批判{npsAgg.det}</div>}
                  </div>
                  <p className="text-[10px] mb-2" style={{ color: 'var(--text-dim)' }}>{modeLabel}・n={npsAgg.n}</p>
                  <ResponsiveContainer width="100%" height={140}>
                    <LineChart data={npsTrend} margin={{ top: 6, right: 8, bottom: 0, left: -18 }}>
                      <XAxis dataKey="month" {...CHART_AXIS} />
                      <YAxis domain={[-100, 100]} {...CHART_AXIS} />
                      <Tooltip {...chartTooltip} />
                      <Line dataKey="nps" stroke="#D85A30" strokeWidth={2} dot={{ r: 2 }} />
                    </LineChart>
                  </ResponsiveContainer>
                </>
              ) : <p className="text-sm py-10 text-center" style={{ color: 'var(--text-dim)' }}>アンケートが未取込です（Googleフォーム運用開始後に表示されます）。</p>}
            </div>
          </div>

          {/* 改善候補（課題の特定・実引用・解決策①②③） */}
          <div className="card p-5 mb-4" style={{ borderColor: 'var(--accent)' }}>
            <div className="flex items-center gap-2 mb-1 flex-wrap">
              <h2 className="text-base font-bold">改善候補 TOP3（{modeLabel}）</h2>
              <span className="text-[10px] px-1.5 py-0.5 rounded" style={{ background: 'var(--surface2)', color: 'var(--text-dim)' }}>実クチコミ引用に基づく</span>
              <div className="ml-auto flex items-center gap-2">
                <button onClick={runAnalyze} disabled={analyzing || insightBusy}
                  className="text-xs px-3 py-1 rounded-md hover:opacity-80 disabled:opacity-50"
                  style={{ border: '1px solid var(--border)', color: 'var(--text-dim)' }}
                  title="STEP1: クチコミからトピックを抽出（新着があるときに実行）">
                  {analyzing ? '抽出中…' : '① トピック抽出'}
                </button>
                <button onClick={() => genInsight(insights.length > 0)} disabled={analyzing || insightBusy || topicsWin.length === 0}
                  className="text-xs px-3 py-1 rounded-md text-white hover:opacity-90 disabled:opacity-50"
                  style={{ background: 'var(--accent)' }}
                  title="STEP2: 課題の特定と解決策①②③を生成">
                  {insightBusy ? '生成中…' : insights.length ? '↻ レポート再生成' : '② 改善レポート生成'}
                </button>
              </div>
            </div>
            {(analyzeMsg || insightMsg) && (
              <p className="text-[11px] mb-2" style={{ color: (analyzeMsg + insightMsg).startsWith('Error') ? 'var(--red)' : 'var(--text-dim)' }}>
                {analyzeMsg}{analyzeMsg && insightMsg ? ' ／ ' : ''}{insightMsg}
              </p>
            )}

            {insights.length > 0 ? (
              <div className="space-y-4 mt-3">
                {insights.map((ins, i) => {
                  const t = topicsWin.find((x) => x.code === ins.topic_code)
                  return (
                    <div key={ins.topic_code} className="rounded-lg p-4" style={{ background: 'var(--surface2)' }}>
                      {/* 見出し */}
                      <div className="flex items-center gap-2 mb-2 flex-wrap">
                        <span className="w-7 h-7 rounded-full flex items-center justify-center text-white text-sm font-bold shrink-0" style={{ background: 'var(--accent)' }}>{i + 1}</span>
                        <span className="text-base font-bold">{ins.topic_label ?? ins.topic_code}</span>
                        {t && t.kinds >= 2 && <span className="text-[9px] px-1.5 py-0.5 rounded text-white" style={{ background: 'var(--green)' }}>確度高（WEB+アンケート）</span>}
                        {t && <span className="ml-auto text-xs whitespace-nowrap"><span style={{ color: 'var(--red)' }}>ネガ {t.neg}</span>　<span style={{ color: 'var(--green)' }}>ポジ {t.pos}</span></span>}
                      </div>
                      {/* 課題の特定 */}
                      {ins.problem && (
                        <div className="mb-3">
                          <div className="text-[11px] font-semibold mb-1" style={{ color: 'var(--accent)' }}>■ 課題</div>
                          <p className="text-sm leading-relaxed">{ins.problem}</p>
                        </div>
                      )}
                      {/* 実際のクチコミ引用 */}
                      {(ins.evidence ?? []).length > 0 && (
                        <div className="mb-3">
                          <div className="text-[11px] font-semibold mb-1" style={{ color: 'var(--accent)' }}>■ 根拠（実際のクチコミ）</div>
                          <div className="space-y-1.5">
                            {(ins.evidence ?? []).map((ev, j) => (
                              <div key={j} className="text-xs rounded-md px-3 py-2 flex items-start gap-2" style={{ background: 'var(--surface)', borderLeft: `3px solid ${SRC_COLOR[ev.source] ?? '#888780'}` }}>
                                <span className="flex-1" style={{ color: 'var(--text)' }}>“{ev.quote}”</span>
                                <span className="shrink-0 text-[10px]" style={{ color: 'var(--text-dim)' }}>
                                  {SRC_LABEL[ev.source] ?? ev.source}{ev.review_date ? `・${ev.review_date}` : ''}{ev.rating != null ? `・総合${ev.rating}` : ''}
                                </span>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                      {/* 解決策①②③ */}
                      {(ins.solutions ?? []).length > 0 && (
                        <div>
                          <div className="text-[11px] font-semibold mb-1" style={{ color: 'var(--accent)' }}>■ 解決策の候補（実施しやすい順）</div>
                          <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
                            {(ins.solutions ?? []).map((s, j) => (
                              <div key={j} className="rounded-md p-3" style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}>
                                <div className="flex items-center gap-1.5 mb-1">
                                  <span className="text-sm font-bold" style={{ color: 'var(--accent)' }}>{['①', '②', '③'][j] ?? j + 1}</span>
                                  <span className="text-xs font-semibold flex-1">{s.title}</span>
                                  <span className="text-[9px] px-1.5 py-0.5 rounded text-white shrink-0"
                                    style={{ background: s.effort === '低' ? 'var(--green)' : s.effort === '中' ? '#BA7517' : 'var(--red)' }}>
                                    負荷{s.effort}
                                  </span>
                                </div>
                                <p className="text-[11px] leading-relaxed" style={{ color: 'var(--text-dim)' }}>{s.detail}</p>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            ) : topicsWin.length > 0 ? (
              <div className="mt-2">
                <div className="flex flex-wrap gap-2 mb-2">
                  {topicsWin.slice(0, 3).map((t, i) => (
                    <span key={t.code} className="text-xs px-2.5 py-1 rounded-full" style={{ background: 'var(--surface2)' }}>
                      {i + 1}. {t.label}（<span style={{ color: 'var(--red)' }}>ネガ{t.neg}</span>）
                    </span>
                  ))}
                </div>
                <p className="text-sm" style={{ color: 'var(--text-dim)' }}>トピック抽出済み。「② 改善レポート生成」で課題の特定・実クチコミ引用・解決策①②③を作成します。</p>
              </div>
            ) : (
              <p className="text-sm py-6 text-center" style={{ color: 'var(--text-dim)' }}>まず「① トピック抽出」を実行してください（クチコミ本文から課題トピックを抽出します）。</p>
            )}
          </div>

          {/* 最新クチコミ一覧 */}
          <div className="card overflow-auto" style={{ maxHeight: 560 }}>
            <table className="w-full text-xs">
              <thead className="[&_th]:sticky [&_th]:top-0 [&_th]:z-10 [&_th]:bg-[var(--surface2)]">
                <tr className="text-left" style={{ color: 'var(--text-dim)' }}>
                  <th className="px-3 py-2 whitespace-nowrap">投稿日</th>
                  <th className="px-3 py-2">ソース</th>
                  <th className="px-3 py-2 text-right">総合</th>
                  <th className="px-3 py-2">タイトル / 本文（クリックで全文）</th>
                  <th className="px-3 py-2 whitespace-nowrap">属性</th>
                  <th className="px-3 py-2 whitespace-nowrap">宿泊日</th>
                </tr>
              </thead>
              <tbody>
                {winReviews.map((r) => {
                  const low = r.overall_rating != null && r.overall_rating * 5 / r.rating_scale <= 2
                  const attr = r.reviewer_attr ?? {}
                  return (
                    <tr key={r.id} style={{ borderTop: '1px solid var(--border)', background: low ? 'rgba(239,68,68,0.08)' : undefined }}>
                      <td className="px-3 py-2 whitespace-nowrap" style={{ color: 'var(--text-dim)' }}>{r.review_date}</td>
                      <td className="px-3 py-2 whitespace-nowrap"><span className="px-1.5 py-0.5 rounded text-white text-[10px]" style={{ background: SRC_COLOR[r.source] ?? '#888780' }}>{SRC_LABEL[r.source] ?? r.source}</span></td>
                      <td className="px-3 py-2 text-right font-semibold" style={{ color: low ? 'var(--red)' : undefined }}>{r.overall_rating ?? '-'}</td>
                      <td className="px-3 py-2 cursor-pointer" onClick={() => setOpenBody(openBody === r.id ? null : r.id)}>
                        {r.title && <div className="font-medium">{r.title}</div>}
                        <div style={{ color: 'var(--text-dim)' }}>
                          {openBody === r.id ? r.body : ((r.body ?? '').slice(0, 60) + ((r.body ?? '').length > 60 ? '…' : ''))}
                        </div>
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap" style={{ color: 'var(--text-dim)' }}>{[attr.gender, attr.age_group, attr.scene].filter((x) => x && x !== '不明').join('・') || '-'}</td>
                      <td className="px-3 py-2 whitespace-nowrap" style={{ color: 'var(--text-dim)' }}>{r.stay_date ?? '-'}</td>
                    </tr>
                  )
                })}
                {winReviews.length === 0 && <tr><td colSpan={6} className="px-3 py-6 text-center" style={{ color: 'var(--text-dim)' }}>期間内のクチコミがありません</td></tr>}
              </tbody>
            </table>
          </div>

          <p className="text-xs mt-2" style={{ color: 'var(--text-dim)' }}>
            スコアは5点満点に正規化し、総合評価はベイズ平滑化（事前分布=宿24ヶ月平均・k=10）の3ヶ月ローリング値。n&lt;5は参考値バッジ。
            楽天は宿カルテ集計値（別扱い）。改善候補はAI定性分析（C4）から自動抽出。
          </p>
        </>
      )}
    </div>
  )
}
