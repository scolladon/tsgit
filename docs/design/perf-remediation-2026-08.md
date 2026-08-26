# Design — perf remediation 2026-08

> Brief: remediate every finding (F1–F16) of the structured performance review of `main@5aa318bd`
> recorded in `.claude/perf-review-2026-08-26.md`, grounded in the regenerated profile sitting
> uncommitted in this worktree (`docs/perf/baseline.{json,md}`). Cross-cutting user requirement:
> every bounded-concurrency pool derives its bound from the actual limiting resource — CPU-bound
> stages from core count, I/O-bound stages from threadpool width / storage characteristics — never
> from a single magic constant, with the platform knowledge living in adapters behind a port.
> Status: draft → self-reviewed ×3 → **revised against ADRs 718–730**
>
> **All sixteen decision candidates are settled** and authored as ADRs **718–730**. Every gate
> resolved to "do it": P5 ships F3 **and** F4, P7's progress shape is completion-ordered, P9 is in
> scope at **full breadth** (commit-graph write *and* gc-lite). The Decision-candidates section is
> retained below as the historical record, each row carrying its settled outcome. One **new**
> candidate — **DC-17**, how gc-lite treats unreachable objects — emerged from the P9 expansion and
> is **unsettled**; it is the only open question in this document.

---

## Context

### Where this comes from

The source is a structured perf review of `main@acfe17e3` (the tree has since taken the
`chore(main): release 3.6.0` commit, `5aa318bd`; no source changed between them). It combines
fresh V8 CPU profiles through `tooling/profile.ts`, five parallel code investigations, and one
instrumented fs-call trace. This worktree is cut from that tree, so every anchor below was
re-verified in place with Serena. **Where the review's anchor is stale or its mechanism is wrong,
this document says so and carries the corrected anchor** — the corrections are collected in
[Review corrections](#review-corrections) and repeated inline.

This is a **remediation** change, not a feature. It touches roughly 40 source files, 4 tooling
files and 2 committed artifacts. Two items add public surface — a `maintenance` Tier-1 command
(F11, ADR-724) and the concurrency-policy seam (the cross-cutting requirement, ADR-719) — and
both are ratified. The run has no backlog id (the input is a review file), so no
`docs/BACKLOG.md` tick is owed for the remediation itself; **F11 un-parks the `gc / repack /
prune` entry at `docs/BACKLOG.md:429`, and that tick is owed by the documentation phase** (ADR-724
records the un-parking; the checkbox flip and the reference links are the docs phase's job, under
guard, not the implementer's).

### The predecessor

`docs/design/perf-review-remediation.md` (+ `docs/plan/perf-review-remediation.md`) is the
*2026-08-16* review's remediation, shipped as PR #276. **This document must not be confused with
it and must not overwrite it** — hence the dated slug. Everything it settled (ADR-640 … ADR-652:
per-command export surface, `ObjectId.from` hex validation, `status` allocation probe, the two
cache bounds, `tsc` incremental, label-gated CI jobs) is upstream context here, not scope.

### Finding → work-part map

The review suggested 8 delivery slices. This design refines them to **ten sequential parts**,
because the harness work has to land first for later oracles to mean anything, and because the
concurrency-policy seam is a prerequisite for two later parts rather than a tail item.

| Part | Findings | Why it sits here |
|---|---|---|
| **P0** | F16 (+ commit the regenerated baseline) | Every later oracle reads this harness. Today it cannot resolve the effects we are about to make. |
| **P1** | concurrency-policy seam (user requirement); re-points F15's pool constants | P6/P7 consume it; landing it first stops them each inventing a bound. |
| **P2** | F5, F12, F2.3, F15 (micro batch, less the zlib threshold → P7) | Behaviour-preserving, no ADR, no new surface. |
| **P3** | F1, F10 | One subsystem (pack), one bench file, one fixture fix. |
| **P4** | F2 (blame) | One command, pinned by blame interop goldens. |
| **P5** | F3, F4 | Both ship in full (ADR-718 flips all five `verifyHash` defaults; ADR-727 ratifies the parsed-commit memo). They share a part because they touch the same read path. F15's sync-cache-hit fast path is **enabled** by ADR-718 and rides here as a P5 rider, not in P2 (P2 lands first). |
| **P6** | F7, F13 | index/status/add I/O shaping; consumes P1's policy. FlatTree key settled by ADR-726. |
| **P7** | F6, F8 | checkout/clone; consumes P1's policy. Progress is completion-ordered (ADR-725); quarantine is git's layout + tidy unlink (ADR-728). |
| **P8** | F9, F14 | Structural; ADR-721 (read-side containment) and ADR-722 (session token) each already authored. |
| **P9** | F11 | **In scope at full breadth** (ADR-724): commit-graph write **and** gc-lite. New Tier-1 command; the largest single lift. |

### What constrains it

| Constraint | Source | Effect on this design |
|---|---|---|
| Git-faithfulness prime directive | `CLAUDE.md`, ADR-226 | Object SHAs, refs, state files and **refusal conditions** stay byte-identical unless an ADR diverges. F3 and F9 change refusal behaviour and have their divergences recorded (ADR-718, ADR-721). F11 writes new on-disk artefacts and carries its own pinned matrix (Pins C, E–K). Every other part is in-memory strategy only. The pinned matrix below is the authority — no git behaviour in this document is asserted from memory. |
| Structured output, not cosmetics | ADR-249 | Engaged only by F11: a `maintenance` command returns counts/oids/booleans, never a rendered line. `MaintenanceResult` carries no message, no formatted size, no rendered summary. |
| Hexagonal dependency rule | `.dependency-cruiser.cjs`, ADR-001, `docs/design/ports-and-adapters.md` | `ports/ ✗→ adapters/`, `ports/ ✗→ application/`, `domain/ ✗→ *`, `primitives/ ✗→ adapters/`. `tsPreCompilationDeps: true`, so **type-only imports count as edges**. There is no rule restricting `from: ^src/adapters/` — adapters are gated by packaging, not dep-cruiser. |
| `node:`-free default entry | `tooling/verify-tarball.sh:246-276` | The guard walks the packed tarball's transitive static import graph from `dist/esm/index.default.js` and fails on the first `node:` specifier. **`node:os` may only be reached from `src/index.node.ts`.** A sibling grep guards the CDN bundle. |
| workerd/browser runtime parity is blocking | ADR-143, ADR-144 | `index.default.js` runs on workerd, which has neither `node:os` nor `navigator.hardwareConcurrency`. Any concurrency probe must feature-detect with a hard floor. |
| Coverage 100 % on `src/domain/**`, `src/ports/**`, `src/adapters/{node,memory}/**`, `src/operators/**` | `vitest.config.ts:80-98` | A new port file and its node/memory adapters must be 100 % covered. `src/adapters/browser/**` and `src/application/**` are outside the coverage gate but inside Stryker. |
| Mutation budgets | `mutation-budgets.json` | `domain` break 99 / low 100; `application` break 95 / low 98; `adapters` break 85 / low 90; `infra` (`ports`, `operators`, `transport`, `progress.ts`) break 90 / low 95. A new port lands in `infra`. |
| Equivalent-mutant proofs are structure-specific | prior-run learning; ADR-552 | Every `// Stryker disable next-line … equivalent` on a line this change rewrites must be re-proved against the new structure or removed. The known blast radius is listed per part. |
| No suppression directives | `CLAUDE.md` | No new `v8 ignore` / `stryker-disable` / `biome-ignore` / `@ts-ignore`. |
| Size budgets | `.size-limit.json` | Core 50 kB, Node shim 60 kB, memory shim 60 kB, each adapter 10 kB, browser no-build bundle 175 kB, full library 335 kB (all gzip). `dist/esm/index.browser.js` has **no** dedicated row. `dist/` is not built in this worktree, so headroom must be measured, not assumed. |
| `reports/api.json` is a **prepush** gate | `.claude/workflow/surface-gates.md` | Any new public type (a `ConcurrencyPolicy` port re-exported from `src/ports/index.ts`; `maintenance` on the facade) changes `reports/api.json`; regenerate with `npm run docs:json` and commit **in the same part**. `validate` will not catch it. |
| New Tier-1 command trips a **checklist, not a gate** | `.claude/workflow/surface-gates.md` | Command barrel, facade interface + impl, `repository.test.ts` key list, `docs/use/commands/<kebab>.md` + index row, a parity scenario **and** its registration, the "46 Tier-1 commands" line in `README.md`, regenerated `api.json`, `.size-limit.json`, `test-pyramid-budgets.json`. Eleven rows, enumerated with exact anchors in P9; `validate` catches only some of them and `api.json` is a **prepush** gate it does not catch at all. |
| Test-pyramid allowlist names factories by identifier | `test-pyramid-budgets.json` `sutBindsResult.allowlist` | It names `createConcurrencyLimiter`, `createWorkingTreeStatMap`, `createLeadingPathScanner`, `createPromiseMemo`, … Consolidating or renaming any of them requires updating the allowlist in the same part or `check:test-pyramid` reddens. |
| Published perf numbers come from the CI nightly bench artifact | ADR-483, ADR-486 | Every number in this document is labelled **local, dev-machine** and is used for sizing and revert rules only. Nothing here is a publishable claim. |
| Absolute wall-clock main-vs-branch, never self-shares | `CLAUDE.md`, ADR-501 | The verification method is fixed; §P0 builds the driver, because **no local A/B driver exists today**. |

### Measurement environment (every local number below)

```text
host        darwin arm64 / Apple M3 Pro / 11 logical cores (os.availableParallelism() === 11)
node        v22.22.3     (UV_THREADPOOL_SIZE unset ⇒ libuv default 4)
git         2.55.0
os          macOS 26.5.2
tree        tsgit-perf-remediation-2026-08 @ 5aa318bd, branch perf/review-remediation-2026-08
```

Every downstream agent that reports a number must re-state its own `node --version`,
`git --version` and core count beside it.

---

## Pinned git behaviour (faithfulness matrix)

Measured on **git 2.55.0**, each in a `mktemp -d` throwaway with an isolated `HOME`,
`GIT_CONFIG_NOSYSTEM=1` and signing off. Never in this worktree — a worktree shares `.git/config`
with the main checkout through the common dir.

### Pin A — git does **not** verify object hashes on ordinary reads

Method: write a *valid zlib stream encoding different content* over an existing object, so the
zlib checksum stays intact and only the SHA disagrees. Loose case: overwrite the loose file.
Packed case: two 1000-byte random blobs deflate to identical lengths (1013 B), so their byte
ranges in the pack can be swapped in place.

| Surface | Store | Result | Exit |
|---|---|---|---|
| `git cat-file -p <oid>` | loose | printed the **other** content | 0 |
| `git cat-file -t <oid>` | loose | `blob` | 0 |
| `git cat-file --batch-check` | loose | `<oid> blob 19` (the *stale* size) | 0 |
| `git cat-file -p <oidA>` / `<oidB>` | packed, ranges swapped | returned each other's content (`sha256` of A's read == B's file, and vice-versa) | 0 |
| `git checkout -- .` | packed, ranges swapped | materialised the **swapped** bytes into the working tree | 0 |
| `git log --format='%H %s'` | loose commit replaced by a different valid commit | printed the tampered subject **at the original oid** | 0 |
| `git rev-list --all`, `git show` | same | served the tampered commit | 0 |
| `git bundle verify <file>` | loose prerequisite corrupted | `error: hash mismatch <oid>` + `Repository lacks these prerequisite commits` | ≠0 |
| `git fsck` | loose | `error: <actual>: hash-path mismatch, found at: .git/objects/<expected-path>` | 3 |
| `git fsck` | packed | `pack checksum mismatch` + `index CRC mismatch` + `is corrupt` | ≠0 |
| `git verify-pack -s` | packed | `fatal: SHA1 COLLISION FOUND WITH <oid>` … `bad` | ≠0 |

Also pinned from the installed binary's own documentation: `fetch.fsckObjects` /
`receive.fsckObjects` "**Defaults to false**. If not set, the value of `transfer.fsckObjects` is
used instead." — verification at transfer time is opt-in too.

**Reading.** Canonical git's verification lives in `fsck` / `verify-pack` / the object-parsing
path used by `bundle verify` — **not** in the read path that `cat-file`, `checkout`, `log`,
`rev-list` and `show` take. tsgit's `verifyHash ?? true` on `readObject`/`readRawObject` is
therefore **stricter than git**, on the same axis ADR-625 already resolved for path containment
(a tsgit check stricter than git is a divergence to close, not a property to defend). That is the
evidence base for DC-1, ratified as **ADR-718**: the default flips to off.

### Pin B — the incoming pack is a temp file renamed after verification

```text
$ git clone --no-local <repo> c1      # polled every 250 ms
[t2..t4] .git/objects/pack/tmp_pack_cEkQSJ
[t5+]    .git/objects/pack/pack-81a97caa….{idx,pack,rev}
```

Git streams the received pack into `objects/pack/tmp_pack_<6 mkstemp chars>` and renames it to
`pack-<sha>.pack` (plus `.idx` and `.rev`) only after `index-pack` has verified it. On
`SIGKILL` mid-clone the partial `tmp_pack_XXXXXX` **survives** (mode `444`, 8.4 MB observed) —
git does not clean up on a hard kill. F8's quarantine design is therefore faithfulness-positive
and inherits the same "a hard kill may leave a temp file" posture.

### Pin C — commit-graph writing is byte-deterministic, and `gc` produces exactly it

```text
$ git commit-graph write --reachable        # run twice on the same commit set
sha256(commit-graph) == sha256(commit-graph)          → BYTE-IDENTICAL
$ git gc                                     # default config, 30 commits
objects/info/commit-graph                    ← identical bytes to the explicit write
objects/info/packs
objects/pack/pack-<sha>.{idx,pack,rev}       ← no midx, no bitmap at this size
chunks: OIDF OIDL CDAT GDA2                  ← no Bloom chunks without --changed-paths
$ git commit-graph write --reachable --split
objects/info/commit-graphs/{commit-graph-chain, graph-<sha>.graph ×2}
```

`--changed-paths` produces a different (larger) file carrying the Bloom chunks.
tsgit's reader already parses `OIDF`, `OIDL`, `CDAT`, `GDA2` and `EDGE`
(`src/domain/commit/commit-graph.ts:13-28`) and refuses the `GDO2` overflow chunk — exactly the
chunk set `git commit-graph write --reachable` emits at ordinary date ranges. A writer is
therefore pinnable byte-for-byte against git, which is what makes F11 tractable.

### Pin D — the auto-maintenance thresholds

From `git gc --help` / `git maintenance --help` on the installed binary:

- `gc.auto` — "When there are **approximately** more than this many loose objects … The default
  value is **6700**." Setting it to `0` disables every `--auto` heuristic, `gc.autoPackLimit`
  included.
- `gc.autoPackLimit` — "more than this many packs that are not marked with a `*.keep` file …
  The default value is **50**."
- `git maintenance run --task=` accepts exactly: `commit-graph`, `prefetch`, `gc`,
  `loose-objects` (batch size default 50 000, `maintenance.loose-objects.batchSize`),
  `incremental-repack`, `pack-refs`, `reflog-expire`, `worktree-prune`, and the reuse-recorded-resolution collector.
  `git maintenance run --task=bogus` → `error: 'bogus' is not a valid task`.
- The docs warn that enabling **both** `loose-objects` and `gc` is inadvisable (gc writes
  unreachable objects back as loose).

### Pin E — what `git gc` does to loose objects, by reachability

Fresh `mktemp -d` repo, 3 commits, `gc.cruftPacks` at its default.

| Setup | `git gc` (default) | Result |
|---|---|---|
| only reachable loose objects | one pack | `objects/pack/pack-<sha>.{idx,pack,rev}`, **no mtime sidecar**, zero loose left |
| + one **unreachable, recent** loose blob | two packs | a normal pack **and** a second pack carrying an mtime sidecar — the **cruft pack**. The blob is **not** loose and **not** deleted: `cat-file -e` → 0 |
| + one **unreachable** loose blob with mtime forced to 2020 | — | **deleted**. `cat-file -e` → non-zero |
| unreachable recent loose blob, `git gc --prune=now` | — | **deleted** |
| unreachable recent loose blob, `gc.cruftPacks=false` | one pack | the blob **stays loose** and survives; `count-objects -v` → `count: 1`, `in-pack: 9` |

`gc.cruftPacks` — "Store unreachable objects in a cruft pack … **The default is true**."
`gc.pruneExpire` — "`git gc` … will call `prune --expire 2.weeks.ago` (and `repack --cruft
--cruft-expiration 2.weeks.ago` if using cruft packs)". `now` prunes immediately; `never`
suppresses pruning.

**Reading.** git 2.55's *default* gc neither leaves unreachable objects loose nor deletes them
outright: it moves them into a **cruft pack** — a `.pack` with a sibling index recording each
object's `mtime` (git spells that extension as the plural of `mtime`; this document calls it the
**mtime sidecar**, because naming the literal here would owe a `cspell.json` dictionary entry this
commit is not scoped to make — the entry is owed by whichever change first writes the literal
path). git deletes those objects on the next gc once they age past two weeks. **tsgit neither
reads nor writes the mtime sidecar.** The reachable direction is unambiguous and is what P9 implements;
the unreachable direction is DC-17.

### Pin F — `.rev` and the pack-sibling lifecycle

```text
$ git repack -a -d      # after an earlier gc created pack-<A>.{idx,pack,rev}
old .pack gone? YES     old .idx gone? YES     old .rev gone? YES
```

A pack's `.rev` is removed with the pack. Bitmaps are **not** written by default
(`repack.writeBitmaps=true` adds `pack-<sha>.bitmap`; the default run emits only
`.idx`/`.pack`/`.rev`), so a gc-lite that writes no bitmap matches git's default exactly.

### Pin G — the multi-pack-index lives in `objects/pack/`, and `gc` deletes it

```text
$ git multi-pack-index write
.git/objects/pack/multi-pack-index          ← NOT objects/info/
.git/objects/info/                          ← commit-graph, packs  (no midx here)
$ git gc                                    # consolidates 2 packs → 1
.git/objects/pack/  →  pack-<sha>.{idx,pack,rev}     midx: DELETED
```

But a midx that merely *stops covering every pack* is left alone and stays valid:

```text
$ git multi-pack-index write   # 1 pack, midx covers it
$ git commit … && git repack -d                       # now 2 packs
midx still present: YES     git fsck: (silent) exit 0     cat-file -t HEAD: commit
```

**Reading.** git removes the midx when it removes the packs the midx names; it does **not**
remove it merely because a new pack appeared. tsgit has no midx writer, so "expire or rewrite" is
only ever "delete" — and under P9's shape (Pin E's reachable direction, no pack removal) the
question does not arise: leaving a partial-coverage midx is exactly what `git repack -d` does.
tsgit's `bindMidx` already tolerates a `PNAM` entry it cannot resolve (it logs and falls through
to the ordinary `.idx` loop) — `internal/midx-binding.ts:89-103,123-134`.

### Pin H — the reachability roots `gc` uses

```text
$ git add s                       # blob staged, never committed
$ git checkout -b other && commit && git checkout - && git branch -D other
$ git -c gc.cruftPacks=false gc --prune=now
index-only blob survives?       YES
deleted-branch commit survives? YES   (and is IN the new pack)
```

Roots are refs **plus HEAD, the index, and the reflogs** — a commit reachable only from a deleted
branch's reflog is treated as reachable and packed. tsgit's fsck already assembles exactly this
root set (`commands/internal/fsck/roots.ts` — `addRefRoots :80`, `addReflogRoots :103`,
`addIndexRoots :220`).

### Pin I — `gc.auto` governs `--auto` only

```text
$ git -c gc.auto=0 gc          # EXPLICIT gc, threshold disabled
loose 1 → 0                    # it packed anyway
$ git -c gc.auto=<N> -c gc.autoDetach=false gc --auto
                               # never triggered at 1–4 loose objects for N ∈ {1,100,200,256,300,400,512}
```

Explicit `git gc` ignores `gc.auto` entirely; only `--auto` consults it. The `--auto` predicate is
documented as counting "**approximately** more than this many loose objects" — it samples a single
fanout directory rather than counting. **The exact sampling predicate was not reproduced**: no
`gc.auto` value tried made `--auto` fire at these object counts, so this design does **not** model
git's estimator. P9 uses an exact loose count, which sits inside git's own documented
"approximately", and states so.

### Pin J — `git gc` also packs refs

```text
$ git gc
.git/packed-refs        present
.git/refs/heads/        EMPTY
```

`git gc` runs `pack-refs`, `reflog expire` and `worktree prune` as well as repacking. **P9's
gc-lite does none of them**: tsgit already ships `packRefs()` as its own Tier-1 command, and
bundling it into `maintenance` would make one call mutate the ref backend. Stated, not inherited.

### Pin K — the commit-graph header `git commit-graph write --reachable` emits

```text
$ git commit-graph write --reachable ; sha=A
$ git gc                              ; sha=B          A == B   (byte-identical)
$ xxd -l 12 .git/objects/info/commit-graph
00000000: 4347 5048 0101 0400 4f49 4446    CGPH....OIDF
          C G P H  ^v1 ^hash1 ^4 chunks ^0 base graphs
chunks: OIDF OIDL CDAT GDA2
$ git commit-graph verify        → silent, exit 0
```

Confirms Pin C at the byte level and fixes the exact header P9's writer must emit: magic `CGPH`,
version `1`, hash version `1` (SHA-1) / `2` (SHA-256), chunk count `4`, base-graph count `0`.

### Pin L — the commit-graph lock file

```text
$ : > .git/objects/info/commit-graph.lock
$ git commit-graph write --reachable
fatal: Unable to create '<repo>/.git/objects/info/commit-graph.lock': File exists.

Another git process seems to be running in this repository, or the lock file may be stale
```

git serialises commit-graph writes through `objects/info/commit-graph.lock`. tsgit's writer must
take the **same** path, so a tsgit write and a concurrent `git commit-graph write` exclude each
other instead of interleaving.

### Pin M — an octopus merge adds the `EDGE` chunk

```text
$ git merge --no-edit br1 br2 br3        # 4-parent commit
$ git commit-graph write --reachable
header      4347 5048 01 01 05 00        CGPH · v1 · hash1 · 5 chunks · 0 base graphs
chunk ids   OIDF OIDL CDAT GDA2 EDGE
$ git commit-graph verify                → silent, exit 0
```

`numChunks` is **4** without an octopus merge (Pin K) and **5** with one. `EDGE` is the only
conditional chunk in the default write.

### Pin N — SHA-256 repositories

```text
$ git init --object-format=sha256 … && git commit-graph write --reachable
$ xxd -l 12 .git/objects/info/commit-graph
00000000: 4347 5048 0102 0400    CGPH · v1 · hash version 2 · 4 chunks · 0 base graphs
```

Only the hash-version byte moves; the chunk set is unchanged. Matches the reader's
`hashLength = hashVersion === 1 ? 20 : 32` (`commit-graph.ts:86`).

### Pin O — `commit-graph write --reachable` walks refs only

```text
$ git checkout -b gone && commit && git checkout - && git branch -D gone
$ git commit-graph write --reachable
graph commit count      1
git rev-list --all      1        ← the reflog-only commit is in NEITHER
```

The commit reachable only from the deleted branch's reflog is **absent from the graph** — while
Pin H shows the very same commit **is** retained and packed by `gc`. One command, two root sets;
see P9.

---

## Requirements

No requirements artifact exists for this run; the review is the source. Restated as verifiable
statements. `Rn` numbers are referenced by the parts.

**Correctness / faithfulness**

- **R1** Every part except F3, F9 and F11 is behaviour-preserving on the public surface: identical
  results, identical error codes with identical `.data`, identical refusal ordering, identical
  on-disk bytes, for every input. F11 adds surface and writes new artefacts; it removes and
  changes nothing that exists.
- **R2** F3 changes exactly one thing observably: a corrupt object read through
  `readObject`/`readRawObject` propagates instead of throwing `OBJECT_HASH_MISMATCH`.
  `write-object.ts`'s write-side verification, `fsck`'s independent re-hash, and `bundle verify`'s
  prerequisite check keep verifying. Recorded in ADR-718 (supersedes ADR-389's default posture);
  amends `docs/understand/security.md:92`.
- **R3** F9 changes exactly one thing observably: a first-party-adapter path that
  escapes the layout roots refuses with `PERMISSION_DENIED` rather than `PATHSPEC_OUTSIDE_REPO`,
  and a path containing a `..` segment that resolves back inside the roots is accepted rather than
  refused. Every user-supplied `opts.fs` keeps today's behaviour exactly. Config-scope reads
  (`~/.gitconfig`, `$XDG/git/config`, `/etc/gitconfig`) still resolve to an empty scope, not a
  throw — `readSingleScopeUncached` catches `FILE_NOT_FOUND` and `PERMISSION_DENIED` only.
- **R4** F2's cursor-based path descent preserves `parseTreeContent`'s duplicate-entry-name
  refusal — byte-identical error data — and its eager per-entry mode validation on the descended
  directory (ADR-723; no divergence is taken).
- **R5** F12's parallel parent reads keep the date-walk's pop order identical for every input and
  keep `OBJECT_NOT_FOUND` propagation deterministic in **parent-array order**, not
  first-in-time order.
- **R6** F14's re-keying is symmetric across every Context derivation: writing through a derived
  Context and reading through the original (or vice-versa) never misses. The seven derivation
  sites are enumerated in P8 and each is classified as *same-repository* or *distinct-repository*.
- **R7** No provenance references (phase / ADR / backlog numbers) in source or test code.

**Maintenance (P9 / F11)**

- **R22** For any commit set, `maintenance({ tasks: ['commit-graph'] })` writes
  `objects/info/commit-graph` **byte-identical** to `git commit-graph write --reachable` run on the
  same repository by git 2.55.0, for both SHA-1 and SHA-256 repositories, and
  `git commit-graph verify` accepts the result at exit 0.
- **R23** `maintenance` never loses an object. For every object readable before the call —
  reachable or not, loose or packed — `readObject` succeeds after it, and `git fsck` on the
  resulting repository is silent at exit 0.
- **R24** gc-lite unlinks a loose object **only** after the pack, `.idx` and `.rev` containing it
  are all present at their final paths, and **only** if that object is in the pack it just wrote.
  No object is deleted on age. No pack, `.idx`, `.rev`, `.bitmap`, `.promisor`, mtime sidecar or
  `multi-pack-index` file that existed before the call is removed by it (under DC-17(a); DC-17(b)
  replaces this clause — see the part).
- **R25** After gc-lite, a host `git` reads the repository unchanged: `git fsck`, `git log`,
  `git cat-file -p` on a packed oid and `git rev-list --all --objects` all succeed, and
  `git count-objects -v` reports the expected `count` / `in-pack` split.
- **R26** `maintenance` mutates neither refs nor reflogs nor the index (Pin J): no `pack-refs`,
  no `reflog expire`, no `worktree prune`. A test asserts `packed-refs`, every loose ref file and
  every reflog is byte-identical across the call.

**Artifacts / observability**

- **R8** `docs/perf/baseline.json` and `docs/perf/baseline.md` are committed regenerated from the
  current tree, and the JSON records enough information to tell a well-sampled row from an
  under-sampled one (see R9).
- **R9** For every profiled workload the committed baseline records the **absolute tsgit tick
  total** the shares were computed from. A workload whose tick total is below a recorded floor is
  marked as such, and no oracle in this change reads a share delta from a marked row.
- **R10** A repeatable local absolute-wall-clock A/B driver exists and is documented: two
  worktrees, the same bench-file list, alternating rounds, `bestOfRounds` reduction, absolute
  `Base (ms)` / `Current (ms)` columns.
- **R11** The `add`, `commit` and `merge` write profiles attribute `openRepository` + scratch
  construction separately from the command, or exclude them from the sampled region.

**Performance (each with an oracle; all local, dev-machine)**

- **R12** `test/bench/pack-offset-table.bench.ts`'s many-object scenario shows a strictly lower
  median ms after P3 than before, on the same machine and fixture, **and** its `.rev`-present and
  `.rev`-absent rows stop being the same code path — the first proving the **lazy `.rev`-backed
  successor**, the second the **`Float64Array` fallback table** (today the fixture is 3 000 objects
  and `REV_INDEX_MIN_OBJECTS` is 5 000, so both rows sort and neither proves anything).
- **R13** `test/bench/delta-chain-read.bench.ts`'s cold row shows a strictly lower median ms after
  P3 (F10 is the only change that can move it).
- **R14** `test/bench/blame.bench.ts`'s deep-ancestry tiers show a strictly lower median ms after
  P4.
- **R15** `test/bench/status.bench.ts` and `test/bench/add.bench.ts` show strictly lower median ms
  after P6, with the per-file `lstat` budget unchanged (`add --all` over 3 files stays
  `[1, 1, 1]`).
- **R16** A new `test/bench/checkout.bench.ts` exists and shows a strictly lower median ms after
  P7 than the same scenario measured on `main`.
- **R17** Peak RSS for a clone of a fixture whose pack exceeds the buffered-pack size is bounded
  independently of pack size after P7 (`tooling/bench-memory.ts` workload), demonstrated at two
  pack sizes differing by ≥4×.
- **R18** Every pool introduced or reshaped in P1/P6/P7 derives its bound from
  `ConcurrencyPolicy`, and a unit test proves the derivation for at least: 1 core, 2 cores,
  11 cores, 128 cores, `UV_THREADPOOL_SIZE` unset, `UV_THREADPOOL_SIZE=1`, and the
  no-platform-information fallback.

**Gates**

- **R19** `npm run validate` is green at every commit; `reports/api.json` is regenerated and
  committed in the part that changes the public surface.
- **R20** `check:architecture`, `check:tarball` (both `node:` guards) and the three runtime-parity
  jobs stay green — in particular `index.default.js` reaches no `node:` specifier after P1.
- **R21** Mutation budgets hold per bucket, and every equivalence proof this change moves is
  re-proved against the new structure or removed.

---

## Design

### 0. Ordering

```text
P0 harness honesty            ← every later oracle reads it; MUST be first
P1 concurrency policy seam    ← P6 and P7 consume it
   ├── P2 quick wins          (independent)
   ├── P3 pack                (independent)
   ├── P4 blame               (independent; overlaps P2's F2.3 one-liner — see P2)
   ├── P5 read policy         (F3 + F4; ADR-718, ADR-727)
   ├── P6 status/add/index    (consumes P1; ADR-726)
   ├── P7 checkout/clone      (consumes P1; ADR-725, ADR-728)
   └── P8 structural          (ADR-721, ADR-722)
P9 maintenance                (ADR-724, full breadth; largest lift, new command surface)
```

P9 sits **last** and depends on three earlier parts, which is why it cannot be reordered:
P1's `ioBound` bucket sizes its loose-object enumeration fan-out; P3's lazy successor lookup is
what makes reading every object out of an existing pack affordable; and P5's `verifyHash: false`
default must **not** apply to it — gc-lite reads objects it is about to delete the only copy of,
so it opts back in explicitly (see the part).

P0-before-everything is not a preference. The committed baseline is stale *and* — as P0
establishes — under-sampled to the point where several of the review's headline share numbers are
single-tick artefacts. Acting on them before fixing the harness would be optimising noise.

P1-before-P6/P7 is also forced: both later parts introduce pools, and the user requirement is that
no pool invents its own constant.

### 0.1 Invariant-route checklist (binds P2, P3, P6, P8, P9)

Six of the parts add a memo or relax a check. For each, the implementer must **walk every route
that can bypass or re-admit the invariant** — including bootstrap, discovery, and any
post-canonicalisation re-entry — and record the walk in the part's commit body. Concretely:

| New memo / relaxation | Every route that must be walked |
|---|---|
| P2's gate-verdict memo | every `assert*Repository` call site (88); every writer that changes `${gitDir}/config` (the 7 `invalidateConfigCache` callers **plus** the 2 that currently forget the scoped cache); external mutation between commands (the memo must not outlive a config write, and `hasUsableHead` must stay per-command — it is what notices an externally deleted HEAD); repository re-open; worktree/submodule derivation |
| P2's loose-read cache population | every `writeObject` path (the loose fanout cache is invalidated only by tsgit's own writes, so a test or peer process writing via real git needs a fresh Context); `refresh()`; `dispose()` |
| P3's `(pack, offset)` cache | `registry.refresh()` (offsets are only meaningful within a generation); `dispose()`; midx rebind; a pack file replaced under a live handle |
| P6's index cache | `acquireIndexLock` → `lock.commit`; every `writeIndex` path; an external `git add` between two tsgit calls (the `(size, mtimeMs, mtimeNs, ino)` key is what catches it — **and second-resolution filesystems are why `mtimeNs` and `ino` are both in the key**) |
| P8's containment relaxation | the discovery walk (before any adapter exists); `worktreeFs(path)` (a fresh adapter per call); submodule child contexts; the config-scope allowlist paths; `unsafeRawAdapters`; user-supplied `opts.fs` (must be unaffected) |
| P8's session token | all seven derivation sites, in both directions — write through the derived Context and read through the original, **and** the reverse |
| P9's loose-object unlink | `internal/loose-oid-cache.ts` states the invariant **"tsgit never prunes loose objects"** twice in prose (`:13-15`, `:61`) and its only mutator is add-only (`invalidateLooseOid :67-69`). gc-lite falsifies it: every fanout prefix it unlinks from must go through `forgetLooseOidPrefix` (`:76-78`) — or gain a remove-member helper — **in the same commit that adds the unlink**, and the two prose blocks must be rewritten. Also walk: `object-resolver.ts:197/203` (the probe + stale-HIT recovery), `write-object.ts:49/54`, and `refreshPackRegistry` after the new pack lands |

Every cache added here is also **write-path symmetric**: the part that adds the read cache adds
its invalidation in the same commit, never in a follow-up.

---

### P0 — Harness honesty (F16)

**Anchors (verified).**

| Thing | Anchor |
|---|---|
| profiler driver | `tooling/profile.ts` (219 lines); parent/child split on `--child` |
| workload registry | `tooling/profile-registry.ts` — 10 read + 3 write |
| digest parsing / share computation | `tooling/profile-digest.ts` |
| baseline writer | `tooling/profile-baseline.ts` `writeBaseline` |
| write-scratch factory | `tooling/profile-scratch-repo.ts` `newScratch` |
| fixtures | `test/bench/support/fixture-generator.ts` (imported across the tooling/test boundary) |
| bench comparator | `tooling/bench-check.ts`; hot-op registry `docs/perf/hot-paths.json` |

**The three honesty defects, verified.**

1. **`self` has no absolute scale, and the current baseline is severely under-sampled.**
   `profile-digest.ts` filters the `--prof-process` digest with a *positive location* regex —
   only lines resolving into `dist-profile/esm/` survive:

   ```text
   const TSGIT_FRAME_LINE =
     /^\s*(\d+)\s+[\d.]+%\s+[\d.]+%\s+(?:\S+:\s+)?[*~^+]?(\S+)\s+.*dist-profile\/esm\//;
   ```

   `Builtin:`, `Stub:`, `RegExp:`, `GC`, `Unaccounted` and `[Shared libraries]` rows carry no such
   path, so they are excluded **from the denominator**, not merely from the ranking. Raw tick
   counts are then discarded (`normaliseShares` divides by the surviving sum and rounds to two
   decimals). Because the shares are exact values rounded to 2 decimals, the smallest tick total consistent
   with each committed share vector is recoverable:

   | workload | frames ≥1 % | smallest consistent tsgit tick total |
   |---|---|---|
   | `show` | 2 | **2** |
   | `pack-read` | 3 | **7** |
   | `add` | 7 | **7** |
   | `rev-parse` | 7 | **11** |
   | `cat-file` | 8 | **11** |
   | `blame` | 6 | **14** |
   | `commit` | 16 | **16** |
   | `diff` | 17 | **31** |
   | `describe` / `name-rev` | 31 / 30 | **56** / **67** |
   | `log` / `status` / `merge` | 14 / 18 / 55 | **80** |

   At V8's default 1 ms `--prof` interval (no `--prof-interval` is set), `add`'s uniform seven
   frames at exactly 1/7 and `commit`'s sixteen at exactly 1/16 are the signature of
   one-tick-per-frame sampling. **The review's `pack-read` "gatherByRevIndex 43 % / entryOffsets
   43 %" is 3 frames over ~7 ticks.** F1's *mechanism* is sound independently (an O(N) build to
   answer one query is visible in the code and in a dedicated bench), but the profile share is not
   evidence for its size, and this document does not use it as such.

2. **Open cost is attributed to the write commands.** `profile.ts:83-87` calls
   `workload.build(...)` **inside** the sampled loop; `newScratch` does
   `mkdtemp → openRepository → repo.init()`. The compensation is
   `SETUP_FRAMES = { openRepository, init, bootstrapRepository }`, subtracted by name only —
   everything those three *call* keeps its own frame name and stays in `hotShares`. In the fresh
   baseline all three `setupShares` arrays are **empty**, while `add`'s `hotShares` is
   `runFs / isContainedIn / findLayout / dirChain / createSingleFlightIndexResolver / addAll /
   normalizeSeparators`, six of seven of which are layout-discovery and adapter frames from
   `openRepository`. `buildMergeScratch` additionally runs 3 adds, 3 commits, a branch create and
   2 checkouts inside the loop.

3. **Nothing gates on the profile, and no local A/B driver exists.** `baseline.{json,md}` are
   read by no `validate` task. `npm run bench` does not exist. `npm run test:perf` runs exactly
   one file (`test/perf/domain/pathspec/compile-glob.perf.test.ts`, a ReDoS wall-clock guard) and
   is deliberately isolated from Stryker. `tooling/bench-check.ts` is the comparator but is
   invoked only by the label-gated, `continue-on-error: true` `benchmark-compare` CI job, and it
   filters to `hot-paths.json`'s seven operations.

**Shape.**

- **P0.1 — record ticks.** Extend the baseline schema from `{ frame, self }` to
  `{ frame, self, ticks }` plus a per-command `totalTicks`, and render a `totalTicks` line in
  `baseline.md`. `renderBaselineJson` is the only writer; `parseDigest` already captures
  `ticks` before discarding them (`normaliseShares`). Add an explicit
  `UNDER_SAMPLED_TICK_FLOOR` (proposal: 500) and mark any command below it in both artifacts.
  This is a **schema change to a committed artifact**, ratified as **ADR-729** — the schema gains
  `ticks` and `totalTicks`, the floor is explicit, and the artifact stays ungated.
- **P0.2 — raise iteration counts until the floor is cleared.** `READ_ITERATIONS = 100`,
  `WRITE_ITERATIONS = 100`, `HEAVY_READ_ITERATIONS = 2`, `FAST_READ_ITERATIONS = 2000`. Raise
  per-workload counts (not the shared default) until each clears the floor, and record the chosen
  counts in the registry with the measured tick total in a comment. `blame`'s 2 iterations
  over a ~200-commit ancestry is the hard case; it may need a smaller fixture rather than more
  iterations.
- **P0.3 — take open out of the sampled region.** Hoist `workload.build(...)` out of the loop:
  build **all** scratch repos first, then run the loop over them. This changes `merge`'s
  measurement most (its build is 9 library calls). Where a workload genuinely cannot be
  pre-built (a stateful `add`), keep the per-iteration build but widen `SETUP_FRAMES` to the
  transitive open set (`findLayout`, `dirChain`, `normalizeSeparators`, `isContainedIn`,
  `runFs`, `createSingleFlightIndexResolver`, `cachedParentRealpath`, `assertTrusted`,
  `assertRepository`) — a name list is fragile, so prefer the hoist.
- **P0.4 — add a commit-graph read workload.** `MEDIUM_FIXTURE_WITH_COMMIT_GRAPH` exists
  (`fixture-generator.ts`) and is used by `test/bench/log.bench.ts:39` and
  `tooling/bench-memory.ts`, but **no profiler workload uses it** — so the profiler never samples
  the commit-graph read path at all. Register `log-commit-graph`. Note
  `tooling/gen-bench-fixture.ts` cannot pre-warm that fixture, so the first run pays generation.
- **P0.5 — the A/B driver.** Add `tooling/bench-ab.ts` implementing the CI recipe locally:
  pre-warm fixtures; take two worktrees; intersect the bench-file lists; alternate
  `base, head, base, head, …` rounds writing `reports/benchmarks/raw.json` out to
  `/tmp/{base,head}-<round>.json`; feed both comma-joined lists to `compareToBaseline`; print the
  absolute `Base (ms)` / `Current (ms)` columns. Crucially it must **not** filter to
  `hot-paths.json` (that filter is what makes `bench-check.ts` unusable for `add`/`commit`/
  `merge`/`checkout`).
- **P0.6 — fix the pack-offset-table bench fixture.** `MANY_OBJECT_COUNT = 3_000`
  (`test/bench/fixtures.ts:143`) is below `REV_INDEX_MIN_OBJECTS = 5_000`
  (`src/application/primitives/internal/pack-offset-table.ts:68`), so `resolveSortedOffsets`
  returns `sortAscending(raw)` *before reading the artefact* and the bench's "healthy `.rev`
  present" and "`.rev` deleted" scenarios exercise **the identical code path**.

  **ADR-720 retires the threshold**, which changes what the two tiers are for. They are no longer
  below/above a crossover — there is no crossover left. After P3 the two scenarios prove a
  *different* pair of code paths, and that is what the fixture must now guarantee:

  | Tier | Proves |
  |---|---|
  | `.rev` present | the **lazy path** — `readOffset(index, revIndexPositionAt(rev, p))` binary-searched, O(log N) `DataView` reads, no table built |
  | `.rev` deleted | the **fallback path** — the memoised `Float64Array` sorted-offset table, still O(N) once per pack per generation |

  So the object count no longer has to clear 5 000 to make the rows differ — after P3 they differ
  at *any* count, because the discriminator is artefact presence, not size. Keep the count above
  the retired threshold anyway (a **single** raise, to ~8 000), for two reasons: it keeps the
  before/after A/B comparable on `main`, where the threshold still exists and 3 000 would make both
  pre-change rows identical; and it keeps the fallback tier large enough for the O(N) build to be
  measurable against the O(log N) path. A second below-crossover tier would now measure nothing —
  **do not add one**. Note the cache coupling: bench fixtures live under
  `~/.cache/tsgit-bench/<label>-v<FIXTURE_GENERATOR_VERSION>` and the CI cache key is a hash of
  `test/bench/support/fixture-generator.ts` — **editing that file invalidates the nightly's whole
  fixture cache**, so the next `bench.yml` run regenerates everything inside its 30-minute
  timeout. Budget one slow nightly and bump `FIXTURE_GENERATOR_VERSION` deliberately.
- **P0.7 — commit the regenerated baseline.** The uncommitted `docs/perf/baseline.{json,md}` in
  this tree are the current-tree numbers; commit them together with P0's schema change so the
  artifact and its schema move once.

**Known caveat.** `add.bench.ts`, `commit.bench.ts` and `merge.bench.ts` build their scratch repo
**inside `sut`**, self-documented and accepted as advisory. P0 does not change that (the bench and
the profiler have independent framings); it only stops the *profiler* conflating them. Say so in
`docs/understand/performance.md` rather than silently leaving the asymmetry.

**Oracle.** Every command in the regenerated `baseline.json` carries `totalTicks ≥ floor`, or is
marked under-sampled. `npm run profile` completes. `tooling/bench-ab.ts` produces a table with
absolute ms columns on a no-op branch and reports a delta inside the noise band.

**Gate interactions.** `check:spelling` covers `docs/**/*.md`, so new frame names in
`baseline.md` may need `cspell.json` entries (never an inline suppression). `check:doc-links`
runs lychee over `*.md` — the baseline has no links. `tooling/test/unit/profile-digest.test.ts`
and `profile-registry.test.ts` pin the current schema and must move with it.

---

### P1 — The concurrency-policy seam (cross-cutting user requirement)

This is the part the user named explicitly, and it is the one place this design introduces new
architecture. **ADR-719 ratified the composite exactly as recommended** — the pure domain selector,
`Context.concurrency` as the home, two buckets, `min(cores, threadpoolWidth)` for `cpuBound` with
integrator documentation, and an internal type with a public `RepositoryConfig.parallelism`
override. What follows is therefore the settled shape, not a menu.

#### What exists today

Four independent pool helpers, six named constants, two magic literals, one dead option, three
unbounded fan-outs and three concurrency-1 loops — and **not one** of them derives from a machine
property. Verified inventory:

| # | Site | Bound | Named? | Stage | Limiting resource |
|---|---|---|---|---|---|
| 1 | `src/application/primitives/internal/bounded-map.ts:3` | `MAX_CONCURRENT_OBJECT_LOADS = 32` | yes, exported | object reads (diff-trees, grep, materialise-patch-files, detect-similarity-renames, walk-raw-subtree, flatten-raw) | **mixed** — fs read + inflate + hash |
| 2 | `src/application/primitives/internal/raw-subtree-prefetch.ts:55` | `PRESCAN_WINDOW = MAX_CONCURRENT_OBJECT_LOADS * 2` | yes | prefetch window | I/O |
| 3 | `src/application/primitives/internal/read-commit-graph.ts:33` | `DEFAULT_PREFETCH_CONCURRENCY = 8` | yes, exported | commit-body prefetch | mixed |
| 4 | `src/application/commands/merge.ts:619` | `MAX_CONCURRENT_PATH_WRITES = 32` | yes | working-tree path writes | I/O (comment: "so a 10k-path merge doesn't exhaust file descriptors") |
| 5 | `src/application/commands/range-diff.ts:51` | `MAX_CONCURRENT_COMMITS = 16` | yes | per-commit patch-id | mixed |
| 6 | `src/adapters/node/node-file-system.ts:65` | `REMOVE_TREE_CONCURRENCY = 8` | yes | `rmRecursive` fan-out | I/O — **the only bound already living in an adapter** |
| 7 | `src/application/primitives/snapshot-operators/hash-slot.ts:25` | `opts.concurrency ?? 4` | **no — magic literal** | working-tree blob hashing | mixed, hash-heavy |
| 8 | `src/application/primitives/snapshot-operators/load-blob.ts:72` | `opts.concurrency ?? 4` (+ `DEFAULT_MAX_INFLIGHT_BYTES = 64 MiB`) | **no — magic literal** | blob loading | I/O |
| 9 | `src/application/primitives/snapshot/join.ts:9` | `JoinOptions.concurrency?: number` | **declared, never read**, and publicly exported | — | — |
| 10 | `src/ports/context.ts:131` + `src/repository/validate-options.ts:22-23` | `RepositoryConfig.parallelism`, 1..32, default 8 | yes | read at exactly **two** sites: `walk-commits.ts:50`, `internal/commit-date-walk.ts:91` | mixed |

**Unbounded `Promise.all` fan-outs (no pool at all), verified:** `status.ts:202` (every stage-0
entry), `status.ts:351`, `commit.ts:441`, `merge.ts:511`, `ref-store.ts:769`,
`internal/fsck/roots.ts:106`, `bundle-create.ts:218`. **Concurrency-1 loops on hot I/O paths:**
`apply-changeset.ts` materialisation and dirty prescan, `add.ts:253` staging.

**Pools nest, and the nesting multiplies.** `detect-similarity-renames.ts:394` is a 2-arity
`Promise.all` whose *each* arm runs `hydrateIds → boundedMap(…, 32)` — **64 object loads in
flight**, not 32. A stage-named policy makes this visible; a per-call-site constant hides it.
This is the second reason (after the libuv ceiling) that the bounds must come from one authority.

Helpers, all verified: `boundedMap` (`internal/bounded-map.ts:3,10-29`, input-order results,
`Promise.all` rejection semantics, no cancellation), `createConcurrencyLimiter`
(`internal/concurrency-limiter.ts:10-12,14-51`, counting semaphore for streaming walkers, one
instance threaded through a whole recursion; its `run` has exactly one consumer,
`internal/raw-subtree-prefetch.ts:103`), `createBoundedReader`
(`internal/bounded-reader.ts:4-11,19-68`, semaphore + per-id memo), `mapConcurrent`
(`node-file-system.ts:107-128`, a fourth adapter-local copy with documented "workers keep draining
the queue after a rejection" semantics), and `runBounded` (`merge.ts:663`, a result-discarding wrapper over
`boundedMap`). There is also a close-only `Promise.allSettled` drain in `pack-registry.ts` on the
handle path (`:379-402` is the `readSlice` handle acquisition) — a *shutdown* fan-out, not a work
pool, and out of the policy's scope.

**`src/` reads no machine property at all today**: `os.availableParallelism`, `os.cpus`,
`navigator.hardwareConcurrency` and `UV_THREADPOOL_SIZE` appear nowhere in `src/`. The only
`os.cpus()` calls in the repo are provenance strings in `tooling/`.

#### The mechanism that decides the bounds

The user's framing is right, and one Node-specific fact sharpens it:

- **CPU-bound work in JS is not made parallel by a promise pool.** tsgit runs on one thread. A
  pool over `inflateSync` does not overlap anything — it just reorders. Real CPU parallelism in
  Node requires the *asynchronous* zlib/crypto APIs, which dispatch to the **libuv threadpool**.
- **The libuv threadpool is the ceiling for both stage classes in Node.** `fs.*` (async),
  `zlib.*` (callback form) and most of `crypto` all queue on the same pool, default width **4**,
  configurable only via `UV_THREADPOOL_SIZE` **before the first pool use**. So on this 11-core
  machine, an "inflate pool of 11" and an "lstat pool of 64" both really run 4 wide, and they
  contend with each other.
- **A library must not set `UV_THREADPOOL_SIZE`.** Mutating `process.env` is hostile to the host
  application and, past the first pool use, inert. tsgit can only *read* it and size accordingly.
- **The browser is the mirror image.** `DecompressionStream` is native and off the JS thread;
  `navigator.hardwareConcurrency` is the only signal, and several browsers clamp it for privacy
  (reported values as low as 2) — a hint, not a measurement.
- **workerd has neither.** `index.default.js` must work with no machine information at all.

So the derivation is not "cores for CPU, 4 for I/O". It is:

```text
cpuBound   = clamp(1, min(cores, threadpoolWidth), CPU_CAP)      // Node: min(11, 4) = 4
ioBound    = clamp(1, threadpoolWidth * IO_OVERSUBSCRIBE, IO_CAP) // Node: 4 * 8 = 32
```

`ioBound` oversubscribes deliberately: an `lstat` that misses the page cache spends its time
blocked, so queuing more than the pool width keeps the pool saturated; the cap exists to bound
file-descriptor pressure (which is exactly what `MAX_CONCURRENT_PATH_WRITES`'s comment already
says). `cpuBound` does **not** oversubscribe: extra queued deflates only add latency.

Fallbacks, in order, per runtime:

| Runtime | `cores` | `threadpoolWidth` |
|---|---|---|
| Node | `os.availableParallelism()` | `Number(process.env.UV_THREADPOOL_SIZE) || 4` |
| Browser | `navigator.hardwareConcurrency ?? 4` | `cores` (streams are native; no libuv) |
| Memory / workerd | `undefined` → floor | `undefined` → floor |

The floor (`cpuBound = 1`, `ioBound = 4`) must be a *safe* answer, because workerd will always
take it.

#### Proposed shape

Three collaborating pieces, respecting the dependency rule:

1. **A pure selector in the domain** — `src/domain/concurrency/derive-limits.ts`:

   ```ts
   export interface MachineFacts {
     readonly cores?: number;            // undefined ⇒ unknown
     readonly threadpoolWidth?: number;  // undefined ⇒ unknown
   }
   export interface ConcurrencyLimits {
     readonly cpuBound: number;
     readonly ioBound: number;
   }
   export function deriveLimits(facts: MachineFacts): ConcurrencyLimits;
   ```

   Pure, total, no platform imports — 100 % coverage-testable, and the place R18's matrix is
   proved. This mirrors ADR-046's shape exactly: a pure `selectNativePolicy(platform)` selector
   plus a thin host-bound binding.

2. **A capability on the ports side** carrying the *resolved* limits, so nothing below the
   composition root reads a machine property. **Settled (ADR-719): a new optional
   `Context.concurrency?: ConcurrencyLimits` field**, filled by the composition root from
   adapter-supplied facts. It must be **optional**: 215 test files construct a Context, and a
   required field is a 215-file change. `RepositoryLayout` was rejected as a home (it is about
   *where the repository is*), and `RepositoryConfig.parallelism` rides **alongside** rather than
   instead — see below.

3. **The platform binding in the node adapter only** —
   `src/adapters/node/node-concurrency.ts`, `nativeMachineFacts()`, reading
   `os.availableParallelism()` and `process.env.UV_THREADPOOL_SIZE`, imported **only** from
   `src/index.node.ts`. The browser shim reads `navigator.hardwareConcurrency` inline
   (no `node:` import). `index.default.ts` passes nothing and takes the floor. This is what keeps
   `tooling/verify-tarball.sh`'s `node:`-free guard and the blocking workerd parity job green.

4. **One pool module** — consolidate `boundedMap`, `runBounded`, `createConcurrencyLimiter`,
   `createBoundedReader` and `mapConcurrent` behind a single internal module whose entry points
   take a *stage name*, not a number:

   ```ts
   type Bucket = 'cpuBound' | 'ioBound';
   const limitFor = (ctx: Context, bucket: Bucket): number => …;
   ```

   **Granularity is settled at two buckets** (ADR-719 rejected the five-named-stage taxonomy: the
   per-stage multipliers would have been invented rather than measured — the exact failure mode the
   user requirement exists to prevent). Every one of the twelve inventoried sites classifies
   cleanly into one of the two. A bucket is promoted to its own row only when an A/B shows the
   bucket is wrong for that site — and then the promotion is a measurement, not a guess.
   `mapConcurrent` lives in the adapter and cannot import from `application/` — it keeps its own
   copy or takes its limit as a constructor argument on `NodeFileSystem`.

**Absence is a first-class case.** The field is optional, so every
consumption site resolves as `limitFor(ctx, bucket)` where the helper falls back to the derivation
of `{}` — i.e. the floor (`cpuBound = 1`, `ioBound = 4`). A Context built by
`createNodeContext`/`createMemoryContext`/`createBrowserContext` or by a unit test therefore
behaves correctly without being updated, and workerd takes the same path. **The floor must be a
safe answer, never a fast one.**

**`RepositoryConfig.parallelism` keeps working, keeps winning, and widens to a pair.** Its two
current consumers (`walk-commits.ts:50`, `internal/commit-date-walk.ts:91`) already read
`ctx.config?.parallelism ?? DEFAULT_PREFETCH_CONCURRENCY`; after P1 the fallback becomes the
derived bound instead of the literal `8`. Per ADR-719 the type widens to
`number | { cpu?: number; io?: number }` — the *knob* is public even though `ConcurrencyLimits`
is not, which is exactly where `parallelism` already sits. A bare `number` keeps meaning what it
means today and applies to both buckets. The validated 1..32 range and its
`invalidOption('parallelism', …)` refusals extend to both members of the object form. Every other
pool acquires the override for free, which is a behaviour *widening* — a caller who set
`parallelism: 2` today affects two sites and afterwards affects all of them. ADR-719 calls that
widening deliberate; the implementer must still cover it in `validate-options.test.ts` and in the
`repository.md` option docs.

**What P1 changes behaviourally.** Nothing observable — but **bound values change**, e.g.
`MAX_CONCURRENT_OBJECT_LOADS` 32 → `ioBound` (32 on this machine with the default threadpool,
8 if `UV_THREADPOOL_SIZE=1`). That is a measurable change and must be A/B'd, not assumed
neutral. Sites 7/8/9 (`hash-slot`, `load-blob`, `join`) are on the **public snapshot surface**:
their `opts.concurrency` option must keep working and keep winning over the policy; `join.ts:9`'s
dead option is either wired or removed (removing it changes `reports/api.json`) — ADR-719 requires
one or the other, not the status quo.

**Integrator documentation is part of the part, not a follow-up.** ADR-719 ratified the
`cpuBound = min(cores, threadpoolWidth)` derivation *together with* the note telling integrators
that raising `UV_THREADPOOL_SIZE` is theirs to do, in the host application, **before the first
threadpool use**. tsgit never sets it. The note lands in `docs/understand/performance.md` in P1,
because a ceiling nobody can see is a ceiling nobody raises. Non-Node runtimes that accept but may
not honour the variable (Deno, Bun) are treated as "threadpool width unknown" → floor.

**Gates.** New port/domain files → 100 % coverage + `infra`/`domain` mutation buckets;
`src/ports/index.ts` re-export required or `knip` calls it dead code; `ConcurrencyLimits` stays
**internal** so `reports/api.json` grows only by the widened `parallelism` type;
`check:architecture`; `check:tarball` `node:` guard; `test-pyramid-budgets.json`
`sutBindsResult.allowlist` updated for any renamed factory.

---

### P2 — Quick wins (F5, F12, F2.3, F15)

Behaviour-preserving, no ADR, no new surface.

#### F5 — per-command gate re-validation

**Anchors (corrected).** The review's `repo-state.ts` is
`src/application/commands/internal/repo-state.ts`, which is now an 8-line deprecated re-export
shim. The source of truth is
**`src/application/primitives/internal/repo-state.ts`**; the line numbers are exact.

```ts
// src/application/primitives/internal/repo-state.ts:116-126
const hasUsableHead = async (ctx: Context): Promise<boolean> => {
  const headPath = `${ctx.layout.gitDir}/HEAD`;
  const linkText = await ctx.fs.readlink(headPath).catch(() => undefined);
  if (linkText !== undefined) return isRefsLinkText(linkText);
  const head = await ctx.fs.readUtf8(headPath).catch(() => undefined);
  return head !== undefined && isValidHeadContent(head);
};
```

Per-command sequence: `assertOperationalRepository` (`:275`) → `assertAcceptedRepository`
(`:260`) → `assertRepository` (`:97`) → `hasUsableHead` (**2 fs calls**) →
`assertDiscoveryBooleansValid` (`:79`, **2 token walks**) → `assertTrusted` (`:241`, sync, zero
I/O) → `formatRefusal` (sync) → `assertEagerConfigValid` (`:193`, **6 token walks** in one
`Promise.all`). **88 call sites** in `src/`, 86 of them in `commands/` — once per command *verb*,
and `openRepository` does not run the gate, so nothing amortises it.

The 8 finders are `findLastInvalidMaxTreeDepth`, `findFirstValuelessEntry`,
`findFirstInvalidCompression`, `findFirstInvalidBoolean`, `findFirstInvalidLogAllRefUpdates`,
`findFirstInvalidBooleanInSection`, `findFirstValuelessInSection`, `findFirstInvalidPushGpgSign`
(all in `src/application/primitives/config-read.ts`), four of them delegating to the private
`findFirstRejectedBoolean` (`:1216`) — the 18 % frame in the `rev-parse` profile. Each opens with
`await readConfigEntry(ctx)`, which is cached per Context (`config-read.ts:156`,
`WeakMap<Context, Promise<ConfigCacheEntry>>` holding `{ parsed, tokens, source }`), so the walks
are in-memory array scans, not I/O.

**Fix.** A tenth per-Context `WeakMap<Context, Promise<FilePath>>` memoising the *gate verdict*.
It is a pure function of the token stream plus `ctx.layout`, both immutable for a Context's life.
It **must** be invalidated wherever `invalidateConfigCache` fires, or a mid-session
`git config core.sparseCheckout=bogus` write stops refusing. Collapse `hasUsableHead`'s two reads
to an `lstat`-discriminated single read — **not** to a single `readUtf8`: the
`readlink`-then-`readUtf8` order mirrors git's `validate_headref` (a symlinked HEAD is judged by
link text, a regular file by content), and the `.catch(() => undefined)` arms deliberately
collapse absent/EACCES/EISDIR/EIO into one verdict.

**Traps.** `assertEagerConfigValid`'s `core.maxTreeDepth` ordering is **pinned against measured
git** — thrown before the five-way `pickLowerLine` reduction, and *last-wins* where every other
key is *first-wins*. Any merge-the-walks refactor must preserve which of two malformed keys
refuses first (interop pin: `test/integration/max-tree-depth-config-interop.test.ts`).
`pickLowerLine`'s tie-freedom rests on the tokenizer invariant that distinct keys occupy distinct
physical lines. And ADR-351 already records that the tempting
"skip the gate when `ParsedConfig.core` is absent" short-circuit is **unsound**.

**Rider (a real defect, found while verifying).** `invalidateConfigCache`'s docstring
(`config-read.ts:192-200`) claims it also drops the per-scope sections cache; it does not — it
never calls `invalidateScopedConfigCache`. Two writers leave the scoped cache stale:
`update-config.ts:434` and `:561`. Five other sites call both. Fix the two writers and the two
false docstrings (`config-read.ts:192-200`, `config-scoped-read.ts:101-102`) in this part.

#### F12 — graph-absent walk is concurrency-1

**Anchor (corrected).** `src/application/primitives/internal/commit-date-walk.ts` — the review
omits the `internal/` segment. `enqueueParents` `:132-138`, `enqueueCommit` `:140-159`.

The review says "the prefetcher only helps graph-present repos". The **structural** reason is
sharper: the heap is date-ordered, and without a commit-graph the date only exists inside the
body, so `enqueueCommit` cannot push until its body resolves (`:154`) and `enqueueParents` awaits
each parent in turn — strictly one read in flight. By contrast `walk-commits.ts:149-158` calls
`bodies.start(id)` **without** awaiting, because a FIFO queue needs no date at enqueue time; the
topo walk is already concurrent graph-absent. Only the date walk is concurrency-1.

**Fix.** Start every selected parent's body read, then await, then push. Three traps the
"5-line diff, heap order unchanged" framing misses:

1. Pop order is safe — `precedes` (`src/domain/commit/priority-queue.ts:21-22`) is a strict total
   order over `(date, oid)` and `walk.seen` guarantees distinct oids. But **`frontier()` returns
   the unsorted backing array by reference** (`binary-heap.ts:70-74`), so sibling *push* order
   becomes completion order. Resolve all parents first, then push in parent-array order.
2. `Promise.all` rejects with the first-in-**time** rejection. Today a missing parent throws in
   parent order (`internal/commit-date-walk.test.ts:295-346` asserts propagation). Use
   `allSettled` + rethrow in array order.
3. The graph-present early return (`:143-149`) is explicitly pinned as "must enqueue from the
   header WITHOUT awaiting the body" — keep that path body-await-free.

#### F2.3 — loose reads bypass the delta cache

```ts
// src/application/primitives/object-resolver.ts:184-188
async function tryLoose(ctx: Context, id: ObjectId): Promise<Uint8Array | undefined> {
  const compressed = await readLooseCompressed(ctx, id);
  if (compressed === undefined) return undefined;
  return ctx.compressor.inflate(compressed);
}
```

`resolveObjectBytes` probes `ctx.deltaCache` at `:56` and returns the loose result at `:65`
**without** calling `cacheEntry` — only `:342` (reconstructed pack object) and `:432`
(REF_DELTA base) populate. On a loose-heavy repo every repeated tree/commit read re-inflates.
One-line fix: `cacheEntry(ctx.deltaCache, id, loose)` before returning.

**Watch:** `test/parity/scenarios/read-pipeline.scenario.ts` asserts `readObject` **call counts**;
`RawObject.content` may alias the cache (`primitives/types.ts:87-88`), so the cached buffer must
be treated as immutable by every consumer. And the 16 MiB budget is now shared with loose bytes —
demand goes up before it goes down, which is exactly why P3's F10 and this land in different parts
with an A/B between them.

#### F15 — micro batch

Verified, with anchors:

- `LruCache.get` unlinks and re-links even when the node is already head
  (`src/domain/storage/lru-cache.ts:78-86`) — a one-line head fast-path. `NodeFileSystem`'s
  `parentRealpathCache` (`node-file-system.ts:446`, 128 KiB / 512 entries) is the hot consumer.
- `mapStat` builds its object through double `Number()` round-trips and two spreads
  (`node-file-system.ts:342-374`). Build it once. **Keep `bigint: true`** — `matchesMtime`
  treats a missing nanosecond field as a match, so dropping it *loosens* the racy-clean guard.
- Module-level `TextEncoder` in `object-resolver.ts:353`; the singleton already exists at
  `src/domain/objects/encoding.ts:60`.
- `stepEntry` / `verifyPath` character-code pre-screens on the index-path validation hot path (the `stepEntry`
  6 % and `validateIndexPath` 4 % rows in the `status` profile).
- `resolveWrite` gains the prefilter `resolveRead` already has; `requireWorkTree` hoists out of
  the per-entry status calls.
- `assertValidPromisorRemoteConfig` (`add.ts:417`) becomes lazy-once per `add` invocation instead
  of per staged file.
- Collapse one async-generator layer in `log` (`commitDateWalk` → `walkCommitsByDate` both wrap
  every commit).
- **A sync fast path for delta-cache hits — now enabled.** ADR-718 flips the default to
  `verifyHash: false`, so the cache-hit arm (`object-resolver.ts:56-60`) no longer has to await a
  hash and `verifyAndReturn` no longer has to be on the hot path at all. Two obligations ride with
  it. (1) `verifyAndReturn` carries an abort poll (`object-resolver.ts:230`, `checkAborted`
  between hash and compare) pinned by `docs/design/primitives.md:1229`; ADR-718 requires "an
  explicit poll at the same point", so the sync arm must **still** poll before returning — a sync
  return that never yields would make a cache-hot `log` impossible to cancel. (2) The arm stays a
  `Promise`-returning function; only the *body* short-circuits. Changing the signature would ripple
  through ~55 call sites for no gain. **Sequencing: this item reads P5's flip, and P2 lands before
  P5 — so it ships as a rider inside P5, not here.** It is listed under F15 because that is where
  the review put it; the part that owns it is P5.
- The size-gated callback-zlib item moves to **P7**, where it has a consumer.

---

### P3 — Pack: lazy successor lookup and an offset-keyed delta cache (F1, F10)

#### F1 — the successor query materialises the world

**Anchors (verified; one path corrected).**

```ts
// src/application/primitives/pack-registry.ts:354-371  (a closure inside loadPack)
const buildOffsetTable = async (): Promise<PackOffsetTable> => {
  const index = await indexMemo.get();
  const stat = await ctx.fs.stat(packPath);
  const packFileSize = stat.size;
  const raw = entryOffsets(index);                                   // boxed number[] over all N
  const sortedOffsets = await resolveSortedOffsets(ctx, name, raw, revIndexMemo.get);
  const trailerStart = packFileSize - ctx.hashConfig.digestLength;
  if (trailerStart < 0) throw invalidPackIndex('pack file too small to contain a trailer');
  return { sortedOffsets, packFileSize, trailerStart };
};
const offsetTable = createPromiseMemo(buildOffsetTable).get;
```

```ts
// src/domain/storage/pack-index.ts:144-150
export function entryOffsets(index: PackIndex): ReadonlyArray<number> {
  const offsets: number[] = [];
  for (let i = 0; i < index.objectCount; i += 1) offsets.push(readOffset(index, i));
  return offsets;
}
```

`gatherByRevIndex` is **not** at `src/domain/storage/pack-positions.ts` — that file does not
exist. It is `src/application/primitives/internal/pack-positions.ts:60-72`, and it is a second
O(N) pass over `raw`, gathering into a `Float64Array` via `revIndexPositionAt`.

Consumers of the table: exactly **two**, both single-entry read paths —
`object-resolver.ts:261` (`collectDeltaChain`, hoisted out of the chain loop because `hit.pack` is
invariant) and `internal/blob-source.ts:106` (`openBlobSource`, a single successor lookup, not
even in a loop). `nextOffsetForEntry` is `internal/pack-offset-table.ts:127-138`, over
`PackOffsetTable = { sortedOffsets: Float64Array; packFileSize: number; trailerStart: number }`.

**There is no bulk consumer of `offsetTable()`.** The bulk appetite lives on a *different* memo:
`RegisteredPack.packPositions()` (`pack-registry.ts:333-341`) returns a `Uint32Array` consumed by
the bitmap tier (`internal/pack-bitmap-binding.ts:59-80`), and fsck's rev-index pass calls
`packPositionMap(await pack.index())` directly (`internal/fsck/rev-index-health.ts:66`). The two
memos are already structurally independent — **so making `offsetTable()` lazy touches two call
sites and no bulk path.** This materially simplifies the review's "keep the table for bulk paths"
caveat: the eager table already has its own home.

The `.rev` surface is one function: `revIndexPositionAt(rev, p)`
(`src/domain/storage/rev-index.ts:173-181`), bounds-checking `p` but deliberately not the stored
value. The `.idx` surface has the private `readOffset` (`pack-index.ts:126-142`, handling the
MSB-set large-offset indirection) and the private fanout binary search
`searchIndexPosition` (`:157`). A lazy successor needs `readOffset` exposed (or a new
`offsetAtPackPosition(index, rev, p)` in the domain).

**Fix.** With a usable `.rev`, `p ↦ readOffset(index, revIndexPositionAt(rev, p))` is monotonic,
so the successor of an entry at byte offset `o` is found by binary-searching `p` and reading
`p+1` — O(log N) `DataView` reads, zero allocation. This is the shape canonical git uses for the
same query; the *behaviour* to match is only "same successor offset, same corruption refusals",
which the existing pack interop suite already pins. Keep the memoised table as the no-`.rev` fallback,
but build it straight into a `Float64Array` (drop the boxed intermediate).

**`REV_INDEX_MIN_OBJECTS = 5_000` is retired** (ADR-720). Its 24-line docstring justifies it with a
measured *gather-vs-sort* crossover table, and the lazy scheme deletes the gather entirely — there
is no crossover left to protect. After P3 the discriminator is **artefact presence, not object
count**: a present, loadable `.rev` always wins; a missing or unreadable one falls back. Delete the
constant and its docstring rather than setting it to zero, so the next reader does not go looking
for the trade-off it describes. An out-of-range `.rev` value degrades the pack to the fallback
exactly as the gather's bounds check does today — the degrade path is preserved, only its trigger
moves. Fixing midx repos falls out transitively: `PackLookupHit` is
`{ pack, offset }` with no midx provenance (`pack-registry.ts:173-176`), so a midx hit pays the
owning pack's full `.idx` parse **and** table build today.

**Faithfulness.** None — in-memory strategy. **But** one refusal-shaping constraint is
load-bearing: `internal/pack-shared.ts:15-19` documents that `INVALID_PACK_INDEX` is deliberately
**absent** from `isSkippablePackFault` *because* `nextOffsetForEntry` / `buildOffsetTable` throw
it for mid-read corruption, and folding it in "would turn a detected corruption into a silent
miss after the gate passed". `isSkippableIdxFault` does admit it, at the scan layer. A lazy
successor must preserve that layer split or a corrupt `.idx` becomes a silent `OBJECT_NOT_FOUND`.
The error strings to preserve: `'offset not in pack index: corrupt index'`
(`pack-offset-table.ts:132`), `'next offset exceeds pack file size: corrupt index'`
(`object-resolver.ts:267`), `'slice length ≤ 0: next offset not beyond entry offset'`
(`object-resolver.ts:401`).

**Two more constraints.** (1) `buildOffsetTable` pays an unconditional `ctx.fs.stat(packPath)`
for `packFileSize`/`trailerStart`; a lazy design still owes that stat, and
`test/unit/application/primitives/pack-registry.test.ts:2094-2170` asserts the exact stat call
count across repeated and concurrent calls. (2) `pack-offset-table.ts:130` carries a Stryker
equivalence proof written specifically about `bisectLeft` over a `Float64Array`; replacing the
structure **falsifies** it.

#### F10 — the delta base cache cannot cache OFS bases

The LRU is keyed by hex `ObjectId` (`LruCache<Uint8Array>`, `src/domain/storage/lru-cache.ts`),
probed at `object-resolver.ts:56` / `:422` / `blob-source.ts:89` and populated at `:342`
(`targetId`) and `:432` (REF_DELTA `baseId`). The gap is documented in-source at
`object-resolver.ts:322-326`: mid-chain intermediates have no known ObjectId, so an OFS chain
caches only its tip. Canonical git keys `delta_base_cache` by `(packed_git*, off_t)` for exactly
this reason.

**Fix.** A `(packName, offset) → { type, content }` cache probed in `collectDeltaChain` before
descending and populated per level in the bottom-up apply loop. Storing the `(type, content)`
pair avoids re-`splitHeader` on hits.

**Where it hangs is the load-bearing choice, and this design settles it.** `ctx.deltaCache` is per-**Context**; the pack registry is a
separate `WeakMap<Context, PackRegistry>` (`read-object.ts:15`) with an explicit
`adoptPackRegistry(from, to)` aliasing helper (`:38-40`). Hanging the new cache off the registry
ties it to `refresh()` (correct: a refreshed generation invalidates offsets); hanging it off the
Context keeps it alive across a `refresh()` that invalidated the packs — **which would be a
correctness bug**, because `(packName, offset)` is only meaningful within a generation. So:
**per-registry, cleared by `refresh()`**, sharing the existing byte budget via a second
`LruCache` sized from the same `deltaCacheMaxBytes`. Also note `ctx.deltaCache` is load-bearing as
an *identity anchor* (`load-reftable-stack.ts:91` keys on it; `fsck.ts:76` swaps in
`createNoDeltaCache()`), so it must not be repurposed.

**Budget interaction.** `LruCache.set` **silently drops** an entry larger than `maxSizeBytes`
(`lru-cache.ts:92-94`) and **throws** on `byteSize <= 0` (`:89-91`). Both matter for a cache of
inflated intermediates.

**Oracle.** R12 (`pack-offset-table.bench.ts`, after P0.6's fixture fix) and R13
(`delta-chain-read.bench.ts` cold row). The delta-chain fixture is ~43 deep at
`--depth=50 --window=250` — exactly the shape F10 targets.

---

### P4 — Blame (F2)

**Anchors (verified; two off-by-small corrections).** `findTreeEntry` is
`src/application/primitives/internal/resolve-tree-path.ts:34-50` (`:52-53` is the private
`findEntry`). `readHeadTree` is `read-head-tree.ts:21-32`.

`parseTreeContent` (`src/domain/objects/tree.ts:31-73`) costs, per entry: 3 `subarray`
allocations, 2 `TextDecoder` calls, an `ObjectId.fromRaw` hex string, a `normalizeFileMode`
lookup, a `Set` `has` + `add`, and an object push — for **every** entry, to find one. That is the
`parseTreeContent` 36 % + `fromRaw` 21 % + `bytesToHex` 7 % of the blame profile (over ~14 ticks;
see P0 — the *mechanism* is what justifies the work, the share is not). `findEntry` is a linear
`Array.prototype.find`, so a 1 000-entry directory costs 1 000 string compares per level on top of
the parse.

**The tools already exist and are simply not wired into the descent.** `TreeCursor`
(`src/domain/objects/tree-cursor.ts`) exposes name bytes and oid bytes without decoding
(`compareCursorNames` `:130-147` compares byte-wise with the virtual trailing `/`; `cursorsSame`
`:149-158` compares raw oid bytes; `cursorName`/`cursorOid`/`cursorMode` are the opt-in
materialisers), and `readRawTreeById` is `internal/raw-tree-io.ts:14-18`. Today their consumers
are `flatten-raw.ts`, `walk-raw-subtree.ts`, `raw-subtree-prefetch.ts`, `diff-trees.ts` and
`domain/diff/raw-tree-diff.ts` — none of the path-descent world.

**Fixes, in priority order.**

1. **Byte-scan path resolution.** Rewrite `findTreeEntry`'s descent onto the cursor: compare name
   bytes, compare oids as raw bytes, hex only at the leaf.
2. **Per-level oid short-circuit.** Carry the suspect's `[rootTree, subtree…, blob]` oid chain in
   `Suspect` (`blame.ts:101-107`, today `{ commit, path, blob, blobId, entries }`). A parent whose
   root tree equals the child's is TREESAME with **zero** tree reads; the first equal level stops
   the descent. Today the comparison happens only at the blob leaf (`resolveInParent`, `:358-378`,
   which reaches it via a full `blobTreeEntry` descent at `:367`).
3. **Pre-split lines.** `processSuspect` re-splits the same unchanged blob per generation
   (`blame.ts:258`), and `diffLinesWithBound` re-splits both inputs internally
   (`src/domain/diff/line-diff.ts:363-364` — note this is inside `diffLinesWithBound`, a
   deliberately unexported test seam, not inside `diffLines` at `:342-348`). `LineDiff` **already
   returns** `oursLines`/`theirsLines` (`:16-21`), so the `changed` arm can consume them directly;
   the TREESAME and root arms still need an independent source, so carry a presplit array in
   `Suspect`. `splitLines` returns subarray **views**, so the cost is N object allocations, not
   copies. The same double-split exists at `src/domain/merge/three-way-content.ts:88-89`
   (`base` split twice) — same fix class, in scope if it is free.
4. **Carry the parent's `CommitData`.** `processSuspect` reads the suspect's commit at `:257`;
   `resolveInParent` reads each parent at `:365` for its tree and date; `schedule` (`:404-416`)
   discards it, so the parent re-reads and re-parses when it pops. On a merge commit it is worse
   than 2×. Add the `CommitData` to the scheduled `Suspect`.

F2.3 (loose caching) lands in P2; the 16 MiB cache thrash the review notes should be re-measured
*after* P2+P3, not pre-emptively budgeted away.

**Faithfulness constraints — the sharp one.** `parseTreeContent` throws
`invalidTreeEntry(offset, 'duplicate entry name: …')` (`tree.ts:64-66`). **The raw cursor path
does not**: `flatten-raw.ts`'s `validatedName` checks only `.`, `..` and embedded `/`. Swapping
`findTreeEntry` onto the cursor would therefore *silently drop* the duplicate-name refusal for
`blame`, `read-file-at` and `rev-parse <tree-ish>:<path>`.

**ADR-723 keeps the refusal**, re-implemented in the descent: a per-directory `Set` over the names
of the directory being descended (not the whole tree), throwing the same
`invalidTreeEntry(offset, 'duplicate entry name: …')` with **byte-identical error data**. The
saving this part exists for comes from *not decoding and not hexing*, not from dropping a check —
the `Set` is a cost `parseTreeContent` already pays. Mode validation likewise stays **eager per
visited entry on the descended directory**: `normalizeFileMode` refuses a malformed mode eagerly
for every entry, while `computeIsDir` (`tree-cursor.ts:110-121`) accepts arbitrary-length octal and
refuses lazily at `cursorMode` — so without the explicit eager call a malformed sibling mode would
refuse later, or never.

Because the refusal is preserved rather than diverged, **no interop re-pin is owed** for this
behaviour; the unit + property coverage below is the gate. ADR-723 also records the open question
it deliberately did not answer: whether git itself refuses duplicate entry names outside
`fsck`/`mktree` is **unpinned**, and if a future probe settles it, the divergence option reopens.
Do not assume it here.

**Do not replace `findEntry`'s linear scan with a binary search without the git comparator.** git
sorts as if a directory name carried a trailing `/` (`treeEntryCompare`, `tree.ts:104-126`;
`compareCursorNames`, `tree-cursor.ts:130-147`), and `parseTreeContent` **never verifies sort
order** — so an unsorted-but-currently-accepted tree that `findEntry` resolves today would start
returning `undefined`. `PATH_NOT_IN_TREE` where git finds the file is a faithfulness regression.

**Also:** `blobTreeEntry` (`blame.ts:419-428`) treats `DIRECTORY` and `GITLINK` leaves as absent;
`blame.ts:194-196` encodes a symlink's *target string* as blob content in worktree mode. A
"regular file" fast path would break symlink blame. And `blame.ts:28` imports a **different**
`joinPath` (from `internal/join-working-tree-path.ts`) than `raw-tree-io.ts`'s — same name, two
functions.

**Property-test lens.** `resolve-tree-path` has unit coverage
(`test/unit/application/primitives/internal/resolve-tree-path.test.ts`) but **no property
sibling**. Rewriting it as a byte-level matcher over a tree grammar is lens 2/3 — a
`resolve-tree-path.properties.test.ts` is owed.

**Oracle.** R14 (`test/bench/blame.bench.ts`, whose `DEEP_ANCESTRY_TIERS` already exist to pin
"the O(path-depth) descent + TREESAME skip win"), plus `test/integration/blame-interop.test.ts`
staying byte-identical against `git blame --porcelain`.

---

### P5 — Read policy (F3, F4 — both ratified)

#### F3 — verify-on-read

**Anchors (verified).** `read-object.ts:139` and `:151` are exact. `verifyAndReturn` is
`object-resolver.ts:222-236`; `:56-60` is the **delta-cache-hit call site**, which does re-hash:

```ts
// object-resolver.ts:56-60
const cached = ctx.deltaCache.get(id);
if (cached !== undefined) {
  enforceCachedCap(id, cached, maxBytes);
  return verifyAndReturn(ctx, id, cached, verifyHash);   // re-hashes bytes tsgit itself verified
}
```

There are **five** independent `?? true` defaults, not two: `read-object.ts:139`, `:151`,
`walk-commits.ts:41`, `internal/commit-date-walk.ts:86`, `internal/blob-source.ts:80`. About 51 of
~55 read call sites rely on the default; only four opt out (`fetch.ts:279`,
`internal/fsck/content-validation.ts:78`, `internal/fsck/object-cache.ts:360`,
`object-resolver.ts:430` — the REF_DELTA base, already unverified).

**No ADR decides the default.** ADR-389 *inherits* it — its Context reads "`readObject`/`readBlob`
default `verifyHash` to on", its Decision says "matching `readObject`", and its rejected option 3
is "inconsistent with `readObject`'s default-on". The nearest normative text is a design doc,
`docs/design/primitives.md:399`: "`verifyHash` defaults to `true` (safe-by-default). The hot-path
cost is a single hash over bytes already in memory; profiling showed the overhead < 1 % for
typical workloads" — a claim with **no measurement artifact**, contradicted by the current
profile's `verifyAndReturn` row.

`streamBlob`'s default is ADR-ratified **twice** (ADR-389's Decision and ADR-394's "keeps its
ratified `{ verifyHash }` options surface"), so `blob-source.ts:80` needs a *superseding* ADR;
`read-object.ts:139/151` need only a new one.

**Blast radius if the default flips.** `fsck` is unaffected (already `false`, re-hashes
independently). `verify-pack` / `index-pack` / `cat-file --batch-check` do not exist as commands
here. Two surfaces do change: `bundle verify` (`bundle-verify.ts:147`/`:180` read with no options
and narrow only `OBJECT_NOT_FOUND`) and `catFile` (`cat-file.ts:41-42`). **Pin A shows git
verifies in `bundle verify` and not in `cat-file`** — so the faithful outcome is to flip the
default *and* pass `verifyHash: true` explicitly in `bundle-verify.ts`, which is strictly more
faithful than today on both surfaces.

**Settled: ADR-718 flips all five defaults to `false`** and has `bundle-verify.ts` pass
`verifyHash: true` explicitly — the option survives on every surface, `fsck` and the write path keep
their own independent verification, and the posture now reproduces Pin A's verify/don't-verify
split exactly. ADR-718 supersedes ADR-389's default posture (and its premise that dropping
verification "would weaken faithfulness"); ADR-394's option surface is untouched, and ADR-389's
incremental end-of-stream verification for `streamBlob` is carried forward for callers who opt in.

**The costs, now obligations rather than trade-offs.** Each is scoped work in this part:

| Obligation | Anchor | What lands |
|---|---|---|
| Amend the published security claim | `docs/understand/security.md:92` | verify-on-read stops being a documented property; detection is `fsck` + `bundle verify`. Same commit as the flip |
| Replace the abort poll | `object-resolver.ts:230`, pinned by `docs/design/primitives.md:1229` | the hash-then-compare `checkAborted` disappears with the hash; ADR-718 requires "an explicit poll at the same point". Not a silent deletion |
| Re-prove one equivalence | `internal/fsck/object-cache.ts:359` | its justification text **cites the old default**; the proof is falsified by the flip and must be re-written against the new structure or removed |
| Forestall a newly-equivalent mutant | `fetch.ts:278` | disables only `BooleanLiteral`; under the flipped default the `ObjectLiteral` `{}` mutant on `{ verifyHash: false }` becomes equivalent and will survive un-suppressed. Either the explicit `false` goes (it is now the default) or the proof widens |
| **Invert, never delete, the mutant-killing tests** | `read-object.test.ts:48-71`, `:514-544`; `walk-commits.test.ts:346-350`; `walk-commits-by-date.test.ts:445-448`; plus `blob-source`'s equivalents | these call the read with **no options** precisely to kill the `?? true → false` mutant. Under the flip the surviving mutant is `?? false → true`, so each test inverts: assert that a corrupt object **is served** by default, and add a sibling asserting explicit `verifyHash: true` **does** refuse. Deleting them would silence the mutant, not kill it |
| Pin the two changed surfaces | `bundle-verify.ts:147/180`, `cat-file.ts:41-42` | `bundle verify` gets explicit verification (strictly **more** faithful than today); `catFile` stops verifying (matching Pin A's `cat-file` row). Both get an interop row |

`bundle verify` and `catFile` are the only two commands whose observable behaviour moves; the flip
touches nothing else's results.

#### F4 — commit parsing

**Anchors (verified; one correction).** `parseCommitContent` is `src/domain/objects/commit.ts:46-65`
and `parseRequiredFields` `:67-99`. Five passes: full-buffer `decode()` **including the message**;
`indexOf('\n\n')` + 2 slices; `split('\n')`; per-line `startsWith`/`slice` with
`ObjectIdFactory.from` 40/64-char scans (the `isValidObjectIdHex` 19 % row); then
`parseOptionalHeaderBlock` with a nested continuation loop.

`parseIdentity` is `src/domain/objects/author-identity.ts:10-42`, **not** `:25-39`, and the review's
"two regexes" is wrong: the name/email half uses `lastIndexOf`, and there is exactly one
validating regex (`/^[+-]\d{4}$/`) plus the `split(/\s+/)`.

**A byte-level rewrite must preserve, exactly:** `lastIndexOf` on both brackets with `lastOpen`
searched backwards from `lastClose` (a name containing `<`/`>` parses by the **last** pair);
exactly **one** trailing space stripped from the name (`endsWith(' ') ? slice(0,-1)`, not
`trimEnd()` — `serializeIdentity` emits exactly one space, so this is round-trip-critical);
`.trim()` then `split(/\s+/)` with `parts.length < 2` (so trailing garbage is **accepted**);
`Number()` + `Number.isSafeInteger` (so `"1e3"` → 1000 is accepted, `"1.5"` rejected, negatives
accepted); ASCII-only `\d` in the timezone; and the five distinct `.data.reason` strings with
`line` carrying the **full original line**. `parseIdentity` has a third consumer,
`src/domain/reflog/reflog-format.ts:85`, which relies on it throwing `TsgitError` (never a bare
`Error`).

**Parsed-commit memo.** No memo exists at any level: `ctx.deltaCache` holds bytes only, and
`resolveObject` re-parses on every read. The `headerCache` precedent is
`src/application/primitives/internal/read-commit-graph.ts:81` —
`WeakMap<Context, Map<ObjectId, CommitHeader>>`, capped at 65 536, **FIFO not LRU**, with a
written argument (`:76-80`) that a walk touches each oid roughly once so LRU bookkeeping (~2 MiB
at cap) never repays. **That argument does not transfer**: `headerCache`'s eviction is hazard-free
because a miss re-derives from the already-parsed graph with zero further I/O, whereas a
parsed-commit miss costs a full object read. And `headerCache` is populated only on a graph hit
today (`read-commit-graph.ts:307`) — a graph-absent repo never fills it, which is precisely the
repo shape tsgit produces (until P9's writer exists — see F11).

**Settled (ADR-727): a per-session byte-capped `LruCache<CommitData>`**, consulted by the object
resolver for commits (and tags), populated on parse, sharing the delta-cache byte budget by
fraction. Recency ordering repays here for exactly the reason it does not for `headerCache`; a
*byte* cap is the right axis because message sizes vary by orders of magnitude, which an entry cap
cannot bound. `CommitData` is deep-readonly, so handing the same parsed object to two callers is
safe without copying. Two riders ADR-727 attaches: the size fraction is **A/B-measured, not
picked** (the memo competes with P2's loose-read cache for the same 16 MiB, and demand shifts
before it drops); and "no memo, byte parser only" stays the **recorded fallback** if the
interaction cannot be sized cleanly — the byte parser alone is the larger and simpler win, so a
failed sizing exercise must not take the parser down with it. "Per-session" is P8's token
(ADR-722); until P8 lands the memo is per-Context and re-keys in P8.

**Trusted-oid construction.** `ObjectId.from` (`src/domain/objects/object-id.ts:41-58`) does a
length check plus a per-code-unit `charCodeAt` scan; `fromRaw` does a length check plus
`bytesToHex`. The genuinely hot sites fed tsgit-produced hex are small and enumerable:
`commit.ts:82` (`parent ` slice, in a loop — the highest-traffic site in the codebase),
`commit.ts:77` (`tree ` slice), `tag.ts:94`, and `snapshot/workdir-entry.ts:43` (hex from
`ctx.hash.hashHex`, i.e. tsgit's own output — and an inconsistency, since the parallel write path
`internal/serialize-and-hash.ts:34-36` already uses the cheaper `isOid` + cast).
⚠️ **At `commit.ts:77/82` the length check is not redundant** — a truncated `tree `/`parent ` line
still passes the object's own SHA check. Only the hex-digit *scan* is provably vacuous. Drop the
scan, keep the width test.

Already on the trusted path and **not** worth touching: `tree.ts:61`, `commit-graph.ts:198/247`,
`read-commit-graph.ts:269` (all `fromRaw`), and the pack/midx/index parsers which already cast
directly (`midx.ts:471`, `pack-index.ts:215`, `pack-entry.ts:177`, `index-parser.ts:96/316`).

**Property-test lens.** There is **no** `commit.properties.test.ts` and no property test for
`parseIdentity`. `tag.properties.test.ts` is a ready-made template (round-trip at `numRuns: 200`),
and `test/unit/domain/objects/arbitraries.ts` already exports `arbAuthorIdentity()`,
`arbObjectId(40|64)` and `arbCommitMessage()`. **Trap:** `parse(serialize(x)) ≡ x` over arbitrary
*bytes* is unsound — `decode()` uses a non-fatal `TextDecoder`, so invalid UTF-8 becomes U+FFFD
and the round trip is lossy. Generate a `Commit`, serialize, parse, compare **structurally**.
**Second trap:** `commit.ts:61` conditionally spreads `gpgSignature`, so the key is *absent* when
undefined; `toEqual` cannot see key presence — assert `'gpgSignature' in data`.

**Hash-width note.** `parseCommitContent` takes **no `HashConfig`**; width tolerance comes entirely
from `isValidObjectIdHex` accepting 40 **or** 64. A byte parser must derive width from the line
length, and must not grow a `hashConfig` parameter without a public-API change
(`parseCommitContent` is in `reports/api.json`).

---

### P6 — status / add / index I/O shaping (F7, F13)

Consumes P1's policy for every bound.

**`readIndex` re-parses and re-hashes per call** (`src/application/primitives/read-index.ts:20-58`,
verified): `exists` → `stat` → full `read` → **whole-file `ctx.hash.hashHex(payload)`** →
`parseIndex`, on every `status` and every `add`. Fix: a per-Context cache keyed on
`(size, mtimeMs, mtimeNs, ino)`, following `config-read.ts`'s precedent, invalidated by the
index-lock commit path. This subsumes most of the `validateIndexPath` 4 % row. Keep the
TOCTOU post-check (`bytes.length` re-tested after the read) and the integrity-first ordering
(trailer verified **before** parsing, so malformed payloads cannot leak parser state through error
messages).

**`status`'s lstat fan-out is unbounded** (`src/application/commands/status.ts:202-208`,
verified — `await Promise.all(stage0.map(…))` over every stage-0 entry). It is not actually
parallel: everything funnels through libuv's 4-wide pool, so the JS-side per-call cost dominates.
Fix: an `ioBound` pool from P1, plus F15's `mapStat` rebuild. **Keep `bigint: true`.**

**`add` is fully sequential per file** (`add.ts:253-259`): lstat → read → clean-filter → deflate →
`writeExclusive`. The walk must stay sequential (the ignore stack is stateful, and
`walk-working-tree.properties.test.ts:286-307` asserts the walker's emission order matches a
recursive oracle with an order-sensitive `toEqual` over 100 runs — **parallelising the walk is a
contract change, parallelising its consumption is not**). So: fan `stageFromStat` through an
`ioBound` pool while iterating the walk sequentially; ordering holds because staging is
path-keyed with a sort-at-end and the index is byte-sorted on write; drain the pool on the first
hostile-path throw *before* `lock.commit`.

**`WorkingTreeStatMap` is write-only** — recorded per tracked entry, never read. Delete it, and
with it the `stats` parameter threaded through `scanWorkingTree`/`scanUntracked`.

**F13 — HEAD `FlatTree` rebuilt per status.** `readHeadTree` (`:21-32`) resolves HEAD, reads the
commit and calls `flattenTree` → `flattenRawTree` (`internal/flatten-raw.ts:101-117`) on every
call. `FlatTree` is `{ entries: ReadonlyMap<FilePath, FlatTreeEntry> }` with one entry per **leaf**
(directories are descended, not recorded), capped at `MAX_FLAT_TREE_ENTRIES = 1_000_000`; `joinPath`
(`raw-tree-io.ts:20-22`) concatenates per entry, so deep trees re-concatenate the ancestor prefix
at every level. Callers: `status.ts:171` and `rm.ts:171` (**not** `diff` — the recursive tree diff
walks raw bytes and never flattens). Other `flattenTree` consumers that would also benefit:
`merge.ts:324-326`, `apply-merge-to-worktree.ts:241-243`/`:303-305`, `stash.ts:377`/`:387`,
`internal/clean-work-tree.ts:39`.

**Settled (ADR-726): a Context-scoped byte-capped `LruCache` keyed `(rootTreeOid, maxDepth)`**,
sized from the existing delta-cache budget, with a floor-at-1 byte sizer. **Three traps, each
now discharged by the settled shape.**
(1) A `FlatTree` is built under a specific `maxDepth` resolved from repo config at build time
(`resolveFlattenBounds`, `flatten-raw.ts:67-70`; `core.maxTreeDepth`, default 2048) — keying by oid
alone would alias across a config change. The depth is **in the key**, so correctness across a
`core.maxTreeDepth` change is structural, not an invalidation protocol: no coupling to
`invalidateConfigCache` is added or needed. (2) `LruCache.set` silently drops an entry larger
than the cap and throws on `byteSize <= 0`, so a monorepo HEAD tree could never cache and an
empty tree needs a floor-at-1 sizer (`load-reftable-stack.ts:100-109`'s `stackByteSize` is the
pattern). ADR-726 accepts the over-cap drop as **documented behaviour, not a bug to work around** —
a tree too large to cache simply re-flattens, exactly as today. (3) Gitlinks **are** present in a
`FlatTree` with mode `160000` (`flatten-raw.ts:181-185`) even though `blobTreeEntry` treats them as
absent — `status`/`rm` depend on that; a cached tree must preserve it, and a test asserts it.
Other `flattenTree` consumers may opt in later; this part wires only `status` and `rm`.
Context-scoped becomes session-scoped in P8 (ADR-722), same as P5's commit memo.

**The syscall-budget pins are the real regression surface here**, and they are dense:

| Pin | Location | What it fixes in place |
|---|---|---|
| `add --all` over 3 files ⇒ `fileLstatCounts` `[1,1,1]` | `test/unit/application/commands/add.test.ts:1664-1682` | one lstat per file, not two |
| racy-clean shortcut ⇒ `readCalled === false` | `add.test.ts:438-459` | the stat-clean short-circuit |
| tracked + untracked passes sharing one stat map ⇒ exactly 2 lstats | `status.test.ts:1145-1204` | the two-pass dedup contract |
| path-only untracked walk ⇒ **0** lstats | `status.test.ts:723-744` | lazy stat |
| map hit ⇒ 0 calls, miss ⇒ 1, no map ⇒ 1, `recordSpy` not called on a hit | `compare-working-tree-entry.test.ts:765-852` | the stat-map contract |
| lazy-stat memoisation counts; `lstatsInsidePruned === 0` | `walk-working-tree.test.ts:251-293, 741-765` | pruning |
| exact `realpath`/`open`/`close` counts (~20 `toBe(1|2|4)` sites) | `node-file-system-injected.test.ts` | under every add/status/checkout write |

⚠️ **Concurrent identical `realpath` probes racing `parentRealpathCache` before it populates will
inflate those counts.** The mitigation is a single-flight promise memo — `createPromiseMemo`
already exists (`internal/promise-memo.ts:22-44`, memoises the in-flight promise, self-clears on
rejection) and is already in the pyramid-audit allowlist.

**Deleting `WorkingTreeStatMap` interacts with the pins above** (they name
`createWorkingTreeStatMap` and `recordSpy`). Those tests must be rewritten to assert the same
*counts* through the surviving mechanism, not deleted.

---

### P7 — Checkout / clone (F6, F8)

Consumes P1's policy. Progress semantics settled by ADR-725; quarantine posture by ADR-728.

**F6 — materialisation is sequential.** Verified in
`src/application/primitives/apply-changeset.ts`: the dirty prescan is a plain `for` loop over
`changeset.entries` awaiting `evaluateDirtyPath` (≈`:162-168`), and `applyAllEntries` is a plain
`for` loop awaiting `applyEntry` per entry (≈`:277-300`). `applyChangeset` builds **one**
`LeadingPathScanner` per invocation (`:325`) whose per-directory memo means a deep tree costs one
`lstat` per distinct directory — that memo is exactly what concurrent access can race, so the
scanner needs the same single-flight treatment as `parentRealpathCache`
(`internal/symlinked-leading-path.test.ts:197-244` pins exact **ordered** probe-path and `rm`-target
lists).

Refusals are unaffected: `checkDirty` completes before any write, and its refusal arrays are
sorted with `comparePaths` (git's raw-byte order) after collection, so collection order does not
matter — the prescan can go through an `ioBound` pool unchanged.

The write side needs ordered waves — deletes first, directories before their children — because
`applyEntry` creates parents. `LeadingPathScanner` knows the structure; the changeset's own
`add`/`update`/`delete` split gives the wave boundaries.

**Progress is where the observable change is.** Today:

```ts
ctx.progress.update(CHECKOUT_OP, written + deleted, total, entry.path);
```

`ProgressReporter.update(op, current, total?, text?)` documents `current` as "the count of items
processed so far" and `text` as "sideband-style auxiliary text". **ADR-725 settles it as the shared
completion counter**: `current` stays **strictly monotone** via one counter incremented as each
entry finishes, `total` is unchanged, and `text` carries the path of the entry that just
completed — **in completion order, not changeset order**. The port never promised `text` ordering,
so this is contract-honest rather than a divergence; a consumer that needs changeset order needs
the sequential path, and none is known.

Two things this makes testable rather than hand-waved: `current` must be proved monotone under a
pool (a counter incremented inside each task's completion, never derived from an index), and
`text` must be proved to always name a path that has actually landed on disk — emitting the path
before its write completes would be worse than reordering.
`test/unit/application/commands/checkout.test.ts:1436-1512` counts post-checkout hook invocations
via `runner.calls` snapshots and must stay green; hook invocation counts are unaffected by the
progress change (ADR-725 says so explicitly, and the test is what proves it).

**F8 — clone buffers the whole pack.** `fetch-pack.ts:203-229` concatenates the entire sideband
stream into one `Uint8Array` before trailer verification and indexing; every object then goes
through `inflateSync` (`node-compressor.ts:56-58`) on the main thread.

**Fix, shaped by Pin B and settled by ADR-728.** Stream the sideband body to
`objects/pack/tmp_pack_<random>`, hash the trailer incrementally as bytes arrive, verify, then
rename to `pack-<sha>.pack` and write the sibling `.idx`/`.rev` — which is exactly what git does,
so this is faithfulness-**positive**, and the "a hard kill may leave a `tmp_pack_*` behind" posture
is git's too. Index from disk through the existing `readSlice`.
`FileSystem.writeStream(path, AsyncIterable<Uint8Array>)` already exists on the port;
`atomicRename?` is optional (OPFS omits it), so the rename must fall back to `rename`. On
browser/OPFS this is the difference between competing with the origin quota and not. Clone peak
memory becomes O(window) instead of O(pack) — that is R17's oracle.

**The failure posture, and the pin the implementer still owes.** ADR-728 adopts git's layout
**plus** a best-effort `try/finally` unlink of the temp file on a *handled* failure. Pin B only
covered the hard-kill case (where git leaves the partial file, mode `444`, and so does tsgit).
Whether git also unlinks on a handled failure is **not pinned**, and the ADR makes pinning it an
explicit obligation of this part: kill `git-upload-pack` mid-stream (the *server* side, not the
client) against a real `git clone`, observe whether `tmp_pack_*` survives, and **align tsgit to
whatever that shows** before any interop test claims parity on the failure path. The unlink is
proposed on tidiness grounds, not faithfulness grounds — do not defend it as parity until the
probe says it is.

The unlink must also be genuinely best-effort: `ctx.fs.rm` throws `FILE_NOT_FOUND` when the path is
gone (`ports/file-system.ts:106-107` — it is **not** idempotent), so a cleanup racing a successful
rename must swallow exactly that code and rethrow everything else. A swallowed-everything
`catch {}` is a guardrail violation, not a tidy-up.

**Which stages get a pool here, and from which bucket.** The sideband receive is a single ordered
stream — it takes no pool; its concurrency is 1 by construction, and the incremental trailer hash
rides along it. The pools are: the **dirty prescan** and the **materialisation waves**
(`ioBound` — blocking `lstat`/`open`/`write`, oversubscribed), and the **indexing pass** that
inflates each object out of the quarantined pack via `readSlice` (`cpuBound` — deflate/inflate
dispatched to the libuv threadpool, not oversubscribed). Naming the three separately is the point
of ADR-719's two-bucket taxonomy: they have different limiting resources and today they would all
have taken the same literal.

**The zlib threshold (F15's deferred item) belongs here.** `NodeCompressor` is synchronous inside
an async signature at every entry point — `inflateSync` at `node-compressor.ts:58` (inside
`inflate`, `:56-62`), `deflateSync` `:39`, `deflateRawSync` `:49` — with `createInflate()` used
only for the streaming paths (`:75`, `:106`); the class spans `:21-213`. The port
(`src/ports/compressor.ts`: `deflate` `:14`, `deflateRaw` `:21`, `inflate` `:24`, `streamInflate`
`:44-48`, `createInflateStream` `:55`, `InflateStreamResult` `:1-6`) is already fully async, so no
signature changes. `BrowserCompressor` (`:6-70`) and `MemoryCompressor` (`:5-55`) are already
async via `CompressionStream`/`DecompressionStream`.

Node's **callback** zlib dispatches to the libuv threadpool, so above a size threshold (~16 KiB)
it genuinely overlaps; below it the dispatch overhead dominates. This is the enabler that makes
P6's and P7's pools do anything at all on Node — and its bound comes from P1's `cpuBound`,
i.e. `min(cores, threadpoolWidth)`. The threshold itself is a measured constant, not a derived
one: A/B it at 4, 16 and 64 KiB before fixing a value.

⚠️ `test/unit/application/commands/clone.test.ts:330-357` puts a Proxy over `ctx` and counts
**property reads** after bootstrap (`staleReadsAfterBootstrap === 0`). A mechanical hoist like
`const { fs } = ctx` outside a loop changes that count.

⚠️ `BrowserCompressor` has **no node-side behavioural test** — `browser-adapter.test.ts:24` only
asserts `toBeInstanceOf`. Its real coverage is `test/browser/decompression-stream.spec.ts` under
Playwright across chromium/firefox/webkit. Any compressor change must keep the 16-case shared
contract (`test/unit/ports/compressor.contract.ts`) green for node and memory, and the Playwright
spec green for the browser.

**Oracles.** R16 (a new `test/bench/checkout.bench.ts` — none exists today) and R17
(`tooling/bench-memory.ts` clone workload at two pack sizes).

---

### P8 — Structural (F9, F14)

#### F9 — double containment

Verified. `wrapFsValidator`'s `guard` (`src/repository/wrap-fs-validator.ts:70-78`) rejects any
`..` segment, then prefix-matches against `layoutRootsOf(layout)`, then consults an `allowSet`.
`NodeFileSystem.resolveRead` (`:972-986`) makes the path absolute, **collapses** `..` via `policy.resolve`,
case-folds via `policy.normalizeForCompare`, and prefix-matches the same root set. **Post
ADR-625 (`docs/adr/625-git-parity-containment-posture.md`) the read path is lexical and
syscall-free**, so on reads the two layers now perform the same class of check on the same roots
with zero syscalls each. On **writes** they are genuinely different — the wrapper cannot do the
realpath post-check — so the wrapper is cheap but not redundant there.

⚠️ **ADR number collision in the repo:** `625-git-parity-containment-posture.md` and
`625-one-shared-pack-offset-sort-for-idx-and-rev.md` both exist. Cite by filename.

**Three things make this harder than the review implies.**

1. **There is no provenance signal to skip on.** `composeAdapters`
   (`src/repository/compose-adapters.ts:51-56`) erases it: `fs: overrides.fs ?? fallback.fs`. The
   only opt-out is the repo-wide `opts.unsafeRawAdapters`, which *also* drops
   `wrapTransportValidator` (the SSRF guard), so it cannot serve. A brand on
   `NodeFileSystem`/`MemoryFileSystem`, or a `RuntimeFallback` marking its own `fs` as
   pre-contained, must be **introduced**. `composeAdapters` is the seam
   (`test/unit/repository/compose-adapters.test.ts`).
2. **The error code differs.** Wrapper → `PATHSPEC_OUTSIDE_REPO`; adapters →
   `PERMISSION_DENIED`. Both are in the exhaustive error union with an exhaustiveness guard, and
   `docs/use/errors.md` pins them. Interestingly `docs/understand/security.md:11` already asserts
   the *adapter's* behaviour ("all throw `PERMISSION_DENIED` before any I/O"), so skipping the
   wrapper makes the docs **more** accurate — but it is still an observable flip, ratified as
   **ADR-721**.
3. **`..` semantics diverge.** The wrapper *rejects* any `..` segment (including the Win32 forms
   `'.. '` / `'...'`, `hasDotDotSegment` at `:23-25`); the adapter *collapses* it. So
   `<workDir>/a/../b` is refused today and would be accepted. Arguably more git-faithful, but it
   is a behaviour change.
4. **The `allowSet` is load-bearing in the opposite direction.** `computeConfigScopePaths` admits
   `~/.gitconfig` / `$XDG/git/config` / `/etc/gitconfig` past the wrapper; the adapter then refuses
   them with `PERMISSION_DENIED`, which `readSingleScopeUncached`
   (`config-scoped-read.ts:53-63`) catches alongside `FILE_NOT_FOUND` and returns `[]`. It does
   **not** catch `PATHSPEC_OUTSIDE_REPO`. So removing the wrapper preserves the `[]` outcome — but
   removing only the allowlist while keeping the wrapper breaks config-scope reads. Sequence it.

**Settled (ADR-721): brand the first-party adapters in `composeAdapters` and skip
`wrapFsValidator` on *reads* only.** The write path keeps both layers, because there the wrapper is
not redundant — it cannot do the realpath post-check, and ADR-721 explicitly carries ADR-541's
write-path posture forward unchanged. User-supplied `opts.fs` keeps both layers exactly as today.
ADR-721 supersedes ADR-541 on one narrow point: the premise that the facade wrapper is a
load-bearing *read-path* layer for first-party adapters. Everything else in ADR-541 stands.

The two observable flips are **confined to branded read escapes**, and both are now ratified rather
than proposed: the refusal code becomes the adapter's `PERMISSION_DENIED` (which
`docs/understand/security.md:11` already documents as the behaviour, so the docs get *more*
accurate), and an in-repo `a/../b` read path is collapsed and accepted rather than refused. Point
4's `allowSet` sequencing is preserved verbatim — config-scope reads keep resolving to an empty
scope, never a throw. Sequence the wrapper skip **before** any allowlist change, never the reverse.

**Correctness gate.** ADR-485 records that path containment is a *tsgit security property, not a
git behaviour* — "there is nothing git-observable to diverge from" — so the gate is a
**verdict-identity proof** (a property test over the containment predicate, lens 2), not an interop
test. `test/integration/git-parity-containment-interop.test.ts` (1 416 lines) is nonetheless the
first thing to re-run. `wrap-fs-validator.ts` carries three Stryker equivalence proofs (`:12`,
`:24`) that a predicate restructure invalidates.

**Free rider.** `worktreeFs` (`repository.ts:589-595`) rebuilds a `NodeFileSystem` **and** a
`wrapFsValidator` on **every call**, never memoised — and `deriveWorktreeContext`,
`listWorktrees:159` and `worktree.ts:97/167/316` all call it. Memoising that closure by root-set
touches neither the gate nor the cache keying and is a self-contained win.

#### F14 — Context-identity cache keying

**Corrected count: nine, not seven.** All `WeakMap<Context, …>` keyed literally on `ctx`:

| # | Cache | Declaration |
|---|---|---|
| 1 | config `{parsed, tokens, source}` | `config-read.ts:156` |
| 2 | **per-scope `IniSection[]`** *(missed by the review)* | `config-scoped-read.ts:16-19` |
| 3 | pack registry | `read-object.ts:15` |
| 4 | **promisor in-flight fetches** *(missed by the review)* | `read-object.ts:21` |
| 5 | ref store | `ref-store.ts:221` |
| 6 | loose-oid fanout | `internal/loose-oid-cache.ts:22` |
| 7 | shallow set | `internal/shallow-set.ts:30` |
| 8 | commit-graph layers | `internal/read-commit-graph.ts:52` |
| 9 | commit-graph headers | `internal/read-commit-graph.ts:81` |

**Two workarounds already exist in-tree**, which is the strongest evidence the axis is wrong:
`adoptPackRegistry(from, to)` (`read-object.ts:38-40`) manually re-keys the registry onto a derived
Context (sole caller `fsck.ts:77`), and `load-reftable-stack.ts:91` keys on
`Context['deltaCache']` with a 22-line docstring that is already a complete statement of the
problem:

> Keyed by `ctx.deltaCache` rather than `ctx` itself: every `Context` derived from the same
> `openRepository()`/`createXContext()` call carries the SAME `deltaCache` object by reference
> (it survives every spread-derivation this codebase does …), whereas `ctx` — and even `ctx.fs` —
> does not.

**The seven derivation sites, classified:**

| Site | Form | Dimension changed | Same repository? |
|---|---|---|---|
| `repository.ts:654-665` | construction | — | root |
| `list-worktrees.ts:74-77` `deriveMainContext` | `{ ...ctx, layout: { ...ctx.layout, gitDir } }` | **gitDir** | different admin dir → must re-key. **Not frozen** — the only unfrozen derivation |
| `internal/worktree-context.ts:36-55` | freeze; new `fs`, `layout`, `cwd`; drops promisor/hooks/command | **fs + layout** | different worktree → must re-key |
| `internal/submodule-context.ts:17-39` | freeze; new `layout`, `cwd` | **layout** (`${gitDir}/modules/<name>`) | different repository → must re-key |
| `fsck.ts:76` | `{ ...ctx, deltaCache: createNoDeltaCache() }` | **deltaCache only** | same repository — yet drops every cache *and* the reftable memo |
| `clone.ts:162` | `{ ...ctx, hash, hashConfig }` | **hash algorithm** | same repository — config/ref caches are semantically valid but dropped |
| `bundle-verify.ts:128` | `{ ...ctx, hash, hashConfig }` | **hash algorithm** | same repository — same |

**Settled (ADR-722).** Promote the `deltaCache` trick to an explicit convention: a frozen
`ctx.session` token created at construction and preserved by a `deriveContext(ctx, changes)`
helper — **the only derivation path** — which documents which dimensions require a **fresh** token:
**gitDir/commonDir, the fs root set, and the hash algorithm**. All nine caches re-key onto
`ctx.session`. This closes the "write via a spread Context, read via the original → intermittent
`OBJECT_NOT_FOUND`" family *structurally*, and makes `adoptPackRegistry` (`read-object.ts:38-40`)
unnecessary — **it is removed**, not left as a deprecated alias, since its one caller keeps the
registry by keeping the token.

Mapping the seven derivation sites onto that rule:

| Site | Fresh token? | Why |
|---|---|---|
| `repository.ts:654-665` | n/a (creates it) | root |
| `list-worktrees.ts:74-77` `deriveMainContext` | **fresh** | gitDir changes |
| `internal/worktree-context.ts:36-55` | **fresh** | fs root set **and** layout change |
| `internal/submodule-context.ts:17-39` | **fresh** | different repository |
| `fsck.ts:76` | **keeps it** | same repository; only `deltaCache` is swapped |
| `clone.ts:162` | **keeps it** | same repository — but see the tension below |
| `bundle-verify.ts:128` | **keeps it** | same repository — but see the tension below |

⚠️ **A tension inside ADR-722 the implementer must resolve, not paper over.** The ADR lists **the
hash algorithm** among the dimensions that force a fresh token, *and* names clone's and
bundle-verify's hash adoption among the same-repository derivations that **keep** it. Both cannot
be read literally at once. The reconciliation this design takes: hash algorithm is a fresh-token
dimension **in general**, because oid-keyed caches are meaningless across a digest-width change;
but at these two specific sites the swap happens during bootstrap, **before any hash-dependent
cache is populated**, so keeping the token is sound and is what the ADR's Decision says. That
soundness is an assumption about ordering, and assumptions about ordering rot. **Assert it** — a
test proving no oid-keyed cache holds an entry at the moment `clone.ts:162` / `bundle-verify.ts:128`
derive. If the assertion cannot be made to hold, take a fresh token at those two sites and record
the deviation; do **not** keep the token on the strength of this paragraph.

⚠️ **The one question the token forced into the open, now answered.** `fsck.ts:76` derives
`{ ...ctx, deltaCache: createNoDeltaCache() }`. That swap has *two* effects today: it stops the
audit polluting (and benefiting from) the object-byte cache — clearly intended — **and**, because
`load-reftable-stack.ts:91` keys on `ctx.deltaCache`, it silently gives fsck a fresh
reftable-stack cache too. **ADR-722 decouples them and keeps the session for fsck, isolating only
`deltaCache`.** fsck therefore now *shares* ref/config/graph caches with the opening Context. This
is a stated behaviour change to a verification command, taken deliberately: re-reading the same
`packed-refs` is redundant work, not safer work — fsck's actual integrity guarantee comes from its
own independent re-hash, which is untouched. The implementer must assert the narrowing explicitly
(fsck still gets zero object-byte cache hits; fsck now gets ref-store reuse) rather than letting it
be inferred.

`ConcurrencyLimits` aside, the token is the second thing this change adds to `Context`. Keep it
internal and opaque — an embedder has no reason to construct one, and a public token invites
callers to forge cache identity.

**Immediate win it unlocks.** `listWorktrees` (`list-worktrees.ts:182-193`) builds a fresh Context
per linked worktree (`linkedEntry` → `deriveWorktreeContext`) and calls `getRefStore` twice per
worktree, so N linked worktrees today cost **N+1 fresh ref stores and N+1 `packed-refs` parses**,
plus a fresh `NodeFileSystem` + validator each — and the loop is sequential.

---

### P9 — Maintenance (F11) — full breadth (ADR-724)

**The situation, verified.** tsgit reads commit-graph, midx, `.rev` and bitmaps. It **writes**
`.rev` and nothing else: no commit-graph writer, no midx writer, no bitmap writer, no
gc/repack/prune. `src/application/commands/pack-refs.ts:8` says so in-source — *"tsgit has neither
`gc` nor `prune`"*. `docs/BACKLOG.md:429` parks the family as "largely redundant for a library
embedded next to canonical git", with two carried constraints: any gc **must expire or rewrite an
existing midx**, and **must delete a pack's sibling `.rev` with the pack**. The 28.4 entry states
the exclusion explicitly: "Bitmap / midx / commit-graph writing stay excluded (maintenance-born in
git; the parked gc/repack entry is their home)."

**Why the rationale fails for the headline target.** A browser/OPFS repository has no host git.
Every tsgit-managed repo there accumulates loose objects and unconsolidated packs forever, and the
commit-graph fast path in `commitDateWalk` — the one that makes the date walk concurrent (F12) — is
dead code in practice, because tsgit cannot produce a commit-graph. **ADR-724 ratified the full
answer, above the design's own recommendation**: both tasks ship, explicit-only, in this PR.

#### Anchors (verified with Serena)

| Thing | Anchor | Shape |
|---|---|---|
| in-memory pack builder | `primitives/build-pack.ts:40-53` `buildPack(ctx, { oids })` | returns `{ bytes, sha, objectCount, entries }`. **Non-delta** — every oid becomes a base entry (`:1-12`); serial `for` loop `:42-45`, one `readObject` per oid via `encodeEntry` `:55-67` |
| disk writer | `primitives/internal/write-pack-artifacts.ts:141-163` `writePackArtifacts(ctx, { packDir, packBytes, entries, packSha, promisor })` | writes `.pack` → `.idx` → optional `.promisor` → optional `.rev`, all through `writeExclusive`; one shared `sortPackIndexEntries` |
| `.idx` serializer | `domain/storage/pack-writer.ts:65-163` `serializePackIndex` | **pack-index v2** (magic `0xff744f63` `:107`, version `2` `:108`); refuses digest widths ≠ 20/32 `:70-73` |
| `.rev` serializer | `domain/storage/rev-index.ts:112-143` `serializePackRevIndex` | **rev v1** `:135`, magic `RIDX` `:16`, header 12 `:18`; leaves the trailer zeroed for the caller |
| `.rev` write gate | `write-pack-artifacts.ts:80-83` (`pack.writeReverseIndex`, default `true`), evaluated at `:145` **before any artefact is created** | inherited free by any reuse of `writePackArtifacts` |
| loose enumeration | `primitives/enumerate-objects.ts:23-39` `enumerateObjects(ctx, { includePacks })`; loose half `collectLooseObjectIds :41-53` | **materialised** `Set` → sorted array; walks all 256 `HEX_PREFIXES` with `exists` **then** `readdir` = up to 512 serial fs round trips. Sole caller today: `commands/fsck.ts:79-82` |
| loose membership cache | `primitives/internal/loose-oid-cache.ts:22,32-51,54-57,67-69,76-78` | `WeakMap<Context, Map<prefix, Set<suffix>>>`; **`invalidateLooseOid` is add-only**; `forgetLooseOidPrefix` is the only removal escape hatch |
| single-file delete | `ports/file-system.ts:107` `rm(path)` | **not idempotent** — throws `FILE_NOT_FOUND`. `unlink`/`remove` do **not** exist on the port |
| reachability closure | `primitives/internal/closure-engine.ts:260` `computeClosure(ctx, { wants, not, objects, tier })` | tier `'bitmap' \| 'walk'`, **no engine-side default**; takes **oids, not refs**; materialised `ClosureResult` |
| gc-style roots | `commands/internal/fsck/roots.ts:265-276` `collectRoots` — `addRefRoots :80`, `addReflogRoots :103`, `addIndexRoots :220` | already assembles refs + reflogs + index; but it is **universe-bounded** (needs a pre-built `Set` of every object) — wrong cost shape, reuse the *root collection*, not the walk |
| midx reader / binding | `domain/storage/midx.ts:71,384`; `primitives/internal/midx-source.ts:343` `loadMidxSet`; `internal/midx-binding.ts:68-113` `bindMidx`, `:123-134` `findMidxHit` | an unresolvable `PNAM` entry logs and binds `undefined` (`:95-103`), and `findMidxHit` falls through to the ordinary `.idx` loop — **a partial-coverage midx is already tolerated, no refusal** |
| midx path | `primitives/path-layout.ts:106` `multiPackIndexPath` | `objects/pack/multi-pack-index` (Pin G) |
| **midx writer** | — | **does not exist**, anywhere in `src/` |
| commit-graph reader | `domain/commit/commit-graph.ts` — see the chunk model below | |
| **commit-graph writer** | — | **does not exist in `src/` or `tooling/`.** The only encoder is test-only: `buildCommitGraphBytes` in `test/unit/domain/commit/arbitraries.ts` (`:107`), documented at `:71-73` as existing *because* production never writes the format |
| `gc.*` config | — | **`ParsedConfig` has no `gc` section** (`config-read.ts:41-146`). Adding one follows `pack.writeReverseIndex`'s exact four-site pattern: the interface member, a `mergeGc` beside `mergePack` (`:909-914`), and the type echoes at `:499`, `:1048`, `:1127` |

**The single largest gap is the commit-graph writer**: P9 must *write* a format tsgit has only ever
*read*, and the one reference encoder in the tree is test code, not shippable.

#### Command surface

Explicit-only — **never auto-triggered** (ADR-724). No timer, no threshold check inside `status`,
no write-path hook. A caller decides when maintenance happens.

```ts
export type MaintenanceTask = 'commit-graph' | 'gc';

export interface MaintenanceOptions {
  readonly tasks: ReadonlyArray<MaintenanceTask>;
  readonly auto?: boolean;
}

export interface MaintenanceResult {
  readonly tasksRun: ReadonlyArray<MaintenanceTask>;
  readonly commitGraphWritten: boolean;
  readonly commitsInGraph: number;
  readonly looseObjectsBefore: number;
  readonly looseObjectsPacked: number;
  readonly prunedLooseObjects: number;
  readonly packsBefore: number;
  readonly packsAfter: number;
  readonly packId: ObjectId | undefined;
}
```

Every field is a count, a boolean, an enum or an oid — **no rendered line, no formatted size, no
message** (ADR-249). A caller wanting "packed 6 700 objects into 1 pack" composes it.

Three fields are additions to the sketch ADR-724 endorsed, each forced by the expanded design and
each still a plain scalar: `tasksRun` (the `auto` gate can decline, and the caller must be able to
tell "declined" from "ran and found nothing"), `looseObjectsBefore` (without the denominator
`looseObjectsPacked` is the same unreadable share P0 spent a whole part fixing), and `packId` (the
caller needs a handle on the pack it just created). Nothing was removed from the sketch.

`tasks` is required and non-empty; an unknown task is an `invalidOption('tasks', …)` refusal
mirroring `git maintenance run --task=bogus` → `error: 'bogus' is not a valid task` (Pin D).
`tasksRun` echoes what actually ran, which is how a caller learns the `auto` gate declined —
**not** a `skipped: true` flag, because "ran nothing" and "ran and found nothing to do" are then
distinguishable from the counts.

**`auto` mirrors `git maintenance run --auto`, and this is a deliberate, stated split.** Pin I is
decisive: **explicit `git gc` ignores `gc.auto` entirely** — with `gc.auto=0` it still packed. Only
`--auto` consults the threshold. So `auto: true` applies the `gc.auto` gate (default 6700; `0`
disables every heuristic, Pin D) and `auto` absent/false runs unconditionally, exactly as git
splits the two. ADR-724's sentence "when loose-object count exceeds `gc.auto`" describes the
`auto: true` path.

The gate uses an **exact loose count**, not git's estimator. Pin I records why: git's `--auto`
predicate samples a single fanout directory and its own documentation says "**approximately** more
than this many loose objects", and the exact sampling predicate **could not be reproduced** — no
`gc.auto` value made `--auto` fire at small object counts. An exact count sits inside git's
documented "approximately", is strictly more accurate, and is free because gc-lite enumerates the
loose objects anyway. Stated in the docs page, not inferred.

**Out of `maintenance`'s scope, deliberately** (Pin J): `git gc` also runs `pack-refs`, `reflog
expire` and `worktree prune`. tsgit already ships `packRefs()` as its own Tier-1 command; folding
it in would make one call mutate the ref backend as a side effect. `maintenance` touches
**objects only** — R26 asserts refs, reflogs and the index are byte-identical across the call.

#### Task 1 — `commit-graph`

Byte-identical to `git commit-graph write --reachable` for the same commit set (Pin C, Pin K).

**The chunk model to emit.** Read off tsgit's own parser (`domain/commit/commit-graph.ts`) and
confirmed against real bytes:

| Field | Value | Anchor / pin |
|---|---|---|
| magic | `CGPH` | `:5`; Pin K bytes `4347 5048` |
| version | `1` | `:6`, `SUPPORTED_VERSION` |
| hash version | `1` (SHA-1, 20 B) / `2` (SHA-256, 32 B) | `:86`; Pin K SHA-1 header `…0101 0400`, Pin N SHA-256 header `…0102 0400` |
| chunk count | **4** normally, **5** when any octopus merge is present | Pin K = `04` (OIDF OIDL CDAT GDA2); Pin M = `05` (… + EDGE) |
| base-graph count | `0` (single file, not split) | Pin K/M byte 7 = `00` |
| chunk table | `numChunks+1` rows × 12 B (4-B id + 8-B big-endian offset), terminated by a zero-id row carrying the trailer offset | `readChunkTable :127-158`, `CHUNK_TABLE_ROW_SIZE = 12` `:8` |
| `OIDF` | exactly **1024 B**, 256 big-endian cumulative counts | required + size-validated `:90-91` |
| `OIDL` | `commitCount × hashLength`, **oid-sorted** — this ordering *defines* every position index | required + size-validated `:94-95` |
| `CDAT` | `commitCount × (hashLength + 16)` | required + size-validated `:97-99`; `CDAT_FIXED_SIZE = 16` `:11` |
| `GDA2` | `commitCount × 4` | optional but validated when present `:101-104` |
| `EDGE` | variable, **size unvalidated** by the reader | optional `:106` |
| `BASE` | **not emitted** (`numBaseGraphs = 0`) | `readBaseGraphHashes :177-201` |
| the two changed-path Bloom chunks | **not emitted** — they appear only under `--changed-paths` (Pin C) and tsgit's reader does not parse them | out of scope |
| `GDO2` | **must not be emitted** — see the refusal below | `:307-312` |

**The CDAT entry, byte for byte** (`commitDataAt :242-262`), at
`_commitDataOffset + localPos × (hashLength + 16)`:

```text
[0, hashLength)          root tree oid, raw bytes
[hashLength,   +4)       parent1 position, u32BE — 0x70000000 (NO_PARENT) when absent
[hashLength+4, +4)       parent2 position, u32BE — NO_PARENT, or a plain position,
                         or (0x80000000 | edgeIndex) when >2 parents (OCTOPUS_FLAG)
[hashLength+8, +4)       genWord: (generationV1 << 2) | (committerDate >> 32)
[hashLength+12,+4)       dateWord: committerDate & 0xffffffff
```

The reader's decode is `committerDate = (genWord & 0x3) * 2^32 + dateWord` and
`generationV1 = genWord >>> 2` (`:254-255`) — a **34-bit** committer date and a 30-bit topological
generation. The writer is the exact inverse, and a repository with a committer date ≥ 2³⁴ is the
one input that cannot be encoded; refuse it rather than truncate.

`generationV1` is the topological level: `0` for a root commit, `1 + max(parents' level)`
otherwise. `GDA2` holds `correctedCommitDate − committerDate` per commit as a u32, where
`correctedCommitDate = max(committerDate, 1 + max(parents' correctedCommitDate))` — the reader
recomposes it as `committerDate + raw` (`resolveGeneration :314`).

**The GDO2 refusal, and the pin it still owes.** When the offset exceeds `0x7fffffff`, git sets
`GENERATION_OVERFLOW_FLAG` and puts the true value in a `GDO2` overflow chunk. tsgit's reader does
**not** parse `GDO2` — it silently degrades to `generationV1` (`:307-312`), and there is no
`CHUNK_ID_GDO2` constant. A writer that emitted `GDO2` would therefore produce a file tsgit itself
reads with reduced fidelity. **The design refuses instead**: if any corrected-date offset would
overflow, the writer throws a typed refusal and writes nothing, leaving any existing graph intact.
⚠️ **git's behaviour in that case is unpinned** — the skew probe failed on git's date parser
(`fatal: invalid date format: 2500-01-01…`) so no overflow file was produced. Before the interop
test claims parity here, the implementer must pin it: build a repo with a corrected-date offset
past 2³¹ (use `GIT_COMMITTER_DATE=@<epoch>` seconds form, which the ISO parser rejected), run
`git commit-graph write --reachable`, and record whether a `GDO2` chunk appears and what
`numChunks` becomes. If git emits `GDO2`, the honest options are to parse it (a reader change) or
to keep the refusal with an ADR line; **do not silently emit a chunk tsgit cannot read.**

**The commit set is refs-only — and that is *not* gc's root set.** Pin O is decisive: a commit
reachable only from a deleted branch's reflog is **absent** from the graph (`rev-list --all` = 1,
graph commit count = 1), while Pin H shows the very same commit **is** packed by `gc`. One command,
two different root sets:

| Task | Roots |
|---|---|
| `commit-graph` | **refs only** (`--reachable`) — Pin O |
| `gc` | refs **+ HEAD + index + reflogs** — Pin H |

Getting this backwards produces a graph git will not reproduce byte-for-byte. Say it in the code's
naming (`commitGraphRoots` vs `retentionRoots`), not in a comment.

**Sourcing the commits.** Resolve every ref through the existing ref store, then walk commits with
`walkCommits` — the one AsyncIterable of the four enumeration surfaces
(`primitives/walk-commits.ts:98-121`). Do **not** reuse fsck's `buildReachableSet`
(`internal/fsck/reachability.ts:152`): it is universe-bounded and requires decoding every object in
the repository first (`fsck.ts:79-82,94`) — O(all objects) before the walk starts, for a task that
needs only commits. ⚠️ Self-reference hazard: `read-commit-graph.ts` short-circuits the graph for
shallow repositories (`:183`) and poisons a corrupt graph for the Context's lifetime (`:313-316`).
The writer must read commit **objects**, never the graph it is about to replace, or it will encode
a stale generation set.

**Where it lands, and how.** `objects/info/commit-graph`. Pin L: git holds
`objects/info/commit-graph.lock` and refuses with `fatal: Unable to create '…commit-graph.lock':
File exists.` + `Another git process seems to be running in this repository, or the lock file may
be stale` when it is present. Use the repo's existing `atomic-write.ts` lock-then-rename helper
against that exact path, so a tsgit write and a concurrent `git commit-graph write` exclude each
other rather than interleaving. The split-chain form
(`objects/info/commit-graphs/{commit-graph-chain, graph-<sha>.graph}`, Pin C) is **not** written —
tsgit reads chains but writes only the single-file form, and `numBaseGraphs = 0` says so on disk.

**Placement.** A pure domain serializer `src/domain/commit/commit-graph-writer.ts`
(`serializeCommitGraph(commits, hashConfig) → Uint8Array`) plus a thin application wrapper that
gathers the commit set and writes the file — the same split `pack-writer.ts` /
`write-pack-artifacts.ts` already uses. The serializer being pure and in the domain is what makes
it 100 %-coverage-testable and property-testable against the existing reader.

#### Task 2 — `gc`-lite

**What it does, in order.** Every step is ordered so that a crash at any point leaves a repository
git still reads:

1. **Count.** `enumerateObjects(ctx, { includePacks: false })` → the loose set.
   `looseObjectsBefore`. If `auto` is set and the count does not exceed `gc.auto`, return with
   `tasksRun` omitting `'gc'`.
2. **Partition by reachability.** Collect retention roots as gc does — refs + HEAD + index +
   reflogs (Pin H); `internal/fsck/roots.ts`'s three collectors are the reusable half. Feed the
   root oids to `computeClosure(ctx, { wants: roots, not: [], objects: true, tier })` and intersect
   with the loose set. **Reachable loose** is what gets packed.
3. **Build.** `buildPack(ctx, { oids: reachableLoose })` → bytes + entries.
4. **Write.** `writePackArtifacts(ctx, { packDir: packsDir(commonGitDir(ctx)), … })` — `.pack`,
   `.idx`, and `.rev` **if `pack.writeReverseIndex` allows** (the gate at `:80-83,145` is inherited,
   not re-implemented). `packId` is the pack sha.
5. **Refresh, then verify.** `refreshPackRegistry(ctx)`, then read **every** oid just packed back
   out of the new pack with **`verifyHash: true` passed explicitly**. This is the one place in the
   codebase that must opt back in after ADR-718's flip: gc-lite is about to delete the only other
   copy, so "trust the bytes" is exactly wrong here. R24 hangs on this step.
6. **Prune.** Only now unlink the loose files, via `ctx.fs.rm`. Unlink the objects that went into
   the new pack, **plus** any loose object that was already present in an existing pack — git's
   `count-objects -v` names that second class `prune-packable` and `repack -d` removes it.
   `prunedLooseObjects` counts the unlinks and may exceed `looseObjectsPacked` for exactly that
   reason; the two fields are separate so the difference is visible rather than silent.
7. **Invalidate.** `forgetLooseOidPrefix` for every fanout prefix touched — see §0.1. The
   loose-oid cache's stated invariant ("tsgit never prunes loose objects",
   `loose-oid-cache.ts:13-15,:61`) is falsified by this step and its prose must be rewritten in the
   same commit.

**How unreachable loose objects are treated — stated explicitly, and pinned.** They are **never
packed and never pruned.** They stay exactly where they are, at their existing paths, with their
existing `mtime` values, for as long as the repository lives. gc-lite deletes nothing on age and
has no notion of an expiry.

Pin E is what makes this a *choice* rather than an oversight, and it is worth being blunt about:
git 2.55's **default** `gc` does something tsgit cannot reproduce. It moves an unreachable, recent
loose object into a **cruft pack** — a `.pack` with an **mtime sidecar** recording each object's
`mtime` — and deletes it on a later gc once it ages past `gc.pruneExpire` (2 weeks). **tsgit
neither reads nor writes that sidecar.** With `gc.cruftPacks=false` git instead leaves that object loose and
alive (Pin E, row 5) — which is precisely the state gc-lite produces. So gc-lite's output matches a
**configured** git, not a default one, and the difference is entirely in the unreachable direction:

| Object class | git default `gc` | git `gc.cruftPacks=false` | tsgit gc-lite |
|---|---|---|---|
| reachable loose | packed | packed | **packed** |
| unreachable loose, recent | → cruft pack (mtime sidecar) | stays loose | **stays loose** |
| unreachable loose, > 2 weeks | **deleted** | **deleted** † | **stays loose** |
| loose already in a pack (`prune-packable`) ‡ | removed | removed | **removed** |

† The default-`gc` deletion is pinned directly (Pin E, row 3: an unreachable blob with its mtime
forced to 2020 was gone after `git gc`). The `gc.cruftPacks=false` cell of that row is **not**
directly pinned — it follows from `gc.pruneExpire`'s documented `prune --expire 2.weeks.ago`. It
changes nothing in the tsgit column, which deletes in neither case, so nothing in this design rests
on it; pin it if DC-17 lands as (b) or (c).

‡ Also documented rather than separately pinned: `git count-objects -v` reports this class as
`prune-packable` (it read `0` in every probe above, because no probe created the case), and
`repack -d` is what removes it. Pin it in the implementing change — it is the one row where
tsgit *does* delete something, so it is the row that most deserves a pin.

tsgit is strictly *more* conservative than git in every row: it never deletes an object git would
keep, and it keeps objects git would delete. Nothing is lost; a repo maintained only by tsgit
retains unreachable garbage indefinitely. **This is the open question DC-17 carries** — see
Decision candidates. The design above is DC-17(a).

**Why gc-lite does not consolidate existing packs, and what changes if DC-17 says it must.**
`buildPack` is **delta-free** — `build-pack.ts:1-12` is explicit that every oid becomes a base
entry. Reading an existing pack's delta chains and re-emitting them as full base entries would
**inflate** the repository, possibly several times over: a "gc" that makes the repository bigger
is the opposite of gc. So under DC-17(a) no existing pack is read, rewritten or removed, and three consequences
follow that must be asserted rather than assumed:

- **`packsAfter = packsBefore + 1`** on a run that packs anything, and `= packsBefore` otherwise.
  The pair is thin under (a); it becomes informative only under (b).
- **The two carried backlog constraints are discharged structurally.** No pack is removed, so no
  `.rev` can be orphaned (Pin F's rule never fires). The midx is left in place, which is exactly
  what `git repack -d` does when a *new* pack appears — Pin G row 2: the midx survives, `git fsck`
  is silent at exit 0, and reads still work. Git deletes the midx only when it removes the packs
  the midx names (Pin G row 1), which gc-lite never does. tsgit's `bindMidx` already tolerates the
  partial-coverage case without a refusal (`midx-binding.ts:89-103,123-134`). **A test must assert
  both**, so that a later change to (b) fails loudly instead of orphaning artefacts.
- **No bitmap is written.** Pin F: git's default gc writes only `.idx`/`.pack`/`.rev`; `.bitmap`
  needs `repack.writeBitmaps=true`. Writing none matches the default exactly.

If DC-17 lands as **(b)** (consolidate like `git repack -A -d` with cruft packs off), the delta
below is added to this part and nothing above is removed: a delta-capable pack writer or an
accepted size regression; loosening unreachable objects out of superseded packs before deleting
them; deleting each superseded pack together with its `.idx`, `.rev`, `.bitmap` and `.promisor`
siblings (Pin F); and **deleting `objects/pack/multi-pack-index`** when any pack it names is
removed (Pin G row 1) — deletion being the only option, since no midx writer exists.

**Crash safety.** The ordering above is the safety argument, and it is the same one Pin B gives for
clone: nothing is deleted until its replacement is present, verified and readable. A crash after
step 4 leaves a valid extra pack whose objects are also still loose — redundant, not corrupt, and
the next run cleans it up as `prune-packable`. A crash mid-step-6 leaves a partially pruned loose
set, all of whose objects are in the pack. `ctx.fs.rm` throwing `FILE_NOT_FOUND` on an
already-gone path (`ports/file-system.ts:106-107`) must be tolerated **by code, not by a bare
catch**: narrow to that one code and rethrow the rest. `writeExclusive`'s contract already
anticipates a concurrent pruner (`ports/file-system.ts:66-79` — "if the parent is removed between
the implicit mkdir and the open (e.g. concurrent `git gc` prunes the fanout), the adapter retries
once"), so a host git running against the same repository is a supported concurrency, not an
excluded one.

**Cost shape, and where P1's policy applies.** `collectLooseObjectIds` is 512 serial fs round trips
(`exists` then `readdir` per prefix) — the enumeration goes through P1's **`ioBound`** pool, which
is the single largest win available in this task and the reason P9 sits after P1. `buildPack`'s
per-oid `readObject` + deflate loop is `cpuBound`. Neither pool is invented here; both come from
`limitFor(ctx, …)`.

**Config.** Adding `gc.auto` means adding the first `gc` section to `ParsedConfig`. Follow
`pack.writeReverseIndex` exactly — interface member near `config-read.ts:114`, a `mergeGc` beside
`mergePack` (`:909-914`), type echoes at `:499`, `:1048`, `:1127` — and validate it through the
same `assertValidBooleanConfig`-style eager path so a malformed `gc.auto` refuses like every other
malformed key rather than silently defaulting.

#### Surface gates — the full Tier-1 checklist

Budget every row; `npm run validate` catches only some of them, and `reports/api.json` is a
**prepush** gate that it does not catch at all.

| # | Gate | Exact anchor | What lands |
|---|---|---|---|
| 1 | command barrel | `src/application/commands/index.ts` (`packRefs` at `:222` is the pattern) | `export { type MaintenanceOptions, type MaintenanceResult, type MaintenanceTask, maintenance } from './maintenance.js';`, alphabetically placed |
| 2 | public barrel | `src/index.ts:3` | nothing — it is a single `export * from './application/commands/index.js'` wildcard; **no per-command line exists**, so do not add one |
| 3 | facade interface | `src/repository.ts` (`packRefs` at `:380`) | `readonly maintenance: BindCtx<typeof commands.maintenance>;`, alphabetical |
| 4 | facade impl | `src/repository.ts` (`packRefs` at `:797-800`, `packObjects` at `:793-796`) | the **options-taking** arrow shape (like `packObjects`), not the no-arg shape |
| 5 | binding-integrity key list | `test/unit/repository/repository.test.ts:249-…` (array), assertion `:248`, `it` at `:242` | add `'maintenance'` in sorted position — this test asserts `Object.keys(sut)` **exactly** |
| 6 | docs page | `docs/use/commands/maintenance.md` + the index row | both tasks, the `auto` semantics, the exact-count note, and the unreachable-object table above |
| 7 | parity scenario | `test/parity/scenarios/maintenance.scenario.ts`; registered in `test/parity/scenarios/index.ts` (import ≈`:24`, array entry ≈`:93`) | runs on node **and** memory adapters (`test/parity/{node,memory}.test.ts`) |
| 8 | README count | `README.md:47` — "**46** Tier-1 commands · 20+ AsyncIterable primitives · …" | 46 → **47** |
| 9 | `reports/api.json` | prepush gate | `npm run docs:json`, committed **in this part** |
| 10 | size budgets | `.size-limit.json` | a new command in the full-library row; measure, do not assume headroom |
| 11 | pyramid budgets | `test-pyramid-budgets.json` | new test files shift the tier counts |

#### Faithfulness pins this part owes

Every row becomes a case in a new `test/integration/maintenance-interop.test.ts`, spawning real git
2.55.0 with `GIT_*` scrubbed, `HOME` isolated and signing off, sharing one `beforeAll` repo with a
60 s timeout:

| Pin | Assertion |
|---|---|
| commit-graph byte identity | tsgit's `objects/info/commit-graph` `≡` `git commit-graph write --reachable`, byte-for-byte, on a linear history, a repo with merges, and a repo with an **octopus** merge (Pin M: `numChunks` 4 → 5, `EDGE` present) |
| commit-graph, SHA-256 | same, in a `--object-format=sha256` repo; header hash version `2` (Pin N) |
| commit-graph accepted by git | `git commit-graph verify` on tsgit's file → silent, exit 0 |
| commit-graph root set | a commit reachable only from a reflog is **absent** from tsgit's graph, as it is from git's (Pin O) |
| gc-lite reachable direction | after tsgit gc-lite, `git fsck` silent exit 0; `git count-objects -v` `count`/`in-pack` split matches the equivalent `git -c gc.cruftPacks=false gc --prune=never` run |
| gc-lite unreachable direction | an unreachable recent loose object is byte-identical and at the same path after the call (Pin E row 5 is the git-side comparison) |
| gc-lite retention roots | an index-only blob and a reflog-only commit both survive and are **packed** (Pin H) |
| no ref mutation | `packed-refs`, every loose ref file and every reflog byte-identical across the call (Pin J is the contrast: git's `gc` **does** pack refs) |
| artefact siblings | the new pack carries `.idx` and `.rev`; no `.bitmap`, no mtime sidecar (Pin F) |
| midx survival | a pre-existing `objects/pack/multi-pack-index` is untouched and still readable by git afterwards (Pin G row 2) |

Parity scenarios prove cross-adapter consistency only; **none of the above is provable by a parity
test**. Interop is the only faithfulness proof.

#### Oracles

- **R22–R26** above.
- A new `test/bench/maintenance.bench.ts` with two scenarios: commit-graph write over
  `MEDIUM_FIXTURE_WITH_COMMIT_GRAPH`'s commit count, and gc-lite over a fixture seeded with a few
  thousand loose objects. Absolute wall-clock only, through P0.5's driver.
- The **transitive** oracle, and the reason this part pays for itself: after a `commit-graph` run
  on a tsgit-created repo, `test/bench/log.bench.ts` must show the commit-graph fast path engaging
  — F12's prefetcher stops being dead code. Measure it; do not assert it in prose.

---

## Review corrections

Recorded so the corrections do not have to be re-derived:

| Review claim | Correction |
|---|---|
| `gatherByRevIndex` at `src/domain/storage/pack-positions.ts:60-72` | No such file. It is `src/application/primitives/internal/pack-positions.ts:60-72`. |
| `repo-state.ts:116-126` | The `commands/internal/repo-state.ts` path is a deprecated 8-line shim; the source is `src/application/primitives/internal/repo-state.ts` (line numbers correct). |
| `commit-date-walk.ts:119-159` | `src/application/primitives/internal/commit-date-walk.ts`; `enqueueParents` `:132-138`, `enqueueCommit` `:140-159`. |
| `read-commit-graph.ts:81` | `src/application/primitives/internal/read-commit-graph.ts:81`. |
| `verifyAndReturn` at `object-resolver.ts:56-60` | `:56-60` is the cache-hit **call site**; the function is `:222-236`. The claim (cache hits are re-hashed) is correct. |
| "flip the defaults" (2 sites) | There are **five** `?? true` defaults; `blob-source.ts:80` is ADR-ratified twice and needs a superseding ADR. |
| `parseIdentity` at `author-identity.ts:25-39`, "`.trim()` + two regexes" | `:10-42`; the name/email half uses `lastIndexOf`, and there is one validating regex plus a `split(/\s+/)`. |
| `findTreeEntry` `:34-53` | `:34-50`; `:52-53` is the private `findEntry`. |
| `readHeadTree` `:22-33` | `:21-32`. |
| `diffLines` re-splits at `line-diff.ts:363-364` | Correct lines, but they are inside `diffLinesWithBound` (an unexported test seam), not `diffLines` (`:342-348`). `LineDiff` already returns both split arrays. |
| "seven Context-identity caches" | **Nine** — the per-scope config sections cache (`config-scoped-read.ts:16-19`) and the promisor in-flight map (`read-object.ts:21`) were missed. |
| "`list-worktrees.ts:74-77` builds a fresh spread per call" | `deriveMainContext` runs once per `listWorktrees` call; the per-worktree churn comes from `linkedEntry` → `deriveWorktreeContext` (`:155`), which is worse — N+1 ref stores and a fresh `NodeFileSystem` + validator per worktree, in a sequential loop. |
| "keep the eager table for bulk paths (fsck, bitmap tier)" | Those paths already use a **different** memo (`packPositions()`) and `packPositionMap` directly. `offsetTable()` has exactly two consumers, both single-entry. |
| "`add` profile partly measures `openRepository`" | Correct, and stronger: the `SETUP_FRAMES` subtraction is inert (all `setupShares` empty) while transitive open frames dominate `hotShares`. |
| `medium-commit-graph` unused | True for the **profiler**; `test/bench/log.bench.ts:39` and `tooling/bench-memory.ts` do use it. |
| Profile share magnitudes (`pack-read` 43/43/14 etc.) | Under-sampled: several commands' whole share vectors rest on 2–16 ticks. See P0. Mechanisms stand; magnitudes do not. |

---

## Decision candidates

**DC-1 … DC-16 are all settled — see ADRs 718–730.** The table is retained verbatim as the
historical record of what was weighed, with a **Settled** column carrying each outcome. The
designer decided none of them. **DC-17 is new, arrived with the P9 expansion, and is
unsettled** — it is the only open question in this document.

**ADRs authored.** Thirteen, numbered **718–730** (`docs/adr/` held 727 files, highest 717, when
this design was first written). The mapping is one ADR per load-bearing decision, with the
concurrency seam's four sub-shapes collapsed into one:

| ADR | Covers | Outcome | Supersedes / refines |
|---|---|---|---|
| **718** — read-path hash verification is opt-in | DC-1 | **user-ratified (a)** — all five defaults flip; `bundle-verify` opts in explicitly | **supersedes ADR-389** (default posture and its consistency premise only); ADR-394's option surface unchanged |
| **719** — concurrency limits derive from the limiting resource | DC-5, DC-6, DC-7, DC-8 | **user-ratified composite**, exactly as recommended: `Context.concurrency`, two buckets, `min(cores, threadpoolWidth)` + integrator note, internal type / public `parallelism` override | — |
| **720** — pack successor lookup is lazy and `.rev`-first | DC-4 | **user-ratified (c)** — threshold **retired** | refines `625-one-shared-pack-offset-sort-for-idx-and-rev.md` |
| **721** — first-party read containment is single-authority | DC-9 | **user-ratified (c)** — skip the wrapper on **reads** for branded adapters; writes keep both layers | **supersedes ADR-541** (the wrapper's read-path role only); refines `625-git-parity-containment-posture.md` |
| **722** — caches key on a session token | DC-10 | **user-ratified (a)** — frozen `ctx.session`, `deriveContext`; **fsck keeps the session, isolating only `deltaCache`**; `adoptPackRegistry` removed | — |
| **723** — cursor descent keeps the duplicate-name refusal | DC-11 | **adopted as recommended (a)** — no user judgment; refusal re-implemented in the descent | — |
| **724** — `maintenance` with commit-graph write and gc-lite | DC-2 | **user-ratified (b) — above the recommendation.** The design recommended (a), commit-graph only; the user took the full scope | un-parks `docs/BACKLOG.md:429` |
| **725** — checkout progress text is completion-ordered | DC-3 | **user-ratified (a)** | — |
| **726** — FlatTree cache keys on `(oid, maxDepth)` | DC-12 | **adopted as recommended (a)** | — |
| **727** — parsed-commit memo is a byte-capped LRU | DC-13 | **adopted as recommended (a)**; option (c) recorded as the fallback | — |
| **728** — clone pack quarantine matches git, with tidy unlink | DC-14 | **adopted as recommended (b)**; the handled-failure pin is an explicit implementer obligation | — |
| **729** — perf baseline records tick totals | DC-15 | **adopted as recommended (a)** | refines ADR-652 (the baseline stays ungated) |
| **730** — remediation ships as one PR | DC-16 | **user-ratified (a)** — all ten parts, P9 included | — |

**Two supersessions, both narrow.** ADR-389 → 718 gives up only the *default-on posture* and the
premise that dropping verification weakens faithfulness (Pin A shows that premise is backwards);
the incremental end-of-stream verification mechanism and the `{ verifyHash }` option surface are
carried forward. ADR-541 → 721 gives up only the premise that the facade wrapper is a load-bearing
**read-path** layer for first-party adapters; the root-set containment model, canonical-prefix
derivation and the entire write-path posture are carried forward.

**One deviation from the design's recommendation:** DC-2. The design recommended (a) —
`commit-graph write` alone, on the grounds that gc-lite "is a phase, not a slice". The user chose
(b). P9 above is rewritten to that scope, and DC-17 is the question that scope opened.

**One ADR is arguably owed and deliberately not written yet:** DC-17's outcome. Whichever option
the user takes, it either amends ADR-724's gc-lite scope with the cruft-pack divergence (option a
or b) or expands it (option c). It is left unwritten because the designer does not decide it.

| # | Choice | Alternatives (≤3) | Recommendation | Why | Settled |
|---|---|---|---|---|---|
| **DC-1** | **`verifyHash` default on read** (F3) — the five `?? true` sites | (a) Flip all five to `false`, keep the option, pass `verifyHash: true` explicitly in `bundle-verify.ts`; new ADR for `readObject`/`readRawObject`/the walks, superseding ADR for `streamBlob` (ADR-389/394). (b) Minimum viable: never verify a **delta-cache hit** (one line at `object-resolver.ts:56-60`), leave every default as-is. (c) Keep default-on everywhere. | **(a)** | Pin A shows canonical git serves wrong bytes at exit 0 on `cat-file`, `checkout`, `log`, `rev-list` and `show`, loose **and** packed, and verifies only in `fsck` / `verify-pack` / `bundle verify`. Option (a) reproduces that split exactly — including making `bundle verify` *more* faithful than today. It costs `docs/understand/security.md:92` (a published security claim must be amended), an abort-poll replacement at `object-resolver.ts:230`, inverting four mutant-killing tests, and re-proving two Stryker equivalences. (b) captures ~99 % of profiled `log` reads for one line and no ADR, and is the right answer if the user wants the win without the posture change. (c) leaves the largest single read-path cost on the table and leaves ADR-389's inherited premise ("dropping verification would weaken faithfulness") standing, which Pin A shows is factually backwards. | **(a)** · user-ratified · **ADR-718** (supersedes 389) |
| **DC-2** | **F11 maintenance scope** | (a) `commit-graph write` only, as a Tier-1 `maintenance` command with `{ task: 'commit-graph' }`, never auto-triggered. (b) (a) plus `gc`-lite (loose-count > `gc.auto` → `packObjects` + prune), still explicit-only. (c) Stay parked; keep `docs/BACKLOG.md:429` as-is. | **(a)** | Pin C makes the commit-graph writer byte-pinnable against git and tsgit's reader already covers git's exact default chunk set — so it is assembly of existing subsystems with a hard oracle. It is also the half that pays for itself twice: it un-deadens the commit-graph fast path that F12's prefetcher needs, and it is the piece a browser/OPFS repo cannot get from a host git. (b) is the honest full answer to the parked entry but drags in midx expiry, `.rev` sibling deletion and pack-lifecycle interop — a phase, not a slice. (c) is defensible for the Node-next-to-git case and indefensible for the browser case, which is the headline target. **This is a product-scope decision; the user owns it.** | **(b)** · user-ratified **above the recommendation** · **ADR-724** |
| **DC-3** | **F6 progress semantics under parallel materialisation** | (a) Shared completion counter: `current` stays monotone, `text` becomes completion order. (b) Keep `text` in changeset order by buffering and emitting on a sequential drain. (c) Drop `text` entirely for checkout and emit counts only. | **(a)** | `ProgressReporter.update`'s contract documents `current` as "count of items processed so far" and `text` as "sideband-style auxiliary text" — it promises nothing about `text` ordering (git's own checkout progress is a counter, though this design did not pin that). (b) preserves a property nobody promised at the cost of the parallelism the part exists for. (c) is a silent capability removal for consumers rendering a filename. Whichever lands, `checkout.test.ts:1436-1512`'s hook-call snapshots must stay green. | **(a)** · user-ratified · **ADR-725** |
| **DC-4** | **F1 pack posture** | (a) Lazy `.rev`-backed O(log N) successor lookup; keep the memoised table as the no-`.rev` fallback, built straight into a `Float64Array`. (b) Keep eager tables, only drop the boxed `number[]` intermediate. (c) (a) plus retire `REV_INDEX_MIN_OBJECTS` entirely (always prefer a present `.rev`). | **(c)** | The threshold's own docstring justifies it with a *gather-vs-sort* crossover table that the lazy scheme makes irrelevant — under (a) a present `.rev` is a bounded read plus O(log N), never an O(N) build, so there is no crossover left to protect. Verification found that the eager table has **no bulk consumer** (`packPositions()` and `packPositionMap` serve fsck and the bitmap tier independently), which removes the review's main caveat. (b) is the safe subset and still leaves a full O(N) build per pack per cold open. Whichever lands, the layer split around `INVALID_PACK_INDEX` (`internal/pack-shared.ts:15-19`) must survive, or a corrupt `.idx` becomes a silent miss. | **(c)** · user-ratified · **ADR-720** (threshold retired) |
| **DC-5** | **Where the concurrency policy lives** | (a) New optional `Context.concurrency?: ConcurrencyLimits`, filled by the composition root from adapter-supplied facts. (b) New `RepositoryLayout.concurrency` field (the ADR-034 `homeDir` / ADR-687 ref-backend precedent: shim reads the platform, layout carries the resolved scalar). (c) Widen `RepositoryConfig.parallelism` to `number \| { cpu?: number; io?: number }` (the ADR-267 precedent) and compute the default at `openRepository`. | **(a)** | The value is a *capability of the host*, not a property of the repository layout (b) and not user configuration (c). (a) reads naturally at the ~12 consumption sites (`ctx.concurrency`), is optional so the 215 Context-constructing tests are untouched, and mirrors how `hooks`/`command`/`env`/`ssh`/`promisor` already ride. (b) is the closest existing precedent for a platform-derived scalar and is cheaper (no new port type), but `RepositoryLayout` is about *where the repository is*, and overloading it invites the next platform fact to land there too. (c) keeps the user override in the right place and should ride **alongside** whichever wins — the caller's explicit number must always beat the derived one. | **(a)** · user-ratified · **ADR-719** |
| **DC-6** | **Stage taxonomy granularity** | (a) Two buckets: `cpuBound` / `ioBound`. (b) Named stages (`objectRead`, `objectInflate`, `fileStat`, `fileWrite`, `workTreeHash`) each mapping to a bucket + multiplier. (c) One number, as today, but derived. | **(a)** | Two buckets is the smallest thing that expresses the actual physics (the libuv pool ceiling vs the oversubscription that only makes sense when work blocks), and every one of the 12 existing sites classifies cleanly into one of them. (b) is more precise on paper but the multipliers would be invented, not measured — and inventing five numbers is the failure mode the requirement exists to prevent. (c) cannot express that an lstat pool wants oversubscription and a deflate pool does not. Start at (a); promote a stage to its own row only when an A/B shows the bucket is wrong for it. | **(a)** · user-ratified · **ADR-719** |
| **DC-7** | **The Node CPU bound** — `os.availableParallelism()` reports 11 here, but async zlib/crypto queue on the 4-wide libuv pool | (a) `cpuBound = min(cores, threadpoolWidth)`, reading `UV_THREADPOOL_SIZE` (default 4). (b) `cpuBound = cores`, ignoring the threadpool. (c) (a), plus a documented note telling integrators to raise `UV_THREADPOOL_SIZE` before importing tsgit, and never setting it ourselves. | **(c)** | (b) queues 11 deflates onto a 4-slot pool: the extra 7 add latency and memory, not throughput. (a) is correct but leaves the ceiling invisible to the one party that can raise it — the embedding application, which must set `UV_THREADPOOL_SIZE` **before the first threadpool use**. A library must never set it: mutating `process.env` is hostile and, past first use, inert. (c) is (a) with the knowledge written down where an integrator will find it. Note the reading is Node-only: Deno and Bun accept the variable but are reported not to honour it (they do not use libuv) — **unpinned; verify before the derivation trusts it on those runtimes**, and until then treat a non-Node runtime as "threadpool width unknown" and take the floor. | **(c)** · user-ratified · **ADR-719** |
| **DC-8** | **Is `ConcurrencyLimits` public?** | (a) Internal: not re-exported from `src/ports/index.ts`; `Context.concurrency` typed by an unexported interface (the ADR-535 `LayoutProbe` precedent). (b) Public: exported and documented, so an embedder can supply its own. (c) Internal type, public **override** only through `RepositoryConfig` (DC-5c). | **(c)** | (b) widens `reports/api.json` and the size budgets for a type whose sole purpose is to carry two integers, and invites support questions about a shape we want free to change. (a) alone gives an integrator on unusual storage (network FS, spinning disk, a Worker pool) no way to say so. (c) keeps the derivation private and the *knob* public, which is exactly where `parallelism` already sits. | **(c)** · user-ratified · **ADR-719** |
| **DC-9** | **F9 containment single-authority** — the wrapper is now a duplicate on reads | (a) Introduce a first-party provenance brand in `composeAdapters`; skip `wrapFsValidator` for branded adapters; ADR records the `PATHSPEC_OUTSIDE_REPO` → `PERMISSION_DENIED` flip and the `..` reject→collapse change. (b) Keep both layers; only memoise `worktreeFs` and micro-optimise `guard`. (c) Keep the wrapper for **writes** only (where it is not redundant), skip it for reads on branded adapters. | **(c)** | (a) is the clean end state but changes two observable behaviours at once on a security-adjacent surface, and ADR-541 explicitly chose to keep both layers. (b) banks the free rider (`worktreeFs` rebuilds a `NodeFileSystem` **and** a validator on every call, and `listWorktrees` calls it per worktree) with zero surface risk, but leaves the `guard` frame — the top frame of the `merge` profile — in place on every read. (c) targets exactly the layer ADR-625 made redundant, leaves the write path's realpath post-check untouched, and confines the error-code flip to lexical read escapes. All three need the `allowSet` sequencing in P8 respected, or config-scope reads break. | **(c)** · user-ratified · **ADR-721** (supersedes 541) |
| **DC-10** | **F14 cache keying** | (a) Frozen `ctx.session` token + a `deriveContext(ctx, changes)` helper; all nine caches key on `ctx.session`. (b) Formalise the existing trick: key on `ctx.deltaCache`, documented as the identity anchor. (c) Status quo + widen `adoptPackRegistry` into a general `adoptCaches(from, to)` called at each derivation site. | **(a)** | (b) works today only by accident — `fsck.ts:76` replaces `deltaCache` precisely to isolate itself, so the anchor is already overloaded with a second meaning, and any future code that swaps the cache silently drops eight unrelated memos. (c) is the most conservative but puts the burden on every future derivation site to remember, which is how the current bug family started. (a) makes the invariant explicit and reviewable, lets `deriveContext` *document* which dimensions (gitDir/commonDir, fs root set, hash algorithm) force a fresh token, and makes `adoptPackRegistry` unnecessary. The three same-repository derivations (`fsck`, `clone`, `bundle-verify`) then keep their caches — a win as well as a fix, but note it **decouples** two effects `fsck.ts:76` currently gets from one line (no object-byte cache *and*, incidentally, a fresh reftable-stack cache), so the ADR must say which fsck keeps. See P8. | **(a)** · user-ratified · **ADR-722** |
| **DC-11** | **F2's duplicate-entry-name refusal** — the cursor path does not have it | (a) Re-implement the duplicate check in the cursor descent (one `Set` on the path being descended, not on the whole tree). (b) Accept the divergence with an ADR (git itself refuses duplicate names only in `fsck` and `mktree`). (c) Keep `parseTreeContent` for the **final** path segment and use the cursor only for intermediate levels. | **(a)** | The refusal is currently observable from `blame`, `read-file-at` and `rev-parse <tree-ish>:<path>`; dropping it silently is the one thing the prime directive forbids. (a) costs a `Set` over one directory's names, which is what `parseTreeContent` already pays — the saving comes from *not decoding and not hexing*, not from dropping the check. (b) may well be the more git-faithful answer — git is believed to refuse duplicate entry names only in `fsck` and `mktree` — but that is **unpinned**: it needs a probe of `git rev-parse HEAD:<path>`, `git cat-file -p`, and `git checkout` against a hand-built duplicate-name tree, which this design has **not** run. (c) keeps the check where it matters least (the leaf) and drops it where trees are widest. | **(a)** · adopted as recommended · **ADR-723** |
| **DC-12** | **F13 FlatTree cache — key and eviction** | (a) Key `(rootTreeOid, maxDepth)`, byte-capped `LruCache`, Context-scoped, floor-at-1 sizer. (b) Key `rootTreeOid` only, invalidated by `invalidateConfigCache`. (c) FIFO `Map` with an entry cap, following `headerCache`. | **(a)** | `resolveFlattenBounds` reads `core.maxTreeDepth` per call, so a `FlatTree` is only valid under the depth it was built with; (b) aliases across a config change unless every config write invalidates it, which is a second coupling to get wrong. (c)'s justification does not transfer: `headerCache` chose FIFO because a miss re-derives from an already-parsed graph with **zero** I/O, whereas a FlatTree miss re-walks the whole tree — recency ordering does repay here. (a) must also handle `LruCache.set` silently dropping an over-cap entry (a monorepo HEAD tree would never cache) — size the cap from `deltaCacheMaxBytes`, or accept the drop and document it. | **(a)** · adopted as recommended · **ADR-726** |
| **DC-13** | **F4 parsed-commit memo — bound and scope** | (a) Per-Context (per-session after DC-10) byte-capped `LruCache<CommitData>`, sized from a fraction of `deltaCacheMaxBytes`. (b) Entry-capped FIFO `Map`, mirroring `headerCache`'s 65 536. (c) No memo; ship only the byte parser. | **(a)** | A commit's parsed form is small and its miss cost is a full object read plus parse, so recency ordering repays — the opposite of `headerCache`'s situation, whose FIFO rationale explicitly rests on hazard-free re-derivation. A *byte* cap is the right axis because commit message sizes vary by orders of magnitude; an entry cap (b) lets a repo of large messages blow the budget. (c) is the honest fallback if the memo's interaction with `deltaCache`'s existing 16 MiB proves hard to size — the byte parser alone is the larger and simpler win. | **(a)** · adopted as recommended · **ADR-727** |
| **DC-14** | **F8 quarantine failure posture** | (a) Match git exactly: `tmp_pack_<random>` in `objects/pack/`, renamed after trailer verification, no cleanup on hard kill. (b) (a) plus a best-effort `try/finally` unlink on a caught failure. (c) Stream to a `tmp/` sibling directory instead of `objects/pack/`. | **(b)** | Pin B shows git leaves a partial `tmp_pack_*` after `SIGKILL`, so (a) is literally faithful for the un-cleanable case. Whether git also unlinks on a *handled* failure is **not pinned here** — the probe only covered a hard kill — so (b) is proposed on tidiness grounds, not faithfulness grounds, and the implementer should pin the handled-failure case (kill `git-upload-pack` mid-stream rather than the client) before claiming parity. Either way the hard-kill leftover matches git. (c) diverges from git's on-disk layout for no benefit and would confuse a host `git gc` running against the same repository. | **(b)** · adopted as recommended · **ADR-728** |
| **DC-15** | **P0.1 baseline schema change** — `baseline.json` is a committed artifact | (a) Add `ticks` per frame + `totalTicks` per command, and mark under-sampled commands. (b) Keep the schema; record tick totals in a separate `docs/perf/sampling.md`. (c) Keep the schema; raise iterations until every command clears the floor and say so in the commit message. | **(a)** | The whole defect is that a share with no denominator cannot be read; putting the denominator in a sibling document reproduces the problem for the next reader (b). (c) fixes today's artifact but not the next regeneration on a different machine, where the same command may fall under the floor again. (a) is a one-field change to a file nothing gates on, and `tooling/test/unit/profile-digest.test.ts` already pins the shape so the migration is mechanical. | **(a)** · adopted as recommended · **ADR-729** |
| **DC-16** | **Delivery shape** | (a) All ten parts in one PR, sequential commits, decision-gated parts dropped if their decision says no. (b) Split: P0–P4 in one PR, P5–P9 in a second. (c) One PR per part. | **(a)** | The repo's workflow is trunk-based with one PR per run, and the parts share oracles: P0's harness fixes are what make P3/P4/P6/P7's numbers readable, and P1's policy is consumed by P6/P7. Splitting (b) means the second PR re-derives the first's measurement context. (c) multiplies the mutation/validate/nightly cost by ten for a change whose parts are individually small. The risk (a) carries is a large diff for the review phase, mitigated by atomic per-part commits. **If DC-2 adopts F11**, P9 alone is plausibly its own PR — it adds a command surface, not a perf fix. | **(a)** · user-ratified · **ADR-730** |
| **DC-17** 🆕 | **How gc-lite treats unreachable objects** — git 2.55's *default* `gc` writes a **cruft pack** with an mtime sidecar, a format tsgit neither reads nor writes (Pin E) | (a) **Reachable-only, additive**: pack only *reachable* loose objects, prune only those (plus `prune-packable` loose-already-in-a-pack); never touch existing packs; never touch unreachable loose objects; never delete on age. Equivalent to `git -c gc.cruftPacks=false -c gc.pruneExpire=never gc`, restricted to the loose→pack direction. (b) **Consolidating, cruft-free**: `git repack -A -d` with cruft packs off — one new pack of all reachable objects, unreachable objects loosened out of superseded packs first, superseded packs removed with `.idx`/`.rev`/`.bitmap`/`.promisor`, `objects/pack/multi-pack-index` deleted. (c) **Default parity**: (b) plus a cruft-pack writer (mtime sidecar, read **and** write) and `gc.pruneExpire=2.weeks.ago` age-based deletion. | **(a)** | `buildPack` is **delta-free** (`build-pack.ts:1-12`: every oid becomes a base entry). Under (b) gc-lite would read existing packs' delta chains and re-emit them as full base entries — a `gc` that **inflates** the repository, which is the opposite of the point. (b) becomes sane only once a delta-capable pack writer exists, and that is a phase of its own. (a) is strictly more conservative than git in every row of the Pin E table: it never deletes an object git keeps, and it keeps objects git would delete after two weeks — nothing is ever lost, at the cost of unreachable garbage accumulating indefinitely in a tsgit-only repository. (c) is byte-faithful to git's default and is the only option that ever *reclaims* space from unreachable objects, but it adds a whole on-disk format to both the reader and the writer, and its age-based deletion is the one operation in this design that can destroy data. **The cost of (a) is honesty about what it is**: ADR-724's two carried constraints (midx expiry, `.rev` sibling deletion) are then discharged *vacuously* — nothing is removed, so nothing can be orphaned — and `packsBefore`/`packsAfter` only ever differ by one. If that reads as under-delivering against the ratified scope, (b) is the answer and P9 carries the written delta for it. | **NEW — UNSETTLED.** The only open question in this document. |

---

## Test strategy

### Per part

| Part | Unit | Property | Integration / interop | Bench |
|---|---|---|---|---|
| P0 | `tooling/test/unit/profile-digest.test.ts`, `profile-registry.test.ts` updated for the new schema; new tests for the under-sampled marking | — | — | `bench-ab.ts` exercised on a no-op branch |
| P1 | `deriveLimits` matrix (R18): 1 / 2 / 11 / 128 cores × threadpool unset / 1 / 4 / 64, plus both-unknown; adapter fact readers; the consolidated pool helper's ordering + rejection semantics | `deriveLimits` totality over a bounded integer domain (lens 3) | runtime-parity (deno/bun/workerd) must stay green — workerd takes the floor | every re-pointed pool A/B'd, since bound **values** change |
| P2 | gate-verdict memo incl. invalidation on config write; `hasUsableHead` single-read variants (symlinked HEAD, dangling symlink, regular file, absent, EACCES); `enqueueParents` parallel + parent-order rejection; loose-read cache population | — | `max-tree-depth-config-interop`, `config-boolean-interop`, `missing-value-refusal-interop` unchanged; `commit-graph-walk-interop`, `log-interop` unchanged | `log`, `rev-parse`, `status` |
| P3 | lazy successor over `.rev`-present / `.rev`-absent / corrupt-`.rev` / large-offset (MSB) packs; `(pack,offset)` cache probe/populate/refresh-clear; stat-count pins | successor monotonicity over generated pack layouts (lens 3) | `packfile-interop`, `rev-write-interop`, `midx-interop`, `fsck-interop`, `sha256-object-format-interop`, `large-object-pack-interop` | `pack-offset-table`, `delta-chain-read`, `pack-read`, `midx-lookup` |
| P4 | cursor descent (found / missing / gitlink / symlink / duplicate name / malformed mode / unsorted tree); oid-chain short-circuit; presplit reuse | **new** `resolve-tree-path.properties.test.ts` (lens 2/3) | `blame-interop` byte-identical vs `git blame --porcelain`; `tree-interop`, `tree-depth-interop` | `blame` deep-ancestry tiers |
| P5 | **the test-inversion sweep** — `read-object.test.ts:48-71`, `:514-544`, `walk-commits.test.ts:346-350`, `walk-commits-by-date.test.ts:445-448` and the `blob-source` equivalents each flip from "no options ⇒ refuses" to "no options ⇒ **serves** the corrupt bytes", each gaining a sibling proving explicit `verifyHash: true` still refuses (**inverted, never deleted**, or the new `?? false → true` mutant survives); `bundle-verify` explicit verification; `catFile` no longer verifying; the sync delta-cache-hit fast path **still polling for abort**; byte commit parser vs the string parser on a differential corpus; `parseIdentity` edge matrix (last-bracket-pair, one-trailing-space, `1e3`, trailing garbage, negative timestamp, non-ASCII digits); parsed-commit LRU hit / miss / evict / byte-cap / over-cap drop | **new** `commit.properties.test.ts` + `author-identity.properties.test.ts` (round-trip, structural compare, `'gpgSignature' in data`) | `commit-interop`, `commit-message-interop`, `blob-streaming-interop`, `loose-corrupt-precedence-interop`; **new rows** mirroring Pin A — `bundle verify` refuses a corrupt prerequisite, `cat-file` serves corrupt bytes at exit 0 | `log`, `cat-file`, `show` |
| P6 | index cache hit/miss/invalidate keyed on `(size,mtimeMs,mtimeNs,ino)`; every syscall-count pin in the table above re-asserted through the new mechanism; FlatTree cache key incl. `maxDepth`; gitlink preservation | — | `status`/`add` interop suites unchanged; `git-parity-containment-interop` untouched | `status`, `status-dirty`, `add` |
| P7 | wave ordering (deletes → dirs → children); pool drain on first throw before `lock.commit`; `checkDirty` refusal arrays byte-order-identical under a pool; quarantine rename + failure unlink; zlib threshold both sides | — | clone/fetch network interop (`test/integration/network/*`, real `git-http-backend`); `test/browser/decompression-stream.spec.ts` | **new** `checkout.bench.ts`; `clone-small-repo`; `bench-memory` clone workload at two pack sizes |
| P8 | provenance brand in `composeAdapters`; verdict identity between wrapper and adapter over a path corpus; `deriveContext` preserving/renewing the session token per dimension; `listWorktrees` ref-store reuse count | **new** containment verdict-identity property (lens 2, ADR-485 already asks for one) | `git-parity-containment-interop`, `worktree-interop`, `linked-worktree-discovery-interop`, `ownership-trust-gate-interop` | `merge` (the `guard` frame), `status` |
| P9 | **commit-graph writer**: chunk table layout, `numChunks` 4 vs 5 (octopus ⇒ `EDGE`), `OIDF` 1024-byte fanout, oid-sorted `OIDL` positions, `CDAT` field-by-field incl. the `(genWord & 3) << 32 \| dateWord` split, `GDA2` corrected-date offsets, `NO_PARENT` / `OCTOPUS_FLAG` encoding, SHA-1 **and** SHA-256 header, the GDO2-overflow **refusal**, the ≥2³⁴ committer-date refusal, lock-file contention on `commit-graph.lock`, refs-only root set. **gc-lite**: `auto` gate on / off × `gc.auto` 0 / default / exceeded; the reachable-vs-unreachable partition; `prune-packable` unlink; unlink-after-verify ordering (a fault injected between write and prune must leave every object readable); `forgetLooseOidPrefix` called for every touched prefix; `ctx.fs.rm` `FILE_NOT_FOUND` narrowed and every other code rethrown; malformed `gc.auto` refusal; **no** pack / `.rev` / `.bitmap` / midx removed (R24); refs, reflogs and index byte-identical (R26); `MaintenanceResult` carries no rendered text | serializer ↔ parser round-trip for the commit-graph writer over an arbitrary commit DAG — `parseCommitGraphLayer(serializeCommitGraph(dag)) ≡ dag` incl. octopus merges and multi-root DAGs (lens 1); `commit-graph-writer.properties.test.ts`, reusing `test/unit/domain/commit/arbitraries.ts` | **new** `test/integration/maintenance-interop.test.ts` — all ten rows of the "Faithfulness pins this part owes" table: commit-graph byte identity (linear / merge / **octopus**), SHA-256 header, `git commit-graph verify` exit 0, refs-only root set (Pin O), gc-lite `fsck` + `count-objects -v` parity against `git -c gc.cruftPacks=false gc --prune=never`, unreachable-loose survival (Pin E), index-only + reflog-only retention (Pin H), ref/reflog immutability (Pin J), artefact siblings — `.idx`+`.rev`, no `.bitmap`, no mtime sidecar (Pin F), pre-existing midx untouched and still git-readable (Pin G). One shared `beforeAll` repo, 60 s timeout, `GIT_*` scrubbed, `HOME` isolated, signing off | **new** `maintenance.bench.ts`: (1) commit-graph write over `MEDIUM_FIXTURE_WITH_COMMIT_GRAPH`'s commit count; (2) gc-lite over a fixture seeded with a few thousand loose objects, absolute wall-clock through P0.5's driver. Plus the **transitive** oracle — `log.bench.ts` must show the commit-graph fast path engaging on a tsgit-created repo after the write, i.e. F12's prefetcher stops being dead code |

### Cross-cutting

- **Interop is the only faithfulness proof.** Parity tests are cross-adapter and prove nothing
  about git. Every refusal-adjacent change (P3's `INVALID_PACK_INDEX` layering, P5's flip, P7's
  quarantine, P8's containment) and every new on-disk artefact (P9's commit-graph and pack)
  gets an interop pin or an explicit ADR line saying why not.
- **Three pins are owed *by implementers*, not by this design**, and each blocks a parity claim
  until it is run: git's behaviour on a **handled** clone failure (ADR-728 / P7), whether git emits
  a **`GDO2`** chunk under corrected-date overflow (P9 task 1), and — should DC-17 land as (b) or
  (c) — git's exact cruft-pack mtime-sidecar layout. Record each matrix in this document when run.
- **Interop hygiene** (prior-run learnings, all still binding): scrub `GIT_*` when spawning git
  (a husky hook leaks `GIT_DIR`; `-C` does not override it); isolate `HOME`; signing OFF for
  goldens; pin `-c merge.conflictStyle=merge` when comparing conflict bytes; share one
  `beforeAll` repo with a 60 s timeout for git-spawning suites; the per-Context loose-object
  fanout cache is invalidated only by tsgit's own `writeObject`, so a test that writes via real
  git needs a **fresh Context** afterwards.
- **Mutation.** Every equivalence proof this change moves is listed per part
  (`pack-offset-table.ts:130`, `object-resolver.ts:156/169/447/452`, `pack-index.ts:167/238`,
  `wrap-fs-validator.ts:12/24`, `internal/fsck/object-cache.ts:359`, `fetch.ts:278`,
  `bounded-map.ts`, `mapConcurrent`'s two, `binary-heap.ts:54`, `read-commit-graph.ts:147/249/260`).
  Re-prove or remove; never carry forward. Stryker anchors on the **expression** line.
- **Measurement.** Every perf claim is an absolute wall-clock main-vs-branch A/B on this machine
  via P0.5's driver, reported with both absolute columns. Never a self-share delta. The only
  citable number is the CI nightly artifact, and nothing in this document is citable.

---

## Out of scope

- **Changed-path Bloom filters** (the commit-graph's two Bloom chunks) — git's real deep-blame
  accelerator, and the natural follow-on to F11's writer. Not in this change: the reader does not
  parse them today either, so it is a read+write pair, not a rider. They appear only under
  `--changed-paths` (Pin C), so omitting them is what byte-identity with the default write
  *requires*, not a shortfall against it.
- **Cruft packs (the mtime sidecar) and age-based pruning.** git 2.55's default `gc` stores unreachable
  objects in a cruft pack and deletes them past `gc.pruneExpire` (Pin E). tsgit neither reads nor
  writes the mtime sidecar, and P9 adds neither. Consequence, stated plainly: a repository maintained only
  by tsgit **never reclaims space from unreachable objects**. This is DC-17's subject — if the user
  takes option (c), it moves back into scope and stops being a line here.
- **A delta-capable pack writer.** `buildPack` emits base entries only (`build-pack.ts:1-12`).
  Until that changes, gc-lite cannot consolidate existing packs without inflating the repository,
  which is what pins DC-17 to option (a) and keeps `git repack -A -d` parity out of reach.
- **A multi-pack-index writer.** None exists (`src/` has no `serializeMultiPackIndex`). P9's only
  midx verb would be *delete*, and under DC-17(a) it does not even need that — it leaves a
  partial-coverage midx exactly as `git repack -d` does (Pin G).
- **Pack bitmaps.** tsgit reads them and does not write them. git's default `gc` does not write
  them either (`repack.writeBitmaps` is off by default, Pin F), so P9 matches the default without
  doing anything.
- **`git gc`'s non-object work** — `pack-refs`, `reflog expire`, `worktree prune`,
  `incremental-repack` (Pin D lists the full task set; Pin J shows `gc` runs the first three).
  `maintenance` touches objects only. `packRefs()` already exists as its own Tier-1 command;
  reflog expiry and worktree pruning are separate features with their own faithfulness surfaces.
- **Auto-triggered maintenance.** ADR-724 fixes `maintenance` as explicit-only: no timer, no
  threshold check inside `status`, no write-path hook. A scheduler is the embedder's job.
- **Streaming inflate replacing the successor query entirely** (F1's optional follow-on) — it
  moves corrupt-pack refusals to zlib-level errors and needs its own interop re-pinning.
- **`worker_threads` for CPU parallelism.** The libuv threadpool is the ceiling this design works
  within; moving inflate off-thread is a different architecture with its own transferable-buffer
  and lifecycle design.
- **Lazy `openRepository`.** Real (the shim eagerly builds four runners plus two validator
  wrappers), but ADR-635's DC-6 already considered and declined it, and P0.3 removes the
  *measurement* distortion that made it look larger than it is. Revisit with an honest number.
- **`unsafeRawAdapters` semantics.** F9 narrows what the flag governs; a full rethink of the
  flag (it currently controls fs wrapping *and* SSRF wrapping with one boolean) is its own change.
- **Retiring `docs/perf/hot-paths.json`'s gate scoping.** P0.5's driver deliberately bypasses the
  seven-operation filter for local A/B; changing the CI gate's scope is an ADR-501/505
  re-derivation, not a perf fix.
- **The 2026-08-16 review's remediation** (`docs/design/perf-review-remediation.md`, ADR-640 …
  ADR-652). Shipped; upstream context only.
