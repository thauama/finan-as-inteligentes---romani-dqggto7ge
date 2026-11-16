import pb from '@/lib/pocketbase/client'
import type { Transaction } from '@/types/finance'

export interface TransferInput {
  from_account_id: string
  to_account_id: string
  amount: number
  date: string
  description?: string
  notes?: string
}

export interface UpdateTransferInput extends TransferInput {
  id: string
}

function transferPayload(input: TransferInput) {
  return {
    account_id: input.from_account_id,
    destination_account_id: input.to_account_id,
    amount: input.amount,
    date: input.date,
    description: input.description,
    notes: input.notes,
  }
}

/**
 * Cria uma transferência entre contas no backend (rota atômica):
 * um lançamento 'transferencia' com conta de origem e conta de destino.
 *
 * IMPORTANTE: o corpo vai em `body` — o SDK trata qualquer opção desconhecida
 * (ex.: `content`) como query parameter e o hook receberia o corpo vazio.
 */
export async function createTransfer(input: TransferInput): Promise<Transaction> {
  return pb.send<Transaction>(
    '/backend/v1/transactions/transfer?expand=account,destination_account',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: transferPayload(input),
    },
  )
}

/**
 * Atualiza uma transferência existente (mesmo lançamento, sem criar cópia):
 * usa a rota dedicada, que preserva o tipo 'transferencia' e a posse do registro.
 */
export async function updateTransfer(input: UpdateTransferInput): Promise<Transaction> {
  return pb.send<Transaction>(
    `/backend/v1/transactions/transfer/${input.id}?expand=account,destination_account`,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: transferPayload(input),
    },
  )
}
