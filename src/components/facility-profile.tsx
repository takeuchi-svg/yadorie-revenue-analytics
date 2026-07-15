'use client'

// 宿プロフィール（AIコンテキスト基盤）F2-F4
// 正本: docs/要件定義書_宿プロフィール_AIコンテキスト.md
//   - プロフィール: セクション別アコーディオン＋上書き保存＋具体性ゲージ(R1)
//   - 繁閑理由: 暦月1〜12のインライン編集(upsert)
//   - 取組履歴: 追記のみ（編集・削除は当月分のみ許可）＋当月未記入アラート
import { useCallback, useEffect, useMemo, useState } from 'react'
import { supabase } from '@/lib/supabase/client'
import { useFacility } from '@/lib/facility-context'
import { PROFILE_SECTIONS, INITIATIVE_CATEGORIES, FACILITY_TYPES, concreteness, GAUGE_COLORS } from '@/lib/facility-profile-def'
import { useToast } from '@/components/toast'

/* eslint-disable @typescript-eslint/no-explicit-any */
interface Initiative { id: number; year_month: string; category: string | null; title: string; description: string | null; status: string | null; created_by: string | null }

const CAT_COLOR: Record<string, string> = {
  '食事': '#1D9E75', '接客': '#D85A30', '集客': '#378ADD', '設備': '#7F77DD',
  '価格': '#BA7517', 'オペレーション': '#888780', 'その他': '#B4B2A9',
}
const thisMonth = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}` }
// 年度(4月開始)の12ヶ月 'YYYY-MM'
function fyMonths(fy: string): string[] {
  const y = Number(fy); if (!y) return []
  const out: string[] = []
  for (let m = 4; m <= 12; m++) out.push(`${y}-${String(m).padStart(2, '0')}`)
  for (let m = 1; m <= 3; m++) out.push(`${y + 1}-${String(m).padStart(2, '0')}`)
  return out
}

function Gauge({ text }: { text: string }) {
  const { score, label } = concreteness(text)
  return (
    <span className="inline-flex items-center gap-1.5 shrink-0" title="具体性ゲージ: 固有名詞・数値・適正な長さで緑になります">
      <span className="flex gap-0.5">
        {[0, 1, 2, 3].map((i) => (
          <span key={i} className="inline-block w-3 h-1.5 rounded-sm"
            style={{ background: i <= score && text.trim() ? GAUGE_COLORS[score] : 'var(--border)' }} />
        ))}
      </span>
      <span className="text-[9px]" style={{ color: text.trim() ? GAUGE_COLORS[score] : 'var(--text-dim)' }}>{label}</span>
    </span>
  )
}

export default function FacilityProfile() {
  const { current, currentFacility } = useFacility()
  const toast = useToast()
  const [profile, setProfile] = useState<Record<string, any>>({})
  const [totalRooms, setTotalRooms] = useState<number | ''>('')  // dim_facility.total_rooms（旧・設定/宿マスタから統合）
  const [opRooms, setOpRooms] = useState<Record<string, number | ''>>({})  // 月別客室数の上書き（改装時のみ・旧設定から統合）
  const [opFy, setOpFy] = useState('')
  const [opFys, setOpFys] = useState<string[]>([])
  const [dirty, setDirty] = useState(false)
  const [openSec, setOpenSec] = useState<Set<number>>(new Set([0]))
  const [seasonal, setSeasonal] = useState<Record<number, string>>({})
  const [seasonalDirty, setSeasonalDirty] = useState(false)
  const [initiatives, setInitiatives] = useState<Initiative[]>([])
  const [saving, setSaving] = useState(false)
  // 取組追加フォーム
  const [showAdd, setShowAdd] = useState(false)
  const [niCat, setNiCat] = useState<string>('食事')
  const [niTitle, setNiTitle] = useState('')
  const [niDesc, setNiDesc] = useState('')
  const [niStatus, setNiStatus] = useState('実行')

  const reload = useCallback(async () => {
    if (!current) return
    const [p, s, ini] = await Promise.all([
      supabase.from('dim_facility_profile').select('*').eq('facility', current).maybeSingle(),
      supabase.from('raw_seasonality_note').select('month, note').eq('facility', current),
      supabase.from('raw_facility_initiative').select('id, year_month, category, title, description, status, created_by')
        .eq('facility', current).order('year_month', { ascending: false }).order('id', { ascending: false }).limit(100),
    ])
    setProfile((p.data as any) ?? {})
    const sm: Record<number, string> = {}
    ;((s.data as { month: number; note: string | null }[]) ?? []).forEach((r) => { sm[r.month] = r.note ?? '' })
    setSeasonal(sm)
    setInitiatives((ini.data as Initiative[]) ?? [])
    setDirty(false); setSeasonalDirty(false)
  }, [current])
  useEffect(() => { reload() }, [reload])
  useEffect(() => { setTotalRooms(currentFacility?.total_rooms ?? '') }, [currentFacility])

  // 月別客室数: 年度候補と選択年度の値を読み込み
  useEffect(() => {
    if (!current) return
    supabase.from('budget_monthly').select('fiscal_year').eq('facility', current).then(({ data }) => {
      const fys = [...new Set(((data as { fiscal_year: string }[]) ?? []).map((r) => r.fiscal_year))].sort().reverse()
      setOpFys(fys)
      setOpFy((prev) => (fys.includes(prev) ? prev : fys[0] ?? ''))
    })
  }, [current])
  useEffect(() => {
    if (!current || !opFy) return
    const months = fyMonths(opFy)
    supabase.from('dim_operating_days').select('month, rooms').eq('facility', current).in('month', months).then(({ data }) => {
      const rmap: Record<string, number | ''> = {}
      months.forEach((m) => { rmap[m] = '' })
      ;((data as { month: string; rooms: number | null }[]) ?? []).forEach((r) => { rmap[r.month] = r.rooms ?? '' })
      setOpRooms(rmap)
    })
  }, [current, opFy])

  const setField = (k: string, v: any) => { setProfile((prev) => ({ ...prev, [k]: v })); setDirty(true) }

  const saveProfile = async () => {
    setSaving(true)
    const { data: { user } } = await supabase.auth.getUser()
    const row: Record<string, any> = { facility: current, updated_at: new Date().toISOString(), updated_by: user?.email ?? null }
    for (const sec of PROFILE_SECTIONS) for (const f of sec.fields) row[f.key] = profile[f.key] || null
    row.price_min = profile.price_min || null
    row.price_max = profile.price_max || null
    row.facility_type = profile.facility_type || null   // 基準PL照合用の宿タイプ
    const { error } = await supabase.from('dim_facility_profile').upsert(row, { onConflict: 'facility' })
    // 総客室数は dim_facility（旧・設定/宿マスタから統合。予実の在庫数等で使用）
    const { error: e2 } = await supabase.from('dim_facility')
      .update({ total_rooms: totalRooms === '' ? null : Number(totalRooms), updated_at: new Date().toISOString() })
      .eq('facility', current)
    // 月別客室数の上書き（改装時のみ）。選択年度の全月を value-or-null で upsert（空欄化にも対応）
    let e3: { message: string } | null = null
    if (opFy) {
      const roomRows = fyMonths(opFy).map((m) => ({
        facility: current, month: m,
        rooms: opRooms[m] === '' || opRooms[m] == null ? null : Number(opRooms[m]),
        updated_at: new Date().toISOString(),
      }))
      const r = await supabase.from('dim_operating_days').upsert(roomRows, { onConflict: 'facility,month' })
      e3 = r.error
    }
    const err = error ?? e2 ?? e3
    toast(err ? `エラー: ${err.message}` : 'プロフィールを保存しました', err ? 'error' : 'success')
    if (!err) setDirty(false)
    setSaving(false)
  }

  const saveSeasonal = async () => {
    setSaving(true)
    const rows = Object.entries(seasonal).filter(([, v]) => v.trim() !== '')
      .map(([m, note]) => ({ facility: current, month: Number(m), note, updated_at: new Date().toISOString() }))
    const { error } = rows.length
      ? await supabase.from('raw_seasonality_note').upsert(rows, { onConflict: 'facility,month' })
      : { error: null }
    toast(error ? `エラー: ${error.message}` : '繁閑理由を保存しました', error ? 'error' : 'success')
    if (!error) setSeasonalDirty(false)
    setSaving(false)
  }

  const addInitiative = async () => {
    if (!niTitle.trim()) { toast('取組の見出しを入力してください', 'error'); return }
    setSaving(true)
    const { data: { user } } = await supabase.auth.getUser()
    const { error } = await supabase.from('raw_facility_initiative').insert({
      facility: current, year_month: thisMonth(), category: niCat,
      title: niTitle.trim(), description: niDesc.trim() || null, status: niStatus,
      created_by: user?.email ?? null,
    })
    toast(error ? `エラー: ${error.message}` : '取組を記録しました', error ? 'error' : 'success')
    if (!error) { setShowAdd(false); setNiTitle(''); setNiDesc(''); reload() }
    setSaving(false)
  }

  const deleteInitiative = async (row: Initiative) => {
    if (row.year_month !== thisMonth()) return // 過去分は不変（要件§3.2）
    if (!confirm(`「${row.title}」を削除しますか？（当月分のみ削除可能）`)) return
    await supabase.from('raw_facility_initiative').delete().eq('id', row.id)
    reload()
  }

  const currentMonthMissing = useMemo(() => !initiatives.some((i) => i.year_month === thisMonth()), [initiatives])
  const requiredMissing = PROFILE_SECTIONS.flatMap((s) => s.fields).filter((f) => f.required && !(profile[f.key] ?? '').trim())

  return (
    <section className="card p-6 mt-6">
      <div className="flex items-center justify-between mb-1 flex-wrap gap-2">
        <h2 className="text-lg font-semibold">宿プロフィール</h2>
        <button onClick={saveProfile} disabled={saving || !dirty}
          className="px-4 py-1.5 bg-[var(--accent)] text-white rounded-md text-sm hover:opacity-90 disabled:opacity-50">
          {dirty ? 'プロフィールを保存' : '保存済み'}
        </button>
      </div>

      {/* アラート */}
      {(currentMonthMissing || requiredMissing.length > 0) && (
        <div className="rounded-md p-3 mb-4 text-xs space-y-1" style={{ background: 'var(--surface2)', borderLeft: '3px solid var(--red)' }}>
          {currentMonthMissing && <p><span className="px-1.5 py-0.5 rounded text-white text-[10px] mr-1" style={{ background: 'var(--red)' }}>未記録</span>{thisMonth()} の取組が未記録です（下の「＋今月の取組を追加」から）</p>}
          {requiredMissing.length > 0 && <p><span className="px-1.5 py-0.5 rounded text-white text-[10px] mr-1" style={{ background: 'var(--red)' }}>必須</span>{requiredMissing.map((f) => f.label.replace('（★必須）', '')).join('・')} が未入力です</p>}
        </div>
      )}

      {/* プロフィール: セクション別アコーディオン */}
      <div className="space-y-2 mb-5">
        {PROFILE_SECTIONS.map((sec, si) => (
          <div key={sec.title} className="rounded-md" style={{ border: '1px solid var(--border)' }}>
            <button className="w-full flex items-center px-3 py-2 text-sm font-semibold"
              onClick={() => setOpenSec((prev) => { const n = new Set(prev); n.has(si) ? n.delete(si) : n.add(si); return n })}>
              <span style={{ color: 'var(--text-dim)', width: 14 }}>{openSec.has(si) ? '▾' : '▸'}</span>
              {sec.title}
              <span className="ml-2 text-[10px] font-normal" style={{ color: 'var(--text-dim)' }}>
                {sec.fields.filter((f) => (profile[f.key] ?? '').trim()).length}/{sec.fields.length} 入力済み
              </span>
            </button>
            {openSec.has(si) && (
              <div className="px-3 pb-3 space-y-3">
                {sec.note && <p className="text-[11px]" style={{ color: 'var(--red)' }}>{sec.note}</p>}
                {sec.fields.map((f) => (
                  <div key={f.key}>
                    <div className="flex items-center justify-between mb-1 gap-2">
                      <label className="text-xs font-medium" style={{ color: f.required && !(profile[f.key] ?? '').trim() ? 'var(--red)' : 'var(--text-dim)' }}>{f.label}</label>
                      <Gauge text={profile[f.key] ?? ''} />
                    </div>
                    <textarea className="field px-3 py-2 text-sm w-full" rows={f.rows ?? 1}
                      placeholder={f.placeholder} value={profile[f.key] ?? ''}
                      onChange={(e) => setField(f.key, e.target.value)} />
                  </div>
                ))}
                {si === 0 && (
                  <>
                    <div className="flex gap-4 flex-wrap">
                      <div>
                        <label className="block text-xs font-medium mb-1" style={{ color: 'var(--text-dim)' }}>宿タイプ（基準PL・横断比較の区分）</label>
                        <select className="field px-3 py-1.5 text-sm" style={{ minWidth: 180 }}
                          value={profile.facility_type ?? ''} onChange={(e) => setField('facility_type', e.target.value)}>
                          <option value="">（未設定）</option>
                          {FACILITY_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
                        </select>
                      </div>
                      <div>
                        <label className="block text-xs font-medium mb-1" style={{ color: 'var(--text-dim)' }}>総客室数（稼働率・予実の在庫数に使用）</label>
                        <input type="number" min={0} className="field px-3 py-1.5 text-sm w-32"
                          value={totalRooms} onChange={(e) => { setTotalRooms(e.target.value === '' ? '' : Number(e.target.value)); setDirty(true) }} />
                      </div>
                      <div>
                        <label className="block text-xs font-medium mb-1" style={{ color: 'var(--text-dim)' }}>最低価格帯（1泊2食・円）</label>
                        <input type="number" min={0} className="field px-3 py-1.5 text-sm w-32"
                          value={profile.price_min ?? ''} onChange={(e) => setField('price_min', e.target.value === '' ? null : Number(e.target.value))} />
                      </div>
                      <div>
                        <label className="block text-xs font-medium mb-1" style={{ color: 'var(--text-dim)' }}>最高ランク（1泊2食・円）</label>
                        <input type="number" min={0} className="field px-3 py-1.5 text-sm w-32"
                          value={profile.price_max ?? ''} onChange={(e) => setField('price_max', e.target.value === '' ? null : Number(e.target.value))} />
                      </div>
                    </div>
                    {/* 月別客室数の上書き（改装時のみ・旧設定から統合） */}
                    <div className="mt-4 rounded-md p-3" style={{ border: '1px solid var(--border)' }}>
                      <div className="flex items-center justify-between mb-1 flex-wrap gap-2">
                        <label className="text-xs font-medium" style={{ color: 'var(--text-dim)' }}>月別客室数（毎年・全月入力。空欄の月は総客室数 {totalRooms || '-'} を使用）</label>
                        {opFys.length > 0 && (
                          <select className="field px-2 py-1 text-xs" value={opFy} onChange={(e) => setOpFy(e.target.value)}>
                            {opFys.map((y) => <option key={y} value={y}>{y}年度</option>)}
                          </select>
                        )}
                      </div>
                      <p className="text-[10px] mb-2" style={{ color: 'var(--text-dim)' }}>毎年、各月の客室数を入力してください（改装・季節休館などで月ごとに変わる分を反映）。稼働日数は販売実績のある日数から自動算出のため入力不要です。</p>
                      <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-6 gap-2">
                        {fyMonths(opFy).map((m) => (
                          <div key={m}>
                            <span className="block text-[10px] mb-0.5" style={{ color: 'var(--text-dim)' }}>{m.slice(5)}月（{m.slice(0, 4)}）</span>
                            <input type="number" min={0} className="field px-2 py-1 text-xs w-full"
                              placeholder={`${totalRooms || '-'}室`}
                              value={opRooms[m] ?? ''}
                              onChange={(e) => { setOpRooms((p) => ({ ...p, [m]: e.target.value === '' ? '' : Number(e.target.value) })); setDirty(true) }} />
                          </div>
                        ))}
                      </div>
                    </div>
                  </>
                )}
              </div>
            )}
          </div>
        ))}
      </div>

      {/* 繁閑理由（暦月） */}
      <div className="rounded-md p-3 mb-5" style={{ border: '1px solid var(--border)' }}>
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-sm font-semibold">繁閑の理由（暦月・毎年共通の季節性）</h3>
          <button onClick={saveSeasonal} disabled={saving || !seasonalDirty}
            className="px-3 py-1 text-xs rounded-md text-white hover:opacity-90 disabled:opacity-50" style={{ background: 'var(--accent)' }}>保存</button>
        </div>
        <p className="text-[11px] mb-2" style={{ color: 'var(--text-dim)' }}>数値の繁閑はDBが持っています。ここには「なぜその月が忙しい/暇か」だけを書きます（例: 2月=河津桜まつりで急増）。特定年だけの事情は取組履歴へ。</p>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-x-4 gap-y-1.5">
          {Array.from({ length: 12 }, (_, i) => i + 1).map((m) => (
            <div key={m} className="flex items-center gap-2">
              <span className="text-xs w-9 shrink-0 text-right" style={{ color: 'var(--text-dim)' }}>{m}月</span>
              <input className="field px-2 py-1 text-xs flex-1" placeholder={m === 2 ? '例: 河津桜まつりで急増' : ''}
                value={seasonal[m] ?? ''}
                onChange={(e) => { setSeasonal((prev) => ({ ...prev, [m]: e.target.value })); setSeasonalDirty(true) }} />
            </div>
          ))}
        </div>
      </div>

      {/* 取組履歴 */}
      <div className="rounded-md p-3" style={{ border: '1px solid var(--border)' }}>
        <div className="flex items-center justify-between mb-2 flex-wrap gap-2">
          <h3 className="text-sm font-semibold">取組履歴（トライ&エラーの記録）
            {currentMonthMissing && <span className="ml-2 px-1.5 py-0.5 rounded text-white text-[10px]" style={{ background: 'var(--red)' }}>{thisMonth()} 未記録</span>}
          </h3>
          <button onClick={() => setShowAdd((v) => !v)}
            className="px-3 py-1 text-xs rounded-md text-white hover:opacity-90" style={{ background: 'var(--accent)' }}>＋ 今月の取組を追加</button>
        </div>
        <p className="text-[11px] mb-2" style={{ color: 'var(--text-dim)' }}>「何をやったか」の事実だけを記録します。うまくいったか等の主観は書きません。過去分は編集不可。</p>

        {showAdd && (
          <div className="rounded-md p-3 mb-3 space-y-2" style={{ background: 'var(--surface2)' }}>
            <div className="flex gap-2 flex-wrap">
              <select className="field px-2 py-1.5 text-xs" value={niCat} onChange={(e) => setNiCat(e.target.value)}>
                {INITIATIVE_CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
              <select className="field px-2 py-1.5 text-xs" value={niStatus} onChange={(e) => setNiStatus(e.target.value)}>
                {['計画', '実行', '完了'].map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
              <span className="text-xs self-center" style={{ color: 'var(--text-dim)' }}>{thisMonth()}</span>
            </div>
            <input className="field px-3 py-1.5 text-sm w-full" placeholder="見出し（例: 朝食の干物を桜えび釜飯に変更）"
              value={niTitle} onChange={(e) => setNiTitle(e.target.value)} />
            <div className="flex items-start gap-2">
              <textarea className="field px-3 py-1.5 text-sm flex-1" rows={2}
                placeholder="何をやったかの事実（100-200字目安）。例: 3月1日から朝食の主菜を干物から桜えび釜飯に変更。仕入は由比の◯◯商店。"
                value={niDesc} onChange={(e) => setNiDesc(e.target.value)} />
              <Gauge text={niDesc} />
            </div>
            <div className="flex gap-2">
              <button onClick={addInitiative} disabled={saving} className="px-4 py-1.5 text-xs rounded-md text-white hover:opacity-90 disabled:opacity-50" style={{ background: 'var(--accent)' }}>記録する</button>
              <button onClick={() => setShowAdd(false)} className="px-3 py-1.5 text-xs rounded-md" style={{ border: '1px solid var(--border)' }}>キャンセル</button>
            </div>
          </div>
        )}

        {initiatives.length === 0 ? (
          <p className="text-xs py-4 text-center" style={{ color: 'var(--text-dim)' }}>まだ記録がありません。月次会議の後に「今月やったこと」を記録する運用がおすすめです。</p>
        ) : (
          <div className="space-y-1.5 max-h-80 overflow-y-auto">
            {initiatives.map((i) => (
              <div key={i.id} className="flex items-start gap-2 rounded-md px-3 py-2" style={{ background: 'var(--surface2)' }}>
                <span className="text-[10px] shrink-0 mt-0.5" style={{ color: 'var(--text-dim)' }}>{i.year_month}</span>
                <span className="text-[9px] px-1.5 py-0.5 rounded text-white shrink-0 mt-0.5" style={{ background: CAT_COLOR[i.category ?? 'その他'] ?? '#888780' }}>{i.category ?? '-'}</span>
                <div className="flex-1 min-w-0">
                  <span className="text-xs font-medium">{i.title}</span>
                  {i.status && i.status !== '実行' && <span className="ml-1 text-[9px] px-1 rounded" style={{ background: 'var(--surface)', color: 'var(--text-dim)' }}>{i.status}</span>}
                  {i.description && <p className="text-[11px] mt-0.5" style={{ color: 'var(--text-dim)' }}>{i.description}</p>}
                </div>
                {i.year_month === thisMonth() && (
                  <button onClick={() => deleteInitiative(i)} className="text-xs shrink-0 hover:opacity-70" style={{ color: 'var(--text-dim)' }} title="当月分のみ削除可">×</button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

    </section>
  )
}
