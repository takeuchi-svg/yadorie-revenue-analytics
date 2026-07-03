import { NextRequest, NextResponse } from 'next/server'
import { runAgent, hasApiKey } from '@/lib/ai/agent'
import { requireUser, isAuthErr, facilityAllowed } from '@/lib/ai/auth'

export const runtime = 'nodejs'
export const maxDuration = 60

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
    const text = await runAgent(messages, facility, auth.facilities)
    return NextResponse.json({ reply: text || '回答の生成に時間がかかりました。質問を具体的にして再度お試しください。' })
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ reply: `エラー: ${m}` }, { status: 500 })
  }
}
