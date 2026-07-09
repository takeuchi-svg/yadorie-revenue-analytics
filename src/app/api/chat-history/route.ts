// 会話メモリAPI（第3弾M-1）。(ユーザー×施設)単位。load=直近40件 / append=1件 / clear=新スレッド。
import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { requireUser, isAuthErr } from '@/lib/ai/auth'

export const runtime = 'nodejs'
const admin = () => createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })
/* eslint-disable @typescript-eslint/no-explicit-any */
const LIMIT = 40

export async function POST(req: NextRequest) {
  const auth = await requireUser(req)
  if (isAuthErr(auth)) return NextResponse.json({ error: auth.error }, { status: auth.status })
  const sb = admin()
  try {
    const body = await req.json()
    const action = body.action as string
    const facility = (body.facility ?? '').toString() || null

    if (action === 'load') {
      // 直近LIMIT件（active）を新しい順で取り、時系列昇順に並べ替えて返す
      const q = sb.from('chat_message').select('role, content, created_at')
        .eq('user_id', auth.userId).eq('active', true)
        .order('created_at', { ascending: false }).limit(LIMIT)
      const { data, error } = facility === null ? await q.is('facility', null) : await q.eq('facility', facility)
      if (error) return NextResponse.json({ error: error.message }, { status: 500 })
      const messages = ((data as any[]) ?? []).reverse().map((r) => ({ role: r.role, content: r.content }))
      return NextResponse.json({ messages })
    }

    if (action === 'append') {
      const role = body.role as string
      if (!['user', 'assistant'].includes(role)) return NextResponse.json({ error: '不正なrole' }, { status: 400 })
      const content = (body.content ?? '').toString()
      if (!content.trim()) return NextResponse.json({ ok: true })   // 空は保存しない
      const { error } = await sb.from('chat_message').insert({ user_id: auth.userId, facility, role, content: content.slice(0, 20000) })
      if (error) return NextResponse.json({ error: error.message }, { status: 400 })
      return NextResponse.json({ ok: true })
    }

    if (action === 'clear') {
      // 現スレッドを archive（active=false）。過去は残す。
      const q = sb.from('chat_message').update({ active: false }).eq('user_id', auth.userId).eq('active', true)
      const { error } = facility === null ? await q.is('facility', null) : await q.eq('facility', facility)
      if (error) return NextResponse.json({ error: error.message }, { status: 400 })
      return NextResponse.json({ ok: true })
    }

    return NextResponse.json({ error: '不明なアクション' }, { status: 400 })
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 })
  }
}
