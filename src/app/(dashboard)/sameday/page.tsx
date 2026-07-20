'use client'

// 前年同日分析（先行予約 同日対比）— 基準日を選び、宿泊月ごとに「基準日時点で入っていた予約」を
// 今年 vs 前年同日で比較する。チャネル別に売上・室数(泊)・ADR・人数・同伴を並べる。
import { useMemo, useState } from 'react'
import { useFacility } from '@/lib/facility-context'
import { supabase } from '@/lib/supabase/client'
import { fetchAll } from '@/lib/supabase/fetch-all'
import { fmtNum, fmtYen, pct, channelColor } from '@/lib/ui'
import { Loading, Empty, LoadError } from '@/components/page-bits'
import { useFacilityData } from '@/lib/use-facility-data'

interface Resv {
  checkin: string; nights: number | null; revenue_settled: number | null; channel: string | null
  status: string | null; booking_date: string | null; cancel_date: string | null; guests_total: number | null
}

const EXCLUDE_STATUS = new Set(['販売不可', '空部屋'])  // 予約とみなさない
const TOP_CHANNELS = 8
const MAX_MONTHS = 12

const todayISO = () => new Date().toISOString().slice(0, 10)
const shiftYr = (k: string) => `${Number(k.slice(0, 4)) - 1}${k.slice(4)}`
// 基準日Tの時点で「生きていた」予約か: 予約済み(booking_date<=T) かつ 未キャンセル(status!=キャンセル または キャンセル日がTより後)
const aliveAt = (r: Resv, T: string) =>
  !!r.booking_date && r.booking_date <= T && (r.status !== 'キャンセル' || (!!r.cancel_date && r.cancel_date > T))

type Agg = { rev: number; rn: number; guests: number }
const emptyAgg = (): Agg => ({ rev: 0, rn: 0, guests: 0 })
const adr = (a: Agg) => (a.rn > 0 ? Math.round(a.rev / a.rn) : null)
const companion = (a: Agg) => (a.rn > 0 ? a.guests / a.rn : null)

export default function SameDayPage() {
  const { current } = useFacility()
  const [asOf, setAsOf] = useState(todayISO())
  const prevAsOf = useMemo(() => shiftYr(asOf), [asOf])

  const { data, loading, error } = useFacilityData<Resv[]>((facility) => {
    const from = `${Number(asOf.slice(0, 4)) - 1}-01-01`
    return fetchAll<Resv>(() => supabase.from('raw_reservation')
      .select('checkin, nights, revenue_settled, channel, status, booking_date, cancel_date, guests_total')
      .eq('facility', facility).gte('checkin', from))
  }, [asOf])
  const resv = useMemo(() => (data ?? []).filter((r) => !EXCLUDE_STATUS.has(r.status ?? '')), [data])

  const asOfMonth = asOf.slice(0, 7)
  const months = useMemo(
    () => [...new Set(resv.map((r) => r.checkin.slice(0, 7)).filter((m) => m >= asOfMonth))].sort().slice(0, MAX_MONTHS),
    [resv, asOfMonth])

  // 月ごとに { チャネル→{今,前} } を集計
  const byMonth = useMemo(() => {
    const out: Record<string, { cur: Record<string, Agg>; prev: Record<string, Agg> }> = {}
    for (const m of months) out[m] = { cur: {}, prev: {} }
    for (const r of resv) {
      const m = r.checkin.slice(0, 7)
      const ch = r.channel || '不明'
      if (out[m] && aliveAt(r, asOf)) {
        const g = (out[m].cur[ch] ??= emptyAgg())
        g.rev += r.revenue_settled ?? 0; g.rn += Math.max(r.nights ?? 1, 1); g.guests += r.guests_total ?? 0
      }
      const pm = shiftYr(m)
      if (out[pm] && aliveAt(r, prevAsOf)) {
        const g = (out[pm].prev[ch] ??= emptyAgg())
        g.rev += r.revenue_settled ?? 0; g.rn += Math.max(r.nights ?? 1, 1); g.guests += r.guests_total ?? 0
      }
    }
    return out
  }, [resv, months, asOf, prevAsOf])

  const monthRows = useMemo(() => months.map((m) => {
    const { cur, prev } = byMonth[m]
    const chSet = [...new Set([...Object.keys(cur), ...Object.keys(prev)])]
    const ranked = chSet.sort((a, b) => (cur[b]?.rev ?? 0) - (cur[a]?.rev ?? 0))
    const top = ranked.slice(0, TOP_CHANNELS)
    const hasOther = ranked.length > TOP_CHANNELS
    const rows = top.map((ch) => ({ ch, cur: cur[ch] ?? emptyAgg(), prev: prev[ch] ?? emptyAgg() }))
    if (hasOther) {
      const other = { cur: emptyAgg(), prev: emptyAgg() }
      for (const ch of ranked.slice(TOP_CHANNELS)) {
        const c = cur[ch], p = prev[ch]
        if (c) { other.cur.rev += c.rev; other.cur.rn += c.rn; other.cur.guests += c.guests }
        if (p) { other.prev.rev += p.rev; other.prev.rn += p.rn; other.prev.guests += p.guests }
      }
      rows.push({ ch: 'その他', cur: other.cur, prev: other.prev })
    }
    const total = rows.reduce((s, r) => ({
      cur: { rev: s.cur.rev + r.cur.rev, rn: s.cur.rn + r.cur.rn, guests: s.cur.guests + r.cur.guests },
      prev: { rev: s.prev.rev + r.prev.rev, rn: s.prev.rn + r.prev.rn, guests: s.prev.guests + r.prev.guests },
    }), { cur: emptyAgg(), prev: emptyAgg() })
    return { m, prevM: shiftYr(m), rows, total }
  }), [months, byMonth])

  const ratioColor = (v: number | null) => (v == null ? undefined : v >= 1 ? 'var(--green)' : v >= 0.9 ? undefined : 'var(--red)')
  const ratio = (a: number, b: number) => (b > 0 ? a / b : null)

  return (
    <div className="p-6">
      <div className="flex items-center gap-3 mb-2 flex-wrap">
        <h1 className="text-base font-semibold">先行予約 同日対比</h1>
        <label className="text-xs ml-2" style={{ color: 'var(--text-dim)' }}>基準日:</label>
        <input type="date" className="field px-3 py-1.5 text-sm" value={asOf} onChange={(e) => setAsOf(e.target.value)} />
      </div>
      <p className="text-xs mb-4" style={{ color: 'var(--text-dim)' }}>
        今年基準日: {asOf}　前年基準日: {prevAsOf}
      </p>

      {loading ? <Loading /> : error ? <LoadError message={error} /> : monthRows.length === 0 ? (
        <Empty message="この基準日以降の宿泊予約データがありません。予約情報CSV（全ステータス）を /upload から取り込んでください。" />
      ) : (
        <div className="space-y-4">
          {monthRows.map(({ m, prevM, rows, total }) => (
            <div key={m} className="card overflow-x-auto">
              <div className="flex items-center justify-between px-4 pt-3 pb-2">
                <h2 className="text-sm font-semibold">宿泊月：{m}</h2>
                <span className="text-xs" style={{ color: 'var(--text-dim)' }}>前年同月：{prevM}</span>
              </div>
              <table className="w-full text-sm whitespace-nowrap">
                <thead>
                  <tr style={{ background: 'var(--surface2)', color: 'var(--text-dim)' }} className="text-left">
                    <th className="px-3 py-2">チャネル</th>
                    <th className="px-3 py-2 text-right">売上（今）</th>
                    <th className="px-3 py-2 text-right">売上（前）</th>
                    <th className="px-3 py-2 text-right">売上比</th>
                    <th className="px-3 py-2 text-right">室数RN（今）</th>
                    <th className="px-3 py-2 text-right">室数RN（前）</th>
                    <th className="px-3 py-2 text-right">室数比</th>
                    <th className="px-3 py-2 text-right">ADR（今）</th>
                    <th className="px-3 py-2 text-right">ADR（前）</th>
                    <th className="px-3 py-2 text-right">人数（今）</th>
                    <th className="px-3 py-2 text-right">人数（前）</th>
                    <th className="px-3 py-2 text-right">同伴（今）</th>
                  </tr>
                </thead>
                <tbody>
                  <tr style={{ borderTop: '1px solid var(--border)', background: 'var(--surface2)' }}>
                    <td className="px-3 py-2 font-bold">合計</td>
                    <td className="px-3 py-2 text-right font-bold">{fmtYen(total.cur.rev)}</td>
                    <td className="px-3 py-2 text-right" style={{ color: 'var(--text-dim)' }}>{fmtYen(total.prev.rev)}</td>
                    <td className="px-3 py-2 text-right font-medium" style={{ color: ratioColor(ratio(total.cur.rev, total.prev.rev)) }}>{pct(ratio(total.cur.rev, total.prev.rev))}</td>
                    <td className="px-3 py-2 text-right font-bold">{fmtNum(total.cur.rn)}室</td>
                    <td className="px-3 py-2 text-right" style={{ color: 'var(--text-dim)' }}>{fmtNum(total.prev.rn)}室</td>
                    <td className="px-3 py-2 text-right font-medium" style={{ color: ratioColor(ratio(total.cur.rn, total.prev.rn)) }}>{pct(ratio(total.cur.rn, total.prev.rn))}</td>
                    <td className="px-3 py-2 text-right">{fmtYen(adr(total.cur))}</td>
                    <td className="px-3 py-2 text-right" style={{ color: 'var(--text-dim)' }}>{fmtYen(adr(total.prev))}</td>
                    <td className="px-3 py-2 text-right">{fmtNum(total.cur.guests)}名</td>
                    <td className="px-3 py-2 text-right" style={{ color: 'var(--text-dim)' }}>{fmtNum(total.prev.guests)}名</td>
                    <td className="px-3 py-2 text-right">{companion(total.cur)?.toFixed(2) ?? '-'}</td>
                  </tr>
                  {rows.map((r) => (
                    <tr key={r.ch} style={{ borderTop: '1px solid var(--border)' }}>
                      <td className="px-3 py-2">
                        <span className="inline-flex items-center gap-1.5">
                          <span className="inline-block w-2 h-2 rounded-full" style={{ background: r.ch === 'その他' ? '#B4B2A9' : channelColor(r.ch) }} />
                          {r.ch}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-right">{fmtYen(r.cur.rev)}</td>
                      <td className="px-3 py-2 text-right" style={{ color: 'var(--text-dim)' }}>{fmtYen(r.prev.rev)}</td>
                      <td className="px-3 py-2 text-right" style={{ color: ratioColor(ratio(r.cur.rev, r.prev.rev)) }}>{pct(ratio(r.cur.rev, r.prev.rev))}</td>
                      <td className="px-3 py-2 text-right">{fmtNum(r.cur.rn)}室</td>
                      <td className="px-3 py-2 text-right" style={{ color: 'var(--text-dim)' }}>{fmtNum(r.prev.rn)}室</td>
                      <td className="px-3 py-2 text-right" style={{ color: ratioColor(ratio(r.cur.rn, r.prev.rn)) }}>{pct(ratio(r.cur.rn, r.prev.rn))}</td>
                      <td className="px-3 py-2 text-right">{fmtYen(adr(r.cur))}</td>
                      <td className="px-3 py-2 text-right" style={{ color: 'var(--text-dim)' }}>{fmtYen(adr(r.prev))}</td>
                      <td className="px-3 py-2 text-right">{fmtNum(r.cur.guests)}名</td>
                      <td className="px-3 py-2 text-right" style={{ color: 'var(--text-dim)' }}>{fmtNum(r.prev.guests)}名</td>
                      <td className="px-3 py-2 text-right">{companion(r.cur)?.toFixed(2) ?? '-'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
        </div>
      )}
      <p className="text-xs mt-3" style={{ color: 'var(--text-dim)' }}>
        今＝基準日時点で入っていた予約（予約日が基準日以前・基準日時点で未キャンセル）。前＝前年同日時点で同様に集計。
        室数RN＝室泊数（1予約×泊数）。ADR＝売上÷室泊。同伴＝人数÷室泊。販売不可・空部屋は除外。
      </p>
    </div>
  )
}
