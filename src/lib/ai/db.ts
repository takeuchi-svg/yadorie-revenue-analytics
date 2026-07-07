// サーバー専用: AIのデータ読み取り接続（K30・給与守秘の物理防御）。
// 専用DBロール ai_reader で Supavisor プーラーへ直結し、mart_ai スキーマのビューだけを読む。
// ai_reader は public スキーマへの権限を持たないため、コードのバグやプロンプトインジェクション
// があっても個人給与（dim_staff_wage 等）には物理的に到達できない。
// 接続文字列: 環境変数 AI_DB_URL（例: postgres://ai_reader:PASSWORD@aws-0-xx.pooler.supabase.com:6543/postgres）
import { Pool } from 'pg'

/* eslint-disable @typescript-eslint/no-explicit-any */
const ID_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/

export interface AiQueryInput {
  table: string
  columns?: string                      // 'a, b, c' または '*'（省略時 *）
  filters?: { column: string; op: string; value: any }[]
  order?: { column: string; ascending?: boolean }
  limit?: number
  facilityIn?: string[] | null          // memberの許可施設（null/未指定=制限なし）
}

let pool: Pool | null = null

export function aiDbAvailable(): boolean {
  return !!process.env.AI_DB_URL
}

function getPool(): Pool {
  if (!pool) {
    pool = new Pool({
      connectionString: process.env.AI_DB_URL,
      max: 1,                            // serverless: 1コネクションで十分（Supavisorが多重化）
      idleTimeoutMillis: 10_000,
      connectionTimeoutMillis: 8_000,
      ssl: { rejectUnauthorized: false },
    })
  }
  return pool
}

function ident(name: string, kind: string): string {
  if (!ID_RE.test(name)) throw new Error(`不正な${kind}: ${name}`)
  return `"${name}"`
}

// mart_ai スキーマ限定のSELECTビルダー（識別子は正規表現検証、値は全てパラメータ化）
export async function queryMartAi(q: AiQueryInput): Promise<any[]> {
  const table = ident(q.table, 'テーブル名')
  const colsRaw = (q.columns ?? '*').split(',').map((s) => s.trim()).filter(Boolean)
  const colSql = colsRaw.length === 1 && colsRaw[0] === '*'
    ? '*'
    : colsRaw.map((c) => ident(c, '列名')).join(', ')

  const params: any[] = []
  const conds: string[] = []
  for (const f of q.filters ?? []) {
    const col = ident(f.column, '列名')
    if (f.op === 'eq') { params.push(f.value); conds.push(`${col} = $${params.length}`) }
    else if (f.op === 'neq') { params.push(f.value); conds.push(`${col} <> $${params.length}`) }
    else if (f.op === 'gte') { params.push(f.value); conds.push(`${col} >= $${params.length}`) }
    else if (f.op === 'lte') { params.push(f.value); conds.push(`${col} <= $${params.length}`) }
    else if (f.op === 'like') { params.push(`%${f.value}%`); conds.push(`${col} ILIKE $${params.length}`) }
    else if (f.op === 'in') {
      const arr = Array.isArray(f.value) ? f.value : [f.value]
      params.push(arr); conds.push(`${col} = ANY($${params.length})`)
    }
    else throw new Error(`不正な演算子: ${f.op}`)
  }
  if (q.facilityIn != null) {
    if (q.facilityIn.length === 0) throw new Error('閲覧可能な施設がありません')
    params.push(q.facilityIn)
    conds.push(`"facility" = ANY($${params.length})`)
  }

  let sql = `select ${colSql} from mart_ai.${table}`
  if (conds.length) sql += ' where ' + conds.join(' and ')
  if (q.order?.column) sql += ` order by ${ident(q.order.column, '列名')} ${q.order.ascending === false ? 'desc' : 'asc'}`
  sql += ` limit ${Math.min(Math.max(1, q.limit ?? 100), 300)}`

  const res = await getPool().query(sql, params)
  return res.rows
}
