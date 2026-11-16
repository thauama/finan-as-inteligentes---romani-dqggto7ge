migrate(
  (app) => {
    const collection = app.findCollectionByNameOrId('transactions')

    // 'transferencia' entra como valor permitido do campo type
    const typeField = collection.fields.getByName('type')
    typeField.values = [...typeField.values, 'transferencia']

    // Conta de destino da transferência (opcional: só usado quando type = transferencia)
    const destinationField = new RelationField({
      name: 'destination_account',
      collectionId: app.findCollectionByNameOrId('accounts').id,
      maxSelect: 1,
    })
    collection.fields.add(destinationField)

    // Categoria passa a ser opcional (transferência não tem categoria)
    const categoryField = collection.fields.getByName('category')
    categoryField.required = false

    app.save(collection)
  },
  (app) => {
    const collection = app.findCollectionByNameOrId('transactions')
    const typeField = collection.fields.getByName('type')
    typeField.values = typeField.values.filter((v) => v !== 'transferencia')
    try {
      collection.fields.removeByName('destination_account')
    } catch (_) {}
    const categoryField = collection.fields.getByName('category')
    categoryField.required = true
    app.save(collection)
  },
)
