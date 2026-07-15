'use client'

// 全社Core（経営者の右腕）: 全27施設を横断。(A)サマリKPI +(B)施設ヒートマップ。
// 権限=owner限定（ページ側ガード＋サイドバーもowner出し分け。実データ保護はDBのRLS）。
// PLは company-data 経由で施設ごとに pl-compute を適用 → 施設別ページ(yojitsu)と数字一致。
import { useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { supabase } from '@/lib/supabase/client'
import { useFacility } from '@/lib/facility-context'
import { fetchAll } from '@/lib/supabase/fetch-all'
import { fmtNum, fmtYenM, pct } from '@/lib/ui'
import { Loading, Empty, LoadError } from '@/components/page-bits'
import {
  loadCompanyData, aggregateScope, detectAnomalies, loadFacilityQualitative,
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
const signedM = (v: number | null): string => (v == null ? '' : (v >= 0 ? '+' : '') + fmtYenM(v))

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
      <div className="font-medium">{t.act == null ? '—' : fmtYenM(t.act)}</div>
      <div className="text-[10px]" style={{ color: rColor(rB) }}>予 {signedM(diffB)}{rB != null && ` / ${pct(rB)}`}</div>
      {showYoY && <div className="text-[10px]" style={{ color: rColor(rY) }}>前 {rY == null ? '—' : `${signedM(diffY)} / ${pct(rY)}`}</div>}
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

// G4: 課題施設ドリルダウン（1段目=数字の自動異常 / 2段目=定性背景 / 施設別ページへ導線）
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
              <p className="text-sm p-3 rounded" style={{ background: 'var(--surface2)', color: 'var(--text-dim)' }}>定性情報は未登録です。施設プロフィール・取組履歴を記録すると、数字の背景が結びつきます。</p>
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

          {/* 導線: 施設別ページへ */}
          <div className="flex gap-2 pt-1">
            <button onClick={() => onOpenFacility(m.facility, '/yojitsu')}
              className="px-4 py-1.5 rounded-md text-sm text-white" style={{ background: 'var(--accent)' }}>この施設の予実（PL）を開く</button>
            <button onClick={() => onOpenFacility(m.facility, '/')}
              className="px-4 py-1.5 rounded-md text-sm" style={{ background: 'var(--surface2)', color: 'var(--text)' }}>概要を開く</button>
          </div>
        </div>
      </div>
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

  // スコープ内の施設（ヒートマップ行）
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
        この画面（全社Core）は<strong>オーナーのみ</strong>が利用できます。施設別の分析は左メニューからご利用ください。
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
        {agg && <span className="text-xs" style={{ color: 'var(--text-dim)' }}>{STORE_SCOPE_LABEL[scope]} {agg.count}施設</span>}
      </div>

      {loading ? <Loading /> : loadError ? <LoadError message={loadError} /> : !ds || ds.facilities.length === 0 ? (
        <Empty message="全社データがありません。PL・売上実績の取込状況をご確認ください。" />
      ) : (
        <>
          {/* (A) サマリKPI */}
          {agg && (
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3 mb-6">
              <SummaryCard label="売上" act={agg.sales.act} bud={agg.sales.bud} prior={agg.sales.prior} fmt={fmtYenM} showYoY={showYoY} />
              <SummaryCard label="営業利益" act={agg.operatingIncome.act} bud={agg.operatingIncome.bud} prior={agg.operatingIncome.prior} fmt={fmtYenM} showYoY={showYoY} />
              <SummaryCard label="GOP" act={agg.gop.act} bud={agg.gop.bud} prior={agg.gop.prior} fmt={fmtYenM} showYoY={showYoY} />
              <SummaryCard label="OCC（稼働率）" act={agg.occ} bud={null} prior={null} fmt={pct} showYoY={showYoY} />
              <SummaryCard label="満足度" act={agg.satisfaction} bud={null} prior={null} fmt={(x) => x.toFixed(2)} showYoY={showYoY} />
              <SummaryCard label="NPS" act={agg.nps} bud={null} prior={null} fmt={(x) => x.toFixed(1)} showYoY={showYoY} />
            </div>
          )}

          {/* (B) 施設ヒートマップ */}
          <div className="flex items-center justify-between mb-2">
            <div className="text-sm font-semibold">施設ヒートマップ</div>
            <div className="text-[11px]" style={{ color: 'var(--text-dim)' }}>
              各セル: 実額 ／ 予=予算差・比 ／ 前=前年差・比。色は{colorMode === 'budget' ? '予算比' : '前年比'}基準。列見出しクリックでソート・行クリックで課題ドリルダウン。
            </div>
          </div>
          <div className="card overflow-auto" style={{ maxHeight: 'calc(100vh - 280px)' }}>
            <table className="w-full text-sm border-separate" style={{ borderSpacing: 0 }}>
              <thead>
                <tr style={{ color: 'var(--text-dim)' }}>
                  <th className="px-3 py-2.5 text-left whitespace-nowrap sticky left-0 top-0 z-30" style={{ background: 'var(--surface2)', borderRight: '2px solid var(--border)' }}>施設</th>
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

          <p className="text-xs mt-2" style={{ color: 'var(--text-dim)' }}>
            金額=¥M（百万円）。売上/営業利益/GOPは施設ごとにPL明細から再計算（予実ページと同一）。人件費率=人件費(PL)÷売上、生産性=売上÷総労働時間、OCC=全日ベース。
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
