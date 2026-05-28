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

Every feature follows this sequence. No exceptions. No skipping steps. When the user says **"apply the workflow"** (or any equivalent — "do the workflow", "follow our process", "the usual flow"), the orchestrator (this session) **delegates each phase to a dedicated subagent** and itself only handles ADR conversations with the user + final cleanup. The orchestrator's context never holds source code; it reads design.md, plan.md, the mutation report, and the PR URL.

### Subagent map

| Phase | Agent | Model | Self-loop contract |
|---|---|---|---|
| 1. Branch | orchestrator | — | one-shot worktree + branch |
| 2. Design | subagent | opus | self-review until convergence, ≤3 passes |
| 3. ADR | orchestrator (with user) | opus | one ADR per user-driven decision |
| 4. Plan | subagent | opus | self-review until convergence, ≤3 passes |
| 5. Implementation | subagent (single, runs all slices) | opus | TDD per slice, `npm run validate` before each commit, escalate to orchestrator on a blocker |
| 6. Review × 3 | three subagents in parallel | opus | each fixes its OWN findings until self-review converges, runs `npm run validate` after each batch |
| 7. Mutation | subagent | sonnet | iterate until 0 killable mutants, document equivalents inline |
| 8. Harness + PR | subagent | haiku | run validate, flip BACKLOG, update README/RUNBOOK/CONTRIBUTING/docs, push, `gh pr create` |

There is no "effort" knob in the Agent tool — only `model`. Depth comes from model choice + the prompt instructions in each phase below. Don't burn an Opus on Phase 7 or 8; don't burn a Haiku on Phase 2 or 5.

### 1. Branch (orchestrator)

Create a fresh branch off `main` via `git worktree add`, named with a conventional-commit type prefix: `feat/<topic>`, `fix/<topic>`, `ci/<topic>`, `chore/<topic>`, `docs/<topic>`. Never commit directly to `main`. `npm install` inside the worktree.

### 2. Design — `docs/design/<topic>.md` (Opus subagent)

Spawn one Opus subagent. Brief: the backlog item, the existing related design docs, the codebase patterns it must follow (hex architecture, types, conventions).

**Subagent contract** — produce the draft, then self-review until convergence (max 3 passes). Each pass fixes every gap; stop the moment a pass yields no changes. The design covers:
- TypeScript types and interfaces
- Binary/wire format details (if applicable)
- Function signatures and contracts
- Module structure and file layout
- Testing strategy (unit, property-based, interop)
- Key design decisions with rationale + alternatives considered

Subagent commits `docs(design): <topic>` and returns the final doc path. Orchestrator reads only the final doc.

### 3. ADR — `docs/adr/NNN-<title>.md` (orchestrator with user)

The orchestrator handles ADRs because they require user judgment on alternatives. Whenever a decision was reached in conversation with the user — naming, scoping, library selection, trade-off, anything they weighed in on — capture it as an ADR **before** moving on. Mechanics:
- Use the template at `docs/adr/000-template.md`
- Number sequentially
- Status: `Accepted (at <main-sha>)`
- Document context, decision, consequences (positive, negative, neutral), alternatives considered

Commit: `docs(adr): NNN <title>`.

### 4. Plan — `docs/plan/<topic>.md` (Opus subagent)

Spawn one Opus subagent. Brief: the design doc + the relevant ADRs.

**Subagent contract** — produce the plan, then self-review until convergence (max 3 passes). Plan contents:
- Ordered list of files to create/modify
- Each step: what to test first (Red), what to implement (Green), what to verify
- Dependency graph between slices (which are parallel-safe)

Subagent commits `docs(plan): <topic>` and returns the final doc path.

### 5. Implementation — TDD, all slices in ONE subagent (Opus)

Spawn ONE Opus subagent for the whole implementation. Brief: the design doc, the plan, the relevant ADRs.

**Subagent contract** — execute every slice top-to-bottom:
- **Red**: write the test first; it must fail.
- **Green**: write minimal code to pass.
- **Refactor**: clean up while keeping tests green.
- Run `npm run validate` before each commit; commit one atomic conventional-commit per slice.
- On a blocker the subagent cannot resolve (design hits a wall, ADR-level decision needed, ambiguous spec), it MUST escalate to the orchestrator with a specific question — never spin or silently give up.
- Returns the commit list when done.

Do NOT split implementation across multiple subagents; the slice split exists for plan-level atomicity, not for orchestrator round-trips. One session per phase keeps the cache warm and the context coherent.

### 6. Review × 3 — three Opus subagents in parallel, fix-all-until-converged

Spawn three Opus subagents in parallel:
- **typescript-reviewer** — types, correctness, bugs, project conventions, immutability
- **security-reviewer** — config/path/url injection, traversal, SSRF, resource exhaustion, cache poisoning
- **test-review** — mutation gaps, coverage holes, isolation, GWT/AAA conventions

**Subagent contract (each)** — review the diff, fix every finding it identifies (not just report — actually apply Edits), run `npm run validate` after each fix batch, self-review until its own next pass yields zero findings or the convergence cap (3) is hit. Returns: "applied N fixes, here's the list, final state validate-green".

**Exception:** for HIGH/CRITICAL security findings, the security subagent surfaces the fix diff to the orchestrator BEFORE committing — the orchestrator confirms or revises. MEDIUM/LOW security findings + all other reviewers' findings: fix-all-then-converge, no orchestrator round-trip.

### 7. Mutation testing — Sonnet subagent

Spawn one Sonnet subagent. Brief: `stryker run` output / report file path.

**Subagent contract** — iterate per surviving mutant: read it, kill it with a test, or document it inline as `// equivalent-mutant: <why>` when provably equivalent. Re-run `stryker` until 0 killable survivors. Commit each kill as `test(mutation): <module>`. Returns: "0 killable mutants, N equivalents documented".

### 8. Docs refresh + PR — Haiku subagent

Spawn one Haiku subagent. Brief: the design doc + the commit list.

**Subagent contract** — update `README.md`, `RUNBOOK.md`, `CONTRIBUTING.md`, the relevant pages under `docs/get-started/` · `docs/use/` · `docs/understand/`, and any phase design docs that the implementation invalidated. Flip every relevant `docs/BACKLOG.md` entry (`[ ]` / `[~]` → `[x]`) inside the PR's own commits — never as a follow-up after merge. Push the branch, open a PR with `gh pr create` (thorough body: summary + test plan). Returns the PR URL.

The orchestrator handles squash-merge on green CI + worktree cleanup (`git worktree remove`, `git branch -D`) after the user confirms the merge.

### Workflow summary

```
branch (orch)
  → design subagent (opus, self-review ≤×3)
  → ADR (orch + user)
  → plan subagent (opus, self-review ≤×3, takes design as input)
  → implementation subagent (opus, all slices, TDD, escalation contract)
  → review × 3 subagents (opus, parallel, fix-all-until-converged)
  → mutation subagent (sonnet, until 0 killable)
  → docs + PR subagent (haiku)
  → orch: squash-merge + worktree cleanup
```

Design and plan: stop the moment a self-review pass produces no changes — convergence wins; ×3 is a ceiling, not a quota. Implementation reviews keep the convergence loop (each fix can introduce a new finding).

**Never skip design. Never code without a plan. Never decide with the user without an ADR. Never push without the three review subagents.**

### Escalation contract (every subagent)

A subagent MUST escalate to the orchestrator when:
- A decision requires the user's judgment (ADR-level choice).
- It cannot make `npm run validate` green after 3 fix attempts.
- It discovers the design or plan is wrong and needs a revision.

Escalation = return a structured message: "blocked at <slice/finding>, reason: <one line>, candidates: <≤3 options>". Never spin, never silently abandon.

## Docs

- `docs/BACKLOG.md` — V1 roadmap and progress tracker
- `docs/prd/` — Product requirements
- `docs/design/` — Technical design documents (one per phase/subsystem)
- `docs/plan/` — Implementation plans (step-by-step TDD sequences)
- `docs/adr/` — Architecture decision records (when choosing between alternatives)
- `docs/spike/` — Technical spike findings (research before design)
