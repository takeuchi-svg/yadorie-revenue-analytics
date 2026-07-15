'use client'

// 月次会議タブ（プロフィール内）: ①会議パック(灯生成・手動+キャッシュ) ②会議記録(自由記述) ③構造化抽出(承認登録)
import { useCallback, useEffect, useState } from 'react'
import { useFacility } from '@/lib/facility-context'
import { supabase } from '@/lib/supabase/client'
import { fetchAll } from '@/lib/supabase/fetch-all'
import { useToast } from '@/components/toast'
import { AssistantContent } from '@/components/ai-drawer'
import { buildMeetingMaterial } from '@/lib/meeting-data'

interface MeetingProposal {
  type: 'issue' | 'initiative' | 'policy'
  title?: string; description?: string; category?: string; field?: string; suggestion?: string
}
interface Rec { meeting_date: string; attendees: string; review_note: string; discussion_note: string; decision_note: string; task_note: string }
const EMPTY_REC: Rec = { meeting_date: '', attendees: '', review_note: '', discussion_note: '', decision_note: '', task_note: '' }
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
  const [rec, setRec] = useState<Rec>(EMPTY_REC)
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
        .select('meeting_date, attendees, review_note, discussion_note, decision_note, task_note')
        .eq('facility', current).eq('year_month', month).maybeSingle()
      setRec(data ? {
        meeting_date: data.meeting_date ?? '', attendees: data.attendees ?? '', review_note: data.review_note ?? '',
        discussion_note: data.discussion_note ?? '', decision_note: data.decision_note ?? '', task_note: data.task_note ?? '',
      } : EMPTY_REC)
      const r = await authedPost('/api/meeting-pack', { facility: current, month })  // material無し=キャッシュ読込のみ
      setPack(r?.content ?? '')
    })()
  }, [current, month])

  const generatePack = useCallback(async () => {
    if (!current || !month) return
    setPackBusy(true); setPackErr('')
    try {
      const material = await buildMeetingMaterial(supabase, current, month)
      const r = await authedPost('/api/meeting-pack', { facility: current, month, material, force: true })
      if (r?.error) setPackErr(r.error)
      setPack(r?.content ?? '')
    } catch (e) { setPackErr(e instanceof Error ? e.message : String(e)) }
    finally { setPackBusy(false) }
  }, [current, month])

  const set = (k: keyof Rec, v: string) => setRec((p) => ({ ...p, [k]: v }))

  const saveRecord = async () => {
    if (!current || !month) return
    setSaving(true)
    const { data: { user } } = await supabase.auth.getUser()
    const { error } = await supabase.from('raw_meeting_record').upsert({
      facility: current, year_month: month,
      meeting_date: rec.meeting_date || null, attendees: rec.attendees || null,
      review_note: rec.review_note || null, discussion_note: rec.discussion_note || null,
      decision_note: rec.decision_note || null, task_note: rec.task_note || null,
      updated_at: new Date().toISOString(), created_by: user?.email ?? null,
    }, { onConflict: 'facility,year_month' })
    toast(error ? `エラー: ${error.message}` : '会議記録を保存しました', error ? 'error' : 'success')
    setSaving(false)
  }

  const extract = async () => {
    if (!current || !month) return
    const text = [rec.review_note, rec.discussion_note, rec.decision_note, rec.task_note].filter(Boolean).join('\n\n')
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

  const ta = 'field w-full text-sm px-3 py-2'
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
          <h3 className="text-sm font-semibold">会議パック（灯が編む会議資料）</h3>
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
          <p className="text-sm" style={{ color: 'var(--text-dim)' }}>「生成」で、灯が当月の実績・クチコミ・生産性・先月の取組の効果検証・今月の論点をまとめます。</p>
        )}
      </section>

      {/* ② 会議記録（自由記述） */}
      <section className="card p-5">
        <div className="flex items-center justify-between mb-2 flex-wrap gap-2">
          <h3 className="text-sm font-semibold">会議記録（自由記述）</h3>
          <button onClick={saveRecord} disabled={saving || !month}
            className="px-3 py-1.5 rounded-md text-sm text-white disabled:opacity-50" style={{ background: 'var(--accent)' }}>保存</button>
        </div>
        <div className="grid grid-cols-2 gap-2 mb-2">
          <div>
            <label className="block text-[10px] mb-0.5" style={{ color: 'var(--text-dim)' }}>開催日</label>
            <input type="date" className="field px-3 py-1.5 text-sm w-full" value={rec.meeting_date} onChange={(e) => set('meeting_date', e.target.value)} />
          </div>
          <div>
            <label className="block text-[10px] mb-0.5" style={{ color: 'var(--text-dim)' }}>参加者</label>
            <input type="text" className="field px-3 py-1.5 text-sm w-full" value={rec.attendees} onChange={(e) => set('attendees', e.target.value)} placeholder="支配人・総支配人・本社マーケ…" />
          </div>
        </div>
        {([['review_note', '実績の振り返り'], ['discussion_note', '議論したいこと・議論内容'], ['decision_note', '決定事項'], ['task_note', 'タスク（記録のみ）']] as [keyof Rec, string][]).map(([k, label]) => (
          <div key={k} className="mb-2">
            <label className="block text-[10px] mb-0.5" style={{ color: 'var(--text-dim)' }}>{label}</label>
            <textarea className={ta} rows={k === 'review_note' || k === 'discussion_note' ? 3 : 2} value={rec[k]} onChange={(e) => set(k, e.target.value)} />
          </div>
        ))}
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
