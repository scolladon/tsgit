---
backlog: { source: file, ref: docs/BACKLOG.md }
paths: { design: docs/design, adr: docs/adr, plan: docs/plan }
context: .claude/workflow/code-navigation.md
gates:
  part: "npx vitest run <touched-tests> && npm run check:types && ./node_modules/.bin/biome check <touched-files> && npm run check:spelling"
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
  toolchain supports TS 7. `knip` is also skipped; the reason was never recorded. **`vitest` and
  `@vitest/coverage-v8` are pinned to 4.x**: 5.0.0 is a major, and Stryker pairs with the
  test runner — the last vitest/Stryker mis-pairing cost a whole PR to diagnose, and the
  mutation phase gates every feature PR here, so a runner major landing inside one makes a
  surviving mutant ambiguous between the feature and the bump. Unpin in its own PR, where a
  mutation regression is attributable to the bump alone. **`jscpd` is pinned to
  5.0.16**: release 5.1.0 declares all seven of its optional platform packages at version
  `5.0.16`, but `jscpd-windows-arm64-msvc` was only ever published at `5.1.0` — so
  `npm install` silently skips an unresolvable optional dep while `npm ci` computes it as
  required and fails with `Missing: jscpd-windows-arm64-msvc@ from lock file`. A local
  `npm run validate` cannot catch this, because local `node_modules` is already correct;
  only `npm ci` sees it. Unpin when a release ships coherent optional-dependency versions.
  **`@cloudflare/workers-types` is skipped**: it publishes a date-versioned release
  (`5.<date>.<n>`) every day, so bumping it makes `deps` green for exactly one day and red
  again the next morning — a treadmill, not a freshness signal. Dependabot's weekly npm PR
  keeps the pin from rotting, and a `workers-types` change that actually matters shows up as
  a type error, not as an `npm outdated` row. The exception existed before the v4 → v5
  migration removed it; this restores it.
  **`@playwright/test` is held at 1.62.1**: 1.63.0 ships WebKit 26.6, and on the
  `ubuntu-latest` runner every headless WebKit page then fails
  `navigator.storage.getDirectory()` with `UnknownError: The operation failed for an unknown
  transient reason`, so the whole `e2e (webkit)` job goes red (reproduced twice on PR #295;
  green on the previous build; Chromium and Firefox unaffected). Unpin once a later release
  passes the WebKit e2e job.
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

- **`check:spelling` is in BOTH `gates.part` and `review-batch`** — it was review-batch-only,
  and an unknown word once rode two commits before anything noticed, because the part gate
  never ran it. The md-scoped commit hook misses words in TS test titles, comments and doc
  filenames, so per-part spelling is the cheapest place to catch them. The cspell dictionary
  lags on some British `-ising/-ised` forms; full validate remains the authority.
- **Gate results can be stale — `wireit` caches them.** `npm run check:types` and
  `npm run check:spelling` both return `Ran 0 scripts and skipped 1` when inputs look
  unchanged, and that reads exactly like a pass. A cached green preceded a red pre-push
  once, and a commit went out on a cached spelling result. Before trusting either as a
  gate, `rm -rf .wireit`, or bypass wireit entirely:
  `npx tsc --noEmit -p tsconfig.json` and `npx cspell --no-progress <files>`.
- **Never re-sort `cspell.json`.** Its order tiebreaks uppercase-first for case-equal
  pairs, which `localeCompare` does not reproduce — a re-sort churned 42 unrelated lines.
  Insert the one new word at its alphabetical position and leave the rest alone. Better
  still, reword the comment: a term used once rarely earns a dictionary entry.
- **The harness LSP is rooted at the MAIN checkout, not the worktree.** It produced about
  thirty confirmed-false errors across one feature branch — symbols it called missing that
  were three lines away, properties it called absent that were declared in the file it was
  reading — while `tsc` on the same tree was clean throughout. Never gate on it and never
  source a review finding from it; `npx tsc --noEmit -p tsconfig.json` is the oracle.
- **Search interception — both causes are fixed, and here is what they looked like.** Two
  separate defects blocked searches during one feature run, and both failed in ways that
  read as a legitimate empty result rather than an error. `rtk` installed a shell wrapper
  named `grep` that returned `Error: claude native binary not installed` instead of matches
  — it failed *closed*, so "no output" meant "broken", not "no matches"; fixed by repairing
  the missing `@anthropic-ai/claude-code` install. And tokensave's PreToolUse hook blocked
  symbol-shaped searches on `grep` **and** `rg` — it matches the command text, not the tool
  — while naming replacement tools that do not exist, because its MCP server is not
  registered here; fixed by setting `TOKENSAVE_DISABLE_GREP_HOOK=1` globally in
  `~/.claude/settings.json`'s `env` block.
  Narrowing that hook's matcher instead would not have held: `tokensave doctor` rewrites
  `~/.claude/settings.json` — it widened the matcher to include `Glob` on its own — so a
  matcher edit is reverted the next time anyone runs it. Prefer the env override.
  If a search ever returns nothing again, confirm the tool works before believing the
  result: `command grep`, `rg` (no `-E` flag), or `rtk proxy grep` all bypass a wrapper.

## Backlog conventions

New follow-up entries land in **dependency order**: after their prerequisites, before
their dependents — never just appended. The backlog tick is flip + `· ADRs NNN–NNN ·
design/<slug>.md` suffix ONLY; the squash commit and PR body are the permanent record.

## Worktree layout

This checkout is a normal repo on `main`; feature worktrees are created as siblings
(`../tsgit-<slug>`), each with its own `npm install` (engine setup script does this).
