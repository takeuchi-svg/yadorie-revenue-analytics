'use client'

// 上部バーに現在選択中の施設名を表示（各ページのタイトル下から昇格）。
import { useFacility } from '@/lib/facility-context'

export default function TopbarFacility() {
  const { currentFacility, current } = useFacility()
  const name = currentFacility?.name ?? current
  if (!name) return null
  return (
    <span className="text-sm font-medium truncate" style={{ color: 'var(--text)', maxWidth: 260 }} title={name}>
      {name}
    </span>
  )
}
