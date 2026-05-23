# ADR-102: Remove the per-OS nightly mutation job

## Status

Accepted (at `90ea27b`) — supersedes [ADR-055](055-per-os-mutation-nightly.md).

## Context

ADR-055 stood up `.github/workflows/mutation-os.yml` to run full Stryker on macOS + Windows nightly. The framing then was: per-PR matrix mutation across three OSes would be ~3× the slowest gate; defer the per-OS signal to a nightly. That decision was correct given what was known at the time — 11.2 (cross-platform E2E) was open, and we did not yet know how much real OS-specific surviving-mutant risk lived in the adapter code.

Since ADR-055 landed:

- The `posix-integration` job (ADR-044) runs the real-fs POSIX semantics suite on Ubuntu + macOS. Errno parity, chmod mode bits, symlink permissions are all covered as real tests, not as mutated assertions.
- The `win-integration` job runs the real-fs Windows semantics suite on `windows-latest`: 8.3 short-name reconciliation, real `mkdtemp` paths, real Windows symlinks, drive-letter acceptance.
- The `FsOperations` DI refactor (Phase 14.4) means adapter platform branches are exercised cross-platform via DI in the unit suite — not just on the OS that hosts them.
- The nightly per-OS mutation job has not flagged a platform-specific surviving mutant since it landed. The signal is empty.
- macOS Actions minutes bill at a premium multiplier; Windows minutes bill at a smaller premium. The nightly burns both for redundant signal.

Phase 19.1 reworks mutation testing into per-bucket budgets with a diff-scoped PR gate. The nightly's role in the prior architecture was "the place where the slow full-tree mutation runs caught what the incremental PR job didn't." With diff-scoped PR runs and bucket-level enforcement, the question "what's the full-tree mutation score?" stops being a gating concern: every file touched in a PR is fully gated at PR time. Drift on untouched files is bounded by the next PR that touches them.

## Decision

Delete `.github/workflows/mutation-os.yml`. No replacement.

Per-OS adapter correctness continues to be enforced by:

- `unit-tests` matrix — `os: [ubuntu, macos, windows] × node: [22, 24]`, six cells per PR.
- `posix-integration` matrix — `os: [ubuntu, macos]`, real-fs POSIX semantics per PR.
- `win-integration` — Windows real-fs semantics per PR.
- `e2e` matrix — `browser: [chromium, firefox, webkit]`, browser adapter per PR.

Mutation testing runs on Linux only, on the PR gate, scoped to changed files. Local `npm run test:mutation` continues to run full-tree without the OS matrix (which it never had — `mutation-os.yml` was the only OS-spreading job).

Backlog item 11.2 (cross-platform E2E) stays `[x]` — its closure was always grounded in the per-OS unit-tests + integration matrices, not in the nightly mutation job. The cross-reference in ADR-055 that linked 11.2 to per-OS mutation was over-claimed.

## Consequences

### Positive

- Removes a nightly job whose signal has been consistently empty.
- Removes the macOS-minutes premium billing the nightly incurs.
- Removes maintenance surface — the nightly's stryker run does not benefit from the diff-scope optimization 19.1 introduces, so it would diverge from the PR path's configuration over time.
- Simpler CI story to explain in CONTRIBUTING: mutation is a PR-time gate, period.

### Negative

- A platform-specific surviving mutant that the per-PR `unit-tests` matrix and the integration jobs both miss would also slip past mutation forever. The risk is theoretical (zero historical incidents) but real. Mitigation: the maintainer can always run mutation locally on macOS or Windows before a risky platform-branching change.

### Neutral

- `stryker.config.json` needs no change — the diff-scoped PR job and the local full-tree run both use the same config.
- ADR-055 is marked Superseded, not deleted. Its rationale at the time stands; this ADR records the conditions that have changed.

## Alternatives considered

- **Keep the nightly, drop only the Windows cell** — rejected: macOS premium minutes are the larger cost, and the Windows cell has at least the theoretical edge for catching reconciler-style mutants. Either keep both or drop both; dropping only one is the worst of both worlds.
- **Move nightly to weekly** — rejected: same maintenance cost, same divergence risk, lower probability of catching anything. The signal-to-noise ratio gets worse, not better.
- **Promote nightly to "on-demand only" (workflow_dispatch)** — rejected: nobody runs on-demand jobs proactively. The job would exist only in name and rot.
