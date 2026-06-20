'use client'

import { useEffect, useState } from 'react'
import { useFacility } from '@/lib/facility-context'
import { supabase } from '@/lib/supabase/client'
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer,
  PieChart, Pie, Cell, Legend,
} from 'recharts'
import { fmtYen, pct, fmtNum, channelColor, CHART_AXIS, chartTooltip } from '@/lib/ui'
import { AssistantContent, SparkleIcon } from '@/components/ai-drawer'

interface MonthlyKpi {
  facility: string
  month: string
  revenue: number | null
  rooms_sold: number | null
  guests: number | null
  occ: number | null
  adr: number | null
  guest_unit: number | null
  revpar: number | null
  companion: number | null
  revenue_budget: number | null
  total_inventory: number | null
}

interface OccRow { month: string; occ: number | null; rooms_sold: number | null; operating_days: number | null; total_rooms: number | null }
interface ChannelRow { channel: string | null; revenue: number | null }

export default function OverviewPage() {
  const { current, currentFacility } = useFacility()
  const [kpi, setKpi] = useState<MonthlyKpi[]>([])
  const [occByMonth, setOccByMonth] = useState<Record<string, number | null>>({})
  const [capByMonth, setCapByMonth] = useState<Record<string, number | null>>({})
  const [budgetByMonth, setBudgetByMonth] = useState<Record<string, number | null>>({})
  const [aiSummary, setAiSummary] = useState('')
  const [aiLoading, setAiLoading] = useState(false)
  const [channels, setChannels] = useState<ChannelRow[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!current) return
    setLoading(true)
    Promise.all([
      supabase.from('mart_monthly_kpi').select('*').eq('facility', current)
        .order('month', { ascending: false }).limit(12),
      supabase.from('mart_occupancy_monthly').select('month, occ, rooms_sold, operating_days, total_rooms').eq('facility', current),
      supabase.from('mart_budget_revenue_monthly').select('month, revenue_budget').eq('facility', current),
    ]).then(([kpiRes, occRes, budRes]) => {
      const kpiData = (kpiRes.data as MonthlyKpi[]) ?? []
      setKpi(kpiData)
      const occMap: Record<string, number | null> = {}
      const capMap: Record<string, number | null> = {}
      ;((occRes.data as OccRow[]) ?? []).forEach((o) => {
        occMap[o.month] = o.occ
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

  // 概要のAIサマリ（当月実績の自動要約）
  useEffect(() => {
    const lm = kpi[0]?.month
    if (!current || !lm) return
    setAiLoading(true); setAiSummary('')
    fetch('/api/chat', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ facility: current, messages: [{ role: 'user', content: `${lm}の当施設の実績を、売上・稼働率・予算達成率・前年比などの観点から3〜4行で簡潔に要約してください。本文のみ（表やグラフは不要）。` }] }),
    }).then((r) => r.json()).then((d) => setAiSummary(d.reply || '')).catch(() => setAiSummary('')).finally(() => setAiLoading(false))
  }, [current, kpi])

  const latest = kpi[0]
  const latestOcc = latest ? occByMonth[latest.month] ?? null : null
  const latestCap = latest ? capByMonth[latest.month] ?? null : null
  // REVPAR = 売上 ÷ 利用可能室数（総室数×営業日数）。予算入力なしで自動算出。
  const latestRevpar = latest && latest.revenue && latestCap ? latest.revenue / latestCap : latest?.revpar ?? null
  const latestBudget = latest ? budgetByMonth[latest.month] ?? latest.revenue_budget ?? null : null
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
      <h1 className="text-2xl font-bold mb-1">Overview</h1>
      <p className="text-sm mb-6" style={{ color: 'var(--text-dim)' }}>
        {currentFacility?.name ?? current}{latest ? ` ・ ${latest.month}` : ''}
      </p>

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
          {/* KPI Cards (6, per UI spec) */}
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4 mb-6">
            <KpiCard label="売上" value={fmtYen(latest?.revenue)} />
            <KpiCard label="OCC（稼働率）" value={pct(latestOcc)} accent />
            <KpiCard label="REVPAR" value={fmtYen(latestRevpar)} />
            <KpiCard label="客単価" value={fmtYen(latest?.guest_unit)} />
            <KpiCard label="予算達成率" value={pct(budgetRate)} />
            <KpiCard label="同伴係数" value={latest?.companion?.toFixed(2) ?? '-'} />
          </div>

          {/* AI実績サマリ */}
          <div className="card p-4 mb-6" style={{ background: 'linear-gradient(135deg, var(--surface), var(--surface2))', borderColor: 'var(--accent)' }}>
            <div className="flex items-center gap-2 mb-2">
              <SparkleIcon size={16} />
              <h2 className="text-sm font-semibold">AI実績サマリ（{latest?.month}）</h2>
            </div>
            {aiLoading ? (
              <p className="text-sm" style={{ color: 'var(--text-dim)' }}>生成中...</p>
            ) : aiSummary ? (
              <AssistantContent content={aiSummary} />
            ) : (
              <p className="text-sm" style={{ color: 'var(--text-dim)' }}>AIサマリは未生成です（APIキー設定後に表示されます）。</p>
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
                  <th className="px-4 py-3 text-right">室数</th>
                  <th className="px-4 py-3 text-right">客数</th>
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
                    <td className="px-4 py-2 text-right" style={{ color: 'var(--text-dim)' }}>{fmtNum(row.revenue_budget)}</td>
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
            ※ OCC（稼働率）は販売数集計表（確定販売室数）ベース。室数・売上はPMS予約ベース。
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
