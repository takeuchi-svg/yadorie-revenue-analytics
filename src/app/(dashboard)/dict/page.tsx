'use client'

// 辞書（全ユーザー閲覧可）。公開中のKPI辞書・用語集を読みやすく表示（編集はオーナーの「灯の頭の中」で）。
import { useCallback, useEffect, useMemo, useState } from 'react'
import { supabase } from '@/lib/supabase/client'

/* eslint-disable @typescript-eslint/no-explicit-any */
interface Kpi { kpi_key: string; label_ja: string; formula?: string; numerator?: string; denominator?: string; unit?: string; direction?: string; note?: string }
interface Gloss { term: string; definition_ja: string; note?: string }
const DIR: Record<string, string> = { higher_better: '高いほど良い', lower_better: '低いほど良い', neutral: '中立' }

export default function DictPage() {
  const [kpi, setKpi] = useState<Kpi[]>([])
  const [glossary, setGlossary] = useState<Gloss[]>([])
  const [tab, setTab] = useState<'kpi' | 'glossary'>('kpi')
  const [q, setQ] = useState('')
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    const { data: { session } } = await supabase.auth.getSession()
    const res = await fetch('/api/dictionary', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(session ? { Authorization: `Bearer ${session.access_token}` } : {}) },
      body: JSON.stringify({}),
    })
    const d = await res.json()
    setKpi(d.kpi ?? []); setGlossary(d.glossary ?? []); setLoading(false)
  }, [])
  useEffect(() => { load() }, [load])

  const kpiShown = useMemo(() => {
    const s = q.trim().toLowerCase()
    if (!s) return kpi
    return kpi.filter((k) => (k.label_ja + k.kpi_key + (k.note ?? '') + (k.formula ?? '')).toLowerCase().includes(s))
  }, [kpi, q])
  const glossShown = useMemo(() => {
    const s = q.trim().toLowerCase()
    if (!s) return glossary
    return glossary.filter((g) => (g.term + g.definition_ja + (g.note ?? '')).toLowerCase().includes(s))
  }, [glossary, q])

  const calc = (k: Kpi) => (k.formula?.trim() ? k.formula : (k.numerator && k.denominator ? `${k.numerator} ÷ ${k.denominator}` : (k.numerator ?? '')))

  return (
    <div className="p-6">
      <div className="mb-4">
        <h1 className="text-2xl font-bold mb-1">辞書</h1>
        <p className="text-sm" style={{ color: 'var(--text-dim)' }}>KPI・指標の定義と社内用語。灯（AI）もこの定義に沿って回答します。</p>
      </div>

      <div className="flex items-center gap-2 mb-4 flex-wrap">
        <div className="flex gap-1">
          <button onClick={() => setTab('kpi')} className="px-4 py-1.5 rounded-md text-sm" style={{ background: tab === 'kpi' ? 'var(--accent)' : 'var(--surface2)', color: tab === 'kpi' ? '#fff' : 'var(--text-dim)' }}>KPI辞書（{kpi.length}）</button>
          <button onClick={() => setTab('glossary')} className="px-4 py-1.5 rounded-md text-sm" style={{ background: tab === 'glossary' ? 'var(--accent)' : 'var(--surface2)', color: tab === 'glossary' ? '#fff' : 'var(--text-dim)' }}>用語集（{glossary.length}）</button>
        </div>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="キーワードで絞り込み" className="field px-3 py-1.5 text-sm ml-auto" style={{ minWidth: 220 }} />
      </div>

      {loading ? (
        <p className="text-sm" style={{ color: 'var(--text-dim)' }}>読み込み中...</p>
      ) : tab === 'kpi' ? (
        kpiShown.length === 0 ? <p className="text-sm" style={{ color: 'var(--text-dim)' }}>公開中のKPIがありません。</p> : (
          <div className="card overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr style={{ color: 'var(--text-dim)' }}>
                  <th className="text-left font-medium px-3 py-2">指標</th>
                  <th className="text-left font-medium px-3 py-2">計算方法</th>
                  <th className="text-left font-medium px-3 py-2">単位</th>
                  <th className="text-left font-medium px-3 py-2">方向</th>
                  <th className="text-left font-medium px-3 py-2">注記</th>
                </tr>
              </thead>
              <tbody>
                {kpiShown.map((k) => (
                  <tr key={k.kpi_key} style={{ borderTop: '1px solid var(--border)' }}>
                    <td className="px-3 py-2 align-top"><span className="font-medium">{k.label_ja}</span><div className="text-[10px]" style={{ color: 'var(--text-dim)' }}>{k.kpi_key}</div></td>
                    <td className="px-3 py-2 align-top">{calc(k)}</td>
                    <td className="px-3 py-2 align-top whitespace-nowrap">{k.unit ?? '-'}</td>
                    <td className="px-3 py-2 align-top whitespace-nowrap" style={{ color: k.direction === 'higher_better' ? 'var(--green)' : k.direction === 'lower_better' ? 'var(--red)' : 'var(--text-dim)' }}>{DIR[k.direction ?? ''] ?? '-'}</td>
                    <td className="px-3 py-2 align-top" style={{ color: 'var(--text-dim)' }}>{k.note || ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      ) : (
        glossShown.length === 0 ? <p className="text-sm" style={{ color: 'var(--text-dim)' }}>公開中の用語がありません。</p> : (
          <div className="space-y-2">
            {glossShown.map((g) => (
              <div key={g.term} className="card p-3">
                <div className="font-medium text-sm">{g.term}</div>
                <div className="text-sm mt-0.5">{g.definition_ja}</div>
                {g.note && <div className="text-xs mt-1" style={{ color: 'var(--text-dim)' }}>{g.note}</div>}
              </div>
            ))}
          </div>
        )
      )}
    </div>
  )
}
