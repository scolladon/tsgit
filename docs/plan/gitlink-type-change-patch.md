# Plan — gitlink/submodule PATCH rendering (all diff kinds) + rename-detection exclusion

> Source: design doc `docs/design/gitlink-type-change-patch.md` · ADRs `403, 404, 405`
> The plan is the implementation script AND the knowledge handoff. Slice agents start
> with zero context: whatever a slice block omits is paid later as agent rediscovery.
> `plan-lint.sh` enforces the schema below — the plan phase cannot close without it.

## Sizing rules

- Every slice costs a full agent lifecycle (spin-up, zero-context rebuild, gate) — it
  must earn it. No standalone test-only slices for FEATURE code: coverage/interop/property
  tests fold into the implementation slice whose code they exercise. EXCEPTION:
  test-infra-only and docs-only slices (tooling config, test helpers, fixtures,
  mutation/ADV/property suites, docs/prose) with no `src/` delta ARE standalone — they
  have no implementation slice to fold into.
- A slice that would be a pure test pass over already-landed code merges into its
  neighbour.

## Plan-level orientation (read once, applies to every slice)

This feature has **zero new public surface** (confirmed per symbol): no new Tier-1
command, no new exported error code / discriminated-union member, no new `Repository`
facade method, no new package-entry re-export. The only new symbols are *internal*
helpers inside two existing application primitives (a `SUBPROJECT_LINE_PREFIX`-style
constant in `materialise-patch-files.ts`, and an `isGitlinkChange`/`isGitlinkMode`
predicate in `detect-similarity-renames.ts`). Neither is consumed by a sibling module,
so **neither is barrelled** and **no surface gate fires** (`src/application/commands/index.ts`,
`src/repository.ts`, `docs/use/commands/`, `reports/api.json`, browser scenarios — all
untouched). If during implementation a sibling module turns out to need the predicate,
barrel it from `src/application/primitives/` only; do not widen the domain.

Pivotal invariant the whole feature rests on (design §"Why one synthesis mechanism",
ADR-403 Decision): the domain serializer is **UNCHANGED**. `renderAddBlock` /
`renderDeleteBlock` / `renderModifyBlock` (via `renderSameKindBlock`/`modePreamble`) /
`renderTypeChangeBlock` already derive the block header `mode` from `change.*Mode`
(already `160000`), the `index` abbrev from `shortOid(change.*Id)` (already the gitlink
oid), and the body from `splitContentLines(content)`. So feeding the gitlink side the
synthesized bytes `Subproject commit <oid>\n` renders byte-perfectly with **no
`patch-serializer.ts` edit**. That is why the domain-serializer pins (Slice 1) are a
production-free addition folded into the synthesis slice, not a standalone slice.

Faithfulness pin bytes are already empirically captured in the design's §"Faithfulness
baseline" matrix (A1 / DEL1 / D1–D4 / M / R1 / R2 / R3 / B). **Copy those bytes; do not
re-derive them.** Where a slice reproduces a golden it cites the exact matrix row.

## Slice 1 — synthesize the gitlink Subproject-commit line in `materialiseOne`

### Context

**Production file:** `src/application/primitives/materialise-patch-files.ts`.
Symbol name-path: `materialiseOne` (`:20`). Current body (verbatim — the four arms you
must touch):

```ts
export async function materialiseOne(ctx: Context, change: DiffChange): Promise<PatchFile> {
  if (change.type === 'add') {
    const blob = await readBlob(ctx, change.newId);
    return { change, newContent: blob.content };
  }
  if (change.type === 'delete') {
    const blob = await readBlob(ctx, change.oldId);
    return { change, oldContent: blob.content };
  }
  if (change.type === 'rename' || change.type === 'copy') {
    if (change.similarity.score === MAX_SCORE) return { change };
    const [oldBlob, newBlob] = await Promise.all([
      readBlob(ctx, change.oldId),
      readBlob(ctx, change.newId),
    ]);
    return { change, oldContent: oldBlob.content, newContent: newBlob.content };
  }
  // modify or type-change — load both sides; short-circuit when ids match
  // (mode-only modify) to save one readBlob round-trip.
  if (change.oldId === change.newId) {
    const blob = await readBlob(ctx, change.oldId);
    return { change, oldContent: blob.content, newContent: blob.content };
  }
  const [oldBlob, newBlob] = await Promise.all([
    readBlob(ctx, change.oldId),
    readBlob(ctx, change.newId),
  ]);
  return { change, oldContent: oldBlob.content, newContent: newBlob.content };
}
```

**What to add (ADR-403, per-side, change-kind-agnostic — design §"The fix", Arm table):**
a module-level constant for the submodule line and a per-side helper that returns the
gitlink side's synthesized content WITHOUT a `readBlob`. Concretely:

- Constant (single named template; the ONLY submodule-specific knowledge in the
  primitive): build `Subproject commit <oid>\n` as UTF-8 bytes. Suggested shape — a
  `SUBPROJECT_PREFIX = 'Subproject commit '` string constant + a small
  `synthesizeGitlink(oid: ObjectId): Uint8Array` returning
  `new TextEncoder().encode(`${SUBPROJECT_PREFIX}${oid}\n`)`. (Keep the encoder hoisted
  to module scope, mirroring the existing module style.)
- A per-side mode check `kindOf(mode) === 'gitlink'` — `kindOf` is already exported from
  `'../../domain/diff/index.js'` (the module this file already imports from for
  `DiffChange`/`PatchFile`; add `kindOf` and the `FileMode`/`ObjectId` types as needed
  from `'../../domain/objects/index.js'`). `kindOf` lives in
  `src/domain/diff/mode-kind.ts:6`; `FILE_MODE.GITLINK = '160000'`
  (`src/domain/objects/file-mode.ts:8`).
- **`add` arm:** if `kindOf(change.newMode) === 'gitlink'`, return
  `{ change, newContent: synthesizeGitlink(change.newId) }` instead of `readBlob`.
- **`delete` arm:** if `kindOf(change.oldMode) === 'gitlink'`, return
  `{ change, oldContent: synthesizeGitlink(change.oldId) }` instead of `readBlob`.
- **`modify` / `type-change` arm (the final fall-through):** resolve EACH side
  independently — gitlink side → `synthesizeGitlink(<that side's id>)`; non-gitlink side
  → real `readBlob`. A `TypeChangeChange` has at most one gitlink side (two gitlink sides
  would be a `modify`); a gitlink↔gitlink `modify` has the gitlink on BOTH sides and the
  two oids ALWAYS differ (a pointer bump — same-oid gitlink is no change), and a
  gitlink-vs-blob type-change always has different kinds hence different oids — so a
  gitlink side never satisfies `oldId === newId`. The existing same-id short-circuit
  therefore only ever fires for a NON-gitlink mode-only modify; gate it so it is taken
  only when neither side is gitlink (e.g. `change.oldId === change.newId && !isGitlinkMode(change.oldMode)`),
  keeping the existing `oldId equals newId (mode-only)` test at
  `materialise-patch-files.test.ts:126` green. Then compute each side via a small
  `resolveSide(mode, id)` returning `synthesizeGitlink(id)` for a gitlink mode and
  `(await readBlob(ctx, id)).content` otherwise, run in `Promise.all`.
- **`rename` / `copy` arm:** UNCHANGED. The exact same-oid gitlink rename (R1) hits
  `score === MAX_SCORE` ⇒ `return { change }` (no read, no synthesis); an *inexact*
  gitlink rename never reaches here because Slice 2's detection excludes gitlinks from
  the inexact matrix. Do not add a gitlink branch to this arm.

Object-Calisthenics / house-style guardrails: small functions (<20 lines), early
returns, no boolean params, immutable. Run `mcp__serena__get_diagnostics_for_file` after
the edit; ground truth is `npm run check:types`.

**Tests — pin in three existing files (the serializer + patch-id pins are
production-free under ADR-403, so they FOLD here rather than standing alone):**

1. `test/unit/application/primitives/materialise-patch-files.test.ts` — the synthesis is
   the new code. The file already has `writeBlob(ctx, content)` (writes a blob via
   `writeObject`), `createMemoryContext`, `FILE_MODE`, `MAX_SCORE`, `utf8 = new
   TextEncoder()`, and a `describe('materialiseOne')` block with a `Given a type-change
   change` case at `:180`. Add, per GWT/AAA/`sut`, one isolated guard test PER ARM and
   PER SIDE (separate `kindOf(...) === 'gitlink'` Conditional mutation targets — one test
   per branch):
   - `Given an add whose new side is a gitlink` → `materialiseOne` returns
     `newContent === utf8.encode('Subproject commit ' + gitlinkOid + '\n')`,
     `oldContent` undefined.
   - `Given a delete whose old side is a gitlink` → `oldContent` is the synthesized line,
     `newContent` undefined.
   - `Given a gitlink↔gitlink modify (both sides gitlink, different oids)` → BOTH
     `oldContent`/`newContent` are the synthesized lines for `oldId`/`newId` respectively
     (a pointer bump; oids differ so the same-id short-circuit is not taken).
   - `Given a type-change with the gitlink as the NEW side` (e.g. regular→gitlink) →
     `newContent` synthesized for `newId`, `oldContent` is the REAL blob bytes.
   - `Given a type-change with the gitlink as the OLD side` (e.g. gitlink→regular) →
     `oldContent` synthesized for `oldId`, `newContent` is the REAL blob bytes.
   - `Given an exact same-oid gitlink rename (score === MAX_SCORE)` → `{ change }` with
     BOTH content fields undefined (R1's `materialiseOne` half; no synthesis, no read).
   - **The mutation-strong "no readBlob on the gitlink oid" assertion:** for each gitlink
     side, seed the gitlink oid as a REAL COMMIT object (not a blob) so that if a mutant
     drops the gitlink branch and falls through to `readBlob`, the call throws
     `unexpectedObjectType('blob','commit')` and the test fails. Use the `read-blob.test.ts:47`
     pattern verbatim: build a `Tree` then a `Commit` via `writeObject(ctx, {type:'commit', id:'' as ObjectId, data:{tree, parents:[], author:{name:'a',email:'a@a',timestamp:0,timezoneOffset:'+0000'}, committer:{…}, message:'m', extraHeaders:[]}})`,
     and use that returned id as the gitlink `oldId`/`newId`. Assert the synthesized bytes
     by content equality (`expect(sut.newContent).toEqual(utf8.encode('Subproject commit ' + commitId + '\n'))`).
     This both proves the synthesized line AND that the commit was never read as a blob.

2. `test/unit/domain/diff/patch-serializer.test.ts` — the byte-faithful render pins
   (production-free: ADR-403 keeps the serializer unchanged; these prove the synthesized
   content renders the exact golden bytes through the existing block path). The file has
   `OID_A='a'*40`, `OID_B='b'*40`, `OID_C='c'*40`, `utf8`, and helpers `addFile`,
   `deleteFile`, `modifyFile`, `typeChangeFile` (all constructing `PatchFile`), with the
   file↔symlink and binary type-change patch blocks at `:639–757`. **Use the design's
   pinned gitlink oids** `GL1 = '1'.repeat(40)` (→ `shortOid` `1111111`) and
   `GL2 = '2'.repeat(40)` (→ `2222222`) so the `index` lines match the goldens. Add one
   `it` per kind, each asserting the FULL byte string (not a substring) of
   `renderPatch([file])` against the matrix golden:
   - `Given an add of a gitlink` → construct a `PatchFile` `{ change: { type:'add', newPath:'sub', newId: GL1, newMode: FILE_MODE.GITLINK }, newContent: utf8.encode('Subproject commit ' + GL1 + '\n') }`; assert exactly the **A1** block (design §A1):
     `diff --git a/sub b/sub` / `new file mode 160000` / `index 0000000..1111111` /
     `--- /dev/null` / `+++ b/sub` / `@@ -0,0 +1 @@` /
     `+Subproject commit 1111111111111111111111111111111111111111` then trailing `''`.
     **No `\ No newline` marker** (synthesized content ends in `\n`).
   - `Given a delete of a gitlink` → assert the **DEL1** block (design §DEL1):
     `deleted file mode 160000` / `index 1111111..0000000` / `--- a/sub` / `+++ /dev/null`
     / `@@ -1 +0,0 @@` / `-Subproject commit …1`. No no-newline marker.
   - `Given a gitlink→gitlink modify (pointer bump)` → `{ type:'modify', path:'sm',
     oldId:GL1, newId:GL2, oldMode:GITLINK, newMode:GITLINK }` with both contents the
     synthesized lines; assert the **M** block (design §M):
     `diff --git a/sm b/sm` / `index 1111111..2222222 160000` / `--- a/sm` / `+++ b/sm` /
     `@@ -1 +1 @@` / `-Subproject commit …1` / `+Subproject commit …2`.
     (This is `modePreamble`'s equal-modes form — `index <a>..<b> 160000`.)
   - The four type-change directions, each a two-block delete+add form (design §D1–D4).
     **Unit-serializer abbrev caveat:** the serializer derives every `index` abbrev from
     the oid you put on the `PatchFile.change` via `shortOid` (first 7 chars) — it does
     NOT hash content. So in THIS unit test use clean oids and assert the index from them
     (the real-git content hashes `00cb5bc`/`1de5659` in §D1–D4 belong to the INTEROP
     arms in Slice 3, not here). Use the gitlink side at `GL1` (`shortOid` `1111111`) and
     the blob/symlink side at a distinct oid (e.g. `OID_C` → `ccccccc`). Construct each
     via a `PatchFile` with `type:'type-change'` and assert the full two-block bytes:
     `Given a type change from regular to gitlink` (path `fg`, `oldMode 100644` /
     `newMode 160000`, `oldContent 'regular content\n'` / `newContent` the synthesized
     `Subproject commit GL1\n`): block 1 = `deleted file mode 100644` + `-regular content`
     (no marker, trailing `\n`); block 2 = `new file mode 160000` + `+Subproject commit …1`
     (no marker).
     `Given a type change from gitlink to regular` (path `gf`, modes reversed).
     `Given a type change from symlink to gitlink` (path `sg`, `oldMode 120000` →
     `newMode 160000`, `oldContent 'target'` WITHOUT trailing `\n`): the symlink delete
     block carries `\ No newline at end of file`; the gitlink add block does NOT.
     `Given a type change from gitlink to symlink` (path `gs`, `160000` → `120000`): the
     gitlink delete block has no marker; the symlink add block (`+target`, no trailing
     `\n`) has `\ No newline at end of file`.
     The line SHAPE (mode headers, hunk headers `@@ -1 +0,0 @@` / `@@ -0,0 +1 @@`, the
     `Subproject commit` body, marker presence/absence) is copied from §D1–§D4; only the
     `index` oid abbrevs reflect your chosen unit oids.

3. `test/unit/application/primitives/patch-id.test.ts` — the blast-radius pin for the one
   consumer-specific invariant (`computePatchId` composes `diffTrees → materialisePatchFiles
   → renderPatch`; the `Subproject commit` line survives `canonicalise`, which drops only
   `@@ ` and `index ` lines then strips whitespace — design §"Blast radius"). The file has
   `buildSeededContext`, `AUTHOR`, `writeObject`, `writeTree`, `createCommit`, and helpers
   `commitFile`/`commitNestedFile`. Add a `commitGitlink(ctx, gitlinkOid, parents)` local
   helper (mirror `commitFile`: `writeTree(ctx, [{ mode: FILE_MODE.GITLINK, name:'sub',
   id: gitlinkOid }])` then `createCommit`; the gitlink oid need not exist as an object —
   `writeTree` does not validate, and `materialiseOne` synthesizes without reading it).
   Add two cases:
   - `Given two commits introducing the SAME submodule pointer` (same path, same gitlink
     oid, parent = the same empty/base commit) → `computePatchId` of both is EQUAL
     (proves the `Subproject commit` line is in the equivalence key and is stable).
   - `Given two commits introducing the same submodule path at DIFFERENT gitlink oids` →
     patch-ids DIFFER (proves the oid-bearing line survives canonicalisation and
     distinguishes). Exercise on a gitlink **add** (introduce submodule: base tree empty
     → tree with the gitlink) — the common case. rebase/range-diff are covered
     transitively (Slice 3 interop + their existing suites); no extra consumer pin needed.

### TDD steps

- RED — add the materialise gitlink guard tests (item 1). Run them; they FAIL today: the
  `add`/`delete`/`modify`/`type-change` arms call `readBlob` on the gitlink commit oid,
  which throws `unexpectedObjectType('blob','commit')` — the failure message is the
  thrown TsgitError, not an assertion mismatch.
- RED — add the serializer gitlink-render pins (item 2). They FAIL because no `PatchFile`
  with synthesized gitlink content is produced yet by the pipeline these tests model;
  the serializer renders the synthesized bytes correctly already, so these turn GREEN as
  soon as the constructed `PatchFile` inputs are present (they pin the byte goldens that
  Slice 3 will exercise end-to-end). (If a serializer pin is already green on construction
  — because the serializer is unchanged — that is expected; it documents the golden.)
- RED — add the patch-id gitlink pins (item 3). They FAIL today: `computePatchId` →
  `materialisePatchFiles` throws on the gitlink commit oid.
- GREEN — implement the `materialiseOne` synthesis (constant + `synthesizeGitlink` +
  per-arm/per-side `kindOf(...) === 'gitlink'` branches) as specified in Context. Re-run
  all three test files; all pass.
- REFACTOR — extract the per-side resolution to a single small `resolveSide(mode, id)`
  used by the modify/type-change arm so the gitlink check lives in one place; keep the
  add/delete arms as explicit early returns for readability. Verify no `any`, no boolean
  params, functions <20 lines.

### Gate

`npx vitest run test/unit/application/primitives/materialise-patch-files.test.ts test/unit/domain/diff/patch-serializer.test.ts test/unit/application/primitives/patch-id.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/primitives/materialise-patch-files.ts test/unit/application/primitives/materialise-patch-files.test.ts test/unit/domain/diff/patch-serializer.test.ts test/unit/application/primitives/patch-id.test.ts`

### Commit

`feat(diff): synthesize gitlink Subproject-commit line for all patch kinds`

## Slice 2 — exclude gitlinks from the inexact rename/copy/break matrix

### Context

**Production file:** `src/application/primitives/detect-similarity-renames.ts`. This is
ADR-405 / design §"Rename detection over gitlinks", D6 option (a): a single shared
gitlink predicate applied at the THREE pool builders that feed the two `readBlob`
hydration sites. The byte-free domain exact same-oid fold (`detectRenames`/`tryFoldAdd`
in `src/domain/diff/rename-detect.ts`) stays UNTOUCHED — it never reads bytes and already
folds same-oid gitlinks to `R100` (R1).

Imports already present in this file: `kindOf` is NOT yet imported but
`FileMode`/`FilePath`/`ObjectId` types are (`:23`), `DiffChange`/`AddChange`/`DeleteChange`/
`ModifyChange` etc. (`:2–10`), and the file imports from `'../../domain/diff/...'`. Add
`import { kindOf } from '../../domain/diff/mode-kind.js'` (or extend the existing
`'../../domain/diff/index.js'` style import — match whichever import grouping the file
uses; `kindOf` is exported from both `mode-kind.js` and the diff barrel).

**Shared predicate (the only new symbol — INTERNAL, not barrelled):** a small
`isGitlinkMode(mode: FileMode): boolean => kindOf(mode) === 'gitlink'` (and/or a
change-shaped `isGitlinkChange` if cleaner at a call site). Define it once near the top
of the file's helpers; reuse at all three sites below.

**The three edit sites (verbatim current bodies):**

1. `partitionLeftovers` (`:337`) — routes exact-pass leftovers into `adds`/`deletes`/`other`:
   ```ts
   for (const change of changes) {
     if (change.type === 'add') adds.push(change);
     else if (change.type === 'delete') deletes.push(change);
     else other.push(change);
   }
   ```
   Change: a gitlink-mode `add` (`isGitlinkMode(change.newMode)`) or gitlink-mode
   `delete` (`isGitlinkMode(change.oldMode)`) must NOT enter `adds`/`deletes` — route it
   to `other` (which `assemblePostPass` (`:763`) passes through VERBATIM, never hydrated,
   so the gitlink survives as a standalone `AddChange`/`DeleteChange` → R2/R3 behaviour).
   Guard the `add`/`delete` branches with the predicate; on a gitlink, `other.push(change)`.

2. `buildCopySourcesForOn` (`:58`) AND `buildCopySourcesForHarder` (`:81`) — the COPY
   SOURCE pool. `buildCopySourcesForOn` pulls sources from `deletes` and from `other`
   modify/type-change preimages; `buildCopySourcesForHarder` pulls the FULL preimage tree.
   Current bodies:
   ```ts
   // ForOn
   for (const del of deletes) sources.push({ oldPath: del.oldPath, oldId: del.oldId, oldMode: del.oldMode });
   for (const change of other) {
     if (change.type === 'modify' || change.type === 'type-change')
       sources.push({ oldPath: change.path, oldId: change.oldId, oldMode: change.oldMode });
   }
   // ForHarder
   for (const [path, entry] of preimage) sources.push({ oldPath: path, oldId: entry.id, oldMode: entry.mode });
   ```
   Change: skip any source whose `oldMode`/`entry.mode` is a gitlink (`isGitlinkMode`).
   The `deletes`-derived sources in `ForOn` are already gitlink-free once step 1 routes
   gitlink deletes into `other`, but the `other`-derived (modify/type-change preimage) and
   the `preimage`-derived (`ForHarder`, includes unchanged gitlinks) sources are NOT —
   this guard is LOAD-BEARING (design §fix step 2; pin: copy-source test below), not
   redundant. Guard each `sources.push` / the preimage iteration.

3. `attemptBreaks` (`:571`) — the BREAK pool. Current body filters modifies then scores:
   ```ts
   const modifies = diff.changes.filter((c): c is ModifyChange => c.type === 'modify');
   ```
   Change: also exclude gitlink-mode modifies — `.filter((c): c is ModifyChange => c.type === 'modify' && !isGitlinkMode(c.oldMode) && !isGitlinkMode(c.newMode))`
   (a gitlink↔gitlink pointer bump has the gitlink on both sides). This stops
   `scoreModifies` (`:512`, which calls `hydrateIds` → `readBlob` at `:42`) from ever
   reading a gitlink commit oid (B pin: gitlink modify stays a plain `M` even under
   forced `-B`). `scoreModifies` itself needs NO edit once the filter excludes gitlinks.

Do NOT touch the domain `rename-detect.ts` (exact fold) — putting the guard there
mislocates a hydration concern across the hexagonal boundary (ADR-405 option 3,
rejected). Do NOT add a post-exact split (option 2, rejected).

**Tests — `test/unit/application/primitives/detect-similarity-renames.test.ts`.** The
file has `buildSeededContext` (from `./fixtures.js`), `writeBlob(ctx, content)`, the
`tenLines(changed)` ~90%-similar blob helper, `FILE_MODE`, `MAX_SCORE`,
`DEFAULT_RENAME_THRESHOLD`, and exercises `detectSimilarityRenames(ctx, diff, options?)`
directly. Add one ISOLATED guard test per branch (separate Conditional mutation targets),
per GWT/AAA/`sut`:

- **Primary kill test** — `Given a different-oid gitlink add/delete pair` / `When
  detectSimilarityRenames runs at threshold 1` / `Then they stay a separate add and
  delete and the gitlink oid is never read`. Build a `delete` (`oldMode: GITLINK`,
  `oldId: GLX`) + an `add` (`newMode: GITLINK`, `newId: GLY`, different oid). Today this
  THROWS `unexpectedObjectType('blob','commit')`; after the fix it returns one
  `AddChange` + one `DeleteChange`, no `RenameChange`/`CopyChange`, NO throw. Seed `GLX`/`GLY`
  as REAL COMMIT objects (the `read-blob.test.ts:47` commit-write pattern) so a mutant
  that drops the `partitionLeftovers` guard falls into `adds`/`deletes` → `hydrateAndFingerprint`
  → `readBlob` → throws. Run at default threshold AND `renameOptions: { threshold: 1 }`
  (lowest) AND `renameOptions: { copies: 'harder' }` — each must stay `A`+`D`.
- `Given a gitlink delete and a real-blob add (R3)` → only the blob is a candidate; the
  gitlink stays a delete (isolates the `partitionLeftovers` gitlink-delete guard vs the
  gitlink-add guard — one test triggering each side independently).
- `Given a gitlink↔gitlink modify and breakRewrites enabled` /
  `renameOptions: { breakRewrites: { score: 0, merge: 0 } }` → the modify is NOT scored
  for a break (stays one `ModifyChange`, no synthetic delete+add, no `broken` datum, no
  throw) — isolates the `attemptBreaks` modify-filter gitlink guard. Seed the gitlink oids
  as commits to prove `scoreModifies`/`hydrateIds` never read them.
- `Given copies:'on' with a gitlink modify preimage and a similar blob add` → the gitlink
  modify stays `M`, the blob stays a pure `A`, no copy — isolates the
  `buildCopySourcesForOn` `other`-derived-source guard.
- `Given copies:'harder' with an unchanged gitlink preimage entry and a similar blob add`
  → no copy is detected from the gitlink source — isolates the `buildCopySourcesForHarder`
  preimage-source guard. Pass a `preimage` map containing an unchanged GITLINK entry as
  the 4th positional argument: `detectSimilarityRenames(ctx, diff, { copies: 'harder' },
  new Map<FilePath, FlatTreeEntry>([['unchanged_sub' as FilePath, { id: gitlinkOid, mode:
  FILE_MODE.GITLINK }]]))` — model on the existing `When detectSimilarityRenames is called
  with preimage` block at `:662` (which uses a `FILE_MODE.REGULAR` preimage entry and
  asserts the unchanged file IS a copy source; this gitlink variant inverts it — the
  gitlink preimage is NOT a copy source). `FlatTreeEntry` is already imported
  (`./detect-similarity-renames.test.ts:11`).
- **Regression guard** — `Given an exact same-oid gitlink add/delete pair` / `Then it
  still folds to R100 with MAX_SCORE and reads no bytes` (R1 unchanged): a `delete` +
  `add` with the SAME gitlink oid on both → one `RenameChange`, `similarity.score ===
  MAX_SCORE`, both modes `160000`, no throw. Proves the exact fold stayed mode-agnostic.

### TDD steps

- RED — add the six detection guard tests above. The primary kill test + the modify/copy
  tests FAIL today by THROWING `unexpectedObjectType('blob','commit')` (the inexact /
  break / copy-source passes `readBlob` the gitlink commit oid). The R1 regression guard
  already passes (the exact fold is mode-agnostic) — it documents the must-not-break
  invariant.
- GREEN — add the shared `isGitlinkMode` predicate and apply it at the three sites
  (`partitionLeftovers` routing, `buildCopySourcesForOn`/`ForHarder` skipping,
  `attemptBreaks` filter). Re-run; all pass with no throw.
- REFACTOR — ensure the predicate is defined ONCE and reused at all three sites (no
  copy-pasted `kindOf(...) === 'gitlink'`); confirm `assemblePostPass` still passes
  `other` through verbatim. Functions stay small; no `any`.

### Gate

`npx vitest run test/unit/application/primitives/detect-similarity-renames.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/primitives/detect-similarity-renames.ts test/unit/application/primitives/detect-similarity-renames.test.ts`

### Commit

`feat(diff): exclude gitlinks from inexact rename/copy/break detection`

## Slice 3 — cross-tool interop arms for gitlink patch render + rename detection

### Context

**Test-only, but exercises real production end-to-end** (the full
`diff → materialisePatchFiles → renderPatch` pipeline from Slice 1 and the detection
exclusion from Slice 2) — a legitimate standalone interop slice (template exception:
cross-tool faithfulness pin running production code, no `src/` delta). MUST land AFTER
Slices 1 and 2: the rename-detection arms need the exclusion, and the patch arms need the
synthesis. No production file is touched.

**File:** `test/integration/diff-type-change-interop.test.ts`. This is the ONLY interop
file with the `update-index --cacheinfo 160000,<oid>,<path>` gitlink-building machinery
(node adapter, on-disk git repo) — so BOTH the patch-render arms and the rename-detection
arms go here (design §"Test strategy" allows "same file or a sibling … whichever keeps
the `--cacheinfo` helper closest"; the helper lives only here, and the sibling
`rename-similarity-interop.test.ts` is memory-adapter + tsgit-command-driven with no
gitlink staging). The peer `rename-similarity-interop.test.ts` builds gitlinks NOWHERE.

Existing fixture machinery in this file to REUSE (do not re-invent):
- `describe.skipIf(!GIT_AVAILABLE)`, one shared `beforeAll` repo + `SETUP_TIMEOUT = 60_000`,
  `afterAll` dispose, `dateEnv(epoch)` (deterministic dates, signing off), `IDENTITY`,
  `GITLINK_OID = '1'.repeat(40)`. All `git` calls go through `runGit`/`git` (scrubbed
  `GIT_*`, isolated `HOME`, `GIT_CONFIG_NOSYSTEM=1`) from `./interop-helpers.js`.
- Helpers: `doCommit(message)` (commits + returns HEAD oid), `gitDiff(dir, from, to)`
  (`git diff --no-ext-diff --no-color`), `gitRawLines`, `gitNameStatus`, `rawLine(c)`,
  `nameStatusFrom(treeDiff)`. `reconstructPatch(ctx, treeDiff)` from `./diff-reconstruct.js`
  (= `renderPatch(await materialisePatchFiles(ctx, treeDiff.changes))` — the SAME path the
  library uses for rebase/patch-id). `ctx = createNodeContext({ workDir: dir })`;
  `repo = await openRepository({ cwd: dir })`; `diff` command imported from
  `../../src/application/commands/diff.js`.
- The four gitlink type-change commit pairs ALREADY exist: `fileToGitlink` (path `fg`),
  `gitlinkToFile` (`gf`), `symlinkToGitlink` (`sg`), `gitlinkToSymlink` (`gs`), built via
  `--cacheinfo` in `beforeAll`. They currently have `--raw`/`--name-status` `T` arms but
  NO `reconstructPatch` arm (those would throw today; now they pass).

**Arms to ADD:**

A. **Type-change `reconstructPatch` arms (4).** Into each existing `describe('Given file →
   gitlink …')` / `gitlink → file` / `symlink → gitlink` / `gitlink → symlink` `When diff
   called` block, add an `it('Then reconstructPatch emits delete+add blocks matching git
   diff patch bytes')` mirroring the file↔symlink arm at `:267`:
   `const peer = gitDiff(dir, from, to); const treeDiff = await diff(ctx, { from, to });
   const result = await reconstructPatch(ctx, treeDiff); expect(result).toBe(peer);`
   (Pinned against LIVE git + the §D1–D4 goldens.) The existing `--raw`/`--name-status`
   `T` arms stay UNCHANGED (ADR-399 regression guard).

B. **Pure gitlink ADD (A1) + DELETE (DEL1) + gitlink↔gitlink MODIFY (M).** Add three new
   commit pairs in `beforeAll` (after the existing pairs) and a top-level `let` for each
   (mirror `fileToGitlink` etc.):
   - **ADD** (path e.g. `add_sub`): base commit with the path ABSENT, then
     `update-index --add --cacheinfo 160000,<GITLINK_OID>,add_sub` + `doCommit`. Arms:
     `reconstructPatch` equals `gitDiff` (pins the single `new file mode 160000` +
     `+Subproject commit …` A1 block), plus `--name-status A` (`nameStatusFrom` ===
     `gitNameStatus`) and `--raw A` (`result.changes.map(rawLine)` === `gitRawLines`).
   - **DELETE** (path e.g. `del_sub`): the reverse — a commit WITH the gitlink, then
     `git rm --cached del_sub` + `doCommit`. Arms: `reconstructPatch` === `gitDiff` (DEL1
     single `deleted file mode 160000` block), `--name-status D`, `--raw D`.
   - **MODIFY** (path e.g. `bump_sub`): commit with gitlink oid `'1'*40`, then
     `update-index --cacheinfo 160000,<'2'*40>,bump_sub` + `doCommit`. Arms:
     `reconstructPatch` === `gitDiff` (the single `index 1111111..2222222 160000` + `-1/+1
     Subproject commit` M block), `--name-status M`, `--raw M`. Use a SECOND gitlink oid
     constant `GITLINK_OID_2 = '2'.repeat(40)`.
   Each pinned against LIVE git AND the §A1 / §DEL1 / §M goldens.

C. **Rename-detection arms (R1 / R2 / R3 / copy-source / B)** — `diff(ctx, { from, to,
   detectRenames: true, renameOptions })` vs live `git diff -M`/`-C`/`-B`. Add new commit
   pairs in `beforeAll` + `let`s. Use `git`'s own classification via
   `git(dir,'diff','--no-ext-diff','-M','--name-status', from, to)` etc. as `peer`:
   - **R1 — exact same-oid gitlink move under `-M` is `R100`.** Pair: gitlink `GITLINK_OID`
     at path `A` (commit it), then `git rm --cached A` + `--cacheinfo 160000,<same oid>,B`
     + commit. Arm: `diff(ctx, { from, to, detectRenames: true })` → result has ONE
     `RenameChange` (`oldPath 'A'`, `newPath 'B'`, both modes `160000`, `similarity.score
     === MAX_SCORE` — import `MAX_SCORE`), and `reconstructPatch` === git's header-only
     `similarity index 100%` / `rename from A` / `rename to B` bytes
     (`gitDiff` of `git diff -M`… — render via `reconstructPatch`, compare to a `-M` peer).
     Plus a `--name-status -M` structural arm `R100\tA\tB`.
   - **R2 — different-oid gitlink "move" stays `A`+`D`.** Pair: gitlink `GITLINK_OID` at
     `m1`, then remove + add gitlink `GITLINK_OID_2` at `m2`. Arm: at default threshold,
     `renameOptions: { threshold: 1 }`, AND `renameOptions: { copies: 'harder' }` — each
     yields exactly one `AddChange` + one `DeleteChange` (NO `RenameChange`/`CopyChange`),
     `reconstructPatch` === git's two-block add+delete patch, and the call does NOT throw.
   - **R3 — gitlink delete + near-similar real-blob add not cross-paired under `-M05`.**
     Pair: a gitlink at `r3` + a real blob, mutate so a blob add and the gitlink delete
     coexist; `renameOptions: { threshold: <≈0.5 * MAX_SCORE> }` → `A`+`D`, gitlink keeps
     `160000`, blob keeps `100644`, no rename, no throw.
   - **Copy-source pin — gitlink is not a COPY SOURCE under `-C --find-copies-harder`.**
     Pair: a gitlink modify (`X→Y` at `cs_g`) + an UNCHANGED gitlink (`X` at `cs_u`) + a
     content blob added whose bytes are literally `Subproject commit <X>\n`.
     `renameOptions: { copies: 'harder' }` → the gitlink modify stays `M`, the blob stays
     a pure `A` (no `CopyChange`), no throw. (This is the pin that makes the
     `buildCopySources*` exclusion load-bearing, not redundant with the add/delete guard.)
   - **B — gitlink↔gitlink bump under forced `-B` stays a plain `M`.** Pair: gitlink
     `X@bp` → `Y@bp`. `renameOptions: { breakRewrites: { score: 0, merge: 0 } }` → one
     `ModifyChange` (no synthetic delete+add, no `broken` datum), `reconstructPatch` ===
     git's single `index <a>..<b> 160000` block, no throw.

   For each, the `peer` is live `git diff` with the matching `-M`/`-C --find-copies-harder`/
   `-B` flag(s); compare `reconstructPatch`/`nameStatusFrom`/`map(rawLine)` to git.

GWT/AAA/`sut` conventions throughout (the existing arms model them). New `beforeAll`
commit-pair setup must keep the deterministic `doCommit` + `dateEnv` discipline; build
gitlinks ONLY via `update-index --cacheinfo` (no real submodule). Keep all new pairs
inside the one shared `beforeAll` (the 60s timeout + single-repo discipline is the
interop load→validate-flake guard).

### TDD steps

- RED — add the type-change `reconstructPatch` arms (A). Before Slice 1 they would throw;
  with Slice 1 landed they PASS (this slice lands after 1+2, so verify they are green and
  byte-equal to `gitDiff`). If any fails it is a real byte mismatch — fix the golden/setup,
  never the production.
- RED — add the new ADD/DELETE/MODIFY commit pairs + their `reconstructPatch` /
  `--name-status` / `--raw` arms (B). They exercise Slice 1's synthesis end-to-end; assert
  byte-equality to live git (A1/DEL1/M).
- RED — add the rename-detection pairs + arms (C: R1/R2/R3/copy-source/B). They exercise
  Slice 2's exclusion end-to-end; assert each matches git's classification and does not
  throw.
- GREEN — no production change in this slice; "green" = every new arm byte-matches live
  git. Run the file; all pass.
- REFACTOR — factor any repeated commit-pair scaffolding into small local `beforeAll`
  helpers if it reduces duplication, keeping the top-down readability the file favours.

### Gate

`npx vitest run test/integration/diff-type-change-interop.test.ts && npm run check:types && ./node_modules/.bin/biome check test/integration/diff-type-change-interop.test.ts`

### Commit

`test(diff): cross-tool interop for gitlink patch render and rename exclusion`
