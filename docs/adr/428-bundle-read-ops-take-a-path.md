# 428 — bundle read ops take a path; the library opens it

- **Status:** accepted
- **Date:** 2026-06-27
- **Design:** docs/design/bundle.md · **Relates:** ADR-226 (git-faithfulness), ADR-422 (create returns bytes)
- **Decision class:** D-API (user judgment)

## Context

`verify` and `listHeads` read an existing bundle file. The input can be supplied two ways:
the caller reads the file and passes bytes, or the caller passes a path and the library
opens it via `Context.fs`. `create` returns bytes for the caller to write (ADR-422), so a
bytes-in read surface would be symmetric with it. Against that, git's read commands take a
file path and emit their own `could not open` faithfulness when the file is missing.

## Options considered

1. **Caller passes bytes** (`{ bytes }`) — pros: symmetric with `create`'s bytes-out;
   matches the `archive` bytes-in/out through-line; cons: the library cannot emit git's
   `could not open` error — that faithfulness moves to the caller.
2. **Library reads a path** (`{ path }`) — the library opens the file via `Context.fs`
   *(user choice)* — pros: ergonomic; lets tsgit emit the git-faithful open/read error
   itself; the read ops own their I/O end to end; cons: an asymmetry with `create`, which
   returns bytes rather than writing a path.
3. **Bytes or stream** — pros: flexible for large bundles; cons: a wider input surface to
   specify and pin now.

## Decision

**Option 2 — ratified by the user**, deviating from the designer's bytes-in recommendation.
`verify` and `listHeads` take `{ path }`; the library opens the file via `Context.fs` and
emits the git-faithful error when it cannot be opened or read.

## Consequences

- The "could not open / read" refusal is owned and pinned by the library, matching git.
- A deliberate asymmetry remains with `create` (ADR-422), which returns bytes the caller
  writes; the design revision reconciles whether `create` also offers a path-write
  convenience or the producer-returns-bytes / readers-take-a-path split stands as the
  intended shape.
