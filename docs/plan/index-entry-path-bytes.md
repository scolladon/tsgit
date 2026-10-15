# Plan — byte-exact index entry paths

> Source: design doc `docs/design/index-entry-path-bytes.md` · ADRs 968, 969, 970, 971, 972
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

**Two key schemes, never mixed.**
- Whole-path keys (`IndexPathKey`, Part 3): a round-tripping path is its own key; a lossy path
  is `'\0' + latin1(pathBytes)`. Injective; free for UTF-8. Every `Map`/`Set` on an
  index-writing route keys entries with `indexPathKey(entry)`; a plain string (pathspec,
  working-tree path) is looked up with `keyOfPath(path)` and therefore never addresses a lossy
  entry — correct, a JS string cannot name non-UTF-8 bytes.
- Cache-tree component keys (`cache-tree.ts`, unchanged scheme): `latin1` of the component's
  bytes (ASCII components are their own key).

**Sites deliberately left on the string view** (see Decision candidates DC-1): status
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
