---
subjects:
  - src/ports/file-system.ts
  - src/adapters/node/node-file-system.ts
  - src/adapters/memory/memory-file-system.ts
  - src/adapters/browser/browser-file-system.ts
  - src/repository/wrap-fs-validator.ts
  - src/application/primitives/internal/read-capped-file.ts
  - src/application/primitives/config-scoped-read.ts
  - src/application/primitives/shallow-file.ts
  - src/application/primitives/read-sparse-checkout.ts
---
# 884 — The `FileSystem` port gains optional non-throwing `lstat` and UTF-8 read probes

- **Status:** accepted
- **Date:** 2026-09-22
- **Design:** docs/design/node-io-cold-read-pipeline.md (D4, DC-4) · **Supersedes/Refines:** refines ADR-873 (the optional-capability shape) and ADR-870 (structural classification)

## Context

An *expected* miss costs a `TsgitError` whose stack capture is 2.1 µs against 0.22 µs without
it. A clean `status` constructs 200–400 of them, one per directory (`loadCappedUtf8` →
`lstat(dir/.gitignore)` → `ENOENT`), 4–5 % of the command; per-command probes of usually-absent
files (`shallow`, sparse-checkout, scoped config) pay the same. ADR-873 already gave the port an
optional `lexists` whose absence is a documented, equivalent fallback. Loose-ref misses go
through `openWithNoFollow` and are a different seam.

## Options considered

1. **Optional `tryLstat` / `tryReadUtf8` port methods in the ADR-873 shape, fallback in callers**
   — pros: the miss becomes data; stacks stay intact for real faults; adapters that omit them
   change cost, never answers / cons: hot callers carry a fallback. *Recommended by the design.*
2. **Stack-free `FILE_NOT_FOUND` construction inside the adapters** — pros: no port change /
   cons: drops the stack on every not-found, the unexpected ones included.
3. **Both** — cons: two mechanisms for one cost.

## Decision

**Option 1 — adopted-as-recommended (no user judgment).** `FileSystem` gains
`tryLstat?(path): Promise<FileStat | undefined>` and `tryReadUtf8?(path): Promise<string |
undefined>`. Each resolves `undefined` exactly where its throwing twin refuses `FILE_NOT_FOUND`
and behaves identically otherwise, so omitting the method changes cost and never the answer. The
Node sync arm answers a miss with `throwIfNoEntry: false` (no error object at all); its async arm
catches `ENOENT` before `mapErrno` as `isPresent` does. The memory adapter reuses its `lstat` /
`readUtf8` resolution (ancestor symlink walk included) and returns `undefined` on the not-found
arm; the browser adapter does the same on its handle walk. `wrap-fs-validator.ts` forwards both
only when present, guarded as read surfaces. Callers use `ctx.fs.tryLstat?.(p)` and fall back to
the throwing method plus `errorDataCode(err) === 'FILE_NOT_FOUND'`, never `instanceof`. The hot
callers converted in this slice are `loadCappedUtf8`, the scoped config read, the shallow file
and the sparse-checkout read; cold `FILE_NOT_FOUND` catch sites stay as they are.

## Consequences

- The per-directory miss on `status` and the per-command probes stop paying a stack capture; a
  probe per part measures the count.
- A `tryOpenWithNoFollow` for loose-ref misses is out of scope and becomes a follow-up only if
  the measurement shows ref misses matter.
- The `instanceof TsgitError` in `loadCappedUtf8` is replaced by the structural check while the
  site is touched.
