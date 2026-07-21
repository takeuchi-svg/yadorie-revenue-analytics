'use client'

// 全社設定 → 正社員 人件費（宿×月の合計額）。個人給与は持たず、宿ごとの月額合計だけを毎月入力。
// 人件費モデルv2: 正社員=この月額（固定）／アルバイト=各宿の標準時給×時間／スポット=シフトで都度。
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useFacility } from '@/lib/facility-context'
import { FacilitySelect } from '@/components/facility-select'
import { useToast } from '@/components/toast'
import { loadRegularLabor, saveRegularLabor } from '@/lib/shift/data'

// 直近12ヶ月＋先3ヶ月を編集対象に（新しい順）
function monthList(): string[] {
  const now = new Date()
  const out: string[] = []
  for (let k = 3; k >= -11; k--) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + k, 1))
    out.push(d.toISOString().slice(0, 7))
  }
  return out
}

export default function RegularLaborAdmin() {
  const { facilities } = useFacility()
  const toast = useToast()
  const [facility, setFacility] = useState('')
  const [vals, setVals] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)
  const months = useMemo(monthList, [])

  useEffect(() => { if (!facility && facilities.length) setFacility(facilities[0].facility) }, [facilities, facility])

  const load = useCallback(async () => {
    if (!facility) return
    const rows = await loadRegularLabor(facility)
    const m: Record<string, string> = {}
    for (const r of rows) if (r.amount != null) m[r.month] = String(r.amount)
    setVals(m)
  }, [facility])
  useEffect(() => { load() }, [load])

  const save = async () => {
    if (!facility) return
    setSaving(true)
    let err: string | undefined
    for (const mth of months) {
      const raw = (vals[mth] ?? '').trim()
      const amount = raw === '' ? null : Number(raw)
      if (amount != null && !Number.isFinite(amount)) { err = `${mth} の金額が不正です`; break }
      const { error } = await saveRegularLabor(facility, mth, amount)
      if (error) { err = error; break }
    }
    setSaving(false)
    toast(err ? `エラー: ${err}` : '正社員人件費を保存しました', err ? 'error' : 'success')
  }

  return (
    <section className="card p-6">
      <div className="flex items-center justify-between mb-2 flex-wrap gap-2">
        <h2 className="text-lg font-semibold">正社員 人件費（宿×月の合計）</h2>
        <button onClick={save} disabled={saving || !facility}
          className="px-4 py-1.5 bg-[var(--accent)] text-white rounded-md text-sm hover:opacity-90 disabled:opacity-50">保存</button>
      </div>
      <p className="text-xs mb-3" style={{ color: 'var(--text-dim)' }}>
        個人給与は持たず、宿ごとの<b>正社員人件費の月額合計</b>だけを入力します（給料手当＋賞与＋法定福利など、正社員に関わる固定人件費の合計）。
        シフトの人件費予実では固定として扱い、日別は計画時間で按分して生産性に反映します。
      </p>
      <div className="mb-3">
        <label className="block text-[10px] mb-1 tracking-wide" style={{ color: 'var(--text-dim)' }}>対象の宿</label>
        <div className="min-w-56 inline-block"><FacilitySelect options={facilities} value={facility} onChange={setFacility} /></div>
      </div>
      <div className="overflow-x-auto">
        <table className="text-sm">
          <tbody>
            {months.map((m) => (
              <tr key={m} style={{ borderTop: '1px solid var(--border)' }}>
                <td className="px-2 py-1.5 whitespace-nowrap" style={{ color: 'var(--text-dim)' }}>{m}</td>
                <td className="px-2 py-1.5">
                  <div className="flex items-center gap-1">
                    <span className="text-xs" style={{ color: 'var(--text-dim)' }}>¥</span>
                    <input type="number" min={0} step={1000} className="field px-2 py-1 text-sm w-40 text-right"
                      value={vals[m] ?? ''} placeholder="0"
                      onChange={(e) => setVals((p) => ({ ...p, [m]: e.target.value }))} />
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}
