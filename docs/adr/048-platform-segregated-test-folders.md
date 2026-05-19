# ADR-048: Platform-segregated integration test folders + CI matrix — folder gates, not `skipIf` gates

## Status

Accepted (at `e9e82e6`)

## Context

Phase 14.4 introduced two distinct test needs the cross-platform unit
suite couldn't satisfy:

1. **POSIX real-fs tests.** Exercise real symlinks, real permission
   bits (`0o600` enforcement, `EPERM` from a `chmod 000` parent), and
   real `mkdtemp` ergonomics on POSIX. These rely on Linux/macOS
   filesystem semantics that `node:fs` cannot fake on Windows.
2. **Windows real-fs tests.** Exercise 8.3 short-name reconciliation
   against a real `mkdtemp` parent, real drive-letter casing, the real
   Windows symlink behaviour (the developer-mode runner ships with
   `SeCreateSymbolicLinkPrivilege`), and `openRepository` accepting a
   `C:\`-prefixed path. These rely on NTFS / Win32 semantics the
   Linux/macOS unit suite cannot reach.

ADR-041 introduced the platform-mock strategy: unit tests inject a
`PathPolicy` (ADR-046) + `FsOperations` (ADR-047) to *simulate* the
non-host platform. That works for *logic* tests, but it does NOT cover
the OS→Node→adapter wiring layer. A simulated Windows test cannot prove
the real Windows kernel will surface `ERROR_PRIVILEGE_NOT_HELD` as
`EPERM` rather than something else.

Two options for the real-fs layer:

1. **`describe.skipIf(process.platform !== 'win32')` blocks inline in
   the cross-platform suite.** Tests live next to their POSIX
   counterparts; platform gate lives in the test body. Cheap to write,
   familiar pattern, but: (a) the `unit-tests` matrix would then have to
   run on *every* OS to be useful, multiplying CI cost; (b) `skipIf`
   silently produces "0 passed, N skipped" on the wrong host which is
   indistinguishable from real coverage gaps in dashboards; (c) the
   lint-staged `vitest related` hook runs on every commit on whichever
   developer OS — `skipIf` blocks add noise to local runs without
   exercising the code; (d) the §14.4 work would have added five+
   inline `skipIf` regions just to the `NodeFileSystem` suite — the
   smell was visible in the first draft.
2. **Folder-level segregation.** `test/integration/posix-only/` for
   real-POSIX-fs scenarios, `test/integration/win-only/` for
   real-Windows-fs scenarios. The Vitest config defines two extra
   projects (`posix-integration`, `win-integration`) that include only
   those folders. The cross-platform integration project explicitly
   *excludes* both folders. CI runs each project on the matching
   OS-pinned job; lint-staged scopes to `--project unit` so commit
   hooks never try to execute platform-bound suites on the wrong host.

Option 2 wins because the platform constraint becomes structural rather
than runtime: the folder is the contract. There is no "skipped on this
host" state — the test either belongs to the host's job or it doesn't.
Vitest, biome, ls-lint, and any future tooling all see the placement
unambiguously.

The lint-staged scoping is a critical, easy-to-miss detail. `vitest
related --run --project unit` is the only hook that fires per-commit;
restricting to `--project unit` keeps the commit hook deterministic on
both POSIX and Windows developer machines — neither integration nor
platform-bound suites run on commit. (`posix-integration` and
`win-integration` only run on the matching CI job; running them locally
remains an explicit `npm run test:posix-integration` /
`npm run test:win-integration` action.)

The `integration` job stays Linux-only because its primary content is
the `git-http-backend` CGI exercise, which is POSIX-only and unrelated
to platform-fs concerns. ADR-044 already documented that exclusion;
this ADR builds on it by carving out the platform-fs slice as a
*separate* job, not as a sub-matrix of `integration`.

## Decision

Adopt folder-level platform segregation for real-fs tests:

```
test/
├── unit/                              # cross-platform; runs on every CI cell
├── integration/
│   ├── network/                       # git-http-backend (POSIX-only); CI: integration job
│   ├── posix-only/                    # real POSIX fs; CI: posix-integration job (Linux + macOS)
│   └── win-only/                      # real Windows fs;  CI: win-integration job (windows-latest)
```

Vitest projects (`vitest.config.ts`):

- `unit` — `test/unit/**/*.test.ts`
- `integration` — `test/integration/**/*.test.ts`, **excludes**
  `posix-only/**` and `win-only/**`
- `posix-integration` — `test/integration/posix-only/**/*.test.ts`
- `win-integration` — `test/integration/win-only/**/*.test.ts`

CI jobs (`.github/workflows/ci.yml`):

- `unit-tests` — matrix `ubuntu-latest` + `macos-latest` + `windows-latest`
  × Node 22 + 24. Coverage threshold (100%) enforced on the Linux Node 22
  cell only.
- `integration` — `ubuntu-latest` only. Runs the `integration` project.
- `posix-integration` — matrix `ubuntu-latest` + `macos-latest`. Runs
  the `posix-integration` project.
- `win-integration` — `windows-latest` only. Runs the
  `win-integration` project.

Lint-staged (`package.json`):

```json
"lint-staged": {
  "*.ts": [
    "biome check --write",
    "vitest related --run --project unit"
  ]
}
```

The `--project unit` flag is mandatory. Commit hooks never run platform-
bound suites on the wrong host.

No `describe.skipIf` (or `it.skipIf`) for **platform gating** anywhere
in the test tree. `test/unit/` is cross-platform by construction; the
two `*-only/` folders are gated by their location and the CI matrix.
The Phase 11.1 `skipIf` directives for `git-http-backend` integration
tests remain unchanged — they gate on infrastructure availability
(git CLI present), not on platform.

## Consequences

### Positive

- **Structural platform gating.** The folder placement is the contract.
  No silent "0 passed, N skipped" rows in dashboards; no test body
  riddled with `skipIf` branches; no possibility of a Windows test
  accidentally running on Linux because someone deleted the `skipIf`
  by mistake.
- **CI cost is right-sized.** Real POSIX fs tests run only on POSIX
  cells; real Windows fs tests run only on the Windows cell. The
  `integration` job stays Linux-only and keeps its `git-http-backend`
  focus. Each job's runtime maps directly to what it actually exercises.
- **Local developer hooks stay fast and host-agnostic.**
  `vitest related --run --project unit` never tries to spawn a real
  symlink chmod chain on a host that can't satisfy it. POSIX
  developers can still run `npm run test:posix-integration` locally;
  Windows developers can run `npm run test:win-integration`.
- **Coverage stays cross-platform.** Coverage is measured on the unit
  suite only. The platform-bound suites verify *wiring* (the OS surface
  produces the errno the adapter expects); the unit suite verifies
  *logic*. Mixing them would inflate the coverage denominator with
  platform-bound code that's structurally unreachable on the gate cell.

### Negative

- **Three integration vitest projects instead of one.** Slight config
  duplication (~10 lines in `vitest.config.ts`). The `integration`
  project must explicitly `exclude` both `*-only` folders, otherwise
  the platform-bound suites would double-run in the Linux integration
  job.
- **A new file in a platform folder needs a CI job to exercise it.**
  If a contributor adds a `win-only/foo.test.ts`, only the
  `win-integration` job runs it. Forgetting that the file is gated by
  CI matrix (not by inline `skipIf`) is the new failure mode; the
  CONTRIBUTING.md note (Phase 14.4 followup) documents the placement
  rule.
- **The wireit `validate` graph leaves `posix-integration` and
  `win-integration` out of the default local validate flow.** Running
  the full real-fs matrix locally requires an explicit script.
  Acceptable — CI catches it, and the cross-platform unit suite covers
  the adapter logic on every developer host.

### Neutral

- The `test/integration/network/` folder predates this ADR and stays
  exactly where it is. Its skipping logic (CGI availability) lives
  inside the test body because the gate is not platform but *binary
  availability* — different axis.
- The OS list for `posix-integration` (`ubuntu-latest` +
  `macos-latest`) is wider than the `unit-tests` POSIX cells deliberately:
  macOS HFS+ case-insensitivity is a subtly different filesystem from
  Linux ext4, and the real-fs suite is where any divergence would
  surface. Cost is bounded — these tests are small.
- ADR-044 (`unit-tests` × `windows-latest` re-included) remains in
  force; this ADR adds the `*-integration` jobs alongside without
  changing the `unit-tests` matrix shape.
