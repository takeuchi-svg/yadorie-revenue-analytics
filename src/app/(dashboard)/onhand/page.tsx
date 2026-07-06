'use client'

// オンハンド（予約の積み上がり）— ステイシー予約情報ベース。将来月の埋まり具合を予算と対比。
// ブッキングペースの時系列（as-of別）は別途スナップショット保存で対応予定（現状は最新スナップショット）。
import { useEffect, useMemo, useState } from 'react'
import { useFacility } from '@/lib/facility-context'
import { supabase } from '@/lib/supabase/client'
import { fetchAll } from '@/lib/supabase/fetch-all'
import {
  ComposedChart, Bar, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, Legend, CartesianGrid,
} from 'recharts'
import { fmtNum, fmtYen, pct, CHART_AXIS, chartTooltip } from '@/lib/ui'
import { Loading, Empty, LoadError } from '@/components/page-bits'

interface OnhandRow {
  month: string
  room_nights: number | null
  room_nights_stayed: number | null
  room_nights_confirmed: number | null
  room_nights_tentative: number | null
  guest_nights: number | null
  revenue: number | null
  adr: number | null
}
interface BudgetRow { month: string; rooms_budget: number | null; revenue_budget: number | null; inventory_budget: number | null }

const thisMonth = () => {
  const n = new Date()
  return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, '0')}`
}
const daysInMonth = (ym: string) => new Date(Number(ym.slice(0, 4)), Number(ym.slice(5, 7)), 0).getDate()

export default function OnhandPage() {
  const { current, currentFacility } = useFacility()
  const [onhand, setOnhand] = useState<OnhandRow[]>([])
  const [budget, setBudget] = useState<BudgetRow[]>([])
  const [roomsOverride, setRoomsOverride] = useState<Record<string, number>>({})
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')

  const totalRooms = currentFacility?.total_rooms ?? null

  useEffect(() => {
    if (!current) return
    setLoading(true); setLoadError('')
    Promise.all([
      fetchAll<OnhandRow>(() => supabase.from('mart_onhand_monthly').select('*').eq('facility', current)),
      fetchAll<BudgetRow>(() => supabase.from('mart_budget_daily_monthly').select('*').eq('facility', current)),
      supabase.from('dim_operating_days').select('month, rooms').eq('facility', current).then((r) => r),
    ]).then(([oh, bg, od]: any[]) => {
      setOnhand((oh as OnhandRow[]) ?? [])
      setBudget((bg as BudgetRow[]) ?? [])
      const rm: Record<string, number> = {}
      ;((od?.data as { month: string; rooms: number | null }[]) ?? []).forEach((r) => { if (r.rooms != null) rm[r.month] = r.rooms })
      setRoomsOverride(rm)
    }).catch((e: unknown) => setLoadError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false))
  }, [current])

  const cm = thisMonth()
  const budgetMap = useMemo(() => { const m: Record<string, BudgetRow> = {}; budget.forEach((b) => { m[b.month] = b }); return m }, [budget])

  // 当月以降のみ（オンハンド＝これからの予約の入り具合）
  const rows = useMemo(() => {
    const list = onhand.filter((r) => r.month >= cm).sort((a, b) => a.month.localeCompare(b.month))
    return list.map((r) => {
      const b = budgetMap[r.month]
      const rooms = totalRooms != null ? (roomsOverride[r.month] ?? totalRooms) : null
      const inventory = b?.inventory_budget != null && b.inventory_budget > 0
        ? b.inventory_budget
        : (rooms != null ? rooms * daysInMonth(r.month) : null)
      const oh = r.room_nights ?? 0
      const rev = r.revenue ?? 0
      return {
        month: r.month,
        onhand: oh,
        stayed: r.room_nights_stayed ?? 0,
        confirmed: r.room_nights_confirmed ?? 0,
        tentative: r.room_nights_tentative ?? 0,
        revenue: rev,
        adr: r.adr ?? null,
        roomsBudget: b?.rooms_budget ?? null,
        revenueBudget: b?.revenue_budget ?? null,
        inventory,
        roomsPickup: b?.rooms_budget ? oh / b.rooms_budget : null,       // 予算室泊に対する現在の埋まり
        revenuePickup: b?.revenue_budget ? rev / b.revenue_budget : null,
        fill: inventory ? oh / inventory : null,                          // 在庫に対するオンハンド稼働率
      }
    })
  }, [onhand, budgetMap, roomsOverride, totalRooms, cm])

  // 今後合計（サマリ）
  const totals = useMemo(() => {
    const oh = rows.reduce((s, r) => s + r.onhand, 0)
    const rev = rows.reduce((s, r) => s + r.revenue, 0)
    const rb = rows.reduce((s, r) => s + (r.roomsBudget ?? 0), 0)
    const vb = rows.reduce((s, r) => s + (r.revenueBudget ?? 0), 0)
    return { oh, rev, roomsPickup: rb > 0 ? oh / rb : null, revenuePickup: vb > 0 ? rev / vb : null }
  }, [rows])

  const chart = rows.map((r) => ({
    month: r.month.slice(2),
    オンハンド室泊: r.onhand,
    予算室泊: r.roomsBudget ?? 0,
    埋まり率: r.fill != null ? Math.round(r.fill * 1000) / 10 : null,
  }))

  return (
    <div className="p-6">
      <div className="mb-4">
        <h1 className="text-2xl font-bold mb-1">予約状況（オンハンド）</h1>
        <p className="text-sm" style={{ color: 'var(--text-dim)' }}>
          {currentFacility?.name ?? current}・{cm} 以降の予約の入り具合（ステイシー予約情報の最新スナップショット）
        </p>
      </div>

      {loading ? <Loading /> : loadError ? <LoadError message={loadError} /> : rows.length === 0 ? (
        <Empty message="将来月の予約情報CSV（未チェックイン分）を /upload からアップロードしてください" />
      ) : (
        <>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
            <Kpi label="今後 オンハンド室泊" value={fmtNum(totals.oh)} accent />
            <Kpi label="今後 オンハンド売上" value={fmtYen(totals.rev)} />
            <Kpi label="対予算 室泊（ピックアップ）" value={pct(totals.roomsPickup)} />
            <Kpi label="対予算 売上（ピックアップ）" value={pct(totals.revenuePickup)} />
          </div>

          <div className="card p-4 mb-6">
            <h2 className="text-sm font-semibold mb-1">月別 オンハンド室泊 vs 予算室泊</h2>
            <p className="text-xs mb-3" style={{ color: 'var(--text-dim)' }}>棒＝オンハンド(青)・予算(灰)、折れ線＝在庫に対する埋まり率。</p>
            <ResponsiveContainer width="100%" height={300}>
              <ComposedChart data={chart} margin={{ top: 5, right: 10, bottom: 5, left: 0 }}>
                <CartesianGrid stroke="#e7dac6" vertical={false} />
                <XAxis dataKey="month" {...CHART_AXIS} />
                <YAxis yAxisId="l" {...CHART_AXIS} allowDecimals={false} />
                <YAxis yAxisId="r" orientation="right" {...CHART_AXIS} tickFormatter={(v) => `${v}%`} />
                <Tooltip {...chartTooltip} formatter={(v: any, n: any) => (n === '埋まり率' ? `${v}%` : fmtNum(Number(v)))} />
                <Legend wrapperStyle={{ fontSize: 11 }} />
                <Bar yAxisId="l" dataKey="オンハンド室泊" fill="#378ADD" />
                <Bar yAxisId="l" dataKey="予算室泊" fill="#c7b8a3" />
                <Line yAxisId="r" dataKey="埋まり率" stroke="#C0392B" strokeWidth={2} dot={{ r: 2 }} />
              </ComposedChart>
            </ResponsiveContainer>
          </div>

          <div className="card overflow-x-auto">
            <table className="w-full text-sm whitespace-nowrap">
              <thead>
                <tr style={{ background: 'var(--surface2)', color: 'var(--text-dim)' }} className="text-left">
                  <th className="px-3 py-3">月</th>
                  <th className="px-3 py-3 text-right">オンハンド室泊</th>
                  <th className="px-3 py-3 text-right">内訳(実績/確定/未確認)</th>
                  <th className="px-3 py-3 text-right">予算室泊</th>
                  <th className="px-3 py-3 text-right">対予算</th>
                  <th className="px-3 py-3 text-right">在庫</th>
                  <th className="px-3 py-3 text-right">埋まり率</th>
                  <th className="px-3 py-3 text-right">オンハンド売上</th>
                  <th className="px-3 py-3 text-right">予算売上</th>
                  <th className="px-3 py-3 text-right">対予算</th>
                  <th className="px-3 py-3 text-right">ADR</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.month} style={{ borderTop: '1px solid var(--border)' }}>
                    <td className="px-3 py-2 font-medium">{r.month}</td>
                    <td className="px-3 py-2 text-right font-medium">{fmtNum(r.onhand)}</td>
                    <td className="px-3 py-2 text-right text-xs" style={{ color: 'var(--text-dim)' }}>
                      {fmtNum(r.stayed)} / {fmtNum(r.confirmed)} / {fmtNum(r.tentative)}
                    </td>
                    <td className="px-3 py-2 text-right" style={{ color: 'var(--text-dim)' }}>{fmtNum(r.roomsBudget)}</td>
                    <td className="px-3 py-2 text-right" style={{ color: pickupColor(r.roomsPickup) }}>{pct(r.roomsPickup)}</td>
                    <td className="px-3 py-2 text-right" style={{ color: 'var(--text-dim)' }}>{fmtNum(r.inventory)}</td>
                    <td className="px-3 py-2 text-right">{pct(r.fill)}</td>
                    <td className="px-3 py-2 text-right">{fmtYen(r.revenue)}</td>
                    <td className="px-3 py-2 text-right" style={{ color: 'var(--text-dim)' }}>{fmtYen(r.revenueBudget)}</td>
                    <td className="px-3 py-2 text-right" style={{ color: pickupColor(r.revenuePickup) }}>{pct(r.revenuePickup)}</td>
                    <td className="px-3 py-2 text-right">{fmtNum(r.adr)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-xs mt-2" style={{ color: 'var(--text-dim)' }}>
            オンハンド＝キャンセルを除く予約（未確認＋予約確定＋重要予約＋当月の宿泊済）の室泊。内訳＝実績(C/O)/確定/未確認。
            予算室泊・予算売上は年度予算（budget_daily）由来。在庫＝客室数×暦日数（改装月は設定の月別客室数を反映）。
            ブッキングペース（日次の積み上がり推移）はスナップショット保存で別途対応予定。
          </p>
        </>
      )}
    </div>
  )
}

function pickupColor(v: number | null): string | undefined {
  if (v == null) return undefined
  if (v >= 1) return 'var(--green)'
  if (v >= 0.7) return undefined
  return 'var(--red)'
}

function Kpi({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="card p-4">
      <p className="text-xs mb-1" style={{ color: 'var(--text-dim)' }}>{label}</p>
      <p className="text-xl font-bold" style={{ color: accent ? 'var(--accent)' : 'var(--text)' }}>{value}</p>
    </div>
  )
}
