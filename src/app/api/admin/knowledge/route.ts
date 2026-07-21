// 「灯の頭の中」管理API（K10）。ai_prompt / ai_knowledge の閲覧・下書き・公開・履歴・ロールバック。
// 閲覧は min_role_view、編集は min_role_edit に従う。書き込みは service_role（本ルート）でのみ。
import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { requireUser, isAuthErr } from '@/lib/ai/auth'
import { runAgent, hasApiKey } from '@/lib/ai/agent'

export const runtime = 'nodejs'
export const maxDuration = 60   // goldenRun は灯を1問実行するため長め

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

    // ---- 構造化データ（KPI辞書 / 用語集 / 基準PL）: 閲覧=admin以上・編集/公開=owner ----
    // 各行が独立して status / draft_content(JSON) / 版履歴を持つ（ai_knowledge と同じ作法）。
    if (action.startsWith('struct')) {
      const S: Record<string, { table: string; ver: string; verFk: string; idCol: string; fields: string[] }> = {
        kpi: { table: 'kpi_definition', ver: 'kpi_definition_version', verFk: 'kpi_key', idCol: 'kpi_key',
               fields: ['kpi_key', 'label_ja', 'formula', 'numerator', 'denominator', 'unit', 'direction', 'note'] },
        glossary: { table: 'glossary', ver: 'glossary_version', verFk: 'term', idCol: 'term',
               fields: ['term', 'definition_ja', 'note'] },
        standard_pl: { table: 'standard_pl_master', ver: 'standard_pl_master_version', verFk: 'std_id', idCol: 'id',
               fields: ['facility_type', 'item_key', 'value', 'unit', 'note'] },
      }
      const kind = body.kind as string
      const cfg = S[kind]
      if (!cfg) return NextResponse.json({ error: '不明な種別' }, { status: 400 })
      const canView = myRank >= 2   // admin 以上
      const canEditStruct = myRank >= 3 // owner のみ
      if (!canView) return NextResponse.json({ error: '閲覧権限がありません' }, { status: 403 })

      // 一覧
      if (action === 'structList') {
        const { data, error } = await sb.from(cfg.table).select('*').order(cfg.idCol)
        if (error) return NextResponse.json({ error: error.message }, { status: 500 })
        return NextResponse.json({ rows: data ?? [], canEdit: canEditStruct })
      }

      // 以降は編集系（owner のみ）
      if (!canEditStruct) return NextResponse.json({ error: '編集権限がありません（オーナーのみ）' }, { status: 403 })

      // 入力フィールドをホワイトリストで抽出（identity 含む）
      const pickFields = (src: any): any => {
        const o: any = {}
        for (const f of cfg.fields) if (src?.[f] !== undefined) o[f] = src[f] === '' ? null : src[f]
        return o
      }
      // 版履歴に入れる編集フィールドのみ（identity は含めるが id は含めない）
      const draftFields = (src: any): any => {
        const o: any = {}
        for (const f of cfg.fields) o[f] = src?.[f] === '' || src?.[f] === undefined ? null : src[f]
        return o
      }

      if (action === 'structVersions') {
        const { data } = await sb.from(cfg.ver).select('*').eq(cfg.verFk, body.id).order('changed_at', { ascending: false }).limit(50)
        return NextResponse.json({ versions: data ?? [] })
      }

      // 下書き保存（新規作成 or 既存の draft_content 更新）
      if (action === 'structSaveDraft') {
        const df = draftFields(body.fields ?? {})
        if (body.id == null || body.id === '') {
          // 新規: NOT NULL 制約を満たすため列も初期値で埋め、status='draft'（＝未公開・非注入）
          const ins = pickFields(body.fields ?? {})
          ins.status = 'draft'
          ins.draft_content = df
          ins.updated_by = myEmail
          ins.updated_at = new Date().toISOString()
          const { error } = await sb.from(cfg.table).insert(ins)
          if (error) return NextResponse.json({ error: error.message }, { status: 400 })
          return NextResponse.json({ ok: true })
        }
        // 既存: 公開中の列は触らず draft_content だけ更新
        const { error } = await sb.from(cfg.table)
          .update({ draft_content: df, updated_by: myEmail, updated_at: new Date().toISOString() })
          .eq(cfg.idCol, body.id)
        if (error) return NextResponse.json({ error: error.message }, { status: 400 })
        return NextResponse.json({ ok: true })
      }

      // 公開: draft_content を列へ反映＋版スナップショット。変更メモ必須。
      if (action === 'structPublish') {
        const note = (body.change_note ?? '').trim()
        if (!note) return NextResponse.json({ error: '変更メモは必須です' }, { status: 400 })
        const { data: row } = await sb.from(cfg.table).select('*').eq(cfg.idCol, body.id).maybeSingle()
        if (!row) return NextResponse.json({ error: '対象が見つかりません' }, { status: 404 })
        const r = row as any
        // 反映元 = 明示 fields > draft_content > 現在の列
        const src = body.fields ?? r.draft_content ?? r
        const snap = draftFields(src)
        const cols = pickFields(src)
        cols.status = 'published'
        cols.draft_content = null
        cols.updated_by = myEmail
        cols.updated_at = new Date().toISOString()
        const { error: e1 } = await sb.from(cfg.table).update(cols).eq(cfg.idCol, body.id)
        if (e1) return NextResponse.json({ error: e1.message }, { status: 400 })
        await sb.from(cfg.ver).insert({ [cfg.verFk]: body.id, content: snap, status: 'published', change_note: note, changed_by: myEmail })
        return NextResponse.json({ ok: true })
      }

      // ロールバック: 版の JSON を列へ復元
      if (action === 'structRollback') {
        const { data: v } = await sb.from(cfg.ver).select('content').eq('id', body.version_id).maybeSingle()
        if (!v) return NextResponse.json({ error: '版が見つかりません' }, { status: 404 })
        const snap = (v as any).content ?? {}
        const cols = pickFields(snap)
        cols.status = 'published'
        cols.draft_content = null
        cols.updated_by = myEmail
        cols.updated_at = new Date().toISOString()
        const { error } = await sb.from(cfg.table).update(cols).eq(cfg.idCol, body.id)
        if (error) return NextResponse.json({ error: error.message }, { status: 400 })
        await sb.from(cfg.ver).insert({ [cfg.verFk]: body.id, content: snap, status: 'published', change_note: `ロールバック（版#${body.version_id}へ復元）`, changed_by: myEmail })
        return NextResponse.json({ ok: true })
      }

      // 削除（owner のみ・公開行なら灯からも消える）
      if (action === 'structDelete') {
        const { error } = await sb.from(cfg.table).delete().eq(cfg.idCol, body.id)
        if (error) return NextResponse.json({ error: error.message }, { status: 400 })
        return NextResponse.json({ ok: true })
      }

      return NextResponse.json({ error: '不明なアクション' }, { status: 400 })
    }

    // ---- ゴールデン質問セット（K40）: 閲覧/実行=admin以上・編集=owner ----
    if (action.startsWith('golden')) {
      const canEditG = myRank >= 3
      if (myRank < 2) return NextResponse.json({ error: '閲覧権限がありません' }, { status: 403 })

      if (action === 'goldenList') {
        const { data, error } = await sb.from('golden_question').select('*').order('sort_order').order('id')
        if (error) return NextResponse.json({ error: error.message }, { status: 500 })
        return NextResponse.json({ rows: data ?? [], canEdit: canEditG })
      }

      // 1問だけ灯に実行して回答を返す（UI側で1問ずつ呼びタイムアウト回避）
      if (action === 'goldenRun') {
        if (!hasApiKey()) return NextResponse.json({ error: 'ANTHROPIC_API_KEY 未設定' }, { status: 400 })
        const q = (body.question ?? '').toString().trim()
        if (!q) return NextResponse.json({ error: '質問が空です' }, { status: 400 })
        // ゴールデン質問の試走コンテキスト（読み取り専用・書き込みなし）。UIが宿を渡さない場合のみ
        // 先行施設(FRY)を既定にする。ここでの facility は灯が回答を作る際の文脈で、DB書き込み先ではない。
        const facility = (body.facility || 'FRY').toString()
        try {
          const text = await runAgent([{ role: 'user', content: q }], facility, null)
          return NextResponse.json({ answer: text || '(応答が空でした)' })
        } catch (e) {
          return NextResponse.json({ answer: '', error: e instanceof Error ? e.message : String(e) })
        }
      }

      if (!canEditG) return NextResponse.json({ error: '編集権限がありません（オーナーのみ）' }, { status: 403 })

      if (action === 'goldenSave') {
        const f = body.fields ?? {}
        const question = (f.question ?? '').toString().trim()
        const expectation = (f.expectation ?? '').toString().trim()
        if (!question || !expectation) return NextResponse.json({ error: '質問と期待値は必須です' }, { status: 400 })
        const row: any = {
          category: f.category || 'kpi_def', question, expectation,
          facility: f.facility ? String(f.facility) : null,
          sort_order: Number(f.sort_order) || 0,
          is_active: f.is_active !== false,
          updated_by: myEmail, updated_at: new Date().toISOString(),
        }
        const { error } = body.id
          ? await sb.from('golden_question').update(row).eq('id', body.id)
          : await sb.from('golden_question').insert(row)
        if (error) return NextResponse.json({ error: error.message }, { status: 400 })
        return NextResponse.json({ ok: true })
      }

      if (action === 'goldenDelete') {
        const { error } = await sb.from('golden_question').delete().eq('id', body.id)
        if (error) return NextResponse.json({ error: error.message }, { status: 400 })
        return NextResponse.json({ ok: true })
      }

      return NextResponse.json({ error: '不明なアクション' }, { status: 400 })
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
