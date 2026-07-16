'use client'

// B3 日別売上予算 作成画面。来期(FY)の日別予算を支配人が手入力（灯は自動配分しない）。
// 年間分を1つの縦スクロールに表示し、月セレクタでその月へジャンプ。budget_daily version='当初' で保存。
import { Fragment, useCallback, useEffect, useMemo, useState } from 'react'
import { useFacility } from '@/lib/facility-context'
import { supabase } from '@/lib/supabase/client'
import { fetchAll } from '@/lib/supabase/fetch-all'
import { fmtNum, pct } from '@/lib/ui'
import { useToast } from '@/components/toast'
import { Loading } from '@/components/page-bits'

/* eslint-disable @typescript-eslint/no-explicit-any */
interface Row { inventory: string; rooms_sold: string; room_unit: string; guests: string; guest_unit: string; total_revenue: string; event_note: string }
const EMPTY: Row = { inventory: '', rooms_sold: '', room_unit: '', guests: '', guest_unit: '', total_revenue: '', event_note: '' }
interface PrevRef { budRooms: number | null; budRev: number | null; actOcc: number | null; actRooms: number | null }

const WD = ['日', '月', '火', '水', '木', '金', '土']
const num = (s: string): number | null => (s.trim() === '' ? null : (Number.isFinite(Number(s)) ? Number(s) : null))
const daysInMonth = (ym: string) => new Date(+ym.slice(0, 4), +ym.slice(5, 7), 0).getDate()
const mEnd = (ym: string) => `${ym}-${String(daysInMonth(ym)).padStart(2, '0')}`
const monthDates = (ym: string) => Array.from({ length: daysInMonth(ym) }, (_, i) => `${ym}-${String(i + 1).padStart(2, '0')}`)
const shiftYear = (dateStr: string, delta: number) => `${+dateStr.slice(0, 4) + delta}${dateStr.slice(4)}`
// FY文字列(例2027) → その年度の月配列 2027-04..2028-03
const fyMonths = (fy: number): string[] => {
  const out: string[] = []
  for (let m = 4; m <= 12; m++) out.push(`${fy}-${String(m).padStart(2, '0')}`)
  for (let m = 1; m <= 3; m++) out.push(`${fy + 1}-${String(m).padStart(2, '0')}`)
  return out
}

export default function BudgetDaily({ fy, fyList, onFy }: { fy: number | null; fyList: number[]; onFy: (fy: number) => void }) {
  const { current, currentFacility } = useFacility()
  const toast = useToast()
  const [jump, setJump] = useState('')          // ジャンプ先の月
  const [rows, setRows] = useState<Record<string, Row>>({})
  const [prev, setPrev] = useState<Record<string, PrevRef>>({})
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)

  const totalRooms = currentFacility?.total_rooms ?? null
  const months = useMemo(() => (fy == null ? [] : fyMonths(fy)), [fy])
  const allDates = useMemo(() => months.flatMap(monthDates), [months])
  useEffect(() => { if (months.length && !months.includes(jump)) setJump(months[0]) }, [months, jump])

  // 年間の既存予算＋前年参考を読込
  const load = useCallback(async () => {
    if (!current || fy == null) return
    setLoading(true)
    try {
      const [cur, prevBud, prevOcc] = await Promise.all([
        fetchAll(() => supabase.from('budget_daily').select('date, inventory, rooms_sold, room_unit, guests, guest_unit, total_revenue, event_note').eq('facility', current).eq('version', '当初').eq('fiscal_year', String(fy))).catch(() => []),
        fetchAll(() => supabase.from('budget_daily').select('date, rooms_sold, total_revenue').eq('facility', current).eq('version', '当初').eq('fiscal_year', String(fy - 1))).catch(() => []),
        fetchAll(() => supabase.from('mart_occupancy_daily').select('date, occ, rooms_sold').eq('facility', current).gte('date', `${fy - 1}-04-01`).lte('date', `${fy}-03-31`)).catch(() => []),
      ])
      const r: Record<string, Row> = {}
      const s = (v: any) => (v == null ? '' : String(v))
      ;((cur as any[]) ?? []).forEach((x) => {
        r[String(x.date)] = {
          inventory: s(x.inventory), rooms_sold: s(x.rooms_sold), room_unit: s(x.room_unit),
          guests: s(x.guests), guest_unit: s(x.guest_unit), total_revenue: s(x.total_revenue), event_note: x.event_note ?? '',
        }
      })
      const p: Record<string, PrevRef> = {}
      ;((prevBud as any[]) ?? []).forEach((x) => { const d = shiftYear(String(x.date), 1); (p[d] ??= { budRooms: null, budRev: null, actOcc: null, actRooms: null }).budRooms = x.rooms_sold; p[d].budRev = x.total_revenue })
      ;((prevOcc as any[]) ?? []).forEach((x) => { const d = shiftYear(String(x.date), 1); (p[d] ??= { budRooms: null, budRev: null, actOcc: null, actRooms: null }).actOcc = x.occ; p[d].actRooms = x.rooms_sold })
      setRows(r); setPrev(p)
    } finally { setLoading(false) }
  }, [current, fy])
  useEffect(() => { load() }, [load])

  const setCell = (date: string, k: keyof Row, v: string) => setRows((prevR) => ({ ...prevR, [date]: { ...(prevR[date] ?? EMPTY), [k]: v } }))
  const occOf = (row: Row): number | null => { const rs = num(row.rooms_sold), inv = num(row.inventory); return rs != null && inv ? rs / inv : null }

  const goMonth = (m: string) => { setJump(m); document.getElementById(`bm-${m}`)?.scrollIntoView({ block: 'start', behavior: 'smooth' }) }

  // 前年同月をコピー（前年の予算値をこの月の入力に流し込む）。対象=ジャンプ中の月。
  const copyPrevYear = async () => {
    if (!current || !jump) return
    const prevMonth = shiftYear(`${jump}-01`, -1).slice(0, 7)
    const pb = await fetchAll(() => supabase.from('budget_daily').select('date, inventory, rooms_sold, room_unit, guests, guest_unit, total_revenue, event_note').eq('facility', current).eq('version', '当初').gte('date', `${prevMonth}-01`).lte('date', mEnd(prevMonth))).catch(() => [])
    const byDate: Record<string, any> = {}
    ;((pb as any[]) ?? []).forEach((x) => { byDate[shiftYear(String(x.date), 1)] = x })
    setRows((prevR) => {
      const r = { ...prevR }
      for (const d of monthDates(jump)) {
        const src = byDate[d]; if (!src) continue
        const s = (v: any) => (v == null ? '' : String(v))
        r[d] = { inventory: s(src.inventory), rooms_sold: s(src.rooms_sold), room_unit: s(src.room_unit), guests: s(src.guests), guest_unit: s(src.guest_unit), total_revenue: s(src.total_revenue), event_note: src.event_note ?? '' }
      }
      return r
    })
    toast(`${jump} に前年同月の予算をコピーしました`, 'success')
  }

  // 売上予算を「室数×ADR」で補充（年間の空欄のみ）
  const fillRevenue = () => setRows((prevR) => {
    const r = { ...prevR }
    for (const d of allDates) {
      const row = r[d] ?? EMPTY
      if (row.total_revenue.trim() !== '') continue
      const rs = num(row.rooms_sold), ad = num(row.room_unit)
      if (rs != null && ad != null) r[d] = { ...row, total_revenue: String(Math.round(rs * ad)) }
    }
    return r
  })

  const save = async () => {
    if (!current || fy == null) return
    setSaving(true)
    const payload = allDates.map((d) => {
      const row = rows[d] ?? EMPTY
      const rs = num(row.rooms_sold), inv = num(row.inventory)
      return {
        facility: current, fiscal_year: String(fy), date: d, version: '当初',
        inventory: inv, rooms_sold: rs, occ: rs != null && inv ? Number((rs / inv).toFixed(4)) : null,
        room_unit: num(row.room_unit), guests: num(row.guests), guest_unit: num(row.guest_unit),
        total_revenue: num(row.total_revenue), event_note: row.event_note.trim() || null,
      }
    })
    const { error } = await supabase.from('budget_daily').upsert(payload, { onConflict: 'facility,date,version' })
    toast(error ? `エラー: ${error.message}` : `${fy}年度の日別予算を保存しました（${payload.length}日）`, error ? 'error' : 'success')
    setSaving(false)
  }

  const monthTotal = (m: string) => {
    let rooms = 0, rev = 0, inv = 0
    for (const d of monthDates(m)) { const r = rows[d] ?? EMPTY; rooms += num(r.rooms_sold) ?? 0; rev += num(r.total_revenue) ?? 0; inv += num(r.inventory) ?? 0 }
    return { rooms, rev, occ: inv ? rooms / inv : null }
  }
  const yearTotal = useMemo(() => {
    let rooms = 0, rev = 0, inv = 0
    for (const d of allDates) { const r = rows[d] ?? EMPTY; rooms += num(r.rooms_sold) ?? 0; rev += num(r.total_revenue) ?? 0; inv += num(r.inventory) ?? 0 }
    return { rooms, rev, occ: inv ? rooms / inv : null }
  }, [rows, allDates])

  if (!current) return <div className="p-6 text-sm" style={{ color: 'var(--text-dim)' }}>宿を選択してください。</div>

  const inputCls = 'field px-1.5 py-1 text-xs text-right w-full'
  return (
    <div>
      <div className="flex items-center gap-2 flex-wrap mb-3">
        <span className="text-xs" style={{ color: 'var(--text-dim)' }}>年度</span>
        <select className="field px-3 py-1.5 text-sm" value={fy ?? ''} onChange={(e) => onFy(Number(e.target.value))}>
          {fyList.map((y) => <option key={y} value={y}>{y}年度</option>)}
        </select>
        <span className="text-xs" style={{ color: 'var(--text-dim)' }}>月へ移動</span>
        <select className="field px-3 py-1.5 text-sm" value={jump} onChange={(e) => goMonth(e.target.value)}>
          {months.map((m) => <option key={m} value={m}>{m}</option>)}
        </select>
        <button onClick={copyPrevYear} className="text-xs px-3 py-1.5 rounded-md" style={{ background: 'var(--surface2)', color: 'var(--text)' }}>前年同月をコピー</button>
        <button onClick={fillRevenue} className="text-xs px-3 py-1.5 rounded-md" style={{ background: 'var(--surface2)', color: 'var(--text)' }}>売上=室数×ADRで補充</button>
        <button onClick={save} disabled={saving} className="ml-auto px-4 py-1.5 rounded-md text-sm text-white disabled:opacity-50" style={{ background: 'var(--accent)' }}>{saving ? '保存中…' : '年間を保存'}</button>
      </div>
      <p className="text-[11px] mb-2" style={{ color: 'var(--text-dim)' }}>
        支配人が繁閑・イベント・戦略を考えて日別に置きます（灯は自動配分しません）。前年は参考です（コピーはしません）。年間 販売室数計 {fmtNum(yearTotal.rooms)} / 売上計 {fmtNum(yearTotal.rev)} / OCC {pct(yearTotal.occ)}。総客室数={totalRooms ?? '—'}。
      </p>

      {loading ? <Loading /> : (
        <div className="card overflow-auto" style={{ maxHeight: 'calc(100vh - 200px)' }}>
          <table className="text-xs border-separate" style={{ borderSpacing: 0, minWidth: 1100 }}>
            <thead className="[&_th]:sticky [&_th]:top-0 [&_th]:z-10 [&_th]:bg-[var(--surface2)] [&_th]:px-2 [&_th]:py-1.5 [&_th]:whitespace-nowrap">
              <tr style={{ color: 'var(--text-dim)' }}>
                <th className="text-left sticky left-0 z-20" style={{ background: 'var(--surface2)' }}>日付</th>
                <th className="text-right">販売可能室数</th>
                <th className="text-right">想定販売室数</th>
                <th className="text-right">想定OCC</th>
                <th className="text-right">想定ADR</th>
                <th className="text-right">想定客数</th>
                <th className="text-right">想定客単価</th>
                <th className="text-right">売上予算</th>
                <th className="text-left">備考</th>
                <th className="text-right" style={{ color: 'var(--accent)' }}>前年予算(室/売上)</th>
                <th className="text-right" style={{ color: 'var(--accent)' }}>前年実績(OCC/室)</th>
              </tr>
            </thead>
            <tbody>
              {months.map((m) => {
                const mt = monthTotal(m)
                return (
                  <Fragment key={m}>
                    <tr id={`bm-${m}`}>
                      <td colSpan={11} className="px-2 py-1.5 text-xs font-semibold sticky left-0" style={{ background: 'var(--surface2)', borderTop: '2px solid var(--border)' }}>
                        {m}　<span style={{ color: 'var(--text-dim)' }}>販売室数 {fmtNum(mt.rooms)} / 売上 {fmtNum(mt.rev)} / OCC {pct(mt.occ)}</span>
                      </td>
                    </tr>
                    {monthDates(m).map((d) => {
                      const row = rows[d] ?? EMPTY
                      const wd = WD[new Date(d).getDay()]
                      const isWeekend = wd === '土' || wd === '日'
                      const p = prev[d]
                      return (
                        <tr key={d} style={{ borderTop: '1px solid var(--border)' }}>
                          <td className="px-2 py-1 whitespace-nowrap sticky left-0 z-10" style={{ background: 'var(--surface)', color: isWeekend ? 'var(--red)' : undefined }}>{d.slice(8)}（{wd}）</td>
                          <td className="px-1 py-1"><input className={inputCls} value={row.inventory} onChange={(e) => setCell(d, 'inventory', e.target.value)} /></td>
                          <td className="px-1 py-1"><input className={inputCls} value={row.rooms_sold} onChange={(e) => setCell(d, 'rooms_sold', e.target.value)} /></td>
                          <td className="px-2 py-1 text-right" style={{ color: 'var(--text-dim)' }}>{pct(occOf(row))}</td>
                          <td className="px-1 py-1"><input className={inputCls} value={row.room_unit} onChange={(e) => setCell(d, 'room_unit', e.target.value)} /></td>
                          <td className="px-1 py-1"><input className={inputCls} value={row.guests} onChange={(e) => setCell(d, 'guests', e.target.value)} /></td>
                          <td className="px-1 py-1"><input className={inputCls} value={row.guest_unit} onChange={(e) => setCell(d, 'guest_unit', e.target.value)} /></td>
                          <td className="px-1 py-1"><input className={inputCls} value={row.total_revenue} onChange={(e) => setCell(d, 'total_revenue', e.target.value)} /></td>
                          <td className="px-1 py-1"><input className="field px-1.5 py-1 text-xs w-full" style={{ minWidth: 120 }} value={row.event_note} onChange={(e) => setCell(d, 'event_note', e.target.value)} placeholder="イベント・休館 等" /></td>
                          <td className="px-2 py-1 text-right whitespace-nowrap" style={{ color: 'var(--text-dim)' }}>{p?.budRooms == null ? '—' : fmtNum(p.budRooms)} / {p?.budRev == null ? '—' : fmtNum(p.budRev)}</td>
                          <td className="px-2 py-1 text-right whitespace-nowrap" style={{ color: 'var(--text-dim)' }}>{p?.actOcc == null ? '—' : pct(p.actOcc)} / {p?.actRooms == null ? '—' : fmtNum(p.actRooms)}</td>
                        </tr>
                      )
                    })}
                  </Fragment>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
