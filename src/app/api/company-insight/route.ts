// 全社Core（G6）: 灯（全社モード）の所見を「キャッシュ優先・無ければ生成して保存」。owner限定。
// 材料(material)はクライアント(company-data)で算出済みの全社集計テキストを受け取る（集計値のみ＝個人給与を含まない）。
import { NextRequest, NextResponse } from 'next/server'
import { runCompanyInsight, makeSupabase, hasApiKey } from '@/lib/ai/agent'
import { requireUser, isAuthErr } from '@/lib/ai/auth'

export const runtime = 'nodejs'
export const maxDuration = 60

export async function POST(req: NextRequest) {
  const auth = await requireUser(req)
  if (isAuthErr(auth)) return NextResponse.json({ content: '', error: auth.error }, { status: auth.status })
  if (!auth.isOwner) {
    return NextResponse.json({ content: '', error: '全社Coreはオーナーのみが利用できます。' }, { status: 403 })
  }
  try {
    const { month, material, force } = (await req.json()) as { month?: string; material?: string; force?: boolean }
    if (!month) return NextResponse.json({ content: '', error: 'month が必要です' }, { status: 400 })
    const sb = makeSupabase()

    // キャッシュ優先（再生成押下時のみ作り直す）
    if (!force) {
      const { data } = await sb.from('ai_company_insight').select('content, updated_at').eq('month', month).maybeSingle()
      if (data?.content) return NextResponse.json({ content: data.content as string, updatedAt: data.updated_at, cached: true })
      // 生成要求でない読み込み時は、キャッシュが無ければ空で返す（材料不要）
      if (!material) return NextResponse.json({ content: '' })
    }

    if (!hasApiKey()) {
      return NextResponse.json({ content: '', error: 'AIのAPIキー（ANTHROPIC_API_KEY）が未設定です。' })
    }
    if (!material) return NextResponse.json({ content: '', error: '生成用の全社データがありません。' }, { status: 400 })

    const content = await runCompanyInsight(month, material)
    if (content) {
      try {
        await sb.from('ai_company_insight').upsert(
          { month, content, updated_by: auth.userId, updated_at: new Date().toISOString() },
          { onConflict: 'month' },
        )
      } catch { /* 保存失敗時も本文は返す */ }
    }
    return NextResponse.json({ content })
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ content: '', error: m }, { status: 500 })
  }
}
