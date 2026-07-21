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
  spot_wage_kind?: string | null   // スポット行のみ: '日当' | '時給'
  spot_wage_amount?: number | null // 日当=1日の額 / 時給=円/時
}
export type SpotWage = { kind: '日当' | '時給'; amount: number }
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
  is_closed?: boolean | null   // 休館日（列をグレー表示。旧館出勤等の記入は可能）
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

// ── SV02 シフト公開（月初版スナップショット） ──
export interface Publication { id: number; facility: string; target_month: string; is_baseline: boolean; published_by: string | null; published_at: string }
// 公開履歴（この施設×月）。新しい順。
export async function loadPublications(facility: string, month: string): Promise<Publication[]> {
  const { data } = await supabase.from('shift_plan_publication')
    .select('id, facility, target_month, is_baseline, published_by, published_at')
    .eq('facility', facility).eq('target_month', `${month}-01`).order('published_at', { ascending: false })
  return (data as Publication[]) ?? []
}
// 公開実行（RPC）。初回=月初版(baseline)、以降=再公開。戻り=publication_id。
export async function publishShiftPlan(facility: string, month: string): Promise<{ id: number | null; error?: string }> {
  const { data, error } = await supabase.rpc('publish_shift_plan', { p_facility: facility, p_month: `${month}-01` })
  return { id: (data as number) ?? null, error: error?.message }
}

// ── SV03 標準人時係数（分/人泊） ──
export interface LaborStandard { facility: string; auto: number | null; sampleDays: number | null; manual: number | null; effective: number | null; source: 'auto' | 'manual' | null }
export async function loadLaborStandard(facility: string): Promise<LaborStandard> {
  const [autoR, effR, manR] = await Promise.all([
    supabase.from('mart_labor_standard_auto').select('minutes_per_guest_auto, sample_days').eq('facility', facility).maybeSingle(),
    supabase.from('mart_labor_standard_effective').select('minutes_per_guest, source').eq('facility', facility).maybeSingle(),
    supabase.from('dim_labor_standard').select('minutes_per_guest').eq('facility', facility).eq('source', 'manual').order('effective_from', { ascending: false }).limit(1).maybeSingle(),
  ])
  const a = autoR.data as any, e = effR.data as any, m = manR.data as any
  return {
    facility,
    auto: a?.minutes_per_guest_auto ?? null, sampleDays: a?.sample_days ?? null,
    manual: m?.minutes_per_guest ?? null,
    effective: e?.minutes_per_guest ?? null, source: e?.source ?? null,
  }
}
// 手動補正の保存（履歴追記）／解除（manual行を削除）
export async function saveLaborStandardManual(facility: string, value: number | null): Promise<{ error?: string }> {
  const { data: { user } } = await supabase.auth.getUser()
  if (value == null) {
    const { error } = await supabase.from('dim_labor_standard').delete().eq('facility', facility).eq('source', 'manual')
    return { error: error?.message }
  }
  const { error } = await supabase.from('dim_labor_standard')
    .insert({ facility, minutes_per_guest: value, source: 'manual', updated_by: user?.id ?? null })
  return { error: error?.message }
}

// 施設所属の従業員（フラット表示用）
export async function loadStaff(facility: string): Promise<StaffLite[]> {
  // 人件費モデルv2: 個人給与(dim_staff_wage)は撤去。賃金列は互換のため null 固定。
  const { data } = await supabase.from('dim_staff')
    .select('staff_code, name, employment_type, is_spot')
    .eq('home_facility', facility).order('staff_code')
  return ((data as StaffLite[]) ?? []).map((s) => ({
    ...s, wage_type: null, hourly_wage: null, monthly_salary: null, deemed_ot_hours: null, contracted_monthly_hours: null,
  }))
}

/* ===== 人件費モデルv2: 従業員マスタ手動編集 / アルバイト標準時給 / 正社員月額 ===== */
export type EmpType = '正社員' | 'アルバイト' | 'スポット'
export interface StaffRow { staff_code: string; name: string | null; employment_type: string | null; is_spot: boolean | null; source: string | null }

export async function loadStaffRoster(facility: string): Promise<StaffRow[]> {
  const { data } = await supabase.from('dim_staff')
    .select('staff_code, name, employment_type, is_spot, source')
    .eq('home_facility', facility).order('employment_type').order('name')
  return (data as StaffRow[]) ?? []
}
// 手動追加（各宿設定）。staff_code は勤怠(KOT)コードが分かれば入力、空なら自動採番。
export async function addStaff(facility: string, p: { name: string; employment_type: EmpType; staff_code?: string }): Promise<{ error?: string }> {
  const code = (p.staff_code?.trim()) || `M${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`
  const { error } = await supabase.from('dim_staff').insert({
    staff_code: code, name: p.name.trim(), home_facility: facility,
    employment_type: p.employment_type, is_spot: p.employment_type === 'スポット',
    is_monthly_salary: p.employment_type === '正社員', source: 'manual',
  })
  return { error: error?.message }
}
export async function updateStaff(staff_code: string, patch: { name?: string; employment_type?: EmpType }): Promise<{ error?: string }> {
  const upd: Record<string, unknown> = { updated_at: new Date().toISOString() }
  if (patch.name != null) upd.name = patch.name.trim()
  if (patch.employment_type != null) {
    upd.employment_type = patch.employment_type
    upd.is_spot = patch.employment_type === 'スポット'
    upd.is_monthly_salary = patch.employment_type === '正社員'
  }
  const { error } = await supabase.from('dim_staff').update(upd).eq('staff_code', staff_code)
  return { error: error?.message }
}
export async function deleteStaff(staff_code: string): Promise<{ error?: string }> {
  const { error } = await supabase.from('dim_staff').delete().eq('staff_code', staff_code)
  return { error: error?.message }  // シフト/勤怠がある従業員はFKで拒否される（エラー文言を表示）
}

export async function loadLaborRate(facility: string): Promise<number | null> {
  const { data } = await supabase.from('dim_labor_rate').select('hourly_wage').eq('facility', facility).maybeSingle()
  return (data?.hourly_wage as number | null) ?? null
}
export async function saveLaborRate(facility: string, hourly: number | null): Promise<{ error?: string }> {
  const { error } = await supabase.from('dim_labor_rate')
    .upsert({ facility, hourly_wage: hourly, updated_at: new Date().toISOString() }, { onConflict: 'facility' })
  return { error: error?.message }
}

export interface RegularLaborRow { facility: string; month: string; amount: number | null }
export async function loadRegularLabor(facility: string): Promise<RegularLaborRow[]> {
  const { data } = await supabase.from('raw_regular_labor_monthly')
    .select('facility, month, amount').eq('facility', facility).order('month')
  return (data as RegularLaborRow[]) ?? []
}
export async function saveRegularLabor(facility: string, month: string, amount: number | null): Promise<{ error?: string }> {
  const { error } = await supabase.from('raw_regular_labor_monthly')
    .upsert({ facility, month, amount, updated_at: new Date().toISOString() }, { onConflict: 'facility,month' })
  return { error: error?.message }
}

// 施設×月のシフト計画・セグメント・稼働前提を一括ロード
export async function loadShiftMonth(facility: string, month: string): Promise<{
  plans: ShiftPlan[]; segments: ShiftSegment[]; context: PlanContext[]
}> {
  const { start, end } = monthRange(month)
  // ページング必須: 素の select は1000行で無警告に切り捨てられる（スタッフ数×日数で超えうる）
  const plans = await fetchAll<ShiftPlan>(() => supabase.from('raw_shift_plan')
    .select('shift_id, staff_code, work_facility, work_date, pattern_id, planned_minutes, note, spot_wage_kind, spot_wage_amount')
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
    .select('facility, work_date, budget_rooms, budget_guests, onhand_rooms, forecast_rooms, memo, is_closed')
    .eq('facility', facility).gte('work_date', start).lte('work_date', end)
  return { plans, segments, context: (ctxRes.data as PlanContext[]) ?? [] }
}

// 1セル保存（勤務/休日）。(staff_code, work_facility, work_date) で upsert。shift_id を返す
export async function saveShiftCell(p: ShiftPlan): Promise<number | null> {
  const row: Record<string, unknown> = {
    staff_code: p.staff_code, work_facility: p.work_facility, work_date: p.work_date,
    pattern_id: p.pattern_id, planned_minutes: p.planned_minutes, note: p.note ?? null,
    updated_at: new Date().toISOString(),
  }
  // スポット賃金は指定があるときのみ更新（誤って既存値を消さない）
  if (p.spot_wage_kind !== undefined) row.spot_wage_kind = p.spot_wage_kind
  if (p.spot_wage_amount !== undefined) row.spot_wage_amount = p.spot_wage_amount
  const { data, error } = await supabase.from('raw_shift_plan')
    .upsert(row, { onConflict: 'staff_code,work_facility,work_date' })
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
export async function savePlanContext(facility: string, work_date: string, patch: { onhand_rooms?: number | null; forecast_rooms?: number | null; memo?: string | null; is_closed?: boolean | null }): Promise<void> {
  const { error } = await supabase.from('raw_daily_plan_context')
    .upsert({ facility, work_date, ...patch, updated_at: new Date().toISOString() }, { onConflict: 'facility,work_date' })
  if (error) throw error
}

// スポット要員を登録（dim_staff のみ・個人給与は持たない）。賃金(日当/時給)はシフト計画行に都度持たせる。
export async function createSpotStaff(facility: string, name: string): Promise<string> {
  const staff_code = `SP-${facility}-${Date.now().toString(36).toUpperCase()}`
  const { error } = await supabase.from('dim_staff').insert({
    staff_code, name, home_facility: facility, employment_type: 'スポット',
    is_monthly_salary: false, is_spot: true, source: 'manual',
    updated_at: new Date().toISOString(),
  })
  if (error) throw error
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
