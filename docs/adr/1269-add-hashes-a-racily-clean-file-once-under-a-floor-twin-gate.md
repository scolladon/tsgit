---
subjects:
  - src/application/commands/add.ts
  - test/bench/status-racy-window.bench.ts
---
# 1269 — `add` hashes a racily clean file once, under a floor-twin gate

- **Status:** accepted
- **Date:** 2026-11-25
- **Design:** docs/design/whole-second-stat-match.md (§6) · **Supersedes/Refines:** applies DOCTRINE(D-7); extends ADR-1267

## Context

The perf review counted work-tree reads through a proxied file system. `add .` in the racy
window read and hashed each racily clean tracked file twice, where git reads it once:

- staging cannot restage a racy entry as is, so it reads and hashes the file;
- the rebuilt entry carries the same stat and object name as before, so the smudge pass of the
  index write took it for carried over and compared its content again.

The mechanism predates this change. The whole-second racy test of ADR-1262 makes it the usual
case for the first `add` after a checkout, a commit or another `add`.

git marks an entry it just staged up to date (`fill_stat_cache_info`), and its index write
skips up-to-date entries.

## Options considered

1. **`add` hands the paths it restaged to the index write as verified, and the racy-window
   bench gains an `add` pair with its floor twin** (recommended).
2. The fix without a bench.
3. A unit row counting work-tree reads.

## Decision

**Adopted-as-recommended (no user judgment)** — DOCTRINE(D-7) for the bench pair. Option 1.

Measured on 5000 files of 2 KiB, ratio over a settled `add` plus one synchronous read and blob
SHA-1 per file: 3.77 before the fix; 2.18, 2.35 and 1.93 after. The gate is 3.0. git's own
`add .` on the same tree takes about as long as tsgit's does after the fix.

Refused: option 2 leaves the second hash unguarded. Option 3 is a call-count spy on a result
no caller can observe.

## Consequences

### Positive

- `add .` in the racy window costs one content pass, as git's does.
- A unit row still pins that an entry `add` did not stage is smudged.

### Negative

- The floor twin undercounts what `add` must do (it writes no object and no index), so the
  ratio sits near 2 rather than near 1.
