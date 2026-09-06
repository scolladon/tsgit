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
> codes (ADR-819).
> **Scope after the Windows probe (this revision):** ADR-819's accepted failure mode fired — two
> shared contract rows are red on the three `windows-latest` unit cells. The user settled the
> answer directly, and it is not a candidate: *"Way 1 is the much cleaner way and it is what our
> architecture allows us easily."* The **node adapter emulates POSIX `rename(2)` kind rules and the
> exclusive-create symlink verdict on Windows**, behind the `PathPolicy` / `FsOperations` seam,
> inside this PR; the two red rows must pass on `windows-latest` unchanged. §8 designs that leg
> against a three-OS probe of the adapter *and* of real `git`.
> **Scope after the third decisions round (this revision):** the six candidates that leg raised are
> settled — ADR-820 (a fourth `PathPolicy` flag, `honoursRenameKinds`), ADR-821 (the enumerated
> root-rename pair), ADR-822 (the Windows ancestor shapes documented and pinned), ADR-823 (the
> scoped atomicity claim), ADR-824 (every `write` / `rename` refusal row in the shared contract
> suite asserts its exact code, superseding ADR-819's tolerant clause) and ADR-825 (the replace arm
> removes the destination with `rmdir` and lets `mapErrno` translate the failure). A second probe
> run closed two of the three measurement gaps §8i named, and §8 is rewritten against it.
> Status: draft → self-reviewed ×3 → accepted (ADRs 810–815) → revised (write + rename folded in)
> → self-reviewed ×3 → accepted (ADRs 816–819) → revised (browser write/rename folded in)
> → self-reviewed ×3 → three review cycles folded in → revised (Windows leg folded in)
> → self-reviewed ×3 → accepted (ADRs 820–825) → revised (Windows decisions folded in)
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
| **ADR-812** cross-adapter proof lives in the contract suite | Settles DC-C. Strict codes, no `test/parity/` scenario, no symlink-occupant row. **Refined by ADR-819** for the two new surfaces: `writeExclusive` stays strict, `write`/`rename` do not |
| **ADR-813** the port comment names every occupant shape | Settles DC-D. Rewrite the `writeExclusive` JSDoc; correct `ports-and-adapters.md:561` |
| **ADR-814** browser maps a directory occupant to `FILE_EXISTS` | Settles DC-E for `writeExclusive` **only**. Its `assertDoesNotExist` narrowing and ADR-816's `resolveFileHandle` arm share one `TypeMismatchError` predicate → §3f |
| **ADR-815** non-exclusive `write` and `rename` refuse a directory occupant | Settles DC-F as **option 3**, against the design's recommendation. Required the `rename` matrix *before* implementation → §1e |
| **ADR-816** browser `write`/`rename` map a directory occupant to `PERMISSION_DENIED` | Settles DC-G as **option 2**, against the design's recommendation. `resolveFileHandle` gains a `create: true`-**only** arm; the `create: false` mapping `stat`/`exists` depend on is untouched; two Playwright cases pin it → §1f, §3f |
| **ADR-817** `rename` into itself refuses **before** the destination-kind check | Settles DC-H as **option 1**. One clause throwing `unsupportedOperation('filesystem', <the invalid-argument errno>)`, matching linux; darwin's `NOT_A_DIRECTORY` on the one divergent arrangement is a knowing divergence → §3c |
| **ADR-818** non-exclusive writes refuse a **symlink** leaf | Settles DC-I as **option 1**. The `write` guard is two terms, so `files`/`directories`/`symlinks` become pairwise disjoint under every port call → §3b, R8a |
| **ADR-819** node's strict codes live in the posix-only suite | Settles DC-J as **option 2**. Its tolerant-row clause is **superseded by ADR-824**; what survives is the posix-only file as the home of the node codes the contract suite does not carry, and the strict `writeExclusive` rows → §5. Its Context sentence about `MoveFileExW` is measured **false** and its accepted failure mode has **fired** → §8c |
| **ADR-820** a fourth `PathPolicy` flag gates the emulation | Settles DC-K as **option 1**. `honoursRenameKinds` — `true` on `posixPolicy`, `false` on `windowsPolicy`, set through `PathPolicyCapabilities`; `honoursNoFollow` is not overloaded and `isSymlinkLeaf`'s equivalence note stands → §8e, **R48** |
| **ADR-821** the root-rename row accepts both codes POSIX allows | Settles DC-M as **option 1**. The posix-only N15 row asserts `PERMISSION_DENIED` **or** `DIRECTORY_NOT_EMPTY` plus non-destructiveness, with a comment naming the axis; memory keeps `PERMISSION_DENIED` → §8g, **R46** |
| **ADR-822** the Windows ancestor-fault shapes are documented, not normalised | Settles DC-N as **option 1**. N19 and N20 are pinned in their Windows shapes in the win-only file and the `rename` JSDoc calls the ancestor report adapter- **and** platform-chosen → §6, §8h, **R47**, **R49** |
| **ADR-823** `atomicRename` is atomic where the platform renames in one step | Settles DC-O as **option 1**. The JSDoc scopes the claim rather than dropping it; the emulated replacement is two steps, as git's own is → §6, §8d, **R42** |
| **ADR-824** the contract suite's `write`/`rename` refusal rows assert exact codes | Settles DC-P as **option 3**, user-ratified. Four rows go strict; `assertRefusedWithoutCode` loses its callers and is deleted; supersedes ADR-819's tolerant clause and refines ADR-812 → §5, **R25** |
| **ADR-825** the replace arm removes the destination first | Settles DC-L as **option 2**, user-ratified through *"the measurement decides"*. `rmdir(dst)` inside the same errno-mapped operation, `ENOTEMPTY` → `DIRECTORY_NOT_EMPTY(src)` through `mapErrno`, `readdir` never called → §8d, **R50** |
| **ADR-046** the `PathPolicy` abstraction | The seam the Windows emulation is gated on. Its capability flags are independent *by doctrine* — *"each say exactly what they gate … instead of one flag standing in for all three"* — which is why §8e adds a fourth rather than overloading `honoursNoFollow` (DC-K → ADR-820) |
| **ADR-047** `FsOperations` dependency injection | The seam the Windows arm is *tested* through: `windowsPolicy` plus a fake `FsOperations` reaches every branch on any host, which is how the linux mutation runner reaches Windows-only code at all → §8h |
| **ADR-043** errno-mapping placement | The precedent for where a platform discriminator lives: `mapErrno` stays a pure errno lookup and the platform-specific decision sits at the call site holding its inputs. §8d and §8f both follow it |
| **ADR-041 / ADR-048** Windows testing strategy, platform-segregated test folders | Why the strict Windows codes go in `test/integration/win-only/` rather than in the cross-platform contract suite → §8h |
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

**Numbers are stable identifiers, not an ordering.** R28–R32 were added by the second decisions
round, R37–R47 by the Windows revision and R48–R50 by the third decisions round; each sits in the
block it belongs to rather than at the end, so cross-references from the ADRs and from §1–§8 keep
pointing at the same statements. Two earlier statements were **rewritten in place** rather than
renumbered, because the record they carry is superseded and a second number for the same obligation
would leave the old one live: **R25** (the contract rows are strict now, ADR-824) and **R46** (the
root-rename row asserts the enumerated pair, ADR-821).

The Windows block below is the one part of this document that constrains the **node** adapter's
behaviour. Everything above it still holds: R1–R36 are memory- and browser-side.

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
- **R25** *(ADR-824, superseding ADR-819's tolerant clause)* — The contract suite carries a row for
  each new `write` / `rename` refusal family that both drivers pass, asserting the **exact**
  `data.code` **plus non-destructiveness**: `PERMISSION_DENIED` for a non-exclusive write onto a
  directory and for a non-directory renamed onto a directory, `NOT_A_DIRECTORY` for a directory
  renamed onto a regular file, `DIRECTORY_NOT_EMPTY` for a directory renamed onto a non-empty
  directory. The instance-only helper `assertRefusedWithoutCode` has no callers afterwards and is
  deleted in the same change — a helper nothing calls is dead code. The `writeExclusive` rows stay
  strict (R9).
- **R32** *(ADR-819, narrowed by ADR-824)* — A new file under `test/integration/posix-only/` pins the
  **node** adapter's exact `data.code` (and `data.path` where the variant carries one) for every §1d
  / §1e row on which darwin and linux agree. It runs in the `posix-integration` project only. Four of
  those codes are now also asserted cross-adapter in the contract suite (R25); the posix-only rows
  stay, because they assert what the contract helpers do not — `data.path`, the `rootDir`
  arrangements, the symlink occupants, the delegating write surfaces, and the `reason` strings.

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

**Windows leg — the node adapter emulates POSIX kind rules (this revision)**

"Emulating platform" below means a `PathPolicy` whose new capability flag says the platform's own
`rename` does **not** enforce POSIX's kind rules — `windowsPolicy` today, and nothing else (§8e).
Every row id is a probe row from §8a.

- **R37** — On an emulating platform, `NodeFileSystem.rename` refuses a **directory** source onto a
  **regular file or a symlink** destination with `NOT_A_DIRECTORY` carrying `src`, **before** any
  `fsOps.rename`, and the destination is untouched — the file's bytes, or the link and its target
  (N4 / N5 / N6, where Windows today *replaces* the destination and loses it).
- **R38** — Same platform: a directory source onto a **non-empty directory** destination refuses
  with `DIRECTORY_NOT_EMPTY` carrying `src`, and neither tree moves or merges (N8 / N9 / N10 / N16,
  today `PERMISSION_DENIED`). The refusal is the destination `rmdir`'s own `ENOTEMPTY` translated by
  `mapErrno` inside the operation's `runFs(…, src)` wrapper, not a code the arm chooses (R50).
- **R39** — Same platform: a directory source onto an **empty directory** destination **succeeds**,
  replacing it — the subtree lands at the destination and the source name is gone (N7, today
  `PERMISSION_DENIED`). This is the row `test/unit/ports/file-system.contract.ts:494` asserts.
- **R40** — The emulation only ever *adds* a refusal or the replace. Every arrangement the platform
  already decides POSIX-shaped is delegated to its own `rename` untouched: `src === dst`
  (N21 / N22), a destination inside the source (N11 / N11b / N11c / N11d / N12 →
  `UNSUPPORTED_OPERATION` with the invalid-argument errno, which Windows already reports), a
  non-directory source (N1 / N2 / N3 / N13 / N14 / N15 / N25), an absent source (N17), a fresh
  destination (N23 / N24), and both ancestor-fault rows (N18 / N19 / N20).
- **R41** — Cost: **zero** extra syscalls on a non-emulating policy (the `async` verdict's own
  promise is the only allocation, ~30 ns against a ~97 µs rename); **one** `lstat` on an emulating
  policy for a non-directory source — every production caller; **two** for a directory source onto
  a fresh name; two `lstat` plus one `realpath` plus one `rmdir` for a directory onto a directory.
- **R42** *(ADR-823)* — `atomicRename` inherits R37–R41 by delegation. The replace arm (R39) is two
  syscalls — `rmdir` then `rename` — so the port's *"no observer ever sees an intermediate state"*
  claim is **scoped**, not dropped: it holds for every arrangement on a non-emulating platform and
  for every non-replace arrangement on an emulating one. If the destination is filled between the
  two steps the `rmdir` fails and the caller sees `DIRECTORY_NOT_EMPTY` — the same refusal the
  arrangement would have produced — so the window degrades into the correct answer, and the only
  loss it can cause is an empty directory removed before a rename that then fails.
- **R43** — The parent-realpath cache is cleared even when the replace arm has already removed the
  destination and the following `rename` then fails.
- **R44** — `writeExclusive` over a **symlink** leaf, live or dangling, refuses with `FILE_EXISTS`
  carrying the requested path on **every** platform — including one whose `open(2)` ignores
  `O_NOFOLLOW`, where the adapter's own leaf `lstat` decides it (W13 / W13b, today
  `PERMISSION_DENIED` on Windows against `FILE_EXISTS` on POSIX). The link and its target are
  unchanged — and on a **dangling** link that means the target is still **absent**, which is the
  half the platform's own exclusive open gets wrong (§8f). The **non-exclusive** surfaces keep
  `PERMISSION_DENIED` on every platform (W7 / W8 agree on all three), so the two verdicts are pinned
  apart by a pair of rows.
- **R45** — `test/unit/ports/file-system.contract.ts:446` and `:494` pass on the `windows-latest`
  unit cells with **no arrangement edited and no assertion weakened**. That is the settled
  constraint. Three refusal rows in that file are additionally *tightened* to exact codes — the
  opposite move — under R25 / ADR-824, so R45 holds.
- **R46** *(ADR-821)* — `test/integration/posix-only/node-fs-write-rename-refusals.test.ts`'s "file
  renamed onto the containment root" row passes on **both** `posix-integration` cells, by accepting
  `PERMISSION_DENIED` **or** `DIRECTORY_NOT_EMPTY` and asserting non-destructiveness, with an
  in-file comment naming the axis that splits the two POSIX kernels. It is measured red on ubuntu
  today (§8g).
- **R48** *(ADR-820)* — `PathPolicy` carries a fourth capability flag, `honoursRenameKinds`, set
  through `PathPolicyCapabilities`: `true` on `posixPolicy`, `false` on `windowsPolicy`. It is the
  only thing the rename arm reads to decide whether to enforce the kind rules itself, so the arm is
  reachable through dependency injection on **every** host — which is what lets the linux mutation
  runner kill its mutants. `honoursNoFollow` is not overloaded to carry it, so `isSymlinkLeaf`'s
  carried equivalence note stays true of that method; every hand-built policy in the suite names the
  fourth flag, and the compiler points at each one.
- **R49** *(ADR-822)* — The two Windows ancestor-fault reports are **pinned in their Windows shape**
  rather than normalised: N19 refuses `NOT_A_DIRECTORY` carrying `src` where POSIX carries `dst`,
  and N20 refuses `FILE_NOT_FOUND` where POSIX refuses `NOT_A_DIRECTORY`. No adapter behaviour
  changes; a future change to either shape turns a pinned row red instead of drifting. Every path
  expectation in those rows is built with `node:path`, because the adapter reports joined paths and
  Windows joins with `\`.
- **R50** *(ADR-825)* — On an emulating platform, once two `lstat` probes have proved a directory
  source and a directory destination, the arm removes the destination with `rmdir` **inside the same
  errno-mapped operation as the rename** and renames on success. `readdir` is **never** called, on
  any branch. A non-empty destination fails the `rmdir` with `ENOTEMPTY`, which `mapErrno` turns
  into `DIRECTORY_NOT_EMPTY` carrying `src` (R38); every other `rmdir` errno passes through the same
  map — an `EACCES` on a locked destination surfaces as `PERMISSION_DENIED` carrying `src`, and no
  `rename` is issued.
- **R51** *(review round)* — On an emulating platform, `src` and `dst` are the same entry when
  their spellings are byte-identical, or when the two `lstat` results share a device and a
  non-zero inode (compared as bigints), or — when either side reports no inode — when their
  canonical paths agree; that arrangement delegates to the platform (a no-op), and a string
  compare decides only strict containment. A source whose leaf is an alias is canonicalised with
  `realpath` before the replace arm, so a destination inside it delegates too.
- **R52** *(review round)* — When the replace arm's `rename` fails after the arm removed the
  destination, the empty destination is recreated on a best-effort basis (default, parent-inherited
  permissions; an errno failure of the recreation is subordinate and not surfaced) before the
  failure is rethrown; a removal that finds the destination already gone (`ENOENT`) proceeds to
  the rename and, having removed nothing, recreates nothing.

**Documentation**

- **R11** — The `writeExclusive` JSDoc on `src/ports/file-system.ts` states the occupancy rule in
  terms of *anything at `path`*, not *"the file"* (ADR-813).
- **R26** — The port JSDoc for `write`, `writeStream`, `writeUtf8`, `appendUtf8`, `rename` and
  `atomicRename` states the directory-occupant refusal and its code. `write`'s current summary —
  *"Overwrites if exists"* — is the same narrow reading ADR-813 condemns, one method over.
- **R47** *(ADR-822, ADR-823)* — The port JSDoc becomes **true on Windows**: `rename` and
  `atomicRename` state that the kind matrix holds on the node and memory adapters on **every**
  platform, emulated on Windows in two steps for the empty-directory replacement; that the atomicity
  claim is scoped to the arrangements the platform renames in one step; and that the ancestor-chain
  refusal is adapter- **and** platform-chosen on node (`dst` on POSIX, `src` on Windows — today's
  text says `dst` flatly, which §8a measures false). `writeExclusive`'s occupancy sentence already
  names a symlink leaf, dangling included, and needs no edit — §8f is what makes it true on Windows.
  §6 carries the exact sentences. `reports/api.json` is regenerated in the same commit — the
  `docs:json` pre-push gate refuses a stale report.

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
| **N15** | file | the containment **root** | **darwin `EISDIR` · linux `ENOTEMPTY`** | **darwin `PERMISSION_DENIED` · linux `DIRECTORY_NOT_EMPTY`** | `src` | **succeeds** — the root becomes a file | `PERMISSION_DENIED(src)` — the darwin/Windows shape; §8g |
| N16 | directory with children | the containment **root** | `ENOTEMPTY` | `DIRECTORY_NOT_EMPTY` | `src` | **succeeds** — merges into the root | `DIRECTORY_NOT_EMPTY(src)` |
| N17 | absent | anything | `ENOENT` | `FILE_NOT_FOUND` | `src` | `FILE_NOT_FOUND` (`src`) | unchanged |
| N18 | file | dst whose **immediate parent** is a regular file | `EEXIST` (adapter's `mkdir -p`) | `FILE_EXISTS` | **`src`** | `NOT_A_DIRECTORY` (**ancestor** path) | unchanged — ADR-811 |
| N19 | file | dst whose **grandparent** is a regular file | `ENOTDIR` (`resolveWrite(dst)`) | `NOT_A_DIRECTORY` | **`dst`** on POSIX, **`src`** on Windows (§8a) | `NOT_A_DIRECTORY` (**ancestor** path) | unchanged — ADR-811 |
| N20 | src whose **immediate parent** is a regular file | fresh name | `ENOTDIR` (`resolveWrite(src)`) | `NOT_A_DIRECTORY` on POSIX, **`FILE_NOT_FOUND` on Windows** (§8a) | `src` | `FILE_NOT_FOUND` (`src`) | unchanged — §Out of scope |
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

**Platform verification — 33 distinct arrangements probed on two platforms, two divergent families.**
Both families are named below; the second one — **N15** — was found by the third platform (§8a) and
is the row §8g settles. The raw `rename(2)` /
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
the guard (§3c). **The Windows column has since broken the tie in ADR-817's favour**: N11b, N11c and
N11d all report the invalid-argument errno on `windows-latest` (§8a), so darwin is the one platform
of three that answers `NOT_A_DIRECTORY` there. **ADR-817 resolved it as option 1 —
reproduce linux** — because linux is the CI platform that gates every merge, so the code has a home
that actually runs (R32), and because the invalid-argument errno is the *specific* diagnosis where
darwin's `ENOTDIR` is the incidental one it reaches first. The darwin divergence on N11b is
knowingly kept, exactly as ADR-811 kept the depth-1 ancestor divergence.

🔴 **Windows is now measured — and this paragraph's predecessor was wrong twice.** It read *"No
Windows host was available, and node's `fs.rename` on Windows goes through `MoveFileExW`, not
`rename(2)`… nothing in this section may be read as a Windows claim."* A CI-hosted probe has since
run the whole matrix on `windows-latest`, `ubuntu-latest` and darwin (§8a): the Windows column
differs from **both** POSIX columns on eleven of the 43 arrangements, not on the one the
`MoveFileExW` reasoning predicted, and that attribution itself does not survive the data (§8c).
Every row of the table above is a POSIX statement; §8a carries the Windows column, §8d the
emulation that makes the node adapter honour these same kind rules there, and §8g the N15
divergence the third platform exposed inside POSIX.

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

**The node adapter's Windows arm is *inside* the mutation gate** — `stryker.config.mjs` mutates all
of `src` except `index.ts`, `*.d.ts` and the browser adapter — and the runner is linux, so every
mutant in `planRename` is reachable **only** through an injected `windowsPolicy`. §8h(a) is therefore
a mutation requirement, not merely a coverage one: without those rows every new branch would report
as an unreachable-code survivor, and no comment could honestly call it equivalent.

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
four code-checking assertion helpers (`assertFileNotFound` `:78`, `assertPermissionDenied` `:83`,
`assertFileExists` `:88`, `assertNotADirectory` `:93`) all check the instance and `data.code`, and
**none** checks `data.path`. There is **no** `DIRECTORY_NOT_EMPTY` helper — ADR-824 adds one in the
same shape — and the fifth helper the previous revision added, `assertRefusedWithoutCode` (its
comment at `:97–104`, its body at `:105–107`), checks the instance only; its four call sites
(`:277`, `:441`, `:465`, `:487`) are exactly the four rows ADR-824 makes strict, so the helper is
deleted with the last of them.

**The new constraint the first pass did not have.** The unit project runs on `windows-latest`
(`ci.yml:257`), so every node-side assertion in that file runs on Windows. §1e verified darwin and
linux; Windows was not probed at the time, and the mapping from `ERROR_*` to errno was not something
that revision could assert from memory. The file already carries **two** tolerance precedents built
for exactly this situation:

- `:762` `Given mkdir on existing file path, When mkdir, Then throws FILE_EXISTS or NOT_A_DIRECTORY`
  — an enumerated pair, with an in-file comment saying the exact code is platform-dependent.
- `Given non-empty directory, When rm, Then throws a TsgitError` — instance only, no code, with its
  own in-body comment saying the code is platform-dependent. It was at `:676` when the previous
  revision cited it and sits at `:871` after the new rows shipped. It asserts inline rather than
  through a helper, and ADR-824 leaves it alone: it is a different method, and its adapters
  genuinely disagree.

**ADR-819 settled it as option 2 and ADR-824 has since superseded that clause**, and the table below
is the placement, per row. "Code after the change" is what **both** adapters produce once the guards
land — memory today produces nothing at all on most of these rows.

🔴 **The "platform risk" column is no longer speculation.** Every cell that read *"unverified on
Windows"* has been measured (§8a) and is replaced by its verdict below. Two of them came back
**red**, which is exactly the outcome ADR-819 recorded as acceptable; §8 is the design of the
response the user chose.

🔴 **And the tolerance those measurements were the reason for is gone.** ADR-824 makes every `write`
and `rename` **refusal** row assert its exact code, because the premise of the tolerance — an
unmeasured Windows column — no longer holds. Two of the four rows already refuse identically on all
three operating systems before any change (`write` onto a directory: W1 / W2 / W3; a file renamed
onto a directory: N1 / N2 / N3). The other two are exactly what the emulation fixes: a directory onto
a regular file, which Windows does not refuse at all, and a directory onto a non-empty directory,
which it refuses with `PERMISSION_DENIED` where POSIX says `DIRECTORY_NOT_EMPTY`. After §8 all four
agree, so all four can be asserted strictly, and the instance-only helper the tolerance needed is
deleted with its last caller. What ADR-819 still governs is the table's right-hand column: the
posix-only file keeps the node codes the contract suite does **not** carry.

| Row | Code after the change | Windows column, measured (§8a) | Contract strictness | Strict node code pinned in |
|---|---|---|---|---|
| `writeExclusive` → directory occupant | `FILE_EXISTS` | **agrees** (W11) — `O_EXCL`/`EEXIST` is universal, and the existing strict `writeExclusive`-over-a-file row already passes Windows CI (W12) | **strict** (ADR-812) | the contract row itself |
| `writeExclusive` → file at a grandparent segment | `NOT_A_DIRECTORY` | **agrees** (W14); the depth-1 case is the adapter-dependent one and is excluded (W15) | **strict, code only** (ADR-812) | the contract row itself |
| `write` → directory at the leaf | `PERMISSION_DENIED` | **agrees** (W1 / W2 / W3) | **strict** (ADR-824), via `assertPermissionDenied`, plus non-destructiveness | the contract row itself; the `writeUtf8` / `writeStream` / `appendUtf8` delegations stay posix-only |
| `write` → **symlink** at the leaf | `PERMISSION_DENIED` | **agrees** (W7 live, W8 dangling); symlink creation itself works on the runner (`CAP-symlink`) | **no contract row** — same reasoning as the two `rename` symlink rows below | posix-only file (the existing `node-fs-real-symlinks.test.ts` is its neighbour) |
| `rename` file → directory | `PERMISSION_DENIED` | **agrees** (N1 / N2 / N3) | **strict** (ADR-824), via `assertPermissionDenied`, plus non-destructiveness | the contract row itself; the root arrangement (N15) stays posix-only, where the two kernels split |
| `rename` directory → regular file | `NOT_A_DIRECTORY` | 🔴 **RED — Windows *replaces* the file** (N4 / N5 / N6). `:446` is one of the two failing rows; §8d refuses it before the syscall | **strict** (ADR-824), via `assertNotADirectory`, plus non-destructiveness | the contract row itself, on all three OS; the symlink-destination variant is posix-only + win-only (§8h) |
| `rename` directory → non-empty directory | `DIRECTORY_NOT_EMPTY` | **was passing on the wrong code** — Windows reported `PERMISSION_DENIED` (N8 / N9 / N10 / N16), which the tolerant row admitted; §8d re-codes it and the strict row now says so | **strict** (ADR-824), via a **new** `assertDirectoryNotEmpty` helper, plus non-destructiveness | the contract row itself; the ancestor variants (N10 / N16) posix-only + win-only |
| `rename` directory → **empty** directory (positive, R20) | it succeeds | 🔴 **RED — Windows refuses `PERMISSION_DENIED`** (N7). `:494` is the other failing row; §8d emulates the replacement in two steps, which is what git's own compat layer does (§8b) | **positive row, kept in the contract suite** — see below | posix-only file + the new win-only file |
| `rename` src === dst, **regular file** (positive, R21) | it succeeds | **agrees** (N21) | **strict** (positive row, no code asserted) | — |
| `rename` src === dst, **non-empty directory** (positive, R21) | it succeeds | **agrees** (N22) — the `MoveFileEx` worry §8c corrects never applied here | **positive row, kept in the contract suite** | posix-only file |
| `rename` symlink → directory, directory → symlink | `PERMISSION_DENIED` / `NOT_A_DIRECTORY` | — | **no contract row.** ADR-812's reasoning applies verbatim: the file gates symlink behaviour per adapter through a capability hook, and a row that happens to agree without such a declaration would over-constrain a future adapter | posix-only file; memory-side unit rows too |
| `rename` dst inside src, dst absent or a directory (N11/N12) | `UNSUPPORTED_OPERATION` / `INVALID-ARGUMENT` | — | **no contract row.** The `reason` string is a node errno name and would over-constrain any adapter that has no errnos | posix-only file |
| `rename` dst inside src, dst an existing file or symlink (N11b) | **darwin and linux disagree** | **proven POSIX-divergent** | **never a strict contract row** | **nowhere on the node side** — memory-side unit row only, asserting ADR-817's linux-shaped choice |

**The two positive rows stayed in the contract suite even though they carried Windows risk**, and
that was deliberate: a positive row has no tolerant form — "it succeeds or it throws something"
asserts nothing. ADR-819's own consequence section said so: if Windows genuinely cannot replace a
directory through `rename`, the row goes red on the `windows-latest` unit cell and becomes a
**recorded decision** rather than a silent tolerance.

🔴 **That is what happened.** `:494` (R20, the empty-directory replacement) went red, and so did
`:446` (a directory source onto a file destination) — the second one for the opposite reason and the
worse one: Windows does not refuse it at all, it **replaces the file with the directory** (N4 / N5 /
N6). Tolerance did not hide *that* one — a row that admits any code still fails when nothing is
thrown — but it is exactly what hid the wrong code on the neighbouring row, where Windows refused
`PERMISSION_DENIED` for a non-empty directory destination and the row accepted it. The recorded
decision the ADR anticipated has been taken, and it is not to weaken the rows: **the node adapter
emulates the POSIX kind rules on Windows** (§8), so both rows pass with their arrangements and
assertions unchanged (**R45**), and the refusal rows around them gain the codes tolerance was
withholding (**R25**). All of them are still additionally proven on the memory side, where there is
no platform.

**The cross-adapter proof for these four refusals is one file again (ADR-824).** Each row asserts the
exact code through the file's own helpers — `assertPermissionDenied` (`:83`), `assertNotADirectory`
(`:93`) and one new sibling for `DIRECTORY_NOT_EMPTY`, which the file does not have today — plus its
own non-destructiveness observations, on **both** drivers and on all three operating systems. The
consequence is stated rather than discovered later: a Windows regression in the emulation now turns a
**shared** row red on every push instead of staying confined to the `win-integration` job. That is
the signal wanted, and it is the same reason the two positive rows were kept strict from the start.

What the posix-only file still carries is everything the contract suite deliberately does **not**:
the symlink-occupant rows, the inside-source `reason` string, the root arrangement's enumerated pair
(**R46**), the two ancestor oddities, and the delegating write surfaces. So the join point between
the two files is still this table — but the line between them now runs where ADR-812 always put it,
between *what every adapter must do* and *what this adapter does on this platform family*, rather
than between *code* and *no code*.

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

**The three sentences the Windows leg adds — R47, verbatim.** ADR-822 and ADR-823 bind wording, so
the text is fixed here rather than left to the implementation to phrase. Each replaces or extends an
existing clause in `src/ports/file-system.ts`; nothing else in those blocks moves.

1. **`rename`, replacing the clause that today reads *"On the node and memory adapters:"*** — the
   kind rules become explicitly platform-wide:
   > On the node and memory adapters, on every platform: a non-directory source refuses a directory
   > destination with PERMISSION_DENIED; a directory source refuses a non-directory destination with
   > NOT_A_DIRECTORY and a non-empty directory destination with DIRECTORY_NOT_EMPTY; an empty
   > directory destination is replaced — in one step where the platform's own rename honours these
   > rules, and on Windows in two, where the node adapter removes the empty destination and then
   > renames.
2. **`rename`, replacing the ancestor-chain clause's parenthesis** — today *"(node: `dst`; memory:
   the blocking ancestor)"*, which is false on Windows:
   > …refuses with NOT_A_DIRECTORY carrying an adapter- and platform-chosen path (node: `dst` on
   > POSIX and `src` on Windows; memory: the blocking ancestor), changing nothing. On Windows a
   > regular file on the **source's** ancestor chain reports FILE_NOT_FOUND rather than
   > NOT_A_DIRECTORY, because a different resolution step fails first.
3. **`atomicRename`, replacing *"stays atomic because the guard is pure inspection…"*** — the claim
   is scoped, not dropped:
   > Inherits every `rename` refusal above by delegation. Atomic for every arrangement on a platform
   > whose own rename honours the kind rules, and for every non-replacing arrangement everywhere:
   > the guard is pure inspection with no `await` between it and the mutation. The one exception is
   > the emulated empty-directory replacement on Windows, which is a removal followed by a rename;
   > if the destination is filled in between, the removal fails and the caller sees
   > DIRECTORY_NOT_EMPTY — the refusal the arrangement would have produced anyway.

`writeExclusive`'s summary already says *"a symbolic link, including a dangling one"* after ADR-813,
and that sentence becomes **true on Windows** for the first time with §8f; the JSDoc needs no further
edit, which is the point of having written it as an occupancy rule rather than a POSIX errno rule.

### §7 Faithfulness posture

The port contract is the oracle for this change and **no new interop test ships**:

- 🔴 **The node adapter's behaviour is no longer unchanged.** The previous revision's first bullet
  read *"The node adapter's behaviour is unchanged by this design, so there is no new node-side
  behaviour to pin cross-tool."* §8 changes it on one platform, so the sentence is retired and
  replaced by the three below. §1a still records that its exclusive-create refusal already matches
  git on POSIX.
- **The Windows change is pinned by a `git` probe, not by the port contract alone.** Real `git`
  2.55.0.windows.5 was run on `windows-latest` for every arrangement a git command can reach (§8b):
  `git init --separate-git-dir` onto an **empty** directory replaces it (S3) and onto a **non-empty**
  one refuses *"Directory not empty"* (S4) — on Windows exactly as on linux and darwin — and a
  symlink at `index.lock`, live or dangling, refuses *"File exists."* on all three (L1 / L2). Those
  four rows are the faithfulness anchor for R39, R38 and R44 respectively. `git`'s own Windows compat
  layer reaches them by emulating the POSIX rules in user space (`compat/mingw.c`), which is the
  same move §8d makes and is why this is faithfulness rather than invention.
- **Three rows rest on the port contract alone, and that is stated rather than hidden.** N4 / N5 /
  N6 — a directory source onto a file or a symlink destination — are reachable by **no git command**:
  `git mv` refuses before `rename(2)` (M1 / M2 / M3), `git worktree move` refuses before it (T1), and
  `git init --separate-git-dir` reads the target as a gitfile first and dies on the format (S1 / S2).
  There is therefore no git behaviour to match, on any platform. The oracle for those three is POSIX
  `rename(2)`'s own `ENOTDIR`, which the memory adapter, the node adapter on POSIX and the shared
  contract row already assert; §8d makes the node adapter on Windows agree with them.
- **No tsgit command reaches the changed arms either — the port surface is the whole exposure.**
  `worktreeMove` (`commands/worktree.ts:316`) calls `assertTargetFree` (`:315`) first, so its
  directory rename always lands on a **fresh** name (N23 / N24, the delegated arm); `mv`
  (`commands/internal/working-tree.ts:138`) moves leaf by leaf and never renames a directory at all —
  the shape adopted after backlog **21.2a**. Every other `ctx.fs.rename` call site is a file-to-file
  lock or temp promotion (`atomic-write.ts:36`, `index-lock.ts:137`, `ref-store.ts:712`,
  `reftable-transaction.ts:712,749,1015`, `fetch-pack.ts:374`, `shallow-file.ts:107`). So the
  emulation is not on any command's path; `NodeFileSystem` is a public export and *that* is what is
  being made correct.
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
  run so the mapping cannot rot silently. It is one of this design's three external-system pins:
  §1a's `git` run on darwin, this one, and §8b's three-OS `git` run.

### §8 The Windows leg — the node adapter emulates POSIX kind rules there

ADR-819 accepted a failure mode and it fired: two shared contract rows
(`test/unit/ports/file-system.contract.ts:446` and `:494`) are red on the three `windows-latest` unit
cells. The user settled the response, and it is therefore **not** a candidate — *"Way 1 is the much
cleaner way and it is what our architecture allows us easily"*: the **node adapter emulates POSIX
`rename(2)`'s kind rules and the exclusive-create symlink verdict on Windows**, behind the
`PathPolicy` / `FsOperations` seam (ADR-046 / ADR-047), inside this PR, with both rows passing
unchanged (**R45**).

The rejected alternative — loosen the two rows and describe Windows truthfully — is recorded so a
later reader has the argument that lost. It would ship a first-party adapter whose `rename`
**silently destroys a regular file** when handed a directory source (N4 / N5 / N6 below), on the one
platform where, after the loosening, nothing in the suite would say so.

**Every claim in §8 cites a probe row or a `compat/mingw.c` line.** Where a claim is an inference
rather than an observation it says so, and where the data is missing §8i names the gap instead of
guessing.

#### §8a The three-OS matrices — provenance, notation, and what actually differs

**Harnesses**, both on branch `probe/windows-rename-matrix` (commit `a262fd76`), cited not copied:

| Harness | What it drives | Runs |
|---|---|---|
| `tooling/probe-windows-rename-matrix.mjs` | the **composed `NodeFileSystem`** (never a bare syscall — the §1b rule), against a real `mkdtemp` + `realpath` root, occupants planted with raw `node:fs` | 44 rows per OS; CI run 34017803355 for the two hosted cells |
| `tooling/probe-windows-git-rename.mjs` | **real `git`**, scrubbed `GIT_*`, empty global config, `core.symlinks=true` | 20 rows per OS; CI run 34035733959 |
| the same rename-matrix harness, extended (probe branch commit `741c2808`) | the gap-closing rows: `writeExclusive` over a **dangling** symlink through the adapter (W13b), the **raw** `node:fs` calls under the mapped codes (`rmdir` on a non-empty directory, four `rename` arrangements, `open(…, 'wx')` over a live link, a dangling link and a directory), and a direct `npm run test:posix-integration` on ubuntu | 53 rows per OS, green on `windows-latest` and `ubuntu-latest`; the rows are cited in §8d, §8f, §8g and §8i |

**Columns.** `windows-latest` (node v24.19.0, git 2.55.0.windows.5) · `ubuntu-latest` (node
v24.20.0, git 2.55.0) · darwin 25.5.0 (node v22.22.3, git 2.55.0). `CAP-symlink` is `ok` on all
three, so no row is skipped for want of symlink privileges: symlink creation succeeded on the
hosted Windows runner.

⚠️ **Notation — the one trap in this section.** The harness's `N…` ids line up one-for-one with
§1e's rename rows (it adds `N25`, a file over an existing file). Its **`W…` ids do not line up with
§1d's**: the harness numbers the write surfaces in its own order, and three ids collide with
different meanings. Read every `W…` below through this table:

| Harness id | Arrangement | This document |
|---|---|---|
| W1 / W2 / W3 | `write` over an empty directory / a directory with a child / the root | §1d W1 / W2 / W3 (same) |
| W4 / W5 / W6 | `writeUtf8` / `writeStream` / `appendUtf8` over a directory | §1d W6 / W7 / W8 |
| W7 / W8 | `write` over a **live** / a **dangling** symlink | §1d W9 (both halves) |
| W9 / W10 | `write` with a file at the immediate parent / the grandparent | §1d W4 / W5 |
| W11 / W12 | `writeExclusive` over an empty directory / a regular file | §1d W10 / §1b row B |
| W13 / W13b | `writeExclusive` over a **live** / a **dangling** symlink | §1b row E / row G |
| W14 / W15 | `writeExclusive` with a file at the grandparent / the immediate parent | §1b row I / row H |

**The twelve arrangements where Windows differs from *both* POSIX columns.** Everything not listed
here is identical on all three, including every `W…` row except W13 and W13b, and N11 / N11b / N11c /
N11d / N12 / N13 / N14 / N17 / N18 / N21 / N22 / N23 / N24 / N25.

| Row | windows-latest | ubuntu-latest | darwin | Verdict |
|---|---|---|---|---|
| N4 empty directory → regular file | **`ok` — replaces**, after: `d` absent, `f` is now a directory | `NOT_A_DIRECTORY(src)` | `NOT_A_DIRECTORY(src)` | **destructive divergence**; §8d refuses it |
| N5 directory with a child → regular file | **`ok` — replaces**, after: `f` is the directory and `f/c` the child | `NOT_A_DIRECTORY(src)` | idem | **destructive divergence** |
| N6 directory → symlink | **`ok` — replaces**, after: `l` is the directory, its target `t` intact | `NOT_A_DIRECTORY(src)` | idem | **destructive divergence** |
| N7 directory with a child → **empty** directory | `PERMISSION_DENIED(src)`, destination untouched | **`ok` — replaces** | **`ok` — replaces** | **over-refusal**; §8d emulates the replacement |
| N8 empty directory → non-empty directory | `PERMISSION_DENIED(src)` | `DIRECTORY_NOT_EMPTY(src)` | idem | wrong code, right refusal |
| N9 directory with a child → non-empty directory | `PERMISSION_DENIED(src)` | `DIRECTORY_NOT_EMPTY(src)` | idem | wrong code |
| N10 directory → its own parent | `PERMISSION_DENIED`, path `p\s` | `DIRECTORY_NOT_EMPTY(p/s)` | idem | wrong code |
| N16 directory with a child → the containment root | `PERMISSION_DENIED(src)` | `DIRECTORY_NOT_EMPTY(src)` | idem | wrong code |
| N19 file → destination whose **grandparent** is a file | `NOT_A_DIRECTORY`, path **`src`** | `NOT_A_DIRECTORY`, path `p/m/x` (**`dst`**) | idem | anchoring oddity — ADR-822 |
| N20 source whose **immediate parent** is a file → fresh | **`FILE_NOT_FOUND`**, path `p\f` | `NOT_A_DIRECTORY(p/f)` | idem | code oddity — ADR-822 |
| W13 `writeExclusive` over a **live** symlink | **`PERMISSION_DENIED(l)`** | `FILE_EXISTS(l)` | `FILE_EXISTS(l)` | §8f |
| W13b `writeExclusive` over a **dangling** symlink | **`PERMISSION_DENIED(l)`** | `FILE_EXISTS(l)` | `FILE_EXISTS(l)` | §8f — same arm as W13 on every OS, and the raw syscall underneath it is worse than the code suggests |

**Two more rows the third platform changed inside POSIX**, neither of them a Windows-versus-POSIX
difference:

- **N11b / N11c** — a directory renamed onto an existing **file or symlink inside itself**. §1e
  recorded this as the one platform-divergent family, darwin `NOT_A_DIRECTORY` against linux's
  invalid-argument errno. Windows reports the **invalid-argument errno** too, so ADR-817's choice of
  the linux shape is now the majority of three rather than one of two. No change follows; the
  record does.
- **N15** — a **file** renamed onto the containment root. darwin and Windows report
  `PERMISSION_DENIED`; **ubuntu reports `DIRECTORY_NOT_EMPTY`**. §8g settles the consequence, which
  is a latently red row in a file this PR already added.

**Why W13's verdict is the adapter's own, not the platform's.** On Windows `honoursNoFollow` is
`false`, so every write surface runs `assertWritableLeaf` → `assertLeafSafeToWrite` →
`interpretCreationLstat` (`node-file-system.ts:304`), whose symlink arm throws `permissionDenied`
**before any syscall touches the leaf**. That is correct for `write` (W7 / W8 agree with POSIX's
`ELOOP`) and wrong for `writeExclusive`, where POSIX's `O_EXCL` says `EEXIST`. The fix is therefore
in the adapter, not in a flag (§8f).

**Windows path strings carry backslashes.** N10's reported path is `p\s` and N20's is `p\f` — the
adapter reports the *joined* path, and `pathPolicy.join` is `path.win32.join` there. Any assertion
about `data.path` in a Windows-running test must build its expectation with `node:path`, never with a
`/`-spelled literal (§8h).

#### §8b What real `git` does on Windows — the faithfulness pin

Same three OS, same run. **Every row is byte-identical across windows, ubuntu and darwin except L3.**

| Row | Command / arrangement | All three OS |
|---|---|---|
| M1 / M2 / M3 | `git mv <dir> <file>`, `-f <file>`, `-f <symlink>` | refused **before** `rename(2)`: `fatal: destination already exists, source=d, destination=f` |
| M4 / M5 | `git mv <dir> <empty dir>` / `-f <non-empty dir>` | exit 0 — a directory destination means move **into** it |
| M6 | `git mv -f <file> <file>` | exit 0, replaced |
| S1 / S2 | `git init --separate-git-dir <file>` / `<symlink to a file>` | `fatal: invalid gitfile format: …` — git reads the target as a gitfile first, so `rename(dir, file)` is never reached |
| **S3** | `git init --separate-git-dir <empty dir>` | **exit 0** — `.git` becomes a gitfile and `tgt/HEAD` exists: the empty directory **is replaced**, on Windows too |
| **S4** | `git init --separate-git-dir <non-empty dir>` | **`fatal: unable to move …/.git to …/tgt: Directory not empty`**, nothing moved — on Windows too |
| S5 | `… <fresh name>` | exit 0 |
| T1 | `git worktree move wt <file>` | `fatal: 'tgt' already exists` — a pre-check, `builtin/worktree.c` |
| T2 / T3 / T4 | `… <empty dir>` / `<non-empty dir>` / `<fresh>` | exit 0 — a directory target means move **into** it |
| **L1 / L2** | `.git/index.lock` occupied by a **live** / a **dangling** symlink | **`fatal: Unable to create '…/index.lock': File exists.`** — on Windows too |
| L4 | `.git/index.lock` occupied by a regular file | same message |
| **L3** | `.git/index.lock` occupied by a **directory** | POSIX: `File exists.` · **Windows: `Is a directory`** — the single divergent row |

**What this pins, row by row.**

- **R39 (the empty-directory replacement) is git-faithful, not merely POSIX-faithful.** S3 succeeds
  on Windows. `git` gets there by emulating it: `mingw_rename` (`compat/mingw.c:2527`) first tries
  `SetFileInformationByHandle` with `FileRenameInfoEx` and
  `REPLACE_IF_EXISTS | POSIX_SEMANTICS` (`:2550–2588`, falling back to `MoveFileExW` at `:2616` on
  systems that reject the newer class); when that fails with a file-in-use error (`:2626`) **and the
  destination is a directory** (`:2633`), it removes the destination with the CRT's
  wide-character `rmdir` and jumps back to the top to retry the rename (`:2638–2639`). That is
  precisely the two-step §8d specifies.
- **R38 (`DIRECTORY_NOT_EMPTY`) is git-pinned by S4.** In the same arm, a destination the CRT
  `rmdir` cannot remove leaves that call's `ENOTEMPTY` in `errno` and `mingw_rename` returns −1
  (`:2640`), which is the *"Directory not empty"* S4 prints on Windows.
- **The `EISDIR` sibling is git's too.** In that same block, a **non-directory** source against a
  directory destination sets `errno = EISDIR` (`:2635–2637`) — the code the node adapter already
  produces on Windows for N1 / N2 / N3 and maps to `PERMISSION_DENIED`.
- **R44 (`FILE_EXISTS` for a symlink leaf under exclusive create) is git-pinned by L1 and L2.**
  `mingw_open` (`:835`) tests, when `O_CREAT|O_EXCL` are both set, whether the leaf carries
  `FILE_ATTRIBUTE_REPARSE_POINT` and, if so, sets `errno = EEXIST` before opening anything
  (`:869–878`). Its comment states the intent in git's own words: *"When `symlink` exists and is a
  symbolic link pointing to a non-existing file, `_wopen(symlink, O_CREAT | O_EXCL)` would create
  that file. Not what we want: Linux would say `EEXIST` in that instance, which is therefore what
  Git expects."* That is the same sentence this design is making true for `NodeFileSystem`.
- **L3 is a recorded non-replication, and no behaviour changes for it.** git-on-Windows reports
  *"Is a directory"* for a directory occupant at `index.lock` because `mingw_open` maps `EACCES` on a
  directory leaf to `EISDIR` (`:898–901`); git-on-POSIX reports *"File exists."*. The node adapter
  reports `FILE_EXISTS` for that arrangement on **all three** OS (W11) — matching git-on-POSIX, the
  port contract and ADR-813's *"anything occupying the path"* rule. Replicating the Windows compat
  layer's incidental `EISDIR` would break a strict cross-adapter row to reproduce a difference git's
  own lockfile code treats identically (*"lock held"*). Recorded, not chased.

**What no `git` command reaches, so what the port contract alone decides.** M1–M3, T1 and S1–S2 show
that every git path to a directory rename either refuses first or never reaches `rename(2)` at all —
`builtin/mv.c:358–361` refuses a directory source with any existing destination —
`if (S_ISDIR(st.st_mode) && lstat(dst, &dest_st) == 0) bad = _("destination already exists")`, on
the path taken with or without `--force`, one clause below its own
*"can not move directory into itself"* refusal (`:353–356`) — and
`setup.c`'s `separate_git_dir` is the single call site that renames a directory without a pre-check.
So **N4 / N5 / N6 have no git oracle on any platform** and rest on POSIX `rename(2)`'s `ENOTDIR` plus
the port contract — which is exactly what §7's third bullet says, and why those three rows get no
interop test and no new golden.

#### §8c ADR-819's premise, corrected

ADR-819's Context reads: *"on Windows node's `fs.rename` is `MoveFileExW`, whose replace-existing
flag is documented not to replace directories, so the positive row where a directory replaces an
empty directory is the likeliest Windows failure."*

The **prediction** was right — N7 is red — and the **reason** does not survive the data:

- Take ADR-819's own premise at face value — that the replace-existing flag *"is documented not to
  replace directories"*. Then N4 / N5 / N6, whose **source** is a directory, could not succeed
  either. They **do** succeed (measured). Whatever the primitive is, the refusal tracks the
  *destination's* directory-ness, not a file-only scope on the call.
- N7 and N8 refuse **identically** (`PERMISSION_DENIED`) whether the destination directory is empty
  or not, which is a directory-replace refusal, not an emptiness rule.
- `git`'s own compat layer meets the same wall from a *different* primitive — `FileRenameInfoEx`
  with POSIX semantics — and has to work around it with a remove-then-retry (§8b). A workaround that
  is needed under both primitives is a property of the filesystem, not of the call.

**What the design therefore does and does not claim.** It claims only what was measured: on
`windows-latest`, `NodeFileSystem.rename` replaces a non-directory destination with a directory
source and refuses every directory destination with `EACCES`/`EPERM`. **It makes no claim about
which Win32 call node or libuv issues** — that was not measured (§8i, gap G3), and nothing in §8d
depends on it. ADR-819's *consequence* section is the part that binds: the red row is a recorded
decision, and this section plus §8d is that decision executed.

#### §8d The Windows arm of `NodeFileSystem.rename`

Today (`node-file-system.ts:745`):

```ts
rename = async (src: string, dst: string): Promise<void> => {
  const realSrc = await this.resolveWrite(src);
  const realDst = await this.resolveWrite(dst);
  await runFs(async () => {
    await this.fsOps.mkdir(this.pathPolicy.dirname(realDst), { recursive: true });
    await this.fsOps.rename(realSrc, realDst);
  }, src);
  this.parentRealpathCache.clear();
};
```

After:

```ts
rename = async (src: string, dst: string): Promise<void> => {
  const realSrc = await this.resolveWrite(src);
  const realDst = await this.resolveWrite(dst);
  try {
    await runFs(async () => {
      const replace = await this.mustReplaceDirectory(realSrc, realDst, src);
      await this.fsOps.mkdir(this.pathPolicy.dirname(realDst), { recursive: true });
      if (replace) await this.replaceDirectory(realSrc, realDst);
      else await this.fsOps.rename(realSrc, realDst);
    }, src);
  } finally {
    this.parentRealpathCache.clear();          // R43
  }
};

/** Same directory entry, decided by device and inode rather than by name (R51); bigint stats. */
function sameEntry(a: fs.BigIntStats, b: fs.BigIntStats): boolean {
  return a.ino === b.ino && a.dev === b.dev;
}

/** By device and inode when both sides report one, else by canonical path (one more realpath). */
private async sameDirectory(source, destination, canonicalSrc, realDst): Promise<boolean> { … }

/**
 * POSIX `rename(2)`'s kind rules, enforced here only on a platform whose own
 * rename does not enforce them. `true` means the destination is a directory
 * other than the source that must be removed before the rename; whether it
 * is empty is the removal's own verdict.
 */
private async mustReplaceDirectory(realSrc, realDst, reported): Promise<boolean> {
  if (this.pathPolicy.honoursRenameKinds) return false;                 // POSIX — 0 syscalls
  if (realSrc === realDst) return false;                                // byte-identical spellings: one entry, no fold
  if (this.strictlyContains(realSrc, realDst)) return false;            // N11 … N12, exact spelling
  const source = await this.lstatOrMissing(realSrc);                    // syscall 1
  if (source === undefined || !source.isDirectory()) return false;      // N1 / N2 / N3 / N13 / N14 / N15 / N17 / N25
  const destination = await this.lstatOrMissing(realDst);               // syscall 2
  if (destination === undefined) return false;                          // N23 / N24
  if (!destination.isDirectory()) throw notADirectory(reported);        // N4 / N5 / N6
  const canonicalSrc = await this.fsOps.realpath(realSrc);              // syscall 3 — the source leaf was never canonicalised
  if (await this.sameDirectory(source, destination, canonicalSrc, realDst)) return false;   // N22 under any spelling
  return !this.strictlyContains(canonicalSrc, realDst);                 // N7 replaces; N8 / N9 / N10 / N16 fail the rmdir
}

/** `child` strictly below `parent` — equality is NOT containment here. */
private strictlyContains(parent: string, child: string): boolean { … }

/** rmdir(dst) (ENOENT = nothing to remove), then rename; on a failed rename, best-effort mkdir(dst) back — only if this arm removed it. */
private async replaceDirectory(realSrc: string, realDst: string): Promise<void> {
  const removed = await this.removeEmptyDirectory(realDst);
  try {
    await this.fsOps.rename(realSrc, realDst);
  } catch (err) {
    if (removed) await this.restoreEmptyDirectory(realDst);             // R52
    throw err;
  }
}
```

**The emptiness verdict is the `rmdir`'s, not the plan's (ADR-825, R50).** The plan proves only that
both sides are directories; the removal itself decides whether the destination was empty, because
`rmdir` on a non-empty directory rejects `ENOTEMPTY` on `windows-latest` exactly as it does on linux
and darwin — that is measured, on node v24.19, and it is what turned this from a guess into a
decision. The refusal then costs nothing to produce: the `rmdir` runs inside the operation's existing
`runFs(…, src)`, so `mapErrno`'s `ENOTEMPTY` arm returns `directoryNotEmpty(src)` (`:225–229`) with
the `src` anchoring every other error in this operation already has. Every other `rmdir` errno takes
the same route — an `EACCES` on a destination another process holds open surfaces as
`PERMISSION_DENIED(src)` — so the arm has one failure path, not two. `readdir` is never called.

**Why removing before checking cannot destroy an ancestor.** The arm reaches its `rmdir` with a
directory at both ends, and the two arrangements whose destination is an **ancestor** of the source —
N10 (the source's own parent) and N16 (the containment root) — are exactly the arrangements where the
destination cannot be empty: it contains the source. Their `rmdir` therefore always fails
`ENOTEMPTY`, which is the refusal those rows want. The only directory this arm can ever remove is one
that holds nothing, which is what makes remove-first safe here in a way it would not be for a general
`rm`.

**Row by row against §1e, and what each arm costs.**

| Rows | Source | Destination | Arm | `fsOps` calls the arm makes |
|---|---|---|---|---|
| N21 | a file or symlink | itself | delegate | `lstat(src)` — a non-directory source never reaches the identity test |
| N22 | a directory | itself, byte-identical spelling | delegate | none — decided before any syscall |
| N22 | a directory | itself, under an alias spelling | delegate | `lstat(src)`, `lstat(dst)`, `realpath(src)` — the same device and inode (R51); a volume with no inodes adds `realpath(dst)` and compares the canonical paths exactly |
| N11 / N11b / N11c / N11d / N12 | directory | inside itself | delegate | none when the spelling shows it (strict containment); a source leaf spelled by an alias adds `lstat(src)`, `lstat(dst)`, `realpath(src)` |
| N1 / N2 / N3 / N15 | file or symlink | any directory | delegate | `lstat(src)` |
| N13 / N14 / N25 | file or symlink | file or symlink | delegate | `lstat(src)` |
| N17 | absent | anything | delegate | `lstat(src)` (missing) |
| N18 / N19 / N20 | ancestor-fault rows | — | delegate | `lstat` of the affected side, treated as missing |
| N23 / N24 | directory | absent | delegate | `lstat(src)`, `lstat(dst)` |
| **N4 / N5 / N6** | directory | **file or symlink** | **refuse `NOT_A_DIRECTORY(src)`** | `lstat(src)`, `lstat(dst)` — **no `rename`** |
| **N8 / N9 / N10 / N16** | directory | **non-empty directory** | **refuse — the `rmdir` rejects `ENOTEMPTY`, `mapErrno` returns `DIRECTORY_NOT_EMPTY(src)`** | `lstat(src)`, `lstat(dst)`, `realpath(src)`, `rmdir(dst)` **rejecting** — **no `rename`** |
| **N7** | directory | **empty directory** | **replace** | `lstat(src)`, `lstat(dst)`, `realpath(src)`, then `mkdir -p`, `rmdir(dst)`, `rename` **in that order**; a failing `rename` is followed by a best-effort `mkdir(dst)` |

`readdir` appears in no row: after ADR-825 the arm never calls it, on any branch.

**Where the `mkdir -p` sits.** It is the operation's own pre-existing step, not the emulation's, and
it runs between the plan and the removal on both directory-destination arms. On those arms it is a
**no-op**: both require the destination to exist, which requires its parent to exist. So the row
above lists it only where its ordering is load-bearing — before the `rmdir` and the `rename` of the
replace arm — and the syscall budget in §8i counts only what the emulation adds.

**Eleven design points, each of which a DI test pins.**

1. **The refusals are raised from inside `runFs`, and pass through it untouched.** `runFs`
   (`:254`) rethrows anything `isErrnoException` rejects, and that predicate is
   `err instanceof Error && 'code' in err` (`:140`). `TsgitError` carries its code at `data.code`,
   not at `code` (`domain/error.ts`), so a `notADirectory(src)` thrown inside the callback reaches
   the caller verbatim. Placing the plan inside `runFs` is what gives its own stray errnos the
   `src` anchoring every other error in this operation already has.
2. **The gate is the first line and short-circuits to nothing.** On a `honoursRenameKinds: true`
   policy — every POSIX host — `mustReplaceDirectory` issues zero syscalls; the only allocation is
   the `async` function's own promise, measured at about 30 ns against a 97 µs rename (**R41**).
3. **Identity is decided by the entry, never by the spelling (R51).** A string compare — even
   through `pathPolicy.normalizeForCompare`, which case-folds and normalises separators — cannot
   see the aliases Win32 accepts for one entry: a trailing dot or space the kernel strips, an 8.3
   short name. `resolveWrite` canonicalises the *parent* chain and joins the raw leaf, so both
   `C:\r\d` and `C:\r\d.` reach the arm as different strings for the same directory; a string
   self-rename escape would miss them, both `lstat`s would report that directory, and the replace
   arm would remove the **source** (the review round's sharpest finding). The opposite error also
   exists: on a per-directory case-sensitive NTFS tree `A` (a directory) and `a` (a file) are
   distinct entries that a case-fold equates, and a string escape would delegate — letting the
   platform replace the file with the directory, the very N4 hazard the arm exists to refuse. So
   equality is asked of the two `lstat` results — same device and same inode, when the filesystem
   reports one (`ino !== 0`; libuv fills both on NTFS from the volume serial and the file index) —
   and a self-rename of a directory costs two probes and one `realpath` on Windows (N22), which
   nothing hot pays. Two spellings that are byte-identical are one entry with no fold involved, so
   that case is decided before any syscall. A filesystem that reports no inode (FAT, some network
   shares) does not leave identity undecided either — the second review cycle found that it must
   not: with equality masked off the string test, an undecided identity would have sent
   `rename(dir, dir)` into the replace arm. When either side reports no inode, identity is decided
   by canonical path instead — `realpath` of both sides, compared exactly, since `realpath` already
   returns the platform's own spelling — at the cost of one more syscall on that arm alone; a mixed
   report (one side with an inode, the other without) takes the same fallback, and a destination
   that vanished before its `realpath` reads as another entry, whose removal then finds nothing. The
   inode compare itself runs on bigint stats, because an NTFS file reference exceeds a double's
   precision.
4. **Containment is asked twice, strictly, and delegates rather than refusing.** Windows already
   reports the invalid-argument errno for N11 / N11b / N11c / N11d / N12 (§8a), so the platform's
   own answer is the one ADR-817 chose for memory; refusing here would re-code N11b and — the
   destructive case — take the replace arm on N11d, removing an existing empty directory *inside*
   the source before a rename that then fails anyway. The first test is the cheap string one
   (`strictlyContains`, equality excluded — equality belongs to point 3), before any syscall. The
   second runs only on the directory-onto-directory arm: the destination's parent chain is
   canonical but the source leaf may be an alias (`C:\r\LONG-N~1` for `C:\r\long-name`), so
   only `realpath(src)` can show that the destination sits inside the source; that one extra
   syscall sits on the arm no command reaches (§7). `pathContainsNormalized` is reused for the
   prefix test — the adapter's own, case- and separator-correct — with the equality arm masked off.
5. **Symlinks are never followed, on either side.** Both probes are `lstat`, and `lstat` never
   reports a link as a directory: `Stats.isDirectory()` and `isSymbolicLink()` test `S_IFMT`
   against distinct values, and libuv reports a directory junction as `S_IFLNK` too. So
   `isDirectory()` alone decides the kind — a symlink to a directory is a non-directory for
   `rename(2)`, the property §1e's closing paragraph already pins on POSIX (N3, N6) — and an
   explicit `isSymbolicLink()` disjunct could never change a verdict (the review round removed the
   two it had, and the two DI rows that had to fabricate a `Stats` that is both). Only a
   `stat`-based probe, which follows the link, would need the extra test.
6. **`lstatOrMissing` answers "is there an entry here", and swallows nothing.** `ENOENT` and
   `ENOTDIR` both mean *no entry at this path* and return `undefined`; every other errno propagates
   through `runFs` and is mapped. `ENOTDIR` is included deliberately: it is the ancestor-blocked
   case (N18 / N19 / N20), where returning "missing" delegates to the `mkdir -p` and the `rename`
   that already produce today's measured codes on both platform families — so the emulation cannot
   move an ancestor-fault row. This mirrors the ENOENT-only swallow `isSymlinkLeaf` (`:856`) already
   documents; whether the two share one helper is a refactor-phase call, and if `isSymlinkLeaf` is
   re-expressed on top of it, its carried equivalence prose is re-read against the new structure per
   the repo rule.
7. **The plan runs before the `mkdir -p`, and the ordering is provably immaterial.** As written, the
   one refusal the plan raises — `NOT_A_DIRECTORY` on N4 / N5 / N6 — happens before the `mkdir -p`
   runs at all. The opposite ordering would be observationally identical, because that refusal
   requires the destination to **exist**, which requires its parent to exist, which makes the
   `mkdir -p` a no-op on exactly that arm — so it can never create a directory on a path that then
   refuses, under either ordering. The same argument covers the `rmdir` refusal one line below it.
   The order written keeps the diff to two inserted lines and keeps the "nothing is mutated before
   the verdict" posture the memory guard already has (§3c, R22).
8. **The replace arm is `rmdir` → `rename`, and the emptiness verdict is the platform's own
   (ADR-825).** `rmdir(dst)` runs inside the same errno-mapped operation as the rename: an empty
   destination is removed and the rename proceeds; a non-empty one rejects `ENOTEMPTY`, which
   `mapErrno` turns into `DIRECTORY_NOT_EMPTY(src)`; one that vanished between the probe and the
   removal rejects `ENOENT`, which the arm reads as *already in the state the removal wanted* and
   proceeds to the rename — reporting `FILE_NOT_FOUND(src)` there would name the wrong side. The
   removal reports whether it removed anything, and the restoration below runs only when it did:
   recreating a directory a concurrent actor deleted would not be *changing nothing*. This is literally `mingw_rename`'s sequence
   (`mingw.c:2638–2639`), it is one syscall cheaper than reading the directory first, and its
   refusal code comes from the same errno map every other refusal in the adapter uses rather than
   from a second, hand-written verdict. It rested on one unmeasured fact — node's own Windows errno
   for a non-empty `rmdir` — and that fact was measured: **`ENOTEMPTY`**, the same as on linux and
   darwin (§8i, gap G2, now closed). The rejected alternative, `readdir` first, bought independence
   from an errno that turned out not to need it, at one syscall and a second code path for one
   verdict.
9. **Atomicity is scoped, not silently dropped (ADR-823).** The replace arm is two syscalls with a
   window between them, so `atomicRename` — which delegates (`:764`) — is no longer a single atomic
   operation for that one arrangement on that one platform. git accepts the identical window in the
   identical place (`mingw.c:2638–2639`), and no `atomicRename` caller renames a directory at all
   (§7). The port JSDoc states the scope instead of the bare word; §6 carries the sentence. The
   window's failure mode is bounded: only a directory the `rmdir` itself could remove — that is, an
   empty one — is ever removed, and if the following `rename` fails, an empty directory is gone. A
   concurrent writer that fills the destination first makes the `rmdir` fail with `ENOTEMPTY`, so the
   caller sees `DIRECTORY_NOT_EMPTY` — the refusal the arrangement would have produced anyway, which
   is why the race degrades into the correct answer rather than into a wrong one. With the removal
   *as* the check there is no window between check and act at all; the only remaining window is
   between the removal and the rename, and it needs no adversary on Windows — an indexer or an
   antivirus holding a handle inside the source makes the `rename` fail with a sharing violation
   after the destination is gone. So a failed rename on that arm is followed by a best-effort
   `mkdir(dst)` (**R52**): the refusal keeps the contract's *changing nothing*, the rename failure
   stays the one reported, and an errno failure of the restoration itself is subordinate to it and is
   not surfaced — a non-errno failure there is a programming error and surfaces in its place. One check-then-act window remains and is documented rather than closed: a directory
   source over an *absent* destination delegates after `lstat(dst)`, and a regular file planted
   there before the `rename` still meets the platform's own replace — `mingw_rename` has the same
   window, and no native primitive closes it.
10. **The verdict is a boolean, not a string enum.** A `'rename-only' | 'replace-directory'` plan
    was consumed by one `===`, so every `'rename-only'` literal was a provably equivalent
    string-literal mutant (four of them, hand-verified surviving); a boolean has no such class, and
    its forced-true and forced-false mutants both die on the rows that assert which syscalls ran.
11. **The rows pin the targets, not only the order.** A `rmdir(realSrc)` in place of
    `rmdir(realDst)` is a one-token defect that deletes the source, and Stryker emits no
    identifier-swap mutant for it; every replace-arm row therefore asserts `rmdir` was called with
    the destination and `rename` with the pair, and the restoration row asserts the recreating
    `mkdir` names the removed destination.

**What does not change on Windows.** N1 / N2 / N3 keep `PERMISSION_DENIED` (already POSIX-shaped),
N11–N12 keep the invalid-argument errno, N18 keeps `FILE_EXISTS(src)`, and the two oddities N19 and
N20 keep their Windows shapes — documented and pinned, not normalised (ADR-822, **R49**).

#### §8e The gate — a fourth `PathPolicy` capability flag

`path-policy.ts`'s own header states the doctrine: the capability flags are independent so *"a
policy that mixes capabilities … sets each on its own merits instead of one flag standing in for all
three"*. ADR-820 settles the gate as a fourth flag of exactly that kind (**R48**):

```ts
/**
 * Whether this platform's own `rename` enforces POSIX `rename(2)`'s kind
 * rules: a directory source refuses a non-directory destination, and a
 * directory destination is replaced only when it is empty. `false` forces
 * `NodeFileSystem.rename` onto an explicit pre-rename kind check.
 */
readonly honoursRenameKinds: boolean;
```

`posixPolicy: true`, `windowsPolicy: false`, set through the existing `PathPolicyCapabilities`
record so `makePolicy` needs no other change. The name mirrors `honoursNoFollow` deliberately: both
say *what the platform's syscall does*, and both have the same consequence — the adapter falls back
to an explicit probe when the answer is `false`.

**Why not reuse `honoursNoFollow`.** The two flags are `false` on exactly the same policy today, and
would stay coupled only by accident: one is about `open(2)` and symlink leaves, the other about
`rename(2)` and directory kinds. A platform could honour one and not the other — and the file was
built precisely to stop that coincidence from being encoded (ADR-046). Reusing it would also make
`isSymlinkLeaf`'s carried equivalence prose — *"this method is only called when
`!pathPolicy.honoursNoFollow`"* — quietly wrong, since a second, unrelated caller would appear under
the same condition. §8f does add a second *reader of the flag* — the new exclusive-create assert —
which leaves that note intact, because the note is about which platform reaches `isSymlinkLeaf`'s
body and not about how many places consult `honoursNoFollow`. The new reader gets its own POSIX row
(§8h(a), row 20) so its gate is not itself an unkilled mutant.

**What the fourth flag costs.** Every policy built by hand in the suite gains a field; the compiler
points at each one, which is the whole of the migration. Nothing becomes public: `PathPolicy` stays
`@internal` to the node adapter and is not re-exported, so `reports/api.json` does not move for this
flag — only for the port JSDoc (**R47**).

**Why `PathPolicy` at all, given its header says "path operation".** `honoursNoFollow` is already a
syscall-semantics flag living there, and it is the precedent: the interface is *"every platform-aware
operation `NodeFileSystem` needs"* in practice, and adding a second seam for one boolean would give
the adapter two places to ask what platform it is on. The rejected shape — a separate capability
record injected beside `PathPolicy` — buys interface purity for a second platform seam and a fourth
constructor parameter, which ADR-820 weighed and declined.

**What the flag buys the test tiers.** Because the emulation is gated on an injectable capability
rather than on `process.platform`, the Windows arm is reachable on **every** host: the DI rows of
§8h(a) construct `new NodeFileSystem(rootDir, windowsPolicy, fakeFsOps({ … }))` on darwin and on the
linux mutation runner alike. Without that, every mutant inside the arm would be an unreachable-code
survivor on the only platform Stryker runs on.

#### §8f `writeExclusive` over a symlink leaf — the exclusive-create verdict

**The defect.** On a `honoursNoFollow: false` platform, all five write surfaces share
`assertWritableLeaf` → `assertLeafSafeToWrite` → `interpretCreationLstat`, whose symlink arm throws
`permissionDenied(path)` (`node-file-system.ts:304–324`). For `write` / `writeUtf8` / `writeStream` /
`appendUtf8` that is right and cross-platform (W7 / W8 agree with POSIX's `ELOOP` on all three OS).
For `writeExclusive` it is wrong: POSIX's `O_EXCL` gives `EEXIST` → `FILE_EXISTS` (W13 on ubuntu and
darwin), git's own compat layer forces `EEXIST` for a reparse point under `O_CREAT|O_EXCL`
(`mingw.c:869–878`), and real git on Windows refuses `index.lock` occupied by a live **or** a
dangling symlink with *"File exists."* (L1 / L2).

🔴 **The guard is load-bearing for correctness, not only for the error code — measured.** The second
probe run took the raw syscall underneath the adapter, `fs.open(path, 'wx')`, on all three OS:

| Leaf at `path` | windows-latest | ubuntu-latest | darwin |
|---|---|---|---|
| a **live** symlink | `EEXIST` | `EEXIST` | `EEXIST` |
| a **dangling** symlink | **succeeds — and creates the link's target** | `EEXIST` | `EEXIST` |
| an empty directory | `EEXIST` | `EEXIST` | `EEXIST` |

On Windows libuv **follows** a dangling link under an exclusive create and materialises the file the
link points at — anywhere the link points, including outside the containment root. That is precisely
the hazard git's own comment names (`mingw.c:869–878`): *"`_wopen(symlink, O_CREAT | O_EXCL)` would
create that file. Not what we want."* Two consequences bind the implementation:

- The adapter's pre-open `lstat` on the `!honoursNoFollow` arm must **keep firing for a dangling
  link**. It is what stops the write, not merely what renames the error: today it refuses with the
  wrong code, and §8f's change makes the code right without touching the moment the refusal happens.
- *"Drop the guard on `writeExclusive` and let the platform's own `EEXIST` answer"* is not available
  on Windows: for a **live** link the raw open does report `EEXIST`, but for a **dangling** one it
  reports success and a created file, so the platform cannot be trusted to answer for the family. It
  is recorded here so no later reader tries it, and DI row 20 (§8h(a)) pins the POSIX half — where the
  flag *is* `true` and the platform's `EEXIST` genuinely is the answer on both.

W13 (live) and W13b (dangling) take the **same** adapter arm on all three OS — `PERMISSION_DENIED` on
Windows, `FILE_EXISTS` on ubuntu and darwin — which the second probe run measured through the
composed adapter rather than inferred (§8i, gap G1, now closed). After this change both are
`FILE_EXISTS` everywhere, and both are pinned as rows in the win-only file (§8h(b)), because the
platform where they used to differ is the platform where the fix has to hold.

**The fix — turn the shared helper into a classifier and let each surface name its own verdict.**
`interpretCreationLstat` currently *decides* (`void`, throws `permissionDenied`). It becomes a query
that *reports* — same three cases, same errno handling, same non-errno re-bubble — and the two
callers spell their own refusal:

```ts
/** @internal — was `interpretCreationLstat`: `void` + throw. Now a pure classifier. */
export function isCreationLeafSymlink(result: …, path: string): boolean;

/** lstat the creation leaf and classify it. Unconditional; callers gate on the policy. */
private async creationLeafIsSymlink(real: string, path: string): Promise<boolean>;

// unchanged meaning, one line shorter — chmod's caller, on every platform
private async assertLeafSafeToWrite(real: string, path: string): Promise<void> {
  if (await this.creationLeafIsSymlink(real, path)) throw permissionDenied(path);
}

// unchanged — write / writeUtf8 / writeStream / appendUtf8
private async assertWritableLeaf(real: string, path: string): Promise<void> {
  if (!this.pathPolicy.honoursNoFollow) await this.assertLeafSafeToWrite(real, path);
}

// new — writeExclusive only
private async assertExclusiveCreateLeaf(real: string, path: string): Promise<void> {
  if (this.pathPolicy.honoursNoFollow) return;                  // O_EXCL already answers EEXIST
  if (await this.creationLeafIsSymlink(real, path)) throw fileExists(path);
}
```

`writeExclusive` (`:656`) swaps its one call from `assertWritableLeaf` to
`assertExclusiveCreateLeaf`; the other four write surfaces and `chmod` (`:787`) are untouched, and
`assertLeafSafeToWrite` / `assertWritableLeaf` keep their names, their gating and their
`PERMISSION_DENIED`. Three properties make this the right shape rather than a verdict parameter
threaded down through two layers: the error is named at the call site that knows its surface (no
boolean and no error factory travels in as an argument), the exported helper becomes a **pure**
function of its input — its existing unit rows at `node-file-system.test.ts:1130–1215` change from
"throws X" to "returns true/false", one assertion each — and the one caller that runs on **every**
platform is the one that does not change.

**What stays put.** A **directory** leaf under `writeExclusive` on Windows already reports
`FILE_EXISTS` (W11) through `writeFile`'s own `EEXIST`; nothing is added for it, and L3's
git-on-Windows *"Is a directory"* is the recorded non-replication of §8b. A **dangling** symlink
takes the identical `lstat` verdict as a live one — the adapter never resolves the target — which is
no longer an inference: W13b measures it on all three OS.

**A residual window, stated.** The exclusive-create guard's `lstat` and the `writeFile` it guards
are separated by an `await`; on Windows a dangling symlink planted in that window is followed by
libuv's open, the target is created, and `writeExclusive` returns success. The pre-change guard had
the identical shape, so the change neither introduces nor widens the window — only the code it
reports moved — and no portable fix exists at this layer without a Win32 no-follow open. The guard
is load-bearing against the arrangement that exists *before* the call, not against one planted
during it.

#### §8g N15 — the divergence inside POSIX, and a latently red row

**The measurement.** `rename(<file>, <the containment root>)`: darwin `PERMISSION_DENIED`
(`EISDIR`), Windows `PERMISSION_DENIED`, **ubuntu `DIRECTORY_NOT_EMPTY` (`ENOTEMPTY`)**.

**The axis is not emptiness.** N2 — a file onto a *sibling* non-empty directory — is
`PERMISSION_DENIED` on **both** POSIX platforms. N10 and N16 — a *directory* onto an ancestor — are
`DIRECTORY_NOT_EMPTY` on both. The only row that splits is a **non-directory source whose
destination is one of its own ancestors**: linux answers "you are trying to remove a non-empty
directory" and darwin answers "the destination is a directory" first. Both are legal `rename(2)`
outcomes; POSIX does not order the two checks.

**Why it matters now.** `test/integration/posix-only/node-fs-write-rename-refusals.test.ts:287`
(*"Given a file renamed onto the containment root, When rename, Then throws PERMISSION_DENIED"*)
pins the darwin answer strictly, and the `posix-integration` job runs on **ubuntu and macos**
(`ci.yml:388–395`). That job `needs: [changes, unit-tests]`, and `unit-tests` is red on the three
Windows cells — so the ubuntu cell has never run this row. It is **latently red** and would surface
the moment §8 turns the unit job green. It must be fixed in the same PR, or the Windows fix would
merely swap one red job for another (**R46**).

**And it is no longer latent in the "unproven" sense.** The second probe run executed
`npm run test:posix-integration` directly on `ubuntu-latest`, outside the job's `needs:` chain:
32 rows pass and exactly one fails — *"Given a file renamed onto the containment root, When rename,
Then throws `PERMISSION_DENIED`"*, with `AssertionError: expected 'DIRECTORY_NOT_EMPTY' to be
'PERMISSION_DENIED'`. The row is the one named above and the failure is the one predicted; nothing
else in the file moves.

**ADR-821 settles it as the enumerated pair**, following the contract suite's own precedent at
`:762` (`mkdir` over a file accepts `FILE_EXISTS` **or** `NOT_A_DIRECTORY`, with an in-file comment
saying the code is platform-dependent): the row asserts `PERMISSION_DENIED` or
`DIRECTORY_NOT_EMPTY`, plus the non-destructiveness observation, plus a comment naming the axis
above so the next reader does not "fix" it back to one code. The rejected alternatives were a
`process.platform` branch — a conditional oracle inside a test, with a new arm for every future
POSIX platform — and swapping the arrangement for the sibling non-empty directory, which loses the
`rootDir` arrangement §2b exists to close.

**The memory adapter's N15 target does not change.** `assertRenamable` refuses any directory
destination under a non-directory source with `permissionDenied` (§3c), which matches darwin and
Windows — two of the three node columns — and matches its own N1 / N2 / N3 rule. Reproducing linux
would mean adding an *is the destination an ancestor of the source* clause that then contradicts
darwin and Windows on the same row: the ADR-811 / ADR-817 shape exactly, where there is no single
node behaviour to match. The contract row for this family asserts instance plus non-destructiveness,
so nothing cross-adapter depends on the code. Recorded in §1e's table, not changed.

#### §8h Test placement

Four tiers, mirroring the ones this design already uses. **(a) is the mutation gate** — Stryker runs
on linux, so the Windows arm's mutants are killable only through the DI seam.

**(a) DI unit rows — `test/unit/adapters/node/node-file-system-injected.test.ts`.**
`new NodeFileSystem(rootDir, windowsPolicy, fakeFsOps({ … }))`, no `vi.mock`, running on every OS.
One row per branch, because every branch of `planRename` is a `ConditionalExpression` target and a
row that trips two of them proves neither (§3e):

| # | Given (all under `windowsPolicy` unless stated) | Then |
|---|---|---|
| 1 | `posixPolicy` and a directory source over a regular-file destination | delegates: `rename` called once, `lstat` and `rmdir` **never** called — kills the forced-false gate |
| 2 | `src` and `dst` differing only in case | delegates, `lstat` never called — pins `pathContains`'s equality arm through `normalizeForCompare` |
| 3 | `dst` inside `src`, `dst` an existing empty directory, `fsOps.rename` rejecting the invalid-argument errno | `UNSUPPORTED_OPERATION` / that errno, with `lstat` and `rmdir` **never** called — the row that proves the inside-source test delegates instead of taking the replace arm and destroying `dst` |
| 4 | a regular-file source, any destination | exactly **one** `lstat`; `rmdir` never called |
| 5 | a symlink source over a directory destination | delegates after one `lstat` — the symlink test, not the directory test, decides it |
| 6 | source `lstat` rejecting `ENOENT` | delegates; the platform's own `rename` reports it |
| 7 | a directory source, destination `lstat` rejecting `ENOENT` | delegates; `rmdir` never called |
| 8 | a directory source, destination `lstat` rejecting `ENOTDIR` | delegates — the ancestor-blocked case keeps today's code |
| 9 | a directory source, destination `lstat` rejecting `EACCES` | `PERMISSION_DENIED` carrying **src**; `rename` never called — proves the probe does not swallow |
| 10 | a directory source, a **regular-file** destination | `NOT_A_DIRECTORY` carrying src; `rmdir` and `rename` never called |
| 11 | a directory source, a **symlink** destination | idem — the second disjunct, alone |
| 12 | a directory source, a directory destination, `fsOps.rmdir` rejecting `ENOTEMPTY` | `DIRECTORY_NOT_EMPTY` carrying **src**; `rename` never called — the refusal comes from `mapErrno`, not from the arm |
| 13 | the same, `fsOps.rmdir` rejecting `EACCES` | `PERMISSION_DENIED` carrying **src**; `rename` never called — pins *"every other `rmdir` errno passes through the same map"* (**R50**) rather than only the non-empty one |
| 14 | a directory source, a directory destination, `fsOps.rmdir` resolving | `rmdir(realDst)` then `rename(realSrc, realDst)`, **in that order** (`mock.invocationCallOrder`), and `readdir` **never called on any arm** — the one row that pins ADR-825's removal of the emptiness probe |
| 15 | row 14 with `fsOps.rename` rejecting | the error surfaces **and** the parent-realpath cache was cleared (a following call re-issues `realpath`) — R43 |
| 16 | `atomicRename` on row 10's arrangement | the same error — delegation, not a second guard |
| 17 | `writeExclusive` with a symlink leaf | `FILE_EXISTS` carrying the requested path; `writeFile` never called |
| 18 | `writeExclusive` with a non-symlink leaf | `writeFile` called with the exclusive flags |
| 19 | `write` with a symlink leaf | still `PERMISSION_DENIED` — the pair that must not collapse |
| 20 | `posixPolicy` and `writeExclusive` over a symlink leaf, with the fake `writeFile` rejecting `EEXIST` | `FILE_EXISTS` **and no `lstat` at all** — kills the forced-false `honoursNoFollow` gate in the new assert, which is otherwise outcome-equivalent on POSIX and observable only by call count |

Rows 12 and 13 are the pair ADR-825 turns from one branch into one code path: the arm issues the
same `rmdir` in both, and what separates the verdicts is the errno `mapErrno` receives. Row 14 is
where the *absence* of `readdir` is asserted — once, on the arm that used to call it — so a future
re-introduction of an emptiness probe fails a row instead of passing silently.

**Review-round additions to the DI rows.** The two rows that fabricated a `Stats` that is both a
directory and a symlink became a plain symlink source and a plain symlink destination (point 5); the
case-differing self-rename row became the entry-identity row (same device and inode under two
spellings → delegate, two `lstat`s, no `rmdir`); three rows joined it — spellings that fold equal but
are distinct entries (a directory `A` over a file `a` on a case-sensitive directory → `NOT_A_DIRECTORY`
carrying src, no `rename`), a filesystem reporting no inode (identity undecided → the kind checks take
the replace arm), and a source leaf spelled by an alias whose canonical path contains the destination
(→ delegate, no `rmdir`); the replace arm gained the target pins (point 11), a restoration row (the
recreating `mkdir` names the removed destination and runs after the removal; `PERMISSION_DENIED`
carrying src surfaces), a row where the restoration itself fails (the rename failure is still the one
reported), and an `ENOENT`-on-removal row (the rename still runs); the cache-clear row asserts the
exact code and path; the two `posixPolicy` delegation rows arrange the `Stats` their `Given` names,
even though the gate keeps `lstat` from being called; and every fabricated `Stats` in the block now
carries an inode and a device so the identity test is decided, not defaulted. The `dataFor` /
`captureError` helpers moved to `test/fixtures/tsgit-error-data.ts`, shared by the three files that
had copies.

**Second-cycle additions.** An exact-spelling self-rename with no inode (delegates, nothing
removed), two spellings of one directory with no inode whose canonical paths agree (delegates), two
distinct directories sharing an inode on different devices (the replace arm — the `dev` conjunct's
kill), a removal rejecting a non-errno throwable (propagates verbatim, no rename), a destination that
vanished before the removal whose rename then fails (nothing recreated: `mkdir` ran once, for the
parent chain), and the success row now pins that the recreating `mkdir` never runs on success. Every
fabricated `Stats` in the block is a bigint `entry()` with its own inode, so no row exercises the
undecided-identity path by accident.

**(b) Real-NTFS rows — a new `test/integration/win-only/node-fs-windows-rename-refusals.test.ts`.**
The name mirrors its posix-only sibling; the directory's convention is a `@proves` header
(`surface: nodeFs.windowsRenameRefusals`, `bucket: platform-only`, `unique:` the POSIX kind rules the
node adapter emulates on NTFS) after a block comment saying why the file is platform-bound — the
shape `node-fs-windows-real.test.ts` already uses. Real `mkdtemp` + `realpath` root, a real
`NodeFileSystem`, no `vi.*` at all (the `integration` tier's `overMockedIntegration` threshold is
**0**), `const sut = new NodeFileSystem(rootDir)`, and the existing `canCreateSymlinks()` probe with
an honest `skip()` guarding every symlink row. It is run by the `win-integration` project
(`vitest.config.ts:64–65`) in its own CI job (`ci.yml:417`), never by `npm run validate`.

Rows: N4 / N5 / N6 → `NOT_A_DIRECTORY` carrying src, destination byte-identical · N7 → replaced,
child reachable under the destination · N8 / N9 / N10 / N16 → `DIRECTORY_NOT_EMPTY` carrying src,
neither tree merged · N1 / N2 / N3 / N15 → `PERMISSION_DENIED` carrying src (unchanged, pinned so a
regression shows) · N11 / N11b / N11c / N11d / N12 → `UNSUPPORTED_OPERATION`, `operation:
'filesystem'`, the invalid-argument errno as `reason`, no `path` · N19 / N20 → the two anchoring
oddities, pinned in their **Windows** shapes (ADR-822, **R49**) · N21 / N22 / N23 / N24 positives ·
W13 and W13b → `writeExclusive` over a live **and** over a dangling symlink → `FILE_EXISTS`, and on
the dangling row the link's target is still **absent** afterwards, which is the half the platform's
own exclusive open gets wrong (§8f) · W7 / W8 → `write` over the same two leaves →
`PERMISSION_DENIED`, so the two verdicts are pinned apart on the platform where they differ.

Two rows joined after the review round: N11c — a directory renamed onto an existing symlink inside
itself (`UNSUPPORTED_OPERATION`, link and target intact, behind the symlink guard) — and the
cheapest real-platform proof of R51: a directory renamed onto its own name in another case resolves,
keeps its child and lands under the new spelling (the identity test sees one entry before anything
is removed; a replace arm taken by mistake would refuse `DIRECTORY_NOT_EMPTY`; the platform then
applies the case change itself). The row first shipped with a trailing-dot spelling and went red on
the Windows runner for a reason worth recording: both `lstat`s did see one entry and the arm
delegated, but node's own rename then created a literal dotted NT name — an alias spelling is the
platform's to interpret, and the adapter passes it through unchanged, exactly as it must for the
case-only rename a caller relies on. The directory-with-child-onto-file row now also asserts the destination
file's bytes are byte-identical, the observation §8h(b) names.

⚠️ **Every path expectation in this file is built with `node:path`.** The adapter reports joined
paths, and on Windows those carry `\` (N10's `p\s`, N20's `p\f`); a `/`-spelled literal would fail
against a correct implementation. `readlink` results are Windows-shaped too, so any predicate on link
text normalises separators before matching.

**(c) The shared contract rows keep their arrangements and gain their codes.** `:446` and `:494` are
edited in neither arrangement nor assertion and simply go green on Windows (**R45**). The four rows
that call `assertRefusedWithoutCode` — `:277`, `:441`, `:465`, `:487` — swap that call for a
code-checking helper (ADR-824, **R25**), and the helper itself is deleted with its last caller. No
row is added, moved or removed; §5's table carries the per-row placement.

**(d) The posix-only file gains the N15 fix** (§8g, ADR-821) and nothing else — every other row in it
is darwin-and-linux agreeing, which the ubuntu column of §8a re-confirms and the direct ubuntu run of
the file (32 passing rows, one failure, §8g) demonstrates end to end.

#### §8i Cost, the tarball, and the named measurement gaps

**Syscall budget, per call, by policy.**

| Policy / arrangement | Extra syscalls |
|---|---|
| `honoursRenameKinds: true` (every POSIX host) | **0** |
| Windows, byte-identical self-rename or destination spelled inside the source | **0** |
| Windows, self-rename under an alias spelling | 2 `lstat` + 1 `realpath` (+ 1 `realpath` without inodes) |
| Windows, non-directory source — *every* production caller | **1** `lstat` |
| Windows, directory source onto a fresh name (`worktreeMove` after `assertTargetFree`) | 2 `lstat` |
| Windows, directory source onto an existing directory | 2 `lstat` + `realpath(src)` + 1 `rmdir` (+ `realpath(dst)` on a volume reporting no inode) |

The hot callers are all in the third row: `atomic-write.ts:36` (every ref update),
`index-lock.ts:137`, `ref-store.ts:712`, `reftable-transaction.ts:712,749,1015`,
`fetch-pack.ts:374`, `shallow-file.ts:107` — file-onto-file lock and temp promotions, which pay one
`lstat` on Windows and nothing anywhere else. The bottom row is reached by **no tsgit command** (§7),
only by a direct port call.

`writeExclusive` pays nothing new: the leaf `lstat` on `honoursNoFollow: false` platforms is already
issued today; §8f only changes which error it raises.

**Tarball and the browser bundle — measured, and the limits they set.** `tooling/verify-tarball.sh`'s
cap was 906 KiB with 415 B of headroom before this leg; the arm, the fourth flag and the port JSDoc
put a clean-build pack at 928 803 B, and the cap moved to **908 KiB** (929 792 B) with its own header
paragraph, the smallest whole-KiB step that admits the measurement (907 KiB = 928 768 B is under it).
After the exclusive-create verdict two consecutive clean-build measurements read **929 011 B** — 781 B
of headroom. The one field `portable-posix-policy.ts` gained put `dist/browser/tsgit.js` at
**190 003 B** gzipped against a 190 000 B limit; `.size-limit.json` now says **190.1 kB**
(`bytes-iec` parses it as 190 100 B) — 97 B of headroom, chosen so the ratchet keeps its sensitivity
rather than the 1 kB step first taken (`size-limit`'s kB is 1 000 B, and JSON carries no comment, so
this paragraph is the attribution). The measurement rule stands: `rm -rf dist .wireit`, a clean
`npm run build`, then the number — a stale chunk has produced a false failure here before.

**What the perf round measured on a quiet machine.** The POSIX arm's cost over 20 000 renames in one
process, both dists loaded: +0.35 % / −0.18 % / +0.61 % (noise; ~30 ns of added work against a
~97 µs floor). The memory adapter's 2048-deep chain — not this leg's code — seeds in 21.4 ms on the
branch against 10.9 ms on main (the two-phase ancestor walk doubles a constant, the class stays
O(depth²)), while the deep-walk test's own `readdir` fan-out is O(depth³), unchanged, and ~9.8 s on
both trees; on the checkout-shaped workload (20 000 files into a depth-4 tree) the branch is 23 %
faster. The three timeouts that test produced under a loaded full gate were load, not the code.

**The named measurement gaps — two closed, one standing.** Each was a gap in the *data*, not a guess
this design made; the second probe run (same two hosted runners, same harness shape, node v24.19 on
`windows-latest` and v24.20 on `ubuntu-latest`) closed the two that anything could have depended on.

| # | Gap | Status |
|---|---|---|
| **G1** | `writeExclusive` over a **dangling** symlink, through the adapter, on any OS — the first harness planted a **live** link only. | **Closed.** W13b measures it: `PERMISSION_DENIED` on Windows, `FILE_EXISTS` on ubuntu and darwin — the same arm as the live link on every OS, as the `lstat`-based verdict implied. The inference is now a measurement, and the raw-syscall row beside it (§8f) turned the guard from an error-code question into a correctness one. |
| **G2** | node's own Windows errno for `rmdir` on a **non-empty** directory. | **Closed.** `ENOTEMPTY` on `windows-latest`, the same as on linux and darwin. That is the fact ADR-825's option 2 rested on, and it is why the replace arm removes first and maps the errno instead of reading the directory. |
| **G3** | Which Win32 call node/libuv issues for `fs.rename` on Windows. | **Open, and nothing depends on it.** §8c says so explicitly; every claim in §8 is written against measured adapter outcomes and git's own compat source. It stays open deliberately — closing it would add a fact the design has no use for. |

The raw-syscall rows the second run added are recorded where they bind rather than only here: the
`rmdir` errno in §8d point 8, the exclusive-open behaviour over a dangling link in §8f. For the
record, the raw Windows `rename` errnos underneath the adapter's mapped codes are `EPERM` for a
directory onto an empty directory, `EPERM` for a directory onto a non-empty directory, `EPERM` for a
file onto an empty directory, and **success** for a directory onto a regular file — the destructive
row, at the syscall level.

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
| **DC-J** | How the node-side assertion for the new `write` / `rename` refusals is written, given that the contract suite also runs on `windows-latest` | **→ ADR-819, adopted as recommended (option 2).** Contract rows assert a structured `TsgitError` plus non-destructiveness, no code — the `:676` precedent; the strict node codes move to a new file under `test/integration/posix-only/`, run by the `posix-integration` job on ubuntu + macos. `writeExclusive` rows stay strict per ADR-812. The two **positive** rows (R20, R21) stay in the contract suite, because a positive row has no tolerant form. **The tolerant-row half is superseded by ADR-824** once the Windows column was measured; the posix-only file survives it. §5, **R25**, **R32** |

### Considered and not candidates — recorded by the second fold

That fold was a pure consequence of ADRs 816–819, and every question it opened resolved inside the
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
- **The errno literal's spelling in this document** was a tooling constraint, not a decision. The
  word has since landed in `cspell.json` with the implementation commit that introduced the literal,
  so the constraint is gone; the stand-in spelling is kept throughout for consistency with the rows
  and ADR text already written against it. §8's Windows rows report the same errno.

### Settled by the third decisions round — folded into the design above

The six choices the Windows revision raised. The emulation **itself** was never among them: the user
settled it directly (§8's opening), and "Way 2" — loosen the two contract rows and describe Windows
truthfully — was rejected, not deferred.

| # | Choice | Outcome |
|---|---|---|
| **DC-K** | Where the Windows-emulation gate lives | **→ ADR-820, adopted as recommended (option 1).** A fourth `PathPolicy` capability flag, `honoursRenameKinds` — `true` on `posixPolicy`, `false` on `windowsPolicy`, set through `PathPolicyCapabilities`. `honoursNoFollow` is not overloaded and `isSymlinkLeaf`'s equivalence note stands; the interface stays `@internal`. Refines ADR-046. §8e, **R48** |
| **DC-L** | How the emulated replace arm tells an empty destination directory from a non-empty one | **→ ADR-825, ratified by the user through the rule "the measurement decides": option 2.** The measurement was taken — node v24.19 on `windows-latest` rejects `rmdir` of a non-empty directory with `ENOTEMPTY`, as linux and darwin do — so the arm removes the destination with `rmdir` inside the same errno-mapped operation and lets `mapErrno` translate any failure; `readdir` is never called. It is `mingw_rename`'s own sequence. §8d points 8–9, **R50** |
| **DC-M** | The posix-only N15 row, which pinned `PERMISSION_DENIED` strictly and was red on the ubuntu cell | **→ ADR-821, adopted as recommended (option 1).** The row accepts `PERMISSION_DENIED` **or** `DIRECTORY_NOT_EMPTY`, keeps its non-destructiveness assertion, and names the axis in a comment — the contract suite's own `mkdir`-over-a-file precedent. The memory adapter's target does not change. Refines ADR-819. §8g, **R46** |
| **DC-N** | The two Windows `data.path` oddities — N19 anchoring `src` where POSIX anchors `dst`, N20 reporting `FILE_NOT_FOUND` where POSIX reports `NOT_A_DIRECTORY` | **→ ADR-822, adopted as recommended (option 1).** Both are documented in their Windows shape, pinned in the win-only file with `node:path`-built expectations, and the `rename` JSDoc calls the ancestor-fault report adapter- **and** platform-chosen. No adapter behaviour changes. Refines ADR-811 and ADR-813. §6, §8h(b), **R47**, **R49** |
| **DC-O** | What the port says about `atomicRename` once the emulated replace arm is two syscalls | **→ ADR-823, adopted as recommended (option 1).** The JSDoc scopes the atomicity claim — one step wherever the platform's rename honours the kind rules and for every non-replacing arrangement everywhere, two steps for the emulated empty-directory replacement, as git's own is — and states that the race degrades into `DIRECTORY_NOT_EMPTY`. `atomicRename` keeps delegating. Refines ADR-813. §6, §8d point 9, **R42** |
| **DC-P** | Whether the tolerant contract rows become strict, now that the Windows column is measured | **→ ADR-824, ratified by the user: option 3, as recommended.** Every `write` / `rename` refusal row in the shared contract suite asserts its exact code — `PERMISSION_DENIED`, `NOT_A_DIRECTORY`, `DIRECTORY_NOT_EMPTY` — and `assertRefusedWithoutCode`, left with no callers, is deleted. Supersedes ADR-819's tolerant-row clause and refines ADR-812. §5, **R25** |

### New — raised by this fold

**None.**

Every choice this fold makes is dictated by ADRs 820–825 or by a measurement those records already
weigh. Three places a reader might expect a fresh candidate, and why none is:

- **The plan value's name and the disappearance of the emptiness probe.** With `readdir` gone the
  arm no longer proves emptiness before acting, so `'replace-empty-directory'` would name something
  the code does not know; it becomes `'replace-directory'`. That is a naming consequence of ADR-825,
  not a choice with alternatives worth weighing.
- **Where the `DIRECTORY_NOT_EMPTY` assertion helper lives.** ADR-824 requires the code to be
  asserted and the file already has four helpers in one shape at `:78–95`; a fifth in the same shape
  is the only form that does not invent a second convention in the same file.
- **Whether `assertRefusedWithoutCode` is kept for future use.** It is not: after the four rows go
  strict nothing calls it, and an uncalled helper is dead code the repo's own rules refuse. Deleting
  it is the ADR's own wording, not a judgement this fold adds.

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
**memory** adapter only, so neither says anything about the browser adapter or about the node
adapter's Windows arm. That arm needs no sweep of its own, for a different reason: it is unreachable
from every tsgit command (§7), and on the two platforms every suite here runs on it is a no-op
(**R41**).

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
`it('Given …, When …, Then …')` style, run by **both** drivers. Strictness per §5, settled by
ADR-824: `writeExclusive` rows keep a strict code, every `write` / `rename` **refusal** row asserts
its exact code **plus** a non-destructiveness observation, and the two **positive** rows assert the
outcome.

🔴 **These rows have shipped; two of them are red on Windows and four of them are tolerant.** The
Windows revision changes **no arrangement** here — §8 makes the node adapter satisfy the two red rows
as written (**R45**) — and ADR-824 changes the assertions of the four tolerant ones, in the
tightening direction only (**R25**).

**The helper edit, exactly.** The four rows that call `assertRefusedWithoutCode` (`:277`, `:441`,
`:465`, `:487`) call code-checking helpers instead: `assertPermissionDenied` (`:83`) for the `write`
row and for the file-onto-directory `rename` row, `assertNotADirectory` (`:93`) for the
directory-onto-file row, and a **new** `assertDirectoryNotEmpty` for the directory-onto-non-empty-directory
row — the file has no `DIRECTORY_NOT_EMPTY` helper today, and the new one is written in the same
three-line shape as its four siblings, next to them. `assertRefusedWithoutCode` and its explanatory
comment (`:97–107`) are then deleted: nothing calls it, and an uncalled helper is dead code. Each row
keeps its own non-destructiveness assertions inline, because what "intact" means differs per
arrangement.

| Req | Row | Strictness |
|---|---|---|
| R9 | `Given an existing directory, When writeExclusive, Then throws FILE_EXISTS` | **strict**, via `assertFileExists` (`:88`) |
| — | `Given a file at a grandparent path segment, When writeExclusive, Then throws NOT_A_DIRECTORY` | **strict on the code**, via `assertNotADirectory` (`:93`), which asserts no `data.path`. Depth ≥ 2 only; an in-file comment records that depth 1 is adapter-dependent |
| R25 | `Given a directory at the target path, When write, Then it refuses and the directory is intact` | **strict** `PERMISSION_DENIED` (`assertPermissionDenied`) + `readdir(dir)` still lists the child, and the child reads back byte-identical |
| R25 | `Given a directory at the destination, When rename, Then it refuses and neither side moves` | **strict** `PERMISSION_DENIED` + `read(src)` unchanged, `readdir(dst)` unchanged |
| R25 | `Given a directory source and a file destination, When rename, Then it refuses and neither side moves` | **strict** `NOT_A_DIRECTORY` (`assertNotADirectory`) + the destination file's bytes unchanged, the source's children still under the source |
| R25 | `Given a directory source and a non-empty directory destination, When rename, Then it refuses and neither tree merges` | **strict** `DIRECTORY_NOT_EMPTY` (the new `assertDirectoryNotEmpty`) + each tree still holds exactly its own child |
| R20 | `Given a directory source and an empty directory destination, When rename, Then the subtree lands at the destination` | **positive row, outcome asserted** — kept because a positive row has no tolerant form (§5). It **is** the row that went red on Windows, and it is why §8 exists; the arrangement and the assertion do not change (**R45**) |
| R21 | `Given src === dst, When rename, Then it resolves and the entry is unchanged` — one file case, one non-empty-directory case | **positive rows**, outcome asserted, no code |

New rows go beside the existing `Given existing file, When writeExclusive, Then throws FILE_EXISTS`
(`:389`), `Given non-existent path, When writeExclusive, Then creates file` (`:403`), and the two
rename rows at `:357` / `:373`. None needs an addition to the `pathCalls` security table (`:34–76`) —
`writeExclusive` (`:39`), `write`, `rename-src` and `rename-dst` are all already rows there.

**The tolerant `mkdir` row at `:762` stays tolerant**, and does not conflict. It asserts `mkdir` over
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

**What ADR-824 leaves for this file to do.** Four of its codes are now asserted cross-adapter in the
contract suite, and the rows below keep them anyway — because the contract helpers check `data.code`
and nothing else (§5), while these rows check `data.path`, the `rootDir` arrangements the contract
driver cannot plant, the symlink occupants ADR-812 keeps out of the shared file, the three delegating
write surfaces, and the `reason` strings. The overlap is four codes; the rest of the file has no
counterpart anywhere.

**Rows** — every §1d / §1e arrangement on which darwin and linux agree, asserting `data.code` and,
where the variant carries one, `data.path`:

| From | Arrangement | Assert |
|---|---|---|
| W1 / W2 / W3 | `write` over an empty directory, a directory with children, the root | `PERMISSION_DENIED`, `path` = requested |
| W6 / W7 / W8 | `writeUtf8`, `writeStream`, `appendUtf8` over a directory | `PERMISSION_DENIED`, `path` = requested |
| W9 | `write` over a symlink leaf, live and dangling | `PERMISSION_DENIED`, `path` = requested |
| W4 / W5 | file at the immediate parent / at the grandparent | `FILE_EXISTS` / `NOT_A_DIRECTORY`, `path` = requested — the ADR-811 depth split, pinned so it cannot move silently |
| N1 / N2 / N3 | leaf → directory destination (empty, with children, from a symlink source) | `PERMISSION_DENIED`, `path` = **src** |
| **N15** | file → the containment **root** | 🔴 **not one code.** darwin `PERMISSION_DENIED`, ubuntu `DIRECTORY_NOT_EMPTY` — measured in §8a, and measured **red** by a direct ubuntu run of this file (§8g). Fixed per **ADR-821**: the row asserts the enumerated pair, `PERMISSION_DENIED` **or** `DIRECTORY_NOT_EMPTY`, plus non-destructiveness, with a comment naming the axis (a **non-directory** source whose destination is one of its own **ancestors**), the same shape the contract suite's `mkdir` row already uses (**R46**) |
| N4 / N5 / N6 | directory → regular file / → symlink destination | `NOT_A_DIRECTORY`, `path` = **src** |
| N8 / N9 / N10 / N16 | directory → non-empty directory, → its own parent, → the root | `DIRECTORY_NOT_EMPTY`, `path` = **src** |
| N7 / N20 / N21 / N22 / N23 / N24 | the positive rows: replace an empty directory, `src === dst` for a file and for a non-empty directory, fresh-name moves | they resolve, and the tree is where it should be |
| N11 / N12 | dst inside src, dst absent or a directory; the root renamed inside itself | `UNSUPPORTED_OPERATION`, `operation: 'filesystem'`, `reason` = the invalid-argument errno, **no `path`** |
| N18 / N19 | the two anchoring oddities this design deliberately does not fix — N18's `FILE_EXISTS` carrying **src**, N19's `NOT_A_DIRECTORY` carrying **dst** | both, so a future refactor of `runFs` anchoring cannot move them silently |

**N11b is excluded** — it is the one row where darwin and linux disagree (§1e), and this job runs on
both. It is pinned memory-side only. **N15 is now a second such row and is not excluded**: it is
already in the file, it is the arrangement §2b is about, and ADR-821 settles how it is written.

### Windows-side rows — the DI seam and the new win-only file

Two tiers, both specified row by row in **§8h**; only the tier facts are repeated here.

| Where | File | Runs on | Why it exists |
|---|---|---|---|
| **DI unit** | `test/unit/adapters/node/node-file-system-injected.test.ts` (existing, 3 618 lines) | **every** OS, in the `unit` project | 20 rows, one per branch of the new arm, built with `windowsPolicy` + `fakeFsOps` (ADR-046 / ADR-047 / ADR-820). This is the **mutation gate** for the Windows code: Stryker's runner is linux, so without the injected policy every mutant in `planRename` would be an unreachable-code survivor. Several rows assert *which* `fsOps` methods were **not** called, which is what pins the syscall budget of **R41** |
| **Real NTFS** | **new** `test/integration/win-only/node-fs-windows-rename-refusals.test.ts` | `windows-latest` only, `win-integration` project (`vitest.config.ts:64–65`, `ci.yml:417`) | the strict codes through the *composed* adapter against a real filesystem — the mirror of what the posix-only file does for POSIX, and the only place the emulation meets NTFS. Tier rules apply: `@proves` header, GWT split, AAA, `sut`, and **no `vi.*` at all** (`overMockedIntegration` threshold 0). Symlink rows are guarded by the directory's existing `canCreateSymlinks()` probe with an honest `skip()` |

**One trap, stated where the tests are written as well as in §8h:** on Windows the adapter reports
**joined** paths, which carry `\` (N10's `p\s`, N20's `p\f`). Every path expectation in the win-only
file is built with `node:path`, never with a `/`-spelled literal, and any predicate on `readlink`
output normalises separators before matching (**R49**).

**Tier share.** The win-only file is one more file in the `integration` tier the audit counts by
file; that tier sits far below its warn-above threshold with or without it, and this adds one.

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
| `src/ports/file-system.ts` `rename` / `atomicRename` JSDoc — **Windows** | the kind matrix holds on node and memory on **every** platform, emulated on Windows in two steps for the empty-directory replacement, so the atomicity sentence is scoped (ADR-823); the ancestor-chain path is adapter- **and** platform-chosen on node — `dst` on POSIX, **`src`** on Windows — where the text says `dst` flatly today (ADR-822). **The three sentences are written out verbatim in §6**; the implementation copies them rather than re-phrasing. **R47** | implementation |
| `src/ports/file-system.ts` `writeExclusive` JSDoc — **Windows** | no edit needed: ADR-813's occupancy sentence already names *"a symbolic link, including a dangling one"*, and §8f makes it true on Windows for the first time. Re-read at implementation time to confirm it still says so. **R44**, **R47** | implementation |
| `reports/api.json` | regenerated in the commit that changes the port JSDoc — the `docs:json` pre-push gate refuses a stale report | implementation |
| `docs/design/ports-and-adapters.md:45` | *"`rename` atomically replaces target … Node adapter on Windows uses `fs.rename` (which does replace on modern Windows + NTFS)"* — **measured false in both halves**: Windows replaces a *file* destination with a *directory* source (N4 / N5 / N6) and refuses **every** directory destination (N7 / N8), and after this change the adapter refuses the first and emulates the second | docs phase |
| `docs/design/ports-and-adapters.md` §7.1 node bullet list | has no `rename` bullet at all; add one naming the POSIX kind rules, the platforms on which they are the syscall's and the platform on which they are emulated, and the two-step replacement | docs phase |
| `docs/understand/architecture.md:134` | *"Uniform occupied-name refusals"* — extend to say the uniformity now holds **across platforms** as well as across adapters, because the node adapter emulates the kind rules where the OS does not enforce them | docs phase |
| `tooling/verify-tarball.sh` | one more documented cap raise, measured on a clean build (`rm -rf dist .wireit` first) — §8i | implementation chore |

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

**Windows round, cycle 3 (fix delta, final — max cycles).** Every cycle-2 finding verified resolved.
Security: HIGH ×1 (the narrowed restoration catch's rethrow arm was executed by no row — the one
uncovered branch of the unit project, coverage gate red), LOW ×2 applied (a non-errno restoration
failure surfaces in place of the rename failure, now stated; the fallback's `realpath(dst)` reads a
vanished destination as another entry instead of naming `src`), PROBE ×1 recorded (one directory
under two namespaces on a no-inode volume). Code: HIGH ×1 (the same coverage gap), LOW ×6 applied
(the byte-identical row pins that no probe runs; a stale row title; the N22 cost row split; the §8i
budget cells; the fallback compares canonical paths exactly, not case-folded; the tolerant
`realpath`). Tests: HIGH ×2 and MEDIUM ×2 — four hand-verified survivors on the two identity guards
and the restoration arm (`realSrc === realDst` forced false; inode-first forced false; `&&` → `||`
on the inode reports; the rethrow arm forced off) — each killed by a row that fails on its mutant
(the case-differing two-directory row with inodes, the mixed-report row, the never-probed pin, the
non-errno restoration row); LOW ×2 applied (two row titles). No fourth reviewer pass ran: the fixes
are session-verified with rows that fail on the pre-fix code, and the phase gate is the arbiter.

**Windows round, cycle 2 (fix delta).** All fifteen cycle-1 findings verified resolved. Security:
MEDIUM ×1 (the equality mask plus an undecided identity sent `rename(dir, dir)` into the replace arm
on inode-less volumes — fixed by the byte-identical short-circuit and the canonical-path fallback),
LOW ×2 applied (bigint inode compare; the restoration's catch narrowed to errno failures), LOW ×1
RULED-OUT (the failure-path `mkdir` inside the pre-existing window), PROBE ×1 (the trailing-dot
win-only row proves a no-op, not that the identity path fired — the DI identity row is the R51
pin). Code: MEDIUM ×2 (the same self-rename hole; the linux ancestor exception was hung on "node
and memory" — now scoped to the node adapter), LOW ×6 applied (restore only what was removed; the
`atomicRename` sentence names the parent-chain `mkdir`; the `finally` comment re-anchored; the dead
`Number.isInteger` conjunct gone with the bigint stats; a differing-device row; the immediate-parent
symlink clause narrowed to links that do not resolve to a directory). Tests: HIGH ×1 (the same
hole, with its two rows), MEDIUM ×1 (`a.dev === b.dev` → `true` survived every row — a
different-device row now kills it), LOW ×3 applied (non-errno removal row; the success row pins
"no restore"; the `entry()` fabricator typed and bigint), PROBE carried (the trailing-dot row).

**Windows round, cycle 1.** Four dimensions on `7be746cf..e72cc711`. Security: MEDIUM ×3
— string identity misses Win32 name aliases (R51, point 3), the post-removal residue (R52, point 9),
no unit pin on the removal's target (point 11) — LOW ×2 (`ENOENT` on the removal → the rename
proceeds; the residual exclusive-create window, documented in §8f). Code: MEDIUM ×2 — the port's
"on every platform … PERMISSION_DENIED" clause needed the linux ancestor exception, and the ancestor
clause conflated the immediate parent (`FILE_EXISTS` carrying src) with higher ancestors — LOW ×4
(the `atomicRename` sentence's reason, three stale guard comments, the verdict's doc comment, the
redundant symlink disjuncts — all applied). Tests: MEDIUM ×1 (converging with security's target pin)
— LOW ×5 applied (strict cache row, honest `posixPolicy` fakes, shared helpers, hoisted errno
factories, N11c) — and the PROBE that turned the verdict into a boolean (point 10). Perf: LOW ×1
(the bundle limit, applied), everything else RULED-OUT with measurements (§8i). Every MEDIUM was fixed
with rows that fail on the pre-fix code.

### Gates

Per-part: `npx vitest run <touched test files>`, `npm run check:types`,
`./node_modules/.bin/biome check <touched files>`, `npx cspell --no-progress <touched files>` **bare**
(the wireit-cached scripts report `Ran 0 scripts and skipped 1`, which reads exactly like a pass).
Phase: `npm run validate`, run bare into a file with the exit code read from that file — never
through a pipe, never `--no-verify`. `npm outdated` is re-measured before the full gate (eight
excepted packages, `.claude/workflow.md`).

Coverage stays at 100 % on `src/adapters/memory/**` **and on `src/adapters/node/**`** — both are in
`vitest.config.ts`'s `coverage.include`, so every branch of `planRename` and of the new
exclusive-create assert needs a row in the DI suite (§8h(a)) or the gate goes red on a host that
never takes the Windows arm. The mutation gate covers both too (`stryker.config.mjs` mutates all of
`src` except `index.ts`, `*.d.ts` and `src/adapters/browser/**`).

**What a green `npm run validate` on darwin now proves, and what it still cannot.** ADR-824 moves
four codes into the shared contract suite, which the `unit` project runs locally with both drivers —
so a local green run proves the **memory** adapter's codes strictly *and* the node adapter's **POSIX**
codes strictly, for `PERMISSION_DENIED`, `NOT_A_DIRECTORY` and `DIRECTORY_NOT_EMPTY`, on the same
arrangements CI will re-run on ubuntu and Windows. What it still cannot prove is any **Windows**
code: those reach the local host only through the DI rows of §8h(a), which assert the arm's decisions
against a fake `FsOperations` rather than against NTFS. The real-filesystem Windows proof stays
CI-only — the `windows-latest` unit cell for the contract rows, the `win-integration` job for the
win-only file — and the ubuntu proof of the N15 pair stays CI-only for the same reason. Nothing about
the strictness change makes a local run stand in for either.

**Four gates `npm run validate` does not run, each of which this change needs.** Verified against
`package.json`'s `wireit.validate.dependencies`, which lists none of `test:e2e`,
`test:posix-integration` or `test:win-integration`.

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
3. **The Windows leg — now two gates, neither runnable on this host.** The contract suite runs on the
   `windows-latest` unit matrix cell, and the new win-only file runs in the `win-integration` job
   (`ci.yml:417`, `npm run test:win-integration` → `vitest run --project win-integration`). Neither
   can be executed locally on darwin, so the **local** proxy for both is the DI unit rows of §8h(a),
   which run in the ordinary `unit` project on every host and cover every branch of the new arm.
   That is a real limitation, stated rather than papered over: the first genuine NTFS evidence for
   this change arrives on CI. Push early, read the `win-integration` job, and do not merge on a
   `windows-latest` cell that has not run.
4. **`npm run test:posix-integration` is load-bearing this time, not just prudent.** The N15 row
   (§8g) is latently red on the ubuntu cell and has never executed there, because
   `posix-integration` `needs: [changes, unit-tests]` and `unit-tests` has been red. Run it locally
   on darwin (which is the passing platform) *and* read the ubuntu cell on CI before the PR — a
   green local run proves nothing about the row that is actually broken.

**Two chores the Windows leg adds.** (a) `reports/api.json` is regenerated in the commit that
changes the port JSDoc — the `docs:json` pre-push gate refuses a stale report and a cached
`validate` will not catch it. (b) `tooling/verify-tarball.sh`'s 906 KiB cap has **415 B** of
headroom against the last measured pack, which the new adapter code and the R47 prose will exceed:
one documented raise, measured on a **clean** build (`rm -rf dist .wireit`, then `npm run build`) —
a stale chunk has produced a false reading here before. §8i.

**One dictionary chore — done.** The memory adapter carries POSIX's invalid-argument errno as a
string literal (ADR-817), so `cspell.json` gained that one word in the implementation commit that
introduced it — inserted between the `effectful` and `EISDIR` entries, file not re-sorted, never a
`cspell:disable` comment. The Windows arm introduces no new literal: it delegates the inside-source
arrangement to the platform, which reports the same errno (§8d, point 4). This document keeps the
stand-in spelling for consistency with the rows already written against it.

---

## Out of scope

- 🔴 **Node-adapter behaviour — this bullet no longer holds as written.** It read: *"Nothing in §1b,
  §1d or §1e changes on the node side."* §8 changes the node adapter on **one platform**: `rename`
  gains the POSIX kind rules on a policy whose own rename does not enforce them (N4 / N5 / N6 refuse,
  N7 replaces, N8 / N9 / N10 / N16 re-code), and `writeExclusive` reports `FILE_EXISTS` rather than
  `PERMISSION_DENIED` for a symlink leaf there (W13 / W13b). What **is** still out of scope on the node side:
  every POSIX outcome in §1b / §1d / §1e is byte-for-byte unchanged and pays no syscall for the new
  arm (**R41**); ADR-721 (read containment) and ADR-782 (`readSlice` as the pass-2 seam) are
  untouched; and the two `data.path` anchoring oddities stay as measured, on both platform families —
  N18's `FILE_EXISTS` carrying `src`, and N19's `NOT_A_DIRECTORY` carrying `dst` on POSIX and `src` on
  Windows (ADR-822, **R49**).
- **Normalising the Windows `data.path` oddities.** N19's anchor and N20's code differ from POSIX's
  because a different call fails first inside the adapter, not because of a considered contract. They
  are documented and pinned, not emulated — ADR-822, option 1.
- **N15 on the memory adapter.** ubuntu and darwin disagree about a non-directory renamed onto one of
  its own ancestors (§8g), so there is no single node behaviour to match, exactly the ADR-811 /
  ADR-817 shape. Memory keeps `PERMISSION_DENIED`; only the posix-only node row is fixed (ADR-821).
- **Replicating git-on-Windows's `EISDIR` for a directory at an exclusive-create leaf** (probe L3).
  The adapter reports `FILE_EXISTS` there on all three OS, matching git-on-POSIX, the port contract
  and ADR-813; git's own Windows compat layer produces `EISDIR` as an artefact of mapping `EACCES`
  on a directory leaf (`mingw.c:899–901`) and its lockfile code treats the two identically. Recorded
  in §8b as a deliberate non-replication.
- **`write-pack-artifacts.ts` production code.** ADR-789 governs its input shape; this change edits
  that module's **tests** only.
- **A new interop test.** §7 — the port contract is the oracle and the memory adapter has no
  cross-tool surface. The node adapter's Windows behaviour **does** change, but its faithfulness pin
  is the three-OS `git` probe recorded in §8b, not a new interop test: the arrangements git can
  reach are `git init --separate-git-dir` (S3 / S4) and the lock-file occupants (L1 / L2), neither of
  which is a tsgit command. An interop test could not carry the Windows claim anyway: the
  `integration` job — which is where `*-interop.test.ts` runs — is `runs-on: ubuntu-latest`
  (`ci.yml:362–365`), so it would assert the leg that was never in doubt.
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
  same ADR-811 family, a different method. The contract suite's tolerant row (`:762`) already absorbs
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
