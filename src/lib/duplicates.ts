/**
 * Detecção de duplicidade na importação de faturas/extratos (heurística, SEM IA).
 * Uma linha é "possível duplicado" quando casa com um lançamento JÁ EXISTENTE do
 * usuário por 3 critérios somados: data dentro de ±3 dias, valor igual e
 * descrição similar (normalizada, sem acentos/caixa — similaridade ≥70% ou
 * startsWith). É heurística: dois gastos legítimos iguais no mesmo dia casam —
 * por isso a linha só vem DESMARCADA na revisão, e o usuário decide.
 */
import type { PdfImportDraftItem } from '@/services/pdfImport'

/** Janela de dias (±) para considerar que a data casa. */
export const DUPLICATE_DATE_TOLERANCE_DAYS = 3
/** Similaridade mínima de descrição (0 a 1). */
export const DUPLICATE_SIMILARITY = 0.7

export interface ExistingTxForDupCheck {
  date: string
  amount: number
  description: string
}

export interface DraftItemWithDuplicate extends PdfImportDraftItem {
  duplicate?: boolean
}

/** Remove acentos, baixa a caixa e colapsa espaços. */
export function normalizeText(value: string): string {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Similaridade 0..1 por bigramas (Dice), robusta a trocas de ordem pequenas. */
export function descriptionSimilarity(a: string, b: string): number {
  const s1 = normalizeText(a)
  const s2 = normalizeText(b)
  if (!s1 || !s2) return 0
  if (s1 === s2) return 1
  if (s2.startsWith(s1) || s1.startsWith(s2)) return 1
  if (s1.length < 2 || s2.length < 2) return s1 === s2 ? 1 : 0
  const bigrams = new Map<string, number>()
  for (let i = 0; i < s1.length - 1; i++) {
    const gram = s1.slice(i, i + 2)
    bigrams.set(gram, (bigrams.get(gram) || 0) + 1)
  }
  let hits = 0
  for (let i = 0; i < s2.length - 1; i++) {
    const gram = s2.slice(i, i + 2)
    const count = bigrams.get(gram) || 0
    if (count > 0) {
      hits++
      bigrams.set(gram, count - 1)
    }
  }
  return (2 * hits) / (s1.length - 1 + (s2.length - 1))
}

function toUtcDay(ymd: string): number {
  const parts = String(ymd || '')
    .slice(0, 10)
    .split('-')
    .map(Number)
  if (!parts[0] || !parts[1] || !parts[2]) return NaN
  return Date.UTC(parts[0], parts[1] - 1, parts[2])
}

/** Data está dentro de ±3 dias da outra? */
export function isDateWithinTolerance(a: string, b: string): boolean {
  const da = toUtcDay(a)
  const db = toUtcDay(b)
  if (isNaN(da) || isNaN(db)) return false
  return Math.abs(da - db) <= DUPLICATE_DATE_TOLERANCE_DAYS * 86400000
}

/**
 * Marca cada linha do rascunho com `duplicate: true` quando casa com um
 * lançamento já existente (data ±3 dias E valor igual E descrição similar).
 */
export function markDuplicates<T extends PdfImportDraftItem>(
  draft: T[],
  existing: ExistingTxForDupCheck[],
): Array<T & { duplicate?: boolean }> {
  const existingByAmount = new Map<number, ExistingTxForDupCheck[]>()
  for (const tx of existing) {
    const cents = Math.round(Number(tx.amount) * 100)
    if (!existingByAmount.has(cents)) existingByAmount.set(cents, [])
    existingByAmount.get(cents)!.push(tx)
  }
  return draft.map((item) => {
    const cents = Math.round(item.amount * 100)
    const candidates = existingByAmount.get(cents) || []
    for (const tx of candidates) {
      if (!isDateWithinTolerance(item.date, tx.date)) continue
      if (descriptionSimilarity(item.description, tx.description) >= DUPLICATE_SIMILARITY) {
        return { ...item, duplicate: true }
      }
    }
    return { ...item, duplicate: false }
  })
}
