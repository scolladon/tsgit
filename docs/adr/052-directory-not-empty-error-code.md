# ADR-052: New `DIRECTORY_NOT_EMPTY` error code (mapErrno ENOTEMPTY split)

## Status

Accepted (at `50e6eed`)

## Context

`mapErrno` maps both `ENOTDIR` and `ENOTEMPTY` to the same domain
error: `notADirectory(path)`. The two errnos are semantically
distinct:

- **ENOTDIR**: a path component was used as a directory but is not
  one (e.g., `rmdir('/file.txt/inner')`).
- **ENOTEMPTY**: `rmdir` of a directory that contains entries.

Callers that pattern-match on `NOT_A_DIRECTORY` cannot distinguish
"the path is wrong" from "the directory has contents". Real
consequence: the security reviewer flagged this as LOW-3 in the
§14.4 pass — a caller retrying on `NOT_A_DIRECTORY` (e.g., a future
`force` flag implementation) would incorrectly clear directories
the user wanted preserved.

Adding a new error variant has cross-cutting impact:

1. The domain `ErrorData` union in `src/domain/error.ts` gains a
   member.
2. The error-class export (`directoryNotEmpty`) is added.
3. The Node `mapErrno` adds a case.
4. The memory adapter's analogous error path must produce the same
   code for parity (or stay on `NOT_A_DIRECTORY` and the new code
   is Node-adapter-only).
5. Any error-handling exhaustiveness checks in commands / primitives
   must handle the new case.

The Node adapter is the only adapter that emits errno-bearing errors
today. The memory adapter throws `notADirectory` from a
hand-written guard in its own `rmdir` implementation when the
directory has children. After this change, the memory adapter
should emit `directoryNotEmpty` for cross-adapter parity — otherwise
a test against the memory adapter sees one code and against
NodeFileSystem sees another.

## Decision

Add a new error variant `DIRECTORY_NOT_EMPTY` with `path: string`
payload, parallel to `notADirectory`:

```ts
// src/domain/error.ts
| { readonly code: 'DIRECTORY_NOT_EMPTY'; readonly path: string }

export const directoryNotEmpty = (path: string): TsgitError =>
  new TsgitError({ code: 'DIRECTORY_NOT_EMPTY', path });
```

`mapErrno` gains:

```ts
case 'ENOTEMPTY':
  return directoryNotEmpty(path);
```

(The current `ENOTEMPTY` case in the existing `case 'ENOTDIR':
case 'ENOTEMPTY':` block is split out.)

The memory adapter's `rmdir` is updated to emit `directoryNotEmpty`
for non-empty directories, restoring cross-adapter parity.

Any exhaustive `switch` over `TsgitError.data.code` in commands /
primitives gets a new `case` (or relies on `default`). The TypeScript
checker enforces this — adding the variant to the discriminated
union forces the compiler to flag every non-exhaustive switch.

## Consequences

### Positive

- Callers can distinguish "the path is wrong shape" from "the
  directory has contents". Future `force` / retry logic gains a
  precise discriminator.
- The semantic distinction matches POSIX errno semantics. No more
  one-to-many mapping in the adapter layer.
- Cross-adapter parity restored: both NodeFileSystem and
  MemoryFileSystem produce the same code for the same conceptual
  failure.

### Negative

- The error union widens. Every exhaustive consumer of `ErrorData`
  needs a `case 'DIRECTORY_NOT_EMPTY'`. The TypeScript checker
  surfaces these at build time; the work is mechanical but
  non-zero.
- Tests that previously matched on `NOT_A_DIRECTORY` for ENOTEMPTY
  scenarios need updating to `DIRECTORY_NOT_EMPTY`.

### Neutral

- The error union grew similarly when §14.3 introduced
  `GITIGNORE_FILE_TOO_LARGE` — the project has done this before and
  the cost is bounded.
- Browser adapter is unaffected — OPFS does not produce ENOTEMPTY
  through tsgit's surface (its `rmRecursive` is the only delete
  call, and recursive delete cannot ENOTEMPTY).
