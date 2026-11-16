/**
 * Detecção de parcelamento em descrições de fatura — regex no cliente, SEM IA.
 * Funciona para Excel/CSV (texto puro) e para PDF (pós-IA). Exemplos suportados:
 * "LOJA XYZ - 3/6", "Compra 2/6 LOJA", "PARCELA 2/10", "LOJA 3X6", "LOJA 12X".
 *
 * Convenção: o VALOR da linha já é o valor da parcela mensal (nunca multiplicar).
 */

export interface InstallmentMatch {
  /** Número da parcela desta linha (1-based). */
  current: number
  /** Total de parcelas da compra. */
  total: number
}

const MAX_INSTALLMENTS = 48

/** Detecta "n/m", "parcela n/m", "n de m", "nXm" e "nX" (total-only) na descrição. */
export function detectInstallment(description: string): InstallmentMatch | null {
  const text = String(description || '').toUpperCase()
  if (!text) return null

  let current = 0
  let total = 0

  const labeled = /PARCELA\s*:?\s*(\d{1,2})\s*(?:\/|DE)\s*(\d{1,2})/.exec(text)
  const slash = /\b(\d{1,2})\s*\/\s*(\d{1,2})\b/.exec(text)
  const timesOf = /\b(\d{1,2})\s*X\s*(\d{1,2})\b/.exec(text)
  const timesOnly = /(?:PARCELA\s*)?\b(\d{1,2})\s*X\b(?!\/|\s*X)/.exec(text)

  if (labeled) {
    current = Number(labeled[1])
    total = Number(labeled[2])
  } else if (slash) {
    current = Number(slash[1])
    total = Number(slash[2])
  } else if (timesOf) {
    current = Number(timesOf[1])
    total = Number(timesOf[2])
  } else if (timesOnly) {
    // "12X" sem total: a linha é a 1ª de N parcelas (o usuário pode desmarcar na revisão).
    current = 1
    total = Number(timesOnly[1])
  } else {
    return null
  }

  if (!Number.isFinite(current) || !Number.isFinite(total)) return null
  if (total < 2 || total > MAX_INSTALLMENTS) return null
  if (current < 1 || current > total) return null
  return { current, total }
}

/** Total de parcelas que ainda faltam depois da linha importada. */
export function futureInstallmentsCount(match: InstallmentMatch): number {
  return Math.max(0, match.total - match.current)
}

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate()
}

/**
 * Soma `count` meses a uma data "aaaa-mm-dd" mantendo o dia (clamp no último
 * dia do mês de destino) — respeita a virada de ano.
 */
export function addMonthsToYmd(ymd: string, count: number): string {
  const [year, month, day] = ymd.slice(0, 10).split('-').map(Number)
  if (!year || !month || !day) return ymd
  const absolute = year * 12 + (month - 1) + count
  const nextYear = Math.floor(absolute / 12)
  const nextMonth = (absolute % 12) + 1
  const nextDay = Math.min(day, daysInMonth(nextYear, nextMonth))
  return `${nextYear}-${pad2(nextMonth)}-${pad2(nextDay)}`
}

/** Mês "aaaa-mm" de uma data "aaaa-mm-dd". */
export function ymdToMonth(ymd: string): string {
  return ymd.slice(0, 7)
}

/** Sufixo invisível de agrupamento gravado na descrição: "#P{token}". */
export function installmentGroupSuffix(token: string): string {
  return `#P${token}`
}

/** Extrai o token de agrupamento de uma descrição, se houver. */
export function parseInstallmentGroup(description: string): string | null {
  const match = /#P([A-Za-z0-9]+)/.exec(String(description || ''))
  return match ? match[1] : null
}

/** Descrição sem o sufixo "#P..." (para exibição). */
export function stripInstallmentSuffix(description: string): string {
  return String(description || '')
    .replace(/\s*#P[A-Za-z0-9]+\s*$/, '')
    .trim()
}

/** Nota gravada nos lançamentos criados pelo parcelamento. */
export function installmentNote(current: number, total: number): string {
  return `Importado por PDF — parcela ${current}/${total}`
}
