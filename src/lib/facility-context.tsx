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
}

const FacilityContext = createContext<FacilityContextType>({
  facilities: [],
  current: '',
  setCurrent: () => {},
  currentFacility: null,
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

  useEffect(() => {
    supabase
      .from('dim_facility')
      .select('facility, name, short_name, total_rooms')
      .order('facility')
      .then(({ data }) => {
        if (data && data.length > 0) {
          setFacilities(data)
          const saved = readFacilityCookie()
          const valid = data.find((f) => f.facility === saved)
          setCurrent(valid ? saved! : data[0].facility)
        }
      })
  }, [])

  const handleSetCurrent = (code: string) => {
    setCurrent(code)
    writeFacilityCookie(code)
  }

  const currentFacility = facilities.find((f) => f.facility === current) ?? null

  return (
    <FacilityContext.Provider
      value={{ facilities, current, setCurrent: handleSetCurrent, currentFacility }}
    >
      {children}
    </FacilityContext.Provider>
  )
}

export function useFacility() {
  return useContext(FacilityContext)
}
