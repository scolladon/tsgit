---
subjects:
  - src/application/primitives/internal/object-caches.ts
supersedes:
  - adr: "851"
    scope: "the default valve numbers (a 16 MiB parsed-memo valve and an 8 MiB FlatTree valve at every hash width) and the memo's 256 B fixed-overhead charge"
  - adr: "852"
    scope: "the documented ~136 MiB cache family total"
---
# 869 — Cache byte valves are width-aware and charged at measured cost

- **Status:** accepted
- **Date:** 2026-09-14
- **Design:** docs/design/session-caches-faithfulness-addendum.md (H, O, DC-H1, DC-O1) · **Supersedes/Refines:** supersedes ADR-851 and ADR-852 in scope; ADR-851's principle is unchanged

## Context

ADR-851 bounds the parsed-object memo by entries (32 768 per 16 MiB of `deltaCacheMaxBytes`) with a
16 MiB byte valve, and the FlatTree cache by an 8 MiB valve sized for about 50 000 tracked files; a
unit test pins that each valve admits its reference workload. Two measurements show the numbers do
not hold as stated. Environment: Apple M3 Pro, macOS, Node 22.22.3; heap figures are
`process.memoryUsage().heapUsed` deltas after six forced collections, each run twice with identical
results.

**The valves are blind to hash width.** Both sizers charge one byte per hex character of an object
id and have no other width term. 50 000 tracked files with 14-character paths size to 8 200 048 B
at sha1 and 9 400 048 B at sha256, so at sha256 the 8 MiB valve refuses the tree and only 44 620
files fit. A typical commit (216-character message, one parent) sizes to 512 B at sha1 and 536 B
at sha256; `32 768 × 536 = 17 563 648 > 16 777 216`, so at sha256 the memo's byte valve binds at
31 300 entries — the ordering ADR-851's invariant test pins at sha1 only.

**The memo's charge is not its cost.** The sizer charges a 256 B fixed overhead plus message,
signature, extra headers and parent ids. Measured, a memoised commit retains about 947 B of fixed
overhead at sha1 (one parent, LRU node and map entry included) plus about one byte per message
byte; parsed commits pin no content buffer. The sizer under-states a typical commit 2.34× and a
short-message commit 3.3×, so at the 32 768-entry default the memo really holds about 37.7 MiB
behind a stated 16 MiB valve. The FlatTree sizer is closer — 1.26× to 1.32× over real
`flattenTree` output.

## Options considered

How the default valves derive from hash width (DC-H1):

1. **A width surcharge** (recommended, chosen) — the reference counts stay dial-scaled and
   width-independent (50 000 files and 32 768 commits per 16 MiB of dial), and each valve adds
   `count × (hexLength − 40)`. Pros: adds exactly what the sizers charge for wider ids, their only
   width term; every sha1 number stays byte-identical; the same workload fits at both widths; no
   typical path-length constant. Cons: one more derived term to read.
2. **Per-width literals** (FlatTree share ½ or 9⁄16; memo valve 16 or 17 MiB) — cons: leaves 197
   files of sha256 headroom and hides the rule.
3. **Width-proportional scaling by a typical-entry ratio** — cons: needs a typical path-length
   constant, the kind the parent design removed.

Parsed-memo accounting (DC-O1):

1. **Correct the constants to the measured overhead, keep the 32 768-entry count, valve = entries ×
   honest typical bytes** (recommended, chosen) — pros: keeps the workload ADR-851 sized for, makes
   the valve and the family total true; real memory changes only for walks of atypically large
   entries. Cons: the documented valve and family total rise.
2. **Correct the constants, keep the 16 MiB valve** — the derived cap drops to about 13 900
   entries. Cons: a walk above that re-enters the LRU cliff ADR-851 removed.
3. **Document the valve as a charged proxy with the measured ratios, no code change** — cons: keeps
   a documented 16 MiB that is really about 38 MiB.

## Decision

**DC-H1 option 1 and DC-O1 option 1.**

**FlatTree.** The default valve is `dial × ½ + files × (hexLength − 40)`, where `files` is 50 000
scaled by the dial against 16 MiB: 8 388 608 B at sha1, 9 588 608 B at sha256, at the default dial.

**Parsed memo.** `PARSED_OBJECT_FIXED_OVERHEAD_BYTES` and `PARSED_OBJECT_TYPICAL_ENTRY_BYTES` take
their measured values (about 950 B and about 1 206 B at sha1). A separate dial divisor of 512 B
per entry keeps the default count at `floor(dial / 512)`, 32 768 at the default dial. The byte
valve is that dial-derived count times the typical entry size at the context's width — about 37.7
MiB at sha1 — so the width surcharge sits inside the typical size rather than beside it.

The surcharge and the valve multiply the **dial-derived** count, never an explicit
`parsedObjectMemoMaxEntries`: an explicit entry cap sets only the entry cap, and
`deltaCacheMaxBytes` remains the one dial that scales bytes. Explicit `flatTreeCacheMaxBytes` and
`parsedObjectMemoMaxEntries` still win verbatim. The entry count no longer derives from the byte
valve; both derive from the dial, so `entries × typical(width) ≤ valve` holds by construction at
every dial and width, and the invariant test measures it through the real sizers at both widths.

## Consequences

At sha1 the FlatTree valve and the memo entry count are byte-identical to ADR-851's; at sha256 both
caches admit their full reference workload. Real memory for a typical walk does not change — the
overhead was always there, bounded by the entry cap — but the memo valve, which binds only for
atypical entries, now binds at an honest ceiling: a walk of 4 KiB-message commits holds about
37.7 MiB where it held about 18 MiB of real memory behind the stated 16 MiB before.

The documented worst-case cache family total at the defaults becomes about **158 MiB** at sha1 —
16 MiB loose-object bytes, about 37.7 MiB parsed memo, 8 MiB FlatTree and 96 MiB delta bases —
replacing ADR-852's 136 MiB. The internals and performance pages carry the new figure and the
measurement method; the constants' docstrings carry the method, not this record's number.

The FlatTree sizer's 1.26×–1.32× under-count is measured and recorded, and is not corrected here:
DC-O1 covers the parsed memo only.

ADR-851's principle is untouched: budgets in the consumer's unit, byte caps as valves that bind
only for atypical entries, the ordering pinned by a test.
