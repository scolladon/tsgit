# ADR-137: Interop suite uses canonical `git`, not snapshots

## Status

Accepted (at `69fb435`)

## Context

19.7 needs an oracle that proves tsgit's write paths produce Git-on-
disk bytes canonical `git` accepts (and, where the format is fully
specified, that the bytes match). Two candidate oracles exist:

1. **Snapshot fixtures**: produce golden byte files once with
   canonical `git`, commit them, and `expect(tsgitOutput).toEqual(
   readFileSync(golden))` in every test run.
2. **Live canonical `git`**: invoke the `git` binary at test time,
   capture its output (raw files via peer tmpdir, or readback via
   `git cat-file` / `git ls-files`), compare against tsgit.

Snapshot fixtures are faster, deterministic, and don't depend on a
binary being installed. Live `git` is slower and requires CI to
pin and install specific git versions.

The deciding factor is **oracle integrity**. A snapshot is just a
file in the repo; if tsgit mis-encodes a surface, the same PR can
regenerate the snapshot and "pass." Reviewers cannot tell from a
binary diff whether the snapshot moved because Git's format changed,
because tsgit's encoder changed legitimately, or because a bug was
silently baked in. The harness ends up grading its own homework.

Real `git` keeps the oracle external. The test produces a peer
tmpdir state via canonical `git`, then compares. If tsgit drifts,
the test fails — there is no snapshot to "update."

## Decision

19.7 interop tests invoke canonical `git` at test time. No snapshot
fixtures are committed for the interop layer. Comparison kind
(`byte-identical`, `equivalent-under-readback`, `readback-only`) is
declared per surface in the `@writes` tag and enforced by the
test's comparison strategy (see ADR-138).

Tests guard with `it.skipIf(!hasGit())` so contributors without a
git binary still run the rest of the suite; CI installs known git
versions and runs the matrix unconditionally.

## Consequences

### Positive

- A tsgit mis-encoding cannot be "blessed" by regenerating a fixture
  in the same PR — there is no fixture to regenerate.
- The oracle stays current automatically. When canonical `git`
  ships a format-touching change (rare but real — e.g. index v4
  defaults), the matrix surfaces it as a test failure on the
  `latest` runner well before any user notices.
- Reviewers reading an interop diff see real assertions and real
  comparison calls, not opaque binary deltas.

### Negative

- CI wall time grows. Each interop test spawns `git` once (typically
  twice — peer-tmpdir setup + readback). Mitigated by per-test
  scenarios staying small and the matrix being limited to two pins.
- Contributors who run the integration suite locally must have
  `git` installed — they already do; tsgit is a Git library.
- Test setup is more verbose than `expect(out).toMatchSnapshot()`.
  The verbosity is the point: each interop test makes the
  comparison strategy explicit, which is exactly what 19.7 is
  trying to enforce.

### Neutral

- An attacker who can backdoor the `git` binary on a CI runner
  could pass a malicious oracle. This is true of any test that uses
  any binary; out of scope.
- The pre-existing `reflog-writers.test.ts` already uses this
  pattern; 19.7 generalises rather than introducing a new style.
