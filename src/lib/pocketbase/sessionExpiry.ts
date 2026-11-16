import pb from '@/lib/pocketbase/client'
import { ClientResponseError } from 'pocketbase'

/**
 * Indica se um erro representa SESSÃO EXPIRADA (401) — o usuário está
 * autenticado localmente, mas o token não vale mais no servidor.
 *
 * É o detector central usado por toda ação autenticada (exclusão de conta,
 * importação de PDF, etc.): nunca deixe "Something went wrong" passar por um
 * 401 — mostre o painel de sessão expirada (SessionExpiryPanel).
 */
export function isSessionExpiredError(error: unknown): boolean {
  if (error instanceof ClientResponseError) return error.status === 401
  if (error && typeof error === 'object' && 'status' in error) {
    return (error as { status?: unknown }).status === 401
  }
  // Erros de rede do fetch carregam a mensagem do gateway.
  if (error instanceof Error) {
    return /401|requires valid record authorization/i.test(error.message)
  }
  return false
}

// Uma renovação por vez: chamadas concorrentes (boot + focus + intervalo)
// compartilham a MESMA promessa em vez de disparar auth-refresh duplicado.
let inFlight: Promise<boolean> | null = null
let lastRefreshAt = 0

/** true quando a última renovação bem-sucedida foi há menos de `maxAgeMs`. */
export function isSessionRefreshRecent(maxAgeMs: number): boolean {
  return Date.now() - lastRefreshAt < maxAgeMs
}

/**
 * Renova o token de autenticação do PocketBase, se houver usuário válido.
 * Resolve com `true` quando a sessão segue válida; `false` quando o refresh
 * falhou.
 *
 * IMPORTANTE: só limpa o authStore em 401 REAL. Falha de rede/timeout não pode
 * deslogar o usuário — era isso que derrubava a sessão no meio do upload do
 * Excel e devolvia o app para /login ("só fica atualizando").
 */
export async function refreshSession(): Promise<boolean> {
  if (!pb.authStore.isValid || !pb.authStore.record?.id) return false
  if (inFlight) return inFlight
  inFlight = (async () => {
    try {
      await pb.collection('users').authRefresh()
      lastRefreshAt = Date.now()
      return true
    } catch (error) {
      if (isSessionExpiredError(error)) {
        // 401 real: a sessão realmente não vale mais.
        pb.authStore.clear()
      }
      // Qualquer outro erro (rede, 5xx, timeout): mantém a sessão local.
      return false
    } finally {
      inFlight = null
    }
  })()
  return inFlight
}
