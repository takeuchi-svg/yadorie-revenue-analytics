'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { supabase } from '@/lib/supabase/client'

export default function LoginPage() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [mode, setMode] = useState<'login' | 'forgot'>('login')
  const [notice, setNotice] = useState('')
  const router = useRouter()

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault()
    setLoading(true)
    setError('')

    const { error } = await supabase.auth.signInWithPassword({ email, password })

    if (error) {
      setError(error.message)
      setLoading(false)
      return
    }

    router.push('/')
    router.refresh()
  }

  const handleForgot = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!email) { setError('メールアドレスを入力してください'); return }
    setLoading(true); setError(''); setNotice('')
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${window.location.origin}/reset-password`,
    })
    setLoading(false)
    if (error) { setError(error.message); return }
    setNotice('パスワード再設定用のメールを送信しました。メール内のリンクから再設定してください。')
  }

  return (
    <div className="min-h-screen flex items-center justify-center" style={{ background: 'var(--bg)' }}>
      <div className="w-full max-w-sm">
        <div className="card p-8">
          <div className="text-center mb-6">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/yadorie-logo.png" alt="YADORIE宿GROUP" style={{ height: 44, width: 'auto' }} className="mx-auto mb-2" />
            <div className="text-sm font-bold tracking-wide">Core</div>
            <div className="text-xs" style={{ color: 'var(--text-dim)' }}>宿の数だけ、ストーリー。</div>
          </div>

          {mode === 'login' ? (
            <form onSubmit={handleLogin} className="space-y-4">
              <div>
                <label className="block text-sm font-medium mb-1" style={{ color: 'var(--text-dim)' }}>
                  メールアドレス
                </label>
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="field w-full px-3 py-2 text-sm"
                  required
                />
              </div>

              <div>
                <label className="block text-sm font-medium mb-1" style={{ color: 'var(--text-dim)' }}>
                  パスワード
                </label>
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="field w-full px-3 py-2 text-sm"
                  required
                />
              </div>

              {error && (
                <p className="text-sm" style={{ color: 'var(--red)' }}>{error}</p>
              )}

              <button
                type="submit"
                disabled={loading}
                className="w-full py-2 text-white rounded-md font-medium hover:opacity-90 disabled:opacity-50"
                style={{ background: 'var(--accent)' }}
              >
                {loading ? 'ログイン中...' : 'ログイン'}
              </button>

              <button type="button" onClick={() => { setMode('forgot'); setError(''); setNotice('') }}
                className="w-full text-center text-xs hover:opacity-80" style={{ color: 'var(--text-dim)' }}>
                パスワードをお忘れの方はこちら
              </button>
            </form>
          ) : (
            <form onSubmit={handleForgot} className="space-y-4">
              <p className="text-xs" style={{ color: 'var(--text-dim)' }}>
                登録メールアドレスを入力してください。パスワード再設定用のリンクをお送りします。
              </p>
              <div>
                <label className="block text-sm font-medium mb-1" style={{ color: 'var(--text-dim)' }}>
                  メールアドレス
                </label>
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="field w-full px-3 py-2 text-sm"
                  required
                />
              </div>

              {error && <p className="text-sm" style={{ color: 'var(--red)' }}>{error}</p>}
              {notice && <p className="text-sm" style={{ color: 'var(--green)' }}>{notice}</p>}

              <button
                type="submit"
                disabled={loading}
                className="w-full py-2 text-white rounded-md font-medium hover:opacity-90 disabled:opacity-50"
                style={{ background: 'var(--accent)' }}
              >
                {loading ? '送信中...' : '再設定メールを送信'}
              </button>

              <button type="button" onClick={() => { setMode('login'); setError(''); setNotice('') }}
                className="w-full text-center text-xs hover:opacity-80" style={{ color: 'var(--text-dim)' }}>
                ← ログインに戻る
              </button>
            </form>
          )}
        </div>
      </div>
    </div>
  )
}
