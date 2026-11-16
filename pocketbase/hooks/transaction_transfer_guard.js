// Proteção dos lançamentos do tipo 'transferencia' contra escrita pelas rotas
// padrão da coleção. O saldo da conta de destino depende do campo
// destination_account: se um create/update padrão gravar uma transferência sem
// esse campo, o valor sai da origem e nunca entra no destino.
// REGRA DO JSVM: todo o código fica INLINE dentro de cada callback —
// nenhuma função ou variável top-level é referenciada dentro de callbacks.

// IMPORTANTE: todo caminho que não lança erro DEVE chamar e.next() — sem isso
// o PocketBase pula a escrita e o cliente fica sem resposta (bug visto em logs:
// "served hooks can finish without calling e.next()").

onRecordCreateRequest((e) => {
  const record = e.record
  if (!record || record.collection().name !== 'transactions') {
    return e.next()
  }
  const type = record.getString('type')
  if (type !== 'transferencia') {
    return e.next()
  }
  const destination = record.getString('destination_account')
  const account = record.getString('account')
  if (!destination || destination === account) {
    throw new BadRequestError(
      'Transferência deve ser criada com conta de origem e destino válidas.',
    )
  }
  try {
    const destinationAccount = $app.findRecordById('accounts', destination)
    if (destinationAccount.getString('user') !== record.getString('user')) {
      throw new ForbiddenError('Conta de destino inválida.')
    }
  } catch (error) {
    if (error && typeof error.message === 'string' && error.status) {
      throw error
    }
    throw new BadRequestError('Conta de destino não encontrada.')
  }
  return e.next()
}, 'transactions')

onRecordUpdateRequest((e) => {
  const record = e.record
  if (!record || record.collection().name !== 'transactions') {
    return e.next()
  }
  const type = record.getString('type')
  const wasTransfer = record.original().getString('type') === 'transferencia'
  if (type !== 'transferencia') {
    // Impede que um lançamento comum seja convertido em transferência pelas
    // rotas padrão (sem o campo de destino obrigatório).
    if (!wasTransfer && record.getString('destination_account')) {
      throw new BadRequestError('Use a edição da transferência para alterar a conta de destino.')
    }
    return e.next()
  }
  const destination = record.getString('destination_account')
  const account = record.getString('account')
  if (!destination || destination === account) {
    throw new BadRequestError('Transferência deve ter conta de origem e destino válidas.')
  }
  try {
    const destinationAccount = $app.findRecordById('accounts', destination)
    if (destinationAccount.getString('user') !== record.getString('user')) {
      throw new ForbiddenError('Conta de destino inválida.')
    }
  } catch (error) {
    if (error && typeof error.message === 'string' && error.status) {
      throw error
    }
    throw new BadRequestError('Conta de destino não encontrada.')
  }
  return e.next()
}, 'transactions')
