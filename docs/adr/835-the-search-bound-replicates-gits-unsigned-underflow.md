---
subjects:
  - src/application/primitives/internal/deltify.ts
---
# 835 — The search bound replicates git's unsigned underflow

- **Status:** accepted
- **Date:** 2026-09-07
- **Design:** docs/design/name-hash-delta-ordering.md (DC-10) · **Supersedes/Refines:** refines ADR-831

## Context

git's depth-scaled search bound starts from `max_size = size / 2 - hashSize`, computed in unsigned
arithmetic. `hashSize` is the raw hash width — 20 for sha1, 32 for sha256 — so for any object
smaller than `2 × hashSize` the subtraction wraps and wraps to a value near the unsigned
maximum. The effect is that the smallest objects get an effectively unbounded delta search,
which is the opposite of what the bound is for.

The window is real and reachable: under sha256 it is every object below 64 bytes, and objects of
50 to 63 bytes sit above the 50-byte floor (ADR-834) and therefore still reach the underflow.
Under sha1 the window is every object below 40 bytes, all of which the floor already excludes —
so the floor hides the wrap on sha1 and exposes it on sha256.

Pinned empirically against git 2.55.0 across a sha1/sha256 matrix, rather than reasoned from the
C alone.

## Options considered

1. **Replicate the wrap** (chosen) — pros: git's observable behaviour, which the prime directive takes as the default; small objects get the same unbounded search they get in git; one formula, one set of vectors / cons: ports arithmetic that is plainly not what the code intends, and a future reader may try to "fix" it.
2. **Clamp a negative bound to zero, and diverge with a record** — pros: arguably what git meant, and removes a surprising cliff / cons: a deliberate divergence on a size-affecting path, and it makes tsgit's packs differ from git's for small objects in a case no fixture currently covers.
3. **Replicate under sha1, clamp under sha256** — cons: two code paths and two vector sets for one formula, and it diverges precisely in the case more likely to be hit, since 50-to-63-byte objects are common.

## Decision

**User-ratified.** tsgit computes the bound as git does, underflow included, so an object below
`2 × hashSize` searches unbounded. The behaviour is pinned with the recorded sha1 and sha256 vectors
and is called out in the implementation so it reads as replicated, not as a defect.

The prime directive decides this: the underflow is observable in git's output, and nothing here
argues strongly enough to diverge. Replicating a quirk is cheaper to justify than owning a
divergence, and it keeps the one formula honest across both hash widths.

## Consequences

tsgit's bound matches git's for every object size under both hash algorithms, so the bound stage's
structural readouts hold on sha256 repositories as well as sha1 ones — where a clamp would have
silently disagreed with git in exactly the size band the floor leaves open.

The implementation carries arithmetic that looks like a bug and is not, which is a standing
comprehension cost. It is mitigated by naming it at the site and by the vectors, which fail if
anyone clamps it.

If git ever fixes the underflow, tsgit's bound diverges from git's until this record is reopened.
That is the ordinary cost of bug-for-bug replication and is preferable to diverging today by
choice.
