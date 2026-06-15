'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useFacility } from '@/lib/facility-context'
import { supabase } from '@/lib/supabase/client'
import { useRouter } from 'next/navigation'

const NAV_ITEMS = [
  { href: '/', label: 'Overview', icon: '📊' },
  { href: '/revenue', label: 'Revenue', icon: '💰' },
  { href: '/upload', label: 'Upload', icon: '📤' },
  { href: '/settings', label: 'Settings', icon: '⚙️' },
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
    <aside className="w-56 bg-gray-900 text-white flex flex-col min-h-screen">
      <div className="p-4 border-b border-gray-700">
        <h1 className="text-lg font-bold">売上分析BI</h1>
      </div>

      <nav className="flex-1 p-3 space-y-1">
        {NAV_ITEMS.map((item) => {
          const active = pathname === item.href
          return (
            <Link
              key={item.href}
              href={item.href}
              className={`flex items-center gap-2 px-3 py-2 rounded-md text-sm ${
                active
                  ? 'bg-gray-700 text-white'
                  : 'text-gray-300 hover:bg-gray-800 hover:text-white'
              }`}
            >
              <span>{item.icon}</span>
              {item.label}
            </Link>
          )
        })}
      </nav>

      <div className="p-3 border-t border-gray-700 space-y-3">
        <div>
          <label className="block text-xs text-gray-400 mb-1">施設</label>
          <select
            className="w-full bg-gray-800 border border-gray-600 rounded px-2 py-1.5 text-sm"
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
          className="w-full text-left text-xs text-gray-400 hover:text-white px-2 py-1"
        >
          ログアウト
        </button>
      </div>
    </aside>
  )
}
