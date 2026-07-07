import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

export const runtime = 'nodejs'

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL!
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY!

const admin = () => createClient(URL, SERVICE, { auth: { persistSession: false } })

/* 呼び出し元が admin か検証 */
async function requireAdmin(req: NextRequest) {
  const token = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '')
  if (!token) return { error: '未認証' }
  const anon = createClient(URL, ANON, { auth: { persistSession: false } })
  const { data: { user }, error } = await anon.auth.getUser(token)
  if (error || !user) return { error: '認証失敗' }
  const { data: au } = await admin().from('app_user').select('role').eq('user_id', user.id).maybeSingle()
  if (!au || (au.role !== 'admin' && au.role !== 'owner')) return { error: '権限がありません（管理者のみ）' }
  return { user }
}

export async function POST(req: NextRequest) {
  try {
    const chk = await requireAdmin(req)
    if ('error' in chk) return NextResponse.json({ error: chk.error }, { status: 403 })
    const sb = admin()
    const body = await req.json()
    const action = body.action

    if (action === 'list') {
      const { data: users } = await sb.from('app_user').select('user_id, email, role, can_view_wage').order('email')
      const { data: ufs } = await sb.from('user_facility').select('user_id, facility')
      const byUser: Record<string, string[]> = {}
      ;(ufs ?? []).forEach((r: { user_id: string; facility: string }) => { (byUser[r.user_id] ??= []).push(r.facility) })
      return NextResponse.json({ users: (users ?? []).map((u: any) => ({ ...u, facilities: byUser[u.user_id] ?? [] })) })
    }

    if (action === 'create') {
      const { email, password, role, facilities } = body as { email: string; password: string; role: string; facilities: string[] }
      if (!email || !password) return NextResponse.json({ error: 'メールとパスワードは必須です' }, { status: 400 })
      const { data: created, error: cErr } = await sb.auth.admin.createUser({ email, password, email_confirm: true })
      if (cErr) return NextResponse.json({ error: cErr.message }, { status: 400 })
      const uid = created.user.id
      await sb.from('app_user').upsert({ user_id: uid, email, role: role === 'admin' ? 'admin' : 'member' }, { onConflict: 'user_id' })
      if ((facilities ?? []).length) await sb.from('user_facility').insert(facilities.map((f) => ({ user_id: uid, facility: f })))
      return NextResponse.json({ ok: true })
    }

    // 招待メール送信（本人がリンクからパスワードを設定）
    if (action === 'invite') {
      const { email, role, facilities, redirectTo } = body as { email: string; role: string; facilities: string[]; redirectTo?: string }
      if (!email) return NextResponse.json({ error: 'メールアドレスは必須です' }, { status: 400 })
      const { data: inv, error: iErr } = await sb.auth.admin.inviteUserByEmail(email, redirectTo ? { redirectTo } : undefined)
      if (iErr) return NextResponse.json({ error: iErr.message }, { status: 400 })
      const uid = inv.user.id
      await sb.from('app_user').upsert({ user_id: uid, email, role: role === 'admin' ? 'admin' : 'member' }, { onConflict: 'user_id' })
      if ((facilities ?? []).length) await sb.from('user_facility').insert(facilities.map((f) => ({ user_id: uid, facility: f })))
      return NextResponse.json({ ok: true })
    }

    // 既存ユーザーへパスワード再設定メールを送る（管理者操作）
    if (action === 'sendReset') {
      const { email, redirectTo } = body as { email: string; redirectTo?: string }
      if (!email) return NextResponse.json({ error: 'メールアドレスが必要です' }, { status: 400 })
      const { error: rErr } = await sb.auth.resetPasswordForEmail(email, redirectTo ? { redirectTo } : undefined)
      if (rErr) return NextResponse.json({ error: rErr.message }, { status: 400 })
      return NextResponse.json({ ok: true })
    }

    if (action === 'setFacilities') {
      const { user_id, facilities } = body as { user_id: string; facilities: string[] }
      await sb.from('user_facility').delete().eq('user_id', user_id)
      if ((facilities ?? []).length) await sb.from('user_facility').insert(facilities.map((f) => ({ user_id, facility: f })))
      return NextResponse.json({ ok: true })
    }

    if (action === 'setRole') {
      const { user_id, role } = body as { user_id: string; role: string }
      // owner の役割変更・API経由での owner 付与は不可（owner=克樹さん固定。変更はSQLのみ）
      const { data: target } = await sb.from('app_user').select('role').eq('user_id', user_id).maybeSingle()
      if (target?.role === 'owner') return NextResponse.json({ error: 'オーナーの役割は変更できません' }, { status: 400 })
      await sb.from('app_user').update({ role: role === 'admin' ? 'admin' : 'member' }).eq('user_id', user_id)
      return NextResponse.json({ ok: true })
    }

    if (action === 'setWagePerm') {
      const { user_id, can_view_wage } = body as { user_id: string; can_view_wage: boolean }
      await sb.from('app_user').update({ can_view_wage: !!can_view_wage }).eq('user_id', user_id)
      return NextResponse.json({ ok: true })
    }

    if (action === 'delete') {
      const { user_id } = body as { user_id: string }
      const { data: target } = await sb.from('app_user').select('role').eq('user_id', user_id).maybeSingle()
      if (target?.role === 'owner') return NextResponse.json({ error: 'オーナーは削除できません' }, { status: 400 })
      await sb.from('user_facility').delete().eq('user_id', user_id)
      await sb.from('app_user').delete().eq('user_id', user_id)
      await sb.auth.admin.deleteUser(user_id)
      return NextResponse.json({ ok: true })
    }

    return NextResponse.json({ error: '不明なアクション' }, { status: 400 })
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 })
  }
}
