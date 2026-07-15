'use client'

// 上部バーに現在選択中の宿名を表示（各ページのタイトル下から昇格）。全社モードでは出さない。
import { useFacility } from '@/lib/facility-context'

export default function TopbarFacility() {
  const { currentFacility, current, mode } = useFacility()
  const name = currentFacility?.name ?? current
  if (mode === 'company' || !name) return null
  return (
    <span className="text-sm font-medium truncate" style={{ color: 'var(--text)', maxWidth: 260 }} title={name}>
      {name}
    </span>
  )
}
