/**
 * Builds the WF3 workflow JSON from source.
 *
 *   node workflows/build.mjs
 */
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const SERVICES_URL = process.env.WF3_SERVICES_URL ?? 'http://localhost:4200'

let idCounter = 0
const nid = (name) => `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${++idCounter}`

const node = (name, type, typeVersion, parameters, position, extra = {}) => ({
  parameters, id: nid(name), name, type, typeVersion, position, ...extra
})

const code = (name, jsCode, position) =>
  node(name, 'n8n-nodes-base.code', 2, { jsCode }, position)

const respond = (name, statusCode, body, position) =>
  node(name, 'n8n-nodes-base.respondToWebhook', 1.1, {
    respondWith: 'json',
    responseBody: body,
    options: { responseCode: statusCode }
  }, position)

const ifTrue = (name, expression, position) =>
  node(name, 'n8n-nodes-base.if', 2.2, {
    conditions: {
      options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
      conditions: [{
        id: nid('cond'),
        leftValue: expression,
        rightValue: '',
        operator: { type: 'boolean', operation: 'true', singleValue: true }
      }],
      combinator: 'and'
    },
    options: {}
  }, position)

const postJson = (name, path, bodyExpression, position) =>
  node(name, 'n8n-nodes-base.httpRequest', 4.2, {
    method: 'POST',
    url: `${SERVICES_URL}${path}`,
    sendBody: true,
    specifyBody: 'json',
    jsonBody: bodyExpression,
    options: {}
  }, position)

const connect = (c, from, to, outputIndex = 0) => {
  c[from] ??= { main: [] }
  while (c[from].main.length <= outputIndex) c[from].main.push([])
  c[from].main[outputIndex].push({ node: to, type: 'main', index: 0 })
}

// ---------------------------------------------------------------------------

const MERGE_JS = `
// ---------------------------------------------------------------------------
// Three-way field-level merge between the two systems.
//
// The event only says WHICH record changed, never which side changed it. That
// is deliberate: trusting the reported origin means trusting whichever system
// fired the webhook, and the two can disagree. Reading both sides and diffing
// against the base is authoritative regardless of who claims what.
//
// The BASE - field values as of the last successful sync - is what makes this
// a merge instead of a guess. Without it you can only see THAT the sides
// differ; with it you can see WHICH side moved, and a field only one side
// touched needs no decision at all.
//
// This is also where echo suppression comes from, for free: after a sync the
// base equals both sides, so the write we just made produces a change event
// where nothing differs from base, and the run stops. No origin markers, no
// "ignore my own writes" flags - the ones that leak and cause infinite loops
// the moment a write is retried.
// ---------------------------------------------------------------------------
const SERVICES_URL = ${JSON.stringify(SERVICES_URL)};

const raw = $input.first().json;
const body = raw.body ?? raw;
const recordId = typeof body.record_id === 'string' ? body.record_id.trim() : '';

if (!recordId) {
  return [{ json: { valid: false, errors: ['record_id must be a non-empty string'] } }];
}

// returnFullResponse is required here: the merge branches on statusCode to
// tell "record absent" from "record present but empty", and without it the
// helper resolves to the body alone, statusCode is undefined, and every
// record silently looks empty.
const http = (opts) =>
  this.helpers.httpRequest({
    json: true,
    returnFullResponse: true,
    ignoreHttpStatusErrors: true,
    ...opts
  });

const [crmRes, sheetRes, baseRes] = await Promise.all([
  http({ method: 'GET', url: SERVICES_URL + '/systems/crm/records/' + recordId }),
  http({ method: 'GET', url: SERVICES_URL + '/systems/sheet/records/' + recordId }),
  http({ method: 'GET', url: SERVICES_URL + '/sync/base/' + recordId })
]);

const crm = crmRes.statusCode === 200 ? (crmRes.body.fields ?? {}) : {};
const sheet = sheetRes.statusCode === 200 ? (sheetRes.body.fields ?? {}) : {};
const base = baseRes.body?.fields ?? {};

if (crmRes.statusCode === 404 && sheetRes.statusCode === 404) {
  return [{ json: { valid: false, errors: ['record ' + recordId + ' exists in neither system'] } }];
}

const fields = new Set([...Object.keys(crm), ...Object.keys(sheet), ...Object.keys(base)]);

const toCrm = {};
const toSheet = {};
const merged = {};
const conflicts = [];

for (const field of fields) {
  const a = crm[field];
  const b = sheet[field];
  const baseValue = base[field]?.value;

  const aValue = a?.value;
  const bValue = b?.value;

  const aChanged = aValue !== baseValue;
  const bChanged = bValue !== baseValue;

  // Neither side moved since the last sync. Nothing to do - this is the echo
  // of our own previous write.
  if (!aChanged && !bChanged) {
    if (a !== undefined) merged[field] = a;
    continue;
  }

  // Only one side moved: no decision required, and record-level
  // last-write-wins would have thrown the other side's untouched field away.
  if (aChanged && !bChanged) {
    toSheet[field] = aValue;
    merged[field] = a;
    continue;
  }
  if (!aChanged && bChanged) {
    toCrm[field] = bValue;
    merged[field] = b;
    continue;
  }

  // Both moved. Identical values are convergence, not conflict.
  if (aValue === bValue) {
    merged[field] = a ?? b;
    continue;
  }

  // A genuine conflict. Resolved by the newer per-field timestamp, and
  // RECORDED either way: the losing value is about to be overwritten, and
  // someone has to be able to find out what it was.
  const aTime = a?.updated_at ?? '';
  const bTime = b?.updated_at ?? '';
  const crmWins = aTime >= bTime;

  if (crmWins) {
    toSheet[field] = aValue;
    merged[field] = a;
  } else {
    toCrm[field] = bValue;
    merged[field] = b;
  }

  conflicts.push({
    record_id: recordId,
    field,
    value_crm: aValue ?? null,
    value_sheet: bValue ?? null,
    winner: crmWins ? 'crm' : 'sheet',
    reason: 'both sides changed since base; resolved by newer per-field timestamp (' +
      (crmWins ? aTime : bTime) + ' > ' + (crmWins ? bTime : aTime) + ')'
  });
}

const hasWrites = Object.keys(toCrm).length > 0 || Object.keys(toSheet).length > 0;

// When both sides made the SAME edit there is nothing to propagate - but the
// base is now stale, and leaving it behind is not harmless: the next edit to
// that field would diff against the old base, both sides would look changed,
// and the pipeline would report a conflict that never happened. Advancing the
// base is work even when writing is not.
const baseStale = [...fields].some((f) => merged[f]?.value !== base[f]?.value);
const hasWork = hasWrites || baseStale;

return [{
  json: {
    valid: true,
    record_id: recordId,
    has_work: hasWork,
    has_writes: hasWrites,
    to_crm: toCrm,
    to_sheet: toSheet,
    conflicts,
    merged
  }
}];
`.trim()

const APPLY_JS = `
// ---------------------------------------------------------------------------
// Apply the merge: propagate each side's changes, log conflicts, then move the
// base forward.
//
// Order matters. The base is written LAST, and only after both propagations
// have returned. If the base moved first and a propagation then failed, the
// pipeline would believe the systems were in sync while they were not - and
// because the base is what detects change, that difference would never be
// noticed again. A failed propagation leaves the base behind, so the next
// event retries it.
//
// Each write carries the ORIGINATING edit's timestamp rather than "now", so
// the propagated copy does not look newer than the edit it came from and win
// every future conflict against its own source.
// ---------------------------------------------------------------------------
const SERVICES_URL = ${JSON.stringify(SERVICES_URL)};
const plan = $('Three-way merge').first().json;

const http = (opts) => this.helpers.httpRequest({ json: true, ...opts });

const written = [];

for (const [system, changes] of [['crm', plan.to_crm], ['sheet', plan.to_sheet]]) {
  if (Object.keys(changes).length === 0) continue;

  // Take the newest timestamp among the fields being written, so the copy
  // carries the edit's own time.
  const touchedAt = Object.keys(changes)
    .map((f) => plan.merged[f]?.updated_at)
    .filter(Boolean)
    .sort()
    .pop();

  await http({
    method: 'PUT',
    url: SERVICES_URL + '/systems/' + system + '/records/' + plan.record_id,
    body: { fields: changes, touched_at: touchedAt }
  });
  written.push({ system, fields: Object.keys(changes) });
}

for (const conflict of plan.conflicts) {
  await http({ method: 'POST', url: SERVICES_URL + '/conflicts', body: conflict });
}

// Base last, and only now that every propagation has succeeded.
await http({
  method: 'PUT',
  url: SERVICES_URL + '/sync/base/' + plan.record_id,
  body: { fields: plan.merged }
});

await http({
  method: 'POST',
  url: SERVICES_URL + '/audit',
  body: {
    record_id: plan.record_id,
    // Distinguished so the audit trail does not claim a propagation that never
    // happened - this run only moved the base forward.
    action: written.length > 0 ? 'propagated' : 'base_advanced',
    detail: JSON.stringify({ written, conflicts: plan.conflicts.length })
  }
});

if (plan.conflicts.length > 0) {
  await http({
    method: 'POST',
    url: SERVICES_URL + '/alerts',
    body: {
      severity: 'warning',
      text: plan.conflicts.length + ' field conflict(s) on ' + plan.record_id +
        ': ' + plan.conflicts.map((c) => c.field + ' -> ' + c.winner).join(', ')
    }
  });
}

return [{
  json: {
    record_id: plan.record_id,
    written,
    conflicts: plan.conflicts,
    conflict_count: plan.conflicts.length
  }
}];
`.trim()

const RECONCILE_JS = `
// ---------------------------------------------------------------------------
// Periodic drift detection.
//
// This REPORTS ONLY - it never repairs. A reconciliation job that silently
// fixes differences is indistinguishable from one that silently destroys
// them: the drift it "corrected" may be the only surviving copy of a real
// edit made while the sync was broken. Drift means something bypassed the
// pipeline, and that is a question for a human, not a value to overwrite.
// ---------------------------------------------------------------------------
const SERVICES_URL = ${JSON.stringify(SERVICES_URL)};
const http = (opts) => this.helpers.httpRequest({ json: true, ...opts });

const report = await http({ method: 'GET', url: SERVICES_URL + '/reconcile' });

await http({
  method: 'POST',
  url: SERVICES_URL + '/audit',
  body: {
    action: 'reconciled',
    detail: JSON.stringify({ drift_count: report.drift_count })
  }
});

if (report.drift_count > 0) {
  await http({
    method: 'POST',
    url: SERVICES_URL + '/alerts',
    body: {
      severity: 'warning',
      text: 'Reconciliation found ' + report.drift_count + ' drifted field(s): ' +
        report.drift.map((d) => d.record_id + '.' + d.field).join(', ') +
        '. Not repaired automatically - review required.'
    }
  });
}

return [{ json: report }];
`.trim()

function buildSyncWorkflow() {
  const nodes = [
    node('Webhook: record changed', 'n8n-nodes-base.webhook', 2, {
      httpMethod: 'POST', path: 'sync', responseMode: 'responseNode', options: {}
    }, [-700, 300], { webhookId: 'wf3-sync-webhook' }),

    code('Three-way merge', MERGE_JS, [-480, 300]),

    ifTrue('Resolvable?', '={{ $json.valid }}', [-260, 300]),

    respond('Respond 400: bad request', 400,
      '={{ JSON.stringify({ error: "invalid_request", details: $json.errors }) }}',
      [-40, 460]),

    ifTrue('Anything to propagate?', '={{ $json.has_work }}', [-40, 160]),

    postJson('Audit: no-op echo', '/audit',
      `={{ JSON.stringify({ record_id: $('Three-way merge').item.json.record_id, action: "noop_echo", detail: "both sides already match base; nothing propagated" }) }}`,
      [180, 300]),

    respond('Respond 200: no-op', 200,
      `={{ JSON.stringify({ status: "no_op", record_id: $('Three-way merge').item.json.record_id, note: "both sides match the last synced base - this was an echo of our own write" }) }}`,
      [400, 300]),

    code('Apply merge', APPLY_JS, [180, 60]),

    respond('Respond 200: synced', 200,
      `={{ JSON.stringify({ status: "synced", record_id: $json.record_id, written: $json.written, conflicts: $json.conflicts, conflict_count: $json.conflict_count }) }}`,
      [400, 60])
  ]

  const c = {}
  connect(c, 'Webhook: record changed', 'Three-way merge')
  connect(c, 'Three-way merge', 'Resolvable?')
  connect(c, 'Resolvable?', 'Anything to propagate?', 0)
  connect(c, 'Resolvable?', 'Respond 400: bad request', 1)
  connect(c, 'Anything to propagate?', 'Apply merge', 0)
  connect(c, 'Anything to propagate?', 'Audit: no-op echo', 1)
  connect(c, 'Audit: no-op echo', 'Respond 200: no-op')
  connect(c, 'Apply merge', 'Respond 200: synced')

  return {
    id: 'wf3BidirectSync',
    name: 'WF3 - Bidirectional sync with field-level conflict resolution',
    active: false,
    triggerCount: 1,
    nodes,
    connections: c,
    settings: { executionOrder: 'v1' },
    pinData: {}
  }
}

function buildReconcileWorkflow() {
  const nodes = [
    node('Webhook: run reconciliation', 'n8n-nodes-base.webhook', 2, {
      httpMethod: 'POST', path: 'reconcile', responseMode: 'lastNode', options: {}
    }, [-460, 300], { webhookId: 'wf3-reconcile-webhook' }),
    node('Every night', 'n8n-nodes-base.scheduleTrigger', 1.2, {
      rule: { interval: [{ field: 'hours', hoursInterval: 24 }] }
    }, [-460, 460]),
    code('Report drift', RECONCILE_JS, [-200, 380])
  ]

  const c = {}
  connect(c, 'Webhook: run reconciliation', 'Report drift')
  connect(c, 'Every night', 'Report drift')

  return {
    id: 'wf3Reconciliatn',
    name: 'WF3b - Reconciliation (reports drift, never repairs)',
    active: false,
    triggerCount: 1,
    nodes,
    connections: c,
    settings: { executionOrder: 'v1' },
    pinData: {}
  }
}

mkdirSync(HERE, { recursive: true })
for (const [file, wf] of [
  ['01-bidirectional-sync.json', buildSyncWorkflow()],
  ['02-reconciliation.json', buildReconcileWorkflow()]
]) {
  writeFileSync(join(HERE, file), JSON.stringify(wf, null, 2) + '\n', 'utf8')
  console.log(`wrote ${file} (${wf.nodes.length} nodes)`)
}
