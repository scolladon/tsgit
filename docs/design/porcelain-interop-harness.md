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
- `test/integration/mv-interop.test.ts` — pins `repo.mv` to `git mv` across
  rename, move-into-dir, directory-subtree, force-overwrite, the
  unstaged-edit-travels invariant, and three refusals.
- Make porcelain faithfulness **machine-tracked** by the write-surface audit:
  declare `mv` as a write surface so `audit-write-surfaces` reports it covered
  (not orphan) — see ADR-204.
- Reword the `mv.scenario.ts` golden comment: the tree id is now machine-pinned
  to canonical git by the interop sibling, not "verified out-of-band".

Out of scope (future, same pattern):

- Retrofitting other composite porcelain (`add`, `rm`, `reset`, `stash`, …).
  `commit` is already pinned (`commit-message-interop.test.ts`). Each future
  porcelain adds its own `@writes` tag + `*-interop.test.ts` as it lands.
- Network porcelain (`clone`/`fetch`/`pull`/`push`) — covered by the
  `network/*-http-backend.test.ts` suite, a different bucket.

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

## Surface declaration (audit integration)

`audit-write-surfaces` couples every `@writes` surface to a `cross-tool-interop`
test naming it via `interopSurface:`. A `cross-tool-interop` test that names a
surface no `@writes` declares is reported as **orphan coverage**. To keep the
audit clean *and* make porcelain faithfulness durable, `mv` becomes a declared
write surface — a top-of-file JSDoc on `src/application/commands/mv.ts`:

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

`kind: equivalent-under-readback` — the resulting index + tree read back (via
`ls-files --stage` / `write-tree`) match git; raw index bytes differ by
stat-cache. `format: git-index-tree-state` names the composite readback state
(no single new byte format — that is the point of a porcelain surface).

The new test header:

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
case. Recorded in ADR-204.

## Testing strategy

- **Interop (this PR):** `mv-interop.test.ts` is the deliverable — it *is* the
  test. `describe.skipIf(!GIT_AVAILABLE)` mirrors the suite (skips where git is
  absent, e.g. a hermetic CI shard).
- **Unit:** the new `interop-helpers.ts` functions are exercised transitively by
  the interop test. `tryRunGit`'s failure branch is covered by refusal cases 6–8
  (git exits non-zero); its success branch by every happy path. No separate unit
  test — interop helpers have always been integration-scoped (the module doc
  says so), and `runGit`/`hasGit`/`makePeerPair` carry no unit tests today.
- **No property test:** the harness is I/O orchestration against a real
  subprocess — explicitly *not* a parser/matcher/round-trip per the property-test
  guidance. The four lenses don't fit.
- **Mutation:** refusal cases assert `.data.code` (StringLiteral-mutant
  resistant); guard conditions (each `MV_*` path) get an isolated case.

## Key design decisions

1. **Readback over byte-equality** — compare `git ls-files --stage` /
   `git write-tree` of each side, not raw `.git/index` bytes. Forced by
   per-host stat-cache fields. (Pre-decided by `index-interop.test.ts`.)
2. **Seed by staging, not committing** — `git mv` works off the index; staging
   is sufficient and faster. A seed commit would only add a constant SHA with no
   extra faithfulness signal.
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
