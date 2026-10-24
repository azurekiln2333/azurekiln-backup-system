# Four-Pi final planning preflight

2026-10-25. All messages were sent to the four existing project Pi agents in workspace w1H after verifying their cwd and identity; no pane/focus/layout mutations. No product code, task activation or test suite was requested.

- p4 backend/shared: ACK/READY; explicit store read/write fields, legacy/PATCH behavior and shared exports are feasible. Parent confirmed HTTP(S), bare-to-HTTPS and exact repositoryUrls field spelling; shared names recorded in shared-contract.md. Selected separate siteDomainHostname helper preserves full editor preview behavior.
- p8 frontend: ACK/READY; row/overview integration structurally feasible. The proposed compact column layout can meet target geometry without hiding task names; existing overview and fixed spacing contracts must be deliberately replaced as specified.
- p6 tests: ACK/READY; parent clarified same-core-data baseline comparison because the old UI lacks repositories/notes. Full final fixture still includes those fields and absolute 6/3-row, 104/156px targets apply. Legacy and real encrypted restore extension points exist.
- p7 docs/independent review: identified the need for explicit selected-plan precedence over current shipped spec/guards, and a repository-only/notes-only search assertion. Parent added the precedence table in design.md and explicit AC1/browser coverage. Final acknowledgment pending.

These are planning feasibility findings, not implementation acceptance or evidence that new behavior exists. Workers remain on hold until final user approval and an explicit parent IMPLEMENT brief after task.py start.
