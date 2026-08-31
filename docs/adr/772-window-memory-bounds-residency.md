---
subjects:
  - src/application/primitives/internal/deltify.ts
---
# 772 — Window memory bounds residency; there is no per-object cap

- **Status:** accepted
- **Date:** 2026-08-31
- **Design:** docs/design/delta-writing-packer.md (DC-6) · **Supersedes/Refines:** decided against the design doc's own recommendation, on measurement

## Context

Something must bound how much object content the window holds. The design doc proposed a
hardcoded per-object ceiling and refused git's own `pack.windowMemory`, on the grounds that
a memory-driven window would make the emitted pack depend on the host and so break the gc
identity pins.

That refusal rests on a misreading, and the measurement falsifies it. `git-pack-objects(1)`
documents `--window-memory=<n>` as scaling the window down against **a configured byte
budget**, not against host pressure. Measured on git 2.55.0, one fixture repeated with
`pack.threads=1`, two independent runs per setting:

| `pack.windowMemory` | run 1 | run 2 |
|---|---|---|
| `0` (unlimited) | 20 087 B | 20 087 B |
| `8k` | 82 902 B | 82 902 B |
| `64k` | 89 458 B | 89 458 B |

Byte-identical every time. The key is deterministic for a fixed object set and a fixed
configuration.

## Options considered

1. **`pack.windowMemory` bounds the window total** (chosen) — pros: bounds the quantity that actually matters; git's own key; already in the config surface / cons: the bound is a budget over the window, not a guarantee about any single object.
2. **A hardcoded per-object constant** — pros: simplest / cons: a tsgit-only magic number sitting beside a git key that does the same job.
3. **`core.bigFileThreshold`** — pros: also git's own key / cons: a second new integer key with its own refusal pin, and git applies it far beyond delta selection, so honouring it only here would itself diverge.

## Decision

**User-ratified.** `pack.windowMemory` bounds the total bytes of base content the window
holds; candidates are evicted oldest-first until the budget is met, and a candidate larger
than the whole budget is skipped rather than admitted alone. There is no separate per-object
cap. Unset or `0` means unlimited, matching git.

## Consequences

Residency is configurable through git's own key rather than a private constant, and it stays
deterministic because the budget is a configured number. The design doc's determinism
objection is corrected there rather than left standing. A caller that sets a small budget
gets a larger pack — deterministically, and matching git's own behaviour at that setting.
