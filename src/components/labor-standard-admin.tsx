'use client'

// 各宿設定 → 標準人時係数（SV03）。自動算出値（過去実績中央値）を表示し、手動補正値を入力/解除。
// 需要調整（客数増の許容超過＝係数×増分）の基準。手動があれば予実分析で優先される。
import { useCallback, useEffect, useState } from 'react'
import { useFacility } from '@/lib/facility-context'
import { useToast } from '@/components/toast'
import { Loading } from '@/components/page-bits'
import { loadLaborStandard, saveLaborStandardManual, type LaborStandard } from '@/lib/shift/data'

const hh = (min: number | null) => (min == null ? '—' : `${min}分/人泊（約${(min / 60).toFixed(1)}h）`)

export default function LaborStandardAdmin() {
  const { current } = useFacility()
  const toast = useToast()
  const [std, setStd] = useState<LaborStandard | null>(null)
  const [loading, setLoading] = useState(true)
  const [manual, setManual] = useState('')
  const [saving, setSaving] = useState(false)

  const load = useCallback(async () => {
    if (!current) return
    setLoading(true)
    const s = await loadLaborStandard(current)
    setStd(s); setManual(s.manual != null ? String(s.manual) : '')
    setLoading(false)
  }, [current])
  useEffect(() => { load() }, [load])

  const save = async () => {
    if (!current) return
    const v = manual.trim() === '' ? null : Number(manual)
    if (v != null && (!Number.isFinite(v) || v <= 0)) { toast('正しい数値（分/人泊）を入力してください', 'error'); return }
    setSaving(true)
    const { error } = await saveLaborStandardManual(current, v)
    setSaving(false)
    if (error) { toast(`エラー: ${error}`, 'error'); return }
    toast(v == null ? '手動補正を解除しました（自動値を使用）' : '手動補正を保存しました')
    load()
  }

  if (loading) return <Loading />
  if (!std) return null
  const noAuto = std.auto == null

  return (
    <section className="card p-5 mt-4">
      <h2 className="text-lg font-semibold mb-1">標準人時係数（分/人泊）</h2>
      <p className="text-xs mb-3" style={{ color: 'var(--text-dim)' }}>
        シフト予実分析の「需要調整」に使う基準です。客数が増えた日は「係数×増加人数」まで労働増を許容します。
        自動値（直近6ヶ月の実績中央値）を基本に、実態と合わなければ手動補正できます（手動があれば優先）。
      </p>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-3">
        <div className="rounded-md px-3 py-2" style={{ background: 'var(--surface2)' }}>
          <div className="text-[10px]" style={{ color: 'var(--text-dim)' }}>自動算出（実績中央値）</div>
          <div className="text-sm font-semibold">{noAuto ? '算出不可' : hh(std.auto)}</div>
          <div className="text-[10px]" style={{ color: 'var(--text-dim)' }}>{noAuto ? '客数×労働の実績が不足' : `サンプル ${std.sampleDays}日`}</div>
        </div>
        <div className="rounded-md px-3 py-2" style={{ background: 'var(--surface2)' }}>
          <div className="text-[10px]" style={{ color: 'var(--text-dim)' }}>適用中（有効値）</div>
          <div className="text-sm font-semibold" style={{ color: 'var(--accent)' }}>{hh(std.effective)}</div>
          <div className="text-[10px]" style={{ color: 'var(--text-dim)' }}>{std.source === 'manual' ? '手動補正を適用中' : std.source === 'auto' ? '自動値を適用中' : '未設定'}</div>
        </div>
        <div className="rounded-md px-3 py-2" style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}>
          <div className="text-[10px] mb-1" style={{ color: 'var(--text-dim)' }}>手動補正（分/人泊・空欄で解除）</div>
          <div className="flex items-center gap-2">
            <input type="number" min={0} className="field px-2 py-1 text-sm w-28 text-right" value={manual} placeholder={std.auto != null ? String(std.auto) : ''} onChange={(e) => setManual(e.target.value)} />
            <button onClick={save} disabled={saving} className="px-3 py-1.5 rounded-md text-sm text-white disabled:opacity-50" style={{ background: 'var(--accent)' }}>{saving ? '保存中…' : '保存'}</button>
          </div>
        </div>
      </div>
      {noAuto && (
        <p className="text-[11px] p-2 rounded" style={{ background: 'var(--yellow)', color: '#3d2b1f' }}>
          客数×労働の実績が不足しているため自動算出できません。手動で目安（例: 60〜180分/人泊）を入力してください。
        </p>
      )}
    </section>
  )
}
