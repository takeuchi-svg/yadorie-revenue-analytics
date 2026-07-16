// B6 灯の予算レビュー: 来期予算 vs 前年実績/前年予算 を材料化して /api/budget-review へ。
// 基準PL(施設タイプ)・宿の意図・取組履歴は buildSystemBlocks(facility) の層3で注入されるので材料には含めない。
import type { SupabaseClient } from '@supabase/supabase-js'
import { supabase } from '@/lib/supabase/client'
import { fetchAll } from '@/lib/supabase/fetch-all'
import { fmtMan, pct } from '@/lib/ui'

/* eslint-disable @typescript-eslint/no-explicit-any */
const CODES = ['sales_total', 'cogs_total', 'labor_total', 'sga_total', 'gop', 'operating_income'] as const
const fyMonths = (fy: number): string[] => {
  const out: string[] = []
  for (let m = 4; m <= 12; m++) out.push(`${fy}-${String(m).padStart(2, '0')}`)
  for (let m = 1; m <= 3; m++) out.push(`${fy + 1}-${String(m).padStart(2, '0')}`)
  return out
}
const r = (a: number, b: number) => (b ? pct(a / b) : '—')

export async function buildBudgetReviewMaterial(sb: SupabaseClient, facility: string, fy: number): Promise<string> {
  const [budFy, actPrev, budPrev] = await Promise.all([
    fetchAll(() => sb.from('budget_monthly').select('month, item_code, amount').eq('facility', facility).eq('version', '当初').eq('fiscal_year', String(fy)).in('item_code', CODES as any)).catch(() => []),
    fetchAll(() => sb.from('actual_monthly').select('month, item_code, actual').eq('facility', facility).eq('fiscal_year', String(fy - 1)).in('item_code', CODES as any)).catch(() => []),
    fetchAll(() => sb.from('budget_monthly').select('month, item_code, amount').eq('facility', facility).eq('version', '当初').eq('fiscal_year', String(fy - 1)).in('item_code', CODES as any)).catch(() => []),
  ])
  const yr = (rows: any[], field: string) => {
    const g = (code: string) => (rows as any[]).filter((x) => x.item_code === code).reduce((s, x) => s + (Number(x[field]) || 0), 0)
    return { sales: g('sales_total'), cogs: g('cogs_total'), labor: g('labor_total'), sga: g('sga_total'), gop: g('gop'), oi: g('operating_income') }
  }
  const line = (label: string, y: ReturnType<typeof yr>) =>
    `- ${label}: 売上 ${fmtMan(y.sales)} / 原価 ${fmtMan(y.cogs)}(${r(y.cogs, y.sales)}) / 人件費 ${fmtMan(y.labor)}(${r(y.labor, y.sales)}) / 販管費 ${fmtMan(y.sga)}(${r(y.sga, y.sales)}) / GOP ${fmtMan(y.gop)}(${r(y.gop, y.sales)}) / 営業利益 ${fmtMan(y.oi)}(${r(y.oi, y.sales)})`

  // 月次売上（来期予算 vs 前年実績）で繁閑パターンの整合を見る
  const salesByMonth = (rows: any[], field: string, shift: number) => {
    const o: Record<string, number> = {}
    ;(rows as any[]).filter((x) => x.item_code === 'sales_total').forEach((x) => { const m = `${+String(x.month).slice(0, 4) + shift}${String(x.month).slice(4)}`; o[m] = (o[m] ?? 0) + (Number(x[field]) || 0) })
    return o
  }
  const budM = salesByMonth(budFy as any[], 'amount', 0)
  const actM = salesByMonth(actPrev as any[], 'actual', 1)  // 前年実績を来期の月に合わせる

  const lines: string[] = [
    `${fy}年度予算のレビュー材料（金額=万円・率=対売上）`, '',
    '## 来期予算（年間）', line('来期予算', yr(budFy as any[], 'amount')),
    '', '## 前年実績（年間）', line('前年実績', yr(actPrev as any[], 'actual')),
    '', '## 前年予算（年間）', line('前年予算', yr(budPrev as any[], 'amount')),
    '', '## 月次の売上（来期予算 / 前年実績）',
  ]
  for (const m of fyMonths(fy)) lines.push(`- ${m}: 予算 ${budM[m] == null ? '—' : fmtMan(budM[m])} / 前年実績 ${actM[m] == null ? '—' : fmtMan(actM[m])}`)
  return lines.join('\n')
}

/* ===== load / generate（会議レポートと同方式・キャッシュ ai_budget_review(facility,fiscal_year)） ===== */
async function authedPost(url: string, body: unknown) {
  const { data: { session } } = await supabase.auth.getSession()
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(session ? { Authorization: `Bearer ${session.access_token}` } : {}) }, body: JSON.stringify(body) })
  return res.json()
}
export async function loadBudgetReview(facility: string, fy: number): Promise<string> {
  const r0 = await authedPost('/api/budget-review', { facility, fy })
  return (r0?.content as string) || ''
}
export async function generateBudgetReview(facility: string, fy: number): Promise<{ content: string; error?: string }> {
  const material = await buildBudgetReviewMaterial(supabase, facility, fy)
  const r0 = await authedPost('/api/budget-review', { facility, fy, material, force: true })
  return { content: (r0?.content as string) || '', error: r0?.error as string | undefined }
}
