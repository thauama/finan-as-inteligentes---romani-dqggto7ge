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
  deleteCategoryWithCleanup,
  getCategoryImpact,
  type CategoryImpact,
} from '@/services/categoryDelete'
import type { Category } from '@/types/finance'

/**
 * Modal de exclusão de categoria (mãe ou subcategoria).
 *
 * Fluxo (mesmo padrão do modal de exclusão de contas):
 * 1. Ao abrir, consulta o backend (rota autenticada) quantos lançamentos,
 *    contas a pagar/receber, recorrências e metas estão vinculados à categoria
 *    (incluindo subcategorias).
 * 2. Com vínculos: avisa quantos serão afetados e oferece "Excluir tudo"
 *    (categoria + vínculos) ou Cancelar — nada fica órfão.
 * 3. Sem vínculos: exclui apenas a categoria (e subcategorias, se mãe).
 */
export function CategoryDeleteModal({
  category,
  open,
  onOpenChange,
  onDeleted,
}: {
  category: Category | null
  open: boolean
  onOpenChange: (value: boolean) => void
  onDeleted?: (category: Category) => void
}) {
  const { refreshCategories } = useFinance()
  const { toast } = useToast()
  const [impact, setImpact] = useState<CategoryImpact | null>(null)
  const [loadingImpact, setLoadingImpact] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [error, setError] = useState('')
  const [authError, setAuthError] = useState(false)
  const navigate = useNavigate()

  const loadImpact = useCallback(async (categoryId: string) => {
    setLoadingImpact(true)
    setError('')
    setAuthError(false)
    try {
      setImpact(await getCategoryImpact(categoryId))
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
    if (open && category) {
      setImpact(null)
      void loadImpact(category.id)
    }
  }, [open, category, loadImpact])

  const linkedAll = impact?.linked_transactions ?? 0
  const linkedTransactions = impact?.transactions ?? 0
  const linkedBills = impact?.bills ?? 0
  const linkedRecurrings = impact?.recurrings ?? 0
  const subcategories = impact?.subcategories ?? 0

  async function execute(mode: 'delete' | 'keep') {
    if (!category) return
    setDeleting(true)
    setError('')
    setAuthError(false)
    try {
      await deleteCategoryWithCleanup(category.id, mode)
      await refreshCategories()
      toast({
        title: 'Categoria excluída',
        description: `“${category.name}” foi removida.${
          subcategories > 0 ? ` ${subcategories} subcategoria(s) também foram excluídas.` : ''
        }`,
      })
      onDeleted?.(category)
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

  const summaryParts: string[] = []
  if (linkedTransactions > 0) summaryParts.push(`${linkedTransactions} lançamento(s)`)
  if (linkedBills > 0) summaryParts.push(`${linkedBills} conta(s) a pagar/receber`)
  if (linkedRecurrings > 0) summaryParts.push(`${linkedRecurrings} recorrência(s)`)
  if (subcategories > 0) summaryParts.push(`${subcategories} subcategoria(s)`)

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
            Excluir categoria
          </DialogTitle>
          <DialogDescription>
            {category ? `Você está excluindo “${category.name}”.` : ''}
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
            Verificando vínculos da categoria...
          </div>
        ) : (
          <div className="space-y-4 pt-1">
            {impact && linkedAll === 0 && (
              <p className="text-sm text-fin-muted">
                Esta categoria não tem lançamentos, contas, recorrências nem metas vinculados. A
                exclusão não afeta outros registros.
              </p>
            )}

            {impact && linkedAll > 0 && (
              <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
                <p className="flex items-start gap-2 font-semibold">
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
                  <span>Esta categoria tem vínculos: {summaryParts.join(', ')}.</span>
                </p>
                {linkedTransactions > 0 ? (
                  <p className="mt-2 text-amber-900/90">
                    Excluir a categoria exclui também todos esses lançamentos — nada fica órfão.
                    Deseja continuar?
                  </p>
                ) : (
                  <p className="mt-2 text-amber-900/90">
                    Você pode excluir mantendo as contas a pagar/receber e recorrências (elas ficam
                    sem categoria vinculada) — ou cancelar.
                  </p>
                )}
              </div>
            )}

            {error && <p className="rounded-lg bg-red-50 p-3 text-sm text-fin-danger">{error}</p>}

            <div className="flex flex-col gap-2">
              {linkedTransactions > 0 ? (
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
                      : `Excluir tudo (${linkedTransactions} lançamento(s) + categoria)`}
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
                    {deleting ? 'Excluindo...' : 'Excluir categoria'}
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
