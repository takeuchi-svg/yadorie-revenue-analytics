'use client'

// シフト予実分析（SV05・支配人向け振り返り）。計画(予)vs実績(実)を月次で振り返る。
// 「計画超過」(実績−計画)と「残業」(KOT)を厳密に使い分け（要件2.1）。要因の断定はせず可視化まで。
import { useEffect, useMemo, useState, Fragment } from 'react'
import { useFacility } from '@/lib/facility-context'
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell,
} from 'recharts'
import { fmtYen, CHART_AXIS, chartTooltip } from '@/lib/ui'
import { Loading, Empty, LoadError } from '@/components/page-bits'
import { useToast } from '@/components/toast'
import {
  loadVariance, loadVarianceMonths, loadVarianceReasons, saveVarianceNote,
  type VarianceBundle, type VarianceReason, type FacilityDaily,
} from '@/lib/shift/variance'

const WD = ['月', '火', '水', '木', '金', '土', '日']  // isodow 1..7
const h = (min: number | null | undefined) => (min == null ? '—' : `${(min / 60).toFixed(1)}h`)
const hSign = (min: number | null | undefined) => (min == null ? '—' : `${min >= 0 ? '+' : ''}${(min / 60).toFixed(1)}h`)
const thisMonth = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}` }

// 自動分類の表示ラベル・色
const TYPE_META: Record<string, { label: string; color: string }> = {
  ABSENCE: { label: '欠勤', color: '#C0392B' },
  UNPLANNED: { label: 'シフト外出勤', color: '#D85A30' },
  SPOT_ADD: { label: 'スポット追加', color: '#C99A2E' },
  HELP: { label: 'ヘルプ', color: '#378ADD' },
  HOLIDAY_WORK: { label: '休日出勤', color: '#7F77DD' },
  OVER: { label: '計画超過', color: '#E24B4A' },
  UNDER: { label: '計画未達', color: '#5FA8D3' },
  ON_PLAN: { label: '計画通り', color: '#1D9E75' },
}

export default function ShiftVariancePage() {
  const { current, currentFacility } = useFacility()
  const toast = useToast()
  const [month, setMonth] = useState(thisMonth())
  const [months, setMonths] = useState<string[]>([])
  const [data, setData] = useState<VarianceBundle | null>(null)
  const [reasons, setReasons] = useState<VarianceReason[]>([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState('')

  useEffect(() => { if (current) loadVarianceMonths(current).then(setMonths); loadVarianceReasons().then(setReasons) }, [current])
  const reload = () => {
    if (!current) return
    setLoading(true); setErr('')
    loadVariance(current, month).then(setData).catch((e) => setErr(e instanceof Error ? e.message : String(e))).finally(() => setLoading(false))
  }
  useEffect(reload, [current, month])  // eslint-disable-line react-hooks/exhaustive-deps

  const mo = data?.monthly
  const prev = data?.prevMonthly
  const costTotal = (m?: typeof mo) => (m ? (m.cost_impact_hourly ?? 0) + (m.cost_impact_monthly_ot ?? 0) : null)

  // 差異内訳（自動分類別の時間）
  const typeBreak = useMemo(() => {
    const acc: Record<string, number> = {}
    for (const r of data?.staffDaily ?? []) {
      // 分類別の差異時間（絶対値。ON_PLANは0）
      acc[r.variance_type] = (acc[r.variance_type] ?? 0) + (r.variance_type === 'ON_PLAN' ? 0 : Math.abs(r.variance_min))
    }
    return Object.entries(acc).filter(([, v]) => v > 0)
      .map(([type, v]) => ({ type, label: TYPE_META[type]?.label ?? type, color: TYPE_META[type]?.color ?? '#888', hours: +(v / 60).toFixed(1) }))
      .sort((a, b) => b.hours - a.hours)
  }, [data])

  // 曜日別（調整後差異の平均・時間）
  const wdData = useMemo(() => {
    const m: Record<number, { v: number; adj: number }> = {}
    for (const r of data?.weekday ?? []) m[r.weekday] = { v: (r.avg_variance_min ?? 0) / 60, adj: (r.avg_adjusted_variance_min ?? 0) / 60 }
    return [1, 2, 3, 4, 5, 6, 7].map((d) => ({ wd: WD[d - 1], adj: +(m[d]?.adj ?? 0).toFixed(1) }))
  }, [data])
  const wdMax = Math.max(1, ...wdData.map((d) => Math.abs(d.adj)))

  // 人別明細
  const staffRows = useMemo(() => {
    const acc: Record<string, { plan: number; actual: number; variance: number; ot: number; days: Record<string, string> }> = {}
    for (const r of data?.staffDaily ?? []) {
      const g = (acc[r.staff_code] ??= { plan: 0, actual: 0, variance: 0, ot: 0, days: {} })
      g.plan += r.plan_min; g.actual += r.actual_min; g.variance += r.variance_min; g.ot += r.overtime_min
      if (r.variance_type !== 'ON_PLAN') g.days[r.work_date] = r.variance_type
    }
    return Object.entries(acc).map(([code, v]) => ({ code, name: data?.staffNames[code] ?? code, ...v }))
      .sort((a, b) => b.variance - a.variance)
  }, [data])

  const exceptionCount = (data?.facilityDaily ?? []).filter((d) => d.is_exception).length
  const reasonDone = (data?.facilityDaily ?? []).filter((d) => d.is_exception && d.reason_entered).length

  return (
    <div className="p-6">
      <div className="flex items-center gap-3 mb-4 flex-wrap">
        <h1 className="text-base font-semibold">シフト予実分析{currentFacility?.name ? `（${currentFacility.name}）` : ''}</h1>
        <select className="field px-3 py-1.5 text-sm" value={month} onChange={(e) => setMonth(e.target.value)}>
          {[...new Set([month, ...months])].sort().reverse().map((m) => <option key={m} value={m}>{m}</option>)}
        </select>
        <span className="text-xs" style={{ color: 'var(--text-dim)' }}>計画（予）と実績（実）の突合。「計画超過」＝実績−計画、「残業」＝勤怠の所定外（別概念）。</span>
      </div>

      {loading ? <Loading /> : err ? <LoadError message={err} /> : !data || (data.staffDaily.length === 0 && data.facilityDaily.length === 0) ? (
        <Empty message="この月の予実データがありません。シフト計画の公開＋勤怠取込がそろうと表示されます。" />
      ) : (
        <>
          {/* 例外リスト＋理由入力（SV06） */}
          {exceptionCount > 0 && (
            <ExceptionList
              days={(data.facilityDaily ?? []).filter((d) => d.is_exception)}
              reasons={reasons} exceptionCount={exceptionCount} reasonDone={reasonDone}
              onSave={async (wd, codes, note) => {
                if (!current) return
                const { error } = await saveVarianceNote(current, wd, codes, note)
                if (error) { toast(`エラー: ${error}`, 'error'); return }
                toast('理由を保存しました'); reload()
              }}
            />
          )}

          {/* 1. 月次サマリー */}
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3 mb-5">
            <Card label="計画" value={h(mo?.final_plan_min)} sub={prev ? `前月 ${h(prev.final_plan_min)}` : undefined} />
            <Card label="実績" value={h(mo?.actual_min)} sub={prev ? `前月 ${h(prev.actual_min)}` : undefined} />
            <Card label="計画超過" value={hSign(mo?.variance_min)} accent={(mo?.variance_min ?? 0) > 0} sub={prev ? `前月 ${hSign(prev.variance_min)}` : undefined} />
            <Card label="調整後差異(運用起因)" value={hSign(mo?.ops_over_min)} accent={(mo?.ops_over_min ?? 0) > 0} sub="需要増を控除した超過" />
            <Card label="人件費影響" value={costTotal(mo) != null ? fmtYen(costTotal(mo)!) : '—'} sub={costTotal(prev) != null ? `前月 ${fmtYen(costTotal(prev)!)}` : undefined} />
            <Card label="例外日 / 理由入力" value={`${exceptionCount} / ${reasonDone}`} sub={`修正 ${mo?.revision_count ?? 0}回`} />
          </div>

          {/* 2. 3時点予実バー */}
          <div className="card p-4 mb-5">
            <h2 className="text-sm font-semibold mb-1">3時点予実（月初版 → 最終版 → 実績）</h2>
            <p className="text-xs mb-3" style={{ color: 'var(--text-dim)' }}>
              月初版＝最初に「公開」した計画。月中修正量（計画の変更）と当日運用差（欠勤・超過）を分けて見ます。
              {mo?.baseline_min == null && <span style={{ color: 'var(--yellow)' }}>　※この月は未公開のため月初版がありません（シフト管理で「公開」すると記録されます）。</span>}
            </p>
            <ThreePoint baseline={mo?.baseline_min ?? null} finalPlan={mo?.final_plan_min ?? null} actual={mo?.actual_min ?? null} />
            <div className="grid grid-cols-3 gap-2 mt-3 text-xs">
              <Mini label="A. 月中修正量" v={mo?.revision_min} note="月初版→最終版" />
              <Mini label="B. 当日運用差" v={mo?.variance_min} note="最終版→実績" />
              <Mini label="C. 月初計画精度" v={mo?.baseline_variance_min} note="月初版→実績" />
            </div>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-5">
            {/* 3. 差異内訳 */}
            <div className="card p-4">
              <h2 className="text-sm font-semibold mb-3">差異の内訳（自動分類・時間）</h2>
              {typeBreak.length === 0 ? <p className="text-sm py-10 text-center" style={{ color: 'var(--text-dim)' }}>差異なし</p> : (
                <ResponsiveContainer width="100%" height={Math.max(180, typeBreak.length * 34)}>
                  <BarChart data={typeBreak} layout="vertical" margin={{ left: 20, right: 24 }}>
                    <XAxis type="number" {...CHART_AXIS} tickFormatter={(v) => `${v}h`} />
                    <YAxis type="category" dataKey="label" {...CHART_AXIS} width={90} />
                    <Tooltip {...chartTooltip} formatter={(v: any) => [`${v}h`, '時間']} />
                    <Bar dataKey="hours" radius={[0, 4, 4, 0]}>{typeBreak.map((d) => <Cell key={d.type} fill={d.color} />)}</Bar>
                  </BarChart>
                </ResponsiveContainer>
              )}
            </div>

            {/* 4. 曜日別ヒートマップ（調整後差異平均） */}
            <div className="card p-4">
              <h2 className="text-sm font-semibold mb-1">曜日別 調整後差異（平均・恒常超過の発見）</h2>
              <p className="text-xs mb-3" style={{ color: 'var(--text-dim)' }}>需要増を控除した後の差異。特定曜日が恒常的に赤ならシフトパターン見直しの合図。</p>
              <div className="grid grid-cols-7 gap-1.5">
                {wdData.map((d) => {
                  const t = Math.min(1, Math.abs(d.adj) / wdMax)
                  const bg = d.adj >= 0 ? `rgba(216,90,48,${0.12 + t * 0.6})` : `rgba(29,158,117,${0.12 + t * 0.5})`
                  return (
                    <div key={d.wd} className="rounded-md text-center py-3" style={{ background: bg }}>
                      <div className="text-[11px]" style={{ color: 'var(--text-dim)' }}>{d.wd}</div>
                      <div className="text-sm font-semibold">{d.adj >= 0 ? '+' : ''}{d.adj}h</div>
                    </div>
                  )
                })}
              </div>
            </div>
          </div>

          {/* 5. 雇用区分・スポット別 */}
          <div className="card overflow-x-auto mb-5">
            <div className="px-3 pt-3 text-sm font-semibold">雇用区分・スポット別</div>
            <table className="w-full text-sm whitespace-nowrap mt-2">
              <thead><tr style={{ background: 'var(--surface2)', color: 'var(--text-dim)' }} className="text-left">
                <th className="px-3 py-2">区分</th><th className="px-3 py-2 text-right">計画</th><th className="px-3 py-2 text-right">実績</th><th className="px-3 py-2 text-right">計画超過</th>
              </tr></thead>
              <tbody>
                {(data.byEmp ?? []).map((r) => (
                  <tr key={r.emp_type} style={{ borderTop: '1px solid var(--border)' }}>
                    <td className="px-3 py-2 font-medium">{r.emp_type ?? '—'}</td>
                    <td className="px-3 py-2 text-right">{h(r.plan_min)}</td>
                    <td className="px-3 py-2 text-right">{h(r.actual_min)}</td>
                    <td className="px-3 py-2 text-right" style={{ color: r.variance_min > 0 ? 'var(--red)' : r.variance_min < 0 ? 'var(--green)' : undefined }}>{hSign(r.variance_min)}</td>
                  </tr>
                ))}
                {(data.byEmp ?? []).length === 0 && <tr><td colSpan={4} className="px-3 py-4 text-center" style={{ color: 'var(--text-dim)' }}>データなし</td></tr>}
              </tbody>
            </table>
          </div>

          {/* 6. 人別明細 */}
          <div className="card overflow-x-auto">
            <div className="px-3 pt-3 text-sm font-semibold">人別明細（計画超過の大きい順）</div>
            <table className="w-full text-sm whitespace-nowrap mt-2">
              <thead><tr style={{ background: 'var(--surface2)', color: 'var(--text-dim)' }} className="text-left">
                <th className="px-3 py-2">従業員</th><th className="px-3 py-2 text-right">計画</th><th className="px-3 py-2 text-right">実績</th>
                <th className="px-3 py-2 text-right">計画超過</th><th className="px-3 py-2 text-right">うち残業</th><th className="px-3 py-2">差異のあった日</th>
              </tr></thead>
              <tbody>
                {staffRows.map((r) => (
                  <tr key={r.code} style={{ borderTop: '1px solid var(--border)' }}>
                    <td className="px-3 py-2 font-medium">{r.name}</td>
                    <td className="px-3 py-2 text-right">{h(r.plan)}</td>
                    <td className="px-3 py-2 text-right">{h(r.actual)}</td>
                    <td className="px-3 py-2 text-right font-medium" style={{ color: r.variance > 0 ? 'var(--red)' : r.variance < 0 ? 'var(--green)' : undefined }}>{hSign(r.variance)}</td>
                    <td className="px-3 py-2 text-right" style={{ color: 'var(--text-dim)' }}>{h(r.ot)}</td>
                    <td className="px-3 py-2">
                      <span className="inline-flex flex-wrap gap-1">
                        {Object.entries(r.days).slice(0, 12).map(([d, t]) => (
                          <span key={d} className="text-[10px] px-1 py-0.5 rounded text-white" style={{ background: TYPE_META[t]?.color ?? '#888' }} title={`${d} ${TYPE_META[t]?.label ?? t}`}>{d.slice(8)}</span>
                        ))}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <p className="text-xs mt-3" style={{ color: 'var(--text-dim)' }}>
            計画超過＝実績−計画（予実の概念）／残業＝勤怠の所定外（労務の概念・overtime）で別指標です。調整後差異＝計画超過−需要起因分（客数増×標準人時係数）。
            例外＝｜調整後差異｜が5時間以上の日。標準人時係数は各宿設定で確認・補正できます。要因の判断は人が行います。
          </p>
        </>
      )}
    </div>
  )
}

// ── SV06 例外リスト＋理由入力（行内展開） ──
function ExceptionList({ days, reasons, exceptionCount, reasonDone, onSave }: {
  days: FacilityDaily[]; reasons: VarianceReason[]; exceptionCount: number; reasonDone: number
  onSave: (workDate: string, codes: string[], note: string) => Promise<void>
}) {
  const [open, setOpen] = useState<string | null>(null)
  const [sel, setSel] = useState<Set<string>>(new Set())
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const cats = useMemo(() => {
    const m: Record<string, VarianceReason[]> = {}
    for (const r of reasons) (m[r.category] ??= []).push(r)
    return Object.entries(m)
  }, [reasons])
  const openRow = (d: FacilityDaily) => {
    if (open === d.work_date) { setOpen(null); return }
    setOpen(d.work_date); setSel(new Set(d.reason_codes ?? [])); setNote(d.note ?? '')
  }
  const toggle = (c: string) => setSel((p) => { const n = new Set(p); n.has(c) ? n.delete(c) : n.add(c); return n })
  const wd = ['月', '火', '水', '木', '金', '土', '日']

  return (
    <div className="card overflow-hidden mb-5" style={{ borderColor: 'var(--accent)' }}>
      <div className="px-4 py-3 flex items-center gap-2 flex-wrap" style={{ background: 'var(--surface2)' }}>
        <span className="text-sm font-semibold">理由入力が必要な差異</span>
        <span className="px-1.5 py-0.5 rounded text-white text-[10px]" style={{ background: exceptionCount > reasonDone ? 'var(--red)' : 'var(--green)' }}>
          {exceptionCount}件（入力済み {reasonDone}）
        </span>
        <span className="text-xs" style={{ color: 'var(--text-dim)' }}>｜調整後差異｜が5時間以上の日。行をクリックして理由を選択（1件30秒）。</span>
      </div>
      <table className="w-full text-sm whitespace-nowrap">
        <thead><tr style={{ color: 'var(--text-dim)' }} className="text-left">
          <th className="px-4 py-2">日付</th><th className="px-4 py-2 text-right">調整後差異</th><th className="px-4 py-2 text-right">客数(予/実)</th>
          <th className="px-4 py-2">内訳</th><th className="px-4 py-2">理由</th><th className="px-4 py-2"></th>
        </tr></thead>
        <tbody>
          {days.map((d) => {
            const isOpen = open === d.work_date
            const dowLabel = wd[(d.weekday as number) - 1] ?? ''
            const parts = [d.cnt_absence && `欠${d.cnt_absence}`, d.cnt_unplanned && `外${d.cnt_unplanned}`, d.cnt_spot && `ス${d.cnt_spot}`, d.cnt_help && `ヘ${d.cnt_help}`].filter(Boolean).join(' ')
            return (
              <Fragment key={d.work_date}>
                <tr style={{ borderTop: '1px solid var(--border)', cursor: 'pointer', background: isOpen ? 'var(--surface2)' : undefined }} onClick={() => openRow(d)}>
                  <td className="px-4 py-2 font-medium">{d.work_date.slice(5)}（{dowLabel}）</td>
                  <td className="px-4 py-2 text-right font-medium" style={{ color: (d.adjusted_variance_min ?? 0) >= 0 ? 'var(--red)' : 'var(--green)' }}>
                    {d.adjusted_variance_min == null ? '—' : `${d.adjusted_variance_min >= 0 ? '+' : ''}${(d.adjusted_variance_min / 60).toFixed(1)}h`}
                    {d.flag_no_flex_down && <span className="ml-1 text-[9px] px-1 py-0.5 rounded text-white" style={{ background: 'var(--red)' }} title="客数減なのに労働が減っていない">変動費化不全</span>}
                  </td>
                  <td className="px-4 py-2 text-right" style={{ color: 'var(--text-dim)' }}>{d.guests_plan ?? '—'} / {d.guests_actual ?? '—'}</td>
                  <td className="px-4 py-2 text-xs" style={{ color: 'var(--text-dim)' }}>{parts || '—'}</td>
                  <td className="px-4 py-2">
                    {d.reason_entered
                      ? <span className="inline-flex flex-wrap gap-1">{(d.reason_codes ?? []).map((c) => <span key={c} className="text-[10px] px-1.5 py-0.5 rounded" style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}>{reasons.find((r) => r.reason_code === c)?.label ?? c}</span>)}</span>
                      : <span className="text-[10px] px-1.5 py-0.5 rounded text-white" style={{ background: 'var(--red)' }}>未入力</span>}
                  </td>
                  <td className="px-4 py-2 text-[10px]" style={{ color: 'var(--text-dim)' }}>{isOpen ? '▲' : '▼'}</td>
                </tr>
                {isOpen && (
                  <tr>
                    <td colSpan={6} className="px-4 pb-3" style={{ background: 'var(--surface2)' }}>
                      <div className="pt-1 space-y-2">
                        {cats.map(([cat, rs]) => (
                          <div key={cat} className="flex items-start gap-2 flex-wrap">
                            <span className="text-[11px] w-16 shrink-0 pt-1" style={{ color: 'var(--text-dim)' }}>{cat}</span>
                            <div className="flex flex-wrap gap-1.5">
                              {rs.map((r) => {
                                const on = sel.has(r.reason_code)
                                return (
                                  <button key={r.reason_code} onClick={() => toggle(r.reason_code)}
                                    className="text-xs px-2.5 py-1 rounded-full"
                                    style={{ background: on ? 'var(--accent)' : 'var(--surface)', color: on ? '#fff' : 'var(--text)', border: `1px solid ${on ? 'var(--accent)' : 'var(--border)'}` }}>
                                    {r.label}
                                  </button>
                                )
                              })}
                            </div>
                          </div>
                        ))}
                        <div className="flex items-center gap-2">
                          <input className="field px-2 py-1 text-sm flex-1" placeholder="メモ（任意）" value={note} onChange={(e) => setNote(e.target.value)} />
                          <button disabled={busy} onClick={async () => { setBusy(true); await onSave(d.work_date, [...sel], note); setBusy(false); setOpen(null) }}
                            className="px-4 py-1.5 rounded-md text-sm text-white disabled:opacity-50" style={{ background: 'var(--accent)' }}>{busy ? '保存中…' : '保存'}</button>
                        </div>
                      </div>
                    </td>
                  </tr>
                )}
              </Fragment>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

function Card({ label, value, sub, accent }: { label: string; value: string; sub?: string; accent?: boolean }) {
  return (
    <div className="card p-3">
      <p className="text-[11px] mb-1" style={{ color: 'var(--text-dim)' }}>{label}</p>
      <p className="text-lg font-bold" style={{ color: accent ? 'var(--accent)' : 'var(--text)' }}>{value}</p>
      {sub && <p className="text-[10px] mt-0.5" style={{ color: 'var(--text-dim)' }}>{sub}</p>}
    </div>
  )
}
function Mini({ label, v, note }: { label: string; v: number | null | undefined; note: string }) {
  return (
    <div className="rounded-md px-3 py-2" style={{ background: 'var(--surface2)' }}>
      <div className="text-[10px]" style={{ color: 'var(--text-dim)' }}>{label}</div>
      <div className="text-sm font-semibold" style={{ color: (v ?? 0) > 0 ? 'var(--red)' : (v ?? 0) < 0 ? 'var(--green)' : undefined }}>{v == null ? '—' : `${v >= 0 ? '+' : ''}${(v / 60).toFixed(1)}h`}</div>
      <div className="text-[9px]" style={{ color: 'var(--text-dim)' }}>{note}</div>
    </div>
  )
}
function ThreePoint({ baseline, finalPlan, actual }: { baseline: number | null; finalPlan: number | null; actual: number | null }) {
  const max = Math.max(1, baseline ?? 0, finalPlan ?? 0, actual ?? 0)
  const bar = (label: string, v: number | null, color: string) => (
    <div className="flex items-center gap-2">
      <span className="text-[11px] w-16 shrink-0" style={{ color: 'var(--text-dim)' }}>{label}</span>
      <div className="flex-1 rounded" style={{ background: 'var(--surface2)', height: 22 }}>
        <div className="h-full rounded flex items-center justify-end pr-2 text-[11px] text-white" style={{ width: `${v == null ? 0 : Math.max(6, (v / max) * 100)}%`, background: color }}>
          {v == null ? '' : `${(v / 60).toFixed(1)}h`}
        </div>
      </div>
    </div>
  )
  return (
    <div className="flex flex-col gap-1.5">
      {bar('月初版', baseline, '#B4B2A9')}
      {bar('最終版', finalPlan, '#7F77DD')}
      {bar('実績', actual, 'var(--accent)')}
    </div>
  )
}
