---
subjects:
  - src/domain/objects/tree-entry-bytes.ts
  - src/domain/fsck/validate-tree.ts
---
# 751 — Byte keys are built from char codes, not a text decoder

- **Status:** accepted
- **Date:** 2026-08-30
- **Design:** docs/design/tree-entry-byte-sensitivity.md (D4) · **Supersedes/Refines:** none

## Context

Duplicate detection and sort keys need a map key that is one-to-one with a name's raw
bytes. The obvious shortcuts are wrong in different ways: keying on the UTF-8-decoded
name is the defect being fixed, and hex doubles key length on a whole-directory hot
path.

## Options considered

1. **A key built from the bytes with `String.fromCharCode`** — pros: one code unit per byte, engine-friendly, byte-identity by construction / cons: must be chunked, never spread — a 4096-byte name would overflow the argument list.
2. **A pairwise byte comparison over a list of name spans** — pros: no key at all / cons: quadratic per directory, acceptable for a single-name descent but not for a whole-tree parse or fsck's sort and duplicate passes.
3. **A hex key via the existing helper** — pros: trivially correct / cons: two code units per byte on a hot path.

## Decision

**Adopted as recommended (no user judgment).** Byte keys are built by walking the bytes
and accumulating char codes in bounded chunks.

**`TextDecoder('latin1')` is not an option, and the reason matters.** It is *not* a
byte-identity map: the WHATWG encoding standard aliases `latin1` and `iso-8859-1` to
windows-1252, so twenty-seven bytes in `0x80`–`0x9F` decode to a different code point
(`0x80` → U+20AC, `0x92` → U+2019, and so on). Measured over all 256 byte values, that
mapping is nevertheless **injective — zero bytes decode to U+FFFD and no two bytes
collide** — so it would in fact work as a duplicate key. It is rejected because it is
not reversible to the original byte, which makes any later use of the key as a name
silently wrong, not because it collides.

## Consequences

The key is an implementation detail of the classifier and of fsck's duplicate and sort
passes; it never escapes either. Anyone tempted to reach for a text decoder here should
read the measurement above rather than re-derive it.
