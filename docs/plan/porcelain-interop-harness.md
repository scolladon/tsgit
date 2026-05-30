# Plan — git-faithfulness interop harness (write porcelain)

Implements `docs/design/porcelain-interop-harness.md` under ADR-204 (porcelain
as `@writes` surfaces) and ADR-205 (scope = `mv`, `add`, `rm`, `reset`).

## TDD framing for interop characterization tests

These tests pin **already-shipped** porcelain to canonical `git` — there is no
new production logic to write (the only `src/` change is a `@writes` JSDoc per
command). Classic Red→Green therefore applies cleanly only to **Slice 1**, which
introduces the shared harness helpers (a real Red: the test file fails to import
`lsStage`/`writeTreeOf`/`tryRunGit` until they exist).

For Slices 2–4 the helpers already exist, so the loop is:

1. **Write** the interop test.
2. **Run** it (`npx vitest run <file>`). Expected: **passes** and genuinely
   asserts against real git (confirm it is not skipped — git is available — and
   not vacuous). A **failure here is a discovered faithfulness divergence** —
   STOP and surface to the user per the escalation contract (is it a tsgit bug
   to fix in `src/`, or an accepted divergence?). Do not weaken the assertion to
   make it green.
3. **Tag** the command module with `@writes` (flips the audit from
   orphan-coverage → covered) and re-run `npm run validate`.

Each gating test-pyramid heuristic must hold in every new test: GWT titles,
AAA body with section comments, `sut` for the system under test, no
`toThrow(Class)` (assert `.data.code` via try/catch), no empty AAA section.

## Files

Created:

- `test/integration/mv-interop.test.ts`
- `test/integration/add-interop.test.ts`
- `test/integration/rm-interop.test.ts`
- `test/integration/reset-interop.test.ts`

Modified:

- `test/integration/interop-helpers.ts` — add `lsStage`, `writeTreeOf`, `tryRunGit`.
- `src/application/commands/mv.ts` — leading module JSDoc + `@writes surface: mv`.
- `src/application/commands/add.ts` — leading module JSDoc + `@writes surface: add`.
- `src/application/commands/rm.ts` — leading module JSDoc + `@writes surface: rm`.
- `src/application/commands/reset.ts` — leading module JSDoc + `@writes surface: reset`.
- `test/parity/scenarios/mv.scenario.ts` — reword the "verified out-of-band"
  golden comment (now machine-pinned by `mv-interop.test.ts`).

## Dependency graph

```
Slice 1 (mv + harness helpers)  ──┬──> Slice 2 (add)
                                  ├──> Slice 3 (rm)
                                  └──> Slice 4 (reset)
```

Slice 1 must land first (it creates the shared helpers). Slices 2–4 are mutually
independent; executed sequentially in-thread.

---

## Slice 1 — `mv` + harness helpers

**Red.** Write `test/integration/mv-interop.test.ts` per the design's mv matrix
(rename, into-dir, directory-subtree, force, unstaged-edit-travels, three
refusals). It imports `lsStage`, `writeTreeOf`, `tryRunGit` from
`interop-helpers.ts`. Run `npx vitest run test/integration/mv-interop.test.ts`
→ fails: those helpers are not exported yet.

**Green.**
1. Add to `interop-helpers.ts`:
   - `lsStage(dir) = git(dir, 'ls-files', '--stage')`
   - `writeTreeOf(dir) = git(dir, 'write-tree').trim()`
   - `tryRunGit(args, options?)` → `{ ok, stdout, stderr }`, narrowing the
     `execFileSync` failure (`unknown` with `status`/`stdout`/`stderr` buffers);
     reuses `SAFE_ENV`.
2. Add the leading module JSDoc + `@writes surface: mv / kind:
   equivalent-under-readback / format: git-index-tree-state` to `mv.ts`.
3. Re-run the test file → passes.

**Refactor.** Extract per-case `*BothWays` arrange-act helpers in the test for a
clean `sut`. Reword `mv.scenario.ts`'s golden comment: the tree id is now
machine-pinned to canonical git by `mv-interop.test.ts`.

**Verify.** `npm run validate` green; `audit-write-surfaces` reports `mv`
covered (no orphan, no gap).

**Commit:** `test(interop): pin mv porcelain to canonical git mv`.

---

## Slice 2 — `add`

**Write + run.** `test/integration/add-interop.test.ts` per the add matrix
(new file, subdirectory pathspec, re-stage after edit). Run the file → expect
pass against real `git add`; a failure is a divergence → escalate.

**Tag.** Leading module JSDoc + `@writes surface: add` on `add.ts`.

**Verify.** `npm run validate` green; audit reports `add` covered.

**Commit:** `test(interop): pin add porcelain to canonical git add`.

---

## Slice 3 — `rm`

**Write + run.** `test/integration/rm-interop.test.ts` per the rm matrix
(tracked removal, `--cached`, untracked-path refusal). The refusal case uses
`tryRunGit` (git exits non-zero) and try/catch on `repo.rm` asserting
`.data.code === 'PATHSPEC_NO_MATCH'`, plus unchanged `lsStage`. Run → expect
pass; failure → escalate.

**Tag.** Leading module JSDoc + `@writes surface: rm` on `rm.ts`.

**Verify.** `npm run validate` green; audit reports `rm` covered.

**Commit:** `test(interop): pin rm porcelain to canonical git rm`.

---

## Slice 4 — `reset`

**Write + run.** `test/integration/reset-interop.test.ts` per the reset matrix.
Seed two pinned-identity commits (`C0`, `C1`) so SHAs match git's, then reset to
`C0` in `--soft` / `--mixed` / `--hard`, comparing `rev-parse HEAD` ∧ `lsStage` ∧
working tree against `git reset --<mode> <C0>`. Run → expect pass; failure →
escalate.

**Tag.** Leading module JSDoc + `@writes surface: reset` on `reset.ts`.

**Verify.** `npm run validate` green; audit reports `reset` covered;
`reports/write-surface-coverage.json` shows 17 surfaces, 0 gaps, 0 orphan.

**Commit:** `test(interop): pin reset porcelain to canonical git reset`.

---

## Post-implementation (workflow Steps 6–8)

- **Review ×3** — typescript / security / tests on `git diff main...HEAD`.
  Security focus: the harness spawns `git` with `SAFE_ENV` (GIT_* scrubbed);
  confirm `tryRunGit` keeps that discipline and never shells through a string.
- **Mutation** — no new `src/` logic (only JSDoc), so no new mutants; run to
  confirm the suite stays at 0 killable survivors.
- **Docs + PR** — flip `docs/BACKLOG.md` 21.2a `[ ] → [x]`; update
  `CONTRIBUTING.md` (how to add a porcelain interop test) and the relevant
  `docs/understand/` page on the faithfulness harness if present.

## Risks

- **A retrofit test reveals a real divergence.** Most likely in `reset` (most
  state touched) or `mv` force/unstaged-edit paths. Handled by the escalation
  step — surface `{ slice, divergence, ≤3 options }`; do not weaken the test.
- **`git write-tree` rejects tsgit's index** in some state. Mitigation: the
  index byte-format is already git-readable (`index-interop.test.ts`); if
  `write-tree` ever errors, fall back to `lsStage`-only for that case and note
  it (no silent drop).
- **`add` subdir pathspec semantics** differ subtly (e.g. trailing slash).
  Mitigation: mirror the exact pathspec git is given; keep the case literal.
