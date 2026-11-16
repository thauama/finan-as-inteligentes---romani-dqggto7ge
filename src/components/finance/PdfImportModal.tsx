import { useRef, useState, type DragEvent } from 'react'
import {
  AlertTriangle,
  CalendarDays,
  Check,
  FileText,
  Loader2,
  RotateCcw,
  Sparkles,
  Trash2,
  UploadCloud,
  X,
} from 'lucide-react'

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { CategoryTreeSelect } from '@/components/finance/CategoryTreeSelect'
import { useFinance } from '@/contexts/FinanceContext'
import { brl } from '@/lib/format'
import { cn } from '@/lib/utils'
import {
  confirmPdfImport,
  importPdf,
  type PdfImportDraftItem,
  type PdfImportDraftType,
} from '@/services/pdfImport'

interface PdfImportModalProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onImported?: (created: number) => void
  defaultAccountId?: string
}

interface DraftRow extends PdfImportDraftItem {
  discarded: boolean
}

export function PdfImportModal({
  open,
  onOpenChange,
  onImported,
  defaultAccountId,
}: PdfImportModalProps) {
  const { accounts, categories, refreshAll } = useFinance()
  const [rows, setRows] = useState<DraftRow[] | null>(null)
  const [accountId, setAccountId] = useState('')
  const [fileName, setFileName] = useState('')
  const [extracting, setExtracting] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const fileRef = useRef<HTMLInputElement>(null)

  function reset() {
    setRows(null)
    setAccountId(defaultAccountId || '')
    setFileName('')
    setError('')
    setExtracting(false)
    setSaving(false)
  }

  function handleOpenChange(next: boolean) {
    if (!next) reset()
    onOpenChange(next)
  }

  function validateFile(file: File) {
    if (file.type && file.type !== 'application/pdf') {
      setError('Envie um arquivo PDF (fatura de cartão ou extrato bancário).')
      return
    }
    if (file.size > 10 * 1024 * 1024) {
      setError('O PDF deve ter no máximo 10 MB.')
      return
    }
    setError('')
    setFileName(file.name)
    void extract(file)
  }

  function handleDrop(event: DragEvent<HTMLButtonElement>) {
    event.preventDefault()
    const file = event.dataTransfer.files[0]
    if (file) validateFile(file)
  }

  async function extract(file: File) {
    setExtracting(true)
    setError('')
    try {
      const result = await importPdf(file)
      setRows(result.draft.map((item) => ({ ...item, discarded: false })))
      if (!accountId && accounts.length > 0) setAccountId(accounts[0].id)
    } catch (err) {
      setRows(null)
      setError(err instanceof Error ? err.message : 'Falha ao processar o PDF.')
    } finally {
      setExtracting(false)
    }
  }

  function updateRow(index: number, patch: Partial<DraftRow>) {
    setRows((current) =>
      current ? current.map((row, i) => (i === index ? { ...row, ...patch } : row)) : current,
    )
  }

  function toggleDiscard(index: number) {
    setRows((current) =>
      current
        ? current.map((row, i) => (i === index ? { ...row, discarded: !row.discarded } : row))
        : current,
    )
  }

  const activeRows = (rows || []).filter((row) => !row.discarded)
  const totalAmount = activeRows.reduce(
    (sum, row) => sum + (row.type === 'despesa' ? row.amount : -row.amount),
    0,
  )

  async function submit() {
    if (!accountId) {
      setError('Selecione a conta ou cartão em que os lançamentos serão registrados.')
      return
    }
    if (activeRows.length === 0) {
      setError('Mantenha pelo menos um lançamento na revisão para confirmar.')
      return
    }
    const invalid = activeRows.find(
      (row) => !row.description.trim() || !row.amount || row.amount <= 0 || !row.date,
    )
    if (invalid) {
      setError('Revise os lançamentos: há linhas sem descrição, valor ou data válidos.')
      return
    }
    setSaving(true)
    setError('')
    try {
      const result = await confirmPdfImport(
        accountId,
        activeRows.map((row) => ({
          date: row.date,
          description: row.description,
          amount: row.amount,
          type: row.type,
          category_id: row.category_id,
        })),
      )
      await refreshAll()
      onImported?.(result.created)
      handleOpenChange(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Falha ao criar os lançamentos.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-h-[92vh] overflow-y-auto border-fin-border bg-white sm:max-w-[760px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="h-5 w-5 text-fin-primary" />
            Importar fatura ou extrato (PDF)
          </DialogTitle>
          <DialogDescription>
            Anexe o PDF da fatura de cartão ou do extrato bancário. A leitura é feita por IA e os
            lançamentos aparecem abaixo como rascunho — nada é lançado antes da sua confirmação.
          </DialogDescription>
        </DialogHeader>

        {!rows && (
          <div className="space-y-4 pt-2">
            <button
              type="button"
              disabled={extracting}
              onClick={() => fileRef.current?.click()}
              onDragOver={(event) => event.preventDefault()}
              onDrop={handleDrop}
              className={cn(
                'flex w-full flex-col items-center rounded-xl border border-dashed px-5 py-10 text-center transition',
                extracting
                  ? 'border-fin-primary bg-indigo-50'
                  : 'border-fin-border bg-fin-surface hover:border-fin-primary/50',
              )}
            >
              {extracting ? (
                <Loader2 className="mb-3 h-8 w-8 animate-spin text-fin-primary" />
              ) : (
                <UploadCloud className="mb-3 h-8 w-8 text-fin-muted" />
              )}
              {extracting ? (
                <>
                  <span className="text-sm font-semibold text-fin-text">Lendo o PDF com IA...</span>
                  <span className="mt-1 text-xs text-fin-muted">
                    Isso pode levar alguns segundos.
                  </span>
                </>
              ) : (
                <>
                  <span className="text-sm font-semibold text-fin-text">
                    {fileName || 'Clique ou arraste o PDF da fatura/extrato'}
                  </span>
                  <span className="mt-1 text-xs text-fin-muted">
                    PDF com texto selecionável, até 10 MB
                  </span>
                </>
              )}
            </button>
            <input
              ref={fileRef}
              type="file"
              accept="application/pdf"
              className="hidden"
              onChange={(event) => {
                const file = event.target.files?.[0]
                if (file) validateFile(file)
              }}
            />

            {error && (
              <div className="flex items-start gap-2 rounded-lg bg-red-50 px-3 py-2.5 text-sm text-fin-danger">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                <span>{error}</span>
              </div>
            )}

            {extracting && (
              <p className="text-center text-xs text-fin-muted">
                Dica: use o PDF baixado do site do banco ou do app do cartão — faturas escaneadas
                (imagem) não têm texto legível.
              </p>
            )}

            <div className="flex justify-end border-t border-fin-border pt-4">
              <button
                type="button"
                className="btn-secondary"
                onClick={() => handleOpenChange(false)}
              >
                <X className="h-4 w-4" />
                Cancelar
              </button>
            </div>
          </div>
        )}

        {rows && (
          <div className="space-y-4 pt-2">
            <div className="grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end">
              <label className="block space-y-1.5">
                <span className="text-[13px] font-medium text-fin-text">
                  Conta / cartão de destino
                </span>
                <select
                  className="field"
                  value={accountId}
                  onChange={(event) => setAccountId(event.target.value)}
                >
                  <option value="">Selecione a conta</option>
                  {accounts.map((account) => (
                    <option key={account.id} value={account.id}>
                      {account.name}
                      {account.type === 'cartao' ? ' (cartão)' : ''}
                    </option>
                  ))}
                </select>
              </label>
              <div className="rounded-xl bg-fin-surface px-4 py-2.5 text-right">
                <p className="text-[11px] font-semibold uppercase tracking-wide text-fin-muted">
                  {activeRows.length} lançamento(s)
                </p>
                <p
                  className={cn(
                    'text-sm font-extrabold',
                    totalAmount > 0 ? 'text-rose-800' : 'text-emerald-800',
                  )}
                >
                  {totalAmount >= 0 ? '−' : '+'} {brl.format(Math.abs(totalAmount))}
                </p>
              </div>
            </div>

            {error && (
              <div className="flex items-start gap-2 rounded-lg bg-red-50 px-3 py-2.5 text-sm text-fin-danger">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                <span>{error}</span>
              </div>
            )}

            <div className="space-y-3">
              {rows.map((row, index) => (
                <div
                  key={index}
                  className={cn(
                    'rounded-xl border p-3 transition',
                    row.discarded
                      ? 'border-fin-border bg-fin-surface opacity-50'
                      : 'border-fin-border bg-white',
                  )}
                >
                  <div className="grid gap-2 sm:grid-cols-[110px_1fr_130px_auto]">
                    <label className="block space-y-1">
                      <span className="text-[11px] font-medium text-fin-muted">Data</span>
                      <div className="relative">
                        <CalendarDays className="absolute left-2.5 top-2.5 h-3.5 w-3.5 text-fin-muted" />
                        <input
                          type="date"
                          className="field py-1.5 pl-8 text-xs"
                          value={row.date}
                          disabled={row.discarded}
                          onChange={(event) => updateRow(index, { date: event.target.value })}
                        />
                      </div>
                    </label>
                    <label className="block space-y-1">
                      <span className="text-[11px] font-medium text-fin-muted">Descrição</span>
                      <input
                        className="field py-1.5 text-xs"
                        value={row.description}
                        disabled={row.discarded}
                        onChange={(event) => updateRow(index, { description: event.target.value })}
                      />
                    </label>
                    <label className="block space-y-1">
                      <span className="text-[11px] font-medium text-fin-muted">Valor (R$)</span>
                      <input
                        type="number"
                        min="0.01"
                        step="0.01"
                        className="field py-1.5 text-xs"
                        value={row.amount || ''}
                        disabled={row.discarded}
                        onChange={(event) =>
                          updateRow(index, { amount: Number(event.target.value) })
                        }
                      />
                    </label>
                    <div className="flex items-end justify-end">
                      <button
                        type="button"
                        title={row.discarded ? 'Restaurar linha' : 'Descartar linha'}
                        onClick={() => toggleDiscard(index)}
                        className={cn(
                          'rounded-lg p-2 transition',
                          row.discarded
                            ? 'text-fin-primary hover:bg-indigo-50'
                            : 'text-fin-muted hover:bg-red-50 hover:text-fin-danger',
                        )}
                      >
                        {row.discarded ? (
                          <RotateCcw className="h-4 w-4" />
                        ) : (
                          <Trash2 className="h-4 w-4" />
                        )}
                      </button>
                    </div>
                  </div>
                  <div className="mt-2 grid gap-2 sm:grid-cols-[130px_1fr]">
                    <label className="block space-y-1">
                      <span className="text-[11px] font-medium text-fin-muted">Tipo</span>
                      <select
                        className="field py-1.5 text-xs"
                        value={row.type}
                        disabled={row.discarded}
                        onChange={(event) =>
                          updateRow(index, {
                            type: event.target.value as PdfImportDraftType,
                            category_id: '',
                          })
                        }
                      >
                        <option value="despesa">Despesa</option>
                        <option value="receita">Receita</option>
                      </select>
                    </label>
                    <label className="block space-y-1">
                      <span className="text-[11px] font-medium text-fin-muted">Categoria</span>
                      <CategoryTreeSelect
                        categories={categories}
                        type={row.type}
                        value={row.category_id}
                        disabled={row.discarded}
                        onChange={(categoryId) => updateRow(index, { category_id: categoryId })}
                        placeholder={
                          row.category_name
                            ? `Sugerido: ${row.category_name}`
                            : 'Selecione a categoria...'
                        }
                      />
                    </label>
                  </div>
                </div>
              ))}
            </div>

            <div className="flex justify-end gap-3 border-t border-fin-border pt-4">
              <button
                type="button"
                className="btn-secondary"
                onClick={() => handleOpenChange(false)}
              >
                <X className="h-4 w-4" />
                Cancelar
              </button>
              <button
                type="button"
                className="btn-primary"
                onClick={() => void submit()}
                disabled={saving || activeRows.length === 0 || !accountId}
              >
                {saving ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Criando...
                  </>
                ) : (
                  <>
                    <Check className="h-4 w-4" />
                    Confirmar {activeRows.length} lançamento(s)
                  </>
                )}
              </button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
