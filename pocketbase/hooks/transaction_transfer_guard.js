// Guard de transferências: transferência é UM lançamento type='transferencia'
// com destination_account. Criação/edição SÓ pelas rotas dedicadas em
// transaction_transfer.js — escrita direta de transferencia na coleção
// transactions (API de registros) é bloqueada aqui.
//
// v0.0.14: correção do warning "served hooks can finish without calling
// e.next()". Regra da JSVM: um handler de request-hook DEVE chamar e.next()
// exatamente uma vez em TODOS os caminhos — bloquear = lançar o erro ANTES do
// e.next() (isso interrompe a cadeia e a escrita não acontece; chamar e.next()
// e depois lançar gravaria o registro e ainda emitiria o warning).
onRecordCreateRequest((e) => {
  const record = e.record
  if (record && record.getString('type') === 'transferencia') {
    throw new BadRequestError(
      'Transferências são criadas apenas pela rota dedicada de transferência.',
    )
  }
  e.next()
}, 'transactions')

onRecordUpdateRequest((e) => {
  const record = e.record
  if (record && record.getString('type') === 'transferencia') {
    throw new BadRequestError(
      'Transferências são editadas apenas pela rota dedicada de transferência.',
    )
  }
  e.next()
}, 'transactions')

onRecordDeleteRequest((e) => {
  const record = e.record
  if (record && record.getString('type') === 'transferencia') {
    throw new BadRequestError(
      'Transferências são excluídas apenas pela rota dedicada de transferência.',
    )
  }
  e.next()
}, 'transactions')
