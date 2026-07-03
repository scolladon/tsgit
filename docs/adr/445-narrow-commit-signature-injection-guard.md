# 445 — Narrow the commit-signature injection guard to NUL/CR

- **Status:** accepted
- **Date:** 2026-07-03
- **Design:** docs/design/gpg-signing.md · **Relates:** ADR-226 (git-faithfulness)
- **Decision class:** D-security (user judgment)

## Context

`createCommit` (`src/application/primitives/create-commit.ts`) validates the optional
`gpgSignature` input with a header-injection guard (`hasHeaderInjectionChars`) that rejects
any value containing `\n\n`, a leading `\n`, or a trailing `\n`. Every real OpenPGP armor
violates this: the armor has a blank line after `-----BEGIN PGP SIGNATURE-----` and a
trailing newline. As written, `createCommit` rejects **every genuine signature**, so
signing cannot work at all until the guard is resolved. The commit serializer already
space-prefixes interior LFs when emitting the `gpgsig` continuation header, so interior
newlines cannot break out of the header — only a raw NUL or CR could smuggle a new header
line.

## Options considered

1. **Narrow the signature check to NUL/CR only** *(design recommendation, user choice)* —
   for the `gpgSignature` field specifically, reject only NUL/CR (the characters that
   actually enable header injection given continuation-encoding); permit the blank
   line/trailing newline that valid armor requires.
2. **Normalize the armor before injection** — pre-process the signature to satisfy the
   existing guard unchanged. Fragile; couples signing logic to the guard's internals.
3. **Trusted internal write path** — `createCommit` skips the guard for self-produced
   signatures. Simplest, but removes the safety net for that field.

## Decision

**Option 1, ratified by the user.** The `gpgSignature` field is validated by a narrowed
check that rejects only NUL and CR. This is scoped to the signature field — other header
inputs (author/committer/message) keep their existing validation. The narrowing is safe
because the continuation encoder neutralizes interior LFs; NUL/CR are the only characters
that could inject a spurious header, and both remain rejected.

## Consequences

### Positive
- Signing works with genuine armor; the guard still blocks the characters that actually
  enable header injection.

### Negative
- The `gpgSignature` field uses a different (narrower) validation than other header
  inputs; the asymmetry must be justified in the code's naming and covered by a guard test
  per condition (NUL rejected, CR rejected, valid armor accepted).

### Neutral
- No on-object divergence — the produced object is byte-identical to git's.
