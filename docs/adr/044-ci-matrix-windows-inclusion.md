# ADR-044: CI matrix — `unit-tests` × `windows-latest` re-included; mutation / integration / E2E remain Linux-only

## Status

Accepted (at `963a72b`)

## Context

Phase 11's `unit-tests` matrix initially included `windows-latest`. After
discovering the NodeFileSystem path handling bugs (8.3 short names,
mixed separators) the cell was removed with a comment pointing at
Phase 14.4. Once §14.4 lands, the cell must be re-added.

The CI workflow has six job clusters that COULD run on Windows:

| Job              | Cost-on-Windows | Value-on-Windows |
|------------------|-----------------|------------------|
| lint / typecheck / check:* | Marginal (1-2 min more) | None — pure-TS, OS-agnostic |
| build / size / exports     | Marginal       | None — bundler is platform-stable |
| **unit-tests**             | High (~12-15 min) | HIGH — adapter code paths |
| mutation                   | Very high (~45 min per OS) | Tracked under §15.4 |
| integration                | Blocked — `git-http-backend` is POSIX-only |
| e2e (Playwright)           | Already covers Chromium/Firefox/WebKit on Linux |

`unit-tests` is the only cluster whose Windows run catches platform-real
bugs (the adapter is the only place platform branches live). The other
clusters either have nothing to gain (lint, build) or are physically
blocked (integration needs `git-http-backend` CGI, which is POSIX).

Adding `windows-latest` to ALL clusters would multiply CI cost without
catching bugs.

## Decision

Re-include `windows-latest` ONLY in the `unit-tests` matrix:

```yaml
os: [ubuntu-latest, macos-latest, windows-latest]
node: [22, 24]
```

Mutation testing stays on `ubuntu-latest` (per Phase 15.4 backlog).
Integration tests stay on `ubuntu-latest` (`git-http-backend`
constraint, documented in the integration test files).
E2E / Playwright stays on `ubuntu-latest` (the three browser engines
cover platform-independent rendering).

The coverage-artifact upload retains its `matrix.os == 'ubuntu-latest'`
guard — only one OS uploads the coverage report to keep artifact names
unique.

## Consequences

### Positive

- The matrix doubles in effective coverage for the adapter (the actual
  source of Windows-only bugs), at ~2× the cluster cost (12-15 min
  vs. 6 min for Linux Node 22).
- Other clusters stay cheap. Lint + typecheck + checks finish in
  the same wall time as before.

### Negative

- `unit-tests` total wall-clock budget grows. With the existing matrix
  this job already gates the merge queue; the Windows cell becomes the
  longest-tail step. Acceptable — Phase 11.2 backlog called this out.
- Windows runners are sometimes flaky on GitHub Actions (image
  refreshes, slow networks, mscv runtime updates). We accept a small
  flake rate; transient failures can be re-run via the "Re-run failed
  jobs" UI.

### Neutral

- The Phase 11 ".github/workflows/ci.yml" comment block that explained
  the exclusion is removed.
