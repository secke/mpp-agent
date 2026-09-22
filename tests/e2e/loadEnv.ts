import { existsSync, readFileSync } from 'node:fs'

/**
 * Charge `.env` dans `process.env` pour les tests e2e.
 *
 * Vitest n'applique pas `--env-file` de Node. On fait donc la lecture ici,
 * uniquement pour les tests e2e — les tests unitaires n'ont besoin d'aucun
 * secret et ne doivent pas dépendre d'un fichier local.
 */
export function loadDotEnv(path = '.env'): void {
  if (!existsSync(path)) return
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq <= 0) continue
    const key = trimmed.slice(0, eq).trim()
    if (process.env[key] === undefined) process.env[key] = trimmed.slice(eq + 1).trim()
  }
}
