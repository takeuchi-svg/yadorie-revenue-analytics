'use client'

import { useEffect, useMemo, useState } from 'react'
import { useFacility } from '@/lib/facility-context'
import { supabase } from '@/lib/supabase/client'
import { fetchAll } from '@/lib/supabase/fetch-all'
import { useFacilityData } from '@/lib/use-facility-data'
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer,
  PieChart, Pie, Cell, Legend,
} from 'recharts'
import { fmtYen, fmtNum, pct, CHART_AXIS, chartTooltip, channelColor } from '@/lib/ui'
import { PageHeader, Kpi, Loading, Empty, LoadError } from '@/components/page-bits'
import type { OtherProductRow as OP, PaymentRow as Pay } from '@/lib/db-types'

export default function FbPage() {
  const { current, currentFacility } = useFacility()
  const [month, setMonth] = useState('')

  const { data, loading, error: loadError } = useFacilityData<{ op: OP[]; pay: Pay[] }>(async (facility) => {
    const [o, p] = await Promise.all([
      fetchAll<OP>(() => supabase.from('raw_other_product').select('item_name, category, total, quantity, source_month, status').eq('facility', facility).order('id')),
      fetchAll<Pay>(() => supabase.from('raw_payment').select('payment_method, amount, source_month').eq('facility', facility).order('id')),
    ])
    return { op: o, pay: p }
  })
  const op = useMemo(() => data?.op ?? [], [data])
  const pay = useMemo(() => data?.pay ?? [], [data])

  const months = useMemo(() => [...new Set(op.map((r) => r.source_month).filter(Boolean))].sort().reverse() as string[], [op])
  useEffect(() => { if (months.length && !months.includes(month)) setMonth(months[0]) }, [months, month])

  const rows = useMemo(() => op.filter((r) => r.source_month === month && (r.status == null || r.status === 'C/O')), [op, month])
  const total = rows.reduce((s, r) => s + (r.total || 0), 0)
  const qty = rows.reduce((s, r) => s + (r.quantity || 0), 0)

  const byCat = useMemo(() => {
    const m = new Map<string, number>()
    rows.forEach((r) => { const k = r.category || 'その他'; m.set(k, (m.get(k) || 0) + (r.total || 0)) })
    return [...m.entries()].map(([name, total]) => ({ name, total })).sort((a, b) => b.total - a.total)
  }, [rows])

  const topItems = useMemo(() => {
    const m = new Map<string, { total: number; qty: number }>()
    rows.forEach((r) => { const k = r.item_name || '(不明)'; const g = m.get(k) ?? { total: 0, qty: 0 }; g.total += r.total || 0; g.qty += r.quantity || 0; m.set(k, g) })
    return [...m.entries()].map(([name, v]) => ({ name, ...v })).sort((a, b) => b.total - a.total).slice(0, 15)
  }, [rows])

  const payData = useMemo(() => {
    const m = new Map<string, number>()
    pay.filter((p) => p.source_month === month).forEach((p) => { const k = p.payment_method || '不明'; m.set(k, (m.get(k) || 0) + (p.amount || 0)) })
    return [...m.entries()].filter(([, v]) => v > 0).map(([name, value]) => ({ name, value })).sort((a, b) => b.value - a.value)
  }, [pay, month])

  return (
    <div className="p-6">
      <PageHeader title="料飲分析" subtitle={currentFacility?.name ?? current} month={month} months={months} onMonth={setMonth} />
      {loading ? <Loading /> : loadError ? <LoadError message={loadError} /> : op.length === 0 ? (
        <Empty message="その他商品情報を /upload からアップロードしてください" />
      ) : (
        <>
          <div className="grid grid-cols-2 lg:grid-cols-3 gap-4 mb-6">
            <Kpi label="料飲・物販売上" value={fmtYen(total)} accent />
            <Kpi label="提供点数" value={fmtNum(qty)} />
            <Kpi label="平均単価" value={fmtYen(qty > 0 ? total / qty : null)} />
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-4">
            <div className="card p-4">
              <h2 className="text-sm font-semibold mb-3">カテゴリ別売上</h2>
              {byCat.length === 0 ? <p className="text-sm py-12 text-center" style={{ color: 'var(--text-dim)' }}>データなし</p> : (
                <ResponsiveContainer width="100%" height={280}>
                  <BarChart data={byCat} layout="vertical" margin={{ left: 20 }}>
                    <XAxis type="number" {...CHART_AXIS} tickFormatter={(v) => `${Math.round(v / 1000)}k`} />
                    <YAxis type="category" dataKey="name" {...CHART_AXIS} width={80} />
                    <Tooltip {...chartTooltip} formatter={(v) => fmtYen(Number(v))} />
                    <Bar dataKey="total" fill="var(--accent)" radius={[0, 4, 4, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              )}
            </div>
            <div className="card p-4">
              <h2 className="text-sm font-semibold mb-3">決済方法構成</h2>
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

          {/* 売れ筋 TOP15 */}
          <div className="card overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr style={{ background: 'var(--surface2)', color: 'var(--text-dim)' }} className="text-left">
                  <th className="px-4 py-3">売れ筋 TOP15（{month}）</th>
                  <th className="px-4 py-3">カテゴリ</th>
                  <th className="px-4 py-3 text-right">数量</th>
                  <th className="px-4 py-3 text-right">売上</th>
                  <th className="px-4 py-3 text-right">構成比</th>
                </tr>
              </thead>
              <tbody>
                {topItems.map((it, i) => {
                  const cat = rows.find((r) => (r.item_name || '(不明)') === it.name)?.category || 'その他'
                  return (
                    <tr key={i} style={{ borderTop: '1px solid var(--border)' }}>
                      <td className="px-4 py-2 font-medium">{i + 1}. {it.name}</td>
                      <td className="px-4 py-2" style={{ color: 'var(--text-dim)' }}>{cat}</td>
                      <td className="px-4 py-2 text-right">{fmtNum(it.qty)}</td>
                      <td className="px-4 py-2 text-right">{fmtNum(it.total)}</td>
                      <td className="px-4 py-2 text-right" style={{ color: 'var(--text-dim)' }}>{total > 0 ? pct(it.total / total) : '-'}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  )
}
