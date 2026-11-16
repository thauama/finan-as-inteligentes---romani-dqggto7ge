import { useRef, useState, type DragEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  AlertTriangle,
  CalendarDays,
  Check,
  FileText,
  Loader2,
  LogIn,
  RotateCcw,
  Sparkles,
  Split,
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
import { PdfImportReviewSummary } from '@/components/finance/PdfImportReviewSummary'
import { useFinance } from '@/contexts/FinanceContext'
import { useToast } from '@/hooks/use-toast'
import { brl } from '@/lib/format'
import { cn } from '@/lib/utils'
import {
  IMPORT_SHEET_MAX_BYTES,
  IMPORT_SHEET_MAX_ROWS,
  SheetImportError,
  importSheetFile,
} from '@/lib/importSheet'
import { detectInstallment, futureInstallmentsCount } from '@/lib/installments'
import { markDuplicates } from '@/lib/duplicates'
import { listTransactions } from '@/services/transactions'
import {
  confirmPdfImport,
  importPdf,
  PdfImportError,
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
  /** Selo visível de possível duplicado (fica true mesmo se o usuário marcar de novo). */
  duplicateFlag: boolean
  /** false = parcelamento desmarcado: lança só a parcela atual como linha comum. */
  installments: boolean
}

export function PdfImportModal({
  open,
  onOpenChange,
  onImported,
  defaultAccountId,
}: PdfImportModalProps) {
  const { accounts, categories, refreshAll } = useFinance()
  const navigate = useNavigate()
  const { toast } = useToast()
  const [rows, setRows] = useState<DraftRow[] | null>(null)
  const [accountId, setAccountId] = useState('')
  const [fileName, setFileName] = useState('')
  const [extracting, setExtracting] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [authError, setAuthError] = useState(false)
  const [kind, setKind] = useState<'pdf' | 'sheet'>('pdf')
  const [sheetInfo, setSheetInfo] = useState<{ read: number; ignored: number } | null>(null)

  const fileRef = useRef<HTMLInputElement>(null)

  function reset() {
    setRows(null)
    setAccountId(defaultAccountId || '')
    setFileName('')
    setError('')
    setAuthError(false)
    setExtracting(false)
    setSaving(false)
    setKind('pdf')
    setSheetInfo(null)
  }

  function handleOpenChange(next: boolean) {
    if (!next) reset()
    onOpenChange(next)
  }

  /** Erros de sessão expirada: mensagem clara + caminho controlado para o login. */
  function handleAuthError(message: string) {
    setRows(null)
    setFileName('')
    setError(message)
    setAuthError(true)
  }

  const SHEET_EXTENSIONS = ['.xlsx', '.xls', '.csv', '.txt']

  function validateFile(file: File) {
    setError('')
    setAuthError(false)
    const lowerName = file.name.toLowerCase()
    const isSheet = SHEET_EXTENSIONS.some((extension) => lowerName.endsWith(extension))
    const isPdf = file.type === 'application/pdf' || lowerName.endsWith('.pdf')

    if (!isSheet && !isPdf && file.type) {
      setError('Envie um PDF, Excel (.xlsx) ou CSV da fatura ou extrato.')
      setAuthError(false)
      return
    }
    if (isPdf) {
      if (file.size > 10 * 1024 * 1024) {
        setError('O PDF deve ter no máximo 10 MB.')
        return
      }
      setKind('pdf')
      setSheetInfo(null)
      setFileName(file.name)
      void extract(file)
      return
    }
    if (isSheet) {
      if (file.size > IMPORT_SHEET_MAX_BYTES) {
        setError(
          `A planilha deve ter no máximo ${Math.round(IMPORT_SHEET_MAX_BYTES / (1024 * 1024))} MB (o arquivo tem ${(file.size / (1024 * 1024)).toFixed(1)} MB).`,
        )
        return
      }
      setKind('sheet')
      setSheetInfo(null)
      setFileName(file.name)
      void extractSheet(file)
      return
    }
    setError('Envie um PDF, Excel (.xlsx) ou CSV da fatura ou extrato.')
  }

  function handleDrop(event: DragEvent<HTMLButtonElement>) {
    event.preventDefault()
    const file = event.dataTransfer.files[0]
    if (file) validateFile(file)
  }

  /**
   * Busca lançamentos existentes do usuário para a checagem de duplicidade.
   * Falha silenciosa: sem duplicidade marcada, a importação segue normal.
   */
  async function fetchExisting(): Promise<
    Array<{ date: string; amount: number; description: string }>
  > {
    try {
      const existing = await listTransactions()
      return existing.map((tx) => ({
        date: String(tx.date || '').slice(0, 10),
        amount: Number(tx.amount) || 0,
        description: String(tx.description || ''),
      }))
    } catch (_) {
      return []
    }
  }

  async function extract(file: File) {
    setExtracting(true)
    setError('')
    setAuthError(false)
    try {
      const result = await importPdf(file)
      const existing = await fetchExisting()
      setRows(
        markDuplicates(result.draft, existing).map(({ duplicate, ...item }) => ({
          ...item,
          duplicateFlag: !!duplicate,
          discarded: !!duplicate,
          installments: true,
        })),
      )
      if (!accountId && accounts.length > 0) setAccountId(accounts[0].id)
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Falha ao processar o PDF.'
      if (err instanceof PdfImportError && err.isAuthError) {
        handleAuthError(message)
      } else {
        setRows(null)
        setError(message)
      }
    } finally {
      setExtracting(false)
    }
  }

  /** Excel/CSV: leitura direta das linhas no cliente, sem IA. */
  async function extractSheet(file: File) {
    setExtracting(true)
    setError('')
    setAuthError(false)
    try {
      const result = await importSheetFile(file, categories)
      if (result.draft.length === 0) {
        setRows(null)
        setFileName('')
        setError(
          `Nenhuma linha com data e valor válidos foi encontrada (${result.rowsRead} linha(s) lida(s), ${result.rowsIgnored} ignorada(s)). Verifique se a planilha tem as colunas "Data", "Descrição" e "Valor".`,
        )
        return
      }
      const existing = await fetchExisting()
      setRows(
        markDuplicates(result.draft, existing).map(({ duplicate, ...item }) => ({
          ...item,
          duplicateFlag: !!duplicate,
          discarded: !!duplicate,
          installments: true,
        })),
      )
      setSheetInfo({ read: result.rowsRead, ignored: result.rowsIgnored })
      if (!accountId && accounts.length > 0) setAccountId(accounts[0].id)
    } catch (err) {
      const message =
        err instanceof SheetImportError
          ? err.message
          : 'Não foi possível ler a planilha. Verifique o arquivo e tente novamente.'
      setRows(null)
      setFileName('')
      setSheetInfo(null)
      setError(message)
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

  /** Desmarcar o parcelamento: a linha vira lançamento comum (só a parcela atual). */
  function toggleInstallments(index: number) {
    setRows((current) =>
      current
        ? current.map((row, i) => (i === index ? { ...row, installments: !row.installments } : row))
        : current,
    )
  }

  const activeRows = (rows || []).filter((row) => !row.discarded)
  const totalAmount = activeRows.reduce(
    (sum, row) => sum + (row.type === 'despesa' ? row.amount : -row.amount),
    0,
  )
  const futureCount = activeRows.reduce(
    (sum, row) =>
      sum +
      (row.installments && row.installment_current && row.installment_total
        ? futureInstallmentsCount({
            current: row.installment_current,
            total: row.installment_total,
          })
        : 0),
    0,
  )
  const duplicateCount = (rows || []).filter((row) => row.duplicateFlag).length

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
          installment_current: row.installments ? row.installment_current || 0 : 0,
          installment_total: row.installments ? row.installment_total || 0 : 0,
        })),
      )
      await refreshAll()
      onImported?.(result.created)
      toast({
        title: 'Importação concluída',
        description:
          (result.future_created || 0) > 0
            ? `${result.created} lançamento(s) criado(s) e ${result.future_created} parcela(s) futura(s) agendada(s).`
            : `${result.created} lançamento(s) criado(s).`,
      })
      handleOpenChange(false)
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Falha ao criar os lançamentos.'
      if (err instanceof PdfImportError && err.isAuthError) {
        handleAuthError(message)
      } else {
        setError(message)
      }
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
            Importar fatura ou extrato (PDF, Excel ou CSV)
          </DialogTitle>
          <DialogDescription>
            Anexe o PDF da fatura de cartão, o extrato em Excel (.xlsx) ou CSV. Os lançamentos
            aparecem abaixo como rascunho editável — nada é lançado antes da sua confirmação.
          </DialogDescription>
        </DialogHeader>

        {authError ? (
          <div className="flex flex-col items-center gap-4 rounded-xl border border-fin-border bg-fin-surface px-6 py-10 text-center">
            <LogIn className="h-8 w-8 text-fin-primary" />
            <div className="space-y-1">
              <p className="text-sm font-semibold text-fin-text">Sessão expirada</p>
              <p className="max-w-sm text-xs leading-relaxed text-fin-muted">
                Faça login novamente para continuar a importação. Seu PDF pode ser reenviado em
                seguida — nada foi alterado nas suas finanças.
              </p>
            </div>
            <div className="flex gap-3">
              <button
                type="button"
                className="btn-secondary"
                onClick={() => handleOpenChange(false)}
              >
                <X className="h-4 w-4" />
                Fechar
              </button>
              <button
                type="button"
                className="btn-primary"
                onClick={() => {
                  const wasOpen = open
                  handleOpenChange(false)
                  if (wasOpen) navigate('/login')
                }}
              >
                <LogIn className="h-4 w-4" />
                Ir para o login
              </button>
            </div>
          </div>
        ) : (
          <>
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
                      <span className="text-sm font-semibold text-fin-text">
                        {kind === 'pdf' ? 'Lendo o PDF com IA...' : 'Lendo a planilha...'}
                      </span>
                      <span className="mt-1 text-xs text-fin-muted">
                        {kind === 'pdf'
                          ? 'Isso pode levar alguns segundos.'
                          : 'Lendo as linhas do arquivo...'}
                      </span>
                    </>
                  ) : (
                    <>
                      <span className="text-sm font-semibold text-fin-text">
                        {fileName || 'Clique ou arraste o PDF, Excel ou CSV da fatura/extrato'}
                      </span>
                      <span className="mt-1 text-xs text-fin-muted">
                        PDF com texto selecionável (até 10 MB) · Excel/CSV até 5 MB e{' '}
                        {IMPORT_SHEET_MAX_ROWS.toLocaleString('pt-BR')} linhas
                      </span>
                    </>
                  )}
                </button>
                <input
                  ref={fileRef}
                  type="file"
                  accept="application/pdf,.xlsx,.xls,.csv,.txt"
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
                    Dica: use o PDF baixado do site do banco ou do app do cartão — faturas
                    escaneadas (imagem) não têm texto legível.
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
                {sheetInfo && (
                  <p className="text-xs text-fin-muted">
                    {sheetInfo.read} linha(s) lida(s), {sheetInfo.ignored} ignorada(s) (sem data,
                    valor ou duplicadas).
                  </p>
                )}

                {duplicateCount > 0 && (
                  <div className="flex items-start gap-2 rounded-lg bg-amber-50 px-3 py-2.5 text-sm text-amber-800">
                    <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                    <span>
                      {duplicateCount} linha(s) parecem já estar lançadas (data próxima, mesmo valor
                      e descrição parecida) e começam desmarcadas — marque-as só se quiser lançar de
                      novo. É uma verificação por semelhança: dois gastos legítimos iguais podem
                      casar, e a decisão é sua.
                    </span>
                  </div>
                )}

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
                  <PdfImportReviewSummary
                    count={activeRows.length}
                    total={(rows || []).length}
                    futureInstallments={futureCount}
                    duplicates={duplicateCount}
                    totalFormatted={`${
                      totalAmount >= 0 ? '−' : '+'
                    } ${brl.format(Math.abs(totalAmount))}`}
                    isNegative={totalAmount > 0}
                  />
                </div>

                {error && (
                  <div className="flex items-start gap-2 rounded-lg bg-red-50 px-3 py-2.5 text-sm text-fin-danger">
                    <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                    <span>{error}</span>
                  </div>
                )}

                <div className="space-y-3">
                  {rows.map((row, index) => {
                    const match =
                      row.installment_current && row.installment_total
                        ? {
                            current: row.installment_current,
                            total: row.installment_total,
                          }
                        : detectInstallment(row.description)
                    return (
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
                            <span className="text-[11px] font-medium text-fin-muted">
                              Descrição
                            </span>
                            <input
                              className="field py-1.5 text-xs"
                              value={row.description}
                              disabled={row.discarded}
                              onChange={(event) =>
                                updateRow(index, { description: event.target.value })
                              }
                            />
                          </label>
                          <label className="block space-y-1">
                            <span className="text-[11px] font-medium text-fin-muted">
                              Valor (R$)
                            </span>
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
                            <span className="text-[11px] font-medium text-fin-muted">
                              Categoria
                            </span>
                            <CategoryTreeSelect
                              categories={categories}
                              type={row.type}
                              value={row.category_id}
                              disabled={row.discarded}
                              onChange={(categoryId) =>
                                updateRow(index, { category_id: categoryId })
                              }
                              placeholder={
                                row.category_name
                                  ? `Sugerido: ${row.category_name}`
                                  : 'Selecione a categoria...'
                              }
                            />
                          </label>
                        </div>
                        <div className="mt-2 flex flex-wrap items-center gap-2">
                          {match && (
                            <span
                              className={cn(
                                'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold',
                                row.installments
                                  ? 'bg-indigo-50 text-indigo-700'
                                  : 'bg-fin-surface text-fin-muted',
                              )}
                            >
                              <Split className="h-3 w-3" />
                              {match.current}/{match.total} → {futureInstallmentsCount(match)}{' '}
                              parcela(s) futura(s)
                            </span>
                          )}
                          {row.duplicateFlag && (
                            <span className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-2 py-0.5 text-[11px] font-semibold text-amber-700">
                              <AlertTriangle className="h-3 w-3" />
                              Possível duplicado
                            </span>
                          )}
                          <label
                            className={cn(
                              'ml-auto flex cursor-pointer items-center gap-1.5 text-[11px] font-medium text-fin-muted',
                              row.discarded && 'pointer-events-none opacity-50',
                            )}
                            title="Desmarque para lançar só esta parcela, sem as futuras"
                          >
                            <input
                              type="checkbox"
                              className="h-3.5 w-3.5 accent-indigo-600"
                              checked={row.installments}
                              disabled={row.discarded}
                              onChange={() => toggleInstallments(index)}
                            />
                            Criar parcelas futuras
                          </label>
                          <label
                            className={cn(
                              'flex cursor-pointer items-center gap-1.5 text-[11px] font-medium text-fin-muted',
                              row.discarded && 'pointer-events-none opacity-50',
                            )}
                            title="Marque para lançar mesmo parecendo duplicado"
                          >
                            <input
                              type="checkbox"
                              className="h-3.5 w-3.5 accent-indigo-600"
                              checked={!row.discarded}
                              disabled={row.discarded}
                              onChange={() => toggleDiscard(index)}
                            />
                            Incluir no envio
                          </label>
                        </div>
                      </div>
                    )
                  })}
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
                        {futureCount > 0 ? ` + ${futureCount} parcela(s) futura(s)` : ''}
                      </>
                    )}
                  </button>
                </div>
              </div>
            )}
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
