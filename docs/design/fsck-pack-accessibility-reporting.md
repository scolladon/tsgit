# Design — `fsck` pack-accessibility reporting

> Brief: 28.1 gave the pack registry per-pack degradation — a pack refused at the header gate is
> skipped at lookup, a pack whose `.idx` cannot be read or parsed is excluded at scan. Both are
> faithful *read-path* semantics (ADR-572/575). What is missing is the *integrity-reporting*
> surface: real git's `fsck` reports `packfile … cannot be accessed` per refused pack and sets
> exit bit 4, and reports `packfile … index not opened` + `unable to load rev-index` for an
> unreadable index. tsgit's `fsck` is blind to both. Give `fsck` a per-pack health view of the
> registry, emit structured findings, and compose the exit bit — without regressing ADR-572's
> lookup-position gate.
>
> Status: **draft — decision candidates open** (§Decision candidates). Nine load-bearing choices
> are raised, none decided here.

## Context

### The divergences — pinned on **both** sides, not read off the code

Every cell in this section was executed: git 2.55.0 (§Pin J … §Pin N) and tsgit at this branch's
merge-base, driven through `dist/esm/index.node.js` (§Pin O). The arrangement is constant — a repo
whose own objects are loose and whose graph is clean, plus one *foreign* pack dropped into
`.git/objects/pack/` and mutated per row. That isolates the pack axis: any exit code other than 0
is attributable to the pack alone.

| # | repo shape | `git fsck` | tsgit `fsck` **today** |
|---|---|---|---|
| 1 | healthy pack (control) | **0**, no pack output | **0** |
| 2 | pack version **3** (control) | **0** | **0** |
| 3 | pack version **99** | **4** — one `cannot be accessed`, **zero object findings** | **1** — nine spurious `bad-object { msgId: 'badType' }`, 18 logger warns |
| 4 | header/index `objectCount` disagreement | **4** — same shape | **1** — same nine spurious findings |
| 5 | `.pack` unreadable (`chmod 000`) | **4** | **1** (same class) |
| 6 | `.idx` corrupt or unreadable | **68** — `index not opened` + `unable to load rev-index` | **0** — completely silent |
| 7 | `.idx` with no `.pack` (orphan) | **0**, silent | **0**, silent — **already faithful** |

**Three distinct divergences, not one.**

1. **D-A — the lookup layer reports the wrong thing.** For rows 3–5 git emits exit bit **4** and
   *no object findings whatsoever*: it refuses the pack and skips its object walk entirely (Pin M).
   tsgit instead enumerates the refused pack's object ids from its still-readable `.idx` (via
   `registry.all()`, which ADR-575 deliberately keeps ungated), then fails to read each one, and
   `tryGetRawObjectBody`'s `catch` (`content-validation.ts:76-81`) turns every failure into
   `bad-object { objectType: 'unknown', msgId: 'badType', severity: 'error' }` — nine findings that
   describe objects as malformed when the truth is that a pack is unusable — plus exit bit **1**,
   the *content-error* bit, where git sets bit 4.
   The brief's own wording ("makes its objects report *missing* while `fsck` walks a clean graph
   and exits 0") **understates this row**: the objects do not report missing and the exit is not 0.
   It is `badType` and exit 1. Recorded because the requirements below are written against the
   executed behaviour, not against the brief's description of it.
2. **D-B — the scan layer reports nothing at all.** For row 6 ADR-575's scan-layer skip removes the
   pack from the generation, so `all()` never lists it, so its ids never enter `fsck`'s universe,
   so `fsck` walks a genuinely clean graph and exits **0**. git exits **68**. *This* is the row the
   brief describes, and it is the one where tsgit is wrong in the most dangerous direction: a
   corrupt index is a real store-integrity problem and tsgit's integrity command says the store is
   fine.
3. **D-C — row 7 is already faithful and must stay that way.** git's `fsck` says nothing about an
   orphaned `.idx` (exit 0); only `count-objects -v` warns (`no corresponding .pack`,
   `garbage: 1`). ADR-579/580's scan-time exclusion + once-per-generation warn already matches this
   exactly. The temptation to fold the orphan case into the same finding as row 6 — they share a
   code path in `loadCandidatePack` and both currently end in `return undefined` — would *create* a
   divergence. §D1 keeps them separate on purpose.

### Premises of the brief, checked against the code

| # | brief premise | verdict |
|---|---|---|
| B-1 | *"a pack refused at the header gate … makes its objects report missing"* | **false, and worse than stated.** They report `bad-object / badType` with exit bit 1 (Pin O row 3). `missing` would at least be a connectivity finding; `badType` asserts the *object* is malformed. |
| B-2 | *"`fsck` walks a clean graph and exits 0"* | **true for the scan layer only** (D-B, Pin O row 5). For the lookup layer the graph is not clean and the exit is 1. |
| B-3 | *"real git's `fsck` … sets exit bit 4"* | **correct, and narrower than the whole story.** Bit 4 is git's `ERROR_PACK`. An unusable `.idx` additionally sets bit **64**, so git's exit for that family is **68**, not 4 (Pin K). Bit 64 fires with no `.rev` file on disk (Pin K, isolation row K-a), i.e. it is a function of the index fault, not of reverse-index support. DC-6. |
| B-4 | *"Requires deciding how `registry.all()`/a health accessor exposes skip records to `fsck`"* | correct, and it is **two** questions: how the *scan-layer* skips (discarded today) are retained, and how the *lookup-layer* verdicts are obtained for packs no lookup ever touches. DC-1 and DC-2. |
| B-5 | implicit: bit 4 covers exactly the accessibility conditions the registry already computes | **false.** git also folds a full `verify_pack` — per-object CRC, inflate, and the pack trailer checksum — into bit 4 (Pin N). Accessibility is a *subset* of git's bit-4 surface. DC-7. |
| B-6 | implicit: the finding surface is additive to `FsckFinding` | correct, and `FsckFinding` is **public** — 9 occurrences in `reports/api.json`, documented in `docs/use/commands/fsck.md`. `PackRegistry` / `RegisteredPack` are **not** (0 occurrences), so a registry accessor costs zero public surface. |

### Subsystems this touches

| Part | File / symbol | Tier |
|------|---------------|------|
| P1 | `src/application/primitives/pack-registry.ts` → `loadCandidatePack` (`:295-318`) stops collapsing three outcomes into `RegisteredPack \| undefined`; `scanPacks` (`:321-338`) accumulates skip records beside packs; `PackRegistry` (`:118`) gains one accessor (DC-1). `all()` / `lookup()` / `refresh()` / `dispose()` **unchanged** | primitive |
| P2 | `src/application/primitives/enumerate-objects.ts` → `EnumerateObjectsOptions` gains an accessibility knob whose default preserves every existing consumer (DC-5) | primitive (**public**) |
| P3 | **new** `src/application/commands/internal/fsck/pack-health.ts` → the third sibling of `runContentValidationPass` / `runRefsVerifyPass` (DC-9) | command-internal |
| P4 | `src/application/commands/internal/fsck/exit-codes.ts` → `EXIT_PACK = 4` (+ `EXIT_PACK_REV_INDEX = 64` under DC-6a/b) | command-internal |
| P5 | `src/application/commands/internal/fsck/types.ts` → new `FsckFinding` variant(s) (DC-3, DC-4), **and** `FsckResult.exitCode`'s doc-comment, which today reads *"0=clean, 2=missing/broken-link"* and is already stale (it names neither bit 1 nor bit 8) | command-internal (**public**) |
| P6 | `src/application/commands/fsck.ts` → call the pass, OR its bit into `exitCode` (`:101`), narrow the universe (`:35`) | command |
| P7 | `test/unit/application/primitives/pack-registry.test.ts` → the health matrix | test |
| P8 | `test/unit/application/commands/fsck.test.ts` → pass, gating and composition matrix; `test/unit/application/commands/fsck.properties.test.ts` → two added lens-2 invariants (§Test strategy) | test |
| P9 | **new** `test/integration/fsck-pack-accessibility-interop.test.ts` | test |
| P10 | `test/integration/pack-version-interop.test.ts` → its crafting helpers lift into a shared module (§Test strategy) | test |
| P11 | `docs/use/commands/fsck.md`, `docs/use/primitives/internals.md`, `reports/api.json` | docs |

### Constraining prior decisions

| ADR / rule | What it binds | How this design stands to it |
|---|---|---|
| **ADR-226** (git-faithfulness prime directive) | observable behaviour byte-for-byte unless an ADR diverges | every accept/refuse/exit cell below is executed, and the tsgit "today" column is executed too, so the before/after claims are falsifiable in both directions |
| **ADR-249** (structured data, not cosmetics) | the *condition* and the *exit code* are git's; the rendered line is the caller's | the findings carry the pack identity and a structured reason; **no** git stderr text is composed in `src/`. The interop test reconstructs git's line from the fields and compares (§Test strategy) |
| **ADR-572** (the local pack gate sits in `lookup`) | the gate is lookup-positioned and **lazy** — a pack whose index does not claim a requested object is never opened; `all()` stays ungated | **must not regress.** `lookup`'s body is unchanged. The health probe is a *separate entry point* with exactly one caller (DC-2); it awaits the **same** `header()` memo rather than duplicating it, so a successful probe makes later lookups cheaper and a failed probe still clears the memo — 28.1's Pin C5 (*no negative cache*) survives untouched, and the refusal reason cannot drift between callers because only one site computes it |
| **ADR-573** (a refused pack degrades per pack) | a refused pack's objects report `OBJECT_NOT_FOUND`, one logger warn, nothing else fails | unchanged on the read path. `fsck` now *additionally* reports the pack, which is what git does — the read path stays quiet, the integrity command becomes loud |
| **ADR-575** (full per-pack registry degradation) | an index-layer fault excludes the pack from the generation; `all()` matches git's `packs: 0` | unchanged. The design does **not** put those packs back into `all()`; it retains their *skip records* alongside (§D1), a strictly additive channel |
| **ADR-577** (the gate cross-checks `objectCount`) | a header/index count disagreement is a skippable pack fault carrying `INVALID_PACK_HEADER` | reused verbatim: one more `unusable` row with one more reason, and git agrees (Pin J4) |
| **ADR-579 / ADR-580** (orphaned `.idx` excluded at scan, warned once per generation) | an orphan never becomes a `RegisteredPack`; one warn per generation | **must not become a finding** — git's `fsck` is silent and exits 0 (Pin J11). §D1 keeps the orphan arm and the fault arm distinct |
| **ADR-566 … ADR-571** (promise-memo / handle lifecycle) | every lazy initializer crossing an `await` is a `createPromiseMemo`; no handle may become unreachable; `dispose()` is terminal | the probe calls the existing `header()` memo, which reads via `ctx.fs.readSlice` and owns **no** `FileHandle` (28.1 §D7). Zero new orphaning surface; the accessor obeys the same terminal-disposal rule as `all()` (§D1) |
| **ADR-510** (persistent per-pack `FileHandle`s) | the registry owns one lazily-opened handle per pack | untouched: the probe never reaches `pack.readSlice` |
| **ADR-050** (cache-invalidation policy) | event-driven invalidation for caches that can go stale | health is derived from the scan memo and the per-pack header memos; `refresh()` discards both together, so no new invalidation rule appears |

### House patterns this must follow

- **Pass shape.** `runContentValidationPass` (`content-validation.ts:178`) and `runRefsVerifyPass`
  both return `{ findings, exitBit }` and are OR'd at `fsck.ts:101`
  (`contentResult.exitBit | connectivityBit | refsResult.exitBit`). The pack pass is the third of
  the same shape — no new composition mechanism.
- **Named exit-bit constants**, one per condition, in `internal/fsck/exit-codes.ts`, with the
  pinned-against-real-git comment block that file already carries.
- **Narrow fault discriminators, never a blanket `catch`.** `isSkippableIdxFault` /
  `isSkippablePackFault` / `isUnsupportedOperation` (`pack-registry.ts:29-65`) already state the
  rule: recognise the expected fault by code, let everything else surface, because `mapErrno` folds
  `EMFILE`/`EIO` into `UNSUPPORTED_OPERATION { operation: 'filesystem' }` and a descriptor
  exhaustion must never be reported as a corrupt pack.
- **Flat, string-valued logger context** — `faultContext` (`pack-registry.ts:70`) exists because the
  Logger port sanitises top-level string values only.
- **`isSafePackName`** (`pack-registry.ts:134`) rejects `/`, `\`, `..` and every control character
  below `0x20` at the scan boundary — the reason a pack name is safe to hand out as data (§D10 T-3).
- **`@proves` block with `interopSurface:`** on the interop test. `tooling/audit-write-surfaces.ts`
  cross-checks `@writes`/`@proves` pairs; this change writes nothing, so no `@writes` moves (§D8).

## Pinned matrices — git 2.55.0, this host (darwin 25.5.0)

Method: one `mktemp -d` throwaway per row, isolated `HOME`, `GIT_CONFIG_NOSYSTEM=1`, every `GIT_*`
scrubbed, `commit.gpgsign=false`, `core.logAllRefUpdates=false` (reflog roots are orthogonal to this
axis, and their absence keeps every non-zero exit attributable to the pack). A donor repo is seeded
with three commits and `git repack -adq`'d; its `.pack`/`.idx` pair is copied into a *fresh* repo
whose own nine objects are loose and whose graph is clean, then mutated. Mutations rewrite the u32
BE field in question and re-fix the pack trailer over `pack[0 .. len − 20)`; where the `.idx` must
keep agreeing, its recorded pack checksum (20 bytes at `idxLen − 40`) is re-stamped and its own
trailer re-hashed. `.rev` files are deleted before the pack rows so the reverse-index axis cannot
contaminate them. Probe scripts are under the session scratchpad; the recipe is reproduced in
§Test strategy because the tests need it.

### Pin J — `git fsck`, default mode, one foreign pack, clean local graph

| # | pack-directory state | exit | stderr, in emission order |
|---|---|---|---|
| J1 | healthy `.pack` + `.idx` | **0** | — |
| J2 | pack version **3** | **0** | — |
| J3 | pack version **99** | **4** | `error: packfile <p>.pack is version 99 and not supported (try upgrading GIT to a newer version)` → `error: packfile <p>.pack cannot be accessed` |
| J4 | header count 10, index count 9 | **4** | `error: packfile <p>.pack claims to have 10 objects while index indicates 9 objects` → `cannot be accessed` |
| J5 | `.pack` `chmod 000` | **4** | `error: packfile <p>.pack cannot be accessed` — **and nothing else**; git does not say why |
| J6 | signature `PACX` | **4** | `error: file <p>.pack is not a GIT packfile` → `cannot be accessed` |
| J7 | `.pack` truncated to 8 bytes | **4** | `error: file <p>.pack is far too short to be a packfile` → `cannot be accessed` |
| J8 | `.idx` same-length garbage | **68** | `error: non-monotonic index <p>.idx` (×7) + `error: packfile <p>.pack index not opened` + `error: unable to load rev-index for pack '<p>.pack'` |
| J9 | `.idx` truncated to 8 bytes | **68** | `error: index file <p>.idx is too small` (×7) + `index not opened` + `unable to load rev-index` |
| J10 | `.idx` `chmod 000` | **68** | `index not opened` + `unable to load rev-index` — **silent** about the cause |
| J11 | `.idx` present, **no `.pack`** | **0** | — (`count-objects -v`: `packs: 0`, `garbage: 2`, `warning: no corresponding .pack`) |
| J12 | `.pack` present, **no `.idx`** | **0** | — (`count-objects -v`: `packs: 0`, `garbage: 1`, `warning: no corresponding .idx`) |
| J13 | `.rev` corrupt, `.pack` + `.idx` healthy | **64** | `error: reverse-index file <p>.rev is too small` + `unable to load rev-index` |
| J14 | **two** bad packs (v99 + `PACX`) | **4** | **two** `cannot be accessed`, one per pack, each preceded by its own cause line |
| J15 | pack **v99 and** `.idx` garbage, same pack | **68** | the index layer wins outright — `index not opened` + `unable to load rev-index`; the version line **never appears** |

**Rules, as pinned.**

- The refusal is reported **once per pack per `fsck` run** (J14) — not once per object, and not once
  per lookup. That is the opposite cardinality from the read path's per-request `error:` line
  (28.1 Pin C5), and it is the cardinality the findings must have.
- `cannot be accessed` is a **verdict** line, always preceded by a cause line **except** J5, where
  git is silent about the cause. So the cause is not recoverable from git's output in every row;
  only the verdict is. That is what makes the structured reason ours to choose under ADR-249, and
  why the interop test compares the verdict everywhere and a cause only where git emits one.
- The two layers produce **different messages and different exit integers**: pack-open faults give
  `cannot be accessed` and bit 4; index faults give `index not opened` and bit 4 **plus** bit 64.
- **Both orphan rows (J11, J12) are non-events** — silent, exit 0, at both layers.
- J15 pins the precedence: an unusable index masks whatever is wrong with the pack, because git
  never reaches the pack open.

### Pin K — mode gating, and where bit 64 comes from

| repo shape | `fsck` | `fsck --connectivity-only` | `fsck --no-full` | `fsck --strict` |
|---|---|---|---|---|
| healthy | 0 | 0 | 0 | 0 |
| pack v99 | **4** | **0** | **0** | **4** |
| `.idx` garbage | **68** | **64** | **64** | 68 |

| # | isolation probe | result |
|---|---|---|
| K-a | `.idx` garbage with the `.rev` file **deleted first** | still **68** — bit 64 is emitted with **no reverse index on disk** |
| K-b | `.rev` corrupt, index healthy (= J13) | **64** alone, no bit 4 |
| K-c | pack v99, index healthy (= J3) | **4** alone, no bit 64 |

**Rules, as pinned.**

- **Bit 4 is gated; bit 64 is not.** The pack-open pass that emits `cannot be accessed` /
  `index not opened` runs only in full, non-connectivity-only mode. The reverse-index load runs in
  **every** mode, `--no-full` included, and fails whenever the index fails.
- **Bit 64 is a deterministic consequence of an unusable index, not of `.rev` support.** K-a is the
  probe that forbids the tempting reading *"tsgit has no `.rev`, therefore bit 64 does not apply"*:
  git emits it when there is no `.rev` file either, because it computes the reverse index in memory
  from the `.idx`. DC-6 turns on this cell.
- `--strict` does not touch the pack bits.

### Pin L — exit-bit isolation and composition

| repo shape | exit | decomposition |
|---|---|---|
| ref containing a null sha, no pack fault | 10 | 2 \| 8 |
| a reachable tree deleted, no pack fault | 10 | 2 \| 8 |
| pack v99 **+** a reachable tree deleted | **14** | 2 \| 4 \| 8 |
| pack v99 **+** a null-sha ref | **14** | 2 \| 4 \| 8 |
| pack v99 alone | 4 | 4 |
| **v99 pack holding every reachable object** (= Pin M5) | **14** | 2 \| 4 \| 8 |
| **corrupt `.idx` holding every reachable object** (= Pin M6) | **78** | 2 \| 4 \| 8 \| 64 |

Bit 4 composes by plain OR with every other bit and is neither absorbed by nor absorbing of them.
tsgit already models bits 1, 2 and 8 (`internal/fsck/exit-codes.ts`); this change adds the fourth
(and, under DC-6, fifth) independent term to the same OR at `fsck.ts:101`.

### Pin M — the object universe: what an unusable pack contributes

The decisive matrix for D-A, and the one that separates `fsck` from every other enumeration surface.

| # | repo shape | `git fsck` stdout | `count-objects -v` | `cat-file --batch-all-objects --batch-check` |
|---|---|---|---|---|
| M1 | v99 pack, its 9 objects **nowhere else** | **empty** — no `missing`, no `dangling`, no `unreachable` | `packs: 1`, `in-pack: 9` | lists all 9 ids, each as `<oid> missing`, exit 0 |
| M2 | v99 pack, its 9 objects **also loose** | **empty** | `packs: 1`, `in-pack: 9` | — |
| M3 | v99 pack **+ a healthy twin** holding the same objects | `dangling commit <oid>` — the objects **are** reported, served from the healthy pack | `packs: 2`, `in-pack: 18` | — |
| M4 | healthy foreign pack (control) | `dangling commit <oid>` | `packs: 1`, `in-pack: 9` | — |
| M5 | **v99 pack holding every one of the repo's own reachable objects** | `missing blob <oid>` ×3 (the index-root blobs); stderr adds `refs/heads/main: invalid sha1 pointer`, `HEAD: invalid sha1 pointer`, `invalid sha1 pointer in cache-tree of .git/index`; exit **14** | — | — |
| M6 | **corrupt `.idx` holding every reachable object** | same `missing blob` ×3 + the same pointer errors; exit **78** | `packs: 0`, `in-pack: 0` | — |
| M7 | v99 pack, `--connectivity-only` | 6–9 × `dangling unknown <oid>` on stdout, one `error: Unknown object type for <oid>` each on stderr, **no bit 4** | — | — |

**Rules, as pinned.**

- **`fsck`'s object walk is pack-accessibility-gated; every other enumeration surface is
  index-driven.** M1 against its own `cat-file --batch-all-objects` column is the whole point: git
  *does* list a refused pack's ids when asked to enumerate objects, and *does not* walk them in
  `fsck`. So this change must **not** touch `registry.all()` (ADR-575 pinned it against
  `count-objects`) and must **not** make `enumerateObjects` filter by default (M1's `cat-file`
  column forbids it) — only `fsck`'s own universe narrows. DC-5.
- **The gate is per pack, not per object** (M3): an object reachable through *any* accessible pack
  is walked normally while a sibling pack is refused. "Build the universe from accessible packs
  only" produces M1, M2 **and** M3 with no special case.
- **Roots are unaffected by the gate** (M5, M6). A ref or index entry pointing into an unusable pack
  still resolves to nothing, so git reports the connectivity failure (bit 2, plus bit 8 from its ref
  and cache-tree checks) *alongside* the pack bit. Narrowing the universe must therefore leave the
  root-seeding path alone: seeds that fall outside the universe are exactly what produces
  `missing`/`broken-link`, and that is the correct outcome here. **Caveat for the interop
  assertions:** git splits those reports between stdout `missing blob` (index roots) and stderr
  `invalid sha1 pointer` (ref roots), while tsgit models both as `missing` findings — a pre-existing
  roots-axis shape difference this change neither causes nor fixes, which is why the composition
  rows assert **differentially** (§Test strategy K-15, K-19).
- **`--connectivity-only` inverts the object rule** (M7): there git enumerates from the index and
  reports each unreadable object as `dangling unknown`. tsgit reports nothing in that mode (Pin O),
  because `collectTypeFindings` (`reachability.ts:204-217`) skips null-cache entries and
  `FsckFinding['dangling'].objectType` has no `'unknown'` member. DC-8.

### Pin N — the rest of git's bit 4, which this change does *not* claim

| repo shape | exit | stderr |
|---|---|---|
| healthy pack, **one body byte flipped** at offset 40 | **4** | `error: <p>.pack pack checksum mismatch` + `error: cannot unpack <oid> from <p>.pack at offset 12` + `error: index CRC mismatch for object <oid> …` + `error: inflate: data stream error (invalid bit length repeat)` |

git's `fsck` runs a full `verify_pack` over every **accessible** pack — pack trailer checksum,
per-object index CRC, and an inflate of every object — and folds all of it into the same bit 4.
Accessibility is a **subset** of git's bit-4 surface. DC-7 decides how much of the remainder this
change takes; the recommendation is none, with the residual named in §Out of scope rather than left
implicit.

### Pin O — tsgit **today**, same rows, executed

Driven through `dist/esm/index.node.js` (`openRepository({ cwd, logger })` → `repo.fsck(opts)`) at
this branch's merge-base, against the identical on-disk fixtures. The `git fsck` column is re-run in
the same process per row, so both columns describe the same bytes.

| # | repo shape | git | tsgit `exitCode` | tsgit findings | tsgit logger warns |
|---|---|---|---|---|---|
| O1 | clean, no packs | 0 | 0 | `root`×1 | 0 |
| O2 | pack v3 | 0 | 0 | `unreachable`×9, `dangling`×1, `root`×1 | 0 |
| O3 | pack **v99** | **4** | **1** | **`bad-object`×9** (`msgId: 'badType'`, `severity: 'error'`), `root`×1 | **18** × `packRegistry: skipping unusable pack` |
| O4 | header/index count mismatch | **4** | **1** | **`bad-object`×9** (`badType`), `root`×1 | **18** |
| O5 | `.idx` corrupt | **68** | **0** | `root`×1 | 1 × `skipping unreadable pack index` |
| O6 | `.idx` orphan | 0 | 0 | `root`×1 | 1 × `skipping pack index with no pack file` |
| O7 | healthy foreign pack | 0 | 0 | `unreachable`×9, `dangling`×1, `root`×1 | 0 |
| O8 | every row above, `connectivityOnly: true` | 0 / 4 / 68 | **0** for all | `root`×1 | as above |
| O9 | every row above, `full: false` | 0 / 4 / 68 | **0** for all | `root`×1 | as above |

Three things this column establishes that the code alone would not.

- **O3/O4's finding is `badType`, not `missing`.** Fixing D-A therefore removes nine findings *and*
  changes the exit bit, in opposite directions at once — a test asserting only "bit 4 is now set"
  would pass while leaving nine lies in `findings`. Requirement 6 is written to forbid that.
- **The 18 warns are two per object** — one from the object-cache read, one from the
  content-validation read — and vanish once the ids leave the universe. Log volume falls from
  `2 × objects` to O(1) per generation. Noted so the drop is not mistaken for a lost signal.
- **O8/O9 are uniformly 0**, so the mode-gating requirement is *not* "preserve today's behaviour in
  the non-default modes" — those modes are wrong too, in the bit-64 direction (git 64, tsgit 0).
  DC-6 decides whether that closes.

**O2/O7 caveat.** tsgit reporting `unreachable`×9 **and** `dangling`×1 where git prints one
`dangling commit` is not a divergence: tsgit computes the maximal finding taxonomy and the caller
filters (`docs/use/commands/fsck.md`), where git needs `--unreachable` to print the rest.

## Requirements

Verifiable at ship time.

1. **A pack refused at the pack-open layer produces exactly one finding, per pack, per run** — for
   every recognised cause: version outside `2|3`, bad signature, short file, header/index
   `objectCount` disagreement, and a `.pack` that cannot be opened (`FILE_NOT_FOUND` /
   `PERMISSION_DENIED`). Pin J3–J7; cardinality from J14.
2. **A pack whose `.idx` cannot be read or parsed produces exactly one finding, per pack, per run**
   — distinguishable from requirement 1's finding, because git's message and exit composition
   differ (Pin J8–J10 versus J3–J7).
3. **An orphaned `.idx`, and a `.pack` with no `.idx`, produce no finding and no exit bit.**
   Pin J11, J12. The existing ADR-580 warn stays; a warn is not a finding.
4. **Exit bit 4 is set when and only when at least one finding from requirements 1 or 2 exists**,
   and composes by OR with the existing bits 1, 2 and 8 without absorbing or being absorbed
   (Pin L).
5. **Under DC-6a/b, exit bit 64 is set when and only when at least one *index-layer* fault exists**,
   in **every** mode — including `connectivityOnly` and `full: false`, where requirement 4's bit is
   absent (Pin K). Under DC-6c this requirement is dropped and the divergence recorded in the ADR.
6. **Mode gating matches Pin K.** The pack pass — and the universe narrowing of requirement 7 — run
   only when `full !== false` **and** `connectivityOnly !== true`. `strict` does not affect either.
7. **The object universe excludes objects contributed *only* by an unusable pack**, at both layers:
   index-layer faults already exclude them via ADR-575's scan exclusion, and pack-open-layer faults
   must now exclude them too (Pin M1, M2). An object also present loose or in an accessible pack is
   walked and classified normally (Pin M3). After the change, tsgit's default-mode findings for Pin
   O rows O3/O4 contain **zero** object-level entries attributable to the refused pack — no
   `bad-object`, no `missing`, no `dangling`, no `unreachable`.
8. **Root seeding is unchanged.** A ref or index entry pointing into an unusable pack still produces
   `missing` + `broken-link` + bit 2 alongside the pack finding (Pin M5, M6, Pin L).
9. **`registry.all()`, `lookup()`, `refresh()` and `dispose()` keep their current semantics
   exactly.** ADR-575's `all()`-lists-a-refused-pack property (git's `packs: 1` / `in-pack: 9`,
   Pin M1) is unchanged, and so is default `enumerateObjects` (git's `cat-file
   --batch-all-objects` column, Pin M1).
10. **ADR-572's lookup gate does not regress.** `lookup` still probes only packs whose index claims
    the requested object, and the header memo still clears on rejection, so a refused pack is still
    re-probed per lookup hit (no negative cache). Structural: `lookup`'s body is unchanged and the
    probe uses the *same* memo, not a second one.
11. **The #263 handle lifecycle is untouched.** The probe opens no `FileHandle`; after `dispose()`,
    opened-minus-closed stays 0 for every row of that lifecycle matrix. The accessor obeys the same
    terminal-disposal rule as `all()`.
12. **Structured data only** (ADR-249). No production code composes `cannot be accessed`,
    `index not opened`, `is version N and not supported`, or any other git stderr text.
13. **No swallowed reason.** Every skip the registry performs stays on the logger channel *and*
    becomes retrievable through the accessor. A fault outside the two allow-lists still propagates
    — the accessor must **reject**, never report an `UNSUPPORTED_OPERATION` as a degraded pack.
14. **No new public surface beyond the finding variant(s) and, under DC-5a, one optional
    `EnumerateObjectsOptions` field.** `reports/api.json` **will** change for the variant(s); the
    regenerated report must be committed (prepush `check:doc-typedoc`).
15. **Nothing is written.** `tooling/audit-write-surfaces.ts` stays green with no annotation or
    allowlist edit (§D8).
16. **Hash-agnostic.** No branch on `ctx.hashConfig` anywhere in the pass (§D9).

## Design

### §D1 — the registry health accessor

The scan layer already *computes* the index-fault verdict and then throws it away.
`loadCandidatePack` (`pack-registry.ts:295-318`) returns `RegisteredPack | undefined` and folds
three distinct outcomes into that one `undefined`: an orphan (no sibling `.pack`), a skippable index
fault, and — implicitly — nothing else, because an unrecognised fault re-throws. The loss is at the
return type, not in the logic: both branches already exist and already carry the right context to
`ctx.logger?.warn?.`.

So the change is to widen the return type, not to add logic:

```ts
type PackCandidateOutcome =
  | { readonly kind: 'registered'; readonly pack: RegisteredPack }
  | { readonly kind: 'orphaned'; readonly name: string }
  | { readonly kind: 'index-fault'; readonly name: string; readonly data: TsgitErrorData };
```

`scanPacks` accumulates both arrays and the memo carries both:

```ts
interface PackGeneration {
  readonly packs: ReadonlyArray<RegisteredPack>;
  readonly indexFaults: ReadonlyArray<PackIndexFault>;   // 'orphaned' is NOT retained (req. 3)
}
```

`all()` returns `generation.packs` — the same array shape it returns today, so `enumerateObjects`,
`resolveOidPrefix` and every other `all()` consumer see nothing (requirement 9).

The report is then defined by two equations over that generation, which is the whole of the
accessor's semantics:

```
unusable   = generation.indexFaults  ∪  { p ∈ generation.packs | p.header() rejected }
accessible = generation.packs        \  { p ∈ generation.packs | p.header() rejected }
```

so `accessible ⊆ all() ⊆ accessible ∪ unusable`, and an orphan appears in **none** of the three
(requirement 3). Stating it as equations matters because the two layers contribute to `unusable`
from opposite sides — an index fault never became a `RegisteredPack`, a pack fault is one — and the
finding must not care which (DC-4).

The accessor (its shape is DC-3/DC-4; the mechanism is what §D1 fixes):

```ts
/**
 * Per-pack health for the CURRENT generation — the integrity view `fsck` needs
 * and nothing else needs. Probes every registered pack's header, so it is the
 * ONE caller that opens packs a lookup would have left alone: never call it
 * from a read path. Costs one 12-byte `ctx.fs.readSlice` per registered pack
 * whose header memo is not already settled, and opens no FileHandle.
 * Rejects — never reports — on a fault outside the two allow-lists.
 */
health(): Promise<PackHealth>;
```

Four properties make this an additive view rather than a second, competing gate.

- **It reuses `pack.header()`.** There is exactly one header memo per pack, built in `loadPack`
  (`pack-registry.ts:173-181`). `health()` awaits it; `lookup` awaits it. A successful probe settles
  the memo so a later lookup pays nothing; a failed probe clears it, so a later lookup re-probes and
  re-warns — 28.1's Pin C5 *no negative cache* survives, and the refusal reason cannot drift between
  the two callers because only one site computes it.
- **It never reaches `pack.readSlice`.** The header memo reads through `ctx.fs.readSlice`, not the
  persistent-handle path (28.1 §D7, ADR-566…571), so `health()` cannot open a `FileHandle`, cannot
  touch the `retired`/`inFlight`/`close()` state machine, and adds no orphaning surface
  (requirement 11).
- **It honours terminal disposal.** ADR-569 makes `dispose()` terminal and `allPacks()` refuses to
  start a scan afterwards (`pack-registry.ts:369-372`). `health()` routes through the same
  `allPacks()` helper, so a disposed registry reports the peeked generation or an empty one — it
  never resurrects a scan whose packs nothing could close.
- **It probes sequentially**, matching `scanPacks`'s existing per-candidate `await` loop. The scan
  already pays a `stat` + full `.idx` read + `parsePackIndex` per pack in that same loop, so a
  12-byte probe per pack cannot dominate; introducing bounded concurrency here would add a
  concurrency primitive to a path that has none, for a saving below measurement.

**The orphan branch stays outside the report** (requirement 3, Pin J11). It keeps its ADR-580 warn
and contributes nothing. This is the single most inversion-prone line in the change: the orphan arm
and the fault arm sit five lines apart and both end in `return undefined` today. §Test strategy pins
them with separate `it`s for exactly that reason.

### §D2 — the two layers, and why the finding must distinguish them

| layer | tsgit site | git's message | git's exit contribution | tsgit finding |
|---|---|---|---|---|
| **index** | `scanPacks` / `loadCandidatePack` — `INVALID_PACK_INDEX`, `FILE_NOT_FOUND`, `PERMISSION_DENIED` | `packfile <p>.pack index not opened` **and** `unable to load rev-index for pack '<p>.pack'` | bit 4 (full mode only) **and** bit 64 (every mode) | requirement 2's variant |
| **pack-open** | the `header()` probe — `INVALID_PACK_HEADER`, `FILE_NOT_FOUND`, `PERMISSION_DENIED` | `packfile <p>.pack cannot be accessed`, usually preceded by a cause line | bit 4 (full mode only) | requirement 1's variant |
| **orphan** | `loadCandidatePack`'s sibling-`.pack` check | *(silent; `count-objects` only)* | none | **no finding** |

Collapsing the first two into one variant is defensible on the *message* axis under ADR-249 (wording
is ours) but not on the **exit** axis: they compose differently (Pin K), and an exit integer is data
the prime directive binds. DC-3 puts the choice to the user with that constraint stated.

The precedence pin (Pin J15) — a pack that is *both* v99 and index-corrupt reports only the index
fault — is inherited for free: an index-fault pack never becomes a `RegisteredPack`, so its header
is never probed and only the index-layer finding can exist. Structural, not a rule anyone has to
remember.

### §D3 — the fsck pack pass

A third pass beside the two that exist, in the file the house pattern implies (DC-9):

```ts
export async function runPackHealthPass(
  ctx: Context,
  opts: FsckOptions,
): Promise<{ readonly findings: ReadonlyArray<FsckFinding>; readonly exitBit: number }>;
```

`fsck.ts` gains three lines: call it, OR its bit into `exitCode`, spread its findings.

**The signature takes `opts`, not a pre-computed boolean, and that is DC-6's doing.** Under DC-6c a
single `enabled = opts.full !== false && opts.connectivityOnly !== true` computed at the call site
would suffice and the pass could stay opinion-free about options. Under DC-6a/b the pass carries
**two** gates — bit 4 gated by `enabled`, bit 64 ungated (Pin K) — so the gating cannot be hoisted
out. Stated explicitly because a reviewer will otherwise read the `opts` parameter as a layering
slip rather than a pinned consequence.

### §D4 — the object universe

`fsck.ts:35` today:

```ts
const allIds = await enumerateObjects(ctx, { includePacks: opts.full !== false });
```

Requirement 7 needs the pack half restricted to accessible packs, and Pin M1's `cat-file
--batch-all-objects` column forbids changing the default for everybody else. Whichever DC-5 option
lands, the semantics are fixed: **union(loose ids, ids of every accessible pack's index)**, applied
under the same `enabled` predicate as the pass (requirement 6) — in `connectivityOnly` mode git
*includes* a refused pack's ids (Pin M7), so the narrowing must not fire there.

Consequences worth stating rather than discovering:

- **The nine `badType` findings disappear** (Pin O3/O4) because the ids never enter the universe,
  not because `content-validation.ts` learns a new arm. `tryGetRawObjectBody` is untouched.
- **`buildObjectCache` no longer reads nine objects it cannot read**, which is where 18 of the 18
  logger warns came from.
- **`missing` / `broken-link` is unaffected** (requirement 8). An object genuinely referenced but
  absent — including one that was only in the refused pack and is referenced from a loose commit or
  a ref — still produces `missing` + `broken-link` + bit 2, composing with bit 4 exactly as Pin L's
  `v99 + deleted tree` and Pin M5 rows do.
- **`health()` is called twice per `fsck` run** under DC-5a — once inside `enumerateObjects`, once
  by the pass. The scan memo and every *successful* header memo are settled by then, so the second
  call re-probes only the **failed** packs, at 12 bytes each, and emits a second logger warn for
  each. That is not a regression against git, which re-emits its own `error:` line many times per
  run (Pin J8: seven times) for the identical no-negative-cache reason. Passing the report down
  instead is DC-5(b)'s upside, and is called out in DC-5's consequence column.

### §D5 — exit-code semantics

`internal/fsck/exit-codes.ts` gains, in the file's existing pinned-comment convention:

```ts
// bit 4  = pack inaccessible / index not opened (git's ERROR_PACK)
// bit 64 = reverse index unusable                (git's ERROR_PACK_REV_INDEX)  ← DC-6
export const EXIT_PACK = 4;
export const EXIT_PACK_REV_INDEX = 64;
```

`fsck.ts:101` becomes a four- or five-term OR. Bit 4 is set **once**, regardless of how many packs
are unusable (Pin J14: two packs, still exit 4).

The file's header comment currently claims "pinned against real git 2.54.0"; the rows added here are
pinned against **2.55.0** and the comment must say so rather than silently widen the older claim.

### §D6 — refusal propagation and finding semantics

| repo state | tsgit findings | tsgit exit bits | git observable |
|---|---|---|---|
| healthy / v3 pack | none | 0 | exit 0 (J1, J2) |
| pack v99 | one pack-inaccessible finding; **no** object findings from that pack | 4 | exit 4, one `cannot be accessed` (J3, M1) |
| header/index count disagreement | one, reason names both counts | 4 | exit 4 (J4) |
| bad signature | one, reason names the magic | 4 | exit 4 (J6) |
| pack < 12 bytes | one, reason names the truncation | 4 | exit 4 (J7) |
| `.pack` unopenable | one, reason carries the io code | 4 | exit 4, git silent about the cause (J5) |
| `.idx` unparseable | one index-unusable finding | 4 \| 64 (DC-6) | exit 68 (J8, J9) |
| `.idx` unreadable | one, reason carries the io code | 4 \| 64 | exit 68, git silent about the cause (J10) |
| `.idx` over `MAX_PACK_IDX_BYTES` | one, reason `REASON_PACK_IDX_EXCEEDS_MAX`; **no `ctx.fs.read` issued** | 4 \| 64 | no direct analogue — git's own size sanity lands it in the J8 family |
| orphan `.idx` / idx-less `.pack` | **none** | 0 | exit 0, silent (J11, J12) |
| two unusable packs | **two** findings | 4 (once) | exit 4, two verdict lines (J14) |
| v99 **and** unusable `.idx`, same pack | **one** index-unusable finding only | 4 \| 64 | exit 68, no version line (J15) |
| unusable pack **+** deleted reachable tree | pack finding **and** `missing` + `broken-link` | 2 \| 4 (\| 8) | exit 14 (Pin L, M5) |
| any of the above, `connectivityOnly` / `full: false` | no pack-inaccessible finding | 0 (DC-6c) or 64 for index faults (DC-6a/b) | 0 / 64 (Pin K) |
| a fault outside both allow-lists | `health()` **rejects**; `fsck` propagates | n/a | n/a — tsgit-side guardrail |

Per ADR-249 the wording is ours; the condition and the exit integer are git's.

### §D7 — performance

Cost: **one 12-byte `ctx.fs.readSlice` per registered pack whose header memo is not already
settled**, once (twice, for failed packs, under DC-5a) per `fsck` run in full mode. Against what
`fsck` already does — `enumerateObjects` reads and parses every `.idx`, `buildObjectCache` decodes
*every object in the repository*, `runContentValidationPass` inflates and re-hashes each one — the
probe is not measurable. git pays the same 12 bytes per pack for the same reason.

Three non-costs worth naming, because they are what a reviewer will look for.

- **The read path pays nothing.** `lookup`, `readSlice` and the delta-chain walk are byte-for-byte
  the code they are today. The accessor is a distinct entry point with exactly one caller.
- **The scan layer pays nothing.** `scanPacks` already visits every candidate and already
  distinguishes the three outcomes; retaining the fault records replaces a discarded `undefined`
  with a pushed object. The happy path allocates one extra empty array per generation.
- **`fsck` gets *faster* on the refused-pack rows**: nine failed `readObject` calls plus nine failed
  `readRawObject` calls per refused pack disappear with the ids.

One **new** cost exists and belongs to DC-6a/b only: because bit 64 is ungated (Pin K),
`fsck({ full: false })` — a mode chosen precisely to avoid touching packs — must consult the
registry, so it newly reads and parses every `.idx` in the repository. On a many-pack repo that is
the difference between a loose-only scan and a full index scan. Named in DC-6's consequence column
because it is a real argument for (c).

### §D8 — write-path symmetry (explicit checklist)

| question | answer |
|---|---|
| Does this change write anything? | **No.** Read-and-report end to end: one 12-byte read per pack; no file created, modified, renamed or deleted. |
| Any `@writes` annotation churn? | **None.** `tooling/audit-write-surfaces.ts` stays green with no annotation and no allowlist edit (requirement 15). |
| Does reporting a pack change what a *write* does? | **No.** `buildPack` (`build-pack.ts:38`) still sources every object through `readObject`, so an object hidden by a skip still fails push / `bundle create` loudly with `OBJECT_NOT_FOUND` (28.1 requirement 15). Reporting is strictly additive. |
| Could a caller act destructively on a finding? | tsgit exposes no `gc` / `repack` / `prune`, so nothing inside the library can. The finding *is* the signal an external caller needs before deciding to repair or re-fetch — the direction of travel this change enables. Any future pruning surface must consult a **non-degraded** view or refuse, exactly as `git gc` does (28.1 §D8 T-8, re-affirmed). |
| Is there a write-side analogue that should move in step? | **No.** git's `fsck` is read-only; `git repack`/`gc` are the write-side reactions, and tsgit has neither. |
| Does the finding shape constrain a future writer? | Yes, mildly: whatever identifies a pack (DC-4) is the identifier a future repair surface would take as input — an argument for the pack's *name* over a rendered path. |

### §D9 — hash-width genericity (explicit checklist)

| question | answer |
|---|---|
| Does the pass read anything hash-width-dependent? | **No.** It consumes `PackIndex.objectCount` and the 12-byte header, neither of which contains a digest. |
| Does any part branch on `ctx.hashConfig`? | No, and it must not — 28.1 Pin E establishes that pack version is orthogonal to object format (a SHA-256 repo also stamps version 2, and git accepts a v3 SHA-256 pack). |
| Where is hash width load-bearing? | Only in the **fixtures**: re-stamping a mutated pack's trailer digests `pack[0 .. len − digestLength)`. The lifted helpers hard-code SHA-1 and say so, exactly as `pack-version-interop.test.ts` already does. |
| Can the matrix carry a SHA-256 leg? | **No, and not because of this change.** `IDX_SHA_LENGTH = 20` is hard-coded in the idx reader (`pack-index.ts:10`) and writer (`pack-writer.ts:63`); the pack subsystem is SHA-1-only end to end. Unchanged in either direction. |
| Would a later SHA-256 widening invalidate this design? | No. The pass never sees a digest; only the fixtures would change. |

### §D10 — threat model

The subject is an *integrity-reporting* surface over bytes an attacker with repo-write access fully
controls — a `.pack` or `.idx` dropped into `.git/objects/pack/` — and the new consumer of that
report is a caller who may gate CI on the exit code.

| # | concern | assessment |
|---|---|---|
| T-1 | **Reporting is the security content.** Today an attacker who flips one byte in a pack header makes nine objects vanish from every read *and* makes tsgit's integrity command report `badType` on them (Pin O3), or — at the index layer — report nothing at all (Pin O5) while `git fsck` exits 68. A repository can be silently degraded today and still pass tsgit's own integrity check. Closing that is the point of the change; it strictly *adds* signal. | — |
| T-2 | **Eager probing is a new I/O surface.** `health()` reads 12 bytes from every registered pack, so an attacker who drops N `.idx`/`.pack` pairs makes `fsck` issue N extra reads. Bounded by the same directory listing `scanPacks` already walks and already reads a full `.idx` from, so the marginal cost is 12 bytes against a multi-KiB index read — not an amplification vector. No new path is constructed: `packPath` is the value `loadPack` already derived. | accepted |
| T-3 | **The finding carries a pack identifier out of the library as data no sanitiser touches.** `RegisteredPack.name` comes from a `readdir` entry an attacker controls, and the Logger port's sanitiser applies to log arguments, **not** to return values. `isSafePackName` (`pack-registry.ts:134`) already rejects `/`, `\`, `..` and every control character below `0x20` at the scan boundary — that is what makes the name safe to hand out, because no newline can be smuggled into a line-oriented sink downstream. **Load-bearing for DC-4:** the chosen identifier must be one `isSafePackName` has already constrained, and a `path` field would additionally disclose the gitdir layout to a consumer that may not have it. | mitigated by the existing scan-boundary filter; re-state it in the finding's doc-comment |
| T-4 | **A new denial vector on the exit code.** One flipped byte now moves `fsck` from exit 0 to 4 or 68, failing any CI gate keyed on it. This is *faithful* — git does the same — and is the honest signal, not a regression. Suppressing the report requires making the pack healthy again, which is not a suppression. | accepted, and intended |
| T-5 | **The allow-lists must not widen.** They deliberately differ by one code each (`INVALID_PACK_HEADER` at the pack layer, `INVALID_PACK_INDEX` at the index layer). A DRY pass that unioned them would make a **mid-read** `INVALID_PACK_INDEX` from `nextOffsetForEntry` / `buildOffsetTable` (`pack-registry.ts:279`, `:192`) skippable at the lookup layer, converting a detected corruption into a silent miss (28.1 §D9.9). Reporting gives that mistake a *second* way to be wrong: a corruption detected mid-read would then be reported as a whole-pack accessibility fault. The shared helper stays `isSkippableIoFault` and nothing more. | design constraint, tested by the propagation rows |
| T-6 | **`UNSUPPORTED_OPERATION` must not be laundered.** `mapErrno` folds `EMFILE`, `EIO` and every unnamed errno into `UNSUPPORTED_OPERATION { operation: 'filesystem' }`. An `fsck` that reported those as unusable packs would raise a *false* integrity alarm across the whole pack set under load — worse than the silence it replaces, because it is actionable and wrong. `health()` must **reject** (requirement 13); the two propagation rows in §Test strategy forbid a future `catch {}`. | design constraint, tested |
| T-7 | **Alternates.** git sets bit 4 for an inaccessible pack in an *alternate* object directory, printing its absolute path (probed). tsgit's registry scans `packsDir(commonGitDir(ctx))` only. This change neither widens nor narrows that; a repo using alternates gets no pack report for the alternate's packs — a pre-existing enumeration boundary, named in §Out of scope so it is known rather than assumed. | pre-existing, named |
| T-8 | **Symlinked `.pack`.** git registers a pack whose `.pack` is a symlink to a regular file (its sibling test resolves the target); tsgit's lstat-based regular-files-only listing drops it at scan, so it reports as an orphan — silent, exit 0. A deliberate extension of the no-follow policy (28.1 §D9.1), unchanged here, but the reporting surface makes it observable for the first time. | pre-existing, named |

### §D11 — blind spots, named

1. **The orphan arm and the index-fault arm are five lines apart and both return `undefined`
   today.** Requirement 3 versus requirement 2 hangs entirely on keeping them distinct. This is the
   most likely way the change ships subtly wrong; the only defence is two tests that each trigger
   one arm alone.
2. **The `--connectivity-only` inversion (Pin M7) points the opposite way from every other row.**
   Everywhere else the fix *removes* object findings for a refused pack; in connectivity-only mode
   git *adds* them as `dangling unknown`. A reviewer who reads every other row as *refused pack ⇒ no object
   findings* will read the connectivity-only requirement as a bug. DC-8.
3. **Bit 64 names a subsystem tsgit does not have.** Under DC-6a/b tsgit emits
   `EXIT_PACK_REV_INDEX` with no reverse-index reader anywhere in `src/`. It is exit-faithful
   (Pin K-a) and will still be correct when 28.3 lands a real `.rev` reader — but it is a constant
   whose *name* is a promise the code does not yet keep, and the doc-comment must say so.
4. **Bit 64 is ungated while bit 4 is gated** (Pin K), which means `full: false` newly triggers a
   full index scan (§D7). Both consequences will look like bugs in review; they are the ugliest part
   of DC-6a/b and the strongest argument for DC-6c.
5. **`health()` is a footgun on any path but `fsck`.** It opens every registered pack — precisely
   what ADR-572 spent a decision avoiding on the read path — and nothing structurally prevents a
   future caller reaching for it. The cheap durability measure is the §D1 doc-comment plus a
   `find_referencing_symbols` check in review; the structural alternative is DC-1's cost side.
6. **git's cause lines are not always available** (Pin J5, J10: git is silent about *why*), so no
   test can reconstruct git's full stderr for those rows — only the verdict line. The interop matrix
   marks which rows compare a cause.
7. **The `error:` line multiplicity is not stable.** git printed `non-monotonic index` seven times
   in default mode and ten in connectivity-only, because it re-prepares the pack list and retries.
   Per ADR-249 that is presentation; interop assertions must be *verdict-occurs-once-per-pack* and
   never a whole-stderr equality.
8. **The roots axis has a pre-existing shape difference** (Pin M5): git splits root failures between
   stdout `missing blob` (index roots) and stderr `invalid sha1 pointer` (ref roots), while tsgit
   models both as `missing` findings. Not caused or fixed here, which is why the composition interop
   rows assert differentially rather than by exact finding count.
9. **`fetchMissing` builds its own registry** (`fetch-missing.ts:65`), so it gets its own generation
   and its own health view. No `fsck` interaction, but it means the per-`Context` memo is not the
   only one in a process — noted so a "cache the health report globally" idea is refused early.
10. **This design assumes `enumerateObjects` is the only route packed ids take into `fsck`'s
    universe.** Verified today (`fsck.ts:35` is the sole call, and `collectRoots` produces *seeds*,
    not universe members). Nothing enforces it — a future root collector consulting
    `registry.all()` directly would reintroduce D-A silently.

## Decision candidates

Nine load-bearing choices. Each states the constraint that makes it load-bearing; none is decided
here.

### DC-1 — How per-pack health reaches `fsck`

*Constraint:* the scan layer computes the index-fault verdict and discards it; the lookup layer
computes the pack-open verdict **lazily**, so a pack no read ever touches has no verdict at all —
and Pin M1 requires reporting exactly such a pack.

| | option | consequence |
|---|---|---|
| **(a)** | **A `PackRegistry.health()` accessor** returning `{ accessible, unusable }`, fed by the memoised scan (index faults retained) plus an explicit header probe of every registered pack | one accessor, one source of truth, zero public surface (`PackRegistry` is barrel-private); the registry gains a method only `fsck` may call (§D11.5) |
| (b) | A passive **skip ledger** the registry appends to as faults occur, read by `fsck` afterwards | fails Pin M1 — the lookup layer never probes a pack nothing requests, so the ledger is empty for exactly the case that must be reported. Would need `fsck` to force probing anyway, i.e. (a) with extra state |
| (c) | `fsck` probes on its **own** — re-reads the pack directory, re-derives paths, re-parses headers | duplicates `scanPacks` / `loadPack` / both allow-lists; guaranteed to drift from the read path's verdicts, which is the bug class ADR-574 closed by giving the gate one representation |

**Recommendation: (a).**

### DC-2 — Does the health probe open packs eagerly?

*Constraint:* ADR-572 made the gate lazy on purpose and must not regress; but Pin M1/M2 show git's
`fsck` opens **every** pack, including ones no object needs.

| | option | consequence |
|---|---|---|
| **(a)** | **Eager** — `health()` awaits `pack.header()` for every registered pack: one 12-byte `ctx.fs.readSlice` each, no `FileHandle`, reusing the existing memo | faithful to Pin M1/M2; `lookup` untouched; a successful probe warms the memo, a failed one clears it (28.1 Pin C5 preserved) |
| (b) | **Lazy** — report only packs a preceding read already probed | diverges on Pin M1/M2: a refused pack holding objects nothing requests goes unreported, which is the headline case |
| (c) | Add a synchronous `validated` flag to `RegisteredPack` and read it | mutable state on the read path, which 28.1 §D7 explicitly declined for a measurable nothing — and it still needs (a) to populate it |

**Recommendation: (a).**

### DC-3 — One finding variant, or two?

*Constraint:* the two layers differ in git's message (`cannot be accessed` vs `index not opened`)
**and** in exit composition (bit 4 vs bit 4 | 64, Pin K). Message wording is ours under ADR-249; the
exit integer is not.

| | option | consequence |
|---|---|---|
| **(a)** | **Two variants** — `pack-inaccessible` and `pack-index-unusable` | the exit-bit rule becomes a property of the variant, so the pass needs no per-row branching; the caller reconstructs the right git line from the type alone; two entries in `docs/use/commands/fsck.md` and `api.json` |
| (b) | **One variant with a `layer: 'pack' \| 'index'` field** | smaller public surface; the exit-bit rule becomes a conditional on a field — one more mutation-surviving branch, and one more thing a caller can ignore |
| (c) | Reuse `bad-object` with a synthetic id | refused on principle: a pack is not an object and the `id` field would be a lie — precisely the confusion Pin O3 shows tsgit already causing. Listed so it is rejected in writing |

**Recommendation: (a).**

### DC-4 — What identifies the pack in the finding?

*Constraint:* §D10 T-3 — the identifier crosses the library boundary as data no sanitiser
touches, and `isSafePackName` has already constrained the *name* but not a composed path.

| | option | consequence |
|---|---|---|
| **(a)** | **`pack: string`** — the base name (`pack-<sha>`), the value `isSafePackName` already vetted | smallest faithful datum; the caller knows its own object directory and composes git's line from it; a future repair surface takes the same identifier. It is also the **only** field both layers can carry uniformly: an index-layer fault never constructed a `RegisteredPack`, so it has a candidate name and no derived `packPath` — (b) would have to re-derive one for exactly the rows where the derivation is least trustworthy |
| (b) | **`path: string`** — the derived `.pack` path | reconstructs git's line without the caller knowing the layout, but discloses the gitdir path and differs by adapter (browser paths are `/`-rooted). git itself prints a *relative* path for the local dir and an *absolute* one for an alternate, so "verbatim" is not even well-defined |
| (c) | Both fields | maximal caller convenience, largest disclosure, two fields to keep consistent |

**Recommendation: (a).**

### DC-5 — How `fsck`'s universe drops inaccessible packs

*Constraint:* requirement 7 needs the narrowing; requirement 9 and Pin M1's `cat-file
--batch-all-objects` column forbid narrowing it for anyone else.

| | option | consequence |
|---|---|---|
| **(a)** | **`EnumerateObjectsOptions` gains an accessibility knob** (default = today's behaviour); `fsck` opts in | one optional public field, one `api.json` delta, one doc-page row; the primitive stays the single enumeration route. **Costs a second `health()` call per run** — cheap (only failed packs re-probe) but it doubles the per-unusable-pack warn (§D4) |
| (b) | **`fsck` composes the universe itself** — loose ids from `enumerateObjects({ includePacks: false })` unioned with `allObjectIds` over the health report it already holds | zero public delta, **one** `health()` call, one warn per pack; duplicates six lines of `collectPackedObjectIds` inside a command, which is the layering `enumerate-objects.ts` exists to prevent |
| (c) | `enumerateObjects` always filters | refuted by Pin M1 — git's own enumeration surfaces *do* list a refused pack's ids — and it would silently change `resolveOidPrefix` |

**Recommendation: (a).** (b) is a genuine contender if the public-surface delta or the double probe
is unwelcome; the choice is a layering-versus-surface trade, not a correctness one.

### DC-6 — Does tsgit model git's exit bit 64?

*Constraint:* Pin K. An unusable `.idx` gives git **68** in full mode and **64** in
`--connectivity-only` / `--no-full`, and Pin K-a proves bit 64 fires with **no `.rev` file on
disk** — it is a consequence of the index fault, not of reverse-index support. tsgit has no `.rev`
reader (28.3). The prime directive binds the exit integer.

| | option | consequence |
|---|---|---|
| **(a)** | **Model the bit *and* an ungated third finding variant** (`pack-rev-index-unusable`) | exact exit parity on every Pin K cell, and a nonzero exit always has a finding explaining it. In **full** mode one unusable `.idx` then yields **two** findings for the same pack — the gated index-unusable one and the ungated rev-index one — which is faithful: git emits both `index not opened` **and** `unable to load rev-index` for that pack (Pin J8). Three public variants; the ungated evaluation makes `full: false` read every `.idx` (§D7, §D11.4) |
| (b) | **Model the bit as a bare bit, no finding** | exact exit parity with two variants instead of three; but a caller can receive `exitCode === 64` with an **empty** `findings` array in connectivity-only mode — a nonzero exit nothing explains, which is poor for a structured-output API |
| (c) | **Bit 4 only** — exit 4 / 0 / 0 where git gives 68 / 64 / 64 | simplest, and honest about what tsgit knows; no constant naming an absent subsystem; `full: false` stays loose-only. Costs a named, ADR-recorded exit divergence in a family whose entire point is exit-code faithfulness, and 28.3 must revisit it |

Refuted in writing: *gate bit 64 on the presence of a `.rev` file* — Pin K-a shows git emits it with
no `.rev` on disk.

**Recommendation: (a).**

### DC-7 — How much of git's bit-4 surface does this change claim?

*Constraint:* Pin N — git folds a full `verify_pack` (trailer checksum, per-object index CRC,
inflate of every object) into the same bit 4. The no-follow-ups directive means the boundary must be
drawn deliberately, not deferred.

| | option | consequence |
|---|---|---|
| **(a)** | **Accessibility only** — the header gate and whether the index can be opened, i.e. exactly what the registry already computes | matches the backlog's scope; zero new parsing. The pack-body integrity surface is named in §Out of scope as a *distinct capability* (a `verify-pack` analogue tsgit has never had), not as a deferred piece of this feature |
| (b) | **Accessibility + the pack trailer checksum** — one `digestLength`-byte read and one digest over the pack body per pack | closes the cheapest slice of Pin N; turns an O(packs) probe into O(pack bytes) on every `fsck` — the same trade 28.1 §Out of scope declined for the read path |
| (c) | **Full `verify_pack`** — inflate and CRC every packed object | complete bit-4 parity; a different feature by size, overlapping the content-validation pass that already inflates every object by a different route |

**Recommendation: (a),** with the residual stated in §Out of scope. This is the decision most
affected by the no-follow-ups directive and should be taken explicitly rather than inherited.

### DC-8 — Is the `--connectivity-only` `dangling unknown` divergence closed here?

*Constraint:* Pin M7 — git's connectivity-only mode enumerates a refused pack's ids and reports each
as `dangling unknown`. tsgit reports nothing (Pin O8), because `collectTypeFindings`
(`reachability.ts:204-217`) skips null-cache entries and `FsckFinding['dangling'].objectType` is
`FsckObjectType` with no `'unknown'` member. The divergence became reachable *because of 28.1* (a
v99 pack used to be read as v2), which is what makes it arguably in-family. The exit codes already
agree; only the findings differ.

| | option | consequence |
|---|---|---|
| (a) | **Close it** — widen `dangling`/`unreachable` `objectType` to `FsckObjectType \| 'unknown'` and stop skipping null-cache entries | exact parity in all three modes; a public type widening that changes findings for rows this brief does not cover — **any** unreadable loose object starts producing `dangling unknown` too, which needs its own git pins |
| **(b)** | **Leave it, name it** as a residual: it is an *unreadable-object classification* question, not a pack-accessibility one, and it predates this change for loose objects | keeps the blast radius on the pack axis; ships one known divergent cell in a mode this feature otherwise makes faithful |
| (c) | **Close it only for objects whose pack is inaccessible** | parity on the row that matters with no loose-object churn; a special case keyed on pack health inside the classifier — the kind of conditional §D11.10 warns about |

**Recommendation: (b)** — but the no-follow-ups directive makes this the user's call, since (b)
means shipping a known divergent cell rather than filing it.

### DC-9 — Where the pass lives

| | option | consequence |
|---|---|---|
| **(a)** | **`src/application/commands/internal/fsck/pack-health.ts`**, exporting `runPackHealthPass` | matches `runContentValidationPass` / `runRefsVerifyPass` exactly; command-internal, invisible to `api.json` |
| (b) | Inline in `fsck.ts` | `fsck.ts` is 104 lines and already at the limit of what reads as one function; the pass would add a third concern |
| (c) | A Tier-2 primitive `checkPackHealth(ctx)` exported from `primitives/index.ts` | reusable and independently documented; adds a public export → `api.json` entry, a doc-coverage page, and a surface commitment for a capability with exactly one caller |

**Recommendation: (a).**

## Test strategy

### Unit — `test/unit/application/primitives/pack-registry.test.ts` (extend)

Existing fixtures: `buildSeededContext` (`./fixtures.js`), `buildSyntheticPack` /
`writeSyntheticPack` (`./pack-fixture.js`); the version/count restamp helper 28.1 added is reused.
`sut` = the registry.

| case | arrangement | expectation |
|---|---|---|
| healthy | one good pack | `accessible` = [that pack]; `unusable` = `[]` |
| v99 | version field 99, trailer restamped | one `unusable` entry, pack layer, `INVALID_PACK_HEADER`, reason names the version |
| count disagreement | header count = `index.objectCount + 1` | **its own `it`** — a row that also breaks the version proves nothing about ADR-577's comparison; reason names **both** counts |
| bad signature | `PACX` | pack layer; reason contains `magic` |
| short pack | truncated to 8 bytes | pack layer; reason contains `truncated` |
| `.pack` unopenable — `FILE_NOT_FOUND` | probe rejects ENOENT | pack layer; **own `it`** (isolated-guard rule over `isSkippableIoFault`'s `\|\|`) |
| `.pack` unopenable — `PERMISSION_DENIED` | probe rejects EACCES | pack layer; **own `it`** |
| `.idx` unparseable | same-length byte ramp | index layer, `INVALID_PACK_INDEX`; pack absent from `accessible` |
| `.idx` unreadable — `PERMISSION_DENIED` | `ctx.fs.read` rejects | index layer; own `it` |
| `.idx` vanishes after `readdir` — `FILE_NOT_FOUND` | `stat` rejects | index layer; own `it` |
| `.idx` over `MAX_PACK_IDX_BYTES` | stat reports oversize | index layer, reason exactly `REASON_PACK_IDX_EXCEEDS_MAX`, **and `expect(reads).toEqual([])`** — the pre-read allocation guard 28.1 pins must survive this change verbatim |
| **orphan `.idx`** | `.idx` written, `.pack` never present | **absent from `unusable` and from `accessible`** — the requirement-3 row, its own `it` |
| **idx-less `.pack`** | `.pack` only | never a candidate; absent from both |
| unrecognised fault, pack layer | probe rejects `UNSUPPORTED_OPERATION { operation: 'filesystem' }` | `health()` **rejects** with that exact `.data` |
| unrecognised fault, index layer | `ctx.fs.read` rejects the same | `health()` **rejects** |
| non-`TsgitError` | plain `Error` from `read` | propagates — asserted for `health()`, not only for the existing scan test |
| memo warming | healthy pack, `health()` then `lookup` | **one** header read total (requirement 10) |
| no negative cache | v99, `health()` then `lookup` | **two** probes — the memo cleared on rejection (28.1 Pin C5) |
| `all()` unchanged | v99 pack | `all()` still lists it (requirement 9) — fails if the filter is wired into the wrong accessor |
| disposed registry | `dispose()`, then `health()` | resolves against the peeked generation; starts no scan (ADR-569) |
| handle ledger | any row | opened-minus-closed after `dispose()` is 0 (requirement 11) |
| `refresh()` | fault → repair the file → `refresh()` → `health()` | the pack moves from `unusable` to `accessible`; nothing remembers it as bad |
| two unusable packs | one v99 + one corrupt `.idx` | **two** entries, one per layer — kills `ArrayDeclaration -> []` and a `break`-for-`continue` mutant |

### Unit — `test/unit/application/commands/fsck.test.ts` (extend)

`sut` = `fsck`. Every row asserts `exitCode` **and** the finding array, because the two move in
opposite directions (Pin O: nine findings must disappear as the bit appears).

| case | expectation |
|---|---|
| healthy pack | no pack finding; bit 4 absent |
| v99 pack, objects only there | exactly one pack finding; bit 4 set; **zero** findings carrying an id from that pack — asserted positively, not as "no `bad-object`" |
| header/index count disagreement | same shape |
| `.idx` corrupt | one index-layer finding; bits per DC-6 |
| **orphan `.idx`** | **no finding, `exitCode` 0** — own `it` |
| two unusable packs | two findings; bit 4 set once |
| v99 **+** healthy twin (Pin M3) | the objects are still classified `dangling`/`unreachable` **and** the pack is reported |
| v99 holding every reachable object (Pin M5) | pack finding **plus** `missing` + `broken-link`; bits 2 and 4 both set (requirement 8) |
| `connectivityOnly: true` | no pack finding; bit 4 absent — own `it` |
| `full: false` | no pack finding; bit 4 absent — own `it`, because one test setting both options proves neither gate |
| `strict: true` | bit 4 unchanged (Pin K) |
| DC-6a/b only: `connectivityOnly` + corrupt `.idx` | bit 64 present, bit 4 absent — the row that isolates the ungated term |

### Integration / interop — **new** `test/integration/fsck-pack-accessibility-interop.test.ts`

`@proves` block with `surface: fsck.packAccessibility`, `bucket: cross-tool-interop`,
`interopSurface: fsck`. Helpers `GIT_AVAILABLE`, `git`, `runGitEnv`, `tryRunGitWithExit` from
`./interop-helpers.js`.

**Helper lifting (P10).** The crafting helpers this needs — `restampPackVersion`,
`restampIdxForPack`, `corruptIdxSameLength`, `setHeaderObjectCount`, `trailerOf`, `writePack`,
`writePackOnly`, `writeIdxOnly`, `readSolePackPair`, `countObjects` — all exist today inside
`test/integration/pack-version-interop.test.ts` (≈ lines 40–215). They move to a shared
`test/integration/pack-fixture-helpers.ts` that both suites import. Copying them would guarantee the
two interop suites drift on the one recipe that must stay identical.

**Three harness rules this suite must obey.**

- One shared `beforeAll` repo family and a 60 s timeout — heavy git-spawning interop suites time out
  hooks under `validate`'s concurrency.
- **Build the tsgit `Context` *after* every `git` subprocess write.** The per-`Context` loose-object
  fanout cache is invalidated only by tsgit's own `writeObject`, so a `Context` created before a
  `git repack` sees a stale loose view. Every row here writes with `git` first.
- Delete each fixture's `.rev` before mutating, or the reverse-index axis contaminates the pack rows
  (the same discipline the pins used).

| # | row | git assertion | tsgit assertion |
|---|---|---|---|
| K-1 | healthy pack | exit 0, no `packfile` line | no pack finding; bit 4 absent |
| K-2 | pack v3 | exit 0 | no pack finding |
| K-3 | **pack v99** | exit **4**; the reconstructed verdict line occurs **once** | one pack finding; bit 4; **zero** object findings from that pack |
| K-4 | header/index count disagreement | exit 4; cause `claims to have N objects while index indicates M objects` | one finding whose reason carries both counts |
| K-5 | signature `PACX` | exit 4; cause `is not a GIT packfile` | one finding |
| K-6 | pack truncated to 8 bytes | exit 4; cause `far too short to be a packfile` | one finding |
| K-7 | `.pack` `chmod 000` | exit 4; **verdict only**, no cause (Pin J5) | one finding; node tier only (no `chmod` on the other adapters) |
| K-8 | `.idx` same-length garbage | exit **68** | one index-layer finding; bits per DC-6 |
| K-9 | `.idx` truncated to 8 bytes | exit 68 | same |
| K-10 | `.idx` `chmod 000` | exit 68; verdict lines only (Pin J10) | same; node tier only |
| K-11 | **orphan `.idx`** | exit **0**, silent | **no finding**; `exitCode` 0 |
| K-12 | **idx-less `.pack`** | exit 0, silent | no finding |
| K-13 | two unusable packs | exit 4; the verdict line occurs **twice**, once per pack | two findings; bit 4 once |
| K-14 | v99 **+** healthy twin (Pin M3) | exit 4 **and** the objects still reported | objects classified; pack reported |
| K-15 | v99 **+** a deleted reachable tree | exit 14 | **differential**: the non-pack bits equal what the *same repo without the bad pack* produces, and bit 4 is the only added term |
| K-16 | v99 **and** corrupt `.idx`, same pack (Pin J15) | exit 68; **no** version line | exactly one finding, index layer — the precedence row |
| K-17 | mode gating | `--connectivity-only` and `--no-full` on the v99 and corrupt-idx repos: 0 / 0 / 64 / 64 | `connectivityOnly` and `full: false` reproduce the same four exits |
| K-18 | `--strict` | exit 4 unchanged | `strict: true` unchanged |
| K-19 | **v99 pack holding every reachable object** (Pin M5) | exit 14 | **differential** as K-15 — bit 4 is the only term the bad pack adds; `missing` findings present (requirement 8, §D11.8) |

**Assertion discipline.** Per §D11.7 the cause lines repeat a non-deterministic number of times;
every git-side assertion is *the verdict line occurs exactly once per unusable pack*, never a
whole-stderr equality. Per ADR-249 the verdict line is **reconstructed inside the test** from the
finding's fields (e.g. `` `packfile ${packDir}/${finding.pack}.pack cannot be accessed` ``) and
compared — the library composes no string.

### Parity — cross-adapter

One scenario under `test/parity/scenarios`: a repo with one corrupt `.idx` and one v99 pack read
through node, memory and browser adapters, asserting the identical `FsckResult`. It earns its place
for the same reason 28.1's second parity scenario did: the discriminators key on `FILE_NOT_FOUND` /
`PERMISSION_DENIED`, which each adapter produces independently (node via `mapErrno`, memory via an
explicit `fileNotFound` throw, browser via `resolveFileHandle`), and a *reporting* surface turns an
adapter-specific code difference into a **missing finding** rather than a thrown error — silent
where the old behaviour was loud. The `chmod`-based rows (K-7, K-10) stay node-only.

### Property-based testing — **lens 2 applies**; extend the existing sibling

`test/unit/application/commands/fsck.properties.test.ts` already exists and already works lens 2
(compositional invariants over the reachability closure: I1–I5, including *"adding exactly one
unreachable blob adds exactly one `dangling` finding"* and *"a missing referent sets exit bit 2"*).
This change's surface fits the same lens and the file gains two invariants — **not** a new file.

- **I6 — additivity.** For an arbitrary healthy repo, dropping in **one** unusable pack (fault shape
  drawn by `fc.constantFrom` over the enumerated set: v99, bad signature, short pack, count
  disagreement, unreadable `.pack`, garbage `.idx`, truncated `.idx`) adds **exactly one** pack
  finding, sets bit 4, and leaves the non-pack findings **set-equal** to the same repo's baseline
  run. This is the invariant that catches "the pack pass perturbed the object universe" across
  arbitrary graphs, which no fixed fixture can — and requirement 7's most likely failure mode is
  precisely a narrowing that removes one object too many.
- **I7 — cardinality and bit idempotence.** For an arbitrary healthy repo and arbitrary `N` in
  `[1, 4]`, `N` unusable packs add **exactly `N`** pack findings while bit 4 is set exactly once
  (`|` is idempotent). No finite example table proves this for arbitrary `N`; the two-pack example
  row only proves it for `N = 2`.

Not a tautology: the oracle is the *baseline run of the same repo*, not a re-implementation of the
classifier. `numRuns: 50` — each run constructs a repo and crafts a pack fixture, so this is the
expensive tier, and both invariants are structural rather than statistical.

The lenses that do **not** fit, stated so the omissions are deliberate: no **round-trip pair**
(nothing serialises a health report); no **total function over an algebraic grammar** (the fault
domain is a four-member set of `TsgitError` codes crossed with two layers — a parameterised example
sweep is clearer than an arbitrary); no **idempotence** axis beyond I7's bit fold.

### Mutation

- **The layer classifier** is a `LogicalOperator` chain over `||`, the same shape as the two existing
  allow-lists, so per the isolated-guard rule every recognised code needs an arrangement that
  triggers **it alone**: `INVALID_PACK_HEADER`, `INVALID_PACK_INDEX`, `FILE_NOT_FOUND`,
  `PERMISSION_DENIED` — four rows per layer, plus the two `UNSUPPORTED_OPERATION` propagation rows
  that kill "force the predicate true", plus the plain-`Error` row that kills the
  `err instanceof TsgitError` operand.
- **The mode gate** is `opts.full !== false && opts.connectivityOnly !== true` — one
  `LogicalOperator` and two `ConditionalExpression`s. One test setting both options kills neither;
  the two gating rows must be separate `it`s.
- **The exit-bit OR** is an `AssignmentOperator` / `ArithmeticOperator` target. A row where bit 4
  fires **alone** (K-3) and a row where it composes with bit 2 (K-15, K-19) are both required: with
  only the first, `|` → `&` survives against a zero accumulator.
- **The orphan branch** is a `BlockStatement` whose deletion violates requirement 3 only in the row
  that has an orphan and nothing else — K-11 is the only test that kills it.
- **The health accumulation** needs the two-unusable-packs row to stop `ArrayDeclaration -> []` and
  a `break`-for-`continue` mutant surviving against a single-pack matrix.
- Under DC-6a/b the bit-64 term is a second `ArithmeticOperator` needing its own isolating row —
  K-17's connectivity-only leg, where bit 4 is absent and 64 must still appear.

### Gates

`npm run validate`, plus:

- **`reports/api.json` will change** — the new `FsckFinding` variant(s) and, under DC-5a, the
  `EnumerateObjectsOptions` field. The regenerated report must be committed or the prepush
  `check:doc-typedoc` gate fails; a large typedoc-id diff is normal.
- **`docs/use/commands/fsck.md`** — three places, not one: the `FsckFinding` union block, the
  **composite-bitmask table** (which today enumerates only `0 / 1 / 2 / 3 / 8 / 10` and must gain
  `4`, `6`, `14` and, under DC-6a/b, `64` and `68`), and the finding-reference table.
- **`docs/use/primitives/internals.md`** — if DC-5a lands.
- **`check:doc-coverage`** for any newly public symbol (none under the recommended options; one
  under DC-9c).
- `tooling/audit-write-surfaces.ts` unchanged (requirement 15).
- Per the cached-validate note: re-run `cspell` fresh and regenerate `api.json` before pushing — a
  green wireit-cached `validate` can still precede a red prepush.

## Out of scope

- **Pack-body integrity verification** — git's bit 4 also covers the pack trailer checksum,
  per-object index CRC and inflate failures (Pin N). Under DC-7a this change reports *accessibility*
  only. The residual is a distinct capability (a `git verify-pack` analogue, which 28.1 §Out of
  scope already recorded tsgit as lacking), not a deferred slice of this feature — the boundary is
  drawn by DC-7 rather than assumed.
- **Reverse-index (`.rev`) and bitmap reading** — 28.3. Under DC-6a/b this change emits git's
  rev-index *exit bit* without reading a `.rev` file, which is exit-faithful (Pin K-a) and leaves
  28.3 with nothing to correct.
- **Multi-pack-index health** — 28.2. git has its own `ERROR_MULTI_PACK_INDEX` bit (32); tsgit reads
  no midx, so no midx can be unusable.
- **Alternates** — git reports an inaccessible pack in an alternate object directory with bit 4 and
  an absolute path (§D10 T-7). tsgit's registry scans the common gitdir's pack directory only; this
  change neither widens nor narrows that boundary.
- **Symlinked `.pack`** — tsgit's regular-files-only scan drops it as an orphan where git resolves
  and registers it (§D10 T-8). A deliberate extension of the no-follow policy, unchanged here.
- **The `--connectivity-only` `dangling unknown` classification** — DC-8b, if taken.
- **The roots-axis reporting shape** — git splits root failures between stdout `missing blob` and
  stderr `invalid sha1 pointer` (Pin M5); tsgit models both as `missing`. Pre-existing, unchanged,
  and the reason the composition interop rows assert differentially (§D11.8).
- **Stderr transcript parity** — per ADR-249 git's `error:` lines are presentation; tsgit emits none
  and is not expected to. The interop tests reconstruct them from structured fields.
- **Changing `registry.all()` semantics** — ADR-575 pinned it against `count-objects`
  (`packs: 1` / `in-pack: 9` for a refused pack) and Pin M1 re-confirms it against `cat-file
  --batch-all-objects`. Only `fsck`'s universe narrows.
