'use client'

// ビュー配下（概要・宿プロフィール・月次会議）を切り替える上部タブ。各ページ先頭に置く。
import Link from 'next/link'
import { usePathname } from 'next/navigation'

const TABS = [
  { href: '/', label: '概要' },
  { href: '/profile', label: '宿プロフィール' },
  { href: '/meeting', label: '月次会議' },
]

export default function ViewTabs() {
  const pathname = usePathname()
  return (
    <div className="flex gap-1 mb-5 flex-wrap">
      {TABS.map((t) => {
        const active = pathname === t.href
        return (
          <Link key={t.href} href={t.href}
            className="px-4 py-1.5 rounded-md text-sm font-medium transition-colors"
            style={{ background: active ? 'var(--accent)' : 'var(--surface)', color: active ? '#fff' : 'var(--text-dim)', border: '1px solid var(--border)' }}>
            {t.label}
          </Link>
        )
      })}
    </div>
  )
}
