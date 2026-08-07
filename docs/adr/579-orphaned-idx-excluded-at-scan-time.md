# 579 — An orphaned .idx is excluded at scan time via the sibling-pack check

- **Status:** accepted
- **Date:** 2026-08-07
- **Design:** docs/design/pack-v3-read-compliance.md · **Supersedes/Refines:** refines ADR-575

## Context

Git registers a pack only when the `.pack` file exists by name: an orphaned `.idx` shows
`packs: 0, garbage: 1` in `count-objects -v` and is never listed. ADR-575 as first worded
routed a missing `.pack` to the lookup-layer header probe — object reads come out
identical either way, but enumeration differs: under the probe placement, `registry.all()`
(`enumerateObjects`, `resolveOidPrefix`, `fsck --full`) would still list the orphaned
idx's objects. This choice only arose once ADR-575 created a scan-layer
exclusion mechanism.

## Options considered

1. **Scan-time sibling check** (designer's recommendation) — require a sibling
   `<name>.pack` entry in the `readdir` listing `scanPacks` already holds; git's own
   scan-time test at zero extra I/O; enumeration matches git.
2. **Leave it to the lookup probe** — ADR-575 verbatim; reads match git, enumeration
   diverges.
3. **`exists()` per pack per generation** — same enumeration outcome as (1) but pays one
   syscall per pack per scan for information the listing already contains.

## Decision

**User ratified option 1.** `scanPacks` registers a pack only when its sibling
`<name>.pack` appears in the directory listing it already holds. The lookup-layer probe's
unopenable-pack arm (ADR-575) remains for the race where the `.pack` disappears between
scan and open.

## Consequences

Enumeration and reads both match git for the orphaned-idx shape; ADR-575's
"pack file that cannot be opened" arm narrows to the between-generations race. Zero
additional I/O. The H5 test rows assert the orphan is absent from `registry.all()`.
