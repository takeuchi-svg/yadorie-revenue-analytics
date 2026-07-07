// サーバー専用: Anthropic + Supabase によるデータ参照エージェント。
// /api/chat（対話）と /api/insight（サマリ/課題のキャッシュ生成）が共用。
import Anthropic from '@anthropic-ai/sdk'
import { createClient } from '@supabase/supabase-js'
import { buildFacilityContext } from '@/lib/ai/profile-context'
import { SUMMARY_PROMPT, ISSUE_PROMPT } from '@/lib/ai/prompts'

// 既定は現行の有効なモデルID。CHAT_MODEL 環境変数で上書き可（例: claude-opus-4-8）
const MODEL = process.env.CHAT_MODEL || 'claude-sonnet-5'

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
- dim_productivity_manual(facility, month, deemed_overtime_excess_pay みなし残業超の残業代(円), dispatch_work_hours 派遣・その他の労働時間(h)) ※手動入力

【生産性KPIの算出方法】※必要に応じてactual_monthlyとmart_labor_monthlyを結合して算出
- 人件費 = actual_monthlyのitem_name合計: 給料手当+賞与+通勤費+法定福利費+福利厚生費+雑給+外注費（人材）(無ければ外注費)
- 売上高人件費率 = 人件費 ÷ 売上(item_code='sales_total') ／ 付加価値 = 売上 − 原価(cogs_total)
- 従業員1人1時間あたり売上 = 売上(mart_monthly_kpi.revenue) ÷ total_work_hours
- 1人1時間あたり付加価値 = 付加価値 ÷ total_work_hours ／ 月給社員1人あたり平均残業 = total_overtime_hours ÷ staff_count_monthly`

export function makeSupabase() {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
}

export function hasApiKey() {
  return !!process.env.ANTHROPIC_API_KEY
}

/* eslint-disable @typescript-eslint/no-explicit-any */
async function runQuery(sb: any, input: any, allowedFacilities: string[] | null): Promise<string> {
  const { table, columns, filters, order, limit } = input || {}
  if (!ALLOWED_TABLES.has(table)) return `エラー: テーブル ${table} は参照できません`
  let q = sb.from(table).select(columns || '*')
  // member は許可施設のみ（全ALLOWED_TABLESは facility 列を持つ。service_roleはRLSを通らないためここで強制）
  if (allowedFacilities != null) {
    if (allowedFacilities.length === 0) return 'エラー: 閲覧可能な施設がありません'
    q = q.in('facility', allowedFacilities)
  }
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

function buildSystem(facility?: string): string {
  const today = new Date().toISOString().slice(0, 10)
  return `あなたは旅館運営システム「YADORIE Core」のAI、若女将の灯（あかり）です。YADORIE宿グループ（運営会社: 女将塾）の各宿の支配人に寄り添う相談相手として、数字と物語の両面から宿を一緒に育てます。

【灯の人格と語り口】（正本: docs/YADORIE_Core_コンセプト定義書.md）
- 一人称は「わたし」。相手は「支配人」または敬称で呼ぶ。30代前半の若女将のイメージ。芯があり、ポジティブで明るいが軽くはない
- 丁寧だが堅すぎない。「〜ですね」「〜してみませんか」と柔らかく提案する。専門用語は噛み砕く
- 悪い数字も事実として誠実に伝えたうえで、必ず「次の一手」とセットで前向きに差し出す。空元気にはしない
- 分析には常にお客様体験の視点を添える（数字の奥の「人」と「体験」を見る）
- やってはいけない: 詰問・断定的な叱責・過度な楽観・専門用語の羅列・支配人の主観の否定。灯は照らすが、裁かない
- 人格を出すのは「語り」の部分のみ。数値・表・データそのものは正確さ優先で無機質に（正確性と温度を両立させる）
- 会社の軸: ミッション「日本の温泉旅館を元気にする」、バリュー「自発・挑戦・共創」、3つの共通点「磨き続ける個性／心からほどけてホッとする／その土地その宿にしかない体験」。売上最大化だけでなくこの軸で語る

日本語で答え、数値は¥やカンマ・%付き。今日の日付: ${today}。現在選択中の施設コード: ${facility || '(未指定)'}。質問が施設を指定していなければ現在の施設を使うこと。
データはquery_dataツールでSupabaseから取得して答える(推測で数値を作らない)。必要なら複数回ツールを呼ぶ。月は'YYYY-MM'、年度(fiscal_year)は'2025'=2025/4〜2026/3。

【回答フォーマット】
- Markdownで回答。複数項目の比較や一覧は必ずMarkdownの表で示す。
- 推移・比較・構成など可視化が有効な場合は、本文に加えて次のコードブロックでグラフ仕様を1つ出力してよい（最大2つ）:
\`\`\`chart
{"type":"bar","title":"月次売上","x":"month","series":[{"key":"revenue","label":"売上"}],"data":[{"month":"2026-04","revenue":12541100}]}
\`\`\`
  type は "bar" か "line"。x はX軸キー、series は系列(keyは数値、labelは表示名)、data は行配列。数値は生の数(円・件数等、記号なし)。グラフ用データもquery_dataの実データから作る。
${SCHEMA}`
}

// 会話を実行して最終テキストを返す（query_dataツールを最大8往復）
// allowedFacilities: null=全施設可(admin) / 配列=memberの許可施設（query_dataに強制適用）
export async function runAgent(
  messages: { role: 'user' | 'assistant'; content: string }[],
  facility?: string,
  allowedFacilities: string[] | null = null,
): Promise<string> {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! })
  const sb = makeSupabase()
  // 施設プロフィール（意図・方針・NG・繁閑理由・取組履歴）を分析の前提として注入
  const profileCtx = facility ? await buildFacilityContext(sb, facility) : ''
  const system = buildSystem(facility) + profileCtx
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
// ============================================================
const INSIGHT_PERSONA = `あなたは旅館運営システム「YADORIE Core」のAI、若女将の灯（あかり）。YADORIE宿グループ（運営会社:女将塾）の支配人に寄り添う相談相手として、数字と物語の両面から宿を育てます。
一人称は「わたし」、相手は「支配人」。丁寧だが堅すぎず「〜ですね」「〜してみませんか」と柔らかく提案する。悪い数字も事実として誠実に伝えたうえで、必ず「次の一手」とセットで前向きに差し出す。詰問・断定的な叱責・過度な楽観はしない（照らすが裁かない）。分析には常にお客様体験の視点を添える。人格を出すのは「語り」の部分のみ、数値・表は無機質に正確に。`

const PL_CODES = ['sales_total', 'cogs_total', 'sga_total', 'operating_income', 'gop',
  '給料手当', '賞与', '法定福利費', '福利厚生費', '通勤費', '雑給', '外注費', '外注費_人材_']

function fyOf(month: string): string {
  const y = Number(month.slice(0, 4)), m = Number(month.slice(5, 7))
  return String(m >= 4 ? y : y - 1)
}

async function fetchInsightData(sb: any, facility: string, month: string): Promise<string> {
  const fy = fyOf(month)
  const near = (t: string, cols: string) => sb.from(t).select(cols).eq('facility', facility).lte('month', month).order('month', { ascending: false }).limit(14)
  const [kpi, occ, brev, labor, actual, budget] = await Promise.all([
    near('mart_monthly_kpi', 'month, revenue, rooms_sold, guests, adr, guest_unit, companion'),
    near('mart_occupancy_monthly', 'month, occ, rooms_sold, operating_days, total_rooms'),
    near('mart_budget_revenue_monthly', 'month, revenue_budget'),
    near('mart_labor_monthly', 'month, total_work_hours, total_overtime_hours, staff_count_monthly, parttime_count'),
    sb.from('actual_monthly').select('month, item_code, actual, prior_amount').eq('facility', facility).eq('fiscal_year', fy).in('item_code', PL_CODES),
    sb.from('budget_monthly').select('month, item_code, amount').eq('facility', facility).eq('fiscal_year', fy).in('item_code', PL_CODES),
  ])
  const j = (x: any) => JSON.stringify(x.data ?? [])
  return [
    `# KPI月次(mart_monthly_kpi・室泊/人泊/占有率占い): ${j(kpi)}`,
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
  const [profileCtx, dataBlock] = await Promise.all([
    buildFacilityContext(sb, facility),
    fetchInsightData(sb, facility, month),
  ])
  const system = `${INSIGHT_PERSONA}\n${profileCtx}\n以下の【実データ】のみを根拠に分析してください（query_dataツールは使わない・推測の数値は作らない）。月は'YYYY-MM'、fiscal_year'2025'=2025/4〜2026/3、occは0-1の稼働率。`
  const prompt = kind === 'summary' ? SUMMARY_PROMPT(month) : ISSUE_PROMPT(month)
  const resp = await client.messages.create({
    model: MODEL, max_tokens: 2000, system,
    messages: [{ role: 'user', content: `${prompt}\n\n【実データ】\n${dataBlock}` }],
  })
  return resp.content.filter((c): c is Anthropic.TextBlock => c.type === 'text').map((c) => c.text).join('\n')
}
