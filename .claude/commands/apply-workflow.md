---
description: Run the in-session tsgit workflow on a backlog item, PRD file, or free-text feature description. Every phase runs in this session — no subagents.
argument-hint: <backlog-id | docs/prd/file.md | "feature description">
---

You are running tsgit's in-session development workflow (see `CLAUDE.md` §"Development Workflow"). Run the workflow on the input below **in this session, in-thread**. Do NOT spawn subagents (no `Agent` tool calls). Every phase — design, ADR, plan, implementation, review, mutation, docs, PR — happens here. The user sees every action as it happens.

## Input

```
$ARGUMENTS
```

## Step 0 — Resolve the input

Inspect the argument and decide which of three input forms it is:

1. **Backlog ID** — matches `^\d+(\.\d+)+$` (e.g. `20.6`, `22.4`, `25.5.1`). Look up the matching `[ ] **<id>**` entry in `docs/BACKLOG.md`. Extract the one-line description. The topic-slug is derived from the backlog item's wording (kebab-case, ≤6 words).

2. **File path** — exists on disk under `docs/prd/`, `docs/design/`, or any `.md` extension. Read the file. The topic-slug is derived from the filename (strip `.md`, kebab-case).

3. **Free-text description** — anything else. Treat as the design brief verbatim. The topic-slug is your kebab-case summary of the request (≤6 words).

If the resolution is ambiguous (e.g. backlog ID not found, file unreadable), STOP and ask the user.

Print one line so the user can confirm: `Resolved input → topic: <slug>, brief: <one-line summary>`.

## Step 1 — Branch

```bash
git worktree add ../tsgit-<slug> -b feat/<slug>
cd ../tsgit-<slug>
npm install
```

The TypeScript LSP tool is available for code navigation — no activation step needed; the LSP server starts on first use. Use it as the default for navigating source (`goToDefinition`, `findReferences`, `goToImplementation`, `documentSymbol`, `workspaceSymbol`, `hover`, call-hierarchy ops). Apply edits with `Edit` / `Write`; use `Read` / `Grep` for non-code files (markdown, JSON, generated artefacts).

If the branch already exists or the worktree path collides, STOP and ask the user.

## Step 2 — Design

Write `docs/design/<slug>.md` directly. Read the existing related design docs (`docs/design/`), ADRs (`docs/adr/`), and the codebase patterns it must follow (hexagonal architecture, branded types, GWT/AAA test conventions, 100% coverage, mutation-resistant tests — all per `CLAUDE.md`).

Self-review until convergence (max 3 passes — stop the moment a pass yields no changes). Commit: `docs(design): <slug>`.

## Step 3 — ADR conversation

For every load-bearing choice the design makes that's not pre-decided by existing ADRs:
- Surface the alternatives to the user (≤3 options each).
- Capture the user's decision as `docs/adr/NNN-<title>.md` using `docs/adr/000-template.md`.
- Number sequentially after the highest existing ADR.
- Commit each as `docs(adr): NNN <title>`.

If the design has no user-judgment decisions, skip to Step 4 without inventing questions. If user decisions deviate from the design's recommendations, revise the design doc to absorb them in a follow-up `docs(design): revise <slug> against ADRs <range>` commit BEFORE moving to Step 4.

## Step 4 — Plan

Write `docs/plan/<slug>.md` directly. The plan is the implementation script — per-slice TDD steps the next phase reads top-to-bottom. Self-review until convergence (max 3 passes). Commit: `docs(plan): <slug>`.

## Step 5 — Implementation

Execute every slice from the plan top-to-bottom:

- **Red**: write the test first; run it with `npx vitest run <file>`; it must fail for the stated reason.
- **Green**: write minimal code to pass; re-run the test file.
- **Refactor**: clean up while keeping tests green.
- Run `npm run validate` before each commit. NEVER commit on a red validate.
- One slice = one atomic conventional-commit.

Use the TypeScript LSP tool (`goToDefinition`, `findReferences`, `documentSymbol`, …) to navigate before editing; apply edits with `Edit` / `Write`. Never `--no-verify` the hook. Never insert `// @ts-ignore`, `// eslint-disable`, `// v8 ignore`, `// stryker-disable`, or `// biome-ignore`.

If blocked (design hits a wall, ADR-level decision needed, ambiguous spec): surface to the user with `{ slice, reason, ≤3 candidate options }`. Never spin, never silently abandon.

## Step 6 — Review × 3 (sequential, in-thread)

Run three review passes in this order:

1. **TypeScript review** — types, correctness, bugs, project conventions, immutability.
2. **Security review** — config/path/URL injection, traversal, SSRF, resource exhaustion, cache poisoning.
3. **Test review** — mutation gaps, coverage holes, isolation, GWT/AAA conventions.

For each: read the branch's diff (`git diff main...HEAD`), identify every finding, **apply fixes directly**, run `npm run validate` after each fix batch, self-review until the next pass yields zero findings (max 3 cycles per reviewer).

**Security gate:** for HIGH/CRITICAL security findings, surface the fix diff to the user BEFORE committing. MEDIUM/LOW security findings + all typescript/test findings: fix-all-then-converge, no user round-trip.

Commit fixes per reviewer as conventional commits (e.g. `refactor(config): apply typescript-review fixes`, `fix(security): tighten path validator`, `test(coverage): close gap surfaced by test-review`).

## Step 7 — Architecture refactor + scoped re-review (in-thread)

Implementation and the three reviews are scoped to the diff. This pass widens the lens: with the feature landed, look across the **whole codebase** for structural gains the scoped passes can't see — duplication that now warrants centralizing, a responsibility sitting in the wrong layer, the Nth consumer of a pattern that should become a shared primitive/port. Improve SOLID / hexagonal layering / SoC / DRY; stay bounded by YAGNI + KISS — no speculative abstraction.

Discovery is **seeded by the feature's diff** and radiates only as far as the feature's concerns reach.

**Contract:**

- **Behavior-preserving:** tests change only mechanically (moved/renamed). `npm run validate` stays green throughout. No public-API behavior change.
- **Bounded blast radius:** every change traces back to the feature's concerns. A cross-cutting opportunity unrelated to the feature is *not* done here — log it as a `docs/BACKLOG.md` follow-up entry.
- **May be a no-op:** if the code is already in good shape, the step still emits a 1–3 line written justification of what was considered and why nothing changed. A silent skip is not allowed.
- **May defer:** follow-ups recorded explicitly (backlog), left for a dedicated step; this pass never balloons the PR.
- **Atomic commits:** each refactor lands as its own `refactor(<scope>): <what>` commit, separate from the feature commits.

Then **re-review**, scoped to *only* the refactor diff (`git diff` of the `refactor(...)` commits), through the same three lenses (typescript / security / tests), fix-all-until-converged (≤3 cycles), re-validate. Findings that imply *further* refactoring become follow-ups, not another refactor loop.

**Why here (before mutation):** mutation testing scores test strength against the *final* code shape. Refactoring after mutation would invalidate the run and force a costly redo. Refactor → re-review → green validate → then mutation.

## Step 8 — Mutation testing

Run `npm run test:mutation` (or `stryker run`). Per surviving mutant: kill it with a new test, or document it inline as `// equivalent-mutant: <why>` when provably equivalent. Re-run until 0 killable survivors. Commit each kill as `test(mutation): <module>`.

If the project has no mutation config or the run is intractable (>30 min), surface to the user.

## Step 9 — Docs refresh + PR

Update `README.md`, `RUNBOOK.md`, `CONTRIBUTING.md`, and the relevant `docs/get-started/` / `docs/use/` / `docs/understand/` pages. Flip the `docs/BACKLOG.md` entry (`[ ]` / `[~]` → `[x]`) inside this PR's commits. Push the branch with `-u origin`. Run `gh pr create` with a thorough body (summary + test plan).

## Step 10 — Cleanup

Surface the PR URL. Wait for confirmation that CI is green and the PR is squash-merged. Then:

```bash
git worktree remove ../tsgit-<slug>
git branch -D feat/<slug>
```

## Hard rules

- **NEVER spawn subagents.** The whole workflow runs in this session. The user sees every action, can interrupt at any point, can steer mid-flight.
- **Never skip the ADR step** when user-judgment was required to disambiguate the design.
- **Never skip the three review passes** before pushing.
- **Never skip the architecture refactor pass** (Step 7). It may be a no-op, but a no-op must carry a written justification — never a silent skip. Refactor commits are atomic and behavior-preserving, and are re-reviewed before mutation.
- **Never `--no-verify` the commit hook**, never use ignore directives.
- **Never include phase/ADR refs inside source or test code** (`§X.Y.Z`, `Phase N`, `ADR-NNN`, `BACKLOG 20.6` etc.). Those belong in the design doc and PR body. Source code is silent about its provenance.
- **Be git-faithful** unless an ADR explicitly diverges.

When done, the final message to the user is the PR URL + a one-line summary of what shipped.
