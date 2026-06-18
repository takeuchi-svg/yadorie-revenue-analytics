// 予算スプレッドシート取込: ③日別計画 → budget_daily, ⑤月次計画 → budget_monthly
// 使い方: node scripts/import-budget.mjs <base64JsonPath> [facility=FRY]
// base64JsonPath: Drive download_file_content の保存ファイル（{content: base64 xlsx}）
import fs from 'fs';
import * as XLSX from '../node_modules/xlsx/xlsx.mjs';
import { createClient } from '@supabase/supabase-js';

const B64 = process.argv[2]
const FACILITY = process.argv[3] || 'FRY'
// .env.local から Supabase 認証情報を読む（鍵はコミットしない）
const env = Object.fromEntries(
  fs.readFileSync(new URL('../.env.local', import.meta.url), 'utf8')
    .split(/\r?\n/).filter((l) => l.includes('=')).map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()] })
)
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY)

const num = (v) => {
  if (v === '' || v === null || v === undefined) return null
  if (typeof v === 'number') return isFinite(v) ? v : null
  const s = String(v).replace(/,/g, '').trim()
  if (s === '' || s.includes('DIV') || s.includes('#')) return null
  const n = parseFloat(s); return isNaN(n) ? null : n
}
const excelToISO = (serial) => {
  if (typeof serial !== 'number' || serial < 40000 || serial > 60000) return null
  const d = new Date((serial - 25569) * 86400 * 1000)
  return isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10)
}
const fyOf = (iso) => { const [y, m] = iso.split('-').map(Number); return String(m >= 4 ? y : y - 1) }

const ITEM_CODE = {
  '売上高 計': 'sales_total', '売上高計': 'sales_total',
  '宿泊売上': 'sales_lodging', '料理売上': 'sales_food', '室料売上': 'sales_room',
  '売店売上': 'sales_shop', '飲料売上': 'sales_beverage', '別注料理売上': 'sales_extra_food',
  '日帰売上': 'sales_daytrip', 'キャンセル売上等': 'sales_cancel', 'その他売上': 'sales_other',
  '原価': 'cogs_total', '人件費': 'labor_total', '販売管理費': 'sga_total',
  'GOP': 'gop', 'EBITDA': 'ebitda', '営業損益': 'operating_income',
}
const codeOf = (name) => ITEM_CODE[name] || name.replace(/\s+/g, '').replace(/[()（）・/]/g, '_')

function parseDaily(wb) {
  const sh = wb.Sheets['③日別計画']
  const rows = XLSX.utils.sheet_to_json(sh, { header: 1, defval: '' })
  const hRow = rows.findIndex((r) => r.includes('売上合計') && r.includes('販売室数'))
  if (hRow < 0) throw new Error('日別計画ヘッダー行が見つかりません')
  const H = rows[hRow]
  const col = (name) => H.indexOf(name)
  const map = {
    date: col('日付'), event_note: col('イベント/休館/素泊'), inventory: col('在庫数'),
    rooms_sold: col('販売室数'), occ: col('稼働率'), companion: col('同伴係数'), guests: col('宿泊人数'),
    guest_unit: col('客単価'), room_unit: col('室単価'), room_revenue: col('宿泊売上'),
    shop_revenue: col('売店売上'), beverage_revenue: col('飲料売上'), extra_food_revenue: col('別注料理売上'),
    daytrip_revenue: col('日帰売上'), other_revenue: col('その他売上'), ancillary_revenue: col('付帯売上'),
    total_revenue: col('売上合計'),
  }
  const out = []
  for (let i = hRow + 1; i < rows.length; i++) {
    const r = rows[i]
    const iso = excelToISO(r[map.date])
    if (!iso) continue
    out.push({
      facility: FACILITY, fiscal_year: fyOf(iso), date: iso,
      event_note: (r[map.event_note] || '').toString().trim() || null,
      inventory: num(r[map.inventory]), rooms_sold: num(r[map.rooms_sold]), occ: num(r[map.occ]),
      companion: num(r[map.companion]), guests: num(r[map.guests]), guest_unit: num(r[map.guest_unit]),
      room_unit: num(r[map.room_unit]), room_revenue: num(r[map.room_revenue]),
      shop_revenue: num(r[map.shop_revenue]), beverage_revenue: num(r[map.beverage_revenue]),
      extra_food_revenue: num(r[map.extra_food_revenue]), daytrip_revenue: num(r[map.daytrip_revenue]),
      other_revenue: num(r[map.other_revenue]), ancillary_revenue: num(r[map.ancillary_revenue]),
      total_revenue: num(r[map.total_revenue]),
    })
  }
  return out
}

function parseMonthly(wb) {
  const sh = wb.Sheets['⑤月次計画']
  const rows = XLSX.utils.sheet_to_json(sh, { header: 1, defval: '' })
  // 月ヘッダー行
  const mRow = rows.findIndex((r) => r.some((c) => /^\d+月$/.test(String(c))))
  const monthCols = {} // monthNum -> colIndex
  rows[mRow].forEach((c, idx) => { const m = String(c).match(/^(\d+)月$/); if (m) monthCols[+m[1]] = idx })
  const monthNums = [4, 5, 6, 7, 8, 9, 10, 11, 12, 1, 2, 3].filter((m) => monthCols[m] != null)
  const firstMonthCol = Math.min(...monthNums.map((m) => monthCols[m]))
  const labelCol = firstMonthCol - 1
  const CATS = ['売上', '原価', '人件費', '販売管理費', 'GOP', 'EBITDA', '営業損益']
  let curCat = null, sort = 0
  const out = []
  for (let i = mRow + 1; i < rows.length; i++) {
    const r = rows[i]
    // カテゴリ carry-forward（col1付近にトップ分類）
    for (let c = 0; c < labelCol; c++) { if (CATS.includes(String(r[c]).trim())) { curCat = String(r[c]).trim(); break } }
    const name = String(r[labelCol] || '').trim()
    if (!name) continue
    const code = codeOf(name)
    for (const m of monthNums) {
      const fy = 2026
      const yyyymm = m >= 4 ? `${fy}-${String(m).padStart(2, '0')}` : `${fy + 1}-${String(m).padStart(2, '0')}`
      const amount = num(r[monthCols[m]])
      const ratio = num(r[monthCols[m] + 1])
      if (amount === null && ratio === null) continue
      out.push({ facility: FACILITY, fiscal_year: '2026', month: yyyymm, category: curCat, item_code: code, item_name: name, amount, ratio, sort_order: sort })
    }
    sort++
  }
  return out
}

async function upsert(table, rows, conflict) {
  for (let i = 0; i < rows.length; i += 500) {
    const batch = rows.slice(i, i + 500)
    const { error } = await sb.from(table).upsert(batch, { onConflict: conflict })
    if (error) throw new Error(table + ': ' + error.message)
  }
}

async function main() {
  const j = JSON.parse(fs.readFileSync(B64, 'utf8'))
  const wb = XLSX.read(Buffer.from(j.content, 'base64'), { type: 'buffer' })
  const daily = parseDaily(wb)
  const monthly = parseMonthly(wb)
  console.log('parsed daily:', daily.length, 'monthly:', monthly.length)
  console.log('daily sample:', JSON.stringify(daily[0]))
  console.log('monthly sample:', JSON.stringify(monthly.find((m) => m.item_code === 'sales_total')))
  await upsert('budget_daily', daily, 'facility,date')
  await upsert('budget_monthly', monthly, 'facility,fiscal_year,month,item_code')
  console.log('IMPORT DONE')
}
main().catch((e) => { console.error('ERROR:', e.message); process.exit(1) })
