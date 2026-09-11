---
subjects:
  - src/application/primitives/pack-registry.ts
  - src/application/primitives/internal/config-read.ts
---
# 858 — The explicit delta-base budget option suppresses the config key

- **Status:** accepted
- **Date:** 2026-09-11
- **Design:** docs/design/session-caches-per-command-floor.md (NDC-1) · **Supersedes/Refines:** refines ADR-852

## Context

ADR-852 gave the delta-base cache two levers — the explicit `deltaBaseCacheMaxBytes` option and
the repository's `core.deltaBaseCacheLimit` key — and named them "in this order" without saying
which wins when both are set. That is not a detail an implementer can settle: it decides whether
an embedding host can cap its own memory, and it decides whether a malformed key in a repository
is even looked at when the host has already supplied a value.

Git has a direct analogue. `git -c core.deltaBaseCacheLimit=1m …` over a file value of `-1` exits
0 — an overridden file value is **never validated** — while a malformed override is refused
(pinned as C5). Command-line precedence is last-wins in the config set, and validation follows
the value that wins.

## Options considered

1. **The option wins and suppresses the key** (recommended, chosen) — when
   `deltaBaseCacheMaxBytes` is supplied the key is neither read nor validated. Pros: the only
   alternative with a pinned git precedent; an embedding host can cap memory unconditionally.
   Cons: a repository's deliberate tuning is ignored by a host that has its own opinion.
2. **The key wins; the option only replaces the absent-key default** — the literal "in this
   order" reading. Cons: a browser tab that must cap memory cannot, if the cloned repository's
   config says `96m` — the repository overrides the embedder.
3. **`min(option, key)`** — the host caps, the repository may only lower within the cap. Cons: no
   git analogue, and a user raising the key above the option is ignored with no signal.

## Decision

**Option 1.** Resolution order is: the explicit `deltaBaseCacheMaxBytes` option if supplied;
otherwise `core.deltaBaseCacheLimit` if present and valid; otherwise git's 96 MiB default. When
the option is supplied the key is **not read and not validated** — the option is tsgit's `-c`,
and suppressing validation of a value that cannot take effect is the faithful transcription of
C5 rather than a convenience.

This makes the eager validator's skip condition (design D2-ii) a pin rather than an optimisation:
the validator is skipped exactly when `cacheBudgets.deltaBaseCacheMaxBytes` is set, because that
is the case in which git would not have validated the file value either.

## Consequences

An embedding host that passes the option is immune to a malformed key in the repositories it
opens, which is the behaviour a browser tab or a server needs and the behaviour git gives a
caller who passes `-c`.

A caller who wants the repository's own tuning simply does not pass the option — the same choice
a git user makes by not passing `-c`.

The skip is observable and is tested as such: with a malformed key present, a Context built with
the option opens and reads normally, and the same Context built without it refuses.
