import { NextRequest, NextResponse } from 'next/server'
import Anthropic from '@anthropic-ai/sdk'
import { createClient } from '@supabase/supabase-js'

export const runtime = 'nodejs'
export const maxDuration = 60

const MODEL = process.env.CHAT_MODEL || 'claude-sonnet-4-6'

const ALLOWED_TABLES = new Set([
  'mart_monthly_kpi', 'mart_occupancy_monthly', 'mart_occupancy_daily',
  'mart_channel_monthly', 'mart_room_monthly', 'mart_room_type_monthly',
  'mart_meal_monthly', 'mart_residence_monthly', 'mart_plan_monthly',
  'mart_adr_band_monthly', 'mart_gs_monthly', 'mart_cxl_summary', 'mart_cxl_lt',
  'mart_booking_lt', 'budget_monthly', 'actual_monthly', 'mart_budget_revenue_monthly',
  'dim_facility', 'raw_other_product', 'raw_room_sales',
  'mart_labor_monthly', 'dim_productivity_manual',
])

const SCHEMA = `参照可能なテーブル/ビュー（列）:
- mart_monthly_kpi(facility, month 'YYYY-MM', revenue 売上, rooms_sold 室数(室泊), guests 客数, occ 稼働率(0-1), adr, guest_unit 客単価, revpar, companion 同伴, revenue_budget, total_inventory)
- mart_occupancy_monthly(facility, month, rooms_sold 販売室数, operating_days, total_rooms, occ) ※稼働率の正データ(販売数集計表由来)
- mart_occupancy_daily(facility, date 'YYYY-MM-DD', rooms_sold, total_rooms, occ)
- mart_channel_monthly(facility, month, channel チャネル, revenue, rooms, guests, adr, guest_unit)
- mart_room_type_monthly(facility, month, room_type 部屋タイプ, revenue, rooms_sold, guests, adr)
- mart_meal_monthly(facility, month, meal_type 喫食(2食付/朝食付/素泊り等), reservations 予約数, revenue, rooms, guests)
- mart_residence_monthly(facility, month, prefecture 都道府県/国, region, bookings, guests, revenue, guest_unit, rooms)
- mart_plan_monthly(facility, month, plan, bookings, revenue, rooms_total, guests, adr)
- mart_adr_band_monthly(facility, month, band ADR帯, bookings, revenue, rooms_total, adr)
- mart_gs_monthly(facility, month, group_size, bookings, revenue, rooms_total, adr)
- mart_cxl_summary(facility, month, channel, bookings, cancels, cancel_revenue, cxl_rate)
- budget_monthly(facility, fiscal_year '2025'/'2026', month, category, item_code, item_name, amount) ※予算P&L。item_code='sales_total'が売上予算, 'operating_income'が営業損益, 'cogs_total'原価, 'sga_total'販管費
- actual_monthly(facility, fiscal_year, month, item_code, item_name, actual 実績, prior_amount 昨年)
- mart_budget_revenue_monthly(facility, month, revenue_budget)
- raw_other_product(facility, item_name 商品, category, total, quantity, source_month) ※料飲/物販の明細(売れ筋)
- dim_facility(facility, name, total_rooms)
- mart_labor_monthly(facility, month, staff_count_monthly 月給社員数, parttime_count アルバイト数, total_work_hours 総労働時間, total_overtime_hours 総残業時間, own_work_hours 自施設, help_work_hours ヘルプ, operating_days) ※勤怠由来。本社(HQ)は除外済み。未取込の月は行が無い
- dim_productivity_manual(facility, month, deemed_overtime_excess_pay みなし残業超の残業代(円), dispatch_work_hours 派遣・その他の労働時間(h)) ※手動入力

【生産性KPIの算出方法】※必要に応じてactual_monthlyとmart_labor_monthlyを結合して算出
- 人件費 = actual_monthlyのitem_name合計: 給料手当+賞与+通勤費+法定福利費+福利厚生費+雑給+外注費（人材）(無ければ外注費)
- 売上高人件費率 = 人件費 ÷ 売上(item_code='sales_total') ／ 付加価値 = 売上 − 原価(cogs_total)
- 従業員1人1時間あたり売上 = 売上(mart_monthly_kpi.revenue) ÷ total_work_hours
- 1人1時間あたり付加価値 = 付加価値 ÷ total_work_hours ／ 月給社員1人あたり平均残業 = total_overtime_hours ÷ staff_count_monthly`

function makeSupabase() {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
}

/* eslint-disable @typescript-eslint/no-explicit-any */
async function runQuery(sb: any, input: any): Promise<string> {
  const { table, columns, filters, order, limit } = input || {}
  if (!ALLOWED_TABLES.has(table)) return `エラー: テーブル ${table} は参照できません`
  let q = sb.from(table).select(columns || '*')
  for (const f of (filters || [])) {
    const { column, op, value } = f
    if (op === 'eq') q = q.eq(column, value)
    else if (op === 'gte') q = q.gte(column, value)
    else if (op === 'lte') q = q.lte(column, value)
    else if (op === 'like') q = q.ilike(column, `%${value}%`)
    else if (op === 'neq') q = q.neq(column, value)
  }
  if (order?.column) q = q.order(order.column, { ascending: order.ascending !== false })
  q = q.limit(Math.min(limit || 100, 300))
  const { data, error } = await q
  if (error) return `エラー: ${error.message}`
  const json = JSON.stringify(data)
  return json.length > 12000 ? json.slice(0, 12000) + '...(truncated)' : json
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

export async function POST(req: NextRequest) {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) {
    return NextResponse.json({ reply: 'AIのAPIキー（ANTHROPIC_API_KEY）が未設定です。Vercelの環境変数に設定してください。' })
  }
  try {
    const { messages, facility } = (await req.json()) as { messages: { role: 'user' | 'assistant'; content: string }[]; facility?: string }
    const today = new Date().toISOString().slice(0, 10)
    const client = new Anthropic({ apiKey })
    const sb = makeSupabase()

    // 施設の定性コンテキスト（コンセプト・直近の取組）をプロンプトに注入
    let contextBlock = ''
    if (facility) {
      try {
        const { data } = await sb.from('dim_facility_context').select('concept, initiatives, notes, doc_content').eq('facility', facility).maybeSingle()
        const c = data as { concept: string | null; initiatives: string | null; notes: string | null; doc_content: string | null } | null
        if (c && (c.concept || c.initiatives || c.notes || c.doc_content)) {
          contextBlock = `\n\n【施設の定性コンテキスト】数値の解釈・要約・課題抽出の前提として必ず考慮する（コンセプトと実績の整合、取組の効果検証の観点を含める）。\n` +
            (c.concept ? `- コンセプト/ターゲット: ${c.concept}\n` : '') +
            (c.initiatives ? `- 直近の取組・施策: ${c.initiatives}\n` : '') +
            (c.notes ? `- その他メモ: ${c.notes}\n` : '') +
            (c.doc_content ? `- 連携ドキュメント(Google)からの補足情報:\n${c.doc_content}\n` : '')
        }
      } catch { /* テーブル未作成等は無視 */ }
    }

    const system = `あなたは旅館・ホテルの売上分析BI「YADORIE Revenue Analytics」のアシスタントです。日本語で簡潔に、数値は¥やカンマ・%付きで答えます。
今日の日付: ${today}。現在選択中の施設コード: ${facility || '(未指定)'}。質問が施設を指定していなければ現在の施設を使うこと。
データはquery_dataツールでSupabaseから取得して答える(推測で数値を作らない)。必要なら複数回ツールを呼ぶ。月は'YYYY-MM'、年度(fiscal_year)は'2025'=2025/4〜2026/3。

【回答フォーマット】
- Markdownで回答。複数項目の比較や一覧は必ずMarkdownの表で示す。
- 推移・比較・構成など可視化が有効な場合は、本文に加えて次のコードブロックでグラフ仕様を1つ出力してよい（最大2つ）:
\`\`\`chart
{"type":"bar","title":"月次売上","x":"month","series":[{"key":"revenue","label":"売上"}],"data":[{"month":"2026-04","revenue":12541100}]}
\`\`\`
  type は "bar" か "line"。x はX軸キー、series は系列(keyは数値、labelは表示名)、data は行配列。数値は生の数(円・件数等、記号なし)。グラフ用データもquery_dataの実データから作る。
${SCHEMA}${contextBlock}`

    const msgs: Anthropic.MessageParam[] = messages.map((m) => ({ role: m.role, content: m.content }))

    for (let i = 0; i < 8; i++) {
      const resp = await client.messages.create({ model: MODEL, max_tokens: 2000, system, tools: [TOOL], messages: msgs })
      if (resp.stop_reason === 'tool_use') {
        const results: Anthropic.ToolResultBlockParam[] = []
        for (const block of resp.content) {
          if (block.type === 'tool_use') {
            const out = await runQuery(sb, block.input)
            results.push({ type: 'tool_result', tool_use_id: block.id, content: out })
          }
        }
        msgs.push({ role: 'assistant', content: resp.content })
        msgs.push({ role: 'user', content: results })
        continue
      }
      const text = resp.content.filter((c): c is Anthropic.TextBlock => c.type === 'text').map((c) => c.text).join('\n')
      return NextResponse.json({ reply: text || '(応答なし)' })
    }
    return NextResponse.json({ reply: '回答の生成に時間がかかりました。質問を具体的にして再度お試しください。' })
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ reply: `エラー: ${m}` }, { status: 500 })
  }
}
