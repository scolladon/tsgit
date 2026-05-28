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

Every feature follows this sequence. No exceptions. No skipping steps. When the user says **"apply the workflow"** (or any equivalent — "do the workflow", "follow our process", "the usual flow"), the assistant runs **every phase in the current session, in-thread**. No subagents are spawned. The user sees every action as it happens and can intervene at any point.

### Precedence

**This workflow supersedes any user-global "Default feature workflow" or `~/.claude/rules/common/development-workflow.md` Feature Implementation Workflow when working inside this repository.** When both could plausibly apply, this project's in-session workflow wins. The user-global workflow only fires on its own explicit trigger phrase (`"use my default workflow"` etc.) — never on this project's triggers (`"apply the workflow"` etc.).

### Why no subagents

Earlier iterations of this workflow used a subagent-per-phase model. It failed in practice for three reasons:

1. **Context loss.** Each subagent boots cold and has to re-read the design / plan / ADRs from scratch — repeating work the orchestrator already did.
2. **Hidden execution.** Subagents run in their own context. When they stall, fail a validate, or pick a debatable resolution, the user only learns at return time. Mid-flight steering is impossible.
3. **LSP/MCP scope mismatch.** Serena's LSP delivers diagnostics to whichever context called `activate_project`. Routing in a shared MCP server is asymmetric — diagnostics from subagent edits ended up surfacing in the orchestrator's reminder stream as if they were tool rejections, leaving the orchestrator unable to tell whether the subagent was making progress or stuck.

Running every phase in the current session removes all three failure modes: shared context across phases, every action visible, all diagnostics scoped to the one agent doing the work.

### Phase map (in-session)

| Phase | What happens | Self-loop contract |
|---|---|---|
| 1. Branch | `git worktree add` + `npm install` + activate Serena on the worktree | one-shot |
| 2. Design | write `docs/design/<topic>.md` in-thread; self-review until convergence (≤3 passes) | stop the moment a pass yields zero diffs |
| 3. ADR | surface decisions to user; write `docs/adr/NNN-<title>.md` per accepted decision | one ADR per user-driven decision |
| 4. Plan | write `docs/plan/<topic>.md` in-thread; self-review until convergence (≤3 passes) | stop the moment a pass yields zero diffs |
| 5. Implementation | TDD per slice; `npm run validate` before each commit; one atomic conventional-commit per slice | escalate to user on a blocker |
| 6. Review × 3 | run three review passes in-thread, sequentially (typescript / security / tests); fix every finding; re-validate | converge until a pass yields zero findings |
| 7. Mutation | `npm run test:mutation`; per surviving mutant kill with a test or annotate `// equivalent-mutant: <why>`; re-run until 0 killable | one kill = one `test(mutation): <module>` commit |
| 8. Docs + PR | update `README.md`, `RUNBOOK.md`, `CONTRIBUTING.md`, the relevant `docs/get-started/` · `docs/use/` · `docs/understand/` pages; flip `docs/BACKLOG.md` entry; push; `gh pr create` | thorough PR body (summary + test plan) |

### Serena activation

Activate Serena once at the start of Step 1 (after `npm install`) on the worktree's absolute path:

- `mcp__serena__activate_project` with the worktree's absolute path.
- `mcp__serena__initial_instructions` to load the manual.

Use Serena's symbol tools (`find_symbol`, `find_referencing_symbols`, `get_symbols_overview`, `replace_symbol_body`, `insert_after_symbol`, `insert_before_symbol`, `replace_content`) as the default for navigating and editing source. Fall back to `Read` / `Edit` / `Grep` only for non-code files (markdown, JSON, generated artefacts).

All LSP diagnostics now stay in this one session — no cross-context routing.

### 1. Branch

Create a fresh branch off `main` via `git worktree add`, named with a conventional-commit type prefix: `feat/<topic>`, `fix/<topic>`, `ci/<topic>`, `chore/<topic>`, `docs/<topic>`. Never commit directly to `main`. `npm install` inside the worktree. Activate Serena.

### 2. Design — `docs/design/<topic>.md`

Write the design in-thread. Self-review until convergence (max 3 passes). Each pass fixes every gap; stop the moment a pass yields zero diffs. The design covers:

- TypeScript types and interfaces
- Binary/wire format details (if applicable)
- Function signatures and contracts
- Module structure and file layout
- Testing strategy (unit, property-based, interop)
- Key design decisions with rationale + alternatives considered

Commit: `docs(design): <topic>`.

### 3. ADR — `docs/adr/NNN-<title>.md`

Whenever a decision in the design needs user judgment — naming, scoping, library selection, trade-off, anything the user must weigh in on — surface alternatives to the user (≤3 options each). Capture each accepted decision as an ADR **before** moving on:

- Use the template at `docs/adr/000-template.md`
- Number sequentially
- Status: `Accepted (at <main-sha>)`
- Document context, decision, consequences (positive, negative, neutral), alternatives considered

Commit each: `docs(adr): NNN <title>`.

If the design surfaces no user-judgment decisions (everything is pre-decided or mechanical), skip ADRs.

### 4. Plan — `docs/plan/<topic>.md`

Write the plan in-thread. Self-review until convergence (max 3 passes). Plan contents:

- Ordered list of files to create/modify
- Each step: what to test first (Red), what to implement (Green), what to verify
- Dependency graph between slices (which are parallel-safe)
- Commit message for each slice

Commit: `docs(plan): <topic>`.

### 5. Implementation — TDD, all slices in-thread

Execute every slice from the plan top-to-bottom:

- **Red**: write the test first; run it; it must fail for the stated reason.
- **Green**: write minimal code to pass; re-run the test file.
- **Refactor**: clean up while keeping tests green.
- Run `npm run validate` before each commit. NEVER commit on a red validate.
- One slice = one atomic conventional-commit.

On a blocker (design hits a wall, ADR-level decision needed, ambiguous spec): surface to the user with `{ slice, reason, ≤3 candidate options }`. Never spin, never silently abandon, never `--no-verify`, never use `// @ts-ignore` / `// eslint-disable` / `// v8 ignore` / `// stryker-disable` / `// biome-ignore`.

### 6. Review × 3 — sequential, in-thread, fix-all-until-converged

Run three review passes in sequence, in this order:

1. **TypeScript review** — types, correctness, bugs, project conventions, immutability.
2. **Security review** — config/path/url injection, traversal, SSRF, resource exhaustion, cache poisoning.
3. **Test review** — mutation gaps, coverage holes, isolation, GWT/AAA conventions.

For each: read the branch's diff (`git diff main...HEAD`), identify every finding, **apply fixes directly**, run `npm run validate` after each fix batch, self-review until the next pass yields zero findings (max 3 cycles per reviewer).

**Exception:** for HIGH/CRITICAL security findings, surface the fix diff to the user BEFORE committing. MEDIUM/LOW security findings + all other findings: fix-all-then-converge, no user round-trip.

### 7. Mutation testing — in-thread

Run `npm run test:mutation` (or `stryker run`). For each surviving mutant: read it, kill it with a new test, or document it inline as `// equivalent-mutant: <why>` when provably equivalent. Re-run until 0 killable survivors. Commit each kill as `test(mutation): <module>`.

### 8. Docs refresh + PR — in-thread

Update `README.md`, `RUNBOOK.md`, `CONTRIBUTING.md`, the relevant pages under `docs/get-started/` · `docs/use/` · `docs/understand/`, and any phase design docs that the implementation invalidated. Flip every relevant `docs/BACKLOG.md` entry (`[ ]` / `[~]` → `[x]`) inside the PR's own commits — never as a follow-up after merge. Push the branch with `-u origin`. Run `gh pr create` with a thorough body (summary + test plan).

The user handles squash-merge on green CI; this session handles worktree cleanup (`git worktree remove`, `git branch -D`) after the user confirms the merge.

### Workflow summary

```
branch (worktree + npm install + activate Serena)
  → design (in-thread, self-review ≤×3)
  → ADR (in-thread + user)
  → plan (in-thread, self-review ≤×3)
  → implementation (in-thread, TDD per slice, escalate on blocker)
  → review × 3 (in-thread, sequential, fix-all-until-converged)
  → mutation (in-thread, until 0 killable)
  → docs + PR (in-thread)
  → user: squash-merge + this session: worktree cleanup
```

Design and plan: stop the moment a self-review pass produces no changes — convergence wins; ×3 is a ceiling, not a quota. Review keeps the convergence loop (each fix can introduce a new finding).

**Never skip design. Never code without a plan. Never decide with the user without an ADR. Never push without the three review passes.**

### Escalation contract

The assistant MUST surface a blocker to the user when:
- A decision requires user judgment (ADR-level choice).
- `npm run validate` cannot be made green after 3 honest fix attempts.
- The design or plan is wrong and needs a revision.

Escalation format: "blocked at <slice/finding>, reason: <one line>, candidates: <≤3 options>". Never spin, never silently abandon.

## Docs

- `docs/BACKLOG.md` — V1 roadmap and progress tracker
- `docs/prd/` — Product requirements
- `docs/design/` — Technical design documents (one per phase/subsystem)
- `docs/plan/` — Implementation plans (step-by-step TDD sequences)
- `docs/adr/` — Architecture decision records (when choosing between alternatives)
- `docs/spike/` — Technical spike findings (research before design)
