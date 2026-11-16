// Confirmação da importação de fatura/extrato em PDF.
// POST JSON /backend/v1/import/pdf/confirm
// Body: { account_id: string, transactions: [{date, description, amount, type, category_id}] }
// Cria lançamentos REAIS (coleção transactions), vinculados à conta e categoria
// escolhidos na tela de revisão. Tudo dentro de uma transação: ou cria todos,
// ou nenhum.
routerAdd(
  'POST',
  '/backend/v1/import/pdf/confirm',
  (e) => {
    const userId = e.auth && e.auth.id
    if (!userId) return e.unauthorizedError('Autenticação necessária')

    const body = e.requestInfo().body || {}
    const accountId = typeof body.account_id === 'string' ? body.account_id.trim() : ''
    const incoming = Array.isArray(body.transactions) ? body.transactions : []

    if (!accountId) {
      return e.badRequestError('Selecione a conta ou cartão de destino.')
    }
    if (incoming.length === 0) {
      return e.badRequestError('Nenhum lançamento para importar.')
    }
    if (incoming.length > 200) {
      return e.badRequestError('No máximo 200 lançamentos por importação.')
    }

    // Conta precisa pertencer ao usuário.
    let account = null
    try {
      account = $app.findRecordById('accounts', accountId)
    } catch (_) {
      return e.badRequestError('Conta inválida.')
    }
    if (account.getString('user') !== userId) {
      return e.forbiddenError('Conta não pertence ao usuário autenticado.')
    }

    // Categorias do usuário, para validar as escolhidas na revisão.
    const categoriesById = {}
    try {
      const categoryRecords = $app.findRecordsByFilter(
        'categories',
        "user = '" + userId + "'",
        '',
        1000,
        0,
      )
      for (let i = 0; i < categoryRecords.length; i++) {
        const rec = categoryRecords[i]
        categoriesById[rec.id] = { type: rec.getString('type'), name: rec.getString('name') }
      }
    } catch (_) {
      categoriesById = {}
    }

    const dateRe = /^\d{4}-\d{2}-\d{2}$/
    const prepared = []
    for (let i = 0; i < incoming.length; i++) {
      const item = incoming[i] || {}
      const description = String(item.description || '').trim()
      const amount = Number(item.amount)
      const type = item.type === 'receita' ? 'receita' : 'despesa'
      const date = String(item.date || '').trim()
      let categoryId = String(item.category_id || '').trim()
      if (!description) {
        return e.badRequestError('Todo lançamento precisa de uma descrição.')
      }
      if (!isFinite(amount) || amount <= 0) {
        return e.badRequestError('Todo lançamento precisa de um valor maior que zero.')
      }
      if (!dateRe.test(date)) {
        return e.badRequestError('Todo lançamento precisa de uma data válida (AAAA-MM-DD).')
      }
      if (categoryId) {
        if (!categoriesById[categoryId]) {
          return e.badRequestError('Categoria inválida em um dos lançamentos.')
        }
        if (categoriesById[categoryId].type !== type) {
          categoryId = ''
        }
      }
      prepared.push({
        description: description.slice(0, 200),
        amount: Math.round(amount * 100) / 100,
        type: type,
        date: date,
        category_id: categoryId,
      })
    }

    let createdCount = 0
    $app.runInTransaction((txApp) => {
      for (let i = 0; i < prepared.length; i++) {
        const item = prepared[i]
        const collection = txApp.findCollectionByNameOrId('transactions')
        const record = new Record(collection)
        record.set('user', userId)
        record.set('account', accountId)
        record.set('description', item.description)
        record.set('amount', item.amount)
        record.set('type', item.type)
        record.set('date', item.date + ' 12:00:00.000Z')
        record.set('category', item.category_id)
        record.set('notes', 'Importado por PDF')
        txApp.save(record)
        createdCount++
      }
    })

    return e.json(200, { created: createdCount })
  },
  $apis.requireAuth(),
)
