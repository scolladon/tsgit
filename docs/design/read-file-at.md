# Design — `readFileAt(rev, path)`

## Goal

A read-model **ergonomics** pass, surfaced by the 23.4 API review (finding
**M1**). It lands one faithful, additive convenience for the single most common
viewer job — *"read a file's bytes as of a revision"*.

Today a consumer answering that question composes a five-step primitive dance by
hand:

```ts
const commit = await repo.revParse('HEAD');        // resolve rev → commit-ish oid
const obj    = await repo.primitives.readObject(commit);  // read the commit
const tree   = await repo.primitives.readTree(commit);    // peel commit → root tree
//   …then walk each `/`-separated path segment through sub-trees…
const blob   = await repo.primitives.readBlob(entryOid);  // read the addressed blob
```

`readFileAt` collapses that into one call and guarantees the addressed object is
a **blob** (not a directory), returning the file's bytes plus the tree-entry
metadata a viewer needs (oid + mode).

This is **purely additive** — no existing behaviour, SHA, ref, reflog, on-disk
state, refusal, or porcelain output changes. The only existing code that moves is
a **behaviour-preserving extraction**: `rev-parse`'s private `<tree-ish>:<path>`
descent is lifted into a shared primitive that both `rev-parse` and `readFileAt`
consume (DRY), proven invisible by `rev-parse`'s unchanged tests.

## Faithfulness anchors (git)

`readFileAt` reproduces what `git cat-file blob <rev>:<path>` (equivalently
`git show <rev>:<path>` for a blob) yields — the **raw committed bytes** of the
file addressed by `<path>` in the tree of `<rev>`:

- **Resolution** mirrors git's `<rev>:<path>` object name: resolve `<rev>` to a
  commit-ish, peel to its root tree, then descend `<path>`'s `/`-separated
  components through sub-trees to the addressed entry. This is the exact grammar
  `rev-parse`'s `resolveTreePath` already implements (the `tree-path` branch).
- **Refusals co-refuse with git:**
  - a path component that is **absent**, or an intermediate component that is a
    **non-tree** (a file used as a directory), → `PATH_NOT_IN_TREE` — git:
    `fatal: path '<path>' … does not exist in '<rev>'` / `… is not a tree`.
  - the final component addressing a **directory** (sub-tree) or a **gitlink**
    (submodule commit) → `UNEXPECTED_OBJECT_TYPE` (`expected: 'blob'`) — git:
    `git cat-file blob <rev>:<dir>` ⇒ `fatal: … not a blob`.
- **Bytes are verbatim** — the blob content is returned untouched (no
  EOL/`.gitattributes` smudge filtering; tsgit stores and returns canonical
  object bytes, consistent with `readBlob` / `show`'s blob arm).
- **mode** is the file's tree-entry mode (`100644` / `100755` / `120000`), the
  same value `git ls-tree` reports. For a symlink (`120000`) the "content" is the
  link target bytes — exactly what git stores in the blob — so the mode is what
  lets a caller tell a symlink from a regular file.

Pinned byte-for-byte by a `read-file-at-interop` cross-tool suite reconstructing
`git cat-file blob <rev>:<path>` (and its refusals) against real `git`.

## Decisions (ADR-262)

Two load-bearing choices, settled in **ADR-262**: a **Tier-1 command over the
full `revParse` grammar** (D1), returning **`{ id, mode, content }`** (D2). The
rest of the design is written against those.

### D1 — Tier & accepted `rev` grammar *(decided: Tier-1 command, full grammar)*

The backlog frames this as *"golden-path **convenience** for the #1 viewer job"*.
Convenience hinges on which `rev` forms resolve:

| form | example | resolves via |
|------|---------|--------------|
| `HEAD`, detached HEAD | `HEAD` | `readTree` ✓ / `revParse` ✓ |
| full ref path | `refs/heads/main` | `readTree` ✓ / `revParse` ✓ |
| full 40-hex oid | `a1b2…` | `readTree` ✓ / `revParse` ✓ |
| **short branch/tag name** | `main`, `v1.0` | **`revParse` only** |
| **navigation** | `HEAD~3`, `dev^2` | **`revParse` only** |
| **abbreviated oid** | `a1b2c3d` | **`revParse` only** |
| **reflog** | `@{yesterday}` | **`revParse` only** |

`readTree`/`resolveRef` resolve a ref **verbatim** (no candidate expansion), so a
primitive built on them rejects `main`, `v1.0`, `HEAD~3`, and abbreviated oids —
the forms a real viewer most wants. Only `revParse` (a Tier-1 command) carries
the full grammar.

- **(A) Tier-1 command `repo.readFileAt(rev, path)`, full `revParse` grammar.**
  *Recommended.* Maximally convenient — every form above works; mirrors `show`,
  which also resolves the full grammar then reads the object. Commands may import
  commands (`show` → `revParse` today), so this is idiomatic. Cost: it is
  porcelain-tier, not a Core primitive.
- **(B) Tier-2 primitive `repo.primitives.readFileAt(rev, path)`, commit-ish
  (`RefName | ObjectId`) only.** Mirrors 23.4b's `walkCommitsByDate` (a Core
  primitive) and the "4-call **primitive** dance" wording. Cost: `main` / `v1.0`
  / `HEAD~3` / abbreviated oids do **not** resolve — the user composes
  `revParse` first (back to a 2-call dance for those forms), undercutting the
  "convenience" goal.

The two are not mutually exclusive forever — (A) can later delegate to a (B)
primitive in the 23.4j convergence — but shipping **one** now per YAGNI, (A) is
the better single bet for a helper whose entire reason to exist is convenience.

### D2 — Return shape *(decided: `{ id, mode, content }`)*

- **(A) `{ id, mode, content }`.** *Recommended.* The blob oid, its tree-entry
  mode, and the raw bytes. `mode` is **free** (already read during descent) and
  is the only way a caller distinguishes a symlink/exec file from a regular one —
  exactly the metadata `git ls-tree` pairs with the bytes. Structured-data-only
  (ADR-249 compliant): plain fields, no rendered line.
- **(B) the `Blob` (`{ type, id, content }`).** Minimal, identical to `readBlob`.
  Drops `mode` — a follow-up the moment a caller needs symlink detection.

Returning `content` directly (not the whole `Blob` wrapper) keeps the result a
flat, purpose-built record; `type` is always `'blob'` by construction so it
carries no information.

## Surface (ADR-262)

```ts
// src/application/commands/read-file-at.ts
export interface ReadFileAtResult {
  /** The addressed blob's object id. */
  readonly id: ObjectId;
  /** The file's tree-entry mode (100644 / 100755 / 120000). */
  readonly mode: FileMode;
  /** The blob's raw bytes (verbatim committed content). */
  readonly content: Uint8Array;
}

export const readFileAt = async (
  ctx: Context,
  rev: string,
  path: string,
  options?: ReadObjectOptions,   // { verifyHash?, maxBytes? } — forwarded to the final blob read
): Promise<ReadFileAtResult> => { /* … */ };
```

- `rev` — any `revParse` expression (full grammar). Default-less: the caller
  passes the revision explicitly (a "read file at a rev" call with no rev is
  meaningless; `'HEAD'` is one keystroke).
- `path` — a `/`-separated tree path. An empty path descends to a segment named
  `''`, which no tree entry carries → `PATH_NOT_IN_TREE` (there is no file to
  read; the root-tree-for-empty-path shortcut is `rev-parse`'s concern, not a
  file reader's).
- `options.maxBytes` — bounds **only** the final blob read (the file). The DoS
  guard that matters for a viewer reading an arbitrary committed file; intermediate
  tree reads are small and use defaults. `verifyHash` likewise forwards to the
  blob read.

New binding `repo.readFileAt` (top-level, alongside `show`/`blame`) + the result
type re-exported from the commands barrel; `reports/api.json` regenerates.

### Algorithm

```
readFileAt(ctx, rev, path, options):
  commitish ← revParse(ctx, rev)              // full grammar → commit-ish oid (D1-A)
  rootTree  ← readTree(ctx, commitish)        // peel commit/tag → root Tree
  entry     ← descendTreePath(ctx, rootTree, path, rev)   // shared descent → { id, mode }
  blob      ← readBlob(ctx, entry.id, options)            // blob-guard + maxBytes/verifyHash
  return { id: entry.id, mode: entry.mode, content: blob.content }
```

- `revParse` raises `REVPARSE_UNRESOLVED` / `AMBIGUOUS_OID_PREFIX` for a bad rev
  (faithful, unchanged).
- `readTree` peels commit/tag → tree; a `rev` that is a blob/tree oid is handled
  faithfully (a tree resolves to itself; a blob → `UNEXPECTED_OBJECT_TYPE tree`,
  matching `git show <blob>:x`).
- `descendTreePath` (extracted, below) walks the segments, raising
  `PATH_NOT_IN_TREE` on a missing or non-tree intermediate.
- `readBlob` raises `UNEXPECTED_OBJECT_TYPE` for a directory / gitlink final
  entry and `OBJECT_TOO_LARGE` when `maxBytes` is exceeded — all reused, none new.

## Reuse — extract the shared `<rev>:<path>` descent

`rev-parse.ts` already walks a tree path in `resolveTreePath` / `lookupTreeEntry`
(the `tree-path` grammar branch). `readFileAt` needs the **same** walk. Rather
than duplicate the faithful segment-descent (missing-segment and
non-tree-intermediate refusals, error threading), lift it into a primitive both
consume:

```ts
// src/application/primitives/resolve-tree-path.ts
export const descendTreePath = async (
  ctx: Context,
  rootTree: Tree,
  path: string,           // split on '/'; '' descends to a missing '' segment → PATH_NOT_IN_TREE
  rev: string,            // carried only for PATH_NOT_IN_TREE display
): Promise<TreeEntry> => { /* walk segments → final entry { id, mode, name } */ };
```

- **`readFileAt`** passes the `Tree` it already loaded via `readTree` (zero
  redundant root read) and uses the returned `{ id, mode }`.
- **`rev-parse`'s `resolveTreePath`** keeps its own `peel`-to-tree (its
  `OBJECT_NOT_FOUND` semantics for the `<tag→blob>:path` edge case differ from
  `readTree`'s `UNEXPECTED_OBJECT_TYPE`, so the peel must **not** be swapped for
  `readTree` — that would change an observable error) and its `path === ''` →
  root-tree-oid shortcut. For a non-empty path it loads the root `Tree` via
  `readTree(treeId)` (the peeled oid is already a tree, so `readTree` returns it
  with no extra peel — and no **dead** type-guard, since `readTree` owns and tests
  that guard), then delegates the segment walk to `descendTreePath`, using `.id`.
  Behaviour-preserving: the same reads, the same `PATH_NOT_IN_TREE` for the same
  inputs — pinned by `rev-parse`'s existing tests staying green.

`descendTreePath` returns the **final entry verbatim** (`{ id, mode, name }`) —
it does **not** blob-guard. `rev-parse` returns `.id` (so `HEAD:dir` still
resolves to the sub-tree oid, faithfully); `readFileAt` applies the blob-guard
itself via `readBlob`. The only refusal `descendTreePath` owns is
`PATH_NOT_IN_TREE` (missing segment, or a non-tree used as an intermediate).

The extraction lands as its own `refactor(primitives)` commit **before** the
feature (the 23.4b precedent — the shared `read-commit.ts` reader landed as a
refactor commit ahead of `walkCommitsByDate`), so the feature commit is purely
additive.

`descendTreePath` lives in `primitives/` (not command-internal) so the
command-tier `readFileAt` and `rev-parse` both reach it via the legal
`commands → primitives` edge.

## Security

- **No filesystem surface from `path`.** The path drives a pure object-graph
  traversal (`readObject` on tree oids by content hash); it is `split('/')` and
  matched against tree-entry names. A `..` or absolute segment is just a name
  that no tree entry carries → `PATH_NOT_IN_TREE`. There is no path-join, so no
  traversal/SSRF vector. (Contrast `resolveRef`, which validates ref names
  precisely because they *do* build filesystem paths.)
- **Error payloads sanitised.** `PATH_NOT_IN_TREE` already runs `rev`/`path`
  through `sanitizeForDisplay` (control bytes escaped) — a corrupt or hostile
  path cannot smuggle control characters into a thrown/logged error.
- **Resource exhaustion bounded.** `options.maxBytes` forwards to the final
  `readBlob`, so a viewer reading a hostile multi-GB committed blob can cap the
  read (`OBJECT_TOO_LARGE`) exactly as `catFile`/`readBlob` already allow.

## Tests

### Unit — `descendTreePath` (`resolve-tree-path.test.ts`)

GWT/AAA, `sut`, one expectation per case. Built on `buildSeededContext` +
`writeObject` (raw trees/blobs), so the descent is exercised without the rev
layer:

- single top-level segment → the entry `{ id, mode }`;
- nested `a/b/c` → the deep entry (pins the intermediate-tree recursion);
- **missing** final segment → `PATH_NOT_IN_TREE { rev, path }` (assert the `data`
  fields, not just the type — kills the StringLiteral/field mutants);
- **missing** intermediate segment → `PATH_NOT_IN_TREE` (isolated from the
  final-segment case per the guard-isolation rule);
- intermediate segment is a **blob** (file-as-directory) → `PATH_NOT_IN_TREE`
  (the `type !== 'tree'` guard, tested independently of the "missing" guard);
- preserves a non-`100644` `mode` (an executable entry round-trips `100755`).

### Unit — `readFileAt` (`read-file-at.test.ts`)

Built on a seeded repo with a committed tree (commit → tree → blobs), reusing the
command fixtures:

- file at `HEAD` → `{ id, mode: 100644, content }` (the bytes equal the blob);
- nested path `dir/file` → the deep blob;
- `rev` as a **short branch name** and as a **tag** → resolves (pins the
  `revParse` grammar path that a primitive would miss — the D1-A justification);
- `rev` as `HEAD~1` → reads the file at the parent commit (older-rev case);
- **directory** path → `UNEXPECTED_OBJECT_TYPE { expected:'blob', actual:'tree' }`;
- **gitlink** path (submodule entry) → `UNEXPECTED_OBJECT_TYPE actual:'commit'`;
- **missing** path → `PATH_NOT_IN_TREE`;
- `maxBytes` below the file size → `OBJECT_TOO_LARGE` (forwarded to `readBlob`);
- a **symlink** entry → `mode: 120000`, content is the link-target bytes (the
  mode is what makes this distinguishable — pins D2-A's value).

### Why no property test

`readFileAt` and `descendTreePath` are **I/O read wrappers over the object
graph**, not parsers/matchers/round-trip pairs. Per CLAUDE.md's "NOT
appropriate" list (I/O wrappers, command facades), none of the four lenses fit:
there is no `serialize`/`parse` inverse, no algebraic grammar to total over, no
counting invariant. Faithfulness is proven by the example + interop suites, where
it belongs.

### Interop — `read-file-at-interop.test.ts`

Cross-tool, `skipIf(!GIT_AVAILABLE)`, scrubbed `GIT_*`, signing off. Build a repo
with canonical `git` (a nested file, an executable file, a symlink, two commits),
then assert:

- `readFileAt('HEAD', '<file>').content` byte-equals `git cat-file blob HEAD:<file>`;
- a nested path and a `HEAD~1`-addressed file match `git cat-file blob` too;
- `readFileAt('HEAD', '<exec>').mode === '100755'` and the symlink entry's
  `mode === '120000'` with content equal to the link target (git parity via
  `git ls-tree`);
- a **directory** path and a **missing** path both throw where `git cat-file
  blob` exits non-zero (co-refusal, not byte parity).

## Coverage / mutation

100% line/branch/function/statement on every touched file; 0 surviving killable
mutants. Awkward spots and their kills:

- the descent's "missing" vs "non-tree-intermediate" branches → separate isolated
  cases;
- the final blob-guard (`UNEXPECTED_OBJECT_TYPE`) → the directory + gitlink cases;
- `maxBytes` forwarding → the over-cap case.

No `v8 ignore` / `stryker-disable`. Any genuinely equivalent mutant (e.g. a
loop-bound that returns `undefined` out of range) is annotated inline with
`// equivalent-mutant: <why>` only.

## Out of scope (logged, not done)

- **Working-tree / index reads** (`readFileAt` of an uncommitted file) — `rev` is
  a committed revision only; the index/workdir live behind `repo.snapshot.*` and
  the deferred `repo.index` / `repo.workdir` accessors (23.4k). YAGNI here.
- **`.gitattributes` smudge / EOL conversion** — tsgit returns canonical object
  bytes everywhere; a checkout-style filtered read is a separate cross-cutting
  concern (no consumer yet).
- **Batch / multi-path reads** — a single `(rev, path)` is the golden path; a
  many-paths-at-one-rev convenience is a follow-up only if a caller needs it.
- **Read-model convergence** — folding `readFileAt` (and `rev-parse`'s
  `<rev>:<path>`) onto a future unified tree-path read model is the capstone
  **23.4j**; this slice only adds the helper and the shared descent it sits on.
