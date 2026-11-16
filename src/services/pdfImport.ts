import pb from '@/lib/pocketbase/client'

export interface PdfImportDraftItem {
  date: string
  description: string
  amount: number
  type: 'receita' | 'despesa'
  category_id: string
  category_name: string
}

export interface PdfImportResult {
  draft: PdfImportDraftItem[]
  total: number
  truncated?: boolean
}

export interface PdfImportConfirmInput {
  date: string
  description: string
  amount: number
  type: 'receita' | 'despesa'
  category_id: string
}

function buildErrorPayload(error: unknown): { message: string; status: number } {
  const err = error as { response?: { message?: string; status?: number }; status?: number }
  const status = err?.response?.status ?? err?.status ?? 0
  const message = err?.response?.message || ''
  return { message, status }
}

/**
 * Envia o PDF do usuário ao backend, que extrai o texto e interpreta os
 * lançamentos com IA. Devolve o RASCUNHO — nada é gravado ainda.
 */
export async function importPdf(file: File): Promise<PdfImportResult> {
  const form = new FormData()
  form.set('file', file)
  try {
    return await pb.send<PdfImportResult>('/backend/v1/import/pdf', {
      method: 'POST',
      body: form,
    })
  } catch (error) {
    const { message, status } = buildErrorPayload(error)
    const fallback =
      'Não foi possível processar o PDF agora. Verifique o arquivo (PDF de fatura de cartão ou extrato, com texto selecionável, até 10 MB) e tente novamente.'
    const friendly =
      status === 413
        ? 'O PDF é muito grande. O limite é de 10 MB — tente um arquivo menor.'
        : status === 422
          ? message ||
            'Não foi possível ler o texto deste PDF. Ele pode estar escaneado (imagem) ou corrompido. Tente outro arquivo com texto selecionável.'
          : message || fallback
    throw new Error(friendly)
  }
}

/**
 * Confirma a importação: cria os lançamentos REAIS vinculados à conta/cartão
 * e categorias escolhidas na tela de revisão.
 */
export async function confirmPdfImport(
  accountId: string,
  transactions: PdfImportConfirmInput[],
): Promise<{ created: number }> {
  try {
    return await pb.send<{ created: number }>('/backend/v1/import/pdf/confirm', {
      method: 'POST',
      content: JSON.stringify({ account_id: accountId, transactions }),
      headers: { 'Content-Type': 'application/json' },
    })
  } catch (error) {
    const { message } = buildErrorPayload(error)
    throw new Error(
      message ||
        'Não foi possível criar os lançamentos. Verifique os dados da revisão e tente novamente.',
    )
  }
}
