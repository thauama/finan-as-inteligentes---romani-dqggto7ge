// Cron diário para geração automática de lançamentos recorrentes
// Executa todo dia às 09:00 no fuso de Brasília (UTC-3) -> 12:00 UTC
//
// Estratégia (v0.0.34): além do lançamento do mês de vencimento atual, o cron gera
// antecipadamente os lançamentos dos ~12 meses seguintes de cada recorrência, para que
// a previsão do mês seguinte no Dashboard/Metas já contabilize despesas e receitas.
// O mês de vencimento de cada ocorrência respeita interval_months (1=mensal,
// 2=bimestral, 3=trimestral, 6=semestral, 12=anual).
// Idempotente: se já existe lançamento da mesma recorrência no mesmo mês, não duplica.

const RECURRING_TX_NOTE = 'Lançamento gerado automaticamente por recorrência'
const FORWARD_MONTHS = 12 // quantos meses à frente gerar

// Gera os lançamentos de uma recorrência a partir do mês do vencimento atual.
// Compartilhado pelo cron diário e pela rota manual /backend/v1/recurring/process.
function processRecurringRecords(recurrings, brtTime) {
  const todayYMD = brtTime.toISOString().slice(0, 10) // "YYYY-MM-DD"
  const currentYear = brtTime.getUTCFullYear()
  const currentMonthIdx = brtTime.getUTCMonth() // 0-based
  const currentDayOfMonth = brtTime.getUTCDate()

  let createdCount = 0
  let skippedCount = 0
  let errorCount = 0

  const pad = (n) => String(n).padStart(2, '0')
  const monthKey = (y, mIdx) => y + '-' + pad(mIdx + 1) // "YYYY-MM"

  // Dia efetivo de vencimento num mês (clampa para o último dia do mês)
  const effectiveDayFor = (year, monthIdx, day) => {
    const daysInMonth = new Date(Date.UTC(year, monthIdx + 1, 0)).getUTCDate()
    return Math.min(day, daysInMonth)
  }

  // Existe lançamento desta recorrência neste mês (dedup)?
  const hasTxInMonth = (userId, categoryId, accountId, description, year, monthIdx) => {
    const safeDesc = description.replace(/'/g, "\\'")
    const monthStart = year + '-' + pad(monthIdx + 1) + '-01'
    const nextMonthIdx = monthIdx + 1
    const nextYear = nextMonthIdx > 11 ? year + 1 : year
    const normNextMonthIdx = nextMonthIdx % 12
    const monthEnd = nextYear + '-' + pad(normNextMonthIdx + 1) + '-01'
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

  const createTx = (userId, item, description, amount, txType, categoryId, accountId, dueYMD) => {
    const txCol = $app.findCollectionByNameOrId('transactions')
    const txRecord = new Record(txCol)
    txRecord.set('user', userId)
    txRecord.set('description', description)
    txRecord.set('amount', amount)
    txRecord.set('type', txType)
    txRecord.set('date', dueYMD + ' 12:00:00.000Z')
    txRecord.set('category', categoryId)
    txRecord.set('account', accountId)
    txRecord.set('notes', RECURRING_TX_NOTE)
    $app.save(txRecord)
    createdCount++
  }

  // Mês do próximo vencimento (0-based, absoluto) para frequências por intervalo de meses
  const nextDueMonth = (startMonthIdx, startYear, intervalMonths, currentAbsMonth) => {
    const interval = Math.max(1, intervalMonths || 1)
    // Alinha ao ciclo iniciado em start (startAbsMonth + k*interval)
    const startAbsMonth = startYear * 12 + startMonthIdx
    const diff = currentAbsMonth - startAbsMonth
    let k = Math.ceil(diff / interval)
    if (k < 1) k = 1 // a primeira ocorrência futura é no ciclo seguinte ou atual
    return startAbsMonth + k * interval
  }

  for (let i = 0; i < recurrings.length; i++) {
    const item = recurrings[i]
    const recId = item.id
    const userId = item.getString('user')

    try {
      const startDateStr = item.getString('start_date')
      const endDateStr = item.getString('end_date')
      const frequency = item.getString('frequency')
      const dayOfMonth = item.getInt('day_of_month') || 1
      const intervalMonths = Math.max(1, item.getInt('interval_months') || 1)

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

      const startDate = startDateStr ? new Date(startDateStr.replace(' ', 'T')) : null
      const startMonthIdx = startDate ? startDate.getUTCMonth() : currentMonthIdx
      const startYear = startDate ? startDate.getUTCFullYear() : currentYear

      // Semanal/quinzenal: mantém comportamento original (por last_run, sem geração futura)
      if (frequency === 'semanal' || frequency === 'quinzenal') {
        const lastRunStr = item.getString('last_run')
        const lastRunYMD = lastRunStr ? lastRunStr.slice(0, 10) : ''
        let shouldRunToday = false

        if (!lastRunYMD) {
          shouldRunToday = true
        } else {
          const lastDate = new Date(lastRunYMD + 'T00:00:00Z')
          const todayDate = new Date(todayYMD + 'T00:00:00Z')
          const diffDays = Math.round(
            (todayDate.getTime() - lastDate.getTime()) / (1000 * 60 * 60 * 24),
          )
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
            createTx(userId, item, description, amount, txType, categoryId, accountId, todayYMD)
            item.set('last_run', todayYMD + ' 12:00:00.000Z')
            $app.save(item)
          }
        } else {
          skippedCount++
        }
        continue
      }

      // Frequências mensais/por intervalo (mensal, bimestral, trimestral, semestral, anual)
      const currentAbsMonth = currentYear * 12 + currentMonthIdx
      const startAbsMonth = startYear * 12 + startMonthIdx

      const isIntervalFreq =
        frequency === 'mensal' ||
        frequency === 'anual' ||
        frequency === 'bimestral' ||
        frequency === 'trimestral' ||
        frequency === 'semestral' ||
        intervalMonths > 1

      if (!isIntervalFreq) {
        skippedCount++
        continue
      }

      // Intervalo em meses conforme a frequência (interval_months prevalece quando > 1)
      let stepMonths = 1
      if (intervalMonths > 1) {
        stepMonths = intervalMonths
      } else if (frequency === 'anual') {
        stepMonths = 12
      } else if (frequency === 'bimestral') {
        stepMonths = 2
      } else if (frequency === 'trimestral') {
        stepMonths = 3
      } else if (frequency === 'semestral') {
        stepMonths = 6
      }

      // Ocorrências previstas: do ciclo atual (se o dia já passou) até +FORWARD_MONTHS meses.
      // Cada ocorrência cai em startAbsMonth + k*stepMonths (alinhada ao mês de início).
      let k = 0
      // primeira ocorrência candidata >= mês atual
      const diff = currentAbsMonth - startAbsMonth
      if (diff > 0) {
        k = Math.ceil(diff / stepMonths)
      }

      for (let occ = k; occ <= k + Math.ceil(FORWARD_MONTHS / stepMonths); occ++) {
        const occAbsMonth = startAbsMonth + occ * stepMonths
        const occYear = Math.floor(occAbsMonth / 12)
        const occMonthIdx = ((occAbsMonth % 12) + 12) % 12
        const occDay = effectiveDayFor(occYear, occMonthIdx, dayOfMonth)
        const occYMD = occYear + '-' + pad(occMonthIdx + 1) + '-' + pad(occDay)

        // Limites
        if (endYMD && occYMD > endYMD) break
        if (occYMD < startYMD) continue

        // Não gerar ocorrências passadas (antes do mês atual)
        if (occAbsMonth < currentAbsMonth) continue

        // Dedup: um lançamento por recorrência/mês
        if (hasTxInMonth(userId, categoryId, accountId, description, occYear, occMonthIdx)) {
          // mantém last_run atualizado para o vencimento mais recente já coberto
          const lastRunStr = item.getString('last_run')
          const lastRunYMD = lastRunStr ? lastRunStr.slice(0, 10) : ''
          if (!lastRunYMD || lastRunYMD < occYMD) {
            const pastOrCurrent = occAbsMonth <= currentAbsMonth
            if (pastOrCurrent) {
              item.set('last_run', occYMD + ' 12:00:00.000Z')
              $app.save(item)
            }
          }
          skippedCount++
          continue
        }

        createTx(userId, item, description, amount, txType, categoryId, accountId, occYMD)

        // last_run registra a última ocorrência até o mês atual (futuras não avançam o ciclo)
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

  return { createdCount, skippedCount, errorCount }
}

cronAdd('recurring-transactions-daily', '0 12 * * *', () => {
  const now = new Date()
  // Data e hora de Brasília (America/Sao_Paulo: UTC-3)
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

  const res = processRecurringRecords(recurrings, brtTime)

  console.log(
    '[cron:recurring-transactions-daily] Finalizado. Criados: ' +
      res.createdCount +
      ', Ignorados: ' +
      res.skippedCount +
      ', Erros: ' +
      res.errorCount,
  )
})

// Rota HTTP protegida para acionar manualmente o processamento de recorrências
// Útil para testes, QA ou para o próprio usuário forçar a sincronização de recorrências se desejar
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

    const res = processRecurringRecords(recurrings, brtTime)

    return e.json(200, {
      success: true,
      createdCount: res.createdCount,
      skippedCount: res.skippedCount,
      errorCount: res.errorCount,
      message: 'Processamento de recorrências executado com sucesso.',
    })
  },
  $apis.requireAuth(),
)
