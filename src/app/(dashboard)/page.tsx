'use client'

// ビュー → 概要。宿の今月スナップショット（売上だけでなく予実・満足度まで）。
// カード6種（対予算比・対前年比つき）＋今期12ヶ月の表＋灯の月次レポート。予実PLは pl-compute(SSOT)で再計算。
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useFacility } from '@/lib/facility-context'
import { supabase } from '@/lib/supabase/client'
import { fetchAll } from '@/lib/supabase/fetch-all'
import { fmtYen, pct, fmtNum } from '@/lib/ui'
import { AssistantContent, SparkleIcon } from '@/components/ai-drawer'
import FeedbackButton from '@/components/feedback-button'
import ViewTabs from '@/components/view-tabs'
import { loadMeetingReport, generateMeetingReport } from '@/lib/meeting-report'
import {
  makePlResolver, priorYM,
  type BudgetRow, type ActualRow, type KpiRow, type OccRow,
} from '@/lib/pl-compute'

/* eslint-disable @typescript-eslint/no-explicit-any */
interface SatRow { month: string; channel: string; axis_code: string; n: number; raw_avg: number | null; smoothed_avg: number | null }

const reportCache = new Map<string, string>()

const SEASONAL_WORDS: Record<number, string> = {
  1: '新しい年ですね。今年もお客様の「ホッとする」を、一緒に結んでいきましょう',
  2: '河津の桜が咲く頃ですね。春を待つお客様を、あたたかくお迎えしましょう',
  3: '春の足音が聞こえます。旅立ちの季節、お客様の思い出づくりを支えましょうね',
  4: '新年度ですね。今年の宿の物語、どんな一年にしましょうか',
  5: '新緑の季節です。連休のお客様をお見送りしたら、ひと息つきましょうね',
  6: '雨の音も、宿では風情になりますね。梅雨こそ「おこもり」の魅力を',
  7: '夏がやってきます。湯上がりの夕涼み、お客様の記憶に残る季節ですね',
  8: 'お盆の繁忙、本当におつかれさまです。スタッフの皆さんにもねぎらいを',
  9: '夏の疲れが出る頃です。宿もわたしたちも、少し息を整えましょう',
  10: '紅葉の便りが届き始めましたね。秋のお客様をお迎えする準備を',
  11: '湯けむりが恋しい季節になりました。温泉宿の本領発揮ですね',
  12: '一年の締めくくりですね。年越しのお客様に、良い年の瀬を',
}

const fiscalYearOf = (ym: string) => { const y = +ym.slice(0, 4), m = +ym.slice(5, 7); return m >= 4 ? y : y - 1 }
const fyMonths = (fy: number) => {
  const out: string[] = []
  for (let m = 4; m <= 12; m++) out.push(`${fy}-${String(m).padStart(2, '0')}`)
  for (let m = 1; m <= 3; m++) out.push(`${fy + 1}-${String(m).padStart(2, '0')}`)
  return out
}

export default function OverviewPage() {
  const { current, currentFacility } = useFacility()
  const [budget, setBudget] = useState<BudgetRow[]>([])
  const [actual, setActual] = useState<ActualRow[]>([])
  const [kpi, setKpi] = useState<KpiRow[]>([])
  const [occ, setOcc] = useState<OccRow[]>([])
  const [opRooms, setOpRooms] = useState<Record<string, number>>({})
  const [forecast, setForecast] = useState<BudgetRow[]>([])
  const [satRows, setSatRows] = useState<SatRow[]>([])
  const [report, setReport] = useState('')
  const [reportBusy, setReportBusy] = useState(false)
  const [reportErr, setReportErr] = useState('')
  const [loading, setLoading] = useState(true)
  const [initiativeMissing, setInitiativeMissing] = useState(false)
  const [meetingMissing, setMeetingMissing] = useState(false)

  const totalRooms = currentFacility?.total_rooms ?? null

  useEffect(() => {
    if (!current) return
    const ym = `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}`
    supabase.from('raw_facility_initiative').select('id').eq('facility', current).eq('year_month', ym).limit(1)
      .then(({ data, error }) => setInitiativeMissing(!error && (data ?? []).length === 0))
    supabase.from('raw_meeting_record').select('id').eq('facility', current).eq('year_month', ym).limit(1)
      .then(({ data, error }) => setMeetingMissing(!error && (data ?? []).length === 0))
  }, [current])

  useEffect(() => {
    if (!current) return
    setLoading(true)
    Promise.all([
      fetchAll(() => supabase.from('budget_monthly').select('fiscal_year, month, category, item_code, item_name, amount, sort_order').eq('facility', current).eq('version', '当初').order('id')),
      fetchAll(() => supabase.from('actual_monthly').select('fiscal_year, month, item_code, actual').eq('facility', current).order('id')),
      fetchAll(() => supabase.from('mart_monthly_kpi').select('month, guests, adr, guest_unit, companion').eq('facility', current)),
      fetchAll(() => supabase.from('mart_occupancy_monthly').select('month, rooms_sold, occ, occ_calendar_days, operating_days').eq('facility', current)),
      supabase.from('dim_operating_days').select('month, rooms').eq('facility', current).then((r) => r),
      fetchAll(() => supabase.from('budget_monthly').select('fiscal_year, month, category, item_code, item_name, amount, sort_order, version').eq('facility', current).like('version', '見込%').order('id')),
      fetchAll(() => supabase.from('mart_guest_feedback_3mo').select('month, channel, axis_code, n, raw_avg, smoothed_avg').eq('facility', current).eq('axis_code', 'overall')),
    ]).then(([b, a, kp, oc, od, fc, sat]: any[]) => {
      setBudget((b as BudgetRow[]) ?? [])
      setActual((a as ActualRow[]) ?? [])
      setKpi((kp as KpiRow[]) ?? [])
      setOcc((oc as OccRow[]) ?? [])
      const rbm: Record<string, number> = {}
      ;(((od as any)?.data as { month: string; rooms: number | null }[]) ?? []).forEach((r) => { if (r.rooms != null) rbm[r.month] = r.rooms })
      setOpRooms(rbm)
      const fcRows = (fc as any[]) ?? []
      const fvs = [...new Set(fcRows.map((r) => r.version as string))].sort()
      const maxV = fvs[fvs.length - 1]
      setForecast((maxV ? fcRows.filter((r) => r.version === maxV) : []) as BudgetRow[])
      setSatRows((sat as SatRow[]) ?? [])
      setLoading(false)
    }).catch(() => setLoading(false))
  }, [current])

  // 最新の実績月（無ければ最新の予算/データ月）→ 今期(FY)を決める
  const latestMonth = useMemo(() => {
    const am = actual.map((a) => a.month)
    if (am.length) { const s = [...am].sort(); return s[s.length - 1] }
    const all = [...new Set([...budget.map((b) => b.month), ...kpi.map((k) => k.month)])].sort()
    return all[all.length - 1] ?? ''
  }, [actual, budget, kpi])
  const fy = latestMonth ? fiscalYearOf(latestMonth) : fiscalYearOf(`${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}`)
  const fyMs = useMemo(() => fyMonths(fy), [fy])

  const resolver = useMemo(
    () => makePlResolver({ budget, actual, kpi, occ, opRooms, totalRooms, fy: String(fy), forecast }),
    [budget, actual, kpi, occ, opRooms, totalRooms, fy, forecast])

  // 満足度: 月別の総合評価（3ヶ月ローリングmartをn加重）
  const satByMonth = useMemo(() => {
    const m: Record<string, { sum: number; n: number }> = {}
    for (const r of satRows) {
      const s = r.smoothed_avg ?? r.raw_avg; if (s == null) continue
      ;(m[r.month] ??= { sum: 0, n: 0 }); m[r.month].sum += s * r.n; m[r.month].n += r.n
    }
    const out: Record<string, number | null> = {}
    for (const [mo, v] of Object.entries(m)) out[mo] = v.n > 0 ? v.sum / v.n : null
    return out
  }, [satRows])

  const loadReport = useCallback(async (facility: string, month: string) => {
    const key = `${facility}|${month}`
    if (reportCache.has(key)) { setReport(reportCache.get(key)!); return }
    setReport(''); setReportErr('')
    const text = await loadMeetingReport(facility, month)
    setReport(text); if (text) reportCache.set(key, text)
  }, [])
  const genReport = useCallback(async (facility: string, month: string) => {
    setReportBusy(true); setReportErr('')
    try {
      const { content, error } = await generateMeetingReport(facility, month)
      if (error) setReportErr(String(error))
      setReport(content); if (content) reportCache.set(`${facility}|${month}`, content)
    } catch (e) { setReportErr(e instanceof Error ? e.message : String(e)) } finally { setReportBusy(false) }
  }, [])
  useEffect(() => { if (current && latestMonth) loadReport(current, latestMonth) }, [current, latestMonth, loadReport])

  // カード用: 実績 / 予算 / 前年
  const lm = latestMonth
  const pm = lm ? priorYM(lm) : ''
  const val = (code: string) => resolver.getActual(code, lm)
  const bud = (code: string) => resolver.getBudget(code, lm)
  const prv = (code: string) => resolver.getActual(code, pm)

  const budgetRate = lm ? (() => { const a = val('sales_total'), b = bud('sales_total'); return a != null && b ? a / b : null })() : null

  const cards: CardDef[] = [
    { label: '売上', kind: 'yen', cur: val('sales_total'), bud: bud('sales_total'), prev: prv('sales_total'), accent: true },
    { label: 'OCC（稼働率）', kind: 'occ', cur: val('稼働率'), bud: bud('稼働率'), prev: prv('稼働率') },
    { label: '室単価', kind: 'yen', cur: val('室単価'), bud: bud('室単価'), prev: prv('室単価') },
    { label: 'GOP', kind: 'yen', cur: val('gop'), bud: bud('gop'), prev: prv('gop') },
    { label: '営業利益', kind: 'yen', cur: val('operating_income'), bud: bud('operating_income'), prev: prv('operating_income') },
    { label: '顧客満足度 総合', kind: 'score', cur: satByMonth[lm] ?? null, bud: null, prev: satByMonth[pm] ?? null },
  ]

  // 今期の想定着地（実績＞見込＞予算）と年度予算・予算差異
  const sumB = (code: string) => fyMs.reduce((s, m) => s + (resolver.getBudget(code, m) ?? 0), 0)
  const summary = {
    sales: { land: resolver.yearLanding('sales_total'), bud: resolver.yearBudget('sales_total') },
    occ: { land: resolver.yearLanding('稼働率'), bud: sumB('在庫数') > 0 ? sumB('販売室数') / sumB('在庫数') : null },
    adr: { land: resolver.yearLanding('室単価'), bud: sumB('販売室数') > 0 ? sumB('sales_total') / sumB('販売室数') : null },
    gop: { land: resolver.yearLanding('gop'), bud: resolver.yearBudget('gop') },
    oi: { land: resolver.yearLanding('operating_income'), bud: resolver.yearBudget('operating_income') },
  }
  const fcMonths = useMemo(() => new Set(forecast.map((f) => f.month)), [forecast])
  const dyen = (l: number | null, b: number | null): { t: string; c?: string } =>
    (l == null || b == null) ? { t: '-' } : { t: (l - b >= 0 ? '+' : '') + fmtNum(l - b), c: l - b >= 0 ? 'var(--green)' : 'var(--red)' }
  const dpt = (l: number | null, b: number | null): { t: string; c?: string } =>
    (l == null || b == null) ? { t: '-' } : { t: ((l - b) * 100 >= 0 ? '+' : '') + ((l - b) * 100).toFixed(1) + 'pt', c: (l - b) >= 0 ? 'var(--green)' : 'var(--red)' }
  const diffCells = [dyen(summary.sales.land, summary.sales.bud), dpt(summary.occ.land, summary.occ.bud), dyen(summary.adr.land, summary.adr.bud), dyen(summary.gop.land, summary.gop.bud), dyen(summary.oi.land, summary.oi.bud)]

  const noData = !loading && !lm

  return (
    <div className="p-6">
      <ViewTabs />

      <div className="flex items-start justify-between mb-5 gap-4 flex-wrap">
        <p className="text-sm" style={{ color: 'var(--text-dim)' }}>{lm}{lm && !resolver.actualMonths.has(lm) ? '（予算）' : ''}</p>
        <p className="text-[11px] max-w-72 text-right leading-relaxed" style={{ color: 'var(--text-dim)' }}>
          {SEASONAL_WORDS[new Date().getMonth() + 1]} — 灯
        </p>
      </div>

      {loading ? (
        <p style={{ color: 'var(--text-dim)' }}>読み込み中...</p>
      ) : noData ? (
        <div className="card p-6 text-center" style={{ borderColor: 'var(--yellow)' }}>
          <p className="font-medium" style={{ color: 'var(--yellow)' }}>データ未登録</p>
          <p className="text-sm mt-1" style={{ color: 'var(--text-dim)' }}>/upload からCSVファイルをアップロードしてください</p>
        </div>
      ) : (
        <>
          {initiativeMissing && (
            <div className="card p-3 mb-4 text-xs flex items-center gap-2" style={{ borderColor: 'var(--yellow)' }}>
              <span className="px-1.5 py-0.5 rounded text-white text-[10px]" style={{ background: 'var(--red)' }}>未記録</span>
              <span style={{ color: 'var(--text-dim)' }}>支配人、今月の「取組履歴」がまだのようです。小さなことでも記録しておくと、わたしの分析がもっとお役に立てます（宿プロフィール）。— 灯</span>
            </div>
          )}
          {meetingMissing && (
            <div className="card p-3 mb-4 text-xs flex items-center gap-2" style={{ borderColor: 'var(--yellow)' }}>
              <span className="px-1.5 py-0.5 rounded text-white text-[10px]" style={{ background: 'var(--red)' }}>未記録</span>
              <span style={{ color: 'var(--text-dim)' }}>支配人、今月の「月次会議」の記録がまだのようです。会議の後に残しておくと、翌月の振り返りに活きます（月次会議）。— 灯</span>
            </div>
          )}

          {/* KPIカード6種（対予算比・対前年比つき） */}
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4 mb-6">
            {cards.map((c) => <MetricCard key={c.label} {...c} />)}
          </div>

          {budgetRate != null && budgetRate >= 1 && (
            <div className="flex items-center gap-3 mb-6 px-4 py-2.5 rounded-lg" style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src="/mizuhiki.png" alt="" className="mizuhiki-celebrate" style={{ width: 30, height: 'auto' }} />
              <p className="text-xs" style={{ color: 'var(--text-dim)' }}>
                {lm} は予算達成（{pct(budgetRate)}）です。皆さんの積み重ねが結ばれましたね。おめでとうございます — 灯
              </p>
            </div>
          )}

          {/* 灯の月次レポート */}
          <div className="card p-4 mb-6" style={{ background: 'linear-gradient(135deg, var(--surface), var(--surface2))', borderColor: 'var(--accent)' }}>
            <div className="flex items-center gap-2 mb-2">
              <SparkleIcon size={16} />
              <h2 className="text-sm font-semibold">灯の月次レポート（{lm}）</h2>
              <button onClick={() => lm && genReport(current, lm)} disabled={reportBusy || !lm}
                className="ml-auto text-xs px-2 py-0.5 rounded-md hover:opacity-80 disabled:opacity-40"
                style={{ color: 'var(--text-dim)', border: '1px solid var(--border)' }} title="最新データで生成">
                {reportBusy ? '生成中…' : report ? '↻ 再生成' : '生成'}
              </button>
            </div>
            {reportBusy ? (
              <p className="text-sm" style={{ color: 'var(--text-dim)' }}>灯が{lm}の実績・クチコミ・生産性・先月の取組を読んでレポートを編んでいます…</p>
            ) : report ? (
              <>
                <AssistantContent content={report} />
                <div className="mt-2"><FeedbackButton source="summary" question={`${lm} 月次レポート`} answer={report} facility={current} /></div>
              </>
            ) : reportErr ? (
              <p className="text-sm" style={{ color: 'var(--red)' }}>生成エラー: {reportErr}</p>
            ) : (
              <p className="text-sm" style={{ color: 'var(--text-dim)' }}>「生成」で、灯が今月の実績・クチコミ・生産性・先月の取組の効果・課題と次の一手を一枚にまとめます（月次会議と同じ内容）。</p>
            )}
          </div>

          {/* 今期12ヶ月の表 */}
          <div className="card overflow-x-auto">
            <div className="px-4 pt-3 text-sm font-semibold">{fy}年度（今期12ヶ月）</div>
            <table className="w-full text-sm whitespace-nowrap mt-2">
              <thead>
                <tr style={{ background: 'var(--surface2)', color: 'var(--text-dim)' }} className="text-left">
                  <th className="px-4 py-3">月</th>
                  <th className="px-4 py-3 text-right">売上</th>
                  <th className="px-4 py-3 text-right">OCC</th>
                  <th className="px-4 py-3 text-right">室単価</th>
                  <th className="px-4 py-3 text-right">GOP</th>
                  <th className="px-4 py-3 text-right">営業利益</th>
                  <th className="px-4 py-3 text-right">顧客満足度</th>
                </tr>
              </thead>
              <tbody>
                {fyMs.map((m) => {
                  const isA = resolver.actualMonths.has(m)
                  return (
                    <tr key={m} style={{ borderTop: '1px solid var(--border)', background: isA ? undefined : 'rgba(216,90,48,0.03)' }}>
                      <td className="px-4 py-2 font-medium">{m}{!isA && <span className="ml-1 text-[9px] px-1 py-0.5 rounded" style={{ background: 'var(--surface2)', color: 'var(--text-dim)' }}>{fcMonths.has(m) ? '見込' : '予算'}</span>}</td>
                      <td className="px-4 py-2 text-right">{fmtNum(resolver.landingFor('sales_total', m))}</td>
                      <td className="px-4 py-2 text-right">{pct(resolver.landingFor('稼働率', m))}</td>
                      <td className="px-4 py-2 text-right">{fmtNum(resolver.landingFor('室単価', m))}</td>
                      <td className="px-4 py-2 text-right">{fmtNum(resolver.landingFor('gop', m))}</td>
                      <td className="px-4 py-2 text-right">{fmtNum(resolver.landingFor('operating_income', m))}</td>
                      <td className="px-4 py-2 text-right" style={{ color: 'var(--text-dim)' }}>{satByMonth[m] != null ? satByMonth[m]!.toFixed(2) : '-'}</td>
                    </tr>
                  )
                })}
                {/* 今期の想定着地 */}
                <tr style={{ borderTop: '2px solid var(--border)', background: 'var(--surface2)' }} className="font-bold">
                  <td className="px-4 py-2">着地見込</td>
                  <td className="px-4 py-2 text-right">{fmtNum(summary.sales.land)}</td>
                  <td className="px-4 py-2 text-right">{pct(summary.occ.land)}</td>
                  <td className="px-4 py-2 text-right">{fmtNum(summary.adr.land)}</td>
                  <td className="px-4 py-2 text-right">{fmtNum(summary.gop.land)}</td>
                  <td className="px-4 py-2 text-right">{fmtNum(summary.oi.land)}</td>
                  <td className="px-4 py-2 text-right" style={{ color: 'var(--text-dim)' }}>-</td>
                </tr>
                <tr style={{ borderTop: '1px solid var(--border)', background: 'var(--surface2)', color: 'var(--text-dim)' }}>
                  <td className="px-4 py-2">年度予算</td>
                  <td className="px-4 py-2 text-right">{fmtNum(summary.sales.bud)}</td>
                  <td className="px-4 py-2 text-right">{pct(summary.occ.bud)}</td>
                  <td className="px-4 py-2 text-right">{fmtNum(summary.adr.bud)}</td>
                  <td className="px-4 py-2 text-right">{fmtNum(summary.gop.bud)}</td>
                  <td className="px-4 py-2 text-right">{fmtNum(summary.oi.bud)}</td>
                  <td className="px-4 py-2 text-right">-</td>
                </tr>
                <tr style={{ borderTop: '1px solid var(--border)', background: 'var(--surface2)' }} className="font-medium">
                  <td className="px-4 py-2">予算差異</td>
                  {diffCells.map((d, i) => <td key={i} className="px-4 py-2 text-right" style={{ color: d.c }}>{d.t}</td>)}
                  <td className="px-4 py-2 text-right" style={{ color: 'var(--text-dim)' }}>-</td>
                </tr>
              </tbody>
            </table>
            <p className="text-xs px-4 py-3" style={{ color: 'var(--text-dim)' }}>
              実績のある月は実績、無い月は予算（見込があれば見込）。「着地見込」＝実績＋残月見込の今期想定着地、「予算差異」＝着地−年度予算（緑=予算超・赤=未達）。
              GOP・営業利益は予実PL（sales−原価−人件費−販管費、EBITDA−減価償却）を再計算。顧客満足度は3ヶ月平滑化の総合評価。
            </p>
          </div>
        </>
      )}
    </div>
  )
}

/* ===== カード ===== */
interface CardDef { label: string; kind: 'yen' | 'occ' | 'score'; cur: number | null; bud: number | null; prev: number | null; accent?: boolean }

function MetricCard({ label, kind, cur, bud, prev, accent }: CardDef) {
  const valStr = cur == null ? '-' : kind === 'yen' ? fmtYen(cur) : kind === 'occ' ? pct(cur) : cur.toFixed(2)
  // 比較: yen=比率(達成率/前年比), occ=pt差, score=スコア差
  const cmp = (base: number | null): { txt: string; color?: string } => {
    if (cur == null || base == null) return { txt: '—' }
    if (kind === 'yen') {
      if (base <= 0) return { txt: '—' }
      const r = cur / base
      return { txt: pct(r), color: r >= 1 ? 'var(--green)' : 'var(--red)' }
    }
    if (kind === 'occ') {
      const d = (cur - base) * 100
      return { txt: `${d >= 0 ? '+' : ''}${d.toFixed(1)}pt`, color: d >= 0 ? 'var(--green)' : 'var(--red)' }
    }
    const d = cur - base
    return { txt: `${d >= 0 ? '+' : ''}${d.toFixed(2)}`, color: d >= 0 ? 'var(--green)' : 'var(--red)' }
  }
  const b = cmp(bud), p = cmp(prev)
  return (
    <div className="card p-4">
      <p className="text-xs mb-1" style={{ color: 'var(--text-dim)' }}>{label}</p>
      <p className="text-xl font-bold mb-1.5" style={{ color: accent ? 'var(--accent)' : 'var(--text)' }}>{valStr}</p>
      <div className="flex flex-col gap-0.5 text-[11px]">
        <div className="flex justify-between"><span style={{ color: 'var(--text-dim)' }}>対予算</span><span style={{ color: b.color ?? 'var(--text-dim)' }}>{b.txt}</span></div>
        <div className="flex justify-between"><span style={{ color: 'var(--text-dim)' }}>対前年</span><span style={{ color: p.color ?? 'var(--text-dim)' }}>{p.txt}</span></div>
      </div>
    </div>
  )
}
