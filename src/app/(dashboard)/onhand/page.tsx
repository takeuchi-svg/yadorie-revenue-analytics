// 旧「予約状況（オンハンド）」は「売上状況」(/sales) に統合（2026-07 売上分析再編）。
// 室泊ピックアップ・埋まり率は売上軸へ一本化。旧URLへのアクセスはリダイレクト。
import { redirect } from 'next/navigation'

export default function OnhandRedirect() {
  redirect('/sales')
}
