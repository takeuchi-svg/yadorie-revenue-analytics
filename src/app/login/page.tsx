'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { supabase } from '@/lib/supabase/client'

export default function LoginPage() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
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

  return (
    <div className="min-h-screen flex items-center justify-center" style={{ background: 'var(--bg)' }}>
      <div className="w-full max-w-sm">
        <div className="card p-8">
          <div className="text-center mb-6">
            <div className="text-xl font-bold tracking-wide">YADORIE</div>
            <div className="text-xs" style={{ color: 'var(--text-dim)' }}>Revenue Analytics</div>
          </div>

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
          </form>
        </div>
      </div>
    </div>
  )
}
