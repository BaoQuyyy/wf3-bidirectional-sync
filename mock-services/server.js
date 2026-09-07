/**
 * Stand-ins for the two systems being kept in sync, plus the sync state the
 * pipeline owns.
 *
 *   /systems/:system/records/:id   the CRM and the spreadsheet. A PUT here is
 *                                  "a human edited this record".
 *   /sync/base/:id                 field values as of the last successful sync,
 *                                  the BASE for three-way merge.
 *   /reconcile                     read-only drift report across both systems.
 *
 * Zero dependencies: node:http + node:sqlite.
 */
import { createServer } from 'node:http'
import * as store from './db.js'

const PORT = Number(process.env.PORT ?? 4200)

const json = (res, status, body, headers = {}) => {
  const payload = JSON.stringify(body, null, 2)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    ...headers
  })
  res.end(payload)
}

const readBody = (req) =>
  new Promise((resolve, reject) => {
    let raw = ''
    req.on('data', (c) => {
      raw += c
      if (raw.length > 1_000_000) {
        reject(new Error('payload too large'))
        req.destroy()
      }
    })
    req.on('end', () => {
      if (!raw) return resolve({})
      try {
        resolve(JSON.parse(raw))
      } catch {
        reject(new Error('body is not valid JSON'))
      }
    })
    req.on('error', reject)
  })

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`)
  const path = url.pathname
  const method = req.method

  try {
    const body = method === 'POST' || method === 'PUT' ? await readBody(req) : undefined

    // --- one record in one system -----------------------------------------
    const recordMatch = path.match(/^\/systems\/([a-z]+)\/records\/([\w-]+)$/)
    if (recordMatch) {
      const [, system, recordId] = recordMatch
      if (!store.SYSTEMS.includes(system)) {
        return json(res, 404, { error: 'unknown_system', system })
      }

      if (method === 'GET') {
        const fields = store.getRecord(system, recordId)
        return fields
          ? json(res, 200, { system, record_id: recordId, fields })
          : json(res, 404, { error: 'not_found', system, record_id: recordId })
      }

      if (method === 'PUT') {
        if (!body?.fields || typeof body.fields !== 'object') {
          return json(res, 400, { error: 'fields object is required' })
        }
        const fields = store.writeRecord(system, recordId, body.fields, body.touched_at)
        return json(res, 200, { system, record_id: recordId, fields })
      }
    }

    // --- everything else ---------------------------------------------------
    const key = `${method} ${path}`

    if (key.startsWith('GET /systems/') && path.endsWith('/records')) {
      const system = path.split('/')[2]
      return json(res, 200, store.listRecords(system))
    }

    const baseMatch = path.match(/^\/sync\/base\/([\w-]+)$/)
    if (baseMatch) {
      const recordId = baseMatch[1]
      if (method === 'GET') {
        const base = store.getBase(recordId)
        return json(res, 200, { record_id: recordId, exists: base !== null, fields: base })
      }
      if (method === 'PUT') {
        if (!body?.fields) return json(res, 400, { error: 'fields is required' })
        return json(res, 200, store.putBase(recordId, body.fields))
      }
    }

    switch (key) {
      case 'GET /sync/record-ids':
        return json(res, 200, store.allRecordIds())

      case 'POST /conflicts':
        if (!body?.record_id || !body?.field) {
          return json(res, 400, { error: 'record_id and field are required' })
        }
        store.recordConflict({
          recordId: body.record_id,
          field: body.field,
          valueA: body.value_crm,
          valueB: body.value_sheet,
          winner: body.winner ?? 'unknown',
          reason: body.reason ?? 'unspecified'
        })
        return json(res, 201, { ok: true })

      case 'GET /conflicts':
        return json(res, 200, store.listConflicts())

      case 'POST /audit':
        if (!body?.action) return json(res, 400, { error: 'action is required' })
        store.audit({
          recordId: body.record_id ?? null,
          action: body.action,
          detail: typeof body.detail === 'string' ? body.detail : JSON.stringify(body.detail ?? null)
        })
        return json(res, 201, { ok: true })

      case 'GET /audit':
        return json(res, 200, store.listAudit())

      case 'POST /alerts':
        store.insertAlert({ severity: body?.severity ?? 'warning', text: body?.text ?? '(no text)' })
        return json(res, 201, { ok: true })

      case 'GET /alerts':
        return json(res, 200, store.listAlerts())

      case 'GET /reconcile':
        return json(res, 200, store.reconcile())

      case 'POST /admin/reset':
        store.resetAll()
        return json(res, 200, { ok: true, stats: store.stats() })

      case 'GET /admin/stats':
        return json(res, 200, store.stats())

      case 'GET /health':
        return json(res, 200, { ok: true })
    }

    return json(res, 404, { error: 'not_found', path: key })
  } catch (err) {
    console.error(`[error] ${method} ${path}:`, err.message)
    return json(res, 400, { error: 'bad_request', message: err.message })
  }
})

server.listen(PORT, () => {
  console.log(`wf3 mock services listening on http://localhost:${PORT}`)
  console.log(`  drift report:  GET /reconcile`)
  console.log(`  conflicts:     GET /conflicts`)
})
