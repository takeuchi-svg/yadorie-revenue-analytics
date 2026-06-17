'use client'

import { FacilityProvider } from '@/lib/facility-context'
import AuthGuard from './auth-guard'
import Sidebar from './sidebar'
import type { ReactNode } from 'react'

export default function DashboardLayout({ children }: { children: ReactNode }) {
  return (
    <AuthGuard>
      <FacilityProvider>
        <div className="flex min-h-screen" style={{ background: 'var(--bg)' }}>
          <Sidebar />
          <main className="flex-1 overflow-auto" style={{ background: 'var(--bg)', color: 'var(--text)' }}>
            {children}
          </main>
        </div>
      </FacilityProvider>
    </AuthGuard>
  )
}
