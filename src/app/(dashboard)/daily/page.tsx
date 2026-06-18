'use client'

import { useEffect, useMemo, useState } from 'react'
import { useFacility } from '@/lib/facility-context'
import { supabase } from '@/lib/supabase/client'
import { fmtNum, pct } from '@/lib/ui'
import { Loading, Empty } from '@/components/page-bits'

const DOW = ['日', '月', '火', '水', '木', '金', '土']

function addDays(dateStr: string, k: number): string {
  const d = new Date(dateStr + 'T00:00:00Z')
  d.setUTCDate(d.getUTCDate() + k)
  return d.toISOString().slice(0, 10)
}
function enumerateDates(from: string, to: string): string[] {
  const out: string[] = []
  let d = from
  let guard = 0
  while (d <= to && guard < 800) { out.push(d); d = addDays(d, 1); guard++ }
  return out
}
function lastDayOfMonth(ym: string): string {
  const [y, m] = ym.split('-').map(Number)
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate()
  return `${ym}-${String(last).padStart(2, '0')}`
}
function dowOf(dateStr: string): number {
  return new Date(dateStr + 'T00:00:00Z').getUTCDay()
}
function mmdd(dateStr: string): string {
  const [, m, d] = dateStr.split('-')
  return `${+m}/${+d}`
}
function rankColor(rank: number | null): string {
  if (rank === null || rank === undefined) return 'transparent'
  if (rank <= 25) return 'rgba(34,197,94,0.8)'
  if (rank <= 33) return 'rgba(245,158,11,0.8)'
  return 'rgba(239,68,68,0.78)'
}

interface RoomSale { stay_date: string; sold: number | null }
interface Res { checkin: string; nights: number | null; revenue_settled: number | null; guests_total: number | null }
interface RateRow { snapshot_date: string; stay_date: string; rate_rank: number | null }

export default function DailyPage() {
  const { current, currentFacility } = useFacility()
  const totalRooms = currentFacility?.total_rooms ?? 0

  const [allSales, setAllSales] = useState<RoomSale[]>([])
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [res, setRes] = useState<Res[]>([])
  const [rates, setRates] = useState<RateRow[]>([])
  const [loadingRange, setLoadingRange] = useState(true)
  const [loading, setLoading] = useState(false)

  // 1) 販売室数の全期間 → 既定範囲（最新月）を決定
  useEffect(() => {
    if (!current) return
    setLoadingRange(true)
    supabase.from('mart_occupancy_daily').select('date, rooms_sold').eq('facility', current).order('date')
      .then(({ data }) => {
        const rows = ((data as any[]) ?? []).map((r) => ({ stay_date: r.date, sold: r.rooms_sold }))
        setAllSales(rows)
        if (rows.length > 0) {
          const months = [...new Set(rows.map((r) => r.stay_date.slice(0, 7)))].sort()
          const latest = months[months.length - 1]
          setFrom(`${latest}-01`)
          setTo(lastDayOfMonth(latest))
        }
        setLoadingRange(false)
      })
  }, [current])

  // 2) 範囲確定後に 予約（按分用）と レートランク を取得
  useEffect(() => {
    if (!current || !from || !to) return
    setLoading(true)
    Promise.all([
      supabase.from('raw_reservation').select('checkin, nights, revenue_settled, guests_total')
        .eq('facility', current).eq('status', 'C/O')
        .gte('checkin', addDays(from, -40)).lte('checkin', to).limit(20000),
      supabase.from('raw_rate_snapshot').select('snapshot_date, stay_date, rate_rank')
        .eq('facility', current).eq('scope', 'total')
        .gte('stay_date', from).lte('stay_date', to).limit(20000),
    ]).then(([r, rt]) => {
      setRes((r.data as Res[]) ?? [])
      setRates((rt.data as RateRow[]) ?? [])
      setLoading(false)
    })
  }, [current, from, to])

  const model = useMemo(() => {
    if (!from || !to || from > to) return null
    const dates = enumerateDates(from, to)

    // 販売室数（正データ）
    const soldMap: Record<string, number> = {}
    for (const s of allSales) if (s.stay_date >= from && s.stay_date <= to) soldMap[s.stay_date] = s.sold ?? 0

    // 売上・人数を宿泊日ごとに按分
    const revMap: Record<string, number> = {}
    const guestMap: Record<string, number> = {}
    for (const r of res) {
      const nights = Math.max(r.nights ?? 1, 1)
      const perNightRev = (r.revenue_settled ?? 0) / nights
      for (let k = 0; k < nights; k++) {
        const d = addDays(r.checkin, k)
        if (d < from || d > to) continue
        revMap[d] = (revMap[d] ?? 0) + perNightRev
        guestMap[d] = (guestMap[d] ?? 0) + (r.guests_total ?? 0)
      }
    }

    // レートランク: stay_date → {snapshot_date → rank}
    const snapSet = new Set<string>()
    const rankMap: Record<string, Record<string, number | null>> = {}
    for (const rt of rates) {
      snapSet.add(rt.snapshot_date)
      ;(rankMap[rt.stay_date] ??= {})[rt.snapshot_date] = rt.rate_rank
    }
    const snapshots = [...snapSet].sort()

    const rows = dates.map((d) => {
      const sold = soldMap[d] ?? 0
      const revenue = Math.round(revMap[d] ?? 0)
      const guests = guestMap[d] ?? 0
      return {
        date: d,
        sold,
        revenue,
        guests,
        guestUnit: guests > 0 ? Math.round(revenue / guests) : null,
        occ: totalRooms > 0 ? sold / totalRooms : null,
        adr: sold > 0 ? Math.round(revenue / sold) : null,
        companion: sold > 0 ? guests / sold : null,
        revpar: totalRooms > 0 ? Math.round(revenue / totalRooms) : null,
        ranks: rankMap[d] ?? {},
      }
    })

    // 合計
    const sumSold = rows.reduce((s, r) => s + r.sold, 0)
    const sumRev = rows.reduce((s, r) => s + r.revenue, 0)
    const sumGuests = rows.reduce((s, r) => s + r.guests, 0)
    const days = rows.length
    const cap = totalRooms * days
    const total = {
      sold: sumSold, revenue: sumRev, guests: sumGuests,
      guestUnit: sumGuests > 0 ? Math.round(sumRev / sumGuests) : null,
      occ: cap > 0 ? sumSold / cap : null,
      adr: sumSold > 0 ? Math.round(sumRev / sumSold) : null,
      companion: sumSold > 0 ? sumGuests / sumSold : null,
      revpar: cap > 0 ? Math.round(sumRev / cap) : null,
    }
    return { rows, snapshots, total }
  }, [from, to, allSales, res, rates, totalRooms])

  const HROW = 'h-9'
  const HHEAD = 'h-11'

  return (
    <div className="p-6">
      <div className="flex items-end justify-between mb-4 flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold mb-1">日別売上</h1>
          <p className="text-sm" style={{ color: 'var(--text-dim)' }}>{currentFacility?.name ?? current}</p>
        </div>
        <div className="flex items-center gap-2">
          <input type="date" className="field px-3 py-1.5 text-sm" value={from} onChange={(e) => setFrom(e.target.value)} />
          <span style={{ color: 'var(--text-dim)' }}>〜</span>
          <input type="date" className="field px-3 py-1.5 text-sm" value={to} onChange={(e) => setTo(e.target.value)} />
        </div>
      </div>
      <p className="text-xs mb-4" style={{ color: 'var(--text-dim)' }}>
        販売室数〜RevPAR はPMS（販売室数=販売数集計表、売上・人数=予約情報を宿泊日按分）。スタート以降は在庫レート表の料金ランク推移。
      </p>

      {loadingRange ? <Loading /> : allSales.length === 0 ? (
        <Empty message="販売数集計表を /upload からアップロードしてください" />
      ) : !model || model.rows.length === 0 ? (
        <p style={{ color: 'var(--text-dim)' }}>範囲を選択してください</p>
      ) : (
        <div className="card overflow-hidden">
          <div className="flex">
            {/* 左：固定ブロック */}
            <table className="text-sm shrink-0" style={{ borderRight: '2px solid var(--border)' }}>
              <thead>
                <tr style={{ background: 'var(--surface2)', color: 'var(--text-dim)' }} className="text-left">
                  <th className={`px-3 ${HHEAD} whitespace-nowrap`}>日付</th>
                  <th className={`px-3 ${HHEAD} text-right`}>販売室数</th>
                  <th className={`px-3 ${HHEAD} text-right`}>売上</th>
                  <th className={`px-3 ${HHEAD} text-right`}>人数</th>
                  <th className={`px-3 ${HHEAD} text-right`}>客単価</th>
                  <th className={`px-3 ${HHEAD} text-right`}>稼働率</th>
                  <th className={`px-3 ${HHEAD} text-right`}>ADR</th>
                  <th className={`px-3 ${HHEAD} text-right`}>同伴係数</th>
                  <th className={`px-3 ${HHEAD} text-right`}>RevPAR</th>
                </tr>
              </thead>
              <tbody>
                {model.rows.map((r) => {
                  const dw = dowOf(r.date)
                  const dcolor = dw === 0 ? 'var(--red)' : dw === 6 ? '#378ADD' : 'var(--text)'
                  return (
                    <tr key={r.date} style={{ borderTop: '1px solid var(--border)' }}>
                      <td className={`px-3 ${HROW} whitespace-nowrap font-medium`} style={{ color: dcolor }}>
                        {mmdd(r.date)}({DOW[dw]})
                      </td>
                      <td className={`px-3 ${HROW} text-right`}>{fmtNum(r.sold)}</td>
                      <td className={`px-3 ${HROW} text-right`}>{fmtNum(r.revenue)}</td>
                      <td className={`px-3 ${HROW} text-right`}>{fmtNum(r.guests)}</td>
                      <td className={`px-3 ${HROW} text-right`}>{fmtNum(r.guestUnit)}</td>
                      <td className={`px-3 ${HROW} text-right`}>{pct(r.occ)}</td>
                      <td className={`px-3 ${HROW} text-right`}>{fmtNum(r.adr)}</td>
                      <td className={`px-3 ${HROW} text-right`}>{r.companion?.toFixed(2) ?? '-'}</td>
                      <td className={`px-3 ${HROW} text-right`}>{fmtNum(r.revpar)}</td>
                    </tr>
                  )
                })}
                {/* 合計 */}
                <tr style={{ borderTop: '2px solid var(--border)', background: 'var(--surface2)' }} className="font-semibold">
                  <td className={`px-3 ${HHEAD} whitespace-nowrap`}>合計/平均</td>
                  <td className={`px-3 ${HHEAD} text-right`}>{fmtNum(model.total.sold)}</td>
                  <td className={`px-3 ${HHEAD} text-right`}>{fmtNum(model.total.revenue)}</td>
                  <td className={`px-3 ${HHEAD} text-right`}>{fmtNum(model.total.guests)}</td>
                  <td className={`px-3 ${HHEAD} text-right`}>{fmtNum(model.total.guestUnit)}</td>
                  <td className={`px-3 ${HHEAD} text-right`}>{pct(model.total.occ)}</td>
                  <td className={`px-3 ${HHEAD} text-right`}>{fmtNum(model.total.adr)}</td>
                  <td className={`px-3 ${HHEAD} text-right`}>{model.total.companion?.toFixed(2) ?? '-'}</td>
                  <td className={`px-3 ${HHEAD} text-right`}>{fmtNum(model.total.revpar)}</td>
                </tr>
              </tbody>
            </table>

            {/* 右：レートランク（横スクロール）*/}
            <div className="overflow-x-auto flex-1">
              {model.snapshots.length === 0 ? (
                <div className={`px-4 ${HHEAD} flex items-center text-xs`} style={{ color: 'var(--text-dim)' }}>
                  この範囲の在庫レート表データがありません
                </div>
              ) : (
                <table className="text-sm">
                  <thead>
                    <tr style={{ background: 'var(--surface2)', color: 'var(--text-dim)' }} className="text-center">
                      {model.snapshots.map((s, i) => (
                        <th key={s} className={`px-2 ${HHEAD} whitespace-nowrap`} style={{ minWidth: 56 }}>
                          {i === 0 ? 'スタート' : mmdd(s)}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {model.rows.map((r) => (
                      <tr key={r.date} style={{ borderTop: '1px solid var(--border)' }}>
                        {model.snapshots.map((s) => {
                          const rank = r.ranks[s] ?? null
                          return (
                            <td key={s} className={`px-2 ${HROW} text-center`} style={{ background: rankColor(rank), minWidth: 56 }}>
                              {rank ?? ''}
                            </td>
                          )
                        })}
                      </tr>
                    ))}
                    <tr style={{ borderTop: '2px solid var(--border)', background: 'var(--surface2)' }}>
                      {model.snapshots.map((s) => <td key={s} className={`px-2 ${HHEAD}`} />)}
                    </tr>
                  </tbody>
                </table>
              )}
            </div>
          </div>
        </div>
      )}

      {loading && <p className="text-xs mt-2" style={{ color: 'var(--text-dim)' }}>読み込み中...</p>}

      {/* 凡例 */}
      <div className="flex gap-4 mt-4 text-xs" style={{ color: 'var(--text-dim)' }}>
        <span className="flex items-center gap-1.5"><span className="inline-block w-3 h-3 rounded" style={{ background: 'rgba(34,197,94,0.8)' }} />ランク20-25</span>
        <span className="flex items-center gap-1.5"><span className="inline-block w-3 h-3 rounded" style={{ background: 'rgba(245,158,11,0.8)' }} />26-33</span>
        <span className="flex items-center gap-1.5"><span className="inline-block w-3 h-3 rounded" style={{ background: 'rgba(239,68,68,0.78)' }} />34+</span>
      </div>
    </div>
  )
}
