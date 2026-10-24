# Agreed shared export names for implementation

Recorded from Pi w1H:p4's read-only preflight on 2026-10-25. The parent selected these names for cross-worker coordination; no code exists for the new exports yet.

- `SITE_REPOSITORY_LIMIT = 20`, `SITE_REPOSITORY_MAX_LENGTH = 2048`, `SITE_NOTES_MAX_LENGTH = 500`.
- `SITE_REPOSITORY_HOSTS`: frozen exact-host map, github.com -> github, cnb.cool -> cnb, gitee.com -> gitee, gitcode.com and hub.gitcode.com -> gitcode.
- `normalizeSiteRepository(input) -> string`: canonical HTTP(S) href; bare input defaults HTTPS. Preserve explicitly supplied HTTP instead of silently upgrading it. Follow design.md host/path/credential/port and case-sensitive suffix rules.
- `siteRepositorySchema`: Zod transform to canonical href with actionable field issues. The site list schema owns ordered deduplication through the existing helper.
- `siteRepositoryProvider(value) -> 'github' | 'cnb' | 'gitee' | 'gitcode' | null`.
- `siteRepositoryLink(value) -> {href, provider, label}`: safe normalized link with distinguishable owner/repository path label, including multiple links on one provider. Invalid restored values are caught at presentation boundaries, never emitted as unsafe hrefs.
- `siteNotesSchema`: trimmed plain text, <=500 characters, default ''.
- `siteDomainHostname(value) -> string`: normalize using the existing domain boundary, then URL.hostname. Preserve `siteDomainLabel`/`siteDomainLink` semantics for full editor previews. The row combines the new hostname label with the existing complete safe href. This avoids changing full-address behavior in other consumers.
- `siteSchema`: add `repositoryUrls: []` and `notes: ''` with the shared validators. Store public/save projections include both; omitted PATCH still merges before parsing and explicit clears are independent.

Backend owns these exports; frontend/tests consume them after CONTRACT-READY. Any necessary change is coordinated through parent before editing consumers. PRD/design remain authoritative over historical research alternatives.
