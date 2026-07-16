'use client'

// B3 日別売上予算 作成画面。来期(FY)の日別予算を支配人が手入力（灯は自動配分しない）。
// 可変(青)=在庫数・販売室数・同伴係数・客単価。他は計算（稼働率・宿泊人数・室単価・宿泊売上・売上合計）。
// 各セル下に「前予（前年予算）／前実（前年実績）」を参考表示。budget_daily version='当初' で保存。
import { Fragment, useCallback, useEffect, useMemo, useState } from 'react'
import { useFacility } from '@/lib/facility-context'
import { supabase } from '@/lib/supabase/client'
import { fetchAll } from '@/lib/supabase/fetch-all'
import { fmtNum, pct } from '@/lib/ui'
import { useToast } from '@/components/toast'
import { Loading } from '@/components/page-bits'

/* eslint-disable @typescript-eslint/no-explicit-any */
interface Row { inventory: string; rooms_sold: string; companion: string; guest_unit: string; event_note: string }
const EMPTY: Row = { inventory: '', rooms_sold: '', companion: '', guest_unit: '', event_note: '' }

const WD = ['日', '月', '火', '水', '木', '金', '土']
const num = (s: string): number | null => (s.trim() === '' ? null : (Number.isFinite(Number(s)) ? Number(s) : null))
const daysInMonth = (ym: string) => new Date(+ym.slice(0, 4), +ym.slice(5, 7), 0).getDate()
const mEnd = (ym: string) => `${ym}-${String(daysInMonth(ym)).padStart(2, '0')}`
const monthDates = (ym: string) => Array.from({ length: daysInMonth(ym) }, (_, i) => `${ym}-${String(i + 1).padStart(2, '0')}`)
const shiftYear = (dateStr: string, delta: number) => `${+dateStr.slice(0, 4) + delta}${dateStr.slice(4)}`
const fyMonths = (fy: number): string[] => {
  const out: string[] = []
  for (let m = 4; m <= 12; m++) out.push(`${fy}-${String(m).padStart(2, '0')}`)
  for (let m = 1; m <= 3; m++) out.push(`${fy + 1}-${String(m).padStart(2, '0')}`)
  return out
}

// 列定義。edit=可変(青入力)、kind=表示形式、prevAct=前年実績を持てる項目(在庫は実績概念として無し)
type EditKey = 'inventory' | 'rooms_sold' | 'companion' | 'guest_unit'
type Metric = { key: string; label: string; edit?: EditKey; kind: 'num' | 'pct' | 'dec'; prevAct?: 'rooms_sold' | 'occ' }
const METRICS: Metric[] = [
  { key: 'inventory', label: '在庫数', edit: 'inventory', kind: 'num' },
  { key: 'rooms_sold', label: '販売室数', edit: 'rooms_sold', kind: 'num', prevAct: 'rooms_sold' },
  { key: 'occ', label: '稼働率', kind: 'pct', prevAct: 'occ' },
  { key: 'companion', label: '同伴係数', edit: 'companion', kind: 'dec' },
  { key: 'guests', label: '宿泊人数', kind: 'num' },
  { key: 'guest_unit', label: '客単価', edit: 'guest_unit', kind: 'num' },
  { key: 'room_unit', label: '室単価', kind: 'num' },
  { key: 'room_revenue', label: '宿泊売上', kind: 'num' },
  { key: 'total_revenue', label: '売上合計', kind: 'num' },
]
const fmtM = (kind: Metric['kind'], v: number | null): string => (v == null ? '—' : kind === 'pct' ? pct(v) : kind === 'dec' ? v.toFixed(2) : fmtNum(v))

// 計算: 稼働率=販売室数/在庫数, 宿泊人数=販売室数×同伴係数, 室単価=客単価×同伴係数, 宿泊売上=販売室数×同伴係数×客単価, 売上合計=宿泊売上
function derive(row: Row): Record<string, number | null> {
  const inv = num(row.inventory), rs = num(row.rooms_sold), comp = num(row.companion), gu = num(row.guest_unit)
  const room_rev = rs != null && comp != null && gu != null ? rs * comp * gu : null
  return {
    inventory: inv, rooms_sold: rs, companion: comp, guest_unit: gu,
    occ: rs != null && inv ? rs / inv : null,
    guests: rs != null && comp != null ? rs * comp : null,
    room_unit: gu != null && comp != null ? gu * comp : null,
    room_revenue: room_rev, total_revenue: room_rev,
  }
}

export default function BudgetDaily({ fy, fyList, onFy, locked = false }: { fy: number | null; fyList: number[]; onFy: (fy: number) => void; locked?: boolean }) {
  const { current, currentFacility } = useFacility()
  const toast = useToast()
  const [jump, setJump] = useState('')
  const [rows, setRows] = useState<Record<string, Row>>({})
  const [prevBud, setPrevBud] = useState<Record<string, any>>({})     // 前年予算(全項目)
  const [prevAct, setPrevAct] = useState<Record<string, any>>({})     // 前年実績(販売室数・稼働率のみ)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)

  const totalRooms = currentFacility?.total_rooms ?? null
  const months = useMemo(() => (fy == null ? [] : fyMonths(fy)), [fy])
  const allDates = useMemo(() => months.flatMap(monthDates), [months])
  useEffect(() => { if (months.length && !months.includes(jump)) setJump(months[0]) }, [months, jump])

  const load = useCallback(async () => {
    if (!current || fy == null) return
    setLoading(true)
    try {
      const [cur, pb, po] = await Promise.all([
        fetchAll(() => supabase.from('budget_daily').select('date, inventory, rooms_sold, companion, guest_unit, event_note').eq('facility', current).eq('version', '当初').eq('fiscal_year', String(fy))).catch(() => []),
        fetchAll(() => supabase.from('budget_daily').select('date, inventory, rooms_sold, occ, companion, guests, guest_unit, room_unit, room_revenue, total_revenue').eq('facility', current).eq('version', '当初').eq('fiscal_year', String(fy - 1))).catch(() => []),
        fetchAll(() => supabase.from('mart_occupancy_daily').select('date, occ, rooms_sold').eq('facility', current).gte('date', `${fy - 1}-04-01`).lte('date', `${fy}-03-31`)).catch(() => []),
      ])
      const s = (v: any) => (v == null ? '' : String(v))
      const r: Record<string, Row> = {}
      ;((cur as any[]) ?? []).forEach((x) => { r[String(x.date)] = { inventory: s(x.inventory), rooms_sold: s(x.rooms_sold), companion: s(x.companion), guest_unit: s(x.guest_unit), event_note: x.event_note ?? '' } })
      const pbM: Record<string, any> = {}
      ;((pb as any[]) ?? []).forEach((x) => { pbM[shiftYear(String(x.date), 1)] = x })
      const poM: Record<string, any> = {}
      ;((po as any[]) ?? []).forEach((x) => { poM[shiftYear(String(x.date), 1)] = x })
      setRows(r); setPrevBud(pbM); setPrevAct(poM)
    } finally { setLoading(false) }
  }, [current, fy])
  useEffect(() => { load() }, [load])

  const setCell = (date: string, k: keyof Row, v: string) => setRows((p) => ({ ...p, [date]: { ...(p[date] ?? EMPTY), [k]: v } }))
  const goMonth = (m: string) => { setJump(m); document.getElementById(`bm-${m}`)?.scrollIntoView({ block: 'start', behavior: 'smooth' }) }

  // 前年同月をコピー（前年予算の可変項目をこの月の入力に流し込む）
  const copyPrevYear = async () => {
    if (!current || !jump) return
    const prevMonth = shiftYear(`${jump}-01`, -1).slice(0, 7)
    const pb = await fetchAll(() => supabase.from('budget_daily').select('date, inventory, rooms_sold, companion, guest_unit, event_note').eq('facility', current).eq('version', '当初').gte('date', `${prevMonth}-01`).lte('date', mEnd(prevMonth))).catch(() => [])
    const byDate: Record<string, any> = {}
    ;((pb as any[]) ?? []).forEach((x) => { byDate[shiftYear(String(x.date), 1)] = x })
    const s = (v: any) => (v == null ? '' : String(v))
    setRows((prevR) => {
      const r = { ...prevR }
      for (const d of monthDates(jump)) { const src = byDate[d]; if (src) r[d] = { inventory: s(src.inventory), rooms_sold: s(src.rooms_sold), companion: s(src.companion), guest_unit: s(src.guest_unit), event_note: src.event_note ?? '' } }
      return r
    })
    toast(`${jump} に前年同月の予算をコピーしました`, 'success')
  }

  const save = async () => {
    if (!current || fy == null) return
    setSaving(true)
    const payload = allDates.map((d) => {
      const row = rows[d] ?? EMPTY
      const v = derive(row)
      return {
        facility: current, fiscal_year: String(fy), date: d, version: '当初',
        inventory: v.inventory, rooms_sold: v.rooms_sold, occ: v.occ == null ? null : Number(v.occ.toFixed(4)),
        companion: v.companion, guests: v.guests, guest_unit: v.guest_unit,
        room_unit: v.room_unit == null ? null : Math.round(v.room_unit),
        room_revenue: v.room_revenue == null ? null : Math.round(v.room_revenue),
        total_revenue: v.total_revenue == null ? null : Math.round(v.total_revenue),
        event_note: row.event_note.trim() || null,
      }
    })
    const { error } = await supabase.from('budget_daily').upsert(payload, { onConflict: 'facility,date,version' })
    toast(error ? `エラー: ${error.message}` : `${fy}年度の日別予算を保存しました（${payload.length}日）`, error ? 'error' : 'success')
    setSaving(false)
  }

  const yearTotal = useMemo(() => {
    let rooms = 0, rev = 0
    for (const d of allDates) { const v = derive(rows[d] ?? EMPTY); rooms += v.rooms_sold ?? 0; rev += v.total_revenue ?? 0 }
    return { rooms, rev }
  }, [rows, allDates])

  if (!current) return <div className="text-sm mt-4" style={{ color: 'var(--text-dim)' }}>宿を選択してください。</div>

  const editStyle = { color: '#2563eb' } // 可変=青
  return (
    <div>
      <div className="flex items-center gap-2 flex-wrap mb-2 mt-3">
        <span className="text-xs" style={{ color: 'var(--text-dim)' }}>年度</span>
        <select className="field px-3 py-1.5 text-sm" value={fy ?? ''} onChange={(e) => onFy(Number(e.target.value))}>
          {fyList.map((y) => <option key={y} value={y}>{y}年度</option>)}
        </select>
        <span className="text-xs" style={{ color: 'var(--text-dim)' }}>月へ移動</span>
        <select className="field px-3 py-1.5 text-sm" value={jump} onChange={(e) => goMonth(e.target.value)}>
          {months.map((m) => <option key={m} value={m}>{m}</option>)}
        </select>
        <button onClick={copyPrevYear} disabled={locked} className="text-xs px-3 py-1.5 rounded-md disabled:opacity-40" style={{ background: 'var(--surface2)', color: 'var(--text)' }}>前年同月をコピー</button>
        <button onClick={save} disabled={saving || locked} className="ml-auto px-4 py-1.5 rounded-md text-sm text-white disabled:opacity-50" style={{ background: 'var(--accent)' }}>{saving ? '保存中…' : locked ? '🔒 ロック中' : '年間を保存'}</button>
      </div>
      <p className="text-[11px] mb-2" style={{ color: 'var(--text-dim)' }}>
        <span style={{ color: '#2563eb' }}>青</span>＝手入力（在庫数・販売室数・同伴係数・客単価）。他は自動計算。各セル下＝前予（前年予算）／前実（前年実績・販売室数と稼働率のみ）。売上合計＝販売室数×同伴係数×客単価（二食込み・付帯抜き）。備考に「休館」でグレー表示。年間 販売室数計 {fmtNum(yearTotal.rooms)} / 売上計 {fmtNum(yearTotal.rev)}。総客室数={totalRooms ?? '—'}。
      </p>

      {loading ? <Loading /> : (
        <div className="card overflow-auto" style={{ maxHeight: 'calc(100vh - 210px)' }}>
          <table className="text-xs border-separate" style={{ borderSpacing: 0, minWidth: 1200 }}>
            <thead>
              <tr style={{ color: 'var(--text-dim)' }}>
                <th className="px-2 py-1.5 text-left whitespace-nowrap sticky left-0 top-0 z-30" style={{ background: 'var(--surface2)' }}>日付</th>
                {METRICS.map((m) => <th key={m.key} className="px-2 py-1.5 text-right whitespace-nowrap sticky top-0 z-20" style={{ background: 'var(--surface2)', minWidth: 84, color: m.edit ? '#2563eb' : undefined }}>{m.label}</th>)}
                <th className="px-2 py-1.5 text-left whitespace-nowrap sticky top-0 z-20" style={{ background: 'var(--surface2)', minWidth: 130 }}>備考</th>
              </tr>
            </thead>
            <tbody>
              {months.map((m) => (
                <Fragment key={m}>
                  <tr id={`bm-${m}`}>
                    <td colSpan={METRICS.length + 2} className="px-2 py-1 text-xs font-semibold" style={{ position: 'sticky', top: 28, zIndex: 16, background: 'var(--surface2)', borderTop: '2px solid var(--border)', borderBottom: '1px solid var(--border)' }}>{m}</td>
                  </tr>
                  {monthDates(m).map((d) => {
                    const row = rows[d] ?? EMPTY
                    const v = derive(row)
                    const wd = WD[new Date(d).getDay()]
                    const isWeekend = wd === '土' || wd === '日'
                    const closed = row.event_note.includes('休館')
                    const pb = prevBud[d], po = prevAct[d]
                    return (
                      <tr key={d} style={{ borderTop: '1px solid var(--border)', opacity: closed ? 0.5 : 1 }}>
                        <td className="px-2 py-1 whitespace-nowrap sticky left-0 z-10" style={{ background: 'var(--surface)', color: isWeekend ? 'var(--red)' : undefined }}>{d.slice(8)}（{wd}）</td>
                        {METRICS.map((mt) => {
                          const pbv = pb ? pb[mt.key] ?? null : null
                          const pov = mt.prevAct && po ? po[mt.prevAct] ?? null : null
                          return (
                            <td key={mt.key} className="px-1 py-1 text-right align-top" style={{ minWidth: 84 }}>
                              {mt.edit ? (
                                <input className="field px-1 py-0.5 text-xs text-right w-full" readOnly={locked} style={{ ...editStyle, minWidth: 64 }} value={row[mt.edit]} onChange={(e) => setCell(d, mt.edit as keyof Row, e.target.value)} />
                              ) : (
                                <div className="px-1">{fmtM(mt.kind, v[mt.key])}</div>
                              )}
                              <div className="text-[9px] leading-tight whitespace-nowrap" style={{ color: 'var(--text-dim)' }}>
                                前予 {fmtM(mt.kind, pbv)} ／ 前実 {mt.prevAct ? fmtM(mt.kind, pov) : 'ー'}
                              </div>
                            </td>
                          )
                        })}
                        <td className="px-1 py-1"><input className="field px-1.5 py-1 text-xs w-full" readOnly={locked} style={{ minWidth: 120 }} value={row.event_note} onChange={(e) => setCell(d, 'event_note', e.target.value)} placeholder="イベント・休館・素泊 等" /></td>
                      </tr>
                    )
                  })}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
