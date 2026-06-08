# Implementation plan — submodule `add` / `update` (+ `sync --recursive`)

TDD per slice (Red → Green → Refactor), `npm run validate` green before each
commit, one atomic conventional-commit per slice. Mutation kills come from **unit**
tests (interop is skipped under Stryker); interop proves real-git byte-parity.

Faithfulness anchors (all verified against git 2.54 in design/ADRs):
- gitfile `<path>/.git` = `gitdir: ` + (`../`×path-segments) + `.git/modules/<name>`
- core.worktree = (`../`×(2+name-segments)) + `<path>`
- `.gitmodules` keys: `path`, `url`(raw), `branch?` — tab-indented
- super `.git/config` `add` order: `url`(resolved), `active` (no `update`)
- module reflog: `clone: from <url>`; `checkout: moving from <x> to <y>`;
  `branch: Created from origin/<b>`; `rebase (start)/(finish)`

## Slice 1 — `domain/submodule/gitlink-path.ts` (pure path algebra)

**Red** `test/unit/domain/submodule/gitlink-path.test.ts` — GWT/AAA, `sut`:
- `submoduleGitfile('libs/sub','libs/sub')` → `gitdir: ../../.git/modules/libs/sub`
- `submoduleGitfile('custom','vendor/x')` → `gitdir: ../../.git/modules/custom`
- `submoduleCoreWorktree('libs/sub','libs/sub')` → `../../../../libs/sub`
- `submoduleCoreWorktree('custom','vendor/x')` → `../../../vendor/x`
- single-segment name/path (`a`,`a`) → gitfile `gitdir: ../.git/modules/a`,
  core.worktree `../../../a`

**Green** implement both as total functions over `segmentCount` (split `/`).
Re-export from `domain/submodule/index.ts`.

**Properties** `gitlink-path.properties.test.ts` + `arbitraries.ts` (safe-name
generator: 1–4 `/`-joined segments, no `..`/empty/control):
- lens 1 (round-trip): gitfile's `../` count === path segment count; the
  `.git/modules/<name>` tail === name.
- lens 3 (totality): both functions return a string for any safe name/path.
`numRuns` 200 (cheap).

**Commit** `feat(submodule): gitlink path algebra (gitfile + core.worktree)`

## Slice 2 — `materializeWorktreeFromHead` primitive

**Red** `test/unit/application/primitives/materialize-worktree-from-head.test.ts`
(memory adapter; seed a gitdir with HEAD→branch→commit→tree, empty worktree/index):
- worktree files written to match the HEAD tree; module index written (readback).
- HEAD ref unchanged; no new `logs/HEAD` entry (reflog length unchanged).
- empty/absent index tolerated (full materialise).

**Green** `src/application/primitives/materialize-worktree-from-head.ts`:
resolveRef HEAD → readCommit → readTree → `acquireIndexLock` → `materializeTree`
→ `lock.commit(newIndexEntries)`. No ref/reflog write. No bespoke unborn-HEAD
guard — an unborn HEAD surfaces through `resolveRef`'s own error (avoids dead
code). Export from primitives barrel.

**Commit** `feat(submodule): materializeWorktreeFromHead primitive`

## Slice 3 — `deriveSubmoduleCloneContext` (+ shared builder)

**Red** `test/unit/application/primitives/internal/submodule-context.test.ts`
(extend): clone-variant returns a child Context for a **non-existent** gitdir
(no HEAD guard); layout gitDir `${gitDir}/modules/<name>`, workDir
`${workDir}/<path>`, bare:false; transport/config inherited; promisor/hooks dropped.

**Green** refactor `submodule-context.ts`: extract the frozen-child builder shared
by `deriveSubmoduleContext` (keeps HEAD guard) and new
`deriveSubmoduleCloneContext` (no guard). Behaviour-preserving for the existing fn.

**Commit** `feat(submodule): deriveSubmoduleCloneContext for fresh module gitdir`

## Slice 4 — `submoduleAdd` (default branch, no `-b`)

**Red** `test/unit/application/commands/submodule-add.test.ts` (memory adapter +
`buildCloneRemote`-style stub transport serving a 2-commit submodule pack; seed
super with a commit + index + `remote.origin.url`):
- refusals (isolated): unsafe `name`; unsafe `path`; empty `url`; empty `path`;
  `path` already in the super index → INDEX-collision refusal (assert `.data`).
- happy path: `.gitmodules` text = `[submodule "<name>"]\n\tpath = …\n\turl = <raw>`;
  super `.git/config` submodule section `url`(resolved) then `active` (order);
  super index has gitlink `160000 <subHead>` @path **and** `.gitmodules` blob;
  module config `core.worktree` value; `<path>/.git` gitfile value;
  module HEAD on `refs/heads/<remoteHead>`; result `{name,path,url,id,branch}`.

**Green** `submoduleAdd` in `commands/submodule.ts`:
- validate; read super index (tolerate missing); collision check.
- resolve base+url (reuse `resolveBaseUrl`/`resolveSubmoduleUrl`).
- `deriveSubmoduleCloneContext`; `mkdir -p` worktree path; `clone(child,{url})`.
- write `core.worktree` (updateConfigOperations on child); write gitfile.
- `materializeWorktreeFromHead(child)`; `subHead = resolveRef(child,'HEAD')`.
- write `.gitmodules` (read worktree text → `applyConfigOpInText` set branch?/url/path
  in **reverse** for path,url[,branch] order → write back).
- single super-index lock: set gitlink entry (lstat dir → GITLINK mode + subHead)
  + stage `.gitmodules` blob (hash + entry).
- super config ops: `active` then `url` (reverse → file url,active).

**Commit** `feat(submodule): add — clone a new submodule (local default branch)`

## Slice 5 — `submoduleAdd --branch`

**Red** extend submodule-add.test.ts: `branch:'dev'` →
- `.gitmodules` gains `branch = dev` (after path,url);
- module HEAD on `refs/heads/dev`; `refs/heads/dev` reflog `branch: Created from
  origin/dev`; both `branch.main`+`branch.dev` in module config; HEAD reflog
  `checkout: moving from main to dev`; gitlink = dev's commit; result `branch:'dev'`.

**Green** add the `branch` branch to `submoduleAdd`: `createTrackingBranch(child, b)`
(resolve `refs/remotes/origin/<b>` → write `refs/heads/<b>` + recordRefUpdate
`branch: Created from origin/<b>` + branch.<b>.remote/merge) then
`checkout(child,{rev:b})`; append `branch` to `.gitmodules`.

**Commit** `feat(submodule): add --branch — track a named branch`

## Slice 6 — `submoduleUpdate` (checkout mode, init, clone-if-missing, refusals)

**Red** `test/unit/application/commands/submodule-update.test.ts` (memory; seed a
super already carrying a committed gitlink in index + `.gitmodules` + stub
transport):
- refusals (isolated): non-submodule path → PATHSPEC_NO_MATCH; unregistered +
  no `init` → skipped/not-initialised; pinned oid absent from pack →
  OBJECT_NOT_FOUND (assert `.data.id`).
- `init:true` registers config (active,url) then clones.
- clone-if-missing: first call `cloned:true`; module HEAD detached at pinned;
  HEAD reflog `clone: from` + `checkout: moving from <head> to <pinned7>`.
- idempotent re-run: `cloned:false`, `changed:false`, no new reflog.
- result entry `{name,path,id,mode:'checkout',cloned,changed}`.

**Green** `submoduleUpdate`: read rows + selectRows; read super index/HEAD-tree for
the pinned gitlink (`gitlinkOid`); per row register-if-init; clone-if-missing
(derive clone ctx, clone, gitfile+core.worktree+materialize); assert pinned object
present (else OBJECT_NOT_FOUND); checkout-detach when HEAD≠pinned.

**Commit** `feat(submodule): update — checkout mode (clone-if-missing + detached pin)`

## Slice 7 — `submoduleUpdate` rebase / merge / none + `mode` override

**Red** extend submodule-update.test.ts (seed module on a branch diverged from the
pinned oid, both commits in the pack):
- `mode:'rebase'` (or config `update=rebase`) → `rebaseRun(child,{upstream:pinned})`
  applied; stays on branch; reflog `rebase (start)/(finish)`; `changed:true`.
- `mode:'merge'` → `mergeRun(child,{rev:pinned})`; merge applied.
- config `update=none` → skipped (`changed:false`); `mode:'none'` in entry.
- `opts.mode` overrides config (e.g. config none + `mode:'checkout'` → checkout).

**Green** add the mode switch (`opts.mode ?? configMode ?? 'checkout'`) dispatching
to checkout-detach / rebaseRun / mergeRun / skip; surface `mode` + `changed`.

**Commit** `feat(submodule): update — rebase/merge/none modes`

## Slice 8 — `submoduleSync --recursive`

**Red** extend `test/unit/application/commands/submodule*.test.ts` (nested module
fixture): `recursive:true` descends into each checked-out submodule and re-points
its nested submodule url; depth-bounded (`MAX_SUBMODULE_DEPTH`); cycle-guarded;
uninitialised child skipped.

**Green** extend `submoduleSync`: after the existing re-point loop, when
`recursive`, derive each row's child Context (`deriveSubmoduleContext`) and recurse
`submoduleSync(child,{recursive,paths:undefined})` carrying depth+visited.

**Commit** `feat(submodule): sync --recursive descends into checked-out submodules`

## Slice 9 — Namespace + facade + surface gates

- `submodule-namespace.ts`: bind `add`, `update` (guard-then-forward).
- `repository.ts`: `SubmoduleNamespace` doc + types include add/update.
- barrel exports for new option/result types.
- `test/unit/.../repository.test.ts`: submodule namespace key-set includes
  `add`,`update`.
- doc-coverage page for submodule namespace lists add/update; browser scenario
  list notes network verbs node-only (inert in browser, like `clone`).
- regenerate `reports/api.json` (`npm run` doc-typedoc target); commit it.

**Commit** `feat(submodule): bind add/update on the namespace + surface gates`

## Slice 10 — Interop (real git + git-http-backend)

`test/integration/submodule-add-update-interop.test.ts` (skipIf no git-http-backend
/ under Stryker). Boot http-backend over a committed bare submodule fixture +
(for sync) a nested fixture. Twin construction: build identical super starting
state with **real git**, run the verb with git on one twin + tsgit on the other,
byte-compare. Helper `assertSubmoduleParity` diffs: `.gitmodules`,
`git config -f .git/config --get-regexp '^submodule\.'`, `git ls-files -s`,
module `core.worktree`/gitfile, module `HEAD` + `git -C <path> rev-parse HEAD`,
worktree file contents.

- `add` (name=path) parity; `add --name`; `add -b <branch>` parity.
- `update --init` (checkout, detached) parity.
- `update --rebase` + `update --merge` parity (diverged-branch fixture).
- `sync --recursive` parity (nested fixture).

Cross-adapter: network verbs are node-interop-only (memory adapter has no network),
mirroring `clone`.

**Commit** `test(submodule): add/update/sync-recursive interop vs real git`

## Validation gates (every slice)
`npm run validate` green; never `--no-verify`; no ignore directives; no phase/ADR
refs in source/tests. After Slice 10: full `check:types`, `check`, `test:unit`,
`test:coverage`, `build`, then reviews → refactor → mutation → docs/PR.
