import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import {
  ArrowDownRight,
  ArrowUpRight,
  CalendarCheck,
  CheckCircle2,
  Info,
  Scale,
} from 'lucide-react'

import { useRealtime } from '@/hooks/use-realtime'
import { brl, currentMonth, monthBounds, monthTitle, shiftMonth, toDateInput } from '@/lib/format'
import { listBills } from '@/services/bills'
import { listTransactions } from '@/services/transactions'
import type { Bill, Transaction } from '@/types/finance'

/**
 * Aba Início — comparação Previsto × Realizado do mês corrente.
 *
 * Definições (mesmas janelas/regras do Dashboard, regra v0.0.21 de parcelas):
 * - Previsto para entrar  = receitas lançadas no mês + contas a receber pendentes com vencimento no mês.
 * - Previsto para pagar   = despesas lançadas no mês (parcela conta só no mês do vencimento) +
 *                           contas a pagar pendentes com vencimento no mês.
 * - Já recebido / já pago = apenas os lançamentos do mês (dinheiro que movimentou de fato).
 * - Sobra do mês anterior = acumulado realizado até o fim do mês anterior
 *                           (todas as receitas − despesas com data anterior ao mês exibido).
 * - Transferências ficam fora de todos os totais.
 */
export default function InicioPage() {
  const [transactions, setTransactions] = useState<Transaction[]>([])
  const [bills, setBills] = useState<Bill[]>([])
  const [loading, setLoading] = useState(true)

  const reload = useCallback(async () => {
    try {
      const [txs, billList] = await Promise.all([listTransactions(), listBills()])
      setTransactions(txs)
      setBills(billList)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void reload()
  }, [reload])
  useRealtime<Transaction>('transactions', () => {
    void reload()
  })
  useRealtime<Bill>('bills', () => {
    void reload()
  })

  const month = currentMonth()
  const { start, next } = monthBounds(month)
  const monthStartDay = start.slice(0, 10)
  const monthEndDay = next.slice(0, 10)

  const summary = useMemo(() => {
    const inMonth = transactions.filter((t) => t.date >= start && t.date < next)
    const recebido = inMonth
      .filter((t) => t.type === 'receita')
      .reduce((sum, t) => sum + t.amount, 0)
    const pago = inMonth.filter((t) => t.type === 'despesa').reduce((sum, t) => sum + t.amount, 0)

    // Contas pendentes do mês (em aberto ou atrasadas no próprio mês) — o
    // previsto que ainda não virou lançamento.
    const pendingInMonth = bills.filter((bill) => {
      if (bill.status === 'pago') return false
      const day = toDateInput(bill.due_date)
      return day >= monthStartDay && day < monthEndDay
    })
    const aReceber = pendingInMonth
      .filter((bill) => bill.direction === 'receber')
      .reduce((sum, bill) => sum + bill.amount, 0)
    const aPagar = pendingInMonth
      .filter((bill) => bill.direction === 'pagar')
      .reduce((sum, bill) => sum + bill.amount, 0)

    // Sobra acumulada até o fim do mês anterior (realizado histórico).
    const sobraAnterior = transactions
      .filter((t) => t.type !== 'transferencia' && t.date < start)
      .reduce((sum, t) => sum + (t.type === 'receita' ? t.amount : -t.amount), 0)

    return {
      recebido,
      pago,
      aReceber,
      aPagar,
      pendingReceberCount: pendingInMonth.filter((b) => b.direction === 'receber').length,
      pendingPagarCount: pendingInMonth.filter((b) => b.direction === 'pagar').length,
      sobraAnterior,
      previstoEntrar: recebido + aReceber,
      previstoSair: pago + aPagar,
    }
  }, [transactions, bills, start, next, monthStartDay, monthEndDay])

  const { recebido, pago, aReceber, aPagar, sobraAnterior, previstoEntrar, previstoSair } = summary
  const totalPrevisto = sobraAnterior + previstoEntrar - previstoSair
  const totalReal = sobraAnterior + recebido - pago
  const diferenca = totalReal - totalPrevisto

  const pctEntradas = previstoEntrar > 0 ? Math.min((recebido / previstoEntrar) * 100, 100) : 0
  const pctSaidas = previstoSair > 0 ? Math.min((pago / previstoSair) * 100, 100) : 0

  if (loading) return <InicioSkeleton />

  return (
    <div className="space-y-6 page-container">
      <section>
        <p className="mb-1 text-xs font-semibold uppercase tracking-wider text-fin-muted">
          Planejamento
        </p>
        <h1 className="page-title">Início</h1>
        <p className="page-subtitle">
          Previsto × realizado de {monthTitle(month)} — o que falta receber e pagar ainda entra na
          conta.
        </p>
      </section>

      <section className="grid gap-5 xl:grid-cols-2">
        {/* Bloco PREVISTO */}
        <article className="fin-card animate-fade-up stagger-1 overflow-hidden border-indigo-100 bg-gradient-to-b from-indigo-50/40 via-white to-white shadow-sm">
          <div className="flex items-center gap-3 border-b border-fin-border px-5 py-4 sm:px-6">
            <span className="grid h-10 w-10 place-items-center rounded-xl bg-indigo-50 text-fin-primary">
              <Scale className="h-5 w-5" />
            </span>
            <div>
              <h2 className="section-title">Previsto</h2>
              <p className="mt-0.5 text-xs text-fin-muted">Tudo que está projetado para o mês</p>
            </div>
          </div>

          <div className="space-y-4 px-5 py-5 sm:px-6">
            <SummaryRow
              icon={<ArrowDownRight className="h-4 w-4" />}
              label="Previsto para entrar"
              value={previstoEntrar}
              tone="success"
              hint={
                aReceber > 0
                  ? `Inclui ${brl.format(aReceber)} em ${summary.pendingReceberCount} conta(s) a receber`
                  : undefined
              }
            />
            <SummaryRow
              icon={<ArrowUpRight className="h-4 w-4" />}
              label="Despesas previstas para pagar"
              value={previstoSair}
              tone="danger"
              hint={
                aPagar > 0
                  ? `Inclui ${brl.format(aPagar)} em ${summary.pendingPagarCount} conta(s) a pagar`
                  : undefined
              }
            />

            <div className="flex items-center justify-between rounded-xl bg-fin-surface/70 px-4 py-3 text-sm">
              <span className="text-fin-muted">Sobra de {monthTitle(shiftMonth(month, -1))}</span>
              <strong className={sobraAnterior >= 0 ? 'text-fin-success' : 'text-fin-danger'}>
                {sobraAnterior >= 0 ? '+' : ''}
                {brl.format(sobraAnterior)}
              </strong>
            </div>

            <TotalRow
              label={`Total previsto do mês (com a sobra)`}
              value={totalPrevisto}
              accent="indigo"
            />
          </div>
        </article>

        {/* Bloco REALIZADO */}
        <article className="fin-card animate-fade-up stagger-2 overflow-hidden border-emerald-100 bg-gradient-to-b from-emerald-50/40 via-white to-white shadow-sm">
          <div className="flex items-center gap-3 border-b border-fin-border px-5 py-4 sm:px-6">
            <span className="grid h-10 w-10 place-items-center rounded-xl bg-emerald-50 text-emerald-700">
              <CheckCircle2 className="h-5 w-5" />
            </span>
            <div>
              <h2 className="section-title">Realizado</h2>
              <p className="mt-0.5 text-xs text-fin-muted">
                Somente o que efetivamente entrou e saiu
              </p>
            </div>
          </div>

          <div className="space-y-4 px-5 py-5 sm:px-6">
            <SummaryRow
              icon={<ArrowDownRight className="h-4 w-4" />}
              label="Receitas já recebidas"
              value={recebido}
              tone="success"
            />
            <SummaryRow
              icon={<ArrowUpRight className="h-4 w-4" />}
              label="Valores já pagos"
              value={pago}
              tone="danger"
            />

            <div className="rounded-xl bg-fin-surface/70 px-4 py-3 text-sm">
              <div className="flex items-center justify-between">
                <span className="text-fin-muted">Sobra de {monthTitle(shiftMonth(month, -1))}</span>
                <strong className={sobraAnterior >= 0 ? 'text-fin-success' : 'text-fin-danger'}>
                  {sobraAnterior >= 0 ? '+' : ''}
                  {brl.format(sobraAnterior)}
                </strong>
              </div>

              <div className="mt-3 space-y-2.5">
                <ProgressBar
                  label="Entradas recebidas do previsto"
                  pct={pctEntradas}
                  barClass="bg-emerald-600"
                />
                <ProgressBar
                  label="Despesas pagas do previsto"
                  pct={pctSaidas}
                  barClass="bg-rose-600"
                />
              </div>
            </div>

            <TotalRow
              label="Valor total real do mês (com a sobra)"
              value={totalReal}
              accent="emerald"
              chip={
                <span
                  className={`fin-badge ${
                    diferenca === 0
                      ? 'fin-badge-success'
                      : diferenca > 0
                        ? 'fin-badge-success'
                        : 'fin-badge-danger'
                  }`}
                >
                  {diferenca === 0
                    ? 'no previsto'
                    : `${brl.format(Math.abs(diferenca))} ${diferenca > 0 ? 'acima' : 'abaixo'} do previsto`}
                </span>
              }
            />
          </div>
        </article>
      </section>

      <p className="flex items-start gap-2 px-1 text-xs text-fin-muted">
        <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        <span>
          Transferências entre contas não entram nos totais. Cada parcela de parcelamento conta como
          realizada somente no mês do vencimento. Contas liquidadas viram lançamentos e passam a
          contar no realizado.
        </span>
      </p>
    </div>
  )
}

function SummaryRow({
  icon,
  label,
  value,
  tone,
  hint,
}: {
  icon: ReactNode
  label: string
  value: number
  tone: 'success' | 'danger'
  hint?: string
}) {
  return (
    <div className="flex items-start justify-between gap-3">
      <div className="flex items-center gap-2.5">
        <span
          className={`grid h-8 w-8 place-items-center rounded-lg ${
            tone === 'success' ? 'bg-emerald-50 text-emerald-700' : 'bg-rose-50 text-rose-700'
          }`}
        >
          {icon}
        </span>
        <div>
          <p className="text-sm font-medium text-fin-text">{label}</p>
          {hint && <p className="mt-0.5 text-[11px] text-fin-muted">{hint}</p>}
        </div>
      </div>
      <strong
        className={`shrink-0 text-[15px] font-bold ${
          tone === 'success' ? 'text-emerald-700' : 'text-rose-700'
        }`}
      >
        {tone === 'success' ? '+' : '−'}
        {brl.format(value)}
      </strong>
    </div>
  )
}

function ProgressBar({ label, pct, barClass }: { label: string; pct: number; barClass: string }) {
  return (
    <div>
      <div className="mb-1 flex items-center justify-between text-[11px]">
        <span className="text-fin-muted">{label}</span>
        <span className="font-bold text-fin-text">{pct.toFixed(0)}%</span>
      </div>
      <div className="h-2 w-full overflow-hidden rounded-full border border-slate-200/70 bg-slate-200/80">
        <div
          className={`h-full rounded-full transition-all duration-700 ${barClass}`}
          style={{ width: `${Math.max(pct, pct > 0 ? 3 : 0)}%` }}
        />
      </div>
    </div>
  )
}

function TotalRow({
  label,
  value,
  accent,
  chip,
}: {
  label: string
  value: number
  accent: 'indigo' | 'emerald'
  chip?: ReactNode
}) {
  return (
    <div
      className={`flex flex-wrap items-center justify-between gap-2 rounded-xl border px-4 py-3.5 ${
        accent === 'indigo'
          ? 'border-indigo-100 bg-indigo-50/60'
          : 'border-emerald-100 bg-emerald-50/60'
      }`}
    >
      <div className="min-w-0">
        <p className="text-xs font-semibold uppercase tracking-wide text-fin-muted">{label}</p>
        <p
          className={`mt-1 text-2xl font-extrabold tracking-[-.02em] ${
            value >= 0 ? 'text-fin-text' : 'text-fin-danger'
          }`}
        >
          {brl.format(value)}
        </p>
      </div>
      {chip}
    </div>
  )
}

function InicioSkeleton() {
  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <div className="skeleton h-4 w-28" />
        <div className="skeleton h-8 w-40" />
        <div className="skeleton h-4 w-72" />
      </div>
      <div className="grid gap-5 xl:grid-cols-2">
        {[0, 1].map((index) => (
          <div key={index} className="fin-card p-6">
            <div className="flex items-center gap-3">
              <div className="skeleton h-10 w-10 rounded-xl" />
              <div className="space-y-2">
                <div className="skeleton h-4 w-24" />
                <div className="skeleton h-3 w-40" />
              </div>
            </div>
            <div className="mt-6 space-y-4">
              <div className="skeleton h-10 w-full rounded-xl" />
              <div className="skeleton h-10 w-full rounded-xl" />
              <div className="skeleton h-14 w-full rounded-xl" />
              <div className="skeleton h-20 w-full rounded-xl" />
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
