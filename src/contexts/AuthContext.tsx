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
  // O objeto `user` deve mudar APENAS quando o usuário loga/desloga ou edita o
  // perfil — NUNCA a cada auth-refresh. Hoje cada renovação de token repõe o
  // `user` com um objeto novo; isso muda a identidade dos useCallback que
  // dependem dele no FinanceContext (refreshAccounts/Categories/Onboarding →
  // refreshAll), e o app RECARREGA TODAS as coleções do zero — a cada 10 min e
  // a cada foco na aba. É o "fica atualizando" que o usuário relata (logs:
  // auth-refresh seguido de refetch total em ciclo).
  const [userId, setUserId] = useState<string | null>(pb.authStore.record?.id ?? null)

  useEffect(() => {
    const unsubscribe = pb.authStore.onChange((_token, record) => {
      // Fix "fica atualizando": só troca o objeto `user` quando MUDA de
      // identidade (login/logout/edição de perfil). Cada auth-refresh entregava
      // um RecordModel novo — a cada 10 min e a cada foco na aba — e qualquer
      // efeito dependentes do objeto user reexecutava (refetch geral + remounts).
      setUser((prev) => {
        const prevKey = prev ? `${prev.id}:${prev.updated ?? ''}` : ''
        const nextKey = record ? `${record.id}:${record.updated ?? ''}` : ''
        return prevKey === nextKey ? prev : record
      })
      setUserId(record?.id ?? null)
    }, true)
    if (pb.authStore.isValid) {
      refreshSession().finally(() => setReady(true))
    } else {
      setReady(true)
    }

    // Renovação automática da sessão: o token do PocketBase vale ~14 dias, mas
    // renovações concorrentes/falhas intermitentes derrubavam a sessão no meio
    // do uso. Renova a cada 10 minutos e também quando a aba volta ao
    // foco/segue visível — com COOLDOWN de foco (60s): abrir o seletor de
    // arquivos do upload ou trocar de janela disparava refresh atrás de refresh,
    // cada um com refetch total atrás. Só limpa o authStore em 401 real
    // (refreshSession) — falha de rede não desloga.
    const REFRESH_INTERVAL_MS = 10 * 60 * 1000
    const FOCUS_COOLDOWN_MS = 60 * 1000
    let stopped = false
    let lastTickAt = 0
    const tick = (force = false) => {
      if (stopped) return
      const now = Date.now()
      if (!force && now - lastTickAt < FOCUS_COOLDOWN_MS) return
      lastTickAt = now
      void refreshSession()
    }
    const interval = window.setInterval(() => tick(true), REFRESH_INTERVAL_MS)
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
