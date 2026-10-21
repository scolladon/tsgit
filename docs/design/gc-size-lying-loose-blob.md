# Design — gc over a size-lying loose blob

> Brief: `gc` (the `maintenance` gc task) must treat a loose blob whose body overruns its header's size claim the way git's `gc` / `repack` / `pack-objects` do (issue #306), pinned against git 2.55.0 with interop rows.
> Status: draft → self-reviewed ×2

## Context

- **ADR-907** split loose reads into git's two tiers. The *buffered* tier (`unpack_loose_rest`)
  refuses an overrun past the 32-byte header window, truncates one inside it and serves an
  under-run's real bytes. The *streamed* tier serves the real bytes. Every whole-object consumer
  takes the buffered tier, except gc's pack builders.
- **ADR-902** keeps `readObjectMetadata` content-derived. ADR-907 carries forward ADR-863's
  streaming routes and its short-body residual. Neither ADR binds the internal
  `readObjectMetadataWithContent`. Only `build-pack.ts` and `internal/deltify.ts` call it.
- **ADR-718**: reads verify no hash by default. gc's post-write `verifyPacked` opts in
  (`verifyHash: true`). git has no such step: its `pack-objects` never re-hashes what it copies.
- **ADR-724 / 731 / 732 / 733**: the gc pipeline (`repack`: plan → write normal, promisor, cruft →
  verify → retire → prune loose → tidy). **ADR-249**: only structured data. The test rebuilds
  git's `fatal:` line from `tasksFailed[].data`. **ADR-226**: byte-faithful data and on-disk state.
- Precedent for the fault surface: `INVALID_OBJECT_HEADER` already carries an optional field
  (`headerLimit`, from `looseHeaderTooLong`). The `BAD_TREE_OBJECT` row in
  `test/integration/maintenance-interop.test.ts` rebuilds git's stderr from `tasksFailed`.

## Requirements

1. An overrun past the window that gc must read (reachable, or unreachable-unexpired with cruft
   packs on) makes the gc task fail before any durable write. No new pack is registered, no
   `.mtimes` is written, and every loose file is left untouched.
2. That failure's `tasksFailed[0].data` has the fields to rebuild git's two lines exactly:
   `error: corrupt loose object '<oid>'` and `fatal: loose object <oid> (stored in <path>) is
   corrupt`.
3. `gc.cruftPacks=false` with the liar unreachable and unexpired: the task succeeds, does not
   read the liar, and leaves it loose.
4. Unreachable and expired: pruned without being read (today's behaviour is already right; an
   interop row pins it).
5. A liar held only by an alternate: the borrower's gc succeeds.
6. The pack builders size an entry from the bytes the buffered tier yields. They never size it
   from the claim, and never take the streamed tier's real bytes.

## Design

### Pinned matrix — git 2.55.0 (scrubbed `GIT_*`, isolated `HOME`, `GIT_CONFIG_NOSYSTEM=1`, signing off, mktemp)

Fixture: a new loose blob stored at the SHA-1 of its own stored bytes. Header `blob 5\0` plus 200
bytes (0x00..0xC7) gives `7df3ad74663b645d0dfdadc2b343438b2350430c`. The honest 200-byte blob would
be `631c4448…aa6f`. "Reachable" means referenced through `update-index --add --cacheinfo` and a
commit. `E1`/`F1` below:

```
E1 = error: corrupt loose object '7df3ad74663b645d0dfdadc2b343438b2350430c'
F1 = fatal: loose object 7df3ad74663b645d0dfdadc2b343438b2350430c (stored in .git/objects/7d/f3ad74663b645d0dfdadc2b343438b2350430c) is corrupt
```

| # | case | git result | on disk after |
|---|---|---|---|
| G1 | reachable, overrun past window (5 / 200) | `maintenance run --task=gc` exit 1, stderr exactly `E1 F1 fatal: failed to run repack` + `error: task 'gc' failed`. `gc`, `gc --prune=now` and `-c gc.cruftPacks=false gc` exit 128 with `E1 F1 fatal: failed to run repack`. `repack`, `repack -a -d` and `pack-objects` exit 128 with `E1 F1` | no new pack; existing packs untouched; loose count unchanged; one `objects/pack/tmp_pack_XXXXXX` (`count-objects -v` `garbage: 1`) |
| G2 | unreachable, unexpired, cruft on (default) | same as G1 (the cruft `pack-objects` reads it), with or without a pre-existing pack | same as G1. The normal pack is not registered either, so the 9 reachable objects stay loose |
| G3 | unreachable, unexpired, `gc.cruftPacks=false` | exit 0, stderr empty | normal pack registered; the liar stays loose, never read; `garbage: 0` |
| G4 | unreachable, expired (`gc.pruneExpire=now` / `--prune=now`) | exit 0 | `prune` unlinks the liar without reading it |
| G5 | reachable, overrun inside the window (5 / 10) | exit 0 | pack holds the 5-byte truncation (`cat-file -s` → 5); loose pruned; later `git fsck` → `error: packed <oid> from <pack> is corrupt`, exit 4 |
| G6 | unreachable, in-window overrun, cruft on | exit 0 | cruft pack holds the 5-byte truncation; fsck exit 4 as G5 |
| G7 | reachable under-run (200 / 5) | exit 0 | pack holds 200 bytes (5 real + 195 padding, non-deterministic per ADR-907); loose pruned; fsck exit 4 |
| G8 | reachable overrun held in an alternate | borrower `gc` exit 0 (`repack -l` never reads it) | — |
| G9 | reachable overrun: `bundle create --all` / `push` to a local bare | exit 1. Bundle: `E1 F1 error: pack-objects died`. Push: `E1 F1` then `remote rejected … (unpacker error)` | — |
| G10 | two reachable past-window liars | exit 1, one `E1`/`F1` pair naming one of them | — |

The streamed and header tiers are unchanged. ADR-907 already pins them: `cat-file -s` → 5,
`cat-file -p` / `show` → 200 real bytes, `rev-list --objects --all` exit 0.

### tsgit today (same fixtures, `maintenance(ctx, { tasks: ['gc'] })`)

| case | tsgit result | divergence |
|---|---|---|
| G1 | fails `INVALID_OBJECT_HEADER { reason: 'content exceeds declared size 5' }` with no id; nothing written. Refused by deltify's `readEmissionContent` → `readRawObject` | no id: the test cannot rebuild F1 |
| G2 | fails `OBJECT_HASH_MISMATCH { expected: 7df3…, actual: 631c… }`, but only after a new normal pack and a cruft pack (`.pack/.idx/.rev/.mtimes`) are written and registered. The cruft pack holds the 200 real bytes under the lying oid. Afterwards `git fsck` exits 5 | durable corrupt writes |
| G3 | fails `INVALID_OBJECT_HEADER` after the normal pack is registered: `verifyPacked` reads `plan.survivors`, which were never packed | git succeeds |
| G4 | ok, pruned | none |
| G5 | fails `OBJECT_HASH_MISMATCH` after writing a 10-byte entry | git writes 5 bytes, exit 0 |
| G7 | fails `OBJECT_HASH_MISMATCH` after writing a 5-byte entry | git pads to 200, exit 0 (out of scope) |

Root cause: `build-pack.ts` `readBaseContent` (L180-191) and `deltify.ts` `buildEmissionOrder`
(L125-134) take the content carried by `readObjectMetadataWithContent`. Its loose arm,
`read-object.ts` `metadataFromLoose`, pins `resolveLooseArm(…, 'streamed')`. A carried liar
therefore yields its real bytes. Only objects whose content is not carried fall back to the
buffered `readRawObject`.

### Change set

| part | file · symbol | change |
|---|---|---|
| P1 | `src/domain/objects/error.ts` · `INVALID_OBJECT_HEADER` variant; `src/application/primitives/object-resolver.ts` · `contentExceedsDeclaredSize(size)`; `src/application/primitives/internal/blob-source.ts` · `assertWithinClaim` | Fault surface per **D3**. Recommended: an optional `id?: ObjectId`, set at all three refusal sites (`inflateLooseSinglePass` L241, `inflateBoundToClaim` L144, `assertWithinClaim` L752). Each site has the id in scope or one frame up |
| P2 | `src/application/primitives/read-object.ts` · `readObjectMetadataWithContent`, `resolveObjectMetadataWithContent`, `metadataFromLoose`, `metadataAfterFullMiss` | Per **D2**: thread a `LooseReadMode`. `readObjectMetadata` passes `'streamed'`, so ADR-902's contract and its test (L159-176) are untouched. `readObjectMetadataWithContent` passes `'buffered'`, so `uncompressedSize === content.length` of the buffered bytes |
| P3 | `src/application/commands/internal/gc-pipeline.ts` · `writeRepack`, `buildAndWriteNormalPack`, `buildAndWritePromisorPack`, `buildAndWriteCruftPack` | Per **D5**: split each into build and write. Build every pack (cruft, promisor, normal) before writing any, so a G2 refusal leaves no registered pack |
| P4 | `gc-pipeline.ts` · `verifyPacked` | Verify only objects in a pack this run wrote: normal ∪ promisor ∪ survivors **only when** a fresh cruft pack was written (a reused or no-op cruft pack is excluded). Fixes G3 |
| P5 (if **D6**=A) | `gc-pipeline.ts` · `verifyPacked` | On `OBJECT_HASH_MISMATCH` alone, accept when the id's still-present loose copy reads through the buffered tier as `'truncate'` and equals the packed bytes. Honest objects pay nothing extra. Brings G5/G6 to git's exit 0 |

No change to `maintenance.ts`: `failureOr` already copies `error.data` into `tasksFailed`.

### Flow after the change (G1/G2)

```
writeRepack
  build cruft  ── buildPack → deltify.buildEmissionOrder → readObjectMetadataWithContent('buffered')
  build promisor                                            └─ throws INVALID_OBJECT_HEADER { reason, id }
  build normal
  ── nothing written yet ──▶ failureOr('gc') → tasksFailed[{ task:'gc', code, data }]
  write normal → write promisor → write cruft → verifyPacked(written only)
```

The interop test rebuilds the stderr from `data.id` alone: the loose path is
`.git/objects/<id[0..2]>/<id[2..]>` relative to the work tree, per ADR-249.

### Edge behaviour

- **Commits, trees and tags** that lie about their size refuse in both tiers (`size mismatch`),
  so this change does not affect them.
- **`push`, `bundle create`, `packObjects`** share `buildPack`, so P2 aligns them with G9 too.
  Today their failure is order-dependent: they refuse only when the content was not carried.
- **G10, several liars:** tsgit names the first refusal its bounded-parallel read meets. The
  interop rows use one liar, and which id git names is not pinned.
- **Cost:** the buffered tier inflates once for loose files of 64 KiB compressed or less
  (`inflateLooseSinglePass`), as the streamed tier does. Above that size it adds one header probe
  of at most 33 output bytes (`inflateLooseHeadProbed`). The carried-content design (one read per
  loose object) survives. Acceptance: `npm run bench:ab` on `test/bench/maintenance.bench.ts`
  gc rows within noise. D5 holds the cruft and promisor pack bytes while the normal pack builds:
  measure with `npm run bench:memory`.
- **Threat model:** the claim is attacker-controlled (a planted loose file). P2 reuses the
  buffered tier's existing bound, `max(32, header + claim)` under the 2 GiB adapter ceiling,
  which is smaller than today's unbounded streamed inflate. P3 to P5 allocate nothing from the
  claim.

### Docs to update (documentation phase, not now)

- `docs/adr/907-*.md` gets an Amendment, or new ADRs from 1027 for the D-rows the user ratifies.
- `docs/use/errors.md`: the `INVALID_OBJECT_HEADER` row (the new `id` field, and gc / push /
  bundle in the buffered list).
- `docs/use/commands/maintenance.md`: the `tasksFailed` example.
- `docs/use/primitives/read-object.md`: the buffered-consumer list.
- `docs/BACKLOG.md`: Release order row 1 (#306).

## Decision candidates

| # | Choice | Alternatives (≤3) | Recommendation | Why |
|---|---|---|---|---|
| D1 | What gc does with a past-window overrun it must read (G1 reachable, G2 cruft route) | A. Refuse the whole task before any durable write · B. Skip the object and pack the rest · C. Write the real (streamed) bytes, today's G2 | **A** | G1/G2: git exits 128 with no pack registered and loose files untouched. B loses a reachable object; C writes a corrupt pack (git fsck exit 5). Named divergence: tsgit leaves no `tmp_pack_*` litter (git leaves one, `garbage: 1`) |
| D2 | Which layer changes | A. `readObjectMetadataWithContent` (internal, pack builders only) takes the buffered tier; `readObjectMetadata` stays streamed · B. build-pack and deltify drop the carried content and re-read through `readRawObject` · C. gc-pipeline pre-checks loose candidates | **A** | A costs one inflate, as today (see Cost). B inflates every loose object twice, undoing deltify's carried content. C covers gc only, while G9 shows push and bundle refuse too, and adds a third read |
| D3 | Fault surface | A. Optional `id` on `INVALID_OBJECT_HEADER` (additive; precedent `headerLimit`) · B. New code, e.g. `LOOSE_OBJECT_CORRUPT { id }`, for every buffered overrun (breaking for code-matchers, allowed in 6.0.0, must be named) · C. Reuse `OBJECT_HASH_MISMATCH` | **A** | A is minor and needs no new union member; the errors page gains one field. B moves every ADR-907 consumer's code. C is wrong: git never hashes here, and the data carries no oid pair |
| D4 | git's `error: corrupt loose object '<oid>'` line | A. Not emitted; the interop test rebuilds E1 and F1 from `data.id` · B. gc logs E1 through `ctx.logger.error` (`{ id }`) on catching it · C. The buffered reader logs E1 at every refusal site | **A** | Both lines depend only on the id (ADR-249). B is gc-only logging of a reader fault. C changes log output for every ADR-907 consumer, outside the brief |
| D5 | No durable write before a cruft-route (G2) refusal | A. Build cruft, promisor and normal packs, then write all · B. Keep the order and unlink the written normal pack on refusal · C. Keep the order and record the divergence (an honest normal pack stays registered) | **A** | G2 registers nothing. B is not crash-safe and its rollback can itself fail. C diverges on on-disk state. A's cost is the cruft and promisor bytes held during the normal build, gated by `bench:memory` |
| D6 | In-window overrun (G5/G6) | A. Match git: pack the truncation, `verifyPacked` accepts the mismatch only when the loose copy reads `'truncate'` with identical bytes, and gc prunes the loose file · B. Keep refusing after the write (`OBJECT_HASH_MISMATCH`, pack registered, loose intact) and record the divergence · C. Refuse before the write, like D1 | **A** | G5/G6: git exits 0 and fsck later flags the entry. A has no cost on the honest path. B and C both diverge from git on data and on exit status |

Pre-decided by faithfulness (not a candidate): P4. A run must verify only the packs it wrote.
G3 shows git never reads unpacked survivors. The perf-remediation design's "do not make it
conditional" rule is about sampling, not about verifying objects the run never packed.

## Test strategy

Unit RED, one per changed function (GWT titles, AAA, `sut`):

| suite | RED |
|---|---|
| `test/unit/application/primitives/object-resolver.test.ts` | Given a self-hashed past-window liar, When read through the buffered tier, Then the error data carries `id` and `reason` (try/catch on `.data`). One test per site: single-pass, then head-probed with more than 64 KiB compressed |
| `test/unit/application/primitives/internal/blob-source*.test.ts` | stream arm `assertWithinClaim` → `data.id` |
| `test/unit/application/primitives/read-object-metadata.test.ts` | `readObjectMetadataWithContent` on a past-window liar throws `INVALID_OBJECT_HEADER` with `id`. In-window: `content.length === uncompressedSize === 5`. The existing `readObjectMetadata` L159-176 test stays green as the guard |
| `test/unit/application/primitives/build-pack.test.ts`, `internal/deltify-carried-content.test.ts` | single-object build of a liar refuses (today it writes real bytes); multi-object build refuses regardless of carry |
| `test/unit/application/commands/maintenance-task-failure.test.ts` | G1/G2 → `tasksFailed[0]` `{ task:'gc', code:'INVALID_OBJECT_HEADER', data.id }`; G2 → zero `.pack` written (memory adapter census) |
| same, gc rows | G3: task ok, liar loose. P4: survivors are not read when cruft is off (a read-spy on the liar id). D6-A: in-window → ok, entry 5 bytes |

The liar fixture is a store written at the SHA-1 of its own stored bytes. The unit
`writeLooseWithDeclaredSize` in `test/unit/application/primitives/fixtures.ts` writes at the
honest id. Extend it with a self-hashed variant. For interop, lift `forgeOwnHash` from
`loose-header-size-interop.test.ts` into `test/integration/interop-helpers.ts`.

Interop rows (twin layout of `maintenance-interop.test.ts`, `makeTwin`, peer =
`git -C peer maintenance run --task=gc`). The fatal lines are rebuilt from `tasksFailed[].data`,
as in the `BAD_TREE_OBJECT` row:

| row | peer assertion | ours assertion | on disk (both twins) |
|---|---|---|---|
| I1 ← G1 | exit 1; stderr === `E1 F1 fatal: failed to run repack\nerror: task 'gc' failed\n` (E1/F1 rebuilt from `data.id`); plus `git gc` exit 128 | `tasksFailed` rebuilds E1+F1; `tasksRun` lacks `gc` | same registered `.pack` set as before the run; no `.mtimes`; `git count-objects` equal; liar file bytes unchanged |
| I2 ← G2 (with and without a pre-existing pack) | as I1 | as I1 | as I1; the reachable objects stay loose |
| I3 ← G3 | exit 0 | `tasksFailed` empty | liar loose on both; one registered pack each; `count-objects` equal |
| I4 ← G4 | exit 0 | ok | liar absent on both |
| I5 ← G5/G6 (if D6=A) | exit 0 | ok | `git cat-file -s` → 5 on both; loose pruned; real `git fsck` on both → exit 4 |
| I6 ← G8 | borrower exit 0 | ok (extend `alternates-gc-fsck-interop.test.ts`) | lender's liar untouched |

Interop traps: build each tsgit `Context` after the twin copy, because the loose fanout cache
only sees tsgit's own writes. Pin `GIT_AUTHOR_DATE` and `GIT_COMMITTER_DATE` on the fixture
commit.

Property-test lens (`.claude/workflow/property-testing.md`): no parser, decoder, matcher or
serializer changes shape. The header grammar and the verdict classifier are untouched, and P1
only adds a field to an error, so no `*.properties.test.ts` sibling applies. Mutation: the guard
in P5 (`'truncate'` and bytes-equal) needs one isolated test per condition.

## Out of scope

- Backlog 32.31 (`addAll` equivalence mark) is a separate id.
- Under-run rewrite, G7 (git pads to 200 and exits 0; tsgit refuses after the write): ADR-907's carried-forward short-body residual, unchanged here.
- `tmp_pack_*` litter (G1/G2): git's crash artefact, deliberately not reproduced (D1).
- tsgit `fsck` labels a loose overrun `unterminatedHeader` where git says `corrupt loose object`: pre-existing, separate.
- Interop rows for push / bundle create (G9): P2 aligns them, but the brief is gc; unit rows cover `buildPack`.
- A loose blob whose claim exceeds `core.bigFileThreshold`: not pinned. To prove it, re-run G1 with `-c core.bigFileThreshold=4`.
- G10 naming order (which liar git reports): not pinned. The rows use a single liar.
