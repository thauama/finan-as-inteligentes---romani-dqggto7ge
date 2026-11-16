import type { Transaction } from '@/types/finance'

export const TRANSFER_TYPE = 'transferencia' as const

export function isTransfer(transaction: Pick<Transaction, 'type'>): boolean {
  return transaction.type === TRANSFER_TYPE
}

/**
 * Rótulo de tipo para listagens/CSV: Receita, Despesa ou Transferência.
 */
export function transactionTypeLabel(
  transaction: Pick<Transaction, 'type'>,
): 'Receita' | 'Despesa' | 'Transferência' {
  if (transaction.type === 'receita') return 'Receita'
  if (transaction.type === TRANSFER_TYPE) return 'Transferência'
  return 'Despesa'
}

/**
 * Texto "Conta A → Conta B" para transferências, usando as contas carregadas
 * (ou expand do registro). Devolve '' quando não é transferência.
 */
export function transferAccountsLabel(
  transaction: Transaction,
  accountsById: Map<string, { name: string }>,
): string {
  if (!isTransfer(transaction)) return ''
  const from = accountsById.get(transaction.account)?.name || transaction.expand?.account?.name
  const to =
    accountsById.get(transaction.destination_account || '')?.name ||
    transaction.expand?.destination_account?.name
  if (!from || !to) return ''
  return `${from} → ${to}`
}
