# ADR-046: `PathPolicy` abstraction — host vs. simulated-platform separation in the Node adapter

## Status

Accepted (at `e9e82e6`)

## Context

Phase 14.4 needed two distinct kinds of platform awareness inside
`src/adapters/node/node-file-system.ts`:

1. **Host platform.** What `process.platform` reports right now — drives
   `nodePath.sep`, the casing convention for containment compares, the
   selection of `nodePath.posix` vs `nodePath.win32`, and the errno
   discriminator for `O_NOFOLLOW` symlink refusal (ADR-043).
2. **Simulated platform.** The platform a *test* wants the adapter to
   behave as, regardless of where the test runs. POSIX-only tests must
   verify the Windows code paths (8.3 short-name reconciliation, drive-
   letter casing, `caseInsensitive` containment) without skipping on
   non-Windows runners; Windows runs must still exercise POSIX paths
   that the cross-platform suite ships.

The Phase 14.4 design draft (`docs/design/phase-14-4-windows-support.md`
§3.2) initially specified a `platform.ts` module exporting
`isWindows()` / `normalizeForCompare()` as separate helpers. Tests would
`vi.spyOn(platformModule.isWindows)`. That approach worked for the
narrow case but had three drawbacks once implementation started:

- **Surface creep.** Every new platform-aware operation needed yet another
  exported helper (`sep`, `caseInsensitive`, `rootOf`, `resolve`,
  `dirname`, `basename`). Each had to be individually spy-able.
- **Spying drift.** Vitest's module-level `vi.spyOn` patches the imported
  binding; if a call site captured the function reference at module top
  level (e.g., `const { isWindows } = await import(...)`), the spy
  silently did nothing. The smell appeared in the contract suite around
  the first `realpath` mismatch and would only get worse as more helpers
  joined.
- **Two truths drift.** Production code reads `process.platform`; tests
  override the helper. The two arms can disagree (the production arm
  takes its own copy of `nodePath.sep`, the test arm overrides
  `isWindows()` but leaves `nodePath.sep` alone). Bugs hide between the
  two reads.

Three design options:

1. **Keep the per-helper module.** Add another export per concern,
   accept the spy-binding fragility. Rejected — the failure mode
   (silently inactive spy) is invisible and bites under refactors.
2. **Full domain `Path` wrapper.** Branded `Path` type with methods
   (`Path.resolve`, `Path.dirname`, …). Rejected — would force every
   adapter call site, every test, and every fixture to convert between
   raw strings (which Node returns) and `Path` instances. The blast
   radius is wrong for a portability slice that has zero domain
   implications.
3. **A single injectable `PathPolicy` interface.** Capture every
   platform-aware path operation the adapter needs as one cohesive
   interface; expose `nativePolicy` (host-matching) for production and
   `posixPolicy` / `windowsPolicy` for tests. Injected at the
   `NodeFileSystem` constructor as an optional second parameter with a
   default of `nativePolicy`.

Option 3 wins because: (a) one interface stays cohesive as Windows
quirks grow (extended-length paths, UNC), (b) tests construct a policy
explicitly — no module-level spying — and (c) production callers see no
behavioural change because the default is the host policy.

The interface is intentionally `Pick`-shaped at the type level
(`PathPolicy` lists the exact methods rather than `typeof nodePath`),
which both documents the contract and forbids smuggling host-bound
`nodePath` calls back into `NodeFileSystem` (the production code uses
`this.pathPolicy.xxx` exclusively for the platform-aware operations).

A pure helper `selectNativePolicy(platform: NodeJS.Platform): PathPolicy`
is exported alongside the platform-bound `nativePolicy` so both arms of
the `process.platform` selection are unit-testable on any host. Without
this seam the non-matching arm of `nativePolicy`'s ternary would be
forever uncovered on the Linux mutation runner.

## Decision

Introduce `src/adapters/node/path-policy.ts` exporting:

- `interface PathPolicy { sep, caseInsensitive, isAbsolute, resolve, join,
  dirname, basename, rootOf, normalizeForCompare }` — the minimal
  platform-aware path surface `NodeFileSystem` uses.
- `posixPolicy` (backed by `nodePath.posix`, `caseInsensitive: false`).
- `windowsPolicy` (backed by `nodePath.win32`, `caseInsensitive: true`).
- `selectNativePolicy(platform)` — pure ternary, both arms testable.
- `nativePolicy = selectNativePolicy(process.platform)` — the host-bound
  default.

`NodeFileSystem`'s constructor takes `pathPolicy: PathPolicy = nativePolicy`
as an optional second argument. Internal helpers (`toAbsolute`,
`pathContains`, `realpathNearestExisting`, `isWindowsSymlinkRefusal`) also
default their `policy` parameter to `nativePolicy` so they remain callable
standalone from internal call sites and from tests.

The `caseInsensitive` flag intentionally encodes only Windows (per Git's
`core.ignorecase` default and POSIX convention). macOS HFS+ is treated as
case-sensitive even though the filesystem usually isn't — matching Git's
own portability stance.

## Consequences

### Positive

- **One seam, one default.** Production code paths the same way they
  did before — the default value is the host policy. Tests inject the
  opposite policy to exercise the other platform's code path on any
  host.
- **No mid-test mutation of `process.platform`.** That global is
  effectively read-only on Node and previously required workarounds
  (`Object.defineProperty` + restore) that interact badly with
  ESM-cached modules. The policy abstraction makes the platform a
  *value* passed in, not a global to monkey-patch.
- **Mutation testing reaches both arms.** `selectNativePolicy(platform)`
  is the only branch on `platform === 'win32'` left in the codebase;
  both arms are killed by unit tests in `path-policy.test.ts`.
- **Future Windows quirks extend the same interface.** Long-path
  prefix handling, UNC path normalisation, or NTFS reparse-point
  detection plug into `PathPolicy` without touching call sites.

### Negative

- **Two extra files to maintain.** `path-policy.ts` (~70 LOC) plus the
  test file (~80 LOC). Trivial — and the previous `platform.ts`
  proposal would have been about the same size.
- **A second indirection at every path-aware call site.**
  `this.pathPolicy.resolve(p)` instead of `nodePath.resolve(p)`. Reads
  fine in practice; static review confirms no perf cost (the methods
  are direct delegations to `nodePath.posix` / `nodePath.win32`).

### Neutral

- The `PathPolicy` interface is `@internal` to the Node adapter — not
  re-exported from `src/adapters/node/index.ts`. Browser and memory
  adapters do not need it.
- The ports layer (`src/ports/file-system.ts`) is untouched. `PathPolicy`
  is an adapter-internal seam, not a port. Ports define what tsgit needs
  from a host; `PathPolicy` factors out how the Node adapter satisfies
  it on each OS.
- This pattern is duplicated for FS calls in [ADR-047](047-fs-operations-dependency-injection.md);
  both seams live one level deeper than the `FileSystem` port.
