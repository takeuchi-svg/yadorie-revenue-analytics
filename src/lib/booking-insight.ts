// M8 灯の予約日ベース所見: 前年同期比の異変・OTA/室数/単価の分解・施策照合の材料を作り /api/booking-insight へ。
// 人格(層1)・会社軸(層2)・宿プロフィール(層3)は buildSystemBlocks(facility) で注入されるので材料には含めない。
import type { SupabaseClient } from '@supabase/supabase-js'
import { supabase } from '@/lib/supabase/client'
import { fetchAll } from '@/lib/supabase/fetch-all'
import { fmtMan } from '@/lib/ui'

/* eslint-disable @typescript-eslint/no-explicit-any */
const shiftYr = (k: string) => `${Number(k.slice(0, 4)) - 1}${k.slice(4)}`
const yoy = (cur: number, prev: number) => (prev > 0 ? `前年比${Math.round((cur / prev) * 100)}%` : '前年データなし')
const adr = (rn: number, rev: number) => (rn > 0 ? fmtMan(Math.round(rev / rn)) : '—')

export async function buildBookingInsightMaterial(sb: SupabaseClient, facility: string, asOf: string): Promise<string> {
  const [flow, onhand, actions] = await Promise.all([
    fetchAll<any>(() => sb.from('mart_booking_flow').select('flow_date, channel, new_room_nights, new_revenue').eq('facility', facility)).catch(() => []),
    fetchAll<any>(() => sb.from('mart_onhand').select('stay_date, channel, rooms').eq('facility', facility)).catch(() => []),
    fetchAll<any>(() => sb.from('raw_marketing_action').select('channel, action_type, title, start_date, end_date').eq('facility', facility)).catch(() => []),
  ])

  // 予約日ベース 月次（新規予約）
  const bm: Record<string, { rn: number; rev: number }> = {}
  for (const r of flow as any[]) { const m = r.flow_date.slice(0, 7); (bm[m] ??= { rn: 0, rev: 0 }); bm[m].rn += r.new_room_nights ?? 0; bm[m].rev += r.new_revenue ?? 0 }
  const bmonths = Object.keys(bm).sort()
  const recent = bmonths.slice(-8)

  const lines: string[] = [`予約日ベース分析の材料（${asOf}時点・金額=万円）`, '', '## 予約日ベース 月次（新規予約・直近8ヶ月／前年同月比）']
  for (const m of recent) {
    const c = bm[m]; const p = bm[shiftYr(m)]
    lines.push(`- ${m}予約分: 室泊 ${c.rn}（${p ? yoy(c.rn, p.rn) : '前年データなし'}） / 金額 ${fmtMan(c.rev)}（${p ? yoy(c.rev, p.rev) : '前年データなし'}） / 室単価 ${adr(c.rn, c.rev)}`)
  }

  // 予約日ベース OTA別（直近3ヶ月合計・室泊の当年/前年）
  const last3 = recent.slice(-3)
  const chAcc: Record<string, { cur: number; prev: number; rev: number }> = {}
  for (const r of flow as any[]) {
    const m = r.flow_date.slice(0, 7)
    if (last3.includes(m)) { (chAcc[r.channel] ??= { cur: 0, prev: 0, rev: 0 }); chAcc[r.channel].cur += r.new_room_nights ?? 0; chAcc[r.channel].rev += r.new_revenue ?? 0 }
    if (last3.map(shiftYr).includes(m)) { (chAcc[r.channel] ??= { cur: 0, prev: 0, rev: 0 }); chAcc[r.channel].prev += r.new_room_nights ?? 0 }
  }
  lines.push('', `## 予約日ベース OTA別（直近3ヶ月 ${last3[0] ?? ''}〜${last3[last3.length - 1] ?? ''} の新規室泊・前年同期比）`)
  for (const [ch, v] of Object.entries(chAcc).sort((a, b) => b[1].cur - a[1].cur))
    lines.push(`- ${ch}: 室泊 ${v.cur}（${yoy(v.cur, v.prev)}） / 室単価 ${adr(v.cur, v.rev)}`)

  // オンハンド（宿泊日ベース・今後6ヶ月の現在の入り）
  const om: Record<string, number> = {}; const omByCh: Record<string, Record<string, number>> = {}
  for (const r of onhand as any[]) { const m = r.stay_date.slice(0, 7); om[m] = (om[m] ?? 0) + (r.rooms ?? 0); (omByCh[m] ??= {}); omByCh[m][r.channel] = (omByCh[m][r.channel] ?? 0) + (r.rooms ?? 0) }
  const future = Object.keys(om).filter((m) => m >= asOf).sort().slice(0, 6)
  lines.push('', '## オンハンド（宿泊日ベース・今後6ヶ月・現在の入り室数）※前年同時点は蓄積待ちのため未提供')
  for (const m of future) {
    const top = Object.entries(omByCh[m] ?? {}).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([c, v]) => `${c}${v}`).join('・')
    lines.push(`- ${m}宿泊: ${om[m]}室（${top}）`)
  }

  // 施策（直近8ヶ月）
  const cutoff = shiftYr(asOf) // 約1年前まで含める
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
