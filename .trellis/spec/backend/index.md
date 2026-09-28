# Backend Development Guidelines

> Best practices for backend development in this project.

---

## Overview

The backup runtime uses Node 24 ESM, Express, native SQLite, and fixed subprocess adapters. Read the implemented [Backup Runtime Contracts](./backup-lifecycle.md) before editing services or infrastructure. Other generic guide templates remain pending bootstrap.

## Quality Check

Read `backup-lifecycle.md` and the active task contracts. Run `npm test`, `npm run check`, `npm run build`, and the isolated browser integration when changing user workflows. Check source boundaries, credential redaction, persisted terminal states, verified remote versions, and staging cleanup. Report live integration limits honestly.

---

## Guidelines Index

| Guide | Description | Status |
|-------|-------------|--------|
| [Backup Runtime Contracts](./backup-lifecycle.md) | APIs, persistence, adapters, lifecycle and safety tests | Implemented |
| [Directory Structure](./directory-structure.md) | Module organization and file layout | To fill |
| [Database Guidelines](./database-guidelines.md) | ORM patterns, queries, migrations | To fill |
| [Error Handling](./error-handling.md) | Error types, handling strategies | To fill |
| [Quality Guidelines](./quality-guidelines.md) | Code standards, forbidden patterns | To fill |
| [Logging Guidelines](./logging-guidelines.md) | Structured logging, log levels | To fill |

---

## How to Fill These Guidelines

For each guideline file:

1. Document your project's **actual conventions** (not ideals)
2. Include **code examples** from your codebase
3. List **forbidden patterns** and why
4. Add **common mistakes** your team has made

The goal is to help AI assistants and new team members understand how YOUR project works.

---

**Language**: All documentation should be written in **English**.
