# 443 — Signing formats for v1: OpenPGP and SSH

- **Status:** accepted
- **Date:** 2026-07-03
- **Design:** docs/design/gpg-signing.md · **Relates:** ADR-226 (git-faithfulness), ADR-442 (CommandRunner reuse)
- **Decision class:** D-scope (user judgment)

## Context

git's `gpg.format` selects the signature backend: `openpgp` (default, via `gpg`), `ssh`
(via `ssh-keygen -Y sign`), or `x509` (via `gpgsm`). Each has a distinct argv contract and
a distinct on-object encoding, all pinned in the design against real git 2.55.0. Supporting
more formats widens the interop-test matrix and the config surface.

## Options considered

1. **OpenPGP only** — smallest surface; `ssh`/`x509` become follow-ups.
2. **OpenPGP + SSH** *(user choice)* — the default backend plus SSH signing, which is
   topical now that SSH transport landed (24.19 / ADRs 434–441) and whose argv contract
   (`ssh-keygen -Y sign -n git -f <key> <tempfile>` → `<file>.sig`) is fully pinned.
3. **All three (+ x509/gpgsm)** — also the niche x509 path; largest surface.

## Decision

**Option 2, ratified by the user.** v1 implements `gpg.format` ∈ {`openpgp`, `ssh`}.
`x509` is out of scope and, when requested, refuses with a typed unsupported-format error
(faithful to git's own behavior when its `gpgsm` is unavailable is *not* the model — here
the format is deliberately unimplemented, so the error is explicit). `gpg.format` defaults
to `openpgp`.

## Consequences

### Positive
- Covers the default backend and the increasingly common SSH backend, aligned with the
  freshly landed SSH transport work.

### Negative
- `x509` users are unserved until a follow-up; requires a clear typed error, not a silent
  fallback.

### Neutral
- The signer primitive is written format-dispatched, so adding `x509` later is additive
  (one argv arm + one encoding arm + interop pins).
