/**
 * Second service sold: analysis of a text supplied in the request body.
 *
 * Its point in phase 8 is not the analysis itself — it is deliberately
 * trivial — but the fact that it **takes a body**, which makes it possible to
 * exercise binding the body to the Challenge (see server/app.ts).
 */
export type Analysis = {
  readonly characters: number
  readonly words: number
  readonly sentences: number
}

export function analyze(text: string): Analysis {
  const trimmed = text.trim()
  return {
    characters: trimmed.length,
    words: trimmed ? trimmed.split(/\s+/).length : 0,
    sentences: trimmed ? trimmed.split(/[.!?]+\s|[.!?]+$/).filter(Boolean).length : 0,
  }
}
