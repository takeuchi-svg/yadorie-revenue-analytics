'use client'

// 施設プロフィール（設定から「ビュー」へ昇格。宿の意図・物語のホーム）
import { useFacility } from '@/lib/facility-context'
import FacilityProfile from '@/components/facility-profile'

export default function ProfilePage() {
  const { current, currentFacility } = useFacility()
  return (
    <div className="p-6">
      <div className="mb-1">
        <h1 className="text-2xl font-bold mb-1">施設プロフィール</h1>
        <p className="text-sm" style={{ color: 'var(--text-dim)' }}>
          {currentFacility?.name ?? current} — この宿の意図・方針・物語を記録します（AI分析の前提になります）
        </p>
      </div>
      <FacilityProfile />
    </div>
  )
}
