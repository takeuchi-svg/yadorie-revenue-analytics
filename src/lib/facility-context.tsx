'use client'

import { createContext, useContext, useState, useEffect, type ReactNode } from 'react'
import { supabase } from './supabase/client'

interface Facility {
  facility: string
  name: string
  short_name: string | null
  total_rooms: number | null
}

interface FacilityContextType {
  facilities: Facility[]
  current: string
  setCurrent: (code: string) => void
  currentFacility: Facility | null
  isAdmin: boolean
}

const FacilityContext = createContext<FacilityContextType>({
  facilities: [],
  current: '',
  setCurrent: () => {},
  currentFacility: null,
  isAdmin: false,
})

const COOKIE_KEY = 'currentFacility'

function readFacilityCookie(): string | null {
  if (typeof document === 'undefined') return null
  const match = document.cookie.match(/(?:^|;\s*)currentFacility=([^;]+)/)
  return match ? decodeURIComponent(match[1]) : null
}

function writeFacilityCookie(code: string) {
  if (typeof document === 'undefined') return
  document.cookie = `${COOKIE_KEY}=${encodeURIComponent(code)}; path=/; max-age=31536000; samesite=lax`
}

export function FacilityProvider({ children }: { children: ReactNode }) {
  const [facilities, setFacilities] = useState<Facility[]>([])
  const [current, setCurrent] = useState<string>('')
  const [isAdmin, setIsAdmin] = useState(false)

  useEffect(() => {
    ;(async () => {
      const { data: facData } = await supabase
        .from('dim_facility').select('facility, name, short_name, total_rooms').order('facility')
      const all = (facData as Facility[]) ?? []

      let admin = true
      let allowed = all
      try {
        const { data: { user } } = await supabase.auth.getUser()
        if (user) {
          const { data: au, error } = await supabase.from('app_user').select('role').eq('user_id', user.id).maybeSingle()
          if (error) throw error // テーブル未作成 → フォールバック(全施設/admin)
          if (au) {
            admin = au.role === 'admin'
            if (!admin) {
              const { data: uf } = await supabase.from('user_facility').select('facility').eq('user_id', user.id)
              const set = new Set((uf ?? []).map((r: { facility: string }) => r.facility))
              allowed = all.filter((f) => set.has(f.facility))
            }
          } else {
            admin = true // app_user未登録 → 暫定で全権限(初期ブートストラップ)
          }
        }
      } catch { admin = true; allowed = all }

      setIsAdmin(admin)
      setFacilities(allowed)
      if (allowed.length > 0) {
        const saved = readFacilityCookie()
        const valid = allowed.find((f) => f.facility === saved)
        setCurrent(valid ? saved! : allowed[0].facility)
      }
    })()
  }, [])

  const handleSetCurrent = (code: string) => {
    setCurrent(code)
    writeFacilityCookie(code)
  }

  const currentFacility = facilities.find((f) => f.facility === current) ?? null

  return (
    <FacilityContext.Provider value={{ facilities, current, setCurrent: handleSetCurrent, currentFacility, isAdmin }}>
      {children}
    </FacilityContext.Provider>
  )
}

export function useFacility() {
  return useContext(FacilityContext)
}
