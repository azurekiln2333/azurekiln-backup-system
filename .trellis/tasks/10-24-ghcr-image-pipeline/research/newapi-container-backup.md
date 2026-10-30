# New-api PostgreSQL container deployment inquiry

Date: 2026-10-24. The user raised this question before approving CI implementation: can their host-side `docker exec postgres pg_dump` script run under the backup system instead of producing files for a separate directory-watching job?

This is deployment/requirements research. No database connection, host script execution, product edit, push, or additional task has been performed. The image-pipeline plan remains awaiting review; application bug fixes need an explicit scope decision rather than silently expanding that task.

## User script

The script runs host Docker CLI, invokes `pg_dump -w -U root -d new-api -Fc` inside container `postgres`, writes stdout to a `.partial` file, calls `pg_restore --list`, atomically renames the completed file, and deletes old files.

Confirmed retention defect from the supplied text: output files start `newapi_`, but cleanup matches `new-api-*.dump`. The find pattern does not select the generated dumps. Use `newapi_*.dump` if retaining the current naming convention.

`pg_restore --list` checks archive table-of-contents readability; it is not evidence that all table data has been restored successfully.

## Execution models

Recommended: the backup container joins a network that can reach PostgreSQL, runs its own compatible `pg_dump` via TCP, and lets the existing backup task own export, packaging, upload, verification, scheduling, and retention. A shared Docker network permits service-name access using PostgreSQL's container port (normally 5432), without publishing that port to the internet or sharing the raw database data directory.

Mounting a host script makes its file available in the container; invoking it still runs in the container environment. The current script therefore needs additional Docker-daemon access and a Docker CLI to preserve its `docker exec` behavior. The supplied Dockerfile/Compose do not provide either. Access to the normal Docker daemon socket grants broad control over host containers and mounts; direct database access is the narrower fit for this database-only operation.

A direct database connection does not require mounting PostgreSQL's raw data volume. The current full new-api task does additionally require the new-api application data directory and its `.env` to be readable within `SOURCE_ROOTS`; these are distinct from PostgreSQL's raw database directory.

## Existing implementation and verified defects

- `server/newapi.mjs:202-213`: `pgDumpEnvironment` supplies PGHOST, PGPORT, PGUSER, PGPASSWORD, PGDATABASE and optional TLS settings. The password is passed in the process environment, not argv.
- `server/newapi.mjs:232`: runs `config.pgDumpBinary` as `pg_dump --format=custom --no-password --file ...`. No Docker CLI or host script is involved.
- `web/src/components/NewApiFields.vue:75`: exposes database connection fields. Data directory and `.env` paths are required by current validation; `.env` is copied into the encrypted backup and is not automatically parsed to fill database credentials.
- **Confirmed path defect:** `server/newapi.mjs:229` exports to `payload/db.main.<stamp>.dump` (or sql), but `:412` records `db/main.dump`, then `:417-418` tries to hash that nonexistent path. There is no move/copy between them. The independent remote log database has the same mismatch at `:434-438`. PostgreSQL/MySQL full jobs cannot be described as working end to end until this is fixed and covered by a filesystem-producing test.
- **Confirmed PostgreSQL validation gap:** the actual export path checks subprocess exit, nonzero file size, chmod, and later hash. `pg_restore` only appears in generated restore instructions, not as an executed dump check. Container packaging validation should not be confused with database dump validity.
- **Confirmed PostgreSQL logs-selection defect:** `includeLogTable` reaches the helper, but the PostgreSQL argv at `:232` ignores it; only `mysqlDumpArguments` applies exclusion. `:415` nevertheless records `logsIncluded=false` when requested.
- Health detection runs `pg_dump --version` but does not compare it with a live server version.

The parent agent re-read the export/helper and main/log consumer paths to confirm the path mismatch and missing validation before reporting the finding.

## Confirmed deployment facts from the user

The user supplied host command output on 2026-10-24:

- Server: `postgres (PostgreSQL) 15.18 (Debian 15.18-1.pgdg13+1)`.
- Existing database-container network: `new-api_new-api-network`.

These facts resolve the server-version and network-name questions. Use the existing network as an external Compose network for the backup container while preserving its current network connectivity. Determine a valid PostgreSQL network alias and actual connection credentials during deployment; do not request secret values in chat or assume that TCP access/authentication is already working.

## Implication for image planning

The existing Dockerfile installs the distribution-default `postgresql-client`. Do not assume it can dump every deployed PostgreSQL version. Official PostgreSQL documentation states that `pg_dump` refuses to dump a server newer than its own major version. The user's confirmed server is major 15; verify the built image's actual client is major 15 or a supported newer client and document how it joins `new-api_new-api-network`.

Potential read-only host discovery commands (the user must run these on the actual deployment host):

```bash
docker exec postgres postgres --version
docker inspect postgres --format '{{range $name, $_ := .NetworkSettings.Networks}}{{println $name}}{{end}}'
```

## Primary documentation checked

Official pages were fetched directly over HTTPS because web search produced no usable rendered response:

- Docker Compose networking: `https://docs.docker.com/compose/how-tos/networking/` — shared/external networks, service-name DNS, container-port versus host-port distinction.
- Docker Engine security: `https://docs.docker.com/engine/security/` — Docker daemon control and host access implications; rootless operation is a separate configuration.
- PostgreSQL pg_dump: `https://www.postgresql.org/docs/current/app-pgdump.html` — newer-client/older-server support and refusal for a server newer than the client's major version; pg_dump covers a single database rather than cluster-global roles.
- PostgreSQL pg_restore: `https://www.postgresql.org/docs/current/app-pgrestore.html` — `--list` lists the archive table of contents; actual restore testing is a separate operation.
