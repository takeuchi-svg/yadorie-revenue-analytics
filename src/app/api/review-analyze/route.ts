// クチコミ・アンケート自由記述のAI定性分析バッチ（C4）
//   未分析テキストを最大8件/回まとめて1回のLLM呼び出しで処理し、raw_feedback_topic へ保存。
//   model_version 管理（ロジック改善時はバージョンを上げて再実行→別行として蓄積）。
//   トピック0件のテキストには '_none' マーカーを入れて再分析対象から外す。
import { NextRequest, NextResponse } from 'next/server'
import Anthropic from '@anthropic-ai/sdk'
import { createClient } from '@supabase/supabase-js'
import { requireUser, isAuthErr, facilityAllowed } from '@/lib/ai/auth'
import { buildFacilityContext } from '@/lib/ai/profile-context'
import { getPrompt } from '@/lib/ai/knowledge'

export const runtime = 'nodejs'
export const maxDuration = 60

const MODEL = process.env.CHAT_MODEL || 'claude-sonnet-5'
const MODEL_VERSION = 'v1'
const BATCH = 8

// プロンプト正本はDB(ai_prompt 'review_analyze')。⑤は灯人格でなく「クチコミ分析の専門家」（仕様どおり）

/* eslint-disable @typescript-eslint/no-explicit-any */
export async function POST(req: NextRequest) {
  const auth = await requireUser(req)
  if (isAuthErr(auth)) return NextResponse.json({ error: auth.error }, { status: auth.status })
  if (!process.env.ANTHROPIC_API_KEY) return NextResponse.json({ error: 'ANTHROPIC_API_KEY が未設定です' }, { status: 500 })
  try {
    const { facility } = (await req.json()) as { facility?: string }
    if (!facility) return NextResponse.json({ error: 'facility が必要です' }, { status: 400 })
    if (!facilityAllowed(auth, facility)) return NextResponse.json({ error: 'この施設の権限がありません' }, { status: 403 })

    const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })

    // 分析済み (table:id:field) の集合
    const { data: done } = await sb.from('raw_feedback_topic')
      .select('source_table, source_id, source_field')
      .eq('facility', facility).eq('model_version', MODEL_VERSION)
    const doneSet = new Set(((done ?? []) as any[]).map((d) => `${d.source_table}:${d.source_id}:${d.source_field}`))

    // 候補テキストの収集
    type Item = { key: string; table: string; id: number; field: string; text: string }
    const items: Item[] = []
    const { data: reviews } = await sb.from('raw_review')
      .select('id, title, body').eq('facility', facility).not('body', 'is', null).order('id')
    for (const r of (reviews ?? []) as any[]) {
      const text = [r.title, r.body].filter(Boolean).join('\n')
      if (text.trim() && !doneSet.has(`raw_review:${r.id}:body`)) {
        items.push({ key: `raw_review:${r.id}:body`, table: 'raw_review', id: r.id, field: 'body', text })
      }
    }
    const { data: surveys } = await sb.from('raw_survey_response')
      .select('id, good_point, improvement_point, low_score_reason').eq('facility', facility).order('id')
    for (const s of (surveys ?? []) as any[]) {
      for (const f of ['good_point', 'improvement_point', 'low_score_reason'] as const) {
        const t = (s[f] ?? '').trim()
        if (t && !doneSet.has(`raw_survey_response:${s.id}:${f}`)) {
          items.push({ key: `raw_survey_response:${s.id}:${f}`, table: 'raw_survey_response', id: s.id, field: f, text: t })
        }
      }
    }

    const total = items.length
    if (total === 0) return NextResponse.json({ analyzed: 0, remaining: 0 })
    const batch = items.slice(0, BATCH)

    // 1回のLLM呼び出しでバッチ全件を分析（施設プロフィール=意図・方針を前提として注入）
    const [taskPrompt, preamble] = await Promise.all([
      getPrompt(sb, 'review_analyze'),
      getPrompt(sb, 'profile_context_template'),
    ])
    const profileCtx = await buildFacilityContext(sb, facility, preamble)
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
    const user = `施設のクチコミ/アンケート自由記述です。各テキストのトピックを抽出してください。\n` +
      JSON.stringify(batch.map((b) => ({ key: b.key, text: b.text.slice(0, 1500) })), null, 0)
    const resp = await client.messages.create({ model: MODEL, max_tokens: 3000, system: taskPrompt + profileCtx, messages: [{ role: 'user', content: user }] })
    const raw = resp.content.filter((c): c is Anthropic.TextBlock => c.type === 'text').map((c) => c.text).join('')
    const jsonStr = raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1)
    const parsed = JSON.parse(jsonStr) as { results: { key: string; topics: { code: string; label: string; sentiment: string; quote?: string }[] }[] }

    // 保存（トピック0件は '_none' マーカー）
    const rows: any[] = []
    for (const b of batch) {
      const res = parsed.results.find((r) => r.key === b.key)
      const topics = (res?.topics ?? []).filter((t) => t.code && ['positive', 'negative', 'neutral'].includes(t.sentiment)).slice(0, 5)
      if (topics.length === 0) {
        rows.push({ facility, source_table: b.table, source_id: b.id, source_field: b.field, topic_code: '_none', topic_label: null, sentiment: 'neutral', quote: null, model_version: MODEL_VERSION })
      } else {
        for (const t of topics) {
          rows.push({ facility, source_table: b.table, source_id: b.id, source_field: b.field, topic_code: t.code.slice(0, 60), topic_label: (t.label ?? t.code).slice(0, 30), sentiment: t.sentiment, quote: (t.quote ?? '').slice(0, 120) || null, model_version: MODEL_VERSION })
        }
      }
    }
    const { error } = await sb.from('raw_feedback_topic')
      .upsert(rows, { onConflict: 'source_table,source_id,source_field,topic_code,model_version', ignoreDuplicates: true })
    if (error) throw error

    return NextResponse.json({ analyzed: batch.length, remaining: total - batch.length })
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: m }, { status: 500 })
  }
}
