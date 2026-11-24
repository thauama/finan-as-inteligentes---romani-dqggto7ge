// Migration 0025: o campo frequency de recurring_transactions era um SELECT
// com os valores mensal|semanal|quinzenal|anual. O app agora oferece também
// frequências personalizadas ("A cada N meses", qualquer N >= 1), gravadas em
// interval_months com um texto de frequência livre ("a cada 4 meses" etc.).
// Como SELECT rejeita valores fora da lista (era isso que bloqueava o usuário
// ao salvar Bimestral/Trimestral/Semestral), o campo passa a ser TEXT, aceitando
// qualquer rótulo. Idempotente: só converte se ainda estiver como select.
migrate(
  (app) => {
    const col = app.findCollectionByNameOrId('recurring_transactions')
    const field = col.fields.getByName('frequency')
    if (!field || field.type !== 'select') return // já convertido
    const idx = col.fields.indexOf(field)
    col.fields.remove(idx)
    col.fields.insert(idx, new Field({ name: 'frequency', type: 'text', required: true }))
    app.save(col)
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
