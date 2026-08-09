# 612 — The midx-bitmap check does not inherit git's config gate

- **Status:** accepted (adopted-as-recommended)
- **Date:** 2026-08-09
- **Design:** docs/design/rev-index-bitmap-read-support.md (DC-10, Pin K) · **Refines:** ADR-592

## Context

Pinned asymmetry: git gates the **midx**-bitmap check on `core.multiPackIndex` but leaves
the **pack**-bitmap check ungated (design Pin K rows X1 versus X8). tsgit's `readConfig`
has no such key — ADR-592 declined to add it for the midx read path.

## Options considered

1. **No gate — always run** (designer's recommendation) — matches git's default
   configuration / diverges when a user has explicitly disabled the feature.
2. **Add the config key and gate on it** — strictly more faithful / adds a config key, a
   precedence question, and a surface with no other use.
3. **Skip the midx-bitmap arm entirely** — avoids the question / drops a real exit-bit-128
   cause.

## Decision

Option 1. Both bitmap arms run unconditionally. This is the second time the same call is
made from ADR-592's premise, which is consistency rather than inertia.

Recorded as a **named, deliberate divergence**, not an implementation detail: tsgit matches
git's default configuration and differs only from an explicitly disabled one. ADR-617's
ratification widens the divergence's blast radius — the key would gate the *read* path too,
not only `fsck` — and this ADR accepts that with the same ratio.

## Consequences

A repository configured with the multi-pack-index disabled sees tsgit verify and consume a
midx bitmap where git would not. Should the config key ever arrive for another reason, this
gate is the first consumer to revisit.
