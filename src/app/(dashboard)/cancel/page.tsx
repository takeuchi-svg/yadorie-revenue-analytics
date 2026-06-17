'use client'

import { useEffect, useState } from 'react'
import { useFacility } from '@/lib/facility-context'
import { supabase } from '@/lib/supabase/client'
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts'
import { fmtNum, fmtYen, pct, CHART_AXIS, chartTooltip } from '@/lib/ui'

interface CxlRow { month: string; channel: string | null; bookings: number; cancels: number; cancel_revenue: number | null; cxl_rate: number | null }
interface LtRow { month: string; bucket: string; count: number }

const LT_ORDER = ['当日','1-3日前','4-6日前','7-13日前','14-20日前','21-27日前','28-55日前','56-83日前','84-111日前','112日以上前']

export default function CancelPage() {
  const { current, currentFacility } = useFacility()
  const [rows, setRows] = useState<CxlRow[]>([])
  const [lt, setLt] = useState<LtRow[]>([])
  const [month, setMonth] = useState<string>('')
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!current) return
    setLoading(true)
    Promise.all([
      supabase.from('mart_cxl_summary').select('*').eq('facility', current),
      supabase.from('mart_cxl_lt').select('*').eq('facility', current),
    ]).then(([sRes, ltRes]) => {
      const s = (sRes.data as CxlRow[]) ?? []
      setRows(s)
      setLt((ltRes.data as LtRow[]) ?? [])
      const months = [...new Set(s.map((r) => r.month))].sort().reverse()
      setMonth((m) => m || months[0] || '')
      setLoading(false)
    })
  }, [current])

  const months = [...new Set(rows.map((r) => r.month))].sort().reverse()
  const monthRows = rows.filter((r) => r.month === month)
  const bookings = monthRows.reduce((s, r) => s + (r.bookings || 0), 0)
  const cancels = monthRows.reduce((s, r) => s + (r.cancels || 0), 0)
  const cancelRev = monthRows.reduce((s, r) => s + (r.cancel_revenue || 0), 0)
  const cxlRate = bookings + cancels > 0 ? cancels / (bookings + cancels) : null
  const netBookings = bookings - cancels

  const ltData = LT_ORDER.map((b) => ({
    bucket: b,
    count: lt.filter((r) => r.month === month && r.bucket === b).reduce((s, r) => s + r.count, 0),
  }))

  return (
    <div className="p-6">
      <Header title="Cancel" subtitle={currentFacility?.name ?? current} month={month} months={months} onMonth={setMonth} />
      {loading ? <Loading /> : rows.length === 0 ? <Empty /> : (
        <>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
            <Kpi label="CXL率" value={pct(cxlRate)} accent />
            <Kpi label="取消件数" value={fmtNum(cancels)} />
            <Kpi label="取消金額" value={fmtYen(cancelRev)} />
            <Kpi label="ネット予約" value={fmtNum(netBookings)} />
          </div>

          <div className="card p-4 mb-6">
            <h2 className="text-sm font-semibold mb-3">キャンセル リードタイム分布</h2>
            <ResponsiveContainer width="100%" height={260}>
              <BarChart data={ltData}>
                <XAxis dataKey="bucket" {...CHART_AXIS} interval={0} angle={-30} textAnchor="end" height={70} />
                <YAxis {...CHART_AXIS} allowDecimals={false} />
                <Tooltip {...chartTooltip} />
                <Bar dataKey="count" fill="var(--red)" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>

          <div className="card overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr style={{ background: 'var(--surface2)', color: 'var(--text-dim)' }} className="text-left">
                  <th className="px-4 py-3">チャネル</th>
                  <th className="px-4 py-3 text-right">予約</th>
                  <th className="px-4 py-3 text-right">取消</th>
                  <th className="px-4 py-3 text-right">取消金額</th>
                  <th className="px-4 py-3 text-right">CXL率</th>
                </tr>
              </thead>
              <tbody>
                {monthRows.sort((a, b) => (b.cancels || 0) - (a.cancels || 0)).map((r) => (
                  <tr key={r.channel} style={{ borderTop: '1px solid var(--border)' }}>
                    <td className="px-4 py-2">{r.channel || '不明'}</td>
                    <td className="px-4 py-2 text-right">{fmtNum(r.bookings)}</td>
                    <td className="px-4 py-2 text-right">{fmtNum(r.cancels)}</td>
                    <td className="px-4 py-2 text-right">{fmtNum(r.cancel_revenue)}</td>
                    <td className="px-4 py-2 text-right">{pct(r.cxl_rate)}</td>
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

/* shared small components */
function Header({ title, subtitle, month, months, onMonth }: { title: string; subtitle: string; month: string; months: string[]; onMonth: (m: string) => void }) {
  return (
    <div className="flex items-end justify-between mb-6">
      <div>
        <h1 className="text-2xl font-bold mb-1">{title}</h1>
        <p className="text-sm" style={{ color: 'var(--text-dim)' }}>{subtitle}</p>
      </div>
      {months.length > 0 && (
        <select className="field px-3 py-1.5 text-sm" value={month} onChange={(e) => onMonth(e.target.value)}>
          {months.map((m) => <option key={m} value={m}>{m}</option>)}
        </select>
      )}
    </div>
  )
}
function Kpi({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="card p-4">
      <p className="text-xs mb-1" style={{ color: 'var(--text-dim)' }}>{label}</p>
      <p className="text-xl font-bold" style={{ color: accent ? 'var(--accent)' : 'var(--text)' }}>{value}</p>
    </div>
  )
}
function Loading() { return <p style={{ color: 'var(--text-dim)' }}>読み込み中...</p> }
function Empty() {
  return (
    <div className="card p-6 text-center" style={{ borderColor: 'var(--yellow)' }}>
      <p className="font-medium" style={{ color: 'var(--yellow)' }}>データ未登録</p>
      <p className="text-sm mt-1" style={{ color: 'var(--text-dim)' }}>/upload からファイルをアップロードしてください</p>
    </div>
  )
}
