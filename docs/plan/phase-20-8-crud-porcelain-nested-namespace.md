# Plan — Phase 20.8 CRUD-family porcelain → nested namespace

Design: `docs/design/phase-20-8-crud-porcelain-nested-namespace.md`.
ADRs: 192 (strip-`kind` per-verb results + full split), 193 (hard-remove
callable form), 194 (doc-coverage namespace awareness; browser-surface
deferred).

## Conventions

- TDD per slice: **Red** (rewrite/extend tests, run, watch fail) → **Green**
  (implement) → **Refactor**. `npm run validate` green before each commit.
- Serena symbol tools for source edits; `Read`/`Edit` only for markdown/JSON.
- Per-verb functions mirror `commands/config.ts`; binders mirror
  `commands/internal/config-namespace.ts`. Each per-verb function calls
  `assertRepository` (sparse: `assertSparseReady`) itself, as config does.
- Frozen namespace objects (`Object.freeze`), as `bindConfigNamespace`.

## Slice dependency graph

Slices 1–4 (one family each) are mutually independent — each family is
self-contained, consumed only by `repository.ts`. Slice 5 (audit) is
independent (fixture-tested). Order: remote → branch → tag → sparseCheckout
→ audit. Docs/BACKLOG land in Step 8 (workflow phase 8), not a code slice.

A shared touch-point — `test/unit/repository/repository.test.ts` — flips one
family per slice from the "function binding" branch to the "namespace
object" branch (a `NAMESPACE_KEYS` set that grows by one each slice). By
slice 4, the set is `{config, remote, branch, tag, sparseCheckout}`.

**Call-site sweep rule.** A family's call sites live across several test
files; sequential slices mean each slice must fix **every** `repo.X({ kind })`
/ `X(ctx, { kind })` for its family wherever it appears (a stale call site
fails `check:types`). Before each slice's commit, re-grep
`grep -rn "<family>(.*kind:\|<family>(.*action:" src test` and fix all hits.
Known multi-family files: `test/parity/scenarios/{merge-abort,merge-continue,
merge-ff}.scenario.ts` and `test/integration/{merge-state-machine,
reflog-writers}.test.ts` call `repo.branch`/`repo.tag` and are touched by
slices 2–3.

---

## Slice 1 — `remote` → `repo.remote.*`

Verbs: `list`, `add`, `remove`, `rename`, `setUrl`, `show`.

**Red**

1. Rewrite `test/unit/application/commands/remote.test.ts`: import
   `remoteList`/`remoteAdd`/`remoteRemove`/`remoteRename`/`remoteSetUrl`/
   `remoteShow`; replace `remote(ctx, { kind: 'add', … })` →
   `remoteAdd(ctx, { … })`; assertions drop `.kind` (e.g.
   `expect(sut).toEqual({ remotes: [] })`). Keep every error-data assertion,
   guard-isolation test, and equivalent-mutant annotation. Run
   `npx vitest run test/unit/application/commands/remote.test.ts` → fails
   (new fns don't exist).

**Green**

2. `commands/remote.ts`: delete `RemoteAction`, `RemoteResult`, the
   `remote` dispatcher. Keep `RemoteInfo`, `RemoteShow`, private helpers
   (`toRemoteInfo`, `listTrackingRefs`, `moveTrackingRef`, `compareByteWise`,
   `assertUrlSafe`, `FORBIDDEN_URL_CHARS`). Add per-verb result/input
   interfaces (design §3.1). Convert each `listRemotes`/`addRemote`/… into
   an exported `remoteList(ctx)`/`remoteAdd(ctx, input)`/… that calls
   `assertRepository(ctx)` first and returns the no-`kind` result. Preserve
   the `@writes` JSDoc header verbatim if present.
3. New `commands/internal/remote-namespace.ts`: `RemoteNamespace` +
   `bindRemoteNamespace(ctx, guard)` (frozen object; each method
   `guard()` then forwards). Mirror `config-namespace.ts`.
4. `commands/index.ts`: replace the `remote.js` export block with the
   per-verb fns + input/result types; add
   `export { bindRemoteNamespace, type RemoteNamespace } from
   './internal/remote-namespace.js';`.
5. `repository.ts`: interface — replace
   `readonly remote: BindCtx<typeof commands.remote>;` with
   `readonly remote: commands.RemoteNamespace;`. Binding — replace the
   `remote: ((remoteAction) => …)` block with
   `remote: commands.bindRemoteNamespace(ctx, guard),`.
6. `repository.test.ts`: add `'remote'` to `NAMESPACE_KEYS`; assert
   `sut.remote` is a frozen object of functions (top-level-keys test
   unchanged — `remote` is still a key).
7. Rewrite `test/parity/scenarios/remote-crud.scenario.ts`:
   `repo.remote({ kind: 'add', … })` → `repo.remote.add({ … })`; drop
   `.kind` from the captured result shape + golden type. `commit.id`
   golden unchanged.
8. Run the remote unit test, `repository.test.ts`, and the remote parity
   scenario → green.

**Refactor** — tidy imports/ordering.

**Validate + commit** — `npm run validate`; commit
`feat(remote)!: repo.remote nested namespace`.

---

## Slice 2 — `branch` → `repo.branch.*`

Verbs: `list`, `create`, `delete`, `rename`.

**Red** — rewrite `branch.test.ts` to `branchCreate`/`branchDelete`/
`branchRename`/`branchList`; drop `.kind`. Keep the `compareRefName`
equal-keys unit test (that symbol stays exported). Run → fails.

**Green**

1. `commands/branch.ts`: delete `BranchAction`/`BranchResult`/`branch`
   dispatcher; keep `BranchInfo`, `compareRefName`, `HEADS_PREFIX`,
   `resolveBranchTarget`. Add per-verb types (design §3.2). Export
   `branchList`/`branchCreate`/`branchDelete`/`branchRename` (each
   `assertRepository` first).
2. New `commands/internal/branch-namespace.ts`.
3. `commands/index.ts`: swap the `branch.js` export block + add binder.
4. `repository.ts`: interface + binding for `branch`.
5. `repository.test.ts`: add `'branch'` to `NAMESPACE_KEYS`.
6. Rewrite `test/parity/scenarios/branch-lifecycle.scenario.ts`, the merge
   scenarios that call `repo.branch({ kind })`
   (`merge-abort`/`merge-continue`/`merge-ff`), and `test/browser/
   surface-parity.spec.ts` (the `RepoLike.branch` overloads → namespace
   object; call sites → `repo.branch.create(...)`/`repo.branch.list()`).
7. Update integration tests touching `branch`
   (`test/integration/{merge-state-machine,reflog-writers}.test.ts` + any
   surfaced by the sweep grep). Run affected → green.

**Validate + commit** — `feat(branch)!: repo.branch nested namespace`.

---

## Slice 3 — `tag` → `repo.tag.*`

Verbs: `list`, `create`, `delete`.

**Red** — rewrite `tag.test.ts` to `tagCreate`/`tagDelete`/`tagList`;
drop `.kind`; keep the `EqualityOperator` equivalent-mutant annotation on
the list sort. Run → fails.

**Green**

1. `commands/tag.ts`: delete `TagAction`/`TagResult`/`tag` dispatcher; keep
   `TagInfo`, `TAGS_PREFIX`, `currentHeadId`. Add per-verb types (§3.3);
   export `tagList`/`tagCreate`/`tagDelete`.
2. New `commands/internal/tag-namespace.ts`.
3. `commands/index.ts` swap + binder.
4. `repository.ts` interface + binding.
5. `repository.test.ts`: add `'tag'` to `NAMESPACE_KEYS`.
6. Rewrite `test/browser/surface-parity.spec.ts` `tag` overloads + call
   sites; the merge scenarios / integration tests calling `repo.tag({ kind })`
   surfaced by the sweep grep. Run → green.

**Validate + commit** — `feat(tag)!: repo.tag nested namespace`.

---

## Slice 4 — `sparseCheckout` → `repo.sparseCheckout.*`

Verbs: `list`, `set`, `add`, `reapply`, `disable`. Discriminator was
`action` (input) / `kind` (result) — both removed.

**Red** — rewrite `sparse-checkout.test.ts` to `sparseCheckoutSet`/
`sparseCheckoutAdd`/`sparseCheckoutReapply`/`sparseCheckoutDisable`/
`sparseCheckoutList`; results: `list` → `SparseCheckoutListResult`,
mutators → `SparseCheckoutAppliedResult` (drop `.kind`). Run → fails.

**Green**

1. `commands/sparse-checkout.ts`: delete `SparseCheckoutAction`/
   `SparseCheckoutResult`/`sparseCheckout` dispatcher; keep the private
   helpers (`assertSparseReady`, `specToList`, `applyOpts`,
   `applyAndPersist`, `buildSpecAndText`, `combineSpecAndText`, `toApplied`).
   Add per-verb types (§3.4). Export `sparseCheckoutList`/`…Set`/`…Add`/
   `…Reapply`/`…Disable`; each calls `assertSparseReady(ctx)` first.
   `reapply`/`disable` take optional input; argless must work.
   `toApplied` returns the no-`kind` applied shape.
2. New `commands/internal/sparse-checkout-namespace.ts`.
3. `commands/index.ts` swap + binder.
4. `repository.ts` interface + binding.
5. `repository.test.ts`: add `'sparseCheckout'` to `NAMESPACE_KEYS`.
6. Rewrite `test/parity/scenarios/sparse-checkout.scenario.ts`,
   `test/integration/sparse-checkout.test.ts`,
   `test/integration/sparse-reset-merge.test.ts`. Run → green.

**Validate + commit** —
`feat(sparse-checkout)!: repo.sparseCheckout nested namespace`.

---

## Slice 5 — doc-coverage audit learns namespaces (ADR-194)

**Red** — extend `tooling/test/unit/check-doc-coverage.test.ts`: add a
case asserting `parseRepositoryInterface` captures
`readonly remote: commands.RemoteNamespace;` (and `config`) as a tier-1
command name. Run → fails.

**Green** — in `tooling/check-doc-coverage.ts`, add a namespace regex
(`/^ {2}readonly (\w+):\s*commands\.\w+Namespace/gm`) and union its matches
into the tier-1 command list (dedup; keep `TIER1_SKIP`). Leave
`audit-browser-surface.ts` untouched (deferral). Run unit test → green.

**Validate + commit** —
`feat(harness): doc-coverage audit recognises namespace commands`.

After this slice `check:doc-coverage` re-requires `remote`/`branch`/`tag`/
`sparseCheckout`/`config` pages + rows — all already present, so validate
stays green.

---

## Post-slice gates (workflow Steps 6–8)

- **Review ×3** (typescript / security / tests) on `git diff main...HEAD`.
- **Mutation** — `npm run test:mutation`; kill or annotate survivors per
  touched module.
- **Docs (Step 8)** — rewrite snippets in `docs/use/commands/{remote,branch,
  tag,sparse-checkout}.md`, `docs/use/recipes.md`, `docs/use/errors.md`,
  `docs/get-started/migrate-from-isomorphic-git.md`; scan `README.md`,
  `RUNBOOK.md`, `CONTRIBUTING.md`, `docs/understand/*` for the discriminator
  form. Flip `docs/BACKLOG.md` 20.8 → `[x]`. Add a follow-up BACKLOG item:
  "teach `audit-browser-surface` about namespace commands (config + the
  four)". `gh pr create`.

## Risks / watch-list

- **`check:dead-code` / `check:exports`** — new per-verb fns must be
  consumed (binder) + publicly exported; verify no knip/ts-prune orphan.
- **`check:write-surfaces`** — none of the four command files carry a
  `@writes` header today (writes flow through `updateRef` /
  `updateConfigOperations` primitives, which own the tags); restructuring
  the command files should not perturb the audit. Re-run to confirm.
- **`exactOptionalPropertyTypes`** — `reapply`/`disable` optional input;
  preserve the `applyOpts` force-omission helper.
- **Frozen-object surface test** — `repository.test.ts` "typeof every
  binding" must treat all five namespaces uniformly by slice 4.
