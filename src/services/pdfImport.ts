import pb from '@/lib/pocketbase/client'
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

/**
 * Lê um PDF de fatura/extrato e devolve apenas um RASCUNHO de lançamentos
 * (receitas e despesas — transferências não fazem parte da importação).
 */
export async function importPdf(
  file: File,
): Promise<PdfImportResult & { draft: PdfImportDraftItem[] }> {
  const content: Record<string, unknown> = { filename: file.name }
  const raw = await pb.send<{ draft?: PdfImportDraftItem[]; created?: number }>(
    '/backend/v1/import/pdf',
    {
      method: 'POST',
      body: toFormBody(content, file),
    },
  )
  return {
    created: 0,
    draft: (raw?.draft || []).map((item) => ({
      ...item,
      type: (item.type === 'receita' ? 'receita' : 'despesa') as PdfImportDraftType,
    })),
  }
}

function toFormBody(content: Record<string, unknown>, file: File): FormData {
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
  const result = await pb.send<{ created: number }>('/backend/v1/import/pdf/confirm', {
    method: 'POST',
    content: JSON.stringify({
      account_id: accountId,
      items: items.map((item) => ({
        date: item.date,
        description: item.description,
        amount: item.amount,
        type: item.type,
        category_id: item.category_id,
      })),
    }),
    headers: { 'Content-Type': 'application/json' },
  })
  return { created: result?.created ?? items.length }
}

export type { TransactionInput, TransactionType }
