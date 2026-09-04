---
subjects:
  - test/bench/support/fixture-generator.ts
---
# 793 — The generator replaces a cached fixture that fails its identity probe

- **Status:** accepted
- **Date:** 2026-09-04
- **Design:** docs/design/fix-main-ci-bench-fixture-deps.md (D3) · **Supersedes/Refines:** refines ADR-054

## Context

`ensureScaledFixture` trusted a cached fixture on `meta.version` alone, so a fixture whose
`HEAD` had been detached by a bench was returned as pristine and every later consumer of that
fixture failed. Every generator strategy ends with `checkout -f main` and records
`headCommitId = rev-parse HEAD`, so a pristine fixture always satisfies two invariants that
hold for every spec: `HEAD` is the symbolic ref `refs/heads/main`, and `refs/heads/main`
equals `meta.headCommitId`. Commit count is strategy-dependent and was rejected as the probe.
ADR-054 rules that the cached directory is never deleted by benches; it says nothing about the
generator repairing a directory it can prove is not the one it wrote.

## Options considered

1. **Identity probe, then warn on `stderr` and replace** (designer's recommendation) — pros:
   self-heals an already-mutated local cache; the warning names the label and the mismatch so
   a future mutating bench is visible / cons: the generator gains the right to remove a cache
   directory.
2. **Identity probe, then throw a distinct error** — cons: `resolveScaledContext` turned every
   error into a silently skipped scenario, so a corrupt fixture would become a missing benchmark
   row; local caches would stay broken until a manual removal.
3. **Identity plus `git status --porcelain` cleanliness** — cons: an O(20 000-file) scan on each
   of the 38 resolutions per run, a special case for the fixture's own untracked `meta.json`,
   and still blind to tags and dangling objects.

## Decision

**Ratified by the user: option 1.** On a cache hit `ensureScaledFixture` first reads the
`.git/HEAD` file itself — a pristine fixture's is exactly `ref: refs/heads/main`, so a detached
oid, another ref, garbage or a missing file is a proven fact about the directory, needing no
git — and then runs `rev-parse --verify -q refs/heads/main^{commit}`, which answers "no" with
exit 1 when the ref is missing. If either fact disagrees with what the generator wrote, it
writes one warning line to `stderr` naming the fixture label and the mismatch, moves the
directory aside with a single `rename`, removes it, and rebuilds through the existing
temp-build-then-rename path. Any other non-zero exit of the probe means git could not run it
(dubious ownership, a transient spawn failure): the cache is then **unverifiable**, kept as-is,
and a warning says so and names the directory to delete for a forced rebuild — a mismatch is
never assumed (review refinements, adopted). A mismatch proven with no `git` on `PATH` cannot
be repaired: the fixture is reported unavailable (benches skip) and the cache is left in place. The retire step runs unconditionally before
any rebuild, so a directory with no readable `meta.json` can no longer make the final `rename`
fail with `ENOTEMPTY`. With `git` absent the probe cannot run and the hit degrades to today's
behaviour: the cached fixture is returned unchanged. The probe checks identity only; tags and
dangling objects added by benches are tolerated by construction.

## Consequences

- ADR-054's rule stands for benches: they never delete or mutate the cache. The generator alone
  may replace a directory that fails the probe, and only after proving the mismatch.
- Editing `fixture-generator.ts` changes the CI `actions/cache` key once; the first run under
  the new key cold-builds every fixture (seconds each, measured) and saves it.
- A healthy run prints no warning, so the warning's appearance is itself the signal that a
  bench has started mutating a shared fixture.
- Every generator git spawn runs with `GIT_CONFIG_GLOBAL` and `GIT_CONFIG_SYSTEM` pointed at
  `/dev/null`, an isolated `HOME` and `XDG_CONFIG_HOME`, `GIT_CONFIG_NOSYSTEM=1`, and
  `GIT_CEILING_DIRECTORIES` at the cache root, so neither an ambient git setting nor an ancestor
  repository can steer a verdict that retires a directory. Accepted consequence: a
  `safe.directory` entry in the developer's global config is unreachable too, so a cache root
  owned by another uid fails generation outright instead of being whitelist-able.
