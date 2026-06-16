# ADR-350: `core.hooksPath` refuses a valueless value per-accessor (at hook resolution), a documented under-refusal — refines ADR-346

## Status

Accepted (at `53b61b42`)

## Context

ADR-346 ruled that the `[core]` path-likes refuse a valueless value **eagerly with git's broad reach**. That holds cleanly for `core.excludesFile`/`core.attributesFile`: pinned against git 2.54.0 they die on the *entire* default-config-loading porcelain (status, log, branch/tag list, for-each-ref, rev-parse, commit, …) — a uniform broad set, shipped via the `assertOperationalRepository` chokepoint.

Empirical pinning at implement time showed `core.hooksPath`'s death breadth is **NOT** the clean "work-doing vs ref-listing" split the design assumed, and **not** uniform. Pinned matrix (git 2.54.0): it dies on `status`, `log`, `add`, `diff`, `show`, `commit`, `checkout`, `merge`, `name-rev`, `blame`, `describe`, `reflog` — but **survives** on `branch`, `tag`, `cat-file`, `rev-parse`, `shortlog`, `mv`, `rm`, `stash`, `reset`, `rebase`, `range-diff`, `whatchanged`, `worktree`, `sparse-checkout`, `fetch`, `pull`, `push`. There is no clean rule (`log` dies but `whatchanged` survives; `blame` dies but `rev-parse` survives; mutations like `rm`/`reset` survive). Worse, it is **flag-dependent**: `cherry-pick --no-commit` survives while a *committing* cherry-pick runs hooks → resolves the hooks dir → dies. git's death is incidental to whichever code path happens to call `git_config_get_pathname("core.hookspath", …)` per invocation — a static per-command gate cannot reproduce it.

A static `assertOperationalRepository(ctx, { hooks })`-style gate (the original plan shape) would therefore be a brittle, per-invocation-inaccurate approximation.

## Decision

`core.hooksPath` refuses a valueless value **per-accessor**: the guard sits at tsgit's hook-resolution point (`run-hook` / `invokeHook`, where `config.core?.hooksPath` is read to locate the hooks dir), mirroring git's actual mechanism (`find_hook` → `git_config_get_pathname`). tsgit refuses with `CONFIG_MISSING_VALUE { key: 'core.hookspath', source, line }` exactly when a command resolves the hooks dir and the value is valueless — which is where tsgit's hook-running commands (commit, merge, checkout, the rebase/cherry-pick/revert hook points, pull-via-merge, …) all die, matching git on those commands.

This is a **conscious, documented under-refusal** relative to git: git *also* dies incidentally on commands that do NOT run hooks (`log`, `blame`, `diff`, `show`, `name-rev`, `describe`, `reflog`) because their code paths happen to resolve the hookspath; tsgit does **not** refuse there. The divergence is bounded to a pathological input (a present-but-valueless `core.hooksPath`) and is accepted because the faithful broad set is intricate, ruleless, and flag-dependent — a principled mechanism-matching gate is preferred over a brittle per-command enumeration that still could not match git's per-invocation behaviour.

This **refines ADR-346**: its eager-broad ruling stands for `excludesFile`/`attributesFile`; `hooksPath` is carved out to per-accessor. `excludesFile`/`attributesFile` are NOT added to the hook-resolution guard, and `hooksPath` is NOT added to the `assertOperationalRepository` broad gate.

## Consequences

### Positive

- Mechanically principled (matches git's `find_hook` access point); small, non-brittle change at one site instead of a per-command/per-flag enumeration that could not be faithful anyway.
- tsgit and git agree on every hook-running command (commit/merge/checkout/…) — the cases a consumer actually hits.
- Reuses the 24.9l enabler (`assertNoValuelessConfig` / `CONFIG_MISSING_VALUE`) unchanged.

### Negative

- Documented under-refusal: tsgit's `log`/`blame`/`diff`/`show`/`name-rev`/`describe`/`reflog` succeed on a valueless `core.hooksPath` where git dies. A bounded, recorded divergence from the prime directive on a pathological input. Interop pins agreement on the hook-resolving commands only; the divergent commands are documented, not pinned as agreement.

### Neutral

- If a future change needs the broad hookspath breadth, it would have to reproduce git's per-invocation access pattern — out of scope here and likely not worth the brittleness.
