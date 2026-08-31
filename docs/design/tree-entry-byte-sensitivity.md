# Design — tree entry-name byte-sensitivity unification

> Brief: tsgit's tree-object read paths disagree with each other, and with canonical
> git, about which entry-name **bytes** and which malformed **modes** are refused.
> Unify them on a byte-level predicate so every read path refuses exactly what git
> refuses and accepts exactly what git accepts — never by weakening the byte-level
> cursor path.
> Status: **decided**. All ten load-bearing choices were ruled in the decisions phase and
> are recorded as [ADR-748](../adr/748-tree-byte-sensitivity-spans-every-decoding-read-path.md)
> … [ADR-757](../adr/757-file-path-stays-a-string-and-the-sibling-collapse-is-asserted.md);
> [ADR-723](../adr/723-cursor-descent-keeps-the-duplicate-name-refusal.md) is superseded in
> part. This revision rewrites the body against what was ratified — three rulings went
> against the original recommendation (the `TreeEntry` shape, the duplicate refusal, the
> name-shape refusals) and one published measurement was wrong and is corrected (§3).
> **Five** new choices the revision surfaced are listed under **Decision candidates**;
> nothing else there is open.
> **This ships as a major** — see *Release and migration*.

## Context

### What exists today — four implementations of one check, three of them defective

| # | Site | Symbol | Lines | Operates on | Verdict |
|---|---|---|---|---|---|
| 1 | `src/domain/objects/tree.ts` | `parseTreeContent` | 31–73 | **decoded string** (`decode()`) | defective |
| 2 | `src/application/primitives/internal/flatten-raw.ts` | `validatedName` | 194–200 | **decoded string** (`cursorName()`) | defective — the same bug, copied |
| 3 | `src/domain/fsck/validate-tree.ts` | `parseTreeEntriesTolerant` + `checkNameFaults` + `treeEntrySortKey` | 52–129, 90–98 | **decoded string** (module-scope `DECODER`) | defective — the same bug, four consequences |
| 4 | `src/application/primitives/internal/resolve-tree-path.ts` | `isInvalidEntryNameBytes` | 222–250 | **raw bytes** | correct *about bytes* — the model the other three were to unify on. ADRs 752/753 then removed the question it answers, so the function is **deleted** rather than promoted (§3a) |

Site 4 is the only one that never decodes before deciding. Its doc comment already
names itself the "byte-cursor counterpart to `parseTreeContent`'s
`name === '' || name === '.' || name === '..' || name.includes('/')`", and site 2's
comment says it repeats those checks "with the identical reason string" — the
duplication is documented, just never reconciled.

Note that `validate-tree.ts` declares its **own** local `interface TreeEntry`
(L30–35, `{ mode: string; name: string; sha; offset }`), unrelated to the published
`domain/objects` `TreeEntry`. Two types, one name; ADR-749 is about the published one,
and the fsck-local one changes regardless (it must carry raw spans instead of decoded
strings — §5d).

### Root cause 1 — the BOM-stripping decoder

`src/domain/objects/encoding.ts` L72: `const textDecoder = new TextDecoder();`.
`ignoreBOM` defaults to **false**, which in the WHATWG encoding spec means *strip* a
leading U+FEFF. Every `decode()` call treats its slice as a fresh stream start, so a
BOM sitting at the start of a name is silently eaten.

The repo already carries the fix precedent in-tree: `decodePreservingBom()` (L88–92),
built on `new TextDecoder('utf-8', { ignoreBOM: true })`, added for commit/tag headers
with a comment explaining that git stores those bytes verbatim. Tree entry names were
never migrated.

Measured (Node 22.22.3, this worktree):

| bytes | `decode()` | length | re-encoded length | `decodePreservingBom()` | re-encoded length |
|---|---|---|---|---|---|
| `EF BB BF` | `""` | 0 | 0 | `"﻿"` | 3 |
| `EF BB BF 61` | `"a"` | 1 | **1** (was 4) | `"﻿a"` | 4 |
| `EF BB BF 2E` | `"."` | 1 | 1 | `"﻿."` | 4 |
| `EF BB BF 2E 2E` | `".."` | 2 | 2 | `"﻿.."` | 5 |
| `EF BB BF EF BB BF` | `"﻿"` | 1 | 3 | `"﻿﻿"` | 6 |

Only the *first* BOM is stripped, which is why the last row loses three bytes and not
six — the defect is position-sensitive, not a uniform transform.

### Root cause 2 — lossy replacement characters

`decode([FF])` and `decode([FE])` both yield `"�"`, and they compare **equal**
(measured: `decode([0xFF]) === decode([0xFE])` is `true`). Every string-keyed duplicate
`Set` and every string-derived sort key collapses all invalid-UTF-8 names onto one
value. Re-encoding inflates each such byte to three (`EF BF BD`).

### Root cause 3 — the mode/name check is one tier where git has two

git refuses a tree in two structurally distinct places, and says so in two distinct
messages (§1b). tsgit's cursor path already reproduces the split
(`tree-cursor.ts::scanMode` → `INVALID_TREE_ENTRY 'malformed mode'` at the parse tier,
`file-mode.ts::matchFileModeBytes` → `INVALID_FILE_MODE` at emit time). Sites 1 and 3
collapse it:

- `parseTreeContent` reaches a single `normalizeFileMode(modeStr)` **after** the name
  check and the hash-bounds check, so a non-octal mode surfaces as `INVALID_FILE_MODE`
  where git and the cursor both say "malformed mode".
- `validate-tree.ts::parseTreeEntriesTolerant` never inspects mode bytes at all, so a
  non-octal mode falls through to `VALID_MODES.has(normMode)` and is reported as
  `badFilemode` where git reports `badTree`.

The same collapse hits the **empty name**: git refuses it at the parse tier
(`badTree`); `validate-tree.ts` reports `emptyName`.

### Constraints this design inherits

**The ten ADRs are the authority.** Where this document and an ADR disagree, the ADR wins.

| ADR | Binds |
|---|---|
| [748](../adr/748-tree-byte-sensitivity-spans-every-decoding-read-path.md) | scope — all four sites, byte predicate extracted from site 4 |
| [749](../adr/749-tree-entry-is-branded-and-minted-only-through-its-factory.md) | `TreeEntry` is branded, carries `nameBytes`, minted only through its factory |
| [750](../adr/750-entry-name-byte-faults-are-one-classifier-consumers-map.md) | one byte classifier, each consumer maps the fault to its own outcome |
| [751](../adr/751-byte-keys-are-built-from-char-codes-not-a-text-decoder.md) | byte keys from char codes, never a `TextDecoder` |
| [752](../adr/752-tree-read-paths-accept-duplicate-entry-names.md) | read paths accept duplicate names; descent first-wins, materialisation last-wins, fsck detects |
| [753](../adr/753-name-shape-refusals-move-to-worktree-materialisation.md) | `.`/`..` refused at materialisation, not parse; the separator refusal is dropped |
| [754](../adr/754-tree-parse-tier-separates-malformed-from-bad.md) | parse tier (`malformed mode`, `empty filename` → `badTree`) before check tier (`badFilemode`) |
| [755](../adr/755-the-empty-name-fsck-message-id-is-removed.md) | `emptyName` msg-id and its severity row are deleted |
| [756](../adr/756-tree-byte-parity-pins-live-in-one-interop-suite.md) | one new interop suite carries the whole matrix, claiming `tree` |
| [757](../adr/757-file-path-stays-a-string-and-the-sibling-collapse-is-asserted.md) | `FilePath` stays a string; the sibling collapse is asserted at the `FlatTree` level |

- **ADR-226 / prime directive** — observable behaviour byte-for-byte unless an ADR
  diverges. Here that binds *which trees are refused*, *the refusal class and data*,
  *the fsck msg-id and severity*, and *the bytes `serializeTreeContent` re-emits*.
- **ADR-249 / structured data only** — no rendered `ls-tree` line leaves the library.
  Display parity is proven by reconstructing git's output from structured fields
  inside the interop test.
- **[ADR-723](../adr/723-cursor-descent-keeps-the-duplicate-name-refusal.md) is now
  superseded in part.** ADR-752 takes over the duplicate-entry-name refusal on read
  paths and the unpinned premise it rested on. What ADR-723 still governs, and what
  this design therefore still obeys: (i) the cursor's own unconditional scan stays
  minimal — putting a name check inside it regressed `raw-tree-diff.ts` against real
  git, pinned by `test/integration/tree-diff-corrupt-interop.test.ts`'s embedded-`/`
  row; (ii) name validation is re-implemented per consumer rather than inside
  `TreeCursor`; (iii) the raw merge-join deliberately carries neither check; (iv) the
  whole mode-tier addendum, which ADR-754 *acts on* rather than reverses. Every
  citation of ADR-723 in this document is scoped to (i)–(iv).
- **[ADR-747](../adr/747-reflog-rewrite-channel-is-byte-faithful.md)** was the shape
  precedent argued in the decisions phase; ADR-749 took it further than reflogs did —
  the byte view is not an optional second field but the authoritative one, and the
  type is branded so the pair cannot be built inconsistently.
- **`TreeEntry` is published API.** It is re-exported through
  `src/domain/objects/index.ts`; the standalone identifier `\bTreeEntry\b` appears in
  **26** source files (54 files match the bare substring, the rest being
  `WalkWorkingTreeEntry`, `compareWorkingTreeEntry` and friends), and `reports/api.json`
  carries **133** matches for the substring — **110** for this type, less 12
  `ShowTreeEntry` and 11 `FlatTreeEntry`. Changing its shape puts api.json regeneration
  on the critical path and makes this release a major.
  Note `src/public-types.ts:25` re-exports a *different* `TreeEntry` — the snapshot
  wrapper from `application/primitives/snapshot/tree-entry.ts` — as the explicit winner
  over the `domain/objects` wildcard. That type is unaffected; the domain type reaches
  consumers through `domain/objects/index.ts` and the `writeTree`/`readTree` signatures.
- **`serializeTreeContent` carries a `@writes surface: tree / kind:
  equivalent-under-readback / format: git-tree-object` header** (tree.ts L1–10), and
  `test/integration/tree-interop.test.ts` claims `interopSurface: tree`. ADR-749 makes
  that header honest for entry-name bytes; the sort normalisation keeps it
  `equivalent-under-readback` (see Out of scope).
- Prior art: [ADR-518](../adr/518-raw-merge-join-git-parity-validation.md) (the raw
  merge-join's refusal surface), [ADR-520](../adr/520-tree-cursor-home-domain-objects.md)
  (`parseTreeContent` is the cursor's differential oracle),
  `docs/design/perf-remediation-2026-08.md` (DC-11).

---

## Requirements

No requirements artefact exists for this item; these are self-supplied and verifiable.

When this ships:

1. Every tree read path decides refusals from **raw name bytes**. No refusal, no
   duplicate key, no sort key and no length count is derived from a decoded string.
   Verified structurally: no `decode`/`TextDecoder` result feeds a comparison in any of
   the four sites (ADR-748).
2. For every class in the §1b matrix, each tsgit read surface agrees with the git
   surface it corresponds to — or the disagreement is a **ratified decision** with a
   live assertion of the difference, never a silence. After ADRs 752 and 753 the only
   surviving read-path divergences are the pre-existing `INVALID_FILE_MODE` one
   (octal-but-unrecognised modes) and the `FilePath` collapse (ADR-757).
3. `parseTreeContent` no longer changes the bytes it read:
   `serializeTreeContent(parseTreeContent(b), hash)` equals `b` for any `b` whose
   entries are already in git sort order — including entries whose names carry a BOM
   or invalid UTF-8. `TreeEntry.nameBytes` is what serialisation, sorting and
   comparison read (ADR-749); nothing reads `name` to make a decision.
4. No two distinct on-disk names ever collapse into one parsed entry, one duplicate
   finding, or one sort key. This requirement stops at the **tree-object layer** — it
   does *not* extend to `FlatTree` / `FilePath` keys, whose string nature is ADR-757's
   explicitly-bounded and asserted limit.
5. The parse tier runs first and matches git's on every site: an empty or non-octal
   mode, and an empty name, are **parse-tier** faults; an octal-but-unrecognised mode
   is a **check-tier** fault. fsck classifies the first two as `badTree` and the third
   as `badFilemode`. `parseTreeContent` and `openTreeCursor` emit identical error data
   for every parse-tier fault (ADR-754).
6. The object-parse layer refuses **no name shape and no duplicate** — not `.`, not
   `..`, not an embedded separator, not a repeated name. (The empty name is not a
   shape: it stays a parse-tier structural refusal, per requirement 5.) `.` and `..`
   are refused where git refuses them, at worktree materialisation and index
   construction; the embedded separator is refused nowhere outside fsck
   (ADRs 752, 753).
7. Path descent resolves a duplicated name **first**-wins; worktree materialisation and
   index construction keep **last**-wins. Both tie-breaks are asserted against git, per
   surface (ADR-752).
8. fsck's `largePathname` counts **raw** name bytes (measured boundary: 4096 accepted,
   4097 refused, §1b), and `treeNotSorted` compares **raw** name bytes with the virtual
   trailing slash for directories.
9. `TreeCursor`'s scan verdicts, `matchFileModeBytes` and `raw-tree-diff.ts` are
   unchanged. ADR-723's pins in `tree-diff-corrupt-interop.test.ts` stay green without
   edits. The two mechanical edits the cursor module does take are named in §6.
10. Every row of §1b is pinned by one case in
    `test/integration/tree-entry-bytes-interop.test.ts`, spawning real git with `GIT_*`
    scrubbed and signing off (ADR-756).
11. `npm run validate` green: 100 % line/branch/function/statement coverage on the
    touched domain code, 0 killable mutants, `reports/api.json` regenerated, and the
    landing commit and PR title carrying the conventional `!` breaking marker.

---

## Design

### 1. The pinned matrix — this IS the parity contract

#### 1a. Environment

`git version 2.55.0`. Every probe ran in a `mktemp -d` throwaway repository, never the
worktree: `GIT_DIR`, `GIT_WORK_TREE`, `GIT_INDEX_FILE`, `GIT_OBJECT_DIRECTORY` and
`GIT_COMMON_DIR` unset; `HOME` and `XDG_CONFIG_HOME` pointed at fresh directories
inside the tmp root; `GIT_CONFIG_NOSYSTEM=1`; `commit.gpgsign=false`,
`tag.gpgsign=false`, `gc.auto=0`; `git init -b main`.

Fixture: two blobs, `one\n` → `5626abf0f72e58d7a153368ba57db4c673c0e171` and `two\n` →
`f719efd430d52bcfc8566a43b2eb655688d38871`. Trees are hand-built as raw
`<mode> SP <name-bytes> NUL <raw-oid>` records and written two ways —
`git hash-object -w -t tree --stdin` (which runs git's **write-side fsck**) and the
same with `--literally` (which does not), so read-side behaviour is observable for
inputs git refuses to create.

Hash width: every probe is SHA-1. Nothing in the design is SHA-1-specific — both the
cursor and `parseTreeContent` take `digestLength` from `ctx.hashConfig` — but the
interop suite must still run at least one row under `--object-format=sha256` so that
stays a measurement rather than an inference.

#### 1b. git has two tiers, and the tier decides everything

The single most load-bearing measurement in this document: git refuses a tree in two
different places, and **only the parse tier is a read-path refusal**.

The table below records **git's** behaviour and does not change. What the ratified
decisions changed is the *role* each row plays in the parity contract — which rows are
co-refusals, which are per-surface tie-break parity, and which are plain acceptance.
That mapping is stated immediately after the table.

- **Parse tier** (`decode_tree_entry`): an empty name, or a mode that is empty or
  contains a non-octal byte. Refused by *every* consumer — `ls-tree`, `diff-tree`,
  `read-tree`, `fsck`, `hash-object`. Message: `error: malformed mode in tree entry` /
  `error: empty filename in tree entry`, then `badTree: cannot be parsed as a tree`.
- **Check tier** (`fsck_tree`): everything else. Enforced by `git fsck` and by
  `hash-object`'s write-side fsck. **Not enforced on any read path.**

| # | class | fixture | `hash-object -w` (write fsck) | `ls-tree` (read) | `read-tree` + `checkout-index` | `git fsck` | `git fsck --strict` |
|---|---|---|---|---|---|---|---|
| 1 | baseline | `100644 a` | 0 | `100644 blob …\ta` | index `a`, file `a` | 0 | 0 |
| 2 | BOM + `a` | `EF BB BF 61` | **0 — accepted** | `"\357\273\277a"` (raw bytes with `-z`) | index `﻿a`, file created | 0 | 0 |
| 3 | bare BOM | `EF BB BF` | **0 — accepted** | `"\357\273\277"` | index `﻿`, file created | 0 | 0 |
| 4 | two invalid-UTF-8 names | `FE` and `FF` | **0 — accepted** | two entries | two index entries; `checkout-index` fails per file with `Illegal byte sequence` (APFS, filesystem-level) | 0 | 0 |
| 5 | BOM + `.` | `EF BB BF 2E` | **0 — accepted** | `"\357\273\277."` | index + file | 0 | 0 |
| 6 | BOM + `..` | `EF BB BF 2E 2E` | **0 — accepted** | `"\357\273\277.."` | index + file | 0 | 0 |
| 7 | `a` and BOM + `a` | both | **0 — accepted, distinct** | two entries | two index entries, two files | 0 | 0 |
| 8 | `40000` → a blob | `40000 d <blob>` | 0 | non-recursive: `040000 tree …\td`. **`ls-tree -r` exits 1** with `error: Object … not a tree` | — | — | — |
| 9 | name `.` | `100644 .` | 128 `hasDot: contains '.'` | **accepted**, `\t.` | `read-tree` **128** `error: invalid path '.'` | 0 (warn) | **1** `hasDot` |
| 10 | name `..` | `100644 ..` | 128 `hasDotdot` | **accepted** | `read-tree` **128** `error: invalid path '..'` | 0 (warn) | **1** `hasDotdot` |
| 11 | name `a/b` | `100644 a/b` | 128 `fullPathname` | **accepted**, `\ta/b` | **accepted** — index entry `a/b`, materialises `a/b` as a nested path | 0 (warn) | **1** `fullPathname` |
| 12 | names `/a`, `a/`, `/`, `a//b` | — | 128 `fullPathname` (all four) | — | — | — | **1** `fullPathname` |
| 13 | empty name | `100644 ` | 128 `empty filename in tree entry` → `badTree` | **128** `fatal: empty filename in tree entry` | — | **1** `badTree` | **1** `badTree` |
| 14 | duplicate `a`, `a` | two entries | 128 `duplicateEntries` | **accepted**, both listed | **accepted** — index keeps the **last** (`f719efd4…`) | **1** `duplicateEntries` | **1** `duplicateEntries` |
| 15 | duplicate `a` with different modes | `100644 a` + `40000 a` | 128 `duplicateEntries` | — | — | **1** `duplicateEntries` | **1** — the key is the **name only**, not (name, mode) |
| 16 | mode `0100644` | — | 128 `zeroPaddedFilemode` | **accepted**, shown as `100644` | index mode `100644` | 0 (warn) | **1** `zeroPaddedFilemode` |
| 17 | mode `040000` | — | 128 `zeroPaddedFilemode` | shown as `040000 tree` | — | 0 | **1** |
| 18 | mode `777777` | — | 128 `badFilemode` | **accepted**, canonicalised to `160000 commit` | index mode `160000` | **0** | **0** — `badFilemode` stays a warning even under `--strict` |
| 19 | mode `10064a` | — | 128 `malformed mode in tree entry` → `badTree` | **128** `fatal: malformed mode in tree entry` | — | **1** `badTree` | **1** `badTree` |
| 20 | empty mode (leading space) | ` 100644 a` | 128 `malformed mode` → `badTree` | **128** `fatal: malformed mode in tree entry` | — | **1** `badTree` | **1** `badTree` |
| 21 | name 4096 bytes | 4096 × `x` | **0 — accepted** | — | — | 0 | **0** |
| 22 | name 4097 bytes | 4097 × `x` | 128 `largePathname` | — | — | 0 (warn) | **1** `largePathname` |
| 23 | name 4096 bytes as 2048 × `C3 A9` | — | **0 — accepted** | — | — | 0 | **0** — the count is **raw bytes**, not code points |
| 24 | name 4098 bytes as 1366 × `E2 82 AC` | — | 128 `largePathname` | — | — | 0 | **1** |
| 25 | sorted: `a` then BOM + `a` | — | **0 — accepted** | — | — | 0 | **0** |
| 26 | reversed: BOM + `a` then `a` | — | 128 `treeNotSorted` | — | — | **1** `treeNotSorted` | **1** |
| 27 | sorted: `FE` then `FF` | — | **0 — accepted** | — | — | 0 | **0** |
| 28 | reversed: `FF` then `FE` | — | 128 `treeNotSorted` | — | — | **1** | **1** |

Rows 25–28 pin the sort order as a **raw byte** comparison: `61` sorts before
`EF BB BF 61`, and `FE` before `FF`.

**Re-pinned 2026-08-30, git 2.55.0**, in a fresh `mktemp -d` under the §1a discipline,
for the classes the ratified decisions made load-bearing. Verbatim results:

| probe | measured |
|---|---|
| tree = `a`→blobA, `BOM+a`→blobB; `git ls-tree` | both listed; the second rendered `"\357\273\277a"` |
| `git rev-parse <tree>:a` | `5626abf0…` (blobA) — **does not match the `BOM+a` entry** |
| `git rev-parse <tree>:<BOM>a` | `f719efd4…` (blobB) — git compares bytes |
| `git read-tree` + `ls-files -s` | two index entries, second shown `"\357\273\277a"` |
| tree = `a`→blobA, `a`→blobB; `ls-tree` | both listed |
| `git rev-parse <tree>:a` on that tree | `5626abf0…` — the **first** |
| `git read-tree` + `ls-files -s` on that tree | exit 0, one entry `f719efd4…` — the **last** |
| `git fsck` on that tree | `error in tree …: duplicateEntries: contains duplicate file entries` |
| name `.` | `ls-tree` exit 0 lists it; `read-tree` **exit 128** `error: invalid path '.'` |
| name `..` | `ls-tree` exit 0 lists it; `read-tree` **exit 128** `error: invalid path '..'` |
| name `a/b` | `ls-tree` exit 0 lists it; `read-tree` **exit 0**, index entry `a/b` |
| `40000 sub` → tree whose sole entry is named `.` | `read-tree` **exit 128** `error: invalid path 'sub/.'` |
| `git rev-parse <tree>:.` / `:..` | both resolve to the blob — exit 0 |
| `git rev-parse <tree>:a/b` on the entry literally named `a/b` | **resolves** — exit 0, `5626abf0…`; `cat-file -p` prints the blob |
| `fsck --strict` over the three shape trees | `hasDot: contains '.'` · `hasDotdot: contains '..'` · `fullPathname: contains full pathnames` |

Two consequences the ratified decisions rest on, stated plainly:

- **A duplicate name is not a refusal on any read surface.** `ls-tree` lists both,
  `rev-parse`/`cat-file` resolve the **first**, `read-tree` keeps the **last**,
  `diff-tree` emits both. Only `fsck` (and write-side fsck) reports it. Rows 14–15 are
  therefore **first-wins / last-wins parity rows**, not co-refusal rows (ADR-752).
- **`.` and `..` are refused at materialisation, `a/b` is not refused at all.** Rows
  9–10 are **materialisation-refusal** rows — the refusal exists, one layer down, and
  git names the full path (`sub/.`), not the bare segment. Row 11 is an **accepted**
  row on every surface except fsck (ADR-753).

**Recursion**: `ls-tree -r` descends into a subtree carrying any of these names and
emits `sub/<name>` verbatim. `read-tree --prefix=x/` refuses the `.`/`..` classes with
the prefixed path in the message.

**Not a divergence, do not "fix" it.** `zeroPaddedFilemode` (rows 16–17) is a
*write*-side and fsck-side finding; git's **read** path (`canon_mode`) accepts `040000`
and `0100644` fine, and so do both `normalizeFileMode` (via `NORMALIZE_MAP`) and
`matchFileModeBytes` (via `DIRECTORY_6_BYTES`). That agreement is already correct.

#### 1c. tsgit today — measured, not inferred

Run against this worktree's source through `jiti`, same fixtures, SHA-1.

`parseTreeContent(id, bytes, SHA1_CONFIG)`:

| class | tsgit today | git (§1b) | verdict |
|---|---|---|---|
| BOM + `a` | **accepts, entry name `"a"`** — the BOM is dropped, so `serializeTreeContent` re-emits `61` and the tree's oid changes | accepted, bytes preserved | **silent corruption** |
| bare BOM | throws `INVALID_TREE_ENTRY {offset:0, reason:"invalid entry name: "}` | accepted | false refusal |
| `FE` + `FF` | throws `INVALID_TREE_ENTRY {offset:29, reason:"duplicate entry name: �"}` | accepted, two entries | false refusal |
| BOM + `.` | throws `invalid entry name: .` | accepted | false refusal |
| BOM + `..` | throws `invalid entry name: ..` | accepted | false refusal |
| `a` + BOM + `a` | throws `duplicate entry name: a` at offset 29 | accepted, two entries | false refusal |
| mode `10064a` | throws `INVALID_FILE_MODE {value:"10064a"}` | parse tier: `malformed mode` | right refusal, **wrong class and tier** |
| empty mode | throws `INVALID_FILE_MODE {value:""}` | parse tier: `malformed mode` | right refusal, wrong class; a **third** shape (the cursor says `INVALID_TREE_ENTRY 'malformed mode'`) |
| name `.` / `..` / `a/b` / duplicate `a,a` | refuses | every read surface accepts | refusal-set divergence — **removed** by ADR-753 (shapes) and ADR-752 (duplicates) |
| empty name | refuses `invalid entry name: ` | `ls-tree` exits 128 `empty filename in tree entry` | right refusal, wrong reason string — ADR-754 renames it `'empty filename'` |

`validateTree(bytes, strict, 20)`:

| class | tsgit today | git (§1b) | verdict |
|---|---|---|---|
| bare BOM | `emptyName` (warning / error under strict) | **no finding, exit 0** | false positive |
| BOM + `.` | `hasDot` | no finding | false positive |
| BOM + `..` | `hasDotdot` | no finding | false positive |
| `FE` + `FF` | `duplicateEntries:error` | no finding | false positive |
| `a` + BOM + `a` | `duplicateEntries:error` | no finding | false positive |
| rows 25–28 (all four orders) | `duplicateEntries:error`, and **never** `treeNotSorted` | rows 26, 28 → `treeNotSorted` | false positive **and** false negative in one |
| BOM + 4095 × `x` (4098 raw bytes) | **no finding** — the count is 4095 | `largePathname` | false negative |
| 1400 × `FF` (1400 raw bytes) | `largePathname` — the count is 4200 | no finding | false positive |
| 4097 × `x` | `largePathname` | `largePathname` | agrees |
| mode `10064a` | `badFilemode:info` | `badTree:error` | wrong class **and** wrong severity |
| empty name | `emptyName:warning` | `badTree:error` | wrong class and severity |
| empty mode | `badTree:error` | `badTree:error` | agrees (caught by `spaceIdx === offset`) |
| mode `777777` | `badFilemode:info` | `badFilemode`, warn-class, exit 0 even under `--strict` | agrees behaviourally |
| mode `0100644` | `zeroPaddedFilemode` warn→error under strict | same | agrees |

`cursorName` — the decode `flatten-raw.ts::validatedName` inherits:

| bytes | `cursorName` | `=== '.'` | `=== '..'` | flatten's verdict | git `read-tree` |
|---|---|---|---|---|---|
| `EF BB BF 61` | `"a"` | no | no | accepts, path `a` — **wrong path**, the BOM is lost | path `﻿a` |
| `EF BB BF` | `""` | no | no | **accepts**, `joinPath(prefix, "")` yields `prefix/` — an empty final segment | path `﻿` |
| `EF BB BF 2E` | `"."` | **yes** | no | throws `invalid entry name: .` | accepted (`read-tree --prefix` would refuse `x/sub/.`, but this name is not `.`) |
| `EF BB BF 2E 2E` | `".."` | no | **yes** | throws | accepted |
| `FF`, `FE` | `"�"` both | no | no | accepts both, **same `Map` key** — one silently overwrites the other | two distinct index entries |

The bare-BOM row is a divergence *between sites 1 and 2*, not just against git: site 1
refuses it (`name === ''`), site 2 accepts it, because site 2 dropped the `name === ''`
check on the reasoning that the cursor's `scanName` already refuses `nameEnd ===
nameStart`. That reasoning is correct about *bytes* and wrong about the *decoded
string*, which is exactly the defect class.

#### 1d. The fsck cascade — the two passes disagree with each other

`src/application/commands/fsck.ts` runs two passes over the same object:

- the **content-validation pass** reads raw bytes and calls `validateObject` →
  `validateTree` (never `parseTreeContent`), so it produces the §1c false findings;
- the **object-cache pass** (`internal/fsck/object-cache.ts`) decodes via `readObject`
  → `parseObject` → **`parseTreeContent`**, and a throw there yields
  `CachedGitObject = null`, the cache's "unreadable / corrupt object" value, which
  feeds connectivity and `buildBlobFilenameMap`.

So for a BOM-name tree that real git reports clean, tsgit reports `emptyName` from one pass and
treats the tree as unreadable in the other. Fixing site 1 without site 3 leaves the
disagreement; fixing site 3 without site 1 leaves it too. This is the strongest
argument for ADR-748's all-four scope.

#### 1e. Blast radius

- `parseTreeContent` has exactly **one** production caller: `parseObject`
  (`src/domain/objects/git-object.ts:40`). Everything else that matches is a comment,
  a test, or the barrel re-export in `src/domain/objects/index.ts`. Its reach is
  therefore every `readObject`-of-a-tree: `readTree`, `build-index-from-tree`,
  `ls-tree`, `cat-file`, `show`, the non-recursive diff path, and fsck's object cache.
- `flattenRawTree` backs `flattenTree` (published primitive), `read-head-tree`,
  `apply-merge-to-worktree` and `diff-trees`' recursive entry set.
- `validateTree` has exactly one caller, `validateObject`
  (`src/domain/fsck/validate-object.ts:59-70`), whose contract is documented as
  "NEVER throws — it classifies faults and returns them".
- `resolve-tree-path`'s `scanRawTreeFor` backs `blame`, `read-file-at` and
  `rev-parse <tree-ish>:<path>`. Note its **root level** is not byte-level:
  `findTreeEntry` does `rootTree.entries.find(c => c.name === segments[0])` over a
  `parseTreeContent` result, so the root of a descent inherits site 1's defect while
  every deeper level uses site 4. Fixing site 1 alone does *not* fix that seam — the
  comparison itself has to become a byte comparison (§4b).
- **Downstream of the parse layer, six call sites already validate paths**
  through `verifyPath` (`src/domain/path/verify-path.ts`), which mirrors git's
  `verify_path` and returns `'dot-segment'` / `'dotdot-segment'` among its rejections.
  Measured by reading the call graph:
  `src/domain/git-index/index-parser.ts:118`, `apply-changeset.ts:152`
  (`validateChangesetEntry` — the checkout tree→index boundary, gating every
  `add`/`update` write), `build-index-from-tree.ts:114` (`projectLeaf`, per walked
  leaf), `synthesize-tree-from-index.ts:87`, `stash.ts:393` and `add.ts:571`. This is
  load-bearing for ADR-753: the refusal it moves *down* is, for those surfaces,
  **already there**.

### 2. The scope correction — the backlog entry is incomplete

Backlog **30.3** names `tree.ts` and "the cursor descent". That is wrong in two
directions; ADR-748 ratified the correction, and it stays a first-class part of this
design:

- **`flatten-raw.ts` is in scope.** Its `validatedName` is the same decoded-string
  predicate, by its own admission, and §1c measures it producing a *different* wrong
  answer from site 1 on the bare-BOM class. Fixing only `tree.ts` would leave
  `flatten` as the new outlier — the precise situation ADR-723 left behind.
- **`validate-tree.ts` is in scope** (found after this design's brief was written).
  It is the worst site: the same decoder defect produces four distinct wrong verdicts
  (`checkNameFaults`, `MAX_NAME_BYTES`, `seenNames`, `treeEntrySortKey`) plus the mode
  tier collapse, and §1d shows it disagreeing with site 1 inside one command.
- **The cursor's scan is *not* in scope.** ADR-723 already ruled it, twice, with a
  regression pinned in `tree-diff-corrupt-interop.test.ts`. §6 restates what stays
  untouched and names the two mechanical edits the cursor *module* does take.

#### 2a. A second scope correction — ADR-753's subject list under-enumerates the sites

ADR-753 lists `materialize-tree.ts` and `build-index-from-tree.ts` as the sites that
"gain a refusal they did not carry". Read against the code (§1e), that is only half
right, and the half that is wrong is the one that matters:

- **`build-index-from-tree.ts` already refuses.** `projectLeaf` calls
  `validateIndexPath(leaf.path, …)` → `verifyPath` for every walked leaf, which returns
  `'dot-segment'` / `'dotdot-segment'`. A `.`-named entry that today dies in
  `parseTreeContent` will, after the change, die here instead. No new code; what is new
  is that the branch becomes *reachable*, so it needs a test that proves it fires.
- **`materialize-tree.ts` already refuses too**, one hop away: it composes
  `walkTree → computeChangeset → applyChangeset`, and `applyChangeset`'s
  `validateChangesetEntry` runs the same `validateIndexPath` on every `add`/`update`
  entry before anything is written. Its comment already anticipates exactly this —
  "`walkTree` never validates entry names — that is git's `mktree` escape hatch".
- **The site that genuinely has no check is the merge worktree writer.**
  `apply-merge-to-worktree.ts` flattens ours/theirs/base with `flattenTree` and then
  writes through `writeWorkingTreeFile` / `writeWorkingTreeEntry`
  (`writeConflictWorktree`, `writeMarkedConflict`), and `merge.ts:715` does the same
  for its conflicts. Neither path calls `validateIndexPath`. Today `flatten-raw.ts`'s
  `validatedName` refuses `.`/`..` before those writers ever see the path; after
  ADR-753 removes it, a `.`-named entry in a merged tree reaches a working-tree write
  with no refusal in front of it. **That is a new hole opened by this change**, and it
  is what DC-C rules.

The other flatten consumers are safe by inspection: `read-head-tree.ts` and
`clean-work-tree.ts` only *compare* the flattened paths, and `stash.ts` already calls
`validateIndexPath` on every flattened path (`stash.ts:393`).

### 3. The shared byte module, re-derived from the ratified decisions

ADR-750 ratified "one classifier the consumers map", and the design that argued it had
four consumers in mind. ADRs 752 and 753 then removed the reason three of those four had
to ask the question at all. The fault set has to be re-derived from the ADRs, not
trimmed from the old one — and the honest re-derivation says the *classifier* no longer
earns its keep, while two smaller byte helpers do.

#### 3a. Who still asks a byte-level question, after 752 and 753

| site | name-shape faults | duplicate key | mode bytes | empty name |
|---|---|---|---|---|
| `parseTreeContent` | **none** (753) | **none** (752) | yes — parse tier (754) | yes — parse tier (754) |
| `flatten-raw.ts` | **none** (753) | none (already) | cursor's, unchanged | cursor's, unchanged |
| `resolve-tree-path.ts` | **none** (753) | **none** (752) | cursor's, unchanged | cursor's, unchanged |
| `validate-tree.ts` (fsck) | **yes** — `hasDot`, `hasDotdot`, `hasDotgit`, `fullPathname`, `largePathname` | **yes** — `duplicateEntries` | yes — parse tier (754) | yes — parse tier (754) |
| `tree-cursor.ts` | none (ADR-723) | none (ADR-723) | yes — already owns `hasNonOctalByte` | yes — already owns it |

Read down the columns:

- **Name-shape classification has exactly one consumer left: fsck.** A three-member
  `EntryNameFault` union that only fsck maps is not a shared abstraction; it is fsck's
  own check with an extra module boundary in front of it. And fsck needs two members the
  union never had (`hasDotgit`, `largePathname`), so the union would have to grow to
  serve its single consumer.
- **The duplicate key has exactly one consumer left: fsck** — for both
  `duplicateEntries` and `treeNotSorted`. `parseTreeContent`'s `names` Set and
  `resolve-tree-path.ts`'s `seenNames`/`NameSpan` list are both deleted by ADR-752.
- **`hasNonOctalByte` has three consumers**: `tree-cursor.ts` (owns it today, L77–83),
  `parseTreeContent` and `validate-tree.ts`'s tolerant parser. That one is genuinely
  shared, across two domain directories, and is the only export ADR-754 actually
  requires to move.

So the module ADR-750 describes shrinks to **one shared function plus, at most, one
byte-key helper**. That is smaller than a module's worth of content, which is why the
shape is put back to the user as **DC-A** rather than quietly kept.

#### 3b. What the design assumes until DC-A is ruled

Written against DC-A's recommendation (option 1): `src/domain/objects/tree-entry-bytes.ts`
survives with a deliberately small surface, and fsck's name-fault policy moves *into*
fsck where its only consumer lives.

```ts
/** Parse-tier mode scan, moved out of tree-cursor.ts (ADR-754). */
export function hasNonOctalByte(buf: Uint8Array, start: number, end: number): boolean;

/**
 * Lossless byte→string key for fsck's duplicate set and sort keys (ADR-751).
 * One code unit per byte, accumulated in bounded chunks.
 */
export function entryNameKey(buf: Uint8Array, start: number, end: number): string;
```

There is deliberately **no** `entryNameByteLength` export: the raw length git's
`largePathname` counts is `end - start`, and wrapping subtraction buys nothing.
There is deliberately **no** name-shape classifier export: after 752 and 753 its only
caller is `validate-tree.ts`, so the byte comparisons for `.`, `..`, `.git`,
`/` and the 4096-byte bound are private to that file.

**This is a helper the consumers call, not a check inside `TreeCursor`.** ADR-723's
regression came from making a check unconditional inside the cursor's own scan, which
forced it onto `raw-tree-diff.ts`. `hasNonOctalByte` moving *out* of `tree-cursor.ts`
and being imported back is a relocation of code the cursor already runs, at the same
point in the same order — no verdict on any path changes, and every ADR-723 pin stays
green.

#### 3c. The `TextDecoder('latin1')` correction

The previous revision of this document claimed that `TextDecoder('latin1')` maps
`0x81`, `0x8D`, `0x8F`, `0x90`, `0x9D` to U+FFFD and that those bytes therefore
collide. **That was wrong.** Re-measured over all 256 byte values (Node 22, this
worktree):

| property | measured |
|---|---|
| bytes decoding to U+FFFD | **0** |
| bytes whose code point ≠ the byte value | **27** (all in `0x80`–`0x9F`) |
| colliding pairs | **0** — 256 distinct results |
| examples | `0x80` → U+20AC, `0x92` → U+2019, `0x81` → U+0081, `0x90` → U+0090 |

The WHATWG encoding standard aliases `latin1`/`iso-8859-1` to windows-1252, so the map
is not the identity — but it *is* injective, so it would in fact have worked as a
duplicate key. It is rejected because it is **not reversible to the original byte**,
which makes any later use of the key as a name silently wrong. ADR-751 already states
it this way; this section now agrees with the ADR.

#### 3d. One invariant the tier ordering buys

Once a non-octal mode short-circuits to the parse tier, every mode span that reaches the
check tier is pure ASCII octal — so decoding it to a string *there* is lossless by
construction. `validate-tree.ts` may therefore keep its decoded `mode` string for
`zeroPaddedFilemode` (`mode.startsWith('0')`) and `VALID_MODES.has`, and only the
**name** side has to go byte-level. That is worth stating because it is the one place a
decode survives the change on purpose, and a reviewer would otherwise read it as a
missed site.

The `Stryker disable next-line EqualityOperator` comment on `isInvalidEntryNameBytes`
(resolve-tree-path.ts L243) does not need re-proving: ADR-753 deletes the function it
annotates. It must be **removed with the function**, never relocated onto a surviving
loop — its proof cites that loop's bound and that covering set, and neither survives.

### 4. Target behaviour, per site, per class

Written against the ratified decisions. Every row cites the §1b probe that pins it and
the ADR that rules it.

#### 4a. The object-parse layer

| class | pin | `parseTreeContent` | `flatten` | `resolve-tree-path` | `validateTree` |
|---|---|---|---|---|---|
| BOM + `a` | rows 2, 7 | accept; `nameBytes` = `EF BB BF 61`, `name` = `"﻿a"` (749) | accept; path carries the BOM (§4c) | accept; matches only a BOM-prefixed query | no finding |
| bare BOM | row 3 | **accept** (today: refuse) | accept; the path segment *is* the BOM (today: an empty final segment) | accept | **no finding** (today: `emptyName`) |
| BOM + `.` / `..` | rows 5, 6 | **accept** | **accept** (today: refuse) | **accept** | **no finding** (today: `hasDot`/`hasDotdot`) |
| `FE` and `FF` in one tree | row 4 | **accept, two entries** with distinct `nameBytes` (today: false duplicate) | accept; the two paths still collapse to one `FlatTree` key — ADR-757, asserted | accept | **no finding** (today: `duplicateEntries`) |
| `a` and BOM + `a` | row 7 | **accept, two entries** | accept, two distinct paths | accept; `:a` matches only `a` | **no finding** |
| name `.` / `..` | rows 9, 10 | **accept** (753; today: refuse) | **accept** (753) | **accept** (753) | `hasDot` / `hasDotdot`, warn→error under strict |
| name `a/b`, `/a`, `a/`, `/`, `a//b` | rows 11, 12 | **accept** (753) | **accept**; `joinPath` yields a two-segment path, which is what git's index stores | **accept**, but see §4e — git *resolves* `<tree>:a/b` against such an entry and tsgit's segment-split descent does not | `fullPathname`, warn→error |
| duplicate names | rows 14, 15 | **accept, both entries** (752; today: refuse) | accept, **last**-wins — already faithful | accept, **first**-wins (§4b) | `duplicateEntries`, key = raw bytes |
| empty name | row 13 | refuse — **`INVALID_TREE_ENTRY 'empty filename'`** (754; today `'invalid entry name: '`) | refuse — cursor's `'empty filename'`, unchanged | refuse — cursor's, unchanged | **`badTree`** (754, 755; today `emptyName`) |
| mode `10064a`, empty mode | rows 19, 20 | **`INVALID_TREE_ENTRY 'malformed mode'`** (754; today `INVALID_FILE_MODE`) | cursor already correct | cursor already correct | **`badTree`** (754; today `badFilemode`) |
| mode `777777` | row 18 | `INVALID_FILE_MODE` — known divergence, already pinned | same | same | `badFilemode:info` |
| mode `0100644` / `040000` | rows 16, 17 | accept, normalise | accept | accept | `zeroPaddedFilemode` |
| name 4096 / 4097 raw bytes | rows 21–24 | no length limit (git's read path has none) | no limit | no limit | `largePathname` on the **raw** count `end - start` |
| sort order | rows 25–28 | n/a (`parseTreeContent` does not check order) | n/a | n/a | `treeNotSorted` on **raw** byte keys |

Two whole checks disappear from three files rather than moving byte-level:

- `parseTreeContent` loses the `name === '' || '.' || '..' || includes('/')` line and
  the `names` Set entirely. What remains at the name position is a single parse-tier
  test — `nullIndex === spaceIndex + 1` → `'empty filename'`.
- `flatten-raw.ts` loses `validatedName` as a function; `flattenEntry` calls
  `cursorName(cursor)` directly.
- `resolve-tree-path.ts` loses `isInvalidEntryNameBytes`, its `Stryker disable`
  comment, the `NameSpan` type and the `seenNames` array. `scanEntry` reduces to:
  read the mode (eager, per ADR-723's carried-forward ruling), compare the name bytes
  to the target, return the entry on a match.

#### 4b. Duplicate tie-breaks — the two lines that implement ADR-752

Neither tie-break is free; each is one line, and each is observable.

- **Descent, first-wins.** `scanRawTreeFor` today does
  `matched = scanEntry(cursor, seenNames, target) ?? matched`, which keeps the **last**
  match — unreachable until now because the duplicate check threw first. It becomes a
  first-wins accumulate (`matched ??= scanEntry(cursor, target)`), matching
  `git rev-parse <tree>:a` → the first blob (§1b re-pin).
  **The loop still runs to the end of the directory.** Breaking out on the first match
  would be faster, but `scanEntry` calls `cursorMode` on every visited entry, so an
  early break would silently stop raising `INVALID_FILE_MODE` for a malformed mode
  *after* the match — a refusal-set change ADR-723's carried-forward ruling ("mode
  validation stays eager per visited entry") does not permit. If that eager refusal
  is ever revisited, it is its own decision with its own probe.
- **Root level, byte comparison.** `findTreeEntry` does
  `rootTree.entries.find(c => c.name === segments[0])` — a *string* compare, where every
  deeper level uses `cursorNameEquals(cursor, encode(name))` on bytes. `Array.find` is
  already first-wins, so the tie-break is right; the *comparison* is not. It becomes a
  byte comparison against `entry.nameBytes` (ADR-749 makes those available on the parsed
  entry), otherwise `<tree>:<U+FFFD>` resolves against an `FF`-named entry where git
  resolves against nothing.
- **Materialisation, last-wins** needs no code: `state.entries.set(path, …)` in
  `flatten-raw.ts` and the index `Map` builders already overwrite.
  `test/unit/application/primitives/flatten-tree.test.ts` L482+ already asserts "the
  last entry on disk wins"; row 14 is now its named oracle.

#### 4c. Fixing the predicate is not enough — the *decode* has to move too

A byte-level predicate stops the false refusals. It does **not** stop the BOM being
dropped from the value that escapes, because three helpers still decode with the
BOM-stripping `decode()`:

| helper | file | consumed by | change |
|---|---|---|---|
| `parseTreeContent`'s `decode(name bytes)` | tree.ts L48 | `TreeEntry.name` | the `treeEntry` factory owns the encode/decode pair (ADR-749); the parse path hands it the raw slice |
| `cursorName(c)` | tree-cursor.ts L197–199 | `flatten`'s path, `resolve-tree-path`'s returned entry name, every refusal message | switch to `decodePreservingBom` |
| `validate-tree.ts`'s `DECODER.decode` | validate-tree.ts L37, 76–77 | every fsck name check | remove for names entirely — the checks go byte-level; the *mode* decode stays (§3d) |

**Changing `cursorName`'s decoder is not the change ADR-723 forbids.** ADR-723 forbids
adding a *check* to the cursor's unconditional scan, because that would force it onto
`raw-tree-diff.ts`. `cursorName` is an emit helper, called only when a consumer wants a
string; the merge-join never calls it (it compares through `compareCursorNames` /
`cursorNameEquals`, both already byte-level). Swapping its decoder changes no verdict on
any path and leaves every ADR-723 pin green.

#### 4d. The `TreeEntry` shape and its construction sites (ADR-749)

```ts
export type TreeEntry = {
  readonly mode: FileMode;
  readonly name: string;          // derived display view
  readonly nameBytes: Uint8Array; // authoritative — the on-disk bytes
  readonly id: ObjectId;
} & { readonly __brand: unique symbol };

export function treeEntry(mode: FileMode, name: string | Uint8Array, id: ObjectId): TreeEntry;
```

This is the repo's existing brand idiom, one file over: `ObjectId` is
`string & { readonly __brand: unique symbol }` with `ObjectId.fromRaw` /
`ObjectId.from` as its only mints (`src/domain/objects/object-id.ts`). The factory
accepts `string | Uint8Array` and performs the encode or decode itself, so no consumer
ever touches a `TextEncoder`. `parseTreeContent` routes through the same factory,
handing it the raw name slice. Whether the factory **copies** that slice or keeps a view
into the object body is **DC-D**; this design is written against the copying variant.

Three helpers in `tree.ts` stop touching `name`: `serializeTreeContent`'s per-entry
`encode(entry.name)`, `sortTreeEntries`'s decoration and `treeEntryCompare` all read
`entry.nameBytes` instead, which makes the private `encodeEntryName(name, isDir)` take
bytes rather than a string. That is the change that makes requirement 3 true; the
predicate work alone would not.

**`writeTree`'s public signature does not change shape** —
`writeTree(ctx, entries: ReadonlyArray<TreeEntry>)` still. What changes is that a
caller can no longer *build* the array from literals. The published example becomes a
`treeEntry(...)` call per entry (see *Release and migration*).

**Measured — what the brand does and does not catch.** Probed with the repo's own
`typescript@6.0.3` under `strict`:

| construction | verdict |
|---|---|
| `const e: TreeEntry = { mode, name, nameBytes, id }` | **TS2322** — `Property '__brand' is missing` |
| the same literal inside `const es: ReadonlyArray<TreeEntry> = [ … ]` | **TS2322**, same reason |
| `{ ...existing, id: newId }` | **compiles** — spread copies `__brand` |
| `{ ...existing, name: 'other' }` | **compiles** — and `nameBytes` is now stale |

So ADR-749's "an inconsistent `name`/`nameBytes` pair is a compile error" holds for
**object literals**, which is every construction site in the repo, and does **not** hold
for spread-derived entries. TypeScript's structural spread copies every known property
including the brand, and no property-based brand can defeat that. The residual is
**DC-B**; note it is not a byte-fidelity hole, because ADR-749 also rules that nothing
reads `name` to make a decision — a spread that overrode `name` would produce a wrong
*display* string, never wrong on-disk bytes.

**Every construction site, enumerated.** In `src` (each becomes one `treeEntry(...)`
call):

| file | site |
|---|---|
| `src/domain/objects/tree.ts` | `entries.push({ mode, name, id: entryId })` in `parseTreeContent` — becomes the factory's own caller |
| `src/application/commands/commit.ts:439` | `treeEntries.push({ mode: leaf.mode as TreeEntry['mode'], name, id: leaf.id })` |
| `src/application/commands/commit.ts:453` | `treeEntries.push({ mode: '40000', name, id })` |
| `src/application/commands/merge.ts:487` | `files.map((f) => ({ name: f.path, id: f.id, mode: f.mode }))` |
| `src/application/primitives/write-notes-tree.ts:59` | `direct.push({ id: entry.oid, mode: entry.mode, name: entry.name })` |
| `src/application/primitives/write-notes-tree.ts:72` | `subtreeEntries.push({ id: subtreeOid, mode: FILE_MODE.DIRECTORY, name: prefix })` |
| `src/application/primitives/synthesize-tree-from-index.ts:175` | `files.map((file) => ({ name: file.path as FilePath, id: file.id, mode: file.mode }))` |
| `src/application/primitives/internal/resolve-tree-path.ts:218` | `return { mode, name: cursorName(cursor), id: cursorOid(cursor) }` — builds from a cursor, so it hands the factory the raw name slice, not the decoded string |

Not a construction site, despite matching the shape: `src/application/commands/show.ts:142`
projects a `Tree` into `ShowTreeEntry`, its own interface — unaffected.
`src/domain/notes/write-plan.ts` builds `{ name, mode, oid }` records for the notes
planner, a different type.

**Spreads, checked in `test/` as well as `src`.** Two exist, both in
`test/bench/diff-recursive.bench.ts` (L57 and inside the `writeTree` call above it):
`{ ...firstBlob, id: mutatedId }` and `{ ...entry, id: newSubtreeId }`. Both override
`id` only, both keep `name`/`nameBytes` consistent, and both keep compiling under the
brand (measured above). Nothing in `src` or `test` spreads a `TreeEntry` while
overriding `name`.

**Test fixtures** build entries the same way — `treeEntry(mode, name, id)`. The two
places that matter: `test/unit/domain/objects/arbitraries.ts::arbTreeEntryAnyMode`
(its `.map(([mode, name, id]) => ({ mode, name, id }))` becomes a factory call, and its
name filter — which currently excludes `/`, `.` and `..` — is *kept* for the canonical
arbitrary and joined by a byte-oriented sibling, §Test strategy), and
`dedupeTreeEntriesByName`, whose comment ("Git trees cannot contain duplicate entry
names") is now false and whose dedupe stays only because a *generated* tree should still
be canonical.

#### 4e. A divergence ADR-753 exposes and does not rule — descent over an embedded separator

Measured 2026-08-30: `git rev-parse <tree>:a/b`, on a tree whose **sole entry is
literally named `a/b`**, resolves to that entry's blob (exit 0, `5626abf0…`), and
`cat-file -p` prints its content. That is not an accident of the fixture — git's
`find_tree_entry` compares each entry name against a *prefix of the whole remaining
path* and accepts either an exact full-path match or a match followed by `/`. An entry
name carrying a separator is therefore addressable by the path it spells.

tsgit's descent splits first: `findTreeEntry` does `path.split('/')` and looks for `a`,
which does not exist, so it returns `undefined` → `PATH_NOT_IN_TREE`.

The divergence is not *created* by this change — today the same query throws
`invalid entry name: a/b` while scanning the directory — but ADR-753 changes its shape
from "refuses" to "reports not-found", and the probe that ADR-753 rests on did not cover
the descent surface for this class. It is unruled, so it is **DC-E**.

For the other two shapes there is no gap: `<tree>:.` and `<tree>:..` both resolve under
git, and tsgit's split yields the single segment `.` / `..`, matches the entry by name,
and resolves too — no path validation sits in front of `findTreeEntry` (checked:
`resolve-tree-path.ts` splits and descends, nothing more). Those two become parity rows.

### 5. Error and finding semantics after the change

The refusals that moved changed **both** their error class and their layer. Stating each
one at its new home:

#### 5a. Reason strings that cease to exist

Both `invalid entry name: <name>` and `duplicate entry name: <name>` disappear from the
codebase entirely — not relocated, deleted. Their only emitters are the three lines
ADRs 752 and 753 remove:

| reason | emitter | fate |
|---|---|---|
| `invalid entry name: …` | `tree.ts:51`, `flatten-raw.ts:197`, `resolve-tree-path.ts:211` | deleted (753) |
| `duplicate entry name: …` | `tree.ts:65`, `resolve-tree-path.ts:214` | deleted (752) |

That is a visible removal on a published error channel: code stays `INVALID_TREE_ENTRY`,
but two `data.reason` values a consumer could switch on stop being producible. It is
listed here so the breaking-change note in *Release and migration* covers it, not just
the `TreeEntry` shape.

The tests that assert those strings are the change's own regression surface, and each
must be re-based rather than deleted: `flatten-tree.test.ts` L368–476,
`flatten-raw.test.ts` L614, `resolve-tree-path.test.ts` L454/L494/L559,
`resolve-tree-path.properties.test.ts` L125. Two more assert a *behaviour* that rests on
the duplicate refusal and therefore need a different fault to keep testing what they
test: `fsck.test.ts` L6731 ("a dangling loose tree with a duplicate entry name — full
decode fails, stored header still recovers") and `content-validation.test.ts` L114. A
duplicate no longer makes the decode fail; those fixtures must switch to a parse-tier
fault (a non-octal mode) to keep exercising the recovery path they exist for.

#### 5b. `INVALID_TREE_ENTRY` at the parse tier

- `parseTreeContent` gains two reasons — `'malformed mode'` and `'empty filename'` —
  both matching the cursor's existing strings exactly (ADR-754). After the change
  `parseTreeContent` and `openTreeCursor` produce **identical error data for every
  parse-tier fault**, which is what lets `parseTreeContent` keep serving as the cursor's
  differential oracle (ADR-520).
- `INVALID_FILE_MODE` stops being raised by `parseTreeContent` for unparseable modes.
  It is still raised for octal-but-unrecognised modes (`777777`, `100664`, `40644`) —
  the pre-existing, already-pinned divergence from git's `canon_mode`
  (`tree-diff-corrupt-interop.test.ts`, "git accepts it silently but tsgit throws
  INVALID_FILE_MODE"). That test is not touched.
- The **check order** inside `parseTreeContent` becomes the cursor's
  (`scanMode → scanName → scanOid`). Target order, per entry:

  1. locate the mode/name separator; `'missing space after mode'` if absent
  2. **mode bytes**: empty or non-octal → `'malformed mode'` *(new position)*
  3. locate the NUL; `'missing null after name'` if absent
  4. **empty name** → `'empty filename'` *(new reason)*
  5. oid bounds → `'truncated hash'`
  6. **mode match** via the check-tier matcher → `INVALID_FILE_MODE`

  Steps that used to sit between 4 and 5 — the name-shape test and the duplicate test —
  are gone. A tree with both a malformed mode and a bad-shaped name now reports the mode
  fault; a tree with a bad-shaped name reports nothing at all. Both are observable and
  each gets its own interop row rather than riding along as a side effect.

#### 5c. `INVALID_INDEX_ENTRY` at the materialisation tier

The `.`/`..` refusal ADR-753 moves down lands on the existing `verifyPath` vocabulary,
not a new one:

| surface | site | error |
|---|---|---|
| index construction (`reset --mixed`, `read-tree`-equivalent) | `build-index-from-tree.ts:114` | `INVALID_INDEX_ENTRY { offset: -1, reason: "'.' segment rejected" }` / `"'..' segment rejected"` |
| checkout / worktree materialisation | `apply-changeset.ts:152` | the same, for every `add`/`update` entry |
| merge worktree write | **none today** | DC-C |

Neither of the first two needs new code; both need a test proving the branch is now
reachable (§Test strategy). The class differs from git's `error: invalid path '.'`
message text, which ADR-249 leaves to the caller — what binds is that the operation
refuses, at the same layer, for the same input. `offset` is `NO_PARSER_OFFSET` (`-1`)
because the path was not sourced from a parsed index buffer.

**A second, unrelated behaviour change lands on the same code path, and it is a fix.**
Today a *nested* bare-BOM entry (`40000 sub` → an entry whose name is exactly
`EF BB BF`) produces the path `sub/` on both the flatten and the `walkTree` route,
because the decoder eats the BOM and leaves an empty final segment — and `verifyPath`
then refuses it as `'empty-segment'`. After §4c's decoder change the path is
`sub/<U+FEFF>`, `verifyPath` accepts it, and the entry materialises, which is what git
does (§1b row 3). So one `INVALID_INDEX_ENTRY` that fires today stops firing; that is
the fix working, and it needs its own before/after test rather than being noticed as a
missing refusal.

**One equivalence worth recording, because a reviewer will ask why a byte-level design
ends in a string comparison.** `verifyPath` splits a `FilePath` *string* on `/` and
compares each segment to `'.'` and `'..'`. That is byte-exact for this predicate: UTF-8
decoding produces `"."` only from the single byte `0x2E` and `".."` only from `0x2E 0x2E`,
and (after §4c) the decode preserves a BOM, so `EF BB BF 2E` decodes to `"﻿."`,
which is not `"."`. Invalid UTF-8 decodes to U+FFFD, which is not `"."` either. So no
byte sequence other than the intended one can reach the refusal, and none that should
can escape it.

#### 5d. fsck findings

- `validateTree` changes class for two inputs — `badFilemode` → `badTree` for a
  non-octal mode, and `emptyName` → `badTree` for an empty name — and stops emitting a
  finding for six byte classes (§1c). Severity follows the msg-id, so `badTree`'s
  `error` replaces `emptyName`'s `warning`, which changes fsck's **exit code** from 0 to
  1 on an empty-name tree without `--strict`, matching §1b row 13.
- `duplicateEntries` and `treeNotSorted` **stay**, re-keyed on raw bytes (ADR-752 leaves
  fsck as the sole detector). Their tolerant parser keeps name **spans** instead of
  decoded strings, so `validate-tree.ts`'s local `interface TreeEntry`
  (`{ mode: string; name: string; sha; offset }`) becomes
  `{ mode: string; nameStart: number; nameEnd: number; sha; offset }` over the shared
  buffer. The `mode` string survives, per §3d.
- ADR-755 deletes `MSG_EMPTY_NAME`. Three referents go with it:
  `msg-ids.ts:12` (the constant), `severity.ts:74` (the `DEFAULT_SEVERITY` row) and
  `severity.ts:143` (its membership in `STRICT_UPGRADE_SET`). The tests at
  `validate-object.test.ts` L361–398 assert the id at both severities and are rewritten
  to assert `badTree` instead.
- `checkSpecialFileName`'s `.gitmodules` / `.gitattributes` / `.gitignore` / `.mailmap`
  comparisons become **byte-exact**, which *narrows* them: today a BOM-prefixed
  `.gitmodules` is caught by accident. See the corresponding Out-of-scope entry — that
  narrowing is a real behaviour change and must be pinned by a test, not left to surface
  later.
- Every I/O and decompression fault still propagates unchanged; nothing here wraps a
  read.

### 6. What deliberately does not change

- **`src/domain/objects/tree-cursor.ts`'s scan verdicts.** No new check in
  `scanEntryAt`, `scanMode`, `scanName`, `scanOid`, `computeIsDir`,
  `compareCursorNames` or `cursorNameEquals`. ADR-723's carried-forward ruling is the
  reason and its interop pins are the enforcement. The module does take exactly two
  mechanical edits, neither of which changes a verdict: `cursorName` swaps
  `decode` → `decodePreservingBom` (§4c), and `hasNonOctalByte` moves out to be
  imported back (§3b) — or, under DC-A(b), merely gains an `export`.
- **Does dropping `resolve-tree-path.ts`'s checks put a new burden on the cursor's own
  scan?** No — checked explicitly, because it is the obvious way this change could go
  wrong. The two dropped checks were *shape* and *duplicate*; the cursor never carried
  either, and no consumer of the descent depended on them for structural safety. What
  the cursor's scan must still catch is unchanged and unchanged in placement: a missing
  space (`'missing space after mode'`), an empty or non-octal mode
  (`'malformed mode'`), a missing NUL (`'missing null after name'`), an empty name
  (`'empty filename'`) and a short oid (`'truncated hash'`). The descent's own
  consumers — `blame`, `read-file-at`, `rev-parse <tree-ish>:<path>` — return an entry
  or an oid and write nothing; the surfaces that *do* write are covered one layer down
  by `verifyPath` (§5c) and by DC-C.
- **`src/domain/objects/file-mode.ts::matchFileModeBytes`** — the check-tier matcher
  stays byte-level and stays the emit-time refusal.
- **`src/application/primitives/internal/raw-tree-diff.ts`** — the merge-join keeps
  carrying neither the name-shape nor the duplicate check, matching `git diff-tree`.
  ADR-752 changes nothing here: the merge-join already accepted duplicates.
- **`src/domain/path/verify-path.ts`** — untouched. It already implements the `.`/`..`
  refusal ADR-753 relies on, plus the `.git`/`.gitmodules` alias families that the
  Out-of-scope entry keeps out of fsck.
- The three Stryker equivalence suppressions in `encoding.ts` and the two in
  `tree-cursor.ts` are untouched. The one in `resolve-tree-path.ts` is **deleted with
  the function it annotates** (§3d) — never relocated onto a surviving loop.

---

## Decisions — ratified

The ten choices this document opened are closed. Nothing in this table is open; it is
here so a reader can get from a section back to the ruling that binds it.

| was | Choice | Ruling | ADR |
|---|---|---|---|
| D1 | Scope — which sites change | all four; the byte predicate extracted from site 4 | [748](../adr/748-tree-byte-sensitivity-spans-every-decoding-read-path.md) |
| D2 | `TreeEntry` fidelity | **against the recommendation** — branded type + exported factory, not an optional `nameBytes?` | [749](../adr/749-tree-entry-is-branded-and-minted-only-through-its-factory.md) |
| D3 | Shape/home of the shared predicate | one classifier the consumers map — *re-derived in §3, see DC-A* | [750](../adr/750-entry-name-byte-faults-are-one-classifier-consumers-map.md) |
| D4 | Duplicate/sort key representation | char-code keys; `TextDecoder('latin1')` rejected for **non-reversibility, not collision** (§3c) | [751](../adr/751-byte-keys-are-built-from-char-codes-not-a-text-decoder.md) |
| D5 | Duplicate-name refusal set | **against the recommendation** — dropped from the read paths; descent first-wins, materialisation last-wins, fsck detects | [752](../adr/752-tree-read-paths-accept-duplicate-entry-names.md) |
| D6 | Name-shape refusal set | **against the recommendation** — `.`/`..` move to materialisation, the separator refusal is dropped outright | [753](../adr/753-name-shape-refusals-move-to-worktree-materialisation.md) |
| D7 | The parse tier | adopted on both sites, for mode bytes **and** the empty name | [754](../adr/754-tree-parse-tier-separates-malformed-from-bad.md) |
| D8 | The orphaned `emptyName` msg-id | deleted, with its severity row and its strict-upgrade membership | [755](../adr/755-the-empty-name-fsck-message-id-is-removed.md) |
| D9 | Where the interop pins live | one new suite claiming the `tree` surface | [756](../adr/756-tree-byte-parity-pins-live-in-one-interop-suite.md) |
| D10 | The `FilePath` collapse | `FilePath` stays a string; the collapse is asserted at the `FlatTree` level | [757](../adr/757-file-path-stays-a-string-and-the-sibling-collapse-is-asserted.md) |

## Decision candidates

Five choices the revision surfaced that no ADR rules. None is a re-litigation.

| # | Choice | Alternatives (≤3) | Recommendation | Why |
|---|---|---|---|---|
| **DC-A** | **The shape of the shared byte module, now that ADRs 752 and 753 removed three of its four consumers.** ADR-750 ratified "one classifier the consumers map"; §3a measures that name-shape classification and the duplicate key now have exactly **one** consumer each (fsck), while only `hasNonOctalByte` has three. | (a) Keep `src/domain/objects/tree-entry-bytes.ts` with the shrunken surface — `hasNonOctalByte` + `entryNameKey` — and move the name-shape byte comparisons *into* `validate-tree.ts`, where their only consumer lives. (b) No new module at all: `hasNonOctalByte` stays exported from `tree-cursor.ts` and `tree.ts` / `validate-tree.ts` import it from there; `entryNameKey` and the shape comparisons are private to `validate-tree.ts`. (c) Keep ADR-750's full classifier (`EntryNameFault` union, grown to include `dotgit` and `large`) even though fsck is its sole consumer. | **(a)** | (c) is a shared abstraction with one consumer, and the union would have to grow two members to serve it — that is fsck's own policy wearing a module boundary, and the repo's 100 % branch gate would then have to cover arms only one caller can reach. (b) is the smallest diff and defensible, but it makes `domain/fsck` import `tree-cursor.ts` for a five-line octal scan, dragging the cursor module into fsck's graph for a predicate that has nothing to do with cursors. (a) keeps one home for the byte primitives that genuinely have several callers, and puts fsck's policy in fsck. **Whichever is ruled, ADR-750's text needs a follow-up note**, because "the four consumers map it" is no longer true of any surviving export. |
| **DC-B** | **The residual spread hole in ADR-749's brand.** Measured (§4d): the brand makes an inconsistent object *literal* a compile error, and does **not** stop `{ ...entry, name: 'x' }`, because TypeScript's spread copies the brand property. | (a) Accept it: the brand closes the literal hole (every construction site in the repo), and ADR-749's "nothing reads `name` to make a decision" rule means a stale `name` is a wrong display string, never wrong on-disk bytes. Record the limit next to the type. (b) Forbid the pattern mechanically — a lint rule or a review-checklist item against spreading a `TreeEntry`. (c) Remove `name` from the type entirely and expose a derived accessor, so there is no inconsistent pair to build. | **(a)** | No property-based brand in a structurally-typed language can defeat spread, so (a) is not a compromise so much as the honest boundary of what ADR-749 bought. The repo has exactly two `TreeEntry` spreads, both in `test/bench/diff-recursive.bench.ts`, both overriding `id` only, both safe. (b) buys a rule with no current violation and a maintenance cost. (c) is ADR-749's rejected option 1 arriving by the back door and would re-open a settled decision. |
| **DC-C** | **Where the newly-reachable `.`/`..` refusal lands on the merge worktree-write path.** §2a measures the gap: `apply-merge-to-worktree.ts` and `merge.ts` flatten trees and write to the working tree with no `verifyPath` in front, and today only `flatten-raw.ts`'s `validatedName` — which ADR-753 deletes — stands between a `.`-named entry and that write. | (a) Mirror `applyChangeset`'s existing shape: call `validateIndexPath(path, NO_PARSER_OFFSET, mode)` in the merge worktree writers, before the first write. (b) Push the check into the shared low-level writers (`writeWorkingTreeFile` / `writeWorkingTreeEntry`) so every worktree write is covered at one choke point. (c) Leave it — treat a merge input tree as already-validated and accept that the refusal exists only on the checkout and index paths. | **(a)** | (a) is the smallest diff, reuses the vocabulary the checkout path already produces for the identical fault, and keeps the check off the per-file write path. (b) is tempting as a single choke point but would double-validate every checkout write (`applyChangeset` already validates) and puts a path split + per-segment scan on the hottest write loop in the library. (c) is the option that has to be ruled explicitly rather than defaulted into: the input to a merge can be a tree from a hostile remote, and `.`/`..` is precisely the path-traversal shape the refusal exists to stop — ADR-753's "the guarantee moves layer, it does not weaken" is only true if this site gets it. |
| **DC-D** | **Whether the `treeEntry` factory copies its `Uint8Array` input.** ADR-749 says the factory owns the encode; it does not say whether `nameBytes` may alias the caller's array or, on the parse path, the object body. `nameBytes` is published, so this is an API-semantics choice, not an implementation detail. | (a) The factory always copies. `nameBytes` is private to the entry; the caller's array and the object body are both free to be reused or mutated afterwards. (b) The factory never copies; `nameBytes` may be a view, documented as read-only, and the caller is responsible for not mutating what it passed in. (c) Copy only a caller-supplied array; let `parseTreeContent` pass a view into the object body it already owns. | **(a)** | (b) and (c) both hand user code a mutable window into a buffer the library caches: `fsck`'s `CachedGitObject` holds parsed trees, and a consumer writing through `entry.nameBytes` would corrupt a shared cached object with no way to detect it. The cost of (a) is one small `Uint8Array` per entry on the parse path — the same order as the `name` string that path already allocates per entry, and a fraction of what the removed duplicate `Set` cost. (c) is the perf-optimal safe-ish middle, but it makes the aliasing guarantee depend on which overload was used, which is exactly the kind of rule that does not survive contact with a future caller. If the hot path measures badly, the honest reversal is (b) plus a documented read-only contract — not a per-overload rule. |
| **DC-E** | **Whether the path descent learns git's whole-remaining-path match, now that an embedded-separator name is accepted.** §4e measures it: `git rev-parse <tree>:a/b` resolves an entry literally named `a/b`; tsgit's `path.split('/')` descent reports not-found. ADR-753 removed the refusal and did not probe the descent surface for this class. | (a) Record and assert the divergence: tsgit's descent reports `PATH_NOT_IN_TREE` where git resolves; one interop row pins the difference. No code change. (b) Match git: at each level, accept an entry whose name equals the **whole remaining path**, else one that equals a prefix followed by `/` and descend — which is `find_tree_entry`'s own loop, and subsumes segment-splitting. (c) Keep a refusal for embedded-separator names on the descent only. | **(b)** | The prime directive and the repo's standing "always choose the git-faithful fix" both point at (b), and the probe that would have justified anything else has now been run and says git resolves. The cost is contained: `findTreeEntry` / `descendOneLevel` carry the remaining path instead of one segment, and the byte comparison they already do (`cursorNameEquals`) becomes a prefix comparison plus a `/` test — no new decode, no new allocation per entry. (a) is honest and cheap, and is the right answer only if the descent rewrite is judged too much surface for this change; it must then ship as an asserted divergence, never a silence. (c) contradicts ADR-753 on the same evidence ADR-753 was decided on, and is listed only to make the shape of the choice complete. |

---

## Release and migration

**This ships as a major: 3.6.0 → 4.0.0.**

ADR-749 is a breaking public API change on both halves of the tree surface: `TreeEntry`
is published (through `src/domain/objects/index.ts`, and named in `readTree`'s return
and `writeTree`'s parameter), and consumers can no longer construct one from a literal.
Section 5a adds a second, smaller break: two `INVALID_TREE_ENTRY` `data.reason` values
stop being producible.

Release tooling is release-please with `release-type: node`
(`release-please-config.json`, `bump-minor-pre-major: false`), so the conventional `!`
marker on the released commit is what moves the major. The repo merges by **squash**,
which makes the pull-request **title** the released commit's subject — so the marker
has to be on the PR title, not only on a commit inside the branch. Nothing else needs
setting by hand.

### The factory is a new public export, and that has its own gates

`treeEntry` is not just a new symbol — it is the *only* way a consumer can build the
type `writeTree` takes, so it must leave the package. That puts it through the repo's
new-public-export path: an export from `src/domain/objects/tree.ts`, a re-export in
`src/domain/objects/index.ts`, whatever runtime entry the facade uses, and a
regenerated `reports/api.json` (the pre-push gate refuses a new public export without
one). It is a **value** export, not a type-only one, so the `export type *` barrels are
not sufficient — a `.d.ts` that declares a function the runtime bundle omits compiles
green and crashes at runtime, which `src/public-types.ts` already warns about for the
diff values.

### Consumer migration

Both published examples change and are updated in the documentation phase.

`docs/use/primitives/write-tree.md` — before:

```ts
const tree = await repo.primitives.writeTree([
  { name: 'README.md', mode: 0o100644, id: readmeBlobId, type: 'blob' },
  { name: 'src',       mode: 0o040000, id: srcTreeId,    type: 'tree' },
]);
```

after:

```ts
const tree = await repo.primitives.writeTree([
  treeEntry('100644', 'README.md', readmeBlobId),
  treeEntry('40000', 'src', srcTreeId),
]);
```

Note the current example is wrong on three counts *independently* of this change, and
the rewrite fixes all three: `FileMode` is a string union (`'100644'`), not an octal
number; there is no `type` field on a `TreeEntry`; and the page's "pass them out of
order and `writeTree` throws" is false — `serializeTreeContent` sorts the entries. The
documentation phase corrects the page, not just the example.

`docs/use/primitives/read-tree.md` — before:

```ts
const tree = await repo.primitives.readTree('HEAD');
for (const entry of tree.data.entries) console.log(entry.name, entry.mode, entry.id);
```

after:

```ts
const tree = await repo.primitives.readTree('HEAD');
for (const entry of tree.entries) {
  // `name` is the display view; `nameBytes` is what git stored.
  console.log(entry.name, entry.nameBytes, entry.mode, entry.id);
}
```

(`readTree` returns a `Tree`, whose entries are on `.entries` — the page's `tree.data.entries`
is a second pre-existing error the same pass fixes.)

The migration line for a consumer is one sentence: **replace every tree-entry object
literal with a `treeEntry(mode, name, id)` call; reading is unchanged unless you were
relying on `name` round-tripping non-UTF-8 bytes, in which case read `nameBytes`.**

---

## Test strategy

### Unit

- **`test/unit/domain/objects/tree.test.ts`** — one isolated test per §1b class, each
  asserting the parsed entries (`nameBytes` **and** `name`), never a count alone. Every
  refusal asserts the error `.data` (code + offset + reason) via `try`/`catch`, never
  `toThrow(TsgitError)`. The classes that flip from refuse to accept — the four byte
  classes, `.`, `..`, `a/b`, and duplicates — each get an
  *accept-and-assert-the-entries* test, because "it did not throw" would survive a
  mutant returning the wrong entry set. The duplicate case asserts `entries.length === 2`
  with both oids, which is the assertion that kills a surviving `names` Set.
- **`test/unit/domain/objects/tree-entry-bytes.test.ts`** (new, if DC-A(a) or (c)) — the
  surviving byte helpers. `entryNameKey` must return distinct keys for `[0xFF]`,
  `[0xFE]`, `[0x81]`, `[0x8D]`, `[0x90]`, `[0x9D]` — the six bytes §3c re-measured —
  and must handle a 4097-byte name without a stack overflow (the chunked accumulation,
  never a spread). `hasNonOctalByte` gets its own boundary sweep (`'7'` accepted, `'8'`
  refused, `'/'` refused) since it now has three callers.
- **The `treeEntry` factory** — its own tests: a `string` name and a `Uint8Array` name
  producing the same entry for ASCII input; a `Uint8Array` carrying a BOM producing
  `name` **with** the BOM, which proves the factory preserves it; a
  `Uint8Array` carrying `FF` producing a U+FFFD `name` and an intact `nameBytes`; and
  — under DC-D(a) — that mutating the caller's array afterwards does not change the
  entry. Under DC-D(b) that last test inverts into an assertion of the documented
  aliasing, never disappears.
- **Guard isolation, where guards still exist.** `validate-tree.ts` is now the only site
  with per-fault name branches, so the isolation tests move there: separate cases for
  `.`, `..`, `.git`, a lone `/`, a leading `/`, a trailing `/`, `//`, and the 4096/4097
  boundary — each triggering **only** its own finding, plus the near-miss whose
  *decoded* form is `.` but whose bytes are not (`EF BB BF 2E`). A single test
  triggering two faults proves neither guard alone.
- **`test/unit/domain/fsck/validate-tree.test.ts`** — the §1c false-positive and
  false-negative rows become assertions of *no finding* / *the right finding*: the
  4096/4097 raw-byte boundary in **both** encodings (rows 21–24), the four sort orders
  (rows 25–28) asserting `treeNotSorted` present in two and absent in two, the
  `badTree`-vs-`badFilemode` split (rows 18–20), and the empty-name class now landing on
  `badTree`. Both `strict` values, since ADRs 754/755 move severities.
  `validate-object.test.ts` L361–398 is rewritten from `emptyName` to `badTree`.
- **`test/unit/application/primitives/flatten-tree.test.ts`** — the bare-BOM row is a
  **regression** test with a failing baseline (today it yields a path with an empty final
  segment). The four shape rows at L368–476, which currently assert
  `invalid entry name: …`, invert: they become *accept* tests asserting the produced
  path (`.`, `..`, `a/b` as a two-segment path). The existing last-wins duplicate test
  at L482+ stays and gains row 14 as its named oracle.
- **`test/unit/application/primitives/internal/resolve-tree-path.test.ts`** — L454/L494
  (shape refusals) and L559 (duplicate refusal) invert to acceptance, and the duplicate
  case gains the **first**-wins assertion that pins ADR-752's descent tie-break.
- **Newly-reachable refusals get their own tests** (§5c): `build-index-from-tree` over a
  tree with a `.`-named entry throws `INVALID_INDEX_ENTRY` with reason
  `"'.' segment rejected"`, and the same through `materializeTree` →
  `applyChangeset`. Without these two the ADR-753 refusal is *asserted nowhere* —
  the parse-layer tests that used to cover it were just inverted.
- **Round trip** — a tree parsed from BOM-bearing and invalid-UTF-8-bearing bytes
  re-serializes to the **same bytes** (`toEqual` on the `Uint8Array`), which is the only
  assertion that catches a `nameBytes`-dropping mutant.

### Property tests

Re-checked against CLAUDE.md's four lenses, after the refusal moves. Two lenses fit
better than they did, one fits worse, and one now does not fit at all.

- **Lens 1 — round trip. Fits, and is now the decisive property.**
  `parseTreeContent(serializeTreeContent(t))` ≡ `sort(t)` over an arbitrary whose names
  are **arbitrary NUL-free byte sequences**, not `fc.string()`.
  `test/unit/domain/objects/arbitraries.ts::arbTreeEntryAnyMode` generates
  `fc.string()` filtered on `\0`, `/`, `.` and `..` — that arbitrary **cannot generate
  the defect**. It gains a byte-oriented sibling (`arbTreeEntryRawName`) emitting BOMs,
  lone `0x80`–`0xFF` bytes and multi-byte sequences. Under ADR-749 this property is
  total: there is no excluded class to document. `numRuns: 200`.
- **Lens 4 — counting invariant. Fits, and got *stronger*.** The old formulation was
  "`entries.length` equals the record count **whenever no name is byte-duplicated**".
  ADR-752 removes the caveat: every record becomes an entry, unconditionally, for any
  input free of parse-tier faults. The invariant is now `entries.length === recordCount`
  with the count coming from the arbitrary's own generation, so it still does not
  re-implement the parse loop. `numRuns: 100`.
- **Lens 3 — total function over a grammar. Fits, weakly.** `validateTree(anyBytes,
  strict, 20)` never throws, for arbitrary byte input. Its contract already says so;
  the byte-level rewrite is where that could regress. Worth keeping at `numRuns: 100`,
  but it is a guard rail, not a discovery property.
- **Lens 2 — compositional matcher / aggregator. No longer fits, and it is worth saying
  so plainly.** In the pre-ADR design this lens covered `classifyEntryNameBytes` as a
  fault aggregator over a name. ADR-753 deletes the aggregation: three of the four sites
  ask nothing, and fsck's remaining checks are independent single-predicate findings with
  no composition between them (no negation, no identity element, no append semantics).
  Writing a property over them would restate the implementation. **No lens-2 property is
  written**, and the four fsck predicates are covered by the isolated example tests above.
- **`tree-cursor.properties.test.ts`** already asserts the cursor and `parseTreeContent`
  yield the same `(mode, name, oid)` sequence. Under ADR-749 that property must widen to
  name **bytes**, or it silently stops being a differential oracle for exactly the field
  this change is about.
- **`resolve-tree-path.properties.test.ts` L125** currently generates a duplicate name to
  assert a refusal. It is re-pointed at the first-wins tie-break: for an arbitrary
  directory with a duplicated target name, the descent returns the **first** matching
  entry's oid.

No property is written for the mode tiers — a mode is a small enum plus a
non-octal-byte scan, and a parameterised example sweep is clearer (CLAUDE.md's
"small enum" exclusion).

### Interop — `test/integration/tree-entry-bytes-interop.test.ts` (new, per ADR-756)

Header: `@proves surface: tree · bucket: cross-tool-interop · interopSurface: tree ·
unique: exotic entry-name bytes and mode tiers match canonical git across every tsgit
read path`.

Uses `test/integration/interop-helpers.ts` (`GIT_AVAILABLE`, `runGit`,
`tryRunGitWithExit`) — `GIT_*` already scrubbed, `HOME`/XDG isolated,
`GIT_CONFIG_NOSYSTEM=1`. `merge.conflictStyle` is irrelevant and is **not** pinned.
One shared `beforeAll` builds the base repo (**60 s timeout** — the 10 s default flakes
under full-`validate` concurrency), and each case builds a fresh `Context` **after** its
own git-external writes, for the stale-fanout-cache reason
`tree-diff-corrupt-interop.test.ts`'s header documents. Copy `rawEntry` /
`buildLiteralTree` / `concatBytes` from there (ADR-756 rules copying over sharing, so
that suite's declared `diff` surface stays what it says).

Cases, one per pinned group:

1. **Parse-tier co-refusal** — rows 13, 19, 20. `git ls-tree` exits 128 with
   `fatal: empty filename in tree entry` / `fatal: malformed mode in tree entry`; tsgit
   refuses with `INVALID_TREE_ENTRY` + the matching reason, on **all three** parse
   sites (`readTree`, `flattenTree`, `revParse('<tree>:<name>')`). Assert the error
   `.data` **and** git's exit code — a co-refusal case with only one side asserted is a
   vacuous pass.
2. **Byte-class acceptance** — rows 2–7. For each, `git ls-tree -z` (raw bytes, no octal
   quoting) and tsgit agree on the entry set. Display parity is proven by reconstructing
   git's `<mode> <type> <oid>\t<name>` line from the structured fields inside the test
   (ADR-249). Row 4 through `readTree` must yield **two** `Tree.entries`, which is the
   assertion that kills a key-collapse mutant.
3. **Round-trip bytes** — for rows 2, 3, 4, 7: read the tree with tsgit, re-serialize,
   and compare to the on-disk object body **byte for byte**. This is ADR-749's only
   direct oracle.
4. **Name-shape parity, on both layers** — the case that changed most.
   - *Read layer, now parity:* `.`, `..` and `a/b` are **accepted** by `git ls-tree`,
     `git rev-parse <tree>:<name>` and by tsgit's `readTree` / `flattenTree` /
     `revParse`. Three former divergences become three parity rows.
   - *Materialisation layer, co-refusal:* `git read-tree` exits **128** with
     `error: invalid path '.'` / `'..'`, and tsgit's `buildIndexFromTree` throws
     `INVALID_INDEX_ENTRY`. Include the nested fixture (`40000 sub` → a tree whose sole
     entry is `.`) so the full-path form `sub/.` is pinned on both sides.
   - *And `a/b` is accepted at the materialisation layer too:* `git read-tree` exits 0
     with an index entry at `a/b`; tsgit's flattened path is the two-segment `a/b` and
     `verifyPath` does not refuse it. This row is the one that proves the separator
     refusal is gone rather than merely relocated.
5. **Duplicate behaviour, per surface** — rows 14–15, now three parity assertions
   instead of a divergence: `git ls-tree` lists both and tsgit's `readTree` returns two
   entries; `git rev-parse <tree>:a` resolves the **first** and tsgit's descent
   (`revParse` / `readFileAt`) returns the **first**; `git read-tree` + `ls-files -s`
   keeps the **last** and tsgit's `flattenTree` keeps the **last**. `git fsck` reports
   `duplicateEntries` and tsgit's fsck reports the same msg-id at the same severity.
6. **fsck parity** — rows 13, 18–28. Reconstruct git's
   `error in tree <oid>: <msgId>: <text>` line from tsgit's structured `FsckFinding`
   fields and compare, plus the exact exit code, with and without `--strict`. Rows 21–24
   pin the 4096/4097 boundary in both encodings; rows 25–28 pin `treeNotSorted` present
   in two orders and **absent** in the other two — the absent half is what catches a
   sort-key regression. Row 18 pins that `badFilemode` stays exit 0 even under
   `--strict`. The `hasDot` / `hasDotdot` / `fullPathname` rows stay here: fsck is now
   the *only* place those findings exist.
7. **The fsck two-pass agreement** (§1d) — one BOM-name tree, one `fsck` run: git reports
   nothing and exits 0, and tsgit reports **no finding at all**, neither from the content
   pass nor as an unreadable object from the cache pass.
8. **The `FilePath` limit (ADR-757)** — row 4 through `flattenTree`: git's index carries
   **two** entries (`git ls-files -s -z`), tsgit's `FlatTree` carries **one**. Asserted
   as a divergence at the `FlatTree` level, never by comparing worktree contents —
   `checkout-index` itself fails on those names on APFS (row 4), so a worktree comparison
   would pass for the wrong reason on macOS and fail on Linux.
9. **The check-order row (ADR-754's rider)** — one fixture faulty twice over: a non-octal
   mode *and* a name of `.`. Both git and tsgit must report the **mode** fault. (The
   second rider from the pre-ADR design — name-fault-before-duplicate — is gone: neither
   is a fault any more, so there is no ordering left to observe.)
10. **Descent over an embedded separator (DC-E)** — `git rev-parse <tree>:a/b` against
    the entry literally named `a/b`, and `<tree>:.` / `<tree>:..` against those entries.
    The last two are parity rows either way; the first is parity under DC-E(b) and an
    asserted divergence under DC-E(a) — pinned with git's exit code and oid on one side
    and tsgit's `PATH_NOT_IN_TREE` data on the other.
11. **SHA-256** — at least one acceptance row and one parse-tier refusal row re-run on
    `git init --object-format=sha256`, so hash-width independence stays measured.

### Mutation

Scoped Stryker over `src/domain/objects/tree.ts`, the DC-A module (if any),
`src/domain/fsck/validate-tree.ts`,
`src/application/primitives/internal/flatten-raw.ts` and
`src/application/primitives/internal/resolve-tree-path.ts`, per
`.claude/workflow/mutation.md`. Watch for:

- **the first-wins accumulate** in `scanRawTreeFor` (§4b). `matched ??= …` mutated to
  `matched = … ?? matched` is invisible to every test with a unique target name; only
  the duplicate-name descent test kills it.
- **boundary mutants on the byte-length comparisons** in fsck (`> MAX_NAME_BYTES`, and
  the `end - start === 1` / `=== 2` dot arms). The 4096/4097 pair is the only thing that
  separates `>` from `>=`.
- **the `entryNameKey` chunk loop** — an off-by-one there produces a key that is still
  unique for short names, so only a long-name test (≥ 4097 bytes) kills it.
- **ADR-754's reordering** — a mutant restoring the old check order is invisible to any
  test that triggers one fault at a time; the doubly-malformed fixture (non-octal mode
  *and* name `.`) is its only killer.
- **the deleted suppression.** `resolve-tree-path.ts`'s `Stryker disable next-line
  EqualityOperator` goes with the function it annotates. If any survivor tempts someone
  to re-add a suppression on a *different* line, the proof must be re-derived against
  the new structure and covering set — never carried across.
- **`treeEntry`'s copy of the caller's bytes** (DC-D(a)) — a mutant that stores the
  caller's array by reference passes every parse test, because the parse path never
  mutates the buffer afterwards; only the "mutate the caller's array after construction"
  unit test kills it.

---

## Out of scope

- **`hasDotgit` / special-file obfuscation matching — excluded, but it *regresses*, so
  the exclusion has to be an explicit ruling rather than a silence.**

  Measured, git 2.55.0. `hasDotgit` fires for **all** of `.git`, `EF BB BF .git`,
  `U+200C .git` (ZWNJ), `.GIT`, `.GiT` and `git~1` (the NTFS 8.3 short name). The same
  folding governs `checkSpecialFileName`: a `120000` entry named `.gitmodules`,
  `EF BB BF .gitmodules` **or** `.GITMODULES` all report `gitmodulesSymlink`.

  tsgit's `name === '.git'` / `name === '.gitmodules'` catch only the exact lower-case
  form **plus the BOM-prefixed form — and the second only by accident**: git catches it
  because U+FEFF is HFS-ignorable, tsgit because its decoder strips the BOM. Making the
  comparison byte-exact **removes that accidental agreement**. Concretely, after this
  change and without an obfuscation matcher, a `120000 EF BB BF .gitmodules` entry that
  tsgit flags today would stop being flagged, while git still flags it. That is a
  *narrowing* of a security-adjacent check, caused by an otherwise-correct fix.

  Two follow-on facts. First, `validate-tree.ts` already misses every other
  HFS-ignorable code point (U+200C–U+200F, U+202A–U+202E, U+206A–U+206F), every case
  variant, and every NTFS form, so the accidental agreement covers exactly one input out
  of a large family. Second — and this sharpens the exclusion rather than softening it —
  **the repo already owns the matcher**: `src/domain/path/verify-path.ts` implements
  git's `is_hfs_dotgit` / `is_ntfs_dotgit` folding in full, including the ignorable
  set (U+200C–U+200F, U+202A–U+202E, U+206A–U+206F **and U+FEFF**), the case fold, the
  trailing dot/space strip, `git~1`, the `:`-stream forms, and the `.gitmodules`
  short-name families. It is wired to the **index-path** boundary
  (`validateIndexPath` → `verifyPath`), not to fsck. So the future fix for fsck is
  "point `checkNameFaults` / `checkSpecialFileName` at the existing matcher", not
  "write an obfuscation matcher" — a smaller item than this paragraph previously
  implied, but still a distinct one with its own parity matrix (fsck reports findings
  per msg-id; `verifyPath` returns one first-component-wins rejection).

  **Recorded as measured and excluded; no fix is designed here.** The exclusion, and the
  regression it carries, was put to the user alongside ADR-748 and stands. The
  implementation must still land a test asserting the *new* (narrower) behaviour with a
  comment naming this paragraph, so the narrowing is pinned rather than discovered later.
- **`badFilemode`'s severity *label*.** git prints `warning in tree …: badFilemode`;
  tsgit's `DEFAULT_SEVERITY` records `info`. The *behaviour* agrees (neither is
  upgraded by `--strict`; both exit 0 — row 18), so only the label a reconstructed
  stderr line would carry differs. Pre-existing, unrelated to bytes, and it would
  reopen the whole `FsckSeverity` mapping. Recorded, not fixed.
- **A directory mode pointing at a non-tree** (row 8). `git ls-tree -r` exits 1 with
  `error: Object … not a tree`; `flattenRawTree`'s `descendIfTree` silently returns on
  `raw.type !== 'tree'`. A real divergence, but a *type* question, not a name-byte or
  mode-byte one. Measured and recorded here so the silence is not mistaken for
  ignorance.
- **`git canon_mode` mode masking** (row 18: `777777` → `160000`, and the existing
  `100664`/`40644`/`100777` rows). tsgit's five-value `FILE_MODE` set is a
  pre-existing, already-pinned divergence
  (`tree-diff-corrupt-interop.test.ts`, "git accepts it silently but tsgit throws
  INVALID_FILE_MODE"). Unchanged, and its test is untouched.
- **`TreeCursor`'s scan and `raw-tree-diff.ts`** — ADR-723's carried-forward ruling, §6.
  Not re-litigated.
- **`serializeTreeContent`'s sort normalisation.** A tree parsed from on-disk-unsorted
  bytes re-serializes in canonical order and gets a different oid, so the `@writes
  kind: equivalent-under-readback` header stays `equivalent-under-readback` regardless
  of ADR-749. ADR-749 makes the header honest about *name bytes*; the sort is a separate,
  pre-existing question with its own oracle (`tree-diff-corrupt-interop.test.ts`
  already pins the parsed path's re-sort as "a known, out-of-scope asymmetry").
- **`git fsck`'s `broken links` / `dangling` reporting** around a malformed tree. Rows
  13 and 19 show git emitting `broken links` alongside `badTree`; that is a
  connectivity finding driven by the parse failure, not a tree-content classification,
  and it belongs to the connectivity pass's own oracle.
- **`checkout-index`'s `Illegal byte sequence`** on row 4. That is APFS refusing a
  non-UTF-8 filename, not git — a filesystem-capability question that would need its own
  per-platform matrix. The tree-level behaviour (two distinct index entries) is in
  scope; whether the file can be created is not.
- **`MAX_NAME_BYTES` on the read paths.** git's read path enforces no name-length
  limit (rows 21–24 are fsck-only), so `parseTreeContent`, `flatten` and the descent
  gain none.
