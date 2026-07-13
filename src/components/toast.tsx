'use client'

// システム全体の通知（トースト）。保存・送信などのアクション結果を右下に一時表示。
// 使い方: const toast = useToast(); toast('保存しました') / toast('エラー: ...', 'error')
import { createContext, useContext, useState, useCallback, useRef, type ReactNode } from 'react'

type ToastType = 'success' | 'error' | 'info'
interface ToastItem { id: number; message: string; type: ToastType }
interface ToastApi { toast: (message: string, type?: ToastType) => void }

const ToastContext = createContext<ToastApi>({ toast: () => {} })

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([])
  const idRef = useRef(0)

  const toast = useCallback((message: string, type: ToastType = 'success') => {
    if (!message) return
    const id = ++idRef.current
    setItems((prev) => [...prev, { id, message, type }])
    setTimeout(() => setItems((prev) => prev.filter((t) => t.id !== id)), 3200)
  }, [])

  const bg = (t: ToastType) => (t === 'error' ? 'var(--red)' : t === 'info' ? 'var(--accent)' : 'var(--green)')

  return (
    <ToastContext.Provider value={{ toast }}>
      {children}
      <div className="fixed z-[200] flex flex-col gap-2" style={{ right: 16, bottom: 16, maxWidth: 360 }} aria-live="polite">
        {items.map((t) => (
          <div key={t.id} onClick={() => setItems((prev) => prev.filter((x) => x.id !== t.id))}
            className="px-4 py-2.5 rounded-lg text-sm text-white flex items-start gap-2 cursor-pointer"
            style={{ background: bg(t.type), boxShadow: '0 6px 20px rgba(0,0,0,0.18)', animation: 'yadorieToastIn .18s ease-out' }}>
            <span style={{ marginTop: 1 }}>{t.type === 'error' ? '⚠' : '✓'}</span>
            <span style={{ whiteSpace: 'pre-wrap' }}>{t.message}</span>
          </div>
        ))}
      </div>
      <style>{`@keyframes yadorieToastIn{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:none}}`}</style>
    </ToastContext.Provider>
  )
}

export function useToast() {
  return useContext(ToastContext).toast
}
