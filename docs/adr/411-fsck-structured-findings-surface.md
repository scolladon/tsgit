# 411 — fsck structured-findings surface: flat discriminated union, projections are caller-filtered

- **Status:** accepted
- **Date:** 2026-06-23
- **Design:** docs/design/fsck.md · **Refines:** ADR-249 (structured data only), ADR-226 (git-faithfulness)
- **Decision class:** D-SURFACE adopted-as-recommended (no user judgment)

## Context

`fsck` returns its findings as structured data (ADR-249) — never a rendered line, never
`bytes`. Two surface questions follow. **D3:** what discriminator and granularity does a
finding carry? **D4:** git's `fsck` CLI exposes a dozen flags (`--unreachable`, `--dangling`,
`--root`, `--tags`, `--cache`, `--no-reflogs`, `--connectivity-only`, `--full`, `--strict`,
`--references`, …) — which become library options and which are pure caller-side projection?

git routes findings across **two streams** — stdout (the reachability taxonomy: `dangling` /
`unreachable` / `missing` / `broken link` / `root` / `tagged`) and stderr (integrity faults).
Both are caller rendering under ADR-249; the routing must be *reconstructable from the fields*,
not *baked into the data shape*.

## Options considered

**D3 — finding shape:**
1. **Flat `readonly` discriminated union on `type`** (one interface per variant), mirroring `domain/diff/diff-change.ts` — pros: house precedent, every finding self-describing; cons: none material.
2. **Two arrays** (`reachability` vs `integrity`) matching git's stdout/stderr split — pros: mirrors git's streams; cons: bakes a rendering concern (stream routing) into the data = ADR-249 violation.
3. **Wide `{ category, objectType, id, … }` record** with an optional-field bag — pros: flat; cons: not self-describing, weak typing.

**D4 — flags → options:**
1. **All data-scope flags as options** — pros: 1:1 with git CLI; cons: exposes pure projections as options (ADR-249 violation).
2. **Compute one maximal taxonomy, caller filters; keep only genuine computation/verdict toggles** (designer recommendation) — pros: ADR-249-faithful; cons: caller must filter for git-CLI parity.
3. **Core toggles only**, defer the rest — pros: smallest surface; cons: arbitrary line.

## Decision

**D3 → option 1; D4 → option 2.** Both adopted as the design recommended — they are the direct
application of ADR-249 and the `diff-change.ts` precedent, carrying no user-judgment trade-off.

- **Findings are a flat `readonly` discriminated union on `type`** (`dangling` / `unreachable` /
  `missing` / `broken-link` / `bad-object` / `hash-mismatch` / `bad-ref` / `root` / `tagged`),
  one interface per variant, branded `ObjectId` / `RefName` fields. The result is
  `FsckResult = { readonly findings: ReadonlyArray<FsckFinding>; readonly exitCode: number }`.
- **The maximal finding taxonomy is always computed.** Selection flags that are *projections of
  that one set* — `--dangling`, `--unreachable`, `--root`, `--tags` — are NOT options: the
  caller filters the returned `findings`. Only flags that change *what is computed/examined* or
  *the verdict* stay as options: `connectivityOnly`, `reflogRoots`, `indexRoot`, `full`,
  `strict`, `checkReferences`. (`strict`/`checkReferences` are live per ADR-412.)
- **Stream routing is caller rendering**, reconstructed from the variant (each variant maps to a
  known stdout/stderr line) inside the interop test — not encoded as two arrays.

## Consequences

- Public types: `FsckResult`, `FsckFinding` (union), `FsckOptions` (the six genuine toggles).
- The interop test reconstructs git's exact stdout+stderr bytes and stream routing from the
  structured fields and asserts byte-equality — the faithfulness proof for ADR-249.
- A caller wanting `git fsck` default output filters `findings` to `dangling` + integrity faults;
  `--unreachable` output is the same data, unfiltered. No library code changes between them.
- The two-array split (D3.2) is foreclosed: stream is a render-time projection, never data shape.
