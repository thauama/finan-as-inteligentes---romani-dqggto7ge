// Importação de fatura de cartão / extrato bancário em PDF.
// POST multipart /backend/v1/import/pdf  → extrai o texto do PDF e interpreta
// os lançamentos com a IA, sugerindo categorias existentes do usuário.
// Nada é gravado: a rota apenas DEVOLVE o rascunho para revisão no app.
//
// v0.0.11: o EOF ("Unexpected end of JSON input") do gateway não é transitório —
// acontece SEMPRE que o payload tem texto demais (a resposta é cortada no meio e
// o JSON.parse do corpo quebra). Correção: em vez de mandar tudo numa chamada,
// o texto é dividido em CHUNKS de ~8k chars (com sobreposição de 400 chars
// entre eles para não perder lançamento cortado no limite); cada chunk vira uma
// chamada de IA e os resultados são mesclados e deduplicados por
// data+descrição+valor. O parse da resposta é tolerante (JSON completo, bloco
// markdown, trecho "{"…"}", ou objeto incompleto que se conserta com "}") e,
// se um chunk falhar, os outros ainda entram no rascunho — erros reais devolvem
// {error, kind: 'ia'} com a causa concreta no `detail` (nunca uma 502 sem corpo).
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

    // PDFs grandes geram texto muito longo; linhas de tabelas de fatura podem
    // ser largas. Cap de 300 chars por linha evita linha corrompida de layout.
    const rawLines = markdown.split('\n')
    const cappedLines = []
    for (let i = 0; i < rawLines.length; i++) {
      const line = rawLines[i]
      cappedLines.push(line.length > 300 ? line.slice(0, 300) : line)
    }
    const fullText = cappedLines.join('\n')

    // ── Chunking: uma chamada de IA por pedaço de ~8k chars ──────────────────
    // PDF custa 2–3 tokens por caractere, então 8k chars ficam bem dentro do
    // orçamento do modelo `fast` e do gateway. Sobreposição de 400 chars entre
    // chunks preserva lançamentos que cairiam exatamente na fronteira.
    const CHUNK_SIZE = 8000
    const CHUNK_OVERLAP = 400

    const systemPrompt =
      'Você é um extrator de lançamentos financeiros de faturas de cartão de crédito e extratos bancários brasileiros. A partir do texto do documento, extraia TODOS os lançamentos (compras, pagamentos, tarifas, recebimentos/depósitos). Para cada lançamento devolva: date (AAAA-MM-DD, inferindo o ano quando a fatura indicar o mês/ano e para dezembro/janeiro), description (nome do estabelecimento, limpo), amount (sempre POSITIVO, em reais, número), type ("despesa" para compras/pagamentos e "receita" para recebimentos, estornos, pagamentos recebidos e créditos/refunds), e category_id (escolha SEMPRE entre os ids da lista de categorias disponíveis — a mais adequada pela descrição; se nenhuma combinar, use ""). Responda EXCLUSIVAMENTE com JSON válido, sem markdown, no formato {"transactions":[{"date":"AAAA-MM-DD","description":"...","amount":123.45,"type":"despesa","category_id":"..."}]}. Se o trecho do documento não contiver lançamentos, devolva {"transactions":[]}.'

    const buildUserPrompt = function (chunkText) {
      return (
        'Categorias disponíveis do usuário: ' +
        JSON.stringify(categoryList) +
        '\n\nTexto do documento:\n' +
        chunkText
      )
    }

    // Tolerante: aceita JSON completo, bloco markdown, trecho "{"…"}" embutido
    // ou texto incompleto (resposta cortada — completa com "}" e tenta).
    const parseTransactionsReply = function (raw) {
      let text = (raw || '').trim()
      if (!text) return null
      if (text.indexOf('```') === 0) {
        const firstLineBreak = text.indexOf('\n')
        const lastFence = text.lastIndexOf('```')
        if (lastFence > firstLineBreak) {
          text = text.slice(firstLineBreak + 1, lastFence).trim()
        }
      }
      try {
        const direct = JSON.parse(text)
        if (direct && Array.isArray(direct.transactions)) return direct
      } catch (_) {}
      const firstBrace = text.indexOf('{')
      const lastBrace = text.lastIndexOf('}')
      if (firstBrace >= 0 && lastBrace > firstBrace) {
        try {
          const sliced = JSON.parse(text.slice(firstBrace, lastBrace + 1))
          if (sliced && Array.isArray(sliced.transactions)) return sliced
        } catch (_) {}
      }
      if (firstBrace >= 0) {
        // Resposta truncada no meio do array: completa com "}" e tenta de novo.
        try {
          const repaired = JSON.parse(text.slice(firstBrace) + '}')
          if (repaired && Array.isArray(repaired.transactions)) return repaired
        } catch (_) {}
      }
      return null
    }

    const callAiForChunk = function (chunkText, attempt, chunkIndex) {
      try {
        const reply = $ai.chat({
          model: 'fast',
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: buildUserPrompt(chunkText) },
          ],
        })
        const raw = (reply.choices[0].message.content || '').trim()
        return parseTransactionsReply(raw)
      } catch (err) {
        console.log(
          'import/pdf: falha na IA (chunk ' +
            (chunkIndex + 1) +
            ', tentativa ' +
            attempt +
            ', status ' +
            ((err && err.status) || 0) +
            '): ' +
            ((err && err.message) || 'falha desconhecida'),
        )
        return null
      }
    }

    const chunks = []
    for (let start = 0; start < fullText.length; start += CHUNK_SIZE - CHUNK_OVERLAP) {
      chunks.push(fullText.slice(start, start + CHUNK_SIZE))
      if (start + CHUNK_SIZE >= fullText.length) break
    }

    // ── Extração em chunks, com dedup e merge ────────────────────────────────
    // Cada chunk é processado com até 2 tentativas; se um chunk falha nas duas,
    // os outros ainda alimentam o rascunho (falha parcial ≠ falha total).
    const seen = {}
    const merged = []
    const chunkErrors = []
    let processedChunks = 0
    for (let i = 0; i < chunks.length; i++) {
      let chunkParsed = null
      for (let attempt = 1; attempt <= 2 && !chunkParsed; attempt++) {
        chunkParsed = callAiForChunk(chunks[i], attempt, i)
      }
      if (chunkParsed) {
        processedChunks++
        for (let j = 0; j < chunkParsed.transactions.length; j++) {
          const t = chunkParsed.transactions[j] || {}
          const amount = Number(t.amount)
          const type = t.type === 'receita' ? 'receita' : 'despesa'
          const description = String(t.description || '').trim()
          let date = String(t.date || '').trim()
          let categoryId = String(t.category_id || '').trim()
          if (categoriesById[categoryId] && categoriesById[categoryId].type !== type) {
            categoryId = ''
          }
          if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) date = ''
          if (!description || !isFinite(amount) || amount <= 0 || !date) continue
          const key = date + '|' + description.toLowerCase() + '|' + Math.round(amount * 100)
          if (seen[key]) continue
          seen[key] = true
          merged.push({
            date: date,
            description: description.slice(0, 200),
            amount: Math.round(amount * 100) / 100,
            type: type,
            category_id: categoriesById[categoryId] ? categoryId : '',
            category_name: categoriesById[categoryId] ? categoriesById[categoryId].name : '',
          })
        }
      } else {
        chunkErrors.push('chunk ' + (i + 1) + ' de ' + chunks.length)
      }
    }

    console.log(
      'import/pdf: chunks=' +
        chunks.length +
        ', ok=' +
        processedChunks +
        ', lançamentos=' +
        merged.length,
    )

    if (merged.length === 0) {
      if (chunkErrors.length > 0) {
        return e.json(502, {
          error:
            'Não foi possível interpretar os lançamentos deste documento agora — o serviço de IA não respondeu para nenhum trecho do PDF. Tente novamente em instantes; se persistir, o documento pode estar com texto pouco legível.',
          kind: 'ia',
          detail: 'Falha em todos os trechos processados (' + chunkErrors.join(', ') + ')',
        })
      }
      return e.json(422, {
        error:
          'O documento foi lido, mas nenhum lançamento foi identificado. Verifique se o PDF é uma fatura de cartão ou um extrato bancário e tente outro arquivo.',
        kind: 'sem_lancamentos',
      })
    }

    if (chunkErrors.length > 0) {
      console.log('import/pdf: extração parcial — sem lançamentos em: ' + chunkErrors.join(', '))
    }

    return e.json(200, {
      draft: merged,
      truncated: truncated,
      total: merged.length,
    })
  },
  $apis.requireAuth(),
)
