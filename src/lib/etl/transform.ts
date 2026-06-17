import type {
  RawReservation,
  RawBasicProduct,
  RawOtherProduct,
  RawPayment,
  RawBookingEvent,
  RawRoomSales,
  LincolnSubType,
  UploadPayload,
} from './types'
import { parseInt10, parseNum, parseDate, extractSourceMonth } from './parser'

// ============================================================
// Column name candidates (Staysee exports vary by version)
// ============================================================

function findCol(row: Record<string, string>, ...candidates: string[]): string | null {
  for (const c of candidates) {
    if (c in row) return row[c]
  }
  return null
}

// ============================================================
// Staysee 予約情報 → raw_reservation
// ============================================================

export function transformReservation(
  rows: Record<string, string>[],
  facility: string,
  fileName: string
): UploadPayload {
  const sourceMonth = extractSourceMonth(fileName)

  const data: RawReservation[] = rows
    .map((r) => {
      const pmsId = parseInt10(findCol(r, '予約ID', '予約No', 'ID'))
      if (!pmsId) return null

      const checkin = parseDate(findCol(r, 'チェックイン日', 'チェックイン', 'CI日', 'CI', '開始日付'))
      if (!checkin) return null

      return {
        facility,
        pms_id: pmsId,
        booking_no: findCol(r, '連携番号', '予約番号', 'Lincoln番号') || null,
        status: findCol(r, 'ステータス', '状態', '予約状態') || 'C/O',
        channel: findCol(r, '予約経路', 'OTA', 'チャネル', '経路', '経由') || null,
        checkin,
        checkout: parseDate(findCol(r, 'チェックアウト日', 'チェックアウト', 'CO日', 'CO', '終了日付')),
        nights: parseInt10(findCol(r, '泊数', '宿泊数')),
        guests_total: parseInt10(findCol(r, '合計人数', '人数', '利用人数')),
        adults: parseInt10(findCol(r, '大人', '大人人数')),
        children: parseInt10(findCol(r, '子供', '子供人数', '小人')),
        revenue_settled: parseInt10(findCol(r, '精算額', '売上', '合計金額', '請求額', '請求金額')),
        room_raw: findCol(r, '客室', '部屋', '部屋名', '客室名') || null,
        room_parsed: parseRoomName(findCol(r, '客室', '部屋', '部屋名', '客室名')),
        room_count: parseInt10(findCol(r, '部屋数', '室数')) || 1,
        prefecture: findCol(r, '都道府県', '発信地', '居住地', '住所') || null,
        plan: findCol(r, 'プラン', 'プラン名', '企画名') || null,
        booking_date: parseDate(findCol(r, '予約日', '予約受付日')),
        source_month: sourceMonth,
      }
    })
    .filter((r): r is NonNullable<typeof r> => r !== null)

  return { table: 'raw_reservation', data: data as RawReservation[], sourceMonth: sourceMonth ?? undefined }
}

function parseRoomName(raw: string | null): string | null {
  if (!raw) return null
  // Remove room number suffixes like "101", keep room type name
  return raw.replace(/\s*[\d]+$/, '').trim() || raw.trim()
}

// ============================================================
// Staysee 基本商品情報 → raw_basic_product
// ============================================================

export function transformBasicProduct(
  rows: Record<string, string>[],
  facility: string,
  fileName: string
): UploadPayload {
  const sourceMonth = extractSourceMonth(fileName)

  const data: RawBasicProduct[] = rows
    .map((r) => {
      const pmsId = parseInt10(findCol(r, '予約ID', '予約No', 'ID'))
      if (!pmsId) return null

      const dinner = findCol(r, '夕食', '夕食内容') || null
      const breakfast = findCol(r, '朝食', '朝食内容') || null

      return {
        facility,
        pms_id: pmsId,
        status: findCol(r, 'ステータス', '状態') || null,
        product_name: findCol(r, '商品名', '基本商品名', 'プラン名') || null,
        unit_price: parseInt10(findCol(r, '単価', '金額')),
        quantity: parseInt10(findCol(r, '数量', '人数')) || 1,
        dinner,
        breakfast,
        meal_type: classifyMealType(dinner, breakfast),
        source_month: sourceMonth,
      }
    })
    .filter((r): r is NonNullable<typeof r> => r !== null)

  return { table: 'raw_basic_product', data: data as RawBasicProduct[], sourceMonth: sourceMonth ?? undefined }
}

function classifyMealType(dinner: string | null, breakfast: string | null): string {
  const hasDinner = dinner !== null && dinner !== '' && dinner !== 'なし' && dinner !== '-'
  const hasBreakfast = breakfast !== null && breakfast !== '' && breakfast !== 'なし' && breakfast !== '-'

  if (hasDinner && hasBreakfast) return '2食付'
  if (!hasDinner && hasBreakfast) return '朝食付'
  if (hasDinner && !hasBreakfast) return '夕食のみ'
  return '素泊り'
}

// ============================================================
// Staysee その他商品情報 → raw_other_product
// ============================================================

const FB_CATEGORIES: [RegExp, string][] = [
  [/ビール|beer|生|IPA|エール|ラガー/i, 'ビール'],
  [/日本酒|純米|吟醸|大吟|冷酒|熱燗/i, '日本酒'],
  [/ワイン|wine|赤|白|ロゼ|スパーク/i, 'ワイン'],
  [/焼酎|芋|麦|米焼酎/i, '焼酎'],
  [/ウイスキー|ハイボール|whisky/i, 'ウイスキー'],
  [/サワー|チューハイ|酎ハイ/i, 'サワー'],
  [/ソフトドリンク|ジュース|お茶|コーヒー|紅茶|ウーロン|コーラ|ノンアル/i, 'ソフトドリンク'],
  [/料理|食事|御膳|定食|コース|鍋|刺身|天ぷら/i, '料理'],
  [/お土産|土産|物販|売店/i, '売店'],
]

function classifyFbCategory(itemName: string | null): string | null {
  if (!itemName) return null
  for (const [pattern, category] of FB_CATEGORIES) {
    if (pattern.test(itemName)) return category
  }
  return 'その他'
}

export function transformOtherProduct(
  rows: Record<string, string>[],
  facility: string,
  fileName: string
): UploadPayload {
  const sourceMonth = extractSourceMonth(fileName)

  const data: RawOtherProduct[] = rows
    .map((r) => {
      const pmsId = parseInt10(findCol(r, '予約ID', '予約No', 'ID'))
      if (!pmsId) return null

      const itemName = findCol(r, '商品名', 'その他商品名', '品名') || null
      const unitPrice = parseInt10(findCol(r, '単価', '金額'))
      const quantity = parseInt10(findCol(r, '数量')) || 1

      return {
        facility,
        pms_id: pmsId,
        status: findCol(r, 'ステータス', '状態') || null,
        item_name: itemName,
        unit_price: unitPrice,
        quantity,
        total: parseInt10(findCol(r, '合計', '小計')) || unitPrice * quantity,
        category: classifyFbCategory(itemName),
        source_month: sourceMonth,
      }
    })
    .filter((r): r is NonNullable<typeof r> => r !== null)

  return { table: 'raw_other_product', data: data as RawOtherProduct[], sourceMonth: sourceMonth ?? undefined }
}

// ============================================================
// Staysee 入金情報 → raw_payment
// ============================================================

export function transformPayment(
  rows: Record<string, string>[],
  facility: string,
  fileName: string
): UploadPayload {
  const sourceMonth = extractSourceMonth(fileName)

  const data: RawPayment[] = rows
    .map((r) => {
      const pmsId = parseInt10(findCol(r, '予約ID', '予約No', 'ID'))
      if (!pmsId) return null

      return {
        facility,
        pms_id: pmsId,
        payment_method: findCol(r, '入金方法', '支払方法', '決済方法') || null,
        amount: parseInt10(findCol(r, '金額', '入金額', '支払額')),
        source_month: sourceMonth,
      }
    })
    .filter((r): r is NonNullable<typeof r> => r !== null)

  return { table: 'raw_payment', data: data as RawPayment[], sourceMonth: sourceMonth ?? undefined }
}

// ============================================================
// Lincoln 予約検索 → raw_booking_event
// ============================================================

export function transformLincoln(
  rows: Record<string, string>[],
  facility: string,
  fileName: string
): UploadPayload {
  const sourceMonth = extractSourceMonth(fileName)

  const data: RawBookingEvent[] = rows
    .map((r) => {
      const notifyNo = parseInt10(findCol(r, '通知番号', '通知No', 'No'))
      if (!notifyNo) return null

      const checkin = parseDate(findCol(r, 'チェックイン日', 'チェックイン', 'CI日', 'CI'))
      if (!checkin) return null

      return {
        facility,
        notify_no: notifyNo,
        event_type: findCol(r, '通知種別', '種別', '区分') || '予約',
        booking_no: findCol(r, '販売先予約番号', '予約番号', '連携番号') || null,
        channel: findCol(r, '販売先名', '予約経路', 'サイト名', 'サイト', 'OTA', 'チャネル') || null,
        received_at: parseDate(findCol(r, '予約受信日', '受信日', '受信日時', '通知日')),
        checkin,
        checkout: parseDate(findCol(r, 'チェックアウト日', 'チェックアウト', 'CO日', 'CO')),
        nights: parseInt10(findCol(r, '泊数', '宿泊数')) || 1,
        guests_total: parseInt10(findCol(r, 'お客様総合計人数', '人数', '合計人数', '利用人数')),
        rooms: parseInt10(findCol(r, '利用客室合計数', '室数', '部屋数')) || 1,
        amount_gross: parseInt10(findCol(r, '合計宿泊料金(総額)', '金額', '合計金額', '宿泊料金', '総額')),
        plan: findCol(r, 'プラン名', 'プラン') || null,
        address: findCol(r, '団体または代表者住所', '住所', '都道府県') || null,
        meal_condition: findCol(r, '泊食条件', '食事条件', '食事') || null,
        source_csv: null,
      }
    })
    .filter((r): r is NonNullable<typeof r> => r !== null)

  // Deduplicate by notify_no (keep last occurrence)
  const deduped = new Map<number, RawBookingEvent>()
  for (const d of data) {
    deduped.set(d.notify_no, d)
  }
  const uniqueData = Array.from(deduped.values())

  // Detect lincoln subtype: CI-based vs received-date-based
  const subType = detectLincolnSubType(uniqueData)
  const csvLabel = subType === 'lincoln_ci'
    ? `lincoln_ci_${sourceMonth ?? 'unknown'}`
    : `lincoln_rcv_${sourceMonth ?? 'unknown'}`
  for (const d of uniqueData) {
    d.source_csv = csvLabel
  }

  return { table: 'raw_booking_event', data: uniqueData as RawBookingEvent[], sourceMonth: sourceMonth ?? undefined }
}

export function detectLincolnSubType(events: RawBookingEvent[]): LincolnSubType {
  if (events.length === 0) return 'lincoln_ci'

  const checkins = events
    .map((e) => new Date(e.checkin).getTime())
    .filter((t) => !isNaN(t))

  if (checkins.length === 0) return 'lincoln_ci'

  const minCI = Math.min(...checkins)
  const maxCI = Math.max(...checkins)
  const rangeDays = (maxCI - minCI) / (1000 * 60 * 60 * 24)

  // <= 35 days range → CI-based, > 35 days → received-date-based
  return rangeDays <= 35 ? 'lincoln_ci' : 'lincoln_rcv'
}

// ============================================================
// Staysee 販売数集計表 → raw_room_sales
// ============================================================
// Pivot table: rows = room type (+ 合計), columns = day-of-month (1..31),
// values = rooms sold that day. Unpivot into one row per (stay_date, room_type).

export function transformRoomSales(
  rows: Record<string, string>[],
  facility: string,
  fileName: string
): UploadPayload {
  const sourceMonth = extractSourceMonth(fileName) // e.g. '2026-04'
  if (!sourceMonth) {
    return { table: 'raw_room_sales', data: [] }
  }

  const [yearStr, monthStr] = sourceMonth.split('-')
  const year = parseInt(yearStr, 10)
  const month = parseInt(monthStr, 10)
  const daysInMonth = new Date(year, month, 0).getDate()

  const data: RawRoomSales[] = []

  for (const r of rows) {
    const roomType = findCol(r, '客室タイプ', '部屋タイプ', '部屋タイプ名', 'タイプ')
    if (!roomType || !roomType.trim()) continue

    const trimmed = roomType.trim()
    const isTotal = trimmed === '合計' || trimmed === '総計' || trimmed === '計'
    const scope = isTotal ? 'total' : 'type'

    for (let day = 1; day <= daysInMonth; day++) {
      const raw = r[String(day)]
      if (raw === undefined || raw === null || String(raw).trim() === '') continue
      const stayDate = `${yearStr}-${monthStr.padStart(2, '0')}-${String(day).padStart(2, '0')}`
      data.push({
        facility,
        stay_date: stayDate,
        scope,
        room_type: isTotal ? null : trimmed,
        sold: parseInt10(raw),
        source_month: sourceMonth,
      })
    }
  }

  return { table: 'raw_room_sales', data: data as unknown as Record<string, unknown>[], sourceMonth }
}

// ============================================================
// Dispatch by file type
// ============================================================

export function transformByType(
  type: string,
  rows: Record<string, string>[],
  facility: string,
  fileName: string
): UploadPayload {
  switch (type) {
    case 'staysee_reservation':
      return transformReservation(rows, facility, fileName)
    case 'staysee_basic':
      return transformBasicProduct(rows, facility, fileName)
    case 'staysee_other':
      return transformOtherProduct(rows, facility, fileName)
    case 'staysee_payment':
      return transformPayment(rows, facility, fileName)
    case 'staysee_room_sales':
      return transformRoomSales(rows, facility, fileName)
    case 'lincoln':
      return transformLincoln(rows, facility, fileName)
    default:
      throw new Error(`Unknown file type: ${type}`)
  }
}
