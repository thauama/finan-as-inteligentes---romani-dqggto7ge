// Rotas para EXCLUIR contas/cartões financeiros.
// GET  /backend/v1/accounts/{id}/impact  → conta os vínculos da conta
// DELETE /backend/v1/accounts/{id}       → exclusão atômica dos vínculos escolhidos
//
// REGRA DO JSVM: todo o código fica INLINE dentro de cada callback —
// nenhuma função ou variável top-level é referenciada dentro de callbacks.

routerAdd('GET', '/backend/v1/accounts/{id}/impact', (e) => {
  const userId = (e.auth && e.auth.id) || ''
  if (!userId) {
    return e.json(401, { message: 'Sessão expirada. Faça login novamente.' })
  }
  // API do JSVM v0.36: parâmetro de rota fica em e.request.pathValue —
  // e.requestPathValue não existe (TypeError "Object has no member").
  const accountId = String(e.request.pathValue('id') || '').trim()
  if (!accountId) {
    return e.badRequestError('Conta não informada.')
  }

  try {
    let account = null
    try {
      account = $app.findRecordById('accounts', accountId)
    } catch (_) {
      return e.json(404, { message: 'Conta não encontrada.' })
    }
    if (account.getString('user') !== userId) {
      return e.json(403, { message: 'Você não tem permissão para excluir esta conta.' })
    }

    const count = (collection, filter) => {
      try {
        return $app.countRecords(collection, filter)
      } catch (_) {
        return 0
      }
    }

    const transactionsCount = count('transactions', "account = '" + accountId + "'")
    const transfersCount = count(
      'transactions',
      "type = 'transferencia' && destination_account = '" + accountId + "'",
    )
    const billsCount = count('bills', "account = '" + accountId + "'")
    const recurringCount = count(
      'recurring_transactions',
      "account = '" + accountId + "' && active = true",
    )

    return e.json(200, {
      id: accountId,
      name: account.getString('name'),
      type: account.getString('type'),
      transactions: transactionsCount,
      transfers: transfersCount,
      bills: billsCount,
      active_recurrings: recurringCount,
    })
  } catch (error) {
    const isApiError = error && typeof error.message === 'string' && error.status
    if (isApiError) {
      return e.json(error.status || 400, { message: error.message })
    }
    return e.json(500, { message: 'Não foi possível verificar os vínculos da conta.' })
  }
})

routerAdd('DELETE', '/backend/v1/accounts/{id}', (e) => {
  const userId = (e.auth && e.auth.id) || ''
  if (!userId) {
    return e.json(401, { message: 'Sessão expirada. Faça login novamente.' })
  }
  // API do JSVM v0.36: parâmetro de rota fica em e.request.pathValue —
  // e.requestPathValue não existe (TypeError "Object has no member").
  const accountId = String(e.request.pathValue('id') || '').trim()
  if (!accountId) {
    return e.badRequestError('Conta não informada.')
  }

  const info = e.requestInfo()
  const body = (info && info.body) || {}
  const mode = String(body.mode || '').trim() // 'delete' | 'keep'
  if (mode !== 'delete' && mode !== 'keep') {
    return e.badRequestError('Informe o modo de exclusão: "delete" ou "keep".')
  }

  try {
    $app.runInTransaction((txApp) => {
      let account = null
      try {
        account = txApp.findRecordById('accounts', accountId)
      } catch (_) {
        throw new BadRequestError('Conta não encontrada.')
      }
      if (account.getString('user') !== userId) {
        throw new ForbiddenError('Você não tem permissão para excluir esta conta.')
      }

      // Lançamentos do usuário na coleção transactions em que a conta aparece
      // como conta principal OU como destino de transferência.
      const txs = txApp.findRecordsByFilter(
        'transactions',
        "(account = '" + accountId + "' || destination_account = '" + accountId + "')",
        'created',
        0,
        0,
      )

      // Se houver lançamentos E o modo for manter, eles ficam órfãos — bloquear.
      if (txs.length > 0 && mode === 'keep') {
        throw new BadRequestError(
          'Esta conta tem ' +
            txs.length +
            ' lançamento(s) vinculado(s). Para mantê-los, escolha "Excluir tudo".',
        )
      }

      if (mode === 'delete') {
        // 1) Excluir lançamentos vinculados (inclui transferências)
        for (let i = 0; i < txs.length; i++) {
          txApp.delete(txs[i])
        }
      }

      // 2) Contas a pagar/receber vinculadas
      const bills = txApp.findRecordsByFilter(
        'bills',
        "account = '" + accountId + "'",
        'created',
        0,
        0,
      )
      for (let i = 0; i < bills.length; i++) {
        if (mode === 'delete') {
          txApp.delete(bills[i])
        } else {
          bills[i].set('account', '')
          txApp.save(bills[i])
        }
      }

      // 3) Recorrências ativas vinculadas
      const recurrings = txApp.findRecordsByFilter(
        'recurring_transactions',
        "account = '" + accountId + "'",
        'created',
        0,
        0,
      )
      for (let i = 0; i < recurrings.length; i++) {
        if (mode === 'delete') {
          txApp.delete(recurrings[i])
        } else {
          recurrings[i].set('active', false)
          txApp.save(recurrings[i])
        }
      }

      // 4) Por fim, excluir a própria conta
      txApp.delete(account)
    })

    return e.json(200, { ok: true, mode: mode })
  } catch (error) {
    const isApiError = error && typeof error.message === 'string' && error.status
    if (isApiError) {
      return e.json(error.status || 400, { message: error.message })
    }
    return e.json(500, { message: 'Não foi possível excluir a conta. Tente novamente.' })
  }
})
