# 622 — Bitmap positions are range-validated, and a violation declines the artefact

- **Status:** accepted (adopted — measured, refines a decision taken on incomplete evidence)
- **Date:** 2026-08-09
- **Design:** docs/design/rev-index-bitmap-read-support.md (new pin) · **Refines:** ADR-611, ADR-615, ADR-621

## Context

ADR-615 ruled that bitmap closures are "trusted, exactly like git", on the evidence that git
verifies a bitmap's checksum only at `fsck` time. That evidence was incomplete. Measured on a
40-commit fixture whose first per-commit entry header was rewritten to position `999999` and
whose trailer was then restamped — so the file's checksum is **valid** and `fsck` exits 0:

| probe | exit | observable |
|---|---|---|
| `fsck` | **0** | nothing — confirms the checksum-only obligation |
| `rev-list --use-bitmap-index --objects HEAD` | **0** | `error: corrupt ewah bitmap: commit index 999999 out of range`, then the **walk's** answer (120 = 120) |
| `rev-list --test-bitmap HEAD` | **128** | the same error, then `fatal: failed to load bitmap indexes` |
| `pack-objects --revs` | **0** | the same error, then the walk's answer |

git therefore **range-validates positions on the consumption path**, declines the whole
artefact when one is out of range, reports it, and degrades to the walk — returning the
correct answer with a zero exit. It trusts a bitmap's *reachability semantics*; it does not
trust its *integers*.

## Options considered

1. **Range-validate and decline, as measured** — matches git on every probe above.
2. **Trust positions per ADR-615's original wording** — would index outside the pack, yielding
   a wrong object set or a `RangeError`; matches nothing git does.

## Decision

Option 1, which is the faithful reading and supersedes ADR-615's unqualified "trust". Every
position decoded from a bitmap — per-commit entry headers and set bits alike — is validated
against the object count of the pack (or the midx pseudo-pack) it indexes. A violation:

- **declines the whole artefact**, not the single entry — git loses the bitmap entirely;
- **reports the fault** through the logger with the artefact name, because git prints an
  `error:` line here rather than being silent;
- **falls back to the walk**, whose answer is returned with no failure surfaced to the caller.

This sits inside ADR-621 rather than against it — git declines here, so tsgit declining is
"declining where git declines", not added strictness. It is likewise the ADR-611 gate, not the
ADR-615 one: bounds and range checks were always separate from trust, and this ADR makes the
boundary explicit rather than moving it.

## Consequences

Removes the failure mode that made ADR-615 + ADR-616 uncomfortable: a decoder or artefact
fault can no longer silently produce a wrong pack, because an out-of-range position is caught
before any oid is resolved. The residual is narrow and is git's own — a bitmap whose positions
are all **in range** but semantically wrong is still trusted by both tools.

Note the interaction with ADR-618: this fallback changes a have-bearing answer from the exact
difference to the walk's superset. That is precisely what git does (`pack-objects` above
returned the walk's answer), so the tier invariant's superset arm covers it.
