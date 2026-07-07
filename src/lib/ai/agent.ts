// サーバー専用: Anthropic + Supabase によるデータ参照エージェント。
// /api/chat（対話）と /api/insight（サマリ/課題のキャッシュ生成）が共用。
// システムプロンプトはナレッジ注入エンジン（knowledge.ts。正本=DB ai_prompt/ai_knowledge）で組み立てる。
import Anthropic from '@anthropic-ai/sdk'
import { createClient } from '@supabase/supabase-js'
import { buildSystemBlocks, getPrompt } from '@/lib/ai/knowledge'
import { aiDbAvailable, queryMartAi, type AiQueryInput } from '@/lib/ai/db'

// 既定は現行の有効なモデルID。CHAT_MODEL 環境変数で上書き可（例: claude-opus-4-8）
const MODEL = process.env.CHAT_MODEL || 'claude-sonnet-5'

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
- mart_occupancy_monthly(facility, month, rooms_sold 販売室数, operating_days, total_rooms, occ) ※稼働率の正データ(販売数集計表由来)
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
- 人件費 = actual_monthlyのitem_name合計: 給料手当+賞与+通勤費+法定福利費+福利厚生費+雑給+外注費（人材）(無ければ外注費)
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

// ---- AIのデータ読み取り（K30） ----
// AI_DB_URL があれば ai_reader ロールで mart_ai スキーマのみ読む（物理防御）。
// 未設定時は従来どおり service_role の REST（フォールバック。K30適用完了後は AI_DB_URL 運用が正）。
async function aiData(sb: any, input: AiQueryInput, allowedFacilities: string[] | null): Promise<any[]> {
  if (aiDbAvailable()) {
    return queryMartAi({ ...input, facilityIn: allowedFacilities ?? undefined })
  }
  // legacy REST（public スキーマ・コード許可リストのみが砦の旧経路）
  let q = sb.from(input.table).select(input.columns || '*')
  if (allowedFacilities != null) {
    if (allowedFacilities.length === 0) throw new Error('閲覧可能な施設がありません')
    q = q.in('facility', allowedFacilities)
  }
  for (const f of input.filters ?? []) {
    if (f.op === 'eq') q = q.eq(f.column, f.value)
    else if (f.op === 'gte') q = q.gte(f.column, f.value)
    else if (f.op === 'lte') q = q.lte(f.column, f.value)
    else if (f.op === 'like') q = q.ilike(f.column, `%${f.value}%`)
    else if (f.op === 'neq') q = q.neq(f.column, f.value)
    else if (f.op === 'in') q = q.in(f.column, Array.isArray(f.value) ? f.value : [f.value])
    else throw new Error(`不正な演算子: ${f.op}`)
  }
  if (input.order?.column) q = q.order(input.order.column, { ascending: input.order.ascending !== false })
  q = q.limit(Math.min(input.limit || 100, 300))
  const { data, error } = await q
  if (error) throw new Error(error.message)
  return data ?? []
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

// 会話を実行して最終テキストを返す（query_dataツールを最大8往復）
// allowedFacilities: null=全施設可(admin) / 配列=memberの許可施設（query_dataに強制適用）
export async function runAgent(
  messages: { role: 'user' | 'assistant'; content: string }[],
  facility?: string,
  allowedFacilities: string[] | null = null,
): Promise<string> {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! })
  const sb = makeSupabase()
  // 層1(人格)→層2(グループ共通)→層3(施設プロフィール)＋実行時情報。層1+層2はprompt cache対象
  // 許可リスト説明は data_confidentiality(C0) から自動生成（未投入時は静的SCHEMA）
  const { schemaText } = await loadAiCatalog(sb)
  const system = await buildSystemBlocks(sb, facility, { runtime: `${CHAT_CHART_SPEC}\n\n${schemaText}\n\n${PRODUCTIVITY_NOTE}` })
  const msgs: Anthropic.MessageParam[] = messages.map((m) => ({ role: m.role, content: m.content }))

  for (let i = 0; i < 8; i++) {
    const resp = await client.messages.create({ model: MODEL, max_tokens: 2000, system, tools: [TOOL], messages: msgs })
    if (resp.stop_reason === 'tool_use') {
      const results: Anthropic.ToolResultBlockParam[] = []
      for (const block of resp.content) {
        if (block.type === 'tool_use') {
          const out = await runQuery(sb, block.input, allowedFacilities)
          results.push({ type: 'tool_result', tool_use_id: block.id, content: out })
        }
      }
      msgs.push({ role: 'assistant', content: resp.content })
      msgs.push({ role: 'user', content: results })
      continue
    }
    return resp.content.filter((c): c is Anthropic.TextBlock => c.type === 'text').map((c) => c.text).join('\n')
  }
  return ''
}

// ============================================================
// 概要のサマリ/課題: データを先に取得して「1回だけ」LLM呼び出し（tool往復せず高速・タイムアウト回避）
// ※要約版人格(INSIGHT_PERSONA)は廃止（確定）。層1のフル人格①を全機能で共用する。
// ============================================================
const PL_CODES = ['sales_total', 'cogs_total', 'sga_total', 'operating_income', 'gop',
  '給料手当', '賞与', '法定福利費', '福利厚生費', '通勤費', '雑給', '外注費', '外注費_人材_']

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
  const INSIGHT_RUNTIME = `【この依頼の進め方】query_dataツールは使わず、ユーザーメッセージの【実データ】のみを根拠に分析する（推測の数値は作らない）。月は'YYYY-MM'、fiscal_year'2025'=2025/4〜2026/3、occは0-1の稼働率。`
  const [system, promptTpl, dataBlock] = await Promise.all([
    buildSystemBlocks(sb, facility, { runtime: INSIGHT_RUNTIME }),
    getPrompt(sb, kind),
    fetchInsightData(sb, facility, month),
  ])
  const prompt = promptTpl.replaceAll('{month}', month)
  const resp = await client.messages.create({
    model: MODEL, max_tokens: 4000, system,
    messages: [{ role: 'user', content: `${prompt}\n\n【実データ】\n${dataBlock}` }],
  })
  const text = resp.content.filter((c): c is Anthropic.TextBlock => c.type === 'text').map((c) => c.text).join('\n')
  // 生成が途中で止まった/空の場合は理由を添えて返す（呼び出し側で可視化）
  if (!text) throw new Error(`AIが空の応答を返しました（stop_reason=${resp.stop_reason ?? '不明'}）`)
  return text
}
