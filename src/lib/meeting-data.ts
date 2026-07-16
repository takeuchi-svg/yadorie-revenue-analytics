// 月次会議パック（B9）の材料生成。クライアントで算出済みテキストを /api/meeting-pack に渡す
// （全社Coreの buildCompanyMaterial と同方式。集計値のみ＝個人給与を含まない）。
// PLは pl-compute（yojitsuと同一ロジック）、定性は loadFacilityQualitative を再利用。

import type { SupabaseClient } from '@supabase/supabase-js'
import { fetchAll } from '@/lib/supabase/fetch-all'
import { fmtMan, fmtNum, pct } from '@/lib/ui'
import { makePlResolver, priorYM, type BudgetRow, type ActualRow } from '@/lib/pl-compute'
import { loadFacilityQualitative } from '@/lib/company/company-data'

/* eslint-disable @typescript-eslint/no-explicit-any */
const fyOf = (ym: string): number => { const y = +ym.slice(0, 4), m = +ym.slice(5, 7); return m >= 4 ? y : y - 1 }
const rr = (a: number | null, b: number | null | undefined) => (a != null && b ? a / b : null)
const money = (act: number | null, bud: number | null, prior: number | null) => {
  const rb = rr(act, bud), ry = rr(act, prior)
  return `${act == null ? '—' : fmtMan(act)}（予算比${rb == null ? '—' : pct(rb)} / 前年比${ry == null ? '—' : pct(ry)}）`
}

export async function buildMeetingMaterial(sb: SupabaseClient, facility: string, month: string): Promise<string> {
  const prior = priorYM(month)
  const fy = String(fyOf(month))
  const fyList = [fy, String(Number(fy) - 1)]
  const monthList = [month, prior]

  const [budget, actual, kpiTrend, occRows, laborRows, fb, nps, qual] = await Promise.all([
    fetchAll(() => sb.from('budget_monthly').select('facility, fiscal_year, month, category, item_code, item_name, amount, sort_order').eq('facility', facility).in('fiscal_year', fyList).eq('version', '当初').order('id')),
    fetchAll(() => sb.from('actual_monthly').select('facility, fiscal_year, month, item_code, actual').eq('facility', facility).in('fiscal_year', fyList).order('id')),
    fetchAll(() => sb.from('mart_monthly_kpi').select('month, revenue, guest_unit, guests, rooms_sold').eq('facility', facility).order('month', { ascending: false })),
    fetchAll(() => sb.from('mart_occupancy_monthly').select('month, occ, occ_calendar_days').eq('facility', facility)),
    fetchAll(() => sb.from('mart_labor_monthly').select('month, total_work_hours').eq('facility', facility).in('month', monthList)),
    sb.from('mart_guest_feedback_3mo').select('smoothed_avg, raw_avg, n').eq('facility', facility).eq('month', month).eq('channel', 'web').eq('axis_code', 'overall').maybeSingle().then((r) => r.data as any),
    sb.from('mart_nps').select('nps_score, n').eq('facility', facility).eq('month', month).maybeSingle().then((r) => r.data as any),
    loadFacilityQualitative(sb, facility),
  ])

  const R = makePlResolver({ budget: (budget as BudgetRow[]) ?? [], actual: (actual as ActualRow[]) ?? [], fy })
  const pl = (code: string) => ({ act: R.getActual(code, month), bud: R.getBudget(code, month), prior: R.getActual(code, prior) })
  const sales = pl('sales_total'), oi = pl('operating_income'), gop = pl('gop'), labor = pl('labor_total')

  const occByM: Record<string, any> = {}
  ;((occRows as any[]) ?? []).forEach((r) => { occByM[r.month] = r })
  const laborByM: Record<string, any> = {}
  ;((laborRows as any[]) ?? []).forEach((r) => { laborByM[r.month] = r })
  const kpiByM: Record<string, any> = {}
  ;((kpiTrend as any[]) ?? []).forEach((r) => { kpiByM[r.month] = r })

  const occOf = (m: string) => occByM[m]?.occ_calendar_days ?? occByM[m]?.occ ?? null

  // 生産性: 売上(mart) / 総労働時間
  const prodOf = (m: string) => { const rev = kpiByM[m]?.revenue, wh = laborByM[m]?.total_work_hours; return rev != null && wh ? rev / wh : null }

  const lines: string[] = [`対象月: ${month}（前年同月: ${prior}）`, '']

  lines.push('## 実績・予実（当月）')
  lines.push(`- 売上 ${money(sales.act, sales.bud, sales.prior)}`)
  lines.push(`- 営業利益 ${money(oi.act, oi.bud, oi.prior)}`)
  lines.push(`- GOP ${money(gop.act, gop.bud, gop.prior)}`)
  lines.push(`- 人件費率 ${rr(labor.act, sales.act) == null ? '—' : pct(rr(labor.act, sales.act))}（前年 ${rr(labor.prior, sales.prior) == null ? '—' : pct(rr(labor.prior, sales.prior))}）`)
  lines.push(`- OCC(全日) ${occOf(month) == null ? '—' : pct(occOf(month))}（前年 ${occOf(prior) == null ? '—' : pct(occOf(prior))}）`)
  lines.push(`- 客単価 ${kpiByM[month]?.guest_unit == null ? '—' : `¥${fmtNum(kpiByM[month].guest_unit)}`}（前年 ${kpiByM[prior]?.guest_unit == null ? '—' : `¥${fmtNum(kpiByM[prior].guest_unit)}`}）`)

  lines.push('', '## 生産性')
  lines.push(`- 1人1時間あたり売上 ${prodOf(month) == null ? '—' : `¥${fmtNum(prodOf(month))}`}（前年 ${prodOf(prior) == null ? '—' : `¥${fmtNum(prodOf(prior))}`}）${laborByM[month]?.total_work_hours == null ? '（勤怠未取込）' : ''}`)

  lines.push('', '## クチコミ・満足度')
  lines.push(`- 満足度(クチコミ総合・3ヶ月平滑) ${fb?.smoothed_avg ?? fb?.raw_avg ?? '—'} / NPS ${nps?.nps_score ?? '—'}`)
  if (qual.topics.length) lines.push(`- 改善トピック(ネガ言及の多い順): ${qual.topics.map((t) => `${t.label}(${t.negative})`).join(' / ')}`)

  // KPI推移（効果検証用・直近6ヶ月, 新しい順）
  const trendMonths = [...new Set(((kpiTrend as any[]) ?? []).map((r) => r.month))].sort().reverse().slice(0, 6)
  if (trendMonths.length) {
    lines.push('', '## KPI推移（効果検証用・新しい順）')
    for (const m of trendMonths) {
      const k = kpiByM[m]
      lines.push(`- ${m}: 売上 ${k?.revenue == null ? '—' : fmtMan(k.revenue)} / OCC ${occOf(m) == null ? '—' : pct(occOf(m))} / 客単価 ${k?.guest_unit == null ? '—' : `¥${fmtNum(k.guest_unit)}`}`)
    }
  }

  // 取組履歴（先月中心・効果検証の対象）
  if (qual.initiatives.length) {
    lines.push('', '## 取組履歴（先月中心・効果検証の対象）')
    for (const it of qual.initiatives) {
      lines.push(`- ${it.yearMonth} [${it.category ?? '-'}${it.status && it.status !== '実行' ? `/${it.status}` : ''}] ${it.title}${it.description ? `：${it.description}` : ''}`)
    }
  }

  // 宿の方針（前提）
  const pol: string[] = []
  if (qual.coreValue) pol.push(`中核価値=${qual.coreValue}`)
  if (qual.managementPolicy) pol.push(`運営方針=${qual.managementPolicy}`)
  if (qual.ngItems) pol.push(`避けたいこと=${qual.ngItems}`)
  if (pol.length) { lines.push('', '## 宿の方針（前提）'); pol.forEach((p) => lines.push(`- ${p}`)) }

  return lines.join('\n')
}
