---
subjects:
  - src/application/primitives/internal/object-caches.ts
  - src/application/primitives/read-head-tree.ts
  - src/domain/storage/lru-cache.ts
supersedes:
  - adr: "726"
    scope: "the FlatTree cache's 1/16-of-deltaCacheMaxBytes sizing and its silent over-cap drop"
  - adr: "727"
    scope: "the byte cap as the parsed-object memo's primary bound"
---
# 851 — Derived object caches are bound by entries, on explicit budgets

- **Status:** accepted
- **Date:** 2026-09-11
- **Design:** docs/design/session-caches-per-command-floor.md (D2, DC-2) · **Supersedes/Refines:** supersedes ADR-726 and ADR-727 in scope

> **Correction (2026-09-14).** ADR-869 amends this record's numbers. The default memo valve is no
> longer 16 MiB: it is the dial-derived 32 768 entries times the measured typical entry size at the
> context's hash width — about 37.7 MiB at sha1 — and the 256 B fixed-overhead charge becomes the
> measured value of about 950 B, because a memoised commit was measured to retain about 947 B of
> fixed overhead (the old charge under-stated a typical commit 2.34×). The FlatTree valve gains a
> width surcharge: 8 MiB at sha1, unchanged, and 9 588 608 B at sha256, so both caches admit their
> reference workload at both widths; the stated defaults admitted it at sha1 only. The worst-case
> additive footprint of the memo and FlatTree is therefore about 45.7 MiB at sha1, not 24 MiB. The
> principle — budgets in the consumer's unit, valves that bind only for atypical entries, the
> ordering pinned by a test (now at both widths) — is unchanged.

## Context

Two derived caches each take `1/16 × deltaCacheMaxBytes` — 1 MiB at the default — plus a 65 536
entry cap that never binds. Both are sized below the repository they were measured on.

The parsed-object memo charges a 256 B fixed overhead per entry, so its byte cap binds at
**≤ 4 096 entries**; a 5 000-commit walk in the same order every time is the worst case an LRU
has, and the hit rate collapses to roughly zero. Warm `log` on the medium fixture runs 21–30 ms
at the default budget and 9.4–11.5 ms once the walk fits — a 2.2× cliff. The module's own
fraction sweep was taken on that same fixture, i.e. entirely on the wrong side of the cliff, so
it measured no difference between fractions and concluded the fraction did not matter.

The FlatTree cache holds about 6 400 tracked files in 1 MiB and the medium HEAD tree is 3.3 MB,
so `readHeadTree` is refused on **every** `status` and re-flattens HEAD each time. `LruCache.set`
returns silently when an entry exceeds the whole budget, so neither failure announced itself.

The shared root cause is not the fraction's value. It is that a cache was bounded in a unit its
consumer does not scale with.

## Options considered

1. **Explicit options, entry-first bounds, conservative defaults** (recommended, chosen) —
   memo 32 768 entries with a 16 MiB valve, FlatTree 8 MiB (about 50 k files). Pros: the bound is
   in the consumer's own unit; every number is one option away. Cons: raises the documented
   family ceiling.
2. **Explicit options, generous defaults** — 65 536 entries / 32 MiB valve / 16 MiB FlatTree.
   Pros: a 50 k-commit repository needs no tuning. Cons: doubles the documented footprint for
   headroom nothing measured here needs.
3. **One documented total re-derived into fractions** — a single `objectCacheMaxBytes` split into
   fixed sixteenths. Pros: one knob. Cons: this is structurally the defect being fixed, and it
   re-couples four caches whose consumers scale with unrelated quantities.

## Decision

**Option 1.** A cache's budget is expressed in the unit its consumer scales with — **entries**
for the parsed-object memo, because a walk of N commits needs N slots, and **tracked files** for
the FlatTree, because one HEAD tree of F files costs about 164 F bytes. The byte cap becomes a
**valve**, sized so that it binds only for atypical entries and never for typical ones.

Defaults: `parsedObjectMemoMaxEntries` 32 768 with a 16 MiB valve; `flatTreeCacheMaxBytes` 8 MiB.
Both are exposed as options on the Node, browser and memory adapter option types, validated like
the existing `deltaCacheMaxEntries`, carried on `Context` as an optional frozen `cacheBudgets`
and resolved by one `budgetsFor(ctx)` helper that derives the defaults when the field is absent —
the established `concurrency` / `limitFor` pattern, so every hand-built `Context` literal in the
test suite keeps compiling and behaves as a default-budget Context.

**The ordering is pinned by a test, not by a comment.** One unit test per cache asserts that the
valve at the default admits `maxEntries × typicalEntryBytes`, so a future retune that flips the
binding constraint back to bytes fails a test instead of shipping another dead cache.

## Consequences

`deltaCacheMaxBytes` remains the one dial that scales the family, so a browser tab that lowers it
scales these two down with it. The worst-case additive footprint of the memo and FlatTree rises
from 2 MiB to 24 MiB at the defaults; the family total is stated in ADR-852, which owns the
delta-base cache's own budget.

Carried forward from ADR-726: the `(rootTreeOid, maxDepth)` cache key, gitlink preservation in
cached trees, and the floor-at-1 sizer. Superseded from ADR-726: the 1/16 sizing, and its
"an over-cap tree simply never caches; that drop is documented" disposition — the drop is now
reported by `set` (ADR-853) and the default budget is sized so a realistic HEAD does not hit it.

Carried forward from ADR-727: the per-session memo itself, its population on parse, and
deep-readonly `CommitData` making shared parsed objects safe. Superseded from ADR-727: the byte
cap as the primary bound and the fraction of the delta-cache budget it rode on.

The module's fraction-sweep table is replaced by the entry-bound rationale and a pointer to the
medium-fixture A/B. A sweep on the large fixture (50 k commits) is the honest follow-on and is
recorded as out of scope with its reason: no large-fixture bench row exists to run it against.
