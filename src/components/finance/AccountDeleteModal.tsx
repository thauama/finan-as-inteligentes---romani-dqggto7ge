import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { AlertTriangle, Loader2, Trash2 } from 'lucide-react'

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { useFinance } from '@/contexts/FinanceContext'
import { useToast } from '@/hooks/use-toast'
import { getErrorMessage } from '@/lib/pocketbase/errors'
import { isSessionExpiredError } from '@/lib/pocketbase/sessionExpiry'
import { SessionExpiryPanel } from '@/components/finance/SessionExpiryPanel'
import {
  deleteAccountWithCleanup,
  getAccountImpact,
  type AccountImpact,
} from '@/services/accountDelete'
import type { Account } from '@/types/finance'

/**
 * Modal de exclusão de conta/cartão.
 *
 * Fluxo:
 * 1. Ao abrir, consulta o backend (rota autenticada) quantos lançamentos,
 *    transferências, contas a pagar/receber e recorrências ativas estão
 *    vinculados à conta.
 * 2. Com vínculos de lançamento: avisa quantos serão afetados e oferece
 *    "Excluir tudo" (conta + lançamentos) ou Cancelar — a conta nunca fica
 *    com lançamentos órfãos.
 * 3. Contas a pagar/receber: sempre informadas. Sem lançamentos vinculados,
 *    o usuário pode excluir só a conta mantendo-as (desvinculadas).
 */
export function AccountDeleteModal({
  account,
  open,
  onOpenChange,
  onDeleted,
}: {
  account: Account | null
  open: boolean
  onOpenChange: (value: boolean) => void
  onDeleted?: (account: Account) => void
}) {
  const { refreshAccounts } = useFinance()
  const { toast } = useToast()
  const [impact, setImpact] = useState<AccountImpact | null>(null)
  const [loadingImpact, setLoadingImpact] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [error, setError] = useState('')
  const [authError, setAuthError] = useState(false)
  const navigate = useNavigate()

  const loadImpact = useCallback(async (accountId: string) => {
    setLoadingImpact(true)
    setError('')
    setAuthError(false)
    try {
      setImpact(await getAccountImpact(accountId))
    } catch (err) {
      setImpact(null)
      if (isSessionExpiredError(err)) {
        setAuthError(true)
      } else {
        setError(getErrorMessage(err))
      }
    } finally {
      setLoadingImpact(false)
    }
  }, [])

  useEffect(() => {
    if (open && account) {
      setImpact(null)
      void loadImpact(account.id)
    }
  }, [open, account, loadImpact])

  const linkedTransactions = impact ? impact.transactions + impact.transfers : 0
  const linkedBills = impact?.bills ?? 0
  const activeRecurrings = impact?.active_recurrings ?? 0

  async function execute(mode: 'delete' | 'keep') {
    if (!account) return
    setDeleting(true)
    setError('')
    setAuthError(false)
    try {
      await deleteAccountWithCleanup(account.id, mode)
      await refreshAccounts()
      toast({
        title: 'Conta excluída',
        description: `“${account.name}” foi removida da sua lista de contas.`,
      })
      onDeleted?.(account)
      onOpenChange(false)
    } catch (err) {
      if (isSessionExpiredError(err)) {
        setAuthError(true)
      } else {
        setError(getErrorMessage(err))
      }
    } finally {
      setDeleting(false)
    }
  }

  const hasTransactionLinks = linkedTransactions > 0

  // Descrição do que será afetado, em português claro.
  const summaryParts: string[] = []
  if (linkedTransactions > 0) {
    summaryParts.push(
      impact && impact.transfers > 0
        ? `${linkedTransactions} lançamento(s) vinculados (incluindo ${impact.transfers} transferência(s))`
        : `${linkedTransactions} lançamento(s) vinculado(s)`,
    )
  }
  if (linkedBills > 0) summaryParts.push(`${linkedBills} conta(s) a pagar/receber`)
  if (activeRecurrings > 0) summaryParts.push(`${activeRecurrings} recorrência(s) ativa(s)`)

  return (
    <Dialog
      open={open}
      onOpenChange={(value) => {
        if (!deleting) onOpenChange(value)
      }}
    >
      <DialogContent className="border-fin-border bg-white sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Trash2 className="h-4 w-4 text-fin-danger" />
            Excluir conta
          </DialogTitle>
          <DialogDescription>
            {account ? `Você está excluindo “${account.name}”.` : ''}
          </DialogDescription>
        </DialogHeader>

        {authError ? (
          <SessionExpiryPanel
            onClose={() => onOpenChange(false)}
            onLogin={() => {
              onOpenChange(false)
              navigate('/login')
            }}
          />
        ) : loadingImpact ? (
          <div className="flex items-center gap-2 py-6 text-sm text-fin-muted">
            <Loader2 className="h-4 w-4 animate-spin text-fin-primary" />
            Verificando vínculos da conta...
          </div>
        ) : (
          <div className="space-y-4 pt-1">
            {impact && !hasTransactionLinks && linkedBills === 0 && activeRecurrings === 0 && (
              <p className="text-sm text-fin-muted">
                Esta conta não tem lançamentos nem contas a pagar/receber vinculados. A exclusão não
                afeta outros registros.
              </p>
            )}

            {impact && (hasTransactionLinks || linkedBills > 0 || activeRecurrings > 0) && (
              <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
                <p className="flex items-start gap-2 font-semibold">
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
                  <span>
                    Esta conta tem vínculos:{' '}
                    {summaryParts.length > 0 ? `${summaryParts.join(', ')}.` : ''}
                  </span>
                </p>
                {hasTransactionLinks ? (
                  <p className="mt-2 text-amber-900/90">
                    Excluir a conta exclui também todos esses lançamentos (e as transferências em
                    que ela aparece como origem ou destino). Deseja continuar?
                  </p>
                ) : (
                  <p className="mt-2 text-amber-900/90">
                    Você pode excluir a conta mantendo as contas a pagar/receber (elas ficam sem
                    conta vinculada) — ou cancelar.
                  </p>
                )}
              </div>
            )}

            {error && <p className="rounded-lg bg-red-50 p-3 text-sm text-fin-danger">{error}</p>}

            <div className="flex flex-col gap-2">
              {hasTransactionLinks ? (
                <>
                  <button
                    type="button"
                    className="btn-primary w-full !bg-fin-danger hover:!bg-red-600"
                    disabled={deleting}
                    onClick={() => void execute('delete')}
                  >
                    {deleting ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Trash2 className="h-4 w-4" />
                    )}
                    {deleting
                      ? 'Excluindo...'
                      : `Excluir tudo (${linkedTransactions} lançamento(s) + conta)`}
                  </button>
                  <button
                    type="button"
                    className="btn-secondary w-full"
                    disabled={deleting}
                    onClick={() => onOpenChange(false)}
                  >
                    Cancelar
                  </button>
                </>
              ) : (
                <>
                  <button
                    type="button"
                    className="btn-primary w-full !bg-fin-danger hover:!bg-red-600"
                    disabled={deleting}
                    onClick={() => void execute('keep')}
                  >
                    {deleting ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Trash2 className="h-4 w-4" />
                    )}
                    {deleting ? 'Excluindo...' : 'Excluir conta'}
                  </button>
                  <button
                    type="button"
                    className="btn-secondary w-full"
                    disabled={deleting}
                    onClick={() => onOpenChange(false)}
                  >
                    Cancelar
                  </button>
                </>
              )}
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
