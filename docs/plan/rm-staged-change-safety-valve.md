# Plan — `rm` staged-change safety valve

TDD slices, top-to-bottom. Each slice = one atomic commit; `npm run validate`
green before every commit.

## Dependency graph

```
1 atoms ──▶ 2 primitive ──▶ 3 status-migration
                        └──▶ 7 rm-valve ──▶ 8 rm-interop
5 flattenTree-export ───────▶ 7
4 apply-changeset DRY (independent)
6 error codes (folded into 7 — no dead code)
```

Sequential order: 1 → 2 → 3 → 4 → 5 → 7 → 8.

## Slice 1 — extract `deriveWorkingMode` atom

**Files:** `src/application/commands/internal/working-tree.ts` (add export),
`src/application/commands/add.ts` (import it).

- **Red:** in the internal working-tree unit test, assert `deriveWorkingMode`
  maps `isSymbolicLink → '120000'`, `mode & 0o111 → '100755'`, else `'100644'`.
- **Green:** move the inlined derivation out of `add.ts` into `working-tree.ts`;
  `add` imports it. Pure move — `add`'s tests are the safety net.
- **Verify:** `npx vitest run` add + working-tree tests; `npm run validate`.
- **Commit:** `refactor(working-tree): extract deriveWorkingMode atom`

## Slice 2 — `compareWorkingTreeEntry` primitive

**Files:** `src/application/primitives/compare-working-tree-entry.ts` (new),
`src/application/primitives/index.ts` (export), test sibling.

- **Red:** `compare-working-tree-entry.test.ts` — `absent` (no file),
  `unchanged` (same content+mode), `modified` by content, `modified` by mode
  (`chmod +x`, same content), symlink target change, symlink↔regular flip. One
  isolated test per branch.
- **Green:** `compareWorkingTreeEntry(ctx, entry)` — `lstat` (absent on
  miss) → `deriveWorkingMode(stat)`; if `≠ entry.mode` → `modified`; else
  symlink-aware read (`readlink`/`readFile`) → `serializeAndHash` (uncapped) →
  `≠ entry.id ? 'modified' : 'unchanged'`.
- **Verify:** `npm run validate`.
- **Commit:** `feat(primitives): compareWorkingTreeEntry compares content and mode`

## Slice 3 — migrate `status` onto the primitive

**Files:** `src/application/commands/status.ts`, `status.test.ts`.

- **Red:** add a `status` test where a working-tree-only `chmod +x` (content
  unchanged, not staged) is reported `modified` — currently missed.
- **Green:** replace inline `isModified` with `compareWorkingTreeEntry`
  (`absent → deleted`, `modified → modified`, `unchanged → omit`); keep the
  existing skip-worktree guard in `classifyEntry` ahead of the primitive call.
- **Verify:** full `status.test.ts` + any parity scenario using `status` stay
  green; `npm run validate`.
- **Commit:** `refactor(status): consume compareWorkingTreeEntry (mode-aware)`

## Slice 4 — apply-changeset reuses `serializeAndHash` (DRY)

**Files:** `src/application/primitives/apply-changeset.ts`.

- **Green (refactor):** replace `blobMatches`'s inline `blob <size>\0` header +
  `ctx.hash.hashHex` with `serializeAndHash` (behaviour-preserving — uncapped,
  same read, same not-found handling). No new test (existing checkout/merge tests
  cover it).
- **Verify:** checkout + merge + apply-changeset tests green; `npm run validate`.
  If any behaviour shifts, revert this slice and note it in the PR (ADR-209
  boundary already permits skipping).
- **Commit:** `refactor(apply-changeset): reuse serializeAndHash core`

## Slice 5 — promote `flattenTree` to the primitives barrel

**Files:** `src/application/primitives/flatten-tree.ts` (drop `@internal`
"single caller" note), `src/application/primitives/index.ts` (export).

- **Green:** export `flattenTree`. No behaviour change.
- **Verify:** `npm run validate`.
- **Commit:** `refactor(primitives): export flattenTree for rm's HEAD-tree read`

## Slice 7 — rm safety valve (+ `RM_*` codes, `force`)

**Files:** `src/domain/commands/error.ts` (+3 codes, +3 factories),
`src/domain/commands/index.ts` (export), `src/application/commands/rm.ts`,
`src/application/commands/rm.test.ts`.

- **Red:** per-branch `rm.test.ts` (each condition triggered alone):
  - staged-only → `RM_STAGED_CHANGES` (try/catch + `.data.code` + `.data.paths`);
    `--cached` removes; `-f` removes.
  - local-only → `RM_LOCAL_MODIFICATIONS`; `--cached` removes; `-f` removes.
  - both → `RM_STAGED_AND_LOCAL_CHANGES`; `--cached` **still refuses**; `-f` removes.
  - clean → removed (regression guard); work-file-absent + staged → removed.
  - mode-only staged change → `RM_STAGED_CHANGES`.
  - unborn HEAD + staged file → `RM_STAGED_CHANGES`.
  - multi-path multi-bucket → precedence (both wins), nothing removed.
  - every refusal: index + work file unchanged.
- **Green:** add the three `RM_*` codes + factories (introduced with their
  consumer — no dead code); add `force` to `RmOptions`; implement the valve:
  resolve HEAD tree map (`resolveRef`→`readObject`→`flattenTree`; `REF_NOT_FOUND`
  ⇒ ∅), per matched entry `compareWorkingTreeEntry` (skip on `absent`), compute
  `staged`/`local`, bucket honouring per-category `cached` suppression, throw by
  precedence before any mutation; `force` short-circuits the whole valve.
- **Verify:** `npm run validate`.
- **Commit:** `feat(rm): git-faithful staged/local safety valve with force override`

## Slice 8 — rm interop co-refusal parity

**Files:** `test/integration/rm-interop.test.ts`.

- **Red/Green:** add cases comparing `repo.rm` vs `git rm` on staged-only,
  local-only, and both states: assert **both refuse** and index
  (`git ls-files --stage`) + working tree are unchanged and identical. Add
  `--cached`-allows-staged and `-f`-allows-both parity cases. Keep the existing
  "seed via commit" comment for the clean-removal cases.
- **Verify:** `npm run validate` (interop runs under `test:integration`).
- **Commit:** `test(interop): rm safety-valve co-refusal parity with git rm`

## Step 8 (docs) — handled after review/mutation

`docs/use/commands/` rm page (document the valve + `force`/`cached`), `README`
mention if rm options are listed, flip `docs/BACKLOG.md` 21.2c → `[x]`.

## Out of scope (documented, not built)

- `intentToAdd` (`git add -N`) valve special-case (ADR-208/design boundary).
- Migrating `apply-changeset` / `checkout` / `reset` dirty-checks fully onto
  `compareWorkingTreeEntry` (ADR-209 boundary — different compare target;
  follow-up backlog item).
- Working-tree mode fidelity on memory/OPFS (no exec bit — consistent no-op).
