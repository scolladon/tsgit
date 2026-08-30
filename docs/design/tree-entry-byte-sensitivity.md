# Design — tree entry-name byte-sensitivity unification

> Brief: tsgit's tree-object read paths disagree with each other, and with canonical
> git, about which entry-name **bytes** and which malformed **modes** are refused.
> Unify them on a byte-level predicate so every read path refuses exactly what git
> refuses and accepts exactly what git accepts — never by weakening the byte-level
> cursor path.
> Status: draft → self-reviewed ×3 → awaiting the decision phase. **Ten** load-bearing
> choices are open and listed under **Decision candidates**; the body below is written
> against the recommendations and must be re-written against whatever is ratified.

## Context

### What exists today — four implementations of one check, three of them defective

| # | Site | Symbol | Lines | Operates on | Verdict |
|---|---|---|---|---|---|
| 1 | `src/domain/objects/tree.ts` | `parseTreeContent` | 31–73 | **decoded string** (`decode()`) | defective |
| 2 | `src/application/primitives/internal/flatten-raw.ts` | `validatedName` | 194–200 | **decoded string** (`cursorName()`) | defective — the same bug, copied |
| 3 | `src/domain/fsck/validate-tree.ts` | `parseTreeEntriesTolerant` + `checkNameFaults` + `treeEntrySortKey` | 52–129, 90–98 | **decoded string** (module-scope `DECODER`) | defective — the same bug, four consequences |
| 4 | `src/application/primitives/internal/resolve-tree-path.ts` | `isInvalidEntryNameBytes` | 222–250 | **raw bytes** | correct — the model to unify **on** |

Site 4 is the only one that never decodes before deciding. Its doc comment already
names itself the "byte-cursor counterpart to `parseTreeContent`'s
`name === '' || name === '.' || name === '..' || name.includes('/')`", and site 2's
comment says it repeats those checks "with the identical reason string" — the
duplication is documented, just never reconciled.

Note that `validate-tree.ts` declares its **own** local `interface TreeEntry`
(L30–35, `{ mode: string; name: string; sha; offset }`), unrelated to the published
`domain/objects` `TreeEntry`. Two types, one name; D2 is about the published one, and
the fsck-local one changes regardless of D2 (it must carry raw spans instead of
decoded strings).

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

- **ADR-226 / prime directive** — observable behaviour byte-for-byte unless an ADR
  diverges. Here that binds *which trees are refused*, *the refusal class and data*,
  *the fsck msg-id and severity*, and *the bytes `serializeTreeContent` re-emits*.
- **ADR-249 / structured data only** — no rendered `ls-tree` line leaves the library.
  Display parity is proven by reconstructing git's output from structured fields
  inside the interop test.
- **[ADR-723](../adr/723-cursor-descent-keeps-the-duplicate-name-refusal.md) is the
  charter for the cursor and it is not re-litigated.** Its addendum records that
  putting the name-shape check **inside `TreeCursor`'s own scan** was tried and
  regressed `raw-tree-diff.ts` against real git (pinned by
  `test/integration/tree-diff-corrupt-interop.test.ts`'s embedded-`/` row), and that
  changing `scanMode` to match `parseTreeContent` would silently admit a malformed
  mode through `classifySamePathCursor`'s unchanged-entry fast path. Its closing
  sentence — "`parseTreeContent` is the outlier here, not the cursor — any unification
  is future work" — is this document's mandate. **A shared helper the consumers call
  is not a check inside the cursor**; §3 says which one this design means.
- **ADR-723 explicitly invited one re-litigation**: "Whether git itself refuses
  duplicate names outside `fsck`/`mktree` is unpinned — no probe was run… If a future
  probe pins git's actual duplicate-name behaviour on read surfaces, option 2 may be
  revisited with that pin." §1b **is** that probe. That is why D5 exists.
- **[ADR-747](../adr/747-reflog-rewrite-channel-is-byte-faithful.md)** is the shape
  precedent for D2: "the parse produces both display strings and raw slices — two
  views of the same fields", with "a wider `ReflogEntry` surface" accepted as a
  negative consequence. Same trap class: a UTF-8 decode mangling bytes git preserves.
- **`TreeEntry` is published API.** It is re-exported through
  `src/domain/objects/index.ts`, is named in **54** source files, and `reports/api.json`
  carries **110** references to it (133 matches for the string, less 12 `ShowTreeEntry`
  and 11 `FlatTreeEntry`). Widening it puts api.json regeneration on the critical path.
- **`serializeTreeContent` carries a `@writes surface: tree / kind:
  equivalent-under-readback / format: git-tree-object` header** (tree.ts L1–10), and
  `test/integration/tree-interop.test.ts` claims `interopSurface: tree`. D2 decides
  whether that header stays honest for entry-name bytes.
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
   the four sites.
2. For every class in the §1b matrix, each tsgit read surface agrees with the git
   surface it corresponds to — or the disagreement is a **ratified decision** with a
   live assertion of the difference, never a silence.
3. `parseTreeContent` no longer changes the bytes it read. Specifically:
   `serializeTreeContent(parseTreeContent(b), hash)` equals `b` for any `b` whose
   entries are already in git sort order — including entries whose names carry a BOM
   or invalid UTF-8. (What "equals" means for `TreeEntry.name` is D2.)
4. No two distinct on-disk names ever collapse into one parsed entry, one duplicate-set
   member, or one sort key. This requirement stops at the **tree-object layer**: it
   does *not* extend to `FlatTree` / `FilePath` keys, whose string nature is D10's
   explicitly-bounded and asserted limit.
5. The parse tier runs first and matches git's on every site: an empty or non-octal
   mode, and an empty name, are **parse-tier** faults; an octal-but-unrecognised mode
   is a **check-tier** fault. fsck classifies the first two as `badTree` and the third
   as `badFilemode`. `parseTreeContent` and `openTreeCursor` emit identical error data
   for every parse-tier fault.
6. fsck's `largePathname` counts **raw** name bytes. Measured boundary: 4096 accepted,
   4097 refused (§1b).
7. fsck's `treeNotSorted` compares **raw** name bytes with the virtual trailing slash
   for directories.
8. `TreeCursor`, `matchFileModeBytes` and `raw-tree-diff.ts` are unchanged. ADR-723's
   pins in `tree-diff-corrupt-interop.test.ts` stay green without edits.
9. Every row of §1b is pinned by a `test/integration/*-interop.test.ts` case that
   spawns real git with `GIT_*` scrubbed and signing off (D9 decides which file).
10. `npm run validate` green: 100 % line/branch/function/statement coverage on the
    touched domain code, 0 killable mutants, and `reports/api.json` regenerated if D2
    widens `TreeEntry`.

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

**Path descent** (`git rev-parse <tree>:<path>`, `git cat-file -p <tree>:<path>`)
resolves every accepted class, including duplicates — and on a duplicate it returns the
**first** entry (`5626abf0…`), where `read-tree` keeps the **last**. git is
deliberately inconsistent per surface; "match git" therefore means matching each
surface, not picking one rule.

**Recursion**: `ls-tree -r` descends into a subtree carrying any of these names and
emits `sub/<name>` verbatim. `read-tree --prefix=x/` refuses only the `.`/`..` classes
(`error: invalid path 'x/sub/.'`).

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
| name `.` / `..` / `a/b` / empty / duplicate `a,a` | refuses | ls-tree accepts (empty name excepted) | pre-existing refusal-set divergence — D5, D6 |

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
argument for D1(a).

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
  every deeper level uses site 4. Fixing site 1 fixes that seam too.

### 2. The scope correction — the backlog entry is incomplete

Backlog **30.3** names `tree.ts` and "the cursor descent". That is wrong in two
directions and the correction is a first-class part of this design:

- **`flatten-raw.ts` is in scope.** Its `validatedName` is the same decoded-string
  predicate, by its own admission, and §1c measures it producing a *different* wrong
  answer from site 1 on the bare-BOM class. Fixing only `tree.ts` would leave
  `flatten` as the new outlier — the precise situation ADR-723 left behind.
- **`validate-tree.ts` is in scope** (found after this design's brief was written).
  It is the worst site: the same decoder defect produces four distinct wrong verdicts
  (`checkNameFaults`, `MAX_NAME_BYTES`, `seenNames`, `treeEntrySortKey`) plus the mode
  tier collapse, and §1d shows it disagreeing with site 1 inside one command.
- **The cursor is *not* in scope.** ADR-723 already ruled it, twice, with a regression
  pinned in `tree-diff-corrupt-interop.test.ts`. §6 restates what stays untouched.

D1 puts the scope question to the user rather than assuming it.

### 3. Where the shared predicate lives, and what shape it has

A new domain module, `src/domain/objects/tree-entry-bytes.ts` — pure, zero platform
deps, importable by `domain/objects/tree.ts`, `domain/fsck/validate-tree.ts` and both
application-tier consumers (the dependency rule allows domain→domain; `domain/fsck`
already imports `domain/objects/encoding.js`).

**This is a helper the consumers call, not a check inside `TreeCursor`.** ADR-723's
regression came from making the check unconditional inside the cursor's own scan, which
forced it onto `raw-tree-diff.ts`. Nothing here touches `openTreeCursor`,
`scanEntryAt`, `scanMode`, `scanName` or `scanOid`. The merge-join keeps calling none
of it.

The four consumers want two different *outcome shapes* — three throw, one collects
findings — so the module exports a **classifier**, never a thrower:

```ts
/** Check-tier name faults. The empty name is NOT here — it is parse-tier (D7). */
export type EntryNameFault = 'dot' | 'dotdot' | 'slash';

/** Classify one entry's raw name bytes. `undefined` = no fault. */
export function classifyEntryNameBytes(
  buf: Uint8Array, start: number, end: number,
): EntryNameFault | undefined;

/** Lossless byte→string key for duplicate sets and sort keys (D4). */
export function entryNameKey(buf: Uint8Array, start: number, end: number): string;

/** Parse-tier mode check, extracted from tree-cursor.ts (D7). */
export function hasNonOctalByte(buf: Uint8Array, start: number, end: number): boolean;
```

There is deliberately **no** `entryNameByteLength` export: the raw length git's
`largePathname` counts is `end - start`, and wrapping subtraction in a function buys
nothing.

Each consumer maps the fault kind to its own outcome:

| consumer | maps `EntryNameFault` to |
|---|---|
| `parseTreeContent` | one `throw invalidTreeEntry(offset, 'invalid entry name: …')` for **any** non-`undefined` fault |
| `flatten-raw.ts::validatedName` | the same throw, same reason string (its comment already says "identical reason string") |
| `resolve-tree-path.ts::scanEntry` | the same throw — this site *is* today's implementation, so it becomes the classifier's first caller rather than keeping its own copy |
| `validate-tree.ts::checkNameFaults` | `{ msgId, severity }`, branching per kind: `'dot'` → `hasDot`, `'dotdot'` → `hasDotdot`, `'slash'` → `fullPathname` |

**A coverage trap this shape avoids.** The three parse sites map *any* fault to *one*
throw, so they grow no per-kind branch — which matters because the empty case is
unreachable from two of them (the cursor's `scanName` refuses `nameEnd === nameStart`
first) and an unreachable arm could never be covered under the 100 % branch gate. Only
fsck branches per kind, and every kind is reachable there. This is also why `'empty'`
is not a member of `EntryNameFault`: under D7 the empty name is a **parse-tier** fault
detected in the same place as the mode bytes, in all four sites.

The mode tier moves the same way: `tree-cursor.ts` already owns `hasNonOctalByte`
(L77–83). D7 extracts it into the shared module so sites 1 and 3 run the *same*
bytes-first check the cursor runs, rather than each growing its own. The cursor then
imports it back — a move, not a behaviour change, so ADR-723's pins stay green.

**One invariant this ordering buys.** Once a non-octal mode short-circuits to the parse
tier, every mode span that reaches the check tier is pure ASCII octal — so decoding it
to a string there is lossless by construction. `validate-tree.ts` may therefore keep
its decoded `mode` string for `zeroPaddedFilemode` (`mode.startsWith('0')`) and
`VALID_MODES.has`, and only the **name** side has to go byte-level. That is worth
stating because it is the one place a decode survives the change on purpose, and a
reviewer would otherwise read it as a missed site.

The `Stryker disable next-line EqualityOperator` comment on
`isInvalidEntryNameBytes` (resolve-tree-path.ts L243) proves equivalence **against
that loop shape and that covering set**. Moving the loop invalidates the proof: the
implementation must re-prove it against the new structure or drop the suppression, never
carry it forward.

### 4. Target behaviour, per site, per class

Written against the recommended decisions. Every row cites the §1b probe that pins it.

| class | pin | `parseTreeContent` | `flatten` | `resolve-tree-path` | `validateTree` |
|---|---|---|---|---|---|
| BOM + `a` | rows 2, 7 | accept, name bytes preserved (D2) | accept, path carries the BOM (§4a) | accept, matches only a BOM-prefixed query | no finding |
| bare BOM | row 3 | **accept** (today: refuse) | accept, path segment is the BOM (today: an *empty* final segment) | accept | **no finding** (today: `emptyName`) |
| BOM + `.` / `..` | rows 5, 6 | **accept** (today: refuse) | **accept** (today: refuse) | **accept** | **no finding** (today: `hasDot`/`hasDotdot`) |
| `FE` and `FF` in one tree | row 4 | **accept, two entries** (today: false duplicate) | accept, but the two paths still collapse to one `FlatTree` key — **D10**, an asserted divergence | accept | **no finding** (today: `duplicateEntries`) |
| `a` and BOM + `a` | row 7 | **accept, two entries** | accept, two distinct paths | accept | **no finding** |
| name `.` / `..` | rows 9, 10 | refuse (D6) | refuse (D6) | refuse (D6) | `hasDot` / `hasDotdot`, warn→error under strict |
| name `a/b`, `/a`, `a/`, `/`, `a//b` | rows 11, 12 | refuse (D6) | refuse (D6) | refuse (D6) | `fullPathname`, warn→error |
| empty name | row 13 | refuse — **`INVALID_TREE_ENTRY 'empty filename'`** (D7; today `'invalid entry name: '`) | refuse — cursor's `'empty filename'`, unchanged | refuse — cursor's, unchanged | **`badTree`** (D7 + D8; today `emptyName`) |
| duplicate names | rows 14, 15 | refuse, key = raw bytes (D5) | **accept, last-wins** — already faithful | refuse, key = raw bytes (D5) | `duplicateEntries`, key = raw bytes |
| mode `10064a`, empty mode | rows 19, 20 | **`INVALID_TREE_ENTRY 'malformed mode'`** (D7; today `INVALID_FILE_MODE`) | cursor already correct | cursor already correct | **`badTree`** (D7; today `badFilemode`) |
| mode `777777` | row 18 | `INVALID_FILE_MODE` — known divergence, already pinned | same | same | `badFilemode:info` |
| mode `0100644` / `040000` | rows 16, 17 | accept, normalise | accept | accept | `zeroPaddedFilemode` |
| name 4096 / 4097 raw bytes | rows 21–24 | no length limit (git's read path has none) | no limit | no limit | `largePathname` on **raw** count |
| sort order | rows 25–28 | n/a (`parseTreeContent` does not check order) | n/a | n/a | `treeNotSorted` on **raw** byte keys |

#### 4a. Fixing the predicate is not enough — the *decode* has to move too

A byte-level predicate stops the false refusals. It does **not** stop the BOM being
dropped from the value that escapes, because three helpers still decode with the
BOM-stripping `decode()`:

| helper | file | consumed by | change |
|---|---|---|---|
| `parseTreeContent`'s `decode(name bytes)` | tree.ts L48 | `TreeEntry.name` | D2 decides; at minimum switch to `decodePreservingBom` |
| `cursorName(c)` | tree-cursor.ts L197–199 | `flatten`'s path, `resolve-tree-path`'s returned `TreeEntry.name` and every refusal message | switch to `decodePreservingBom` |
| `validate-tree.ts`'s `DECODER.decode` | validate-tree.ts L37, 76–77 | every fsck check | remove entirely — the checks go byte-level |

**Changing `cursorName`'s decoder is not the change ADR-723 forbids.** ADR-723 forbids
adding a *check* to the cursor's unconditional scan, because that would force it onto
`raw-tree-diff.ts`. `cursorName` is an emit helper, called only when a consumer wants a
string; `raw-tree-diff.ts`'s merge-join never calls it (it compares through
`compareCursorNames` / `cursorNameEquals`, both already byte-level). Swapping its
decoder changes no verdict on any path and leaves every ADR-723 pin green.

One more decoded-string comparison hides at the **root** of a path descent:
`resolve-tree-path.ts::findTreeEntry` does
`rootTree.entries.find(c => c.name === segments[0])` — a *string* compare, where every
deeper level uses `cursorNameEquals(cursor, encode(name))` on bytes. So a descent's
root level inherits site 1's defect even after site 1's predicate is fixed. It must
become the same byte comparison (`encode(segment)` against the entry's name bytes),
otherwise `<tree>:<U+FFFD>` resolves against an `FF`-named entry where git resolves
against nothing.

**`flatten`'s missing duplicate check is not a defect — it is the only faithful site.**
Row 14 measures `git read-tree` keeping the *last* duplicate, which is exactly what
`state.entries.set(path, …)` does; `test/unit/application/primitives/flatten-tree.test.ts`
L482+ already asserts "the last entry on disk wins (duplicate detection moved to fsck)".
The brief asked whether the gap was a divergence worth a decision candidate; measured,
the answer is **no** — the divergence runs the other way, and it lives in sites 1 and 4.
That is D5.

### 5. Error and finding semantics after the change

- `INVALID_TREE_ENTRY` gains two reasons on `parseTreeContent` — `'malformed mode'`
  and `'empty filename'` (D7) — both matching the cursor's existing strings exactly.
  After the change, `parseTreeContent` and `openTreeCursor` produce **identical error
  data for every parse-tier fault**, which is what lets `parseTreeContent` keep serving
  as the cursor's differential oracle (ADR-520). It **loses** the false
  `'invalid entry name'` / `'duplicate entry name'` refusals for the byte classes above,
  and loses `'invalid entry name: '` for the empty name (now `'empty filename'`).
- `INVALID_FILE_MODE` stops being raised by `parseTreeContent` for unparseable modes.
  It is still raised for octal-but-unrecognised modes (`777777`, `100664`, `40644`) —
  the pre-existing, already-pinned divergence from git's `canon_mode`
  (`tree-diff-corrupt-interop.test.ts`, "git accepts it silently but tsgit throws
  INVALID_FILE_MODE"). That test is not touched.
- The **check order** inside `parseTreeContent` changes to match git's parse tier and
  the cursor's `scanEntryAt` (`scanMode` → `scanName` → `scanOid`). Target order, per
  entry:

  1. locate the mode/name separator; `'missing space after mode'` if absent
  2. **mode bytes**: empty or non-octal → `'malformed mode'` *(new position)*
  3. locate the NUL; `'missing null after name'` if absent
  4. **empty name** → `'empty filename'` *(new reason)*
  5. **name shape** via `classifyEntryNameBytes` → `'invalid entry name: …'`
  6. oid bounds → `'truncated hash'`
  7. **mode match** via the check-tier matcher → `INVALID_FILE_MODE`
  8. **duplicate**, keyed on raw bytes → `'duplicate entry name: …'`

  A tree with both a malformed mode and a bad name therefore reports the mode fault
  where it used to report the name fault, and a tree with a bad name *and* a duplicate
  still reports the name fault. Both reorderings are observable and each gets its own
  interop row rather than riding along as a side effect.
- `validateTree` findings change class for two inputs (`badFilemode` → `badTree` for a
  non-octal mode; `emptyName` → `badTree` for an empty name), and stop being emitted
  for six byte classes. Severity follows the msg-id, so `badTree`'s `error` replaces
  `emptyName`'s `warning` — which changes fsck's **exit code** from 0 to 1 on an
  empty-name tree without `--strict`, matching §1b row 13.
- D7(a) leaves `MSG_EMPTY_NAME` and its `DEFAULT_SEVERITY` row with no emitter; D8
  decides whether they are deleted. They are referenced only from `validate-tree.ts`
  and `severity.ts`.
- `checkSpecialFileName`'s `.gitmodules` / `.gitattributes` / `.gitignore` / `.mailmap`
  comparisons become **byte-exact**, which *narrows* them: today a BOM-prefixed
  `.gitmodules` is caught by accident. See the corresponding Out-of-scope entry — that
  narrowing is a real behaviour change and must be pinned by a test, not left to
  surface later.
- Every I/O and decompression fault still propagates unchanged; nothing here wraps a
  read.

### 6. What deliberately does not change

- `src/domain/objects/tree-cursor.ts` — no new check in `scanEntryAt`, `scanMode`,
  `scanName`, `scanOid`, `computeIsDir`, `compareCursorNames` or `cursorNameEquals`.
  ADR-723's addendum is the reason and its interop pins are the enforcement.
- `src/domain/objects/file-mode.ts::matchFileModeBytes` — the check-tier matcher stays
  byte-level and stays the emit-time refusal.
- `src/application/primitives/internal/raw-tree-diff.ts` — the merge-join keeps
  carrying neither the name-shape nor the duplicate check, matching `git diff-tree`.
- The three Stryker equivalence suppressions in `encoding.ts` and the two in
  `tree-cursor.ts` are untouched; the one in `resolve-tree-path.ts` is re-proved or
  dropped (§3).

---

## Decision candidates

Ten load-bearing choices. None is pre-decided by an existing ADR; D5 is one ADR-723
explicitly deferred to a future probe, and §1b is that probe. Two couplings to rule
together: **D7 → D8** (D8 exists only if D7(a) lands) and **D2 → D5/D10** (a lossy
`name` turns a dropped duplicate refusal into silent data collapse).

| # | Choice | Alternatives (≤3) | Recommendation | Why |
|---|---|---|---|---|
| **D1** | **Scope — which sites this change touches** | (a) all four: `tree.ts`, `flatten-raw.ts`, `validate-tree.ts`, plus extracting `resolve-tree-path.ts`'s predicate as the shared module. (b) the two object-parse sites now (`tree.ts`, `flatten-raw.ts`), fsck as a separate item. (c) `tree.ts` only, as backlog 30.3 literally says. | **(a)** | One root cause, four sites. §1d shows two of them disagreeing *inside a single `fsck` run*, so (b) ships a command that contradicts itself. (c) reproduces ADR-723's outcome exactly — one site fixed, the rest left as the new outliers — which is why this item exists. (a) also writes the shared helper once instead of twice. Cost: the diff spans `domain/objects`, `domain/fsck` and two application internals, and fsck's finding classes move (D7, D8), so the review surface is real. |
| **D2** | **`TreeEntry.name` fidelity — what makes `serializeTreeContent(parseTreeContent(b))` round-trip** | (a) leave `name` a lossy display string; fix only the refusal predicates; accept a documented non-round-tripping case. (b) switch the tree-name decode to the existing `decodePreservingBom()`. (c) carry raw name bytes alongside the display string, per ADR-747's shape — `readonly nameBytes?: Uint8Array` filled by the parse path only. | **(c)** | (a) is **actively worse than today**: with byte-level refusals but a lossy `name`, `FE` and `FF` both parse to entries named `"�"` — the false refusal becomes a silent collapse (two entries, one name, one `Map` key, a changed oid on re-serialize). Requirement 4 rules it out. (b) closes the BOM class and is cheap (one call site), but leaves the same collapse for invalid-UTF-8 names — and legacy-encoded filenames are exactly ADR-747's motivating real-world case. (c) is the only option that satisfies requirements 3 and 4 together, and it is the shape the user already ratified for reflogs. Cost, stated plainly: `TreeEntry` is named in 54 source files and referenced 110 times in `reports/api.json`; making `nameBytes` optional keeps every programmatic construction site (`writeTree`, index→tree, merge) compiling unchanged, with `serializeTreeContent`, `sortTreeEntries` and `treeEntryCompare` reading `entry.nameBytes ?? encode(entry.name)`. **If the cost is judged too high, (b) is the honest fallback** — it must then ship with the invalid-UTF-8 collapse recorded and asserted as a knowing divergence, not left silent. |
| **D3** | **Shape and home of the shared predicate** | (a) a classifier in a new `src/domain/objects/tree-entry-bytes.ts` returning an `EntryNameFault \| undefined`; each consumer maps it to a throw or a finding (§3). (b) two exports — a thrower for the three parse sites plus a boolean for fsck. (c) no shared module; fix each of the four sites in place. | **(a)** | fsck needs *findings*, the other three need *throws*, and fsck needs to distinguish `hasDot` from `hasDotdot` from `fullPathname` — a boolean cannot express that, so (b) forces fsck to keep its own copy and we are back to two implementations. (c) is what the codebase already tried; ADR-723's addendum is the receipt. (a) puts the byte semantics in exactly one place and leaves the *policy* (what a fault means) with each consumer, which is also what keeps the cursor out of it. |
| **D4** | **Duplicate-key and sort-key representation for raw name bytes** | (a) a `NameSpan[]` list plus pairwise byte comparison, as `resolve-tree-path.ts` does today. (b) a `Set<string>` keyed on a **byte→code-unit** string built with `String.fromCharCode` over the bytes (bijective by construction). (c) a `Set<string>` keyed on hex via the existing `bytesToHex`. | **(b)** | (a) is O(n²) per directory — acceptable for a single-name path scan, not for `parseTreeContent` over a wide tree or for fsck's sort/duplicate passes, both of which are whole-directory. (c) is trivially correct but doubles key length on a hot path. (b) keeps O(1) lookup and one code unit per byte, which V8 stores as a one-byte string. **Trap to encode in the implementation:** `new TextDecoder('latin1')` is *not* a byte-identity map — the spec aliases `latin1`/`iso-8859-1` to windows-1252, where `0x81`, `0x8D`, `0x8F`, `0x90`, `0x9D` decode to U+FFFD and collide. The key must be built manually (chunked `String.fromCharCode`, never a spread — a 4096-byte name would blow the stack). |
| **D5** | **The duplicate-name refusal set** | (a) keep the refusals in `parseTreeContent` and `resolve-tree-path`, re-keyed on raw bytes; `flatten` stays last-wins. (b) drop the refusal from both, matching git's read surfaces: descent resolves **first**-wins, materialisation keeps **last**-wins, detection lives only in fsck. (c) drop it from `resolve-tree-path` (a descent, where git answers) but keep it in `parseTreeContent`. | **(a) — with the caveat below** | This is ADR-723's option 2, and §1b rows 14–15 are the pin it asked for: **git's read surfaces all accept duplicates** (`ls-tree` lists both, `diff-tree` diffs both, `read-tree` keeps the last, `rev-parse <tree>:a` resolves the first); only `fsck` and write-side fsck refuse. So (b) is what the prime directive points at, and the standing "always choose the git-faithful fix" principle points there too. I recommend (a) for *this* change because (b) is a refusal-set change, not a byte-sensitivity change: it needs its own per-surface tie-break rules (first-wins vs last-wins), and under D2 anything but (c) makes a duplicate-bearing `Tree` a silent collapse. **This is the candidate most likely to be ratified against the recommendation, and that is a legitimate outcome** — if it is, §4's duplicate row and the `parseTreeContent`/`scanRawTreeFor` duplicate sets go, ADR-723 is superseded rather than refined, and the interop suite gains first-wins/last-wins parity rows instead of co-refusal rows. |
| **D6** | **The name-shape refusal set (`.`, `..`, `/`)** | (a) keep all three refusals on all three parse sites, byte-level. (b) keep `.`/`..`, drop the embedded-`/` refusal — git's `read-tree` materialises `a/b` as a nested path (row 11) and `rev-parse <tree>:a/b` resolves it. (c) drop all three, matching `ls-tree`. | **(a)** | `.`/`..` are defensible on every site: row 9/10 shows `git read-tree` itself refusing them with `error: invalid path '.'`, so the worktree-materialisation surface agrees. The `/` case is genuinely divergent (row 11) and (b) is the faithful answer for `flatten` — but dropping it there means `joinPath` produces a path with an embedded separator that no longer corresponds to one tree level, and the same name reaches `resolve-tree-path`'s segment splitter, where a `/`-bearing entry can never be addressed anyway. (c) additionally re-admits the path-traversal shape that `..` exists to stop. (a) keeps today's behaviour and makes it *correct about bytes*, which is this item's actual mandate; (b)/(c) are refusal-set changes with a security-adjacent edge and belong to a decision of their own. |
| **D7** | **The parse tier — mode bytes *and* the empty name** | (a) adopt the cursor's split on both defective sites, for **both** parse-tier faults: scan mode bytes for empty/non-octal and the name span for emptiness **first** → `INVALID_TREE_ENTRY 'malformed mode'` / `'empty filename'` (fsck: `badTree`), then the existing check-tier matcher for octal-but-unrecognised (`INVALID_FILE_MODE` / `badFilemode`). Extract `hasNonOctalByte` into the shared module. (b) mode only — fix the mode tier, leave the empty name where it is. (c) no change. | **(a)** | ADR-723's addendum already probed the mode half and ruled the cursor's split is git's — rows 19/20 vs row 18 reproduce it exactly, and row 19's fsck output (`badTree`, not `badFilemode`) extends the same finding to site 3. Row 13 shows the empty name is the *same* tier and the *same* collapse (`error: empty filename in tree entry` → `badTree`, before fsck's check tier runs), so splitting it off is arbitrary. (a) makes `parseTreeContent`'s error data **identical to the cursor's** for every parse-tier fault, which is what makes `parseTreeContent` usable as the cursor's differential oracle again (ADR-520). (c) leaves it the named outlier ADR-723 flagged. **Two riders:** (a) changes which fault a doubly-malformed tree reports (mode before name) — an observable reorder needing its own interop row; and `parseTreeContent`'s empty-name reason string changes from `'invalid entry name: '` to `'empty filename'`, which is a visible error-data change on a published parse path. |
| **D8** | **What happens to the now-orphaned `emptyName` msg-id** — D7(a) makes fsck report `badTree` for an empty name, leaving `MSG_EMPTY_NAME` with no emitter | (a) delete `MSG_EMPTY_NAME` and its `DEFAULT_SEVERITY` row — `validate-tree.ts` and `severity.ts` are its only referents. (b) keep both, unreferenced, so `msg-ids.ts` stays a complete mirror of upstream's `fsck-msgids.adoc`, and take an explicit no-dead-code exemption in the ADR. (c) do not adopt D7's empty-name half, keeping `emptyName` alive but wrong (row 13: git says `badTree:error`, tsgit says `emptyName:warning`, so fsck's exit code differs too). | **(a)** | The repo's no-dead-code rule is unqualified, and `msg-ids.ts`'s own header calls itself "pinned … and cross-checked **behaviourally**" — a constant no behaviour can produce fails that second half. (b) is defensible if the user values the catalogue as documentation of git's id space, but it needs the exemption stated in the ADR rather than absorbed silently. (c) is listed only to make the coupling visible: D8 exists **because** D7(a) is recommended, and ruling D7(b) dissolves D8 entirely. |
| **D9** | **Where the interop pins live** | (a) one new `test/integration/tree-entry-bytes-interop.test.ts` claiming `interopSurface: tree`, carrying every §1b row across all four sites. (b) split by surface — parse/flatten rows extend `tree-interop.test.ts`, fsck rows extend `fsck-interop.test.ts`. (c) extend `tree-diff-corrupt-interop.test.ts`, which already has the `--literally` tree-building helpers. | **(a)** | The matrix is one contract across four consumers; splitting it (b) means the BOM row is written three times and can drift row by row. (c) is tempting for the helpers but its declared `interopSurface` is **`diff`** and its whole premise is the merge-join's *narrower* refusal surface — adding parse-tier rows there would blur exactly the distinction ADR-723 defends. (a) copies the six-line `rawEntry`/`buildLiteralTree` helper set from (c) and claims `tree`; the write-surface audit's `Coverage.coveredBy` is a list, so claiming `tree` alongside `tree-interop.test.ts` aggregates rather than conflicts (precedent: the reflog suite's second claim on `reflog`). |
| **D10** | **The `FilePath` collapse — two entries whose names differ only in invalid UTF-8 still map to one `FlatTree` key** | (a) accept the limit: `flatten`, `build-index-from-tree` and everything keyed on `FilePath` keep last-wins for such siblings; record and **assert** the divergence. (b) re-type `FilePath` / `FlatTree` keys to a byte-backed key. (c) make `flatten` refuse a name that does not survive a UTF-8 round trip. | **(a)** | `FilePath` is the repo's path currency — index, status, diff, checkout, pathspec, gitignore, sparse-checkout all key on it — so (b) is a repo-wide re-typing an order of magnitude larger than this item, and it would have to answer what a non-UTF-8 path even means to the working-tree adapters. (c) invents a refusal git does not have (row 4: `read-tree` makes two index entries) and would make `flatten` *less* faithful than it is now. (a) is honest: the tree-object layer becomes byte-correct (D2), and the path layer's limit is stated at its real boundary with a test that fails the day someone claims otherwise. **Note the platform interaction:** on macOS/APFS `git checkout-index` itself fails on such a name (`Illegal byte sequence`, row 4), so the divergence is only observable end-to-end on a filesystem that permits the bytes — the interop assertion must therefore be made at the `FlatTree` level, not by comparing worktree contents. |

---

## Test strategy

### Unit

- **`test/unit/domain/objects/tree.test.ts`** — one isolated test per §1b class, each
  asserting the parsed entries (names as bytes and as strings), not a count. Every
  refusal asserts the error `.data` (code + offset + reason) via `try`/`catch`, never
  `toThrow(TsgitError)`. The classes that flip from refuse to accept get an
  *accept-and-assert-the-entries* test, because "it did not throw" would survive a
  mutant returning the wrong entry set.
- **Guard isolation.** `classifyEntryNameBytes` has four independent faults; each gets
  a test that triggers **only** that fault (`.`, `..`, a lone `/`, an empty span), plus
  the near-misses the loop must not fire on: a leading `/`, a trailing `/`, `//`, a
  name whose *decoded* form is `.` but whose bytes are not (`EF BB BF 2E`). A single
  test triggering two faults proves neither guard alone.
- **`test/unit/domain/objects/tree-entry-bytes.test.ts`** (new) — the classifier, the
  byte-length helper, and the key helper, including the D4 trap: `entryNameKey` must
  return distinct keys for `[0xFF]`, `[0xFE]`, `[0x81]`, `[0x8D]`, `[0x90]` and
  `[0x9D]` (the five windows-1252 holes), and must handle a 4097-byte name without a
  stack overflow.
- **`test/unit/domain/fsck/validate-tree.test.ts`** — the §1c false-positive and
  false-negative rows become assertions of *no finding* / *the right finding*: the
  4096/4097 raw-byte boundary in **both** encodings (rows 21–24), the four sort orders
  (rows 25–28) asserting `treeNotSorted` present in two and absent in two, the
  `badTree`-vs-`badFilemode` split (rows 18–20), and D8's empty-name class.
  Both `strict` values, since D8/D7 move severities.
- **`test/unit/application/primitives/flatten-tree.test.ts`** — the bare-BOM row is a
  **regression** test with a failing baseline (today it yields a path with an empty
  final segment), not a confirmation test. The existing last-wins duplicate test at
  L482+ stays and gains a comment naming row 14 as its oracle.
- **`test/unit/application/primitives/internal/resolve-tree-path.test.ts`** — proves the
  extracted classifier is the same predicate: the existing refusal rows keep their exact
  error data.
- **`test/unit/domain/objects/git-object.test.ts`** / round-trip — under D2(c), a tree
  parsed from BOM-bearing and invalid-UTF-8-bearing bytes re-serializes to the **same
  bytes** (`toEqual` on the `Uint8Array`), which is the only assertion that catches a
  `nameBytes`-dropping mutant.

### Property tests

Apply the four lenses (CLAUDE.md) to what actually changes.

- **Lens 1 — round trip.** `parseTreeContent(serializeTreeContent(t))` ≡ `sort(t)` over
  an arbitrary whose names are **arbitrary NUL-free byte sequences**, not
  `fc.string()`. `test/unit/domain/objects/arbitraries.ts::arbTreeEntryAnyMode`
  currently generates `fc.string()` filtered on `\0`, `/`, `.` and `..` — that
  arbitrary **cannot generate the defect** and must gain a byte-oriented sibling
  (`arbTreeEntryRawName`) that emits BOMs, lone `0x80`-`0xFF` bytes and multi-byte
  sequences. This is the property that decides D2 empirically: under (a) or (b) it will
  find a counterexample; under (c) it must hold. `numRuns: 200`.
  *Under D2(a)/(b) it must be written as a documented partial property with the
  excluded class named, not deleted.*
- **Lens 3 — total function over a grammar.** `validateTree(anyBytes, strict, 20)`
  never throws, for arbitrary byte input. It already must not (its contract says so);
  the byte-level rewrite is where that could regress. `numRuns: 100`.
- **Lens 4 — counting invariant.** For an arbitrary tree of raw-byte names,
  `parseTreeContent(...).entries.length` equals the number of records in the input
  whenever no name is byte-duplicated — i.e. distinct bytes never collapse. This is the
  invariant form of requirement 4; it does not re-implement the parse loop because the
  record count comes from the arbitrary's own generation, not from a second parser.
  `numRuns: 100`.
- **`tree-cursor.properties.test.ts`** already asserts the cursor and
  `parseTreeContent` yield the same `(mode, name, oid)` sequence. Under D2(c) that
  property must widen to name **bytes**, or it silently stops being a differential
  oracle for exactly the field this change is about.

No property is written for the mode tiers — a mode is a small enum plus a
non-octal-byte scan, and a parameterised example sweep is clearer (CLAUDE.md's
"small enum" exclusion).

### Interop — `test/integration/tree-entry-bytes-interop.test.ts` (new, per D9)

Header: `@proves surface: tree · bucket: cross-tool-interop · interopSurface: tree ·
unique: exotic entry-name bytes and mode tiers match canonical git across every tsgit
read path`.

Uses `test/integration/interop-helpers.ts` (`GIT_AVAILABLE`, `runGit`,
`tryRunGitWithExit`) — `GIT_*` already scrubbed, `HOME`/XDG isolated,
`GIT_CONFIG_NOSYSTEM=1`. `merge.conflictStyle` is irrelevant and is **not** pinned.
One shared `beforeAll` builds the base repo (**60 s timeout** — the 10 s default flakes
under full-`validate` concurrency), and each case builds a fresh `Context` **after** its
own git-external writes, for the stale-fanout-cache reason `tree-diff-corrupt-interop.test.ts`'s
header documents. Copy `rawEntry` / `buildLiteralTree` / `concatBytes` from there.

Cases, one per pinned group:

1. **Parse-tier co-refusal** — rows 13, 19, 20. `git ls-tree` exits 128 with
   `fatal: empty filename in tree entry` / `fatal: malformed mode in tree entry`; tsgit
   refuses with `INVALID_TREE_ENTRY` + the matching reason, on **all three** parse
   sites (`readTree`, `flattenTree`, `revParse('<tree>:<name>')`). Assert the error
   `.data`, and assert git's exit code — a co-refusal case with only one side asserted
   is a vacuous pass.
2. **Byte-class acceptance** — rows 2–7. For each, `git ls-tree -z` (raw bytes, no
   octal quoting) and tsgit agree on the entry set. Display parity is proven by
   reconstructing git's `<mode> <type> <oid>\t<name>` line from the structured fields
   inside the test (ADR-249). Row 4 asserted through `readTree` must yield **two**
   `Tree.entries`, which is the assertion that kills a key-collapse mutant.
3. **Round-trip bytes** — for rows 2, 3, 4, 7: read the tree with tsgit, re-serialize,
   and compare to the on-disk object body **byte for byte**. This is D2's only direct
   oracle; under D2(a)/(b) it becomes an asserted divergence with the exact expected
   difference, never a skip.
4. **Worktree materialisation** — rows 9–11 through `flattenTree` against
   `git read-tree` + `git ls-files -s -z`: `.` and `..` co-refuse (git exit 128 with
   `error: invalid path`), `a/b` is D6's asserted divergence (git materialises,
   tsgit refuses), and the bare-BOM path is asserted equal on both sides.
5. **Duplicate behaviour** — row 14, per surface: `git ls-tree` lists both;
   `git read-tree` keeps the last and tsgit's `flattenTree` keeps the last (parity);
   `git rev-parse <tree>:a` resolves the first while tsgit's descent refuses
   (D5's asserted divergence, or parity if D5(b) is ratified).
6. **fsck parity** — rows 13, 18–28. Reconstruct git's
   `error in tree <oid>: <msgId>: <text>` line from tsgit's structured `FsckFinding`
   fields and compare, plus the exact exit code, both with and without `--strict`.
   Rows 21–24 pin the 4096/4097 boundary in both encodings; rows 25–28 pin
   `treeNotSorted` present in two orders and **absent** in the other two — the absent
   half is what catches a sort-key regression. Row 18 pins that `badFilemode` stays
   exit 0 even under `--strict`.
7. **The fsck two-pass agreement** (§1d) — one BOM-name tree, one `fsck` run: git
   reports nothing and exits 0, and tsgit reports **no finding at all**, neither from
   the content pass nor as an unreadable object from the cache pass.
8. **The `FilePath` limit (D10)** — row 4 through `flattenTree`: git's index carries
   **two** entries (`git ls-files -s -z`), tsgit's `FlatTree` carries **one**. Asserted
   as a divergence at the `FlatTree` level, never by comparing worktree contents —
   `checkout-index` itself fails on those names on APFS (row 4), so a worktree
   comparison would pass for the wrong reason on macOS and fail on Linux.
9. **Check-order rows (D7's riders)** — two fixtures that are faulty twice over:
   (i) non-octal mode *and* name `.` → both git and tsgit report the **mode** fault;
   (ii) name `.` *and* a duplicate of it → both report the **name** fault. These are
   the only cases that observe the reordering; without them a mutant restoring the old
   order is invisible.
10. **SHA-256** — at least one acceptance row and one parse-tier refusal row re-run on
    `git init --object-format=sha256`, so hash-width independence stays measured.

### Mutation

Scoped Stryker over `src/domain/objects/tree.ts`,
`src/domain/objects/tree-entry-bytes.ts`, `src/domain/fsck/validate-tree.ts`,
`src/application/primitives/internal/flatten-raw.ts` and
`src/application/primitives/internal/resolve-tree-path.ts`, per
`.claude/workflow/mutation.md`. Watch for:

- **the moved `EqualityOperator` suppression** on `isInvalidEntryNameBytes`
  (resolve-tree-path.ts L243). Its proof cites that loop's bound *and* its covering set;
  after extraction both change. Re-prove against the new structure or drop it — never
  carry the comment across.
- **boundary mutants on the byte-length comparison** (`length === 1` / `length === 2`
  in the dot/dotdot arms, `> MAX_NAME_BYTES` in fsck). The 4096/4097 pair is the only
  thing that separates `>` from `>=`.
- **the `entryNameKey` chunk loop** — an off-by-one there produces a key that is still
  unique for short names, so only a long-name test (≥ 4097 bytes) kills it.
- **D7's reordering** — a mutant restoring the old check order is invisible to any test
  that triggers one fault at a time; the doubly-malformed fixture (non-octal mode *and*
  name `.`) is its only killer.
- **D2(c)'s `nameBytes ?? encode(name)` fallback** — a mutant deleting the `??` arm is
  invisible to every parse test (the parse path always fills `nameBytes`); only a
  programmatically-constructed `TreeEntry` (writeTree) round-trip sees it.

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

  Two follow-on facts: tsgit already misses every other HFS-ignorable code point
  (U+200C–U+200F, U+202A–U+202E, U+206A–U+206F), every case variant, and every NTFS
  form, so the accidental agreement covers exactly one input out of a large family;
  and the fix (git's `is_hfs_dotgit` / `is_ntfs_dotgit`) is a distinct feature from
  byte-sensitivity with its own matrix.

  **Recorded as measured and excluded; no fix is designed here.** The orchestrator is
  putting the exclusion — and the regression it carries — to the user at the decisions
  phase alongside D1. If it is excluded, the implementation must still land a test
  asserting the *new* (narrower) behaviour with a comment naming this paragraph, so the
  narrowing is pinned rather than discovered later.
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
- **`TreeCursor` and `raw-tree-diff.ts`** — ADR-723, §6. Not re-litigated.
- **`serializeTreeContent`'s sort normalisation.** A tree parsed from on-disk-unsorted
  bytes re-serializes in canonical order and gets a different oid, so the `@writes
  kind: equivalent-under-readback` header stays `equivalent-under-readback` regardless
  of D2. D2 makes the header honest about *name bytes*; the sort is a separate,
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
