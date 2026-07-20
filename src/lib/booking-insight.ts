// 灯の売上状況所見: 売上分析の全体（実績＋オンハンド＋予約日ベース）を、予算比・前年比・前年同日比で
// 異変検知する材料を作り /api/booking-insight へ。人格/会社軸/宿プロフィールは buildSystemBlocks で注入。
import type { SupabaseClient } from '@supabase/supabase-js'
import { supabase } from '@/lib/supabase/client'
import { fetchAll } from '@/lib/supabase/fetch-all'
import { fmtMan } from '@/lib/ui'

/* eslint-disable @typescript-eslint/no-explicit-any */
const ALIVE = new Set(['未確認', '予約確定', '重要予約', 'C/O'])
const shiftYr = (k: string) => `${Number(k.slice(0, 4)) - 1}${k.slice(4)}`
const yoy = (cur: number, prev: number | null | undefined) => (prev && prev > 0 ? `前年比${Math.round((cur / prev) * 100)}%` : '前年—')
const rat = (a: number, b: number | null | undefined, label: string) => (b && b > 0 ? `${label}${Math.round((a / b) * 100)}%` : `${label}—`)
const todayISO = () => new Date().toISOString().slice(0, 10)

export async function buildBookingInsightMaterial(sb: SupabaseClient, facility: string, asOf: string): Promise<string> {
  const today = todayISO()
  const tPrev = shiftYr(today)             // 前年の同じ日付（前年同日の基準時点）
  const from = `${Number(asOf.slice(0, 4)) - 2}-01-01`
  const [resv, flow, onhand, actions, budget, occ, kpi] = await Promise.all([
    fetchAll<any>(() => sb.from('raw_reservation').select('checkin, nights, revenue_settled, channel, status, booking_date, cancel_date').eq('facility', facility).gte('checkin', from)).catch(() => []),
    fetchAll<any>(() => sb.from('mart_booking_flow').select('flow_date, channel, new_room_nights, new_revenue').eq('facility', facility)).catch(() => []),
    fetchAll<any>(() => sb.from('mart_onhand').select('stay_date, channel, rooms, revenue').eq('facility', facility)).catch(() => []),
    fetchAll<any>(() => sb.from('raw_marketing_action').select('channel, action_type, title, start_date, end_date').eq('facility', facility)).catch(() => []),
    fetchAll<any>(() => sb.from('mart_budget_daily_monthly').select('month, revenue_budget').eq('facility', facility)).catch(() => []),
    fetchAll<any>(() => sb.from('mart_occupancy_monthly').select('month, occ, occ_calendar_days').eq('facility', facility)).catch(() => []),
    fetchAll<any>(() => sb.from('mart_monthly_kpi').select('month, adr, guest_unit').eq('facility', facility)).catch(() => []),
  ])
  const budMap: Record<string, number> = {}; for (const b of budget as any[]) if (b.revenue_budget != null) budMap[b.month] = b.revenue_budget
  const occMap: Record<string, number> = {}; for (const o of occ as any[]) { const v = o.occ_calendar_days ?? o.occ; if (v != null) occMap[o.month] = v }
  const adrMap: Record<string, number> = {}; const guMap: Record<string, number> = {}
  for (const k of kpi as any[]) { if (k.adr != null) adrMap[k.month] = k.adr; if (k.guest_unit != null) guMap[k.month] = k.guest_unit }

  const aliveNow = (r: any) => ALIVE.has(r.status ?? '')
  const aliveAt = (r: any, T: string) => !!r.booking_date && r.booking_date <= T && (r.status !== 'キャンセル' || (!!r.cancel_date && r.cancel_date > T))
  // 宿泊月別: 現在の生存売上 / 前年同日時点の売上
  const salesNow: Record<string, number> = {}; const salesPrevSame: Record<string, number> = {}
  for (const r of resv as any[]) {
    const m = (r.checkin ?? '').slice(0, 7); if (!m) continue
    if (aliveNow(r)) salesNow[m] = (salesNow[m] ?? 0) + (r.revenue_settled ?? 0)
    if (aliveAt(r, tPrev)) salesPrevSame[m] = (salesPrevSame[m] ?? 0) + (r.revenue_settled ?? 0)
  }
  const curM = today.slice(0, 7)
  const allMonths = [...new Set(Object.keys(salesNow))].sort()
  const pastMonths = allMonths.filter((m) => m < curM).slice(-6)
  const pct1 = (v: number | null | undefined) => (v == null ? '—' : `${(v * 100).toFixed(1)}%`)

  const lines: string[] = [`売上状況の材料（${asOf}時点・金額=万円・前年同日=1年前の同じ日${tPrev}時点の入り）`]

  // ── 実績（宿泊月・直近6ヶ月・予算比/前年比） ──
  lines.push('', '## 実績（確定した宿泊月・直近6ヶ月）')
  for (const m of pastMonths) {
    const pm = shiftYr(m)
    const s = salesNow[m] ?? 0
    const occLine = occMap[m] != null ? `OCC ${pct1(occMap[m])}（${occMap[pm] != null ? yoy(occMap[m], occMap[pm]) : '前年—'}）` : 'OCC—'
    const adrLine = adrMap[m] != null ? `室単価 ${fmtMan(adrMap[m])}（${adrMap[pm] != null ? yoy(adrMap[m], adrMap[pm]) : '前年—'}）` : ''
    const guLine = guMap[m] != null ? `客単価 ${fmtMan(guMap[m])}（${guMap[pm] != null ? yoy(guMap[m], guMap[pm]) : '前年—'}）` : ''
    lines.push(`- ${m}: 売上 ${fmtMan(s)}（${rat(s, budMap[m], '予算比')} / ${yoy(s, salesNow[pm])}） / ${occLine} / ${adrLine} / ${guLine}`)
  }

  // ── オンハンド（今後の宿泊月・対予算/前年同日比） ──
  const om: Record<string, number> = {}; const omRev: Record<string, number> = {}; const omByCh: Record<string, Record<string, number>> = {}
  for (const r of onhand as any[]) {
    const m = r.stay_date.slice(0, 7)
    om[m] = (om[m] ?? 0) + (r.rooms ?? 0); omRev[m] = (omRev[m] ?? 0) + (r.revenue ?? 0)
    ;(omByCh[m] ??= {}); omByCh[m][r.channel] = (omByCh[m][r.channel] ?? 0) + (r.rooms ?? 0)
  }
  const future = Object.keys(om).filter((m) => m >= curM).sort().slice(0, 6)
  lines.push('', '## オンハンド（今後の宿泊月・現在の入り・対予算/前年同日比）')
  for (const m of future) {
    const pm = shiftYr(m)
    const top = Object.entries(omByCh[m] ?? {}).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([c, v]) => `${c}${v}室`).join('・')
    lines.push(`- ${m}宿泊: ${om[m]}室 / 売上 ${fmtMan(omRev[m] ?? 0)}（${rat(omRev[m] ?? 0, budMap[m], '対予算')} / 前年同日比${salesPrevSame[pm] > 0 ? Math.round(((omRev[m] ?? 0) / salesPrevSame[pm]) * 100) + '%' : '—'}）（${top}）`)
  }

  // ── 予約日ベース（施策の効き・新規予約の前年同月比） ──
  const bm: Record<string, { rn: number; rev: number }> = {}
  for (const r of flow as any[]) { const m = r.flow_date.slice(0, 7); (bm[m] ??= { rn: 0, rev: 0 }); bm[m].rn += r.new_room_nights ?? 0; bm[m].rev += r.new_revenue ?? 0 }
  const recent = Object.keys(bm).sort().slice(-6)
  lines.push('', '## 予約日ベース（いつ予約が入ったか＝施策の効き・直近6ヶ月・前年同月比）')
  for (const m of recent) { const c = bm[m]; const p = bm[shiftYr(m)]; lines.push(`- ${m}予約分: 金額 ${fmtMan(c.rev)}（${yoy(c.rev, p?.rev)}） / 室泊 ${c.rn}（${yoy(c.rn, p?.rn)}）`) }

  // ── 施策（約1年内） ──
  const cutoff = shiftYr(asOf)
  const acts = (actions as any[]).filter((a) => (a.end_date ?? a.start_date) >= cutoff).sort((a, b) => a.start_date.localeCompare(b.start_date))
  lines.push('', '## 施策の記録（約1年内）')
  if (acts.length === 0) lines.push('- 記録なし')
  else for (const a of acts) lines.push(`- ${a.start_date}${a.end_date && a.end_date !== a.start_date ? `〜${a.end_date}` : ''}: [${a.action_type}] ${a.title}（${a.channel ?? '全体'}）`)

  return lines.join('\n')
}

/* ===== load / generate（キャッシュ ai_booking_insight(facility, as_of)） ===== */
async function authedPost(url: string, body: unknown) {
  const { data: { session } } = await supabase.auth.getSession()
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(session ? { Authorization: `Bearer ${session.access_token}` } : {}) }, body: JSON.stringify(body) })
  return res.json()
}
export async function loadBookingInsight(facility: string, asOf: string): Promise<{ content: string; updatedAt?: string }> {
  const r0 = await authedPost('/api/booking-insight', { facility, asOf })
  return { content: (r0?.content as string) || '', updatedAt: r0?.updatedAt as string | undefined }
}
export async function generateBookingInsight(facility: string, asOf: string): Promise<{ content: string; error?: string }> {
  const material = await buildBookingInsightMaterial(supabase, facility, asOf)
  const r0 = await authedPost('/api/booking-insight', { facility, asOf, material, force: true })
  return { content: (r0?.content as string) || '', error: r0?.error as string | undefined }
}
