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

/**
 * Cria uma transferência entre contas no backend (rota atômica):
 * um lançamento 'transferencia' com conta de origem e conta de destino.
 */
export async function createTransfer(input: TransferInput): Promise<Transaction> {
  return pb.send<Transaction>('/backend/v1/transactions/transfer', {
    method: 'POST',
    content: JSON.stringify({
      account_id: input.from_account_id,
      destination_account_id: input.to_account_id,
      amount: input.amount,
      date: input.date,
      description: input.description,
      notes: input.notes,
    }),
    headers: { 'Content-Type': 'application/json' },
    query: { expand: 'account,destination_account' },
  })
}

/**
 * Atualiza uma transferência existente (mesmo lançamento, sem criar cópia):
 * usa a rota dedicada, que preserva o tipo 'transferencia' e a posse do registro.
 */
export async function updateTransfer(input: UpdateTransferInput): Promise<Transaction> {
  return pb.send<Transaction>(`/backend/v1/transactions/transfer/${input.id}`, {
    method: 'PATCH',
    content: JSON.stringify({
      account_id: input.from_account_id,
      destination_account_id: input.to_account_id,
      amount: input.amount,
      date: input.date,
      description: input.description,
      notes: input.notes,
    }),
    headers: { 'Content-Type': 'application/json' },
    query: { expand: 'account,destination_account' },
  })
}
