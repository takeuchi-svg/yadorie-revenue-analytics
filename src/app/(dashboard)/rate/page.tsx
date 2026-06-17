'use client'

import { useEffect, useState } from 'react'
import { useFacility } from '@/lib/facility-context'
import { supabase } from '@/lib/supabase/client'
import { PageHeader, Loading, Empty } from '@/components/page-bits'

interface RateRow {
  snapshot_date: string
  stay_date: string
  dow: string | null
  rate_rank: number | null
  remaining: number | null
}

function rankColor(rank: number | null): string {
  if (rank === null) return 'var(--surface2)'
  if (rank <= 25) return 'rgba(34,197,94,0.8)'
  if (rank <= 33) return 'rgba(245,158,11,0.8)'
  return 'rgba(239,68,68,0.75)'
}

export default function RatePage() {
  const { current, currentFacility } = useFacility()
  const [rows, setRows] = useState<RateRow[]>([])
  const [snapshot, setSnapshot] = useState('')
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!current) return
    setLoading(true)
    supabase.from('raw_rate_snapshot')
      .select('snapshot_date, stay_date, dow, rate_rank, remaining')
      .eq('facility', current).eq('scope', 'total')
      .order('stay_date').limit(10000)
      .then(({ data }) => {
        const r = (data as RateRow[]) ?? []
        setRows(r)
        const snaps = [...new Set(r.map((x) => x.snapshot_date))].sort().reverse()
        setSnapshot((s) => s || snaps[0] || '')
        setLoading(false)
      })
  }, [current])

  const snapshots = [...new Set(rows.map((r) => r.snapshot_date))].sort().reverse()
  const grid = rows.filter((r) => r.snapshot_date === snapshot)

  return (
    <div className="p-6">
      <div className="flex items-end justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold mb-1">Rate Control</h1>
          <p className="text-sm" style={{ color: 'var(--text-dim)' }}>{currentFacility?.name ?? current}</p>
        </div>
        {snapshots.length > 0 && (
          <div>
            <label className="block text-[10px] mb-1" style={{ color: 'var(--text-dim)' }}>スナップショット日</label>
            <select className="field px-3 py-1.5 text-sm" value={snapshot} onChange={(e) => setSnapshot(e.target.value)}>
              {snapshots.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>
        )}
      </div>

      {loading ? <Loading /> : rows.length === 0 ? (
        <Empty message="レート表（レートチェック表 xlsx）を /upload からアップロードしてください" />
      ) : (
        <>
          <div className="card p-4 mb-4">
            <h2 className="text-sm font-semibold mb-3">料金ランク × 残室（宿泊日別）</h2>
            <div className="grid gap-1.5" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(58px, 1fr))' }}>
              {grid.map((d) => (
                <div key={d.stay_date} className="rounded-md px-1.5 py-2 text-center" style={{ background: rankColor(d.rate_rank) }}>
                  <div className="text-[10px] opacity-80">{d.stay_date.slice(5)}</div>
                  <div className="text-sm font-bold">{d.rate_rank ?? '-'}</div>
                  <div className="text-[10px]" style={{ color: d.remaining !== null && d.remaining <= 2 ? '#fff' : undefined, fontWeight: d.remaining !== null && d.remaining <= 2 ? 700 : 400 }}>
                    残{d.remaining === -1 ? '止' : d.remaining ?? '-'}
                  </div>
                </div>
              ))}
            </div>
            <div className="flex gap-4 mt-4 text-xs" style={{ color: 'var(--text-dim)' }}>
              <Lg c="rgba(34,197,94,0.8)" t="ランク20-25" />
              <Lg c="rgba(245,158,11,0.8)" t="26-33" />
              <Lg c="rgba(239,68,68,0.75)" t="34+" />
            </div>
          </div>
        </>
      )}
    </div>
  )
}

function Lg({ c, t }: { c: string; t: string }) {
  return <span className="flex items-center gap-1.5"><span className="inline-block w-3 h-3 rounded" style={{ background: c }} />{t}</span>
}
