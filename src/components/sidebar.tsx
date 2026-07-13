'use client'

// YADORIE Core サイドバー
// グループにホバー/クリックで右横にサブメニュー（フライアウト）が開く（freee風）。
// サブを持たないグループ（顧客満足度）は直接リンク。
import Link from 'next/link'
import { useState } from 'react'
import { usePathname, useRouter } from 'next/navigation'
import { useFacility } from '@/lib/facility-context'
import { supabase } from '@/lib/supabase/client'
import { FacilitySelect } from '@/components/facility-select'

interface NavItem { href: string; label: string; disabled?: boolean; note?: string }
interface NavGroup { key: string; label: string; href?: string; items?: NavItem[] }

const NAV_GROUPS: NavGroup[] = [
  {
    key: 'view', label: 'ビュー',
    items: [
      { href: '/', label: '概要' },
      { href: '/profile', label: '施設プロフィール' },
    ],
  },
  {
    key: 'analysis', label: '分析',
    items: [
      { href: '/revenue', label: '売上分析' },
      { href: '/daily', label: '日別売上' },
      { href: '/cancel', label: 'CXL＆LT分析' },
      { href: '/fb', label: '料飲分析' },
      { href: '/yojitsu', label: '予実管理（PL）' },
      { href: '/productivity', label: '生産性' },
    ],
  },
  { key: 'review', label: '顧客満足度', href: '/review' },
  {
    key: 'shift', label: 'シフト労務',
    items: [
      { href: '/shift', label: 'シフト管理' },
      { href: '#', label: 'スキルマップ', disabled: true, note: '準備中' },
    ],
  },
  {
    key: 'onhand', label: 'オンハンド',
    items: [
      { href: '/onhand', label: '予約状況（オンハンド）' },
      { href: '/rate', label: 'レートコントロール' },
      { href: '/ota', label: 'OTA分析' },
    ],
  },
]

// 左下に固定するツール（施設選択の下・ログアウトの上）
const BOTTOM_TOOLS: { href: string; label: string }[] = [
  { href: '/upload', label: 'アップロード' },
  { href: '/settings', label: '設定' },
]

export default function Sidebar() {
  const pathname = usePathname()
  const { facilities, current, setCurrent, isOwner } = useFacility()
  const router = useRouter()
  const [openGroup, setOpenGroup] = useState<string | null>(null)
  // 辞書(KPI辞書・用語集)は全員閲覧可。「灯の頭の中」はオーナーのみ（ページ側でも権限ガード）
  const bottomTools = [
    ...BOTTOM_TOOLS,
    { href: '/dict', label: '辞書' },
    ...(isOwner ? [{ href: '/knowledge', label: '灯の頭の中' }] : []),
  ]

  const handleLogout = async () => {
    await supabase.auth.signOut()
    router.push('/login')
    router.refresh()
  }

  const groupActive = (g: NavGroup) =>
    g.href ? pathname === g.href : (g.items ?? []).some((i) => !i.disabled && pathname === i.href)

  return (
    <aside
      className="flex flex-col h-screen shrink-0"
      style={{ width: 220, background: 'var(--surface)', borderRight: '1px solid var(--border)' }}
    >
      {/* Logo（クリックで概要トップへ） */}
      <Link href="/" onMouseEnter={() => setOpenGroup(null)} className="block px-4 py-4 hover:opacity-80 transition-opacity" style={{ borderBottom: '1px solid var(--border)' }}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/yadorie-logo.png" alt="YADORIE宿GROUP" style={{ height: 30, width: 'auto' }} />
        <div className="text-[10px] mt-1.5 tracking-wide" style={{ color: 'var(--text-dim)' }}>
          Core — 宿の数だけ、ストーリー。
        </div>
      </Link>

      {/* Nav（グループ＋フライアウト） */}
      <nav className="flex-1 px-3 py-4 space-y-1 overflow-y-visible" onMouseLeave={() => setOpenGroup(null)}>
        {NAV_GROUPS.map((g) => {
          const active = groupActive(g)
          const open = openGroup === g.key
          const rowStyle = {
            background: active ? 'var(--accent)' : open ? 'var(--surface2)' : 'transparent',
            color: active ? '#fff' : 'var(--text)',
          }
          // サブなし＝直接リンク
          if (g.href) {
            return (
              <Link key={g.key} href={g.href} onMouseEnter={() => setOpenGroup(null)}
                className="flex items-center justify-between px-3 py-2.5 rounded-md text-sm font-medium transition-colors"
                style={rowStyle}>
                {g.label}
              </Link>
            )
          }
          return (
            <div key={g.key} className="relative" onMouseEnter={() => setOpenGroup(g.key)}>
              <button
                onClick={() => setOpenGroup(open ? null : g.key)}
                className="w-full flex items-center justify-between px-3 py-2.5 rounded-md text-sm font-medium transition-colors"
                style={rowStyle}>
                {g.label}
                <span className="text-[10px]" style={{ color: active ? '#fff' : 'var(--text-dim)' }}>›</span>
              </button>
              {/* フライアウト */}
              {open && (
                <div className="absolute z-50 rounded-lg py-2 shadow-lg"
                  style={{ left: '100%', top: 0, width: 200, background: 'var(--surface)', border: '1px solid var(--border)', marginLeft: 2 }}>
                  <div className="px-3 pb-1.5 text-[10px] font-semibold tracking-widest" style={{ color: 'var(--text-dim)' }}>{g.label}</div>
                  {(g.items ?? []).map((item) => {
                    if (item.disabled) {
                      return (
                        <div key={item.label} className="flex items-center justify-between px-3 py-2 text-sm" style={{ color: 'var(--text-dim)', opacity: 0.55, cursor: 'not-allowed' }}>
                          {item.label}
                          {item.note && <span className="text-[9px] px-1.5 py-0.5 rounded" style={{ background: 'var(--surface2)' }}>{item.note}</span>}
                        </div>
                      )
                    }
                    const itemActive = pathname === item.href
                    return (
                      <Link key={item.href} href={item.href} onClick={() => setOpenGroup(null)}
                        className="block px-3 py-2 text-sm transition-colors"
                        style={{
                          background: itemActive ? 'var(--accent)' : 'transparent',
                          color: itemActive ? '#fff' : 'var(--text)',
                          borderLeft: itemActive ? 'none' : '2px solid var(--border)',
                          marginLeft: itemActive ? 0 : 10,
                          paddingLeft: itemActive ? 22 : 10,
                        }}>
                        {item.label}
                      </Link>
                    )
                  })}
                </div>
              )}
            </div>
          )
        })}
      </nav>

      {/* 左下固定: 施設選択 → アップロード/設定 → ログアウト */}
      <div className="p-3 space-y-3 shrink-0" style={{ borderTop: '1px solid var(--border)' }}>
        <div>
          <label className="block text-[10px] mb-1 tracking-wide" style={{ color: 'var(--text-dim)' }}>
            施設
          </label>
          <FacilitySelect options={facilities} value={current} onChange={setCurrent} />
          {facilities.length > 12 && (
            <p className="mt-1 text-[10px]" style={{ color: 'var(--text-dim)' }}>{facilities.length}施設・検索可</p>
          )}
        </div>

        <div className="space-y-0.5">
          {bottomTools.map((item) => {
            const active = pathname === item.href
            return (
              <Link
                key={item.href}
                href={item.href}
                className="flex items-center gap-2 px-3 py-2 rounded-md text-sm transition-colors"
                style={{ background: active ? 'var(--accent)' : 'transparent', color: active ? '#fff' : 'var(--text-dim)' }}
              >
                {item.label}
              </Link>
            )
          })}
        </div>

        <button
          onClick={handleLogout}
          className="w-full text-left text-xs px-2 py-1 hover:opacity-80"
          style={{ color: 'var(--text-dim)' }}
        >
          ログアウト
        </button>
      </div>
    </aside>
  )
}
