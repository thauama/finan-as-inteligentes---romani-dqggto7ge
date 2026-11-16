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

/**
 * Renova o token de autenticação do PocketBase, se houver usuário válido.
 * Resolve com `true` quando a sessão segue válida; `false` quando o refresh
 * falhou (sessão realmente expirada — limpa o authStore e o app redireciona
 * para /login via ProtectedLayout).
 */
export async function refreshSession(): Promise<boolean> {
  if (!pb.authStore.isValid || !pb.authStore.record?.id) return false
  try {
    await pb.collection('users').authRefresh()
    return true
  } catch {
    // Refresh falhou: a sessão realmente não vale mais.
    pb.authStore.clear()
    return false
  }
}
