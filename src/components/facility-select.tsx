'use client'
// 検索付き施設セレクタ。70施設規模でも素のselectのように長大にならず、
// 名称/短縮名/コードでインクリメンタル絞り込みできる。
import { useEffect, useMemo, useRef, useState } from 'react'

export interface FacilityOption { facility: string; name: string; short_name?: string | null }

export function FacilitySelect({
  options, value, onChange, placeholder = '施設を選択', className = '',
}: {
  options: FacilityOption[]
  value: string
  onChange: (facility: string) => void
  placeholder?: string
  className?: string
}) {
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const boxRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const current = options.find((o) => o.facility === value)
  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase()
    if (!s) return options
    return options.filter((o) =>
      o.name.toLowerCase().includes(s) ||
      (o.short_name ?? '').toLowerCase().includes(s) ||
      o.facility.toLowerCase().includes(s))
  }, [options, q])

  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent) => { if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', onDoc)
    setTimeout(() => inputRef.current?.focus(), 0)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open])

  const pick = (f: string) => { onChange(f); setOpen(false); setQ('') }

  return (
    <div ref={boxRef} className={`relative ${className}`}>
      <button type="button" onClick={() => setOpen((v) => !v)}
        className="field w-full px-2 py-1.5 text-sm text-left flex items-center justify-between gap-1"
        style={{ color: current ? 'var(--text)' : 'var(--text-dim)' }}>
        <span className="truncate">{current ? (current.name) : placeholder}</span>
        <span style={{ color: 'var(--text-dim)' }}>▾</span>
      </button>
      {open && (
        <div className="absolute z-50 mt-1 w-full rounded-md shadow-lg overflow-hidden"
          style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}>
          <input ref={inputRef} value={q} onChange={(e) => setQ(e.target.value)}
            placeholder="検索（名称/コード）" className="w-full px-3 py-2 text-sm"
            style={{ background: 'var(--surface2)', borderBottom: '1px solid var(--border)', color: 'var(--text)', outline: 'none' }}
            onKeyDown={(e) => { if (e.key === 'Enter' && filtered.length) pick(filtered[0].facility); if (e.key === 'Escape') setOpen(false) }} />
          <div className="overflow-y-auto" style={{ maxHeight: 280 }}>
            {filtered.length === 0 && <div className="px-3 py-3 text-xs" style={{ color: 'var(--text-dim)' }}>該当なし</div>}
            {filtered.map((o) => (
              <button key={o.facility} type="button" onClick={() => pick(o.facility)}
                className="w-full text-left px-3 py-1.5 text-sm flex items-center justify-between gap-2 hover:opacity-90"
                style={{ background: o.facility === value ? 'var(--accent)' : 'transparent', color: o.facility === value ? '#fff' : 'var(--text)' }}>
                <span className="truncate">{o.name}</span>
                <span className="text-[10px] shrink-0" style={{ color: o.facility === value ? '#fff' : 'var(--text-dim)' }}>{o.short_name || o.facility}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
