# Design — the memory adapter refuses a directory occupant on every write surface

> Brief: `MemoryFileSystem.writeExclusive` refuses a **file** or a **symlink** occupant but not a
> **directory** — it overwrites the name with a file entry and returns success. The node adapter
> refuses with `FILE_EXISTS`, and so does canonical git. Close the gap, prove it cross-adapter,
> and drop the test-side patches that existed only to fake the POSIX behaviour.
> **Scope after the decisions phase:** the same defect family in non-exclusive `write` and in
> `rename` is in scope too — the user ratified option 3 of DC-F against the design's own
> recommendation.
> Status: draft → self-reviewed ×3 → accepted (ADRs 810–815) → revised (write + rename folded in)
> → self-reviewed ×3

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
| **ADR-812** cross-adapter proof lives in the contract suite | Settles DC-C. Strict codes, no `test/parity/` scenario, no symlink-occupant row |
| **ADR-813** the port comment names every occupant shape | Settles DC-D. Rewrite the `writeExclusive` JSDoc; correct `ports-and-adapters.md:561` |
| **ADR-814** browser maps a directory occupant to `FILE_EXISTS` | Settles DC-E for `writeExclusive` **only**. Explicitly leaves browser `write`/`rename` to this revision → §1f, DC-G |
| **ADR-815** non-exclusive `write` and `rename` refuse a directory occupant | Settles DC-F as **option 3**, against the design's recommendation. Requires the `rename` matrix in this revision *before* implementation → §1e |
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

Every statement below is checked by a test named in §Test strategy, except **R8b**, which is an
explicitly *unclosed* invariant clause (§2d, DC-I), and **R27**, which is conditional on DC-H.

**Exclusive create — settled by ADR-810**

- **R1** — `MemoryFileSystem.writeExclusive(p, d)` throws `TsgitError` with `data.code === 'FILE_EXISTS'`
  and `data.path === p` when an **empty directory** occupies `p`.
- **R2** — Same when the directory at `p` **has children**.
- **R3** — Same when `p` is the adapter's `rootDir` itself (today it is silently overwritten; §2b).
- **R4** — Unchanged: a **regular file** at `p` refuses with `FILE_EXISTS`.
- **R5** — Unchanged: a **symlink** at `p` refuses with `FILE_EXISTS` regardless of its target.
- **R6** — Unchanged: an absent `p` writes the bytes and auto-creates missing parents.
- **R7** — A refused `writeExclusive` mutates nothing *observably*: `lstat(p)` still reports
  `isDirectory: true` with unchanged timestamps, and every child under `p/` reads back
  byte-identical. (Stated on the port surface, not on the private `files`/`times` maps.)

**Non-exclusive write — settled by ADR-815**

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
- **R27** *(conditional on DC-H)* — `rename(s, d)` refuses when `d` lies **inside** `s`, with the
  code and the clause position DC-H picks, and `s`'s subtree is intact afterwards. This is a
  *separate* invariant from R8a: it never produces a cross-namespace collision, it produces a
  `directories` set holding a path whose own parent is absent — a directory reachable by `readdir`
  through a parent that `lstat` reports as `FILE_NOT_FOUND`. If DC-H lands option 3, this
  requirement is struck and §2b's second paragraph is the record of what stays broken.
- **R24** — Unchanged: an absent `s` throws `FILE_NOT_FOUND` with `data.path === s`; a file renamed
  over a symlink replaces the link and leaves its target untouched; a symlink renamed over a file
  replaces the file; a directory renamed to a fresh name re-keys its whole subtree.

**Invariant**

- **R8a** — After the change, `files ∩ directories = ∅` and `symlinks ∩ directories = ∅` hold under
  every reachable sequence of `FileSystem` port calls. Not a new invariant: five committed Stryker
  equivalence proofs already assume it (§2c), and after ADR-810 + ADR-815 every method that could
  violate it is guarded — so R1–R3, R12–R14 and R17–R19 are where it is actually enforced.
- **R8b** — `files ∩ symlinks = ∅` is **not** closed by this change. Two routes survive: `write` /
  `writeStream` / `appendUtf8` over a symlink leaf (§1d row W9 — **DC-I**), and the constructor's
  `files` seeding (§2d). Both are named rather than claimed, so no later reader mistakes R8a for a
  total disjointness claim.

**Cross-adapter**

- **R9** — The shared port contract suite carries a directory-occupant `writeExclusive` row that
  **both** drivers pass, asserting `FILE_EXISTS` strictly (ADR-812).
- **R10** — `writeOrKeepArtifact` classifies a directory occupying `pack-<sha>.idx` as
  `PACK_ARTIFACT_MISMATCH` on the memory adapter **with no test-side patch of `writeExclusive`**.
- **R25** — The contract suite carries a row for each new refusal family that both drivers pass, at
  the strictness §5 justifies per row (strict code where the code is proven platform-independent,
  refusal-plus-non-destructiveness where it is not).

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
| W9 | `write` / `writeStream` / `appendUtf8` | **symlink** at the leaf (live or dangling) | `ELOOP` (open, `O_NOFOLLOW`) | `PERMISSION_DENIED` | requested | **writes** — key lands in `files` *and* `symlinks`; `lstat` still says symlink, `read` returns the new bytes, `readlink` returns the old target | **undecided — DC-I** |
| W10 | `writeExclusive` | empty directory (control) | `EEXIST` (open, `O_EXCL`) | `FILE_EXISTS` | requested | **writes** | `FILE_EXISTS` — ADR-810 |

**The four surfaces really are one guard.** `writeStream` (`memory-file-system.ts:93–104`) and
`writeUtf8` (`:116–118`) both end in `await this.write(...)`; `appendUtf8` (`:120–123`) calls
`readExistingUtf8` — a pure `files.get` + `TextDecoder` that mutates nothing — then `writeUtf8`. So a
single guard at the top of `write` covers all four, and `appendUtf8`'s observable is a clean
`PERMISSION_DENIED` with no partial read and no partial write.

#### §1e The `rename` matrix — composed adapters, both sides

The matrix ADR-815 requires before implementation. Same construction as §1d.

**Notation.** POSIX's invalid-argument errno is written `INVALID-ARGUMENT` throughout this document.
Its real six-letter name is not in `cspell.json` — its siblings `EEXIST`, `EISDIR`, `ELOOP`,
`ENOENT`, `ENOTDIR` and `ENOTEMPTY` all are — and this design commit is scoped to a single file, so
adding the dictionary entry is an implementation-phase chore (§Gates), never a `cspell:disable`
comment. It is the errno POSIX defines for *"an attempt was made to make a directory a subdirectory
of itself"*. `mapErrno` has **no case for it**, so it falls to the `default` arm, which forwards the
raw errno name verbatim as `reason` — the `reason` string on that error *is* the errno's real name.

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
| N11 | directory | a path **inside itself** that is **absent or a directory** (direct child, deep child with a missing mid segment, existing empty dir, existing non-empty dir — all four probed) | `INVALID-ARGUMENT` | `UNSUPPORTED_OPERATION` (`operation: 'filesystem'`, `reason: 'INVALID-ARGUMENT'`, **no `path` field**) | — | **succeeds** — `/repo/src.d` disappears from `directories` while `/repo/src.d/inner` remains: `lstat(src)` throws `FILE_NOT_FOUND` yet `readdir(src/inner)` works | **undecided — DC-H** |
| **N11b** | directory | a path **inside itself** that **exists as a non-directory** (regular file or symlink, at any depth) | **darwin `ENOTDIR` · linux `INVALID-ARGUMENT`** | **darwin `NOT_A_DIRECTORY` (`src`) · linux `UNSUPPORTED_OPERATION`/`INVALID-ARGUMENT`** | darwin `src`, linux none | **succeeds** — the directory key lands on the file key *and* the subtree is re-parented under it | **undecided — DC-H; the only platform-divergent row in this design** |
| N12 | the containment **root** | a fresh name inside it | `INVALID-ARGUMENT` | `UNSUPPORTED_OPERATION` / `INVALID-ARGUMENT` | — | **succeeds** — the root vanishes from `directories` (`lstat(rootDir)` now throws `FILE_NOT_FOUND`) and the **entire repository is silently re-keyed one level deeper** under `dst`. The adapter is not bricked — the next write re-creates the root through `addDirectoryRecursive` — it is relocated, which is quieter and worse | **undecided — DC-H** |
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
ADR-811 ruled on for the depth-1 ancestor case. It also decides a *clause-ordering* question inside
the guard (§3c), which is why it belongs to **DC-H** rather than being settled here.

**Windows is a different question again and is NOT verified here.** No Windows host was available,
and node's `fs.rename` on Windows goes through `MoveFileExW`, not `rename(2)`. The unit project — and
therefore the contract suite — runs on `windows-latest`. §5 and **DC-J** carry the consequence;
nothing in this section may be read as a Windows claim.

#### §1f The browser adapter — derived, not executed

`BrowserFileSystem` has no OPFS fake (`test/unit/adapters/browser/` holds one
`'atomicRename' in sut` capability test and nothing else), so Playwright is the only oracle and
everything below is derived from the adapter source plus the WHATWG File System Standard's normative
rejections:

> *"If child is a directory entry: Reject result with a `TypeMismatchError` DOMException"* (`getFileHandle`)
> *"If child is a file entry: Reject result with a `TypeMismatchError` DOMException"* (`getDirectoryHandle`)
> *"If options['create'] is false: Reject result with a `NotFoundError` DOMException"*

**`writeExclusive` — ADR-814, ratified.** `assertDoesNotExist` (`browser-file-system.ts:273–286`)
catches every non-`TsgitError` rejection and `return`s, reading `TypeMismatchError` as *"not found,
safe to create"*. Control reaches `dir.getFileHandle(leaf, { create: true })`, which rejects with
`TypeMismatchError` again — and **that one escapes unmapped**. A caller sees a bare `DOMException`;
`errorDataCode(err)` returns `undefined` and `writeOrKeepArtifact` rethrows instead of raising
`PACK_ARTIFACT_MISMATCH`. ADR-814 fixes this and pins it in `test/browser/opfs-roundtrip.spec.ts`.

**`write` (and `writeStream`, `writeUtf8`, `appendUtf8`) — derived here.** All four route through
`resolveFileHandle(path, /* create */ true)` (`:226–237`), whose `catch` maps every non-`TsgitError`
rejection to `fileNotFound(path)`. A directory at the leaf therefore surfaces as **`FILE_NOT_FOUND`**
— a *mapped but wrong* code where node and the memory target say `PERMISSION_DENIED`. Nothing is
written: `createWritable()` is never reached. A regular file at an ancestor segment takes the same
route through `walkToParent`'s `getDirectoryHandle(..., { create: true })` and also reports
`FILE_NOT_FOUND`.

**`rename` — derived here.** `rename` (`:153–162`) is `read(src)` → `write(dst, data)` → `rm(src)`.
A directory `src` fails at `read` (its `getFileHandle` hits `TypeMismatchError`) → `FILE_NOT_FOUND`;
a directory `dst` fails at `write` → `FILE_NOT_FOUND`, and `rm(src)` never runs. So the browser
adapter **never corrupts** on any §1e arrangement and never leaves a half-move — it reports the wrong
code, in contract.

**Why this is materially milder than ADR-814's case**, and why the fix is *not* the same size:

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

This is **DC-G**. Note the harness page (`test/browser/index.html`) exposes only three adapters on
`window.__tsgit.adapters`, but `BrowserFileSystem` is a public export of
`/dist/esm/adapters/browser/index.js`, so a Playwright case can reach it with a dynamic `import()`
inside `page.evaluate` without touching the harness page.

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
repository is silently re-keyed one level deeper instead. That row is DC-H's, not this section's.

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

#### §2d Two routes to `files ∩ symlinks` this change does not close

Probed, so they are stated rather than assumed:

1. **`write` over a symlink leaf** (§1d row W9). `files.set` lands beside the surviving `symlinks`
   entry. `lstat` still reports a symlink (it consults `symlinks` first), `readlink` still returns
   the old target, but `read` returns the newly written bytes. **DC-I.**
2. **Constructor seeding.** `MemoryFileSystem({ rootDir: '/repo', files: { '/repo/a/b': …, '/repo/a': … } })`
   seeds in `Object.entries` order: `/repo/a/b` makes `/repo/a` a directory, then
   `files.set('/repo/a')` collides — `lstat('/repo/a')` reports a file while `readdir('/repo/a')`
   throws `NOT_A_DIRECTORY`. The reverse order throws `NOT_A_DIRECTORY` at construction, so only one
   of the two orders is a hole; `{ files: { '/repo': … } }` is the same hole at depth 0. This is a
   *fixture-authoring* route reachable only from test code, not from the port surface, and the sweep
   found **zero** occurrences across 15 929 unit + parity tests. Named in §Out of scope, not fixed.

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

#### §3b `write` — ADR-815

```ts
write = async (path: string, data: Uint8Array): Promise<void> => {
  const normalized = this.resolve(path);
  if (this.directories.has(normalized)) throw permissionDenied(path);   // node: EISDIR
  this.ensureParentDirs(normalized);
  this.files.set(normalized, data.slice());
  this.touch(normalized);
};
```

One added line, four surfaces (§1d). `rootDir ∈ directories`, so W3 is covered without a second
clause.
The guard sits **before** `ensureParentDirs`, which keeps the ancestor-fault behaviour ADR-811
ratified: when a file blocks an ancestor, the leaf itself is in no namespace, the guard falls
through, and `addDirectoryRecursive` throws `NOT_A_DIRECTORY` carrying the ancestor — unchanged, and
the existing case at `memory-file-system.test.ts:452` still passes.

Whether this guard also names `symlinks` is **DC-I**. If it does, the code is the same
`PERMISSION_DENIED` on both adapters (node maps `ELOOP` and `EISDIR` to it alike), so the extension
is one term: `if (this.directories.has(n) || this.symlinks.has(n))`.

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
  if (dst.startsWith(`${src}/`)) throw /* shape + position: DC-H */; // N11 / N11b / N12
  if (!this.directories.has(dst)) {
    if (this.files.has(dst) || this.symlinks.has(dst)) {
      throw notADirectory(reported);                                 // N4 / N5 / N6
    }
    return;                                                          // N23 / N24
  }
  if (this.hasChildren(dst)) throw directoryNotEmpty(reported);      // N8 / N9 / N10 / N16
}                                                                    // else N7 — empty dst, replace
```

**The `dst`-inside-`src` clause's *position* is itself a decision, not a detail.** As drafted it
precedes the file/symlink clause, which reproduces **linux** on N11b and contradicts **darwin**;
moving it below reproduces darwin and contradicts linux. Every other ordering is equivalent because
the arrangements are disjoint. §1e proves there is no third answer, so DC-H owns both the code and
the position.

`reported` is the caller's raw `src` string, matching node's `runFs(op, src)` anchoring. The
`hasChildren` helper already exists (`:488–501`) and is exactly the predicate node's `ENOTEMPTY`
expresses.

**Ordering is load-bearing in three further places** (the DC-H clause position above is the fourth):

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

Per row, then:

"Code after the change" is what **both** adapters produce once the guards land — memory today
produces nothing at all on most of these rows.

| Row | Code after the change | Platform risk | Contract strictness |
|---|---|---|---|
| `writeExclusive` → directory occupant | `FILE_EXISTS` | none — `O_EXCL`/`EEXIST` is universal, and the existing strict `writeExclusive`-over-a-file row already passes Windows CI | **strict** (ADR-812) |
| `writeExclusive` → file at a grandparent segment | `NOT_A_DIRECTORY` | none (`mkdir -p` `ENOTDIR`; the depth-1 case is the adapter-dependent one and is excluded) | **strict, code only** (ADR-812) |
| `write` → directory at the leaf | `PERMISSION_DENIED` | **unverified on Windows** — libuv's directory-open mapping was not probed | **DC-J** |
| `rename` file → directory | `PERMISSION_DENIED` | **unverified on Windows** | **DC-J** |
| `rename` directory → regular file | `NOT_A_DIRECTORY` | **unverified on Windows** | **DC-J** |
| `rename` directory → non-empty directory | `DIRECTORY_NOT_EMPTY` | **unverified on Windows** | **DC-J** |
| `rename` directory → **empty** directory (positive, R20) | it succeeds | **unverified on Windows** — `MoveFileEx`'s replace-existing flag is documented not to replace directories, so this is the likeliest Windows failure | **DC-J** |
| `rename` src === dst, **regular file** (positive, R21) | it succeeds | none | **strict** (positive row, no code asserted) |
| `rename` src === dst, **non-empty directory** (positive, R21) | it succeeds | **unverified on Windows** — same `MoveFileEx` question as the R20 row | **DC-J** |
| `rename` symlink → directory, directory → symlink | `PERMISSION_DENIED` / `NOT_A_DIRECTORY` | — | **no contract row.** ADR-812's reasoning applies verbatim: the file gates symlink behaviour per adapter through a capability hook, and a row that happens to agree without such a declaration would over-constrain a future adapter. These stay memory-side |
| `rename` dst inside src, dst absent or a directory (N11/N12) | `UNSUPPORTED_OPERATION` / `INVALID-ARGUMENT` | — | **no contract row** until DC-H is settled; the `reason: 'INVALID-ARGUMENT'` string is a node errno and would over-constrain any adapter |
| `rename` dst inside src, dst an existing file or symlink (N11b) | **darwin and linux disagree** | **proven POSIX-divergent** | **never a strict contract row**, under any DC-H outcome. Memory-side only, where the code is whatever DC-H picks |

Every row marked **DC-J** is proven on the memory side regardless — strictly, since memory has no
platform, and for the two positive rows by asserting the outcome rather than a code. The open
question is only what the *node-side* assertion looks like and where it lives.

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

---

## Decision candidates

### Settled by the decisions phase — folded into the design above

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

### New — raised by this revision, not settled by ADRs 810–815

| # | Choice | Alternatives (≤3) | Recommendation | Why |
|---|---|---|---|---|
| **DC-G** | Browser `write` (and its three delegating siblings) and `rename` report **`FILE_NOT_FOUND`** for a directory occupant where node and the memory target say `PERMISSION_DENIED` (§1f — derived from the adapter source + the normative WHATWG spec, not executed). ADR-814 covers `writeExclusive` only and explicitly defers this | **1.** Out of scope: record the derivation here and change nothing. **2.** Fix in this PR — give `resolveFileHandle` a `create: true`-only arm mapping `TypeMismatchError` to `permissionDenied(path)`, leaving the `create: false` mapping untouched — and pin it with **two** new cases in `test/browser/opfs-roundtrip.spec.ts` (one `write`, one `rename`). **3.** Fix with no end-to-end pin. | **1** | This is deliberately a *different* verdict from ADR-814's, for two reasons the derivation makes concrete. **(a) The failure differs in kind, not just degree.** ADR-814's defect put the browser *outside* the port's error contract — a bare `DOMException` defeats `errorDataCode` and turns a `PACK_ARTIFACT_MISMATCH` into an opaque throw. This one stays inside it: a structured `TsgitError`, wrong code, **no corruption and no half-move** (`createWritable` is never reached; `rm(src)` never runs). A sweep of `src/application` + `src/repository` found no production caller branching on `FILE_NOT_FOUND` after a write or a rename. **(b) The fix's blast radius is much larger.** `assertDoesNotExist` has exactly one caller; `resolveFileHandle` has nine, and **`stat` and `exists` depend on its current mapping** — `stat` catches `FILE_NOT_FOUND` and falls back to `resolveDirHandle`, so a helper-wide re-map would make `stat` on a directory rethrow instead of falling back, a strictly worse bug. Option 2 is therefore only safe as a conditional inside the adapter's most-shared helper, in the one adapter outside both the coverage and the mutation gates. **Cost of option 1 to weigh:** the port's cross-adapter guarantee stays partly false on the browser after this PR closes it everywhere else, and re-opening it later costs a second Playwright round. Option 3 ships an unverified behaviour change to the ungated adapter — the least defensible |
| **DC-H** | `rename` where **`dst` is inside `src`** (§1e N11 / N11b / N12) — the one family ADR-815's text does not reach, and the one row in this design where **the two POSIX platforms disagree**. Node throws `UNSUPPORTED_OPERATION` (`operation: 'filesystem'`, `reason: 'INVALID-ARGUMENT'`, **no `path` field** — `INVALID-ARGUMENT` is not in `mapErrno`'s switch, so it hits the `default` arm), *except* when `dst` already exists as a file or a symlink, where darwin says `NOT_A_DIRECTORY` and linux says `UNSUPPORTED_OPERATION`. Memory today re-parents the subtree under its own descendant, leaving `lstat(src)` throwing `FILE_NOT_FOUND` while `readdir(src/inner)` works; `rename(rootDir, x)` silently relocates the whole repository one level deeper | **1.** One clause, placed **before** the file/symlink check: `unsupportedOperation('rename', <the invalid-argument errno name>)` for every dst-inside-src arrangement (the literal string is that errno's real name, not this document's stand-in spelling). Matches linux exactly, matches darwin on N11 and N12 and diverges from it on N11b. **2.** Same clause placed **after** the file/symlink check, so an existing file or symlink at `dst` yields `notADirectory(src)` first. Matches darwin exactly, diverges from linux on N11b. **3.** Out of scope: ADR-815 names "a directory occupies the destination" and "source and destination differ in kind", and this is neither; leave the corruption in place | **1** | Option 3 is the honest reading of ADR-815's *letter* and is flagged as available — but it leaves the only arrangements in the whole matrix that produce a **structurally incoherent tree** (a directory reachable only through a parent that reports `FILE_NOT_FOUND`), and N12 is reachable from `rename(rootDir, x)`, a one-argument mistake, with no error at all. Between 1 and 2 there is no correct answer — §1e proves node is not self-consistent across platforms, which is precisely the situation ADR-811 resolved by picking one behaviour and documenting the divergence rather than chasing an oracle that does not exist. **Option 1 over option 2 because linux is the CI platform that gates every merge**, so the strict-code assertion has a home that actually runs (DC-J), and because `INVALID-ARGUMENT` is the *specific* diagnosis while `ENOTDIR` is the incidental one darwin reaches first. **Costs to weigh, both real:** `UNSUPPORTED_OPERATION` carries no `path`, so a caller cannot name what failed; and importing an errno name as a string literal into an adapter that has no errnos is the same species of borrowing ADR-811 rejected for `mkdir -p`. Whichever is chosen, **N11b can never be a strict cross-adapter contract row** and its memory-side row is strict only because memory has no platform |
| **DC-I** | `write` / `writeStream` / `writeUtf8` / `appendUtf8` over a **symlink leaf** (§1d row W9). Node refuses with `PERMISSION_DENIED` (`ELOOP` from `O_NOFOLLOW`); memory writes a `files` key beside the surviving `symlinks` key, so `lstat` says symlink, `readlink` returns the old target, and `read` returns the new bytes. This is **R8b** — the reason R8 could not be restated as a total disjointness claim | **1.** Extend the §3b guard by one term: `if (this.directories.has(n) \|\| this.symlinks.has(n)) throw permissionDenied(path)`. Node maps both `EISDIR` and `ELOOP` to `PERMISSION_DENIED`, so **one code covers both occupants** and it is the same contract row. **2.** Out of scope — ADR-815 says "a directory occupant" and "a file entry on a name held by a directory"; a symlink is neither. **3.** Refuse the symlink case in `write`/`writeStream`/`writeUtf8` but leave `appendUtf8` alone, since it is the only one that reads first | **1** | The marginal cost is one `\|\|` term and one unit row per surface, in a guard being added anyway, and it is the only way R8a can be stated without an embarrassing footnote: `symlinks ∩ directories = ∅` gets closed by the `rename` guard in the same PR, so leaving `files ∩ symlinks` open means this change closes two thirds of an invariant and documents the third. The adapter already has the in-house precedent — `openWithNoFollow` (`:375–385`) refuses a symlink leaf with exactly `permissionDenied`, citing `O_NOFOLLOW`. **Cost to weigh:** it is scope growth beyond ADR-815's text, and it makes `write` refuse something that silently succeeds today — the regression sweep found **zero** memory-backed call sites (`WRITE_ONTO_SYMLINK`: 0 hits across 15 929 unit + parity tests), so the risk is measured, not assumed. Option 3 is incoherent — the four surfaces are one code path by delegation — and is listed only to be rejected |
| **DC-J** | How the **node-side** assertion for the new `write` and `rename` refusals is written, given that `test/unit/ports/file-system.contract.ts` runs on `windows-latest` while §1e verified only darwin + linux | **1.** Strict codes in the contract suite; if Windows disagrees, CI is the oracle and the implementer converts the offending row to the `:567` enumerated-pair precedent. **2.** Contract rows in the `:676` precedent — assert `TsgitError` **plus non-destructiveness**, no code — and put the strict node-side codes in a new `test/integration/posix-only/` file, which the `posix-integration` CI job already runs on ubuntu + macos only (`ci.yml:393–395`). **3.** Contract rows in the `:676` precedent only; the strict codes live on the memory side alone, and §1e's matrix is the sole record of node's | **2** | Option 1 designs a claim that cannot be supported here: `MoveFileExW` is documented not to replace an existing directory, so the **R20 positive row** is the likeliest Windows failure — and a positive row failing is not something a tolerant code list can absorb. Guessing and letting CI correct it burns a full matrix round and puts an unverified assertion in a committed design. Option 2 is the only one that keeps a strict node-side code *somewhere* while honouring the rule that a platform-unverified code cannot be a strict cross-platform row, and the home already exists and is already wired into CI — the cost is one new file, not new infrastructure. Its price: the cross-adapter proof for these rows becomes two-file (the contract suite proves *both refuse and neither corrupts*; the posix-only file proves *node's exact code*), which is more moving parts than ADR-812 envisaged for `writeExclusive`. Option 3 is cheapest and leaves node's `rename` codes asserted nowhere — every future node-side change to them would be caught only by this document |

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

**`write` and its delegates — `describe('write over a directory')`**

| Req | Given | When | Then |
|---|---|---|---|
| R12 | an empty directory occupies the target path | `write` | throws `PERMISSION_DENIED` carrying the requested path; `lstat` still reports a directory |
| R13 + R22 | a directory holding a child file occupies the target path | `write` | throws `PERMISSION_DENIED`; `readdir` still lists the child and the child reads back byte-identical |
| R14 | the target path is the adapter's root directory | `write` | throws `PERMISSION_DENIED`, and a later write elsewhere still succeeds |
| R15 | an empty directory occupies the target path | `writeUtf8` | throws `PERMISSION_DENIED` |
| R15 | an empty directory occupies the target path | `writeStream` | throws `PERMISSION_DENIED` |
| R15 | a directory holding a child occupies the target path | `appendUtf8` | throws `PERMISSION_DENIED`, and the child is unchanged (nothing was read or written first) |
| R16 | a regular file occupies the target path | `write` | overwrites, and reads back the new bytes |
| DC-I | a symlink occupies the target path | `write` | *(only under DC-I option 1)* throws `PERMISSION_DENIED`, and `readlink` still returns the original target |

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
| R19 | a directory at src and dst = src's own **parent** | `rename` | throws `DIRECTORY_NOT_EMPTY` carrying src — not the DC-H code, because a parent is not inside its child |
| R20 | a directory with children at src and an **empty directory** at dst | `rename` | succeeds; every child is reachable under dst and none under src |
| R21 | a **regular file**, src === dst | `rename` | resolves; the bytes are unchanged |
| R21 | a **non-empty directory**, src === dst | `rename` | resolves; every child is still reachable (the clause that would otherwise refuse) |
| R23 | a file at src and a directory at dst | `atomicRename` | throws `PERMISSION_DENIED` carrying src — proves the delegation, not a second guard |
| R24 | absent src | `rename` | throws `FILE_NOT_FOUND` carrying src *(existing case at `:431`, retained)* |
| R27 | a directory at src and an **absent** dst inside src | `rename` | *(shape depends on DC-H)* refuses, and src's subtree is intact |
| R27 | a directory at src and an **existing non-empty directory** dst inside src | `rename` | *(shape depends on DC-H)* refuses, and both levels are intact |
| R27 (N11b) | a directory at src and an **existing regular file** dst inside src | `rename` | *(shape and clause order depend on DC-H)* refuses, and the file is unchanged. **Memory-only** — POSIX-divergent, so it can never be a contract row |
| R27 | src = the adapter's **root**, dst inside it | `rename` | *(shape depends on DC-H)* refuses, and `lstat(rootDir)` still reports a directory |

R3 / R14 (the `rootDir` cases) are memory-specific: node's root is a real directory the contract
driver cannot reasonably occupy, so they have no contract counterpart.

### New shared contract rows

`test/unit/ports/file-system.contract.ts`, in that file's existing 1-level
`it('Given …, When …, Then …')` style, run by **both** drivers. Strictness per §5; the DC-J rows are
written once that candidate is settled.

| Req | Row | Strictness |
|---|---|---|
| R9 | `Given an existing directory, When writeExclusive, Then throws FILE_EXISTS` | **strict**, via `assertFileExists` (`:88`) |
| — | `Given a file at a grandparent path segment, When writeExclusive, Then throws NOT_A_DIRECTORY` | **strict on the code**, via `assertNotADirectory` (`:93`), which asserts no `data.path`. Depth ≥ 2 only; an in-file comment records that depth 1 is adapter-dependent |
| R25 | `Given a directory at the target path, When write, Then it refuses and the directory is intact` | **DC-J** |
| R25 | `Given a directory at the destination, When rename, Then it refuses and neither side moves` | **DC-J** |
| R25 | `Given a directory source and a file destination, When rename, Then it refuses and neither side moves` | **DC-J** |
| R25 | `Given a directory source and a non-empty directory destination, When rename, Then it refuses and neither tree merges` | **DC-J** |
| R20 | `Given a directory source and an empty directory destination, When rename, Then the subtree lands at the destination` | **DC-J** — the row most at risk on Windows |
| R21 | `Given src === dst, When rename, Then it resolves and the entry is unchanged` — one file case, one non-empty-directory case | **strict** (positive rows; no code asserted, no platform risk) |

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

### Node-side strict rows *(only under DC-J option 2)*

A new `test/integration/posix-only/node-file-system-write-refusals.test.ts`, run by the
`posix-integration` project on ubuntu + macos only, constructing `NodeFileSystem` over a `mkdtemp`
root the way the unit driver does. One case per §1d/§1e row that DC-J pulls out of the contract
suite, asserting `data.code` **and** `data.path` — including the two anchoring oddities node exhibits
and this design deliberately does not fix (N18's `FILE_EXISTS` carrying **src**, N19's
`NOT_A_DIRECTORY` carrying **dst**), so a future refactor of `runFs` anchoring cannot move them
silently.

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
| `:515` `addDirectEntry` pairwise disjoint | same | **KEEP as written** |
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
| `src/ports/file-system.ts` `write` / `writeStream` / `writeUtf8` / `appendUtf8` JSDoc | *"Overwrites if exists"* → overwrites a **regular file**; refuses a directory with `PERMISSION_DENIED` (R26) | implementation |
| `src/ports/file-system.ts` `rename` / `atomicRename` JSDoc | the §1e kind matrix in one sentence, plus `data.path === src` on every refusal (R26) | implementation |
| `docs/design/ports-and-adapters.md:561` | the `writeExclusive` line that codified the narrow reading | docs phase, ADR-813 |
| `docs/design/ports-and-adapters.md:565` | the `rename` line — *"Delete old key + insert new key"* is now an incomplete description of the guarded method | docs phase |
| `docs/design/ports-and-adapters.md` memory bullet list | has no `write` bullet at all; add one naming the directory refusal | docs phase |
| `docs/use/errors.md:42` `FILE_EXISTS` | *"Write attempted with `wx` flag against an existing file"* → anything occupying the path (file, directory, or symlink including a dangling one) | docs phase |
| `docs/use/errors.md:46` `PERMISSION_DENIED` | add: a non-exclusive write whose leaf is a directory, and a `rename` that would replace a directory with a non-directory | docs phase |
| `docs/use/errors.md:41` `DIRECTORY_NOT_EMPTY` | *"A directory delete on a non-empty target"* → also a `rename` whose destination is a non-empty directory | docs phase |
| `docs/use/errors.md:44` `NOT_A_DIRECTORY` | *"Directory operation against a non-directory"* → also a `rename` of a directory onto a non-directory | docs phase |

### Gates

Per-part: `npx vitest run <touched test files>`, `npm run check:types`,
`./node_modules/.bin/biome check <touched files>`, `npx cspell --no-progress <touched files>` **bare**
(the wireit-cached scripts report `Ran 0 scripts and skipped 1`, which reads exactly like a pass).
Phase: `npm run validate`, run bare into a file with the exit code read from that file — never
through a pipe, never `--no-verify`. `npm outdated` is re-measured before the full gate (eight
excepted packages, `.claude/workflow.md`).

Coverage stays at 100 % on `src/adapters/memory/**`; the mutation gate covers it too
(`stryker.config.mjs` mutates all of `src` except `index.ts`, `*.d.ts` and
`src/adapters/browser/**`). The ADR-814 browser fix — and anything taken under DC-G — is outside both
gates and is proven only by the Playwright cases, which need `npx playwright install` and a local run
before the PR.

**Three gates the first pass did not name.** The contract suite runs on the `windows-latest` unit
matrix cell, so a red Windows job is the expected failure mode if DC-J option 1 is taken.
`test/integration/posix-only/**` is a *separate CI job* (`ci.yml:393`), not part of
`npm run test:integration` — a new file there must be run explicitly with
`npx vitest run --project posix-integration`. And if DC-H lands option 1 or 2, the memory adapter
will carry POSIX's invalid-argument errno as a string literal, so **`cspell.json` gains that one
word** in the implementation commit that introduces it — a dictionary entry, next to the six errno
siblings already listed there, never a `cspell:disable` comment.

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
- **Constructor-seeded namespace collisions** (§2d route 2). Reachable only from test fixtures, not
  from the port surface; the sweep found zero occurrences. Closing it means either ordering the
  seeded entries or checking `directories` before `files.set` in the constructor loop — a change to a
  test-facing API with no production caller.
- **`write-object.ts`'s treatment of a directory occupant as "we already have this object".** Once
  memory refuses, both adapters take the `isFileExists` arm and return the oid **without the object
  being written** — a pre-existing question about the *caller*, identical on node today, and not
  created by this change.
- **A `test/parity/` scenario.** A slot *does* exist — the brief's premise was wrong and §5 corrects
  it — but ADR-812 records the decision to add none, because every registered scenario also runs
  against real OPFS in `test/browser/parity.spec.ts`.
- **Browser `rm` on a non-empty directory.** Derived alongside §1f: `removeEntry` without `recursive`
  rejects with `InvalidModificationError`, which the bare `catch` at `browser-file-system.ts:146–150`
  maps to `FILE_NOT_FOUND` where node gives `DIRECTORY_NOT_EMPTY`. Same class as DC-G, a third
  method, not opened here.
- **A `BACKLOG.md` tick.** This is not a backlog item.
- **Anything under DC-G, DC-H, DC-I or DC-J the user declines.** All four are honest scope questions
  raised by the pinned matrices; none is assumed.
