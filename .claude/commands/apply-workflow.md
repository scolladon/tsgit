---
description: Run the tsgit workflow on a backlog item, PRD file, or free-text feature description. Heavy phases are delegated to model-matched subagents (fable for design/plan/review/refactor, sonnet for slices/mutation-triage, haiku for mechanical docs); the session orchestrates, decides with the user, applies review fixes, and owns the synthesis artifacts (ADRs, backlog follow-ups, PR body).
argument-hint: <backlog-id | docs/prd/file.md | "feature description">
---

You are running tsgit's development workflow (see `CLAUDE.md` §"Development Workflow"). The session is the **orchestrator**: it resolves the input, talks to the user (ADRs, escalations), verifies every delegated artifact, applies review fixes, runs the phase-boundary gates, and owns all synthesis (backlog follow-ups, PR body, merge). Heavy exploration and production runs in **model-matched subagents** per the delegation map in the Hard rules — this keeps the session's context lean (cheaper every later turn) without lowering the quality bar where it matters.

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

**Activate Serena on the fresh worktree immediately** — `mcp__serena__activate_project` with the absolute worktree path (`/abs/path/tsgit-<slug>`). Serena's activated-project LSP is rooted at the worktree, so cross-file navigation/rename reflect the worktree's own edits; the harness LSP tool is single-rooted at the *main* repo and only sees declarations for worktree files. Use Serena symbol/LSP tools (`find_symbol`, `find_referencing_symbols`, `rename_symbol`, `get_symbols_overview`, …) as the default for navigating and editing source; fall back to the harness LSP tool or `Edit` / `Write` only when Serena can't do it; use `Read` / `Grep` for non-code files (markdown, JSON, generated artefacts).

If the branch already exists or the worktree path collides, STOP and ask the user.

## Step 2 — Design (fable subagent)

Delegate the design to a dedicated subagent (`Agent` tool, `model: "fable"`, general-purpose type). Its prompt carries: the resolved brief, the absolute worktree path (work ONLY there; Serena already active — symbol tools right away, no `activate_project`), and this contract:

- Read the related design docs (`docs/design/`), ADRs (`docs/adr/`), and the codebase patterns the feature must follow (hexagonal architecture, branded types, GWT/AAA test conventions, 100% coverage, mutation-resistant tests — all per `CLAUDE.md`).
- When git-faithfulness is in play, **pin real git's behaviour empirically** (scrubbed env, isolated HOME, signing off) and record the pinned matrix in the doc — never design from memory of git.
- Write `docs/design/<slug>.md`; self-review until convergence (max 3 passes). Commit: `docs(design): <slug>`.
- Return: the doc path + a list of **decision candidates** — every load-bearing choice not pre-decided by existing ADRs, each with ≤3 alternatives and a recommendation. The agent NEVER decides those itself; the user does, in Step 3.

The session reads the returned doc (not the agent's exploration), sanity-checks it against the brief, and carries the decision candidates into Step 3.

## Step 3 — ADR conversation

For every load-bearing choice the design makes that's not pre-decided by existing ADRs:
- Surface the alternatives to the user (≤3 options each).
- Capture the user's decision as `docs/adr/NNN-<title>.md` using `docs/adr/000-template.md`.
- Number sequentially after the highest existing ADR.
- Commit each as `docs(adr): NNN <title>`.

If the design has no user-judgment decisions, skip to Step 4 without inventing questions. If user decisions deviate from the design's recommendations, revise the design doc to absorb them in a follow-up `docs(design): revise <slug> against ADRs <range>` commit BEFORE moving to Step 4.

## Step 4 — Plan (fable subagent)

Delegate to a fable subagent (same worktree + Serena-already-active hygiene as Step 2; pass the design doc path + the accepted ADRs). It writes `docs/plan/<slug>.md`, self-reviews until convergence (max 3 passes), commits `docs(plan): <slug>`.

The plan is the implementation script **and the knowledge handoff**: the session no longer explores the code itself, so whatever the plan omits is paid later as slice-agent rediscovery. Hard contract — **every slice block carries a pre-chewed context section**: exact file paths and symbol name-paths to touch, current signatures being changed, the helpers/fixtures/describe blocks to extend and where they live, and any pinned behaviour bytes the slice must reproduce. Step 5 prompts are assembled FROM these blocks.

**Slice sizing (cycle-time contract):** every slice costs a full agent lifecycle (spin-up, zero-context rebuild, gate), so slices must earn it. **No standalone test-only slices** — coverage tests, interop pins, and property tests are folded into the implementation slice whose code they exercise (the slice's TDD steps simply carry more RED entries). A slice that would be a pure test pass over already-landed code is a smell: merge it into its neighbour.

## Step 5 — Implementation (one sonnet subagent per slice)

Execute the plan's slices top-to-bottom, **delegating each slice to its own subagent** (`Agent` tool, `model: "sonnet"`, general-purpose type). Slices share one worktree and build on each other, so run them **sequentially** — never two agents writing the same worktree concurrently. The session stays the orchestrator: it launches, verifies, and gates every slice.

**Per-slice agent prompt must carry** (the agent starts with zero context — every line of rediscovery it has to do is wasted cycle time you could have pre-paid from the session's own exploration):

- The absolute worktree path and an instruction to work ONLY there.
- **The Serena mandate:** Serena is ALREADY ACTIVATED on this worktree (Step 1 did it; all slices share that worktree) — use its symbol/LSP tools right away, no `activate_project` call. Serena is the default for all TS reading/editing (test files included); `get_diagnostics_for_file` after each source edit; Bash for git/npm only.
- The plan file path + the exact slice to execute (quote the slice text verbatim if short).
- The design doc path for grammar/behaviour reference.
- **The slice's pre-chewed context block, quoted from the plan:** exact file paths and symbol name-paths to touch, the helpers/fixtures/describe blocks to extend and where they live, current type signatures being changed, and any pinned behaviour bytes the slice must reproduce (the Step 4 plan contract guarantees each slice carries this block — hand it over verbatim instead of letting the agent re-grep it; slice agents have burned 100+ tool calls on rediscovery).
- The TDD contract: **Red** (write the test first, run `npx vitest run <file>`, it must fail for the stated reason) → **Green** (minimal code, re-run) → **Refactor** (keep green).
- **The slice gate (targeted, NOT the full validate):** `npx vitest run` on every touched test file, `npm run check:types`, and biome on the touched files (`npx biome check <files>`) — all green before committing; NEVER commit on a red gate; commit exactly one atomic conventional-commit with the message the plan names; never `--no-verify`. The agent does NOT run `npm run validate` — that gate moves to the phase boundary (below).
- The conventions: GWT describe/it split, AAA sections with real statements, `sut` = the unit under test (result goes in `result`), no `@ts-ignore` / `eslint-disable` / `v8 ignore` / `stryker-disable` / `biome-ignore`, no phase/ADR/backlog refs in source or tests, git-faithful behaviour.
- The blocker protocol: on any wall (ambiguous spec, ADR-level decision, failing gate it cannot honestly fix) the agent must NOT commit — it reports `{ slice, reason, ≤3 candidate options }` back as its final message.

**After each agent returns, verify in-session before launching the next slice**: the commit exists and contains what the slice promised (`git log`/`git show --stat`), and the diff honours the conventions (spot-check; deep review still happens in Step 6). A failed or blocked slice is handled in-session: fix it directly or surface to the user with the agent's options — never relaunch blindly.

**Phase-boundary gate:** after the LAST slice lands, run `npm run validate` once in-session. It MUST be green before Step 6 — anything it surfaces (cross-slice breakage, coverage holes, doc-typedoc / `reports/api.json` regeneration, spelling) is fixed and committed here (`fix(<scope>): close validate gap after slice N` or the regenerated artefact in its own commit). One full validate for the whole phase replaces N per-slice runs — that was the single biggest cycle-time cost of the delegated form.

If blocked at orchestration level (design hits a wall, ADR-level decision needed): surface to the user with `{ slice, reason, ≤3 candidate options }`. Never spin, never silently abandon.

## Step 6 — Review × 4 (parallel dimensions, per-dimension convergence; read-only fable reviewers; fixes in-thread)

Four review dimensions, **fanned out in parallel** (one message, four `Agent` calls, `model: "fable"`), each converging **independently** (≤3 cycles per dimension):

1. **Code review (TypeScript)** — types, correctness, bugs, project conventions, immutability.
2. **Security review** — config/path/URL injection, traversal, SSRF, resource exhaustion, cache poisoning.
3. **Perf review** — scoped to the repo's performance priorities (CLAUDE.md §Performance): allocation churn on hot paths, accidental O(n²), buffer copies, sync I/O in async pipelines, cache-defeating patterns. Calibrate to the diff: a cold-path feature legitimately returns zero findings.
4. **Test review** — run the `test-review` skill's audit dimensions over the diff's tests, **minus its mutation dimension** (mutation is willingly deferred to Step 8's background run — do not anticipate or duplicate it here): behaviour focus, coverage holes, freshness, mocks, isolation, assertion strength, GWT/AAA + `sut`/`result` conventions, maintainability, forbidden refs/directives.

Each reviewer is a **read-only fable subagent**: worktree path, design doc path, mission to read `git diff main...HEAD` plus whatever surrounding code it needs (Serena already active); no edits, no commits; returns a structured findings list `{ file:line, severity, finding, suggested fix }` (empty list valid — and a converged dimension).

**Convergence loop:** collect the round's findings → the SESSION applies every fix directly (Serena), batched and committed **per dimension**, `npm run validate` after the round's batches → then converge per dimension by severity:

- **LOW-only dimension:** converged once the session applies its fixes — NO fresh reviewer relaunch just to confirm polish (a relaunch to rubber-stamp LOWs costs a full review pass for predictable empty lists).
- **MEDIUM+ dimension:** re-launch a **fresh** reviewer — but scoped to the **fix delta**, not the whole branch: its prompt carries the prior round's findings list, the fix commits' diff (`git diff <pre-fix>..HEAD`), and the mission "verify each finding's resolution + review the fix diff itself"; it does NOT re-read the full `main...HEAD` diff (round 1 already deep-read every line — what needs fresh eyes is the fixes).
- Repeat until every dimension is converged or hits 3 cycles. Round 1 is always full-diff; fresh per-cycle contexts keep reviewers unbiased by the implementer's history and their own previous pass.

Commit fixes per dimension as conventional commits (e.g. `refactor(config): apply code-review fixes`, `fix(security): tighten path validator`, `perf(pack): hoist allocation out of loop`, `test(coverage): close gap surfaced by test-review`).

**Security gate:** for HIGH/CRITICAL security findings, surface the fix diff to the user BEFORE committing. MEDIUM/LOW security findings + all code/perf/test findings: fix-all-then-converge, no user round-trip.

## Step 7 — Architecture refactor (conditional fable subagent) + scoped re-review

Implementation and the four review dimensions are scoped to the diff. This pass widens the lens: with the feature landed, look across the **whole codebase** for structural gains the scoped passes can't see — duplication that now warrants centralizing, a responsibility sitting in the wrong layer, the Nth consumer of a pattern that should become a shared primitive/port. Improve SOLID / hexagonal layering / SoC / DRY; stay bounded by YAGNI + KISS — no speculative abstraction.

Discovery is **seeded by the feature's diff** and radiates only as far as the feature's concerns reach.

**Two-stage, judgment vs execution:** the session (fable) owns the judgment — a quick in-thread candidate scan (diff + targeted symbol lookups — minutes, not an exploration), then scoping each surviving candidate into a precise spec: what moves where, which symbols/files, expected mechanical test changes, blast radius. If nothing clears the bar → write the 1–3 line no-op justification and move on; spawning an agent to conclude "no-op" is forbidden waste. If candidates survive → delegate **execution to a `sonnet` subagent** (same trust level as feature slices, and the spec makes it slice-grade work): worktree path, Serena-active note, the scoped candidate specs, the behavior-preserving contract below, targeted slice-style gates, atomic `refactor(<scope>): <what>` commits.

**Contract:**

- **Integrate, don't defer:** the discovered refactor is executed **in this PR**, not logged for later. The default is to do the work now while the feature diff makes the blast radius obvious. Only spin out a `docs/BACKLOG.md` follow-up when the refactor is genuinely *feature-sized* — large enough to need its own complex ADR and its own workflow run. Small and medium structural gains are landed here, every time.
- **Behavior-preserving:** tests change only mechanically (moved/renamed). `npm run validate` stays green throughout. No public-API behavior change.
- **Bounded blast radius:** every change traces back to the feature's concerns. A cross-cutting opportunity *unrelated* to the feature is still out of scope — but an in-scope opportunity is done now, not deferred.
- **May be a no-op:** if the code is already in good shape, the step still emits a 1–3 line written justification of what was considered and why nothing changed. A silent skip is not allowed.
- **Atomic commits:** each refactor lands as its own `refactor(<scope>): <what>` commit, separate from the feature commits.

Then **re-review**, scoped to *only* the refactor diff (`git diff` of the `refactor(...)` commits), through the same four dimensions (code / security / perf / tests, parallel, per-dimension convergence ≤3), fix-all-until-converged, re-validate. Findings that imply *further* refactoring become follow-ups, not another refactor loop.

**Why here (before mutation):** mutation testing scores test strength against the *final* code shape. Refactoring after mutation would invalidate the run and force a costly redo. Refactor → re-review → green validate → then mutation.

## Step 8 — Mutation testing (scoped to the PR's touched files; PR waits for it)

The moment Step 7's validate is green, start the scoped run **in the background** — scoped to **exactly the code the PR touches**, never the full tree. **Line-range scoping is the default**: derive each file's contiguous changed regions from `git diff main...HEAD` and pass one `<file>:<start>-<end>` entry per region (the same file may appear several times); widen to the whole file only when the diff blankets it (most of the file changed, or the regions are so fragmented the ranges add noise — e.g. a file-wide mechanical rename):

```bash
./node_modules/.bin/stryker run --incremental --mutate "src/a.ts:42-118,src/a.ts:300-340,src/b.ts"   # run_in_background
```

(One `--mutate` flag with a comma list — repeated flags override each other.) Pre-existing-line survivors are out of scope anyway (the triage filters to the diff's lines), so mutating untouched regions of a touched file is pure wasted wall-clock on the PR's critical path — don't pay it.

**Incremental mode:** always pass `--incremental` — `stryker.config.json` wires `incrementalFile: reports/stryker-incremental.json` (gitignored, never committed), so the post-triage re-run only re-tests mutants affected by the new kill tests instead of the full scoped set. If results look inconsistent with the cache (stale kills, impossible survivors), rebuild it with `--force`; the vitest-4 false-survivor caveat below applies to incremental runs too.

While it grinds, Step 9's **docs work** may proceed in parallel — but **the PR is NOT created until this run lands and its triage is complete**. Mutation is part of the work, not a post-merge afterthought: the PR must carry the final, mutation-hardened test suite.

**When the run lands**, filter survivors/no-coverage to **the diff's lines only** (pre-existing-line survivors are out of scope) and triage with a **sonnet subagent**: kill each with a mutation-resistant test, or document inline as `// equivalent-mutant: <why>` when provably equivalent; commit kills as `test(mutation): <module>`, then re-run `npm run validate`. Known caveat: local Stryker under vitest-4 can report false survivors — verify a survivor is real before writing a test for it. If the project has no mutation config, note it and move on.

**Never destroy the run's worktree while it executes** (no `git sync`/worktree removal until the run has landed — it crashes the run with no verdict, and the CI mutation job dies with the branch at merge, so both verdict sources are lost).

## Step 9 — Docs refresh (haiku subagent, parallel with mutation) + PR (in-session, AFTER mutation triage)

While mutation grinds in the background, handle the documentation. **First check whether any doc pages are actually affected** (public-surface changes, behaviour notes a page states). If none are, skip the haiku agent entirely. If pages need updating, delegate ONLY the page work to a **haiku subagent** (worktree path, design doc path, the list of public-surface changes, Serena-active note, targeted gates):

- `README.md` / `RUNBOOK.md` / `CONTRIBUTING.md` touches and the relevant `docs/get-started/` / `docs/use/` / `docs/understand/` pages — signature blocks, behaviour-note bullets, error tables, ADR/design links (content sourced from the design doc, not invented). One commit: `docs(<slug>): refresh pages`.

The SESSION keeps the synthesis work (these are specs and records other sessions depend on — never haiku):

- **The backlog flip, bare** (session-owned — it's a one-line Edit, and a delegated agent has rewritten the entry body against instructions before): `[ ]` / `[~]` → `[x]` plus appending only `· ADRs NNN–NNN · design/<slug>.md`. **NO retrospective prose, NO rewording the entry body** — the squash commit and PR body are the permanent record; `git blame` on the line finds them. Commit: `docs(<slug>): backlog flip` (or fold into the follow-up-entries commit).
- **New backlog follow-up entries** surfaced during the run — full context, cross-links (`surfaced by`/`same shape as`), placed in dependency order. They are what a future `/apply-workflow <id>` resolves from.
- **The PR body** — now the single source of truth for what shipped: decisions + ADR numbers, design doc path, divergences, pinned behaviours, test plan. Write it accordingly.

**Pre-PR gate (all must hold before `gh pr create`):**

1. Docs committed, backlog updated.
2. Step 8's mutation run landed + survivors triaged + validate green.
3. **Deps freshness:** `npm outdated` is clean — the CI `deps` job gates on it, so catching it here saves a full CI round. If anything is outdated, bump it in its own `chore(deps): bump <pkgs>` commit and re-validate (known publisher-bug false flags, e.g. `@ls-lint/ls-lint` same-version, are local-only and ignorable).

Then push the branch with `-u origin` and run `gh pr create` with the PR body.

## Step 10 — Merge + cleanup

Surface the PR URL and the CI result. Once CI is green — ignore the non-blocking `mutation` / `benchmark-compare` jobs — squash-merge **with branch deletion**:

```bash
gh pr merge <#> --squash --delete-branch --admin
```

**Always pass `--delete-branch`** so the remote branch is removed as part of the merge. `--admin` is required because the `main` ruleset blocks normal merges. Then run `git sync` from the main worktree — it fetches + prunes, fast-forwards `main`, and removes every local branch whose upstream is now `[gone]` together with its worktree:

```bash
git checkout main && git sync
```

After `git sync` removes the worktree, **clean up Serena's project entry** for it: prune the stale `~/.serena` project record for `tsgit-<slug>` so a later `activate_project` doesn't trip over a deleted path. The Serena activation (Step 1) and this cleanup are a matched pair — every worktree that gets activated gets pruned here.

## Hard rules

- **Delegation map (fixed):** design (2) + plan (4) + review dimensions (6, read-only, 4 in parallel, per-dimension convergence ≤3) → `fable`; implementation slices (5, one per slice, sequential) + scoped refactor execution (7) + mutation triage (8) → `sonnet`; mechanical doc-page updates (9, only when pages are actually affected) → `haiku`. Refactor *judgment* (candidate scan + scoping) stays with the session — only the scoped execution is delegated. The SESSION keeps: input resolution, branch setup, the ADR conversation, slice verification, review-fix application, all phase-boundary validates, the backlog flip, backlog follow-up authoring, the PR body, CI monitoring, merge + cleanup. Review agents never edit; only the session edits during review. The user can interrupt at any point and steer mid-flight.
- **Mutation gates the PR** — the run is scoped to exactly the src files the PR touches (never the full tree), backgrounds at Step 8 so docs can parallel it, and the PR is created only after the run lands, survivors are triaged (killed or documented equivalent), and validate is green. Never destroy the worktree while the run executes. The `mutation` CI job stays non-blocking at merge time (the local triage is the gate).
- **Never skip the ADR step** when user-judgment was required to disambiguate the design.
- **Never skip the four review dimensions** before pushing.
- **Never skip the architecture refactor pass** (Step 7). It may be a no-op, but a no-op must carry a written justification — never a silent skip. Refactor commits are atomic and behavior-preserving, and are re-reviewed before mutation.
- **Never `--no-verify` the commit hook**, never use ignore directives.
- **Validate cadence:** slice agents gate on targeted checks (touched-file vitest + `check:types` + biome); the full `npm run validate` runs at phase boundaries — once after the last slice, after each review/refactor fix batch, and before push — and must be green there. Nothing is ever committed on a known-red gate.
- **Never include phase/ADR refs inside source or test code** (`§X.Y.Z`, `Phase N`, `ADR-NNN`, `BACKLOG 20.6` etc.). Those belong in the design doc and PR body. Source code is silent about its provenance.
- **Be git-faithful** unless an ADR explicitly diverges.
- **Always merge with `--delete-branch`** (`gh pr merge --squash --delete-branch --admin`) so no merged branch lingers on the remote.

When done, the final message to the user is the PR URL + a one-line summary of what shipped.
