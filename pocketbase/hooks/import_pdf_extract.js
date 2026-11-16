// Importação de fatura de cartão / extrato bancário em PDF.
// POST multipart /backend/v1/import/pdf  → extrai o texto do PDF e interpreta
// os lançamentos com a IA, sugerindo categorias existentes do usuário.
// Nada é gravado: a rota apenas DEVOLVE o rascunho para revisão no app.
//
// v0.0.12: o EOF ("Unexpected end of JSON input") do gateway é determinístico —
//acontece quando o PAYLOAD TOTAL (system+user+resposta) passa de ~24k chars, e a
//resposta vem CORTADA no meio do JSON. Com chunk de 8k chars ainda acontecia
//(prompt de categorias + cabeçalho comem muito do orçamento). Correções:
// 1. Chunk menor (4k chars, overlap 300) e prompt compacto: categorias reduzidas
//    a "id:nome" e só o trecho de texto — payload total fica longe do limite.
// 2. Parse tolerante MAIS forte: se o JSON vier truncado no meio de um item,
//    repara fechando o item, o array e o objeto ("...}}, {"transactions":[' →
//    '{"transactions":[…]}) em vez de descartar o chunk.
// 3. SPLIT RECURSIVO (v0.0.13): chunk que falha nas 2 tentativas (EOF len=0) é
//    dividido ao meio (overlap 300) e cada metade tenta de novo, até o piso de
//    1.200 chars — o EOF é determinístico, retry simples nunca resolve.
// 4. Log por chunk/subchunk (itens brutos e aceitos) para diagnosticar cortes.
// 5. Mensagens honestas: "ok=N de M, extraído 0" ≠ "nenhum trecho respondeu".
// Chunks que respondem nunca são descartados (falha parcial ≠ total).
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
    // Compacto: "id:nome (tipo)" — economiza payload sem perder informação.
    const categoryList = Object.keys(categoriesById).map((id) => {
      const cat = categoriesById[id]
      return id + ':' + cat.name + '(' + cat.type + ')'
    })

    // PDFs grandes geram texto muito longo; linhas de tabelas de fatura podem
    // ser largas. Cap de 300 chars por linha evita linha corrompida de layout.
    const rawLines = markdown.split('\n')
    const cappedLines = []
    for (let i = 0; i < rawLines.length; i++) {
      const line = rawLines[i]
      if (line.length > 300) {
        cappedLines.push(line.slice(0, 300))
      } else {
        cappedLines.push(line)
      }
    }
    const fullText = cappedLines.join('\n')

    // ── Chunking: uma chamada de IA por pedaço de ~4k chars ──────────────────
    // PDF custa 2–3 tokens por caractere: o gateway corta a resposta quando o
    // payload TOTAL passa de ~24k chars. Com chunk de 4k + prompt compacto
    // (categorias "id:nome" + cabeçalho curto), o total fica < 10k chars e a
    // resposta tem folga para ~80 lançamentos por chunk. Overlap de 300 chars
    // preserva lançamentos cortados exatamente na fronteira.
    const CHUNK_SIZE = 4000
    const CHUNK_OVERLAP = 300

    // Prompt enxuto: instruções curtas + schema mínimo (menos chars no request,
    // menos tokens de resposta — a resposta também conta no payload do gateway).
    const systemPrompt =
      'Extraia lançamentos de fatura de cartão/extrato bancário brasileiro do texto. Regras: date = AAAA-MM-DD do documento (ajuste o ano quando dezembro/janeiro cruzarem); description = nome do estabelecimento limpo; amount = SEMPRE positivo, em reais, número (formato BR: "1.300,00" = 1300.00); type = "despesa" para compras/tarifas/parcelas, "receita" para pagamentos de fatura (valor negativo, ex. "-5.480,76"), estornos e créditos. Para transação em USD, use o "Valor R$" final. IGNORE cabeçalhos, totais ("Total R$"), saldos ("Saldo da fatura anterior"), boletos, encargos e textos explicativos — só linhas com data + valor. Responda EXCLUSIVAMENTE JSON puro, sem markdown: {"transactions":[{"date":"AAAA-MM-DD","description":"...","amount":123.45,"type":"despesa","category_id":"id ou "}]}. Se o trecho não tiver lançamentos: {"transactions":[]}.'

    const buildUserPrompt = function (chunkText) {
      return (
        'Categorias (id:nome(tipo)) — use o id da mais adequada ou "":\n' +
        categoryList.join(', ') +
        '\n\nTEXTO:\n' +
        chunkText
      )
    }

    // Tolerante: aceita JSON completo, bloco markdown, trecho "{"…"}" embutido
    // ou texto incompleto (resposta cortada) — reconstrói o estado de
    // abre/fecha de aspas, itens, array e objeto e fecha o que estiver aberto.
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
      const tryParse = function (s) {
        try {
          const parsed = JSON.parse(s)
          if (parsed && Array.isArray(parsed.transactions)) return parsed
        } catch (_) {}
        return null
      }
      let parsed = tryParse(text)
      if (parsed) return parsed
      const firstBrace = text.indexOf('{')
      if (firstBrace < 0) return null
      const sliced = text.slice(firstBrace)
      parsed = tryParse(sliced)
      if (parsed) return parsed
      // Resposta truncada: repara fechando o que estiver aberto. Caminha pelo
      // texto fora de strings, contando {, [ e " para saber o estado final.
      let inString = false
      let escape = false
      const stack = []
      for (let i = 0; i < sliced.length; i++) {
        const c = sliced.charAt(i)
        if (escape) {
          escape = false
          continue
        }
        if (c === '\\') {
          if (inString) escape = true
          continue
        }
        if (c === '"') {
          inString = !inString
          continue
        }
        if (inString) continue
        if (c === '{' || c === '[') stack.push(c)
        else if (c === '}' || c === ']') stack.pop()
      }
      let repaired = sliced
      if (inString) repaired += '"'
      // Fecha valores incompletos: um truncamento pode deixar "amount":12,3
      // ou "amount": ou "description":"abc" pendurados antes do fechamento.
      repaired = repaired.replace(/[,\s]*$/, '')
      repaired = repaired.replace(/,?\s*"[A-Za-z_]+"\s*:\s*$/, '')
      repaired = repaired.replace(/:\s*[0-9.,]*$/, function (m) {
        return m.indexOf(':') === m.length - 1 || m === '' ? '' : m
      })
      for (let i = stack.length - 1; i >= 0; i--) {
        repaired += stack[i] === '{' ? '}' : ']'
      }
      parsed = tryParse(repaired)
      if (parsed) return parsed
      // Último recurso: se o array abriu mas nada parseou, extrai itens
      // individuais (um item truncado no meio não mata o resto). Cada item é
      // um objeto sem chaves aninhadas, então /\{[^{}]*\}/g acha cada um.
      const itemRe = /\{[^{}]*\}/g
      const items = []
      let m
      while ((m = itemRe.exec(sliced)) !== null) {
        const item = tryParse('{"transactions":[' + m[0] + ']}')
        if (item && item.transactions[0]) items.push(item.transactions[0])
      }
      if (items.length > 0) return { transactions: items }
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
        const parsed = parseTransactionsReply(raw)
        if (!parsed) {
          console.log(
            'import/pdf: ' +
              chunkIndex +
              ' tentativa ' +
              attempt +
              ' devolveu resposta não-parseável (len=' +
              raw.length +
              ')',
          )
        }
        return parsed
      } catch (err) {
        console.log(
          'import/pdf: falha na IA (' +
            chunkIndex +
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

    // ── Split do texto em chunks iniciais de ~4k chars ─────────────────────────
    const initialChunks = []
    for (let start = 0; start < fullText.length; start += CHUNK_SIZE - CHUNK_OVERLAP) {
      initialChunks.push(fullText.slice(start, start + CHUNK_SIZE))
      if (start + CHUNK_SIZE >= fullText.length) break
    }

    // ── Extração com SPLIT RECURSIVO ──────────────────────────────────────────
    // O EOF do gateway é determinístico (>~24k chars no payload total): retry
    // simples NUNCA resolve. Se um chunk falha nas 2 tentativas (len=0/EOF),
    // ele é dividido ao meio (com overlap) e cada metade tenta de novo, até o
    // piso de MIN_CHUNK chars. Chunks que respondem nunca são descartados.
    const MIN_CHUNK = 1200

    const mergeTransactions = function (chunkParsed) {
      let okCount = 0
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
        okCount++
      }
      return okCount
    }

    const seen = {}
    const merged = []
    const chunkErrors = []
    let processedChunks = 0
    let okSubchunks = 0
    let totalSubchunks = 0

    const splitAndProcess = function (chunkText, depth, parentLabel) {
      totalSubchunks++
      let parsed = null
      for (let attempt = 1; attempt <= 2 && !parsed; attempt++) {
        parsed = callAiForChunk(chunkText, attempt, parentLabel)
      }
      if (parsed) {
        processedChunks++
        const okCount = mergeTransactions(parsed)
        okSubchunks++
        console.log(
          'import/pdf: ' + parentLabel + ' → itens=' + okCount + ' (profundidade ' + depth + ')',
        )
        return
      }
      const half = Math.floor(chunkText.length / 2)
      if (chunkText.length <= MIN_CHUNK || half < 1) {
        console.log(
          'import/pdf: ' + parentLabel + ' FALHOU no piso (' + chunkText.length + ' chars)',
        )
        chunkErrors.push(parentLabel)
        return
      }
      // Divide ao meio com overlap e processa cada metade recursivamente.
      const left = chunkText.slice(0, half + CHUNK_OVERLAP)
      const right = chunkText.slice(half - CHUNK_OVERLAP >= 0 ? half - CHUNK_OVERLAP : 0)
      console.log(
        'import/pdf: ' +
          parentLabel +
          ' FALHOU — dividindo ' +
          chunkText.length +
          ' chars em ' +
          left.length +
          '+' +
          right.length +
          ' (profundidade ' +
          (depth + 1) +
          ')',
      )
      splitAndProcess(left, depth + 1, parentLabel + '.a')
      splitAndProcess(right, depth + 1, parentLabel + '.b')
    }

    for (let i = 0; i < initialChunks.length; i++) {
      splitAndProcess(initialChunks[i], 0, 'chunk ' + (i + 1) + '/' + initialChunks.length)
    }

    console.log(
      'import/pdf: chunks_iniciais=' +
        initialChunks.length +
        ', subchunks=' +
        totalSubchunks +
        ', ok=' +
        okSubchunks +
        ', lançamentos=' +
        merged.length +
        ' (dedup=' +
        merged.length +
        ')',
    )

    if (merged.length === 0) {
      if (chunkErrors.length > 0 && processedChunks > 0) {
        // Alguns trechos responderam, mas nenhum lançamento veio deles.
        return e.json(502, {
          error:
            'A leitura falhou parcialmente: ' +
            okSubchunks +
            ' de ' +
            totalSubchunks +
            ' trechos foram lidos, mas nenhum lançamento foi extraído (' +
            chunkErrors.join(', ') +
            ' falharam). Tente novamente; se persistir, o documento pode ter um formato não suportado.',
          kind: 'ia',
          detail: 'Trechos lidos: ' + okSubchunks + '/' + totalSubchunks + '; extraído: 0',
        })
      }
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
      chunks_ok: okSubchunks,
      chunks_total: totalSubchunks,
    })
  },
  $apis.requireAuth(),
)
