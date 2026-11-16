// Confirmação da importação de fatura/extrato em PDF/Excel.
// POST JSON /backend/v1/import/pdf/confirm
// Body: { account_id, items: [{date, description, amount, type, category_id,
//   installment_current?, installment_total?}] }
// Cria lançamentos REAIS (coleção transactions), vinculados à conta e categoria
// escolhidos na tela de revisão. Tudo dentro de uma transação: ou cria todos,
// ou nenhum.
//
// Parcelamento: quando o item traz installment_current/installment_total
// (detectado na revisão, regex no cliente), além do lançamento do mês atual são
// criados os das parcelas futuras — um por mês, mesma descrição com o nº da
// parcela, mesmo valor/categoria/conta, agrupados por sufixo "#P{token}" na
// descrição para permitir editar/excluir em bloco depois. A data avança um mês
// por parcela mantendo o dia (clamp no último dia) e respeita a virada de ano.
routerAdd(
  'POST',
  '/backend/v1/import/pdf/confirm',
  (e) => {
    const userId = e.auth && e.auth.id
    if (!userId) return e.unauthorizedError('Autenticação necessária')

    const body = e.requestInfo().body || {}
    const accountId = typeof body.account_id === 'string' ? body.account_id.trim() : ''
    const incoming = Array.isArray(body.items)
      ? body.items
      : Array.isArray(body.transactions)
        ? body.transactions
        : []

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
    // (let: o catch abaixo NÃO pode reatribuir um const — quebraria o handler.)
    let categoriesById = {}
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

    const MAX_INSTALLMENTS = 48
    const dateRe = /^\d{4}-\d{2}-\d{2}$/
    const prepared = []
    for (let i = 0; i < incoming.length; i++) {
      const item = incoming[i] || {}
      const description = String(item.description || '').trim()
      const amount = Number(item.amount)
      const type = item.type === 'receita' ? 'receita' : 'despesa'
      const date = String(item.date || '').trim()
      let categoryId = String(item.category_id || '').trim()
      const instCurrent = Number(item.installment_current) || 0
      const instTotal = Number(item.installment_total) || 0
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
      if (instCurrent > 0 || instTotal > 0) {
        if (!dateRe.test(date) || instCurrent < 1 || instTotal < 2) {
          return e.badRequestError(
            'Parcelamento inválido em "' +
              description.slice(0, 60) +
              '": confira nº e total de parcelas.',
          )
        }
        if (instCurrent > instTotal || instTotal > MAX_INSTALLMENTS) {
          return e.badRequestError(
            'Parcelamento inválido em "' +
              description.slice(0, 60) +
              '": o nº da parcela não pode passar do total (máx. ' +
              MAX_INSTALLMENTS +
              ').',
          )
        }
      }
      prepared.push({
        description: description.slice(0, 200),
        amount: Math.round(amount * 100) / 100,
        type: type,
        date: date,
        category_id: categoryId,
        inst_current: instCurrent > 0 ? instCurrent : 0,
        inst_total: instCurrent > 0 ? instTotal : 0,
      })
    }

    // Soma meses a uma data AAAA-MM-DD mantendo o dia (clamp no último dia do
    // mês de destino) — respeita a virada de ano (dez/2025 + 1 = jan/2026).
    function addMonths(ymd, count) {
      const parts = ymd.slice(0, 10).split('-')
      const year = Number(parts[0])
      const month = Number(parts[1])
      const day = Number(parts[2])
      if (!year || !month || !day) return ymd
      const absolute = year * 12 + (month - 1) + count
      const nextYear = Math.floor(absolute / 12)
      const nextMonth = (absolute % 12) + 1
      const lastDay = new Date(Date.UTC(nextYear, nextMonth, 0)).getUTCDate()
      const nextDay = Math.min(day, lastDay)
      const pad = function (n) {
        return n < 10 ? '0' + n : String(n)
      }
      return nextYear + '-' + pad(nextMonth) + '-' + pad(nextDay)
    }

    // Substitui o nº da parcela na descrição: mantém o padrão original
    // ("LOJA - 3/6" → "LOJA - 4/6") e remove o que já existia antes de anexar.
    function withInstallmentNumber(description, current, total) {
      const cleaned = description.replace(/\s*\d{1,2}\s*\/\s*\d{1,2}/g, ' ')
      return (cleaned.replace(/\s{2,}/g, ' ').trim() + ' ' + current + '/' + total).trim()
    }

    let createdCount = 0
    let futureCount = 0
    $app.runInTransaction((txApp) => {
      const collection = txApp.findCollectionByNameOrId('transactions')
      for (let i = 0; i < prepared.length; i++) {
        const item = prepared[i]

        const createRecord = function (description, date, note) {
          const record = new Record(collection)
          record.set('user', userId)
          record.set('account', accountId)
          record.set('description', description)
          record.set('amount', item.amount)
          record.set('type', item.type)
          record.set('date', date + ' 12:00:00.000Z')
          record.set('category', item.category_id)
          record.set('notes', note)
          txApp.save(record)
          createdCount++
        }

        if (!item.inst_total) {
          createRecord(item.description, item.date, 'Importado por PDF')
          continue
        }

        // Parcelada: token de agrupamento compartilhado entre todas as parcelas
        // (edita/exclui em bloco depois a partir de qualquer uma delas).
        let token = ''
        const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789'
        for (let c = 0; c < 10; c++) {
          token += alphabet.charAt(Math.floor(Math.random() * alphabet.length))
        }
        const suffix = ' #P' + token
        const note = 'Importado por PDF — parcela ' + item.inst_current + '/' + item.inst_total
        createRecord(
          withInstallmentNumber(item.description, item.inst_current, item.inst_total) + suffix,
          item.date,
          note,
        )
        for (let n = item.inst_current + 1; n <= item.inst_total; n++) {
          createRecord(
            withInstallmentNumber(item.description, n, item.inst_total) + suffix,
            addMonths(item.date, n - item.inst_current),
            'Importado por PDF — parcela ' + n + '/' + item.inst_total,
          )
          futureCount++
        }
      }
    })

    return e.json(200, { created: createdCount, future_created: futureCount })
  },
  $apis.requireAuth(),
)
