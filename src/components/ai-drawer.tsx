'use client'

import { useEffect, useRef, useState } from 'react'
import { useFacility } from '@/lib/facility-context'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { BarChart, Bar, LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts'
import { CHART_AXIS, chartTooltip } from '@/lib/ui'

const SERIES_COLORS = ['#c75b39', '#2e9e6b', '#d98a2b', '#378ADD', '#9168E0', '#84cc16']

/* eslint-disable @typescript-eslint/no-explicit-any */
function MiniChart({ spec }: { spec: any }) {
  const series: { key: string; label?: string }[] = spec.series || []
  const data = spec.data || []
  const fmtY = (v: number) => (Math.abs(v) >= 1e6 ? `${Math.round(v / 1e5) / 10}M` : Math.abs(v) >= 1000 ? `${Math.round(v / 1000)}k` : `${v}`)
  return (
    <div className="my-2 rounded-md p-2" style={{ background: 'var(--surface2)' }}>
      {spec.title && <div className="text-[11px] mb-1" style={{ color: 'var(--text-dim)' }}>{spec.title}</div>}
      <ResponsiveContainer width="100%" height={180}>
        {spec.type === 'line' ? (
          <LineChart data={data}>
            <XAxis dataKey={spec.x} {...CHART_AXIS} tick={{ fill: '#927e6a', fontSize: 9 }} />
            <YAxis {...CHART_AXIS} tick={{ fill: '#927e6a', fontSize: 9 }} tickFormatter={fmtY} width={36} />
            <Tooltip {...chartTooltip} />
            {series.map((s, i) => <Line key={s.key} dataKey={s.key} name={s.label || s.key} stroke={SERIES_COLORS[i % SERIES_COLORS.length]} strokeWidth={2} dot={false} />)}
          </LineChart>
        ) : (
          <BarChart data={data}>
            <XAxis dataKey={spec.x} {...CHART_AXIS} tick={{ fill: '#927e6a', fontSize: 9 }} />
            <YAxis {...CHART_AXIS} tick={{ fill: '#927e6a', fontSize: 9 }} tickFormatter={fmtY} width={36} />
            <Tooltip {...chartTooltip} />
            {series.map((s, i) => <Bar key={s.key} dataKey={s.key} name={s.label || s.key} fill={SERIES_COLORS[i % SERIES_COLORS.length]} radius={[3, 3, 0, 0]} />)}
          </BarChart>
        )}
      </ResponsiveContainer>
    </div>
  )
}

export function AssistantContent({ content }: { content: string }) {
  const parts: { t: 'md' | 'chart'; v: any }[] = []
  const re = /```chart\s*([\s\S]*?)```/g
  let last = 0, m: RegExpExecArray | null
  while ((m = re.exec(content))) {
    if (m.index > last) parts.push({ t: 'md', v: content.slice(last, m.index) })
    try { parts.push({ t: 'chart', v: JSON.parse(m[1]) }) } catch { parts.push({ t: 'md', v: m[1] }) }
    last = re.lastIndex
  }
  if (last < content.length) parts.push({ t: 'md', v: content.slice(last) })
  return (
    <div className="aimd text-sm">
      {parts.map((p, i) => p.t === 'chart'
        ? <MiniChart key={i} spec={p.v} />
        : <ReactMarkdown key={i} remarkPlugins={[remarkGfm]}>{p.v}</ReactMarkdown>)}
    </div>
  )
}

interface Msg { role: 'user' | 'assistant'; content: string }

const SUGGESTIONS = [
  '今月の売上と稼働率は？',
  '直近3ヶ月のADRの推移を教えて',
  '料飲の売れ筋トップ5は？',
  '2025年度の営業損益の予実は？',
]

export default function AiDrawer({ onClose }: { onClose: () => void }) {
  const { current, currentFacility } = useFacility()
  const [messages, setMessages] = useState<Msg[]>([])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => { scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight }) }, [messages, loading])

  const send = async (text: string) => {
    const q = text.trim()
    if (!q || loading) return
    const next = [...messages, { role: 'user' as const, content: q }]
    setMessages(next)
    setInput('')
    setLoading(true)
    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: next, facility: current }),
      })
      const data = await res.json()
      setMessages((m) => [...m, { role: 'assistant', content: data.reply ?? 'エラー' }])
    } catch {
      setMessages((m) => [...m, { role: 'assistant', content: '通信エラーが発生しました' }])
    } finally {
      setLoading(false)
    }
  }

  return (
    <aside className="flex flex-col h-screen shrink-0" style={{ width: 380, background: 'var(--surface)', borderLeft: '1px solid var(--border)' }}>
      {/* header */}
      <div className="flex items-center justify-between px-4 py-3" style={{ borderBottom: '1px solid var(--border)' }}>
        <div className="flex items-center gap-2">
          <SparkleIcon />
          <div>
            <div className="text-sm font-bold">AIアシスタント</div>
            <div className="text-[10px]" style={{ color: 'var(--text-dim)' }}>{currentFacility?.name ?? current} のデータを参照</div>
          </div>
        </div>
        <button onClick={onClose} className="text-lg leading-none px-2 hover:opacity-70" style={{ color: 'var(--text-dim)' }}>✕</button>
      </div>

      {/* messages */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-4 space-y-3">
        {messages.length === 0 && (
          <div>
            <p className="text-sm mb-3" style={{ color: 'var(--text-dim)' }}>
              データベースを参照して質問に答えます。例えば:
            </p>
            <div className="space-y-2">
              {SUGGESTIONS.map((s) => (
                <button key={s} onClick={() => send(s)} className="w-full text-left text-sm px-3 py-2 rounded-md"
                  style={{ background: 'var(--surface2)', border: '1px solid var(--border)', color: 'var(--text)' }}>
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}
        {messages.map((m, i) => (
          <div key={i} className={m.role === 'user' ? 'flex justify-end' : 'flex justify-start'}>
            <div className="max-w-[90%] px-3 py-2 rounded-lg text-sm"
              style={{ background: m.role === 'user' ? 'var(--accent)' : 'var(--surface2)', color: m.role === 'user' ? '#fff' : 'var(--text)' }}>
              {m.role === 'user' ? <span className="whitespace-pre-wrap">{m.content}</span> : <AssistantContent content={m.content} />}
            </div>
          </div>
        ))}
        {loading && (
          <div className="flex justify-start">
            <div className="px-3 py-2 rounded-lg text-sm" style={{ background: 'var(--surface2)', color: 'var(--text-dim)' }}>
              <span className="inline-block w-2 h-2 rounded-full animate-pulse" style={{ background: 'var(--accent)' }} /> 考え中...
            </div>
          </div>
        )}
      </div>

      {/* input */}
      <div className="p-3" style={{ borderTop: '1px solid var(--border)' }}>
        <div className="flex gap-2">
          <input
            className="field flex-1 px-3 py-2 text-sm"
            placeholder="売上や稼働率などを質問..."
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') send(input) }}
            disabled={loading}
          />
          <button onClick={() => send(input)} disabled={loading || !input.trim()}
            className="px-3 py-2 rounded-md text-sm text-white disabled:opacity-50" style={{ background: 'var(--accent)' }}>
            送信
          </button>
        </div>
        <p className="text-[10px] mt-1.5" style={{ color: 'var(--text-dim)' }}>AIの回答は誤りを含む場合があります。重要な判断は元データをご確認ください。</p>
      </div>
    </aside>
  )
}

export function SparkleIcon({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <path d="M12 2c.4 4.5 3 7.1 7.5 7.5C15 9.9 12.4 12.5 12 17c-.4-4.5-3-7.1-7.5-7.5C9 9.1 11.6 6.5 12 2Z"
        fill="url(#g)" />
      <path d="M19 14c.2 2.2 1.5 3.5 3.7 3.7-2.2.2-3.5 1.5-3.7 3.7-.2-2.2-1.5-3.5-3.7-3.7 2.2-.2 3.5-1.5 3.7-3.7Z" fill="url(#g)" />
      <defs>
        <linearGradient id="g" x1="0" y1="0" x2="24" y2="24">
          <stop stopColor="#4F8DFD" /><stop offset="0.5" stopColor="#9168E0" /><stop offset="1" stopColor="#E0608A" />
        </linearGradient>
      </defs>
    </svg>
  )
}
