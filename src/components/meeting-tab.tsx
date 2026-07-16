'use client'

// 月次会議タブ（プロフィール内）: ①会議パック(灯生成・手動+キャッシュ) ②会議記録(7カテゴリ×4軸グリッド) ③構造化抽出(承認登録)
import { useCallback, useEffect, useState } from 'react'
import { useFacility } from '@/lib/facility-context'
import { supabase } from '@/lib/supabase/client'
import { fetchAll } from '@/lib/supabase/fetch-all'
import { useToast } from '@/components/toast'
import { AssistantContent } from '@/components/ai-drawer'
import { loadMeetingReport, generateMeetingReport } from '@/lib/meeting-report'

interface MeetingProposal {
  type: 'issue' | 'initiative' | 'policy'
  title?: string; description?: string; category?: string; field?: string; suggestion?: string
}
// 会議記録グリッド: 7カテゴリ × 4軸（スプレッドシート⑨施設会議と同構成）
const CATEGORIES = [
  { key: 'branding', label: 'ブランディング' },
  { key: 'satisfaction', label: '顧客満足度' },
  { key: 'hr_ops', label: '人材・オペレーション' },
  { key: 'sales_promo', label: '売上・販促' },
  { key: 'cost', label: '経費' },
  { key: 'capex', label: '修繕・投資' },
  { key: 'other', label: 'その他・長期課題' },
] as const
const AXES = [
  { key: 'review', label: '振り返り' },
  { key: 'forecast', label: '見込み' },
  { key: 'agenda', label: '議題/提案' },
  { key: 'memo', label: '議事メモ' },
] as const
type Grid = Record<string, Record<string, string>>
const emptyGrid = (): Grid => Object.fromEntries(CATEGORIES.map((c) => [c.key, {}]))

const FIELD_LABEL: Record<string, string> = {
  management_policy: '支配人の運営方針', core_value: '中核価値', ng_items: '避けたいこと・NG', seasonal_policy: '季節ごとの方針',
}

async function authedPost(url: string, body: unknown) {
  const { data: { session } } = await supabase.auth.getSession()
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(session ? { Authorization: `Bearer ${session.access_token}` } : {}) },
    body: JSON.stringify(body),
  })
  return res.json()
}

export default function MeetingTab() {
  const { current, currentFacility } = useFacility()
  const toast = useToast()
  const [months, setMonths] = useState<string[]>([])
  const [month, setMonth] = useState('')
  // 会議パック
  const [pack, setPack] = useState('')
  const [packBusy, setPackBusy] = useState(false)
  const [packErr, setPackErr] = useState('')
  // 会議記録
  const [meetingDate, setMeetingDate] = useState('')
  const [attendees, setAttendees] = useState('')
  const [grid, setGrid] = useState<Grid>(emptyGrid())
  const [saving, setSaving] = useState(false)
  // 構造化抽出
  const [proposals, setProposals] = useState<MeetingProposal[] | null>(null)
  const [extracting, setExtracting] = useState(false)
  const [doneIdx, setDoneIdx] = useState<Set<number>>(new Set())

  // 対象月リスト（実績のある月）
  useEffect(() => {
    if (!current) return
    ;(async () => {
      const rows = await fetchAll(() => supabase.from('mart_monthly_kpi').select('month').eq('facility', current))
      const ms = [...new Set(((rows as { month: string }[]) ?? []).map((r) => r.month))].sort().reverse()
      setMonths(ms)
      setMonth((m) => (m && ms.includes(m) ? m : ms[0] ?? ''))
    })()
  }, [current])

  // 記録＋パックキャッシュの読込
  useEffect(() => {
    if (!current || !month) return
    setProposals(null); setDoneIdx(new Set()); setPackErr('')
    ;(async () => {
      const { data } = await supabase.from('raw_meeting_record')
        .select('meeting_date, attendees, grid')
        .eq('facility', current).eq('year_month', month).maybeSingle()
      setMeetingDate(data?.meeting_date ?? '')
      setAttendees(data?.attendees ?? '')
      const g = emptyGrid()
      const src = (data?.grid ?? {}) as Grid
      for (const c of CATEGORIES) g[c.key] = { ...(src[c.key] ?? {}) }
      setGrid(g)
      setPack(await loadMeetingReport(current, month))
    })()
  }, [current, month])

  const generatePack = useCallback(async () => {
    if (!current || !month) return
    setPackBusy(true); setPackErr('')
    try {
      const { content, error } = await generateMeetingReport(current, month)
      if (error) setPackErr(error)
      setPack(content)
    } catch (e) { setPackErr(e instanceof Error ? e.message : String(e)) }
    finally { setPackBusy(false) }
  }, [current, month])

  const setCell = (cat: string, axis: string, v: string) =>
    setGrid((p) => ({ ...p, [cat]: { ...(p[cat] ?? {}), [axis]: v } }))

  const saveRecord = async () => {
    if (!current || !month) return
    setSaving(true)
    const { data: { user } } = await supabase.auth.getUser()
    const { error } = await supabase.from('raw_meeting_record').upsert({
      facility: current, year_month: month,
      meeting_date: meetingDate || null, attendees: attendees || null, grid,
      updated_at: new Date().toISOString(), created_by: user?.email ?? null,
    }, { onConflict: 'facility,year_month' })
    toast(error ? `エラー: ${error.message}` : '会議記録を保存しました', error ? 'error' : 'success')
    setSaving(false)
  }

  // グリッド全文を「カテゴリ/軸」ラベル付きテキスト化（抽出の入力）
  const gridToText = (): string =>
    CATEGORIES.map((c) => {
      const cell = grid[c.key] ?? {}
      const parts = AXES.map((a) => (cell[a.key] ?? '').trim() ? `[${a.label}] ${cell[a.key].trim()}` : '').filter(Boolean)
      return parts.length ? `■ ${c.label}\n${parts.join('\n')}` : ''
    }).filter(Boolean).join('\n\n')

  const extract = async () => {
    if (!current || !month) return
    const text = gridToText()
    if (!text.trim()) { toast('会議記録が空です。先に記録を書いてください。', 'error'); return }
    setExtracting(true); setProposals(null); setDoneIdx(new Set())
    const r = await authedPost('/api/meeting-extract', { facility: current, month, text })
    if (r?.error) toast(`エラー: ${r.error}`, 'error')
    setProposals(r?.proposals ?? [])
    setExtracting(false)
  }

  const approve = async (p: MeetingProposal, idx: number) => {
    const { data: { user } } = await supabase.auth.getUser()
    let error = null
    if (p.type === 'initiative') {
      const res = await supabase.from('raw_facility_initiative').insert({
        facility: current, year_month: month, category: p.category || 'その他',
        title: (p.title || '施策').slice(0, 200), description: p.description || null, status: '計画', created_by: user?.email ?? null,
      })
      error = res.error
    } else if (p.type === 'issue') {
      const { data: prof } = await supabase.from('dim_facility_profile').select('issue_awareness').eq('facility', current).maybeSingle()
      const add = [p.title, p.description].filter(Boolean).join(': ')
      const next = [prof?.issue_awareness, `- ${add}`].filter(Boolean).join('\n')
      const res = await supabase.from('dim_facility_profile').upsert({ facility: current, issue_awareness: next }, { onConflict: 'facility' })
      error = res.error
    } else if (p.type === 'policy' && p.field) {
      const res = await supabase.from('dim_facility_profile').upsert({ facility: current, [p.field]: p.suggestion ?? '' }, { onConflict: 'facility' })
      error = res.error
    }
    if (error) { toast(`エラー: ${error.message}`, 'error'); return }
    setDoneIdx((s) => new Set(s).add(idx))
    toast('登録しました', 'success')
  }

  if (!current) return <div className="card p-6 mt-4 text-sm" style={{ color: 'var(--text-dim)' }}>宿を選択してください。</div>

  return (
    <div className="mt-4 space-y-4">
      {/* 月セレクタ */}
      <div className="flex items-center gap-2">
        <span className="text-xs" style={{ color: 'var(--text-dim)' }}>対象月</span>
        {months.length > 0 ? (
          <select className="field px-3 py-1.5 text-sm" value={month} onChange={(e) => setMonth(e.target.value)}>
            {months.map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
        ) : <span className="text-xs" style={{ color: 'var(--text-dim)' }}>実績データがありません</span>}
      </div>

      {/* ① 会議パック */}
      <section className="card p-5">
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-sm font-semibold">月次レポート（灯が編む・概要と同一）</h3>
          <button onClick={generatePack} disabled={packBusy || !month}
            className="px-3 py-1.5 rounded-md text-sm text-white disabled:opacity-50" style={{ background: 'var(--accent)' }}>
            {packBusy ? '生成中…' : pack ? '再生成' : '生成'}
          </button>
        </div>
        {packErr && <p className="text-sm mb-2" style={{ color: 'var(--red)' }}>エラー: {packErr}</p>}
        {packBusy ? (
          <p className="text-sm" style={{ color: 'var(--text-dim)' }}>{currentFacility?.name ?? current} の {month} を読み込んで会議資料を編んでいます…</p>
        ) : pack ? (
          <div className="text-sm"><AssistantContent content={pack} /></div>
        ) : (
          <p className="text-sm" style={{ color: 'var(--text-dim)' }}>「生成」で、灯が当月の実績・クチコミ・生産性・先月の取組の効果・課題と次の一手を一枚にまとめます（概要と同じ内容）。</p>
        )}
      </section>

      {/* ② 会議記録（7カテゴリ × 4軸グリッド） */}
      <section className="card p-5">
        <div className="flex items-center justify-between mb-2 flex-wrap gap-2">
          <h3 className="text-sm font-semibold">会議記録</h3>
          <button onClick={saveRecord} disabled={saving || !month}
            className="px-3 py-1.5 rounded-md text-sm text-white disabled:opacity-50" style={{ background: 'var(--accent)' }}>保存</button>
        </div>
        <div className="grid grid-cols-2 gap-2 mb-3 max-w-md">
          <div>
            <label className="block text-[10px] mb-0.5" style={{ color: 'var(--text-dim)' }}>開催日</label>
            <input type="date" className="field px-3 py-1.5 text-sm w-full" value={meetingDate} onChange={(e) => setMeetingDate(e.target.value)} />
          </div>
          <div>
            <label className="block text-[10px] mb-0.5" style={{ color: 'var(--text-dim)' }}>参加者</label>
            <input type="text" className="field px-3 py-1.5 text-sm w-full" value={attendees} onChange={(e) => setAttendees(e.target.value)} placeholder="支配人・総支配人・本社…" />
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="border-separate" style={{ borderSpacing: 0, minWidth: 860 }}>
            <thead>
              <tr>
                <th className="sticky left-0 z-10 px-2 py-1.5 text-left text-[11px] font-medium" style={{ background: 'var(--surface2)', color: 'var(--text-dim)', minWidth: 120, borderBottom: '1px solid var(--border)' }}>カテゴリ</th>
                {AXES.map((a) => (
                  <th key={a.key} className="px-2 py-1.5 text-left text-[11px] font-medium" style={{ background: 'var(--surface2)', color: 'var(--text-dim)', minWidth: 180, borderBottom: '1px solid var(--border)' }}>{a.label}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {CATEGORIES.map((c) => (
                <tr key={c.key}>
                  <td className="sticky left-0 z-10 px-2 py-1.5 text-xs font-medium align-top" style={{ background: 'var(--surface)', borderBottom: '1px solid var(--border)', borderRight: '1px solid var(--border)' }}>{c.label}</td>
                  {AXES.map((a) => (
                    <td key={a.key} className="px-1 py-1 align-top" style={{ borderBottom: '1px solid var(--border)' }}>
                      <textarea className="field w-full text-xs px-2 py-1.5" rows={3} style={{ minWidth: 176 }}
                        value={grid[c.key]?.[a.key] ?? ''} onChange={(e) => setCell(c.key, a.key, e.target.value)} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="text-[10px] mt-1.5" style={{ color: 'var(--text-dim)' }}>自由記述で構いません。構造化は下の「記録から抽出」で灯が行います。</p>
      </section>

      {/* ③ 構造化抽出（承認登録） */}
      <section className="card p-5">
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-sm font-semibold">記録から抽出（灯の提案 → 承認で登録）</h3>
          <button onClick={extract} disabled={extracting || !month}
            className="px-3 py-1.5 rounded-md text-sm disabled:opacity-50" style={{ background: 'var(--surface2)', color: 'var(--text)' }}>
            {extracting ? '抽出中…' : '記録から抽出'}
          </button>
        </div>
        <p className="text-[11px] mb-2" style={{ color: 'var(--text-dim)' }}>会議記録を灯が読み、課題・施策・方針変化を仕分けます。登録先を確認して「登録」を押すと反映されます（自動登録はしません）。</p>
        {proposals == null ? null : proposals.length === 0 ? (
          <p className="text-sm" style={{ color: 'var(--text-dim)' }}>登録を提案できる内容は見つかりませんでした。</p>
        ) : (
          <div className="space-y-2">
            {proposals.map((p, i) => {
              const dest = p.type === 'initiative' ? `取組履歴に登録（${p.category || 'その他'}）`
                : p.type === 'issue' ? '宿プロフィールの課題認識に追記'
                : `宿プロフィール「${FIELD_LABEL[p.field ?? ''] ?? p.field}」を更新`
              const body = p.type === 'policy' ? p.suggestion : [p.title, p.description].filter(Boolean).join('：')
              return (
                <div key={i} className="p-3 rounded flex items-start justify-between gap-3" style={{ background: 'var(--surface2)' }}>
                  <div className="min-w-0">
                    <div className="text-[10px]" style={{ color: 'var(--accent)' }}>{dest}</div>
                    <div className="text-sm">{body}</div>
                  </div>
                  {doneIdx.has(i)
                    ? <span className="text-xs shrink-0" style={{ color: 'var(--green)' }}>✓ 登録済</span>
                    : <button onClick={() => approve(p, i)} className="text-xs px-3 py-1 rounded-md text-white shrink-0" style={{ background: 'var(--accent)' }}>登録</button>}
                </div>
              )
            })}
          </div>
        )}
      </section>
    </div>
  )
}
