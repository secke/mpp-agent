/**
 * Second service vendu : analyse d'un texte fourni dans le corps de la requête.
 *
 * Son intérêt en phase 8 n'est pas l'analyse elle-même — elle est
 * délibérément triviale — mais le fait qu'elle **prenne un corps**, ce qui
 * permet d'exercer la liaison du corps au Challenge (voir server/app.ts).
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
