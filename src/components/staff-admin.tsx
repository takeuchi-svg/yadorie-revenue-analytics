'use client'

// 各宿設定 → 従業員マスタ（手動追加・編集・削除）＋ アルバイト標準時給。
// 従業員は勤怠取込に依存せず登録可（未来のシフト作成用）。個人給与は持たない
// （正社員=全社設定の月額 / アルバイト=この宿の標準時給 / スポット=シフト作成で都度）。
import { useCallback, useEffect, useState } from 'react'
import { useFacility } from '@/lib/facility-context'
import { useToast } from '@/components/toast'
import { Loading } from '@/components/page-bits'
import {
  loadStaffRoster, addStaff, updateStaff, deleteStaff, saveStaffOrder,
  loadLaborRate, saveLaborRate, type StaffRow, type EmpType,
} from '@/lib/shift/data'

const EMP_TYPES: EmpType[] = ['正社員', 'アルバイト', 'スポット']
const EMP_COLOR: Record<string, string> = { 正社員: '#378ADD', アルバイト: '#2e9e6b', スポット: '#C99A2E' }

export default function StaffAdmin() {
  const { current } = useFacility()
  const toast = useToast()
  const [rows, setRows] = useState<StaffRow[]>([])
  const [rate, setRate] = useState('')
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)

  // 追加フォーム
  const [name, setName] = useState('')
  const [emp, setEmp] = useState<EmpType>('アルバイト')
  const [code, setCode] = useState('')

  const load = useCallback(async () => {
    if (!current) return
    setLoading(true)
    const [r, rt] = await Promise.all([loadStaffRoster(current), loadLaborRate(current)])
    setRows(r); setRate(rt != null ? String(rt) : '')
    setLoading(false)
  }, [current])
  useEffect(() => { load() }, [load])

  const add = async () => {
    if (!current) return
    if (!name.trim()) { toast('氏名を入力してください', 'error'); return }
    setBusy(true)
    const { error } = await addStaff(current, { name, employment_type: emp, staff_code: code })
    setBusy(false)
    if (error) { toast(`エラー: ${error}`, 'error'); return }
    toast(`${name}（${emp}）を追加しました`)
    setName(''); setCode(''); load()
  }

  const changeType = async (s: StaffRow, t: EmpType) => {
    const { error } = await updateStaff(s.staff_code, { employment_type: t })
    if (error) { toast(`エラー: ${error}`, 'error'); return }
    load()
  }
  const rename = async (s: StaffRow, v: string) => {
    if (v.trim() === (s.name ?? '')) return
    const { error } = await updateStaff(s.staff_code, { name: v })
    if (error) { toast(`エラー: ${error}`, 'error'); load() }
  }
  const move = async (i: number, dir: -1 | 1) => {
    const j = i + dir
    if (j < 0 || j >= rows.length) return
    const a = rows[i], b = rows[j]
    const soA = a.sort_order ?? (i + 1) * 10, soB = b.sort_order ?? (j + 1) * 10
    const { error } = await saveStaffOrder([{ staff_code: a.staff_code, sort_order: soB }, { staff_code: b.staff_code, sort_order: soA }])
    if (error) { toast(`エラー: ${error}`, 'error'); return }
    load()
  }
  const remove = async (s: StaffRow) => {
    if (!confirm(`${s.name ?? s.staff_code} を削除しますか？（シフト・勤怠がある従業員は削除できません）`)) return
    const { error } = await deleteStaff(s.staff_code)
    if (error) { toast(`削除できません: ${error}`, 'error'); return }
    toast('削除しました'); load()
  }

  const saveRate = async () => {
    if (!current) return
    const v = rate.trim() === '' ? null : Number(rate)
    if (v != null && (!Number.isFinite(v) || v <= 0)) { toast('正しい時給を入力してください', 'error'); return }
    setBusy(true)
    const { error } = await saveLaborRate(current, v)
    setBusy(false)
    if (error) { toast(`エラー: ${error}`, 'error'); return }
    toast(v == null ? '標準時給を解除しました' : '標準時給を保存しました')
  }

  if (loading) return <Loading />

  return (
    <section className="card p-5 mt-4">
      <h2 className="text-lg font-semibold mb-1">従業員・賃金設定</h2>
      <p className="text-xs mb-3" style={{ color: 'var(--text-dim)' }}>
        従業員はここで手動追加できます（勤怠取込を待たずに未来のシフト作成に使えます）。個人ごとの給与は持ちません。
        正社員の人件費は<b>全社設定の月額</b>、アルバイトは下の<b>宿の標準時給</b>、スポットは<b>シフト作成時に日当/時給</b>で設定します。
      </p>

      {/* アルバイト標準時給（宿ごと1本） */}
      <div className="rounded-md px-3 py-2 mb-4 flex items-center gap-2 flex-wrap" style={{ background: 'var(--surface2)' }}>
        <span className="text-xs font-medium">アルバイト標準時給（この宿・円/時）</span>
        <input type="number" min={0} className="field px-2 py-1 text-sm w-28 text-right" value={rate} placeholder="例: 1100" onChange={(e) => setRate(e.target.value)} />
        <button onClick={saveRate} disabled={busy} className="px-3 py-1.5 rounded-md text-sm text-white disabled:opacity-50" style={{ background: 'var(--accent)' }}>保存</button>
        <span className="text-[10px]" style={{ color: 'var(--text-dim)' }}>アルバイト人件費＝実働/計画時間 × この時給（個人差は持ちません）</span>
      </div>

      {/* 追加フォーム */}
      <div className="flex items-end gap-2 mb-3 flex-wrap">
        <div>
          <div className="text-[10px] mb-0.5" style={{ color: 'var(--text-dim)' }}>氏名</div>
          <input className="field px-2 py-1 text-sm w-40" value={name} placeholder="山田 太郎" onChange={(e) => setName(e.target.value)} />
        </div>
        <div>
          <div className="text-[10px] mb-0.5" style={{ color: 'var(--text-dim)' }}>区分</div>
          <select className="field px-2 py-1 text-sm" value={emp} onChange={(e) => setEmp(e.target.value as EmpType)}>
            {EMP_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        </div>
        <div>
          <div className="text-[10px] mb-0.5" style={{ color: 'var(--text-dim)' }}>勤怠コード（任意・KOT）</div>
          <input className="field px-2 py-1 text-sm w-36" value={code} placeholder="空なら自動採番" onChange={(e) => setCode(e.target.value)} />
        </div>
        <button onClick={add} disabled={busy} className="px-3 py-1.5 rounded-md text-sm text-white disabled:opacity-50" style={{ background: 'var(--accent)' }}>＋ 従業員を追加</button>
      </div>

      {/* 一覧 */}
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr style={{ color: 'var(--text-dim)' }} className="text-left">
              <th className="py-1.5 px-2">順</th>
              <th className="py-1.5 px-2">氏名</th>
              <th className="py-1.5 px-2">区分</th>
              <th className="py-1.5 px-2">勤怠コード</th>
              <th className="py-1.5 px-2">登録</th>
              <th className="py-1.5 px-2"></th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr><td colSpan={6} className="py-4 text-center text-xs" style={{ color: 'var(--text-dim)' }}>従業員がいません。上のフォームから追加してください。</td></tr>
            ) : rows.map((s, i) => (
              <tr key={s.staff_code} style={{ borderTop: '1px solid var(--border)' }}>
                <td className="py-1 px-2 whitespace-nowrap">
                  <button onClick={() => move(i, -1)} disabled={i === 0} className="text-xs px-1 disabled:opacity-30" title="上へ">▲</button>
                  <button onClick={() => move(i, 1)} disabled={i === rows.length - 1} className="text-xs px-1 disabled:opacity-30" title="下へ">▼</button>
                </td>
                <td className="py-1 px-2">
                  <input className="field px-2 py-1 text-sm w-40" defaultValue={s.name ?? ''} onBlur={(e) => rename(s, e.target.value)} />
                </td>
                <td className="py-1 px-2">
                  <select className="field px-2 py-1 text-sm" value={s.employment_type ?? 'アルバイト'} onChange={(e) => changeType(s, e.target.value as EmpType)}
                    style={{ color: EMP_COLOR[s.employment_type ?? ''] ?? undefined }}>
                    {EMP_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
                  </select>
                </td>
                <td className="py-1 px-2 text-xs" style={{ color: 'var(--text-dim)' }}>{s.staff_code}</td>
                <td className="py-1 px-2 text-[10px]" style={{ color: 'var(--text-dim)' }}>{s.source === 'manual' ? '手動' : '勤怠取込'}</td>
                <td className="py-1 px-2 text-right">
                  <button onClick={() => remove(s)} className="text-xs px-2 py-1 rounded" style={{ color: 'var(--red)' }}>削除</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-[10px] mt-2" style={{ color: 'var(--text-dim)' }}>
        勤怠取込（KOT）は勤怠コードで突合します。手動追加した従業員に実勤怠を紐づけたい場合は「勤怠コード」にKOTのコードを入れてください（空だと別人として扱われます）。
      </p>
    </section>
  )
}
