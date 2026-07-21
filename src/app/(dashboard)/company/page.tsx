'use client'

// 全社Core（経営者の右腕）: 全27宿を横断。単月/年度の表 ＋ 2軸クロス ＋ 灯の月次レポート。
// 権限=owner限定。PLは company-data 経由で宿ごとに pl-compute（宿別ページと数字一致）。
import { Fragment, useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { ScatterChart, Scatter, XAxis, YAxis, ZAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from 'recharts'
import { supabase } from '@/lib/supabase/client'
import { useFacility } from '@/lib/facility-context'
import { fetchAll } from '@/lib/supabase/fetch-all'
import { fmtNum, fmtMan, pct, CHART_AXIS } from '@/lib/ui'
import { Loading, Empty, LoadError } from '@/components/page-bits'
import { AssistantContent, SparkleIcon } from '@/components/ai-drawer'
import { loadMeetingReport, generateMeetingReport } from '@/lib/meeting-report'
import CompanyShiftVariance from '@/components/company-shift-variance'
import {
  loadCompanyData, aggregateScope, buildCompanyMaterial, loadCompanyAnnual,
  type CompanyDataset, type FacilityMetrics, type Triple,
  type CompanyAnnual, type FacilityAnnual,
} from '@/lib/company/company-data'
import { STORE_SCOPE_LABEL, type StoreScope, type FacilityClass } from '@/lib/company/facility-class'

type Cmp = 'budget' | 'yoy'   // 比較の相手（予算 / 前年）
type ViewMode = 'month' | 'year'
const CLS_LABEL: Record<FacilityClass, string> = { existing: '既存', new: '新', unknown: '—' }

/* ヒートマップ背景（良い=緑・悪い=赤、乖離で濃さ）。 */
function heatBg(dev: number | null): string | undefined {
  if (dev == null) return undefined
  const a = Math.min(0.24, Math.abs(dev))
  return dev >= 0 ? `rgba(34,197,94,${a})` : `rgba(239,68,68,${a})`
}
const rate = (a: number | null, b: number | null | undefined): number | null => (a != null && b ? a / b : null)
const signedMan = (v: number | null): string => (v == null ? '' : (v >= 0 ? '+' : '▲') + fmtMan(Math.abs(v)))
const CMP_LABEL: Record<Cmp, string> = { budget: '予算', yoy: '前年' }

/* ---- セル/カード（module-scope） ---- */
// 金額メトリクスセル: 実額 ＋ 選択した比較（予算 or 前年）＋ 差/比
function MoneyCell({ t, cmp, higherBetter = true }: { t: Triple; cmp: Cmp; higherBetter?: boolean }) {
  const compVal = cmp === 'budget' ? t.bud : t.prior
  const r = rate(t.act, compVal)
  const dev = r == null ? null : (r - 1) * (higherBetter ? 1 : -1)
  const diff = t.act != null && compVal != null ? t.act - compVal : null
  const rColor = r == null ? 'var(--text-dim)' : (r >= 1) === higherBetter ? 'var(--green)' : 'var(--red)'
  return (
    <td className="px-2.5 py-1.5 text-right whitespace-nowrap align-top" style={{ background: heatBg(dev), borderTop: '1px solid var(--border)' }}>
      <div className="font-medium">{t.act == null ? '—' : fmtMan(t.act)}</div>
      <div className="text-[10px]" style={{ color: 'var(--text-dim)' }}>{CMP_LABEL[cmp]} {compVal == null ? '—' : fmtMan(compVal)}</div>
      <div className="text-[10px]" style={{ color: rColor }}>{diff == null ? '—' : `${signedMan(diff)}${r != null ? ` / ${pct(r)}` : ''}`}</div>
    </td>
  )
}

// 年度一覧のコンパクトセル: 実額 ＋ 差(vs選択・小)。sep=宿の区切り(左太線)、strong=年間行(上太線)
function AnnualCell({ t, cmp, higherBetter = true, sep = false, strong = false }: { t: Triple; cmp: Cmp; higherBetter?: boolean; sep?: boolean; strong?: boolean }) {
  const compVal = cmp === 'budget' ? t.bud : t.prior
  const r = rate(t.act, compVal)
  const dev = r == null ? null : (r - 1) * (higherBetter ? 1 : -1)
  const diff = t.act != null && compVal != null ? t.act - compVal : null
  const rColor = r == null ? 'var(--text-dim)' : (r >= 1) === higherBetter ? 'var(--green)' : 'var(--red)'
  return (
    <td className="px-2 py-1 text-right whitespace-nowrap align-top" style={{ background: heatBg(dev), borderTop: strong ? '2px solid var(--border)' : '1px solid var(--border)', borderLeft: sep ? '2px solid var(--border)' : undefined }}>
      <div className="text-[12px]">{t.act == null ? '—' : fmtMan(t.act)}</div>
      <div className="text-[9px] leading-none" style={{ color: rColor }}>{diff == null ? '' : `${signedMan(diff)}${r != null ? ` ${pct(r)}` : ''}`}</div>
    </td>
  )
}

// 比率/スコアセル（スコープ平均比でヒート）
function StatCell({ v, avg, higherBetter, fmt }: { v: number | null; avg: number | null; higherBetter: boolean; fmt: (x: number) => string }) {
  const dev = v != null && avg ? ((v - avg) / avg) * (higherBetter ? 1 : -1) : null
  const diff = v != null && avg != null ? v - avg : null
  return (
    <td className="px-2.5 py-1.5 text-right whitespace-nowrap align-top" style={{ background: heatBg(dev), borderTop: '1px solid var(--border)' }}>
      <div className="font-medium">{v == null ? '—' : fmt(v)}</div>
      <div className="text-[10px]" style={{ color: 'var(--text-dim)' }}>{diff == null ? '' : `平均差 ${diff >= 0 ? '+' : ''}${fmt(diff)}`}</div>
    </td>
  )
}

// サマリKPIカード
function SummaryCard({ label, act, bud, prior, fmt, showYoY, higherBetter = true }:
  { label: string; act: number | null; bud: number | null; prior: number | null; fmt: (x: number) => string; showYoY: boolean; higherBetter?: boolean }) {
  const rB = rate(act, bud), rY = rate(act, prior)
  const c = (r: number | null) => (r == null ? 'var(--text-dim)' : (r >= 1) === higherBetter ? 'var(--green)' : 'var(--red)')
  return (
    <div className="card p-4">
      <div className="text-xs mb-1" style={{ color: 'var(--text-dim)' }}>{label}</div>
      <div className="text-xl font-bold">{act == null ? '—' : fmt(act)}</div>
      <div className="text-[11px] mt-1 flex gap-3">
        <span style={{ color: c(rB) }}>予算比 {rB == null ? '—' : pct(rB)}</span>
        {showYoY && <span style={{ color: c(rY) }}>前年比 {rY == null ? '—' : pct(rY)}</span>}
      </div>
    </div>
  )
}

// ④ 宿クリック → 各宿ビュー「概要」の灯の月次レポートを表示
function MonthlyReportModal({ m, month, onClose, onOpenFacility }:
  { m: FacilityMetrics; month: string; onClose: () => void; onOpenFacility: (facility: string, path: string) => void }) {
  const [report, setReport] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  useEffect(() => {
    let alive = true; setReport(''); setErr('')
    loadMeetingReport(m.facility, month).then((c) => { if (alive) setReport(c) }).catch(() => { /* 未生成は空 */ })
    return () => { alive = false }
  }, [m.facility, month])
  const gen = async () => {
    setBusy(true); setErr('')
    try { const { content, error } = await generateMeetingReport(m.facility, month); if (error) setErr(error); if (content) setReport(content) }
    catch (e) { setErr(e instanceof Error ? e.message : String(e)) } finally { setBusy(false) }
  }
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: 'rgba(0,0,0,0.45)' }} onClick={onClose}>
      <div className="card w-full max-w-2xl overflow-auto" style={{ maxHeight: '88vh' }} onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between p-5 pb-3" style={{ borderBottom: '1px solid var(--border)' }}>
          <div>
            <div className="text-lg font-semibold">{m.name}</div>
            <div className="text-xs" style={{ color: 'var(--text-dim)' }}>
              {m.facilityType ?? 'タイプ未設定'} ・ {m.cls === 'existing' ? '既存店' : m.cls === 'new' ? '新店' : '区分不明'}
            </div>
          </div>
          <button onClick={onClose} className="text-sm px-2 py-1 rounded hover:opacity-70" style={{ color: 'var(--text-dim)' }}>✕</button>
        </div>
        <div className="p-5 space-y-4">
          <div className="flex items-center gap-2">
            <SparkleIcon size={16} />
            <h3 className="text-sm font-semibold">灯の月次レポート（{month}）</h3>
            <button onClick={gen} disabled={busy} className="ml-auto text-xs px-3 py-1 rounded-md text-white disabled:opacity-50" style={{ background: 'var(--accent)' }}>
              {busy ? '生成中…' : report ? '↻ 再生成' : '生成'}
            </button>
          </div>
          {err && <p className="text-sm" style={{ color: 'var(--red)' }}>生成エラー: {err}</p>}
          {busy ? (
            <p className="text-sm" style={{ color: 'var(--text-dim)' }}>灯が{m.name}の{month}を読んでレポートを編んでいます…</p>
          ) : report ? (
            <AssistantContent content={report} />
          ) : (
            <p className="text-sm" style={{ color: 'var(--text-dim)' }}>「生成」で、灯がこの宿の実績・クチコミ・生産性・先月の取組の効果・課題と次の一手を一枚にまとめます（概要の月次レポートと同一）。</p>
          )}
          <div className="flex gap-2 pt-1" style={{ borderTop: '1px solid var(--border)' }}>
            <button onClick={() => onOpenFacility(m.facility, '/')} className="mt-3 px-4 py-1.5 rounded-md text-sm text-white" style={{ background: 'var(--accent)' }}>この宿の概要を開く</button>
            <button onClick={() => onOpenFacility(m.facility, '/yojitsu')} className="mt-3 px-4 py-1.5 rounded-md text-sm" style={{ background: 'var(--surface2)', color: 'var(--text)' }}>予実（PL）を開く</button>
          </div>
        </div>
      </div>
    </div>
  )
}

/* G5: 2軸クロス分析 */
type AxisDef = { key: string; label: string; get: (m: FacilityMetrics) => number | null; fmt: (v: number) => string }
const AXES: AxisDef[] = [
  { key: 'satisfaction', label: '満足度', get: (m) => m.satisfaction, fmt: (v) => v.toFixed(2) },
  { key: 'guestUnit', label: '客単価', get: (m) => m.guestUnit, fmt: (v) => `¥${fmtNum(v)}` },
  { key: 'laborRatio', label: '人件費率', get: (m) => rate(m.labor.act, m.sales.act), fmt: pct },
  { key: 'budgetRate', label: '予算達成率(売上)', get: (m) => rate(m.sales.act, m.sales.bud), fmt: pct },
  { key: 'yoyRate', label: '前年比(売上)', get: (m) => rate(m.sales.act, m.sales.prior), fmt: pct },
  { key: 'occ', label: 'OCC(稼働率)', get: (m) => m.occ, fmt: pct },
  { key: 'oiRate', label: '営業利益率', get: (m) => rate(m.operatingIncome.act, m.sales.act), fmt: pct },
  { key: 'prod', label: '生産性(人時売上)', get: (m) => rate(m.revenue, m.workHours), fmt: (v) => `¥${fmtNum(v)}` },
]
const PRESETS: { label: string; x: string; y: string }[] = [
  { label: '満足度 × 客単価', x: 'satisfaction', y: 'guestUnit' },
  { label: '満足度 × 人件費率', x: 'satisfaction', y: 'laborRatio' },
  { label: '予算達成率 × 前年比', x: 'budgetRate', y: 'yoyRate' },
]
const TYPE_COLORS: Record<string, string> = {
  '小規模旅館': '#D85A30', '温泉旅館': '#1D9E75', '小規模都市型ホテル': '#378ADD', '中規模旅館': '#7F77DD',
  '都市型ホテル': '#D4537E', '高級旅館': '#c9a227', '大規模旅館': '#5AB3A6',
}
const typeColor = (t: string) => TYPE_COLORS[t] ?? '#888780'

/* eslint-disable @typescript-eslint/no-explicit-any */
function ScatterTip({ active, payload }: any) {
  if (!active || !payload?.length) return null
  const p = payload[0].payload
  return (
    <div className="text-xs px-2.5 py-1.5 rounded" style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}>
      <div className="font-medium">{p.name}</div>
      <div style={{ color: 'var(--text-dim)' }}>{p.type}</div>
      <div>{p.xLabel}: {p.xf}</div>
      <div>{p.yLabel}: {p.yf}</div>
      <div style={{ color: 'var(--text-dim)' }}>売上: {p.z == null ? '—' : fmtMan(p.z)}</div>
    </div>
  )
}

function CrossAnalysis({ rows }: { rows: FacilityMetrics[] }) {
  const [xKey, setXKey] = useState('satisfaction')
  const [yKey, setYKey] = useState('guestUnit')
  const xAxis = AXES.find((a) => a.key === xKey) ?? AXES[0]
  const yAxis = AXES.find((a) => a.key === yKey) ?? AXES[1]
  const groups = useMemo(() => {
    const g: Record<string, any[]> = {}
    for (const m of rows) {
      const xv = xAxis.get(m), yv = yAxis.get(m)
      if (xv == null || yv == null) continue
      const t = m.facilityType ?? '未設定'
      ;(g[t] ??= []).push({ x: xv, y: yv, z: m.sales.act, name: m.name, type: t, xf: xAxis.fmt(xv), yf: yAxis.fmt(yv), xLabel: xAxis.label, yLabel: yAxis.label })
    }
    return g
  }, [rows, xAxis, yAxis])
  const plotted = Object.values(groups).reduce((s, a) => s + a.length, 0)
  return (
    <div className="card p-4 mt-6">
      <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
        <div className="text-sm font-semibold">2軸クロス分析</div>
        <div className="flex items-center gap-2 flex-wrap">
          {PRESETS.map((p) => (
            <button key={p.label} onClick={() => { setXKey(p.x); setYKey(p.y) }}
              className="text-[11px] px-2 py-1 rounded" style={{ background: xKey === p.x && yKey === p.y ? 'var(--accent)' : 'var(--surface2)', color: xKey === p.x && yKey === p.y ? '#fff' : 'var(--text-dim)' }}>
              {p.label}
            </button>
          ))}
          <span className="text-[11px]" style={{ color: 'var(--text-dim)' }}>X</span>
          <select className="field px-2 py-1 text-xs" value={xKey} onChange={(e) => setXKey(e.target.value)}>
            {AXES.map((a) => <option key={a.key} value={a.key}>{a.label}</option>)}
          </select>
          <span className="text-[11px]" style={{ color: 'var(--text-dim)' }}>Y</span>
          <select className="field px-2 py-1 text-xs" value={yKey} onChange={(e) => setYKey(e.target.value)}>
            {AXES.map((a) => <option key={a.key} value={a.key}>{a.label}</option>)}
          </select>
        </div>
      </div>
      {plotted === 0 ? (
        <p className="text-sm py-8 text-center" style={{ color: 'var(--text-dim)' }}>この2軸で描画できる宿がありません（データ欠損）。別の軸をお試しください。</p>
      ) : (
        <ResponsiveContainer width="100%" height={340}>
          <ScatterChart margin={{ top: 10, right: 16, bottom: 24, left: 8 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#efe6d6" />
            <XAxis type="number" dataKey="x" name={xAxis.label} {...CHART_AXIS} tickFormatter={xAxis.fmt}
              label={{ value: xAxis.label, position: 'insideBottom', offset: -12, fill: '#927e6a', fontSize: 11 }} />
            <YAxis type="number" dataKey="y" name={yAxis.label} {...CHART_AXIS} tickFormatter={yAxis.fmt}
              label={{ value: yAxis.label, angle: -90, position: 'insideLeft', fill: '#927e6a', fontSize: 11 }} width={64} />
            <ZAxis type="number" dataKey="z" range={[60, 460]} name="売上" />
            <Tooltip cursor={{ strokeDasharray: '3 3' }} content={<ScatterTip />} />
            <Legend wrapperStyle={{ fontSize: 11 }} />
            {Object.entries(groups).map(([t, data]) => (
              <Scatter key={t} name={t} data={data} fill={typeColor(t)} fillOpacity={0.75} />
            ))}
          </ScatterChart>
        </ResponsiveContainer>
      )}
      <p className="text-[11px] mt-2" style={{ color: 'var(--text-dim)' }}>
        バブル=宿（色=宿タイプ・大きさ=売上）。例: 満足度が高いのに客単価が低い＝価値を価格化できていない伸びしろ。
      </p>
    </div>
  )
}

/* ③ 年度一覧（縦=月・横=宿×[売上,営業利益]） */
function AnnualTable({ annual, scope, cmp }: { annual: CompanyAnnual; scope: StoreScope; cmp: Cmp }) {
  const facs = annual.facilities.filter((f) => (scope === 'all' ? true : f.cls === scope))
  const mLabel = (m: string) => `${+m.slice(5, 7)}月`
  return (
    <div className="card overflow-auto" style={{ maxHeight: 'calc(100vh - 220px)' }}>
      <table className="text-sm border-separate" style={{ borderSpacing: 0 }}>
        <thead>
          <tr style={{ color: 'var(--text-dim)' }}>
            <th rowSpan={2} className="px-3 py-2 text-left whitespace-nowrap sticky left-0 top-0 z-30 align-bottom" style={{ background: 'var(--surface2)', borderRight: '2px solid var(--border)' }}>月</th>
            {facs.map((f) => (
              <th key={f.facility} colSpan={2} className="px-2 py-2 text-center whitespace-nowrap sticky top-0 z-20" style={{ background: 'var(--surface2)', borderLeft: '2px solid var(--border)' }}>
                {f.name}<span className="ml-1 text-[9px]" style={{ color: 'var(--text-dim)' }}>{CLS_LABEL[f.cls]}</span>
              </th>
            ))}
          </tr>
          <tr style={{ color: 'var(--text-dim)' }} className="text-[11px]">
            {facs.map((f) => (
              <Fragment key={f.facility}>
                <th className="px-2 py-1 text-right whitespace-nowrap sticky z-20" style={{ top: 33, background: 'var(--surface2)', borderLeft: '2px solid var(--border)' }}>売上</th>
                <th className="px-2 py-1 text-right whitespace-nowrap sticky z-20" style={{ top: 33, background: 'var(--surface2)' }}>営業利益</th>
              </Fragment>
            ))}
          </tr>
        </thead>
        <tbody>
          {annual.months.map((m, i) => (
            <tr key={m}>
              <td className="px-3 py-1 whitespace-nowrap sticky left-0 z-10 font-medium" style={{ background: 'var(--surface)', borderRight: '2px solid var(--border)', borderTop: '1px solid var(--border)' }}>{mLabel(m)}</td>
              {facs.map((f) => (
                <Fragment key={f.facility}>
                  <AnnualCell t={f.months[i].sales} cmp={cmp} sep />
                  <AnnualCell t={f.months[i].oi} cmp={cmp} />
                </Fragment>
              ))}
            </tr>
          ))}
          <tr className="font-semibold">
            <td className="px-3 py-1.5 whitespace-nowrap sticky left-0 z-10" style={{ background: 'var(--surface2)', borderRight: '2px solid var(--border)', borderTop: '2px solid var(--border)' }}>年間</td>
            {facs.map((f) => (
              <Fragment key={f.facility}>
                <AnnualCell t={f.totalSales} cmp={cmp} sep strong />
                <AnnualCell t={f.totalOi} cmp={cmp} strong />
              </Fragment>
            ))}
          </tr>
        </tbody>
      </table>
    </div>
  )
}

export default function CompanyPage() {
  // ---- 権限（owner限定） ----
  const [role, setRole] = useState<string | null>(null)
  const [roleLoading, setRoleLoading] = useState(true)
  useEffect(() => {
    ;(async () => {
      try {
        const { data: { user } } = await supabase.auth.getUser()
        if (user) {
          const { data: au } = await supabase.from('app_user').select('role').eq('user_id', user.id).maybeSingle()
          setRole(au?.role ?? null)
        }
      } catch { setRole(null) } finally { setRoleLoading(false) }
    })()
  }, [])
  const isOwner = role === 'owner'
  const router = useRouter()
  const { setCurrent } = useFacility()

  // ---- データ ----
  const [months, setMonths] = useState<string[]>([])
  const [month, setMonth] = useState('')
  const [ds, setDs] = useState<CompanyDataset | null>(null)
  const [scope, setScope] = useState<StoreScope>('all')
  const [cmp, setCmp] = useState<Cmp>('budget')          // 比較の相手（予算/前年）
  const [viewMode, setViewMode] = useState<ViewMode>('month')
  const [sortKey, setSortKey] = useState<string>('sales')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc')
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [selected, setSelected] = useState<FacilityMetrics | null>(null)
  const openFacility = (facility: string, path: string) => { setCurrent(facility); router.push(path) }

  // 年度一覧
  const fyNum = month ? (Number(month.slice(5, 7)) >= 4 ? Number(month.slice(0, 4)) : Number(month.slice(0, 4)) - 1) : null
  const [annual, setAnnual] = useState<CompanyAnnual | null>(null)
  const [annualLoading, setAnnualLoading] = useState(false)
  useEffect(() => {
    if (!isOwner || viewMode !== 'year' || fyNum == null) return
    setAnnualLoading(true)
    loadCompanyAnnual(supabase, fyNum).then(setAnnual).catch(() => setAnnual(null)).finally(() => setAnnualLoading(false))
  }, [isOwner, viewMode, fyNum])

  // 灯（全社モード）所見
  const [insight, setInsight] = useState('')
  const [insightAt, setInsightAt] = useState<string | null>(null)
  const [insightBusy, setInsightBusy] = useState(false)
  const [insightErr, setInsightErr] = useState('')
  const authHeader = async (): Promise<Record<string, string>> => {
    const { data: { session } } = await supabase.auth.getSession()
    return { 'Content-Type': 'application/json', ...(session ? { Authorization: `Bearer ${session.access_token}` } : {}) }
  }
  useEffect(() => {
    if (!isOwner || !month) return
    setInsight(''); setInsightErr(''); setInsightAt(null)
    ;(async () => {
      try {
        const res = await fetch('/api/company-insight', { method: 'POST', headers: await authHeader(), body: JSON.stringify({ month }) })
        const d = await res.json()
        if (d.content) { setInsight(d.content); setInsightAt(d.updatedAt ?? null) }
      } catch { /* 生成ボタンで再取得可 */ }
    })()
  }, [isOwner, month])
  const genInsight = async () => {
    if (!ds) return
    setInsightBusy(true); setInsightErr('')
    try {
      const material = buildCompanyMaterial(ds)
      const res = await fetch('/api/company-insight', { method: 'POST', headers: await authHeader(), body: JSON.stringify({ month, material, force: true }) })
      const d = await res.json()
      if (d.error) setInsightErr(d.error)
      if (d.content) { setInsight(d.content); setInsightAt(new Date().toISOString()) }
    } catch (e) { setInsightErr(e instanceof Error ? e.message : String(e)) }
    finally { setInsightBusy(false) }
  }

  // 対象月リスト
  useEffect(() => {
    if (!isOwner) return
    ;(async () => {
      try {
        const rows = await fetchAll(() => supabase.from('mart_monthly_kpi').select('month'))
        const ms = [...new Set(((rows as { month: string }[]) ?? []).map((r) => r.month))].sort().reverse()
        setMonths(ms)
        if (ms.length) setMonth((m) => (m && ms.includes(m) ? m : ms[0]))
      } catch (e) { setLoadError(e instanceof Error ? e.message : String(e)) }
    })()
  }, [isOwner])

  useEffect(() => {
    if (!isOwner || !month) return
    setLoading(true)
    loadCompanyData(supabase, month)
      .then(setDs)
      .catch((e: unknown) => setLoadError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false))
  }, [isOwner, month])

  const agg = useMemo(() => (ds ? aggregateScope(ds, scope) : null), [ds, scope])
  const showYoY = scope !== 'new'
  const rows = useMemo(() => {
    if (!ds) return []
    return ds.facilities.filter((m) => (scope === 'all' ? true : m.cls === scope))
  }, [ds, scope])

  type Col = { key: string; label: string; sortVal: (m: FacilityMetrics) => number | null }
  const cols: Col[] = useMemo(() => [
    { key: 'sales', label: '売上', sortVal: (m) => (cmp === 'budget' ? rate(m.sales.act, m.sales.bud) : rate(m.sales.act, m.sales.prior)) },
    { key: 'oi', label: '営業利益', sortVal: (m) => (cmp === 'budget' ? rate(m.operatingIncome.act, m.operatingIncome.bud) : rate(m.operatingIncome.act, m.operatingIncome.prior)) },
    { key: 'gop', label: 'GOP', sortVal: (m) => (cmp === 'budget' ? rate(m.gop.act, m.gop.bud) : rate(m.gop.act, m.gop.prior)) },
    { key: 'laborRatio', label: '人件費率', sortVal: (m) => rate(m.labor.act, m.sales.act) },
    { key: 'prod', label: '生産性', sortVal: (m) => rate(m.revenue, m.workHours) },
    { key: 'sat', label: '満足度', sortVal: (m) => m.satisfaction },
  ], [cmp])

  const sortedRows = useMemo(() => {
    const col = cols.find((c) => c.key === sortKey) ?? cols[0]
    const dir = sortDir === 'asc' ? 1 : -1
    return [...rows].sort((a, b) => {
      const va = col.sortVal(a), vb = col.sortVal(b)
      if (va == null && vb == null) return 0
      if (va == null) return 1
      if (vb == null) return -1
      return (va - vb) * dir
    })
  }, [rows, cols, sortKey, sortDir])

  const clickSort = (key: string) => {
    if (sortKey === key) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
    else { setSortKey(key); setSortDir(key === 'laborRatio' ? 'asc' : 'desc') }
  }

  const avgLaborRatio = agg?.laborRatio ?? null
  const avgProd = agg?.revenuePerHour ?? null
  const avgSat = agg?.satisfaction ?? null

  if (roleLoading) return <div className="p-6"><Loading /></div>
  if (!isOwner) return (
    <div className="p-6">
      <div className="card p-6 text-sm" style={{ color: 'var(--text-dim)' }}>
        この画面（全社Core）は<strong>オーナーのみ</strong>が利用できます。宿別の分析は左メニューからご利用ください。
      </div>
    </div>
  )

  return (
    <div className="p-6">
      {/* コントロール */}
      <div className="flex items-center gap-2 flex-wrap mb-4">
        {/* 単月 / 年度 */}
        <div className="flex rounded-md overflow-hidden" style={{ border: '1px solid var(--border)' }}>
          {(['month', 'year'] as ViewMode[]).map((v) => (
            <button key={v} onClick={() => setViewMode(v)} className="px-3 py-1.5 text-xs"
              style={{ background: viewMode === v ? 'var(--accent)' : 'var(--surface)', color: viewMode === v ? '#fff' : 'var(--text-dim)' }}>
              {v === 'month' ? '単月' : '年度一覧'}
            </button>
          ))}
        </div>
        {/* スコープ */}
        <div className="flex rounded-md overflow-hidden" style={{ border: '1px solid var(--border)' }}>
          {(['all', 'existing', 'new'] as StoreScope[]).map((s) => (
            <button key={s} onClick={() => setScope(s)} className="px-3 py-1.5 text-xs"
              style={{ background: scope === s ? 'var(--accent)' : 'var(--surface)', color: scope === s ? '#fff' : 'var(--text-dim)' }}>
              {STORE_SCOPE_LABEL[s]}
            </button>
          ))}
        </div>
        {/* 比較の相手 */}
        <span className="text-xs" style={{ color: 'var(--text-dim)' }}>比較:</span>
        <div className="flex rounded-md overflow-hidden" style={{ border: '1px solid var(--border)' }}>
          {(['budget', 'yoy'] as Cmp[]).map((c) => (
            <button key={c} onClick={() => setCmp(c)} className="px-3 py-1.5 text-xs"
              style={{ background: cmp === c ? 'var(--accent)' : 'var(--surface)', color: cmp === c ? '#fff' : 'var(--text-dim)' }}>
              {c === 'budget' ? '予算' : '前年'}
            </button>
          ))}
        </div>
        {months.length > 0 && (
          <select className="field px-3 py-1.5 text-sm" value={month} onChange={(e) => setMonth(e.target.value)}>
            {months.map((m) => <option key={m} value={m}>{viewMode === 'year' ? `${m.slice(0, 4)}年度を含む` : m}</option>)}
          </select>
        )}
        {viewMode === 'month' && agg && <span className="text-xs" style={{ color: 'var(--text-dim)' }}>{STORE_SCOPE_LABEL[scope]} {agg.count}宿</span>}
      </div>

      {loading ? <Loading /> : loadError ? <LoadError message={loadError} /> : !ds || ds.facilities.length === 0 ? (
        <Empty message="全社データがありません。PL・売上実績の取込状況をご確認ください。" />
      ) : viewMode === 'year' ? (
        /* ③ 年度一覧 */
        <>
          <div className="flex items-center justify-between mb-2">
            <div className="text-sm font-semibold">年度一覧（{fyNum}年度・{cmp === 'budget' ? '予算比' : '前年比'}）</div>
            <div className="text-[11px]" style={{ color: 'var(--text-dim)' }}>縦=月／横=宿の売上・営業利益。各セル: 実績 ＋ {cmp === 'budget' ? '予算' : '前年'}との差/比（緑=上回り・赤=下回り）。</div>
          </div>
          {annualLoading || !annual ? <Loading /> : <AnnualTable annual={annual} scope={scope} cmp={cmp} />}
          <p className="text-xs mt-2" style={{ color: 'var(--text-dim)' }}>金額=万円。売上/営業利益は宿ごとにPL明細から再計算（予実ページと同一）。「比較」で予算/前年を切替えられます。</p>
        </>
      ) : (
        /* 単月 */
        <>
          {/* 灯（全社モード）の所見 */}
          <div className="card p-4 mb-6">
            <div className="flex items-center justify-between mb-2 gap-2">
              <div className="text-sm font-semibold">灯（全社モード）の所見</div>
              <button onClick={genInsight} disabled={insightBusy || !ds}
                className="px-3 py-1.5 rounded-md text-xs text-white disabled:opacity-50" style={{ background: 'var(--accent)' }}>
                {insightBusy ? '生成中…' : insight ? '再生成' : '生成'}
              </button>
            </div>
            {insightErr && <p className="text-xs mb-2" style={{ color: 'var(--red)' }}>{insightErr}</p>}
            {insight ? <AssistantContent content={insight} />
              : !insightBusy && <p className="text-sm" style={{ color: 'var(--text-dim)' }}>「生成」で、灯が全社を読んで“注力すべき宿と理由”をまとめます（予算対比・前年対比の両面から）。</p>}
            {insightAt && <p className="text-[10px] mt-2" style={{ color: 'var(--text-dim)' }}>最終生成: {insightAt.slice(0, 16).replace('T', ' ')}</p>}
          </div>

          {/* サマリKPI（NPS除く） */}
          {agg && (
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3 mb-6">
              <SummaryCard label="売上" act={agg.sales.act} bud={agg.sales.bud} prior={agg.sales.prior} fmt={fmtMan} showYoY={showYoY} />
              <SummaryCard label="営業利益" act={agg.operatingIncome.act} bud={agg.operatingIncome.bud} prior={agg.operatingIncome.prior} fmt={fmtMan} showYoY={showYoY} />
              <SummaryCard label="GOP" act={agg.gop.act} bud={agg.gop.bud} prior={agg.gop.prior} fmt={fmtMan} showYoY={showYoY} />
              <SummaryCard label="OCC（稼働率）" act={agg.occ} bud={null} prior={null} fmt={pct} showYoY={showYoY} />
              <SummaryCard label="満足度" act={agg.satisfaction} bud={null} prior={null} fmt={(x) => x.toFixed(2)} showYoY={showYoY} />
            </div>
          )}

          {/* 宿ヒートマップ */}
          <div className="flex items-center justify-between mb-2">
            <div className="text-sm font-semibold">宿ヒートマップ</div>
            <div className="text-[11px]" style={{ color: 'var(--text-dim)' }}>
              各セル: 実額 ／ {cmp === 'budget' ? '予算' : '前年'} ／ 差・比。列見出しクリックでソート・行クリックで灯の月次レポート。
            </div>
          </div>
          <div className="card overflow-auto" style={{ maxHeight: 'calc(100vh - 280px)' }}>
            <table className="w-full text-sm border-separate" style={{ borderSpacing: 0 }}>
              <thead>
                <tr style={{ color: 'var(--text-dim)' }}>
                  <th className="px-3 py-2.5 text-left whitespace-nowrap sticky left-0 top-0 z-30" style={{ background: 'var(--surface2)', borderRight: '2px solid var(--border)' }}>宿</th>
                  {cols.map((c) => (
                    <th key={c.key} onClick={() => clickSort(c.key)}
                      className="px-2.5 py-2.5 text-right whitespace-nowrap sticky top-0 z-20 cursor-pointer select-none"
                      style={{ background: 'var(--surface2)', minWidth: 96 }}>
                      {c.label}{sortKey === c.key && <span className="ml-0.5 text-[10px]">{sortDir === 'asc' ? '▲' : '▼'}</span>}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {sortedRows.map((m) => (
                  <tr key={m.facility} onClick={() => setSelected(m)} className="cursor-pointer hover:opacity-90">
                    <td className="px-3 py-1.5 whitespace-nowrap sticky left-0 z-10" style={{ background: 'var(--surface)', borderRight: '2px solid var(--border)', borderTop: '1px solid var(--border)' }}>
                      <span className="font-medium">{m.name}</span>
                      <span className="ml-1.5 text-[9px] px-1 py-0.5 rounded" style={{ background: 'var(--surface2)', color: 'var(--text-dim)' }}>{CLS_LABEL[m.cls]}</span>
                      {m.facilityType && <div className="text-[10px]" style={{ color: 'var(--text-dim)' }}>{m.facilityType}</div>}
                    </td>
                    <MoneyCell t={m.sales} cmp={cmp} />
                    <MoneyCell t={m.operatingIncome} cmp={cmp} />
                    <MoneyCell t={m.gop} cmp={cmp} />
                    <StatCell v={rate(m.labor.act, m.sales.act)} avg={avgLaborRatio} higherBetter={false} fmt={pct} />
                    <StatCell v={rate(m.revenue, m.workHours)} avg={avgProd} higherBetter fmt={(x) => `¥${fmtNum(x)}`} />
                    <StatCell v={m.satisfaction} avg={avgSat} higherBetter fmt={(x) => x.toFixed(2)} />
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <CrossAnalysis rows={rows} />

          <p className="text-xs mt-2" style={{ color: 'var(--text-dim)' }}>
            金額=万円。売上/営業利益/GOPは宿ごとにPL明細から再計算（予実ページと同一）。人件費率=人件費(PL)÷売上、生産性=売上÷総労働時間、OCC=全日ベース。
            満足度=クチコミ総合(3ヶ月平滑)。人件費率・生産性・満足度の色はスコープ平均比。
          </p>

          <CompanyShiftVariance />
        </>
      )}

      {selected && (
        <MonthlyReportModal m={selected} month={month} onClose={() => setSelected(null)} onOpenFacility={openFacility} />
      )}
    </div>
  )
}
