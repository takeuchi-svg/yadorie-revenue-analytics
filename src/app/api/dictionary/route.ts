// 辞書API（全ユーザー閲覧可）。公開中のKPI辞書・用語集を返す。
// kpi_definition/glossary は min_role_view=admin のRLSがかかるため、
// 一般ユーザーにも見せるべく service_role で published のみ返す（定義は守秘対象ではない）。
import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { requireUser, isAuthErr } from '@/lib/ai/auth'

export const runtime = 'nodejs'
const admin = () => createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })

export async function POST(req: NextRequest) {
  const auth = await requireUser(req)
  if (isAuthErr(auth)) return NextResponse.json({ error: auth.error }, { status: auth.status })
  const sb = admin()
  const [kpi, glossary] = await Promise.all([
    sb.from('kpi_definition').select('kpi_key, label_ja, formula, numerator, denominator, unit, direction, note')
      .eq('status', 'published').order('kpi_key'),
    sb.from('glossary').select('term, definition_ja, note').eq('status', 'published').order('term'),
  ])
  return NextResponse.json({ kpi: kpi.data ?? [], glossary: glossary.data ?? [] })
}
