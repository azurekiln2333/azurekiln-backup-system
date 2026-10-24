# Storage and domain-only address display

Confirmed by source inspection and the user's follow-up on 2026-10-25. Planning only; no product code changed.

## Application storage

- `server/store.mjs:1` imports Node's native `DatabaseSync`; `:31` opens `DATA_DIR/state.sqlite`; `:43` enables WAL and foreign keys. The app uses SQLite, without a separate PostgreSQL/MySQL service for its own state.
- Tables hold jobs, settings, runs, logs, admin/session information, watch baselines, sites and site-job links (`server/store.mjs:44-59`). JSON text inside several tables is a record format inside SQLite, not a separate JSON-file datastore. The site-job relation remains normalized and many-to-many.
- Local default is `.data/` (`server/config.mjs:20`). The image sets `DATA_DIR=/data` (`Dockerfile:20`); Compose persists it through `backup-data:/data` (`compose.yaml:14`). These are configured defaults, not a claim to have inspected the live server or its actual Docker volume path.
- Backup archive files are staged under the configured temporary directory and uploaded through rclone (`server/backup.mjs:124`, `:575`, `:639`). They are not SQLite blobs. The master key and running rclone configuration are separate files (`server/config.mjs:34`, `:45`), and the system archive includes the database snapshot, key and rclone config (`server/backup.mjs:243-272`).
- No datastore replacement/migration is requested by the user. Multiple repository links and remarks fit existing site JSON metadata in SQLite.

## User-confirmed address behavior

- Site title and the primary displayed access address share a row.
- Only one access address is visible in a list row, even if several are configured. Use the first saved address in input order; keep the complete array and editing controls.
- The visible address is its hostname only. For example, `https://panel.example.com:8443/admin?view=full#config` displays `panel.example.com`.
- Its link target remains the complete canonical saved URL, including port, case-sensitive path, query and fragment. Domain-only display must never rewrite the stored URL or navigation target.
- `shared/contracts.mjs:83` currently produces host/path/query/fragment labels, and `:92` exposes the safe href/label projection. Update the display projection deliberately, rather than applying inconsistent component-local substring operations; check its other consumers/tests before changing it.
- Full URL information should remain available through an accessible link label/tooltip and the editor. Handle old invalid values as readable nonlinks. Keep focus/hover treatment distinct from tag-filter chips.
- At narrow widths, keep the identity structure as one row and handle long names/hostnames without document overflow or dropping the actual href. Any necessary visual ellipsis retains the complete accessible name/tooltip. Existing linked job names and task-state information remain visible.

## User-confirmed metadata additions

- Multiple repositories are selected; the prior one-versus-many research is historical.
- Optional site remarks are requested. Use one canonical shared field (proposed `notes`, default `''`) at schema/public-view/save/editor boundaries, with bounded plain text and omitted-PATCH preservation. Do not render remarks as HTML.
