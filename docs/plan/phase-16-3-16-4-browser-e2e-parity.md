# Plan — Phase 16.3 / 16.4 browser E2E parity

Derived from `docs/design/phase-16-3-16-4-browser-e2e-parity.md`.
One branch (`test/browser-e2e-parity`), one worktree, two implementation
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

Each scenario runs in **one** `page.evaluate()` that returns a result keyed
by operation; the test body asserts each slice under its own `test.step()`.
No repo is re-opened per operation (see design §3.1).

## Slice 1 — Split `opfs-roundtrip.spec.ts` into per-operation assertions (16.4)

**File:** `test/browser/opfs-roundtrip.spec.ts` (rewrite).

- Keep the `test.describe('OPFS round-trip')` + `test.skip(webkit)` guard.
- One `evaluate()`: get the OPFS root, write `a.txt`, open the repo, run
  `init` → `add(['a.txt'])` → `commit({ message, author })` → `status()`,
  dispose in a `finally`, return `{ init, add, commit, status }` with each
  operation's return value.
- Test body: four `test.step()`s — `init`, `add`, `commit`, `status` — each
  asserting only its slice:
  1. `init.initialBranch === 'main'` (short name); `init.bare === false`.
  2. `add.added` includes `a.txt`.
  3. `commit.id` matches `/^[0-9a-f]{40}$/`; `commit.branch === 'refs/heads/main'`.
  4. `status.clean === true`; `status.branch === 'refs/heads/main'`;
     `status.indexChanges` and `status.workingTreeChanges` both `[]`.
- Self-declare the `window.__tsgit` typings the rewritten file needs.
- Mutation-resistant assertions: concrete data, not booleans alone (the
  commit-id regex, the exact `refs/heads/main` string, empty-array equality).

**Verify:** `npx playwright test opfs-roundtrip` — passes on chromium +
firefox, skips on webkit.

_Commit:_ `test(browser): split opfs round-trip into per-operation steps`.

## Slice 2 — `surface-parity.spec.ts` + `seedRepo` helper (16.3)

**Files:** `test/browser/fixtures.ts` (add `seedRepo`),
`test/browser/surface-parity.spec.ts` (new). `seedRepo` ships in this commit
alongside its first caller (a lone unused helper is not an atomic commit).

`seedRepo(page): Promise<{ commitId: string; branch: string }>` — one
self-contained `page.evaluate()`: get the OPFS root, write
`a.txt = "hello browser\n"`, `openRepository`, `init` → `add(['a.txt'])` →
`commit`, dispose in a `finally`, return `{ commitId, branch }`. Reuse the
author shape from `opfs-roundtrip.spec.ts`.

`surface-parity.spec.ts` — four `test.describe` blocks, each with the
`test.skip(webkit)` guard and self-declared `window.__tsgit` typings; each
scenario does one `evaluate()` returning a keyed result, asserted per
operation under `test.step()`:

1. **`log`** — `seedRepo(page)`; second `evaluate` writes a distinct `b.txt`
   and `add`+`commit`s it; third `evaluate` re-opens and calls `log()`.
   `test.step`s assert: two entries, reverse-chronological order, messages
   match, newest `parents` contains the older `id`.
2. **`branch`** — `seedRepo(page)`; one `evaluate` re-opens and runs
   `create` → `list` → `delete` → `list`. `test.step`s assert: created ref
   `refs/heads/feature`; first list has `feature` (`current: false`) +
   `main` (`current: true`); delete returns `feature`; second list omits it.
3. **`checkout`** — one `evaluate`: seed `a.txt = "v1"` (init/add/commit),
   create `feature`, checkout it, overwrite `a.txt = "v2"`, add+commit,
   checkout `main` + read `a.txt`, checkout `feature` + read `a.txt`; return
   `{ onMain, onFeature }`. `test.step`s assert `onMain === "v1"`,
   `onFeature === "v2"`.
4. **`tag`** — `seedRepo(page)`; one `evaluate` re-opens and runs `create`
   → `list` → `delete` → `list`. `test.step`s assert: created ref
   `refs/tags/v1`; first list has it; delete returns it; second list omits.

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
| `test/browser/opfs-roundtrip.spec.ts` | rewrite — per-operation steps |
| `test/browser/fixtures.ts` | add `seedRepo` |
| `test/browser/surface-parity.spec.ts` | new |
| `docs/BACKLOG.md` | flip 16.3 / 16.4 |
| `RUNBOOK.md` | refresh browser-test note if needed |
