# WF3 — Bidirectional sync with field-level conflict resolution

Keeps a CRM and a spreadsheet in sync in both directions, without infinite
loops and without quietly destroying edits.

**Three claims, all asserted in `scripts/verify.mjs`: the pipeline never
triggers itself, an edit is never lost because the other side happened to be
touched too, and nothing is ever silently repaired.**

This is the one most no-code builds avoid. One-way sync is a morning's work;
two-way sync is where the interesting failures live.

![Workflow canvas](docs/screenshots/canvas.png)

The canvas is deliberately small. Almost all of the difficulty lives inside
the `Three-way merge` node — see the design notes below rather than the shape
of the graph.

---

## The three failures that define this problem

### 1. The echo loop

A writes to B. B fires a change event. The pipeline writes back to A. A fires a
change event. Forever.

The usual fix is an origin marker — tag your own writes and ignore them. It
leaks: the marker is lost on a retry, stripped by a system that does not store
custom fields, or missed when two events interleave. Then the loop is back,
now intermittently.

**This pipeline has no markers at all.** It keeps a *base* — the field values
as of the last successful sync — and diffs both sides against it. After a sync,
the base equals both sides, so the change event our own write produced shows
nothing changed, and the run stops. Echo suppression falls out of the data
model instead of being bolted onto it.

### 2. Record-level last-write-wins destroys edits

Someone updates the phone number in the CRM. Someone else updates the email in
the sheet. Record-level LWW keeps one record and discards the other — including
the field that was never in dispute.

Merging happens **per field**. A field only one side touched needs no decision
at all, and never produces a conflict.

### 3. A reconciliation job that "fixes" things

Drift means something bypassed the pipeline. The drifted value might be the only
surviving copy of a real edit made while the sync was broken. A job that
silently overwrites it is indistinguishable from one that silently destroys
data.

`02-reconciliation.json` **reports and alerts. It never repairs.**

---

## Design decisions

### The event says *which* record changed, never *which side* changed it

Trusting the reported origin means trusting whichever system fired the webhook,
and the two can disagree. Reading both sides and diffing against the base is
authoritative regardless of what anyone claims.

### Conflicts are resolved by per-field timestamp — and always recorded

A genuine conflict (both sides changed the same field to different values since
the base) is resolved by the newer `updated_at`. The losing value is written to
the conflict log first, with the reason, because it is about to be overwritten
and someone has to be able to find out what it was.

### Propagated writes carry the *originating* edit's timestamp

If the copy were stamped with the propagation time, it would always look newer
than the edit it came from, and would win every future conflict against its own
source.

### The base moves last

Base is written only after both propagations return. If the base moved first
and a propagation then failed, the pipeline would believe the systems were in
sync while they were not — and since the base is what detects change, that
difference would never be noticed again. A failed propagation leaves the base
behind, so the next event retries it.

### Identical edits on both sides are convergence, not conflict

Nothing is propagated — but the base still advances. Leaving it stale is not
harmless: the next edit to that field would diff against the old base, both
sides would look changed, and the pipeline would report a conflict that never
happened. The audit log calls this `base_advanced` rather than `propagated`, so
the trail does not claim a write that never occurred.

---

## Verified

`node scripts/dev.mjs` — **33/33 checks passed** on n8n 2.37.10 / Node 24.

What is asserted:

1. A record created in the CRM propagates to the sheet, no conflicts.
2. The write we just made does not bounce back; repeated events stay no-ops and
   the propagation count does not move.
3. Different fields edited on each side both survive the merge.
4. The same field edited on both sides raises exactly one conflict, the newer
   edit wins, both sides converge, and the losing value is preserved in the log.
5. Identical edits on both sides raise no conflict.
6. After syncing, reconciliation reports no drift.
7. An out-of-band edit is detected by reconciliation, alerted — and **not
   overwritten**.
8. A normal sync run then resolves that drift.
9. An unknown record is rejected with `400`, not silently ignored.

---

## Running it

Requires Node 22.5+. No dependencies.

```bash
node scripts/dev.mjs           # start everything + verify
node scripts/dev.mjs status
node scripts/dev.mjs restart
node scripts/dev.mjs stop
```

### Driving it by hand

```bash
# a human edits the CRM
curl -X PUT localhost:4200/systems/crm/records/rec1 \
  -H 'content-type: application/json' \
  -d '{"fields":{"name":"Nguyen An","email":"an@example.com"}}'

# tell the pipeline that record changed
curl -X POST localhost:5678/webhook/sync \
  -H 'content-type: application/json' -d '{"record_id":"rec1"}'

# fire it again - this is the echo, and it should be a no-op
curl -X POST localhost:5678/webhook/sync \
  -H 'content-type: application/json' -d '{"record_id":"rec1"}'

curl localhost:4200/reconcile
curl localhost:4200/conflicts
curl localhost:4200/audit
```

---

## What changes in production

| Demo | Production |
|---|---|
| Two record tables in one SQLite file | The real CRM API and Google Sheets / Postgres |
| `POST /webhook/sync` fired by hand | The systems' own change webhooks, or polling |
| `POST /alerts` sink | Slack incoming webhook |

The merge logic does not change — it only ever sees field values, timestamps
and a base. Swapping the endpoints is a URL change.

**One thing that does change:** with real systems the two reads and two writes
are not instantaneous, so a record edited *during* a sync run can be missed.
The base makes that safe rather than silent — the next change event diffs
against a base that never advanced past the lost edit, and picks it up. That is
why the base is written last.
