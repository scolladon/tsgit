# ADR-047: `FsOperations` dependency injection — the `node:fs/promises` surface as a constructor argument

## Status

Accepted (at `e9e82e6`)

## Context

Before Phase 14.4, `NodeFileSystem` imported `fsPromises` directly and
called `fsPromises.readFile(…)`, `fsPromises.realpath(…)`, etc. as
free-function calls bound at module load. Tests reached the same module
via `vi.mock('node:fs/promises', …)` and patched the imports for the
duration of the file.

The §14.4 work made that arrangement painful for three reasons:

1. **Cross-file mock leakage.** `vi.mock` is file-scoped only in name —
   ESM module evaluation is shared, and a single rogue test that
   mutated the mock state (`mockRealpath.mockImplementationOnce(…)`)
   could affect every subsequent test in execution order. The previous
   `node-file-system-containment.test.ts` was the symptom: every test
   that needed to mock fs piled into one ~700 LOC file because adding a
   sibling file forced a fresh `vi.mock` sequence that interacted
   weirdly with the existing one.
2. **No per-instance fakes.** The §14.4 design (and ADR-046's
   `PathPolicy`) lets one test instantiate a "Windows-shaped"
   `NodeFileSystem` and another a "POSIX-shaped" one in the same file.
   But `vi.mock` patches the *module*, so both instances saw the same
   mocked `fsPromises`. The clean way to assert that an instance with
   `windowsPolicy` *also* called a windows-specific realpath sequence
   was to inject the fs surface per instance, not per file.
3. **Mock semantics drift from production.** `vi.mock` returns
   `vi.fn()` for every export by default. Forgetting to wire one
   exports a `MockFunction` that returns `undefined`, which then
   throws an unrelated error in production code (`Cannot read property
   'isSymbolicLink' of undefined`). Explicit DI forces the test to
   declare what it stubs and lets TypeScript flag the rest at compile
   time.

Three design options:

1. **Stay with `vi.mock`.** Cheap up-front, but the file-level coupling
   was already a code smell and the §14.4 layered tests (Windows + POSIX
   in one file, per-instance) would have made it worse.
2. **Full `FsAdapter` port.** Lift the Node-fs surface to
   `src/ports/file-system-host.ts`, give it Browser/Memory/Node
   implementations. Rejected — the `FileSystem` port at
   `src/ports/file-system.ts` is already the abstraction over host
   filesystems. Introducing a *second* port one level deeper duplicates
   responsibility and pollutes the domain with adapter implementation
   detail.
3. **Adapter-internal DI.** Define an `@internal` `FsOperations` type
   in `src/adapters/node/fs-operations.ts`, shaped as a
   `Pick<typeof fsPromises, …>` of the exact members `NodeFileSystem`
   uses. Production wires the real module (`realFsOps = fsPromises`).
   Tests pass a fake object. Optional third constructor argument with
   `realFsOps` as the default — production callers unaffected.

Option 3 keeps the seam *inside* the adapter, exactly where it belongs:
the `FileSystem` port still describes what tsgit needs from a host;
`FsOperations` is one layer deeper, describing *how* the Node adapter
talks to the host fs library. They are not competing abstractions.

The `Pick<typeof fsPromises, …>` typing is load-bearing. It means:

- Production code passes `fsPromises` (or `realFsOps`, which is the
  same reference) — no glue object.
- Tests pass a `fakeFsOps` helper that returns a partial object cast to
  `FsOperations`; only the methods exercised need an implementation.
  Missing methods surface as TypeError on call rather than silent
  `undefined`.
- The interface tracks `fsPromises` automatically. If Node renames or
  removes a method tsgit uses, TypeScript flags the call site at the
  next build.

## Decision

Introduce `src/adapters/node/fs-operations.ts`:

```ts
export type FsOperations = Pick<typeof fsPromises,
  'chmod' | 'lstat' | 'mkdir' | 'open' | 'readdir'
  | 'readFile' | 'readlink' | 'realpath' | 'rename'
  | 'rm' | 'rmdir' | 'stat' | 'symlink' | 'writeFile'>;

export const realFsOps: FsOperations = fsPromises;
```

Refactor `NodeFileSystem` to take `fsOps: FsOperations = realFsOps` as
an optional third constructor parameter (after `rootDir`, `pathPolicy`).
Internal helpers `realpathNearestExisting` and `resolveForCreation`
take an optional `fsOps` parameter so they remain pure functions
unit-testable in isolation.

Every internal call site replaces `fsPromises.xxx(…)` with
`this.fsOps.xxx(…)` (or the parameter inside the helpers).

Tests use a `fakeFsOps` factory (in
`test/unit/adapters/node/node-file-system-injected.test.ts`) that builds
an `FsOperations` from a record of method stubs. The previous
`vi.mock('node:fs/promises', …)` plumbing is retired across the file.

The module is `@internal` — not exported from
`src/adapters/node/index.ts`. End-users have no reason to construct a
`NodeFileSystem` with a custom `FsOperations`; the seam exists for
internal tests.

## Consequences

### Positive

- **Per-instance fakes.** Two `NodeFileSystem` instances in the same
  test file can see different `fsOps` and `pathPolicy`. The new
  injected test file exercises POSIX-shaped + Windows-shaped scenarios
  side by side without `vi.mock`.
- **Failures point at the seam.** A test that forgets to stub
  `readlink` gets `TypeError: this.fsOps.readlink is not a function` —
  the test file, not a deep adapter call. Stack traces shorten.
- **Type-driven coverage.** Adding a new `fsPromises` call site means
  adding the method to the `Pick<>` first; the compiler then nags
  every test fake to add a stub. Coverage drift becomes a build error.
- **Plays well with `PathPolicy`.** Tests assemble exactly the
  (policy, fsOps) pair they need: posix-policy + posix-shaped fsOps;
  windows-policy + windows-shaped fsOps. Hosts cancel out of the
  arrangement. See [ADR-046](046-path-policy-abstraction.md).

### Negative

- **One extra constructor parameter.** Production code that constructs
  `NodeFileSystem` directly (the `repository` factory, the
  `node-adapter` bundle) passes nothing — the defaults work. But
  third-party users who hand-build the adapter now see an extra
  optional param in IntelliSense. Minor cost; the param is `@internal`
  in shape (default `realFsOps`) so it shouldn't appear in published
  docs.
- **Every call site reads `this.fsOps.x` instead of `fsPromises.x`.**
  Stylistic — no perf cost; the property dereference is a single
  hidden-class lookup in V8 that gets inlined.

### Neutral

- The `FileSystem` port at `src/ports/file-system.ts` is unchanged. It
  remains the contract tsgit speaks to all hosts; `FsOperations` is
  the *adapter's* private contract with the Node `fs` module.
- The browser and memory adapters do not gain a similar seam — they
  already control their own fs surface (OPFS / in-memory map). The DI
  exists only where the test pain existed: against the real Node fs
  module.
- The previous `vi.mock('node:fs/promises')` site is fully removed by
  this branch. Future Node-fs additions need a stub method only, not a
  fresh `vi.mock` block.
