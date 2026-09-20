/**
 * Ouverture de la base du ledger.
 *
 * `better-sqlite3` plutôt que `node:sqlite` : ce dernier n'existe qu'à partir
 * de Node 22.5, et le projet cible Node ≥ 20 (voir docs/DECISIONS.md D11).
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import Database from 'better-sqlite3'

export type LedgerDatabase = Database.Database

const SCHEMA_PATH = join(dirname(fileURLToPath(import.meta.url)), 'schema.sql')

/**
 * Ouvre (ou crée) la base et applique le schéma.
 *
 * @param path chemin du fichier, ou `:memory:` pour une base éphémère.
 */
export function openLedger(path = ':memory:'): LedgerDatabase {
  const db = new Database(path)
  // WAL n'a pas de sens en mémoire et fait échouer le pragma sur certains builds.
  if (path !== ':memory:') db.pragma('journal_mode = WAL')
  db.exec(readFileSync(SCHEMA_PATH, 'utf8').replace(/^pragma journal_mode.*$/im, ''))
  return db
}
