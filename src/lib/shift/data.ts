// シフト・労務 データアクセス層（T04）
// 施設×月のシフト読み書き。既存 supabase クライアント（認証済み）を再利用。
// キー: (staff_code, work_facility, work_date)。時間は分(整数)。
import { supabase } from '@/lib/supabase/client'
import { fetchAll } from '@/lib/supabase/fetch-all'

export interface ShiftPattern {
  pattern_id: number
  pattern_type: '勤務' | '休日'
  name: string
  start_time: string | null
  end_time: string | null
  break_minutes: number
  default_role_id: number | null
  is_paid: boolean
  color: string | null
  sort_order: number
  facility: string | null
}
export interface Role { role_id: number; role_name: string; color: string | null; sort_order: number }
export interface ShiftPlan {
  shift_id?: number
  staff_code: string
  work_facility: string
  work_date: string // 'YYYY-MM-DD'
  pattern_id: number | null
  planned_minutes: number
  note?: string | null
}
export interface ShiftSegment {
  segment_id?: number
  shift_id?: number
  seq: number
  role_id: number
  start_time: string
  end_time: string
  break_minutes: number
  work_minutes: number
}
export interface PlanContext {
  facility: string
  work_date: string
  budget_rooms?: number | null
  budget_guests?: number | null
  onhand_rooms?: number | null
  forecast_rooms?: number | null
  memo?: string | null
}
export interface StaffLite {
  staff_code: string
  name: string | null
  employment_type: string | null
  is_spot: boolean | null
  // 賃金（dim_staff_wage。給与閲覧権限がないユーザーには null のまま＝人件費タイルは「-」表示）
  wage_type: string | null
  hourly_wage: number | null
  monthly_salary: number | null
  deemed_ot_hours: number | null
  contracted_monthly_hours: number | null
}

// 月の [初日, 末日] を 'YYYY-MM-DD' で返す
export function monthRange(month: string): { start: string; end: string } {
  const y = +month.slice(0, 4), m = +month.slice(5, 7)
  const start = `${month}-01`
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate()
  const end = `${month}-${String(lastDay).padStart(2, '0')}`
  return { start, end }
}

// マスタ（役割・パターン）: 施設共通(NULL) ＋ 当該施設固有
export async function loadMasters(facility: string): Promise<{ roles: Role[]; patterns: ShiftPattern[] }> {
  const [roleRes, patRes] = await Promise.all([
    supabase.from('dim_role').select('role_id, role_name, color, sort_order').eq('is_active', true).order('sort_order'),
    supabase.from('dim_shift_pattern').select('*').eq('is_active', true).or(`facility.is.null,facility.eq.${facility}`).order('sort_order'),
  ])
  return { roles: (roleRes.data as Role[]) ?? [], patterns: (patRes.data as ShiftPattern[]) ?? [] }
}

// 施設所属の従業員（フラット表示用）
export async function loadStaff(facility: string): Promise<StaffLite[]> {
  const { data } = await supabase.from('dim_staff')
    .select('staff_code, name, employment_type, is_spot')
    .eq('home_facility', facility).order('staff_code')
  const staff = ((data as StaffLite[]) ?? []).map((s) => ({
    ...s, wage_type: null, hourly_wage: null, monthly_salary: null, deemed_ot_hours: null, contracted_monthly_hours: null,
  }))
  // 賃金は別テーブル（給与閲覧権限がないとRLSで0行＝nullのまま）
  if (staff.length) {
    const { data: wages } = await supabase.from('dim_staff_wage')
      .select('staff_code, wage_type, hourly_wage, monthly_salary, deemed_ot_hours, contracted_monthly_hours')
      .in('staff_code', staff.map((s) => s.staff_code))
    const m: Record<string, Partial<StaffLite>> = {}
    ;((wages as StaffLite[]) ?? []).forEach((w) => { m[w.staff_code] = w })
    for (const s of staff) Object.assign(s, m[s.staff_code] ?? {})
  }
  return staff
}

// 施設×月のシフト計画・セグメント・稼働前提を一括ロード
export async function loadShiftMonth(facility: string, month: string): Promise<{
  plans: ShiftPlan[]; segments: ShiftSegment[]; context: PlanContext[]
}> {
  const { start, end } = monthRange(month)
  // ページング必須: 素の select は1000行で無警告に切り捨てられる（スタッフ数×日数で超えうる）
  const plans = await fetchAll<ShiftPlan>(() => supabase.from('raw_shift_plan')
    .select('shift_id, staff_code, work_facility, work_date, pattern_id, planned_minutes, note')
    .eq('work_facility', facility).gte('work_date', start).lte('work_date', end).order('shift_id'))
  const ids = plans.map((p) => p.shift_id).filter((x): x is number => x != null)
  let segments: ShiftSegment[] = []
  if (ids.length) {
    segments = await fetchAll<ShiftSegment>(() => supabase.from('raw_shift_segment')
      .select('segment_id, shift_id, seq, role_id, start_time, end_time, break_minutes, work_minutes')
      .in('shift_id', ids).order('segment_id'))
    segments.sort((a, b) => ((a.shift_id ?? 0) - (b.shift_id ?? 0)) || (a.seq - b.seq))
  }
  const ctxRes = await supabase.from('mart_daily_plan_context')
    .select('facility, work_date, budget_rooms, budget_guests, onhand_rooms, forecast_rooms, memo')
    .eq('facility', facility).gte('work_date', start).lte('work_date', end)
  return { plans, segments, context: (ctxRes.data as PlanContext[]) ?? [] }
}

// 1セル保存（勤務/休日）。(staff_code, work_facility, work_date) で upsert。shift_id を返す
export async function saveShiftCell(p: ShiftPlan): Promise<number | null> {
  const { data, error } = await supabase.from('raw_shift_plan')
    .upsert({
      staff_code: p.staff_code, work_facility: p.work_facility, work_date: p.work_date,
      pattern_id: p.pattern_id, planned_minutes: p.planned_minutes, note: p.note ?? null,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'staff_code,work_facility,work_date' })
    .select('shift_id').single()
  if (error) throw error
  return (data as { shift_id: number } | null)?.shift_id ?? null
}

// セルのクリア（そのセルの計画を削除。segment は ON DELETE CASCADE）
export async function deleteShiftCell(staff_code: string, work_facility: string, work_date: string): Promise<void> {
  const { error } = await supabase.from('raw_shift_plan').delete()
    .eq('staff_code', staff_code).eq('work_facility', work_facility).eq('work_date', work_date)
  if (error) throw error
}

// 役割セグメントを再生成し、planned_minutes を合計へ同期
export async function saveSegments(shift_id: number, segments: ShiftSegment[]): Promise<void> {
  await supabase.from('raw_shift_segment').delete().eq('shift_id', shift_id)
  if (segments.length) {
    const rows = segments.map((s, i) => ({
      shift_id, seq: s.seq ?? i + 1, role_id: s.role_id,
      start_time: s.start_time, end_time: s.end_time,
      break_minutes: s.break_minutes, work_minutes: s.work_minutes,
    }))
    const { error } = await supabase.from('raw_shift_segment').insert(rows)
    if (error) throw error
  }
  const total = segments.reduce((sum, s) => sum + (s.work_minutes || 0), 0)
  const { error: upErr } = await supabase.from('raw_shift_plan')
    .update({ planned_minutes: total, updated_at: new Date().toISOString() }).eq('shift_id', shift_id)
  if (upErr) throw upErr
}

// 稼働前提（オンハンド/予測/メモ）の保存
export async function savePlanContext(facility: string, work_date: string, patch: { onhand_rooms?: number | null; forecast_rooms?: number | null; memo?: string | null }): Promise<void> {
  const { error } = await supabase.from('raw_daily_plan_context')
    .upsert({ facility, work_date, ...patch, updated_at: new Date().toISOString() }, { onConflict: 'facility,work_date' })
  if (error) throw error
}

// スポット要員を登録（dim_staff: is_spot / dim_staff_wage: 時給）。staff_code は非KOT系で自動採番
export async function createSpotStaff(facility: string, name: string, hourlyWage: number): Promise<string> {
  const staff_code = `SP-${facility}-${Date.now().toString(36).toUpperCase()}`
  const { error } = await supabase.from('dim_staff').insert({
    staff_code, name, home_facility: facility, employment_type: 'スポット',
    is_monthly_salary: false, is_spot: true,
    updated_at: new Date().toISOString(),
  })
  if (error) throw error
  // 賃金はINSERTのみ施設メンバーに許可（読み返し・変更は給与閲覧権限が必要）
  const { error: wErr } = await supabase.from('dim_staff_wage').insert({
    staff_code, wage_type: '時給', hourly_wage: hourlyWage, updated_at: new Date().toISOString(),
  })
  if (wErr) throw wErr
  return staff_code
}

// スポット実働（実績）を raw_attendance_daily(source='manual') へ upsert。KOT行と staff_code が別系統で衝突しない
export async function saveSpotActual(staff_code: string, work_facility: string, work_date: string, minutes: number): Promise<void> {
  const { error } = await supabase.from('raw_attendance_daily').upsert({
    staff_code, work_facility, work_date, total_work_min: minutes, source: 'manual',
  }, { onConflict: 'staff_code,work_date,work_facility' })
  if (error) throw error
}
export async function deleteSpotActual(staff_code: string, work_facility: string, work_date: string): Promise<void> {
  const { error } = await supabase.from('raw_attendance_daily').delete()
    .eq('staff_code', staff_code).eq('work_facility', work_facility).eq('work_date', work_date).eq('source', 'manual')
  if (error) throw error
}

// 開始/終了/休憩（'HH:MM'）から実働(分)。日跨ぎ対応（end<=start は翌日扱い）
export function segMinutes(start: string, end: string, breakMin: number): number {
  const toMin = (t: string) => { const [h, m] = t.split(':'); return (+h) * 60 + (+m) }
  let span = toMin(end) - toMin(start)
  if (span <= 0) span += 24 * 60
  return Math.max(0, span - (breakMin || 0))
}

// パターン既定の予定実働(分)を計算（日跨ぎ対応: end<=start は翌日扱い）
export function patternMinutes(p: Pick<ShiftPattern, 'start_time' | 'end_time' | 'break_minutes' | 'pattern_type'>): number {
  if (p.pattern_type === '休日' || !p.start_time || !p.end_time) return 0
  return segMinutes(p.start_time, p.end_time, p.break_minutes || 0)
}
