# ADR-370: Rename limit skips the inexact pass silently; exact pairing is never limited

## Status

Accepted

- **Date:** 2026-06-19
- **Design:** [design/similarity-rename-detection.md](../design/similarity-rename-detection.md)
- **Refines:** [ADR-249](249-describe-structured-data-only.md)

## Context

git caps inexact rename/copy detection by `diff.renameLimit` (default 1000): when the
candidate matrix `num_create · num_src` exceeds the limit, git **skips the inexact
pass entirely** and prints a stderr warning, while still emitting exact (R100)
renames. tsgit's current `detectRenames` instead bails the **whole** pass — exact
pairing included — when `adds · deletes > limit`, which is non-faithful (real `git`
still emits R100 renames over the limit). ADR-249 holds that printed warnings are
rendering, not library data.

## Options considered

1. **(chosen) Over-limit ⇒ skip the inexact pass silently; exact pass always runs** —
   adds/deletes stay unpaired, no warning datum. Pros: matches git's faithful data
   outcome; corrects the current whole-pass bail; no consumer needs the warning flag.
   Cons: the "detection was skipped" signal is not surfaced (it is rendering per ADR-249).
2. **Add a structured `renameLimitExceeded: boolean` to `TreeDiff`** — surfaces the
   skip as data. Rejected: no consumer needs it yet (YAGNI); can be added later.
3. **Raise an error** — Rejected: git never errors on this; it degrades gracefully.

## Decision

The rename limit gates only the **inexact** matrix (renames and copies). When
`num_create · num_src` exceeds the configured limit, the inexact pass is skipped and
the unpaired adds/deletes are returned as-is. The **exact** id-bucketed pass
(O(adds+deletes)) always runs and is never limited. No warning datum is emitted; the
stderr warning git prints is the caller's to reconstruct if desired.

## Consequences

- Corrects a latent faithfulness bug: tsgit now emits R100 renames over the limit,
  matching git (pinned by interop).
- `renameOptions.limit` configures the inexact cap; `0` means unlimited (git's
  internal hard cap aside).
- If a future consumer needs the skip signal, a structured field can be added without
  breaking this decision.
