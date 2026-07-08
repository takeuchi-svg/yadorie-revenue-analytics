// サーバー専用: 施設プロフィール（AIコンテキスト基盤）をシステムプロンプト用テキストに整形。
// 参照: dim_facility_profile / raw_seasonality_note / raw_facility_initiative（直近12ヶ月・最大15件）
// テーブル未作成・未入力時は '' を返す（呼び出し側はそのまま連結してよい）。
import { PROFILE_SECTIONS } from '@/lib/facility-profile-def'

const DEFAULT_PREAMBLE = `【施設プロフィール（この施設の意図・方針。分析・提案の前提として必ず考慮する）】
※プロフィール=意図、実績DB=事実。両者のギャップにも着目する。「避けたいこと・NG」に反する提案はしない。`

/* eslint-disable @typescript-eslint/no-explicit-any */
// preamble: 前文（正本=ai_prompt 'profile_context_template'。注入エンジンから渡される。省略時は既定文）
export async function buildFacilityContext(sb: any, facility: string, preamble?: string): Promise<string> {
  try {
    const [p, s, ini] = await Promise.all([
      sb.from('dim_facility_profile').select('*').eq('facility', facility).maybeSingle(),
      sb.from('raw_seasonality_note').select('month, note').eq('facility', facility).order('month'),
      sb.from('raw_facility_initiative').select('year_month, category, title, description, status')
        .eq('facility', facility).order('year_month', { ascending: false }).limit(15),
    ])
    const prof = p?.data as Record<string, any> | null

    // この施設タイプの基準PL（1タイプ分だけ。全タイプは重いので層2には載せない）
    let plLine = ''
    const ftype = (prof?.facility_type ?? '').toString().trim()
    if (ftype) {
      const pl = await sb.from('standard_pl_master')
        .select('item_key, value, unit').eq('facility_type', ftype).eq('status', 'published')
      const labels: Record<string, string> = {
        cogs_ratio: '原価率', labor_cost_ratio: '人件費率', sga_ratio: '販管費率',
        gop_ratio: 'GOP率', ebitda_ratio: 'EBITDA率', oi_ratio: '営業利益率',
        occ_target: '稼働率目標', adr_target: 'ADR目標',
      }
      const items = ((pl?.data as { item_key: string; value: number | null; unit: string | null }[]) ?? [])
        .filter((r) => r.value != null)
        .map((r) => `${labels[r.item_key] ?? r.item_key} ${r.unit === 'ratio' ? `${(Number(r.value) * 100).toFixed(1)}%` : Number(r.value).toLocaleString()}`)
      if (items.length) plLine = `【基準PL（この施設タイプ「${ftype}」の目標水準・対売上）】\n${items.join(' / ')}\n※水準の良し悪しはこの女将塾基準に照らして評価する`
    }
    const notes = (s?.data as { month: number; note: string | null }[]) ?? []
    const inis = (ini?.data as { year_month: string; category: string | null; title: string; description: string | null; status: string | null }[]) ?? []

    const parts: string[] = []
    if (prof) {
      // 施設タイプ＋基準PL（基準値があればセットで、無ければタイプのみ）
      if (plLine) parts.push(plLine)
      else if (ftype) parts.push(`【施設タイプ】${ftype}（水準評価は女将塾の基準PLのうち「${ftype}」の目標値に照らす）`)
      for (const sec of PROFILE_SECTIONS) {
        const lines = sec.fields
          .map((f) => ({ label: f.label.replace('（★必須）', ''), v: (prof[f.key] ?? '').toString().trim() }))
          .filter((x) => x.v)
          .map((x) => `- ${x.label}: ${x.v}`)
        if (lines.length) parts.push(`【${sec.title.replace(/（.*?）/, '')}】\n${lines.join('\n')}`)
      }
      if (prof.price_min || prof.price_max) {
        parts.push(`【価格帯】1泊2食 ${prof.price_min ? `¥${Number(prof.price_min).toLocaleString()}` : '?'} 〜 ${prof.price_max ? `¥${Number(prof.price_max).toLocaleString()}` : '?'}`)
      }
    }
    const noteLines = notes.filter((n) => (n.note ?? '').trim()).map((n) => `- ${n.month}月: ${n.note}`)
    if (noteLines.length) parts.push(`【繁閑の理由（毎年の季節性）】\n${noteLines.join('\n')}`)
    const iniLines = inis.map((i) => `- ${i.year_month} [${i.category ?? '-'}${i.status && i.status !== '実行' ? `/${i.status}` : ''}] ${i.title}${i.description ? `: ${i.description}` : ''}`)
    if (iniLines.length) parts.push(`【直近の取組履歴（事実。効果の成否は実績データで判断すること）】\n${iniLines.join('\n')}`)

    if (!parts.length) return ''
    return `\n\n${(preamble ?? DEFAULT_PREAMBLE).trim()}\n` + parts.join('\n\n')
  } catch {
    return '' // テーブル未作成等は無視（コンテキストなしで動作）
  }
}
