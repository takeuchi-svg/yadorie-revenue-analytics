// 改善レポート生成（C4拡張）
//   期間内のネガ言及トピック上位3件について、
//   「課題の特定（なぜ改善候補か）」「解決策①②③（実施しやすい順）」をAIが生成。
//   引用(evidence)は raw_feedback_topic に保存済みの実クチコミ引用から採用（捏造防止）。
//   結果は raw_improvement_insight にキャッシュ（再生成は force=true）。
//   施設プロフィール（意図・NG・競合・取組履歴）を学習した状態で生成する（profile-context注入）。
import { NextRequest, NextResponse } from 'next/server'
import Anthropic from '@anthropic-ai/sdk'
import { createClient } from '@supabase/supabase-js'
import { requireUser, isAuthErr, facilityAllowed } from '@/lib/ai/auth'
import { buildFacilityContext } from '@/lib/ai/profile-context'

export const runtime = 'nodejs'
export const maxDuration = 60

const MODEL = process.env.CHAT_MODEL || 'claude-sonnet-4-6'
const MODEL_VERSION = 'v1'
const TOP_N = 3

const monthsBack = (m: string, k: number): string[] => {
  const y = +m.slice(0, 4), mo = +m.slice(5, 7); const out: string[] = []
  for (let i = 0; i < k; i++) { const d = new Date(Date.UTC(y, mo - 1 - i, 1)); out.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`) }
  return out
}

const SYSTEM = `あなたは旅館運営システム「YADORIE Core」のAI、若女将の灯（あかり）です。クチコミ分析で特定された課題トピックについて、支配人がそのまま行動に移せる改善レポートを作成します。
文体: 灯の語り口（丁寧だが堅すぎない。課題は事実として誠実に、しかし詰めずに前を向ける言葉で。おもてなし・お客様体験の視点を添える。裁かない）。数値・事実は正確に。
出力は次のJSONのみ（説明文・コードブロック記法は不要）:
{"insights":[{"topic_code":"<入力のまま>","problem":"課題の特定。なぜ改善候補なのか、引用が示す事実に基づいて2〜3文で。","solutions":[{"title":"短い施策名","detail":"具体的な実施内容を1〜2文","effort":"低"},{"title":"...","detail":"...","effort":"中"},{"title":"...","detail":"...","effort":"高"}]}]}
ルール:
- problem は提供された実際の引用・クチコミ本文が示す事実のみに基づく。憶測の事実を作らない
- solutions は必ず3件、【実施しやすい順】（①=今日から可能な運用改善 → ②=少額投資・仕組み変更 → ③=設備投資等の抜本策）。effort は 低/中/高
- 旅館の現場で現実的な施策にする（人員・費用の制約を考慮）`

/* eslint-disable @typescript-eslint/no-explicit-any */
export async function POST(req: NextRequest) {
  const auth = await requireUser(req)
  if (isAuthErr(auth)) return NextResponse.json({ error: auth.error }, { status: auth.status })
  if (!process.env.ANTHROPIC_API_KEY) return NextResponse.json({ error: 'ANTHROPIC_API_KEY が未設定です' }, { status: 500 })
  try {
    const { facility, month, window, force } = (await req.json()) as { facility?: string; month?: string; window?: number; force?: boolean }
    if (!facility || !month) return NextResponse.json({ error: 'facility / month が必要です' }, { status: 400 })
    if (!facilityAllowed(auth, facility)) return NextResponse.json({ error: 'この施設の権限がありません' }, { status: 403 })
    const win = [1, 3, 12].includes(window ?? 0) ? window! : 3
    const winMonths = monthsBack(month, win)

    const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })

    // キャッシュ（force以外）
    if (!force) {
      const { data: cached } = await sb.from('raw_improvement_insight')
        .select('topic_code, topic_label, problem, evidence, solutions')
        .eq('facility', facility).eq('month', month).eq('window_months', win).eq('model_version', MODEL_VERSION)
      if (cached && cached.length) return NextResponse.json({ insights: cached, cached: true })
    }

    // 期間内のトピック行（レビュー・アンケート由来）を収集
    const { data: topicRows } = await sb.from('raw_feedback_topic')
      .select('source_table, source_id, source_field, topic_code, topic_label, sentiment, quote')
      .eq('facility', facility).eq('model_version', MODEL_VERSION).neq('topic_code', '_none')
    const rows = (topicRows ?? []) as any[]
    if (!rows.length) return NextResponse.json({ insights: [], error: '先に「AI分析を実行」でトピック抽出を行ってください' })

    // 由来テキストの日付・メタを取得して期間フィルタ
    const revIds = [...new Set(rows.filter((r) => r.source_table === 'raw_review').map((r) => r.source_id))]
    const svIds = [...new Set(rows.filter((r) => r.source_table === 'raw_survey_response').map((r) => r.source_id))]
    const revMeta: Record<number, { month: string; date: string; source: string; rating: number | null; body: string | null }> = {}
    if (revIds.length) {
      const { data } = await sb.from('raw_review').select('id, review_date, source, overall_rating, rating_scale, body').in('id', revIds)
      for (const r of (data ?? []) as any[]) revMeta[r.id] = { month: r.review_date.slice(0, 7), date: r.review_date, source: r.source, rating: r.overall_rating != null ? Math.round(r.overall_rating * 50 / r.rating_scale) / 10 : null, body: r.body }
    }
    const svMeta: Record<number, { month: string; date: string }> = {}
    if (svIds.length) {
      const { data } = await sb.from('raw_survey_response').select('id, response_at').in('id', svIds)
      for (const r of (data ?? []) as any[]) svMeta[r.id] = { month: String(r.response_at).slice(0, 7), date: String(r.response_at).slice(0, 10) }
    }
    const winSet = new Set(winMonths)
    const inWin = rows.filter((r) => {
      const m = r.source_table === 'raw_review' ? revMeta[r.source_id]?.month : svMeta[r.source_id]?.month
      return m != null && winSet.has(m)
    })

    // ネガ言及数の上位トピック
    const agg: Record<string, { label: string; neg: number; rows: any[] }> = {}
    for (const r of inWin) {
      const a = (agg[r.topic_code] ??= { label: r.topic_label ?? r.topic_code, neg: 0, rows: [] })
      if (r.sentiment === 'negative') a.neg += 1
      a.rows.push(r)
    }
    const top = Object.entries(agg).map(([code, v]) => ({ code, ...v }))
      .filter((t) => t.neg > 0).sort((a, b) => b.neg - a.neg).slice(0, TOP_N)
    if (!top.length) return NextResponse.json({ insights: [], error: '期間内にネガティブ言及のあるトピックがありません' })

    // evidence（実引用）はサーバー側でDBのquoteから組み立て（AIに作らせない）
    const buildEvidence = (t: typeof top[number]) =>
      t.rows.filter((r) => r.quote && r.sentiment === 'negative').slice(0, 3).map((r) => {
        const meta = r.source_table === 'raw_review' ? revMeta[r.source_id] : svMeta[r.source_id]
        return {
          quote: r.quote,
          source: r.source_table === 'raw_review' ? (revMeta[r.source_id]?.source ?? 'web') : 'survey',
          review_date: (meta as any)?.date ?? null,
          rating: r.source_table === 'raw_review' ? revMeta[r.source_id]?.rating ?? null : null,
        }
      })

    // LLMへ: トピックごとの引用＋関連本文（要約用）を渡し、problem/solutionsを生成
    const payload = top.map((t) => ({
      topic_code: t.code, topic_label: t.label,
      negative_mentions: t.neg,
      quotes: t.rows.filter((r) => r.quote).map((r) => ({ sentiment: r.sentiment, quote: r.quote })).slice(0, 6),
      related_bodies: [...new Set(t.rows.filter((r) => r.source_table === 'raw_review').map((r) => revMeta[r.source_id]?.body).filter(Boolean))].slice(0, 4).map((b) => String(b).slice(0, 600)),
    }))
    // 施設プロフィール（意図・NG・競合・取組履歴）を前提として注入
    // → NGに反する解決策を出さない・既に実施済みの取組を「新規提案」しない
    const profileCtx = await buildFacilityContext(sb, facility)
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
    const resp = await client.messages.create({
      model: MODEL, max_tokens: 3500, system: SYSTEM + profileCtx,
      messages: [{ role: 'user', content: `施設のクチコミ分析結果です。各トピックの改善レポートを作成してください。\n${JSON.stringify(payload)}` }],
    })
    const raw = resp.content.filter((c): c is Anthropic.TextBlock => c.type === 'text').map((c) => c.text).join('')
    const parsed = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1)) as { insights: { topic_code: string; problem: string; solutions: { title: string; detail: string; effort: string }[] }[] }

    // 保存＆返却
    const out: any[] = []
    for (const t of top) {
      const ai = parsed.insights.find((i) => i.topic_code === t.code)
      const row = {
        facility, month, window_months: win, topic_code: t.code, topic_label: t.label,
        problem: ai?.problem ?? null,
        evidence: buildEvidence(t),
        solutions: (ai?.solutions ?? []).slice(0, 3),
        model_version: MODEL_VERSION,
      }
      out.push(row)
    }
    const { error } = await sb.from('raw_improvement_insight')
      .upsert(out, { onConflict: 'facility,month,window_months,topic_code,model_version' })
    if (error) throw error
    // 期間キーが変わった古い行はそのまま残す（履歴）。同キーは上書き。
    return NextResponse.json({ insights: out })
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: m }, { status: 500 })
  }
}
