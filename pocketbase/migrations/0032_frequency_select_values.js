// Migração 0032 — raiz do erro "Invalid value trimestral".
//
// As tentativas anteriores (0024/0025/0026/0030/0031) tentaram converter o
// campo frequency de select para text, mas nenhuma surtiu efeito no backend
// live: 0025 usava o global inexistente `new Field` e 0030/0031 usavam
// `col.fields.remove(idx)`/`insert(idx, ...)` — o remove do JSVM é POR NOME,
// então o campo select antigo nunca saiu da coleção. Resultado: o select
// (mensal|semanal|quinzenal|anual) rejeita "trimestral" com
// "Invalid value trimestral".
//
// Em vez de uma quarta tentativa de conversão de tipo (frágil), esta migração
// MANTÉM o campo como select e amplia os valores permitidos para cobrir tudo
// que o modal grava:
//   mensal, bimestral, trimestral, semestral, anual — fixas
//   semanal, quinzenal                            — legado, tratado pelo cron
//   personalizado                                 — intervalo sob medida
//     (o número de meses vai em interval_months, ex.: a cada 4 meses →
//      frequency='personalizado', interval_months=4)
//
// Idempotente: só salva quando a lista de valores realmente muda.
migrate(
  (app) => {
    const col = app.findCollectionByNameOrId('recurring_transactions')
    const field = col.fields.getByName('frequency')
    if (!field) throw new Error('campo frequency não encontrado em recurring_transactions')

    const wanted = [
      'mensal',
      'bimestral',
      'trimestral',
      'semestral',
      'anual',
      'semanal',
      'quinzenal',
      'personalizado',
    ]
    const current = field.values || []
    const missing = wanted.filter((v) => current.indexOf(v) === -1)
    if (missing.length === 0) {
      console.log('[0032] frequency já possui todos os valores; nada a fazer')
      return
    }
    field.values = current.concat(missing)
    app.save(col)
    console.log('[0032] frequency/values atualizado: ' + field.values.join(', '))
  },
  (app) => {
    const col = app.findCollectionByNameOrId('recurring_transactions')
    const field = col.fields.getByName('frequency')
    if (!field || field.type !== 'select') return
    field.values = ['mensal', 'semanal', 'quinzenal', 'anual']
    app.save(col)
  },
)
