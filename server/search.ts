/**
 * Service vendu par le provider.
 *
 * Phase 1 : implémentation factice et déterministe — l'objet de cette phase
 * est le flux de paiement, pas la pertinence des résultats. Remplacée par un
 * vrai moteur en phase ultérieure ; la forme de la réponse, elle, est stable.
 */
export type SearchResult = {
  readonly title: string
  readonly url: string
  readonly snippet: string
}

export function search(query: string): SearchResult[] {
  const q = query.trim()
  if (!q) return []
  return [
    {
      title: `Résultat de référence pour « ${q} »`,
      url: `https://example.invalid/search?q=${encodeURIComponent(q)}`,
      snippet: `Extrait déterministe correspondant à « ${q} ».`,
    },
  ]
}
