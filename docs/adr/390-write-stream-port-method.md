# ADR-390: A new `FileSystem.writeStream(path, source)` is the streaming-write capability

## Status

Accepted

- **Date:** 2026-06-20
- **Design:** [design/blob-streaming.md](../design/blob-streaming.md)
- **Refines:** [ADR-383](383-stream-blob-primitive.md)

## Context

Wiring the checkout consumer to stream (ADR-392) requires writing a working-tree file
from a chunk source without buffering the whole content. `FileSystem` has only
`write(path, data: Uint8Array)` (whole buffer), `writeExclusive`, and a `FileHandle`
whose `write(buffer)` the Node adapter implements as a single
`handle.write(buffer, 0, buffer.length)`. There is no streaming write. A new port
capability is needed; its shape is the decision.

## Options considered

1. **(chosen) `writeStream(path, source: AsyncIterable<Uint8Array>): Promise<void>`** —
   high-level, mirrors `write`; the adapter owns the platform piping — pros: symmetry
   with how `createInflateStream` hides the platform stream; blast radius is 1 port
   method ×3 adapters + 1 contract test (same posture as `read`/`readSlice`/`write`);
   the call site stays a one-liner; cross-adapter feasible — Node
   `stream.pipeline(source, fs.createWriteStream(real))`, OPFS `createWritable()` loop
   (the adapter's `write` already uses `createWritable()`), memory concat-then-store /
   cons: the in-memory adapter cannot truly bound memory (acceptable — no disk).
2. **`createWriteStream(path): WritableStream<Uint8Array>`** — Rejected: leaks a Web
   stream type into every call site and duplicates the piping/bridge logic per caller.
3. **Reuse the `FileHandle` chunked-write loop via `openWithNoFollow`** — Rejected: not
   uniform — `openWithNoFollow` throws `UNSUPPORTED_OPERATION` on browser OPFS, so it
   cannot be the cross-adapter write path.

## Decision

Add `writeStream(path: string, source: AsyncIterable<Uint8Array>): Promise<void>` to the
`FileSystem` port, with the same contract as `write` (creates parent directories,
overwrites, writes bytes verbatim). Implement on all three adapters and cover it in the
shared port contract test. `FileHandle` is untouched.

## Consequences

### Positive

- One high-level method; adapters hide the platform write stream; minimal blast radius.

### Negative

- One more port method ×3 adapters + contract test to maintain.

### Neutral

- Symlink-safety stays the `rmIfExists`-then-write order (ADR-393); the no-follow guard
  is unavailable on OPFS regardless.
