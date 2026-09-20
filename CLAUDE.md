# tsgit — Project Instructions

## What is this?

A pure TypeScript git library. Lightning-fast, portable (Node.js + browser), zero dependencies.

## Git-faithfulness (prime directive)

Replicate canonical git's **observable behaviour byte-for-byte** — object SHAs, ref & reflog contents, on-disk state files (`sequencer/`, `MERGE_HEAD`, `CHERRY_PICK_HEAD`, …), refusal conditions, and message formats — **unless an ADR explicitly diverges and says why**. This is a project-wide invariant, not scoped to any workflow: it binds every change. Verify against real `git` (scrubbed `GIT_*`, signing off) rather than guessing; pin the result with a cross-tool interop test. Enforced by the interop harness + parity goldens + write-surface audit. See [ADR-226](docs/adr/226-git-faithfulness-prime-directive.md).

## Structured output, not cosmetics

The library returns **data in a structured shape**; representing it — date formats, number formatting, output layout, hash abbreviation, suffixes/markers — is the **caller's** responsibility. A command surface must not carry options whose only job is to steer rendered text (`--long`, `--abbrev=<n>`, `--pretty`/`--format`, `--date=<mode>`, `--stat` widths, dirty `=<mark>`, …), nor return a pre-rendered line/`bytes`. Ship the underlying fields (oids, counts, timestamps, enums, booleans) and let the consumer format them.

This **refines** the prime directive: byte-for-byte faithfulness binds the **data and on-disk state** (SHAs, refs, reflogs, state files, refusal conditions), not the **human-readable stdout** git prints. Pin faithfulness by reconstructing git's display *in the interop test* from the structured fields and comparing to real `git` — the library itself emits no display string. New commands follow this from day one; existing rendering-bearing commands (`show`, `log`, …) are swept by backlog **23.2a**. See [ADR-249](docs/adr/249-describe-structured-data-only.md).

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

## Code Navigation (serena + graft)

Routing table, rationale and measurements live in
[`.claude/workflow/code-navigation.md`](.claude/workflow/code-navigation.md), which the
craft manifest injects as global context into every agent — it is the single home, do not
restate it here. Measurements: [`docs/spike/code-graph-tool-selection.md`](docs/spike/code-graph-tool-selection.md).

- **serena — precision and all writes.** Exact references, symbol bodies, renames,
  diagnostics. The **only** tool that resolves `export type *` barrels, so every
  "who uses this re-exported symbol" question is serena's.
- **graft — cheap breadth.** `graft ask` to orient, `graft skeleton` for a file's
  signatures (~6× cheaper than reading it). Deterministic tier only — never
  `graft build --deep`.

Loop: `graft ask` → `graft skeleton` → serena `find_symbol` /
`find_referencing_symbols` → serena `replace_*`.

**Activate serena on the active worktree first** (`mcp__serena__activate_project` with the
absolute worktree path, e.g. `/abs/path/tsgit-<slug>`), then use its symbol/LSP tools as
the default for editing and precise navigation. Its LSP is rooted at the **worktree**;
the harness LSP is rooted at the **main** checkout and reports spurious cross-root
`Cannot find module` errors plus stale content for sibling worktrees. Activation and the
end-of-workflow `~/.serena` prune are a matched pair. Fall back to `Edit`/`Write` only
when serena can't do it; `Read`/`Grep` only for non-code files or a quick literal scan.

LSP/serena diagnostics are advisory only; the ground-truth gate is always
`npm run validate` (and `npm run check:types`).


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
- **Triage suspected false survivors before writing kill tests:** the procedure (and all Stryker run scoping) lives in `.claude/workflow/mutation.md` — its single home, used by the craft validation phase.

### Property-Based Testing

Parsers, decoders, matchers and serializers get a `*.properties.test.ts` sibling alongside the example test — properties prove the *grammar* round-trips, examples document the literal Git encoding; they are additive, never substitutes. The four lenses that decide whether a property fits, the cases where they don't, and the layout/`numRuns` budget live in [`.claude/workflow/property-testing.md`](.claude/workflow/property-testing.md) (ADRs 134–136). If a diff touches one of those shapes without a property sibling, surface the gap in review and either add it or note which lens fails.


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

The workflow is the **craft plugin**: run `/craft:run <backlog-id | file | description>`.
The repo customizes it through the committed declination manifest
[`.claude/workflow.md`](.claude/workflow.md) plus `.claude/workflow/` — that manifest is
the single source of truth for gates, models, phase contexts and PR policy; do not restate
its values here. Triggers: `"apply the workflow"`, `"the usual flow"`, or `/craft:run`
directly. Phase skills also run standalone — `/craft:review` (four-dimension battery on
the current branch), `/craft:validation` (scoped Stryker run + triage).

Phase sequence: **workspace → design → decisions (ADRs, with user) → planning ->
implementation (TDD per part, atomic commits) → review x4 (code / security / tests / perf,
per-dimension convergence) → refactoring (behaviour-preserving, may no-op with written
justification) → validation (mutation; gates the PR) → documentation → propose (PR) ->
integrate (merge + cleanup)**. The session orchestrates and verifies; agents produce
committed artifacts.

**Non-negotiables** (hook-enforced where mechanical — see `.claude/hooks/` and the craft
plugin hooks): never commit on a red `npm run validate`; never `--no-verify`; never use
ignore directives (`@ts-ignore` / `v8 ignore` / `stryker-disable` / `biome-ignore`); never
include phase/ADR refs inside source or test code; be git-faithful unless an ADR diverges.
Escalate blockers as `{ unit, reason, ≤3 options }` — never spin, never silently abandon.


## Docs

- `docs/BACKLOG.md` — V1 roadmap and progress tracker
- `docs/prd/` — Product requirements
- `docs/design/` — Technical design documents (one per phase/subsystem)
- `docs/plan/` — Implementation plans (step-by-step TDD sequences)
- `docs/adr/` — Architecture decision records (when choosing between alternatives)
- `docs/spike/` — Technical spike findings (research before design)
