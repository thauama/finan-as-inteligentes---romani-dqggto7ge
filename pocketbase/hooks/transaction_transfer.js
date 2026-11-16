routerAdd('POST', '/backend/v1/transactions/transfer', (e) => {
  const info = e.requestInfo()
  const body = info.body || {}

  const accountId = String(body.account_id || '').trim()
  const destinationId = String(body.destination_account_id || '').trim()
  const amount = Number(body.amount)
  const date = String(body.date || '').trim()
  const description = String(body.description || '').trim()
  const notes = String(body.notes || '').trim()

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

  const userId = e.auth.id

  try {
    let created = null

    $app.runInTransaction((txApp) => {
      // Valida propriedade das duas contas DENTRO da transação
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

      // Garante data válida (aceita 'YYYY-MM-DD' ou ISO) e normaliza para meio-dia UTC
      const dateInput = /^\d{4}-\d{2}-\d{2}$/.test(date) ? `${date} 12:00:00.000Z` : date
      const parsed = new Date(dateInput.replace(' ', 'T'))
      if (Number.isNaN(parsed.getTime())) {
        throw new BadRequestError('Data inválida.')
      }
      const normalizedDate = parsed.toISOString().replace('T', ' ')

      const collection = txApp.findCollectionByNameOrId('transactions')

      // Lançamento de saída na conta de origem
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

    return e.json(200, { id: created.id, created: true })
  } catch (error) {
    // Propaga erros de validação do PocketBase (ex.: valor negativo) com mensagem clara
    const isApiError = error && typeof error.message === 'string' && error.status
    if (isApiError) {
      return e.json(error.status || 400, { message: error.message })
    }
    return e.json(500, { message: 'Não foi possível criar a transferência. Tente novamente.' })
  }
})
