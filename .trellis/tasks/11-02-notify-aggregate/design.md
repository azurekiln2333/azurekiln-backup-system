# Notification aggregation design

## Boundary

The current backup executor sends a completion email from `notify()` for every run. Completion delivery will instead be owned by `server/notify-batch.mjs`, with persisted run notification states as its recovery source. Existing start notifications, execution, cleanup, retention, and frontend behavior stay outside the aggregation change.

Allowed source edits are `server/backup.mjs`, necessary changes to `server/store.mjs` / `server/scheduler.mjs`, and the `settings.notification.aggregateWindowSec` field in `shared/contracts.mjs`. Tests and this task's artifacts are also owned by this task. Other agents own notification templates and server nodes; preserve their edits, including adjacent settings fields.

## Delivery and recovery

- Default aggregation window: 120 seconds; zero retains immediate per-run delivery.
- Persist eligible completion notifications as `batched` before scheduling delivery. Recover terminal `pending` and `batched` records from SQLite after startup recovery.
- Flush when no persisted run is queued/running and the last completion is outside the quiet window. A fixed 30-minute oldest-completion deadline overrides queue activity / a continuously moving quiet window.
- Serialize sends and snapshot the selected run IDs so completions arriving during SMTP remain queued for the next delivery.
- Disabled SMTP and per-job success/failure preferences retain their existing semantics. SMTP errors settle notification states independently of successful backup results, with redacted warnings/logs.
- Shutdown cancels scheduling, waits for in-flight sends, and leaves unsent records recoverable.
- Existing settings rows receive the missing aggregation default on reads without rewriting secrets or stripping concurrently added template fields.

## Rendering

Build the exact context in `11-02-notify-template/prd.md`, including disjoint success/warning/failure counts and one item per run. Call `renderNotification(template, ctx)` from the optional template module when available; otherwise use a built-in escaped default with the same summary and row fields. Pass text and HTML through SMTP with credential redaction. No edits to the template module or template settings fields.

## Validation

Use SQLite-backed tests with controlled clocks and a local SMTP sink / injected delivery. Cover aggregation, zero-window compatibility, mixed outcomes, quiet-window reset, queued/running gating, 30-minute cap, pending/batched restart recovery, concurrent sends, shutdown, redaction, and settings compatibility. Existing SMTP integration fixtures should opt into window zero when asserting immediate legacy delivery.
