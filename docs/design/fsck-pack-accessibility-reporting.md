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
> Status: **revised against ADR-581 … ADR-591** (2026-08-07). All ten decision candidates are
> settled — eight adopted as recommended, two ruled by the user against this document's own reading:
> **DC-8** closes the `--connectivity-only` `dangling unknown` divergence *fully* (ADR-588, option
> (a)), overriding the design's "leave it, name it"; **DC-10** — raised by the pins that ruling
> commissioned — makes `fsck` **reject** on the one loose-object fault class git `die()`s on
> (ADR-590, option (a)), where the design deliberately gave no recommendation. Both are folded in
> below as real design content: the classification closure is **§D12**, the reject mechanism
> **§D13**. The rows they reach are pinned empirically in **§Pin P**, **§Pin Q** and **§Pin R** —
> the last commissioned by ADR-590, because the ruling's phrase *"opened but undecodable"* has a
> boundary no code reading fixes.
>
> **ADR-591** then closes the one residual those pins left standing (§D11.16): an unreachable object
> is typed from its **recovered header**, so `objectType: 'unknown'` becomes a *reserved* verdict —
> the exact set git prints `dangling unknown` for — rather than tsgit's generic read-failure label.
> The mechanism is **§D13.8**; it reuses what §D13.1 and §D13.2 already compute and changes no abort
> verdict, no exit code and no public type. Its one previously unpinned leg — a **delta-stored**
> packed entry — is **§Pin R13**. Nothing in this document is open.

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

**Four distinct divergences, not one.** The first three are the pack axis the brief names; the
fourth (D-D) is the *unreadable-object classification* axis that ADR-588 pulled into scope.

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
4. **D-D — unreadable objects are classified as nothing at all in `--connectivity-only`.** git
   enumerates every id it can name and reports each one it cannot type as `dangling unknown <oid>`
   (Pin M7 for a refused pack's ids, **Pin P1/P4** for a loose object). tsgit reports nothing,
   because `collectTypeFindings` (`reachability.ts:204-217`) skips null-cache entries and
   `FsckFinding['dangling'].objectType` has no `'unknown'` member. **ADR-588 closes this**, and the
   closure reaches beyond the pack axis: any *loose* object tsgit cannot read is affected too. The
   arrangement that isolates this axis is a repo with **no packs at all** and one damaged loose
   object, so every cell is attributable to the object alone (§Pin P). One sub-class of it is then
   carved back out by **ADR-590**, because git does not classify that one — it dies (§Pin R, §D13).

### Premises of the brief, checked against the code

| # | brief premise | verdict |
|---|---|---|
| B-1 | *"a pack refused at the header gate … makes its objects report missing"* | **false, and worse than stated.** They report `bad-object / badType` with exit bit 1 (Pin O row 3). `missing` would at least be a connectivity finding; `badType` asserts the *object* is malformed. |
| B-2 | *"`fsck` walks a clean graph and exits 0"* | **true for the scan layer only** (D-B, Pin O row 5). For the lookup layer the graph is not clean and the exit is 1. |
| B-3 | *"real git's `fsck` … sets exit bit 4"* | **correct, and narrower than the whole story.** Bit 4 is git's `ERROR_PACK`. An unusable `.idx` additionally sets bit **64**, so git's exit for that family is **68**, not 4 (Pin K). Bit 64 fires with no `.rev` file on disk (Pin K, isolation row K-a), i.e. it is a function of the index fault, not of reverse-index support. ADR-586 models it. |
| B-4 | *"Requires deciding how `registry.all()`/a health accessor exposes skip records to `fsck`"* | correct, and it is **two** questions: how the *scan-layer* skips (discarded today) are retained, and how the *lookup-layer* verdicts are obtained for packs no lookup ever touches. ADR-581 and ADR-582. |
| B-5 | implicit: bit 4 covers exactly the accessibility conditions the registry already computes | **false.** git also folds a full `verify_pack` — per-object CRC, inflate, and the pack trailer checksum — into bit 4 (Pin N). Accessibility is a *subset* of git's bit-4 surface. ADR-587 claims only the subset. |
| B-6 | implicit: the finding surface is additive to `FsckFinding` | correct, and `FsckFinding` is **public** — 9 occurrences in `reports/api.json`, documented in `docs/use/commands/fsck.md`. `PackRegistry` / `RegisteredPack` are **not** (0 occurrences), so a registry accessor costs zero public surface. |

### Subsystems this touches

| Part | File / symbol | Tier |
|------|---------------|------|
| P1 | `src/application/primitives/pack-registry.ts` → `loadCandidatePack` (`:295-318`) stops collapsing three outcomes into `RegisteredPack \| undefined`; `scanPacks` (`:321-338`) accumulates skip records beside packs; `PackRegistry` (`:118`) gains one accessor (ADR-581). `all()` / `lookup()` / `refresh()` / `dispose()` **unchanged** | primitive |
| P2 | `src/application/primitives/enumerate-objects.ts` → `EnumerateObjectsOptions` gains an accessibility knob whose default preserves every existing consumer (ADR-585) | primitive (**public**) |
| P3 | **new** `src/application/commands/internal/fsck/pack-health.ts` → the third sibling of `runContentValidationPass` / `runRefsVerifyPass` (ADR-589) | command-internal |
| P4 | `src/application/commands/internal/fsck/exit-codes.ts` → `EXIT_PACK = 4` **and** `EXIT_PACK_REV_INDEX = 64` (ADR-586) | command-internal |
| P5 | `src/application/commands/internal/fsck/types.ts` → three new `FsckFinding` variants (ADR-583, ADR-584, ADR-586); the `dangling` / `unreachable` `objectType` widens to `FsckObjectType \| 'unknown'` (ADR-588, §D12); the shared `UnreadableMode` (`'skip' \| 'classify'`) both §D12 and §D13 key on — **not** re-exported, so it stays out of `api.json`; **and** `FsckResult.exitCode`'s doc-comment, which today reads *"0=clean, 2=missing/broken-link"* and is already stale (it names neither bit 1 nor bit 8) | command-internal (**public**) |
| P5b | `src/application/commands/internal/fsck/reachability.ts` → `collectTypeFindings` (`:204-217`) stops skipping null-cache entries under the connectivity-only gate (ADR-588, §D12) and both it and `resolveObjectType` (`:220-226`) take the retention map (ADR-591, §D13.8); the stale `// Stryker disable` at `:163` is **removed**, not re-justified (§D12.4) | command-internal |
| P5c | `src/application/commands/internal/fsck/object-cache.ts` → `buildObjectCache` (`:21-38`) takes the mode, returns `{ cache, unrecoverable, recovered }` instead of the bare map, and its blanket `catch` gains the one probe that answers both the abort question (ADR-590, §D13) and the stored-type question (ADR-591, §D13.8), plus the `assertTypesRecoverable` guard; the `// Stryker disable` at `:32` is **removed** (§D13.6) | command-internal |
| P6 | `src/application/commands/fsck.ts` → call the pass, OR its bit into `exitCode` (`:101`), narrow the universe (`:35`), compute `UnreadableMode` once and thread it into `buildObjectCache` (`:40`) and `collectTypeFindings` (`:93-94`), thread the retention map into `collectTypeFindings` and `resolveObjectType` (`:87`), call the recoverability guard after `classifyObjects` (`:70`) | command |
| P7 | `test/unit/application/primitives/pack-registry.test.ts` → the health matrix | test |
| P8 | `test/unit/application/commands/fsck.test.ts` → pass, gating and composition matrix; `test/unit/application/commands/fsck.properties.test.ts` → two added lens-2 invariants (§Test strategy) | test |
| P9 | **new** `test/integration/fsck-pack-accessibility-interop.test.ts` | test |
| P10 | `test/integration/pack-version-interop.test.ts` → its crafting helpers lift into a shared module (§Test strategy) | test |
| P11 | `docs/use/commands/fsck.md`, `docs/use/primitives/internals.md`, `reports/api.json` | docs |

### Decisions settled for this change

Every decision candidate below is now an ADR. Eight were adopted as the design recommended; **two
were ruled by the user** where the design recommended otherwise (DC-8) or declined to recommend at
all (DC-10), and those two rulings are the reason this document was revised twice.

| DC | ADR | Outcome |
|---|---|---|
| DC-1 | **581** | (a) a `PackRegistry.health()` accessor — as recommended |
| DC-2 | **582** | (a) eager probe through the existing `header()` memo — as recommended |
| DC-3 | **583** | (a) two finding variants, one per layer — as recommended |
| DC-4 | **584** | (a) the finding carries the pack **base name** — as recommended |
| DC-5 | **585** | (a) an `EnumerateObjectsOptions` accessibility knob — user-ratified |
| DC-6 | **586** | (a) model exit bit 64 **with** an ungated finding variant — user-ratified |
| DC-7 | **587** | (a) accessibility only; pack-body verification is a capability boundary — user-ratified |
| DC-8 | **588** | **(a) close the `dangling unknown` divergence fully — deviates** from the design's (b) |
| DC-9 | **589** | (a) the pass lives in `internal/fsck/pack-health.ts` — as recommended |
| DC-10 | **590** | **(a) `fsck` rejects on an undecodable loose object in `connectivityOnly`** — user-ratified against no recommendation; mechanism in §D13 |

One further ruling is not a decision candidate but a **residual closure**: **ADR-591** settles the
type-resolution residual §D11.16 named, which no DC raised because it only became visible once
ADR-588's closure started emitting the field. It refines ADR-588 rather than re-opening it —
mechanism in **§D13.8**.

### Constraining prior decisions

| ADR / rule | What it binds | How this design stands to it |
|---|---|---|
| **ADR-226** (git-faithfulness prime directive) | observable behaviour byte-for-byte unless an ADR diverges | every accept/refuse/exit cell below is executed, and the tsgit "today" column is executed too, so the before/after claims are falsifiable in both directions |
| **ADR-249** (structured data, not cosmetics) | the *condition* and the *exit code* are git's; the rendered line is the caller's | the findings carry the pack identity and a structured reason; **no** git stderr text is composed in `src/`. The interop test reconstructs git's line from the fields and compares (§Test strategy) |
| **ADR-572** (the local pack gate sits in `lookup`) | the gate is lookup-positioned and **lazy** — a pack whose index does not claim a requested object is never opened; `all()` stays ungated | **must not regress.** `lookup`'s body is unchanged. The health probe is a *separate entry point* with exactly one caller (ADR-582); it awaits the **same** `header()` memo rather than duplicating it, so a successful probe makes later lookups cheaper and a failed probe still clears the memo — 28.1's Pin C5 (*no negative cache*) survives untouched, and the refusal reason cannot drift between callers because only one site computes it |
| **ADR-573** (a refused pack degrades per pack) | a refused pack's objects report `OBJECT_NOT_FOUND`, one logger warn, nothing else fails | unchanged on the read path. `fsck` now *additionally* reports the pack, which is what git does — the read path stays quiet, the integrity command becomes loud |
| **ADR-575** (full per-pack registry degradation) | an index-layer fault excludes the pack from the generation; `all()` matches git's `packs: 0` | unchanged. The design does **not** put those packs back into `all()`; it retains their *skip records* alongside (§D1), a strictly additive channel |
| **ADR-577** (the gate cross-checks `objectCount`) | a header/index count disagreement is a skippable pack fault carrying `INVALID_PACK_HEADER` | reused verbatim: one more `unusable` row with one more reason, and git agrees (Pin J4) |
| **ADR-579 / ADR-580** (orphaned `.idx` excluded at scan, warned once per generation) | an orphan never becomes a `RegisteredPack`; one warn per generation | **must not become a finding** — git's `fsck` is silent and exits 0 (Pin J11). §D1 keeps the orphan arm and the fault arm distinct |
| **ADR-566 … ADR-571** (promise-memo / handle lifecycle) | every lazy initializer crossing an `await` is a `createPromiseMemo`; no handle may become unreachable; `dispose()` is terminal | the probe calls the existing `header()` memo, which reads via `ctx.fs.readSlice` and owns **no** `FileHandle` (28.1 §D7). Zero new orphaning surface; the accessor obeys the same terminal-disposal rule as `all()` (§D1) |
| **ADR-510** (persistent per-pack `FileHandle`s) | the registry owns one lazily-opened handle per pack | untouched: the probe never reaches `pack.readSlice` |
| **ADR-050** (cache-invalidation policy) | event-driven invalidation for caches that can go stale | health is derived from the scan memo and the per-pack header memos; `refresh()` discards both together, so no new invalidation rule appears |
| **ADR-411** (flat finding union; maximal taxonomy, caller filters) | one `readonly` discriminated union on `type`; selection flags are caller-side projections, not options | the three new pack variants extend the same union; §D12's widening adds no variant, only a member to two existing `objectType` fields. It is also why tsgit emits `unreachable` **and** `dangling` where git prints only `dangling` — a projection difference, not a divergence (§Pin O caveat). **ADR-590 carves the one exception to its always-compute-and-return premise**, and scopes it as narrowly as the pins allow: in `connectivityOnly`, one fault class over one object set withholds the taxonomy entirely rather than returning it (§D13), because git withholds its own (Pin R6) |
| **ADR-412** (full msg-id catalogue is in v1) | `bad-object` reproduces git's named checks with git's severity classes | §D12 must not let the widened classifier *duplicate* a `bad-object` the content pass already emits for the same id — the two live in modes that are mutually exclusive (Pin P), which is what makes the mode gate load-bearing rather than cosmetic |

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

**Reading order.** The sections are grouped by *tool*, not alphabetically: **J, K, L, M, N, P, Q, R**
pin **git**; **O** and **O′** pin **tsgit today** against the identical fixtures. P and Q were added
in the ADR-588 revision and R in the ADR-590 one; all three keep the git group contiguous rather than
taking the next free letter after O. Two arrangements are in play — the pack rows use the foreign-pack
recipe above, while **Pin P, Pin R and Pin O′ use a repo with no packs at all** (except Pin R's two
explicitly packed rows), so the loose-object axis is isolated from it.
One further discipline applies only to the loose rows: git writes loose objects `0444`, so every
mutation is preceded by `chmod u+w`. A probe that omits it fails silently and measures a healthy
repo — which is how the first run of this matrix produced five false "no divergence" cells.

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
  from the `.idx`. ADR-586 turns on this cell.
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
and (per ADR-586) fifth independent term to the same OR at `fsck.ts:101`.

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
| M7 | v99 pack, `--connectivity-only` | **exactly `U`** × `dangling unknown <oid>` on stdout, one `error: Unknown object type for <oid>` each on stderr, **no bit 4**, exit **0** — where `U` = the number of the pack's oids readable through **no other source** (§Pin Q) | — | — |
| M8 | v99 pack, `--no-full` | **empty**, exit **0** — `--no-full` drops packed objects from the universe entirely, so not even `dangling unknown` appears (§Pin Q) | — | — |

**Rules, as pinned.**

- **`fsck`'s object walk is pack-accessibility-gated; every other enumeration surface is
  index-driven.** M1 against its own `cat-file --batch-all-objects` column is the whole point: git
  *does* list a refused pack's ids when asked to enumerate objects, and *does not* walk them in
  `fsck`. So this change must **not** touch `registry.all()` (ADR-575 pinned it against
  `count-objects`) and must **not** make `enumerateObjects` filter by default (M1's `cat-file`
  column forbids it) — only `fsck`'s own universe narrows. ADR-585.
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
  `FsckFinding['dangling'].objectType` has no `'unknown'` member. **ADR-588 closes this** — §D12.
- **`--no-full` does *not* behave like `--connectivity-only` here** (M8 against M7). The two modes
  are gated independently: `--no-full` removes packed objects from the universe (so a refused pack
  contributes nothing at all), while `--connectivity-only` keeps them and reports them untyped.
  Reading the two as one "reduced mode" is the single easiest way to get §D12's gate wrong, which is
  why M8 exists as its own row.

### Pin N — the rest of git's bit 4, which this change does *not* claim

| repo shape | exit | stderr |
|---|---|---|
| healthy pack, **one body byte flipped** at offset 40 | **4** | `error: <p>.pack pack checksum mismatch` + `error: cannot unpack <oid> from <p>.pack at offset 12` + `error: index CRC mismatch for object <oid> …` + `error: inflate: data stream error (invalid bit length repeat)` |

git's `fsck` runs a full `verify_pack` over every **accessible** pack — pack trailer checksum,
per-object index CRC, and an inflate of every object — and folds all of it into the same bit 4.
Accessibility is a **subset** of git's bit-4 surface. ADR-587 takes none of the remainder; the
residual is named in §Out of scope as a capability boundary rather than left implicit.

### Pin P — unreadable / corrupt **loose** objects, all three modes

Commissioned by ADR-588: the ruling closes the `dangling unknown` divergence *fully*, and option (a)
itself flags that the widening "also makes any unreadable LOOSE object produce `dangling unknown`,
which needs its own git pins". These are those pins. Same isolation discipline as J–N, with one
change of arrangement: **the repo has no packs at all**, so every cell is attributable to the one
damaged loose object. Objects are damaged after `chmod u+w` — git writes loose objects `0444`, and a
probe that skips this silently measures a *healthy* repo.

| # | loose object's state | reachable? | `git fsck` | `fsck --connectivity-only` | `fsck --no-full` |
|---|---|---|---|---|---|
| P1 | healthy (control) | dangling | **0** — `dangling blob <oid>` | **0** — `dangling blob <oid>` | **0** — `dangling blob <oid>` |
| P2 | `chmod 000` | dangling | **1** — **no stdout finding**; stderr `unable to mmap <path>: Permission denied` + `<oid>: object corrupt or missing: <path>` | **0** — `dangling unknown <oid>`; stderr `unable to open loose object <oid>: Permission denied` (×4) + `Unknown object type for <oid>` | **1** — byte-identical to default |
| P3 | file truncated to **0 bytes** | dangling | **1** — no finding; `object file <path> is empty` | **0** — `dangling unknown <oid>` | **1** |
| P4 | body replaced by **non-zlib garbage** | dangling | **1** — no finding; `inflate: data stream error (incorrect header check)` + `unable to unpack header of <path>` | **128 — `fatal: loose object <oid> (stored in <path>) is corrupt`; stdout EMPTY** | **1** |
| P5 | truncated to **8 bytes** (zlib header cut) | dangling | **1** — no finding; `unable to unpack header of <path>` | **128 — fatal**; `header for <oid> too long, exceeds 32 bytes` (×3) + the same `fatal` | **1** |
| P6 | valid zlib, **wrong content** (hash-path mismatch) | dangling | **1** — no finding; `<real-oid>: hash-path mismatch, found at: <path>` | **0** — `dangling blob <oid>` — **typed**, because connectivity-only reads the header and never hashes the body | **1** |
| P7 | `chmod 000` | **reachable** | **3** (2\|1) — `missing blob <oid>` | **0** — **nothing at all** | **3** |
| P8 | non-zlib garbage | **reachable** | **3** — `missing blob <oid>` | **0** — nothing | **3** |
| P9 | file **removed** | **reachable** | **2** — `missing blob <oid>` | **2** — `missing blob <oid>` | **2** |

| # | isolation probe | result |
|---|---|---|
| P-a | P2 / P3 / P4 / P5 / P6 re-run in **default** mode with `--dangling --unreachable` | **unchanged** — still no `dangling` and no `unreachable` line. git does not merely decline to *print* the entry in default mode; it does not *compute* one. This is the probe that forbids reading P2's default cell as a projection difference |

**Rules, as pinned.**

- **`dangling unknown` for a loose object is a `--connectivity-only` phenomenon and nothing else.**
  In default and `--no-full` mode git turns an unreadable object into a *content* error (exit bit 1)
  and drops it from the graph, so it can be neither `dangling` nor `unreachable` (P2–P6, P-a).
- **`--no-full` tracks *default*, not `--connectivity-only`, on the loose axis** — every P-row's
  third column equals its first. `--no-full` only removes *packed* objects (Pin M8). So the two
  reduced modes are orthogonal knobs, and §D12's gate keys on **`connectivityOnly` alone**.
- **Within `--connectivity-only`, git splits unreadable objects by fault class.** If it *cannot open*
  the file (EACCES) or the file *is empty*, it yields type `unknown` and keeps going (P2, P3). If it
  *opens* the file but the zlib stream is undecodable, it `die()`s — **exit 128, zero findings on
  stdout** (P4, P5). A body that inflates but hashes wrong is not a read fault at all: the type is
  recovered and the object reports `dangling blob` (P6).
- **A reachable unreadable object produces nothing in `--connectivity-only`** (P7, P8): the
  connectivity check is satisfied by the file's *existence*, so no `missing`, no bit 2. Only genuine
  absence produces `missing` (P9). This is what keeps the closure off the reachable path.
- **Exit bit 1 is git's verdict for an unreadable loose object in the two full modes.** tsgit already
  sets exactly that bit on the rows where the file opens and the *decode* fails (Pin O12, O13), so this axis
  needs no exit-code change from ADR-588. It is **not** already faithful on the IO-fault row, where
  tsgit throws instead (Pin O11, O15) — a separate, pre-existing gap (§D11.13).

### Pin Q — M7's cardinality, resolved

The original Pin M7 recorded "6–9 × `dangling unknown`" — an ambiguity that had to be resolved
before an interop row could assert a count. It was **probe contamination, not git non-determinism**.

| # | probe | result |
|---|---|---|
| Q1 | the v99 fixture built by the *original* recipe, 10 fresh fixtures | `dangling unknown` = **0** on four runs, **3** on six — flipping mid-sweep |
| Q2 | same, instrumented | the donor and the target repo were built from the **same file bodies**, so 6 of the pack's 9 oids (3 trees + 3 blobs) were *content-identical* to the target's own loose objects; the 3 commits differed only by timestamp. When a run crossed a one-second boundary the commits differed too (→ 3 unknown); when it did not, all nine oids coincided (→ 0) |
| Q3 | donor bodies made **distinct** from the target's, 3 fresh fixtures | **9 / 9 / 9** |
| Q4 | one fixture, `fsck --connectivity-only` run **5×** | **9, 9, 9, 9, 9** — and the same nine oids each time, no duplicates |
| Q5 | donor bodies distinct, then **K** of the donor's loose object files copied into the target byte-for-byte (oid preserved) *before* the donor is repacked, K ∈ {0, 2, 5, 9} | `dangling unknown` = **9, 4, 0, 0**. Overlap does **not** subtract 1 per copy: a readable copy leaves the unknown-type set *and* supplies **in-edges** to whatever it references, demoting those referents from `dangling` to merely `unreachable`. Which oids get copied varies per fixture (they are the first K in sorted-oid order), so the mid-range cells are fixture-dependent — the reason the interop fixture must use K = 0 |
| Q6 | Q5's fixtures re-run with `--unreachable --dangling` | `unreachable unknown` = **9, 4, 0, 0** with `dangling` = **0** throughout — `--unreachable` *replaces* the dangling projection rather than adding to it, so the two flags are alternative views of one classification, never a sum |

**Rules, as pinned.**

- **git is deterministic here.** The count is a pure function of the fixture: stable across five
  repeated runs on one fixture (Q4) and across freshly-built fixtures with the same overlap (Q3).
  The original "6–9" was an artefact of the probe, and no interop assertion needs a range.
- **With a zero-overlap fixture the count is exactly `|pack objects|`** (Q3, Q4: 9 of 9). This is the
  only cell an interop row should assert, and §Test strategy states the zero-overlap precondition as
  a helper contract because it is invisible in the assertion itself.
- **Objects git cannot type obey the ordinary `dangling` / `unreachable` rule** (Q5, Q6). Such an
  object still counts as `dangling` only when no *readable* object references it; an unreadable
  object supplies no out-edges, so it can never demote anything itself. That is precisely what
  `classifyObjects` + `buildInEdgeMap(universe, objectCache)` already compute in tsgit, both of which
  already skip null-cache entries — **so the closure needs no change to classification, only to
  emission** (§D12.1).
- Exit stays **0** in every cell: `--connectivity-only` sets no pack bit (Pin K), and `dangling` is
  not an error condition.

### Pin R — where `--connectivity-only`'s `die()` fires, exactly

Commissioned by ADR-590. The ruling says `fsck` rejects on an object git can *open* but not
*decode* — and that phrase has a boundary the code cannot supply: which faults abort, over which
objects, and whether another copy of the object changes the answer. Same isolation discipline as
Pin P (`chmod u+w` before every mutation, since git writes loose objects `0444` — and copied pack
files inherit the same read-only mode, which silently defeated the first run of R13); the repo has no
packs except in the three rows that say otherwise. Columns are `git fsck --connectivity-only` and
plain `git fsck`, the second given because it is what tsgit must keep unchanged.

| # | object's state | reachability | `--connectivity-only` | default |
|---|---|---|---|---|
| R1 | non-zlib garbage | **reachable** | **0** — stdout empty **and stderr empty**: git never opens it | **3** (2\|1) — `missing blob <oid>` |
| R2 | non-zlib garbage | unreachable, **referenced by a readable dangling tree** | **128** — `fatal: loose object <oid> (stored in <path>) is corrupt`; stdout empty | — |
| R3 | non-zlib garbage | dangling | **128** — same fatal (re-confirms P4) | 1 |
| R4 | file truncated to 0 bytes | dangling | **0** — `dangling unknown <oid>` (re-confirms P3) | 1 |
| R5 | `chmod 000` | **reachable** | **0** — silent (re-confirms P7) | 3 |
| R6 | one **healthy** dangling blob **+** one garbage dangling blob | dangling | **128**, **stdout empty** — the healthy `dangling blob` line is suppressed | — |
| R7 | **packed-only** object, one body byte flipped inside the `.pack` | dangling | **0** — `dangling blob <oid>`, **typed** | **4** — `pack checksum mismatch` + `index CRC mismatch` + `cannot unpack <oid>` |
| R8 | valid zlib, inflated bytes carry **no NUL** in the first 32 | dangling | **128** — `header for <oid> too long, exceeds 32 bytes` ×3 + the fatal | 1 |
| R9 | loose file garbled, **healthy copy of the same oid in a pack** | dangling | **0** — `dangling blob <oid>`, **typed** | 1 — the loose fault is still reported |
| R10a | valid zlib, header `widget 5\0` | dangling | **128** — `fatal: invalid object type` (a *different* fatal, same class) | 1 |
| R10b | valid zlib, header `blob abc\0` | dangling | **128** — `unable to parse <oid> header` ×3 + the fatal | 1 |
| R10c | valid zlib, header `blob 99\0` over **2** content bytes | dangling | **0** — `dangling blob <oid>`, **typed** | 1 — `hash-path mismatch` |
| R10d | valid zlib, header `tree 4\0` over 4 junk bytes | dangling | **0** — `dangling tree <oid>`, **typed**; stderr `too-short tree object` | 1 |
| R11 | R3's and R4's fixtures under `--connectivity-only --no-full` | dangling | **128** / **0 + `dangling unknown`** — identical to the `--connectivity-only` column | — |
| R12 | corrupt `.idx` (bit-64 territory, Pin K) **plus** R3's undecodable dangling object | dangling | **128**, stdout empty — the die beats the rev-index bit outright | 79 (64\|8\|4\|2\|1); `--no-full` 75 |
| R13 | **delta-stored** packed-only object, one byte flipped in the **delta** body — run twice, `REF_DELTA` and `OFS_DELTA` | dangling | **0** — `dangling blob <oid>`, **typed**, both encodings | **4** — `index CRC mismatch` + `failed to unpack compressed delta` + `cannot unpack <oid> … at offset <n>` |

**Rules, as pinned.**

- **git dies when, and only when, it cannot recover the `<type> <size>\0` header from a file it
  opened.** A dead zlib stream (R3), a header longer than 32 bytes (R8), an unknown type name (R10a)
  and a non-numeric size (R10b) all abort. A *recovered* header aborts nothing, however wrong the
  body behind it is: a size that disagrees with the content (R10c) and a tree body git itself calls
  `too-short` (R10d) both print the header's type and exit 0. The class is therefore **not**
  "corrupt versus intact", and **not** an error family — it is *header recoverable or not*. This is
  the single most inversion-prone reading in the change and §D13.1 is built on it.
- **A file git could not open, or that is empty, is outside the class** (P2, R4): those yield type
  `unknown` and the run continues. "Cannot read it" and "cannot type it" are different verdicts and
  only the second aborts.
- **The abort is scoped to the objects git does not reach** (R1 versus R2/R3). A reachable object is
  never opened in this mode — R1's stderr is *empty*, not merely finding-free — so identical damage
  kills the run when the object is unreachable and is invisible when it is reachable. R2 forbids the
  narrower reading *"dangling"*: an unreachable object that a readable object still references
  aborts too, so the domain is git's `check_unreachable_object` set, i.e. tsgit's `unreachable`
  array, never its `dangling` subset.
- **The abort withholds everything** (R6): stdout is empty even though git had already computed a
  healthy `dangling blob` line for another object. An abort is not "one finding replaced by an
  error" — it is the whole report withheld, which is what makes a **rejected promise** (rather than
  an extra finding plus an exit bit) the faithful tsgit shape, and what refutes DC-10's option (c)
  a second time.
- **Another readable copy defuses it** (R7, R9). A packed object whose body will not inflate still
  types from its pack-entry header, and a garbled loose file whose oid also sits in a healthy pack is
  served from the pack. git aborts only when *no* source can type the object — a property tsgit's
  loose-before-pack read order does not have for free (§D13.2).
- **The pack-entry type survives delta encoding** (R13, commissioned by ADR-591). A corrupt entry
  whose stored type is `REF_DELTA` or `OFS_DELTA` still prints `dangling blob`: git resolves the type
  by walking base links through **entry headers only** and never inflates the body it cannot read.
  Both encodings were run because they name the base differently (20-byte oid versus back-offset
  varint) and tsgit's chain walker branches on exactly that. The row is what makes §D13.8's pack arm
  a pinned behaviour rather than an inference from R7's single non-delta entry.
  *Recipe:* two ~20 KiB blobs differing in three bytes, written with `git hash-object -w` and packed
  by `git pack-objects --window=250 --depth=50 --no-reuse-delta [--delta-base-offset]` over their two
  oids alone — so both land packed-only **and** dangling in a fresh target repo — then one byte of
  the delta entry's deflate stream flipped, trailer left as-is, not restamped (`--connectivity-only` does not
  verify it, which is what R7's default column already showed).
- **`--no-full` does not move the class** (R11): combined with `--connectivity-only` every cell
  equals the `--connectivity-only` column, and alone it equals the default column (Pin P). Requirement
  6's gate on `connectivityOnly` **alone** survives the combination — the one option pair that could
  have falsified it.
- **The abort outranks every exit bit, including the one ADR-586 makes ungated** (R12). A repo whose
  `.idx` is unusable *and* whose unreachable loose object cannot be typed exits **128**, not 64 or
  192: `die()` leaves immediately and the accumulated bits go with the report. So tsgit's reject may
  discard an already-computed bit 64, and the order in which the pack pass and the guard run is
  observably irrelevant (§D13.3).

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
  the non-default modes" — those modes are wrong in **two** directions at once, and ADR-586 and
  ADR-588 close one each. On the exit axis git gives 64 where tsgit gives 0 for an index fault
  (ADR-586); on the findings axis git gives `dangling unknown`×N where tsgit gives none for a
  *refused* pack in `connectivityOnly` (ADR-588, §D12). O8's single `root` finding is therefore not
  a baseline to preserve in either mode.

**O2/O7 caveat.** tsgit reporting `unreachable`×9 **and** `dangling`×1 where git prints one
`dangling commit` is not a divergence: tsgit computes the maximal finding taxonomy and the caller
filters (ADR-411, `docs/use/commands/fsck.md`), where git needs `--unreachable` to print the rest.
Pin Q6 sharpens this — git's two flags are *alternative projections* of one classification, never a
sum, so an interop assertion compares tsgit's `dangling` subset against git's default output and its
`unreachable` superset against git's `--unreachable` output, never one against the other.

### Pin O′ — tsgit **today** on the Pin P loose rows, executed

Same driver and merge-base as Pin O, against the identical Pin P fixtures (no packs present, so the
pack axis cannot contaminate). `findings` is shown as a type→count census.

| # | loose object's state | reach. | git (default / conn-only / no-full) | tsgit `default` | tsgit `connectivityOnly` | tsgit `full: false` |
|---|---|---|---|---|---|---|
| O10 | healthy (control) | dangling | 0 / 0 / 0 | 0 — `unreachable/blob`×1, `dangling/blob`×1, `root`×1 | same | same |
| O11 | `chmod 000` | dangling | 1 / **0 + `dangling unknown`** / 1 | **THROWS `PERMISSION_DENIED`** | **0** — `root`×1 only | **THROWS** |
| O12 | empty file | dangling | 1 / **0 + `dangling unknown`** / 1 | 1 — `bad-object/unknown/unterminatedHeader`×1, `root`×1 | **0** — `root`×1 only | 1 — as default |
| O13 | non-zlib garbage | dangling | 1 / **128 fatal** / 1 | 1 — `bad-object/unknown/unterminatedHeader`×1, `root`×1 | **0** — `root`×1 only | 1 — as default |
| O14 | hash-path mismatch | dangling | 1 / 0 + `dangling blob` / 1 | 1 — `hash-mismatch`×1, `unreachable/blob`×1, `dangling/blob`×1, `root`×1 | 0 — `unreachable/blob`×1, `dangling/blob`×1, `root`×1 | as default |
| O15 | `chmod 000` | **reachable** | 3 / 0 + silence / 3 | **THROWS `PERMISSION_DENIED`** | **0** — `root`×1 only | **THROWS** |

Four things this column establishes.

- **The cells ADR-588 must close are exactly O11, O12 and O13's middle column** — tsgit returns
  `root`×1 and nothing else where git reports `dangling unknown` (O11, O12) or dies (O13). Every
  other cell in the `connectivityOnly` column already agrees with git (O10, O14, O15).
- **O14's `connectivityOnly` column is already faithful and must stay so.** A hash-path mismatch is
  *not* a read fault: the object decodes, the cache entry is non-null, and both tools report it
  typed (`dangling blob`). §D12's widening keys on the cache entry being null, so it cannot reach
  this row — but a widening keyed on "the content pass flagged this object" instead **would**, and
  would wrongly retype a readable blob as `unknown`.
  Its **default** column is a different matter and is *not* faithful: tsgit emits `dangling`/`blob` +
  `unreachable`/`blob` where git emits neither, because git drops any object failing its integrity
  read from the reachability graph and tsgit keeps the one that decoded. Pre-existing, unchanged by
  §D12 (which touches only null entries), and named in §D11.13 — the row is listed here so nobody
  reads "O14 is fine" off the connectivity-only cell alone.
- **O15 is why the reachable path must be left alone.** git is silent; tsgit is silent; the widening
  must not disturb that, which it does not, because a reachable object never reaches
  `collectTypeFindings` (§D12.1).
- **O11/O15's `THROWS` is a pre-existing divergence on a different axis** — the content-validation
  pass propagates `PERMISSION_DENIED` from a loose object's raw read where git records exit bit 1.
  It is not caused by, and not closed by, ADR-588 (the widening is `connectivityOnly`-gated and that
  mode does not throw). Named in §Out of scope and §D11.13 rather than folded in silently.

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
5. **Exit bit 64 is set when and only when at least one *index-layer* fault exists** (ADR-586), in
   **every** mode — including `connectivityOnly` and `full: false`, where requirement 4's bit is
   absent (Pin K) — and always alongside its own ungated finding variant.
6. **Mode gating matches Pin K and Pin P.** Two *independent* gates, never one:
   - the pack pass and the universe narrowing of requirement 7 run only when `full !== false`
     **and** `connectivityOnly !== true` (Pin K); `strict` affects neither;
   - the unknown-classification of requirement 17 **and** the reject of requirement 19 run only when
     **`connectivityOnly === true`**, and are **not** conditioned on `full` (Pin P: every P-row's
     `--no-full` column equals its default column, while its `--connectivity-only` column differs;
     Pin R11: `--connectivity-only --no-full` follows `--connectivity-only` on both). They share one
     `UnreadableMode` value computed once, so there is one predicate here, not two.
   Collapsing these into a single "reduced mode" predicate reproduces neither (Pin M7 vs M8).
7. **The object universe excludes objects contributed *only* by an unusable pack** — *in the modes
   where the pack pass runs* (requirement 6). Index-layer faults already exclude them via ADR-575's
   scan exclusion; pack-open-layer faults must now exclude them too (Pin M1, M2). An object also
   present loose or in an accessible pack is walked and classified normally (Pin M3). After the
   change, tsgit's **default-mode** findings for Pin O rows O3/O4 contain **zero** object-level
   entries attributable to the refused pack — no `bad-object`, no `missing`, no `dangling`, no
   `unreachable`. In `connectivityOnly` the narrowing must **not** fire, and requirement 17 governs
   instead; with `full: false` the ids never enter the universe at all (Pin M8), so neither applies.
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
14. **No new public surface beyond the three finding variants, one optional
    `EnumerateObjectsOptions` field (ADR-585), and the widened `objectType` on two existing finding
    variants (ADR-588).** `reports/api.json` **will** change for all three; the regenerated report
    must be committed (prepush `check:doc-typedoc`). **ADR-590 adds nothing to that list** — its
    types are command-internal and its reject reuses two existing `TsgitError` codes (§D13.4) — but
    it is a caller-visible behaviour change and `docs/use/commands/fsck.md` must say so. **ADR-591
    adds nothing either**: it narrows *when* the already-declared `'unknown'` member occurs and keeps
    its retention map on the command-internal `ObjectCacheResult` (§D13.8) — also a caller-visible
    behaviour change the same page must state.
15. **Nothing is written.** `tooling/audit-write-surfaces.ts` stays green with no annotation or
    allowlist edit (§D8).
16. **Hash-agnostic.** No branch on `ctx.hashConfig` anywhere in the pass (§D9).
17. **In `connectivityOnly` mode an object in the universe that cannot be read is classified, not
    dropped** (ADR-588) — every such object except the one class requirement 19 rejects on. It
    appears as `unreachable` and — when no *readable* object references it — also as `dangling`. Its
    `objectType` is **the type its stored header declares** whenever one can be recovered — the loose
    `<type> <size>\0` or the pack-entry header, delta entries resolved through their base
    (ADR-591, §D13.8; Pin R7, R9, R10c, R10d, R13) — and `'unknown'` when **no** stored header can be
    obtained at all: an unopenable file, an empty file, or an id only a refused pack supplies
    (Pin P2, P3, R4, M7). That split is git's own, not an approximation of it. The requirement holds
    whichever layer made the object unreadable: a refused pack's ids (Pin M7, cardinality per Pin Q)
    and an unreadable *loose* object (Pin P2, P3) take the same path. Five boundaries are part of the
    requirement, each with its own pin:
    - it does **not** fire in default or `full: false` mode, where git computes no such entry at all
      (Pin P2–P6 plus the P-a projection probe);
    - it does **not** fire for a *reachable* unreadable object, where git is silent (Pin P7, P8, O15,
      Pin R1, R5);
    - it does **not** fire for an object that decodes but fails its hash check, which keeps its real
      type in both tools (Pin P6, O14);
    - it does **not** fire for an object whose header cannot be recovered — that object is
      requirement 19's, and the run ends before any finding is returned (Pin P4, P5, Pin R3, R8,
      R10a, R10b);
    - it does **not** emit `'unknown'` for an object some store can still type — a recovered loose
      header over a body that will not parse, a corrupt pack entry (delta or not), or a garbled loose
      copy shadowing a healthy packed one all carry a real type (Pin R7, R9, R10c, R10d, R13). The
      retention that supplies it cannot change any verdict above: it only replaces `'unknown'` with a
      type (§D13.8).
18. **The classification is emission-only.** `classifyObjects`, `buildInEdgeMap` and
    `buildReachableSet` keep their current behaviour exactly; only `collectTypeFindings` changes
    (Pin Q5/Q6 show git's dangling-vs-unreachable rule is unchanged for objects it cannot type).
    Requirement 19's guard reads `classifyObjects`'s output and writes nothing back to it.
19. **In `connectivityOnly` mode `fsck` rejects — when and only when — the universe holds an object
    that is all four of: not reached; stored as a loose file that opened **non-empty**; unable to
    yield a `<type> <size>\0` header from those bytes; and claimed by **no** pack index** (ADR-590).
    It rejects with the `TsgitError` the header recovery itself produced — `DECOMPRESS_FAILED` or
    `INVALID_OBJECT_HEADER` (§D13.4) — and returns no `FsckResult` at all, which is git's `die()`:
    exit 128, empty stdout, every already-computed finding withheld (Pin R6). Each of the four
    conjuncts is a pinned negative, and none may be dropped as redundant:
    - **mode** — in default and `full: false` the object stays a *content* error with exit bit 1 and
      today's `bad-object` finding (Pin P4/P5 default columns, Pin R3/R8/R10a/R10b default columns,
      Pin O′ O12/O13). `--connectivity-only --no-full` follows `connectivityOnly` (Pin R11);
    - **not reached** — a reachable object with identical damage produces nothing at all in either
      tool (Pin R1, P8), and an unreachable object that a readable object references still aborts
      (Pin R2), so the guard's input is the `unreachable` array, never `dangling`;
    - **header unrecoverable** — an unopenable file, an empty file, a valid header over an
      unparseable or size-mismatched body all keep requirement 17's classification (Pin P2, P3,
      R4, R10c, R10d);
    - **no other source** — a packed object whose body will not inflate, and a garbled loose file
      whose oid a pack still claims, are both exit 0 in git (Pin R7, R9).

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
finding must not care which (ADR-584).

The accessor (its shape is ADR-583/ADR-584; the mechanism is what §D1 fixes):

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
the prime directive binds. ADR-583 took the two-variant option for exactly that reason.

The precedence pin (Pin J15) — a pack that is *both* v99 and index-corrupt reports only the index
fault — is inherited for free: an index-fault pack never becomes a `RegisteredPack`, so its header
is never probed and only the index-layer finding can exist. Structural, not a rule anyone has to
remember.

### §D3 — the fsck pack pass

A third pass beside the two that exist, in the file the house pattern implies (ADR-589):

```ts
export async function runPackHealthPass(
  ctx: Context,
  opts: FsckOptions,
): Promise<{ readonly findings: ReadonlyArray<FsckFinding>; readonly exitBit: number }>;
```

`fsck.ts` gains three lines: call it, OR its bit into `exitCode`, spread its findings.

**The signature takes `opts`, not a pre-computed boolean, and that is ADR-586's doing.** Had bit 64
not been modelled, a single `enabled = opts.full !== false && opts.connectivityOnly !== true`
computed at the call site would have sufficed and the pass could have stayed opinion-free about
options. Because the bit *is* modelled, the pass carries **two** gates — bit 4 gated by `enabled`,
bit 64 ungated (Pin K) — so the gating cannot be hoisted out. Stated explicitly because a reviewer
will otherwise read the `opts` parameter as a layering slip rather than a pinned consequence.

### §D4 — the object universe

`fsck.ts:35` today:

```ts
const allIds = await enumerateObjects(ctx, { includePacks: opts.full !== false });
```

Requirement 7 needs the pack half restricted to accessible packs, and Pin M1's `cat-file
--batch-all-objects` column forbids changing the default for everybody else. ADR-585 landed the
accessibility knob on `EnumerateObjectsOptions`; the semantics are **union(loose ids, ids of every
accessible pack's index)**, applied under the same `enabled` predicate as the pass (requirement 6) —
in `connectivityOnly` mode git *includes* a refused pack's ids (Pin M7), so the narrowing must not
fire there. That negative is not a detail: it is the step that feeds §D12's classifier, and the whole
path is walked end to end in **§D12.5**.

Consequences worth stating rather than discovering:

- **The nine `badType` findings disappear** (Pin O3/O4) because the ids never enter the universe,
  not because `content-validation.ts` learns a new arm. `tryGetRawObjectBody` is untouched.
- **`buildObjectCache` no longer reads nine objects it cannot read**, which is where 18 of the 18
  logger warns came from.
- **`missing` / `broken-link` is unaffected** (requirement 8). An object genuinely referenced but
  absent — including one that was only in the refused pack and is referenced from a loose commit or
  a ref — still produces `missing` + `broken-link` + bit 2, composing with bit 4 exactly as Pin L's
  `v99 + deleted tree` and Pin M5 rows do.
- **`health()` is called twice per `fsck` run** under ADR-585's knob — once inside `enumerateObjects`, once
  by the pass. The scan memo and every *successful* header memo are settled by then, so the second
  call re-probes only the **failed** packs, at 12 bytes each, and emits a second logger warn for
  each. That is not a regression against git, which re-emits its own `error:` line many times per
  run (Pin J8: seven times) for the identical no-negative-cache reason. Passing the report down
  instead was option (b)'s upside, recorded in DC-5's consequence column and knowingly not taken.

### §D5 — exit-code semantics

`internal/fsck/exit-codes.ts` gains, in the file's existing pinned-comment convention:

```ts
// bit 4  = pack inaccessible / index not opened (git's ERROR_PACK)
// bit 64 = reverse index unusable                (git's ERROR_PACK_REV_INDEX)
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
| `.idx` unparseable | one index-unusable finding **and** one rev-index finding (ADR-586) | 4 \| 64 | exit 68 (J8, J9) |
| `.idx` unreadable | one, reason carries the io code | 4 \| 64 | exit 68, git silent about the cause (J10) |
| `.idx` over `MAX_PACK_IDX_BYTES` | one, reason `REASON_PACK_IDX_EXCEEDS_MAX`; **no `ctx.fs.read` issued** | 4 \| 64 | no direct analogue — git's own size sanity lands it in the J8 family |
| orphan `.idx` / idx-less `.pack` | **none** | 0 | exit 0, silent (J11, J12) |
| two unusable packs | **two** findings | 4 (once) | exit 4, two verdict lines (J14) |
| v99 **and** unusable `.idx`, same pack | **one** index-unusable finding only | 4 \| 64 | exit 68, no version line (J15) |
| unusable pack **+** deleted reachable tree | pack finding **and** `missing` + `broken-link` | 2 \| 4 (\| 8) | exit 14 (Pin L, M5) |
| any of the above, `connectivityOnly` / `full: false` | no pack-inaccessible finding | 0, or 64 for index faults (ADR-586) | 0 / 64 (Pin K) |
| refused pack, **`connectivityOnly`** | **`unreachable` + `dangling`, `objectType: 'unknown'`**, one pair per id the pack alone supplies (§D12) | 0 | exit 0, `dangling unknown <oid>` ×N (Pin M7, cardinality per Pin Q) |
| refused pack, **`full: false`** | **none** — the ids never enter the universe | 0 | exit 0, silent (Pin M8) |
| **unopenable or empty** loose object, unreferenced, `connectivityOnly` | `unreachable` + `dangling`, `objectType: 'unknown'` | 0 | exit 0, `dangling unknown <oid>` (Pin P2, P3, R4) |
| **header-unrecoverable** loose object, not reached, `connectivityOnly` | **none — `fsck` rejects** with the recovery fault (§D13.4) | n/a — no result | exit **128**, stdout empty (Pin P4, P5, R2, R3, R6, R8, R10a, R10b) |
| loose object with a **recovered** header over a bad body, not reached, `connectivityOnly` | `unreachable` + `dangling` with the header's real type (§D13.8) | 0 | exit 0, `dangling blob` / `dangling tree` (Pin R10c, R10d) |
| unreadable **loose** object, unreferenced, default / `full: false` | `bad-object` from the content pass; **no** `dangling`, **no** `unreachable`, **no** reject | 1 — except an *IO*-fault read, which throws today and is out of scope (§D11.13) | exit 1, no reachability line (Pin P2–P5, P-a, Pin R3/R8/R10a/R10b default column) |
| unreadable **loose** object, **reachable**, `connectivityOnly` | **none** | 0 | exit 0, silent (Pin P7, P8, R1, R5) |
| **packed** object whose body will not inflate, dangling, `connectivityOnly` | `unreachable` + `dangling` with the **pack-entry header's** type; **no reject** | 0 | exit 0, `dangling blob` — git types it from the pack-entry header, delta entries included (Pin R7, R13; §D13.8) |
| loose file garbled, **healthy packed copy**, dangling, `connectivityOnly` | `unreachable` + `dangling` with the **packed copy's** type; **no reject** | 0 | exit 0, `dangling blob` — git reads the packed copy (Pin R9; §D13.8) |
| a fault outside both allow-lists | `health()` **rejects**; `fsck` propagates | n/a | n/a — tsgit-side guardrail |

Per ADR-249 the wording is ours; the condition and the exit integer are git's.

### §D7 — performance

Cost: **one 12-byte `ctx.fs.readSlice` per registered pack whose header memo is not already
settled**, once (twice, for failed packs, via ADR-585's knob) per `fsck` run in full mode. Against what
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

ADR-590's header-recovery probe costs nothing on the two modes that carry the traffic and nothing on
a healthy repo in the third: it runs only in `connectivityOnly`, only for an object whose read
already **failed**, and only for the two error codes a decode fault can produce — so a refused
pack's N failing `OBJECT_NOT_FOUND` reads add N string comparisons and no syscalls (§D13.5). Only a
damaged *loose* object pays a second read plus a second inflate of its own bytes.

One **new** cost arrives with ADR-586: because bit 64 is ungated (Pin K), `fsck({ full: false })` —
a mode chosen precisely to avoid touching packs — must consult the registry, so it newly reads and
parses every `.idx` in the repository. On a many-pack repo that is the difference between a
loose-only scan and a full index scan. It was the strongest argument for the option not taken, and
is accepted deliberately: git's own `--no-full` pays the same, and exit-code faithfulness was ruled
to outweigh it.

### §D8 — write-path symmetry (explicit checklist)

| question | answer |
|---|---|
| Does this change write anything? | **No.** Read-and-report end to end: one 12-byte read per pack; no file created, modified, renamed or deleted. |
| Any `@writes` annotation churn? | **None.** `tooling/audit-write-surfaces.ts` stays green with no annotation and no allowlist edit (requirement 15). |
| Does reporting a pack change what a *write* does? | **No.** `buildPack` (`build-pack.ts:38`) still sources every object through `readObject`, so an object hidden by a skip still fails push / `bundle create` loudly with `OBJECT_NOT_FOUND` (28.1 requirement 15). Reporting is strictly additive. |
| Could a caller act destructively on a finding? | tsgit exposes no `gc` / `repack` / `prune`, so nothing inside the library can. The finding *is* the signal an external caller needs before deciding to repair or re-fetch — the direction of travel this change enables. Any future pruning surface must consult a **non-degraded** view or refuse, exactly as `git gc` does (28.1 §D8 T-8, re-affirmed). |
| Is there a write-side analogue that should move in step? | **No.** git's `fsck` is read-only; `git repack`/`gc` are the write-side reactions, and tsgit has neither. |
| Does the finding shape constrain a future writer? | Yes, mildly: whatever identifies a pack (ADR-584) is the identifier a future repair surface would take as input — an argument for the pack's *name* over a rendered path. |

### §D9 — hash-width genericity (explicit checklist)

| question | answer |
|---|---|
| Does the pass read anything hash-width-dependent? | **No.** It consumes `PackIndex.objectCount` and the 12-byte header, neither of which contains a digest. |
| Does any part branch on `ctx.hashConfig`? | No, and it must not — 28.1 Pin E establishes that pack version is orthogonal to object format (a SHA-256 repo also stamps version 2, and git accepts a v3 SHA-256 pack). |
| Where is hash width load-bearing? | Only in the **fixtures**: re-stamping a mutated pack's trailer digests `pack[0 .. len − digestLength)`. The lifted helpers hard-code SHA-1 and say so, exactly as `pack-version-interop.test.ts` already does. |
| Can the matrix carry a SHA-256 leg? | **No, and not because of this change.** `IDX_SHA_LENGTH = 20` is hard-coded in the idx reader (`pack-index.ts:10`) and writer (`pack-writer.ts:63`); the pack subsystem is SHA-1-only end to end. Unchanged in either direction. |
| Would a later SHA-256 widening invalidate this design? | No. The pass never sees a digest; only the fixtures would change. |
| Does ADR-590's header recovery branch on hash width? | **No.** It inflates a loose file and calls `parseHeader`, whose input is `<type> <size>\0` — no digest, no width. The oid it is keyed by is the caller's own `ObjectId`, and `looseObjectPath` already derives its 2/38 split from that string rather than from `hashConfig` (§D13.1). |

### §D10 — threat model

The subject is an *integrity-reporting* surface over bytes an attacker with repo-write access fully
controls — a `.pack` or `.idx` dropped into `.git/objects/pack/` — and the new consumer of that
report is a caller who may gate CI on the exit code.

| # | concern | assessment |
|---|---|---|
| T-1 | **Reporting is the security content.** Today an attacker who flips one byte in a pack header makes nine objects vanish from every read *and* makes tsgit's integrity command report `badType` on them (Pin O3), or — at the index layer — report nothing at all (Pin O5) while `git fsck` exits 68. A repository can be silently degraded today and still pass tsgit's own integrity check. Closing that is the point of the change; it strictly *adds* signal. | — |
| T-2 | **Eager probing is a new I/O surface.** `health()` reads 12 bytes from every registered pack, so an attacker who drops N `.idx`/`.pack` pairs makes `fsck` issue N extra reads. Bounded by the same directory listing `scanPacks` already walks and already reads a full `.idx` from, so the marginal cost is 12 bytes against a multi-KiB index read — not an amplification vector. No new path is constructed: `packPath` is the value `loadPack` already derived. | accepted |
| T-3 | **The finding carries a pack identifier out of the library as data no sanitiser touches.** `RegisteredPack.name` comes from a `readdir` entry an attacker controls, and the Logger port's sanitiser applies to log arguments, **not** to return values. `isSafePackName` (`pack-registry.ts:134`) already rejects `/`, `\`, `..` and every control character below `0x20` at the scan boundary — that is what makes the name safe to hand out, because no newline can be smuggled into a line-oriented sink downstream. **Load-bearing for ADR-584:** the chosen identifier must be one `isSafePackName` has already constrained, and a `path` field would additionally disclose the gitdir layout to a consumer that may not have it. | mitigated by the existing scan-boundary filter; re-state it in the finding's doc-comment |
| T-4 | **A new denial vector on the exit code.** One flipped byte now moves `fsck` from exit 0 to 4 or 68, failing any CI gate keyed on it. This is *faithful* — git does the same — and is the honest signal, not a regression. Suppressing the report requires making the pack healthy again, which is not a suppression. | accepted, and intended |
| T-5 | **The allow-lists must not widen.** They deliberately differ by one code each (`INVALID_PACK_HEADER` at the pack layer, `INVALID_PACK_INDEX` at the index layer). A DRY pass that unioned them would make a **mid-read** `INVALID_PACK_INDEX` from `nextOffsetForEntry` / `buildOffsetTable` (`pack-registry.ts:279`, `:192`) skippable at the lookup layer, converting a detected corruption into a silent miss (28.1 §D9.9). Reporting gives that mistake a *second* way to be wrong: a corruption detected mid-read would then be reported as a whole-pack accessibility fault. The shared helper stays `isSkippableIoFault` and nothing more. | design constraint, tested by the propagation rows |
| T-6 | **`UNSUPPORTED_OPERATION` must not be laundered.** `mapErrno` folds `EMFILE`, `EIO` and every unnamed errno into `UNSUPPORTED_OPERATION { operation: 'filesystem' }`. An `fsck` that reported those as unusable packs would raise a *false* integrity alarm across the whole pack set under load — worse than the silence it replaces, because it is actionable and wrong. `health()` must **reject** (requirement 13); the two propagation rows in §Test strategy forbid a future `catch {}`. | design constraint, tested |
| T-7 | **Alternates.** git sets bit 4 for an inaccessible pack in an *alternate* object directory, printing its absolute path (probed). tsgit's registry scans `packsDir(commonGitDir(ctx))` only. This change neither widens nor narrows that; a repo using alternates gets no pack report for the alternate's packs — a pre-existing enumeration boundary, named in §Out of scope so it is known rather than assumed. | pre-existing, named |
| T-8 | **Symlinked `.pack`.** git registers a pack whose `.pack` is a symlink to a regular file (its sibling test resolves the target); tsgit's lstat-based regular-files-only listing drops it at scan, so it reports as an orphan — silent, exit 0. A deliberate extension of the no-follow policy (28.1 §D9.1), unchanged here, but the reporting surface makes it observable for the first time. | pre-existing, named |
| T-9 | **One byte now denies the whole report.** After ADR-590 an attacker with repo-write access can, by garbling a single unreachable loose object, make `fsck({ connectivityOnly: true })` reject — no findings, no exit code, nothing a CI gate can read *except* the failure. That is strictly more disruptive than T-4's exit-bit denial, and it is nonetheless the faithful shape: git `die()`s on the same byte (Pin R3, R6). The mitigation is that the other two modes are untouched — a caller who needs a report from a damaged repo has `fsck()` and `fsck({ full: false })`, both of which classify the same object as a `bad-object` content error and still return everything else. | accepted, and bounded to one mode |
| T-10 | **The reject must not be reachable from a *reachable* object.** If the guard were fed the universe instead of the `unreachable` array, any repo whose *checked-out* tree holds one damaged blob would stop reporting entirely — a self-inflicted denial on the most common corruption there is, where git says nothing at all (Pin R1). The scoping is what keeps the blast radius equal to git's, and §Test strategy pins it with a row that must assert a *resolved* result. | design constraint, tested |
| T-11 | **ADR-591 types an object from attacker-controlled bytes.** The retained type comes from a header inside a file or pack entry an attacker with repo-write access wrote. It crosses the boundary as one of four enum values and nothing else: `parseHeader` rejects any type name outside `blob\|tree\|commit\|tag` (it is the `INVALID_OBJECT_HEADER` that makes Pin R10a an *abort* row), and arm 2's walk stops at a non-delta entry whose `PACK_ENTRY_TYPE` is likewise a closed four-value set. So the widest thing an attacker gains is mislabelling a corrupt dangling object as a `tree` instead of a `blob` — which is exactly what git reports for the same bytes. No path, no size and no attacker-chosen string is retained. | bounded by the enum, and git-equal |

### §D11 — blind spots, named

1. **The orphan arm and the index-fault arm are five lines apart and both return `undefined`
   today.** Requirement 3 versus requirement 2 hangs entirely on keeping them distinct. This is the
   most likely way the change ships subtly wrong; the only defence is two tests that each trigger
   one arm alone.
2. **The `--connectivity-only` inversion (Pin M7) points the opposite way from every other row, and
   is now *implemented* rather than merely noted.** Everywhere else this change *removes* object
   findings for a refused pack; in connectivity-only mode ADR-588 makes it *add* them as
   `dangling unknown` (§D12). A reviewer who reads every other row as *refused pack ⇒ no object
   findings* will read requirement 17 as a bug, and a reviewer who generalises requirement 17 will
   read requirement 7 as one. The two are reconciled only by the mode gate, which is why §D12.2
   states it as its own gate and §D11.11 flags the shared-predicate refactor as a trap.
3. **Bit 64 names a subsystem tsgit does not have.** Per ADR-586 tsgit emits `EXIT_PACK_REV_INDEX`
   with no reverse-index reader anywhere in `src/`. It is exit-faithful (Pin K-a) and will still be
   correct when 28.3 lands a real `.rev` reader — but it is a constant whose *name* is a promise the
   code does not yet keep, and the doc-comment must say so.
4. **Bit 64 is ungated while bit 4 is gated** (Pin K), which means `full: false` newly triggers a
   full index scan (§D7). Both consequences will look like bugs in review; they are the accepted
   cost of ADR-586 and were the strongest argument for the option it declined. Note this is a
   *third* mode predicate, distinct from the two in §D11.11 — bit 64 is gated by nothing at all.
5. **`health()` is a footgun on any path but `fsck`.** It opens every registered pack — precisely
   what ADR-572 spent a decision avoiding on the read path — and nothing structurally prevents a
   future caller reaching for it. The cheap durability measure is the §D1 doc-comment plus a
   `find_referencing_symbols` check in review; the structural alternative is ADR-581's cost side.
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
11. **The two mode gates look like one and are not** (requirement 6). The pack pass keys on
    `full !== false && connectivityOnly !== true`; §D12's classification keys on
    `connectivityOnly === true` alone. They are not merely different — they are *disjoint*: no
    option set turns both on. A reviewer who factors out a shared `reduced mode` predicate will
    produce something that type-checks, reads better, and is wrong in both directions (Pin M7 vs M8).
12. **§D12's widening is keyed on the object cache entry being `null`, not on "the content pass
    complained".** The two are not the same set: a hash-path mismatch decodes fine (non-null entry,
    real type) yet the content pass flags it (Pin P6, O14). Keying on the wrong one silently retypes
    a perfectly readable blob as `unknown`.
13. **Two pre-existing loose-object divergences sit one column away from rows this change moves.**
    Both are named here and in §Out of scope so they are not discovered mid-implementation and
    quietly folded in — and neither is reachable from §D12's `connectivityOnly`-gated path.
    - tsgit **throws `PERMISSION_DENIED`** where git records exit bit 1, for an unreadable loose
      object in default and `full: false` mode (Pin O11, O15) — the content pass's IO handling.
    - tsgit emits `dangling`/`unreachable` in **default** mode for an object that decodes but fails
      its hash check, where git emits neither (Pin O14 default column): git drops every object that
      fails its integrity read from the reachability graph, tsgit drops only the ones it could not
      decode. Closing this would mean removing hash-mismatched ids from the reachability input — a
      change to `classifyObjects`'s input set, which requirement 18 explicitly freezes.
14. **The reject's four conjuncts each defend a different pinned row, and three of them look
    redundant.** `not reached` (Pin R1), `non-empty` (Pin R4), `header unrecoverable rather than
    error-code-matched` (Pin R10c) and `no packed copy` (Pin R7, R9) will each read to a reviewer as
    an over-careful condition on an already-narrow discriminator. Drop any one and tsgit aborts a run
    git completes. §D13.1 states the pin beside each step and §Test strategy gives each its own row
    for the same reason.
15. **git's split is *header recoverable or not*, which no error taxonomy reproduces.** tsgit's
    `INVALID_OBJECT_HEADER` covers both a header that cannot be parsed (Pin R8/R10a/R10b — git
    aborts) and a size that disagrees with the content (Pin R10c — git reports), because
    `splitObject` (`git-object.ts:24`) raises the same code for the second. Any implementation that
    classifies the *caught error* rather than re-running the recovery will therefore be wrong on
    R10c, and wrong in the direction that loses a report (§D13.1).
16. **`'unknown'` is a reserved verdict, not the generic read-failure label — and everything about
    the surrounding code invites the opposite reading.** git types an unreachable object from its
    **header** (loose) or its **pack-entry header** (packed); tsgit typed it from a successful
    `parseObject`, so an object whose header is fine but whose body tsgit cannot parse (Pin R10d),
    whose body is packed and undecodable (Pin R7, R13), or whose garbled loose copy shadows a healthy
    packed one (Pin R9) came out `'unknown'` where git prints `tree` / `blob`. **ADR-591 rules that
    closed** — §D13.8 retains the recovered header's type — which inverts the rule a reviewer will
    otherwise infer from the null cache entry: after this change `'unknown'` means *no stored header
    could be obtained at all* (unopenable file, empty file, refused pack) and nothing else. The trap
    is that `resolveObjectType`'s fallback still reads `obj != null ? obj.type : 'unknown'` and looks
    complete on its own; the retention map is the second half of the sentence and lives one file away.
    The two rows that hold the boundary in place are the `chmod 000` row (still `'unknown'`, Pin P2)
    and the R10d row (now `tree`) — dropping either lets the field drift back to a generic label.

### §D12 — the unreadable-object classification closure (ADR-588)

ADR-588 overrode the design's recommendation and ruled DC-8 **closed fully**: widen the
`dangling` / `unreachable` `objectType` to admit `'unknown'` and stop skipping null-cache entries.
Pin P and Pin Q were commissioned by that ruling, and they shape the closure in three ways the ADR
could not state in advance.

#### §D12.1 — the change is one function, and it is emission-only

`collectTypeFindings` (`reachability.ts:204-217`) is the entire site:

```ts
for (const id of ids) {
  const obj = objectCache.get(id);
  if (obj != null) findings.push({ type, id, objectType: obj.type });
  // null (unreadable) — skip
}
```

The skip becomes conditional on the mode (§D12.2) and the type is resolved rather than assumed:

```ts
for (const id of ids) {
  if (objectCache.get(id) == null && unreadable === 'skip') continue;
  findings.push({ type, id, objectType: resolveObjectType(id, objectCache, recovered) });
}
```

`resolveObjectType` (`:220-226`) already exists, already returns `FsckObjectType | 'unknown'`, and is
already the one place `fsck.ts:87` resolves a type it may not know — so the closure introduces no new
concept and no second `'unknown'` derivation. Routing through it also preserves the
`object-cache.ts:32` equivalence proof, which depends on the cache being read with a **loose**
`!= null` test (§D12.4). Its third argument is ADR-591's retention map (§D13.8), which is consulted
**only** when the cache entry is null and is empty in every mode but `connectivityOnly` — so the
single-site property survives the later ruling instead of sprouting a second resolver.

Everything upstream is untouched (requirement 18), and Pin Q6 is why that is *sufficient* rather than
merely convenient: git applies its ordinary dangling-vs-unreachable rule to objects it cannot type, and
tsgit's `classifyObjects` + `buildInEdgeMap` already compute exactly that rule — `buildInEdgeMap`
skips null-cache entries, so an unreadable object contributes no out-edges and can never demote
another object, precisely as git behaves. **No classification logic changes; only the emission step.**

The reachable path is likewise safe *by construction, not by a guard*: `buildReachableSet` adds an
unreadable reached object to `reached`, `classifyObjects` skips everything in `reached`, so such an
object never reaches `collectTypeFindings` at all. That is what makes Pin P7/P8/O15 (git silent,
tsgit silent) survive the widening with nothing written to preserve it — see §D12.4 for the mutation
consequence, which is the one place this *does* cost something.

#### §D12.2 — the gate is `connectivityOnly`, and it is its own gate

Pin P is unambiguous: an unreadable loose object yields `dangling unknown` **only** under
`--connectivity-only`. In default and `--no-full` mode git emits a content error and no reachability
entry, and probe P-a proves that is a computation difference, not a print filter. So:

```ts
collectTypeFindings(unreachable, 'unreachable', findings, objectCache, recovered, unreadableMode);
collectTypeFindings(dangling,   'dangling',    findings, objectCache, recovered, unreadableMode);
// at the fsck.ts call site:
const unreadableMode = opts.connectivityOnly === true ? 'classify' : 'skip';
```

Three notes on that parameter, in decreasing obviousness.

- **It is a named mode, not a boolean.** `'skip' | 'classify'` states the two behaviours at the call
  site and at every test row; a `boolean` would be a flag argument whose meaning is only recoverable
  from the parameter name, and its mutants are harder to read than a `StringLiteral` mutant.
- **It keys on `connectivityOnly` and must not consult `full`.** This is the trap §D11.11 names: the
  pack pass's gate excludes `connectivityOnly`, this one *requires* it. The two predicates are
  disjoint, so there is no shared helper to extract and any attempt to write one is a bug.
- **In default mode the behaviour is byte-identical to today**, which is what keeps this closure from
  perturbing the pack rows: requirement 7's narrowing already removes a refused pack's ids from the
  default-mode universe, so there is nothing left there for the classifier to classify.

#### §D12.3 — the type widens on the finding, not in the domain

ADR-588's consequence line reads "`FsckObjectType` gains `'unknown'` **for the dangling/unreachable
classification**". That qualifier is load-bearing and the design takes it literally: the widening is
on the two **finding fields**, not on the domain type.

```ts
| { readonly type: 'dangling';    readonly id: ObjectId; readonly objectType: FsckObjectType | 'unknown' }
| { readonly type: 'unreachable'; readonly id: ObjectId; readonly objectType: FsckObjectType | 'unknown' }
```

`FsckObjectType` itself (`src/domain/fsck/types.ts:2`) stays `'commit' | 'blob' | 'tree' | 'tag'`,
because it is a *domain* type naming the object kinds the validator operates on, and six other sites
depend on that meaning: `validate-object.ts:11` (`kind: FsckObjectType`), `content-validation.ts:15`,
`reachability.ts:49`/`:58`/`:108`, and the `tagged` finding. Widening the domain type would make
`'unknown'` a legal input to the msg-id catalogue and the severity table (ADR-412) and a legal
`tagged.objectType`, none of which git can ever produce. The field-level widening is also the
*existing house idiom* — `missing.objectType`, `broken-link.toType` and `bad-object.objectType` are
already spelled `FsckObjectType | 'unknown'` — so this adds no new pattern, only two more uses of one.

#### §D12.4 — two carried-forward equivalence proofs, one of which dies

Both `// Stryker disable` comments in this neighbourhood were written against *today's* skipping
behaviour. The closure falsifies one and leaves the other standing only under a condition worth
writing down.

| site | comment's claim | after the closure |
|---|---|---|
| `reachability.ts:163` | *"corrupt objects (obj==null) are not emitted as findings by `collectTypeFindings` (skips null-cache entries); whether `reached.add` is called or not, no finding difference"* | **FALSE — the directive must be deleted, not re-justified.** Its premise (*null-cache entries are never emitted*) is exactly what §D12.1 makes conditional. In `'classify'` mode, deleting `reached.add(id)` moves a *reachable* unreadable object out of `reached`, so `classifyObjects` reports it `unreachable`/`'unknown'` — it keeps its in-edge, so not `dangling` — where git is silent (Pin P7, O15). The mutant becomes **killable and must be killed**, and only by a **`connectivityOnly`** row: in default mode the skip still applies and the mutant stays equivalent. That is why §Test strategy's reachable-unreadable row names its mode |
| `object-cache.ts:32` | *"`cache.get(id)` returns `undefined` when null not set; `undefined == null` is true so all `obj == null` guards behave identically"* | **true after §D12, false after §D13 — the directive is deleted.** Against §D12 alone it survived, and only while the new code reads the cache with `.get(id)` and a **loose** `!= null` test (a `has(id)` check or a strict `!== null` would distinguish the two states and falsify it); that constraint still binds `resolveObjectType`, which is one more reason to route the closure through it rather than re-deriving the type inline. §D13 ends it outright: the directive covers the `catch` **block**, and that block acquires a second, observable statement — the fault recording — so emptying it changes behaviour. See §D13.6 |

This is the failure mode the repo has hit before: a data-shape change quietly invalidating an
equivalence argument that was correct when written. Neither directive may be carried forward on the
strength of its own text.

#### §D12.5 — the end-to-end path for a refused pack, against ADR-585

The one path that crosses every decision in this document, stated whole because no single section
owns it:

1. `fsck({ connectivityOnly: true })` on a repo holding a header-refused pack.
2. `fsck.ts:35` calls `enumerateObjects(ctx, { includePacks: opts.full !== false })` — `full` is
   unset, so packs are included.
3. **ADR-585's accessibility knob is NOT set**, because requirement 6 gates the narrowing on
   `connectivityOnly !== true`. This is the load-bearing negative: the knob exists to drop a refused
   pack's ids, and here it must deliberately not. Pin M7 is the authority (git enumerates them);
   Pin K is why it is safe (no pack bit is set in this mode anyway).
4. So the refused pack's ids **enter the universe** from its still-readable `.idx`, exactly as
   ADR-575 keeps `all()` ungated for.
5. `buildObjectCache` reads each and fails — the registry refuses the pack at the header gate
   (ADR-572/573) — and stores `null` for each. No throw: `OBJECT_NOT_FOUND` is caught, and it is the
   code **both** probe gates exclude — §D13.1's step 0 and §D13.8's `isDecodeFault` — so ADR-590's
   reject class is unreachable on this path no matter how many of the pack's objects fail, and
   ADR-591's retention never runs for them either.
6. `buildInEdgeMap` records no edges for them; `buildReachableSet` never reaches them (no root
   resolves into a refused pack); `classifyObjects` puts all of them in `unreachable`, and — no
   readable object referencing them — in `dangling` too.
7. `collectTypeFindings` with `unreadableMode = 'classify'` emits `unreachable/unknown` and
   `dangling/unknown` for each — `'unknown'` by *entitlement* rather than by default, since the
   refusal makes the pack unable to type its own ids and git says the same (§D13.8, Pin M7).
8. Exit code stays **0**: no pack pass runs in this mode (requirement 6), no bit 64 unless the fault
   was index-layer (ADR-586), and dangling is not an error (Pin K, Pin Q).

Net: tsgit's `dangling`-with-`objectType: 'unknown'` subset equals git's `dangling unknown` lines
one-for-one, with the cardinality Pin Q pins — provided the fixture has zero donor/target object
overlap. With `full: false` instead, step 2 excludes packs and every later step is vacuous, matching
Pin M8's empty output. **The same eight steps describe an unreadable loose object**, with step 4
reading "the loose half of `enumerateObjects` lists it" and step 5 "the read fails on the object's
own bytes" — which is why one closure covers both layers and Pin P and Pin M7 agree.

#### §D12.6 — what it costs on the surface

| surface | delta |
|---|---|
| `FsckFinding` | two existing variants' `objectType` widens; **no new variant** (the three new variants are ADR-583/586's, unrelated to this) |
| `reports/api.json` | changes for the two widened fields, on top of the three variants and ADR-585's knob — one regeneration covers all of it (requirement 14) |
| `docs/use/commands/fsck.md` | the union block (lines 19–22), the finding-reference rows for `dangling` and `unreachable` (both currently say plain `objectType`), and the rendering example at line 180 — `` `dangling ${f.objectType} ${f.id}` `` already prints `'unknown'` correctly with no code change, which is worth stating because it is the one place the widening is *free* |
| existing consumers | a caller that `switch`es on `f.objectType` for a `dangling` finding gains a reachable case. tsgit ships no such consumer; the parity and interop suites read the field as data |
| ADR-591's retention | **nothing on this table.** It changes *which* of the already-declared members a row carries, never the member set, and its map is command-internal (§D13.8) |
| `FsckResult.exitCode` | **unchanged by this closure** — every Pin P and Pin M7 cell it touches is exit 0 on both sides. It is a findings-only change, which is why it composes with ADR-586's exit work without interacting |

#### §D12.7 — the residual the pins exposed, and its ruling

Pin P4/P5 found one cell the closure does **not** reach: a dangling loose object whose zlib stream is
undecodable makes `git fsck --connectivity-only` **die with exit 128 and print nothing**, where tsgit
after the widening returns exit 0 with a `dangling unknown` finding. It was not a regression — today
tsgit returns exit 0 with *no* finding, and git dies either way — but it was a cell in the mode this
change otherwise makes faithful, and exactly the kind of cell ADR-588's ruling was about. That was
DC-10, and **the user ruled option (a): close it — `fsck` rejects.** Closing it means the classifier
must first tell that cell apart from the ones §D12 classifies, which is a mechanism, not a widening.
It is **§D13**, and it is the one part of this change that makes `fsck` stop reporting rather than
report differently.

### §D13 — the reject mechanism (ADR-590)

#### §D13.1 — the discriminator re-asks git's question; it does not classify the error

The obvious implementation — an allow-list over the code `readObject` threw — is **wrong on three
pinned rows**, and the design starts from those rather than arriving at them:

- `INVALID_OBJECT_HEADER` is what `splitObject` (`git-object.ts:24`) raises for a **size mismatch**
  on an object whose header parsed perfectly — Pin R10c, where git prints `dangling blob` and exits
  0. An allow-list holding that code aborts a run git completes.
- `DECOMPRESS_FAILED` is also what a corrupt **pack entry** produces (Pin R7) and what a garbled
  loose file produces while a healthy packed copy of the same oid exists (Pin R9) — both exit 0.
- `PERMISSION_DENIED` (Pin P2) and an *empty* file (Pin P3, R4) both reach the same `catch`, and both
  must keep requirement 17's `dangling unknown`.

So the mechanism does not read the error at all as its *decider*. It re-asks git's own question about
the **stored form** — *can the `<type> <size>\0` header be recovered from it?* — in one helper in
`internal/fsck/object-cache.ts` whose loose arm is deliberately the same shape `tryGetRawObjectBody`
(`content-validation.ts:34-46`) already uses to answer it for the other mode:

```ts
type HeaderRecovery =
  | { readonly kind: 'tolerated' }                                    // today's null — requirement 17 governs
  | { readonly kind: 'unrecoverable'; readonly cause: TsgitError };   // git dies here — requirement 19 governs

async function recoverLooseHeader(ctx: Context, id: ObjectId): Promise<HeaderRecovery>;
```

*(ADR-591 splits `tolerated` into `typed` / `untyped` and renames the helper `recoverStoredType`,
because the type it recovers is now kept rather than discarded — §D13.8. Everything below is the
**abort** discriminator and is unchanged by that ruling, which is the whole of the compatibility
argument between the two ADRs.)*

Five steps, each with the pin that forbids removing it:

0. **Pre-filter on the caught code** — `isRecoveryCandidate(err)`: the **abort** verdict is reachable
   only when `readObject` threw `DECOMPRESS_FAILED` or `INVALID_OBJECT_HEADER`. This is not the
   decider (steps 1–4 are); it is what keeps the probe off an object whose *first* read already
   failed at the I/O layer. Without it, Pin P2's `chmod 000` object would have its `ctx.fs.read`
   retried inside the probe, the `PERMISSION_DENIED` would propagate, and a row git exits 0 on would
   reject instead. It can only shrink the candidate set — every abort row in Pin R arrives with one
   of the two codes. §D13.8 widens the code set that *enters* the probe and leaves this two-code test
   in place as the abort gate, so the widening cannot manufacture an abort.
1. `looseCompressedBytes(ctx, id)` returns `undefined` ⇒ **tolerated** (ADR-591: `typed` from the
   pack entry — arm 2): the object is not loose, so whatever failed was a pack read (Pin R7). No I/O — `probeLooseOid` answers from the per-prefix
   fanout set, which the very read that just failed already warmed (`loose-oid-cache.ts`, one
   `readdir` per `objects/xx` per `Context`). (A refused pack's ids never get this far: their read
   fails `OBJECT_NOT_FOUND`, which step 0 already excludes.)
2. `bytes.length === 0` ⇒ **tolerated** — and ADR-591's `untyped`, since there is no header to
   recover (Pin P3, R4: git treats an empty file as one it could not read, not as one whose type it
   failed to recover).
3. `parseHeader(await ctx.compressor.inflate(bytes))` throws ⇒ **unrecoverable**, carrying the thrown
   error (Pin P4, P5, R3, R8, R10a, R10b). `parseHeader`, **not** `splitObject` — that one line is
   what keeps Pin R10c out of the class, because `splitObject` adds the size check git does not make
   here.
4. it returns ⇒ **tolerated** — and ADR-591 keeps the `type` field it just returned (arm 1), which is
   what finally makes Pin R10c/R10d's *"a recovered type is a reported type, whatever the body does
   behind it"* true of tsgit and not only of git (P6).

The catch in step 3 is narrow — `DECOMPRESS_FAILED` and `INVALID_OBJECT_HEADER` are the only codes
`inflate` and `parseHeader` can raise — and rethrows everything else, so a file that changed under
the probe surfaces its I/O fault instead of being laundered into an abort. That is §D10 T-6's rule
applied to a second allow-list, and the two `UNSUPPORTED_OPERATION` propagation rows in §Test
strategy exist here for the same reason they exist for `health()`.

#### §D13.2 — one more question: git aborts only when nothing can type the object

Pin R9 is the row ADR-590's one-line description could not anticipate. A garbled loose file whose oid
*also* sits in a healthy pack exits 0 in git, because git types it from the pack. tsgit reads
**loose-before-pack**, so its `readObject` fails on the shadowed copy — a pre-existing read-path
divergence (§Out of scope, *loose-before-pack read order*) that this mechanism would otherwise
amplify from "one null cache entry" into "the whole report withheld". So step 3's `unrecoverable`
verdict is confirmed by one last question,
asked only for a genuine abort candidate and therefore never on a healthy path:

```ts
(await registry.lookup(id)) === undefined   // ADR-572's ordinary lazy gate — never health()
```

An id a pack index still claims is **tolerated**. ADR-590 bound only the abort axis, so this section
left the cell divergent on the *type* (`'unknown'` versus git's `blob`); **ADR-591 closes that half**
by typing the object from the very `PackLookupHit` this condition produces — one lookup, two answers
(§D13.8). Three notes on the shape:

- **It lives inside `recoverLooseHeader`**, which reaches the registry through `getPackRegistry(ctx)`
  — the per-`Context` instance `readObject` has already been using, so no scan and no second
  generation appear (§D11.9's "one registry per `Context`" stays true).
- **It is `lookup`, never `health()`.** `lookup` is the lazy, index-claim-gated read path ADR-572
  positioned there; `health()` opens every pack and is `fsck`'s pack pass's business, not this
  helper's (§D11.5).
- **It is placed last on purpose**: the only step that can touch a pack, reached only by a damaged,
  loose, non-empty, header-unrecoverable object — which is to say, essentially never.

#### §D13.3 — the fault is recorded where it is found and rejected where reachability is known

`buildObjectCache` must **not** reject at the point of discovery. It reads every universe object
regardless of reachability, and Pin R1 pins a *reachable* undecodable object as exit 0 with git's
stderr completely empty. So discovery records, and the guard rejects:

```ts
export interface ObjectCacheResult {
  readonly cache: ReadonlyMap<ObjectId, CachedGitObject>;
  /** oid → the fault that made its type unrecoverable. Always empty unless `unreadable === 'classify'`. */
  readonly unrecoverable: ReadonlyMap<ObjectId, TsgitError>;
  /** oid → the type its *stored header* declares, for an object whose body would not parse
   *  (ADR-591, §D13.8). Always empty unless `unreadable === 'classify'`. */
  readonly recovered: ReadonlyMap<ObjectId, FsckObjectType>;
}
```

The cache's `catch` arm keeps its one statement and gains one branch — the probe answers both
questions in one pass, which is why ADR-591 adds a map and not a second traversal:

```ts
} catch (err) {
  cache.set(id, null);
  if (unreadable === 'classify' && isDecodeFault(err)) {
    const recovery = await recoverStoredType(ctx, id, err);
    if (recovery.kind === 'typed') recovered.set(id, recovery.objectType);
    if (recovery.kind === 'unrecoverable') unrecoverable.set(id, recovery.cause);
  }
}
```

and `fsck.ts` gains one line, immediately after `classifyObjects` — the first point at which the
`unreachable` array exists:

```ts
assertTypesRecoverable(ctx, unreachable, unrecoverable);
```

`UnreadableMode` (`'skip' | 'classify'`) is the **same** value §D12.2 threads into
`collectTypeFindings`, computed once in `fsck.ts` from `opts.connectivityOnly === true` and passed to
both consumers. One predicate, one origin — §D11.11's disjoint-gates trap is not made worse by
ADR-590, because this is the *same* gate §D12 already keys on, not a third one.

Four properties fall out of that placement — the first three are requirement 19's mode, scope and
reachability clauses; the fourth is what makes a rejected promise the right shape at all:

- **Default and `full: false` stay byte-identical to today by construction, not by a second gate.**
  In `'skip'` mode the map is never populated, so the guard is a total function over an empty map and
  no mode test appears at the call site. The content pass keeps classifying those objects as
  `bad-object` with exit bit 1 (Pin O′ O12/O13; Pin R3/R8/R10a/R10b default columns) — and it is the
  only mode where two codepaths could ever disagree about one object, because the content pass does
  not run in the other.
- **The guard's input is `unreachable`, never `dangling`** (Pin R2). tsgit's `unreachable` is exactly
  `universe \ reached`, which is git's `check_unreachable_object` domain; `dangling` is its
  in-edge-free subset and would silently pass R2's referenced object.
- **A reachable object cannot reach the guard**, because `buildReachableSet` adds an unreadable
  reached object to `reached` and `classifyObjects` skips everything reached (§D12.1). Pin R1, R5,
  P7, P8 and O15 survive with nothing written to preserve them — the same by-construction argument
  §D12.1 relies on, now load-bearing twice and mutation-relevant in both places (§D13.6).
- **The reject withholds the whole report**, because a rejected promise returns no `FsckResult` and
  the findings assembled before it are unobservable. Pin R6's empty stdout is reproduced without a
  "suppress" concept existing anywhere in the code.

**Determinism.** With several unrecoverable ids the guard rejects on the first in `unreachable`
order, which is `universe` order (`enumerateObjects`: loose ids, then packed). git names whichever it
reaches first; the two orders are not compared and no test asserts across them — every fixture in the
matrices damages exactly one object, and the multi-damage row asserts only *that* it rejects.

**Ordering against the pack pass is a non-question.** ADR-586's bit 64 is the one exit term that also
fires in `connectivityOnly`, so a repo can qualify for both it and the reject; Pin R12 pins git at
**128**, not 64 — the `die()` takes the accumulated bits with it. A rejected promise does the same to
whatever the pack pass computed, so the guard may sit before or after that pass without changing what
a caller observes. Placing it after `classifyObjects` is a readability choice, not a correctness one,
and no test may assert the pack pass's side effects on a rejecting row.

#### §D13.4 — the error shape: the store's own error, rethrown

The reject carries **the `TsgitError` the recovery produced** — `DECOMPRESS_FAILED { reason }`
(Pin P4, P5, R3) or `INVALID_OBJECT_HEADER { reason }` (Pin R8, R10a, R10b) — rethrown, not
re-wrapped, not re-coded. Three reasons in decreasing weight:

- It is the same value `readObject(ctx, <oid>)` already throws for that object, so `fsck`'s reject
  and every other command's failure on the same damage are indistinguishable — which is honest: they
  are the same failure. Nothing is invented for a condition git models as a bare exit code carrying
  no structured data at all.
- **Zero public surface.** A new `TsgitErrorData` arm would widen a public union and add a
  `formatError` case; requirement 14 stays as written and `reports/api.json` gains nothing from
  ADR-590.
- ADR-249: git's `fatal: loose object <oid> (stored in <path>) is corrupt` is *presentation*. The
  binding datum is that the command aborts, and a rejected promise is that datum.

Its one real cost is that neither code carries the object id, and `error.ts` has no id-bearing
"corrupt object" arm to reach for: `OBJECT_NOT_FOUND` is refuted by ADR-590 itself (the file exists),
`OBJECT_HASH_MISMATCH` and `OBJECT_TOO_LARGE` would each be a lie, and inventing one is the surface
delta the previous bullet declines. The id therefore leaves on the channel this repo already uses for
a fault it reports rather than returns: one
`ctx.logger?.warn?.('fsck: object type unrecoverable', { objectId, reason })` at the reject site,
flat string values only, per the Logger port's top-level-string sanitiser and `pack-registry.ts:70`'s
`faultContext` precedent. Exactly one warn per aborted run — never one per object, never one for a
`tolerated` fault — so a healthy repo's log volume is unchanged and the warn cannot be mistaken for
the per-pack degradation warns.

#### §D13.5 — what it costs, and the three places it costs nothing

- **`'skip'` mode** (default, `full: false`) pays nothing: no probe, no second read, one mode
  comparison on a path that already failed.
- **A healthy repo in `'classify'` mode** pays nothing: the `catch` never runs.
- **A refused pack** (Pin M7, cardinality Pin Q) pays N failed reads exactly as today plus N string
  comparisons — **no syscalls at all**: those reads fail `OBJECT_NOT_FOUND` and step 0 excludes them
  before the probe is entered. The row this feature is *about* pays nothing for the row it is not.
- **A damaged loose object** pays one extra `ctx.fs.read` and one extra inflate of its own bytes,
  plus — only if it is an abort candidate — one `registry.lookup`. It is the only place in this
  design an object is read twice, it is bounded by the damage, and the run it slows down is the run
  that is about to reject.
- **ADR-591's retention adds nothing to the first three bullets** and, to the fourth, only what the
  type actually costs: arm 1 is free (the type is a field of the value step 3 already produced), and
  arms 2 and 3 add one memoised `registry.lookup` — already performed on the arm-3 path — plus one
  small `readSlice` per damaged object and one more per delta link (§D13.8). The widened
  `isDecodeFault` entry set means a *body*-parse failure now pays the loose probe too (Pin R10d):
  one read and one inflate of an object whose read already failed, in the one mode that does no
  content pass.

#### §D13.6 — the mutation consequences, including a third dead equivalence proof

- **`object-cache.ts:32`'s `// Stryker disable` is deleted.** Its equivalence claim is that not
  setting a key reads the same as setting `null`; the directive covers the whole `catch` block, and
  that block now has a second observable statement. Emptying it makes a `connectivityOnly` run over
  an unrecoverable object *resolve* where it must reject, so the mutant is killable — by the same
  rows requirement 19 needs anyway. Deleted, not re-justified: this is the third carried-forward
  equivalence proof in this neighbourhood falsified by a data-shape change (§D12.4), and the first
  two were also "still true" until they were not.
- **`reachability.ts:163`'s deleted directive gets a second killer.** §D12.4 established that the
  now-live `BlockStatement` mutant (dropping `reached.add(id)` for an unreadable object) is killed
  only by a `connectivityOnly` reachable-unreadable row. That row still kills it, and the new
  reachable-**undecodable** row (Pin R1) kills it a second way: with `reached.add` gone, the object
  becomes unreachable, the guard finds its recorded fault and the run rejects, so a test asserting a
  resolved result fails. Two independent kills on one mutant is not redundancy to prune — the two
  rows differ in fault class, and each is the *only* killer of a different mutant elsewhere in
  §D13.1's step list.

#### §D13.7 — the whole class, row by row, as the implementer will need it

The `probe verdict` column carries ADR-591's outcome (§D13.8) as well as ADR-590's, because one probe
answers both questions. **No row moved into or out of the rejecting set when ADR-591 landed** — only
the type column of four already-resolving rows changed.

| pinned row | what tsgit's read throws | probe verdict | tsgit result in `connectivityOnly` |
|---|---|---|---|
| P2 / O11 — `chmod 000` | `PERMISSION_DENIED` | not a candidate (`isDecodeFault`) | `dangling` + `unreachable`, `'unknown'`, exit 0 — **faithful** |
| P3 / R4 — empty file | `DECOMPRESS_FAILED` | **untyped** (step 2) | `dangling` + `unreachable`, `'unknown'`, exit 0 — **faithful** |
| P4 / R3 — non-zlib garbage, dangling | `DECOMPRESS_FAILED` | **unrecoverable** | **rejects** `DECOMPRESS_FAILED` |
| P5 — truncated to 8 bytes | `DECOMPRESS_FAILED` | **unrecoverable** | **rejects** `DECOMPRESS_FAILED` |
| R8 — valid zlib, no NUL in 32 bytes | `INVALID_OBJECT_HEADER` (*missing null terminator*) | **unrecoverable** | **rejects** `INVALID_OBJECT_HEADER` |
| R10a — header `widget 5\0` | `INVALID_OBJECT_HEADER` (*unknown object type*) | **unrecoverable** | **rejects** `INVALID_OBJECT_HEADER` |
| R10b — header `blob abc\0` | `INVALID_OBJECT_HEADER` (*invalid size*) | **unrecoverable** | **rejects** `INVALID_OBJECT_HEADER` |
| R10c — header `blob 99\0`, 2 content bytes | `INVALID_OBJECT_HEADER` (*size mismatch*, from `splitObject`) | **typed `blob`** (step 4, arm 1) | `dangling`/`blob`, exit 0 — **faithful** |
| R10d — header `tree 4\0`, junk body | `INVALID_TREE_ENTRY` | **typed `tree`** (step 4, arm 1 — entered via `isDecodeFault`, never an abort candidate) | `dangling`/`tree`, exit 0 — **faithful** |
| P6 / O14 — hash-path mismatch | *nothing — it decodes* | never reached | `dangling`/`blob`, exit 0 — **faithful** |
| R2 — undecodable, unreachable, referenced | `DECOMPRESS_FAILED` | **unrecoverable** | **rejects** — the id is in `unreachable`, not in `dangling` |
| R1 / P8 — undecodable, **reachable** | `DECOMPRESS_FAILED` | unrecoverable, but **never in `unreachable`** | no finding, exit 0 — **faithful** |
| R7 — packed entry body corrupt | `DECOMPRESS_FAILED` | **typed `blob`** from the pack entry (step 1, arm 2) | `dangling`/`blob`, exit 0 — **faithful** |
| R13 — packed **delta** entry body corrupt | `DECOMPRESS_FAILED` | **typed `blob`** from the delta base's entry (arm 2, base-link walk) | `dangling`/`blob`, exit 0 — **faithful** |
| R9 — loose garbled, healthy packed copy | `DECOMPRESS_FAILED` | **typed `blob`** from the packed copy (§D13.2's hit, arm 3) | `dangling`/`blob`, exit 0 — **faithful** |
| M7 — refused pack's ids | `OBJECT_NOT_FOUND` | not a candidate (`isDecodeFault`) | `dangling` + `unreachable`, `'unknown'` ×N, exit 0 — **faithful** |

Every row now reads **faithful** or **rejects**; the `type residual §D11.16` annotation that stood
against R7, R9 and R10d is gone, and R10c is the row worth pausing on — the previous revision already
claimed `blob` for it while the mechanism it described produced `'unknown'` (the read throws inside
`splitObject`, so the cache entry is null and `resolveObjectType` had nothing else to consult). ADR-591
is what makes that cell true rather than asserted.

#### §D13.8 — the type the probe already recovered, retained (ADR-591)

§D11.16 named the last residual: git types an unreachable object from its **stored header**, tsgit
from a successful `parseObject`, so three rows reported `'unknown'` where git prints a real type. The
user ruled it closed. The closure asks **no new question** — §D13.1's step 3 already parses the loose
header and §D13.2 already asks whether a pack claims the oid; both compute exactly what git prints
and then throw it away. Retention keeps it.

**What `'unknown'` means afterwards.** tsgit emits it when — and only when — *no stored header could
be obtained at all*: an unopenable file (Pin P2), an empty one (Pin P3, R4) and a refused pack's ids
(Pin M7). That is precisely the set git prints `dangling unknown` for. A loose object whose header is
unrecoverable reaches the question only when a pack still claims its oid — that is arm 3, Pin R9;
otherwise requirement 19 rejects on it before any finding exists.

**Three arms, one map.**

| the read failed because | where the type comes from | pins |
|---|---|---|
| the loose header parsed but the **body** did not | `parseHeader`'s own `type`, already in hand at §D13.1 step 3 — **no extra I/O whatsoever** | R10c, R10d |
| the object is **not loose** — the failure was a pack read | the **pack-entry header** at `lookup`'s offset; a delta entry resolves to its base's type by walking base links through entry headers only, never inflating a body | R7, **R13** |
| the loose header is unrecoverable but a **pack claims the oid** | the same pack-entry read, on the hit §D13.2 already holds | R9 |

Arms 2 and 3 are one code path reached from two places, which is why the pack arm costs one function
and not two. It reads the entry header through `PackLookupHit` + `parsePackEntryHeader` — the pair
`resolvePackChain` already uses — and follows `OFS_DELTA` / `REF_DELTA` base links exactly as that
walker does, stopping at the first non-delta entry's type. Pin R13 is what makes that a pinned
behaviour rather than an inference from R7's single non-delta entry, and it was run in both encodings
because the walker branches on which one it sees.

**Where the retained type flows.** `buildObjectCache` returns it in `recovered` (§D13.3);
`fsck.ts` threads that map into `collectTypeFindings` beside the cache; `collectTypeFindings`
resolves through the **same** `resolveObjectType` §D12.1 already routes through, which gains one
fallback line and no new `'unknown'` derivation:

```ts
export function resolveObjectType(
  id: ObjectId,
  objectCache: ReadonlyMap<ObjectId, CachedGitObject>,
  recovered: ReadonlyMap<ObjectId, FsckObjectType>,
): FsckObjectType | 'unknown' {
  const obj = objectCache.get(id);
  if (obj != null) return obj.type;
  return recovered.get(id) ?? 'unknown';
}
```

so the retained type reaches exactly the two finding kinds ADR-588 widened — `dangling` and
`unreachable` — and nothing else. `fsck.ts:87`'s `missing` call site passes the same map and is
unchanged **by construction**: a missing id is by definition outside the universe, so it has neither a
cache entry nor a recovery entry. One resolver, two call sites, one meaning.

**It stays emission-only** (requirement 18). `recovered` is a *sibling* of the cache, never a
substitute entry inside it. Putting a `{ type }` stub in `cache` would be the shorter diff and is
wrong: `buildInEdgeMap` and `buildReachableSet` both branch on `obj == null`, so a stub would turn an
undecodable object into a readable one with no out-edges and change reachability on exactly the rows
Pin R1 / P7 require to stay silent — and `visitObject` would then read fields a stub does not have.
The map is consulted at emission and nowhere else.

**Retention is monotone, and that is the whole compatibility argument with ADR-590.** It can only
replace `'unknown'` with a real type. It adds no finding, removes none, touches no exit bit, and
**cannot change an abort verdict**: requirement 19's four conjuncts are computed by §D13.1 steps 1–4
and §D13.2 exactly as before, and the `unrecoverable` verdict remains gated on §D13.1 step 0's
unchanged two-code test. A reviewer checking ADR-591 against ADR-590 needs only that sentence and the
§D13.7 table, in which **no row moved into or out of the rejecting set**.

**The entry gate, and why it may over-approximate but not under-protect.** R10d's read throws
`INVALID_TREE_ENTRY`, which step 0 deliberately excludes — so retention cannot hang off the abort
candidate set. It hangs off a wider one: `isDecodeFault(err)`, a membership test over the closed set
of codes reachable **once the object's bytes are already in hand** — `DECOMPRESS_FAILED` and
`INVALID_OBJECT_HEADER` (§D13.1's two) plus the codes `parseObject` raises after `parseHeader` has
succeeded: `INVALID_TREE_ENTRY`, `INVALID_COMMIT`, `INVALID_TAG`, `INVALID_IDENTITY`,
`INVALID_FILE_MODE`, `INVALID_OBJECT_ID`, `TREE_ENTRY_LIMIT_EXCEEDED`.

Three properties make that list safe to write down rather than a drift hazard:

- **It is an allow-list, so it fails toward today.** A parse code missing from it yields
  `'unknown'` — the pre-ADR-591 answer — never a wrong type and never an abort. A deny-list over I/O
  codes would fail the other way: one unlisted access code and Pin P2's `chmod 000` object gets its
  read retried inside the probe, the `PERMISSION_DENIED` propagates, and a run git completes rejects.
  That asymmetry, not brevity, is why the longer list wins.
- **Not one of its members can come from `ctx.fs`**, so the two pinned negatives hold structurally:
  `PERMISSION_DENIED` (P2) and `OBJECT_NOT_FOUND` (M7, a refused pack's ids) are outside it and
  neither ever enters the probe.
- **It is a `Set` membership test, not a `||` chain**, so it is one `ArrayDeclaration` / one
  `MethodExpression` mutant rather than nine `LogicalOperator` operands — the isolated-guard rule
  costs one row here, not one per code (§Mutation).

**Two boundaries it deliberately does not cross.**

- **A refused pack's ids stay `'unknown'`.** The pack arm goes through `lookup`, ADR-572's
  header-gated read path, so a refused pack yields no hit and no type. That is not a shortfall — git
  refuses the pack too and prints `dangling unknown` (Pin M7). The gate is what keeps the two tools
  equal, and routing the arm through `health()` instead would silently *break* M7 (§D11.5).
- **The pack arm is reached only from the two arms above, never as a general fallback.** So a loose
  file that is unopenable (P2) or empty (R4) *and* whose oid a pack also claims stays `'unknown'`
  where git would print the packed type: the first never enters the probe at all (step 0's reasoning
  applies unchanged to `isDecodeFault`, and reaching it would mean re-reading the file the pre-filter
  exists to leave alone), the second answers `untyped` at step 2. Both cells are unpinned on **both**
  sides — P2's, R4's and R9's fixtures each hold exactly one source — and both are facets of the
  pre-existing loose-before-pack read order already in §Out of scope. Widening the arm to fire
  wherever the loose form yields no type would be a plausible generalisation of R9's rule and is
  declined for the reason §D11.14 gives: every branch here defends a pinned row, and this one would
  defend none.

**Cost.** Arm 1 is free — the type is a field of a value step 3 already produced. Arms 2 and 3 add one
memoised `registry.lookup` (the `.idx` is already parsed; for arm 3 it is the lookup §D13.2 performs
anyway) and one small `readSlice` per **damaged** object, plus one more per delta link. Nothing on a
healthy repo, nothing in `'skip'` mode, and nothing on the refused-pack row (§D13.5).

**Surface.** Zero delta beyond ADR-588's: `FsckObjectType | 'unknown'` is unchanged as a *type* —
ADR-591 narrows *when* the `'unknown'` member occurs, which is behaviour, not surface. `recovered`
lives on the command-internal `ObjectCacheResult`, and `resolveObjectType` /`collectTypeFindings` are
command-internal too, so `reports/api.json` gains nothing from this ruling (requirement 14).

## Decision candidates

Nine load-bearing choices were raised in the original draft and a tenth by ADR-588's pins; all ten
are settled as ADR-581 … ADR-590 and each is marked below. The option tables are kept verbatim —
they are the record the ADRs point into, so a table's present tense describes the choice as it stood
when it was put, not the design as it now is.

### DC-1 — How per-pack health reaches `fsck`

> **Settled: ADR-581 — option (a).** Adopted as recommended.

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

> **Settled: ADR-582 — option (a).** Adopted as recommended.

*Constraint:* ADR-572 made the gate lazy on purpose and must not regress; but Pin M1/M2 show git's
`fsck` opens **every** pack, including ones no object needs.

| | option | consequence |
|---|---|---|
| **(a)** | **Eager** — `health()` awaits `pack.header()` for every registered pack: one 12-byte `ctx.fs.readSlice` each, no `FileHandle`, reusing the existing memo | faithful to Pin M1/M2; `lookup` untouched; a successful probe warms the memo, a failed one clears it (28.1 Pin C5 preserved) |
| (b) | **Lazy** — report only packs a preceding read already probed | diverges on Pin M1/M2: a refused pack holding objects nothing requests goes unreported, which is the headline case |
| (c) | Add a synchronous `validated` flag to `RegisteredPack` and read it | mutable state on the read path, which 28.1 §D7 explicitly declined for a measurable nothing — and it still needs (a) to populate it |

**Recommendation: (a).**

### DC-3 — One finding variant, or two?

> **Settled: ADR-583 — option (a).** Adopted as recommended.

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

> **Settled: ADR-584 — option (a).** Adopted as recommended.

*Constraint:* §D10 T-3 — the identifier crosses the library boundary as data no sanitiser
touches, and `isSafePackName` has already constrained the *name* but not a composed path.

| | option | consequence |
|---|---|---|
| **(a)** | **`pack: string`** — the base name (`pack-<sha>`), the value `isSafePackName` already vetted | smallest faithful datum; the caller knows its own object directory and composes git's line from it; a future repair surface takes the same identifier. It is also the **only** field both layers can carry uniformly: an index-layer fault never constructed a `RegisteredPack`, so it has a candidate name and no derived `packPath` — (b) would have to re-derive one for exactly the rows where the derivation is least trustworthy |
| (b) | **`path: string`** — the derived `.pack` path | reconstructs git's line without the caller knowing the layout, but discloses the gitdir path and differs by adapter (browser paths are `/`-rooted). git itself prints a *relative* path for the local dir and an *absolute* one for an alternate, so "verbatim" is not even well-defined |
| (c) | Both fields | maximal caller convenience, largest disclosure, two fields to keep consistent |

**Recommendation: (a).**

### DC-5 — How `fsck`'s universe drops inaccessible packs

> **Settled: ADR-585 — option (a),** user-ratified. The layering argument won over the surface delta. §D12.5 adds the constraint the ADR implies but does not spell out: the knob must be **off** in `connectivityOnly` mode.

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

> **Settled: ADR-586 — option (a),** user-ratified: model the bit *and* the ungated finding variant.

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

> **Settled: ADR-587 — option (a),** user-ratified: accessibility only; the pack-body residual is a capability boundary, not deferred work.

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

> **Settled: ADR-588 — option (a), overriding the design's recommendation of (b).** Shipping a known
> divergent cell in a mode this feature otherwise makes faithful was judged to contradict both the
> prime directive and the no-follow-ups directive. The closure is designed in **§D12**; the
> loose-object rows option (a) called out as "needing their own git pins" are **§Pin P**, and the
> cardinality question left open in Pin M7 is resolved in **§Pin Q**.
>
> The pins refine option (a)'s one-line description in two ways the option table could not
> anticipate, and both are now requirements rather than choices:
> - "stop skipping null-cache entries" is **gated on `connectivityOnly`**. Applied unconditionally it
>   would emit `dangling unknown` in default and `--no-full` mode, where git computes no such entry
>   at all (Pin P2–P6 and the P-a projection probe) — i.e. it would *create* a divergence in the two
>   most-used modes while closing one in the third.
> - the widening lands on the two **finding fields**, not on the domain `FsckObjectType`, which
>   `validate-object.ts` and the `tagged` finding depend on keeping to four real object kinds (§D12.3).
>
> One cell the closure still does not reach was carried forward as **DC-10**, and is now settled by
> ADR-590 (option (a), §D13): `fsck` rejects on it rather than classifying it.

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
means shipping a known divergent cell rather than filing it. *(Superseded: the user chose (a).)*

### DC-9 — Where the pass lives

> **Settled: ADR-589 — option (a).** Adopted as recommended.

| | option | consequence |
|---|---|---|
| **(a)** | **`src/application/commands/internal/fsck/pack-health.ts`**, exporting `runPackHealthPass` | matches `runContentValidationPass` / `runRefsVerifyPass` exactly; command-internal, invisible to `api.json` |
| (b) | Inline in `fsck.ts` | `fsck.ts` is 104 lines and already at the limit of what reads as one function; the pass would add a third concern |
| (c) | A Tier-2 primitive `checkPackHealth(ctx)` exported from `primitives/index.ts` | reusable and independently documented; adds a public export → `api.json` entry, a doc-coverage page, and a surface commitment for a capability with exactly one caller |

**Recommendation: (a).**

### DC-10 — Does the closure extend to the loose object git *dies* on?

> **Settled: ADR-590 — option (a),** user-ratified against no designer recommendation. Raised by
> §Pin P4/P5, executed after ADR-588 was taken; not a re-litigation of DC-8 — that ruling stands and
> §D12 implements it — but the one cell that ruling's mechanism does not reach. The mechanism is
> **§D13**; the fault discriminator it needs is pinned in **§Pin R**, which was commissioned by this
> ruling and refines option (a)'s one-line description in three ways the option table could not
> anticipate, all of them now requirements rather than choices:
> - *"opened but undecodable"* is really **"opened, and no `<type> <size>\0` header can be recovered
>   from it"** — the class covers an unknown type name and a non-numeric size as well as a dead zlib
>   stream (Pin R8, R10a, R10b), and excludes a *recovered* header over a body that is wrong in any
>   way (Pin R10c, R10d). No error-code allow-list expresses that split (§D11.15).
> - the abort is scoped to objects git does **not reach**, and to *all* of them, not just the
>   dangling ones (Pin R1 versus R2) — so the guard runs over `unreachable`.
> - it does not fire when another source can type the object: a packed body that will not inflate,
>   or a garbled loose file shadowing a healthy packed copy, both exit 0 in git (Pin R7, R9).
>
> One residual the pins exposed and this ruling does **not** cover was carried forward on a different
> axis from the abort: git types an unreachable object from its header, tsgit from a successful parse,
> so three rows kept `objectType: 'unknown'` where git prints a real type. It was a findings-shape
> residual of ADR-588's closure and is **now settled by ADR-591** — §D13.8 retains the recovered
> type, §D11.16 states the reserved meaning of `'unknown'` that follows, and Pin R13 pins the one leg
> (a delta-stored entry) that no earlier row reached. Nothing about the abort moved.

*Constraint:* within `--connectivity-only`, git splits unreadable objects by fault class (Pin P).
An object it cannot **open** (EACCES) or that is **empty** becomes `dangling unknown` and the run
continues — §D12 reproduces that exactly. An object it **can** open but whose zlib stream is
undecodable makes git `die()`: **exit 128, stdout empty, no findings at all** (P4, P5), deterministic
across repeated runs and unaffected by other healthy findings in the repo, which are also suppressed.
tsgit cannot distinguish these classes today — `buildObjectCache` catches every failure into one
`null` — so after §D12 it returns exit 0 with a `dangling unknown` finding for a row where git
produces exit 128 and nothing. Note the row is *already* divergent today (tsgit: exit 0, no finding),
so no option here is a regression; the question is which divergence, if any, ships.

| | option | consequence |
|---|---|---|
| (a) | **Close it** — distinguish "cannot open / empty" from "opened but undecodable" in the object cache, and make `fsck` **reject** on the latter in `connectivityOnly` mode | exact parity on every Pin P cell. But `fsck` — an *integrity-reporting* command — learns to abort instead of report, on one fault class, in one mode. It also needs a new fault discriminator in `buildObjectCache`, whose single `catch` is currently what keeps the command total (ADR-411's premise is that the maximal taxonomy is always computed and returned) |
| (b) | **Classify it like the others** — `dangling unknown`, exit 0 | what §D12 does if nothing is added; one uniform rule, no abort concept, no new discriminator. Ships a known divergent cell (git 128 / tsgit 0) on the corrupt-loose-object row — the same shape of residual DC-8 was ruled against, which is exactly why this is not a designer's call |
| (c) | **Report it, differently** — classify it `dangling unknown` **and** set exit bit 1, matching git's *default-mode* verdict for the same damage (Pin P4 default column) | a nonzero exit that a finding explains, and no abort; but 1 ≠ 128 and git sets no bit in this mode, so it is a third behaviour matching neither tool's connectivity-only cell |

Refuted in writing: *treat it as `missing`* — the object file exists, git never calls it missing in
any mode (Pin P4, P9), and bit 2 would be a connectivity claim about a present object.

**No recommendation.** DC-8's ruling established that shipping a known divergent cell is the user's
call and not the designer's; this cell is the same class of question, and the pins deliberately stop
at describing it. *(Superseded: the user chose (a). Option (b)'s "what §D12 does if nothing is
added" is therefore a counterfactual — §D12 alone would have classified this cell
`dangling unknown`; §D13 rejects on it instead.)*

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
| `.idx` corrupt | one index-layer finding; bits 4 \| 64 (ADR-586) |
| **orphan `.idx`** | **no finding, `exitCode` 0** — own `it` |
| two unusable packs | two findings; bit 4 set once |
| v99 **+** healthy twin (Pin M3) | the objects are still classified `dangling`/`unreachable` **and** the pack is reported |
| v99 holding every reachable object (Pin M5) | pack finding **plus** `missing` + `broken-link`; bits 2 and 4 both set (requirement 8) |
| `connectivityOnly: true` | no pack finding; bit 4 absent — own `it` |
| `full: false` | no pack finding; bit 4 absent — own `it`, because one test setting both options proves neither gate |
| `strict: true` | bit 4 unchanged (Pin K) |
| `connectivityOnly` + corrupt `.idx` | bit 64 present, bit 4 absent — the row that isolates ADR-586's ungated term |

#### The §D12 classification rows — `test/unit/application/commands/fsck.test.ts`

`sut` = `fsck`. Every row asserts the `objectType` **value**, never just the finding's presence: the
whole change is that one field can now be `'unknown'`, and a presence-only assertion passes on the
old code for the typed rows and on a mis-keyed widening for the untyped ones. After ADR-591 the
`'unknown'` rows below are also the *boundary* rows for §D13.8's retention — an unopenable file and a
refused pack's ids must stay `'unknown'` because no store can type them, and a retention that reached
them would pass every other row in the matrix (§D13.8's two boundaries).

| case | arrangement | expectation |
|---|---|---|
| refused pack, `connectivityOnly` | v99 pack whose ids are supplied by nothing else | one `dangling`/`unknown` **and** one `unreachable`/`unknown` per id; `exitCode` 0 (Pin M7, §D12.5) |
| refused pack, **default** | same fixture | **zero** `dangling`, **zero** `unreachable` for those ids — requirement 7's narrowing, and the row that fails if the gate is inverted |
| refused pack, **`full: false`** | same fixture | zero findings for those ids — its **own `it`**: `full: false` and `connectivityOnly` disagree here (Pin M7 vs M8), so a single test setting both proves neither |
| unreadable **loose** object, unreferenced, `connectivityOnly` | one loose object whose read rejects `PERMISSION_DENIED`, no packs present | `dangling`/`unknown` + `unreachable`/`unknown`; `exitCode` 0 (Pin P2) |
| unreadable **loose** object, unreferenced, **default** | same fixture | **no** `dangling`, **no** `unreachable` (Pin P2 default column, P-a) — the row that catches an ungated widening |
| **reachable** unreadable object, `connectivityOnly` | damaged blob referenced by a reachable tree | **no** `dangling`, **no** `unreachable`, no `missing`, `exitCode` 0 (Pin P7, O15). **This is the row that kills the `reachability.ts:163` mutant** (§D12.4) — without it, deleting `reached.add(id)` survives |
| decodable object failing its hash check, `connectivityOnly` | hash-path mismatch fixture | `dangling`/**`blob`** — the real type, not `'unknown'` (Pin P6, O14): proves the widening keys on the null cache entry and not on "the content pass complained" |
| in-edge demotion, `connectivityOnly` | two unreadable ids, one referenced by a **readable** object | the referenced one is `unreachable` only; the other is `unreachable` **and** `dangling` (Pin Q5/Q6) — proves `buildInEdgeMap` still governs and §D12 changed emission only (requirement 18) |
| healthy repo, all three modes | no damage | findings identical to today in every mode — the no-op guard for a widening that leaks |

#### The §D13 reject rows — `test/unit/application/commands/fsck.test.ts`

`sut` = `fsck`. Every rejecting row asserts the error's **`.data`** through `try`/`catch`, never
`toThrow(TsgitError)` — the code *and* the reason distinguish the two abort classes, and a
type-only assertion passes on either. Every tolerating row asserts a **resolved** result and the
`objectType` value, because "did not reject" is the whole claim and an absence-only assertion also
passes on a run that rejected for a different reason. Each row is its own `it`: they are the four
conjuncts of requirement 19 and no two may share an arrangement.

After ADR-591 the `objectType` assertion is doing **two** jobs on the tolerating rows: it proves the
run resolved *and* it proves which store typed the object. The three rows that must stay `'unknown'`
— unopenable (P2), empty (P3/R4) and the refused-pack ids (M7) — are that claim's boundary and are
already in this matrix and the §D12 one; they are what stops a retention that types everything, just
as the retention rows are what stops a `'unknown'` that means "read failed".

| case | arrangement | expectation |
|---|---|---|
| **undecodable, dangling, `connectivityOnly`** | one loose object whose bytes are non-zlib garbage, no packs | **rejects**; `.data.code === 'DECOMPRESS_FAILED'` (Pin P4, R3) |
| same fixture, **default** | — | **resolves**; `bad-object` finding, `exitCode` bit 1, no `dangling` (Pin R3 default column, O′ O13) |
| same fixture, **`full: false`** | — | **resolves**, same as default — its own `it`, because one test setting both options proves neither gate |
| same fixture, **`connectivityOnly` + `full: false`** | — | **rejects** — the combination Pin R11 pins, and the row that fails if the gate ever consults `full` |
| **unrecoverable header**, dangling, `connectivityOnly` | valid zlib whose inflated bytes have no NUL in the first 32 | **rejects**; `.data.code === 'INVALID_OBJECT_HEADER'` and `.data.reason` asserted (Pin R8) |
| **unknown type name**, dangling, `connectivityOnly` | valid zlib, header `widget 5\0` | **rejects**; `.data.reason` names the type — own `it` (isolated-guard rule over the recovery's two-code catch) (Pin R10a) |
| **size mismatch**, dangling, `connectivityOnly` | valid zlib, header `blob 99\0` over 2 content bytes | **resolves**; `dangling`/**`blob`** — the row that forbids keying the abort on `INVALID_OBJECT_HEADER` as a code (Pin R10c, §D11.15). Its `blob` is now *produced* by arm 1 rather than assumed, which is what the previous revision's §D13.7 got wrong |
| **unparseable body, valid header**, dangling, `connectivityOnly` | header `tree 4\0` over 4 junk bytes | **resolves**; `dangling`/**`tree`**, `exitCode` 0 — one row, two claims: the *abort* pre-filter excludes `INVALID_TREE_ENTRY`, and `isDecodeFault` admits it so arm 1 types it (Pin R10d, §D13.8) |
| **same fixture, default** | — | **resolves**; `bad-object`, **no** `dangling`/`unreachable` — the row that proves the retention map is mode-gated, i.e. empty in `'skip'` mode, and its own `it` for the same reason the other mode pairs are |
| **empty file**, dangling, `connectivityOnly` | loose file truncated to 0 bytes | **resolves**; `dangling`/`'unknown'` — the `length === 0` row (Pin P3, R4) |
| **unopenable**, dangling, `connectivityOnly` | loose read rejects `PERMISSION_DENIED` | **resolves**; `dangling`/`'unknown'` — the step-0 row, and the one that fails loudly if the probe re-reads (Pin P2) |
| **reachable** undecodable, `connectivityOnly` | garbage blob referenced by a reachable tree | **resolves**; no finding for that oid, `exitCode` 0 (Pin R1) — second killer of the `reachability.ts:163` mutant (§D13.6) |
| **unreachable but referenced**, `connectivityOnly` | garbage blob referenced by a *dangling* readable tree | **rejects** (Pin R2) — the only row that fails if the guard is fed `dangling` instead of `unreachable` |
| **packed** object with an undecodable body, dangling, `connectivityOnly` | corrupt **base** entry in an otherwise accessible pack; the oid is not loose | **resolves**; `dangling`/**`blob`**, `exitCode` 0 — the step-1 row, and arm 2's non-delta leg (Pin R7) |
| **packed *delta* entry** with an undecodable body, dangling, `connectivityOnly` | corrupt `OFS_DELTA` entry whose base is healthy; a second `it` for the `REF_DELTA` encoding | **resolves**; `dangling`/**`blob`**, `exitCode` 0 — the base-link walk; the **only** rows that fail if arm 2 stops at the entry's stored type (Pin R13) |
| **loose garbled + healthy packed copy**, dangling, `connectivityOnly` | same oid loose (garbled) and in a healthy pack | **resolves**; `dangling`/**`blob`**, `exitCode` 0 — the **only** row that kills the §D13.2 lookup condition, and arm 3's only row (Pin R9) |
| **two damaged objects**, `connectivityOnly` | one healthy dangling blob + one undecodable dangling blob | **rejects**, and the healthy object's findings are unobservable (Pin R6) — asserts the abort, not which oid |
| refused pack, `connectivityOnly` (existing row above) | v99 pack, ids supplied by nothing else | **resolves** with `dangling`/`'unknown'` ×N — doubles as the proof that `OBJECT_NOT_FOUND` never enters the candidate set (Pin M7) |
| corrupt `.idx` **+** undecodable dangling object, `connectivityOnly` | both faults in one repo | **rejects** — the bit-64 term ADR-586 computes in this mode is not observable through a reject (Pin R12); the row exists to forbid a test that asserts `exitCode === 64` here |

`buildObjectCache` keeps being exercised **through `fsck`** rather than gaining a dedicated
`object-cache.test.ts`: it has exactly one caller, its new return shape is meaningful only in
combination with `classifyObjects`, and every row above is a statement about `fsck`'s observable
result. `content-validation.test.ts` stays the only per-internal file in that directory, for the
same reason it is one today — it owns a msg-id catalogue that `fsck`-level rows cannot enumerate.

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

**Five harness rules this suite must obey.**

- One shared `beforeAll` repo family and a 60 s timeout — heavy git-spawning interop suites time out
  hooks under `validate`'s concurrency.
- **Build the tsgit `Context` *after* every `git` subprocess write.** The per-`Context` loose-object
  fanout cache is invalidated only by tsgit's own `writeObject`, so a `Context` created before a
  `git repack` sees a stale loose view. Every row here writes with `git` first.
- Delete each fixture's `.rev` before mutating, or the reverse-index axis contaminates the pack rows
  (the same discipline the pins used).
- **`chmod u+w` before mutating any loose object** (K-22 … K-37) **and any copied pack file**
  (K-34 … K-36): git writes loose objects `0444` and a copied `.pack` keeps that mode, and a helper
  that skips this silently measures a *healthy* repo — the failure mode that produced five false
  cells on the first run of Pin P, one dead row on the first run of Pin R, and a `PermissionError`
  on the first run of Pin R13.
- **Each loose-object row gets its own repo**, not a shared one with several damaged objects. The
  abort rows withhold the whole report (Pin R6), so a second damaged object in the same fixture can
  mask exactly the assertion the row exists to make — and the reject's determinism is defined by
  universe order, which the fixture must not depend on (§D13.3).

| # | row | git assertion | tsgit assertion |
|---|---|---|---|
| K-1 | healthy pack | exit 0, no `packfile` line | no pack finding; bit 4 absent |
| K-2 | pack v3 | exit 0 | no pack finding |
| K-3 | **pack v99** | exit **4**; the reconstructed verdict line occurs **once** | one pack finding; bit 4; **zero** object findings from that pack |
| K-4 | header/index count disagreement | exit 4; cause `claims to have N objects while index indicates M objects` | one finding whose reason carries both counts |
| K-5 | signature `PACX` | exit 4; cause `is not a GIT packfile` | one finding |
| K-6 | pack truncated to 8 bytes | exit 4; cause `far too short to be a packfile` | one finding |
| K-7 | `.pack` `chmod 000` | exit 4; **verdict only**, no cause (Pin J5) | one finding; node tier only (no `chmod` on the other adapters) |
| K-8 | `.idx` same-length garbage | exit **68** | one index-layer finding; bits 4 \| 64 (ADR-586) |
| K-9 | `.idx` truncated to 8 bytes | exit 68 | same |
| K-10 | `.idx` `chmod 000` | exit 68; verdict lines only (Pin J10) | same; node tier only |
| K-11 | **orphan `.idx`** | exit **0**, silent | **no finding**; `exitCode` 0 |
| K-12 | **idx-less `.pack`** | exit 0, silent | no finding |
| K-13 | two unusable packs | exit 4; the verdict line occurs **twice**, once per pack | two findings; bit 4 once |
| K-14 | v99 **+** healthy twin (Pin M3) | exit 4 **and** the objects still reported | objects classified; pack reported |
| K-15 | v99 **+** a deleted reachable tree | exit 14 | **differential**: the non-pack bits equal what the *same repo without the bad pack* produces, and bit 4 is the only added term |
| K-16 | v99 **and** corrupt `.idx`, same pack (Pin J15) | exit 68; **no** version line | exactly one finding, index layer — the precedence row |
| K-17 | mode gating, **exit axis** | `--connectivity-only` and `--no-full` on the v99 and corrupt-idx repos: 0 / 0 / 64 / 64 | `connectivityOnly` and `full: false` reproduce the same four exits |
| K-18 | `--strict` | exit 4 unchanged | `strict: true` unchanged |
| K-19 | **v99 pack holding every reachable object** (Pin M5) | exit 14 | **differential** as K-15 — bit 4 is the only term the bad pack adds; `missing` findings present (requirement 8, §D11.8) |
| K-20 | **v99 pack, `--connectivity-only`, findings axis** (Pin M7 / Pin Q) | the `dangling unknown <oid>` lines are **exactly the pack's N oids**, no duplicates, exit 0 | the `dangling` findings with `objectType === 'unknown'` are the **same oid set**, compared as sets. **Fixture precondition: zero donor/target object overlap** (below) |
| K-21 | **v99 pack, `--no-full`** (Pin M8) | exit 0, **no** `dangling` line at all | zero `dangling` / `unreachable` findings for the pack's oids — the row that separates the two reduced modes |
| K-22 | **unreadable loose object, unreferenced, `--connectivity-only`** (Pin P2) | exit 0, `dangling unknown <oid>` once | one `dangling` finding, `objectType === 'unknown'`; node tier only (`chmod`) |
| K-23 | **same fixture, default mode** (Pin P2, P-a) | exit 1, **no** `dangling` and **no** `unreachable` line even with `--dangling --unreachable` | no `dangling` / `unreachable` finding for that oid — git's side of this row is asserted *with the projection flags on*, because that is what makes it a computation difference rather than a print filter |
| K-24 | **reachable unreadable object, `--connectivity-only`** (Pin P7) | exit 0, stdout empty | no finding for that oid; node tier only |
| K-25 | **hash-path mismatch, `--connectivity-only`** (Pin P6) | exit 0, `dangling blob <oid>` | one `dangling` finding with `objectType === 'blob'` — the negative row for the widening |
| K-26 | **undecodable loose object, dangling, `--connectivity-only`** (Pin P4, R3) | exit **128**, **stdout empty** | `fsck({ connectivityOnly: true })` **rejects**, `.data.code === 'DECOMPRESS_FAILED'` — the headline ADR-590 row |
| K-27 | **same fixture, default mode** (Pin R3 default column) | exit 1 | resolves; exit bit 1 and a `bad-object` finding — the mode boundary, asserted on the *same* bytes as K-26 |
| K-28 | **reachable** undecodable object, `--connectivity-only` (Pin R1) | exit 0, stdout **and stderr** empty | resolves; no finding for that oid, `exitCode` 0 |
| K-29 | **unreachable-but-referenced** undecodable object, `--connectivity-only` (Pin R2) | exit 128, stdout empty | rejects — proves both tools scope the abort to the unreached set, not to the dangling subset |
| K-30 | **empty** loose object, dangling, `--connectivity-only` (Pin R4) | exit 0, `dangling unknown <oid>` | resolves; `dangling` with `objectType === 'unknown'` |
| K-31 | **valid zlib / unrecoverable header** (`widget 5\0`), `--connectivity-only` (Pin R10a) | exit 128 | rejects, `.data.code === 'INVALID_OBJECT_HEADER'` |
| K-32 | **valid header / size disagreement** (`blob 99\0`), `--connectivity-only` (Pin R10c) | exit 0, `dangling blob <oid>` | resolves; `dangling` with `objectType === 'blob'` — the row that pins the split as header-recovery, not error code |
| K-33 | **healthy dangling object + undecodable dangling object**, `--connectivity-only` (Pin R6) | exit 128 and the healthy `dangling` line is **absent** from stdout | rejects — neither tool emits a partial report |
| K-34 | **packed-only object with a corrupt entry body**, `--connectivity-only` (Pin R7) | exit 0, `dangling blob <oid>` | resolves, `exitCode` 0 **and `objectType === 'blob'`** — after ADR-591 this row is a full match on id, verdict, type and exit; the `'unknown'` caveat the previous revision carried here is gone |
| K-35 | **garbled loose copy + healthy packed copy**, `--connectivity-only` (Pin R9) | exit 0, `dangling blob <oid>` | resolves, `exitCode` 0 **and `objectType === 'blob'`** — full match, same as K-34 |
| K-36 | **packed *delta* entry with a corrupt body**, `--connectivity-only` (Pin R13) — run for `OFS_DELTA` **and** `REF_DELTA` | exit 0, `dangling blob <oid>` | resolves, `objectType === 'blob'`, `exitCode` 0 — the base-link walk against real git-written deltas, which no synthetic single-entry fixture exercises. Fixture per Pin R13's recipe: `git pack-objects --no-reuse-delta [--delta-base-offset]` over two near-identical blob oids, dropped into a fresh repo so both entries are dangling |
| K-37 | **valid header over an unparseable body**, `--connectivity-only` (Pin R10d) | exit 0, `dangling tree <oid>` | resolves, `objectType === 'tree'` — the loose arm of the retention, and the row where git's `too-short tree object` stderr is *not* compared (ADR-249: verdict line only) |

**Fixture precondition for K-20 (Pin Q).** The donor repo's file bodies must be **distinct** from the
target repo's. Both are built by the same helper, so the default is *identical* content, which makes
6 of 9 oids coincide — and the commit oids coincide too whenever the two `git commit` calls land in
the same second, taking the expected count from 9 to 3 to 0 without any assertion changing shape.
The helper takes the body prefix as a parameter for exactly this reason, and K-20 asserts the count
against `git cat-file --batch-all-objects` on the donor rather than against a literal 9.

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

The scenario runs in **both** `connectivityOnly: true` and default mode, because ADR-588 makes the
two modes disagree on the *same* fixture by design (§D12): default yields pack findings and no object
findings; connectivity-only yields `dangling`/`unreachable` with `objectType: 'unknown'` and no pack
finding. A single-mode scenario would prove cross-adapter agreement on exactly the half of the
behaviour the widening does not touch. The `'unknown'` classification is the more valuable leg of the
two, because it is reached only when a read *fails* — precisely where the three adapters' error paths
differ.

The fixture also carries **one undecodable dangling loose object** (ADR-590), asserting that all
three adapters *reject* in connectivity-only mode and resolve with a `bad-object` in default mode.
This is the leg with the largest cross-adapter exposure in the whole change: the verdict is reached
through `ctx.compressor.inflate` and every adapter has its own decoder — node's `zlib`, the memory
adapter's `DecompressionStream`, the browser tier's zero-dependency `inflateZlibMember` — and all
three must map a dead stream to `DECOMPRESS_FAILED` for the discriminator to see the same class.
A decoder that returned empty bytes instead of throwing would silently move the object from the
reject class into `dangling unknown` on that adapter alone.

ADR-591's retention rides the same fixture with one added assertion rather than a fourth leg: the
v99 pack's ids must come back `'unknown'` on all three adapters (the pack is refused, so `lookup`
yields nothing — §D13.8's first boundary), while the scenario's healthy pack contributes the arm-2
read, which is the one place the retention touches `pack.readSlice` and therefore the browser tier's
handle-less fallback (ADR-510/28.1 §D7). Asserting the type *value* per adapter is what makes an
adapter that silently returns short bytes from `readSlice` fail here instead of downgrading one
finding to `'unknown'` in production.

### Property-based testing — **lens 2 applies**; extend the existing sibling

`test/unit/application/commands/fsck.properties.test.ts` already exists and already works lens 2
(compositional invariants over the reachability closure: I1–I5, including *"adding exactly one
unreachable blob adds exactly one `dangling` finding"* and *"a missing referent sets exit bit 2"*).
This change's surface fits the same lens and the file gains three invariants — **not** a new file.
I6 and I7 are **default-mode** properties; I8 is the one that spans the mode gate.

- **I6 — additivity (default mode).** For an arbitrary healthy repo, dropping in **one** unusable pack (fault shape
  drawn by `fc.constantFrom` over the enumerated set: v99, bad signature, short pack, count
  disagreement, unreadable `.pack`, garbage `.idx`, truncated `.idx`) adds **exactly one** pack
  finding, sets bit 4, and leaves the non-pack findings **set-equal** to the same repo's baseline
  run. This is the invariant that catches "the pack pass perturbed the object universe" across
  arbitrary graphs, which no fixed fixture can — and requirement 7's most likely failure mode is
  precisely a narrowing that removes one object too many.
- **I7 — cardinality and bit idempotence (default mode).** For an arbitrary healthy repo and arbitrary `N` in
  `[1, 4]`, `N` unusable packs add **exactly `N`** pack findings while bit 4 is set exactly once
  (`|` is idempotent). No finite example table proves this for arbitrary `N`; the two-pack example
  row only proves it for `N = 2`.
- **I8 — mode complementarity (ADR-588, §D12).** For an arbitrary healthy repo plus one unusable
  pack, let `S` be the id set the pack's `.idx` names that the repo does not otherwise hold. Then the
  **default** run contains ≥ 1 pack finding and **zero** findings carrying an id in `S`, while the
  **`connectivityOnly`** run contains **zero** pack findings and exactly one `dangling`/`'unknown'`
  *and* one `unreachable`/`'unknown'` finding per id in `S`. No option set produces both halves.
  This is the property that catches §D11.11's trap — a reviewer factoring the two disjoint gates into
  one shared predicate — across arbitrary graphs, where the fixed unit rows only catch it for their
  own fixture. It also fails loudly if the widening leaks into default mode, which is requirement
  17's first boundary and the failure Pin P2's default column exists to forbid.

Not a tautology: the oracle is the *baseline run of the same repo*, not a re-implementation of the
classifier. `numRuns: 50` — each run constructs a repo and crafts a pack fixture, so this is the
expensive tier, and all three invariants are structural rather than statistical. I8 runs `fsck`
twice per case; it stays in the same tier because the second run reuses the fixture.

**No property can trip ADR-590's reject or ADR-591's retention, and that is a precondition rather
than a coincidence.** All three arbitraries damage a *pack* and leave every loose object intact, so a
generated repo's failing reads are `OBJECT_NOT_FOUND` — excluded by §D13.1's step 0 **and** by
§D13.8's `isDecodeFault`. That is what makes I8's literal `'unknown'` expectation stable across
arbitrary graphs rather than a hostage to which store could have typed the object. Any later
arbitrary that learns to damage a loose object, or to damage a *readable* pack's entry bodies rather
than its header, must state which side of the header-recovery split it generates **and** whether the
id can still be typed — otherwise I8's `connectivityOnly` leg starts either rejecting on some draws or
returning a real type where the property demands `'unknown'`, and shrinks to a counterexample that
looks like a classification bug and is not.

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
- The bit-64 term (ADR-586) is a second `ArithmeticOperator` needing its own isolating row —
  K-17's connectivity-only leg, where bit 4 is absent and 64 must still appear.
- **§D12's mode gate** is a `ConditionalExpression` producing `'classify' | 'skip'`, plus two
  `StringLiteral` mutants. Each needs a row where the *other* value is wrong: the connectivity-only
  loose row and the default-mode loose row on the same fixture (the two P2 columns) are that pair.
  A `BooleanLiteral` gate would need the same two rows, so the string union costs nothing in
  mutation terms and reads better at the call site (§D12.2).
- **`reachability.ts:163` loses its `// Stryker disable`** (§D12.4). The directive's equivalence
  premise is the line §D12.1 deletes, so it must be removed rather than carried forward — and the
  now-live `BlockStatement` mutant is killed by the reachable-unreadable rows, of which there are
  now **two**: the `PERMISSION_DENIED` one (Pin P2/O15) and, after §D13, the reachable-undecodable
  one (Pin R1), which fails a different way — with `reached.add` gone the object becomes
  unreachable, the guard finds its recorded fault and the run rejects (§D13.6). Both rows assert an
  *absence*, which reads like a weak test; dropping either as redundant returns a mutant to
  surviving, because each is the sole killer of a different mutant in §D13.1's step list.
- **`object-cache.ts:32` loses its `// Stryker disable` too** (§D13.6) — its equivalence premise is
  that the `catch` block has exactly one statement, and §D13 gives it a second. The now-live
  `BlockStatement` mutant is killed by any rejecting row (K-26's unit twin), so this one costs no
  extra test — only the discipline of deleting the comment rather than re-justifying it.
- **§D13's step 0 pre-filter** is a two-operand `LogicalOperator` over error codes: the
  `DECOMPRESS_FAILED` rows and the `INVALID_OBJECT_HEADER` rows each need an arrangement that
  triggers **that operand alone** (isolated-guard rule), and the `PERMISSION_DENIED` row plus the
  `INVALID_TREE_ENTRY` row (Pin R10d) kill "force the predicate true".
- **§D13's `unreadable === 'classify'` gate** is a `ConditionalExpression` plus a `StringLiteral`;
  the default-mode and connectivity-only rows over the *same* garbage fixture (K-26/K-27) are the
  pair that kills both, and the `full: false` row is what stops a mutant that keys on `full`.
- **`bytes.length === 0`** is an `EqualityOperator` and a `ConditionalExpression`: the empty-file row
  (Pin R4) and any non-empty abort row are both required, and neither alone kills the `<`/`>`
  variants.
- **`looseCompressedBytes(...) === undefined`** (step 1) is killed only by the packed-corrupt-entry
  row (Pin R7) — the one arrangement where the fault is a decode failure on an object that is not
  loose.
- **The §D13.2 registry lookup** is killed only by the loose-garbled-plus-healthy-packed-copy row
  (Pin R9). It is the most droppable-looking row in the matrix (it asserts that nothing happens) and
  the only thing standing between a reviewer's "simplify this" and an abort git does not perform.
- **The guard's argument** — `unreachable` versus `dangling` — is not a mutator target but is an
  equally silent failure; the unreachable-but-referenced row (Pin R2) is its only detector, so it
  belongs in the matrix even though it looks like a duplicate of the dangling row.
- **`object-cache.ts:32`'s `// Stryker disable` stays**, and stays *valid* only while the new code
  reads the cache through `resolveObjectType`'s `obj != null` (§D12.4). A reviewer who "tightens"
  that to `!== null` or `has()` falsifies a proof in a file the diff does not otherwise touch.
- **The widened `objectType`** is an `ObjectLiteral`/`StringLiteral` surface: a mutant replacing
  `resolveObjectType(...)` with the literal `'unknown'` is killed by the hash-path-mismatch row
  (which must stay `'blob'`), and one replacing it with `obj.type` is killed by the unreadable rows.
  Both directions need a row; only one of them is the "interesting" case, which is why the negative
  row is listed in the unit matrix rather than left to the interop suite.
- **ADR-591's retention adds three mutation targets and no new class of row** (§D13.8):
  - `resolveObjectType`'s new fallback is one `ConditionalExpression` plus the `??` operand. Forcing
    it to `'unknown'` is killed by any retention row (R7, R9, R10c, R10d, R13); deleting the
    `?? 'unknown'` and returning `undefined` is killed by the rows that must **stay** `'unknown'`
    (P2, R4, M7) — the same pairing §D13.8 calls the boundary, so neither side may be pruned as
    "asserting nothing happens".
  - `isDecodeFault` is a **`Set` membership test over a named constant array**, not a `||` chain, so
    the isolated-guard rule costs one row rather than one per code: the `ArrayDeclaration -> []`
    mutant is killed by R10d (the only pinned member outside §D13.1's two abort codes), and forcing
    the predicate true is killed by the `chmod 000` row (P2), which must not re-read. This is the
    deliberate shape reason §D13.8 gives for a `Set` over a disjunction.
  - Arm 2's delta-link walk is a loop with a `ConditionalExpression` on the entry's stored type. Only
    the two Pin R13 rows reach it; the non-delta R7 row exits before the first iteration, so R7 alone
    leaves a `while`-body `BlockStatement` mutant surviving. That is why R13 is two `it`s in the unit
    matrix and one interop row, not a variant of R7's arrangement.

### Gates

`npm run validate`, plus:

- **`reports/api.json` will change**, from **three** independent causes this time: the three new
  `FsckFinding` variants (ADR-583, ADR-586), ADR-585's `EnumerateObjectsOptions` field, and
  **ADR-588's widened `objectType` on the `dangling` and `unreachable` variants** (§D12.6). One
  regeneration covers all three, but a reviewer diffing the report should expect edits in the two
  *existing* variants and not only additions. The regenerated report must be committed or the
  prepush `check:doc-typedoc` gate fails; a large typedoc-id diff is normal. **ADR-590 adds nothing
  to this list** — `UnreadableMode`, `ObjectCacheResult` and the guard are command-internal and the
  reject reuses two existing error codes (§D13.4), so the reject is a documented behaviour with no
  type-surface delta at all. **ADR-591 adds nothing either**, for the same reason: the retention map
  hangs off `ObjectCacheResult` and the widened member it narrows was already declared by ADR-588
  (§D13.8).
- **`docs/use/commands/fsck.md`** — six places, not three, and the sixth is new prose rather than a
  table edit: **`fsck` can now reject** in `connectivityOnly` mode (ADR-590), which is the first
  input-independent failure the command has, so the page needs a short "when `fsck` throws" section
  naming the condition, the two error codes, and the fact that the other two modes report the same
  damage as a `bad-object` with exit bit 1. A caller that treats `fsck` as total will otherwise meet
  this in production. The five table edits are: the `FsckFinding` union block (lines
  19–22, where `dangling` and `unreachable` both gain `| 'unknown'`), the **composite-bitmask table**
  (which today enumerates only `0 / 1 / 2 / 3 / 8 / 10` and must gain `4`, `6`, `14`, `64` and `68`),
  the finding-reference table (the `dangling` and `unreachable` rows gain the `'unknown'` case and
  the mode in which it occurs), the new pack-finding rows, and the rendering example at line 180 —
  which already prints `` `dangling ${f.objectType} ${f.id}` `` and therefore reproduces git's
  `dangling unknown` line with no change, worth stating so nobody "fixes" it. The finding-reference
  rows must also carry ADR-591's rule, because it is the caller-facing half of the widening: for a
  `dangling` / `unreachable` finding, `objectType` is the type the object's **stored header**
  declares, and `'unknown'` means no header could be obtained at all (unreadable file, empty file, or
  an id only an unusable pack supplies) — not "tsgit failed to read it".
- **`docs/use/primitives/internals.md`** — for ADR-585's knob.
- **`check:doc-coverage`** for any newly public symbol — **none**: ADR-589 keeps the pass
  command-internal, and ADR-588's widening touches existing documented fields only.
- `tooling/audit-write-surfaces.ts` unchanged (requirement 15).
- Per the cached-validate note: re-run `cspell` fresh and regenerate `api.json` before pushing — a
  green wireit-cached `validate` can still precede a red prepush.

## Out of scope

- **Pack-body integrity verification** — git's bit 4 also covers the pack trailer checksum,
  per-object index CRC and inflate failures (Pin N). Per ADR-587 this change reports *accessibility*
  only. The residual is a distinct capability (a `git verify-pack` analogue, which 28.1 §Out of
  scope already recorded tsgit as lacking), not a deferred slice of this feature — the boundary is
  drawn by ADR-587 rather than assumed.
- **Reverse-index (`.rev`) and bitmap reading** — 28.3. Per ADR-586 this change emits git's
  rev-index *exit bit* without reading a `.rev` file, which is exit-faithful (Pin K-a) and leaves
  28.3 with nothing to correct.
- **Multi-pack-index health** — 28.2. git has its own `ERROR_MULTI_PACK_INDEX` bit (32); tsgit reads
  no midx, so no midx can be unusable.
- **Alternates** — git reports an inaccessible pack in an alternate object directory with bit 4 and
  an absolute path (§D10 T-7). tsgit's registry scans the common gitdir's pack directory only; this
  change neither widens nor narrows that boundary.
- **Symlinked `.pack`** — tsgit's regular-files-only scan drops it as an orphan where git resolves
  and registers it (§D10 T-8). A deliberate extension of the no-follow policy, unchanged here.
- ~~**Aborting `fsck` on a loose object git dies on**~~ — **in scope now.** DC-10 was ruled option
  (a) (ADR-590): `fsck` rejects on that class in `connectivityOnly`, the mechanism is §D13 and the
  boundary is §Pin R. The entry is kept struck through rather than deleted because the previous
  revision of this document listed it here as open, and a reader comparing revisions must be able to
  see it moved rather than vanished.
- ~~**Type recovery for an object tsgit cannot parse**~~ (§D11.16) — **in scope now.** The user ruled
  it closed (ADR-591): an unreachable object is typed from its recovered header — loose, pack-entry,
  or the pack-entry of a delta's base — so Pin R10c, R10d, R7, R13 and R9 all carry a real type and
  `'unknown'` is reserved for the objects git reserves it for. The mechanism is §D13.8 and the
  delta leg is §Pin R13. Kept struck through rather than deleted for the same reason the entry below
  it is: a reader comparing revisions must see it move rather than vanish. What remains out of scope
  is the *unpinned* corner §D13.8 names — an unopenable or empty loose file whose oid a pack also
  claims, which stays `'unknown'` because the probe never reaches the pack arm for it.
- **tsgit's loose-before-pack read order** — a corrupt loose copy shadows a readable packed copy of
  the same oid (Pin R9), where git serves the packed one. A read-path property that predates this
  change and affects every command, not only `fsck`; §D13.2 keeps it from *escalating* into an abort
  here and §D13.8 keeps it from *showing* in the type field, but neither fixes the read order itself:
  every other command still fails on the shadowed copy.
- **Two pre-existing loose-object divergences in the *full* modes** (§D11.13), both surfaced by
  these pins and neither touched by this change: tsgit propagates `PERMISSION_DENIED` out of `fsck`
  where git records exit bit 1 (Pin O11, O15), and tsgit reports a hash-mismatched object as
  `dangling`/`unreachable` where git drops it from the graph (Pin O14 default column). Both sit on
  the content pass's handling of failed reads, a different axis from ADR-588's classification
  question, and both are unreachable from §D12's `connectivityOnly`-gated path.
- **The roots-axis reporting shape** — git splits root failures between stdout `missing blob` and
  stderr `invalid sha1 pointer` (Pin M5); tsgit models both as `missing`. Pre-existing, unchanged,
  and the reason the composition interop rows assert differentially (§D11.8).
- **Stderr transcript parity** — per ADR-249 git's `error:` lines are presentation; tsgit emits none
  and is not expected to. The interop tests reconstruct them from structured fields.
- **Changing `registry.all()` semantics** — ADR-575 pinned it against `count-objects`
  (`packs: 1` / `in-pack: 9` for a refused pack) and Pin M1 re-confirms it against `cat-file
  --batch-all-objects`. Only `fsck`'s universe narrows.
