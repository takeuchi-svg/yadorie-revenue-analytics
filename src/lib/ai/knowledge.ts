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
  | 'company_insight'

interface KpiRow { kpi_key: string; label_ja: string; formula?: string; numerator?: string; denominator?: string; unit?: string; direction?: string; note?: string }
interface GlossRow { term: string; definition_ja: string; note?: string }
interface PlRow { facility_type: string; item_key: string; value?: number | null; unit?: string; note?: string }

interface Loaded {
  prompts: Record<string, string>              // published のみ
  layer2: { type: string; content: string }[]  // published のみ・sort_order順
  kpi: KpiRow[]                                 // published のみ（構造化・注入用）
  glossary: GlossRow[]                          // published のみ
  standardPl: PlRow[]                           // published のみ
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
    // 構造化データ（KPI辞書/用語集/基準PL）は別 try で取得: 未マイグレーション（status列なし）でも
    // プロンプト/層2ナレッジの読み込みを壊さない（非回帰）。published のみ注入対象。
    let kpi: KpiRow[] = [], glossary: GlossRow[] = [], standardPl: PlRow[] = []
    try {
      const [kd, gl, pl] = await Promise.all([
        sb.from('kpi_definition').select('kpi_key,label_ja,formula,numerator,denominator,unit,direction,note').eq('status', 'published').order('kpi_key'),
        sb.from('glossary').select('term,definition_ja,note').eq('status', 'published').order('term'),
        sb.from('standard_pl_master').select('facility_type,item_key,value,unit,note').eq('status', 'published').order('facility_type').order('item_key'),
      ])
      if (!kd.error) kpi = (kd.data ?? []) as KpiRow[]
      if (!gl.error) glossary = (gl.data ?? []) as GlossRow[]
      if (!pl.error) standardPl = (pl.data ?? []) as PlRow[]
    } catch { /* 器が未作成でも本体は継続 */ }
    const data: Loaded = { prompts, layer2, kpi, glossary, standardPl }
    memo = { at: Date.now(), data }
    return data
  } catch {
    // テーブル未作成・DB障害時: コード内の既定文面で動作継続
    return { prompts: {}, layer2: DEFAULT_LAYER2.length ? [...DEFAULT_LAYER2] : [], kpi: [], glossary: [], standardPl: [] }
  }
}

// ---- 構造化データ → 灯に渡す文章（提案E）。空セクションは出さない（非回帰） ----
function directionJa(d?: string): string {
  return d === 'higher_better' ? '高いほど良い' : d === 'lower_better' ? '低いほど良い' : ''
}
export function buildStructuredText(kpi: KpiRow[], glossary: GlossRow[], pl: PlRow[]): string {
  const parts: string[] = []
  if (kpi.length) {
    const lines = kpi.map((x) => {
      const calc = (x.formula ?? '').trim()
        ? x.formula!.trim()
        : (x.numerator && x.denominator ? `${x.numerator} ÷ ${x.denominator}` : (x.numerator ?? x.denominator ?? '').trim())
      const seg = [`- ${x.label_ja}（${x.kpi_key}）:`]
      if (calc) seg.push(` ${calc}。`)
      if ((x.unit ?? '').trim()) seg.push(`単位${x.unit!.trim()}。`)
      const dir = directionJa(x.direction)
      if (dir) seg.push(`${dir}。`)
      if ((x.note ?? '').trim()) seg.push(` ※${x.note!.trim()}`)
      return seg.join('')
    })
    parts.push('## KPI定義（この定義を厳守。数値を語る際の分母・分子・単位はここが正）\n' + lines.join('\n'))
  }
  if (glossary.length) {
    const lines = glossary.map((x) => `- ${x.term}: ${x.definition_ja}${(x.note ?? '').trim() ? `（${x.note!.trim()}）` : ''}`)
    parts.push('## 用語集（社内語彙。ユーザーがこの語を使ったらこの意味で解釈）\n' + lines.join('\n'))
  }
  if (pl.length) {
    const byType: Record<string, PlRow[]> = {}
    for (const r of pl) (byType[r.facility_type] ??= []).push(r)
    const blocks = Object.entries(byType).map(([t, rows]) => {
      const items = rows.map((r) => {
        const v = r.value == null ? '-' : String(r.value)
        const u = r.unit === 'ratio' ? '（率）' : (r.unit ?? '')
        return `${r.item_key}=${v}${u}`
      }).join(' / ')
      return `- ${t}: ${items}`
    })
    parts.push('## 基準PL（施設タイプ別の目標水準。横断比較時はこの基準に照らし、単価帯・規模の違いを明記して評価）\n' + blocks.join('\n'))
  }
  return parts.join('\n\n')
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
  const { layer2, kpi, glossary, standardPl } = await load(sb)
  const today = new Date().toISOString().slice(0, 10)
  const persona = (await getPrompt(sb, 'chat_system'))
    .replaceAll('{日付}', today)
    .replaceAll('{施設}', facility || '(未指定)')

  const l2items = layer2.length ? layer2 : DEFAULT_LAYER2
  // 層2 = 全施設共通のMarkdownナレッジ ＋ KPI辞書・用語集（cache対象プレフィックス。施設非依存で共有）。
  // 基準PLは全7タイプを毎回積むと重いので層2には入れず、profile-context（層3）で
  // 「その施設のタイプ1つ分」だけ注入する（standardPl はここでは未使用）。
  void standardPl
  const structuredText = buildStructuredText(kpi, glossary, [])
  const layer2Text = [l2items.map((x) => x.content).join('\n\n'), structuredText]
    .filter((s) => s.trim())
    .join('\n\n')

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
