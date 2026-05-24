# tsgit — Project Instructions

## What is this?

A pure TypeScript git library. Lightning-fast, portable (Node.js + browser), zero dependencies.

## Architecture

Hexagonal architecture with tiered application layer:

```
src/
├── domain/           # Pure core — zero outward deps
├── application/
│   ├── commands/     # Tier 1 — high-level use cases (clone, log, status...)
│   └── primitives/   # Tier 2 — low-level composable ops (readObject, walkCommits...)
├── ports/            # Interfaces only (FileSystem, HttpTransport, HashService, Compressor)
├── adapters/         # Platform implementations (node, browser, memory)
├── operators/        # AsyncIterable composition (pipe, filter, map, take...)
├── transport/        # Transport middleware (retry, auth, logging)
├── repository.ts     # Tier 1 facade — openRepository()
└── index.ts
```

**Dependency rule:** `repository → commands → primitives → domain`. Ports sit between application and adapters. Domain never imports outward.

## Key Commands

```bash
npm run validate      # Full quality gate — run before committing
npm run check         # Biome lint + format
npm run check:types   # TypeScript strict check
npm run test:unit     # Unit tests
npm run test:coverage # 100% coverage enforcement
npm run test:mutation # Stryker mutation testing
npm run build         # Compile to dist/
```

## Test Conventions

- **Titles:** Split across the describe/it tree — `describe('Given <context>')` > `describe('When <action>')` > `it('Then <expected>')`. Outer non-GWT describes (e.g. module names) are allowed as transparent wrappers. The 2-level shortcut `describe('Given <context>, When <action>')` > `it('Then <expected>')` is allowed when only one expectation lives under the When.
- **Body:** AAA — Arrange / Act / Assert with section comments
- **Variable:** System under test is always named `sut`
- **Coverage:** 100% line, branch, function, statement
- **Mutations:** Target 0 surviving mutants (equivalent mutants are acceptable only when provably equivalent)
- **No ignore directives:** Never use `v8 ignore`, `istanbul ignore`, `stryker-disable`, or any coverage/mutation suppression comments without explicit user approval

### Mutation-Resistant Test Patterns

- **Error assertions must be specific:** Never use `toThrow(ErrorClass)` alone — always assert the error's data (code, reason, value). StringLiteral mutants survive generic type-only checks.
- **Guard clauses need isolated tests:** For `if (A || B) { throw }`, write separate tests that trigger each condition independently. One test triggering both doesn't prove each guard works alone.
- **Prefer try/catch over toThrow for data assertions:** `toThrow(expect.objectContaining(...))` can miss nested property mutations. Use try/catch + direct `.data` assertions for reliable mutant killing.
- **Watch for dead code in guards:** `string.split('\n')` always returns at least one element — `if (lines.length === 0)` is unreachable dead code. Mutation testing reveals these. Remove them rather than writing impossible tests.
- **Accept provably equivalent mutants:** Loop bounds (`i < len` vs `i <= len` where out-of-bounds returns `undefined`) and search start offsets in homogeneous data are often equivalent. Document why, don't write contrived tests.

## Code Style

- FP-first: pure functions, immutable data, composition
- Object Calisthenics for domain: branded types (ObjectId, RefName, FilePath), no primitives crossing boundaries
- No `any` — biome enforces this. Use `unknown` + narrowing.
- Kebab-case files — enforced by ls-lint
- Small functions (<20 lines), early returns, no deep nesting
- Immutability — never mutate, always create new

## Domain Invariants

- All git objects are `readonly` discriminated unions
- ObjectId, RefName, FilePath are branded string types
- Domain code has zero platform dependencies
- Commands are built from primitives (same building blocks users get)

## Performance Priorities

1. Fanout binary search for pack index
2. LRU delta base cache
3. Zero-copy DataView parsing
4. Streaming inflate (no full-buffer)
5. Stat-cache for working tree
6. Platform-optimized hashing (SubtleCrypto / node:crypto)
7. Parallel I/O with bounded concurrency

## Development Workflow (MANDATORY)

Every feature follows this sequence. No exceptions. No skipping steps. When the user says **"apply the workflow"** (or any equivalent — "do the workflow", "follow our process", "the usual flow"), run the 8 steps below **in order**, top to bottom, without abbreviation.

### 1. Branch

Create a fresh branch off `main`, named with a conventional-commit type prefix: `feat/<topic>`, `fix/<topic>`, `ci/<topic>`, `chore/<topic>`, `docs/<topic>`. Never commit directly to `main`.

### 2. Design (`docs/design/<topic>.md`)

Write the first draft, then **self-review until convergence, max three times**, fixing every gap each pass. Stop as soon as a pass produces no changes (converged) — don't burn extra passes just to hit the cap. The design covers:
- TypeScript types and interfaces
- Binary/wire format details (if applicable)
- Function signatures and contracts
- Module structure and file layout
- Testing strategy (unit, property-based, interop)
- Key design decisions with rationale

Commit when stable: `docs(design): <topic>`.

### 3. ADR (`docs/adr/NNN-<title>.md`) — for every choice made with the user

Whenever a decision was reached in conversation with the user — naming, scoping, library selection, trade-off, anything they weighed in on — capture it as an ADR **before** moving on. This rule is stronger than "when choosing between alternatives": if the user's input shaped the choice, an ADR records it so the rationale survives the conversation. Mechanics:
- Use the template at `docs/adr/000-template.md`
- Number sequentially: `docs/adr/NNN-title.md`
- Status: `Accepted (at <main-sha>)`
- Document context, decision, consequences (positive, negative, neutral), and the alternatives considered.

Commit: `docs(adr): NNN <title>`.

### 4. Plan (`docs/plan/<topic>.md`)

Derive the plan from the design and ADRs. **Self-review until convergence, max three times**, fixing every issue each pass. Stop as soon as a pass yields no changes. Plan contents:
- Ordered list of files to create/modify
- Each step: what to test first, what to implement, what to verify
- Dependencies between steps

Commit: `docs(plan): <topic>`.

### 5. Implement (TDD, agent teams)

Follow the plan step by step. Use parallel agent teams (typescript-reviewer, test-review, security-reviewer, planner, refactor-cleaner, etc.) where it accelerates the work or improves quality. Write **atomic, easy-to-review commits** — one concept per commit, conventional-commit subjects.

For each unit of work:
- **Red**: write the test first; it must fail.
- **Green**: write minimal code to pass.
- **Refactor**: clean up while keeping tests green.
- Run `npm run validate` before committing.

### 6. Review the implementation three times

After implementation, run **three review passes** on the diff — code quality, performance, security, tests — fixing every finding each pass. Prefer the parallel-agent pattern (code-reviewer + security-reviewer + test-review + perf review in parallel), the same way the Phase 11 launch finalization did. The three passes ensure findings introduced by an earlier round of fixes get caught too.

### 7. Engineering harness green + mutation testing

- `npm run validate` — every check passes (lint, types, dead-code, duplicates, filesystem, architecture, spelling, deps, security, size, exports, 100% coverage on lines/branches/functions/statements, integration tests).
- `stryker run` — kill every killable mutant. Provably-equivalent mutants are accepted only when documented inline with a `// equivalent-mutant: <why>` comment.

### 8. Docs refresh, push, open PR

Update `README.md`, `RUNBOOK.md`, `CONTRIBUTING.md`, the relevant pages under `docs/get-started/` · `docs/use/` · `docs/understand/`, and any phase design docs that the implementation invalidated. **Flip every relevant `docs/BACKLOG.md` entry (`[ ]` / `[~]` → `[x]`) inside the PR's own commits** — never as a follow-up after merge. The squash-merge that closes the PR is what flips the line in `main`, so the tick must travel with the implementation, not chase it. Push the branch, open a PR with a thorough body (summary + test plan), and let CI exercise the full pipeline. Squash-merge on green. Cleanup: `git worktree remove`, `git branch -D`.

### Workflow summary

```
branch → design (until convergence, max ×3) → adr (every user-made choice) →
plan (until convergence, max ×3) → implement (TDD, agent teams, atomic commits) →
review ×3 → harness green + kill mutants → docs refresh + push + PR
```

Design and plan: stop the moment a review pass produces no changes — convergence wins; the `×3` is a ceiling, not a quota. Implementation review keeps the fixed three-pass cadence because each pass can introduce new findings that need re-review.

**Never skip design. Never code without a plan. Never decide with the user without an ADR. Never push without three review passes.**

## Docs

- `docs/BACKLOG.md` — V1 roadmap and progress tracker
- `docs/prd/` — Product requirements
- `docs/design/` — Technical design documents (one per phase/subsystem)
- `docs/plan/` — Implementation plans (step-by-step TDD sequences)
- `docs/adr/` — Architecture decision records (when choosing between alternatives)
- `docs/spike/` — Technical spike findings (research before design)
