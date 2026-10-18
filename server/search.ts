/**
 * Service sold by the provider.
 *
 * Phase 1: fake, deterministic implementation — the point of this phase is
 * the payment flow, not the relevance of results. To be replaced by a real
 * engine later; the shape of the response, however, is stable.
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
      title: `Reference result for "${q}"`,
      url: `https://example.invalid/search?q=${encodeURIComponent(q)}`,
      snippet: `Deterministic excerpt matching "${q}".`,
    },
  ]
}
