---
description: Run the subagent-per-phase tsgit workflow on a backlog item, PRD file, or free-text feature description.
argument-hint: <backlog-id | docs/prd/file.md | "feature description">
---

You are the orchestrator for tsgit's subagent-per-phase development workflow (see `CLAUDE.md` §"Development Workflow"). Run the workflow on the input below. Your context must never hold source code — every phase delegates to a subagent. You only handle: branch creation, ADR conversations with the user, security HIGH/CRITICAL gates, and final cleanup.

## Input

```
$ARGUMENTS
```

## Step 0 — Resolve the input

Inspect the argument and decide which of three input forms it is:

1. **Backlog ID** — matches `^\d+(\.\d+)+$` (e.g. `20.6`, `22.4`, `25.5.1`). Look up the matching `[ ] **<id>**` entry in `docs/BACKLOG.md`. Extract the one-line description. The topic-slug is derived from the backlog item's wording (kebab-case, ≤6 words).

2. **File path** — exists on disk under `docs/prd/`, `docs/design/`, or any `.md` extension. Read the file. The topic-slug is derived from the filename (strip `.md`, kebab-case).

3. **Free-text description** — anything else. Treat as the design brief verbatim. The topic-slug is your kebab-case summary of the request (≤6 words).

If the resolution is ambiguous (e.g. backlog ID not found, file unreadable), STOP and ask the user. Do NOT spawn any subagent before resolution succeeds.

Print one line so the user can confirm: `Resolved input → topic: <slug>, brief: <one-line summary>`.

## Step 1 — Branch (orchestrator)

```bash
git worktree add ../tsgit-<slug> -b feat/<slug>
cd ../tsgit-<slug>
npm install
```

The orchestrator does NOT activate Serena. Every spawned subagent activates Serena on its own worktree at the start of its turn (see "Standard subagent preamble" below). Rationale: Serena's LSP delivers diagnostics into the context that issued `activate_project` — if the orchestrator activates, intermediate-state errors from subagent edits roll up into the orchestrator's reminder stream instead of staying inside the subagent's loop where they can be handled. Per-subagent activation keeps each phase's diagnostic stream scoped to the agent doing the work.

If the branch already exists or the worktree path collides, STOP and ask the user.

## Standard subagent preamble (every spawned subagent in Steps 2, 4, 5, 6, 7, 8)

Every subagent prompt MUST open with these two lines verbatim (substitute `<worktree-abs-path>` with the path created in Step 1):

> **Working directory:** `<worktree-abs-path>` — all reads/writes happen here.
> **Activate Serena before any code work:** call `mcp__serena__activate_project` with this directory's absolute path, then `mcp__serena__initial_instructions`. Use Serena's symbol tools (`find_symbol`, `find_referencing_symbols`, `get_symbols_overview`, `replace_symbol_body`, `insert_after_symbol`) as the default for navigating and editing source; fall back to `Read` / `Edit` / `Grep` only for non-code files (markdown, JSON, generated artefacts).

Cost: a single `activate_project` call per subagent (~50 ms). Benefit: every LSP diagnostic stays in the subagent's context — the orchestrator never sees mid-slice noise.

## Step 2 — Design subagent (Opus)

Spawn ONE Opus subagent with this brief:

- The topic slug + the resolved design brief (backlog text / PRD content / free text).
- Pointers to the related existing design docs (`docs/design/`), ADRs (`docs/adr/`), and the patterns it must follow (hexagonal architecture, branded types, GWT/AAA test conventions, 100% coverage, mutation-resistant tests — all per `CLAUDE.md`).
- The contract: produce `docs/design/<slug>.md`, self-review until convergence (max 3 passes), commit as `docs(design): <slug>`, return the final doc path.

Wait for completion. Read the returned doc path's contents.

## Step 3 — ADR conversation (orchestrator with user)

For every load-bearing choice the design makes that's not pre-decided by existing ADRs:
- Surface the alternatives to the user, ≤3 options each.
- Capture the user's decision as `docs/adr/NNN-<title>.md` using `docs/adr/000-template.md`.
- Number sequentially after the highest existing ADR.
- Commit each as `docs(adr): NNN <title>`.

If the design has no user-judgment decisions (everything is pre-decided or mechanical), skip to Step 4 without inventing questions.

## Step 4 — Plan subagent (Opus)

Spawn ONE Opus subagent with:
- The design doc path + the new ADR paths.
- The contract: produce `docs/plan/<slug>.md`, self-review until convergence (max 3 passes), commit as `docs(plan): <slug>`, return the final doc path.

Wait for completion. Read the returned doc.

## Step 5 — Implementation subagent (Opus, single, all slices)

Spawn ONE Opus subagent with:
- The design doc + plan + relevant ADRs.
- The contract: execute every slice top-to-bottom, TDD per slice (Red → Green → Refactor), run `npm run validate` before each commit, one atomic conventional-commit per slice.
- Escalation rule: if blocked, escalate with `{slice, reason, ≤3 candidate options}`. Never spin or silently abandon.

Wait for completion. If escalated: surface to the user, resolve, re-spawn with the resolution as added context. If done: read the commit list.

## Step 6 — Review subagents × 3 (Opus, parallel, fix-all-until-converged)

Spawn three Opus subagents in parallel via a single message with three Agent tool calls:

1. **typescript-reviewer** — types, correctness, bugs, conventions, immutability.
2. **security-reviewer** — config/path/URL injection, traversal, SSRF, resource exhaustion, cache poisoning.
3. **test-review** (general-purpose) — mutation gaps, coverage holes, isolation, GWT/AAA conventions.

Each subagent's contract: review the diff, apply fixes for every finding it identifies, run `npm run validate` after each fix batch, self-review until its own pass yields zero findings (max 3 cycles). Returns "applied N fixes, list, final validate state".

**Security gate:** the security subagent surfaces HIGH/CRITICAL findings to YOU (the orchestrator) BEFORE committing fixes. You confirm or revise with the user. MEDIUM/LOW security findings + all typescript/test findings: fix-all-then-converge, no orchestrator round-trip.

## Step 7 — Mutation subagent (Sonnet)

Spawn ONE Sonnet subagent with:
- The contract: run `npm run test:mutation` (or `stryker run`), iterate per surviving mutant — kill it with a new test, or document it inline as `// equivalent-mutant: <why>` when provably equivalent. Re-run until 0 killable survivors. Commit each kill as `test(mutation): <module>`. Return the final mutant report.

If the project has no mutation config or the run is intractable (>30min), the subagent reports back; you decide with the user whether to skip.

## Step 8 — Docs + PR subagent (Haiku)

Spawn ONE Haiku subagent with:
- The design + plan + commit list.
- The contract: update `README.md`, `RUNBOOK.md`, `CONTRIBUTING.md`, and the relevant `docs/get-started/` / `docs/use/` / `docs/understand/` pages. Flip the `docs/BACKLOG.md` entry (`[ ]` / `[~]` → `[x]`) inside this PR's commits. Push the branch with `-u origin`. Run `gh pr create` with a thorough body (summary + test plan). Return the PR URL.

## Step 9 — Cleanup (orchestrator)

Surface the PR URL to the user. Wait for confirmation that CI is green and the PR is squash-merged. Then:

```bash
git worktree remove ../tsgit-<slug>
git branch -D feat/<slug>
```

## Hard rules

- Never load source code into the orchestrator's context — every code touch goes through a subagent.
- Never skip the ADR step when user-judgment was required to disambiguate the design.
- Never spawn the review subagents in series — they MUST run in parallel (single message, three Agent tool calls).
- Never use the Haiku for design/plan/implementation/review; never use the Opus for harness/PR-open.
- If at any phase the subagent escalates, do NOT retry blindly — surface to the user with the candidate options.

When done, your final message to the user is the PR URL + a one-line summary of what shipped.
