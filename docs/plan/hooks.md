# Git Hooks — Implementation Plan (Phase 17.2)

> Derived from `docs/design/hooks.md` and ADRs 065–068. TDD throughout:
> Red (failing test) → Green (minimal code) → Refactor. `npm run validate`
> green before every commit. Titles `Given … When … Then …`, AAA bodies,
> `sut`.

## Slice dependency graph

```
S1 (domain + port + config)
   ├─ S2 (runHook primitive)        ┐
   ├─ S3 (Node adapter)             ├─ parallelizable after S1
   └─ S4 (memory adapter)           ┘
S2 + S4 ─ S5 (command integration)
S2 + S3 ─ S6 (facade)
S5 + S6 ─ S7 (docs)
```

Single-agent execution order: S1 → S2 → S3 → S4 → S5 → S6 → S7. Each numbered
step is one atomic commit unless noted.

---

## Slice 1 — Domain, port, config

### Step 1.1 — `HookName` domain type

- **Create** `src/domain/hooks/hook-name.ts` — `export type HookName =
  'pre-commit' | 'commit-msg' | 'pre-push';`. **Create** `src/domain/hooks/index.ts`
  barrel. **Modify** `src/domain/index.ts` to re-export `./hooks/index.js`.
- **Test first:** type alias — no runtime behaviour, no unit test. The
  re-export is exercised transitively by later steps.
- **Verify:** `npm run check:types`, dependency-cruiser (`npm run check` /
  `validate`) — domain stays leaf.

### Step 1.2 — `HOOK_FAILED` error

- **Test first** (`test/unit/domain/commands/error.test.ts` or sibling):
  `hookFailed(hook, code, stderr)` produces `code: 'HOOK_FAILED'` with `hook` /
  `exitCode` carried verbatim; `stderr` is `sanitizeForDisplay`-cleaned; an
  `stderr` of length `MAX_HOOK_STDERR_IN_ERROR + 1` is truncated to the cap.
  `extractDetail` returns `hook <name> failed with exit code <n>`.
- **Implement:** add the `HOOK_FAILED` variant to `CommandError`
  (`src/domain/commands/error.ts`), the `MAX_HOOK_STDERR_IN_ERROR = 4096`
  const, the `hookFailed` factory, and the `extractDetail` arm in
  `src/domain/error.ts`. Import `HookName` from `../hooks/index.js`.
- **Verify:** unit tests green; exhaustiveness `never` check still compiles.

### Step 1.3 — `HookRunner` port + `Context.hooks`

- **Create** `src/ports/hook-runner.ts` — `HookRequest`, `HookResult`,
  `HookRunner` (import `HookName` from domain). **Modify** `src/ports/context.ts`
  — add `hooks?: HookRunner` to `Context` **and** `CreateContextParts`
  (`createContext` already spreads `...parts` — no body change). **Modify**
  `src/ports/index.ts` — export the three hook-runner types.
- **Test first:** type-only — no unit test. `createContext` passing `hooks`
  through is covered by the adapter tests in S3/S4.
- **Verify:** `check:types`, dependency-cruiser (port → domain allowed).

### Step 1.4 — `core.hooksPath` config

- **Test first** (`config-read` test): a `[core]\nhooksPath = …` block yields
  `config.core.hooksPath`; the key is case-insensitive (`HooksPath`);
  `finalize` emits a `core` object when *only* `hooksPath` is present.
- **Implement:** add `hooksPath?: string` to `ParsedConfig.core`; a `hookspath`
  arm in `mergeCore`; the `hooksPath !== undefined` arm in `finalize`'s `core`
  guard and the assembled `out.core`.
- **Verify:** config-read unit tests green.

**Commit:** `feat(domain): HookName, HOOK_FAILED error, HookRunner port` — or
split 1.1–1.3 from 1.4 if cleaner. One slice, ≤2 commits.

---

## Slice 2 — `runHook` primitive

### Step 2.1 — `resolveHooksDir`

- **Test first** (`run-hook` test): `hooksPath` undefined → `${gitDir}/hooks`;
  absolute path → unchanged; `~/x` with `layout.homeDir` → expanded; `~/x`
  without `homeDir` → `${gitDir}/hooks` fallback; relative path → resolved
  under `workDir`. One isolated test per arm (mutation).
- **Implement:** `resolveHooksDir(hooksPath, layout)` pure helper in
  `src/application/primitives/run-hook.ts`.
- **Verify:** unit tests green.

### Step 2.2 — `runHook`

- **Test first:** with a hand-rolled fake `HookRunner` injected on a memory
  `Context`:
  - no `ctx.hooks` → resolves, runner never called.
  - runner returns `{ kind: 'skipped' }` → resolves, no throw.
  - `{ kind: 'ran', exitCode: 0 }` → resolves.
  - `{ kind: 'ran', exitCode: 2, stderr }` → throws `HOOK_FAILED` with
    `exitCode === 2` and the `stderr` (try/catch + `.data` assertions).
  - the `HookRequest` carries the resolved `hooksDir`, `workDir`, `gitDir`,
    forwarded `args` / `stdin`, and `signal` **only** when `ctx.signal` is set.
- **Implement:** `runHook(ctx, name, input?)` per design §6. **Modify**
  `src/application/primitives/index.ts` — export `runHook`.
- **Verify:** unit tests green; `validate`.

**Commit:** `feat(primitives): runHook + resolveHooksDir`

---

## Slice 3 — Node adapter (`NodeHookRunner`)

### Step 3.1 — `NodeHookRunner`

- **Fixtures:** add `test/fixtures/hooks/` scripts with the executable bit
  committed (`git update-index --chmod=+x`): `exit-zero`, `exit-nonzero`,
  `echo-stdin` (copies stdin → stdout), `print-args`, `print-env` (echoes
  `GIT_DIR` + `pwd`), `huge-output` (> 1 MiB), `sleep` (long-running). Plus a
  committed non-executable `not-exec` regular file.
- **Test first** (`test/integration/node/node-hook-runner.test.ts`; the
  exec-bit arm under `test/integration/posix-only/`):
  - absent hook → `{ kind: 'skipped' }`.
  - `not-exec` (regular file, no `+x`) → `skipped` on POSIX.
  - `exit-zero` → `{ kind: 'ran', exitCode: 0 }`.
  - `exit-nonzero` → `ran` with the script's code.
  - `echo-stdin` → `stdout` equals the `stdin` sent.
  - `print-args` → args delivered in order.
  - `print-env` → `GIT_DIR` set, `cwd` is `workDir`.
  - `huge-output` → captured `stdout` length ≤ `MAX_HOOK_OUTPUT_BYTES`.
  - `sleep` + an aborting `AbortSignal` → child killed, `exitCode` non-zero.
- **Implement:** `src/adapters/node/node-hook-runner.ts` per design §8.1
  (`lstat` probe, POSIX exec-bit gate, `spawn`, bounded capture, `signal`
  kill, `error`-event → exitCode 126, `close` → exitCode `code ?? 128`).
- **Verify:** integration tests green on the host.

### Step 3.2 — wire `NodeHookRunner` into `createNodeContext`

- **Test first:** `createNodeContext({ workDir })` → `ctx.hooks` is defined;
  `createNodeContext({ workDir, hooks: false })` → `ctx.hooks` undefined.
- **Implement:** `NodeAdapterOptions.hooks?: boolean` (default `true`);
  conditionally add `hooks: new NodeHookRunner()` to `parts`. **Modify**
  `src/adapters/node/index.ts` — export `NodeHookRunner`.
- **Verify:** unit tests green; `validate`.

**Commit:** `feat(adapters): NodeHookRunner + createNodeContext wiring`

---

## Slice 4 — memory adapter (`MemoryHookRunner`)

### Step 4.1 — `MemoryHookRunner`

- **Test first** (`test/unit/adapters/memory/memory-hook-runner.test.ts`): a
  mapped hook returns its scripted `HookResult`; an unmapped hook returns
  `{ kind: 'skipped' }`; every `run` call appends its `HookRequest` to `calls`.
- **Implement:** `src/adapters/memory/memory-hook-runner.ts` — constructed with
  a `Partial<Record<HookName, HookResult>>` (or empty); `run` looks up `name`
  and pushes the request onto a `calls` array exposed read-only for assertions.
- **Verify:** unit tests green.

### Step 4.2 — wire into `createMemoryContext`

- **Test first:** `createMemoryContext()` → `ctx.hooks` undefined;
  `createMemoryContext({ hooks })` → `ctx.hooks` is the injected runner.
- **Implement:** `MemoryAdapterOptions.hooks?: HookRunner`; conditionally add
  to `parts`. **Modify** `src/adapters/memory/index.ts` — export
  `MemoryHookRunner`.
- **Verify:** unit tests green; `validate`.

**Commit:** `feat(adapters): MemoryHookRunner + createMemoryContext wiring`

---

## Slice 5 — command integration

### Step 5.1 — `commit-hooks.ts` internal helpers

- **Test first** (`test/unit/application/commands/internal/commit-hooks.test.ts`,
  memory ctx + `MemoryHookRunner`):
  - `runPreCommitHook(ctx, true)` → no-op (runner untouched).
  - `runPreCommitHook(ctx, false)` with a failing `pre-commit` → throws
    `HOOK_FAILED`.
  - `applyCommitMsgHook(ctx, msg, { noVerify: true, … })` → returns `msg`,
    `COMMIT_EDITMSG` not written.
  - `applyCommitMsgHook` with no runner → returns `msg` unchanged.
  - with a runner: writes `COMMIT_EDITMSG`, the (test) hook rewrite is
    re-read and re-sanitised; an emptied message → `EMPTY_COMMIT_MESSAGE`
    unless `allowEmptyMessage`.
- **Implement:** `src/application/commands/internal/commit-hooks.ts`.
- **Verify:** unit tests green.

### Step 5.2 — `commit` wiring

- **Test first** (commit integration, memory ctx + `MemoryHookRunner`):
  `pre-commit` exit 0 → commit proceeds; exit ≠ 0 → `HOOK_FAILED`, no commit
  object; `commit-msg` rewrite → commit message + reflog subject reflect it;
  `commit-msg` exit ≠ 0 → abort; `noVerify: true` → both skipped; no runner →
  inert.
- **Implement:** add `noVerify?: boolean` to `CommitOptions`; call
  `runPreCommitHook` after `assertNoPendingOperation` (before `readIndex`);
  replace the message with `applyCommitMsgHook(...)` after the
  `nothingToCommit` guard; thread the result into `commitData` +
  `commitReflogMessage`.
- **Verify:** commit unit + integration tests green.

### Step 5.3 — `push` wiring

- **Test first** (push integration against the `git-http-backend` fixture +
  `MemoryHookRunner`/fixture runner): `pre-push` exit 0 → push proceeds; exit
  ≠ 0 → abort before upload; stdin lines match `<local-ref> <local-oid>
  <remote-ref> <remote-oid>` for update / create / delete refspecs;
  `noVerify: true` → skipped.
- **Implement:** add `noVerify?: boolean` to `PushOptions`; a `push.ts`-local
  `runPrePushHook(ctx, noVerify, remote, url, movers)` building the stdin
  payload; invoke it after the `movers.length === 0` early return, before
  `sendUpdates`.
- **Verify:** push unit + integration tests green; `validate`.

**Commits:** `feat(commit): pre-commit + commit-msg hooks` and
`feat(push): pre-push hook` (5.1 folds into the commit commit).

---

## Slice 6 — facade

### Step 6.1 — `repository.ts`

- **Test first:** `openRepository({ …, hooks: false })` → `ctx.hooks`
  undefined; `openRepository({ …, hooks: customRunner })` → that runner;
  default → `fallback.hooks`. `repo.primitives.runHook` is bound and guarded
  (throws `REPOSITORY_DISPOSED` after dispose).
- **Implement:** `OpenRepositoryOptions.hooks?: HookRunner | false`;
  `RuntimeFallback.hooks?: HookRunner`; resolve
  `hooks = opts.hooks === false ? undefined : (opts.hooks ?? fallback.hooks)`
  and spread into `ctx`; bind `repo.primitives.runHook` + add it to the
  `Repository['primitives']` type.
- **Verify:** repository unit tests green.

### Step 6.2 — `index.node.ts`

- **Test first** (Node integration): `openRepository()` on a repo with a real
  executable `.git/hooks/pre-commit` runs it on `commit`.
- **Implement:** set `fallback.hooks = new NodeHookRunner()` in the Node shim.
- **Verify:** integration test green; `validate`.

**Commit:** `feat(repository): wire HookRunner through the facade`

---

## Slice 7 — docs

- **Modify** `README.md` (hooks section + `noVerify`), `RUNBOOK.md`,
  `CONTRIBUTING.md`, `DESIGN.md`. Flip `docs/design/hooks.md` status to
  *Implemented*. Flip `docs/BACKLOG.md` **17.2** `[ ]` → `[x]` with an
  acceptance summary + ADR links, and update the Progress line.
- **Verify:** `cspell` clean; links resolve.

**Commit:** `docs: git hooks (17.2)`

---

## Post-implementation (workflow steps 6–8)

- **Review ×3** — parallel `code-reviewer` + `security-reviewer` +
  `test-review` + perf pass on the diff; fix every finding each pass.
- **Harness + mutation** — `npm run validate` fully green (incl. 100 %
  coverage); `stryker run` — kill every killable mutant; document provably
  equivalent ones inline with `// equivalent-mutant:`.
- **PR** — push `feat/hooks`; open a PR with summary + test plan. Squash-merge
  on green.

## Risk notes for implementation

- `NodeHookRunner` is the coverage/mutation hot spot — the `error`-event arm,
  the signal-kill arm, and the output cap each need a dedicated fixture and an
  isolated test.
- Fixture hook scripts must carry the executable bit **in git** — verify with
  `git ls-files -s test/fixtures/hooks/` (mode `100755`).
- `createNodeContext` default-on means every existing Node commit/push test now
  resolves hooks; with no hook files present the result is `skipped` — confirm
  no existing integration test regresses.
- Keep `commit.ts` and `push.ts` under the 800-line ceiling — the
  `commit-hooks.ts` extraction and the small `push.ts`-local helper are sized
  for that.
