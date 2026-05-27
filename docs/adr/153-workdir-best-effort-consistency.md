# ADR-153: Workdir best-effort consistency + opt-in verified mode

## Status

Accepted (at `1c35bc3`)

## Context

`WorkdirSnapshot` reads the filesystem. There is no portable userland API
for atomic filesystem snapshots — ZFS/btrfs/APFS expose them but only via
root-level operations; we can't take them safely from a library.

Three honest options:

1. **Materialize snapshot at construction** — walk + lstat every entry up
   front, freeze in memory. Pretend atomicity. Reality: still racy during
   the materialization walk; allocates O(n) memory for n files; defeats the
   "snapshots are free" property (see ADR-149).
2. **Single lstat per row, cached on the row** — match git semantics. Document
   that cross-row consistency is not guaranteed. Provide `verify()` for
   callers that need to detect mid-iteration races.
3. **Two-pass with race detection** — walk + lstat materialize, then re-lstat
   per row on access. Emits `WorkdirRaceError` when the second lstat differs.
   Pays O(n) memory and 2× I/O, but gives the strongest guarantee userland can.

Anyone claiming a "consistent workdir snapshot" without an OS-level FS snapshot
is lying. We refuse to do that.

## Decision

**Default mode:** `consistency: 'eager'` — single lstat per row, cached on
the row. Multiple operators on the same row (`hashWorkdir`, `loadBlob`,
`verify`) reuse the cached stat. Cross-row consistency is documented as
not guaranteed. Matches git semantics, more honest API.

**Opt-in mode:** `consistency: 'verified'` — two-pass materialize + verify.
Available for callers that need race detection (e.g., `add -p`,
`checkout --detect-races`, `add --intent-to-add` workflows).

Per-row `await row.workdir.verify()` available in both modes for ad-hoc
race detection at specific operation points.

## Consequences

### Positive

- Default is git-faithful — users coming from git get the semantics they
  expect. Power users get `verified` mode without paying for it by default.
- API is honest about what userland can deliver. No false atomicity claim.
- Single-mode default keeps the snapshot lazy (ADR-149).
- `verified` mode formalises what git users hand-roll as `git update-index
  --refresh; git status`.

### Negative

- Two consistency modes is more API surface. Mitigated: single options flag
  with two values, documented in one place.
- `verified` mode trades memory + I/O for safety. Users must understand the
  trade-off. Mitigated: docs and runbook entries.

### Neutral

- `verify()` per row is available in `eager` mode too — costs one extra lstat
  per call.
- Tree/index snapshots are atomic (per ADR-149 / ADR-150); only workdir has
  this caveat.
