# Notification aggregation completed

Date: 2026-11-02
Branch: `feat/nodes-and-notify`
Status: implementation and independent review complete; left uncommitted for parent-task integration.

## Owned changes

| File | Change |
| --- | --- |
| `server/notify-batch.mjs` | New persisted notification coordinator, scheduling, rendering, delivery, recovery, and shutdown. |
| `server/backup.mjs` | Route completion notifications through the coordinator; recover after staging cleanup, stop delivery scheduling on shutdown, and send multipart text/HTML email. Start notifications remain immediate. |
| `server/store.mjs` | Settings-read normalization supplies missing notification defaults without rewriting encrypted settings or removing adjacent template fields. |
| `shared/contracts.mjs` | Only this task's `settings.notification.aggregateWindowSec` field: integer 0–86400, default 120. Adjacent template fields belong to the template task. |
| `tests/notify-batch.test.mjs` | 19 tests covering aggregation and persistence, timing, rendering, redaction, concurrency, shutdown, and real local SMTP. |
| `tests/integration.test.mjs` | Legacy SMTP fixtures explicitly select window zero; completion waiting handles both pending and batched states. |

Task-local planning/context files were populated, task status activated, and the implementation checklist completed. Concurrent node/template changes in shared files were preserved. No frontend, template-module, sibling-task, or spec files were edited by this task.

## Delivered behavior

- Eligible completed runs persist `pending -> batched -> sent`; SMTP failures settle as `failed` independently of backup success and cleanup.
- Default delivery waits until there are no queued/running runs and 120 seconds have passed since the latest completed run. A later completion resets the quiet window, including a run whose notification is disabled.
- The oldest eligible completion sets a fixed 30-minute deadline that overrides queue activity and the quiet window. Window zero delivers each run individually.
- Summaries contain total/success/warning/failure counts and one row per run with task name, type, status, elapsed seconds, archive bytes, and error/warning summary.
- Rendering calls the optional `renderNotification(template, ctx)` contract; an unavailable module uses an escaped built-in summary. Credentials are redacted before rendering and in delivered output.
- Startup recovers terminal pending/batched notifications from SQLite. Batched notifications survive task deletion. Incomplete restarted runs retain the existing interrupted/disabled behavior.
- Delivery snapshots and serialized sends prevent overlapping batches. Shutdown waits for in-flight SMTP and preserves later unsent records for restart recovery.

## Verification

- `node --test tests/notify-batch.test.mjs`: **19 passed, 0 failed**.
- `npm test`: **195 tests, 192 passed, 0 failed, 3 existing platform/tool skips**, approximately 205.5 seconds; includes real SMTP, encryption, and rclone integration.
- The final timer-only regression was added after that full-suite run and passed in the 19-test focused suite and independently during review; production code was unchanged.
- `npm run check`: passed, including independent review rerun.
- `npm run build`: passed.
- Notification backend syntax checks and scoped `git diff --check`: passed.
- Independent `trellis-check` review: no outstanding findings and no additional source edits.

## Remaining items / delivery semantics

- No unfinished items within this task's scope. Parent-task integration and commit remain with the main session as requested.
- Recovery provides at-least-once delivery: a process crash after SMTP acceptance but before persisting `sent` can resend the affected notification.
- The 30-minute maximum is fixed internally; the only new aggregation settings field is `aggregateWindowSec`.

No git commit or task archive was performed.
