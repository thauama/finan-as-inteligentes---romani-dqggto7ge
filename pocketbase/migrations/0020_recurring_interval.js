// Migration 0020: campo interval_months na coleção recurring_transactions.
// Permite recorrências com intervalo de meses (1=mensal, 2=bimestral, 3=trimestral,
// 6=semestral, 12=anual). Idempotente: se o campo já existir, não faz nada.
migrate(
  (app) => {
    const collection = app.findCollectionByNameOrId('recurring_transactions')
    if (collection.fields.getByName('interval_months')) {
      return // já aplicado
    }
    collection.fields.add(
      new NumberField({
        name: 'interval_months',
        onlyInt: true,
        min: 1,
        max: 60,
      }),
    )
    app.save(collection)
  },
  (app) => {
    const collection = app.findCollectionByNameOrId('recurring_transactions')
    if (!collection.fields.getByName('interval_months')) {
      return // nada a reverter
    }
    collection.fields.removeByName('interval_months')
    app.save(collection)
  },
)
