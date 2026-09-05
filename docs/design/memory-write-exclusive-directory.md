# Design — the memory adapter's `writeExclusive` refuses an existing directory

> Brief: `MemoryFileSystem.writeExclusive` refuses a **file** or a **symlink** occupant but not a
> **directory** — it overwrites the name with a file entry and returns success. The node adapter
> refuses with `FILE_EXISTS`, and so does canonical git. Close the gap, prove it cross-adapter,
> and drop the test-side patches that existed only to fake the POSIX behaviour.
> Status: draft → self-reviewed ×3

## Context

### What `writeExclusive` is for

It is the port's only exclusive-create primitive, and every caller depends on the *refusal*, not
on the write. Fifteen production call sites, four distinct protocols:

| Protocol | Call sites | What `FILE_EXISTS` means to the caller |
|---|---|---|
| **Lock files** | `internal/index-lock.ts:55,84,98`, `atomic-write.ts:28` (every ref update), `shallow-file.ts:105`, `reftable-transaction.ts:147` | *Another writer holds the lock* → `refLocked` / `RESOURCE_LOCKED` refusal |
| **Loose objects** | `write-object.ts:46` | *We already have this object* → keep the existing bytes, return the oid |
| **Pack artefacts** | `internal/write-pack-artifacts.ts:169,183,271,353,354`, `internal/cruft-pack-lifecycle.ts:244` | *An artefact already occupies the name* → compare, keep if identical, else `PACK_ARTIFACT_MISMATCH` |
| **Name probing** | `fetch-pack.ts:312`, `reftable-transaction.ts:675` | *That random temp name is taken* → draw another |

Every one of those is a **refusal condition** in the prime directive's sense (CLAUDE.md, ADR-226):
observable behaviour that must match canonical git. A silent success where git refuses is exactly
the class of divergence the directive exists to prevent.

### The three first-party adapters and their gates

| Adapter | 100 % coverage gate | Stryker mutation gate | Cross-adapter proof today |
|---|---|---|---|
| `adapters/node` | yes (`vitest.config.ts` `coverage.include`) | yes | `test/unit/ports/file-system.contract.ts` |
| `adapters/memory` | yes | yes | same contract suite |
| `adapters/browser` | **no** (not in `coverage.include`) | **no** (`stryker.config.mjs` `mutate` excludes `src/adapters/browser/**`) | Playwright only (`test/browser/`) |

### Governing decisions this design sits inside

| ADR / design | What it binds here |
|---|---|
| **ADR-226** git-faithfulness prime directive | Refusal conditions are observable behaviour; pin against the real binary. §1a is that pin |
| **ADR-052** `DIRECTORY_NOT_EMPTY` (`mapErrno` ENOTEMPTY split) | The exact precedent: *"the memory adapter's analogous error path must produce the same code for cross-adapter parity — otherwise a test against the memory adapter sees one code and against NodeFileSystem sees another."* This change is the same move for `FILE_EXISTS` |
| **ADR-721** first-party read containment is single-authority | Governs `node-file-system.ts`'s read path. Untouched: this change adds nothing to the node adapter |
| **ADR-782** pass-two reads go through `readSlice` | Governs the `readSlice` seam on `ports/file-system.ts`. Untouched: the port change here is a doc comment on a different method |
| **ADR-789** the `.idx`/`.rev` serializers take the oid slab | Governs `write-pack-artifacts.ts`'s input shape. This change touches that module's **tests only**, never its code |
| **ADR-628** the `.rev` is written exclusively like its siblings | Why the `.rev` is on `writeExclusive` at all, and therefore in this blast radius |
| `design/ports-and-adapters.md:561` | The line that *codified* the bug: *"**`writeExclusive`:** Checks `Map.has(path)` — throws `FILE_EXISTS` if present."* One map, not three namespaces |
| `design/bench-snapshot-summary-adr-lint.md:584` | Asserts on the record that *"`exists`, `readSlice` and `writeExclusive` behave identically on both first-party adapters"*. **Two thirds of that sentence are false**: §1c falsifies it for `writeExclusive`, §3 falsifies it for `exists`. This change makes the `writeExclusive` clause true; the `exists` clause stays false and is named in §Out of scope |
| `docs/BACKLOG.md` **21.2a** | Prior art for the defect class, in this repo, in this file family: *"caught a shipped bug: `repo.mv` on a directory rename threw `EISDIR` on the Node adapter (memory tolerated it, so unit+parity missed it)"* |

There is **no backlog entry** for this work — it was surfaced while fixing PR #295 and chosen
directly by the user, so nothing gets ticked.

---

## Requirements

Every statement below is checked by a test named in §Test strategy, except **R8**, which is a design
invariant checked indirectly at the only method that can break it (the reason is in §Test strategy's
property-test paragraph).

**Refusal**

- **R1** — `MemoryFileSystem.writeExclusive(p, d)` throws `TsgitError` with `data.code === 'FILE_EXISTS'`
  and `data.path === p` when an **empty directory** occupies `p`.
- **R2** — Same when the directory at `p` **has children**.
- **R3** — Same when `p` is the adapter's `rootDir` itself (today it is silently overwritten; see §2b).
- **R4** — Unchanged: a **regular file** at `p` refuses with `FILE_EXISTS`.
- **R5** — Unchanged: a **symlink** at `p` refuses with `FILE_EXISTS` regardless of its target.
  (→ file, → directory and dangling are three arrangements but **one** code path in memory —
  `symlinks.has` never looks at the target — so one test covers the guard term. All three are
  pinned on node in §1b for the cross-adapter claim, not because memory branches on them.)
- **R6** — Unchanged: an absent `p` writes the bytes and auto-creates missing parents.

**Non-destructiveness**

- **R7** — A refused call mutates nothing *observably*: `lstat(p)` still reports
  `isDirectory: true` with unchanged timestamps, and every child under `p/` reads back
  byte-identical. (Stated on the port surface, not on the private `files`/`times` maps.)

**Invariant**

- **R8** *(design invariant, not a single test)* — After the change, `files`, `directories` and
  `symlinks` hold **pairwise disjoint** key sets under every reachable sequence of adapter calls.
  Not a new invariant: four existing Stryker equivalence proofs already assume it (§2c), and
  `writeExclusive` is the only method that can violate it — so R1–R3 are where it is actually
  guarded.

**Cross-adapter**

- **R9** — The shared port contract suite (`test/unit/ports/file-system.contract.ts`) carries a
  directory-occupant row that **both** the node and the memory driver pass, asserting `FILE_EXISTS`
  strictly (one code, not a tolerated pair).
- **R10** — `writeOrKeepArtifact` classifies a directory occupying `pack-<sha>.idx` as
  `PACK_ARTIFACT_MISMATCH` on the memory adapter **with no test-side patch of `writeExclusive`**.

**Documentation**

- **R11** *(conditional on DC-D)* — The `writeExclusive` JSDoc on `src/ports/file-system.ts` states
  the occupancy rule in terms of *anything at `path`*, not *"the file"*.

---

## Design

### §1 The pinned matrices

Nothing below is recalled; each table is a probe run for this design on 2026-09-05.

#### §1a Canonical git — the faithfulness anchor

`git version 2.55.0`, darwin 25.5.0. Throwaway `mktemp -d` repo, isolated `HOME`,
`GIT_CONFIG_NOSYSTEM=1`, every `GIT_*` scrubbed via `env -u`, signing off. Exit codes captured
without a pipe.

| Command | Occupant at the exclusive-create path | exit | stderr (first line) |
|---|---|---|---|
| `git update-ref refs/heads/main HEAD` | **directory** at `.git/refs/heads/main.lock` | 128 | ``fatal: update_ref failed for ref 'refs/heads/main': cannot lock ref 'refs/heads/main': Unable to create '<…>/main.lock': File exists.`` |
| `git update-ref refs/heads/main HEAD` | **file** at the same path | 128 | *byte-identical to the row above* |
| `git add b.txt` | **directory** at `.git/index.lock` | 128 | ``fatal: Unable to create '<…>/index.lock': File exists.`` |
| `git add b.txt` | **file** at the same path | 128 | *byte-identical to the row above* |
| `git index-pack <p>.pack` | **directory** at `<p>.idx` | 128 | ``fatal: unable to create '<…>/in.idx': File exists`` |
| `git index-pack <p>.pack` | **file** at `<p>.idx` | 0 | *(none — replaced)* |
| `git index-pack <p>.pack` | nothing (control) | 0 | *(none)* |

**What this pins.** For git's lock protocol, a directory occupant and a file occupant are the
**same** refusal, byte-for-byte: `File exists`. That is the behaviour `writeExclusive` exists to
model, and the memory adapter does not model it.

The `index-pack` file row is *not* a counter-example and does not belong to this change: git's
`.idx` finalisation is tmp-write-then-rename, so a regular file is replaced while a directory makes
the create fail. tsgit places that same tolerance one layer up, in `writeOrKeepArtifact`, which
compares and keeps an identical occupant (ADR-804) — the port primitive underneath stays strictly
exclusive. `bench-snapshot-summary-adr-lint.md` already ruled on this shape: *"the fix is a tolerant
caller, never a permissive file system."*

#### §1b The node adapter — the composed behaviour, not the syscall

Run against `NodeFileSystem` itself (not `fs/promises`) in a `mkdtemp` root, Node v22.22.3,
darwin 25.5.0. **This distinction is load-bearing and cost one wrong assumption:**
`NodeFileSystem.writeExclusive` is

```ts
const real = await this.resolveWrite(path);
await this.assertWritableLeaf(real, path);           // no-op on POSIX — O_NOFOLLOW covers it
await runFs(async () => {
  await this.fsOps.mkdir(this.pathPolicy.dirname(real), { recursive: true });
  await this.fsOps.writeFile(real, data, { flag: WRITE_EXCLUSIVE_FLAGS });
}, path);
```

so an ancestor fault is decided by the **`mkdir`**, not by the `open`. Probing bare
`writeFile(p, {flag:'wx'})` reports `ENOTDIR` for a file-at-parent; probing the adapter reports
`FILE_EXISTS`, because `mkdir('<file>', {recursive:true})` yields `EEXIST` on an existing file. The
two disagree. Only the second is this change's oracle.

| # | Arrangement at / above `path` | node adapter result | `data.path` |
|---|---|---|---|
| A | nothing | writes | — |
| B | regular file at `path` | `FILE_EXISTS` | requested |
| C | **empty directory at `path`** | **`FILE_EXISTS`** | requested |
| D | **directory with children at `path`** | **`FILE_EXISTS`** | requested |
| E | symlink → file at `path` | `FILE_EXISTS` | requested |
| F | symlink → directory at `path` | `FILE_EXISTS` | requested |
| G | dangling symlink at `path` | `FILE_EXISTS` | requested |
| H | regular file at the **immediate parent** | `FILE_EXISTS` | requested |
| I | regular file at the **grandparent** | `NOT_A_DIRECTORY` | requested |
| J | symlink → file at the immediate parent | `FILE_EXISTS` | requested |
| K | `path` **is** the containment root | `FILE_EXISTS` | requested |
| L | symlink → directory at the immediate parent | **writes** (resolves inside the root) | — |

Rows H and I are the same fault at two depths and produce **two different codes**. That is a
property of `mkdir -p`, not a considered decision, and it means *there is no single "node
behaviour" to align an ancestor rule to* (DC-B).

Row L is node honouring the port's own containment rule — the symlinked parent resolves **inside**
the root, so `resolveWrite` admits it. The port text only forbids an ancestor symlink resolving
*outside* the root.

#### §1c The memory adapter — where it diverges

Same twelve arrangements, `MemoryFileSystem({ rootDir: '/repo' })`.

| # | Arrangement | memory today | node | verdict |
|---|---|---|---|---|
| A | nothing | writes | writes | agree |
| B | file at `path` | `FILE_EXISTS` (requested) | `FILE_EXISTS` | agree |
| C | **empty dir at `path`** | **writes** | `FILE_EXISTS` | **DIVERGE — the bug** |
| D | **dir with children at `path`** | **writes** | `FILE_EXISTS` | **DIVERGE — the bug** |
| E | symlink → file | `FILE_EXISTS` (requested) | `FILE_EXISTS` | agree |
| F | symlink → dir | `FILE_EXISTS` (requested) | `FILE_EXISTS` | agree |
| G | dangling symlink | `FILE_EXISTS` (requested) | `FILE_EXISTS` | agree |
| H | file at immediate parent | `NOT_A_DIRECTORY` (**ancestor** path) | `FILE_EXISTS` (requested) | diverge — DC-B |
| I | file at grandparent | `NOT_A_DIRECTORY` (**ancestor** path) | `NOT_A_DIRECTORY` (requested) | code agrees, path differs — DC-B |
| J | symlink → file at immediate parent | `NOT_A_DIRECTORY` (ancestor path) | `FILE_EXISTS` (requested) | diverge — DC-B |
| K | **`path` is `rootDir`** | **writes** | `FILE_EXISTS` | **DIVERGE — worst case, §2b** |
| L | symlink → dir at immediate parent | `NOT_A_DIRECTORY` | writes | diverge — out of scope, §Out of scope |

Rows C, D and K are what this change closes. Row L is memory being *stricter* than node (it never
follows a symlinked ancestor); it is a separate question and is not opened here.

Bonus row, same probe, different method — **`write` (non-exclusive) over a directory**:
node throws `PERMISSION_DENIED` (`EISDIR` → `mapErrno`), memory silently replaces the directory
name with a file. Same defect family, different method (DC-F).

#### §1d The browser adapter — derived, not executed

`BrowserFileSystem.writeExclusive` guards with

```ts
try { await dir.getFileHandle(leaf, { create: false }); }
catch (err) { if (err instanceof TsgitError) throw err; return; }   // "NotFoundError → safe to create"
throw fileExists(path);
```

The WHATWG File System Standard (fetched 2026-09-05) is normative on the two rejections
`getFileHandle` can produce:

> *"If child is a directory entry: Reject result with a `TypeMismatchError` DOMException and abort these steps."*
> *"If options['create'] is false: Reject result with a `NotFoundError` DOMException and abort these steps."*

The catch arm treats **every** non-`TsgitError` as "not found", so a `TypeMismatchError` from a
directory occupant is read as *safe to create*. Control then reaches
`dir.getFileHandle(leaf, { create: true })`, which rejects with `TypeMismatchError` again — and that
one escapes `writeExclusive` **unmapped**. A caller sees a bare `DOMException`, so
`errorDataCode(err)` returns `undefined` and `writeOrKeepArtifact` rethrows it instead of raising
`PACK_ARTIFACT_MISMATCH`.

So the browser adapter does not silently corrupt like memory — it fails *outside the port's error
contract*, which is a different and arguably worse failure. **Status: derived from the adapter
source plus the normative spec. Not executed against a real OPFS in this phase** — there is no OPFS
fake in `test/unit/adapters/browser/` (that file holds one `'atomicRename' in sut` capability test
and nothing else), so the only oracle is Playwright. DC-E puts the choice to the user.

### §2 What the bug actually breaks

#### §2a The reachable path today

`writeOrKeepArtifact` (`internal/write-pack-artifacts.ts:161–174`):

```ts
try { await ctx.fs.writeExclusive(path, bytes); }
catch (err) {
  if (errorDataCode(err) !== 'FILE_EXISTS') throw err;
  const occupant = await ctx.fs.stat(path);
  if (!occupant.isFile || occupant.size !== bytes.length) throw packArtifactMismatch(path);
  if (!bytesEqual(await ctx.fs.read(path), bytes)) throw packArtifactMismatch(path);
}
```

The `!occupant.isFile` arm is the directory classifier. It is only ever reached through the
`FILE_EXISTS` catch — so on the memory adapter it is **unreachable in production**, and the one unit
test that appears to exercise it is exercising a patched fixture instead (§4).

#### §2b The `rootDir` case is the sharp edge

Row K: `writeExclusive('/repo', …)` on a memory adapter rooted at `/repo` **succeeds today**. The
root is seeded into `directories` at construction, so nothing else stops it. Afterwards
`files.has('/repo')` is true, and `addDirectoryRecursive` — which every write surface funnels
through — throws `NOT_A_DIRECTORY` on its first iteration for **every subsequent write anywhere in
the repository**. One exclusive write at the root bricks the adapter instance. The fix closes this
for free, because `rootDir ∈ directories`.

#### §2c The bug falsifies an invariant three equivalence proofs rest on

After row D the adapter holds `/repo/x/target` in **both** `files` and `directories`. Observed
consequences in the same probe:

- `lstat('/repo/x/target')` → `isFile: true`
- `readdir('/repo/x')` → `[{ name: 'target', isDirectory: true }]`
- `readdir('/repo/x/target')` → `NOT_A_DIRECTORY`
- the child `/repo/x/target/child.txt` is still readable

One name, two types, three surfaces disagreeing. The bug puts one key in **`files` ∩ `directories`**,
and committed `Stryker disable` proofs in `memory-file-system.ts` rest on that pair being empty:

| Line | Proof text (excerpt) | Falsified by the bug? |
|---|---|---|
| `:186` `readdir` | *"files and directories are disjoint namespaces, so a file path always fails the `!directories.has` check below"* | **yes** — with the key in both, removing the guard would list children instead of throwing |
| `:352` `removeLeafEntry` (file arm) | *"returning false … only lets rmRecursive fall through to `!directories.has` (true, since files/dirs are disjoint) and return anyway"* | **yes** — `!directories.has` becomes false, so the mutant reaches `removeSubtree` |
| `:515` `addDirectEntry` | *"files/symlinks/directories are pairwise disjoint … two iterators reaching the same first-segment `name` always build an identically-shaped DirEntry"* | **yes** — the two iterators build `{isFile:true}` and `{isDirectory:true}` |
| `:359` `removeLeafEntry` (symlink arm) | *"(true, since symlinks/dirs are disjoint)"* | **no** — same claim family, different pair; `writeExclusive` cannot create a symlink |

The fix **restores** the premise rather than invalidating it, so the first three become sound where
they were previously conditional on a bug not being hit. Per the repo's rule that equivalence
comments are structure-specific, each is re-read during implementation and left in place only if its
wording still matches the code it annotates. None of the four sits on a line this change edits.

### §3 The fix

`symlink` in the same file is the in-house precedent — it already tests all three namespaces:

```ts
symlink = async (target: string, path: string): Promise<void> => {
  const normalized = this.resolve(path);
  if (this.files.has(normalized) || this.symlinks.has(normalized) || this.directories.has(normalized)) {
    throw fileExists(path);
  }
  …
```

`writeExclusive` is the only one of the two writers that tests two namespaces out of three. Shape
is DC-A; the behaviour is fixed either way.

**`exists` is *not* a third copy of the same predicate, and must not be folded in.** It computes a
textually identical disjunction today, but it answers a different question, and the two answers
already come apart on the node adapter — probed, same run:

| path | `node.exists` | `memory.exists` |
|---|---|---|
| regular file | `true` | `true` |
| symlink → file | `true` | `true` |
| **dangling symlink** | **`false`** | **`true`** |
| directory | `true` | `true` |
| absent | `false` | `false` |

Node's `exists` follows symlinks by design (its own comment: *"a dangling symlink must report
`false`, not `true`"*), while `writeExclusive` refuses a dangling symlink with `FILE_EXISTS`
(row G) — *not existing* and *occupied* are genuinely different predicates, and only the
coincidence of memory's current implementation makes them look like one. Sharing a helper between
them would cement that coincidence as intent. (The `exists` divergence itself is pre-existing and
out of scope — §Out of scope.)

Mutation note, either shape: Stryker mutates the guard on several axes — each `||` flips to `&&`,
and the whole condition is forced to `true` and to `false`. Each disjunct therefore needs its
**own** observable test; one test tripping two occupants at once proves neither term. That is the
recorded high-yield real-survivor class in this repo, and R1/R4/R5 are exactly that
one-condition-each split. Extracting the predicate (DC-A option 2) halves the mutant population by
removing the duplicated expression — not by suppressing anything.

### §4 The test-side patches this retires

`writeOrKeepArtifact`'s directory arm is currently proven on the memory adapter by patching
`writeExclusive` on a spread copy of the context so it throws `FILE_EXISTS` — i.e. by faking the
behaviour this change makes real. **A full sweep of `test/**` found exactly one such patch** (the
brief expected two; the second candidate patches `stat` only and is unaffected — see the inventory).
It becomes redundant and must go, or it will keep the adapter's real behaviour untested at the very
call site that motivated the fix.

The rule, applied literally:

- **Drop** a `writeExclusive` override whose only job is to make a directory occupant produce
  `FILE_EXISTS`.
- **Keep** every `stat` patch — the size coincidence (an occupant whose size equals the artefact's,
  so `isFile` is the sole discriminator) is the point of the test and cannot be arranged otherwise.
- **Keep** every override that injects a **non-`FILE_EXISTS`** failure — those pin the rethrow
  branch and have nothing to do with this change.
- **Keep** every `vi.spyOn(ctx.fs, 'writeExclusive')` used for call-order or argument pinning.

The exact inventory is in §Test strategy.

One title also becomes false and is corrected in passing: the memory suite's
`describe('Given the memory fs has no real symlinks')` around a `writeExclusive` case — the memory
adapter has had symlinks since before this change, and rows E–G above are the proof.

### §5 Where the cross-adapter proof lives

🔴 **Correction to the brief's premise.** The brief asks whether `test/parity/**` "has a slot for
exclusive-create refusals". It does — the sweep found raw port calls all over the scenario set
(`repo.ctx.fs.write` / `read` / `readSlice` / `readdir` / `writeUtf8` in `bitmap-closure`,
`pack-degraded-idx`, `fsck-degraded-store`, `reftable-refs`, `pack-v3-read`, `pack-objects`,
`maintenance`, `stash`, `rebase`, …), and `reftable-refs.scenario.ts:155` even branches on an
adapter capability (`if (ctx.fs.atomicRename === undefined)`). `writeExclusive` is the one write
method that appears nowhere in `test/parity/`, but nothing structural stops it. Answering "no slot"
would have been wrong.

**What does stop it is the browser.** `test/browser/parity-scenarios.bundle.ts` re-exports the
*whole* `SCENARIOS` registry into the page, and `test/browser/parity.spec.ts` runs **every**
registered scenario against a real OPFS-backed repository, asserting the same golden. So a parity
scenario asserting an exclusive-create refusal is automatically a **browser** assertion too — and
per §1d the browser adapter throws a bare `DOMException` there. Adding the scenario without taking
DC-E turns the browser parity spec red. The two decisions are coupled, and DC-C names it.

`test/unit/ports/file-system.contract.ts` remains the purpose-built cross-adapter home: one exported
`fileSystemContractTests(createSut)` driven by the memory suite (L7–24) and the node suite
(L63–96, real `mkdtemp` root), already carrying
`Given existing file, When writeExclusive, Then throws FILE_EXISTS` (`:389`). Its four assertion
helpers (`assertFileNotFound` `:78`, `assertPermissionDenied` `:83`, `assertFileExists` `:88`,
`assertNotADirectory` `:93`) all check the instance and `data.code` and **none** checks `data.path`
— which is what makes a code-only ancestor row idiomatic there rather than a compromise.

Note the file already has a **tolerant** precedent for a neighbouring shape:
`Given mkdir on existing file path, When mkdir, Then throws FILE_EXISTS or NOT_A_DIRECTORY` (`:567`,
assertion `:585`), accepting either code as platform-dependent. §1b/§1c say the *directory-occupant*
row needs no such latitude — both adapters give `FILE_EXISTS`, pinned. A tolerant row would still
have caught today's bug (which throws nothing at all), but it would not catch a future adapter
emitting the *wrong one* of the two codes, and there is no evidence to justify the latitude. The
ancestor row is the mirror image: genuinely adapter-dependent at depth 1, and in agreement at
depth ≥ 2 on the code alone.

### §6 The port's wording is the thing that let this happen

```
/** Write bytes to file. Fails with FILE_EXISTS if the file already exists (exclusive create). */
```

"the file already exists" reads as *a file exists at this path*, which is precisely what the memory
adapter implemented. `design/ports-and-adapters.md:561` then wrote the narrow reading down as the
memory adapter's spec. The contract obligations listed underneath cover parent creation and the
symlinked-ancestor escape, but never say what counts as an occupant. DC-D.

### §7 Faithfulness posture

The port contract is the oracle for this change and **no new interop test ships**:

- The node adapter's behaviour is unchanged by this design, so there is no new node-side behaviour
  to pin cross-tool. §1a records that it already matches git.
- The memory adapter has no canonical-git counterpart — git cannot be pointed at an in-process
  `Map`, so a cross-tool test is not constructible for it. `.claude/workflow/faithfulness.md` is
  explicit that parity tests are cross-adapter and prove nothing about faithfulness; the inverse
  also holds — an adapter with no on-disk existence has no interop surface.
- §1a is nonetheless recorded in full so the claim *"refusing a directory is the git-faithful
  choice"* rests on a probe rather than on assertion.

---

## Decision candidates

| # | Choice | Alternatives (≤3) | Recommendation | Why |
|---|---|---|---|---|
| **DC-A** | Shape of the occupancy guard in `memory-file-system.ts` | **1.** Add `\|\| this.directories.has(normalized)` inline in `writeExclusive`, mirroring `symlink`. **2.** Extract `private occupied(normalized): boolean` returning the three-way disjunction; `writeExclusive` and `symlink` each throw `fileExists(path)` on it. **3.** Extract `private assertUnoccupied(normalized, path): void` that throws, called by both writers. | **2** | Two writers compute the identical predicate and one of them got it wrong — that is the duplication worth removing, and it halves the guard's mutant population by having one expression instead of two. Option 3 folds the `throw` in too, which reads well but couples the predicate to one error code and leaves no boolean to test directly. Option 1 is the smallest diff and is defensible on that ground alone; it just leaves the second copy free to drift again. **In all three, `exists` stays as it is** — §3 shows *not existing* and *occupied* are different predicates that already disagree on a dangling symlink, so folding `exists` in would cement a coincidence as intent. |
| **DC-B** | The ancestor-is-a-file case (rows H/I/J): memory throws `NOT_A_DIRECTORY` carrying the **ancestor** path from `addDirectoryRecursive`; node throws `FILE_EXISTS` at depth 1 and `NOT_A_DIRECTORY` at depth ≥ 2, always carrying the **requested** path | **1.** Leave memory's behaviour and reported path alone; document the divergence in the port JSDoc (DC-D) and cover only depth ≥ 2 in the contract suite. **2.** Change `addDirectoryRecursive` to throw `notADirectory(requestedPath)`, aligning the *path* across the seven surfaces that funnel through it (`write`, `writeUtf8`, `writeStream`, `appendUtf8`, `writeExclusive`, `rename`, `mkdir`). **3.** Align memory to node exactly, depth-1 `FILE_EXISTS` included. | **1** | The matrix shows **node is not self-consistent**: rows H and I are the same fault at two depths with two different codes, because `mkdir -p` decides it, not a design choice. There is no "node behaviour" to converge on. Option 3 would import node's `mkdir -p` accident into an adapter that has no `mkdir -p`. Option 2 is *cheap* — the sweep confirms **no test anywhere asserts `data.path` on an adapter-produced `NOT_A_DIRECTORY`** (the only three `data.path` assertions are the domain factory test and two config-read pass-through-identity tests over test-constructed errors), so nothing breaks — but it fixes the cosmetic half of the divergence while leaving the code half (row H) exactly as divergent, which buys consistency of a field no caller reads. Option 1 is the only one that does not trade a real divergence for a cosmetic one. This is a *decision that the behaviour is acceptable and documented*, not a deferral — nothing is left open. |
| **DC-C** | Where the cross-adapter proof lives, and how strict | **1.** Contract suite only: a strict `FILE_EXISTS` directory-occupant row, plus a strict depth-≥2 ancestor row asserting `NOT_A_DIRECTORY` by **code only**, with an in-file note that depth 1 is adapter-dependent. **2.** Those rows **plus** a `test/parity/` scenario projecting the refusal code into a plain result compared against the shared golden. **3.** Memory-only unit rows; the contract suite untouched. | **1** | The contract suite is purpose-built for exactly this, already drives both adapters, and its four assertion helpers already assert code-without-path — so the ancestor row is idiomatic there, not a compromise. The directory row must be strict because §1b/§1c pin one code on both adapters and there is no evidence justifying latitude. Option 2 looks attractive now that §5 shows parity *does* have a slot, but it is a trap: **`test/browser/parity.spec.ts` runs every registered scenario against real OPFS**, so a refusal scenario is a browser assertion too and turns the browser parity spec red unless DC-E is taken as well — it would also duplicate the contract row with a weaker oracle (one projected code string) and would need the asserted path normalised across a `/repo` root and an `mkdtemp` root. Option 3 leaves the node side unwritten and the parity claim unproven. |
| **DC-D** | Tighten the `writeExclusive` JSDoc on `src/ports/file-system.ts` | **1.** Rewrite the summary to *"Fails with `FILE_EXISTS` if **anything** already occupies `path` — a regular file, a directory, or a symbolic link (including a dangling one)"*, and add one obligation line saying a **file at an ancestor** segment refuses, with the code adapter-dependent at depth 1 (`FILE_EXISTS` or `NOT_A_DIRECTORY`). **2.** Tighten only the occupancy sentence; say nothing about ancestors. **3.** Leave the wording as it is. | **1** | The ambiguity in *"the file already exists"* is the proximate cause: the memory adapter read it narrowly, and `design/ports-and-adapters.md:561` wrote the narrow reading down as spec. Fixing the code without fixing the sentence leaves the next adapter free to repeat it. Documenting the depth-1 ancestor divergence is what makes DC-B option 1 a decision instead of an omission. Option 2 fixes the cause but hides the surviving divergence. |
| **DC-E** | The browser adapter's `assertDoesNotExist` swallows `TypeMismatchError`, so a directory occupant escapes `writeExclusive` as a **bare `DOMException`** — outside the port's error contract (§1d; derived from the adapter source + normative spec, not executed) | **1.** Out of scope; record the derivation in this doc and change nothing. **2.** Fix in this PR — narrow the catch so a `TypeMismatchError` becomes `fileExists(path)` — and pin it with one new case in `test/browser/opfs-roundtrip.spec.ts` against real OPFS. **3.** Fix in this PR with no e2e pin, resting on the spec derivation alone. | **2** | It is the same defect at the same seam, and the browser outcome is worse than memory's: an unmapped `DOMException` defeats `errorDataCode` and turns a `PACK_ARTIFACT_MISMATCH` into an opaque throw. The fix is a few lines in one method, the browser adapter sits outside both the coverage and the mutation gates so it adds no gate cost, and `test/browser/opfs-roundtrip.spec.ts` already exists to host the pin (chromium + firefox; the file already skips webkit, whose Playwright build does not expose OPFS). **Cost to weigh:** it is real scope growth beyond the brief, and it is the only part of this change that needs a Playwright run. Option 3 ships an unverified behaviour change to the one adapter with no automated safety net — the least defensible of the three. |
| **DC-F** | The same defect family in **non-exclusive** `write`: memory silently replaces a directory with a file where node throws `PERMISSION_DENIED` (`EISDIR`) | **1.** Out of scope — the brief scopes `writeExclusive`. **2.** Fix `write` in this PR (memory throws `permissionDenied(path)` for a directory at the leaf); `writeUtf8`, `writeStream` and `appendUtf8` all inherit it by delegation, so one guard covers four surfaces. **3.** Option 2 **plus** `rename`, the remaining surface that can land a file entry on a directory name. | **2** | `write` is far more heavily used than `writeExclusive`, so the port's cross-adapter guarantee stays broken in the common case if only the exclusive path is fixed — and every other byte-writing surface funnels through `write`, so one guard closes them all. Option 3 grows the blast radius into `rename`, whose destination-clobber and `renameDirectory` semantics were **not probed here** and would need their own matrix before anything is changed. **Cost to weigh:** option 2 is scope growth beyond the brief and needs its own unit rows plus a contract row; a memory-backed test that currently writes over a directory path would start failing (none found, but the sweep is the check). Option 1 is defensible purely on scope discipline. |

---

## Test strategy

### Inventory — what exists, what changes

`test/**` swept for every `writeExclusive` override / spy, every `stat` fake near a pack artefact,
and every `FILE_EXISTS` / `NOT_A_DIRECTORY` assertion. Result: **exactly one edit**, plus one title
correction.

| File · lines | Given → When → Then | Verdict |
|---|---|---|
| `test/unit/application/primitives/internal/write-pack-artifacts.test.ts` **:889–920** (`writeExclusive` override at **:913–916**, `stat` size fake at **:917–920**, comment at **:892–899**) | `Given a directory occupying the .idx sibling name` → `When writePackSiblingArtifacts runs` → `Then it refuses naming the index instead of surfacing a raw filesystem error` | **EDIT.** Drop the `writeExclusive` override; **keep** the `stat` size fake (it forces `isFile` to be the sole discriminator, which is the point). Rewrite the Arrange comment — it currently reads *"…the memory adapter only checks files/symlinks — so `writeExclusive` is patched here to reject the same way a correct adapter (or a real one) would"*, which is precisely the sentence this change retires |
| same file **:343–348** (`.rev` → `PERMISSION_DENIED`), **:981–986** (`.promisor` → `PERMISSION_DENIED`) | `Given writeExclusive rejects for the .rev path` / `…the .promisor path with something other than FILE_EXISTS` | **KEEP.** Non-`FILE_EXISTS` injections pinning the rethrow branch; unrelated |
| same file **:479–485**, **:523–529**, **:602–608** (`vi.spyOn`) | tmp-name shape / `Math.random` scaling / tmp-debris cleanup | **KEEP.** Call-order and argument pins |
| `test/unit/application/primitives/fetch-pack.test.ts` **:5311–5331** (`stat` size fake at **:5328–5331**) | `Given a directory whose stat happens to report the same size as the pack, occupying the content-addressed destination` → … → `Then it refuses naming the destination instead of surfacing a raw filesystem error` | **UNAFFECTED — and this is the brief's second candidate.** It patches `stat` only; the `.pack` destination is reached by quarantine-rename with a stat/read pre-check, never by `writeExclusive`. It does **not** become redundant |
| `test/unit/application/primitives/fetch-pack.test.ts` **:4130–4206**, `commands/fetch.test.ts:1867`, `commands/internal/index-update.test.ts` **:297/319/512/548**, `primitives/atomic-write.test.ts` **:60/98**, `primitives/write-object.test.ts` **:152/178**, `primitives/reftable-transaction.test.ts` (14 spies), `commands/maintenance.test.ts:2521`, `commands/branch.test.ts` **:734/765/793/824** (`Proxy`), `primitives/fixtures.ts:273` | assorted | **KEEP, all.** Recorders, non-`FILE_EXISTS` faults, or `FILE_EXISTS` injected to drive *caller* retry/remap logic. None fakes the directory-occupant behaviour |
| `test/unit/adapters/memory/memory-file-system.test.ts` **:811–818** | `Given the memory fs has no real symlinks` → `When writeExclusive is called` → `Then succeeds (symlink-safe contract trivially holds)` | **RETITLE.** The premise is false — the memory adapter has symlinks, and rows E–G prove `writeExclusive` refuses them. The body proves parent auto-creation; the title should say so |

**Nothing breaks.** `data.path` is never asserted on an adapter-produced `NOT_A_DIRECTORY`
anywhere in the suite. Exactly one test pins a *production-produced* `FILE_EXISTS` path —
`fetch-pack.test.ts:4189` (`…/tmp_pack_<random>`, the quarantine give-up message) — and it is on a
path this change cannot reach. The lock-seeding `await ctx.fs.writeExclusive(lockPath, …)` calls
across `checkout` / `mv` / `rm` / `reset` / `fsck` / `apply-sparse-checkout` / `pack-refs` /
`fetch-missing` / `reftable-transaction` all target file paths, never directories.

### New memory-adapter unit cases

`test/unit/adapters/memory/memory-file-system.test.ts`, under
`describe('MemoryFileSystem') > describe('writeExclusive contract')`, house GWT split
(`describe('Given …')` > `describe('When …')` > `it('Then …')`), AAA comments, `sut` = the adapter,
error assertions via try/catch + `data.code` (never `toThrow(Class)`).

| Req | Given | When | Then |
|---|---|---|---|
| R1 | an empty directory occupies the target path | `writeExclusive` | throws `FILE_EXISTS` carrying the requested path |
| R2 + R7 | a directory holding a child file occupies the target path | `writeExclusive` | throws `FILE_EXISTS`, the child is still readable byte-for-byte, and no file entry appears at the directory's name |
| R3 | the target path is the adapter's root directory | `writeExclusive` | throws `FILE_EXISTS`, and a later write elsewhere in the tree still succeeds |
| R4 | a regular file occupies the target path | `writeExclusive` | throws `FILE_EXISTS` |
| R5 | a symlink occupies the target path | `writeExclusive` | throws `FILE_EXISTS` |

R4 and R5 exist **as separate one-occupant cases** even though the file case is already covered by
the contract suite: each `||` term needs a test that trips it alone, or the `LogicalOperator`
mutants survive. R3 is the `rootDir` regression from §2b and is memory-specific (node's root is a
real directory the contract driver cannot reasonably occupy).

R7's "no timestamp written" half is asserted structurally — via `lstat` on the surviving directory
and a read-back of the child — rather than by reaching into `times`, which is private.

The stale title `describe('Given the memory fs has no real symlinks')` is corrected to state what
its body actually proves (a nested path auto-creates its parents), since the premise is false.

### New shared contract rows

`test/unit/ports/file-system.contract.ts`, in the existing 1-level
`it('Given …, When …, Then …')` style that file uses, run by **both** the memory driver
(`MemoryFileSystem({ rootDir: '/repo' })`) and the node driver (real `mkdtemp` root):

| Req | Row | Strictness |
|---|---|---|
| R9 | `Given an existing directory, When writeExclusive, Then throws FILE_EXISTS` | strict — one code, via the existing `assertFileExists` helper (`:88`) |
| — | `Given a file at a grandparent path segment, When writeExclusive, Then throws NOT_A_DIRECTORY` | strict on the code, via `assertNotADirectory` (`:93`) — which asserts no `data.path`, so no new helper is needed. Depth ≥ 2 only; an in-file comment records that depth 1 is adapter-dependent |

Both rows go next to the existing `Given existing file, When writeExclusive, Then throws
FILE_EXISTS` (`:389`) and `Given non-existent path, When writeExclusive, Then creates file`
(`:403`). Neither needs an addition to the `pathCalls` security table (`:34–76`) — `writeExclusive`
is already row `:39` there.

No symlink-occupant contract row is proposed: the node driver's leaf is not realpathed
(`realpathForCreation` caches the **parent** and joins the basename), so `O_EXCL` decides and both
adapters give `FILE_EXISTS` — but the contract suite's `symlinkReadEscape` capability hook shows the
file's own convention is to gate symlink behaviour per adapter, and adding a row that happens to
agree today without a capability declaration would over-constrain a future adapter. Rows E–G stay
memory-side.

### Receive-path test edit

One edit, at `test/unit/application/primitives/internal/write-pack-artifacts.test.ts:889–920` —
see the inventory table for exactly what goes and what stays. After it, the test proves the real
memory adapter refuses a directory occupant and `writeOrKeepArtifact` classifies it, which is R10.

### Regression risk

The failure mode to fear is an existing test that *relies* on memory's permissiveness — an
exclusive write onto a path an earlier step made a directory. The sweep above found none: every
lock-seeding `writeExclusive` call targets a file path, and no adapter-produced `NOT_A_DIRECTORY`
`data.path` is asserted anywhere. `npm run validate` is still the arbiter, not this paragraph.

### Property tests — the four lenses, and why none fits

Checked deliberately, not skipped.

1. **Round-trip pair** — no. Nothing here parses what another function serialises; `writeExclusive`
   has no inverse.
2. **Compositional matcher / aggregator** — closest, and still no. `occupied()` reduces three
   `Map`/`Set` lookups to a boolean, but the "rules" are three fixed namespaces, not an
   arbitrary-length list. There is no empty-input identity, no append, no negation to invert — the
   invariants a property would state (*"occupied ⟺ the path is in exactly one of three sets"*) are
   the implementation restated.
3. **Total function over an algebraic grammar** — no. The input is a path string, and the interesting
   axis is *filesystem state*, not path syntax. A generator over paths would re-draw the same three
   arrangements the example sweep already covers exhaustively.
4. **Idempotence / counting invariant** — no. A second `writeExclusive` at the same path is a
   *different* outcome by design (that is the whole contract), so idempotence is the wrong property;
   nothing counts.

R8 (pairwise disjointness) is the one statement with property-shaped appeal — *no reachable sequence
of adapter calls puts one key in two namespaces* — but writing it needs a generator over adapter
operation sequences and a re-implementation of the state machine as oracle, which is the tautology
the fourth lens warns against. It is asserted instead by the R1–R3 example cases at the only method
that could break it. **No `*.properties.test.ts` sibling ships, and this paragraph is the recorded
reason.**

### Gates

Per-part: `npx vitest run <touched test files>`, `npm run check:types`,
`./node_modules/.bin/biome check <touched files>`, `npx cspell --no-progress <touched files>` bare
(the wireit-cached scripts report `Ran 0 scripts and skipped 1`, which reads exactly like a pass).
Phase: `npm run validate`, run bare into a file with the exit code read from that file — never
through a pipe, never `--no-verify`. Default parallelism on a quiet tree. `npm outdated` is
re-measured before the full gate (eight excepted packages, `.claude/workflow.md`).

Coverage stays at 100 % on `src/adapters/memory/**`; the mutation gate covers it too
(`stryker.config.mjs` mutates all of `src` except `index.ts`, `*.d.ts` and
`src/adapters/browser/**`). Under DC-E the browser fix is outside both gates and is proven only by
the Playwright case.

---

## Out of scope

- **Node-adapter behaviour.** Nothing in §1b changes. ADR-721 (read containment) and ADR-782
  (`readSlice` as the pass-2 seam) are untouched, and no node write-path semantics move.
- **`write-pack-artifacts.ts` production code.** ADR-789 governs its input shape; this change edits
  that module's **tests** only.
- **A new interop test.** §7 — the port contract is the oracle, the node adapter's git-facing
  behaviour is unchanged, and the memory adapter has no cross-tool surface.
- **Row L — memory refusing a symlinked ancestor that node follows.** Real divergence, opposite
  direction (memory stricter), and closing it means teaching `addDirectoryRecursive` to resolve
  symlinks and re-check containment. That is a containment-model change and belongs with ADR-721's
  family, not here.
- **`exists` on a dangling symlink** — node returns `false` (it stats, and stat follows), memory
  returns `true` (its three-way `has` disjunction sees the link entry). Probed in §3. A real
  divergence from the port's own wording, in a *different* method, with a different correct answer
  (`false`), and fixing it means giving memory's `exists` a follow-and-resolve step. It is named
  here because DC-A must not accidentally paper over it by sharing a helper.
- **`write-object.ts`'s treatment of a directory occupant as "we already have this object".** Once
  memory refuses, both adapters take the `isFileExists` arm and return the oid **without the object
  being written** — a pre-existing question about the *caller*, identical on node today, and not
  created by this change.
- **A `test/parity/` scenario.** A slot *does* exist — the brief's premise was wrong and §5 corrects
  it — but under DC-C option 1 none is added, because every registered scenario also runs against
  real OPFS in `test/browser/parity.spec.ts` and would go red on the browser gap until DC-E lands.
  This is a scoping decision recorded in DC-C, not a claim of impossibility.
- **A `BACKLOG.md` tick.** This is not a backlog item.
- **Anything under DC-E or DC-F the user declines.** Both are recommended as in-PR, both are honest
  scope growth beyond the brief, and neither is assumed.
