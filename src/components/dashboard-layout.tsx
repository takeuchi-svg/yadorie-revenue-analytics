'use client'

import { useState, type ReactNode } from 'react'
import { FacilityProvider } from '@/lib/facility-context'
import AuthGuard from './auth-guard'
import Sidebar from './sidebar'
import AiDrawer, { SparkleIcon } from './ai-drawer'

export default function DashboardLayout({ children }: { children: ReactNode }) {
  const [leftOpen, setLeftOpen] = useState(true)
  const [aiOpen, setAiOpen] = useState(false)

  return (
    <AuthGuard>
      <FacilityProvider>
        <div className="flex h-screen overflow-hidden" style={{ background: 'var(--bg)' }}>
          {leftOpen && <Sidebar />}
          <main className="flex-1 min-w-0 overflow-auto flex flex-col" style={{ background: 'var(--bg)', color: 'var(--text)' }}>
            {/* Top bar */}
            <div className="flex items-center justify-between px-4 h-12 shrink-0 sticky top-0 z-10"
              style={{ background: 'var(--bg)', borderBottom: '1px solid var(--border)' }}>
              <button onClick={() => setLeftOpen((v) => !v)} title="サイドバー開閉"
                className="px-2 py-1 rounded-md text-sm hover:opacity-80" style={{ color: 'var(--text-dim)', border: '1px solid var(--border)' }}>
                {leftOpen ? '«' : '»'}
              </button>
              <button onClick={() => setAiOpen((v) => !v)} title="AIアシスタント"
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm"
                style={{ background: aiOpen ? 'var(--accent)' : 'var(--surface)', color: aiOpen ? '#fff' : 'var(--text)', border: '1px solid var(--border)' }}>
                <SparkleIcon size={16} /> AI
              </button>
            </div>
            <div className="flex-1">{children}</div>
          </main>
          {aiOpen && <AiDrawer onClose={() => setAiOpen(false)} />}
        </div>
      </FacilityProvider>
    </AuthGuard>
  )
}
