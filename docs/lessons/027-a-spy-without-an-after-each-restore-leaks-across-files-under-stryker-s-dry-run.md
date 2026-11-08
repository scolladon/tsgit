---
subjects:
  - test/unit/**
  - vitest.stryker.config.ts
  - .claude/workflow/mutation.md
phases: [implementation, validation]
kind: gotcha
trigger: the mutation dry run dies with "There were failed tests in the initial test run" naming a stub's own error while npm run validate is green
evidence:
  - test/unit/application/commands/internal/commit-ish.test.ts
  - vitest.stryker.config.ts
  - .claude/workflow/mutation.md
source: { run: rev-parse-corrupt-input, phase: validation, date: 2026-11-05 }
status: active
supersedes: []
last-verified: 2026-11-08
---
# 027 — A spy without an afterEach restore leaks across files under Stryker's dry run

## Context

Three narrowed Stryker buckets died forty seconds in, each with the same one-word output:
`boom`, the message of a `mockRejectedValue(new Error('boom'))` stub in the commit-ish suite.
`npm run validate` was green on the same tree. `vitest.config.ts` sets `restoreMocks: true`,
but Stryker's vitest runner loads `vitest.stryker.config.ts` and runs every suite of the
bucket in one shared module registry, so a `vi.spyOn(module, 'readObject')` installed by one
file was still live when a later file read an object, and the later file's success rows saw
the first file's rejection. Plain vitest isolates files per worker, which is why the gate
never showed it.

## Lesson

Under a shared module registry a spy on a module export outlives its file. The restore has to
live in the suite that installs the spy; a config-level `restoreMocks` is not applied by the
mutation runner and cannot be relied on.

## How to apply

Every suite that calls `vi.spyOn` gets a top-level `afterEach(() => { vi.restoreAllMocks(); })`.
Reproduce a dry-run death before touching Stryker: `npx vitest run --config <narrowed config> --no-isolate` names the leaking rows.
List the offenders with `grep -L restoreAllMocks` over the suites that `grep -l 'vi.spyOn('` returns for the bucket.
A row that still fails only under `--no-isolate` after the restores is a shared cache, not a spy: check it under the real dry run first.
Commit the restores as a test-only `test(unit)` change; no source changes.

## Evidence

`test/unit/application/commands/internal/commit-ish.test.ts` — the top-level `afterEach` restore above suites that spy on `readObject` and `readRefCandidate` with `mockRejectedValue`.
`vitest.stryker.config.ts` — the runner's config: `include`, `testTimeout` and `env` only, no `restoreMocks`.
`.claude/workflow/mutation.md` — the narrowed-bucket procedure whose dry run runs every suite of a bucket in one registry.
