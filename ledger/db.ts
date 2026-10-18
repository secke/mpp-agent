/**
 * Opens the ledger database.
 *
 * `better-sqlite3` rather than `node:sqlite`: the latter only exists from
 * Node 22.5, and the project targets Node ≥ 20 (see docs/DECISIONS.md D11).
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import Database from 'better-sqlite3'

export type LedgerDatabase = Database.Database

const SCHEMA_PATH = join(dirname(fileURLToPath(import.meta.url)), 'schema.sql')

/**
 * Opens (or creates) the database and applies the schema.
 *
 * @param path file path, or `:memory:` for an ephemeral database.
 */
export function openLedger(path = ':memory:'): LedgerDatabase {
  const db = new Database(path)
  // WAL makes no sense in memory and makes the pragma fail on some builds.
  if (path !== ':memory:') db.pragma('journal_mode = WAL')
  db.exec(readFileSync(SCHEMA_PATH, 'utf8').replace(/^pragma journal_mode.*$/im, ''))
  return db
}
