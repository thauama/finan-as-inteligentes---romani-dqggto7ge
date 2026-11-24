// 0021 — Flag persistente de onboarding concluído + backfill do usuário existente.
//
// O onboarding era inferido da existência de lançamentos; quem apagava os
// lançamentos de teste voltava a cair no /onboarding. A partir daqui o sinal
// é o campo booleano `onboarding_completed` em settings, gravado pelo hook
// pocketbase/hooks/onboarding_complete.js e pelo serviço de onboarding.
//
// Backfill: qualquer usuário que JÁ POSSUA uma linha em settings já usou o app
// (as settings são criadas no primeiro uso) — marca o onboarding como completo
// e garante que o campo exista em todas as linhas. Idempotente.
migrate(
  (app) => {
    const settingsCollection = app.findCollectionByNameOrId('settings')
    const field = settingsCollection.fields.getByName('onboarding_completed')
    if (!field) {
      settingsCollection.fields.add(new Field({ name: 'onboarding_completed', type: 'bool' }))
      app.save(settingsCollection)
    }

    const records = app.findRecordsByFilter('settings', 'onboarding_completed != true', '', 0, 0)
    for (const record of records) {
      record.set('onboarding_completed', true)
      app.save(record)
    }
  },
  (app) => {
    // Down: remove o campo (os valores são descartados junto).
    const settingsCollection = app.findCollectionByNameOrId('settings')
    const field = settingsCollection.fields.getByName('onboarding_completed')
    if (field) {
      settingsCollection.fields.removeByName('onboarding_completed')
      app.save(settingsCollection)
    }
  },
)
