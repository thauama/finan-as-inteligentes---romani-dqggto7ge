// 0023 — Correção de dados: recorrências com frequency != mensal e interval_months
// vazio/1 recebem o intervalo correto derivado do frequency (bimestral→2,
// trimestral→3, semestral→6, anual→12). Idempotente: já corrigidas não são tocadas.
migrate(
  (app) => {
    const intervals = {
      bimestral: 2,
      trimestral: 3,
      semestral: 6,
      anual: 12,
    }
    const records = app.findRecordsByFilter(
      'recurring_transactions',
      "frequency != 'mensal' && frequency != 'semanal' && frequency != 'quinzenal' && (interval_months = '' || interval_months = 0 || interval_months = 1)",
      '',
      0,
      0,
    )
    let fixed = 0
    for (const record of records) {
      const freq = record.getString('frequency')
      const interval = intervals[freq]
      if (interval && interval > 1) {
        record.set('interval_months', interval)
        app.save(record)
        fixed++
      }
    }
    console.log('[0023] interval_months corrigidos por frequency: ' + fixed)
  },
  (app) => {
    // Down: nada a reverter (o backfill não introduz informação nova).
  },
)
