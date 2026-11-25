import { CalendarDays, ChevronLeft, ChevronRight } from 'lucide-react'

import { currentMonth, monthTitle, shiftMonth } from '@/lib/format'

const MONTH_OPTIONS = [
  'Janeiro',
  'Fevereiro',
  'Março',
  'Abril',
  'Maio',
  'Junho',
  'Julho',
  'Agosto',
  'Setembro',
  'Outubro',
  'Novembro',
  'Dezembro',
]

/** Lista de anos do seletor: janela ao redor do ano atual, expandida para conter o selecionado. */
export function yearOptions(selectedMonth: string): number[] {
  const nowYear = Number(currentMonth().slice(0, 4))
  const selectedYear = Number(selectedMonth.slice(0, 4))
  const from = Math.min(nowYear, selectedYear) - 5
  const to = Math.max(nowYear, selectedYear) + 5
  const years: number[] = []
  for (let year = from; year <= to; year += 1) years.push(year)
  return years
}

/**
 * Navegação de mês/ano reutilizável (mesmo padrão visual da navegação de Metas):
 * ◀ ▶ + dropdowns de mês e ano + botão "Hoje". Permite escolher qualquer mês
 * de qualquer ano, passado ou futuro.
 */
export function MonthYearNav({
  month,
  onChange,
}: {
  month: string
  onChange: (month: string) => void
}) {
  const year = Number(month.slice(0, 4))
  const monthNumber = Number(month.slice(5, 7))
  const isCurrent = month === currentMonth()

  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="flex items-center gap-1 rounded-xl border border-fin-border bg-white p-1 shadow-2xs">
        <button
          type="button"
          aria-label="Mês anterior"
          className="rounded-lg p-1.5 text-fin-muted hover:bg-fin-surface hover:text-fin-text"
          onClick={() => onChange(shiftMonth(month, -1))}
        >
          <ChevronLeft className="h-4 w-4" />
        </button>
        <span className="inline-flex items-center gap-1.5 px-1 text-xs font-semibold text-fin-text">
          <CalendarDays className="h-3.5 w-3.5 text-fin-primary" />
          {monthTitle(month)}
        </span>
        <button
          type="button"
          aria-label="Próximo mês"
          className="rounded-lg p-1.5 text-fin-muted hover:bg-fin-surface hover:text-fin-text"
          onClick={() => onChange(shiftMonth(month, 1))}
        >
          <ChevronRight className="h-4 w-4" />
        </button>
        <button
          type="button"
          className="ml-1 rounded-lg px-2 py-1 text-[11px] font-semibold text-fin-primary hover:bg-indigo-50 disabled:cursor-default disabled:opacity-40"
          disabled={isCurrent}
          onClick={() => onChange(currentMonth())}
        >
          Hoje
        </button>
      </div>

      <div className="flex items-center gap-2">
        <label className="sr-only" htmlFor="month-nav-month">
          Mês
        </label>
        <select
          id="month-nav-month"
          className="field min-h-9 w-auto py-1.5 text-xs"
          value={monthNumber}
          onChange={(event) => {
            const next = Number(event.target.value)
            onChange(shiftMonth(`${year}-01`, next - 1))
          }}
        >
          {MONTH_OPTIONS.map((label, index) => (
            <option key={label} value={index + 1}>
              {label}
            </option>
          ))}
        </select>
        <label className="sr-only" htmlFor="month-nav-year">
          Ano
        </label>
        <select
          id="month-nav-year"
          className="field min-h-9 w-auto py-1.5 text-xs"
          value={year}
          onChange={(event) => {
            const nextYear = Number(event.target.value)
            onChange(`${nextYear}-${String(monthNumber).padStart(2, '0')}`)
          }}
        >
          {yearOptions(month).map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      </div>
    </div>
  )
}
