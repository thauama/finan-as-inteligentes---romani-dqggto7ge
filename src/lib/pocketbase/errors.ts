import { ClientResponseError } from 'pocketbase'

export type FieldErrors = Record<string, string>

export function extractFieldErrors(error: unknown): FieldErrors {
  if (!(error instanceof ClientResponseError)) return {}
  const data = error.response?.data
  if (!data || typeof data !== 'object') return {}
  const errors: FieldErrors = {}
  for (const [field, detail] of Object.entries(data)) {
    if (
      detail &&
      typeof detail === 'object' &&
      'message' in detail &&
      typeof (detail as { message: unknown }).message === 'string'
    ) {
      errors[field] = (detail as { message: string }).message
    }
  }
  return errors
}

// Fallback genérico do SDK do PocketBase (ClientResponseError) quando a resposta
// não traz "message" — nunca exibir esse texto cru ao usuário.
const GENERIC_SDK_FALLBACKS = ['Something went wrong.']

// Mensagens nativas (em inglês) devolvidas pelo PocketBase traduzidas para o
// usuário, sempre com uma ação concreta. O texto original nunca é exibido cru.
const PB_MESSAGE_TRANSLATIONS: Array<{ match: RegExp; message: string }> = [
  {
    match: /Failed to authenticate/i,
    message: 'E-mail ou senha incorretos.',
  },
  {
    // Falta de SMTP configurado no servidor — erro comum no reset de senha
    match: /Failed to send (password reset|verification|email)/i,
    message:
      'O servidor não conseguiu enviar o e-mail agora. Isso geralmente indica que o envio de e-mails (SMTP) não está configurado — procure o suporte ou tente novamente em instantes.',
  },
  {
    match: /User not found|user was not found/i,
    message: 'Não encontramos uma conta com esse e-mail. Confira o endereço ou crie uma conta.',
  },
  {
    match: /Invalid or expired (token|password reset token)/i,
    message: 'Este link de recuperação expirou ou já foi usado. Solicite um novo link.',
  },
  {
    match: /too many requests/i,
    message: 'Muitas tentativas em sequência. Aguarde alguns minutos e tente novamente.',
  },
]

export function getErrorMessage(error: unknown): string {
  if (!(error instanceof ClientResponseError)) {
    return error instanceof Error ? error.message : 'Ocorreu um erro inesperado. Tente novamente.'
  }
  const msgs = Object.values(extractFieldErrors(error))
  if (msgs.length > 0) return msgs.join(' ')
  if (error.isAbort) {
    return 'A requisição foi cancelada antes de concluir. Tente novamente.'
  }
  if (error.status === 0) {
    // A requisição nem chegou ao servidor: queda de conexão, bloqueio de rede etc.
    return 'Não foi possível conectar ao servidor. Verifique sua conexão com a internet e tente novamente.'
  }
  const raw = (error.response?.message as string | undefined) || error.message || ''
  if (!raw || GENERIC_SDK_FALLBACKS.includes(raw)) {
    return `O servidor não conseguiu concluir a operação agora${
      error.status ? ` (erro ${error.status})` : ''
    }. Tente novamente em instantes.`
  }
  for (const { match, message } of PB_MESSAGE_TRANSLATIONS) {
    if (match.test(raw)) return message
  }
  return raw
}
