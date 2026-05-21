# Reflog — Implementation Plan (Phase 17.1)

Derived from `docs/design/reflog.md` and ADRs 058–064. TDD throughout: each
step writes the failing test first (RED), the minimal implementation (GREEN),
then refactors. `npm run validate` must pass before each commit.

Six slices. Within a slice, steps are ordered by dependency. Slices 1↔2 are
sequential (2 needs 1); 3, 4, 5 may proceed in parallel once 2 lands; 6 is last.

Conventional-commit subjects are given per step; one commit per step unless
noted. No `Phase`/`ADR`/`§` references in source or test code.

---

## Slice 1 — Domain + port

Pure domain modules and the `appendUtf8` port. No integration; fully
self-contained.

### 1.1 `ZERO_OID` constant

- **Test first:** `ZERO_OID` is a 40-zero `ObjectId`; equals
  `ObjectId.from('0'.repeat(40))`.
- **Implement:** add `ZERO_OID` to `src/domain/objects/object-id.ts`; export
  from `src/domain/objects/index.ts`. Migrate the three inline
  `'0'.repeat(40) as ObjectId` sites (`branch.ts`, `tag.ts`, `fetch.ts`).
- **Verify:** `npm run validate`; the three migrated sites behave unchanged.
- **Commit:** `refactor(domain): add ZERO_OID constant`

### 1.2 Reflog error variants

- **Test first:** each constructor (`invalidReflogEntry`, `reflogNotFound`,
  `reflogEntryOutOfRange`) builds a `TsgitError` with the right `data`;
  `extractDetail` renders each.
- **Implement:** `src/domain/reflog/error.ts` — `ReflogError` union +
  constructors. Add `ReflogError` to `TsgitErrorData` and `extractDetail` arms
  in `src/domain/error.ts`.
- **Verify:** `npm run validate`; exhaustiveness check still compiles.
- **Commit:** `feat(domain): reflog error variants`

### 1.3 Reflog entry + line format

- **Test first:** `serializeReflogLine` ↔ `parseReflogLine` round-trip;
  first-entry `ZERO_OID`; empty message; message with spaces; identity with
  `<>` in name; rejects missing `TAB`, short/non-hex OID, misplaced separator,
  `LF` in message; `parseReflog` multi-line + tolerated trailing blank line.
  Plus a fast-check property test: `parseReflogLine ∘ serializeReflogLine`
  round-trips for arbitrary valid entries.
- **Implement:** `src/domain/reflog/reflog-entry.ts` (`ReflogEntry`),
  `src/domain/reflog/reflog-format.ts` (`serializeReflogLine`,
  `parseReflogLine`, `parseReflog`, `sanitizeReflogMessage`).
- **Verify:** `npm run validate`.
- **Commit:** `feat(domain): reflog entry type and line format`

### 1.4 approxidate parser

- **Test first:** every supported form (`now`, `yesterday`, ISO date/datetime,
  dotted + spaced relative); `.ago` no-op equivalence; `month`/`year`
  approximation pinned; unknown unit / garbage → `undefined`; ISO forms under a
  pinned `TZ`.
- **Implement:** `src/domain/reflog/approxidate.ts` — `parseApproxidate(text,
  now)`.
- **Verify:** `npm run validate`.
- **Commit:** `feat(domain): approxidate date parser`

### 1.5 Logging-gate predicate

- **Test first:** `shouldAutocreateReflog` for every arm — `always`, `false`,
  `true`, unset×bare, unset×non-bare; each default-loggable prefix (`HEAD`,
  `refs/heads/`, `refs/remotes/`, `refs/notes/`); `refs/tags/*` excluded.
  One isolated case per arm (mutation).
- **Implement:** `src/domain/reflog/should-log.ts`.
- **Verify:** `npm run validate`.
- **Commit:** `feat(domain): reflog logging-gate predicate`

### 1.6 Reflog domain barrel

- **Implement:** `src/domain/reflog/index.ts` re-exporting the public surface.
  Fold into 1.5's commit if trivial; otherwise its own
  `chore(domain): reflog barrel`.

### 1.7 `FileSystem.appendUtf8`

- **Test first:** extend `test/unit/ports/file-system.contract.ts` — creates a
  new file, creates parent directories, appends to an existing file, sequential
  appends accumulate. The unit contract runs against the node + memory
  adapters; the browser adapter's method is exercised by `test/browser/`.
- **Implement:** add `appendUtf8` to `src/ports/file-system.ts`; implement in
  the node, memory, and browser adapters.
- **Verify:** `npm run validate`; contract suite green (node + memory).
- **Commit:** `feat(ports): appendUtf8 file-system method`

---

## Slice 2 — Config relocation + store / writer primitives

Depends on Slice 1.

### 2.1 Relocate `config-read`; parse `core.logAllRefUpdates`

- **Test first:** config parsing yields `logAllRefUpdates` as `true` / `false`
  / `'always'` from the matching `logallrefupdates` values; absent → undefined.
- **Implement:** move `src/application/commands/internal/config-read.ts` →
  `src/application/primitives/config-read.ts`; update every importer's path;
  add `logAllRefUpdates?: boolean | 'always'` to `ParsedConfig.core` and the
  `mergeCore` parse arm. Export from the primitives barrel.
- **Verify:** `npm run validate`; dependency-cruiser clean (no
  primitive→command edge).
- **Commit:** `refactor(primitives): relocate config-read, parse core.logAllRefUpdates`

### 2.2 Reflog store

- **Test first:** `appendReflog` creates `.git/logs/` and writes a line;
  `readReflog` of a missing file → `[]`; append-then-read round-trip;
  `writeReflog` whole-file replace; `reflogExists`; `deleteReflog` of a missing
  file is a no-op; `listReflogs` recursion; `MAX_REFLOG_BYTES` guard.
- **Implement:** `src/application/primitives/path-layout.ts` += `logsDir`,
  `reflogPath`; `src/application/primitives/reflog-store.ts` (`appendReflog`,
  `readReflog`, `reflogExists`, `writeReflog`, `deleteReflog`, `listReflogs`).
- **Verify:** `npm run validate` (memory adapter).
- **Commit:** `feat(primitives): reflog store`

### 2.3 Reflog identity resolver

- **Test first:** config `user.*` present → that identity + fresh timestamp;
  `user.*` absent → portable `tsgit <tsgit@localhost>` fallback; never throws.
- **Implement:** `src/application/primitives/reflog-identity.ts`
  (`resolveReflogIdentity`).
- **Verify:** `npm run validate`.
- **Commit:** `feat(primitives): reflog identity resolver`

### 2.4 `recordRefUpdate` writer

- **Test first:** gate open (default-loggable prefix) → entry appended; gate
  closed (`refs/tags/*`, default config) → silent no-op; existing-log arm →
  appends even for a non-default prefix; `logAllRefUpdates=false` → no-op;
  `always` → logs a tag; message sanitised (`CR`/`LF` collapsed); identity
  flows from config.
- **Implement:** `src/application/primitives/record-ref-update.ts`
  (`recordRefUpdate`) — gate via `reflogExists ‖ shouldAutocreateReflog`,
  identity via `resolveReflogIdentity`, append via `appendReflog`.
- **Verify:** `npm run validate`.
- **Commit:** `feat(primitives): recordRefUpdate reflog writer`

### 2.5 `enumerateRefs`

- **Test first:** union of `HEAD`, loose `refs/**`, and packed-refs entries,
  deduplicated; empty repo → `['HEAD']` or `[]` as appropriate.
- **Implement:** `src/application/primitives/enumerate-refs.ts`.
- **Verify:** `npm run validate`.
- **Commit:** `feat(primitives): enumerateRefs`

### 2.6 Primitives barrel

- **Implement:** export `reflog-store`, `record-ref-update`,
  `reflog-identity`, `enumerate-refs` from
  `src/application/primitives/index.ts`. Fold into 2.5's commit if trivial.

---

## Slice 3 — `updateRef` integration + command sites

Depends on Slice 2. The `updateRef` signature change is breaking, so the
primitive change **and** every call site land in **one commit** (the build is
red in between).

`updateRef` callers (verified): `commit.ts`, `branch.ts`, `reset.ts`,
`merge.ts`, `fetch.ts`, `push.ts`, `tag.ts`, plus the `repository.ts` facade
binding. `clone.ts` does **not** use `updateRef` — it writes refs and HEAD
with raw `fs.writeUtf8`, so it is a `recordRefUpdate` site like detached
checkout. Test files calling `updateRef`: `update-ref.test.ts`,
`laws.test.ts`, `merge.test.ts`.

### 3.1 `updateRef` + all callers

- **Test first (primitive):** write logs an entry via `recordRefUpdate`; HEAD
  coupling appends a second entry only when HEAD's symref target equals the
  ref; a detached/other-branch HEAD does not couple; `delete` removes the
  reflog file; isolated guard tests for the `symbolic && target === name`
  condition.
- **Test first (commands):** integration — `commit` ×2 writes
  `.git/logs/HEAD` + `.git/logs/refs/heads/main` with the catalogued messages;
  `branch` create / rename (history preserved) / delete; `checkout` switch +
  detached; `reset`; `merge` fast-forward and clean merge commit; `fetch`;
  `push`; `clone`; `tag` (no entry under default config). Plus an **interop**
  case: a reflog tsgit writes is parsed by canonical `git reflog`, and a
  `git`-written reflog is parsed by `readReflog` (skipped where `git` is
  absent).
- **Implement:**
  - `update-ref.ts` — `UpdateRefOptions` discriminated union (write arm
    requires `reflogMessage`, delete arm does not); capture `oldId`; after a
    write call `recordRefUpdate` for the ref + coupled `HEAD`; on delete call
    `deleteReflog`.
  - Update every `updateRef` caller — `commit.ts`, `branch.ts`, `reset.ts`,
    `merge.ts`, `fetch.ts`, `push.ts`, `tag.ts` — to pass the catalogued
    `reflogMessage`; update the three test files calling `updateRef`.
  - `branch.ts` rename: move the log explicitly (`readReflog` →
    `writeReflog` → `deleteReflog`) before the rename entry.
  - `clone.ts` — call `recordRefUpdate(ctx, <ref>, ZERO_OID, id, 'clone:
    from <url>')` for each ref and the HEAD it writes; the gate decides which
    actually log.
  - `checkout.ts` (switch + detached) and `commit.ts` (detached) — call
    `recordRefUpdate(ctx, 'HEAD', oldOid, newOid, message)` for the HEAD move.
- **Verify:** `npm run validate`; full integration suite green.
- **Commit:** `feat: write a reflog entry on every ref update`

---

## Slice 4 — `reflog` command

Depends on Slice 2. May land in parallel with Slices 3 and 5.

### 4.1 `reflog` command

- **Test first:** `show` newest-first ordering + `selector` strings + default
  `ref`; `show` on an empty/missing log → empty list; `exists`; `delete`
  removes the entry at `index`, `rewrite` repairs the following entry's
  `oldId`, missing log → `REFLOG_NOT_FOUND`, out-of-range → 
  `REFLOG_ENTRY_OUT_OF_RANGE`; `expire` reachable vs. unreachable partition on
  the two cutoffs, `all` across `listReflogs`, unparseable cutoff →
  `REVPARSE_UNRESOLVED`.
- **Implement:** `src/application/commands/reflog.ts` — discriminated
  `ReflogAction`; `expire` builds the reachable set via `enumerateRefs` +
  `walkCommits`. Export from `src/application/commands/index.ts`.
- **Verify:** `npm run validate`.
- **Commit:** `feat(commands): reflog command (show/exists/delete/expire)`

---

## Slice 5 — `@{N}` / `@{date}` in `revParse`

Depends on Slice 2. May land in parallel with Slices 3 and 4.

### 5.1 Grammar — `@{…}` parsing

- **Test first:** `HEAD@{2}`, `main@{0}^`, `@{yesterday}`, bare `@{1}`,
  `HEAD@{2.days.ago}~3`; `@{}` rejected, unbalanced `@{2` rejected;
  digits→`index` vs. text→`date` discrimination.
- **Implement:** `rev-parse-grammar.ts` — `ReflogSelector` type, `reflog`
  field on the `ref-or-hex` `RevExpression`, real `@{…}` parsing replacing the
  `fail` guard.
- **Verify:** `npm run validate`.
- **Commit:** `feat(commands): parse @{N} and @{date} reflog selectors`

### 5.2 Evaluator — reflog base resolution

- **Test first:** `revParse('HEAD@{1}')` after two commits → first commit;
  `main@{0}` → tip; `HEAD@{2}^` chains; `@{date}` against a seeded reflog with
  controlled timestamps (`pickByDate` boundaries — before oldest → `oldId`);
  out-of-range index → `REFLOG_ENTRY_OUT_OF_RANGE`; empty reflog →
  `REVPARSE_UNRESOLVED`; `canonicalizeRef` ladder.
- **Implement:** `rev-parse.ts` — `resolveReflogBase`, `pickByIndex`,
  `pickByDate`, `canonicalizeRef`; thread `now` from a single
  `Date.now()` per call.
- **Verify:** `npm run validate`.
- **Commit:** `feat(commands): resolve <ref>@{N} and @{date} in revParse`

---

## Slice 6 — Facade + docs

Depends on Slices 3–5.

### 6.1 Facade binding

- **Test first:** `repo.reflog` is bound and callable; `repo.primitives`
  exposes `recordRefUpdate`; signatures strip `ctx`.
- **Implement:** `src/repository.ts` — add `reflog` to the `Repository`
  interface + binding; add `recordRefUpdate` to `primitives`. Confirm the
  `reflog` command types reach the public surface via `src/index.ts` (add the
  re-export if not transitive).
- **Verify:** `npm run validate` — incl. `attw` / size-limit on the dist.
- **Commit:** `feat(repository): expose reflog command`

### 6.2 Docs refresh + backlog

- **Implement:** update `README.md` (reflog in the command list + a usage
  snippet), `DESIGN.md` (reflog subsystem), `RUNBOOK.md`, `CONTRIBUTING.md`,
  `MIGRATION.md` (the breaking `updateRef` `reflogMessage` arg + the
  `config-read` import-path move). Flip `docs/BACKLOG.md` **17.1** `[ ]` →
  `[x]` with an acceptance note; correct the stale header line that claims
  Phase 13.x is "next".
- **Verify:** `npm run validate`.
- **Commit:** `docs: reflog`

---

## Post-implementation (workflow steps 6–8)

1. **Review ×3** — parallel `code-reviewer` + `security-reviewer` +
   `test-review` + perf pass over the branch diff; fix every finding each
   round.
2. **Harness + mutation** — `npm run validate` fully green; `stryker run`
   kills every killable mutant (document provably-equivalent ones inline with
   `// equivalent-mutant: <why>`).
3. **Push + PR** — push `feat/reflog`; open a PR with summary + test plan.

## Verification checklist

- [ ] 100% line/branch/function/statement coverage on all new/changed files.
- [ ] 0 surviving mutants (or documented equivalents).
- [ ] `dependency-cruiser` clean — no `primitives → commands` edge after the
      `config-read` move.
- [ ] Interop test: a reflog tsgit writes is read by canonical `git`, and vice
      versa.
- [ ] `MIGRATION.md` documents both breaking changes.
- [ ] No `Phase` / `ADR` / `§` references in `src/` or `test/`.
