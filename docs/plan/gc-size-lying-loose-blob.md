# Plan — gc over a size-lying loose blob

> Source: design doc `docs/design/gc-size-lying-loose-blob.md` · ADRs 1027, 1028, 1029, 1030, 1031
> (live context: 907, 902, 718, 731–733, 249, 226)
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

## Rules every part inherits

- Base commit for every line number below: bd3ffac6. Earlier parts shift lines; locate by
  symbol name first, line second.
- One RED per function, run before its code. Write the test, run it, read the failure,
  check it names the reason the step states, and only then write the GREEN. Never batch
  REDs across functions, and never write a GREEN before its RED has been seen failing.
- Tests: `describe('Given …')` > `describe('When …')` > `it('Then …')` (or the two-level
  `Given …, When …` shortcut when one `it` lives under it), AAA section comments, the system
  under test is `sut`. Refusals are read with try/catch plus `expect.unreachable()`, then
  `.data` is asserted: `data.code` and `data.id`. Never `toThrow(Class)` alone.
- No provenance in source or test code: no ADR numbers, no design row ids (G1, I3, P4, a–o),
  no part numbers, no backlog ids in titles, comments or names.
- No suppression directives of any kind. No swallowed errors.
- Interop rows: `describe.skipIf(!GIT_AVAILABLE)`. Pin `GIT_AUTHOR_DATE` and
  `GIT_COMMITTER_DATE` on every fixture commit. Build each tsgit `Context` AFTER the twin
  copy (the loose fanout cache only sees tsgit's own writes).
- A row flipped by a part flips because the part's src change is the ratified contract change
  named in that part. Any OTHER test that turns red is a defect in the part's code: fix the
  code, never the expectation. The one exception is stated in Part 3.

## Decision candidates

Load-bearing choices the design and ADRs leave open. The parts below follow each
recommendation; the session confirms or redirects before Part 1 starts.

| # | Choice | Alternatives (≤3) | Recommendation | Why |
|---|---|---|---|---|
| DC1 | ADR-1027 staging mechanism (decided here, as the ADR delegates it) | A. Build every pack in memory, then install all · B. Stage each pack's `.pack`/`.idx` under `tmp_pack_*`/`tmp_idx_*` and rename all at the end · C. Keep the order and unlink on refusal | **A** | The quarantine writer cannot stage today: `writePackArtifactsViaQuarantine` writes the tmp pair and renames it in the same call, inside one try/finally that removes the tmp files on any fault, and `writeCruftPack` does not quarantine at all (`writePackArtifacts` straight at the final names, then `.mtimes`). B means splitting both writers into stage/install halves and carrying a cross-build cleanup obligation for staged tmp files, which is more surface than the defect. A keeps both writers unchanged: `buildPack` already holds each pack's whole bytes in memory, so the only cost is holding the normal, promisor and cruft `BuildPackResult`s at the same time. C is the rejected D5-B (not crash-safe). Memory acceptance in Part 5 |
| DC2 | Build order once builds precede installs | A. normal → promisor → cruft (today's order) · B. cruft → promisor → normal (the design's flow sketch) | **A** | Nothing pins it: with one liar, either order refuses on the same id, and G10 (which liar is named) is out of scope. A is the minimal diff and keeps the existing `buildPack` call order that `maintenance.test.ts` spies observe |
| DC3 | Where the in-window acceptance check lives | A. New internal module `isLooseTruncationOf(ctx, id, packed)` in primitives/internal · B. Private function inside `gc-pipeline.ts` · C. Export from `object-resolver.ts` | **A** | ADR-1031 wants each condition pinned by its own test. A takes the packed bytes as an argument, so "truncate but bytes differ" is a one-line unit case. Through B the only route is a forged pack entry. C grows a 1071-line file for one consumer |
| DC4 | P1's design slice (rows a–o) exceeds one part's 6-file ceiling | A. Three parts: surface (a–g), fsck code sets (l–n), throw sites and flips (h–k, o) · B. One part of 16 files | **A** | The memory hint records first-spawn success only at ≤6 files. Order matters: the fsck sets must accept the code BEFORE any site throws it, or fsck rows go red mid-run. The `!` marker goes on the throw-site part (Part 3), the commit that actually breaks callers |
| DC5 | content-validation.ts `looseHeaderFailure` proof comment (row o) | A. Delete the `ConditionalExpression` disable line, name the third code in the prose · B. Keep the line and only add the third code to its text | **A** | With `LOOSE_OBJECT_CORRUPT` arriving, the `true` mutant reads `.reason` of `{ code, id }` → `undefined.startsWith` → TypeError out of the catch, so the existing past-window rows of content-validation.test.ts kill it. The equivalence the comment records becomes false, and B would keep a false suppression. The `StringLiteral` disable below it stays true (neither `''` nor `'Stryker was here!'` starts with `'unknown object type'`) and stays |

Property-test lens (.claude/workflow/property-testing.md), confirmed: no parser, decoder,
matcher or serializer changes shape. Every change is an error code, a read mode, a write order,
or a predicate over two byte arrays. No `*.properties.test.ts` part.

Public surface: the only new public symbol is the `LOOSE_OBJECT_CORRUPT` member of
`TsgitErrorData` (Part 1). Every other new symbol is internal: `looseObjectCorrupt` (domain
factory, imported by path like `badTreeObject`, not barrelled), `isLooseTruncationOf`, the
gc-pipeline staging types, and the test fixtures.

Docs (`docs/use/errors.md`, `docs/use/commands/maintenance.md`,
`docs/use/primitives/read-object.md`, the 6.0.0 release notes) and the backlog tick belong to
the documentation phase. No part edits them.

## Part 1 — `LOOSE_OBJECT_CORRUPT` on the error union

### Context

Public surface. `TsgitErrorData` is barrel-exported (src/index.ts L20,
`export { TsgitError, type TsgitErrorData }`). It reaches `DomainObjectError` through the union
in src/domain/error.ts L68, so the union itself needs no edit. Surface gates to pre-pay in THIS
part (.claude/workflow/surface-gates.md, section "New error code"):

1. The union member. In `src/domain/objects/error.ts`, type `DomainObjectError` (L10), add
   beside `BAD_TREE_OBJECT` (L49-50), with a one-line doc comment in the same style:
   `/** git's corrupt loose object <id>: a loose body that overruns its header's size claim past the 32-byte header window. */`
   `| { readonly code: 'LOOSE_OBJECT_CORRUPT'; readonly id: ObjectId }`
2. The factory. In the same file, after `badTreeObject` (L139):
   `export const looseObjectCorrupt = (id: ObjectId): TsgitError => new TsgitError({ code: 'LOOSE_OBJECT_CORRUPT', id });`
   Internal: do NOT add it to the src/domain/objects/index.ts barrel (`badTreeObject` is not
   there either; consumers import it from the module path).
3. The message switch. In `src/domain/error.ts`, `extractDetail` (L289, switch L290), add
   beside `case 'BAD_TREE_OBJECT':` (L354):
   `case 'LOOSE_OBJECT_CORRUPT': return \`corrupt loose object ${data.id}\`;`
   This is `Error.message`, as for every code. No rendered field goes into the data
   (ADR-1030). The `default` arm (L819, `const _exhaustive: never = data`) makes check:types
   fail until the case exists.
4. The exhaustiveness switch. In `test/unit/domain/exhaustiveness.ts`, `assertExhaustiveSwitch`,
   add `case 'LOOSE_OBJECT_CORRUPT':` next to `case 'BAD_TREE_OBJECT':` (L57). Its `never` default
   (L286) makes check:types fail without it.
5. Barrel-surface tests: test/unit/api-surface/snapshot-exports.test.ts and
   snapshot-barrel-surface.test.ts assert runtime exports only. A type-only union member changes
   neither, so no edit.
6. API report: regenerate `reports/api.json` with `npm run docs:json` and commit it in this
   part. It is a prepush gate (check:doc-typedoc), not a validate gate. The large typedoc-id
   churn is normal.

Tests to extend:
- `test/unit/domain/objects/error.test.ts`: a new `describe('Given looseObjectCorrupt(id)')`
  after the `Given treeUnreadable(id)` block (L175-187), same layout: `id = 'a'.repeat(40)`,
  `expect(result.data).toEqual({ code: 'LOOSE_OBJECT_CORRUPT', id })`. Add `looseObjectCorrupt`
  to the file's import list (L18 area).
- `test/unit/domain/error.test.ts`: a new `describe('Given LOOSE_OBJECT_CORRUPT')` right after
  the `Given BAD_TREE_OBJECT` block (L510-520), same layout:
  `new TsgitErrorClass({ code: 'LOOSE_OBJECT_CORRUPT', id: 'abc123' as never })`, then
  `expect(result.message).toBe('LOOSE_OBJECT_CORRUPT: corrupt loose object abc123')`. The
  `extractDetail exhaustive guard` test (L1075) stays as is.

Nothing in src throws the code yet. Part 2 teaches fsck to classify it, Part 3 throws it.

### TDD steps

1. RED (factory): `Given looseObjectCorrupt(id) > When checking error.data > Then code and id
   are set`. Fails because the module has no `looseObjectCorrupt` export (a TypeError
   "not a function" at runtime, plus a type error).
2. RED (message): `Given LOOSE_OBJECT_CORRUPT > When reading message > Then reads as git's
   corrupt loose object line`. Fails because `extractDetail` falls to its `default` arm and the
   message is `LOOSE_OBJECT_CORRUPT: [object Object]`, not `…: corrupt loose object abc123`.
   (A type error on the literal is expected until step 3.)
3. GREEN: items 1–4 of Context, in that order. Both REDs pass and check:types is green.
4. REFACTOR: none expected. Then run `npm run docs:json` and stage `reports/api.json`.

### Gate

```
npx vitest run test/unit/domain/objects/error.test.ts test/unit/domain/error.test.ts && npm run check:types && ./node_modules/.bin/biome check src/domain/objects/error.ts src/domain/error.ts test/unit/domain/exhaustiveness.ts test/unit/domain/error.test.ts test/unit/domain/objects/error.test.ts && npm run check:spelling
```
Notes. (a) wireit caches `check:types` and `check:spelling`: "Ran 0 scripts and skipped 1" is a
cached result. The bare oracles are `npx tsc --noEmit -p tsconfig.json` and
`npx cspell --no-progress <files>`. (b) No interop test in this part. (c) zsh does not
word-split a variable: pass literal file lists, as above. Also confirm `git status` shows
`reports/api.json` modified before committing.

### Commit

`fix(objects): add LOOSE_OBJECT_CORRUPT, the corrupt loose object refusal naming its id`

## Part 2 — fsck classifies `LOOSE_OBJECT_CORRUPT` as a corrupt loose read

### Context

ADR-1029: fsck's verdict on a corrupt loose object does not change. Every fsck code set that
classifies a loose read fault gains the new code BEFORE Part 3 makes any site throw it. Both
REDs inject the fault through a mocked or spied `readObject`, so they do not depend on Part 3.

Edits:
- `src/application/commands/internal/fsck/stored-corruption.ts`, `CORRUPTION_CODES` (L8-24):
  add `'LOOSE_OBJECT_CORRUPT'` after `'INVALID_OBJECT_HEADER'`. Extend the doc comment's list
  ("…zlib stream or header, a loose body that overruns its size claim, …").
- `src/application/commands/internal/fsck/packed-ref-tips.ts`, `LOOSE_UNREADABLE_CODES`
  (L27-30): add `'LOOSE_OBJECT_CORRUPT'`. Without it, `corruptionDie` (L35) returns `undefined`
  for a liar ref tip and git's `loose object <id> (stored in <path>) is corrupt` die
  (`invalidObjectHeader(…)`, L45) is lost. The die keeps code `INVALID_OBJECT_HEADER`: that is
  the existing fsck rewrap, not the reader's code. Update the doc comment above the set ("…cannot
  inflate it, parse its header, or bound its body to the header's claim").
- `src/application/commands/internal/fsck/object-cache.ts`, `RECOVERABLE_DECODE_CODES` (L126):
  add `'LOOSE_OBJECT_CORRUPT'` after `'INVALID_OBJECT_HEADER'`. Without it, `warrantsRecovery`
  (L467) reaches `recoverStoredType` only through `probeLooseOid(ctx, id)`, which probes the
  PRIMARY only. A liar held loose in an alternate then loses its recovered type.
  `isRecoveryCandidate` (L109) and the `DecodeError` type (L102) stay unchanged: they filter
  header-probe errors (`recoverHeader`), which never raise the new code.

Tests:
- `test/unit/application/commands/internal/fsck/packed-ref-tips.test.ts`: the file already
  `vi.mock`s read-object (L35-41). Add a third row to the `describe.each` at L190-210
  (`'Given a loose ref tip no pack claims whose read fails with %s'`):
  `['a corrupt loose object', looseObjectCorrupt('a'.repeat(40) as ObjectId)]`. Import
  `looseObjectCorrupt` from src/domain/objects/error.js (the import block at L13-22 already
  imports from domain error modules). The fault's own id is not read by `corruptionDie`, so a
  fixed id is fine. The expected die is the existing assertion:
  `{ code: 'INVALID_OBJECT_HEADER', reason: 'loose object <id> (stored in <looseObjectPath>) is corrupt' }`.
- `test/unit/application/commands/internal/fsck/object-cache.test.ts`: a new block modelled on
  `'Given a tree whose loose bytes live only in an alternate and do not parse'` (L145-190), which
  uses the donor `'/repo/donor/objects'` plus info/alternates. Arrange: the donor holds a loose
  file whose stored bytes are `blob 5\0` followed by 200 bytes, at the id
  `ctx.hash.hashHex(raw)`. Add `import * as readObjectModule from` the read-object module and
  `vi.spyOn(readObjectModule, 'readObject').mockRejectedValueOnce(looseObjectCorrupt(id))`
  (`buildObjectCache` imports `readObject` from that module; namespace spying works in this repo,
  see build-pack.test.ts L18). Add `vi` to the vitest import and an
  `afterEach(() => vi.restoreAllMocks())`. Act: `buildObjectCache(ctx, new Set([id]), 'classify')`.
  Assert: `result.recovered.get(id)` is `'blob'`. If that assertion is already green before the
  GREEN (meaning `probeLooseOid` reaches alternates after all), the row is a GUARD: record it,
  and add a spy on the loose-oid-cache module's `probeLooseOid` asserting it is not called with
  `id` (`readObject` is mocked, so the only probe left is `warrantsRecovery`'s). That spy
  assertion is the RED.

One test kills both membership mutants in packed-ref-tips (dropping the code from
`CORRUPTION_CODES` rethrows the fault; dropping it from `LOOSE_UNREADABLE_CODES` resolves
`undefined`). The object-cache test kills the third.

### TDD steps

1. RED (packed-ref-tips row): `Given a loose ref tip no pack claims whose read fails with a
   corrupt loose object > When ref tips are checked > Then it refuses as git dies on the corrupt
   loose object`. Fails because `isStoredCorruption` is false for the new code, so
   `assertReadableUnlessAbsent` rethrows `LOOSE_OBJECT_CORRUPT` instead of the
   `INVALID_OBJECT_HEADER` die.
2. GREEN: add the code to `CORRUPTION_CODES`, run again. Still red: `corruptionDie` now returns
   `undefined` and the check resolves. Add it to `LOOSE_UNREADABLE_CODES`, and the row is green.
   (One RED, two set edits, both needed.)
3. RED (object-cache): `Given a blob held loose only in an alternate whose read refuses as a
   corrupt loose object > When buildObjectCache classifies unreadable objects > Then its stored
   type is recovered from the alternate holder`. Fails because `recovered.get(id)` is
   `undefined`: `isDecodeFault` is false and `probeLooseOid(ctx, id)` finds no primary copy.
4. GREEN: add the code to `RECOVERABLE_DECODE_CODES`.
5. REFACTOR: doc comments only.

### Gate

```
npx vitest run test/unit/application/commands/internal/fsck/packed-ref-tips.test.ts test/unit/application/commands/internal/fsck/object-cache.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/commands/internal/fsck/stored-corruption.ts src/application/commands/internal/fsck/packed-ref-tips.ts src/application/commands/internal/fsck/object-cache.ts test/unit/application/commands/internal/fsck/packed-ref-tips.test.ts test/unit/application/commands/internal/fsck/object-cache.test.ts && npm run check:spelling
```
Notes. (a) wireit caches `check:types`/`check:spelling`. Bare oracles:
`npx tsc --noEmit -p tsconfig.json`, `npx cspell --no-progress <files>`. (b) No interop.
(c) Literal file lists (zsh).

### Commit

`fix(fsck): read LOOSE_OBJECT_CORRUPT as a corrupt loose object`

## Part 3 — the buffered tier refuses an overrun as `LOOSE_OBJECT_CORRUPT { id }`

### Context

This is the breaking change (ADR-1029, 6.0.0): the three past-window refusal sites throw
`looseObjectCorrupt(id)` instead of `INVALID_OBJECT_HEADER { reason: 'content exceeds declared
size <claim>' }`. The claim-bearing reason is dropped. `INVALID_OBJECT_HEADER` keeps the
unparseable header, the header-too-long refusal and the commit/tree/tag `size mismatch`.

Edits in `src/application/primitives/object-resolver.ts`:
- Add `looseObjectCorrupt` to the import from the domain objects error module (L7-13).
- `inflateLooseSinglePass(ctx, id, compressed)` (L229, throw L241): `id` is a parameter.
  Replace `throw contentExceedsDeclaredSize(size)` with `throw looseObjectCorrupt(id)`.
- `inflateBoundToClaim(ctx, compressed, cap, declaredSize)` (L134, throw L144): `id` is not in
  scope. Change the signature to `inflateBoundToClaim(ctx, id, compressed, cap)`: drop
  `declaredSize`, which only worded the reason. Throw `looseObjectCorrupt(id)`. Its only caller
  is `inflateLooseHeadProbed(ctx, id, compressed)` (L255), at L263:
  `inflateBoundToClaim(ctx, compressed, cap, size)` becomes `inflateBoundToClaim(ctx, id, compressed, cap)`.
- Delete `contentExceedsDeclaredSize(size)` (L107-112, with its doc comment). After this part
  nothing uses it, and the repo allows no dead code. `invalidObjectHeader` is then unused in this
  file, so drop it from the import (L9). `sizeMismatch` and `looseHeaderTooLong` keep their
  imports.
- Doc comments that name the old code: `inflateBoundToClaim` (L124-133), `inflateLooseSinglePass`
  (L218-228, "throws `INVALID_OBJECT_HEADER`"), `inflateLooseHeadProbed` (L245-254). Reword them
  to `LOOSE_OBJECT_CORRUPT`.

Edits in `src/application/primitives/internal/blob-source.ts`:
- Drop `contentExceedsDeclaredSize` from the object-resolver import (L38) and import
  `looseObjectCorrupt` from the domain objects error module (the import at L16-21 already reads
  from it).
- `assertWithinClaim(total, declaredSize)` (L750, throw L752): becomes
  `assertWithinClaim(id, total, declaredSize)` and throws `looseObjectCorrupt(id)`. Its caller
  `yieldAndVerifyLooseChunks(ctx, id, header, iterator, verifyHash, declaredSize?)` (L763) has `id`
  as a parameter and calls it at L779 and L789. Update both calls, and the doc comments
  (L747-749, L755-761).

Edit in `src/application/commands/internal/fsck/content-validation.ts`, `looseHeaderFailure`
(L76): no behaviour change. A `LOOSE_OBJECT_CORRUPT` has no `reason`, so it takes the `''` arm
and maps to `unterminatedHeader`, today's verdict. Per DC5, delete the
`// Stryker disable next-line ConditionalExpression: …` line (L82). With a third code reaching
this function, its `true` mutant reads `.reason` of `{ code, id }` → `undefined.startsWith` →
TypeError, and the past-window rows of content-validation.test.ts (L529 commit, L626 blob) kill
it, so the recorded equivalence is false. Reword the prose comment (L77-80) to name the three
codes `inflateLooseBuffered` throws (`INVALID_OBJECT_HEADER`, `DECOMPRESS_FAILED`,
`LOOSE_OBJECT_CORRUPT`). Keep the `StringLiteral` disable (L85): it stays true for both
reason-less codes.

The 13 existing expectations that flip. Each one pins the OLD contract (a past-window overrun
as `INVALID_OBJECT_HEADER` with the claim in `reason`), which this part's ratified change
replaces. Flip only these. Each becomes `data.code === 'LOOSE_OBJECT_CORRUPT'` and
`data.id === <the id read>`, and every `reason` assertion is removed:

| file | `it` line · test | today's assertion lines |
|---|---|---|
| `test/unit/application/primitives/object-resolver.test.ts` | L1695 single-pass (`'Then it throws INVALID_OBJECT_HEADER naming the claim, from the single-pass…'`) | L1714-1718; keep `inflateSpy` calls === 1 |
| same | L1965 head-probed (`"…remapped from the compressor's own cap-exceeded refusal"`) | L1985-1989; keep its `inflateHeadSpy` assertion |
| `test/unit/application/primitives/internal/blob-source.test.ts` | L340 bytes arm | L358-362 |
| same | L400 stream arm, first chunk | L425-429 |
| same | L507 stream arm, running total (second chunk) | L506-510 |
| `test/integration/loose-header-size-interop.test.ts` | L344 `diff` withStat, L374 break-rewrite, L410 `ignoreWhitespace`, L443 `archive` (blob claim 500) | L371, L407, L438, L466 |
| same | L656 forged HEAD commit (status), L683 forged HEAD tree | L676, L704 |
| same | L880 commit overrun | L905-910 |
| same | L963 tree `it.each`: ONLY the `delta: -10` row (`reasonNamesClaim: true`) | L988-992: split the expected code by `reasonNamesClaim`, so the `true` row expects `LOOSE_OBJECT_CORRUPT` with `data.id === treeId` and the `delta: 125` row keeps `INVALID_OBJECT_HEADER` with its `size mismatch` reason |

In the interop rows the id is the forged object's id (`smallId`, `commitId`, `treeId`, etc. as
each row names it). Also rename each flipped `it` title that says "refuses INVALID_OBJECT_HEADER"
to say "refuses LOOSE_OBJECT_CORRUPT". In the L963 `it.each` title, which serves both rows,
use `'Then git refuses ($label) and tsgit refuses'`. L656 and L683 assert the code with no
reason. Their claim is `body.byteLength - 10` on a body longer than the window, so they reach
the same sites as L880; confirm each by its red.

The one exception to "any other red is a defect": if a test outside these 13 turns red, and it
provably pins a past-window overrun refusal (its fixture's body overruns the claim by more than
`32 - headerLength` bytes) that the design's grep missed, flip it the same way and list it in
the hand-back report. Any other red is a defect.

Guards that must stay green (no edit):
- test/unit/application/commands/internal/fsck/content-validation.test.ts L529 and L626 (fsck
  verdict `unterminatedHeader` unchanged).
- test/integration/loose-header-size-interop.test.ts L796, "a size-lying blob stored at its own
  hash" (fsck interop).
- The under-run rows of the same suite: tree `delta: 125` and the commit row at L915. They keep
  `INVALID_OBJECT_HEADER` `size mismatch`.

### TDD steps

1. RED (interop pins): flip the 8 interop rows above. Run them (Gate b). Each fails with
   `expected 'INVALID_OBJECT_HEADER' to be 'LOOSE_OBJECT_CORRUPT'`. They go green progressively
   through steps 2–4, and all must be green after step 4.
2. RED (`inflateLooseSinglePass`): flip object-resolver.test.ts L1695. Fails: `data.code` is
   `INVALID_OBJECT_HEADER`. GREEN: throw `looseObjectCorrupt(id)` at L241.
3. RED (`inflateBoundToClaim`): flip L1965. Fails the same way through the head-probed arm.
   GREEN: the signature change plus the throw, and the caller update in `inflateLooseHeadProbed`.
4. RED (`assertWithinClaim`): flip the three blob-source.test.ts rows. Each fails with
   `INVALID_OBJECT_HEADER`. The L340 bytes-arm row may already be green after step 2, because
   the bytes arm goes through `inflateLooseBuffered`. If it is, record it as a GUARD, not a RED.
   GREEN: add `id` to `assertWithinClaim` and its two calls, throw `looseObjectCorrupt(id)`, then
   delete `contentExceedsDeclaredSize` and its now-unused imports in both files.
5. GUARD: content-validation.test.ts (whole file) is green. It passes because the new code
   takes `looseHeaderFailure`'s `''` arm, so the msgId stays `unterminatedHeader`.
6. REFACTOR: the content-validation.ts comment edit (DC5), and the doc-comment rewording in
   object-resolver.ts and blob-source.ts.

### Gate

```
npx vitest run test/unit/application/primitives/object-resolver.test.ts test/unit/application/primitives/internal/blob-source.test.ts test/unit/application/commands/internal/fsck && PATH="<git-2.55-bin>:$PATH" npx vitest run test/integration/loose-header-size-interop.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/primitives/object-resolver.ts src/application/primitives/internal/blob-source.ts src/application/commands/internal/fsck/content-validation.ts test/unit/application/primitives/object-resolver.test.ts test/unit/application/primitives/internal/blob-source.test.ts test/integration/loose-header-size-interop.test.ts && npm run check:spelling
```
Notes. (a) wireit caches `check:types`/`check:spelling`. Bare oracles:
`npx tsc --noEmit -p tsconfig.json`, `npx cspell --no-progress <files>`. (b) Interop tests spawn
real git: run them with the pinned git 2.55 first on PATH, `<git-2.55-bin>` being its `bin`
directory. A run without git skips every row (`GIT_AVAILABLE`), and a skipped row is not a
green one. (c) Literal file lists (zsh). Also run `npx vitest run test/unit/application/primitives`
once to catch an overrun pin the design's grep missed (see the exception above).

### Commit

`fix(objects)!: refuse a buffered loose overrun as LOOSE_OBJECT_CORRUPT with its id`

## Part 4 — the pack-building reader takes the buffered loose tier

### Context

ADR-1028. `readObjectMetadataWithContent` (internal, used only by
src/application/primitives/build-pack.ts `readBaseContent` L180-191 and
src/application/primitives/internal/deltify.ts `buildEmissionOrder` L125-134) reads a loose
object through the BUFFERED tier: a past-window overrun refuses (`LOOSE_OBJECT_CORRUPT`, from
Part 3), an in-window overrun yields its truncation, and `uncompressedSize` is the length of the
bytes that tier yields. `readObjectMetadata` keeps the STREAMED tier (ADR-902, content-derived).

Edits in `src/application/primitives/read-object.ts`. `LooseReadMode` is already imported
(it is exported from object-resolver at L83 and used by `readObjectStreamed` L202-212):
- `readObjectMetadata(ctx, id)` (L265): call a mode-taking internal with `'streamed'`.
- `readObjectMetadataWithContent(ctx, id)` (L277): keep its public-internal signature and pass
  `'buffered'`. Suggested shape: a private
  `readMetadataWithContentIn(ctx, id, mode: LooseReadMode)` that both entry points call, so
  neither takes a mode argument from callers. Callers in build-pack.ts and deltify.ts stay
  untouched.
- `resolveObjectMetadataWithContent(ctx, store, id)` (L462) gains `mode: LooseReadMode` and
  threads it to both arms.
- `metadataFromLoose(ctx, store, source, id)` (L480): `resolveLooseArm(…, 'streamed')` (L486-493)
  becomes `resolveLooseArm(…, mode)`. `resolveLooseArm` already routes `'buffered'` through
  `applyLooseVerdict` (honest / truncate to the claim / underrun real bytes / refuse
  size-mismatch), so the returned `content` is the servable buffered bytes, and
  `uncompressedSize: loose.content.length` stays correct. Rewrite the doc comment (L476-479):
  the pack builders take the buffered tier, and `readObjectMetadata` alone stays streamed.
- `metadataAfterFullMiss(ctx, store, id)` (L501): `resolveObjectContent(…, 'streamed')` (L506-513)
  becomes `…, mode)`.
- Rewrite the doc comments of `ObjectMetadataWithContent` (L244-251) and
  `readObjectMetadataWithContent` (L269-276) to state the buffered contract.

Fixture (test infra, folded here because this part's tests are its first users): in
`test/unit/application/primitives/fixtures.ts`, next to `writeLooseWithDeclaredSize` (L356-370),
add
`export async function writeSelfHashedLooseWithDeclaredSize(ctx: Context, type: ObjectType, declaredSize: number, content: Uint8Array): Promise<ObjectId>`.
It builds the same `serializeHeader(type, declaredSize) + content` bytes, takes
`id = await ctx.hash.hashHex(bytes)`, writes the deflated bytes at
`${ctx.layout.gitDir}/objects/${computeLooseObjectPath(id)}` and returns `id`: a store written at
the SHA-1 of its own stored bytes, git's shape for a planted liar. Extract the shared byte
assembly (a private `looseBytesWithClaim(type, declaredSize, content)`) so both helpers use it
(DRY). Trap: the loose fanout cache only learns tsgit's own writes. Call the helper before any
read touches that fanout prefix (in practice right after building the context).

Fixtures used below: `OVERRUN = Uint8Array.from({ length: 200 }, (_, i) => i)` with claim 5 (past
the window: header `blob 5\0` is 7 bytes, 7 + 200 > 32), and `IN_WINDOW = 10 bytes` with claim 5
(7 + 10 ≤ 32 → the `'truncate'` verdict, servable bytes = the first 5).

Tests:
- `test/unit/application/primitives/read-object-metadata.test.ts`: add
  `readObjectMetadataWithContent` to the read-object import (L3-8) and a new top-level
  `describe('readObjectMetadataWithContent')` after the `readObjectMetadata` block (it ends near
  L646). Its rows: (i) a past-window liar on the loose route → try/catch,
  `data.code === 'LOOSE_OBJECT_CORRUPT'`, `data.id === id`; (ii) an in-window liar on the loose
  route → `uncompressedSize === 5`, `content.length === 5`, and `content` equals the first 5
  body bytes; (iii) an in-window liar on the full-miss route, modelled on `'Given a loose object
  that appears after its id missed…'` (L625-645: miss first, then plant the file) →
  `uncompressedSize === 5`. Use `buildSeededContext()` and the new self-hashed helper. For row
  (iii) the plant must come after the miss, so write the bytes directly as L631-634 does.
- `test/unit/application/primitives/build-pack.test.ts` (imports at L10-35;
  `buildSeededContext` is imported from fixtures): a new `describe('Given a single loose blob
  whose body overruns its size claim past the header window')` > `When buildPack builds it
  without deltas` (`{ objects: [{ id }], delta: false }`, the `readBaseContent` path) >
  `Then it refuses with LOOSE_OBJECT_CORRUPT naming the blob`.
- `test/unit/application/primitives/internal/deltify-carried-content.test.ts`: two rows using
  `deltifyEntries(ctx, [{ id }, { id: honestId }], DEFAULT_POLICY)` (the file's sut). (i) The
  default context, where the liar's content is carried → refuses `LOOSE_OBJECT_CORRUPT` with
  `data.id`. (ii) `createMemoryContext({ deltaCacheMaxBytes: 0 })` (L64), where nothing is
  carried and the emission loop re-reads through `readRawObject` → refuses the same way. Import
  the self-hashed helper from fixtures, next to `buildSeededContext` (L18).
- Guard, no edit: read-object-metadata.test.ts L159-176 (`readObjectMetadata` on a 12-byte body
  claiming 5 → `uncompressedSize === 12`). This is ADR-902's pin and the kill for a `'streamed'`
  → `'buffered'` mutant in `readObjectMetadata`.

Where git agrees: G9 (push / bundle create / pack-objects refuse the same overrun) follows from
this part, because all three share `buildPack`. Unit rows only; interop for them is out of
scope.

### TDD steps

All of the steps below exercise the same seam (`readObjectMetadataWithContent` and its two
arms), so write and run every RED before the single GREEN:

1. RED: read-object-metadata row (i). Fails because the streamed loose arm returns the 200 real
   bytes, so the call resolves.
2. RED: row (ii). Fails: `uncompressedSize` is 10 (the streamed real length), not 5.
3. RED: row (iii), the full-miss route. Fails: 10, not 5 (`metadataAfterFullMiss` pins
   `'streamed'`).
4. RED: build-pack.test.ts single-blob `delta: false`. Fails because `readBaseContent` takes the
   carried streamed content and the build resolves, writing the 200 real bytes under the lying id.
5. RED: deltify-carried-content row (i), carried. Fails the same way: the content is carried
   into the emission entry and never re-read.
6. GUARD: deltify-carried-content row (ii), zero budget. It already refuses: the content is not
   carried, so the emission loop's `readRawObject` (buffered, Part 3) throws
   `LOOSE_OBJECT_CORRUPT`.
7. GREEN: thread `mode` as described in Context. Steps 1–5 go green. The L159 guard stays
   green.
8. REFACTOR: doc comments. Rows (ii)/(iii) also pin the in-window truncation that gc relies on
   later.

### Gate

```
npx vitest run test/unit/application/primitives/read-object-metadata.test.ts test/unit/application/primitives/build-pack.test.ts test/unit/application/primitives/internal/deltify-carried-content.test.ts test/unit/application/primitives/internal/deltify.test.ts test/unit/application/primitives/read-object.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/primitives/read-object.ts test/unit/application/primitives/fixtures.ts test/unit/application/primitives/read-object-metadata.test.ts test/unit/application/primitives/build-pack.test.ts test/unit/application/primitives/internal/deltify-carried-content.test.ts && npm run check:spelling
```
Notes. (a) wireit caches `check:types`/`check:spelling`. Bare oracles:
`npx tsc --noEmit -p tsconfig.json`, `npx cspell --no-progress <files>`. (b) No interop in this
part. (c) Literal file lists (zsh).

### Commit

`fix(pack): size and carry a loose entry from the buffered tier when building a pack`

## Part 5 — gc builds every pack before it installs any

### Context

ADR-1027 with DC1-A (in-memory staging) and DC2-A (build order normal → promisor → cruft).
A refusal during any build leaves the registered pack set, the `.mtimes` sidecars and every
loose file exactly as they were. Today (after Part 4), a liar that only the cruft build reads
(unreachable, unexpired, cruft packs on) refuses after the normal pack is already written and
registered.

Current code in `src/application/commands/internal/gc-pipeline.ts`:
- `writeRepack(run, plan, existing)` (L1194-1211) calls, in order,
  `buildAndWriteNormalPack(ctx, packDir, plan.toNormalPack, existingCruftShas)` (L584),
  `buildAndWritePromisorPack(ctx, packDir, plan.toPromisorPackInputs)` (L614),
  `writeCruftOutcome(run, plan, existing.existingCruft)` (L1213) → `applyCruftOutcome(…)` (L688),
  and then `verifyPacked(ctx, plan)` (L1228).
- `applyCruftOutcome` decides: `!cruftPacksEnabled` → `loosenIfNotLoose` every survivor (a
  durable write); then `decideCruftFate` (cruft-pack-lifecycle.ts L202) gives `'noop'` → the
  existing pack's id, `'delete'` → `undefined`, `'rewrite'` → `buildAndWriteCruftPack` (L642),
  which returns early WITHOUT writing when `existingCruftShas.has(pack.sha)`.
- Writers, unchanged by this part: `writePackArtifactsViaQuarantine` (write-pack-artifacts.ts)
  and `writeCruftPack` (cruft-pack-lifecycle.ts L225). `buildPack` returns `BuildPackResult`
  (build-pack.ts L51: `bytes`, `sha`, `objectCount`, `entries`, `emissionOrder`).
- `RepackOutputs` (L954), `NormalPackOutcome` (L559) and `CruftOutcome` (L677) keep their shapes.
  `retireSuperseded`, `ranResult` and the rest of `repack` (L1015) consume them unchanged.

Target shape (names are suggestions; keep each function under 20 lines):

    type StagedCruft =
      | { readonly kind: 'loosen' }                                         // gc.cruftPacks=false
      | { readonly kind: 'kept'; readonly cruftPackId: ObjectId | undefined } // noop, delete, or a rebuild reproducing an existing sha
      | { readonly kind: 'fresh'; readonly pack: BuildPackResult };

    interface StagedRepack {
      readonly normal: BuildPackResult | undefined;   // undefined when plan.toNormalPack is empty
      readonly promisor: BuildPackResult | undefined; // undefined when plan.toPromisorPackInputs is empty
      readonly cruft: StagedCruft;
    }

    async function writeRepack(run, plan, existing): Promise<RepackOutputs> {
      const staged = await buildRepack(run, plan, existing);       // every read, no write
      const outputs = await installRepack(run, plan, existing, staged); // every write
      await verifyPacked(run.ctx, plan);
      return outputs;
    }

- `buildRepack`: normal → promisor → cruft, sequential. `stageCruft` holds today's decision tree
  from `applyCruftOutcome` minus the writes. The `existingCruftShas.has(pack.sha)` check that
  `buildAndWriteCruftPack` makes moves here and yields `kept`.
- `installRepack`: normal (`writePackArtifactsViaQuarantine`, `promisor: false`; `reuse` stays
  `existingCruftShas.has(pack.sha) ? 'cruft' : 'none'`) → promisor (`promisor: true`) → cruft
  (`loosen` → `boundedMapFor(ctx, 'ioBound', survivors, (id) => loosenIfNotLoose(…))`, `kept` →
  its id, `fresh` → `writeCruftPack` with today's `mtimeAt` mapping through
  `pack.emissionOrder`). This is today's write order.
- Move the existing doc comments (the "ALWAYS writes fresh" rationale of the normal and promisor
  builders, and the same-sha reuse rationale of the cruft builder) onto the install or stage
  function that now carries each behaviour. Rewrite the `writeRepack` doc to "builds every pack,
  then installs them, then verifies", and add one line on why: a refused build must leave no
  registered pack.
- Spies in test/unit/application/commands/maintenance.test.ts observe
  `buildPack` (L2622-3024), `writePackArtifactsViaQuarantine` (L4282, L5604),
  `declassifyCruftPack` and `writeLooseObject`. They keep passing because the same module
  functions are called with the same arguments. Run the whole file. A red there is a defect in
  this part.

Memory acceptance (DC1-A): the cost is the cruft and promisor `BuildPackResult` bytes held while
the normal pack builds, plus all three held until install. Run `npm run bench:memory` once the GREEN is in and
record the "gc residency" scenario's peak RSS (tooling/bench-memory.ts L943-1000) in the hand-back report,
next to the latest committed baseline if the repo keeps one (never check out another ref to
measure). That scenario has only reachable objects (no cruft or promisor pack),
so it should be within noise. Report that it cannot show the cruft-held cost, so the reviewer
judges it, rather than claiming a measurement. Check the machine is quiet first (uptime, no
foreign stryker).

Unit tests in `test/unit/application/commands/maintenance-task-failure.test.ts` (memory adapter,
`maintenance(ctx, { tasks: ['gc'] })`). Add a new `describe('gc over a size-lying loose blob')`
inside the top-level `describe('maintenance task failure')`, after `'gc over a history git cannot
walk'` (L144-282). Parts 6 and 7 extend it. Its helper:
`liarRepo({ reachable, declaredSize, body })`:
`createMemoryContext()` → `init(ctx)` → write the liar FIRST with
`writeSelfHashedLooseWithDeclaredSize(ctx, 'blob', declaredSize, body)` (import from
../primitives/fixtures.js, plain path) → write an honest blob `hello` with `writeObject` → a tree
naming `a.txt` → that blob, plus `liar.bin` → liarId when `reachable`
(`treeEntry('100644' as FileMode, …)`; tree entries must be name-sorted) → a commit (`AUTHOR`)
and the main branch ref pointing at it (the `commitNaming` steps, L166-183).
Census helper: `packDirNames(ctx)` = the `.pack`/`.idx`/`.mtimes` names under
`packsDir(commonGitDir(ctx))` (path-layout exports both; an absent directory reads as `[]`,
catch `FILE_NOT_FOUND` only). The liar file bytes are read with
`ctx.fs.read(looseObjectPath(commonGitDir(ctx), liarId))`.

Rows (OVERRUN = 200 bytes, claim 5):
- reachable liar: `tasksFailed` equals
  `[{ task: 'gc', code: 'LOOSE_OBJECT_CORRUPT', data: { code: 'LOOSE_OBJECT_CORRUPT', id: liarId } }]`,
  `tasksRun` is `[]`, the pack census is unchanged (empty), and the liar's bytes are unchanged.
- unreachable unexpired liar, cruft on (the default, `gc.pruneExpire` unset = 2 weeks): the same
  `tasksFailed`, and zero `.pack` and zero `.mtimes` after the run.
- the same with a pre-existing pack: run one gc BEFORE writing the liar (so the liar is written
  after the first run; use `forgetLooseOidPrefix(ctx, liarId)` from
  primitives/internal/loose-oid-cache after the direct write, or the probe misses it), snapshot
  the census, then run gc → census equal to the snapshot and the same `tasksFailed`.

Interop (folded here, this part's code). In `test/integration/maintenance-interop.test.ts`, add
a new top-level `describe.skipIf(!GIT_AVAILABLE)('maintenance interop — gc over a size-lying loose
blob', …)` at the end of the file (after the `'… gc over a history git cannot walk'` block,
L2260-2334, which is the model: `tryRunGitWithExit([...'maintenance', 'run', '--task=gc'])` on the
peer, structured `tasksFailed` on ours, stderr rebuilt from `data`). Parts 6 and 7 extend this
block. Helpers inside it:
- `buildLiarBase({ reachable, declaredSize, body, prepack })`: `initRepo` + `addCommit` (both in
  this file), optionally `git repack -d -q` (prepack), then
  `forgeOwnHash(dir, declaredSize, body)`. When `reachable`:
  `git update-index --add --cacheinfo 100644,<oid>,liar.bin` and `git commit -q -m liar` with
  `GIT_AUTHOR_DATE`/`GIT_COMMITTER_DATE` pinned (`execFileSync('git', …, { env: { ...runGitEnv(), GIT_AUTHOR_DATE: '1700000000 +0000', GIT_COMMITTER_DATE: '1700000000 +0000' } })`).
- `corruptLines(id)` →
  `error: corrupt loose object '<id>'\nfatal: loose object <id> (stored in .git/objects/<id[0..2]>/<id[2..]>) is corrupt\n`
  (ADR-1030: built from `data.id` alone).
- `registeredPacks(dir)` → sorted `pack-*.pack` names in the repository pack directory (git's
  `tmp_pack_*` residue is excluded by the prefix filter; the divergence is recorded in ADR-1027).
- Use `makeTwin` (L171), `runOursGc` (L198, builds the Context after the copy), `disposeTwin`.

Lift `forgeOwnHash` (test/integration/loose-header-size-interop.test.ts L99-106) into
`test/integration/interop-helpers.ts` as an exported
`forgeOwnHash(dir: string, claim: number, body: Buffer): Promise<string>`. Build the loose path
inside it (`path.join(dir, '.git', 'objects', sha1.slice(0, 2), sha1.slice(2))`) and add the
node:crypto / node:zlib / node:fs/promises / node:path imports it needs. Then delete the local
copy in `test/integration/loose-header-size-interop.test.ts` and import it from there. Drop any
import that becomes unused there (biome flags it; `createHash`/`deflateSync` are likely still
used by other helpers in that file).

Interop rows (sha1, one liar each):
- reachable, OVERRUN 5/200: the peer exits 1, and its stderr equals
  `corruptLines(id) + 'fatal: failed to run repack\nerror: task \'gc\' failed\n'`, rebuilt from
  OURS' `result.tasksFailed[0].data.id`. Ours: `tasksFailed[0].code === 'LOOSE_OBJECT_CORRUPT'`,
  `tasksRun` lacks `'gc'`. Both twins: `registeredPacks` equal to the base's, no `.mtimes`,
  `git count-objects` equal, liar file bytes unchanged. Then, on the same peer after those assertions,
  `git gc` exits 128 (the store is unchanged apart from git's tmp residue).
- unreachable unexpired, cruft on, `it.each` over `prepack: false | true`: the same assertions.
  The reachable objects stay loose on both (`git count-objects` equal before and after on each
  twin).

### TDD steps

1. GUARD (reachable liar, unit): it already passes after Part 4, because the normal build is the
   first build and refuses before any write. Run it to prove it.
2. RED (unreachable, cruft on, unit): fails because the census shows the normal pack's
   `.pack`/`.idx`. `buildAndWriteNormalPack` wrote and registered it before the cruft build
   refused.
3. RED (unreachable with a pre-existing pack, unit): fails because the census gained the new
   normal pack.
4. GREEN: split `writeRepack` into `buildRepack` + `installRepack` as in Context.
5. GUARD: the whole of test/unit/application/commands/maintenance.test.ts stays green (same
   writers, same order, same arguments).
6. Lift `forgeOwnHash`, run test/integration/loose-header-size-interop.test.ts green (a
   behaviour-preserving move).
7. GUARD (reachable interop): passes, by step 1's reasoning.
8. Interop, unreachable `it.each`: write it before step 4 to see ours fail (a registered normal
   pack on the tsgit twin), then green after step 4. If written after, record it as a GUARD in
   the hand-back report. Never revert code to watch it fail.
9. REFACTOR: docs moved onto the stage and install functions. Function sizes ≤ 20 lines.

### Gate

```
npx vitest run test/unit/application/commands/maintenance-task-failure.test.ts test/unit/application/commands/maintenance.test.ts && PATH="<git-2.55-bin>:$PATH" npx vitest run test/integration/maintenance-interop.test.ts test/integration/loose-header-size-interop.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/commands/internal/gc-pipeline.ts test/unit/application/commands/maintenance-task-failure.test.ts test/integration/maintenance-interop.test.ts test/integration/interop-helpers.ts test/integration/loose-header-size-interop.test.ts && npm run check:spelling
```
Notes. (a) wireit caches `check:types`/`check:spelling`. Bare oracles:
`npx tsc --noEmit -p tsconfig.json`, `npx cspell --no-progress <files>`. (b) Interop tests need
the pinned git 2.55 first on PATH (`<git-2.55-bin>`). Without git every row skips, and a skip is
not green. (c) Literal file lists (zsh). Then run `npm run bench:memory` (see Context) once
before committing. It builds dist first, so expect a few minutes.

### Commit

`fix(gc): build every pack before installing any, so a refused build leaves the store untouched`

Why separate from Parts 6 and 7 (they share gc-pipeline.ts, the two gc test files and the
interop block): each part changes one ratified gc behaviour with its own REDs, and merged they
exceed 5 cycles. loose-header-size-interop.test.ts is shared with Part 3 only for the
`forgeOwnHash` import swap. Part 3 is already at the 6-file ceiling, and the lift belongs to the
helper's first new consumer, this part.

## Part 6a — the closure types a blob want from its header alone

Inserted after Part 5 landed, before Part 6 commits. Part 6's alternates row (a borrower whose
index names a size-lying blob that only the donor holds) failed where the plan expected a pass:
tsgit's gc refused `LOOSE_OBJECT_CORRUPT` and git exited 0. Part 6's green edits stay uncommitted
in the tree while this part lands; this part touches none of Part 6's four remaining files.

### Context

Root cause, measured (`runGcTask` on a donor/borrower pair, pinned git 2.55.0): the closure
types every WANT by reading its whole body. `src/application/primitives/internal/closure-engine.ts`
`resolveWant` (L326-341) calls `resolveTagChain` then `readObject(ctx, peeled)` (L335);
`src/application/primitives/internal/object-emit.ts` `resolveTagChain` (L41-58) calls
`parseTypedObject(ctx, table, current)` on every hop, the final non-tag hop included, and
`parseTypedObject` is `readObject` (object-type-table.ts L181), the buffered tier. gc passes the
index entries as wants (fsck/roots.ts `collectRetentionRoots`), so a size-lying blob in the index,
or named directly by a ref, refuses at root resolution even when an alternate holds it and gc would
never pack it. Reached through a tree only (index entry removed) tsgit already succeeds, because
`emitTreeContents` types a blob from the tree entry mode without reading it.

git: `parse_object` (object.c) types a blob want through `oid_object_info` — the header only — and,
without `--verify-objects`, never inflates its body; `--indexed-objects` adds index blobs to pending
with no read at all. Pinned: index→borrowed liar and ref→borrowed liar: git `gc` exit 0, tsgit
refuses; index→local liar and ref→local liar: git exit 128 at `pack-objects` (`error: corrupt loose
object`), tsgit refuses — same outcome, different site; index→missing blob: git `fatal: unable to
read <oid>` exit 128, tsgit `OBJECT_NOT_FOUND` — match.

Edits:
- `src/application/primitives/internal/object-emit.ts` `resolveTagChain`: at the top of each loop iteration read
  `readDeclaredObjectHeader(ctx, current)` (import from ../read-object.js). When its `type` is
  `'blob'`: `if (!assignObjectType(ctx, table, current, 'blob')) throw objectNotFound(current);
  return current;` — the same `undefined → objectNotFound` contract `parseTypedObject` has. Any
  other type keeps today's `parseTypedObject` hop. Import `assignObjectType` from
  ./object-type-table.js (closure-engine.ts already imports it from there). Doc comment: git's
  `parse_object` types a blob through `oid_object_info`, header only, never the body.
- `src/application/primitives/internal/closure-engine.ts` `resolveWant`: after `peeled`, read
  `const { type } = await readDeclaredObjectHeader(ctx, peeled)` (import from ../read-object.js,
  where `readObject` already comes from). When `type === 'blob'`: push
  `{ id: peeled, type: 'blob' }` to `resolving.pending` and return `undefined`, with no content
  read. Otherwise keep today's `readObject(ctx, peeled)` branch unchanged (a commit seeds the walk
  with its body; a tree keeps its read, as git's `parse_object` reads a tree). A blob want pays two
  header probes (one per function); a commit want pays one header probe before the full read it
  already paid; no want pays more inflates than today.
- No other file. Callers of `resolveTagChain` take the change as is:
  internal/bitmap-binding.ts L251, enumerate-bundle-objects.ts L102,
  enumerate-push-objects.ts L48 — git's rev-list behaves the same for `bundle create` and `push`.

Tests in `test/unit/application/primitives/internal/closure-engine.test.ts` (imports already
present: `computeClosure`, `createObjectTypeTable`, `* as readObjectModule`, `buildSeededContext`,
`writeBlob`/`writeTree`/`writeCommit`/`writeTag`, `vi`; add `writeSelfHashedLooseWithDeclaredSize`
from ../fixtures.js, the Part 4 helper). The liar is `writeSelfHashedLooseWithDeclaredSize(ctx,
'blob', 5, Uint8Array.from({ length: 200 }, (_, i) => i))`, written right after the context is
built. `sut = computeClosure`, walk tier, `objects: true`.
- `Given a blob want whose loose body overruns its size claim past the header window` >
  `When computeClosure walks it with object typing` > `Then the blob is listed as a pending blob
  and its body is never inflated`: `wants: [liarId]`, `objectTypes: createObjectTypeTable()`;
  assert `result.objects` contains `{ id: liarId, type: 'blob', nameHash: 0 }`.
- `Given a tag whose target is such a blob` > `When computeClosure walks the tag want` > `Then
  the tag and the blob are listed`: `writeTag(ctx, liarId, 'blob', 'liar')`, `wants: [tagId]`,
  typing on; assert both ids present with their types.
- `Given an honest blob want` > `When computeClosure walks it` > `Then neither readObject nor
  readRawObject is called with its id` (`vi.spyOn(readObjectModule, 'readObject')` and
  `'readRawObject'`, pass-through; `afterEach(vi.restoreAllMocks)` already exists in the file).
  Kills a mutant that keeps reading the body on the blob branch.
- `Given a blob want naming an id no store holds` > `Then OBJECT_NOT_FOUND names that id`
  (try/catch on `.data`): a GUARD if a row already pins it, else a new row written and run.
- Interop: the row Part 6 wrote in `test/integration/alternates-gc-fsck-interop.test.ts`
  (`'Given a borrower reaching a size-lying loose blob that only the donor holds'`), red today,
  turns green. That file carries only that row as an uncommitted edit; stage the whole file here.

### TDD steps

1. RED (`resolveWant` blob want): fails because `readObject(ctx, peeled)` inflates the liar and
   refuses `LOOSE_OBJECT_CORRUPT` — wait: it fails earlier, in `resolveTagChain`'s
   `parseTypedObject`, with the same code. Record the observed code.
2. RED (tag → liar blob): fails the same way through `resolveTagChain`'s final hop.
3. GREEN: the `resolveTagChain` header probe first (step 2 goes green; step 1 still red at
   `resolveWant`'s `readObject`), then the `resolveWant` branch (step 1 green).
4. RED (spy, honest blob): write and run before step 3 when possible; after step 3 it passes —
   then record it as a GUARD whose kill power is the mutant that drops the blob branch.
5. GUARD: the missing-id row; every existing row of closure-engine.test.ts,
   closure-engine-sparse.test.ts and bitmap-binding.closure.test.ts; the enumerate-push /
   enumerate-bundle suites (`ls test/unit/application/primitives | command grep enumerate`).
6. GUARD (interop): the alternates row is green with git 2.55 on PATH.
7. REFACTOR: doc comments on both functions naming git's `parse_object` / `oid_object_info` split.

### Gate

```
npx vitest run test/unit/application/primitives/internal/closure-engine.test.ts test/unit/application/primitives/internal/closure-engine-sparse.test.ts test/unit/application/primitives/internal/bitmap-binding.closure.test.ts test/unit/application/primitives/enumerate-push-objects.test.ts test/unit/application/primitives/enumerate-bundle-objects.test.ts && PATH="<git-2.55-bin>:$PATH" npx vitest run test/integration/alternates-gc-fsck-interop.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/primitives/internal/object-emit.ts src/application/primitives/internal/closure-engine.ts test/unit/application/primitives/internal/closure-engine.test.ts test/integration/alternates-gc-fsck-interop.test.ts && npm run check:spelling
```
Notes. (a) wireit caches `check:types`/`check:spelling`; bare oracles `npx tsc --noEmit -p
tsconfig.json`, `npx cspell --no-progress <files>`. (b) The interop file spawns real git: pinned
git 2.55 first on PATH; a skip is not green. (c) Literal file lists (zsh). (d) Stage ONLY the four
files above, whole; Part 6's other four modified files stay unstaged and uncommitted.

### Commit

`fix(closure): type a blob want from its header alone, as git's parse_object does`

## Part 6 — gc verifies only the packs this run wrote

### Context

ADR-1027 consequence: `verifyPacked` verifies only objects in a pack this run wrote. That is
normal ∪ promisor ∪ survivors, the survivors ONLY when a fresh cruft pack was written (Part 5's
`StagedCruft` `kind === 'fresh'`). A reused or no-op cruft pack, a deleted one, and
`gc.cruftPacks=false` (survivors loosened, never packed) are excluded. git never reads an
unpacked survivor.

Current code in `src/application/commands/internal/gc-pipeline.ts`: `verifyPacked(ctx, plan)`
(L1228-1238) calls `refreshPackRegistry(ctx)`, then
`boundedMapFor(ctx, 'ioBound', [...toNormalPack ids, ...plan.toPromisorPack, ...plan.survivors], (id) => readObject(ctx, id, { verifyHash: true }))`.

Change: `verifyPacked(ctx, targets: ReadonlyArray<ObjectId>)` and a pure
`verifyTargetsOf(plan, staged)`, which returns
`[...plan.toNormalPack.map((o) => o.id), ...plan.toPromisorPack, ...(staged.cruft.kind === 'fresh' ? plan.survivors : [])]`.
`writeRepack` calls `verifyPacked(ctx, verifyTargetsOf(plan, staged))`. No boolean parameter.

Tests:
- `test/unit/application/commands/maintenance-task-failure.test.ts`, in the
  `'gc over a size-lying loose blob'` block from Part 5: an unreachable unexpired OVERRUN liar
  with `gc.cruftPacks=false` (append `\n[gc]\n\tcruftPacks = false\n` to `${gitDir}/config`)
  → `tasksFailed` is `[]`, `tasksRun` contains `'gc'`, the liar file still exists with unchanged
  bytes, and exactly one `.pack` is registered. Add a `readObject` spy
  (`import * as readObjectModule from` the read-object module;
  `vi.spyOn(readObjectModule, 'readObject')`): no call's second argument is the liar id. The
  file already has `afterEach(vi.restoreAllMocks)` (L38-40). Then an unreachable EXPIRED liar
  (`gc.pruneExpire = now`) → `tasksFailed` is `[]` and the liar file is gone (pruned without
  being read; also assert no `readObject` call with its id).
- `test/unit/application/commands/maintenance.test.ts`:
  - next to `'… noop shortcut …'` at L2605-2633: `Given an unchanged cruft survivor set, When the
    next gc runs, Then no survivor is re-read for verification`. Arrange as L2615-2621 (empty
    repo, one loose blob, `pruneExpire = never`, first gc). Then spy `readObject` through a
    namespace import of the read-object module and run the second gc. Assert no call matches
    `(ctx, blobId, { verifyHash: true })`.
  - next to the crash-state block at L2636-2677: the same assertion on its third gc, the run
    whose rebuild reproduces an existing cruft sha (`kept`). Add a precondition assertion
    `expect(third.cruftPackId).toBe(second.cruftPackId)`. If that precondition fails, the case is
    not a sha reuse. Escalate instead of rewriting the arrange.
  - Guard, no edit: `'Given a loose object whose content does not hash to its own filename'`
    (L3606-3637). The fake-id blob lands in a FRESH cruft pack, so it is still verified and still
    refuses `OBJECT_HASH_MISMATCH`.
- Interop, extending Part 5's `describe` in `test/integration/maintenance-interop.test.ts`:
  - `gc.cruftPacks=false`, unreachable unexpired OVERRUN liar. Set `git config gc.cruftPacks
    false` in the base BEFORE `makeTwin`, so both twins carry it. Peer `maintenance run
    --task=gc` exits 0 with empty stderr. Ours: `tasksFailed` is `[]`. Both: the liar is still
    loose, exactly one registered pack, `git count-objects` equal.
  - `gc.pruneExpire=now`, unreachable liar: both exit 0 / ok, and the liar file is absent on
    both. (Already true before this part; a GUARD that pins it.)
- Interop, alternates, in `test/integration/alternates-gc-fsck-interop.test.ts`, inside
  `describe.skipIf(!GIT_AVAILABLE)('alternates gc interop — local-only packing')` (L176-472),
  after the `'Given a borrower holding a loose copy of a reachable object the donor holds loose'`
  block (L340-373, the model). Use `pairOf(slug, prepare)` (L104). `prepare` forges the OVERRUN
  liar in the DONOR with `forgeOwnHash(donor, 5, body)` (import from interop-helpers, plain path),
  then makes it reachable in the borrower (`update-index --add --cacheinfo` + a commit with
  pinned dates). Act: `runGit(['-C', pair.gitSide, 'gc', '-q'])` must not throw (exit 0), and
  on the tsgit side `(await openRepository({ cwd: pair.tsgitSide })).maintenance({ tasks: ['gc'] })`
  returns `tasksFailed` `[]` (the file's `tsgitGc` L118 discards the result, so call it
  directly). Assert the donor's liar file bytes are unchanged. Expected to pass already: a
  reachable object that only an alternate holds is never owned, so `toNormalPackInputs`
  (gc-pipeline.ts L448) never packs it. A red here is a defect: escalate with the failing
  output.

### TDD steps

1. RED (`gc.cruftPacks=false`, unit): fails with `tasksFailed[0].code === 'LOOSE_OBJECT_CORRUPT'`.
   `verifyPacked` reads every survivor, including the never-packed liar.
2. RED (noop cruft, maintenance.test.ts): fails because `readObject` was called with
   `(ctx, blobId, { verifyHash: true })`.
3. RED (sha-reused cruft, maintenance.test.ts): fails the same way on the third run.
4. GREEN: `verifyTargetsOf` + the `verifyPacked(ctx, targets)` signature.
5. GUARD: the hash-mismatch row L3606 stays green (fresh cruft is still verified). Its kill
   power: a mutant that drops the survivors for every kind turns it green-to-red.
6. GUARD: the expired-liar unit row, the `pruneExpire=now` interop row and the alternates row.
   All pass because no build reads the liar.
7. RED-by-order (interop `gc.cruftPacks=false`): write it before step 4 to see it red (ours
   fails `LOOSE_OBJECT_CORRUPT` from the verify). Otherwise record it as a guard.
8. REFACTOR: a doc comment on `verifyTargetsOf` stating why survivors join only for a fresh
   cruft pack (git never reads what it did not pack).

### Gate

```
npx vitest run test/unit/application/commands/maintenance-task-failure.test.ts test/unit/application/commands/maintenance.test.ts && PATH="<git-2.55-bin>:$PATH" npx vitest run test/integration/maintenance-interop.test.ts test/integration/alternates-gc-fsck-interop.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/commands/internal/gc-pipeline.ts test/unit/application/commands/maintenance-task-failure.test.ts test/unit/application/commands/maintenance.test.ts test/integration/maintenance-interop.test.ts test/integration/alternates-gc-fsck-interop.test.ts && npm run check:spelling
```
Notes. (a) wireit caches `check:types`/`check:spelling`. Bare oracles:
`npx tsc --noEmit -p tsconfig.json`, `npx cspell --no-progress <files>`. (b) Interop tests need
the pinned git 2.55 first on PATH (`<git-2.55-bin>`). A skip is not green. (c) Literal file lists
(zsh).

### Commit

`fix(gc): verify only the packs this run wrote`

Why separate from Parts 5 and 7: see Part 5. This part's single behaviour is the verify target
set.

## Part 7 — gc packs an in-window truncation and verifies it against the loose copy

### Context

ADR-1031. After Part 4, a reachable (or crufted) blob claiming 5 with a 10-byte body (inside the
32-byte window) is packed as its 5-byte truncation, as git does. `verifyPacked`'s
`readObject(ctx, id, { verifyHash: true })` then refuses `OBJECT_HASH_MISMATCH`, where git exits
0. Accept that mismatch only when BOTH hold: the id's still-present loose copy, read through the
buffered tier, has the `'truncate'` verdict, AND its truncated bytes equal the packed entry's
bytes. Every other mismatch, and every other fault, propagates unchanged. Honest objects pay
nothing extra, because the extra reads happen only inside the catch.

New internal module `src/application/primitives/internal/loose-truncation.ts` (DC3-A,
kebab-case, internal: no barrel entry). Single quotes in the sketch's doc comment stand for backticks in the real one:

    /** Whether the primary's loose copy of 'id' is a window truncation (git's buffered
     *  'unpack_loose_rest') whose claimed prefix is exactly 'packed'. */
    export async function isLooseTruncationOf(ctx: Context, id: ObjectId, packed: Uint8Array): Promise<boolean> {
      const compressed = await looseCompressedBytes(ctx, id);       // object-resolver.ts L651; undefined on a miss
      if (compressed === undefined) return false;
      const { split } = await inflateLooseBuffered(ctx, id, compressed); // object-resolver.ts L274
      if (classifyLooseBody(split) !== 'truncate') return false;    // domain/objects/git-object.ts L58
      return bytesEqual(split.content.subarray(0, split.declaredSize), packed); // domain/objects/encoding.ts L56
    }
Imports: `looseCompressedBytes` and `inflateLooseBuffered` from the object-resolver module (one
level up), `classifyLooseBody` from the domain git-object module, `bytesEqual` from the domain
encoding module, and the `Context` and `ObjectId` types. A buffered refusal (a past-window
overrun, `LOOSE_OBJECT_CORRUPT`) propagates: no swallow. It cannot arise in gc's verify, because
Part 4 refuses that object at build time.

Edit in `src/application/commands/internal/gc-pipeline.ts`: `verifyPacked` (Part 6 shape) maps
each target through a new private `verifyPackedObject(ctx, id)`:

    async function verifyPackedObject(ctx: Context, id: ObjectId): Promise<void> {
      try {
        await readObject(ctx, id, { verifyHash: true });
      } catch (error) {
        if (errorDataCode(error) !== 'OBJECT_HASH_MISMATCH') throw error;
        const packed = (await readRawObject(ctx, id)).content; // the buffered resolver answers from the pack first
        if (!(await isLooseTruncationOf(ctx, id, packed))) throw error;
      }
    }
`readRawObject` comes from the read-object module (already imported for `readObject`).
`errorDataCode` is already imported (L10). Add a doc comment stating git's behaviour: git's
pack-objects never re-hashes, so a truncation it packed exits 0, and `git fsck` flags the entry
later. `pruneLooseAfterRepack` (L1323) then unlinks the loose copy, because `packedAnywhere`
finds it packed. That is git's prune.

Tests:
- `test/unit/application/primitives/internal/loose-truncation.test.ts` (new; memory adapter,
  `buildSeededContext` + `writeSelfHashedLooseWithDeclaredSize` from ../fixtures.js, plain
  path). sut = `isLooseTruncationOf`. One `describe('Given …')` per condition, each isolated:
  - no loose copy (an id never written) → `false`;
  - honest loose blob (claim === body length) → `false`;
  - under-run (claim 200, body 5) → `false`;
  - in-window truncation (claim 5, body 10), `packed` = a different 5 bytes → `false`;
  - in-window truncation, `packed` = the first 5 body bytes → `true`;
  - in-window truncation, `packed` = all 10 body bytes → `false` (kills a mutant that drops the
    `subarray`).
- `test/unit/application/commands/maintenance-task-failure.test.ts`, Part 5's block, with
  IN_WINDOW (claim 5, body 10):
  - reachable → `tasksFailed` `[]`. The liar's loose file is gone (pruned).
    `readRawObject(ctx, liarId)` returns 5 bytes equal to the first 5 body bytes (served from the
    pack).
  - unreachable, cruft on → `tasksFailed` `[]`. `result` carries a `cruftPackId`. The loose file
    is gone. `readRawObject` returns the 5 bytes.
  - guard against a mutant that inverts or drops the code check: reachable IN_WINDOW, with
    `vi.spyOn(readObjectModule, 'readObject')` rejecting ONCE, only for
    `(liarId, { verifyHash: true })`, with `permissionDenied(path)` (src/domain/error.ts; pass
    the other calls through to the original) → `tasksFailed[0].code === 'PERMISSION_DENIED'`.
    The truncation would match, so only the code check makes the task fail.
- Guard, no edit: test/unit/application/commands/maintenance.test.ts L3606-3637. A fake-id
  honest-verdict loose blob still refuses `OBJECT_HASH_MISMATCH`: the verdict condition is
  `'honest'`, not `'truncate'`.
- Interop, extending Part 5's `describe` in `test/integration/maintenance-interop.test.ts`:
  `it.each` over `reachable: true | false`, IN_WINDOW liar (`forgeOwnHash(dir, 5, <10 bytes>)`).
  Peer `maintenance run --task=gc` exits 0. Ours: `tasksFailed` `[]`. Both twins:
  `git cat-file -s <oid>` prints `5`, the loose file is absent, and a real `git fsck` exits 4 on
  each (`tryRunGitWithExit(['-C', dir, 'fsck'])`, `exitCode === 4`; the entry is reported
  corrupt).

### TDD steps

1. RED (`isLooseTruncationOf`, all six rows, one function): fails because the module does not
   exist (import resolution error). Write the rows, run them red, then GREEN the module. All six
   pass.
2. RED (reachable in-window, unit): fails with
   `tasksFailed[0].code === 'OBJECT_HASH_MISMATCH'` from `verifyPacked`.
3. RED (unreachable in-window, cruft on, unit): fails the same way, through the fresh cruft
   pack's survivor verify.
4. GREEN: `verifyPackedObject` in gc-pipeline.ts.
5. GUARD: the injected `PERMISSION_DENIED` row passes (the fault propagates). Its value is the
   mutant kill on `!== 'OBJECT_HASH_MISMATCH'`.
6. GUARD: maintenance.test.ts L3606 (`OBJECT_HASH_MISMATCH` still refused on an honest-verdict
   loose copy).
7. Interop `it.each`: write it before step 4 to see ours fail `OBJECT_HASH_MISMATCH`, then green
   after. Otherwise record it as a guard.
8. REFACTOR: none expected beyond doc comments.

### Gate

```
npx vitest run test/unit/application/primitives/internal/loose-truncation.test.ts test/unit/application/commands/maintenance-task-failure.test.ts test/unit/application/commands/maintenance.test.ts && PATH="<git-2.55-bin>:$PATH" npx vitest run test/integration/maintenance-interop.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/primitives/internal/loose-truncation.ts src/application/commands/internal/gc-pipeline.ts test/unit/application/primitives/internal/loose-truncation.test.ts test/unit/application/commands/maintenance-task-failure.test.ts test/integration/maintenance-interop.test.ts && npm run check:spelling
```
Notes. (a) wireit caches `check:types`/`check:spelling`. Bare oracles:
`npx tsc --noEmit -p tsconfig.json`, `npx cspell --no-progress <files>`. (b) Interop tests need
the pinned git 2.55 first on PATH (`<git-2.55-bin>`). A skip is not green. (c) Literal file lists
(zsh). The new module is internal: knip (check:dead-code, part of the session's `npm run validate`)
sees it used by gc-pipeline.ts, so no barrel entry.

### Commit

`fix(gc): pack an in-window loose truncation and verify it against the loose copy, as git does`

Why separate from Parts 5 and 6: see Part 5. This part owns the new module and the acceptance
guard.

Phase gate (session-run after Part 7, not per part): `npm run validate`. `reports/api.json`
(prepush `check:doc-typedoc`) changed only in Part 1. Re-run `npm run docs:json` before the push
to confirm no later part moved it. Perf acceptance (ADR-1028): `npm run bench:ab` on the gc rows
of test/bench/maintenance.bench.ts, within noise, run after the last commit.
