'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useFacility } from '@/lib/facility-context'
import { fmtNum, fmtYen } from '@/lib/ui'
import { Loading, Empty } from '@/components/page-bits'
import {
  loadMasters, loadStaff, loadShiftMonth,
  saveShiftCell, deleteShiftCell, savePlanContext, saveSegments,
  createSpotStaff, saveSpotActual, deleteSpotActual,
  patternMinutes, segMinutes,
  type Role, type ShiftPattern, type StaffLite, type PlanContext, type ShiftSegment,
} from '@/lib/shift/data'

/* eslint-disable @typescript-eslint/no-explicit-any */
type Cell = { patternId: number | null; minutes: number; shiftId?: number }
const WD = ['日', '月', '火', '水', '木', '金', '土']
const ck = (staff: string, date: string) => `${staff}|${date}`

function daysOfMonth(month: string): { date: string; day: number; wd: number }[] {
  if (!month) return []
  const y = +month.slice(0, 4), m = +month.slice(5, 7)
  const n = new Date(y, m, 0).getDate()
  const out = []
  for (let d = 1; d <= n; d++) out.push({ date: `${month}-${String(d).padStart(2, '0')}`, day: d, wd: new Date(y, m - 1, d).getDay() })
  return out
}
const prevMonthStr = (month: string) => {
  const y = +month.slice(0, 4), m = +month.slice(5, 7)
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`
}
const hoursStr = (min: number) => (min > 0 ? (min / 60).toFixed(1) : '')

export default function ShiftPage() {
  const { current, currentFacility } = useFacility()
  const [month, setMonth] = useState(() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}` })
  const [roles, setRoles] = useState<Role[]>([])
  const [patterns, setPatterns] = useState<ShiftPattern[]>([])
  const [staff, setStaff] = useState<StaffLite[]>([])
  const [cells, setCells] = useState<Record<string, Cell>>({})
  const [segByShift, setSegByShift] = useState<Record<number, ShiftSegment[]>>({})
  const [ctx, setCtx] = useState<Record<string, PlanContext>>({})
  const [dirtyCells, setDirtyCells] = useState<Set<string>>(new Set())
  const [dirtyCtx, setDirtyCtx] = useState<Set<string>>(new Set())
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState('')
  // 選択・コピペ
  const [sel, setSel] = useState<Set<string>>(new Set())
  const [selRect, setSelRect] = useState<{ rs: number; re: number; ds: number; de: number } | null>(null)
  const [copyBuf, setCopyBuf] = useState<{ rows: number; cols: number; grid: Cell[][] } | null>(null)
  const anchorRef = useRef<{ r: number; d: number } | null>(null)
  // モーダル
  const [segEdit, setSegEdit] = useState<{ staff: string; date: string; shiftId: number } | null>(null)
  const [segDraft, setSegDraft] = useState<ShiftSegment[]>([])
  const [spotOpen, setSpotOpen] = useState(false)
  const [spotName, setSpotName] = useState(''); const [spotWage, setSpotWage] = useState<number | ''>('')

  const days = useMemo(() => daysOfMonth(month), [month])
  const patMap = useMemo(() => { const o: Record<number, ShiftPattern> = {}; patterns.forEach((p) => { o[p.pattern_id] = p }); return o }, [patterns])
  const staffMap = useMemo(() => { const o: Record<string, StaffLite> = {}; staff.forEach((s) => { o[s.staff_code] = s }); return o }, [staff])
  const dayIdx = useMemo(() => { const o: Record<string, number> = {}; days.forEach((d, i) => { o[d.date] = i }); return o }, [days])

  const reload = useCallback(async () => {
    if (!current || !month) return
    setLoading(true); setMsg('')
    const [{ roles, patterns }, st, mo] = await Promise.all([
      loadMasters(current), loadStaff(current), loadShiftMonth(current, month),
    ])
    setRoles(roles); setPatterns(patterns); setStaff(st)
    const c: Record<string, Cell> = {}
    mo.plans.forEach((p) => { c[ck(p.staff_code, p.work_date)] = { patternId: p.pattern_id, minutes: p.planned_minutes, shiftId: p.shift_id } })
    setCells(c)
    const sb: Record<number, ShiftSegment[]> = {}
    mo.segments.forEach((s) => { if (s.shift_id != null) (sb[s.shift_id] ??= []).push(s) })
    setSegByShift(sb)
    const cx: Record<string, PlanContext> = {}
    mo.context.forEach((r) => { cx[r.work_date] = r }); setCtx(cx)
    setDirtyCells(new Set()); setDirtyCtx(new Set()); setSel(new Set())
    setLoading(false)
  }, [current, month])
  useEffect(() => { reload() }, [reload])

  const setCell = (staff: string, date: string, patch: Partial<Cell>) => {
    const key = ck(staff, date)
    setCells((prev) => { const base: Cell = prev[key] ?? { patternId: null, minutes: 0 }; return { ...prev, [key]: { ...base, ...patch } } })
    setDirtyCells((prev) => new Set(prev).add(key))
  }
  const onPattern = (staff: string, date: string, pid: string) => {
    if (!pid) { setCell(staff, date, { patternId: null, minutes: 0 }); return }
    const p = patMap[+pid]
    setCell(staff, date, { patternId: p.pattern_id, minutes: p.pattern_type === '勤務' ? patternMinutes(p) : 0 })
  }
  const onHours = (staff: string, date: string, v: string, patternId: number | null) => {
    const min = v === '' ? 0 : Math.round(Number(v) * 60)
    setCell(staff, date, { patternId, minutes: isNaN(min) ? 0 : min })
  }
  const setCtxField = (date: string, patch: Partial<PlanContext>) => {
    setCtx((prev) => ({ ...prev, [date]: { ...(prev[date] ?? { facility: current, work_date: date }), ...patch } }))
    setDirtyCtx((prev) => new Set(prev).add(date))
  }

  // ---- 選択・コピペ（T10）----
  const selectRect = (r2: number, d2: number, extend: boolean) => {
    const a = anchorRef.current
    if (!extend || !a) { anchorRef.current = { r: r2, d: d2 }; setSel(new Set()); setSelRect(null); return }
    const rs = Math.min(a.r, r2), re = Math.max(a.r, r2), ds = Math.min(a.d, d2), de = Math.max(a.d, d2)
    const s = new Set<string>()
    for (let r = rs; r <= re; r++) for (let d = ds; d <= de; d++) s.add(ck(staff[r].staff_code, days[d].date))
    setSel(s); setSelRect({ rs, re, ds, de })
  }
  // ブロックコピー: 範囲があればその矩形を、無ければアンカー1セルを取り込む
  const doCopy = useCallback(() => {
    const get = (r: number, d: number): Cell => { const c = cells[ck(staff[r].staff_code, days[d].date)]; return c ? { patternId: c.patternId, minutes: c.minutes } : { patternId: null, minutes: 0 } }
    if (selRect) {
      const { rs, re, ds, de } = selRect
      const grid: Cell[][] = []
      for (let r = rs; r <= re; r++) { const row: Cell[] = []; for (let d = ds; d <= de; d++) row.push(get(r, d)); grid.push(row) }
      setCopyBuf({ rows: re - rs + 1, cols: de - ds + 1, grid })
      setMsg(`コピーしました（${grid.length}人 × ${grid[0].length}日）。貼付先の左上をクリック→貼付`)
    } else if (anchorRef.current) {
      const a = anchorRef.current
      setCopyBuf({ rows: 1, cols: 1, grid: [[get(a.r, a.d)]] })
      setMsg('コピーしました（貼付先を選択して貼付）')
    }
  }, [cells, staff, days, selRect])
  const doPaste = useCallback(() => {
    if (!copyBuf) return
    // 単一セル×範囲選択 = 塗りつぶし（従来動作を維持）
    if (copyBuf.rows === 1 && copyBuf.cols === 1 && sel.size) {
      const one = copyBuf.grid[0][0]
      setCells((prev) => { const n = { ...prev }; sel.forEach((k) => { n[k] = { ...n[k], patternId: one.patternId, minutes: one.minutes } }); return n })
      setDirtyCells((prev) => { const n = new Set(prev); sel.forEach((k) => n.add(k)); return n })
      setMsg(`貼付しました（${sel.size}セル）`); return
    }
    // ブロック貼付: アンカー（左上）から形を保って配置
    const a = anchorRef.current; if (!a) { setMsg('貼付先のセルをクリックしてください'); return }
    const keys: string[] = []
    setCells((prev) => {
      const n = { ...prev }
      for (let i = 0; i < copyBuf.rows; i++) for (let j = 0; j < copyBuf.cols; j++) {
        const r = a.r + i, d = a.d + j
        if (r < staff.length && d < days.length) { const k = ck(staff[r].staff_code, days[d].date); n[k] = { ...n[k], ...copyBuf.grid[i][j] }; keys.push(k) }
      }
      return n
    })
    setDirtyCells((prev) => { const n = new Set(prev); keys.forEach((k) => n.add(k)); return n })
    setMsg(`貼付しました（${copyBuf.rows}人 × ${copyBuf.cols}日）`)
  }, [copyBuf, sel, staff, days])

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { setSel(new Set()); return }
      const mod = e.ctrlKey || e.metaKey
      if (!mod) return
      const el = document.activeElement as HTMLElement | null
      const editingText = el && el.tagName === 'INPUT' && (el as HTMLInputElement).type === 'text'
      if (editingText) return
      if (e.key === 'c') { if (sel.size || anchorRef.current) { doCopy() } }
      else if (e.key === 'v') { if (copyBuf) { e.preventDefault(); doPaste() } }
    }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [doCopy, doPaste, sel, copyBuf])

  // ---- 前月コピー（曜日合わせ・T09）----
  const copyPrevMonth = async () => {
    if (!confirm('前月のシフトを同一曜日に複製します（当月の入力は上書きされます）。よろしいですか？')) return
    setSaving(true); setMsg('')
    try {
      const prev = prevMonthStr(month)
      const mo = await loadShiftMonth(current, prev)
      // 当月の (曜日, n回目) → 日付
      const cur: Record<string, string> = {}; const cnt: Record<number, number> = {}
      for (const d of days) { const n = (cnt[d.wd] = (cnt[d.wd] ?? 0) + 1); cur[`${d.wd}-${n}`] = d.date }
      // 前月の各計画を (曜日, n回目) に変換して当月へ
      const pdays = daysOfMonth(prev); const pcnt: Record<number, number> = {}; const pkey: Record<string, string> = {}
      for (const d of pdays) { const n = (pcnt[d.wd] = (pcnt[d.wd] ?? 0) + 1); pkey[d.date] = `${d.wd}-${n}` }
      const nextCells = { ...cells }; const nextDirty = new Set(dirtyCells)
      // 対象従業員（当月に居る人）のみ
      const staffSet = new Set(staff.map((s) => s.staff_code))
      for (const p of mo.plans) {
        if (!staffSet.has(p.staff_code)) continue
        const tgt = cur[pkey[p.work_date]]; if (!tgt) continue
        const key = ck(p.staff_code, tgt)
        nextCells[key] = { patternId: p.pattern_id, minutes: p.planned_minutes, shiftId: nextCells[key]?.shiftId }
        nextDirty.add(key)
      }
      setCells(nextCells); setDirtyCells(nextDirty)
      setMsg(`前月から複製しました（保存で確定）。元計画${mo.plans.length}件を反映`)
    } catch (e: any) { setMsg('Error: ' + (e?.message ?? String(e))) }
    finally { setSaving(false) }
  }

  // ---- 役割分割エディタ（T08）----
  const openSegEditor = async (staffCode: string, date: string) => {
    const key = ck(staffCode, date); const c = cells[key]
    if (!c || c.patternId == null || patMap[c.patternId]?.pattern_type !== '勤務') return
    let shiftId = c.shiftId
    if (shiftId == null || dirtyCells.has(key)) {
      // 未保存セルは先に保存して shift_id を確定
      shiftId = (await saveShiftCell({ staff_code: staffCode, work_facility: current, work_date: date, pattern_id: c.patternId, planned_minutes: c.minutes })) ?? undefined
      if (shiftId == null) { setMsg('Error: シフト行の保存に失敗しました'); return }
      setCell(staffCode, date, { shiftId })
      setDirtyCells((prev) => { const n = new Set(prev); n.delete(key); return n })
    }
    const existing = segByShift[shiftId] ?? []
    const p = patMap[c.patternId]
    setSegDraft(existing.length ? existing.map((s) => ({ ...s })) : [{
      seq: 1, role_id: roles[0]?.role_id ?? 0,
      start_time: (p.start_time ?? '09:00').slice(0, 5), end_time: (p.end_time ?? '17:00').slice(0, 5),
      break_minutes: p.break_minutes ?? 0, work_minutes: c.minutes,
    }])
    setSegEdit({ staff: staffCode, date, shiftId })
  }
  const segRow = (i: number, patch: Partial<ShiftSegment>) => setSegDraft((prev) => prev.map((s, idx) => {
    if (idx !== i) return s
    const n = { ...s, ...patch }
    n.work_minutes = segMinutes(n.start_time, n.end_time, n.break_minutes || 0)
    return n
  }))
  const saveSegEditor = async () => {
    if (!segEdit) return
    setSaving(true)
    try {
      const segs = segDraft.map((s, i) => ({ ...s, seq: i + 1 }))
      await saveSegments(segEdit.shiftId, segs)
      const total = segs.reduce((a, s) => a + (s.work_minutes || 0), 0)
      setSegByShift((prev) => ({ ...prev, [segEdit.shiftId]: segs }))
      setCells((prev) => ({ ...prev, [ck(segEdit.staff, segEdit.date)]: { ...prev[ck(segEdit.staff, segEdit.date)], minutes: total } }))
      setSegEdit(null); setMsg(`役割分割を保存（合計${(total / 60).toFixed(1)}h）`)
    } catch (e: any) { setMsg('Error: ' + (e?.message ?? String(e))) }
    finally { setSaving(false) }
  }

  // ---- スポット追加（T11）----
  const addSpot = async () => {
    if (!spotName || spotWage === '') { setMsg('氏名と時給を入力してください'); return }
    setSaving(true)
    try {
      await createSpotStaff(current, spotName, Number(spotWage))
      setSpotOpen(false); setSpotName(''); setSpotWage('')
      await reload(); setMsg('スポット要員を追加しました')
    } catch (e: any) { setMsg('Error: ' + (e?.message ?? String(e))) }
    finally { setSaving(false) }
  }

  // ---- 集計 ----
  const rowAgg = useCallback((sc: string) => {
    let min = 0, off = 0
    for (const d of days) { const c = cells[ck(sc, d.date)]; if (!c || c.patternId == null) continue; const p = patMap[c.patternId]; if (p?.pattern_type === '休日') off += 1; else min += c.minutes }
    return { hours: min / 60, off }
  }, [cells, days, patMap])
  const dayTotal = (date: string) => { let min = 0; for (const s of staff) { const c = cells[ck(s.staff_code, date)]; if (c && c.patternId != null && patMap[c.patternId]?.pattern_type !== '休日') min += c.minutes } return min / 60 }
  const summary = useMemo(() => {
    let totalH = 0, totalCost = 0, spotH = 0
    for (const s of staff) {
      const { hours } = rowAgg(s.staff_code); totalH += hours
      if (s.is_spot) spotH += hours
      if (s.wage_type === '月給' && s.monthly_salary && s.contracted_monthly_hours) {
        const ot = Math.max(0, hours - s.contracted_monthly_hours - (s.deemed_ot_hours ?? 0))
        totalCost += s.monthly_salary + Math.round(ot * (s.monthly_salary / s.contracted_monthly_hours) * 1.25)
      } else if (s.hourly_wage) totalCost += Math.round(hours * s.hourly_wage)
    }
    return { totalH, totalCost, spotH }
  }, [staff, rowAgg])

  const dirtyCount = dirtyCells.size + dirtyCtx.size
  const save = async () => {
    setSaving(true); setMsg('')
    try {
      for (const key of dirtyCells) {
        const [sc, date] = key.split('|'); const c = cells[key]; const isSpot = !!staffMap[sc]?.is_spot
        if (!c || c.patternId == null) { await deleteShiftCell(sc, current, date); if (isSpot) await deleteSpotActual(sc, current, date) }
        else { await saveShiftCell({ staff_code: sc, work_facility: current, work_date: date, pattern_id: c.patternId, planned_minutes: c.minutes }); if (isSpot) await saveSpotActual(sc, current, date, c.minutes) }
      }
      for (const date of dirtyCtx) { const r = ctx[date]; await savePlanContext(current, date, { onhand_rooms: r?.onhand_rooms ?? null, forecast_rooms: r?.forecast_rooms ?? null, memo: r?.memo ?? null }) }
      const nc = dirtyCells.size, nx = dirtyCtx.size
      await reload(); setMsg(`保存しました（シフト${nc}件・稼働前提${nx}件）`)
    } catch (e: any) { setMsg('Error: ' + (e?.message ?? String(e))) }
    finally { setSaving(false) }
  }

  const patOptions = useMemo(() => ({ work: patterns.filter((p) => p.pattern_type === '勤務'), off: patterns.filter((p) => p.pattern_type === '休日') }), [patterns])
  const wdColor = (wd: number) => (wd === 0 ? 'var(--red)' : wd === 6 ? 'var(--accent)' : 'var(--text-dim)')
  const btnGhost = 'px-3 py-1.5 text-xs rounded-md hover:opacity-80'

  return (
    <div className="p-6">
      <div className="flex items-end justify-between mb-4 flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold mb-1">シフト・労務</h1>
          <p className="text-sm" style={{ color: 'var(--text-dim)' }}>{currentFacility?.name ?? current}</p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <input type="month" className="field px-3 py-1.5 text-sm" value={month} onChange={(e) => setMonth(e.target.value)} />
          <button onClick={copyPrevMonth} disabled={saving} className={btnGhost} style={{ border: '1px solid var(--border)', color: 'var(--text-dim)' }}>前月コピー</button>
          <button onClick={() => setSpotOpen(true)} className={btnGhost} style={{ border: '1px solid var(--border)', color: 'var(--text-dim)' }}>スポット追加</button>
          {copyBuf && <button onClick={doPaste} className={btnGhost} style={{ border: '1px solid var(--accent)', color: 'var(--accent)' }}>貼付（{copyBuf.rows === 1 && copyBuf.cols === 1 && sel.size ? `${sel.size}セル` : `${copyBuf.rows}×${copyBuf.cols}`}）</button>}
          <button onClick={doCopy} className={btnGhost} style={{ border: '1px solid var(--border)', color: 'var(--text-dim)' }}>コピー</button>
          <button onClick={save} disabled={saving || dirtyCount === 0} className="px-4 py-1.5 text-sm rounded-md text-white hover:opacity-90 disabled:opacity-40" style={{ background: 'var(--accent)' }}>
            {saving ? '保存中...' : dirtyCount > 0 ? `保存（${dirtyCount}）` : '保存'}
          </button>
        </div>
      </div>

      {loading ? <Loading /> : staff.length === 0 ? (
        <Empty message="この施設に従業員がいません。勤怠CSVを取り込むか、スポット追加で登録してください。" />
      ) : (
        <>
          {/* 稼働前提・メモ */}
          <details className="card mb-4" style={{ padding: '8px 12px' }} open>
            <summary className="text-sm font-semibold cursor-pointer" style={{ color: 'var(--text-dim)' }}>稼働前提・メモ</summary>
            <div className="overflow-x-auto mt-2">
              <table className="text-xs border-separate" style={{ borderSpacing: 0 }}>
                <thead>
                  <tr>
                    <th className="px-2 py-1 sticky left-0" style={{ minWidth: 132, background: 'var(--surface)' }} />
                    {days.map((d) => (
                      <th key={d.date} className="px-1 py-1 text-center" style={{ minWidth: 52, color: 'var(--text-dim)' }}>
                        <div>{d.day}</div>
                        <div style={{ fontSize: 10, color: wdColor(d.wd) }}>{WD[d.wd]}</div>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {([['予算 稼働室/人数', 'budget'], ['オンハンド販売室数', 'onhand'], ['予測販売室数', 'forecast'], ['メモ', 'memo']] as const).map(([label, kind]) => (
                    <tr key={kind}>
                      <td className="px-2 py-1 whitespace-nowrap sticky left-0" style={{ minWidth: 132, background: 'var(--surface)', color: 'var(--text-dim)', borderTop: '1px solid var(--border)' }}>{label}</td>
                      {days.map((d) => { const r = ctx[d.date]; return (
                        <td key={d.date} className="px-1 py-1 text-center" style={{ minWidth: 52, borderTop: '1px solid var(--border)' }}>
                          {kind === 'budget' ? (<div>{r?.budget_rooms ?? '-'}<div style={{ fontSize: 10, color: 'var(--text-dim)' }}>{r?.budget_guests ?? ''}</div></div>)
                          : kind === 'memo' ? (<input className="field text-center" style={{ width: 46, fontSize: 10, padding: 2 }} title={r?.memo ?? ''} value={r?.memo ?? ''} onChange={(e) => setCtxField(d.date, { memo: e.target.value })} />)
                          : (<input type="number" min={0} className="field text-center" style={{ width: 40, fontSize: 11, padding: 2 }} value={(kind === 'onhand' ? r?.onhand_rooms : r?.forecast_rooms) ?? ''} onChange={(e) => setCtxField(d.date, kind === 'onhand' ? { onhand_rooms: e.target.value === '' ? null : Number(e.target.value) } : { forecast_rooms: e.target.value === '' ? null : Number(e.target.value) })} />)}
                        </td>) })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>

          {/* 月グリッド */}
          <div className="card overflow-auto" style={{ maxHeight: 'calc(100vh - 280px)' }}>
            <table className="text-xs border-separate" style={{ borderSpacing: 0 }}>
              <thead>
                <tr>
                  <th className="px-2 h-12 text-left whitespace-nowrap sticky left-0 top-0 z-30" style={{ minWidth: 150, background: 'var(--surface2)', borderRight: '2px solid var(--border)' }}>氏名</th>
                  {days.map((d) => (<th key={d.date} className="px-1 h-12 text-center whitespace-nowrap sticky top-0 z-20" style={{ minWidth: 58, background: 'var(--surface2)' }}><div>{d.day}</div><div style={{ fontSize: 10, color: wdColor(d.wd) }}>{WD[d.wd]}</div></th>))}
                  <th className="px-1 h-12 text-center sticky top-0 z-20" style={{ minWidth: 52, background: 'var(--surface)', borderLeft: '2px solid var(--border)' }}>時間計</th>
                  <th className="px-1 h-12 text-center sticky top-0 z-20" style={{ minWidth: 40, background: 'var(--surface)' }}>休日</th>
                </tr>
              </thead>
              <tbody>
                {staff.map((s, ri) => {
                  const agg = rowAgg(s.staff_code); const tag = s.is_spot ? 'スポット' : (s.wage_type || '未設定')
                  return (
                    <tr key={s.staff_code} style={s.is_spot ? { borderTop: '1px dashed var(--border)' } : undefined}>
                      <td className="px-2 h-10 whitespace-nowrap sticky left-0 z-10" style={{ background: 'var(--surface)', borderTop: '1px solid var(--border)', borderRight: '2px solid var(--border)' }}>
                        {s.name ?? s.staff_code}
                        <span className="ml-1 text-[9px] px-1 py-0.5 rounded" style={{ background: s.is_spot ? 'var(--green)' : 'var(--surface2)', color: s.is_spot ? '#fff' : 'var(--text-dim)' }}>{tag}</span>
                      </td>
                      {days.map((d, di) => {
                        const c = cells[ck(s.staff_code, d.date)]; const p = c?.patternId != null ? patMap[c.patternId] : null
                        const isWork = p?.pattern_type === '勤務'; const selected = sel.has(ck(s.staff_code, d.date))
                        const hasSeg = c?.shiftId != null && (segByShift[c.shiftId]?.length ?? 0) > 1
                        return (
                          <td key={d.date} className="px-0.5 h-10" title={isWork ? 'ダブルクリックで役割分割' : undefined}
                            onMouseDown={(e) => { if (e.shiftKey) { e.preventDefault(); selectRect(ri, di, true) } }}
                            onDoubleClick={() => isWork && openSegEditor(s.staff_code, d.date)}
                            style={{ borderTop: '1px solid var(--border)', background: p?.color ? `${p.color}22` : undefined, boxShadow: selected ? 'inset 0 0 0 2px var(--accent)' : undefined }}>
                            <select className="w-full text-[10px] rounded" style={{ background: 'transparent', border: '1px solid var(--border)', color: p?.color || 'var(--text)' }}
                              value={c?.patternId ?? ''} onFocus={() => { anchorRef.current = { r: ri, d: di } }} onChange={(e) => onPattern(s.staff_code, d.date, e.target.value)}>
                              <option value="">－</option>
                              {patOptions.work.map((pt) => <option key={pt.pattern_id} value={pt.pattern_id}>{pt.name}</option>)}
                              {patOptions.off.map((pt) => <option key={pt.pattern_id} value={pt.pattern_id}>{pt.name}</option>)}
                            </select>
                            <input className="w-full text-[10px] text-center rounded mt-0.5" style={{ background: hasSeg ? 'var(--surface2)' : 'transparent', border: '1px solid var(--border)' }}
                              value={isWork ? hoursStr(c!.minutes) : ''} disabled={!isWork} title={hasSeg ? '役割分割あり' : undefined}
                              onFocus={() => { anchorRef.current = { r: ri, d: di } }} onChange={(e) => onHours(s.staff_code, d.date, e.target.value, c?.patternId ?? null)} />
                          </td>
                        )
                      })}
                      <td className="px-1 h-10 text-center font-medium" style={{ background: 'var(--surface)', borderLeft: '2px solid var(--border)', borderTop: '1px solid var(--border)' }}>{agg.hours.toFixed(1)}</td>
                      <td className="px-1 h-10 text-center" style={{ background: 'var(--surface)', borderTop: '1px solid var(--border)', color: 'var(--text-dim)' }}>{agg.off}</td>
                    </tr>
                  )
                })}
                <tr>
                  <td className="px-2 h-9 text-right whitespace-nowrap sticky left-0 z-10 font-semibold" style={{ background: 'var(--surface2)', borderTop: '2px solid var(--border)', borderRight: '2px solid var(--border)', color: 'var(--text-dim)' }}>日別 予定合計</td>
                  {days.map((d) => <td key={d.date} className="px-1 h-9 text-center" style={{ background: 'var(--surface2)', borderTop: '2px solid var(--border)' }}>{dayTotal(d.date).toFixed(1)}</td>)}
                  <td style={{ background: 'var(--surface2)', borderTop: '2px solid var(--border)', borderLeft: '2px solid var(--border)' }} /><td style={{ background: 'var(--surface2)', borderTop: '2px solid var(--border)' }} />
                </tr>
              </tbody>
            </table>
          </div>

          <div className="grid grid-cols-3 gap-3 mt-4">
            <div className="card p-4"><div className="text-xs" style={{ color: 'var(--text-dim)' }}>月次 労働時間 合計</div><div className="text-xl font-bold">{fmtNum(summary.totalH)} h</div></div>
            <div className="card p-4"><div className="text-xs" style={{ color: 'var(--text-dim)' }}>月次 人件費 合計（計画）</div><div className="text-xl font-bold">{staff.some((s) => s.wage_type != null || s.hourly_wage != null || s.monthly_salary != null) ? fmtYen(summary.totalCost) : '-'}</div>{!staff.some((s) => s.wage_type != null || s.hourly_wage != null || s.monthly_salary != null) && <div className="text-[10px] mt-0.5" style={{ color: 'var(--text-dim)' }}>給与閲覧権限または賃金設定が必要</div>}</div>
            <div className="card p-4"><div className="text-xs" style={{ color: 'var(--text-dim)' }}>うち 派遣・その他 時間</div><div className="text-xl font-bold">{fmtNum(summary.spotH)} h</div></div>
          </div>

          {msg && <p className="text-sm mt-3" style={{ color: msg.startsWith('Error') ? 'var(--red)' : 'var(--green)' }}>{msg}</p>}
          <p className="text-xs mt-2" style={{ color: 'var(--text-dim)' }}>
            セル=パターン選択＋時間手修正。<b>Shift+クリックで範囲選択→コピー</b>し、<b>貼付先の左上をクリック→貼付</b>で形のまま複製（⌘/Ctrl+C・V可。単一セルは範囲選択に塗りつぶし）。<b>勤務セルをダブルクリックで役割分割</b>。
            スポットの実働は保存時に実績(raw_attendance_daily/manual)へ記録され総労働時間・KPIに反映。人件費は計画ベースの月次合計のみ表示。
          </p>
        </>
      )}

      {/* 役割分割モーダル（T08） */}
      {segEdit && (
        <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ background: 'rgba(0,0,0,0.5)' }} onClick={() => setSegEdit(null)}>
          <div className="card p-5 w-[560px] max-w-[92vw]" style={{ background: 'var(--surface)' }} onClick={(e) => e.stopPropagation()}>
            <h3 className="text-base font-semibold mb-1">役割分割 — {staffMap[segEdit.staff]?.name ?? segEdit.staff}・{segEdit.date}</h3>
            <p className="text-xs mb-3" style={{ color: 'var(--text-dim)' }}>時間帯×役割に分割。合計がその日の予定実働になります。</p>
            <table className="w-full text-xs mb-3">
              <thead><tr style={{ color: 'var(--text-dim)' }}><th className="text-left py-1">役割</th><th>開始</th><th>終了</th><th>休憩(分)</th><th>実働</th><th></th></tr></thead>
              <tbody>
                {segDraft.map((s, i) => (
                  <tr key={i}>
                    <td className="py-1"><select className="field px-2 py-1 text-xs w-32" value={s.role_id} onChange={(e) => segRow(i, { role_id: Number(e.target.value) })}>{roles.map((r) => <option key={r.role_id} value={r.role_id}>{r.role_name}</option>)}</select></td>
                    <td className="text-center"><input type="time" className="field px-1 py-1 text-xs" value={s.start_time} onChange={(e) => segRow(i, { start_time: e.target.value })} /></td>
                    <td className="text-center"><input type="time" className="field px-1 py-1 text-xs" value={s.end_time} onChange={(e) => segRow(i, { end_time: e.target.value })} /></td>
                    <td className="text-center"><input type="number" min={0} className="field px-1 py-1 text-xs w-14 text-right" value={s.break_minutes} onChange={(e) => segRow(i, { break_minutes: Number(e.target.value) })} /></td>
                    <td className="text-center">{(s.work_minutes / 60).toFixed(1)}h</td>
                    <td className="text-center"><button onClick={() => setSegDraft((prev) => prev.filter((_, idx) => idx !== i))} style={{ color: 'var(--red)' }}>×</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="flex items-center justify-between">
              <button className="text-xs px-3 py-1.5 rounded-md" style={{ border: '1px solid var(--border)' }}
                onClick={() => setSegDraft((prev) => [...prev, { seq: prev.length + 1, role_id: roles[0]?.role_id ?? 0, start_time: '09:00', end_time: '17:00', break_minutes: 60, work_minutes: segMinutes('09:00', '17:00', 60) }])}>＋ 行を追加</button>
              <div className="text-sm">合計 <b>{(segDraft.reduce((a, s) => a + s.work_minutes, 0) / 60).toFixed(1)}h</b></div>
              <div className="flex gap-2">
                <button className="text-sm px-3 py-1.5 rounded-md" style={{ border: '1px solid var(--border)' }} onClick={() => setSegEdit(null)}>キャンセル</button>
                <button className="text-sm px-4 py-1.5 rounded-md text-white" style={{ background: 'var(--accent)' }} onClick={saveSegEditor} disabled={saving}>保存</button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* スポット追加モーダル（T11） */}
      {spotOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ background: 'rgba(0,0,0,0.5)' }} onClick={() => setSpotOpen(false)}>
          <div className="card p-5 w-[380px] max-w-[92vw]" style={{ background: 'var(--surface)' }} onClick={(e) => e.stopPropagation()}>
            <h3 className="text-base font-semibold mb-3">スポット要員を追加（{currentFacility?.name ?? current}）</h3>
            <label className="block text-xs mb-1" style={{ color: 'var(--text-dim)' }}>氏名 / 表示名</label>
            <input className="field px-3 py-2 text-sm w-full mb-3" value={spotName} onChange={(e) => setSpotName(e.target.value)} placeholder="例: 派遣 山田（タイミー）" />
            <label className="block text-xs mb-1" style={{ color: 'var(--text-dim)' }}>時給（円）</label>
            <input type="number" min={0} className="field px-3 py-2 text-sm w-full mb-4" value={spotWage} onChange={(e) => setSpotWage(e.target.value === '' ? '' : Number(e.target.value))} placeholder="例: 1300" />
            <div className="flex justify-end gap-2">
              <button className="text-sm px-3 py-1.5 rounded-md" style={{ border: '1px solid var(--border)' }} onClick={() => setSpotOpen(false)}>キャンセル</button>
              <button className="text-sm px-4 py-1.5 rounded-md text-white" style={{ background: 'var(--accent)' }} onClick={addSpot} disabled={saving}>追加</button>
            </div>
            <p className="text-[11px] mt-3" style={{ color: 'var(--text-dim)' }}>追加後、グリッドに行が現れます。実働時間を入力→保存で実績に記録されKPIへ反映します。</p>
          </div>
        </div>
      )}
    </div>
  )
}
