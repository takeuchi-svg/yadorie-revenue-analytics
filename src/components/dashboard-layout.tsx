'use client'

import { FacilityProvider } from '@/lib/facility-context'
import Sidebar from './sidebar'
import type { ReactNode } from 'react'

export default function DashboardLayout({ children }: { children: ReactNode }) {
  return (
    <FacilityProvider>
      <div className="flex min-h-screen">
        <Sidebar />
        <main className="flex-1 bg-gray-50 overflow-auto">{children}</main>
      </div>
    </FacilityProvider>
  )
}
