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
          const saved = localStorage.getItem('currentFacility')
          const valid = data.find((f) => f.facility === saved)
          setCurrent(valid ? saved! : data[0].facility)
        }
      })
  }, [])

  const handleSetCurrent = (code: string) => {
    setCurrent(code)
    localStorage.setItem('currentFacility', code)
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
