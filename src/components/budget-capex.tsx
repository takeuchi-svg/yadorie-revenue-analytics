'use client'

// 予算作成 → 修繕投資計画（HRM_2026予実管理.xlsx「②修繕投資計画」準拠）。
// 1行1案件の編集グリッド。総額=数量×単価は自動。PL計上/BS計上は記録のみ。年度ごと。
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useFacility } from '@/lib/facility-context'
import { supabase } from '@/lib/supabase/client'
import { fetchAll } from '@/lib/supabase/fetch-all'
import { fmtYen, fmtNum } from '@/lib/ui'
import { useToast } from '@/components/toast'
import { Loading } from '@/components/page-bits'

/* eslint-disable @typescript-eslint/no-explicit-any */
interface Row {
  id?: number; seq: number; priority: string; kind: string
  pl_booked: boolean; bs_booked: boolean; order_ym: string
  place: string; content: string; qty: string; unit_price: string
  vendor: string; payment: string; done: boolean; memo: string
}
const PRIORITIES = ['高', '中', '低']
const KINDS = ['修繕', '投資']
const numOf = (s: string) => (s.trim() === '' ? 0 : (Number.isFinite(Number(s)) ? Number(s) : 0))
const totalOf = (r: Row) => Math.round(numOf(r.qty) * numOf(r.unit_price))
const blank = (seq: number): Row => ({ seq, priority: '中', kind: '修繕', pl_booked: false, bs_booked: false, order_ym: '', place: '', content: '', qty: '1', unit_price: '0', vendor: '', payment: '', done: false, memo: '' })

export default function BudgetCapex({ fy, locked }: { fy: number | null; locked?: boolean }) {
  const { current } = useFacility()
  const toast = useToast()
  const [rows, setRows] = useState<Row[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [delIds, setDelIds] = useState<number[]>([])

  const load = useCallback(async () => {
    if (!current || fy == null) return
    setLoading(true); setDelIds([])
    const data = await fetchAll<any>(() => supabase.from('raw_capex_plan').select('*')
      .eq('facility', current).eq('fiscal_year', String(fy)).order('seq').order('id')).catch(() => [])
    const rs: Row[] = (data ?? []).map((r) => ({
      id: r.id, seq: r.seq ?? 0, priority: r.priority ?? '中', kind: r.kind ?? '修繕',
      pl_booked: !!r.pl_booked, bs_booked: !!r.bs_booked, order_ym: r.order_ym ?? '',
      place: r.place ?? '', content: r.content ?? '', qty: String(r.qty ?? 1), unit_price: String(r.unit_price ?? 0),
      vendor: r.vendor ?? '', payment: r.payment ?? '', done: !!r.done, memo: r.memo ?? '',
    }))
    setRows(rs.length ? rs : [blank(1)])
    setLoading(false)
  }, [current, fy])
  useEffect(() => { load() }, [load])

  const setCell = (i: number, k: keyof Row, v: any) => setRows((p) => p.map((r, idx) => idx === i ? { ...r, [k]: v } : r))
  const addRow = () => setRows((p) => [...p, blank((p.at(-1)?.seq ?? p.length) + 1)])
  const removeRow = (i: number) => setRows((p) => {
    const r = p[i]; if (r.id) setDelIds((d) => [...d, r.id!])
    return p.filter((_, idx) => idx !== i)
  })

  const totals = useMemo(() => {
    let all = 0, repair = 0, invest = 0, pl = 0, bs = 0
    for (const r of rows) { const t = totalOf(r); all += t; if (r.kind === '修繕') repair += t; else invest += t; if (r.pl_booked) pl += t; if (r.bs_booked) bs += t }
    return { all, repair, invest, pl, bs }
  }, [rows])

  const save = async () => {
    if (!current || fy == null) return
    setSaving(true)
    try {
      if (delIds.length) await supabase.from('raw_capex_plan').delete().in('id', delIds)
      const { data: { user } } = await supabase.auth.getUser()
      const payload = rows.map((r, i) => ({
        ...(r.id ? { id: r.id } : {}),
        facility: current, fiscal_year: String(fy), seq: r.seq || i + 1, priority: r.priority, kind: r.kind,
        pl_booked: r.pl_booked, bs_booked: r.bs_booked, order_ym: r.order_ym || null, place: r.place || null,
        content: r.content || null, qty: numOf(r.qty), unit_price: Math.round(numOf(r.unit_price)), amount: totalOf(r),
        vendor: r.vendor || null, payment: r.payment || null, done: r.done, memo: r.memo || null,
        updated_by: user?.email ?? null, updated_at: new Date().toISOString(),
      }))
      const { error } = await supabase.from('raw_capex_plan').upsert(payload)
      if (error) throw error
      toast('修繕投資計画を保存しました')
      load()
    } catch (e: any) { toast(`エラー: ${e.message ?? e}`, 'error') } finally { setSaving(false) }
  }

  const ro = !!locked
  const inputCls = 'field px-1 py-0.5 text-xs w-full'

  if (loading) return <Loading />
  return (
    <div className="mt-3">
      <div className="flex items-center gap-2 mb-2">
        <span className="text-xs" style={{ color: 'var(--text-dim)' }}>年度ごとの修繕・設備投資の計画。総額＝数量×単価（自動）。PL計上/BS計上は記録用（自動反映なし）。</span>
        {!ro && <button onClick={addRow} className="text-xs px-3 py-1 rounded-md" style={{ background: 'var(--surface2)', color: 'var(--text)' }}>＋行追加</button>}
        {!ro && <button onClick={save} disabled={saving} className="ml-auto px-4 py-1.5 rounded-md text-sm text-white disabled:opacity-50" style={{ background: 'var(--accent)' }}>{saving ? '保存中…' : '保存'}</button>}
        {ro && <span className="ml-auto text-[11px] px-2 py-0.5 rounded" style={{ background: 'var(--surface2)', color: 'var(--text-dim)' }}>🔒 ロック中（閲覧のみ）</span>}
      </div>

      <div className="card overflow-auto" style={{ maxHeight: 'calc(100vh - 230px)' }}>
        <table className="text-xs" style={{ minWidth: 1400, borderCollapse: 'separate', borderSpacing: 0 }}>
          <thead>
            <tr style={{ color: 'var(--text-dim)', background: 'var(--surface2)' }} className="text-left">
              {['#', '優先', '区分', 'PL', 'BS', '発注予定', '場所', '内容', '数量', '単価(円)', '総額(円)', '取引先', '支払い', '実施済', '備考', ''].map((h) => (
                <th key={h} className="px-2 py-2 whitespace-nowrap sticky top-0" style={{ background: 'var(--surface2)' }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i} style={{ borderTop: '1px solid var(--border)' }}>
                <td className="px-2 py-1 text-center" style={{ color: 'var(--text-dim)' }}>{i + 1}</td>
                <td className="px-1 py-1"><select disabled={ro} className={inputCls} value={r.priority} onChange={(e) => setCell(i, 'priority', e.target.value)} style={{ minWidth: 48 }}>{PRIORITIES.map((p) => <option key={p}>{p}</option>)}</select></td>
                <td className="px-1 py-1"><select disabled={ro} className={inputCls} value={r.kind} onChange={(e) => setCell(i, 'kind', e.target.value)} style={{ minWidth: 56 }}>{KINDS.map((p) => <option key={p}>{p}</option>)}</select></td>
                <td className="px-1 py-1 text-center"><input type="checkbox" disabled={ro} checked={r.pl_booked} onChange={(e) => setCell(i, 'pl_booked', e.target.checked)} /></td>
                <td className="px-1 py-1 text-center"><input type="checkbox" disabled={ro} checked={r.bs_booked} onChange={(e) => setCell(i, 'bs_booked', e.target.checked)} /></td>
                <td className="px-1 py-1"><input disabled={ro} className={inputCls} placeholder="2026-05" value={r.order_ym} onChange={(e) => setCell(i, 'order_ym', e.target.value)} style={{ minWidth: 76 }} /></td>
                <td className="px-1 py-1"><input disabled={ro} className={inputCls} value={r.place} onChange={(e) => setCell(i, 'place', e.target.value)} style={{ minWidth: 140 }} /></td>
                <td className="px-1 py-1"><input disabled={ro} className={inputCls} value={r.content} onChange={(e) => setCell(i, 'content', e.target.value)} style={{ minWidth: 200 }} /></td>
                <td className="px-1 py-1"><input disabled={ro} className={`${inputCls} text-right`} value={r.qty} onChange={(e) => setCell(i, 'qty', e.target.value)} style={{ minWidth: 48 }} /></td>
                <td className="px-1 py-1"><input disabled={ro} className={`${inputCls} text-right`} value={r.unit_price} onChange={(e) => setCell(i, 'unit_price', e.target.value)} style={{ minWidth: 90 }} /></td>
                <td className="px-2 py-1 text-right whitespace-nowrap font-medium">{fmtNum(totalOf(r))}</td>
                <td className="px-1 py-1"><input disabled={ro} className={inputCls} value={r.vendor} onChange={(e) => setCell(i, 'vendor', e.target.value)} style={{ minWidth: 100 }} /></td>
                <td className="px-1 py-1"><input disabled={ro} className={inputCls} value={r.payment} onChange={(e) => setCell(i, 'payment', e.target.value)} style={{ minWidth: 70 }} /></td>
                <td className="px-1 py-1 text-center"><input type="checkbox" disabled={ro} checked={r.done} onChange={(e) => setCell(i, 'done', e.target.checked)} /></td>
                <td className="px-1 py-1"><input disabled={ro} className={inputCls} value={r.memo} onChange={(e) => setCell(i, 'memo', e.target.value)} style={{ minWidth: 160 }} /></td>
                <td className="px-1 py-1 text-center">{!ro && <button onClick={() => removeRow(i)} className="text-[11px]" style={{ color: 'var(--red)' }} title="削除">×</button>}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr style={{ borderTop: '2px solid var(--border)', background: 'var(--surface2)' }} className="font-semibold">
              <td className="px-2 py-2" colSpan={10}>年間合計</td>
              <td className="px-2 py-2 text-right">{fmtNum(totals.all)}</td>
              <td className="px-2 py-2" colSpan={5}></td>
            </tr>
          </tfoot>
        </table>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mt-3">
        <Sum label="修繕 計" v={totals.repair} />
        <Sum label="投資 計" v={totals.invest} />
        <Sum label="PL計上 計" v={totals.pl} />
        <Sum label="BS計上 計（資産→減価償却）" v={totals.bs} />
      </div>
      <p className="text-[11px] mt-2" style={{ color: 'var(--text-dim)' }}>
        BS計上（資産性の設備/改装投資）は減価償却へ、PL計上は月次PLの修繕費等へ——という運用の記録用フラグです（自動連動はしません）。
      </p>
    </div>
  )
}

function Sum({ label, v }: { label: string; v: number }) {
  return (
    <div className="card p-3">
      <p className="text-[11px] mb-1" style={{ color: 'var(--text-dim)' }}>{label}</p>
      <p className="text-lg font-bold">{fmtYen(v)}</p>
    </div>
  )
}
