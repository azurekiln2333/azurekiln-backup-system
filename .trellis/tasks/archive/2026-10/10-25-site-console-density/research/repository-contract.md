# Site repositories and notes: contract research

Planning only, inspected 2026-10-25. No implementation or tests run. This note owns repository/notes metadata and the address storage/display boundary; density and overview layout decisions are researched separately.

## Confirmed follow-up decisions

- Each site supports **multiple** repository links. Use `repositoryUrls: string[]`, default `[]`; cardinality is no longer an open question.
- Add optional plain-text site remarks. Proposed consistent API/schema/store/editor field name: `notes`, with `string` output and default `''`. The user approved remarks; the field name and length rule below are technical proposals.
- Display the site name and **first** access address on the same row, with only that one address visible. Its visible label is **hostname only**, while clicking preserves the complete canonical href: `https://panel.example.com:8443/admin` displays `panel.example.com` and still opens the URL with port/path intact. Keep the complete ordered `domains[]` in storage, public DTOs and the editor; the condensed view must not truncate saved addresses. This is a view projection, not a cardinality/schema change.

## Existing boundaries

- `shared/contracts.mjs:106` defines `siteSchema` as `{name, domains, tags, backupJobIds}`. `web/src/types.ts:31` derives `SiteInput` from it; `Site` adds identity/timestamps at `web/src/types.ts:32`. Extend this shared boundary rather than maintaining a second frontend DTO.
- `shared/contracts.mjs:57` already normalizes navigation addresses with a URL parser, rejecting credentials, unsupported schemes, whitespace/control characters and invalid hosts; `shared/contracts.mjs:97` reports schema issues. Repository URLs need an additional provider/path policy, so do not silently change the existing domain rules.
- **Two explicit store projections must change:** `server/store.mjs:124` constructs public site DTOs, and `server/store.mjs:202` constructs persisted metadata. A schema-only extension would lose `repositoryUrls` and `notes`. Both values fit the existing `sites.data` JSON (`server/store.mjs:55`); neither a new SQL table nor any change to `site_jobs` is needed.
- `server/store.mjs:200` merges previous values before parsing; `server/store.mjs:203` transactionally saves metadata and replacement task links. Preserve that order and the many-to-many relation as the only source of `backupJobIds` (`server/store.mjs:123`).
- Existing site collection/member routes (`server/app.mjs:182`) already delegate arbitrary object bodies to the store and return its authoritative DTO. They sit behind auth/origin/CSRF middleware (`server/app.mjs:110`). No new endpoint is needed for this extension.
- `web/src/components/SiteEditor.vue:29` clones a draft once; its save payload is explicitly enumerated at `:100`. Add repository-list and notes initialization, payload, field issue mapping (`:70`, `:108`) and preview to the same flow. Preserve draft values on polling/API failure (`:14`, `:118`) and retain every editable address even though the list displays only the first.
- `web/src/components/SitesView.vue:113` renders domain links with `target="_blank" rel="noopener noreferrer"`; repository navigation should use the same safe anchor behavior and a provider icon with an accessible name. Local brand assets/provider styling belong to the frontend workstream. New repository links must remain distinct from access links and tag-filter buttons (`:122`).

## Hostname label versus full access URL

- The current `siteDomainLabel` includes port/path/query/fragment (`shared/contracts.mjs:83`), so reusing its current label unchanged would not meet the latest request. At the agreed list/overview presentation boundary, derive the short label from `new URL(canonicalHref).hostname`, **not** `.host` (which contains the port) and not string slicing. Reuse the shared safe canonical link projection (`shared/contracts.mjs:92`); centralize the hostname-only display projection when both views need it.
- Preserve the original normalized href as `href`, including scheme, port, path, query and fragment. Never replace `domains[]` entries with hostnames, mutate the record during rendering, or change canonicalization to discard URL components. The first-address display does not change URL order or normalize every address to a root URL.
- Existing full addresses remain available in the editor and keep their navigation targets after repository/notes-only edits. Whether the full target also appears as a tooltip is a presentation detail. Search should continue seeing all stored domains (`web/src/components/SitesView.vue:54`), including addresses hidden by the condensed display.

## Cardinality decision history

The following alternatives were researched before the user's follow-up. **The multiple-repository row is now selected; the single-repository row is historical, not pending.**

| Product choice | Minimal candidate input/output extension | Empty and PATCH semantics | Consequence |
| --- | --- | --- | --- |
| One source repository per site — historical alternative | `repositoryUrl: string` defaulting to `''` | Omitted PATCH preserves; `''` clears | Not selected |
| Several source repositories/mirrors — confirmed | `repositoryUrls: string[]` defaulting to `[]` | Omitted PATCH preserves; supplied array replaces; `[]` clears | Repeatable fields and ordered links; agree a small maximum and deduplicate canonical hrefs |

Use only `repositoryUrls`, not a parallel `repositoryUrl` field or a primary-repository selector. Its multiplicity is independent of the existing many-to-many backup-job relationship.

Provider selection is a separate choice: infer from a validated host for the smallest metadata model, or persist `{provider,url}` only if manual provider selection is needed. If explicit selection is chosen, validate agreement between provider and URL host; otherwise a mislabeled external site could receive a trusted brand icon. Do not persist both a derived provider and URL without a concrete reason.

## Optional site notes proposal

- Extend `siteSchema` with `notes: z.string().trim().max(500).default('')`, reusing the behavior already established for job descriptions at `shared/contracts.mjs:115`. This permits multiline plain text and empty notes; it does not inherit the single-line tag restrictions. Keep the field name `notes` throughout the shared schema, DTO, SQLite JSON, editor and tests.
- `server/store.mjs:156` and `:160` already supply `description: ''` on legacy job reads. Apply the analogous `data.notes ?? ''` default in `siteView`, plus `data.repositoryUrls ?? []`; shared-schema defaults alone do not affect these direct reads.
- Add an optional textarea following the existing job-description input (`web/src/components/JobEditor.vue:207`, `maxlength="500"`, three rows), adapted to the final density design. Render saved notes using Vue text interpolation/text content, not `v-html` or Markdown interpretation. No link extraction, tokens or secret handling are added.
- Existing job list descriptions are searchable and displayed as secondary text (`web/src/components/JobsView.vue:53`, `:128`). This is a reusable pattern if the site UX includes notes search/preview, not permission to replace site names/addresses or hide saved notes completely. Exact placement remains with the density design.

## Provider hosts: official evidence

Verified official documentation, not user repositories:

| Requested provider label | Confirmed host | Primary source and evidence |
| --- | --- | --- |
| GitHub | `github.com` | [GitHub: Cloning a repository](https://docs.github.com/en/repositories/creating-and-managing-repositories/cloning-a-repository) uses an HTTPS owner/repository URL. |
| CNB | `cnb.cool` | [CNB: Git Address and Authentication](https://docs.cnb.cool/en/guide/git-access.html) states that the HTTPS repository address is the same URL as the browser repository homepage. |
| Gitee | `gitee.com` | [Gitee: git clone / 下载代码](https://help.gitee.com/enterprise/code-manage/%E4%BB%A3%E7%A0%81%E6%89%98%E7%AE%A1/%E4%BB%A3%E7%A0%81%E4%BB%93%E5%BA%93/git%20clone%E6%88%96%E4%B8%8B%E8%BD%BD%E4%BB%A3%E7%A0%81) uses its official HTTPS repository host. |
| GitCode | `gitcode.com`; also documented `hub.gitcode.com` | [Official CLI documentation](https://docs.gitcode.com/docs/help/home/general-reference/cli/) explicitly supports both host forms. It now uses AtomGit branding; preserve the user's requested GitCode label and submitted host rather than silently renaming/replacing them. |

The second GitCode host is evidence for an optional supported alias, not a reason to rewrite saved addresses. No evidence was established here for legacy `gitcode.net`, arbitrary subdomains, custom enterprise hosts or `www` aliases; do not silently accept them as recognized providers. Parent research owns icon assets/brand-use guidance.

## Proposed normalization and validation boundary

- Export one shared repository URL schema and link/provider projection. Both API/editor validation and rendered provider icons should use it, analogous to `siteDomainSchema`/`siteDomainLink`; no component-local host heuristics.
- Use the URL parser; trim input, optionally default bare provider URLs to HTTPS like existing site addresses, and bound both raw/canonical URL length (the existing 2048-character address limit is reusable). `[]` is the empty repository value; blank editor rows may be omitted before parsing, but an empty string is not a valid persisted list entry.
- Match exact normalized `URL.hostname` against the supported host map, never substring/suffix text. Reject credentials, non-web schemes, control characters, backslashes and unsupported ports. An HTTPS-only policy is simple for these public providers, but must be stated in final acceptance rather than assumed from the broader HTTP(S) site-address contract.
- Require a nonempty repository path, not merely a provider homepage. The official examples establish owner/group plus repository paths; do not claim they establish every platform's complete namespace grammar. Avoid an exactly-two-segments rule until nested-group policy is verified. Do not automatically cut a deep link to two path segments.
- Preserve case-sensitive path/query/fragment semantics. Do not lowercase an entire href, infer a repository's canonical casing, strip `.git`, discard deep-link suffixes, or rewrite aliases without an agreed rule. The narrowest predictable UX asks for a browser repository URL and keeps its navigation target after safe normalization.
- Deduplicate only identical normalized hrefs and retain first order in `repositoryUrls`. Mirror links remain distinct values.
- Never fetch a repository, resolve DNS, request its favicon, check existence/privacy, clone code, or add tokens/OAuth. A valid stored link means navigation metadata; it does not certify access, CI state or backup coverage.
- On read/render, missing legacy fields default to `repositoryUrls: []` and `notes: ''`. Handle an unexpectedly invalid restored link as non-clickable text/invalid metadata rather than crashing a site row. Do not broaden the old archive validator into a network/provider availability check.

## Compatibility and required future verification

- The empty defaults `repositoryUrls: []` and `notes: ''` belong in **both** `siteSchema` and `siteView`, because current public reads do not parse all metadata through `siteSchema`. Include both values in the explicit persisted metadata record and public DTO; `SiteInput`/`Site` then derive the extension from the shared schema. A pre-extension site must remain editable.
- Preserve merge-before-parse (`server/store.mjs:200`): omitted `repositoryUrls` and `notes` retain prior values, including requests from an older client. Supplied `repositoryUrls` replaces the array; `[]` clears repositories. Supplied `notes` replaces text; `''` clears notes, with whitespace-only input normalizing to `''` under the proposed trim rule. Reject `null`/wrong types rather than interpreting them as a clear.
- Clearing either field must preserve the other, `domains`, `tags` and `backupJobIds`; invalid notes or repository input must leave metadata/timestamps/relations intact. Keep full ordered address arrays through edits that only alter notes/repositories. Showing `domains[0]` on one row must never become a PATCH containing only that address.
- Whole-state backup snapshots already copy SQLite (`server/backup.mjs:243`, `:248`) and build the same version-1 manifest (`:286`). Restore validates files/integrity/key (`server/system-restore.mjs:28`, `:47`); startup applies restore before opening the store (`server/app.mjs:73`, `:76`). Keep this format: JSON metadata requires no archive migration or mandatory new file/table.
- Existing tests provide extension points, **not evidence of repository behavior yet**: CRUD/reopen (`tests/sites.test.mjs:151`, `:206`), reject-without-write (`:225`), omit/replace/clear PATCH (`:287`), pre-site-table migration (`:391`), current snapshot restore (`:457`), old snapshot restore (`:491`), and a real encrypted export/staged-import round trip (`:537`, seeded site at `:558`).
- Add a legacy case with **site tables present but both new fields absent**; the current old-archive case removes the whole tables. Check that public reads return `[]`/`''` and the old site remains editable after reopen/restore. Extend current snapshot and real encrypted export/import fixtures with several repositories, multiline notes and several domains so deep equality proves exact metadata, order and relation preservation. Preserve the existing foreign-key checks and archive manifest version.
- Cover recognized/mismatched/deceptive hosts, invalid schemes/credentials, canonical deduplication/order, array replacement/clearing, notes trimming/length/wrong types, independently clearing notes/repos, old-client PATCH preservation and shared-schema field issues. Browser verification must check provider labels/icons, exact `href`, safe new-tab attributes, literal HTML-looking notes, failed-save draft retention and mobile wrapping. Assert name plus first address share the intended row, the short label contains only hostname, the anchor still targets the full URL (including nondefault port/path/query/fragment), and reopening the editor still exposes every saved address. No additional backup-executor behavior is needed.

## Remaining decisions

1. Final URL policy: browser links only, supported host aliases, HTTP(S) versus HTTPS, bare URL convenience, and repository-root versus deep-link acceptance. Set these consistently with the chosen UI; do not silently add restrictions through implementation.
2. Technical limits and presentation: repository count cap, confirmation of the proposed 500-character plain-text `notes` contract, and notes placement/search behavior. Repository multiplicity, optional remarks and first-address-only list display are confirmed decisions, not open questions.

No product files, task status, commits, pushes or test processes were changed by this research.
