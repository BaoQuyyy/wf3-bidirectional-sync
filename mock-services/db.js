import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const DB_PATH = process.env.WF3_DB_PATH ?? join(HERE, 'data', 'sync.db')

mkdirSync(dirname(DB_PATH), { recursive: true })

const db = new DatabaseSync(DB_PATH)
db.exec('PRAGMA journal_mode = WAL')

db.exec(`
  -- Both systems live in one table keyed by (system, record_id). In production
  -- these are a CRM and a spreadsheet or database; what matters is that each
  -- side stores a per-field updated_at, because last-write-wins at record
  -- granularity throws away edits that never actually conflicted.
  CREATE TABLE IF NOT EXISTS records (
    system      TEXT NOT NULL,
    record_id   TEXT NOT NULL,
    fields_json TEXT NOT NULL,
    PRIMARY KEY (system, record_id)
  );

  -- The BASE for three-way merge: the field values as they stood at the last
  -- successful sync. Without a base you cannot tell "A changed" from
  -- "B changed" - you only see that the two sides differ, which is exactly the
  -- information that is not enough to merge safely.
  CREATE TABLE IF NOT EXISTS sync_base (
    record_id   TEXT PRIMARY KEY,
    fields_json TEXT NOT NULL,
    synced_at   TEXT NOT NULL
  );

  -- Real conflicts only: both sides changed the same field to different values
  -- since the base. Everything else merges without a decision.
  CREATE TABLE IF NOT EXISTS conflicts (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    ts         TEXT NOT NULL,
    record_id  TEXT NOT NULL,
    field      TEXT NOT NULL,
    value_a    TEXT,
    value_b    TEXT,
    winner     TEXT NOT NULL,
    reason     TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS audit (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    ts        TEXT NOT NULL,
    record_id TEXT,
    action    TEXT NOT NULL,
    detail    TEXT
  );

  CREATE TABLE IF NOT EXISTS alerts (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    ts       TEXT NOT NULL,
    severity TEXT NOT NULL,
    text     TEXT NOT NULL
  );
`)

const now = () => new Date().toISOString()
export const SYSTEMS = ['crm', 'sheet']

export function getRecord(system, recordId) {
  const row = db
    .prepare('SELECT fields_json FROM records WHERE system = ? AND record_id = ?')
    .get(system, recordId)
  return row ? JSON.parse(row.fields_json) : null
}

/**
 * Write field values into one system.
 *
 * `touchedAt` is supplied by the caller so a sync-driven write can carry the
 * ORIGINATING edit's timestamp rather than the moment of propagation. If the
 * propagation time were stamped instead, the copy would always look newer than
 * the original and would win every subsequent conflict against it.
 */
export function writeRecord(system, recordId, changes, touchedAt = now()) {
  const current = getRecord(system, recordId) ?? {}
  const next = { ...current }
  for (const [field, value] of Object.entries(changes)) {
    next[field] = { value, updated_at: touchedAt }
  }
  db.prepare(
    `INSERT INTO records (system, record_id, fields_json) VALUES (?, ?, ?)
     ON CONFLICT(system, record_id) DO UPDATE SET fields_json = excluded.fields_json`
  ).run(system, recordId, JSON.stringify(next))
  return next
}

export function listRecords(system) {
  return db
    .prepare('SELECT record_id, fields_json FROM records WHERE system = ? ORDER BY record_id')
    .all(system)
    .map((r) => ({ record_id: r.record_id, fields: JSON.parse(r.fields_json) }))
}

export function allRecordIds() {
  return db
    .prepare('SELECT DISTINCT record_id FROM records ORDER BY record_id')
    .all()
    .map((r) => r.record_id)
}

export function getBase(recordId) {
  const row = db.prepare('SELECT fields_json FROM sync_base WHERE record_id = ?').get(recordId)
  return row ? JSON.parse(row.fields_json) : null
}

export function putBase(recordId, fields) {
  db.prepare(
    `INSERT INTO sync_base (record_id, fields_json, synced_at) VALUES (?, ?, ?)
     ON CONFLICT(record_id) DO UPDATE SET fields_json = excluded.fields_json, synced_at = excluded.synced_at`
  ).run(recordId, JSON.stringify(fields), now())
  return { ok: true }
}

export function recordConflict({ recordId, field, valueA, valueB, winner, reason }) {
  db.prepare(
    `INSERT INTO conflicts (ts, record_id, field, value_a, value_b, winner, reason)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(now(), recordId, field, String(valueA), String(valueB), winner, reason)
}

export const listConflicts = () =>
  db
    .prepare('SELECT * FROM conflicts ORDER BY id')
    .all()
    // Read back under the same names the caller wrote, rather than leaking the
    // internal a/b column naming into the API.
    .map(({ value_a, value_b, ...rest }) => ({
      ...rest,
      value_crm: value_a,
      value_sheet: value_b
    }))

export function audit({ recordId = null, action, detail = null }) {
  db.prepare('INSERT INTO audit (ts, record_id, action, detail) VALUES (?, ?, ?, ?)').run(
    now(), recordId, action, detail
  )
}

export const listAudit = () => db.prepare('SELECT * FROM audit ORDER BY id').all()

export function insertAlert({ severity, text }) {
  db.prepare('INSERT INTO alerts (ts, severity, text) VALUES (?, ?, ?)').run(now(), severity, text)
}

export const listAlerts = () => db.prepare('SELECT * FROM alerts ORDER BY id').all()

/**
 * Compare the two systems field by field and report drift.
 *
 * This REPORTS ONLY. A reconciliation job that silently repairs differences is
 * indistinguishable from one that silently corrupts them: the drift it "fixed"
 * might be the only surviving copy of a real edit. Someone has to look.
 */
export function reconcile() {
  const drift = []
  for (const recordId of allRecordIds()) {
    const crm = getRecord('crm', recordId) ?? {}
    const sheet = getRecord('sheet', recordId) ?? {}
    const fields = new Set([...Object.keys(crm), ...Object.keys(sheet)])

    for (const field of fields) {
      const a = crm[field]?.value
      const b = sheet[field]?.value
      if (a !== b) {
        drift.push({
          record_id: recordId,
          field,
          crm: a ?? null,
          sheet: b ?? null,
          missing_in: a === undefined ? 'crm' : b === undefined ? 'sheet' : null
        })
      }
    }
  }
  return { in_sync: drift.length === 0, drift_count: drift.length, drift }
}

export function resetAll() {
  for (const t of ['records', 'sync_base', 'conflicts', 'audit', 'alerts']) db.exec(`DELETE FROM ${t}`)
}

export function stats() {
  const one = (sql) => db.prepare(sql).get().n
  return {
    crm_records: one("SELECT COUNT(*) n FROM records WHERE system = 'crm'"),
    sheet_records: one("SELECT COUNT(*) n FROM records WHERE system = 'sheet'"),
    synced_bases: one('SELECT COUNT(*) n FROM sync_base'),
    conflicts: one('SELECT COUNT(*) n FROM conflicts'),
    audit_rows: one('SELECT COUNT(*) n FROM audit'),
    alerts: one('SELECT COUNT(*) n FROM alerts'),
    propagations: one("SELECT COUNT(*) n FROM audit WHERE action = 'propagated'"),
    noops: one("SELECT COUNT(*) n FROM audit WHERE action = 'noop_echo'")
  }
}
