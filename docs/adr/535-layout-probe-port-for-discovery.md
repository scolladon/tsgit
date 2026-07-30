# 535 — Narrow `LayoutProbe` port for repository discovery

- **Status:** accepted
- **Date:** 2026-07-29
- **Design:** docs/design/linked-worktree-discovery.md · **Supersedes/Refines:** refines ADR-298 (multi-root containment)

## Context

Discovery must run *before* any bounded `FileSystem` adapter exists (the walk climbs
above `cwd`, which a bounded adapter rejects), and the design requires one shared
implementation for every shim (R9). The question is what surface the single
implementation reads the filesystem through.

## Options considered

1. **`findLayout(fs: FileSystem, …)` with a temporary root-rooted `NodeFileSystem` for discovery** — pros: no new port / cons: constructs a `/`-rooted adapter — a real, if brief, containment widening for a path that needs three methods.
2. **New narrow `LayoutProbe` port: `stat` + `readUtf8`** (recommended) — pros: minimal trusted surface; preserves the "runs before the bounded FS exists" property / cons: one more (internal) port.
3. **Keep two copies and port the logic twice** — pros: none / cons: the status quo that let the copies drift.

## Decision

**Adopted-as-recommended (no user judgment).** Option 2: `src/ports/layout-probe.ts`
declares `LayoutProbe { stat; readUtf8 }` where `undefined` means "absent" and any other
I/O failure propagates. `src/repository/file-system-layout-probe.ts` adapts any
`FileSystem` port (implementing, once, the inherited narrowing that a path-confined
adapter's `PERMISSION_DENIED` reads as "absent" so the walk terminates at the sandbox
boundary). The node shim backs the probe with raw `node:fs/promises`. `LayoutProbe`
stays internal — not exported from the `ports/index.ts` barrel.

## Consequences

One discovery implementation shared by node and memory shims (browser per ADR-538); the
duplicate `discoverLayout` in `index.node.ts` is deleted. The published type surface is
unchanged.
