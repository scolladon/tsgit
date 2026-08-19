# 694 — Width correctness comes from a repository-aware oid predicate

- **Status:** accepted
- **Date:** 2026-08-19
- **Design:** docs/design/sha256-object-format.md (candidate D3) · **Refines:** ADR-681

## Context

46 sites carry a width assumption, most as a literal `/^[0-9a-f]{40}$/`. The tempting fix — reuse
the existing dual `looksLikeObjectId`, which accepts 40 **or** 64 hex — is a trap the design
identified: **width-permissive is not width-correct.** In a SHA-256 repository a 40-hex string is
a valid *prefix*, not a full oid, so a permissive predicate resolves it as a full id and reads
the wrong object. That permissiveness in `ObjectId.from` is precisely what carries an unsupported
repository deep enough to be misdiagnosed seven different ways.

## Options considered

1. **Thread `hexLength` per site** — pros: explicit / cons: 46 hand-edits, each a chance to pass
   the wrong config, and no single place proving the rule.
2. **Reuse the dual `looksLikeObjectId`** — cons: width-permissive, as above; it would make the
   40-hex-prefix confusion systematic rather than incidental.
3. **A repository-aware `isOid(value, hashConfig)` plus `algorithm` on `HashConfig`** (design
   recommendation) — pros: one predicate, one rule, every site asks the repository what an oid is.

## Decision

**Option 3 — adopted as recommended (no user judgment).**

`HashConfig` gains `algorithm`, and a single repository-aware predicate answers "is this a full
oid here?". The 46 sites are re-expressed against it, each classified as must-generalise,
correctly-SHA-1-only, or already-dual — the design's §2 carries that classification.

## Consequences

- A 40-hex string in a SHA-256 repository is a **prefix**, and prefix resolution handles it —
  `resolve-oid-prefix.ts` is therefore in the sweep, not exempt from it.
- One predicate means one place for the mutation suite to prove the rule, instead of 46
  independently-mutable literals.
- `ObjectId.from`'s permissiveness is narrowed at the boundary, which is what stops an
  unsupported or mismatched id reaching far enough to produce a misdiagnosis.
