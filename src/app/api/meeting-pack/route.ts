// 月次会議パック（B9）: 灯が会議資料を生成 → ai_meeting_pack にキャッシュ。宿スコープ。
// 材料(material)はクライアント(meeting-data)で算出済みのテキストを受け取る（集計値のみ＝個人給与を含まない）。
import { NextRequest, NextResponse } from 'next/server'
import { runMeetingPack, makeSupabase, hasApiKey } from '@/lib/ai/agent'
import { requireUser, isAuthErr, facilityAllowed } from '@/lib/ai/auth'

export const runtime = 'nodejs'
export const maxDuration = 60

export async function POST(req: NextRequest) {
  const auth = await requireUser(req)
  if (isAuthErr(auth)) return NextResponse.json({ content: '', error: auth.error }, { status: auth.status })
  try {
    const { facility, month, material, force } = (await req.json()) as
      { facility?: string; month?: string; material?: string; force?: boolean }
    if (!facility || !month) return NextResponse.json({ content: '', error: 'facility / month が必要です' }, { status: 400 })
    if (!facilityAllowed(auth, facility)) return NextResponse.json({ content: '', error: 'この宿を閲覧する権限がありません。' }, { status: 403 })
    const sb = makeSupabase()

    if (!force) {
      const { data } = await sb.from('ai_meeting_pack').select('content, updated_at').eq('facility', facility).eq('month', month).maybeSingle()
      if (data?.content) return NextResponse.json({ content: data.content as string, updatedAt: data.updated_at, cached: true })
      if (!material) return NextResponse.json({ content: '' })  // 読込のみでキャッシュ無し
    }

    if (!hasApiKey()) return NextResponse.json({ content: '', error: 'AIのAPIキー（ANTHROPIC_API_KEY）が未設定です。' })
    if (!material) return NextResponse.json({ content: '', error: '生成用の会議データがありません。' }, { status: 400 })

    const content = await runMeetingPack(facility, month, material)
    if (content) {
      try {
        await sb.from('ai_meeting_pack').upsert(
          { facility, month, content, updated_by: auth.userId, updated_at: new Date().toISOString() },
          { onConflict: 'facility,month' },
        )
      } catch { /* 保存失敗時も本文は返す */ }
    }
    return NextResponse.json({ content })
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ content: '', error: m }, { status: 500 })
  }
}
