// 0022 — Backfill idempotente de interval_months em recurring_transactions.
//
// A migração 0020 criou o campo mas as linhas existentes ficaram com
// interval_months=0 ("unset"), e o cron trata 0 como mensal. Aqui normalizamos
// todo valor não positivo para 1 (mensal) — o valor real fica no registro, não
// implícito. Idempotente: linhas com intervalo > 1 não são tocadas.
migrate(
  (app) => {
    const records = app.findRecordsByFilter(
      'recurring_transactions',
      "interval_months = '' || interval_months = 0",
      '',
      0,
      0,
    )
    for (const record of records) {
      record.set('interval_months', 1)
      app.save(record)
    }
  },
  (app) => {
    // Down: nada a reverter (o backfill não introduz informação nova).
  },
)
