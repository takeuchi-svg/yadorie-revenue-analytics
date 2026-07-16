// 統合月次レポート（実績サマリ＋課題と対策＋会議パックを1本化）の生成/読込。
// 概要ページ と 月次会議タブ の両方が使う。キャッシュは ai_meeting_pack(facility,month) を共有＝同一内容を2箇所に表示。
import { supabase } from '@/lib/supabase/client'
import { buildMeetingMaterial } from '@/lib/meeting-data'

async function authedPost(url: string, body: unknown) {
  const { data: { session } } = await supabase.auth.getSession()
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(session ? { Authorization: `Bearer ${session.access_token}` } : {}) },
    body: JSON.stringify(body),
  })
  return res.json()
}

// キャッシュ読込のみ（material無し）。無ければ空文字。
export async function loadMeetingReport(facility: string, month: string): Promise<string> {
  const r = await authedPost('/api/meeting-pack', { facility, month })
  return (r?.content as string) || ''
}

// 生成（材料をクライアントで算出→APIへ）。キャッシュを更新して本文を返す。
export async function generateMeetingReport(facility: string, month: string): Promise<{ content: string; error?: string }> {
  const material = await buildMeetingMaterial(supabase, facility, month)
  const r = await authedPost('/api/meeting-pack', { facility, month, material, force: true })
  return { content: (r?.content as string) || '', error: r?.error as string | undefined }
}
