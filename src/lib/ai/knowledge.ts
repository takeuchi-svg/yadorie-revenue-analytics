// サーバー専用: AIナレッジ注入エンジン（K00）。
// 正本=DB（ai_prompt / ai_knowledge の published）。層1（人格①）→層2（グループ共通ナレッジ）→
// 層3（施設プロフィール⑦）の順で system ブロックを組み立てる。
// - prompt caching: 層1+層2 は安定プレフィックスとして層2末尾に cache_control を置く（断点1つ）。
//   published 更新＝本文が変わる＝プレフィックス不一致で自動的にキャッシュが切り替わる。
// - フォールバック: DB未適用・障害時は defaults.ts の同一文面を使う（灯を止めない）。
import type Anthropic from '@anthropic-ai/sdk'
import { buildFacilityContext } from '@/lib/ai/profile-context'
import { DEFAULT_PROMPTS, DEFAULT_LAYER2 } from '@/lib/ai/defaults'

/* eslint-disable @typescript-eslint/no-explicit-any */
export type PromptKey =
  | 'chat_system' | 'summary' | 'issue'
  | 'review_analyze' | 'review_insight' | 'profile_context_template'

interface Loaded {
  prompts: Record<string, string>              // published のみ
  layer2: { type: string; content: string }[]  // published のみ・sort_order順
}

// Lambdaインスタンス内の短期メモ（60秒）。公開直後の反映遅延は最大60秒。
let memo: { at: number; data: Loaded } | null = null
const MEMO_MS = 60_000

async function load(sb: any): Promise<Loaded> {
  if (memo && Date.now() - memo.at < MEMO_MS) return memo.data
  try {
    const [p, k] = await Promise.all([
      sb.from('ai_prompt').select('prompt_key, content, status').eq('status', 'published'),
      sb.from('ai_knowledge').select('type, content, status, sort_order, content_type')
        .eq('layer', 2).eq('status', 'published').order('sort_order'),
    ])
    if (p.error || k.error) throw new Error(p.error?.message || k.error?.message)
    const prompts: Record<string, string> = {}
    for (const r of (p.data ?? []) as any[]) if (r.content) prompts[r.prompt_key] = r.content
    const layer2 = ((k.data ?? []) as any[])
      .filter((r) => r.content_type === 'markdown' && (r.content ?? '').trim())
      .map((r) => ({ type: r.type as string, content: r.content as string }))
    const data: Loaded = { prompts, layer2 }
    memo = { at: Date.now(), data }
    return data
  } catch {
    // テーブル未作成・DB障害時: コード内の既定文面で動作継続
    return { prompts: {}, layer2: DEFAULT_LAYER2.length ? [...DEFAULT_LAYER2] : [] }
  }
}

// プロンプト本文を取得（DB published → 無ければ既定文面）
export async function getPrompt(sb: any, key: PromptKey): Promise<string> {
  const { prompts } = await load(sb)
  return prompts[key] ?? DEFAULT_PROMPTS[key]
}

/**
 * system ブロックを層構造で組み立てる。
 *  [0] 層1: chat_system（人格①。{日付}{施設}を置換）
 *  [1] 層2: グループ共通ナレッジ連結 ← cache_control（層1+層2がキャッシュ対象プレフィックス）
 *  [2] 層3: 施設プロフィール⑦ ＋ runtime（許可リスト等の実行時情報）
 *  [3] task: 機能別の task プロンプト（review_insight 等。省略可）
 */
export async function buildSystemBlocks(
  sb: any,
  facility?: string,
  opts: { runtime?: string; task?: string } = {},
): Promise<Anthropic.TextBlockParam[]> {
  const { layer2 } = await load(sb)
  const today = new Date().toISOString().slice(0, 10)
  const persona = (await getPrompt(sb, 'chat_system'))
    .replaceAll('{日付}', today)
    .replaceAll('{施設}', facility || '(未指定)')

  const l2items = layer2.length ? layer2 : DEFAULT_LAYER2
  const layer2Text = l2items.map((x) => x.content).join('\n\n')

  const preamble = await getPrompt(sb, 'profile_context_template')
  const profileCtx = facility ? await buildFacilityContext(sb, facility, preamble) : ''
  const tail = [profileCtx, opts.runtime ?? ''].filter((s) => s.trim()).join('\n\n')

  const blocks: Anthropic.TextBlockParam[] = [{ type: 'text', text: persona }]
  if (layer2Text.trim()) {
    blocks.push({ type: 'text', text: layer2Text, cache_control: { type: 'ephemeral' } })
  } else {
    blocks[0].cache_control = { type: 'ephemeral' }
  }
  if (tail) blocks.push({ type: 'text', text: tail })
  if (opts.task?.trim()) blocks.push({ type: 'text', text: opts.task })
  return blocks
}

// 管理画面の公開直後に即時反映したい場合に呼ぶ（同一インスタンス内のメモ破棄）
export function invalidateKnowledgeMemo() { memo = null }
