# ADR-337: Interop helper isolates HOME via a non-existent path

## Status

Accepted

- **Date:** 2026-06-15
- **Design:** [design/interop-helper-env-hardening.md](../design/interop-helper-env-hardening.md)

## Context

`test/integration/interop-helpers.ts`'s `buildSafeEnv()` scrubbed every `GIT_*` key and set `GIT_CEILING_DIRECTORIES`, but spawned git with the developer's inherited `HOME` and no `GIT_CONFIG_NOSYSTEM`. Pinned against git 2.54 (design Matrix A): every global key leaked — `merge.conflictStyle=diff3`, `user.name`, `commit.gpgsign=true`, `init.defaultBranch`, a custom `merge.<name>.driver`, plus the system `credential.helper`. The design matrices the interop tests assert against were produced under `env -i` + isolated `HOME` + `GIT_CONFIG_NOSYSTEM=1`, so the suite ran under a dirtier env than it was pinned for — the same trap class as the prior `merge.conflictStyle=diff3` flake. Closing the global-config vector requires redirecting git's `$HOME/.gitconfig` lookup somewhere harmless. Matrix D pinned that git treats a missing `$HOME` as "no global config" and writes nothing under `$HOME` during `init`/`add`/`commit` (signing off, no credential flows in the corpus), so a `HOME` git only ever reads from needs no backing directory at all.

## Options considered

1. **Real empty tmpdir at module load** (`mkdtempSync(os.tmpdir()+'/tsgit-interop-home-')`) — *(design recommendation)* matches the `missing-value-refusal-interop` precedent and survives a hypothetical future credential/askpass flow; cons: creates a resource whose cleanup must be decided.
2. **Guaranteed-empty fixed dir** (a reused `os.tmpdir()/tsgit-interop-empty-home`) — no per-run creation; cons: risks a non-empty dir if the path is ever polluted/reused.
3. **(chosen) Deterministic non-existent path under `os.tmpdir()`** — git fail-soft (Matrix D): zero filesystem footprint, nothing created, no cleanup story needed; cons: a future suite that needs git to *write* under `$HOME` would fail against a missing dir.

## Decision

`buildSafeEnv()` sets `HOME` to a deterministic non-existent path under `os.tmpdir()` (no `mkdtemp`, no directory creation). Git's global-config lookup (`$HOME/.gitconfig`) misses and resolves no value. The companion system-config vector is closed in the same factory by setting `GIT_CONFIG_NOSYSTEM=1` (no alternative — git's canonical system-config opt-out; Matrix B canary `credential.helper`). The existing `GIT_*` scrub + `GIT_CEILING_DIRECTORIES` guard are retained unchanged. Because git never writes under `$HOME` in this corpus, there is **no tmpdir to clean up** — the cleanup decision candidate is moot.

## Consequences

### Positive

- Spawned git reads no developer global config (Matrix B: all probed keys return exit 1) and no system config (NOSYSTEM). A future suite that forgets to pin a config-sensitive value no longer passes by accident on the author's machine while diverging from the design matrix.
- Zero filesystem side effects and no teardown machinery — the leanest faithful shape.

### Negative

- If a future interop suite needs git to *write* under `$HOME` (a credential cache, askpass), it would fail against the non-existent path and must point `HOME` at its own (e.g. per-`makePeerPair`) directory. This is a deliberate, documented trade vs. the design's real-tmpdir recommendation.

### Neutral

- `init.defaultBranch` is no longer read from ambient config (Matrix B2: the unspecified default would flip `main`→`master`), but every `init` in the corpus passes `-b <branch>` explicitly, so the shift is latent — the corpus becomes robust to a dev with a different ambient default rather than changing behaviour.
- The `XDG_CONFIG_HOME` vector is an explicit override independent of the `HOME`-relative fallback and is closed separately ([ADR-338](338-interop-helper-xdg-config-home-inside-home.md)).
