---
subjects:
  - src/domain/objects/tree.ts
  - src/application/primitives/write-tree.ts
  - src/public-types.ts
---
# 749 — TreeEntry is branded and minted only through its factory

- **Status:** accepted
- **Date:** 2026-08-30
- **Design:** docs/design/tree-entry-byte-sensitivity.md (D2) · **Supersedes/Refines:** applies ADR-747's byte-faithful shape to tree objects

## Context

`TreeEntry.name` is a `string` produced by a BOM-stripping, U+FFFD-lossy decode, so
`serializeTreeContent(parseTreeContent(bytes))` does not round-trip for a name carrying
a byte-order mark or invalid UTF-8 — the re-serialised tree gets a different object id.
Measured against git 2.55.0: a `EF BB BF 61` entry name is accepted and preserved by
`hash-object`, `ls-tree`, `read-tree` and `rev-parse`, and git's `rev-parse <tree>:a`
correctly does not match it, because git compares bytes. Fixing the refusal predicates
alone would turn today's false refusal into a silent collapse: two distinct names both
becoming `"�"` inside one `Tree`.

## Options considered

1. **Bytes only — `TreeEntry { mode, nameBytes, id }`, caller decodes** — pros: one representation, a lossy comparison becomes unwritable / cons: worse for every consumer, forever, to protect a rare case; both reading and writing get more verbose.
2. **Both fields required on a plain interface** (designer's recommendation was the optional variant) — pros: readers unchanged / cons: the `name`/`nameBytes` consistency is convention-enforced; an inconsistent object literal type-checks.
3. **Branded type plus an exported factory** — pros: one type, the invariant is compiler-enforced, the library owns encoding / cons: every construction site becomes a factory call.

## Decision

**Ratified by the user: option 3.** `TreeEntry` carries `nameBytes` (authoritative, the
on-disk bytes) alongside `name` (the derived display view), and is branded in this
repo's existing idiom so an object literal cannot satisfy it. The only mints are the
exported factory — which accepts `string | Uint8Array` and performs the encode itself,
so no consumer touches a `TextEncoder` — and `parseTreeContent`, which routes through
the same factory. Serialisation, sorting and comparison read `nameBytes`; nothing reads
`name` to make a decision.

## Consequences

### Positive

- `writeTree(tree.entries)` round-trips byte-identically with nothing for the caller to remember.
- An inconsistent `name`/`nameBytes` pair is a compile error, not a review finding.
- Because construction is owned, the internal representation can change later without touching a consumer.

### Negative

- A breaking change for anyone constructing tree entries: `{ name, mode, id }` literals become factory calls. Internally that is roughly twenty `src` sites and entry-shaped literals across many test files.
- The brand stops a literal, not a spread. `{ ...entry, name: 'x' }` still type-checks, because the spread carries the brand property along with everything else, so an inconsistent pair can be built that way. Measured: the tree holds exactly two such spreads, both in a benchmark fixture and both overriding `id` only, so nothing is inconsistent today. This is a known limit of the technique, accepted rather than worked around — the alternative is a class with private state, which the domain layer does not use.

### Neutral

- `FilePath` stays a decoded string; the byte fidelity this establishes ends at that boundary, which ADR-757 records at its real edge.

### Release

This is a **breaking public API change** and ships as a **major**. `TreeEntry` is a
published type and `writeTree` takes it as input, so both the read and the write half of
the tree surface change shape. The commit that lands the type carries the conventional
`!` breaking marker, and because this repo merges by squash — making the pull-request
title the released commit's subject — that title carries the marker too. Release
tooling is configured for the `node` release type with no pre-major special-casing, so
the marker is what moves the version; nothing else needs to be set by hand.
