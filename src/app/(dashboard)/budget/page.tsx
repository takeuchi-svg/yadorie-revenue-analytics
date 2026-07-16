'use client'

// B3 日別売上予算 作成画面。来期(FY)の日別予算を支配人が手入力（灯は自動配分しない）。
// budget_daily に version='当初' で保存。前年の予算・実績を参考表示、前年同月コピー・室数×ADR補助。
import { useCallback, useEffect, useMemo, useState } from 'react'
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
const shiftYear = (dateStr: string, delta: number) => `${+dateStr.slice(0, 4) + delta}${dateStr.slice(4)}`
// FY文字列(例'2027') → その年度の月配列 2027-04..2028-03
const fyMonths = (fy: number): string[] => {
  const out: string[] = []
  for (let m = 4; m <= 12; m++) out.push(`${fy}-${String(m).padStart(2, '0')}`)
  for (let m = 1; m <= 3; m++) out.push(`${fy + 1}-${String(m).padStart(2, '0')}`)
  return out
}

export default function BudgetPage() {
  const { current, currentFacility } = useFacility()
  const toast = useToast()
  const [fyList, setFyList] = useState<number[]>([])
  const [fy, setFy] = useState<number | null>(null)
  const [month, setMonth] = useState('')
  const [rows, setRows] = useState<Record<string, Row>>({})
  const [prev, setPrev] = useState<Record<string, PrevRef>>({})
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)

  const totalRooms = currentFacility?.total_rooms ?? null

  // 年度候補: 既存の当初予算のFY ＋ 来期(最大+1)。デフォルトは来期。
  useEffect(() => {
    if (!current) return
    ;(async () => {
      const rowsFy = await fetchAll(() => supabase.from('budget_daily').select('fiscal_year').eq('facility', current).eq('version', '当初'))
      const ys = [...new Set(((rowsFy as { fiscal_year: string }[]) ?? []).map((r) => Number(r.fiscal_year)).filter(Number.isFinite))].sort((a, b) => a - b)
      const nextFy = (ys.length ? ys[ys.length - 1] : new Date().getFullYear()) + 1
      const opts = [...new Set([...ys, nextFy])].sort((a, b) => b - a)
      setFyList(opts)
      setFy((f) => (f && opts.includes(f) ? f : nextFy))
    })()
  }, [current])

  const months = useMemo(() => (fy == null ? [] : fyMonths(fy)), [fy])
  useEffect(() => { if (months.length && !months.includes(month)) setMonth(months[0]) }, [months, month])

  const dates = useMemo(() => {
    if (!month) return []
    return Array.from({ length: daysInMonth(month) }, (_, i) => `${month}-${String(i + 1).padStart(2, '0')}`)
  }, [month])

  // 当月の既存予算＋前年参考を読込
  const load = useCallback(async () => {
    if (!current || !month || fy == null) return
    setLoading(true)
    const prevMonth = shiftYear(`${month}-01`, -1).slice(0, 7)
    const [cur, prevBud, prevOcc] = await Promise.all([
      fetchAll(() => supabase.from('budget_daily').select('date, inventory, rooms_sold, room_unit, guests, guest_unit, total_revenue, event_note').eq('facility', current).eq('version', '当初').eq('fiscal_year', String(fy)).gte('date', `${month}-01`).lte('date', `${month}-31`)),
      fetchAll(() => supabase.from('budget_daily').select('date, rooms_sold, total_revenue').eq('facility', current).eq('version', '当初').gte('date', `${prevMonth}-01`).lte('date', `${prevMonth}-31`)),
      fetchAll(() => supabase.from('mart_occupancy_daily').select('date, occ, rooms_sold').eq('facility', current).gte('date', `${prevMonth}-01`).lte('date', `${prevMonth}-31`)),
    ])
    const r: Record<string, Row> = {}
    for (const d of dates) r[d] = { ...EMPTY }
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
    setRows(r); setPrev(p); setLoading(false)
  }, [current, month, fy, dates])
  useEffect(() => { load() }, [load])

  const setCell = (date: string, k: keyof Row, v: string) => setRows((prevR) => ({ ...prevR, [date]: { ...(prevR[date] ?? EMPTY), [k]: v } }))
  const occOf = (row: Row): number | null => { const rs = num(row.rooms_sold), inv = num(row.inventory); return rs != null && inv ? rs / inv : null }

  // 前年同月をコピー（前年の予算値をこの月の入力に流し込む＝土台。そこから手直し）
  const copyPrevYear = async () => {
    if (!current || !month) return
    const prevMonth = shiftYear(`${month}-01`, -1).slice(0, 7)
    const pb = await fetchAll(() => supabase.from('budget_daily').select('date, inventory, rooms_sold, room_unit, guests, guest_unit, total_revenue, event_note').eq('facility', current).eq('version', '当初').gte('date', `${prevMonth}-01`).lte('date', `${prevMonth}-31`))
    const byDate: Record<string, any> = {}
    ;((pb as any[]) ?? []).forEach((x) => { byDate[shiftYear(String(x.date), 1)] = x })
    setRows((prevR) => {
      const r = { ...prevR }
      for (const d of dates) {
        const src = byDate[d]
        if (!src) continue
        r[d] = {
          inventory: src.inventory == null ? '' : String(src.inventory),
          rooms_sold: src.rooms_sold == null ? '' : String(src.rooms_sold),
          room_unit: src.room_unit == null ? '' : String(src.room_unit),
          guests: src.guests == null ? '' : String(src.guests),
          guest_unit: src.guest_unit == null ? '' : String(src.guest_unit),
          total_revenue: src.total_revenue == null ? '' : String(src.total_revenue),
          event_note: src.event_note ?? '',
        }
      }
      return r
    })
    toast('前年同月の予算をコピーしました（手直ししてから保存してください）', 'success')
  }

  // 売上予算を「室数×ADR」で一括補充（空欄のみ）
  const fillRevenue = () => setRows((prevR) => {
    const r = { ...prevR }
    for (const d of dates) {
      const row = r[d] ?? EMPTY
      if (row.total_revenue.trim() !== '') continue
      const rs = num(row.rooms_sold), ad = num(row.room_unit)
      if (rs != null && ad != null) r[d] = { ...row, total_revenue: String(Math.round(rs * ad)) }
    }
    return r
  })

  const save = async () => {
    if (!current || !month || fy == null) return
    setSaving(true)
    const payload = dates.map((d) => {
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
    toast(error ? `エラー: ${error.message}` : `${month} の日別予算を保存しました（${payload.length}日）`, error ? 'error' : 'success')
    setSaving(false)
  }

  // 月合計
  const totals = useMemo(() => {
    let rooms = 0, rev = 0, inv = 0
    for (const d of dates) { const r = rows[d] ?? EMPTY; rooms += num(r.rooms_sold) ?? 0; rev += num(r.total_revenue) ?? 0; inv += num(r.inventory) ?? 0 }
    return { rooms, rev, occ: inv ? rooms / inv : null }
  }, [rows, dates])

  if (!current) return <div className="p-6 text-sm" style={{ color: 'var(--text-dim)' }}>宿を選択してください。</div>

  const inputCls = 'field px-1.5 py-1 text-xs text-right w-full'
  return (
    <div className="p-6">
      <div className="flex items-center gap-2 flex-wrap mb-3">
        <span className="text-xs" style={{ color: 'var(--text-dim)' }}>年度</span>
        <select className="field px-3 py-1.5 text-sm" value={fy ?? ''} onChange={(e) => setFy(Number(e.target.value))}>
          {fyList.map((y) => <option key={y} value={y}>{y}年度</option>)}
        </select>
        {months.length > 0 && (
          <select className="field px-3 py-1.5 text-sm" value={month} onChange={(e) => setMonth(e.target.value)}>
            {months.map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
        )}
        <button onClick={copyPrevYear} className="text-xs px-3 py-1.5 rounded-md" style={{ background: 'var(--surface2)', color: 'var(--text)' }}>前年同月をコピー</button>
        <button onClick={fillRevenue} className="text-xs px-3 py-1.5 rounded-md" style={{ background: 'var(--surface2)', color: 'var(--text)' }}>売上=室数×ADRで補充</button>
        <button onClick={save} disabled={saving} className="ml-auto px-4 py-1.5 rounded-md text-sm text-white disabled:opacity-50" style={{ background: 'var(--accent)' }}>{saving ? '保存中…' : '保存'}</button>
      </div>
      <p className="text-[11px] mb-2" style={{ color: 'var(--text-dim)' }}>
        支配人が繁閑・イベント・戦略を考えて日別に置きます（灯は自動配分しません）。前年は参考です（コピーはしません）。作った後に灯がレビューします。総客室数={totalRooms ?? '—'}。
      </p>

      {loading ? <Loading /> : (
        <div className="card overflow-auto" style={{ maxHeight: 'calc(100vh - 220px)' }}>
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
              {dates.map((d) => {
                const row = rows[d] ?? EMPTY
                const wd = WD[new Date(d).getDay()]
                const isWeekend = wd === '土' || wd === '日'
                const p = prev[d]
                return (
                  <tr key={d} style={{ borderTop: '1px solid var(--border)' }}>
                    <td className="px-2 py-1 whitespace-nowrap sticky left-0 z-10" style={{ background: 'var(--surface)', color: isWeekend ? 'var(--red)' : undefined }}>
                      {d.slice(8)}（{wd}）
                    </td>
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
            </tbody>
            <tfoot>
              <tr style={{ borderTop: '2px solid var(--border)', background: 'var(--surface2)' }} className="font-semibold">
                <td className="px-2 py-1.5 sticky left-0 z-10" style={{ background: 'var(--surface2)' }}>月合計</td>
                <td></td>
                <td className="px-2 py-1.5 text-right">{fmtNum(totals.rooms)}</td>
                <td className="px-2 py-1.5 text-right">{pct(totals.occ)}</td>
                <td colSpan={3}></td>
                <td className="px-2 py-1.5 text-right">{fmtNum(totals.rev)}</td>
                <td colSpan={3}></td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </div>
  )
}
