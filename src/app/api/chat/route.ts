import { NextRequest, NextResponse } from 'next/server'
import { runAgent, hasApiKey } from '@/lib/ai/agent'

export const runtime = 'nodejs'
export const maxDuration = 60

export async function POST(req: NextRequest) {
  if (!hasApiKey()) {
    return NextResponse.json({ reply: 'AIのAPIキー（ANTHROPIC_API_KEY）が未設定です。Vercelの環境変数に設定してください。' })
  }
  try {
    const { messages, facility } = (await req.json()) as { messages: { role: 'user' | 'assistant'; content: string }[]; facility?: string }
    const text = await runAgent(messages, facility)
    return NextResponse.json({ reply: text || '回答の生成に時間がかかりました。質問を具体的にして再度お試しください。' })
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ reply: `エラー: ${m}` }, { status: 500 })
  }
}
