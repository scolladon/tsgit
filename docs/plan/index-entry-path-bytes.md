# Plan — byte-exact index entry paths

> Source: design doc `docs/design/index-entry-path-bytes.md` · ADRs 968, 969, 970, 971, 972
> Revision (Parts 16+): design at `212826b0` · ADRs 973-985 (972's key encoding superseded by 981)
> The plan is the implementation script AND the knowledge handoff. Part agents start
> with zero context: whatever a part block omits is paid later as agent rediscovery.
> `plan-lint.sh` enforces the schema below — the plan phase cannot close without it.

<!-- cspell:ignore backticked xbfz efbbbf efbfbd efbbbf612f78 efbbbf7a efbfbd2e747874 ff2e747874 ff2f78 622fc3 622fefbfbd FEFF FFFD bytewise latin1 Latin1 renormalize unstage unstaging unstaged restaged restage lossy -->

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
  files in its `### Context` block, is two parts. What counts is a backticked path:
  backtick the files the part CREATES or EDITS, and write read-only reference paths in
  plain text.

## Shared knowledge (read once, applies to every part)

**The model after this plan.** `IndexEntry.path` is the decoded view
(`decodePreservingBom` of the raw bytes: a leading U+FEFF is kept, an invalid UTF-8 sequence
becomes U+FFFD). `IndexEntry.pathBytes` is present (absent key, never `pathBytes: undefined`)
exactly when `encode(path)` differs from the raw bytes — a "lossy" path. Invariant P: anything
that sets `path` drops or recomputes `pathBytes`. A BOM path is NOT lossy. ASCII bytes (`/`, `.`)
sit at the same positions in both views, so slash counts and `.`/`..`/`.git` checks agree.

**Fact the plan leans on.** A lossy path always contains U+FFFD in its decoded view (the
decoder emits U+FFFD for every invalid sequence). So `pathComparatorFor`'s existing
`SURROGATE_OR_ABOVE` test already picks the slow comparator for every index holding a lossy
entry — no third tier is needed; only `compareEntryPath`'s body changes (Part 4).

**Naming vs the design.** Design §D6's `ChangedPath` is this plan's `IndexPath` (one type for
every path projection; status.ts already exports an unrelated public `ChangedPath`). Design
§D5.3's `withPath(entry, path, pathBytes?)` is `withPath(entry, to: IndexPath)` here (no optional
positional parameter).

**Two key schemes, never mixed.** **[superseded, ADR-981 / ADR-984: from Part 18a a lossy key is
its escaped path and from Part 18b cache-tree component keys are escaped components; see Shared
knowledge — revision]**
- Whole-path keys (`IndexPathKey`, Part 3): a round-tripping path is its own key; a lossy path
  is `'\0' + latin1(pathBytes)` **[superseded, ADR-981: `escapedPathOf(entry)`]**. Injective; free for UTF-8. Every `Map`/`Set` on an
  index-writing route keys entries with `indexPathKey(entry)`; a plain string (pathspec,
  working-tree path) is looked up with `keyOfPath(path)` and therefore never addresses a lossy
  entry — correct, a JS string cannot name non-UTF-8 bytes.
- Cache-tree component keys (`cache-tree.ts`, unchanged scheme): `latin1` of the component's
  bytes (ASCII components are their own key) **[superseded, ADR-984: escaped components, Part 18b]**.

**Sites deliberately left on the string view** (see Decision candidates DC-1) **[superseded in
part by ADR-977 / ADR-980: the merge engine, pathspec matches, `materialize-tree.ts` scope sets and
status / clean-work-tree / find-would-overwrite joins move to escaped keys in Parts 19-32c]**: status
`stage0Map` / `collectStagedKinds`, `clean-work-tree.ts` `stagedDirty`/`unstagedDirty`,
`find-would-overwrite.ts` `stage0ByPath`, `materialize-tree.ts` `filterByPaths` /
`preserveOutOfScope` / `checkoutDirection`, add's `indexRules`, smudge's `IsVerified`, the
merge engine, `stage0Entry`. Each compares index paths against another string-pathed source
(a flattened tree, merge outcomes, user pathspecs, fs paths); converting one side alone would
make a lossy entry miss its own counterpart.

**Public-surface decisions.**
- `IndexEntry.pathBytes` — PUBLIC (type reaches `reports/api.json` through `export type *` of the
  domain git-index barrel in src/public-types.ts). Gate: regenerate `reports/api.json` with
  `npm run docs:json` in Part 2 (prepush `check:doc-typedoc`, not caught by validate).
- `ChangesetEntry.pathBytes` — PUBLIC (`ChangesetEntry` is exported from
  src/application/primitives/index.ts and present in api.json). Gate: `npm run docs:json` in
  Part 15. See DC-2.
- Everything else is INTERNAL: the new module src/domain/git-index/index-path-key.ts (not added
  to any barrel), `decodesLosslessly` (domain objects encoding module, not barreled), `withPath`
  (not added to the git-index barrel), `walkTreeWithLossyBytes` (exported from walk-tree.ts but
  NOT from src/application/primitives/index.ts, so the public `walkTree` / `WalkTreeOptions`
  and the `Repository.primitives.walkTree` binding stay unchanged). `compareEntryPath`,
  `skipWorktreeEntry`, `serializeIndex`, `parseIndex` are barrel VALUES, which
  `export type *` drops: their signature changes are internal. No new error code, no new
  command, no README count change.

**Test conventions (every part).** `describe('Given …')` > `describe('When …')` >
`it('Then …')`; AAA comments (`// Arrange`, `// Act`, `// Assert`); the system under test is
`sut`. Mutation-resistant: assert exact bytes/values, never `toThrow(Class)` alone; isolate
each branch of every `pathBytes === undefined ? … : …` (one test per side). Raw bytes in tests
are literal `Uint8Array.of(0xff, 0x2e, 0x74, 0x78, 0x74)`; the decoded view is
`'\uFFFD.txt'`. No provenance refs (phase/ADR/backlog/part numbers) in src or test text. No
suppression directives. Properties live in `*.properties.test.ts` siblings, `numRuns` 200 for
cheap round-trips, 100 for invariants, 50 for filter-heavy ones; never commit a seed.

**Byte fixtures used across parts** (hex of raw path bytes):
- L = `ff2e747874` (raw `\xff.txt`, view `\uFFFD.txt`, lossy)
- U = `efbfbd2e747874` (literal U+FFFD `.txt`, NOT lossy — its own UTF-8 encoding)
- the collision pair L/U decodes to the same string; so do `\xef\xbb\xbfz` vs `z` before Part 1.
- invalid classes for example sweeps: `ff`, lone `80`, truncated `c3`, overlong `c0 af`,
  surrogate `ed a0 80`, `f5`.

**Interop file.** All cross-tool twin rows live in one new file,
test/integration/index-path-bytes-interop.test.ts (header `@proves surface: index, bucket:
cross-tool-interop, interopSurface: index`, `describe.skipIf(!GIT_AVAILABLE)`). Rows by part:
P1 = A1–A4, D1, D2 · P4 = B1–B3, F1–F2 · P5 = B4 · P10 = C1–C3 · P14 = E1, F3 (F3 is derived
from R8: a changed lossy directory invalidates its cache-tree node through `reset`). The state
is built with real git (`mkdir` + `git add` for BOM names; `update-index -z --index-info` for
non-UTF-8 names, which APFS cannot hold as files), tsgit acts through
`openRepository({ cwd })` (src/index.node.ts), and the assertion compares path bytes as hex
from `git ls-files -s -z` / `git ls-tree -r -z` (via `runGitBytes`) to the pinned hex from the
design matrix §D1. Helpers come from test/integration/interop-helpers.ts (`runGit` accepts a
`Uint8Array` `input`; `runGitBytes`; `runGitEnv`; `makePeerPair`; `GIT_AVAILABLE`). Interop
runs need `PATH=$HOME/.local/git-2.55.0/bin:$PATH` (pinned matrix is git 2.55.0).

**Bench.** R9 (UTF-8 paths cost what they cost today on parse, write and walk) is measured in the
validation phase after Part 15 with `bench:ab` over test/bench status, checkout and commit benches;
expected flat. No part runs benches.

**Gate hygiene.** `rm -rf .wireit` before trusting a cached `check:types` / `check:spelling`
green (or run `npx tsc --noEmit -p tsconfig.json` and `npx cspell --no-progress <files>`).
Interim parts may leave a new export unconsumed until a later part (knip runs at the phase
gate, not the part gate); every export listed here is consumed by Part 15.

## Part 1 — Keep a leading BOM in index entry paths

### Context
- `src/domain/git-index/index-parser.ts` — `parseIndex`, the entry loop: line 117
  `const path = decode(bytes.subarray(offset, pathEnd));` becomes `decodePreservingBom(...)`
  (import it from the objects encoding module next to `decode`, which the cache-tree parse
  keeps using). Line 118 `validateIndexPath(path, entryStart, mode)` stays on the decoded string.
- `test/unit/domain/git-index/index-parser.test.ts` — helper `buildTestIndex(entries, extensions)`
  (line 8) encodes `entry.path` with `TextEncoder`, which already yields `EF BB BF` for
  `'\uFEFF…'`; add a describe "Given an entry whose path bytes start with EF BB BF".
- `test/unit/domain/git-index/path-validator.test.ts` — add the `'\uFEFF.git/x'` guard.
- `test/integration/index-path-bytes-interop.test.ts` — CREATE (see Shared knowledge). Local
  helpers created here and reused by later parts: `hex(bytes)`;
  `lsFilesPathHex(dir): string[]` (split `runGitBytes(['-C', dir, 'ls-files', '-s', '-z'])` on
  0x00, keep the bytes after the first 0x09, hex each); `lsTreePathHex(dir, rev): string[]`
  (same over `ls-tree -r -z <rev>`); an `AUTHOR` `AuthorIdentity` constant and a `COMMIT_ENV`
  (pattern: test/integration/add-add-content-interop.test.ts lines 33-49).
- Reference (read-only): src/domain/objects/encoding.ts (`decodePreservingBom` line 91);
  src/domain/path/verify-path.ts (HFS ignorable code points include 0xfeff, line 32; reason
  `dotgit-hfs-alias`); src/domain/git-index/path-validator.ts (`VERIFY_PATH_REASON` maps
  `dotgit-hfs-alias` to "'.git' HFS+ ignorable-codepoint alias rejected" and `dotgit-alias` to
  "'.git' component rejected"); error data shape `{ code: 'INVALID_INDEX_ENTRY', offset, reason }`
  (src/domain/git-index/error.ts).
- Nothing else changes for BOM: the writer's `encode`, the comparator (U+FEFF ranks above `z`,
  bytes `EF > 7A`), tree-walk names (`decodePreservingBom`) and cache-tree `keyOfComponent`
  are already consistent.

### TDD steps
1. RED `index-parser.test.ts` — Given an entry whose path bytes are `ef bb bf 61 2f 78`, When
   `parseIndex`, Then `entries[0].path` is `'\uFEFFa/x'`. Fails: `decode` strips the BOM, path is
   `'a/x'`.
2. RED `index-parser.test.ts` — Given path bytes `ef bb bf 2e 67 69 74 2f 78`, When `parseIndex`,
   Then it throws with `data.code === 'INVALID_INDEX_ENTRY'` and `data.reason === "'.git' HFS+
   ignorable-codepoint alias rejected"` (try/catch, assert `data`). Fails: the stripped `.git/x`
   is refused with reason "'.git' component rejected".
3. GUARD `index-parser.test.ts` — path `sub/\uFEFFy` decodes with its inner BOM (passes: the
   default decoder only strips a leading BOM). GUARD — the parsed BOM entry has no `pathBytes`
   key (`'pathBytes' in entry` is false; passes: the field does not exist yet, and must stay
   absent for BOM paths after Part 2).
4. GUARD `path-validator.test.ts` — `validateIndexPath('\uFEFF.git/x', 0, '100644')` throws reason
   "'.git' HFS+ ignorable-codepoint alias rejected" (passes: `verifyPath` strips HFS ignorable code points).
5. RED interop (new file) rows, each its own `it`, state built in `pair.peer` (use
   `makePeerPair('index-path-bytes')`, `git init -q -b main`, identity config):
   - A1+A2: git `mkdir $'\uFEFF'a`, file `x`, file `z`, `git add .`, commit; tsgit
     `readIndex` (src/application/primitives/read-index.ts with `createNodeContext`) paths hex are
     `['7a', 'efbbbf612f78']`. Fails today: `['7a', '612f78']`.
   - A3: modify `z`; tsgit `repo.add(['z'])`; `lsFilesPathHex` is `['7a', 'efbbbf612f78']`,
     `git fsck` exits 0, `git status --porcelain -z` is only `M  z`. Fails: entry renamed to `612f78`.
   - A4: then tsgit `repo.commit({ message, author: AUTHOR, committer: AUTHOR })`;
     `lsTreePathHex(dir, 'HEAD')` is `['7a', 'efbbbf612f78']` and
     `git diff-tree -r --name-status HEAD~1 HEAD` is exactly `M\tz`. Fails: tree lists `612f78`.
   - D1: git commits `\uFEFFa/x` and `sub/\uFEFFy`; tsgit `repo.status()` returns `clean: true`.
     Fails: BOM entry reported staged-added/deleted and untracked.
   - D2: tsgit `repo.rm(['\uFEFFa/x'], { cached: true })` resolves with `removed` equal to
     `['\uFEFFa/x']` and `lsFilesPathHex` no longer lists `efbbbf612f78`. Fails:
     `PATHSPEC_NO_MATCH`.
6. GREEN — swap `decode` for `decodePreservingBom` at line 117.
7. REFACTOR — none expected; keep the import list sorted.

### Gate
```sh
rm -rf .wireit
npx vitest run test/unit/domain/git-index/index-parser.test.ts test/unit/domain/git-index/path-validator.test.ts
PATH=$HOME/.local/git-2.55.0/bin:$PATH npx vitest run test/integration/index-path-bytes-interop.test.ts
npm run check:types
./node_modules/.bin/biome check src/domain/git-index/index-parser.ts test/unit/domain/git-index/index-parser.test.ts test/unit/domain/git-index/path-validator.test.ts test/integration/index-path-bytes-interop.test.ts
npm run check:spelling
```

### Commit
`fix(index): keep a leading BOM in index entry paths`

## Part 2 — Raw path bytes on lossy index entries

### Context
- `src/domain/objects/encoding.ts` — ADD next to `decodePreservingBom` (line 91):
  `export function decodesLosslessly(text: string, raw: Uint8Array): boolean` =
  `!text.includes('\uFFFD') || bytesEqual(encode(text), raw)`. Contract: `text` was produced by
  `decodePreservingBom(raw)`. Why it holds: that decoder emits U+FFFD only for an invalid
  sequence or a literal `EF BF BD`, and a valid UTF-8 decode re-encodes to the same bytes, so a
  view without U+FFFD is lossless without encoding (hot path: one scan, no allocation).
- `test/unit/domain/objects/encoding.test.ts` — new describe for `decodesLosslessly`.
- `src/domain/git-index/index-entry.ts` — `IndexEntry` (lines 20-34) gains, after `path`:
  `readonly pathBytes?: Uint8Array;` with a doc comment: raw path bytes, present only when
  `path` does not re-encode to them (a non-UTF-8 name); writers emit them verbatim; a fresh copy,
  never a view on the index buffer; read-only by contract (parsed entries are shared through the
  index cache); anything that changes `path` must drop or recompute it.
- `src/domain/git-index/index-parser.ts` — entry loop (lines 115-139): keep
  `const rawPath = bytes.subarray(offset, pathEnd)`, `const path = decodePreservingBom(rawPath)`,
  `const pathBytes = decodesLosslessly(path, rawPath) ? undefined : rawPath.slice()`;
  `validateIndexPath(path, …)` unchanged; build the entry object as today and push
  `pathBytes === undefined ? entry : { ...entry, pathBytes }` (absent key for UTF-8; the spread
  runs only for the rare lossy entry). Do NOT touch `roundTrips` (cache-tree, lines 308-316).
- `test/unit/domain/git-index/index-parser.test.ts` — widen `buildTestIndex`'s entry `path` to
  `string | Uint8Array` (use the bytes verbatim when given, `TextEncoder` otherwise; name length =
  byte length).
- `reports/api.json` — regenerate with `npm run docs:json` (public type change; prepush gate).
- Reference: design §D2-§D3; the `CacheTreeEntry.nameBytes` doc (same file, lines 52-63) is the
  wording precedent.

### TDD steps
1. RED `encoding.test.ts` — `decodesLosslessly` example table (Given each raw input, When
   `decodesLosslessly(decodePreservingBom(raw), raw)`, Then the expected boolean): `61 2e 74`
   true; `c3 a9` true; `ef bb bf 61` true; `ef bf bd` true (literal U+FFFD round-trips —
   kills a mutant dropping the `bytesEqual` arm); `ff` false; `80` false; `c3` false; `c0 af`
   false; `ed a0 80` false; `f5` false. Fails: `decodesLosslessly` is not exported (TypeError
   "not a function").
2. GREEN — add `decodesLosslessly`.
3. RED `index-parser.test.ts` — Given an entry with raw path L (`ff 2e 74 78 74`), When `parseIndex`,
   Then `path === '\uFFFD.txt'` and `pathBytes` equals `Uint8Array.of(0xff,0x2e,0x74,0x78,0x74)`.
   Fails: no `pathBytes` key (`undefined`).
4. RED `index-parser.test.ts` — one `it` per remaining invalid class (`80`, `c3`, `c0 af`,
   `ed a0 80`, `f5`, each followed by `.txt`), Then `pathBytes` equals the raw bytes. Fails as 3.
5. RED `index-parser.test.ts` — Given the parsed L entry, When the source buffer's path bytes are
   overwritten after parse, Then `pathBytes` is unchanged (the `slice` copy). Fails: no `pathBytes`.
6. GREEN — parser change above.
7. GUARD `index-parser.test.ts` — `é.txt` (`c3 a9 …`), U (`ef bf bd …`) and the BOM path parse
   with no `pathBytes` key (`'pathBytes' in entry === false`; passes: the lossless branch keeps the
   key absent). Existing `toEqual` fixtures stay green (absent key).
8. REFACTOR — none; then `npm run docs:json` and commit the regenerated `reports/api.json`.

### Gate
```sh
rm -rf .wireit
npx vitest run test/unit/domain/objects/encoding.test.ts test/unit/domain/git-index/index-parser.test.ts test/unit/domain/git-index/index-parser.properties.test.ts
npm run check:types
./node_modules/.bin/biome check src/domain/objects/encoding.ts src/domain/git-index/index-entry.ts src/domain/git-index/index-parser.ts test/unit/domain/objects/encoding.test.ts test/unit/domain/git-index/index-parser.test.ts
npm run check:spelling
npm run docs:json && git diff --stat reports/api.json
```

### Commit
`fix(index): carry raw path bytes on index entries whose path is not valid UTF-8`

## Part 3 — Byte-faithful index path keys

### Context
- `src/domain/git-index/index-path-key.ts` — CREATE (internal; no barrel entry). Imports
  `decodePreservingBom`, `decodesLosslessly` and `encode` from the objects encoding module and the `FilePath` type from the objects barrel. Exports:
  - `export interface IndexPath { readonly path: FilePath; readonly pathBytes?: Uint8Array }` —
    the path projection of an entry (`IndexEntry` is structurally an `IndexPath`).
  - `export type IndexPathKey = string & { readonly __brand: 'IndexPathKey' }`.
  - `export const latin1 = (bytes: Uint8Array): string` — one char per byte (moved verbatim from
    cache-tree's `keyOfBytes`, lines 78-82).
  - `export const indexPathKey = (entry: IndexPath): IndexPathKey` — `entry.path` when
    `pathBytes === undefined`, else `LOSSY_KEY_PREFIX + latin1(entry.pathBytes)` with
    `const LOSSY_KEY_PREFIX = '\0'` (comment why: NUL never occurs in a valid entry path, so a
    lossy key can never equal a UTF-8 key).
  - `export const keyOfPath = (path: FilePath): IndexPathKey` — a well-formed string path is its
    own key (used by every lookup from a pathspec / fs / tree string).
  - `export const pathBytesOf = (entry: IndexPath): Uint8Array` — `entry.pathBytes ?? encode(entry.path)`.
  - `export const indexPathOfBytes = (bytes: Uint8Array): IndexPath` — canonical construction:
    `path = decodePreservingBom(bytes)`, `pathBytes = bytes.slice()` only when
    `!decodesLosslessly(path, bytes)` (absent key otherwise).
  - `export const splitAtSlash = (bytes: Uint8Array): Uint8Array[]` — subarray views between
    `0x2f` bytes (name the constant), no empty-leading special case beyond what `split('/')` does.
- `src/domain/git-index/cache-tree.ts` — delete local `keyOfBytes` (lines 78-82) and import
  `latin1`; `keyOfComponent` / `keyOfChild` call `latin1`. Behaviour-preserving.
- `test/unit/domain/git-index/index-path-key.test.ts` — CREATE, example tests.
- `test/unit/domain/git-index/index-path-key.properties.test.ts` — CREATE.
- `test/unit/domain/git-index/arbitraries.ts` — ADD (used by Parts 3, 4, 5, 6, 14):
  - `arbPathBytes()`: 1-3 components joined by `0x2f`, each 1-4 tokens drawn from: ASCII `61`,
    `62`, `7a`; valid multi-byte `c3 a9`, `ef bb bf`, `ef bf bd`, `f0 9f 98 80`; invalid `ff`,
    `80`, `c3`, `c0 af`, `ed a0 80`, `f5`. No `2e` (dot), no `00`, so no dot, dot-dot, dot-git or empty
    component can arise and `validateIndexPath` accepts every view.
  - `arbRawPathBytes()`: `arbPathBytes()` filtered to lossy (`!bytesEqual(encode(decodePreservingBom(b)), b)`).
  - `arbIndexEntryWithPathBytes()`: `fc.tuple(arbStatData(), arbObjectId(), arbFlags(), arbPathBytes())`
    mapped to `{ ...stat, id, flags, ...indexPathOfBytes(bytes) }`.
  - `arbGitIndexWithPathBytes()`: like `arbGitIndexV3` (line 167) but entries from
    `arbIndexEntryWithPathBytes()`. Do NOT change the existing `arbGitIndexV2` and `arbGitIndexV3` (their
    properties assert `toEqual` against today's shapes).
- Reference: cache-tree tests (test/unit/domain/git-index/cache-tree.test.ts lines 218-300,
  BOM/non-UTF-8 `nameBytes` cases) are the guard for the move.

### TDD steps
1. RED `index-path-key.test.ts` — Given L (`{ path: '\uFFFD.txt', pathBytes: ff 2e 74 78 74 }`)
   and U (`{ path: '\uFFFD.txt' }`), When `indexPathKey` of each, Then they differ, U's key is
   `'\uFFFD.txt'` and L's key is `'\0\xff.txt'` (`String.fromCharCode(0, 0xff, 0x2e, 0x74, 0x78, 0x74)`).
   Fails: module does not exist (import error).
2. GREEN — create the module with `IndexPath`, `IndexPathKey`, `latin1`, `indexPathKey`.
3. RED `index-path-key.test.ts` — `indexPathOfBytes`: L bytes → `path '\uFFFD.txt'`,
   `pathBytes` equal to the input but NOT the same instance; `c3 a9` → `{ path: 'é' }` with no
   `pathBytes` key; `ef bb bf 61` → `{ path: '\uFEFFa' }` with no key. `pathBytesOf`: lossy returns
   the same `pathBytes` instance; UTF-8 returns `encode(path)`. `keyOfPath('a/b')` is `'a/b'`.
   `splitAtSlash(ff 2f 78)` → `[ff]`, `[78]`; no slash → one part equal to the input. `latin1`
   over `00..ff` maps each byte to the same char code. Fails: exports missing.
4. GREEN — add `keyOfPath`, `pathBytesOf`, `indexPathOfBytes`, `splitAtSlash`.
5. Properties `index-path-key.properties.test.ts` (Given an arbitrary path bytes b …):
   round-trip `bytesEqual(pathBytesOf(indexPathOfBytes(b)), b)` (200); invariant P
   `indexPathOfBytes(b).pathBytes === undefined` ⇔ `bytesEqual(encode(decodePreservingBom(b)), b)`
   (100); injective keys over two arbitrary b1, b2:
   `indexPathKey(indexPathOfBytes(b1)) === indexPathKey(indexPathOfBytes(b2))` ⇔ `bytesEqual(b1, b2)`
   (100; the small token alphabet makes collisions of the decoded view likely);
   `splitAtSlash(b)` re-joined with `0x2f` equals b (200). These pass after step 4 (written after
   GREEN as additive grammar proofs, not RED).
6. REFACTOR — `cache-tree.ts`: replace `keyOfBytes` with the imported `latin1`. GUARD: the whole
   cache-tree.test.ts and cache-tree.properties.test.ts stay green.

### Gate
```sh
rm -rf .wireit
npx vitest run test/unit/domain/git-index/index-path-key.test.ts test/unit/domain/git-index/index-path-key.properties.test.ts test/unit/domain/git-index/cache-tree.test.ts test/unit/domain/git-index/cache-tree.properties.test.ts
npm run check:types
./node_modules/.bin/biome check src/domain/git-index/index-path-key.ts src/domain/git-index/cache-tree.ts test/unit/domain/git-index/index-path-key.test.ts test/unit/domain/git-index/index-path-key.properties.test.ts test/unit/domain/git-index/arbitraries.ts
npm run check:spelling
```

### Commit
`refactor(index): introduce byte-faithful index path keys`

## Part 4 — Write raw path bytes verbatim and order entries by them

### Context
- `src/domain/git-index/index-writer.ts`:
  - `serializeIndex` (line 110), line 115 `const pathBytes = encode(entry.path as string);` →
    `pathBytesOf(entry)`. The name-length field (`writeEntry`, line 183,
    `Math.min(pathBytes.length, 0xfff)`) is then the raw length — no change there.
  - `compareEntryPath(a: IndexEntry, b: IndexEntry)` (line 57) → `(a: IndexPath, b: IndexPath)`:
    both `pathBytes` undefined → `comparePathStrings(a.path, b.path)` (today's ADR-966 code-unit
    rank); otherwise `compareBytes(pathBytesOf(a), pathBytesOf(b))` (`compareBytes` from the
    objects encoding module). Keep the exported name (barrel value, internal).
  - `compareUtf16Path` and `pathComparatorFor(entries: ReadonlyArray<IndexPath>)` — widen the
    parameter type only; the `SURROGATE_OR_ABOVE` pick already routes every index holding a lossy
    entry to `compareEntryPath` (a lossy view always contains U+FFFD). Add a doc line saying so.
  - Callers that need no edit (they pass `IndexEntry[]`): diff-index-entries.ts
    (`comparatorForBoth`'s `first === compareEntryPath` test stays right), build-index-from-tree.ts
    line 132, materialize-tree.ts lines 155/178, apply-merge-to-worktree.ts line 293.
- `test/unit/domain/git-index/index-writer.test.ts` — extend the serializeIndex and
  compareEntryPath describes.
- `test/unit/domain/git-index/index-writer.properties.test.ts` — add an order property.
- `test/unit/domain/git-index/index-parser.properties.test.ts` — add the raw-path round trip
  (reuse its `withChecksum` helper, line 11).
- `test/integration/index-path-bytes-interop.test.ts` — add rows B1-B3, F1-F2 and the helpers
  `hashBlob(dir, content)` (`git hash-object -w --stdin`) and
  `stageRaw(dir, rows: ReadonlyArray<{ mode: string; oid: string; path: Uint8Array }>)`
  (`runGit(['-C', dir, 'update-index', '-z', '--index-info'], { input })` where input is the
  concatenation of `` `${mode} ${oid}\t` `` bytes, the raw path, and `0x00` per row).
- Reference: `pathBytesOf`, `IndexPath` from src/domain/git-index/index-path-key.ts;
  `arbIndexEntryWithPathBytes`, `arbGitIndexWithPathBytes` from the git-index arbitraries.

### TDD steps
1. RED `index-writer.test.ts` — Given an index with entry L (`path '\uFFFD.txt'`,
   `pathBytes ff 2e 74 78 74`), When `serializeIndex(index, 20)`, Then the path bytes written at
   offset `12 + 62` are `ff 2e 74 78 74` and the flags word's name length (low 12 bits) is `5`.
   Fails: writes `ef bf bd 2e 74 78 74`, length `7`.
2. GREEN — `pathBytesOf(entry)` in `serializeIndex`.
3. RED `index-writer.test.ts` — `compareEntryPath` mixed pairs: raw `c3` (view `'\uFFFD'`) vs
   `'é'` (`c3 a9`) is negative; raw `ff` vs `'\u{1F600}'` (`f0 9f 98 80`) is positive; raw `ff`
   vs U (`ef bf bd`) is positive. Fails: the code-unit rank puts U+FFFD (rank 0xF7FD) above `é`,
   below the astral surrogate rank, and equal to U.
4. GREEN — the two-arm `compareEntryPath`.
5. GUARD `index-writer.test.ts` — both-UTF-8 pairs keep today's sign (existing tests); a raw
   pair `ff` vs `fe` compares by bytes; `pathComparatorFor([L])` returns `compareEntryPath`
   (passes: U+FFFD triggers the surrogate-or-above test) — pins that a lossy-only index takes the byte-aware comparator; `serializeIndex` orders `b/\xc3 < z < \xff.txt` (passes before and after).
6. Properties — `index-writer.properties.test.ts`: Given arbitrary entries a, b from
   `arbIndexEntryWithPathBytes`, When `compareEntryPath(a, b)`, Then its sign equals the sign of
   `compareBytes(pathBytesOf(a), pathBytesOf(b))` (200). `index-parser.properties.test.ts`: Given an
   arbitrary `arbGitIndexWithPathBytes()` index, When serialized, parsed (with checksum) and
   serialized again, Then the two byte arrays are equal, and every parsed entry's
   `pathBytesOf` equals its source entry's (200). Both are RED before steps 2/4 and pass after;
   write them before step 2 if the agent wants them as RED, else as additive proofs.
7. RED interop — B1 (pin, arrange): `stageRaw` `\xff.txt` and `b/\xc3` (blobs via `hashBlob`),
   `git add z`, `git commit`. B2 (GUARD after Part 2): tsgit `readIndex` gives `\xff.txt` with
   `pathBytes` hex `ff2e747874` and view `'\uFFFD.txt'`. B3: modify `z`, tsgit `repo.add(['z'])`;
   `lsFilesPathHex` is `['622fc3', '7a', 'ff2e747874']`, `git fsck` exits 0. Fails before step 2:
   `['622fefbfbd', '7a', 'efbfbd2e747874']`.
   F1-F2: git index `d/y` (real file), `d/\xff` (`stageRaw`), `e/f` (real file), `git commit`
   (valid `TREE`); modify `e/f`; tsgit `repo.add(['e/f'])`; Then `lsFilesPathHex` lists `642f79`,
   `642fff`, `652f66`, `git fsck --cache` exits 0, and `lsTreePathHex(dir, <git write-tree>)`
   equals `lsFilesPathHex(dir)`. Fails before step 2: entries say `642fefbfbd` while the carried
   `TREE` still names `\xff`.
8. REFACTOR — none expected.

### Gate
```sh
rm -rf .wireit
npx vitest run test/unit/domain/git-index/index-writer.test.ts test/unit/domain/git-index/index-writer.properties.test.ts test/unit/domain/git-index/index-parser.properties.test.ts test/unit/domain/git-index/diff-index-entries.test.ts
PATH=$HOME/.local/git-2.55.0/bin:$PATH npx vitest run test/integration/index-path-bytes-interop.test.ts
npm run check:types
./node_modules/.bin/biome check src/domain/git-index/index-writer.ts test/unit/domain/git-index/index-writer.test.ts test/unit/domain/git-index/index-writer.properties.test.ts test/unit/domain/git-index/index-parser.properties.test.ts test/integration/index-path-bytes-interop.test.ts
npm run check:spelling
```

### Commit
`fix(index): write raw index path bytes verbatim and order entries by them`

## Part 5 — Emit raw index path bytes as tree entry names

### Context
- `src/application/commands/commit.ts` — `SubtreeNode` (line 388), `buildTreeFromIndex` (393),
  `insertEntry` (403), `writeSubtree` (417). Today: `insertEntry(root, entry.path.split('/'), entry)`,
  `files: Map<string, {id, mode}>` and `subdirs: Map<string, SubtreeNode>` keyed by the
  component string; `treeEntry(mode, name, id)`. Change: components are `IndexPath`s — for a
  UTF-8 entry `entry.path.split('/')` (keep the string split, no encode), for a lossy entry
  `splitAtSlash(entry.pathBytes).map(indexPathOfBytes)`. Key both maps by
  `indexPathKey(component)` and store the tree name with each value
  (`component.pathBytes ?? component.path`); `writeSubtree` passes that name to
  `treeEntry(mode, name, id)` — the existing `string | Uint8Array` overload (src/domain/objects/tree.ts
  line 43 copies bytes). Result: twins L/U give two tree entries; the d-slash-ff and d-slash-y entries share subdir `d`.
- `src/application/primitives/synthesize-tree-from-index.ts` — `PendingEntry` (line 57) gains
  `readonly pathBytes?: Uint8Array`; `stage0Entries` (line 89) carries it (absent key when
  undefined); `groupByPrefix` (line 102): for a lossy pending entry cut `pathBytes` at the first
  `0x2f` (prefix component = `indexPathOfBytes(prefixBytes)`, rest = `indexPathOfBytes(restBytes)`
  as the sub-entry's `path`/`pathBytes`), for a UTF-8 entry keep today's string slicing; group
  `subdirs` by `indexPathKey(prefixComponent)` and keep the frame's tree name
  (`TrieFrame.name` becomes `string | Uint8Array`); `filesToTreeEntries` (line 187) passes
  `file.pathBytes ?? file.path`, the directory entry (line 206) passes the frame name.
  `indexEntryCheck` / `depthCheck` keep running on `entry.path` (same slash count, §D2).
  `synthesizeResultTree` shares the trie and inherits the fix.
- `test/unit/application/commands/commit.test.ts` — seed an index file holding lossy entries
  with `serializeIndexFixtureAsync` (test/unit/application/primitives/fixtures.ts line 561)
  written to the index path, blobs via `writeObject`.
- `test/unit/application/primitives/synthesize-tree-from-index.test.ts` and
  `test/unit/application/primitives/synthesize-tree-from-index.properties.test.ts`.
- `test/integration/index-path-bytes-interop.test.ts` — row B4.
- Reference: `walkTree(ctx, treeId, { pathBytes: true })` (public option, yields full raw path
  bytes) is the independent oracle for tree names in tests.

### TDD steps
1. RED `synthesize-tree-from-index.test.ts` — Given stage-0 entries `d/y` (UTF-8), `d/\xff`
   (lossy, `pathBytes 64 2f ff`), L and U, When `synthesizeTreeFromIndex`, Then walking the result
   with `{ pathBytes: true }` yields leaf path bytes hex `642f79`, `642fff`, `efbfbd2e747874`,
   `ff2e747874` (4 leaves). Fails: L and `d/\xff` are emitted under the U+FFFD encoding
   (`efbfbd…`), so L duplicates U's name and `d/\xff` becomes `642fefbfbd`.
2. GREEN — synthesize changes.
3. RED `commit.test.ts` — Given an index file holding the same four entries, When `commit`, Then
   HEAD's tree walk yields the same four leaf hex paths. Fails: `buildTreeFromIndex` keys and names
   by the decoded string.
4. GREEN — commit changes.
5. GUARD — a BOM entry `\uFEFFa/x` emits tree bytes `efbbbf612f78` in both builders (passes:
   `encode` of the BOM string). Existing commit/synthesize tests stay green.
6. Property `synthesize-tree-from-index.properties.test.ts` — Given arbitrary stage-0 entries from
   `arbIndexEntryWithPathBytes` with distinct `indexPathKey`s and no entry whose bytes are a
   `0x2f`-prefix of another's (filter), When synthesized and walked with `{ pathBytes: true }`,
   Then the multiset of leaf path bytes equals the entries' `pathBytesOf` (50, filter-heavy).
7. RED interop B4 — continuing the B3 state (same `it` or a fresh setup reaching it): tsgit
   `repo.commit(...)`; `lsTreePathHex(dir, 'HEAD')` is `['622fc3', '7a', 'ff2e747874']` and
   `git diff-tree -r --name-status HEAD~1 HEAD` is exactly `M\tz`. Fails before step 4: tree has
   `efbfbd…`, diff shows `D`/`A` pairs.
8. REFACTOR — extract a shared "components of an index path" helper only if both files would
   otherwise duplicate it (jscpd runs at validate).

### Gate
```sh
rm -rf .wireit
npx vitest run test/unit/application/commands/commit.test.ts test/unit/application/primitives/synthesize-tree-from-index.test.ts test/unit/application/primitives/synthesize-tree-from-index.properties.test.ts
PATH=$HOME/.local/git-2.55.0/bin:$PATH npx vitest run test/integration/index-path-bytes-interop.test.ts
npm run check:types
./node_modules/.bin/biome check src/application/commands/commit.ts src/application/primitives/synthesize-tree-from-index.ts test/unit/application/commands/commit.test.ts test/unit/application/primitives/synthesize-tree-from-index.test.ts test/unit/application/primitives/synthesize-tree-from-index.properties.test.ts test/integration/index-path-bytes-interop.test.ts
npm run check:spelling
```

### Commit
`fix(commit): emit raw index path bytes as tree entry names`

## Part 6 — Invalidate cache-tree nodes by raw path bytes

### Context
- `src/domain/git-index/cache-tree.ts` — `invalidateCacheTree(root, paths: ReadonlyArray<FilePath>)`
  (line 152) → `paths: ReadonlyArray<IndexPath>`. `Pending` (line 104) becomes an array of
  precomputed component KEYS: a UTF-8 path → `path.split('/').map(keyOfComponent)`; a lossy path →
  `splitAtSlash(pathBytes).map(latin1)`. `groupByComponent` (line 106) then reads
  `item[depth]` directly (drop its per-level `keyOfComponent` call — one regex test per component
  per level saved). `keyOfChild` already keys a child by `nameBytes` when present, so a change
  under `\xff/x` now reaches node `\xff` (with string keys the U+FFFD component keyed to
  `latin1(ef bf bd)` and missed it).
- `src/domain/git-index/carry-extensions.ts` — `carryTree` (line 33), TRANSITIONAL until Part 7:
  `invalidateCacheTree(root, change.changedPaths.map((path) => ({ path })))`.
- `test/unit/domain/git-index/cache-tree.test.ts` — the `invalidateCacheTree` describe (lines
  128-300) passes `['d/c']`-style arrays; convert each call to `IndexPath` objects
  (`[{ path: 'd/c' as FilePath }]`); add lossy cases.
- `test/unit/domain/git-index/cache-tree.properties.test.ts` — the invalidation properties
  (lines 101-160) build string paths from component names; lift them to `{ path }` and add the raw
  property. Its `coversPath` helper must compare component keys (latin1 of `nameBytes` when present)
  instead of `path` strings for the raw property.
- `test/unit/domain/git-index/carry-extensions.test.ts` — four expected-value calls
  `invalidateCacheTree(cacheTree(n), change.changedPaths)` (lines ~99, 217, 308, 375) need the same
  `{ path }` lift.
- Reference: `IndexPath`, `latin1`, `splitAtSlash`, `indexPathOfBytes` (index-path-key module);
  `parseCacheTree` keeps `decode` + `nameBytes` (unchanged).

### TDD steps
1. RED `cache-tree.test.ts` — Given a cache-tree whose root has a valid child with `nameBytes`
   `[0xff]` (path `'\uFFFD'`) holding `x`, and a valid sibling `a`, When
   `invalidateCacheTree(root, [{ path: '\uFFFD/x', pathBytes: ff 2f 78 }])`, Then the `\xff` child
   has `entryCount -1` and no `id`, keeps its `nameBytes`, and `a` is the same object. Fails today:
   the item reaches `path.split` as an object (TypeError) — and with a string `'\uFFFD/x'` the child
   would stay valid (key `latin1(ef bf bd)` ≠ `latin1(ff)`).
2. RED `cache-tree.test.ts` — Given siblings with `nameBytes` `[0xff]` and path `'\uFFFD'` without
   `nameBytes` (the U twin), When the lossy path `\xff/x` is invalidated, Then only the `\xff` child
   is invalidated. Fails as 1.
3. GREEN — new `invalidateCacheTree` / `Pending` / `groupByComponent`; transitional lift in
   `carryTree`; convert the existing test call sites.
4. GUARD `cache-tree.test.ts` — a BOM changed path `{ path: '\uFEFFa/x' }` invalidates the child whose
   `nameBytes` are `ef bb bf 61` (passes: `keyOfComponent` latin1-encodes non-ASCII).
5. Property `cache-tree.properties.test.ts` — Given an arbitrary tree whose subtree names are raw
   components (`nameBytes` from `arbRawPathBytes` components, `path` their decoded view) and changed
   paths built from those `nameBytes` joined by `0x2f` (`indexPathOfBytes`), When
   `invalidateCacheTree`, Then no valid node covers a changed path (100). Existing properties keep
   passing with `{ path }` lifts.
6. REFACTOR — none.

### Gate
```sh
rm -rf .wireit
npx vitest run test/unit/domain/git-index/cache-tree.test.ts test/unit/domain/git-index/cache-tree.properties.test.ts test/unit/domain/git-index/carry-extensions.test.ts test/unit/domain/git-index/carry-extensions.properties.test.ts test/unit/domain/git-index/carry-extensions.rethrow.test.ts
npm run check:types
./node_modules/.bin/biome check src/domain/git-index/cache-tree.ts src/domain/git-index/carry-extensions.ts test/unit/domain/git-index/cache-tree.test.ts test/unit/domain/git-index/cache-tree.properties.test.ts test/unit/domain/git-index/carry-extensions.test.ts
npm run check:spelling
```

### Commit
`fix(index): invalidate cache-tree nodes by raw path bytes`

## Part 7 — Keep index changes whose decoded paths collide distinct

### Context
- `src/domain/git-index/diff-index-entries.ts` — `IndexChange.changedPaths` (line 6) →
  `ReadonlyArray<IndexPath>`. `collectChangedPaths` (line 26) returns `IndexPath[]` and pushes the
  entry itself (an `IndexEntry` is an `IndexPath`; no allocation); `mark` dedups on
  `indexPathKey(last) !== indexPathKey(entry)` instead of `changed[last] !== entry.path`.
  `comparatorForBoth` unchanged (Part 4 made `compareEntryPath` byte-aware).
- `src/domain/git-index/carry-extensions.ts` — `carryTree`: drop Part 6's transitional lift
  (pass `change.changedPaths`). `withRestagedPaths(change, restagedPaths: ReadonlyArray<FilePath>)`
  (line 84) keeps its parameter type for now (TRANSITIONAL until Part 8): lift each restaged string
  to `{ path }`, union with `change.changedPaths` deduplicated by `indexPathKey` (first wins), sort
  with `pathComparatorFor(union)` (replaces `pathStringComparatorFor`, whose last caller this was —
  its deletion is in Part 12). `NO_INDEX_CHANGE` unchanged.
- `test/unit/domain/git-index/diff-index-entries.test.ts` — assertions on `changedPaths` compare
  `.map(({ path }) => path)` (or `IndexPath` objects); add the collision cases.
- `test/unit/domain/git-index/carry-extensions.test.ts`,
  `test/unit/domain/git-index/carry-extensions.properties.test.ts` (line 50),
  `test/unit/domain/git-index/carry-extensions.rethrow.test.ts` (line 24) — `changedPaths:
  ['d/c' as FilePath]` literals become `[{ path: 'd/c' as FilePath }]`; drop the Part 6 lifts in the
  expected-value calls; the `withRestagedPaths` describe (lines ~320-360) now asserts `IndexPath`s.
- Reference: only carry-extensions and tests read `IndexChange.changedPaths` (index-lock passes
  the whole change through).

### TDD steps
1. RED `diff-index-entries.test.ts` — Given before `[U (id 1), L (id 1)]` and after
   `[U (id 2), L (id 3)]`, When `diffIndexEntries`, Then `changedPaths` has 2 items, the second
   carrying L's `pathBytes`. Fails: `mark` dedups on the decoded string, length 1.
2. RED `diff-index-entries.test.ts` — Given before `[U]` and after `[U, L]`, Then `changedPaths` is
   `[L]` with `pathBytes`, and `trackedSetChanged` is true. Fails: item is a bare string.
3. GREEN — diff changes; type conversion in carry-extensions and the three carry test files.
4. RED `carry-extensions.test.ts` — Given a change whose `changedPaths` is `[L]` and restaged
   `['\uFFFD.txt']`, When `withRestagedPaths`, Then the union is `[{ path: '\uFFFD.txt' }, L]` (U's
   bytes `ef…` order before `ff…`). Fails: at this step `withRestagedPaths` still unions raw strings, so the restaged item stays a
   bare string instead of an `IndexPath` (step 3 leaves it untouched; `check:types` is red until step 5).
5. GREEN — new `withRestagedPaths`.
6. GUARD `carry-extensions.test.ts` — end to end: Given a `TREE` whose root holds a valid `\xff`
   subtree (`nameBytes [0xff]`) and a change from `diffIndexEntries` over a lossy `\xff/x` whose id
   changed, When `carryExtensions(…, 'update', …)`, Then the parsed carried `TREE` has the `\xff`
   child invalidated. Passes: Part 6 keys invalidation by bytes and step 3 hands the entry (with
   its `pathBytes`) straight to `invalidateCacheTree`.
7. REFACTOR — none.

### Gate
```sh
rm -rf .wireit
npx vitest run test/unit/domain/git-index/diff-index-entries.test.ts test/unit/domain/git-index/diff-index-entries.properties.test.ts test/unit/domain/git-index/carry-extensions.test.ts test/unit/domain/git-index/carry-extensions.properties.test.ts test/unit/domain/git-index/carry-extensions.rethrow.test.ts test/unit/application/primitives/internal/index-lock.test.ts
npm run check:types
./node_modules/.bin/biome check src/domain/git-index/diff-index-entries.ts src/domain/git-index/carry-extensions.ts test/unit/domain/git-index/diff-index-entries.test.ts test/unit/domain/git-index/carry-extensions.test.ts test/unit/domain/git-index/carry-extensions.properties.test.ts test/unit/domain/git-index/carry-extensions.rethrow.test.ts
npm run check:spelling
```

### Commit
`fix(index): keep index changes whose decoded paths collide distinct`

## Part 8 — Carry raw path bytes through restaged paths

### Context
- `src/domain/git-index/carry-extensions.ts` — `withRestagedPaths(change, restagedPaths:
  ReadonlyArray<IndexPath>)`: drop the Part 7 string lift; union + key dedup + sort unchanged.
- `src/application/primitives/internal/index-lock.ts` — `CommitOptions.restagedPaths` (line 40)
  → `ReadonlyArray<IndexPath>` (doc: "entries the writer re-staged whatever their object name").
  `carriedExtensions` (line 191) passes it through unchanged.
- `src/application/commands/add.ts` — the three producers become `IndexPath[]`:
  `stageLiterals` (line 264/272, push the new `entry` instead of `path`), `renormalizeEntries`
  (line 547/556, push `previous`), `restagedPathsOf` (line 624, map to `entry`); the
  `changesIndex` / `commitIfChanged` parameter types (lines 281-295) and the result types at
  lines 257, 543, 642 follow.
- `src/application/commands/stash.ts` — line ~804 `lock.commit(entries, 'replace', { restagedPaths })`:
  TRANSITIONAL until Part 12, lift `restagedPaths.map((path) => ({ path }))` (unstage still
  returns `FilePath[]`).
- `test/unit/domain/git-index/carry-extensions.test.ts` — `withRestagedPaths` cases take
  `IndexPath`s.
- `test/unit/application/primitives/internal/index-lock.test.ts` — lines 163/187
  `restagedPaths: ['b' as FilePath]` → `[{ path: 'b' as FilePath }]`; new lossy case. Fixture
  helpers (read-only): `cacheTreeExtension(root, digestLength)` and `withIndexExtensions(ctx, …)` in
  test/unit/application/primitives/helpers/index-extensions.ts.

### TDD steps
1. RED `index-lock.test.ts` — Given an on-disk index holding lossy `\xff/x` (written with
   `serializeIndexFixtureAsync`) and a `TREE` whose `\xff` subtree (`nameBytes [0xff]`) is valid, When
   `lock.commit(sameEntries, 'update', { restagedPaths: [lossyEntry] })`, Then the written index's
   `TREE` has the `\xff` child invalidated. Fails: `withRestagedPaths` lifts each item as a string,
   so the entry object reaches `path.split` (TypeError) — `check:types` rejects the call too.
2. GREEN — parameter/option type change in carry-extensions and index-lock; convert the existing
   `restagedPaths` literals in both test files.
3. GREEN (compiler-forced) — add.ts producers and the stash transitional lift. GUARD: the full
   add and stash unit suites stay green (test/unit/application/commands/add.test.ts,
   stash.test.ts) — behaviour is unchanged for UTF-8 paths.
4. REFACTOR — none.

### Gate
```sh
rm -rf .wireit
npx vitest run test/unit/domain/git-index/carry-extensions.test.ts test/unit/application/primitives/internal/index-lock.test.ts test/unit/application/commands/add.test.ts test/unit/application/commands/stash.test.ts
npm run check:types
./node_modules/.bin/biome check src/domain/git-index/carry-extensions.ts src/application/primitives/internal/index-lock.ts src/application/commands/add.ts src/application/commands/stash.ts test/unit/domain/git-index/carry-extensions.test.ts test/unit/application/primitives/internal/index-lock.test.ts
npm run check:spelling
```

### Commit
`fix(index): carry raw path bytes through restaged paths`

## Part 9 — Key the stat refresh and racy smudge by raw path bytes

### Context
- `src/application/primitives/internal/index-lock.ts` — `withRefreshedStat` (line 207):
  `new Map(refreshed.map((entry) => [indexPathKey(entry), entry]))` and
  `byPath.get(indexPathKey(entry))`. Reached through `IndexLock.commitRefresh(read, refreshed,
  verified)` (status write-back).
- `src/application/primitives/internal/smudge-racily-clean.ts` — `carriedOver` (line 56):
  `racyByPath` keyed by `indexPathKey(entry)`, looked up with `indexPathKey(entry)`.
  `IsVerified` stays `(path: FilePath) => boolean` (status verifies by fs path; see DC-1).
- `test/unit/application/primitives/internal/index-lock.test.ts` — the `commitRefresh` describe.
- `test/unit/application/primitives/internal/smudge-racily-clean.test.ts` — follow its existing
  racy-timestamp setup (index mtime vs entry mtime).

### TDD steps
1. RED `index-lock.test.ts` — Given a read index `[U, L]` (written to disk) and `refreshed = [U']`
   (U with new stat), When `commitRefresh(read, refreshed, () => false)`, Then the written index
   holds U' and L with L's `pathBytes` intact (hex `ff2e747874`). Fails: L is looked up by its
   decoded path and replaced by U', so the file holds U' twice.
2. GREEN — key `withRefreshedStat`.
3. RED `smudge-racily-clean.test.ts` — Given a previous index holding only U (racy stat S) and new
   entries `[L]` with the same stat S, When `smudgeRacilyClean`, Then L is returned unchanged (same
   object, `fileSize` kept). Fails: `racyByPath` keyed by the decoded path makes L look carried over
   from U, so L is probed against U's working file and smudged (`fileSize 0`).
4. GREEN — key `carriedOver`.
5. REFACTOR — none.

### Gate
```sh
rm -rf .wireit
npx vitest run test/unit/application/primitives/internal/index-lock.test.ts test/unit/application/primitives/internal/smudge-racily-clean.test.ts
npm run check:types
./node_modules/.bin/biome check src/application/primitives/internal/index-lock.ts src/application/primitives/internal/smudge-racily-clean.ts test/unit/application/primitives/internal/index-lock.test.ts test/unit/application/primitives/internal/smudge-racily-clean.test.ts
npm run check:spelling
```

### Commit
`fix(index): key the stat refresh and racy smudge by raw path bytes`

## Part 10 — Keep add's index entries whose decoded paths collide

### Context
- `src/application/commands/add.ts` (1022 lines) — every map/set keyed on an index entry path
  becomes `IndexPathKey`-keyed:
  - `Staging.entries` (line 231), `ExistingIndexState.entries` (line 812): `ReadonlyMap<IndexPathKey, IndexEntry>`;
    `readExistingEntries` (line 808) `out.set(indexPathKey(entry), entry)`.
  - `trackedFirst` (line 238): `existing.has(keyOfPath(path))`.
  - `stageLiterals` (line 247): `new Map<IndexPathKey, IndexEntry>(existing)`,
    `existing.get(keyOfPath(path))`, `newEntries.set(keyOfPath(path), entry)`.
  - `walkedTrackedFirst` (line 376): key the `walked` map by `keyOfPath(walkEntry.path)` and iterate
    `existing.keys()` — a lossy key never matches an fs key, by construction.
  - `stageWalkedEntries` / `processWalkEntry` (lines 352, ~789-793): `existing.get(keyOfPath(path))`.
  - `restagedPathsOf` (line 624), `tallyWalkOutcomes` (line 634), `addAll` (line 664):
    `Map<IndexPathKey, IndexEntry>`, `set(keyOfPath(outcome.path), …)`; `seen: Set<IndexPathKey>`
    (`seen.add(keyOfPath(path))` at line 778).
  - `collectRemovedPaths` (line 730): iterate `[key, entry]`, `seen.has(key)`,
    `isPathOrAncestorIgnored(entry.path, ignore)`, return the removed ENTRIES; `addAll` deletes by
    `indexPathKey(entry)` and reports `removed` as their `path`s (sorted as today).
  - `stageStaging`'s `indexRules` (lines 150-153, 816) STAY `FilePath`-keyed (EOL rule lookups by fs
    path; DC-1).
- `test/unit/application/commands/add.test.ts` — seed lossy index entries with
  `serializeIndexFixtureAsync` (test/unit/application/primitives/fixtures.ts).
- `test/integration/index-path-bytes-interop.test.ts` — rows C1-C3.
- Reference: `indexPathKey`, `keyOfPath` (index-path-key module).

### TDD steps
1. RED `add.test.ts` — Given an index holding `z`, U (blob y) and L (blob x) and a modified `z` on
   disk, When `add(ctx, ['z'])`, Then the written index has 3 entries: `z` (new blob), U with blob y,
   L with blob x and `pathBytes` `ff2e747874`. Fails: `readExistingEntries` collapses U/L under
   `'\uFFFD.txt'`, one entry is dropped and the survivor may carry the other's blob.
2. GREEN — literal-path route (`readExistingEntries`, `trackedFirst`, `stageLiterals`).
3. RED `add.test.ts` — Given the same index, When `add(ctx, [], { all: true })` with only `z` (unchanged since the index) and
   `'\uFFFD.txt'` (blob y content) on disk, Then `removed` is `['\uFFFD.txt']` (L: its raw file is not addressable through the
   string fs — git gives the same verdict when the raw file is absent), `modified` is empty, and the
   index holds `z` and U. Fails: `existing` keeps only L under the decoded key, so the walked
   `'\uFFFD.txt'` is staged over L and reported modified while L vanishes without being reported.
4. GREEN — walk route (`walkedTrackedFirst`, `tallyWalkOutcomes`, `addAll`, `collectRemovedPaths`).
5. RED interop C1-C3 — C1: `stageRaw` L (blob x), U (blob y), `\xef\xbb\xbfz` (blob y), `git add z`.
   C2 (GUARD): tsgit `readIndex` → 4 entries, `pathBytesOf` hex `['7a', 'efbbbf7a',
   'efbfbd2e747874', 'ff2e747874']`. C3: modify `z`, tsgit `repo.add(['z'])`; `git ls-files -s -z`
   lists 4 entries with those path bytes, the `ff2e747874` one with blob x and the `efbfbd…` one
   with blob y; `git fsck` exits 0. Passes after step 2 (write it before step 2 to watch it fail:
   today 2 entries `7a`, `efbfbd2e747874` with blob x).
6. REFACTOR — remove any `FilePath`-keyed type alias left unused.

### Gate
```sh
rm -rf .wireit
npx vitest run test/unit/application/commands/add.test.ts test/unit/application/commands/add-clean-order.test.ts test/unit/application/commands/add-big-file-threshold.test.ts
PATH=$HOME/.local/git-2.55.0/bin:$PATH npx vitest run test/integration/index-path-bytes-interop.test.ts test/integration/add-interop.test.ts
npm run check:types
./node_modules/.bin/biome check src/application/commands/add.ts test/unit/application/commands/add.test.ts test/integration/index-path-bytes-interop.test.ts
npm run check:spelling
```

### Commit
`fix(add): keep index entries whose decoded paths collide`

## Part 11 — Keep raw path bytes in rm and mv

### Context
- `src/domain/git-index/index-entry.ts`:
  - ADD `export const withPath = (entry: IndexEntry, to: IndexPath): IndexEntry` — builds the entry
    field by field from `entry`'s stat/id/mode/flags (no spread of `entry`, so stale `pathBytes`
    never ride along), sets `path: to.path` and `pathBytes` only when `to.pathBytes` is defined.
    Not added to the git-index barrel (internal).
  - `skipWorktreeEntry` (line 128): parameter `IndexPath & { readonly id: ObjectId; readonly mode:
    FileMode }`; sets `pathBytes` only when defined (absent key otherwise).
  - Import the `IndexPath` type from the index-path-key module (no cycle: that module imports only
    objects).
- `test/unit/domain/git-index/index-entry.test.ts`.
- `src/application/commands/rm.ts` — `byPath` (lines 87-115): `Map<IndexPathKey, IndexEntry>` keyed
  `indexPathKey(entry)`; the matching loop iterates `[key, entry]`, tests
  `matchesPathspec(matcher, entry.path)` (pathspecs see the decoded view), records the matched keys,
  and deletes by key. `removed` stays the `FilePath` view list (result + `removeFile`; fs I/O of raw
  names is out of scope).
- `test/unit/application/commands/rm.test.ts`.
- `src/application/commands/mv.ts` — `readIndexMap` (line 129) keyed `indexPathKey(entry)`;
  `buildPlan`/`validateMove`/`classifySource`/`destinationFree` take `ReadonlyMap<IndexPathKey, …>`;
  `classifySource` exact lookup `byPath.get(keyOfPath(source))`, directory branch keeps
  `entry.path.startsWith(prefix)` (the ASCII slash sits at the same position in both views);
  `destinationFree` `byPath.has(keyOfPath(target))`; `applyToIndex` (line 298): delete
  `indexPathKey(entry)`, build the moved entry with `withPath(entry, movedPath(entry, source,
  target))` and set it under its own key. New private `movedPath`: UTF-8 entry →
  `{ path: repath(entry, source, target) }`; lossy entry → `indexPathOfBytes(concatBytes([encode(target),
  entry.pathBytes.subarray(encode(source).length)]))` (the source prefix is a user string, so its
  encoded length is the exact cut). `plannedMoves` keeps the string `repath` for the result.
- `test/unit/application/commands/mv.test.ts`.
- Reference: `concatBytes`, `encode` (objects encoding module); `indexPathOfBytes`, `keyOfPath`,
  `indexPathKey` (index-path-key module).

### TDD steps
1. RED `index-entry.test.ts` — `withPath(L, { path: 'e/x' })` has no `pathBytes` key and every
   stat/id/mode/flags field of L; `withPath(entryA, { path: L.path, pathBytes: L.pathBytes })` carries L's bytes. Fails: not exported.
   `skipWorktreeEntry({ path, pathBytes: L bytes, id, mode })` keeps `pathBytes`; without bytes the key
   is absent. Fails: today the bytes are dropped.
2. GREEN — `withPath`, `skipWorktreeEntry`.
3. RED `rm.test.ts` — Given an index `[z, U, L]`, When `rm(ctx, ['z'], { cached: true })`, Then the
   written index holds U and L (L with `pathBytes`). Fails: `byPath` collapses U/L and one is lost.
4. GREEN — rm keys.
5. RED `mv.test.ts` — Given an index `[d/y, d/\xff (lossy)]` and directory `d` with `y` on disk,
   When `mv(ctx, ['d'], 'e')`, Then the index holds `e/y` and an entry with `path 'e/\uFFFD'` and
   `pathBytes 65 2f ff`. Fails: the spread `{ ...entry, path: newPath }` keeps `pathBytes 64 2f ff`,
   so the writer emits the old name.
6. GREEN — mv keys + `movedPath` + `withPath`.
7. REFACTOR — none.

### Gate
```sh
rm -rf .wireit
npx vitest run test/unit/domain/git-index/index-entry.test.ts test/unit/application/commands/rm.test.ts test/unit/application/commands/mv.test.ts
npm run check:types
./node_modules/.bin/biome check src/domain/git-index/index-entry.ts src/application/commands/rm.ts src/application/commands/mv.ts test/unit/domain/git-index/index-entry.test.ts test/unit/application/commands/rm.test.ts test/unit/application/commands/mv.test.ts
npm run check:spelling
```

### Commit
`fix(index): keep raw path bytes when rm and mv rewrite the index`

## Part 12 — Keep raw path bytes when stash restores entries and lists untracked files

### Context
- `src/application/commands/internal/unstage-changes-unless-new.ts`:
  - `byPath` (line 21) → `compareEntryPath` (index-writer; byte-aware since Part 4).
  - `undoBefore` (line 55): `compareEntryPath(prev, now) >= 0`.
  - `joinByPath` (line 70): `prev === undefined || indexPathKey(prev) !== indexPathKey(now)`.
  - `occupiedBy` (line 37): `files`/`dirs` become `Set<IndexPathKey>`; ancestor keys of a UTF-8 path
    are its slash-delimited prefixes (as today, typed as keys); of a lossy path, `indexPathKey(indexPathOfBytes(
    pathBytes.subarray(0, at)))` for each `0x2f` index `at`. The returned predicate takes the entry
    (`IndexPath`), not a string.
  - `UnstageOutcome.restagedPaths` (line 101) → `IndexPath[]`; line 126
    `restagedPaths: [...added, ...restoredEntries]`.
- `test/unit/application/commands/internal/unstage-changes-unless-new.test.ts` — assertions on
  `restagedPaths` (lines 41, 109, 126, 179, 196) compare `.map(({ path }) => path)`.
- `src/application/commands/stash.ts` — drop Part 8's transitional lift (line ~804);
  `listUntracked` (line 372): `tracked = new Set(index.entries.map(indexPathKey))`, test
  `tracked.has(keyOfPath(path))`.
- `test/unit/application/commands/stash.test.ts`.
- `src/domain/git-index/index-writer.ts` — delete `pathStringComparatorFor` (lost its last src
  caller in Part 7; dead code). `comparePathStrings` stays (used by `compareEntryPath`).
- `test/unit/domain/git-index/index-writer.test.ts` — delete the `pathStringComparatorFor` tests.

### TDD steps
1. RED `unstage-changes-unless-new.test.ts` — Given merged `[L (new)]` and before `[U]` (U deleted by
   the merge), When `unstageChangesUnlessNew`, Then entries are `[U (zero stat), L]` and L stays
   staged. Fails: the join pairs U with L by their equal decoded string and drops L.
2. GREEN — comparator + key join.
3. RED `unstage-changes-unless-new.test.ts` — Given a kept new lossy `\xff/x` and a restored U-named
   file `'\uFFFD'` (bytes `ef bf bd`), Then the restored file is kept (no collision: `\xff` is not
   `\xef\xbf\xbd`). Fails: `occupiedBy` sees directory `'\uFFFD'` and drops it.
4. GREEN — key-based `occupiedBy`; `restagedPaths` as `IndexPath[]` (assert L's `pathBytes` in the
   list); remove stash's transitional lift.
5. RED `stash.test.ts` — Given a tracked lossy `\xff.txt` and an untracked file `'\uFFFD.txt'` on
   disk, When `stash push` with `includeUntracked: true`, Then `'\uFFFD.txt'` is stashed as untracked
   and removed from the working tree. Fails: the `tracked` set holds the decoded view and hides it.
6. GREEN — stash `listUntracked` keys.
7. REFACTOR — delete `pathStringComparatorFor` and its tests (GUARD: index-writer suite green).

### Gate
```sh
rm -rf .wireit
npx vitest run test/unit/application/commands/internal/unstage-changes-unless-new.test.ts test/unit/application/commands/stash.test.ts test/unit/application/commands/stash-unmerged-index.test.ts test/unit/domain/git-index/index-writer.test.ts
npm run check:types
./node_modules/.bin/biome check src/application/commands/internal/unstage-changes-unless-new.ts src/application/commands/stash.ts src/domain/git-index/index-writer.ts test/unit/application/commands/internal/unstage-changes-unless-new.test.ts test/unit/application/commands/stash.test.ts test/unit/domain/git-index/index-writer.test.ts
npm run check:spelling
```

### Commit
`fix(stash): keep raw index path bytes when unstaging and listing untracked files`

## Part 13 — Key status, submodule and sparse-checkout index maps by raw path bytes

### Context
- `src/application/commands/status.ts` — `trackedEntriesOf` (line 222): `trackedPaths` becomes
  `ReadonlySet<IndexPathKey>` built from `grouped.staged.map(indexPathKey)` plus
  `keyOfPath(path)` for each `grouped.unmerged` key; `TrackedEntries.trackedPaths` type (line 217)
  and `scanUntracked` (line 379) follow (`trackedPaths.has(keyOfPath(path))`). `stage0Map`,
  `collectStagedKinds`, `buildChanges` STAY string-keyed (DC-1).
- `test/unit/application/commands/status.test.ts`.
- `src/application/commands/submodule.ts` — `stageSubmodule` (line 602): `entries` map keyed
  `indexPathKey(e)`; the gitlink and `.gitmodules` sets use `keyOfPath(path as FilePath)` /
  `keyOfPath(GITMODULES_FILE as FilePath)`.
- `test/unit/application/commands/submodule-add.test.ts` — extend "When the index holds several
  entries and the target path is tracked" (line 307) style setup.
- `src/application/commands/internal/apply-sparse-checkout.ts` — `toSkipWorktree` (line 161)
  rebuilds without spread and drops `pathBytes`: replace it with the domain `skipWorktreeEntry(entry)`
  (Part 11 made it carry bytes; same zero stat, kept id/mode, `skipWorktree: true` STAGE0 flags —
  delete `ZEROED_STAT` if nothing else uses it). `assembleEntries` (line 181): `writtenByPath`
  keyed `indexPathKey(entry)`, looked up with `indexPathKey(entry)`.
- `test/unit/application/commands/internal/apply-sparse-checkout.test.ts`.

### TDD steps
1. RED `status.test.ts` — Given an index holding lossy L only and an untracked file `'\uFFFD.txt'` on
   disk, When `status`, Then `untracked` contains `'\uFFFD.txt'`. Fails: the tracked set holds L's
   decoded view. (git: `?? \xef\xbf\xbd.txt`.)
2. GREEN — status `trackedPaths`.
3. RED `submodule-add.test.ts` — Given an index holding U and L, When a submodule is added, Then the
   written index still holds both U and L (L with `pathBytes`) plus the gitlink and `.gitmodules`.
   Fails: the string map collapses U/L.
4. GREEN — submodule keys.
5. RED `apply-sparse-checkout.test.ts` — Given lossy `\xff.txt` excluded by the new patterns, When
   applied, Then its skip-worktree entry keeps `pathBytes`. Fails: `toSkipWorktree` rebuilds without
   it. Given lossy L included while U is also included and written, Then L and U each keep their own
   record (L's bytes intact). Fails: `writtenByPath` keyed by the view hands U's written record to L.
6. GREEN — sparse changes.
7. REFACTOR — none.

### Gate
```sh
rm -rf .wireit
npx vitest run test/unit/application/commands/status.test.ts test/unit/application/commands/status-refresh.test.ts test/unit/application/commands/submodule-add.test.ts test/unit/application/commands/internal/apply-sparse-checkout.test.ts test/unit/application/commands/sparse-checkout.test.ts
npm run check:types
./node_modules/.bin/biome check src/application/commands/status.ts src/application/commands/submodule.ts src/application/commands/internal/apply-sparse-checkout.ts test/unit/application/commands/status.test.ts test/unit/application/commands/submodule-add.test.ts test/unit/application/commands/internal/apply-sparse-checkout.test.ts
npm run check:spelling
```

### Commit
`fix(index): key status, submodule and sparse-checkout index maps by raw path bytes`

## Part 14 — Lossy-only tree-walk bytes and the reset rebuild

### Context
- `src/application/primitives/walk-tree.ts` (302 lines) — internal byte channel:
  - `WalkConfig` (line 29) gains `readonly lossyPathBytes: boolean`; `FramePrefix` (line 51) gains
    `readonly lossyBytes: Uint8Array | undefined` — the frame's own path bytes when the frame path
    does NOT round-trip, else `undefined`.
  - Per entry (`nextFrameEntry`, line 166): when `config.lossyPathBytes`, the entry is lossy iff
    `frame.framePrefix.lossyBytes !== undefined || !decodesLosslessly(entry.name, entry.nameBytes)`
    (`TreeEntry.name` is already `decodePreservingBom(nameBytes)`); then
    `pathBytes = join(prefixLossyBytes ?? encode(prefix.text), nameBytes)` with the root rule of
    `joinPrefixBytes` (no leading slash at the root). Otherwise `undefined`. Keep the existing
    `pathBytes: true` option behaviour unchanged (it wins when both are on). Put the selection in a
    small helper so `nextFrameEntry` stays flat.
  - `buildRootPrefix` (line 190): `lossyBytes: undefined`; `buildChildPrefix` (line 203): child
    `lossyBytes` = the entry's computed lossy `pathBytes` (or `undefined`).
  - Entry point: split today's `walkTree` body into a private generator over a resolved
    `WalkConfig`; `walkTree(ctx, treeIdOrObject, options?)` resolves with `lossyPathBytes: false`
    (public signature, `WalkTreeOptions` and the Repository binding untouched);
    `export function walkTreeWithLossyBytes(ctx, treeIdOrObject, options?: WalkTreeOptions):
    AsyncIterable<WalkTreeEntry>` resolves with `lossyPathBytes: true`. Do NOT add it to
    src/application/primitives/index.ts (internal). No boolean parameter.
- `test/unit/application/primitives/walk-tree.test.ts` — trees built with
  `treeEntry(mode, Uint8Array, id)` + `writeTree` (existing imports at lines 1-29).
- `test/unit/application/primitives/walk-tree.properties.test.ts`.
- `src/application/primitives/build-index-from-tree.ts` — `TargetLeaf` (line 54) gains
  `readonly pathBytes?: Uint8Array`; `collectLeaves` (line 69) walks with `walkTreeWithLossyBytes`
  and copies `pathBytes` only when present; `donorByPath` (line 60) → `Map<IndexPathKey,
  IndexEntry>` keyed `indexPathKey`; `projectLeaf` (line 110): `validateIndexPath(leaf.path, …)` and
  `sparse(leaf.path)` stay on the view, `donors.get(indexPathKey(leaf))`, `skipWorktreeEntry(leaf)`
  carries bytes (Part 11), `zeroStatEntry(leaf)` (line 78) sets `pathBytes` only when defined; the
  donor spread `{ ...donor, flags }` keeps the donor's own bytes (same key ⇒ same bytes).
- `test/unit/application/primitives/build-index-from-tree.test.ts` — helpers `writeBlob`,
  `makeIndexEntry`, `EMPTY_INDEX` (lines 19-60).
- `test/integration/index-path-bytes-interop.test.ts` — rows E1, F3.

### TDD steps
1. RED `walk-tree.test.ts` — Given a tree `{ \xff/ { x }, ok/ { y }, \uFEFFb, é }`, When
   `walkTreeWithLossyBytes`, Then `\xff` yields `pathBytes [ff]`, `\xff/x` yields `ff 2f 78`, and
   `ok`, `ok/y`, `\uFEFFb`, `é` have no `pathBytes` key. Fails: not exported.
2. GREEN — config/prefix/helper and the new entry point.
3. GUARD `walk-tree.test.ts` — plain `walkTree` still yields no `pathBytes` key (existing tests at
   line 534); `{ pathBytes: true }` unchanged.
4. Property `walk-tree.properties.test.ts` — Given an arbitrary tree whose leaf names come from
   `arbPathBytes` components, When walked with `walkTreeWithLossyBytes` and with
   `walkTree(…, { pathBytes: true })` (independent oracle), Then each entry carries `pathBytes` iff
   the oracle's bytes do not equal `encode(path)`, and when present they are byte-equal (100).
5. RED `build-index-from-tree.test.ts` — Given a tree holding L and U leaves and donors L (same id) and
   U (same id) with distinct stat, When `buildIndexFromTree`, Then L keeps `pathBytes ff2e747874`
   and L's donor stat, U keeps U's donor stat. Fails: leaves carry no bytes and the donor map
   collapses U/L. Given sparse excluding L, Then the skip-worktree entry keeps `pathBytes`.
6. GREEN — build-index-from-tree changes.
7. RED interop — E1: HEAD tree holds `\xff.txt` (via `stageRaw` + commit) and `\uFEFFb` (real file);
   `git rm --cached` both; tsgit `repo.reset({ mode: 'mixed', rev: 'HEAD' })`; `lsFilesPathHex`
   lists `efbbbf62` and `ff2e747874`. Fails before step 6: `efbfbd2e747874`.
   F3 (derived, R8): commit 1 `stageRaw` `\xff/x` blob a plus `y`; commit 2 changes `\xff/x` to blob b;
   tsgit `reset --mixed HEAD~1`; `git write-tree` equals `git rev-parse HEAD~1^{tree}` and
   `lsFilesPathHex` lists `ff2f78` with blob a. Fails before step 6: the entry is rewritten as
   `efbfbd2f78`.
8. REFACTOR — keep `nextFrameEntry` / `buildChildPrefix` under 20 lines.

### Gate
```sh
rm -rf .wireit
npx vitest run test/unit/application/primitives/walk-tree.test.ts test/unit/application/primitives/walk-tree.properties.test.ts test/unit/application/primitives/build-index-from-tree.test.ts test/unit/application/commands/reset.test.ts
PATH=$HOME/.local/git-2.55.0/bin:$PATH npx vitest run test/integration/index-path-bytes-interop.test.ts
npm run check:types
./node_modules/.bin/biome check src/application/primitives/walk-tree.ts src/application/primitives/build-index-from-tree.ts test/unit/application/primitives/walk-tree.test.ts test/unit/application/primitives/walk-tree.properties.test.ts test/unit/application/primitives/build-index-from-tree.test.ts test/integration/index-path-bytes-interop.test.ts
npm run check:spelling
```

### Commit
`fix(reset): carry raw tree name bytes into rebuilt index entries`

## Part 15 — Raw path bytes through checkout materialization

### Context
- `src/application/primitives/compute-changeset.ts` — PUBLIC `ChangesetEntry` (line 12) gains
  `readonly pathBytes?: Uint8Array` (doc: raw path bytes when `path` does not re-encode to them; the
  working-tree write still uses `path`). Its own `TargetEntry` (line 33) gains `pathBytes?`;
  `IndexProjection` (line 39) carries `path` and `pathBytes?`; `projectIndex` / `projectTarget`
  (lines 44-58) key by `indexPathKey`; `computeChangeset` (line ~100) iterates the union of keys
  (sorted as strings, so UTF-8 order is unchanged and lossy keys sort first); `classify` takes the
  key's projections and copies `path` / `pathBytes` (absent key when undefined) from the target, or
  from the index side for a delete.
- `src/application/primitives/apply-changeset.ts` — `buildIndexEntry` (line 268) takes the changeset
  entry's `pathBytes` and sets it only when defined; `applyWriteEntry` (line 305) passes it. The
  file is still written under `entry.path` (fs I/O of raw names is out of scope).
- `src/application/primitives/materialize-tree.ts` — `TargetEntry` (line 92) gains `pathBytes?`;
  `collectTargetEntries` (line 98) walks with `walkTreeWithLossyBytes`; `indexEntriesByPath`,
  `writtenEntriesByPath` (lines 110-125) key by `indexPathKey`; `pickEntry` (line 135) takes the target
  entry and looks up `indexPathKey(entry)`; `plan.excluded.map(skipWorktreeEntry)` carries bytes.
  `filterByPaths`, `preserveOutOfScope`, `checkoutDirection` STAY on the string view (user pathspec
  scope; DC-1).
- `test/unit/application/primitives/compute-changeset.test.ts`.
- `test/unit/application/primitives/materialize-tree.test.ts` (memory adapter; covers
  `apply-changeset`'s new branch end to end).
- `reports/api.json` — regenerate with `npm run docs:json` (public `ChangesetEntry` field).

### TDD steps
1. RED `compute-changeset.test.ts` — Given an index holding L and a target holding U, When
   `computeChangeset`, Then the entries are a `delete` of L (with `pathBytes ff2e747874`) and an
   `add` of U (no `pathBytes` key). Fails: both project to `'\uFFFD.txt'` and classify as one
   `update`.
2. RED `compute-changeset.test.ts` — Given an empty index and a target holding L, Then the `add` entry
   carries L's `pathBytes`. Fails: no field.
3. GREEN — compute-changeset changes.
4. RED `materialize-tree.test.ts` — Given an empty index and a target tree holding `d/\xff` and `d/y`,
   When `materializeTree`, Then `newIndexEntries` hold `d/y` and an entry with `pathBytes 64 2f ff`.
   Fails: the target walk yields no bytes and the written entry is built from the decoded path.
   Given a target holding both L and U, Then two index entries come back. Fails: keyed maps collapse.
5. GREEN — materialize-tree and apply-changeset changes.
6. GUARD — existing materialize/checkout suites stay green; `npm run docs:json` regenerates
   `reports/api.json`.
7. REFACTOR — none.

### Gate
```sh
rm -rf .wireit
npx vitest run test/unit/application/primitives/compute-changeset.test.ts test/unit/application/primitives/materialize-tree.test.ts test/unit/application/primitives/apply-changeset.test.ts test/unit/application/commands/checkout.test.ts
npm run check:types
./node_modules/.bin/biome check src/application/primitives/compute-changeset.ts src/application/primitives/apply-changeset.ts src/application/primitives/materialize-tree.ts test/unit/application/primitives/compute-changeset.test.ts test/unit/application/primitives/materialize-tree.test.ts
npm run check:spelling
npm run docs:json && git diff --stat reports/api.json
```

### Commit
`fix(checkout): carry raw tree name bytes into materialized index entries`

## Decision candidates

| # | Choice | Alternatives (≤3) | Recommendation | Why |
|---|---|---|---|---|
| DC-1 | Sweep sites whose counterpart is another string-pathed source: status `stage0Map`/`collectStagedKinds` (status.ts:225, 401), clean-work-tree `stagedDirty` (clean-work-tree.ts:40 compares against `flattenTree` string keys), find-would-overwrite `stage0ByPath` (find-would-overwrite.ts:88, looked up by merge outcome paths), materialize `filterByPaths`/`preserveOutOfScope` (user pathspec scope), add `indexRules`, smudge `IsVerified`, `stage0Entry`. Design §D5.2 lists some of them for keys. | **A** leave them on the decoded view: both sides of each comparison stay string-pathed, so a lossy entry still meets its own counterpart; behaviour for lossy entries is today's (already reported as missing/dirty because the fs port cannot address raw names). **B** convert only the index side as §D5.2 reads: a lossy entry then never matches its HEAD/merge/pathspec counterpart (e.g. clean-work-tree reports a spurious staged deletion and refuses on a clean repo). **C** convert both sides: `flattenTree`, `diffIndexAgainstTree`, merge outcomes and pathspec resolution carry bytes — a separate design (merge engine and fs port are already out of scope). | **A** | B introduces a refusal on clean repositories that today's code does not have; C is the merge/fs scope the design already excluded. Every write route that can drop or rename an entry is still converted (Parts 7-15). |
| DC-2 | How apply-changeset learns a lossy entry's bytes | **A** additive optional `pathBytes` on the public `ChangesetEntry` (mirrors `IndexEntry.pathBytes`; api.json regenerated in Part 15). **B** keep `ChangesetEntry` unchanged and hand `applyChangeset` an internal key→bytes side map from `materializeTree` (no public change, extra plumbing through `applyChangesetWithAttributes`). | **A** | Same shape as the accepted `IndexEntry.pathBytes` (ADR 968); one field instead of a parallel channel; the design (§D8) already routes bytes through the changeset entry. |

## Shared knowledge — revision (Parts 16+)

<!-- cspell:ignore surrogateescape lstat lstats unlinks unlinked symlinked mkdir repath repathed DCFF DC80 DCC3 DCFE ff7e6d61696e 652fff 6efe 722e747874 642fff 642f78 ff2f78 dotgit protectHFS readlink noncharacter noncharacters characterisation normalise normalises normalised interleaving wildmatch untracked unmerged EILSEQ unstash unstashed subpart xfe xc3 xed xc0 xf4 octopus -->
<!-- cspell:ignore injectivity DBFF DFFF DCAF DCED FFFE FFFDA renormal handback xbfit xffit unloadable caseprobe -->

Source: design `docs/design/index-entry-path-bytes.md` at `212826b0` (§D12 Parts 16-34, §D13-§D19,
decision table DC6-DC17, all decided) and ADRs 973-985. ADR-972's key **encoding** is superseded by
ADR-981; its brand, injectivity, zero UTF-8 cost and "a string lookup never addresses a lossy entry"
carry forward. Parts 1-15 above are landed (`81fa18fb`, gate fixes `61cb592c`, `e0542414`).

**What changed since Parts 1-15.**
- **One key scheme (ADR-981, Part 18a).** `indexPathKey(entry)` returns the escaped path
  (`escapedPathOf(entry)`): `entry.path` for a UTF-8 entry, else `pathBytes` decoded with each byte
  of a rejected sequence mapped to the lone surrogate `U+DC00 + byte` (`\xff.txt` → `'\uDCFF.txt'`).
  The same string is the merge engine's `FlatTree` key and the pathspec matching view, so an engine
  path enters an index map through `keyOfPath(path)` with no conversion. The NUL-prefixed
  description in Shared knowledge above is superseded.
- **Lossy entries never touched on disk (ADR-973, ADR-975; Parts 16, 17, 21, 27, 27b).** A lossy
  entry reads, for every reader, exactly as a tracked entry whose `lstat` failed (its existing
  missing-file branch, reached with no fs call); every write, unlink and leading-directory creation
  for it is skipped; the command succeeds silently and `status` reports it deleted.
- **HFS alias on raw bytes (ADR-978; Parts 22, 22b, 22c, 26).** `verifyPath` / `validateIndexPath`
  take the path bytes; the HFS candidate ends where git's `pick_one_utf8_char` rejects a sequence.
- **Surrogate-escape pathspec view (ADR-980; Parts 19, 19b, 19c, 21).** Every pathspec match against
  an index or tree entry runs on `escapedPathOf(entry)`: a literal from a well-formed string never
  names a lossy entry; `*`, `**` and directory prefixes reach it.
- **Sequential leading-directory phase when a symlink is written (ADR-974, ADR-976; Part 23).**
- **Merge engine carries bytes (ADR-977, ADR-983; Parts 24-33).** Exits first (24-29, identity on
  well-formed strings, no test moves), then one producer group per part (30b, 31, 31b, 32-32c),
  then a phantom brand on the engine input (33, 33b).
- **Public results show the U+FFFD view (ADR-982; Parts 27b, 29, 32, 32b).** Every engine path that
  leaves as public data goes through `viewOfEscaped`; no new public field.
- **Cache-tree component keys are escaped components (ADR-984 = DC16 B; Part 18b).** `latin1` is
  deleted.
- **Lone-surrogate intake normalisation (ADR-985 = DC17 A; Part 18c).** `resolvePathspec` and `mv`
  arguments pass through `wellFormed` (each lone surrogate → U+FFFD) once per argument.

**Order (dependency order, labels keep the design's numbers).**
`16 → 17 → 18 → 18a → 18b → 18c → 19 → 19b → 19c → 22 → 22b → 22c → 20 → 21 → 23 → 24 → 25 → 26 →
27 → 27b → 28 → 29 → 30 → 30a → 30b → 31 → 31b → 32 → 32b → 32c → 33 → 33b → 34`.
Splits not in the design (19c, 22b, 22c, 27b, 30a, 30b, 31b, 32b, 32c, 33b) are forced by the
six-file Context ceiling. Part 22 runs before Part 20 so mv's re-validation (security part) already
passes the bytes to the HFS check. The validation-path switches the design puts in Part 26 for
`merge.ts:1794/1824` move to Part 31 and `stash.ts:667` to Part 27b, the parts where an escaped path
first reaches them (so each switch lands with a test that feeds it one).

**The escape codec (Part 18; read before any later part).**
```ts
// src/domain/objects/encoding.ts (internal: NOT added to src/domain/objects/index.ts)
decodeEscapingInvalid(bytes: Uint8Array): string // valid runs as decodePreservingBom; each byte of a rejected sequence → U+DC00 + byte
encodeEscaped(text: string): Uint8Array          // inverse: a LONE U+DC80..U+DCFF → its byte; everything else UTF-8 (encode)
hasEscapedBytes(text: string): boolean           // /(?<![\uD800-\uDBFF])[\uDC80-\uDCFF]/ — a LONE low surrogate only
wellFormed(text: string): string                 // Part 18c: every lone surrogate → U+FFFD
// src/domain/git-index/index-path-key.ts (internal, no barrel)
isLossy(entry: IndexPath): boolean               // Part 16: entry.pathBytes !== undefined
escapedPathOf(entry: IndexPath): FilePath        // entry.path when pathBytes is undefined, else decodeEscapingInvalid(pathBytes)
indexPathOfEscaped(path: FilePath): IndexPath    // hasEscapedBytes(path) ? indexPathOfBytes(encodeEscaped(path)) : { path }
viewOfEscaped(path: FilePath): FilePath          // hasEscapedBytes(path) ? decodePreservingBom(encodeEscaped(path)) : path
hasBytePrefix(bytes: Uint8Array, prefix: Uint8Array): boolean // Part 20: bytes start with prefix + 0x2f
```
- `decodeEscapingInvalid` algorithm (Python's `surrogateescape`): fast path
  `const view = decodePreservingBom(bytes); if (decodesLosslessly(view, bytes)) return view;`; else walk
  the bytes: at each offset take the length of a well-formed UTF-8 sequence by Unicode Table 3-7
  (`00-7F`; `C2-DF 80-BF`; `E0 A0-BF 80-BF`; `E1-EC|EE-EF 80-BF 80-BF`; `ED 80-9F 80-BF`;
  `F0 90-BF 80-BF 80-BF`; `F1-F3 80-BF ×3`; `F4 80-8F 80-BF 80-BF`), accumulate valid runs and decode
  each run with `decodePreservingBom`; a byte where no well-formed sequence starts becomes
  `String.fromCharCode(0xdc00 + byte)` and the walk advances one byte. Escaping one byte at a time
  equals escaping WHATWG's maximal subpart (its tail bytes are continuation bytes, which never start
  a sequence). Name the table bounds as constants (no magic values).
- `viewOfEscaped` must round-trip through bytes, not replace escapes one by one: WHATWG maps the
  maximal subpart `e2 80` to ONE U+FFFD, so the per-escape replacement would disagree with
  `IndexEntry.path`.
- `indexPathOfEscaped` goes through `indexPathOfBytes` so invariant P holds even for a
  non-canonical escape (`'\uDCC3\uDCA9'` encodes to the valid `c3 a9` and yields `{ path: 'é' }`).
- Invariants every later part keeps: **I1** a well-formed path is its own key, escaped path and view
  (identity, zero allocation); **I2** a lone `U+DC80`-`U+DCFF` never reaches public data, an error
  message or an fs call; **I3** no fs call names a lossy entry's view; **I4** invariant P (above).

**Public-surface decisions (revision).**
- INTERNAL (no barrel entry, no api.json change): every codec function above; `matchesIndexPath`
  (`src/domain/pathspec/matching-path.ts`, imported by module path, not added to
  src/domain/pathspec/index.ts); `validateTreePath` (git-index barrel values are dropped by
  `export type *`); `ensureLeadingDirectories` / `invalidateAll` on the internal `LeadingPathScanner`;
  `cursorNameBytes`; `flattenRawTreeEscaped`, `flattenEscapedTree` (NOT added to
  src/application/primitives/index.ts); `readHeadTreeEscaped`; `diffIndexAgainstTreeKeyed`,
  `groupUnmergedEntriesKeyed` (NOT added to src/domain/diff/index.ts, whose values public-types.ts
  re-exports by name and whose types it re-exports wholesale); `EscapedFlatTree` and
  `mergeEscapedTrees` (NOT added to the diff / merge barrels); `toConflictList` (already exported
  from its internal module).
- PUBLIC types touched: `MaterializeTreeOpts.paths` (Part 19b, TSDoc only under DC-4 A; regenerate
  `reports/api.json`). Public values whose behaviour moves only for escaped input and whose TSDoc is
  NOT edited (no api.json change; verify with `npm run docs:json && git diff --exit-code
  reports/api.json`): `comparePaths`, `sortByPath`, `writeConflictMarkers` (Part 24),
  `conflictsToIndexEntries` (Part 25), `mergeTrees` (Part 33 keeps it on `FlatTree`, DC-6),
  `readHeadTree`, `diffIndexAgainstTree`, `groupUnmergedEntries` (Part 32 keeps the public view
  semantics, DC-5/DC-7). No new error code, command, README count or facade binding anywhere.

**Fixtures and doubles (every revision part).**
- Bytes: L = `ff2e747874` (`\xff.txt`, view `'\uFFFD.txt'`, escaped `'\uDCFF.txt'`); U =
  `efbfbd2e747874` (literal U+FFFD `.txt`); `d/\xff` = `642fff` (escaped `'d/\uDCFF'`); `n\xfe` =
  `6efe`; `\xff/x` = `ff2f78`; `\xff~main` = `ff7e6d61696e`; `e/\xff` = `652fff`; `r.txt` =
  `722e747874`.
- Recording fs: `vi.spyOn(ctx.fs, '<method>')` on a memory context (`createMemoryContext`,
  src/adapters/memory/memory-adapter.ts) for `lstat`, `read`, `exists`, `write`, `writeUtf8`,
  `rm`, `mkdir`, `symlink`; assert `spy.mock.calls.flat()` holds no string containing the view
  `'\uFFFD.txt'` (when U's file is absent from the expectation) and none matching
  `/[\uDC80-\uDCFF]/`. Every suite that spies keeps `afterEach(() => vi.restoreAllMocks())`.
- Interop repo with lossy twins (`seedLossyTwins`, created in Part 16 inside
  test/integration/index-path-bytes-interop.test.ts): real files `z` (`z\n`) and U (`u\n`, written
  with `writeFileSync(path.join(dir, '\uFFFD.txt'))`); `git add z $'\uFFFD.txt'`; `stageRaw` L and
  `d/\xff` with `hashBlob(dir, 'l\n')`; `git commit -q -m seed`. Variant `{ lossyBlob: 'u\n' }`
  makes L's blob equal U's content (S16). Assert git state with `lsFilesPathHex`,
  `git status --porcelain=v2 -z`, `git fsck`.
- Merge interop recipe (Parts 30b-32c, test/integration/merge-path-bytes-interop.test.ts): build
  each side with plumbing (`hash-object -w`, `stageRaw` / `update-index -z --add --index-info`,
  `write-tree`, `commit-tree`, `update-ref`), check out only the UTF-8 files (`read-tree HEAD` +
  `checkout-index -f -- <utf-8 path>`); the oracle is
  `git -c merge.conflictStyle=merge merge-tree --write-tree -z main side` (first NUL field = result
  tree oid; then `<mode> <oid> <stage>\t<path>` records for conflicted paths); tsgit runs the
  porcelain through `openRepository`; assert `lsTreePathHex(dir, 'HEAD')` (or the AUTO_MERGE tree)
  and `git ls-files -s -z` bytes equal the oracle, and `git fsck` exits 0. The macOS porcelain
  column of §D13.5 is not compared (ADR-975).

**Interop rows by part.** test/integration/index-path-bytes-interop.test.ts: 16 = S1, S2/S3, S4,
S10, S16 · 17 = S1b/T2, S12b, S13 · 19 = S6, S7, S7b · 19b = S12 · 19c = S5b (+ S5 under DC-3 B) ·
22b = H rows (§D13.3) · 20 = M1, M2, S9, S9c · 21 = S15 · 32b = status on the clean twin repo ·
32c = S8b. test/integration/checkout-leading-symlink-interop.test.ts (new, Part 23): R1, R2 (only on
a case-insensitive filesystem), R4. test/integration/merge-path-bytes-interop.test.ts (new, Part
30b): 30b = T19, T19b, T23 · 31 = T9-T18 · 31b = T20, T21 · 32c = T22. Every interop gate runs with
`PATH=$HOME/.local/git-2.55.0/bin:$PATH`.

**Files shared between parts (plan-lint locality warnings, deliberate).** Parts 1-15 and the
revision parts touch some files twice because the revision folds review findings into landed code
(each later part is a separate concern, e.g. `index-path-key.ts` gains `isLossy`, the codec, the key
switch and `hasBytePrefix` in the order their consumers land); the two interop files are shared
infrastructure by design; merge.ts, encoding.ts, path-validator.ts and index-diff.ts are split
across parts by the ADR-983 migration order (exits, then producers, then the brand).

**Gate hygiene (revision).** Parts 18, 18c, 22 and 24 add code to the domain chunk, whose size cap
was raised in `e0542414`: their gates also run `rm -rf dist .wireit && npm run build && npm run
check:size`; on a real overflow read every failing row and raise only the failing cap in
`.size-limit.json` to the measured size, in the same commit. Interim exports may stay unconsumed
until the part named in their Context (knip runs at the phase gate). Every part that touches a
public type or TSDoc runs `npm run docs:json` and commits `reports/api.json`; every other part
asserts `git diff --exit-code reports/api.json` after `npm run docs:json` only when its Context
says so. `bench:ab` runs after the commit, never as a commit gate (Part 24).

## Part 16 — Lossy entries read as absent from the working tree

### Context
- `src/domain/git-index/index-path-key.ts` — ADD `export const isLossy = (entry: IndexPath):
  boolean => entry.pathBytes !== undefined;` (consumed here).
- `test/unit/domain/git-index/index-path-key.test.ts` — describe `isLossy` (one test per side).
- `src/application/primitives/compare-working-tree-entry.ts` — `compareAndRefresh` (line 255): first
  statement `if (isLossy(entry)) return { delta: { status: 'absent' } };` (the exact value the
  `lstat`-rejected branch at line 262 returns), before `joinPath`/`lstat`. One chokepoint serves
  `compareWorkingTreeDelta` (270), `compareWorkingTreeEntry` (299) and every caller: status,
  diff, rm's safety valve, internal/clean-work-tree.ts, find-would-overwrite.ts,
  internal/smudge-racily-clean.ts and stash's `classifyEntry` (stash.ts:234 → `projectEntry`
  returns `entry: undefined` for `absent`, so the W tree records the lossy path deleted, S10).
  A lossy entry is never refreshed (the `absent` delta never reaches `shouldRefresh`), so S16 holds.
- `test/unit/application/primitives/compare-working-tree-entry.test.ts` — memory context; write a
  file at `'\uFFFD.txt'` in the work tree; spy `ctx.fs.lstat` and `ctx.fs.read`.
- `src/application/commands/add.ts` — `renormalizeOne` (line 568): replace
  `previous.pathBytes !== undefined` by `isLossy(previous)` and drop the comment above it (the name
  says it). Behaviour unchanged (S4: `PATHSPEC_NO_MATCH`, index unchanged).
- `test/integration/index-path-bytes-interop.test.ts` — new describe "lossy entries on disk" with
  the `seedLossyTwins(git, dir, opts?)` helper (Shared knowledge); rows S1, S2/S3, S4, S10, S16.
- Deferred on purpose: internal/apply-sparse-checkout.ts `partition` (`ctx.fs.exists` +
  `isDirty`, lines 70-92) lands in Part 21 with the other edits of that file.

### TDD steps
1. RED `index-path-key.test.ts` — Given L (`{ path: '\uFFFD.txt', pathBytes: ff2e747874 }`), When
   `isLossy`, Then `true`; Given U (`{ path: '\uFFFD.txt' }`), Then `false`. Fails: `isLossy` is not
   exported (TypeError "isLossy is not a function").
2. GREEN — add `isLossy`.
3. RED `compare-working-tree-entry.test.ts` — Given a lossy entry L (blob of `l\n`) and U's file
   `\uFFFD.txt` (`u\n`) on disk, When `compareAndRefresh(ctx, entry)`, Then the result equals
   `{ delta: { status: 'absent' } }` and the `lstat` spy was never called (`toHaveBeenCalledTimes(0)`).
   Fails: today `lstat` of the view succeeds and the delta is `{ status: 'modified', … }` (pin T1).
4. RED same file — Given L whose blob equals U's file content (`u\n`), When `compareAndRefresh`,
   Then `refreshed` is `undefined` (`'refreshed' in result === false`). Fails: today the view file
   matches, the delta is `unchanged` and `refreshed` carries U's stat (S16).
5. GREEN — the `isLossy` early return in `compareAndRefresh`.
6. GUARD `compare-working-tree-entry.test.ts` — `compareWorkingTreeEntry` on L returns `'absent'`
   (passes: it projects `compareAndRefresh`). The UTF-8 entry U still reports `unchanged` with its
   own stat (passes: the early return keys on `pathBytes` only).
7. REFACTOR `add.ts` — `isLossy(previous)`; GUARD: `npx vitest run test/unit/application/commands/add.test.ts -t renormal`
   stays green.
8. RED interop (each its own `it`, built with `seedLossyTwins`):
   - S1: tsgit `repo.status()`; the record for `d/\uFFFD` and the record for L (`\uFFFD.txt`,
     the one that is not U) report the unstaged change `deleted`, U reports nothing (read the
     record shape in src/application/commands/status.ts). Fails today: L reports `modified`
     against U's file (T1).
   - S2/S3: `repo.add({ all: true })` (read `AddOptions` for the exact flag); `lsFilesPathHex`
     no longer lists `ff2e747874` nor `642fff`. Already green (T3): GUARD row, pin it.
   - S4: `repo.add(['.'], { renormalize: true })` rejects with `data.code === 'PATHSPEC_NO_MATCH'`
     and `lsFilesPathHex` is unchanged. GUARD row (existing guard).
   - S10: modify `z`; `repo.stash.push()` (read `StashNamespace`); `git ls-tree -r -z stash@{0}`
     path hex is `['7a', 'efbfbd2e747874']`. Fails today: the W tree keeps L from the view hash.
   - S16: variant `{ lossyBlob: 'u\n' }`; tsgit `repo.status()`; `readIndex` L entry's
     `mtimeSeconds` and `ctimeSeconds` are still `0` (update-index --index-info zero stat). Fails
     today: status refreshes L with U's stat.
9. REFACTOR — none beyond step 7.

### Gate
```sh
rm -rf .wireit
npx vitest run test/unit/domain/git-index/index-path-key.test.ts test/unit/application/primitives/compare-working-tree-entry.test.ts test/unit/application/commands/add.test.ts test/unit/application/commands/status.test.ts test/unit/application/commands/stash.test.ts
PATH=$HOME/.local/git-2.55.0/bin:$PATH npx vitest run test/integration/index-path-bytes-interop.test.ts
npm run check:types
./node_modules/.bin/biome check src/domain/git-index/index-path-key.ts src/application/primitives/compare-working-tree-entry.ts src/application/commands/add.ts test/unit/domain/git-index/index-path-key.test.ts test/unit/application/primitives/compare-working-tree-entry.test.ts test/integration/index-path-bytes-interop.test.ts
npm run check:spelling
```

### Commit
`fix(status): read lossy index entries as absent from the working tree` — no public type change,
no api.json regeneration.

## Part 17 — Lossy entries are never written or unlinked

### Context
- `src/application/primitives/apply-changeset.ts`:
  - `applyWriteEntry` (line ~305): after the `entry.id === undefined` return, a lossy changeset
    entry (`entry.pathBytes !== undefined`; `ChangesetEntry` is an `IndexPath` structurally, so call
    `isLossy(entry)`) writes nothing and returns
    `{ ...stage0Entry(entry.path, entry.id as ObjectId, entry.mode), pathBytes: entry.pathBytes }`
    (`stage0Entry` from src/application/primitives/internal/synthetic-index-entry.ts: zero stat,
    `STAGE0_FLAGS`). No leading directory is created (the writer is never reached).
  - `applyDeleteEntry` (line ~295): `if (isLossy(entry)) return;` before the scanner call.
  - `evaluateDirtyPath` (line 203): `if (isLossy(entry)) return undefined;` first — a lossy entry is
    absent, so it is never a local change nor an untracked clash (git's up-to-date check passes on
    ENOENT).
- `test/unit/application/primitives/apply-changeset.test.ts` — helpers `makeChangeset`, `makeAdd`,
  `makeDelete`, `makeUpdate` (lines 55-100); extend each with an optional trailing `pathBytes`
  through an options object, not a positional boolean.
- `src/application/commands/rm.ts` — the unlink loop (lines ~108-115) iterates `removedEntries`
  instead of `removed` and skips `isLossy(entry)`; `removed` (the public result) is unchanged.
- `test/unit/application/commands/rm.test.ts`.
- `test/integration/index-path-bytes-interop.test.ts` — rows S1b/T2, S12b, S13.
- Folds design Part 34(d) (rm of a lossy entry by key) as a GUARD here.

### TDD steps
1. RED `apply-changeset.test.ts` — Given a changeset adding L (blob `l\n`, `pathBytes ff2e747874`)
   and U (blob `u\n`), empty work tree, When `applyChangeset`, Then `\uFFFD.txt` holds `u\n`, the
   `write` spy saw exactly one call whose path ends with `'\uFFFD.txt'`, and L's written entry has
   `pathBytes` equal to L's bytes and `mtimeSeconds === 0`, `fileSize === 0`. Fails: today both
   entries write the view (same case-fold group) and L's entry carries the file's stat
   (`mtimeSeconds > 0`).
2. RED same file — Given U's file on disk and a changeset deleting L, When applied, Then
   `\uFFFD.txt` still exists. Fails: `rmIfExists` unlinks the view.
3. RED same file — Given U's file `x\n` on disk and a changeset updating L (`previousId` = blob of
   `l\n`) without `force`, When applied, Then it resolves (no `CHECKOUT_OVERWRITE_DIRTY`). Fails:
   the dirty probe hashes U's file against L's previous id and throws with
   `data.localChanges` `['\uFFFD.txt']`. Same RED for an `add` of L over U's file: today
   `data.untracked` is `['\uFFFD.txt']`.
4. GREEN — the three `isLossy` returns.
5. RED `rm.test.ts` — Given index entries `d/y` and `d/\xff` (lossy) and an untracked file at
   `d/\uFFFD` on disk, When `rm(['d'], { recursive: true, force: true })`, Then both entries leave
   the index, `d/y` is unlinked and `d/\uFFFD` still exists. Fails: the loop unlinks the view
   `d/\uFFFD`.
6. GREEN — rm loop over `removedEntries` skipping lossy ones.
7. GUARD `rm.test.ts` — `rm(['d'], { recursive: true, cached: true })` over `d/y` + `d/\xff` removes
   both entries by key, nothing unlinked (passes: keyed since Part 11; closes Part 34(d)).
8. RED interop:
   - S1b/T2: `seedLossyTwins`; tsgit `repo.reset({ mode: 'hard', rev: 'HEAD' })`; then
     `readFileSync(U)` is `u\n`, `existsSync('d')` is false, `lsFilesPathHex` is unchanged and
     `git status --porcelain=v2 -z` reports `.D` for `642fff` and `ff2e747874`. Fails today: L's
     blob lands in `\uFFFD.txt` and `d/\uFFFD` is written.
   - S12b: modify U; `repo.checkout({ paths: ['*.txt'], source: 'HEAD' })` (read
     `CheckoutPathsOptions`); U holds `u\n` again, no write of L (file content check) and the
     index bytes are unchanged. Fails today: L's blob overwrites U.
   - S13: branch `side` (plumbing) adds `n\xfe`; tsgit `repo.checkout({ rev: 'side' })`; the index
     lists `6efe`, `existsSync('n\uFFFD')` is false, exit success. Fails today: `n\uFFFD` written.
9. REFACTOR — keep `applyWriteEntry` under 20 lines (extract `absentLossyEntry(entry)` if needed).

### Gate
```sh
rm -rf .wireit
npx vitest run test/unit/application/primitives/apply-changeset.test.ts test/unit/application/commands/rm.test.ts test/unit/application/primitives/materialize-tree.test.ts test/unit/application/commands/checkout.test.ts
PATH=$HOME/.local/git-2.55.0/bin:$PATH npx vitest run test/integration/index-path-bytes-interop.test.ts
npm run check:types
./node_modules/.bin/biome check src/application/primitives/apply-changeset.ts src/application/commands/rm.ts test/unit/application/primitives/apply-changeset.test.ts test/unit/application/commands/rm.test.ts test/integration/index-path-bytes-interop.test.ts
npm run check:spelling
```

### Commit
`fix(checkout): never write or unlink a lossy index entry's decoded name` — behaviour only, no
api.json regeneration.

## Part 18 — Surrogate-escape path codec

### Context
- `src/domain/objects/encoding.ts` — ADD next to `decodesLosslessly` (line 99):
  `decodeEscapingInvalid`, `encodeEscaped`, `hasEscapedBytes` (spec and algorithm in Shared
  knowledge). Named constants for the Table 3-7 bounds and `ESCAPE_BASE = 0xdc00`. Each function
  under 20 lines (split the sequence-length lookup into its own function).
- `test/unit/domain/objects/encoding.test.ts` — example tables.
- `test/unit/domain/objects/encoding.properties.test.ts` — CREATE (no sibling exists today).
  Arbitraries: bytes from `fc.uint8Array({ maxLength: 12 })`; well-formed strings from
  `fc.string({ unit: 'grapheme' })`.
- `src/domain/git-index/index-path-key.ts` — ADD `escapedPathOf`, `indexPathOfEscaped`,
  `viewOfEscaped` (Shared knowledge). No caller yet (Part 18a consumes `escapedPathOf`, Part 25
  `indexPathOfEscaped`, Part 27b `viewOfEscaped`).
- `test/unit/domain/git-index/index-path-key.test.ts`.
- `test/unit/domain/git-index/index-path-key.properties.test.ts` — reuse `arbPathBytes`,
  `arbRawPathBytes`, `arbIndexEntryWithPathBytes` from test/unit/domain/git-index/arbitraries.ts.

### TDD steps
1. RED `encoding.test.ts` — `decodeEscapingInvalid` table: `ff 2e 74` → `'\uDCFF.t'`; lone `80` →
   `'\uDC80'`; truncated `c3` → `'\uDCC3'`; overlong `c0 af` → `'\uDCC0\uDCAF'`; surrogate
   `ed a0 80` → `'\uDCED\uDCA0\uDC80'`; `f5` → `'\uDCF5'`; truncated `e2 80 41` → `'\uDCE2\uDC80A'`;
   `ef bf be` → `'\uFFFE'` (valid, kept); `ef bf bd` → `'\uFFFD'`; `ef bb bf 61` → `'\uFEFFa'`;
   `f0 90 82 80` → `'\u{10080}'` (astral kept). Fails: not exported.
2. GREEN — `decodeEscapingInvalid`.
3. RED `encoding.test.ts` — `encodeEscaped`: `'\uDCFF.t'` → `ff 2e 74`; `'\u{10080}'` → `f0 90 82 80`
   (the pair's low half `DC80` is not an escape); lone `'\uD800'` → `ef bf bd`; `'\uDC41'` (outside
   DC80-DCFF) → `ef bf bd`. `hasEscapedBytes`: `'\uDCFF'` true, `'a\uDC80'` true, `'\u{10080}'` false,
   `'\uDC41'` false, `'\uFFFD'` false, `''` false. Fails: not exported.
4. GREEN — `encodeEscaped`, `hasEscapedBytes`.
5. Properties `encoding.properties.test.ts` (written after GREEN; additive grammar proofs, they
   pass): for any bytes b, `encodeEscaped(decodeEscapingInvalid(b))` bytes-equals b (200); for any
   well-formed s, `hasEscapedBytes(s)` is false, `decodeEscapingInvalid(encode(s)) === s` and
   `encodeEscaped(s)` bytes-equals `encode(s)` (200); for any bytes b, every ASCII byte at index i
   of b sits in `decodeEscapingInvalid(b)` at the code-unit index equal to the count of code units
   produced by `b.subarray(0, i)` (100).
6. RED `index-path-key.test.ts` — `escapedPathOf(L) === '\uDCFF.txt'`; `escapedPathOf(U) === '\uFFFD.txt'`
   (same instance as `path`); `indexPathOfEscaped('\uDCFF.txt')` equals
   `{ path: '\uFFFD.txt', pathBytes: ff2e747874 }`; `indexPathOfEscaped('a/b')` is `{ path: 'a/b' }`
   with no `pathBytes` key; `indexPathOfEscaped('\uDCC3\uDCA9')` is `{ path: 'é' }` with no key;
   `viewOfEscaped('\uDCE2\uDC80A') === '\uFFFDA'` (one replacement for the maximal subpart);
   `viewOfEscaped('a/b')` returns the input. Fails: not exported.
7. GREEN — the three `index-path-key.ts` functions.
8. Properties `index-path-key.properties.test.ts`: `indexPathOfEscaped(escapedPathOf(e))` deep-equals
   `{ path: e.path, ...(e.pathBytes && { pathBytes: e.pathBytes }) }` for `e` from
   `arbIndexEntryWithPathBytes` projected to `IndexPath` (100); `escapedPathOf` injective over two
   `arbPathBytes` (100); `viewOfEscaped(escapedPathOf(indexPathOfBytes(b))) === indexPathOfBytes(b).path`
   (200). Pass after GREEN.
9. REFACTOR — none.

### Gate
```sh
rm -rf .wireit
npx vitest run test/unit/domain/objects/encoding.test.ts test/unit/domain/objects/encoding.properties.test.ts test/unit/domain/git-index/index-path-key.test.ts test/unit/domain/git-index/index-path-key.properties.test.ts
npm run check:types
./node_modules/.bin/biome check src/domain/objects/encoding.ts src/domain/git-index/index-path-key.ts test/unit/domain/objects/encoding.test.ts test/unit/domain/objects/encoding.properties.test.ts test/unit/domain/git-index/index-path-key.test.ts test/unit/domain/git-index/index-path-key.properties.test.ts
npm run check:spelling
rm -rf dist .wireit && npm run build && npm run check:size
```

### Commit
`refactor(index): add the surrogate-escape path codec` — internal only, no api.json change.

## Part 18a — The index key is the escaped path

### Context
- `src/domain/git-index/index-path-key.ts` — `indexPathKey` becomes
  `escapedPathOf(entry) as string as IndexPathKey`; delete `LOSSY_KEY_PREFIX` and its comment.
  `latin1` stays (Part 18b deletes it). `keyOfPath`, `pathBytesOf`, `indexPathOfBytes`,
  `splitAtSlash` unchanged.
- `test/unit/domain/git-index/index-path-key.test.ts` — "documented scheme" test (line 19-35): the
  lossy key becomes `'\uDCFF.txt'`.
- `test/unit/domain/git-index/index-path-key.properties.test.ts` — keep the bytes ⇔ key property;
  add the three ADR-981 properties.
- `src/application/commands/internal/unstage-changes-unless-new.ts` — `utf8AncestorKeys` (38),
  `lossyAncestorKeys` (43) and the branching `ancestorKeys` (49) become one
  `ancestorKeys(entry)` running today's `utf8AncestorKeys` loop over `indexPathKey(entry)`; drop
  `SLASH_BYTE` (13) and the `indexPathOfBytes` / `pathBytesOf` imports.
- `test/unit/application/commands/internal/unstage-changes-unless-new.test.ts` — existing lossy test
  near line 206.
- `src/application/commands/commit.ts` — `componentKey` (line 412): the byte arm becomes
  `decodeEscapingInvalid(name)` (closes design Part 34(g)); drop the `indexPathKey` and `FilePath`
  imports if nothing else in the file uses them. Injective against the string arm: `componentsOf`
  (404) keeps bytes only for a component that does not round-trip, whose escaped form holds a lone
  surrogate no string component has.
- No other site changes: every other `indexPathKey` user treats the key as opaque.
  `compute-changeset.ts:130` sorts bare keys; only the order of lossy entries in the internal
  `Changeset.entries` moves, and compute-changeset.test.ts asserts by `find`.

### TDD steps
1. RED `index-path-key.test.ts` — documented scheme: L's key is `'\uDCFF.txt'`; new: the key of
   `indexPathOfBytes(642fff)` cut at its `/` equals `indexPathKey({ path: 'd' })`;
   `keyOfPath('\uDCFF.txt' as FilePath)` equals L's key. Fails: today L's key is
   `'\0\xff.txt'` (`String.fromCharCode(0, 0xff, …)`).
2. GREEN — new `indexPathKey` body.
3. Properties (pass after GREEN): (1) for b from `arbRawPathBytes()` and well-formed s,
   `indexPathKey(indexPathOfBytes(b)) !== keyOfPath(s)` (100); (2) `encodeEscaped(indexPathKey(
   indexPathOfBytes(b)))` bytes-equals b for `arbPathBytes()` (200); (3) for the k-th `0x2f` of b at
   byte `at`, the key cut before its k-th `/` equals `indexPathKey(indexPathOfBytes(b.subarray(0,
   at)))` (100).
4. GUARD `unstage-changes-unless-new.test.ts` — a kept new `\xff/x` drops a restored lossy file
   `\xff` and keeps a restored U file `\uFFFD`; a kept new `d/\xff` drops a restored `d` (passes:
   the byte-cut branch already computes these; written before the REFACTOR so it guards it).
5. REFACTOR `unstage-changes-unless-new.ts` — single `ancestorKeys`; GUARD step 4 and the suite stay
   green.
6. REFACTOR `commit.ts` — `componentKey` via `decodeEscapingInvalid`; GUARD: the commit suite and the
   interop rows A4, B4 stay green.

### Gate
```sh
rm -rf .wireit
npx vitest run test/unit/domain/git-index/index-path-key.test.ts test/unit/domain/git-index/index-path-key.properties.test.ts test/unit/application/commands/internal/unstage-changes-unless-new.test.ts test/unit/application/commands/commit.test.ts test/unit/application/primitives/compute-changeset.test.ts test/unit/domain/git-index
PATH=$HOME/.local/git-2.55.0/bin:$PATH npx vitest run test/integration/index-path-bytes-interop.test.ts
npm run check:types
./node_modules/.bin/biome check src/domain/git-index/index-path-key.ts src/application/commands/internal/unstage-changes-unless-new.ts src/application/commands/commit.ts test/unit/domain/git-index/index-path-key.test.ts test/unit/domain/git-index/index-path-key.properties.test.ts test/unit/application/commands/internal/unstage-changes-unless-new.test.ts
npm run check:spelling
```

### Commit
`refactor(index): key lossy index entries by their escaped path` — internal key, no api.json change.

## Part 18b — Cache-tree component keys are escaped components

### Context
- `src/domain/git-index/cache-tree.ts` — `componentKeysOf` (100-103) becomes
  `indexPathKey(entry).split('/')`; `keyOfChild` (81-82) becomes
  `child.nameBytes === undefined ? child.path : decodeEscapingInvalid(child.nameBytes)`; delete
  `NON_ASCII` (76) and `keyOfComponent` (78); drop the `latin1`, `splitAtSlash` and `encode`
  imports (keep `hexToBytes`); the comment at 71-75 says children match by their escaped name.
  Correct because a child without `nameBytes` has a `path` that re-encodes to its name (#317 rule)
  and a BOM child carries `nameBytes`, whose escaped decode keeps U+FEFF as the entry component
  does.
- `src/domain/git-index/index-path-key.ts` — delete `latin1` (no other src user after this part;
  `splitAtSlash` stays for commit.ts:407).
- `test/unit/domain/git-index/cache-tree.test.ts`.
- `test/unit/domain/git-index/cache-tree.properties.test.ts` — selector at lines 198-211 uses
  `latin1`: switch to `decodeEscapingInvalid`.
- `test/unit/domain/git-index/index-path-key.test.ts` — remove the `latin1` describe (~line 169)
  and its import.
- Perf (ADR-979, no bench covers `invalidateCacheTree`): before the GREEN, time
  `invalidateCacheTree` over 10 000 changed UTF-8 paths with a throwaway script in the session
  scratchpad (never committed), repeat after; report both medians in the handback.

### TDD steps
1. GUARD `cache-tree.test.ts` — sibling subtrees `\xff` and `\xef\xbf\xbd` (both carry
   `nameBytes`): a change under `\xff/x` invalidates only `\xff`, a change under `\uFFFD/x` (U)
   only `\xef\xbf\xbd`; a BOM child `\uFEFFa` is invalidated by a change under `\uFEFFa/x`;
   `namesEachSubtreeOnce` over the twins (passes: the latin1 scheme is injective too; these pin the
   behaviour across the key swap).
2. REFACTOR `cache-tree.ts` + delete `latin1`; the step-1 tests, cache-tree.test.ts and
   cache-tree.properties.test.ts (selector switched) stay green.
3. GUARD — interop rows F1-F3 stay green.

### Gate
```sh
rm -rf .wireit
npx vitest run test/unit/domain/git-index/cache-tree.test.ts test/unit/domain/git-index/cache-tree.properties.test.ts test/unit/domain/git-index/index-path-key.test.ts test/unit/domain/git-index/carry-extensions.test.ts
PATH=$HOME/.local/git-2.55.0/bin:$PATH npx vitest run test/integration/index-path-bytes-interop.test.ts
npm run check:types
./node_modules/.bin/biome check src/domain/git-index/cache-tree.ts src/domain/git-index/index-path-key.ts test/unit/domain/git-index/cache-tree.test.ts test/unit/domain/git-index/cache-tree.properties.test.ts test/unit/domain/git-index/index-path-key.test.ts
npm run check:spelling
```

### Commit
`refactor(index): key cache-tree components by their escaped name` — internal, no api.json change.

## Part 18c — Caller path strings never equal a lossy key

### Context
- `src/domain/objects/encoding.ts` — ADD `wellFormed(text: string): string`: replaces each lone
  surrogate with U+FFFD through one global regex
  (`/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g`); returns the input
  instance when nothing matches. `String.prototype.toWellFormed` is outside the ES2022 lib in
  tsconfig.json.
- `test/unit/domain/objects/encoding.test.ts`.
- `src/application/commands/internal/resolve-pathspec.ts` — `resolvePathspec(patterns)` (line 56):
  first statement `const wellFormedPatterns = patterns.map(wellFormed);` and every later use reads
  it (collapse, budget, `spellLiterals`). Serves add, rm, checkout, grep.
- `test/unit/application/commands/internal/resolve-pathspec.test.ts`.
- `src/application/commands/mv.ts` — normalise each source and the destination once, before
  `validateMove` / `classifySource` (line 231) see them (find the argument intake in `mv`, line
  100, and `buildPlan`, line 176).
- `test/unit/application/commands/mv.test.ts`.

### TDD steps
1. RED `encoding.test.ts` — `wellFormed('\uDCFF.txt') === '\uFFFD.txt'`; lone high
   `'a\uD800b'` → `'a\uFFFDb'`; a valid pair `'\u{1F600}'` kept; `'\uFEFFa'` kept; well-formed input
   returns the same string. Fails: not exported.
2. GREEN — `wellFormed`.
3. RED `resolve-pathspec.test.ts` — `resolvePathspec(['\uDCFF.txt']).literalMustMatch` equals
   `['\uFFFD.txt']`. Fails: today the literal keeps the lone surrogate.
4. GREEN — normalise in `resolvePathspec`.
5. RED `mv.test.ts` — Given index L and U with U's file on disk, When `mv(['\uDCFF.txt'], 'x')`,
   Then `moved` names U → `x`, and `readIndex` still holds L with `pathBytes ff2e747874` at its old
   path. Fails: under Part 18a `keyOfPath('\uDCFF.txt')` hits L exactly, the on-disk check of the
   lone-surrogate name finds nothing and mv rejects with the bad-source refusal (`mvBadSource`).
6. GREEN — normalise in `mv`.
7. REFACTOR — none.

### Gate
```sh
rm -rf .wireit
npx vitest run test/unit/domain/objects/encoding.test.ts test/unit/application/commands/internal/resolve-pathspec.test.ts test/unit/application/commands/mv.test.ts test/unit/application/commands/add.test.ts test/unit/application/commands/rm.test.ts
npm run check:types
./node_modules/.bin/biome check src/domain/objects/encoding.ts src/application/commands/internal/resolve-pathspec.ts src/application/commands/mv.ts test/unit/domain/objects/encoding.test.ts test/unit/application/commands/internal/resolve-pathspec.test.ts test/unit/application/commands/mv.test.ts
npm run check:spelling
rm -rf dist .wireit && npm run build && npm run check:size
```

### Commit
`fix(pathspec): normalise lone surrogates in caller paths to the replacement character` — no
public type change, no api.json regeneration. Interop: none (argv cannot carry a lone surrogate).

## Part 19 — Pathspec matching view for rm

### Context
- `src/domain/pathspec/matching-path.ts` — CREATE (internal; not added to
  src/domain/pathspec/index.ts): `export const matchesIndexPath = (spec: Pathspec, entry:
  IndexPath): boolean => matchesPathspec(spec, escapedPathOf(entry));` (imports
  ./match-pathspec.js and ../git-index/index-path-key.js; domain → domain is allowed by
  .dependency-cruiser.cjs).
- `test/unit/domain/pathspec/matching-path.test.ts` — CREATE.
- `test/unit/domain/pathspec/matching-path.properties.test.ts` — CREATE (compile specs with
  `compilePathspec` from the pathspec barrel).
- `src/application/commands/rm.ts` — line 95 `matchesPathspec(matcher, entry.path)` →
  `matchesIndexPath(matcher, entry)`. The HEAD lookup of the safety valve (204-213) is Part 32c.
- `test/unit/application/commands/rm.test.ts`.
- `test/integration/index-path-bytes-interop.test.ts` — rows S6, S7, S7b.

### TDD steps
1. RED `matching-path.test.ts` — Given spec `['\uFFFD.txt']` (literal), When matching L, Then
   `false`; U → `true`; spec `['*.txt']` matches both; spec `['d']` matches `d/\xff`
   (`{ path: 'd/\uFFFD', pathBytes: 642fff }`); spec `['?.txt']` matches L (one escaped unit = one
   byte). Fails: module does not exist.
2. GREEN — create the module.
3. Properties `matching-path.properties.test.ts` (pass after GREEN): for a UTF-8 entry the verdict
   equals `matchesPathspec(spec, entry.path)` (100); for b from `arbRawPathBytes()` no literal spec
   compiled from a well-formed string (`fc.string({ unit: 'grapheme' })` filtered to valid pathspec
   bodies) matches `indexPathOfBytes(b)` (50); `['*']` matches every lossy entry whose bytes hold no
   `0x2f` and `['**']` every lossy entry (100).
4. RED `rm.test.ts` — Given L and U tracked (both committed in HEAD, files absent/present per
   fixture), When `rm(['\uFFFD.txt'], { cached: true })`, Then `removed` is `['\uFFFD.txt']` once
   and `readIndex` still holds L (`pathBytes ff2e747874`). Fails: the view match selects both (S6).
   And When `rm(['\uDCFF.txt'], { cached: true })`, Then L stays (DC17, Part 18c normalises to U).
5. GREEN — `rm.ts` line 95.
6. RED interop — S6: `seedLossyTwins`; tsgit `repo.rm(['\uFFFD.txt'], { cached: true })`;
   `lsFilesPathHex` keeps `ff2e747874`, drops `efbfbd2e747874`. Fails before step 5. GUARD rows: S7
   `rm(['*.txt'], { cached: true })` removes both (passes today, T6); S7b `rm(['d'], { cached: true,
   recursive: true })` removes `642fff` (passes).
7. REFACTOR — none.

### Gate
```sh
rm -rf .wireit
npx vitest run test/unit/domain/pathspec/matching-path.test.ts test/unit/domain/pathspec/matching-path.properties.test.ts test/unit/application/commands/rm.test.ts
PATH=$HOME/.local/git-2.55.0/bin:$PATH npx vitest run test/integration/index-path-bytes-interop.test.ts
npm run check:types
./node_modules/.bin/biome check src/domain/pathspec/matching-path.ts src/application/commands/rm.ts test/unit/domain/pathspec/matching-path.test.ts test/unit/domain/pathspec/matching-path.properties.test.ts test/unit/application/commands/rm.test.ts test/integration/index-path-bytes-interop.test.ts
npm run check:spelling
```

### Commit
`fix(rm): match pathspecs against the escaped view of lossy entries` — internal, no api.json change.

## Part 19b — Key-scoped restore

### Context
- `src/application/commands/checkout.ts` — `pathRestore` (319-366): `enumerateSourcePaths` (443)
  returns `IndexPath[]` (the index source maps entries to `{ path, pathBytes? }`; the tree source
  walks with `walkTreeWithLossyBytes`, src/application/primitives/walk-tree.ts); `matched` filters
  with `matchesIndexPath` (Part 19); `enforceLiteralMustMatch` receives `matched.map((e) =>
  e.path)`; `pathSet` becomes `new Set(matched.map(escapedPathOf))` typed
  `ReadonlySet<FilePath>` (DC-4 A); the two `materialize…` helpers (372, 402) keep their
  `ReadonlySet<FilePath>` parameter.
- `src/application/primitives/materialize-tree.ts` — PUBLIC `MaterializeTreeOpts.paths` (line 61)
  keeps its type `ReadonlySet<FilePath>`; its TSDoc gains one sentence: "A path selects the entry
  whose raw name it encodes; a well-formed path never selects an entry whose raw name is not
  UTF-8." `filterByPaths` (114) tests `paths.has(escapedPathOf(e))`; `preserveOutOfScope` (136) and
  the use near 288 likewise. Target entries carry `pathBytes` since Part 15.
- src/application/commands/internal/pull-into-void.ts (read-only here) — line 47 keeps
  `new Set(target.entries.keys())` (a view key today, an escaped key once Part 31b flips its
  flatten: one scheme either way, ADR-981); no edit unless check:types asks.
  Transient until Part 31b: an unborn-branch pull whose target holds a lossy name scopes the
  materialize with view keys, which cannot name that entry, so it is left out of the new index;
  Part 31b's escaped flatten closes it. Both land in one PR, so no release carries the window.
- `test/unit/application/commands/checkout.test.ts`.
- `test/unit/application/primitives/materialize-tree.test.ts`.
- `test/integration/index-path-bytes-interop.test.ts` — row S12.
- `reports/api.json` — regenerate (`npm run docs:json`): the `paths` TSDoc changed.

### TDD steps
1. RED `materialize-tree.test.ts` — Given an index holding L and U and a target tree holding both
   (U changed), When `materializeTree` with `paths: new Set(['\uFFFD.txt'])`, Then L's index entry
   keeps its id and `pathBytes`, and U is updated. Fails: `filterByPaths` matches both views, so L
   is rewritten from the target.
2. GREEN — `filterByPaths` / `preserveOutOfScope` on `escapedPathOf`.
3. RED `checkout.test.ts` — Given L and U staged and U modified on disk, When
   `checkout({ paths: ['\uFFFD.txt'], source: 'HEAD' })`, Then U is restored and L's entry and bytes
   are unchanged. Fails: the view universe puts L in scope (deletes or refuses
   `CHECKOUT_OVERWRITE_DIRTY`, S12).
4. GREEN — `pathRestore` / `enumerateSourcePaths`.
5. RED interop S12: modify U; `repo.checkout({ paths: ['\uFFFD.txt'], source: 'HEAD' })` resolves;
   `lsFilesPathHex` unchanged; U holds `u\n`. Fails before step 4.
6. GUARD — pull.test.ts stays green (pull-into-void has no unit suite).
7. REFACTOR — none; `npm run docs:json`.

### Gate
```sh
rm -rf .wireit
npx vitest run test/unit/application/commands/checkout.test.ts test/unit/application/primitives/materialize-tree.test.ts test/unit/application/commands/pull.test.ts
PATH=$HOME/.local/git-2.55.0/bin:$PATH npx vitest run test/integration/index-path-bytes-interop.test.ts
npm run check:types
./node_modules/.bin/biome check src/application/commands/checkout.ts src/application/primitives/materialize-tree.ts test/unit/application/commands/checkout.test.ts test/unit/application/primitives/materialize-tree.test.ts test/integration/index-path-bytes-interop.test.ts
npm run check:spelling
npm run docs:json && git diff --stat reports/api.json
```

### Commit
`fix(checkout): scope path restores by index key` — commits the regenerated `reports/api.json`
(TSDoc of the public `MaterializeTreeOpts.paths`). Under DC-4 B the type becomes
`ReadonlySet<IndexPathKey>` with `IndexPathKey` exported publicly instead (same api.json step).

## Part 19c — add pathspecs on the escaped view

### Context
- `src/application/commands/add.ts` — `isRecleaned` (line 530-534): `matchesPathspec(matcher,
  entry.path)` → `matchesIndexPath(matcher, entry)`. The walk filter `withPathspec` (612-617) stays
  on fs strings (the walk never yields a lossy name).
  Under DC-3 B only: `addByPathspec` (452-479) also stages the deletion of every stage-0,
  non-skip-worktree entry that `matchesIndexPath` selects and the walk did not see (reuse
  `collectRemovedEntries`' rules, 740-751, restricted to matched entries) and reports them in
  `removed`, as git ≥ 2.0 does for `add <pathspec>` (pin S5). Proof of today's gap:
  `addByPathspec` returns `removed: []` (line 475) for every path, UTF-8 included.
- `test/unit/application/commands/add.test.ts`.
- `test/integration/index-path-bytes-interop.test.ts` — S5b (+ S5 under DC-3 B).

### TDD steps
1. RED `add.test.ts` — Given L and U tracked and U's file on disk, When
   `add(['\uFFFD.txt'], { renormalize: true })`, Then it resolves and the index still holds L with
   its bytes. Fails: `isRecleaned` selects L by view and `renormalizeOne` throws
   `PATHSPEC_NO_MATCH` for `\uFFFD.txt`.
2. GREEN — `isRecleaned` on `matchesIndexPath`.
3. RED interop S5b: modify U; `repo.add(['\uFFFD.txt'])`; U restaged, `lsFilesPathHex` keeps
   `ff2e747874`. GUARD today (literal add walks fs strings; it already keeps L) — pin it.
4. DC-3 B only — RED `add.test.ts`: Given tracked `a.txt` deleted from disk, When `add(['*.txt'])`,
   Then `removed` is `['a.txt']` and the index drops it. Fails: `removed` is `[]`. Then the same with
   L: When `add(['*.txt'])` with U modified, Then L is removed and U restaged (S5). GREEN: the
   deletion pass in `addByPathspec`. Interop S5.
5. REFACTOR — none.

### Gate
```sh
rm -rf .wireit
npx vitest run test/unit/application/commands/add.test.ts test/unit/application/commands/add-clean-order.test.ts
PATH=$HOME/.local/git-2.55.0/bin:$PATH npx vitest run test/integration/index-path-bytes-interop.test.ts test/integration/add-interop.test.ts test/integration/add-all.test.ts
npm run check:types
./node_modules/.bin/biome check src/application/commands/add.ts test/unit/application/commands/add.test.ts test/integration/index-path-bytes-interop.test.ts
npm run check:spelling
```

### Commit
`fix(add): match tracked entries against the escaped pathspec view` (DC-3 B:
`fix(add): stage deletions of tracked paths a pathspec matches`) — no api.json change.

## Part 22 — HFS alias verdict on raw component bytes

### Context
- `src/domain/path/verify-path.ts` (internal: src/domain/path is in no public barrel):
  - `verifyPath(path, mode)` (line ~217) gains a third parameter `pathBytes?: Uint8Array`; when
    defined, `splitAtSlash(pathBytes)` (src/domain/git-index/index-path-key.ts; no import cycle:
    index-path-key imports only the objects encoding module) gives one byte slice per
    `path.split('/')` component (same count: ASCII slash positions agree, §D2). Thread the slice to
    `findComponentRejection` → `matchAliasComponent` (115) → `matchAliasPart` (68) and to
    `hasGitmodulesSymlinkComponent` → `matchGitmodulesAliasPart` (189).
  - NEW pure `gitPickerValidPrefix(bytes: Uint8Array): number` — offset of the first sequence git's
    `pick_one_utf8_char` rejects (C0/C1 lead, stray continuation `80-BF`, `E0` + `<A0`, `ED` +
    `A0-BF`, `EF BF BE`, `EF BF BF`, `F0` + `<90`, `F4` + `>=90`, `F5-FF`, truncated), else
    `bytes.length` (rules §D13.3, source `utf8.c:122-185`). Named constants for every bound.
  - NEW `hfsCandidate(part: string, partBytes?: Uint8Array): string` (§D17):
    `partBytes === undefined ? part.slice(0, firstNoncharacter(part)) :
    decodePreservingBom(partBytes.subarray(0, gitPickerValidPrefix(partBytes)))`, where
    `firstNoncharacter` is the index of the first U+FFFE/U+FFFF else `part.length`.
  - `matchAliasPart` / `matchGitmodulesAliasPart`: the HFS arm compares
    `normalizeAliasCandidate(stripIgnorableCodepoints(hfsCandidate(part, partBytes)))`; the early
    `!hasIgnorableCodepoint(part)` return now also requires that the candidate equals the part
    (a cut candidate must be compared even without ignorable code points). NTFS and ASCII checks
    stay on the view. `isObviouslyNotAnAlias` (100) stays valid (every target starts with `.` or
    `g`).
- `test/unit/domain/path/verify-path.test.ts`.
- `test/unit/domain/path/verify-path.properties.test.ts` (exists; extend).
- `src/domain/git-index/path-validator.ts` — `validateIndexPath(path, offset, mode)` (line 96)
  gains `pathBytes?: Uint8Array` and forwards it to `verifyPath` (101). Callers pass bytes in
  Parts 22b, 22c, 20, 26.
- `test/unit/domain/git-index/path-validator.test.ts`.

### TDD steps
1. RED `verify-path.test.ts` — one `it` per §D13.3 row, bytes passed as the third argument, mode
   `100644` unless stated: `.git\xff/x`, `.git\xed\xa0\x80/x`, `.git\xc0\xaf`, `.git\xc3/x`,
   `.git\xf4\x90\x80\x80/x`, `.g\xef\xbb\xbfit\xff/x`, `.GiT\xe2\x80\x8c\xff/x`, `a/.git\xff/x`,
   `.git\xff` → `'dotgit-hfs-alias'`; `.gitmodules\xff` and `.gitmodules\xef\xbf\xbe` with mode
   `120000` → the gitmodules-symlink rejection (read its reason constant in the file). Fails: the
   view `.git\uFFFD` is not an alias (verdict `undefined`).
2. RED same file, string arm (no bytes): `'.git\uFFFE/x'` and `'.git\uFFFF/x'` →
   `'dotgit-hfs-alias'`; `'.gitmodules\uFFFE'` mode `120000` → refused. Fails: today accepted.
3. GUARD same file — accepted rows: `.git\xef\xbf\xbd/x` (literal U+FFFD), `.g\xffit/x`,
   `.gitmodules\xff` mode `100644`; `.git\xe2\x80\x8c/x` still `dotgit-hfs-alias` (passes today).
4. GREEN — `gitPickerValidPrefix`, `hfsCandidate`, threading.
5. Properties `verify-path.properties.test.ts` — for component bytes `.git` + X (X from 1-4 bytes
   over `00-ff` minus `2f` and `00`), the verdict is `'dotgit-hfs-alias'` iff
   `gitPickerValidPrefix(X) === 0` or X decodes, up to its first rejected sequence, to HFS-ignorable
   code points only (100). Pass after GREEN.
6. RED `path-validator.test.ts` — `validateIndexPath('.git\uFFFD/x', 0, '100644', bytes(.git\xff/x))`
   throws with `data.reason === "'.git' HFS+ ignorable-codepoint alias rejected"` (try/catch on
   `data`). Fails: the fourth argument is ignored (no throw).
7. GREEN — forward `pathBytes`.
8. REFACTOR — keep `matchAliasPart` under 20 lines (extract `hfsAlias(part, partBytes)`).

### Gate
```sh
rm -rf .wireit
npx vitest run test/unit/domain/path/verify-path.test.ts test/unit/domain/path/verify-path.properties.test.ts test/unit/domain/git-index/path-validator.test.ts test/unit/domain/git-index
npm run check:types
./node_modules/.bin/biome check src/domain/path/verify-path.ts src/domain/git-index/path-validator.ts test/unit/domain/path/verify-path.test.ts test/unit/domain/path/verify-path.properties.test.ts test/unit/domain/git-index/path-validator.test.ts
npm run check:spelling
rm -rf dist .wireit && npm run build && npm run check:size
```

### Commit
`fix(index): read raw component bytes in the HFS alias check` — internal, no api.json change.

## Part 22b — HFS bytes at parse and tree synthesis

### Context
- `src/domain/git-index/index-parser.ts` — the entry loop's `validateIndexPath(path, entryStart,
  mode)` (line ~128) passes the entry's `pathBytes` (the `rawPath.slice()` computed for a lossy
  entry; `undefined` otherwise).
- `test/unit/domain/git-index/index-parser.test.ts` — `buildTestIndex` takes `Uint8Array` paths
  (Part 2).
- `src/application/primitives/synthesize-tree-from-index.ts` — `validateIndexPath(entry.path,
  NO_PARSER_OFFSET, entry.mode)` (line ~90) passes `entry.pathBytes`.
- `test/unit/application/primitives/synthesize-tree-from-index.test.ts`.
- `test/integration/index-path-bytes-interop.test.ts` — H rows.

### TDD steps
1. RED `index-parser.test.ts` — Given an entry with raw path `.git\xff/x`, When `parseIndex`, Then it
   throws `INVALID_INDEX_ENTRY` with the HFS reason. Fails: the view is accepted.
2. GREEN — parser forwards bytes.
3. RED `synthesize-tree-from-index.test.ts` — Given an entry `{ path: '.git\uFFFD/x', pathBytes:
   2e676974ff2f78 }`, When `synthesizeTreeFromIndex`, Then it throws with the HFS reason. Fails:
   accepted.
4. GREEN — synthesize forwards bytes.
5. RED interop H rows — for `.git\xff/x`, `.git\xc0\xaf`, `.git\xef\xbf\xbe/x`: git
   `-c core.protectHFS=false update-index -z --add --index-info` stages it; tsgit
   `readIndex` rejects with `data.code === 'INVALID_INDEX_ENTRY'` and the HFS reason; git
   `-c core.protectHFS=true update-index` on the same input prints `Ignoring path` on stderr
   (refusal parity). `.git\xef\xbf\xbd/x`: both accept (GUARD). Fails before step 2: tsgit accepts.
6. REFACTOR — none.

### Gate
```sh
rm -rf .wireit
npx vitest run test/unit/domain/git-index/index-parser.test.ts test/unit/domain/git-index/index-parser.properties.test.ts test/unit/application/primitives/synthesize-tree-from-index.test.ts
PATH=$HOME/.local/git-2.55.0/bin:$PATH npx vitest run test/integration/index-path-bytes-interop.test.ts
npm run check:types
./node_modules/.bin/biome check src/domain/git-index/index-parser.ts src/application/primitives/synthesize-tree-from-index.ts test/unit/domain/git-index/index-parser.test.ts test/unit/application/primitives/synthesize-tree-from-index.test.ts test/integration/index-path-bytes-interop.test.ts
npm run check:spelling
```

### Commit
`fix(index): pass raw path bytes to the HFS check at parse and tree synthesis` — no api.json change.

## Part 22c — HFS bytes on tree-to-index routes

### Context
- `src/application/primitives/build-index-from-tree.ts` — `projectLeaf` (118):
  `validateIndexPath(leaf.path, NO_PARSER_OFFSET, leaf.mode)` passes `leaf.pathBytes`.
- `test/unit/application/primitives/build-index-from-tree.test.ts` — helpers `writeBlob`,
  `makeIndexEntry`, `EMPTY_INDEX`.
- `src/application/primitives/apply-changeset.ts` — `validateChangesetEntry` (230-234) passes
  `entry.pathBytes`.
- `test/unit/application/primitives/apply-changeset.test.ts`.
- Folds design Part 34(b): the zero-stat rebuild of a lossy leaf with an empty index
  (`zeroStatEntry`, build-index-from-tree.ts:85).

### TDD steps
1. RED `build-index-from-tree.test.ts` — Given a tree holding `.git\xff/x` (written with
   `treeEntry(mode, Uint8Array, id)`), When `buildIndexFromTree`, Then it throws with the HFS reason.
   Fails: accepted.
2. GREEN — forward `leaf.pathBytes`.
3. GUARD `build-index-from-tree.test.ts` — Given an empty index and a tree holding `\xff.txt`, When
   `buildIndexFromTree`, Then the entry has `pathBytes ff2e747874` and every stat field `0`
   (passes since Part 14; closes Part 34(b)).
4. RED `apply-changeset.test.ts` — Given an `add` entry `{ path: '.git\uFFFD/x', pathBytes:
   2e676974ff2f78 }`, When `applyChangeset`, Then it throws with the HFS reason and nothing is
   written. Fails: validation runs on the view (and the write is skipped silently since Part 17).
5. GREEN — forward `entry.pathBytes`.
6. REFACTOR — none.

### Gate
```sh
rm -rf .wireit
npx vitest run test/unit/application/primitives/build-index-from-tree.test.ts test/unit/application/primitives/apply-changeset.test.ts test/unit/application/commands/reset.test.ts
npm run check:types
./node_modules/.bin/biome check src/application/primitives/build-index-from-tree.ts src/application/primitives/apply-changeset.ts test/unit/application/primitives/build-index-from-tree.test.ts test/unit/application/primitives/apply-changeset.test.ts
npm run check:spelling
```

### Commit
`fix(checkout): pass raw tree name bytes to the HFS check on tree-to-index routes` — no api.json
change.

## Part 20 — mv: byte-prefix members, re-validation, absent lossy members

### Context
- `src/domain/git-index/index-path-key.ts` — ADD `hasBytePrefix(bytes: Uint8Array, prefix:
  Uint8Array): boolean` next to `splitAtSlash`: `bytes.length > prefix.length`, the first
  `prefix.length` bytes equal `prefix` and `bytes[prefix.length] === SLASH` (reuse the existing
  `SLASH` constant).
- `test/unit/domain/git-index/index-path-key.test.ts`.
- `src/application/commands/mv.ts`:
  - `classifySource` (231-241): `exact` stays `byPath.get(keyOfPath(source))` (source already
    normalised, Part 18c); directory members are entries with `hasBytePrefix(pathBytesOf(entry),
    encode(source))` instead of `entry.path.startsWith(prefix)`. `movedPath` (322) then cuts at a
    real component boundary.
  - `applyToIndex` (307-318): before `byPath.set`, `validateIndexPath(moved.path,
    NO_PARSER_OFFSET, moved.mode, moved.pathBytes)` (Part 22 signature; import from
    src/domain/git-index/path-validator.ts).
  - `validateMove` (203-224): for a `directory` source holding a lossy member (`isLossy`), without
    `skipErrors` return a `bad-source` verdict that names the member: the `Verdict` skip variant
    (line 92) gains optional `source` / `target` (the member's view `d/\uFFFD` and its moved view
    `e/\uFFFD`) so `refusal` (334) builds `mvBadSource(memberView, movedView)` as git's
    `bad source, source=d/\xff, destination=e/\xff` (M1); with `skipErrors` the lossy members are
    dropped from `entries` (they stay at their old path) and the rest moves (M1 `-k`, S9c). The
    disk rename still moves the directory as a whole, as git does.
  - A lossy file source never reaches here as `exact` (a caller string cannot name it, Part 18c);
    S9 is a GUARD.
- `test/unit/application/commands/mv.test.ts`.
- `test/integration/index-path-bytes-interop.test.ts` — rows M1, M2, S9, S9c.
- Security (design: HIGH): the cycle-1 repro cut a lossy `\xff/…` path past its slash and re-pathed
  an entry to .git/p; byte membership closes the cut, re-validation is defence in depth.

### TDD steps
1. RED `index-path-key.test.ts` — `hasBytePrefix(ff2f78, ff)` true; `hasBytePrefix(ff2f78, efbfbd)`
   false; `hasBytePrefix(ff, ff)` false (no slash); `hasBytePrefix(ff78, ff)` false. Fails: not
   exported.
2. GREEN — `hasBytePrefix`.
3. RED `mv.test.ts` — security repro: Given a tracked U directory member `\uFFFD/k` (file on disk)
   and a lossy entry `\xff/it/p` (bytes `ff2f69742f70`, view `\uFFFD/it/p`), When
   `mv(['\uFFFD'], '.g')`, Then `moved` is only `\uFFFD/k → .g/k`, the lossy entry keeps its path
   and bytes, and `readIndex` parses (no `INVALID_INDEX_ENTRY`). Fails: today the view selects the
   lossy entry, the 3-byte cut drops `ff 2f` and re-paths it to `.git/p`.
4. RED `mv.test.ts` — M2: Given `\uFFFD/x` (U directory, file on disk) and lossy `\xff/x`, When
   `mv(['\uFFFD'], 'dst')`, Then `moved` is only `\uFFFD/x → dst/x` and `\xff/x` keeps
   `pathBytes ff2f78`. Fails: both move.
5. GREEN — byte membership in `classifySource`.
6. RED `mv.test.ts` — re-validation: Given tracked `x`, When `mv(['x'], '.git\u200c')` (an HFS
   alias), Then it rejects with the HFS reason (`data.reason`) and the index is unchanged. Fails:
   mv never validates a moved path. Run it first: if an argument check already refuses it, the step
   is a GUARD, the re-validation is defence in depth only, and the handback names it as a suspected
   equivalent mutant for the validation phase.
7. GREEN — `validateIndexPath` in `applyToIndex`.
8. RED `mv.test.ts` — M1: Given `d/y` on disk and lossy `d/\xff`, When `mv(['d'], 'e')`, Then it
   rejects with `data.code === 'MV_BAD_SOURCE'`, `data.source === 'd/\uFFFD'`,
   `data.destination === 'e/\uFFFD'`, index unchanged. When `mv(['d'], 'e', { skipErrors: true })`
   (read `MvOptions` for the call shape), Then the index holds `d/\xff` (bytes `642fff`) and `e/y`.
   Fails: today the lossy member moves with the directory.
9. GREEN — lossy-member verdict.
10. RED interop — M1 (`mv d e` refused, index bytes unchanged; `-k` leaves `642fff` and adds
    `652f79`), M2 (index `dst/x` and `ff2f78`), S9c (`mkdir d` only, `d/\xff` staged: refused
    naming the member), S9 (GUARD: `mv(['\uFFFD.txt'], 'y')` moves U only when U exists, never L).
    Fail before steps 5-9.

### Gate
```sh
rm -rf .wireit
npx vitest run test/unit/domain/git-index/index-path-key.test.ts test/unit/application/commands/mv.test.ts
PATH=$HOME/.local/git-2.55.0/bin:$PATH npx vitest run test/integration/index-path-bytes-interop.test.ts test/integration/mv-interop.test.ts
npm run check:types
./node_modules/.bin/biome check src/domain/git-index/index-path-key.ts src/application/commands/mv.ts test/unit/domain/git-index/index-path-key.test.ts test/unit/application/commands/mv.test.ts test/integration/index-path-bytes-interop.test.ts
npm run check:spelling
```

### Commit
`fix(mv): select directory members by path bytes and re-validate moved paths` — no api.json change
(error data shape unchanged).
STOP before commit: hand back the staged diff for the user's security review.

## Part 21 — Sparse-checkout keeps raw path bytes

### Context
- `src/application/commands/internal/apply-sparse-checkout.ts`:
  - `isIncluded` (60-62) takes the entry and runs the `SparseMatcher` on `escapedPathOf(entry)`
    (ADR-980 matching view).
  - `partition` (70-92): a lossy excluded entry is `removable` with `present: false` and no
    `ctx.fs.exists` / `isDirty` call (ADR-973; moved here from Part 16).
  - `deleteEntry` (95), `addEntry` (105), `noopEntry` (115): one `changesetPathOf(entry)` helper
    spreads `path` and, only when defined, `pathBytes` (absent-key rule).
- `test/unit/application/commands/internal/apply-sparse-checkout.test.ts` — DELETE the vacuous spy
  test near line 155 and replace it with an end-to-end unit test without the `applyChangeset`
  mock.
- `test/integration/index-path-bytes-interop.test.ts` — S15 analogue.

### TDD steps
1. RED `apply-sparse-checkout.test.ts` — Given L excluded by the sparse patterns and U's file on
   disk (different content), When the partition runs (through `applySparseCheckout`), Then L is
   removable and the `exists` spy saw no call naming `'\uFFFD.txt'` for L. Fails: today
   `ctx.fs.exists(view)` is true and `isDirty` hashes U's file, so L is retained.
2. GREEN — lossy early arm in `partition`.
3. RED same file — end to end, no mock: L and U tracked, narrow to `z` then widen to everything;
   Then U holds U's blob, the index keeps L with `pathBytes ff2e747874`, and no `write` call names
   the view for L. Fails: `addEntry` drops `pathBytes`, so the widen writes L's blob into U.
4. GREEN — `changesetPathOf` in the three builders.
5. RED same file — a pattern `'\uFFFD.txt'` (literal) includes U and excludes L; `'*.txt'` includes
   both. Fails: the matcher sees L's view.
6. GREEN — `isIncluded` on `escapedPathOf`.
7. RED interop S15 analogue — `seedLossyTwins`; tsgit `repo.sparseCheckout.set(['z'])` then
   `repo.sparseCheckout.disable()` (read `SparseCheckoutNamespace`); `lsFilesPathHex` lists L and
   `d/\xff` with their bytes; U holds `u\n`. Fails before step 4.
8. REFACTOR — none.

### Gate
```sh
rm -rf .wireit
npx vitest run test/unit/application/commands/internal/apply-sparse-checkout.test.ts test/unit/application/commands/sparse-checkout.test.ts
PATH=$HOME/.local/git-2.55.0/bin:$PATH npx vitest run test/integration/index-path-bytes-interop.test.ts
npm run check:types
./node_modules/.bin/biome check src/application/commands/internal/apply-sparse-checkout.ts test/unit/application/commands/internal/apply-sparse-checkout.test.ts test/integration/index-path-bytes-interop.test.ts
npm run check:spelling
```

### Commit
`fix(sparse-checkout): keep raw path bytes through sparse re-shaping` — no api.json change.

## Part 23 — Leading-symlink-safe write wave

### Context
- `src/application/primitives/internal/symlinked-leading-path.ts` — `PrefixShape` (38) becomes
  `'symlink' | 'directory' | 'other' | 'missing'` (`'plain'` split: a regular file at a leading
  prefix must be replaced, not written into); `lstatPrefix` (87) classifies accordingly.
  `LeadingPathScanner` (17) gains `ensureLeadingDirectories(path: FilePath): Promise<void>` (per
  leading prefix in order, `lstat` without follow through the memo: `directory` → next; `missing`
  → `ctx.fs.mkdir(prefix)`; `symlink` / `other` → `ctx.fs.rm(prefix)` then `ctx.fs.mkdir(prefix)`;
  record `directory` in the memo after each mkdir) and `invalidateAll(): void` (clears the memo).
  Never a recursive mkdir.
- `src/application/primitives/apply-changeset.ts` — `applyWriteWave` (~515):
  - no write with mode `120000` (`FILE_MODE.SYMLINK`) → today's pooled groups (ADR-976, hot path
    unchanged);
  - otherwise phase 1, sequential in index byte order (`byEntryPath`): a symlink or gitlink entry →
    `applyWriteEntry` (the writer's symlink arm already invalidates its prefix), then
    `scanner.invalidateAll()`; a regular entry → `scanner.ensureLeadingDirectories(entry.path)`;
    then `scanner.invalidateAll()` at the phase boundary (memo keys are spellings, the disk folds
    them, §D18.2); phase 2 pools the regular-file groups (`groupByCaseFoldedPath`), each write
    re-running `unlinkSymlinkedLeadingComponent` (the writer already does) before writing.
  - the sequential filter-process / unloadable-source branch (`applyGroup` on the sorted list)
    calls `ensureLeadingDirectories` for regular entries too, so both branches share one behaviour.
  - Keep each function under 20 lines (`writePhaseOne`, `writePhaseTwo`, `writesSymlink`).
- `test/unit/application/primitives/support/interleaving-fs.ts` — CREATE (test infra, §D18.3):
  `createInterleavingFs(inner: FileSystem, opts: { readonly foldUnder: string })` returns
  `{ fs, recorded }`: paths under `foldUnder` (the work tree) are lower-cased before delegating
  (`A` and `a` are one entry on every platform; the gitdir is never folded); gate 1 — `symlink(t,
  p)` resolves only after an `lstat` of a path folding to `p` resolved, or after one macrotask
  (`setTimeout(0)`) when it is the only fs operation in flight (no deadlock on the fix); gate 2 — a
  `write` / `writeStream` whose leading prefix folds to a pending symlink path waits for that
  symlink; recorder — at every `write`, `writeStream`, `mkdir`, `lstat`s each leading prefix
  through `inner` and pushes `{ op, path, prefix }` into `recorded` for any `isSymbolicLink`. No
  randomness, no retry loop.
- `test/unit/application/primitives/internal/symlinked-leading-path.test.ts`.
- `test/unit/application/primitives/apply-changeset.test.ts` — build the context with
  `createMemoryContext` and swap `ctx.fs` for the interleaving double (see how the file's
  `buildSeededContext` / fixtures compose a context).
- `test/integration/checkout-leading-symlink-interop.test.ts` — CREATE; header modelled on
  test/integration/checkout-replace-symlink-with-file-interop.test.ts (`@proves surface`,
  `bucket: cross-tool-interop`, `interopSurface`). Rows R1, R2 (only when a probe in the test finds
  the filesystem case-insensitive: write `CaseProbe` in a mktemp dir and test
  `existsSync('caseprobe')`), R4 everywhere.
- Security (design: CRITICAL): `A` (symlink → outside) and a/payload in different pool groups let
  the payload write follow the link created by the other task; the fix is git's
  `create_directories` + sequential symlink writes (§D18.2).

### TDD steps
1. RED `symlinked-leading-path.test.ts` — `ensureLeadingDirectories('a/b/c')` on a memory fs: `a`
   missing → `a` and `a/b` are directories (mkdir called once per level, never recursive); `a` a
   symlink to `/outside` → `a` replaced by a real directory, `/outside` untouched; `a` a regular
   file → replaced by a directory. `invalidateAll` makes the next scan re-`lstat` (spy count).
   Fails: not a function.
2. GREEN — `PrefixShape` split, `ensureLeadingDirectories`, `invalidateAll`.
3. RED `apply-changeset.test.ts` — order 1: changeset `A` (symlink → `/outside`) + `a/payload`,
   interleaving fs over the work tree, When `applyChangeset`, Then `recorded` is `[]`, the inner fs
   has a real directory `a` holding `payload`, no symlink at `a`, and `/outside` holds nothing.
   Fails: the gates force scan → symlink → write and `recorded` holds the `a/payload` write
   through `a`.
4. RED same file — order 2: `a` (symlink) + `A/payload` (the memo case: phase 1 caches `A` as a
   directory, the link `a` then replaces it; only the boundary clear makes phase 2 re-`lstat`).
   Same assertions. Fails as step 3; on the fix without the boundary `invalidateAll` it must still
   fail (state it in the test title, not a comment on phases).
5. GREEN — two-phase `applyWriteWave`.
6. GUARD same file — a regular-only changeset never calls `ctx.fs.mkdir` from the wave (spy count
   `0`; passes today, kills an "always run phase 1" mutant); existing symlink tests (lines 315,
   503-560, 805) stay green.
7. RED interop — R4: worktree symlink `a` → `<tmp>/outside`, tree holds `a/payload` only; tsgit
   `repo.checkout({ rev: 'HEAD', force: true })` (read `CheckoutOptions`); `a` is a real directory
   holding `payload`, outside empty — same as git's R4. R1/R2 (case-insensitive only): tree `A` →
   outside + `a/payload`, empty work tree; tsgit `repo.reset({ mode: 'hard', rev: 'HEAD' })`; a real
   directory holding `payload`, outside empty, `git status --porcelain` is ` D A`. These
   real-filesystem rows can pass by scheduling luck before the fix (1-2 runs in 10, security
   review), so they are regression pins, not the RED proof: steps 3-4 are. The gate runs them three
   times.
8. REFACTOR — none.

### Gate
```sh
rm -rf .wireit
npx vitest run test/unit/application/primitives/internal/symlinked-leading-path.test.ts test/unit/application/primitives/apply-changeset.test.ts test/unit/application/primitives/internal/write-working-tree-file.test.ts test/unit/application/primitives/materialize-tree.test.ts
for i in 1 2 3; do PATH=$HOME/.local/git-2.55.0/bin:$PATH npx vitest run test/integration/checkout-leading-symlink-interop.test.ts || exit 1; done
npm run check:types
./node_modules/.bin/biome check src/application/primitives/internal/symlinked-leading-path.ts src/application/primitives/apply-changeset.ts test/unit/application/primitives/support/interleaving-fs.ts test/unit/application/primitives/internal/symlinked-leading-path.test.ts test/unit/application/primitives/apply-changeset.test.ts test/integration/checkout-leading-symlink-interop.test.ts
npm run check:spelling
rm -rf dist .wireit && npm run build && npm run check:size
```

### Commit
`fix(checkout): never write through a symlink created in the same write wave` — no api.json change.
STOP before commit: hand back the staged diff for the user's security review.

## Part 24 — Escape-aware path order and conflict-marker labels

### Context
- `src/domain/diff/path-compare.ts` — PUBLIC values `comparePaths` (6) and `sortByPath` (10)
  (re-exported by name in src/public-types.ts): encode through one private
  `encodePath(p) = hasEscapedBytes(p) ? encodeEscaped(p) : pathEncoder.encode(p)` (codec imported
  from src/domain/objects/encoding.ts), so an escaped key orders by its raw bytes (ADR-966). Every
  engine sort reaches it (`three-way-tree.ts:728`, `index-diff.ts:106/202/248`,
  `find-would-overwrite.ts`, `detect-similarity-renames.ts:376/1386`, `sortedRecordedPaths`). Do NOT
  edit their TSDoc.
- `test/unit/domain/diff/path-compare.test.ts`.
- `test/unit/domain/diff/path-compare.properties.test.ts` — CREATE.
- `src/domain/merge/conflict-markers.ts` — `markerLine` (36-37): `encoder.encode(label line)` →
  `encodeEscaped(...)`, so a label `side:\uDCFF.txt` emits byte `ff` (T15). `writeConflictMarkers`
  is public; its TSDoc is not edited.
- `test/unit/domain/merge/conflict-markers.test.ts`.
- Bench (after the commit, never a commit gate; quiet machine first — `uptime` and no foreign
  Stryker): `npm run bench:ab` over test/bench/merge.bench.ts and test/bench/status.bench.ts;
  `hasEscapedBytes` is one regex test per sorted path. Report the deltas in the handback; if a bench
  moves beyond noise, raise it with the profile (no speculative fast path).

### TDD steps
1. RED `path-compare.test.ts` — `comparePaths('\uDCC3x', 'é')` is negative (bytes `c3 78` < `c3 a9`);
   `comparePaths('\uDCFF.txt', '\uFFFD.txt')` is positive (`ff` > `ef`); `sortByPath` over
   `['\uDCFF', 'z', '\u{10080}']` yields `['z', '\u{10080}', '\uDCFF']` (`7a` < `f0` < `ff`). Fails:
   the WHATWG encoder maps each lone surrogate to `ef bf bd`.
2. GREEN — `encodePath`.
3. Property `path-compare.properties.test.ts` (passes after GREEN): for any two bytes a, b,
   `Math.sign(comparePaths(decodeEscapingInvalid(a), decodeEscapingInvalid(b)))` equals
   `Math.sign(compareBytes(a, b))` (200); for well-formed strings the order equals
   `compareBytes(encode(a), encode(b))` (200).
4. RED `conflict-markers.test.ts` — a conflict whose theirs label is `side:\uDCFF.txt` writes the
   marker line bytes `>>>>>>> side:` + `ff 2e 74 78 74`. Fails: the label encodes `ef bf bd`.
5. GREEN — `markerLine` on `encodeEscaped`; GUARD: a label without escapes is byte-identical.
6. REFACTOR — none; `npm run docs:json && git diff --exit-code reports/api.json` (unchanged).

### Gate
```sh
rm -rf .wireit
npx vitest run test/unit/domain/diff/path-compare.test.ts test/unit/domain/diff/path-compare.properties.test.ts test/unit/domain/merge/conflict-markers.test.ts test/unit/domain/merge
npm run check:types
./node_modules/.bin/biome check src/domain/diff/path-compare.ts src/domain/merge/conflict-markers.ts test/unit/domain/diff/path-compare.test.ts test/unit/domain/diff/path-compare.properties.test.ts test/unit/domain/merge/conflict-markers.test.ts
npm run check:spelling
rm -rf dist .wireit && npm run build && npm run check:size
npm run docs:json && git diff --exit-code reports/api.json
```

### Commit
`fix(diff): order escaped paths and conflict-marker labels by their raw bytes` — public values,
behaviour only for escaped input, TSDoc untouched: no api.json change.

## Part 25 — Index entries and tree names from escaped paths

### Context
- `src/application/primitives/internal/synthetic-index-entry.ts` — `stage0Entry(path, id, mode)`
  spreads `indexPathOfEscaped(path)` instead of `path` (absent `pathBytes` key for a well-formed
  path). Serves `blobBackedEntries`, `mergedBlobEntries`, `conflictLeaves` / `distinctTypesLeaves`
  (apply-merge-to-worktree.ts:112/324/337), octopus `writeFlatTree` (octopus-merge.ts:186) and,
  through them, `synthesizeTreeFromIndex` (byte-aware since Part 5) and the AUTO_MERGE tree.
- `test/unit/application/primitives/internal/synthetic-index-entry.test.ts` — CREATE (no suite
  today).
- `src/domain/diff/index-diff.ts` — `toIndexEntry` (205) spreads `indexPathOfEscaped(emission.path)`;
  `seenPaths` (231) stays on the escaped string (injective); the final sort (247) compares
  `pathBytesOf(a)` / `pathBytesOf(b)` with `compareBytes`, then stage (the view would tie L with U).
  `conflictsToIndexEntries` is a public value; no type or TSDoc change.
- `test/unit/domain/diff/index-diff.test.ts`.
- `src/application/commands/merge.ts` — `writeNestedTree` (1559): `leavesToTreeEntries` (1517) and
  the directory frames (~1491, 1507, 1552) call `treeEntry(mode, encodeEscaped(name), id)` when
  `hasEscapedBytes(name)`, the string form otherwise (one helper `treeEntryOfEscaped`).
- `test/unit/application/commands/merge.test.ts`.

### TDD steps
1. RED `synthetic-index-entry.test.ts` — `stage0Entry('\uDCFF.txt', id, '100644')` has `path
   '\uFFFD.txt'` and `pathBytes` `ff2e747874`; `stage0Entry('a', id, mode)` has no `pathBytes` key.
   Fails: today `path` is the escaped string and no bytes.
2. GREEN — `stage0Entry`.
3. RED `index-diff.test.ts` — `conflictsToIndexEntries` over a content conflict at `'\uDCFF.txt'`
   and one at `'\uFFFD.txt'`: six entries, L's three carry `pathBytes ff2e747874` and sort after U's
   three (bytes `ff` > `ef`); a UTF-8 conflict carries no key. Fails: no bytes; order by view ties.
4. GREEN — `toIndexEntry` and the byte sort.
5. RED `merge.test.ts` — `writeNestedTree` over leaves `'\uDCFF.txt'` and `'\uDCFF/x'`: the written
   tree lists names `ff2e747874` and `ff` (subtree) with `x` inside (read back with
   `readObject` + `nameBytes`). Fails: the names are encoded `ef bf bd`.
6. GREEN — `treeEntryOfEscaped`.
7. REFACTOR — none. Interop: none (no producer of escaped keys yet).

### Gate
```sh
rm -rf .wireit
npx vitest run test/unit/application/primitives/internal/synthetic-index-entry.test.ts test/unit/domain/diff/index-diff.test.ts test/unit/application/commands/merge.test.ts test/unit/application/primitives/apply-merge-to-worktree.test.ts test/unit/application/commands/internal/octopus-merge.test.ts
npm run check:types
./node_modules/.bin/biome check src/application/primitives/internal/synthetic-index-entry.ts src/domain/diff/index-diff.ts src/application/commands/merge.ts test/unit/application/primitives/internal/synthetic-index-entry.test.ts test/unit/domain/diff/index-diff.test.ts test/unit/application/commands/merge.test.ts
npm run check:spelling
npm run docs:json && git diff --exit-code reports/api.json
```

### Commit
`refactor(merge): build index entries and tree names from escaped paths` — no api.json change.

## Part 26 — Path validation of escaped merge paths

### Context
- `src/domain/git-index/path-validator.ts` — ADD `export const validateTreePath = (path: FilePath,
  mode: FileMode): void` = `const { path: view, pathBytes } = indexPathOfEscaped(path);
  validateIndexPath(view, NO_PARSER_OFFSET, mode, pathBytes);` (HFS reads the raw bytes, ADR-978).
  Internal (git-index barrel values are type-only in public-types.ts).
- `test/unit/domain/git-index/path-validator.test.ts`.
- `src/application/primitives/internal/validate-merge-write-paths.ts` — both loops switch from
  `validateIndexPath(…, NO_PARSER_OFFSET, …)` to `validateTreePath(path, mode)`.
- `test/unit/application/primitives/internal/validate-merge-write-paths.test.ts`.
- `src/application/primitives/apply-merge-to-worktree.ts` — `removeChangedOutcome` (~211) and
  `writeValidatedConflict` (~247) switch to `validateTreePath`.
- Moved out (see Shared knowledge): `merge.ts:1794/1824` → Part 31; `stash.ts:667` → Part 27b.

### TDD steps
1. RED `path-validator.test.ts` — `validateTreePath('.git\uDCFF/x', '100644')` throws with the HFS
   reason (§D13.3 row 1); `validateTreePath('\uDCFF.txt', '100644')` does not throw;
   `validateTreePath('../x', '100644')` throws as `validateIndexPath` does. Fails: not exported.
2. GREEN — `validateTreePath`.
3. RED `validate-merge-write-paths.test.ts` — an outcome at `'.git\uDCFF/x'` is refused with the HFS
   reason. Fails: the escaped string is accepted (`.git` + lone surrogate is no alias for the
   string check).
4. GREEN — both loops.
5. GUARD `apply-merge-to-worktree.test.ts` — existing suite green after the two call-site switches
   (identity on well-formed paths; their escaped coverage lands with Part 30b's twins).
6. REFACTOR — none.

### Gate
```sh
rm -rf .wireit
npx vitest run test/unit/domain/git-index/path-validator.test.ts test/unit/application/primitives/internal/validate-merge-write-paths.test.ts test/unit/application/primitives/apply-merge-to-worktree.test.ts
npm run check:types
./node_modules/.bin/biome check src/domain/git-index/path-validator.ts src/application/primitives/internal/validate-merge-write-paths.ts src/application/primitives/apply-merge-to-worktree.ts test/unit/domain/git-index/path-validator.test.ts test/unit/application/primitives/internal/validate-merge-write-paths.test.ts
npm run check:spelling
```

### Commit
`refactor(merge): validate escaped merge paths against their raw bytes` — no api.json change.

## Part 27 — Merge-driven writes skip escaped paths

### Context
- `src/application/primitives/internal/write-converted-entry.ts` — `createWorkingTreeWriter`:
  `writeBlob` (114) and `writeBytes` (138) return before the leading-path scan when
  `hasEscapedBytes(path)` (ADR-973, ADR-975: silent). Serves `writeChangedOutcome`,
  `writeMarkedConflict`, `writeDistinctTypesSides`, `merge.ts:1798-1832` and stash
  `restoreUntracked`. Checkout's `applyWriteEntry` never reaches the writer with a lossy entry
  (Part 17), so this is the merge chokepoint only.
- `test/unit/application/primitives/internal/write-converted-entry.test.ts`.
- `src/application/primitives/internal/write-working-tree-file.ts` — `removeWorkingTreeFile` (289):
  `if (hasEscapedBytes(path)) return;` first.
- `test/unit/application/primitives/internal/write-working-tree-file.test.ts`.

### TDD steps
1. RED `write-converted-entry.test.ts` — Given a writer on a memory context, When
   `writeBlob('\uDCFF.txt', id, '100644', scanner)` and `writeBytes('\uDCFF/x', bytes, '100644',
   scanner)`, Then no fs spy (`write`, `mkdir`, `lstat`, `symlink`) saw a call, and no call argument
   matches `/[\uDC80-\uDCFF]/`. Fails: today the writer scans and writes the lone-surrogate name.
2. GREEN — the two early returns.
3. RED `write-working-tree-file.test.ts` — Given U's file on disk, When
   `removeWorkingTreeFile(ctx, '\uDCFF.txt')`, Then no fs spy (`lstat`, `rm`) saw a call and U's file
   exists. Fails: today it probes and removes the lone-surrogate name.
4. GREEN — early return.
5. GUARD — `writeBlob('\uFFFD.txt', …)` (well-formed) still writes (passes: `hasEscapedBytes` is
   false for U+FFFD).
6. REFACTOR — none.

### Gate
```sh
rm -rf .wireit
npx vitest run test/unit/application/primitives/internal/write-converted-entry.test.ts test/unit/application/primitives/internal/write-working-tree-file.test.ts test/unit/application/primitives/apply-merge-to-worktree.test.ts
npm run check:types
./node_modules/.bin/biome check src/application/primitives/internal/write-converted-entry.ts src/application/primitives/internal/write-working-tree-file.ts test/unit/application/primitives/internal/write-converted-entry.test.ts test/unit/application/primitives/internal/write-working-tree-file.test.ts
npm run check:spelling
```

### Commit
`refactor(merge): skip working-tree writes for escaped merge paths` — no api.json change.

## Part 27b — Escaped paths are absent in overwrite checks and stash restore

### Context
- `src/application/primitives/find-would-overwrite.ts` — `stage0ByPath` (87) keys by
  `escapedPathOf(entry)` (map type `Map<FilePath, IndexEntry>` unchanged: the escaped key is a
  `FilePath`); `isUntrackedPresent` (76) returns `false` with no `lstat` for an escaped path; the
  returned `localChanges` / `untracked` are sorted with the escape-aware `comparePaths` (Part 24),
  then mapped through `viewOfEscaped` (public data, ADR-982). Part 16's lossy test in
  find-would-overwrite.test.ts switches its `paths` input to the escaped key `'\uDCFF.txt'`, the
  form the engine hands it from Part 30b on.
- `test/unit/application/primitives/find-would-overwrite.test.ts`.
- `src/application/commands/stash.ts` — `untrackedOverwrites` (~630): skip escaped paths before
  `pathIsOccupied`; `restoreUntracked` gate (~667): `validateIndexPath(path, …)` →
  `validateTreePath(path, entry.mode)` (Part 26).
- `test/unit/application/commands/stash.test.ts`.

### TDD steps
1. RED `find-would-overwrite.test.ts` — Given index L (lossy) and U's file on disk, When
   `findWouldOverwrite` over paths `['\uDCFF.txt']` (merge changes L), Then `localChanges` and
   `untracked` are both empty and the `lstat` spy saw no call (pin T10: git's up-to-date check passes
   on ENOENT). Fails: today the escaped key misses the view-keyed `stage0ByPath`, the path reads as
   untracked and `lstat` runs on the lone-surrogate name.
2. RED same file — Given index entries U (dirty on disk), When paths `['\uFFFD.txt']`, Then
   `localChanges` is `['\uFFFD.txt']` (view, sorted by bytes). GUARD for U (passes) and a RED for an
   escaped dirty report: Given two escaped untracked candidates never reported (no `lstat`). Write
   the GUARD before GREEN.
3. GREEN — keyed map, `isUntrackedPresent` early return, view mapping.
4. RED `stash.test.ts` — Given a stash whose untracked tree holds `'\uDCFF.txt'`-named entry (build
   the untracked tree with `treeEntry(mode, ff2e747874 bytes, id)`) and U's file on disk, When
   `stash.apply` restores untracked files, Then it does not refuse on U's file and writes nothing for
   L. Fails: `untrackedOverwrites` probes the name. If the untracked flatten (stash.ts:635/661) still
   yields views at this point, the RED is reached only after Part 30's flatten: then keep this step
   as written and run it in Part 30b's gate instead (the implementer states which in the handback).
5. GREEN — `untrackedOverwrites` skip + `validateTreePath` gate.
6. REFACTOR — none.

### Gate
```sh
rm -rf .wireit
npx vitest run test/unit/application/primitives/find-would-overwrite.test.ts test/unit/application/primitives/find-would-overwrite.properties.test.ts test/unit/application/commands/stash.test.ts
npm run check:types
./node_modules/.bin/biome check src/application/primitives/find-would-overwrite.ts src/application/commands/stash.ts test/unit/application/primitives/find-would-overwrite.test.ts test/unit/application/commands/stash.test.ts
npm run check:spelling
```

### Commit
`refactor(merge): treat escaped paths as absent in overwrite checks` — `findWouldOverwrite` is
internal (not in src/application/primitives/index.ts): no api.json change.

## Part 28 — `MERGE_MSG` conflict list carries raw bytes

### Context
- `src/application/commands/internal/merge-state.ts` — `writeMergeMsg` (line 67):
  `ctx.fs.writeUtf8(path, message)` → `ctx.fs.write(path, encodeEscaped(message))`, so the
  `#\t<path>` lines `cherry-pick-state.ts` `conflictsHint` (40) builds from escaped paths land as raw
  bytes (git's `append_conflicts_hint` writes the index name, source-read).
- `src/application/commands/internal/rebase-state.ts` — line 154 the same switch.
- `test/unit/application/commands/internal/merge-state.test.ts`.
- `test/unit/application/commands/internal/rebase-state.test.ts`.

### TDD steps
1. RED `merge-state.test.ts` — Given a message `'Merge\n\n# Conflicts:\n#\t\uDCFF.txt\n'`, When
   `writeMergeMsg`, Then the file bytes hold `23 09 ff 2e 74 78 74 0a`. Fails: `writeUtf8` encodes
   `ef bf bd`.
2. GREEN — `writeMergeMsg`.
3. GUARD same file — a message without escapes is byte-identical to `encode(message)`.
4. RED `rebase-state.test.ts` — a stop whose `mergeMsg` holds `'\uDCFF'` writes byte `ff`. Fails as
   step 1.
5. GREEN — rebase-state switch.
6. REFACTOR — none.

### Gate
```sh
rm -rf .wireit
npx vitest run test/unit/application/commands/internal/merge-state.test.ts test/unit/application/commands/internal/rebase-state.test.ts test/unit/application/commands/internal/cherry-pick-state.test.ts
npm run check:types
./node_modules/.bin/biome check src/application/commands/internal/merge-state.ts src/application/commands/internal/rebase-state.ts test/unit/application/commands/internal/merge-state.test.ts test/unit/application/commands/internal/rebase-state.test.ts
npm run check:spelling
```

### Commit
`refactor(merge): write MERGE_MSG conflict lines with raw path bytes` — no api.json change.

## Part 29 — Public conflict results report the view

### Context
- `src/application/commands/internal/replay-sequence.ts` — `toConflictList` (line 113-115, already
  exported, internal module) maps `path: viewOfEscaped(c.path)`. It is the single mapper: the
  inline copies `conflicts.map((c) => ({ path: c.path, type: c.type }))` in
  `src/application/commands/rebase.ts` (~508, ~1262), `src/application/commands/stash.ts` (~798)
  and `src/application/commands/merge.ts` (~1684, `MergeConflictDescriptor`) call `toConflictList`
  instead (check that each result type is structurally `{ path, type }`; if one is not, keep a
  local mapper that calls `viewOfEscaped`).
- `merge.ts` `rejectUnsupportedConflicts` (~1701, exported): the error data / message names
  `viewOfEscaped(conflict.path)`. `apply-merge-to-worktree.ts` `rejectUnsupported` (299) is switched
  in Part 30b, where a test can reach it.
- `test/unit/application/commands/internal/replay-sequence.test.ts` — CREATE.
- `test/unit/application/commands/merge.test.ts`.

### TDD steps
1. RED `replay-sequence.test.ts` — `toConflictList([{ path: '\uDCFF.txt', type: 'content', … }])`
   yields `[{ path: '\uFFFD.txt', type: 'content' }]`; a UTF-8 path is unchanged (same string).
   Fails: today the escaped path passes through.
2. GREEN — `viewOfEscaped` in `toConflictList`.
3. REFACTOR — the four inline mappers call `toConflictList`; GUARD: rebase, stash, merge,
   cherry-pick suites stay green.
4. RED `merge.test.ts` — `rejectUnsupportedConflicts` over an unsupported conflict at
   `'\uDCFF.txt'` throws with the path `'\uFFFD.txt'` in its data (assert the data field the error
   factory sets). Fails: the escaped string leaks.
5. GREEN — view in `rejectUnsupportedConflicts`.

### Gate
```sh
rm -rf .wireit
npx vitest run test/unit/application/commands/internal/replay-sequence.test.ts test/unit/application/commands/merge.test.ts test/unit/application/commands/rebase.test.ts test/unit/application/commands/stash.test.ts test/unit/application/commands/cherry-pick.test.ts
npm run check:types
./node_modules/.bin/biome check src/application/commands/internal/replay-sequence.ts src/application/commands/rebase.ts src/application/commands/stash.ts src/application/commands/merge.ts test/unit/application/commands/internal/replay-sequence.test.ts test/unit/application/commands/merge.test.ts
npm run check:spelling
npm run docs:json && git diff --exit-code reports/api.json
```

### Commit
`refactor(merge): report conflict paths by their decoded view` — result types unchanged: no
api.json change.

## Part 30 — Escaped flatten for merge inputs

### Context
- `src/domain/objects/tree-cursor.ts` — ADD `cursorNameBytes(c: TreeCursor): Uint8Array` (a
  `subarray`, no copy) next to `cursorName` (192).
- `test/unit/domain/objects/tree-cursor.test.ts`.
- `src/application/primitives/internal/flatten-raw.ts` — `FlattenConfig` gains
  `readonly names: 'view' | 'escaped'` (set once per call); `flattenEntry` (170-177) names the key
  `cursorName(cursor)` unless `names === 'escaped'` and
  `!decodesLosslessly(name, cursorNameBytes(cursor))` (the §D3 shortcut), then
  `decodeEscapingInvalid(cursorNameBytes(cursor))` (a small `keyNameOf(config, cursor)` helper keeps
  `flattenEntry` flat). Two entry points share `flattenLevel`: `flattenRawTree` (unchanged
  signature, `'view'`; `diff-trees.ts:501/504` keeps it) and NEW `flattenRawTreeEscaped(ctx, root,
  bounds)`.
- `test/unit/application/primitives/internal/flatten-raw.test.ts`.
- `src/application/primitives/flatten-tree.ts` — keep the public `flattenTree` on the view (DC13);
  ADD internal `flattenEscapedTree(ctx, tree)` (NOT exported from
  src/application/primitives/index.ts). Consumed from Part 30b.
- `test/unit/application/primitives/flatten-tree.test.ts`.

### TDD steps
1. RED `tree-cursor.test.ts` — over a tree whose entry name bytes are `ff2e747874`,
   `cursorNameBytes` equals those bytes. Fails: not exported.
2. GREEN — `cursorNameBytes`.
3. RED `flatten-raw.test.ts` — Given a tree with L and U leaves, When `flattenRawTreeEscaped`, Then
   two keys `'\uDCFF.txt'` and `'\uFFFD.txt'` with their own ids; a lossy directory `\xff/` with
   child `x` yields key `'\uDCFF/x'`; a BOM name keeps U+FEFF unescaped. Fails: not exported.
4. GREEN — `names` config and the entry point.
5. GUARD same file — `flattenRawTree` on the twins yields one key `'\uFFFD.txt'` (today's collapse,
   unchanged; passes).
6. RED `flatten-tree.test.ts` — `flattenEscapedTree` over the twins has two keys. Fails: not
   exported.
7. GREEN — `flattenEscapedTree`.

### Gate
```sh
rm -rf .wireit
npx vitest run test/unit/domain/objects/tree-cursor.test.ts test/unit/domain/objects/tree-cursor.properties.test.ts test/unit/application/primitives/internal/flatten-raw.test.ts test/unit/application/primitives/flatten-tree.test.ts
npm run check:types
./node_modules/.bin/biome check src/domain/objects/tree-cursor.ts src/application/primitives/internal/flatten-raw.ts src/application/primitives/flatten-tree.ts test/unit/domain/objects/tree-cursor.test.ts test/unit/application/primitives/internal/flatten-raw.test.ts test/unit/application/primitives/flatten-tree.test.ts
npm run check:spelling
npm run docs:json && git diff --exit-code reports/api.json
```

### Commit
`refactor(merge): add an escaped flatten for merge inputs` — internal, no api.json change.

## Part 30a — Shared raw-path interop helpers

### Context
- `test/integration/interop-helpers.ts` — MOVE from test/integration/index-path-bytes-interop.test.ts
  and export: `stageRaw(dir, rows)`, `pathHexOfRecords(records)`, `lsFilesPathHex(dir)`,
  `lsTreePathHex(dir, rev)`, `hashBlob(dir, content)`; ADD `mergeTreeResult(dir, ours, theirs):
  { tree: string; conflicted: ReadonlyArray<{ mode: string; oid: string; stage: number; pathHex:
  string }> }` parsing `git -c merge.conflictStyle=merge merge-tree --write-tree -z <ours> <theirs>`
  (`runGitBytes`; first NUL field = tree oid, then `<mode> <oid> <stage>\t<path>` records until the
  empty field).
- `test/integration/index-path-bytes-interop.test.ts` — import them instead of the local copies.
- Test-infra only, no `src/` delta: legitimately standalone.

### TDD steps
1. GUARD — move the helpers; the whole index-path-bytes interop file stays green (passes: pure move).
2. GUARD — `mergeTreeResult` has no consumer yet; Part 30b's first row exercises it.
3. REFACTOR — none.

### Gate
```sh
rm -rf .wireit
PATH=$HOME/.local/git-2.55.0/bin:$PATH npx vitest run test/integration/index-path-bytes-interop.test.ts
npm run check:types
./node_modules/.bin/biome check test/integration/interop-helpers.ts test/integration/index-path-bytes-interop.test.ts
npm run check:spelling
```

### Commit
`test(interop): share raw-path interop helpers`

## Part 30b — Cherry-pick, revert, rebase and stash apply on escaped trees

### Context
- `src/application/primitives/apply-merge-to-worktree.ts` — `applyMergeToWorktree` (445; flattens at
  450-452) and `mergeTreesToTree` (511; 521-523) flatten with `flattenEscapedTree`. Covers
  `cherry-pick`, `revert`, `rebase` (both backends: `replay-sequence.ts:179`,
  `rebase-merges-steps.ts:144`) and `stash apply` (`stash.ts:697/834`). `rejectUnsupported` (299)
  names `viewOfEscaped(conflict.path)`. The index side meets engine keys through `stage0Entry`
  (Part 25); worktree I/O skips escaped paths (Part 27).
- `test/unit/application/primitives/apply-merge-to-worktree.test.ts`.
- `test/unit/domain/merge/three-way-tree.test.ts` — characterisation over escaped keys (GUARDs:
  `mergeTrees` is string-local on keys).
- `test/integration/merge-path-bytes-interop.test.ts` — CREATE; header modelled on
  test/integration/merge-interop.test.ts (`@proves surface: merge`, `bucket: cross-tool-interop`,
  `interopSurface`), `describe.skipIf(!GIT_AVAILABLE)`; recipe in Shared knowledge. Rows T19, T19b,
  T23.

### TDD steps
1. RED `apply-merge-to-worktree.test.ts` — Given base/ours/theirs trees holding L and U twins where
   theirs modifies L, When `applyMergeToWorktree`, Then the result index holds L with the new blob,
   `pathBytes ff2e747874`, zero stat, U untouched with its own blob, and no fs spy call names
   `'\uFFFD.txt'` for L or matches `/[\uDC80-\uDCFF]/`. Fails: the view flatten collapses the twins
   (T12) and the merged L is written to U's file.
2. GREEN — `flattenEscapedTree` at both flatten sites.
3. RED same file — an unsupported conflict type on L rejects naming `'\uFFFD.txt'` (find the types
   in `UNSUPPORTED_CONFLICT_TYPES`). Fails: the escaped key leaks. GREEN — `viewOfEscaped` in
   `rejectUnsupported`.
4. GUARD `three-way-tree.test.ts` — over escaped `FlatTree` inputs: T13 rename paired by content from
   `'\uDCFF.txt'` to `r.txt`; T14 rename onto `'\uDCFF.txt'`; T16 D/F name `'\uDCFF~main'`; T17
   directory rename moves `'d/\uDCFF'` to `'e/\uDCFF'`; T18 a `*.txt merge=union` attribute reaches
   `'\uDCFF.txt'` (passes: string-local machinery, design §D19.4).
5. RED interop — T19: T10 history, tsgit `repo.cherryPick.run(...)` (read `CherryPickNamespace`):
   `lsTreePathHex('HEAD')` equals the tree of `mergeTreeResult` for the same sides; `git ls-files
   -s -z` lists `ff2e747874` with the new blob; `git status --porcelain` ` D` for L; `git fsck` 0.
   T19b: `repo.revert.run(...)` of a commit touching only `a` keeps `ff2e747874` = base blob. T23: L
   staged as `l2` over HEAD `l1`; `repo.stash.push()` then `repo.stash.apply({ index: true })`
   reports a modify/delete conflict on `'\uFFFD.txt'` (view) and the index holds stages 1 (`l1`) and
   2 (`l2`) at `ff2e747874`. Fail before step 2: `efbfbd…` names.
6. REFACTOR — none. If Part 27b's stash RED was deferred here, it runs in this gate.

### Gate
```sh
rm -rf .wireit
npx vitest run test/unit/application/primitives/apply-merge-to-worktree.test.ts test/unit/domain/merge/three-way-tree.test.ts test/unit/application/commands/stash.test.ts test/unit/application/commands/cherry-pick.test.ts test/unit/application/commands/rebase.test.ts
PATH=$HOME/.local/git-2.55.0/bin:$PATH npx vitest run test/integration/merge-path-bytes-interop.test.ts test/integration/stash-apply-index-interop.test.ts
npm run check:types
./node_modules/.bin/biome check src/application/primitives/apply-merge-to-worktree.ts test/unit/application/primitives/apply-merge-to-worktree.test.ts test/unit/domain/merge/three-way-tree.test.ts test/integration/merge-path-bytes-interop.test.ts
npm run check:spelling
```

### Commit
`fix(merge): carry raw path bytes through cherry-pick, revert, rebase and stash apply` — no
api.json change.

## Part 31 — Three-way merge on escaped trees

### Context
- `src/application/commands/merge.ts` — flatten sites 836, 847, 1186, 1318-1320 →
  `flattenEscapedTree`; `assertIndexMatches` (~1198) keys the index side by `escapedPathOf(entry)`
  and reports `viewOfEscaped` paths sorted by `comparePaths`; `outcomesBetween` (~1212) unchanged;
  the validation sites at ~1794 / ~1824 switch to `validateTreePath` (moved here from Part 26);
  the skip-worktree builder near 1898 already goes through `skipWorktreeEntry` with the outcome path
  — pass `indexPathOfEscaped(outcome.path)` fields so a lossy outcome keeps its bytes.
- `test/unit/application/commands/merge.test.ts`.
- `test/integration/merge-path-bytes-interop.test.ts` — rows T9, T10, T11, T12, T13, T14, T15, T16,
  T17 (`merge.directoryRenames` default `conflict` and `true`), T18.

### TDD steps
1. RED `merge.test.ts` — T9: `main` and `side` change different ASCII files, both carry L untouched;
   `merge.run` makes a merge commit whose tree lists L's name bytes `ff2e747874` (read the tree with
   `nameBytes`). Fails: the tree names `efbfbd2e747874` (history rewrite).
2. RED same file — T12: twins L/U, side modifies L: the merge tree keeps U = `y`, L = `x2`, two
   entries. Fails: the view collapse drops U.
3. GREEN — flatten sites on `flattenEscapedTree` together with `assertIndexMatches` on
   `escapedPathOf` (line 847 feeds it an escaped tree; switching one without the other refuses a
   clean twin repo).
4. GUARD same file — T11: conflicting edits of L leave stages 1/2/3 with `pathBytes ff2e747874`, no
   worktree file, the descriptor names `'\uFFFD.txt'` (passes after step 3 through Parts 25, 27, 29).
5. RED same file — side adds `.git\xff/x` (tree built with `treeEntry(mode, bytes, id)`): `merge.run`
   rejects with the HFS reason. Fails: the escaped string passes `validateIndexPath` and the merge
   commits an index tsgit then refuses to parse.
6. GREEN — `validateTreePath` at ~1794 / ~1824.
7. RED same file — sparse checkout excluding L, side modifies L: the skip-worktree index entry keeps
   `pathBytes ff2e747874`. Fails: `skipWorktreeEntry({ path: outcome.path, … })` stores the escaped
   string as `path`, which the writer encodes as `efbfbd2e747874`.
8. GREEN — skip-worktree builder from `indexPathOfEscaped(outcome.path)`.
9. RED interop — each row compares tsgit's HEAD tree / index with `mergeTreeResult` on the same
   sides (T9-T12, T14, T16, T17, T18), T13 and T15 compare porcelain outcomes directly (T15: tsgit
   `r.txt` marker label bytes `>>>>>>> side:` + `ff2e747874`, stages at `722e747874`). Fail before
   step 3.
10. REFACTOR — none.

### Gate
```sh
rm -rf .wireit
npx vitest run test/unit/application/commands/merge.test.ts test/unit/application/commands/merge.properties.test.ts test/unit/application/commands/merge-squash.test.ts test/unit/application/commands/merge-no-commit.test.ts
PATH=$HOME/.local/git-2.55.0/bin:$PATH npx vitest run test/integration/merge-path-bytes-interop.test.ts test/integration/merge-interop.test.ts test/integration/merge-conflict-interop.test.ts test/integration/merge-renames-interop.test.ts
npm run check:types
./node_modules/.bin/biome check src/application/commands/merge.ts test/unit/application/commands/merge.test.ts test/integration/merge-path-bytes-interop.test.ts
npm run check:spelling
```

### Commit
`fix(merge): carry raw path bytes through three-way merges` — no api.json change.

## Part 31b — Octopus, pull into an unborn branch and subtree shifts

### Context
- `src/application/commands/internal/octopus-merge.ts` — flatten at line 67 →
  `flattenEscapedTree`; line ~139 `[...paths].sort()` (UTF-16 order) → `sortByPath` (escape-aware).
- `test/unit/application/commands/internal/octopus-merge.test.ts`.
- `src/application/commands/internal/pull-into-void.ts` — `checkoutFromEmptyTree` (38) flattens
  escaped; `assertNoStagedCollision` (58) looks up `escapedPathOf(entry)`; line 47's
  `new Set(target.entries.keys())` now holds escaped keys, which Part 19b's `filterByPaths`
  compares with `escapedPathOf` (one scheme, no conversion).
- `src/domain/merge/match-trees.ts` — subtree prefixes (85) and the path walk (114) use the escaped
  name of a tree entry (`decodeEscapingInvalid(entry.nameBytes)` when the name is lossy, else
  `entry.name`), so `shift-merge-side.ts`'s `startsWith(prefix)` meets escaped keys (git's
  `shift_tree` compares raw names).
- `test/unit/domain/merge/match-trees.test.ts`.
- `test/integration/merge-path-bytes-interop.test.ts` — rows T20, T21.

### TDD steps
1. RED `octopus-merge.test.ts` — T20: `a`, L → main edits `a` / s1 adds `c` / s2 adds `d`: the octopus
   tree keeps `ff2e747874`. Fails: `efbfbd…`. And order: entries `'\uDCFF'` and `'\u{10080}'` are
   merged in byte order. Fails: UTF-16 sort.
2. GREEN — octopus flatten and sort.
3. RED `match-trees.test.ts` — a lossy subtree directory `\xff/` matched against its shifted twin
   yields the escaped prefix `'\uDCFF/'`. Fails: the view prefix `'\uFFFD/'`.
4. GREEN — escaped names in match-trees.
5. GUARD — pull.test.ts covers `pull-into-void` (no unit suite): pulling into an unborn branch whose
   target holds L keeps `pathBytes`; add the case to pull.test.ts only if the gate's file budget
   allows, else rely on the interop below.
6. RED interop — T20 (tree keeps `ff2e747874`, 3 parents), T21 (s1 also edits L: tsgit succeeds with
   L's new blob at `ff2e747874`, zero stat; git porcelain refuses on macOS — not compared,
   ADR-975; compare the tree with sequential `mergeTreeResult`). Fail before step 2.

### Gate
```sh
rm -rf .wireit
npx vitest run test/unit/application/commands/internal/octopus-merge.test.ts test/unit/domain/merge/match-trees.test.ts test/unit/domain/merge/match-trees.properties.test.ts test/unit/application/commands/pull.test.ts
PATH=$HOME/.local/git-2.55.0/bin:$PATH npx vitest run test/integration/merge-path-bytes-interop.test.ts test/integration/merge-octopus-interop.test.ts
npm run check:types
./node_modules/.bin/biome check src/application/commands/internal/octopus-merge.ts src/application/commands/internal/pull-into-void.ts src/domain/merge/match-trees.ts test/unit/application/commands/internal/octopus-merge.test.ts test/unit/domain/merge/match-trees.test.ts test/integration/merge-path-bytes-interop.test.ts
npm run check:spelling
```

### Commit
`fix(merge): carry raw path bytes through octopus merges, unborn pulls and subtree shifts` — no
api.json change.

## Part 32 — Escaped HEAD tree and keyed index diff

### Context
- `src/application/primitives/read-head-tree.ts` — PUBLIC `readHeadTree` (112) stays on the view
  (DC-5 A). ADD internal `readHeadTreeEscaped(ctx)` sharing one private
  `readHeadTreeWith(ctx, flatten, keySuffix)`; its cache key is `flatTreeCacheKey(tree, maxDepth)`
  plus an `':escaped'` suffix (named constant) so both views coexist in `flatTreeCacheFor(ctx)`.
  NOT exported from src/application/primitives/index.ts.
- `test/unit/application/primitives/read-head-tree.test.ts`.
- `src/domain/diff/index-diff.ts` — ADD internal `diffIndexAgainstTreeKeyed(index, tree)` and
  `groupUnmergedEntriesKeyed(index)` that key index entries by `escapedPathOf(entry)` (via a
  `keyOf` parameter on the private helpers `stage0IndexMap` (23) and the grouping loop). The PUBLIC
  `diffIndexAgainstTree` (96) keeps keying the index side by `entry.path` (its tree argument comes
  from the public, view-keyed `flattenTree`; DC-7 A); the PUBLIC `groupUnmergedEntries` (116)
  returns the keyed grouping with each group's `path` mapped through `viewOfEscaped` (twins become
  two groups). Do NOT add the keyed functions to src/domain/diff/index.ts.
- `test/unit/domain/diff/index-diff.test.ts`.

### TDD steps
1. RED `read-head-tree.test.ts` — HEAD tree holding L and U: `readHeadTreeEscaped` has keys
   `'\uDCFF.txt'` and `'\uFFFD.txt'`; `readHeadTree` still has one key `'\uFFFD.txt'`; a second
   `readHeadTreeEscaped` call hits the cache (spy on the flatten or count `readObject`). Fails: not
   exported.
2. GREEN — `readHeadTreeWith` + the two entry points.
3. RED `index-diff.test.ts` — twins in HEAD (escaped tree) and index: `diffIndexAgainstTreeKeyed`
   reports no change; `groupUnmergedEntries` over unmerged L and U returns two groups, both with
   path `'\uFFFD.txt'`. Fails: not exported / one merged group.
4. GREEN — keyed variants and the public grouping view.
5. GUARD — the public `diffIndexAgainstTree` over a view-keyed tree and an index with L only reports
   no change (passes today and after).

### Gate
```sh
rm -rf .wireit
npx vitest run test/unit/application/primitives/read-head-tree.test.ts test/unit/domain/diff/index-diff.test.ts test/unit/application/commands/status.test.ts
npm run check:types
./node_modules/.bin/biome check src/application/primitives/read-head-tree.ts src/domain/diff/index-diff.ts test/unit/application/primitives/read-head-tree.test.ts test/unit/domain/diff/index-diff.test.ts
npm run check:spelling
npm run docs:json && git diff --exit-code reports/api.json
```

### Commit
`refactor(diff): key HEAD-tree index diffs by escaped paths` — public signatures unchanged, no
api.json change.

## Part 32b — Status joins HEAD, index and work tree on escaped paths

### Context
- `src/application/commands/status.ts` — `readHeadTree` (297) → `readHeadTreeEscaped`; `stage0Map`
  (225-235), `workingMap` (240-246, 366), `stagedKindMap` / `collectStagedKinds` (~399) and the
  unmerged groups key by `escapedPathOf(entry)` (scanned work-tree names are fs strings, their own
  keys); use `diffIndexAgainstTreeKeyed` / `groupUnmergedEntriesKeyed`; `buildChangedPath` (~450)
  then finds L's HEAD side. Sort the records by escaped key with `comparePaths` (raw byte order,
  Part 24), then map each record's `path` through `viewOfEscaped` (public data, ADR-982).
- `test/unit/application/commands/status.test.ts`.
- `test/integration/index-path-bytes-interop.test.ts` — status on the clean twin repo.

### TDD steps
1. RED `status.test.ts` — Given HEAD and index holding L and U, U's file clean on disk, When
   `status`, Then exactly one record names `'\uFFFD.txt'` with unstaged `deleted` (L) and no staged
   change exists; U has no record. Fails: today L's index entry meets U's HEAD id through the view
   key and reports a staged modification (or twins collapse).
2. RED same file — records sort by raw bytes: Given L deleted (absent) and a modified tracked file
   `\u{10080}` (`f0 90 82 80`), Then the record for `\u{10080}` precedes L's (`f0` < `ff`). Fails:
   the view sort compares L as `ef bf bd` and puts it first.
3. GREEN — escaped joins, keyed variants, sort then view.
4. RED interop — `seedLossyTwins`; tsgit `repo.status()`: staged section empty; the only changes are
   the unstaged deletions of `\uFFFD.txt` (L) and `d/\uFFFD` — git `status --porcelain=v2` agrees
   (S1). Fails before step 3 if staged noise appears; else GUARD.

### Gate
```sh
rm -rf .wireit
npx vitest run test/unit/application/commands/status.test.ts test/unit/application/commands/status-refresh.test.ts test/unit/application/commands/status-clean-order.test.ts test/unit/application/commands/status-filter-skip.test.ts
PATH=$HOME/.local/git-2.55.0/bin:$PATH npx vitest run test/integration/index-path-bytes-interop.test.ts test/integration/status-interop.test.ts
npm run check:types
./node_modules/.bin/biome check src/application/commands/status.ts test/unit/application/commands/status.test.ts test/integration/index-path-bytes-interop.test.ts
npm run check:spelling
```

### Commit
`fix(status): join HEAD, index and work tree on escaped paths` — status result types unchanged, no
api.json change.

## Part 32c — rm and the clean-tree check look up HEAD by escaped path

### Context
- `src/application/commands/rm.ts` — `isStaged` / the HEAD map (204-213): `readHeadTreeEscaped`
  and `head.get(escapedPathOf(entry))` (pin T7).
- `test/unit/application/commands/rm.test.ts`.
- `src/application/commands/internal/clean-work-tree.ts` — `stagedDirty` (34-50):
  `flattenEscapedTree`, `indexPaths` on `escapedPathOf`, the HEAD lookup on `escapedPathOf(entry)`,
  dirty paths reported through `viewOfEscaped` (the HEAD-only loop keeps the escaped key until the
  final map).
- `test/unit/application/commands/internal/clean-work-tree.test.ts`.
- `test/integration/index-path-bytes-interop.test.ts` — row S8b.
- `test/integration/merge-path-bytes-interop.test.ts` — row T22.

### TDD steps
1. RED `rm.test.ts` — Given HEAD and index holding L and U (U's file clean), When `rm(['*.txt'])`,
   Then both entries leave the index, U is unlinked and nothing is unlinked for L. Fails:
   `RM_STAGED_CHANGES` (the view-keyed HEAD map gives U L's blob, T7).
2. GREEN — escaped HEAD lookup in rm.
3. RED `clean-work-tree.test.ts` — Given HEAD and index holding L and U unchanged, When the staged
   check runs, Then no staged-dirty path. Fails: the view-keyed HEAD flatten pairs U with L's id.
4. GREEN — `stagedDirty` on escaped keys.
5. RED interop — S8b: tsgit `repo.rm(['*.txt'])` removes both entries, unlinks U, exit success.
   T22: T10 history on `side`, tsgit `repo.rebase.run({ upstream: 'main' })` (read
   `RebaseNamespace`) refuses with the unstaged-changes error (the absent L is an unstaged
   deletion, §D14) — same verdict as git. Fail before steps 2 / 4.

### Gate
```sh
rm -rf .wireit
npx vitest run test/unit/application/commands/rm.test.ts test/unit/application/commands/internal/clean-work-tree.test.ts test/unit/application/commands/rebase.test.ts
PATH=$HOME/.local/git-2.55.0/bin:$PATH npx vitest run test/integration/index-path-bytes-interop.test.ts test/integration/merge-path-bytes-interop.test.ts test/integration/rm-interop.test.ts
npm run check:types
./node_modules/.bin/biome check src/application/commands/rm.ts src/application/commands/internal/clean-work-tree.ts test/unit/application/commands/rm.test.ts test/unit/application/commands/internal/clean-work-tree.test.ts test/integration/index-path-bytes-interop.test.ts test/integration/merge-path-bytes-interop.test.ts
npm run check:spelling
```

### Commit
`fix(rm): look up lossy entries in HEAD by their escaped path` — no api.json change.

## Part 33 — Brand the merge engine's escaped input

### Context
- `src/domain/diff/flat-tree.ts` — ADD `export type EscapedFlatTree = FlatTree & { readonly
  __keys: 'escaped' }` (phantom, no runtime field). NOT added to src/domain/diff/index.ts.
- `src/application/primitives/flatten-tree.ts` — `flattenEscapedTree` returns
  `Promise<EscapedFlatTree>` (one cast at the boundary, with a comment saying why the keys are
  escaped).
- `src/domain/merge/three-way-tree.ts` — ADD internal `mergeEscapedTrees(base: EscapedFlatTree |
  undefined, ours: EscapedFlatTree | undefined, theirs: EscapedFlatTree | undefined, …rest of
  mergeTrees' parameters)` delegating to `mergeTrees` (680). The PUBLIC `mergeTrees` keeps
  `FlatTree` (DC-6 A). Not added to src/domain/merge/index.ts.
- `src/application/commands/merge.ts` — the `{ base, ours, theirs }` interface (1305-1307) and
  `ourFlat` (1336) become `EscapedFlatTree`; every internal `mergeTrees(` call → `mergeEscapedTrees(`.
- `src/application/primitives/apply-merge-to-worktree.ts` — interface (436-438) to
  `EscapedFlatTree`; `mergeTrees(` → `mergeEscapedTrees(`.
- `test/unit/domain/merge/three-way-tree.test.ts`.

### TDD steps
1. RED `three-way-tree.test.ts` — `mergeEscapedTrees` over escaped twins returns the same result as
   `mergeTrees` (two outcomes `'\uDCFF.txt'`, `'\uFFFD.txt'`). Fails: not exported.
2. GREEN — brand type, `flattenEscapedTree` return type, `mergeEscapedTrees`.
3. REFACTOR — retype the two callers; `check:types` proves no view-keyed `FlatTree` reaches the
   engine through them (a public `flattenTree` result no longer type-checks there). GUARD: merge,
   apply-merge-to-worktree, cherry-pick, stash, rebase suites green.

### Gate
```sh
rm -rf .wireit
npx vitest run test/unit/domain/merge/three-way-tree.test.ts test/unit/application/commands/merge.test.ts test/unit/application/primitives/apply-merge-to-worktree.test.ts test/unit/application/commands/stash.test.ts test/unit/application/commands/rebase.test.ts
npm run check:types
./node_modules/.bin/biome check src/domain/diff/flat-tree.ts src/application/primitives/flatten-tree.ts src/domain/merge/three-way-tree.ts src/application/commands/merge.ts src/application/primitives/apply-merge-to-worktree.ts test/unit/domain/merge/three-way-tree.test.ts
npm run check:spelling
npm run docs:json && git diff --exit-code reports/api.json
```

### Commit
`refactor(merge): brand the merge engine's escaped inputs` — internal brand, no api.json change.

## Part 33b — Brand the rename detector's input

### Context
- `src/application/primitives/detect-merge-renames.ts` — `detectMergeRenames` (153; internal, absent
  from api.json) takes `EscapedFlatTree` for `base`, `ours`, `theirs`. Its callers (merge.ts,
  apply-merge-to-worktree.ts) already pass branded trees after Part 33.
- `test/unit/support/escaped-flat-tree.ts` — CREATE (test helper):
  `escapedFlatTree(entries: Iterable<[string, FlatTreeEntry]>): EscapedFlatTree` (the one cast for
  hand-built fixtures).
- `test/unit/application/primitives/detect-merge-renames.test.ts` — hand-built `FlatTree` fixtures go
  through `escapedFlatTree`.

### TDD steps
1. GUARD — retype the parameter; `npm run check:types` fails on every hand-built fixture until they
   use the helper (the compile error is the expected signal, not a RED test); then the suite is
   green unchanged.
2. REFACTOR — none.

### Gate
```sh
rm -rf .wireit
npx vitest run test/unit/application/primitives/detect-merge-renames.test.ts test/unit/application/commands/merge.test.ts test/unit/application/primitives/apply-merge-to-worktree.test.ts
npm run check:types
./node_modules/.bin/biome check src/application/primitives/detect-merge-renames.ts test/unit/support/escaped-flat-tree.ts test/unit/application/primitives/detect-merge-renames.test.ts
npm run check:spelling
```

### Commit
`refactor(merge): brand the rename detector's escaped inputs` — no api.json change.

## Part 34 — Review leftovers

### Context
Folded elsewhere: (b) → Part 22c, (d) → Part 17, (g) → Part 18a. (e) is already landed:
test/integration/index-path-bytes-interop.test.ts lines 190 and 203 name the result `sut`
(`61cb592c`); nothing to do. Remaining:
- (a) `test/unit/application/commands/commit.test.ts` — `commit.ts:404-413` lossy directory with two
  children (`\xff/x`, `\xff/y`): one tree entry `ff` holding both (kills the surviving
  `typeof name === 'string'` → `true` mutant at `componentKey`).
- (a) `test/unit/application/commands/commit.properties.test.ts` — CREATE if absent: for entries
  from `arbIndexEntryWithPathBytes` (test/unit/domain/git-index/arbitraries.ts) sharing directories,
  the committed tree has no duplicate entry name at any level (50).
- (c, f) `src/application/primitives/walk-tree.ts` — `walkResolved(…, lossyOnly: boolean)` (~301)
  becomes a `ByteChannel = 'none' | 'lossy' | 'all'` field on `WalkConfig` (no boolean parameter);
  the public `walkTree` (285) resolves `'none'` unless `pathBytes: true` (`'all'`),
  `walkTreeWithLossyBytes` `'lossy'`.
- (c) `test/unit/application/primitives/walk-tree.test.ts` — public `walkTree` over a `\xff` name:
  `Object.keys(entry)` has no `pathBytes`.
- (h) `src/domain/git-index/carry-extensions.ts` — `uniqueByKey` (~88): drop the `!byKey.has(key)`
  guard (an equal key means equal bytes and `Map.set` keeps the first insertion position), per the
  equivalent-mutant policy.

### TDD steps
1. GUARD `commit.test.ts` — lossy directory with two children yields one `ff` subtree with `x`, `y`
   (passes since Part 5; pins the mutant).
2. GUARD `commit.properties.test.ts` — no duplicate names (passes).
3. GUARD `walk-tree.test.ts` — public `walkTree` never yields `pathBytes` (passes).
4. REFACTOR `walk-tree.ts` — `ByteChannel`; GUARD: walk-tree suites and step 3 stay green.
5. REFACTOR `carry-extensions.ts` — drop the guard; GUARD: carry-extensions suites green.

### Gate
```sh
rm -rf .wireit
npx vitest run test/unit/application/commands/commit.test.ts test/unit/application/commands/commit.properties.test.ts test/unit/application/primitives/walk-tree.test.ts test/unit/application/primitives/walk-tree.properties.test.ts test/unit/domain/git-index/carry-extensions.test.ts
npm run check:types
./node_modules/.bin/biome check test/unit/application/commands/commit.test.ts test/unit/application/commands/commit.properties.test.ts src/application/primitives/walk-tree.ts test/unit/application/primitives/walk-tree.test.ts src/domain/git-index/carry-extensions.ts
npm run check:spelling
```

### Commit
`refactor(index): close the lossy-path review leftovers` — no api.json change.

## Decision candidates — revision (Parts 16+)

DC6-DC17 are decided (ADRs 975-985). These are new, found while pre-chewing the parts; each
deviates from or completes the design text, so the user decides.

| # | Choice | Alternatives (≤3) | Recommendation | Why |
|---|---|---|---|---|
| DC-3 | `add <pathspec>` never stages deletions (`addByPathspec` returns `removed: []`, src/application/commands/add.ts:475, for every path), so pin S5 (git removes L on `add '*.txt'`) is out of reach of the matching view alone | **A** Part 19c converts only `isRecleaned`; S5 stays a documented gap (backlog: git ≥ 2.0 `add <pathspec>` = `add -A <pathspec>`). **B** Part 19c also stages deletions of matched tracked entries absent from the walk (fixes UTF-8 paths too; pin S5). **C** a separate run for B | **B** | git-faithful for every path and the fold-gaps preference; one function, one part. Proof to produce first in Part 19c's RED: a deleted tracked `a.txt` survives `add(['*.txt'])` today. Cost: a behaviour change of a public command beyond lossy names |
| DC-4 | `MaterializeTreeOpts.paths` is PUBLIC (`reports/api.json` line ~21784); the design retypes it to the internal `ReadonlySet<IndexPathKey>` | **A** keep `ReadonlySet<FilePath>`, compare `escapedPathOf(entry)` (a well-formed path is its own key), TSDoc sentence, api.json regenerated. **B** retype and export `IndexPathKey` publicly (breaking for TypeScript callers passing `Set<FilePath>`). **C** A plus an internal option for escaped keys | **A** | No breaking change; ADR-981 makes the escaped key a `FilePath`-shaped string already. A public caller holding a lone-surrogate string could select a lossy entry, the same residue ADR-985 normalises at command intakes; the primitive is low-level |
| DC-5 | `readHeadTree` is PUBLIC (api.json line ~22016); the design makes it return escaped keys | **A** keep the public view; internal `readHeadTreeEscaped` with its own cache key. **B** switch the public function (lone surrogates reach callers, against ADR-982). **C** one cached escaped flatten, the public function maps keys through `viewOfEscaped` (twins collapse by insertion order) | **A** | ADR-982 keeps escapes off the public surface; two cache keys cost memory only when both are read in one session |
| DC-6 | `mergeTrees` is PUBLIC (api.json line ~57714); the design brands its parameters (Part 33) | **A** keep `mergeTrees(FlatTree…)`; internal `mergeEscapedTrees` wrapper carries the brand; internal callers switch. **B** brand the public signature (breaking: public `flattenTree` results stop compiling there). **C** no brand on `mergeTrees`, brand `detectMergeRenames` only | **A** | Same compile-time proof for every internal route, no public break |
| DC-7 | The design maps the public `diffIndexAgainstTree` / `groupUnmergedEntries` results through `viewOfEscaped` after keying by escaped path; the public `diffIndexAgainstTree` receives view-keyed trees from the public `flattenTree`, so escaped index keys would report L as added and its HEAD view as deleted | **A** public `diffIndexAgainstTree` keeps today's view keying; internal keyed variant for status; public `groupUnmergedEntries` groups by escaped key and reports views. **B** as the design text (behaviour change for public callers with twins). **C** keep both public functions untouched, internal variants only | **A** | A keeps public input/output consistent; grouping depends on the index only, so its twin split is a pure correctness gain |
