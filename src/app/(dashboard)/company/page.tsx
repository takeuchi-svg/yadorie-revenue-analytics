'use client'

// 全社Core（経営者の右腕）: 全27宿を横断。(A)サマリKPI +(B)宿ヒートマップ。
// 権限=owner限定（ページ側ガード＋サイドバーもowner出し分け。実データ保護はDBのRLS）。
// PLは company-data 経由で宿ごとに pl-compute を適用 → 宿別ページ(yojitsu)と数字一致。
import { useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { ScatterChart, Scatter, XAxis, YAxis, ZAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from 'recharts'
import { supabase } from '@/lib/supabase/client'
import { useFacility } from '@/lib/facility-context'
import { fetchAll } from '@/lib/supabase/fetch-all'
import { fmtNum, fmtMan, pct, CHART_AXIS } from '@/lib/ui'
import { Loading, Empty, LoadError } from '@/components/page-bits'
import { AssistantContent } from '@/components/ai-drawer'
import {
  loadCompanyData, aggregateScope, detectAnomalies, loadFacilityQualitative, buildCompanyMaterial,
  type CompanyDataset, type FacilityMetrics, type Triple, type ScopeAggregate,
  type FacilityQualitative,
} from '@/lib/company/company-data'
import { STORE_SCOPE_LABEL, type StoreScope, type FacilityClass } from '@/lib/company/facility-class'

type ColorMode = 'budget' | 'yoy'
const CLS_LABEL: Record<FacilityClass, string> = { existing: '既存', new: '新', unknown: '—' }

/* ヒートマップ背景（良い=緑・悪い=赤、乖離で濃さ）。rgbaなのでライト/ダーク両対応。 */
function heatBg(dev: number | null): string | undefined {
  if (dev == null) return undefined
  const a = Math.min(0.24, Math.abs(dev))
  return dev >= 0 ? `rgba(34,197,94,${a})` : `rgba(239,68,68,${a})`
}
const rate = (a: number | null, b: number | null | undefined): number | null => (a != null && b ? a / b : null)
const signedMan = (v: number | null): string => (v == null ? '' : (v >= 0 ? '+' : '▲') + fmtMan(Math.abs(v)))

/* ---- セル/カード（module-scope。render内定義だと再マウントするため外出し） ---- */
// 金額メトリクスセル（実額 + 予算比 + 前年比、colorModeで着色）
function MoneyCell({ t, colorMode, showYoY, higherBetter = true }: { t: Triple; colorMode: ColorMode; showYoY: boolean; higherBetter?: boolean }) {
  const rB = rate(t.act, t.bud), rY = rate(t.act, t.prior)
  const activeRate = colorMode === 'budget' ? rB : rY
  const dev = activeRate == null ? null : (activeRate - 1) * (higherBetter ? 1 : -1)
  const diffB = t.act != null && t.bud != null ? t.act - t.bud : null
  const diffY = t.act != null && t.prior != null ? t.act - t.prior : null
  const rColor = (r: number | null) => (r == null ? 'var(--text-dim)' : (r >= 1) === higherBetter ? 'var(--green)' : 'var(--red)')
  return (
    <td className="px-2.5 py-1.5 text-right whitespace-nowrap align-top" style={{ background: heatBg(dev), borderTop: '1px solid var(--border)' }}>
      <div className="font-medium">{t.act == null ? '—' : fmtMan(t.act)}</div>
      <div className="text-[10px]" style={{ color: rColor(rB) }}>予 {signedMan(diffB)}{rB != null && ` / ${pct(rB)}`}</div>
      {showYoY && <div className="text-[10px]" style={{ color: rColor(rY) }}>前 {rY == null ? '—' : `${signedMan(diffY)} / ${pct(rY)}`}</div>}
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

// 定性フィールド1件（空なら描画しない）
function QualField({ label, v }: { label: string; v: string | null }) {
  if (!v || !v.trim()) return null
  return <div className="mb-2"><div className="text-[10px]" style={{ color: 'var(--text-dim)' }}>{label}</div><div className="text-sm">{v}</div></div>
}

// G4: 課題宿ドリルダウン（1段目=数字の自動異常 / 2段目=定性背景 / 宿別ページへ導線）
function DrilldownModal({ m, agg, showYoY, qual, qualLoading, onClose, onOpenFacility }:
  { m: FacilityMetrics; agg: ScopeAggregate; showYoY: boolean; qual: FacilityQualitative | null; qualLoading: boolean
    onClose: () => void; onOpenFacility: (facility: string, path: string) => void }) {
  const anomalies = detectAnomalies(m, agg, showYoY)
  const barColor = (b: number) => (b >= 0.5 ? 'var(--red)' : b >= 0.2 ? '#BA7517' : 'var(--text-dim)')
  const hasQual = qual && (qual.managementPolicy || qual.ngItems || qual.seasonalPolicy || qual.coreValue || qual.initiatives.length || qual.topics.length)
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: 'rgba(0,0,0,0.45)' }} onClick={onClose}>
      <div className="card w-full max-w-2xl overflow-auto" style={{ maxHeight: '86vh' }} onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between p-5 pb-3" style={{ borderBottom: '1px solid var(--border)' }}>
          <div>
            <div className="text-lg font-semibold">{m.name}</div>
            <div className="text-xs" style={{ color: 'var(--text-dim)' }}>
              {m.facilityType ?? 'タイプ未設定'} ・ {m.cls === 'existing' ? '既存店' : m.cls === 'new' ? '新店' : '区分不明'}
            </div>
          </div>
          <button onClick={onClose} className="text-sm px-2 py-1 rounded hover:opacity-70" style={{ color: 'var(--text-dim)' }}>✕</button>
        </div>

        <div className="p-5 space-y-5">
          {/* 1段目: 数字の注目ポイント */}
          <div>
            <div className="text-sm font-semibold mb-1">数字の注目ポイント</div>
            <p className="text-[11px] mb-2" style={{ color: 'var(--text-dim)' }}>全社平均・予算・前年と比べて、いま目が向くところです（悪化順）。</p>
            {anomalies.length === 0 ? (
              <p className="text-sm p-3 rounded" style={{ background: 'var(--surface2)', color: 'var(--text-dim)' }}>予算・前年・全社平均を下回る指標は見当たりません。堅調です。</p>
            ) : (
              <div className="space-y-1.5">
                {anomalies.map((a, i) => (
                  <div key={i} className="flex items-start gap-2 p-2 rounded" style={{ background: 'var(--surface2)', borderLeft: `3px solid ${barColor(a.badness)}` }}>
                    <div>
                      <div className="text-sm font-medium">{a.label}</div>
                      <div className="text-[11px]" style={{ color: 'var(--text-dim)' }}>{a.detail}</div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* 2段目: 定性背景 */}
          <div>
            <div className="text-sm font-semibold mb-1">背景（現場の意図・取組・お客様の声）</div>
            {qualLoading ? (
              <p className="text-sm" style={{ color: 'var(--text-dim)' }}>読み込み中...</p>
            ) : !hasQual ? (
              <p className="text-sm p-3 rounded" style={{ background: 'var(--surface2)', color: 'var(--text-dim)' }}>定性情報は未登録です。宿プロフィール・取組履歴を記録すると、数字の背景が結びつきます。</p>
            ) : (
              <div>
                <QualField label="中核価値" v={qual!.coreValue} />
                <QualField label="支配人の運営方針" v={qual!.managementPolicy} />
                <QualField label="避けたいこと・NG（打ち手の制約）" v={qual!.ngItems} />
                <QualField label="季節ごとの方針" v={qual!.seasonalPolicy} />
                {qual!.initiatives.length > 0 && (
                  <div className="mb-2">
                    <div className="text-[10px]" style={{ color: 'var(--text-dim)' }}>直近の取組履歴</div>
                    <ul className="text-sm space-y-0.5 mt-0.5">
                      {qual!.initiatives.map((it, i) => (
                        <li key={i}>・<span style={{ color: 'var(--text-dim)' }}>{it.yearMonth}</span> [{it.category ?? '-'}{it.status && it.status !== '実行' ? `/${it.status}` : ''}] {it.title}{it.description ? `：${it.description}` : ''}</li>
                      ))}
                    </ul>
                  </div>
                )}
                {qual!.topics.length > 0 && (
                  <div className="mb-1">
                    <div className="text-[10px]" style={{ color: 'var(--text-dim)' }}>クチコミ改善トピック（ネガ言及の多い順）</div>
                    <div className="flex flex-wrap gap-1.5 mt-1">
                      {qual!.topics.map((t, i) => (
                        <span key={i} className="text-xs px-2 py-0.5 rounded" style={{ background: 'var(--surface2)' }}>{t.label} <span style={{ color: 'var(--red)' }}>{t.negative}</span></span>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* 導線: 宿別ページへ */}
          <div className="flex gap-2 pt-1">
            <button onClick={() => onOpenFacility(m.facility, '/yojitsu')}
              className="px-4 py-1.5 rounded-md text-sm text-white" style={{ background: 'var(--accent)' }}>この宿の予実（PL）を開く</button>
            <button onClick={() => onOpenFacility(m.facility, '/')}
              className="px-4 py-1.5 rounded-md text-sm" style={{ background: 'var(--surface2)', color: 'var(--text)' }}>概要を開く</button>
          </div>
        </div>
      </div>
    </div>
  )
}

// G5: 2軸クロス分析（散布図・宿タイプ色分け）
// 軸メトリクス定義（get=宿からの値, fmt=表示）
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
  { key: 'nps', label: 'NPS', get: (m) => m.nps, fmt: (v) => v.toFixed(1) },
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
        バブル=宿（色=宿タイプ・大きさ=売上）。例: 満足度が高いのに客単価が低い＝価値を価格化できていない伸びしろ。満足度×人件費率＝効率化しすぎてサービスが痩せていないか。
      </p>
    </div>
  )
}

export default function CompanyPage() {
  // ---- 権限（owner限定。/knowledge と同じく自前で role を確定） ----
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
  const [colorMode, setColorMode] = useState<ColorMode>('budget')
  const [sortKey, setSortKey] = useState<string>('sales')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc')
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  // G4 ドリルダウン
  const [selected, setSelected] = useState<FacilityMetrics | null>(null)
  const [qual, setQual] = useState<FacilityQualitative | null>(null)
  const [qualLoading, setQualLoading] = useState(false)
  useEffect(() => {
    if (!selected) return
    setQual(null); setQualLoading(true)
    loadFacilityQualitative(supabase, selected.facility).then(setQual).catch(() => setQual(null)).finally(() => setQualLoading(false))
  }, [selected])
  const openFacility = (facility: string, path: string) => { setCurrent(facility); router.push(path) }
  // G6 灯（全社モード）所見
  const [insight, setInsight] = useState('')
  const [insightAt, setInsightAt] = useState<string | null>(null)
  const [insightBusy, setInsightBusy] = useState(false)
  const [insightErr, setInsightErr] = useState('')
  const authHeader = async (): Promise<Record<string, string>> => {
    const { data: { session } } = await supabase.auth.getSession()
    return { 'Content-Type': 'application/json', ...(session ? { Authorization: `Bearer ${session.access_token}` } : {}) }
  }
  // 対象月のキャッシュ済み所見を読み込む（無ければ空）
  useEffect(() => {
    if (!isOwner || !month) return
    setInsight(''); setInsightErr(''); setInsightAt(null)
    ;(async () => {
      try {
        const res = await fetch('/api/company-insight', { method: 'POST', headers: await authHeader(), body: JSON.stringify({ month }) })
        const d = await res.json()
        if (d.content) { setInsight(d.content); setInsightAt(d.updatedAt ?? null) }
      } catch { /* 読み込み失敗は無視（生成ボタンで再取得可） */ }
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

  // 対象月リスト（売上実績martの月＝運営月。最新をデフォルト）
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

  // スコープ内の宿（ヒートマップ行）
  const rows = useMemo(() => {
    if (!ds) return []
    return ds.facilities.filter((m) => (scope === 'all' ? true : m.cls === scope))
  }, [ds, scope])

  // 列定義。sortVal=ソート基準（money列はcolorModeの率、比率/スコア列は値）。
  type Col = {
    key: string; label: string; sortVal: (m: FacilityMetrics) => number | null
  }
  const cols: Col[] = useMemo(() => [
    { key: 'sales', label: '売上', sortVal: (m) => (colorMode === 'budget' ? rate(m.sales.act, m.sales.bud) : rate(m.sales.act, m.sales.prior)) },
    { key: 'oi', label: '営業利益', sortVal: (m) => (colorMode === 'budget' ? rate(m.operatingIncome.act, m.operatingIncome.bud) : rate(m.operatingIncome.act, m.operatingIncome.prior)) },
    { key: 'gop', label: 'GOP', sortVal: (m) => (colorMode === 'budget' ? rate(m.gop.act, m.gop.bud) : rate(m.gop.act, m.gop.prior)) },
    { key: 'laborRatio', label: '人件費率', sortVal: (m) => rate(m.labor.act, m.sales.act) },
    { key: 'prod', label: '生産性', sortVal: (m) => rate(m.revenue, m.workHours) },
    { key: 'sat', label: '満足度', sortVal: (m) => m.satisfaction },
    { key: 'nps', label: 'NPS', sortVal: (m) => m.nps },
  ], [colorMode])

  const sortedRows = useMemo(() => {
    const col = cols.find((c) => c.key === sortKey) ?? cols[0]
    const dir = sortDir === 'asc' ? 1 : -1
    return [...rows].sort((a, b) => {
      const va = col.sortVal(a), vb = col.sortVal(b)
      if (va == null && vb == null) return 0
      if (va == null) return 1          // null は常に末尾
      if (vb == null) return -1
      return (va - vb) * dir
    })
  }, [rows, cols, sortKey, sortDir])

  const clickSort = (key: string) => {
    if (sortKey === key) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
    else { setSortKey(key); setSortDir(key === 'laborRatio' ? 'asc' : 'desc') }  // 人件費率は昇順=良い側から
  }

  // スコープ平均（比率・スコア列のヒート基準）
  const avgLaborRatio = agg?.laborRatio ?? null
  const avgProd = agg?.revenuePerHour ?? null
  const avgSat = agg?.satisfaction ?? null
  const avgNps = agg?.nps ?? null

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
        {/* スコープ */}
        <div className="flex rounded-md overflow-hidden" style={{ border: '1px solid var(--border)' }}>
          {(['all', 'existing', 'new'] as StoreScope[]).map((s) => (
            <button key={s} onClick={() => setScope(s)} className="px-3 py-1.5 text-xs"
              style={{ background: scope === s ? 'var(--accent)' : 'var(--surface)', color: scope === s ? '#fff' : 'var(--text-dim)' }}>
              {STORE_SCOPE_LABEL[s]}
            </button>
          ))}
        </div>
        {/* 色分け基準 */}
        <div className="flex rounded-md overflow-hidden" style={{ border: '1px solid var(--border)' }}>
          {(['budget', 'yoy'] as ColorMode[]).map((cm) => (
            <button key={cm} onClick={() => setColorMode(cm)} className="px-3 py-1.5 text-xs"
              style={{ background: colorMode === cm ? 'var(--accent)' : 'var(--surface)', color: colorMode === cm ? '#fff' : 'var(--text-dim)' }}>
              {cm === 'budget' ? '予算比で色分け' : '前年比で色分け'}
            </button>
          ))}
        </div>
        {months.length > 0 && (
          <select className="field px-3 py-1.5 text-sm" value={month} onChange={(e) => setMonth(e.target.value)}>
            {months.map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
        )}
        {agg && <span className="text-xs" style={{ color: 'var(--text-dim)' }}>{STORE_SCOPE_LABEL[scope]} {agg.count}宿</span>}
      </div>

      {loading ? <Loading /> : loadError ? <LoadError message={loadError} /> : !ds || ds.facilities.length === 0 ? (
        <Empty message="全社データがありません。PL・売上実績の取込状況をご確認ください。" />
      ) : (
        <>
          {/* (D) 灯（全社モード）の所見 */}
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

          {/* (A) サマリKPI */}
          {agg && (
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3 mb-6">
              <SummaryCard label="売上" act={agg.sales.act} bud={agg.sales.bud} prior={agg.sales.prior} fmt={fmtMan} showYoY={showYoY} />
              <SummaryCard label="営業利益" act={agg.operatingIncome.act} bud={agg.operatingIncome.bud} prior={agg.operatingIncome.prior} fmt={fmtMan} showYoY={showYoY} />
              <SummaryCard label="GOP" act={agg.gop.act} bud={agg.gop.bud} prior={agg.gop.prior} fmt={fmtMan} showYoY={showYoY} />
              <SummaryCard label="OCC（稼働率）" act={agg.occ} bud={null} prior={null} fmt={pct} showYoY={showYoY} />
              <SummaryCard label="満足度" act={agg.satisfaction} bud={null} prior={null} fmt={(x) => x.toFixed(2)} showYoY={showYoY} />
              <SummaryCard label="NPS" act={agg.nps} bud={null} prior={null} fmt={(x) => x.toFixed(1)} showYoY={showYoY} />
            </div>
          )}

          {/* (B) 宿ヒートマップ */}
          <div className="flex items-center justify-between mb-2">
            <div className="text-sm font-semibold">宿ヒートマップ</div>
            <div className="text-[11px]" style={{ color: 'var(--text-dim)' }}>
              各セル: 実額 ／ 予=予算差・比 ／ 前=前年差・比。色は{colorMode === 'budget' ? '予算比' : '前年比'}基準。列見出しクリックでソート・行クリックで課題ドリルダウン。
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
                    <MoneyCell t={m.sales} colorMode={colorMode} showYoY={showYoY} />
                    <MoneyCell t={m.operatingIncome} colorMode={colorMode} showYoY={showYoY} />
                    <MoneyCell t={m.gop} colorMode={colorMode} showYoY={showYoY} />
                    <StatCell v={rate(m.labor.act, m.sales.act)} avg={avgLaborRatio} higherBetter={false} fmt={pct} />
                    <StatCell v={rate(m.revenue, m.workHours)} avg={avgProd} higherBetter fmt={(x) => `¥${fmtNum(x)}`} />
                    <StatCell v={m.satisfaction} avg={avgSat} higherBetter fmt={(x) => x.toFixed(2)} />
                    <StatCell v={m.nps} avg={avgNps} higherBetter fmt={(x) => x.toFixed(1)} />
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* (E) 2軸クロス分析 */}
          <CrossAnalysis rows={rows} />

          <p className="text-xs mt-2" style={{ color: 'var(--text-dim)' }}>
            金額=万円。売上/営業利益/GOPは宿ごとにPL明細から再計算（予実ページと同一）。人件費率=人件費(PL)÷売上、生産性=売上÷総労働時間、OCC=全日ベース。
            満足度=クチコミ総合(3ヶ月平滑)。全店/既存店/新店は開業13ヶ月ルール（新店は前年比を非表示）。人件費率・生産性・満足度・NPSの色はスコープ平均比。
          </p>
        </>
      )}

      {selected && agg && (
        <DrilldownModal m={selected} agg={agg} showYoY={showYoY} qual={qual} qualLoading={qualLoading}
          onClose={() => setSelected(null)} onOpenFacility={openFacility} />
      )}
    </div>
  )
}
