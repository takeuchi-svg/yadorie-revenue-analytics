// 月次会議 構造化抽出（B10）: 自由記述 → 灯が「登録の提案」JSONを返す（自動登録はしない）。
// 承認・DB登録はクライアント側で既存パターン（raw_facility_initiative / dim_facility_profile）で行う。
import { NextRequest, NextResponse } from 'next/server'
import Anthropic from '@anthropic-ai/sdk'
import { requireUser, isAuthErr, facilityAllowed } from '@/lib/ai/auth'
import { buildFacilityContext } from '@/lib/ai/profile-context'
import { getPrompt } from '@/lib/ai/knowledge'
import { makeSupabase } from '@/lib/ai/agent'

export const runtime = 'nodejs'
export const maxDuration = 60
const MODEL = process.env.CHAT_MODEL || 'claude-sonnet-5'

export interface MeetingProposal {
  type: 'issue' | 'initiative' | 'policy'
  title?: string
  description?: string
  category?: string
  field?: string
  suggestion?: string
}

export async function POST(req: NextRequest) {
  const auth = await requireUser(req)
  if (isAuthErr(auth)) return NextResponse.json({ proposals: [], error: auth.error }, { status: auth.status })
  if (!process.env.ANTHROPIC_API_KEY) return NextResponse.json({ proposals: [], error: 'AIのAPIキー（ANTHROPIC_API_KEY）が未設定です。' })
  try {
    const { facility, month, text } = (await req.json()) as { facility?: string; month?: string; text?: string }
    if (!facility || !month || !text?.trim()) return NextResponse.json({ proposals: [], error: 'facility / month / text が必要です' }, { status: 400 })
    if (!facilityAllowed(auth, facility)) return NextResponse.json({ proposals: [], error: 'この宿の権限がありません。' }, { status: 403 })

    const sb = makeSupabase()
    const [taskPrompt, preamble] = await Promise.all([getPrompt(sb, 'meeting_extract'), getPrompt(sb, 'profile_context_template')])
    const profileCtx = await buildFacilityContext(sb, facility, preamble)
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
    const resp = await client.messages.create({
      model: MODEL, max_tokens: 2000, thinking: { type: 'disabled' },
      system: taskPrompt + profileCtx,
      messages: [{ role: 'user', content: `対象月: ${month}\n【会議記録（自由記述）】\n${text.slice(0, 8000)}` }],
    })
    const raw = resp.content.filter((c): c is Anthropic.TextBlock => c.type === 'text').map((c) => c.text).join('')
    const jsonStr = raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1)
    let proposals: MeetingProposal[] = []
    try {
      const parsed = JSON.parse(jsonStr) as { proposals?: MeetingProposal[] }
      proposals = (parsed.proposals ?? []).filter((p) => ['issue', 'initiative', 'policy'].includes(p.type))
    } catch { proposals = [] }
    return NextResponse.json({ proposals })
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ proposals: [], error: m }, { status: 500 })
  }
}
