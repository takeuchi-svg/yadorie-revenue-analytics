'use client'

// 宿プロフィール（設定から「ビュー」へ昇格。宿の意図・物語のホーム）。
// 4タブの器: プロフィール / 月次会議 / 修繕投資計画 / 人員計画。
// タブ1=既存プロフィール編集。他3タブは順次実装（月次会議=Phase2、修繕投資/人員計画=別テーマ）。
import { useState } from 'react'
import FacilityProfile from '@/components/facility-profile'

type Tab = 'profile' | 'meeting' | 'capex' | 'staffing'
const TABS: { key: Tab; label: string; ready: boolean }[] = [
  { key: 'profile', label: 'プロフィール', ready: true },
  { key: 'meeting', label: '月次会議', ready: false },
  { key: 'capex', label: '修繕投資計画', ready: false },
  { key: 'staffing', label: '人員計画', ready: false },
]

function ComingSoon({ label }: { label: string }) {
  return (
    <div className="card p-8 mt-4 text-center" style={{ color: 'var(--text-dim)' }}>
      <div className="text-sm">「{label}」は準備中です。</div>
    </div>
  )
}

export default function ProfilePage() {
  const [tab, setTab] = useState<Tab>('profile')
  return (
    <div className="p-6">
      <div className="flex gap-1 flex-wrap">
        {TABS.map((t) => (
          <button key={t.key} onClick={() => setTab(t.key)}
            className="px-4 py-1.5 rounded-md text-sm transition-colors"
            style={{
              background: tab === t.key ? 'var(--accent)' : 'var(--surface2)',
              color: tab === t.key ? '#fff' : 'var(--text-dim)',
            }}>
            {t.label}{!t.ready && <span className="ml-1 text-[9px]">準備中</span>}
          </button>
        ))}
      </div>

      {tab === 'profile' && <FacilityProfile />}
      {tab === 'meeting' && <ComingSoon label="月次会議" />}
      {tab === 'capex' && <ComingSoon label="修繕投資計画" />}
      {tab === 'staffing' && <ComingSoon label="人員計画" />}
    </div>
  )
}
