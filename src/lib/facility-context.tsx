'use client'

import { createContext, useContext, useState, useEffect, type ReactNode } from 'react'
import { supabase } from './supabase/client'

interface Facility {
  facility: string
  name: string
  short_name: string | null
  total_rooms: number | null
}

// 表示モード: 全社（全社Core）/ 各宿（従来の宿別）。全社は owner のみ。
export type ViewMode = 'company' | 'facility'

interface FacilityContextType {
  facilities: Facility[]
  current: string
  setCurrent: (code: string) => void
  currentFacility: Facility | null
  isAdmin: boolean
  isOwner: boolean   // owner=克樹さんのみ（灯の頭の中の編集権限）
  mode: ViewMode
  setMode: (m: ViewMode) => void
  canCompany: boolean  // 全社モードに入れるか（=owner）
}

const FacilityContext = createContext<FacilityContextType>({
  facilities: [],
  current: '',
  setCurrent: () => {},
  currentFacility: null,
  isAdmin: false,
  isOwner: false,
  mode: 'facility',
  setMode: () => {},
  canCompany: false,
})

const COOKIE_KEY = 'currentFacility'
const MODE_COOKIE = 'viewMode'

function readCookie(key: string): string | null {
  if (typeof document === 'undefined') return null
  const match = document.cookie.match(new RegExp(`(?:^|;\\s*)${key}=([^;]+)`))
  return match ? decodeURIComponent(match[1]) : null
}
function writeCookie(key: string, value: string) {
  if (typeof document === 'undefined') return
  document.cookie = `${key}=${encodeURIComponent(value)}; path=/; max-age=31536000; samesite=lax`
}
const readFacilityCookie = () => readCookie(COOKIE_KEY)
const writeFacilityCookie = (code: string) => writeCookie(COOKIE_KEY, code)

export function FacilityProvider({ children }: { children: ReactNode }) {
  const [facilities, setFacilities] = useState<Facility[]>([])
  const [current, setCurrent] = useState<string>('')
  const [isAdmin, setIsAdmin] = useState(false)
  const [isOwner, setIsOwner] = useState(false)
  const [mode, setModeState] = useState<ViewMode>('facility')

  useEffect(() => {
    ;(async () => {
      const { data: facData } = await supabase
        .from('dim_facility').select('facility, name, short_name, total_rooms').order('facility')
      const all = (facData as Facility[]) ?? []

      // フェイルクローズ: 権限が確認できない場合は「施設ゼロのmember」扱い（誤って全施設を見せない）
      let admin = false
      let owner = false
      let allowed: Facility[] = []
      try {
        const { data: { user } } = await supabase.auth.getUser()
        if (user) {
          const { data: au, error } = await supabase.from('app_user').select('role').eq('user_id', user.id).maybeSingle()
          if (error) throw error
          owner = au?.role === 'owner'
          admin = au?.role === 'admin' || au?.role === 'owner'
          if (admin) {
            allowed = all
          } else {
            const { data: uf } = await supabase.from('user_facility').select('facility').eq('user_id', user.id)
            const set = new Set((uf ?? []).map((r: { facility: string }) => r.facility))
            allowed = all.filter((f) => set.has(f.facility))
          }
        }
      } catch { admin = false; owner = false; allowed = [] }

      setIsAdmin(admin)
      setIsOwner(owner)
      setFacilities(allowed)
      if (allowed.length > 0) {
        const saved = readFacilityCookie()
        const valid = allowed.find((f) => f.facility === saved)
        setCurrent(valid ? saved! : allowed[0].facility)
      }
      // 全社モードは owner のみ。ownerかつCookieが'company'なら全社で開始、それ以外は各宿。
      setModeState(owner && readCookie(MODE_COOKIE) === 'company' ? 'company' : 'facility')
    })()
  }, [])

  const handleSetCurrent = (code: string) => {
    setCurrent(code)
    writeFacilityCookie(code)
  }
  const handleSetMode = (m: ViewMode) => {
    const next = m === 'company' && !isOwner ? 'facility' : m  // 非ownerは全社に入れない
    setModeState(next)
    writeCookie(MODE_COOKIE, next)
  }

  const currentFacility = facilities.find((f) => f.facility === current) ?? null

  return (
    <FacilityContext.Provider value={{
      facilities, current, setCurrent: handleSetCurrent, currentFacility, isAdmin, isOwner,
      mode, setMode: handleSetMode, canCompany: isOwner,
    }}>
      {children}
    </FacilityContext.Provider>
  )
}

export function useFacility() {
  return useContext(FacilityContext)
}
