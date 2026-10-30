# Repository host fallback contract review

## Authoritative behavior

The user explicitly clarified that an unrecognized repository host must remain addable; absence from the provider map means no icon. The task PRD supersedes the older backend/frontend spec statements that restrict repository hosts. Keep the provider list unchanged and use it only to infer icons.

## Change boundary

- `shared/contracts.mjs`: remove provider-recognition rejection from URL normalization; update provider-nullability documentation and provider-specific validation wording. Preserve all other URL rules and the prototype-safe exact-host map lookup.
- `web/src/components/SiteRow.vue`: represent a valid link with a nullable provider and provide a meaningful accessible label for it. The current conditional `ProviderMark` already expresses the required no-icon fallback.
- `web/src/components/SiteEditor.vue`: explain HTTP(S) repository input and optional recognized-provider icons rather than an exclusive platform list.
- `tests/sites.test.mjs`: replace host-rejection expectations with real create/read/edit persistence and provider-null regressions, including the reported GitLab URL, a self-hosted repository, and a known-name lookalike host. Retain tests for independently invalid URLs.
- `scripts/check-browser.mjs`: extend the existing repository editor/site/overview workflow with an unknown-provider link. Assert correct save/read/display/href/accessibility and absence of a provider mark while retaining the existing same-provider coverage.
- `README.md`, `README.en.md`, `README.zh-TW.md`: distinguish arbitrary valid repository hosts from the small set of bundled provider icons.
- `.trellis/spec/backend/backup-lifecycle.md`, `.trellis/spec/frontend/ui-api.md`: synchronize the executable contract once the implementation and checks pass.

## Verification

Run meaningful regression coverage for shared normalization and real site API persistence, then the project gates `npm test`, `npm run check`, `npm run build`, and `npm run check:browser`. Frontend guidelines additionally require the existing layout/radius gates and visual inspection of the relevant desktop/mobile/light/dark output. Use isolated test state only.

## Existing workspace changes

Before task creation the workspace already contained edits to `server/auth.mjs`, the UI revamp task record and developer journal/index, plus untracked tool/runtime folders, other tasks and a zip. They are outside this task and must not be reverted or included in any task commit.
