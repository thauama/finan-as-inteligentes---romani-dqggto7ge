import { useEffect, useMemo, useState } from 'react'
import { CalendarRange, Loader2, Search } from 'lucide-react'

import { useFinance } from '@/contexts/FinanceContext'
import { brl, currentMonth, escapeFilter, formatDate, monthBounds, monthTitle } from '@/lib/format'
import { getCategoryPath } from '@/lib/categories'
import { listTransactions } from '@/services/transactions'
import { isTransfer } from '@/lib/transactionTypes'
import type { Transaction } from '@/types/finance'
import { CategoryTreeSelect } from '@/components/finance/CategoryTreeSelect'
import { cn } from '@/lib/utils'

const MAX_MONTHS = 24

type PeriodPreset = '3m' | '6m' | '12m' | '24m' | 'custom'

const PRESETS: Array<{ value: PeriodPreset; label: string }> = [
  { value: '3m', label: 'Últimos 3 meses' },
  { value: '6m', label: 'Últimos 6 meses' },
  { value: '12m', label: 'Últimos 12 meses' },
  { value: '24m', label: 'Últimos 24 meses' },
  { value: 'custom', label: 'Período personalizado' },
]

function addMonths(month: string, delta: number): string {
  const [year, monthNumber] = month.split('-').map(Number)
  const date = new Date(Date.UTC(year, monthNumber - 1 + delta, 1))
  return date.toISOString().slice(0, 7)
}

function rangeForPreset(preset: PeriodPreset, from: string, to: string) {
  const end = currentMonth()
  if (preset === 'custom') return { from, to }
  return { from: addMonths(end, -(Number(preset.replace('m', '')) - 1)), to: end }
}

/**
 * Seção "Lançamentos por categoria": o usuário escolhe uma categoria (receita ou
 * despesa) e um período de até 24 meses, e vê todos os lançamentos daquela
 * categoria com o total. Transferências ficam fora da lista e dos totais
 * (não são receita nem despesa).
 */
export function CategoryReport() {
  const { accounts, categories } = useFinance()
  const [categoryId, setCategoryId] = useState('')
  const [preset, setPreset] = useState<PeriodPreset>('24m')
  const [fromMonth, setFromMonth] = useState(addMonths(currentMonth(), -(MAX_MONTHS - 1)))
  const [toMonth, setToMonth] = useState(currentMonth())
  const [transactions, setTransactions] = useState<Transaction[]>([])
  const [loading, setLoading] = useState(false)
  const [loadedKey, setLoadedKey] = useState('')

  const accountsById = useMemo(
    () => new Map(accounts.map((account) => [account.id, account])),
    [accounts],
  )

  const selectedCategory = categories.find((category) => category.id === categoryId)
  const categoryType = selectedCategory?.type === 'receita' ? 'receita' : 'despesa'

  const range = rangeForPreset(preset, fromMonth, toMonth)

  // Chave que identifica o conjunto carregado: categoria + intervalo de meses
  const rangeKey = `${range.from}..${range.to}`

  // Busca os lançamentos do período completo (até 24 meses) uma vez por intervalo;
  // a troca de categoria reutiliza o mesmo fetch, sem nova requisição.
  useEffect(() => {
    if (loadedKey === rangeKey) return
    const startBounds = monthBounds(range.from)
    const endBounds = monthBounds(range.to)
    let cancelled = false
    setLoading(true)
    listTransactions(
      `date >= '${escapeFilter(startBounds.start)}' && date < '${escapeFilter(endBounds.next)}'`,
    )
      .then((records) => {
        if (cancelled) return
        setTransactions(records)
        setLoadedKey(rangeKey)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [rangeKey, range.from, range.to, loadedKey])

  const filtered = useMemo(() => {
    if (!categoryId) return []
    const startBounds = monthBounds(range.from)
    const endBounds = monthBounds(range.to)
    return transactions
      .filter(
        (transaction) =>
          !isTransfer(transaction) &&
          transaction.category === categoryId &&
          transaction.date >= startBounds.start &&
          transaction.date < endBounds.next,
      )
      .sort((a, b) => (a.date < b.date ? 1 : -1))
  }, [transactions, categoryId, range.from, range.to])

  const total = useMemo(
    () => filtered.reduce((sum, transaction) => sum + transaction.amount, 0),
    [filtered],
  )

  const periodLabel =
    preset === 'custom'
      ? `${monthTitle(range.from)} — ${monthTitle(range.to)}`
      : `Últimos ${preset.replace('m', '')} meses (até ${monthTitle(range.to).toLowerCase()})`

  return (
    <article className="fin-card print-card animate-fade-up stagger-4 p-5 sm:p-6">
      <div className="mb-5 flex items-center gap-3">
        <span className="grid h-10 w-10 place-items-center rounded-xl bg-indigo-50 text-fin-primary">
          <CalendarRange className="h-5 w-5" />
        </span>
        <div>
          <h2 className="section-title">Lançamentos por categoria</h2>
          <p className="text-xs text-fin-muted">
            Escolha uma categoria de receita ou despesa e veja todos os lançamentos até 24 meses
          </p>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-[1.4fr_1fr_1fr]">
        <div>
          <label className="mb-1 block text-xs font-semibold text-fin-muted">Categoria</label>
          <CategoryTreeSelect
            categories={categories}
            value={categoryId}
            onChange={setCategoryId}
            placeholder="Selecione uma categoria..."
            allowClear
          />
        </div>
        <div>
          <label className="mb-1 block text-xs font-semibold text-fin-muted">Período</label>
          <select
            className="field"
            value={preset}
            onChange={(event) => {
              const next = event.target.value as PeriodPreset
              setPreset(next)
              if (next !== 'custom') {
                setFromMonth(addMonths(currentMonth(), -(MAX_MONTHS - 1)))
                setToMonth(currentMonth())
              }
            }}
          >
            {PRESETS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
        {preset === 'custom' && (
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="mb-1 block text-xs font-semibold text-fin-muted">De</label>
              <input
                type="month"
                className="field"
                value={fromMonth}
                min={addMonths(currentMonth(), -(MAX_MONTHS - 1))}
                max={toMonth}
                onChange={(event) => setFromMonth(event.target.value || fromMonth)}
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-semibold text-fin-muted">Até</label>
              <input
                type="month"
                className="field"
                value={toMonth}
                min={fromMonth}
                max={currentMonth()}
                onChange={(event) => setToMonth(event.target.value || toMonth)}
              />
            </div>
          </div>
        )}
      </div>

      {categoryId && (
        <div className="mt-4 rounded-xl border border-fin-border bg-fin-surface/60 p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <p className="text-sm font-semibold">
                <span
                  className={cn(
                    'mr-2 inline-block h-2 w-2 rounded-full align-middle',
                    categoryType === 'receita' ? 'bg-fin-success' : 'bg-fin-danger',
                  )}
                />
                {getCategoryPath(categoryId, categories)}
              </p>
              <p className="mt-0.5 text-xs text-fin-muted">{periodLabel}</p>
            </div>
            <div className="text-right">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-fin-muted">
                Total no período
              </p>
              <p
                className={cn(
                  'text-xl font-extrabold',
                  categoryType === 'receita' ? 'text-fin-success' : 'text-fin-danger',
                )}
              >
                {categoryType === 'receita' ? '+' : '−'} {brl.format(total)}
              </p>
            </div>
          </div>
        </div>
      )}

      {loading ? (
        <div className="flex items-center justify-center gap-2 py-10 text-sm text-fin-muted">
          <Loader2 className="h-4 w-4 animate-spin" />
          Carregando lançamentos...
        </div>
      ) : !categoryId ? (
        <div className="flex flex-col items-center justify-center gap-2 py-10 text-center text-sm text-fin-muted">
          <Search className="h-5 w-5" />
          Selecione uma categoria para ver os lançamentos.
        </div>
      ) : filtered.length === 0 ? (
        <div className="py-10 text-center text-sm text-fin-muted">
          Nenhum lançamento desta categoria no período selecionado.
        </div>
      ) : (
        <div className="mt-4 overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-fin-border text-left text-xs uppercase tracking-wide text-fin-muted">
                <th className="py-2 pr-3 font-semibold">Data</th>
                <th className="py-2 pr-3 font-semibold">Descrição</th>
                <th className="py-2 pr-3 font-semibold">Conta</th>
                <th className="py-2 text-right font-semibold">Valor</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((transaction) => {
                const accountName =
                  accountsById.get(transaction.account)?.name ||
                  transaction.expand?.account?.name ||
                  '—'
                return (
                  <tr key={transaction.id} className="border-b border-fin-border/50 last:border-0">
                    <td className="whitespace-nowrap py-2 pr-3 text-fin-muted">
                      {formatDate(transaction.date)}
                    </td>
                    <td className="py-2 pr-3">
                      <span className="line-clamp-1 font-medium">{transaction.description}</span>
                    </td>
                    <td className="py-2 pr-3 text-fin-muted">{accountName}</td>
                    <td
                      className={cn(
                        'whitespace-nowrap py-2 text-right font-semibold',
                        categoryType === 'receita' ? 'text-fin-success' : 'text-fin-danger',
                      )}
                    >
                      {categoryType === 'receita' ? '+' : '−'} {brl.format(transaction.amount)}
                    </td>
                  </tr>
                )
              })}
            </tbody>
            <tfoot>
              <tr className="border-t-2 border-fin-border">
                <td colSpan={3} className="py-2.5 text-right font-semibold">
                  Total ({filtered.length} lançamento{filtered.length === 1 ? '' : 's'})
                </td>
                <td
                  className={cn(
                    'whitespace-nowrap py-2.5 text-right font-extrabold',
                    categoryType === 'receita' ? 'text-fin-success' : 'text-fin-danger',
                  )}
                >
                  {categoryType === 'receita' ? '+' : '−'} {brl.format(total)}
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </article>
  )
}
