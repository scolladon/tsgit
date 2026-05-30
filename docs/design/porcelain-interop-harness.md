# Design — git-faithfulness interop harness (write porcelain)

## Goal

Extend the `cross-tool-interop` suite so it asserts **write porcelain**
(`repo.mv`, …) against canonical `git`, not just the low-level format
primitives. Today every `@writes` byte-format (commit object, index DIRC, loose
ref, packfile, …) is pinned to real git by a `*-interop.test.ts`. Composite
porcelain commands — which **compose** those primitives rather than defining a
new on-disk format — are only pinned **cross-adapter** (Node ≡ Memory ≡
Browser). The parity golden is tsgit-computed, so a divergence from canonical
git can ship undetected.

`mv` surfaced the gap. `test/parity/scenarios/mv.scenario.ts` locks a
40-hex commit id across adapters and tags it `verified out-of-band` — a human
checked it once against git; nothing re-checks it on every run.

Headline invariant added: **for every covered porcelain command, the resulting
repository state (index + tree + working tree) is byte-faithful to running the
same operation under canonical `git`.**

## Scope

In scope:

- A reusable **porcelain interop harness** in `test/integration/interop-helpers.ts`:
  read-back helpers (`lsStage`, `writeTreeOf`) and a non-throwing git runner
  (`tryRunGit`) for co-refusal assertions.
- Four `<cmd>-interop.test.ts` files pinning the most-used state-mutating
  porcelain to canonical `git` (ADR-205): **`mv`**, **`add`**, **`rm`**,
  **`reset`**.
- Make porcelain faithfulness **machine-tracked** by the write-surface audit:
  declare each command as a `@writes` surface so `audit-write-surfaces` reports
  it covered (not orphan) — see ADR-204.
- Reword the `mv.scenario.ts` golden comment: the tree id is now machine-pinned
  to canonical git by the interop sibling, not "verified out-of-band".

Out of scope (future, same pattern):

- `commit` — already pinned (`commit-message-interop.test.ts`).
- `stash` (21.3) and history-rewriting porcelain (22.x) — adopt the same pattern
  when they land.
- Network porcelain (`clone`/`fetch`/`pull`/`push`) — covered by the
  `network/*-http-backend.test.ts` suite, a different bucket.
- `index-interop.test.ts` is **not** retargeted: it remains the `index` byte-format
  proof (it uses `add` as a vehicle, but `add`'s command behaviour gets its own
  test).

## The cross-tool readback technique

The load-bearing trick (already proven by `index-interop.test.ts`): tsgit writes
a **real** `.git/index`, so canonical `git` can read it back. We never compare
raw index bytes (stat-cache fields mtime/ctime/dev/ino are per-host); we compare
git's **readback** of each side:

| Readback | Command | Proves |
|---|---|---|
| Index entries | `git ls-files --stage` | mode · blob id · stage · path |
| Resulting tree | `git write-tree` | the index materialises to git's tree |
| Working tree | `fs` read of dest + absence of source | the file physically moved |

`git write-tree` on the tsgit side reads tsgit's index and emits a tree object;
equality of the two tree ids is the canonical, stat-independent faithfulness
proof. `ls-files --stage` is the granular diagnostic (a failure points at the
exact diverging entry without needing a commit).

## Harness — `interop-helpers.ts` additions

```ts
/** `git ls-files --stage` — host-independent (mode sha stage\tpath) listing. */
export const lsStage = (dir: string): string => git(dir, 'ls-files', '--stage');

/** `git write-tree` — materialise the index to a tree id (reads tsgit's index). */
export const writeTreeOf = (dir: string): string => git(dir, 'write-tree').trim();

export interface GitRunResult {
  readonly ok: boolean;
  readonly stdout: string;
  readonly stderr: string;
}

/** Run git without throwing on non-zero exit — for co-refusal assertions. */
export const tryRunGit = (
  args: ReadonlyArray<string>,
  options?: { readonly env?: NodeJS.ProcessEnv },
): GitRunResult;
```

`tryRunGit` narrows the `execFileSync` failure (an `unknown` error carrying
`status`/`stdout`/`stderr`) into a typed result. No new isolation surface —
it reuses the same `SAFE_ENV` scrubbing as `runGit`.

The peer/ours pair is the existing `makePeerPair` + `initBothRepos`; the tsgit
side is driven through the **porcelain facade** `openRepository({ cwd: ours })`
(as `commit-message-interop.test.ts` does), never the primitives.

## Test matrix — `mv-interop.test.ts`

Each case seeds identical files **staged** on both sides (`git add` peer /
`repo.add` ours — `git mv` operates on the index, so no seed commit is needed),
runs the move both ways, then compares.

> The three retrofit matrices (`add` / `rm` / `reset`) follow this same
> seed-both-ways-then-compare shape and live in their own files; see below.

Happy paths (assert `lsStage` equal ∧ `writeTreeOf` equal ∧ worktree ∧ the
porcelain `moved` report):

1. **Rename** — `mv(['a.txt'], 'renamed.txt')` vs `git mv a.txt renamed.txt`.
2. **Move into existing directory** — `mv(['b.txt'], 'dir')` reparents to
   `dir/b.txt` (basename join). Seed a tracked `dir/keep.txt` so `dir`
   exists on disk (git mv into-dir requires the destination directory).
3. **Directory subtree rename** — `mv(['old'], 'new')` reparents every tracked
   entry under `old/` leaf-by-leaf.
4. **Force overwrite** — `mv(['a.txt'], 'b.txt', { force: true })` vs
   `git mv -f a.txt b.txt`.
5. **Unstaged edit travels** — stage `a.txt`, then edit the working copy so
   worktree ≠ staged blob, then `mv`. The index blob id must stay the staged
   one (matches git: no re-hash) **and** the working dest must hold the edited
   bytes. This pins the 21.2 headline invariant to canonical git.

Refusals (assert `git` exits non-zero ∧ `repo.mv` throws the mapped `MV_*`
code ∧ neither index nor working tree mutated — `lsStage` unchanged on both):

6. **Source not tracked** → `MV_SOURCE_NOT_TRACKED`.
7. **Destination exists, no force** → `MV_DESTINATION_EXISTS`.
8. **Overlapping sources** (`mv(['a','a/b'], 'dir')`) → `MV_OVERLAPPING_SOURCES`.

Refusal cases assert the `.data.code` directly (try/catch, not
`toThrow(Class)`) per the mutation-resistant convention, and assert the
**pre-move** `lsStage` equals the **post-refusal** `lsStage` on the tsgit side
(no partial mutation).

## Test matrix — `add-interop.test.ts`

Seed identical untracked files on both sides; stage via `repo.add` / `git add`;
compare `lsStage` ∧ `writeTreeOf`.

1. **New file** — `add(['a.txt'])` vs `git add a.txt`.
2. **Subdirectory pathspec** — `add(['sub'])` stages every file under `sub/`.
3. **Re-stage after edit** — stage, edit the working copy, `add` again; the blob
   id advances to the new content (matches git).

(Executable-bit and symlink staging are POSIX-mode-dependent — left to the
`posix-only/` suite, not this portable file.)

## Test matrix — `rm-interop.test.ts`

Seed a tracked file (stage on both), then remove both ways; compare `lsStage`
(entry gone) ∧ working-tree presence.

1. **Tracked removal** — `rm(['a.txt'])` drops the index entry **and** deletes
   the working file, matching `git rm a.txt`.
2. **`--cached`** — `rm(['a.txt'], { cached: true })` drops the index entry but
   leaves the working file, matching `git rm --cached a.txt`.
3. **Refusal — untracked path** — `rm(['ghost.txt'])` throws (`PATHSPEC_NO_MATCH`)
   and `git rm ghost.txt` exits non-zero; neither side mutates (`lsStage`
   unchanged).

## Test matrix — `reset-interop.test.ts`

Reset needs a committed history with **matching SHAs** on both sides, so the
seed commits with a pinned author/committer identity (commit ids are already
proven SHA-equal by `commit-interop.test.ts`). Seed: commit `C0` (`a=v0`), then
commit `C1` (`a=v1` + new `b`). Reset each mode to `C0` and compare against
`git reset --<mode> <C0>`:

1. **`--soft`** — HEAD → `C0`; index + working tree untouched. Compare
   `rev-parse HEAD` ∧ `lsStage` (still `C1`'s index) ∧ working tree.
2. **`--mixed`** — HEAD → `C0`; index rebuilt from `C0`'s tree; working tree
   untouched (`b` still on disk, now untracked). Compare `rev-parse HEAD` ∧
   `lsStage` ∧ `b` present on disk.
3. **`--hard`** — HEAD → `C0`; index **and** working tree reset (`b` deleted,
   `a` back to `v0`). Compare `rev-parse HEAD` ∧ `lsStage` ∧ working tree
   (`a` content = `v0`, `b` absent).

`rev-parse HEAD` is read back by canonical git on both sides — the reset must
land HEAD on the same commit id, not merely "a" commit.

## Surface declaration (audit integration)

`audit-write-surfaces` couples every `@writes` surface to a `cross-tool-interop`
test naming it via `interopSurface:`. A `cross-tool-interop` test that names a
surface no `@writes` declares is reported as **orphan coverage**. To keep the
audit clean *and* make porcelain faithfulness durable, each command becomes a
declared write surface — a top-of-file JSDoc on its command module (none of the
four currently has one; they start with imports). For `mv`:

```ts
/**
 * Move/rename tracked paths in the index and the working tree, faithful to
 * `git mv`. …
 *
 * @writes
 *   surface: mv
 *   kind:    equivalent-under-readback
 *   format:  git-index-tree-state
 */
```

The same block (with `surface: add` / `rm` / `reset`) is added to each command
module. All four share `kind: equivalent-under-readback` (the resulting index +
tree read back via `ls-files --stage` / `write-tree` match git; raw index bytes
differ by stat-cache) and `format: git-index-tree-state` (the composite readback
state — no single new byte format, which is the point of a porcelain surface;
format labels are not required unique).

The parser requires the `@writes` block to be the **first** JSDoc at byte 0, so
each command file gains a leading module-doc comment before its imports.

Each new test header, e.g. `mv-interop.test.ts`:

```ts
/**
 * @proves
 *   surface:        mv
 *   bucket:         cross-tool-interop
 *   unique:         mv porcelain index+tree state matches canonical git mv
 *   interopSurface: mv
 */
```

This widens `@writes` from "module defines a byte format" to "module owns a
write surface that must be pinned to canonical git" — the composite-porcelain
case. Recorded in ADR-204; scope in ADR-205.

## Testing strategy

- **Interop (this PR):** the four `<cmd>-interop.test.ts` files *are* the
  deliverable. Each is `describe.skipIf(!GIT_AVAILABLE)` so it mirrors the suite
  (skips where git is absent, e.g. a hermetic CI shard).
- **Unit:** the new `interop-helpers.ts` functions are exercised transitively by
  the interop tests. `tryRunGit`'s failure branch is covered by every refusal
  case (git exits non-zero); its success branch by every happy path. No separate
  unit test — interop helpers have always been integration-scoped (the module doc
  says so), and `runGit`/`hasGit`/`makePeerPair` carry no unit tests today.
- **Coverage gate unaffected:** the only `src/` change is four `@writes` JSDoc
  blocks (comments). `test:coverage` measures `src/` and is untouched; the new
  helpers live under `test/` and run in `test:integration`.
- **No property test:** the harness is I/O orchestration against a real
  subprocess — explicitly *not* a parser/matcher/round-trip per the property-test
  guidance. The four lenses don't fit.
- **Mutation:** refusal cases assert `.data.code` (StringLiteral-mutant
  resistant); each guard condition (per `MV_*` path, `PATHSPEC_NO_MATCH`) gets an
  isolated case. No new `src/` logic is added, so the PR introduces no new
  mutants.

## Key design decisions

1. **Readback over byte-equality** — compare `git ls-files --stage` /
   `git write-tree` of each side, not raw `.git/index` bytes. Forced by
   per-host stat-cache fields. (Pre-decided by `index-interop.test.ts`.)
2. **Seed by staging where the command works off the index** — `mv`/`add`/`rm`
   operate on the index, so staging is sufficient and faster; a seed commit would
   only add a constant SHA with no extra faithfulness signal. `reset` is the
   exception — it targets a commit, so it seeds two pinned-identity commits whose
   SHAs match git's (proven by `commit-interop.test.ts`).
3. **Drive the porcelain facade, not primitives** — `openRepository().mv(...)`.
   The whole point is to exercise the orchestration layer the parity goldens
   can't vouch for against canonical git.
4. **Model porcelain as a `@writes` surface** (ADR-204) — reuse the existing
   audit so the gap is machine-tracked, rather than convention-only.
5. **Co-refusal proof** — for every refusal, assert git *also* refuses and
   neither side mutated, not merely that tsgit throws. Faithfulness is symmetric.

## Alternatives considered

- **Convention-only, no audit tag** — ship the test, leave `mv` untracked by the
  audit. Rejected: the backlog's whole motivation is "can ship undetected";
  convention relies on humans remembering. (ADR-204 option A.)
- **New `@faithful` porcelain tag + audit extension** — a separate taxonomy
  (`@writes` = byte format, `@faithful` = porcelain state) with its own parser,
  collector, and report fields. Cleaner taxonomy, real tooling cost. Deferred
  in favour of reusing `@writes`. (ADR-204 option C.)
- **Compare via `repo.status` rename detection** — brittle; status output and
  rename heuristics are themselves under test. The index/tree readback is the
  canonical artifact.
