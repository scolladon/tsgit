# ADR-348: Valueless `core` path-likes — eager guard reproducing git's `git_default_core_config` die

## Status

Accepted

## Context

Pinned C1/C3/C4 (git 2.54.0): a valueless `core.excludesFile`, `core.attributesFile`, or `core.hooksPath` makes git die `missing value for 'core.excludesfile'` (etc.) **eagerly** — `git_default_core_config` runs during the config scan on nearly every command (`status`, `add`, `log -1`, `rev-parse`, `cat-file`, `commit`). The die is NOT gated on the feature being exercised. Pinned C2: the porcelain `config --get`/`--list` path bypasses the typed callback and still succeeds (ADR-314 parity).

tsgit reads each key at a *silent-miss feature consumer* (`read-gitignore.ts`, `read-gitattributes.ts`, `run-hook.ts` `resolveHooksDir`) and treats valueless (→ absent, ADR-315 D4) as "feature off" — no refusal anywhere. The design noted the only faithful reproduction is an **eager** guard (option 3c), distinct from every 24.9l site, and recommended deferring it as a separable architectural design. The user chose to build it now.

## Decision

Add an **eager** valueless guard for the three `core` path-like keys, fired on the command hot path so a valueless value refuses with `CONFIG_MISSING_VALUE` independently of whether the ignore/attributes/hooks feature is reached — matching git's `git_default_core_config` eagerness.

Architecture (final placement to be detailed in the revised design):

- The guard is `assertNoValuelessConfig(ctx, 'core', undefined, ['excludesfile', 'attributesfile', 'hookspath'])`, run once early on the commands that read config for a real purpose — reproducing "dies on almost everything" without putting a throw inside the pure `findFirstValuelessEntry`/`readConfig` read primitive (which the porcelain `config` path must keep non-throwing, C2).
- It must fire **only** for present-but-valueless keys (file-line order picks which is reported); an **absent** or **empty-string** `core.*` path-like keeps today's behaviour (feature off / explicit empty) with no regression — the porcelain `config` reads and the absent case stay green.
- The reported key is lower-cased (`core.excludesfile`), matching git (C1).

The revised design fixes the exact shared placement (which command entry points carry the eager guard, and how it stays off the porcelain `config` path) and pins the command matrix (`status`/`add`/`log`/`commit` die; `config --get`/`--list` succeed).

## Consequences

### Positive

- Faithful to git's eager `core` path-like die — the one family where a feature-consumer guard (option 3b) would have been unfaithful (it would catch `status`/`add` but not `log`/`rev-parse`).
- Reuses `findFirstValuelessEntry` + `CONFIG_MISSING_VALUE`; no new error code.

### Negative

- Introduces a refusal on a broad command surface that today never throws on valueless `core.*`. The placement must be careful not to throw on the porcelain `config` path (C2) or on the absent/empty cases (regression risk). This is the largest blast radius in the PR; the revised design + interop matrix must pin the boundary precisely.

### Neutral

- Shares the "eager valueless validation" shape with ADR-349 (`branch.*` eager die within `pull`); the revised design decides whether they share a helper or stay separate (the key sets and scopes differ — `core` is flat and every-command; `branch.*` is per-subsection and pull-scoped).
