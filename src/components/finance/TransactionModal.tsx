import { useEffect, useRef, useState, type DragEvent, type FormEvent } from 'react'
import { CalendarDays, Check, FileText, Layers, Loader2, UploadCloud, X } from 'lucide-react'

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { useFinance } from '@/contexts/FinanceContext'
import { extractFieldErrors, getErrorMessage, type FieldErrors } from '@/lib/pocketbase/errors'
import { todayInput, toDateInput } from '@/lib/format'
import {
  createTransaction,
  updateTransaction,
  type RegularTransactionInput,
} from '@/services/transactions'
import { createTransfer, updateTransfer } from '@/services/transfers'
import { updateInstallmentGroup } from '@/lib/installmentGroupService'
import { stripInstallmentSuffix as stripSuffix } from '@/lib/installments'
import { isTransfer as transactionIsTransfer } from '@/lib/transactionTypes'
import type { Account, Transaction, TransactionInput, TransactionType } from '@/types/finance'
import { CategoryTreeSelect } from '@/components/finance/CategoryTreeSelect'
import { cn } from '@/lib/utils'

/**
 * As rotas dedicadas de transferência devolvem um objeto plano (sem os
 * métodos do SDK). Normalizamos para um Transaction tipado, expandindo as
 * contas com base na lista carregada no contexto.
 */
function normalizeTransferRecord(raw: Transaction, accounts: Account[]): Transaction {
  const account = accounts.find((item) => item.id === raw.account)
  const destination = accounts.find((item) => item.id === raw.destination_account)
  return {
    ...raw,
    collectionId: raw.collectionId || 'transactions',
    collectionName: 'transactions',
    expand: {
      ...raw.expand,
      account: raw.expand?.account || account,
      destination_account: raw.expand?.destination_account || destination,
    },
  }
}

interface TransactionModalProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  transaction?: Transaction | null
  defaultType?: TransactionType
  onSaved?: (transaction: Transaction) => void
  /**
   * Modo "editar grupo em bloco": aplica valor/categoria/conta (apenas os
   * campos alterados) a TODOS os lançamentos do grupo de parcelas — os já
   * lançados e as parcelas futuras.
   */
  groupEdit?: { ids: string[] } | null
  onGroupSaved?: (updated: number) => void
}

const initialInput = (type: TransactionType): TransactionInput => ({
  type,
  description: '',
  amount: 0,
  date: todayInput(),
  category: '',
  account: '',
  notes: '',
  attachment: null,
})

export function TransactionModal({
  open,
  onOpenChange,
  transaction,
  defaultType = 'despesa',
  onSaved,
  groupEdit = null,
  onGroupSaved,
}: TransactionModalProps) {
  const { accounts, categories } = useFinance()
  const [form, setForm] = useState<TransactionInput>(() => initialInput(defaultType))
  const [errors, setErrors] = useState<FieldErrors>({})
  const [message, setMessage] = useState('')
  const [saving, setSaving] = useState(false)
  const [dragging, setDragging] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)
  const isTransfer = form.type === 'transferencia'
  const editingTransfer = Boolean(transaction && transactionIsTransfer(transaction))
  const groupMode = Boolean(groupEdit && groupEdit.ids.length > 0 && transaction)
  /** Snapshot do clique: só o que o usuário mudou de verdade vai para o grupo. */
  const groupInitial = useRef<{ amount: number; category: string; account: string } | null>(null)

  useEffect(() => {
    if (!open) return
    setErrors({})
    setMessage('')
    if (transaction) {
      setForm({
        type: transaction.type,
        description: transaction.description,
        amount: transaction.amount,
        date: toDateInput(transaction.date),
        category: transaction.category,
        account: transaction.account,
        destination_account: transaction.destination_account || '',
        notes: transaction.notes || '',
        attachment: null,
      })
      groupInitial.current = groupMode
        ? {
            amount: transaction.amount,
            category: transaction.category,
            account: transaction.account,
          }
        : null
    } else {
      setForm(initialInput(defaultType))
      groupInitial.current = null
    }
  }, [open, transaction, defaultType, groupMode])

  function set<K extends keyof TransactionInput>(key: K, value: TransactionInput[K]) {
    setForm((current) => ({ ...current, [key]: value }))
    setErrors((current) => ({ ...current, [key]: '' }))
  }

  function validateFile(file: File) {
    const allowed = ['application/pdf', 'image/png', 'image/jpeg']
    if (!allowed.includes(file.type)) {
      setErrors((current) => ({ ...current, attachment: 'Use um arquivo PDF, PNG ou JPEG.' }))
      return
    }
    if (file.size > 5 * 1024 * 1024) {
      setErrors((current) => ({ ...current, attachment: 'O comprovante deve ter no máximo 5 MB.' }))
      return
    }
    set('attachment', file)
  }

  function handleDrop(event: DragEvent<HTMLButtonElement>) {
    event.preventDefault()
    setDragging(false)
    const file = event.dataTransfer.files[0]
    if (file) validateFile(file)
  }

  async function submit(event: FormEvent) {
    event.preventDefault()
    const localErrors: FieldErrors = {}
    if (!form.amount || form.amount <= 0) localErrors.amount = 'Informe um valor maior que zero.'
    if (!form.date) localErrors.date = 'Informe a data.'
    if (!form.account) localErrors.account = 'Selecione a conta de origem.'

    if (groupMode) {
      // Edição em bloco: valida só os 3 campos aplicáveis e aplica a TODOS os
      // membros do grupo apenas o que foi alterado nesta tela.
      if (!form.category) localErrors.category = 'Selecione uma categoria.'
      if (Object.keys(localErrors).length) return setErrors(localErrors)
      const patch: Partial<Pick<RegularTransactionInput, 'amount' | 'category' | 'account'>> = {}
      const initial = groupInitial.current
      if (!initial || form.amount !== initial.amount) patch.amount = form.amount
      if (!initial || form.category !== initial.category) patch.category = form.category
      if (!initial || form.account !== initial.account) patch.account = form.account
      if (Object.keys(patch).length === 0) {
        setMessage('Nenhuma alteração para aplicar: valor, categoria e conta estão iguais.')
        return
      }
      setSaving(true)
      setMessage('')
      try {
        const updated = await updateInstallmentGroup(groupEdit!.ids, patch)
        onGroupSaved?.(updated)
        onOpenChange(false)
      } catch (error) {
        setErrors(extractFieldErrors(error))
        setMessage(getErrorMessage(error))
      } finally {
        setSaving(false)
      }
      return
    }

    if (isTransfer) {
      if (!form.destination_account) {
        localErrors.destination_account = 'Selecione a conta de destino.'
      } else if (form.destination_account === form.account) {
        localErrors.destination_account = 'A conta de destino deve ser diferente da origem.'
      }
    } else {
      if (!form.description.trim()) localErrors.description = 'Informe uma descrição.'
      if (!form.category) localErrors.category = 'Selecione uma categoria.'
    }
    if (Object.keys(localErrors).length) return setErrors(localErrors)

    setSaving(true)
    setMessage('')
    try {
      let saved: Transaction
      if (isTransfer) {
        // Toda transferência passa pelas rotas dedicadas — o create/update
        // padrão NÃO grava destination_account.
        if (editingTransfer) {
          // Atualiza o MESMO lançamento (sem criar cópia) via rota dedicada
          saved = await updateTransfer({
            id: transaction!.id,
            from_account_id: form.account,
            to_account_id: form.destination_account || '',
            amount: form.amount,
            date: form.date,
            description: form.description,
            notes: form.notes,
          })
        } else {
          saved = await createTransfer({
            from_account_id: form.account,
            to_account_id: form.destination_account || '',
            amount: form.amount,
            date: form.date,
            description: form.description,
            notes: form.notes,
          })
        }
      } else {
        saved = transaction
          ? await updateTransaction(transaction.id, {
              ...form,
              type: form.type as 'receita' | 'despesa',
            })
          : await createTransaction(form as RegularTransactionInput)
      }
      saved = normalizeTransferRecord(saved, accounts)
      onSaved?.(saved)
      onOpenChange(false)
    } catch (error) {
      setErrors(extractFieldErrors(error))
      setMessage(getErrorMessage(error))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92vh] overflow-y-auto border-fin-border bg-white sm:max-w-[620px]">
        <DialogHeader>
          <DialogTitle>
            {groupMode
              ? 'Editar grupo de parcelas'
              : transaction
                ? 'Editar lançamento'
                : 'Novo lançamento'}
          </DialogTitle>
          <DialogDescription>
            {groupMode
              ? `As alterações se aplicam a todos os ${groupEdit!.ids.length} lançamentos do grupo — lançados e parcelas futuras.`
              : 'Registre uma entrada, saída ou transferência entre contas.'}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-5 pt-2">
          {groupMode && (
            <div className="flex items-start gap-2 rounded-xl border border-fin-primary/20 bg-indigo-50 px-3 py-2.5">
              <Layers className="mt-0.5 h-4 w-4 shrink-0 text-fin-primary" />
              <p className="text-[13px] leading-5 text-fin-text">
                Editando em bloco o grupo <strong>{stripSuffix(transaction!.description)}</strong> (
                {transaction!.notes || 'parcelamento'}). Somente valor, categoria e conta são
                aplicados ao grupo — data, descrição e notas ficam intactas.
              </p>
            </div>
          )}

          <div className="grid grid-cols-3 rounded-xl bg-fin-surface p-1">
            {(['receita', 'despesa', 'transferencia'] as const).map((type) => (
              <button
                key={type}
                type="button"
                disabled={Boolean(transaction)}
                title={
                  transaction
                    ? 'O tipo não pode ser alterado em um lançamento existente.'
                    : undefined
                }
                onClick={() => {
                  set('type', type)
                  set('category', '')
                }}
                className={cn(
                  'rounded-lg px-3 py-2.5 text-sm font-semibold transition',
                  Boolean(transaction) && 'cursor-not-allowed',
                  form.type === type
                    ? type === 'receita'
                      ? 'bg-white text-fin-success shadow-sm'
                      : type === 'transferencia'
                        ? 'bg-white text-fin-primary shadow-sm'
                        : 'bg-white text-fin-danger shadow-sm'
                    : 'text-fin-muted',
                )}
              >
                {type === 'transferencia' ? 'Transferência' : type}
              </button>
            ))}
          </div>

          <div className={cn('grid gap-4', groupMode && 'sm:grid-cols-1')}>
            <Field label="Valor" error={errors.amount}>
              <div className="relative">
                <span className="absolute left-3 top-2.5 text-sm text-fin-muted">R$</span>
                <input
                  className="field pl-10"
                  type="number"
                  min="0.01"
                  step="0.01"
                  value={form.amount || ''}
                  onChange={(event) => set('amount', Number(event.target.value))}
                  placeholder="0,00"
                />
              </div>
            </Field>
            <Field label="Data" error={errors.date}>
              <div className="relative">
                <CalendarDays className="absolute left-3 top-2.5 h-4 w-4 text-fin-muted" />
                <input
                  className="field pl-10"
                  type="date"
                  value={form.date}
                  onChange={(event) => set('date', event.target.value)}
                  disabled={groupMode}
                />
              </div>
            </Field>
          </div>

          {!isTransfer && !groupMode && (
            <Field label="Descrição" error={errors.description}>
              <input
                className="field"
                value={form.description}
                onChange={(event) => set('description', event.target.value)}
                placeholder="Ex.: Compra no supermercado"
                autoFocus
              />
            </Field>
          )}

          {isTransfer ? (
            <>
              <Field label="Descrição (opcional)" error={errors.description}>
                <input
                  className="field"
                  value={form.description}
                  onChange={(event) => set('description', event.target.value)}
                  placeholder="Ex.: Guardar dinheiro do mês"
                />
              </Field>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Conta de origem" error={errors.account}>
                  <select
                    className="field"
                    value={form.account}
                    onChange={(event) => set('account', event.target.value)}
                  >
                    <option value="">Conta de origem</option>
                    {accounts.map((account) => (
                      <option key={account.id} value={account.id}>
                        {account.name}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Conta de destino" error={errors.destination_account}>
                  <select
                    className="field"
                    value={form.destination_account || ''}
                    onChange={(event) => set('destination_account', event.target.value)}
                  >
                    <option value="">Conta de destino</option>
                    {accounts
                      .filter((account) => account.id !== form.account)
                      .map((account) => (
                        <option key={account.id} value={account.id}>
                          {account.name}
                        </option>
                      ))}
                  </select>
                </Field>
              </div>
            </>
          ) : (
            <>
              <Field label="Categoria (raiz ou subcategoria)" error={errors.category}>
                <CategoryTreeSelect
                  categories={categories}
                  type={form.type}
                  value={form.category}
                  onChange={(categoryId) => set('category', categoryId)}
                  placeholder={`Selecione a categoria de ${form.type}...`}
                  error={Boolean(errors.category)}
                />
              </Field>

              <Field label="Conta" error={errors.account}>
                <select
                  className="field"
                  value={form.account}
                  onChange={(event) => set('account', event.target.value)}
                >
                  <option value="">Selecione a conta</option>
                  {accounts.map((account) => (
                    <option key={account.id} value={account.id}>
                      {account.name}
                    </option>
                  ))}
                </select>
              </Field>
            </>
          )}

          {!groupMode && (
            <Field label="Notas" error={errors.notes}>
              <textarea
                className="field min-h-20 resize-none"
                value={form.notes}
                onChange={(event) => set('notes', event.target.value)}
                placeholder="Informações adicionais (opcional)"
              />
            </Field>
          )}

          {!isTransfer && !groupMode && (
            <Field label="Comprovante" error={errors.attachment}>
              <button
                type="button"
                onClick={() => fileRef.current?.click()}
                onDragOver={(event) => {
                  event.preventDefault()
                  setDragging(true)
                }}
                onDragLeave={() => setDragging(false)}
                onDrop={handleDrop}
                className={cn(
                  'flex w-full flex-col items-center rounded-xl border border-dashed px-5 py-5 text-center transition',
                  dragging
                    ? 'border-fin-primary bg-indigo-50'
                    : 'border-fin-border bg-fin-surface hover:border-fin-primary/50',
                )}
              >
                {form.attachment ? (
                  <FileText className="mb-2 h-6 w-6 text-fin-primary" />
                ) : (
                  <UploadCloud className="mb-2 h-6 w-6 text-fin-muted" />
                )}
                <span className="text-sm font-medium text-fin-text">
                  {form.attachment?.name || 'Clique ou arraste um arquivo'}
                </span>
                <span className="mt-1 text-xs text-fin-muted">PDF, PNG ou JPEG, até 5 MB</span>
              </button>
              <input
                ref={fileRef}
                type="file"
                accept="application/pdf,image/png,image/jpeg"
                className="hidden"
                onChange={(event) => {
                  const file = event.target.files?.[0]
                  if (file) validateFile(file)
                }}
              />
            </Field>
          )}

          {message && (
            <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-fin-danger">{message}</p>
          )}

          <div className="flex justify-end gap-3 border-t border-fin-border pt-4">
            <button type="button" className="btn-secondary" onClick={() => onOpenChange(false)}>
              <X className="h-4 w-4" />
              Cancelar
            </button>
            <button type="submit" className="btn-primary" disabled={saving}>
              {saving ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Salvando...
                </>
              ) : (
                <>
                  <Check className="h-4 w-4" />
                  {groupMode
                    ? 'Aplicar ao grupo'
                    : editingTransfer
                      ? 'Salvar alterações'
                      : 'Criar lançamento'}
                </>
              )}
            </button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function Field({
  label,
  error,
  children,
}: {
  label: string
  error?: string
  children: React.ReactNode
}) {
  return (
    <label className="block space-y-1.5">
      <span className="text-[13px] font-medium text-fin-text">{label}</span>
      {children}
      {error && <span className="block text-xs text-fin-danger">{error}</span>}
    </label>
  )
}
