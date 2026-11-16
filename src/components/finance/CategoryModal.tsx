import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { Check, Loader2 } from 'lucide-react'

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { SessionExpiryPanel } from '@/components/finance/SessionExpiryPanel'
import { useFinance } from '@/contexts/FinanceContext'
import { getErrorMessage } from '@/lib/pocketbase/errors'
import { isSessionExpiredError } from '@/lib/pocketbase/sessionExpiry'
import { countTransactionsForCategory } from '@/services/transactions'
import { createCategory, updateCategory } from '@/services/categories'
import type { Category, CategoryInput, TransactionType } from '@/types/finance'

const colors = ['#5B5FEF', '#34C759', '#FFB020', '#F4526B', '#8B5CF6', '#06B6D4', '#F97316']

/**
 * Modal de categoria: cria/edita categoria MÃE ou SUBCATEGORIA.
 * - `parentCategory` informado + `category` nulo → modo "nova subcategoria".
 * - Mudança de tipo é bloqueada com explicação quando há lançamentos ou
 *   subcategorias vinculadas (evita misturar receita e despesa na hierarquia).
 */
export function CategoryModal({
  category,
  parentCategory,
  open,
  onOpenChange,
  onSaved,
}: {
  category?: Category | null
  parentCategory?: Category | null
  open: boolean
  onOpenChange: (value: boolean) => void
  onSaved?: (category: Category) => void
}) {
  const { categories, refreshCategories } = useFinance()
  const navigate = useNavigate()
  const [form, setForm] = useState<CategoryInput>({
    name: '',
    type: 'despesa',
    color: colors[0],
    parent: '',
  })
  const [message, setMessage] = useState('')
  const [sessionExpired, setSessionExpired] = useState(false)
  const [txCount, setTxCount] = useState(0)
  const [saving, setSaving] = useState(false)
  const isSubcategoryMode = Boolean(parentCategory)

  // Vínculos da categoria em edição: lançamentos diretos (consultados no
  // backend, o contexto não carrega lançamentos) e subcategorias (da lista local)
  const childCount = useMemo(
    () => (category ? categories.filter((item) => item.parent === category.id).length : 0),
    [categories, category],
  )
  useEffect(() => {
    if (!open || !category) {
      setTxCount(0)
      return
    }
    let cancelled = false
    void countTransactionsForCategory(category.id)
      .then((result) => {
        if (!cancelled) setTxCount(result.totalItems)
      })
      .catch(() => {
        if (!cancelled) setTxCount(0)
      })
    return () => {
      cancelled = true
    }
  }, [open, category])
  const typeLocked = Boolean(category) && (txCount > 0 || childCount > 0)

  const parents = useMemo(
    () =>
      categories.filter(
        (item) => !item.parent && item.type === form.type && item.id !== category?.id,
      ),
    [categories, form.type, category],
  )
  useEffect(() => {
    if (open) {
      setMessage('')
      setSessionExpired(false)
      setForm(
        category
          ? {
              name: category.name,
              type: category.type,
              color: category.color,
              parent: category.parent || '',
            }
          : parentCategory
            ? {
                name: '',
                type: parentCategory.type,
                color: parentCategory.color,
                parent: parentCategory.id,
              }
            : { name: '', type: 'despesa', color: colors[0], parent: '' },
      )
    }
  }, [open, category, parentCategory])
  async function submit(event: FormEvent) {
    event.preventDefault()
    if (!form.name.trim()) return setMessage('Informe o nome da categoria.')
    setSaving(true)
    try {
      const saved = category ? await updateCategory(category.id, form) : await createCategory(form)
      await refreshCategories()
      onSaved?.(saved)
      onOpenChange(false)
    } catch (error) {
      if (isSessionExpiredError(error)) {
        setSessionExpired(true)
        setMessage('Sua sessão expirou. Renove-a abaixo para salvar suas alterações.')
      } else {
        setMessage(getErrorMessage(error))
      }
    } finally {
      setSaving(false)
    }
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="border-fin-border sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {category
              ? isSubcategoryMode
                ? 'Editar subcategoria'
                : 'Editar categoria'
              : isSubcategoryMode
                ? 'Nova subcategoria'
                : 'Nova categoria'}
          </DialogTitle>
          <DialogDescription>
            Use categorias e subcategorias para entender para onde vai seu dinheiro.
          </DialogDescription>
        </DialogHeader>
        {sessionExpired && (
          <SessionExpiryPanel
            onClose={() => onOpenChange(false)}
            onLogin={() => {
              onOpenChange(false)
              navigate('/login')
            }}
          />
        )}
        <form onSubmit={submit} className="space-y-4 pt-2">
          {isSubcategoryMode && parentCategory ? (
            <div className="rounded-xl border border-fin-border bg-fin-surface/60 p-3 text-sm">
              <span className="text-[13px] font-medium">Categoria-mãe</span>
              <p className="mt-0.5 flex items-center gap-2 text-fin-muted">
                <span
                  className="h-2.5 w-2.5 rounded-full shrink-0"
                  style={{ background: parentCategory.color }}
                />
                {parentCategory.name} · {parentCategory.type === 'receita' ? 'Receita' : 'Despesa'}
              </p>
            </div>
          ) : null}
          <label className="block space-y-1.5">
            <span className="text-[13px] font-medium">Nome</span>
            <input
              className="field"
              value={form.name}
              onChange={(event) => setForm({ ...form, name: event.target.value })}
              placeholder={isSubcategoryMode ? 'Ex.: Supermercado' : 'Ex.: Alimentação'}
              autoFocus
            />
          </label>
          {isSubcategoryMode ? (
            <p className="text-xs text-fin-muted">
              Tipo e cor são herdados da categoria-mãe — mantém a hierarquia consistente.
            </p>
          ) : (
            <>
              <div className="grid grid-cols-2 gap-4">
                <label className="block space-y-1.5">
                  <span className="text-[13px] font-medium">Tipo</span>
                  {typeLocked ? (
                    <>
                      <select className="field" value={form.type} disabled>
                        <option value="despesa">Despesa</option>
                        <option value="receita">Receita</option>
                      </select>
                      <span className="block text-xs text-fin-muted">
                        {txCount > 0
                          ? `${txCount} lançamento(s) usam esta categoria — o tipo não pode mudar.`
                          : `${childCount} subcategoria(s) herdariam tipo inválido — o tipo não pode mudar.`}
                      </span>
                    </>
                  ) : (
                    <select
                      className="field"
                      value={form.type}
                      onChange={(event) =>
                        setForm({
                          ...form,
                          type: event.target.value as TransactionType,
                          parent: '',
                        })
                      }
                    >
                      <option value="despesa">Despesa</option>
                      <option value="receita">Receita</option>
                    </select>
                  )}
                </label>
                {category && !category.parent ? null : (
                  <label className="block space-y-1.5">
                    <span className="text-[13px] font-medium">Categoria-mãe</span>
                    <select
                      className="field"
                      value={form.parent}
                      onChange={(event) => setForm({ ...form, parent: event.target.value })}
                    >
                      <option value="">Nenhuma</option>
                      {parents.map((parent) => (
                        <option key={parent.id} value={parent.id}>
                          {parent.name}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
              </div>
              <div>
                <span className="text-[13px] font-medium">Cor</span>
                <div className="mt-2 flex gap-2">
                  {colors.map((color) => (
                    <button
                      key={color}
                      type="button"
                      onClick={() => setForm({ ...form, color })}
                      className="grid h-8 w-8 place-items-center rounded-full"
                      style={{ background: color }}
                    >
                      {form.color === color && <Check className="h-4 w-4 text-white" />}
                    </button>
                  ))}
                </div>
              </div>
            </>
          )}
          {message && <p className="rounded-lg bg-red-50 p-3 text-sm text-fin-danger">{message}</p>}
          <button type="submit" className="btn-primary w-full" disabled={saving}>
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
            {saving ? 'Salvando...' : 'Salvar categoria'}
          </button>
        </form>
      </DialogContent>
    </Dialog>
  )
}
