---
backlog: { source: file, ref: docs/BACKLOG.md }
paths: { design: docs/design, adr: docs/adr, plan: docs/plan }
context: .claude/workflow/code-navigation.md
gates:
  part: "npx vitest run <touched-tests> && npm run check:types && ./node_modules/.bin/biome check <touched-files>"
  phase: "npm run validate"
  review-batch: "npm run check:spelling"
phases:
  design:         { context: .claude/workflow/faithfulness.md }
  planning:       { context: .claude/workflow/surface-gates.md }
  implementation: { context: [.claude/workflow/surface-gates.md, .claude/workflow/faithfulness.md] }
  review:         { context: .claude/workflow/surface-gates.md }
  documentation:  { context: .claude/workflow/docs-drift.md }
  validation:     { override: .claude/workflow/mutation.md }
  integrate:      { context: .claude/workflow/docs-drift.md, merge-flags: "--admin", non-blocking-jobs: [mutation, benchmark-compare] }
pr: { creator: session, pre-pr-gate: "npm outdated" }
scripts: { pre-teardown: .claude/workflow/serena-prune.sh }
---

# tsgit — craft declination

This manifest customizes the [craft workflow](https://github.com/scolladon) for tsgit.
Run it with `/craft:run <backlog-id | file | description>`. Triggers "apply the
workflow" / "the usual flow" resolve here (see CLAUDE.md §Development Workflow).

## Why these policies

- **`merge-flags: --admin`** — the `main` ruleset blocks normal merges; admin squash is
  the only path. Always `--delete-branch` (engine default).
- **`non-blocking-jobs`** — `mutation` is informational (the local triage is the real
  gate); `benchmark-compare` measures runner noise (`continue-on-error`).
- **`pr.creator: session`** — the session pushes and creates the PR; the user owns only
  the merge confirmation.
- **`pre-pr-gate: npm outdated`** — the CI `deps` job gates on freshness; catching it
  pre-PR saves a round. Remediation: bump in a `chore(deps): bump <pkgs>` commit,
  re-validate. **Exceptions** (skipped in the `check:deps` grep): `@ls-lint/ls-lint`
  flags at its own installed version (publisher bug); `typescript` is pinned to 6.x because
  7.x is the native ("tsgo") compiler — an API-breaking major whose main export is a version
  stub and whose programmatic API moved under `./unstable/*`, so `@rollup/plugin-typescript`
  and `rollup-plugin-dts` cannot load it (the `tsc` CLI still works). Unpin once the rollup
  toolchain supports TS 7. `knip` is also skipped; the reason was never recorded.
- **`docs-drift.md` on BOTH `documentation` and `integrate`** — the `docs-pr-gate` bot
  comments only once the PR exists, so the documentation phase can preempt it but cannot
  see it. Integrate therefore treats that comment like any other red CI signal: read it,
  and for every entry either land a `docs(<scope>): …` fix or record why it is
  intentionally code-only. It is informational today and blocking soon, so an unread
  comment is a merge-time surprise waiting to happen.
- **Tool bootstrap in agent spawns** — every spawn prompt for an agent that will *edit
  code* carries a short block with the two literal `ToolSearch` calls (graft's five tools,
  serena's six) plus one worked example per tool, pre-filled from that part's own context,
  above the context-file references. Measured over one full run: agents that edit code made
  321 MCP calls across 16 spawns, against 0 across 6 read-only spawns — and three read-only
  agents ran the ToolSearch calls and then used nothing. So the block is worth its prompt
  space for implementers and refactor executors, and is not worth it for reviewers, planners or
  docs writers, whose natural instrument is Bash over a diff. Evidence and the full split:
  `.claude/workflow/code-navigation.md`.

- **`review-batch: check:spelling`** — the md-scoped commit hook misses words in TS test
  titles/comments and doc filenames; per-batch spelling beats a failed validate. The
  cspell dict lags on some British `-ising/-ised` forms — full validate is the authority.

## Backlog conventions

New follow-up entries land in **dependency order**: after their prerequisites, before
their dependents — never just appended. The backlog tick is flip + `· ADRs NNN–NNN ·
design/<slug>.md` suffix ONLY; the squash commit and PR body are the permanent record.

## Worktree layout

This checkout is a normal repo on `main`; feature worktrees are created as siblings
(`../tsgit-<slug>`), each with its own `npm install` (engine setup script does this).
