# 405 — rename detection excludes gitlinks from the inexact similarity matrix

- **Status:** accepted
- **Date:** 2026-06-22
- **Design:** docs/design/gitlink-type-change-patch.md · **Refines:** ADR-226 (git-faithfulness) · **Relates:** ADR-403, ADR-404 (gitlink patch rendering), and the similarity rename/copy/break detection surface (24.13, ADRs 366–377)
- **Decision class:** scope user-ratified; insertion point adopted-as-recommended

## Context

tsgit's opt-in similarity rename/copy/break detection
(`src/application/primitives/detect-similarity-renames.ts`) hydrates candidate blobs via
`readBlob` to score similarity. A gitlink-mode entry (`160000`) has no readable content —
`readBlob` throws `unexpectedObjectType('blob','commit')` on its commit oid
(`read-blob.ts:14`), reached through `hydrateAndFingerprint` (inexact pass) and
`scoreModifies` (`-B` break). So running diff with `-M`/`-C`/`-B` over a repo containing a
gitlink crashes. Real git's diffcore-rename/break **exclude `S_ISGITLINK` from the inexact
similarity matrix** — a "moved" gitlink with a different oid is reported delete+add, never
inexactly rename-paired (pinned). git's EXACT same-oid rename pass DOES pair gitlinks
(pinned: `R100`); tsgit's domain same-oid fold (`tryFoldAdd`, byte-free) already matches
that. This gap was found while scoping the gitlink patch-rendering feature; the user
ratified bringing the fix into the same PR rather than a follow-up.

## Options considered (insertion point — the behavior is fully pinned; only placement forks)

1. **Exclude gitlink-mode entries at the three application-tier hydration pool builders**
   — `partitionLeftovers` (rename src/dst), `buildCopySourcesForOn`/`buildCopySourcesForHarder`
   (copy sources), and `attemptBreaks`' modify filter (break) — via a shared gitlink
   predicate (designer's recommendation). pros: minimal and local; provably preserves the
   byte-free exact same-oid fold; stays in the application tier where blob hydration lives.
   cons: the predicate is applied at three pool sites (mitigated by sharing it).
2. **A single post-exact split** that partitions gitlinks out once after the exact fold.
   cons: adds a redundant partition/concat layer AND still needs the copy-source guard
   separately — more structure, no clearer.
3. **Push the exclusion into the domain detection.** cons: mislocates a hydration concern
   across the hexagonal boundary — the domain is content-agnostic; the `readBlob`
   hydration that throws is an application concern.

## Decision

tsgit's inexact rename/copy/break detection excludes gitlink-mode entries from its
similarity candidate pools, mirroring git's `S_ISGITLINK` exclusion, so a moved or changed
gitlink is reported as delete+add and never feeds `readBlob`. The exclusion is applied at
the three application-tier pool builders (`partitionLeftovers`, `buildCopySources*`,
`attemptBreaks`' modify filter) through a single shared gitlink predicate
(`kindOf(mode) === 'gitlink'`); the byte-free domain exact same-oid fold — which
faithfully pairs same-oid gitlinks as `R100` — is unchanged. Scope inclusion in this
feature is user-ratified; the insertion point is adopted as recommended (the behavior is
git-dictated and identical across all three placements).

## Consequences

- Rename/copy/break detection (`-M`/`-C`/`-B`) over a repo with gitlinks no longer throws
  and matches git (inexact: delete+add; exact same-oid move: `R100`).
- The only gitlink knowledge added to the detection primitive is one shared predicate; the
  domain stays content-agnostic and its exact fold is untouched.
- New interop/unit arms pin gitlink-under-`-M` reported as delete+add (not rename) and the
  invariant that no `readBlob` is attempted on a gitlink oid.
- This feature's surface now spans both gitlink patch RENDERING (ADRs 403–404) and gitlink
  rename-detection EXCLUSION (this ADR) — the complete set of gitlink diff paths that
  previously threw.
