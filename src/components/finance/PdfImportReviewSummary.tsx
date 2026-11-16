import { AlertTriangle, Layers, Split } from 'lucide-react'

interface Props {
  count: number
  total: number
  futureInstallments: number
  duplicates: number
  totalFormatted: string
  isNegative: boolean
}

/**
 * Resumo da revisão da importação: contagem de lançamentos ativos, total,
 * parcelas futuras que serão criadas e possíveis duplicados desmarcados.
 */
export function PdfImportReviewSummary({
  count,
  total,
  futureInstallments,
  duplicates,
  totalFormatted,
  isNegative,
}: Props) {
  return (
    <div className="rounded-xl bg-fin-surface px-4 py-2.5 text-right">
      <p className="text-[11px] font-semibold uppercase tracking-wide text-fin-muted">
        {count} lançamento(s)
      </p>
      <p className={`text-sm font-extrabold ${isNegative ? 'text-rose-800' : 'text-emerald-800'}`}>
        {totalFormatted}
      </p>
      <div className="mt-1 space-y-0.5">
        {futureInstallments > 0 && (
          <p className="flex items-center justify-end gap-1 text-[11px] text-fin-muted">
            <Split className="h-3 w-3" />
            {futureInstallments} parcela(s) futura(s) serão criadas
          </p>
        )}
        {duplicates > 0 && (
          <p className="flex items-center justify-end gap-1 text-[11px] text-amber-700">
            <AlertTriangle className="h-3 w-3" />
            {duplicates} possível(is) duplicado(s) fora do envio
          </p>
        )}
        {futureInstallments === 0 && duplicates === 0 && (
          <p className="flex items-center justify-end gap-1 text-[11px] text-fin-muted">
            <Layers className="h-3 w-3" />
            {total} linha(s) lida(s)
          </p>
        )}
      </div>
    </div>
  )
}
