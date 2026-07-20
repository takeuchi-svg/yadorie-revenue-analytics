'use client'

// 各宿設定（各宿モード）。この宿だけの設定。第一弾＝シフトパターン管理。
// 全社横断の設定（賃金・宿タイプ・ユーザー）は「全社設定」(/company-settings)へ。
import { useFacility } from '@/lib/facility-context'
import ShiftPatternAdmin from '@/components/shift-pattern-admin'
import LaborStandardAdmin from '@/components/labor-standard-admin'

export default function SettingsPage() {
  const { current, currentFacility } = useFacility()
  if (!current) return <div className="p-6 text-sm" style={{ color: 'var(--text-dim)' }}>宿を選択してください。</div>
  return (
    <div className="p-6 max-w-5xl">
      <div className="mb-4">
        <h1 className="text-lg font-semibold">各宿設定{currentFacility?.name ? `（${currentFacility.name}）` : ''}</h1>
        <p className="text-xs mt-0.5" style={{ color: 'var(--text-dim)' }}>この宿だけの設定。全社横断（賃金・宿タイプ・ユーザー）は全社設定へ。</p>
      </div>
      <ShiftPatternAdmin />
      <LaborStandardAdmin />
    </div>
  )
}
