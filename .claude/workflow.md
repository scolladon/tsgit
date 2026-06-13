---
backlog: docs/BACKLOG.md
paths: { design: docs/design, adr: docs/adr, plan: docs/plan }
context: .claude/workflow/serena.md
gates:
  slice: "npx vitest run <touched-tests> && npm run check:types && ./node_modules/.bin/biome check <touched-files>"
  phase: "npm run validate"
  review-batch: "npm run check:spelling"
phases:
  design:    { context: .claude/workflow/faithfulness.md }
  plan:      { context: .claude/workflow/surface-gates.md }
  implement: { context: [.claude/workflow/surface-gates.md, .claude/workflow/faithfulness.md] }
  review:    { context: .claude/workflow/surface-gates.md }
  mutation:  { override: .claude/workflow/mutation.md }
  merge:     { merge-flags: "--admin", non-blocking-jobs: [mutation, benchmark-compare] }
pr: { creator: session, pre-pr-gate: "npm outdated" }
scripts: { pre-teardown: .claude/workflow/serena-prune.sh }
---

# tsgit — forge declination

This manifest customizes the [forge workflow](https://github.com/scolladon) for tsgit.
Run it with `/forge:run <backlog-id | file | description>`. Triggers "apply the
workflow" / "the usual flow" resolve here (see CLAUDE.md §Development Workflow).

## Why these policies

- **`merge-flags: --admin`** — the `main` ruleset blocks normal merges; admin
  squash-merge is the only path. Always with `--delete-branch` (engine default).
- **`non-blocking-jobs`** — the `mutation` CI job is informational (the local triage
  in the mutation phase is the real gate); `benchmark-compare` measures runner noise
  and is `continue-on-error`.
- **`pr.creator: session`** — the session pushes AND creates the PR as the final
  workflow step; the user owns only the merge confirmation.
- **`pre-pr-gate: npm outdated`** — the CI `deps` job gates on freshness; catching it
  pre-PR saves a CI round. Remediation: bump in a dedicated `chore(deps): bump <pkgs>`
  commit and re-validate. **Documented exception:** `@ls-lint/ls-lint` can be flagged
  at its own installed version (publisher metadata bug) — local-only, ignorable, do
  not attempt to bump.
- **`review-batch: check:spelling`** — the md-scoped commit hook misses words in TS
  test titles/comments and doc filename tokens; catching them per fix batch beats a
  failed validate later. The cspell dictionary lags on some British `-ising/-ised`
  forms — full validate is the authority.

## Backlog conventions

New follow-up entries land in **dependency order**: after their prerequisites, before
their dependents — never just appended. The backlog tick is flip + `· ADRs NNN–NNN ·
design/<slug>.md` suffix ONLY; the squash commit and PR body are the permanent record.

## Worktree layout

This checkout is a normal repo on `main`; feature worktrees are created as siblings
(`../tsgit-<slug>`), each with its own `npm install` (engine setup script does this).
