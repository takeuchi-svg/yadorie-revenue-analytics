'use client'
// 施設スコープのデータ取得フック。
//   - 施設が未確定なら取得しない（loadingのまま）
//   - 施設を素早く切り替えても、最新のリクエスト結果だけを反映（レース対策・世代トークン）
//   - 例外は error に集約（呼び出し側で LoadError 表示。データ未登録=空とは区別）
//   - reload() で再取得
import { useCallback, useEffect, useRef, useState } from 'react'
import { useFacility } from '@/lib/facility-context'

export function useFacilityData<T>(
  fetcher: (facility: string) => Promise<T>,
  deps: React.DependencyList = [],
): { data: T | null; loading: boolean; error: string; reload: () => void } {
  const { current } = useFacility()
  const [data, setData] = useState<T | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [tick, setTick] = useState(0)
  const genRef = useRef(0)
  const fetcherRef = useRef(fetcher)
  fetcherRef.current = fetcher

  useEffect(() => {
    if (!current) return // 施設未確定→loadingのまま（ページ側はLoading表示）
    const gen = ++genRef.current
    setLoading(true); setError('')
    fetcherRef.current(current)
      .then((d) => { if (gen === genRef.current) setData(d) })
      .catch((e) => { if (gen === genRef.current) setError(e instanceof Error ? e.message : String(e)) })
      .finally(() => { if (gen === genRef.current) setLoading(false) })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current, tick, ...deps])

  const reload = useCallback(() => setTick((t) => t + 1), [])
  return { data, loading, error, reload }
}
