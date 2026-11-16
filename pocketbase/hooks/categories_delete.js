// Rotas para EXCLUIR categorias (mãe ou subcategoria) com proteção de vínculos.
// GET  /backend/v1/categories/{id}/impact → conta os vínculos da categoria
// DELETE /backend/v1/categories/{id}      → exclusão atômica dos vínculos escolhidos
//
// Por que rotas dedicadas: a exclusão direta pela API de registros falha com
// "Failed to delete record ... required relation reference" quando a categoria
// tem subcategorias (a relação parent referencia a categoria que está sendo
// excluída). Aqui os vínculos são resolvidos em transação — sem órfãos.
//
// REGRA DO JSVM: todo o código fica INLINE dentro de cada callback — nenhuma
// função ou variável top-level é referenciada dentro de callbacks.
//
// API do JSVM v0.36: parâmetro de rota fica em e.request.pathValue('id') —
// e.requestPathValue não existe (TypeError "Object has no member").

routerAdd('GET', '/backend/v1/categories/{id}/impact', (e) => {
  const userId = (e.auth && e.auth.id) || ''
  if (!userId) {
    return e.json(401, { message: 'Sessão expirada. Faça login novamente.' })
  }
  const categoryId = String(e.request.pathValue('id') || '').trim()
  if (!categoryId) {
    return e.badRequestError('Categoria não informada.')
  }

  try {
    let category = null
    try {
      category = $app.findRecordById('categories', categoryId)
    } catch (_) {
      return e.json(404, { message: 'Categoria não encontrada.' })
    }
    if (category.getString('user') !== userId) {
      return e.json(403, { message: 'Você não tem permissão para excluir esta categoria.' })
    }

    const count = (collection, filter) => {
      try {
        return $app.countRecords(collection, filter)
      } catch (_) {
        return 0
      }
    }

    // Subcategorias da categoria (e netas, por segurança)
    let subIds = []
    let grandIds = []
    try {
      const subs = $app.findRecordsByFilter(
        'categories',
        "parent = '" + categoryId + "'",
        'created',
        0,
        0,
      )
      for (let i = 0; i < subs.length; i++) {
        subIds.push(subs[i].id)
        const subs2 = $app.findRecordsByFilter(
          'categories',
          "parent = '" + subs[i].id + "'",
          'created',
          0,
          0,
        )
        for (let j = 0; j < subs2.length; j++) grandIds.push(subs2[j].id)
      }
    } catch (_) {}

    const allIds = [categoryId].concat(subIds, grandIds)
    let txCount = 0
    let billCount = 0
    let recurringCount = 0
    for (let i = 0; i < allIds.length; i++) {
      txCount += count('transactions', "category = '" + allIds[i] + "'")
      billCount += count('bills', "category = '" + allIds[i] + "'")
      recurringCount += count('recurring_transactions', "category = '" + allIds[i] + "'")
    }

    return e.json(200, {
      id: categoryId,
      name: category.getString('name'),
      type: category.getString('type'),
      subcategories: subIds.length,
      transactions: txCount,
      bills: billCount,
      recurrings: recurringCount,
      linked_transactions: txCount + billCount + recurringCount,
    })
  } catch (error) {
    const isApiError = error && typeof error.message === 'string' && error.status
    if (isApiError) {
      return e.json(error.status || 400, { message: error.message })
    }
    return e.json(500, { message: 'Não foi possível verificar os vínculos da categoria.' })
  }
})

routerAdd('DELETE', '/backend/v1/categories/{id}', (e) => {
  const userId = (e.auth && e.auth.id) || ''
  if (!userId) {
    return e.json(401, { message: 'Sessão expirada. Faça login novamente.' })
  }
  const categoryId = String(e.request.pathValue('id') || '').trim()
  if (!categoryId) {
    return e.badRequestError('Categoria não informada.')
  }

  const info = e.requestInfo()
  const body = (info && info.body) || {}
  const mode = String(body.mode || '').trim() // 'delete' | 'keep'
  if (mode !== 'delete' && mode !== 'keep') {
    return e.badRequestError('Informe o modo de exclusão: "delete" ou "keep".')
  }

  try {
    $app.runInTransaction((txApp) => {
      let category = null
      try {
        category = txApp.findRecordById('categories', categoryId)
      } catch (_) {
        throw new BadRequestError('Categoria não encontrada.')
      }
      if (category.getString('user') !== userId) {
        throw new ForbiddenError('Você não tem permissão para excluir esta categoria.')
      }

      // Família: a própria categoria + subcategorias (e netas, por segurança)
      const ids = [categoryId]
      const subList = txApp.findRecordsByFilter(
        'categories',
        "parent = '" + categoryId + "'",
        'created',
        0,
        0,
      )
      for (let i = 0; i < subList.length; i++) {
        ids.push(subList[i].id)
        const sub2 = txApp.findRecordsByFilter(
          'categories',
          "parent = '" + subList[i].id + "'",
          'created',
          0,
          0,
        )
        for (let j = 0; j < sub2.length; j++) ids.push(sub2[j].id)
      }

      // Lançamentos, contas a pagar/receber e recorrências em qualquer
      // categoria da família
      const collectLinks = (collection, field) => {
        let found = []
        for (let i = 0; i < ids.length; i++) {
          const rows = txApp.findRecordsByFilter(
            collection,
            field + " = '" + ids[i] + "'",
            'created',
            0,
            0,
          )
          for (let j = 0; j < rows.length; j++) found.push(rows[j])
        }
        return found
      }

      const txs = collectLinks('transactions', 'category')
      const bills = collectLinks('bills', 'category')
      const recurrings = collectLinks('recurring_transactions', 'category')
      const budgets = collectLinks('budgets', 'category')

      const totalLinks = txs.length + bills.length + recurrings.length + budgets.length

      // Modo 'keep': só permitido quando NÃO há nenhum vínculo — nada fica órfão.
      if (totalLinks > 0 && mode === 'keep') {
        throw new BadRequestError(
          'Esta categoria tem ' +
            totalLinks +
            ' vínculo(s) (lançamentos, contas, recorrências ou metas). Para mantê-los, escolha "Excluir tudo".',
        )
      }

      if (mode === 'delete') {
        // Lançamentos: nada fica órfão — podem ir junto (mesma regra da
        // exclusão de contas); o histórico é do usuário, que escolheu excluir.
        for (let i = 0; i < txs.length; i++) txApp.delete(txs[i])

        // Metas: excluídas junto (a relação category é obrigatória em budgets)
        for (let i = 0; i < budgets.length; i++) txApp.delete(budgets[i])

        // Contas a pagar/receber: desvinculadas (categoria deixa de existir)
        for (let i = 0; i < bills.length; i++) {
          bills[i].set('category', '')
          txApp.save(bills[i])
        }

        // Recorrências: desativadas e desvinculadas
        for (let i = 0; i < recurrings.length; i++) {
          recurrings[i].set('category', '')
          recurrings[i].set('active', false)
          txApp.save(recurrings[i])
        }
      }

      // Por fim, excluir a(s) categoria(s) da família (subcategorias primeiro)
      for (let i = ids.length - 1; i >= 0; i--) {
        if (ids[i] === categoryId) continue
        let sub = null
        try {
          sub = txApp.findRecordById('categories', ids[i])
        } catch (_) {
          continue
        }
        txApp.delete(sub)
      }
      txApp.delete(category)
    })

    return e.json(200, { ok: true, mode: mode })
  } catch (error) {
    const isApiError = error && typeof error.message === 'string' && error.status
    if (isApiError) {
      return e.json(error.status || 400, { message: error.message })
    }
    return e.json(500, { message: 'Não foi possível excluir a categoria. Tente novamente.' })
  }
})
