# Journal - lichengyu (Part 1)

> AI development session journal
> Started: 2026-09-28

---

## Session 1: Unified Backup Console (2026-09-28)

Implemented Node 24/Express/SQLite services and Vue/TypeScript UI with shared schemas. One administrator, optional AzureKiln OIDC, independent directory-to-rclone destinations, schedules/history/downloads, Vaultwarden database adapters and optional artifacts, AES-256 archives, SMTP, retention and bounded temporary storage. Preserved existing scaffold and reference repositories.

Validation: `npm run check` and `npm run build` pass; final `npm test` passes 35/35 without skips; browser check passes 25 desktop/mobile/light/dark screenshots, two real encrypted backups and SMTP/download/cleanup workflows. Credentials/source boundaries, live SQLite WAL, wrong passwords, queue/restart/cancel, quota enforcement, atomic encrypted config import and retention retry covered.

Preview: http://127.0.0.1:5173 with fresh uninitialized state. Task evidence: `.trellis/tasks/09-28-unified-backup-system/verification.md`. Docker build and actual cloud/PostgreSQL/MySQL/OAuth deployment tests remain external. No staging/commits or archive auto-commits performed; current task remains available for review/commit.



## Session 2: ui-shell: rebuild console shell after newapi (pane w1H:p3)
<!-- trellis-session: v=2 fp=009f272b1dcbc0d1 -->

**Date**: 2026-10-18
**Task**: ui-shell: rebuild console shell after newapi (pane w1H:p3)
**Branch**: `main`

### Summary

Radii tokenized to --radius-sm/md/lg/pill (0.5rem tier, audit script enforces zero raw corners); sidebar rebuilt with collapsible rail (226->68px, 200ms width+margin+opacity transition, localStorage persistence, tooltips, mobile drawer unaffected); account identity/sign-out moved to topbar dropdown; removed workspace label, admin card, admin-session lines, page eyebrow, workspace footer; nav extracted to web/src/nav.ts registry; storage 'not found' root-caused to verbatim rclone/server error passthrough and fixed via web/src/errors.ts friendlyError with raw text in title, plus error/empty-state mutual exclusion. Verified: check green, test 68/68, check:browser 44 screenshots, radius audit clean, 37 targeted shell assertions.

### Git Commits

| Hash | Message |
|------|---------|
| `57c87f0` | docs(task): review api-tokens cleanup from ui-shell |

### Status

[OK] **Completed**


## Session 3: final regression + p5 review (pane w1H:p3)
<!-- trellis-session: v=2 fp=8a93cf52e8f6fda6 -->

**Date**: 2026-10-18
**Task**: final regression + p5 review (pane w1H:p3)
**Branch**: `main`

### Summary

Reviewed p5 newapi-data-backup: verified SQLite online-backup snapshot, path sandboxing, secret handling (scanned every archived file), and that source/images are excluded; reported 7 findings (D1 includeLogTable ignored for sqlite, D2 WITHOUT ROWID digest crash plus null-hash false pass, D3 round-trip never used a real 7z archive, D4 sqlitePath outside dataDir, D5 empty row-count table, D6 placeholder restore commands, D7 recoveryPoint double now). All 7 confirmed and fixed by p5 with real assertions. Final regression green: check, test 80 pass/1 skip, build, check:browser 44 screenshots, radius audit. Wrote ALL-DONE to board.

### Git Commits

| Hash | Message |
|------|---------|
| `a055564` | docs(task): respond to p5 review with D1-D7 fixes |

### Status

[OK] **Completed**


## Session 5: Site inventory and shared backup job links
<!-- trellis-session: v=2 fp=b65b62a51633a68b -->

**Date**: 2026-10-24
**Task**: Site inventory and shared backup job links
**Branch**: `feat/site-management`

### Summary

Implemented and verified site CRUD, multiple domains, independent tags, bidirectional many-to-many job links and safe deletion/restore. User authorized the scoped commit and feature-branch push.

### Git Commits

| Hash | Message |
|------|---------|
| `2dcc72be0d2414a37b901170a145278d09d873ad` | feat(sites): add site inventory and shared backup job links |

### Testing

- [OK] 91 tests: 90 passed, 0 failed, 1 intentional Windows symlink skip; type check and production build passed.
- [OK] Browser: 57 screenshots and no browser errors; layout: 56 asserted renders and 60 screenshots; independent review PASS AC1-AC6.

### Status

[OK] **Completed**

### Next Steps

- Publish feat/site-management to GitHub; handle image CI and new-api adapter follow-ups in their separate tasks.
