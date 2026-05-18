# ADR-032: Large-file guard aborts the walk with `WORKING_TREE_FILE_TOO_LARGE`

## Status

Accepted (at `5ecd61a`)

## Context

Phase 13.8 introduced `maxBytes` on `readObject` / `readBlob` to cap
the post-inflate size of git objects coming off disk or out of a
pack. The cap fires BEFORE materialising the inflated payload into
memory, defending against adversarial blobs in a pack.

`add --all` faces the symmetric problem from the other direction:
the working tree may contain arbitrarily large files (build
artefacts, video, datasets) that the walker shouldn't materialise
into a single `Uint8Array` and then handover to `writeObject`. A
50 GiB log file in `dist/` would OOM Node before the user even
realises `--all` is the wrong tool.

Three options:

1. **Skip silently:** big files vanish from staging with no signal.
   Violates "fail fast" + the project's stance against silent
   suppression.
2. **Plumb `maxBytes` through `writeObject`:** symmetric with the
   §13.8 read path. Requires re-shaping every `writeObject` caller
   and introducing a streaming code path.
3. **Pre-check `stat.size` against a cap in `addAll`:** fast, no
   extra I/O (size already in hand from the walk's `lstat`), and
   the failure fires before any blob is hashed.

Option 2 is the "right" long-term answer (full streaming I/O) but
out of scope for §14.1 — it's a v2-class change touching every
write path. Option 1 is rejected on principle. Option 3 is the
pragmatic, ADR-tracked choice.

### Error shape: reuse `OBJECT_TOO_LARGE` or a new variant?

`OBJECT_TOO_LARGE` carries `id`. At the point the §14.1 guard
fires, we have a path but no id (the blob hasn't been hashed yet).
Two ways to handle this:

- **Reuse:** put a sentinel id (`'0'.repeat(40)`) in the error
  payload. Saves a new variant but the payload is misleading — a
  consumer that branches on `id` sees zeroes that don't map to any
  real object.
- **New variant:** introduce `WORKING_TREE_FILE_TOO_LARGE` with
  `path`, `size`, `limit`. The payload is honest about what hit
  the cap and what the operator needs to do (`rm` the file or
  bump the cap).

## Decision

Option 3 + a new error variant `WORKING_TREE_FILE_TOO_LARGE` with
`{ path: FilePath, size: number, limit: number }`. The cap value is
`MAX_WORKING_TREE_BLOB_BYTES = 256 * 1024 * 1024` — the same 256 MiB
ceiling as `MAX_CONFLICT_OUTPUT_BYTES` so the memory-pressure
budget across read + write paths is symmetric.

The check fires AFTER `seen.add(path)` (so the not-seen → removed
logic stays correct in case the user's first action is to `rm` the
big file) and BEFORE `stageFromStat` — no partial blob is written.

The throw unwinds out of `addAll`'s `try`; the `finally` calls
`lock.release()` without `lock.commit()`. The on-disk `.git/index`
is unchanged. Atomicity guaranteed.

## Consequences

### Positive

- Honest failure mode: the user sees the path + the cap; remedy is
  obvious (move the file, drop it, or raise the cap once it's
  configurable).
- No partial commits — the index is the same after a failed
  `add --all` as it was before.
- Symmetric with §13.8 in spirit (cap fires before materialising
  bytes) without requiring a new write-path API surface.

### Negative

- The cap is hard-coded for §14.1. A future ADR will expose it via
  `AddOptions.maxFileBytes` or repository config once we have a use
  case for raising it.
- A user with one outsized file can't `add --all` even if all the
  other files would have staged cleanly. They must filter the path
  manually (literal-path mode) or remove the file. Acceptable for
  v1.

### Neutral

- New error variant adds one row to `CommandError` and one arm to
  `extractDetail`. Maintenance cost is trivial relative to the
  clarity it buys downstream.
