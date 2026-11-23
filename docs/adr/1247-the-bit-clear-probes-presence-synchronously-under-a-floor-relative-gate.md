---
subjects:
  - src/application/primitives/internal/clear-skip-worktree-from-present-files.ts
  - src/domain/sparse/missing-directory.ts
  - src/ports/file-system.ts
supersedes:
  - adr: "1243"
    scope: "the sequential walk and the main-relative 10% status gate"
---
# 1247 — The bit clear probes presence synchronously under a floor-relative gate

- **Status:** accepted
- **Date:** 2026-11-22
- **Design:** docs/design/skip-worktree-present-files.md (D-H, R3) · **Supersedes/Refines:** supersedes ADR-1243 (walk and gate)

## Context

ADR-1243's gate fired. Against a base without the clear, `status` on 20000 skip-worktree entries
in present directories went from 18.9 ms to 196 ms with the sequential walk, and to 60.2 ms with
the walk split into runs under bounded concurrency. With the directories removed it is +9.5%.

The base performs no `lstat`; git performs one per entry outside a known-missing directory. No
faithful clear can stay within 10% of a base that skips the work. A profile of 20000 `lstat`
calls on missing files puts the async threadpool round trip at 116 ms (concurrency 16, no gain
past the pool width of 4) against 24 ms for synchronous `lstatSync` with `throwIfNoEntry: false`.

## Options considered

1. **A synchronous presence probe on the file-system port, used by the walk, with a gate relative
   to the faithful floor** (recommended).
2. Keep the concurrent async walk and accept its cost.
3. Reuse the previous clear while the raw index and the skip-worktree directories' mtimes are
   unchanged, which meets the old gate but departs from git's recompute on every read.

## Decision

**User-ratified — option 1.** The file-system port gains an optional synchronous presence probe;
adapters that cannot answer synchronously omit it and the walk falls back to the async probe. Any
probe failure still reads absent.

Both rows are gated against the faithful floor on the same fixture: the clear costs at most 10%
more than one bare synchronous `lstat` per probe git's `path_found` makes plus one scan of the
candidate paths. On the removed-directories row that floor is about 1 ms (400 probes and a
20000-path scan the base does not do), so a main-relative gate there measured git's own work, not
an overhead: user-ratified on 2026-11-22 after the row stood at a +12.0% median against main.

Superseded from ADR-1243: the sequential async walk and the 10%-of-`status`-against-main gate on
the present-directories row.

Carried forward from ADR-1243: git's missing-directory cache, one probe per skip-worktree entry
outside a known-missing directory, none when sparse is off or the index holds no skip-worktree
entry, and results identical to git's `path_found`.

## Consequences

### Positive

- The probe count equals git's and the per-probe cost drops to the synchronous floor.

### Negative

- The port grows an optional member that node implements and browser adapters may omit.
- `status` on a large sparse checkout with present directories stays slower than before the clear,
  by the cost git also pays.
