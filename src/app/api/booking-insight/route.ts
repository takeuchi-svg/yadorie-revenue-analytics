// M8 予約日ベース所見: 灯が前年比の異変検知・分解・施策照合 → ai_booking_insight(facility, as_of) にキャッシュ。宿スコープ。
import { NextRequest, NextResponse } from 'next/server'
import { runBookingInsight, makeSupabase, hasApiKey } from '@/lib/ai/agent'
import { requireUser, isAuthErr, facilityAllowed } from '@/lib/ai/auth'

export const runtime = 'nodejs'
export const maxDuration = 60

export async function POST(req: NextRequest) {
  const auth = await requireUser(req)
  if (isAuthErr(auth)) return NextResponse.json({ content: '', error: auth.error }, { status: auth.status })
  try {
    const { facility, asOf, material, force } = (await req.json()) as { facility?: string; asOf?: string; material?: string; force?: boolean }
    if (!facility || !asOf) return NextResponse.json({ content: '', error: 'facility / asOf が必要です' }, { status: 400 })
    if (!facilityAllowed(auth, facility)) return NextResponse.json({ content: '', error: 'この宿を閲覧する権限がありません。' }, { status: 403 })
    const sb = makeSupabase()

    if (!force) {
      const { data } = await sb.from('ai_booking_insight').select('content, updated_at').eq('facility', facility).eq('as_of', asOf).maybeSingle()
      if (data?.content) return NextResponse.json({ content: data.content as string, updatedAt: data.updated_at, cached: true })
      if (!material) return NextResponse.json({ content: '' })
    }

    if (!hasApiKey()) return NextResponse.json({ content: '', error: 'AIのAPIキー（ANTHROPIC_API_KEY）が未設定です。' })
    if (!material) return NextResponse.json({ content: '', error: '分析用の予約データがありません。' }, { status: 400 })

    const content = await runBookingInsight(facility, asOf, material)
    if (content) {
      try {
        await sb.from('ai_booking_insight').upsert(
          { facility, as_of: asOf, content, updated_by: auth.userId, updated_at: new Date().toISOString() },
          { onConflict: 'facility,as_of' },
        )
      } catch { /* 保存失敗時も本文は返す */ }
    }
    return NextResponse.json({ content })
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ content: '', error: m }, { status: 500 })
  }
}
