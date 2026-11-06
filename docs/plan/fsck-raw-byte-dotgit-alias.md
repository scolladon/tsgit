# Plan — fsck's dotgit alias fold reads raw bytes the way git's HFS reader does

> Source: design doc `docs/design/fsck-raw-byte-dotgit-alias.md` · ADRs 1148, 1149 (constraining: 226, 249, 751, 756, 763, 978, 134–136)
> The plan is the implementation script AND the knowledge handoff. Part agents start
> with zero context: whatever a part block omits is paid later as agent rediscovery.
> `plan-lint.sh` enforces the schema below — the plan phase cannot close without it.

## Sizing rules

- Every part costs a full agent lifecycle (spin-up, zero-context rebuild, gate) — it
  must earn it. No standalone test-only parts for FEATURE code: coverage/interop/property
  tests fold into the implementation part whose code they exercise. EXCEPTION:
  test-infra-only and docs-only parts (tooling config, test helpers, fixtures,
  harness/ADV/property suites, docs/prose) with no `src/` delta ARE standalone — they
  have no implementation part to fold into.
- A part that would be a pure test pass over already-landed code merges into its
  neighbour.
- A part should land in ~100 tool calls. More than ~5 RED→GREEN cycles, or more than 6
  files in its `### Context` block, is two parts. What counts is a back-ticked path:
  backtick the files the part CREATES or EDITS, and write read-only reference paths in
  plain text.

## Overview of parts

| Part | Commit | Scope | src delta |
|---|---|---|---|
| 1 | `refactor(encoding): …` | move git's UTF-8 picker into encoding.ts (ADR-1149), behaviour-preserving | encoding.ts, verify-path.ts |
| 2 | `fix(fsck): …` | HFS arm walks raw bytes; a rejected sequence after the needle ends the name (ADR-1148, design D1) | tree-entry-bytes.ts |
| 3 | `fix(fsck): …` | a `/` after the needle ends the name (design D3) | tree-entry-bytes.ts (one clause) |
| 4 | `test(fsck): …` | property sibling for the alias fold (lenses 2 + 3), no src delta | none |

Why D1 splits into Parts 2 and 3: one part holding the fold rewrite, the `/` rule, four
unit/caller suites, the interop case, the property file and its generators is 7 files
and ~7 RED→GREEN cycles. The two rules are independent lines of git
(`next_hfs_char` returning 0 vs `is_dir_sep(c)`), each with its own matrix rows (M1/M2
vs M3), so each ships with its own RED rows in the part that turns them GREEN. Parts 2
and 3 edit the same five files (plan-lint's overlap warning is expected and advisory).

**Execution environment for every part.** Worktree root = the working directory; run
every command from it. `package.json` / `package-lock.json` carry the session's pending
dependency bump: never stage them; stage only the files the part names (`git add <paths>`,
never `git add -A`/`-u`). Oracle: git 2.56.0 on PATH (`<git-bin>`, the session oracle); the
interop helpers already scrub `GIT_*` (`SAFE_ENV` in test/integration/interop-helpers.ts).
Implementers have no MCP tools: use `Read`/`Grep`/`Edit`. wireit caches `check:types`
and `check:spelling`; when a result looks stale, bypass with
`npx tsc --noEmit -p tsconfig.typecheck.json` and `npx cspell --no-progress <files>`.
No test spies anywhere in this change, so no `afterEach(vi.restoreAllMocks)` is needed;
if you add a spy, add it (lesson 027). Test titles: `describe('Given …')` >
`describe('When …')` > `it('Then …')`, AAA comments, `sut` = the function under test
(the `sutBindsResult`, `gwtTitle`, `aaaBody`, `sutNaming` pyramid heuristics gate
`validate`). No design-matrix row ids, ADR, backlog or phase numbers in test titles,
comments or fixture contents — label rows by what they are ("lead byte at or above F8").

**Public-surface decision (all parts): every new export is INTERNAL.**
`gitPickerSequenceLength` and `gitPickerValidPrefix` (encoding.ts) are consumed only by
verify-path.ts, tree-entry-bytes.ts and tests. Proof they never reach the package
surface: src/domain/objects/index.ts L19 re-exports only `bytesToHex`, `compareBytes`,
`hexToBytes` from encoding.js; src/public-types.ts re-exports domain barrels with
`export type *`, which drops values; src/domain/path has no barrel; and
`grep -c gitPicker reports/api.json` is `0` today. So no barrel, facade, doc-coverage,
browser-surface or api.json gate applies. Do NOT run `npm run docs:json` to confirm it:
it rewrites the tracked reports/api.json, and the pending dependency bump can shift
typedoc output unrelated to this change. The static proof above is the confirmation.
knip (`check:dead-code`) runs with `ignoreExportsUsedInFile: true` and vitest-entry
tests, so an export used in-file or by a test is not dead.

## Decision candidates

Choices the design and ADRs leave open. Each carries a recommendation; the plan is
written to the recommendation, and the user/session can flip any before Part 2 starts.

| # | Choice | Alternatives (≤3) | Recommendation | Why |
|---|---|---|---|---|
| PDC-1 | Part split of D1/D3 | (a) Part 2 = rejection rule, Part 3 = `/` rule (this plan); (b) one `fix(fsck)` part with production + unit + callers + interop, property in a separate test part | (a) | (b) is 5 files but ~7 RED→GREEN cycles plus a ~50-row interop table, past the ~100-call budget; (a) keeps each rule's RED rows in the part that turns them GREEN. |
| PDC-2 | How `skipIgnorableSequences` advances past an accepted ignorable | (a) by the named constant `THREE_BYTE_SEQUENCE_LENGTH` (the guard already requires the picker length `=== 3`); (b) by the picker's returned length | (a) | Under (b) the `=== 3 → true` mutant advances by 0 on a rejected ignorable-arithmetic sequence and loops forever (a slow timeout kill, and a watchdog hazard in triage). Under (a) every guard mutant is a fast, row-decided kill. Both kill rows below are required either way. |
| PDC-3 | Raw-byte names in the special-blobs unit suite | (a) widen its local `RawEntry` name to `string \| Uint8Array` inside `treeBody`; (b) add a second `treeBodyBytes` helper | (a) | One helper, no duplicated body-assembly loop; existing call sites keep passing strings. |
| PDC-4 | Where the property suite's ignorable-sequence generator comes from | (a) map `arbIgnorableCodepoint` (test/unit/domain/path/arbitraries.ts) through `encode(String.fromCodePoint(cp))` inside objects/arbitraries.ts; (b) a literal 16-entry byte list in objects/arbitraries.ts | (a) | The closed code-point set lives once in the test tree already; (b) duplicates it a third time (production + verify-path property + here). |
| PDC-5 | The moved `gitPickerValidPrefix` table's `sut` binding | (a) rows unchanged, body rebinds `const sut = gitPickerValidPrefix` and the input as `bytes` (the repo's sut-is-the-SUT rule); (b) move it byte-for-byte (today `sut` holds the input) | (a) | The table is touched by the move; the convention binds touched code. Rows (the behaviour proof) stay identical. |

## Part 1 — refactor(encoding): git's UTF-8 picker lives once in encoding

### Context

Behaviour-preserving move (ADR-1149, design D2). No interop: no behaviour changes.

**Files this part edits**

- `src/domain/objects/encoding.ts` — 294 lines, no imports. `wellFormedSequenceLength(bytes: Uint8Array, at: number): number` is L147-159 (comment L147, Unicode Table 3-7); `decodeEscapingInvalid` follows at L161. Constants block L104-127 (`CONTINUATION_MAX = 0xbf` L109, `THREE_BYTE_LEAD_MAX = 0xef` L113, `THREE = 3` L125). Insert the picker directly after `wellFormedSequenceLength` (after L159).
- `src/domain/path/verify-path.ts` — L2 imports `{ decodePreservingBom, encode, wellFormedSequenceLength }` from `'../objects/encoding.js'`; L4 imports `matchesNtfsDotgitAlias` from tree-entry-bytes (this is why the picker cannot live here for tree-entry-bytes' use: cycle). Code to MOVE: L57-59 consts `THREE_BYTE_LEAD_NON_CHARACTER = 0xef`, `NON_CHARACTER_SECOND = 0xbf`, `NON_CHARACTER_THIRD_MIN = 0xbe`; L63-66 `isNonCharacterTail(bytes, at): boolean`; L68-73 `acceptedSequenceLength(bytes, at): number` (JSDoc L68, inline comment L71); L75-85 `export const gitPickerValidPrefix = (bytes: Uint8Array): number`, with the inline note at L78 `// Stryker disable next-line EqualityOperator: equivalent — at bytes.length the lead reads undefined, acceptedSequenceLength is 0 and the loop returns at, which is bytes.length.` Code that STAYS: L60-61 `BMP_LAST_MINUS_ONE`, `BMP_LAST`, L87-94 `firstNonCharacter`, L98-101 `hfsCandidate` (its only picker call is L101 `gitPickerValidPrefix(partBytes)`).
- `test/unit/domain/objects/encoding.test.ts` — 753 lines; one outer `describe('encoding')` (L24) holding per-function describes; last is `describe('wellFormed')` at L729; file ends L753. Import list L4-22 (alphabetical). Append the two new describes inside `describe('encoding')`, after `wellFormed`.
- `test/unit/domain/path/verify-path.test.ts` — L3-9 imports `gitPickerValidPrefix` (L4) from verify-path.js; `describe('gitPickerValidPrefix')` table L1109-1150 (top-level, 28 rows, `const sut = Uint8Array.from(bytes)` then `gitPickerValidPrefix(sut)`). Delete that describe and the L4 specifier.
- `test/unit/domain/path/verify-path.properties.test.ts` — L25-31 import block from verify-path.js includes `gitPickerValidPrefix` (L27); its only use is L185 `decodesToIgnorableOnly`. Move the specifier to a new `import { gitPickerValidPrefix } from '../../../../src/domain/objects/encoding.js';` (biome's organizeImports decides order — run `biome check --write` on the file).

**Target shape in encoding.ts** (renames per ADR-1149; bodies unchanged):

```ts
const THREE_BYTE_LEAD_NON_CHARACTER = 0xef;
const NON_CHARACTER_SECOND = 0xbf;
const NON_CHARACTER_THIRD_MIN = 0xbe;

const isNonCharacterTail = (bytes: Uint8Array, at: number): boolean => /* L63-66 body */;

/** Length of the sequence git's `pick_one_utf8_char` accepts at `at`, or 0 when it rejects
 *  (also 0 at `at === bytes.length`). */
export function gitPickerSequenceLength(bytes: Uint8Array, at: number): number { /* L70-72 body */ }

/** Offset of the first sequence git's `pick_one_utf8_char` rejects, else `bytes.length`. */
export function gitPickerValidPrefix(bytes: Uint8Array): number { /* L77-84 body, calling gitPickerSequenceLength */ }
```

The L78 equivalence note moves with the loop; only the identifier inside it changes
(`acceptedSequenceLength` → `gitPickerSequenceLength`). It keeps its `equivalent`
rationale, so .claude/hooks/check-forbidden-patterns.sh (which blocks only a
`Stryker disable` without `equivalent`) lets it through. It is the same directive
relocated, not a new one. Keep the L71 "non-character tail … only ever meets a
three-byte length or 0" comment. Keep the three non-character constants under their
own names: do not alias them to `THREE_BYTE_LEAD_MAX`/`CONTINUATION_MAX` (a
behaviour-preserving move, minimal diff).

**Read-only references:** docs/design/fsck-raw-byte-dotgit-alias.md §D2 and M1/M4 tables; git utf8.c `pick_one_utf8_char` rules (design §"Source"); other verify-path consumers whose suites must stay green: test/unit/application/primitives/build-index-from-tree.test.ts (L907 `.git\xff/x` HFS refusal), test/unit/domain/git-index/.

**Property sibling:** none added to test/unit/domain/objects/encoding.properties.test.ts.
The move adds no grammar. The picker's grammar-level use is already the oracle of
verify-path.properties.test.ts L175-205 and becomes the oracle of Part 4's properties.
A property restating "picker = Table 3-7 minus EF BF BE/BF" would copy the production
body (property-testing.md: tautology).

### TDD steps

1. **RED** — in encoding.test.ts add `describe('gitPickerSequenceLength')` > `describe("Given byte sequences git's UTF-8 picker accepts or rejects")` > `describe('When the accepted length at an offset is measured')` > `it.each(rows)('Then $label yields $expected', …)`; body: `const sut = gitPickerSequenceLength; const bytes = Uint8Array.from(row.bytes);` Act `sut(bytes, row.at)`; Assert `toBe(expected)`. Import `gitPickerSequenceLength` from encoding.js. Fails: encoding.ts exports no `gitPickerSequenceLength` (tsc: "has no exported member"; vitest: `sut is not a function`). Rows (`at: 0` unless stated), one per picker rule so each guard has an isolated kill row:
   - accept: `[0x61]`→1 · `[0xc2,0x80]`→2 (lowest 2-byte) · `[0xc3,0xa9]`→2 · `[0xe0,0xa0,0x80]`→3 (E0 overlong boundary) · `[0xe2,0x80,0x8c]`→3 (U+200C) · `[0xe2,0x98,0x83]`→3 · `[0xed,0x9f,0xbf]`→3 (surrogate boundary) · `[0xef,0xbe,0xbf]`→3 (non-character boundary, second byte) · `[0xef,0xbf,0xbd]`→3 (literal U+FFFD) · `[0xf0,0x90,0x80,0x80]`→4 (F0 overlong boundary) · `[0xf0,0x9f,0x98,0x80]`→4 · `[0xf2,0x80,0x8c,0x80]`→4 (four-byte whose first three bytes compute to U+200C) · `[0xf4,0x8f,0xbf,0xbf]`→4 (U+10FFFF).
   - reject (→0): `[0xff]` lead ≥ F8 · `[0xfe]` · `[0xf8,0x80,0x80,0x80,0x80]` lowest ≥ F8 lead · `[0x80]` stray continuation · `[0xc0,0x80]` C0 lead · `[0xc1,0xbf]` C1 lead · `[0xc2]` 2-byte truncated · `[0xe2,0x80]` 3-byte truncated · `[0xe2,0x80,0x41]` bad third byte · `[0xe2,0xc0,0x8c]` bad second byte · `[0xe2,0x78]` ASCII second byte · `[0xe0,0x80,0xaf]` E0 overlong · `[0xe0,0x80]` E0 truncated · `[0xed,0xa0,0x80]` surrogate · `[0xef,0xbf,0xbe]` U+FFFE · `[0xef,0xbf,0xbf]` U+FFFF · `[0xf0,0x9f,0x98,0x41]` bad fourth byte · `[0xf0,0x80,0x80,0x80]` F0 overlong · `[0xf4,0x90,0x80,0x80]` above U+10FFFF · `[0xf5,0x80,0x80,0x80]` lead above F4.
   - offset rows (kill `at`-arithmetic mutants in `isNonCharacterTail` and the length read): `[0x61,0xe2,0x80,0x8c]` at 1 → 3 · `[0x61,0xef,0xbf,0xbe]` at 1 → 0 · `[0x61,0xef,0xbf,0xbd]` at 1 → 3 · `[0x61]` at 1 → 0 (end of bytes reads `undefined` → 0; Parts 2–3 rely on this).
2. **RED** — move the `describe('gitPickerValidPrefix')` table from verify-path.test.ts L1109-1150 into encoding.test.ts (inside `describe('encoding')`), rows byte-identical; per PDC-5 the body becomes `const sut = gitPickerValidPrefix; const bytes = Uint8Array.from(row.bytes);` → `sut(bytes)`. Import `gitPickerValidPrefix` from encoding.js. Fails: not exported from encoding.ts. Delete the old describe and the L4 import specifier from verify-path.test.ts in the same step.
3. **GREEN** — move the code per the target shape; delete L57-59, L63-85 from verify-path.ts; change verify-path.ts L2 to `import { decodePreservingBom, encode, gitPickerValidPrefix } from '../objects/encoding.js';` (`wellFormedSequenceLength` is no longer used there — tsc/biome flag an unused import otherwise). Update the verify-path.properties.test.ts import (L27). Both new tables pass.
4. **GUARD** — `npx vitest run test/unit/domain/path test/unit/application/primitives/build-index-from-tree.test.ts test/unit/domain/git-index test/unit/domain/objects/encoding.properties.test.ts` passes untouched: the same picker body is now reached through an import, which proves the move preserves behaviour (R3).
5. **REFACTOR** — none expected. Check that `grep -n "acceptedSequenceLength\|isNonCharacterTail\|NON_CHARACTER" src/domain/path/verify-path.ts` is empty and that `grep -rn "gitPickerValidPrefix\|gitPickerSequenceLength" src` shows only encoding.ts (definitions) and verify-path.ts (one import + L101 use).

Mutation note (validation phase): Stryker scopes encoding.ts to its eponymous suite (encoding.test.ts). That is why both tables must live there and why each rule has its own row. The moved `while (at < bytes.length)` note remains the only equivalent mutant.

### Gate

```bash
npx vitest run test/unit/domain/objects/encoding.test.ts test/unit/domain/path/verify-path.test.ts test/unit/domain/path/verify-path.properties.test.ts && npm run check:types && ./node_modules/.bin/biome check src/domain/objects/encoding.ts src/domain/path/verify-path.ts test/unit/domain/objects/encoding.test.ts test/unit/domain/path/verify-path.test.ts test/unit/domain/path/verify-path.properties.test.ts && npm run check:spelling
```

### Commit

`refactor(encoding): move git's UTF-8 picker next to the Unicode validator`

## Part 2 — fix(fsck): a sequence git's UTF-8 reader rejects ends a dotgit alias name

### Context

ADR-1148 / design D1, without the `/` clause (Part 3 adds it). After this part the HFS
arm walks `buf[start, end)` as git's `is_hfs_dot_generic`/`next_hfs_char` do, and a
rejected sequence (or end of span) after the needle and trailing ignorable sequences matches.

**Files this part edits**

- `src/domain/objects/tree-entry-bytes.ts` (currently NO imports; this part adds the first: `import { gitPickerSequenceLength } from './encoding.js';`. No cycle: encoding.ts imports nothing). Current layout:
  - L46 `export type DotgitAliasName = 'git' | 'gitmodules' | 'gitattributes' | 'gitignore' | 'mailmap';`
  - L48-53 `HFS_IGNORABLE_CODE_POINTS: ReadonlySet<number>` (16 code points: U+200C–200F, 202A–202E, 206A–206F, U+FEFF). Every one is a three-byte sequence. Keep it.
  - L55-63 `ASCII_DOT = 0x2e`, `ASCII_SPACE`, `ASCII_TILDE`, `ASCII_UPPER_A`, `ASCII_UPPER_Z`, `ASCII_CASE_BIT`, NTFS consts.
  - L65-70 comment + `const HFS_DECODER = new TextDecoder('utf-8', { ignoreBOM: true });`. DELETE both (the module's last decoder, ADR-751).
  - L72-77 `function foldAsciiCodePoint(codePoint: number): number`, with an existing approved `Stryker disable … equivalent` note at L73 about the `Z` boundary. Keep both unchanged; the note stays true.
  - L79-85 JSDoc of `foldsToHfsAlias`. Rewrite it: the name is read through git's UTF-8 picker; ignorable sequences are skipped only when the picker accepts them; each needle character is compared on its raw byte, ASCII-folded; after the needle the name matches at the end of the span or at a sequence the picker rejects.
  - L86-105 `function foldsToHfsAlias(buf: Uint8Array, start: number, end: number, alias: DotgitAliasName): boolean`. The signature stays the same and the body is replaced. The `Stryker disable` note at L98 on `matched >= wantLength` disappears with that code.
  - L107-112 `ASCII_COLON`, `ASCII_SLASH = 0x2f` (L108), `ASCII_BACKSLASH`, digits (leave in place; Part 3 uses `ASCII_SLASH`).
  - L230-237 JSDoc + L238-245 `export function matchesDotgitAlias(buf, start, end, alias): boolean` = `foldsToHfsAlias(...) || matchesNtfsDotgitAlias(...)`. The body is unchanged. Rewrite the JSDoc phrase "HFS-ignorable code points dropped at any position" so it states the picker-reading rule (rejection ends the name).
  - L262-269 `namesGitmodules`, NTFS functions (`isNtfsTail` ~L119, `foldsToNtfsShortName`, `matchesNtfsDotgitAlias`): unchanged.
- `test/unit/domain/objects/tree-entry-bytes.test.ts` (600 lines). Imports L1-10: `encode` from encoding.js, and `backslashSegmentStarts, entryNameKey, hasNonOctalByte, matchesDotgitAlias, matchesNtfsDotgitAlias`. Local variadic `concatBytes(...parts)` L12-21. Byte constants L23-28 `BOM`, `U200C`, `U200D`, `U200E`, `U202A`, `U206A`. `describe('matchesDotgitAlias')` L204-494, with the hasDotgit matrix it.each at L205 and the family it.each at L259. **Re-pin target L444-460**: `describe('Given a name containing an invalid UTF-8 byte immediately after ".git"')` > `When matching against "git"` > `it('Then it does not match and does not throw')`, expecting `false`. Add new tables inside `describe('matchesDotgitAlias')`, before its closing L494.
- `test/unit/domain/fsck/validate-object.test.ts` (4473 lines). Helpers: `BLOB_SHA` L22, `EMPTY_TREE_SHA` L24, `buildTreeEntryBytes(mode: string, nameBytes: Uint8Array, rawSha: Uint8Array)` L33-45, `buildTree(...entries)` L47-56, `concatBytes`/`encode` imported from encoding.js L6 (array form: `concatBytes([a, b])`). Pattern to copy: the backslash-segment `describe.each` L4380-4405 (`validateObject({ kind: 'tree', rawBody, strict: false, hashConfig: SHA1_CONFIG })`, `expect(result).toEqual([{ msgId, severity }])`). Append the new `describe.each` at end of file.
- `test/unit/application/commands/internal/fsck/special-blobs.test.ts` (261 lines). `const sut = createSpecialBlobLedger` L7; `BLOB` L9; `type RawEntry = readonly [mode: string, name: string, id: ObjectId]` L11; `treeBody(...entries)` L14-27 encodes `name` with `TextEncoder` (which turns a lone FF into C3 BF, so it cannot carry raw bytes). Per PDC-3, widen `name` to `string | Uint8Array` and encode only strings. Pattern to copy: L30-46 (`ledger.noteTree(treeBody([...]))`, `ledger.pendingUnder('.gitattributes')`).
- `test/integration/tree-entry-bytes-interop.test.ts` (1207 lines). It is the ONE tree byte-parity suite (ADR-756). Helpers: local variadic `concatBytes` L64-73; `rawEntry(mode, name, oidHex)` L75-77; `rawEntryBytes(mode, nameBytes, oidHex)` L81-83; `buildLiteralTreeIn(repoDir, body): string` L85-89 (`hash-object -t tree -w --stdin --literally`); `buildTreeIn` L94-98; `reconstructTreeLine(severity, id, msgId, text)` L176-177 → `` `${severity} in tree ${id}: ${msgId}: ${text}` ``; `isBadObjectFor(finding, id)` L179-183; imports include `encode, hexToBytes` (L40), `FILE_MODE` (L43), `fsck`, `FsckFinding`, `createNodeContext`, `runGit`, `tryRunGitWithExit` (returns `{ stdout, stderr, exitCode }`), `mkdtemp`/`rm`/`os`/`path`, `afterAll`/`beforeAll`. `describe('fsck-only faults')` opens L720 and closes L1144. Case 12, the template to copy, is L1033-1143: its own `mkdtemp` repo in `beforeAll`, `strictRows` `it.each` over `{ strict: false }`/`{ strict: true }`, one `git fsck` + one `fsck(ctx, { strict })` per mode. **Insert Case 13 between L1143 and L1144**, inside `fsck-only faults`. Only loose objects are used, so no packed-repo lifecycle tracking is needed (lesson 030 does not apply).

**New private helpers in tree-entry-bytes.ts** (each < 20 lines, nesting ≤ 1, no boolean params, named constants):

```ts
const END_OF_NAME = 0;                       // git's next_hfs_char at the terminating NUL
const THREE_BYTE_SEQUENCE_LENGTH = 3;
const THREE_BYTE_LEAD_PAYLOAD_MASK = 0x0f;
const CONTINUATION_PAYLOAD_MASK = 0x3f;
const THREE_BYTE_LEAD_SHIFT = 12;
const CONTINUATION_SHIFT = 6;

// git's arithmetic over a sequence the picker accepted as three bytes
function threeByteCodePoint(name: Uint8Array, at: number): number
//   ((name[at] & 0x0f) << 12) | ((name[at+1] & 0x3f) << 6) | (name[at+2] & 0x3f)   (use `as number`, encoding.ts style)

function skipIgnorableSequences(name: Uint8Array, at: number): number
//   while gitPickerSequenceLength(name, at) === THREE_BYTE_SEQUENCE_LENGTH
//         && HFS_IGNORABLE_CODE_POINTS.has(threeByteCodePoint(name, at)):  at += THREE_BYTE_SEQUENCE_LENGTH   (PDC-2)
//   return at

function endsHfsName(name: Uint8Array, at: number): boolean
//   Part 2: gitPickerSequenceLength(name, at) === 0      (end of view reads undefined → 0: no separate length clause)

function foldsToHfsAlias(buf, start, end, alias): boolean {
  const name = buf.subarray(start, end);     // a view, never a copy; bounds every look-ahead at `end` (R4)
  let at = skipIgnorableSequences(name, 0);
  for (let i = 0; i <= alias.length; i++) {
    const want = i === 0 ? ASCII_DOT : alias.charCodeAt(i - 1);
    if (foldAsciiCodePoint(name[at] ?? END_OF_NAME) !== want) return false;
    at = skipIgnorableSequences(name, at + 1);
  }
  return endsHfsName(name, at);
}
```

Naming: the design spells the skip helper `skipHfs` + the plural of "ignorable"; cspell
(part of the gate) rejects that plural inside a camelCase identifier, so it is
`skipIgnorableSequences` here. Same body, same contract.

Why the needle compares the raw byte: every needle character is ASCII. A byte ≥ 0x80 is
either a multi-byte lead (git: `c > 127 → 0`) or a rejected lead (git: `c = 0`), and
`foldAsciiCodePoint` leaves it ≥ 0x80, so it fails as git does. Do not add a
`name.length` guard before the compare: `name[at] ?? END_OF_NAME` already fails it, and
a guard would be an equivalent mutant. The counted `let` loop and the `let at` cursor
are local, never shared, as in the existing `isNtfsTail`.

**Expected findings (pinned on git 2.56.0, design M1/M2/M4/M5).** Severities from
src/domain/fsck/severity.ts (read-only): `hasDotgit` WARN and `fullPathname` WARN →
`error` under `--strict`; `gitmodulesSymlink`, `gitattributesLineLength` ERROR in both
modes; `gitattributesSymlink`, `gitignoreSymlink`, `mailmapSymlink`, `gitmodulesParse`
INFO (tsgit `severity: 'info'`, git prints the word `warning`), never upgraded. git's
message texts (from the probe logs):

| msgId | object | git text |
|---|---|---|
| hasDotgit | tree | `contains '.git'` |
| fullPathname | tree | `contains full pathnames` |
| gitmodulesSymlink | tree | `.gitmodules is a symbolic link` |
| gitattributesSymlink | tree | `.gitattributes is a symlink` |
| gitignoreSymlink | tree | `.gitignore is a symlink` |
| mailmapSymlink | tree | `.mailmap is a symlink` |
| gitmodulesParse | blob | `could not parse gitmodules blob` |
| gitattributesLineLength | blob | `.gitattributes has too long lines to parse` |

**Read-only references:** design §M1–M5 tables and §Test strategy; src/domain/fsck/validate-tree.ts (callers: `namesDotgit` L166-172, `symlinkOnlyFindings` L190-209, `checkSpecialFileName` L217-238 with `mode !== '120000'`, `checkNameFaults` L131-163 pushes `hasDotgit` before `fullPathname`, `checkEntryFaults` L242-298 pushes name faults before special-file faults); src/application/commands/internal/fsck/special-blobs.ts `specialBlobNames` L37-44 (its comment "matched on raw bytes" stays true: no edit); src/application/commands/internal/fsck/content-validation.ts L447 (`noteTree` runs for every tree object, dangling ones included, so a dangling single-entry tree queues its blob, as git does per the design's probe6).

### TDD steps

1. **RED — unit re-pin (R5).** Rewrite L444-460 in place: `describe('Given a name holding a byte git\'s UTF-8 reader rejects immediately after ".git"')` > `When matching against "git"` > `it('Then it matches without throwing, as git reads the rejected byte as the end of the name')`. Arrange comment cites git 2.56.0 `fsck` reporting `hasDotgit` for `.git` + FF. Act `const result = sut(buf, 0, buf.length, 'git')`, Assert `expect(result).toBe(true)` (the Act completing is the no-throw half). Fails: `foldsToHfsAlias` decodes FF to U+FFFD, one character past the needle, so the length match fails (`false`), and the NTFS arm also fails at FF.
2. **RED — unit tables, inside `describe('matchesDotgitAlias')`** (each `it.each` row isolates one guard; `nameBytes` built with the file's `concatBytes`/`encode`):
   - (a) `describe("Given '.git' followed by a sequence git's UTF-8 picker rejects")` > `When matched against "git"` > `Then $label matches`, expected `true`. One row per rule: `FF` · `FE` · `F8 80 80 80 80` · `80` · `C0 80` · `C1 BF` · `C2` (truncated at span end) · `E2 80` · `E2 80 41` · `E2 C0 8C` · `E2 78` · `E0 80 AF` · `E0 80` · `ED A0 80` · `EF BF BE` · `EF BF BF` · `F0 9F 98 41` · `F0 80 80 80` · `F4 90 80 80` · `F5 80 80 80`. Plus composed rows: `.GIT` FF (case fold) · `.git FF FF` (first rejection ends the read) · `.git E2 80 8C FF` (ignorable, then reject) · `.git FF E2 80 8C` (rest unread) · `.gi E2 80 8C t FF` (ignorable mid-needle) · `. E2 80 8C GIT FF` · `E2 80 8C .git FF` (leading ignorable) · `.g E2 80 8C it 80`. Fails today: the decoder adds U+FFFD (or a real U+FFFE/U+FFFF character) after the needle → `false`.
   - (a2) same shape for the other four aliases, expected `true`: `.gitmodules FF`, `.gitattributes FF`, `.gitignore FF`, `.mailmap FF`, each against its own alias. Fails for the same reason.
   - (b) `describe("Given '.git' followed by a sequence git's picker accepts")`, expected `false`. Rows `C3 A9` · `C2 80` · `E0 A0 80` · `E2 98 83` · `ED 9F BF` · `EF BE BF` · `EF BF BD` (a literal U+FFFD is a character) · `F0 90 80 80` · `F0 9F 98 80` · `F4 8F BF BF` · `F2 80 8C 80` (the tail-form `>= 3` killer, see mutation notes) · ASCII `x` (`.gitx` FF: the byte after the needle is `x`). **GUARD**: these pass before GREEN (the decoder yields a non-ignorable character), and they pin that the new picker read does not over-match.
   - (d) `describe('Given a rejection or a non-ignorable sequence inside the needle')`, expected `false`. Rows: `.g FF it` (rejection inside the needle) · `.g E2 C0 8C it` (a rejected sequence whose arithmetic equals U+200C is not ignorable) · `.g F2 80 8C 80 it` (a valid four-byte character whose first three bytes compute to U+200C) · `. FF git` (rejection right after the dot) · `FF .git` (rejection before the dot). **GUARD**: they all pass before GREEN. They are the kill rows for the skip's acceptance check.
   - (e) `describe('Given a span ending inside a three-byte sequence whose rest lies past the end')` > `When only [start, end) is matched against "git"` > `Then it matches, as git reads the truncated sequence as the end of the name`: `buf = concatBytes(encode('.git'), Uint8Array.of(0xe2, 0x98, 0x83))`, `sut(buf, 0, 5, 'git')` → `true`. Fails today (the decoder sees a lone E2 → U+FFFD → `false`). It also pins R4: a look-ahead past `end` would read a valid U+2603 → `false`.
3. **RED — domain callers** (validate-object.test.ts, appended): `describe.each([...] as const)('Given a tree entry $label', …)` > `When validateObject runs` > `Then emits $msgId` with `expect(result).toEqual([{ msgId, severity }])`, strict false, names built with `buildTreeEntryBytes(mode, nameBytes, BLOB_SHA)`. Rows: `40000` `.git FF` → `hasDotgit` `warning` · `120000` `.gitmodules FF` → `gitmodulesSymlink` `error` · `120000` `.gitattributes FF` → `gitattributesSymlink` `info` · `120000` `.gitignore FF` → `gitignoreSymlink` `info` · `120000` `.mailmap FF` → `mailmapSymlink` `info`. Plus one strict row: `40000` `.git FF`, strict true → `[{ hasDotgit, error }]`. Fails today: `[]` for each.
4. **RED — special blobs** (special-blobs.test.ts): widen `RawEntry`/`treeBody` (PDC-3), then `describe.each` over `{ nameBytes: .gitmodules FF, queuedUnder: '.gitmodules' }`, `{ nameBytes: .gitattributes FF, queuedUnder: '.gitattributes' }`. `Given a regular entry named $label` > `When the tree is noted` > `Then its blob is pending under $queuedUnder` asserts `ledger.pendingUnder(queuedUnder)` `toEqual([BLOB])` and the other name `toEqual([])`. Fails today: `[]`, because the name is not folded.
5. **RED — interop Case 13** (tree-entry-bytes-interop.test.ts, between L1143 and L1144). Header comment: git's HFS reader reads a sequence its UTF-8 picker rejects as the end of the name, for all five names.
   - Local helpers. `reconstructBlobLine(severity, id, msgId, text)` → `` `${severity} in blob ${id}: ${msgId}: ${text}` ``. `GIT_TEXT: Readonly<Record<AliasMsgId, string>>` from the table above. `BASE_SEVERITY: Readonly<Record<AliasMsgId, 'error' | 'warning' | 'info'>>`. `expectedSeverity(msgId, strict)` → `strict && base === 'warning' ? 'error' : base`. `gitWord(severity)` → `severity === 'info' ? 'warning' : severity`.
   - Row type: `{ label: string; nameBytes: Uint8Array; kind: 'dir' | 'blob' | 'link' | 'badGitmodules' | 'longAttributes'; tree: ReadonlyArray<AliasMsgId>; blob: ReadonlyArray<AliasMsgId> }` (`tree`/`blob` = expected msgIds on the tree and on the routed blob; both empty for a control).
   - Setup in `beforeAll`: one repo `mkdtemp(path.join(os.tmpdir(), 'tsgit-tree-bytes-fsck-hfs-'))`, `git init -q -b main`. Shared `hello\n` blob. A subtree for `dir` rows = `buildTreeIn(dir, rawEntry('100644', 'x', hello))`. Per row, one single-entry dangling tree: `buildLiteralTreeIn(dir, rawEntryBytes(modeOf(kind), row.nameBytes, oidOf(row)))`, with mode `40000` for dir, `120000` for link, `100644` otherwise. Each `badGitmodules` row writes its own blob `[` LF `# <slug>` LF, and each `longAttributes` row writes `<slug>` + 3000 × `a` + LF, where `<slug>` is a short descriptive kebab label unique per row (git reports a blob finding once per blob id). Keep a `Map<label, { treeId, blobId }>`.
   - Assertions, `it.each(strictRows)`, per mode: one `tryRunGitWithExit(['-C', dir, 'fsck', ...flags])` and one `fsck(createNodeContext({ workDir: dir }), { strict })`. Then for each row: tsgit `result.findings.filter(f => isBadObjectFor(f, treeId)).map(({msgId, severity}) => ({msgId, severity}))`, sorted by msgId, `toEqual` the expected list, sorted. Sort because the order differs between the tools (DC-3, out of scope). For each expected msgId, git stderr `toContain(reconstructTreeLine(gitWord(sev), treeId, msgId, GIT_TEXT[msgId]))`. Do the same on `blobId` with `reconstructBlobLine` for `blob` msgIds. For a row with no expectation on an object, assert `gitResult.stderr` `not.toContain(\`in tree ${treeId}:\`)` (and the same for its blob) and that tsgit has no bad-object finding for it.
   - Exit code: `expect(gitResult.exitCode).toBe(1)` and `expect(result.exitCode).toBe(1)` in BOTH modes, driven by the `.gitmodules FF` link (gitmodulesSymlink) and `.gitattributes FF` longAttributes (gitattributesLineLength) rows.
   - Second repo `describe` for M5 (its own `mkdtemp`, `tsgit-tree-bytes-fsck-hfs-exit-`): only the `.git FF` dir tree (plus its subtree and blob). `it.each(strictRows)`: both tools exit `strict ? 1 : 0`, and the tree's finding is `hasDotgit` at `strict ? 'error' : 'warning'` on both sides.
   - Rows for this part (labels descriptive; bytes after the name prefix):
     - **`.git` + rejection, dir → tree [hasDotgit]:** every rule in step 2(a) (FF, FE, F8 80 80 80 80, 80, C0 80, C1 BF, C2, E2 80, E2 80 41, E2 C0 8C, E2 78, E0 80 AF, E0 80, ED A0 80, EF BF BE, EF BF BF, F0 9F 98 41, F0 80 80 80, F4 90 80 80, F5 80 80 80), plus `.GIT FF`, `.git FF FF`, `.git E2 80 8C FF`, `.git FF E2 80 8C`, `.gi E2 80 8C t FF`, `. E2 80 8C GIT FF`, `E2 80 8C .git FF`, `.g E2 80 8C it 80`. Also `.git FF` as `blob` kind → tree [hasDotgit].
     - **Other aliases:** `.gitmodules FF` badGitmodules → blob [gitmodulesParse] · `.gitmodules FF` blob (hello) → none · `.gitmodules FF` link → tree [gitmodulesSymlink] · `.gitattributes FF` longAttributes → blob [gitattributesLineLength] · `.gitattributes` (plain) longAttributes → blob [gitattributesLineLength] (control, already green) · `.gitattributes FF` link → tree [gitattributesSymlink] · `.gitignore FF` link → tree [gitignoreSymlink] · `.mailmap FF` link → tree [mailmapSymlink] · `.gitignore FF` blob → none · `.mailmap FF` blob → none.
     - **Rejection then `/` (turned green by this part's rule):** `.gitmodules FF /x` link → tree [gitmodulesSymlink, fullPathname] · `.gitmodules FF /x` badGitmodules → tree [fullPathname], blob [gitmodulesParse].
     - **Controls → none:** `.g FF it`, `.g E2 C0 8C it`, `. FF git`, `FF .git`, `.gitx FF`, `.git C3 A9`, `.git EF BF BD`, `.git EF BE BF` (all dir); `git~1 FF` dir; `x\.git FF` blob. Controls `.git EF BB BF` dir → tree [hasDotgit] and `.gitmodules EF BB BF` badGitmodules → blob [gitmodulesParse] are already green and guard the ignorable tail.
   - Fails today: tsgit reports nothing for the rejection rows. The P2l/G1-shaped rows leave tsgit at exit 0, not 1, so the exit-code assertion fails too.
6. **GREEN** — implement the helpers and the `foldsToHfsAlias` body, delete `HFS_DECODER`, rewrite the two JSDocs, and add the encoding.js import. Steps 1–5 pass, along with every existing row in tree-entry-bytes.test.ts (the hasDotgit matrix L205, the family matrix L259, the NTFS rows L496-528, span-bound rows) and in validate-object.test.ts.
7. **REFACTOR** — check that no helper exceeds 20 lines and that tree-entry-bytes.ts has no `TextDecoder` (`grep -n TextDecoder src/domain/objects/tree-entry-bytes.ts` is empty). Run `npx vitest run test/unit/domain/fsck test/unit/application/commands/internal/fsck test/integration/fsck-interop.test.ts` as a wider guard. Optional cost measure on a quiet machine, after the commit: `npm run bench:ab -- HEAD~1 HEAD 3 test/bench/fsck-artefacts.bench.ts` (structural claim only in the design; report the numbers, never gate on them).

**Blocker triggers (escalate `{ unit, reason, ≤3 options }`, never weaken a row):** git's stderr for a row differs from the expectation above (re-probe per .claude/workflow/probes.md in a `mktemp -d`); tsgit's own gitmodules parser accepts the `[` LF `# …` blob, or rejects `hello\n`, where git does the opposite (a parser parity gap outside this perimeter); a dangling tree's blob is not checked by tsgit.

**Mutation-kill map (validation scopes tree-entry-bytes.ts to tree-entry-bytes.test.ts, then hand-verifies survivors against validate-object.test.ts and special-blobs.test.ts):**
- `=== THREE_BYTE_SEQUENCE_LENGTH` → `>= 3`: killed by `.git F2 80 8C 80` (step 2(b), tail form; the mutant skips three bytes, lands on continuation 80, the picker rejects it and the name wrongly matches). With PDC-2's constant advance, the needle-form row `.g F2 80 8C 80 it` stays `false` under this mutant. It is still required, because under the alternative advance-by-length it is the killer.
- `=== 3` → `true`: killed by `.g E2 C0 8C it` (step 2(d)): the mutant skips the rejected sequence because its arithmetic equals U+200C, then matches. `.git E2 C0 8C` does NOT kill it (both verdicts are `true`).
- `=== 3` → `!== 3` / `false`: killed by `.g E2 80 8C it` (existing matrix): the original skips the accepted ignorable; the mutant compares E2 with `i`.
- `HFS_IGNORABLE_CODE_POINTS.has(...)` → `true`: killed by `.git E2 98 83` (valid, non-ignorable).
- `endsHfsName` `=== 0` → `true`: killed by every (b) row. → `false`: killed by every (a) row.
- `i <= alias.length` → `<`: killed by HFS-only matches such as `.g E2 80 8C it` (existing matrix) and `.git FF` (step 2(a)). The mutant stops before `t`, the picker accepts `t`, so `endsHfsName` is false and the NTFS arm cannot rescue them. Plain `.git` does NOT kill it: the NTFS arm matches `.git` on its own.
- `name[at] ?? END_OF_NAME` (LogicalOperator): killed by any matching row.
- the subarray bound: killed by step 2(e) and the existing "embedded in a larger buffer" rows (L462-493).
- Expected equivalents: none new. The only notes left in the HFS arm are the existing `foldAsciiCodePoint` `Z` note. Write an inline `Stryker disable next-line … equivalent — <proof>` only with a written proof, and only after hand-verification. Otherwise remove the redundant guard.

### Gate

```bash
npx vitest run test/unit/domain/objects/tree-entry-bytes.test.ts test/unit/domain/fsck/validate-object.test.ts test/unit/application/commands/internal/fsck/special-blobs.test.ts test/integration/tree-entry-bytes-interop.test.ts && npm run check:types && ./node_modules/.bin/biome check src/domain/objects/tree-entry-bytes.ts test/unit/domain/objects/tree-entry-bytes.test.ts test/unit/domain/fsck/validate-object.test.ts test/unit/application/commands/internal/fsck/special-blobs.test.ts test/integration/tree-entry-bytes-interop.test.ts && npm run check:spelling
```

### Commit

`fix(fsck): read a dotgit alias name through git's UTF-8 picker so a rejected byte ends it`

## Part 3 — fix(fsck): a slash after the needle ends a dotgit alias name

### Context

Design D3 / R1 third bullet: git's final check `if (c && !is_dir_sep(c)) return 0`. With
Part 2 landed, `endsHfsName` is `gitPickerSequenceLength(name, at) === 0`. This part
makes it `name[at] === ASCII_SLASH || gitPickerSequenceLength(name, at) === 0`
(`ASCII_SLASH = 0x2f` already at tree-entry-bytes.ts ~L108, below the HFS block, which
is fine because it is read at call time). `is_dir_sep` is the slash only on the POSIX git
that CI and the oracle run, so a backslash after the needle stays a non-match. Existing guard
row: `.gitmodules\\b` → `false` in the NTFS `describe.each` (tree-entry-bytes.test.ts
~L504). The Windows backslash separator is out of scope (design §Out of scope).

**Files this part edits** (same five as Part 2; the line numbers below are from before
Part 2 and shift after it: locate by symbol/describe title):

- `src/domain/objects/tree-entry-bytes.ts` — `endsHfsName` (Part 2's helper): add the slash clause. Extend the `foldsToHfsAlias` and `matchesDotgitAlias` JSDocs with "or at a slash".
- `test/unit/domain/objects/tree-entry-bytes.test.ts` — inside `describe('matchesDotgitAlias')`, the new table (c).
- `test/unit/domain/fsck/validate-object.test.ts` — extend Part 2's appended `describe.each` (or add a sibling one: rows here expect two findings).
- `test/unit/application/commands/internal/fsck/special-blobs.test.ts` — extend Part 2's `describe.each` with `.gitmodules/x`.
- `test/integration/tree-entry-bytes-interop.test.ts` — extend Case 13's row table (big repo) only.

Ordering facts the assertions must respect. For a single-entry tree, tsgit's
`checkNameFaults` pushes `hasDotgit` before `fullPathname`, and `checkEntryFaults` pushes
name faults before special-file faults. So validateObject returns
`[{ fullPathname, warning }, { gitmodulesSymlink, error }]` for a `.gitmodules/x` link and
`[{ hasDotgit, warning }, { fullPathname, warning }]` for a `.g<ZWNJ>it/x` dir. git's
order differs (DC-3, out of scope), so the interop rows compare sorted lists.

**Read-only references:** design §M3 and §M4 (N1–N6, F5); src/domain/fsck/validate-tree.ts (as in Part 2).

### TDD steps

1. **RED — unit table (c)** `describe("Given a dotgit alias name followed by '/'")` > `When matched against its alias` > `Then $label resolves to $expected`. Rows → `true`: `.gitmodules/x` (gitmodules) · `.GITMODULES/x` · `.gitattributes/x` · `.gitignore/x` · `.mailmap/x` · `.gitmodules E2 80 8C /x` (ignorable, then `/`) · `.g E2 80 8C it/x` (git) · `EF BB BF .git/x` (git, BOM-led, HFS-only). These fail on Part 2's code, because the picker accepts `/`, so `endsHfsName` is `false` and the NTFS arm stops at `/` only for `git`. Rows → `false`, **GUARD** (pass already): `.gitx/y` (git) · `.git C3 A9 /` (git: a valid non-ignorable character before `/`) · `.gitmodules /x` (space before `/`) · `\x\.gitmodules/y` · `x\.gitmodules/y` · `gitmod~1/x` (gitmodules: the NTFS arm does not stop at `/` for non-`git` aliases). **GUARD** `true`: `.gitmodules FF /x` (Part 2's rule already matches it).
2. **RED — domain callers** (validate-object.test.ts): `120000` `.gitmodules/x` → `toEqual([{ msgId: 'fullPathname', severity: 'warning' }, { msgId: 'gitmodulesSymlink', severity: 'error' }])` · `120000` `.gitignore/x` → `[fullPathname warning, gitignoreSymlink info]` · `40000` `.g E2 80 8C it/x` → `[hasDotgit warning, fullPathname warning]`. Today each returns `[fullPathname warning]` only.
3. **RED — special blobs**: `100644` `.gitmodules/x` → `pendingUnder('.gitmodules')` `toEqual([BLOB])`. Fails: `[]`.
4. **RED — interop Case 13 rows** (append to the big-repo table):
   - `.gitmodules/x` link → tree [gitmodulesSymlink, fullPathname] (RED)
   - `.gitmodules E2 80 8C /x` link → tree [gitmodulesSymlink, fullPathname] (RED)
   - `.gitmodules/x` badGitmodules → tree [fullPathname], blob [gitmodulesParse] (RED)
   - `.gitignore/x` link → tree [gitignoreSymlink, fullPathname] (RED)
   - `.mailmap/x` link → tree [mailmapSymlink, fullPathname] (RED)
   - `.gitattributes/x` link → tree [gitattributesSymlink, fullPathname] (RED)
   - `.g E2 80 8C it/x` dir → tree [hasDotgit, fullPathname] (RED)
   - `EF BB BF .git/x` dir → tree [hasDotgit, fullPathname] (RED; single-entry, so no treeNotSorted)
   - GUARD controls: `.git/x` dir → [hasDotgit, fullPathname] · `.git /x` dir → [hasDotgit, fullPathname] (NTFS arm) · `.gitx/y` dir → [fullPathname] · links `\x\.gitmodules/y`, `x\.gitmodules/y`, `.gitmodules /x`, `.gitignore /x`, `gitmod~1/x` → [fullPathname] each.
   - Under `--strict` every `fullPathname` and `hasDotgit` expectation is `error` (the `expectedSeverity` helper from Part 2 already does this). The exit code stays 1 in both modes.
5. **GREEN** — add the `name[at] === ASCII_SLASH ||` clause and the JSDoc words.
6. **REFACTOR** — none expected.

Mutation-kill map: the clause → `false`: killed by every step-1 `true` row. `||` → `&&`:
killed by Part 2's (a) rows (the picker rejects, the byte is not `/`). `=== ASCII_SLASH`
→ `!==`: killed by the (b) rows.

### Gate

```bash
npx vitest run test/unit/domain/objects/tree-entry-bytes.test.ts test/unit/domain/fsck/validate-object.test.ts test/unit/application/commands/internal/fsck/special-blobs.test.ts test/integration/tree-entry-bytes-interop.test.ts && npm run check:types && ./node_modules/.bin/biome check src/domain/objects/tree-entry-bytes.ts test/unit/domain/objects/tree-entry-bytes.test.ts test/unit/domain/fsck/validate-object.test.ts test/unit/application/commands/internal/fsck/special-blobs.test.ts test/integration/tree-entry-bytes-interop.test.ts && npm run check:spelling
```

### Commit

`fix(fsck): end a dotgit alias name at a slash after the needle as git does`

## Part 4 — test(fsck): property sibling for the dotgit alias fold

### Context

Test-only property suite (standalone per the sizing exception: no `src/` delta).
property-testing.md lens 2 (matcher invariants) and lens 3 (total over bytes). Oracle =
`gitPickerValidPrefix` / `gitPickerSequenceLength` (encoding.ts, example-tested in
encoding.test.ts since Part 1), never a copy of the fold loop. `numRuns: 100` per
property (ADR-135 composition tier). Same GWT/AAA/`sut` conventions as the examples;
`Given` reads "Given an arbitrary …"; the body uses `// Arrange + Act + Assert`, as
test/unit/domain/path/verify-path.properties.test.ts does. Never commit a seed.

**Files this part creates/edits**

- `test/unit/domain/objects/arbitraries.ts` (412 lines; `fc` imported L1; existing generators include `arbRawBytes(maxLength = 40)` L79 = `fc.uint8Array({ maxLength })`). Add, exported:
  - `arbDotgitAliasName(): fc.Arbitrary<DotgitAliasName>` — `fc.constantFrom('git', 'gitmodules', 'gitattributes', 'gitignore', 'mailmap')` (type from src/domain/objects/tree-entry-bytes.js).
  - `arbHfsIgnorableBytes(): fc.Arbitrary<Uint8Array>` — per PDC-4: `arbIgnorableCodepoint()` imported from `../path/arbitraries.js` (L32-39 there), mapped with `encode(String.fromCodePoint(cp))`.
  - `arbHfsNeedleVariant(alias: DotgitAliasName): fc.Arbitrary<Uint8Array>` — `.<alias>` with each character's ASCII case chosen arbitrarily and 0–2 ignorable sequences inserted at arbitrary positions (before the dot included).
  - `arbPickerRejectedSequence(): fc.Arbitrary<Uint8Array>` — a sequence whose rejection does not depend on the bytes after it: one of `F8–FF` lead · `80–BF` lead · `C0`/`C1` + continuation · `E0` + `80–9F` + continuation · `ED` + `A0–BF` + continuation · `EF BF BE`/`EF BF BF` · `F0` + `80–8F` + 2 continuations · `F4` + `90–BF` + 2 continuations · `F5–F7` + 3 continuations · a 2–4-byte lead followed by an ASCII byte other than NUL. Truncation is excluded (`E2 80` then `8C` would complete a valid sequence).
  - `arbPickerAcceptedSequences(): fc.Arbitrary<Uint8Array>` — a concatenation of 0–4 whole accepted sequences: non-NUL ASCII, ignorable sequences, or `encode(String.fromCodePoint(cp))` for an arbitrary non-surrogate code point other than U+FFFE/U+FFFF.
- `test/unit/domain/objects/tree-entry-bytes.properties.test.ts` (NEW). Header JSDoc names the lenses that fit (2, 3) and why 1 and 4 do not: no serialise/parse pair, no re-parse step. Copy the wording style from verify-path.properties.test.ts L1-22. Imports: `fc`, `describe`/`it`, `matchesDotgitAlias` from tree-entry-bytes.js, `gitPickerSequenceLength` and `gitPickerValidPrefix` from encoding.js, the generators above. A local oracle `isIgnorableOnly(bytes)` walks `bytes` with `gitPickerSequenceLength` and requires every sequence to be an ignorable three-byte one. Write it independently of production (compare against the 16 encoded byte triples built from `arbIgnorableCodepoint`'s ranges, or reuse verify-path.properties' approach at L157-178).

**Properties** (each one `describe('Given an arbitrary …')` > `describe('When …')` > `it('Then …')`):

1. Needle variant + tail of 1–4 arbitrary bytes, excluding `.`, space, `:`, `\`, `/` and NUL (the NTFS-arm terminators, plus NUL, which a tree name cannot hold): `matchesDotgitAlias(name, 0, name.length, alias) === isIgnorableOnly(tail.subarray(0, gitPickerValidPrefix(tail)))`, for every alias. Mirrors verify-path.properties.test.ts L188-205.
2. Needle variant + 0–2 ignorable sequences + `/` + `arbRawBytes(8)`: always `true` for each alias.
3. `P = oneof(arbHfsNeedleVariant(alias), arbPickerAcceptedSequences())`, then `R = arbPickerRejectedSequence()`, then two independent suffixes `X`, `Y` = `arbRawBytes(8)`: `matchesDotgitAlias(P+R+X) === matchesDotgitAlias(P+R+Y)` (neither arm reads past a rejection). A counterexample is a defect to pin against git. Escalate it with the shrunk bytes; never weaken the property.
4. `arbRawBytes(40)` × `arbDotgitAliasName()`: `typeof matchesDotgitAlias(...) === 'boolean'`, and it never throws.

**Read-only references:** .claude/workflow/property-testing.md; test/unit/domain/path/arbitraries.ts (`arbIgnorableCodepoint` L32-39); test/unit/domain/path/verify-path.properties.test.ts (L111-205: tail-exclusion constants, ignorable byte list and oracle shape).

### TDD steps

1. **GUARD** — properties 1–4 are written against code that Parts 2–3 already landed, so each is expected to pass at once (lens-2/3 invariants of shipped behaviour, not new behaviour). If one fails, do not edit production in this part. Shrink the counterexample and check it against git 2.56.0 in a `mktemp -d` throwaway (.claude/workflow/probes.md). Then escalate `{ unit: Part 4, reason: <bytes + both verdicts>, options }`: a real defect folds back into tree-entry-bytes.ts with its own RED example row (a production fix this part does not own).
2. **GUARD** — sanity check that the generators produce what they claim. Temporarily run property 1 with `fc.statistics` or a `numRuns: 1000` local run to see both `true` and `false` verdicts occur, then remove the temporary code before commit (no dead code, no committed seed).
3. **REFACTOR** — keep each generator < 20 lines and use named constants for byte bounds (`CONTINUATION_MIN = 0x80`, …) as arbitraries.ts already does for its ranges.

### Gate

```bash
npx vitest run test/unit/domain/objects/tree-entry-bytes.properties.test.ts test/unit/domain/objects/tree-entry-bytes.test.ts && npm run check:types && ./node_modules/.bin/biome check test/unit/domain/objects/arbitraries.ts test/unit/domain/objects/tree-entry-bytes.properties.test.ts && npm run check:spelling
```

### Commit

`test(fsck): pin the dotgit alias fold's grammar with properties`

## Phase gate (after Part 4)

`npm run validate` (full: 100% coverage, integration, parity, perf, knip, jscpd,
depcruise, cspell). Then validation runs scoped Stryker on encoding.ts and
tree-entry-bytes.ts line ranges, narrowed to their eponymous suites per
.claude/workflow/mutation.md. Survivors are hand-verified against the full covering set,
including validate-object.test.ts and special-blobs.test.ts.
