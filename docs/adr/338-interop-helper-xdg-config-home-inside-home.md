# ADR-338: Interop helper points XDG_CONFIG_HOME inside the isolated HOME

## Status

Accepted

- **Date:** 2026-06-15
- **Design:** [design/interop-helper-env-hardening.md](../design/interop-helper-env-hardening.md) · **Refines:** [ADR-337](337-interop-helper-home-isolation-non-existent-path.md)

## Context

Git resolves global config from two places that are **independent** of each other: `$HOME/.gitconfig` and `$XDG_CONFIG_HOME/git/config`. [ADR-337](337-interop-helper-home-isolation-non-existent-path.md) closes the `HOME` vector with a non-existent path, which also kills git's *fallback* XDG lookup (`$HOME/.config/git/config`, used only when `XDG_CONFIG_HOME` is unset). But an **explicitly set** `XDG_CONFIG_HOME` is read regardless of `HOME` — design Matrix C pinned that with an isolated `HOME` and `XDG_CONFIG_HOME` pointed at a real `git/config`, git read `merge.conflictStyle=zealous-diff3` from it (exit 0, leak). The dev's `XDG_CONFIG_HOME` is currently unset (dormant), but `buildSafeEnv()` passes through every non-`GIT_*` key, so a dev or CI lane that sets `XDG_CONFIG_HOME` (common on Linux) would reintroduce the leak the helper is meant to close.

## Options considered

1. **(chosen, design recommendation) Point `XDG_CONFIG_HOME` inside the isolated HOME** (`<HOME>/.config`) — the XDG lookup lands in the same non-existent tree as `HOME`, one coherent isolation story; survives a child process that re-derives XDG defaults relative to `HOME`.
2. **Unset (delete) `XDG_CONFIG_HOME`** — simpler, equally correct for git itself (the `HOME`-relative fallback is already dead); cons: a *second*, different mechanism (delete vs. redirect) where one redirect would do.
3. **Do nothing** — rely on `XDG_CONFIG_HOME` being unset on the dev's machine; cons: latent leak on any Linux box that sets it — rejected.

## Decision

`buildSafeEnv()` sets `XDG_CONFIG_HOME` to `<HOME>/.config`, where `HOME` is the non-existent path from [ADR-337](337-interop-helper-home-isolation-non-existent-path.md). Both git config-discovery roots therefore point into one dead directory tree: the explicit XDG override and the `HOME`-relative fallback resolve to the same non-existent location, fail-soft to "no config." No directory is created (consistent with ADR-337; Matrix D shows git writes nothing there).

## Consequences

### Positive

- The XDG leak vector (design Matrix C) is closed even on a machine/CI lane that exports `XDG_CONFIG_HOME` — the helper no longer depends on it being unset.
- A single coherent isolation model: every git config-discovery path points into the one isolated (non-existent) HOME tree.

### Negative

- One extra env key on `SAFE_ENV`. Negligible.

### Neutral

- Equivalent to unsetting `XDG_CONFIG_HOME` for git's own behaviour today; the redirect is chosen for self-consistency with the HOME isolation rather than a behavioural difference.
