import pb from '@/lib/pocketbase/client'
import { escapeFilter } from '@/lib/format'
import type { RegularTransactionInput } from '@/services/transactions'

export interface InstallmentGroup {
  token: string
  ids: string[]
  count: number
}

/**
 * Agrupa os lançamentos de um mesmo parcelamento pelo sufixo "#P{token}" na
 * descrição (convenção criada pelo import_pdf_confirm.js).
 */
export function groupInstallmentTokens(transactions: Array<{ id: string; description: string }>) {
  const map = new Map<string, string[]>()
  for (const t of transactions) {
    const match = /#P([A-Za-z0-9]+)/.exec(t.description || '')
    if (!match) continue
    const list = map.get(match[1]) || []
    list.push(t.id)
    map.set(match[1], list)
  }
  return map
}

export function findGroupMembers(
  transaction: { description: string },
  transactions: Array<{ id: string; description: string }>,
): string[] {
  const token = transaction.description?.match(/#P([A-Za-z0-9]+)/)?.[1]
  if (!token) return []
  return transactions.filter((t) => t.description?.includes(`#P${token}`)).map((t) => t.id)
}

/**
 * Atualiza valor/categoria/conta (e descrição, quando alterada) em TODOS os
 * lançamentos do grupo de parcelas. Retorna quantos foram atualizados.
 */
export async function updateInstallmentGroup(
  ids: string[],
  input: Partial<Pick<RegularTransactionInput, 'amount' | 'category' | 'account'>>,
) {
  const collection = pb.collection('transactions')
  let updated = 0
  for (const id of ids) {
    const form = new FormData()
    if (input.amount !== undefined) form.set('amount', String(input.amount))
    if (input.category !== undefined) form.set('category', input.category)
    if (input.account !== undefined) form.set('account', input.account)
    if (form.keys().next().done) return updated
    await collection.update(id, form)
    updated++
  }
  return updated
}

/** Exclui em bloco todos os lançamentos do grupo. Retorna quantos foram excluídos. */
export async function deleteInstallmentGroup(ids: string[]) {
  const collection = pb.collection('transactions')
  let deleted = 0
  for (const id of ids) {
    try {
      await collection.delete(id)
      deleted++
    } catch {
      // 404 em um item não deve abortar o bloco: segue com o resto.
    }
  }
  return deleted
}

export function installmentsFilter(token: string) {
  return `description ~ '${escapeFilter(`#P${token}`)}'`
}
