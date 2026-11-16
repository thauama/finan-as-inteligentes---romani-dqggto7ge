import pb from '@/lib/pocketbase/client'
import { ClientResponseError } from 'pocketbase'
import type { TransactionInput, TransactionType } from '@/types/finance'

export type PdfImportDraftType = Extract<TransactionType, 'receita' | 'despesa'>

export interface PdfImportDraftItem {
  date: string
  description: string
  amount: number
  type: PdfImportDraftType
  category_id: string
  category_name?: string
}

export interface PdfImportResult {
  created: number
}

export interface PdfImportConfirmInput extends PdfImportDraftItem {}

/** Causas conhecidas devolvidas pelo backend no corpo `{error, kind}`. */
export type PdfImportErrorKind =
  | 'sem_texto'
  | 'grande'
  | 'ilegivel'
  | 'ia'
  | 'sem_lancamentos'
  | 'auth'
  | 'rede'
  | 'desconhecido'

/**
 * Erro com a causa REAL da falha na importação — nunca uma mensagem genérica.
 * `status === 401` (ou `kind === 'auth'`) indica sessão expirada: a UI oferece
 * ir para o login e refazer o fluxo depois.
 */
export class PdfImportError extends Error {
  kind: PdfImportErrorKind
  status: number

  constructor(message: string, kind: PdfImportErrorKind, status: number) {
    super(message)
    this.name = 'PdfImportError'
    this.kind = kind
    this.status = status
  }

  get isAuthError(): boolean {
    return this.status === 401 || this.kind === 'auth'
  }
}

const AUTH_MESSAGE = 'Sua sessão expirou. Faça login novamente para importar o PDF.'
const NETWORK_MESSAGE =
  'Não foi possível conectar ao servidor. Verifique sua internet e tente novamente.'

/** Traduz qualquer erro de `pb.send` para um PdfImportError com a causa real. */
function toPdfImportError(err: unknown): PdfImportError {
  if (err instanceof PdfImportError) return err

  if (err instanceof ClientResponseError) {
    // Corpo `{error, kind}` devolvido pelas rotas de importação (e.json).
    const body = (err.response || {}) as { error?: unknown; kind?: unknown }
    const serverMessage =
      typeof body.error === 'string' && body.error.trim() ? body.error.trim() : ''
    const kind =
      typeof body.kind === 'string' && body.kind ? (body.kind as PdfImportErrorKind) : null

    if (err.status === 401) {
      return new PdfImportError(AUTH_MESSAGE, 'auth', 401)
    }
    if (serverMessage) {
      return new PdfImportError(serverMessage, kind || 'desconhecido', err.status)
    }
    if (err.status === 0) {
      return new PdfImportError(NETWORK_MESSAGE, 'rede', 0)
    }
    if (err.status >= 500) {
      return new PdfImportError(
        'O servidor não conseguiu processar o PDF agora. Tente novamente em instantes.',
        'desconhecido',
        err.status,
      )
    }
    return new PdfImportError(getGenericMessageForStatus(err.status), 'desconhecido', err.status)
  }

  if (err instanceof Error && err.message) {
    // Erro de rede do fetch (TypeError: Failed to fetch) ou falha local.
    if (/fetch|network|Load failed/i.test(err.message)) {
      return new PdfImportError(NETWORK_MESSAGE, 'rede', 0)
    }
    return new PdfImportError(err.message, 'desconhecido', 0)
  }

  return new PdfImportError(
    'Falha inesperada ao importar o PDF. Tente novamente.',
    'desconhecido',
    0,
  )
}

function getGenericMessageForStatus(status: number): string {
  if (status === 400)
    return 'Não foi possível processar a solicitação. Verifique o arquivo enviado.'
  if (status === 413) return 'O PDF é muito grande. O limite é de 10 MB — tente um arquivo menor.'
  return 'Não foi possível importar o PDF. Tente novamente.'
}

/**
 * Lê um PDF de fatura/extrato e devolve apenas um RASCUNHO de lançamentos
 * (receitas e despesas — transferências não fazem parte da importação).
 */
export async function importPdf(
  file: File,
): Promise<PdfImportResult & { draft: PdfImportDraftItem[] }> {
  try {
    const raw = await pb.send<{ draft?: PdfImportDraftItem[]; created?: number }>(
      '/backend/v1/import/pdf',
      {
        method: 'POST',
        body: toFormBody(file),
      },
    )
    return {
      created: 0,
      draft: (raw?.draft || []).map((item) => ({
        ...item,
        type: (item.type === 'receita' ? 'receita' : 'despesa') as PdfImportDraftType,
      })),
    }
  } catch (err) {
    throw toPdfImportError(err)
  }
}

function toFormBody(file: File): FormData {
  const form = new FormData()
  form.set('file', file, file.name)
  return form
}

/**
 * Confirma o rascunho: cria os lançamentos (receita/despesa) na conta escolhida.
 */
export async function confirmPdfImport(
  accountId: string,
  items: PdfImportDraftItem[],
): Promise<PdfImportResult> {
  // IMPORTANTE: o corpo vai em `body` — o SDK trata qualquer opção desconhecida
  // (ex.: `content`) como query parameter e o hook receberia o corpo vazio.
  try {
    const result = await pb.send<{ created: number }>('/backend/v1/import/pdf/confirm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: {
        account_id: accountId,
        items: items.map((item) => ({
          date: item.date,
          description: item.description,
          amount: item.amount,
          type: item.type,
          category_id: item.category_id,
        })),
      },
    })
    return { created: result?.created ?? items.length }
  } catch (err) {
    throw toPdfImportError(err)
  }
}

export type { TransactionInput, TransactionType }
