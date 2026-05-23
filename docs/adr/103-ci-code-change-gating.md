# ADR-103: Skip code-dependent CI jobs when the diff has no code changes

## Status

Accepted (at `958b472`)

## Context

The Phase 19.1 mutation job ships with a diff-scoped skip — `compute-mutation-scope.sh` returns an empty list when no `src/` files changed, and the job posts `::notice::No src/ files changed — skipping mutation`. The same logic — "this gate only has meaning when the relevant inputs changed" — applies to every code-dependent job in the pipeline.

Today's per-PR pipeline runs **every** code-dependent job on a docs-only PR:

- `unit-tests` matrix (6 cells: ubuntu/macos/windows × Node 22/24)
- `integration` + `posix-integration` matrix (2 cells) + `win-integration`
- `e2e` matrix (chromium/firefox/webkit)
- `build`
- `typecheck`, `check:dead-code`, `check:duplicates`, `check:architecture`
- `benchmark-compare`

Counted naively, a docs-only PR currently burns ~15 jobs of runner time for zero signal. The marginal cost is real on CI minutes (especially macOS, which is premium-billed) and on developer wall-clock (PRs slow to converge while jobs that cannot fail still run).

The opposite trade-off — skipping a job that should have run — is the actual risk. The mitigation set must:

1. Treat any `.github/**` change as "code" (workflow + script edits must re-exercise CI).
2. Treat any config-file change (`tsconfig*.json`, `vitest.config.ts`, etc.) as "code" — config drift can break tests silently.
3. Treat `package.json` / `package-lock.json` as "code" — dep bumps need a full pass.
4. Treat `test/**` and `scripts/**` as "code" — test/script edits must re-run.
5. Default to "code = true" on any non-PR trigger (push to main runs the full pipeline).

## Decision

Add a `changes` detection job at the top of `ci.yml` that:

- Always runs.
- On `pull_request` events: diffs `base.sha..head.sha` and emits `code=true` if any path matches a curated allowlist of code-relevant globs, otherwise `code=false`.
- On `push` events (including main pushes and tag pushes): unconditionally emits `code=true` — there is no diff scope and the pipeline must always cover the full surface.

Every code-dependent job then adds `needs: [changes, …]` and `if: needs.changes.outputs.code == 'true'`. A skipped job is reported as success-equivalent for branch protection (`if:` is evaluated *after* the job is queued, so the job exists in the run graph and required-checks see it as "skipped → success").

### Gated job list

| Job | Why gated |
|---|---|
| `typecheck` | tsc only matters for `.ts` changes |
| `dead-code` | knip walks `src/**` |
| `duplicates` | jscpd walks `src/**` |
| `architecture` | depcruise reads dep graph from source |
| `build` | nothing to build without source changes |
| `unit-tests` matrix | the central correctness gate |
| `integration`, `posix-integration`, `win-integration` | same |
| `e2e` matrix | same |
| `benchmark-compare` | nothing to measure delta on |
| `mutation` | **NOT additionally gated** — already self-skips via `compute-mutation-scope.sh` when the diff has no `src/` files; double-gating would just duplicate the check |

### NOT gated (run on every PR regardless)

| Job | Why kept |
|---|---|
| `lint` | biome formats `.md`, `.json`, `.yml` too |
| `filesystem` | ls-lint applies to any file change |
| `spelling` | cspell runs on docs |
| `deps` | npm outdated is independent of changed files |
| `security` | npm audit is independent of changed files |
| `doc-links`, `doc-coverage`, `doc-typedoc`, `docs-pr-gate` | already only run on doc-relevant inputs |
| `megalinter` | path-filters internally |

### Code-path globs

```
src/**
test/**
scripts/**
.github/**
package.json
package-lock.json
tsconfig*.json
vitest.config.ts
stryker.config.json
rollup.config.ts
mutation-budgets.json
biome.json
knip.json
.ls-lint.yml
cspell.json
```

Captured in `.github/scripts/has-code-changes.sh`. The script also enforces the same `^[A-Za-z0-9_./~^@{}-]{1,200}$` SHA-format guard introduced by ADR-102's mutation script — defence-in-depth against a future `pull_request_target` migration.

## Consequences

### Positive

- Docs-only PRs (typos, ADR additions, BACKLOG ticks) drop from ~20 jobs to ~8 — measurable saving in runner minutes, especially on macOS-billed cells.
- Faster green: PR reviewers see "ready" status sooner.
- The mutation job's "skip when empty diff" pattern generalises to a single shared mechanism — no more bespoke logic per heavy job.

### Negative

- Adds one always-run `changes` job at the top of every PR. Wall-time cost: ~10s (`git diff --name-only` on a fetched-depth-0 checkout).
- A single misclassification (a config file the script doesn't recognise as code) silently skips tests. Mitigated by: the allowlist is curated and tested; new config files added to the repo trigger a deliberate update to the allowlist.
- Branch protection rules listing a now-gated job as "required" will see it as "skipped" (still counted as success). If a maintainer adds a new required-check rule for a gated job, they must understand skipped = success here.

### Neutral

- The `changes` job's outputs are visible in the workflow run, so a reviewer can see at a glance whether `code=true` or `code=false` was decided for any PR.
- Existing `mutation` job semantics unchanged — already correctly self-skips.

## Alternatives considered

- **`paths` / `paths-ignore` at the workflow level** — rejected: prevents the workflow from running entirely, which breaks branch protection rules that require named checks to exist on every PR.
- **`dorny/paths-filter@v3` action** — rejected: introduces a third-party action dependency for what is structurally `git diff --name-only | grep`. The project already runs the same pattern in `docs-pr-gate.sh` and `compute-mutation-scope.sh`; consistency wins.
- **Per-job inline `git diff` checks** — rejected: every gated job would re-checkout, re-fetch, and re-run the same diff. A single `changes` job sets the verdict once and downstream jobs read its output.
- **Gating the `mutation` job too** — rejected: the mutation job already self-skips via `compute-mutation-scope.sh`. Adding `if: needs.changes.outputs.code` on top would skip the *entire* job (including the helpful `::notice::` log), confusing rather than clarifying.
