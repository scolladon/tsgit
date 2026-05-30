# Design — `stash` (push / pop / list / drop / apply)

## 1. Goal

Ship the `stash` porcelain family: save dirty working-tree + index state onto a
stack, restore it later, and manage the stack. Faithful to `git stash` on-disk
representation (the `refs/stash` ref + its reflog stack, the `W`/`I`/`U` commit
trio) and faithful observable behaviour (message format, "no local changes",
3-way apply, clean-tree reset after push).

This phase also wires the `SnapshotFactory.stashEntry` stub (currently
`async () => null`) to parse a real stash entry into the `StashSnapshot` trio —
the working-tree snapshot infra Phase 22 (cherry-pick / revert / rebase) reuses.

Non-goals (deferred — see §11): patch mode (`-p`), pathspec-limited push,
`stash clear`, `stash branch`, `stash show`, `stash create`/`store` plumbing.
The shared ref-DWIM ladder gap that blocks `rev-parse stash@{N}` is fixed in this
PR as a separate `fix(rev-parse)` slice (§12 / ADR-216) — stash's own verbs stay
index-typed and do not depend on it.

## 2. Faithful data model (git on-disk, not invented)

A stash entry is a commit `W` reachable from `refs/stash`; the stack is the
`refs/stash` **reflog** (newest entry = `stash@{0}`). This is exactly git.

```
W  (WIP commit)           tree = w_tree   (tracked working-tree content)
│                         parents = [b, i] or [b, i, u]
├─ parent[0] = b          the HEAD commit when stashed (the merge base on apply)
├─ parent[1] = i  (I)     tree = i_tree   (the index at stash time)
│                         parent = [b]
└─ parent[2] = u  (U)     tree = u_tree   (untracked files only); parents = []
   (only when push included untracked)
```

- `i_tree` = `synthesizeTreeFromIndex(index.entries)` (write-tree of the index).
- `w_tree` = the index entry set with every tracked path updated to its
  working-tree content (re-hash modified, drop deleted), then
  `synthesizeTreeFromIndex`. Untracked files are **not** in `w_tree`.
- `u_tree` = a tree built from untracked (non-ignored) files only.
- `b` = current HEAD commit oid.

**Reflog / W message** (byte-faithful):
- default: `WIP on <branch>: <abbrev> <subject>`
- custom message (`-m`): `On <branch>: <message>`
- index commit: `index on <branch>: <abbrev> <subject>`
- untracked commit: `untracked files on <branch>: <abbrev> <subject>`

`<branch>` is HEAD's symbolic branch short-name, or `(no branch)` when detached.
`<abbrev>` is the 7-char HEAD oid; `<subject>` is the first line of HEAD's commit
message.

**Reflog must be force-created.** `shouldAutocreateReflog` only auto-logs
`refs/heads/`, `refs/remotes/`, `refs/notes/`, and `HEAD` — **not** `refs/stash`.
So plain `updateRef` would write the ref but, on the first push, `recordRefUpdate`'s
gate is closed and the reflog entry is silently dropped — breaking the stack.
git treats stash as always-logged (it passes the reflog-creation flag
explicitly). Therefore the `stash-ref` primitive (§7) writes the ref **and**
force-appends the reflog entry directly (resolving identity like
`recordRefUpdate`, oldId = current ref or `ZERO_OID`), bypassing the autocreate
gate. The general `shouldAutocreateReflog` rule is left untouched (no
stash-specific pollution of the shared gate).

## 3. API surface — nested namespace `repo.stash.*`

Per the established multi-verb convention (ADR-181 / ADR-192: per-verb
Context-aware functions, concrete result types, no `kind`/`action` discriminator
on input, frozen non-callable namespace), `stash` is a nested namespace:

```typescript
export interface StashNamespace {
  readonly push: (input?: StashPushInput) => Promise<StashPushResult>;
  readonly list: () => Promise<StashListResult>;
  readonly apply: (input?: StashApplyInput) => Promise<StashApplyResult>;
  readonly pop: (input?: StashApplyInput) => Promise<StashPopResult>;
  readonly drop: (input?: StashDropInput) => Promise<StashDropResult>;
}
```

### 3.1 Inputs / results

```typescript
export interface StashPushInput {
  readonly message?: string;          // custom message → "On <branch>: <message>"
  readonly includeUntracked?: boolean;// -u: also stash untracked files (U commit)
  readonly keepIndex?: boolean;       // --keep-index: re-stage the index after reset
}
export type StashPushResult =
  | { readonly kind: 'saved'; readonly stash: ObjectId; readonly message: string }
  | { readonly kind: 'no-local-changes' };   // git prints + exits 0, not an error

// Selector: numeric stack index (0 = newest). Default 0.
export interface StashApplyInput {
  readonly index?: number;
  readonly restoreIndex?: boolean;    // --index: also restore staged-ness
}
export type StashApplyResult =
  | { readonly kind: 'applied'; readonly stash: ObjectId }
  | { readonly kind: 'conflict'; readonly conflicts: ReadonlyArray<StashConflict> };
export interface StashConflict { readonly path: FilePath; readonly type: ConflictType }

export type StashPopResult =
  | { readonly kind: 'applied'; readonly stash: ObjectId; readonly dropped: number }
  | { readonly kind: 'conflict'; readonly conflicts: ReadonlyArray<StashConflict> };

export interface StashDropInput { readonly index?: number }
export interface StashDropResult { readonly dropped: ObjectId; readonly remaining: number }

export interface StashListEntry {
  readonly index: number;             // 0 = newest
  readonly selector: string;          // "stash@{0}"
  readonly stash: ObjectId;           // the W commit
  readonly message: string;           // reflog message
}
export type StashListResult = { readonly entries: ReadonlyArray<StashListEntry> };
```

**Selector decision.** `apply`/`pop`/`drop` take a numeric `index` (default 0),
not a `stash@{N}` string. The stack model is intrinsically index-addressed and
the verbs need the index for the reflog mutation (drop/pop) regardless. Resolving
the W commit is a direct read of the `refs/stash` reflog (`pickByIndex`-style),
**not** the shared `rev-parse` DWIM ladder — that ladder lacks a `refs/<base>`
candidate, so `stash@{N}` does not resolve through it today. Broadening the
ladder (and thus `rev-parse stash@{N}`) is deferred (§11).

### 3.2 Wiring

`repo.stash` is bound exactly like `repo.branch` / `repo.config`:
`commands.bindStashNamespace(ctx, guard)` returns a frozen object whose methods
run `guard()` then forward to the Context-aware command functions.

## 4. `push` algorithm

```
1. assertRepository; assertNotBare('stash'); assertNoPendingOperation()
2. head = readHeadRaw(); resolve b = HEAD oid.
   - HEAD unborn (no commit) → throw NO_INITIAL_COMMIT (git: "You do not have
     the initial commit yet").
3. index = readIndex(); enumerate working-tree dirtiness + untracked.
   - "anything to stash?" = (index ≠ HEAD tree) OR (working tree ≠ index) OR
     (includeUntracked AND ≥1 untracked file).
   - none → return { kind: 'no-local-changes' } (no ref/reflog mutation).
4. i_tree = synthesizeTreeFromIndex(index.entries);
   i = createCommit(tree=i_tree, parents=[b], msg="index on <branch>: …").
5. if includeUntracked: collect untracked (non-ignored) files → u_tree;
   u = createCommit(tree=u_tree, parents=[], msg="untracked files on …").
6. w_tree = synthesizeTreeFromIndex(workingTreeEntries(index));
   w = createCommit(tree=w_tree, parents=[b, i, (u)], msg=<wip/on message>).
7. updateRef('refs/stash', w, { reflogMessage: <wip/on message> }).
8. Reset working tree + index to HEAD so the tree is clean:
   - reset --hard semantics over tracked files (materializeTree(b_tree,
     force, forceRewriteAll) + commit index).
   - if includeUntracked: remove the stashed untracked files from disk.
   - if keepIndex: re-materialise i_tree into working tree + index afterwards
     (so staged changes survive in the index).
9. return { kind: 'saved', stash: w, message }.
```

`workingTreeEntries(index)` = for every stage-0 index entry, `compareWorkingTreeEntry`:
- `absent` → drop (deleted),
- `unchanged` → keep entry verbatim,
- `modified` → re-hash working content+mode into a new stage-0 entry.

The whole push is wrapped so a failure after step 7 (ref written) but before the
reset completes is the same recoverable hazard as git (the stash is saved; the
working tree may be partially reset). Ordering: create objects → update ref →
reset, matching git's "save before reset" order so the data is never lost first.

## 5. `apply` algorithm (3-way merge)

```
1. assertRepository; assertNotBare; assertNoPendingOperation().
2. w = resolveStashEntry(index)  // reflog[index].newId, else STASH_NOT_FOUND.
3. Parse W parents: b = W^1, i = W^2, u = W^3?.  b_tree = b^{tree}, w_tree = W^{tree}.
4. c_tree = synthesizeTreeFromIndex(currentIndex)        // "ours"
5. result = mergeTrees(base=b_tree, ours=c_tree, theirs=w_tree, contentMerger)
6. Overwrite guard (git's "local changes would be overwritten"): for every path
   the merge would write, if the working file is dirty vs the index AND the merge
   target differs from the working content → refuse atomically (no write).
7a. clean → materialise merged outcomes onto the working tree; index stays at
    c_tree (changes appear unstaged). If restoreIndex AND i_tree ≠ b_tree:
    additionally re-stage the i_tree-vs-b_tree diff into the index.
7b. conflict → write conflict markers to the working tree + stage-1/2/3 unmerged
    index entries (faithful; reuses the merge command's conflict writers). NO
    MERGE_HEAD is written (stash apply is not a merge-in-progress). Return
    { kind: 'conflict', conflicts }. Stash is retained.
8. if restoreUntracked (u present): check out u_tree into the working tree;
   refuse if it would overwrite an existing file. (v1: untracked restored only
   on clean apply.)
9. return { kind: 'applied', stash: w } | { kind: 'conflict', … }.
```

The 3-way merge reuses the **domain** `mergeTrees` / `mergeContent` (pure,
already 100%-covered) plus the merge command's exported working-tree writers
(`writeOutcomeToTree`, conflict writers). To avoid duplicating merge's
clean-outcome → working-tree + index materialisation (which lives inline in
`merge.ts` and is partly not exported), this phase extracts a small reusable
primitive `applyMergeToWorktree` (see §7) that both `stash apply` and Phase 22
consume. `merge.ts`'s public behaviour is unchanged.

## 6. `pop` / `list` / `drop`

- **`list`** = `readReflog('refs/stash')`, newest-first, mapped to
  `StashListEntry`. Absent reflog → `{ entries: [] }`.
- **`drop(index)`** = resolve entry; remove reflog line `index`; then:
  - reflog now non-empty → write `refs/stash` **directly** (`atomicWriteRef`) to
    the new top survivor's `newId` AND `writeReflog(survivors)`. Drop must **not**
    go through `updateRef` — that appends a fresh reflog entry, whereas drop
    *rewrites* the stack. The ref + reflog are mutated together by the `stash-ref`
    primitive.
  - reflog now empty → delete `refs/stash` (loose ref) + its reflog file
    (`deleteReflog`).
  Faithful to `git stash drop` (= `reflog delete --updateref --rewrite` + ref
  cleanup). Returns `{ dropped, remaining }`.
- **`pop(index)`** = `apply(index)`; on `applied`, `drop(index)` and return
  `{ kind: 'applied', dropped }`; on `conflict`, **do not drop** (git retains the
  stash on conflicting pop) and return the conflict result.

## 7. New / changed modules

```
src/application/commands/stash.ts                      # 5 verb functions
src/application/commands/internal/stash-namespace.ts   # bindStashNamespace
src/application/commands/internal/stash-message.ts     # message builders (pure)
src/application/primitives/apply-merge-to-worktree.ts  # clean+conflict → worktree+index
src/application/primitives/stash-ref.ts                # refs/stash reflog read/mutate (force-creates reflog on push; rewrites stack on drop)
src/domain/commands/error.ts                           # STASH_* codes (see §8)
src/application/primitives/snapshot/snapshot-factory.ts# wire stashEntry stub
src/application/commands/index.ts                      # export StashNamespace
src/repository.ts                                       # repo.stash binding
src/index.ts                                           # public type re-exports
```

`apply-merge-to-worktree` is the "working-tree snapshot infra reused by 22":
given `(baseTree, oursTree, theirsTree)` it runs the 3-way merge and applies the
result to the working tree + index, returning `{ kind:'clean' } | { kind:'conflict', conflicts }`.
Phase 22's cherry-pick/revert/rebase apply commits the same way.

`stashEntry(stashIndex)` wiring: resolve `refs/stash` reflog[stashIndex] → W
oid; if absent → `null`. Read W; build the trio of lazy `TreeSnapshot`s from
`W^{tree}` (workdir), `W^2^{tree}` (index), and `W^3^{tree}` if a 3rd parent
exists else `null` (untracked). No I/O beyond the reflog read + the W commit
read until a snapshot is iterated (preserves the §9 construction discipline).

## 8. Error codes (`domain/commands/error.ts`)

```
| { code: 'NO_INITIAL_COMMIT' }                                  // push on unborn HEAD
| { code: 'STASH_NOT_FOUND'; index: number; stackSize: number }  // bad selector
| { code: 'STASH_APPLY_WOULD_OVERWRITE'; paths: ReadonlyArray<FilePath> } // dirty-overlap guard
```

Conflict-on-apply is **not** an error — it's the `{ kind: 'conflict' }` result
(mirrors `merge`'s `{ kind: 'conflict' }`). `STASH_APPLY_WOULD_OVERWRITE`
mirrors git's pre-merge "Your local changes … would be overwritten" abort. Each
factory follows the existing pattern (typed payload, sanitised display where the
payload is user-derived). Error assertions in tests must assert `.data` fields
(not just the class) per the mutation-resistant convention.

## 9. Testing strategy

- **Unit (example)** — per verb, GWT/AAA, `sut`, 100% L/B/F/S:
  - `push`: no-changes no-op; saved (working-only / staged / both); message
    format (default vs `-m`, branch vs detached); `includeUntracked`;
    `keepIndex`; unborn-HEAD refusal; clean working tree after push.
  - `list`: empty; ordering newest-first; selector strings.
  - `apply`: clean restore; restore onto staged state; `restoreIndex`; conflict
    (markers + unmerged index, stash retained); `STASH_APPLY_WOULD_OVERWRITE`;
    `STASH_NOT_FOUND`; untracked restore + overwrite refusal.
  - `pop`: applied → dropped; conflict → retained; stack re-indexing.
  - `drop`: middle/oldest/newest; empties stack ⇒ `refs/stash` deleted; updates
    ref to new top; `STASH_NOT_FOUND`.
  - `stashEntry` factory: null when no stash / out of range; trio for
    tracked-only and `-u` stashes; lazy (no parse before iteration).
- **Property** (`stash-message.properties.test.ts`): the message builders are a
  small total grammar over `(branch, abbrev, subject, custom?)`. The four lenses:
  round-trip does not apply; **total function** over ASCII inputs (builder never
  throws) — lens 3 fits. Add a focused property that the WIP/On/index/untracked
  builders are total over arbitrary single-line ASCII subjects. The verb
  orchestration itself is integration/parity, not property (lens exclusion:
  "command facades … belong in integration/parity tests").
- **Interop / parity** (`test/integration/*-interop.test.ts`): per ADR-204
  `stash` is a `@writes` surface. Assert `repo.stash.push` then real
  `git stash list` / `git rev-parse stash@{0}^{tree}` / `git ls-files --stage`
  readback matches canonical git: the saved W/I/U trees, the reflog message, the
  clean working tree, and a clean `apply` round-trip. Co-refusal proof for
  unborn-HEAD push and `STASH_APPLY_WOULD_OVERWRITE`.

## 10. Key design decisions (resolved)

1. **API surface** → nested namespace `repo.stash.*` (ADR-210).
2. **v1 scope** → 5 verbs + `-m` + `-u` + `--keep-index` + `--index`; patch /
   pathspec / clear / branch / show / create-store deferred (ADR-211).
3. **Apply/pop conflict handling** → faithful markers + stage-1/2/3 unmerged
   index + upfront overwrite guard; conflict is a result, pop retains on conflict
   (ADR-212).
4. **Selector form** → numeric `index` (default 0); `stash@{N}` string deferred
   (ADR-213).
5. **Reflog creation** → `stash-ref` force-creates the `refs/stash` reflog;
   `drop` rewrites the stack directly (ADR-214).
6. **Reuse architecture** → extract `applyMergeToWorktree` primitive shared with
   Phase 22; `merge.ts` unchanged this phase (ADR-215).
7. **`refCandidates` faithfulness gap** (§12) → **full** gitrevisions fix in this
   PR (add `refs/<name>`, swap heads↔tags, add `refs/remotes/<name>/HEAD`);
   unlocks `rev-parse stash@{N}` (ADR-216). Stash verbs stay index-typed
   regardless.

## 11. Deferred (explicitly out of scope for 21.3)

- Patch mode (`stash -p`), pathspec-limited push (`stash push -- <paths>`).
- `stash clear`, `stash branch <name>`, `stash show`, `stash create`/`store`.
- The `stash@{N}` **string** selector at the stash verb API (the verbs take a
  numeric `index`; ADR-213). `rev-parse stash@{N}` itself **does** ship via the
  §12 ladder fix (ADR-216).
- `--index` reinstatement of *conflicted* staged state (v1 `restoreIndex` only
  applies on a clean merge).

## 12. Appendix — `refCandidates` is a faithfulness gap (not by design)

`src/domain/refs/ref-candidates.ts` claims to be "the gitrevisions ref-DWIM
ladder", but diverges from the canonical 6-rule order in three ways:

| gitrevisions rule | tsgit `refCandidates` |
|---|---|
| 1. `$GIT_DIR/<name>` (HEAD, MERGE_HEAD, **refs/stash via verbatim**) | ✅ `base` verbatim |
| 2. `refs/<name>` | ❌ **missing** — this is why `stash` / `stash@{N}` doesn't resolve |
| 3. `refs/tags/<name>` | present, but **after** heads |
| 4. `refs/heads/<name>` | present, but **before** tags (order swapped) |
| 5. `refs/remotes/<name>` | ✅ |
| 6. `refs/remotes/<name>/HEAD` | ❌ missing |

So it is a genuine gap, not an intentional design. The faithful fix lands in
that one shared helper and flows automatically to both consumers (`rev-parse`
and `merge`'s `resolveTarget`). Two parts, different risk:

**Decided (ADR-216): the full fix ships in this PR** as a `fix(rev-parse)` slice
in the one shared helper:

```
refCandidates(base) = [
  base,                        // rule 1 — verbatim (full paths, HEAD, refs/stash)
  `refs/${base}`,              // rule 2 — NEW
  `refs/tags/${base}`,         // rule 3 — now before heads
  `refs/heads/${base}`,        // rule 4 — now after tags
  `refs/remotes/${base}`,      // rule 5
  `refs/remotes/${base}/HEAD`, // rule 6 — NEW
]
```

Both consumers (`rev-parse`, `merge`'s `resolveTarget`) inherit the fix; it
unlocks `rev-parse stash@{N}` / `merge stash`. The heads↔tags swap is
behavioural — a name that is both a tag and a branch now resolves to the tag
first (like git), so existing `rev-parse`/`merge` resolution-order tests are
updated to match. Stash's own verbs stay index-typed (ADR-213) and do not depend
on this slice.
```

