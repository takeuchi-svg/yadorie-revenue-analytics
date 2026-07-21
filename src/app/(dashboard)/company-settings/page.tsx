'use client'

// 全社設定（全社Core・owner限定）: 正社員人件費（宿×月）/ 宿タイプ一括設定 / ユーザー管理。
// 人件費モデルv2: 個人給与は持たない。正社員=宿×月の月額（ここ）、アルバイト標準時給・従業員追加=各宿設定。
import { useFacility } from '@/lib/facility-context'
import UserAdmin from '@/components/user-admin'
import FacilityTypeAdmin from '@/components/facility-type-admin'
import RegularLaborAdmin from '@/components/regular-labor-admin'

export default function CompanySettingsPage() {
  const { isOwner } = useFacility()

  if (!isOwner) return (
    <div className="p-6">
      <div className="card p-6 text-sm" style={{ color: 'var(--text-dim)' }}>
        全社設定は<strong>オーナーのみ</strong>が利用できます。
      </div>
    </div>
  )

  return (
    <div className="p-6 max-w-4xl">
      <div className="mb-4">
        <h1 className="text-lg font-semibold">全社設定</h1>
        <p className="text-xs mt-0.5" style={{ color: 'var(--text-dim)' }}>
          正社員人件費・宿タイプ・ユーザーの横断管理。従業員の追加とアルバイト標準時給は「各宿」タブの各宿設定へ。
        </p>
      </div>

      <RegularLaborAdmin />
      <FacilityTypeAdmin />
      <UserAdmin />
    </div>
  )
}
