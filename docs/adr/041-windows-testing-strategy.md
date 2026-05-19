# ADR-041: Windows support — dev on macOS with platform-mocked unit tests, gate on real `windows-latest` CI

## Status

Accepted (at `963a72b`)

## Context

BACKLOG §14.4 ("Full Windows support") needs the unit-test suite to pass on
a real `windows-latest` runner. Two ways to drive the work:

1. **Real-runner-only.** Develop blind on macOS with no Windows-specific
   tests; push a draft PR, wait for the CI matrix to fail, read the logs,
   patch, push, repeat.
2. **Mock-and-verify.** Develop on macOS with unit tests that mock the
   Windows quirks (8.3 short names, drive-letter casing, EACCES errnos)
   via a platform indirection seam. Push a draft PR once the macOS suite
   is green to validate against the real runner.

Option 1 leaks every iteration cycle into ~12-15 min CI runs. The error
visibility is poor — symlink failures show as `EPERM` strings rather than
discriminator-level reasoning. The harness-green / mutation-testing /
review passes effectively cannot run until the matrix is green, blocking
the whole pipeline.

Option 2 requires a small platform-indirection module
(`src/adapters/node/platform.ts` exporting `isWindows()` /
`normalizeForCompare()`) so tests can `vi.spyOn` the exported helpers.
The cost is one extra module; the benefit is that the entire phase can
be developed in seconds-per-iteration on macOS and the real-runner pass
serves as a verification gate rather than the primary debug loop.

The phase 14.4 design (see `docs/design/phase-14-4-windows-support.md` §3.2)
already needs the platform module for code (`normalizeForCompare` is
called on every containment check); the test-injection use is a free
extra capability of the same module.

## Decision

Develop Phase 14.4 on the macOS shell using platform-mocked unit tests
that exercise the Windows code paths via the `platform.ts` indirection.
After the local suite is green, push the branch as a draft PR with the
`windows-latest` matrix re-enabled (per ADR-044). The real-runner pass
is the merge gate; the mocked tests are the development loop.

## Consequences

### Positive

- Iteration cycles stay seconds-long. The full `npm run validate` runs
  on a developer shell, not on CI.
- Mutation testing on Linux already covers the new branches (the
  `isWindows()` short-circuit produces equivalent mutants documented
  inline — see design §4.3).
- Adds a reusable platform-indirection module that future Windows-only
  fixes can extend without touching every call site.

### Negative

- Mocked tests can drift from real Windows behaviour. We mitigate by
  pairing each mocked case with a real `describe.skipIf` integration
  test (see design §4.2) that runs only on the Windows CI cell.
- One extra module (`platform.ts`) to maintain. ~10 LOC; trivial.

### Neutral

- The "draft PR pattern" is already used in this repo for OS-sensitive
  changes (e.g., the npm-publish OIDC fix at the v1.0.0 release).
