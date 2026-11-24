// 0030 — Fix real do "não consigo cadastrar novas frequências": as migrações
// 0024/0025/0026 foram marcadas como aplicadas mas o campo frequency de
// recurring_transactions CONTINUA select (mensal|semanal|quinzenal|anual) —
// um select rejeita qualquer valor fora da lista, era isso que bloqueava o
// usuário ao salvar "bimestral"/"trimestral"/"a cada 4 meses".
// Converte o campo para TEXT de verdade (idempotente: só age se for select).
migrate(
  (app) => {
    const col = app.findCollectionByNameOrId('recurring_transactions')
    const field = col.fields.getByName('frequency')
    if (!field || field.type !== 'select') return // já convertido
    const idx = col.fields.indexOf(field)
    col.fields.remove(idx)
    col.fields.insert(idx, new TextField({ name: 'frequency', required: true }))
    app.save(col)
    console.log('[0030] frequency convertido para text em recurring_transactions')
  },
  (app) => {
    const col = app.findCollectionByNameOrId('recurring_transactions')
    const field = col.fields.getByName('frequency')
    if (!field || field.type !== 'text') return
    const idx = col.fields.indexOf(field)
    col.fields.remove(idx)
    col.fields.insert(
      idx,
      new SelectField({
        name: 'frequency',
        required: true,
        maxSelect: 1,
        values: ['mensal', 'semanal', 'quinzenal', 'anual'],
      }),
    )
    app.save(col)
  },
)
