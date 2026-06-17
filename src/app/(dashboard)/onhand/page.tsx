'use client'

import { useEffect, useState } from 'react'
import { useFacility } from '@/lib/facility-context'
import { supabase } from '@/lib/supabase/client'
import { fmtNum, pct } from '@/lib/ui'
import { PageHeader, Loading, Empty } from '@/components/page-bits'

interface OccMonth { month: string; rooms_sold: number | null; operating_days: number | null; total_rooms: number | null; occ: number | null }
interface OccDay { date: string; dow: string; rooms_sold: number | null; total_rooms: number | null; occ: number | null }

function occColor(occ: number | null): string {
  if (occ === null) return 'var(--surface2)'
  if (occ >= 0.8) return 'rgba(34,197,94,0.85)'   // green
  if (occ >= 0.5) return 'rgba(245,158,11,0.8)'   // amber
  return 'rgba(239,68,68,0.7)'                      // red
}

export default function OnhandPage() {
  const { current, currentFacility } = useFacility()
  const [monthly, setMonthly] = useState<OccMonth[]>([])
  const [daily, setDaily] = useState<OccDay[]>([])
  const [month, setMonth] = useState('')
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!current) return
    setLoading(true)
    Promise.all([
      supabase.from('mart_occupancy_monthly').select('*').eq('facility', current),
      supabase.from('mart_occupancy_daily').select('*').eq('facility', current).order('date'),
    ]).then(([mRes, dRes]) => {
      const m = (mRes.data as OccMonth[]) ?? []
      setMonthly(m)
      setDaily((dRes.data as OccDay[]) ?? [])
      const months = m.map((x) => x.month).sort().reverse()
      setMonth((cur) => cur || months[0] || '')
      setLoading(false)
    })
  }, [current])

  const months = monthly.map((m) => m.month).sort().reverse()
  const dayRows = daily.filter((d) => d.date.startsWith(month))

  return (
    <div className="p-6">
      <PageHeader title="On-hand" subtitle={currentFacility?.name ?? current} month={month} months={months} onMonth={setMonth} />
      {loading ? <Loading /> : monthly.length === 0 ? (
        <Empty message="販売数集計表（販売数集計表 CSV）を /upload からアップロードしてください" />
      ) : (
        <>
          {/* Monthly occupancy table */}
          <div className="card overflow-x-auto mb-6">
            <table className="w-full text-sm">
              <thead>
                <tr style={{ background: 'var(--surface2)', color: 'var(--text-dim)' }} className="text-left">
                  <th className="px-4 py-3">月</th>
                  <th className="px-4 py-3 text-right">販売室数</th>
                  <th className="px-4 py-3 text-right">営業日数</th>
                  <th className="px-4 py-3 text-right">総室数</th>
                  <th className="px-4 py-3 text-right">稼働率</th>
                </tr>
              </thead>
              <tbody>
                {[...monthly].sort((a, b) => b.month.localeCompare(a.month)).map((r) => (
                  <tr key={r.month} style={{ borderTop: '1px solid var(--border)' }}>
                    <td className="px-4 py-2 font-medium">{r.month}</td>
                    <td className="px-4 py-2 text-right">{fmtNum(r.rooms_sold)}</td>
                    <td className="px-4 py-2 text-right">{fmtNum(r.operating_days)}</td>
                    <td className="px-4 py-2 text-right">{fmtNum(r.total_rooms)}</td>
                    <td className="px-4 py-2 text-right font-semibold">{pct(r.occ)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Daily heatmap */}
          <div className="card p-4">
            <h2 className="text-sm font-semibold mb-3">日別稼働率カレンダー（{month}）</h2>
            {dayRows.length === 0 ? (
              <p className="text-sm py-8 text-center" style={{ color: 'var(--text-dim)' }}>この月のデータがありません</p>
            ) : (
              <div className="grid gap-1.5" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(64px, 1fr))' }}>
                {dayRows.map((d) => (
                  <div key={d.date} className="rounded-md px-2 py-2 text-center" style={{ background: occColor(d.occ) }}>
                    <div className="text-[10px] opacity-80">{d.date.slice(8)}日</div>
                    <div className="text-sm font-bold">{d.occ !== null ? `${Math.round(d.occ * 100)}%` : '-'}</div>
                    <div className="text-[10px] opacity-80">{fmtNum(d.rooms_sold)}室</div>
                  </div>
                ))}
              </div>
            )}
            <div className="flex gap-4 mt-4 text-xs" style={{ color: 'var(--text-dim)' }}>
              <Legend c="rgba(34,197,94,0.85)" t="80%以上" />
              <Legend c="rgba(245,158,11,0.8)" t="50-79%" />
              <Legend c="rgba(239,68,68,0.7)" t="50%未満" />
            </div>
          </div>
        </>
      )}
    </div>
  )
}

function Legend({ c, t }: { c: string; t: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <span className="inline-block w-3 h-3 rounded" style={{ background: c }} />{t}
    </span>
  )
}
