import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react'

import { useAuth } from '@/contexts/AuthContext'
import { listAccounts } from '@/services/accounts'
import { listCategories } from '@/services/categories'
import type { Account, Category } from '@/types/finance'

import { checkOnboardingStatus, type OnboardingStatus } from '@/services/onboarding'

interface FinanceContextValue {
  accounts: Account[]
  categories: Category[]
  loading: boolean
  onboardingStatus: OnboardingStatus | null
  loadingOnboarding: boolean
  refreshAccounts: () => Promise<void>
  refreshCategories: () => Promise<void>
  refreshOnboarding: () => Promise<OnboardingStatus | null>
  refreshAll: () => Promise<void>
}

const FinanceContext = createContext<FinanceContextValue | null>(null)

export function FinanceProvider({ children }: { children: ReactNode }) {
  // FIX "fica atualizando": depends on user.ID, never on the user OBJECT.
  // Each auth-refresh replaced the user object (new identity) → these
  // useCallbacks changed → refreshAll effect refetched EVERY collection —
  // every 10 min and on every tab focus (logs: auth-refresh + full reload
  // in loop). A token renewal must be invisible to the data layer.
  const { user } = useAuth()
  const userId = user?.id ?? null
  const [accounts, setAccounts] = useState<Account[]>([])
  const [categories, setCategories] = useState<Category[]>([])
  const [onboardingStatus, setOnboardingStatus] = useState<OnboardingStatus | null>(null)
  const [loadingOnboarding, setLoadingOnboarding] = useState(true)
  const [loading, setLoading] = useState(true)

  const refreshAccounts = useCallback(async () => {
    if (!userId) return setAccounts([])
    setAccounts(await listAccounts())
  }, [userId])

  const refreshCategories = useCallback(async () => {
    if (!userId) return setCategories([])
    setCategories(await listCategories())
  }, [userId])

  const refreshOnboarding = useCallback(async () => {
    if (!userId) {
      setOnboardingStatus(null)
      setLoadingOnboarding(false)
      return null
    }
    try {
      setLoadingOnboarding(true)
      const st = await checkOnboardingStatus(userId)
      setOnboardingStatus(st)
      return st
    } catch {
      return null
    } finally {
      setLoadingOnboarding(false)
    }
  }, [userId])

  const refreshAll = useCallback(async () => {
    setLoading(true)
    await Promise.all([refreshAccounts(), refreshCategories(), refreshOnboarding()]).finally(() =>
      setLoading(false),
    )
  }, [refreshAccounts, refreshCategories, refreshOnboarding])

  useEffect(() => {
    void refreshAll()
  }, [refreshAll])

  const value = useMemo(
    () => ({
      accounts,
      categories,
      loading,
      onboardingStatus,
      loadingOnboarding,
      refreshAccounts,
      refreshCategories,
      refreshOnboarding,
      refreshAll,
    }),
    [
      accounts,
      categories,
      loading,
      onboardingStatus,
      loadingOnboarding,
      refreshAccounts,
      refreshCategories,
      refreshOnboarding,
      refreshAll,
    ],
  )
  return <FinanceContext.Provider value={value}>{children}</FinanceContext.Provider>
}

export function useFinance() {
  const context = useContext(FinanceContext)
  if (!context) throw new Error('useFinance deve ser usado dentro de FinanceProvider')
  return context
}
