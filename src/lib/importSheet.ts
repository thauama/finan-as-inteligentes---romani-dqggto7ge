/**
 * Leitura client-side de planilhas de fatura/extrato (.xlsx e .csv) — SEM IA.
 * A extração é direta das linhas; a revisão/categorias ficam na mesma tela
 * editável usada pela importação de PDF (PdfImportModal).
 *
 * Tolerante com cabeçalhos pt/en e formatos pt-BR:
 * - data: dd/mm/aaaa, dd-mm-aaaa, aaaa-mm-dd, dd/mm/aa e serial do Excel
 * - valor: "R$ 1.234,56", "1.234,56-", "(1.234,56)", "1234.56", US$ 1,234.56
 * - tipo: coluna única ("crédito"/"débito", "receita"/"despesa", +/-) OU
 *   colunas separadas de crédito e débito (cada uma vira receita/despesa)
 */
import * as XLSX from 'xlsx'
import type { PdfImportDraftItem } from '@/services/pdfImport'

export const IMPORT_SHEET_MAX_BYTES = 5 * 1024 * 1024
export const IMPORT_SHEET_MAX_ROWS = 2000

export interface SheetImportResult {
  draft: PdfImportDraftItem[]
  rowsRead: number
  rowsIgnored: number
  sheetName?: string
}

export class SheetImportError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SheetImportError'
  }
}

const HEADER_ALIASES: Record<'date' | 'description' | 'amount' | 'credit' | 'debit', string[]> = {
  date: ['data', 'date', 'dia', ' lançamento', 'data lancamento', 'data lançamento'],
  description: [
    'descrição',
    'descricao',
    'description',
    'histórico',
    'historico',
    'history',
    'lançamento',
    'lancamento',
    'movimentação',
    'movimentacao',
    'estabelecimento',
    'memo',
    'detalhe',
    'detalhes',
  ],
  amount: ['valor', 'value', 'amount', 'montante', 'importância', 'importancia', 'total'],
  credit: ['crédito', 'credito', 'credit', 'entrada', 'depósito', 'deposito', 'in'],
  debit: ['débito', 'debito', 'debit', 'saída', 'saida', 'out'],
  type: ['tipo', 'type', 'natureza', 'operação', 'operacao', 'movimento'],
}

const EXPENSE_HINTS = [
  'débito',
  'debito',
  'debit',
  'despesa',
  'saída',
  'saida',
  'compra',
  'pagamento',
  'out',
]
const INCOME_HINTS = [
  'crédito',
  'credito',
  'credit',
  'receita',
  'entrada',
  'recebimento',
  'estorno',
  'in',
]

function normalizeHeader(value: unknown): string {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
}

function matchesHeader(normalized: string, aliases: string[]): boolean {
  return aliases.some((alias) => {
    const clean = alias.trim().toLowerCase()
    if (!clean) return false
    return normalized === clean || normalized.startsWith(clean + ' ') || normalized.includes(clean)
  })
}

/** Mapeia os índices de coluna pelos cabeçalhos da primeira linha. */
function findColumns(headerRow: unknown[]): Partial<Record<keyof typeof HEADER_ALIASES, number>> {
  const cols: Partial<Record<keyof typeof HEADER_ALIASES, number>> = {}
  for (let i = 0; i < headerRow.length; i++) {
    const normalized = normalizeHeader(headerRow[i])
    if (!normalized) continue
    ;(Object.keys(HEADER_ALIASES) as Array<keyof typeof HEADER_ALIASES>).forEach((field) => {
      if (cols[field] === undefined && matchesHeader(normalized, HEADER_ALIASES[field])) {
        cols[field] = i
      }
    })
  }
  return cols
}

const DATE_RE_ISO = /^(\d{4})-(\d{1,2})-(\d{1,2})/
const DATE_RE_BR = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})/

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

function ymd(year: number, month: number, day: number): string {
  return `${year}-${pad2(month)}-${pad2(day)}`
}

function excelSerialToYmd(serial: number): string {
  // Serial do Excel: dias desde 1899-12-30 (com o bug do ano bissexto de 1900).
  const ms = Math.round((serial - 25569) * 86400 * 1000)
  const d = new Date(ms)
  return ymd(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate())
}

function parseDateCell(value: unknown): string {
  if (value instanceof Date && !isNaN(value.getTime())) {
    return ymd(value.getFullYear(), value.getMonth() + 1, value.getDate())
  }
  if (typeof value === 'number' && isFinite(value) && value > 20000 && value < 80000) {
    return excelSerialToYmd(value)
  }
  const raw = String(value ?? '').trim()
  if (!raw) return ''
  const iso = DATE_RE_ISO.exec(raw)
  if (iso) return ymd(Number(iso[1]), Number(iso[2]), Number(iso[3]))
  const br = DATE_RE_BR.exec(raw)
  if (br) {
    let year = Number(br[3])
    if (year < 100) year += 2000
    return ymd(year, Number(br[2]), Number(br[1]))
  }
  const fallback = new Date(raw)
  if (!isNaN(fallback.getTime())) {
    return ymd(fallback.getFullYear(), fallback.getMonth() + 1, fallback.getDate())
  }
  return ''
}

/**
 * Valor pt-BR ("1.234,56") e en-US ("1,234.56"), com R$/US$, parênteses e
 * sufixo de sinal ("123,45-"). Devolve valor COM SINAL (negativo = saída).
 */
export function parseAmountCell(value: unknown): number | null {
  if (typeof value === 'number') return isFinite(value) ? value : null
  let raw = String(value ?? '').trim()
  if (!raw) return null
  const negativeByParen = /^\(.*\)$/.test(raw)
  raw = raw.replace(/[()]/g, '')
  raw = raw.replace(/[Rr]\$|US\$|\$/g, ' ')
  raw = raw.replace(/\s/g, '')
  const hasMinusBefore = raw.startsWith('-')
  const hasMinusAfter = /-$/.test(raw)
  raw = raw.replace(/-/g, '')
  if (!/\d/.test(raw)) return null
  // Heurística do separador decimal: o ÚLTIMO separador presente vence.
  const lastComma = raw.lastIndexOf(',')
  const lastDot = raw.lastIndexOf('.')
  if (lastComma > lastDot) {
    // pt-BR: ponto = milhar, vírgula = decimal.
    raw = raw.replace(/\./g, '').replace(',', '.')
  } else if (lastDot > lastComma) {
    // en-US: vírgula = milhar, ponto = decimal.
    raw = raw.replace(/,/g, '')
  } else if (lastComma >= 0 && lastDot < 0) {
    raw = raw.replace(',', '.')
  }
  const n = Number(raw)
  if (!isFinite(n)) return null
  const sign = negativeByParen || hasMinusBefore || hasMinusAfter ? -1 : 1
  return sign * n
}

function normalizeTypeCell(value: unknown): 'receita' | 'despesa' | '' {
  const v = normalizeHeader(value)
  if (!v) return ''
  if (INCOME_HINTS.some((hint) => v.includes(hint))) return 'receita'
  if (EXPENSE_HINTS.some((hint) => v.includes(hint))) return 'despesa'
  return ''
}

function pickString(...cells: unknown[]): string {
  for (const cell of cells) {
    const value = String(cell ?? '').trim()
    if (value) return value
  }
  return ''
}

/** Sugestão de categoria por palavras-chave da descrição (sem IA). */
export function suggestCategory(
  description: string,
  type: 'receita' | 'despesa',
  categories: Array<{ id: string; name: string; type: string; parent?: string }>,
): string {
  const desc = normalizeHeader(description)
  if (!desc) return ''
  const candidates = categories.filter((category) => category.type === type)
  let best: { id: string; score: number } | null = null
  for (const category of candidates) {
    const name = normalizeHeader(category.name)
    if (!name) continue
    let score = 0
    if (desc.includes(name)) score = 100 + name.length
    else {
      const words = name.split(' ').filter((word) => word.length >= 4)
      for (const word of words) {
        if (desc.includes(word)) score = Math.max(score, word.length * 2)
      }
    }
    if (score > 0 && (!best || score > best.score)) best = { id: category.id, score }
  }
  return best ? best.id : ''
}

function buildDraftItem(input: {
  date: string
  description: string
  signed: number
  explicitType: 'receita' | 'despesa' | ''
  categories: Array<{ id: string; name: string; type: string; parent?: string }>
}): PdfImportDraftItem | null {
  const { date, description, signed, explicitType, categories } = input
  if (!date || !description || !signed) return null
  const type: 'receita' | 'despesa' = explicitType || (signed < 0 ? 'despesa' : 'receita')
  const amount = Math.abs(Math.round(signed * 100) / 100)
  if (amount <= 0) return null
  return {
    date,
    description: description.slice(0, 200),
    amount,
    type,
    category_id: suggestCategory(description, type, categories),
  }
}

interface SheetRow {
  cells: unknown[]
  index: number
}

function processRow(
  cells: unknown[],
  cols: Partial<Record<keyof typeof HEADER_ALIASES, number>>,
  categories: Array<{ id: string; name: string; type: string; parent?: string }>,
  hasHeader: boolean,
): PdfImportDraftItem | null {
  const dateCell = cols.date !== undefined ? cells[cols.date] : undefined
  const descriptionCell = cols.description !== undefined ? cells[cols.description] : undefined
  const amountCell = cols.amount !== undefined ? cells[cols.amount] : undefined
  const creditCell = cols.credit !== undefined ? cells[cols.credit] : undefined
  const debitCell = cols.debit !== undefined ? cells[cols.debit] : undefined

  const date = parseDateCell(dateCell)
  let description = pickString(descriptionCell)
  if (!description && dateCell && typeof dateCell === 'string') {
    // Alguns extratos colocam tudo numa única coluna de texto.
    description = dateCell.trim()
  }

  // Caso 1: colunas separadas de crédito/débito.
  if (creditCell !== undefined || debitCell !== undefined) {
    const credit = parseAmountCell(creditCell)
    const debit = parseAmountCell(debitCell)
    if (credit && credit !== 0 && !debit) {
      return buildDraftItem({
        date,
        description,
        signed: Math.abs(credit),
        explicitType: 'receita',
        categories,
      })
    }
    if (debit && debit !== 0 && !credit) {
      return buildDraftItem({
        date,
        description,
        signed: -Math.abs(debit),
        explicitType: 'despesa',
        categories,
      })
    }
  }

  // Caso 2: coluna de valor única + (opcional) coluna de tipo.
  let explicitType = normalizeTypeCell(cells[cols.amount !== undefined ? -1 : -1])
  const typeColumn = cols.credit !== undefined && cols.debit === undefined ? undefined : undefined
  void typeColumn
  const amount = parseAmountCell(amountCell)
  if (amount === null) {
    // Caso 3: sem coluna de valor parseável — tenta a coluna de tipo como valor.
    return null
  }
  // Se a descrição OU o valor carregam a palavra (ex.: "Pagamento -5.480,76"),
  // tenta inferir da descrição; senão, sinal do valor.
  const fromDescription = normalizeTypeCell(description)
  explicitType = fromDescription || explicitType
  return buildDraftItem({ date, description, signed: amount, explicitType, categories })
}

export async function importSheetFile(
  file: File,
  categories: Array<{ id: string; name: string; type: string; parent?: string }>,
): Promise<SheetImportResult> {
  if (file.size > IMPORT_SHEET_MAX_BYTES) {
    throw new SheetImportError(
      `O arquivo deve ter no máximo ${Math.round(IMPORT_SHEET_MAX_BYTES / (1024 * 1024))} MB (o enviado tem ${(file.size / (1024 * 1024)).toFixed(1)} MB).`,
    )
  }
  const name = file.name.toLowerCase()
  const isXlsx = name.endsWith('.xlsx') || name.endsWith('.xls')
  const isCsv = name.endsWith('.csv') || name.endsWith('.txt')

  let grid: unknown[][] = []
  let sheetName: string | undefined
  try {
    if (isXlsx) {
      const buffer = await file.arrayBuffer()
      const workbook = XLSX.read(buffer, { type: 'array', cellDates: true })
      const first = workbook.SheetNames[0]
      if (!first) throw new SheetImportError('A planilha está vazia.')
      sheetName = first
      grid = XLSX.utils.sheet_to_json<unknown[]>(workbook.Sheets[first], {
        header: 1,
        raw: true,
        defval: '',
        blankrows: false,
      })
    } else if (isCsv) {
      const text = await file.text()
      grid = parseCsv(text)
    } else {
      throw new SheetImportError(
        'Formato não suportado. Envie um arquivo .xlsx, .csv ou PDF da fatura/extrato.',
      )
    }
  } catch (err) {
    if (err instanceof SheetImportError) throw err
    throw new SheetImportError(
      'Não foi possível ler a planilha. Verifique se o arquivo abre no Excel/Google Sheets e tente novamente.',
    )
  }

  if (grid.length === 0) {
    throw new SheetImportError('A planilha está vazia ou não tem linhas legíveis.')
  }
  if (grid.length > IMPORT_SHEET_MAX_ROWS + 20) {
    throw new SheetImportError(
      `A planilha tem ${grid.length} linhas; o limite é de ${IMPORT_SHEET_MAX_ROWS}. Divida o arquivo em partes menores.`,
    )
  }

  // Cabeçalho: a primeira linha é cabeçalho se tiver alguma coluna reconhecida.
  let cols = findColumns(grid[0] || [])
  let hasHeader = Object.keys(cols).length > 0
  let dataRows: SheetRow[] = grid.map((cells, index) => ({ cells, index })).slice(1)
  if (!hasHeader) {
    // Sem cabeçalho: heurística de posição (data, descrição, valor...).
    cols = inferColumnsByPosition(grid)
    dataRows = grid.map((cells, index) => ({ cells, index }))
    if (!cols.date || (!cols.amount && cols.credit === undefined && cols.debit === undefined)) {
      throw new SheetImportError(
        'Não encontramos as colunas de data e valor. Renomeie os cabeçalhos para "Data", "Descrição" e "Valor" (ou "Credit"/"Debit") e tente novamente.',
      )
    }
  }

  const draft: PdfImportDraftItem[] = []
  let rowsRead = 0
  let rowsIgnored = 0
  const seen = new Set<string>()
  for (const row of dataRows) {
    const cells = row.cells || []
    if (cells.every((cell) => String(cell ?? '').trim() === '')) continue
    rowsRead++
    // Com cabeçalho reconhecido, pula a própria linha de cabeçalho.
    if (hasHeader && row.index === 0) continue
    const item = processRow(cells, cols, categories, hasHeader)
    if (!item) {
      rowsIgnored++
      continue
    }
    const key = `${item.date}|${item.description.toLowerCase()}|${Math.round(item.amount * 100)}|${item.type}`
    if (seen.has(key)) {
      rowsIgnored++
      continue
    }
    seen.add(key)
    draft.push(item)
  }

  return { draft, rowsRead, rowsIgnored, sheetName }
}

/** Heurística sem cabeçalho: primeira coluna com datas = data, etc. */
function inferColumnsByPosition(
  grid: unknown[][],
): Partial<Record<keyof typeof HEADER_ALIASES, number>> {
  const cols: Partial<Record<keyof typeof HEADER_ALIASES, number>> = {}
  const sample = grid.slice(0, 50)
  let dateCol = -1
  let amountCol = -1
  let descriptionCol = -1
  const columnCount = Math.max(...sample.map((row) => (row || []).length), 0)
  for (let col = 0; col < columnCount; col++) {
    let dates = 0
    let numbers = 0
    let texts = 0
    for (const row of sample) {
      const cell = (row || [])[col]
      if (cell === undefined || String(cell).trim() === '') continue
      if (parseDateCell(cell)) dates++
      else if (
        typeof cell === 'number' ||
        (parseAmountCell(cell) !== null &&
          !/[a-zA-ZçÇ]/.test(String(cell).replace(/[Rr]\$|US\$|\$/g, '')))
      )
        numbers++
      else texts++
    }
    if (dateCol < 0 && dates >= Math.max(2, sample.length * 0.5)) dateCol = col
    else if (amountCol < 0 && numbers >= Math.max(2, sample.length * 0.3)) amountCol = col
    else if (descriptionCol < 0 && texts >= 1) descriptionCol = col
  }
  if (dateCol >= 0) cols.date = dateCol
  if (amountCol >= 0) cols.amount = amountCol
  if (descriptionCol >= 0) cols.description = descriptionCol
  return cols
}

/** Parser CSV próprio e leve: suporta vírgula, ponto-e-vírgula, tab e aspas. */
export function parseCsv(text: string): unknown[][] {
  const clean = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n')
  const delimiter = detectDelimiter(clean)
  const rows: unknown[][] = []
  let row: unknown[] = []
  let field = ''
  let inQuotes = false
  for (let i = 0; i < clean.length; i++) {
    const char = clean[i]
    if (inQuotes) {
      if (char === '"') {
        if (clean[i + 1] === '"') {
          field += '"'
          i++
        } else {
          inQuotes = false
        }
      } else {
        field += char
      }
      continue
    }
    if (char === '"') {
      inQuotes = true
      continue
    }
    if (char === delimiter) {
      row.push(field)
      field = ''
      continue
    }
    if (char === '\n') {
      row.push(field)
      field = ''
      rows.push(row)
      row = []
      continue
    }
    field += char
  }
  if (field !== '' || row.length > 0) {
    row.push(field)
    rows.push(row)
  }
  return rows
}

function detectDelimiter(text: string): string {
  const firstLine = text.split('\n', 1)[0] || ''
  const counts: Array<[string, number]> = [
    [';', (firstLine.match(/;/g) || []).length],
    [',', (firstLine.match(/,/g) || []).length],
    ['\t', (firstLine.match(/\t/g) || []).length],
  ]
  counts.sort((a, b) => b[1] - a[1])
  return counts[0][1] > 0 ? counts[0][0] : ','
}
