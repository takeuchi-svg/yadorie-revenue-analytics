'use client'

// 各宿設定: 選択中の宿に紐づく設定の入口。
// 総客室数・月別稼働日数・宿の意図/方針は「宿プロフィール」で編集。
// 賃金・宿タイプ一括・ユーザー管理は「全社」タブ →「全社設定」へ移設。
import { useFacility } from '@/lib/facility-context'

export default function SettingsPage() {
  const { current, currentFacility, isOwner } = useFacility()
  const name = currentFacility?.name ?? current

  return (
    <div className="p-6 max-w-3xl">
      <div className="mb-4">
        <h1 className="text-lg font-semibold">設定{name && <span className="text-sm ml-2" style={{ color: 'var(--text-dim)' }}>{name}</span>}</h1>
        <p className="text-xs mt-0.5" style={{ color: 'var(--text-dim)' }}>この宿に関する設定です。</p>
      </div>

      <section className="card p-6">
        <h2 className="text-base font-semibold mb-1">宿プロフィール・マスタ</h2>
        <p className="text-sm mb-3" style={{ color: 'var(--text-dim)' }}>
          総客室数・月別稼働日数、宿の意図・方針・取組履歴の編集は{' '}
          <a href="/profile" style={{ color: 'var(--accent)' }}>宿プロフィール</a> で行います。
        </p>
      </section>

      {isOwner && (
        <section className="card p-6 mt-4">
          <h2 className="text-base font-semibold mb-1">賃金・宿タイプ・ユーザー管理</h2>
          <p className="text-sm" style={{ color: 'var(--text-dim)' }}>
            これらの横断的な設定は上部の「全社」タブ →{' '}
            <a href="/company-settings" style={{ color: 'var(--accent)' }}>全社設定</a> に移動しました。
          </p>
        </section>
      )}
    </div>
  )
}
