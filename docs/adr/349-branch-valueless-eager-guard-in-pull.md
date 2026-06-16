# ADR-349: Valueless `branch.<name>.merge`/`remote` — eager guard in `pull`, closing the explicit-args / detached gap

## Status

Accepted

## Context

Pinned B1–B6 (git 2.54.0): `git pull` dies `missing value for 'branch.main.merge'` on a valueless `branch.<cur>.merge`/`remote`. Crucially this die is **eager within `pull`** — git reads every `[branch *]` section building its refspec/remote map, so it dies:

- on the common no-arg `git pull` on a tracking branch (B1),
- on `git pull origin main` where the upstream is supplied **explicitly** (B1), and
- even with **HEAD detached** (B6).

`git status` is different (B5/B6): it reads only the *current* branch's tracking, so it does not die when detached or off the configured branch — so the eager die is `pull`-scoped, not universal.

tsgit's `pull.ts` `resolveUpstream` reads only `config.branch?.get(currentBranch)` and only when `opts.ref` is absent, then throws `NO_UPSTREAM_CONFIGURED`. A guard on that refusal path alone (the design's recommended option 4a) matches B1's no-arg die but NOT the explicit-args or detached die. The user chose to close that gap.

## Decision

Guard `branch.*` valueless **eagerly within `pull`**, reproducing git's read-every-`[branch *]`-section behaviour:

- The guard runs on `pull` before/independent of `resolveUpstream`'s `opts.ref`/`currentBranch` short-circuit, so it fires on `pull origin main` and detached HEAD too (B1/B6), not only the refusal path.
- It refuses on the first valueless `merge`/`remote` (by file line) under the relevant `[branch *]` section(s). The revised design pins whether git validates **all** `[branch *]` sections eagerly or only those its refspec map touches, and scopes the guard's section set to match git exactly (the pinned fixtures use the current branch's section; the revised design extends the matrix if git dies on an unrelated `[branch "other"]` valueless key during `pull`).
- The **absent** case keeps `NO_UPSTREAM_CONFIGURED` (B6 detached, no tracking → no die in tsgit either where git also doesn't read a present-but-null key); only **valueless** refuses.
- `status` and other tracking-aware commands are **not** in scope here — B5/B6 show their reads are narrower; this ADR is `pull`-scoped, matching git's observed split.

## Consequences

### Positive

- Faithful to git's full `pull` die (B1/B6), not just the no-arg subset — closes the explicit-args and detached-HEAD gap the refusal-path-only guard left open.
- Reuses `findFirstValuelessEntry` + `CONFIG_MISSING_VALUE`.

### Negative

- The eager placement reads `[branch *]` config before `pull`'s normal upstream resolution, a refusal earlier than tsgit throws today. The revised design must confirm the exact section set git validates so the guard is neither too narrow (misses a section git dies on) nor too broad (refuses where git doesn't).

### Neutral

- Shares the eager-validation shape with ADR-348 (`core` path-likes); the revised design decides shared-helper vs separate. The key set here is per-subsection (`branch.<name>.{merge,remote}`) and `pull`-scoped, unlike `core`'s flat every-command set.
