// DB行の共有型（各ページの重複interfaceを集約）。
// ※Supabase CLIが使えないため手書き。列は scripts/sql/*.sql・migrate.mjs 準拠。
//   ページは .select() で部分列を取る場合が多いが、型は全列の上位集合を持たせ、
//   参照側は選択した列のみアクセスする（従来の各ページ独自interfaceと同じ運用）。

// ---- raw_ ----
export interface ReservationRow {
  pms_id?: string
  checkin: string | null
  nights: number | null
  revenue_settled: number | null
  guests_total: number | null
  prefecture: string | null
  status?: string | null
  booking_date?: string | null
  cancel_date?: string | null
  channel?: string | null
  plan?: string | null
  room_count?: number | null
}
export interface BookingEventRow {
  notify_no?: string
  event_type: string | null
  channel?: string | null
  checkin: string | null
  received_at: string | null
  plan: string | null
  rooms: number | null
  guests_total: number | null
  amount_gross: number | null
  nights?: number | null
}
export interface RateSnapshotRow {
  snapshot_date: string
  stay_date: string
  dow: string | null
  scope?: string
  rate_rank: number | null
  remaining: number | null
}
export interface RoomSalesRow {
  room_type: string | null
  sold: number | null
  stay_date: string
  scope?: string
}
export interface OtherProductRow {
  item_name: string | null
  category: string | null
  total: number | null
  quantity: number | null
  source_month: string | null
  status?: string | null
}
export interface PaymentRow {
  payment_method: string | null
  amount: number | null
  source_month: string | null
}

// ---- 予算/PL ----
export interface ActualMonthlyRow {
  fiscal_year?: string
  month: string
  category?: string | null
  item_code: string
  item_name: string
  actual: number | null
  prior_amount?: number | null
}
export interface BudgetMonthlyRow {
  fiscal_year: string
  month: string
  category: string | null
  item_code: string
  item_name: string
  amount: number | null
  sort_order: number | null
}
export interface BudgetDailyRow {
  facility?: string
  date: string
  rooms_sold: number | null
  guests: number | null
  occ?: number | null
  companion?: number | null
  guest_unit?: number | null
  room_unit?: number | null
  total_revenue?: number | null
}

// ---- mart_ ----
export interface MonthlyKpiRow {
  facility?: string
  month: string
  revenue: number | null
  rooms_sold: number | null   // 室泊
  guests: number | null       // 人泊
  adr: number | null
  guest_unit: number | null   // 人泊単価
  companion: number | null    // 人泊÷室泊
}
export interface OccupancyMonthlyRow {
  month: string
  occ: number | null                 // 稼働日ベース（分母=客室数×稼働日数）
  occ_calendar_days?: number | null  // 全日ベース（分母=客室数×暦日数）
  rooms_sold: number | null
  operating_days: number | null
  total_rooms: number | null
}
export interface OccupancyDailyRow {
  date: string
  rooms_sold: number | null
  total_rooms?: number | null
  occ?: number | null
}
export interface ChannelRow {
  month?: string
  channel: string | null
  revenue: number | null
  rooms?: number | null
  guests?: number | null
  adr?: number | null
  guest_unit?: number | null
}
export interface LaborCostMonthlyRow {
  facility?: string
  month: string
  labor_cost?: number | null
  regular_cost?: number | null
  parttime_cost?: number | null
  parttime_hours?: number | null
  spot_cost?: number | null
  spot_hours: number | null
}
