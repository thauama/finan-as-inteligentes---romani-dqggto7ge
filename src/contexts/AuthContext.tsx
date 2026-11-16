import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react'
import type { RecordModel } from 'pocketbase'

import pb from '@/lib/pocketbase/client'
import { refreshSession } from '@/lib/pocketbase/sessionExpiry'

interface AuthContextValue {
  user: RecordModel | null
  ready: boolean
  login: (email: string, password: string) => Promise<void>
  signup: (name: string, email: string, password: string) => Promise<void>
  logout: () => void
}

const AuthContext = createContext<AuthContextValue | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<RecordModel | null>(pb.authStore.record)
  const [ready, setReady] = useState(false)

  useEffect(() => {
    const unsubscribe = pb.authStore.onChange((_token, record) => {
      setUser(record)
    }, true)
    if (pb.authStore.isValid) {
      refreshSession().finally(() => setReady(true))
    } else {
      setReady(true)
    }

    // Renovação automática da sessão: o token do PocketBase vale ~14 dias, mas
    // renovações concorrentes/falhas intermitentes derrubavam a sessão no meio
    // do uso. Renova a cada 10 minutos (bem dentro da validade) e também
    // quando a aba volta ao foco/segue visível — se o refresh falhar, o
    // authStore é limpo e o ProtectedLayout redireciona para /login.
    const REFRESH_INTERVAL_MS = 10 * 60 * 1000
    let stopped = false
    const tick = () => {
      if (stopped) return
      void refreshSession()
    }
    const interval = window.setInterval(tick, REFRESH_INTERVAL_MS)
    const onVisibility = () => {
      if (document.visibilityState === 'visible') tick()
    }
    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('focus', onVisibility)

    return () => {
      stopped = true
      window.clearInterval(interval)
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('focus', onVisibility)
      unsubscribe()
    }
  }, [])

  const login = useCallback(async (email: string, password: string) => {
    await pb.collection('users').authWithPassword(email, password)
  }, [])

  const signup = useCallback(async (name: string, email: string, password: string) => {
    await pb.collection('users').create({
      name,
      email,
      password,
      passwordConfirm: password,
      emailVisibility: true,
    })
    await pb.collection('users').requestVerification(email)
  }, [])

  const logout = useCallback(() => {
    pb.authStore.clear()
  }, [])

  const value = useMemo(
    () => ({ user, ready, login, signup, logout }),
    [user, ready, login, signup, logout],
  )
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth() {
  const context = useContext(AuthContext)
  if (!context) throw new Error('useAuth deve ser usado dentro de AuthProvider')
  return context
}
