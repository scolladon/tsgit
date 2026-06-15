# ADR-349: Single multi-key guard at the consuming site for `merge.<d>.{driver,name}`, `submodule.<n>.url`, `remote.<n>.pushurl`

## Status

Accepted (at `53b61b42`)

## Context

Three remaining string keys each die with the `missing value` shape (pinned, git 2.54.0, exit 128) at exactly one tsgit consuming site:

- `merge.<d>.driver` / `merge.<d>.name` — git engages the named driver only when a path's `merge` attribute selects `<d>`; it reads `.name` **independently** of `.driver`.
- `submodule.<n>.url` — git dies at `git submodule update`; `git submodule sync` reads `.gitmodules`, not config, and does **not** die.
- `remote.<n>.pushurl` — git dies on a valueless `pushurl` **even when `url` is valued** (the `pushurl ?? url` fallback does not save it); when both `pushurl` and `url` are valueless, git reports whichever is earlier in the file.

The shared design question is *where* the guard sits so it fires exactly when git dies and never when git falls through, and so that sibling keys that can co-occur are reported in git's file-line order.

## Decision

Place a **single multi-key `assertNoValuelessConfig` call at the consuming site, before any fallback substitutes a value**, so the guard preserves git's first-valueless-by-file-line order and never refuses where git succeeds:

- **`merge.<d>.{driver,name}`** — `assertNoValuelessConfig(ctx, 'merge', <d>, ['driver','name'])` in `resolve-merge-driver`'s `namedChoice`, before the `driver?.driver === undefined → TEXT` fallthrough. A built-in name (`text`/`binary`/`union`) and an absent `[merge "<d>"]` section keep returning `TEXT`.
- **`submodule.<n>.url`** — `assertNoValuelessConfig(ctx, 'submodule', <n>, ['url'])` on the `config.submodule[<n>].url === undefined` branch in `submoduleUpdate`, git's pinned death command. `submodule sync` gets no guard.
- **`remote.<n>.pushurl`** — replace the existing `['url']`-only guard in `push`'s `resolveRemoteUrl` with a **single pre-resolution `['pushurl','url']`** call, run after `readConfig` and before `url = pushUrl ?? url`. The wholly-absent case still falls through to `REMOTE_NOT_CONFIGURED` (the guard no-ops when nothing is valueless).

## Consequences

### Positive

- Each key refuses at its one faithful death site with the correct `{key,source,line}`; the both-valueless co-occurrences (`pushurl`+`url`) report git's file-line order via the single multi-key call.
- Reuses the 24.9l enabler verbatim — no new mechanism.

### Negative

- The `push` `pushurl`/`url` guard widens 24.9l's `['url']`-only call to `['pushurl','url']`; the existing `url`-only interop row must be re-verified (unchanged for a single valueless key, since file-line order with one match is identical).

### Neutral

- `merge.<d>.name` is guarded jointly with `.driver` because git reads it independently; a valueless `.name` under a selected driver therefore refuses even when `.driver` is valued.
