# ADR-060: `FileSystem.appendUtf8` port addition

## Status

Accepted (at `1e5f20b`)

## Context

A reflog file (`.git/logs/<ref>`) is append-only: each ref update adds one
line, never rewrites. The `FileSystem` port exposes `read` / `readUtf8` /
`write` / `writeUtf8` / `writeExclusive` — but no append.

Two ways to append a reflog line:

- **(a) Read-modify-write.** Read the whole file, concatenate, write it back —
  necessarily under a lock to avoid losing a concurrent line, and O(file size)
  per append.
- **(b) A real append.** Add `appendUtf8` to the port; each adapter implements
  a native append.

Git appends to the reflog with `O_APPEND`, relying on the kernel's guarantee
that a single line-sized `write` to an `O_APPEND` fd is atomic. The ref
`.lock` protects the ref *file*; the reflog append rides `O_APPEND`
independently.

## Decision

Add `appendUtf8(path, content)` to the `FileSystem` port. It appends UTF-8,
creating parent directories and the file as needed.

Adapter implementations:

- **Node** — `fs.appendFile(path, data, 'utf8')` after `mkdir -p`; the open
  uses `O_APPEND`, giving per-write atomicity for line-sized content.
- **Memory** — `map.set(path, (map.get(path) ?? '') + content)`;
  single-threaded, trivially atomic.
- **Browser (OPFS)** — `createWritable({ keepExistingData: true })`, write at
  the current size, `close()`.

The contract is added to the shared `file-system.contract.ts` suite, so all
three adapters are covered identically.

## Consequences

### Positive

- Matches git's own reflog-append model; `O_APPEND` atomicity for line-sized
  writes with no lock on the log file.
- O(1) per append rather than O(file size).
- One small, well-specified method; the append semantics are simple to test.

### Negative

- The port surface grows by one method — three adapter implementations plus a
  contract test.

### Neutral

- OPFS's `createWritable` writes via a temp file swapped on `close`, so the
  browser append is not literally `O_APPEND`-atomic; the browser runtime is
  single-threaded with one `Context`, so this is not observable.
