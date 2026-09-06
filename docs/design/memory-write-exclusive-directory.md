# Design — the memory and browser adapters refuse an occupied name on every write surface

> Brief: `MemoryFileSystem.writeExclusive` refuses a **file** or a **symlink** occupant but not a
> **directory** — it overwrites the name with a file entry and returns success. The node adapter
> refuses with `FILE_EXISTS`, and so does canonical git. Close the gap, prove it cross-adapter,
> and drop the test-side patches that existed only to fake the POSIX behaviour.
> **Scope after the first decisions round:** the same defect family in non-exclusive `write` and in
> `rename` is in scope too — the user ratified option 3 of DC-F against the design's own
> recommendation.
> **Scope after the second decisions round:** the browser adapter's `write`/`rename` mapping
> (ADR-816, again ratified against the design's recommendation), the `rename`-into-itself clause
> (ADR-817), the symlink-leaf write refusal (ADR-818) and the posix-only home for node's strict
> codes (ADR-819). Every decision candidate this document ever raised is now settled; the candidate
> table below raises none.
> Status: draft → self-reviewed ×3 → accepted (ADRs 810–815) → revised (write + rename folded in)
> → self-reviewed ×3 → accepted (ADRs 816–819) → revised (browser write/rename folded in)
> → self-reviewed ×3 → three review cycles folded in

## Context

### What the three write surfaces are for

`writeExclusive` is the port's only exclusive-create primitive, and every caller depends on the
*refusal*, not on the write. Fifteen production call sites, four distinct protocols:

| Protocol | Call sites | What `FILE_EXISTS` means to the caller |
|---|---|---|
| **Lock files** | `internal/index-lock.ts:55,84,98`, `atomic-write.ts:28` (every ref update), `shallow-file.ts:105`, `reftable-transaction.ts:147` | *Another writer holds the lock* → `refLocked` / `RESOURCE_LOCKED` refusal |
| **Loose objects** | `write-object.ts:46` | *We already have this object* → keep the existing bytes, return the oid |
| **Pack artefacts** | `internal/write-pack-artifacts.ts:169,183,271,353,354`, `internal/cruft-pack-lifecycle.ts:244` | *An artefact already occupies the name* → compare, keep if identical, else `PACK_ARTIFACT_MISMATCH` |
| **Name probing** | `fetch-pack.ts:312`, `reftable-transaction.ts:675` | *That random temp name is taken* → draw another |

`write` (and its three delegating siblings `writeUtf8`, `writeStream`, `appendUtf8`) is the
byte-writing surface every other command reaches for; it has no refusal protocol of its own —
callers expect it to *succeed*, which is exactly why a silent success over a directory goes
unnoticed.

`rename` is the commit step of every lock protocol (`atomic-write.ts:36`, `index-lock.ts:137`,
`shallow-file.ts:107`, `reftable-transaction.ts:712,749,1015`), the quarantine promotion in
`fetch-pack.ts:374`, the reflog move in `ref-store.ts:712`, and the leaf mover in
`commands/internal/working-tree.ts:138`. That last one is the only caller that could be pointed at a
directory, and it cannot be: `moveNode` recurses into a directory and only ever calls
`ctx.fs.rename` on a leaf — the shape adopted after backlog **21.2a** caught the node adapter
throwing `EISDIR` there.

Every refusal named above is a **refusal condition** in the prime directive's sense (CLAUDE.md,
ADR-226): observable behaviour that must match canonical git. A silent success where git refuses is
exactly the class of divergence the directive exists to prevent.

### The three first-party adapters and their gates

| Adapter | 100 % coverage gate | Stryker mutation gate | Cross-adapter proof today |
|---|---|---|---|
| `adapters/node` | yes (`vitest.config.ts` `coverage.include`) | yes | `test/unit/ports/file-system.contract.ts` |
| `adapters/memory` | yes | yes | same contract suite |
| `adapters/browser` | **no** (not in `coverage.include`) | **no** (`stryker.config.mjs` `mutate` excludes `src/adapters/browser/**`) | Playwright only (`test/browser/`) |

**The unit project runs on three operating systems.** `.github/workflows/ci.yml:257` sets
`os: [ubuntu-latest, macos-latest, windows-latest]` for the unit matrix, and the shared contract
suite lives at `test/unit/ports/file-system.contract.ts` — so **every node-side assertion added
there also runs on Windows**. This is load-bearing for §5 and was not a consideration in the first
pass, which only added a row whose errno (`EEXIST` from `O_EXCL`) is universal.

### Governing decisions this design sits inside

| ADR / design | What it binds here |
|---|---|
| **ADR-226** git-faithfulness prime directive | Refusal conditions are observable behaviour; pin against the real binary. §1a is that pin |
| **ADR-052** `DIRECTORY_NOT_EMPTY` (`mapErrno` ENOTEMPTY split) | The exact precedent: *"the memory adapter's analogous error path must produce the same code for cross-adapter parity"*. This change is the same move for `FILE_EXISTS`, `PERMISSION_DENIED` and — now — `DIRECTORY_NOT_EMPTY` itself, on `rename` |
| **ADR-810** one `occupied()` predicate | Settles DC-A. `writeExclusive` and `symlink` share one three-namespace predicate; `exists` is not folded in |
| **ADR-811** a file at an ancestor keeps memory's own report | Settles DC-B. Memory keeps `NOT_A_DIRECTORY` + ancestor path at every depth; the depth-1 divergence is documented, not fixed. Binds `write` and `rename` too — both funnel through `addDirectoryRecursive` |
| **ADR-812** cross-adapter proof lives in the contract suite | Settles DC-C. Strict codes, no `test/parity/` scenario, no symlink-occupant row. **Refined by ADR-819** for the two new surfaces: `writeExclusive` stays strict, `write`/`rename` do not |
| **ADR-813** the port comment names every occupant shape | Settles DC-D. Rewrite the `writeExclusive` JSDoc; correct `ports-and-adapters.md:561` |
| **ADR-814** browser maps a directory occupant to `FILE_EXISTS` | Settles DC-E for `writeExclusive` **only**. Its `assertDoesNotExist` narrowing and ADR-816's `resolveFileHandle` arm share one `TypeMismatchError` predicate → §3f |
| **ADR-815** non-exclusive `write` and `rename` refuse a directory occupant | Settles DC-F as **option 3**, against the design's recommendation. Required the `rename` matrix *before* implementation → §1e |
| **ADR-816** browser `write`/`rename` map a directory occupant to `PERMISSION_DENIED` | Settles DC-G as **option 2**, against the design's recommendation. `resolveFileHandle` gains a `create: true`-**only** arm; the `create: false` mapping `stat`/`exists` depend on is untouched; two Playwright cases pin it → §1f, §3f |
| **ADR-817** `rename` into itself refuses **before** the destination-kind check | Settles DC-H as **option 1**. One clause throwing `unsupportedOperation('filesystem', <the invalid-argument errno>)`, matching linux; darwin's `NOT_A_DIRECTORY` on the one divergent arrangement is a knowing divergence → §3c |
| **ADR-818** non-exclusive writes refuse a **symlink** leaf | Settles DC-I as **option 1**. The `write` guard is two terms, so `files`/`directories`/`symlinks` become pairwise disjoint under every port call → §3b, R8a |
| **ADR-819** node's strict codes live in the posix-only suite | Settles DC-J as **option 2**. Contract rows for `write`/`rename` assert instance + non-destructiveness; a new `test/integration/posix-only/` file carries the strict node codes; `writeExclusive` rows stay strict → §5 |
| **ADR-721** first-party read containment is single-authority | Governs `node-file-system.ts`'s read path. Untouched: this change adds nothing to the node adapter |
| **ADR-782** pass-two reads go through `readSlice` | Governs the `readSlice` seam on `ports/file-system.ts`. Untouched |
| **ADR-789** the `.idx`/`.rev` serializers take the oid slab | Governs `write-pack-artifacts.ts`'s input shape. This change touches that module's **tests** only |
| **ADR-628** the `.rev` is written exclusively like its siblings | Why the `.rev` is on `writeExclusive` at all, and therefore in this blast radius |
| `design/ports-and-adapters.md:561` | The line that *codified* the bug: *"**`writeExclusive`:** Checks `Map.has(path)` — throws `FILE_EXISTS` if present."* One map, not three namespaces |
| `design/ports-and-adapters.md:565` | Now also wrong: *"**`rename`:** Delete old key + insert new key (not atomic, but single-threaded JS is safe)."* It describes exactly the unguarded clobber §1e falsifies |
| `design/bench-snapshot-summary-adr-lint.md:584` | Asserts *"`exists`, `readSlice` and `writeExclusive` behave identically on both first-party adapters"*. **Two thirds false**: §1c falsifies it for `writeExclusive`, §3a for `exists`. This change makes the `writeExclusive` clause true; the `exists` clause stays false and is in §Out of scope |
| `docs/BACKLOG.md` **21.2a** | Prior art for the defect class, in this file family: *"caught a shipped bug: `repo.mv` on a directory rename threw `EISDIR` on the Node adapter (memory tolerated it, so unit+parity missed it)"* |

There is **no backlog entry** for this work — it was surfaced while fixing PR #295 and chosen
directly by the user, so nothing gets ticked.

---

## Requirements

Every statement below is checked by a test named in §Test strategy, except **R8b**, which records a
route deliberately left open and therefore has nothing to assert. Nothing here is conditional any
more: the second decisions round settled the four candidates the previous revision left open, so no
requirement is written as *"depends on DC-x"*.

**Numbers are stable identifiers, not an ordering.** R28–R32 were added by that round and sit in the
block they belong to rather than at the end, so cross-references from the ADRs and from §1–§7 keep
pointing at the same statements.

**Exclusive create — settled by ADR-810**

- **R1** — `MemoryFileSystem.writeExclusive(p, d)` throws `TsgitError` with `data.code === 'FILE_EXISTS'`
  and `data.path === p` when an **empty directory** occupies `p`.
- **R2** — Same when the directory at `p` **has children**.
- **R3** — Same when `p` is the adapter's `rootDir` itself (today it is silently overwritten; §2b).
- **R4** — Unchanged: a **regular file** at `p` refuses with `FILE_EXISTS`.
- **R5** — Unchanged: a **symlink** at `p` refuses with `FILE_EXISTS` regardless of its target.
- **R6** — Unchanged: an absent `p` writes the bytes and auto-creates missing parents.
- **R7** — A refused `writeExclusive` mutates nothing *observably*: `lstat(p)` still reports
  `isDirectory: true` (memory directories carry no timestamps, so none are asserted), and every child under `p/` reads back
  byte-identical. (Stated on the port surface, not on the private `files`/`times` maps.)

**Non-exclusive write — settled by ADR-815, extended by ADR-818**

- **R12** — `write(p, d)` throws `PERMISSION_DENIED` with `data.path === p` when an **empty
  directory** occupies `p` (node: `EISDIR` → `mapErrno`; §1d row W1).
- **R13** — Same when the directory at `p` **has children**, and every child still reads back
  byte-identical afterwards, and `readdir(p)` still lists them.
- **R14** — Same when `p` is the adapter's `rootDir`, and a later write elsewhere in the tree still
  succeeds (the §2b brick, on the far more common surface).
- **R15** — `writeUtf8`, `writeStream` and `appendUtf8` inherit R12 by delegation — one named test
  each. `appendUtf8` additionally reads nothing and mutates nothing before refusing: its
  `readExistingUtf8` decodes `undefined` to `''` for a directory, so the observable is a clean
  `PERMISSION_DENIED` with no partial effect.
- **R16** — Unchanged: `write` over a regular file overwrites; over an absent path it creates the
  file and its missing parents.
- **R28** *(ADR-818)* — `write(p, d)` throws `PERMISSION_DENIED` with `data.path === p` when a
  **symlink** occupies `p`, live or dangling, and `readlink(p)` still returns the original target
  and `read` of the target is unchanged (node: `ELOOP` from `O_NOFOLLOW`; §1d row W9).
  `writeUtf8`, `writeStream` and `appendUtf8` inherit it by delegation — one named test each for
  the *directory* term (R15) and one for the *symlink* term, because a single test tripping both
  disjuncts proves neither (§3e).

**Rename — settled by ADR-815, codes pinned by §1e**

Every refusal carries `data.path === src`, matching the node adapter, whose `rename` wraps the whole
operation in `runFs(op, src)`.

- **R17** — `rename(s, d)` throws `PERMISSION_DENIED` with `data.path === s` when `s` is a **file or
  a symlink** and a directory — empty or not — occupies `d` (node: `EISDIR`).
- **R18** — Throws `NOT_A_DIRECTORY` with `data.path === s` when `s` is a **directory** and a
  regular file or a symlink occupies `d` (node: `ENOTDIR`).
- **R19** — Throws `DIRECTORY_NOT_EMPTY` with `data.path === s` when `s` is a **directory** and a
  **non-empty directory** occupies `d` (node: `ENOTEMPTY`).
- **R20** — **Succeeds**, replacing, when `s` is a directory and an **empty directory** occupies
  `d`. This is POSIX and it is what memory already does; it is a requirement because the R19 guard
  must not over-refuse it.
- **R21** — **Succeeds as a no-op** when `s === d`, for a regular file and for a **non-empty
  directory** alike. Node succeeds on both; without an explicit escape the R19 clause would newly
  refuse `rename(dir, dir)`, which is the sharpest regression this change can introduce.
- **R22** — Every refusal in R17–R19 mutates nothing *observably*: `lstat(s)` and `lstat(d)` keep
  their kinds, `readdir` of either directory is unchanged, and every child reads back
  byte-identical. In particular the guard runs **before** the destination `delete` calls.
- **R23** — `atomicRename` inherits R17–R22 by delegation, and stays atomic: the guard is pure
  inspection with no `await`, so the "no observer sees an intermediate state" claim in the port
  JSDoc survives.
- **R27** *(ADR-817)* — `rename(s, d)` refuses when `s` is a directory and `d` lies **inside** `s`,
  throwing `UNSUPPORTED_OPERATION` with `operation: 'filesystem'` and the invalid-argument errno
  name as `reason` (no `path` field — that variant of `AdapterError` has none), for every occupant
  at `d`: absent, an existing directory empty or not, an existing regular file, an existing
  symlink, at any depth. `rename(rootDir, <inside>)` is the same clause (N12). Afterwards `s`'s
  subtree is intact and `lstat(s)` still reports a directory. This is a *separate* invariant from
  R8a: it never produces a cross-namespace collision, it produces a `directories` set holding a
  path whose own parent is absent — a directory reachable by `readdir` through a parent that
  `lstat` reports as `FILE_NOT_FOUND`.
- **R24** — Unchanged: an absent `s` throws `FILE_NOT_FOUND` with `data.path === s`; a file renamed
  over a symlink replaces the link and leaves its target untouched; a symlink renamed over a file
  replaces the file; a directory renamed to a fresh name re-keys its whole subtree.

**Invariant**

- **R8a** — After the change, `files`, `directories` and `symlinks` are **pairwise disjoint** under
  every reachable sequence of `FileSystem` port calls — all three pairs, not two. Not a new
  invariant: five committed Stryker equivalence proofs already assume it (§2c), and after
  ADR-810 + ADR-815 + ADR-817 + ADR-818 every method that could violate it is guarded — so R1–R3,
  R12–R14, R17–R19 and R28 are where it is actually enforced. §2d walks the routes and shows each
  is now closed.
- **R8b** — The invariant is stated over **port calls**, and one route outside them stays open: the
  constructor's `files` option can seed a key that a later entry's `ensureParentDirs` has already
  put in `directories` (§2d) — a `files ∩ directories` collision reachable only from a test fixture.
  It is named rather than claimed, so no later reader mistakes R8a for an unconditional claim about
  every way a `MemoryFileSystem` can come into existence. `files ∩ symlinks` — the pair the previous
  revision left open — **is** closed by R28.

**Cross-adapter**

- **R9** — The shared port contract suite carries a directory-occupant `writeExclusive` row that
  **both** drivers pass, asserting `FILE_EXISTS` strictly (ADR-812).
- **R10** — `writeOrKeepArtifact` classifies a directory occupying `pack-<sha>.idx` as
  `PACK_ARTIFACT_MISMATCH` on the memory adapter **with no test-side patch of `writeExclusive`**.
- **R25** *(ADR-819)* — The contract suite carries a row for each new `write` / `rename` refusal
  family that both drivers pass, asserting a structured `TsgitError` **plus non-destructiveness**
  and no code — the `:676` precedent — because §1e verified darwin and linux while that file also
  runs on `windows-latest`. The `writeExclusive` rows stay strict (R9).
- **R32** *(ADR-819)* — A new file under `test/integration/posix-only/` pins the **node** adapter's
  exact `data.code` (and `data.path` where the variant carries one) for every §1d / §1e row on which
  darwin and linux agree. It runs in the `posix-integration` project only.

**Review round — added by the four-dimension review**

- **R33** — A refused `write`, `writeExclusive`, `mkdir` or `rename` whose ancestor chain holds a
  regular file or a symlink records **no** directory entry: `addDirectoryRecursive` validates the
  whole chain before adding any of it, so the tree after a refusal is byte-for-byte the tree before
  it. Asserted by two memory rows (`write`, `mkdir`) and a probe in the shared contract grandparent
  row that both drivers pass.
- **R34** — `BrowserFileSystem.rename(p, p)` is a no-op: the file survives with its bytes, and an
  absent `p` still reports `FILE_NOT_FOUND`. Asserted against real OPFS.
- **R35** — The port's `rename` contract is scoped per adapter: `src === dst` is a no-op once
  `src` exists (an absent `src` still reports `FILE_NOT_FOUND`); the kind matrix and the
  `data.path === src` anchoring hold on node and memory; a regular file or symlink on the
  destination's ancestor chain refuses with `NOT_A_DIRECTORY` carrying an adapter-chosen path
  (node `dst`, memory the blocking ancestor) and changes nothing; the browser's emulation
  reports `FILE_NOT_FOUND` for a directory source and `PERMISSION_DENIED` carrying `dst` for a
  directory destination, and replaces no directory. The `writeStream` contract records that a
  refused write may already have consumed its source on either adapter.
- **R36** — Constructing a `MemoryFileSystem` with a `files` map that seeds a file where an
  earlier key already made a directory (the root included) throws `NOT_A_DIRECTORY` carrying
  the offending key. With the stale-handle write guard below, `files`, `directories` and
  `symlinks` are pairwise disjoint on **every** reachable state — seeding and handles included —
  so R8a holds without a footnote.

**Browser — settled by ADR-816**

- **R29** — `BrowserFileSystem.write` throws `PERMISSION_DENIED` with `data.path === path` when a
  directory occupies the leaf, and `writeUtf8`, `writeStream` and `appendUtf8` inherit it.
  `rename(src, dst)` with a **file** at `src` and a **directory** at `dst` throws the same and
  leaves `src` readable byte-identical, because `rm(src)` never runs.
- **R30** — The `create: false` mapping is **unchanged**: `resolveFileHandle(path, false)` still
  raises `FILE_NOT_FOUND` for a directory occupant, so `stat` and `exists` still fall back to
  `resolveDirHandle` and report a directory. This is the regression the fix must not cause, and it
  is the reason the new arm is conditional on `create` rather than helper-wide.
- **R31** — A regular file at an **ancestor** segment still reports `FILE_NOT_FOUND` on every write
  surface. `walkToParent` converts its own `TypeMismatchError` before `resolveFileHandle`'s `catch`
  is reachable (§3f), so the new arm cannot mis-map an ancestor fault as `PERMISSION_DENIED`.

**Documentation**

- **R11** — The `writeExclusive` JSDoc on `src/ports/file-system.ts` states the occupancy rule in
  terms of *anything at `path`*, not *"the file"* (ADR-813).
- **R26** — The port JSDoc for `write`, `writeStream`, `writeUtf8`, `appendUtf8`, `rename` and
  `atomicRename` states the directory-occupant refusal and its code. `write`'s current summary —
  *"Overwrites if exists"* — is the same narrow reading ADR-813 condemns, one method over.

---

## Design

### §1 The pinned matrices

Nothing below is recalled. Every row is a probe run for this design on **2026-09-05** against the
**composed adapter classes**, never the bare syscall — the distinction cost the first pass one wrong
assumption (§1b) and is the single most load-bearing methodological rule here.

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

The `index-pack` file row is *not* a counter-example: git's `.idx` finalisation is
tmp-write-then-rename, so a regular file is replaced while a directory makes the create fail. tsgit
places that tolerance one layer up, in `writeOrKeepArtifact` (ADR-804) — the port primitive
underneath stays strictly exclusive. `bench-snapshot-summary-adr-lint.md` already ruled on this
shape: *"the fix is a tolerant caller, never a permissive file system."*

#### §1b The node adapter, `writeExclusive` — the composed behaviour, not the syscall

Run against `NodeFileSystem` itself (not `fs/promises`) in a `mkdtemp` root, Node v22.22.3,
darwin 25.5.0. **This distinction is load-bearing:** `NodeFileSystem.writeExclusive` is

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
`FILE_EXISTS`, because `mkdir('<file>', {recursive:true})` yields `EEXIST`. Only the second is this
change's oracle.

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
property of `mkdir -p`, not a considered decision — which is why ADR-811 declined to align to it.
Row L is node honouring the port's own containment rule: the symlinked parent resolves *inside* the
root, so `resolveWrite` admits it.

#### §1c The memory adapter, `writeExclusive` — where it diverges

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
| H | file at immediate parent | `NOT_A_DIRECTORY` (**ancestor** path) | `FILE_EXISTS` (requested) | diverge — ADR-811 keeps it |
| I | file at grandparent | `NOT_A_DIRECTORY` (**ancestor** path) | `NOT_A_DIRECTORY` (requested) | code agrees, path differs — ADR-811 keeps it |
| J | symlink → file at immediate parent | `NOT_A_DIRECTORY` (ancestor path) | `FILE_EXISTS` (requested) | diverge — ADR-811 keeps it |
| K | **`path` is `rootDir`** | **writes** | `FILE_EXISTS` | **DIVERGE — worst case, §2b** |
| L | symlink → dir at immediate parent | `NOT_A_DIRECTORY` | writes | diverge — out of scope |

Rows C, D and K are what ADR-810 closes.

#### §1d The `write` matrix — composed adapters, both sides

`NodeFileSystem` over a `mkdtemp` root, constructed exactly as
`test/unit/adapters/node/node-file-system.test.ts:63–74` does (`mkdtemp` then `realpath`, because
macOS `os.tmpdir()` is a symlink), versus `MemoryFileSystem({ rootDir: '/repo' })`. Raw errnos taken
from `fs/promises` on the same arrangements, verified on **two platforms** (see §1e's platform note).

| # | Method | Occupant | raw errno | node adapter | `data.path` | memory today | memory target |
|---|---|---|---|---|---|---|---|
| W1 | `write` | **empty directory** at the leaf | `EISDIR` (open) | `PERMISSION_DENIED` | requested | **writes** — key lands in `files` *and* `directories` | `PERMISSION_DENIED(path)` |
| W2 | `write` | **directory with children** | `EISDIR` | `PERMISSION_DENIED` | requested | **writes**; children stay readable | `PERMISSION_DENIED(path)` |
| W3 | `write` | leaf **is** `rootDir` | `EISDIR` | `PERMISSION_DENIED` | requested (the root) | **writes** — bricks the adapter (§2b) | `PERMISSION_DENIED(path)` |
| W4 | `write` | regular file at the **immediate parent** | `EEXIST` (the adapter's own `mkdir -p`) | `FILE_EXISTS` | requested | `NOT_A_DIRECTORY` (**ancestor** path) | unchanged — ADR-811 |
| W5 | `write` | regular file at the **grandparent** | `ENOTDIR` | `NOT_A_DIRECTORY` | requested | `NOT_A_DIRECTORY` (**ancestor** path) | unchanged — ADR-811 |
| W6 | `writeUtf8` | empty directory | `EISDIR` | `PERMISSION_DENIED` | requested | **writes** | inherits W1 |
| W7 | `writeStream` | empty directory / with children | `EISDIR` | `PERMISSION_DENIED` | requested | **writes** | inherits W1 |
| W8 | `appendUtf8` | empty directory / with children | `EISDIR` (open) | `PERMISSION_DENIED` | requested | **writes** | inherits W1 |
| W9 | `write` / `writeStream` / `appendUtf8` | **symlink** at the leaf (live or dangling) | `ELOOP` (open, `O_NOFOLLOW`) | `PERMISSION_DENIED` | requested | **writes** — key lands in `files` *and* `symlinks`; `lstat` still says symlink, `read` returns the new bytes, `readlink` returns the old target | `PERMISSION_DENIED(path)` — ADR-818 |
| W10 | `writeExclusive` | empty directory (control) | `EEXIST` (open, `O_EXCL`) | `FILE_EXISTS` | requested | **writes** | `FILE_EXISTS` — ADR-810 |

**The four surfaces really are one guard.** `writeStream` (`memory-file-system.ts:93–104`) and
`writeUtf8` (`:116–118`) both end in `await this.write(...)`; `appendUtf8` (`:120–123`) calls
`readExistingUtf8` — a pure `files.get` + `TextDecoder` that mutates nothing — then `writeUtf8`. So a
single guard at the top of `write` covers all four, and `appendUtf8`'s observable is a clean
`PERMISSION_DENIED` with no partial read and no partial write.

#### §1e The `rename` matrix — composed adapters, both sides

The matrix ADR-815 requires before implementation. Same construction as §1d.

**Notation.** POSIX's invalid-argument errno is written `INVALID-ARGUMENT` throughout this document.
Its real six-letter name is not in `cspell.json` — its siblings `EACCES`, `EEXIST`, `EISDIR`,
`ELOOP`, `ENOENT`, `ENOTDIR`, `ENOTEMPTY` and `EPERM` all are — and this design commit is scoped to
a single file, so adding the dictionary entry is an implementation-phase chore, never a
`cspell:disable` comment. Verified for this revision: `npx cspell` flags both the full errno name
and its five-letter tail as unknown words, which is why the stand-in survives the fold rather than
being replaced by the literal now that ADR-817 has settled the clause.

It is the errno POSIX defines for *"an attempt was made to make a directory a subdirectory of
itself"*. `mapErrno` (`node-file-system.ts:217–247`) has **no case for it**, so it falls to the
`default` arm (`:244–245`) — `unsupportedOperation('filesystem', err.code ?? 'UNKNOWN')` — which forwards the raw
errno name verbatim as `reason`. The `reason` string on that error *is* the errno's real name, and
`'filesystem'` is node's own operation label, not an invention of this design.

**The exact dictionary insertion, for the plan.** `cspell.json`'s word list is case-insensitively
alphabetical and interleaves lower- and upper-case spellings (`EEXIST`, `effectful`, `EISDIR`,
`elementwise`, …). The errno name sorts **between `effectful` and `EISDIR`** — one line above the
`EISDIR` entry, which is `cspell.json:288` today. Insert it there and **do not re-sort the file**;
a re-sort would bury a one-word change in a several-hundred-line diff.

**`data.path` anchoring on the node adapter.** `NodeFileSystem.rename` (`node-file-system.ts:745`)
resolves both sides, then wraps the `mkdir -p` + `rename(2)` in `runFs(op, src)` — so **every errno
raised inside the operation carries `src`**, including the destination-side `mkdir` failure (N18).
The two pre-`runFs` `resolveWrite` calls carry their own argument instead (N19 carries `dst`, N20
carries `src`). This asymmetry is node's observable; it is recorded, not fixed.

| # | `src` | `dst` | raw errno | node adapter | `data.path` | memory today | memory target |
|---|---|---|---|---|---|---|---|
| N1 | file | **empty directory** | `EISDIR` | `PERMISSION_DENIED` | `src` | **succeeds** — file key lands on the directory key | `PERMISSION_DENIED(src)` |
| N2 | file | **directory with children** | `EISDIR` | `PERMISSION_DENIED` | `src` | **succeeds**; children still readable under a name `lstat` now calls a file | `PERMISSION_DENIED(src)` |
| N3 | symlink | **empty directory** | `EISDIR` | `PERMISSION_DENIED` | `src` | **succeeds** — symlink key lands on the directory key | `PERMISSION_DENIED(src)` |
| N4 | empty directory | regular file | `ENOTDIR` | `NOT_A_DIRECTORY` | `src` | **succeeds** — directory key lands on the file key | `NOT_A_DIRECTORY(src)` |
| N5 | directory with children | regular file | `ENOTDIR` | `NOT_A_DIRECTORY` | `src` | **succeeds**; the children re-key *under a regular file* | `NOT_A_DIRECTORY(src)` |
| N6 | directory (empty or with children) | **symlink** | `ENOTDIR` | `NOT_A_DIRECTORY` | `src` | **succeeds** — directory key lands on the symlink key | `NOT_A_DIRECTORY(src)` |
| N7 | directory with children | **empty directory** | — | **succeeds** (replaces) | — | succeeds, identical result | unchanged — **R20** |
| N8 | empty directory | directory with children | `ENOTEMPTY` | `DIRECTORY_NOT_EMPTY` | `src` | **succeeds** — silently merges | `DIRECTORY_NOT_EMPTY(src)` |
| N9 | directory with children | directory with children | `ENOTEMPTY` | `DIRECTORY_NOT_EMPTY` | `src` | **succeeds** — silently merges both trees | `DIRECTORY_NOT_EMPTY(src)` |
| N10 | directory | its own **parent** (dst contains src) | `ENOTEMPTY` | `DIRECTORY_NOT_EMPTY` | `src` | **succeeds** — subtree flattened into the parent, src key vanishes | `DIRECTORY_NOT_EMPTY(src)` |
| N11 | directory | a path **inside itself** that is **absent or a directory** (direct child, deep child with a missing mid segment, existing empty dir, existing non-empty dir — all four probed) | `INVALID-ARGUMENT` | `UNSUPPORTED_OPERATION` (`operation: 'filesystem'`, `reason: 'INVALID-ARGUMENT'`, **no `path` field**) | — | **succeeds** — `/repo/src.d` disappears from `directories` while `/repo/src.d/inner` remains: `lstat(src)` throws `FILE_NOT_FOUND` yet `readdir(src/inner)` works | `UNSUPPORTED_OPERATION` / `INVALID-ARGUMENT` — ADR-817 |
| **N11b** | directory | a path **inside itself** that **exists as a non-directory** (regular file or symlink, at any depth) | **darwin `ENOTDIR` · linux `INVALID-ARGUMENT`** | **darwin `NOT_A_DIRECTORY` (`src`) · linux `UNSUPPORTED_OPERATION`/`INVALID-ARGUMENT`** | darwin `src`, linux none | **succeeds** — the directory key lands on the file key *and* the subtree is re-parented under it | `UNSUPPORTED_OPERATION` / `INVALID-ARGUMENT` — ADR-817 picks **linux**; the only platform-divergent row in this design, so it is memory-side only and can never be a strict contract row |
| N12 | the containment **root** | a fresh name inside it | `INVALID-ARGUMENT` | `UNSUPPORTED_OPERATION` / `INVALID-ARGUMENT` | — | **succeeds** — the root vanishes from `directories` (`lstat(rootDir)` now throws `FILE_NOT_FOUND`) and the **entire repository is silently re-keyed one level deeper** under `dst`. The adapter is not bricked — the next write re-creates the root through `addDirectoryRecursive` — it is relocated, which is quieter and worse | `UNSUPPORTED_OPERATION` / `INVALID-ARGUMENT` — ADR-817, same clause as N11 |
| N13 | file | symlink | — | **succeeds** (link replaced, its target untouched) | — | succeeds, identical | unchanged |
| N14 | symlink | regular file | — | **succeeds** (dst becomes the link) | — | succeeds, identical | unchanged |
| N15 | file | the containment **root** | `EISDIR` | `PERMISSION_DENIED` | `src` | **succeeds** — the root becomes a file | `PERMISSION_DENIED(src)` |
| N16 | directory with children | the containment **root** | `ENOTEMPTY` | `DIRECTORY_NOT_EMPTY` | `src` | **succeeds** — merges into the root | `DIRECTORY_NOT_EMPTY(src)` |
| N17 | absent | anything | `ENOENT` | `FILE_NOT_FOUND` | `src` | `FILE_NOT_FOUND` (`src`) | unchanged |
| N18 | file | dst whose **immediate parent** is a regular file | `EEXIST` (adapter's `mkdir -p`) | `FILE_EXISTS` | **`src`** | `NOT_A_DIRECTORY` (**ancestor** path) | unchanged — ADR-811 |
| N19 | file | dst whose **grandparent** is a regular file | `ENOTDIR` (`resolveWrite(dst)`) | `NOT_A_DIRECTORY` | **`dst`** | `NOT_A_DIRECTORY` (**ancestor** path) | unchanged — ADR-811 |
| N20 | src whose **immediate parent** is a regular file | fresh name | `ENOTDIR` (`resolveWrite(src)`) | `NOT_A_DIRECTORY` | `src` | `FILE_NOT_FOUND` (`src`) | unchanged — §Out of scope |
| N21 | file | **itself** (`src === dst`) | — | **succeeds**, no-op | — | succeeds | unchanged — **R21** |
| N22 | directory with children | **itself** | — | **succeeds**, no-op | — | succeeds | unchanged — **R21** |
| N23 | directory with children, incl. a nested subtree | fresh name | — | succeeds; the whole subtree moves | — | succeeds; `renameDirectory` re-keys `files`/`symlinks`/`times`/`directories` | unchanged |
| N24 | empty directory | fresh name | — | succeeds | — | succeeds | unchanged |

**`atomicRename`.** Both adapters delegate: `NodeFileSystem.atomicRename` (`:764`) is
`await this.rename(src, dst)`; `MemoryFileSystem.atomicRename` (`:280`) is the same. Probed
explicitly on N1 and N5 — the codes are identical to `rename`'s. So `atomicRename` needs **no guard
of its own** and inherits every row above (R23). The port marks it optional; the browser adapter
omits it and is unaffected.

**Symlinks are never followed on either side.** Probed explicitly: a symlink-to-a-directory renamed
onto an empty directory is `EISDIR` → `PERMISSION_DENIED` (the link is a non-directory, whatever it
points at), and a directory renamed onto a symlink-to-a-directory is `ENOTDIR` → `NOT_A_DIRECTORY`.
Memory reaches the same verdicts structurally, because it branches on which map holds the key and
never resolves the target. N3 and N6 therefore hold for every link target.

**Platform verification — 33 distinct arrangements probed on two platforms, one divergent family.** The raw `rename(2)` /
`open(2)` errnos above were run on **darwin 25.5.0 arm64 (Node v22.22.3)** and on **linux amd64
(`node:22-bookworm`, Node v22.23.2)** — the CI `ubuntu-latest` shape. Thirty of the 33 are identical,
including the one POSIX explicitly leaves open: `rename(2)` onto a non-empty directory may return
`ENOTEMPTY` *or* `EEXIST`, and both platforms return `ENOTEMPTY`, so `DIRECTORY_NOT_EMPTY` is a safe
target for N8/N9/N10/N16.

**The three that differ are one family, N11b**, and they surfaced only because the matrix was
re-run on a second platform rather than reasoned about from the first. When `dst` lies inside `src`
**and already exists as a regular file or a symlink**, darwin's `rename(2)` reports `ENOTDIR` while
linux reports `INVALID-ARGUMENT` — probed at the raw level for **both occupant kinds at two depths on
both platforms**, and at the composed level on darwin, where `NodeFileSystem.rename` surfaces
`NOT_A_DIRECTORY` carrying `src`. The composed linux leg was not run; it follows from the raw errno
plus `mapErrno`, which is the one inference in this matrix that is not a direct observation. There is
therefore **no single node behaviour for the memory adapter to match on that row**, exactly the shape
ADR-811 ruled on for the depth-1 ancestor case. It also decided a *clause-ordering* question inside
the guard (§3c). **ADR-817 resolved it as option 1 — reproduce linux** — because linux is the CI
platform that gates every merge, so the code has a home that actually runs (R32), and because the
invalid-argument errno is the *specific* diagnosis where darwin's `ENOTDIR` is the incidental one it
reaches first. The darwin divergence on N11b is knowingly kept, exactly as ADR-811 kept the
depth-1 ancestor divergence.

**Windows is a different question again and is NOT verified here.** No Windows host was available,
and node's `fs.rename` on Windows goes through `MoveFileExW`, not `rename(2)`. The unit project — and
therefore the contract suite — runs on `windows-latest`. §5 carries the consequence, now settled by
ADR-819; nothing in this section may be read as a Windows claim.

#### §1f The browser adapter — the OPFS rejections, now pinned on two engines

The previous revision derived this section from the WHATWG File System Standard's normative
rejections because `BrowserFileSystem` has no OPFS fake (`test/unit/adapters/browser/` holds one
`'atomicRename' in sut` capability test and nothing else). Deriving an external system's behaviour
from its spec is the thing the faithfulness rule forbids, so **this revision ran it**.

**Probe.** A bare secure-context page on `127.0.0.1` (no tsgit build involved — raw
`navigator.storage.getDirectory()` handles only), driven by the repo's own Playwright install on
**chromium** and **firefox**, 2026-09-05. WebKit is excluded for the same reason the OPFS spec file
already skips it: Playwright's headless WebKit does not expose `navigator.storage.getDirectory`.
Arrangement: a directory `d` holding `inner.txt` (1 byte) and a regular file `f`, both at the OPFS
root.

| Call | Occupant | chromium | firefox | `constructor.name` |
|---|---|---|---|---|
| `getFileHandle(n, { create: true })` | **directory** | `TypeMismatchError` | `TypeMismatchError` | `DOMException` |
| `getFileHandle(n, { create: false })` | **directory** | `TypeMismatchError` | `TypeMismatchError` | `DOMException` |
| `getDirectoryHandle(n, { create: true })` | **regular file** | `TypeMismatchError` | `TypeMismatchError` | `DOMException` |
| `getDirectoryHandle(n, { create: false })` | **regular file** | `TypeMismatchError` | `TypeMismatchError` | `DOMException` |
| `getFileHandle(n, { create: false })` | absent | `NotFoundError` | `NotFoundError` | `DOMException` |
| `getDirectoryHandle(n, { create: false })` | absent | `NotFoundError` | `NotFoundError` | `DOMException` |
| `removeEntry(n)` (no `recursive`) | **non-empty directory** | `InvalidModificationError` | `InvalidModificationError` | `DOMException` |
| `removeEntry(n)` | absent | `NotFoundError` | `NotFoundError` | `DOMException` |

`err instanceof DOMException` was `true` for every row in-page on both engines, and — probed
separately, because §3f's classifier depends on it — `err instanceof Error` was `true` too, with the
prototype chain `DOMException → Error` on both. **Every refusal was non-destructive**: after the
eight probes the root still listed exactly `d` and `f`, and `d/inner.txt` was still 1 byte.

**Three things this pin settles that the spec text alone did not.**

1. `create` does **not** change the rejection for a type mismatch. `getFileHandle` on a directory
   rejects with `TypeMismatchError` at `create: false` too — which is precisely why `stat` and
   `exists` work today (R30) and why the fix must key on `create`, not on the rejection name alone.
2. `getDirectoryHandle` on a **file** — `walkToParent`'s ancestor step — also rejects with
   `TypeMismatchError`, the *same* name as the leaf fault. Without the placement argument in §3f
   that would be a real mis-mapping hazard.
3. The three engine-visible names are stable across two independent implementations, so classifying
   on `err.name` is a pin, not a guess.

Everything below is the adapter's *routing* over those pinned rejections — read off
`browser-file-system.ts`, not recalled:

**`writeExclusive` — ADR-814, ratified.** `assertDoesNotExist` (`browser-file-system.ts:273–286`)
catches every non-`TsgitError` rejection and `return`s, reading `TypeMismatchError` as *"not found,
safe to create"*. Control reaches `dir.getFileHandle(leaf, { create: true })`, which rejects with
`TypeMismatchError` again — and **that one escapes unmapped**. A caller sees a bare `DOMException`;
`errorDataCode(err)` returns `undefined` and `writeOrKeepArtifact` rethrows instead of raising
`PACK_ARTIFACT_MISMATCH`. ADR-814 fixes this and pins it in `test/browser/opfs-roundtrip.spec.ts`.

**`write` (and `writeStream`, `writeUtf8`, `appendUtf8`) — today.** All four route through
`resolveFileHandle(path, /* create */ true)` (`:226–237`), whose `catch` maps every non-`TsgitError`
rejection to `fileNotFound(path)`. A directory at the leaf therefore surfaces as **`FILE_NOT_FOUND`**
— a *mapped but wrong* code where node and the memory target say `PERMISSION_DENIED`. Nothing is
written: `createWritable()` is never reached. A regular file at an ancestor segment takes a
*different* route — `walkToParent`'s own `catch` — and also reports `FILE_NOT_FOUND`; §3f shows why
that difference is what makes the fix safe.

**`rename` — today.** `rename` (`:153–162`) is `read(src)` → `write(dst, data)` → `rm(src)`.
A directory `src` fails at `read` (`getFileHandle(leaf, { create: false })` hits
`TypeMismatchError`) → `FILE_NOT_FOUND`; a directory `dst` fails at `write` → `FILE_NOT_FOUND`, and
`rm(src)` never runs. So the browser adapter **never corrupts** on any §1e arrangement and never
leaves a half-move — it reports the wrong code, in contract.

**Why this is materially milder than ADR-814's case** — the reasoning the design recommended
option 1 on, recorded because ADR-816 overrode it and a later reader is owed the argument that lost:

- The failure stays **inside** the port's error contract. `errorDataCode` works; no caller sees a raw
  `DOMException`. Every `FILE_NOT_FOUND` branch site in `src/application` and `src/repository` sits
  on a **read, probe or remove** path — `read`/`readUtf8` loader misses, `lstat` existence probes
  (`write-working-tree-file.ts:32`, `symlinked-leading-path.ts:94`), `rm` idempotence
  (`index-lock.ts:118`, `fetch-pack.ts:348`, `cruft-pack-lifecycle.ts:249`) — and none catches the
  result of a `write` or a `rename`. `index-lock`'s `commit` does `write` then `rename` with no catch
  at all. So no known caller is harmed today.
- `resolveFileHandle` is the adapter's most-shared private helper — `read`, `readSlice`, `readUtf8`,
  `write`, `writeStream`, `appendUtf8`, `exists`, `stat` and `chmod` all funnel through it — and
  **`stat` and `exists` actively depend on its current mapping**: `stat` (`:99–109`) catches
  `isFileNotFound(err)` and falls back to `resolveDirHandle`. Re-mapping `TypeMismatchError` to
  anything else in the shared helper would make `stat` on a directory **rethrow instead of falling
  back** — a strictly worse bug than the one being fixed. Any fix must be scoped to the `create: true`
  arm only.

**ADR-816 ratified option 2 anyway**, and the second bullet is the constraint it carries into §3f
rather than an argument against it: the arm is `create: true`-only precisely because the
`create: false` mapping is load-bearing (R30). The first bullet's finding — no production caller
branches on `FILE_NOT_FOUND` after a write or a rename — survives as the reason this change is
**behaviour-additive on the browser**: it can only narrow an error code that nothing reads.

**How a Playwright case reaches the adapter.** The harness page (`test/browser/index.html`) exposes
only three adapters on `window.__tsgit.adapters` — `BrowserCompressor`, `BrowserHashService`,
`BrowserHttpTransport` — not `BrowserFileSystem`. But `BrowserFileSystem` *is* a public export of
`src/adapters/browser/index.ts`, and `index.html` already imports from
`/dist/esm/adapters/browser/index.js`, so that module is served, resolvable and already in the
page's module cache. A case reaches it with a dynamic `import()` inside `page.evaluate`, with no
edit to a harness page every one of the six specs in `test/browser/` loads (§Test strategy).

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

#### §2b The `rootDir` case is the sharp edge — and `write` widens it

Rows K / W3 / N15: `writeExclusive('/repo', …)`, `write('/repo', …)` and `rename(file, '/repo')` on
an adapter rooted at `/repo` **all succeed today**. The root is seeded into `directories` at
construction, so nothing else stops them. Afterwards `files.has('/repo')` is true, and
`addDirectoryRecursive` — which every write surface funnels through — throws `NOT_A_DIRECTORY` on its
first iteration for **every subsequent write anywhere in the repository**. One write at the root
bricks the adapter instance. All three guards close this for free, because `rootDir ∈ directories`.

Row N12 — `rename(rootDir, x)` — reaches the root by a *different* mechanism with a *different*
outcome, and the two must not be conflated: `renameDirectory` deletes the root key rather than
shadowing it, so the adapter is **not** bricked (the next write re-creates the root) — the entire
repository is silently re-keyed one level deeper instead. ADR-817 closes that row with its own
clause (§3c), not with the `rootDir ∈ directories` argument above — the two must not be conflated.

#### §2c The bug falsifies an invariant five equivalence proofs rest on

After row D the adapter holds `/repo/x/target` in **both** `files` and `directories`. Observed in the
same probe:

- `lstat('/repo/x/target')` → `isFile: true`
- `readdir('/repo/x')` → `[{ name: 'target', isDirectory: true }]`
- `readdir('/repo/x/target')` → `NOT_A_DIRECTORY`
- the child `/repo/x/target/child.txt` is still readable

One name, two types, three surfaces disagreeing. Committed `Stryker disable` proofs in
`memory-file-system.ts` rest on those namespaces being pairwise disjoint:

| Line | Proof text (excerpt) | Falsified today? | By what |
|---|---|---|---|
| `:186` `readdir` | *"files and directories are disjoint namespaces, so a file path always fails the `!directories.has` check below"* | **yes** | `writeExclusive` row D; `write` row W2; `rename` N1/N2 |
| `:352` `removeLeafEntry` (file arm) | *"only lets rmRecursive fall through to `!directories.has` (true, since files/dirs are disjoint) and return anyway"* | **yes** | same |
| `:359` `removeLeafEntry` (symlink arm) | *"(true, since symlinks/dirs are disjoint)"* | **yes — this flips the first pass's verdict** | `rename` N3 (symlink onto a directory) and N6 (directory onto a symlink). The first pass judged it sound because `writeExclusive` cannot create a symlink; that was right for `writeExclusive` and wrong once `rename` is in scope |
| `:515` `addDirectEntry` | *"files/symlinks/directories are pairwise disjoint … two iterators reaching the same first-segment `name` always build an identically-shaped DirEntry"* | **yes** | every row above; the two iterators build `{isFile:true}` and `{isDirectory:true}` |
| `:343` `rmRecursive` | *"when `normalized` is not a directory it is also missing entirely (leaf cases already returned above)"* | **yes, implicitly** | a key in both maps makes `removeLeafEntry` return `true`, so `rmRecursive` returns early and leaves the whole subtree behind. The wording does not cite disjointness, so it needs no edit |

The fix **restores** the premise rather than invalidating it, so all five become sound where they
were previously conditional on a bug not being hit. Per the repo rule that equivalence comments are
structure-specific, each is re-read during implementation and kept only if its wording still matches
the code it annotates — §Test strategy carries the per-proof verdict.

#### §2d Every route to a namespace collision, re-derived after ADRs 815–818

The previous revision listed *"two routes to `files ∩ symlinks` this change does not close"*, which
mis-stated one of them — the constructor route produces a `files ∩ directories` collision, not a
`files ∩ symlinks` one; the constructor cannot create a symlink at all. Here is the full derivation,
one line per writer. The list is exhaustive by construction: it is every `files.set` /
`symlinks.set` / `directories.add` in `memory-file-system.ts` (lines 46, 49, 89, 112, 267, 271, 304,
331, 399, 431), so R8a rests on an enumeration rather than on a claim.

| Writer | Keys it can create | Guard after this change | Can it collide? |
|---|---|---|---|
| `write` (+ `writeUtf8`, `writeStream`, `appendUtf8`) | `files` | `directories.has(n) \|\| symlinks.has(n)` → `PERMISSION_DENIED` (§3b) | **no** — ADR-815 closes the directory term, ADR-818 the symlink term |
| `writeExclusive` | `files` | `occupied(n)` over all three (§3a) | **no** |
| `symlink` | `symlinks` | already tests all three (`:321–333`) | **no** — pre-existing |
| `mkdir` | `directories` | `addDirectoryRecursive` re-tests `files`/`symlinks` at **every** segment (§3d) | **no** — pre-existing |
| `rename`, leaf arm | `files` or `symlinks` at `dst` | `assertRenamable` refuses a `directories` `dst`; the body still `delete`s `files[dst]` / `symlinks[dst]` before setting (§3c) | **no** |
| `rename`, directory arm | `directories` + re-keyed `files`/`symlinks` under `dst` | `assertRenamable` leaves `dst` provably **absent everywhere or an empty directory**, and refuses `dst` inside `src` (§3c) | **no** |
| the `FileHandle` from `openWithNoFollow` (`:399`) | `files` | `openWithNoFollow` (`:375–385`) refuses a symlink leaf and requires `files.has(normalized)` before handing the handle out | **closed in the review round** — the handle re-filed a removed path (`open → rm → mkdir → handle.write` put one key in `files` and `directories`); a write through a handle whose path no longer holds that file now resolves without effect, the POSIX unlinked-inode outcome |
| `rm`, `rmRecursive` | — (delete only) | n/a | **no** |
| constructor `rootDir` seed (`:46`) | `directories` | runs first, on an empty adapter | **no** |
| **constructor `files` option** (`:49`) | `files` | **none** | **yes — the one surviving route** |

**The surviving route, stated precisely.**
`MemoryFileSystem({ rootDir: '/repo', files: { '/repo/a/b': …, '/repo/a': … } })` seeds in
`Object.entries` order: `/repo/a/b` makes `/repo/a` a directory via `ensureParentDirs`, then
`files.set('/repo/a')` collides — `lstat('/repo/a')` reports a file while `readdir('/repo/a')` throws
`NOT_A_DIRECTORY`. The reverse order throws `NOT_A_DIRECTORY` at construction, so only one of the two
orders is a hole; `{ files: { '/repo': … } }` is the same hole at depth 0. This is a
*fixture-authoring* route reachable only from test code, not from the port surface, and the sweep
found **zero** occurrences across 15 929 unit + parity tests. Named in §Out of scope, not fixed
(**R8b**).

**One row that reads like a violation and is not.** `rename` of a file onto a **symlink** destination
(N13) is allowed on node too — the link is replaced and its target is untouched — so the leaf body's
`symlinks.delete(normalizedDst)` before `files.set(normalizedDst, …)` is *correct*, not a gap.
`renameLeaf` must keep all three destination deletes (`files`, `symlinks`, `times`); dropping any of
them to "simplify" after the guard lands would reopen exactly the collision the guard was added to
prevent.

### §3 The fix

#### §3a `writeExclusive` — ADR-810

`symlink` in the same file is the in-house precedent — it already tests all three namespaces
(`memory-file-system.ts:321–333`). ADR-810 extracts the shared predicate:

```ts
private occupied(normalized: string): boolean {
  return (
    this.files.has(normalized) ||
    this.symlinks.has(normalized) ||
    this.directories.has(normalized)
  );
}
```

`writeExclusive` and `symlink` each `throw fileExists(path)` on it. **`exists` is not folded in.** It
computes a textually identical disjunction today, but it answers a different question, and the two
answers already come apart on the node adapter — probed, same run:

| path | `node.exists` | `memory.exists` |
|---|---|---|
| regular file | `true` | `true` |
| symlink → file | `true` | `true` |
| **dangling symlink** | **`false`** | **`true`** |
| directory | `true` | `true` |
| absent | `false` | `false` |

Node's `exists` follows symlinks by design, while `writeExclusive` refuses a dangling symlink with
`FILE_EXISTS` (row G) — *not existing* and *occupied* are genuinely different predicates. Sharing a
helper would cement a coincidence as intent.

#### §3b `write` — ADR-815 and ADR-818

```ts
write = async (path: string, data: Uint8Array): Promise<void> => {
  const normalized = this.resolve(path);
  // node: EISDIR for a directory leaf, ELOOP for a symlink leaf under O_NOFOLLOW —
  // mapErrno sends both to PERMISSION_DENIED.
  if (this.directories.has(normalized) || this.symlinks.has(normalized)) {
    throw permissionDenied(path);
  }
  this.ensureParentDirs(normalized);
  this.files.set(normalized, data.slice());
  this.touch(normalized);
};
```

One added guard, four surfaces (§1d), two occupant kinds. `rootDir ∈ directories`, so W3 is covered
without a third clause. Both disjuncts produce the **same** code, which is not a coincidence to be
tidied away: `mapErrno` sends `EISDIR` (`node-file-system.ts:239–243`) and `ELOOP` (`:234–238`) to
`permissionDenied` through two adjacent arms, and the committed equivalence proof at `:234` says so
outright — *"emptying this case's consequent makes ELOOP fall through to the EISDIR
`permissionDenied` arm, yielding the identical TsgitError"*. The
in-house precedent is one method away — `openWithNoFollow` (`:375–385`) refuses a symlink leaf with
exactly `permissionDenied`, citing `O_NOFOLLOW`.

The guard sits **before** `ensureParentDirs`, which keeps the ancestor-fault behaviour ADR-811
ratified: when a file blocks an ancestor, the leaf itself is in no namespace, the guard falls
through, and `addDirectoryRecursive` throws `NOT_A_DIRECTORY` carrying the ancestor — unchanged, and
the existing case at `memory-file-system.test.ts:452` still passes.

Because the two disjuncts share a code, **only a single-occupant test per term proves each one**;
a fixture holding both a directory and a symlink is impossible anyway (they are disjoint), but a
single test that only ever plants a directory leaves the `symlinks` term free to be mutated to
`false` undetected. §3e and §Test strategy carry the pair.

#### §3c `rename` — ADR-815, shape pinned by §1e

Today's `rename` (`memory-file-system.ts:246–275`) deletes `files[dst]`, `symlinks[dst]` and
`times[dst]` **before** consulting anything about `dst`, and never consults `directories[dst]` at
all. `renameDirectory` (`:289–310`) re-keys the subtree without consulting `dst` either. That is the
whole gap.

The guard is a pure, synchronous, mutation-free precondition that runs **first**:

```ts
private assertRenamable(src: string, dst: string, reported: string): void {
  const srcIsDirectory = this.directories.has(src);
  if (!srcIsDirectory && !this.files.has(src) && !this.symlinks.has(src)) {
    throw fileNotFound(reported);                                    // N17
  }
  if (src === dst) return;                                           // N21 / N22
  if (!srcIsDirectory) {
    if (this.directories.has(dst)) throw permissionDenied(reported); // N1 / N2 / N3 / N15
    return;                                                          // N13 / N14
  }
  if (dst.startsWith(`${src}/`)) {                                   // N11 / N11b / N12
    throw unsupportedOperation('filesystem', INVALID_ARGUMENT);      // ADR-817, before the kind check
  }
  if (!this.directories.has(dst)) {
    if (this.files.has(dst) || this.symlinks.has(dst)) {
      throw notADirectory(reported);                                 // N4 / N5 / N6
    }
    return;                                                          // N23 / N24
  }
  if (this.hasChildren(dst)) throw directoryNotEmpty(reported);      // N8 / N9 / N10 / N16
}                                                                    // else N7 — empty dst, replace
```

**The `dst`-inside-`src` clause's *position* was itself a decision — ADR-817 settled it.** Placed
**above** the file/symlink clause, as written, it reproduces **linux** on N11b and contradicts
**darwin**; below it reproduces darwin and contradicts linux. Every other ordering is equivalent
because the arrangements are disjoint. §1e proves there is no third answer, and ADR-817 chose linux:
it is the CI platform that gates every merge, so the strict node-side code has a home that actually
runs (R32), and the invalid-argument errno is the *specific* diagnosis where darwin's `ENOTDIR` is
the incidental one it reaches first. The cost taken knowingly: this error carries **no `path`**, so a
caller cannot name what failed, and an adapter with no errnos now carries an errno name as a string
literal — the same species of borrowing ADR-811 declined for `mkdir -p`, accepted here because the
literal is one the node adapter already emits.

`INVALID_ARGUMENT` above stands for a module-level `const` holding POSIX's invalid-argument errno
name — the literal that `mapErrno`'s `default` arm forwards. Naming it once keeps the magic value out
of the guard and gives the dictionary entry a single point of truth in the file.

`reported` is the caller's raw `src` string, matching node's `runFs(op, src)` anchoring. It is
**deliberately unused by the ADR-817 clause**, because that error variant has no `path` field; every
other clause consumes it.

The `hasChildren` helper already exists (`:488–501`) and is exactly the predicate node's `ENOTEMPTY`
expresses. **Its cost, stated:** it scans all three collections linearly, so this guard makes
`rename(dir, dir)` O(files + symlinks + dirs). That is acceptable — it runs only on the
directory-source-onto-existing-directory arm, which no tsgit call site reaches (`working-tree.ts:138`
renames leaves only, §Context), and `rm` already pays the identical scan on every directory removal.
No new hot path is created; if one ever appears, the fix is a child index, not a weaker guard.

**Ordering is load-bearing in three further places** (the inside-source clause position above is the
fourth):

1. **Source existence first.** N17 must win over every destination verdict, because
   `rename(absent, anything)` is `ENOENT` on POSIX regardless of `dst`.
2. **`src === dst` second.** Node succeeds on `rename(dir, dir)` even for a *non-empty* directory
   (N22). Without this escape the N9 clause below would newly refuse it — the sharpest regression
   this change can introduce, and the reason **R21** is a requirement with its own tests.
3. **The whole guard before any mutation.** R22 holds only because `assertRenamable` runs before the
   `files.delete(dst)` / `symlinks.delete(dst)` / `times.delete(dst)` trio.

`dst.startsWith(`${src}/`)` is *inside*, not *ancestor*: N10 (renaming a directory onto its own
parent) is `ENOTEMPTY`, not `INVALID-ARGUMENT`, and correctly falls through to the non-empty clause, because a
parent is not inside its child.

**A leaf source with a destination inside it needs no clause either.**
`rename('/repo/f.txt', '/repo/f.txt/x')` takes the `!srcIsDirectory` branch and returns, then
`renameLeaf`'s `ensureParentDirs` hits `addDirectoryRecursive('/repo/f.txt')`, which finds the key in
`files` and throws `NOT_A_DIRECTORY` carrying the ancestor. Node reports `FILE_EXISTS` carrying `src`
there (its `mkdir -p` sees `EEXIST`, exactly the N18 shape) — so this is the ADR-811 ancestor family
one method over, already ratified and already out of scope, not a hole the new clause leaves.

**N12 needs no clause of its own.** `rename(rootDir, x)` reaches the same test: `rootDir` is seeded
into `directories` at construction, so `srcIsDirectory` is true, and any `x` the adapter will accept
has already been through `resolve`, which refuses anything not equal to `rootDir` or under
`${rootDir}/`. `x === rootDir` is caught by the `src === dst` escape one line above; everything else
starts with `${rootDir}/` and trips the clause. This rests on the file's existing assumption that
`rootDir` is not `/` — `parentOf` (`:537–540`) already states it in a comment — so no new precondition
is introduced.

The body then dispatches on the kind already established, which removes the now-unreachable
`throw fileNotFound(src)` from the leaf arm (dead code is a non-negotiable):

```ts
rename = async (src: string, dst: string): Promise<void> => {
  const normalizedSrc = this.resolve(src);
  const normalizedDst = this.resolve(dst);
  this.assertRenamable(normalizedSrc, normalizedDst, src);
  if (normalizedSrc === normalizedDst) return;
  if (this.directories.has(normalizedSrc)) {
    this.renameDirectory(normalizedSrc, normalizedDst);
    return;
  }
  this.renameLeaf(normalizedSrc, normalizedDst);
};
```

`renameLeaf` is today's leaf body minus that arm; the `as Timestamps` cast justification at
`:258–260` survives unchanged, because a file or symlink at `src` still implies a timestamp.

**What the guard buys `renameDirectory`.** After it, `renameDirectory` can only ever be entered with
`dst` **absent or an empty directory**, and "empty" per `hasChildren` means no key in `files`,
`symlinks` or `directories` starts with `${dst}/`. So the remap can no longer collide with an
existing key — the N4/N5/N6 corruption becomes unreachable by construction rather than by a second
check inside the loop. The N7 replace path needs **no code change**: the empty `dst` directory key is
deleted and re-added by the remap in the same pass and `moves(this.times)` overwrites its timestamp
— probed identical to node's result.

`atomicRename` (`:280–282`) keeps its one-line delegation, and its comment
(*"already atomic with respect to the event loop"*) stays true: the guard adds no `await`.

#### §3d `rm`, `rmRecursive` and `mkdir` need nothing

Stated because the sweep asked the question, and the reasoning differs per method rather than being
one blanket claim.

- `rm` (`:220–244`) already tests the three namespaces in order and already throws
  `DIRECTORY_NOT_EMPTY` for a non-empty directory, matching `mapErrno`'s `ENOTEMPTY` arm — the
  ADR-052 precedent. It only ever *removes* keys, so it cannot violate R8a.
- `rmRecursive` (`:339–346`) is idempotent and also only removes keys.
- `mkdir` (`:211–218`) **does** create keys, in `directories`, so the "cannot create a key" shortcut
  does not apply to it. It is safe for a different reason: `addDirectoryRecursive` re-tests
  `files.has(current) || symlinks.has(current)` at **every** segment and throws `NOT_A_DIRECTORY`
  rather than adding a colliding directory key. That is the same helper every write surface funnels
  through, which is why the ancestor half of R8a has always held while the leaf half did not.

None of the three is touched.

`mkdir` over a **symlink** leaf is a pre-existing divergence probed in passing (node `FILE_EXISTS`
from `EEXIST`, memory `NOT_A_DIRECTORY`) — the ADR-811 family again, a different method, out of
scope.

#### §3e Mutation posture of the new guards

Stryker mutates each guard on several axes: every `||` flips to `&&`, and each condition is forced to
`true` and to `false`. **Each disjunct therefore needs its own observable test**; one test tripping
two occupants at once proves neither term. That is the recorded high-yield real-survivor class in
this repo, and it is why the memory unit rows below are one-occupant-per-case rather than bundled.
`assertRenamable`'s early returns are `BlockStatement` and `ConditionalExpression` targets in their
own right — the N7, N13/N14, N21/N22 and N23/N24 *positive* rows are what kill the
"force the guard to always throw" mutants, so they are as load-bearing as the refusal rows.

Extracting `occupied()` (ADR-810) halves the exclusive-create guard's mutant population by having one
expression instead of two — not by suppressing anything.

Two guards now carry a `||` and therefore need the isolated-term treatment: `write`'s
`directories || symlinks` (§3b — one directory-occupant case *and* one symlink-occupant case, R12 and
R28) and `assertRenamable`'s source-existence and destination-kind disjunctions (§3c). The
`assertRenamable` clause ADR-817 adds is a single `startsWith`, so its mutants are
`ConditionalExpression` and `StringLiteral` (the `/` in `` `${src}/` ``): the string mutant is killed
by the N10 *parent* row, which must **not** refuse — with the slash dropped, `'/repo'.startsWith('/repo')`
is true and N10 would flip to `UNSUPPORTED_OPERATION`.

**The browser fix is outside the mutation gate entirely** (`stryker.config.mjs` excludes
`src/adapters/browser/**`) and outside the 100 % coverage gate (`vitest.config.ts` `coverage.include`
omits it). Its only proof is the three Playwright cases in §Test strategy, which is why each asserts
a *code plus a non-destructiveness observation* rather than the fact of throwing.

#### §3f The browser adapter — ADR-814 and ADR-816

Two changes in `browser-file-system.ts`, sharing one predicate. Nothing else in the file moves.

**One shared classifier**, module-level beside `isFileNotFound` (`:295–297`):

```ts
function isTypeMismatch(err: unknown): boolean {
  return err instanceof Error && err.name === 'TypeMismatchError';
}
```

Shaped exactly like the node adapter's `isErrnoException` (`node-file-system.ts:140–142`,
`err instanceof Error && 'code' in err`) — the house idiom for narrowing an `unknown` rejection with
no cast and no `any`. Two facts make it sound, both **measured** in the §1f probe rather than
assumed: `DOMException` inherits from `Error` on chromium and firefox (`err instanceof Error` was
`true`, prototype chain `DOMException → Error`), and the `name` is the engine-visible string
`'TypeMismatchError'` on both.

Keying on `name` rather than `err instanceof DOMException` is deliberate: it is realm-independent, it
needs no DOM global at runtime, and it follows the repo's rule that adapter errors are classified
structurally rather than by constructor identity. It cannot collide with a `TsgitError`, whose `name`
is the literal `'TsgitError'` (`domain/error.ts:85`) — and in both call sites the
`err instanceof TsgitError` check runs **first** regardless, so the existing propagation is
untouched.

**(a) `assertDoesNotExist` (`:273–286`) — ADR-814.** Today its `catch` swallows every
non-`TsgitError` rejection and `return`s, reading `TypeMismatchError` as *"absent, safe to create"*.
After: a `TypeMismatchError` becomes `fileExists(path)`; a `NotFoundError` still `return`s (absent,
proceed); every other rejection **propagates** rather than being read as absence.

**One residual, stated so it is not mistaken for an oversight.** After (a), an *unexpected* rejection
— `NotAllowedError`, a quota failure — leaves `writeExclusive` as a raw `DOMException`, which is the
shape ADR-814 set out to eliminate. That is the trade ADR-814 ratified and it is the right way round:
the alternative is what the code does today, silently reading a permission failure as *"absent, safe
to create"* and then writing. A diagnostic escape on a condition nothing anticipated beats a silent
misclassification, and it is not a swallowed error — nothing is discarded.

**(b) `resolveFileHandle` (`:226–237`) — ADR-816.** The `catch` gains one arm, gated on `create`:

```ts
try {
  return await dir.getFileHandle(leaf, { create });
} catch (err) {
  if (err instanceof TsgitError) throw err;
  // A directory at the leaf rejects with TypeMismatchError whether or not `create` is set.
  // Only the writing arm may report it as a refusal: `stat`/`exists` read FILE_NOT_FOUND
  // here as "not a file, try a directory handle" and fall back.
  if (create && isTypeMismatch(err)) throw permissionDenied(path);
  throw fileNotFound(path);
}
```

**Why the `create` gate is not optional (R30).** §1f pins that `getFileHandle` rejects with
`TypeMismatchError` at `create: false` too. `stat` (`:99–109`) and `exists` (`:82–97`) catch exactly
`FILE_NOT_FOUND` and fall back to `resolveDirHandle`; a helper-wide re-map would make both **rethrow**
on every directory — `stat` on a directory is used across the codebase, so that is a strictly worse
bug than the one being fixed. `chmod` (`:172–180`) has the same fallback shape and the same exposure.

**Exactly three callers can reach the new arm.** All nine, read off the file:

| Caller | `create` | Reaches the new arm? |
|---|---|---|
| `read` (`:22`) | `false` | no |
| `readSlice` (`:29`) | `false` | no |
| `readUtf8` (`:37`) | `false` | no |
| `exists` (`:84`) | `false` | no — depends on the `false` mapping (R30) |
| `stat` (`:101`) | `false` | no — depends on the `false` mapping (R30) |
| `chmod` (`:175`) | `false` | no — same fallback shape |
| **`write` (`:43`)** | **`true`** | **yes** — and `writeUtf8` (`:70`) and `rename` (`:160`) through it |
| **`writeStream` (`:50`)** | **`true`** | **yes** — the identical call, not a delegation |
| **`appendUtf8` (`:75`)** | **`true`** | **yes** |

`writeExclusive` (`:58–68`) does **not** use `resolveFileHandle` at all — it walks and probes by
hand, which is why ADR-814 needs its own change at (a).

**Ancestor faults keep their current mapping (R31).** `walkToParent(segments, true)` calls
`getDirectoryHandle(segment, { create: true })`, which §1f pins as rejecting with the **same**
`TypeMismatchError` when a regular file blocks an ancestor. That would be a genuine mis-mapping
hazard — node reports `FILE_EXISTS` at depth 1 and `NOT_A_DIRECTORY` deeper (ADR-811), never
`PERMISSION_DENIED` — except that `walkToParent` (`:255–271`) has its **own** `catch` that converts it
to `fileNotFound(segments.join('/'))`, and `resolveFileHandle` awaits `walkToParent` **outside** its
`try` block. So the new arm is structurally unreachable from an ancestor fault: it only ever sees
rejections from the single leaf `getFileHandle` call. No guard, no ordering rule and no extra test is
needed to keep this true — but a future refactor that moves the `walkToParent` call inside the `try`
would silently break it, which is why R31 gets its own Playwright observation.

**`rename` with a directory *source* is not covered by ADR-816, and does not change.** ADR-816's text
is *"plant a directory at the target"* — the destination. A directory `src` still fails at
`read(src)` → `resolveFileHandle(src, false)` → `TypeMismatchError` → the untouched `create: false`
arm → `FILE_NOT_FOUND`, where node would **succeed** for a fresh `dst` (N23/N24). That is not a code
mapping this fix can improve into correctness: OPFS has no directory rename and the adapter's
read/write/rm emulation is leaf-only, so making the code right would mean implementing recursive
copy-then-remove — a capability change, not an error-mapping change. It is recorded in §Out of scope
alongside browser `rm` on a non-empty directory, which the §1f probe pins as
`InvalidModificationError` → `FILE_NOT_FOUND` where node gives `DIRECTORY_NOT_EMPTY`. **Consequence to
state plainly:** after this change the browser reports `PERMISSION_DENIED` for a directory
*destination* and `FILE_NOT_FOUND` for a directory *source*. The asymmetry is deliberate and bounded
by ADR-816's wording; it is not a half-applied fix.

#### §3g What the review round changed

The four-dimension review over the landed parts found and fixed six things; none reopened a
decision.

1. **Orphan directories on an ancestor refusal (security, MEDIUM).** `addDirectoryRecursive` walked
   upward adding each directory key *before* testing the next segment, so a write refused by a
   file at a grandparent left the intermediate directory registered, unreachable from its parent
   and untouched by `rmRecursive`. Pre-existing, but the branch's non-destructive-refusal posture
   made it normative. It now validates the chain first (`assertAncestorChainFree`) and adds only
   afterwards — one synchronous pass, so `atomicRename`'s guarantee is unchanged. R33.
2. **Browser self-rename destroyed the file (code, MEDIUM).** The read/write/rm emulation
   overwrote `p` with itself and then unlinked it. Pre-existing; the port sentence this branch added
   ("`src === dst` is a no-op") made it a contract violation. An early return after the read
   closes it; the read stays first so an absent source still reports `FILE_NOT_FOUND`. R34.
3. **The port's `rename` paragraph was false for the browser (code MEDIUM, security LOW, tests
   MEDIUM — three dimensions converged).** Directory source, directory destination anchoring and
   the empty-directory replace all differ on the browser. The paragraph is now scoped the way its
   atomicity sentence already was. R35.
4. **Rejection classification read `instanceof Error` (security, PROBE).** The browser predicates
   now read `name` structurally through one `rejectionName` helper — realm-independent, the same
   posture `errorDataCode` takes on `data.code`.
5. **Two measured mutation survivors on the `rename` dispatcher (tests, HIGH + MEDIUM).** With
   `directories.has(normalizedSrc)` forced true, every leaf rename routed through
   `renameDirectory`, which never deletes a colliding `dst` key — no test renamed a leaf over a
   leaf of the other kind. With the `normalizedSrc === normalizedDst` early return forced false,
   nothing observed the difference. Both are killed: a file renamed over a symlink (the link is
   replaced, its target untouched), its mirror, and a self-rename that must leave the directory
   listing order unchanged. Every other new guard term was hand-verified killed before the
   mutation phase.
6. **The tarball cap paragraph misattributed the growth (perf, MEDIUM).** Measured by reverting
   only the new port JSDoc inside the emitted type chunks: the prose alone costs ~898 B gzip'd
   because `.d.ts` and `.d.cts` both carry it verbatim beyond gzip's window. The paragraph in
   `tooling/verify-tarball.sh` now records that split; the cap is 906 KiB against a measured
   927 105 B after the review round.

Smaller: `assertRenamable`'s parameters are named `normalizedSrc` / `normalizedDst` /
`reportedPath` like `renameLeaf`'s; the contract `write` row carries the same `expect.fail` guard
as its `rename` siblings; the `appendUtf8` test title no longer claims nothing was read (the read
happens and yields the empty string); the R7 row asserts the directory's timestamps unchanged.

**The second review cycle** verified all sixteen cycle-one findings resolved (the two measured
`rename` survivors re-measured killed) and found four more things worth changing:

7. **The two-phase walk cost +14 % on every memory write (perf, MEDIUM, measured 702 → 807 ns).**
   `addDirectoryRecursive` now returns immediately when its head is already a recorded
   directory: `directories` is prefix-closed and disjoint from the other namespaces, so a
   recorded head proves the whole chain recorded and occupant-free. Measured −31 % against the
   pre-fix baseline. Its mutant is the one provable equivalent this work suppresses, and it is
   provable only because of the next item.
8. **The constructor could seed a file where an earlier key had made a directory (R8's last
   hole).** A one-line guard refuses it with `NOT_A_DIRECTORY` carrying the key. R36.
9. **The `>=` loop bounds were not equivalent after all (tests, HIGH ×2).** After
   `rmRecursive(rootDir)` a write can occupy the root path with a file, and a later child write
   must refuse; and the add loop's root iteration is what records the root again. The
   carried-forward equivalence prose was wrong for both loops; both mutants now have kill rows
   and the comments say why the bound is load-bearing. Only the dropped-`break`/`return` halves
   remain equivalent (`parentOf(rootDir)` is `''`).
10. **The `mkdir` leaf-guard directive covered a non-equivalent mutant (three dimensions
    converged).** The guard reports the caller's string, the chain check the normalized key, so
    a relative path tells them apart. The directive is gone and a relative-path row kills it.

Also from this cycle: the browser's `rejectionName` branches have fake-handle unit rows (a plain
object named `TypeMismatchError` → `PERMISSION_DENIED`; a bare string or a non-string `name` →
`FILE_NOT_FOUND`); the Playwright self-rename case also renames `/same.txt` onto `same.txt`,
pinning that the guard compares normalized segments; the port's `rename` clause is qualified
for an absent source and names the ancestor-chain refusal (R35); the contract grandparent probe
asserts the enumerated pair `NOT_A_DIRECTORY` / `FILE_NOT_FOUND`; R7 no longer claims
timestamps the adapter never records; and the tarball paragraph states the attribution as
measured on a clean build (1 144 B for all the new port prose, not additive).

**The third review cycle** verified every second-cycle fix (the two `>=` bound mutants and the
`mkdir` guard's three mutator classes re-measured killed by exactly their rows; the early exit
measured 39 % faster than cycle 2 and 28 % faster than pre-fix, −18 % end to end on 20 000
loose-object writes) and found one more thing, from two dimensions at once:

11. **A stale `FileHandle` could re-file a removed path (code MEDIUM, tests MEDIUM).** The
    handle's `write` did `files.set` with no occupancy check, so `open → rm → mkdir →
    handle.write` put one key in `files` and `directories` through public port calls alone,
    and in that state the early exit's mutant was distinguishable. The write now lands on the
    unlinked file as it does on POSIX — the path is never re-filed — pinned by two rows
    (path stays absent; a directory created there is untouched and a child write beneath it
    works). The disjointness premise every equivalence proof in the file rests on is now
    true on every reachable state, handles included.
12. **The two `current === rootDir` terminators are documented equivalents with directives.**
    Forcing either false only steps the loop to `parentOf(rootDir)`, which is strictly
    shorter than `rootDir` and fails the `>=` bound; the tests reviewer measured both as
    survivors and proved the equivalence. The early exit's directive lost an inert
    `BlockStatement` mutator name and gained the clause that its forced-true variant is
    killable and suppressed only because the mutator cannot be narrowed. The `>=`→`<`
    mutants on both loops hang (`parentOf('')` is `''`) and count as detected timeouts.

Also from this cycle: a `null` rejection row for the browser classifier (the `||`'s second
term); the tarball paragraph keeps only the measured total (about 1.3 KB for all the new port
prose — two measurers agreed on the total and not on any split), 927 329 B against the
906 KiB cap.

### §4 The test-side patches this retires

`writeOrKeepArtifact`'s directory arm is currently proven on the memory adapter by patching
`writeExclusive` on a spread copy of the context so it throws `FILE_EXISTS` — i.e. by faking the
behaviour this change makes real. **A full sweep of `test/**` found exactly one such patch** (the
brief expected two; the second candidate patches `stat` only and is unaffected). It becomes redundant
and must go, or it will keep the adapter's real behaviour untested at the very call site that
motivated the fix.

The rule, applied literally:

- **Drop** a `writeExclusive` override whose only job is to make a directory occupant produce
  `FILE_EXISTS`.
- **Keep** every `stat` patch — the size coincidence (an occupant whose size equals the artefact's,
  so `isFile` is the sole discriminator) is the point of the test and cannot be arranged otherwise.
- **Keep** every override that injects a **non-`FILE_EXISTS`** failure — those pin the rethrow branch
  and have nothing to do with this change.
- **Keep** every `vi.spyOn(ctx.fs, 'writeExclusive')` used for call-order or argument pinning.

One title also becomes false and is corrected in passing: the memory suite's
`describe('Given the memory fs has no real symlinks')` around a `writeExclusive` case
(`memory-file-system.test.ts:811`) — the memory adapter has had symlinks since before this change,
and rows E–G are the proof. Its body proves parent auto-creation; the title should say so.

### §5 Where the cross-adapter proof lives — and the Windows leg

🔴 **Correction to the brief's premise, retained from the first pass.** `test/parity/**` *does* have
a slot for raw port calls (`repo.ctx.fs.write` / `read` / `readSlice` / `readdir` / `writeUtf8`
appear throughout the scenario set, and `reftable-refs.scenario.ts:155` branches on
`ctx.fs.atomicRename === undefined`). What stops a refusal scenario is the browser:
`test/browser/parity-scenarios.bundle.ts` re-exports the whole `SCENARIOS` registry and
`test/browser/parity.spec.ts` runs **every** registered scenario against real OPFS. ADR-812 records
the decision to add none.

`test/unit/ports/file-system.contract.ts` remains the purpose-built home: one exported
`fileSystemContractTests(createSut)` driven by the memory suite (`memory-file-system.test.ts:7–24`,
`rootDir: '/repo'`) and the node suite (`node-file-system.test.ts:63–96`, real `mkdtemp` root). Its
four assertion helpers (`assertFileNotFound` `:78`, `assertPermissionDenied` `:83`,
`assertFileExists` `:88`, `assertNotADirectory` `:93`) all check the instance and `data.code`, and
**none** checks `data.path`.

**The new constraint the first pass did not have.** The unit project runs on `windows-latest`
(`ci.yml:257`), so every node-side assertion in that file runs on Windows. §1e verified darwin and
linux; Windows was not probed, node's `fs.rename` there is `MoveFileExW` rather than `rename(2)`, and
the mapping from `ERROR_*` to errno is not something this design may assert from memory. The file
already carries **two** tolerance precedents built for exactly this situation:

- `:567` `Given mkdir on existing file path, When mkdir, Then throws FILE_EXISTS or NOT_A_DIRECTORY`
  — an enumerated pair, with an in-file comment saying the exact code is platform-dependent.
- `:676` `Given non-empty directory, When rm, Then throws a TsgitError` — instance only, no code.

**ADR-819 settles it as option 2**, and the table below is the placement, per row. "Code after the
change" is what **both** adapters produce once the guards land — memory today produces nothing at all
on most of these rows.

| Row | Code after the change | Platform risk | Contract strictness | Strict node code pinned in |
|---|---|---|---|---|
| `writeExclusive` → directory occupant | `FILE_EXISTS` | none — `O_EXCL`/`EEXIST` is universal, and the existing strict `writeExclusive`-over-a-file row already passes Windows CI | **strict** (ADR-812) | the contract row itself |
| `writeExclusive` → file at a grandparent segment | `NOT_A_DIRECTORY` | none (`mkdir -p` `ENOTDIR`; the depth-1 case is the adapter-dependent one and is excluded) | **strict, code only** (ADR-812) | the contract row itself |
| `write` → directory at the leaf | `PERMISSION_DENIED` | **unverified on Windows** — libuv's directory-open mapping was not probed | instance + non-destructiveness | posix-only file |
| `write` → **symlink** at the leaf | `PERMISSION_DENIED` | **unverified on Windows**, and symlink creation itself is gated there | **no contract row** — same reasoning as the two `rename` symlink rows below | posix-only file (the existing `node-fs-real-symlinks.test.ts` is its neighbour) |
| `rename` file → directory | `PERMISSION_DENIED` | **unverified on Windows** | instance + non-destructiveness | posix-only file |
| `rename` directory → regular file | `NOT_A_DIRECTORY` | **unverified on Windows** | instance + non-destructiveness | posix-only file |
| `rename` directory → non-empty directory | `DIRECTORY_NOT_EMPTY` | **unverified on Windows** | instance + non-destructiveness | posix-only file |
| `rename` directory → **empty** directory (positive, R20) | it succeeds | **unverified on Windows** — `MoveFileEx`'s replace-existing flag is documented not to replace directories, so this is the likeliest Windows failure | **positive row, kept in the contract suite** — see below | posix-only file (same arrangement, asserted on node alone) |
| `rename` src === dst, **regular file** (positive, R21) | it succeeds | none | **strict** (positive row, no code asserted) | — |
| `rename` src === dst, **non-empty directory** (positive, R21) | it succeeds | **unverified on Windows** — same `MoveFileEx` question as the R20 row | **positive row, kept in the contract suite** | posix-only file |
| `rename` symlink → directory, directory → symlink | `PERMISSION_DENIED` / `NOT_A_DIRECTORY` | — | **no contract row.** ADR-812's reasoning applies verbatim: the file gates symlink behaviour per adapter through a capability hook, and a row that happens to agree without such a declaration would over-constrain a future adapter | posix-only file; memory-side unit rows too |
| `rename` dst inside src, dst absent or a directory (N11/N12) | `UNSUPPORTED_OPERATION` / `INVALID-ARGUMENT` | — | **no contract row.** The `reason` string is a node errno name and would over-constrain any adapter that has no errnos | posix-only file |
| `rename` dst inside src, dst an existing file or symlink (N11b) | **darwin and linux disagree** | **proven POSIX-divergent** | **never a strict contract row** | **nowhere on the node side** — memory-side unit row only, asserting ADR-817's linux-shaped choice |

**The two positive rows stay in the contract suite even though they carry Windows risk**, and that is
deliberate: a positive row has no tolerant form — "it succeeds or it throws something" asserts
nothing. ADR-819's own consequence section says so: if Windows genuinely cannot replace a directory
through `rename`, the row goes red on the `windows-latest` unit cell and becomes a **recorded
decision** rather than a silent tolerance. That is the failure mode this design accepts, in exchange
for not shipping an unverified claim. Both are additionally proven on the memory side, where there is
no platform.

Every "instance + non-destructiveness" row is proven **strictly on the memory side** regardless —
memory has no platform — so no code goes unasserted anywhere; ADR-819 moves only where the *node*
assertion lives. The price it names is real: the cross-adapter proof for these rows is now two-file
(the contract suite proves *both refuse and neither corrupts*; the posix-only file proves *node's
exact code*), which is more moving parts than ADR-812 envisaged for `writeExclusive` alone. The
join point between the two files is this table.

### §6 The port's wording is the thing that let this happen

```
/** Write bytes to file. Fails with FILE_EXISTS if the file already exists (exclusive create). */
```

*"the file already exists"* reads as *a file exists at this path*, which is precisely what the memory
adapter implemented, and `design/ports-and-adapters.md:561` then wrote the narrow reading down as its
spec. ADR-813 rewrites it.

`write`'s summary has the same defect one method over — *"Write bytes to file, creating parent
directories as needed. **Overwrites if exists.**"* — which reads as licence to overwrite *anything*.
R26 extends ADR-813's principle to `write`, `writeStream`, `writeUtf8`, `appendUtf8`, `rename` and
`atomicRename`: each states the directory-occupant refusal and its code, and `rename`'s obligation
list gains the §1e kind matrix in one sentence plus the `data.path === src` anchoring rule.

### §7 Faithfulness posture

The port contract is the oracle for this change and **no new interop test ships**:

- The node adapter's behaviour is unchanged by this design, so there is no new node-side behaviour to
  pin cross-tool. §1a records that its exclusive-create refusal already matches git.
- The memory adapter has no canonical-git counterpart — git cannot be pointed at an in-process `Map`,
  so a cross-tool test is not constructible for it. `.claude/workflow/faithfulness.md` is explicit
  that parity tests are cross-adapter and prove nothing about faithfulness; the inverse also holds —
  an adapter with no on-disk existence has no interop surface.
- §1a is nonetheless recorded in full so the claim *"refusing a directory is the git-faithful
  choice"* rests on a probe rather than on assertion. For `write` and `rename` the anchor is POSIX
  plus the node adapter (§1d, §1e) rather than the `git` binary: git never writes over or renames
  onto a directory on purpose, so there is no git-level refusal message to reproduce — the refusal
  *is* the syscall's, and the syscall was probed on two platforms.
- The browser adapter's anchor is neither git nor POSIX but the **WHATWG File System Standard**, and
  the rule is the same one: it was **run**, not recalled. §1f records the rejection names measured on
  chromium and firefox, and the two ADR-816 Playwright cases re-assert them end-to-end on every CI
  run so the mapping cannot rot silently. That probe is this design's only external-system pin
  besides §1a's `git` run.

---

## Decision candidates

### Settled by the first decisions round — folded into the design above

| # | Choice | Outcome |
|---|---|---|
| **DC-A** | Shape of the occupancy guard in `memory-file-system.ts` | **→ ADR-810, adopted as recommended (option 2).** One private `occupied(normalized)` predicate over the three namespaces; `writeExclusive` and `symlink` both throw `fileExists(path)` on it; `exists` is not folded in. §3a |
| **DC-B** | The ancestor-is-a-file case (rows H/I/J, W4/W5, N18/N19) | **→ ADR-811, user ratified option 1.** Memory keeps `NOT_A_DIRECTORY` with the **ancestor** path at every depth; the depth-1 code divergence is documented in the port comment, and the contract suite covers depth ≥ 2 by code only. §1b–§1e |
| **DC-C** | Where the cross-adapter proof lives, and how strict | **→ ADR-812, adopted as recommended (option 1).** Contract suite only, strict codes, no `test/parity/` scenario, no symlink-occupant row. §5 extends the reasoning to the new rows and adds the Windows constraint the first pass did not have |
| **DC-D** | Tighten the `writeExclusive` JSDoc on `src/ports/file-system.ts` | **→ ADR-813, adopted as recommended (option 1).** Occupancy stated as *anything at `path`*, plus one ancestor obligation line naming the adapter-dependent depth-1 code; `ports-and-adapters.md:561` corrected in the same change. §6 |
| **DC-E** | Browser `writeExclusive` lets a `TypeMismatchError` escape as a bare `DOMException` | **→ ADR-814, user ratified option 2.** `assertDoesNotExist` narrows its catch: `TypeMismatchError` → `fileExists(path)`, every other non-`NotFoundError` rejection propagates; one new case in `test/browser/opfs-roundtrip.spec.ts`. Covers `writeExclusive` **only** |
| **DC-F** | The same defect family in non-exclusive `write` — and in `rename` | **→ ADR-815, user ratified option 3, against the design's recommendation.** `write` throws `permissionDenied(path)` for a directory at the leaf and the three delegating surfaces inherit; `rename` refuses what node refuses, with the codes pinned by §1e before implementation; no memory surface may land a file entry on a directory name |

**One reading ADR-815's wording needs.** It says `rename` refuses *"when a directory occupies the
destination **or** the source and destination differ in kind"*. Taken literally the second clause
would also cover file → symlink (N13) and symlink → file (N14), on which node **succeeds**. §1e
settles it: the only axis that produces a refusal is directory-versus-non-directory, so the clause is
read as "differ in kind *where the node adapter refuses*", and R17–R20 are the exact set.

### Settled by the second decisions round — folded into the design above

| # | Choice | Outcome |
|---|---|---|
| **DC-G** | Browser `write` / `writeStream` / `writeUtf8` / `appendUtf8` and `rename` report `FILE_NOT_FOUND` for a directory occupant where node and the memory target say `PERMISSION_DENIED` | **→ ADR-816, user ratified option 2, against the design's recommendation.** `resolveFileHandle` gains a `create: true`-**only** arm mapping `TypeMismatchError` to `permissionDenied(path)`; the `create: false` mapping `stat` and `exists` depend on is untouched (**R30**). Two new Playwright cases — one `write`, one `rename` — join ADR-814's, so `opfs-roundtrip.spec.ts` carries three directory-occupant pins. §1f, §3f |
| **DC-H** | `rename` where `dst` is inside `src` (N11 / N11b / N12) — the one family ADR-815's text does not reach, and the one row where the two POSIX platforms disagree | **→ ADR-817, user ratified option 1 (as recommended).** One clause **before** the destination-kind check throwing `unsupportedOperation('filesystem', <invalid-argument errno>)` for every inside-source arrangement, including `rename(rootDir, <inside>)`. Reproduces linux exactly; the darwin `NOT_A_DIRECTORY` on N11b is a knowing divergence, documented not chased. Never a strict cross-adapter row. §3c |
| **DC-I** | `write` and its three delegating surfaces over a **symlink** leaf (row W9) | **→ ADR-818, user ratified option 1 (as recommended).** The `write` guard is `directories.has(n) \|\| symlinks.has(n)` → `permissionDenied(path)`; the three delegating surfaces inherit; one single-occupant test per term. Closes the last open pair of R8a, leaving only the constructor-seeding route (§2d). §3b, **R28** |
| **DC-J** | How the node-side assertion for the new `write` / `rename` refusals is written, given that the contract suite also runs on `windows-latest` | **→ ADR-819, adopted as recommended (option 2).** Contract rows assert a structured `TsgitError` plus non-destructiveness, no code — the `:676` precedent; the strict node codes move to a new file under `test/integration/posix-only/`, run by the `posix-integration` job on ubuntu + macos. `writeExclusive` rows stay strict per ADR-812. The two **positive** rows (R20, R21) stay in the contract suite, because a positive row has no tolerant form. §5, **R25**, **R32** |

### New — raised by this fold

**None.**

The fold is a pure consequence of ADRs 816–819, and every question it opened resolved inside the
material those records already decide. Three that a reader might expect to see raised, and why each
is not a candidate:

- **Browser `rename` with a directory *source*** stays `FILE_NOT_FOUND` where node succeeds for a
  fresh destination. ADR-816's scope is a directory at the *target*, the fix is `create: true`-only,
  and the `create: false` path it travels is untouched — so the fold changes nothing here. Making it
  correct means implementing directory rename on OPFS (recursive copy then remove), a capability
  change with no defect behind it: the current behaviour refuses, it does not corrupt. §3f, §Out of
  scope.
- **The `TypeMismatchError` predicate's shape** (`err.name` versus `err instanceof DOMException`) is
  an implementation detail settled by evidence, not judgement: §1f measured `DOMException` on both
  engines, so both work, and the structural check is chosen because it is realm-independent and
  matches the repo's existing rule for classifying adapter errors. §3f.
- **The errno literal's spelling in this document** is a tooling constraint, not a decision: the name
  is not in `cspell.json`, this commit is one file, and a `cspell` suppression comment is forbidden.
  §1e names the exact insertion point for the implementation commit.

---

## Test strategy

### Inventory — what exists, what changes

`test/**` swept for every `writeExclusive` override / spy, every `stat` fake near a pack artefact,
and every `FILE_EXISTS` / `NOT_A_DIRECTORY` assertion. Result: **exactly one edit**, plus one title
correction.

| File · lines | Given → When → Then | Verdict |
|---|---|---|
| `test/unit/application/primitives/internal/write-pack-artifacts.test.ts` **:889–920** (`writeExclusive` override at **:913–916**, `stat` size fake at **:917–920**, comment at **:892–899**) | `Given a directory occupying the .idx sibling name` → `When writePackSiblingArtifacts runs` → `Then it refuses naming the index instead of surfacing a raw filesystem error` | **EDIT.** Drop the `writeExclusive` override; **keep** the `stat` size fake (it forces `isFile` to be the sole discriminator). Rewrite the Arrange comment — it currently reads *"…the memory adapter only checks files/symlinks — so `writeExclusive` is patched here to reject the same way a correct adapter (or a real one) would"*, the exact sentence this change retires |
| same file **:343–348** (`.rev` → `PERMISSION_DENIED`), **:981–986** (`.promisor` → `PERMISSION_DENIED`) | `Given writeExclusive rejects … with something other than FILE_EXISTS` | **KEEP.** Non-`FILE_EXISTS` injections pinning the rethrow branch |
| same file **:479–485**, **:523–529**, **:602–608** (`vi.spyOn`) | tmp-name shape / `Math.random` scaling / tmp-debris cleanup | **KEEP.** Call-order and argument pins |
| `test/unit/application/primitives/fetch-pack.test.ts` **:5311–5331** (`stat` size fake at **:5328–5331**) | `Given a directory whose stat happens to report the same size as the pack, occupying the content-addressed destination` | **UNAFFECTED — the brief's second candidate.** It patches `stat` only; that `.pack` destination is reached by quarantine-rename with a stat/read pre-check, never by `writeExclusive`. It does **not** become redundant |
| `test/unit/application/primitives/fetch-pack.test.ts` **:4130–4206**, `commands/fetch.test.ts:1867`, `commands/internal/index-update.test.ts` **:297/319/512/548**, `primitives/atomic-write.test.ts` **:60/98**, `primitives/write-object.test.ts` **:152/178**, `primitives/reftable-transaction.test.ts` (14 spies), `commands/maintenance.test.ts:2521`, `commands/branch.test.ts` **:734/765/793/824** (`Proxy`), `primitives/fixtures.ts:273` | assorted | **KEEP, all.** Recorders, non-`FILE_EXISTS` faults, or `FILE_EXISTS` injected to drive *caller* retry/remap logic. None fakes the directory-occupant behaviour |
| `test/unit/adapters/memory/memory-file-system.test.ts` **:811–818** | `Given the memory fs has no real symlinks` → `When writeExclusive is called` → `Then succeeds (symlink-safe contract trivially holds)` | **RETITLE.** The premise is false. The body proves parent auto-creation; the title should say so |
| `test/unit/adapters/memory/memory-file-system.test.ts` **:431–449** | `Given rename of non-existent src` → `Then throws FILE_NOT_FOUND` | **UNAFFECTED.** `assertRenamable` raises the same error from a different line; the assertion is on `data.code` |
| `test/unit/adapters/memory/memory-file-system.test.ts` **:232–249**, **:250–312** | rename of a symlink; rename of a directory subtree, incl. the two prefix-boundary siblings at **:274** and **:294** | **KEEP, all.** Every one targets a fresh destination — the happy paths the guard must not break (N23/N24) |
| `test/unit/adapters/memory/memory-file-system.test.ts` **:452–472** | `Given write path whose parent segment is an existing file` → `Then throws NOT_A_DIRECTORY` | **KEEP.** The ADR-811 ancestor posture on `write`; the new leaf guard sits above it and must not shadow it |

**Nothing breaks.** `data.path` is never asserted on an adapter-produced `NOT_A_DIRECTORY` anywhere in
the suite. Exactly one test pins a *production-produced* `FILE_EXISTS` path —
`fetch-pack.test.ts:4189` (`…/tmp_pack_<random>`, the quarantine give-up message) — on a path this
change cannot reach.

### Regression sweep — measured, not argued

The first pass swept `write` by reading; `rename` was not swept at all. This revision swept both
**empirically**. Method: a `mktemp -d` copy of the worktree (`node_modules` symlinked, `.git`
excluded) with `MemoryFileSystem` instrumented to *record, not refuse* every call the new guards
would newly reject — `WRITE_ONTO_DIR`, `WRITE_ONTO_SYMLINK`, `WX_ONTO_DIR`, `RENAME_LEAF_ONTO_DIR`,
`RENAME_DIR_ONTO_LEAF`, `RENAME_DIR_ONTO_NONEMPTY_DIR`, `RENAME_DST_INSIDE_SRC`,
`CTOR_SEED_ONTO_DIR` — each hit carrying the three nearest `test/` stack frames. The copy was deleted
afterwards; the worktree was never modified.

| Suite | Files | Tests | Hits |
|---|---|---|---|
| `--project unit` | 686 | 15 831 | **0** |
| `--project unit --project parity` (with the constructor probe added) | 689 | 15 929 | **0** |
| `--project parity --project integration --project posix-integration` | 147 | 2 369 | **0** |

Three integration files failed in the throwaway (`public-runtime-exports` needs a built `dist/`,
which the copy excluded; `bundle-interop` and `delta-pack-interop` spawn real `git` inside a
directory that is not a repository). All three are artefacts of the copy, none touches the memory
adapter, and none produced a hit.

**Inventory of hits: empty — the file:line list is nil for every tag.** So no memory-backed test
today writes onto a directory or a symlink, renames onto a directory, renames a directory onto a leaf
or a non-empty directory, renames a directory into itself, or seeds a colliding constructor fixture.
The `WX_ONTO_DIR` zero is consistent with §4: the one test that exercises that arm patches
`writeExclusive` first, so the real adapter never sees it.

Not covered by the sweep, and stated as such: `test/browser/**` (Playwright, runs the browser
adapter, not memory), `test/bench/**` (not a gate), and `test/integration/win-only/**` (not runnable
here). `npm run validate` remains the arbiter, not this table.

**Two of those zeroes are now load-bearing rather than informational.** `WRITE_ONTO_SYMLINK: 0` was a
DC-I data point when the symlink term was still a candidate; ADR-818 shipped that term, so the zero is
the evidence that no memory-backed test writes through a symlink today. `RENAME_DST_INSIDE_SRC: 0` is
the same for ADR-817. Both risks are therefore measured, not assumed — but the sweep instrumented the
**memory** adapter only, so neither says anything about the node adapter (unchanged) or the browser
adapter.

**The browser change's blast radius, reasoned separately** because the sweep could not reach it: the
new arm can only fire where `resolveFileHandle(path, true)` already threw, and it changes
`FILE_NOT_FOUND` to `PERMISSION_DENIED` on that one path. `test/browser/parity.spec.ts` runs the whole
`SCENARIOS` registry against real OPFS, and no scenario can be relying on a *failed* write's code —
a scenario that hit this path would already be failing. The one mapping a passing scenario does rely
on is `create: false` → `FILE_NOT_FOUND` (every `exists`/`stat` probe on a directory), and that arm is
untouched by construction (R30) and asserted explicitly in Playwright case 2.

### New memory-adapter unit cases

`test/unit/adapters/memory/memory-file-system.test.ts`, house GWT split
(`describe('Given …')` > `describe('When …')` > `it('Then …')` — the inner describe carries the
When, never a second Given), AAA section comments, `sut` = the adapter under test, error assertions
via try/catch on `data.code` **and** `data.path` (never `toThrow(Class)`) — except where the code is
`UNSUPPORTED_OPERATION`, which carries `operation` and `reason` instead of `path`, so the R27 rows
assert those two fields plus the non-destructiveness observation.

**`writeExclusive` — `describe('writeExclusive contract')`**

| Req | Given | When | Then |
|---|---|---|---|
| R1 | an empty directory occupies the target path | `writeExclusive` | throws `FILE_EXISTS` carrying the requested path |
| R2 + R7 | a directory holding a child file occupies the target path | `writeExclusive` | throws `FILE_EXISTS`, the child is still readable byte-for-byte, and `lstat` still reports a directory |
| R3 | the target path is the adapter's root directory | `writeExclusive` | throws `FILE_EXISTS`, and a later write elsewhere in the tree still succeeds |
| R4 | a regular file occupies the target path | `writeExclusive` | throws `FILE_EXISTS` |
| R5 | a symlink occupies the target path | `writeExclusive` | throws `FILE_EXISTS` |

**`write` and its delegates — `describe('write over an occupied leaf')`**

Every row plants **one** occupant, never two, so each disjunct of the §3b guard is tripped alone
(§3e). The directory rows kill the `directories` term; the symlink rows kill the `symlinks` term.

| Req | Given | When | Then |
|---|---|---|---|
| R12 | an empty directory occupies the target path | `write` | throws `PERMISSION_DENIED` carrying the requested path; `lstat` still reports a directory |
| R13 + R22 | a directory holding a child file occupies the target path | `write` | throws `PERMISSION_DENIED`; `readdir` still lists the child and the child reads back byte-identical |
| R14 | the target path is the adapter's root directory | `write` | throws `PERMISSION_DENIED`, and a later write elsewhere still succeeds |
| R15 | an empty directory occupies the target path | `writeUtf8` | throws `PERMISSION_DENIED` |
| R15 | an empty directory occupies the target path | `writeStream` | throws `PERMISSION_DENIED` |
| R15 | a directory holding a child occupies the target path | `appendUtf8` | throws `PERMISSION_DENIED`, and the child is unchanged (nothing was read or written first) |
| R16 | a regular file occupies the target path | `write` | overwrites, and reads back the new bytes |
| **R28** | a **symlink to an existing file** occupies the target path | `write` | throws `PERMISSION_DENIED` carrying the requested path; `readlink` still returns the original target and the target file's bytes are unchanged |
| **R28** | a **dangling symlink** occupies the target path | `write` | throws `PERMISSION_DENIED`; `readlink` still returns the original target |
| **R28** | a symlink occupies the target path | `writeUtf8` | throws `PERMISSION_DENIED` |
| **R28** | a symlink occupies the target path | `writeStream` | throws `PERMISSION_DENIED` |
| **R28** | a symlink occupies the target path | `appendUtf8` | throws `PERMISSION_DENIED`, and `readlink` is unchanged |

**`rename` — `describe('rename kind guard')`**, one arrangement per case so each guard clause is
tripped alone (§3e):

| Req | Given | When | Then |
|---|---|---|---|
| R17 | a file at src and an **empty directory** at dst | `rename` | throws `PERMISSION_DENIED` carrying **src**; both keep their kinds |
| R17 | a file at src and a **directory with children** at dst | `rename` | throws `PERMISSION_DENIED` carrying src; dst's child still reads back byte-identical |
| R17 | a **symlink** at src and a directory at dst | `rename` | throws `PERMISSION_DENIED` carrying src; `readlink(src)` unchanged |
| R17 | a file at src and dst = the adapter's **root** | `rename` | throws `PERMISSION_DENIED`, and a later write still succeeds |
| R18 | a **directory** at src and a **regular file** at dst | `rename` | throws `NOT_A_DIRECTORY` carrying src; src's children are still listed under src |
| R18 | a directory at src and a **symlink** at dst | `rename` | throws `NOT_A_DIRECTORY` carrying src; `readlink(dst)` unchanged |
| R19 | a directory at src and a **non-empty directory** at dst | `rename` | throws `DIRECTORY_NOT_EMPTY` carrying src; both trees intact, neither merged |
| R19 | an **empty** directory at src and a non-empty directory at dst | `rename` | throws `DIRECTORY_NOT_EMPTY` carrying src |
| R19 | a directory at src and dst = src's own **parent** | `rename` | throws `DIRECTORY_NOT_EMPTY` carrying src — **not** ADR-817's code, because a parent is not inside its child |
| R20 | a directory with children at src and an **empty directory** at dst | `rename` | succeeds; every child is reachable under dst and none under src |
| R21 | a **regular file**, src === dst | `rename` | resolves; the bytes are unchanged |
| R21 | a **non-empty directory**, src === dst | `rename` | resolves; every child is still reachable (the clause that would otherwise refuse) |
| R23 | a file at src and a directory at dst | `atomicRename` | throws `PERMISSION_DENIED` carrying src — proves the delegation, not a second guard |
| R24 | absent src | `rename` | throws `FILE_NOT_FOUND` carrying src *(existing case at `:431`, retained)* |
| R27 | a directory at src and an **absent** dst inside src | `rename` | throws `UNSUPPORTED_OPERATION` with `operation === 'filesystem'` and the invalid-argument errno as `reason`; src's subtree is intact |
| R27 | a directory at src and an **existing non-empty directory** dst inside src | `rename` | same error; both levels intact — proves the clause wins over the `DIRECTORY_NOT_EMPTY` check |
| R27 (N11b) | a directory at src and an **existing regular file** dst inside src | `rename` | same error, and the file is unchanged — proves the clause sits **above** the file/symlink check (ADR-817's ordering). **Memory-only**: POSIX-divergent, never a contract row, and pinned nowhere on the node side |
| R27 (N11b) | a directory at src and an **existing symlink** dst inside src | `rename` | same error; `readlink(dst)` unchanged |
| R27 | src = the adapter's **root**, dst inside it | `rename` | same error, `lstat(rootDir)` still reports a directory, and a later write anywhere still succeeds |
| R27 | a directory at src, dst a **deep** path inside src whose mid segment is absent | `rename` | same error — the clause is a prefix test, not a lookup |

R3 / R14 (the `rootDir` cases) are memory-specific: node's root is a real directory the contract
driver cannot reasonably occupy, so they have no contract counterpart.

### New shared contract rows

`test/unit/ports/file-system.contract.ts`, in that file's existing 1-level
`it('Given …, When …, Then …')` style, run by **both** drivers. Strictness per §5, now settled by
ADR-819: `writeExclusive` rows keep a strict code; every `write` / `rename` **refusal** row asserts a
structured `TsgitError` plus a non-destructiveness observation and no code; the two **positive** rows
assert the outcome.

The refusal rows need one new local helper beside the four existing assertion helpers (`:78–95`) —
call it `assertRefusedWithoutCode`, matching the `:676` precedent's body: `expect(caught).toBeInstanceOf(TsgitError)`
and nothing about `data`. Each row then adds its own non-destructiveness assertions inline, because
what "intact" means differs per arrangement.

| Req | Row | Strictness |
|---|---|---|
| R9 | `Given an existing directory, When writeExclusive, Then throws FILE_EXISTS` | **strict**, via `assertFileExists` (`:88`) |
| — | `Given a file at a grandparent path segment, When writeExclusive, Then throws NOT_A_DIRECTORY` | **strict on the code**, via `assertNotADirectory` (`:93`), which asserts no `data.path`. Depth ≥ 2 only; an in-file comment records that depth 1 is adapter-dependent |
| R25 | `Given a directory at the target path, When write, Then it refuses and the directory is intact` | instance + `readdir(dir)` still lists the child, and the child reads back byte-identical |
| R25 | `Given a directory at the destination, When rename, Then it refuses and neither side moves` | instance + `read(src)` unchanged, `readdir(dst)` unchanged |
| R25 | `Given a directory source and a file destination, When rename, Then it refuses and neither side moves` | instance + the destination file's bytes unchanged, the source's children still under the source |
| R25 | `Given a directory source and a non-empty directory destination, When rename, Then it refuses and neither tree merges` | instance + each tree still holds exactly its own child |
| R20 | `Given a directory source and an empty directory destination, When rename, Then the subtree lands at the destination` | **positive row, outcome asserted** — the row most at risk on Windows, kept because a positive row has no tolerant form (§5) |
| R21 | `Given src === dst, When rename, Then it resolves and the entry is unchanged` — one file case, one non-empty-directory case | **positive rows**, outcome asserted, no code |

New rows go beside the existing `Given existing file, When writeExclusive, Then throws FILE_EXISTS`
(`:389`), `Given non-existent path, When writeExclusive, Then creates file` (`:403`), and the two
rename rows at `:357` / `:373`. None needs an addition to the `pathCalls` security table (`:34–76`) —
`writeExclusive` (`:39`), `write`, `rename-src` and `rename-dst` are all already rows there.

**The tolerant `mkdir` row at `:567` stays tolerant**, and does not conflict. It asserts `mkdir` over
a *regular file*, where node gives `FILE_EXISTS` (its `mkdir -p` sees `EEXIST` — verified on darwin
and linux) and memory gives `NOT_A_DIRECTORY` from `addDirectoryRecursive`. That is ADR-811's depth-1
reasoning at depth 0: the two adapters genuinely disagree, the tolerance is load-bearing, and it is a
different method and a different occupant shape from every row above. Probed in passing: `mkdir` over
a *symlink* has the same split (node `FILE_EXISTS`, memory `NOT_A_DIRECTORY`) and has no row today;
none is added.

### Node-side strict rows — the new posix-only file (ADR-819)

**`test/integration/posix-only/node-fs-write-rename-refusals.test.ts`** — the name follows the
directory's own `node-fs-<subject>.test.ts` convention (`node-fs-locked-directory`, `node-fs-mode-bits`,
`node-fs-real-symlinks`), not the `node-file-system-…` shape the previous revision guessed.

It is run by the `posix-integration` project (`vitest.config.ts:54–60`, `include:
test/integration/posix-only/**/*.test.ts`) via `npm run test:posix-integration`, which is
`vitest run --project posix-integration` — confirmed present in `package.json` (`wireit`
`test:posix-integration`, files `src/**/*.ts` + `test/integration/posix-only/**/*.ts` +
`vitest.config.ts`, dependency `check:types`). It is **not** part of `npm run validate` and **not**
part of `npm run test:integration` (the `integration` project explicitly excludes
`test/integration/posix-only/**`), so it must be run explicitly — §Gates.

**Header.** All five existing files in the directory open with a block comment saying *why the case
is platform-bound*, followed by a `@proves` block (`surface:` / `bucket: platform-only` / `unique:`).
`check:test-pyramid`'s `integrationProof` heuristic is **off** in `test-pyramid-budgets.json`, so the
header is not mechanically gated — it is a house convention, and the new file follows it:
`surface: nodeFs.writeRenameRefusals`, `bucket: platform-only`, `unique:` the POSIX errno mapping for
directory- and symlink-occupant refusals through `NodeFileSystem`.

**Tier constraints that *are* gated.** This file lands in the `integration` tier, where
`gwtTitle`, `aaaBody`, `sutNaming`, `sutBindsResult`, `bareClassToThrow`, `emptyAaaSection` and
`underAssertedUnit` all apply, and `overMockedIntegration` has a threshold of **0** — so the file
must contain no `vi.mock` / `vi.fn` / `vi.spyOn` / `vi.stubGlobal` / `vi.stubEnv`. It needs none: it
constructs a real `NodeFileSystem` over a `mkdtemp` root then `realpath`, exactly as the contract
driver does (`node-file-system.test.ts:63–74`), because macOS `os.tmpdir()` is a symlink. The `sut`
binding is `const sut = new NodeFileSystem(rootDir)` — the shape
`node-fs-mode-bits.test.ts:28` already uses and the audit already passes, so `sutBindsResult` is
satisfied without touching its factory allowlist. Tier share is unaffected — the audit counts
**files**, and integration sits at 146/17.2 % with a 25 % warn-above, so one more file is 147/17.3 %.

**Rows** — every §1d / §1e arrangement on which darwin and linux agree, asserting `data.code` and,
where the variant carries one, `data.path`:

| From | Arrangement | Assert |
|---|---|---|
| W1 / W2 / W3 | `write` over an empty directory, a directory with children, the root | `PERMISSION_DENIED`, `path` = requested |
| W6 / W7 / W8 | `writeUtf8`, `writeStream`, `appendUtf8` over a directory | `PERMISSION_DENIED`, `path` = requested |
| W9 | `write` over a symlink leaf, live and dangling | `PERMISSION_DENIED`, `path` = requested |
| W4 / W5 | file at the immediate parent / at the grandparent | `FILE_EXISTS` / `NOT_A_DIRECTORY`, `path` = requested — the ADR-811 depth split, pinned so it cannot move silently |
| N1 / N2 / N3 / N15 | leaf → directory destination (file, file-with-children, symlink, the root) | `PERMISSION_DENIED`, `path` = **src** |
| N4 / N5 / N6 | directory → regular file / → symlink destination | `NOT_A_DIRECTORY`, `path` = **src** |
| N8 / N9 / N10 / N16 | directory → non-empty directory, → its own parent, → the root | `DIRECTORY_NOT_EMPTY`, `path` = **src** |
| N7 / N20 / N21 / N22 / N23 / N24 | the positive rows: replace an empty directory, `src === dst` for a file and for a non-empty directory, fresh-name moves | they resolve, and the tree is where it should be |
| N11 / N12 | dst inside src, dst absent or a directory; the root renamed inside itself | `UNSUPPORTED_OPERATION`, `operation: 'filesystem'`, `reason` = the invalid-argument errno, **no `path`** |
| N18 / N19 | the two anchoring oddities this design deliberately does not fix — N18's `FILE_EXISTS` carrying **src**, N19's `NOT_A_DIRECTORY` carrying **dst** | both, so a future refactor of `runFs` anchoring cannot move them silently |

**N11b is excluded** — it is the one row where darwin and linux disagree (§1e), and this job runs on
both. It is pinned memory-side only.

### Browser Playwright cases — ADR-814 + ADR-816

**File:** `test/browser/opfs-roundtrip.spec.ts`, which after this change carries **three**
directory-occupant pins. They go in a **second** `test.describe` — the existing one is titled
*OPFS round-trip* and its body is one init→add→commit→status case — and that new describe **must
repeat the webkit skip**: `test.skip(({ browserName }) => browserName === 'webkit', 'OPFS not exposed
in Playwright WebKit')`. Playwright's headless WebKit does not expose
`navigator.storage.getDirectory`, and a `test.skip` on one describe does not reach a sibling. This is
the whole of the per-driver gating obligation here — ADR-812 adds no parity scenario, so nothing has
to land in the five dist-bundle drivers.

**How the page gets a `BrowserFileSystem`.** Inside `page.evaluate`, a dynamic
`import('/dist/esm/adapters/browser/index.js')` — the module `index.html` already imports from, so it
is served and in the page's module cache — then `new BrowserFileSystem(await
navigator.storage.getDirectory())`. Note the constructor takes the **handle directly**
(`browser-file-system.ts:19`), not a `BrowserFileSystemOptions` object, despite that interface being
exported. The alternative — exposing `BrowserFileSystem` on `window.__tsgit.adapters` — is rejected:
every one of the six specs in `test/browser/` loads `index.html` (`no-build-bundle.spec.ts` loads it
*and* `no-build.html`), and a harness edit to reach one adapter class is blast radius for nothing.

**How the occupant is planted.** Through the adapter's own `mkdir` / `write`, not raw
`navigator.storage.getDirectory()` handles. That is what the memory unit rows and the contract suite
already do (`file-system.contract.ts:676–680` plants with `env.fs.mkdir`), it keeps the case in one
vocabulary, and `mkdir` is not the method under test in any of the three. `resetOpfs` in the
`readyPage` fixture guarantees an empty root per test, so no cleanup is needed.

**How the assertion crosses the boundary.** `page.evaluate` returns **plain data only** — never a
`TsgitError` instance, whose class identity and `data` field do not survive serialisation. Each case
plucks `{ code, path }` off `err.data` inside the page and returns it alongside the
non-destructiveness observations, then asserts on the Node side. Titles use the file's existing
1-level `Given …, When …, Then …` form; `check:test-pyramid`'s GWT / AAA / `sut` heuristics do not
cover the `e2e` tier, so this is house style rather than a gate.

| # | Req | Given → When → Then | Steps |
|---|---|---|---|
| 1 | ADR-814 | `Given a directory occupying the target path, When writeExclusive, Then it throws FILE_EXISTS against real OPFS` | the code and the requested path; the directory and its child still there afterwards |
| 2 | **R29**, R30, R31 | `Given a directory occupying the target path, When write, Then it throws PERMISSION_DENIED against real OPFS` | (a) the code and the requested path; (b) non-destructiveness — `readdir` still lists the child and the child's bytes are unchanged; (c) **the mappings that must not move** — `stat(dir).isDirectory` is still `true` and `exists(dir)` is still `true` (R30), and a `write` under a path whose ancestor segment is a regular file still reports `FILE_NOT_FOUND`, not `PERMISSION_DENIED` (R31) |
| 3 | **R29** | `Given a file source and a directory destination, When rename, Then it throws PERMISSION_DENIED and the source survives` | the code and the requested path; `read(src)` returns the original bytes — `rm(src)` never ran; the destination directory's child is unchanged |

Case 2's step (c) is where the fix's real risk lives. The `create: false` mapping is what `stat` and
`exists` fall back through, and the existing round-trip case already depends on it — `init` probes
for `.git` through `exists`, which reaches `resolveFileHandle(path, false)` on a directory on every
run — so a helper-wide re-map would turn the whole spec file red. Step (c) makes that dependency
**explicit** rather than incidental, so a future reader cannot delete it as redundant.

### Receive-path test edit

One edit, at `write-pack-artifacts.test.ts:889–920` — see the inventory for exactly what goes and
what stays. After it the test proves the real memory adapter refuses a directory occupant and
`writeOrKeepArtifact` classifies it, which is R10.

### Stryker equivalence proofs — per-proof verdict

Re-read against the **new** guard placement, per the repo rule that equivalence comments are
structure-specific and a data-structure or control-flow change falsifies a carried-forward proof:

| Line | Proof | Verdict after the change |
|---|---|---|
| `:186` `readdir` files/dirs disjoint | wording unchanged and now unconditionally true | **KEEP as written.** The annotated line is not edited |
| `:352` `removeLeafEntry` file arm | same | **KEEP as written** |
| `:359` `removeLeafEntry` symlink arm (*"symlinks/dirs are disjoint"*) | the premise becomes true only because of the **`rename`** guard, not `writeExclusive` | **KEEP as written**, re-verified: the sentence is about the disjointness, not about which method enforces it, so it still matches the code it annotates |
| `:515` `addDirectEntry` pairwise disjoint | this is the one proof whose wording names **all three** pairs, so it is the one ADR-818 completes: before it, `write` over a symlink leaf could put a name in `files` *and* `symlinks`, and the two iterators would build `{isFile:true}` and `{isSymbolicLink:true}` for the same first segment | **KEEP as written**, and it becomes unconditionally true only with R28 in place |
| `:343` `rmRecursive` (*"not a directory ⇒ missing entirely"*) | does not name disjointness; the claim is now sound where it was conditional | **KEEP as written** |
| `:291` `renameDirectory` remap (*"remap only runs when key === src or key startsWith `${src}/` …"*) | the reasoning is about the **key filter**, untouched by a guard sitting in `rename` above the call. **But** if the implementation adds an explicit `directories.delete(dst)` inside `renameDirectory` for the R20 replace path, the directive's anchor line moves — Stryker anchors on the expression line, so the comment must move with `const remap = …` | **KEEP the wording; re-check the anchor** if `renameDirectory` gains a statement |
| `:213` `mkdir`, `:204` `readdir`, `:392` handle read, `:497` `hasChildren`, `:544` / `:553` collectors | none is on a line this change edits, and none rests on a premise this change moves | **KEEP** |

No new suppression directive is introduced. Any survivor on the new guards is a real survivor and
gets a kill test, not a comment.

### Property tests — the four lenses, re-applied to `rename`

Re-run deliberately now that `rename` is in scope, because `renameDirectory` *is* a re-keying
function over a subtree and lens 4 (counting / structural invariant) has obvious surface appeal:
*"the recursive listing under `dst` after equals the recursive listing under `src` before, and `src`
is gone."* The oracle would be a recursive `readdir` walk over the **port surface**, not a copy of
the remap loop, so it would not be a tautology.

It still does not ship, for two reasons that are about *this diff*, not about property tests:

1. **The code this change adds has no property shape.** `assertRenamable` is a case analysis over a
   four-value kind enum (`absent` / `file` / `symlink` / `directory`) on two sides — sixteen
   combinations, of which §1e enumerates every reachable one. CLAUDE.md's exclusion list names this
   exactly: *"functions whose only inputs are a small enum — a parameterised example sweep does the
   same job clearer."* The unit table above **is** that sweep. The `write` guard is a single
   membership test, smaller still.
2. **The code with the property shape is untouched.** `renameDirectory`'s remap is pre-existing and
   this change does not edit it; what changes is its *reachable input domain*, which narrows (`dst`
   is now provably absent or an empty directory). Adding a property over untouched code is additive
   scope with no defect signal in this diff, and the prefix-boundary bug class it would target
   already has two targeted example tests (`memory-file-system.test.ts:274`, `:294`).

R8a (pairwise disjointness) remains the one statement with genuine property appeal — *no reachable
sequence of adapter calls puts one key in two namespaces* — but writing it needs a generator over
adapter **operation sequences** and a re-implementation of the state machine as oracle, which is the
tautology the fourth lens warns against. It is asserted instead by the example cases at the four
methods that could break it. **No `*.properties.test.ts` sibling ships, and this paragraph is the
recorded reason.** Lenses 1 (round-trip) and 3 (total function over a grammar) do not fit at all:
`rename` has no inverse, and the interesting axis is filesystem *state*, not path syntax.

### Documentation surfaces

| Surface | Change | Owner |
|---|---|---|
| `src/ports/file-system.ts` `writeExclusive` JSDoc | occupancy stated as *anything at `path`* + the ancestor obligation line (R11) | implementation, ADR-813 |
| `src/ports/file-system.ts` `write` / `writeStream` / `writeUtf8` / `appendUtf8` JSDoc | *"Overwrites if exists"* → overwrites a **regular file**; refuses a **directory or a symlink** at the leaf with `PERMISSION_DENIED` (R26, extended by ADR-818) | implementation |
| `src/ports/file-system.ts` `rename` / `atomicRename` JSDoc | the §1e kind matrix in one sentence, plus `data.path === src` on every refusal, plus the inside-source refusal and its `UNSUPPORTED_OPERATION` shape (R26, extended by ADR-817) | implementation |
| `cspell.json` | one word: POSIX's invalid-argument errno, inserted between the `effectful` and `EISDIR` entries (`:288` today). **Never re-sort the file.** Lands in the implementation commit that introduces the literal, never as a `cspell:disable` comment | implementation, ADR-817 |
| `docs/design/ports-and-adapters.md:561` | the `writeExclusive` line that codified the narrow reading | docs phase, ADR-813 |
| `docs/design/ports-and-adapters.md:565` | the `rename` line — *"Delete old key + insert new key"* is now an incomplete description of the guarded method | docs phase |
| `docs/design/ports-and-adapters.md` memory bullet list | has no `write` bullet at all; add one naming the directory refusal | docs phase |
| `docs/use/errors.md:42` `FILE_EXISTS` | *"Write attempted with `wx` flag against an existing file"* → anything occupying the path (file, directory, or symlink including a dangling one) | docs phase |
| `docs/use/errors.md:46` `PERMISSION_DENIED` | add: a non-exclusive write whose leaf is a directory, and a `rename` that would replace a directory with a non-directory | docs phase |
| `docs/use/errors.md:41` `DIRECTORY_NOT_EMPTY` | *"A directory delete on a non-empty target"* → also a `rename` whose destination is a non-empty directory | docs phase |
| `docs/use/errors.md:44` `NOT_A_DIRECTORY` | *"Directory operation against a non-directory"* → also a `rename` of a directory onto a non-directory | docs phase |

### Review-round additions

| Req | Where | Case |
|---|---|---|
| R33 | `memory-file-system.test.ts` → `describe('ancestor refusals leave no directory behind')` | `write` and `mkdir` under a file-blocked grandparent: `NOT_A_DIRECTORY`, the intermediate directory absent, the root listing unchanged |
| R33 | `file-system.contract.ts` grandparent row | after the strict `NOT_A_DIRECTORY`, `lstat` of the intermediate rejects on both drivers with one of the enumerated pair `NOT_A_DIRECTORY` / `FILE_NOT_FOUND` |
| R24 | `describe('rename kind guard')` | file over symlink (link replaced, target untouched — kills the dispatcher's forced-`true` mutant); symlink over file (link keeps its target, the replaced file entry is gone) |
| R21 | `describe('rename kind guard')` | two files, `rename(a, a)`: listing order unchanged — a re-inserted entry would move to the end (kills the forced-`false` early-return mutant) |
| R7 | `describe('writeExclusive contract')` | the directory kind and the child's bytes are unchanged (memory directories carry no timestamps) |
| R36 | `describe('root and seeding invariants')` | a `files` map seeding a file over an earlier directory key, and one seeding a file at the root, both throw `NOT_A_DIRECTORY` carrying the key |
| bound kills | `describe('root and seeding invariants')` | after `rmRecursive(rootDir)`: a file written at the root path makes a child write refuse `NOT_A_DIRECTORY` (check-loop `>=`); a plain child write records the root again and lists the child (add-loop `>=`) |
| mkdir guard | `describe('mkdir leaf guard')` | `mkdir('blocker')` over a file reports `NOT_A_DIRECTORY` carrying `blocker`, the caller's string (kills the former directive's mutants) |
| browser classifier | `test/unit/adapters/browser/browser-file-system.test.ts` | a fake root handle rejecting with `{ name: 'TypeMismatchError' }` → `PERMISSION_DENIED`; a bare string or `{ name: 42 }` → `FILE_NOT_FOUND` |
| stale handle | `describe('stale handle writes')` | a handle write after `rm` leaves the path absent; a handle write after `rm` + `mkdir` at the same name leaves the directory intact and a child write beneath it works |
| browser classifier | (same file) | a fake root handle rejecting with `null` → `FILE_NOT_FOUND` |
| R34 | `test/browser/opfs-roundtrip.spec.ts` | `rename('same.txt', 'same.txt')` leaves the file with its bytes; `rename('missing.txt', 'missing.txt')` reports `FILE_NOT_FOUND` |

### Gates

Per-part: `npx vitest run <touched test files>`, `npm run check:types`,
`./node_modules/.bin/biome check <touched files>`, `npx cspell --no-progress <touched files>` **bare**
(the wireit-cached scripts report `Ran 0 scripts and skipped 1`, which reads exactly like a pass).
Phase: `npm run validate`, run bare into a file with the exit code read from that file — never
through a pipe, never `--no-verify`. `npm outdated` is re-measured before the full gate (eight
excepted packages, `.claude/workflow.md`).

Coverage stays at 100 % on `src/adapters/memory/**`; the mutation gate covers it too
(`stryker.config.mjs` mutates all of `src` except `index.ts`, `*.d.ts` and
`src/adapters/browser/**`).

**Three gates `npm run validate` does not run, each of which this change needs.** Verified against
`package.json`'s `wireit.validate.dependencies`, which lists neither `test:e2e` nor
`test:posix-integration`.

1. **The browser part.** `src/adapters/browser/**` is outside *both* the coverage gate
   (`vitest.config.ts` `coverage.include`) and the mutation gate, so the three Playwright cases are
   its only proof — and `validate` does not run them. During the browser slice, run
   `npm run build` **first**, then
   `npx playwright test test/browser/opfs-roundtrip.spec.ts --project=chromium --project=firefox`;
   a bare `npx playwright test` bypasses wireit's build dependency and every spec then times out
   uniformly against a stale `dist/`. Before the PR, run `npm run test:e2e`, whose wireit entry
   depends on `build` **and** `build:parity`, so the whole browser tier is covered from a clean
   build. `npx playwright install` is a prerequisite of both.
2. **The posix-only file.** `test/integration/posix-only/**` is a separate CI job (`ci.yml:393`) and
   the `integration` vitest project explicitly **excludes** that directory — so neither
   `npm run validate` nor `npm run test:integration` touches the new file. Run
   `npm run test:posix-integration` (`vitest run --project posix-integration`) explicitly in its
   slice and again before the PR.
3. **The Windows leg.** The contract suite runs on the `windows-latest` unit matrix cell and cannot
   be run locally. Under ADR-819 the refusal rows carry no code, so they are Windows-safe by
   construction; the two **positive** rows (R20, R21-directory) are the ones that can go red there,
   and §5 records that as an accepted, recorded outcome rather than a surprise.

**One dictionary chore.** The memory adapter will carry POSIX's invalid-argument errno as a string
literal (ADR-817), so **`cspell.json` gains that one word** in the implementation commit that
introduces it — inserted between the `effectful` and `EISDIR` entries, file not re-sorted, never a
`cspell:disable` comment. §1e carries the exact anchor and the reason this design document still uses
a stand-in spelling.

---

## Out of scope

- **Node-adapter behaviour.** Nothing in §1b, §1d or §1e changes on the node side. ADR-721 (read
  containment) and ADR-782 (`readSlice` as the pass-2 seam) are untouched, and no node write-path
  semantics move — including the two `data.path` anchoring oddities the matrix records (N18's
  `FILE_EXISTS` carrying `src`, N19's `NOT_A_DIRECTORY` carrying `dst`).
- **`write-pack-artifacts.ts` production code.** ADR-789 governs its input shape; this change edits
  that module's **tests** only.
- **A new interop test.** §7 — the port contract is the oracle, the node adapter's git-facing
  behaviour is unchanged, and the memory adapter has no cross-tool surface.
- **Row L — memory refusing a symlinked ancestor that node follows.** A real divergence in the
  opposite direction (memory stricter); closing it means teaching `addDirectoryRecursive` to resolve
  symlinks and re-check containment — a containment-model change belonging with ADR-721's family.
- **`exists` on a dangling symlink** — node returns `false`, memory returns `true`. Probed in §3a. A
  real divergence in a *different* method with a different correct answer; named here because
  ADR-810 must not paper over it by sharing a helper.
- **N20 — `rename` whose *source* has a regular file at an ancestor segment.** Node throws
  `NOT_A_DIRECTORY` from `resolveWrite(src)`; memory throws `FILE_NOT_FOUND` because its source
  lookup simply finds nothing. ADR-811 ratified memory keeping its own ancestor report on the
  surfaces that funnel through `addDirectoryRecursive`; `rename`'s *source* lookup does not, so this
  is a neighbouring divergence the ADR does not cover and this change does not open.
- **`mkdir` over a symlink or a regular file.** Node `FILE_EXISTS`, memory `NOT_A_DIRECTORY` — the
  same ADR-811 family, a different method. The contract suite's tolerant row (`:567`) already absorbs
  the file case; the symlink case has no row and gains none.
- **Constructor-seeded namespace collisions** (§2d, the one surviving route). A `files ∩ directories`
  collision reachable only from test fixtures, not from the port surface; the sweep found zero
  occurrences. Closing it means either ordering the seeded entries or checking `directories` before
  `files.set` in the constructor loop — a change to a test-facing API with no production caller.
  This is the whole of **R8b**.
- **`write-object.ts`'s treatment of a directory occupant as "we already have this object".** Once
  memory refuses, both adapters take the `isFileExists` arm and return the oid **without the object
  being written** — a pre-existing question about the *caller*, identical on node today, and not
  created by this change.
- **A `test/parity/` scenario.** A slot *does* exist — the brief's premise was wrong and §5 corrects
  it — but ADR-812 records the decision to add none, because every registered scenario also runs
  against real OPFS in `test/browser/parity.spec.ts`.
- **Browser `rm` on a non-empty directory.** Now *measured*, not derived (§1f): `removeEntry` without
  `recursive` rejects with `InvalidModificationError` on chromium and firefox, which the bare `catch`
  at `browser-file-system.ts:146–150` maps to `FILE_NOT_FOUND` where node gives
  `DIRECTORY_NOT_EMPTY`. Same class as ADR-816's defect, a third method, not opened here — ADR-816's
  scope is `write` and `rename`.
- **Browser `rename` with a directory *source*.** After ADR-816 the browser reports
  `PERMISSION_DENIED` for a directory *destination* and still `FILE_NOT_FOUND` for a directory
  *source*, where node succeeds for a fresh destination (N23/N24). ADR-816's wording is *"plant a
  directory at the target"*, the new arm is `create: true`-only, and the source travels the untouched
  `create: false` path — so the fold changes nothing here. It is a **capability** gap, not a mapping
  bug: OPFS has no directory rename, the adapter's read/write/rm emulation is leaf-only, and the
  current behaviour refuses rather than corrupts. Closing it means recursive copy-then-remove with
  its own atomicity story. §3f states the resulting asymmetry plainly so it is not read as a
  half-applied fix.
- **A `BACKLOG.md` tick.** This is not a backlog item.
