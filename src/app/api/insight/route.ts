// 概要ページの AI実績サマリ / 課題と対策 を「キャッシュ優先・無ければ1回だけ生成して保存」する。
// 保存はサービスロールキーで確実に行うため、誰が開いても最初に生成された1つを全員が共有する。
import { NextRequest, NextResponse } from 'next/server'
import { runAgent, makeSupabase, hasApiKey } from '@/lib/ai/agent'
import { SUMMARY_PROMPT, ISSUE_PROMPT } from '@/lib/ai/prompts'
import { requireUser, isAuthErr, facilityAllowed } from '@/lib/ai/auth'

export const runtime = 'nodejs'
export const maxDuration = 60

export async function POST(req: NextRequest) {
  const auth = await requireUser(req)
  if (isAuthErr(auth)) return NextResponse.json({ content: '', error: auth.error }, { status: auth.status })
  try {
    const { facility, month, kind, force } = (await req.json()) as
      { facility?: string; month?: string; kind?: 'summary' | 'issue'; force?: boolean }
    if (!facility || !month || (kind !== 'summary' && kind !== 'issue')) {
      return NextResponse.json({ content: '', error: 'facility / month / kind が必要です' }, { status: 400 })
    }
    if (!facilityAllowed(auth, facility)) {
      return NextResponse.json({ content: '', error: 'この施設を閲覧する権限がありません。' }, { status: 403 })
    }
    const table = kind === 'summary' ? 'ai_summary' : 'ai_issue'
    const sb = makeSupabase()

    // キャッシュ優先（再生成押下時のみ作り直す）
    if (!force) {
      const { data } = await sb.from(table).select('content').eq('facility', facility).eq('month', month).maybeSingle()
      if (data?.content) return NextResponse.json({ content: data.content as string, cached: true })
    }

    if (!hasApiKey()) {
      return NextResponse.json({ content: '', error: 'AIのAPIキー（ANTHROPIC_API_KEY）が未設定です。' })
    }

    // 生成 → 保存（全員で共有）
    const prompt = kind === 'summary' ? SUMMARY_PROMPT(month) : ISSUE_PROMPT(month)
    const content = await runAgent([{ role: 'user', content: prompt }], facility, auth.facilities)
    if (content) {
      try {
        await sb.from(table).upsert(
          { facility, month, content }, { onConflict: 'facility,month' },
        )
      } catch { /* 保存失敗時も本文は返す */ }
    }
    return NextResponse.json({ content })
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ content: '', error: m }, { status: 500 })
  }
}
