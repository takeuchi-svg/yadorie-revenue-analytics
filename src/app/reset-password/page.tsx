'use client'

// パスワード設定/再設定ページ（新規招待・パスワード忘れの両方に対応）
// メールのリンクから遷移 → セッション確立 → 新パスワードを設定。
// token_hash 方式（メールテンプレートが token_hash を使う場合。端末を問わず有効）と、
// code/ハッシュ方式（detectSessionInUrl が自動確立）の両方をハンドリング。
import { Suspense, useEffect, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { supabase } from '@/lib/supabase/client'

/* eslint-disable @typescript-eslint/no-explicit-any */
function ResetInner() {
  const router = useRouter()
  const sp = useSearchParams()
  const [phase, setPhase] = useState<'verifying' | 'ready' | 'error' | 'done'>('verifying')
  const [errMsg, setErrMsg] = useState('')
  const [pw, setPw] = useState('')
  const [pw2, setPw2] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let settled = false
    const markReady = () => { if (!settled) { settled = true; setPhase('ready') } }

    const token_hash = sp.get('token_hash')
    const type = sp.get('type')
    if (token_hash && type) {
      supabase.auth.verifyOtp({ type: type as any, token_hash }).then(({ error }) => {
        if (error) { if (!settled) { settled = true; setErrMsg(error.message); setPhase('error') } } else markReady()
      })
    }
    supabase.auth.getSession().then(({ data }) => { if (data.session) markReady() })
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_e, session) => { if (session) markReady() })
    const t = setTimeout(() => {
      if (!settled) { settled = true; setErrMsg('リンクが無効か、有効期限が切れています。もう一度お試しください。'); setPhase('error') }
    }, 5000)
    return () => { subscription.unsubscribe(); clearTimeout(t) }
  }, [sp])

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (pw.length < 8) { setErrMsg('パスワードは8文字以上にしてください'); return }
    if (pw !== pw2) { setErrMsg('パスワードが一致しません'); return }
    setBusy(true); setErrMsg('')
    const { error } = await supabase.auth.updateUser({ password: pw })
    setBusy(false)
    if (error) { setErrMsg(error.message); return }
    setPhase('done')
    setTimeout(() => { router.push('/'); router.refresh() }, 1400)
  }

  return (
    <div className="min-h-screen flex items-center justify-center" style={{ background: 'var(--bg)' }}>
      <div className="w-full max-w-sm">
        <div className="card p-8">
          <div className="text-center mb-6">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/yadorie-logo.png" alt="YADORIE宿GROUP" style={{ height: 44, width: 'auto' }} className="mx-auto mb-2" />
            <div className="text-sm font-bold tracking-wide">パスワードの設定</div>
          </div>

          {phase === 'verifying' && (
            <p className="text-sm text-center" style={{ color: 'var(--text-dim)' }}>リンクを確認しています…</p>
          )}

          {phase === 'error' && (
            <>
              <p className="text-sm mb-4" style={{ color: 'var(--red)' }}>{errMsg}</p>
              <a href="/login" className="block text-center text-sm" style={{ color: 'var(--accent)' }}>ログイン画面へ戻る</a>
            </>
          )}

          {phase === 'done' && (
            <p className="text-sm text-center" style={{ color: 'var(--green)' }}>パスワードを設定しました。移動します…</p>
          )}

          {phase === 'ready' && (
            <form onSubmit={submit} className="space-y-4">
              <div>
                <label className="block text-sm font-medium mb-1" style={{ color: 'var(--text-dim)' }}>新しいパスワード（8文字以上）</label>
                <input type="password" value={pw} onChange={(e) => setPw(e.target.value)} className="field w-full px-3 py-2 text-sm" required />
              </div>
              <div>
                <label className="block text-sm font-medium mb-1" style={{ color: 'var(--text-dim)' }}>もう一度入力</label>
                <input type="password" value={pw2} onChange={(e) => setPw2(e.target.value)} className="field w-full px-3 py-2 text-sm" required />
              </div>
              {errMsg && <p className="text-sm" style={{ color: 'var(--red)' }}>{errMsg}</p>}
              <button type="submit" disabled={busy}
                className="w-full py-2 text-white rounded-md font-medium hover:opacity-90 disabled:opacity-50"
                style={{ background: 'var(--accent)' }}>
                {busy ? '設定中...' : 'パスワードを設定'}
              </button>
            </form>
          )}
        </div>
      </div>
    </div>
  )
}

export default function ResetPasswordPage() {
  return (
    <Suspense fallback={<div className="min-h-screen" style={{ background: 'var(--bg)' }} />}>
      <ResetInner />
    </Suspense>
  )
}
