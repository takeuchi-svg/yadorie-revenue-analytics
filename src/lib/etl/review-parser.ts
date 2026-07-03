// クチコミCSVパーサー（じゃらん / 一休）
// 仕様: docs/データベース設計書_クチコミ満足度分析.md §3（cp932・じゃらんはタイトル行スキップ・クォート/改行対応）
// 列は「ヘッダー名アンカー方式」で解決（列順変化に耐える）。デコードは呼び出し側で decodeCp932（UTF-8/CP932自動判定）。
import Papa from 'papaparse'

export interface ReviewInsert {
  facility: string
  source: 'jalan' | 'ikyu'
  source_review_id: string
  booking_no: string | null
  review_date: string           // 'YYYY-MM-DD'
  stay_date: string | null
  overall_rating: number | null
  rating_scale: number
  sub_ratings: Record<string, number>
  title: string | null
  body: string | null
  reviewer_attr: Record<string, unknown>
  ingested_via: 'csv'
}

export interface ReviewParseResult {
  source: 'jalan' | 'ikyu'
  rows: ReviewInsert[]
  skipped: number               // 必須項目（ID/投稿日）が読めず除外した行数
  minDate: string | null
  maxDate: string | null
}

// '2026/6/2' | '2026/06/02' → '2026-06-02'（不正はnull）
const toISO = (s: string | undefined): string | null => {
  const m = (s ?? '').trim().match(/^(\d{4})[/-](\d{1,2})[/-](\d{1,2})/)
  if (!m) return null
  return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`
}
const toNum = (s: string | undefined): number | null => {
  const v = parseFloat((s ?? '').trim())
  return isNaN(v) ? null : v
}

function parseMatrix(text: string): string[][] {
  const res = Papa.parse<string[]>(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text, {
    header: false, skipEmptyLines: true,
  })
  return (res.data as string[][]).map((r) => r.map((c) => (c ?? '').trim()))
}

// ファイル種別判定: じゃらん=「クチコミ管理番号」/ 一休=「レイティング(個人総合)」
export function detectReviewCsv(text: string): 'jalan' | 'ikyu' | null {
  const head = text.slice(0, 4000)
  if (head.includes('クチコミ管理番号')) return 'jalan'
  if (head.includes('レイティング(個人総合)')) return 'ikyu'
  return null
}

export function parseReviewCsv(text: string, facility: string): ReviewParseResult {
  const source = detectReviewCsv(text)
  if (!source) throw new Error('クチコミCSVを認識できません（じゃらん/一休のヘッダーが見つかりません）')
  const rows = parseMatrix(text)
  // ヘッダー行を探す（じゃらんは1行目がタイトルのため2行目）
  const anchor = source === 'jalan' ? 'クチコミ管理番号' : 'レイティング(個人総合)'
  const hi = rows.findIndex((r) => r.some((c) => c.includes(anchor)))
  if (hi < 0) throw new Error('ヘッダー行が見つかりません')
  const header = rows[hi]
  const col = (name: string) => header.findIndex((c) => c === name)
  const at = (r: string[], i: number) => (i >= 0 && i < r.length ? r[i] : '')

  const out: ReviewInsert[] = []
  let skipped = 0

  if (source === 'jalan') {
    const iDate = col('投稿日'), iId = col('クチコミ管理番号'), iBk = col('予約番号')
    const iPlan = col('利用した宿泊プラン名'), iRoom = col('利用した部屋タイプ名'), iMeal = col('食事形態')
    const iPrice = col('宿泊価格'), iCi = col('チェックイン日'), iNights = col('泊数')
    const iSex = col('性別'), iAge = col('年代'), iScene = col('利用シーン')
    const iTitle = col('クチコミタイトル'), iBody = col('クチコミ投稿への投稿内容')
    const iOverall = col('総合評価')
    // sub_ratings: ソース原文キーのまま（dim_axis_mapping で統一軸へ）
    const subCols: [string, number][] = [
      ['部屋', col('部屋')], ['風呂', col('風呂')],
      ['料理朝食', col('料理朝食')], ['料理夕食', col('料理夕食')],
      ['接客・サービス', col('接客・サービス')], ['清潔感', col('清潔感')],
      ['コストパフォーマンス', col('コストパフォーマンス')],
    ]
    for (const r of rows.slice(hi + 1)) {
      const id = at(r, iId); const rd = toISO(at(r, iDate))
      if (!id || !rd) { skipped++; continue }
      const sub: Record<string, number> = {}
      for (const [k, i] of subCols) { const v = toNum(at(r, i)); if (v != null) sub[k] = v }
      out.push({
        facility, source, source_review_id: id,
        booking_no: at(r, iBk) || null,
        review_date: rd, stay_date: toISO(at(r, iCi)),
        overall_rating: toNum(at(r, iOverall)), rating_scale: 5,
        sub_ratings: sub,
        title: at(r, iTitle) || null, body: at(r, iBody) || null,
        reviewer_attr: {
          gender: at(r, iSex) || null, age_group: at(r, iAge) || null, scene: at(r, iScene) || null,
          plan: at(r, iPlan) || null, room: at(r, iRoom) || null, meal_type: at(r, iMeal) || null,
          price: toNum(at(r, iPrice)), nights: toNum(at(r, iNights)),
        },
        ingested_via: 'csv',
      })
    }
  } else {
    const iId = col('予約ID'), iPlan = col('プラン名称'), iRoomName = col('基本部屋名称')
    const iRoomType = col('部屋タイプ'), iMeal = col('食事区分'), iCi = col('チェックイン日')
    const iGuests = col('利用人数'), iDate = col('投稿日')
    const iOverall = col('レイティング(個人総合)')
    const iBody = col('クチコミ'), iSex = col('予約者性別'), iAge = col('予約者年代')
    const iSite = col('クチコミ投稿サイト')
    const subCols: [string, number][] = [
      ['レイティング(客室・アメニティ)', col('レイティング(客室・アメニティ)')],
      ['レイティング(温泉・お風呂)', col('レイティング(温泉・お風呂)')],
      ['レイティング(食事)', col('レイティング(食事)')],
      ['レイティング(接客・サービス)', col('レイティング(接客・サービス)')],
      ['レイティング(施設・設備)', col('レイティング(施設・設備)')],
      ['レイティング(満足度)', col('レイティング(満足度)')],
    ]
    for (const r of rows.slice(hi + 1)) {
      const id = at(r, iId); const rd = toISO(at(r, iDate))
      if (!id || !rd) { skipped++; continue }
      const sub: Record<string, number> = {}
      for (const [k, i] of subCols) { const v = toNum(at(r, i)); if (v != null) sub[k] = v }
      out.push({
        facility, source, source_review_id: id,
        booking_no: id, // 一休は予約ID=予約番号体系（raw_reservationとのマッチ率はC2で検証）
        review_date: rd, stay_date: toISO(at(r, iCi)),
        overall_rating: toNum(at(r, iOverall)), rating_scale: 5,
        sub_ratings: sub,
        title: null, body: at(r, iBody) || null,
        reviewer_attr: {
          gender: at(r, iSex) || null, age_group: at(r, iAge) || null,
          plan: at(r, iPlan) || null, room: at(r, iRoomName) || null, room_type: at(r, iRoomType) || null,
          meal_type: at(r, iMeal) || null, guests: toNum(at(r, iGuests)),
          post_site: at(r, iSite) || null,  // 一休/Yahoo!トラベル（sourceは'ikyu'のまま＝設計書§6-5）
        },
        ingested_via: 'csv',
      })
    }
  }

  const dates = out.map((r) => r.review_date).sort()
  return { source, rows: out, skipped, minDate: dates[0] ?? null, maxDate: dates[dates.length - 1] ?? null }
}
