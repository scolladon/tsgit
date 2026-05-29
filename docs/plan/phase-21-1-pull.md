# Phase 21.1 — `pull` — implementation plan

TDD, one atomic conventional-commit per slice. `npm run validate` green before
every commit. Slices are ordered by dependency; each lists Red → Green →
Verify. References: `docs/design/phase-21-1-pull.md`, ADRs 196–199.

## Dependency graph

```
S0 ref-candidates ──▶ S1 merge.resolveTarget ─┐
                                              ├─▶ S5 pull ──▶ S6 integration
S2 merge.reflogLabel ─────────────────────────┤
S3 NO_UPSTREAM_CONFIGURED ─────────────────────┤
S4 clone upstream config ──────────────────────┘
```

S0→S1 are sequential (same engine + new helper). S2/S3/S4 are independent of
each other and of S1; run in listed order to keep merge.ts edits serialized.
S5 depends on S2+S3+S4 (and reuses S1 transitively). S6 depends on S4+S5.

---

## S0 — shared `ref-candidates` ladder (extract from rev-parse)

**Files**: `src/domain/refs/ref-candidates.ts` (new),
`src/domain/refs/index.ts` (export), `src/application/commands/rev-parse.ts`
(import + drop private const), `test/unit/domain/refs/ref-candidates.test.ts` (new).

- **Red**: `ref-candidates.test.ts` — Given a base `'main'`, When `refCandidates('main')`,
  Then `['main','refs/heads/main','refs/tags/main','refs/remotes/main']` in
  order. Add a `'origin/main'` case asserting `'refs/remotes/origin/main'` is
  present. Run: fails (module absent).
- **Green**: create `ref-candidates.ts`:
  ```ts
  export const refCandidates = (base: string): ReadonlyArray<RefName | 'HEAD'> => [
    base as RefName,
    `refs/heads/${base}` as RefName,
    `refs/tags/${base}` as RefName,
    `refs/remotes/${base}` as RefName,
  ];
  ```
  Export from `domain/refs/index.ts`.
- **Refactor**: in `rev-parse.ts`, delete the private `refCandidates` const and
  import the shared one. Behaviour identical.
- **Verify**: `npx vitest run test/unit/domain/refs/ref-candidates.test.ts test/unit/application/commands/rev-parse.test.ts` green; `npm run validate`.
- **Commit**: `refactor(refs): extract ref-candidates ladder shared by rev-parse`.

## S1 — broaden `merge.resolveTarget` to ref-DWIM + peel (ADR-199)

**Files**: `src/application/commands/merge.ts`,
`test/unit/application/commands/merge.test.ts`.

- **Red**: in `merge.test.ts`, add a `describe('resolveTarget')` block:
  - Given a `refs/remotes/origin/main` ref → commit C, When
    `resolveTarget(ctx,'origin/main')`, Then returns C. (Arrange: init+commit→C,
    `updateRef(ctx,'refs/remotes/origin/main',C)`.)
  - Given an annotated tag `v1` → commit C, When `resolveTarget(ctx,'v1')`, Then
    returns C (peel). (Arrange: `tagCreate` annotated.)
  - Given a bare branch `feature` → commit, When `resolveTarget(ctx,'feature')`,
    Then resolves `refs/heads/feature` (regression-pin).
  - Given an unknown name, When `resolveTarget`, Then throws with
    `.data.code === 'REF_NOT_FOUND'` (try/catch + `.data`).
  Run: the `origin/main` + tag cases fail (current impl only tries refs/heads).
- **Green**: rewrite `resolveTarget`:
  ```ts
  export const resolveTarget = async (ctx, target) => {
    if (/^[0-9a-f]{40}$/.test(target)) return target as ObjectId;
    for (const candidate of refCandidates(target)) {
      try { return await resolveRef(ctx, candidate, { peel: true }); }
      catch { /* next */ }
    }
    throw refNotFound(target as RefName);
  };
  ```
  Import `refCandidates` (domain/refs) + `refNotFound` (domain/refs/error).
- **Verify**: full `merge.test.ts` green (existing bare-name/OID cases unchanged); `npm run validate`.
- **Commit**: `feat(merge): resolve target via gitrevisions ref-DWIM`.

## S2 — `merge.reflogLabel` (ADR-197)

**Files**: `src/application/commands/merge.ts`, `merge.test.ts`.

- **Red**: in `merge.test.ts`:
  - default omitted → after FF, `readReflog(ctx,'refs/heads/main')[0].message` ===
    `merge feature: Fast-forward` (pin existing).
  - `reflogLabel:'pull'` over an FF → message === `pull: Fast-forward`.
  - `reflogLabel:'pull'` over a `noFastForward` merge commit → message ===
    `pull: Merge made by the 'tsgit' strategy.`.
  (Two isolated tests for the two substitution sites.) Run: label cases fail.
- **Green**: add `readonly reflogLabel?: string;` to `MergeOptions`. At both
  reflog sites replace `` `merge ${opts.target}` `` with
  `` opts.reflogLabel ?? `merge ${opts.target}` ``:
  - FF: `` `${opts.reflogLabel ?? `merge ${opts.target}`}: Fast-forward` ``
  - merge: `` `${opts.reflogLabel ?? `merge ${opts.target}`}: Merge made by the 'tsgit' strategy.` ``
- **Verify**: `merge.test.ts` green; `npm run validate`.
- **Commit**: `feat(merge): optional reflogLabel overrides the reflog action prefix`.

## S3 — `NO_UPSTREAM_CONFIGURED` domain error

**Files**: `src/domain/commands/error.ts`, error test (existing
`test/unit/domain/commands/error.test.ts` if present, else new focused test),
plus any exhaustive code→message switch the compiler flags.

- **Red**: test the factory — `noUpstreamConfigured(RefName.from('refs/heads/x')).data`
  deep-equals `{ code:'NO_UPSTREAM_CONFIGURED', branch:'refs/heads/x' }`. Run: fails.
- **Green**: add union member
  `| { readonly code:'NO_UPSTREAM_CONFIGURED'; readonly branch: RefName }` and
  `export const noUpstreamConfigured = (branch: RefName): TsgitError => new TsgitError({ code:'NO_UPSTREAM_CONFIGURED', branch });`.
  Handle the new code in any exhaustive display/message switch (TS `check:types`
  will surface it).
- **Verify**: `npm run check:types` + the error test green; `npm run validate`.
- **Commit**: `feat(domain): NO_UPSTREAM_CONFIGURED error`.

## S4 — `clone` writes remote + upstream tracking config (ADR-196)

**Files**: `src/application/commands/clone.ts`,
`test/unit/application/commands/clone.test.ts`.

- **Red**: in `clone.test.ts` (uses `readConfig`):
  - normal clone → `config.remote.get('origin').url === REMOTE_URL`,
    `…fetch === '+refs/heads/*:refs/remotes/origin/*'`,
    `config.branch.get('main') === { remote:'origin', merge:'refs/heads/main' }`.
  - partial clone (`filter:'blob:none'`) → the above PLUS `promisor`,
    `partialCloneFilter`, `extensions.partialClone==='origin'`,
    `core.repositoryformatversion==='1'` (regression-pin the subsumed path).
  - detached clone (advertisement with no `symref=HEAD:` cap) → remote block
    present, `config.branch === undefined` (no `[branch …]`).
  Run: normal-clone assertions fail (no remote config written today).
- **Green**: replace `writePromisorConfig` with `writeCloneConfig(ctx, { url, headBranch, filterSpec })`:
  always write `remote.origin.url` + `remote.origin.fetch`; when `headBranch`
  defined add `branch.<head>.remote=origin` + `merge=refs/heads/<head>`; when
  `filterSpec` defined add the partial-clone entries (incl. version=1). Call it
  unconditionally in `fetchAndPropagate` after `applyRemoteHead`, passing the
  `headTrackedBranch(advertisement)` value.
- **Verify**: `clone.test.ts` + clone http-backend integration green; `npm run validate`.
- **Commit**: `feat(clone): write remote + upstream tracking config for all clones`.

## S5 — `pull` command + facade wiring (ADRs 196,197,198)

**Files**: `src/application/commands/pull.ts` (new),
`src/application/commands/index.ts`, `src/repository.ts`,
`test/unit/application/commands/pull.test.ts` (new),
`test/unit/repository/repository.test.ts` (key-list).

- **Red**: `pull.test.ts` (memory ctx + inline fake transport: advertisement for
  `info/refs`, `buildSyntheticPack(ctx,[])` empty pack otherwise; seed
  `remote.origin.url` + upstream via `remoteAdd`/config primitives; build graphs
  with real commands per design §9.1):
  1. fast-forward → `merge.kind==='fast-forward'`, branch advanced, reflog
     `pull: Fast-forward`, `fetch.updatedRefs` reflects origin/main.
  2. up-to-date → `merge.kind==='up-to-date'`.
  3. true merge (diverged distinct files) → `merge.kind==='merge'`, 2 parents,
     commit message `Merge branch 'main' of <url>`, reflog
     `pull: Merge made by the 'tsgit' strategy.`.
  4. conflict (diverged same file) → `merge.kind==='conflict'`, MERGE_HEAD/
     MERGE_MSG/ORIG_HEAD present, conflicted index; then `abortMerge` restores
     ORIG_HEAD (composition assertion).
  5. resolution: explicit `{remote,branch}` honoured; defaults from
     `branch.main.remote`/`merge`; remote falls back to `'origin'` when only
     `merge` set.
  6. `NO_UPSTREAM_CONFIGURED` — isolated arms: (a) no opts + no upstream config;
     (b) detached HEAD + no `opts.branch`. try/catch + `.data.code`+`.branch`.
  7. guards (isolated): bare repo → throws, no fetch issued (assert transport
     unused); MERGE_HEAD present → `OPERATION_IN_PROGRESS`; remote lacks branch
     → `REF_NOT_FOUND`.
  8. `fastForwardOnly` over divergence → `NON_FAST_FORWARD` (`.data` code+refs).
  9. `message` override flows to the merge commit / MERGE_MSG.
  10. result shape: both `fetch` + `merge` surfaced.
  Run: fails (pull absent).
- **Green**: implement `pull.ts` per design §3–§4:
  guards (`assertRepository`,`assertNotBare(ctx,'pull')`,`assertNoPendingOperation`)
  → `readHeadRaw` → `resolveUpstream(config,currentBranch,opts)` helper returning
  `{remote,branch}` or throwing `noUpstreamConfigured` → `fetch(ctx,{remote,…prune?,…depth?})`
  → `resolveRef('refs/remotes/<remote>/<branch>')` → `merge(ctx,{ target, message:
  opts.message ?? \`Merge branch '<branch>' of <url>\`, reflogLabel:'pull',
  …ff/noff/author/committer })` → `{ fetch, merge }`. Conditional spreads for
  every optional (`exactOptionalPropertyTypes`). Small functions / early returns;
  extract `shortName` + `resolveUpstream`.
  Then export from `index.ts`, add `readonly pull: BindCtx<typeof commands.pull>`
  + guarded binding in `repository.ts`, and add `'pull'` to the sorted key list
  in `repository.test.ts`.
- **Verify**: `pull.test.ts` + `repository.test.ts` + `api-surface` green; `npm run validate`.
- **Commit**: `feat(pull): fetch + merge porcelain on repo.*`.

## S6 — integration: pull over real git http-backend

**Files**: `test/integration/network/pull-http-backend.test.ts` (new),
mirroring `clone-http-backend.test.ts` / `fetch-http-backend.test.ts` harness.

- **Red/Green** (integration, no production change):
  - clone a seeded source via the http-backend; advance the source; `repo.pull()`
    (no args, upstream from clone) → fast-forward; assert HEAD/branch advanced
    (ref/commit-level) and `fetch.updatedRefs` present. **Not** workdir-file
    content — `merge` does not materialise the worktree on FF (design §4.3); pull
    inherits that contract.
  - diverge: local commit + source commit on same path; `pull()` → `conflict`
    (merge **does** write conflict markers to the worktree); resolve markers +
    `add` + `continueMerge` produces the 2-parent merge commit (end-to-end proof
    fetch + the 20.4 state machine compose); separately, `abortMerge` restores
    ORIG_HEAD.
- **Verify**: `npx vitest run test/integration/network/pull-http-backend.test.ts`; `npm run validate`.
- **Commit**: `test(pull): http-backend integration — ff + conflict compose with merge state machine`.

---

## Post-slice (Steps 6–8 of the workflow)

- Review ×3 (typescript / security / tests) on `git diff main...HEAD`, fix-all-converge.
- `npm run test:mutation`; kill survivors or annotate `// equivalent-mutant: <why>`.
- Docs: `README.md` (command list / capabilities), `RUNBOOK.md`,
  `CONTRIBUTING.md` if commands enumerated, `docs/use/` pull page,
  `docs/understand/` if architecture pages list commands; flip BACKLOG 21.1
  `[ ]`→`[x]`. Browser-surface / doc-coverage audits (`check:write-surfaces`,
  doc-coverage): register `pull` so the namespace-aware audits stay green.
- Push `-u origin feat/pull`; `gh pr create`.
