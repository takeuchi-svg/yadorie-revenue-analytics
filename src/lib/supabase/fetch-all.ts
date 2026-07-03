/* eslint-disable @typescript-eslint/no-explicit-any */
// Supabase REST の1000行上限を .range() ページングで回避する共通ユーティリティ。
// エラーは throw する（部分データを黙って返さない）。呼び出し側で catch してエラー表示すること。
export async function fetchAll(build: () => any): Promise<any[]> {
  const size = 1000; const maxPages = 50
  let frm = 0; let all: any[] = []
  for (let i = 0; i < maxPages; i++) {
    const { data, error } = await build().range(frm, frm + size - 1)
    if (error) throw new Error(`データ取得に失敗しました: ${error.message}`)
    if (!data || data.length === 0) break
    all = all.concat(data)
    if (data.length < size) break
    frm += size
    if (i === maxPages - 1) {
      // 上限到達＝これ以降の行は取得できていない。呼び出し側の絞り込み(期間等)を見直すこと
      console.warn(`fetchAll: ${maxPages * size}行の上限に到達。結果が欠けている可能性があります`)
    }
  }
  return all
}
