/* eslint-disable @typescript-eslint/no-explicit-any */
export async function fetchAll(build: () => any): Promise<any[]> {
  const size = 1000; let frm = 0; let all: any[] = []
  for (let i = 0; i < 50; i++) {
    const { data, error } = await build().range(frm, frm + size - 1)
    if (error || !data || data.length === 0) break
    all = all.concat(data); if (data.length < size) break; frm += size
  }
  return all
}
