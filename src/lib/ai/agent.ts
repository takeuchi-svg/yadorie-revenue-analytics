// サーバー専用: Anthropic + Supabase によるデータ参照エージェント。
// /api/chat（対話）と /api/insight（サマリ/課題のキャッシュ生成）が共用。
// システムプロンプトはナレッジ注入エンジン（knowledge.ts。正本=DB ai_prompt/ai_knowledge）で組み立てる。
import Anthropic from '@anthropic-ai/sdk'
import { createClient } from '@supabase/supabase-js'
import { buildSystemBlocks, getPrompt } from '@/lib/ai/knowledge'
import { aiDbAvailable, queryMartAi, type AiQueryInput } from '@/lib/ai/db'

// ── モデル2系統 ──
// チャット系＝速さ優先(Sonnet 5・thinking無効)。CHAT_MODEL で上書き可。
// 分析系(所見/会議パック/予算レビュー)＝深さ優先(Opus 4.8・adaptive thinking)。ANALYSIS_MODEL で上書き可。
const MODEL = process.env.CHAT_MODEL || 'claude-sonnet-5'
const ANALYSIS_MODEL = process.env.ANALYSIS_MODEL || 'claude-opus-4-8'

// チャット系は thinking 無効のまま維持する。
// Sonnet 5 は既定が adaptive thinking＝難しい質問ほど本文の前に「思考」へトークンと時間を使う。
// 過去、max_tokens=4000 のまま思考が走り「空回答(stop_reason=max_tokens)」「途中切れ」
// 「60秒タイムアウト」が多発した。真因は (1)max_tokensが思考の内数で小さすぎ (2)maxDuration=60秒。
// チャットは即答が価値なので thinking 無効が正しい。分析系は deepCreate(下記)で器を広げて思考を解禁する。
const NO_THINKING = { type: 'disabled' as const }

// ── 分析系の深い1回生成（熟考解禁の器） ──
// - adaptive thinking + effort high: 灯が回答前に材料の数値を突き合わせて考える
// - max_tokens 16000: 思考は max_tokens の内数のため、思考の余地を確保（従来4000が空回答の真因）
// - SDK内部ストリーミング(stream→finalMessage): 長時間生成でもHTTPアイドル切断されない
// 呼び出し側の route は maxDuration=300 (Vercel Fluid Compute) が前提。
async function deepCreate(
  client: Anthropic,
  system: Anthropic.TextBlockParam[],
  messages: Anthropic.MessageParam[],
): Promise<string> {
  const stream = client.messages.stream({
    model: ANALYSIS_MODEL,
    max_tokens: 16000,
    thinking: { type: 'adaptive' },
    output_config: { effort: 'high' },
    system,
    messages,
  } as Anthropic.MessageStreamParams)
  const resp = await stream.finalMessage()
  const text = resp.content.filter((c): c is Anthropic.TextBlock => c.type === 'text').map((c) => c.text).join('\n')
  if (!text) throw new Error(`AIが空の応答を返しました（stop_reason=${resp.stop_reason ?? '不明'}）`)
  return text
}

// ── Phase 2: 2パス方式（ドラフト生成 → 自己検証 → 最終稿） ──
// 実際に出た違和感（施設名の捏造「FRY=大曲の森の…」/ 造語「満月予算」/ 順繁忙期の秋を「谷」と表現）を
// チェックリスト化。1つの違和感が全体の信頼を落とすため、公開前に灯自身に点検させる。
const VERIFY_PROMPT = `あなたが直前に書いたドラフトを、以下の観点で厳密に点検し、修正を織り込んだ最終版だけを出力してください。点検メモ・修正理由・前置きは一切書かない（最終版の本文のみ）。
1. 数値の検算: 引用した数値・比率が渡された材料と一致するか。材料に無い数値は書かない
2. 軸と基準: すべての数字に軸（宿泊日ベース/予約日ベース）と基準（予算比/前年比/前年同日比）が明記されているか
3. 言葉: 材料・画面に無い造語を使っていないか（例:「満月予算」はNG）。社内で通じる普通の言葉に直す
4. 固有名詞: 施設名はシステムプロンプトで与えられた正式名称のみ。内部コード（英字ID）や推測した名称を排除
5. プロフィール整合: 宿プロフィール（繁閑の理由・避けたいこと・NG）と矛盾する記述がないか（繁忙期の月を「谷」「閑散」と呼ぶ等）
6. 構成: 指示された見出し構成・分量を維持。問題がなければそのまま出力してよい`

async function deepCreateVerified(
  client: Anthropic,
  system: Anthropic.TextBlockParam[],
  userContent: string,
): Promise<string> {
  const draft = await deepCreate(client, system, [{ role: 'user', content: userContent }])
  // 同一system（層1+2はprompt cacheが効く）で会話を続け、検証・改稿した最終版のみ受け取る
  return deepCreate(client, system, [
    { role: 'user', content: userContent },
    { role: 'assistant', content: draft },
    { role: 'user', content: VERIFY_PROMPT },
  ])
}

// フォールバック用の静的許可リスト（正本は data_confidentiality の C0。K30適用後は自動生成が優先）
const ALLOWED_TABLES = new Set([
  'mart_monthly_kpi', 'mart_occupancy_monthly', 'mart_occupancy_daily',
  'mart_channel_monthly', 'mart_room_monthly', 'mart_room_type_monthly',
  'mart_meal_monthly', 'mart_residence_monthly', 'mart_plan_monthly',
  'mart_adr_band_monthly', 'mart_gs_monthly', 'mart_cxl_summary', 'mart_cxl_lt',
  'mart_booking_lt', 'budget_monthly', 'actual_monthly', 'mart_budget_revenue_monthly',
  'dim_facility', 'raw_other_product', 'raw_room_sales',
  'mart_labor_monthly', 'dim_productivity_manual',
  'mart_onhand_monthly', 'mart_budget_daily_monthly',
])

const SCHEMA = `参照可能なテーブル/ビュー（列）:
- mart_monthly_kpi(facility, month 'YYYY-MM', revenue 売上, rooms_sold 室泊数, guests 人泊数, adr 室単価(1室1泊), guest_unit 客単価(人泊単価=1人1泊), companion 同伴係数(人泊÷室泊)) ※チェックイン月に計上(freee計上基準)。稼働率はmart_occupancy_monthlyを使うこと
- mart_occupancy_monthly(facility, month, rooms_sold 販売室数, operating_days 稼働日数, total_rooms 客室数, occ 稼働率(稼働日ベース), occ_calendar_days 稼働率(全日ベース・特記なければ稼働率はこちらを使う)) ※稼働率の正データ(販売数集計表由来)
- mart_occupancy_daily(facility, date 'YYYY-MM-DD', rooms_sold, total_rooms, occ)
- mart_channel_monthly(facility, month, channel チャネル, revenue, rooms, guests, adr, guest_unit)
- mart_room_type_monthly(facility, month, room_type 部屋タイプ, revenue, rooms_sold, guests, adr)
- mart_meal_monthly(facility, month, meal_type 喫食(2食付/朝食付/素泊り等), reservations 予約数, revenue, rooms, guests)
- mart_residence_monthly(facility, month, prefecture 都道府県/国, region, bookings, guests, revenue, guest_unit, rooms)
- mart_plan_monthly(facility, month, plan, bookings, revenue, rooms_total 室泊, guests 人泊, adr) ※ステイシーC/O確定=freee計上基準
- mart_adr_band_monthly(facility, month, band ADR帯(1室1泊), bookings, revenue, rooms_total, adr) ※ステイシーC/O確定
- mart_gs_monthly(facility, month, group_size, bookings, revenue, rooms_total, adr) ※ステイシーC/O確定
- mart_cxl_summary(facility, month, channel, bookings 全予約(取消含む), cancels 取消, cancel_revenue, cxl_rate 取消率=取消÷全予約) ※ステイシー全チャネル(直予約/電話/エージェント含む)
- mart_cxl_lt(facility, month, bucket リードタイム帯, count) ※取消の予約日→CIまでの日数分布
- mart_booking_lt(facility, month, bucket, revenue, rooms_total, guests, adr, count) ※ステイシーC/O確定・予約日基準のLT別売上
- budget_monthly(facility, fiscal_year '2025'/'2026', month, category, item_code, item_name, amount) ※予算P&L。item_code='sales_total'が売上予算, 'operating_income'が営業損益, 'cogs_total'原価, 'sga_total'販管費
- actual_monthly(facility, fiscal_year, month, item_code, item_name, actual 実績, prior_amount 昨年)
- mart_budget_revenue_monthly(facility, month, revenue_budget)
- mart_onhand_monthly(facility, month, room_nights オンハンド室泊, room_nights_stayed 宿泊済(C/O), room_nights_confirmed 確定, room_nights_tentative 未確認, guest_nights 人泊, revenue, adr) ※現時点の予約の入り具合(キャンセル除く)。将来月＝ブッキングペース。最新スナップショット
- mart_budget_daily_monthly(facility, month, rooms_budget 予算室泊, revenue_budget 予算売上, inventory_budget 予算在庫) ※日次予算の月ロールアップ。オンハンドの比較相手
- raw_other_product(facility, item_name 商品, category, total, quantity, source_month) ※料飲/物販の明細(売れ筋)
- dim_facility(facility, name, total_rooms)
- mart_labor_monthly(facility, month, staff_count_monthly 月給社員数, parttime_count アルバイト数, total_work_hours 総労働時間, total_overtime_hours 総残業時間, own_work_hours 自施設, help_work_hours ヘルプ, operating_days) ※勤怠由来。本社(HQ)は除外済み。未取込の月は行が無い
- dim_productivity_manual(facility, month, deemed_overtime_excess_pay みなし残業超の残業代(円), dispatch_work_hours 派遣・その他の労働時間(h)) ※手動入力`

// 生産性KPIの算出ガイド（許可リストと別建て。K20でKPI辞書=層2へ移設予定）
const PRODUCTIVITY_NOTE = `【生産性KPIの算出方法】※必要に応じてactual_monthlyとmart_labor_monthlyを結合して算出
- 人件費 = 給料手当+賞与+通勤費+法定福利費+福利厚生費+雑給+外注費(人材)+外注費(清掃)+外注費(その他)+業務委託料（正確な定義はKPI辞書に従う）
- 売上高人件費率 = 人件費 ÷ 売上(item_code='sales_total') ／ 付加価値 = 売上 − 原価(cogs_total)
- 従業員1人1時間あたり売上 = 売上(mart_monthly_kpi.revenue) ÷ total_work_hours
- 1人1時間あたり付加価値 = 付加価値 ÷ total_work_hours ／ 月給社員1人あたり平均残業 = total_overtime_hours ÷ staff_count_monthly
- 人件費科目が null の施設（小規模・守秘）は labor_cost_ratio_monthly の率を使い、絶対額は「守秘のため非開示」と答える`

export function makeSupabase() {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
}

export function hasApiKey() {
  return !!process.env.ANTHROPIC_API_KEY
}

// ---- 許可リスト（K30）: data_confidentiality の C0 から自動生成。未投入・障害時は静的定義へフォールバック ----
let catalogMemo: { at: number; tables: Set<string>; schemaText: string } | null = null
const CATALOG_MEMO_MS = 60_000

/* eslint-disable @typescript-eslint/no-explicit-any */
async function loadAiCatalog(sb: any): Promise<{ tables: Set<string>; schemaText: string }> {
  if (catalogMemo && Date.now() - catalogMemo.at < CATALOG_MEMO_MS) return catalogMemo
  try {
    const { data, error } = await sb.from('data_confidentiality')
      .select('object_name, ai_description, sort_order')
      .eq('level', 'C0').is('column_name', null).order('sort_order')
    if (error) throw new Error(error.message)
    const rows = (data ?? []) as { object_name: string; ai_description: string | null }[]
    if (!rows.length) throw new Error('C0未投入')
    const tables = new Set(rows.map((r) => r.object_name))
    const schemaText = '参照可能なテーブル/ビュー（列）:\n' +
      rows.filter((r) => (r.ai_description ?? '').trim()).map((r) => `- ${r.ai_description}`).join('\n')
    catalogMemo = { at: Date.now(), tables, schemaText }
    return catalogMemo
  } catch {
    return { tables: ALLOWED_TABLES, schemaText: SCHEMA }
  }
}

// ---- AIのデータ読み取り（K30・物理防御） ----
// 必ず ai_reader ロールで mart_ai スキーマのみを読む（AI_DB_URL 経由）。
// AI_DB_URL 未設定なら「AIはデータを読まない（エラー）」＝service_roleでの直読み経路は撤去済み。
// これにより、AIが公開スキーマ（個人給与を含む）を service_role で読む経路は存在しない。
async function aiData(_sb: any, input: AiQueryInput, allowedFacilities: string[] | null): Promise<any[]> {
  if (!aiDbAvailable()) {
    throw new Error('AIのデータ接続（AI_DB_URL）が未設定です。管理者にご連絡ください。')
  }
  return queryMartAi({ ...input, facilityIn: allowedFacilities ?? undefined })
}

// query_data ツール本体。許可リスト（C0自動生成）でテーブルを検証し、aiData で読む
async function runQuery(sb: any, input: any, allowedFacilities: string[] | null): Promise<string> {
  const { table, columns, filters, order, limit } = input || {}
  const { tables } = await loadAiCatalog(sb)
  if (!tables.has(table)) return `エラー: テーブル ${table} は参照できません`
  try {
    const data = await aiData(sb, { table, columns, filters, order, limit }, allowedFacilities)
    const json = JSON.stringify(data)
    return json.length > 12000 ? json.slice(0, 12000) + '...(truncated)' : json
  } catch (e) {
    return `エラー: ${e instanceof Error ? e.message : String(e)}`
  }
}

const TOOL: Anthropic.Tool = {
  name: 'query_data',
  description: 'Supabaseの集計ビュー/テーブルを読み取り、行をJSONで返す。売上・稼働率・予実・チャネル・F&B等の質問に答えるために使う。',
  input_schema: {
    type: 'object',
    properties: {
      table: { type: 'string', description: '参照するテーブル/ビュー名' },
      columns: { type: 'string', description: '取得列(カンマ区切り)。省略時は全列' },
      filters: {
        type: 'array',
        description: '絞り込み条件',
        items: {
          type: 'object',
          properties: {
            column: { type: 'string' },
            op: { type: 'string', enum: ['eq', 'gte', 'lte', 'like', 'neq'] },
            value: {},
          },
          required: ['column', 'op', 'value'],
        },
      },
      order: { type: 'object', properties: { column: { type: 'string' }, ascending: { type: 'boolean' } } },
      limit: { type: 'number' },
    },
    required: ['table'],
  },
}

// チャット専用の実行時情報のうち chart 仕様（許可リスト説明は loadAiCatalog で自動生成）
const CHAT_CHART_SPEC = `【chartコードブロックの仕様】
\`\`\`chart
{"type":"bar","title":"月次売上","x":"month","series":[{"key":"revenue","label":"売上"}],"data":[{"month":"2026-04","revenue":12541100}]}
\`\`\`
type は "bar" か "line"。x はX軸キー、series は系列(keyは数値、labelは表示名)、data は行配列。数値は生の数(円・件数等、記号なし)。グラフ用データもquery_dataの実データから作る。`

// チャットのシステムブロック（人格＋この施設の直近データパック＋簡潔ガード）を組み立てる。
// 往復ゼロ方式: この施設の直近データを先に丸ごと渡し、tool往復なしで答える（旧8往復方式は廃止）。
// （runQuery/TOOL/loadAiCatalog は将来のディープ分析モード用に残置。現行チャットは未使用）
async function buildChatSystem(sb: any, facility?: string): Promise<Anthropic.TextBlockParam[]> {
  // 回答の長さガード: 長文生成で60秒に近づき通信エラー/切れになるのを防ぐ（簡潔＝速い）
  const BREVITY = `【回答の長さ】簡潔に。要点は2〜4点に絞り、冗長な列挙・前置き・過度な言い換えを避ける。表は必要な列・行だけ、グラフは最大1つ。全体で概ね900字以内を目安に、長くなりそうなら「まず要点→必要なら深掘りを提案」の形にする。`
  const dataBlock = facility ? await fetchChatContext(sb, facility) : ''
  const runtime = dataBlock
    ? `${CHAT_CHART_SPEC}\n\n${BREVITY}\n\n【現在の施設の直近データ（この実データのみを根拠に答える。ここに無い指標・他施設は「今は手元にない」と述べ、推測の数値は作らない）】\n${dataBlock}\n\n${PRODUCTIVITY_NOTE}`
    : `${CHAT_CHART_SPEC}\n\n${BREVITY}\n\n（施設が未選択のため実データがありません。施設の選択をやさしく促してください）`
  return buildSystemBlocks(sb, facility, { runtime })
}

// 非ストリーム（ゴールデン質問の一括実行など、全文を待つ用途）。allowedFacilitiesはroute側で検証済み。
export async function runAgent(
  messages: { role: 'user' | 'assistant'; content: string }[],
  facility?: string,
  allowedFacilities: string[] | null = null,
): Promise<string> {
  void allowedFacilities
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! })
  const sb = makeSupabase()
  const system = await buildChatSystem(sb, facility)
  const msgs: Anthropic.MessageParam[] = messages.map((m) => ({ role: m.role, content: m.content }))
  const resp = await client.messages.create({ model: MODEL, max_tokens: 4000, thinking: NO_THINKING, system, messages: msgs })
  return resp.content.filter((c): c is Anthropic.TextBlock => c.type === 'text').map((c) => c.text).join('\n')
}

// ストリーム（チャットUI用）。トークンを逐次配信＝書きながら表示で体感高速、長文でも待たされ感が消える。
export async function runAgentStream(
  messages: { role: 'user' | 'assistant'; content: string }[],
  facility?: string,
): Promise<ReadableStream<Uint8Array>> {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! })
  const sb = makeSupabase()
  const system = await buildChatSystem(sb, facility)
  const msgs: Anthropic.MessageParam[] = messages.map((m) => ({ role: m.role, content: m.content }))
  const encoder = new TextEncoder()
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        const s = client.messages.stream({ model: MODEL, max_tokens: 4000, thinking: NO_THINKING, system, messages: msgs })
        for await (const ev of s) {
          if (ev.type === 'content_block_delta' && ev.delta.type === 'text_delta') {
            controller.enqueue(encoder.encode(ev.delta.text))
          }
        }
      } catch (e) {
        controller.enqueue(encoder.encode(`\n\n[エラー: ${e instanceof Error ? e.message : String(e)}]`))
      } finally {
        controller.close()
      }
    },
  })
}

// ============================================================
// 概要のサマリ/課題: データを先に取得して「1回だけ」LLM呼び出し（tool往復せず高速・タイムアウト回避）
// ※要約版人格(INSIGHT_PERSONA)は廃止（確定）。層1のフル人格①を全機能で共用する。
// ============================================================
const PL_CODES = ['sales_total', 'cogs_total', 'sga_total', 'operating_income', 'gop',
  '給料手当', '賞与', '法定福利費', '福利厚生費', '通勤費', '雑給',
  '外注費', '外注費_人材_', '外注費_清掃_', '外注費_その他_', '業務委託料']

function fyOf(month: string): string {
  const y = Number(month.slice(0, 4)), m = Number(month.slice(5, 7))
  return String(m >= 4 ? y : y - 1)
}

async function fetchInsightData(sb: any, facility: string, month: string): Promise<string> {
  const fy = fyOf(month)
  // K30: AI_DB_URL 設定時は ai_reader/mart_ai 経由（k-匿名マスク済みデータ）で読む
  const near = (t: string, cols: string) => aiData(sb, {
    table: t, columns: cols,
    filters: [{ column: 'facility', op: 'eq', value: facility }, { column: 'month', op: 'lte', value: month }],
    order: { column: 'month', ascending: false }, limit: 14,
  }, null)
  const pl = (t: string, cols: string) => aiData(sb, {
    table: t, columns: cols,
    filters: [
      { column: 'facility', op: 'eq', value: facility },
      { column: 'fiscal_year', op: 'eq', value: fy },
      { column: 'item_code', op: 'in', value: PL_CODES },
    ], limit: 300,
  }, null)
  const [kpi, occ, brev, labor, actual, budget] = await Promise.all([
    near('mart_monthly_kpi', 'month, revenue, rooms_sold, guests, adr, guest_unit, companion'),
    near('mart_occupancy_monthly', 'month, occ, rooms_sold, operating_days, total_rooms'),
    near('mart_budget_revenue_monthly', 'month, revenue_budget'),
    near('mart_labor_monthly', 'month, total_work_hours, total_overtime_hours, staff_count_monthly, parttime_count'),
    pl('actual_monthly', 'month, item_code, actual, prior_amount'),
    pl('budget_monthly', 'month, item_code, amount'),
  ])
  const j = (x: any[]) => JSON.stringify(x ?? [])
  return [
    `# KPI月次(mart_monthly_kpi・室泊/人泊ベース): ${j(kpi)}`,
    `# 稼働率月次(mart_occupancy_monthly・occは0-1): ${j(occ)}`,
    `# 売上予算月次: ${j(brev)}`,
    `# 労働時間月次(mart_labor_monthly・時間): ${j(labor)}`,
    `# PL実績(actual_monthly・FY${fy}・prior_amountは前年同月): ${j(actual)}`,
    `# PL予算(budget_monthly・FY${fy}): ${j(budget)}`,
  ].join('\n')
}

// チャット用の広めのデータパック。最新実績月を起点に直近14ヶ月＋当月内訳を並列取得し、
// これを丸ごと灯へ渡して「往復ゼロ・1回」で答えさせる（tool往復による遅さ・タイムアウトを回避）。
async function fetchChatContext(sb: any, facility: string): Promise<string> {
  const latest = await aiData(sb, {
    table: 'mart_monthly_kpi', columns: 'month',
    filters: [{ column: 'facility', op: 'eq', value: facility }],
    order: { column: 'month', ascending: false }, limit: 1,
  }, null).catch(() => [])
  const anchor = ((latest?.[0]?.month as string) || new Date().toISOString().slice(0, 7))
  const fy = fyOf(anchor)
  const trend = (t: string, cols: string) => aiData(sb, {
    table: t, columns: cols,
    filters: [{ column: 'facility', op: 'eq', value: facility }, { column: 'month', op: 'lte', value: anchor }],
    order: { column: 'month', ascending: false }, limit: 14,
  }, null).catch(() => [])
  const cur = (t: string, cols: string) => aiData(sb, {
    table: t, columns: cols,
    filters: [{ column: 'facility', op: 'eq', value: facility }, { column: 'month', op: 'eq', value: anchor }], limit: 60,
  }, null).catch(() => [])
  const pl = (t: string, cols: string) => aiData(sb, {
    table: t, columns: cols,
    filters: [
      { column: 'facility', op: 'eq', value: facility },
      { column: 'fiscal_year', op: 'in', value: [fy, String(Number(fy) - 1)] },
      { column: 'item_code', op: 'in', value: PL_CODES },
    ], limit: 600,
  }, null).catch(() => [])
  const [kpi, occ, brev, labor, cxl, onhand, actual, budget, channel, meal, adr, gs, resid] = await Promise.all([
    trend('mart_monthly_kpi', 'month, revenue, rooms_sold, guests, adr, guest_unit, companion'),
    trend('mart_occupancy_monthly', 'month, occ, occ_calendar_days, rooms_sold, operating_days, total_rooms'),
    trend('mart_budget_revenue_monthly', 'month, revenue_budget'),
    trend('mart_labor_monthly', 'month, total_work_hours, total_overtime_hours, staff_count_monthly, parttime_count'),
    trend('mart_cxl_summary', 'month, channel, bookings, cancels, cancel_revenue, cxl_rate'),
    trend('mart_onhand_monthly', 'month, room_nights, room_nights_stayed, room_nights_confirmed, guest_nights, revenue, adr'),
    pl('actual_monthly', 'month, item_code, actual, prior_amount'),
    pl('budget_monthly', 'month, item_code, amount'),
    cur('mart_channel_monthly', 'channel, revenue, rooms, guests, adr, guest_unit'),
    cur('mart_meal_monthly', 'meal_type, reservations, revenue, rooms, guests'),
    cur('mart_adr_band_monthly', 'band, bookings, revenue, rooms_total, adr'),
    cur('mart_gs_monthly', 'group_size, bookings, revenue, rooms_total, adr'),
    cur('mart_residence_monthly', 'prefecture, region, bookings, guests, revenue'),
  ])
  const j = (x: any[]) => JSON.stringify(x ?? [])
  return [
    `最新実績月=${anchor} / 年度=${fy}（月は新しい順）`,
    `# KPI月次(売上/室泊/人泊/ADR/客単価/同伴): ${j(kpi)}`,
    `# 稼働率月次(occ=稼働日ベース, occ_calendar_days=全日ベース=通常こちら, 0-1): ${j(occ)}`,
    `# 売上予算月次: ${j(brev)}`,
    `# 労働時間月次(時間・人数): ${j(labor)}`,
    `# 取消月次(cxl_rate=取消率): ${j(cxl)}`,
    `# オンハンド(現時点の予約の入り。将来月=ブッキングペース): ${j(onhand)}`,
    `# PL実績(FY${fy}と前年・prior_amount=前年同月・item_codeで科目): ${j(actual)}`,
    `# PL予算(FY${fy}と前年): ${j(budget)}`,
    `# 【${anchor}】チャネル別: ${j(channel)}`,
    `# 【${anchor}】喫食別: ${j(meal)}`,
    `# 【${anchor}】ADR帯別: ${j(adr)}`,
    `# 【${anchor}】グループサイズ別: ${j(gs)}`,
    `# 【${anchor}】客層(都道府県): ${j(resid)}`,
  ].join('\n')
}

// 全社モード（G6）: クライアントで算出済みの全社材料を渡し、灯が経営視点の所見を1回で生成。
// 単一施設前提の runInsight/fetchInsightData とは別経路（facility を渡さず層3=空、company_insight プロンプト）。
export async function runCompanyInsight(month: string, material: string): Promise<string> {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! })
  const sb = makeSupabase()
  const RUNTIME = `【この依頼の進め方】query_dataツールは使わず、ユーザーメッセージの【全社実データ】のみを根拠に分析する（推測の数値は作らない）。既存店/新店を区別し、新店は前年比を出さない。金額は万円で表記。`
  const [system, promptTpl] = await Promise.all([
    buildSystemBlocks(sb, undefined, { runtime: RUNTIME }),   // facility 未指定＝層3(施設プロフィール)は空
    getPrompt(sb, 'company_insight'),
  ])
  const prompt = promptTpl.replaceAll('{month}', month)
  return deepCreate(client, system, [{ role: 'user', content: `${prompt}\n\n【全社実データ】\n${material}` }])
}

// 月次会議パック（B9）: 材料(クライアント算出)を渡して1回生成。施設プロフィール(層3)も注入。
export async function runMeetingPack(facility: string, month: string, material: string): Promise<string> {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! })
  const sb = makeSupabase()
  const RUNTIME = `【この依頼の進め方】query_dataツールは使わず、ユーザーメッセージの【会議データ】のみを根拠にする（推測の数値は作らない）。金額は万円、率は%。月は'YYYY-MM'。\n\n${CHAT_CHART_SPEC}`
  const [system, promptTpl] = await Promise.all([
    buildSystemBlocks(sb, facility, { runtime: RUNTIME }),
    getPrompt(sb, 'meeting_pack'),
  ])
  const prompt = promptTpl.replaceAll('{month}', month)
  return deepCreateVerified(client, system, `${prompt}\n\n【会議データ】\n${material}`)
}

// 予算レビュー（B6）: 支配人が作った来期予算を灯が伴走レビュー。材料はクライアント算出。層3(基準PL/意図/取組)注入。
export async function runBudgetReview(facility: string, fy: number, material: string): Promise<string> {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! })
  const sb = makeSupabase()
  const RUNTIME = `【この依頼の進め方】query_dataツールは使わず、ユーザーメッセージの【予算データ】のみを根拠にレビューする（推測の数値は作らない）。金額は万円、率は%。灯は代わりに予算を作らず、気づきを問いの形で示す。`
  const [system, promptTpl] = await Promise.all([
    buildSystemBlocks(sb, facility, { runtime: RUNTIME }),
    getPrompt(sb, 'budget_review'),
  ])
  const prompt = promptTpl.replaceAll('{fy}', String(fy))
  return deepCreate(client, system, [{ role: 'user', content: `${prompt}\n\n【予算データ】\n${material}` }])
}

// 予約日ベース分析（M8）: 前年同期比の異変検知・OTA/室数・単価の分解・施策照合を灯が1回で生成。
// 材料はクライアント算出。層3(施設プロフィール)注入。要因（在庫か料金か）は断定しない。
export async function runBookingInsight(facility: string, asOf: string, material: string): Promise<string> {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! })
  const sb = makeSupabase()
  const RUNTIME = `【この依頼の進め方】query_dataツールは使わず、ユーザーメッセージの【予約日ベースデータ】のみを根拠に分析する（推測の数値は作らない）。予約日ベース＝いつ予約が入ったか、宿泊日ベース＝いつ泊まるか。金額は万円、率は%。要因（在庫か料金か）は断定せず、検知・分解・施策照合と“確かめたい問い”まで。`
  const [system, promptTpl] = await Promise.all([
    buildSystemBlocks(sb, facility, { runtime: RUNTIME }),
    getPrompt(sb, 'booking_insight'),
  ])
  const prompt = promptTpl.replaceAll('{as_of}', asOf)
  return deepCreateVerified(client, system, `${prompt}\n\n【予約日ベースデータ】\n${material}`)
}

// kind='summary'|'issue' の本文を1回のLLM呼び出しで生成
export async function runInsight(
  kind: 'summary' | 'issue',
  facility: string,
  month: string,
  allowedFacilities: string[] | null = null,
): Promise<string> {
  if (allowedFacilities != null && !allowedFacilities.includes(facility)) return ''
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! })
  const sb = makeSupabase()
  // 層1(人格①)＋層2＋層3に、この依頼固有の注意（ツール不使用・実データのみ）を実行時情報として追加
  const INSIGHT_RUNTIME = `【この依頼の進め方】query_dataツールは使わず、ユーザーメッセージの【実データ】のみを根拠に分析する（推測の数値は作らない）。月は'YYYY-MM'、fiscal_year'2025'=2025/4〜2026/3、occは0-1の稼働率。\n\n${CHAT_CHART_SPEC}`
  const [system, promptTpl, dataBlock] = await Promise.all([
    buildSystemBlocks(sb, facility, { runtime: INSIGHT_RUNTIME }),
    getPrompt(sb, kind),
    fetchInsightData(sb, facility, month),
  ])
  const prompt = promptTpl.replaceAll('{month}', month)
  return deepCreate(client, system, [{ role: 'user', content: `${prompt}\n\n【実データ】\n${dataBlock}` }])
}
