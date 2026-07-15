'use client'

// 宿プロフィール（設定から「ビュー」へ昇格。宿の意図・物語のホーム）
import { useFacility } from '@/lib/facility-context'
import FacilityProfile from '@/components/facility-profile'

export default function ProfilePage() {
  const { current, currentFacility } = useFacility()
  return (
    <div className="p-6">
      <FacilityProfile />
    </div>
  )
}
