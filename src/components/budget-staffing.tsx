'use client'

// 予算作成 → 人員計画（HRM_2026予実管理.xlsx「④人員計画」準拠）。
// 上部=売上・稼働率・販売室数などの参考(既存の月次PL予算 budget_monthly から)。
// 中核=月別の人数計画(正社員/アルバイト/派遣＋内訳サービス/清掃/調理/夜警)。下部=自由記述(外注/育成/特記)。
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useFacility } from '@/lib/facility-context'
import { supabase } from '@/lib/supabase/client'
import { fetchAll } from '@/lib/supabase/fetch-all'
import { fmtNum, pct } from '@/lib/ui'
import { useToast } from '@/components/toast'
import { Loading } from '@/components/page-bits'

/* eslint-disable @typescript-eslint/no-explicit-any */
const fyMonths = (fy: number): string[] => {
  const out: string[] = []
  for (let m = 4; m <= 12; m++) out.push(`${fy}-${String(m).padStart(2, '0')}`)
  for (let m = 1; m <= 3; m++) out.push(`${fy + 1}-${String(m).padStart(2, '0')}`)
  return out
}
type Plan = { fulltime: string; parttime: string; dispatch: string; svc: string; clean: string; cook: string; night: string }
const emptyPlan = (): Plan => ({ fulltime: '', parttime: '', dispatch: '', svc: '', clean: '', cook: '', night: '' })
const numOf = (s: string) => (s.trim() === '' ? null : (Number.isFinite(Number(s)) ? Math.round(Number(s)) : null))

// 人数行の定義（内訳はインデント表示）
const HEAD_ROWS: { key: keyof Plan; label: string; indent?: boolean }[] = [
  { key: 'fulltime', label: '正社員数（採用含む）' },
  { key: 'parttime', label: 'アルバイト数' },
  { key: 'svc', label: 'サービス', indent: true },
  { key: 'clean', label: '清掃', indent: true },
  { key: 'cook', label: '調理', indent: true },
  { key: 'night', label: '夜警', indent: true },
  { key: 'dispatch', label: '派遣' },
]
// 参考KPI（budget_monthly の当初予算から）
const REF_ROWS: { code: string; label: string; pct?: boolean }[] = [
  { code: 'sales_total', label: '売上高' },
  { code: 'sales_lodging', label: '宿泊売上' },
  { code: '販売室数', label: '販売室数' },
  { code: '稼働率', label: '稼働率', pct: true },
  { code: '宿泊客数', label: '宿泊客数' },
  { code: '室単価', label: '室単価' },
]

export default function BudgetStaffing({ fy, locked }: { fy: number | null; locked?: boolean }) {
  const { current } = useFacility()
  const toast = useToast()
  const [plans, setPlans] = useState<Record<string, Plan>>({})
  const [note, setNote] = useState({ outsourcing: '', development: '', remarks: '' })
  const [ref, setRef] = useState<Record<string, number | null>>({})   // key: `${month}|${code}`
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)

  const months = useMemo(() => (fy == null ? [] : fyMonths(fy)), [fy])

  const load = useCallback(async () => {
    if (!current || fy == null) return
    setLoading(true)
    const [sp, sn, bm] = await Promise.all([
      fetchAll<any>(() => supabase.from('raw_staffing_plan').select('*').eq('facility', current).eq('fiscal_year', String(fy))).catch(() => []),
      supabase.from('raw_staffing_note').select('*').eq('facility', current).eq('fiscal_year', String(fy)).maybeSingle(),
      fetchAll<any>(() => supabase.from('budget_monthly').select('month, item_code, amount').eq('facility', current).eq('version', '当初').eq('fiscal_year', String(fy))).catch(() => []),
    ])
    const pm: Record<string, Plan> = {}
    for (const r of (sp ?? [])) pm[r.month] = {
      fulltime: r.fulltime?.toString() ?? '', parttime: r.parttime?.toString() ?? '', dispatch: r.dispatch?.toString() ?? '',
      svc: r.svc?.toString() ?? '', clean: r.clean?.toString() ?? '', cook: r.cook?.toString() ?? '', night: r.night?.toString() ?? '',
    }
    setPlans(pm)
    const n = (sn as any)?.data
    setNote({ outsourcing: n?.outsourcing ?? '', development: n?.development ?? '', remarks: n?.remarks ?? '' })
    const rm: Record<string, number | null> = {}
    for (const r of (bm ?? [])) rm[`${r.month}|${r.item_code}`] = r.amount
    setRef(rm)
    setLoading(false)
  }, [current, fy])
  useEffect(() => { load() }, [load])

  const setCell = (m: string, k: keyof Plan, v: string) => setPlans((p) => ({ ...p, [m]: { ...(p[m] ?? emptyPlan()), [k]: v } }))
  const rowTotal = (k: keyof Plan) => months.reduce((s, m) => s + (numOf(plans[m]?.[k] ?? '') ?? 0), 0)

  const save = async () => {
    if (!current || fy == null) return
    setSaving(true)
    try {
      const { data: { user } } = await supabase.auth.getUser()
      const rows = months.map((m) => {
        const p = plans[m] ?? emptyPlan()
        return {
          facility: current, fiscal_year: String(fy), month: m,
          fulltime: numOf(p.fulltime), parttime: numOf(p.parttime), dispatch: numOf(p.dispatch),
          svc: numOf(p.svc), clean: numOf(p.clean), cook: numOf(p.cook), night: numOf(p.night),
          updated_by: user?.email ?? null, updated_at: new Date().toISOString(),
        }
      })
      const [e1, e2] = await Promise.all([
        supabase.from('raw_staffing_plan').upsert(rows, { onConflict: 'facility,fiscal_year,month' }),
        supabase.from('raw_staffing_note').upsert({ facility: current, fiscal_year: String(fy), ...note, updated_by: user?.email ?? null, updated_at: new Date().toISOString() }, { onConflict: 'facility,fiscal_year' }),
      ])
      if (e1.error) throw e1.error; if (e2.error) throw e2.error
      toast('人員計画を保存しました')
    } catch (e: any) { toast(`エラー: ${e.message ?? e}`, 'error') } finally { setSaving(false) }
  }

  const ro = !!locked
  if (loading) return <Loading />

  const th = 'px-2 py-2 text-right whitespace-nowrap sticky top-0'
  const stickyLeft = 'sticky left-0 z-10 whitespace-nowrap'

  return (
    <div className="mt-3">
      <div className="flex items-center gap-2 mb-2">
        <span className="text-xs" style={{ color: 'var(--text-dim)' }}>売上・稼働の予算を参考に、月別の人数計画を立てます。人件費（円）は月次PL予算・シフト労務が担当します。</span>
        {!ro && <button onClick={save} disabled={saving} className="ml-auto px-4 py-1.5 rounded-md text-sm text-white disabled:opacity-50" style={{ background: 'var(--accent)' }}>{saving ? '保存中…' : '保存'}</button>}
        {ro && <span className="ml-auto text-[11px] px-2 py-0.5 rounded" style={{ background: 'var(--surface2)', color: 'var(--text-dim)' }}>🔒 ロック中（閲覧のみ）</span>}
      </div>

      <div className="card overflow-auto" style={{ maxHeight: 'calc(100vh - 260px)' }}>
        <table className="text-xs" style={{ minWidth: 1100, borderCollapse: 'separate', borderSpacing: 0 }}>
          <thead>
            <tr style={{ color: 'var(--text-dim)', background: 'var(--surface2)' }}>
              <th className={`px-3 py-2 text-left ${stickyLeft}`} style={{ background: 'var(--surface2)', borderRight: '2px solid var(--border)' }}>項目</th>
              {months.map((m) => <th key={m} className={th} style={{ background: 'var(--surface2)', minWidth: 74 }}>{m.slice(5)}月</th>)}
              <th className={th} style={{ background: 'var(--surface)', borderLeft: '2px solid var(--border)', minWidth: 88 }}>年間</th>
            </tr>
          </thead>
          <tbody>
            {/* 参考: 売上・KPI（当初予算） */}
            {REF_ROWS.map((rr) => (
              <tr key={rr.code} style={{ borderTop: '1px solid var(--border)', background: 'var(--surface2)' }}>
                <td className={`px-3 py-1.5 ${stickyLeft}`} style={{ background: 'var(--surface2)', borderRight: '2px solid var(--border)', color: 'var(--text-dim)' }}>参考 {rr.label}</td>
                {months.map((m) => { const v = ref[`${m}|${rr.code}`]; return <td key={m} className="px-2 py-1.5 text-right" style={{ color: 'var(--text-dim)' }}>{v == null ? '—' : rr.pct ? pct(v) : fmtNum(v)}</td> })}
                <td className="px-2 py-1.5 text-right" style={{ borderLeft: '2px solid var(--border)', color: 'var(--text-dim)' }}>
                  {rr.pct ? '—' : fmtNum(months.reduce((s, m) => s + (ref[`${m}|${rr.code}`] ?? 0), 0))}
                </td>
              </tr>
            ))}
            {/* 人数計画（編集） */}
            {HEAD_ROWS.map((hr) => (
              <tr key={hr.key} style={{ borderTop: '1px solid var(--border)' }}>
                <td className={`px-3 py-1 ${stickyLeft} ${hr.indent ? 'pl-6' : 'font-medium'}`} style={{ background: 'var(--surface)', borderRight: '2px solid var(--border)', color: hr.indent ? 'var(--text-dim)' : undefined }}>{hr.indent ? '└ ' : ''}{hr.label}</td>
                {months.map((m) => (
                  <td key={m} className="px-1 py-1 text-right" style={{ minWidth: 74 }}>
                    <input disabled={ro} className="field px-1 py-0.5 text-xs text-right w-full" style={{ color: '#2563eb', minWidth: 56 }}
                      value={plans[m]?.[hr.key] ?? ''} onChange={(e) => setCell(m, hr.key, e.target.value)} />
                  </td>
                ))}
                <td className="px-2 py-1 text-right font-medium" style={{ borderLeft: '2px solid var(--border)' }}>{fmtNum(rowTotal(hr.key))}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* 自由記述 */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-3 mt-3">
        <NoteBox label="外注（外部委託）" v={note.outsourcing} onChange={(v) => setNote((n) => ({ ...n, outsourcing: v }))} ro={ro} />
        <NoteBox label="人材育成・配置転換・業務改善" v={note.development} onChange={(v) => setNote((n) => ({ ...n, development: v }))} ro={ro} />
        <NoteBox label="特記事項" v={note.remarks} onChange={(v) => setNote((n) => ({ ...n, remarks: v }))} ro={ro} />
      </div>
      <p className="text-[11px] mt-2" style={{ color: 'var(--text-dim)' }}>青セル=人数を入力。内訳（サービス/清掃/調理/夜警）はアルバイトの職種内訳の目安です。</p>
    </div>
  )
}

function NoteBox({ label, v, onChange, ro }: { label: string; v: string; onChange: (v: string) => void; ro: boolean }) {
  return (
    <div>
      <div className="text-xs font-semibold mb-1">{label}</div>
      <textarea disabled={ro} value={v} onChange={(e) => onChange(e.target.value)} className="field w-full text-sm p-2" style={{ minHeight: 90 }} />
    </div>
  )
}
