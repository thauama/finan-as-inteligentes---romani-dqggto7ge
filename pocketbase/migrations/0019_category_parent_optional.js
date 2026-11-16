migrate(
  (app) => {
    const collection = app.findCollectionByNameOrId('categories')

    // 'parent' passa a ser OPCIONAL: subcategorias (subtipos) recebem a
    // categoria mãe aqui. Antes a relação era obrigatória, o que impedia
    // criar categorias raiz e derrubava a exclusão de subcategorias com
    // "Failed to delete record ... required relation reference".
    const parentField = collection.fields.getByName('parent')
    parentField.required = false

    app.save(collection)
  },
  (app) => {
    const collection = app.findCollectionByNameOrId('categories')
    const parentField = collection.fields.getByName('parent')
    parentField.required = true
    app.save(collection)
  },
)
