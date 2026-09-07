---
subjects:
  - src/domain/storage/pack-name-hash.ts
---
# 829 — tsgit implements name-hash version 1 only

- **Status:** accepted
- **Date:** 2026-09-07
- **Design:** docs/design/name-hash-delta-ordering.md (DC-4)

## Context

git 2.55.0 ships two name-hash functions in `pack-objects.h`. `pack_name_hash` (v1) folds the
last sixteen non-whitespace characters, weighting the tail so names sharing a suffix cluster.
`pack_name_hash_v2` additionally reverses each byte's bits and mixes a directory component at
every `/`, so it clusters by directory as well as basename.

Selection is `pack_name_hash_fn`, and `name_hash_version` defaults to 1. v2 is reachable only
through the `--name-hash-version` command-line option, and `validate_name_hash_version` forces
it back to 1 whenever a bitmap index is being written. No repository configuration key selects
it — there is no `pack.nameHashVersion`.

Whitespace is skipped by git's `isspace`, which under its sane-ctype rules is exactly
`0x09 0x0a 0x0d 0x20`; vertical tab and form feed are hashed, not skipped. This was pinned by
compiling both functions verbatim and recording vectors, rather than inferred from C semantics.

## Options considered

1. **v1 only** (chosen) — pros: git's default, the only version a bitmap-writing path may use, and the whole of what a repository can ask for / cons: a wide tree that v2 would cluster better packs slightly larger.
2. **v1 and v2 behind a tsgit-only option** — pros: v2's directory clustering can help wide trees / cons: no git setting maps to it, so the option is tsgit's alone — a knob with no faithfulness anchor — and v2's two-word fold state widens the hasher seam.
3. **v2 only** — pros: better clustering on wide trees / cons: diverges from git's default on every pack written, and would be wrong for any future bitmap-writing path.

## Decision

**User-ratified.** tsgit implements v1. The hasher is written so a second version is a new
implementation of the same seam rather than a change to the walker or the comparator, and the
pinned v2 vectors are recorded in the test suite as data, so adopting it later is a port rather
than a re-derivation.

## Consequences

Every pack tsgit orders uses the same hash git would use by default, and no repository setting
exists that tsgit would be ignoring. A future bitmap-writing path inherits the version git
would force anyway.

Wide-tree corpora where v2's directory clustering would help are packed with v1's basename
clustering instead, which is what git does by default too — so the gap is against git-with-an-
explicit-flag, not against git.

Recording v2's vectors without implementing v2 means the suite carries data for a code path that
does not exist. That is deliberate: the vectors were expensive to pin correctly, and pinning
them is what makes the later port cheap.
