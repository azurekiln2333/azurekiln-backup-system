# Planning baseline and reference constraints

Inspected on 2026-10-25. No product implementation is authorized yet.

## Repository state

- Current branch: `feat/site-management`; current HEAD `cc900be` follows feature `2dcc72b` and archive `3e1e9ee`. The prior site task is completed at `.trellis/tasks/archive/2026-10/10-24-site-management/`.
- Current task: `.trellis/tasks/10-25-site-console-density`, status `planning`. Task creation was explicitly approved after the current feature request.
- Preserve unrelated dirty paths: `server/auth.mjs`, `.trellis/tasks/10-18-ui-revamp-newapi-backup/task.json`, its untracked `board.md`, pre-existing workspace/journal changes, API-token and GHCR task directories, local agent directories and `azurekiln-backup-system.zip`.
- Only planning/research documents under this task may change before the final plan is approved. Do not run `task.py start`, edit product code, dispatch implementers, commit or push during requirements discovery.

## Existing design constraints

The parent UI requirements in `.trellis/tasks/10-18-ui-revamp-newapi-backup/prd.md` identify the actual references as `D:/My2KProjects/new-api` and `D:/My2KProjects/codebuddy2api-ui_template`.

The completed shell task at `.trellis/tasks/archive/2026-10/10-20-newapi-layout-shell/prd.md` establishes the existing 208px expanded / 44px collapsed sidebar, 48px full-width header, inset workspace, <=900px drawer breakpoint, 1600px content maximum and <=8px container radius. Preserve the existing palette, single h1 and operating workflows.

The earlier shell acceptance targeted correct structure and visible labels. It did not establish a minimum number of useful rows per viewport or a before/after density target. This task needs explicit information-density acceptance rather than only passing the previous screenshot matrix.

## Research ownership

- `research/frontend-density.md`: current spacing/address presentation versus actual local reference sources; proposed measurements.
- `research/repository-contract.md`: provider-link metadata options and backward compatibility.
- `research/site-overview.md`: existing overview sections, available site/job/run data and honest status semantics.
- Parent owns PRD convergence and product decisions. Research recommendations remain proposals until the user approves the final plan.
