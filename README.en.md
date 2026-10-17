# AzureKiln Backup

[简体中文](README.md) | [English](README.en.md) | [繁體中文](README.zh-TW.md)

AzureKiln Backup is a single-administrator backup system for directories, Vaultwarden data, and its own configuration. It uses rclone for remote storage and provides scheduled execution, encrypted archives, version retention, email notifications, execution history, and temporary-storage management. AzureKiln OAuth2/OIDC sign-in is optional.

## Capabilities

| Area | Support |
| --- | --- |
| Sources | Directories; Vaultwarden with SQLite, PostgreSQL, or MySQL/MariaDB; application configuration |
| Archives | tar.gz, AES-256-encrypted 7z or ZIP; independently configured rclone destinations |
| Operations | Manual and scheduled runs, remote verification, retention, downloads, and email notifications |
| Administration | Read-only mounted-file browser, run logs, storage usage, and local-archive cleanup |

## Requirements

Node.js 24 or later is required for local execution. Directory archives require tar; 7z and ZIP archives require 7-Zip; remote transfers require rclone. Vaultwarden SQLite snapshots use the built-in Node.js online backup API. PostgreSQL and MySQL/MariaDB require the corresponding database client. Missing tools are reported in the console; the application does not substitute simulated backups. Executable paths can be set with `RCLONE_BINARY`, `SEVEN_ZIP_BINARY`, `PG_DUMP_BINARY`, and `MYSQL_DUMP_BINARY`.

## Local deployment

```powershell
npm install
npm run dev
```

The development UI normally starts at `http://127.0.0.1:5173`, with the API on port `16323`. If a port is occupied, the development script selects an available one. Create the administrator account on first access. The default state directory is `.data/`, and the default allowed source directory is `sources/`. Set `SOURCE_ROOTS` in `.env` to authorize other paths; separate multiple roots with `;` on Windows or `:` on Linux. See `.env.example` for local configuration.

To serve the built UI from the API process:

```powershell
npm run check
npm test
npm run build
npm start
```

The default production address is `http://127.0.0.1:16323`.

## Docker deployment

Create `.env` from `.env.docker.example`. Configure a private `SETUP_TOKEN` or initial administrator credentials, set `BACKUP_PUBLIC_URL` to the deployment origin, and adjust the read-only source mounts and rclone configuration mount in `compose.yaml`.

```sh
docker compose up -d --build
```

The supplied Compose file binds the application to `127.0.0.1:16323` on the host; terminate HTTPS at a reverse proxy. The container runs as root so it can read restricted source and rclone files. No Docker socket is required. `/data` is persistent application state and must not overlap the mounted source roots under `/sources`.

Mount the directory containing an existing rclone configuration through `RCLONE_CONFIG_DIR` at `/config`, then import `/config/rclone.conf` from the Storage page. The original mount remains read-only. The application keeps a private writable copy under `/data/rclone/` so refreshed OAuth tokens can be stored without modifying the original file.

## Mounted file browser

The File Management page lists only paths allowed by `SOURCE_ROOTS` and mounted in the container. It supports breadcrumbs, parent navigation, case-insensitive name search within the current directory, 100-item pages, refresh, file size, and modification time. The browser is read-only; a directory can be selected as the source of a new backup task. Symbolic links are neither displayed nor followed.

For example, add these mounts to `compose.yaml`:

```yaml
- /www/wwwroot:/sources/websites:ro
- /srv/vaultwarden:/sources/vaultwarden:ro
```

With `SOURCE_ROOTS=/sources`, both directories are visible. To allow only those two paths, use `SOURCE_ROOTS='["/sources/websites","/sources/vaultwarden"]'`. All paths shown in the UI are container paths. After changing mounts or environment variables, recreate the service with `docker compose up -d`.

## Backup behavior

Tasks can carry up to 10 tags (for example `mysql` or `production`). The task list filters by tag, clicking a tag under a task filters by it, and search also matches tags.

When creating a directory task, tick **Batch add** to pick a parent folder instead. Its subfolders are listed; each selected one becomes its own task with otherwise identical settings. Task names come from a template in which `{folder}` is the subfolder name, and every destination uploads to `save directory/subfolder`. For a parent `/sources/mysql` holding `blog_azurekiln_cn` and `azurekiln_cn` with save directory `backups/mysql`, two tasks are created that upload to `backups/mysql/blog_azurekiln_cn` and `backups/mysql/azurekiln_cn`. Subfolders that already have a task cannot be selected, and if any folder fails validation, nothing is created. The resulting tasks are independent; change them one at a time. Batch add also fills the tag list with the parent folder name so the new tasks land in one group; edit or remove it before saving.

The task list groups rows by **tag**, **type** or **source parent folder**, or stays flat. A group header shows its name, task count and failure count; click it to collapse or expand, or use **Collapse all** / **Expand all**. The chosen grouping and the collapsed groups are remembered across reloads. Searching expands every group so a match is never hidden inside a collapsed one. Grouping combines with search, enable-state filtering and tag filtering, and group counts reflect the filtered set.

Directory tasks can enable file-change watching under **Schedule and Notifications**. Watching is off by default and covers the selected directory recursively. Changes are grouped for a configurable 1–300 seconds (five seconds by default) before a full backup version is created. Changes during an active backup trigger one more run after it finishes. Exclusions also apply to watch events. Pausing or deleting a task, or disabling watching, stops its watcher. Vaultwarden and system-configuration tasks do not support this option. Task details show watcher status and errors.

Watching depends on operating-system file events. Network filesystems, some container mounts, and temporary source outages can miss events. The service periodically attempts to reconnect, but cannot recover every change made while disconnected. Use a schedule as an additional safeguard for important data. Increase the grouping interval for frequently changing large directories. The **File watching** switch in the task list turns watching on or off directly while keeping the watch mode and grouping interval.

There are two watch modes. **Whole directory** archives and uploads the full directory on every change. **Only new and modified files** records the existing files as a baseline (path, size, and modification time) when enabled; later watch runs package only new or modified files as an incremental version such as `task.incremental.7z`. Its `incremental.*.tar` holds those files and `changes.*.json` lists added, modified, and deleted paths. A watch run with no new or modified files succeeds without uploading or sending email; deletions alone are recorded in the next incremental version. Manual and scheduled runs are always full backups and reset the baseline to the current directory. After a restart, the service compares against the baseline to back up changes made while it was stopped. To restore, extract the latest full version, then each later incremental version in time order, deleting files listed in `changes.*.json`. Retention counts and days apply to full versions only; an incremental version is pruned only once it is older than the oldest retained full version, so pair this mode with scheduled full backups. Only size and modification time are compared, so a content change that keeps both unchanged is not detected.

Directory tasks first create a tar payload to preserve filesystem metadata. Unencrypted backups can use tar.gz. Encrypted backups use 7z or ZIP with AES-256; 7z also encrypts filenames. The 7z editor supports LZMA2 or LZMA, one to eight threads, and an 8–256 MiB dictionary. At compression levels 7–9, automatic settings use one thread and a 32 MiB dictionary to reduce memory pressure; lower levels use 7-Zip defaults. These settings do not apply to ZIP or tar.gz.

Version-folder and archive filenames accept `{datetime}` (UTC) and `{task}`. The folder template must contain `{datetime}`. A typical remote layout is `destination/2026-09-28_11-24-18-123Z/task.7z`, with `complete.json` beside the archive recording the task ID, run ID, size, and SHA-256. Do not rename or move existing versions manually. Exclusion rules support literal paths, `*`, and `?`; extended glob syntax is rejected.

Vaultwarden tasks support SQLite, PostgreSQL, and MySQL/MariaDB. They create a consistent database snapshot or export and include available `config.json`, `rsa_key*`, `attachments`, and `sends` assets. Missing optional assets are recorded as skipped; a database failure fails the task. Archive entries preserve the familiar `db.*`, `config.*`, `rsakey.*`, `attachments.*`, and `sends.*` names.

Each run creates an independent remote version and verifies the upload. Plaintext staging is removed after archive validation. The policy in **System Settings → Temporary Files** controls the successful local archive: **Immediate cleanup** is the default; **Manual cleanup** retains it until an administrator removes an individual archive or all retained archives on that page. An email failure does not change a successful backup or prevent the selected cleanup policy. Failed-run staging is limited to the latest attempt per task and is subject to its retention period and temporary-space budget. Remote retention only removes completed versions recorded as owned by that task.

The settings page shows total temporary usage, retained successful-archive usage, other temporary files, and each retained archive. Manually retained successful archives count toward the temporary-space limit and are not removed by failed-file housekeeping. If capacity is insufficient, a new backup fails until space is freed or the limit is increased. Switching back to immediate cleanup affects future runs only. Export and compression are monitored every 250 ms; a short overrun remains possible between checks. Restart recovery removes plaintext and database credentials left by interrupted runs.

If an unencrypted tar.gz archive is retained manually, its local copy is also unencrypted. Restrict access to the application's persistent directory and remove local copies when they are no longer required.

## Authentication and notifications

For AzureKiln OAuth2, register a confidential client with callback URL `BACKUP_PUBLIC_URL/api/auth/oidc/callback`. Configure the issuer, client ID, client secret, and exact administrator `sub`. The authorization-code flow uses PKCE, state, nonce, and ID Token verification and maps the approved identity to the existing administrator.

SMTP settings support STARTTLS, implicit TLS, or unencrypted transport, plus a sender, multiple recipients, and a test message. Each task can enable notifications for start, success, and failure independently. Notification status is recorded separately from backup status.

For MySQL/MariaDB, the Require TLS option also validates the server certificate. Supply a trusted chain or a CA certificate; connection failures do not fall back to plaintext.

## Recovery and secrets

Download an archive from its task's version list and decrypt it with the password that was active when the version was created. Directory archives contain an inner tar. For Vaultwarden, restore the database export and the included configuration, RSA keys, attachments, and Sends as applicable. Stop Vaultwarden before replacing live data, and validate the archive in an isolated location first. A `pg_dump` client must not be older than the PostgreSQL server major version.

A database snapshot is internally consistent, but attachments changed during a run are not guaranteed to represent the same instant. Use a maintenance window for application-wide consistency. If Vaultwarden deployment files reside outside its data directory, create a separate directory task for them.

Stored credentials are encrypted with an independent key. Back up the persistent data and `.data/secret.key` (or `/data/secret.key` in Docker). Without the original key, stored credentials cannot be recovered. Password changes affect new archives only; retain historical archive passwords. Imported rclone credentials are encrypted in the application's private configuration, and a failed reimport does not replace the active configuration. Remove an existing `vaultwarden-backup` container only after a real recovery test.

## Application-configuration backup and import

The built-in **System Configuration** task starts disabled. Set an rclone destination and a 7z password, then run it manually or enable a schedule. It takes an online `state.sqlite` snapshot and includes `secret.key`, the active `rclone.conf`, and readable deployment `.env` and `compose.yaml` files. This archive always uses AES-256-encrypted 7z. Keep its password separately.

Compose mounts `.env` and `compose.yaml` read-only under `/system-config/`. Other deployments can set `SYSTEM_ENV_FILE` and `SYSTEM_COMPOSE_FILE`. Source data and reverse-proxy configuration are not included automatically.

To import, sign in as the current administrator and upload a System Configuration archive with its password. The upload limit is 256 MiB and the extracted configuration limit is 2 GiB. The application verifies the archive, hashes, SQLite integrity, and encryption key, then stages it at `/data/system-restore-pending`. Restart with `docker compose restart backup` to apply it. The previous state is preserved under `/data/system-restore-previous-*` for rollback. Deployment files are written as `/data/restored-deployment.env` and `/data/restored-compose.yaml` for manual review; read-only host mounts are not overwritten. If `BACKUP_MASTER_KEY` is supplied externally, set it to the imported key before restarting.

## Verification

```powershell
npm run check
npm test
npm run build
npm run check:browser
```

Browser verification requires Chromium and working rclone/archive tools. Validate the actual remote storage, mail service, database connection, and recovery procedure separately in production.
