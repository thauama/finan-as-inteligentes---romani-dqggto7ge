import pb from '@/lib/pocketbase/client'
import type { Category } from '@/types/finance'

export interface CategoryImpact {
  id: string
  name: string
  type: string
  subcategories: number
  transactions: number
  bills: number
  recurrings: number
  linked_transactions: number
}

/**
 * Consulta ao backend quantos lançamentos, contas a pagar/receber,
 * recorrências e metas estão vinculados a uma categoria (incluindo
 * subcategorias) — usado no modal de impacto da exclusão.
 */
export async function getCategoryImpact(categoryId: string): Promise<CategoryImpact> {
  return pb.send<CategoryImpact>(
    `/backend/v1/categories/${encodeURIComponent(categoryId)}/impact`,
    {
      method: 'GET',
    },
  )
}

/**
 * Exclui a categoria pela rota atômica do backend.
 * - mode 'delete': exclui a categoria JUNTO com suas subcategorias e todos os
 *   lançamentos vinculados; contas a pagar/receber e recorrências são
 *   desvinculadas, e metas da categoria são excluídas.
 * - mode 'keep': só permitido quando NÃO há vínculos — mantém contas a
 *   pagar/receber e recorrências (desvinculando), e nada fica órfão.
 *
 * IMPORTANTE: o corpo vai em `body` — o SDK trata qualquer opção desconhecida
 * (ex.: `content`) como query parameter e o hook receberia o corpo vazio.
 */
export async function deleteCategoryWithCleanup(
  categoryId: string,
  mode: 'delete' | 'keep',
): Promise<void> {
  await pb.send(`/backend/v1/categories/${encodeURIComponent(categoryId)}`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: { mode },
  })
}

export type { Category }
