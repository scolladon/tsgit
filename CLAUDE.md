# tsgit — Project Instructions

## What is this?

A pure TypeScript git library. Lightning-fast, portable (Node.js + browser), zero dependencies.

## Git-faithfulness (prime directive)

Replicate canonical git's **observable behaviour byte-for-byte** — object SHAs, ref & reflog contents, on-disk state files (`sequencer/`, `MERGE_HEAD`, `CHERRY_PICK_HEAD`, …), refusal conditions, and message formats — **unless an ADR explicitly diverges and says why**. This is a project-wide invariant, not scoped to any workflow: it binds every change. Verify against real `git` (scrubbed `GIT_*`, signing off) rather than guessing; pin the result with a cross-tool interop test. Enforced by the interop harness + parity goldens + write-surface audit. See [ADR-226](docs/adr/226-git-faithfulness-prime-directive.md).

## Structured output, not cosmetics

The library returns **data in a structured shape**; representing it — date formats, number formatting, output layout, hash abbreviation, suffixes/markers — is the **caller's** responsibility. A command surface must not carry options whose only job is to steer rendered text (`--long`, `--abbrev=<n>`, `--pretty`/`--format`, `--date=<mode>`, `--stat` widths, dirty `=<mark>`, …), nor return a pre-rendered line/`bytes`. Ship the underlying fields (oids, counts, timestamps, enums, booleans) and let the consumer format them.

This **refines** the prime directive: byte-for-byte faithfulness binds the **data and on-disk state** (SHAs, refs, reflogs, state files, refusal conditions), not the **human-readable stdout** git prints. Pin faithfulness by reconstructing git's display *in the interop test* from the structured fields and comparing to real `git` — the library itself emits no display string. New commands follow this from day one; existing rendering-bearing commands (`show`, `log`, …) are swept by backlog **26.8**. See [ADR-249](docs/adr/249-describe-structured-data-only.md).

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

### Property-Based Testing (when to reach for `fast-check`)

Example tests prove specific inputs round-trip; property tests prove the *grammar* round-trips. They are not interchangeable — example tests document literal Git on-disk encodings, property tests catch grammar-level bugs the examples can't enumerate.

**When property tests are appropriate** — touch the new/changed code with all four lenses; if any one fits, ship a `*.properties.test.ts` sibling alongside the example test:

1. **Round-trip pair** — code under test is half of a `parse`/`serialize` (or `compile`/`render`, `encode`/`decode`) pair. Property: `parse(serialize(x)) ≡ x` (modulo documented canonicalisation, e.g. sort order).
2. **Compositional matcher / aggregator** — function reduces an array of rules/entries/levels to a verdict (e.g. `matchesPathspec`, `matchInStack`, `matches`). Property: invariant shapes — empty input returns the identity, appending a non-negated match makes the verdict true, appending its negation flips it back.
3. **Total function over an algebraic grammar** — compiler / validator that should *never* throw on any input within a declared safe subset (e.g. `compilePathspec` over ASCII no-NUL). Property: `compile(any p in safeSubset)` returns a callable matcher.
4. **Idempotence / counting invariant** — parser whose output should re-parse to the same structure (e.g. `parseGitignore(rulesToText(parseGitignore(x))) ≡ parseGitignore(x)`), or where a syntactic input feature should map 1:1 to a semantic output feature (`!`-prefixed lines ↔ negated rules count).

**When property tests are NOT appropriate (skip them, no virtue points):**

- Single-purpose UI / orchestration code with no algebraic structure.
- Functions whose only inputs are a small enum (3–10 values) — a parameterised example sweep does the same job clearer.
- I/O wrappers, transport middleware, command facades — these belong in integration / parity tests, not property tests.
- A property that requires re-implementing the production loop as the oracle. If the oracle is a verbatim copy of the SUT, you have a tautology, not a property. Rewrite as invariants (case 2 above) or delegate to an *independently tested* sibling function.

**Layout and budget** (per ADRs 134–136):

- Property tests live in `<parser>.properties.test.ts` next to the example file, never mixed in. Per-family generators live in a shared `arbitraries.ts` in the same directory.
- Tiered `numRuns`: **200** for cheap round-trip properties, **100** (default) for composition / invariant properties, **50** for filter-heavy negative properties.
- Properties are *additive*: never delete an example test in the same PR that adds a property — the example documents the literal Git format, the property proves the grammar.
- Same describe/it / AAA / `sut` conventions as example tests. `Given` reads "Given an arbitrary X".
- Never commit a seed. Failing properties shrink to a counterexample; the seed is printed locally for repro, not pinned.

If the work touches a parser/decoder/matcher and the diff lands without a `*.properties.test.ts` sibling, surface the gap in the review pass and either add the property or note why the four lenses above don't fit.

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

The operational workflow lives in **`.claude/commands/apply-workflow.md`** (run via `/apply-workflow <backlog-id | file | description>`). It runs every phase **in the current session, in-thread** — no subagents — so every action is visible and steerable.

Phase sequence: **branch → design (self-review ≤×3) → ADR (with user) → plan (self-review ≤×3) → implement (TDD per slice, atomic commits) → review ×3 (typescript / security / tests, fix-all-until-converged) → architecture refactor + scoped re-review (behavior-preserving, may no-op with justification) → mutation (0 killable) → docs + PR**.

**Precedence:** this in-repo workflow supersedes the user-global "Default feature workflow" when working inside this repository. The project triggers (`"apply the workflow"`, `/apply-workflow`, "the usual flow") drive it; the user-global workflow fires only on its own trigger (`"use my default workflow"`).

**Non-negotiables:** never commit on a red `npm run validate`; never `--no-verify`; never use ignore directives (`@ts-ignore` / `v8 ignore` / `stryker-disable` / `biome-ignore`); never include phase/ADR refs inside source or test code; be git-faithful unless an ADR diverges. Escalate blockers as `{ slice/finding, reason, ≤3 options }` — never spin, never silently abandon.

## Docs

- `docs/BACKLOG.md` — V1 roadmap and progress tracker
- `docs/prd/` — Product requirements
- `docs/design/` — Technical design documents (one per phase/subsystem)
- `docs/plan/` — Implementation plans (step-by-step TDD sequences)
- `docs/adr/` — Architecture decision records (when choosing between alternatives)
- `docs/spike/` — Technical spike findings (research before design)
