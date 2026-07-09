// 改善要望API（第3弾A）。submit=全ユーザー / list・update=owner のみ。
import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { requireUser, isAuthErr } from '@/lib/ai/auth'

export const runtime = 'nodejs'

const admin = () => createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })
/* eslint-disable @typescript-eslint/no-explicit-any */

export async function POST(req: NextRequest) {
  const auth = await requireUser(req)
  if (isAuthErr(auth)) return NextResponse.json({ error: auth.error }, { status: auth.status })
  const sb = admin()
  const { data: me } = await sb.from('app_user').select('email').eq('user_id', auth.userId).maybeSingle()
  const myEmail = (me as any)?.email ?? auth.userId

  try {
    const body = await req.json()
    const action = body.action as string

    // 送信は全ユーザー可（支配人含む）
    if (action === 'submit') {
      const source = body.source as string
      if (!['chat', 'summary', 'issue'].includes(source)) return NextResponse.json({ error: '不正な種別' }, { status: 400 })
      const { error } = await sb.from('ai_feedback').insert({
        facility: body.facility || null,
        created_by: myEmail,
        source,
        question: (body.question ?? '').toString().slice(0, 4000),
        answer: (body.answer ?? '').toString().slice(0, 8000),
        comment: (body.comment ?? '').toString().slice(0, 2000),
        status: 'new',
      })
      if (error) return NextResponse.json({ error: error.message }, { status: 400 })
      return NextResponse.json({ ok: true })
    }

    // 以降は owner のみ
    if (!auth.isOwner) return NextResponse.json({ error: 'オーナーのみが利用できます' }, { status: 403 })

    if (action === 'list') {
      const { data, error } = await sb.from('ai_feedback').select('*').order('created_at', { ascending: false }).limit(200)
      if (error) return NextResponse.json({ error: error.message }, { status: 500 })
      return NextResponse.json({ rows: data ?? [] })
    }

    if (action === 'update') {
      const upd: any = { updated_at: new Date().toISOString() }
      if (body.status && ['new', 'reviewing', 'done'].includes(body.status)) upd.status = body.status
      if (body.owner_note !== undefined) upd.owner_note = (body.owner_note ?? '').toString().slice(0, 4000)
      const { error } = await sb.from('ai_feedback').update(upd).eq('id', body.id)
      if (error) return NextResponse.json({ error: error.message }, { status: 400 })
      return NextResponse.json({ ok: true })
    }

    if (action === 'delete') {
      const { error } = await sb.from('ai_feedback').delete().eq('id', body.id)
      if (error) return NextResponse.json({ error: error.message }, { status: 400 })
      return NextResponse.json({ ok: true })
    }

    return NextResponse.json({ error: '不明なアクション' }, { status: 400 })
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 })
  }
}
