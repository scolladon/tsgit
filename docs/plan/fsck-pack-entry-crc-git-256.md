# Plan — follow git 2.56 across the interop suite, pin CI's git, close 31.8

> Source: design doc `docs/design/fsck-pack-entry-crc-git-256.md` · ADRs 1107, 1108, 1109, 1110,
> 1111, 1112, 1113, 1114, 1115, 1116, 1117, 1118, 1119, 1120
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
  files in its `### Context` block, is two parts. What counts is a back-quoted path:
  backtick the files the part CREATES or EDITS, and write read-only reference paths in
  plain text.

Why some parts are re-pin sweeps: the 6-file ceiling cannot hold the fsck bit collapse
(8 source files, 8 unit suites, 7 interop suites, 10 prose files) in one part, and a mixed
exit value (e.g. 142 = 128|8|4|2) only reaches git's value once every bit source has
collapsed. So Parts 1–5 land the code with its unit suites (Part 5 is the 31.8 fold, so every
sweep reads final code), and Parts 6–8 re-pin the interop suites (each with the prose its
rows make true) once every bit they read is final.
The same holds for the midx recovery (Part 11) and the gitlink/bisect docs (Part 17).

## Conventions binding every part

- **RED first, one function at a time.** One RED per function, run before its code; record
  the observed failure before writing GREEN. Never batch REDs across functions; never
  write GREEN before its RED. An interop row that already passes at its step is a GUARD.
- **`sut` is the system under test** (the function or facade), never the result:
  `const sut = fsck; const result = await sut(ctx, opts)`. The test-pyramid gate
  (`sutBindsResult`) fails a part that names a result `sut`.
- **GWT split:** `describe('Given …')` > `describe('When …')` > `it('Then …')`, AAA body.
  Error assertions assert the error's data (`code` plus `path` / `id` / `reason`), via
  try/catch on `.data`, never `toThrow(Class)` alone.
- **Interop rows run against local `git` 2.56.0 on PATH** (the pinned target). The 2.55.0 build
  at the home-local git-2.55.0 prefix is for A/B reading only, never for a gate.
- **Probes that write** (config, repo state) run in a `mktemp -d` throwaway with the scrubbed
  env (`env -i PATH=… HOME=<tmp>/home GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=<tmp>/gitconfig`,
  `-c commit.gpgsign=false`), never in the worktree.
- **No provenance in code or tests:** no ADR, phase, backlog or design numbers in `src/` or
  `test/`. No suppression directives of any kind. No swallowed errors.
- **Gates run bare** (no `| tail`), exit code checked first. Long runs write to a file in the
  scratchpad and are read back with grep. Poll a background run, do not wait for a
  notification.
- **Coverage 100% / 0 surviving mutants:** every new branch named in a part gets its own
  isolated unit test (one per guard condition).
- **Commit** with `git commit -m "<message>"`, only the part's own files.
- **Dist bytes:** `check:size` / `check:tarball` sit within 100 B of their caps. Parts 1–4
  remove bytes; Parts 5, 9, 10, 14, 16, 18 and 21 add bytes. Parts do not raise caps: the
  orchestrator raises them once after review. A part whose only red is a size cap reports
  the measured delta in its hand-off report and commits.

## Decision candidates

Load-bearing choices the design and ADRs leave open. The recommendation is what each part
is written against; the orchestrator ratifies or swaps before Part 1 spawns.

| # | Choice | Alternatives (≤3) | Recommendation | Why |
|---|---|---|---|---|
| P-D1 | Where the fsck mode gates live (rev-index, bitmap, midx and pack-health's rev term skip under `connectivityOnly`; every pass keeps the local source only under `full: false`) | (a) Inside each pass, reading the `opts` it already takes (today `_opts`, ignored), with one shared `auditedSources(store, opts)` helper in source-attribution. (b) In `fsck.ts`, which skips whole passes and hands each pass a pre-filtered source list. | (a) | Each pass's unit suite already has a MODES block that pins "ungated"; (a) flips it in place and isolates one gate per test. (b) leaves dead `opts` parameters behind. |
| P-D2 | The 31.8 fold: which unpackable entry is reported `missing` (bit 2) | (a) Only an entry that a delta child in the same pack failed to read as its base. This is git's `mark_bad_packed_object` on the base, after `failed to read delta base object`. The id stays present when another pack or a loose copy holds it. (b) Every entry whose own unpack failed, the design's root-cause hint. | (a) | Probed under git 2.56.0 (throwaway, three commits of one 400-line file, `repack -ad`, entry body bytes XORed). A corrupt delta **base** with two delta children gives `missing blob <base>` and exit 3. A corrupt delta **child** alone gives exit 1 and no missing. A lone non-delta corrupt entry (fsck-interop row "Given a REFERENCED blob backed only by a corrupt PACKED entry") gives git exit 1 and no missing. (b) would break that last row. |
| P-D3 | How the midx owner-unavailable recovery is reached on the second read | (a) A registry operation, `lookupOwnerUnavailable(id)`, called only from the four `retryOnceAfterRescan` attempt closures (object-resolver, has-object `'recheck'`, and blob-source's locate and header probe) after their retry missed. Quick `hasObject` never reaches it. (b) Inside `retryOnceAfterRescan`, which pins a recovered hit in a per-generation id → hit map that `lookup` consults. | (a) | ADR-1113 forbids a cache and a `lookup` flag. (a) keeps `lookup`'s hot signature and adds no state. (b) would let a later quick lookup see the recovery, which git's QUICK never does. |
| P-D4 | `hold` on `BRANCH_CHECKED_OUT` outside `branchDelete` (forced `branchCreate`, `worktreeAdd`) | (a) Always `'checkout'`. Git's create/worktree refusals carry no qualifier, and only `delete_branches` runs `branch_bisecting` first. (b) The real claim kind (`'bisect'` when the claim came from `BISECT_START`). | (a) | The field names the refusal git prints. (b) would produce a value no git message reflects. |
| P-D5 | Where the lazy gc keys are validated | (a) `runGcStep`, under `auto`: validate `gc.auto` then `gc.autoPackLimit` **before** `failureOr`, so the refusal is thrown. `runGcTask`, not under `auto`: validate them first inside the failureOr scope (→ `tasksFailed`). `gc.bigPackThreshold`: at the start of `repack()`. `GcSettings.autoThreshold` is read after its validation. (b) Thread a "lazy" settings object that throws on first property read. | (a) | Plain call order, mirrors git's read points, and each guard gets its own test. (b) hides control flow in a getter. |
| P-D6 | Data shape for the gitfile refusal inside `GitlinkCheckout` | (a) `Broken` gains `via: CheckoutVia` (`'directory' \| 'gitfile'`). On the gitfile route, `shown` becomes the gitfile path (`dotGitShown(path)`), and throwers pick `gitfileNotARepository` when `via === 'gitfile'`. The malformed-pointer arm keeps today's `NOT_A_REPOSITORY` under its own value of the `Broken` union (`'unparsed-gitfile'`). (b) A new kind `'broken-gitfile'`. | (a) | Additive. Today's `kind === 'broken'` consumers (compare-working-tree-entry, embedded-repository, refname-ambiguity) keep working unchanged. |
| P-D7 | Test reach of the armor CR stripper | (a) Export `stripCrBeforeLf(text: string): string` from sign-payload.ts. It stays internal: no barrel entry, no public surface. (b) Keep it private and test it only through `signPayload` with a canned runner. | (a) | The property sibling needs the pure function. (b) makes every property run spawn a fake signer. |

## Part 1 — fsck: pack-health and rev-index passes set bit 1, gated by mode

### Context
- Edits:
  - `src/application/commands/internal/fsck/pack-health.ts`
    - `runPackHealthPass(ctx, opts): Promise<{ findings; exitBit }>` (L33);
      `reportSourcePacks` (L49); `reportUnusablePack(entry, report)` (L67).
    - Today `EXIT_PACK` (4) marks an accessibility finding and `EXIT_PACK_REV_INDEX` (64)
      marks `pack-rev-index-unusable`, which is **ungated**: it is emitted in every mode.
    - Target: both findings set `EXIT_CORRUPT` (1). The `pack-rev-index-unusable` term is
      skipped under `connectivityOnly` and kept under `full: false`, local sources only.
    - Keep `packAccessibilityReported` (L16) as is.
  - `src/application/commands/internal/fsck/rev-index-health.ts`
    - `runRevIndexHealthPass(ctx, _opts)` (L103) and `checkSourcePacks` (L119), which sets
      `EXIT_PACK_REV_INDEX`.
    - Target: bit 1. Return no findings under `connectivityOnly`. Under `full: false`, check
      local sources only.
    - Rewrite the docblock: "ungated" becomes the 2.56 gating.
  - `src/application/commands/internal/fsck/source-attribution.ts`
    - Today it holds only `attributeTo` (L7).
    - Add `auditedSources(store, opts): ReadonlyArray<ObjectSource>`: under `full === false`,
      `store.sources.filter((s) => s.local)`; otherwise `store.sources`. `ObjectSource.local`
      is declared in object-store.ts L24.
    - Internal symbol: not public, no surface gate.
  - `test/unit/application/commands/internal/fsck/rev-index-health.test.ts`
    - The MODES block (L566–575) pins "identical output in every fsck mode". Flip it:
      `connectivityOnly` → no findings, exit 0; `full: false` → local findings only.
    - Its 20 exit assertions move from 64 to 1.
  - `test/unit/application/commands/fsck.test.ts`
    - Exit assertions owned by these two passes, by top-level describe:
      - 'Given a v99-header pack whose objects exist nowhere else' (L3134);
      - 'Given a pack whose .idx is corrupt (magic mismatch)' (L3201–3202);
      - 'Given a v99-refused pack holding the only reachable tree…' (L3241);
      - 'Given a header-refused pack' (L3304, L3354–3355);
      - 'Given a pack with a corrupt .idx' (L3374, L3396, L3416). This is the connectivityOnly
        row; it now expects no rev-index finding and exit 0;
      - 'Given a pack with both a broken .rev and a broken bitmap' (L3441, 192). The
        intermediate value is 128|1 = 129 until Part 2;
      - the two 'malformed ref beside a header-refused pack with a broken bitmap' rows
        (L3463, 142 → 139; L3483, 138 unchanged);
      - L3641 (14 → 11);
      - 'Given a corrupt-idx pack beside a pack whose header probe would reject,
        connectivity-only mode' (L6635, `& 64`). The connectivityOnly gate makes it 0;
      - L7546–7547 (`& 4` / `& 64` → `& 1`);
      - 'Given a borrower whose donor holds a pack that fails its header gate' (L8931).
    - Add one isolated test per new gate (see TDD steps).
  - `docs/adr/607-a-second-finding-variant-separates-rev-and-idx-faults.md`
    - Amend in place: wherever it names bit 64, say both variants now set bit 1 and run only
      outside `connectivityOnly`.
    - Add one line of the form "amended for git 2.56: see ADR-1107".
- Read-only: src/application/commands/internal/fsck/exit-codes.ts (leave the constants
  until Part 4, import `EXIT_CORRUPT`); src/application/primitives/object-store.ts
  (`ObjectStore.sources`, `ObjectSource.local`); fsck.ts `runAccelerationPasses` (L382).
- Pinned 2.56 values (local source, design F1 matrix):
  - `.rev` middle byte flipped → default 1, connectivity-only 0, no-full 1;
  - an unusable `.idx` → no rev finding under connectivity-only.
- Alternate-donor values: `.rev` → default 1, connectivity-only 0, no-full 0 (the donor is
  skipped).

### TDD steps
1. RED (source-attribution): `auditedSources` keeps only the `local` sources when
   `full: false`. Fails because the function does not exist.
2. RED (same): `auditedSources` returns every source when `full` is absent. This RED and the
   previous one fail together on the missing export; write both, then GREEN 3.
3. GREEN: add `auditedSources`.
4. RED (rev-index-health): under `connectivityOnly` with a flipped `.rev`, the pass returns
   `{ findings: [], exitBit: 0 }`. Today it reports `pack-rev-index-invalid` with 64.
5. RED (rev-index-health): default mode with a flipped `.rev` gives `exitBit` 1. Today 64.
6. RED (rev-index-health): under `full: false` with a donor `.rev` flipped and a clean local
   pack, there are no findings. Today it reports the donor's finding.
7. GREEN: gate on `opts`, iterate `auditedSources`, set `EXIT_CORRUPT`. Re-pin the MODES
   block and the remaining 64 literals.
8. RED (pack-health): under `connectivityOnly`, a corrupt `.idx` yields no
   `pack-rev-index-unusable`. Today it reports one, with 64.
9. RED (pack-health): default mode with a v99 pack gives `exitBit` 1. Today 4.
10. RED (pack-health): under `full: false`, a donor with an unusable `.idx` yields nothing.
    Today it yields the donor's finding.
11. GREEN: in `reportSourcePacks` / `reportUnusablePack`, OR `EXIT_CORRUPT`; skip the rev
    term under `connectivityOnly`; iterate `auditedSources`. Re-pin the fsck.test.ts rows
    listed in Context.
12. REFACTOR: drop the stale "ungated" prose in both docblocks. Amend ADR-607.

### Gate
```
npx vitest run --project unit test/unit/application/commands/internal/fsck test/unit/application/commands/fsck \
&& npx vitest run --project integration test/integration/fsck-commit-graph-interop.test.ts test/integration/fsck-connectivity-typing-interop.test.ts test/integration/fsck-root-tagged-interop.test.ts test/integration/rev-write-interop.test.ts \
&& npm run check:types \
&& ./node_modules/.bin/biome check src/application/commands/internal/fsck/pack-health.ts src/application/commands/internal/fsck/rev-index-health.ts src/application/commands/internal/fsck/source-attribution.ts test/unit/application/commands/internal/fsck/rev-index-health.test.ts test/unit/application/commands/fsck.test.ts \
&& npm run check:spelling
```
The red fsck interop suites (rev-bitmap-fsck, fsck-pack-accessibility, alternates-gc-fsck,
midx-fsck, fsck-object-table) stay red until Parts 5–11 re-pin them; they are not run here.

### Commit
`fix(fsck): set bit 1 for pack and rev-index faults and gate them by mode as git 2.56 does`

## Part 2 — fsck: bitmap and midx passes set bit 1, gated by mode

### Context
- Edits:
  - `src/application/commands/internal/fsck/bitmap-health.ts`
    - `runBitmapHealthPass(ctx, _opts)` (L81) ends `exitBit: findings.length > 0 ? EXIT_BITMAP : 0`
      (L92). The docblock (L69–79) says "fires identically in every mode".
    - Target: bit 1; nothing under `connectivityOnly`; `auditedSources` (Part 1) under
      `full: false`, keeping git's order (every source's midx bitmap, then every source's
      pack bitmaps).
  - `src/application/commands/internal/fsck/midx-health.ts`
    - `runMidxHealthPass(ctx, _opts)` (L39), `exitBit |= EXIT_MULTI_PACK_INDEX` (L50).
    - Target: bit 1; nothing under `connectivityOnly`; local sources only under `full: false`.
  - `test/unit/application/commands/internal/fsck/bitmap-health.test.ts`
    - 14 assertions of 128 → 1. Flip the MODES block (L751–760) and the "unconditional in
      every mode" block (L599).
  - `test/unit/application/commands/fsck.test.ts`
    - midx rows: L4110, L4139, L4175, L4206, L7031–7283, L7445–7583, L7729–7732,
      L7772–7774 (the `withMidx ^ withoutMidx` difference becomes 1 or 0, depending on
      whether the without-midx twin already exits 1: assert the real value), L7843, L8975.
    - bitmap rows: L3441 (129 → 1), L3463 (139 → 11), L3483 (138 → 10), L7545 (`& 32` → `& 1`).
  - `docs/adr/601-fsck-reports-midx-findings.md`
  - `docs/adr/603-full-read-support-for-both-pack-auxiliary-artefacts.md`
    - Amend both where they name bit 32 or bit 128: 2.56 sets bit 1 and skips the passes
      under `connectivityOnly`, see ADR-1107.
- Read-only: pack-health.ts and source-attribution.ts as Part 1 left them.
- Pinned 2.56 values (local source):
  - pack `.bitmap` → default 1, connectivity-only 0, no-full 1;
  - midx checksum → 1 / 0 / 1;
  - midx `.bitmap` → 1 / 0 / 1.
- Alternate donor: `.bitmap` and midx checksum → default 1, connectivity-only 0, no-full 0.

### TDD steps
1. RED (bitmap-health): `connectivityOnly` with a flipped pack bitmap gives no findings,
   exit 0. Today it reports `bitmap-checksum-mismatch` with 128.
2. RED (bitmap-health): default mode, same fixture, gives exit 1. Today 128.
3. RED (bitmap-health): `full: false` with a flipped donor bitmap gives no findings. Today it
   reports the donor's.
4. GREEN: gate, `auditedSources`, `EXIT_CORRUPT`. Re-pin the remaining literals.
5. RED (fsck.test, midx): `fsck(ctx, { connectivityOnly: true })` over a flat midx with a
   flipped trailer gives no `midx-checksum-mismatch` and exit 0. Today it reports one,
   with 32.
6. RED (fsck.test, midx): `full: false` with only the donor midx trailer flipped gives no
   midx finding. Today it reports the donor's.
7. GREEN: gate `runMidxHealthPass`, `EXIT_CORRUPT`. Re-pin the midx and bitmap rows listed
   in Context.
8. REFACTOR: rewrite both docblocks. Amend ADR-601 and ADR-603.

### Gate
```
npx vitest run --project unit test/unit/application/commands/internal/fsck test/unit/application/commands/fsck \
&& npx vitest run --project integration test/integration/fsck-commit-graph-interop.test.ts test/integration/fsck-connectivity-typing-interop.test.ts test/integration/fsck-root-tagged-interop.test.ts test/integration/rev-write-interop.test.ts \
&& npm run check:types \
&& ./node_modules/.bin/biome check src/application/commands/internal/fsck/bitmap-health.ts src/application/commands/internal/fsck/midx-health.ts test/unit/application/commands/internal/fsck/bitmap-health.test.ts test/unit/application/commands/fsck.test.ts \
&& npm run check:spelling
```

### Commit
`fix(fsck): set bit 1 for bitmap and midx faults and skip them under connectivity-only as git 2.56 does`

## Part 3 — fsck: verify_pack's entry catalogue and the object table set bit 1

> Landed together with Part 4 as one commit. Three verify-pack unit fixtures carry a CRC
> finding (Part 4's bit) and an unpack finding (this part's bit), so they read 5 between
> the two parts and neither part could commit on a green gate alone. The commit also
> re-pins `test/unit/application/commands/fsck-mis-hashed-ref-tip.test.ts` (6 → 3) and the
> verify-pack rows at L132, L155, L185 and L297, which both context blocks omitted.

### Context
- Edits:
  - `src/application/commands/internal/fsck/content-validation.ts`
    - `packEntryResult` (L475–477) returns `exitBit: EXIT_PACK`.
    - `validatePackedEntry(ctx, entry, options): Promise<ContentValidationResult>`
      (L592–609) ends `exitBit: catalogue.exitBit === 0 ? 0 : EXIT_PACK`.
    - Target: `pack-entry-unpackable` and `pack-entry-corrupt` set `EXIT_CORRUPT`. The
      catalogue arm returns `catalogue` as is (its bit is already 1).
    - Fix the docblocks at L586–591 and L604–606 that say "bit 4, never bit 1". Drop the
      `EXIT_PACK` import.
  - `src/application/commands/internal/fsck/object-table.ts`
    - `findingExitBit` (L149–153): `unparseable-object` with `pack` returns
      `EXIT_CORRUPT | EXIT_PACK`. Target: `EXIT_CORRUPT` for both arms. The `pack` field
      stays on the finding.
  - `test/unit/application/commands/internal/fsck/content-validation-packed.test.ts`: L80,
    L128, L228 (4 → 1).
  - `test/unit/application/commands/internal/fsck/object-table.test.ts`: L125 (5 → 1).
  - `test/unit/application/commands/fsck-special-blobs.test.ts`: local `EXIT_PACK = 4` (L22).
    Its rows at L106, L127 and L332 become `EXIT_CONTENT` (1). Delete the local constant.
  - `test/unit/application/commands/fsck-mis-hashed-pack-copy.test.ts`: local `EXIT_PACK = 4`
    (L23). L135 and L176 become 1, L158 becomes `1 | EXIT_REFS_CONTENT` (9).
- Read-only: verify-pack.ts. Its own `EXIT_PACK` uses (`verifyEntry` L98, `verifyOnePack`
  L188) stay until Part 4. The fixtures above trip no CRC or trailer finding, so they
  already read their final value here. If one of them shows 5, or 4|x, the fixture trips a
  verify-pack own finding: stop and escalate rather than pin an intermediate.

### TDD steps
1. RED (content-validation-packed): an unpackable entry gives `exitBit` 1. Today 4.
2. GREEN: `packEntryResult` → `EXIT_CORRUPT`.
3. RED (content-validation-packed): a packed entry with a catalogue ERROR gives `exitBit` 1.
   Today 4.
4. GREEN: the catalogue arm returns `catalogue.exitBit`.
5. RED (object-table): `unparseable-object` with `pack` gives 1. Today 5.
6. GREEN: `findingExitBit` collapse.
7. Re-pin fsck-special-blobs and fsck-mis-hashed-pack-copy (both go red after step 4,
   expecting 4); delete the local constants.
8. REFACTOR: docblocks.

### Gate
```
npx vitest run --project unit test/unit/application/commands/internal/fsck test/unit/application/commands/fsck \
&& npx vitest run --project integration test/integration/fsck-commit-graph-interop.test.ts test/integration/fsck-connectivity-typing-interop.test.ts test/integration/fsck-root-tagged-interop.test.ts \
&& npm run check:types \
&& ./node_modules/.bin/biome check src/application/commands/internal/fsck/content-validation.ts src/application/commands/internal/fsck/object-table.ts test/unit/application/commands/internal/fsck/content-validation-packed.test.ts test/unit/application/commands/internal/fsck/object-table.test.ts test/unit/application/commands/fsck-special-blobs.test.ts test/unit/application/commands/fsck-mis-hashed-pack-copy.test.ts \
&& npm run check:spelling
```

### Commit
`fix(fsck): set bit 1 for damaged pack entries and packed parse failures as git 2.56 does`

## Part 4 — fsck: verify_pack's own findings set bit 1; the four pack-class bits are removed

### Context
- Edits:
  - `src/application/commands/internal/fsck/verify-pack.ts`
    - `verifyEntry` (L78), `exitBit: (crc.length > 0 ? EXIT_PACK : 0) | unpacked.exitBit` (L98).
    - `verifyOnePack` (L177), `const ownBit = findings.length > 0 ? EXIT_PACK : 0` (L188).
    - `runVerifyPackPass` docblock (L197–200): "Any finding sets bit 4".
    - Target: `EXIT_CORRUPT`.
  - `src/application/commands/internal/fsck/exit-codes.ts`
    - Delete `EXIT_PACK`, `EXIT_MULTI_PACK_INDEX`, `EXIT_PACK_REV_INDEX` and `EXIT_BITMAP`
      (decided by ADR-1107: no aliases).
    - Rewrite the header comment: bits 1, 2, 8 and 16, pinned against git 2.56.0. Say that
      pack, rev-index, bitmap and midx faults set bit 1.
    - After Parts 1–3, `grep -rn "EXIT_PACK\b\|EXIT_MULTI_PACK_INDEX\|EXIT_PACK_REV_INDEX\|EXIT_BITMAP" src`
      must return only this file.
    - rev-write-interop.test.ts keeps its own local `EXIT_PACK_REV_INDEX = 64` (L61), used
      only in `& 64 → 0` checks that stay true. Leave it.
  - `test/unit/application/commands/internal/fsck/verify-pack.test.ts`: L276 and L330 (4 → 1).
  - `test/unit/application/commands/fsck.test.ts`: 'Given a pack whose .idx trailer is
    corrupt' (L9020, `& 4` → `& 1`), plus any remaining verify-pack-owned `& 4`.
  - `docs/adr/920-pack-class-fsck-findings-carry-their-objects-dir.md`: amend the bit names
    to bit 1 (git 2.56, ADR-1107).
- Pinned 2.56 values:
  - idx-crc → default 1 [2.55: 4];
  - pack-body → default 3 (bit 2 comes from Part 5's fold; this part yields 1 for the
    pack-body fixture);
  - connectivity-only / no-full → 0.

### TDD steps
1. RED (verify-pack): a CRC mismatch on one entry gives `exitBit` 1. Today 4.
2. GREEN: `verifyEntry`.
3. RED (verify-pack): a flipped pack trailer with clean entries gives `exitBit` 1. Today 4.
4. GREEN: `verifyOnePack`.
5. GUARD: the `tsc` run after deleting the four constants: no importer is left (Parts 1–3
   moved them).
6. REFACTOR: exit-codes.ts header; ADR-920 amendment; re-pin fsck.test L9020.

### Gate
```
npx vitest run --project unit test/unit/application/commands/internal/fsck test/unit/application/commands/fsck \
&& npx vitest run --project integration test/integration/fsck-commit-graph-interop.test.ts test/integration/fsck-connectivity-typing-interop.test.ts test/integration/fsck-root-tagged-interop.test.ts test/integration/rev-write-interop.test.ts \
&& npm run check:types \
&& ./node_modules/.bin/biome check src/application/commands/internal/fsck/verify-pack.ts src/application/commands/internal/fsck/exit-codes.ts test/unit/application/commands/internal/fsck/verify-pack.test.ts test/unit/application/commands/fsck.test.ts \
&& npm run check:spelling
```

### Commit
`fix(fsck): fold verify_pack's findings into bit 1 and drop the pack-class exit bits`

## Part 5 — fsck reports a delta base its children could not read as missing (31.8 closure)

### Context
- Edits:
  - `src/application/commands/internal/fsck/verify-pack.ts`
    - `verifyEntriesInOrder(ctx, target, index, layout, hasher)` (L142) walks entries in
      offset order.
    - `VerifyPackResult` (L65) extends `ContentValidationResult` with `copies`.
    - Add `badBases: ReadonlySet<ObjectId>` (P-D2): when an entry's own unpack failed and its
      header is OFS_DELTA or REF_DELTA, read its base from the header and record the base's
      id. `parsePackEntryHeader(bytes, offset, hash)` (src/domain/storage/pack-entry.ts L163)
      gives `baseDistance` (OFS) or `baseId` (REF).
    - Record the base only when that base entry's own unpack also failed in this pass.
      Map OFS bases back to an id through the offset → position layout already built.
    - An OFS base sits before its child in offset order, so its result is known.
  - `src/application/commands/fsck.ts`
    - `unreadablePackMemberIds` (L506–516) feeds `buildReachableSet`'s pack-held excuse.
    - Subtract `store.verifyPack.badBases` (thread it from `runPackPasses` L364) unless
      another pack or a loose copy holds the id. Use `hasPackCopy` /
      `collectUnreadablePackMemberIds` in object-cache.ts as references.
    - The walk then reports `missing` for the base, giving bit 2.
  - `test/unit/application/commands/internal/fsck/verify-pack.test.ts`: `badBases` cases.
  - `test/integration/fsck-pack-accessibility-interop.test.ts`: a new describe, 'Given a
    corrupt delta base with two delta children'. Build the fixture with git (scrubbed env):
    3 commits of one ≥400-line file, `reflog expire --expire=now --all`, `repack -adq`,
    `prune-packed`, then XOR the base entry's body bytes from offset+5 to its end (read
    offset and size from `git verify-pack -v`).
    - Seed it twice (lesson 022): with the corrupt base **first** in pack order (the default
      `repack`), and **last**. For the "last" twin, write the pack with the base as a
      REF_DELTA target placed after its children, e.g. via `pack-objects` fed in reverse
      order, and confirm with `verify-pack -v`.
    - Both twins: git exit 3 and `missing blob <base>`; tsgit `missing` for the base, none
      for the children, exit 3.
  - `docs/use/commands/fsck.md` L222–224: replace the "Known gap" sentence with
    `pack-crc-mismatch` (bit 1 under 2.56) and the missing-base rule.
  - `docs/adr/907-whole-object-loose-reads-bound-the-inflate-to-the-size-claim.md` L78–81: amend
    the "Known gap" paragraph to "closed: per-entry CRC pass in verify-pack; a delta base its
    children could not read is reported missing".
- Pinned 2.56 bytes, re-probed for this plan:
  - corrupt base with two delta children →
    - `error: …pack checksum mismatch`;
    - `index CRC mismatch for object <base> … at offset <o>`;
    - `cannot unpack <base> … at offset <o>`;
    - for each child: `failed to read delta base object <base> at offset <o> …`, then
      `cannot unpack <child> …`;
    - then `missing blob <base>`; exit 3.
  - corrupt delta child alone → exit 1, no missing.
  - lone non-delta corrupt entry → exit 1, no missing: the fsck-interop row that Part 6
    re-pins (its exit literal is still red here).
- docs/BACKLOG.md L625 (31.8) is ticked by the documentation phase, per the design. Not this
  part.

### TDD steps
1. RED (interop): the new two-twin row. git 3 + `missing blob <base>`; tsgit today returns
   exit 1 with no missing finding.
2. RED (verify-pack unit): a pack whose base entry is corrupt and has two OFS_DELTA children
   gives `badBases` = {base}. Today the field does not exist.
3. GREEN: `badBases` collection in `verifyEntriesInOrder`.
4. GUARD (verify-pack unit): a corrupt OFS_DELTA child over a healthy base gives `badBases`
   empty. It passes after GREEN 3 because only a base whose own unpack failed is recorded;
   it isolates that condition.
5. RED (verify-pack unit): a REF_DELTA child whose base failed records the base by `baseId`.
6. GREEN: the REF arm.
7. RED (fsck unit): `fsck` over the corrupt-base pack reports `missing` for the base,
   exit 3. Today exit 1.
8. GREEN: subtract `badBases` in `unreadablePackMemberIds`.
9. GUARD (fsck unit): the same corrupt base with a loose copy present is not reported
   missing (another copy holds it).
10. GUARD (fsck unit): a lone non-delta entry with a corrupt body, referenced by a commit, is
    not reported missing (exit 1). It passes because no delta child marks it. The interop
    twin is re-pinned in Part 6.
11. Docs: fsck.md and the ADR-907 amendment.

### Gate
The rest of fsck-pack-accessibility is still red on F1/F12 literals until Part 8, so the
new rows run by name filter. The whole fsck interop family runs at Part 8 (lesson 015).
```
npx vitest run --project unit test/unit/application/commands/internal/fsck test/unit/application/commands/fsck \
&& npx vitest run --project integration test/integration/fsck-pack-accessibility-interop.test.ts -t "Given a corrupt delta base with two delta children" \
&& npx vitest run --project integration test/integration/fsck-commit-graph-interop.test.ts test/integration/fsck-connectivity-typing-interop.test.ts test/integration/fsck-root-tagged-interop.test.ts \
&& npm run check:types \
&& ./node_modules/.bin/biome check src/application/commands/internal/fsck/verify-pack.ts src/application/commands/fsck.ts test/unit/application/commands/internal/fsck/verify-pack.test.ts test/integration/fsck-pack-accessibility-interop.test.ts \
&& npm run check:spelling
```

### Commit
`fix(fsck): report a delta base its children could not read as missing, as git does`

## Part 6 — fsck interop: rev-index/bitmap, delta-pack and fsck rows re-pinned to 2.56

### Context
- Edits (test re-pins + prose; the code landed in Parts 1–4):
  - `test/integration/rev-bitmap-fsck-interop.test.ts`: 59 red rows. Failure shapes:
    - git now exits 0 where the row expects 64 (20) or 128 (6): the connectivity-only rows;
    - 1 where it expects 64 (16), 128 (2), 32 (1) or 192 (1);
    - 10 where it expects 74 or 138;
    - 11 where it expects 14, 74, 78 (4), 138 or 142 (2);
    - 3 where it expects 130.
    - Every exit literal and exit table follows git 2.56. Rename titles that say
      "bit 64", "bit 128", "exit 68" and similar to the 2.56 value.
    - Stderr reconstructions are unchanged (byte-identical across versions).
    - Fixture helpers: test/integration/rev-bitmap-fixture-helpers.ts (read-only).
  - `test/integration/delta-pack-interop.test.ts`: the row 'Then it exits 6 with
    pack-checksum / CRC / unpack findings on stderr' (L695–720) is git-only. It becomes
    exit 3; retitle it "exits 3"; rewrite the L713–716 comment.
  - `test/integration/fsck-interop.test.ts`: the row 'Given a REFERENCED blob backed only by a
    corrupt PACKED entry … both exit 4' (L1810 block) → both exit 1. Retitle it. Rewrite the
    L1730–1737 comment: it is pinned against git 2.56.0 and still has no `missing` line.
    It also guards Part 5's fold: no `missing` line, because no delta child marks the entry.
  - `docs/adr/608-per-position-body-mismatches-are-individual-findings.md`: amend the bit-64
    mention.
  - `docs/design/fsck.md`: the exit-bit sections. Bits 1/2/8/16 only; pack, rev, bitmap and
    midx faults set 1; the 2.56 mode gating table (the design's F1 matrices).
- Read-only: test/integration/interop-helpers.ts (`tryRunGitWithExit`),
  test/integration/pack-fixture-helpers.ts.

### TDD steps
1. GUARD-sweep: run the three suites under git 2.56 and confirm every red row fails only on
   an exit literal (no tsgit finding drift). A non-literal failure is a code gap: stop and
   escalate with `{ unit, reason, options }`.
2. Re-pin rev-bitmap-fsck row by row (titles, tables, literals). Re-run.
3. Re-pin delta-pack L719 and fsck-interop L1810. Re-run.
4. Prose: ADR-608, design fsck.md.

### Gate
```
npx vitest run --project integration test/integration/rev-bitmap-fsck-interop.test.ts test/integration/delta-pack-interop.test.ts test/integration/fsck-interop.test.ts test/integration/fsck-commit-graph-interop.test.ts test/integration/fsck-connectivity-typing-interop.test.ts test/integration/fsck-root-tagged-interop.test.ts \
&& npm run check:types \
&& ./node_modules/.bin/biome check test/integration/rev-bitmap-fsck-interop.test.ts test/integration/delta-pack-interop.test.ts test/integration/fsck-interop.test.ts \
&& npm run check:spelling
```

### Commit
`test(fsck): pin the rev-index, bitmap, delta-pack and fsck rows to git 2.56`

## Part 7 — fsck full:false audits the local source only; alternates and object-table rows re-pinned

### Context
- Edits:
  - `src/application/commands/fsck.ts`
    - `enumerateUniverse(ctx, opts)` (L289–298) calls `enumerateObjects(ctx, { scope: 'all', includePacks: opts.full !== false, … })`.
    - Target: `scope: opts.full === false ? 'local' : 'all'` (ADR-1108). The `scope` option
      already exists in src/application/primitives/enumerate-objects.ts L28.
    - Leave `settleWalk`'s `excusePackHeld` (L486–496) and `refTargetCheck` (L111) as they
      are: no red row pins a donor-packed referent under `--no-full`.
  - `test/unit/application/commands/fsck.test.ts`: the borrower describes (around L8920–8975)
    gain one row, a valid tip living only as a donor loose object under `full: false`
    → `missing` (objectType `commit`), exit 2.
  - `test/integration/alternates-gc-fsck-interop.test.ts` (20 red rows):
    - 18 F1 exit literals (4 → 1, 14 → 11, 12 → 9, 6 → 3, plus the tsgit-vs-git pairs where
      tsgit read 5 or 6 and git reads 1 or 3);
    - the row 'Given a donor loose file whose content hashes to a different oid When the
      borrower fsck runs ('no-full')'. Under 2.56, git exits 2 and prints
      `missing commit <oid>`, not the bogus-object pair. Rewrite the row to rebuild that line
      from tsgit's `missing` finding;
    - the F5b row 'Given a borrower whose core.deltaBaseCacheLimit is malformed When git gc
      -q and tsgit gc run' (L1270), rebuilt byte for byte (ADR-1112). The 2.56 stderr is four
      lines: the bad-numeric fatal (with ` in file .git/config` for a file value, without it
      for `-c`), `error: failed to run pack-refs`, the same fatal line again, then
      `fatal: failed to run worktree`. tsgit's refusal data is unchanged.
  - `test/integration/fsck-object-table-interop.test.ts` (8 red rows):
    - `errorLines` (L351–358): the loose branch becomes `error: ${f.id}: object corrupt or
      missing`, the same line the pack branch uses. Delete `looseRelativePath` if it ends up
      unused;
    - the two packed rows 'main at a packed commit whose packed …' and 'an unreferenced
      packed commit whose t…' read tsgit 1 = git 1 since Part 3.
  - `docs/use/commands/fsck.md` L175 (`unparseable-object` row): git's line is now the same
    for loose and packed copies.
- Pinned 2.56 values (design F1 alternate-donor matrix):
  - a borrower on a donor whose loose commit body is `garbage`, `--no-full` → exit 2 and
    `missing commit <oid>`, where 2.55 gave exit 1 with the bogus-object pair;
  - default mode → exit 1, unchanged.

### TDD steps
1. RED (fsck.test): `fsck(borrowerCtx, { full: false })`, where the borrower's tip lives only
   in the donor's loose store, reports `missing` for the tip with exit 2. Today it reads the
   donor and reports none.
2. GREEN: `scope` in `enumerateUniverse`. If the walk still resolves the tip through the
   donor, find which read did it: refs-verify's probe (`refTargetCheck` 'probe-packs') or
   `recordedBy`. Gate that read on the universe, not the store; add one isolated test per
   guard you touch.
3. Re-pin the 20 alternates-gc-fsck rows (GUARD first: run and confirm each red row fails
   on the literal named above).
4. Re-pin fsck-object-table `errorLines`; update fsck.md L175.

### Gate
```
npx vitest run --project unit test/unit/application/commands/internal/fsck test/unit/application/commands/fsck \
&& npx vitest run --project integration test/integration/alternates-gc-fsck-interop.test.ts test/integration/fsck-object-table-interop.test.ts test/integration/alternates-interop.test.ts test/integration/fsck-interop.test.ts \
&& npm run check:types \
&& ./node_modules/.bin/biome check src/application/commands/fsck.ts test/unit/application/commands/fsck.test.ts test/integration/alternates-gc-fsck-interop.test.ts test/integration/fsck-object-table-interop.test.ts \
&& npm run check:spelling
```

### Commit
`fix(fsck): audit only the local source when full is false, as git 2.56 does`

## Part 8 — fsck connectivity-only refuses an unreadable loose object; pack-accessibility rows re-pinned

### Context
- Edits:
  - `src/application/commands/internal/fsck/object-cache.ts`
    - `recordUnreadable(ctx, id, err, unreadable, acc)` (L479–495): today the `'classify'`
      mode (connectivityOnly; fsck.ts L268 sets it) runs header recovery and records the id.
    - Target (ADR-1116): when the unreadable copy is a **loose** object the enumeration
      reached, throw `looseObjectCorrupt(id)` (`LOOSE_OBJECT_CORRUPT { id }`, constructor
      in src/domain/objects/error.ts L145).
    - Packed-copy recovery stays as is. Default mode (`'skip'`) is unchanged: the
      empty-file default row stays exit 1.
  - `test/unit/application/commands/fsck-connectivity-only-findings.test.ts`: the unit rows
    (see TDD steps).
  - `test/integration/fsck-pack-accessibility-interop.test.ts` (22 red rows):
    - 20 F1 literals (4 → 1, 68 → 1, 14 → 11);
    - the "mode gating" table: 'v99 pack, default' 1; 'corrupt idx, default' 1;
      'corrupt idx, --connectivity-only' 0; 'corrupt idx, --no-full' 1; take every other
      cell from git 2.56;
    - rename titles that say "exits 4", "exits 68" or "bit 4";
    - the two F12 rows 'Given a chmod-000 loose object, unreferenced, When fsck runs with
      connectivityOnly' (L1116) and 'Given an empty loose object, dangling, When fsck runs
      with connectivityOnly' (L1312). Their pinned 2.56 bytes are below;
    - the verify_pack rows 'Given the pack trailer is corrupt … exit 14' → 11 and 'a
      separate pack holding only an unreachable blob, with its body corrupt … exit 4' → 1.
  - `docs/use/commands/fsck.md`: the exit-bit table (1, 2, 8, 16 only), every "Exit bit
    4/32/64/128" in the finding table, the mode-gating prose, and the connectivityOnly
    refusal.
  - `docs/design/fsck-pack-accessibility-reporting.md`: the bit sections and the mode-gating
    table re-pinned to 2.56.
- Pinned 2.56 bytes (F12):
  - **empty file** → exit 128, stderr `error: object file .git/objects/ab/ccc… is empty`
    three times, then `fatal: loose object <oid> (stored in .git/objects/ab/ccc…) is corrupt`;
  - **chmod 000** → `error: unable to open loose object <oid>: Permission denied` three
    times, then the same fatal line;
  - the "dangling unknown" assertions go away;
  - tsgit: `LOOSE_OBJECT_CORRUPT { id }`. The test rebuilds the fatal line from `id` and the
    fanout path.
  - Before the RED rows, confirm the die by reading odb/source-loose.c at v2.56.0 (fetch it
    into the scratchpad; do not cite it in code).

### TDD steps
1. RED (unit): `fsck(ctx, { connectivityOnly: true })` over an unreferenced empty loose file
   rejects with `{ code: 'LOOSE_OBJECT_CORRUPT', id }`. Today it resolves with a
   dangling/unknown finding.
2. GREEN: the loose arm in `recordUnreadable`.
3. GUARD (unit): the same fixture in default mode still returns exit 1 with its finding. It
   passes because `'skip'` mode never reaches the new arm.
4. GUARD (unit): under connectivityOnly, an unreadable **packed** copy still classifies. It
   passes because only the loose arm throws.
5. Re-pin the 20 F1 rows and the mode-gating table; rewrite the two F12 rows (RED against
   the old expectations, GREEN with the 2.56 bytes).
6. Docs: fsck.md and the pack-accessibility design doc.

### Gate
Whole fsck interop family (lesson 015); midx-fsck runs in Part 11 and maintenance in Part 19,
once their own families are re-pinned.
```
npx vitest run --project unit test/unit/application/commands/internal/fsck test/unit/application/commands/fsck \
&& npx vitest run --project integration test/integration/fsck-pack-accessibility-interop.test.ts test/integration/fsck-interop.test.ts test/integration/rev-bitmap-fsck-interop.test.ts test/integration/alternates-gc-fsck-interop.test.ts test/integration/fsck-object-table-interop.test.ts test/integration/fsck-commit-graph-interop.test.ts test/integration/fsck-connectivity-typing-interop.test.ts test/integration/fsck-root-tagged-interop.test.ts test/integration/delta-pack-interop.test.ts test/integration/alternates-interop.test.ts \
&& npm run check:types \
&& ./node_modules/.bin/biome check src/application/commands/internal/fsck/object-cache.ts test/unit/application/commands/fsck-connectivity-only-findings.test.ts test/integration/fsck-pack-accessibility-interop.test.ts \
&& npm run check:spelling
```

### Commit
`fix(fsck): refuse an unreadable loose object under connectivity-only as git 2.56 does`

## Part 9 — pack registry: the midx owner-unavailable lookup

### Context
- Edits:
  - `src/application/primitives/internal/midx-binding.ts`
    - `findMidxHit(midx: LoadedMidx, id: ObjectId): PackLookupHit | undefined` (L123)
      returns `undefined` both for "no layer holds id" and for "the owner pack never bound".
    - Target: a tri-state `MidxLookup = { kind: 'hit'; hit } | { kind: 'miss' } |
      { kind: 'owner-unavailable' }`. Internal type, no surface gate.
  - `src/application/primitives/pack-registry.ts`
    - `lookup(id)` (L1306–1317) maps the tri-state.
    - `owner-unavailable` and a header-probe fault (L1312–1316) both fall through to
      `lookupViaIdxScan` (first read, unchanged).
    - Add to the `PackRegistry` interface (L245) `lookupOwnerUnavailable(id): Promise<PackLookupHit | undefined>`.
      It applies only when the current generation's midx says owner-unavailable (or the bound
      owner fails `probeHeader`) for `id`.
    - It scans the midx's bound packs in `PNAM` order across layers, base layer first
      (`midx.packsByLayer` from layer 0 upward, git's `0 … num_packs + num_packs_in_base`).
      For each pack, look up `.idx` and probe the header. Serve the first hit; otherwise
      `undefined`.
    - No teardown, no re-listing, no cache.
    - Internal: PackRegistry is not exported from any package entry.
  - `test/unit/application/primitives/pack-registry.test.ts`: the tri-state and the scan.
  - `test/unit/application/primitives/internal/midx-source.test.ts`, or a new
    `test/unit/application/primitives/internal/midx-binding.test.ts` if findMidxHit has no
    direct suite: one test per tri-state arm.
- Fixture shape (design F6): blob X in pack A (X only) and pack B (X and O, newer); the midx
  assigns X to B. Use test/integration/midx-fixture-helpers.ts as the shape reference;
  unit tests use the memory adapter.
- ADR-592 already carries its supersession banner (ADR-1113); no prose edit here.

### TDD steps
1. RED (midx-binding): `findMidxHit` for an id whose owner never bound returns
   `{ kind: 'owner-unavailable' }`. Today it returns `undefined`.
2. RED (midx-binding): an id no layer holds returns `{ kind: 'miss' }`. Today `undefined`.
   It fails with step 1 on the shape; write both, then GREEN.
3. GREEN: the tri-state, with `lookup` adapted. GUARD: every existing pack-registry test
   passes unchanged.
4. RED (pack-registry): `lookupOwnerUnavailable(X)` with B deleted returns A's hit. Today the
   method does not exist.
5. GREEN: the scan.
6. RED (pack-registry): with the midx naming X in a healthy B, `lookupOwnerUnavailable(X)`
   returns `undefined` (the scan only runs on owner-unavailable).
7. RED (pack-registry): a two-layer chain where the only other copy sits in the base layer is
   found there (base-first order); a copy in both layers is served from the base layer.
8. GUARD (pack-registry): `lookup(X)` with B deleted still returns `undefined` when A is
   midx-claimed (first read keeps git's false negative).

### Gate
```
npx vitest run --project unit test/unit/application/primitives/pack-registry.test.ts test/unit/application/primitives/internal \
&& npx vitest run --project integration test/integration/alternates-interop.test.ts test/integration/alternates-stream-interop.test.ts \
&& npm run check:types \
&& ./node_modules/.bin/biome check src/application/primitives/internal/midx-binding.ts src/application/primitives/pack-registry.ts test/unit/application/primitives/pack-registry.test.ts \
&& npm run check:spelling
```
midx-fsck-interop stays red on its F1 literals until Part 11, so it is not in the gate. Run it
once outside the gate (output to a scratch file) and confirm its failure list did not grow.

### Commit
`feat(pack-registry): find an object whose midx owner pack cannot be opened`

## Part 10 — the second read recovers an object whose midx owner pack is gone

### Context
- Edits (P-D3 (a)): call `lookupOwnerUnavailable` from each second-read attempt, after its
  ordinary retry missed.
  - `src/application/primitives/object-resolver.ts`: the `retryOnceAfterRescan` closure at
    L318 calls `tryResolveViaSources(…)`. On `undefined`, try each source's
    `registry.lookupOwnerUnavailable(id)`, then resolve through `resolvePackChain` the same
    way the per-source arm at L390 does.
  - `src/application/primitives/has-object.ts`: `hasObject(ctx, id, options = QUICK)`
    (L45–57). Only the `'recheck'` path (L54) consults the recovery. `'quick'` returns false
    first (git's QUICK keeps the false negative).
  - `src/application/primitives/internal/blob-source.ts`: the closures at L222 (`locate`)
    and L391 (`probe` via `readDeclaredObjectHeader`). Add the recovery after each miss.
  - `test/unit/application/primitives/object-resolver.test.ts`
  - `test/unit/application/primitives/has-object.test.ts`
  - `test/unit/application/primitives/internal/blob-source.test.ts`
- Read-only: src/application/primitives/internal/retry-after-rescan.ts
  (`retryOnceAfterRescan(ctx, store, missedId, attempt)`) and pack-miss-rescan.ts
  (`rescanOnFullMiss`).
- A shared helper `ownerUnavailableHit(store, id)` belongs in one of these files or in
  retry-after-rescan.ts. If it lands in retry-after-rescan.ts, that file becomes an edit and
  the part splits: escalate rather than exceed six files.

### TDD steps
1. RED (object-resolver): `readObject(ctx, X)` with the owner B fully deleted resolves A's
   copy. Today `OBJECT_NOT_FOUND`.
2. GREEN: object-resolver closure.
3. RED (has-object): `hasObject(ctx, X, { mode: 'recheck' })` → true. Today false.
4. GREEN: has-object.
5. GUARD (has-object): `hasObject(ctx, X)` (quick) stays false. It passes because quick
   returns before the retry.
6. RED (blob-source): the streamed read of X with B's `.pack` deleted and its `.idx` kept
   yields A's bytes. Today `OBJECT_NOT_FOUND`.
7. GREEN: blob-source, both closures (one RED each: the header-probe arm gets its own RED
   with B's `.pack` at mode 000).

### Gate
```
npx vitest run --project unit test/unit/application/primitives/object-resolver.test.ts test/unit/application/primitives/has-object.test.ts test/unit/application/primitives/internal/blob-source.test.ts test/unit/application/primitives/pack-registry.test.ts \
&& npx vitest run --project integration test/integration/alternates-interop.test.ts test/integration/alternates-stream-interop.test.ts test/integration/fetch-head-interop.test.ts \
&& npm run check:types \
&& ./node_modules/.bin/biome check src/application/primitives/object-resolver.ts src/application/primitives/has-object.ts src/application/primitives/internal/blob-source.ts test/unit/application/primitives/object-resolver.test.ts test/unit/application/primitives/has-object.test.ts test/unit/application/primitives/internal/blob-source.test.ts \
&& npm run check:spelling
```
alternates-acceleration keeps one F11 red row until Part 23, so it is not in the gate. Run it
once outside the gate and confirm its failure list did not grow.

### Commit
`fix(read-object): recover an object whose midx owner pack is gone on the second read, as git 2.56 does`

## Part 11 — midx interop: reads, precedence and fsck rows re-pinned to 2.56

### Context
- Edits (re-pin; the code landed in Parts 2, 9 and 10):
  - `test/integration/midx-interop.test.ts`: the 4 red rows under 'the midx is
    authoritative for the packs it names':
    - 'Given the assigned pack fully deleted (.pack + .idx + .rev)';
    - 'Given the assigned pack's .pack deleted but its .idx kept';
    - 'Given the assigned pack's .pack made unreadable via chmod 000';
    - 'flat vs chain precedence' > 'Given an unparseable (Tier-B, too-small) flat midx
      alongside an intact chain whose layer-1 pack was deleted' (L1266).
    - `missing` → the read succeeds: batch-check `<X> blob 4`, `cat-file -p` 0, `-e` 0.
    - The "documented divergence" row h5 (L821) is re-judged to "both read", default path
      only (`core.multiPackIndex=false` stays out of scope).
    - Retitle the describe: the midx is no longer "authoritative" on an owner it cannot open.
  - `test/integration/midx-fsck-interop.test.ts`: the 17 red rows (BASE and CHAIN), all
    "fsck gains bit 32" → git 2.56's exit (`+0` is git's when bit 32 was the only bit).
    - Assert the 2.56 exits. Rename "gains bit 32" titles to the observed exit.
    - The connectivity fallout in the 'midx-named pack fully deleted' rows follows git 2.56
      byte for byte, now that the recovery from Parts 9 and 10 is in.
- Read-only: test/integration/midx-fixture-helpers.ts.

### TDD steps
1. GUARD-sweep: run both suites and list each red row's first failing assertion. Only
   literal/expectation failures are expected. A tsgit-side drift is a code gap in Parts 9–10:
   escalate.
2. Re-pin midx-interop (4 rows + h5); re-run.
3. Re-pin midx-fsck (17 rows); re-run.

### Gate
```
npx vitest run --project integration test/integration/midx-interop.test.ts test/integration/midx-fsck-interop.test.ts test/integration/alternates-interop.test.ts test/integration/alternates-stream-interop.test.ts test/integration/fsck-interop.test.ts \
&& npm run check:types \
&& ./node_modules/.bin/biome check test/integration/midx-interop.test.ts test/integration/midx-fsck-interop.test.ts \
&& npm run check:spelling
```

### Commit
`test(midx): pin the owner-unavailable reads and midx fsck rows to git 2.56`

## Part 12 — stash apply/pop: git 2.56 exits 128 on every non-conflict failure

### Context
- Edits:
  - `src/application/commands/stash.ts`: the `reportApply` docblock (L1358) says "Leaving a
    stashed path unwritten is a failure, as git exits 1 there". Rewrite it: git exits 128;
    1 is reserved for a conflict. The return shape is unchanged (ADR-1109): a conflict with
    `untrackedNotRestored` is git's 128 case. No logic change.
  - `test/integration/stash-apply-index-judge-interop.test.ts` (82 red rows; every row's git
    exit is now 128 where the row says 1):
    - L625 and L635 (`refuses`, `unclean`) → 128. L644 (`merge-conflicts`) stays 1.
    - Also L682 and L719: check each against git.
    - Row families: H2, delete, add-add, add-same, adjacent, offset-top, same-change,
      staged-*, w-is-b-staged, symlink-c, delete-symlink-c, binary-*, attr-driver-*,
      attr-no-diff, c-lacks, create-df(-two), gitlink-differ, index-order, non-overlap-kept;
      the hostile-entry rows (base-only, duplicate-name, duplicate-over-file,
      duplicate-over-moved-file, invalid-name); and 'a staged stash and an unborn HEAD'.
      Each runs once for apply --index and once for pop --index.
  - `test/integration/stash-apply-type-change-interop.test.ts` (82 red rows: DF -u, DFa,
    DL*, DLa*, FD -u, FU -u, LD -u, UP -u):
    - `git.exit` 1 → 128 at L164, L188 (`RESTORE_STOPPED`), L210 (`REFUSED`), L254 and L259;
    - `CONFLICTED` (L211) stays 1, **except** `conflictedWith(...)` (L213: a conflict plus an
      unrestored untracked path). git 2.56 gives 128 there. Build it from
      `{ ...CONFLICTED, git: { exit: 128, autoMerge: true } }`;
    - the tsgit side asserts `kind: 'conflict'` with `untrackedNotRestored` set.
  - `docs/adr/1096-stash-apply-reports-an-unrestored-untracked-tree-with-its-own-code.md`
  - `docs/adr/1097-a-stash-merge-refusal-or-conflict-carries-the-unrestored-untracked-tree.md`
  - `docs/adr/1101-stash-apply-index-refuses-an-index-side-conflict-before-any-write.md`
  - For all three ADRs, amend "exits 1" prose to git 2.56's 128 (conflict-only 1). These are
    amendments, not supersessions.
- Pinned 2.56 exits (design F3; stderr identical to 2.55):
  - apply conflict 1;
  - pop conflict 1;
  - would-overwrite 128;
  - `--index` index conflict 128;
  - `-u` untracked occupant 128;
  - conflict + untracked occupant 128;
  - `apply stash@{3}` missing 128;
  - drop/show with no entries 128.

### TDD steps
1. GUARD-sweep: run both suites and confirm each red row fails only on `expected 128 to be 1`.
2. Re-pin index-judge; re-run.
3. Re-pin type-change: `REFUSED`, `RESTORE_STOPPED`, L164/254/259, then `conflictedWith`
   rows to 128; re-run.
4. Docblock + ADR amendments.

### Gate
```
npx vitest run --project unit test/unit/application/commands/stash \
&& npx vitest run --project integration test/integration/stash-apply-index-judge-interop.test.ts test/integration/stash-apply-type-change-interop.test.ts test/integration/stash-apply-index-interop.test.ts \
&& npm run check:types \
&& ./node_modules/.bin/biome check src/application/commands/stash.ts test/integration/stash-apply-index-judge-interop.test.ts test/integration/stash-apply-type-change-interop.test.ts \
&& npm run check:spelling
```

### Commit
`test(stash): pin apply and pop failures to git 2.56's exit 128`

## Part 13 — stash push, porcelain and gitlink-consumer rows: exit 128

### Context
- Edits:
  - `test/integration/stash-push-reset-interop.test.ts`: L63
    `const GIT_REFUSAL_EXIT = 1` → 128. This covers 8 rows: 'Given an index holding stages
    1-3 of f' and 'Given an index holding stages 2-3 of n', each × plain / include-untracked /
    keep-index; plus 'Given a merge left conflicted on f' and '… and a stat-drifted clean
    entry'. Keep the lesson-018 stat-drift arrangement untouched.
  - `test/integration/stash-interop.test.ts` (32 red rows):
    - L337, L397, L426 and L671 → 128;
    - L622–626 `stashPushOutcome`: the beyond-symlink tolerance accepts 128
      (`run.exitCode === 128 && /beyond a symbolic link/`);
    - the occupant describe (L500 on): 22 rows, S1/add, S1/update, S3a/add, S3d/add,
      S3d/update, S3g/update, S3h/update, S3j/update, D5/delete, S3e/add and D1/delete, each
      for apply and for pop. Do not run the refused git command through a throwing `runGit`.
      Use `tryRunGitWithExit` (test/integration/interop-helpers.ts) and assert its `exitCode`
      (128 on refusal, 1 on a conflict);
    - the snapshot rows 'S3a' / 'S3e' × same / reset-updates / reset-adds, and 'a merge left
      conflicted on f, a stash and a stat-drifted clean entry';
    - the line-ending rows (core.safecrlf lossy ×2, filter "u" required = foo).
  - `test/integration/gitlink-consumers-interop.test.ts`:
    - L289 `REFUSED_EXIT_STATUS = 1` is shared with the non-stash commands that
      `refusedStep` (L310–322) drives. Add `STASH_REFUSED_EXIT_STATUS = 128` and route only
      the two stash rows to it: 'Given a tracked path whose leading directory became a
      symlink, stash push' and '… stash push -u'. Pass it as a parameter of `refusedStep`.
    - `REFUSED_EXIT_STATUS` (1) and `CONFLICT_EXIT_STATUS` (L63, 1) stay for every other row.
  - `docs/use/commands/stash.md`: refusal/exit wording. Git exits 1 only for a merge
    conflict and 128 for every other failure. tsgit's data shape is unchanged; a `conflict`
    with `untrackedNotRestored` is git's 128.
  - `docs/adr/1091-path-restore-and-stash-push-refuse-and-log-as-git-does.md`
  - `docs/adr/1092-stash-push-opens-with-git-s-index-refresh-and-write.md`
  - For both ADRs, amend the "exits 1" prose.
- Pinned 2.56 (design F3): push on an unmerged index 128 `error: could not write index`;
  beyond-symlink 128 (three lines); `core.safecrlf` lossy 128; `stash branch <existing>` 128.

### TDD steps
1. GUARD-sweep: run the three suites and confirm the failure shapes above.
2. Re-pin stash-push-reset (one constant); re-run.
3. stash-interop: switch the occupant rows to `tryRunGitWithExit` (RED: with the 2.56 exit
   asserted, the throwing `runGit` crashes the row; GREEN after the switch), then the
   literals and the tolerance.
4. gitlink-consumers: the split constant; re-run, and confirm the non-stash rows still
   assert 1.
5. Docs + ADR amendments.

### Gate
```
npx vitest run --project integration test/integration/stash-interop.test.ts test/integration/stash-push-reset-interop.test.ts test/integration/gitlink-consumers-interop.test.ts \
&& npm run check:types \
&& ./node_modules/.bin/biome check test/integration/stash-interop.test.ts test/integration/stash-push-reset-interop.test.ts test/integration/gitlink-consumers-interop.test.ts \
&& npm run check:spelling
```

### Commit
`test(stash): pin push and porcelain refusals to git 2.56's exit 128`

## Part 14 — gitfile that names an invalid repository: new error code, raised by gitlink-head

> Landed together with Part 15 as one commit. The pre-commit hook's related-tests run reaches
> `test/unit/application/commands/add-gitlink.test.ts` (12 rows, omitted from both context
> blocks) and `submodule-state.test.ts` as soon as `shown` becomes the gitfile path, so this
> part could not commit on a green hook before Part 15's throwers switched. The commit also
> exports `Broken` and a shared `brokenCheckoutRefusal(checkout)` from `gitlink-head.ts`.

### Context
- **Public surface:** `GITFILE_NOT_A_REPOSITORY { path }` is a new member of the public error
  union (ADR-1110). Gates paid in this part:
  - the union member and constructor `gitfileNotARepository(path: FilePath): TsgitError`;
  - the message switch;
  - the exhaustiveness fixture.

  Gates paid in Part 17: the docs/use/errors.md row and the reports/api.json regen
  (`npm run docs:json`, a prepush gate).
- Edits:
  - `src/domain/repository/error.ts`: the union (L5–7 holds `NOT_A_REPOSITORY` and
    `GITFILE_TOO_LARGE { path: FilePath }`) and the constructors (L28, L34). Add the new
    member and `gitfileNotARepository`.
  - `src/domain/error.ts`: the message switch near L441–446. Add
    `case 'GITFILE_NOT_A_REPOSITORY': return \`gitfile does not point to a valid repository: ${data.path}\``.
  - `test/unit/domain/repository/error.test.ts`: the constructor and message tests.
  - `test/unit/domain/exhaustiveness.ts`: add the case beside `GITFILE_TOO_LARGE` (L95).
  - `src/application/primitives/internal/gitlink-head.ts` (P-D6 (a)):
    - `type GitlinkCheckout` (L49–60): `broken` gains `via: CheckoutVia`; `CheckoutVia` is
      `'directory' | 'gitfile'` (L39).
    - `broken(shown)` (L65) takes `via`.
    - `gitfileCheckout` (L326–345): the located gitfile's `shown` becomes `dotGit` (the
      gitfile path, `<path>/.git`), not the pointer. The pointer-parse failure arm
      `broken(dotGit)` (L332) keeps `NOT_A_REPOSITORY`. Give `Broken` its own union
      (`'directory' | 'gitfile' | 'unparsed-gitfile'`) rather than reuse `'directory'`; no red
      row pins git's `invalid gitfile format` line, so its data stays as is.
    - Callers of `broken(...)`: L97 and L101 (`probeGitlinkCheckout`), L161 and L163
      (`reaching`).
    - `gitlinkHeadOf` (L73–83) throws `gitfileNotARepository(checkout.shown)` when
      `via === 'gitfile'`, else `notARepository(checkout.shown)`.
  - `test/unit/application/primitives/internal/gitlink-head.test.ts`: the refusal-data rows.
- Pinned 2.56 bytes: every gitfile route (target missing, absolute pointer to nothing, module
  HEAD garbage, `commondir` naming nothing, module without objects dir) → exit 128
  `fatal: gitfile does not point to a valid repository: sub/.git`. The directory and symlink
  routes keep `fatal: 'sub/.git' not recognized as a git repository`.

### TDD steps
1. RED (repository error.test): `gitfileNotARepository('sub/.git')` carries
   `{ code: 'GITFILE_NOT_A_REPOSITORY', path: 'sub/.git' }` and the message above. Fails
   because there is no constructor.
2. GREEN: union, constructor, message, exhaustiveness case.
3. RED (gitlink-head): `gitlinkHeadOf` over a gitfile whose target is missing rejects with
   `{ code: 'GITFILE_NOT_A_REPOSITORY', path: 'sub/.git' }`. Today `NOT_A_REPOSITORY` with
   `sub/../.git/modules/sub`.
4. RED (gitlink-head): a gitfile to a module whose HEAD is garbage → the same data. One RED
   per producing branch: `isUsableHead`, `holdsObjectsAndRefs`, and both `reaching` arms
   (empty `commondir`, unnameable).
5. GREEN: `via` on `broken`, `shown` = gitfile path, the thrower switch.
6. GUARD (gitlink-head): a `.git` directory with garbage HEAD still gives
   `NOT_A_REPOSITORY { path: 'sub/.git' }`. It passes because the directory route's `shown`
   was already `dotGitShown`.
7. GUARD (gitlink-head): an unparseable gitfile still gives `NOT_A_REPOSITORY`.

### Gate
```
npx vitest run --project unit test/unit/domain test/unit/application/primitives/internal/gitlink-head.test.ts test/unit/application/commands/status-gitlink.test.ts test/unit/application/commands/rm.test.ts \
&& npm run check:types \
&& ./node_modules/.bin/biome check src/domain/repository/error.ts src/domain/error.ts test/unit/domain/repository/error.test.ts test/unit/domain/exhaustiveness.ts src/application/primitives/internal/gitlink-head.ts test/unit/application/primitives/internal/gitlink-head.test.ts \
&& npm run check:spelling
```

### Commit
`fix(gitlink): name the gitfile when it points to no valid repository, as git 2.56 does`

## Part 15 — submodule throwers raise the gitfile refusal; add and status rows re-pinned

### Context
- Edits:
  - `src/application/commands/internal/submodule-absorb.ts`: L128–133.
    `if (checkout.kind === 'broken' && (await dotGitShapeOf(ctx, path)) === 'file') throw notARepository(checkout.shown)`
    → throw `gitfileNotARepository(checkout.shown)` for `via === 'gitfile'`.
  - `src/application/commands/internal/submodule-state.ts`: L71–73.
    `if (checkout.kind === 'broken') throw notARepository(checkout.shown)` → the same
    `via` switch.
  - `test/unit/application/commands/internal/submodule-absorb.test.ts`
  - `test/unit/application/commands/internal/submodule-state.test.ts`
  - In both suites, assert the new refusal data for a gitfile, and the old code for a .git
    directory.
  - `test/integration/add-gitlink-interop.test.ts`:
    - L866 `toMatchObject({ code: 'NOT_A_REPOSITORY' })` → the new code;
    - L867 `line(refusal.path…)` rebuilds `fatal: gitfile does not point to a valid
      repository: ${path}`;
    - 11 rows under 'add over a gitlink whose submodule checkout moved': 'a pointer to a
      gitdir that does not e…', 'a module whose HEAD is garbage', 'an absolute pointer to
      nothing', and the 'a commondir naming …' rows (nothing, the filesystem root, an empty
      directory, a directory with r…, a directory with o…, a regular file).
  - `test/integration/status-gitlink-interop.test.ts`: L952 `gitMessage` for 'a gitfile
    naming a missing module dir…', 'a module HEAD that is garbage' and 'a module without its
    objects directory'.
- Read-only: compare-working-tree-entry.ts L265, embedded-repository.ts L27 and
  refname-ambiguity.ts L70. They read `kind === 'broken'` only and are unaffected.

### TDD steps
1. RED (submodule-state): a gitfile to a missing module dir rejects with
   `GITFILE_NOT_A_REPOSITORY { path: 'sub/.git' }`. Today `NOT_A_REPOSITORY`.
2. GREEN: submodule-state.
3. RED (submodule-absorb): the same over the absorb path.
4. GREEN: submodule-absorb.
5. GUARD (both): a `.git` directory keeps `NOT_A_REPOSITORY`.
6. Re-pin add-gitlink and status-gitlink (RED on old wording → GREEN).

### Gate
```
npx vitest run --project unit test/unit/application/commands/internal/submodule-state.test.ts test/unit/application/commands/internal/submodule-absorb.test.ts test/unit/application/primitives/internal/gitlink-head.test.ts \
&& npx vitest run --project integration test/integration/add-gitlink-interop.test.ts test/integration/status-gitlink-interop.test.ts test/integration/gitlink-consumers-interop.test.ts test/integration/submodule-init-sync-deinit-interop.test.ts test/integration/submodules.test.ts \
&& npm run check:types \
&& ./node_modules/.bin/biome check src/application/commands/internal/submodule-absorb.ts src/application/commands/internal/submodule-state.ts test/unit/application/commands/internal/submodule-absorb.test.ts test/unit/application/commands/internal/submodule-state.test.ts test/integration/add-gitlink-interop.test.ts test/integration/status-gitlink-interop.test.ts \
&& npm run check:spelling
```

### Commit
`fix(submodule): refuse a gitfile to an invalid repository with its own code, as git 2.56 does`

## Part 16 — branch delete checks the bisect hold first

### Context
- **Public surface:** `BRANCH_CHECKED_OUT` gains `hold: 'checkout' | 'bisect'` (ADR-1115). It
  is additive. The docs/use/errors.md row, docs/use/commands/branch.md and the
  reports/api.json regen are paid in Part 17.
- Edits:
  - `src/domain/worktree/error.ts`: the union L6
    `{ code: 'BRANCH_CHECKED_OUT'; branch: string; path: string }` and
    `branchCheckedOut(branch, path)` (L24). Add `hold`. Make the constructor take
    `hold: BranchHold`, with a named type alias (not a boolean). The message in
    src/domain/error.ts L782 is unchanged.
  - `src/application/commands/internal/checked-out-branches.ts`
    - Add the exported `worktreeBisecting(ctx, name): Promise<FilePath | undefined>`. It
      walks `listWorktrees` in order and returns the **first** worktree whose
      `bisectingBranch(ctx, adminDirOf(ctx, wt))` equals `name`.
    - Bare worktrees are skipped, as in `branchesHeldBy`.
    - `heldBranches` (L103) and `worktreeHolding` (L112) are unchanged (fetch.ts uses them).
  - `src/application/commands/branch.ts`
    - `assertNoWorktreeHolds(ctx, name)` (L186–189) is used by the forced create (L233) and
      by delete (L307).
    - Delete: first `worktreeBisecting` → `branchCheckedOut(name, path, 'bisect')`, then
      `worktreeHolding` → `'checkout'`.
    - Forced create: `'checkout'` only (P-D4 (a)). Split into two named helpers rather than
      a flag parameter.
  - `src/application/commands/worktree.ts`: L159 `branchCheckedOut(branchRef, used.path)`
    → `'checkout'`.
  - `test/unit/application/commands/internal/checked-out-branches.test.ts`
  - `test/unit/application/commands/branch.test.ts`
- Pinned 2.56 bytes:
  - linked worktree bisecting `sidecar` (HEAD still on it) →
    `error: cannot delete branch 'sidecar' used by worktree at '<B>/wt' for bisect`;
  - main worktree bisecting with HEAD detached → `… at '<B>/r' for bisect`;
  - plain checkout → no suffix.

### TDD steps
1. RED (checked-out-branches): `worktreeBisecting` returns the first of two bisecting
   worktrees. Fails: no export.
2. GREEN.
3. RED (checked-out-branches): a bare main checkout is skipped; a worktree without
   `BISECT_LOG` is skipped (one test each).
4. RED (branch): `branchDelete` on a branch a linked worktree is bisecting rejects with
   `{ code: 'BRANCH_CHECKED_OUT', branch, path, hold: 'bisect' }`. Today there is no `hold`.
5. RED (branch): one worktree has `sidecar` checked out and a later one is bisecting it;
   delete reports the bisecting worktree with `'bisect'`. Today the checkout-holder wins
   (last registration).
6. GREEN: delete helper, `hold` field, constructor change.
7. RED (branch): a forced `branchCreate` over a bisect-held branch reports `hold: 'checkout'`.
8. GREEN: create helper. Update worktree.ts L159.

### Gate
```
npx vitest run --project unit test/unit/application/commands/internal/checked-out-branches.test.ts test/unit/application/commands/branch test/unit/application/commands/worktree test/unit/domain \
&& npx vitest run --project integration test/integration/branch-delete-peel-interop.test.ts test/integration/branch-delete-upstream-interop.test.ts \
&& npm run check:types \
&& ./node_modules/.bin/biome check src/domain/worktree/error.ts src/application/commands/internal/checked-out-branches.ts src/application/commands/branch.ts src/application/commands/worktree.ts test/unit/application/commands/internal/checked-out-branches.test.ts test/unit/application/commands/branch.test.ts \
&& npm run check:spelling
```

### Commit
`fix(branch): refuse deleting a bisected branch with the bisect hold first, as git 2.56 does`

## Part 17 — branch-delete row, gitlink and bisect-hold docs, error catalogue and api.json

### Context
- Edits (the code landed in Parts 14–16):
  - `test/integration/branch-delete-worktree-interop.test.ts`
    - `heldLine(branch, worktree)` (L45–47) gains the hold.
    - The red row is 'Given a linked worktree bisecting, its HEAD detached off the branch When
      git branch -D and tsgit branchDelete both target that branch' (L273). It rebuilds
      ` for bisect` from `hold`.
    - New row: two worktrees, one with `sidecar` checked out and a later one bisecting it.
      The bisecting path wins.
  - `docs/use/commands/branch.md` L82: `BRANCH_CHECKED_OUT` carries `hold`; delete checks
    bisect first.
  - `docs/use/commands/add.md` (L85–108 refusal section) and `docs/use/commands/status.md`
    (refusals): `GITFILE_NOT_A_REPOSITORY { path }`, where `path` is `<sub>/.git`.
  - `docs/use/errors.md`: a new `GITFILE_NOT_A_REPOSITORY | path | …` row near L269; the
    `BRANCH_CHECKED_OUT` row (L83) gains `hold`.
  - `reports/api.json`: regenerate with `npm run docs:json`. A huge typedoc-id diff is
    normal; it is a prepush gate, not a validate gate.

### TDD steps
1. RED (interop): the L273 row with ` for bisect` rebuilt from `hold` fails on today's
   expectation. Update the builder → GREEN.
2. RED → GREEN (interop): the two-worktree row (built in a throwaway under the suite's own
   fixture builder).
3. Docs rows; `npm run docs:json`; confirm `git diff --stat reports/api.json` is non-empty.

### Gate
```
npx vitest run --project integration test/integration/branch-delete-worktree-interop.test.ts test/integration/branch-delete-peel-interop.test.ts \
&& npm run check:types \
&& ./node_modules/.bin/biome check test/integration/branch-delete-worktree-interop.test.ts \
&& npm run check:spelling \
&& npm run check:doc-coverage
```

### Commit
`docs(errors): document the gitfile refusal and the bisect hold`

## Part 18 — gc reads gc.auto, gc.autoPackLimit and gc.bigPackThreshold lazily

### Context
- Edits (P-D5 (a), ADR-1111):
  - `src/application/primitives/internal/gc-config-guard.ts`
    - `assertValidLeadingGcConfig` (L37) loses `auto` and `autoPackLimit`.
    - `assertValidTrailingGcConfig` (L44) loses `bigPackThreshold`.
    - Add `assertValidGcAutoConfig(ctx)`, which validates `auto` then `autoPackLimit` in
      that order, and `assertValidBigPackThreshold(ctx)`.
    - All internal.
  - `src/application/commands/internal/gc-pipeline.ts`
    - `readGcSettings(ctx): Promise<GcSettings>` (L130) stops reading the three lazy keys.
      `GcSettings.autoThreshold` (L113) moves out: `runGcTask` reads it after validation.
    - `runGcTask(ctx, opts)` (L1046): when not `auto`, call `assertValidGcAutoConfig` first;
      under `auto`, the caller already validated.
    - `repack(run)` (L1065) starts with `assertValidBigPackThreshold`.
    - Rewrite the L121–129 docblock: four keys stay eager, three lazy.
  - `src/application/commands/maintenance.ts`
    - `runGcStep(ctx, opts, settings)` (L145–152): when `opts.auto === true`, call
      `assertValidGcAutoConfig` **before** `failureOr`, so the refusal is thrown.
    - Non-auto refusals land in `tasksFailed` through the existing `failureOr` (L270–281)
      as `{ task: 'gc', code, data }`.
    - Rewrite the `maintenance` docblock (L195–203; it pins 2.55).
  - `test/unit/application/primitives/internal/gc-config-guard.test.ts`
  - `test/unit/application/commands/maintenance-task-failure.test.ts`
- Pinned 2.56 (design F5a). Cells are `gc --auto` / `maintenance --task=commit-graph` /
  `maintenance --task=gc`:
  - `gc.auto=bogus` → 128 / 0 / 1;
  - `gc.autoPackLimit=3g` → 128 / 0 / 1;
  - `gc.bigPackThreshold=-0` → 0 (declining gate) / 0 / 1;
  - cruftPacks, pruneExpire, worktreePruneExpire, logExpiry → 128 everywhere.
  - Each `--task=gc` failure prints the fatal line, then `error: task 'gc' failed`.
  - With `gc.auto=bogus`, both task orders exit 1 and still write the commit-graph chain.

### TDD steps
1. RED (gc-config-guard): `assertValidLeadingGcConfig` with `gc.auto=bogus` resolves. Today
   it rejects with `CONFIG_BAD_NUMERIC_VALUE`.
2. GREEN: split. RED/GREEN `assertValidGcAutoConfig` (one test per key, plus order: both bad
   → `gc.auto` named). Then `assertValidBigPackThreshold`.
3. RED (maintenance): `maintenance(ctx, { tasks: ['commit-graph'] })` with `gc.auto=bogus`
   writes the graph. Today it rejects.
4. RED (maintenance): `{ tasks: ['gc'] }` with `gc.auto=bogus` resolves with
   `tasksFailed: [{ task: 'gc', code: 'CONFIG_BAD_NUMERIC_VALUE', data }]`. Today it rejects.
5. RED (maintenance): `{ tasks: ['gc', 'commit-graph'] }` with `gc.auto=bogus` → `gc` failed
   and commit-graph ran. Same for the reverse order.
6. RED (maintenance): `{ tasks: ['gc'], auto: true }` with `gc.autoPackLimit=3g` rejects
   (thrown).
7. RED (maintenance): `{ tasks: ['gc'], auto: true }` with `gc.bigPackThreshold=-0` on a
   tiny repo declines without error.
8. RED (maintenance): `{ tasks: ['gc'] }` (non-auto) with `gc.bigPackThreshold=-0` → a
   `tasksFailed` entry from the pack step.
9. GREEN per RED, in the order above.

### Gate
```
npx vitest run --project unit test/unit/application/primitives/internal/gc-config-guard.test.ts test/unit/application/commands/maintenance \
&& npm run check:types \
&& ./node_modules/.bin/biome check src/application/primitives/internal/gc-config-guard.ts src/application/commands/internal/gc-pipeline.ts src/application/commands/maintenance.ts test/unit/application/primitives/internal/gc-config-guard.test.ts test/unit/application/commands/maintenance-task-failure.test.ts \
&& npm run check:spelling
```
maintenance-interop is re-pinned in Part 19; its gc-config rows flip here and are read
there.

### Commit
`fix(gc): read gc.auto, gc.autoPackLimit and gc.bigPackThreshold lazily, as git 2.56 does`

## Part 19 — maintenance interop: lazy gc keys, the gc failure cascade and in-window fsck rows

### Context
- Edits:
  - `test/integration/maintenance-interop.test.ts`
    - The table at L837–883: the commit-graph run expects git 0 and tsgit success for
      `gc.auto`, `gc.autoPackLimit` and `gc.bigPackThreshold`. It keeps 128 and the typed
      refusal for the other four.
    - The `gc --auto` run expects 0 (declined) for `gc.bigPackThreshold=-0`.
    - Add a third run, `maintenance run --task=gc` (`opts: { tasks: ['gc'], auto: false }`):
      git exit 1 and stderr ending `error: task 'gc' failed\n`; tsgit `tasksFailed[0]`
      carries the code for the three lazy keys. The other four keys stay thrown (128).
    - Add both task orders for `gc.auto=bogus`: exit 1, and the commit-graph chain written by
      both tools.
    - Retitle 'Then both refuse before any task' per run.
    - Cascade reconstructions (ADR-1112, D-F5b): L2327 and L2427 change
      `fatal: failed to run repack\nerror: task 'gc' failed\n` to
      `error: failed to run (null)\nerror: task 'gc' failed\n`. L2447 (`git gc`, exit 128)
      changes `…fatal: failed to run repack\n` to `…error: failed to run (null)\n`.
    - The two in-window rows ('Given a reachable in-window size-lying loose blob …' and
      'Given a unreachable and unexpired in-window size-lying loose blob …', "fsck flags it")
      change 4 → 1.
  - `docs/use/commands/maintenance.md`: the config-validation section. Seven keys; four are
    read eagerly and three lazily, at git 2.56's read points; a lazy-key failure inside the
    gc task is a `tasksFailed` entry. (No `gc.md` page exists.)
- The red row titles to re-pin:
  - 'Given a malformed …', When 'the commit-graph maintenance task alo…', for each lazy key;
  - 'gc --auto under a declining gate' for `gc.bigPackThreshold=-0`;
  - 'Given a tree listing a blob as a subtree When both tools run the gc task, then the
    commit-graph task';
  - the four 'gc over a size-lying loose blob' cascade rows;
  - the two in-window rows.

### TDD steps
1. GUARD-sweep: run the suite and confirm 11 red rows of the shapes above (Part 18 already
   flipped the tsgit side of the config rows).
2. Re-pin the table and add the `--task=gc` run (RED on the old two-run shape → GREEN).
3. Add the task-order rows.
4. Cascade bytes; in-window literals.
5. maintenance.md.

### Gate
```
npx vitest run --project integration test/integration/maintenance-interop.test.ts test/integration/alternates-gc-fsck-interop.test.ts test/integration/fsck-interop.test.ts test/integration/midx-fsck-interop.test.ts \
&& npm run check:types \
&& ./node_modules/.bin/biome check test/integration/maintenance-interop.test.ts \
&& npm run check:spelling
```

### Commit
`test(maintenance): pin the lazy gc keys and git 2.56's gc failure cascade`

## Part 20 — rebase does not record a dropped pick as rewritten

### Context
- Edits:
  - `src/application/commands/rebase.ts`: `advanceFlat(ctx, rc, index, outcome, flat)`
    (L761). `case 'empty'` (L774–778) pushes `[pick.oid, flat.cur]` into `flat.rewritten`.
    Drop the push, keep `await removeAutoMerge(ctx)`, and fix the L774 comment.
    `grep -n "'empty'" src/application/commands/rebase.ts` shows this arm only (L216 is the
    type, L410 the producer). Confirm the interactive replay's drop goes through the same
    arm; if a second arm exists, it gets its own RED.
  - `test/unit/application/commands/rebase.test.ts`
  - `test/integration/rebase-interop.test.ts`
    - The red row is 'Given a flat rebase line refused by an untracked occupant When a
      fast-forward pick is the refused line Then HEAD stays and the dropped pick is recorded
      as git records it' (L1626–1650). The L1648 snapshot goes green with no edit. Retitle
      it: the dropped pick is not recorded.
    - Add an interactive drop row: a dropped pick followed by a refused line.
  - `docs/use/commands/rebase.md`: state-file notes. A pick dropped as already-upstream is
    not written to `rewritten-list`.
- Pinned 2.56 (design F10): `rebase --onto W base` → `dropping <W> W -- patch contents
  already upstream`, then the refusal, exit 1, and no `rewritten-list`.
- Control: `rebase -i --no-ff base` writes `rewritten-list` = `<HEAD> <HEAD>` on both
  versions. This control is a GUARD.

### TDD steps
1. RED (interop): the L1626 row (already red: git writes no `rewritten-list`, tsgit does).
2. RED (unit): `rebase.run` with a first pick that empties and a refused second line leaves
   no `rewritten-list` entry for the dropped pick. Today it records `<pick> <HEAD>`.
3. GREEN: drop the push.
4. RED → GREEN (interop): the interactive drop row, if it fails before GREEN. If it already
   passes after GREEN, record it as a GUARD.
5. GUARD: the `-i --no-ff` control row still records the fast-forward pick.

### Gate
```
npx vitest run --project unit test/unit/application/commands/rebase \
&& npx vitest run --project integration test/integration/rebase-interop.test.ts test/integration/rebase-start-interop.test.ts test/integration/rebase-stop-messages-interop.test.ts test/integration/rebase-merges-interop.test.ts test/integration/rebase-autostash-interop.test.ts test/integration/rebase-reset-interop.test.ts test/integration/pull-rebase-interop.test.ts \
&& npm run check:types \
&& ./node_modules/.bin/biome check src/application/commands/rebase.ts test/unit/application/commands/rebase.test.ts test/integration/rebase-interop.test.ts \
&& npm run check:spelling
```

### Commit
`fix(rebase): stop recording a dropped pick as rewritten, as git 2.56 does`

## Part 21 — merge-base follows git 2.56's paint queue

### Context
- Before RED: read commit-reach.c at tag v2.56.0 (`paint_queue_put`, `paint_queue_get`,
  `paint_down_to_common`, L79–275). Fetch it into the scratchpad. If it cannot be fetched,
  escalate; do not port from memory.
- Edits:
  - `src/application/primitives/merge-base.ts`:
    - `comparatorFor` (L277–278) always returns `byGenerationThenDate`. `byDate` (L199) stays,
      as the tie-break inside it.
    - `hasNonStale` (L173–176) is deleted.
    - `makePaintQueue(read, precedes)` (L290–330) keeps P1-only, P2-only and both
      counters plus a candidate counter. A queued non-stale entry counts in exactly one
      bucket. On `mark` of an already-queued id whose bits change, move it between buckets
      (`paint_queue_put`).
    - `pop` returns `undefined` when no candidate is queued and either side's count is 0
      while the head's generation is below `topoCeiling`, or when both sides are empty
      (`paint_queue_get`; confirm the exact generation operand from the source).
    - `visit` (L338–358): the `!findAll` break uses `entry.generation < options.topoCeiling`.
    - `PaintOptions` (L205–212) gains `topoCeiling: number`:
      `correctedCommitDates ? GENERATION_INFINITY : GENERATION_NUMBER_V1_MAX`. Build it once
      where `correctedCommitDates` is resolved (L404, L456, L542, L682).
  - `src/application/primitives/internal/read-commit-meta.ts`: export
    `GENERATION_NUMBER_V1_MAX = 0x3fffffff` beside `GENERATION_INFINITY` (L18).
  - `src/application/commands/internal/fsck/commit-graph-verify.ts`: delete the private
    L40 constant and import it. (src/domain/commit/commit-graph-writer.ts L265
    `MAX_TOPOLOGICAL_LEVEL` stays: domain cannot import application.)
  - `test/unit/application/primitives/merge-base.test.ts`
  - `test/integration/merge-base-interop.test.ts`: the red row 'Given a commit-graph written
    with commitGraph.generationVersion=1 When mergeBase runs over the two tips that share both
    bases' (L618–664). L655 `toEqual([ids.get('shallow')])` → `[ids.get('deep')]`; retitle
    it, since topological levels now order the queue.
- Pinned 2.56 (design F7): no graph → `shallow` / `--all` `shallow deep`; v1 graph → **`deep`**
  / `shallow deep`; v2 → `shallow` / `shallow deep`.
- ADR-840 already carries its supersession banner; no prose edit.

### TDD steps
1. RED (interop): the v1 row expects `deep`. tsgit returns `shallow`.
2. RED (unit): `mergeBase` over a v1 graph (`correctedCommitDates` false, minGeneration 0)
   pops by generation. Today it pops by date.
3. GREEN: `comparatorFor`.
4. RED (unit): side exhaustion. One side's tips are all stale-free but exhausted below the
   ceiling, and the walk stops without popping the remaining P2-only entries. Assert it
   through the read count of a counting reader.
5. RED (unit): both sides empty → stop.
6. RED (unit): a re-marked queued entry moves from P1-only to both. Assert the walk does
   not stop early on the stale P1 count.
7. GREEN: counters and the `pop` exits; delete `hasNonStale`.
8. RED (unit): `topoCeiling` break. Under v1, a base at generation ≥ V1_MAX does not stop a
   single-result walk; under v2 (INFINITY) a finite base does.
9. GREEN: `PaintOptions.topoCeiling`, the constant move, the commit-graph-verify import.
10. GUARD: merge-base.properties.test.ts and every merge-base row stay green.

### Gate
Lesson 015: every command built on `mergeBase`.
```
npx vitest run --project unit test/unit/application/primitives/merge-base test/unit/application/primitives/internal/read-commit-meta.test.ts test/unit/domain/commit/commit-graph-verify.test.ts test/unit/application/commands/fsck-commit-graph-verify.test.ts \
&& npx vitest run --project integration test/integration/merge-base-interop.test.ts test/integration/merge-interop.test.ts test/integration/merge-octopus-interop.test.ts test/integration/merge-revision-forms-interop.test.ts test/integration/rebase-interop.test.ts test/integration/rebase-start-interop.test.ts test/integration/pull-rebase-interop.test.ts test/integration/log-interop.test.ts test/integration/rev-parse-dwim-interop.test.ts test/integration/shallow-walk-interop.test.ts test/integration/bundle-interop.test.ts test/integration/fsck-commit-graph-interop.test.ts \
&& npm run check:types \
&& ./node_modules/.bin/biome check src/application/primitives/merge-base.ts src/application/primitives/internal/read-commit-meta.ts src/application/commands/internal/fsck/commit-graph-verify.ts test/unit/application/primitives/merge-base.test.ts test/integration/merge-base-interop.test.ts \
&& npm run check:spelling
```

### Commit
`fix(merge-base): follow git 2.56's paint queue and its early exits`

## Part 22 — signing strips only a CR that precedes LF

> Landed wider than planned. `hasSignatureInjectionChars`
> (`src/application/primitives/validators.ts`) rejected every CR in a `gpgSignature`, so the
> armor git 2.56 now stores could not be committed; the guard rejects NUL only, with its unit
> rows, a serializer/parser round-trip row and the create-commit caller comment in the same
> commit. The two property statements below are false for git's single-pass rule
> (`\r\r\n` → `\r\n` is neither idempotent nor free of `\r\n`); the sibling pins three true
> invariants instead: the length shrinks by exactly the count of `\r\n` pairs, the text is
> unchanged once every CR is removed, and a text without LF is returned unchanged.

### Context
- Edits:
  - `src/application/primitives/sign-payload.ts`
    - L57 `const CARRIAGE_RETURNS = /\r/g` → the CR-before-LF lookahead.
    - L61 comment (`remove_cr_after`); L62–63 `signatureText(bytes)`.
    - The L152 docblock says "every carriage return in the armor is dropped".
    - Extract and export `stripCrBeforeLf(text: string): string` (P-D7). It is internal: do
      not add it to src/application/primitives/index.ts (L96–97 export only `signPayload`
      and `resolveSigningSelector`).
  - `test/unit/application/primitives/sign-payload.test.ts`
  - `test/unit/application/primitives/sign-payload.properties.test.ts` (new; layout and
    `numRuns` per .claude/workflow/property-testing.md).
  - `docs/use/commands/commit.md`: the signing section, if it states CR handling. Grep
    first; leave the file untouched if it says nothing.
- Pinned 2.56 (design F9): armor
  `-----BEGIN PGP SIGNATURE-----\r\n\r\nab\rcd\r\nef\r\r\n-----END PGP SIGNATURE-----\r\n`
  is stored as `…\n \n ab\rcd\n ef\r\n -----END…`: a lone CR is kept, and `\r\r\n` becomes
  `\r\n`.
- A trailing `\r` at end of buffer is kept (from the source, `i + 1 < buffer->len`). Pin it
  with a canned signer in a throwaway under git 2.56 before writing that test.

### TDD steps
1. RED (unit): `stripCrBeforeLf('ab\rcd')` keeps the lone CR. Fails: no export (today
   `signatureText` drops every CR).
2. GREEN: extract `stripCrBeforeLf` with the CR-before-LF lookahead; `signatureText` calls it.
3. RED (unit): `'ef\r\r\n'` → `'ef\r\n'`. It passes after step 2: record it as a GUARD.
4. GUARD (unit): trailing `'x\r'` kept (pinned by the throwaway probe first).
5. Property sibling: idempotence (`f(f(s)) === f(s)`) and "no `\r\n` survives"
   (`!f(s).includes('\r\n')`) over strings drawn from an alphabet rich in `\r` and `\n`.
6. GUARD (interop): commit-signing rows 'Then the openpgp signature is stored without them'
   and 'Then the ssh signature is stored …' now share oids with git. Retitle "without them"
   to "with only CR before LF removed" if the title states the old rule.

### Gate
```
npx vitest run --project unit test/unit/application/primitives/sign-payload \
&& npx vitest run --project integration test/integration/commit-signing-interop.test.ts test/integration/tag-signing-interop.test.ts test/integration/config-signing-interop.test.ts \
&& npm run check:types \
&& ./node_modules/.bin/biome check src/application/primitives/sign-payload.ts test/unit/application/primitives/sign-payload.test.ts test/unit/application/primitives/sign-payload.properties.test.ts \
&& npm run check:spelling
```

### Commit
`fix(sign): strip only a carriage return before a line feed, as git 2.56 does`

## Part 23 — the bitmap closure opens sources one at a time

### Context
- Edits:
  - `src/application/primitives/internal/closure-engine.ts`: `tryBitmapClosure(ctx, request)`
    (L648–668). Today it runs three loops: `assertLoadable` over every source, then every
    source's midx bitmap, then every source's pack bitmaps. Replace them with one loop per
    source:
    ```
    for (const { registry } of sources):
      await registry.assertLoadable()
      midx bitmap of this source → answer
      else this source's pack bitmaps → answer
    ```
    Rewrite the L652–655 comment and the docblock above (L630–647).
  - `test/unit/application/primitives/internal/closure-engine.test.ts`
  - `test/integration/alternates-acceleration-interop.test.ts`
    - The red row is 'Given a borrower multi-pack-index bitmap and a donor multi-pack-index
      with a smashed signature When a bitmap-tier closure is computed over HEAD' (L496–526).
      git exits 0. tsgit answers at the bitmap tier with git's ids. Retitle it: "both answer
      from the borrower bitmap".
    - The L459 pack-bitmap row stays as it is (refuse).
- Pinned 2.56 (design F11):
  - borrower with `--write-midx --write-bitmap-index` and donor midx signature `XXXX`:
    `rev-list --objects --use-bitmap-index HEAD` → 0, and `--count` → 0;
  - `fsck --connectivity-only` → 128;
  - borrower `repack -adl --write-bitmap-index` (no bitmap written) → 128.

### TDD steps
1. RED (interop): the L496 row expects git 0 and a tsgit bitmap answer. tsgit refuses on the
   donor signature today.
2. RED (unit): the first source's midx bitmap answers before a later source's registry is
   asserted. Use a spy registry whose `assertLoadable` throws for source 2.
3. GREEN: per-source loop.
4. RED (unit): a first source with only a pack bitmap answers before a later source's midx
   bitmap is loaded.
5. GUARD (unit): no bitmap anywhere → `undefined` (walk fallback).
6. GUARD (interop): the L459 row still refuses.

### Gate
```
npx vitest run --project unit test/unit/application/primitives/internal/closure-engine.test.ts test/unit/application/primitives/internal/closure-engine-sparse.test.ts test/unit/application/primitives/internal/bitmap-binding.closure.test.ts \
&& npx vitest run --project integration test/integration/alternates-acceleration-interop.test.ts test/integration/rev-list-objects-interop.test.ts test/integration/rev-bitmap-closure-interop.test.ts test/integration/pack-sparse-interop.test.ts test/integration/packfile-interop.test.ts \
&& npm run check:types \
&& ./node_modules/.bin/biome check src/application/primitives/internal/closure-engine.ts test/unit/application/primitives/internal/closure-engine.test.ts test/integration/alternates-acceleration-interop.test.ts \
&& npm run check:spelling
```

### Commit
`fix(closure): open bitmaps source by source, as git 2.56 does`

## Part 24 — CI pins every git-spawning job to git 2.56

### Context
- Edits (ADRs 1117–1120):
  - `.github/actions/setup-git/action.yml` (new composite action).
    - One input, `version`, default `"2.56"`. This default is the single constant; jobs do
      not pass it.
    - Linux (`runner.os == 'Linux'`): `sudo add-apt-repository -y ppa:git-core/ppa`,
      `sudo apt-get update`, `sudo apt-get install -y git`.
    - macOS and Windows: no install (ADR-1118).
    - Every OS: parse `git --version` to `major.minor`. If it is not `version`, print
      `::error::expected git <version>.x, found <full git --version output>` and
      `exit 1` (ADR-1119: drift fails, 2.57 included).
    - Echo the resolved `git --version`.
    - `shell: bash` on every step, Windows included.
  - `.github/workflows/ci.yml`:
    - add `- uses: ./.github/actions/setup-git` right after `./.github/actions/setup` in
      `integration` (L362), `posix-integration` (L388) and `win-integration` (L417);
    - in `posix-integration` change `matrix.os` from `[ubuntu-latest, macos-latest]` to
      `[ubuntu-latest, macos-26]`.
  - `CONTRIBUTING.md`: the interop prerequisites. The pinned git minor (2.56), where the
    constant lives (the action's `version` default), how to bump it (change the default,
    re-pin the rows that move, one PR), and that a runner with another minor fails the job.
- Re-verify before writing (D-CI2 facts):
  - the macos-26 and windows-2025 image READMEs list git 2.56.x;
  - the git-core PPA for noble publishes a 2.56 build (Launchpad `getPublishedSources`).
  - Record the URLs read in the hand-off report, not in the repo.
- No 2.55 lane (ADR-1120).

### TDD steps
1. RED (local dry check): run the action's version-assert script body with `version: 2.55`
   against local git 2.56.0 in a throwaway. It must exit 1 and print the `::error::` line.
2. GREEN: the same body with `2.56` exits 0 and echoes the version.
3. Lint the workflow and action YAML with `npx --yes @action-validator/cli` if it can be
   reached, else `actionlint` if installed. If neither runs, state so in the hand-off report; do
   not install globally.
4. The CI proof (a run on each OS, plus one deliberate wrong-constant run on a scratch
   branch) is the orchestrator's, at the propose phase. Note it in the hand-off report.

### Gate
Copy the action's assert script into a scratch file and `bash -n` it first (step 1 already
ran it). Then:
```
npm run check:spelling
```
The gate's real proof is the CI run (step 4); the part has no `src/` delta and no vitest
surface.

### Commit
`ci: pin every git-spawning job to git 2.56 and fail on any other minor`
