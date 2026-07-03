// サーバー専用: 施設プロフィール（AIコンテキスト基盤）をシステムプロンプト用テキストに整形。
// 参照: dim_facility_profile / raw_seasonality_note / raw_facility_initiative（直近12ヶ月・最大15件）
// テーブル未作成・未入力時は '' を返す（呼び出し側はそのまま連結してよい）。
import { PROFILE_SECTIONS } from '@/lib/facility-profile-def'

/* eslint-disable @typescript-eslint/no-explicit-any */
export async function buildFacilityContext(sb: any, facility: string): Promise<string> {
  try {
    const [p, s, ini] = await Promise.all([
      sb.from('dim_facility_profile').select('*').eq('facility', facility).maybeSingle(),
      sb.from('raw_seasonality_note').select('month, note').eq('facility', facility).order('month'),
      sb.from('raw_facility_initiative').select('year_month, category, title, description, status')
        .eq('facility', facility).order('year_month', { ascending: false }).limit(15),
    ])
    const prof = p?.data as Record<string, any> | null
    const notes = (s?.data as { month: number; note: string | null }[]) ?? []
    const inis = (ini?.data as { year_month: string; category: string | null; title: string; description: string | null; status: string | null }[]) ?? []

    const parts: string[] = []
    if (prof) {
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
    return `\n\n【施設プロフィール（この施設の意図・方針。分析・提案の前提として必ず考慮する）】\n` +
      `※プロフィール=意図、実績DB=事実。両者のギャップにも着目する。「避けたいこと・NG」に反する提案はしない。\n` +
      parts.join('\n\n')
  } catch {
    return '' // テーブル未作成等は無視（コンテキストなしで動作）
  }
}
