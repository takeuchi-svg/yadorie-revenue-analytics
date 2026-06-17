'use client'

import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { useFacility } from '@/lib/facility-context'
import { supabase } from '@/lib/supabase/client'

const NAV_GROUPS: { group: string; items: { href: string; label: string }[] }[] = [
  {
    group: 'VIEWS',
    items: [
      { href: '/', label: 'Overview' },
      { href: '/revenue', label: 'Revenue' },
      { href: '/onhand', label: 'On-hand' },
    ],
  },
  {
    group: 'ANALYSIS',
    items: [
      { href: '/rate', label: 'Rate' },
      { href: '/cancel', label: 'Cancel' },
      { href: '/fb', label: 'F&B' },
      { href: '/ota', label: 'OTA' },
    ],
  },
  {
    group: 'TOOLS',
    items: [
      { href: '/upload', label: 'Upload' },
      { href: '/settings', label: 'Settings' },
    ],
  },
]

export default function Sidebar() {
  const pathname = usePathname()
  const { facilities, current, setCurrent } = useFacility()
  const router = useRouter()

  const handleLogout = async () => {
    await supabase.auth.signOut()
    router.push('/login')
    router.refresh()
  }

  return (
    <aside
      className="flex flex-col min-h-screen shrink-0"
      style={{ width: 220, background: 'var(--surface)', borderRight: '1px solid var(--border)' }}
    >
      {/* Logo */}
      <div className="px-5 py-4" style={{ borderBottom: '1px solid var(--border)' }}>
        <div className="text-lg font-bold tracking-wide" style={{ color: 'var(--text)' }}>
          YADORIE
        </div>
        <div className="text-xs" style={{ color: 'var(--text-dim)' }}>
          Revenue Analytics
        </div>
      </div>

      {/* Nav */}
      <nav className="flex-1 px-3 py-4 space-y-5 overflow-y-auto">
        {NAV_GROUPS.map((g) => (
          <div key={g.group}>
            <div
              className="px-2 mb-1 text-[10px] font-semibold tracking-widest"
              style={{ color: 'var(--text-dim)' }}
            >
              {g.group}
            </div>
            <div className="space-y-0.5">
              {g.items.map((item) => {
                const active = pathname === item.href
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    className="flex items-center gap-2 px-3 py-2 rounded-md text-sm transition-colors"
                    style={{
                      background: active ? 'var(--accent)' : 'transparent',
                      color: active ? '#fff' : 'var(--text-dim)',
                    }}
                  >
                    {item.label}
                  </Link>
                )
              })}
            </div>
          </div>
        ))}
      </nav>

      {/* Facility selector + logout */}
      <div className="p-3 space-y-3" style={{ borderTop: '1px solid var(--border)' }}>
        <div>
          <label className="block text-[10px] mb-1 tracking-wide" style={{ color: 'var(--text-dim)' }}>
            施設
          </label>
          <select
            className="field w-full px-2 py-1.5 text-sm"
            value={current}
            onChange={(e) => setCurrent(e.target.value)}
          >
            {facilities.map((f) => (
              <option key={f.facility} value={f.facility}>
                {f.name}
              </option>
            ))}
          </select>
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
