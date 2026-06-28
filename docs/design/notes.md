# Design — `notes` (add / read / list / remove)

## 1. Problem & scope

`git notes` attaches out-of-band annotations to existing objects without
rewriting them. The annotations live in their own ref namespace
(`refs/notes/*`): a notes ref points at a **commit**, whose **tree** maps each
annotated object's oid to a **blob** of note text. tsgit must grow a Tier-1
command family `repo.notes.*` covering the four read/write verbs that operate on
that store:

- **`add`** — write (or, with `force`, overwrite) the note for an object.
- **`read`** — fetch the note recorded for an object (its blob oid + bytes).
- **`list`** — enumerate every `(annotated-object, note-blob)` pair in a notes ref.
- **`remove`** — drop the note for an object, committing the smaller tree.

In scope for this slice: the default notes ref `refs/notes/commits` plus an
explicit per-call `ref` override, the **flat** notes tree (the common case,
below git's fanout flip), **reading** notes trees of any fanout depth, the notes
**commit** mechanics (fixed messages, parent chaining, identity), the **reflog**
entries, the **refusal** conditions, and the empty-tree-on-last-remove
behaviour — all pinned byte-for-byte against real `git` in §4.

Out of scope (call-outs in §10/§13): **writing** a notes tree at or above git's
fanout flip point (the distribution-dependent, sticky one-byte fanout — the
load-bearing decision, §10); the porcelain message-normalisation `git notes`
applies to `-m`/`-F`/editor input (trailing-newline insertion, multi-`-m` blank-line
join, `stripspace`, empty-input-means-remove) — that is the caller's, per ADR-249
(§5); `notes copy`/`merge`/`prune`/`get-ref`, `--ref` rewrite of `notes.rewriteRef`,
and the `notes.displayRef`/`log --notes` display integration.

This design obeys two project directives verbatim:

- **Git-faithfulness (prime directive, ADR-226).** The notes-commit messages,
  the tree shape and entry encoding, the ref/reflog contents, the empty-tree oid,
  and the refusal conditions are pinned against real `git` 2.54.0 in §4 and
  become cross-tool interop tests (§11). Nothing here is described from memory.
- **Structured output, not cosmetics (ADR-249).** The library returns structured
  data (oids, note bytes, object/note pairs); it emits no rendered line and bakes
  in no message normalisation. The note blob is stored **verbatim** from the
  caller's bytes (§5); the human-readable `git notes` stdout/stderr is
  reconstructed *inside the interop test* from the structured fields, never by the
  library.

## 2. Precedents already in the codebase

Studied before designing; every symbol/path below was confirmed in the worktree.

| Concern | Existing symbol | File |
| --- | --- | --- |
| One-command / several-subcommands namespace (the surface shape to copy) | `tagList`/`tagCreate`/`tagDelete` + `bindTagNamespace(ctx, guard)` | `src/application/commands/tag.ts`, `.../internal/tag-namespace.ts` |
| `expected: 'absent'` vs force on a ref write, mapping conflict→refusal | `tagCreate` (catch `REF_UPDATE_CONFLICT` → `tagExists`) | `src/application/commands/tag.ts` |
| Ref write + reflog (auto-logs `refs/notes/*` already) | `updateRef(ctx, name, newId, { reflogMessage })` | `src/application/primitives/update-ref.ts` |
| `refs/notes/` is already a default-loggable reflog prefix | `shouldAutocreateReflog` (`DEFAULT_LOGGABLE_PREFIXES`) | `src/domain/reflog/should-log.ts` |
| Resolve a ref to an oid; absent → `REF_NOT_FOUND` | `resolveRef(ctx, name)` | `src/application/primitives/resolve-ref.ts` |
| Write a blob/commit object; build a flat tree | `writeObject`, `createCommit`, `writeTree(ctx, TreeEntry[])` | `src/application/primitives/{write-object,create-commit,write-tree}.ts` |
| Read a tree's entries / walk a tree of arbitrary fanout depth (full paths) | `readObject` (→ `Tree.entries`), `walkTree` | `src/application/primitives/{read-object,walk-tree}.ts` |
| Read a note blob's bytes by oid | `readBlob(ctx, id) → Blob` | `src/application/primitives/read-blob.ts` |
| Current author==committer identity (config `[user]` + now) | `resolveCurrentIdentity(ctx)` | `src/application/commands/internal/current-identity.ts` |
| `TreeEntry` shape (`{ mode, name, id }`), canonical sort | `TreeEntry`, `sortTreeEntries` | `src/domain/objects/tree.ts` |
| Structured command errors (union + factories) | `CommandError`, `tagExists`/`tagNotFound` | `src/domain/commands/error.ts` |
| Namespace facade wiring | `bindTagNamespace(ctx, guard)` at `repository.ts` | `src/repository.ts` |

`tag` is the canonical precedent for the namespace surface, the
force-vs-`expected:'absent'` write, and the conflict→refusal mapping. `writeTree`
+ `createCommit` + `updateRef` are the exact primitives that build a notes
commit. **No new ref/object/tree machinery is hand-rolled** — the verbs are pure
composition of existing primitives (Tier-1 built from the same building blocks
users get).

## 3. The notes store (on-disk model)

```
refs/notes/commits  ──▶  commit ──▶ tree ──▶ entries
                          │            │
                          │            ├─ 100644 <annotated-oid-40hex> ─▶ note blob   (FLAT, common case)
                          │            └─ …                                            (sorted by entry name = oid)
                          parent = previous notes commit (root if first)
                          author == committer == current identity
                          message = "Notes added by 'git notes add'"  (add/force)
                                  | "Notes removed by 'git notes remove'"  (remove)
```

- **Default ref** `refs/notes/commits`; overridable per call (`ref`), and
  optionally by `GIT_NOTES_REF` / `core.notesRef` (Decision D).
- The notes **tree** maps an annotated object's oid → its note blob. Below git's
  fanout flip the tree is **flat**: one entry `100644 <full-40-hex> <note-blob>`,
  canonically sorted by entry name (i.e. by annotated-object oid). Above the flip
  git switches to a uniform one-byte fanout (`XX/<38-hex>`, recursively) — §10.
- Every mutation (add/force/remove) **commits a new notes commit** whose parent
  is the previous notes commit (or no parent for the very first), and moves the
  ref. The note blob is created with the caller's bytes verbatim.
- **Removing the last note commits the empty tree**
  (`4b825dc642cb6eb9a060e54bf8d69288fbee4904`); the ref is **not** deleted.

## 4. Pinned git behaviour (real `git` 2.54.0, isolated `HOME`, `GIT_*` scrubbed, `GIT_CONFIG_NOSYSTEM=1`, signing OFF, pinned author/committer dates)

All facts below were produced in a `mktemp -d` throwaway repo (never the
worktree). These are the faithfulness goldens; each becomes an interop assertion
(§11). Faithfulness binds the **data and on-disk state** (oids, tree bytes, ref,
reflog, commit messages, refusal conditions) — the rendered stdout/stderr is
reconstructed *in the interop test* from the structured fields (ADR-249).

### 4.1 Storage & commit (the byte-identity surface)

Annotate commit `O` with `hello note`:

```
$ git notes add -m "hello note" O
notes ref:     refs/notes/commits           ← created, points at a commit
notes commit:
    tree <T>
    author A <a@x> 1767225600 +0000
    committer A <a@x> 1767225600 +0000

    Notes added by 'git notes add'           ← fixed message (affects the commit oid)
tree <T>:
    100644 blob <noteblob>   388733f5…  (full-40-hex annotated oid, FLAT)
note blob bytes:  h e l l o   n o t e \n     ← exactly the input + git's one trailing \n (porcelain, §5)
```

- **Parent chaining** (pinned): a second `notes add` on a different object
  produces a notes commit whose `parent` is the first notes commit; the tree
  carries **both** flat entries, sorted by oid ascending.
- The **tree** oid and the **note blob** oid are deterministic (pure functions of
  the entries / bytes) and are pinned byte-for-byte. The notes **commit** oid is
  timestamp-dependent (it embeds the committer date), so it is byte-identical to
  git's only when identity **and** commit date are pinned to git's — see §11.1.
- **Force** (`notes add -f`) overwrites the entry; the commit message is **still**
  `Notes added by 'git notes add'` (the `Overwriting existing notes …` line git
  prints is stderr porcelain, not the commit message).

### 4.2 Reflog (`refs/notes/*` is a default-loggable prefix)

```
add / force:  <new>  refs/notes/commits@{0}: notes: Notes added by 'git notes add'
remove:       <new>  refs/notes/commits@{0}: notes: Notes removed by 'git notes remove'
```

The reflog message is `notes: ` + the notes-commit subject.

### 4.3 Remove & empty-tree-on-last-remove

```
remove (other notes remain):  commit message "Notes removed by 'git notes remove'", parent = prev,
                              tree keeps the other entries.
remove the LAST note:         tree becomes the empty tree 4b825dc642cb6eb9a060e54bf8d69288fbee4904
                              (git hash-object -t tree /dev/null); ref NOT deleted; commit still made.
```

### 4.4 Refusal conditions (exact bytes, exit 1)

| Trigger | git stderr (exact) | exit |
| --- | --- | --- |
| `add` on an object that already has a note, no `-f` | `error: Cannot add notes. Found existing notes for object <oid>. Use '-f' to overwrite existing notes\n` | 1 |
| `remove` on an object with no note | `Object <oid> has no note\n` (**no** `error:` prefix) | 1 |

> Correction to the pre-chewed findings: the remove-missing message is
> `Object <oid> has no note` — there is **no** `error:` prefix (pinned via `od -c`
> on captured stderr). `add -f` succeeds (overwrite); `git notes remove
> --ignore-missing` would suppress the second refusal but is out of scope.

### 4.5 Ref override (Decision D)

`GIT_NOTES_REF=refs/notes/custom git notes add …` writes `refs/notes/custom`;
`git config core.notesRef refs/notes/viaconfig` then `git notes add …` writes
`refs/notes/viaconfig`. Precedence is env > config > default `refs/notes/commits`.

### 4.6 List / read shapes

```
$ git notes list             ← one "<note-blob-oid> <annotated-oid>" line per note, sorted by annotated oid (= tree order)
$ git notes show <obj>       ← the note blob content
```

### 4.7 Porcelain normalisation observed (NOT replicated — caller's, §5)

- `-m "x"` stores `x\n`; input already ending in `\n` is **not** doubled;
  multiple `-m` join with a blank line (`\n\n`).
- `-m ""` (empty after `stripspace`) is treated by git as a **removal** (`exit 0`,
  stderr `Removing note for object <oid>`), not as an empty-blob note.

These are git porcelain message-normalisation steps. Under ADR-249 they are the
**caller's** responsibility; the library stores the bytes it is given (§5).

## 5. Note blob bytes — verbatim, caller owns normalisation (ADR-249)

The library's note `content` is a `Uint8Array` written to the blob **verbatim**.
The trailing-newline insertion, the multi-`-m` blank-line join, the `stripspace`
pass, and the empty-input-means-remove rule git's *porcelain* performs are all
display/normalisation choices ADR-249 assigns to the consumer (exactly as
`bisect` left the `Bisecting: …` line and `archive` left tar/zip framing choices
to the caller). The library owns the **mechanics** — the tree/commit/ref/reflog
encoding, which *is* the byte-identity surface — not the cosmetics of how note
text was assembled. Consequence: `add({ content: new Uint8Array(0) })` stores an
empty blob faithfully; it does **not** reinterpret empty content as a remove (that
is the caller's normalisation), and that single, principled divergence from the
`git notes add -m ""` *porcelain* is recorded as a non-goal (§13).

## 6. Structured data shapes (ADR-249-clean)

All oids are `ObjectId`; the notes-ref name is a `RefName`; note bytes are
`Uint8Array`. No rendered strings, no message normalisation, no pre-formatted
lines.

```ts
const DEFAULT_NOTES_REF = 'refs/notes/commits' as RefName;

interface NotesAddInput {
  readonly object: string;        // commit-ish / oid to annotate (resolved like tagCreate's target)
  readonly content: Uint8Array;   // note bytes, stored verbatim (§5)
  readonly force?: boolean;       // overwrite an existing note (git notes -f)
  readonly ref?: string;          // notes-ref override; default refs/notes/commits (Decision D)
}
interface NotesAddResult {
  readonly object: ObjectId;      // resolved annotated object
  readonly note: ObjectId;        // note blob oid
  readonly notesCommit: ObjectId; // new notes-ref commit oid
}

interface NotesReadInput {
  readonly object: string;
  readonly ref?: string;
}
// null when the object has no note (Decision B)
type NotesReadResult = {
  readonly object: ObjectId;
  readonly note: ObjectId;        // note blob oid
  readonly content: Uint8Array;   // note bytes inline (Decision C); Uint8Array (Decision F)
} | null;

interface NotesListInput {
  readonly ref?: string;
}
interface NotesListResult {
  readonly notes: ReadonlyArray<{ readonly object: ObjectId; readonly note: ObjectId }>;
}

interface NotesRemoveInput {
  readonly object: string;
  readonly ref?: string;
}
interface NotesRemoveResult {
  readonly object: ObjectId;
  readonly notesCommit: ObjectId; // new notes-ref commit oid (empty-tree commit on last remove)
}
```

The `git notes list` / `git notes show` display and the refusal lines are
reconstructed from these fields in the interop test (§11), never emitted here.

## 7. The verbs, composed from primitives

Each verb is a `Context`-aware function in `src/application/commands/notes.ts`,
behind `bindNotesNamespace(ctx, guard)` in
`src/application/commands/internal/notes-namespace.ts` (the `tag` shape). A small
internal helper resolves the notes ref to its `{ commit, tree-entry-map }` (or
"absent"), keyed by annotated-object oid, descending fanout on read (§10).

**`add`**
1. `assertOperationalRepository`; resolve `object` → `ObjectId` (oid-regex else
   `resolveRef`, as `tagCreate` resolves its target).
2. Load the notes ref (`resolveRef(ref)`; `REF_NOT_FOUND` → treat as absent/empty).
3. Look up the entry for `object` in the current tree (fanout-aware). If present
   and `force !== true` → throw `notesAlreadyExist(object)` (§9).
4. **Fanout guard (§10):** if the current tree is already fanned, or the rebuilt
   flat tree would exceed `NOTES_MAX_FLAT_ENTRIES` → throw
   `notesFanoutUnsupported(ref, count)`. Otherwise continue flat.
5. `writeObject(blob{ content }) → noteOid`; set the entry
   `{ mode: '100644', name: <40-hex object>, id: noteOid }`; `writeTree(entries)`
   → `treeOid` (entries re-sorted by `sortTreeEntries`).
6. `createCommit({ tree: treeOid, parents: prevCommit ? [prevCommit] : [],
   author: id, committer: id, message: NOTES_ADD_MESSAGE })` with
   `id = resolveCurrentIdentity(ctx)`.
7. `updateRef(ref, notesCommit, { reflogMessage: NOTES_ADD_REFLOG })`
   (`reflogMessage = "notes: " + NOTES_ADD_MESSAGE`).

**`remove`**
1. Resolve `object`; load the notes ref (absent → throw
   `notesObjectHasNone(object)` — nothing to remove).
2. If no entry for `object` → throw `notesObjectHasNone(object)`.
3. Drop the entry; `writeTree(remaining)` → `treeOid` (empty set → the empty-tree
   oid via `writeTree([])`, §4.3).
4. **Fanout guard (§10):** if the current tree is already fanned → throw
   `notesFanoutUnsupported(ref, count)` (rewriting it flat would drop git's sticky
   fanout structure). A flat tree shrinks to a flat tree — always allowed.
5. `createCommit({ tree, parents: [prevCommit], …, message: NOTES_REMOVE_MESSAGE })`.
6. `updateRef(ref, notesCommit, { reflogMessage: NOTES_REMOVE_REFLOG })`. The ref
   is **never** deleted (§4.3).

**`read`**
1. Resolve `object`; load the notes ref (absent → `null`).
2. Fanout-aware lookup of the entry for `object`; absent → `null` (Decision B).
3. `readBlob(noteOid)` → `{ object, note: noteOid, content }`.

**`list`**
1. Load the notes ref (absent → `{ notes: [] }`).
2. `walkTree(notesTree)` (handles any fanout depth, yields leaf paths
   `XX/yy/…/rest`); de-slash each path → the 40-hex annotated oid; pair with the
   leaf blob id.
3. Sort by annotated-object oid ascending (= git's tree order); return.

Notes-commit messages and reflog strings are named constants
(`NOTES_ADD_MESSAGE`, `NOTES_REMOVE_MESSAGE`, `NOTES_ADD_REFLOG`,
`NOTES_REMOVE_REFLOG`) — no magic strings, no provenance refs in code. The
message constants must be byte-faithful to git's stored commit message
(including git's single trailing newline — the exact byte handling is the commit
serializer's, pinned in interop §11.1).

## 8. Command surface & surface-gate checklist

### 8.1 Surface — one `notes` namespace, four methods

```ts
interface NotesNamespace {
  readonly add: (input: NotesAddInput) => Promise<NotesAddResult>;
  readonly read: (input: NotesReadInput) => Promise<NotesReadResult>;
  readonly list: (input?: NotesListInput) => Promise<NotesListResult>;
  readonly remove: (input: NotesRemoveInput) => Promise<NotesRemoveResult>;
}
```

Bound by `bindNotesNamespace(ctx, guard)` (each method runs `guard()` first, then
forwards — the `tag` pattern). Counts as **one** Tier-1 command for the README
count and surface snapshot.

### 8.2 Surface gates (pre-paid in-slice — current values pinned in the worktree)

- **Barrel** `src/application/commands/index.ts` — export `bindNotesNamespace`,
  `NotesNamespace`, and the input/result types (alphabetical slot between the
  `merge-namespace` and `rebase-namespace` exports).
- **Facade** `src/repository.ts` — add `readonly notes: commands.NotesNamespace`
  to the `Repository` interface (alphabetical, after `nameRev`, before `pull`) and
  `notes: commands.bindNotesNamespace(ctx, guard)` to the frozen object (after the
  `merge` binding).
- **Repository keys test** `test/unit/repository/repository.test.ts` — add
  `'notes'` to the command-name array (before `'primitives'`) **and** to the
  namespace-keys set (with `'tag'`, `'branch'`, …).
- **README** `README.md:46` — bump `42 Tier-1 commands` → `43`.
- **Docs** `docs/use/commands/README.md` — bump the count (`42 entries` → `43`),
  add an index row `| [`notes`](notes.md) | … |`, and add `docs/use/commands/notes.md`
  (the `tag.md` signature-block shape). `docs/design/commands.md` line 189 ("Notes …
  v2.") is updated to reflect that notes has landed.
- **api.json** `reports/api.json` — regenerate via `npm run check:doc-typedoc`
  (prepush gate; the typedoc-id churn is expected).
- **Browser/parity surface** `test/browser/surface-parity.spec.ts` (+ a
  `test/parity/scenarios/notes.scenario.ts`) — add a `notes` namespace block
  invoking `add`/`read`/`list`/`remove`, projecting to oids/counts (no rendered
  strings), runnable on node/memory/browser.

## 9. Error codes & refusal mapping

New members of the `CommandError` union (`src/domain/commands/error.ts`) with
factory functions, each mapping a pinned refusal (§4.4) / divergence (§10) to
structured data — never a pre-rendered git line.

| Code | Data | Raised by | git analogue |
| --- | --- | --- | --- |
| `NOTES_ALREADY_EXIST` | `{ object: ObjectId }` | `add` (no force, note present) | `error: Cannot add notes. Found existing notes for object <oid>. Use '-f' to overwrite existing notes` |
| `NOTES_OBJECT_HAS_NONE` | `{ object: ObjectId }` | `remove` (no note) | `Object <oid> has no note` |
| `NOTES_FANOUT_UNSUPPORTED` | `{ ref: RefName; entryCount: number }` | `add` / `remove` (write crosses, or touches an already-fanned, tree — §10) | (tsgit divergence — git would fan out; §10/§13) |

Mapping notes:
- `add`'s existence check is computed directly (fanout-aware lookup), so the
  refusal is raised explicitly rather than caught from `updateRef`. (Unlike `tag`,
  the conflict is on a tree entry, not a CAS ref write — the notes ref itself is
  not CAS-guarded by git.)
- `read` on an absent note is **not** an error — it returns `null` (Decision B),
  mirroring the structured-absence precedent (`bisect` returns `undefined` for "no
  midpoint"). The caller reconstructs git's `error: no note found …` if it wants
  the porcelain.
- An unresolvable `object` propagates the existing `resolveRef`/object-read error
  (`REF_NOT_FOUND` / unexpected-type) — no new code.

## 10. The fanout decision (load-bearing) & write boundary

**The fact (pinned).** A notes tree is FLAT (full-40-hex entry names) until a
threshold, then flips to a uniform one-byte fanout (`XX/<38-hex>`, recursively).
The flip is **distribution-dependent, not a fixed count** (observed flips at
N=80 and N=99 for different oid distributions) and **sticky** (removing notes back
below the flip does **not** collapse to flat). This is git's in-memory 16-way
nibble-trie plus load-time fanout detection in `notes.c`. Reproducing it
byte-for-byte at all N is a genuine port with reverse-engineering risk; the FLAT
common case is trivially byte-faithful.

**The recommended scope (Decision A, option 1): faithful flat WRITE + faithful
READ of any fanout.**

- **READ (`read`, `list`)** descends arbitrary fanout via `walkTree` (de-slashing
  leaf paths back to 40-hex oids), so tsgit interoperates with large,
  git-produced fanned notes refs — no divergence on the read side.
- **WRITE (`add`, `remove`)** rebuilds and writes a **flat** tree. Every write
  tsgit *accepts* is byte-identical to git. A write is **refused** (structured
  `NOTES_FANOUT_UNSUPPORTED`, the lean sub-option) precisely when it could not be
  byte-faithful: (a) the **current** tree is already fanned — for **both** `add`
  and `remove`, since rewriting a fanned tree flat would drop git's sticky fanout
  structure (tsgit cannot reproduce git's incremental-preserve fanout on
  rewrite); or (b) for `add`, the rebuilt flat tree would exceed
  `NOTES_MAX_FLAT_ENTRIES` — a conservative constant set **strictly below** git's
  minimum observed flip, pinned by a focused probe sweep during implementation, so
  tsgit **never silently emits a tree git would have fanned**. A `remove` that
  shrinks a **flat** tree is always allowed (it cannot cross the flip upward and
  the result stays flat). A possible refinement — structural-preserve `remove` on
  a fanned tree (drop one leaf, prune an emptied `XX/` subtree, keep the rest of
  the fanout) — is byte-faithful without porting flip detection (no flip happens
  on remove; fanout is sticky) and is noted as a parking-lot sub-option, but A
  keeps all writes flat-only for one uniform boundary.

This is an honest boundary: faithful in the overwhelmingly common case,
interoperable on read, and a *refusal* (never a wrong tree) at the edge.
Full fanout-on-write is a parking-lot follow-up (option 2). Rejected: option 3
(flat-only, cannot read fanned trees — no real-world interop).

## 11. Faithfulness interop-test plan

New file `test/integration/notes-interop.test.ts` (cross-tool harness), one
shared seeded repo in `beforeAll`, real `git` spawned with `GIT_*` scrubbed,
isolated `HOME`, `GIT_CONFIG_NOSYSTEM=1`, signing OFF, deterministic dates, 60s
timeout. Each pinned fact in §4 is reconstructed from the structured result and
diffed against real git:

1. **add → byte-identical store.** `repo.notes.add` then assert, against
   `git`-produced goldens for the same object+bytes: the **tree** oid and the
   **note blob** oid byte-for-byte (both timestamp-free), and the notes-commit's
   parsed `tree`/`parent`/`message`/`author`==`committer` fields. The notes-commit
   **oid** is asserted byte-identical only with committer identity **and** date
   pinned to git's — the harness's standard clock/identity control for
   commit-producing interop tests (`resolveCurrentIdentity` reads the system clock;
   `Context` exposes no clock port, so the test fixes the date the same way the
   `commit`/`tag` interop tests do). Cross-check: a repo built by tsgit `add` is
   read correctly by real `git notes show`/`list`, and a repo built by real
   `git notes add` is read by tsgit `read`/`list`.
2. **parent chaining + sorted multi-entry tree** — two adds produce a child notes
   commit and a two-entry oid-sorted tree, matching git.
3. **force** — `add({ force: true })` overwrites; notes-commit message is still
   `Notes added by 'git notes add'`; reflog `notes: Notes added by 'git notes add'`.
4. **reflog** — add/force/remove reflog lines match §4.2 exactly.
5. **remove + empty-tree-on-last** — remove one (others remain); remove the last →
   tree oid `4b825dc642cb6eb9a060e54bf8d69288fbee4904`, ref **not** deleted,
   commit message `Notes removed by 'git notes remove'`.
6. **list / read parity** — reconstruct `git notes list`'s
   `<note-blob> <annotated-oid>` lines (oid-sorted) and `git notes show`'s bytes
   from the structured results.
7. **refusal parity** — add-on-existing (no force) → `NOTES_ALREADY_EXIST`
   reconstructs the exact §4.4 line + exit 1; remove-on-missing →
   `NOTES_OBJECT_HAS_NONE` reconstructs `Object <oid> has no note` (no `error:`
   prefix) + exit 1.
8. **fanout READ** — build a large notes ref with real `git` until it fans out;
   tsgit `list`/`read` return the same pairs/bytes as git (proves fanout read).
9. **fanout WRITE boundary** — adding past `NOTES_MAX_FLAT_ENTRIES`, or onto a
   git-fanned tree, throws `NOTES_FANOUT_UNSUPPORTED` (documents the §10
   divergence); every accepted write below the boundary is byte-identical to git.
10. **ref override** (Decision D) — `ref: 'refs/notes/custom'` (and, if adopted,
    `core.notesRef` via config) targets the right ref, matching §4.5.

Per the project rule, cross-adapter parity tests do **not** prove faithfulness —
only this interop harness does; a `notes.parity` scenario (§8.2) covers
cross-adapter behaviour separately.

## 12. Property tests

The notes verbs are **orchestration over existing primitives**, not a new
parser/decoder/matcher, so the four property-test lenses (round-trip,
compositional matcher, total function over a grammar, idempotence/counting) do not
fit the command code, and no `*.properties.test.ts` is warranted in this slice —
the existing `tree`/`object` serializers already carry their own property tests.
**If** option 2 (full fanout-on-write, §13 Decision A) is later taken, the fanout
**path construction** (oid ↔ `XX/yy/…` nibble split, and `parse(serialize) ≡ id`) is a
genuine round-trip/total-function pair and would ship a property sibling then.

## 13. Decision-candidates

Load-bearing choices not pre-decided by an existing ADR. The user owns them in the
decisions phase; recommendations are advisory.

### A. Fanout scope (the load-bearing decision)

How far to reproduce git's flat→one-byte fanout:

1. **Faithful flat WRITE + faithful READ of any fanout** — byte-identical below
   git's flip (the common case), reads git-produced fanned trees, refuses a write
   that could not be byte-faithful (§10).
2. **Full faithful fanout port** — reproduce `notes.c`'s trie + sticky,
   distribution-dependent fanout byte-for-byte at all N (large effort + reverse-
   engineering risk).
3. **Flat-only** — cannot read git-fanned trees (no real-world interop).

**Recommendation: 1**, with the **refuse** sub-option (below). It is the honest
shippable boundary; 2 is the parking-lot follow-up; 3 is rejected (no interop).

**Sub-decision (only if A1): write that would cross the flat boundary.**
(a) refuse with a structured `NOTES_FANOUT_UNSUPPORTED` (never emit a tree that
diverges from git); (b) keep writing flat (functional, but diverges from git's
bytes once past the flip). **Recommend (a)** — a refusal is a safe, documented
divergence; silently emitting a flat tree where git would fan out violates the
prime directive. The conservative `NOTES_MAX_FLAT_ENTRIES` constant (strictly
below git's minimum observed flip) is pinned empirically in implementation.

### B. `read` on an absent note — `null` vs throw

(a) return `null`; (b) throw a structured `NOTES_OBJECT_HAS_NONE`. **Recommend
(a)** — "no note" is a normal query outcome (git `notes show` exits 1 with a
message, but as a *query* the structured-absence precedent is `bisect`'s
`undefined`); `remove`'s absence is a refusal because it is a *mutation* that
cannot proceed, so the asymmetry is principled (CQS: a query reports absence, a
command refuses an impossible mutation).

### C. `read` return — bytes inline vs oid-only

(a) `{ object, note, content }` (blob oid **and** bytes); (b) `{ object, note }`
(oid only — caller calls `readBlob`). **Recommend (a)** — `git notes show`
surfaces the content; one round-trip is ergonomic and the bytes are small;
`list` already gives oid-only pairs for the bulk case, so inline bytes on the
single-object `read` is the complementary shape. (b) if strict
oid-only/minimal-IO is preferred.

### D. Notes-ref selection — explicit `ref` only vs honour `core.notesRef` / `GIT_NOTES_REF`

(a) explicit `ref` param only (default `refs/notes/commits`); (b) also honour
`core.notesRef` (read via the existing `readConfig`); (c) also honour
`GIT_NOTES_REF` (env > config > default — git's precedence, both pinned working in
§4.5). **Recommend (b)** as the faithful-and-feasible choice — `core.notesRef` is
reachable through the established config path, and an explicit `ref` param
overrides it. **Caveat that scopes (c):** `Context` exposes **no** process-env
accessor (confirmed: no `env` field), and tsgit is portable (browser/memory have
no `process.env`); honouring `GIT_NOTES_REF` would require a new `Context`
capability and is therefore an escalation, not a free add — defer it unless the
user wants the env port introduced. (a) is the minimal surface if config coupling
is judged out of scope for a data library.

### E. `add` input — `force` flag shape

(a) `force?: boolean` (overwrite), mirroring `git notes -f` and `tagCreate`'s
`force`; (b) a richer mode enum (`'fail' | 'overwrite' | 'append'`) anticipating
`git notes append`. **Recommend (a)** — `append` is a separate verb in git
(`git notes append`) and out of scope here; a boolean `force` matches the pinned
add/-f behaviour and the existing `tag` precedent. Revisit if `append` is
scheduled.

### F. `content` type — `Uint8Array` vs `string`

(a) `Uint8Array` (binary-faithful, matches the blob boundary and `readBlob`);
(b) `string` (UTF-8 convenience). **Recommend (a)** — notes blobs can hold
arbitrary bytes; the boundary is bytes (ADR-249 puts text encoding/normalisation
on the caller). `read` returns `Uint8Array` symmetrically.

### G. Naming

| element | options | recommendation |
| --- | --- | --- |
| namespace | `notes` | `notes` (matches `git notes`) |
| verbs | `add` / `read` / `list` / `remove` vs `show` for read | `add`/`read`/`list`/`remove` — `read` reads cleaner than git's porcelain `show`; the brief names `read` |
| result types | `NotesAddResult` / `NotesReadResult` / … | as listed (§6) |
| error codes | `NOTES_ALREADY_EXIST` / `NOTES_OBJECT_HAS_NONE` / `NOTES_FANOUT_UNSUPPORTED` | as listed (§9) |
| flat cap constant | `NOTES_MAX_FLAT_ENTRIES` | as listed (§10) |

## 14. Non-goals (deferred; divergences noted)

- **Fanout-on-write** (option 2, §13 Decision A) — writing a tree at/above git's
  flip point; the parking-lot follow-up. Until then, such writes are *refused*
  (§10), not wrong.
- **Porcelain note normalisation** — trailing-newline insertion, multi-`-m`
  blank-line join, `stripspace`, and **empty-input-means-remove** (§4.7). The
  library stores caller bytes verbatim (§5); the one principled divergence from
  `git notes add -m ""` is intentional (ADR-249).
- **Other `git notes` subcommands** — `append`, `copy`, `edit`, `merge`,
  `prune`, `get-ref`, and `notes.rewriteRef` rewrite-on-amend integration.
- **Notes display integration** — `log --notes`, `notes.displayRef`,
  `--show-notes`; pure rendering, the caller's (ADR-249).
- **`remove --ignore-missing` / batch remove (`--stdin`)** — the refusal is
  faithful as-is; ignore-missing is a later flag.

---

_Provenance: backlog 24.7._
