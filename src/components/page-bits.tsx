'use client'

export function PageHeader({
  title, subtitle, month, months, onMonth,
}: {
  title: string
  subtitle: string
  month?: string
  months?: string[]
  onMonth?: (m: string) => void
}) {
  return (
    <div className="flex items-end justify-between mb-6">
      <div>
        <h1 className="text-2xl font-bold mb-1">{title}</h1>
        <p className="text-sm" style={{ color: 'var(--text-dim)' }}>{subtitle}</p>
      </div>
      {months && months.length > 0 && onMonth && (
        <select className="field px-3 py-1.5 text-sm" value={month} onChange={(e) => onMonth(e.target.value)}>
          {months.map((m) => <option key={m} value={m}>{m}</option>)}
        </select>
      )}
    </div>
  )
}

export function Kpi({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="card p-4">
      <p className="text-xs mb-1" style={{ color: 'var(--text-dim)' }}>{label}</p>
      <p className="text-xl font-bold" style={{ color: accent ? 'var(--accent)' : 'var(--text)' }}>{value}</p>
    </div>
  )
}

// 水引ローディング（YADORIE Core §6: 待ち時間すら世界観に）
export function Loading() {
  return (
    <div className="flex flex-col items-center justify-center py-12 gap-2">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src="/mizuhiki.png" alt="" className="mizuhiki-loading" style={{ width: 46, height: 'auto' }} />
      <p className="text-xs" style={{ color: 'var(--text-dim)' }}>結んでいます…</p>
    </div>
  )
}

export function Empty({ message }: { message?: string }) {
  return (
    <div className="card p-6 text-center" style={{ borderColor: 'var(--yellow)' }}>
      <p className="font-medium" style={{ color: 'var(--yellow)' }}>データ未登録</p>
      <p className="text-sm mt-1" style={{ color: 'var(--text-dim)' }}>
        {message ?? '/upload からファイルをアップロードしてください'}
      </p>
    </div>
  )
}

// 取得エラー表示（「データ未登録」と区別する。再試行はリロードで）
export function LoadError({ message }: { message: string }) {
  return (
    <div className="card p-6 text-center" style={{ borderColor: 'var(--red)' }}>
      <p className="font-medium" style={{ color: 'var(--red)' }}>データ取得エラー</p>
      <p className="text-sm mt-1" style={{ color: 'var(--text-dim)' }}>{message}</p>
      <p className="text-xs mt-2" style={{ color: 'var(--text-dim)' }}>通信状況を確認し、ページを再読み込みしてください（データ未登録とは異なります）。</p>
    </div>
  )
}

export function NotConnected({ message }: { message: string }) {
  return (
    <div className="card p-6 text-center" style={{ borderColor: 'var(--border)' }}>
      <p className="font-medium" style={{ color: 'var(--text-dim)' }}>データ未接続</p>
      <p className="text-sm mt-1" style={{ color: 'var(--text-dim)' }}>{message}</p>
    </div>
  )
}
