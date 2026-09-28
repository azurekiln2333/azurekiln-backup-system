# Frontend Development Guidelines

> Best practices for frontend development in this project.

---

## Overview

The console uses Vue 3 SFCs with TypeScript, shared Zod contracts, and local CSS/assets. Read the implemented [Console and API Contracts](./ui-api.md) before editing workflows. Other generic guide templates remain pending bootstrap.

## Quality Check

Read `ui-api.md`. Run `npm run check`, `npm run build`, and `npm run check:browser`. Inspect desktop/mobile/light/dark screenshots and verify real empty/error states, accessible controls, editor validation, secret-preserving saves, and execution/download state updates.

---

## Guidelines Index

| Guide | Description | Status |
|-------|-------------|--------|
| [Console and API Contracts](./ui-api.md) | Components, state, DTOs and browser verification | Implemented |
| [Directory Structure](./directory-structure.md) | Module organization and file layout | To fill |
| [Component Guidelines](./component-guidelines.md) | Component patterns, props, composition | To fill |
| [Hook Guidelines](./hook-guidelines.md) | Custom hooks, data fetching patterns | To fill |
| [State Management](./state-management.md) | Local state, global state, server state | To fill |
| [Quality Guidelines](./quality-guidelines.md) | Code standards, forbidden patterns | To fill |
| [Type Safety](./type-safety.md) | Type patterns, validation | To fill |

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
