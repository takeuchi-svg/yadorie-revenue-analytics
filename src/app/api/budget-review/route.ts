// B6 予算レビュー: 灯が来期予算をレビュー → ai_budget_review(facility,fiscal_year) にキャッシュ。宿スコープ。
import { NextRequest, NextResponse } from 'next/server'
import { runBudgetReview, makeSupabase, hasApiKey } from '@/lib/ai/agent'
import { requireUser, isAuthErr, facilityAllowed } from '@/lib/ai/auth'

export const runtime = 'nodejs'
export const maxDuration = 300  // 分析系: Opus+adaptive thinkingの熟考生成(Vercel Fluid Compute前提)

export async function POST(req: NextRequest) {
  const auth = await requireUser(req)
  if (isAuthErr(auth)) return NextResponse.json({ content: '', error: auth.error }, { status: auth.status })
  try {
    const { facility, fy, material, force } = (await req.json()) as { facility?: string; fy?: number; material?: string; force?: boolean }
    if (!facility || fy == null) return NextResponse.json({ content: '', error: 'facility / fy が必要です' }, { status: 400 })
    if (!facilityAllowed(auth, facility)) return NextResponse.json({ content: '', error: 'この宿を閲覧する権限がありません。' }, { status: 403 })
    const sb = makeSupabase()

    if (!force) {
      const { data } = await sb.from('ai_budget_review').select('content, updated_at').eq('facility', facility).eq('fiscal_year', String(fy)).maybeSingle()
      if (data?.content) return NextResponse.json({ content: data.content as string, updatedAt: data.updated_at, cached: true })
      if (!material) return NextResponse.json({ content: '' })
    }

    if (!hasApiKey()) return NextResponse.json({ content: '', error: 'AIのAPIキー（ANTHROPIC_API_KEY）が未設定です。' })
    if (!material) return NextResponse.json({ content: '', error: 'レビュー用の予算データがありません。' }, { status: 400 })

    const content = await runBudgetReview(facility, fy, material)
    if (content) {
      try {
        await sb.from('ai_budget_review').upsert(
          { facility, fiscal_year: String(fy), content, updated_by: auth.userId, updated_at: new Date().toISOString() },
          { onConflict: 'facility,fiscal_year' },
        )
      } catch { /* 保存失敗時も本文は返す */ }
    }
    return NextResponse.json({ content })
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ content: '', error: m }, { status: 500 })
  }
}
