// 共通フォーマッタ & チャート設定（UI仕様書 §1.3 / §1.4 準拠）

export function fmtNum(n: number | null | undefined): string {
  if (n === null || n === undefined) return '-'
  return Math.round(n).toLocaleString()
}

export function fmtYen(n: number | null | undefined): string {
  if (n === null || n === undefined) return '-'
  return `¥${Math.round(n).toLocaleString()}`
}

// 金額（大）: ¥15.91M
export function fmtYenM(n: number | null | undefined): string {
  if (n === null || n === undefined) return '-'
  return `¥${(n / 1e6).toFixed(2)}M`
}

export function pct(n: number | null | undefined): string {
  if (n === null || n === undefined) return '-'
  return `${(n * 100).toFixed(1)}%`
}

// チャネル別カラー（UI仕様書 §1.3 全ページ統一）
const CHANNEL_COLORS: { test: RegExp; color: string }[] = [
  { test: /tripla|自社/i, color: '#D85A30' },
  { test: /一休/i, color: '#7F77DD' },
  { test: /じゃらん/i, color: '#1D9E75' },
  { test: /楽天/i, color: '#378ADD' },
  { test: /booking/i, color: '#D4537E' },
]
const FALLBACK_PALETTE = ['#6366f1', '#22c55e', '#f59e0b', '#ef4444', '#06b6d4', '#a855f7', '#84cc16']

export function channelColor(name: string, index = 0): string {
  for (const c of CHANNEL_COLORS) if (c.test.test(name)) return c.color
  if (/直予約|その他/.test(name)) return '#888780'
  return FALLBACK_PALETTE[index % FALLBACK_PALETTE.length]
}

// Recharts 共通スタイル（ダーク）
export const CHART_AXIS = {
  tick: { fill: '#8b8fa3', fontSize: 11 },
  axisLine: { stroke: '#2e3347' },
  tickLine: { stroke: '#2e3347' },
}

export const chartTooltip = {
  contentStyle: {
    background: '#1a1d27',
    border: '1px solid #2e3347',
    borderRadius: 8,
    color: '#e4e6f0',
    fontSize: 12,
  },
  labelStyle: { color: '#8b8fa3' },
}
