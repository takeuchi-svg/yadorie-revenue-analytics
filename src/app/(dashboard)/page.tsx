'use client'

import { useCallback, useEffect, useState } from 'react'
import { useFacility } from '@/lib/facility-context'
import { supabase } from '@/lib/supabase/client'
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer,
  PieChart, Pie, Cell, Legend,
} from 'recharts'
import { fmtYen, pct, fmtNum, channelColor, CHART_AXIS, chartTooltip } from '@/lib/ui'
import { AssistantContent, SparkleIcon } from '@/components/ai-drawer'
import type { MonthlyKpiRow as MonthlyKpi, OccupancyMonthlyRow as OccRow, ChannelRow } from '@/lib/db-types'

// AIサマリ/課題のセッション内キャッシュ（facility|month → 本文）。本体の共有キャッシュはDB(ai_summary/ai_issue)
const summaryCache = new Map<string, string>()
const issueCache = new Map<string, string>()

// 灯からの季節の一言（YADORIE Core §6。静的・月替わり）
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

export default function OverviewPage() {
  const { current, currentFacility } = useFacility()
  const [kpi, setKpi] = useState<MonthlyKpi[]>([])
  const [occByMonth, setOccByMonth] = useState<Record<string, number | null>>({})
  const [capByMonth, setCapByMonth] = useState<Record<string, number | null>>({})
  const [budgetByMonth, setBudgetByMonth] = useState<Record<string, number | null>>({})
  const [aiSummary, setAiSummary] = useState('')
  const [aiLoading, setAiLoading] = useState(false)
  const [aiErr, setAiErr] = useState('')
  const [aiIssue, setAiIssue] = useState('')
  const [aiIssueLoading, setAiIssueLoading] = useState(false)
  const [aiIssueErr, setAiIssueErr] = useState('')
  const [channels, setChannels] = useState<ChannelRow[]>([])
  const [loading, setLoading] = useState(true)
  const [initiativeMissing, setInitiativeMissing] = useState(false)

  // 施設プロフィール: 当月の取組が未記録なら督促（テーブル未作成時は無視）
  useEffect(() => {
    if (!current) return
    const ym = `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}`
    supabase.from('raw_facility_initiative').select('id').eq('facility', current).eq('year_month', ym).limit(1)
      .then(({ data, error }) => setInitiativeMissing(!error && (data ?? []).length === 0))
  }, [current])

  useEffect(() => {
    if (!current) return
    setLoading(true)
    Promise.all([
      supabase.from('mart_monthly_kpi').select('*').eq('facility', current)
        .order('month', { ascending: false }).limit(12),
      supabase.from('mart_occupancy_monthly').select('month, occ, occ_calendar_days, rooms_sold, operating_days, total_rooms').eq('facility', current),
      supabase.from('mart_budget_revenue_monthly').select('month, revenue_budget').eq('facility', current),
    ]).then(([kpiRes, occRes, budRes]) => {
      const kpiData = (kpiRes.data as MonthlyKpi[]) ?? []
      setKpi(kpiData)
      const occMap: Record<string, number | null> = {}
      const capMap: Record<string, number | null> = {}
      ;((occRes.data as OccRow[]) ?? []).forEach((o) => {
        occMap[o.month] = o.occ_calendar_days ?? o.occ   // 稼働率は全日ベースを主に表示（未算出時は稼働日ベース）
        capMap[o.month] = (o.total_rooms && o.operating_days) ? o.total_rooms * o.operating_days : null
      })
      const budMap: Record<string, number | null> = {}
      ;((budRes.data as { month: string; revenue_budget: number | null }[]) ?? []).forEach((b) => { budMap[b.month] = b.revenue_budget })
      setBudgetByMonth(budMap)
      setOccByMonth(occMap)
      setCapByMonth(capMap)

      const latestMonth = kpiData[0]?.month
      if (latestMonth) {
        supabase.from('mart_channel_monthly').select('channel, revenue')
          .eq('facility', current).eq('month', latestMonth)
          .then(({ data }) => {
            setChannels((data as ChannelRow[]) ?? [])
            setLoading(false)
          })
      } else {
        setChannels([])
        setLoading(false)
      }
    })
  }, [current])

  // 概要のAIサマリ。生成・保存はサーバー(/api/insight)が担い、DB(ai_summary)に1つだけ保存して全員で共有。
  // 開いてもキャッシュがあれば再生成しない。再生成ボタン(force)を押した時だけ作り直す。
  const genSummary = useCallback(async (facility: string, month: string, force = false) => {
    const key = `${facility}|${month}`
    if (!force && summaryCache.has(key)) { setAiSummary(summaryCache.get(key)!); return }
    setAiLoading(true); setAiSummary(''); setAiErr('')
    try {
      const { data: { session } } = await supabase.auth.getSession()
      const res = await fetch('/api/insight', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(session ? { Authorization: `Bearer ${session.access_token}` } : {}) },
        body: JSON.stringify({ facility, month, kind: 'summary', force }),
      })
      const d = await res.json()
      const text = d.content || ''
      setAiSummary(text); if (text) summaryCache.set(key, text)
      if (!text && d.error) setAiErr(String(d.error))
    } catch (e) { setAiSummary(''); setAiErr(e instanceof Error ? e.message : String(e)) } finally { setAiLoading(false) }
  }, [])

  // 概要のAI課題と対策（参考）。サマリと同じく1つだけ保存して全員で共有。
  const genIssue = useCallback(async (facility: string, month: string, force = false) => {
    const key = `${facility}|${month}`
    if (!force && issueCache.has(key)) { setAiIssue(issueCache.get(key)!); return }
    setAiIssueLoading(true); setAiIssue(''); setAiIssueErr('')
    try {
      const { data: { session } } = await supabase.auth.getSession()
      const res = await fetch('/api/insight', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(session ? { Authorization: `Bearer ${session.access_token}` } : {}) },
        body: JSON.stringify({ facility, month, kind: 'issue', force }),
      })
      const d = await res.json()
      const text = d.content || ''
      setAiIssue(text); if (text) issueCache.set(key, text)
      if (!text && d.error) setAiIssueErr(String(d.error))
    } catch (e) { setAiIssue(''); setAiIssueErr(e instanceof Error ? e.message : String(e)) } finally { setAiIssueLoading(false) }
  }, [])

  useEffect(() => {
    const lm = kpi[0]?.month
    if (current && lm) { genSummary(current, lm); genIssue(current, lm) }
  }, [current, kpi, genSummary, genIssue])

  const latest = kpi[0]
  const latestOcc = latest ? occByMonth[latest.month] ?? null : null
  const latestCap = latest ? capByMonth[latest.month] ?? null : null
  // REVPAR = 売上 ÷ 利用可能室数（総室数×営業日数）。予算入力なしで自動算出。
  const latestRevpar = latest && latest.revenue && latestCap ? latest.revenue / latestCap : null
  const latestBudget = latest ? budgetByMonth[latest.month] ?? null : null
  const budgetRate = latest && latest.revenue && latestBudget
    ? latest.revenue / latestBudget : null

  // Trend (oldest→newest, last 6)
  const trend = [...kpi].reverse().slice(-6).map((r) => ({
    month: r.month.slice(2),
    revenue: r.revenue ?? 0,
  }))

  const channelData = channels
    .filter((c) => (c.revenue ?? 0) > 0)
    .map((c) => ({ name: c.channel || 'その他', value: c.revenue ?? 0 }))

  return (
    <div className="p-6">
      <div className="flex items-start justify-between mb-6 gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold mb-1">Overview</h1>
          <p className="text-sm" style={{ color: 'var(--text-dim)' }}>
            {currentFacility?.name ?? current}{latest ? ` ・ ${latest.month}` : ''}
          </p>
        </div>
        {/* 灯からの季節の一言（§6） */}
        <p className="text-[11px] max-w-72 text-right leading-relaxed" style={{ color: 'var(--text-dim)' }}>
          {SEASONAL_WORDS[new Date().getMonth() + 1]} — 灯
        </p>
      </div>

      {loading ? (
        <p style={{ color: 'var(--text-dim)' }}>読み込み中...</p>
      ) : kpi.length === 0 ? (
        <div className="card p-6 text-center" style={{ borderColor: 'var(--yellow)' }}>
          <p className="font-medium" style={{ color: 'var(--yellow)' }}>データ未登録</p>
          <p className="text-sm mt-1" style={{ color: 'var(--text-dim)' }}>
            /upload からCSVファイルをアップロードしてください
          </p>
        </div>
      ) : (
        <>
          {initiativeMissing && (
            <div className="card p-3 mb-4 text-xs flex items-center gap-2" style={{ borderColor: 'var(--yellow)' }}>
              <span className="px-1.5 py-0.5 rounded text-white text-[10px]" style={{ background: 'var(--red)' }}>未記録</span>
              <span style={{ color: 'var(--text-dim)' }}>支配人、今月の「取組履歴」がまだのようです。小さなことでも記録しておくと、わたしの分析がもっとお役に立てます（設定 → 施設プロフィール）。— 灯</span>
            </div>
          )}
          {/* KPI Cards (6, per UI spec) */}
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4 mb-6">
            <KpiCard label="売上" value={fmtYen(latest?.revenue)} />
            <KpiCard label="OCC（稼働率）" value={pct(latestOcc)} accent />
            <KpiCard label="REVPAR" value={fmtYen(latestRevpar)} />
            <KpiCard label="客単価" value={fmtYen(latest?.guest_unit)} />
            <KpiCard label="予算達成率" value={pct(budgetRate)} />
            <KpiCard label="同伴係数" value={latest?.companion?.toFixed(2) ?? '-'} />
          </div>

          {/* 達成の小さな祝い（§6: 予算達成の節目に、控えめな水引と灯の一言） */}
          {budgetRate != null && budgetRate >= 1 && (
            <div className="flex items-center gap-3 mb-6 px-4 py-2.5 rounded-lg" style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src="/mizuhiki.png" alt="" className="mizuhiki-celebrate" style={{ width: 30, height: 'auto' }} />
              <p className="text-xs" style={{ color: 'var(--text-dim)' }}>
                {latest?.month} は予算達成（{pct(budgetRate)}）です。皆さんの積み重ねが結ばれましたね。おめでとうございます — 灯
              </p>
            </div>
          )}

          {/* AI実績サマリ */}
          <div className="card p-4 mb-6" style={{ background: 'linear-gradient(135deg, var(--surface), var(--surface2))', borderColor: 'var(--accent)' }}>
            <div className="flex items-center gap-2 mb-2">
              <SparkleIcon size={16} />
              <h2 className="text-sm font-semibold">灯からの実績サマリ（{latest?.month}）</h2>
              <button
                onClick={() => latest && genSummary(current, latest.month, true)}
                disabled={aiLoading || !latest}
                className="ml-auto text-xs px-2 py-0.5 rounded-md hover:opacity-80 disabled:opacity-40"
                style={{ color: 'var(--text-dim)', border: '1px solid var(--border)' }}
                title="最新データで再生成"
              >
                ↻ 再生成
              </button>
            </div>
            {aiLoading ? (
              <p className="text-sm" style={{ color: 'var(--text-dim)' }}>生成中...</p>
            ) : aiSummary ? (
              <AssistantContent content={aiSummary} />
            ) : aiErr ? (
              <p className="text-sm" style={{ color: 'var(--red)' }}>生成エラー: {aiErr}</p>
            ) : (
              <p className="text-sm" style={{ color: 'var(--text-dim)' }}>AIサマリは未生成です（APIキー設定後に表示されます）。</p>
            )}
          </div>

          {/* AI分析の課題と対策（参考） */}
          <div className="card p-4 mb-6" style={{ borderColor: 'var(--border)' }}>
            <div className="flex items-center gap-2 mb-2">
              <SparkleIcon size={16} />
              <h2 className="text-sm font-semibold">灯からの課題と対策（参考）</h2>
              <span className="text-[10px] px-1.5 py-0.5 rounded" style={{ background: 'var(--surface2)', color: 'var(--text-dim)' }}>仮説・参考</span>
              <button
                onClick={() => latest && genIssue(current, latest.month, true)}
                disabled={aiIssueLoading || !latest}
                className="ml-auto text-xs px-2 py-0.5 rounded-md hover:opacity-80 disabled:opacity-40"
                style={{ color: 'var(--text-dim)', border: '1px solid var(--border)' }}
                title="最新データで再生成"
              >
                ↻ 再生成
              </button>
            </div>
            {aiIssueLoading ? (
              <p className="text-sm" style={{ color: 'var(--text-dim)' }}>生成中...</p>
            ) : aiIssue ? (
              <AssistantContent content={aiIssue} />
            ) : aiIssueErr ? (
              <p className="text-sm" style={{ color: 'var(--red)' }}>生成エラー: {aiIssueErr}</p>
            ) : (
              <p className="text-sm" style={{ color: 'var(--text-dim)' }}>課題と対策は未生成です（APIキー設定後に表示されます）。</p>
            )}
          </div>

          {/* Charts */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-6">
            <div className="card p-4">
              <h2 className="text-sm font-semibold mb-3">月次売上推移（直近6ヶ月）</h2>
              <ResponsiveContainer width="100%" height={240}>
                <BarChart data={trend}>
                  <XAxis dataKey="month" {...CHART_AXIS} />
                  <YAxis {...CHART_AXIS} tickFormatter={(v) => `${Math.round(v / 1e6)}M`} />
                  <Tooltip {...chartTooltip} formatter={(v) => fmtYen(Number(v))} />
                  <Bar dataKey="revenue" fill="var(--accent)" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>

            <div className="card p-4">
              <h2 className="text-sm font-semibold mb-3">チャネル別売上構成比（{latest?.month}）</h2>
              {channelData.length === 0 ? (
                <p className="text-sm py-16 text-center" style={{ color: 'var(--text-dim)' }}>データなし</p>
              ) : (
                <ResponsiveContainer width="100%" height={240}>
                  <PieChart>
                    <Pie data={channelData} dataKey="value" nameKey="name" innerRadius={55} outerRadius={90}>
                      {channelData.map((d) => (
                        <Cell key={d.name} fill={channelColor(d.name)} />
                      ))}
                    </Pie>
                    <Tooltip {...chartTooltip} formatter={(v) => fmtYen(Number(v))} />
                    <Legend wrapperStyle={{ fontSize: 11, color: 'var(--text-dim)' }} />
                  </PieChart>
                </ResponsiveContainer>
              )}
            </div>
          </div>

          {/* Monthly table */}
          <div className="card overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr style={{ background: 'var(--surface2)', color: 'var(--text-dim)' }} className="text-left">
                  <th className="px-4 py-3">月</th>
                  <th className="px-4 py-3 text-right">売上</th>
                  <th className="px-4 py-3 text-right">予算</th>
                  <th className="px-4 py-3 text-right">室泊数</th>
                  <th className="px-4 py-3 text-right">人泊数</th>
                  <th className="px-4 py-3 text-right">OCC</th>
                  <th className="px-4 py-3 text-right">ADR</th>
                  <th className="px-4 py-3 text-right">客単価</th>
                </tr>
              </thead>
              <tbody>
                {kpi.map((row) => (
                  <tr key={row.month} style={{ borderTop: '1px solid var(--border)' }}>
                    <td className="px-4 py-2 font-medium">{row.month}</td>
                    <td className="px-4 py-2 text-right">{fmtNum(row.revenue)}</td>
                    <td className="px-4 py-2 text-right" style={{ color: 'var(--text-dim)' }}>{fmtNum(budgetByMonth[row.month] ?? null)}</td>
                    <td className="px-4 py-2 text-right">{fmtNum(row.rooms_sold)}</td>
                    <td className="px-4 py-2 text-right">{fmtNum(row.guests)}</td>
                    <td className="px-4 py-2 text-right">{pct(occByMonth[row.month] ?? null)}</td>
                    <td className="px-4 py-2 text-right">{fmtNum(row.adr)}</td>
                    <td className="px-4 py-2 text-right">{fmtNum(row.guest_unit)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-xs mt-2" style={{ color: 'var(--text-dim)' }}>
            ※ OCC（稼働率）は販売数集計表（確定販売室数）ベース。室泊・売上はPMS予約ベース（チェックイン月に計上＝freee計上基準）。客単価は人泊単価（売上÷人泊数）。
          </p>
        </>
      )}
    </div>
  )
}

function KpiCard({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="card p-4">
      <p className="text-xs mb-1" style={{ color: 'var(--text-dim)' }}>{label}</p>
      <p className="text-xl font-bold" style={{ color: accent ? 'var(--accent)' : 'var(--text)' }}>{value}</p>
    </div>
  )
}
