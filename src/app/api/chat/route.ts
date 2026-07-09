import { NextRequest, NextResponse } from 'next/server'
import { runAgentStream, hasApiKey } from '@/lib/ai/agent'
import { requireUser, isAuthErr, facilityAllowed } from '@/lib/ai/auth'

export const runtime = 'nodejs'
export const maxDuration = 60

// 成功時は text/plain のストリーム（トークン逐次配信）、エラー時は JSON({reply}) を返す。
// クライアント(ai-drawer)は Content-Type で分岐する。
export async function POST(req: NextRequest) {
  const auth = await requireUser(req)
  if (isAuthErr(auth)) return NextResponse.json({ reply: auth.error }, { status: auth.status })
  if (!hasApiKey()) {
    return NextResponse.json({ reply: 'AIのAPIキー（ANTHROPIC_API_KEY）が未設定です。Vercelの環境変数に設定してください。' })
  }
  try {
    const { messages, facility } = (await req.json()) as { messages: { role: 'user' | 'assistant'; content: string }[]; facility?: string }
    if (!facilityAllowed(auth, facility)) {
      return NextResponse.json({ reply: 'この施設を閲覧する権限がありません。' }, { status: 403 })
    }
    const stream = await runAgentStream(messages, facility)
    return new Response(stream, {
      headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', 'X-Accel-Buffering': 'no' },
    })
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ reply: `エラー: ${m}` }, { status: 500 })
  }
}
