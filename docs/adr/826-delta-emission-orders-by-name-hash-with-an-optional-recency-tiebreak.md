---
subjects:
  - src/domain/storage/delta-policy.ts
  - src/application/primitives/build-pack.ts
---
# 826 — Delta emission orders by name hash, with an optional recency tiebreak

- **Status:** accepted
- **Date:** 2026-09-07
- **Design:** docs/design/name-hash-delta-ordering.md (DC-1) · **Supersedes/Refines:** amends the ordering half of ADR-769

## Context

The packer orders window candidates by `(typeRank, size DESC, oid ASC)`. Git orders by
`(type DESC, nameHash DESC, preferred_base DESC, [delta islands], size DESC, pointer)` —
`type_size_sort`, `builtin/pack-objects.c:2650`, pinned against git 2.55.0. Two terms tsgit
lacks are load-bearing: the name hash, which clusters same-path history so a version's
predecessor is a window neighbour, and the final key, which separates candidates that tie on
everything else.

The corpus this entry exists for is dense in exactly those ties. `DELTA_CHAIN_FIXTURE` is one
path at a constant 4 096 bytes, so all 300 versions share one name hash and one size: the hash
cannot separate them, and only the final key can. Measured with `git verify-pack -v`, 808 of
900 objects landed as non-delta bases with a max chain of 5, against git's ~43.

Git's final key is a raw pointer comparison — the addresses of two `object_entry` allocations.
It is not reproducible across runs and cannot be reproduced by another implementation. tsgit's `oid ASC` is deterministic
but carries no recency signal, so it leaves the tie unbroken.

## Options considered

1. **`sourceIndex ASC` — the caller's input position, unconditionally** — pros: git's first-seen semantics in the one form tsgit can reproduce; one mode; simplest comparator / cons: emission becomes sequence-keyed for every caller, inverting three live statements (`build-pack.test.ts:441-480` input-order independence, `pack-objects.ts`'s "byte order is a function of the object SET" docblock, `pack-objects.test.ts:289` cross-tier `packId` equality), and every caller inherits an obligation to pass a deterministic sequence.
2. **Keep `oid ASC`** — pros: nothing inverts; set-keyed pack identity survives untouched; smallest diff / cons: the deep-chain tie stays unbroken, so the gap this entry exists to close stays open and the decision reopens after re-measurement.
3. **An optional caller-supplied recency, defaulting absent** (chosen) — pros: emission stays set-keyed and order-independent for every caller that does not opt in, so no existing contract inverts unconditionally; gc opts in and takes the win / cons: two modes to test, and a conditional final term in the comparator.

## Decision

**User-ratified.** The comparator's key becomes `(typeRank, nameHash DESC, size DESC, recency
ASC, oid ASC)`. `recency` is supplied per object by the caller and is absent by default; when
every object's recency is absent the comparator falls through to `oid ASC` and emission is
exactly as order-independent as it is today. gc supplies it and separates same-path versions;
callers that do not are unaffected.

Two of git's terms are deliberately not modelled: `preferred_base`, which tsgit has no thin-pack
path to populate, and delta islands, which are opt-in in git and unimplemented here. Both are
recorded as residuals rather than silently collapsed into a shorter key.

The final key remains `oid ASC` rather than git's pointer compare. That is a divergence from
git and it is deliberate: git's tiebreak is non-deterministic, and determinism wins. The
consequence is that byte-identical packs against git are not achievable on tie-dense corpora,
and the interop oracle is structural — chain-depth distribution and base-vs-delta counts via
`git verify-pack -v` — rather than a pack sha comparison.

## Consequences

The deep-chain corpus becomes reachable: same-path versions sort adjacent and the window
samples the right neighbours. Callers that pass no recency keep a pack sha that is a pure
function of the object set, so `packId` stays a content identity for them and the three
existing order-independence statements stand unchanged. Callers that do pass it accept a pack
sha that is a function of the set *and* the sequence, and must pass a deterministic sequence —
gc already sorts its path-less inputs for exactly this reason.

The two-mode comparator is the standing cost: every ordering test now has a recency-present and
a recency-absent arm, and a future change to the fallback must keep both honest.

ADR-769's decision — metas are `{ id, crc32, offset }` in emission order — is untouched. What
this record amends is the ordering key its Context assumed, and the reason it gave for declining
a name hash ("helps only the callers that have paths; gc has none"), which ADR-828 disproves.
