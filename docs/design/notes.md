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

In scope for this slice: the notes ref selection rule (explicit `ref` →
`GIT_NOTES_REF` → `core.notesRef` → default `refs/notes/commits`, ADR-433, §10),
the **full faithful fanout** of the notes tree — byte-for-byte identical tree /
commit / ref at **all N**, **reading and writing**, across add/remove/force
sequences (ADR-432, §11) — the notes **commit** mechanics (fixed messages,
parent chaining, identity), the **reflog** entries, the **refusal** conditions,
and the empty-tree-on-last-remove behaviour — all pinned byte-for-byte against
real `git` in §4.

Out of scope (call-outs in §14): the porcelain message-normalisation `git notes`
applies to `-m`/`-F`/editor input (trailing-newline insertion, multi-`-m`
blank-line join, `stripspace`, empty-input-means-remove) — that is the caller's,
per ADR-249 (§5); `notes copy`/`append`/`edit`/`merge`/`prune`/`get-ref`, the
`notes.rewriteRef` rewrite-on-amend integration, and the
`notes.displayRef`/`log --notes` display integration.

This design obeys two project directives verbatim:

- **Git-faithfulness (prime directive, ADR-226).** The notes-commit messages,
  the tree shape and entry encoding (including the full fanout, §11), the
  ref/reflog contents, the empty-tree oid, and the refusal conditions are pinned
  against real `git` 2.54.0 in §4 and become cross-tool interop tests (§12).
  Nothing here is described from memory.
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
| Write a blob/commit object; build a tree from entries | `writeObject`, `createCommit`, `writeTree(ctx, TreeEntry[])` | `src/application/primitives/{write-object,create-commit,write-tree}.ts` |
| Read a tree's entries / walk a tree of arbitrary fanout depth | `readObject` (→ `Tree.entries`), `walkTree` | `src/application/primitives/{read-object,walk-tree}.ts` |
| Read a note blob's bytes by oid | `readBlob(ctx, id) → Blob` | `src/application/primitives/read-blob.ts` |
| Current author==committer identity (config `[user]` + now) | `resolveCurrentIdentity(ctx)` | `src/application/commands/internal/current-identity.ts` |
| `TreeEntry` shape (`{ mode, name, id }`), canonical git tree sort | `TreeEntry`, `sortTreeEntries` | `src/domain/objects/tree.ts` |
| Structured command errors (union + factories) | `CommandError`, `tagExists`/`tagNotFound` | `src/domain/commands/error.ts` |
| Read a single config value (`core.notesRef`) | `readConfigEntry` / `loadConfigEntry` | `src/application/primitives/config-read.ts` |
| **Optional capability on `Context`** (the model for the new env port, §10) | `command?: CommandRunner` — wired by the node adapter, stub-absent on browser/memory | `src/ports/context.ts`, `src/adapters/node/node-adapter.ts` |
| Port **contract test** reused across adapters | `compressorContractTests(createSut)` etc. | `test/unit/ports/*.contract.ts` |
| Namespace facade wiring | `bindTagNamespace(ctx, guard)` at `repository.ts` | `src/repository.ts` |

`tag` is the canonical precedent for the namespace surface, the
force-vs-`expected:'absent'` write, and the conflict→refusal mapping. `writeTree`
+ `createCommit` + `updateRef` are the exact primitives that build a notes
commit. `command?: CommandRunner` is the precedent for the new optional
environment capability (§10): an optional `Context` field, populated by the node
adapter and stubbed absent on the portable adapters. The **fanout trie** (§11) is
the one piece of genuinely new machinery — a pure domain module — but it still
emits `TreeEntry[]` consumed by the existing `writeTree`.

## 3. The notes store (on-disk model)

```
refs/notes/<name>   ──▶  commit ──▶ tree ──▶ entries
                          │            │
                          │            ├─ 100644 <annotated-oid> ─▶ note blob   (FLAT, below the flip)
                          │            ├─ 040000 <2-hex>/         ─▶ fanout subtree (recursive, above the flip)
                          │            └─ …                          (git tree-entry sort order)
                          parent = previous notes commit (root if first)
                          author == committer == current identity
                          message = "Notes added by 'git notes add'"  (add/force)
                                  | "Notes removed by 'git notes remove'"  (remove)
```

- **Default ref** `refs/notes/commits`; selected per call by precedence
  explicit `ref` → `GIT_NOTES_REF` → `core.notesRef` → default (ADR-433, §10).
- The notes **tree** maps an annotated object's oid → its note blob. git keeps
  the tree **flat** (one entry `100644 <full-hex> <note-blob>`) until a
  distribution-dependent point, then reorganizes it into a recursive **one-byte
  (two-hex) fanout** (`XX/<remaining-hex>`). tsgit reproduces **both** layouts
  byte-for-byte, reading and writing, via the trie algorithm in §11.
- Every mutation (add/force/remove) **commits a new notes commit** whose parent
  is the previous notes commit (or no parent for the very first), and moves the
  ref. The note blob is created with the caller's bytes verbatim.
- **Removing the last note commits the empty tree**
  (`4b825dc642cb6eb9a060e54bf8d69288fbee4904`); the ref is **not** deleted.

## 4. Pinned git behaviour (real `git` 2.54.0, isolated `HOME`, `GIT_*` scrubbed, `GIT_CONFIG_NOSYSTEM=1`, signing OFF, pinned author/committer dates)

All facts below were produced in a `mktemp -d` throwaway repo (never the
worktree). These are the faithfulness goldens; each becomes an interop assertion
(§12). Faithfulness binds the **data and on-disk state** (oids, tree bytes, ref,
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
    100644 blob <note-blob>   388733f5…  (full-hex annotated oid, FLAT)
note blob bytes:  h e l l o   n o t e \n     ← exactly the input + git's one trailing \n (porcelain, §5)
```

- **Parent chaining** (pinned): a second `notes add` on a different object
  produces a notes commit whose `parent` is the first notes commit; the tree
  carries **both** entries, in git tree-entry sort order.
- The **tree** oid and the **note blob** oid are deterministic (pure functions of
  the entries / bytes) and are pinned byte-for-byte. The notes **commit** oid is
  timestamp-dependent (it embeds the committer date), so it is byte-identical to
  git's only when identity **and** commit date are pinned to git's — see §12.1.
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
                              tree keeps the other entries (fanout structure preserved — §11.5).
remove the LAST note:         tree becomes the empty tree 4b825dc642cb6eb9a060e54bf8d69288fbee4904
                              (git hash-object -t tree /dev/null); ref NOT deleted; commit still made.
```

### 4.4 Refusal conditions (exact bytes, exit 1)

| Trigger | git stderr (exact) | exit |
| --- | --- | --- |
| `add` on an object that already has a note, no `-f` | `error: Cannot add notes. Found existing notes for object <oid>. Use '-f' to overwrite existing notes\n` | 1 |
| `remove` on an object with no note | `Object <oid> has no note\n` (**no** `error:` prefix) | 1 |

> The remove-missing message is `Object <oid> has no note` — there is **no**
> `error:` prefix (pinned via `od -c` on captured stderr). `add -f` succeeds
> (overwrite); `git notes remove --ignore-missing` would suppress the second
> refusal but is out of scope.

### 4.5 Ref selection (ADR-433)

`GIT_NOTES_REF=refs/notes/custom git notes add …` writes `refs/notes/custom`;
`git config core.notesRef refs/notes/via-config` then `git notes add …` writes
`refs/notes/via-config`; an explicit `git notes --ref=…` argument overrides both.
Precedence (pinned working): **explicit arg > `GIT_NOTES_REF` env > `core.notesRef`
config > default `refs/notes/commits`** (§10).

The three sources differ in handling (pinned, real `git` 2.54.0):

| source | input | result | exit |
| --- | --- | --- | --- |
| `--ref` | `build` | `refs/notes/build` | 0 |
| `--ref` | `notes/x` | `refs/notes/x` | 0 |
| `--ref` | `refs/heads/evil` | `refs/notes/refs/heads/evil` (no branch created) | 0 |
| `GIT_NOTES_REF` / `core.notesRef` | `build` | `fatal: refusing to add notes in build (outside of refs/notes/)` | 128 |
| `GIT_NOTES_REF` / `core.notesRef` | `notes/x` | `fatal: refusing to … notes in notes/x (outside of refs/notes/)` | 128 |
| `GIT_NOTES_REF` / `core.notesRef` | `refs/notes/build` | writes `refs/notes/build` | 0 |

So `--ref` is **expanded** into the namespace (`expand_notes_ref`), while
env/config are taken **verbatim** and **refused** when outside `refs/notes/` (the
refusal verb tracks the subcommand: `add`/`list`/`show`/…). §10/§9.

### 4.6 List / read shapes

```
$ git notes list             ← one "<note-blob-oid> <annotated-oid>" line per note, sorted by annotated oid (= tree order)
$ git notes show <obj>       ← the note blob content
```

### 4.7 Fanout (pinned; tsgit reproduces it — §11)

```
N annotated objects, flat until a threshold, then a recursive one-byte fanout:
  flat:    100644 <40-hex>            <note-blob>
  fanned:  040000 <2-hex>/            <subtree>   →  100644 <38-hex> <note-blob>  (recursive)
flip point:  distribution-dependent (observed N=80 for one oid set, N=99 for another), NOT a fixed count
stickiness:  removing notes back below the flip does NOT collapse fanned → flat (the fanout is sticky)
```

The flip is git's in-memory 16-way nibble-trie + `determine_fanout` heuristic in
`notes.c`; tsgit reimplements the *behaviour* in §11 (clean-room, MIT — §11.11).

### 4.8 Porcelain normalisation observed (NOT replicated — caller's, §5)

- `-m "x"` stores `x\n`; input already ending in `\n` is **not** doubled;
  multiple `-m` join with a blank line (`\n\n`).
- `-m ""` (empty after `stripspace`) is treated by git as a **removal** (`exit 0`,
  stderr `Removing note for object <oid>`), not as an empty-blob note.

These are git porcelain message-normalisation steps. Under ADR-249 they are the
**caller's** responsibility; the library stores the bytes it is given (§5).

## 5. Note blob bytes — verbatim, caller owns normalisation (ADR-249, ADR-431)

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
`git notes add -m ""` *porcelain* is recorded as a non-goal (§14, ADR-431).

## 6. Structured data shapes (ADR-249-clean, ADR-431 surface)

All oids are `ObjectId`; the notes-ref name is a `RefName`; note bytes are
`Uint8Array`. No rendered strings, no message normalisation, no pre-formatted
lines. The result shapes are exactly those ratified in ADR-431.

```ts
const DEFAULT_NOTES_REF = 'refs/notes/commits' as RefName;

interface NotesAddInput {
  readonly object: string;        // commit-ish / oid to annotate (resolved like tagCreate's target)
  readonly content: Uint8Array;   // note bytes, stored verbatim (§5)
  readonly force?: boolean;       // overwrite an existing note (git notes -f)
  readonly ref?: string;          // notes-ref override; selection rule §10 / ADR-433
}
interface NotesAddResult {
  readonly notesCommit: ObjectId; // new notes-ref commit oid
  readonly note: ObjectId;        // note blob oid
}

interface NotesReadInput {
  readonly object: string;
  readonly ref?: string;
}
// null when the object has no note (ADR-431)
type NotesReadResult = {
  readonly object: ObjectId;
  readonly note: ObjectId;        // note blob oid
  readonly content: Uint8Array;   // note bytes inline (ADR-431)
} | null;

interface NotesListInput {
  readonly ref?: string;
}
// bare array, git tree order (ADR-431)
type NotesListResult = ReadonlyArray<{ readonly object: ObjectId; readonly note: ObjectId }>;

interface NotesRemoveInput {
  readonly object: string;
  readonly ref?: string;
}
interface NotesRemoveResult {
  readonly notesCommit: ObjectId; // new notes-ref commit oid (empty-tree commit on last remove)
}
```

The `git notes list` / `git notes show` display and the refusal lines are
reconstructed from these fields in the interop test (§12), never emitted here.

## 7. The verbs, composed from primitives + the notes-tree module

Each verb is a `Context`-aware function in `src/application/commands/notes.ts`,
behind `bindNotesNamespace(ctx, guard)` in
`src/application/commands/internal/notes-namespace.ts` (the `tag` shape). The
notes ref is resolved by the §10 selection rule. A pair of ctx-aware primitives
bridge the object store to the pure fanout trie (§11): `loadNotesTree` (reads the
notes tree into the trie, unpacking lazy subtrees on demand via `readObject`) and
`writeNotesTree` (walks the mutated trie and persists it bottom-up via `writeTree`).

**`add`**
1. `assertOperationalRepository`; resolve `object` → `ObjectId` (oid-regex else
   `resolveRef`, as `tagCreate` resolves its target).
2. Resolve the notes ref (§10). Load it (`resolveRef(ref)`; `REF_NOT_FOUND` →
   empty trie). Look up `object` in the trie (fanout-aware lookup over the loaded
   path). If present and `force !== true` → throw `notesAlreadyExist(object)` (§9).
3. `writeObject(blob{ content }) → noteOid`.
4. **Insert** `(object → noteOid)` into the trie (insert/split on collision,
   overwrite on same key — §11.4).
5. `writeNotesTree(trie)` → `treeOid` (walk-for-write rebuilds the possibly-fanned
   tree bottom-up in git tree-entry sort order — §11.7/11.9).
6. `createCommit({ tree: treeOid, parents: prevCommit ? [prevCommit] : [],
   author: id, committer: id, message: NOTES_ADD_MESSAGE })` with
   `id = resolveCurrentIdentity(ctx)`.
7. `updateRef(ref, notesCommit, { reflogMessage: NOTES_ADD_REFLOG })`
   (`reflogMessage = "notes: " + NOTES_ADD_MESSAGE`).

**`remove`**
1. Resolve `object`; resolve + load the notes ref (absent → throw
   `notesObjectHasNone(object)` — nothing to remove).
2. If no entry for `object` in the trie → throw `notesObjectHasNone(object)`.
3. **Remove** the note from the trie and consolidate up the loaded path; lazy
   sibling subtrees are untouched, so an already-fanned tree stays fanned
   (stickiness — §11.5). Empty result → the empty-tree oid via `writeTree([])`.
4. `writeNotesTree(trie)` → `treeOid`.
5. `createCommit({ tree, parents: [prevCommit], …, message: NOTES_REMOVE_MESSAGE })`.
6. `updateRef(ref, notesCommit, { reflogMessage: NOTES_REMOVE_REFLOG })`. The ref
   is **never** deleted (§4.3).

**`read`**
1. Resolve `object`; resolve + load the notes ref (absent → `null`).
2. Fanout-aware lookup of the entry for `object`; absent → `null` (ADR-431).
3. `readBlob(noteOid)` → `{ object, note: noteOid, content }`.

**`list`**
1. Resolve + load the notes ref (absent → `[]`).
2. `walkTree(notesTree)` (handles any fanout depth, yields leaf paths
   `XX/yy/…/rest`); de-slash each path → the full-hex annotated oid; pair with the
   leaf blob id. Non-note entries (§11.3) are skipped for `list`/`read` but
   preserved on write.
3. Sort by annotated-object oid ascending (= git's tree order); return the array.

Notes-commit messages and reflog strings are named constants
(`NOTES_ADD_MESSAGE`, `NOTES_REMOVE_MESSAGE`, `NOTES_ADD_REFLOG`,
`NOTES_REMOVE_REFLOG`) — no magic strings, no provenance refs in code. The
message constants must be byte-faithful to git's stored commit message
(including git's single trailing newline — the exact byte handling is the commit
serializer's, pinned in interop §12.1).

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

**Command-surface gates:**

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

**Port gates (new env capability, ADR-433 / §10):**

- **Port** `src/ports/env-reader.ts` — a narrow interface (single named-var read,
  returns `string | undefined`); export its type from `src/ports/index.ts`
  (alphabetical, with the other port types).
- **`Context`** `src/ports/context.ts` — add the optional capability to `Context`
  and `CreateContextParts` (the `command?: CommandRunner` pattern: optional field,
  absent ⇒ "unset everywhere").
- **Node adapter** `src/adapters/node/node-env-reader.ts` — reads `process.env`;
  wired in `node-adapter.ts` as the `command` runner is
  (`…: new NodeEnvReader()`).
- **Browser adapter** `src/adapters/browser/` — stub that always returns
  `undefined` (no `process.env`; a faithful "unset").
- **In-memory adapter** `src/adapters/memory/` — same always-absent stub.
- **Port contract test** `test/unit/ports/env-reader.contract.ts` — the
  `compressorContractTests(createSut)` shape; asserts the narrow contract (named
  var present → its value; absent → `undefined`), reused by each adapter's unit
  test (node returns real env; browser/memory return `undefined`).

**Fanout trie gates (new domain module, ADR-432 / §11):**

- **Domain module** `src/domain/notes/` (pure, zero platform deps) — the trie
  type, insert/remove/consolidate, `determineFanout`, `constructPathWithFanout`,
  load-from-entries, and walk-for-write emit (§11). Plus the ctx-aware bridge
  primitives `loadNotesTree`/`writeNotesTree` in `src/application/primitives/`.
- **Property test** `src/domain/notes/<module>.properties.test.ts` (§13) — the
  `constructPathWithFanout` / load↔write round-trip and the load-totality/
  non-note-preservation invariants, with a shared `arbitraries.ts`.

## 9. Error codes & refusal mapping

New members of the `CommandError` union (`src/domain/commands/error.ts`) with
factory functions, each mapping a pinned refusal (§4.4) to structured data —
never a pre-rendered git line.

| Code | Data | Raised by | git analogue |
| --- | --- | --- | --- |
| `NOTES_ALREADY_EXIST` | `{ object: ObjectId }` | `add` (no force, note present) | `error: Cannot add notes. Found existing notes for object <oid>. Use '-f' to overwrite existing notes` |
| `NOTES_OBJECT_HAS_NONE` | `{ object: ObjectId }` | `remove` (no note) | `Object <oid> has no note` |
| `NOTES_REF_OUTSIDE` | `{ ref: string }` | any verb (`GIT_NOTES_REF`/`core.notesRef` outside `refs/notes/`, §10) | `fatal: refusing to <subcommand> notes in <ref> (outside of refs/notes/)` |

Mapping notes:
- `add`'s existence check is computed directly (fanout-aware trie lookup), so the
  refusal is raised explicitly rather than caught from `updateRef`. (Unlike `tag`,
  the conflict is on a tree entry, not a CAS ref write — the notes ref itself is
  not CAS-guarded by git.)
- `read` on an absent note is **not** an error — it returns `null` (ADR-431),
  mirroring the structured-absence precedent (`bisect` returns `undefined` for "no
  midpoint"). The caller reconstructs git's `error: no note found …` if it wants
  the porcelain.
- An unresolvable `object` propagates the existing `resolveRef`/object-read error
  (`REF_NOT_FOUND` / unexpected-type) — no new code. A malformed notes-ref value
  (from any precedence source, §10) still propagates the existing ref-name
  validation error. The one new code, `NOTES_REF_OUTSIDE`, is the env/config
  out-of-namespace refusal (§10): explicit `--ref` values are expanded into
  `refs/notes/` so they never trigger it; only verbatim `GIT_NOTES_REF`/
  `core.notesRef` values can.

There is **no** fanout-related error: the fanout is reproduced faithfully on
write (ADR-432), so there is no boundary to refuse.

## 10. Notes-ref selection & the environment capability (ADR-433)

**Precedence (pinned §4.5, byte-for-byte git):**

```
explicit `ref` arg  →  GIT_NOTES_REF (env)  →  core.notesRef (config)  →  refs/notes/commits
```

Each verb resolves its ref once, before touching the store. The three sources are
**not** treated alike — this asymmetry is git's, pinned against real `git` 2.54.0,
not a tsgit choice:

1. If `input.ref` is given (git's `--ref`), **expand** it with git's
   `expand_notes_ref`: a `refs/notes/…` value is kept; a `notes/…` value only
   gains the `refs/` prefix; anything else is nested under `refs/notes/`. So
   `build → refs/notes/build`, `notes/x → refs/notes/x`, and even
   `refs/heads/evil → refs/notes/refs/heads/evil`. An explicit value can therefore
   **never escape** the notes namespace (no branch-hijack via `--ref`).
2. Else read `GIT_NOTES_REF` via the env capability; if defined, use it
   **verbatim** (git does not expand env/config) and **refuse** when it does not
   start with `refs/notes/`.
3. Else read `core.notesRef` via `readConfigEntry`/`loadConfigEntry`; if present,
   use it **verbatim** and **refuse** when outside `refs/notes/`.
4. Else the default `refs/notes/commits`.

The refusal in steps 2–3 reproduces git's
`fatal: refusing to <subcommand> notes in <ref> (outside of refs/notes/)`
(exit 128) — surfaced as the structured `NOTES_REF_OUTSIDE` code carrying the raw
ref (§9); the per-verb subcommand word is the caller's to render (ADR-249). The
expanded/verbatim value is then validated as a `RefName`; a malformed (but
inside-`refs/notes/`) value still refuses with the existing ref-name validation
error (§9). "Present" for the env var means **defined** (`string | undefined`): an
unset `GIT_NOTES_REF` falls through to config/default — the faithful outcome where
the environment has no such variable.

**The environment capability (a new port).** `Context` exposes **no** process-env
accessor today, and tsgit is portable (browser/memory have no `process.env`).
ADR-433 introduces a **minimal** environment-read capability — a narrow accessor
returning a single named variable or `undefined`, scoped to exactly what notes-ref
selection needs (not a general env bag). It follows the established
`command?: CommandRunner` optional-capability pattern (§2):

- **Port** `src/ports/env-reader.ts` — the narrow read interface.
- **`Context`** — an optional field on `Context` / `CreateContextParts`; absent ⇒
  "always unset" (so callers/tests need not provide it, and precedence falls
  through to config/default).
- **Node adapter** reads `process.env` (returns the value or `undefined`).
- **Browser + in-memory adapters** stub it as always-absent (`undefined`) — the
  faithful "unset" for an environment with no process env. There, precedence falls
  through to `core.notesRef`/default.

The full port surface (port type, three adapter implementations, contract test,
barrel + `Context` wiring) is enumerated in the §8.2 port gates. The architecture
pass should sanity-check the capability for minimality (ADR-433 flags this).

## 11. The full faithful fanout algorithm (ADR-432)

git keeps a notes tree **flat** until a distribution-dependent point, then
reorganizes it into a recursive one-byte fanout; the flip is **sticky** (§4.7).
This is git's in-memory 16-way nibble-trie + `determine_fanout` heuristic
(`notes.c`). tsgit reproduces the **behaviour** byte-for-byte at all N, reading
and writing, across add/remove/force sequences. The model below is the
clean-room spec the implementation follows; every clause is pinned by an interop
assertion (§12.8) so SHA drift is caught by the real binary, not by inspection.

> Convention: `fanout` is the on-disk fanout depth in **bytes** (0 = flat
> full-hex names; 1 = `XX/`+remaining-hex; 2 = `XX/XX/`+…). One on-disk byte = two
> trie nibble levels. `n` is the current nibble depth (0-based) from the start of
> the annotated oid.

### 11.1 In-memory model — a 16-way nibble trie

Each node has 16 slots, indexed by the hex nibble of the annotated oid at depth
`n`. A slot is one of:

- **empty**.
- **NOTE** leaf — `{ key = annotated oid, val = note-blob oid }`.
- **SUBTREE** leaf (lazy) — an on-disk fanout directory not yet loaded; carries
  the consumed prefix and its on-disk tree oid.
- **INTERNAL** — a nested 16-way node.

### 11.2 Load (on-disk tree → trie), per (sub)tree at byte-prefix `P`

For each tree entry with name `E`:

- `len(hex(P)) + len(E)` == full hex length **and** the entry is a blob (mode
  `100644`) → **NOTE**: key = `hex(P) + E`, val = entry oid.
- `E` is a directory whose name is exactly **2 hex chars** → **SUBTREE**
  placeholder (lazy), prefix = `P + E`. (git fans out only in 1-byte / 2-hex
  steps; lazy means its subtree bytes are *not* read until the algorithm needs
  that path.)
- anything else → **non-note** entry (e.g. a `README` committed into a notes
  tree): preserved verbatim, kept in sorted order, written back unchanged. Must
  be preserved for faithfulness (§12.8).

### 11.3 Non-note entries

A notes tree may legitimately carry a non-note tree entry. It is loaded as an
opaque preserved entry, ignored by `read`/`list`, and re-emitted unchanged at its
level on write so the rebuilt tree oid stays byte-identical to git's.

### 11.4 Insert (`add`, force-overwrite)

Walk nibbles from `n = 0`:

- empty slot → place the NOTE.
- slot holds a NOTE with the **same** key → combine (git default
  `combine_notes_overwrite` = overwrite the val). `add` without `force` is refused
  earlier (§9), so only `force` reaches this branch.
- slot holds a NOTE with a **different** key → **split**: create an INTERNAL node,
  demote the existing note into it at nibble `n+1`, then continue inserting the
  new note — recursing nibble-by-nibble until the two keys' nibbles differ (then
  both land in distinct slots).
- slot is INTERNAL → recurse at `n+1`.
- slot is SUBTREE → unpack it (load the on-disk subtree into the trie via
  `loadNotesTree`'s reader), then retry the slot.

### 11.5 Remove + consolidation + stickiness

Drop the note (set its val to null and remove it); then **consolidate walking
up**: an INTERNAL node holding ≤1 non-empty entry collapses back into that single
entry at its parent.

**Stickiness (critical, pinned §4.7):** consolidation only touches nodes **along
the loaded path**. Sibling SUBTREE placeholders are never loaded, so they remain
→ on write they still satisfy `determineFanout`'s "all 16 are subtree/internal"
test → the on-disk fanout does **not** collapse after removals. This reproduces
"removing back below the flip stays fanned."

### 11.6 `determineFanout(node, n, fanout) → new fanout` (the heart of it)

- if `n` is **odd**, or `n > 2 * fanout` → return `fanout` unchanged.
- else inspect all 16 slots: if **every** slot is SUBTREE or INTERNAL → return
  `fanout + 1`; otherwise (any empty or any NOTE present) → return `fanout`.

⇒ Flat (fanout 0) deepens to 1 only when **all 16 root nibble-buckets are
populated branches** — i.e. every nibble value 0–f holds ≥2 colliding notes
(coupon-collector-with-collision). This is exactly why the flip is
distribution-dependent and lands ≈ N=80–99 for random oids, not at a fixed count,
and why it is sticky (untouched lazy siblings keep re-satisfying the test).
Recurses per subtree.

### 11.7 Walk for write (`forEachNote`)

Recurse the trie; at each node call `determineFanout`. For each slot:

- INTERNAL → recurse at `n+1` (same fanout).
- NOTE → emit at path = `constructPathWithFanout(key, fanout)`, mode `100644`.
- SUBTREE → if `n < 2 * fanout`: emit it as a subtree directory (preserved, lazy —
  reuse its on-disk oid as-is, mode `040000`). If `n >= 2 * fanout`: unpack (load)
  it and re-process the slot (consolidate it up into this level).
- preserved non-note entries (§11.3) → emit unchanged at this level.

### 11.8 `constructPathWithFanout(oid, fanout)`

`fanout` leading bytes become `XX/` directory components; the rest is the
remaining hex. `fanout = 0` → full-hex flat name; `fanout = 1` → `ab/<rest>`;
`fanout = 2` → `ab/cd/<rest>`; etc.

### 11.9 Write the trees (bottom-up)

Build tree objects bottom-up from the emitted `(path, oid, mode)` stream: notes
are mode `100644` (blob), fanout dirs are mode `040000` (tree). Entries within
each tree object **must** be in git tree-entry sort order (byte sort, directory
names compared as if they carried a trailing `/`). tsgit's existing
`sortTreeEntries` / `writeTree` already implement git's tree sort, so fanout
dirs, flat note names, and preserved non-note entries interleave correctly
through it; the per-level entry set is what the trie walk produces. The top tree
oid is wrapped in the notes commit (§7).

### 11.10 Module split (hexagonal, pure core)

- **Pure domain** `src/domain/notes/` — the trie type and all decisions
  (`insert`, `remove`+consolidate, `determineFanout`, `constructPathWithFanout`,
  load-from-`TreeEntry[]`, walk-for-write emit). Zero platform deps; operates on
  branded oids and `TreeEntry[]`. Lazy-subtree loading is expressed as a
  caller-supplied reader callback so the domain stays pure (no I/O).
- **Ctx-aware primitives** `src/application/primitives/{load-notes-tree,write-notes-tree}.ts`
  — bridge the object store to the trie: `loadNotesTree` supplies the reader
  (`readObject`) that unpacks lazy subtrees on demand; `writeNotesTree` consumes
  the emit stream and persists trees bottom-up via `writeTree` (and the note blob
  via `writeObject` in the verb).

### 11.11 Licensing boundary (hard constraint, ADR-432)

tsgit is MIT; git is GPL-2.0. This is an **original TypeScript reimplementation
of the observed behaviour** — git's `notes.c` was read only to understand the
algorithm; **no source is copied**. Behaviour/algorithms are not copyrightable;
the specific C expression is. The faithfulness is pinned by interop tests against
the real `git` binary (§12), not by code lineage.

## 12. Faithfulness interop-test plan

New file `test/integration/notes-interop.test.ts` (cross-tool harness), one
shared seeded repo in `beforeAll`, real `git` spawned with `GIT_*` scrubbed,
isolated `HOME`, `GIT_CONFIG_NOSYSTEM=1`, signing OFF, deterministic dates, 60s
timeout. Each pinned fact in §4 is reconstructed from the structured result and
diffed against real git. The fanout tests (8) drive the **same operation
sequence** in both tools — order matters because the fanout is history-dependent.

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
   commit and a two-entry tree in git tree-entry order, matching git.
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
8. **full fanout, twin-tool, equal oids at all N** — drive the **same op
   sequence** in git and tsgit and assert equal notes-commit / tree / blob oids
   across:
   - **flat region** (N = 1..~50);
   - **flip region** (N ≈ 70..110 — must match git's exact, distribution-dependent
     flip for the seeded oid set, §4.7/§11.6);
   - **deep multi-level fanout** (N in the hundreds);
   - **add → remove → add stickiness** — remove back below the flip, assert the
     tree stays fanned exactly as git's does (§11.5);
   - **force-overwrite** inside a fanned tree;
   - **a preserved non-note tree entry** — a non-note entry committed into the
     notes tree survives every mutation unchanged (§11.3).
9. **ref selection** (ADR-433, §10) — `ref: 'refs/notes/custom'` targets that ref;
   `GIT_NOTES_REF` (node adapter, via a fixture env) and `core.notesRef` (config)
   each select the right ref, and explicit `ref` overrides both — matching §4.5
   precedence. On browser/memory the env source is always-unset (precedence falls
   through), which the parity scenario (§8.2) covers separately.

Per the project rule, cross-adapter parity tests do **not** prove faithfulness —
only this interop harness does; a `notes.parity` scenario (§8.2) covers
cross-adapter behaviour separately.

## 13. Property tests

The fanout trie is a genuine parser/serializer and matcher, so two of the four
property lenses (CLAUDE.md) fit — a `*.properties.test.ts` sibling ships with the
`src/domain/notes/` module (per-family generators in a shared `arbitraries.ts`):

- **Round-trip pair (lens 1)** — `constructPathWithFanout` ↔ the fanout-path
  parse (`load`'s de-slash of `XX/…/rest` back to a full-hex oid) is a
  serialize/parse pair: for an arbitrary oid and `fanout ∈ {0,1,2}`,
  `parse(constructPathWithFanout(oid, fanout)) ≡ oid`. And the trie load↔write
  round-trip: `write(load(tree)) ≡ tree` for an arbitrary git-shaped notes tree
  (modulo git's canonical tree sort, which `sortTreeEntries` owns).
- **Total function over a grammar (lens 3)** — `load` over any well-formed tree
  (notes, 2-hex fanout dirs, and arbitrary non-note entries) never throws and
  preserves every non-note entry; `write` of any loaded trie produces a
  sort-canonical tree.

`numRuns` follows the tiers: **200** for the cheap path round-trip, **100** for
the trie load↔write / totality invariants. The verb code (`notes.ts`) stays
orchestration with no algebraic structure, so it carries no property test — the
existing `tree`/`object` serializers carry their own.

## 14. Non-goals (deferred; divergences noted)

- **Porcelain note normalisation** — trailing-newline insertion, multi-`-m`
  blank-line join, `stripspace`, and **empty-input-means-remove** (§4.8). The
  library stores caller bytes verbatim (§5); the one principled divergence from
  `git notes add -m ""` is intentional (ADR-249/ADR-431).
- **Other `git notes` subcommands** — `append`, `copy`, `edit`, `merge`,
  `prune`, `get-ref`, and `notes.rewriteRef` rewrite-on-amend integration.
- **Notes display integration** — `log --notes`, `notes.displayRef`,
  `--show-notes`; pure rendering, the caller's (ADR-249).
- **`remove --ignore-missing` / batch remove (`--stdin`)** — the refusal is
  faithful as-is; ignore-missing is a later flag.

## 15. Decision-candidates — RESOLVED

All load-bearing choices for this slice were ratified by the user in the
decisions phase and recorded as ADRs; this design is the deviation fold-back. No
open forks remain.

| Was a candidate | Resolution | ADR |
| --- | --- | --- |
| Public surface (verb naming, `read`-absent `null`, `read` inline bytes, `force` boolean, `content: Uint8Array`, error codes) | Ratified as designed (§6/§8/§9) | ADR-431 |
| Fanout scope on write | **Full faithful fanout** at all N, reading and writing (§11) — supersedes the earlier flat-write + cap + `NOTES_FANOUT_UNSUPPORTED` refusal | ADR-432 |
| Notes-ref selection | **Honour `GIT_NOTES_REF`** via a new minimal `Context` env capability; precedence explicit → env → config → default (§10) | ADR-433 |

No new load-bearing question surfaced during this revision.

---

_Provenance: backlog 24.7; revised against ADR-431, ADR-432, ADR-433._
