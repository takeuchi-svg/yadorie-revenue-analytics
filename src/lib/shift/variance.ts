// シフト予実・振り返り（SV05〜）データアクセス。mart_shift_variance_* ビュー群を読む。
import { supabase } from '@/lib/supabase/client'
import { fetchAll } from '@/lib/supabase/fetch-all'

const monthRange = (month: string) => {
  const y = +month.slice(0, 4), m = +month.slice(5, 7)
  return { start: `${month}-01`, end: `${month}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, '0')}` }
}

export interface StaffDaily {
  staff_code: string; work_date: string; plan_min: number; actual_min: number
  variance_min: number; overtime_min: number; variance_type: string
}
export interface FacilityDaily {
  work_date: string; weekday: number; plan_min: number; actual_min: number; variance_min: number; overtime_min: number
  guests_plan: number | null; guests_actual: number | null; minutes_per_guest: number | null
  allowed_over_min: number | null; adjusted_variance_min: number | null; flag_no_flex_down: boolean
  cnt_absence: number; cnt_unplanned: number; cnt_spot: number; cnt_help: number
  reason_codes: string[] | null; note: string | null; reason_entered: boolean; is_exception: boolean
}
export interface MonthlyRow {
  facility: string; ym: string; baseline_min: number | null; final_plan_min: number | null; actual_min: number | null
  revision_min: number | null; variance_min: number | null; baseline_variance_min: number | null; ops_over_min: number | null
  cost_impact_hourly: number | null; cost_impact_monthly_ot: number | null; revision_count: number | null
  exception_days: number | null; reason_entered_days: number | null
}
export interface WeekdayRow { weekday: number; avg_variance_min: number | null; avg_adjusted_variance_min: number | null; days: number }
export interface EmpTypeRow { emp_type: string; plan_min: number; actual_min: number; variance_min: number }
export interface StaffName { staff_code: string; name: string | null }

export interface VarianceBundle {
  staffDaily: StaffDaily[]; facilityDaily: FacilityDaily[]; monthly: MonthlyRow | null; prevMonthly: MonthlyRow | null
  weekday: WeekdayRow[]; byEmp: EmpTypeRow[]; staffNames: Record<string, string>
}

const prevMonthStr = (month: string) => {
  const y = +month.slice(0, 4), m = +month.slice(5, 7)
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`
}

export async function loadVariance(facility: string, month: string): Promise<VarianceBundle> {
  const { start, end } = monthRange(month)
  const ymStart = `${month}-01`, prevYm = `${prevMonthStr(month)}-01`
  const [sd, fd, mo, prev, wd, emp] = await Promise.all([
    fetchAll<StaffDaily>(() => supabase.from('mart_shift_variance_staff_daily').select('*').eq('facility', facility).gte('work_date', start).lte('work_date', end)),
    fetchAll<FacilityDaily>(() => supabase.from('mart_shift_variance_facility_daily').select('*').eq('facility', facility).gte('work_date', start).lte('work_date', end).order('work_date')),
    supabase.from('mart_shift_variance_monthly').select('*').eq('facility', facility).eq('ym', ymStart).maybeSingle().then((r) => r.data),
    supabase.from('mart_shift_variance_monthly').select('*').eq('facility', facility).eq('ym', prevYm).maybeSingle().then((r) => r.data),
    fetchAll<WeekdayRow>(() => supabase.from('mart_shift_variance_weekday').select('weekday, avg_variance_min, avg_adjusted_variance_min, days').eq('facility', facility).eq('ym', ymStart)),
    fetchAll<EmpTypeRow>(() => supabase.from('mart_shift_variance_by_emptype').select('emp_type, plan_min, actual_min, variance_min').eq('facility', facility).eq('ym', ymStart)),
  ])
  const codes = [...new Set((sd ?? []).map((r) => r.staff_code))]
  const staffNames: Record<string, string> = {}
  if (codes.length) {
    const { data } = await supabase.from('dim_staff').select('staff_code, name').in('staff_code', codes)
    ;((data as StaffName[]) ?? []).forEach((s) => { staffNames[s.staff_code] = s.name ?? s.staff_code })
  }
  return {
    staffDaily: sd ?? [], facilityDaily: fd ?? [],
    monthly: (mo as MonthlyRow) ?? null, prevMonthly: (prev as MonthlyRow) ?? null,
    weekday: wd ?? [], byEmp: emp ?? [], staffNames,
  }
}

// 対象施設で予実データ(実績)がある月の一覧（新しい順）
export async function loadVarianceMonths(facility: string): Promise<string[]> {
  const { data } = await supabase.from('mart_shift_variance_facility_daily').select('work_date').eq('facility', facility).order('work_date', { ascending: false }).limit(2000)
  return [...new Set(((data as { work_date: string }[]) ?? []).map((r) => r.work_date.slice(0, 7)))]
}
