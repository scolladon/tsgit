# ADR-347: Valueless `merge.<driver>.driver`/`name` — guard lazily at driver resolution

## Status

Accepted

## Context

Pinned M1/M2 (git 2.54.0): when a `.gitattributes` rule resolves `merge=<driver>` and the `[merge "<driver>"]` section has a valueless `driver` (or `name`), git dies `missing value for 'merge.<driver>.driver'` at the merge — exit 128. Pinned M3: this is **lazy** — git does not die in `git_default_config`; the read happens only when a merge actually resolves that driver. tsgit's `resolve-merge-driver.ts` `namedChoice` currently reads the driver and, when `driver` is `undefined`, returns the built-in `text` 3-way merge — a benign fallback, no refusal.

The design recommended deferring (the guard converts a harmless fallback into a hard refusal). The user chose to guard now.

## Decision

Guard at the **driver-resolution site** (`namedChoice`, before the `return TEXT` fallback): when `[merge "<name>"]` is configured for the resolved attribute but its `driver`/`name` is valueless, call `assertNoValuelessConfig(ctx, 'merge', name, ['driver', 'name'])` before falling back. This reproduces git's lazy die exactly — only when a merge resolves that named driver, not eagerly.

Both `driver` and `name` are in the key set (M2 pins git dying on a valueless `name` too); file-line order decides which is reported (requirement 2 of the design, `findFirstValuelessEntry`'s existing behaviour).

The guard fires only when an attribute actually resolves to the named driver — a valueless `[merge "x"]` that no path references stays inert, matching git's laziness.

## Consequences

### Positive

- Faithful to git's die at custom-merge-driver resolution (M1/M2), reusing the existing primitive + error — one additive call.
- Lazy placement keeps the blast radius to conflicting merges on paths carrying a custom `merge=` attribute; clean paths and the default merge are untouched.

### Negative

- Converts tsgit's previously-benign "valueless driver → built-in text" fallback into a refusal — a behaviour change for repos that (mis)configured a valueless driver and relied on the silent fallback. Accepted under ADR-346's faithful-maximal scope.

### Neutral

- Every 3-way consumer (cherry-pick/revert/rebase/stash) inherits the guard for free via the shared `buildContentMerger`/driver-resolution path; the interop matrix pins `merge`, with the others covered by the shared code path.
