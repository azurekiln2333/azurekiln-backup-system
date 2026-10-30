# Proposed commit plan

Branch: `fix/repository-host-fallback`.

## Work commit

`fix: accept repository links from unrecognized hosts`

Include only these files:

- `shared/contracts.mjs`
- `web/src/components/SiteRow.vue`
- `web/src/components/SiteEditor.vue`
- `tests/sites.test.mjs`
- `scripts/check-browser.mjs`
- `README.md`
- `README.en.md`
- `README.zh-TW.md`
- `.trellis/spec/backend/backup-lifecycle.md`
- `.trellis/spec/frontend/ui-api.md`
- `.trellis/tasks/10-25-repository-host-fallback/task.json`
- `.trellis/tasks/10-25-repository-host-fallback/prd.md`
- `.trellis/tasks/10-25-repository-host-fallback/implement.jsonl`
- `.trellis/tasks/10-25-repository-host-fallback/check.jsonl`
- `.trellis/tasks/10-25-repository-host-fallback/research/contract-review.md`
- `.trellis/tasks/10-25-repository-host-fallback/research/verification.md`
- `.trellis/tasks/10-25-repository-host-fallback/research/commit-plan.md`

Task-specific verification passed; the full-suite executor-cleanup failure is disclosed in `verification.md`. The complete test suite must not be described as green.

## Follow-up bookkeeping

After the work commit, archive only this task and record its session separately according to the project workflow. Preserve existing journal/index edits; never auto-stage the preexisting changes listed below. Do not amend or push.

## Unrecognized dirty paths excluded from this commit

These paths were already dirty before this task and remain outside its scope:

- `server/auth.mjs`
- `.trellis/tasks/10-18-ui-revamp-newapi-backup/task.json`
- `.trellis/workspace/lichengyu/index.md`
- `.trellis/workspace/lichengyu/journal-1.md`
- `.agent/`
- `.claude/`
- `.codebuddy/`
- `.codex/`
- `.cursor/`
- `.dsh/`
- `.kimi-code/`
- `.opencode/`
- `.pi/`
- `.trae/`
- `.trellis/tasks/10-18-api-tokens/`
- `.trellis/tasks/10-18-ui-revamp-newapi-backup/board.md`
- `.trellis/tasks/10-24-ghcr-image-pipeline/`
- `.trellis/workspace/index.md`
- `.zcode/`
- `azurekiln-backup-system.zip`

Replying `ok` / `行` / `继续` approves the work commit with these exclusions and the follow-up bookkeeping. Replying `我自己来` / `manual` leaves the commits to the user.
