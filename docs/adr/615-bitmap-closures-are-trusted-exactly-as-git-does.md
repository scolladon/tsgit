# 615 — Bitmap closures are trusted, exactly as git does

- **Status:** accepted (ratified — new scope, no design recommendation existed)
- **Date:** 2026-08-09
- **Design:** docs/design/rev-index-bitmap-read-support.md (revision) · **Refines:** ADR-226, ADR-606

## Context

ADR-613 and ADR-614 let a bitmap decide which objects a closure contains, and therefore
which objects a pack carries. A wrong bitmap means a wrong pack. git's posture is to trust:
it verifies a bitmap's checksum only at `fsck` time, and consumes the file unverified on
the read path — a bitmap whose embedded pack checksum is wrong is used without complaint,
and only `--test-bitmap` notices structural damage.

## Options considered

1. **Trust, exactly like git** — byte-faithful and free / a corrupt bitmap silently
   produces a wrong object set.
2. **Verify the trailer once, then trust the closure** — catches accidental corruption /
   diverges from git by declining a file git would use, and hashes a whole file on the path
   the acceleration exists to speed up.
3. **Cross-check the closure against a walk** — strictly more expensive than the walk it
   replaces; viable only as a test oracle.

## Decision

Option 1, symmetric with ADR-606 one layer out. A bitmap is consumed as found, with no
pre-use digest verification. Verification lives where git puts it — in `fsck`, which under
ADR-605 hashes the file and does not parse it.

The prime directive is the ratio, with the same reasoning as ADR-606: an attacker who can
rewrite a `.bitmap` can rewrite the `.pack` it describes, so trusting it confers no
capability they lack. The exposure is **accepted, not mitigated**.

Option 3 is adopted **as a test-only oracle**: the interop suite asserts the
bitmap-accelerated closure and the walk closure are identical on every fixture, which is
where the cross-check earns its cost.

## Consequences

A security review will flag a trusted read of an attacker-influenceable file; this ADR and
ADR-606 are the standing answer. Parse-time bounds (ADR-611) remain in full force — trusting
content is not trusting length.

**Refinement (ADR-622).** "Trust, exactly like git" was taken on incomplete evidence and is
narrowed: git trusts a bitmap's **reachability semantics** but **range-validates its
integers**. Measured, on a file whose checksum is valid so `fsck` exits 0, an out-of-range
entry position makes git print `error: corrupt ewah bitmap: … out of range`, decline the whole
artefact and fall back to the walk. tsgit does the same (ADR-622). What remains trusted is a
bitmap whose positions are all in range but semantically wrong — that is the real, narrow
residual, and it is git's too.

This also retires the sentence that made the pairing with ADR-616 uncomfortable: the interop
equality assertion is **no longer the only thing** between a decoder fault and a wrong pack —
range validation catches it before any oid is resolved. The assertion remains mandatory as a
second line, and must never be trimmed.
