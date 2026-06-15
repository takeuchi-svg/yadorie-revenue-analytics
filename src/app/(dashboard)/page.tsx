'use client'

import { useEffect, useState } from 'react'
import { useFacility } from '@/lib/facility-context'
import { supabase } from '@/lib/supabase/client'

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

function fmt(n: number | null | undefined): string {
  if (n === null || n === undefined) return '-'
  return Math.round(n).toLocaleString()
}

function pct(n: number | null | undefined): string {
  if (n === null || n === undefined) return '-'
  return (n * 100).toFixed(1) + '%'
}

export default function OverviewPage() {
  const { current, currentFacility } = useFacility()
  const [kpi, setKpi] = useState<MonthlyKpi[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!current) return
    setLoading(true)
    supabase
      .from('mart_monthly_kpi')
      .select('*')
      .eq('facility', current)
      .order('month', { ascending: false })
      .limit(12)
      .then(({ data }) => {
        setKpi((data as MonthlyKpi[]) ?? [])
        setLoading(false)
      })
  }, [current])

  const latest = kpi[0]

  return (
    <div className="p-6">
      <h1 className="text-2xl font-bold text-gray-900 mb-1">Overview</h1>
      <p className="text-sm text-gray-500 mb-6">
        {currentFacility?.name ?? current}
      </p>

      {loading ? (
        <p className="text-gray-400">読み込み中...</p>
      ) : kpi.length === 0 ? (
        <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-6 text-center">
          <p className="text-yellow-700 font-medium">データ未登録</p>
          <p className="text-sm text-yellow-600 mt-1">
            /upload からCSVファイルをアップロードしてください
          </p>
        </div>
      ) : (
        <>
          {/* KPI Cards */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">
            <KpiCard label="売上" value={`¥${fmt(latest?.revenue)}`} />
            <KpiCard label="販売室数" value={fmt(latest?.rooms_sold)} />
            <KpiCard label="宿泊者数" value={fmt(latest?.guests)} />
            <KpiCard label="稼働率" value={pct(latest?.occ)} />
            <KpiCard label="ADR" value={`¥${fmt(latest?.adr)}`} />
            <KpiCard label="客単価" value={`¥${fmt(latest?.guest_unit)}`} />
            <KpiCard label="RevPAR" value={`¥${fmt(latest?.revpar)}`} />
            <KpiCard label="同伴数" value={latest?.companion?.toFixed(2) ?? '-'} />
          </div>

          {/* Monthly table */}
          <div className="bg-white rounded-lg shadow overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-gray-50 border-b text-left text-gray-600">
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
                  <tr key={row.month} className="border-b hover:bg-gray-50">
                    <td className="px-4 py-2 font-medium">{row.month}</td>
                    <td className="px-4 py-2 text-right">{fmt(row.revenue)}</td>
                    <td className="px-4 py-2 text-right text-gray-400">{fmt(row.revenue_budget)}</td>
                    <td className="px-4 py-2 text-right">{fmt(row.rooms_sold)}</td>
                    <td className="px-4 py-2 text-right">{fmt(row.guests)}</td>
                    <td className="px-4 py-2 text-right">{pct(row.occ)}</td>
                    <td className="px-4 py-2 text-right">{fmt(row.adr)}</td>
                    <td className="px-4 py-2 text-right">{fmt(row.guest_unit)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  )
}

function KpiCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-white rounded-lg shadow p-4">
      <p className="text-xs text-gray-500 mb-1">{label}</p>
      <p className="text-xl font-bold text-gray-900">{value}</p>
    </div>
  )
}
