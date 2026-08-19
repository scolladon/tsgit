# 704 — A written reftable is equivalent-under-readback, with a byte-identical prefix

- **Status:** accepted
- **Date:** 2026-08-19
- **Design:** docs/design/reftable-ref-storage.md (candidate DN-1) · **Refines:** ADR-140, ADR-680

## Context

ADR-680 makes tsgit write reftables, which raises the `@writes` contract question: byte-identity
against git, or equivalence?

Measured. Given identical logical content and update indices, **git's writer is a pure
function** — two from-scratch builds produced byte-identical tables. But the log section's
DEFLATE stream is implementation-defined: git (Apple `libz` 1.2.12, level 9) produces 145 bytes;
Node `zlib` 1.3.1 at level 9 produces 147; `CompressionStream('deflate')` produces 147 different
bytes again. A sweep of 2835 Node parameter combinations reproduced none of git's output.
**Everything before `log_position` is reproducible.**

## Options considered

1. **`equivalent-under-readback` for the table, plus an interop assertion that the prefix up to
   `log_position` is byte-identical to git's** — pros: claims exactly what is achievable, and
   still pins the large reproducible majority byte-for-byte.
2. **`equivalent-under-readback`, records-only** — pros: simplest / cons: gives up the
   byte-identical prefix that *is* provable, weakening the contract for no reason.
3. **Chase `byte-identical` by vendoring a matched DEFLATE implementation** — cons: a vendored
   compressor to match one platform's libz build, against a zero-dependency constraint, for a
   property that would break on the next libz release.

## Decision

**Option 1 — adopted as recommended (no user judgment).**

The `@writes` block carries `kind: equivalent-under-readback`, and the interop suite additionally
asserts byte-identity of everything up to `log_position`.

This follows the repository's own existing split exactly: `packfile` is
`equivalent-under-readback` **because** deflate is implementation-defined, while `.rev` is
`byte-identical` because nothing in it is. Reftable is the first artefact that is both — hence
the split contract.

## Consequences

- The interop assertion is sharper than a bare readback: a regression in header, block, restart
  point or footer encoding fails on bytes, not on a semantic round-trip that might mask it.
- The log section is proven by readback and by git reading tsgit's table, not by bytes.
- If a future zlib makes the streams agree, that is a strengthening, not a contract change; the
  ADR would be superseded rather than violated.
