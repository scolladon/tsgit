# Plan — Tier-2 primitive audit (`repo.primitives.*`)

Subtractive pass per ADR-268. Net: `repo.primitives.*` **26 → 21**; `/primitives`
barrel −5 exports. Three feature slices (delete 3, demote 2) + one architecture
slice (Step 7) + a docs/BACKLOG/api.json close. Each slice is one atomic
breaking commit, `npm run validate` green before it lands.

**Validate composition note:** `validate` runs `check:doc-coverage` (forward:
each namespace key needs a page + README row — it does **not** flag orphan
pages), `check:doc-links` (a dangling cross-link is **red**), `check:dead-code`,
`check:exports`, `check:write-surfaces`, `check:browser-surface`,
`check:parity-fixtures`. So every slice must carry its **docs + tests + parity**
changes in the same commit. `check:doc-typedoc` (api.json) is prepush-only →
regenerated once at the close.

---

## Slice 1 — Delete `stageEntry` / `unstageEntry` / `setEntryFlags`

`refactor(primitives)!: drop orphaned index-CRUD verbs`

ADR-268 §Decision 1. Zero command consumers; non-faithful stat; pure plumbing.

**Red (surface-assertion tests first):**
1. `test/unit/repository/repository.test.ts` — remove `stageEntry`,
   `unstageEntry`, `setEntryFlags` from the documented-surface key list (≈L207).
   Run `npx vitest run test/unit/repository/repository.test.ts` → fails (facade
   still binds them).
2. `test/unit/application/primitives/index.test.ts` — remove the three names from
   both export-name lists. Run it → fails (barrel still exports them).

**Green (remove the surface + the dead modules):**
3. `src/repository.ts` — drop the 3 entries from `Repository['primitives']` type
   block and the 3 from `Object.freeze({…})`. (Defer the `(16)`→count comment fix
   to Slice 3, when the final count settles — or set provisional; pick once.)
4. `src/application/primitives/index.ts` — drop the 3 function exports + the type
   exports `StageEntrySource`, `StageEntryOptions`, `UnstageEntryOptions`,
   `SetEntryFlagsOptions`.
5. Delete modules: `src/application/primitives/{stage-entry,unstage-entry,
   set-entry-flags}.ts`.
6. Delete tests: `test/unit/application/primitives/{stage-entry,unstage-entry,
   set-entry-flags}.test.ts`.

**Forced test migrations (same commit):**
7. `test/unit/application/commands/internal/clean-work-tree.test.ts` — replace the
   `setEntryFlags(ctx, 'a.txt', { skipWorktree: true })` arrangement (L8 import,
   L211 call) with a direct index rewrite: read the index, map the `a.txt` entry
   to `{ ...e, flags: { ...e.flags, skipWorktree: true } }`, `writeFramedIndex`.
   Reuse the file's existing `writeFramedIndex` import + local entry builder.
   Behaviour under test (skip-worktree absent file passes clean-work-tree) is
   unchanged.
8. `test/parity/scenarios/phase-20-2-primitives.scenario.ts` — trim to the two
   survivors (`hashBlob`, `isIgnored`): drop result fields
   `stagedPathPresentInIndex`, `stagedEntryStage`, `afterUnstageEntryCount`,
   `skipWorktreeAfterFlagFlip`; drop the `stageEntry`/`setEntryFlags`/
   `unstageEntry` calls in `run`; drop the matching `expected` keys; update the
   header comment's "Surfaces closed" line. Registration in
   `test/parity/scenarios/index.ts` stays (scenario still exists).

**Docs (same commit):**
9. Delete `docs/use/primitives/{stage-entry,unstage-entry,set-entry-flags}.md`.
10. `docs/use/primitives/README.md` — drop the 3 table rows.
11. `grep -rn` the 3 names across `docs/` and fix/remove any cross-link
    (`check:doc-links` gate). Check `errors.md`, `internals.md`, command pages.

**Gate:** `npm run validate` green. Commit.

---

## Slice 2 — Demote `recordRefUpdate` to internal

`refactor(primitives)!: demote recordRefUpdate to internal`

ADR-268 §Decision 2. Footgun (decoupled reflog write); `updateRef` is the
coherent surface. Strip from **both** public surfaces; keep the module (5 direct
importers: `clone`/`checkout`/`commit`/`rebase`/`update-ref`).

**Red:**
1. `repository.test.ts` — remove `recordRefUpdate` from the key list **and**
   delete the bound-`recordRefUpdate` behaviour test (`describe('When the bound
   recordRefUpdate primitive is called', …)`, ≈L614). Run → fails.
2. `index.test.ts` (barrel) — remove `recordRefUpdate` from both lists. Run →
   fails.

**Green:**
3. `src/repository.ts` — drop the `recordRefUpdate` type entry + binding.
4. `src/application/primitives/index.ts` — drop `export { recordRefUpdate }`
   (L50). Module file stays; the 5 consumers import it by direct path — verify
   with `grep -rn "primitives/index.*recordRefUpdate\|from '.*record-ref-update'"`
   that no consumer used the barrel path.

**Docs (same commit):**
5. Delete `docs/use/primitives/record-ref-update.md`.
6. `docs/use/primitives/README.md` — drop the `recordRefUpdate` row.
7. `internals.md` — add a one-line entry documenting `record-ref-update.ts` as
   the internal reflog-writer mechanism (it already documents `reflog-store.ts`
   "Called via recordRefUpdate" — keep that coherent; recordRefUpdate is now an
   internal alongside it).
8. Fix cross-links: `create-commit.md` ("pair with updateRef or recordRefUpdate"
   → drop the recordRefUpdate link, keep updateRef), `update-ref.md` ("Convenience
   wrapper around recordRefUpdate" → reword to describe what it does without the
   dead link). `check:doc-links` is the gate.

**Gate:** `npm run validate` green. Commit.

---

## Slice 3 — Demote `writeSymbolicRef` to internal

`refactor(primitives)!: demote writeSymbolicRef to internal`

ADR-268 §Decision 3. Symref-backend mechanism, largely porcelain-reachable. Strip
from both surfaces; keep the module (3 direct importers:
`checkout`/`branch`/`rebase`).

**Red:**
1. `repository.test.ts` — remove `writeSymbolicRef` from the key list. Run →
   fails.
2. `index.test.ts` (barrel) — remove `writeSymbolicRef` from both lists. Run →
   fails.

**Green:**
3. `src/repository.ts` — drop the `writeSymbolicRef` type entry + binding; **fix
   the stale `Tier-2 primitives (16)` comment to `(21)`** (final count settles
   here).
4. `src/application/primitives/index.ts` — drop `export { writeSymbolicRef }`
   (L92). Module stays; verify no barrel-path consumer.

**Docs (same commit):**
5. Delete `docs/use/primitives/write-symbolic-ref.md`.
6. `docs/use/primitives/README.md` — drop the `writeSymbolicRef` row.
7. `internals.md` — add a one-line entry documenting `write-symbolic-ref.ts` as
   the internal symref-writer mechanism.
8. Fix any remaining cross-links to `write-symbolic-ref.md`.

**Gate:** `npm run validate` green. Commit.

---

## Slice 4 — (Step 7 architecture, **after** the Step 6 reviews) Collapse `AcquireOptions.breakStaleLockMs`

`refactor(index-lock): drop dead per-call breakStaleLockMs override`

Lands after the three scoped reviews (Step 6) and before mutation (Step 8), per
the workflow order. Seeded by Slice 1: the deleted verbs were the **only** callers passing an
explicit `breakStaleLockMs` to `acquireIndexLock`; with them gone the
`opts.breakStaleLockMs ?? ctx.config?.breakStaleLockMs` has no `opts` branch left
to exercise. Behaviour-preserving (every live caller already relies on
`ctx.config`).

**Steps:**
1. `src/application/primitives/internal/index-lock.ts` — remove
   `breakStaleLockMs` from `AcquireOptions`; collapse the read to
   `ctx.config?.breakStaleLockMs`. Keep `now` (the clock test-seam).
2. `npx vitest run` the `index-lock` test — remove the per-call-override case
   (now unreachable); keep the `config`-set and `config`-unset cases so the
   `ctx.config?.…` line stays mutation-covered. If the override case is the only
   one exercising a branch, add an isolated set/unset pair.
3. Verify no other caller passed the option (`grep -rn "breakStaleLockMs" src`).

**Gate:** `npm run validate` green. Commit. (Runs **before** mutation, Step 8.)

---

## Reviews (Step 6) — scoped to `git diff main...HEAD`

1. **TypeScript** — every internal consumer compiles against the smaller surface
   (`check:types` is the completeness oracle); no `any`; immutability intact.
2. **Security** — none expected (pure removal); confirm no validation path was
   the *only* one removed (the demoted writers keep their `validateRefName` /
   sanitise paths verbatim).
3. **Tests** — surface-assertion tests match the 21-key shape; the migrated
   `clean-work-tree` + trimmed parity scenario assert the same behaviour;
   module-level tests for the two demoted writers stay (their behaviour is
   unchanged and still covered).

## Mutation (Step 8)

Re-run scoped to the touched files (`record-ref-update.ts`,
`write-symbolic-ref.ts`, `internal/index-lock.ts`). Deleting 3 modules **reduces**
the mutated surface. 0 killable survivors; no new suppressions.

## Close (Step 9)

- `docs/BACKLOG.md` — flip `[ ] **23.4g**` → `[x]` with the outcome summary +
  ADR-268 + design-doc reference.
- `README.md` — the headline "33 Tier-1 commands · 20+ … primitives" count is a
  fuzzy "20+"; 21 still satisfies it — leave unless it states an exact total.
- `RUNBOOK.md` / `CONTRIBUTING.md` — scan for any primitive-surface reference to
  the 5 removed names; update if present.
- Regenerate `reports/api.json` (`npm run check:doc-typedoc` or the json script);
  commit (`docs(api): regenerate after primitive-tier2-audit`). Large typedoc-id
  reshuffle is normal.
- Push `-u origin`; `gh pr create`.

## Risk register

- **Barrel-path consumer of a demoted writer** — mitigated by the per-slice grep
  (commands import by direct module path, verified pre-flight).
- **`check:write-surfaces`** — `write-symbolic-ref.ts` carries a `@writes`
  annotation; the audit tracks *modules*, not barrel exports, so demotion
  (module kept) leaves it satisfied. Verify green; do not delete the annotation.
- **`check:dead-code`** — the two demoted modules stay *used* (direct imports), so
  no dead-export flag. The collapsed lock field is read in-body, not flagged.
- **doc-coverage allowlist** — if `tooling` keeps a primitives allowlist, confirm
  none of the 5 removed names linger in it (would be stale, not failing).
