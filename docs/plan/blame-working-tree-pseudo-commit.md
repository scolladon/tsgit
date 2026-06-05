# Plan — `blame` working-tree pseudo-commit

TDD slices, top-to-bottom. Each slice = one atomic commit; `npm run validate`
green before each. Decisions: explicit `worktree: true` opt-in (ADR-270);
discriminated `BlameLine` union (ADR-271). All in `commands/blame.ts` + tests;
the pure `domain/blame/*` core is reused unchanged.

References:
- `seedWorkingTree` algorithm — design §4.
- faithful refusals / gate — design §1.3 + §1.4.
- interop time-scrub — design §7.

---

## Slice 1 — `BlameLine` → committed/uncommitted discriminated union

Behaviour-preserving for committed-rev blame; lays the `committed` discriminator.

**Red.** In `blame.test.ts`, assert the linear-history lines carry
`committed: true` (e.g. `expect(sut.lines.every((l) => l.committed)).toBe(true)`).
Fails to compile (`committed` not on `BlameLine`).

**Green.**
- `commands/blame.ts`: replace `BlameLine` with
  ```ts
  interface BlameLineBase { finalLine; sourceLine; sourcePath; content; previous? }
  export interface CommittedBlameLine extends BlameLineBase {
    committed: true; commit; author; committer; summary; boundary;
  }
  export interface UncommittedBlameLine extends BlameLineBase { committed: false }
  export type BlameLine = CommittedBlameLine | UncommittedBlameLine;
  ```
- `finalize`: add `committed: true` to the pushed object. `Scoreboard.finalized`
  stays `BlameLine[]`.
- Mechanical narrowing of existing committed-rev reads:
  - `blame.test.ts`: where a test reads `l.commit`/`l.author`/`l.summary`/
    `l.boundary`, narrow via `committed`-filter or map with a guard. The
    sort `(a,b) => a.finalLine - b.finalLine` uses base fields — unaffected.
  - `blame-interop.test.ts`: add `const oidOf = (l: BlameLine) => l.committed ? l.commit : ZERO_OID;`
    (import `ZERO_OID`). `isContiguous` → compare `oidOf(a) === oidOf(b)` (+ base
    line fields). `renderPorcelain` header → `oidOf(line)`; `seen` keyed on
    `oidOf`. `metadataBlock(line)` guarded `if (!line.committed) …` — for now a
    `throw` placeholder (no uncommitted lines reach it until slice 4); committed
    branch unchanged.
- `repository.ts` / `commands/index.ts` / `index.ts`: re-export
  `CommittedBlameLine` / `UncommittedBlameLine` alongside `BlameLine`.

**Refactor.** None beyond the rename.

**Validate.** `npm run validate`. Regenerate + stage `reports/api.json`
(`check:doc-typedoc` gate — the `BlameLine` shape changed). Commit:
`refactor(blame)!: split BlameLine into committed/uncommitted union`.

---

## Slice 2 — worktree opt-in: path-in-HEAD attribution

The core feature for a tracked, on-disk file: clean ⇒ all committed; dirty ⇒
uncommitted lines to the pseudo-commit, committed lines to real history.

**Red.** `blame.test.ts`, new `describe('Given a worktree dirtied after commit')`:
1. clean tree + `{ worktree: true }` ≡ `blame(ctx, 'f.txt')` (all `committed:true`,
   same commits) — *equivalence pin*.
2. modify line 2 in the worktree (write workdir, **no** add/commit) →
   `{ worktree: true }`: line 2 is `committed:false` with
   `previous == { commit: HEAD, path }`, `sourceLine === finalLine`,
   `content` = working bytes; lines 1/3 stay `committed:true` at their commits.
3. append line 4 → line 4 is `committed:false`.
4. empty working file → `lines === []`.
5. `{ worktree: true, rev: 'HEAD' }` → rejects `INVALID_OPTION`.
6. `-L` window spanning a committed and an uncommitted line → both returned.

**Green.** `commands/blame.ts`:
- `BlameOptions` gains `readonly worktree?: boolean`.
- `blame`: guard `if (opts.worktree === true && opts.rev !== undefined) throw
  invalidOption('--worktree', 'cannot combine with a revision')`. Dispatch:
  `opts.worktree === true ? seedWorkingTree(board, filePath) : seed(board, …)`.
- `seedWorkingTree(sb, path)` per design §4:
  - `head = await resolveCommitIsh(ctx, 'HEAD')` then `data = await readCommitData`
    (unborn ⇒ `resolveCommitIsh` throws `REF_NOT_FOUND` — the faithful refusal).
  - `workingBlob = await readWorkingFile(ctx, path)`.
  - `count = splitLines(workingBlob).length`; `if (count === 0) return`.
  - `const whole = [{ finalStart: 0, count, sourceStart: 0 }]`.
  - `headBlob = await blobAtPath(ctx, data.tree, path)` (reuse the existing helper:
    blob-or-`undefined`, no re-deriving via `flattenTree`).
  - in-HEAD branch (`headBlob !== undefined`):
    `{ passed, kept } = splitAgainstParent(whole, diffLines(headBlob, workingBlob))`;
    `schedule(sb, head, path, data.committer.timestamp, headBlob, passed)`;
    `finalizeUncommitted(sb, path, workingBlob, kept, { commit: head, path })`.
  - (not-in-HEAD branch → slice 3; for now `throw pathNotInTree('HEAD', path)`).
- `finalizeUncommitted(sb, path, blob, entries, previous?)`: split `blob` once
  (`splitLines`); for each entry, for each offset push an `UncommittedBlameLine`
  (`committed: false`, `finalLine`/`sourceLine` = `*Start + offset + 1`,
  `sourcePath: path`, `previous?`, `content`). Reuse the shared `offsets(count)`.
- `readWorkingFile(ctx, path): Promise<Uint8Array>` — internal helper lifting the
  `compareWorkingTreeDelta` read pattern: `lstat` (absent ⇒ slice-3 refusal; here
  assume present), symlink ⇒ `LINK_ENCODER.encode(readlink)`, else `fs.read`.

**Refactor.** If `finalize` and `finalizeUncommitted` share the per-entry/offset
loop shape, extract a private `pushLines`. Keep ≤20-line functions.

**Validate.** Commit: `feat(blame)!: working-tree blame via worktree opt-in`.

---

## Slice 3 — worktree: staged-new + tracking refusals

Path **not** in HEAD, and the on-disk / unborn refusals.

**Red.** `blame.test.ts`:
1. `git add` a new file (write workdir + `add`, **no commit**) → `{ worktree:true }`:
   every line `committed:false`, **no `previous`**, `sourceLine === finalLine`.
2. untracked file (write workdir, no add) → rejects `PATH_NOT_IN_TREE` (rev `HEAD`).
3. tracked file deleted from disk (commit, then remove workdir file) →
   rejects the new `WORKTREE_FILE_ABSENT`.
4. unborn HEAD + `{ worktree: true }` → rejects `REF_NOT_FOUND` (resolve-first).

**Green.**
- `domain/commands/error.ts`: add `worktreeFileAbsent(path: FilePath)` →
  `{ code: 'WORKTREE_FILE_ABSENT', path }`. `domain/error.ts` message switch:
  `` `cannot read working-tree file '${data.path}'` ``. Add to the error union.
- `readWorkingFile`: on `lstat` undefined ⇒ `throw worktreeFileAbsent(path)`.
- `seedWorkingTree` not-in-HEAD branch:
  `const index = await readIndex(ctx);`
  `if (index.entries.some((e) => e.path === path)) finalizeUncommitted(sb, path,
  workingBlob, whole, undefined); else throw pathNotInTree('HEAD', path);`
  (Resolve HEAD **before** reading the working file so unborn refuses first.)
- `docs/errors.md`: document `WORKTREE_FILE_ABSENT`.

**Validate.** Regenerate `reports/api.json` if the error surface is tracked.
Commit: `feat(blame): worktree staged-new + tracking refusals`.

---

## Slice 4 — interop (dirty tree) + parity

Pin faithfulness on the data; the library emits no porcelain line.

**Red/Green.** `test/integration/blame-interop.test.ts`:
- Extend `metadataBlock` uncommitted branch: emit
  `author Not Committed Yet` / `author-mail <not.committed.yet>` /
  `author-time 0` / `author-tz +0000` / committer-mirror /
  `summary Version of ${line.sourcePath} from ${line.sourcePath}` /
  `previous …` (if set) / `filename ${line.sourcePath}`.
- `scrubNow(s)` normalises the pseudo-commit's four time/tz values (regex anchored
  on the `Not Committed Yet` block) → placeholders; apply to **both** tsgit's
  reconstruction and `git blame --porcelain <file>` (no rev). Build a `worktree`
  repo in `beforeAll`: commit `a\nb\nc\n`, then write `a\nB\nc\nd\n` to disk (no
  add). Cases: modified+appended mix, staged-new (`git add` new file, no commit),
  `-L` over mixed. Assert `scrubNow(renderPorcelain(await blame(ctx,'f.txt',
  {worktree:true})))` `===` `scrubNow(git blame --porcelain f.txt)`.
- `test/parity/scenarios/blame.scenario.ts`: add a worktree-mode step (dirty a
  file, `repo.blame(path, { worktree: true })`) asserted equal across the adapters
  the harness drives. Caveat: if the browser adapter has no workdir, scope the
  worktree step to node+memory (or confirm the harness gives browser a workdir);
  resolve when wiring the scenario — do not force a worktree onto an adapter that
  has none.

**Validate.** Commit: `test(blame): working-tree interop + parity`.

---

## Slice 5 — docs + backlog

- `docs/use/commands/blame.md`: document `worktree` opt-in, the discriminated
  union (`committed` flag, `CommittedBlameLine`/`UncommittedBlameLine`), the
  pseudo-commit semantics + refusals, and that the `Not Committed Yet` rendering is
  the caller's (link ADR-249/270/271).
- `README.md`: if blame is described, note the worktree mode (no command-count
  change — same command).
- `docs/BACKLOG.md`: flip `23.4i` `[ ]` → `[x]` with a one-line outcome + ADR refs.
- `RUNBOOK.md` / `CONTRIBUTING.md`: touch only if blame is referenced.

**Validate.** Commit: `docs(blame): working-tree pseudo-commit + flip 23.4i`.

---

## Review & after (workflow Steps 6–8)

- Reviews ×3 (typescript / security / tests). Security watch: `readWorkingFile`
  path join uses `ctx.layout.workDir` + the validated `FilePath` (no traversal —
  same constraint `status`/`add` rely on); size guard via the shared read path.
- Architecture pass: look for a shared working-file-read helper (`status`/`add`/
  blame now all read a workdir blob) — centralise only if rule-of-three + no
  layer crossing; else justify no-op.
- Mutation: target `commands/blame.ts` + the new error helper; 0 killable.
