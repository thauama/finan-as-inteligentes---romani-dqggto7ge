import pb from '@/lib/pocketbase/client'
import type { Account } from '@/types/finance'

export interface AccountImpact {
  id: string
  name: string
  type: string
  transactions: number
  transfers: number
  bills: number
  active_recurrings: number
}

/**
 * Consulta ao backend quantos lançamentos, transferências, contas a
 * pagar/receber e recorrências ativas estão vinculados a uma conta.
 */
export async function getAccountImpact(accountId: string): Promise<AccountImpact> {
  return pb.send<AccountImpact>(`/backend/v1/accounts/${encodeURIComponent(accountId)}/impact`, {
    method: 'GET',
  })
}

/**
 * Exclui a conta pela rota atômica do backend.
 * - mode 'delete': exclui a conta JUNTO com todos os lançamentos vinculados
 *   (incluindo transferências em que ela é origem ou destino) e as contas a
 *   pagar/receber vinculadas.
 * - mode 'keep': só permitido quando a conta NÃO tem lançamentos — mantém as
 *   contas a pagar/receber (desvinculando) e desativa recorrências.
 *
 * IMPORTANTE: o corpo vai em `body` — o SDK trata qualquer opção desconhecida
 * (ex.: `content`) como query parameter e o hook receberia o corpo vazio.
 */
export async function deleteAccountWithCleanup(
  accountId: string,
  mode: 'delete' | 'keep',
): Promise<void> {
  await pb.send(`/backend/v1/accounts/${encodeURIComponent(accountId)}`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: { mode },
  })
}

export type { Account }
