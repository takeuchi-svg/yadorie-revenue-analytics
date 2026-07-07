// サーバー専用: APIルートの認証・施設権限チェック（admin/users と同方式）
import { NextRequest } from 'next/server'
import { createClient } from '@supabase/supabase-js'

export interface AuthOk {
  userId: string
  isAdmin: boolean
  isOwner: boolean            // owner=克樹さんのみ（人格・プロンプト編集権限）
  facilities: string[] | null // null = 全施設可（admin/owner）
}
export interface AuthErr { error: string; status: number }

export async function requireUser(req: NextRequest): Promise<AuthOk | AuthErr> {
  const URL = process.env.NEXT_PUBLIC_SUPABASE_URL!
  const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY!
  const token = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '')
  if (!token) return { error: '未認証です。再ログインしてください。', status: 401 }
  const anon = createClient(URL, ANON, { auth: { persistSession: false } })
  const { data: { user }, error } = await anon.auth.getUser(token)
  if (error || !user) return { error: '認証に失敗しました。再ログインしてください。', status: 401 }
  const admin = createClient(URL, SERVICE, { auth: { persistSession: false } })
  const { data: au } = await admin.from('app_user').select('role').eq('user_id', user.id).maybeSingle()
  // owner > admin > member。owner は admin の全権限＋ナレッジ/プロンプト編集
  if (au?.role === 'admin' || au?.role === 'owner') {
    return { userId: user.id, isAdmin: true, isOwner: au.role === 'owner', facilities: null }
  }
  // member（app_user 行なしも member 扱い＝フェイルクローズ）
  const { data: uf } = await admin.from('user_facility').select('facility').eq('user_id', user.id)
  return { userId: user.id, isAdmin: false, isOwner: false, facilities: ((uf ?? []) as { facility: string }[]).map((r) => r.facility) }
}

export function isAuthErr(r: AuthOk | AuthErr): r is AuthErr {
  return 'error' in r
}

// 指定施設へのアクセス可否
export function facilityAllowed(auth: AuthOk, facility: string | undefined): boolean {
  if (auth.isAdmin) return true
  if (!facility) return false
  return (auth.facilities ?? []).includes(facility)
}
