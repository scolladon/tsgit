# Plan — Phase 16.3 / 16.4 browser E2E parity

Derived from `docs/design/phase-16-3-16-4-browser-e2e-parity.md`.
One branch (`test/browser-e2e-parity`), one worktree, three implementation
slices. Test-only change — no `src/` touched.

The suite is verified by running it: `npm run test:e2e` (builds `dist/`
first, then Playwright across chromium / firefox / webkit). There is no
"red then green" for E2E specs the way a unit test has — a new spec is
"red" only if the feature is broken. Each slice's verification is therefore
*run the new/changed spec and confirm it passes on chromium + firefox, and
skips cleanly on webkit*.

The harness `index.html` imports the built bundle from `/dist/esm/`. This
change touches no `src/`, so a single `npm run build` (or one
`npm run test:e2e`, which builds via wireit) makes `dist/` current for the
whole branch; per-slice `npx playwright test <file>` runs then reuse it.

## Slice 1 — `seedRepo` helper (`test/browser/fixtures.ts`)

**Why first:** Slice 3 depends on it.

- Add `seedRepo(page: Page): Promise<{ commitId: string; branch: string }>`.
- One self-contained `page.evaluate()`: get the OPFS root, write
  `a.txt = "hello browser\n"`, `openRepository({ rootHandle })`, then
  `init` → `add(['a.txt'])` → `commit({ message, author })`, dispose in a
  `finally`, return `{ commitId, branch }`.
- Reuse the author shape already in `opfs-roundtrip.spec.ts`
  (`{ name, email, timestamp, timezoneOffset: '+0000' }`).

**Verify:** `npm run check:types` clean. A lone unused helper is not an
atomic commit, so `seedRepo` ships in the Slice 3 commit alongside its
first caller.

_Commit:_ folded into Slice 3.

## Slice 2 — Split `opfs-roundtrip.spec.ts` into per-step assertions (16.4)

**File:** `test/browser/opfs-roundtrip.spec.ts` (rewrite).

- Keep the `test.describe('OPFS round-trip')` + `test.skip(webkit)` guard.
- Arrange (plain `evaluate`, not a step): write `a.txt`.
- Four `test.step()` blocks, each one `evaluate()` that re-opens the repo,
  runs one operation, returns its result, disposes:
  1. `init` — assert `initialBranch === 'refs/heads/main'`.
  2. `add` — assert `added` includes `a.txt`.
  3. `commit` — assert `id` matches `/^[0-9a-f]{40}$/`, `branch ===
     'refs/heads/main'`.
  4. `status` — assert `clean === true`, `branch === 'refs/heads/main'`,
     `indexChanges` and `workingTreeChanges` both empty.
- Self-declare the `window.__tsgit` typings the rewritten file needs.
- Apply mutation-resistant assertions: assert concrete data, not booleans
  alone (e.g. the commit id regex, the exact branch ref string).

**Verify:** `npx playwright test opfs-roundtrip` — passes on chromium +
firefox, skips on webkit; intentionally break one step locally to confirm
the failure message names that step, then revert.

_Commit:_ `test(browser): split opfs round-trip into per-step assertions`.

## Slice 3 — `surface-parity.spec.ts` for log / branch / checkout / tag (16.3)

**File:** `test/browser/surface-parity.spec.ts` (new) + `fixtures.ts`
(Slice 1's `seedRepo`).

Four `test.describe` blocks, each with the `test.skip(webkit)` OPFS guard
and self-declared `window.__tsgit` typings:

1. **`log`** — `seedRepo(page)`; second `evaluate` writes a distinct
   `b.txt`, `add`+`commit`s it; third `evaluate` calls `log()`. Assert two
   entries, reverse-chronological order, messages match, newest `parents`
   contains the older `id`.
2. **`branch`** — `seedRepo(page)`; three `test.step`s — `create` (assert
   returned ref `refs/heads/feature`), `list` (assert `feature` present with
   `current: false`, `main` with `current: true`), `delete` + re-`list`
   (assert `feature` gone).
3. **`checkout`** — inline seed (`a.txt = "v1"`, init/add/commit); create
   `feature`, checkout it, overwrite `a.txt = "v2"`, add+commit; `test.step`
   checkout `main` → read `a.txt`, assert `"v1"`; `test.step` checkout
   `feature` → read `a.txt`, assert `"v2"`.
4. **`tag`** — `seedRepo(page)`; three `test.step`s — `create` (assert
   `refs/tags/v1`), `list` (assert present), `delete` + re-`list` (assert
   gone).

**Verify:** `npx playwright test surface-parity` — passes on chromium +
firefox, skips on webkit.

_Commit:_ `test(browser): cover log/branch/checkout/tag against opfs`.

## Verification (workflow steps 6–8)

- Three review passes on the diff (code quality / security / tests).
- `npm run validate` — green (`check:spelling` on docs, `check:filesystem`
  on the new kebab-case spec, plus the harness checks; no `src/` change).
- `npm run test:e2e` — full Playwright matrix green.
- Mutation: no `src/` surface changed — nothing to run.
- Docs: `RUNBOOK.md` browser-test note refreshed if it enumerates specs;
  `docs/BACKLOG.md` — flip **16.3** and **16.4** to `[x]` with `_Accepted:_`
  notes, inside this PR's commits.
- Push `test/browser-e2e-parity`, open PR, squash-merge on green.
- Cleanup: `git worktree remove`, `git branch -D`.

## File summary

| File | Action |
|------|--------|
| `test/browser/fixtures.ts` | add `seedRepo` |
| `test/browser/opfs-roundtrip.spec.ts` | rewrite — per-step |
| `test/browser/surface-parity.spec.ts` | new |
| `docs/BACKLOG.md` | flip 16.3 / 16.4 |
| `RUNBOOK.md` | refresh browser-test note if needed |
