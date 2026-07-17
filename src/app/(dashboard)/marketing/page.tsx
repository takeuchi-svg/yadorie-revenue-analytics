'use client'

// 施策記録（M4）— マーケの打ち手を記録し、実行期間中の日別新規予約（予約日ベース）を並べる。
// 効果の「判定」はしない（事実の推移を見せるまで）。要件定義書_予約日ベース分析_施策記録 §2.3/§3.5。
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { useFacility } from '@/lib/facility-context'
import { supabase } from '@/lib/supabase/client'
import { fetchAll } from '@/lib/supabase/fetch-all'
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, ReferenceArea,
} from 'recharts'
import { fmtNum, fmtYen, CHART_AXIS, chartTooltip, channelColor } from '@/lib/ui'
import { Loading, Empty, LoadError } from '@/components/page-bits'
import { useToast } from '@/components/toast'

interface Action {
  id: number; facility: string; channel: string | null; action_type: string; title: string
  decided_date: string | null; start_date: string; end_date: string | null; cost: number | null
  target_stay_from: string | null; target_stay_to: string | null; memo: string | null; created_by: string | null
}
interface FlowRow { flow_date: string; channel: string; new_reservations: number | null; new_room_nights: number | null; new_revenue: number | null }

const ACTION_TYPES = ['広告', 'クーポン', 'セール参加', 'ランク変更', 'プラン', 'その他'] as const
const ACTION_COLOR: Record<string, string> = {
  広告: '#D85A30', クーポン: '#1D9E75', セール参加: '#378ADD', ランク変更: '#7F77DD', プラン: '#C99A2E', その他: '#888780',
}
const CHANNELS = ['全体', 'じゃらん', '楽天', '一休', 'Booking', '自社', 'その他'] as const

const todayISO = () => {
  const n = new Date()
  return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, '0')}-${String(n.getDate()).padStart(2, '0')}`
}
const addDays = (iso: string, d: number) => {
  const t = new Date(iso + 'T00:00:00Z'); t.setUTCDate(t.getUTCDate() + d)
  return t.toISOString().slice(0, 10)
}
const eachDay = (from: string, to: string): string[] => {
  const out: string[] = []; let c = from
  for (let i = 0; i < 400 && c <= to; i++) { out.push(c); c = addDays(c, 1) }
  return out
}
// 施策のチャネル(全体/じゃらん…)と予約の扱先(生文字列)を緩く突合
const channelMatch = (actionCh: string | null, bookingCh: string): boolean => {
  if (!actionCh || actionCh === '全体') return true
  const a = actionCh.toLowerCase(), b = bookingCh.toLowerCase()
  if (a === '自社') return /自社|直予約|tripla|公式/.test(b)
  if (a === 'その他') return true
  return b.includes(a) || a.includes(b)
}

const emptyForm = () => ({
  action_type: '広告' as string, title: '', channel: '全体' as string,
  decided_date: '', start_date: todayISO(), end_date: '', cost: '',
  target_stay_from: '', target_stay_to: '', memo: '',
})

export default function MarketingPage() {
  const { current } = useFacility()
  const toast = useToast()
  const [actions, setActions] = useState<Action[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [monthFilter, setMonthFilter] = useState('all')
  const [form, setForm] = useState(emptyForm())
  const [saving, setSaving] = useState(false)
  const [openId, setOpenId] = useState<number | null>(null)

  const reload = () => {
    if (!current) return
    setLoading(true); setLoadError('')
    fetchAll<Action>(() => supabase.from('raw_marketing_action').select('*').eq('facility', current)
      .order('start_date', { ascending: false }).order('id', { ascending: false }))
      .then((rows) => setActions(rows ?? []))
      .catch((e: unknown) => setLoadError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false))
  }
  useEffect(reload, [current])

  const months = useMemo(
    () => [...new Set(actions.map((a) => a.start_date?.slice(0, 7)).filter(Boolean))].sort().reverse() as string[],
    [actions])
  const rows = useMemo(
    () => actions.filter((a) => monthFilter === 'all' || a.start_date?.slice(0, 7) === monthFilter),
    [actions, monthFilter])

  const save = async () => {
    if (!form.title.trim()) { toast('施策名を入力してください', 'error'); return }
    if (!form.start_date) { toast('実行開始日を入力してください', 'error'); return }
    setSaving(true)
    const { data: { user } } = await supabase.auth.getUser()
    const { error } = await supabase.from('raw_marketing_action').insert({
      facility: current,
      channel: form.channel === '全体' ? '全体' : form.channel,
      action_type: form.action_type,
      title: form.title.trim(),
      decided_date: form.decided_date || null,
      start_date: form.start_date,
      end_date: form.end_date || form.start_date,
      cost: form.cost === '' ? null : Number(form.cost),
      target_stay_from: form.target_stay_from || null,
      target_stay_to: form.target_stay_to || null,
      memo: form.memo.trim() || null,
      created_by: user?.email ?? null,
    })
    setSaving(false)
    if (error) { toast(`エラー: ${error.message}`, 'error'); return }
    toast('施策を記録しました')
    setForm(emptyForm())
    reload()
  }

  const remove = async (a: Action) => {
    if (!confirm(`「${a.title}」を削除しますか？`)) return
    const { error } = await supabase.from('raw_marketing_action').delete().eq('id', a.id)
    if (error) { toast(`エラー: ${error.message}`, 'error'); return }
    toast('削除しました'); if (openId === a.id) setOpenId(null); reload()
  }

  const set = (k: string, v: string) => setForm((f) => ({ ...f, [k]: v }))

  return (
    <div className="p-6">
      {/* 登録フォーム */}
      <div className="card p-4 mb-5">
        <h2 className="text-sm font-semibold mb-3">施策を記録</h2>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <Field label="種類">
            <select className="field w-full px-2 py-1.5 text-sm" value={form.action_type} onChange={(e) => set('action_type', e.target.value)}>
              {ACTION_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          </Field>
          <Field label="対象チャネル">
            <select className="field w-full px-2 py-1.5 text-sm" value={form.channel} onChange={(e) => set('channel', e.target.value)}>
              {CHANNELS.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </Field>
          <Field label="施策名" wide>
            <input className="field w-full px-2 py-1.5 text-sm" value={form.title} placeholder="例: じゃらんお得な10日間"
              onChange={(e) => set('title', e.target.value)} />
          </Field>
          <Field label="判断日">
            <input type="date" className="field w-full px-2 py-1.5 text-sm" value={form.decided_date} onChange={(e) => set('decided_date', e.target.value)} />
          </Field>
          <Field label="実行開始日 *">
            <input type="date" className="field w-full px-2 py-1.5 text-sm" value={form.start_date} onChange={(e) => set('start_date', e.target.value)} />
          </Field>
          <Field label="実行終了日">
            <input type="date" className="field w-full px-2 py-1.5 text-sm" value={form.end_date} onChange={(e) => set('end_date', e.target.value)} />
          </Field>
          <Field label="費用（円）">
            <input type="number" className="field w-full px-2 py-1.5 text-sm" value={form.cost} placeholder="無料/不明は空欄" onChange={(e) => set('cost', e.target.value)} />
          </Field>
          <Field label="対象宿泊期間（任意）">
            <div className="flex items-center gap-1">
              <input type="date" className="field w-full px-1.5 py-1.5 text-xs" value={form.target_stay_from} onChange={(e) => set('target_stay_from', e.target.value)} />
              <span className="text-xs" style={{ color: 'var(--text-dim)' }}>〜</span>
              <input type="date" className="field w-full px-1.5 py-1.5 text-xs" value={form.target_stay_to} onChange={(e) => set('target_stay_to', e.target.value)} />
            </div>
          </Field>
          <Field label="メモ" full>
            <input className="field w-full px-2 py-1.5 text-sm" value={form.memo} placeholder="狙い・条件など" onChange={(e) => set('memo', e.target.value)} />
          </Field>
        </div>
        <div className="flex justify-end mt-3">
          <button onClick={save} disabled={saving}
            className="px-4 py-1.5 rounded-md text-sm text-white disabled:opacity-50"
            style={{ background: 'var(--accent)' }}>{saving ? '保存中…' : '記録する'}</button>
        </div>
      </div>

      {/* 一覧 */}
      <div className="flex items-center justify-between mb-2">
        <h2 className="text-sm font-semibold">施策一覧</h2>
        <select className="field px-3 py-1.5 text-sm" value={monthFilter} onChange={(e) => setMonthFilter(e.target.value)}>
          <option value="all">全期間</option>
          {months.map((m) => <option key={m} value={m}>{m}</option>)}
        </select>
      </div>

      {loading ? <Loading /> : loadError ? <LoadError message={loadError} /> : rows.length === 0 ? (
        <Empty message="まだ施策が記録されていません。上のフォームから最初の施策を登録してください。" />
      ) : (
        <div className="space-y-2">
          {rows.map((a) => (
            <div key={a.id} className="card overflow-hidden">
              <div className="flex items-center gap-3 px-4 py-3 cursor-pointer" onClick={() => setOpenId(openId === a.id ? null : a.id)}>
                <span className="text-[10px] px-1.5 py-0.5 rounded text-white shrink-0" style={{ background: ACTION_COLOR[a.action_type] ?? '#888780' }}>{a.action_type}</span>
                <span className="inline-flex items-center gap-1 text-[11px] shrink-0" style={{ color: 'var(--text-dim)' }}>
                  <span className="inline-block w-2 h-2 rounded-full" style={{ background: a.channel && a.channel !== '全体' ? channelColor(a.channel) : '#B4B2A9' }} />
                  {a.channel ?? '全体'}
                </span>
                <span className="font-medium text-sm truncate flex-1">{a.title}</span>
                <span className="text-xs shrink-0" style={{ color: 'var(--text-dim)' }}>
                  {a.start_date}{a.end_date && a.end_date !== a.start_date ? ` 〜 ${a.end_date}` : ''}
                </span>
                {a.cost != null && <span className="text-xs shrink-0" style={{ color: 'var(--text-dim)' }}>{fmtYen(a.cost)}</span>}
                <span className="text-[10px]" style={{ color: 'var(--text-dim)' }}>{openId === a.id ? '▲' : '▼'}</span>
              </div>
              {openId === a.id && <ActionDetail action={a} facility={current} onDelete={() => remove(a)} />}
            </div>
          ))}
        </div>
      )}
      <p className="text-xs mt-3" style={{ color: 'var(--text-dim)' }}>
        施策の実行期間中の「日別 新規予約（予約日ベース・該当チャネル）」を並べます。効果の判定はしません（事実の推移を見せるまで）。
        判断日＝打ち手を決めた日、実行開始日＝反映した日。予約日ベースはステイシー予約情報から算出。
      </p>
    </div>
  )
}

// 施策詳細: 実行期間中（前後7日を含む）の日別新規予約ミニチャート
function ActionDetail({ action, facility, onDelete }: { action: Action; facility: string; onDelete: () => void }) {
  const [flow, setFlow] = useState<FlowRow[] | null>(null)
  const [err, setErr] = useState('')

  const from = addDays(action.start_date, -7)
  const to = addDays(action.end_date || action.start_date, 7)

  useEffect(() => {
    let alive = true
    setFlow(null); setErr('')
    fetchAll<FlowRow>(() => supabase.from('mart_booking_flow')
      .select('flow_date, channel, new_reservations, new_room_nights, new_revenue')
      .eq('facility', facility).gte('flow_date', from).lte('flow_date', to))
      .then((rows) => { if (alive) setFlow(rows ?? []) })
      .catch((e: unknown) => { if (alive) setErr(e instanceof Error ? e.message : String(e)) })
    return () => { alive = false }
  }, [action.id, facility, from, to])

  const chart = useMemo(() => {
    const acc: Record<string, number> = {}
    for (const r of flow ?? []) {
      if (!channelMatch(action.channel, r.channel)) continue
      acc[r.flow_date] = (acc[r.flow_date] ?? 0) + (r.new_reservations ?? 0)
    }
    return eachDay(from, to).map((d) => ({ date: d.slice(5), full: d, 新規予約: acc[d] ?? 0 }))
  }, [flow, action.channel, from, to])

  const total = chart.reduce((s, d) => s + d.新規予約, 0)
  const inWindow = (chart.find((d) => d.full >= action.start_date) || {}).date

  return (
    <div className="px-4 pb-4 pt-1" style={{ borderTop: '1px solid var(--border)' }}>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-x-6 gap-y-1 text-xs mb-3" style={{ color: 'var(--text-dim)' }}>
        {action.decided_date && <div>判断日: <span style={{ color: 'var(--text)' }}>{action.decided_date}</span></div>}
        <div>実行: <span style={{ color: 'var(--text)' }}>{action.start_date}{action.end_date && action.end_date !== action.start_date ? ` 〜 ${action.end_date}` : ''}</span></div>
        {action.cost != null && <div>費用: <span style={{ color: 'var(--text)' }}>{fmtYen(action.cost)}</span></div>}
        {(action.target_stay_from || action.target_stay_to) && <div>対象宿泊: <span style={{ color: 'var(--text)' }}>{action.target_stay_from ?? '?'} 〜 {action.target_stay_to ?? '?'}</span></div>}
        {action.created_by && <div>登録: <span style={{ color: 'var(--text)' }}>{action.created_by}</span></div>}
      </div>
      {action.memo && <p className="text-sm mb-3" style={{ color: 'var(--text)' }}>{action.memo}</p>}

      <div className="text-xs mb-1" style={{ color: 'var(--text-dim)' }}>
        実行期間中の日別 新規予約（{action.channel ?? '全体'}・前後7日を含む）／期間合計 {fmtNum(total)}件
      </div>
      {err ? <p className="text-xs py-6 text-center" style={{ color: 'var(--red)' }}>{err}</p>
        : flow == null ? <p className="text-xs py-6 text-center" style={{ color: 'var(--text-dim)' }}>読み込み中…</p>
        : total === 0 ? <p className="text-xs py-6 text-center" style={{ color: 'var(--text-dim)' }}>この期間の新規予約データがありません（予約情報CSVの取込状況によります）。</p>
        : (
          <ResponsiveContainer width="100%" height={200}>
            <BarChart data={chart} margin={{ top: 5, right: 8, bottom: 0, left: -24 }}>
              <CartesianGrid stroke="#e7dac6" vertical={false} />
              <XAxis dataKey="date" {...CHART_AXIS} interval={Math.max(0, Math.floor(chart.length / 12))} />
              <YAxis {...CHART_AXIS} allowDecimals={false} />
              <Tooltip {...chartTooltip} formatter={(v: any) => [`${v}件`, '新規予約']} />
              {inWindow && (
                <ReferenceArea x1={inWindow} x2={(chart.find((d) => d.full >= (action.end_date || action.start_date)) || chart[chart.length - 1]).date}
                  fill={ACTION_COLOR[action.action_type] ?? '#888780'} fillOpacity={0.12} />
              )}
              <Bar dataKey="新規予約" fill={action.channel && action.channel !== '全体' ? channelColor(action.channel) : '#378ADD'} radius={[3, 3, 0, 0]} maxBarSize={24} />
            </BarChart>
          </ResponsiveContainer>
        )}

      <div className="flex justify-end mt-2">
        <button onClick={onDelete} className="text-xs px-2 py-1 hover:opacity-80" style={{ color: 'var(--red)' }}>削除</button>
      </div>
    </div>
  )
}

function Field({ label, children, wide, full }: { label: string; children: ReactNode; wide?: boolean; full?: boolean }) {
  return (
    <div className={full ? 'col-span-2 md:col-span-4' : wide ? 'col-span-2' : ''}>
      <label className="block text-[10px] mb-1 tracking-wide" style={{ color: 'var(--text-dim)' }}>{label}</label>
      {children}
    </div>
  )
}
