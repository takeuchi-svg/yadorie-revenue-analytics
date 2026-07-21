'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useFacility } from '@/lib/facility-context'
import { fmtNum, fmtYen } from '@/lib/ui'
import { Loading, Empty } from '@/components/page-bits'
import {
  loadMasters, loadStaff, loadShiftMonth, loadLaborRate, loadRegularLabor, loadLaborBudget,
  saveShiftCell, deleteShiftCell, savePlanContext, saveSegments,
  createSpotStaff, saveSpotActual, deleteSpotActual,
  patternMinutes, segMinutes,
  loadPublications, publishShiftPlan,
  type Role, type ShiftPattern, type StaffLite, type PlanContext, type ShiftSegment, type Publication, type SpotWage,
} from '@/lib/shift/data'

/* eslint-disable @typescript-eslint/no-explicit-any */
type Cell = { patternId: number | null; minutes: number; shiftId?: number }
const WD = ['日', '月', '火', '水', '木', '金', '土']
const ck = (staff: string, date: string) => `${staff}|${date}`

// 日本の祝日（2025〜2027・振替/国民の休日含む）。土=青・日/祝=赤の表示用。
const JP_HOLIDAYS = new Set<string>([
  // 2025
  '2025-01-01','2025-01-13','2025-02-11','2025-02-23','2025-02-24','2025-03-20','2025-04-29','2025-05-03','2025-05-04','2025-05-05','2025-05-06','2025-07-21','2025-08-11','2025-09-15','2025-09-23','2025-10-13','2025-11-03','2025-11-23','2025-11-24',
  // 2026
  '2026-01-01','2026-01-12','2026-02-11','2026-02-23','2026-03-20','2026-04-29','2026-05-03','2026-05-04','2026-05-05','2026-05-06','2026-07-20','2026-08-11','2026-09-21','2026-09-22','2026-09-23','2026-10-12','2026-11-03','2026-11-23',
  // 2027
  '2027-01-01','2027-01-11','2027-02-11','2027-02-23','2027-03-21','2027-03-22','2027-04-29','2027-05-03','2027-05-04','2027-05-05','2027-07-19','2027-08-11','2027-09-20','2027-09-23','2027-10-11','2027-11-03','2027-11-23',
])
// 日付ヘッダの色: 日/祝=赤・土=青・平日=淡色
const dateColor = (date: string, wd: number) => (wd === 0 || JP_HOLIDAYS.has(date)) ? 'var(--red)' : wd === 6 ? '#378ADD' : 'var(--text-dim)'

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
  // #4 ペイント方式: パターンを選んでセルをクリック/ドラッグで塗る
  const [paintBrush, setPaintBrush] = useState<number | 'clear' | null>(null)
  const paintingRef = useRef(false)
  // 1日分まるごとコピー（列コピー）
  const [dayBuf, setDayBuf] = useState<Record<string, { patternId: number | null; minutes: number }> | null>(null)
  const [dayBufDate, setDayBufDate] = useState<string>('')
  // #3 ガントのバー端ドラッグ（15分刻み）
  const dragRef = useRef<{ shiftId: number; edge: 'start' | 'end'; rectLeft: number; rectWidth: number; lo: number; hi: number; staff: string; date: string } | null>(null)
  // モーダル
  const [segEdit, setSegEdit] = useState<{ staff: string; date: string; shiftId: number } | null>(null)
  const [segDraft, setSegDraft] = useState<ShiftSegment[]>([])
  const [timeEdit, setTimeEdit] = useState<{ staff: string; date: string; shiftId: number; start: string; end: string; brk: number } | null>(null)  // #3 時間帯ミニ編集(休憩付き)
  const [ganttDate, setGanttDate] = useState<string | null>(null)  // #4 日別ガント
  const [zoom, setZoom] = useState(1)          // 文字サイズ拡大（年長者対策）
  const [fullscreen, setFullscreen] = useState(false)  // 全画面表示（ネイティブfullscreen）
  const fsRef = useRef<HTMLDivElement>(null)
  const [memoPop, setMemoPop] = useState<{ text: string; x: number; y: number } | null>(null)  // メモのホバー表示
  const [spotOpen, setSpotOpen] = useState(false)
  const [spotName, setSpotName] = useState('')
  const [spotWageKind, setSpotWageKind] = useState<'日当' | '時給'>('時給')
  const [spotWageAmount, setSpotWageAmount] = useState<number | ''>('')
  const [spotWageMap, setSpotWageMap] = useState<Record<string, SpotWage>>({})  // スポットの賃金(日当/時給)。計画行に保存し、置いたセルへ反映
  const [laborRate, setLaborRate] = useState<number | null>(null)  // この宿のアルバイト標準時給（人件費モデルv2）
  const [regularCost, setRegularCost] = useState<number | null>(null)  // 正社員固定費（当月・全社設定）
  const [laborBudget, setLaborBudget] = useState<number | null>(null)  // 人件費予算（給料手当＋雑給＋外注人材＋外注清掃）
  const [paperSize, setPaperSize] = useState<'A3' | 'A4'>('A3')  // PDF/印刷の用紙（張り出し=A3横が既定）
  // SV02 公開
  const [pubs, setPubs] = useState<Publication[]>([])
  const [publishing, setPublishing] = useState(false)

  const days = useMemo(() => daysOfMonth(month), [month])
  const patMap = useMemo(() => { const o: Record<number, ShiftPattern> = {}; patterns.forEach((p) => { o[p.pattern_id] = p }); return o }, [patterns])
  const staffMap = useMemo(() => { const o: Record<string, StaffLite> = {}; staff.forEach((s) => { o[s.staff_code] = s }); return o }, [staff])
  const roleMap = useMemo(() => { const o: Record<number, Role> = {}; roles.forEach((r) => { o[r.role_id] = r }); return o }, [roles])
  const dayIdx = useMemo(() => { const o: Record<string, number> = {}; days.forEach((d, i) => { o[d.date] = i }); return o }, [days])

  // 時間帯: 役割分割があればその範囲。無ければ開始(パターン)＋実働＋休憩で終了を算出
  //   → 時間数を直接変えると終了時刻が自動で伸びる（#E）
  const hmMin = (m: number) => { const x = ((m % 1440) + 1440) % 1440; return `${String(Math.floor(x / 60)).padStart(2, '0')}:${String(x % 60).padStart(2, '0')}` }
  const toMinS = (t: string) => (+t.slice(0, 2)) * 60 + (+t.slice(3, 5))
  const cellTimeRange = (c?: Cell): string => {
    if (!c) return ''
    const segs = c.shiftId != null ? segByShift[c.shiftId] : undefined
    if (segs && segs.length) {
      const starts = segs.map((s) => s.start_time.slice(0, 5)).sort()
      const ends = segs.map((s) => s.end_time.slice(0, 5)).sort()
      return `${starts[0]}–${ends[ends.length - 1]}`
    }
    const p = c.patternId != null ? patMap[c.patternId] : null
    if (p?.start_time) { const s = toMinS(p.start_time.slice(0, 5)); return `${hmMin(s)}–${hmMin(s + (c.minutes || 0) + (p.break_minutes || 0))}` }
    return ''
  }
  // セルの休憩（時間）: 役割分割の合計 or パターン既定
  const cellBreakH = (c?: Cell): number => {
    if (!c) return 0
    const segs = c.shiftId != null ? segByShift[c.shiftId] : undefined
    if (segs && segs.length) return segs.reduce((a, s) => a + (s.break_minutes || 0), 0) / 60
    const p = c.patternId != null ? patMap[c.patternId] : null
    return (p?.break_minutes || 0) / 60
  }

  const reload = useCallback(async () => {
    if (!current || !month) return
    setLoading(true); setMsg('')
    const [{ roles, patterns }, st, mo, rate, regList, labBud] = await Promise.all([
      loadMasters(current), loadStaff(current), loadShiftMonth(current, month), loadLaborRate(current),
      loadRegularLabor(current), loadLaborBudget(current, month),
    ])
    setRoles(roles); setPatterns(patterns); setStaff(st); setLaborRate(rate)
    setRegularCost(regList.find((r) => r.month === month)?.amount ?? null)
    setLaborBudget(labBud)
    const c: Record<string, Cell> = {}
    const swm: Record<string, SpotWage> = {}
    mo.plans.forEach((p) => {
      c[ck(p.staff_code, p.work_date)] = { patternId: p.pattern_id, minutes: p.planned_minutes, shiftId: p.shift_id }
      if (p.spot_wage_kind && p.spot_wage_amount != null) swm[p.staff_code] = { kind: p.spot_wage_kind as '日当' | '時給', amount: p.spot_wage_amount }
    })
    setCells(c)
    setSpotWageMap((prev) => ({ ...prev, ...swm }))  // DB由来を優先しつつ、追加直後のセッション値は保持
    const sb: Record<number, ShiftSegment[]> = {}
    mo.segments.forEach((s) => { if (s.shift_id != null) (sb[s.shift_id] ??= []).push(s) })
    setSegByShift(sb)
    const cx: Record<string, PlanContext> = {}
    mo.context.forEach((r) => { cx[r.work_date] = r }); setCtx(cx)
    setPubs(await loadPublications(current, month))
    setDirtyCells(new Set()); setDirtyCtx(new Set()); setSel(new Set())
    setLoading(false)
  }, [current, month])
  useEffect(() => { reload() }, [reload])

  // SV02: シフト公開（月初版スナップショット）
  const doPublish = async () => {
    if (!current || !month) return
    if (missingForecast.length > 0) {
      setMsg(`Error: 予測販売室数が未入力の日があります（${missingForecast.map((d) => d.slice(5).replace('-', '/')).join('・')}）。休館日は「休」で設定してください。`)
      return
    }
    const isFirst = pubs.length === 0
    const ok = confirm(isFirst
      ? `${month} を「月初版（基準計画）」として記録します。\n予実分析の基準になります。`
      : `${month} の基準を再記録します。\n月初版は変更されません（再記録の履歴として残ります）。`)
    if (!ok) return
    if (dirtyCount > 0) { const s = confirm('未保存の変更があります。先に保存してから記録しますか？'); if (s) { await save() } }
    setPublishing(true); setMsg('')
    const { id, error } = await publishShiftPlan(current, month)
    setPublishing(false)
    if (error || id == null) { setMsg('Error: 記録に失敗しました' + (error ? `（${error}）` : '')); return }
    setPubs(await loadPublications(current, month))
    setMsg(isFirst ? `${month} を月初版として記録しました` : `${month} の基準を再記録しました`)
  }

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

  // 1日分（その日の全員）をコピー／別の日へ貼付
  const copyDay = (date: string) => {
    const buf: Record<string, { patternId: number | null; minutes: number }> = {}
    for (const s of staff) { const c = cells[ck(s.staff_code, date)]; buf[s.staff_code] = c ? { patternId: c.patternId, minutes: c.minutes } : { patternId: null, minutes: 0 } }
    setDayBuf(buf); setDayBufDate(date)
    setMsg(`${date} の1日分をコピーしました。貼付先の日付の「貼」を押してください`)
  }
  const pasteDay = (date: string) => {
    if (!dayBuf) return
    const keys: string[] = []
    setCells((prev) => {
      const n = { ...prev }
      for (const s of staff) { const src = dayBuf[s.staff_code]; if (!src) continue; const k = ck(s.staff_code, date); n[k] = { ...n[k], patternId: src.patternId, minutes: src.minutes }; keys.push(k) }
      return n
    })
    setDirtyCells((prev) => { const n = new Set(prev); keys.forEach((k) => n.add(k)); return n })
    setMsg(`${date} に貼付しました（${dayBufDate} の1日分）`)
  }

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

  // #4 ペイント: ブラシ適用＆ドラッグ終了
  const applyBrush = (staffCode: string, date: string) => {
    if (paintBrush === 'clear') setCell(staffCode, date, { patternId: null, minutes: 0 })
    else if (typeof paintBrush === 'number') { const p = patMap[paintBrush]; if (p) setCell(staffCode, date, { patternId: p.pattern_id, minutes: p.pattern_type === '勤務' ? patternMinutes(p) : 0 }) }
  }
  useEffect(() => {
    const up = () => { paintingRef.current = false }
    window.addEventListener('mouseup', up)
    return () => window.removeEventListener('mouseup', up)
  }, [])

  // #3 ガントのバー端ドラッグ（15分刻み）で開始/終了を調整→離すと保存
  useEffect(() => {
    const toStr = (m: number) => { const x = ((m % 1440) + 1440) % 1440; return `${String(Math.floor(x / 60)).padStart(2, '0')}:${String(x % 60).padStart(2, '0')}` }
    const toMin = (t: string) => (+t.slice(0, 2)) * 60 + (+t.slice(3, 5))
    const mm = (e: MouseEvent) => {
      const d = dragRef.current; if (!d) return
      const seg = segByShift[d.shiftId]?.[0]; if (!seg) return
      const frac = Math.min(1, Math.max(0, (e.clientX - d.rectLeft) / d.rectWidth))
      const mins = Math.round((d.lo + frac * (d.hi - d.lo)) / 15) * 15
      let start = seg.start_time.slice(0, 5), end = seg.end_time.slice(0, 5)
      if (d.edge === 'start') start = toStr(Math.min(mins, toMin(end) - 15))
      else end = toStr(Math.max(mins, toMin(start) + 15))
      const wm = segMinutes(start, end, seg.break_minutes || 0)
      const nseg = { ...seg, start_time: start, end_time: end, work_minutes: wm }
      setSegByShift((prev) => ({ ...prev, [d.shiftId]: [nseg] }))
      setCells((prev) => ({ ...prev, [ck(d.staff, d.date)]: { ...prev[ck(d.staff, d.date)], minutes: wm } }))
    }
    const up = async () => {
      const d = dragRef.current; if (!d) return
      dragRef.current = null
      const seg = segByShift[d.shiftId]?.[0]
      if (seg) { try { await saveSegments(d.shiftId, [{ ...seg, seq: 1 }]); setMsg('時間帯を更新しました') } catch (e: any) { setMsg('Error: ' + (e?.message ?? String(e))) } }
    }
    window.addEventListener('mousemove', mm); window.addEventListener('mouseup', up)
    return () => { window.removeEventListener('mousemove', mm); window.removeEventListener('mouseup', up) }
  }, [segByShift])

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

  // 未保存セルを先に保存して shift_id を確定（役割分割・時間編集で共用）
  const ensureShiftId = async (staffCode: string, date: string): Promise<number | null> => {
    const key = ck(staffCode, date); const c = cells[key]
    if (!c || c.patternId == null || patMap[c.patternId]?.pattern_type !== '勤務') return null
    let shiftId = c.shiftId
    if (shiftId == null || dirtyCells.has(key)) {
      shiftId = (await saveShiftCell({ staff_code: staffCode, work_facility: current, work_date: date, pattern_id: c.patternId, planned_minutes: c.minutes })) ?? undefined
      if (shiftId == null) { setMsg('Error: シフト行の保存に失敗しました'); return null }
      setCell(staffCode, date, { shiftId })
      setDirtyCells((prev) => { const n = new Set(prev); n.delete(key); return n })
    }
    return shiftId
  }

  // #3 時間帯ミニ編集を開く（役割分割が2つ以上ある場合は役割分割モーダルへ回す）
  const openTimeEditor = async (staffCode: string, date: string) => {
    const c = cells[ck(staffCode, date)]
    if (!c || c.patternId == null) return
    if (c.shiftId != null && (segByShift[c.shiftId]?.length ?? 0) > 1) { openSegEditor(staffCode, date); return }
    const shiftId = await ensureShiftId(staffCode, date)
    if (shiftId == null) return
    const seg = segByShift[shiftId]?.[0]
    const p = patMap[c.patternId]
    const start = (seg?.start_time ?? p?.start_time ?? '09:00').slice(0, 5)
    const end = (seg?.end_time ?? p?.end_time ?? '17:00').slice(0, 5)
    const brk = seg?.break_minutes ?? p?.break_minutes ?? 0
    setTimeEdit({ staff: staffCode, date, shiftId, start, end, brk })
  }
  const saveTimeEditor = async () => {
    if (!timeEdit) return
    setSaving(true)
    try {
      const c = cells[ck(timeEdit.staff, timeEdit.date)]
      const p = c?.patternId != null ? patMap[c.patternId] : null
      const roleId = segByShift[timeEdit.shiftId]?.[0]?.role_id ?? p?.default_role_id ?? roles[0]?.role_id ?? 0
      const brk = Math.max(0, timeEdit.brk || 0)
      const wm = segMinutes(timeEdit.start, timeEdit.end, brk)
      const seg: ShiftSegment = { seq: 1, role_id: roleId, start_time: timeEdit.start, end_time: timeEdit.end, break_minutes: brk, work_minutes: wm }
      await saveSegments(timeEdit.shiftId, [seg])
      setSegByShift((prev) => ({ ...prev, [timeEdit.shiftId]: [seg] }))
      setCells((prev) => ({ ...prev, [ck(timeEdit.staff, timeEdit.date)]: { ...prev[ck(timeEdit.staff, timeEdit.date)], minutes: wm } }))
      setTimeEdit(null); setMsg(`時間帯を保存（${(wm / 60).toFixed(1)}h）`)
    } catch (e: any) { setMsg('Error: ' + (e?.message ?? String(e))) }
    finally { setSaving(false) }
  }

  // ---- スポット追加（T11）----
  const addSpot = async () => {
    if (!spotName || spotWageAmount === '') { setMsg('氏名と金額を入力してください'); return }
    setSaving(true)
    try {
      const code = await createSpotStaff(current, spotName)
      setSpotWageMap((m) => ({ ...m, [code]: { kind: spotWageKind, amount: Number(spotWageAmount) } }))
      setSpotOpen(false); setSpotName(''); setSpotWageAmount('')
      await reload(); setMsg('スポット要員を追加しました。日付にシフトを置いて保存すると賃金が記録されます')
    } catch (e: any) { setMsg('Error: ' + (e?.message ?? String(e))) }
    finally { setSaving(false) }
  }

  // ---- 集計 ----
  const rowAgg = useCallback((sc: string) => {
    let min = 0, off = 0, workDays = 0
    for (const d of days) { const c = cells[ck(sc, d.date)]; if (!c || c.patternId == null) continue; const p = patMap[c.patternId]; if (p?.pattern_type === '休日') off += 1; else { min += c.minutes; workDays += 1 } }
    return { hours: min / 60, off, workDays }
  }, [cells, days, patMap])
  const dayTotal = (date: string) => { let min = 0; for (const s of staff) { const c = cells[ck(s.staff_code, date)]; if (c && c.patternId != null && patMap[c.patternId]?.pattern_type !== '休日') min += c.minutes } return min / 60 }
  const summary = useMemo(() => {
    // 人件費モデルv2の変動費: アルバイト=時間×宿の標準時給 / スポット=日当×日数 or 時給×時間。
    // 正社員は月額固定（全社設定）なのでシフトからは算出しない。
    let totalH = 0, varCost = 0, spotH = 0
    for (const s of staff) {
      const agg = rowAgg(s.staff_code); const hours = agg.hours; totalH += hours
      if (s.is_spot) {
        spotH += hours
        const sw = spotWageMap[s.staff_code]
        if (sw) varCost += sw.kind === '日当' ? sw.amount * agg.workDays : Math.round(hours * sw.amount)
      } else if (s.employment_type === 'アルバイト' && laborRate != null) {
        varCost += Math.round(hours * laborRate)
      }
    }
    return { totalH, varCost, spotH }
  }, [staff, rowAgg, spotWageMap, laborRate])

  const dirtyCount = dirtyCells.size + dirtyCtx.size
  // ④ 月初版記録の前提: 休館以外の全日に「予測販売室数」が入っていること
  const missingForecast = days.filter((d) => !ctx[d.date]?.is_closed && (ctx[d.date]?.forecast_rooms == null || Number.isNaN(Number(ctx[d.date]?.forecast_rooms)))).map((d) => d.date)
  const save = async () => {
    setSaving(true); setMsg('')
    try {
      for (const key of dirtyCells) {
        const [sc, date] = key.split('|'); const c = cells[key]; const isSpot = !!staffMap[sc]?.is_spot
        const sw = isSpot ? spotWageMap[sc] : undefined
        if (!c || c.patternId == null) { await deleteShiftCell(sc, current, date); if (isSpot) await deleteSpotActual(sc, current, date) }
        else {
          await saveShiftCell({
            staff_code: sc, work_facility: current, work_date: date, pattern_id: c.patternId, planned_minutes: c.minutes,
            ...(sw ? { spot_wage_kind: sw.kind, spot_wage_amount: sw.amount } : {}),
          })
          if (isSpot) await saveSpotActual(sc, current, date, c.minutes)
        }
      }
      for (const date of dirtyCtx) { const r = ctx[date]; await savePlanContext(current, date, { onhand_rooms: r?.onhand_rooms ?? null, forecast_rooms: r?.forecast_rooms ?? null, memo: r?.memo ?? null, is_closed: r?.is_closed ?? false }) }
      const nc = dirtyCells.size, nx = dirtyCtx.size
      await reload(); setMsg(`保存しました（シフト${nc}件・稼働前提${nx}件）`)
    } catch (e: any) { setMsg('Error: ' + (e?.message ?? String(e))) }
    finally { setSaving(false) }
  }

  const printShift = () => window.print()
  const enterFull = () => { fsRef.current?.requestFullscreen?.().catch(() => setFullscreen(true)) }
  const exitFull = () => { if (document.fullscreenElement) document.exitFullscreen?.(); else setFullscreen(false) }
  useEffect(() => {
    const h = () => setFullscreen(!!document.fullscreenElement)
    document.addEventListener('fullscreenchange', h)
    return () => document.removeEventListener('fullscreenchange', h)
  }, [])

  const patOptions = useMemo(() => ({ work: patterns.filter((p) => p.pattern_type === '勤務'), off: patterns.filter((p) => p.pattern_type === '休日') }), [patterns])
  const isClosed = (date: string) => !!ctx[date]?.is_closed
  const toggleClosed = (date: string) => setCtxField(date, { is_closed: !ctx[date]?.is_closed })
  const CLOSED_BG = '#e6e4df'  // 休館列の薄いグレー
  const btnGhost = 'px-3 py-1.5 text-xs rounded-md hover:opacity-80'

  return (
    <div className="p-6">
      {/* 印刷/PDF: シフト表だけを横向きで出力（張り出し用・A3/A4横） */}
      <style>{`.shift-print-title { display: none; } @media print { body * { visibility: hidden !important; } .shift-print, .shift-print * { visibility: visible !important; } .shift-print { position: absolute !important; left: 0; top: 0; width: auto !important; max-height: none !important; overflow: visible !important; box-shadow: none !important; } .shift-print table { zoom: 1 !important; } .shift-print-title { display: block !important; font-size: 15px; font-weight: 700; margin-bottom: 6px; } @page { size: ${paperSize} landscape; margin: 8mm; } }`}</style>
      <div className="flex items-end justify-between mb-4 flex-wrap gap-3">
        <div className="flex items-center gap-2 flex-wrap">
          <input type="month" className="field px-3 py-1.5 text-sm" value={month} onChange={(e) => setMonth(e.target.value)} />
          <div className="flex items-center gap-0.5">
            <button onClick={() => setZoom((z) => Math.max(0.8, +(z - 0.1).toFixed(2)))} className={btnGhost} style={{ border: '1px solid var(--border)', color: 'var(--text-dim)' }} title="文字を小さく">A−</button>
            <button onClick={() => setZoom((z) => Math.min(2, +(z + 0.1).toFixed(2)))} className={btnGhost} style={{ border: '1px solid var(--border)', color: 'var(--text-dim)' }} title="文字を大きく">A+</button>
          </div>
          <button onClick={enterFull} className={btnGhost} style={{ border: '1px solid var(--border)', color: 'var(--text-dim)' }}>全画面</button>
          <div className="flex items-center rounded-md overflow-hidden" style={{ border: '1px solid var(--border)' }}>
            <button onClick={printShift} className="px-3 py-1.5 text-xs hover:opacity-80" style={{ color: 'var(--text-dim)' }}>PDF/印刷</button>
            {(['A3', 'A4'] as const).map((sz) => (
              <button key={sz} onClick={() => setPaperSize(sz)} className="px-2 py-1.5 text-[11px]" style={{ borderLeft: '1px solid var(--border)', background: paperSize === sz ? 'var(--accent)' : 'var(--surface)', color: paperSize === sz ? '#fff' : 'var(--text-dim)' }} title={`${sz}横で出力`}>{sz}</button>
            ))}
          </div>
          <button onClick={copyPrevMonth} disabled={saving} className={btnGhost} style={{ border: '1px solid var(--border)', color: 'var(--text-dim)' }}>前月コピー</button>
          <button onClick={() => setSpotOpen(true)} className={btnGhost} style={{ border: '1px solid var(--border)', color: 'var(--text-dim)' }}>スポット追加</button>
          {copyBuf && <button onClick={doPaste} className={btnGhost} style={{ border: '1px solid var(--accent)', color: 'var(--accent)' }}>貼付（{copyBuf.rows === 1 && copyBuf.cols === 1 && sel.size ? `${sel.size}セル` : `${copyBuf.rows}×${copyBuf.cols}`}）</button>}
          <button onClick={doCopy} className={btnGhost} style={{ border: '1px solid var(--border)', color: 'var(--text-dim)' }}>コピー</button>
          <button onClick={save} disabled={saving || dirtyCount === 0} className="px-4 py-1.5 text-sm rounded-md text-white hover:opacity-90 disabled:opacity-40" style={{ background: 'var(--accent)' }}>
            {saving ? '保存中...' : dirtyCount > 0 ? `保存（${dirtyCount}）` : '保存'}
          </button>
          <button onClick={doPublish} disabled={publishing || loading || missingForecast.length > 0} className="px-4 py-1.5 text-sm rounded-md hover:opacity-90 disabled:opacity-40"
            style={{ border: '1px solid var(--accent)', color: 'var(--accent)' }} title={missingForecast.length > 0 ? `予測販売室数が未入力の日があります（${missingForecast.length}日）` : 'この月の月初版＝予実分析の基準として記録します'}>
            {publishing ? '記録中…' : pubs.length ? '基準を再記録' : '月初版を記録'}
          </button>
        </div>
      </div>

      {/* 公開状態（SV02） */}
      {!loading && staff.length > 0 && (
        <div className="flex items-center gap-2 mb-2 text-[11px] flex-wrap" style={{ color: 'var(--text-dim)' }}>
          {pubs.length === 0 ? (
            <span>月初版 未記録（「月初版を記録」でこの月の基準計画として保存されます＝予実分析の基準）</span>
          ) : (
            <>
              <span className="px-2 py-0.5 rounded" style={{ background: 'var(--surface2)' }}>記録 {pubs.length}回</span>
              <span>月初版: {new Date(pubs[pubs.length - 1].published_at).toLocaleString('ja-JP')}</span>
              <span>／ 最終記録: {new Date(pubs[0].published_at).toLocaleString('ja-JP')}</span>
            </>
          )}
        </div>
      )}

      {loading ? <Loading /> : staff.length === 0 ? (
        <Empty message="この宿に従業員がいません。勤怠CSVを取り込むか、スポット追加で登録してください。" />
      ) : (
        <>
          {/* 全画面ラッパ: 稼働前提＋シフト表を一体で（ネイティブfullscreenでサイドバー等も消える） */}
          <div ref={fsRef} className={fullscreen ? 'p-3 overflow-auto h-full' : ''} style={fullscreen ? { background: 'var(--bg)' } : undefined}>
            {fullscreen && (
              <div className="flex items-center gap-2 mb-2 flex-wrap">
                <span className="text-sm font-semibold">{currentFacility?.name ?? current} — {month} シフト表</span>
                <div className="ml-auto flex items-center gap-1">
                  <button onClick={() => setZoom((z) => Math.max(0.8, +(z - 0.1).toFixed(2)))} className={btnGhost} style={{ border: '1px solid var(--border)', color: 'var(--text-dim)' }} title="文字を小さく">A−</button>
                  <span className="text-xs w-10 text-center" style={{ color: 'var(--text-dim)' }}>{Math.round(zoom * 100)}%</span>
                  <button onClick={() => setZoom((z) => Math.min(2, +(z + 0.1).toFixed(2)))} className={btnGhost} style={{ border: '1px solid var(--border)', color: 'var(--text-dim)' }} title="文字を大きく">A+</button>
                  <button onClick={printShift} className={btnGhost} style={{ border: '1px solid var(--border)', color: 'var(--text-dim)' }}>PDF/印刷</button>
                  <button onClick={exitFull} className={btnGhost} style={{ border: '1px solid var(--accent)', color: 'var(--accent)' }}>✕ 全画面を閉じる</button>
                </div>
              </div>
            )}
          {/* #4 ペイントパレット: パターンを選んでセルをクリック/ドラッグで塗る */}
          <div className="flex items-center gap-1.5 flex-wrap mb-2">
            <span className="text-xs" style={{ color: 'var(--text-dim)' }}>ペイント:</span>
            {patterns.map((pt) => (
              <button key={pt.pattern_id} onClick={() => setPaintBrush(paintBrush === pt.pattern_id ? null : pt.pattern_id)}
                className="text-xs px-2 py-1 rounded" style={{ border: `1px solid ${paintBrush === pt.pattern_id ? 'var(--accent)' : 'var(--border)'}`, background: pt.color ? `${pt.color}22` : undefined, color: pt.color || 'var(--text)', fontWeight: paintBrush === pt.pattern_id ? 700 : 400 }}>{pt.name}</button>
            ))}
            <button onClick={() => setPaintBrush(paintBrush === 'clear' ? null : 'clear')} className="text-xs px-2 py-1 rounded" style={{ border: `1px solid ${paintBrush === 'clear' ? 'var(--red)' : 'var(--border)'}`, color: 'var(--red)' }}>消す</button>
            {paintBrush !== null && <span className="text-[10px]" style={{ color: 'var(--accent)' }}>← セルをクリック/ドラッグで塗る（もう一度押すと解除）</span>}
            <span className="text-[11px] ml-2" style={{ color: 'var(--text-dim)' }}>｜ 日付にカーソルを当てて<b>「コ」＝1日コピー / 「貼」＝貼付</b></span>
            {dayBuf && <span className="text-[11px] flex items-center gap-1" style={{ color: 'var(--accent)' }}>{dayBufDate} の1日をコピー中<button onClick={() => { setDayBuf(null); setMsg('') }} className="underline">解除</button></span>}
          </div>

          {/* 月グリッド */}
          <div className="card overflow-auto shift-print" style={{ maxHeight: fullscreen ? 'calc(100vh - 110px)' : 'calc(100vh - 280px)' }}>
            <div className="shift-print-title">{currentFacility?.name ?? current} 　{month} シフト表</div>
            <table className="text-xs border-separate" style={{ borderSpacing: 0, zoom }}>
              <thead>
                <tr>
                  <th className="px-2 h-12 text-left whitespace-nowrap sticky left-0 top-0 z-30" style={{ minWidth: 150, background: 'var(--surface2)', borderRight: '2px solid var(--border)' }} />
                  {days.map((d) => {
                    const closed = isClosed(d.date)
                    return (
                    <th key={d.date} className="px-1 h-12 text-center whitespace-nowrap sticky top-0 z-20 group relative" style={{ minWidth: 58, background: closed ? CLOSED_BG : 'var(--surface2)' }}>
                      <div onClick={() => setGanttDate(d.date)} className="cursor-pointer hover:opacity-80" title="クリックでこの日のシフトをガント表示">
                        <div style={{ color: dateColor(d.date, d.wd) }}>{d.day}</div><div style={{ fontSize: 10, color: dateColor(d.date, d.wd) }}>{WD[d.wd]}</div>
                      </div>
                      {closed && <div className="text-[8px] leading-none" style={{ color: 'var(--text-dim)' }}>休館</div>}
                      <div className="absolute left-0 right-0 hidden group-hover:flex justify-center gap-0.5 z-40" style={{ bottom: 1 }}>
                        <button onClick={(e) => { e.stopPropagation(); toggleClosed(d.date) }} className="text-[9px] leading-none px-1 py-0.5 rounded" style={{ border: `1px solid ${closed ? 'var(--accent)' : 'var(--border)'}`, background: 'var(--surface)', color: closed ? 'var(--accent)' : 'var(--text-dim)' }} title={closed ? '休館を解除' : 'この日を休館にする'}>{closed ? '開' : '休'}</button>
                        <button onClick={(e) => { e.stopPropagation(); copyDay(d.date) }} className="text-[9px] leading-none px-1 py-0.5 rounded" style={{ border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text-dim)' }} title="この日の全員をコピー">コ</button>
                        {dayBuf && <button onClick={(e) => { e.stopPropagation(); pasteDay(d.date) }} className="text-[9px] leading-none px-1 py-0.5 rounded" style={{ border: '1px solid var(--accent)', background: 'var(--surface)', color: 'var(--accent)' }} title={`${dayBufDate} の1日分をここに貼付`}>貼</button>}
                      </div>
                    </th>
                    )
                  })}
                  <th className="px-1 h-12 text-center sticky top-0 z-20" style={{ minWidth: 52, background: 'var(--surface)', borderLeft: '2px solid var(--border)' }}>時間計</th>
                  <th className="px-1 h-12 text-center sticky top-0 z-20" style={{ minWidth: 40, background: 'var(--surface)' }}>休日</th>
                </tr>
              </thead>
              <tbody>
                {/* 稼働前提（上部に固定・シフト行とは別デザイン）。日付ヘッダはシフト表と共通 */}
                {([['予算 稼働室/人数', 'budget', 48], ['オンハンド販売室数', 'onhand', 68], ['予測販売室数', 'forecast', 88], ['メモ', 'memo', 108]] as const).map(([label, kind, top], idx, arr) => {
                  const last = idx === arr.length - 1
                  const bg = 'var(--surface2)'
                  const bb = last ? '2px solid var(--border-strong, var(--border))' : '1px solid var(--border)'
                  return (
                    <tr key={kind}>
                      <td className="px-2 whitespace-nowrap sticky left-0 z-30" style={{ top, height: 20, minWidth: 150, background: bg, color: 'var(--text-dim)', fontSize: 11, fontWeight: 600, borderRight: '2px solid var(--border)', borderBottom: bb }}>{label}</td>
                      {days.map((d) => { const r = ctx[d.date]; return (
                        <td key={d.date} className="px-0.5 sticky z-20 text-center" style={{ top, height: 20, minWidth: 58, background: isClosed(d.date) ? CLOSED_BG : bg, borderBottom: bb, fontVariantNumeric: 'tabular-nums' }}>
                          {kind === 'budget' ? (<span style={{ fontSize: 11 }}>{r?.budget_rooms ?? '-'}<span style={{ fontSize: 9, color: 'var(--text-dim)' }}>{r?.budget_guests != null ? ` / ${r.budget_guests}` : ''}</span></span>)
                          : kind === 'memo' ? (<input className="field text-center" style={{ width: 46, fontSize: 10, padding: '1px 2px' }} value={r?.memo ?? ''}
                              onChange={(e) => setCtxField(d.date, { memo: e.target.value })}
                              onMouseEnter={(e) => { const m = ctx[d.date]?.memo; if (m && m.trim()) { const rc = e.currentTarget.getBoundingClientRect(); setMemoPop({ text: m, x: rc.left, y: rc.bottom + 4 }) } }}
                              onMouseLeave={() => setMemoPop(null)} />)
                          : (<input type="number" min={0} className="field text-center" style={{ width: 40, fontSize: 11, padding: '1px 2px' }} value={(kind === 'onhand' ? r?.onhand_rooms : r?.forecast_rooms) ?? ''} onChange={(e) => setCtxField(d.date, kind === 'onhand' ? { onhand_rooms: e.target.value === '' ? null : Number(e.target.value) } : { forecast_rooms: e.target.value === '' ? null : Number(e.target.value) })} />)}
                        </td>) })}
                      <td className="sticky z-20" style={{ top, height: 20, minWidth: 52, background: bg, borderLeft: '2px solid var(--border)', borderBottom: bb }} />
                      <td className="sticky z-20" style={{ top, height: 20, minWidth: 40, background: bg, borderBottom: bb }} />
                    </tr>
                  )
                })}
                {staff.map((s, ri) => {
                  const agg = rowAgg(s.staff_code); const tag = s.is_spot ? 'スポット' : (s.employment_type || '未設定')
                  return (
                    <tr key={s.staff_code} style={s.is_spot ? { borderTop: '1px dashed var(--border)' } : undefined}>
                      <td className="px-2 h-12 whitespace-nowrap sticky left-0 z-10" style={{ background: 'var(--surface)', borderTop: '1px solid var(--border)', borderRight: '2px solid var(--border)' }}>
                        <span style={{ fontSize: 13 }}>{s.name ?? s.staff_code}</span>
                        <span className="ml-1 text-[10px] px-1 py-0.5 rounded" style={{ background: s.is_spot ? 'var(--green)' : 'var(--surface2)', color: s.is_spot ? '#fff' : 'var(--text-dim)' }}>{tag}</span>
                      </td>
                      {days.map((d, di) => {
                        const c = cells[ck(s.staff_code, d.date)]; const p = c?.patternId != null ? patMap[c.patternId] : null
                        const isWork = p?.pattern_type === '勤務'; const selected = sel.has(ck(s.staff_code, d.date))
                        const hasSeg = c?.shiftId != null && (segByShift[c.shiftId]?.length ?? 0) > 1
                        const timeRange = isWork ? cellTimeRange(c) : ''
                        const brkH = isWork ? cellBreakH(c) : 0
                        return (
                          <td key={d.date} className="px-1 h-12" title={isWork ? 'ダブルクリックで役割分割' : undefined}
                            onMouseDown={(e) => {
                              if (e.shiftKey) { e.preventDefault(); selectRect(ri, di, true); return }
                              if (paintBrush !== null) { e.preventDefault(); paintingRef.current = true; applyBrush(s.staff_code, d.date) }
                            }}
                            onMouseEnter={() => { if (paintingRef.current && paintBrush !== null) applyBrush(s.staff_code, d.date) }}
                            onDoubleClick={() => isWork && openSegEditor(s.staff_code, d.date)}
                            style={{ borderTop: '1px solid var(--border)', background: isClosed(d.date) ? CLOSED_BG : (p?.color ? `${p.color}12` : undefined), boxShadow: selected ? 'inset 0 0 0 2px var(--accent)' : undefined }}>
                            <select className="w-full text-[12px] rounded font-medium" style={{ background: 'var(--surface)', border: '1px solid var(--border)', color: p?.color || 'var(--text)' }}
                              value={c?.patternId ?? ''} onFocus={() => { anchorRef.current = { r: ri, d: di } }} onChange={(e) => onPattern(s.staff_code, d.date, e.target.value)}>
                              <option value="">－</option>
                              {patOptions.work.map((pt) => <option key={pt.pattern_id} value={pt.pattern_id}>{pt.name}</option>)}
                              {patOptions.off.map((pt) => <option key={pt.pattern_id} value={pt.pattern_id}>{pt.name}</option>)}
                            </select>
                            <input className="w-full text-[12px] text-center rounded mt-0.5" style={{ background: hasSeg ? 'var(--surface2)' : 'var(--surface)', border: '1px solid var(--border)', fontVariantNumeric: 'tabular-nums' }}
                              value={isWork ? hoursStr(c!.minutes) : ''} disabled={!isWork} title={hasSeg ? '役割分割あり' : undefined}
                              onFocus={() => { anchorRef.current = { r: ri, d: di } }} onChange={(e) => onHours(s.staff_code, d.date, e.target.value, c?.patternId ?? null)} />
                            {timeRange && (
                              <div onClick={(ev) => { ev.stopPropagation(); openTimeEditor(s.staff_code, d.date) }}
                                className="text-center cursor-pointer" style={{ fontSize: 11, lineHeight: 1.2, color: 'var(--text-dim)', marginTop: 1, fontVariantNumeric: 'tabular-nums' }}
                                title="クリックで時間帯を編集">{timeRange}{brkH > 0 ? ` (休${brkH.toFixed(1)})` : ''}</div>
                            )}
                          </td>
                        )
                      })}
                      <td className="px-1 h-12 text-center font-medium" style={{ background: 'var(--surface)', borderLeft: '2px solid var(--border)', borderTop: '1px solid var(--border)', fontSize: 13, fontVariantNumeric: 'tabular-nums' }}>{agg.hours.toFixed(1)}</td>
                      <td className="px-1 h-12 text-center" style={{ background: 'var(--surface)', borderTop: '1px solid var(--border)', color: 'var(--text-dim)', fontVariantNumeric: 'tabular-nums' }}>{agg.off}</td>
                    </tr>
                  )
                })}
                <tr>
                  <td className="px-2 h-9 text-right whitespace-nowrap sticky left-0 z-10 font-semibold" style={{ background: 'var(--surface2)', borderTop: '2px solid var(--border)', borderRight: '2px solid var(--border)', color: 'var(--text-dim)' }}>日別 予定合計</td>
                  {days.map((d) => <td key={d.date} className="px-1 h-9 text-center" style={{ background: isClosed(d.date) ? CLOSED_BG : 'var(--surface2)', borderTop: '2px solid var(--border)' }}>{dayTotal(d.date).toFixed(1)}</td>)}
                  <td style={{ background: 'var(--surface2)', borderTop: '2px solid var(--border)', borderLeft: '2px solid var(--border)' }} /><td style={{ background: 'var(--surface2)', borderTop: '2px solid var(--border)' }} />
                </tr>
                <tr>
                  <td className="px-2 h-8 text-right whitespace-nowrap sticky left-0 z-10" style={{ background: 'var(--surface2)', borderRight: '2px solid var(--border)', color: 'var(--text-dim)', fontSize: 11 }} title="1日の総労働時間 ÷ 予測販売室数">1室あたり時間</td>
                  {days.map((d) => {
                    const f = ctx[d.date]?.forecast_rooms
                    const v = f && f > 0 ? dayTotal(d.date) / f : null
                    return <td key={d.date} className="px-1 h-8 text-center" style={{ background: isClosed(d.date) ? CLOSED_BG : 'var(--surface2)', color: 'var(--text-dim)', fontSize: 11, fontVariantNumeric: 'tabular-nums' }}>{v == null ? '—' : v.toFixed(1)}</td>
                  })}
                  <td style={{ background: 'var(--surface2)', borderLeft: '2px solid var(--border)' }} /><td style={{ background: 'var(--surface2)' }} />
                </tr>
              </tbody>
            </table>
            </div>

          {(() => {
            const totalLabor = (regularCost ?? 0) + summary.varCost                 // 固定＋変動（計画）
            const gap = laborBudget != null ? totalLabor - laborBudget : null        // 対予算 乖離（＋=超過）
            return (
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mt-4">
                <div className="card p-4">
                  <div className="text-xs" style={{ color: 'var(--text-dim)' }}>月次 労働時間 合計</div>
                  <div className="text-xl font-bold">{fmtNum(summary.totalH)} h</div>
                  <div className="text-[10px] mt-0.5" style={{ color: 'var(--text-dim)' }}>うち 派遣・その他 {fmtNum(summary.spotH)} h</div>
                </div>
                <div className="card p-4">
                  <div className="text-xs" style={{ color: 'var(--text-dim)' }}>月次 人件費 合計（計画）</div>
                  <div className="text-xl font-bold">{fmtYen(totalLabor)}</div>
                  <div className="text-[10px] mt-0.5" style={{ color: 'var(--text-dim)' }}>固定(正社員) {regularCost != null ? fmtYen(regularCost) : '—'} ／ 変動 {fmtYen(summary.varCost)}</div>
                </div>
                <div className="card p-4">
                  <div className="text-xs" style={{ color: 'var(--text-dim)' }}>人件費 予算</div>
                  <div className="text-xl font-bold">{laborBudget != null ? fmtYen(laborBudget) : '—'}</div>
                  <div className="text-[10px] mt-0.5" style={{ color: 'var(--text-dim)' }}>給料手当＋雑給＋外注費(人材)＋外注費(清掃)</div>
                </div>
                <div className="card p-4">
                  <div className="text-xs" style={{ color: 'var(--text-dim)' }}>対予算 乖離</div>
                  <div className="text-xl font-bold" style={{ color: gap == null ? undefined : gap > 0 ? 'var(--red)' : 'var(--green)' }}>{gap == null ? '—' : `${gap > 0 ? '+' : ''}${fmtYen(gap)}`}</div>
                  <div className="text-[10px] mt-0.5" style={{ color: 'var(--text-dim)' }}>計画人件費 − 予算（＋＝予算超過）</div>
                </div>
              </div>
            )
          })()}
          <p className="text-[10px] mt-1" style={{ color: 'var(--text-dim)' }}>
            固定費＝正社員（全社設定の月額）／変動費＝アルバイト(時間×標準時給)＋スポット。予算・固定費が未設定の宿は「—」表示。
          </p>

          {msg && <p className="text-sm mt-3" style={{ color: msg.startsWith('Error') ? 'var(--red)' : 'var(--green)' }}>{msg}</p>}
          <div className="text-xs mt-4 leading-relaxed" style={{ color: 'var(--text-dim)' }}>
            <div className="font-semibold mb-1 text-sm" style={{ color: 'var(--text)' }}>使い方（マニュアル）</div>

            <div className="mt-2 font-semibold" style={{ color: 'var(--text)' }}>■ 事前の設定（各宿設定）</div>
            <ol className="space-y-0.5 mt-0.5" style={{ listStyle: 'decimal', paddingLeft: 20 }}>
              <li>「各宿設定」で<b>シフトパターン</b>（早番・遅番・公休など）を設定する</li>
              <li>「各宿設定」で<b>従業員を追加</b>する（表示する並び順もここで▲▼で決められます）</li>
            </ol>

            <div className="mt-2 font-semibold" style={{ color: 'var(--text)' }}>■ シフトの作り方</div>
            <ol className="space-y-0.5 mt-0.5" style={{ listStyle: 'decimal', paddingLeft: 20 }}>
              <li><b>休館日を設定</b>：日付にカーソルを合わせて「<b>休</b>」をクリック（その列がグレーになります。旧館の出勤などは記入できます）</li>
              <li><b>希望休を全員ぶんプロット</b>（休日パターンの「希望休」を選びます）</li>
              <li>各日に<b>オンハンド室数／予測販売室数／メモ</b>を記入（<b>予測販売室数は「月初版を記録」に必須</b>です）</li>
              <li><b>1日ごと、または人ごとにシフトを入力</b>。パターンより<b>労働時間が長い・短い、休憩が変わる</b>ときは、そのセルの時間帯（例「9:00–17:00」）をクリックして個別に調整します。<br /><span style={{ color: 'var(--accent)' }}>※ 予測販売室数（＝需要）に合わせて、しっかり考えて組むことが大事です</span></li>
              <li><b>人が足りない日</b>は「スポット追加」でタイミー等を登録し、その日にアサインします（賃金は日当/時給で入力）</li>
              <li>作り終えたら、下の指標をチェックして修正：<b>日別の予定合計・1室あたり時間・各人の公休数・各人の労働時間・月次の総労働時間・人件費合計（対予算の乖離）</b></li>
              <li>「<b>月初版を記録</b>」を押す（記入漏れがあると押せません）。→ 「PDF/印刷（A3横）」で刷って配布します</li>
            </ol>

            <div className="mt-2 font-semibold" style={{ color: 'var(--text)' }}>■ 便利な操作（補足）</div>
            <ul className="space-y-0.5 mt-0.5" style={{ listStyle: 'disc', paddingLeft: 20 }}>
              <li><b>ペイント</b>：上の「ペイント」でパターンを選び、セルをなぞると連続で入力できます</li>
              <li><b>まとめてコピー</b>：①コピーしたい範囲の<b>左上</b>で Shift を押しながら<b>右下までドラッグ</b>（範囲が枠で囲まれます）→ ②「コピー」（Ctrl+C）→ ③貼り付けたい場所の<b>左上のセルをクリック</b> → ④「貼付」（Ctrl+V）。ある1週間を選んで次の週に貼る、のように<b>並びをそのまま複製</b>できます</li>
              <li><b>1日まるごとコピー</b>：日付にカーソルを当てて「コ」でその日の全員をコピー → 別の日で「貼」</li>
              <li><b>時間帯・役割の編集</b>：「9:00–17:00」をクリックで開始・終了・休憩を編集。勤務セルを<b>ダブルクリック</b>すると1日を複数の役割に分けられます</li>
              <li><b>ガント表示</b>：日付をクリックすると、その日の時間帯の重なりを見られます（バーの端をドラッグで15分ずつ調整）</li>
              <li><b>全画面／文字サイズ（A−・A+）</b>で見やすく調整できます</li>
            </ul>
            <p className="mt-1">※ スポットの実働は保存時に勤怠実績へ記録され、労働時間・人件費に反映されます。人件費は計画ベースの月次合計です。</p>
          </div>

          {/* 役割分割モーダル（T08）※全画面でも出るよう fsRef 内に配置 */}
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
            <label className="block text-xs mb-1" style={{ color: 'var(--text-dim)' }}>賃金</label>
            <div className="flex gap-2 mb-1">
              <div className="flex rounded-md overflow-hidden" style={{ border: '1px solid var(--border)' }}>
                {(['時給', '日当'] as const).map((k) => (
                  <button key={k} onClick={() => setSpotWageKind(k)} className="px-3 py-2 text-sm"
                    style={{ background: spotWageKind === k ? 'var(--accent)' : 'var(--surface)', color: spotWageKind === k ? '#fff' : 'var(--text-dim)' }}>{k}</button>
                ))}
              </div>
              <div className="flex items-center gap-1 flex-1">
                <span className="text-xs" style={{ color: 'var(--text-dim)' }}>¥</span>
                <input type="number" min={0} className="field px-3 py-2 text-sm w-full" value={spotWageAmount}
                  onChange={(e) => setSpotWageAmount(e.target.value === '' ? '' : Number(e.target.value))}
                  placeholder={spotWageKind === '日当' ? '例: 12000（1日）' : '例: 1300（1時間）'} />
              </div>
            </div>
            <p className="text-[11px] mb-4" style={{ color: 'var(--text-dim)' }}>{spotWageKind === '日当' ? '日当＝出勤日数 × 金額（時間に依らず固定）' : '時給＝実働時間 × 金額'}。個人給与としては保存せず、このスポットのシフト行に紐づきます。</p>
            <div className="flex justify-end gap-2">
              <button className="text-sm px-3 py-1.5 rounded-md" style={{ border: '1px solid var(--border)' }} onClick={() => setSpotOpen(false)}>キャンセル</button>
              <button className="text-sm px-4 py-1.5 rounded-md text-white" style={{ background: 'var(--accent)' }} onClick={addSpot} disabled={saving}>追加</button>
            </div>
            <p className="text-[11px] mt-3" style={{ color: 'var(--text-dim)' }}>追加後、グリッドに行が現れます。日付にシフトを置いて保存すると、賃金と実働がKPIへ反映します。</p>
          </div>
        </div>
      )}

      {/* メモのホバー全文表示 */}
      {memoPop && (
        <div className="fixed z-50 p-2 rounded text-[11px]" style={{ left: memoPop.x, top: memoPop.y, maxWidth: 280, background: 'var(--surface)', border: '1px solid var(--border)', whiteSpace: 'pre-wrap', boxShadow: '0 4px 14px rgba(0,0,0,0.2)', color: 'var(--text)' }}>{memoPop.text}</div>
      )}

      {/* #3 時間帯ミニ編集 */}
      {timeEdit && (
        <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ background: 'rgba(0,0,0,0.5)' }} onClick={() => setTimeEdit(null)}>
          <div className="card p-5 w-[320px] max-w-[92vw]" style={{ background: 'var(--surface)' }} onClick={(e) => e.stopPropagation()}>
            <h3 className="text-base font-semibold mb-1">時間帯 — {staffMap[timeEdit.staff]?.name ?? timeEdit.staff}・{timeEdit.date}</h3>
            <p className="text-xs mb-3" style={{ color: 'var(--text-dim)' }}>開始・終了・休憩を設定します（複数役割に分けたい時は「役割分割」で）。</p>
            <div className="flex items-center gap-2 mb-2">
              <input type="time" className="field px-2 py-1.5 text-sm" value={timeEdit.start} onChange={(e) => setTimeEdit({ ...timeEdit, start: e.target.value })} />
              <span>〜</span>
              <input type="time" className="field px-2 py-1.5 text-sm" value={timeEdit.end} onChange={(e) => setTimeEdit({ ...timeEdit, end: e.target.value })} />
            </div>
            <div className="flex items-center gap-2 mb-3 text-sm">
              <label style={{ color: 'var(--text-dim)' }}>休憩</label>
              <input type="number" min={0} step={15} className="field px-2 py-1.5 text-sm w-20 text-right" value={timeEdit.brk} onChange={(e) => setTimeEdit({ ...timeEdit, brk: e.target.value === '' ? 0 : Number(e.target.value) })} />
              <span style={{ color: 'var(--text-dim)' }}>分</span>
              <span className="ml-auto">実働 <b>{(segMinutes(timeEdit.start, timeEdit.end, Math.max(0, timeEdit.brk || 0)) / 60).toFixed(1)}h</b></span>
            </div>
            <div className="flex justify-end gap-2">
              <button className="text-sm px-3 py-1.5 rounded-md" style={{ border: '1px solid var(--border)' }} onClick={() => setTimeEdit(null)}>キャンセル</button>
              <button className="text-sm px-4 py-1.5 rounded-md text-white" style={{ background: 'var(--accent)' }} onClick={saveTimeEditor} disabled={saving}>保存</button>
            </div>
          </div>
        </div>
      )}

      {/* #4 日別ガント */}
      {ganttDate && (() => {
        const toMin = (t: string) => (+t.slice(0, 2)) * 60 + (+t.slice(3, 5))
        type GSeg = { role_id: number; start: number; end: number; label: string }
        type GRow = { name: string; segs: GSeg[]; draggable: boolean; shiftId: number | null; staff: string; date: string; brk: number }
        const rows: GRow[] = []
        for (const s of staff) {
          const c = cells[ck(s.staff_code, ganttDate)]
          if (!c || c.patternId == null) continue
          const p = patMap[c.patternId]
          if (p?.pattern_type !== '勤務') continue
          const raw = (c.shiftId != null ? segByShift[c.shiftId] : null) ?? []
          let segs: GSeg[]
          if (raw.length) segs = raw.map((sg) => { const a = toMin(sg.start_time.slice(0, 5)); let e = toMin(sg.end_time.slice(0, 5)); if (e <= a) e += 1440; return { role_id: sg.role_id, start: a, end: e, label: roleMap[sg.role_id]?.role_name ?? '' } })
          else if (p?.start_time) { const a = toMin(p.start_time.slice(0, 5)); const e = a + (c.minutes || 0) + (p.break_minutes || 0); segs = [{ role_id: p.default_role_id ?? 0, start: a, end: e, label: '' }] }
          else segs = []
          if (segs.length) rows.push({ name: s.name ?? s.staff_code, segs, draggable: segs.length === 1, shiftId: c.shiftId ?? null, staff: s.staff_code, date: ganttDate, brk: raw[0]?.break_minutes ?? p?.break_minutes ?? 0 })
        }
        let lo = 24 * 60, hi = 0
        for (const r of rows) for (const sg of r.segs) { lo = Math.min(lo, sg.start); hi = Math.max(hi, sg.end) }
        if (lo >= hi) { lo = 8 * 60; hi = 22 * 60 }
        lo = Math.floor(lo / 60) * 60; hi = Math.ceil(hi / 60) * 60
        const span = hi - lo || 1
        const ticks: number[] = []; for (let t = lo; t <= hi; t += 60) ticks.push(t)
        const fmt = (m: number) => { const x = ((m % 1440) + 1440) % 1440; return `${String(Math.floor(x / 60)).padStart(2, '0')}:${String(x % 60).padStart(2, '0')}` }
        const startDrag = async (e: React.MouseEvent, row: GRow, edge: 'start' | 'end') => {
          e.preventDefault(); e.stopPropagation()
          const track = (e.currentTarget as HTMLElement).closest('[data-track]') as HTMLElement | null
          if (!track) return
          const rc = track.getBoundingClientRect()
          // 未保存セルはここで確定して shift_id を得る（保存ボタンを押さなくてもドラッグ可）
          let shiftId = row.shiftId
          if (shiftId == null) { shiftId = await ensureShiftId(row.staff, row.date); if (shiftId == null) return }
          if (!segByShift[shiftId]?.length) {
            const sg = row.segs[0]
            const seed: ShiftSegment = { seq: 1, role_id: sg.role_id || (roles[0]?.role_id ?? 0), start_time: fmt(sg.start), end_time: fmt(sg.end), break_minutes: row.brk, work_minutes: segMinutes(fmt(sg.start), fmt(sg.end), row.brk) }
            setSegByShift((prev) => ({ ...prev, [shiftId as number]: [seed] }))
          }
          dragRef.current = { shiftId, edge, rectLeft: rc.left, rectWidth: rc.width, lo, hi, staff: row.staff, date: row.date }
        }
        const dd = days.find((x) => x.date === ganttDate)
        return (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: 'rgba(0,0,0,0.5)' }} onClick={() => setGanttDate(null)}>
            <div className="card p-5 w-[820px] max-w-[95vw] max-h-[85vh] overflow-auto" style={{ background: 'var(--surface)' }} onClick={(e) => e.stopPropagation()}>
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-base font-semibold">{ganttDate}（{dd ? WD[dd.wd] : ''}）のシフト — {rows.length}名</h3>
                <button onClick={() => setGanttDate(null)} className="text-lg leading-none px-2" style={{ color: 'var(--text-dim)' }}>✕</button>
              </div>
              {rows.length === 0 ? <p className="text-sm py-8 text-center" style={{ color: 'var(--text-dim)' }}>この日の勤務はありません。</p> : (
                <div>
                  <div className="flex text-[11px]" style={{ color: 'var(--text-dim)' }}>
                    <div style={{ width: 120, flexShrink: 0 }} />
                    <div className="relative flex-1" style={{ height: 18 }}>
                      {ticks.map((t, i) => (i % 2 === 0 ? <span key={t} className="absolute" style={{ left: `${(t - lo) / span * 100}%`, transform: 'translateX(-50%)' }}>{Math.floor(t / 60) % 24}時</span> : null))}
                    </div>
                  </div>
                  <div className="space-y-1 mt-1">
                    {rows.map((r, i) => (
                      <div key={i} className="flex items-center">
                        <div className="text-xs whitespace-nowrap overflow-hidden" style={{ width: 120, flexShrink: 0, textOverflow: 'ellipsis' }}>{r.name}</div>
                        <div data-track className="relative flex-1 rounded" style={{ height: 24, background: 'var(--surface2)' }}>
                          {ticks.map((t) => <div key={t} className="absolute top-0 bottom-0" style={{ left: `${(t - lo) / span * 100}%`, borderLeft: '1px solid var(--border)' }} />)}
                          {r.segs.map((sg, j) => (
                            <div key={j} className="absolute top-0.5 bottom-0.5 rounded flex items-center justify-center text-[9px] text-white overflow-hidden"
                              style={{ left: `${(sg.start - lo) / span * 100}%`, width: `${(sg.end - sg.start) / span * 100}%`, background: roleMap[sg.role_id]?.color || 'var(--accent)' }}
                              title={`${fmt(sg.start)}–${fmt(sg.end)} ${sg.label}`}>
                              {r.draggable && <div onMouseDown={(e) => startDrag(e, r, 'start')} className="absolute left-0 top-0 bottom-0" style={{ width: 9, cursor: 'ew-resize', background: 'rgba(255,255,255,0.4)', borderRadius: '4px 0 0 4px' }} title="ドラッグで開始を調整" />}
                              <span className="px-1 truncate">{fmt(sg.start)}–{fmt(sg.end)}{sg.label ? ` ${sg.label}` : ''}</span>
                              {r.brk > 0 && j === 0 && (sg.end - sg.start) > 0 && (
                                <div className="absolute pointer-events-none" title={`休憩 ${(r.brk / 60).toFixed(1)}h`}
                                  style={{ left: '50%', top: 3, bottom: 3, width: `${Math.max(6, Math.min(80, (r.brk / (sg.end - sg.start)) * 100))}%`, transform: 'translateX(-50%)', background: 'repeating-linear-gradient(45deg, rgba(0,0,0,0.28), rgba(0,0,0,0.28) 3px, transparent 3px, transparent 6px)', borderRadius: 2 }} />
                              )}
                              {r.draggable && <div onMouseDown={(e) => startDrag(e, r, 'end')} className="absolute right-0 top-0 bottom-0" style={{ width: 9, cursor: 'ew-resize', background: 'rgba(255,255,255,0.4)', borderRadius: '0 4px 4px 0' }} title="ドラッグで終了を調整" />}
                            </div>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                  <p className="text-[10px] mt-3" style={{ color: 'var(--text-dim)' }}>バーの色は役割。<b>バーの左右の端をドラッグ</b>すると開始/終了を15分単位で調整→自動保存（単一時間帯のみ。役割分割ありは役割分割で編集）。</p>
                </div>
              )}
            </div>
          </div>
        )
      })()}
          </div>
        </>
      )}
    </div>
  )
}
