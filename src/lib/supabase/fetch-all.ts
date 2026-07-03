/* eslint-disable @typescript-eslint/no-explicit-any */
// Supabase REST の1000行上限を .range() ページングで回避する共通ユーティリティ。
// 型: fetchAll<T>(() => query) で行の型を指定できる（省略時 any）。
// エラーは throw する（部分データを黙って返さない）。呼び出し側で catch してエラー表示すること。
export async function fetchAll<T = any>(build: () => any): Promise<T[]> {
  const size = 1000; const maxPages = 50
  let frm = 0; let all: T[] = []
  for (let i = 0; i < maxPages; i++) {
    const { data, error } = await build().range(frm, frm + size - 1)
    if (error) throw new Error(`データ取得に失敗しました: ${error.message}`)
    if (!data || data.length === 0) break
    all = all.concat(data as T[])
    if (data.length < size) break
    frm += size
    if (i === maxPages - 1) {
      console.warn(`fetchAll: ${maxPages * size}行の上限に到達。結果が欠けている可能性があります`)
    }
  }
  return all
}
