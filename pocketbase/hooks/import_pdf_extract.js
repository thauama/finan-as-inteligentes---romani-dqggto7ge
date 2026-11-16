// Importação de fatura de cartão / extrato bancário em PDF.
// POST multipart /backend/v1/import/pdf  → extrai o texto do PDF e interpreta
// os lançamentos com a IA, sugerindo categorias existentes do usuário.
// Nada é gravado: a rota apenas DEVOLVE o rascunho para revisão no app.
routerAdd(
  'POST',
  '/backend/v1/import/pdf',
  (e) => {
    const userId = e.auth && e.auth.id
    if (!userId) return e.unauthorizedError('Autenticação necessária')

    const files = e.findUploadedFiles('file')
    if (!files || files.length === 0) {
      return e.badRequestError('Envie um arquivo PDF para importar.')
    }

    let markdown = ''
    let truncated = false
    try {
      const converted = $documents.toMarkdown({ file: files[0] })
      markdown = converted.markdown || ''
      truncated = Boolean(converted.truncated)
    } catch (err) {
      const status = err && err.status
      if (status === 422) {
        // PDF escaneado (sem camada de texto) ou ilegível.
        return e.json(422, {
          error:
            err.message ||
            'Não conseguimos ler o texto deste PDF. Ele parece ser uma imagem escaneada.',
          kind: 'sem_texto',
        })
      }
      if (status === 413) {
        return e.json(413, {
          error: 'O PDF é muito grande. O limite é de 10 MB — tente um arquivo menor.',
          kind: 'grande',
        })
      }
      return e.json(422, {
        error:
          'Não foi possível ler este PDF. Ele pode estar corrompido ou em um formato não suportado. Tente outro arquivo.',
        kind: 'ilegivel',
      })
    }

    if (!markdown || markdown.replace(/\s+/g, '').length < 20) {
      return e.json(422, {
        error:
          'Não encontramos texto suficiente neste PDF para extrair lançamentos. Se for um documento escaneado (imagem), tente a versão com texto selecionável.',
        kind: 'sem_texto',
      })
    }

    // Categorias existentes do usuário (para a IA sugerir dentre elas).
    const categoryRecords = $app.findRecordsByFilter(
      'categories',
      "user = '" + userId + "'",
      '',
      1000,
      0,
    )
    const categoriesById = {}
    for (let i = 0; i < categoryRecords.length; i++) {
      const rec = categoryRecords[i]
      categoriesById[rec.id] = {
        id: rec.id,
        name: rec.getString('name'),
        type: rec.getString('type'),
      }
    }
    const categoryList = Object.keys(categoriesById).map((id) => {
      const cat = categoriesById[id]
      return { id: id, nome: cat.name, tipo: cat.type }
    })

    // Texto pode ser longo (cap 10 MB de PDF): mandamos apenas o começo,
    // onde estão as transações. Limite menor evita estourar o orçamento do
    // modelo (texto de PDF custa 2-3 tokens por caractere) e o EOF do gateway.
    let textForAi = markdown.slice(0, 24000)
    const cappedLines = []
    const rawLines = textForAi.split('\n')
    for (let i = 0; i < rawLines.length; i++) {
      const line = rawLines[i]
      cappedLines.push(line.length > 300 ? line.slice(0, 300) : line)
    }
    textForAi = cappedLines.join('\n')

    const systemPrompt =
      'Você é um extrator de lançamentos financeiros de faturas de cartão de crédito e extratos bancários brasileiros. A partir do texto do documento, extraia TODOS os lançamentos (compras, pagamentos, tarifas, recebimentos/depósitos). Para cada lançamento devolva: date (AAAA-MM-DD, inferindo o ano quando a fatura indicar o mês/ano e para dezembro/janeiro), description (nome do estabelecimento, limpo), amount (sempre POSITIVO, em reais, número), type ("despesa" para compras/pagamentos e "receita" para recebimentos, estornos, pagamentos recebidos e créditos/refunds), e category_id (escolha SEMPRE entre os ids da lista de categorias disponíveis — a mais adequada pela descrição; se nenhuma combinar, use ""). Responda EXCLUSIVAMENTE com JSON válido, sem markdown, no formato {"transactions":[{"date":"AAAA-MM-DD","description":"...","amount":123.45,"type":"despesa","category_id":"..."}]}. Se o documento não contiver lançamentos, devolva {"transactions":[]}.'

    const buildUserPrompt = function () {
      return (
        'Categorias disponíveis do usuário: ' +
        JSON.stringify(categoryList) +
        '\n\nTexto do documento:\n' +
        textForAi
      )
    }

    let parsed = null
    let aiError = ''
    // Duas tentativas: EOF/5xx do gateway são transitórios. Uma tentativa só
    // falha de forma permanente quando o gateway rejeita a entrada (status 400).
    for (let attempt = 0; attempt < 2 && !parsed; attempt++) {
      try {
        const reply = $ai.chat({
          model: 'fast',
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: buildUserPrompt() },
          ],
        })
        const raw = (reply.choices[0].message.content || '').trim()
        const firstBrace = raw.indexOf('{')
        const lastBrace = raw.lastIndexOf('}')
        const candidate = JSON.parse(
          firstBrace >= 0 && lastBrace > firstBrace ? raw.slice(firstBrace, lastBrace + 1) : raw,
        )
        if (candidate && Array.isArray(candidate.transactions)) parsed = candidate
      } catch (err) {
        aiError = (err && err.message) || 'falha desconhecida'
        const status = (err && err.status) || 0
        console.log(
          'import/pdf: falha na IA (tentativa ' +
            (attempt + 1) +
            ', status ' +
            status +
            '): ' +
            aiError,
        )
        // Rejeição de entrada (texto demais, p. ex.) não melhora no retry.
        if (status === 400) break
      }
    }

    if (!parsed) {
      return e.json(502, {
        error:
          'Não foi possível interpretar os lançamentos deste documento agora. Tente novamente em instantes — se persistir, tente um PDF menor.',
        kind: 'ia',
        detail: aiError,
      })
    }

    const draft = []
    const dateRe = /^\d{4}-\d{2}-\d{2}$/
    for (let i = 0; i < parsed.transactions.length; i++) {
      const t = parsed.transactions[i] || {}
      const amount = Number(t.amount)
      const type = t.type === 'receita' ? 'receita' : 'despesa'
      const description = String(t.description || '').trim()
      let date = String(t.date || '').trim()
      let categoryId = String(t.category_id || '').trim()
      if (categoriesById[categoryId] && categoriesById[categoryId].type !== type) {
        categoryId = ''
      }
      if (!dateRe.test(date)) date = ''
      if (!description || !isFinite(amount) || amount <= 0 || !date) continue
      draft.push({
        date: date,
        description: description.slice(0, 200),
        amount: Math.round(amount * 100) / 100,
        type: type,
        category_id: categoriesById[categoryId] ? categoryId : '',
        category_name: categoriesById[categoryId] ? categoriesById[categoryId].name : '',
      })
    }

    if (draft.length === 0) {
      return e.json(422, {
        error:
          'O documento foi lido, mas nenhum lançamento foi identificado. Verifique se o PDF é uma fatura de cartão ou um extrato bancário e tente outro arquivo.',
        kind: 'sem_lancamentos',
      })
    }

    return e.json(200, {
      draft: draft,
      truncated: truncated,
      total: draft.length,
    })
  },
  $apis.requireAuth(),
)
