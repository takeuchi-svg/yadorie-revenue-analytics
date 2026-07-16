'use client'

// 宿プロフィール（ビュー配下）。宿の意図・物語のホーム。
// 月次会議は「ビュー→月次会議」、修繕投資計画・人員計画は「予実管理→予算作成」タブへ移設済み。
import FacilityProfile from '@/components/facility-profile'

export default function ProfilePage() {
  return (
    <div className="p-6">
      <FacilityProfile />
    </div>
  )
}
