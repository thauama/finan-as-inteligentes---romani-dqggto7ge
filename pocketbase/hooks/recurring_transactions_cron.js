// Cron diário para geração automática de lançamentos recorrentes
// Executa todo dia às 12:00 UTC (09:00 no fuso de Brasília).
//
// Estratégia (v0.0.34): além do lançamento do mês de vencimento atual, o cron gera
// antecipadamente os lançamentos dos ~12 meses seguintes de cada recorrência, para que
// a previsão do mês seguinte no Dashboard/Metas já contabilize despesas e receitas.
// O mês de vencimento de cada ocorrência respeita interval_months (1=mensal,
// 2=bimestral, 3=trimestral, 6=semestral, 12=anual; 0/vazio = mensal).
// Idempotente: se já existe lançamento da mesma recorrência (mesma categoria, conta,
// descrição) no mesmo mês, não duplica — rodar 2x não cria nada.
//
// IMPORTANTE (JSVM do PocketBase): TODA a lógica vive DENTRO do corpo de cada callback.
// Funções/constantes top-level NÃO são visíveis dentro dos callbacks (Hook scoping error).

cronAdd('recurring-transactions-daily', '0 12 * * *', () => {
  const now = new Date()
  // Data de Brasília (America/Sao_Paulo: UTC-3)
  const brtTime = new Date(now.getTime() - 3 * 60 * 60 * 1000)

  console.log(
    '[cron:recurring-transactions-daily] Iniciando processamento para data: ' +
      brtTime.toISOString().slice(0, 10),
  )

  let recurrings = []
  try {
    recurrings = $app.findRecordsByFilter(
      'recurring_transactions',
      'active = true',
      'created',
      1000,
      0,
    )
  } catch (err) {
    console.log('[cron:recurring-transactions-daily] Erro ao listar recorrências: ' + err.message)
    return
  }

  // ---- Processamento (inline) ----
  const todayYMD = brtTime.toISOString().slice(0, 10)
  const currentYear = brtTime.getUTCFullYear()
  const currentMonthIdx = brtTime.getUTCMonth()
  const currentAbsMonth = currentYear * 12 + currentMonthIdx
  const FORWARD_MONTHS = 12

  const pad = (n) => String(n).padStart(2, '0')

  // Dia efetivo de vencimento num mês (clampa para o último dia do mês)
  const effectiveDayFor = (year, monthIdx, day) => {
    const daysInMonth = new Date(Date.UTC(year, monthIdx + 1, 0)).getUTCDate()
    return Math.min(day, daysInMonth)
  }

  // Existe lançamento desta recorrência neste mês (dedup idempotente)?
  const hasTxInMonth = (userId, categoryId, accountId, description, year, monthIdx) => {
    const safeDesc = description.replace(/'/g, "\\'")
    const monthStart = year + '-' + pad(monthIdx + 1) + '-01'
    const nextMonthIdx = monthIdx + 1
    const nextYear = nextMonthIdx > 11 ? year + 1 : year
    const monthEnd = nextYear + '-' + pad((nextMonthIdx % 12) + 1) + '-01'
    const existing = $app.findRecordsByFilter(
      'transactions',
      "user = '" +
        userId +
        "' && category = '" +
        categoryId +
        "' && account = '" +
        accountId +
        "' && date >= '" +
        monthStart +
        " 00:00:00.000Z' && date < '" +
        monthEnd +
        " 00:00:00.000Z' && description = '" +
        safeDesc +
        "'",
      '',
      1,
      0,
    )
    return existing.length > 0
  }

  const createTx = (userId, description, amount, txType, categoryId, accountId, dueYMD) => {
    const txCol = $app.findCollectionByNameOrId('transactions')
    const txRecord = new Record(txCol)
    txRecord.set('user', userId)
    txRecord.set('description', description)
    txRecord.set('amount', amount)
    txRecord.set('type', txType)
    txRecord.set('date', dueYMD + ' 12:00:00.000Z')
    txRecord.set('category', categoryId)
    txRecord.set('account', accountId)
    txRecord.set('notes', 'Lançamento gerado automaticamente por recorrência')
    $app.save(txRecord)
  }

  let createdCount = 0
  let skippedCount = 0
  let errorCount = 0

  for (let i = 0; i < recurrings.length; i++) {
    const item = recurrings[i]
    const recId = item.id
    const userId = item.getString('user')

    try {
      const startDateStr = item.getString('start_date')
      const endDateStr = item.getString('end_date')
      const frequency = item.getString('frequency')
      const dayOfMonth = item.getInt('day_of_month') || 1
      const rawInterval = item.getInt('interval_months')
      const intervalMonths =
        rawInterval && rawInterval > 0
          ? rawInterval
          : frequency === 'anual'
            ? 12
            : frequency === 'semestral'
              ? 6
              : frequency === 'trimestral'
                ? 3
                : frequency === 'bimestral'
                  ? 2
                  : 1

      const startYMD = startDateStr ? startDateStr.slice(0, 10) : ''
      const endYMD = endDateStr ? endDateStr.slice(0, 10) : ''

      // Recorrência ainda não começou
      if (startYMD && todayYMD < startYMD) {
        skippedCount++
        continue
      }

      const description = item.getString('description')
      const amount = item.getFloat('amount')
      const txType = item.getString('type')
      const categoryId = item.getString('category')
      const accountId = item.getString('account')

      // Semanal/quinzenal: comportamento original (por last_run, sem geração futura)
      if (frequency === 'semanal' || frequency === 'quinzenal') {
        const lastRunStr = item.getString('last_run')
        const lastRunYMD = lastRunStr ? lastRunStr.slice(0, 10) : ''
        let shouldRunToday = false

        if (!lastRunYMD) {
          shouldRunToday = true
        } else {
          const lastDate = new Date(lastRunYMD + 'T00:00:00Z')
          const todayDate = new Date(todayYMD + 'T00:00:00Z')
          const diffDays = Math.round((todayDate.getTime() - lastDate.getTime()) / 86400000)
          shouldRunToday = diffDays >= (frequency === 'semanal' ? 7 : 14)
        }

        if (shouldRunToday) {
          if (endYMD && todayYMD > endYMD) {
            skippedCount++
          } else if (
            hasTxInMonth(userId, categoryId, accountId, description, currentYear, currentMonthIdx)
          ) {
            item.set('last_run', todayYMD + ' 12:00:00.000Z')
            $app.save(item)
            skippedCount++
          } else {
            createTx(userId, description, amount, txType, categoryId, accountId, todayYMD)
            item.set('last_run', todayYMD + ' 12:00:00.000Z')
            $app.save(item)
          }
        } else {
          skippedCount++
        }
        continue
      }

      // Frequências por intervalo de meses (mensal, bimestral, trimestral,
      // semestral, anual e qualquer interval_months > 1). As ocorrências caem
      // nos meses startAbsMonth + k*stepMonths (alinhadas ao mês de início).
      const stepMonths = Math.max(1, intervalMonths)
      const startDate = startDateStr ? new Date(startDateStr.replace(' ', 'T')) : null
      const startAbsMonth = startDate
        ? startDate.getUTCFullYear() * 12 + startDate.getUTCMonth()
        : currentAbsMonth

      // Primeira ocorrência candidata dentro do ciclo (>= mês atual)
      let k = Math.ceil((currentAbsMonth - startAbsMonth) / stepMonths)
      if (k < 0) k = 0

      // Gera do mês atual (se o ciclo cai nele) até ~12 meses à frente
      const maxOcc = k + Math.ceil(FORWARD_MONTHS / stepMonths)

      for (let occ = k; occ <= maxOcc; occ++) {
        const occAbsMonth = startAbsMonth + occ * stepMonths
        const occYear = Math.floor(occAbsMonth / 12)
        const occMonthIdx = ((occAbsMonth % 12) + 12) % 12
        const occDay = effectiveDayFor(occYear, occMonthIdx, dayOfMonth)
        const occYMD = occYear + '-' + pad(occMonthIdx + 1) + '-' + pad(occDay)

        // Limites
        if (endYMD && occYMD > endYMD) break
        if (occYMD < startYMD) continue

        // Dedup: um lançamento por recorrência/mês
        if (hasTxInMonth(userId, categoryId, accountId, description, occYear, occMonthIdx)) {
          // last_run só avança até o mês atual (futuras não marcam o ciclo)
          if (occAbsMonth <= currentAbsMonth) {
            const lastRunStr = item.getString('last_run')
            const lastRunYMD = lastRunStr ? lastRunStr.slice(0, 10) : ''
            if (!lastRunYMD || lastRunYMD < occYMD) {
              item.set('last_run', occYMD + ' 12:00:00.000Z')
              $app.save(item)
            }
          }
          skippedCount++
          continue
        }

        createTx(userId, description, amount, txType, categoryId, accountId, occYMD)

        if (occAbsMonth <= currentAbsMonth) {
          item.set('last_run', occYMD + ' 12:00:00.000Z')
          $app.save(item)
        }
      }
    } catch (itemErr) {
      errorCount++
      console.log(
        '[cron:recurring-transactions-daily] Erro na recorrência ' + recId + ': ' + itemErr.message,
      )
    }
  }

  console.log(
    '[cron:recurring-transactions-daily] Finalizado. Criados: ' +
      createdCount +
      ', Ignorados: ' +
      skippedCount +
      ', Erros: ' +
      errorCount,
  )
})

// Rota HTTP protegida para acionar manualmente o processamento de recorrências
// (mesma lógica, duplicada inline — JSVM não expõe declarações top-level aos callbacks)
routerAdd(
  'POST',
  '/backend/v1/recurring/process',
  (e) => {
    const authRecord = e.auth
    const specificUserId = authRecord ? authRecord.id : ''

    const now = new Date()
    const brtTime = new Date(now.getTime() - 3 * 60 * 60 * 1000)

    let filter = 'active = true'
    if (specificUserId) {
      filter += " && user = '" + specificUserId + "'"
    }

    const recurrings = $app.findRecordsByFilter(
      'recurring_transactions',
      filter,
      'created',
      1000,
      0,
    )

    const todayYMD = brtTime.toISOString().slice(0, 10)
    const currentYear = brtTime.getUTCFullYear()
    const currentMonthIdx = brtTime.getUTCMonth()
    const currentAbsMonth = currentYear * 12 + currentMonthIdx
    const FORWARD_MONTHS = 12

    const pad = (n) => String(n).padStart(2, '0')

    const effectiveDayFor = (year, monthIdx, day) => {
      const daysInMonth = new Date(Date.UTC(year, monthIdx + 1, 0)).getUTCDate()
      return Math.min(day, daysInMonth)
    }

    const hasTxInMonth = (userId, categoryId, accountId, description, year, monthIdx) => {
      const safeDesc = description.replace(/'/g, "\\'")
      const monthStart = year + '-' + pad(monthIdx + 1) + '-01'
      const nextMonthIdx = monthIdx + 1
      const nextYear = nextMonthIdx > 11 ? year + 1 : year
      const monthEnd = nextYear + '-' + pad((nextMonthIdx % 12) + 1) + '-01'
      const existing = $app.findRecordsByFilter(
        'transactions',
        "user = '" +
          userId +
          "' && category = '" +
          categoryId +
          "' && account = '" +
          accountId +
          "' && date >= '" +
          monthStart +
          " 00:00:00.000Z' && date < '" +
          monthEnd +
          " 00:00:00.000Z' && description = '" +
          safeDesc +
          "'",
        '',
        1,
        0,
      )
      return existing.length > 0
    }

    const createTx = (userId, description, amount, txType, categoryId, accountId, dueYMD) => {
      const txCol = $app.findCollectionByNameOrId('transactions')
      const txRecord = new Record(txCol)
      txRecord.set('user', userId)
      txRecord.set('description', description)
      txRecord.set('amount', amount)
      txRecord.set('type', txType)
      txRecord.set('date', dueYMD + ' 12:00:00.000Z')
      txRecord.set('category', categoryId)
      txRecord.set('account', accountId)
      txRecord.set('notes', 'Lançamento gerado automaticamente por recorrência')
      $app.save(txRecord)
    }

    let createdCount = 0
    let skippedCount = 0
    let errorCount = 0

    for (let i = 0; i < recurrings.length; i++) {
      const item = recurrings[i]
      const recId = item.id
      const userId = item.getString('user')

      try {
        const startDateStr = item.getString('start_date')
        const endDateStr = item.getString('end_date')
        const frequency = item.getString('frequency')
        const dayOfMonth = item.getInt('day_of_month') || 1
        const rawInterval = item.getInt('interval_months')
        const intervalMonths =
          rawInterval && rawInterval > 0
            ? rawInterval
            : frequency === 'anual'
              ? 12
              : frequency === 'semestral'
                ? 6
                : frequency === 'trimestral'
                  ? 3
                  : frequency === 'bimestral'
                    ? 2
                    : 1

        const startYMD = startDateStr ? startDateStr.slice(0, 10) : ''
        const endYMD = endDateStr ? endDateStr.slice(0, 10) : ''

        if (startYMD && todayYMD < startYMD) {
          skippedCount++
          continue
        }

        const description = item.getString('description')
        const amount = item.getFloat('amount')
        const txType = item.getString('type')
        const categoryId = item.getString('category')
        const accountId = item.getString('account')

        if (frequency === 'semanal' || frequency === 'quinzenal') {
          const lastRunStr = item.getString('last_run')
          const lastRunYMD = lastRunStr ? lastRunStr.slice(0, 10) : ''
          let shouldRunToday = false

          if (!lastRunYMD) {
            shouldRunToday = true
          } else {
            const lastDate = new Date(lastRunYMD + 'T00:00:00Z')
            const todayDate = new Date(todayYMD + 'T00:00:00Z')
            const diffDays = Math.round((todayDate.getTime() - lastDate.getTime()) / 86400000)
            shouldRunToday = diffDays >= (frequency === 'semanal' ? 7 : 14)
          }

          if (shouldRunToday) {
            if (endYMD && todayYMD > endYMD) {
              skippedCount++
            } else if (
              hasTxInMonth(userId, categoryId, accountId, description, currentYear, currentMonthIdx)
            ) {
              item.set('last_run', todayYMD + ' 12:00:00.000Z')
              $app.save(item)
              skippedCount++
            } else {
              createTx(userId, description, amount, txType, categoryId, accountId, todayYMD)
              item.set('last_run', todayYMD + ' 12:00:00.000Z')
              $app.save(item)
            }
          } else {
            skippedCount++
          }
          continue
        }

        const stepMonths = Math.max(1, intervalMonths)
        const startDate = startDateStr ? new Date(startDateStr.replace(' ', 'T')) : null
        const startAbsMonth = startDate
          ? startDate.getUTCFullYear() * 12 + startDate.getUTCMonth()
          : currentAbsMonth

        let k = Math.ceil((currentAbsMonth - startAbsMonth) / stepMonths)
        if (k < 0) k = 0

        const maxOcc = k + Math.ceil(FORWARD_MONTHS / stepMonths)

        for (let occ = k; occ <= maxOcc; occ++) {
          const occAbsMonth = startAbsMonth + occ * stepMonths
          const occYear = Math.floor(occAbsMonth / 12)
          const occMonthIdx = ((occAbsMonth % 12) + 12) % 12
          const occDay = effectiveDayFor(occYear, occMonthIdx, dayOfMonth)
          const occYMD = occYear + '-' + pad(occMonthIdx + 1) + '-' + pad(occDay)

          if (endYMD && occYMD > endYMD) break
          if (occYMD < startYMD) continue

          if (hasTxInMonth(userId, categoryId, accountId, description, occYear, occMonthIdx)) {
            if (occAbsMonth <= currentAbsMonth) {
              const lastRunStr = item.getString('last_run')
              const lastRunYMD = lastRunStr ? lastRunStr.slice(0, 10) : ''
              if (!lastRunYMD || lastRunYMD < occYMD) {
                item.set('last_run', occYMD + ' 12:00:00.000Z')
                $app.save(item)
              }
            }
            skippedCount++
            continue
          }

          createTx(userId, description, amount, txType, categoryId, accountId, occYMD)

          if (occAbsMonth <= currentAbsMonth) {
            item.set('last_run', occYMD + ' 12:00:00.000Z')
            $app.save(item)
          }
        }
      } catch (itemErr) {
        errorCount++
        console.log('[recurring:process] Erro na recorrência ' + recId + ': ' + itemErr.message)
      }
    }

    return e.json(200, {
      success: true,
      createdCount: createdCount,
      skippedCount: skippedCount,
      errorCount: errorCount,
      message: 'Processamento de recorrências executado com sucesso.',
    })
  },
  $apis.requireAuth(),
)
