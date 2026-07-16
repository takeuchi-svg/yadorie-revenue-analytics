'use client'

// B4 月次PL予算 作成。売上は日別予算(budget_daily)の月次集計から自動連携、費目は支配人が手入力。
// GOP/EBITDA/営業利益・各集計行(cogs/labor/sga)は自動計算。前年予算を各セルの下に参考表示。
// 器の項目構成は前年度(FY-1)の budget_monthly をテンプレとして使う。保存は version='当初'。
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useFacility } from '@/lib/facility-context'
import { supabase } from '@/lib/supabase/client'
import { fetchAll } from '@/lib/supabase/fetch-all'
import { fmtNum } from '@/lib/ui'
import { useToast } from '@/components/toast'
import { Loading, Empty } from '@/components/page-bits'
import { COLLAPSIBLE, CAT_TOTALS } from '@/lib/pl-compute'

/* eslint-disable @typescript-eslint/no-explicit-any */
interface Item { code: string; name: string; category: string | null; sort_order: number }
const num = (s: string): number | null => (s.trim() === '' ? null : (Number.isFinite(Number(s)) ? Number(s) : null))
const fyMonths = (fy: number): string[] => {
  const out: string[] = []
  for (let m = 4; m <= 12; m++) out.push(`${fy}-${String(m).padStart(2, '0')}`)
  for (let m = 1; m <= 3; m++) out.push(`${fy + 1}-${String(m).padStart(2, '0')}`)
  return out
}
const k = (m: string, code: string) => `${m}|${code}`

export default function BudgetPL({ fy, fyList, onFy }: { fy: number | null; fyList: number[]; onFy: (fy: number) => void }) {
  const { current } = useFacility()
  const toast = useToast()
  const [items, setItems] = useState<Item[]>([])
  const [amt, setAmt] = useState<Record<string, string>>({})       // 手入力（明細費目）m|code → 文字列
  const [prior, setPrior] = useState<Record<string, number | null>>({}) // 前年予算 m|code
  const [salesByMonth, setSalesByMonth] = useState<Record<string, number | null>>({})
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)

  const months = useMemo(() => (fy == null ? [] : fyMonths(fy)), [fy])

  const load = useCallback(async () => {
    if (!current || fy == null) return
    setLoading(true)
    try {
      const [tmplRows, curRows, dailyRoll] = await Promise.all([
        // テンプレ＝前年度(FY-1)の項目構成＋前年予算額。無ければ当年度の既存を使う。
        fetchAll(() => supabase.from('budget_monthly').select('month, category, item_code, item_name, amount, sort_order').eq('facility', current).eq('version', '当初').eq('fiscal_year', String(fy - 1))).catch(() => []),
        fetchAll(() => supabase.from('budget_monthly').select('month, category, item_code, item_name, amount, sort_order').eq('facility', current).eq('version', '当初').eq('fiscal_year', String(fy))).catch(() => []),
        fetchAll(() => supabase.from('mart_budget_daily_monthly').select('month, revenue_budget').eq('facility', current)).catch(() => []),
      ])
      const tmpl = (tmplRows as any[]) ?? []
      const cur = (curRows as any[]) ?? []
      // 項目定義（当年度に既存があればそれ、無ければ前年テンプレ）。sort_order順・item_code一意。
      const src = cur.length ? cur : tmpl
      const seen = new Set<string>(); const its: Item[] = []
      for (const b of [...src].sort((a, z) => (a.sort_order ?? 0) - (z.sort_order ?? 0))) {
        if (seen.has(b.item_code)) continue; seen.add(b.item_code)
        its.push({ code: b.item_code, name: b.item_name, category: b.category, sort_order: b.sort_order ?? 0 })
      }
      // 前年予算 m|code
      const p: Record<string, number | null> = {}
      for (const b of tmpl) p[k(b.month, b.item_code)] = b.amount
      // 当年度の既存手入力を復元
      const a: Record<string, string> = {}
      for (const b of cur) a[k(b.month, b.item_code)] = b.amount == null ? '' : String(b.amount)
      // 売上高計＝日別ロールアップ（当年度の月）
      const sm: Record<string, number | null> = {}
      ;((dailyRoll as any[]) ?? []).forEach((r) => { if (fyMonths(fy).includes(r.month)) sm[r.month] = r.revenue_budget })
      setItems(its); setAmt(a); setPrior(p); setSalesByMonth(sm)
    } finally { setLoading(false) }
  }, [current, fy])
  useEffect(() => { load() }, [load])

  // 明細コード（集計の再計算に使用）
  const detailCodes = useCallback((cat: string) => items.filter((i) => i.category === cat && i.code !== COLLAPSIBLE[cat]).map((i) => i.code), [items])
  const raw = (m: string, code: string): number | null => num(amt[k(m, code)] ?? '')
  const sumDetails = (m: string, cat: string) => detailCodes(cat).reduce((s, c) => s + (raw(m, c) ?? 0), 0)

  // 集計・計算行の値（yojitsuと同じ考え方）。売上=日別、集計=明細合計 or 手入力、gop/ebitda/oi=自動。
  const value = useCallback((m: string, code: string): number | null => {
    switch (code) {
      case 'sales_total': return salesByMonth[m] ?? null
      case 'cogs_total': return detailCodes('原価').length ? sumDetails(m, '原価') : raw(m, code)
      case 'labor_total': return detailCodes('人件費').length ? sumDetails(m, '人件費') : raw(m, code)
      case 'sga_total': return detailCodes('販売管理費').length ? sumDetails(m, '販売管理費') : raw(m, code)
      case 'gross_profit': { const s = value(m, 'sales_total'), c = value(m, 'cogs_total'); return s == null ? null : s - (c ?? 0) }
      case 'gop': { const s = value(m, 'sales_total'); return s == null ? null : s - (value(m, 'cogs_total') ?? 0) - (value(m, 'labor_total') ?? 0) - (value(m, 'sga_total') ?? 0) }
      case 'ebitda': { const g = value(m, 'gop'); return g == null ? null : g - (raw(m, '賃借料_旅館_') ?? 0) }
      case 'operating_income': { const e = value(m, 'ebitda'); return e == null ? null : e - (raw(m, '減価償却費') ?? 0) }
      default: return raw(m, code)
    }
  }, [salesByMonth, amt, items])

  // 集計から自動算出される＝手入力不可の行
  const isComputed = (code: string) => code === 'sales_total' || code === 'gross_profit' || code === 'gop' || code === 'ebitda' || code === 'operating_income'
    || (code === 'cogs_total' && detailCodes('原価').length > 0)
    || (code === 'labor_total' && detailCodes('人件費').length > 0)
    || (code === 'sga_total' && detailCodes('販売管理費').length > 0)

  const setCell = (m: string, code: string, v: string) => setAmt((p) => ({ ...p, [k(m, code)]: v }))
  const yearVal = (code: string) => months.reduce((s, m) => s + (value(m, code) ?? 0), 0)

  const save = async () => {
    if (!current || fy == null) return
    setSaving(true)
    const rows: any[] = []
    for (const m of months) for (const it of items) {
      const v = value(m, it.code)
      rows.push({ facility: current, fiscal_year: String(fy), month: m, version: '当初', category: it.category, item_code: it.code, item_name: it.name, amount: v, sort_order: it.sort_order })
    }
    const { error } = await supabase.from('budget_monthly').upsert(rows, { onConflict: 'facility,fiscal_year,month,item_code,version' })
    toast(error ? `エラー: ${error.message}` : `${fy}年度の月次PL予算を保存しました`, error ? 'error' : 'success')
    setSaving(false)
  }

  if (!current) return <div className="text-sm mt-4" style={{ color: 'var(--text-dim)' }}>宿を選択してください。</div>

  return (
    <div className="mt-4">
      <div className="flex items-center gap-2 flex-wrap mb-2">
        <span className="text-xs" style={{ color: 'var(--text-dim)' }}>年度</span>
        <select className="field px-3 py-1.5 text-sm" value={fy ?? ''} onChange={(e) => onFy(Number(e.target.value))}>
          {fyList.map((y) => <option key={y} value={y}>{y}年度</option>)}
        </select>
        <button onClick={save} disabled={saving || !items.length} className="ml-auto px-4 py-1.5 rounded-md text-sm text-white disabled:opacity-50" style={{ background: 'var(--accent)' }}>{saving ? '保存中…' : '保存'}</button>
      </div>
      <p className="text-[11px] mb-2" style={{ color: 'var(--text-dim)' }}>
        売上高は日別予算の月次集計から自動で入ります（手入力しません）。原価・人件費・販管費などの費目を月ごとに入力してください。GOP・営業利益は自動計算。各セル下の小さい数字は前年予算です。項目の器は前年度の構成を使っています。
      </p>

      {loading ? <Loading /> : !items.length ? (
        <Empty message="項目テンプレートがありません。前年度の予算（budget_monthly）が無い宿では、まず日別予算の保存や前年予算の取込が必要です。" />
      ) : (
        <div className="card overflow-auto" style={{ maxHeight: 'calc(100vh - 210px)' }}>
          <table className="text-xs border-separate" style={{ borderSpacing: 0, minWidth: 1200 }}>
            <thead>
              <tr style={{ color: 'var(--text-dim)' }}>
                <th className="px-3 py-2 text-left whitespace-nowrap sticky left-0 top-0 z-30" style={{ background: 'var(--surface2)', borderRight: '2px solid var(--border)' }}>項目</th>
                {months.map((m) => <th key={m} className="px-2 py-2 text-right whitespace-nowrap sticky top-0 z-20" style={{ background: 'var(--surface2)', minWidth: 92 }}>{m.slice(5)}月</th>)}
                <th className="px-2 py-2 text-right whitespace-nowrap sticky top-0 z-20" style={{ background: 'var(--surface)', minWidth: 104, borderLeft: '2px solid var(--border)' }}>年間</th>
              </tr>
            </thead>
            <tbody>
              {items.map((it) => {
                const total = CAT_TOTALS.has(it.code)
                const computed = isComputed(it.code)
                return (
                  <tr key={it.code} style={{ background: total ? 'var(--surface2)' : undefined }}>
                    <td className={`px-3 py-1 whitespace-nowrap sticky left-0 z-10 ${total ? 'font-semibold' : ''}`} style={{ background: total ? 'var(--surface2)' : 'var(--surface)', borderRight: '2px solid var(--border)', borderTop: '1px solid var(--border)', color: total ? undefined : 'var(--text-dim)' }}>{it.name}</td>
                    {months.map((m) => {
                      const v = value(m, it.code)
                      const pv = prior[k(m, it.code)]
                      return (
                        <td key={m} className="px-1 py-1 text-right align-top" style={{ borderTop: '1px solid var(--border)' }}>
                          {computed ? (
                            <div className={`px-1 ${total ? 'font-semibold' : ''}`}>{v == null ? '—' : fmtNum(v)}</div>
                          ) : (
                            <input className="field px-1.5 py-1 text-xs text-right w-full" style={{ minWidth: 76 }} value={amt[k(m, it.code)] ?? ''} onChange={(e) => setCell(m, it.code, e.target.value)} />
                          )}
                          <div className="text-[9px] leading-tight" style={{ color: 'var(--text-dim)' }}>{pv == null ? '' : `前 ${fmtNum(pv)}`}</div>
                        </td>
                      )
                    })}
                    <td className="px-2 py-1 text-right whitespace-nowrap" style={{ background: 'var(--surface)', borderLeft: '2px solid var(--border)', borderTop: '1px solid var(--border)' }}>
                      <span className={total ? 'font-semibold' : ''}>{fmtNum(yearVal(it.code))}</span>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
