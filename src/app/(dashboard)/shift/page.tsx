'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useFacility } from '@/lib/facility-context'
import { fmtNum, fmtYen } from '@/lib/ui'
import { Loading, Empty } from '@/components/page-bits'
import {
  loadMasters, loadStaff, loadShiftMonth,
  saveShiftCell, deleteShiftCell, savePlanContext, patternMinutes,
  type Role, type ShiftPattern, type StaffLite, type PlanContext,
} from '@/lib/shift/data'

/* eslint-disable @typescript-eslint/no-explicit-any */
type Cell = { patternId: number | null; minutes: number }
const WD = ['日', '月', '火', '水', '木', '金', '土']
const ck = (staff: string, date: string) => `${staff}|${date}`

function daysOfMonth(month: string): { date: string; day: number; wd: number }[] {
  if (!month) return []
  const y = +month.slice(0, 4), m = +month.slice(5, 7)
  const n = new Date(y, m, 0).getDate()
  const out = []
  for (let d = 1; d <= n; d++) {
    out.push({ date: `${month}-${String(d).padStart(2, '0')}`, day: d, wd: new Date(y, m - 1, d).getDay() })
  }
  return out
}
const hoursStr = (min: number) => (min > 0 ? (min / 60).toFixed(1) : '')

export default function ShiftPage() {
  const { current, currentFacility } = useFacility()
  const [month, setMonth] = useState(() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}` })
  const [roles, setRoles] = useState<Role[]>([])
  const [patterns, setPatterns] = useState<ShiftPattern[]>([])
  const [staff, setStaff] = useState<StaffLite[]>([])
  const [cells, setCells] = useState<Record<string, Cell>>({})
  const [ctx, setCtx] = useState<Record<string, PlanContext>>({})
  const [dirtyCells, setDirtyCells] = useState<Set<string>>(new Set())
  const [dirtyCtx, setDirtyCtx] = useState<Set<string>>(new Set())
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState('')

  const days = useMemo(() => daysOfMonth(month), [month])
  const patMap = useMemo(() => { const o: Record<number, ShiftPattern> = {}; patterns.forEach((p) => { o[p.pattern_id] = p }); return o }, [patterns])

  const reload = useCallback(async () => {
    if (!current || !month) return
    setLoading(true); setMsg('')
    const [{ roles, patterns }, st, mo] = await Promise.all([
      loadMasters(current), loadStaff(current), loadShiftMonth(current, month),
    ])
    setRoles(roles); setPatterns(patterns); setStaff(st)
    const c: Record<string, Cell> = {}
    mo.plans.forEach((p) => { c[ck(p.staff_code, p.work_date)] = { patternId: p.pattern_id, minutes: p.planned_minutes } })
    setCells(c)
    const cx: Record<string, PlanContext> = {}
    mo.context.forEach((r) => { cx[r.work_date] = r })
    setCtx(cx)
    setDirtyCells(new Set()); setDirtyCtx(new Set())
    setLoading(false)
  }, [current, month])

  useEffect(() => { reload() }, [reload])

  const setCell = (staff: string, date: string, patch: Cell) => {
    const key = ck(staff, date)
    setCells((prev) => ({ ...prev, [key]: patch }))
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

  // 集計（即時）
  const rowAgg = useCallback((staffCode: string) => {
    let min = 0, off = 0
    for (const d of days) {
      const c = cells[ck(staffCode, d.date)]
      if (!c || c.patternId == null) continue
      const p = patMap[c.patternId]
      if (p?.pattern_type === '休日') off += 1
      else min += c.minutes
    }
    return { hours: min / 60, off }
  }, [cells, days, patMap])

  const dayTotal = (date: string) => {
    let min = 0
    for (const s of staff) { const c = cells[ck(s.staff_code, date)]; if (c && c.patternId != null && patMap[c.patternId]?.pattern_type !== '休日') min += c.minutes }
    return min / 60
  }

  const summary = useMemo(() => {
    let totalH = 0, totalCost = 0, spotH = 0
    for (const s of staff) {
      const { hours } = rowAgg(s.staff_code)
      totalH += hours
      if (s.is_spot) spotH += hours
      if (s.wage_type === '月給' && s.monthly_salary && s.contracted_monthly_hours) {
        const ot = Math.max(0, hours - s.contracted_monthly_hours - (s.deemed_ot_hours ?? 0))
        totalCost += s.monthly_salary + Math.round(ot * (s.monthly_salary / s.contracted_monthly_hours) * 1.25)
      } else if (s.hourly_wage) {
        totalCost += Math.round(hours * s.hourly_wage)
      }
    }
    return { totalH, totalCost, spotH }
  }, [staff, rowAgg])

  const dirtyCount = dirtyCells.size + dirtyCtx.size

  const save = async () => {
    setSaving(true); setMsg('')
    try {
      for (const key of dirtyCells) {
        const [sc, date] = key.split('|')
        const c = cells[key]
        if (!c || c.patternId == null) { await deleteShiftCell(sc, current, date) }
        else { await saveShiftCell({ staff_code: sc, work_facility: current, work_date: date, pattern_id: c.patternId, planned_minutes: c.minutes }) }
      }
      for (const date of dirtyCtx) {
        const r = ctx[date]
        await savePlanContext(current, date, { onhand_rooms: r?.onhand_rooms ?? null, forecast_rooms: r?.forecast_rooms ?? null, memo: r?.memo ?? null })
      }
      setDirtyCells(new Set()); setDirtyCtx(new Set())
      setMsg(`保存しました（シフト${dirtyCells.size}件・稼働前提${dirtyCtx.size}件）`)
    } catch (e: any) { setMsg('Error: ' + (e?.message ?? String(e))) }
    finally { setSaving(false) }
  }

  // パターン選択肢（勤務→休日）
  const patOptions = useMemo(() => {
    const work = patterns.filter((p) => p.pattern_type === '勤務')
    const off = patterns.filter((p) => p.pattern_type === '休日')
    return { work, off }
  }, [patterns])

  const wdColor = (wd: number) => (wd === 0 ? 'var(--red)' : wd === 6 ? 'var(--accent)' : 'var(--text-dim)')

  return (
    <div className="p-6">
      <div className="flex items-end justify-between mb-4 flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold mb-1">シフト・労務</h1>
          <p className="text-sm" style={{ color: 'var(--text-dim)' }}>{currentFacility?.name ?? current}</p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <input type="month" className="field px-3 py-1.5 text-sm" value={month} onChange={(e) => setMonth(e.target.value)} />
          <button disabled title="T09で実装" className="px-3 py-1.5 text-xs rounded-md opacity-40" style={{ border: '1px solid var(--border)', color: 'var(--text-dim)' }}>前月コピー</button>
          <button disabled title="T11で実装" className="px-3 py-1.5 text-xs rounded-md opacity-40" style={{ border: '1px solid var(--border)', color: 'var(--text-dim)' }}>スポット追加</button>
          <button onClick={save} disabled={saving || dirtyCount === 0}
            className="px-4 py-1.5 text-sm rounded-md text-white hover:opacity-90 disabled:opacity-40"
            style={{ background: 'var(--accent)' }}>
            {saving ? '保存中...' : dirtyCount > 0 ? `保存（${dirtyCount}）` : '保存'}
          </button>
        </div>
      </div>

      {loading ? <Loading /> : staff.length === 0 ? (
        <Empty message="この施設に従業員がいません。勤怠CSVを取り込むと従業員が登録されます。" />
      ) : (
        <>
          {/* 稼働前提・メモ（折りたたみ） */}
          <details className="card mb-4" style={{ padding: '8px 12px' }} open>
            <summary className="text-sm font-semibold cursor-pointer" style={{ color: 'var(--text-dim)' }}>稼働前提・メモ</summary>
            <div className="overflow-x-auto mt-2">
              <table className="text-xs border-separate" style={{ borderSpacing: 0 }}>
                <tbody>
                  {([
                    ['予算 稼働室/人数', 'budget'],
                    ['オンハンド室', 'onhand'],
                    ['予測室', 'forecast'],
                    ['メモ', 'memo'],
                  ] as const).map(([label, kind]) => (
                    <tr key={kind}>
                      <td className="px-2 py-1 whitespace-nowrap sticky left-0" style={{ minWidth: 132, background: 'var(--surface)', color: 'var(--text-dim)', borderTop: '1px solid var(--border)' }}>{label}</td>
                      {days.map((d) => {
                        const r = ctx[d.date]
                        return (
                          <td key={d.date} className="px-1 py-1 text-center" style={{ minWidth: 52, borderTop: '1px solid var(--border)' }}>
                            {kind === 'budget' ? (
                              <div>{r?.budget_rooms ?? '-'}<div style={{ fontSize: 10, color: 'var(--text-dim)' }}>{r?.budget_guests ?? ''}</div></div>
                            ) : kind === 'memo' ? (
                              <input className="field text-center" style={{ width: 46, fontSize: 10, padding: '2px' }} title={r?.memo ?? ''}
                                value={r?.memo ?? ''} onChange={(e) => setCtxField(d.date, { memo: e.target.value })} />
                            ) : (
                              <input type="number" min={0} className="field text-center" style={{ width: 40, fontSize: 11, padding: '2px' }}
                                value={(kind === 'onhand' ? r?.onhand_rooms : r?.forecast_rooms) ?? ''}
                                onChange={(e) => setCtxField(d.date, kind === 'onhand'
                                  ? { onhand_rooms: e.target.value === '' ? null : Number(e.target.value) }
                                  : { forecast_rooms: e.target.value === '' ? null : Number(e.target.value) })} />
                            )}
                          </td>
                        )
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>

          {/* 月グリッド */}
          <div className="card overflow-auto" style={{ maxHeight: 'calc(100vh - 260px)' }}>
            <table className="text-xs border-separate" style={{ borderSpacing: 0 }}>
              <thead>
                <tr>
                  <th className="px-2 h-12 text-left whitespace-nowrap sticky left-0 top-0 z-30" style={{ minWidth: 150, background: 'var(--surface2)', borderRight: '2px solid var(--border)' }}>氏名</th>
                  {days.map((d) => (
                    <th key={d.date} className="px-1 h-12 text-center whitespace-nowrap sticky top-0 z-20" style={{ minWidth: 58, background: 'var(--surface2)' }}>
                      <div>{d.day}</div><div style={{ fontSize: 10, color: wdColor(d.wd) }}>{WD[d.wd]}</div>
                    </th>
                  ))}
                  <th className="px-1 h-12 text-center sticky top-0 z-20" style={{ minWidth: 52, background: 'var(--surface)', borderLeft: '2px solid var(--border)' }}>時間計</th>
                  <th className="px-1 h-12 text-center sticky top-0 z-20" style={{ minWidth: 40, background: 'var(--surface)' }}>休日</th>
                </tr>
              </thead>
              <tbody>
                {staff.map((s) => {
                  const agg = rowAgg(s.staff_code)
                  const tag = s.is_spot ? 'スポット' : (s.wage_type || '未設定')
                  return (
                    <tr key={s.staff_code}>
                      <td className="px-2 h-10 whitespace-nowrap sticky left-0 z-10" style={{ background: 'var(--surface)', borderTop: '1px solid var(--border)', borderRight: '2px solid var(--border)' }}>
                        {s.name ?? s.staff_code}
                        <span className="ml-1 text-[9px] px-1 py-0.5 rounded" style={{ background: 'var(--surface2)', color: 'var(--text-dim)' }}>{tag}</span>
                      </td>
                      {days.map((d) => {
                        const c = cells[ck(s.staff_code, d.date)]
                        const p = c?.patternId != null ? patMap[c.patternId] : null
                        const isWork = p?.pattern_type === '勤務'
                        return (
                          <td key={d.date} className="px-0.5 h-10" style={{ borderTop: '1px solid var(--border)', background: p?.color ? `${p.color}22` : undefined }}>
                            <select className="w-full text-[10px] rounded" style={{ background: 'transparent', border: '1px solid var(--border)', color: p?.color || 'var(--text)' }}
                              value={c?.patternId ?? ''} onChange={(e) => onPattern(s.staff_code, d.date, e.target.value)}>
                              <option value="">－</option>
                              {patOptions.work.map((pt) => <option key={pt.pattern_id} value={pt.pattern_id}>{pt.name}</option>)}
                              {patOptions.off.map((pt) => <option key={pt.pattern_id} value={pt.pattern_id}>{pt.name}</option>)}
                            </select>
                            <input className="w-full text-[10px] text-center rounded mt-0.5" style={{ background: 'transparent', border: '1px solid var(--border)' }}
                              value={isWork ? hoursStr(c!.minutes) : ''} disabled={!isWork}
                              onChange={(e) => onHours(s.staff_code, d.date, e.target.value, c?.patternId ?? null)} />
                          </td>
                        )
                      })}
                      <td className="px-1 h-10 text-center font-medium" style={{ background: 'var(--surface)', borderLeft: '2px solid var(--border)', borderTop: '1px solid var(--border)' }}>{agg.hours.toFixed(1)}</td>
                      <td className="px-1 h-10 text-center" style={{ background: 'var(--surface)', borderTop: '1px solid var(--border)', color: 'var(--text-dim)' }}>{agg.off}</td>
                    </tr>
                  )
                })}
                {/* 日別 予定合計 */}
                <tr>
                  <td className="px-2 h-9 text-right whitespace-nowrap sticky left-0 z-10 font-semibold" style={{ background: 'var(--surface2)', borderTop: '2px solid var(--border)', borderRight: '2px solid var(--border)', color: 'var(--text-dim)' }}>日別 予定合計</td>
                  {days.map((d) => <td key={d.date} className="px-1 h-9 text-center" style={{ background: 'var(--surface2)', borderTop: '2px solid var(--border)' }}>{dayTotal(d.date).toFixed(1)}</td>)}
                  <td style={{ background: 'var(--surface2)', borderTop: '2px solid var(--border)', borderLeft: '2px solid var(--border)' }} /><td style={{ background: 'var(--surface2)', borderTop: '2px solid var(--border)' }} />
                </tr>
              </tbody>
            </table>
          </div>

          {/* 月次サマリー */}
          <div className="grid grid-cols-3 gap-3 mt-4">
            <div className="card p-4"><div className="text-xs" style={{ color: 'var(--text-dim)' }}>月次 労働時間 合計</div><div className="text-xl font-bold">{fmtNum(summary.totalH)} h</div></div>
            <div className="card p-4"><div className="text-xs" style={{ color: 'var(--text-dim)' }}>月次 人件費 合計（計画）</div><div className="text-xl font-bold">{fmtYen(summary.totalCost)}</div></div>
            <div className="card p-4"><div className="text-xs" style={{ color: 'var(--text-dim)' }}>うち 派遣・その他 時間</div><div className="text-xl font-bold">{fmtNum(summary.spotH)} h</div></div>
          </div>

          {msg && <p className="text-sm mt-3" style={{ color: msg.startsWith('Error') ? 'var(--red)' : 'var(--green)' }}>{msg}</p>}
          <p className="text-xs mt-2" style={{ color: 'var(--text-dim)' }}>
            セルはパターン選択→時間自動投入（勤務のみ手修正可）。保存で `raw_shift_plan` に反映（キー: 従業員×施設×日）。人件費は計画（シフト）ベースの月次合計のみ表示（個人別は非表示）。役割分割/前月コピー/コピペ/スポットは順次追加（T08〜）。
          </p>
        </>
      )}
    </div>
  )
}
