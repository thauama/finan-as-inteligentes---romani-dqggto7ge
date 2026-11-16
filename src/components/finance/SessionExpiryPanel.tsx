import { LogIn, X } from 'lucide-react'

/**
 * Painel padrão "Sessão expirada" — exibido dentro dos modais quando uma ação
 * autenticada falha com 401. Oferece ir para o login (fechando o modal) ou
 * apenas fechar. Mesmo padrão do painel do modal de importação de PDF.
 */
export function SessionExpiryPanel({
  onLogin,
  onClose,
}: {
  onLogin: () => void
  onClose: () => void
}) {
  return (
    <div className="flex flex-col items-center gap-4 rounded-xl border border-fin-border bg-fin-surface px-6 py-10 text-center">
      <LogIn className="h-8 w-8 text-fin-primary" />
      <div className="space-y-1">
        <p className="text-sm font-semibold text-fin-text">Sessão expirada</p>
        <p className="max-w-sm text-xs leading-relaxed text-fin-muted">
          Faça login novamente para continuar. O que você estava fazendo não foi concluído — nada
          foi alterado nas suas finanças.
        </p>
      </div>
      <div className="flex gap-3">
        <button type="button" className="btn-secondary" onClick={onClose}>
          <X className="h-4 w-4" />
          Fechar
        </button>
        <button type="button" className="btn-primary" onClick={onLogin}>
          <LogIn className="h-4 w-4" />
          Ir para o login
        </button>
      </div>
    </div>
  )
}
