// 会計P&L（月次推移：損益計算書）CSV → actual_monthly 行
// cp932デコード済みテキストを受け取り、年度と実績行を返す。
import Papa from 'papaparse'

export interface PlActualRow {
  fiscal_year: string
  month: string
  category: string | null
  item_code: string
  item_name: string
  actual: number | null
  prior_amount: number | null
}

// 予算(budget_monthly)の item_code と揃える（予実突合のため）
const OVERRIDE: Record<string, string> = {
  '売上高 計': 'sales_total', '売上高計': 'sales_total', '売上': 'sales_total',
  '宿泊売上': 'sales_lodging', '料理売上': 'sales_food', '室料売上': 'sales_room',
  '売店売上': 'sales_shop', '飲料売上': 'sales_beverage', '別注料理売上': 'sales_extra_food',
  '日帰売上': 'sales_daytrip', 'キャンセル売上等': 'sales_cancel', 'その他売上': 'sales_other',
  '原価': 'cogs_total', '売上原価': 'cogs_total', '人件費': 'labor_total',
  '販売管理費': 'sga_total', '販売管理費 計': 'sga_total', '販売管理費計': 'sga_total',
  'GOP': 'gop', 'EBITDA': 'ebitda',
  '営業損益': 'operating_income', '営業損益金額': 'operating_income', '売上総損益金額': 'gross_profit',
}
const TOP_CATS = ['売上高', '売上原価', '販売管理費', '営業損益金額', '経常損益金額']
const codeOf = (name: string) => OVERRIDE[name] || name.replace(/\s+/g, '').replace(/[()（）・/、]/g, '_')

function num(v: unknown): number | null {
  if (v === '' || v === null || v === undefined) return null
  const s = String(v).replace(/,/g, '').trim()
  if (s === '') return null
  const n = parseFloat(s)
  return isNaN(n) ? null : n
}

export function parsePlCsv(text: string): { fiscalYear: string; rows: PlActualRow[] } {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
  const data = Papa.parse<string[]>(text, { skipEmptyLines: false }).data as string[][]

  // 年度（タイトルの「期間：YYYY年MM月～」）
  const title = (data[0]?.[0] ?? '') + (data[0]?.join(' ') ?? '')
  const tm = title.match(/(\d{4})年(\d{1,2})月/)
  let fiscalYear = ''
  if (tm) { const y = +tm[1], m = +tm[2]; fiscalYear = String(m >= 4 ? y : y - 1) }

  // ヘッダー行（YYYY-MM が並ぶ行）
  const hRow = data.findIndex((r) => r.some((c) => /^\d{4}-\d{2}$/.test(String(c).trim())))
  if (hRow < 0) return { fiscalYear, rows: [] }
  const monthCols: Record<string, number> = {}
  data[hRow].forEach((c, i) => { const s = String(c).trim(); if (/^\d{4}-\d{2}$/.test(s)) monthCols[s] = i })
  const months = Object.keys(monthCols).sort()
  if (!fiscalYear && months[0]) { const [y, m] = months[0].split('-').map(Number); fiscalYear = String(m >= 4 ? y : y - 1) }

  const labelOf = (r: string[]) => { for (let c = 0; c < 6; c++) { const v = String(r[c] ?? '').trim(); if (v) return { label: v, col: c } } return { label: '', col: -1 } }

  // 売上高計の行から「実績がある月」を判定
  let validMonths = months
  for (let i = hRow + 1; i < data.length; i++) {
    const { label } = labelOf(data[i])
    if (label === '売上高 計' || label === '売上高計') {
      validMonths = months.filter((m) => (num(data[i][monthCols[m]]) ?? 0) > 0)
      break
    }
  }

  const rows: PlActualRow[] = []
  const seen = new Set<string>()
  let curCat: string | null = null
  for (let i = hRow + 1; i < data.length; i++) {
    const r = data[i]
    const { label, col } = labelOf(r)
    if (!label) continue
    if (col === 0 && TOP_CATS.includes(label)) curCat = label
    // 数値が1つも無い行（節見出し）はスキップ
    if (!months.some((m) => num(r[monthCols[m]]) !== null)) continue
    const code = codeOf(label)
    for (const m of validMonths) {
      const k = m + '|' + code
      if (seen.has(k)) continue
      const v = num(r[monthCols[m]])
      if (v === null) continue
      seen.add(k)
      rows.push({ fiscal_year: fiscalYear, month: m, category: curCat, item_code: code, item_name: label, actual: v, prior_amount: null })
    }
  }
  return { fiscalYear, rows }
}
