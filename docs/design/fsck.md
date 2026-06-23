# Design — `fsck` (repository integrity check)

> Brief: Ship the Tier-1 `fsck` command — git's `git fsck`: verify the connectivity
> and validity of every object in the store, returning the findings as structured
> data only (ADR-249). The library emits typed findings (`missing` / `dangling` /
> `unreachable` / `broken-link` / `bad-object` / `hash-mismatch` / `bad-ref` /
> `root` / `tagged`); reconstructing git's `dangling commit <sha>` / `missing blob
> <sha>` lines, their stdout/stderr stream routing, and the exit-code bitmask is
> the caller's job.
> Status: draft → self-reviewed ×3 → accepted

## Context

`fsck` is backlog **24.3**, the first Wave-C leaf utility (low-coupling, no
structurally-invasive layout change). It composes existing read primitives and
adds the project's first **whole-object-database scan** and **full-graph
reachability closure** — neither exists today.

Constraints it inherits:

- **Prime directive (ADR-226):** replicate git's observable DATA and on-disk
  behaviour byte-for-byte. fsck reads only; its faithfulness surface is *which
  findings it computes* + *the exit-code class* + *the refusal conditions*, pinned
  empirically below and frozen by an interop test.
- **Structured-output (ADR-249):** the command returns typed findings, never a
  rendered line and never a `bytes`. git routes findings across stdout
  (reachability taxonomy) and stderr (integrity faults); both are **caller
  rendering** — the library ships the fields and lets the consumer place them. No
  rendering-only flag (`--name-objects`, `--verbose`, `--progress`) may appear on
  the surface.
- **Hexagonal tiers:** `repository → commands → primitives → domain`. fsck is a
  Tier-1 command built from Tier-2 primitives — the same blocks a library user
  gets. Finding types are `readonly` discriminated unions of branded domain types,
  following the `domain/diff/diff-change.ts` precedent (one interface per variant,
  discriminated on `type`).

Prior structured-inspection commands set the shape: `whatchanged`
(`docs/design/whatchanged.md`) and `shortlog`
(`src/application/commands/shortlog.ts`) are the closest templates — `ctx` first,
one readonly options object, `assertOperationalRepository(ctx)`, a `Promise` of a
structured result, no rendered strings.

### Pre-chewed substrate (exact paths / symbols / signatures)

**Object reading & integrity** — `src/application/primitives/read-object.ts`
- `readObject(ctx, id, options?: ReadObjectOptions): Promise<GitObject>`;
  `ReadObjectOptions = { verifyHash?: boolean /*default true*/; maxBytes?: number }`.
- Errors (factories in `src/domain/objects/error.ts`, all `TsgitError`, `.data`
  discriminated on `code`):
  - `objectNotFound(id)` → `{ code: 'OBJECT_NOT_FOUND', id }` (neither loose nor any pack holds the oid).
  - `objectHashMismatch(expected, actual)` → `{ code: 'OBJECT_HASH_MISMATCH', expected, actual }` (content hash ≠ requested id; from `finalize`, only when `verifyHash`).
  - `objectTooLarge(id, actualSize, limit)` → `{ code: 'OBJECT_TOO_LARGE', … }`.
  - parse failures (`src/domain/objects/header.ts`, `git-object.ts`, `tag.ts`,
    `commit`/`tree`/`identity`): `invalidObjectHeader` (`INVALID_OBJECT_HEADER`),
    `invalidCommit` (`INVALID_COMMIT`), `invalidTag` (`INVALID_TAG`),
    `invalidTreeEntry` (`INVALID_TREE_ENTRY`), `invalidIdentity`
    (`INVALID_IDENTITY`), `invalidFileMode` (`INVALID_FILE_MODE`).
- No public `objectExists` / `hasObject` (only the private `objectExistsLocally`
  in `commands/fetch-missing.ts`). Loose existence is
  `ctx.fs.exists(looseObjectPath(...))`; pack existence is `PackRegistry.lookup(id)`.

**Object-DB enumeration** — *NONE today.* Building blocks: `objectsDir(gitDir,
prefix)` / `looseObjectPath(gitDir, id)` (`src/application/primitives/path-layout.ts`),
`PackRegistry.all()` (`src/application/primitives/pack-registry.ts`), and
`PackIndex.objectCount` + the sorted SHA table at `IDX_SHA_TABLE_OFFSET=1032`
stride `IDX_SHA_LENGTH=20` (`src/domain/storage/pack-index.ts`, which has
`entryOffsets` and `findByPrefix` but **no all-oid iterator**).

**Roots** — `enumerateRefs(ctx): Promise<ReadonlyArray<RefName>>`
(`src/application/primitives/enumerate-refs.ts`) dedups HEAD + loose `refs/**` +
packed-refs. `resolveRef(ctx, name, { peel?: false }): Promise<ObjectId>`
(`resolve-ref.ts`) follows symrefs; with `peel:false` keeps tag oids as roots.
`getRefStore(ctx).resolveDirect(name): { kind:'direct'|'symbolic'|'missing' }`
(`ref-store.ts`) is the raw read. Reflogs: `readReflog(ctx, ref):
Promise<ReadonlyArray<ReflogEntry>>` (`reflog-store.ts`); enumeration is the
private `collectReflogs` — reuse `enumerateRefs` + `readReflog`.

**Graph walk** — `walkCommits` / `walkCommitsByDate`
(`src/application/primitives/walk-commits*.ts`) yield `Commit` objects and follow
**parents only** (`ignoreMissing` tolerates absent parents). `walkTree(ctx,
treeIdOrObject, { recursive?: true }): AsyncIterable<WalkTreeEntry>`
(`walk-tree.ts`; `WalkTreeEntry = { path: FilePath; id: ObjectId; mode:
FileMode }`) recurses trees → sub-trees + blobs but **does not descend gitlinks
(mode 160000)** and **throws** on a corrupt/missing tree. `Tag`
(`src/domain/objects/tag.ts`): `data = { object: ObjectId; objectType:
ObjectType; tagName; tagger?; … }` — `object` is the pointed-at oid, `objectType`
the declared type (lets fsck check the target's actual type).
No full-graph reachability/closure primitive exists (only push-scoped private
`walkCommitClosure`).

## Requirements

When this ships:

1. `repo.fsck(opts?)` returns a structured `FsckResult` — a `findings` array of a
   `readonly` discriminated union + the git-faithful composite `exitCode` integer
   — and emits **no** rendered line.
2. The finding set, finding categories, and exit-code class match real `git fsck`
   for every scenario in the pinned matrix below, proven by reconstructing git's
   stdout+stderr lines from the structured fields inside the interop test
   (byte-equal vs the real binary).
3. fsck is **read-only**: it never writes to the object store, refs, reflogs, or
   any state file. (git's `--lost-found` write side is out of scope — see below.)
4. Reachability roots match git's default head set: all refs, HEAD, **reflog
   entries** (old + new oids), and the **index** (`--cache` head). Each root class
   is independently togglable as a data-scope option per the decision below.
5. A corrupt/missing/mistyped object encountered anywhere (object scan, ref
   target, or graph edge) is **caught and reported as a finding**, never thrown
   out of the command — fsck's whole job is to not crash on a broken repo.
6. Refusal conditions match git: outside a repository fsck refuses (git's "not a
   git repository"); the exact in-repo gate (`assertRepository` vs
   `assertOperationalRepository`) is **D7**. An unborn/dangling symref (HEAD →
   unborn branch) is **not** a fault (clean, exit 0).

## Design

### Faithfulness matrix (pinned against real `git` 2.54.0)

Every probe ran in a `mktemp` throwaway with `env -i`, isolated `HOME`,
`GIT_CONFIG_NOSYSTEM=1`, signing off. stdout/stderr captured separately. `<sha>` =
literal 40-hex; surrounding text byte-exact.

**Stream discipline (load-bearing).** git splits findings across two streams; both
are caller rendering (ADR-249) but the routing must be reconstructable from the
fields:

- **stdout — reachability taxonomy:** `dangling <type> <sha>`, `unreachable <type>
  <sha>`, `missing <type> <sha>`, `broken link from  <type> <sha>` / (14 spaces)`to
  <type> <sha>`, `root <sha>`, `tagged <type> <sha> (<name>) in <tagobj-sha>`.
- **stderr — integrity faults & progress:** `error: <sha>: object corrupt or
  missing: <path>`, `error: unable to unpack header of <path>`, `error: inflate:
  data stream error (<detail>)`, `error: <sha>: hash-path mismatch, found at:
  <path>`, `error: <ref>: invalid sha1 pointer <sha>`, `error: <ref>: invalid
  reflog entry <sha>`, `error: <ref>: badRefContent: <value>`, `error in <type>
  <sha>: <msgId>: <message>` (ERROR content), `warning in <type> <sha>: <msgId>:
  <message>` (WARN/INFO content), `notice: …`, `Checking …` (verbose/progress).

**Byte-exact `broken link` layout** (`od -c` confirmed): line 1 = `broken link
from` + 2 spaces + `<type> <sha>\n`; line 2 = 14 spaces + `to` + 2 spaces + `<type>
<sha>\n` (object descriptor aligned at column 18).

| # | scenario | command | findings (stdout / stderr) | exit |
|---|---|---|---|---|
| 1 | healthy (3 reachable commits), stderr piped | `git fsck` | *(nothing on either stream)* | 0 |
| 1b | healthy | `--full` / `--connectivity-only` / `--no-full` | *(nothing)* | 0 |
| 1c | healthy, `--progress` forced | `git fsck --progress` | stderr `Checking ref database: 100% …` / `Checking object directories: 100% …` | 0 |
| 2 | commit orphaned by `reset --hard`, **reflog intact** | `git fsck` | *(nothing — reflog keeps it reachable)* | 0 |
| 2b | same, reflog intact | `--no-reflogs` | stdout `dangling commit <sha>` | 0 |
| 2c | reflog deleted | `git fsck` | stdout `dangling commit <sha>` | 0 |
| 3 | `hash-object -w` blob, never referenced | `git fsck` | stdout `dangling blob <sha>` | 0 |
| 4 | `git mktree` tree, unreferenced | `git fsck` | stdout `dangling tree <sha>` | 0 |
| 5 | annotated tag, ref deleted | `git fsck` | stdout `dangling tag <sha>` | 0 |
| 6 | 2-commit orphan subgraph, reflog expired | `git fsck` (default) | stdout `dangling commit <tip>` — **tip only** | 0 |
| 6b | same | `--unreachable` | stdout `unreachable {commit,tree,blob} <sha>` — **every** object | 0 |
| 7a | loose blob (in a tree) deleted | `git fsck` | stdout `missing blob <sha>` (no `broken link` for tree→blob) | **2** |
| 7b | loose parent-commit deleted | `git fsck` | stdout `broken link from  commit <child>` / `to  commit <parent>` + `dangling tree <sha>` + `missing commit <parent>`; stderr `error: <ref>: invalid reflog entry <sha>` (per affected reflog line) | **2** |
| 8a | loose object truncated / byte-flipped | `git fsck` | stdout `missing blob <sha>`; stderr `error: <sha>: object corrupt or missing: <path>` + `error: unable to unpack header …` (+ inflate detail) | **3** |
| 8b | valid object at wrong path (hash≠path) | `git fsck` | stdout `dangling blob <actual-sha>`; stderr `error: <actual-sha>: hash-path mismatch, found at: <path>` | **1** |
| 9a | ref → valid-but-absent sha | `git fsck` | stderr `error: refs/heads/broken: invalid sha1 pointer <sha>` | **2** |
| 9b | ref → malformed content | `git fsck` | stderr `error: refs/heads/garbage: badRefContent: <value>` + `… invalid sha1 pointer 0000…0` | **10** |
| 9c | HEAD → unborn branch (dangling symref) | `git fsck` | *(nothing)* | **0** |
| 10 | dangling object packed-only (`repack -ad`) | `git fsck` | stdout `dangling blob <sha>` (storage-agnostic) | 0 |
| 11a | root commits | `--root` | stdout `root <sha>` | 0 |
| 11b | tag target | `--tags` | stdout `tagged commit <sha> (v1) in <tagobj-sha>` | 0 |
| 11c | staged-only blob | `--cache` | *(nothing — index is already a default head)* | 0 |
| 12a | `zeroPaddedFilemode` tree | `git fsck` | stderr `warning in tree <sha>: zeroPaddedFilemode: contains zero-padded file modes` | **0** |
| 12b | same | `--strict` | stderr `error in tree <sha>: zeroPaddedFilemode: …` (same body, `warning`→`error`) | **1** |
| 12c | `treeNotSorted` / `missingSpaceBeforeEmail` | `git fsck` (and `--strict`) | stderr `error in <type> <sha>: <msgId>: …` (already ERROR in both) | **1** |

**Pinned rules extracted:**

- **dangling vs unreachable.** Default reports only the **tips/roots** of each
  unreachable subgraph as `dangling` (an object *directly used* by another
  unreachable object is not dangling). `--unreachable` enumerates **every**
  unreachable object as `unreachable …`. Both exit 0 — unreachability is not a
  fault.
- **Reflogs & index are default roots.** A `reset --hard`'d commit is reachable
  while its reflog survives; the index is part of the default head set
  (staged-only blob is not dangling). `--no-reflogs` / `--cache` toggle these
  root classes — **data-scope**, not rendering.
- **Storage-agnostic.** dangling/unreachable detection is identical for loose and
  packed objects.
- **Exit code is a severity bitmask** OR'd across fault classes: 0 = clean /
  dangling / unreachable / content-INFO-WARN; 1 = generic fsck error
  (`--strict` upgrade, content-ERROR, hash-path mismatch); 2 = missing / broken
  link / ref→absent-sha; 3 = corrupt/undecodable loose object; 10 = `git refs
  verify` ref-content failure. Composite faults OR (`9b` = 2|8 = 10 with the refs
  pass active).

**Flag classification — data-scope (library honours) vs rendering (caller-only,
ADR-249-dropped):**

| flag | meaning | class |
|---|---|---|
| `--unreachable` | also emit every unreachable object | data-scope |
| `--dangling` / `--no-dangling` | include/omit dangling findings (default on) | data-scope |
| `--root` | also emit root commits | data-scope |
| `--tags` | also emit tag targets | data-scope |
| `--cache` | add the index as a reachability root | data-scope |
| `--no-reflogs` | stop treating reflog entries as roots | data-scope |
| `--full` / `--no-full` | include/exclude packs + alternates (default full) | data-scope |
| `--connectivity-only` | skip object-content validation; check links only | data-scope |
| `--strict` | upgrade certain WARN msg-ids to ERROR (+exit) | data-scope |
| `--references` / `--no-references` | run / skip the `git refs verify` pass | data-scope |
| `--name-objects` | annotate findings with a rev-parse name (`(:path)`) | **rendering** (expose the name/path *field*, not the `(…)` suffix) |
| `--lost-found` | write orphans to `.git/lost-found/**` | **side-effect** (write surface — out of scope) |
| `--verbose` | `Checking <type> <sha>` trace lines | **rendering** |
| `--progress` / `--no-progress` | progress meter | **rendering** |

### Architecture

Hexagonal, Tier-1 command composed from existing read primitives + a small set of
net-new ones flagged as decision candidates. The command never throws on a broken
repo — every primitive call that can fault is wrapped to a finding.

**Pipeline (`fsck(ctx, opts)`):**

1. Assert a repository exists and refuse outside one (gate choice is **D7**). An
   unborn/dangling HEAD symref is tolerated (matrix #9c).
2. **Enumerate all objects** — loose (walk `objects/<2hex>/<38hex>`) ∪ packed
   (every oid in every `PackRegistry.all()` index). Produces the universe `A`.
3. **Validate each object** (skipped under `--connectivity-only`): `readObject(id,
   { verifyHash: true })`; map the thrown `TsgitError` to a finding —
   `OBJECT_HASH_MISMATCH` → `bad-object`/`hash-mismatch`, parse/header codes →
   `bad-object` (with the `reason`/`msgId`), inflate/IO → `bad-object` (corrupt).
   A readable object's parsed shape feeds the graph edges in step 5.
4. **Collect roots** `R`: refs (`enumerateRefs` → `resolveRef(peel:false)`), HEAD,
   reflog old+new oids (unless `--no-reflogs`), index oids (when `--cache` /
   default-on). A root resolving to an absent oid → `bad-ref` (`invalid sha1
   pointer`); malformed ref content → `bad-ref` (`badRefContent`, exit-bit 10).
5. **Reachability closure** from `R`: BFS following commit→tree+parents,
   tree→sub-trees+blobs (`walkTree`, gitlinks not descended), tag→object. An edge
   to an absent oid → `missing` (+ a `broken-link` finding carrying the
   referrer+referent, matrix #7b); an edge to a mistyped object → `bad-object`.
   Yields the reachable set `Reach`.
6. **Classify** against `A`: `dangling` = objects in `A`, present, not *directly
   used* by any other object in `A` (the subgraph roots); `unreachable` (only when
   `--unreachable`) = `A − Reach`; `root` (when `--root`), `tagged` (when
   `--tags`) projections.
7. **Compose the exit code** as the OR of the severity bits each finding class
   contributes (the pinned bitmask).

**New composition vs reuse:**

- **Reuse:** `readObject`, `enumerateRefs`, `resolveRef`/`getRefStore`,
  `readReflog`, `walkTree`, `Tag`/`Commit`/`Tree` parsers, `path-layout` helpers,
  `getPackRegistry`.
- **Net-new (decision candidates D5/D6):** an *enumerate-all-objects* primitive
  (loose scan + pack-index oid iterator) and the *reachability closure* +
  *dangling/unreachable classification* logic. Whether these land as exported
  Tier-2 primitives or inline command helpers is **D6**.

### Public surface

`FsckOptions` below is **provisional** — D4 decides which of these are genuine
data-scope toggles (kept) vs. caller-side projections of one maximal computed set
(dropped, e.g. `dangling`/`roots`/`tags`). The maximal set is always computed; the
options here are the candidate scope/verdict knobs.

```ts
repo.fsck(opts?: FsckOptions): Promise<FsckResult>;

interface FsckOptions {
  readonly checkUnreachable?: boolean;   // --unreachable: emit every unreachable object
  readonly dangling?: boolean;           // --no-dangling ⇒ false (default true)
  readonly roots?: boolean;              // --root: emit root commits
  readonly tags?: boolean;               // --tags: emit tag targets
  readonly indexRoot?: boolean;          // --cache: index as a reachability root (default true — git's default head set)
  readonly reflogRoots?: boolean;        // --no-reflogs ⇒ false (default true)
  readonly full?: boolean;               // --no-full ⇒ false (default true): packs + alternates
  readonly connectivityOnly?: boolean;   // --connectivity-only: skip object-content validation
  readonly strict?: boolean;             // --strict: WARN msg-ids → ERROR (+exit)
  readonly checkReferences?: boolean;    // --no-references ⇒ false (default true): the refs-verify pass
}

interface FsckResult {
  readonly findings: ReadonlyArray<FsckFinding>;
  readonly exitCode: number;             // git's composite severity bitmask (the 10-bit needs the refs-verify pass — D1)
}
```

`FsckFinding` is a `readonly` discriminated union on `type`, mirroring
`domain/diff/diff-change.ts`. The exact variant set + field shape is **D2/D3**; a
representative shape:

```ts
type FsckObjectType = 'commit' | 'blob' | 'tree' | 'tag';

type FsckFinding =
  | { readonly type: 'dangling';     readonly objectType: FsckObjectType; readonly id: ObjectId }
  | { readonly type: 'unreachable';  readonly objectType: FsckObjectType; readonly id: ObjectId }
  | { readonly type: 'missing';      readonly objectType: FsckObjectType; readonly id: ObjectId; readonly referencedBy?: ObjectId }
  | { readonly type: 'broken-link';  readonly from: ObjectId; readonly fromType: FsckObjectType; readonly to: ObjectId; readonly toType: FsckObjectType }
  | { readonly type: 'bad-object';   readonly id: ObjectId; readonly reason: string; readonly severity: 'error' | 'warning' }
  | { readonly type: 'hash-mismatch'; readonly id: ObjectId; readonly actual: ObjectId }
  | { readonly type: 'bad-ref';      readonly ref: RefName; readonly reason: string; readonly target?: ObjectId }
  | { readonly type: 'root';         readonly id: ObjectId }
  | { readonly type: 'tagged';       readonly id: ObjectId; readonly objectType: FsckObjectType; readonly tagName: string; readonly tag: ObjectId };
```

Branded types reused from `src/domain/objects/object-id.ts` (`ObjectId`,
`RefName`). The union discriminates on `type` (object/diff-graph precedent), not
`kind` (state-union precedent).

### Refusal & error semantics

- **Non-repository:** `assertOperationalRepository` refuses identically to `log`
  (no special fsck path).
- **In-repo faults are findings, never throws.** Every `readObject` /
  `walkTree` / `resolveRef` call inside the scan/closure is wrapped: a thrown
  `TsgitError` is classified to a finding by its `.data.code`. fsck must survive
  the worst repo it is pointed at.
- **Exit code, not exception, carries severity.** A repo with missing/corrupt
  objects returns a non-zero `exitCode` in a successfully-resolved `FsckResult` —
  it does **not** reject. (git exits non-zero but still prints all findings; the
  structured analogue is a populated `findings` + composite `exitCode`.)

## Decision candidates

| # | Choice | Alternatives (≤3) | Recommendation | Why |
|---|---|---|---|---|
| D1 | **v1 check scope** — how much of git's check space ships now | (a) full: object-content validation + connectivity + dangling/unreachable + ref-content; (b) connectivity + dangling/unreachable only (defer content validation = `--connectivity-only` as the *only* mode); (c) content + connectivity, defer the `git refs verify` ref-content pass (badRefContent / exit-10) | **(c)** | Covers the defining fsck behaviour (corrupt/missing/dangling/unreachable + invalid-sha-pointer refs) and all exit classes 1–3; the refs-verify pass (exit 10, msg-id catalogue) is a self-contained add-on cleanly deferrable without leaving a faithfulness hole in the core. |
| D2 | **Content-validation depth** — which git msg-ids `bad-object` reproduces | (a) only the structural failures tsgit's parsers already throw (bad header / unknown type / size mismatch / bad mode / bad identity / hash mismatch); (b) (a) + git's named tree/commit catalogue (`treeNotSorted`, `zeroPaddedFilemode`, `missingSpaceBeforeEmail`, …) with faithful msg-ids + `--strict` upgrades; (c) (a) + a curated high-value subset of the catalogue | **(a) for v1, catalogue deferred** | tsgit's existing parse errors already cover the corrupt/undecodable/mistyped cases (exit 1/3); git's full fsck msg-id catalogue is a large net-new validator with its own WARN/ERROR/strict severity table — best as a follow-up ADR, documented as a known v1 gap. Drives whether `--strict` ships now. |
| D3 | **`FsckFinding` shape** — discriminator + granularity | (a) one flat union discriminated on `type` with per-variant fields (above), mirroring `DiffChange`; (b) two arrays (`reachability` taxonomy vs `integrity` faults) matching git's stdout/stderr split; (c) a `{ category, objectType, id, …}` record with a wide optional-field bag | **(a)** | Matches the house discriminated-union precedent (`diff-change.ts`), keeps every finding self-describing, and the stdout/stderr split is pure caller rendering (each variant maps to a known stream) — so (b) bakes a rendering concern into the data (ADR-249 violation). |
| D4 | **Which data-scope flags become options in v1** | (a) all data-scope flags (`checkUnreachable`, `dangling`, `roots`, `tags`, `indexRoot`, `reflogRoots`, `full`, `connectivityOnly`, `strict`, `checkReferences`); (b) the always-computed core (find everything; no toggles) + let the caller filter the returned `findings` (return the maximal set always); (c) core scope toggles only (`checkUnreachable`, `connectivityOnly`, `reflogRoots`, `indexRoot`), defer `roots`/`tags`/`strict`/`references` | **(b) with the genuine root/scope toggles kept** | ADR-249 says rendering/selection is the caller's job — `dangling` vs `unreachable` vs `root` vs `tagged` are *projections of one computed set*, so compute the maximal taxonomy once and let the caller filter, dropping `--dangling`/`--root`/`--tags` as options. BUT `--no-reflogs` / `--cache` / `--connectivity-only` / `--no-full` change the *roots/objects actually examined* (a different computation, not a filter) and `--strict` changes the *verdict* — those must stay as data-scope options. Resolving D4 fixes the final `FsckOptions`. |
| D5 | **Dangling/unreachable computation strategy** | (a) full closure: enumerate all objects, BFS-mark reachable from roots, `unreachable = A − Reach`, `dangling = ` unreachable objects not *directly used* by another object; (b) git's incremental "lost & found" walk (mark, then sweep, tracking used-by edges during the sweep); (c) reachable-only connectivity (compute `Reach`, report `missing`/`broken-link`, skip dangling/unreachable entirely) | **(a)** | Direct, testable, faithful to the pinned tip-vs-all distinction (#6): `dangling` = roots of the unreachable subgraphs (objects with no in-edge from another present object), `unreachable` = the whole `A − Reach`. (c) drops a defining fsck feature; (b) is git's internals, more machinery than the clean set-difference needs. |
| D6 | **New Tier-2 primitive vs inline helper** for object-DB enumeration + reachability closure | (a) add two exported primitives (`enumerateObjects`, `objectClosure`/`reachableObjects`) to `application/primitives/` (public, reusable by future `gc`/`prune`/`bundle`); (b) keep both private to `commands/fsck.ts` (+ an internal helper module); (c) add only `enumerateObjects` as a primitive (broadly reusable), keep closure inline | **(c)** | Whole-object-DB enumeration is a generic capability `gc`/`prune`/`repack`/`bundle` (all later backlog items) will reuse — earning Tier-2 status; the dangling/unreachable closure is fsck-specific classification today, so keep it inline until a second consumer appears (YAGNI). The `PackIndex` all-oid iterator it needs is a small `pack-index.ts` addition either way. |
| D7 | **Repository-state assertion** | (a) `assertOperationalRepository` (HEAD exists + valid core config) like `log`; (b) `assertRepository` only (HEAD exists), since fsck must run on a *broken* repo where core config may itself be suspect; (c) no assertion — fsck runs anywhere `.git` resolves | **(b)** | fsck's purpose is diagnosing broken repos; gating it behind `assertCoreConfigValid` could refuse exactly the corrupt repo a user runs fsck on. `assertRepository` (a repo exists) is the faithful minimum — git fsck runs on a repo with broken refs/objects. Confirm against git: does `git fsck` refuse outside a repo only? (it does — exit "not a git repository"). |

## Test strategy

- **Unit** (`fsck.test.ts`, memory adapter): GWT/AAA, `sut = fsck`, 100%
  line/branch/function + 0 surviving mutants. One isolated test per finding class
  and per guard (mutation-resistant): healthy repo → empty findings + exit 0;
  dangling commit/blob/tree/tag (tip-only); `--unreachable` enumerates the whole
  orphan subgraph; missing blob referenced by a tree (#7a, exit 2); missing parent
  commit → `broken-link` + `missing` (#7b); corrupt loose object → `bad-object`
  (exit 3); hash-path mismatch → `hash-mismatch`/`dangling` (exit 1); ref → absent
  sha → `bad-ref` (exit 2); reflog-kept-reachable vs `--no-reflogs`; index root vs
  `--cache`; `--connectivity-only` suppresses content faults; `root`/`tagged`
  projections; packed-only dangling object (#10); unborn-HEAD-symref is clean
  (#9c); non-repository refuses. Each exit-code bit asserted on its **`.data`**
  (specific code/severity, never `toThrow(Class)` alone).
- **Properties** (`fsck.properties.test.ts`, lens 2 — compositional aggregator):
  over an arbitrary small object graph — *closure invariants*: an object reachable
  from a root is never `dangling`/`unreachable`/`missing`; adding a root that
  reaches an object flips it out of `unreachable`; `dangling ⊆ unreachable`;
  `unreachable ∩ Reach = ∅`; a present object directly used by another present
  object is never `dangling`. (`numRuns` 100.) The enumerate-objects primitive (if
  D6 lands it) gets a round-trip property: every written oid (loose ∪ packed) is
  enumerated exactly once.
- **Interop** (`test/integration/fsck-interop.test.ts`, real-git twin via
  `interop-helpers.ts`'s scrubbed `runGit`): one tmp repo per matrix scenario;
  hand-corrupt objects/refs in the tmp `.git`, run `repo.fsck()`, **reconstruct
  git's exact stdout + stderr lines and stream routing from the structured
  fields**, and assert byte-equality with `git fsck <flags>` plus the exact exit
  code. Covers the dangling/unreachable, missing/broken-link, corrupt,
  hash-mismatch, bad-ref, root/tagged, and packed-only cases.
- **Parity scenario** (`test/parity/scenarios/fsck.scenario.ts` + `index.ts`
  registration): a small repo with one dangling + one missing object asserting the
  same structured `findings`/`exitCode` on node / memory / browser.

## Surface gates (per the Tier-1 checklist)

- `src/application/commands/fsck.ts` + barrel export in
  `src/application/commands/index.ts` (alphabetical: after the `fetch`/`fetch-missing`
  block, before `grep`) → public via `src/index.ts`'s `export *`.
- `src/repository.ts`: `readonly fsck: BindCtx<typeof commands.fsck>;` on the
  `Repository` interface + the `guard(); return commands.fsck(ctx, opts);` binding
  (both alphabetical, after `fetchMissing`, before `grep`). Flat `BindCtx<…>` line
  (the doc-coverage parser keys off it).
- `test/unit/repository/repository.test.ts` (~line 199): add `'fsck'` to the
  facade key-set array (between `'fetchMissing'` and `'grep'`).
- `docs/use/commands/fsck.md` + a `` [`fsck`](fsck.md) `` row in
  `docs/use/commands/README.md` (doc-coverage gate, `tooling/check-doc-coverage.ts`).
- `README.md` (~line 46): bump the Tier-1 command count `39` → `40`.
- `reports/api.json`: regenerate (new public `fsck` + `FsckOptions` /
  `FsckResult` / `FsckFinding`) — prepush `check:doc-typedoc` gate; large typedoc-id
  churn is expected.
- `docs/BACKLOG.md`: flip `24.3` to `[x]` (docs phase).

## Out of scope

- **`--lost-found` write side** — materialising orphans under `.git/lost-found/**`
  is a write surface; fsck stays read-only. (git-faithful divergence: we report the
  same orphans, we don't write them.)
- **`git refs verify` ref-content pass** (`badRefContent`, exit-10 class) — pending
  D1; the core ships invalid-sha-pointer ref findings (exit 2) without it.
- **Full fsck msg-id catalogue + `--strict` upgrades** (`treeNotSorted`,
  `zeroPaddedFilemode`, `missingSpaceBeforeEmail`, …) — a large net-new validator
  with its own severity table; v1 reports the structural failures tsgit's parsers
  already detect (pending D2).
- **`--name-objects` / `--verbose` / `--progress`** — pure rendering (ADR-249);
  the library exposes the underlying path/name *field*, not the `(…)` suffix or
  trace text.
- **Alternates / `--full` over alternate object stores** — tsgit has no alternates
  mechanism; `--full` covers this repo's packs only.
- **Gitlink (submodule) target verification** — `walkTree` does not descend mode
  160000; submodule object integrity belongs to the submodule's own repo (matches
  git, which does not follow gitlinks in fsck).
