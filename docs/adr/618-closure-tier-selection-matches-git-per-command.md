# 618 — Closure tier selection matches git, per command

- **Status:** accepted (ratified — resolves a design escalation)
- **Date:** 2026-08-09
- **Design:** docs/design/rev-index-bitmap-read-support.md (E-1) · **Refines:** ADR-613, ADR-614, ADR-616

## Context

ADR-616 required tsgit's bitmap and walk closures to return identical object sets, on the
assumption that git's two paths agree. **They do not.** With haves present, git's walk
over-reports: on a fixture with repeated blob content, `rev-list --objects HEAD --not
HEAD~50` yields **156** objects by walking and **150** via the bitmap, and every one of the
six extras is a blob that is *also* reachable from the have. The bitmap yields the exact set
difference; the walk yields a superset. Without haves the two agree exactly (367 = 367).

The decisive measurement is that git resolves this **per command**, not globally:

| command | default tier | objects |
|---|---|---|
| `rev-list --objects HEAD --not HEAD~50` | walk | 156 |
| `rev-list --use-bitmap-index --objects …` | bitmap | 150 |
| `pack-objects --revs` | **bitmap** | 150 |
| `pack-objects --revs --no-use-bitmap-index` | walk | 156 |

## Options considered

1. **Match git per command** — `rev-list` walks unless asked; `pack-objects` uses the bitmap
   unless refused / two tiers whose answers differ, which ADR-616 had forbidden.
2. **Exact set difference everywhere** — tsgit's two paths agree with each other / `rev-list`
   diverges from git's own default output.
3. **Walk-faithful everywhere** — one answer / kills the acceleration on precisely the
   push/fetch/pack shape it exists for.

## Decision

Option 1. Tier selection is a **per-command** property, chosen to reproduce git's own default
for that command:

- **`rev-list`** computes by walk by default and uses a bitmap only when the caller asks
  (ADR-613's surface gains a `useBitmapIndex`-shaped option; it is **not** cosmetic — it
  changes the returned set — so ADR-249 does not bar it).
- **`pack-objects`** uses a bitmap when one is usable and falls back to the walk otherwise,
  with a caller-facing way to refuse it, mirroring git's `--no-use-bitmap-index`.

The over-report is git's, not a defect to correct: tsgit reproduces the superset where git
produces a superset and the exact difference where git produces the exact difference.

## Consequences

Supersedes ADR-616's global "automatic everywhere" and its unconditional equality obligation
(both amended in place). The equality that survives is **conditional and pinned**: with no
haves the two tiers must agree exactly; with haves the walk must be a **superset** of the
bitmap result, and every object in the difference must be reachable from a have — that is the
invariant the interop suite asserts, and it is stronger than "they differ".

Sending the smaller set from `pack-objects` is safe precisely because the omitted objects are
reachable from the haves, so the receiver already has them.
