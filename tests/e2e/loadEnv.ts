import { existsSync, readFileSync } from 'node:fs'

/**
 * Loads `.env` into `process.env` for the e2e tests.
 *
 * Vitest does not apply Node's `--env-file`. We therefore do the reading here,
 * for the e2e tests only — unit tests need no secret and must not depend on
 * a local file.
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
