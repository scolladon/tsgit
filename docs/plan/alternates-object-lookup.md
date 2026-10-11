# Plan — alternates-object-lookup

<!-- cspell:ignore backticked BADSIG Cblue Cgreen chflags colours Creset delt ERRSIG EXPKEYSIG EXPSIG GOODSIG handback ltrunc mailmapped MAXSYMLINKS mtrunc pgrep readdirs reencode reprepares REVKEYSIG strwidth uchg unloadable utimes valueonly -->

> Source: design doc `docs/design/alternates-object-lookup.md` (e60c42cf) · ADRs 914–935
> (all accepted; DC-21 → ADR-934 option (a), DC-22 → ADR-935 option (a)) · governing:
> ADR-226 (faithful), ADR-249 (structured output), ADR-509, ADR-625/721, ADR-415..419/765,
> ADR-442, ADR-412 (superseded in part by ADR-919).
> The plan is the implementation script AND the knowledge handoff. Part agents start
> with zero context: whatever a part block omits is paid later as agent rediscovery.

## Sizing rules

- Every part costs a full agent lifecycle — it must earn it. No standalone test-only parts
  for FEATURE code, except interop suites whose rows pin the composition of several earlier
  parts and do not fit the owning part's budget (each such part is named and justified below).
- A part lands in ~100 tool calls, ≤ ~5 RED→GREEN cycles, ≤ 6 files backticked in its
  `### Context` (files it CREATES or EDITS). Read-only references are plain text.
- The design's 30-part split is kept in dependency order; parts whose context exceeded six
  files are split (suffix in the map). Generated artefacts (reports/api.json via
  `npm run docs:json`) are named in plain text, never hand-edited.

## Implementer briefing (applies to every part)

- **Tooling.** You have no MCP tools (no serena, no graft). Navigate with `grep -n`, `sed -n
  'a,bp'` and the line numbers given here; line numbers drift after earlier parts — re-grep the
  symbol name before editing.
- **Existing tests are contracts.** When an existing test row breaks, decide whether the OLD
  expectation encoded the contract. If it did, fix the code, not the row, and say so in your
  handback. The only pre-approved expectation flips are the ones a part names explicitly.
- **ENOTDIR.** `statSync(…, { throwIfNoEntry: false })` swallows ENOTDIR — a probe that must
  refuse `NOT_A_DIRECTORY` uses the throwing helpers (`stat`/`lstat` through the port and
  map the code), never the non-throwing variant.
- **One wireit at a time.** Never run two wireit scripts (`npm run check:types`,
  `npm run check:spelling`, `npm run validate`, …) concurrently in one tree. Wireit may serve a
  cached result: the bypasses are `npx tsc --noEmit -p tsconfig.json` and
  `npx cspell --no-progress <files>`.
- **Scripted edits.** After any `sed`/scripted edit, check `git diff --stat` shows it before
  trusting a gate run on it.
- **Layering.** No `node:` imports outside `src/adapters/`. Dependency rule: repository →
  commands → primitives → domain; domain imports nothing outward.
- **Foreground only.** Poll; never end your turn waiting on a background notification.
- **Interop.** Prefix every integration run with `PATH=$HOME/.local/git-2.55.0/bin:$PATH`
  (local git 2.56 differs from CI's 2.55). git subprocesses run with scrubbed `GIT_*`
  (`runGit`/`git` from test/integration/interop-helpers.ts already do) and signing off
  (`commit.gpgSign=false`, `tag.gpgSign=false` in the fixture config). Build the tsgit `Context`
  (or `openRepository`) **after** the git subprocess writes — the loose fanout listing is cached
  per Context. Each new interop file opens with a `@proves` block shaped like
  test/integration/show-interop.test.ts L12–17 (`surface`, `bucket: cross-tool-interop`,
  `unique`, `interopSurface`). `interopSurface` must name a surface some `@writes` tag declares —
  tooling/audit-write-surfaces.ts reports any other name as orphan coverage. Read-only suites
  reuse the declared surface they exercise (e.g. `packfile`, as
  test/integration/delta-pack-interop.test.ts L9–13 does) or omit `interopSurface`; run
  `node --experimental-strip-types tooling/audit-write-surfaces.ts` and
  `node --experimental-strip-types tooling/audit-test-pyramid.ts` before committing any part that
  creates an interop file.
- **House rules.** GWT split across describe/it (`describe('Given …')` › `describe('When …')` ›
  `it('Then …')`), AAA comments, `sut`. No `@ts-ignore`, `v8 ignore`, `stryker-disable`,
  `biome-ignore`. No phase/ADR/backlog numbers in `src/` or `test/`. Errors asserted by data
  (`try/catch` + `.data`), never `toThrow(Class)` alone. Guards `A || B` get one isolated test
  per condition.
- **Property siblings** (.claude/workflow/property-testing.md): parsers, decoders, matchers,
  serialisers get `*.properties.test.ts` beside the example test; `numRuns` as stated per part.
- **Mutation** (.claude/workflow/mutation.md): each part lists its mutation focus; do not run
  Stryker in-part (validation phase does), but write the isolated tests that kill those mutants.
- **Commit.** One commit per part, the exact message in `### Commit`, only your files
  (`git add <paths>`), never on a red gate, never `--no-verify`.

## Phase gate

`PATH=$HOME/.local/git-2.55.0/bin:$PATH npm run validate` after the last part (and whenever a
part says so). Pre-push additionally runs `check:doc-typedoc`: every part that changes a public
type regenerates reports/api.json with `npm run docs:json` and commits it in the same part.

## Public-surface decisions

| new symbol | decision | part | gates pre-paid in-part |
|---|---|---|---|
| `FileSystem.utimeNow?` (port member) | public (port) | 2 | api.json |
| `ObjectSourceReader`, `ObjectSourceAccess`, `AlternatePathProbe` (port types) | public (named by `Context`) | 9 | `src/ports/index.ts` export, api.json |
| `Context.objectSourceAccess?`, `Context.alternatePathProbe?`, `RuntimeFallback.makeConfinedFs?` | public | 9 | api.json |
| `objectSources`, `ObjectSourcesView`, `AlternateDiagnostic`, `AlternateDiagnosticReason` | public (`repo.primitives.objectSources`) | 10 | primitives barrel, `Repository.primitives` + binding, repository.test sorted keys, docs page + README row, parity scenario call, api.json |
| `FsckFinding` pack-class `objectsDir?` | public (field on an exported type) | 31 | api.json |
| `FORMAT_PLACEHOLDER_UNSUPPORTED` error code + `formatPlaceholderUnsupported` | public (error union) | 51 | `src/domain/error.ts` union, test/unit/domain/exhaustiveness.ts, api.json |
| `ParsedConfig` new keys (`core.abbrev`, `mailmap.*`, `trailer.*`, `gpg.ssh.allowedSignersFile`/`revocationFile`) | public (field on exported type) | 42 | api.json |
| `abbreviateObjectId` | public (`repo.primitives.abbreviateObjectId`) — see DC-P1 | 47 | as `objectSources` |
| everything else (`parseAlternatesFile`, `unquoteCStyle`, `resolveObjectSources`, `ObjectStore`, `getObjectStore`, `locateBlob`, `writeStreamedBlob`, `freshenObject`, `domain/pretty/*`, `domain/mailmap/*`, readers in `internal/`) | internal | — | none (domain barrels are not package entry points; package.json `exports` lists `.`, `./primitives`, `./commands*`, adapters) |

## Decision candidates (plan-level; not pre-decided by ADRs 914–935)

| # | choice | alternatives (≤3) | recommendation | why |
|---|---|---|---|---|
| DC-P1 | `abbreviateObjectId` surface | (a) public `repo.primitives.abbreviateObjectId` as the design states (§D15, Part 19a); (b) internal until a second consumer exists | **(a)** | ADR-249 makes rendering the caller's job; git's unique-abbreviation length is data a caller cannot compute without every source. (b) saves Part 47 but leaves callers re-implementing `odb_find_abbrev_len`. If (b) is chosen, drop Part 47 and nothing else changes |
| DC-P2 | Where the lookup interop rows (design Part 13, non-M5) land | (a) one interop part right after the read paths and enumeration (Part 14); (b) fold each row group into the part whose code it pins (Parts 7–13) | **(a)** | the A/P/R/N/D/U/O rows need the chain, the store, the public view and the read paths together — no single earlier part can run them; folding would put a ~500-line suite into a 6-file part. The M5 stream rows are folded per behaviour (Parts 16, 18, 19, 20, 23, 25) |
| DC-P3 | Where the `export-subst` interop (Pin S, design Part 21) lands | (a) its own part right after the archive expansion (Part 52); (b) inside Part 51 | **(a)** | Part 51 is ~570 src+unit lines; the ~500-line byte-comparison suite would push it past one lifecycle |
| DC-P4 | Placeholder wiring for the domain dependencies (dates, colour, padding, wrap, trailers, decorations) | (a) each dependency part wires its own placeholders into `user-format.ts` with a `user-format.test.ts` row; (b) one wiring part after all dependencies | **(a)** | each RED proves the placeholder end-to-end where its module lands; (b) is a sweeping part (memory hint) |
| DC-P5 | Config keys the expander needs (`core.abbrev`, `mailmap.*`, `trailer.*`, `gpg.ssh.*`) | (a) one config part (Part 42) before their readers; (b) each reader part adds its own keys | **(a)** | `config-read.ts` and its test would otherwise appear in four parts' contexts and blow their file ceilings |

## Stale references fixed (design → plan)

- port `FileSystem.chmod` is at src/ports/file-system.ts **L216** (design: ~L208).
- `OpenBlobSourceOptions` is at internal/blob-source.ts **L86** (design: L84).
- `RuntimeFallback` interface starts at src/repository.ts **L263**; L301 is its `makeWorktreeFs`
  member; the facade's `worktreeFs` closure is at **L609** (cache L602).
- pack-registry.ts has **8** `ctx.fs.` call sites (L409, L413, L510, L535, L544, L578, L586,
  L733), not 10 (L127, L310 are doc comments).
- `ref-target.test.ts` is test/unit/application/primitives/**internal**/ref-target.test.ts;
  `loose-oid-cache.test.ts` is test/unit/application/primitives/loose-oid-cache.test.ts (not
  `internal/`).
- There is no gc-pipeline unit suite: gc rows live in
  test/unit/application/commands/maintenance.test.ts (`runGcTask`, gc-pipeline.ts L839).
- `buildReceivePackRequest`'s `packfile` is **required** in src/domain/protocol/receive-pack.ts
  (L18, L64): the push part makes it optional (design said "check").
- `enumerateObjects` gains `scope` in the enumeration part; gc-pipeline.ts L852 must pass
  `scope: 'local'` **in that same part** (design placed it in Part 11 — a window where gc would
  enumerate donor loose objects).
- `ParsedConfig.gpg.ssh` already exists with `program` only (config-read.ts L193): the new SSH
  keys go inside it.
- DC-21 / DC-22 are listed as candidates in the design's table but are ratified (ADR-934,
  ADR-935, option (a) each).
- archive.ts `buildEntryStream` is at **L106** (design: L104–118 and L106–119 in two places).

## Map of parts

| plan | design | title | size (src / test) |
|---|---|---|---|
| 1 | 1 | alternates file parser | 150 / 350 |
| 2 | 2 (i) | `utimeNow` port member + Node adapter | 40 / 90 |
| 3 | 2 (ii) | `utimeNow` memory adapter + shared contract | 15 / 110 |
| 4 | 2 (iii) | `utimeNow` through the validator; browser absence | 15 / 60 |
| 5 | 3 (i) | source location types, path helpers, per-location loose cache | 60 / 80 |
| 6 | 3 (ii) | pack registry family reads through a location | 60 / 40 |
| 7 | 4 | alternate chain resolution | 220 / 450 |
| 8 | 5 (i) | `ObjectStore` memo, `bigFileThreshold`, `objectSources` view | 200 / 250 |
| 9 | 5 (ii) | confined per-alternate capability (facade + Node hook) | 80 / 150 |
| 10 | 5 (iii) | publish `repo.primitives.objectSources` | 20 / 60 + docs |
| 11 | 6 (i) | object resolver + metadata + rescan through the chain | 140 / 220 |
| 12 | 6 (ii) | in-core blob open, `hasObject`, `fetchMissing` through the chain | 90 / 180 |
| 13 | 7 (+11 scope) | enumeration and prefix resolution per source | 100 / 200 |
| 14 | 13 (non-M5) | lookup interop | — / 500 |
| 15 | 6b (i) | streamed blob open in git's stream order | 150 / 300 |
| 16 | 6b (ii) | declared header + `verifyStoredObject` order + stream interop M5a–M5m | 40 / 120 + 300 |
| 17 | 6c (i) | every-source gate + `catFileBatch` | 60 / 150 |
| 18 | 6c (ii) | `show` / `archive` stream routing + interop M5n–M5s | 40 / 150 + 150 |
| 19 | 6c (iii) | `buildPack` gate + base-entry routing + `deltify` + interop M5u–M5w | 50 / 150 + 100 |
| 20 | 6c (iv) | delete-only `push` sends no pack + interop M5ae/M5af | 15 / 60 + 60 |
| 21 | 22 | `merge` writes `ORIG_HEAD` before the outcome | 15 / 150 + 150 |
| 22 | 6d (i) | `writeStreamedBlob` + the checkout write path | 70 / 170 |
| 22b | 6d (i) | merge / stash streamed writers | 15 / 60 |
| 23 | 6d (ii) | sequential write wave under an unloadable source + interop M5i, M5x–M5ab | 30 / 100 + 200 |
| 24 | 6d (iii) | every-source gate in cherry-pick / revert / rebase | 20 / 120 |
| 25 | 6d (iv) | every-source gate in merge / detached checkout + interop M5ac/M5ad | 15 / 80 + 100 |
| 26 | 8 | freshen in `writeObject` + interop | 130 / 350 + 400 |
| 27 | 9 | commit-graph per source + interop CG | 120 / 300 + 250 |
| 28 | 10 | bitmaps per source + interop BM | 50 / 250 + 150 |
| 29 | 11 (+14 G) | gc / prune with alternates + interop G | 60 / 200 + 150 |
| 30 | 12 (i) | fsck universe + content validation per source | 80 / 150 |
| 31 | 12 (ii) | fsck pack-class passes per source + `objectsDir` attribution | 80 / 150 |
| 32 | 12 (iii) | fsck bitmap order + docs + interop F | 40 / 100 + 200 |
| 33 | 15 | directory-only attribute patterns + tree attribute provider | 90 / 300 |
| 34 | 16 | `archive` honours `export-ignore` + interop E | 90 / 350 + 250 |
| 35 | 17a (i) | commit view + ident parsing (domain) | 120 / 250 |
| 36 | 17a (ii) | subject helpers + user-format tokenizer/interpreter | 220 / 350 |
| 37 | 17a (iii) | `$Format:` scanner + pretty barrel | 50 / 150 |
| 38 | 17b | date modes | 250 / 400 |
| 39 | 17c (i) | display-width tables + generator | 220 / 100 |
| 40 | 17c (ii) | colour + `%w` wrap | 150 / 240 |
| 41 | 17c (iii) | padding / column placeholders | 100 / 180 |
| 42 | 18a/19a/19b (config) | config keys for the expander | 40 / 120 |
| 43 | 18a | trailers | 250 / 450 |
| 44 | 18b (i) | decorations formatter | 100 / 180 |
| 45 | 18b (ii) | mailmap domain | 100 / 170 |
| 46 | 19a (i) | `abbreviateObjectId` | 90 / 180 |
| 47 | 19a (ii) | publish `repo.primitives.abbreviateObjectId` | 15 / 50 + docs |
| 48 | 19a (iii) | ref decorations + mailmap reader | 170 / 220 |
| 49 | 19b | signature verification | 320 / 450 |
| 50 | 20 | commit-encoding round trip | 150 / 250 |
| 51 | 21 (i) | `archive` expands `export-subst` (+ refusal error code) | 170 / 400 |
| 52 | 21 (ii) | `export-subst` interop (Pin S) | — / 500 |
| 53 | 23 | delta search skips objects above `core.bigFileThreshold` | 25 / 150 + 100 |
| 54 | 14 (parity) | parity rows with alternates | — / 120 |
| 55 | §Perf, 14 (bench) | `bench:ab` rows and measurement | — / 150 |

Dependency notes: 21 lands before 25 (the merge gate follows the `ORIG_HEAD` write); 13 before
14 (X rows) and 46 (exported scans); 22 before 22b; 36 needs 35; 37 needs 36; 38, 40, 41, 43, 44
need 36; 41 needs 39; 46 needs 13 and 42; 48 and 49 need 42; 50 needs 37; 51 needs 17–18 and
33–50; 52 needs 51; 53 needs 8; 54 needs 10–12. The `FORMAT_PLACEHOLDER_UNSUPPORTED` error moves
from design Part 17a to Part 51, where it is first thrown (the domain returns a refusal value).
Total: 56 parts (1–55 plus 22b).

## Part 1 — alternates file parser (design Part 1)

### Context
- Design §D1 (L711–739) and Pin P (L220–238): every row P1–P14 is a literal-bytes example.
- Creates `src/domain/storage/alternates.ts`:
  `export const parseAlternatesFile = (bytes: Uint8Array): ReadonlyArray<Uint8Array>` and
  `export const unquoteCStyle = (bytes: Uint8Array, start: number): { readonly value: Uint8Array; readonly end: number } | undefined`.
  Rules (odb.c `parse_alternates`, quote.c `unquote_c_style`): stop at first NUL; `#` at
  column 0 → comment to next `\n`; `"` → `unquoteCStyle` (escapes `\a \b \f \n \r \t \v \\ \"`
  and 3-digit octal with first digit 0–3; anything else → `undefined` → verbatim fallback),
  `end` after the closing quote, quoted span may contain raw `\n`; otherwise bytes to next `\n`
  verbatim, no trimming; after an entry skip exactly one byte; empty entries skipped. Named
  byte constants (no magic values).
- Edits `src/domain/storage/index.ts` — named exports under a `// Alternates` comment, in the
  file's style (`export { parseAlternatesFile, unquoteCStyle } from './alternates.js';`, first
  section, alphabetical by comment).
  Internal: src/domain/index.ts re-exports storage, but the domain barrel is no package entry.
- Creates `test/unit/domain/storage/alternates.test.ts` and
  `test/unit/domain/storage/alternates.properties.test.ts`; extends
  `test/unit/domain/storage/arbitraries.ts` with an alternates-file byte generator and a
  test-side C-quoter (independent of `unquoteCStyle`).
- No I/O, no `node:`, no strings in the API (bytes in, bytes out).

### TDD steps
1. RED `alternates.test.ts`: `Given an alternates file › When parsing P1 (comment, blank, plain
   entries) › Then the entries in file order without trimming` — fails: module missing.
   GREEN: line splitter + comment + empty skip.
2. RED P5–P9 quoted rows (`Given a C-quoted entry › When parsing › Then the unquoted bytes`;
   a raw `\n` inside quotes; broken quoting → verbatim line) and direct `unquoteCStyle` rows per
   escape class, octal `\101`, first digit `4` → `undefined`, unterminated → `undefined`.
   GREEN: `unquoteCStyle`.
3. RED P12 (byte after a closing quote skipped whatever it is), P13 (NUL stops the scan), P10/P11
   (leading spaces / `#` not at column 0 kept). GREEN: the one-byte skip + NUL stop.
4. RED `alternates.properties.test.ts`: lens 3 totality — never throws on arbitrary bytes
   (numRuns 200); lens 4 counting — k column-0 non-`#`, non-`"`, NUL-free non-empty lines ↔ k
   entries (100); lens 1 round trip — test-side C-quote of paths without `\n` parses back to the
   path (200). GREEN: fix whatever the properties expose.
- REFACTOR: small functions (<20 lines), named constants for `#`, `"`, `\\`, `\n`, NUL.
- Mutation focus: the octal first-digit bound (`<= 3`), `end` after the closing quote, the
  one-byte skip, `start === length` edges; `if (entry.length === 0)` needs its own row.

### Gate
```
npx vitest run --project unit test/unit/domain/storage/alternates.test.ts test/unit/domain/storage/alternates.properties.test.ts && npm run check:types && ./node_modules/.bin/biome check src/domain/storage/alternates.ts src/domain/storage/index.ts test/unit/domain/storage && npm run check:spelling
```

### Commit
`feat(storage): parse objects/info/alternates as git does`

## Part 2 — `utimeNow` port member + Node adapter (design Part 2, first half)

### Context
- Design §D11 (L1335–1381). Public: optional member on the public `FileSystem` port
  (`atomicRename` precedent) → regenerate reports/api.json (`npm run docs:json`) and commit it.
- Edits `src/ports/file-system.ts` — `FileSystem` (L50–273): add after `chmod` (L216) the
  documented `readonly utimeNow?: (path: string) => Promise<void>;` (doc text verbatim from §D11).
- Edits `src/adapters/node/node-file-system.ts` — `utimeNow` arrow member modelled on `chmod`
  (L1543–1550): `resolveWrite(path)` → `assertLeafSafeToWrite(real, path)` (symlink leaf →
  PERMISSION_DENIED) → `runFs(() => this.fsOps.utimes(real, now, now), path)`, `now = new Date()`.
- Edits `src/adapters/node/fs-operations.ts` — `FsOperations` Pick (L24): add `'utimes'`.
- Edits `cspell.json` — insert `utimes` in place, alphabetical position; never re-sort the file.
- Edits `test/unit/adapters/node/node-file-system-injected.test.ts` — injected-`fsOps` rows.
- Browser adapter (src/adapters/browser/browser-file-system.ts) gets **no** member (Part 4 pins
  the absence).

### TDD steps
1. RED `node-file-system-injected.test.ts`: `Given an injected fsOps whose utimes rejects with
   EACCES › When utimeNow(file) › Then the rejection carries the runFs-mapped code and
   data.path` — fails: `utimeNow` undefined. GREEN: port member + `FsOperations` + Node impl.
2. RED same file: `Given an injected fsOps › When utimeNow(file) › Then utimes is called once
   with the resolved real path and two equal Date instances`. GREEN: as above.
3. RED: `Given a symlink leaf › When utimeNow › Then PERMISSION_DENIED and utimes never
   called` (mirror the chmod symlink row's setup in the same file if it exists; else use the
   adapter's leaf check). GREEN.
- REFACTOR: share nothing with `chmod` beyond the existing helpers; keep the member <20 lines.
- Regenerate api.json: `npm run docs:json`, then `git diff --stat reports/api.json` non-empty.
- Mutation focus: the `assertLeafSafeToWrite` call (remove-call mutant), `now, now` argument pair.

### Gate
```
npx vitest run --project unit test/unit/adapters/node/node-file-system-injected.test.ts && npm run check:types && ./node_modules/.bin/biome check src/ports/file-system.ts src/adapters/node/node-file-system.ts src/adapters/node/fs-operations.ts test/unit/adapters/node/node-file-system-injected.test.ts && npm run check:spelling
```

### Commit
`feat(fs): add an optional utimeNow port operation with a Node implementation`

## Part 3 — `utimeNow` memory adapter + shared contract (design Part 2, second half)

### Context
- Edits `src/adapters/memory/memory-file-system.ts` — `utimeNow` modelled on `chmod`
  (L424–429): `walk(path, 'no-follow')`; symlink leaf → `permissionDenied`; unoccupied →
  `fileNotFound`; else private `touch(normalized)` (L617; already sets `ctimeMs`/`mtimeMs` to
  `Date.now()`). Directories resolve (touch the dir entry).
- Edits `test/unit/ports/file-system.contract.ts`:
  - `FileSystemContractEnv` (L6–33) gains `readonly createBackdatedFile?: (path: string) =>
    Promise<void>` (documented like `symlinkReadEscape`).
  - helper `utimeNow(fs, p)` beside `lexists` (L179) that throws when the member is absent.
  - `pathCalls` (L48–~90): add `{ name: 'utimeNow', invoke: (e, p) => utimeNow(e.fs, p) }` so
    the security matrix (L1531) covers `..` traversal + sibling directory.
  - new block beside the `chmod` rows (L2000–2050).
- Edits `test/unit/adapters/memory/memory-file-system.test.ts` — env hook: write the file under
  `vi.setSystemTime(new Date('2001-01-01'))`, then `vi.useRealTimers()`.
- Edits `test/unit/adapters/node/node-file-system.test.ts` — env hook: write + `node:fs`
  `utimesSync` to 2001 (test code may import `node:`).

### TDD steps
1. RED contract: `Given a back-dated regular file › When utimeNow › Then stat().mtimeMs
   advances past the back-dated value` — fails on memory (member missing). GREEN: memory impl +
   env hooks.
2. RED contract: `Given a directory › When utimeNow › Then it resolves`; `Given a symlink
   leaf › … › Then PERMISSION_DENIED (data.code) and the target's mtime unchanged`; `Given a
   missing path › … › Then FILE_NOT_FOUND`. GREEN.
3. RED: security matrix picks up `utimeNow` via `pathCalls` (2 rows × 2 adapters). GREEN: none
   expected beyond the Node write guard; if Node fails, fix the adapter, not the row.
- Mutation focus: the symlink-leaf arm vs unoccupied arm order in memory (one test each).

### Gate
```
npx vitest run --project unit test/unit/adapters/memory/memory-file-system.test.ts test/unit/adapters/node/node-file-system.test.ts && npm run check:types && ./node_modules/.bin/biome check src/adapters/memory/memory-file-system.ts test/unit/ports/file-system.contract.ts test/unit/adapters/memory/memory-file-system.test.ts test/unit/adapters/node/node-file-system.test.ts && npm run check:spelling
```

### Commit
`feat(fs): implement utimeNow on the memory adapter and pin it in the port contract`

## Part 4 — `utimeNow` through the validator; browser absence (design Part 2, tail)

### Context
- Edits `src/repository/wrap-fs-validator.ts` — `guardedUtimeNow(fs, guard): Pick<FileSystem,
  'utimeNow'>` beside `guardedAtomicRename` (L97–110): `{}` when absent; else forwards behind the
  **write** guard; spread beside `...guardedAtomicRename(fs, guard)` (L245).
- Edits `test/unit/repository/wrap-fs-validator.test.ts` — rows next to the atomicRename rows.
- Edits `test/unit/adapters/browser/browser-file-system.test.ts` — copy the L8–15
  `atomicRename` structural-absence row for `utimeNow`.
- Edits `test/unit/ports/file-system.test.ts` — the L56 pattern: a double omitting `utimeNow`
  type-checks as a `FileSystem`.

### TDD steps
1. RED `wrap-fs-validator.test.ts`: `Given an fs with utimeNow › When wrapped › Then utimeNow is
   forwarded with the path` — fails: not spread. GREEN: `guardedUtimeNow`.
2. RED: `Given an fs without utimeNow › When wrapped › Then 'utimeNow' in sut is false`;
   `Given a path outside the roots › When utimeNow › Then PERMISSION_DENIED before delegating
   (inner spy not called)`. GREEN.
3. RED browser absence + port double rows (pass once compiled; they pin the contract).
- Mutation focus: `if (utimeNow === undefined) return {}` (own row), guard call before delegate.

### Gate
```
npx vitest run --project unit test/unit/repository/wrap-fs-validator.test.ts test/unit/adapters/browser/browser-file-system.test.ts test/unit/ports/file-system.test.ts && npm run check:types && ./node_modules/.bin/biome check src/repository/wrap-fs-validator.ts test/unit/repository/wrap-fs-validator.test.ts test/unit/adapters/browser/browser-file-system.test.ts test/unit/ports/file-system.test.ts && npm run check:spelling
```

### Commit
`feat(fs): forward utimeNow through the containment validator behind the write guard`

## Part 5 — source location types, path helpers, per-location loose cache (design Part 3, first half)

### Context
- Design §D3 (L807–891), ADR-918. Behaviour-preserving: no existing expectation changes.
- Creates `src/ports/object-source-access.ts` with `ObjectSourceReader` (Pick of `read`,
  `readUtf8`, `readSlice`, `readdir`, `stat`, `lstat`, `exists`, `readlink`,
  `openWithNoFollow`), `ObjectSourceAccess = ObjectSourceReader & Pick<FileSystem, 'utimeNow'>`,
  `AlternatePathProbe = Pick<FileSystem, 'lstat' | 'readlink' | 'stat'>`. Not yet barrel-exported
  (Part 9 does, when `Context` names them).
- Creates `src/application/primitives/internal/source-location.ts`:
  `export interface SourceLocation { readonly objectsDir: string; readonly fs: ObjectSourceAccess }`.
- Edits `src/application/primitives/path-layout.ts`: add `looseObjectPathIn(objectsDir, id)`
  and `packsDirIn(objectsDir)` beside `looseObjectPath` (L51) / `packsDir` (L77); existing
  helpers unchanged.
- Edits `src/application/primitives/internal/loose-oid-cache.ts`: `probeLooseOid(ctx, id)` (L72),
  `invalidateLooseOid` (L85), `forgetLooseOidPrefix` (L100) gain optional `location?:
  SourceLocation`. Absent → today's session-keyed map untouched (hot path byte-identical).
  Present → a second `WeakMap<SourceLocation, Map<prefix, Set<string>>>` keyed by **object
  identity**, listing `location.objectsDir/<xx>` through `location.fs.readdir`. Never key by a
  per-call literal.
- Edits `test/unit/application/primitives/path-layout.test.ts` and
  `test/unit/application/primitives/loose-oid-cache.test.ts`.

### TDD steps
1. RED path-layout: `Given an objects dir › When looseObjectPathIn / packsDirIn › Then
   '<dir>/<xx>/<rest>' / '<dir>/pack'`. GREEN.
2. RED loose-oid-cache: `Given a location whose fs holds a loose object › When probeLooseOid(ctx,
   id, location) › Then true, and the primary listing is not consulted (spy on ctx.fs.readdir)`.
   GREEN: the location-keyed map.
3. RED: `Given the same location object probed twice › Then one readdir`; `Given two equal
   literals › Then two readdirs` (pins identity keying); `invalidateLooseOid(ctx, id, location)`
   forgets only that location's entry. GREEN.
- Mutation focus: the `location === undefined` branch (primary vs location map, one row each).

### Gate
```
npx vitest run --project unit test/unit/application/primitives/path-layout.test.ts test/unit/application/primitives/loose-oid-cache.test.ts && npm run check:types && ./node_modules/.bin/biome check src/ports/object-source-access.ts src/application/primitives/internal/source-location.ts src/application/primitives/path-layout.ts src/application/primitives/internal/loose-oid-cache.ts test/unit/application/primitives/path-layout.test.ts test/unit/application/primitives/loose-oid-cache.test.ts && npm run check:spelling
```

### Commit
`refactor(objects): introduce source locations and a per-location loose cache`

## Part 6 — pack registry family reads through a location (design Part 3, second half)

### Context
- Behaviour-preserving; the existing pack/midx suites stay green unedited.
- Edits `src/application/primitives/pack-registry.ts`: `createPackRegistry(ctx: Context)` (L841)
  → `createPackRegistry(ctx: Context, location?: SourceLocation)`, default `{ objectsDir:
  `${commonGitDir(ctx)}/objects`, fs: ctx.fs }`. Replace the 8 `ctx.fs.` sites (L409, L413, L510,
  L535, L544, L578, L586, L733) with `location.fs.` and the 3 `packsDir(commonGitDir(ctx))` sites
  (L731 `listPackDir`, L761 `createStoreGate`, L881 `scanPacks`) with
  `packsDirIn(location.objectsDir)`. Config, logger, session stay on `ctx`. Thread `location`
  (not `fs` alone) through the private helpers.
- Edits `src/application/primitives/internal/midx-source.ts`: `loadMidxSet(ctx, packsDir,
  listing)` (L388) gains `fs: ObjectSourceReader`; its 5 `ctx.fs` sites (L151, L181, L268, L276,
  L321) read through it.
- Edits `src/application/primitives/internal/pack-artefact-source.ts` (3 `ctx.fs` sites) and
  `src/application/primitives/internal/pack-byte-source.ts` (2) the same way.
- Edits `test/unit/application/primitives/pack-registry.test.ts`.

### TDD steps
1. RED pack-registry.test: `Given a location whose fs holds a pack under another objects dir ›
   When createPackRegistry(ctx, location).lookup(id) › Then the entry is found, and ctx.fs is
   never read (spy)` — fails: second parameter ignored. GREEN: thread the location.
2. RED: `Given a location with a multi-pack-index › When lookup › Then served via the midx read
   through location.fs`. GREEN: `loadMidxSet` `fs` parameter.
3. Run the whole pack/midx/object suites (`npx vitest run --project unit
   test/unit/application/primitives`) — must stay green unedited.
- Mutation focus: none new (substitution); keep the default-location row.

### Gate
```
npx vitest run --project unit test/unit/application/primitives && npm run check:types && ./node_modules/.bin/biome check src/application/primitives/pack-registry.ts src/application/primitives/internal/midx-source.ts src/application/primitives/internal/pack-artefact-source.ts src/application/primitives/internal/pack-byte-source.ts test/unit/application/primitives/pack-registry.test.ts && npm run check:spelling
```

### Commit
`refactor(pack): read every pack artefact through an explicit source location`

## Part 7 — alternate chain resolution (design Part 4)

### Context
- Design §D2 (L741–806), Pins R (L239), N (L252), D (L265), U (L275); ADR-914, 916, 917, 923, 924.
- Creates `src/application/primitives/internal/alternate-chain.ts` exporting
  `AlternateDiagnosticReason` (`'unresolvable' | 'not-a-directory' | 'unreadable-list' |
  'nesting-too-deep' | 'unreachable'`), `AlternateDiagnostic { reason, path, listedIn, code? }`,
  `ObjectSourceSpec { objectsDir, local, depth }`, `AlternateChainIo { probe(path):
  AlternatePathProbe; reader(objectsDir): ObjectSourceReader }`, `resolveObjectSources(ctx, io)
  → Promise<{ sources; diagnostics }>`, and the port realpath walk
  `realpathAllowingMissingLeaf(probe, path)` (lstat + readlink per component; only the last
  component may be missing; symlink loops bounded — reuse the adapter's loop limit constant if
  exported, else a named `MAX_SYMLINK_HOPS = 40` matching Linux `MAXSYMLINKS`).
- Algorithm (pseudocode §D2 L775–790): DFS pre-order; whole list normalised first (U1 emitted
  there); depth check `holderDepth + 1 > 5 && paths.length > 0` → `nesting-too-deep`; per path:
  `isDirectory` → else `not-a-directory`; self/duplicate silent; `FILE_NOT_FOUND` /
  `NOT_A_DIRECTORY` on the list → `[]`; other list error → `unreadable-list` with `code`; adapter
  refusal on probe → `unreachable` with `code`; non-UTF-8 entry → `unresolvable`.
  Relative entries join `realpath(holder) + '/' + entry`; absolute via `isAbsolutePath`
  (src/application/primitives/internal/absolute-path.ts). Trailing `/` trimmed.
- Path equality honours `core.ignoreCase` (read once via `readConfig`, as
  src/application/primitives/walk-working-tree.ts does): exact or ASCII case-insensitive.
- Uses `parseAlternatesFile` (Part 1); decodes entries with `TextDecoder('utf-8', { fatal: true })`.
- `ctx.logger?.warn` once per diagnostic (ADR-914) — message names reason + path, no file bytes.
- Creates `test/unit/application/primitives/internal/alternate-chain.test.ts` and
  `test/unit/application/primitives/internal/alternate-chain.properties.test.ts` (memory
  adapter Contexts; the memory adapter supports symlinks; `io` built from `ctx.fs`).
- Internal module.

### TDD steps
1. RED realpath walk: `Given a path through a symlinked directory › When
   realpathAllowingMissingLeaf › Then the resolved path`; missing leaf tolerated (R3), missing
   middle component → `undefined` (R4); loop → `undefined`. GREEN.
2. RED Pins R/N: relative entry resolved against the realpath of the holder (R1, R2, R5–R8);
   six levels reachable, the seventh reported `nesting-too-deep` on its holder (N1–N4; N3/N4
   placement: only normalised entries count). GREEN.
3. RED Pin D + O1: self entry and duplicates silent, cycle terminates, pre-order DFS order;
   `core.ignoreCase=true` merges `/A/objects` and `/a/objects`, false keeps both. GREEN.
4. RED Pin U: `unresolvable` (U1), `not-a-directory` (U2), `unreadable-list` with code (U3),
   `unreachable` when the memory adapter refuses an out-of-root path (ADR-916), non-UTF-8 entry
   → `unresolvable`; each emits one `logger.warn` (spy). GREEN.
5. RED properties (lens 2, numRuns 100): for an arbitrary directed graph of alternates files —
   terminates; `objectsDir`s distinct; every node within six levels appears; each source after
   the source whose list named it first; depth ≤ 5. No re-implemented traversal as oracle.
- Mutation focus: `> 5` boundary (rows at depth 5 and 6), `paths.length > 0` conjunct (own
  row), the is-directory-before-seen order (U2 on a duplicate path), ignoreCase branch.

### Gate
```
npx vitest run --project unit test/unit/application/primitives/internal/alternate-chain.test.ts test/unit/application/primitives/internal/alternate-chain.properties.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/primitives/internal/alternate-chain.ts test/unit/application/primitives/internal/alternate-chain.test.ts test/unit/application/primitives/internal/alternate-chain.properties.test.ts && npm run check:spelling
```

### Commit
`feat(objects): resolve the alternates chain as git does`

## Part 8 — `ObjectStore` memo, `bigFileThreshold`, `objectSources` view (design Part 5, core)

### Context
- Design §D3 (L807–891), ADR-918, ADR-924. Resolution from Part 7, registries from Part 6.
- Creates `src/application/primitives/object-store.ts` exporting `ObjectSource extends
  SourceLocation { local; registry }`, `ObjectStore { sources; primary; diagnostics;
  bigFileThreshold; refresh(): void; reprepare(): Promise<void>; dispose(): Promise<void> }`,
  `getObjectStore(ctx)`, `peekObjectStore(ctx)` (gated on `repoSettingsVerdictSettled`, as
  read-object.ts L77–112 does for the registry), `objectSources(ctx): Promise<ObjectSourcesView>`
  with `ObjectSourcesView = { sources: ReadonlyArray<{ objectsDir; local }>; unusable:
  ReadonlyArray<AlternateDiagnostic> }` (ADR-914), and `narrowObjectSourceAccess(fs, objectsDir):
  ObjectSourceAccess` — a fresh object carrying exactly the `ObjectSourceAccess` members bound to
  `fs`; `openWithNoFollow(p, 'write')` → `permissionDenied`; `utimeNow` (when `fs` has it)
  wrapped in a lexical check: path under `objectsDir`, no `..` segment, else `permissionDenied`.
  The store's alternates use `narrowObjectSourceAccess(ctx.fs, dir)` and the probe `ctx.fs`
  narrowed to `AlternatePathProbe` (Part 9 adds the Context hooks in front).
- Construction: `Promise.all([createPackRegistry(ctx, primaryLocation), read the primary
  info/alternates, readBigFileThreshold(ctx)])`; FILE_NOT_FOUND ⇒ `[primary]`, no more I/O;
  alternates' registries built only when resolution yields alternates. Memo per session (same
  WeakMap/session key read-object.ts uses for `resolvedRegistries`). `refresh()` sync: primary
  `registry.refresh()` + mark list stale; next `getObjectStore` re-resolves and **appends**
  newly-usable sources (existing sources/registries survive). Threshold not re-read on refresh.
- Edits `src/application/primitives/read-object.ts`: `getPackRegistry` (L76), `peekPackRegistry`
  (L112), `refreshPackRegistry` (L122) keep their signatures and act on `store.primary.registry`;
  `disposePackRegistry` (L139) → `store.dispose()` (alternate registries hold FileHandles).
  read-object imports object-store, never the reverse (object-store builds the primary registry
  itself with `createPackRegistry`).
- Creates `src/application/primitives/internal/big-file-threshold.ts`:
  `DEFAULT_BIG_FILE_THRESHOLD_BYTES` (moved) + `readBigFileThreshold(ctx) =
  (await readConfig(ctx)).core?.bigFileThreshold ?? DEFAULT`.
- Edits `src/application/commands/internal/fsck/read-configuration.ts` (L22 constant removed;
  L48 imports it from the new module) and
  `test/unit/application/commands/internal/fsck/content-validation.test.ts` (L7 import path).
- Creates `test/unit/application/primitives/object-store.test.ts` (memory Contexts with a
  hand-written objects/info/alternates file).

### TDD steps
1. RED object-store.test: `Given no alternates file › When getObjectStore › Then sources = [primary]
   with fs === ctx.fs, diagnostics [], and one read of info/alternates`; `Given one alternate ›
   Then two sources in order, the alternate local=false`. GREEN: store + memo.
2. RED: `Given the same session › When getObjectStore twice › Then the same instance`;
   `peekObjectStore` undefined before settle, the instance after; `getPackRegistry(ctx) ===
   store.primary.registry`; `disposePackRegistry` disposes every registry (spies). GREEN: re-point
   read-object.ts.
3. RED: `Given an alternate added after first resolution › When refresh() then getObjectStore ›
   Then it is appended and the first alternate's registry instance survives`; `Given an alternate
   removed › Then it stays (add-only)`. GREEN.
4. RED threshold: default when unset; configured value; not re-read on `refresh()` (spy
   `readConfig` count). GREEN: big-file-threshold module + fsck import move (fsck suites green).
5. RED view + narrowing: `objectSources` → `{ sources: [{ objectsDir, local }], unusable }`;
   `Object.keys(narrowObjectSourceAccess(fs, d)).sort()` equals the `ObjectSourceAccess` member
   list (without `utimeNow` when `fs` lacks it); write-mode open → PERMISSION_DENIED (data.code,
   data.path); `utimeNow('<d>/../x')` and a path outside `d` → PERMISSION_DENIED, inner spy not
   called. GREEN.
- Mutation focus: add-only append (row where the old list shrinks), the `..` segment check vs the
  prefix check (one row each), `utimeNow` presence conditional.

### Gate
```
npx vitest run --project unit test/unit/application/primitives/object-store.test.ts test/unit/application/commands/internal/fsck test/unit/application/primitives/read-object.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/primitives/object-store.ts src/application/primitives/read-object.ts src/application/primitives/internal/big-file-threshold.ts src/application/commands/internal/fsck/read-configuration.ts test/unit/application/primitives/object-store.test.ts test/unit/application/commands/internal/fsck/content-validation.test.ts && npm run check:spelling
```

### Commit
`feat(objects): hold every object source in a session store`

## Part 9 — confined per-alternate capability (design Part 5, capability)

### Context
- Design §D3 "Capability construction" (L847–866), ADR-915, ADR-916, D9 security (L1292–1327).
- Public: `Context` and `RuntimeFallback` gain optional members; port types exported →
  regenerate reports/api.json (`npm run docs:json`).
- Edits `src/ports/context.ts` — `Context` (L251): beside `worktreeFs` (L328) add
  `readonly objectSourceAccess?: (objectsDir: string) => ObjectSourceAccess;` and
  `readonly alternatePathProbe?: (path: string) => AlternatePathProbe;` (doc comments: confined,
  read-only + `utimeNow`; metadata-only).
- Edits `src/ports/index.ts` — export the three types from './object-source-access.js' beside the
  `FileSystem` export (L16).
- Edits `src/repository.ts` — `RuntimeFallback` (L263) gains
  `readonly makeConfinedFs?: (roots: ReadonlyArray<string>) => FileSystem;` (beside
  `makeWorktreeFs`, L301). In the facade beside `worktreeFs` (L602–625): `objectSourceAccess`
  memoised per `objectsDir` (like `worktreeFsCache`) = `narrowObjectSourceAccess(raw, objectsDir)`
  with `raw = fallback.makeConfinedFs?.([objectsDir]) ?? detected.fs` (no layout roots);
  `alternatePathProbe(path)` = the hook rooted at the path's filesystem root (POSIX root, drive root or
  UNC share — derive with a small pure helper) narrowed to lstat, readlink and stat, else `detected.fs`
  narrowed. `opts.unsafeRawAdapters === true` still narrows (narrowing is not containment).
- Edits `src/index.node.ts` — `makeConfinedFs` beside `makeWorktreeFs` (L175): the same
  `NodeFileSystem` construction rooted at `roots`.
- Edits `src/application/primitives/object-store.ts` — prefer `ctx.objectSourceAccess?.(dir)` /
  `ctx.alternatePathProbe?.(p)` over the Part 8 fallbacks.
- Creates `test/unit/repository/object-source-access.test.ts` (node adapter on a mkdtemp dir
  under the OS temp dir + memory adapter, via `openRepository`).
- Memory/browser entry points unchanged (no hook → narrowed `detected.fs`).

### TDD steps
1. RED: `Given a node repository › When ctx.objectSourceAccess(dir) › Then its own keys are
   exactly the ObjectSourceAccess members` and `openWithNoFollow(p, 'write')` → PERMISSION_DENIED.
   GREEN: Context members + facade.
2. RED: `Given a node repository and an alternate objects dir outside the work tree › When
   utimeNow on a file outside that objects dir (sibling) › Then PERMISSION_DENIED` (adapter
   write guard) and inside → mtime advances. GREEN: `makeConfinedFs` in index.node.ts.
3. RED: memo identity per `objectsDir`; `Given a memory repository › When the store resolves an
   out-of-root alternate › Then objectSources().unusable = [{ reason: 'unreachable', … }]`. GREEN.
4. RED: `alternatePathProbe` root derivation helper — POSIX `/x/y` → `/`, `C:\x` → `C:\`,
   `\\srv\share\x` → `\\srv\share\` (pure unit rows in the same file). GREEN.
- Security (D9): the capability must never expose `write*`, `rm*`, `mkdir`, `rename`, `chmod`,
  `symlink`; the key-set row pins it.
- Mutation focus: the memo hit branch, the hook-absent fallback (row each).

### Gate
```
npx vitest run --project unit test/unit/repository/object-source-access.test.ts test/unit/repository/repository.test.ts test/unit/application/primitives/object-store.test.ts && npm run check:types && ./node_modules/.bin/biome check src/ports/context.ts src/ports/index.ts src/repository.ts src/index.node.ts src/application/primitives/object-store.ts test/unit/repository/object-source-access.test.ts && npm run check:spelling
```

### Commit
`feat(repository): give each alternate a capability confined to its objects dir`

## Part 10 — publish `repo.primitives.objectSources` (design Part 5, surface)

### Context
- Public Tier-2 primitive (.claude/workflow/surface-gates.md): every gate pre-paid here.
- Edits `src/application/primitives/index.ts` — `export { objectSources } from
  './object-store.js'` and `export type { ObjectSourcesView } …`, `export type {
  AlternateDiagnostic, AlternateDiagnosticReason } from './internal/alternate-chain.js'`
  (alphabetical among existing exports, e.g. after `mergeBase`).
- Edits `src/repository.ts` — `Repository.primitives` (L405–426): `readonly objectSources:
  BindCtx<typeof primitives.objectSources>;` (alphabetical); the binding beside `streamBlob`
  (L995) following its guard pattern; the "Tier-2 primitives (25)" comment (L403) → 26.
- Edits `test/unit/repository/repository.test.ts` — the sorted primitives key list (near L338,
  `'walkSubmodules'`) gains `'objectSources'`; one call row like L476.
- Creates `docs/use/primitives/object-sources.md` (shape: an existing page such as
  docs/use/primitives/stream-blob.md — signature, returned fields, the five `reason`s and what
  git prints for each, example) and edits `docs/use/primitives/README.md` (table row,
  alphabetical).
- Edits `test/parity/scenarios/standalone-primitives.scenario.ts` — call
  `repo.primitives.objectSources()` in `run()` and record `{ sources: 1, unusable: 0 }` in the
  result (browser-surface audit, tooling/audit-browser-surface.ts L37 regex).
- Regenerate reports/api.json (`npm run docs:json`).

### TDD steps
1. RED repository.test: sorted key list includes `objectSources` — fails. GREEN: interface +
   binding + barrel.
2. RED repository.test: `Given a fresh repository › When repo.primitives.objectSources() › Then
   { sources: [{ local: true, … }], unusable: [] }`. GREEN.
3. Gates: `npm run check:doc-coverage` and `npm run test:parity
   test/parity/scenarios` (or the parity suite entry) green; `node --experimental-strip-types
   tooling/audit-browser-surface.ts` reports no gap.

### Gate
```
npx vitest run --project unit test/unit/repository/repository.test.ts && npm run test:parity && npm run check:types && ./node_modules/.bin/biome check src/application/primitives/index.ts src/repository.ts test/unit/repository/repository.test.ts test/parity/scenarios/standalone-primitives.scenario.ts && npm run check:doc-coverage && npm run check:spelling
```

### Commit
`feat(primitives): expose objectSources with structured diagnostics for unusable alternates`

## Part 11 — object resolver, metadata and rescan through the chain (design Part 6, first half)

### Context
- Design §D4 (L892–922), Pin M (L359–368: M2/M3 ordering), ADR-509 (loose first per source).
- Edits `src/application/primitives/object-resolver.ts`: `resolveObjectContentWithDepth` (L302)
  and `tryResolveViaRegistry` (L377) loop `store.sources` (primary first; for an alternate,
  `source.registry.assertLoadable()` before its first lookup); `readLooseCompressed` (L622) and
  `looseCompressedBytes(ctx, id, source?)` (L641) read `looseObjectPathIn(source.objectsDir, id)`
  through `source.fs`, probing with `probeLooseOid(ctx, id, source)` (absent = primary, today).
- Edits `src/application/primitives/read-object.ts`: `resolveObjectMetadataWithContent` (L475),
  `resolveDeclaredSize` (L357), `readLooseDeclaredSize` (L380), `loosePathFor` — per source,
  same order. Keep `peekObjectStore(ctx) ?? await getObjectStore(ctx)` (one WeakMap get on the
  hot path).
- Edits `src/application/primitives/internal/retry-after-rescan.ts` (`retryOnceAfterRescan`,
  L30) and `src/application/primitives/internal/pack-miss-rescan.ts` (`rescanOnFullMiss`, L37):
  take the store; `store.reprepare()`; forget the prefix in every source's loose cache.
- Edits `test/unit/application/primitives/object-resolver.test.ts` and
  `test/unit/application/primitives/read-object.test.ts`.

### TDD steps
1. RED read-object.test: `Given an object only in an alternate's pack › When readObject › Then
   its content`; same for alternate loose. GREEN: the source loop.
2. RED: `Given an object loose in the primary and packed in an alternate › Then the primary
   copy is served, the alternate registry never loaded (spy assertLoadable)` (M2);
   `Given an alternate with a Tier-A-corrupt midx and an object only in a later alternate › Then
   the read rejects with the midx error data` (M3). GREEN.
3. RED: `Given a pack added to an alternate after the first scan › When readObject misses then
   retries › Then found` (R5 via reprepare). GREEN: rescan helpers take the store.
4. RED: `readObjectMetadata` / `readDeclaredObjectSize` for an alternate-only object. GREEN.
- Mutation focus: `source !== store.primary` gate on `assertLoadable` (row: primary-only hit
  never loads alternates), first-hit `return` inside the loop, every-source prefix forget.

### Gate
```
npx vitest run --project unit test/unit/application/primitives/object-resolver.test.ts test/unit/application/primitives/read-object.test.ts test/unit/application/primitives && npm run check:types && ./node_modules/.bin/biome check src/application/primitives/object-resolver.ts src/application/primitives/read-object.ts src/application/primitives/internal/retry-after-rescan.ts src/application/primitives/internal/pack-miss-rescan.ts test/unit/application/primitives/object-resolver.test.ts test/unit/application/primitives/read-object.test.ts && npm run check:spelling
```

### Commit
`feat(objects): read objects from every source in git's order`

## Part 12 — in-core blob open, `hasObject`, `fetchMissing` through the chain (design Part 6, second half)

### Context
- Edits `src/application/primitives/internal/blob-source.ts`: `tryOpenBlobSource` (L153) loops
  sources in today's loose-first arm order per source (this becomes the `'in-core'` order of
  Part 15; no behaviour change for one source); `checkAborted(ctx)` before each arm, per source;
  `resolvePackDelta` (L461) takes the holding source's registry.
- Edits `src/application/primitives/has-object.ts`: `probeOnce(ctx, registry, id)` (L25) →
  `probeOnce(ctx, store, id)` over every source (`'recheck'` mode reprepares the store).
- Edits `src/application/commands/fetch-missing.ts`: `objectExistsLocally` (L52–59) checks every
  source.
- Edits `test/unit/application/primitives/internal/blob-source.test.ts`,
  `test/unit/application/primitives/has-object.test.ts`,
  `test/unit/application/commands/fetch-missing.test.ts`.

### TDD steps
1. RED blob-source.test: `Given a blob only in an alternate (loose; packed base; packed delta) ›
   When openBlobSource › Then today's bytes`; `Given a full miss and a pack added to the
   alternate › Then the rescan finds it`. GREEN.
2. RED has-object.test: alternate pack hit → true; alternate loose hit → true; miss → false;
   `'recheck'` finds a late alternate pack. GREEN.
3. RED fetch-missing.test: `Given a wanted id present only in an alternate › When fetchMissing ›
   Then it is not requested` (transport spy). GREEN.
- Mutation focus: per-source `checkAborted` (abort between sources row), first-hit return.

### Gate
```
npx vitest run --project unit test/unit/application/primitives/internal/blob-source.test.ts test/unit/application/primitives/has-object.test.ts test/unit/application/commands/fetch-missing.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/primitives/internal/blob-source.ts src/application/primitives/has-object.ts src/application/commands/fetch-missing.ts test/unit/application/primitives/internal/blob-source.test.ts test/unit/application/primitives/has-object.test.ts test/unit/application/commands/fetch-missing.test.ts && npm run check:spelling
```

### Commit
`feat(objects): open blobs and answer presence across every source`

## Part 13 — enumeration and prefix resolution per source (design Part 7, + gc scope)

### Context
- Design §D5 (L1176–1186), §D7 first bullet (L1264), Pin X (L500–513).
- Edits `src/application/primitives/enumerate-objects.ts`: `EnumerateObjectsOptions` (L9) gains
  `readonly scope?: 'all' | 'local'` (default `'all'`); loose = each source's 256 fanout dirs via
  `source.fs`; packs = each source's `registry.all()` / `health().accessible`.
- Edits `src/application/primitives/resolve-oid-prefix.ts`: `scanLoose(ctx, prefix)` (L67) and
  `scanPacks(ctx, prefix)` (L89) take a source; L106 unions across sources; ambiguity over the
  union; `MAX_OID_PREFIX_CANDIDATES` unchanged. Export both scans (named `scanLooseIn`,
  `scanPacksIn` — internal, consumed by Part 46; not added to the primitives barrel).
- Edits `src/application/commands/internal/gc-pipeline.ts` L852: `enumerateObjects(ctx, {
  includePacks: false, scope: 'local' })` — **must land here**, else gc enumerates donor loose
  objects as owned. Known transitional state: fsck's universe (fsck.ts L90, default scope) sees
  donor objects from here until Part 30 reads their loose bytes per source — no existing test
  covers fsck with alternates; do not add one here.
- Edits `test/unit/application/primitives/enumerate-objects.test.ts`,
  `test/unit/application/primitives/resolve-oid-prefix.test.ts`,
  `test/unit/application/commands/maintenance.test.ts` (gc rows).

### TDD steps
1. RED enumerate-objects.test: `Given a borrower › When enumerateObjects() › Then primary and
   alternate ids (loose and packed)`; `scope: 'local'` → primary only. GREEN.
2. RED resolve-oid-prefix.test: prefix unique only across the union resolves; prefix shared by
   a primary and an alternate object → `AMBIGUOUS_OID_PREFIX` with both candidates (X2). GREEN.
3. RED maintenance.test: `Given a borrower with donor loose objects › When gc › Then no donor
   object is counted or touched`. GREEN: gc-pipeline scope.
- Mutation focus: the `'local'` branch (row each), union de-dup.

### Gate
```
npx vitest run --project unit test/unit/application/primitives/enumerate-objects.test.ts test/unit/application/primitives/resolve-oid-prefix.test.ts test/unit/application/commands/maintenance.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/primitives/enumerate-objects.ts src/application/primitives/resolve-oid-prefix.ts src/application/commands/internal/gc-pipeline.ts test/unit/application/primitives/enumerate-objects.test.ts test/unit/application/primitives/resolve-oid-prefix.test.ts test/unit/application/commands/maintenance.test.ts && npm run check:spelling
```

### Commit
`feat(objects): enumerate and resolve abbreviated ids across every source`

## Part 14 — lookup interop (design Part 13, non-M5 rows)

### Context
- Standalone interop part (DC-P2): rows pin Parts 7–13 together; no `src/` delta.
- Creates `test/integration/alternates-interop.test.ts` with the `@proves` block (briefing:
  no orphan `interopSurface`). Helpers (read-only): test/integration/interop-helpers.ts
  (`runGit`, `git`, `makePeerPair`, `disableAutoMaintenance`, `tryRunGitWithExit`),
  test/integration/pack-fixture-helpers.ts (`flipEntryBodyByte`, `writeLooseObject`,
  `readSolePackPair`), test/integration/midx-fixture-helpers.ts (`writeMultiPackIndex`,
  `mutateMidxOrThrow`).
- Rows (design Pins A, P, R, N, D, U, M, X at L210–368, L500–513): A1–A5, P1–P14 (oracle:
  `repo.primitives.objectSources().sources` vs `git count-objects -v` `alternate:` lines),
  R1–R8, N1–N4, D1–D4, O1, U1–U3 (+U4/U5 as read outcomes; `unusable[].reason`), M1–M4, X1–X3
  (reconstruct git's ambiguity message from `ambiguousOidPrefix` data, ADR-249).
- Producing borrowers: `git clone --shared` / hand-written `objects/info/alternates` (git writes,
  then build the tsgit repo). Path-sensitive rows (symlinks, case) `skipIf` the host lacks them.

### TDD steps
1. RED rows A1–A5 + P1–P14 — they should pass on first run; any failure is a real defect: fix the
   owning module (Parts 1, 7–13) in this part and name it in the handback.
2. RED rows R, N, D, O1, U.
3. RED rows M1–M4 and X1–X3.

### Gate
```
PATH=$HOME/.local/git-2.55.0/bin:$PATH npx vitest run --project integration test/integration/alternates-interop.test.ts && npm run check:types && ./node_modules/.bin/biome check test/integration/alternates-interop.test.ts && npm run check:spelling
```

### Commit
`test(interop): pin alternates lookup against git`

## Part 15 — streamed blob open in git's stream order (design Part 6b, first half)

### Context
- Design §D4.1 (L923–1043), Pin M5 (L369–499), ADR-928.
- Edits `src/application/primitives/internal/blob-source.ts`:
  - `OpenBlobSourceOptions` (L86, extends `StreamBlobOptions`, has `looseMode`) gains required
    `order: BlobReadOrder` (`export type BlobReadOrder = 'stream' | 'in-core'`), so
    `openBlobSource(ctx, id, maxBufferedBytes, options)` (L96) takes required options.
  - `tryDeltaCacheHit` (L135) runs only for `'in-core'`.
  - `tryOpenBlobSource` (L153, the Part 12 per-source loop) splits into `locateStream` /
    `locateInCore` returning `LocatedBlob = { source, arm: 'loose', compressed } | { source,
    arm: 'pack', hit, entry }`, and `serveLocated` (existing `resolveLoose` L308,
    `resolvePackBase` L401, `resolvePackDelta` L461 with `located.source.registry`).
  - `locateStream`: per source (alternate → `assertLoadable()` first); pack `lookup` →
    `readEntryHeaderWithChunk` once → accept when `isBase(entry.header) && entry.header.size >
    store.bigFileThreshold`; else `firstHeld ??=` it; then the loose arm (any type/size) returns;
    end → `firstHeld`. `locateInCore`: per source loose first, then pack, first hit.
  - Miss → `retryOnceAfterRescan(… () => locate(…))`; still undefined → `objectNotFound(id)`.
  - Export `locateBlob(ctx, id, { order })` (returns `LocatedBlob | undefined`, no throw) and
    `serveLocatedBlob(ctx, located, maxBufferedBytes, options)`; `openBlobSource` = composition.
  - `hashStoredObject` (L225, calls `openBlobSource` at L236): pass `order: 'in-core'` for now
    (Part 16 makes it type-dependent).
  - Read-only: object-resolver.ts `isBase` (L1009), `readEntryHeaderWithChunk` (L1032);
    `ObjectStore.bigFileThreshold` (Part 8).
- Edits `src/application/primitives/stream-blob.ts` — `streamBlob` (L14) passes
  `{ ...options, order: 'stream' }` (L19).
- Edits `src/application/primitives/internal/whitespace-drop-predicate.ts` L121–122: add
  `order: 'in-core'`.
- Edits `test/unit/application/primitives/internal/blob-source.test.ts`,
  `test/unit/application/primitives/stream-blob.test.ts`,
  `test/unit/application/primitives/internal/whitespace-drop-predicate.test.ts`.
- Reach detector in tests: an alternate whose registry `assertLoadable` rejects (a Tier-A
  corrupt midx in the memory alternate, or a store double) — "reached" ⇔ the call rejects with
  that error's data.

### TDD steps
1. RED blob-source.test (one isolated test per `locateStream` exit): primary pack non-delta with
   size > threshold → served, alternate not reached; size == threshold → declines → reaches
   the alternate (rejects); delta above threshold → declines → reaches it. GREEN: order option +
   `locateStream`.
2. RED: primary loose arm serves (alternate not reached); loose and packed large non-delta both
   present → pack served; declined everywhere and no later holder → `firstHeld` served with no
   second header read (spy `readEntryHeaderWithChunk` count). GREEN.
3. RED: full miss → rescan → hit in an alternate; `'stream'` skips a delta-cache entry,
   `'in-core'` uses it; `'in-core'` never reaches the alternate for a primary-held object.
   `locateBlob` → `undefined` on a full miss after the rescan; `serveLocatedBlob` of a loose /
   pack-base / pack-delta located entry → today's bytes; `openBlobSource` miss → `objectNotFound`
   data. GREEN: split + exports.
4. RED stream-blob.test: `Given a small packed blob in the primary and an unloadable alternate ›
   When streamBlob › Then it rejects with the alternate's error data`. whitespace-drop-predicate.test:
   `… When the predicate opens both sides › Then no rejection` (in-core). GREEN: caller options.
- Regression: test/integration/blob-streaming-interop.test.ts and
  blob-streaming-checkout-interop.test.ts stay green unedited (run them).
- Mutation focus: strict `>` against the threshold, the `isBase` conjunct, `firstHeld ??=` (first
  holder, not last — row with two declining holders), `source !== store.primary` gate.

### Gate
```
npx vitest run --project unit test/unit/application/primitives/internal/blob-source.test.ts test/unit/application/primitives/stream-blob.test.ts test/unit/application/primitives/internal/whitespace-drop-predicate.test.ts && PATH=$HOME/.local/git-2.55.0/bin:$PATH npx vitest run --project integration test/integration/blob-streaming-interop.test.ts test/integration/blob-streaming-checkout-interop.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/primitives/internal/blob-source.ts src/application/primitives/stream-blob.ts src/application/primitives/internal/whitespace-drop-predicate.ts test/unit/application/primitives/internal/blob-source.test.ts test/unit/application/primitives/stream-blob.test.ts test/unit/application/primitives/internal/whitespace-drop-predicate.test.ts && npm run check:spelling
```

### Commit
`feat(objects): open streamed blobs in git's per-source stream order`

## Part 16 — declared header, `verifyStoredObject` order, stream interop M5a–M5m (design Part 6b, second half)

### Context
- Design §D4.1 "Callers" (L985–1043), ADR-929, Pin M5 fixture (L369–499).
- Edits `src/application/primitives/read-object.ts`: `resolveDeclaredSize` (L357) →
  `resolveDeclaredHeader` returning `{ type, declaredSize }` (pack: `readPackedMetadata` L503
  already yields `type`; loose: `resolveDeclaredSizeFromPrefix` L443 parses the header — return
  its type too); export `readDeclaredObjectHeader(ctx, id)`; `readDeclaredObjectSize` (L352)
  maps it (signature unchanged).
- Edits `src/application/primitives/internal/blob-source.ts`: `verifyStoredObject` (L214) /
  `hashStoredObject` (L225): header-only type probe first (`readDeclaredObjectHeader`), then
  `order: 'stream'` for a blob, `'in-core'` otherwise (git's `parse_object`).
- Edits `test/unit/application/primitives/read-object-metadata.test.ts` and
  `test/unit/application/primitives/internal/ref-target.test.ts` (the caller is
  internal/ref-target.ts L93 `assertRefTargetValid`, used by update-ref.ts and clone.ts).
- Creates `test/integration/alternates-stream-interop.test.ts` (`@proves` block per the
  briefing): the M5 fixture built once per file by git (precondition
  asserted with `git verify-pack -v`: `delt` non-delta, `base` a delta; the only borrower loose
  object is `a`, restored with `writeLooseObject` after the repack). Threshold rows set
  `core.bigFileThreshold` in the borrower's config file (`git config`), never `-c`. "Refusal" =
  git exit 128 with the M3 fatal ⇔ tsgit rejects with the same Tier-A midx error data as M3.
  Worktree comparisons on two peer copies (`makePeerPair`), umask 022, mode `stat.mode & 0o777`.

### TDD steps
1. RED read-object-metadata.test: `readDeclaredObjectHeader` type for loose / packed base /
   packed delta; `readDeclaredObjectSize` unchanged. GREEN.
2. RED ref-target.test: `Given a small packed blob target and an unloadable alternate › When
   assertRefTargetValid › Then it rejects with the alternate's error data`; a commit target does
   not reach it. GREEN: type-probe-then-order.
3. RED interop rows M5a–M5h, M5j–M5m (table at design L1993–2018: M5a reads; M5b/M5c/M5d
   `streamBlob` refusal/bytes/refusal; M5e/M5f delt/base; M5g/M5h `updateRef` refusal vs success,
   ref absent after refusal; M5j symlink checkout; M5k `diff` with `ignoreWhitespace: 'all'`; M5l
   loose copy present; M5m `archive` iterates every entry). GREEN: fix the owning module if a
   row fails.
- Mutation focus: the blob-vs-other switch in `verifyStoredObject` (row each), loose header type
  extraction.

### Gate
```
npx vitest run --project unit test/unit/application/primitives/read-object-metadata.test.ts test/unit/application/primitives/internal/ref-target.test.ts test/unit/application/primitives/internal/blob-source.test.ts && PATH=$HOME/.local/git-2.55.0/bin:$PATH npx vitest run --project integration test/integration/alternates-stream-interop.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/primitives/read-object.ts src/application/primitives/internal/blob-source.ts test/unit/application/primitives/read-object-metadata.test.ts test/unit/application/primitives/internal/ref-target.test.ts test/integration/alternates-stream-interop.test.ts && npm run check:spelling
```

### Commit
`feat(objects): verify ref targets by type before choosing the read order`

## Part 17 — every-source gate + `catFileBatch` (design Part 6c, first slice)

### Context
- Design §D4.2 (L1044–1075), §D4.4 (L1141–1175), ADR-930, F1/F8.
- Edits `src/application/primitives/object-store.ts`: `assertEverySourceLoadable(ctx):
  Promise<void>` (every `source.registry.assertLoadable()`, primary first, first rejection
  propagates) and `everySourceLoadable(ctx): Promise<boolean>` (same, settled to a boolean;
  only adapter/`TsgitError` rejections become `false` — anything else rethrows).
  `PackRegistry.assertLoadable` interface pack-registry.ts L273, impl L1162.
- Edits `src/application/primitives/internal/blob-source.ts`: `readBlobContentInStreamOrder(ctx,
  id): Promise<Uint8Array>` — `openBlobSource` with `{ order: 'stream', looseMode: 'streamed' }`
  and `MAX_BUFFERED_BLOB_BYTES`, drained (`bytes` arm as is; `stream` arm concatenated).
- Edits `src/application/primitives/cat-file-batch.ts` `readOne` (L37–50): header first
  (`readDeclaredObjectHeader`); `isObjectNotFound` → `buildMissingEntry` (L32) unchanged;
  `maxBytes` refusal = `objectTooLarge(id, declaredSize, maxBytes)` (src/domain/objects/error.ts
  L112) **before** opening; blob → content via the helper; other types → `readObjectWithSize`
  (read-object.ts L230).
- Edits `test/unit/application/primitives/object-store.test.ts`,
  `test/unit/application/primitives/internal/blob-source.test.ts`,
  `test/unit/application/primitives/cat-file-batch.test.ts`.

### TDD steps
1. RED object-store.test: `assertEverySourceLoadable` rejects with the alternate's error after
   the primary's call (spy order); `everySourceLoadable` → false without throwing; true when all
   load; a non-TsgitError rejection propagates. GREEN.
2. RED blob-source.test: `readBlobContentInStreamOrder` bytes for a loose and a packed blob;
   reaches the unloadable alternate for a small packed blob. GREEN.
3. RED cat-file-batch.test: small packed blob B → rejects (reach); `bigFileThreshold` below B's
   size → served, no reach; commit → never reaches; missing → `{ ok: false }`; `maxBytes` below
   the declared size → `objectTooLarge` data and no reach; size-lying loose blob → real bytes
   (existing row stays green). GREEN.
- Mutation focus: primary-first order, `maxBytes` check before the open, blob/other switch.

### Gate
```
npx vitest run --project unit test/unit/application/primitives/object-store.test.ts test/unit/application/primitives/internal/blob-source.test.ts test/unit/application/primitives/cat-file-batch.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/primitives/object-store.ts src/application/primitives/internal/blob-source.ts src/application/primitives/cat-file-batch.ts test/unit/application/primitives/object-store.test.ts test/unit/application/primitives/internal/blob-source.test.ts test/unit/application/primitives/cat-file-batch.test.ts && npm run check:spelling
```

### Commit
`feat(objects): read cat-file batch blobs in git's stream order`

## Part 18 — `show` / `archive` stream routing + interop M5n–M5s (design Part 6c, second slice)

### Context
- Edits `src/application/commands/show.ts`: `buildForRev` (L122–127) and `buildTag`
  (L162–165) replace `readObjectStreamed` with a module-local `readShowTarget(ctx, id)`: header
  first; blob → `readBlobContentInStreamOrder` wrapped as today's blob object; other types →
  `readObjectStreamed` (same return type as today).
- Edits `src/application/commands/archive.ts` `buildEntryStream` (L106): regular modes
  (`FILE_MODE.REGULAR` / `FILE_MODE.EXECUTABLE`, src/domain/objects/file-mode.ts) route on
  `readDeclaredObjectHeader` + `(await getObjectStore(ctx)).bigFileThreshold` (strict `>`,
  type `blob`) to `readBlobContentInStreamOrder`; otherwise `readBlob` (L115). Symlinks always
  `readBlob`. Lazy: the iteration rejects at the refused entry after yielding earlier ones.
- Edits `test/unit/application/commands/show.test.ts`,
  `test/unit/application/commands/archive.test.ts`,
  `test/integration/alternates-stream-interop.test.ts` (rows M5n–M5s).

### TDD steps
1. RED show.test: blob → reach; tag → blob target → reach; commit → no reach. GREEN.
2. RED archive.test: regular blob above the threshold held as a delta → iteration rejects at that
   entry after yielding the earlier ones; non-delta above → served, no reach; size == threshold →
   `readBlob` (spy); symlink above → `readBlob`; executable above → stream order. GREEN.
3. RED interop M5n/M5o (`catFileBatch`), M5p (`show(B)`, `show('HEAD:f')`), M5q (`archive` rejects
   at `base` after exactly the pre-order entries before it), M5r/M5s (trees built with
   `git mktree`; every entry's bytes equal `git cat-file blob`). GREEN: fix owning code.
- Mutation focus: strict `>` in archive, the regular-mode conjunct, the `blob` type conjunct.

### Gate
```
npx vitest run --project unit test/unit/application/commands/show.test.ts test/unit/application/commands/archive.test.ts && PATH=$HOME/.local/git-2.55.0/bin:$PATH npx vitest run --project integration test/integration/alternates-stream-interop.test.ts test/integration/archive-interop.test.ts test/integration/show-interop.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/commands/show.ts src/application/commands/archive.ts test/unit/application/commands/show.test.ts test/unit/application/commands/archive.test.ts test/integration/alternates-stream-interop.test.ts && npm run check:spelling
```

### Commit
`feat(show,archive): read blobs in git's stream order`

## Part 19 — `buildPack` gate, base-entry routing, `deltify` + interop M5u–M5w (design Part 6c, third slice)

### Context
- Design §D4.2 `buildPack` bullets, F1/F9.
- Edits `src/application/primitives/build-pack.ts`: `buildPack` (L91) awaits
  `assertEverySourceLoadable(ctx)` before `resolveWriterPlan` (L129) — empty `objects` included;
  `buildBaseEntries` (L144) reads `readObjectMetadataWithContent` (read-object.ts L325) and then
  the content (carried, `readBlobContentInStreamOrder` for a blob above the threshold, else
  `readRawObject`); `encodeEntry` (L164) takes `{ type, content }` instead of a `GitObject`.
- Edits `src/application/primitives/internal/deltify.ts` `processEmissionEntry` (L421–446): the
  `readRawObject` fallback (L428) routes a `blob` key (`key.type`) with `key.uncompressedSize >
  threshold` through `readBlobContentInStreamOrder`; the threshold read once per
  `deltifyEntries` (L450) call from the store.
- Edits `test/unit/application/primitives/build-pack.test.ts`,
  `test/unit/application/primitives/internal/deltify.test.ts`,
  `test/integration/alternates-stream-interop.test.ts` (M5u–M5w).

### TDD steps
1. RED build-pack.test: an unloadable alternate rejects before any read (spy `readObject*`),
   empty `objects` included. GREEN: the gate.
2. RED: base-only path encodes the same bytes as today (existing pack-sha rows stay green); a
   large blob held loose + packed non-delta in one source is served from the pack copy (spy
   `looseCompressedBytes`). GREEN: `buildBaseEntries` + `encodeEntry`.
3. RED deltify.test: emission read of a blob above the threshold uses the stream-order helper
   (spy); at the threshold uses `readRawObject`. GREEN.
4. RED interop M5u (`buildPack(ctx, { objects: [] })`, `packObjects({ wants: ['HEAD'] })`
   refusal; no new file under the pack dir on either side), M5v (`bundleCreate` refusal, no bundle
   file), M5w (`gc()` refusal, file set under the objects dir unchanged on both). Confirm the
   `packObjects`/`bundleCreate` option spellings in src/application/commands/pack-objects.ts and
   src/application/commands/bundle-create.ts before writing the rows.
- Mutation focus: gate before the first read, strict `>` in deltify, `type === 'blob'` conjunct.

### Gate
```
npx vitest run --project unit test/unit/application/primitives/build-pack.test.ts test/unit/application/primitives/internal/deltify.test.ts && PATH=$HOME/.local/git-2.55.0/bin:$PATH npx vitest run --project integration test/integration/alternates-stream-interop.test.ts test/integration/delta-pack-interop.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/primitives/build-pack.ts src/application/primitives/internal/deltify.ts test/unit/application/primitives/build-pack.test.ts test/unit/application/primitives/internal/deltify.test.ts test/integration/alternates-stream-interop.test.ts && npm run check:spelling
```

### Commit
`feat(pack): refuse pack builds when any object source cannot load, as git does`

## Part 20 — delete-only `push` sends no pack + interop M5ae/M5af (design Part 6c, push slice)

### Context
- Design §D4.4 last paragraphs, F10; git `send-pack.c:745` (`need_pack_data`).
- Edits `src/application/commands/push.ts` (L325–356): `buildPack` only when `wants.length > 0`
  (L334–341); the request body (signed `buildSignedRequestBody` L348 — widen its pack parameter to
  `Uint8Array | undefined` where it is defined / unsigned `buildReceivePackRequest` L349–353)
  carries no packfile otherwise.
- Edits `src/domain/protocol/receive-pack.ts`: `packfile` (L18, L64) becomes optional
  (`readonly packfile?: Uint8Array`); the serialiser appends nothing when absent (git sends
  commands + flush only). Edits `test/unit/domain/protocol/receive-pack.test.ts`.
- Edits `test/unit/application/commands/push.test.ts` and
  `test/integration/alternates-stream-interop.test.ts` (M5ae, M5af — push to a bare peer).

### TDD steps
1. RED receive-pack.test: `Given commands and no packfile › When serialised › Then the bytes end
   at the flush packet` (and the signed variant). GREEN.
2. RED push.test: `Given a delete-only push › Then buildPack is not called and the request has
   no pack`; a push with a non-delete command still sends one. GREEN.
3. RED interop M5ae (delete-only push from a borrower with an unloadable alternate succeeds,
   remote `x` gone) and M5af (`side` push refuses, remote `y` absent). Run
   test/integration/push-interop*.test.ts if present to confirm no regression.
- Mutation focus: `wants.length > 0` boundary (row with exactly one non-delete).

### Gate
```
npx vitest run --project unit test/unit/domain/protocol/receive-pack.test.ts test/unit/application/commands/push.test.ts && PATH=$HOME/.local/git-2.55.0/bin:$PATH npx vitest run --project integration test/integration/alternates-stream-interop.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/commands/push.ts src/domain/protocol/receive-pack.ts test/unit/domain/protocol/receive-pack.test.ts test/unit/application/commands/push.test.ts test/integration/alternates-stream-interop.test.ts && npm run check:spelling
```

### Commit
`fix(push): send no pack for a delete-only push, as git does`

## Part 21 — `merge` writes `ORIG_HEAD` before the outcome (design Part 22)

### Context
- Design §D16 (L1617–1629), Pin OH (L650–667), G17. Lands before Part 25.
- Edits `src/application/commands/merge.ts`: in `computeMerge` (L163–200), after the merge base
  is found and before every outcome (up-to-date identical/ancestor, fast-forward,
  `fastForward: 'never'`, clean, conflict) and before the ff-only and would-overwrite refusals,
  `await writeOrigHead(ctx, ourId)`; remove the conflict-path-only call in
  `persistConflictState` (L589). Not written when `opts.rev` does not resolve or a merge is
  pending. No reflog (`writeOrigHead`, internal/merge-state.ts L39, writes no log — keep it).
- Edits `test/unit/application/commands/merge.test.ts` and
  `test/integration/merge-interop.test.ts` (OH1–OH4, OH6–OH8: `ORIG_HEAD` bytes equal).
- Pre-approved expectation flips: existing rows asserting "no ORIG_HEAD" after a refusal (OH7,
  OH8 justify them).

### TDD steps
1. RED merge.test: `ORIG_HEAD` = old HEAD after up-to-date (identical and ancestor) and
   fast-forward. GREEN: move the write.
2. RED: after `fastForward: 'never'`, clean merge, conflict; after the ff-only refusal and the
   would-overwrite refusal (flip the old rows, say so). GREEN.
3. RED: not written for an unresolvable `opts.rev` or a pending merge; no `logs/ORIG_HEAD`.
4. RED interop OH rows.
- Mutation focus: write placement before each outcome branch (one row per outcome).

### Gate
```
npx vitest run --project unit test/unit/application/commands/merge.test.ts && PATH=$HOME/.local/git-2.55.0/bin:$PATH npx vitest run --project integration test/integration/merge-interop.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/commands/merge.ts test/unit/application/commands/merge.test.ts test/integration/merge-interop.test.ts && npm run check:spelling
```

### Commit
`fix(merge): write ORIG_HEAD before every merge outcome, as git does`

## Part 22 — `writeStreamedBlob` + the checkout write path (design Part 6d, first slice)

### Context
- Design §D4.3 (L1076–1140), ADR-931, ADR-932, F4–F6.
- Edits `src/application/primitives/internal/write-working-tree-file.ts`: new
  `writeStreamedBlob(ctx, fullPath, id, mode?)` and private `createEmptyOutput(ctx, fullPath,
  mode?)` per the §D4.3 pseudocode (rmIfExists → `locateBlob(…, { order: 'stream' })`; refusal
  (not `operationAborted`) → create the empty file (+ chmod `MODE_EXEC_PERM`/`MODE_REGULAR_PERM`,
  L18–19, when `mode` is given) and rethrow (create failure → its error with `cause` = the
  refusal); `undefined` → `objectNotFound`; serve/write failure → `rmIfExists` and rethrow).
  `writeWorkingTreeEntryStream` (L170) takes the blob `id` instead of a stream and delegates to
  `writeStreamedBlob` after its `unlinkSymlinkedLeadingComponent` step (kept first).
  `writeRegularFileStream` (L129) / `writeWorkingTreeFileStream` (L149) are untouched here
  (Part 22b switches their callers and deletes the stream variant).
- Edits `src/application/primitives/apply-changeset.ts` `writeBlobToWorkingTree` (L212–259):
  the `streamBlob` (L258) + `writeWorkingTreeEntryStream` (L259) pair becomes one call; drop
  the `streamBlob` import (L60) if unused.
- Edits `test/unit/application/primitives/internal/write-working-tree-file.test.ts` and
  `test/unit/application/primitives/apply-changeset.test.ts` (existing rows stay green).

### TDD steps
1. RED write-working-tree-file.test (memory adapter, unloadable alternate as the refusal):
   refusal → empty file exists, `0o755` for executable mode, `0o644` regular, no chmod when mode
   absent (spy). GREEN: `writeStreamedBlob` + `createEmptyOutput`.
2. RED: an occupant (modified file) → replaced by the empty file; full miss → no file, occupant
   removed, `objectNotFound` data; abort during the locate → no file, `operationAborted`. GREEN.
3. RED: serve failure (corrupt loose body) → no file; non-blob → no file,
   `unexpectedObjectType`; `createEmptyOutput` failure → its error with `cause` = the refusal;
   success → bytes + mode as today. GREEN.
4. RED apply-changeset.test: `Given an unloadable alternate and a single small packed blob entry ›
   When applyChangeset › Then the file exists with size 0 and the call rejects with the
   alternate's error`. GREEN: switch `writeBlobToWorkingTree`.
- Mutation focus: create-on-refusal vs unlink-on-serve-failure arms, the `undefined` arm, the
  `mode !== undefined` chmod guard, abort rethrow without residue.

### Gate
```
npx vitest run --project unit test/unit/application/primitives/internal/write-working-tree-file.test.ts test/unit/application/primitives/apply-changeset.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/primitives/internal/write-working-tree-file.ts src/application/primitives/apply-changeset.ts test/unit/application/primitives/internal/write-working-tree-file.test.ts test/unit/application/primitives/apply-changeset.test.ts && npm run check:spelling
```

### Commit
`feat(worktree): leave git's empty file when a streamed checkout write is refused`

## Part 22b — the merge / stash streamed writers (design Part 6d, first slice continued)

### Context
- Same helper (Part 22). The three mode-less writers (§D4.3: adapter default mode on refusal).
- Edits `src/application/primitives/internal/write-working-tree-file.ts`:
  `writeWorkingTreeFileStream` (L149) takes the blob `id` and delegates to
  `writeStreamedBlob(ctx, fullPath, id)` (no mode); delete the now-unused stream variant
  `writeRegularFileStream` (L129) — no dead code.
- Edits the callers (each `streamBlob` + `writeWorkingTreeFileStream` pair becomes one call; drop
  the `streamBlob` imports): `src/application/primitives/apply-merge-to-worktree.ts`
  (L198–199), `src/application/commands/merge.ts` (L711–712),
  `src/application/commands/stash.ts` (L413–414).
- Edits `test/unit/application/primitives/apply-merge-to-worktree.test.ts` and
  `test/unit/application/commands/stash.test.ts` (merge's suite stays green unedited; its
  refusal rows come in Part 25).

### TDD steps
1. RED apply-merge-to-worktree.test: `Given an unloadable alternate and a clean-merged small
   packed blob › When applied › Then the path exists with size 0 and the call rejects with the
   alternate's error`. GREEN: switch the helper + caller.
2. RED stash.test: the same shape through `stashApply`. GREEN: switch stash.ts; switch merge.ts
   (compile-forced), its suite green.
3. Run test/unit/application/commands/merge.test.ts unedited.
- Mutation focus: no chmod on the mode-less path (spy).

### Gate
```
npx vitest run --project unit test/unit/application/primitives/apply-merge-to-worktree.test.ts test/unit/application/commands/stash.test.ts test/unit/application/commands/merge.test.ts test/unit/application/primitives/internal/write-working-tree-file.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/primitives/internal/write-working-tree-file.ts src/application/primitives/apply-merge-to-worktree.ts src/application/commands/merge.ts src/application/commands/stash.ts test/unit/application/primitives/apply-merge-to-worktree.test.ts test/unit/application/commands/stash.test.ts && npm run check:spelling
```

### Commit
`feat(worktree): route merge and stash file writes through the streamed blob writer`

## Part 23 — sequential write wave under an unloadable source + interop M5i, M5x–M5ab (design Part 6d, second slice)

### Context
- Design §D4.3 wave paragraph, F3.
- Edits `src/application/primitives/apply-changeset.ts` `applyWriteWave` (L422–450):
  `everySourceLoadable(ctx)` decides between `drainPooled` (L351, today) and a sequential
  `for…of` over the writes sorted with `compareEntryPath` (the comparator materialize-tree.ts L184
  uses).
- Edits `test/unit/application/primitives/apply-changeset.test.ts` and
  `test/integration/alternates-stream-interop.test.ts` (M5i, M5x, M5y, M5z, M5aa, M5ab).
- Option spellings to confirm against public types before writing rows: `checkout({ paths })`
  (src/application/commands/checkout.ts `CheckoutOptions`), `reset` hard mode
  (src/application/commands/reset.ts), `stashApply` (src/application/commands/stash.ts).

### TDD steps
1. RED apply-changeset.test: unloadable alternate, entries `a` (loose in primary), `base`
   (packed delta), `f`: `a` written, `base` empty, `f` absent, rejection = the alternate's error —
   repeated 20× deterministic; healthy store → `drainPooled` path (spy on the limiter). GREEN.
2. RED interop M5i (`checkout({ paths: ['f'] })` refusal, `f` exists size 0), M5x (index- and
   HEAD-sourced path checkout: size 0, mode 0644, `ls-files -s` unchanged, no `index.lock`), M5y
   (`x` 0755), M5z, M5aa (branch switch + hard reset from `side`: listing equal to git's),
   M5ab (`stashApply`: `s` size 0).
- Mutation focus: the `everySourceLoadable` switch (row each arm), sort comparator use.

### Gate
```
npx vitest run --project unit test/unit/application/primitives/apply-changeset.test.ts && PATH=$HOME/.local/git-2.55.0/bin:$PATH npx vitest run --project integration test/integration/alternates-stream-interop.test.ts test/integration/blob-streaming-checkout-interop.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/primitives/apply-changeset.ts test/unit/application/primitives/apply-changeset.test.ts test/integration/alternates-stream-interop.test.ts && npm run check:spelling
```

### Commit
`feat(worktree): write in index order when an object source cannot load, as git does`

## Part 24 — every-source gate in cherry-pick / revert / rebase (design Part 6d, third slice)

### Context
- Design §D4.4 table, F2. No shared per-pick module exists (internal/ has only
  cherry-pick-state.ts, sequencer-state.ts, cherry-pick-namespace.ts), so gate each entry
  before its first write with `assertEverySourceLoadable(ctx)` (Part 17).
- Edits `src/application/commands/cherry-pick.ts` (`cherryPickRun` L428, `cherryPickContinue`
  L533, `cherryPickSkip` L586), `src/application/commands/revert.ts` (`revertRun` L415,
  `revertContinue` L494, `revertSkip` L540), `src/application/commands/rebase.ts` (`rebaseRun`
  L457, `rebaseContinue` L532, `rebaseSkip` L573). Abort entries are not gated (git's abort
  computes no abbreviation).
- Edits `test/unit/application/commands/cherry-pick.test.ts`,
  `test/unit/application/commands/revert.test.ts`, `test/unit/application/commands/rebase.test.ts`.

### TDD steps
1. RED per command (run/continue/skip — one isolated row each): `Given an unloadable alternate
   › When <entry> › Then it rejects with the alternate's error data, and worktree, index, HEAD,
   refs and sequencer state are untouched` (snapshot the memory fs before/after). GREEN: gate.
2. RED: healthy store → behaviour unchanged (existing rows).
- Mutation focus: gate before the first write (assert no state file written, not just rejection).

### Gate
```
npx vitest run --project unit test/unit/application/commands/cherry-pick.test.ts test/unit/application/commands/revert.test.ts test/unit/application/commands/rebase.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/commands/cherry-pick.ts src/application/commands/revert.ts src/application/commands/rebase.ts test/unit/application/commands/cherry-pick.test.ts test/unit/application/commands/revert.test.ts test/unit/application/commands/rebase.test.ts && npm run check:spelling
```

### Commit
`feat(sequencer): refuse picks when any object source cannot load, as git does`

## Part 25 — every-source gate in merge / detached checkout + interop M5ac/M5ad (design Part 6d, last slice)

### Context
- Design §D4.4 table; Part 21 must have landed (gate runs after the `ORIG_HEAD` write).
- Edits `src/application/commands/merge.ts`: `assertEverySourceLoadable(ctx)` immediately after
  the `writeOrigHead` call Part 21 placed inside `computeMerge` (reached from `mergeRun`, L148)
  and before every other worktree/state write — not at the top of `mergeRun`, which would refuse
  before git's `ORIG_HEAD` write (separate from Parts 21/22b: each is one behaviour; this one
  depends on both).
- Edits `src/application/commands/checkout.ts` `checkout` (L336): on the branch-switch path
  when the **current** HEAD is detached (read via `readHeadRaw`,
  src/application/primitives/internal/repo-state.ts L354 — not `opts.detach`, which is the
  target side, L110), gate before the worktree update.
- Edits `test/unit/application/commands/merge.test.ts`,
  `test/unit/application/commands/checkout.test.ts`,
  `test/integration/alternates-stream-interop.test.ts` (M5ac, M5ad).

### TDD steps
1. RED merge.test: unloadable alternate → refusal; worktree, index, HEAD, refs, `MERGE_HEAD`/
   `MERGE_MSG` untouched; `ORIG_HEAD` = old HEAD. GREEN.
2. RED checkout.test: from an attached HEAD → no gate (Part 22/23 residue path); from a detached
   HEAD → refusal, worktree untouched. GREEN.
3. RED interop M5ac (`merge` ff-only / no-ff, `cherryPick`, `revert` on `main`, `rebase`: each
   refusal with state untouched; `ORIG_HEAD` equal on both) and M5ad (detached at C1: `checkout
   main`, `cherryPick` refusal; tsgit's detached `merge` refuses with `unsupportedOperation` —
   assert refusal + untouched state only, and note the follow-up).
- Mutation focus: the detached-HEAD condition (row each state), gate placement after ORIG_HEAD.

### Gate
```
npx vitest run --project unit test/unit/application/commands/merge.test.ts test/unit/application/commands/checkout.test.ts && PATH=$HOME/.local/git-2.55.0/bin:$PATH npx vitest run --project integration test/integration/alternates-stream-interop.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/commands/merge.ts src/application/commands/checkout.ts test/unit/application/commands/merge.test.ts test/unit/application/commands/checkout.test.ts test/integration/alternates-stream-interop.test.ts && npm run check:spelling
```

### Commit
`feat(merge,checkout): refuse before writing when any object source cannot load, as git does`

## Part 26 — freshen in `writeObject` + interop (design Part 8)

### Context
- Design §D6 (L1187–1261), §D11 write-surface block (L1365–1381), Pin W (L286–328), ADR-922,
  ADR-925, ADR-926.
- Creates `src/application/primitives/internal/freshen-object.ts`: `freshenObject(ctx, id):
  Promise<boolean>`, `touch(ctx, source, path): Promise<boolean>`, module-level
  `freshenedPacks = new WeakSet<RegisteredPack>()` (RegisteredPack, pack-registry.ts L87). Opens
  with the `@writes` block (surface `objectFreshen`, kind `equivalent-under-readback`, format
  `utime-now`) exactly as §D11. Loop per §D6 pseudocode: per source `assertLoadable()`;
  `registry.lookup(id)` (midx then packs); `.mtimes` in `registry.fileNames()` → cruft → fall to
  the loose arm; pack already freshened → true; `touch(<packsDirIn>/<name>.pack)` → add + true;
  loose arm `probeLooseOid(ctx, id, source)` + `touch(looseObjectPathIn(…))`. `touch`: absent
  `utimeNow` → false; adapter refusal (`errorDataCode(e) !== undefined`,
  src/domain/error-data-code.ts) → `ctx.logger?.debug?.(…)` + false; any other error rethrows.
- Edits `src/application/primitives/write-object.ts` `writeObject` (L26–60): after the second
  abort check (L37) and before `readConfig` (L39): `if (await freshenObject(ctx, computed))
  return computed;`. The `FILE_EXISTS` arm (L50–53) also runs `touch(ctx, primary, path)` and
  returns the id either way.
- Creates `test/unit/application/primitives/internal/freshen-object.test.ts`; edits
  `test/unit/application/primitives/write-object.test.ts`. Pre-approved flip: a write-object row
  asserting a loose file for an already-packed object changes (WP2).
- Creates `test/integration/object-freshen-interop.test.ts` with `@proves … interopSurface:
  objectFreshen` (bucket `cross-tool-interop`). Write-surface audit:
  `node --experimental-strip-types tooling/audit-write-surfaces.ts` must pass with no allowlist
  entry.

### TDD steps
1. RED freshen-object.test (memory, `vi.setSystemTime`): primary loose hit → mtime advanced, no
   write; primary pack hit → `.pack` advanced, `.idx`/`.rev` not, no loose file. GREEN.
2. RED: cruft-only → false (written; cruft files untouched); same pack twice in a session → one
   `utimeNow` (spy); `utimeNow` refused → false; `utimeNow` absent → false (ADR-925). GREEN.
3. RED: alternate loose / alternate pack hit; refusal in the primary then alternate hit (WP4);
   non-adapter error propagates; Tier-A midx in an alternate rejects (W5); a loose copy added to an
   alternate after its fanout listing was cached → false (ADR-926). GREEN.
4. RED write-object.test: freshen hit → no deflate (compressor spy); absent `utimeNow` with the
   object already loose → `FILE_EXISTS`, id returned, file not rewritten; `FILE_EXISTS` → `touch`
   called. GREEN.
5. RED interop: portable rows W1, W2, W2m, W4, W5, WP1, WP2, WP3, WP7, WP8, FE1 (same operation on
   both peers; equal `cat-file --batch-all-objects --batch-check` on the primary only; equal set of
   files whose mtime moved past a fence; `git fsck` clean). Darwin-only (`chflags uchg`, `skipIf
   (process.platform !== 'darwin')`): W2b, W3, WP2b, WP4, WP5, WP6.
- Mutation focus: the cruft check, the `freshenedPacks` memo, the absent-`utimeNow` arm, the
  adapter-code vs rethrow split, early return in `writeObject`.

### Gate
```
npx vitest run --project unit test/unit/application/primitives/internal/freshen-object.test.ts test/unit/application/primitives/write-object.test.ts && PATH=$HOME/.local/git-2.55.0/bin:$PATH npx vitest run --project integration test/integration/object-freshen-interop.test.ts && node --experimental-strip-types tooling/audit-write-surfaces.ts && npm run check:types && ./node_modules/.bin/biome check src/application/primitives/internal/freshen-object.ts src/application/primitives/write-object.ts test/unit/application/primitives/internal/freshen-object.test.ts test/unit/application/primitives/write-object.test.ts test/integration/object-freshen-interop.test.ts && npm run check:spelling
```

### Commit
`feat(objects): freshen an existing copy in any source instead of rewriting it, as git does`

## Part 27 — commit-graph per source + interop CG (design Part 9)

### Context
- Design §D12 (L1382–1422), Pin CG (L514–537), ADR-921, ADR-927.
- Edits `src/application/primitives/internal/read-commit-graph.ts`: `tryRead`/`tryReadUtf8`
  (L129–147) take a source `fs` instead of `ctx`; `loadChain(ctx, gitDir)` (L161) →
  `loadChain(ctx, store, holder)`; `loadGraphUncached` (L202) loops sources (first graph wins;
  shallow → undefined stays first); `isGraphDecodeFailure` (L224) applied per file; missing
  layer → `ctx.logger?.warn?.('commitGraph: unable to find all commit-graph files', { chain,
  layer })` and the prefix is served. Memo unchanged.
- Edits `src/application/primitives/path-layout.ts` (L90–98): `commitGraphPathIn(objectsDir)`,
  `commitGraphChainPathIn(objectsDir)`, `commitGraphLayerPathIn(objectsDir, hash)`; the
  `gitDir` forms delegate.
- Edits `test/unit/application/primitives/internal/read-commit-graph.test.ts`. Pre-approved flip:
  the row near L442–444 ("a chain whose most-recent layer file has been deleted … the WHOLE graph
  is treated as absent") becomes "the base layer is served" (CG4).
- Creates `test/integration/alternates-acceleration-interop.test.ts` (`@proves` block per the
  briefing).

### TDD steps
1. RED read-commit-graph.test: CG1 (graph only in the alternate is used), CG2 (primary graph
   wins). GREEN: source loop.
2. RED: CG3 (chain whose layers live in different sources), CG4 (flipped row — prefix served +
   logger warn row with an injected logger), CG5 (empty chain → next source). GREEN: loadChain.
3. RED: CG6 corrupt single file with a valid chain in the same source → chain served (primary
   only). GREEN: per-file decode failure.
4. RED path-layout `…In` helpers through the commit-graph rows (no separate suite edit).
5. RED interop CG1–CG6: git's verdict via the deleted-object trick; tsgit oracle
   `commitHeader(ctx, oid)` defined ⇔ git succeeded (rev-list success alone is not proof).
- Mutation focus: `break` on missing layer (prefix vs absent), per-file catch scope, first-graph
  return.

### Gate
```
npx vitest run --project unit test/unit/application/primitives/internal/read-commit-graph.test.ts test/unit/application/primitives/path-layout.test.ts && PATH=$HOME/.local/git-2.55.0/bin:$PATH npx vitest run --project integration test/integration/alternates-acceleration-interop.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/primitives/internal/read-commit-graph.ts src/application/primitives/path-layout.ts test/unit/application/primitives/internal/read-commit-graph.test.ts test/integration/alternates-acceleration-interop.test.ts && npm run check:spelling
```

### Commit
`feat(commit-graph): load commit-graph files from every object source, as git does`

## Part 28 — bitmaps per source + interop BM (design Part 10)

### Context
- Design §D13 (L1423–1446), Pin BM (L538–560), ADR-921.
- Edits `src/application/primitives/internal/closure-engine.ts` `tryBitmapClosure` (L333–350):
  first loop every source's `assertLoadable()` + `registry.midxBitmap()` →
  `loadMidxBitmapArtefact`; then every source's `registry.all()` packs →
  `loadPackBitmapArtefact`; else `undefined` (walk). Loaders unchanged (artefact carries its pack).
- Edits `test/unit/application/primitives/internal/closure-engine.test.ts` (loader spies) and
  `test/integration/alternates-acceleration-interop.test.ts` (BM1, BM5, BM6 via
  `revList({ useBitmapIndex: true })`: result set equal to git's, `tier: 'bitmap'` for BM1).

### TDD steps
1. RED closure-engine.test: BM2 (primary pack bitmap before donor pack bitmap), BM3 (donor midx
   bitmap before primary pack bitmap), BM4 (primary midx before donor midx). GREEN.
2. RED: BM5 (corrupt donor bitmap → next / walk), BM6 (corrupt donor midx → throws, data
   asserted). GREEN.
3. RED interop BM1, BM5, BM6.
- Mutation focus: midx-loop-before-pack-loop order (BM3 kills the swap), `assertLoadable` call.

### Gate
```
npx vitest run --project unit test/unit/application/primitives/internal/closure-engine.test.ts && PATH=$HOME/.local/git-2.55.0/bin:$PATH npx vitest run --project integration test/integration/alternates-acceleration-interop.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/primitives/internal/closure-engine.ts test/unit/application/primitives/internal/closure-engine.test.ts test/integration/alternates-acceleration-interop.test.ts && npm run check:spelling
```

### Commit
`feat(rev-list): search reachability bitmaps in every object source, as git does`

## Part 29 — gc / prune with alternates + interop G (design Part 11, + Part 14 G rows)

### Context
- Design §D7 (L1262–1275), Pin G (L329–338). Part 13 already made `owned` local.
- Edits `src/application/commands/internal/gc-pipeline.ts`: `toNormalPackInputs` (L402) — its
  comment ("there is no fifth home … unreachable by construction") is now false: an alternate is
  the fifth home; the `owned.has(id)` guard is the `-l` behaviour (rewrite the comment as a why,
  no phase refs); `packedAnywhere(ctx, looseSet)` (L811) consults every source's packs;
  `pruneLooseFiles` (L823) unchanged (input is the local `looseSet`).
- Edits `test/unit/application/commands/maintenance.test.ts` (gc rows; `runGcTask` L839).
- Creates `test/integration/alternates-gc-fsck-interop.test.ts` (`@proves` block per the
  briefing; gc writes packs, so `packfile` is the declared surface it proves) with rows G1–G5.

### TDD steps
1. RED maintenance.test: `Given a borrower whose closure reaches donor objects › When gc › Then
   donor objects are not packed into the local pack` (owned guard, G1/G2). GREEN.
2. RED: a local loose object also packed in the donor is pruned (G4/G5 via `packedAnywhere`);
   donor loose files never unlinked (G3). GREEN.
3. RED interop G1–G5 (local object sets and donor file sets equal to git's after `gc`).
- Mutation focus: the `owned.has(id)` guard (row where it is false), every-source `packedAnywhere`.

### Gate
```
npx vitest run --project unit test/unit/application/commands/maintenance.test.ts && PATH=$HOME/.local/git-2.55.0/bin:$PATH npx vitest run --project integration test/integration/alternates-gc-fsck-interop.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/commands/internal/gc-pipeline.ts test/unit/application/commands/maintenance.test.ts test/integration/alternates-gc-fsck-interop.test.ts && npm run check:spelling
```

### Commit
`feat(gc): pack only local objects and prune against every source, as git does`

## Part 30 — fsck universe + content validation per source (design Part 12, first slice)

### Context
- Design §D8 (L1276–1291), Pin F (L339–358), ADR-919.
- Edits `src/application/commands/fsck.ts` (L90 universe): `enumerateObjects(ctx, { scope:
  'all', includePacks: opts.full !== false, accessiblePacksOnly })` (explicit `'all'`).
- Edits `src/application/commands/internal/fsck/object-cache.ts` (L274 loose read) and
  `src/application/commands/internal/fsck/content-validation.ts` (L378 loose read): read loose
  bytes from the source that holds the id — `looseCompressedBytes(ctx, id, source)` (Part 11)
  over the store's sources (first holder).
- Edits `src/application/commands/internal/fsck/object-presence.ts`: presence over every source.
- Edits `test/unit/application/commands/internal/fsck/object-cache.test.ts` and
  `test/unit/application/commands/fsck.test.ts`.

### TDD steps
1. RED fsck.test: `Given a borrower with a donor-only reachable commit › When fsck › Then no
   missing-object finding`; a corrupt donor loose object → the hash-mismatch finding (shape
   unchanged). GREEN.
2. RED object-cache.test: loose bytes served from the alternate holder. GREEN.
3. RED fsck.test: Tier-A midx fault in an alternate rejects the run (M4), data asserted.
- Mutation focus: first-holder return; the explicit scope.

### Gate
```
npx vitest run --project unit test/unit/application/commands/fsck.test.ts test/unit/application/commands/internal/fsck && npm run check:types && ./node_modules/.bin/biome check src/application/commands/fsck.ts src/application/commands/internal/fsck/object-cache.ts src/application/commands/internal/fsck/content-validation.ts src/application/commands/internal/fsck/object-presence.ts test/unit/application/commands/internal/fsck/object-cache.test.ts test/unit/application/commands/fsck.test.ts && npm run check:spelling
```

### Commit
`feat(fsck): audit objects held by every object source`

## Part 31 — fsck pack-class passes per source + `objectsDir` attribution (design Part 12, second slice)

### Context
- ADR-920: pack-class findings carry an optional `objectsDir`, set for
  every alternate finding, omitted for the primary so existing findings are byte-identical.
  Public field → regenerate reports/api.json (`npm run docs:json`).
- Edits `src/application/commands/internal/fsck/types.ts` (pack-class variants L60–93: add
  `readonly objectsDir?: string`).
- Edits `src/application/commands/internal/fsck/pack-health.ts` (`runPackHealthPass`),
  `src/application/commands/internal/fsck/rev-index-health.ts` (`runRevIndexHealthPass`),
  `src/application/commands/internal/fsck/midx-health.ts` (`runMidxHealthPass`): loop
  `store.sources`, attribute alternates' findings.
- Edits `test/unit/application/commands/internal/fsck/rev-index-health.test.ts` and
  `test/unit/application/commands/fsck.test.ts` (pack-health and midx-health have no own suite).

### TDD steps
1. RED fsck.test: a corrupt pack in the alternate → pack finding with `objectsDir` = the
   alternate's realpath; a primary finding has no `objectsDir` key (`'objectsDir' in f` false).
   GREEN: types + pack-health.
2. RED rev-index-health.test: alternate `.rev` fault attributed. GREEN.
3. RED fsck.test: alternate midx verify finding attributed. GREEN.
- Mutation focus: the primary-omits-key branch (row each).

### Gate
```
npx vitest run --project unit test/unit/application/commands/fsck.test.ts test/unit/application/commands/internal/fsck && npm run check:types && ./node_modules/.bin/biome check src/application/commands/internal/fsck/types.ts src/application/commands/internal/fsck/pack-health.ts src/application/commands/internal/fsck/rev-index-health.ts src/application/commands/internal/fsck/midx-health.ts test/unit/application/commands/internal/fsck/rev-index-health.test.ts test/unit/application/commands/fsck.test.ts && npm run check:spelling
```

### Commit
`feat(fsck): verify every source's packs and attribute findings to their objects dir`

## Part 32 — fsck bitmap order + design doc + interop F (design Part 12, last slice)

### Context
- Edits `src/application/commands/internal/fsck/bitmap-health.ts` (`runBitmapHealthPass`): git's
  `verify_bitmap_files` order — every source's midx bitmap, then every source's pack bitmaps;
  attribution as Part 31.
- Edits `src/application/commands/internal/fsck/refs-verify.ts`: ref targets resolve through the
  chain (already, via read paths) — only the presence probe it uses switches to every source if
  it bypasses `hasObject` (check; if it already uses `hasObject`, no edit — say so).
- Edits `test/unit/application/commands/internal/fsck/bitmap-health.test.ts`.
- Edits `docs/design/fsck.md` L238 / L500 / L666 per ADR-919 (fsck audits every source; ADR-412's
  alternates bullet superseded).
- Edits `test/integration/alternates-gc-fsck-interop.test.ts` (rows F1–F5, F2b, F3b, F4b, F4c:
  structured findings + exit bits compared to git's, ADR-249).

### TDD steps
1. RED bitmap-health.test: donor midx bitmap verified before primary pack bitmaps; attribution.
   GREEN.
2. RED refs-verify (through fsck.test if no own suite): a ref to a donor-only object → no
   finding. GREEN or no-op.
3. RED interop F rows.

### Gate
```
npx vitest run --project unit test/unit/application/commands/internal/fsck test/unit/application/commands/fsck.test.ts && PATH=$HOME/.local/git-2.55.0/bin:$PATH npx vitest run --project integration test/integration/alternates-gc-fsck-interop.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/commands/internal/fsck/bitmap-health.ts src/application/commands/internal/fsck/refs-verify.ts test/unit/application/commands/internal/fsck/bitmap-health.test.ts test/integration/alternates-gc-fsck-interop.test.ts && npm run check:spelling && npm run check:doc-links
```

### Commit
`feat(fsck): verify bitmaps across every source in git's order`

## Part 33 — directory-only attribute patterns + tree attribute provider (design Part 15)

### Context
- Design §D14 (L1447–1502), G1, G3, G5, G6, R16.
- Edits `src/domain/attributes/resolve-attribute.ts`: `resolveInSource` (L22) /
  `resolveAttribute` (L44): a trailing `/` on `path` marks a directory — strip it before
  `rule.compiled.test(rel)`; skip a rule with `directoryOnly` (`AttributeRule`,
  src/domain/attributes/parse-gitattributes.ts L11) for a non-directory path.
- Edits `src/application/primitives/internal/read-gitattributes.ts`: `buildAttributeProvider`
  (L108) → `buildAttributeProviderFrom(ctx, readDir)` with today's `readDir` (L32) as the
  worktree reader; new `buildTreeAttributeProvider(ctx, tree: ObjectId)` reading
  `.gitattributes` per directory from the tree: `findTreeEntry` (internal/resolve-tree-path.ts
  L66), regular/executable modes only (symlink-mode never read, G6), `readBlob`, cap
  `MAX_GITATTRIBUTES_BYTES` (primitives/types.ts L61) refused as `gitattributesFileTooLarge`
  (internal/read-capped-file.ts). Keeps info/attributes precedence and root macros; works with
  `workDir` undefined (bare).
- Edits `test/unit/domain/attributes/resolve-attribute.test.ts`,
  `test/unit/domain/attributes/resolve-attribute.properties.test.ts`,
  `test/unit/application/primitives/internal/read-gitattributes.test.ts`.

### TDD steps
1. RED resolve-attribute.test: pattern `foo/` vs file `foo` → unspecified; vs `foo/` → set;
   nested `x/foo/` → set; existing rows unchanged. GREEN.
2. RED properties (lens 2, numRuns 100): a rule without `directoryOnly` answers the same for `p`
   and `p/`. GREEN.
3. RED read-gitattributes.test: tree provider reads root and nested `.gitattributes` from the
   tree; ignores the worktree file; bare Context; symlink-mode `.gitattributes` ignored;
   `info/attributes` precedence; macros from the tree root; oversize → refusal data. GREEN.
- Mutation focus: the trailing-slash test, the `directoryOnly` conjunct, the regular-mode check.

### Gate
```
npx vitest run --project unit test/unit/domain/attributes test/unit/application/primitives/internal/read-gitattributes.test.ts && npm run check:types && ./node_modules/.bin/biome check src/domain/attributes/resolve-attribute.ts src/application/primitives/internal/read-gitattributes.ts test/unit/domain/attributes/resolve-attribute.test.ts test/unit/domain/attributes/resolve-attribute.properties.test.ts test/unit/application/primitives/internal/read-gitattributes.test.ts && npm run check:spelling
```

### Commit
`feat(attributes): honour directory-only patterns and read attributes from a tree`

## Part 34 — `archive` honours `export-ignore` + interop E (design Part 16)

### Context
- Design §D14 sketch (L1447–1502), Pin E (L561–593), G1–G4, G7, ADR-933.
- Edits `src/application/commands/archive.ts` `buildEntryStream` (L106): build
  `buildTreeAttributeProvider(ctx, tree)` once; per walked entry (`walkTree`,
  primitives/walk-tree.ts L246, unchanged) `validateIndexPath` stays first (G7); directories are
  **queued** and flushed only when a non-directory descendant reaches its check, before that
  check (G4); `export-ignore` set means `ATTR_TRUE` only (G2); directories and gitlinks checked as
  `<path>/` (G3, `FILE_MODE.DIRECTORY`/`GITLINK`); an ignored directory's descendants are skipped
  (ancestor filter).
- Edits `test/unit/application/commands/archive.test.ts`.
- Creates `test/integration/archive-export-interop.test.ts` (`@proves` block per the briefing;
  reuse the tar/zip collectors pattern of test/integration/archive-interop.test.ts
  L400, L753 — copy into a local helper, do not import from another test file).

### TDD steps
1. RED archive.test (memory, committed `.gitattributes`): file set → skipped; unset / string /
   unspecified → kept; macro. GREEN.
2. RED: directory by name and by `dir/`; `dir/**` (dir emitted, child not); a dir with only an
   ignored subdirectory not emitted; empty subtree not emitted (fixes today's emission). GREEN:
   queue/flush.
3. RED: gitlink matched as `path/`; symlink ignored; worktree `.gitattributes` disagreeing with
   the tree → tree wins; bare Context; tree-id tree-ish; invalid name inside an ignored subtree
   still refuses (data asserted). GREEN.
4. RED interop E1–E11, E13 (default half), E14–E17: entry list (path, mode) equal to `git archive
   --format=tar | tar -t` with git's queued-directory rule; E12 recorded only.
- Mutation focus: flush-before-check order, the ancestor filter, the gitlink slash, `=== true`.

### Gate
```
npx vitest run --project unit test/unit/application/commands/archive.test.ts && PATH=$HOME/.local/git-2.55.0/bin:$PATH npx vitest run --project integration test/integration/archive-export-interop.test.ts test/integration/archive-interop.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/commands/archive.ts test/unit/application/commands/archive.test.ts test/integration/archive-export-interop.test.ts && npm run check:spelling
```

### Commit
`feat(archive): honour export-ignore from the archived tree's attributes`

## Part 35 — commit view and ident parsing (design Part 17a, first slice)

### Context
- Design §D15 layering (L1503–1560), Pin S fixture (L594–649). Pure domain, no I/O, internal.
- Creates `src/domain/pretty/commit-view.ts`: `parseCommitView(raw: Uint8Array): CommitView` —
  `parse_commit_header` / `parse_commit_message` offsets over the RAW commit bytes (tree,
  parents, author/committer ident lines, `encoding` header verbatim, message start, subject
  span, body span). Never decodes the message (bytes + offsets).
- Creates `src/domain/pretty/ident.ts`: `splitIdentLine(line: Uint8Array)` — git's
  `split_ident_line` (name, mail, date, tz spans; malformed → `undefined` parts, as git's
  `format_person_part` skips).
- Creates `test/unit/domain/pretty/commit-view.test.ts`,
  `test/unit/domain/pretty/commit-view.properties.test.ts`,
  `test/unit/domain/pretty/ident.test.ts`, `test/unit/domain/pretty/ident.properties.test.ts`.
  Generators local to each properties file (no shared arbitraries yet).

### TDD steps
1. RED commit-view.test: the Pin S fixture commit bytes → tree, two-line parents, idents, empty
   encoding, subject `msg subject line`, body `body para\n\nSigned-off-by: X <x@y>\n`. GREEN.
2. RED: no body; multi-line subject paragraph; `encoding` header; gpgsig continuation lines
   skipped; missing blank line. GREEN.
3. RED ident.test: well-formed; missing `>`; no date; tz without sign; extra spaces (git's exact
   trimming). GREEN.
4. RED properties: commit-view lens 3 totality on arbitrary bytes (200) and lens 1 —
   a commit serialised from generated fields (test-side serialiser) parses back (200);
   ident lens 3 (200) + lens 1 for well-formed generated idents (200).
- Mutation focus: offset arithmetic (`+1` after LF), blank-line search start.

### Gate
```
npx vitest run --project unit test/unit/domain/pretty && npm run check:types && ./node_modules/.bin/biome check src/domain/pretty test/unit/domain/pretty && npm run check:spelling
```

### Commit
`feat(pretty): parse commit headers and ident lines as git's pretty printer does`

## Part 36 — subject helpers + user-format tokenizer and interpreter (design Part 17a, second slice)

### Context
- Design §D15 placeholder table (L1561–1580): literals, magic, declined, refused (as a value
  here; the error is thrown by Part 51), commit ids `%H %T %P` from env, `%h %t %p` from an env
  abbreviation, idents `n e l t` and mailmapped `N E L` through `env.mapUser`, `%s %f %b %B %e
  %m`, reflog `%g*` empty, `%S %N` declined. Dates, colour, padding, wrap, trailers, decorations,
  describe, signatures are declined in this part and wired by their own parts (DC-P4).
- Creates `src/domain/pretty/subject.ts`: `formatSubject` (paragraph joined by `' '`),
  `formatSanitizedSubject` (`%f`, git's `format_sanitized_subject`).
- Creates `src/domain/pretty/user-format.ts`: `FormatEnv` (resolved data, all optional:
  `abbrev(kind)`, `mapUser`, `decorations`, `describe`, `signature`, `now`, `localOffsetMinutes`),
  `FormatBudget = { describe: 0 | 1 }`, `scanPlaceholders(fmt)` (git's `strbuf_expand_step` /
  `format_commit_item` grammar), `formatRequirements(tokens, budget)` (same tokenizer),
  `formatCommit(tokens, view, env, budget) → { bytes, budget, parsedHeader } | { refused:
  '%(count)' | '%(total)' }`.
- Creates `test/unit/domain/pretty/subject.test.ts`, `test/unit/domain/pretty/user-format.test.ts`,
  `test/unit/domain/pretty/user-format.properties.test.ts`.

### TDD steps
1. RED subject.test: `%s` joins a multi-line paragraph; `%f` sanitises (`msg-subject-line`,
   runs of specials, trailing `.`/`-`). GREEN.
2. RED user-format.test literals + magic: `%n`, `%%`, `%x41`, `%x00`, bad hex declines;
   `%+s`/`%-s`/`% s` (Pin S rows); `%+N` → `N`; `%+w(5)` declined. GREEN: tokenizer.
3. RED ids + idents + message: `%H %T %P`, `%h %t %p` via env, `%an %ae %al`, `%aN` via
   `mapUser`, malformed ident (`n e t` empty, rest declined), `%s %f %b %B %e %m`, `%g*` empty,
   `%S %N %q %Zz %(unknown)` declined (S10). GREEN.
4. RED refusal values for `%(count)` / `%(total)`; `parsedHeader` true only after a
   header-parsing placeholder. GREEN.
5. RED properties: `formatRequirements` asks for X ⇔ `formatCommit` reads X (recording env
   proxy, numRuns 200).
- Mutation focus: magic-byte consumption on decline, `%x` hex validation bounds.

### Gate
```
npx vitest run --project unit test/unit/domain/pretty && npm run check:types && ./node_modules/.bin/biome check src/domain/pretty test/unit/domain/pretty && npm run check:spelling
```

### Commit
`feat(pretty): expand git user-format placeholders over a commit view`

## Part 37 — `$Format:` scanner + pretty barrel (design Part 17a, last slice)

### Context
- Pin S rows S1–S3 (L627–629), G9.
- Creates `src/domain/pretty/format-subst.ts`: `expandFormatSubst(blob: Uint8Array, expandOne:
  (accumulated: Uint8Array, fmt: Uint8Array) => Uint8Array): Uint8Array` — `$Format:` … first
  later `$` across lines; no `$` → verbatim tail; format cut at NUL; binary input expanded.
- Creates `src/domain/pretty/index.ts` (barrel of the expander entry points from Parts 35–37;
  modules added later — date, colour, wrap, padding, trailers, decorations, reencode — are
  consumed by user-format.ts and imported by path elsewhere, so no later part edits the barrel;
  if `export *` collides with an existing domain export, tsc reports TS2308 — rename, never
  alias around it) and edits
  `src/domain/index.ts` (add `export * from './pretty/index.js'`, alphabetical). Internal (no
  package entry).
- Creates `test/unit/domain/pretty/format-subst.test.ts` and
  `test/unit/domain/pretty/format-subst.properties.test.ts`.

### TDD steps
1. RED format-subst.test: S1 terminator across newlines; S2 no later `$` → verbatim; S3 NUL inside
   the format; two occurrences; adjacent `$Format:$`. GREEN.
2. RED properties: lens 3 totality on arbitrary bytes (200); identity on blobs without
   `$Format:` (200); lens 4 — k well-formed `$Format:%H$` occurrences ↔ k `expandOne` calls (100).
- Mutation focus: search start after `$Format:` (off-by-one), NUL cut.

### Gate
```
npx vitest run --project unit test/unit/domain/pretty && npm run check:types && ./node_modules/.bin/biome check src/domain/pretty src/domain/index.ts test/unit/domain/pretty && npm run check:spelling
```

### Commit
`feat(pretty): scan $Format: placeholders as git's export-subst does`

## Part 38 — date modes (design Part 17b)

### Context
- Design §D15 "Dates" (L1597–1601); git `date.c:show_date`, `show_date_relative`,
  `show_date_normal`. Pin S date rows + S17.
- Creates `src/domain/pretty/date.ts`: `showDate(timestamp, tzOffsetMinutes, mode, nowSeconds,
  localOffsetMinutes)` for `normal`, `rfc2822`, `relative`, `iso8601`, `iso8601-strict` (`Z` for
  `+0000`), `short`, `human`. Pure (no `Date.now()` inside).
- Creates `test/unit/domain/pretty/date.test.ts`, `test/unit/domain/pretty/date.properties.test.ts`.
- Edits `src/domain/pretty/user-format.ts` (wire `%ad %aD %at %ai %aI %as %ah %ar` and the `%c*`
  forms; `%ad`/`%cd` use `normal`) and `test/unit/domain/pretty/user-format.test.ts`.

### TDD steps
1. RED date.test: Pin S rows (`%ad`, `%aD`, `%ai`, `%aI`, `%as`, `%cI` with `Z`). GREEN.
2. RED relative boundaries (seconds/minutes/hours/days/weeks/months/years, "N years, M months",
   future → "in the future"); human same-day / same-year / other-year, zone hidden when equal to
   local. GREEN.
3. RED user-format.test wiring rows. GREEN.
4. RED property: `iso8601-strict` output → `Date.parse` → the timestamp (lens 1, 200).
- Mutation focus: each relative threshold (row on each side), rounding.

### Gate
```
npx vitest run --project unit test/unit/domain/pretty && npm run check:types && ./node_modules/.bin/biome check src/domain/pretty test/unit/domain/pretty && npm run check:spelling
```

### Commit
`feat(pretty): render git's date modes`

## Part 39 — display-width tables + generator (design Part 17c, first slice)

### Context
- Design §D15 `utf8-width.ts`; git 2.55 `unicode-width.h` (zero-width + double-width
  intervals), `utf8.c:utf8_strwidth`.
- Creates `tooling/gen-utf8-width.ts` (reads a local unicode-width.h path given as argv — the
  committed generator does no network fetch; obtain the input once into the scratch dir with
  `curl -fsSL https://raw.githubusercontent.com/git/git/v2.55.0/unicode-width.h`; no network ⇒
  blocker, never hand-type the table; emits the table module; usage documented in its header) and
  `src/domain/pretty/utf8-width.ts` (generated intervals + `utf8Width(bytes)`; binary search;
  invalid UTF-8 counts as git does — one column per byte).
- Creates `test/unit/domain/pretty/utf8-width.test.ts`.
- If cspell flags generated identifiers, add words in place in cspell.json (never re-sort) —
  then also backtick-list it in your handback.

### TDD steps
1. RED utf8-width.test: ASCII; East-Asian wide (2); zero-width combining (0); interval edges
   (first/last code point of a range and one past); invalid sequence. GREEN: generate + lookup.
- Mutation focus: binary search bounds (edge rows).

### Gate
```
npx vitest run --project unit test/unit/domain/pretty/utf8-width.test.ts && npm run check:types && ./node_modules/.bin/biome check tooling/gen-utf8-width.ts src/domain/pretty/utf8-width.ts test/unit/domain/pretty/utf8-width.test.ts && npm run check:spelling
```

### Commit
`feat(pretty): measure display width with git's unicode tables`

## Part 40 — colour and `%w` wrap (design Part 17c, second slice)

### Context
- Design §D15 `color.ts`, `wrap.ts`; G14; git `color.c:color_parse_mem`,
  `utf8.c:strbuf_add_wrapped_text`, `pretty.c:rewrap_message_tail`.
- Creates `src/domain/pretty/color.ts` (archive colour = never: `%Cred %Cgreen %Cblue %Creset
  %C(spec) %C(auto,…)` emit nothing; `%C(always,spec)` emits the escape; malformed `%C` declines)
  and `src/domain/pretty/wrap.ts` (`%w(w,i1,i2)`).
- Creates `test/unit/domain/pretty/color.test.ts`, `test/unit/domain/pretty/wrap.test.ts`.
- Edits `src/domain/pretty/user-format.ts` and `test/unit/domain/pretty/user-format.test.ts`
  (wiring rows: `%C(always,red)X` → `ESC[31mX`; `%w(10,2,4)%s` Pin S row).

### TDD steps
1. RED color.test: `color_parse_mem` for named colours, bright, 256, RGB, attributes; `never`
   forms empty. GREEN.
2. RED wrap.test: Pin S `%w` row; indent widths; a word longer than the width; width 0 =
   no wrap. GREEN.
3. RED user-format wiring rows. GREEN.
- Property: none — colour/wrap are renderers whose only grammar is git's escape table (lens 1/4
  fail: no inverse, no count invariant); recorded.
- Mutation focus: `always` prefix detection, wrap width boundary (`==`).

### Gate
```
npx vitest run --project unit test/unit/domain/pretty && npm run check:types && ./node_modules/.bin/biome check src/domain/pretty test/unit/domain/pretty && npm run check:spelling
```

### Commit
`feat(pretty): render colour and wrap placeholders as git does in archive context`

## Part 41 — padding and column placeholders (design Part 17c, last slice)

### Context
- Design §D15 `padding.ts`; git `pretty.c:format_and_pad_commit`, `FORMATTING_LIMIT`.
- Creates `src/domain/pretty/padding.ts`: `%<(N[,trunc|ltrunc|mtrunc])`, `%>(N)`, `%><(N)`,
  `%>>(N)`, and the `|(N)` column forms; widths via `utf8Width` (Part 39).
- Creates `test/unit/domain/pretty/padding.test.ts`,
  `test/unit/domain/pretty/padding.properties.test.ts`.
- Edits `src/domain/pretty/user-format.ts`, `test/unit/domain/pretty/user-format.test.ts`.

### TDD steps
1. RED padding.test: Pin S rows (`%<(8)%an|`, `%<(3,trunc)%an|` → `A..|`, `%>(8)`, `%><(9)`,
   `%<|(12)%h` past column 12 → no pad); `FORMATTING_LIMIT` boundary. GREEN.
2. RED: East-Asian wide input truncation (never splits a wide char); ltrunc/mtrunc. GREEN.
3. RED user-format wiring + colour-reset bookkeeping as `format_and_pad_commit`. GREEN.
4. RED property: `%<(N)` output width == max(N, width(input)) (lens 2, 200).
- Mutation focus: limit boundary, trunc arithmetic.

### Gate
```
npx vitest run --project unit test/unit/domain/pretty && npm run check:types && ./node_modules/.bin/biome check src/domain/pretty test/unit/domain/pretty && npm run check:spelling
```

### Commit
`feat(pretty): pad and truncate placeholders by display width`

## Part 42 — config keys for the expander (design Parts 18a/19a/19b, config)

### Context
- DC-P5. Fields on `ParsedConfig` (src/application/primitives/config-read.ts L53) → run
  `npm run docs:json`; commit reports/api.json if it changed.
- Edits `src/application/primitives/config-read.ts`: `core.abbrev` (git's grammar, design §D15
  "Abbreviation" L1582–1590: `auto`, false-boolean text → full, integer < 4 → config error
  `abbrev length out of range` — reuse the existing config-error factory the file uses for
  invalid values, integer ≥ hex length → full); `mailmap.file`, `mailmap.blob`;
  `trailer.separators`, `trailer.<token>.key`; `gpg.ssh.allowedSignersFile`,
  `gpg.ssh.revocationFile` inside the existing `gpg.ssh` (L193). Follow the parse pattern of
  `core.bigFileThreshold` (L1412–1420) and the section-flattening at L2036.
- Edits `test/unit/application/primitives/config-read.test.ts`.

### TDD steps
1. RED: `core.abbrev` = `auto` / `no` / `false` / `3` (error data) / `12` / `64`. GREEN.
2. RED: `mailmap.file`, `mailmap.blob` strings. GREEN.
3. RED: `trailer.separators`; two `trailer.<token>.key` subsections. GREEN.
4. RED: `gpg.ssh.allowedSignersFile`, `gpg.ssh.revocationFile` beside `program`. GREEN.
- Mutation focus: the `< 4` bound and the `>= hexLength` clamp (rows at 3/4 and 39/40).

### Gate
```
npx vitest run --project unit test/unit/application/primitives/config-read.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/primitives/config-read.ts test/unit/application/primitives/config-read.test.ts && npm run check:spelling
```

### Commit
`feat(config): read abbrev, mailmap, trailer and ssh signature keys`

## Part 43 — trailers (design Part 18a)

### Context
- git `trailer.c` block detection: last paragraph, ≥ 25 % trailer lines or a git-generated
  prefix, continuation lines, `trailer.separators`, configured `trailer.<token>.key`;
  `%(trailers[:key=,only,unfold,separator=,key_value_separator=,valueonly,keyonly])`.
  Config arrives through `FormatEnv` (resolved by Part 51).
- Creates `src/domain/pretty/trailers.ts`, `test/unit/domain/pretty/trailers.test.ts`,
  `test/unit/domain/pretty/trailers.properties.test.ts`.
- Edits `src/domain/pretty/user-format.ts`, `test/unit/domain/pretty/user-format.test.ts`.

### TDD steps
1. RED trailers.test: block detection (25 % boundary both sides, git-generated prefix
   `Signed-off-by`, `(cherry picked from`), continuation lines, custom separators. GREEN.
2. RED options: `only`, `unfold`, `key=` (case-insensitive, configured key alias),
   `separator=` with `%n`/`%x`, `key_value_separator=`, `valueonly`, `keyonly`. GREEN.
3. RED user-format wiring: Pin S `%(trailers)`, `%(trailers:only)`,
   `%(trailers:key=Signed-off-by,valueonly)`. GREEN.
4. RED property (lens 1, 200): a message built from generated trailers yields them back with
   `only`.
- Mutation focus: the 25 % ratio comparison, last-paragraph search.

### Gate
```
npx vitest run --project unit test/unit/domain/pretty && npm run check:types && ./node_modules/.bin/biome check src/domain/pretty test/unit/domain/pretty && npm run check:spelling
```

### Commit
`feat(pretty): parse and render trailers as git does`

## Part 44 — decorations formatter (design Part 18b, first slice)

### Context
- git `log-tree.c:format_decorations` over a structured `Decoration[]` (`{ kind: 'head' |
  'branch' | 'remote' | 'tag' | 'stash' | 'other' | 'grafted' | 'replaced'; name }`):
  `HEAD -> branch`, `tag: `, shortening, `%d` ` (…)`, `%D`, `%(decorate:prefix=,suffix=,
  separator=,pointer=,tag=)` with `%n`/`%xNN` expansion in values.
- Creates `src/domain/pretty/decorations.ts`, `test/unit/domain/pretty/decorations.test.ts`.
- Edits `src/domain/pretty/user-format.ts`, `test/unit/domain/pretty/user-format.test.ts`.

### TDD steps
1. RED decorations.test: attached and detached orders (S13 sample), tag prefix, pointer,
   custom separators with `%n`. GREEN.
2. RED user-format wiring: `%d` → ` (HEAD -> main)`, `%D`, `%(decorate:prefix=[,suffix=])`.
- Property: none — a renderer with no inverse or count invariant beyond the example rows
  (lens 1/4 fail); recorded.

### Gate
```
npx vitest run --project unit test/unit/domain/pretty && npm run check:types && ./node_modules/.bin/biome check src/domain/pretty test/unit/domain/pretty && npm run check:spelling
```

### Commit
`feat(pretty): render ref decorations as git does`

## Part 45 — mailmap domain (design Part 18b, second slice)

### Context
- git `mailmap.c:read_mailmap_line`, `map_user` (email case-insensitive, then name).
- Creates `src/domain/mailmap/parse-mailmap.ts`, `src/domain/mailmap/map-user.ts`,
  `src/domain/mailmap/index.ts` (export from src/domain/index.ts is NOT needed — consumers import
  the module barrel), `test/unit/domain/mailmap/parse-mailmap.test.ts`,
  `test/unit/domain/mailmap/parse-mailmap.properties.test.ts`,
  `test/unit/domain/mailmap/map-user.test.ts`. Internal.

### TDD steps
1. RED parse-mailmap.test: the four line forms, comments, `#` inside names, blank lines,
   malformed lines skipped. GREEN.
2. RED map-user.test: email-only match, name+email match precedence, case-insensitive email,
   unmapped. GREEN.
3. RED properties: totality (lens 3, 200); lens 4 — k well-formed lines ↔ k entries (100).
- Mutation focus: the name+email vs email-only precedence.

### Gate
```
npx vitest run --project unit test/unit/domain/mailmap && npm run check:types && ./node_modules/.bin/biome check src/domain/mailmap test/unit/domain/mailmap && npm run check:spelling
```

### Commit
`feat(mailmap): parse mailmap files and map idents as git does`

## Part 46 — `abbreviateObjectId` (design Part 19a, first slice)

### Context
- Design §D15 "Abbreviation" (L1582–1592), G16. Needs Part 13 (`scanLooseIn`/`scanPacksIn`
  exported from src/application/primitives/resolve-oid-prefix.ts) and Part 42 (`core.abbrev`).
- Creates `src/application/primitives/abbreviate-object-id.ts`: `abbreviateObjectId(ctx, id):
  Promise<string>` — base length from `core.abbrev` or, unset/`auto`, `max(7, ceil((msb(n) + 1)
  / 2))` with `n` = packed-object count summed over every source's registry (approximate, git's
  `packfile_store_count_objects`); then the shortest length ≥ base with no other object in any
  source sharing the prefix. `assertEverySourceLoadable` first (an unloadable alternate refuses).
- Creates `test/unit/application/primitives/abbreviate-object-id.test.ts` (registry doubles for
  the count boundaries). Publication is Part 47.

### TDD steps
1. RED: count boundaries 2^13 − 1 / 2^13 / 2^14 → base 7 / 7 / 8 (compute exact git values in the
   test comment); `core.abbrev` 4 / 12 / `no` (full). GREEN.
2. RED: X1-style ambiguity across sources extends the length; unique prefix keeps base. GREEN.
3. RED: unloadable alternate → refusal data. GREEN.
- Mutation focus: msb arithmetic, the `max(7, …)` floor, extension loop bound.

### Gate
```
npx vitest run --project unit test/unit/application/primitives/abbreviate-object-id.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/primitives/abbreviate-object-id.ts test/unit/application/primitives/abbreviate-object-id.test.ts && npm run check:spelling
```

### Commit
`feat(primitives): compute git's unique abbreviation across every object source`

## Part 47 — publish `repo.primitives.abbreviateObjectId` (design Part 19a, surface; DC-P1)

### Context
- Same gate set as Part 10 (.claude/workflow/surface-gates.md). Drop this part if DC-P1 = (b).
- Edits `src/application/primitives/index.ts` (alphabetical export), `src/repository.ts`
  (`Repository.primitives` member + binding following `streamBlob` L995; primitives count
  comment +1), `test/unit/repository/repository.test.ts` (sorted keys + one call row),
  `docs/use/primitives/README.md` (row); creates `docs/use/primitives/abbreviate-object-id.md`;
  edits `test/parity/scenarios/standalone-primitives.scenario.ts` (call it in `run()`).
- Regenerate reports/api.json.

### TDD steps
1. RED repository.test sorted keys include `abbreviateObjectId`. GREEN.
2. RED call row: a fresh repository with one commit → 7-char prefix of HEAD. GREEN.
3. `npm run check:doc-coverage`, parity project, browser-surface audit green.

### Gate
```
npx vitest run --project unit test/unit/repository/repository.test.ts && npm run test:parity && npm run check:types && ./node_modules/.bin/biome check src/application/primitives/index.ts src/repository.ts test/unit/repository/repository.test.ts test/parity/scenarios/standalone-primitives.scenario.ts && npm run check:doc-coverage && npm run check:spelling
```

### Commit
`feat(primitives): expose abbreviateObjectId`

## Part 48 — ref decorations + mailmap reader (design Part 19a, readers)

### Context
- Design §D15 "Mailmap" (L1593–1597), G12, G13, S12, S13.
- Creates `src/application/primitives/internal/ref-decorations.ts`: `loadRefDecorations(ctx):
  Promise<ReadonlyMap<ObjectId, ReadonlyArray<Decoration>>>` — `enumerateRefs`
  (src/application/primitives/enumerate-refs.ts L16) + `readHeadRaw`
  (internal/repo-state.ts L354), tags peeled via internal/peel.ts, replace refs → `replaced`,
  `loadShallowSet` (internal/shallow-set.ts L81) → `grafted`; no exclusion config.
- Creates `src/application/primitives/internal/read-mailmap.ts`: git's `read_mailmap` order —
  worktree `.mailmap` (non-bare, via `loadCappedUtf8`, internal/read-capped-file.ts),
  `mailmap.blob` (`revParse` + `readBlob`; bare default `HEAD:.mailmap`), `mailmap.file`;
  never the archived tree's.
- Creates `test/unit/application/primitives/internal/ref-decorations.test.ts`,
  `test/unit/application/primitives/internal/read-mailmap.test.ts`.

### TDD steps
1. RED ref-decorations: attached / detached order (S13), annotated tag peeled, `refs/stash`,
   remote, replace ref, shallow → `grafted`. GREEN.
2. RED read-mailmap: worktree file; `mailmap.blob`; bare default; `mailmap.file`; precedence
   (later entries override); absent everywhere → empty map. GREEN.
- Mutation focus: bare-default branch (row each), source order.

### Gate
```
npx vitest run --project unit test/unit/application/primitives/internal/ref-decorations.test.ts test/unit/application/primitives/internal/read-mailmap.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/primitives/internal/ref-decorations.ts src/application/primitives/internal/read-mailmap.ts test/unit/application/primitives/internal/ref-decorations.test.ts test/unit/application/primitives/internal/read-mailmap.test.ts && npm run check:spelling
```

### Commit
`feat(primitives): load ref decorations and the repository mailmap`

## Part 49 — signature verification (design Part 19b)

### Context
- Design §D15 "Signatures" (L1597–1607), ADR-935, ADR-442, G15, S14, S15.
- Creates `src/application/primitives/internal/verify-commit-signature.ts`: `check_signature`
  for OpenPGP (`gpg.program --keyid-format=long --status-fd=1 --verify <sig-file> -`, status
  lines as `parse_gpg_output`), SSH (`ssh-keygen -Y find-principals` / `-Y verify` with
  `gpg.ssh.allowedSignersFile` / `revocationFile`), X.509 (`gpgsm`) through `ctx.command`
  (src/ports/command-runner.ts; `Context.command` L304). Program resolution reuses
  src/application/primitives/sign-payload.ts (`DEFAULT_OPENPGP_PROGRAM` L7,
  `DEFAULT_SSH_PROGRAM` L8 — export them if needed, internal). The detached signature is staged
  at `<gitDir>/.git_vtag_tmpXXXXXX` (git's own temp-file name, created exclusively) (beside the SSH-signing buffer `.git_signing_buffer_tmpXXXXXX`, sign-payload.ts) and removed
  in `finally` on every exit; the module opens with a `@writes` block (surface name
  `verifyBuffer`, kind/format per tooling/audit-write-surfaces.ts grammar — copy
  sign-payload.ts's block if it has one). No runner / spawn failure → `N`, empty fields,
  `undefined` trust.
- Creates `test/unit/application/primitives/internal/verify-commit-signature.test.ts` (fake
  `CommandRunner`).

### TDD steps
1. RED: `GOODSIG`, `BADSIG`, `EXPSIG`, `EXPKEYSIG`, `REVKEYSIG`, `ERRSIG` → `%G?` letters;
   trust levels → `%GT`. GREEN.
2. RED: ssh principal found / not found; x509 path. GREEN.
3. RED: no runner → `N`; spawn failure → `N` with stderr in `%GG` per S15; buffer file removed on
   success, failure and throw (fs spy). GREEN.
4. `node --experimental-strip-types tooling/audit-write-surfaces.ts` green.
- Mutation focus: status-line parser keywords, `finally` removal.

### Gate
```
npx vitest run --project unit test/unit/application/primitives/internal/verify-commit-signature.test.ts && node --experimental-strip-types tooling/audit-write-surfaces.ts && npm run check:types && ./node_modules/.bin/biome check src/application/primitives/internal/verify-commit-signature.ts test/unit/application/primitives/internal/verify-commit-signature.test.ts && npm run check:spelling
```

### Commit
`feat(primitives): verify commit signatures through the command runner as git does`

## Part 50 — commit-encoding round trip (design Part 20)

### Context
- ADR-934 (DC-21 option a), G19, S16–S16d. Domain, no `node:`.
- Creates `src/domain/pretty/reencode.ts`: decode with `TextDecoder(label, { fatal: true })`;
  encoders derived from the decoder and memoised per label (single-byte labels by 256 decodes;
  Shift_JIS, EUC-JP, EUC-KR, GBK, Big5 by one pass over the 65 536 two-byte sequences); forms
  outside that pass, labels WHATWG lacks and any failure → unconverted (git's failed iconv).
  UTF-16 with BOM as S16d.
- Creates `test/unit/domain/pretty/reencode.test.ts`,
  `test/unit/domain/pretty/reencode.properties.test.ts`.
- Edits `src/domain/pretty/format-subst.ts` (after an occurrence whose `formatCommit` reported
  `parsedHeader` and a non-UTF-8 `encoding`, transcode the whole accumulated buffer) and
  `test/unit/domain/pretty/format-subst.test.ts`. user-format.ts already reports
  `parsedHeader` (Part 36) and decodes the message to UTF-8 for placeholders through this
  module — edit it only if that call is missing, and say so.

### TDD steps
1. RED reencode.test: S16 bytes (ISO-8859-1 round trip); invalid sequence → unconverted; unknown
   label → unconverted; a CJK label round trip; UTF-16 BOM. GREEN.
2. RED format-subst.test: S16b unchanged (no header parse), S16c whole-buffer transcode, S16d
   UTF-16. GREEN.
3. RED property (lens 1, 200): for single-byte labels, encode(decode(bytes)) = bytes for bytes
   the decoder accepts.
- Mutation focus: the `parsedHeader && encoding !== utf-8` conjunct (row each), memo per label.

### Gate
```
npx vitest run --project unit test/unit/domain/pretty && npm run check:types && ./node_modules/.bin/biome check src/domain/pretty test/unit/domain/pretty && npm run check:spelling
```

### Commit
`feat(pretty): transcode export-subst output to the commit encoding`

## Part 51 — `archive` expands `export-subst` (design Part 21, unit)

### Context
- Design §D15 "Where it runs" (L1505–1516), G8–G11, ADR-933. Needs Parts 18, 33–50.
- Creates `src/application/commands/internal/archive-subst.ts`: per-archive memo — raw commit
  via `readRawObject`, `parseCommitView`, lazily resolved `FormatEnv` (`abbreviateObjectId`,
  `loadRefDecorations`, `readMailmap` + `mapUser`, `verifyCommitSignature`, `describe`
  (src/application/commands/describe.ts L78) rendered from `DescribeResult`, `now` read once,
  local offset), describe budget decremented **before** argument parsing; `expandFile(content)`
  over `expandFormatSubst`; a `refused` result throws `formatPlaceholderUnsupported`.
- Edits `src/application/commands/archive.ts`: `classifyOid` (L66) already yields `commit`;
  `buildEntryStream` gains the subst handle; per regular entry with `export-subst` set:
  in-core `readBlob` then expand; the Part 18 stream routing gains the `!exportSubst` conjunct
  (G8); symlinks never; tree-id archive → no expansion (S7).
- New public error (surface gates): edits `src/domain/error.ts` (add
  `{ code: 'FORMAT_PLACEHOLDER_UNSUPPORTED'; placeholder: string }` to `TsgitErrorData`),
  `src/domain/commands/error.ts` (`formatPlaceholderUnsupported(placeholder)` beside
  `ambiguousOidPrefix` L879), `test/unit/domain/exhaustiveness.ts` (new case). Regenerate
  reports/api.json.
- Edits `test/unit/application/commands/archive.test.ts`.

### TDD steps
1. RED archive.test: tree id → bytes unchanged; tag → peeled commit expands `%H`; symlink
   unchanged; file above the threshold with the attribute → expanded via `readBlob` (spy, no
   stream-order read). GREEN.
2. RED: describe budget consumed by the first file in pre-order, literal in the second;
   malformed describe args spend it. GREEN.
3. RED: `%(count)` → iteration rejects at that file with `{ code:
   'FORMAT_PLACEHOLDER_UNSUPPORTED', placeholder: '%(count)' }` after the earlier entries.
   GREEN: error code + exhaustiveness.
4. RED: no resolver called for a file without its placeholder (spies on each resolver). GREEN.
- Mutation focus: the attribute conjunct in the routing, the regular-mode gate, budget
  decrement order.

### Gate
```
npx vitest run --project unit test/unit/application/commands/archive.test.ts test/unit/domain && npm run check:types && ./node_modules/.bin/biome check src/application/commands/internal/archive-subst.ts src/application/commands/archive.ts src/domain/error.ts src/domain/commands/error.ts test/unit/domain/exhaustiveness.ts test/unit/application/commands/archive.test.ts && npm run check:spelling
```

### Commit
`feat(archive): expand export-subst placeholders as git does`

## Part 52 — `export-subst` interop (design Part 21, interop; DC-P3)

### Context
- Standalone interop part right after Part 51 (DC-P3); no `src/` delta.
- Edits `test/integration/archive-export-interop.test.ts` (Part 34's file) — a second top-level
  `describe` for Pin S (L594–649): every row's expanded bytes equal `git archive | tar -xO` of
  the same file. Both tools under `TZ=UTC`, fixed dates; now-relative rows (S17, `%ar`) built
  from dates relative to the test's own clock with a ±1 s window. S9 refusal on both. S14/S15
  with a fake `gpg.program` script written into the fixture dir (both tools read it from the
  repository config); one real-`gpg` row `skipIf` no `gpg` on PATH. S12 mailmap, S13 decorations
  with the listed refs.

### TDD steps
1. RED placeholder table rows (ids, idents, dates, message, literals, magic, colour, padding,
   wrap, trailers, decorations, describe). Failures are defects in Parts 35–51 — fix there, in
   this part, and name them.
2. RED S1–S17 rows.

### Gate
```
PATH=$HOME/.local/git-2.55.0/bin:$PATH npx vitest run --project integration test/integration/archive-export-interop.test.ts && npm run check:types && ./node_modules/.bin/biome check test/integration/archive-export-interop.test.ts && npm run check:spelling
```

### Commit
`test(interop): pin archive export-subst expansion against git`

## Part 53 — delta search skips objects above `core.bigFileThreshold` (design Part 23)

### Context
- Design §D17 (L1630–1643), Pin BT (L668–678), G18.
- Edits `src/domain/storage/delta-policy.ts`: `DeltaPolicy` (L61) gains `bigFileThreshold`;
  `resolveDeltaPolicy` (L76) takes it; `attemptsDelta(size)` = `size >= DELTA_FLOOR && size <=
  threshold` (strict `>` excludes).
- Edits `src/application/primitives/build-pack.ts` `resolveWriterPlan` (L129–132): pass
  `(await getObjectStore(ctx)).bigFileThreshold` (Part 8; the same source Parts 18–19 read).
- Edits `src/application/primitives/internal/deltify.ts`: `DELTA_FLOOR_BYTES` (L144) and
  `processEmissionEntry` (L421–446): an object above the threshold is emitted whole and never
  enters the window (neither target nor base), every type.
- Edits `test/unit/domain/storage/delta-policy.test.ts`,
  `test/unit/application/primitives/internal/deltify.test.ts`,
  `test/integration/delta-pack-interop.test.ts`.

### TDD steps
1. RED delta-policy.test: `attemptsDelta` at 49/50 and at threshold/threshold+1. GREEN.
2. RED deltify.test: an object above the threshold is emitted whole and never becomes a base
   (BT shape with a low threshold). GREEN.
3. RED interop Pin BT rows: per-blob whole/delta verdict equals git's `verify-pack -v` at each
   threshold (`core.bigFileThreshold` in the repository config file for both tools).
- Mutation focus: `<=` vs `<` at the threshold, base exclusion.

### Gate
```
npx vitest run --project unit test/unit/domain/storage/delta-policy.test.ts test/unit/application/primitives/internal/deltify.test.ts test/unit/application/primitives/build-pack.test.ts && PATH=$HOME/.local/git-2.55.0/bin:$PATH npx vitest run --project integration test/integration/delta-pack-interop.test.ts && npm run check:types && ./node_modules/.bin/biome check src/domain/storage/delta-policy.ts src/application/primitives/build-pack.ts src/application/primitives/internal/deltify.ts test/unit/domain/storage/delta-policy.test.ts test/unit/application/primitives/internal/deltify.test.ts test/integration/delta-pack-interop.test.ts && npm run check:spelling
```

### Commit
`fix(pack): skip the delta search for objects above core.bigFileThreshold, as git does`

## Part 54 — parity rows with alternates (design Part 14, parity)

### Context
- Test-infra-only part (no `src/` delta). Parity driver: test/parity/scenarios/types.ts
  (`Scenario`), registration in test/parity/scenarios/index.ts (`SCENARIOS`, L50).
- Creates `test/parity/scenarios/alternates.scenario.ts`: one cross-adapter row (memory + node)
  with an in-root alternate (the scenario writes a donor objects dir inside the work tree and an
  `objects/info/alternates` file — check whether `inputs.files` may target the git dir; if not,
  write them in `run()` through `repo.ctx.fs`), reading a donor-only blob and
  `repo.primitives.objectSources()`; one memory-only row with an out-of-root alternate →
  `unusable[0].reason === 'unreachable'` (ADR-916; skip on drivers other than memory).
- Edits `test/parity/scenarios/index.ts` (register, alphabetical).

### TDD steps
1. RED the in-root row on memory and node (expected result recorded once). GREEN: fix
   adapter/store gaps if any, in their own module, and say so.
2. RED the out-of-root memory row.
3. `node --experimental-strip-types tooling/audit-parity-fixtures.ts` green.

### Gate
```
npm run test:parity && npm run check:types && ./node_modules/.bin/biome check test/parity/scenarios/alternates.scenario.ts test/parity/scenarios/index.ts && npm run check:spelling
```

### Commit
`test(parity): read through an alternate on every adapter`

## Part 55 — `bench:ab` rows and measurement (design §Perf)

### Context
- Design §Perf statement (L1644–1706). Measurement part; test/bench files only.
- Existing rows compared as-is (no edits): test/bench/cat-file.bench.ts, log.bench.ts,
  status.bench.ts, pack-read.bench.ts / loose-read.bench.ts (`streamBlob`), show.bench.ts,
  deltify.bench.ts.
- Edits `test/bench/fixtures.ts` (a `--shared` borrower fixture built from the existing small
  fixture: `git clone --shared` in the fixture cache dir), `test/bench/add.bench.ts` (row:
  re-adding unchanged files), `test/bench/checkout.bench.ts` (informational borrower checkout
  row), `test/bench/cat-file.bench.ts` (informational borrower read row); creates
  `test/bench/archive.bench.ts` (entries iterated, no-attributes fixture; gated).
- Base-only `buildPack` row: add to `test/bench/deltify.bench.ts` (edit).
- Runtime: local Node is 22 (`node --version` → v22.x); CI benches on Node 24 (post-#312 notes:
  native modules, transpile hook — never the type stripper for timing). Treat local numbers as
  directional; the CI comparison is the gate.
- Quiet machine first: `uptime` load < 2 and no foreign `stryker` process
  (`pgrep -fl stryker`), else wait and re-check (poll, do not end the turn).

### TDD steps
1. Add the rows; `npx vitest bench --run test/bench/archive.bench.ts` (and each edited file)
   executes. GREEN when every new row runs.
2. Commit, then measure: `npm run bench:ab -- main HEAD 3` (the driver makes its own detached
   worktrees; do not touch other worktrees). Record the table in the handback: no-alternates rows
   within the advisory ±envelope; borrower rows informational. A regression beyond the envelope
   is a blocker `{ unit: 'Part 55', reason, options }`, not a silent note.

### Gate
```
npx vitest bench --run test/bench/archive.bench.ts test/bench/add.bench.ts test/bench/checkout.bench.ts test/bench/cat-file.bench.ts test/bench/deltify.bench.ts && npm run check:types && ./node_modules/.bin/biome check test/bench && npm run check:spelling
```

### Commit
`test(bench): add alternates and archive rows for the A/B comparison`

## Shared files across parts (cognitive-locality notes)

- src/application/primitives/read-object.ts (8, 11, 16): store ownership, then per-source
  reads, then the declared header — three behaviours, each with its own RED set.
- src/repository.ts (9, 10, 47): capability facade vs two public-surface publications.
- src/application/primitives/object-store.ts (8, 9, 17): store, then hooks, then gates.
- src/application/primitives/internal/blob-source.ts (12, 15, 16, 17): in-core loop, stream
  order, verify order, drain helper — the design's own ordering (ADR-928/929/930).
- src/application/commands/merge.ts (21, 22b, 25): `ORIG_HEAD` placement must precede the gate.
- src/application/commands/archive.ts (18, 34, 51): stream routing, export-ignore, export-subst.
- src/domain/pretty/user-format.ts (36, 38, 40, 41, 43, 44): DC-P4.
- test/integration/alternates-stream-interop.test.ts (16, 18, 19, 20, 23, 25): one fixture per
  file, rows land with their behaviour.
- build-pack.ts / deltify.ts (19, 53): stream routing vs the threshold delta policy.

## Follow-ups (from the design; the documentation phase files them)

- `archive` has no `--worktree-attributes` option (E13, second half): `ArchiveOptions` carries only `treeish`.
- `archive` applies `convert_to_working_tree` (smudge, `eol`, `ident`, `working-tree-encoding`) to in-core regular files before `export-subst` (`archive.c:object_file_to_archive`); tsgit emits raw blob bytes, and tsgit's checkout implements smudge only.
- Fixed 7-hex abbreviations (`checkout.ts` L94, `rebase.ts` L151, `domain/merge/merge-labels.ts` L16, `domain/diff/patch-serializer.ts` L57) where git writes `find_unique_abbrev` output into on-disk data — candidates for `abbreviateObjectId` (Part 46).
- `merge` of unrelated histories: git refuses (exit 128 without `--allow-unrelated-histories`, OH9); tsgit merges against the empty tree (`docs/design/commands.md` L1285, no ADR).
- `ORIG_HEAD` in a reftable repository lives in the reftable (OH11); `writeOrigHead` (`internal/merge-state.ts` L39) writes a file — affects `merge` and `rebase`.
- `reset` writes `ORIG_HEAD` in git; `commands/reset.ts` never references it (not pinned here).
- Replace refs: git reads `refs/replace/` replacements on object reads (and archives the replacement commit); tsgit ignores them (Part 48 only renders the `replaced` decoration).
- Mailmap in `shortlog`/`log` (git applies `.mailmap` by default) — `domain/mailmap/` (Part 45) can serve them.
- The `delta` attribute (`-delta`) disables the delta search per path (`builtin/pack-objects.c` L1514 `no_try_delta(path)`); tsgit's pack builder has no path-attribute input.
- `merge` from a detached HEAD: tsgit refuses (`unsupportedOperation`), git merges — check whether an ADR covers it (surfaces in Part 25's M5ad row).
- `archive` of an annotated tag that points at a **tree**: git archives the tree without commit metadata (`lookup_commit_reference_gently` fails, `parse_tree_indirect` peels); tsgit's `classifyOid` (`archive.ts` L71–82) throws `unexpectedObjectType` — not pinned here.
- Observed, not changed (design "Out of scope"): tsgit's chain-file grammar (`parseChainLayerHashes` trims and drops blank lines) differs from git's fixed-width read.
