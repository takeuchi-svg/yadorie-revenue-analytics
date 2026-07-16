'use client'

// B4 月次PL予算（⑤月次計画準拠）。宿泊売上＋KPIは日別予算の月次集計から自動。
// 変動費=率入力→額=base×率、固定費=額入力。集計/GOP/EBITDA/営業損益・室料売上等は自動計算。
// 青=入力（固定費は金額・変動費は率）、他は計算。各セルは 金額(上)＋率or金額(下)。テンプレは前年budget_monthly。
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useFacility } from '@/lib/facility-context'
import { supabase } from '@/lib/supabase/client'
import { fetchAll } from '@/lib/supabase/fetch-all'
import { fmtNum, pct } from '@/lib/ui'
import { useToast } from '@/components/toast'
import { Loading, Empty } from '@/components/page-bits'

/* eslint-disable @typescript-eslint/no-explicit-any */
interface Item { code: string; name: string; category: string | null; sort_order: number }
const num = (s: string): number | null => (s.trim() === '' ? null : (Number.isFinite(Number(s)) ? Number(s) : null))
const fyMonths = (fy: number): string[] => {
  const out: string[] = []
  for (let m = 4; m <= 12; m++) out.push(`${fy}-${String(m).padStart(2, '0')}`)
  for (let m = 1; m <= 3; m++) out.push(`${fy + 1}-${String(m).padStart(2, '0')}`)
  return out
}
const K = (m: string, code: string) => `${m}|${code}`

// 項目の性質（⑤月次計画準拠）。既定=固定費(額入力)。
type Kind = { kind: 'daily' | 'var' | 'fix' | 'calc'; base?: 'lodging' | 'sales' }
const DAILY_CODES = ['sales_lodging', '在庫数', '稼働日数', '稼働率', '販売室数', '同伴係数', '宿泊客数', '客単価', '室単価']
const CALC_CODES = ['sales_total', 'sales_room', 'cogs_total', '食材原価率', 'labor_total', 'sga_total', '水道光熱費', 'gop', 'ebitda', 'operating_income', 'gross_profit']
const VAR_LODGING = ['sales_shop', 'sales_beverage', 'sales_extra_food', '食材仕入', '飲料仕入', '売店仕入']
const VAR_SALES = ['販売促進費', '消耗品費', 'リネン費', '送客手数料', 'カード手数料']
const WATER = ['水道代', '重油_灯油', '電気', 'ガス']
const kindOf = (code: string): Kind => {
  if (DAILY_CODES.includes(code)) return { kind: 'daily' }
  if (CALC_CODES.includes(code)) return { kind: 'calc' }
  if (VAR_LODGING.includes(code)) return { kind: 'var', base: 'lodging' }
  if (VAR_SALES.includes(code)) return { kind: 'var', base: 'sales' }
  return { kind: 'fix' }
}
// KPI等の表示形式
const fmtCode = (code: string, v: number | null): string => {
  if (v == null) return '—'
  if (code === '稼働率' || code === '食材原価率') return pct(v)
  if (code === '同伴係数') return v.toFixed(2)
  return fmtNum(v)
}
const isKpi = (code: string) => ['在庫数', '稼働日数', '稼働率', '販売室数', '同伴係数', '宿泊客数', '客単価', '室単価'].includes(code)

export default function BudgetPL({ fy, fyList, onFy, locked = false }: { fy: number | null; fyList: number[]; onFy: (fy: number) => void; locked?: boolean }) {
  const { current } = useFacility()
  const toast = useToast()
  const [items, setItems] = useState<Item[]>([])
  const [inp, setInp] = useState<Record<string, string>>({})      // 入力: 固定費=金額 / 変動費=率(%)
  const [prior, setPrior] = useState<Record<string, number | null>>({})
  const [daily, setDaily] = useState<Record<string, Record<string, number | null>>>({}) // month -> {code -> value}
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)

  const months = useMemo(() => (fy == null ? [] : fyMonths(fy)), [fy])

  const load = useCallback(async () => {
    if (!current || fy == null) return
    setLoading(true)
    try {
      const [tmplRows, curRows, dailyRows] = await Promise.all([
        fetchAll(() => supabase.from('budget_monthly').select('month, category, item_code, item_name, amount, ratio, sort_order').eq('facility', current).eq('version', '当初').eq('fiscal_year', String(fy - 1))).catch(() => []),
        fetchAll(() => supabase.from('budget_monthly').select('month, category, item_code, item_name, amount, ratio, sort_order').eq('facility', current).eq('version', '当初').eq('fiscal_year', String(fy))).catch(() => []),
        fetchAll(() => supabase.from('budget_daily').select('date, inventory, rooms_sold, guests, total_revenue').eq('facility', current).eq('version', '当初').eq('fiscal_year', String(fy))).catch(() => []),
      ])
      const tmpl = (tmplRows as any[]) ?? [], cur = (curRows as any[]) ?? []
      // 項目テンプレ（当年度に既存があればそれ、無ければ前年）
      const src = cur.length ? cur : tmpl
      const seen = new Set<string>(); const its: Item[] = []
      for (const b of [...src].sort((a, z) => (a.sort_order ?? 0) - (z.sort_order ?? 0))) {
        if (seen.has(b.item_code)) continue; seen.add(b.item_code)
        its.push({ code: b.item_code, name: b.item_name, category: b.category, sort_order: b.sort_order ?? 0 })
      }
      // 日別→月次集計（KPIと宿泊売上）
      const agg: Record<string, any> = {}
      for (const m of fyMonths(fy)) agg[m] = { inv: 0, rooms: 0, guests: 0, rev: 0, opDays: 0 }
      ;((dailyRows as any[]) ?? []).forEach((x) => {
        const m = String(x.date).slice(0, 7); if (!agg[m]) return
        agg[m].inv += Number(x.inventory) || 0; agg[m].rooms += Number(x.rooms_sold) || 0
        agg[m].guests += Number(x.guests) || 0; agg[m].rev += Number(x.total_revenue) || 0
        if ((Number(x.rooms_sold) || 0) > 0) agg[m].opDays += 1
      })
      const dm: Record<string, Record<string, number | null>> = {}
      for (const m of fyMonths(fy)) {
        const a = agg[m]
        dm[m] = {
          sales_lodging: a.rev || null, 在庫数: a.inv || null, 稼働日数: a.opDays || null,
          稼働率: a.inv ? a.rooms / a.inv : null, 販売室数: a.rooms || null,
          同伴係数: a.rooms ? a.guests / a.rooms : null, 宿泊客数: a.guests || null,
          客単価: a.guests ? a.rev / a.guests : null, 室単価: a.rooms ? a.rev / a.rooms : null,
        }
      }
      // 前年予算（参考）
      const p: Record<string, number | null> = {}
      for (const b of tmpl) p[K(b.month, b.item_code)] = b.amount
      // 当年度の既存入力を復元（固定=金額 / 変動=率%）。ratio保存があればそれ、無ければamount/baseで逆算
      const inMap: Record<string, string> = {}
      for (const b of cur) {
        const kd = kindOf(b.item_code)
        if (kd.kind === 'var') {
          if (b.ratio != null) inMap[K(b.month, b.item_code)] = String(Number((b.ratio * 100).toFixed(4)))
          else if (b.amount != null) {
            const base = kd.base === 'lodging' ? dm[b.month]?.sales_lodging : null
            if (base) inMap[K(b.month, b.item_code)] = String(Number((b.amount / base * 100).toFixed(4)))
          }
        } else if (kd.kind === 'fix') {
          if (b.amount != null) inMap[K(b.month, b.item_code)] = String(b.amount)
        }
      }
      setItems(its); setInp(inMap); setPrior(p); setDaily(dm)
    } finally { setLoading(false) }
  }, [current, fy])
  useEffect(() => { load() }, [load])

  const catCodes = (cat: string, kinds: Kind['kind'][]) => items.filter((i) => i.category === cat && kinds.includes(kindOf(i.code).kind)).map((i) => i.code)
  const rawIn = (m: string, code: string): number | null => num(inp[K(m, code)] ?? '')

  // 値の解決（円環しないよう sales_lodging→revenue var→sales_total→cost var→集計 の順で参照）。
  // 自己再帰のため関数宣言（巻き上げ）で定義する。
  function value(m: string, code: string): number | null {
    const kd = kindOf(code)
    if (kd.kind === 'daily') return daily[m]?.[code] ?? null
    if (kd.kind === 'var') {
      const base = kd.base === 'lodging' ? value(m, 'sales_lodging') : value(m, 'sales_total')
      const r = rawIn(m, code); return base != null && r != null ? base * (r / 100) : null
    }
    if (kd.kind === 'fix') return rawIn(m, code)
    // calc
    const sumC = (cat: string, exclude: string[] = []) => catCodes(cat, ['var', 'fix']).filter((c) => !exclude.includes(c)).reduce((s, c) => s + (value(m, c) ?? 0), 0)
    switch (code) {
      case 'sales_total': return (value(m, 'sales_lodging') ?? 0) + sumC('売上', ['sales_food'])
      case 'sales_room': return (value(m, 'sales_lodging') ?? 0) - (value(m, 'sales_food') ?? 0)
      case 'cogs_total': return sumC('原価', ['期末商品棚卸']) - (value(m, '期末商品棚卸') ?? 0)
      case '食材原価率': { const rev = (value(m, 'sales_food') ?? 0) + (value(m, 'sales_extra_food') ?? 0); const c = (value(m, '期首商品棚卸') ?? 0) + (value(m, '食材仕入') ?? 0) - (value(m, '期末商品棚卸') ?? 0); return rev ? c / rev : null }
      case 'labor_total': return sumC('人件費')
      case '水道光熱費': return WATER.reduce((s, c) => s + (value(m, c) ?? 0), 0)
      case 'sga_total': return sumC('販売管理費')
      case 'gop': return (value(m, 'sales_total') ?? 0) - (value(m, 'cogs_total') ?? 0) - (value(m, 'labor_total') ?? 0) - (value(m, 'sga_total') ?? 0)
      case 'ebitda': return (value(m, 'gop') ?? 0) - (value(m, '賃借料_旅館_') ?? 0)
      case 'operating_income': return (value(m, 'ebitda') ?? 0) - (value(m, '減価償却費') ?? 0)
      case 'gross_profit': return (value(m, 'sales_total') ?? 0) - (value(m, 'cogs_total') ?? 0)
    }
    return null
  }

  const setCell = (m: string, code: string, v: string) => setInp((p) => ({ ...p, [K(m, code)]: v }))
  const yearVal = (code: string) => months.reduce((s, m) => s + (value(m, code) ?? 0), 0)

  const save = async () => {
    if (!current || fy == null) return
    setSaving(true)
    const rows: any[] = []
    for (const m of months) for (const it of items) {
      const kd = kindOf(it.code)
      const amount = value(m, it.code)
      const st = value(m, 'sales_total')
      const ratio = kd.kind === 'var' ? (rawIn(m, it.code) == null ? null : (rawIn(m, it.code)! / 100)) : (amount != null && st ? amount / st : null)
      rows.push({ facility: current, fiscal_year: String(fy), month: m, version: '当初', category: it.category, item_code: it.code, item_name: it.name, amount: amount == null ? null : Math.round(amount), ratio, sort_order: it.sort_order })
    }
    const { error } = await supabase.from('budget_monthly').upsert(rows, { onConflict: 'facility,fiscal_year,month,item_code,version' })
    toast(error ? `エラー: ${error.message}` : `${fy}年度の月次PL予算を保存しました`, error ? 'error' : 'success')
    setSaving(false)
  }

  if (!current) return <div className="text-sm mt-4" style={{ color: 'var(--text-dim)' }}>宿を選択してください。</div>
  const blue = { color: '#2563eb' }

  return (
    <div className="mt-4">
      <div className="flex items-center gap-2 flex-wrap mb-2">
        <span className="text-xs" style={{ color: 'var(--text-dim)' }}>年度</span>
        <select className="field px-3 py-1.5 text-sm" value={fy ?? ''} onChange={(e) => onFy(Number(e.target.value))}>
          {fyList.map((y) => <option key={y} value={y}>{y}年度</option>)}
        </select>
        <button onClick={save} disabled={saving || !items.length || locked} className="ml-auto px-4 py-1.5 rounded-md text-sm text-white disabled:opacity-50" style={{ background: 'var(--accent)' }}>{saving ? '保存中…' : locked ? '🔒 ロック中' : '保存'}</button>
      </div>
      <p className="text-[11px] mb-2" style={{ color: 'var(--text-dim)' }}>
        <span style={{ color: '#2563eb' }}>青</span>＝入力（固定費は金額・変動費は率）。宿泊売上とKPIは日別予算から自動、集計・GOP・EBITDA・営業損益は自動計算。各セルは 金額(上)／率(下)。項目の器は前年度の構成。
      </p>

      {loading ? <Loading /> : !items.length ? (
        <Empty message="項目テンプレートがありません。前年度の予算(budget_monthly)が無い宿では、まず前年予算の取込が必要です。" />
      ) : (
        <div className="card overflow-auto" style={{ maxHeight: 'calc(100vh - 210px)' }}>
          <table className="text-xs border-separate" style={{ borderSpacing: 0, minWidth: 1250 }}>
            <thead>
              <tr style={{ color: 'var(--text-dim)' }}>
                <th className="px-3 py-2 text-left whitespace-nowrap sticky left-0 top-0 z-30" style={{ background: 'var(--surface2)', borderRight: '2px solid var(--border)' }}>項目</th>
                {months.map((m) => <th key={m} className="px-2 py-2 text-right whitespace-nowrap sticky top-0 z-20" style={{ background: 'var(--surface2)', minWidth: 92 }}>{m.slice(5)}月</th>)}
                <th className="px-2 py-2 text-right whitespace-nowrap sticky top-0 z-20" style={{ background: 'var(--surface)', minWidth: 104, borderLeft: '2px solid var(--border)' }}>年間</th>
              </tr>
            </thead>
            <tbody>
              {items.map((it) => {
                const kd = kindOf(it.code)
                const total = ['sales_total', 'cogs_total', 'labor_total', 'sga_total', 'gop', 'ebitda', 'operating_income'].includes(it.code)
                const kpi = isKpi(it.code)
                return (
                  <tr key={it.code} style={{ background: total ? 'var(--surface2)' : undefined }}>
                    <td className={`px-3 py-1 whitespace-nowrap sticky left-0 z-10 ${total ? 'font-semibold' : ''}`} style={{ background: total ? 'var(--surface2)' : 'var(--surface)', borderRight: '2px solid var(--border)', borderTop: '1px solid var(--border)', color: total ? undefined : 'var(--text-dim)', paddingLeft: kd.kind === 'var' || kd.kind === 'fix' || kpi ? 20 : 12 }}>{it.name}</td>
                    {months.map((m) => {
                      const v = value(m, it.code)
                      const st = value(m, 'sales_total')
                      const pv = prior[K(m, it.code)]
                      return (
                        <td key={m} className="px-1 py-1 text-right align-top" style={{ borderTop: '1px solid var(--border)' }}>
                          {kpi ? (
                            <div>{fmtCode(it.code, v)}</div>
                          ) : kd.kind === 'fix' ? (
                            <>
                              <input className="field px-1 py-0.5 text-xs text-right w-full" readOnly={locked} style={{ ...blue, minWidth: 70 }} value={inp[K(m, it.code)] ?? ''} onChange={(e) => setCell(m, it.code, e.target.value)} />
                              <div className="text-[9px]" style={{ color: 'var(--text-dim)' }}>{st ? pct((v ?? 0) / st) : ''}</div>
                            </>
                          ) : kd.kind === 'var' ? (
                            <>
                              <div className="flex items-center justify-end gap-0.5">
                                <input className="field px-1 py-0.5 text-xs text-right" readOnly={locked} style={{ ...blue, width: 46 }} value={inp[K(m, it.code)] ?? ''} onChange={(e) => setCell(m, it.code, e.target.value)} /><span className="text-[9px]" style={blue}>%</span>
                              </div>
                              <div className="text-[9px]" style={{ color: 'var(--text-dim)' }}>{fmtNum(v)}</div>
                            </>
                          ) : (
                            <>
                              <div className={total ? 'font-semibold' : ''}>{fmtCode(it.code, v)}</div>
                              {!['食材原価率'].includes(it.code) && <div className="text-[9px]" style={{ color: 'var(--text-dim)' }}>{st ? pct((v ?? 0) / st) : ''}</div>}
                            </>
                          )}
                          {pv != null && !kpi && <div className="text-[9px] leading-tight" style={{ color: 'var(--text-dim)' }}>前 {fmtNum(pv)}</div>}
                        </td>
                      )
                    })}
                    <td className="px-2 py-1 text-right whitespace-nowrap" style={{ background: 'var(--surface)', borderLeft: '2px solid var(--border)', borderTop: '1px solid var(--border)' }}>
                      <span className={total ? 'font-semibold' : ''}>{kpi ? '' : fmtNum(yearVal(it.code))}</span>
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
