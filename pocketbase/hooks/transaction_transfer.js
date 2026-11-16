// Rotas dedicadas para transferência entre contas.
// REGRA DO JSVM: todo o código fica INLINE dentro de cada callback —
// nenhuma função ou variável top-level é referenciada dentro de callbacks.

routerAdd('POST', '/backend/v1/transactions/transfer', (e) => {
  const info = e.requestInfo()
  const body = (info && info.body) || {}
  const userId = e.auth.id

  const accountId = String(body.account_id || '').trim()
  const destinationId = String(body.destination_account_id || '').trim()
  const amount = Number(body.amount)
  const date = String(body.date || '').trim()
  const description = String(body.description || '').trim()
  const notes = String(body.notes || '').trim()

  if (!userId) {
    return e.json(401, { message: 'Sessão expirada. Faça login novamente.' })
  }
  if (!accountId || !destinationId) {
    return e.badRequestError('Informe a conta de origem e a conta de destino.')
  }
  if (accountId === destinationId) {
    return e.badRequestError('A conta de origem e a de destino devem ser diferentes.')
  }
  if (!amount || Number.isNaN(amount) || amount <= 0) {
    return e.badRequestError('Informe um valor maior que zero.')
  }
  if (!date) {
    return e.badRequestError('Informe a data da transferência.')
  }

  try {
    let created = null

    $app.runInTransaction((txApp) => {
      // Data aceita 'YYYY-MM-DD' ou ISO; normaliza para meio-dia UTC
      const parsedDate = /^\d{4}-\d{2}-\d{2}$/.test(date) ? date + ' 12:00:00.000Z' : date
      const parsed = new Date(parsedDate.replace(' ', 'T'))
      if (Number.isNaN(parsed.getTime())) {
        throw new BadRequestError('Data inválida.')
      }
      const normalizedDate = parsed.toISOString().replace('T', ' ')

      let source = null
      let destination = null
      try {
        source = txApp.findRecordById('accounts', accountId)
      } catch (_) {
        throw new BadRequestError('Conta de origem não encontrada.')
      }
      try {
        destination = txApp.findRecordById('accounts', destinationId)
      } catch (_) {
        throw new ForbiddenError('Conta de destino inválida.')
      }
      if (source.getString('user') !== userId) {
        throw new ForbiddenError('Conta de origem inválida.')
      }
      if (destination.getString('user') !== userId) {
        throw new ForbiddenError('Conta de destino inválida.')
      }

      const collection = txApp.findCollectionByNameOrId('transactions')

      const outgoing = new Record(collection)
      outgoing.set('description', description || 'Transferência entre contas')
      outgoing.set('amount', amount)
      outgoing.set('type', 'transferencia')
      outgoing.set('date', normalizedDate)
      outgoing.set('account', accountId)
      outgoing.set('destination_account', destinationId)
      outgoing.set('notes', notes)
      outgoing.set('user', userId)
      txApp.save(outgoing)
      created = outgoing
    })

    return e.json(200, {
      id: created.id,
      description: created.getString('description'),
      amount: created.getFloat('amount'),
      type: created.getString('type'),
      date: created.getDateTime('date').string(),
      account: created.getString('account'),
      destination_account: created.getString('destination_account'),
      notes: created.getString('notes'),
      user: created.getString('user'),
      collectionId: created.collection().id,
      collectionName: 'transactions',
      created: true,
    })
  } catch (error) {
    const isApiError = error && typeof error.message === 'string' && error.status
    if (isApiError) {
      return e.json(error.status || 400, { message: error.message })
    }
    return e.json(500, { message: 'Não foi possível criar a transferência. Tente novamente.' })
  }
})

// Atualiza uma transferência existente — grava sobre o MESMO lançamento, sem criar cópia.
routerAdd('PATCH', '/backend/v1/transactions/transfer/{id}', (e) => {
  const info = e.requestInfo()
  const body = (info && info.body) || {}
  const userId = e.auth.id
  const recordId = String(e.requestPathValue('id') || '').trim()

  const accountId = String(body.account_id || '').trim()
  const destinationId = String(body.destination_account_id || '').trim()
  const amount = Number(body.amount)
  const date = String(body.date || '').trim()
  const description = String(body.description || '').trim()
  const notes = String(body.notes || '').trim()

  if (!userId) {
    return e.json(401, { message: 'Sessão expirada. Faça login novamente.' })
  }
  if (!recordId) {
    return e.badRequestError('Transferência não informada.')
  }
  if (!accountId || !destinationId) {
    return e.badRequestError('Informe a conta de origem e a conta de destino.')
  }
  if (accountId === destinationId) {
    return e.badRequestError('A conta de origem e a de destino devem ser diferentes.')
  }
  if (!amount || Number.isNaN(amount) || amount <= 0) {
    return e.badRequestError('Informe um valor maior que zero.')
  }
  if (!date) {
    return e.badRequestError('Informe a data da transferência.')
  }

  try {
    let updated = null

    $app.runInTransaction((txApp) => {
      let transfer = null
      try {
        transfer = txApp.findRecordById('transactions', recordId)
      } catch (_) {
        throw new BadRequestError('Transferência não encontrada.')
      }
      // Só o dono pode editar, e o registro precisa ser do tipo 'transferencia'
      if (transfer.getString('user') !== userId) {
        throw new ForbiddenError('Você não tem permissão para editar esta transferência.')
      }
      if (transfer.getString('type') !== 'transferencia') {
        throw new BadRequestError('O lançamento informado não é uma transferência.')
      }

      let source = null
      let destination = null
      try {
        source = txApp.findRecordById('accounts', accountId)
      } catch (_) {
        throw new BadRequestError('Conta de origem não encontrada.')
      }
      try {
        destination = txApp.findRecordById('accounts', destinationId)
      } catch (_) {
        throw new BadRequestError('Conta de destino não encontrada.')
      }
      if (source.getString('user') !== userId) {
        throw new ForbiddenError('Conta de origem inválida.')
      }
      if (destination.getString('user') !== userId) {
        throw new ForbiddenError('Conta de destino inválida.')
      }

      const parsedDate = /^\d{4}-\d{2}-\d{2}$/.test(date) ? date + ' 12:00:00.000Z' : date
      const parsed = new Date(parsedDate.replace(' ', 'T'))
      if (Number.isNaN(parsed.getTime())) {
        throw new BadRequestError('Data inválida.')
      }
      const normalizedDate = parsed.toISOString().replace('T', ' ')

      transfer.set('description', description || 'Transferência entre contas')
      transfer.set('amount', amount)
      transfer.set('date', normalizedDate)
      transfer.set('account', accountId)
      transfer.set('destination_account', destinationId)
      transfer.set('notes', notes)
      txApp.save(transfer)
      updated = transfer
    })

    return e.json(200, {
      id: updated.id,
      description: updated.getString('description'),
      amount: updated.getFloat('amount'),
      type: updated.getString('type'),
      date: updated.getDateTime('date').string(),
      account: updated.getString('account'),
      destination_account: updated.getString('destination_account'),
      notes: updated.getString('notes'),
      user: updated.getString('user'),
      collectionId: updated.collection().id,
      collectionName: 'transactions',
      updated: true,
    })
  } catch (error) {
    const isApiError = error && typeof error.message === 'string' && error.status
    if (isApiError) {
      return e.json(error.status || 400, { message: error.message })
    }
    return e.json(500, { message: 'Não foi possível atualizar a transferência. Tente novamente.' })
  }
})
