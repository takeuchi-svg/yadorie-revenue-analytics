'use client'

import { useEffect, useState } from 'react'
import { useFacility } from '@/lib/facility-context'
import { supabase } from '@/lib/supabase/client'
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer,
  PieChart, Pie, Cell, Legend,
} from 'recharts'
import { fmtYen, fmtNum, CHART_AXIS, chartTooltip, channelColor } from '@/lib/ui'
import { PageHeader, Kpi, Loading, Empty } from '@/components/page-bits'

interface FbRow { month: string; category: string | null; revenue: number | null; count: number | null }
interface PayRow { payment_method: string | null; amount: number | null }

export default function FbPage() {
  const { current, currentFacility } = useFacility()
  const [rows, setRows] = useState<FbRow[]>([])
  const [pay, setPay] = useState<PayRow[]>([])
  const [month, setMonth] = useState('')
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!current) return
    setLoading(true)
    supabase.from('mart_fb_category').select('*').eq('facility', current).then(({ data }) => {
      const r = (data as FbRow[]) ?? []
      setRows(r)
      const months = [...new Set(r.map((x) => x.month))].sort().reverse()
      setMonth((m) => m || months[0] || '')
      supabase.from('raw_payment').select('payment_method, amount').eq('facility', current).limit(5000)
        .then(({ data: p }) => { setPay((p as PayRow[]) ?? []); setLoading(false) })
    })
  }, [current])

  const months = [...new Set(rows.map((r) => r.month))].sort().reverse()
  const monthRows = rows.filter((r) => r.month === month)
  const totalRev = monthRows.reduce((s, r) => s + (r.revenue || 0), 0)
  const totalCount = monthRows.reduce((s, r) => s + (r.count || 0), 0)
  const avgUnit = totalCount > 0 ? totalRev / totalCount : null

  const catData = [...monthRows].sort((a, b) => (b.revenue || 0) - (a.revenue || 0))
    .map((r) => ({ name: r.category || 'その他', revenue: r.revenue || 0 }))

  const payMap: Record<string, number> = {}
  pay.forEach((p) => { const k = p.payment_method || '不明'; payMap[k] = (payMap[k] || 0) + (p.amount || 0) })
  const payData = Object.entries(payMap).filter(([, v]) => v > 0).map(([name, value]) => ({ name, value }))

  return (
    <div className="p-6">
      <PageHeader title="F&B / Upsell" subtitle={currentFacility?.name ?? current} month={month} months={months} onMonth={setMonth} />
      {loading ? <Loading /> : rows.length === 0 ? <Empty /> : (
        <>
          <div className="grid grid-cols-2 lg:grid-cols-3 gap-4 mb-6">
            <Kpi label="F&B総売上" value={fmtYen(totalRev)} accent />
            <Kpi label="提供数" value={fmtNum(totalCount)} />
            <Kpi label="平均単価" value={fmtYen(avgUnit)} />
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <div className="card p-4">
              <h2 className="text-sm font-semibold mb-3">カテゴリ別売上</h2>
              {catData.length === 0 ? <p className="text-sm py-12 text-center" style={{ color: 'var(--text-dim)' }}>データなし</p> : (
                <ResponsiveContainer width="100%" height={280}>
                  <BarChart data={catData} layout="vertical" margin={{ left: 20 }}>
                    <XAxis type="number" {...CHART_AXIS} tickFormatter={(v) => `${Math.round(v / 1000)}k`} />
                    <YAxis type="category" dataKey="name" {...CHART_AXIS} width={80} />
                    <Tooltip {...chartTooltip} formatter={(v) => fmtYen(Number(v))} />
                    <Bar dataKey="revenue" fill="var(--accent)" radius={[0, 4, 4, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              )}
            </div>

            <div className="card p-4">
              <h2 className="text-sm font-semibold mb-3">決済方法構成（全期間）</h2>
              {payData.length === 0 ? <p className="text-sm py-12 text-center" style={{ color: 'var(--text-dim)' }}>データなし</p> : (
                <ResponsiveContainer width="100%" height={280}>
                  <PieChart>
                    <Pie data={payData} dataKey="value" nameKey="name" innerRadius={55} outerRadius={95}>
                      {payData.map((d, i) => <Cell key={d.name} fill={channelColor(d.name, i)} />)}
                    </Pie>
                    <Tooltip {...chartTooltip} formatter={(v) => fmtYen(Number(v))} />
                    <Legend wrapperStyle={{ fontSize: 11 }} />
                  </PieChart>
                </ResponsiveContainer>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  )
}
