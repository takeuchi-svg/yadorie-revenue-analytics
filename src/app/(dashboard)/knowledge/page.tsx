'use client'

// 「灯の頭の中」管理画面（K10）。オーナー専用。
// 人格・層2ナレッジ・7プロンプトを 閲覧/編集（下書き→プレビュー→公開）。バージョン履歴・差分・ロールバック。
import { useCallback, useEffect, useMemo, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { supabase } from '@/lib/supabase/client'
import StructuredTab from './structured'
import GoldenTab from './golden'
import FeedbackTab from './feedback'

type Tab = 'core' | 'kpi' | 'glossary' | 'standard_pl' | 'golden' | 'feedback'
const TABS: { k: Tab; label: string; ownerOnly?: boolean }[] = [
  { k: 'core', label: 'プロンプト・ナレッジ' },
  { k: 'standard_pl', label: '基準PL' },
  { k: 'golden', label: 'ゴールデン質問' },
  { k: 'feedback', label: '改善要望', ownerOnly: true },
]
// KPI辞書・用語集は「辞書」ページ(/dict)へ移設。オーナーはそこで編集できる。

/* eslint-disable @typescript-eslint/no-explicit-any */
interface Item {
  kind: 'prompt' | 'knowledge'
  id: string | number
  title: string
  group: string
  usage?: string   // どこで使われているか（サイドバー › 配下名称）
  content: string
  draft_content: string | null
  status: string
  min_role_edit: string
  canEdit: boolean
  updated_by: string | null
  updated_at: string | null
}

const G_L1 = '層1 灯の人格'
const G_L2 = '層2 グループ共通ナレッジ'
const G_PROMPT = 'プロンプト（機能別）'

const PROMPT_LABEL: Record<string, string> = {
  chat_system: '灯の人格（全チャット共通の土台）',
  summary: '実績サマリ',
  issue: '課題と対策',
  review_analyze: 'クチコミ トピック抽出',
  review_insight: 'クチコミ 改善レポート',
  profile_context_template: '宿プロフィール 前文',
  company_insight: '全社モード 所見',
  meeting_pack: '月次レポート（概要・月次会議で共通）',
  meeting_extract: '月次会議 構造化抽出',
  budget_review: '予算レビュー（灯の伴走）',
  booking_insight: '売上状況 所見（売上の異変検知）',
}
// プロンプトの並び順（サイドバーの並び順に対応。chat_systemは層1なので含めない）
const PROMPT_ORDER = [
  'meeting_pack', 'summary', 'issue',   // ビュー › 概要 / 月次会議
  'profile_context_template',           // ビュー › 宿プロフィール
  'meeting_extract',                    // ビュー › 月次会議
  'budget_review',                      // 予実管理 › 予算作成
  'booking_insight',                    // 売上分析 › 売上状況
  'review_analyze', 'review_insight',   // 顧客満足度
  'company_insight',                    // 全社ダッシュボード
]
// どこで使われているか（サイドバー › その配下の名称）
const PROMPT_USAGE: Record<string, string> = {
  meeting_pack: 'ビュー › 概要／月次会議',
  summary: 'ビュー › 概要（※月次レポートに統合・現在未使用）',
  issue: 'ビュー › 概要（※月次レポートに統合・現在未使用）',
  profile_context_template: 'ビュー › 宿プロフィール',
  meeting_extract: 'ビュー › 月次会議',
  budget_review: '予実管理 › 予算作成',
  booking_insight: '売上分析 › 売上状況',
  review_analyze: '顧客満足度',
  review_insight: '顧客満足度',
  company_insight: '全社ダッシュボード',
}
const KNOW_LABEL: Record<string, string> = {
  persona: '灯の人格（層1）',
  mission_values: '会社の軸（ミッション・バリュー）',
  kpi_dictionary: 'KPI辞書',
  glossary: '用語集',
  standard_pl: '基準PL',
  group_policy: 'グループ共通方針',
}

// 行単位のかんたん差分
function lineDiff(oldStr: string, newStr: string): { t: 'same' | 'add' | 'del'; v: string }[] {
  const a = (oldStr ?? '').split('\n'), b = (newStr ?? '').split('\n')
  const out: { t: 'same' | 'add' | 'del'; v: string }[] = []
  const bSet = new Set(b), aSet = new Set(a)
  // 素朴な差分（順序は新側基準）
  for (const line of a) if (!bSet.has(line)) out.push({ t: 'del', v: line })
  for (const line of b) out.push({ t: aSet.has(line) ? 'same' : 'add', v: line })
  return out
}

export default function KnowledgePage() {
  const [role, setRole] = useState<string>('')
  const [items, setItems] = useState<Item[]>([])
  const [sel, setSel] = useState<string | null>(null)   // `${kind}:${id}`
  const [draft, setDraft] = useState('')
  const [preview, setPreview] = useState(false)
  const [msg, setMsg] = useState('')
  const [busy, setBusy] = useState(false)
  const [versions, setVersions] = useState<any[]>([])
  const [diffV, setDiffV] = useState<any | null>(null)
  const [publishNote, setPublishNote] = useState('')
  const [showPublish, setShowPublish] = useState(false)
  const [tab, setTab] = useState<Tab>('core')

  const call = useCallback(async (payload: any) => {
    const { data: { session } } = await supabase.auth.getSession()
    const res = await fetch('/api/admin/knowledge', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session?.access_token}` },
      body: JSON.stringify(payload),
    })
    return res.json()
  }, [])

  const load = useCallback(async () => {
    const { data: { user } } = await supabase.auth.getUser()
    if (user) {
      const { data: au } = await supabase.from('app_user').select('role').eq('user_id', user.id).maybeSingle()
      setRole((au as any)?.role ?? 'member')
    }
    const r = await call({ action: 'list' })
    if (r.error) { setMsg(r.error); return }
    const prompts = (r.prompts ?? []) as any[]
    const knowledge = (r.knowledge ?? []) as any[]
    const promptItem = (p: any, group: string, usage?: string): Item => ({
      kind: 'prompt', id: p.prompt_key, title: PROMPT_LABEL[p.prompt_key] ?? p.prompt_key,
      group, usage, content: p.content, draft_content: p.draft_content, status: p.status,
      min_role_edit: p.min_role_edit, canEdit: p.canEdit, updated_by: p.updated_by, updated_at: p.updated_at,
    })
    const knowItem = (k: any): Item => ({
      kind: 'knowledge', id: k.id, title: KNOW_LABEL[k.type] ?? k.type,
      group: k.layer === 1 ? G_L1 : G_L2, content: k.content ?? '', draft_content: k.draft_content,
      status: k.status, min_role_edit: k.min_role_edit, canEdit: k.canEdit, updated_by: k.updated_by, updated_at: k.updated_at,
    })
    // 灯の人格(chat_system)は層1として扱い、プロンプト群から分離
    const persona = prompts.find((p) => p.prompt_key === 'chat_system')
    const otherPrompts = prompts.filter((p) => p.prompt_key !== 'chat_system')
      .sort((a, b) => {
        const ia = PROMPT_ORDER.indexOf(a.prompt_key), ib = PROMPT_ORDER.indexOf(b.prompt_key)
        return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib)
      })
    // 並び順: 層1(人格) → 層2(グループ共通) → プロンプト(サイドバー順)
    const list: Item[] = [
      ...(persona ? [promptItem(persona, G_L1, '全ページの灯チャット共通の土台（人格）')] : []),
      ...knowledge.filter((k) => k.layer === 1).map(knowItem),
      ...knowledge.filter((k) => k.layer !== 1).map(knowItem),
      ...otherPrompts.map((p) => promptItem(p, G_PROMPT, PROMPT_USAGE[p.prompt_key])),
    ]
    setItems(list)
  }, [call])

  useEffect(() => { load() }, [load])

  const current = useMemo(() => items.find((it) => `${it.kind}:${it.id}` === sel) ?? null, [items, sel])
  useEffect(() => {
    if (current) { setDraft(current.draft_content ?? current.content); setPreview(false); setVersions([]); setDiffV(null) }
  }, [sel]) // eslint-disable-line react-hooks/exhaustive-deps

  const dirty = current ? draft !== (current.draft_content ?? current.content) : false
  const hasDraft = current ? (current.draft_content != null && current.draft_content !== current.content) : false

  const saveDraft = async () => {
    if (!current) return
    setBusy(true); setMsg('')
    const r = await call({ action: 'saveDraft', kind: current.kind, id: current.id, content: draft })
    setBusy(false)
    if (r.error) { setMsg('エラー: ' + r.error); return }
    setMsg('下書きを保存しました'); load()
  }
  const doPublish = async () => {
    if (!current) return
    setBusy(true); setMsg('')
    const r = await call({ action: 'publish', kind: current.kind, id: current.id, content: draft, change_note: publishNote })
    setBusy(false)
    if (r.error) { setMsg('エラー: ' + r.error); return }
    setShowPublish(false); setPublishNote(''); setMsg('公開しました（灯への反映は最大60秒）'); load()
  }
  const loadVersions = async () => {
    if (!current) return
    const r = await call({ action: 'versions', kind: current.kind, id: current.id })
    setVersions(r.versions ?? [])
  }
  const rollback = async (version_id: number) => {
    if (!current || !confirm('この版に戻します。よろしいですか？')) return
    setBusy(true)
    const r = await call({ action: 'rollback', kind: current.kind, id: current.id, version_id })
    setBusy(false)
    if (r.error) { setMsg('エラー: ' + r.error); return }
    setMsg('この版に戻しました'); setVersions([]); load()
  }

  const groups = useMemo(() => {
    const g: Record<string, Item[]> = {}
    for (const it of items) (g[it.group] ??= []).push(it)
    return g
  }, [items])

  const canManage = role === 'owner'

  return (
    <div className="p-6">
      <div className="mb-4">
        <h1 className="text-2xl font-bold mb-1">灯の頭の中（ナレッジ・プロンプト管理）</h1>
        <p className="text-sm" style={{ color: 'var(--text-dim)' }}>
          灯の人格・会社の軸・各プロンプトの正本。編集は下書き→プレビュー→公開の順で、履歴が残ります。
          {role && <span className="ml-2">（あなたの権限: {role === 'owner' ? 'オーナー' : role === 'admin' ? '管理者' : '一般'}）</span>}
        </p>
      </div>

      {!canManage ? (
        <div className="card p-6" style={{ borderColor: 'var(--yellow)' }}>
          <p className="text-sm" style={{ color: 'var(--text-dim)' }}>この画面はオーナーのみが利用できます。</p>
        </div>
      ) : (
        <>
          {/* タブ */}
          <div className="flex gap-1 mb-4 flex-wrap">
            {TABS.filter((t) => !t.ownerOnly || role === 'owner').map((t) => (
              <button key={t.k} onClick={() => setTab(t.k)}
                className="px-4 py-1.5 rounded-md text-sm transition-colors"
                style={{ background: tab === t.k ? 'var(--accent)' : 'var(--surface2)', color: tab === t.k ? '#fff' : 'var(--text-dim)' }}>
                {t.label}
              </button>
            ))}
          </div>

          {tab === 'golden' ? (
            <GoldenTab />
          ) : tab === 'feedback' ? (
            <FeedbackTab />
          ) : tab !== 'core' ? (
            <StructuredTab kind={tab} />
          ) : (
        <div className="grid grid-cols-1 lg:grid-cols-[280px_1fr] gap-4">
          {/* 一覧 */}
          <div className="space-y-4">
            {Object.entries(groups).map(([group, list]) => (
              <div key={group} className="card p-2">
                <p className="text-[11px] font-semibold px-2 py-1 tracking-wide" style={{ color: 'var(--text-dim)' }}>{group}</p>
                {list.map((it) => {
                  const key = `${it.kind}:${it.id}`
                  const active = key === sel
                  const draftBadge = it.draft_content != null && it.draft_content !== it.content
                  return (
                    <button key={key} onClick={() => setSel(key)}
                      className="w-full text-left px-2 py-2 rounded-md text-sm flex items-start gap-2 transition-colors"
                      style={{ background: active ? 'var(--accent)' : 'transparent', color: active ? '#fff' : 'var(--text)' }}>
                      <span className="flex-1 min-w-0">
                        <span className="block truncate">{it.title}</span>
                        {it.usage && <span className="block text-[10px] truncate mt-0.5" style={{ color: active ? 'rgba(255,255,255,.8)' : 'var(--text-dim)' }}>{it.usage}</span>}
                      </span>
                      {draftBadge && <span className="text-[9px] px-1.5 py-0.5 rounded shrink-0 mt-0.5" style={{ background: active ? 'rgba(255,255,255,.25)' : 'var(--yellow)', color: active ? '#fff' : '#000' }}>下書き</span>}
                      {!it.canEdit && <span className="text-[9px] shrink-0 mt-0.5" style={{ color: active ? '#fff' : 'var(--text-dim)' }}>🔒</span>}
                    </button>
                  )
                })}
              </div>
            ))}
          </div>

          {/* 編集 */}
          <div className="card p-4 min-h-[60vh]">
            {!current ? (
              <p className="text-sm" style={{ color: 'var(--text-dim)' }}>左から項目を選んでください。</p>
            ) : (
              <>
                <div className="flex items-center gap-2 mb-3 flex-wrap">
                  <h2 className="text-lg font-semibold">{current.title}</h2>
                  {current.usage && <span className="text-[11px] px-2 py-0.5 rounded" style={{ background: 'var(--surface2)', color: 'var(--text-dim)' }}>使用: {current.usage}</span>}
                  {hasDraft && <span className="text-[10px] px-2 py-0.5 rounded" style={{ background: 'var(--yellow)', color: '#000' }}>未公開の下書きあり</span>}
                  <span className="ml-auto text-[11px]" style={{ color: 'var(--text-dim)' }}>
                    最終更新: {current.updated_at ? new Date(current.updated_at).toLocaleString('ja-JP') : '-'} {current.updated_by ? `by ${current.updated_by}` : ''}
                  </span>
                </div>

                {!current.canEdit && (
                  <p className="text-xs mb-2 p-2 rounded" style={{ background: 'var(--surface2)', color: 'var(--text-dim)' }}>閲覧のみ（編集はオーナー権限が必要です）。</p>
                )}

                <div className="flex gap-1 mb-2">
                  <button onClick={() => setPreview(false)} className="px-3 py-1 rounded-md text-xs" style={{ background: !preview ? 'var(--accent)' : 'var(--surface2)', color: !preview ? '#fff' : 'var(--text-dim)' }}>編集</button>
                  <button onClick={() => setPreview(true)} className="px-3 py-1 rounded-md text-xs" style={{ background: preview ? 'var(--accent)' : 'var(--surface2)', color: preview ? '#fff' : 'var(--text-dim)' }}>プレビュー</button>
                </div>

                {preview ? (
                  <div className="aimd text-sm rounded-md p-3 min-h-[300px]" style={{ border: '1px solid var(--border)', background: 'var(--bg)' }}>
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>{draft || '（空）'}</ReactMarkdown>
                  </div>
                ) : (
                  <textarea value={draft} onChange={(e) => setDraft(e.target.value)} disabled={!current.canEdit}
                    className="field w-full text-sm font-mono p-3" style={{ minHeight: 340, lineHeight: 1.6, whiteSpace: 'pre-wrap' }} />
                )}

                {current.canEdit && (
                  <div className="flex items-center gap-2 mt-3 flex-wrap">
                    <button onClick={saveDraft} disabled={busy || !dirty}
                      className="px-4 py-1.5 rounded-md text-sm disabled:opacity-40" style={{ border: '1px solid var(--border)', color: 'var(--text)' }}>下書き保存</button>
                    <button onClick={() => setShowPublish(true)} disabled={busy}
                      className="px-4 py-1.5 rounded-md text-sm text-white disabled:opacity-40" style={{ background: 'var(--accent)' }}>公開する</button>
                    <button onClick={loadVersions} disabled={busy}
                      className="px-4 py-1.5 rounded-md text-sm ml-auto" style={{ border: '1px solid var(--border)', color: 'var(--text-dim)' }}>履歴を見る</button>
                  </div>
                )}

                {/* 履歴 */}
                {versions.length > 0 && (
                  <div className="mt-4 rounded-md p-3" style={{ border: '1px solid var(--border)' }}>
                    <h3 className="text-sm font-semibold mb-2">バージョン履歴</h3>
                    <div className="space-y-1.5">
                      {versions.map((v) => (
                        <div key={v.id} className="flex items-center gap-2 text-xs py-1" style={{ borderBottom: '1px solid var(--border)' }}>
                          <span style={{ color: 'var(--text-dim)' }}>{new Date(v.changed_at).toLocaleString('ja-JP')}</span>
                          <span className="flex-1">{v.change_note}</span>
                          <span style={{ color: 'var(--text-dim)' }}>{v.changed_by}</span>
                          <button onClick={() => setDiffV(diffV?.id === v.id ? null : v)} className="px-2 py-0.5 rounded" style={{ border: '1px solid var(--border)' }}>差分</button>
                          {current.canEdit && <button onClick={() => rollback(v.id)} className="px-2 py-0.5 rounded" style={{ border: '1px solid var(--border)', color: 'var(--accent)' }}>この版に戻す</button>}
                        </div>
                      ))}
                    </div>
                    {diffV && (
                      <div className="mt-2 rounded-md p-2 text-xs font-mono overflow-x-auto" style={{ background: 'var(--bg)', border: '1px solid var(--border)' }}>
                        <p className="mb-1" style={{ color: 'var(--text-dim)' }}>この版 → 現在の公開内容 の差分（緑=現在にある / 赤=この版にあった）</p>
                        {lineDiff(diffV.content, current.content).map((d, i) => (
                          <div key={i} style={{
                            background: d.t === 'add' ? 'rgba(29,158,117,.15)' : d.t === 'del' ? 'rgba(192,57,43,.15)' : 'transparent',
                            color: d.t === 'add' ? 'var(--green)' : d.t === 'del' ? 'var(--red)' : 'var(--text-dim)',
                            whiteSpace: 'pre-wrap',
                          }}>{d.t === 'add' ? '＋ ' : d.t === 'del' ? '－ ' : '　 '}{d.v}</div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </>
            )}
          </div>
        </div>
          )}
        </>
      )}

      {msg && <p className="text-sm mt-3" style={{ color: msg.startsWith('エラー') ? 'var(--red)' : 'var(--green)' }}>{msg}</p>}

      {/* 公開モーダル */}
      {showPublish && current && (
        <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ background: 'rgba(0,0,0,.5)' }} onClick={() => setShowPublish(false)}>
          <div className="card p-5 w-full max-w-md" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-base font-semibold mb-1">「{current.title}」を公開</h3>
            <p className="text-xs mb-3" style={{ color: 'var(--text-dim)' }}>公開すると全員の灯に反映されます（最大60秒）。変更メモは必須です。</p>
            <input value={publishNote} onChange={(e) => setPublishNote(e.target.value)} placeholder="変更メモ（例: 横断比較ルールを追記）"
              className="field w-full px-3 py-2 text-sm mb-3" />
            <div className="flex justify-end gap-2">
              <button onClick={() => setShowPublish(false)} className="px-4 py-1.5 rounded-md text-sm" style={{ border: '1px solid var(--border)', color: 'var(--text-dim)' }}>キャンセル</button>
              <button onClick={doPublish} disabled={busy || !publishNote.trim()} className="px-4 py-1.5 rounded-md text-sm text-white disabled:opacity-40" style={{ background: 'var(--accent)' }}>公開する</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
