# Site image and Watchtower notes

## 1. Scope / Trigger

Apply when editing site deployment metadata, the site editor or site backup/restore coverage. These fields describe an external deployment; saving them never configures a registry, CI pipeline, Docker or Watchtower.

## 2. Signatures

- `siteSchema` adds `cloudImages: string[]` and `watchtowerAutoUpdate: boolean`.
- `store.saveSite(input,id?)` persists them in `sites.data`; `siteView` projects them through list/get responses.
- Existing `GET/POST /api/sites`, `GET/PATCH /api/sites/:id` and `SiteEditor`'s `save(id,input) -> Promise<Site>` retain their signatures.

## 3. Contracts

- `cloudImages` defaults to `[]`, accepts up to 20 entries of 1–1024 characters after trimming, rejects embedded whitespace/control characters and deduplicates exact strings in first order. Preserve case, registry names, tags and digest text. It is plain reference text, not an automatically opened URL or a network-validation instruction.
- `watchtowerAutoUpdate` is a strict boolean defaulting to `false`. Its checkbox records whether the operator uses Watchtower for that site. Do not create/update containers, labels, polling jobs or CI secrets from it.
- Reads of legacy rows provide empty defaults without rewriting the database. PATCH merges before applying schema defaults: omission preserves values, `[]` and `false` clear independently. Persist metadata and existing links in the store-owned transaction; a rejected write changes neither.
- Include the fields in the explicit saved record and public projection. Shared schema defaults alone cannot establish persistence. Whole-database system snapshots retain them automatically with site metadata.
- Browser types derive from `siteSchema`. The editor copies the list into its mounted draft, trims/omits unfilled rows before shared validation, provides distinct add/remove input labels and keeps entered values after failures. Reuse existing responsive list/checkbox styles.

## 4. Validation & Error Matrix

| Condition | Required behavior |
| --- | --- |
| Legacy row or omitted fields on create | `cloudImages: []`, `watchtowerAutoUpdate: false` |
| Omitted field on PATCH | Preserve its saved value |
| Explicit `[]` / `false` | Clear only the specified field |
| More than 20 entries, empty/oversized/whitespace-bearing reference, wrong types | 400 `VALIDATION_FAILED`; leave metadata and links unchanged |
| Invalid linked job in the same update | Existing 400 `SITE_JOB_NOT_FOUND`; do not partially save deployment notes |
| Editor/server save failure | Retain image rows, checkbox and other draft values with an actionable error |

## 5. Good / Base / Bad Cases

- Good: record a GHCR tag and a CNB mirror or digest; restart and reopen the site with exact references and checkbox state.
- Base: an old site has no deployment notes and still edits normally.
- Bad: enabling the informational checkbox starts an updater, or updating a site's name resets a previously saved image list.

## 6. Tests Required

`tests/sites.test.mjs` covers real HTTP/SQLite save/list/get/reopen, strict types and limits, trim/dedup order, independent clear/preserve semantics, failed-write atomicity, legacy non-rewrite behavior and real system restore retention. The focused browser check `scripts/check-site-deployment.mjs` exercises add/remove/save/reopen/clear, invalid and failed-save draft preservation, desktop/mobile themes and metadata-only network effects. Run the full tests, type-check, production build and existing browser/layout gates sequentially. Inspect actual screenshots and validate an exported staged tree when unrelated work exists.

## 7. Wrong vs Correct

Wrong: add defaults only to `siteSchema`, omit the fields from `siteView`/the saved JSON projection, or apply default `false` to an omitted PATCH value before merging.

Correct: merge the current record with the PATCH, validate once, transactionally persist both fields and links, and explicitly project backward-compatible defaults on every read.
