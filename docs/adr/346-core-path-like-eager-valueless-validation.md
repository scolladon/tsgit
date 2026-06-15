# ADR-346: `[core]` path-likes refuse a valueless value eagerly, matching git's broad death

## Status

Accepted (at `53b61b42`)

## Context

git dies with the two-line `missing value` shape (`error: missing value for '<key>'` / `fatal: bad config variable '<key>' in file '<F>' at line <N>`, exit 128) on a valueless `[core]` path-like (`core.excludesFile`, `core.attributesFile`, `core.hooksPath`). Pinned against git 2.54.0: the death is **eager** — it fires in `git_default_config` at config load, so `git status`, `git log`, **and** `git commit` all die, not just the command that consumes that particular path. Porcelain `git config --list`/`--get` still succeed (they do not run the default-config callback).

tsgit reads these fields lazily, each at one accessor: `core.excludesFile` in `readGlobalExcludes`, `core.attributesFile` in `readGlobal`, `core.hooksPath` in `invokeHook`. A per-accessor guard would refuse with the correct `{key,source,line}` — but only on the narrower set of commands that reach that accessor, so `git log` would die in git while tsgit's `log` succeeded. That set of commands that refuse is an **observable refusal condition**, governed by the prime directive (ADR-226), **not** by ADR-249 (which scopes only rendered display, not which commands refuse).

ADR-327 chose a cold-path-only raw re-read for the identity/remote-URL scope to keep `ParsedConfig` clean and validation lazy. The `[core]` path-likes are the first class where git's faithful behaviour is *eager and broad*, so the cold-path-only trigger does not reach far enough on its own.

## Decision

For the `[core]` path-likes, refuse a valueless value **eagerly with git's broad reach**: every command that loads git's default config (the porcelain surface — status, log, commit, add, diff, merge, …) refuses with `CONFIG_MISSING_VALUE { key, source, line }` when any of `core.excludesfile` / `core.attributesfile` / `core.hookspath` is present-but-valueless, **before** the command does its work. The config porcelain (`config --get`/`--list`/`getRegexp`) must keep succeeding, mirroring git's separate read path.

This **refines** ADR-327 (it does not supersede it): the detection primitive `findFirstValuelessEntry` and the `CONFIG_MISSING_VALUE` shape (ADR-328) are reused verbatim; only the *trigger breadth* widens for this key class — from a single command's refusal path to a shared eager gate run across the default-config-loading surface. The revised design pins the exact command boundary empirically (which commands die in git, which — like `config --list` — do not) and chooses the implementation chokepoint that does not break the config porcelain.

## Consequences

### Positive

- Refusal breadth matches git byte-for-byte across the porcelain surface — the faithful behaviour, with no narrow-refusal divergence to document away.
- Reuses the 24.9l enabler (`findFirstValuelessEntry` + `CONFIG_MISSING_VALUE`) unchanged; only a new shared trigger is added.

### Negative

- Larger surface than a single accessor: a shared eager gate touches every default-config-loading command, so the implementation must place it carefully (and the test matrix must prove the porcelain config reads still succeed).
- Widens ADR-327's cold-path-only trigger for this key class; the two triggers (cold-path for identity/url, eager for core path-likes) now coexist and the design must keep their boundary legible.

### Neutral

- The eager gate validates only the three `[core]` path-likes git validates in `git_default_config` for this change; other `[core]` string keys are out of scope until pinned to die.
