/**
 * End-to-end proof for the bidirectional sync pipeline.
 *
 *   node scripts/verify.mjs
 */
const SERVICES = process.env.WF3_SERVICES_URL ?? 'http://localhost:4200'
const N8N = process.env.WF3_N8N_URL ?? 'http://localhost:5678'
const SYNC = `${N8N}/webhook/sync`
const RECONCILE = `${N8N}/webhook/reconcile`

let failures = 0
let checks = 0

const green = (s) => `\x1b[32m${s}\x1b[0m`
const red = (s) => `\x1b[31m${s}\x1b[0m`
const dim = (s) => `\x1b[2m${s}\x1b[0m`
const NO_KEEPALIVE = { connection: 'close' }

function check(label, actual, expected) {
  checks++
  if (JSON.stringify(actual) === JSON.stringify(expected)) {
    console.log(`  ${green('PASS')} ${label}`)
  } else {
    failures++
    console.log(`  ${red('FAIL')} ${label}`)
    console.log(`       expected: ${JSON.stringify(expected)}`)
    console.log(`       actual:   ${JSON.stringify(actual)}`)
  }
}

const send = async (url, method, body) => {
  const res = await fetch(url, {
    method,
    headers: { 'content-type': 'application/json', ...NO_KEEPALIVE },
    body: body === undefined ? undefined : JSON.stringify(body)
  })
  const text = await res.text()
  let parsed
  try {
    parsed = text ? JSON.parse(text) : null
  } catch {
    parsed = text
  }
  return { status: res.status, body: parsed }
}

const post = (url, body) => send(url, 'POST', body ?? {})
const put = (url, body) => send(url, 'PUT', body)
const get = (url) => send(url, 'GET')

const stats = () => get(`${SERVICES}/admin/stats`).then((r) => r.body)
const section = (t) => console.log(`\n${t}`)

/** Simulate a human editing a record in one of the systems. */
const edit = (system, id, fields, touchedAt) =>
  put(`${SERVICES}/systems/${system}/records/${id}`, { fields, touched_at: touchedAt })

const sync = (id) => post(SYNC, { record_id: id })
const valueIn = async (system, id, field) => {
  const r = await get(`${SERVICES}/systems/${system}/records/${id}`)
  return r.body?.fields?.[field]?.value ?? null
}

const T = (min) => new Date(Date.UTC(2026, 0, 1, 12, min, 0)).toISOString()

async function preflight() {
  try {
    await get(`${SERVICES}/health`)
  } catch {
    console.error(red(`\nMock services unreachable at ${SERVICES}\n`))
    process.exit(2)
  }
  const probe = await post(SYNC, {})
  if (probe.status === 404) {
    console.error(red(`\nn8n answers 404 at ${SYNC} - workflow not active\n`))
    process.exit(2)
  }
}

async function main() {
  await preflight()
  await post(`${SERVICES}/admin/reset`)

  // -------------------------------------------------------------------------
  section('1. A record created in the CRM propagates to the sheet')
  await edit('crm', 'rec1', { name: 'Nguyen An', email: 'an@example.com' }, T(0))
  const first = await sync('rec1')
  check('returns 200', first.status, 200)
  check('reported as synced', first.body?.status, 'synced')
  check('name landed in the sheet', await valueIn('sheet', 'rec1', 'name'), 'Nguyen An')
  check('email landed in the sheet', await valueIn('sheet', 'rec1', 'email'), 'an@example.com')
  check('no conflicts', first.body?.conflict_count, 0)

  // -------------------------------------------------------------------------
  section('2. The write we just made does not bounce back (echo suppression)')
  const echo = await sync('rec1')
  check('returns 200', echo.status, 200)
  check('recognised as a no-op', echo.body?.status, 'no_op')
  const afterEcho = await stats()
  check('only one propagation total', afterEcho.propagations, 1)
  check('the echo was recorded as such', afterEcho.noops, 1)

  const echo2 = await sync('rec1')
  check('repeated events stay no-ops', echo2.body?.status, 'no_op')
  check('still one propagation', (await stats()).propagations, 1)

  // -------------------------------------------------------------------------
  section('3. Edits to different fields on each side both survive')
  await edit('crm', 'rec1', { name: 'Nguyen An Updated' }, T(10))
  await edit('sheet', 'rec1', { email: 'an.new@example.com' }, T(11))
  const merged = await sync('rec1')
  check('no conflict was raised', merged.body?.conflict_count, 0)
  check('the CRM name reached the sheet', await valueIn('sheet', 'rec1', 'name'), 'Nguyen An Updated')
  check('the sheet email reached the CRM', await valueIn('crm', 'rec1', 'email'), 'an.new@example.com')
  check('the CRM kept its own name', await valueIn('crm', 'rec1', 'name'), 'Nguyen An Updated')

  // -------------------------------------------------------------------------
  section('4. Same field changed on both sides is a real conflict')
  await edit('crm', 'rec1', { status: 'customer' }, T(20))
  await edit('sheet', 'rec1', { status: 'lead' }, T(25))
  const conflicted = await sync('rec1')
  check('exactly one conflict', conflicted.body?.conflict_count, 1)
  check('conflict is on status', conflicted.body?.conflicts?.[0]?.field, 'status')
  check('the newer edit won', conflicted.body?.conflicts?.[0]?.winner, 'sheet')
  check('both sides converge on the winner', await valueIn('crm', 'rec1', 'status'), 'lead')
  check('sheet holds the winner too', await valueIn('sheet', 'rec1', 'status'), 'lead')

  const conflicts = (await get(`${SERVICES}/conflicts`)).body
  check('the losing value was preserved in the log', conflicts[0]?.value_crm, 'customer')
  check('an alert was raised', (await stats()).alerts, 1)

  // -------------------------------------------------------------------------
  section('5. Identical edits on both sides are convergence, not conflict')
  await edit('crm', 'rec1', { tier: 'gold' }, T(30))
  await edit('sheet', 'rec1', { tier: 'gold' }, T(31))
  const converged = await sync('rec1')
  check('no conflict recorded', converged.body?.conflict_count, 0)
  check('conflict log did not grow', (await get(`${SERVICES}/conflicts`)).body.length, 1)

  // -------------------------------------------------------------------------
  section('6. After syncing, the two systems agree')
  const clean = await get(`${SERVICES}/reconcile`)
  check('reconciliation reports no drift', clean.body?.in_sync, true)

  // -------------------------------------------------------------------------
  section('7. Reconciliation reports out-of-band drift and repairs nothing')
  // Somebody edits the sheet directly without the pipeline ever being told.
  await edit('sheet', 'rec1', { name: 'Edited behind the sync' }, T(40))
  const drifted = await post(RECONCILE, {})
  check('drift is detected', drifted.body?.drift_count, 1)
  check('the drifted field is named', drifted.body?.drift?.[0]?.field, 'name')
  check('an alert was raised', (await stats()).alerts, 2)
  check(
    'the drifted value was NOT overwritten',
    await valueIn('sheet', 'rec1', 'name'),
    'Edited behind the sync'
  )

  // -------------------------------------------------------------------------
  section('8. A sync run then resolves the drift normally')
  const repaired = await sync('rec1')
  check('the out-of-band edit propagates', repaired.body?.status, 'synced')
  check('the CRM now matches', await valueIn('crm', 'rec1', 'name'), 'Edited behind the sync')
  check('reconciliation is clean again', (await get(`${SERVICES}/reconcile`)).body?.in_sync, true)

  // -------------------------------------------------------------------------
  section('9. An unknown record is rejected, not silently ignored')
  const missing = await sync('does_not_exist')
  check('returns 400', missing.status, 400)

  // -------------------------------------------------------------------------
  section('Audit trail')
  const audit = (await get(`${SERVICES}/audit`)).body
  console.log(dim(`       ${audit.length} audit rows`))
  for (const row of audit) {
    console.log(dim(`       ${String(row.action).padEnd(14)} ${row.record_id ?? ''}`))
  }

  console.log(
    `\n${failures === 0 ? green('ALL CHECKS PASSED') : red(`${failures} CHECK(S) FAILED`)}  (${checks - failures}/${checks})\n`
  )
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error(red(`\nverify.mjs crashed: ${err.message}`))
  if (err.cause) console.error(red(`  cause: ${err.cause.code ?? err.cause}`))
  process.exit(3)
})
