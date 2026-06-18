// 予算スプレッドシート取込
//   ③日別計画 / ③日別売上 → budget_daily
//   ⑤月次計画                → budget_monthly（フルP&L, EAV）
//   ⑦予実管理                → actual_monthly（実績・昨年。任意: テーブルが無ければスキップ）
// 使い方: node scripts/import-budget.mjs <base64JsonPath> <facility> <fiscalYear>
//   例:  node scripts/import-budget.mjs ./dl.txt FRY 2026
import fs from 'fs';
import * as XLSX from '../node_modules/xlsx/xlsx.mjs';
import { createClient } from '@supabase/supabase-js';

const B64 = process.argv[2]
const FACILITY = process.argv[3] || 'FRY'
const FY = process.argv[4] || '2026'
const env = Object.fromEntries(
  fs.readFileSync(new URL('../.env.local', import.meta.url), 'utf8')
    .split(/\r?\n/).filter((l) => l.includes('=')).map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()] })
)
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY)

const num = (v) => {
  if (v === '' || v === null || v === undefined) return null
  if (typeof v === 'number') return isFinite(v) ? v : null
  let s = String(v).replace(/,/g, '').trim()
  if (s === '' || s.includes('DIV') || s.includes('#')) return null
  if (s.endsWith('％') || s.endsWith('%')) { const n = parseFloat(s); return isNaN(n) ? null : n / 100 }
  const n = parseFloat(s); return isNaN(n) ? null : n
}
const excelToISO = (serial) => {
  if (typeof serial !== 'number' || serial < 40000 || serial > 60000) return null
  const d = new Date((serial - 25569) * 86400 * 1000)
  return isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10)
}
const fyOf = (iso) => { const [y, m] = iso.split('-').map(Number); return String(m >= 4 ? y : y - 1) }
const monthToYM = (m, fyNum) => (m >= 4 ? `${fyNum}-${String(m).padStart(2, '0')}` : `${fyNum + 1}-${String(m).padStart(2, '0')}`)

const ITEM_CODE = {
  '売上高 計': 'sales_total', '売上高計': 'sales_total', '売上': 'sales_total',
  '宿泊売上': 'sales_lodging', '料理売上': 'sales_food', '室料売上': 'sales_room',
  '売店売上': 'sales_shop', '飲料売上': 'sales_beverage', '別注料理売上': 'sales_extra_food',
  '日帰売上': 'sales_daytrip', 'キャンセル売上等': 'sales_cancel', 'その他売上': 'sales_other',
  '原価': 'cogs_total', '人件費': 'labor_total', '販売管理費': 'sga_total',
  'GOP': 'gop', 'EBITDA': 'ebitda', '営業損益': 'operating_income',
}
const codeOf = (name) => ITEM_CODE[name] || name.replace(/\s+/g, '').replace(/[()（）・/]/g, '_')
const findSheet = (wb, re) => wb.SheetNames.find((n) => re.test(n))

/* ---------- 日別 ---------- */
function parseDaily(wb) {
  const name = findSheet(wb, /日別計画|日別売上/)
  const sh = wb.Sheets[name]
  const rows = XLSX.utils.sheet_to_json(sh, { header: 1, defval: '' })
  // 総客室数
  let totalRooms = 10
  for (const r of rows) { const i = r.findIndex((c) => String(c).includes('総客室数')); if (i >= 0) { const v = num(r[i + 1]); if (v) totalRooms = v; break } }

  const fullHdr = rows.findIndex((r) => r.includes('売上合計') && r.includes('販売室数'))
  const out = []
  if (fullHdr >= 0) {
    // 2026形式
    const H = rows[fullHdr]; const c = (n) => H.indexOf(n)
    const M = { date: c('日付'), event_note: c('イベント/休館/素泊'), inventory: c('在庫数'), rooms_sold: c('販売室数'), occ: c('稼働率'), companion: c('同伴係数'), guests: c('宿泊人数'), guest_unit: c('客単価'), room_unit: c('室単価'), room_revenue: c('宿泊売上'), shop_revenue: c('売店売上'), beverage_revenue: c('飲料売上'), extra_food_revenue: c('別注料理売上'), daytrip_revenue: c('日帰売上'), other_revenue: c('その他売上'), ancillary_revenue: c('付帯売上'), total_revenue: c('売上合計') }
    for (let i = fullHdr + 1; i < rows.length; i++) {
      const r = rows[i]; const iso = excelToISO(r[M.date]); if (!iso) continue
      out.push({ facility: FACILITY, fiscal_year: fyOf(iso), date: iso, event_note: (r[M.event_note] || '').toString().trim() || null,
        inventory: num(r[M.inventory]), rooms_sold: num(r[M.rooms_sold]), occ: num(r[M.occ]), companion: num(r[M.companion]), guests: num(r[M.guests]),
        guest_unit: num(r[M.guest_unit]), room_unit: num(r[M.room_unit]), room_revenue: num(r[M.room_revenue]), shop_revenue: num(r[M.shop_revenue]),
        beverage_revenue: num(r[M.beverage_revenue]), extra_food_revenue: num(r[M.extra_food_revenue]), daytrip_revenue: num(r[M.daytrip_revenue]),
        other_revenue: num(r[M.other_revenue]), ancillary_revenue: num(r[M.ancillary_revenue]), total_revenue: num(r[M.total_revenue]) })
    }
  } else {
    // 2025形式（簡易: 日付/客単価/人数室/室単価/稼働率/売上）
    const hdr = rows.findIndex((r) => r.includes('稼働率') && r.includes('売上') && r.includes('日付'))
    if (hdr < 0) throw new Error('日別ヘッダー行が見つかりません')
    const H = rows[hdr]; const c = (n) => H.indexOf(n)
    const M = { date: c('日付'), guest_unit: c('客単価'), companion: c('人数/室'), room_unit: c('室単価'), occ: c('稼働率'), total: c('売上') }
    for (let i = hdr + 1; i < rows.length; i++) {
      const r = rows[i]; const iso = excelToISO(r[M.date]); if (!iso) continue
      const occ = num(r[M.occ]); const companion = num(r[M.companion]); const total = num(r[M.total])
      const rooms_sold = occ != null ? Math.round(occ * totalRooms) : null
      const guests = (rooms_sold != null && companion != null) ? Math.round(rooms_sold * companion) : null
      out.push({ facility: FACILITY, fiscal_year: fyOf(iso), date: iso, event_note: null, inventory: totalRooms,
        rooms_sold, occ, companion, guests, guest_unit: num(r[M.guest_unit]), room_unit: num(r[M.room_unit]),
        room_revenue: total, shop_revenue: null, beverage_revenue: null, extra_food_revenue: null, daytrip_revenue: null,
        other_revenue: null, ancillary_revenue: null, total_revenue: total })
    }
  }
  return out
}

/* ---------- 月次計画 ---------- */
function parseMonthly(wb) {
  const sh = wb.Sheets[findSheet(wb, /月次計画/)]
  const rows = XLSX.utils.sheet_to_json(sh, { header: 1, defval: '' })
  const mRow = rows.findIndex((r) => r.some((c) => /^\d+月$/.test(String(c))))
  const monthCols = {}; rows[mRow].forEach((c, i) => { const m = String(c).match(/^(\d+)月$/); if (m) monthCols[+m[1]] = i })
  const monthNums = [4, 5, 6, 7, 8, 9, 10, 11, 12, 1, 2, 3].filter((m) => monthCols[m] != null)
  const labelCol = Math.min(...monthNums.map((m) => monthCols[m])) - 1
  const CATS = ['売上', '原価', '人件費', '販売管理費', 'GOP', 'EBITDA', '営業損益']
  const fyNum = parseInt(FY, 10)
  let curCat = null, sort = 0; const out = []
  for (let i = mRow + 1; i < rows.length; i++) {
    const r = rows[i]
    for (let c = 0; c < labelCol; c++) { if (CATS.includes(String(r[c]).trim())) { curCat = String(r[c]).trim(); break } }
    const name = String(r[labelCol] || '').trim(); if (!name) continue
    const code = codeOf(name)
    for (const m of monthNums) {
      const amount = num(r[monthCols[m]]); const ratio = num(r[monthCols[m] + 1])
      if (amount === null && ratio === null) continue
      out.push({ facility: FACILITY, fiscal_year: FY, month: monthToYM(m, fyNum), category: curCat, item_code: code, item_name: name, amount, ratio, sort_order: sort })
    }
    sort++
  }
  // item_code 重複（同名行）対策: 月内で最初の1件のみ採用
  const seen = new Set(); return out.filter((r) => { const k = r.month + '|' + r.item_code; if (seen.has(k)) return false; seen.add(k); return true })
}

/* ---------- 予実管理（実績・昨年） ---------- */
function parseYojitsu(wb) {
  const name = findSheet(wb, /^⑦予実管理|^予実管理/)
  if (!name) return []
  const sh = wb.Sheets[name]
  const rows = XLSX.utils.sheet_to_json(sh, { header: 1, defval: '' })
  const mRow = rows.findIndex((r) => r.filter((c) => /^\d+月$/.test(String(c))).length >= 6)
  if (mRow < 0) return []
  const monthCols = {}; rows[mRow].forEach((c, i) => { const m = String(c).match(/^(\d+)月$/); if (m && monthCols[+m[1]] == null) monthCols[+m[1]] = i })
  const monthNums = [4, 5, 6, 7, 8, 9, 10, 11, 12, 1, 2, 3].filter((m) => monthCols[m] != null)
  const labelCol = Math.min(...monthNums.map((m) => monthCols[m])) - 1
  const CATS = ['売上', '原価', '人件費', '販売管理費', 'GOP', 'EBITDA', '営業損益']
  const fyNum = parseInt(FY, 10)
  let curCat = null; const out = []; const seen = new Set()
  for (let i = mRow + 2; i < rows.length; i++) {
    const r = rows[i]
    for (let c = 0; c < labelCol; c++) { if (CATS.includes(String(r[c]).trim())) { curCat = String(r[c]).trim(); break } }
    const nm = String(r[labelCol] || '').trim(); if (!nm) continue
    const code = codeOf(nm)
    for (const m of monthNums) {
      const base = monthCols[m] // 実績,予算,予算差異,昨年,...
      const actual = num(r[base]); const prior = num(r[base + 3])
      if (actual === null && prior === null) continue
      const month = monthToYM(m, fyNum); const k = month + '|' + code; if (seen.has(k)) continue; seen.add(k)
      out.push({ facility: FACILITY, fiscal_year: FY, month, category: curCat, item_code: code, item_name: nm, actual, prior_amount: prior })
    }
  }
  return out
}

async function upsert(table, rows, conflict) {
  for (let i = 0; i < rows.length; i += 500) {
    const { error } = await sb.from(table).upsert(rows.slice(i, i + 500), { onConflict: conflict })
    if (error) throw new Error(table + ': ' + error.message)
  }
}

async function main() {
  const j = JSON.parse(fs.readFileSync(B64, 'utf8'))
  const wb = XLSX.read(Buffer.from(j.content, 'base64'), { type: 'buffer' })
  const daily = parseDaily(wb), monthly = parseMonthly(wb), yojitsu = parseYojitsu(wb)
  console.log(`FY=${FY} parsed daily:${daily.length} monthly:${monthly.length} yojitsu:${yojitsu.length}`)
  await upsert('budget_daily', daily, 'facility,date')
  await upsert('budget_monthly', monthly, 'facility,fiscal_year,month,item_code')
  if (yojitsu.length) {
    try { await upsert('actual_monthly', yojitsu, 'facility,fiscal_year,month,item_code'); console.log('actual_monthly: ' + yojitsu.length) }
    catch (e) { console.log('actual_monthly skip (' + e.message.slice(0, 60) + ')') }
  }
  console.log('IMPORT DONE')
}
main().catch((e) => { console.error('ERROR:', e.message); process.exit(1) })
