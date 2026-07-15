'use client'

// 構造化ナレッジ（KPI辞書 / 用語集 / 基準PL）の管理タブ。
// ai_prompt/ai_knowledge と同じ作法: 行ごとに 下書き→公開・変更メモ必須・履歴・ロールバック。
// 閲覧=admin以上・編集/公開=owner（APIで強制）。
import { useCallback, useEffect, useMemo, useState } from 'react'
import { supabase } from '@/lib/supabase/client'

/* eslint-disable @typescript-eslint/no-explicit-any */
type Kind = 'kpi' | 'glossary' | 'standard_pl'
interface Field { k: string; label: string; type?: 'text' | 'textarea' | 'select' | 'number'; options?: [string, string][]; idOnly?: boolean; required?: boolean }
interface Config { title: string; newLabel: string; cols: { k: string; label: string }[]; fields: Field[]; rowId: (r: any) => string | number }

const TYPE_OPTS: [string, string][] = [
  ['', '—選択—'],
  ['小規模旅館', '小規模旅館'], ['温泉旅館', '温泉旅館'], ['小規模都市型ホテル', '小規模都市型ホテル'],
  ['中規模旅館', '中規模旅館'], ['都市型ホテル', '都市型ホテル'], ['高級旅館', '高級旅館'], ['大規模旅館', '大規模旅館'],
]
const DIR_OPTS: [string, string][] = [
  ['', '—（中立/未設定）'], ['higher_better', '高いほど良い'], ['lower_better', '低いほど良い'], ['neutral', '中立'],
]

const CONFIGS: Record<Kind, Config> = {
  kpi: {
    title: 'KPI辞書', newLabel: '＋ KPIを追加', rowId: (r) => r.kpi_key,
    cols: [{ k: 'kpi_key', label: 'キー' }, { k: 'label_ja', label: '名称' }, { k: 'unit', label: '単位' }, { k: 'direction', label: '方向' }],
    fields: [
      { k: 'kpi_key', label: 'KPIキー（英・一意）', idOnly: true, required: true },
      { k: 'label_ja', label: '名称（日本語）', required: true },
      { k: 'formula', label: '計算式（自由記述。空なら分子÷分母で整形）' },
      { k: 'numerator', label: '分子' },
      { k: 'denominator', label: '分母' },
      { k: 'unit', label: '単位（円 / % / 室 など）' },
      { k: 'direction', label: '方向', type: 'select', options: DIR_OPTS },
      { k: 'note', label: '目線・注意点（克樹さん加筆欄。空でも可）', type: 'textarea' },
    ],
  },
  glossary: {
    title: '用語集', newLabel: '＋ 用語を追加', rowId: (r) => r.term,
    cols: [{ k: 'term', label: '用語' }, { k: 'definition_ja', label: '定義' }],
    fields: [
      { k: 'term', label: '用語', idOnly: true, required: true },
      { k: 'definition_ja', label: '定義', type: 'textarea', required: true },
      { k: 'note', label: '補足（任意）', type: 'textarea' },
    ],
  },
  standard_pl: {
    title: '基準PL', newLabel: '＋ 基準値を追加', rowId: (r) => r.id,
    cols: [{ k: 'facility_type', label: '宿タイプ' }, { k: 'item_key', label: '項目' }, { k: 'value', label: '目標値' }, { k: 'unit', label: '単位' }],
    fields: [
      { k: 'facility_type', label: '宿タイプ', type: 'select', options: TYPE_OPTS, idOnly: true, required: true },
      { k: 'item_key', label: '項目キー（cogs_ratio / labor_ratio 等）', idOnly: true, required: true },
      { k: 'value', label: '目標値（率は 0.28 のように小数）', type: 'number' },
      { k: 'unit', label: '単位（ratio / yen など）' },
      { k: 'note', label: '補足（任意）', type: 'textarea' },
    ],
  },
}

const DIR_JA: Record<string, string> = { higher_better: '高いほど良い', lower_better: '低いほど良い', neutral: '中立' }

// プレビュー: 提案Eの文章化（1行分）。knowledge.ts の buildStructuredText と同じ整形。
function previewLine(kind: Kind, f: any): string {
  if (kind === 'kpi') {
    const calc = (f.formula ?? '').trim() ? String(f.formula).trim()
      : (f.numerator && f.denominator ? `${f.numerator} ÷ ${f.denominator}` : (f.numerator ?? f.denominator ?? '').toString().trim())
    let s = `- ${f.label_ja || '(名称未設定)'}（${f.kpi_key || 'key'}）:`
    if (calc) s += ` ${calc}。`
    if ((f.unit ?? '').toString().trim()) s += `単位${f.unit}。`
    if (f.direction && DIR_JA[f.direction]) s += `${DIR_JA[f.direction]}。`
    if ((f.note ?? '').toString().trim()) s += ` ※${String(f.note).trim()}`
    return s
  }
  if (kind === 'glossary') {
    return `- ${f.term || '(用語)'}: ${f.definition_ja || ''}${(f.note ?? '').toString().trim() ? `（${f.note}）` : ''}`
  }
  const v = f.value == null || f.value === '' ? '-' : String(f.value)
  const u = f.unit === 'ratio' ? '（率）' : (f.unit ?? '')
  return `- ${f.facility_type || '(タイプ)'}: ${f.item_key || 'item'}=${v}${u}`
}

export default function StructuredTab({ kind }: { kind: Kind }) {
  const cfg = CONFIGS[kind]
  const [rows, setRows] = useState<any[]>([])
  const [canEdit, setCanEdit] = useState(false)
  const [selId, setSelId] = useState<string | number | null>(null)
  const [isNew, setIsNew] = useState(false)
  const [form, setForm] = useState<any>({})
  const [preview, setPreview] = useState(false)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')
  const [versions, setVersions] = useState<any[]>([])
  const [showPublish, setShowPublish] = useState(false)
  const [note, setNote] = useState('')

  const call = useCallback(async (payload: any) => {
    const { data: { session } } = await supabase.auth.getSession()
    const res = await fetch('/api/admin/knowledge', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session?.access_token}` },
      body: JSON.stringify({ ...payload, kind }),
    })
    return res.json()
  }, [kind])

  const load = useCallback(async () => {
    const r = await call({ action: 'structList' })
    if (r.error) { setMsg(r.error); return }
    setRows(r.rows ?? [])
    setCanEdit(!!r.canEdit)
  }, [call])

  useEffect(() => { setSelId(null); setIsNew(false); setForm({}); setVersions([]); load() }, [load])

  const current = useMemo(() => rows.find((r) => cfg.rowId(r) === selId) ?? null, [rows, selId, cfg])
  const hasDraft = current ? current.draft_content != null : false

  const openRow = (r: any) => {
    setSelId(cfg.rowId(r)); setIsNew(false); setPreview(false); setVersions([]); setMsg('')
    setForm({ ...(r.draft_content ?? r) })
  }
  const openNew = () => {
    setSelId(null); setIsNew(true); setPreview(false); setVersions([]); setMsg('')
    setForm({})
  }

  // 送信用に value を数値化（standard_pl）
  const normalize = (f: any) => {
    const o = { ...f }
    if (kind === 'standard_pl') o.value = o.value === '' || o.value == null ? null : Number(o.value)
    return o
  }
  const missingRequired = cfg.fields.filter((fl) => fl.required && !(form[fl.k] ?? '').toString().trim()).map((fl) => fl.label)

  const saveDraft = async () => {
    if (missingRequired.length) { setMsg('必須項目が未入力: ' + missingRequired.join(' / ')); return }
    setBusy(true); setMsg('')
    const r = await call({ action: 'structSaveDraft', id: isNew ? null : selId, fields: normalize(form) })
    setBusy(false)
    if (r.error) { setMsg('エラー: ' + r.error); return }
    setMsg('下書きを保存しました')
    // 新規保存後は識別子で選択し直す
    const newId = isNew ? (kind === 'standard_pl' ? null : form[cfg.fields[0].k]) : selId
    await load()
    if (isNew && newId != null) { setSelId(newId); setIsNew(false) }
  }
  const doPublish = async () => {
    if (missingRequired.length) { setMsg('必須項目が未入力: ' + missingRequired.join(' / ')); return }
    setBusy(true); setMsg('')
    // 新規で未保存なら先に下書き作成 → 公開
    let id = selId
    if (isNew) {
      const c = await call({ action: 'structSaveDraft', id: null, fields: normalize(form) })
      if (c.error) { setBusy(false); setMsg('エラー: ' + c.error); return }
      await load()
      id = kind === 'standard_pl' ? null : form[cfg.fields[0].k]
      // standard_pl は id 未確定 → 一覧から一致行を探す
      if (kind === 'standard_pl') {
        const match = (rows.length ? rows : []).find((x) => x.facility_type === form.facility_type && x.item_key === form.item_key)
        id = match ? match.id : null
      }
    }
    const r = await call({ action: 'structPublish', id, fields: normalize(form), change_note: note })
    setBusy(false)
    if (r.error) { setMsg('エラー: ' + r.error); return }
    setShowPublish(false); setNote(''); setIsNew(false); setMsg('公開しました（灯への反映は最大60秒）')
    if (id != null) setSelId(id)
    load()
  }
  const loadVersions = async () => {
    if (selId == null) return
    const r = await call({ action: 'structVersions', id: selId })
    setVersions(r.versions ?? [])
  }
  const rollback = async (version_id: number) => {
    if (selId == null || !confirm('この版に戻します。よろしいですか？')) return
    setBusy(true)
    const r = await call({ action: 'structRollback', id: selId, version_id })
    setBusy(false)
    if (r.error) { setMsg('エラー: ' + r.error); return }
    setMsg('この版に戻しました'); setVersions([]); await load()
    const row = rows.find((x) => cfg.rowId(x) === selId)
    if (row) setForm({ ...row })
  }
  const del = async () => {
    if (selId == null || !confirm('この行を削除します。公開中なら灯からも消えます。よろしいですか？')) return
    setBusy(true)
    const r = await call({ action: 'structDelete', id: selId })
    setBusy(false)
    if (r.error) { setMsg('エラー: ' + r.error); return }
    setMsg('削除しました'); setSelId(null); setForm({}); load()
  }

  const publishDisabledForNew = kind === 'standard_pl' && isNew
  const editable = (fl: Field) => canEdit && !(fl.idOnly && !isNew)

  return (
    <div className="grid grid-cols-1 lg:grid-cols-[1fr_1fr] gap-4">
      {/* 一覧 */}
      <div className="card p-3">
        <div className="flex items-center justify-between mb-2">
          <p className="text-sm font-semibold">{cfg.title}（{rows.length}件）</p>
          {canEdit && <button onClick={openNew} className="px-3 py-1 rounded-md text-xs text-white" style={{ background: 'var(--accent)' }}>{cfg.newLabel}</button>}
        </div>
        {rows.length === 0 ? (
          <p className="text-xs py-6 text-center" style={{ color: 'var(--text-dim)' }}>まだ登録がありません。{canEdit ? '「追加」から作成できます。' : ''}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr style={{ color: 'var(--text-dim)' }}>
                  {cfg.cols.map((c) => <th key={c.k} className="text-left font-medium px-2 py-1">{c.label}</th>)}
                  <th className="px-2 py-1"></th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const id = cfg.rowId(r)
                  const active = id === selId
                  return (
                    <tr key={String(id)} onClick={() => openRow(r)} className="cursor-pointer"
                      style={{ background: active ? 'var(--accent)' : 'transparent', color: active ? '#fff' : 'var(--text)' }}>
                      {cfg.cols.map((c) => (
                        <td key={c.k} className="px-2 py-1.5 align-top" style={{ borderTop: '1px solid var(--border)' }}>
                          {c.k === 'direction' ? (DIR_JA[r[c.k]] ?? '') : String(r[c.k] ?? '')}
                        </td>
                      ))}
                      <td className="px-2 py-1.5 whitespace-nowrap" style={{ borderTop: '1px solid var(--border)' }}>
                        {r.status !== 'published'
                          ? <span className="text-[9px] px-1.5 py-0.5 rounded" style={{ background: 'var(--yellow)', color: '#000' }}>下書き</span>
                          : r.draft_content != null
                            ? <span className="text-[9px] px-1.5 py-0.5 rounded" style={{ background: 'var(--yellow)', color: '#000' }}>未公開の編集</span>
                            : <span className="text-[9px]" style={{ color: active ? '#fff' : 'var(--green)' }}>公開中</span>}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* 編集 */}
      <div className="card p-4 min-h-[50vh]">
        {!current && !isNew ? (
          <p className="text-sm" style={{ color: 'var(--text-dim)' }}>左の行を選ぶか「追加」を押してください。</p>
        ) : (
          <>
            <div className="flex items-center gap-2 mb-3 flex-wrap">
              <h3 className="text-base font-semibold">{isNew ? `新規${cfg.title}` : (form.label_ja || form.term || `${form.facility_type ?? ''} / ${form.item_key ?? ''}`)}</h3>
              {hasDraft && <span className="text-[10px] px-2 py-0.5 rounded" style={{ background: 'var(--yellow)', color: '#000' }}>未公開の下書きあり</span>}
              {!isNew && current && <span className="ml-auto text-[11px]" style={{ color: 'var(--text-dim)' }}>更新: {current.updated_at ? new Date(current.updated_at).toLocaleString('ja-JP') : '-'} {current.updated_by ? `by ${current.updated_by}` : ''}</span>}
            </div>

            {!canEdit && <p className="text-xs mb-2 p-2 rounded" style={{ background: 'var(--surface2)', color: 'var(--text-dim)' }}>閲覧のみ（編集はオーナー権限が必要です）。</p>}

            <div className="flex gap-1 mb-3">
              <button onClick={() => setPreview(false)} className="px-3 py-1 rounded-md text-xs" style={{ background: !preview ? 'var(--accent)' : 'var(--surface2)', color: !preview ? '#fff' : 'var(--text-dim)' }}>編集</button>
              <button onClick={() => setPreview(true)} className="px-3 py-1 rounded-md text-xs" style={{ background: preview ? 'var(--accent)' : 'var(--surface2)', color: preview ? '#fff' : 'var(--text-dim)' }}>灯に渡る文</button>
            </div>

            {preview ? (
              <div className="text-sm rounded-md p-3 font-mono" style={{ border: '1px solid var(--border)', background: 'var(--bg)', whiteSpace: 'pre-wrap' }}>{previewLine(kind, form)}</div>
            ) : (
              <div className="space-y-3">
                {cfg.fields.map((fl) => (
                  <div key={fl.k}>
                    <label className="block text-[11px] mb-1" style={{ color: 'var(--text-dim)' }}>
                      {fl.label}{fl.required && <span style={{ color: 'var(--red)' }}> *</span>}{fl.idOnly && !isNew && <span className="ml-1">（作成後は変更不可）</span>}
                    </label>
                    {fl.type === 'textarea' ? (
                      <textarea value={form[fl.k] ?? ''} disabled={!editable(fl)} onChange={(e) => setForm({ ...form, [fl.k]: e.target.value })}
                        className="field w-full text-sm p-2" style={{ minHeight: 70, lineHeight: 1.6 }} />
                    ) : fl.type === 'select' ? (
                      <select value={form[fl.k] ?? ''} disabled={!editable(fl)} onChange={(e) => setForm({ ...form, [fl.k]: e.target.value })}
                        className="field w-full text-sm p-2">
                        {(fl.options ?? []).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                      </select>
                    ) : (
                      <input type={fl.type === 'number' ? 'number' : 'text'} step="any" value={form[fl.k] ?? ''} disabled={!editable(fl)}
                        onChange={(e) => setForm({ ...form, [fl.k]: e.target.value })} className="field w-full text-sm p-2" />
                    )}
                  </div>
                ))}
              </div>
            )}

            {canEdit && (
              <div className="flex items-center gap-2 mt-4 flex-wrap">
                <button onClick={saveDraft} disabled={busy} className="px-4 py-1.5 rounded-md text-sm" style={{ border: '1px solid var(--border)', color: 'var(--text)' }}>下書き保存</button>
                <button onClick={() => setShowPublish(true)} disabled={busy || publishDisabledForNew} className="px-4 py-1.5 rounded-md text-sm text-white disabled:opacity-40" style={{ background: 'var(--accent)' }}>公開する</button>
                {!isNew && <button onClick={loadVersions} disabled={busy} className="px-4 py-1.5 rounded-md text-sm" style={{ border: '1px solid var(--border)', color: 'var(--text-dim)' }}>履歴</button>}
                {!isNew && <button onClick={del} disabled={busy} className="px-3 py-1.5 rounded-md text-sm ml-auto" style={{ border: '1px solid var(--red)', color: 'var(--red)' }}>削除</button>}
              </div>
            )}
            {publishDisabledForNew && <p className="text-[11px] mt-2" style={{ color: 'var(--text-dim)' }}>※基準PLの新規は一度「下書き保存」してから公開してください。</p>}

            {/* 履歴 */}
            {versions.length > 0 && (
              <div className="mt-4 rounded-md p-3" style={{ border: '1px solid var(--border)' }}>
                <h4 className="text-sm font-semibold mb-2">バージョン履歴</h4>
                <div className="space-y-1.5">
                  {versions.map((v) => (
                    <div key={v.id} className="text-xs py-1" style={{ borderBottom: '1px solid var(--border)' }}>
                      <div className="flex items-center gap-2">
                        <span style={{ color: 'var(--text-dim)' }}>{new Date(v.changed_at).toLocaleString('ja-JP')}</span>
                        <span className="flex-1">{v.change_note}</span>
                        <span style={{ color: 'var(--text-dim)' }}>{v.changed_by}</span>
                        {canEdit && <button onClick={() => rollback(v.id)} className="px-2 py-0.5 rounded" style={{ border: '1px solid var(--border)', color: 'var(--accent)' }}>この版に戻す</button>}
                      </div>
                      <div className="mt-1 font-mono" style={{ color: 'var(--text-dim)' }}>{previewLine(kind, v.content ?? {})}</div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </>
        )}
      </div>

      {msg && <p className="text-sm lg:col-span-2" style={{ color: msg.startsWith('エラー') || msg.startsWith('必須') ? 'var(--red)' : 'var(--green)' }}>{msg}</p>}

      {/* 公開モーダル */}
      {showPublish && (
        <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ background: 'rgba(0,0,0,.5)' }} onClick={() => setShowPublish(false)}>
          <div className="card p-5 w-full max-w-md" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-base font-semibold mb-1">公開</h3>
            <p className="text-xs mb-3" style={{ color: 'var(--text-dim)' }}>公開すると灯に反映されます（最大60秒）。変更メモは必須です。</p>
            <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="変更メモ（例: 稼働率の定義を全日ベースに）" className="field w-full px-3 py-2 text-sm mb-3" />
            <div className="flex justify-end gap-2">
              <button onClick={() => setShowPublish(false)} className="px-4 py-1.5 rounded-md text-sm" style={{ border: '1px solid var(--border)', color: 'var(--text-dim)' }}>キャンセル</button>
              <button onClick={doPublish} disabled={busy || !note.trim()} className="px-4 py-1.5 rounded-md text-sm text-white disabled:opacity-40" style={{ background: 'var(--accent)' }}>公開する</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
