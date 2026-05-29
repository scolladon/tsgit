# ADR-182: `repo.config` v1 ships all four scopes (local/global/system/worktree)

## Status

Accepted (at `ab51e0a`)

## Context

`git config` operates over four scopes with a defined precedence:

1. **system** — `/etc/gitconfig` (or `$(prefix)/etc/gitconfig`; Windows: `%ProgramData%\Git\config`).
2. **global** — `~/.gitconfig` and `$XDG_CONFIG_HOME/git/config`.
3. **local** — `.git/config`, the per-repo file.
4. **worktree** — `.git/worktrees/<name>/config`, gated by `extensions.worktreeConfig = true`.

For reads, the four sources are merged with later scopes overriding earlier (system → global → local → worktree). For writes, the caller picks a scope explicitly (defaulting to `local`).

The Phase 20.6 design originally recommended shipping `local` only and deferring the rest to a follow-up phase, on the grounds that:

- `global` requires HOMEDIR resolution + `$XDG_CONFIG_HOME` handling in the `FileSystem` adapter (currently only `core.repoPath` is exposed).
- `system` requires platform-specific path discovery (`/etc/gitconfig` on POSIX, `%ProgramData%\Git\config` on Windows, `$(prefix)/etc/gitconfig` on a built-from-source install).
- A precedence resolver is needed for the reads.
- `worktree` needs the `extensions.worktreeConfig` flag check.

The user's call: ship all four in 20.6 anyway, accepting the doubled phase size. The argument is consistency — a partial `repo.config` that only knows about `local` is a leaky abstraction; users who run `git config user.name` expect their `~/.gitconfig` value back. Shipping the full surface in one phase avoids a Phase 20.6-then-20.6b sequence that would have to relitigate the same APIs.

## Decision

`repo.config` ships with full four-scope support in Phase 20.6:

- New `FileSystem` adapter capabilities:
  - `homedir()` — resolves `~` for `~/.gitconfig` and `~/.config/git/config`.
  - `xdgConfigHome()` — honours `$XDG_CONFIG_HOME` env var, falls back to `~/.config`.
  - `systemConfigPath()` — platform-specific (`/etc/gitconfig` POSIX, `%ProgramData%\\Git\\config` Windows, plus `$(prefix)/etc/gitconfig` if Git was built with a non-standard prefix — defer the prefix probe; document as a known limitation).
- New scope precedence resolver: `mergeConfigsByScope([system, global, local, worktree])` — last-writer-wins per key.
- `worktree` scope is read/written only when `extensions.worktreeConfig = true` is set in `local`. Otherwise the worktree scope is invisible.
- Every porcelain method takes an optional `scope?: 'system' | 'global' | 'local' | 'worktree'` parameter (default `local` for writes, merged for reads).
- `list`, `getAll`, `getRegexp` support a `scope` filter; absent the filter, they merge all active scopes.
- New error codes: `CONFIG_SCOPE_NOT_AVAILABLE` (e.g. `worktree` scope when `extensions.worktreeConfig` is unset), `CONFIG_SYSTEM_PATH_UNRESOLVED` (when platform discovery returns no candidate).

### Browser adapter behaviour

The browser adapter cannot resolve `homedir()` or `systemConfigPath()`. Both methods throw a typed error (`FS_OPERATION_NOT_SUPPORTED`); calls to `repo.config.get({ key, scope: 'global' })` against a browser repo fail with a clear "scope not available in browser adapter" message. The `local` and `worktree` scopes remain fully functional in the browser.

## Consequences

### Positive

- **Behaviour parity with `git config`** — users get the values they expect on the first call, not after wondering why `~/.gitconfig` is invisible.
- **No follow-up phase needed** — 20.6b is dissolved. The phase ships the full surface.
- **Precedence resolver lives in the domain** — future read APIs (resolveSignedConfig, credential helper lookup) can reuse it.

### Negative

- **Doubled phase size** — adapter capabilities, precedence resolver, four-scope tests, browser-adapter degradation tests, platform-specific path discovery tests. Implementation estimate roughly doubles vs the `local`-only path.
- **Wider blast radius for `set`** — writing to `system` requires elevated privileges (and tsgit can't reliably check up-front). A `set({ key, value, scope: 'system' })` call that fails with `EACCES` is the caller's responsibility to handle.
- **Browser-adapter asymmetry** — `global`/`system` scope calls succeed in Node and fail in the browser. Documented; otherwise users hit it at runtime.

### Neutral

- **`includeIf` / conditional includes deferred** — the `[include]` and `[includeIf]` directives are out of scope for 20.6 and remain on the backlog. Reads do NOT follow include directives in v1; documented in the design.
- **`--show-origin` / `--show-scope` deferred** — read results in v1 carry the scope they came from in the result envelope (`{ value, scope }`), which subsumes `--show-scope`. `--show-origin` (the source file path) is not exposed.

## Alternatives considered

- **`local` only** — original design recommendation. Rejected per user direction; the abstraction is leaky without the other scopes.
- **`local` + `worktree`** — avoids the HOMEDIR/system-path adapter work but still leaks `global`/`system` invisibility. Rejected on the same consistency argument.
- **Phase 20.6 ships `local`, Phase 20.6b ships the rest** — adds a sequencing dependency and forces the second phase to migrate every caller's `scope` argument. Rejected.
