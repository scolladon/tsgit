# Design — fsck's dotgit alias fold reads raw bytes the way git's HFS reader does

> Brief: backlog 32.26. A tree holding `.git\xff/x`-style names (`.git` followed by a byte git's UTF-8 reader rejects) gets `hasDotgit` from `git fsck`; `tsgit fsck` reports nothing, because its HFS fold reads a decoded view. Fix it for all five names git's `fsck_tree` folds (`.git`, `.gitmodules`, `.gitattributes`, `.gitignore`, `.mailmap`), pinned on git 2.56.0.
> Status: draft → self-reviewed ×3

## Context

**The fold.** `src/domain/objects/tree-entry-bytes.ts` `matchesDotgitAlias(buf, start, end, alias)` (L238) is `foldsToHfsAlias(...) || matchesNtfsDotgitAlias(...)`. `foldsToHfsAlias` (L86) decodes `buf.subarray(start, end)` with `HFS_DECODER` (L70, `TextDecoder('utf-8', { ignoreBOM: true })`). It drops `HFS_IGNORABLE_CODE_POINTS` (L50), ASCII-folds the rest with `foldAsciiCodePoint` (L72), and requires the result to be **exactly** `.<alias>` (`matched === wantLength`). That gets two things wrong (matrix below):

1. **Rejected byte after the needle.** The decoder turns a byte git's picker rejects into U+FFFD. That is one more character, so `matched >= wantLength` returns false. git reads a rejected sequence as end-of-name, so the name **matches**.
2. **Directory separator after the needle.** git's final check is `if (c && !is_dir_sep(c)) return 0`, so `.gitmodules/x` matches. tsgit requires end-of-span. For `.git` the NTFS arm hides this (`isNtfsTail` stops at `/` for `git` only). For the other four names, and for HFS-only `.git` forms such as `.g<ZWNJ>it/x` or `<BOM>.git/x`, it is a real miss.

The NTFS arm (`matchesNtfsDotgitAlias`, `isNtfsTail`, `foldsToNtfsShortName`) is byte-level already and agrees with git on every pinned row (rows N1–N6, `git~1\xff`, `x\.git\xff`). This change does not touch it.

**Callers (every route into the fold, all walked).**

| Caller | File : symbol | Alias(es) |
|---|---|---|
| `hasDotgit` | `src/domain/fsck/validate-tree.ts` `namesDotgit` (L166) | `git` |
| symlink checks | same file, `checkSpecialFileName` (L217-238) → `symlinkOnlyFindings` (L190-209) | `gitmodules`, `gitattributes`, `gitignore`, `mailmap` |
| content-check queue | `src/application/commands/internal/fsck/special-blobs.ts` `specialBlobNames` (L37-44), through `namesGitmodules` (tree-entry-bytes.ts L264) and `matchesDotgitAlias(…, 'gitattributes')` | `gitmodules`, `gitattributes` |

`backslashGitmodulesSymlinks` and the backslash segments of `namesDotgit`/`namesGitmodules` call `matchesNtfsDotgitAlias` only, so they are unaffected (git also runs only `is_ntfs_*` on backslash segments).

**The picker already exists on the index side.** `src/domain/path/verify-path.ts` has `isNonCharacterTail` (L63), `acceptedSequenceLength` (L69) and `export gitPickerValidPrefix` (L76). They are built on `src/domain/objects/encoding.ts` `wellFormedSequenceLength` (L148, Unicode Table 3-7), which differs from git's `pick_one_utf8_char` only on U+FFFE/U+FFFF. `isNonCharacterTail` patches that difference (ADR-978, design `docs/design/index-entry-path-bytes.md` §D17). Import direction: `verify-path.ts` imports `matchesNtfsDotgitAlias` from `objects/tree-entry-bytes.ts`, so `tree-entry-bytes.ts` cannot import `verify-path.ts` without a cycle. `encoding.ts` has no imports.

**ADRs that constrain this design:**

- ADR-226 (prime directive) and ADR-249 (structured findings; the interop test rebuilds git's line).
- ADR-763: fsck implements git's dotgit alias matrix. The fold is one byte-level function in the shared entry-bytes module and applies only to the alias comparisons. Duplicate, sort and length keys stay raw. This change completes 763's HFS matrix; it does not revisit it.
- ADR-978: the HFS check reads raw bytes and stops at the first sequence git's picker rejects. That is the same rule on the index side, so this design adopts its semantics for trees.
- ADR-748 (tree byte sensitivity spans every decoding read path) and ADR-751 (byte keys from char codes, never a text decoder). Removing `HFS_DECODER` takes the last decoder out of this module.
- ADR-756: tree byte-parity pins live in **one** interop suite, `test/integration/tree-entry-bytes-interop.test.ts`.
- ADRs 1107/1108/1116 (fsck exit bits and scope under 2.56), 877 (`[fsck]` config / severities), 919 (fsck audits every object source). They are unchanged; the new findings flow through the existing `resolveSeverity` and exit-bit path.
- ADRs 134–136 (property siblings, `numRuns` tiers, additive).

## Requirements

- R1. For each of the five aliases, the HFS arm matches git's `is_hfs_dot_generic` on raw bytes:
  - Ignorable code points are skipped at any position, but only when git's picker accepts the sequence.
  - Each needle character is compared case-insensitively against ASCII; a non-ASCII character or a rejected sequence fails.
  - After the needle and any trailing ignorables, the name matches when it ends there, when git's picker rejects the next sequence, or when the next character is `/`.
- R2. Every row of the pinned matrix holds on tsgit: findings by `msgId`, `severity` and object id, plus the exit code, with and without `--strict`.
- R3. Only one implementation of git's picker exists in `src/`. Index-side behaviour is unchanged: every existing `verify-path` test passes, with only import paths edited and the `gitPickerValidPrefix` table moved.
- R4. The alias fold allocates no decoder output. It reads only `buf[start, end)`, and no picker look-ahead crosses `end`.
- R5. The wrong unit pin (`test/unit/domain/objects/tree-entry-bytes.test.ts` L444-459, expects `false` for `.git` + FF) is re-pinned to `true`, with git as the cited oracle. It is not deleted.

## Design

### Pinned facts — git 2.56.0 as data

Every row ran in a scrubbed `mktemp -d` throwaway with `env -i`, an isolated `HOME`, `GIT_CONFIG_NOSYSTEM=1`, a user-only config, and `-c commit.gpgsign=false -c gc.auto=0`. Each script ran twice with identical results. Scripts and logs are in `<scratchpad>`:

- `probe-git-dotgit.sh`: `mktree` fixtures, the brief's matrix.
- `probe2/`, `probe4/`, `probe5/` `probe.sh` with `mktree.py`: raw tree bodies through `hash-object -t tree --literally`, because `mktree` refuses `/`.
- tsgit at `a091b533`: `probe-tsgit-dotgit.mjs` and `probe2/tsgit.mjs`, run on `<main-repo-dir>/dist/esm/index.node.js`.

**Fixture shape.** One literal tree per row: the named entry plus a `z` blob (sorted after every `.`-led name), committed via `commit-tree` and pointed at by `refs/heads/main`. Entry kinds:

- `dir`: `40000`, a subtree holding `x`.
- `blob`: `100644` `hello\n`.
- `link`: `120000`.
- `gmblob`: `100644` blob `[\n` (unparseable `.gitmodules`).
- `galong`: `100644` blob of one 3000-byte line.

Unless marked `--strict`, rows run without it. "—" means no finding.

**Source (utf8.c v2.56.0).**

- `pick_one_utf8_char` (L122-192) rejects:
  - a lead byte 0x80-0xBF or ≥ 0xF8;
  - C0/C1 leads;
  - a non-continuation follow byte (including the name's terminating NUL, so truncated sequences are rejected);
  - E0 80-9F (overlong);
  - ED A0-BF (surrogate);
  - EF BF BE/BF (U+FFFE/U+FFFF);
  - F0 80-8F (overlong);
  - F4 90+;
  - a lead above F4.
- `next_hfs_char` (L703-741) returns 0 on a rejection.
- `is_hfs_dot_generic` (L743-776): the first character is `.`, each needle character is `c > 127 → 0` then `tolower(c) == needle`, and after the needle `if (c && !is_dir_sep(c)) return 0; return 1;`.
- `fsck_tree` (fsck.c L616-713) runs `is_hfs_*` || `is_ntfs_*` on the whole name for all five aliases. On each backslash segment it runs only `is_ntfs_dotgit`/`is_ntfs_dotgitmodules`.

**M1 — rejected sequence after the needle (the reported gap).** Each rejection rule in the picker has its own row.

| Row | Name bytes | Kind | Rule that rejects | git | tsgit main |
|---|---|---|---|---|---|
| A | `.git` FF | dir | lead ≥ F8 | 0, warning hasDotgit | 0, — |
| A2 | `.git` FF | blob | lead ≥ F8 | 0, hasDotgit | 0, — |
| AB | `.git` FE | dir | lead ≥ F8 | 0, hasDotgit | — |
| R3 | `.git` F8 80 80 80 80 | dir | lead ≥ F8 (lowest) | 0, hasDotgit | — |
| B | `.git` 80 | dir | stray continuation lead | 0, hasDotgit | — |
| D | `.git` C0 80 | dir | C0 lead | 0, hasDotgit | — |
| R1 | `.git` C1 BF | dir | C1 lead | 0, hasDotgit | — |
| AC | `.git` C2 | dir | 2-byte truncated (NUL follows) | 0, hasDotgit | — |
| C | `.git` E2 80 | dir | 3-byte truncated | 0, hasDotgit | — |
| R4 | `.git` E2 80 41 | dir | 3-byte bad third byte | 0, hasDotgit | — |
| F2 | `.git` E2 C0 8C | dir | 3-byte bad second byte | 0, hasDotgit | — |
| L | `.git` E0 80 AF | dir | E0 overlong | 0, hasDotgit | — |
| R2 | `.git` E0 80 | dir | E0 truncated | 0, hasDotgit | — |
| J | `.git` ED A0 80 | dir | surrogate | 0, hasDotgit | — |
| I | `.git` EF BF BE | dir | U+FFFE | 0, hasDotgit | — |
| I2 | `.git` EF BF BF | dir | U+FFFF | 0, hasDotgit | — |
| R5 | `.git` F0 9F 98 41 | dir | 4-byte bad fourth byte | 0, hasDotgit | — |
| L2 | `.git` F0 80 80 80 | dir | F0 overlong | 0, hasDotgit | — |
| K | `.git` F4 90 80 80 | dir | above U+10FFFF | 0, hasDotgit | — |
| K2 | `.git` F5 80 80 80 | dir | lead above F4 | 0, hasDotgit | — |
| E | `.GIT` FF | dir | case fold + reject | 0, hasDotgit | — |
| T | `.git` FF FF | dir | first rejection ends the read | 0, hasDotgit | — |
| V | `.git` E2 80 8C FF | dir | ignorable, then reject | 0, hasDotgit | — |
| W | `.git` FF E2 80 8C | dir | reject, rest unread | 0, hasDotgit | — |
| F3 | `.gi` E2 80 8C `t` FF | dir | ignorable mid-needle + reject | 0, hasDotgit | — |
| P2 | `.` E2 80 8C `GIT` FF | dir | ignorable + case + reject | 0, hasDotgit | — |
| P1 | E2 80 8C `.git` FF | dir | leading ignorable + reject | 1, hasDotgit + error treeNotSorted (fixture artefact: E2 sorts after `z`) | 1, treeNotSorted only |
| AE | `.git` E2 `x` | dir | 3-byte bad second byte (ASCII) | 0, hasDotgit | — |
| AF | `.g` E2 80 8C `it` 80 | dir | ignorable mid + stray continuation | 0, hasDotgit | — |

**M2 — other aliases, same rule.**

| Row | Name bytes | Kind | git | tsgit main |
|---|---|---|---|---|
| P | `.gitmodules` FF | gmblob | 0, warning in blob gitmodulesParse (blob queued under `.gitmodules`) | 0, — |
| AD | `.gitmodules` FF | blob `hello\n` | 0, — (parses) | 0, — |
| P2l | `.gitmodules` FF | link | **1, error gitmodulesSymlink** | **0, —** |
| G1 | `.gitattributes` FF | galong | **1, error in blob gitattributesLineLength** | **0, —** |
| G2 | `.gitattributes` (control) | galong | 1, gitattributesLineLength | 1, gitattributesLineLength |
| Q | `.gitattributes` FF | link | 0, warning gitattributesSymlink | 0, — |
| R | `.gitignore` FF | link | 0, warning gitignoreSymlink | 0, — |
| S | `.mailmap` FF | link | 0, warning mailmapSymlink | 0, — |
| F7 | `.gitignore` FF | blob | 0, — (regular file: no check) | 0, — |
| F6 | `.mailmap` FF | blob | 0, — | 0, — |

**M3 — directory separator after the needle (folded: same function, same rule).**

| Row | Name bytes | Kind | git | tsgit main |
|---|---|---|---|---|
| S1 | `.gitmodules/x` | link | **1, error gitmodulesSymlink** + warning fullPathname | **0, fullPathname only** |
| S8 | `.gitmodules` FF `/x` | link | **1, gitmodulesSymlink** + fullPathname | **0, fullPathname only** |
| S9 | `.gitmodules` E2 80 8C `/x` | link | **1, gitmodulesSymlink** + fullPathname | **0, fullPathname only** |
| S2 | `.gitmodules/x` | gmblob | 0, fullPathname + gitmodulesParse (blob queued) | 0, fullPathname only |
| P3 | `.gitmodules` FF `/x` | gmblob | 0, fullPathname + gitmodulesParse | 0, fullPathname only |
| S3 | `.gitignore/x` | link | 0, gitignoreSymlink + fullPathname | 0, fullPathname only |
| S4 | `.mailmap/x` | link | 0, mailmapSymlink + fullPathname | 0, fullPathname only |
| S5 | `.gitattributes/x` | link | 0, gitattributesSymlink + fullPathname | 0, fullPathname only |
| S6 | `.g` E2 80 8C `it/x` | dir | 0, fullPathname + hasDotgit | 0, fullPathname only |
| F4 | EF BB BF `.git/x` | dir | 1, fullPathname + hasDotgit + treeNotSorted (artefact) | 1, fullPathname + treeNotSorted |
| S7 | `.git/x` (control, NTFS arm) | dir | 0, fullPathname + hasDotgit | 0, hasDotgit + fullPathname |
| N5 | `.git /x` (control, NTFS arm) | dir | 0, fullPathname + hasDotgit | 0, hasDotgit + fullPathname |

**M4 — controls that must stay as they are (both tools agree today).**

| Row | Name bytes | Kind | Both tools | Guards against |
|---|---|---|---|---|
| F | `.g` FF `it` | dir | — | a rejection inside the needle must fail |
| F1 | `.g` E2 C0 8C `it` | dir | — | a *rejected* sequence whose arithmetic equals U+200C is not ignorable |
| Z | `.` FF `git` | dir | — | rejection right after the dot |
| G | FF `.git` | dir | — | rejection before the dot |
| U | `.gitx` FF | dir | — | an ASCII character after the needle |
| F5 | `.gitx/y` | dir | fullPathname only | `/` only counts right after the needle |
| M | `.git` C3 A9 (é) | dir | — | a valid 2-byte character after the needle |
| V8 | `.git` C2 80 | dir | — | lowest valid 2-byte |
| V6 | `.git` E0 A0 80 | dir | — | lowest valid E0 sequence (overlong boundary) |
| V2 | `.git` E2 98 83 | dir | — | valid 3-byte |
| V5 | `.git` ED 9F BF | dir | — | highest non-surrogate ED (surrogate boundary) |
| V9 | `.git` EF BE BF | dir | — | U+FFBF (non-character boundary, second byte) |
| V1 | `.git` EF BF BD (literal U+FFFD) | dir | — | a real U+FFFD is a character, not a rejection |
| V7 | `.git` F0 90 80 80 | dir | — | lowest valid F0 (overlong boundary) |
| V3 | `.git` F0 9F 98 80 | dir | — | valid 4-byte |
| V4 | `.git` F4 8F BF BF | dir | — | U+10FFFF (upper boundary) |
| N | `git~1` FF | dir | — | NTFS arm unaffected |
| O | `x\.git` FF | blob | — | backslash segment is NTFS-only |
| N1–N4, N6 | `\x\.gitmodules/y`, `x\.gitmodules/y`, `.gitmodules /x`, `.gitignore /x`, `gitmod~1/x` | link | fullPathname only | the NTFS arm does not treat `/` as a terminator for the four non-`git` aliases |
| H | `.git` EF BB BF | dir | hasDotgit | ignorable tail (already caught) |
| X | `.gitmodules` EF BB BF | gmblob | gitmodulesParse | ignorable tail (already caught) |
| Y | `.git` | dir | hasDotgit | exact name |

**M5 — severity and exit code (decision point 2 of the brief: a pinned fact, not a candidate).**

| Row | Mode | git | tsgit main |
|---|---|---|---|
| T1 | `.git` FF dir, `--strict` | 1, **error** hasDotgit | 0, — |
| T2 | `.gitmodules` FF link, `--strict` | 1, error gitmodulesSymlink | 0, — |
| T3 | `.gitattributes` FF link, `--strict` | 0, **warning** gitattributesSymlink (INFO, never upgraded) | 0, — |

fsck.h 2.56 agrees:

- `HAS_DOTGIT` is WARN, so it is ERROR under `--strict`.
- `GITMODULES_SYMLINK` and `GITATTRIBUTES_LINE_LENGTH` are ERROR.
- `GITATTRIBUTES_SYMLINK`, `GITIGNORE_SYMLINK`, `MAILMAP_SYMLINK` and `GITMODULES_PARSE` are INFO, printed as `warning` and never upgraded.

tsgit's existing `resolveSeverity` table already maps these (Case 12 pins `hasDotgit` and `gitattributesSymlink`), so no severity code changes.

**Rows whose tsgit exit code changes:**

- Without `--strict`: P2l, S1, S8, S9 (`gitmodulesSymlink` error) and G1 (`gitattributesLineLength` error, reached because the blob is now queued). Every other new finding is WARN or INFO.
- With `--strict`: also every `hasDotgit` row in M1 and M3.

### D1 — the HFS arm is a byte-level port of `is_hfs_dot_generic`

`foldsToHfsAlias` keeps its signature `(buf: Uint8Array, start: number, end: number, alias: DotgitAliasName): boolean`. Its body becomes a walk over `name = buf.subarray(start, end)`. That is a view, not a copy. It bounds every picker look-ahead at `end`, as git's NUL does, and it is what makes a sequence truncated at the span's end a rejection.

```ts
function foldsToHfsAlias(buf, start, end, alias): boolean {
  const name = buf.subarray(start, end);
  let at = skipHfsIgnorables(name, 0);
  for (let i = 0; i <= alias.length; i++) {
    const want = i === 0 ? ASCII_DOT : alias.charCodeAt(i - 1);
    if (foldAsciiCodePoint(name[at] ?? END_OF_NAME) !== want) return false;
    at = skipHfsIgnorables(name, at + 1);
  }
  return endsHfsName(name, at);
}
```

- **`END_OF_NAME = 0`** is git's `next_hfs_char` result at the NUL. Reading past the view yields `undefined`, which is mapped to it instead of being guarded by a separate length check. Such a check would be an equivalent mutant: `foldAsciiCodePoint(undefined)` already fails the comparison.
- **Needle comparison on the raw byte.** Every needle character is ASCII. An ASCII byte is a one-byte character the picker accepts, so comparing the byte equals git's `tolower(c) == needle`. A byte ≥ 0x80 is either a multi-byte character (git: `c > 127 → 0`) or a rejected lead (git: `c = 0`). Both fail in git, and `foldAsciiCodePoint` leaves the byte ≥ 0x80, so it fails here too. No decode is needed in the needle loop.
- **`skipHfsIgnorables(name, at): number`** advances over consecutive sequences that git's picker accepts as **three bytes** (`gitPickerSequenceLength(name, at) === 3`, see D2) and whose code point is in `HFS_IGNORABLE_CODE_POINTS`. Every one of the 16 ignorables is a three-byte sequence (U+200C–U+206F, U+FEFF). The code point is computed with git's arithmetic, `((b0 & 0x0f) << 12) | ((b1 & 0x3f) << 6) | (b2 & 0x3f)`, in a private `threeByteCodePoint(name, at)`. The acceptance check is load-bearing: in row F1, `E2 C0 8C` computes to U+200C but is rejected. A rejected sequence is not skipped. It stops the skip, and the caller's next byte comparison or `endsHfsName` handles it.
- **`endsHfsName(name, at): boolean`** is git's `!c || is_dir_sep(c)` after the last `next_hfs_char`: `name[at] === ASCII_SLASH || gitPickerSequenceLength(name, at) === 0`. The picker already returns 0 at `at === name.length` (the lead reads `undefined`), so end-of-name needs no separate clause, which would be an equivalent mutant. `is_dir_sep` is `/` only on the POSIX git that CI and the oracle run (see Out of scope).
- `HFS_DECODER`, its comment, and the `Stryker disable` equivalence note on `matched >= wantLength` (it no longer exists) are removed. The JSDoc on `foldsToHfsAlias` and on `matchesDotgitAlias` is rewritten to state the rejection-ends-the-name and `/` rules instead of "Malformed UTF-8 … fails".
- `matchesDotgitAlias`, `namesGitmodules`, every caller in `validate-tree.ts` and `special-blobs.ts`, and the NTFS functions are unchanged. The fix reaches all three caller rows of the Context table through the one predicate.

All new helpers stay well under 20 lines and nest at most one level. Magic bytes become named constants (`ASCII_SLASH` already exists at L108, and the three-byte masks get names). No boolean parameters.

**Cost.** The current arm runs one `TextDecoder.decode` (string allocation) per call. `matchesDotgitAlias` is called up to five times per entry in `validate-tree.ts` and twice more per entry in `special-blobs.ts`. The new arm allocates one subarray view. It exits after the first sequence unless that sequence is `.` or an ignorable, which covers almost every real name. This is a structural statement, not a measurement. If the repo's fsck bench covers large trees, implementation runs it A/B.

### D2 — one git picker, in `encoding.ts` (see DC-2)

Move from `src/domain/path/verify-path.ts` to `src/domain/objects/encoding.ts`, next to `wellFormedSequenceLength`. This is behaviour-preserving.

- `THREE_BYTE_LEAD_NON_CHARACTER`, `NON_CHARACTER_SECOND`, `NON_CHARACTER_THIRD_MIN`, `isNonCharacterTail`: private there.
- `acceptedSequenceLength`: exported as **`gitPickerSequenceLength(bytes: Uint8Array, at: number): number`**, git's `pick_one_utf8_char` accept length, 0 on rejection.
- `gitPickerValidPrefix(bytes: Uint8Array): number`: exported, same body. Its existing inline equivalence note moves with it verbatim; it is not a new directive.

`verify-path.ts` then imports `gitPickerValidPrefix` from `../objects/encoding.js`, which it already imports from. `BMP_LAST_MINUS_ONE`, `BMP_LAST` and `firstNonCharacter` stay in `verify-path.ts`, because they serve the string-only branch of `hfsCandidate`. `tree-entry-bytes.ts` gains its first import, `gitPickerSequenceLength` from `./encoding.js`. That adds no cycle, since `encoding.ts` imports nothing.

None of these symbols is public: `public-types.ts` re-exports domain barrels with `export type *`, which drops values, so `reports/api.json` does not change. Implementation confirms this with `npm run docs:json` producing no diff.

### D3 — the `/` tail is folded, not filed

The M3 rows fail inside the function this change rewrites and follow from the same line of git (`if (c && !is_dir_sep(c))`). The interop rows this change adds would expose them. Under "fold, don't file" they are part of R1. Every M3 row is a tree that already carries `fullPathname`. git still evaluates the alias checks on it, so tsgit must too, and it does: the checks are independent pushes in `checkEntryFaults`.

### Parts

Each part is one atomic commit, RED → GREEN per function, gate green before commit.

**Part 1 — `refactor(encoding)`: one git picker (D2, DC-2).**

- Files:
  - `src/domain/objects/encoding.ts`: add `gitPickerSequenceLength` and `gitPickerValidPrefix` plus the private non-character helpers.
  - `src/domain/path/verify-path.ts`: delete the moved code and import from encoding.
- Tests:
  - The `gitPickerValidPrefix` table moves from `test/unit/domain/path/verify-path.test.ts` L1109-1150 to `test/unit/domain/objects/encoding.test.ts`, unchanged.
  - Add a `gitPickerSequenceLength` table: one row per rejection rule in M1's "Rule" column, plus the M4 boundary rows, asserting the length (2/3/4) or 0.
  - `test/unit/domain/path/verify-path.properties.test.ts` L27: change the import path only.
  - Every verify-path example test stays green untouched. That proves the move preserves behaviour.
- No interop (no behaviour change).

**Part 2 — `fix(fsck)`: the HFS arm reads raw bytes (D1, D3).**

- Files: `src/domain/objects/tree-entry-bytes.ts`: `foldsToHfsAlias` body, new private `skipHfsIgnorables`, `threeByteCodePoint` and `endsHfsName`; delete `HFS_DECODER`. Doc comments are updated in `special-blobs.ts` `specialBlobNames` only if a comment there describes the old rule (today it says "matched on raw bytes", which stays true).
- Unit (`test/unit/domain/objects/tree-entry-bytes.test.ts`, `describe('matchesDotgitAlias')`):
  - Re-pin L444-459: `Given a name holding a byte git's UTF-8 reader rejects immediately after ".git"` › `Then it matches, as git reads the rejected byte as the end of the name`. Expected `true`. Keep the second half of the old assertion: it does not throw.
  - Add `it.each` tables, each row isolating one guard:
    - (a) one row per rejection rule after `.git` (M1 "Rule" column);
    - (b) M4 valid-sequence controls, expected `false`;
    - (c) M3 `/` rows per alias, expected `true`, plus `.gitx/y` and `.git` C3 A9 `/` (a valid non-ignorable character before `/`), expected `false`;
    - (d) F1 (`E2 C0 8C` is not ignorable) and F (rejection inside the needle), both `false`. Add `.g` F2 80 8C 80 `it`, `false`: it is a valid four-byte character whose low bits equal U+200C under the three-byte arithmetic, and it is the only row that kills a `=== 3` → `>= 3` mutant on the skip's length check. It is the same class as pinned V3 (valid four-byte, `c > 127`);
    - (e) the span-bound row: `.git` E2 inside `[start, end)` followed by `98 83` *outside* `end` must match. A look-ahead that crossed `end` would read a valid U+2603, a non-ignorable character, and fail.
- Property sibling, new `test/unit/domain/objects/tree-entry-bytes.properties.test.ts` (see Test strategy).
- Domain fsck: add rows to the `validateTree` suite in `test/unit/domain/fsck/validate-object.test.ts`, one per caller:
  - `hasDotgit` on `.git` FF;
  - `gitmodulesSymlink` on `.gitmodules` FF link and on `.gitmodules/x` link;
  - `gitattributesSymlink`, `gitignoreSymlink` and `mailmapSymlink` on `<alias>` FF links.
- Special blobs: `test/unit/application/commands/internal/fsck/special-blobs.test.ts`, queueing for `.gitmodules` FF, `.gitmodules/x` and `.gitattributes` FF.
- Interop: Case 13 in `test/integration/tree-entry-bytes-interop.test.ts` (see Test strategy), committed red against main's behaviour in this same part and then made green.

## Decision candidates

| # | Choice | Alternatives (≤3) | Recommendation | Why |
|---|---|---|---|---|
| DC-1 | Shape of the byte-faithful HFS predicate | (a) byte-level port of `next_hfs_char`/`is_hfs_dot_generic` on git's picker, no decoder (D1); (b) truncate the span at `gitPickerValidPrefix`, keep the `TextDecoder` fold over the prefix, add the `/` tail rule; (c) keep the decoder and treat U+FFFD as end-of-name | (a) | (c) is refuted by pinned rows. A literal EF BF BD (V1) would match although git says no. U+FFFE/U+FFFF (I, I2) decode to real characters, so they would still not match, though git says yes. (b) is correct but scans the name twice and allocates a string per call, at up to seven calls per entry. (a) mirrors git line for line, allocates no decoded string, exits after the first sequence for nearly every name, and removes the module's last decoder (ADR-751's direction). |
| DC-2 | Where git's picker lives | (a) move `isNonCharacterTail`/`acceptedSequenceLength`/`gitPickerValidPrefix` into `encoding.ts`; verify-path imports them (behaviour-preserving move, tests move with them); (b) add a second copy in `encoding.ts` (or `tree-entry-bytes.ts`) and leave verify-path untouched; (c) export the picker from `tree-entry-bytes.ts`, which verify-path already imports (no cycle) | (a) | git has one `pick_one_utf8_char`, and the two tsgit sides must not drift: §D17's U+FFFE gap was exactly such a drift. `encoding.ts` already hosts `wellFormedSequenceLength`, the picker's base. (c) puts a UTF-8 primitive in a tree-entry module. (b) is DRY-negative, for no gain beyond a smaller diff. |
| DC-3 | git aggregates each `has_*` flag once per tree and reports it after the entry loop. tsgit pushes one finding per entry, in entry order. Proof: a tree with `.GIT` and `.git` blobs gives git `hasDotgit` ×1 and tsgit ×2 (`<scratchpad>/probe3`). Rows S7/N5 show the order differs (git: `fullPathname`, then `hasDotgit`; tsgit: `hasDotgit`, then `fullPathname`). S1 shows git reporting the in-loop `gitmodulesSymlink` before the aggregated `fullPathname`, while tsgit's `checkEntryFaults` pushes name faults before special-file faults | (a) out of this perimeter: report as IMPACT and ask before filing; (b) fold here | (a) | The behaviour spans every aggregated flag (`nullSha1`, `fullPathname`, `emptyName`, `hasDot`, `hasDotdot`, `hasDotgit`, `zeroPaddedFilemode`, `badFilemode`, `duplicateEntries`, `treeNotSorted`, `largePathname`) and the finding order of the whole `validateTree`. It is not the alias fold. The new interop rows use one aliased entry per tree, so they do not depend on it. |

## Test strategy

**RED first.** Part 2's unit re-pin, unit rows and interop Case 13 are seen red against main (`a091b533`) before GREEN. The gate is never committed red.

**Unit tables (Parts 1, 2).** As listed in Parts. Mutation gates the PR, so each picker rejection rule and each boundary has a row that only that rule decides (M1 "Rule" column, M4 boundary rows). Errors are not involved: the predicate is total and never throws.

**Property sibling: `tree-entry-bytes.properties.test.ts` (lens 2: matcher invariants; lens 3: total over bytes).** Generators go in the existing `test/unit/domain/objects/arbitraries.ts`. `numRuns` 100 per ADR-135. Same GWT/AAA/`sut` conventions. The oracle is `gitPickerSequenceLength`/`gitPickerValidPrefix`, independently example-tested in `encoding.test.ts` (Part 1). That is the delegation that property-testing.md allows; the property does not copy the production loop.

1. *Given an arbitrary alias, an arbitrary ASCII case variant of `.<alias>` with HFS-ignorable sequences interleaved at arbitrary positions, and a tail of 1–4 arbitrary bytes excluding `.`, space, `:`, `\` and `/` (the NTFS-arm terminators).* The verdict is `true` iff the tail's picker-valid prefix consists only of ignorable sequences. NUL is excluded too, because a tree name cannot hold it. This mirrors `verify-path.properties.test.ts` L185-205.
2. *Given the same needle variant, ignorable-only padding, then `/`, then arbitrary bytes.* The verdict is always `true` for each alias.
3. *Given P, a concatenation of whole picker-accepted sequences (ASCII, ignorables, arbitrary encoded code points); R, a picker-rejected sequence whose rejection does not depend on the bytes after it (every M1 rule except truncation: a truncated `E2 80` followed by `8C` would become a valid sequence); and two arbitrary suffixes X and Y.* `matchesDotgitAlias(P+R+X) === matchesDotgitAlias(P+R+Y)` for each alias: neither arm reads past a rejection. A counterexample here is a defect to pin against git, not a property to weaken.
4. *Given arbitrary bytes.* `matchesDotgitAlias` returns a boolean and never throws for every alias.

**Interop: Case 13 in `test/integration/tree-entry-bytes-interop.test.ts` (ADR-756: the one suite).**

- **Setup.** One `mkdtemp` repo. Trees are dangling single-entry literal trees. git still queues and checks a dangling tree's special blobs: pinned twice in `<scratchpad>/probe6` (`gitmodulesParse` and `gitattributesLineLength` reported on unreferenced trees). Trees are built with the suite's existing `buildLiteralTreeIn` + `rawEntryBytes`, as in Case 12 (L1047-1140). Single-entry trees keep `treeNotSorted` artefacts and DC-3's aggregation out of every row. Blobs come from `hash-object -w`. Each blob-routed row (`gmblob`, `galong`) gets its **own** blob: `[` + LF + `# <row-id>` + LF for `gmblob` (git refuses it at line 1, pinned with `git config --file`), and `<row-id>` + 3000 × `a` + LF for `galong`. Plain rows share `hello\n`. git reports a blob finding once per blob id, so a blob shared between rows could not tell them apart.
- **Run.** One `git fsck` and one tsgit `fsck(createNodeContext(...), { strict })` per mode, looped `it.each` over `{ strict: false }` and `{ strict: true }` (the Case 12 pattern).
- **Per tree, assert:**
  - the tsgit finding (`msgId`, `severity`, object id and type) against the row's expectation;
  - git's stderr contains `reconstructTreeLine(severity, id, msgId, text)` (blob rows use the blob id and git's blob line);
  - no-finding controls appear in neither tool.
- **Rows:** every M1 rejection-rule row, all of M2, all of M3, and the M4 controls F, F1, Z, U, F5, V1, I-boundary V9, M and the N1–N6 NTFS controls.
- **Severity.** Each finding's expected severity comes per `msgId` from M5, including `fullPathname` (WARN, so `error` under `--strict`) on the M3 rows.
- **Exit code.** Asserted repo-wide, per mode (git fsck walks every loose object regardless): 1 in both modes, driven by P2l/S1/S8/S9/G1. Because that hides the strict upgrade, the `--strict` mode also asserts each `hasDotgit` finding's severity is `error`, and T3's `gitattributesSymlink` stays `info`/`warning`. To pin the M5 exit-code rows independently, one second small repo holds only the T1 tree and asserts `exitCode` 0 without `--strict` and 1 with it, on both tools.
- **Lifecycle.** The suite uses loose objects and `createNodeContext` only, so no new lifecycle tracker is needed (no packed repos).

**Gates.** `npm run validate` (100% coverage), `npm run check:types`, and the scoped Stryker run on `tree-entry-bytes.ts` and `encoding.ts`, narrowed to their eponymous suites per `.claude/workflow/mutation.md`. Survivors are hand-verified against the full covering set, including `validate-object.test.ts` and `special-blobs.test.ts`.

## Out of scope

- **Windows `is_dir_sep('\\')` in the HFS final check.** It applies only to a git built for Windows, and the oracle and CI run POSIX git, where `\` is not a separator after the needle. tsgit's fsck verdict is platform-independent today, and adding a platform switch is a separate decision.
- **`core.protectHFS` gating.** `fsck_tree` calls `is_hfs_*` unconditionally. Only `verify_path` is gated, and that is ADR-978's index side, unchanged here.
- **verify-path behaviour.** Part 1 only moves code, and its HFS branch already truncates at the picker (ADR-978). Index components never contain `/`, so D3 does not apply there.
- **Per-tree aggregation and order of `has_*` findings.** See DC-3: out of the alias-fold perimeter, reported with proof.
- **`checkSpecialFileName`'s `mode !== '120000'` string test vs `special-blobs.ts` `isSymlinkMode` bit test.** Not exercised by any pinned row. A hunch only; to prove it, pin a `0120000`/`120755` `.gitmodules` entry on both tools.
