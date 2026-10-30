# Allow repository links from unrecognized hosts

## Goal

Allow administrators to save and open repository links even when the application has no bundled icon for the host. Provider recognition controls icon presentation only; it must not decide whether a repository URL can be saved.

## Background and confirmed facts

The code anchors below describe the baseline at commit `95a5566`, before this task's edits.

- The user reported that `https://gitlab.com/azurekiln-team/cnb2api-panel` is rejected and clarified that unrecognized platforms should simply have no icon.
- `shared/contracts.mjs:129` owns repository normalization for both the editor and API. The host rejection at `shared/contracts.mjs:139` couples URL validity to the icon-provider map.
- `web/src/components/SiteRow.vue:111` assumes every valid repository has a provider in its accessible name, although the icon at line 112 is already conditional. The editor's provider-only help at `web/src/components/SiteEditor.vue:219` also needs to reflect the new behavior.
- Existing tests deliberately reject GitLab and lookalike provider hosts (`tests/sites.test.mjs:342`); they must distinguish valid unrecognized links from invalid URLs instead.

## Requirements

- R1: Accept repository URLs independently of the recognized-host map. The supplied GitLab URL and other unrecognized hosts must pass the same shared validation and persist through site create/edit/read operations.
- R2: Recognized exact hosts retain their current provider icons. All other valid repository hosts produce a null provider and render as normal, clickable text links without an icon, guessed provider, or broken provider name in their accessible label.
- R3: Preserve the existing URL normalization and unrelated validation: HTTP(S) only, bare hosts default to HTTPS, explicit HTTP and case-sensitive paths/query/fragments survive, at least owner/group plus repository path is required, nondefault ports/credentials/control characters/backslashes are rejected, at most 20 entries of 2048 characters, and canonical duplicate links collapse in first order.
- R4: Saving or rendering repository metadata must not fetch, probe, clone, or authenticate with a repository host. Existing stored links require no migration.
- R5: Update editor help, the three README languages, and applicable backend/frontend specs so provider icons are documented separately from supported repository links.

## Acceptance Criteria

- [x] AC1 (R1, R3): A site containing the exact reported GitLab URL and a separate self-hosted repository URL can be created, edited, saved, and read back through the real API with canonical targets/order intact.
- [x] AC2 (R2): GitLab and self-hosted links appear in both the site list and overview as clickable repository labels with complete hrefs, useful accessible names, and no provider mark. Recognized GitHub links in the same site retain their icon.
- [x] AC3 (R2): A valid host that contains a known provider's name, such as `github.com.example.org`, is accepted as an unrecognized host and never receives the known provider's icon.
- [x] AC4 (R3, R4): Existing malformed/unsafe URL, count/length, deduplication, and metadata-preservation checks continue to pass; saving makes no repository-host request.
- [x] AC5 (R5): Editor help, all three README versions, and the affected specs describe the new rule. API regression tests, type checking, build, and the isolated browser checks pass.

## Scope and decisions

- This is a lightweight correction to one shared validation/presentation contract; PRD-only planning is sufficient.
- The provider map remains an exact-host icon lookup. No GitLab icon or additional provider integration is required by this task.
- Nondefault-port support, changes to required repository path depth, repository existence checks, favicon loading, Git operations, and unrelated authentication/UI work are outside this task.
- Risk: previously rejected unrecognized and lookalike hosts will now be valid navigation metadata. They receive no provider branding; existing URL restrictions and safe new-tab attributes continue to apply.
- No unresolved product or scope questions remain. The user approved the final planning summary with `继续` on 2026-10-25; implementation is authorized for this scope.

## Verification status

The task-specific acceptance criteria above are met. The full test suite is not green: both runs hit the existing executor staging-cleanup assertion at `tests/executor.test.mjs:300`, while the same named case passed alone without edits. See `research/verification.md` for exact results. No executor/authentication changes were made. Commit approval and task wrap-up remain pending.
