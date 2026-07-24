export type FileType =
  | 'staysee_reservation'
  | 'staysee_basic'
  | 'staysee_other'
  | 'staysee_payment'
  | 'staysee_room_sales'
  | 'rate_sheet'

export interface DetectionResult {
  type: FileType
  fileName: string
  facility?: string
}

export interface RawReservation {
  facility: string
  pms_id: number
  booking_no: string | null
  status: string
  channel: string | null
  checkin: string
  checkout: string | null
  nights: number
  guests_total: number
  adults: number
  children: number
  revenue_settled: number
  revenue_net: number
  consumption_tax: number
  bathing_tax: number
  lodging_tax: number
  room_raw: string | null
  room_parsed: string | null
  room_type: string | null
  room_count: number
  prefecture: string | null
  plan: string | null
  booking_date: string | null
  cancel_date: string | null
  source_month: string | null
}

export interface RawBasicProduct {
  facility: string
  pms_id: number
  status: string | null
  product_name: string | null
  unit_price: number
  quantity: number
  dinner: string | null
  breakfast: string | null
  meal_type: string | null
  source_month: string | null
}

export interface RawOtherProduct {
  facility: string
  pms_id: number
  status: string | null
  item_name: string | null
  unit_price: number
  quantity: number
  total: number
  category: string | null
  source_month: string | null
}

export interface RawPayment {
  facility: string
  pms_id: number
  payment_method: string | null
  amount: number
  source_month: string | null
}

export interface RawRateSnapshot {
  facility: string
  snapshot_date: string
  stay_date: string
  dow: string | null
  scope: string
  room: string | null
  rate_rank: number | null
  remaining: number | null
  sold: number | null
  flag_lastmin: boolean
  flag_sudomari: boolean
  flag_breakfast: boolean
  flag_2mei_cut: boolean
  flag_card: boolean
}

export interface RawRoomSales {
  facility: string
  stay_date: string
  scope: string
  room_type: string | null
  sold: number
  source_month: string | null
}

export interface UploadPayload {
  table: string
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data: any[]
  sourceMonth?: string
  skipped?: number // 変換で読めずに除外した行数（silent drop可視化）
}

export interface UploadResult {
  table: string
  inserted: number
  skipped?: number
  error?: string
  warning?: string  // 非ブロッキング警告（確定実績の変更検知・全ステータス出力チェック等）
}
