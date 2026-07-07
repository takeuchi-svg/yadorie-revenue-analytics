// 「灯の頭の中」管理API（K10）。ai_prompt / ai_knowledge の閲覧・下書き・公開・履歴・ロールバック。
// 閲覧は min_role_view、編集は min_role_edit に従う。書き込みは service_role（本ルート）でのみ。
import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { requireUser, isAuthErr } from '@/lib/ai/auth'

export const runtime = 'nodejs'

const admin = () => createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })
const rank = (r: string) => (r === 'owner' ? 3 : r === 'admin' ? 2 : r === 'member' ? 1 : 0)
/* eslint-disable @typescript-eslint/no-explicit-any */

export async function POST(req: NextRequest) {
  const auth = await requireUser(req)
  if (isAuthErr(auth)) return NextResponse.json({ error: auth.error }, { status: auth.status })
  const myRank = auth.isOwner ? 3 : auth.isAdmin ? 2 : 1
  const sb = admin()

  // 更新者表示用のメール
  const { data: me } = await sb.from('app_user').select('email').eq('user_id', auth.userId).maybeSingle()
  const myEmail = (me as any)?.email ?? auth.userId

  try {
    const body = await req.json()
    const action = body.action as string

    if (action === 'list') {
      const [p, k] = await Promise.all([
        sb.from('ai_prompt').select('prompt_key, content, draft_content, status, min_role_view, min_role_edit, updated_by, updated_at').order('prompt_key'),
        sb.from('ai_knowledge').select('id, layer, type, content, draft_content, status, sort_order, min_role_view, min_role_edit, updated_by, updated_at').order('layer').order('sort_order'),
      ])
      const prompts = ((p.data ?? []) as any[]).filter((r) => myRank >= rank(r.min_role_view))
        .map((r) => ({ ...r, canEdit: myRank >= rank(r.min_role_edit) }))
      const knowledge = ((k.data ?? []) as any[]).filter((r) => myRank >= rank(r.min_role_view))
        .map((r) => ({ ...r, canEdit: myRank >= rank(r.min_role_edit) }))
      return NextResponse.json({ prompts, knowledge })
    }

    // 対象の特定（kind='prompt' は prompt_key / kind='knowledge' は id）
    const kind = body.kind as 'prompt' | 'knowledge'
    const table = kind === 'prompt' ? 'ai_prompt' : 'ai_knowledge'
    const verTable = kind === 'prompt' ? 'ai_prompt_version' : 'ai_knowledge_version'
    const idCol = kind === 'prompt' ? 'prompt_key' : 'id'
    const verFk = kind === 'prompt' ? 'prompt_key' : 'ai_knowledge_id'
    const id = body.id

    const { data: row } = await sb.from(table).select('*').eq(idCol, id).maybeSingle()
    if (!row) return NextResponse.json({ error: '対象が見つかりません' }, { status: 404 })
    const r = row as any
    if (myRank < rank(r.min_role_view)) return NextResponse.json({ error: '閲覧権限がありません' }, { status: 403 })
    const canEdit = myRank >= rank(r.min_role_edit)

    if (action === 'versions') {
      const { data: vs } = await sb.from(verTable).select('*').eq(verFk, id).order('changed_at', { ascending: false }).limit(50)
      return NextResponse.json({ versions: vs ?? [] })
    }

    if (!canEdit) return NextResponse.json({ error: '編集権限がありません（オーナーのみ）' }, { status: 403 })

    if (action === 'saveDraft') {
      await sb.from(table).update({ draft_content: body.content ?? '', updated_by: myEmail, updated_at: new Date().toISOString() }).eq(idCol, id)
      return NextResponse.json({ ok: true })
    }

    if (action === 'publish') {
      const content = (body.content ?? r.draft_content ?? r.content ?? '') as string
      const note = (body.change_note ?? '').trim()
      if (!note) return NextResponse.json({ error: '変更メモは必須です' }, { status: 400 })
      if (!content.trim()) return NextResponse.json({ error: '本文が空です' }, { status: 400 })
      // 履歴に「公開後の内容」を1件記録 → 本体を公開に更新（draft は content に反映しクリア）
      await sb.from(verTable).insert({ [verFk]: id, content, status: 'published', change_note: note, changed_by: myEmail })
      await sb.from(table).update({ content, draft_content: null, status: 'published', updated_by: myEmail, updated_at: new Date().toISOString() }).eq(idCol, id)
      return NextResponse.json({ ok: true })
    }

    if (action === 'rollback') {
      const { data: v } = await sb.from(verTable).select('content').eq('id', body.version_id).maybeSingle()
      if (!v) return NextResponse.json({ error: '版が見つかりません' }, { status: 404 })
      const content = (v as any).content as string
      await sb.from(verTable).insert({ [verFk]: id, content, status: 'published', change_note: `ロールバック（版#${body.version_id}へ復元）`, changed_by: myEmail })
      await sb.from(table).update({ content, draft_content: null, status: 'published', updated_by: myEmail, updated_at: new Date().toISOString() }).eq(idCol, id)
      return NextResponse.json({ ok: true })
    }

    return NextResponse.json({ error: '不明なアクション' }, { status: 400 })
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 })
  }
}
