# Design — perf-review remediation

> Brief: act on the 2026-08-16 structured TypeScript performance review of `main` — three
> user-owned decisions (per-command export surface, mutation job placement, benchmark-snapshot
> cadence) and seven measured work items (stale perf baseline, `ObjectId.from` hex validation,
> `status` GC churn, commit-graph header-cache bound, fsck object-cache bound + bench-memory
> coverage, `tsc` incremental + CI cache, vitest pool/prepush pilot).
> Status: draft → self-reviewed ×3 → accepted

---

## Context

### Where this comes from

The source is a structured perf review of `main@46c6bd1c` run on 2026-08-16, with fresh V8
profiles taken through the repo's own `tooling/profile.ts` child mode. This worktree is cut
from that same commit, so every anchor below was re-verified in place; drift from the brief's
anchors is called out where it exists.

This is a **remediation** change, not a feature: it touches four source files, one tooling
file, three config files, one committed artifact, and — decision-dependent — `package.json`'s
`exports` map and `.github/workflows/ci.yml`. There is no new public command, no new error
code, no new on-disk format. The run has no backlog id (the input is a spec file), so no
`docs/BACKLOG.md` tick is owed unless a decision creates a follow-up.

### Work-item labels

The brief's seven items map to eight labels here, because its item 5 bundles two separable
edits:

| Label | Brief item |
|---|---|
| W1 | regenerate the committed perf baseline |
| W2 | `ObjectId.from` hex validation |
| W3 | `status` allocation churn — investigate, then fix |
| W4 | bound the commit-graph header cache |
| W5 | bound fsck's object cache *(item 5, first half)* |
| W6 | `tsc` incremental + CI cache |
| W7 | bench-memory coverage for both cache bounds *(item 5, second half)* |
| W8 | vitest pool / prepush pilot |

### What constrains it

| Constraint | Source | Effect on this design |
|---|---|---|
| Git-faithfulness is the prime directive | `CLAUDE.md`, ADR-226 | The `ObjectId.from` rewrite must keep the accept/reject set and the `invalidObjectId` error data **byte-identical**. No other item touches a refusal path. |
| Structured output, not cosmetics | ADR-249 | Not engaged — no command surface changes. |
| Coverage 100 % on `src/domain/**`, `src/ports/**`, `src/adapters/{node,memory}/**`, `src/operators/**` | `vitest.config.ts:80-98` | Only `src/domain/objects/object-id.ts` falls inside the gated set. The three application-layer edits are outside coverage but inside Stryker. |
| Mutation budgets | `mutation-budgets.json` | `domain` bucket: break **99**, low/high **100**. `application` bucket: break **95**, low **98**. The new validator lands in `domain` — the strictest bucket. |
| Equivalent-mutant proofs are structure-specific | prior-run learning | `ignore-evaluator.ts` and `object-cache.ts` carry `// Stryker disable next-line … equivalent` proofs written against the **current** data structures. Any rewrite invalidates them; they must be re-proven against the new shape or removed, never carried forward. |
| No suppression directives | `CLAUDE.md` | No `v8 ignore` / `stryker-disable` / `biome-ignore` added. Existing proven-equivalent Stryker directives may be *revised or removed*, not extended without a fresh proof. |
| Size budgets | `.size-limit.json` | Full library 335 kB gzip (at 186.6 kB); browser no-build bundle **160 kB gzip and currently 156.04 kB — 97.5 % consumed**. Any byte added to a module reachable from `src/index.browser.ts` spends from a ~3.96 kB reserve. |
| `check:types` wireit fan-in | `package.json` wireit block | `check:types` is a declared dependency of `build:js`, `test`, `test:unit`, `test:integration`, `test:posix-integration`, `test:win-integration`, `test:parity`, `test:coverage`, `test:mutation`, `test:mutation:pr`, `test:mutation:local`, `test:bench`, `test:perf` — 13 downstream tasks. Anything that speeds `tsc` speeds all of them. |
| CI workflow edits are outside `npm run validate` | — | `validate` never parses `.github/workflows/**`. Verification for those edits is named in **Verification of CI-only edits** under W6. |
| Actions stay on floating major tags | brief constraint, prior learning | `actions/cache@v6`, `actions/setup-node@v7` and friends — no SHA pinning in anything this change adds. |
| Published perf numbers come from the CI nightly bench artifact | brief constraint, prior learning | Local numbers here are labelled **local, dev-machine** and are used for design sizing and revert rules only. No number in this document is a publishable claim. |

### Measurement environment (every local number below)

```text
host        darwin arm64 / Apple M3 Pro / 11 logical cores
node        v22.22.3
typescript  6.0.3
git         2.55.0
tree        tsgit-perf-review-remediation @ 46c6bd1c
```

Reviewer and measurement agents downstream of this design must re-state their own
`node --version` and `git --version` beside any number they report.

---

## Requirements

No requirements artifact exists for this run; the brief is the source. Restated as verifiable
statements — all must hold when this ships.

**Correctness / faithfulness**

- **R1** `ObjectId.from` accepts exactly the strings it accepts today (lowercase hex, length 40
  or 64, nothing else) and, for every rejected input, throws a `TsgitError` whose `data` is
  `{ code: 'INVALID_OBJECT_ID', value: <the input string, unmodified> }` — identical class,
  identical code, identical `value` bytes.
- **R2** `ObjectId.fromRaw`'s existing trusted-path contract (length check, no re-validation)
  is unchanged.
- **R3** Bounding the commit-graph header cache changes no observable result of `commitHeader`
  for any input: eviction re-derives from already-parsed layers and performs no I/O.
- **R4** Bounding fsck's object cache changes no `FsckFinding`, no finding order, and no exit
  code, for any repository — including corrupt, shallow, connectivity-only and
  `unreadable: 'classify'` shapes.
- **R5** Every existing `// Stryker disable next-line … equivalent` comment on a line this
  change rewrites is either re-proven against the new structure (with the proof text updated)
  or removed.

**Artifacts / observability**

- **R6** `docs/perf/baseline.json` and `docs/perf/baseline.md` are regenerated from
  `npm run profile` on the current tree, and name no symbol absent from `src/`.
- **R7** `tooling/bench-memory.ts` gains at least one workload that exercises the commit-graph
  header cache and at least one that exercises the fsck object cache, so both bounds are
  measured by the nightly `bench.yml` artifact rather than asserted.

**Performance (each with an oracle, below)**

- **R8** The hex-validation frame's self-share in the regenerated `log` profile is strictly
  lower than in the pre-change profile taken on the same machine, same fixture, same iteration
  count.
- **R9** The `status` GC tick share on the profiled `status` workload is strictly lower than
  its pre-change value on the same machine/fixture/iterations, **and** the change is attributed
  to a named construct by an allocation profile captured *before* any code edit.
- **R10** Peak `heapUsed` for the fsck memory workload added in R7 is bounded independently of
  total repository blob bytes — demonstrated by two fixture sizes whose blob content differs by
  ≥4× showing sub-linear peak growth.
- **R11** A warm `npm run check:types` (unchanged sources) completes in under half its cold
  time on the measurement host, and a cold run is not slower than today's.
- **R12** Both pilots (vitest pool, prepush worker caps) either show a wall-clock win on
  `npm run test:unit` / `npm run prepush` measured over ≥3 alternating rounds main-vs-branch,
  or are reverted in the same PR. A pilot that ships must not change any test's pass/fail
  verdict.

**Gates**

- **R13** `npm run validate` is green at every commit. `check:size` in particular stays green —
  the browser no-build bundle must remain ≤160 kB gzip.
- **R14** No new public export, so `reports/api.json` is unchanged unless a decision adds one;
  if D1 lands as "build", `reports/api.json`, `.size-limit.json` and `check:exports` all move
  together in that change.
- **R15** No provenance references (phase / ADR / backlog numbers) in source or test code.

---

## Design

### 0. Ordering

The items are not independent. The mandated order is:

```text
W1 regenerate baseline        ← ground truth for W2 and W3 oracles; must be first
   ├── W2 ObjectId.from       (oracle reads the W1 baseline)
   ├── W3 status churn        (investigate → attribute → fix; oracle reads the W1 baseline)
   ├── W4 header-cache bound  ─┐
   └── W5 fsck cache bound    ─┴── W7 bench-memory workloads cover both
W6 tsc incremental + CI cache  (independent; touches config + workflow only)
W8 vitest pool / prepush pilot (last, because it perturbs the test harness that every
                                other item's gate runs through)
```

`W1` first is not a preference: the committed baseline is the only pre-change artifact the
`log` and `status` oracles can compare against, and it is currently stale by four merged
perf PRs.

---

### W1 — Regenerate the committed perf baseline

**Anchors (verified).** `docs/perf/baseline.json` (24.7 kB) and `docs/perf/baseline.md`
(8.8 kB), written by `tooling/profile-baseline.ts` `writeBaseline`, driven by
`tooling/profile.ts` `captureBaseline` (lines 162-176) over the workloads registered in
`tooling/profile-registry.ts` (10 read + 3 write).

**Staleness, pinned.**

```text
$ git log -1 --format='%h %ad %s' --date=short -- docs/perf/baseline.json
35ea4eca 2026-07-13 perf(node-fs): amortise the status:clean containment tax (#231)
```

Four perf-relevant merges have landed since: #255 (raw tree cursor diff), #263 (file-handle
leak), #271 (`.rev` write), #273 (containment relaxation — which *deleted* the containment
functions). Symbol-presence check against current `src/`:

| Symbol named in `baseline.json` | Occurrences in `src/**` today |
|---|---|
| `checkContainment` | 0 |
| `isContainedInEitherRoot` | 0 |
| `containmentVerdict` | 0 |
| `walkInternal` | 0 (the single grep hit is a prose reference inside a `walk-tree.ts` comment) |

The `log` entry currently attributes 0.07 self-share to `checkContainment`, a function that no
longer exists.

**Shape.** Run `npm run profile` (builds `dist-profile/` via `build:profile`, then spawns one
`node --prof` child per registered workload) and commit the two regenerated artifacts. No code
change. `generatedOn` re-stamps to the current machine banner; that field is descriptive, not
a gate.

**Oracle.** The four symbols above appear zero times in the regenerated `baseline.json`; the
`commands` key set still covers all 13 registered workloads.

**Gate interactions.** Neither artifact is read by any `validate` task — `baseline.json` is
written by `profile-baseline.ts` and read by nothing (`hot-paths.json` is read by
`tooling/bench-check.ts`, which runs under `bench:check`, not under `validate`), and
`check:doc-links` runs lychee over `*.md` only. `check:spelling` does cover `docs/**/*.md`:
the regenerated `baseline.md` will contain new frame names lifted from names-preserved code;
any that trip cspell must be added to `cspell.json` in the same change, never suppressed
inline.

**Risk.** `npm run profile` needs the `git` CLI and the cached medium fixture, and spawns 13
profiled children. It is a long single-shot command; it must not run concurrently with any
other CPU-heavy task in the same session or the shares are noise.

---

### W2 — `ObjectId.from` hex validation

**Anchors (verified; the brief said `:4-11`, the actual span is `:4-15`).**

```text
src/domain/objects/object-id.ts:4      const SHA1_HEX_RE   = /^[0-9a-f]{40}$/;
src/domain/objects/object-id.ts:5      const SHA256_HEX_RE = /^[0-9a-f]{64}$/;
src/domain/objects/object-id.ts:10-15  ObjectId.from(hex)  ← the two `.test()` calls
```

**The hot call site (the brief said "per tree/parent oid on the walk" — confirmed, and
located).** `ObjectId.from` has 17 direct call sites, none of them on the commit walk. The hot
one imports under an alias and is therefore invisible to an `ObjectId.from(` grep:

```text
src/domain/objects/commit.ts:22   import { ObjectId as ObjectIdFactory } from './object-id.js';
src/domain/objects/commit.ts:75   const tree = ObjectIdFactory.from(lines[0]!.slice(5));
src/domain/objects/commit.ts:79   parents.push(ObjectIdFactory.from(lines[i]!.slice(7)));
```

`parseCommitContent` → `parseRequiredFields` runs one `ObjectId.from` for the root tree plus
one per parent, for every commit `readObject` decodes. That is the `log` walk's per-oid cost.

**Attribution caveat that W1 must settle.** `src/**` contains **12 distinct
`/^[0-9a-f]{40}$/` literals** (`resolve-oid-prefix.ts:16`, `validators.ts:234`, `tag.ts:94`,
`checkout.ts:63` and `:83`, `notes.ts:32`, `reset.ts:168`, `branch.ts:178`, `rev-parse.ts:59`,
`commit-ish.ts:18`, `validate-commit.ts:29`, `validate-tag.ts:23`,
`parse-bundle-header.ts:14`, `object-id.ts:4`). V8's `--prof` digest keys regular-expression
ticks by **pattern source**, so one `^[0-9a-f]{40}$` line in the digest is the *sum over all
twelve*. The regenerated W1 baseline must therefore be read as "the pattern costs 3.9 %", not
"`object-id.ts` costs 3.9 %". On the `log` workload only `object-id.ts:4` is on the per-oid
path, so the attribution holds *for that workload* — but the caveat is recorded so the oracle
is not over-claimed.

**Fix shape.** Replace the two `.test()` calls with a length check plus a code-unit loop,
inside the same `ObjectId.from`:

- accept iff `hex.length === 40 || hex.length === 64`, and every code unit
  `c = hex.charCodeAt(i)` satisfies `(c >= 48 && c <= 57) || (c >= 97 && c <= 102)`;
- on rejection, `throw invalidObjectId(hex)` — the *same* call, unmoved.

Style rules that bind it: the four code-unit boundaries become named constants (no magic
values), the predicate is a small module-private pure function, early return on the length
mismatch, no nesting past 2. The two regex constants are deleted — they have no other reader
in this file.

**Faithfulness (R1) — pinned empirically, not from memory.** Node v22.22.3:

| Input | `/^[0-9a-f]{40}$/.test` | Code-unit predicate |
|---|---|---|
| 40 × `a` | `true` | `true` |
| 40 × `a` + `\n` | **`false`** — JS `$` admits no trailing newline, unlike Perl/Python | `false` |
| 40 × `a` + `\r` | `false` | `false` |
| 40 × `A` (uppercase) | `false` | `false` |
| 39 × `a` | `false` | `false` |
| 41 × `a` | `false` | `false` |
| `''` | `false` | `false` |
| 64 × `0` | `false` for the SHA-1 pattern, `true` for the SHA-256 pattern — union `true` | `true` |
| 40 × `١` (Arabic-Indic digit) | `false` | `false` |
| 39 × `a` + one astral emoji (2 code units → length 41) | `false` | `false` |

Lone surrogates are the one shape worth stating explicitly: the regex carries no `u` flag, so
it matches on **code units**, and `charCodeAt` reads code units too — a surrogate half returns
`0xD800…0xDFFF`, outside both accepted ranges, so both reject. The replacement is a code-unit
predicate exactly as the regex is.

Differential agreement over 200 000 random strings drawn from
`0-9 a-f A-F space g z \n \r ١ <astral emoji>` at lengths 0-69: **0 mismatches**. That sweep
is dominated by the negative space, which is why the property test in the Test strategy is
generated boundary-first.

`invalidObjectId` itself is untouched — `src/domain/objects/error.ts:50-51`,
`new TsgitError({ code: 'INVALID_OBJECT_ID', value })`. The rewrite must not reformat, trim or
truncate `hex` on its way into that call.

**Oracle (R8).** Re-run `npm run profile log` after the change and compare the
`^[0-9a-f]{40}$` and `^[0-9a-f]{64}$` self-shares against the W1 baseline's `log` entry, same
machine, same `MEDIUM_FIXTURE`, same `READ_ITERATIONS = 100`. Report the absolute share on
both sides, never a ratio alone.

**Gate interactions.**

- *Coverage:* `src/domain/objects/**` is inside the 100 % gate. Every branch of the length
  check and both code-unit ranges need line **and** branch coverage.
- *Mutation:* `domain` bucket, break **99**. A code-unit loop is mutation-dense — each
  comparison yields `EqualityOperator`, `ConditionalExpression` and `ArithmeticOperator`
  mutants. Explicit boundary examples are required (see Test strategy); a property test alone
  will not reliably kill them, because Stryker scores each mutant against whatever inputs that
  run happened to generate.
- *Size:* the loop is a few dozen bytes larger minified than two regex literals. With the
  browser bundle at 156.04 / 160 kB this is comfortably inside the reserve, but `check:size`
  must be **observed** green on the actual built bundle, not assumed.
- *Architecture:* stays inside `src/domain/**` with zero new imports — `check:architecture`
  unaffected.

---

### W3 — `status` allocation churn: investigate, **then** fix

The brief is explicit that no code changes before an allocation profile attributes the churn.
This design honours that: it fixes the **method** and pre-chews the **candidate sites**, and
deliberately does not pre-select the edit.

**The signal (from the review, to be restated by W1).** Fresh `status` profile: 17.5 % of ticks
in GC; hot builtins `MapPrototypeSet` 3.6 % and `ArrayPrototypeJoin` 1.7 %.

**Investigation, step by step.**

1. `npm run profile status` after W1 lands, to restate the GC share on the current tree.
2. Capture an **allocation** profile (not a CPU profile) on the same child workload:
   `tooling/profile-registry.ts` `READ_WORKLOADS.status` → `await repo.status()` over
   `MEDIUM_FIXTURE`, `READ_ITERATIONS = 100`. A CPU profile is the wrong instrument here; use
   an allocation sampling profile (`node --heap-prof`, or the inspector's
   `HeapProfiler.startSampling`) against the same `dist-profile/esm/index.node.js` entry
   `tooling/profile.ts` already loads.
3. Rank allocation sites by bytes allocated. Only then choose the edit.

**Pre-chewed candidate sites** — ranked by how well each explains the two named builtins. The
profile decides; this list only saves the investigator a search.

| Candidate | Anchor | Why it fits |
|---|---|---|
| `ancestorsOf` in the ignore evaluator | `src/application/primitives/internal/ignore-evaluator.ts:81-93` | Called **per walked path** through the closure `buildRepoIgnorePredicate` returns (`:60-77`). Per call it allocates one `segments` array (`path.split('/')`), then per depth level one `segments.slice(0, i)` array **and** one `.join('/')` string. For depth *d* that is `1 + 2(d-1)` allocations, nearly all immediately discarded by the `stackedDirs.has(ancestor)` skip on `:71`. Directly explains `ArrayPrototypeJoin`. |
| The five per-path collections in `status` | `src/application/commands/status.ts:143` (`stage0Map`), `:146-147` (`trackedPaths`), `:199-203` (`deltaMap`), `:242-245` (`stagedKindMap`), `:261-263` (`paths`) | Five `Map`/`Set` structures over the same `FilePath` key space, each sized by the index. Explains `MapPrototypeSet` if the fixture's index is large. |
| The shared stat map | `src/application/primitives/internal/working-tree-stat-map.ts:23-31` | One `samples.set` per stat'd path. Small and deliberate — it *replaced* duplicate `lstat` calls — so unlikely to be the top site; listed for completeness. |
| The duplicate `ancestorsOf` | `src/application/primitives/is-ignored.ts:44-55` | A near-verbatim second copy on the `check-ignore` path, **not** on the `status` path. Relevant only if the fix is extracted into a shared helper. |

**Fix shape, if the profile lands on `ancestorsOf`** — the most likely outcome, stated so the
plan can size the slice, *not* a pre-decision. Replace the split/slice/join triple with an
`indexOf`-driven scan that allocates exactly one string per ancestor:

```ts
let idx = path.indexOf('/');
while (idx !== -1) {
  out.push(path.slice(0, idx));
  idx = path.indexOf('/', idx + 1);
}
```

**Mutation hazard this creates (R5).** `ancestorsOf` at `ignore-evaluator.ts:83` and `:86`, and
its caller at `:63`, `:66`, `:70` and `:74`, carry six `// Stryker disable next-line …
equivalent` proofs written against `segments.length <= 1`, `out: string[] = []` and the
`rules.length > 0` guard. An `indexOf` rewrite deletes the `segments` array entirely, which
**falsifies** the `ConditionalExpression,EqualityOperator,ArrayDeclaration` proof on `:83`
verbatim. Each surviving directive must be re-proven against the new expression or removed and
the mutant killed honestly. The same applies to `is-ignored.ts:46-50` if the helper is shared.

**Oracle (R9).** GC tick share on `npm run profile status`, same machine / fixture /
iterations, before vs after — plus the allocation profile's own top-site bytes for the
attributed construct. Both reported as absolute numbers.

**Exit criterion.** If the allocation profile attributes no meaningful share to any single
construct — i.e. the churn is genuinely diffuse — the honest outcome is *no code change* and a
recorded finding. Choosing that threshold and that behaviour is **D12**, not something this
design settles.

**Gate interactions.** `ignore-evaluator.ts` and `status.ts` sit in the `application` mutation
bucket (break 95 / low 98) and outside the coverage gate. `check:duplicates` (jscpd, threshold
5 %, `minLines: 5`, `minTokens: 50`) already tolerates the two `ancestorsOf` copies; extracting
a shared helper can only improve that number.

---

### W4 — Bound the commit-graph header cache

**Anchors (verified — the brief's `:67` is the `WeakMap` declaration; the unbounded `Map` is
created at `:191-198` and written at `:273`).**

```text
src/application/primitives/internal/read-commit-graph.ts:67       const headerCache = new WeakMap<Context, Map<ObjectId, CommitHeader>>();
src/application/primitives/internal/read-commit-graph.ts:191-198  getHeaderCache(ctx) → `new Map()` on first use
src/application/primitives/internal/read-commit-graph.ts:258-260  read path (cache.get)
src/application/primitives/internal/read-commit-graph.ts:273      write path (cache.set) — never evicts
```

`CommitHeader` (`:36-41`) is `{ rootTree: ObjectId; parents: readonly ObjectId[];
committerDate: number; generation: number }` — small, fixed-shape, dominated by the hex oid
strings.

**Why this is a real bound, not a theoretical one.** The outer `WeakMap` is keyed by `Context`,
so the inner `Map` lives for the whole lifetime of an open repository. A full-history walk on a
large repo inserts one entry per commit in the graph and never drops one.

**Sibling precedent — the shape to match.**

| Cache | Anchor | Sizing |
|---|---|---|
| `deltaCache` | `src/index.node.ts:99-102` | `createLruCache(16 MiB, 65 536 entries)` |
| bitmap reconstruction | `src/application/primitives/internal/bitmap-reconstruct.ts:46` | `createLruCache(8 MiB)` |
| parent-realpath | `src/adapters/node/node-file-system.ts:446` | `createLruCache(128 KiB, 512)` |
| **commit-graph headers** | `read-commit-graph.ts:67` | **uncapped `Map`** ← the outlier |

**Fix shape.** Swap the inner `Map<ObjectId, CommitHeader>` for `LruCache<CommitHeader>` from
`src/domain/storage/lru-cache.ts`. The interface is a drop-in for this usage — `get(key:
string)` and `set(key, value, byteSize)` — and `ObjectId` is a branded `string`, so it is
assignable to the cache's `string` key without a cast.

`createLruCache(maxSizeBytes, maxEntries)` supports entry-count sizing directly: `evict()`
(`lru-cache.ts:56-63`) loops while `currentSize > maxSizeBytes || map.size > maxEntries`. Two
usable sizings; the choice between them is **D7**:

- entry-count — `createLruCache<CommitHeader>(Number.POSITIVE_INFINITY, CAP)` with
  `set(id, header, 1)`. Both of `set`'s guards are satisfied (`byteSize <= 0` throws;
  `byteSize > maxSizeBytes` silently drops). `currentSize` degenerates into an insert counter
  and `maxSize` reports `Infinity`; neither is read here.
- byte-estimated — `createLruCache<CommitHeader>(BYTES)` with
  `byteSize ≈ (1 + parents.length) × hashHexLength × 2 + 16`, matching how the siblings are
  sized.

**Correctness (R3).** Eviction is hazard-free by construction. `commitHeader` (`:257-288`)
consults the cache purely as a memo: on a miss it re-runs `findOwnPosition` → `commitDataAt` →
`resolveParentIds` against `graph`, which is the **already-parsed, already-resolved**
`LoadedGraph` held by `graphCache`. No `ctx.fs` call is on that path. The module's own
staleness reasoning (`:53-66`) is about the *shallow gate*, which is settled once per `Context`
inside `loadGraphUncached`; eviction cannot re-open it, because the graph promise is memoised
independently of the header cache.

One asymmetry worth stating: only *hits* are cached; a graph **miss** (`found === undefined`,
`:267`) returns `undefined` uncached today and still will. Bounding does not change that.

**Oracle.** Two readings, both required:

1. *Memory* — the W7 bench-memory workload's peak `heapUsed` on a commit walk over a fixture
   whose commit count exceeds the chosen cap, before vs after. Peak must flatten.
2. *No time regression* — `npm run profile log` self-shares before vs after. A cap set too low
   would show up as increased time in `positionOf` / `findOwnPosition`.

**Gate interactions.** `application` mutation bucket. `createLruCache` is already exported from
`src/domain/storage/index.ts:27`, so there is no new public surface and no `reports/api.json`
churn. The import adds `domain/storage` to this module's dependency set —
`check:architecture` (dependency-cruiser) permits `application → domain`, so this stays inside
the rule.

---

### W5 — Bound fsck's object cache

**Anchors (verified — the brief's `:283-304` is exactly `buildObjectCache`).**

```text
src/application/commands/internal/fsck/object-cache.ts:283-304  buildObjectCache
src/application/commands/internal/fsck/object-cache.ts:244-250  ObjectCacheResult
src/application/commands/internal/fsck/object-cache.ts:34       type CachedGitObject = GitObject | null
src/application/commands/fsck.ts:77-81                          the single call site
```

`buildObjectCache` loops the whole universe and stores every decoded `GitObject` — **including
each blob's full `content: Uint8Array`** — in one `Map` retained for the entire command. Peak
is O(total repository content). Real git streams.

**The decisive finding: no consumer ever reads blob bytes from this map.** Every reader was
traced:

| Consumer | Anchor | Fields it touches |
|---|---|---|
| `buildBlobFilenameMap` | `content-validation.ts:96-112` | `obj.type === 'tree'`, then `entry.name` and `entry.id` |
| `buildInEdgeMap` → `recordOutEdges` | `reachability.ts:11-22`, `:30-44` | commit `data.tree` + `data.parents`; tree `entries[].id` + `entries[].mode`; tag `data.object` |
| `buildReachableSet` → `visitObject` | `reachability.ts:143-181` | the same out-edge set, plus `obj.type` |
| `collectTypeFindings` / `resolveObjectType` | `reachability.ts:215-230` | `obj == null`, and `obj.type` |

Content validation reads raw bytes on its own (`content-validation.ts`
`tryGetRawObjectBody`), never through this cache. **Blob content is retained and never read.**

That makes a *structural projection* — not an LRU — the natural fix: replace
`CachedGitObject = GitObject | null` with a projection carrying `{ type }` plus the out-edge
data each type actually contributes, and `null` for unreadable. Peak drops from O(repo content)
to O(graph metadata), with **zero** re-reads, zero added I/O, and no async signature changes.

**Why the LRU alternative is worse here** — recorded so the decision is informed, not assumed.
All four consumers take a synchronous `ReadonlyMap`. A byte-capped LRU with
re-read-on-eviction makes `buildBlobFilenameMap`, `buildInEdgeMap`, `buildReachableSet` and
`collectTypeFindings` all async, and the re-reads would run through `auditCtx`, which
deliberately carries `NO_DELTA_CACHE` (`fsck.ts:39-50`, `:64`) — so every evicted packed object
re-pays full delta-chain resolution. The audit walk touches each object at least twice (in-edge
scan, then reachability walk), so eviction thrash is not hypothetical.

The exact bounding strategy is **D8**.

**Correctness (R4).** The projection preserves the two distinctions the passes depend on:
`null` (unreadable) versus present, and the object's `type`. `applyGraft(obj, shallow)`
(`object-cache.ts:298`) must be applied *before* projecting a commit, so the grafted parent
list is what the walk sees — a shallow repository's reachability verdict depends on it. The
`recovered` and `unrecoverable` maps are untouched.

**Oracle (R10).** The W7 fsck memory workload: peak `heapUsed` measured on two fixtures whose
blob content differs by ≥4×. Today peak tracks blob bytes roughly linearly; after, it must
track commit/tree count instead. Report both fixtures' absolute peaks on both sides.

**Gate interactions.** `application` bucket, break 95. `object-cache.ts:296` carries a
`// Stryker disable next-line ObjectLiteral,BooleanLiteral: equivalent` proof about
`verifyHash: false` on the `readObject` call — that line is *not* rewritten by the projection
(only the value stored downstream of it is), so the proof survives; it must still be re-read
and confirmed rather than assumed. `check:write-surfaces` is not engaged — fsck writes nothing.

---

### W6 — `tsc` incremental + CI cache

**Anchors (verified).** `tsconfig.json` (27 lines) has no `incremental` and no
`tsBuildInfoFile`. `.gitignore:28` already carries `*.tsbuildinfo`. `check:types` is
`tsc --noEmit`, with `files: ["src/**/*.ts", "test/**/*.ts", "tooling/**/*.ts",
"tsconfig.json"]` and `output: []`.

**Measured, this worktree, this machine.**

| Run | Wall clock | Notes |
|---|---|---|
| `tsc --noEmit -p tsconfig.json` (today) | **9.22 s** real / 14.43 s user | no cache exists |
| `tsc --noEmit --incremental --tsBuildInfoFile <scratch>` — cold, no cache file present | **8.72 s** real | writes a **557.1 kB** `.tsbuildinfo` |
| the same — warm, zero source edits | **2.03 s** real | **4.3× faster** |

The cold pair (9.22 vs 8.72) is a single measurement each and the gap is within plausible
run-to-run noise; the claim taken forward is only "no cold regression", to be confirmed over
≥3 alternating rounds during implementation. The `.tsbuildinfo` for this probe was written to
the session scratchpad — nothing was written into the worktree.

The one number this design does **not** have is warm-after-one-edit, which is the number the
local dev loop actually feels. Measuring it requires editing a source file, so it belongs to
the implementation phase, not to a read-only design probe. It is a required part of R11's
evidence.

**CI blast radius, counted (not estimated).** Jobs whose steps run a wireit task that declares
`check:types` as a dependency, on a `pull_request` event:

```text
typecheck 1 · build 1 · unit-tests 9 (3 os × 3 node) · mutation 1 · integration 1
posix-integration 2 · win-integration 1 · parity-tests 1          = 17 job-instances
+ benchmark-compare, which builds BOTH base and head trees        = 19 tsc payments
```

On `push`, `benchmark-snapshot` adds one more. Eleven of the nineteen payments — nine
job-instances plus `benchmark-compare`'s two tree builds — run on `ubuntu-latest` and can share
a Linux cache. The eight macOS and Windows payments (three `unit-tests` cells + one
`posix-integration` cell on macOS; three `unit-tests` cells + `win-integration` on Windows)
cannot share it.

**Fix shape — where the flag goes matters more than the flag.** Three consumers read the
project's tsconfigs today, and two of them must not inherit `incremental`:

| Consumer | Config it reads | Hazard if it inherits `incremental` |
|---|---|---|
| `check:types` | `tsconfig.json` | none — this is the target |
| rollup (`build:js`) and typedoc (`docs`, `docs:json`) | `tsconfig.build.json`, which **extends `tsconfig.json`** | `@rollup/plugin-typescript` drives the compiler in-memory with `outDir: undefined`; an inherited `incremental` invites a cache-file write with no coherent location. Prior learning: this toolchain is already fragile — TypeScript 7 crashes it, which is why 6.x is pinned. |
| Stryker's typescript-checker | `stryker.config.mjs:32` → `tsconfigFile: 'tsconfig.json'` | Creates a program per mutant under concurrency. Concurrent checkers sharing one `.tsbuildinfo` path is an **unproven but real** hazard; option (a) below removes the need to find out. |

Setting `incremental: true` in `tsconfig.json` and `incremental: false` in
`tsconfig.build.json` fixes rollup and typedoc but **not** Stryker, which reads `tsconfig.json`
directly. The zero-blast-radius shape is therefore a dedicated `tsconfig.typecheck.json`
extending `tsconfig.json`, carrying only `incremental` + `tsBuildInfoFile`, with `check:types`
becoming `tsc --noEmit -p tsconfig.typecheck.json` and the new file added to that task's
wireit `files`. That is **D9**.

**wireit interaction — the trap that would silently void the win.** `check:types` declares
`output: []` today. wireit's default `clean: true` **deletes declared outputs before running a
task**: declaring the `.tsbuildinfo` as an output without `clean: false` would delete the cache
on every run and leave `tsc` permanently cold. The options are to leave it undeclared (wireit
keeps caching task *success* exactly as today, and the cache file simply persists on disk) or
to declare it with `clean: false` (wireit additionally stores and restores it in
`.wireit/cache`, surviving branch switches). This is **D10**.

The two caches compose rather than compete: wireit skips `check:types` entirely when its input
hashes are unchanged; the TypeScript cache only pays off on the runs wireit *does* execute —
which is exactly the changed-source case that hurts today.

**CI cache shape.** `actions/cache@v6` (floating major, per constraint) around the
`.tsbuildinfo`, restored before and saved after the type-consuming step. Keying is **D11**; the
mechanical constraints on any key are that it must include `runner.os` (a Linux cache file is
not valid on Windows), the resolved Node version, and a hash of `tsconfig*.json` +
`package-lock.json`, with a `restore-keys` prefix so a source-only change can reuse a near-miss.

**Clean-run authority (brief constraint).** Exactly one job must remain the cold authority so a
stale or poisoned cache file can never mask a type error. The `typecheck` job is the natural
choice: it is the only job whose sole purpose is `tsc`, it already gates `build` and
`unit-tests` through `needs`, and running it cold costs ~37 s in CI. Whether that job skips the
cache entirely or restores-without-saving is part of **D11**.

**Oracle (R11).** Local: `npm run check:types` timed cold (cache file deleted), warm-unchanged,
and warm-after-one-edit, three alternating rounds each, main vs branch. CI: see below.

**Verification of CI-only edits.** `npm run validate` never reads `.github/workflows/**`. The
verification for W6's workflow edit — and for D2 / D3 if they land — is:

1. The `megalinter` job already in `ci.yml`. `.mega-linter.yml` enables `YAML_YAMLLINT`, so it
   catches **YAML syntax** errors in a workflow file. It enables **no** GitHub-Actions
   semantic linter, so a wrong `uses:` reference, a bad `needs:` edge or a misused context
   expression will **not** be caught there. Do not over-trust this step.
2. **A green CI run on the PR itself** — the workflow edit executes on the PR, so a broken
   action reference or a cache step that fails to restore surfaces as a failing or visibly
   slower job before merge. This is the real pre-merge gate.
3. **Observed run timings post-merge.**
   `gh api repos/scolladon/tsgit/actions/runs/<id>/jobs` exposes per-job `started_at` and
   `completed_at`. The named check: sample the first ≥3 push runs and ≥3 PR runs after merge,
   and compare `typecheck` and `unit-tests` job durations against the same statistic over the
   ≥5 runs immediately preceding. Report absolute seconds. This is a post-merge observation and
   therefore cannot gate the PR; steps 1 and 2 do that.

---

### W7 — bench-memory coverage for both bounds

**Anchor.** `tooling/bench-memory.ts` (215 lines). Two workloads today —
`delta-chain-cold-read` (`runDeltaChainWorkload`) and the `TSGIT_BENCH_LARGE`-gated
`large-pack-spread-read`. It is already wired into nightly CI: `.github/workflows/bench.yml`
runs `npm run bench:memory` and uploads `reports/benchmarks/` as the `benchmarks` artifact. New
workloads therefore get nightly coverage for free — **no workflow edit is needed for W7**.

**What to add.** Two workloads following the existing `WorkloadReport` shape (`before` / `peak`
/ `after` for `rss` and `heapUsed`, with GC-forced baselines via `gcBaseline`):

- **commit-walk-header-cache** — `repo.log()`, or a bounded `walkCommits`, over a fixture whose
  commit count exceeds the W4 cap, so the cache reaches steady state. This reads through
  `commitHeader` **only if the fixture carries a commit-graph**; the workload's setup must
  therefore write one (`git commit-graph write`) and assert its presence, or the workload
  silently measures nothing. That is a real precondition, not a detail.
- **fsck-object-cache** — `repo.fsck()` over two fixtures whose blob content differs by ≥4×,
  emitting one report row each, so R10's sub-linearity is readable straight off the artifact.

**Constraint.** `bench.yml` runs unguarded on the nightly runner with a 30-minute job timeout;
the large-pack workload is already gated behind `TSGIT_BENCH_LARGE` precisely to keep a ~500 MB
fixture out of nightly CI. The fsck workload's larger fixture must respect the same gate, or be
small enough that the nightly wall clock is not threatened.

**Gate interactions.** `tooling/**/*.ts` is inside `check:types` and biome scope. Prior
learning: `biome.json`'s `files.includes` is an allow-list, so a *new* tooling file can be
silently unlinted. This item edits an existing file, so it stays covered; if it grows a new
module, that module's path must be added to `biome.json` in the same change.

---

### W8 — vitest pool / prepush pilot (measure, then keep or revert)

**Anchors (verified).** `vitest.config.ts` declares **no** `pool` key and no `isolate` key, so
vitest defaults apply (`pool: 'forks'`, `isolate: true`). `maxWorkers: '100%'` is set at `:29`.
Five projects are declared; four of them (`test:coverage`, `test:integration`, `test:parity`,
`test:perf`) are direct `validate` dependencies.

**The oversubscription, verified from wireit's own source.**

```text
node_modules/wireit/lib/cli-options.js:77   const defaultValue = os.cpus().length * 2;
```

On this 11-core host `WIREIT_PARALLEL` defaults to **22**, and `validate` declares **22**
dependencies — so wireit will start all of them at once, including four vitest tasks, each
spawning up to 11 workers via `maxWorkers: '100%'`. Worst case is roughly **44 vitest workers
on 11 cores**, alongside rollup, typedoc, biome, cspell, size-limit and attw.

**Isolation audit — the prerequisite for `pool: 'threads'` / `isolate: false` — done.**

| Hazard | Finding |
|---|---|
| In-process working-directory mutation (the Node call that changes `process.cwd()`) | **zero** occurrences in `src/`, `test/`, `tooling/` — the classic threads-pool blocker is absent |
| `process.env` writes in unit tests | 2 files: `test/unit/adapters/node/node-env-reader.test.ts`, `test/unit/adapters/node/node-file-system.test.ts` |
| `vi.stubEnv` / `vi.stubGlobal` / `vi.setSystemTime` | 5 unit-test files |
| Config-level env injection | `vitest.config.ts:21-26` sets `TZ`, `HOME`, `USERPROFILE`, `XDG_CONFIG_HOME` — the isolated-`HOME` guard that has already broken a byte comparison once |
| Module-scope mutable bindings in tests | 5 files with a top-level `let` |
| Suite size | 558 unit test files, 125 integration |

The env findings are the crux and must be settled **empirically, not from memory**: whether a
worker thread receives its own copy of `process.env` or shares the parent's is a Node/Tinypool
behaviour, and `vitest.config.ts`'s `env` block plus `vi.stubEnv` both write through it. The
pilot's first step is a probe, not a config edit.

**Pilot shape.** Three independent variables, measured one at a time so a regression is
attributable:

1. `pool: 'threads'` with `isolate: true`.
2. `isolate: false` on the current `forks` pool.
3. A per-task worker cap for `prepush` — `maxWorkers` lowered, or `WIREIT_PARALLEL` capped — so
   the four concurrent vitest tasks do not each claim every core.

**Oracle and revert rule (R12).** For each variable independently:

- Measure `npm run test:unit` — and, for variable 3, `npm run prepush` — over **≥3 alternating
  rounds** main vs branch on the same idle machine, reporting absolute wall clock per round and
  the median. Self-share deltas and single-round numbers do not count.
- **Revert rule:** if the median wall clock is not improved by a margin larger than the observed
  round-to-round spread, the variable is reverted in the same PR. A variable that changes any
  test's pass/fail verdict, or makes any test flaky across the three rounds, is reverted
  immediately regardless of speed.
- Both outcomes are reported. "Measured, no win, reverted" is a successful item.

**Gate interactions.** This is the one item that perturbs the harness every other item's gate
runs through, so it goes **last**, and `npm run validate` must be green on the final state
regardless of which variables survive. Prior learning applies to the measurement itself: a
wireit-**cached** green `validate` can precede a red `prepush`, so the pilot's timings must come
from genuinely cold task runs, not cache hits.

---

### The three decision-gated items — pinned evidence

These are not designed here; the evidence is pinned so the ADR conversation is grounded.

#### D1 evidence — per-command export surface

`package.json` declares `"./commands/*"` (mapping to `dist/{esm,cjs,types}/commands/*`), but
`rollup.config.ts:8-20` builds exactly one entry under that prefix: `'commands/index'`.
`docs/design/commands.md:1425` promises "17 export entries: one barrel (`./commands`) and one
per command", and `:1431-1435` promises "1.5 kB gzipped each".

Pinned by a resolution probe run in a throwaway directory with
`node_modules/@scolladon/tsgit` symlinked to the built checkout, Node v22.22.3:

| Specifier | Result |
|---|---|
| `@scolladon/tsgit` | **OK** |
| `@scolladon/tsgit/commands/index` | **OK** |
| `@scolladon/tsgit/commands/add` | **`ERR_MODULE_NOT_FOUND`** — `dist/esm/commands/add.js` |
| `@scolladon/tsgit/commands` | **`ERR_PACKAGE_PATH_NOT_EXPORTED`** |

The second failure is **not in the brief** and is arguably the worse of the two: the barrel the
build *does* produce is reachable only through the undocumented `./commands/index`, because
`./commands` matches no pattern in the `exports` map.

Sizing for the "build it" branch: `src/application/commands/*.ts` is **50 files** (49 commands +
`index.ts`), so roughly 49 new rollup entries, 49 `.size-limit.json` rows, and 49 more entry
pairs for `attw --pack . --profile node16`. `tooling/dts-entries.ts:1-9` already expands
wildcard subpaths against the files present under `dist/`, so the truthful-`.d.ts` audit picks a
split up automatically — that piece is pre-built.

`check:exports` (attw) does **not** currently catch either failure: it validates the entries it
can resolve and says nothing about a wildcard with no matching files. Whatever D1 decides, a
guard against silent recurrence belongs with it (**D6**).

**Semver note.** Removing `"./commands/*"` from `exports` also removes the one specifier under
it that resolves today, `@scolladon/tsgit/commands/index`. It is undocumented, but it *works* on
3.3.0, so a retraction is a breaking change to the published surface under a strict reading of
semver. The user should decide that consciously; pairing the retraction with an added
`"./commands"` (**D4**) gives every plausible consumer a supported landing spot.

The promise text lives in design docs — `commands.md:196`, `:1425-1435`, `:1660`, `:1703`;
`repository-facade.md:63`, `:81`, `:581`; `public-type-re-exports.md:26`, `:181` — which are
point-in-time records by this repo's convention. `README.md` makes **no** per-command import
claim, so a retraction has no user-facing documentation to unwind beyond the `exports` map.

#### D2 evidence — mutation job placement

The brief cites PR run **#31225602768** as runner-pool starvation. Re-pulled from the API, the
full job timeline reads:

```text
last unit-tests cell completes            23:02:44
parity-tests            start 23:02:47    (needs: unit-tests)
win-integration         start 23:02:47    (needs: unit-tests)
posix-integration ×2    start 23:02:47    (needs: unit-tests)
benchmark-compare       start 23:02:47    (needs: unit-tests)
mutation                start 23:02:47 → end 23:50:08   (47m21s)
integration             start 23:50:50    (needs: unit-tests)  ← 48 min late
```

So **six** siblings with the same `needs` started 3 s after `unit-tests`; `integration` alone
waited. (`benchmark-snapshot` reports `started 23:50:47 / completed 23:02:44` — GitHub emits
incoherent timestamps for skipped jobs; ignore it.)

Five more recent `pull_request` runs, same query:

| Run | last unit-tests done | `integration` start | delta | `mutation` duration |
|---|---|---|---|---|
| 31945837471 | 12:05:49 | 12:05:52 | **+3 s** | 22 s |
| 31945267624 | 11:51:53 | 11:51:57 | **+4 s** | 7m44s (cancelled) |
| 31873820778 | 08:15:09 | 08:15:12 | **+3 s** | 27 s |
| 31873271501 | 08:02:15 | 08:02:18 | **+3 s** | 8m03s (cancelled) |
| 31872060456 | 07:33:24 | — | (all skipped) | skipped |

**The queueing theory is not confirmed.** In four consecutive non-skipped runs `integration`
started within 4 s of its `needs` being satisfied, *while `mutation` was still running*. The
#31225602768 stall is a one-off, consistent with a stuck queue entry — a class already seen in
this repo — rather than with `mutation` systematically starving the pool.

One incidental observation from the same data: on run 31945837471 `mutation` took 22 s and
`benchmark-compare` took **23m15s**. On current PRs the long tail is `benchmark-compare`, not
`mutation`. Recorded rather than acted on; see **D13**.

#### D3 evidence — benchmark-snapshot cadence

Four consecutive `push` runs of `ci.yml`:

| Run | all jobs except snapshot done | snapshot window | snapshot duration | **solo tail** | result |
|---|---|---|---|---|---|
| 31945820073 | 12:10:40 | 12:04:23 → 12:22:40 | 18m17s | **12m00s** | success |
| 31873799070 | 08:21:45 | 08:14:35 → 08:36:23 | 21m48s | **14m38s** | success |
| 31820464374 | 16:52:45 | 16:45:18 → 17:05:27 | 20m09s | **12m42s** | **failure** |
| 31781834065 | 08:03:22 | 08:00:17 → 08:21:05 | 20m48s | **17m43s** | **failure** |

Reproducible, and **2 of the last 4 runs failed** — a fragility signal the brief did not have.
Total push-run wall clock on 31945820073 was 23m17s, of which 12m is snapshot-only tail. The
trade the brief names still stands: a nightly cadence costs per-merge granularity on the
`gh-pages` data branch — which is benchmark data, not a website, and whose deletion would break
this job — and `benchmark-compare` already gives PR-time signal.

---

## Decision candidates

The designer decides none of these. **D1-D3 are the brief's own three user decisions;** D4-D14
are further load-bearing choices uncovered while designing. The user decides each in the ADR
phase.

| # | Choice | Alternatives (≤3) | Recommendation | Why |
|---|---|---|---|---|
| **D1** | **Per-command export surface** — the shipped `./commands/*` wildcard resolves to nothing | **(a)** Build ~49 real per-command rollup entries + size-limit rows + attw coverage. **(b)** Retract `./commands/*` from `exports` (and from the design-doc promises) until built. **(c)** Keep the wildcard and add entries for a curated subset only. | **(b) retract** | The surface is broken *today*; retracting is a small `exports` edit that makes the package honest immediately. (a) is an L-effort item that also structurally caps the browser bundle — real value, but it should be chosen deliberately, not folded in (see **D5**). (c) leaves a wildcard that silently fails for every uncovered name — the same defect, smaller. Note the semver consequence recorded under D1 evidence, and pair with **D4**. |
| **D2** | **Mutation job placement** | **(a)** Keep as-is; add a `timeout-minutes` guard so a runaway run cannot occupy a slot for 47 minutes. **(b)** Move to its own workflow + concurrency group. **(c)** Move post-merge. | **(a) keep as-is + timeout guard** | The re-pulled evidence does not support the starvation theory: in four consecutive recent runs `integration` started within 3-4 s of its `needs`, while `mutation` was running. The cited 48-minute stall has not reproduced. (b) and (c) restructure CI to fix a defect with one observation behind it, and (c) would remove the pre-merge signal that the local triage currently pairs with. If the stall recurs, this reopens with data. |
| **D3** | **benchmark-snapshot cadence** | **(a)** Move to a nightly schedule — fold into `bench.yml`, which already runs at 03:14 UTC and already publishes a `benchmarks` artifact. **(b)** Keep per-merge. **(c)** Keep per-merge but make it `continue-on-error` / non-blocking. | **(a) nightly** | Reproducible 12-18 minute solo tail on every push to `main` across 4 sampled runs, **2 of which failed**. `benchmark-compare` already gives PR-time signal, so per-merge granularity on the `gh-pages` data branch is the only loss — a per-day trend is adequate for an alert threshold set at 150 %. (c) hides the failures without recovering the wall clock. |
| **D4** | Whether the same change fixes the missing `./commands` barrel subpath | **(a)** Add `"./commands"` pointing at `dist/*/commands/index.*`. **(b)** Leave it; `./commands/index` keeps working. | **(a) add it** | Newly pinned: `@scolladon/tsgit/commands` throws `ERR_PACKAGE_PATH_NOT_EXPORTED` while the barrel is built and documented. One map entry, additive, and correct under either D1 branch — and under D1(b) it is what keeps the retraction from stranding the barrel entirely. |
| **D5** | If D1 lands as "build it" — does the split ride this PR or its own run | **(a)** Its own follow-up run. **(b)** This PR. | **(a) own run** | The brief's closing constraint asks for exactly this to be surfaced. 49 entries × (rollup input + size-limit row + attw pair), plus a wiring guard, is an L-effort change that would dominate a remediation PR and dilute every other item's review. |
| **D6** | Guard against the broken-wildcard class recurring | **(a)** Extend `tooling/verify-tarball.sh` to resolve every `exports` subpath — wildcards expanded against `dist/` — and fail on a miss. **(b)** A dedicated `check:exports-resolve` wireit task in `validate`. **(c)** None; rely on review. | **(a) extend verify-tarball** | attw demonstrably does not catch it — the defect shipped. `verify-tarball.sh` already runs under `validate` via `check:tarball` and already has `dist/` in hand, so the marginal cost is small. (b) is cleaner in isolation but adds a 23rd dependency to `validate`. |
| **D7** | Commit-graph header-cache sizing | **(a)** Entry-count: `createLruCache(Infinity, CAP)` with `byteSize = 1`. **(b)** Byte-estimated: `createLruCache(BYTES)` with a per-header size estimate. **(c)** Both bounds, like `deltaCache`. | **(a) entry-count, CAP = 65 536** | `CommitHeader` is small and fixed-shape, so entry count *is* a proxy for bytes, and the brief itself says "entry-count-sized". 65 536 mirrors `DEFAULT_DELTA_CACHE_ENTRIES` (`src/index.node.ts:32`), so the repo gains no second magic number. (b) buys accuracy the shape does not need; (c) adds a knob with no reader. |
| **D8** | fsck object-cache bounding strategy | **(a)** Structural projection: store `{ type, out-edges, tree-entry {id,name,mode} }`, drop blob bytes. **(b)** (a) **plus** folding `buildBlobFilenameMap` into the build pass so tree-entry *names* are never retained either. **(c)** Byte-capped LRU with re-read on eviction; consumers become async. | **(a) projection** | Traced: no consumer reads blob bytes. (a) removes the O(repo-content) term with zero re-reads, zero I/O and no async churn. (c) makes four consumers async and re-pays full delta resolution on eviction because `auditCtx` carries `NO_DELTA_CACHE` — strictly worse. (b) is a genuine further win but moves fsck's special-filename knowledge into the cache builder; worth it only if W7's oracle shows tree names are material. |
| **D9** | Where `incremental` / `tsBuildInfoFile` live | **(a)** New `tsconfig.typecheck.json` extending `tsconfig.json`; `check:types` points at it. **(b)** `tsconfig.json` plus an explicit `incremental: false` in `tsconfig.build.json`. **(c)** `tsconfig.json` only. | **(a) dedicated typecheck config** | (c) leaks `incremental` into rollup, typedoc **and** Stryker's typescript-checker (`stryker.config.mjs:32` reads `tsconfig.json`), which runs concurrent per-mutant programs. (b) fixes rollup and typedoc but **not** Stryker. (a) has zero blast radius; the cost is one small file plus a wireit `files` entry. |
| **D10** | Whether the `.tsbuildinfo` is a declared wireit output of `check:types` | **(a)** Leave undeclared (`output: []`, as today). **(b)** Declare it with `clean: false`. **(c)** Declare it with default `clean` — **not viable**; wireit deletes outputs before each run and the cache would never warm. | **(a) leave undeclared** | Smallest change that still delivers the full local win: wireit already caches task success on input hashes, and the cache file simply persists on disk. (b) additionally survives branch switches through `.wireit/cache` — a real but secondary benefit that introduces a caching semantic to a task that has never had one. (c) is listed only so it is explicitly ruled out. |
| **D11** | CI cache keying, and which job stays the cold authority | **(a)** `actions/cache` keyed `${{ runner.os }}-${{ node-version }}-${{ hashFiles('tsconfig*.json','package-lock.json') }}` plus a source-hash suffix, with `restore-keys` prefix; the `typecheck` job **skips the cache entirely** and stays the cold authority. **(b)** Same key, but `typecheck` restores without saving. **(c)** Ubuntu-only cache; skip the macOS and Windows cells. | **(a)** | The brief requires clean-run authority, and the cleanest form is one job that never sees a cache, so no stale cache file can mask an error. `runner.os` in the key is mandatory — a Linux cache file is invalid on Windows. (c) forgoes the 8 macOS/Windows payments' savings for no correctness gain, and the key in (a) already makes cross-OS reuse impossible, so (c) buys nothing (a) does not. |
| **D12** | `status` churn — behaviour when the allocation profile finds no dominant construct | **(a)** Fix only the top attributed site; if none exceeds a stated share of allocated bytes, record the finding and ship no code change. **(b)** Fix every candidate above a lower share in one pass. **(c)** Defer W3 entirely to its own run once the allocation profile exists. | **(a) top site, or nothing** | Keeps "investigate, then fix" honest in both directions and keeps the GC-share oracle attributable to a single edit. (b) makes the delta un-attributable across several simultaneous changes. (c) stays available if the profile shows the cost is architectural — e.g. the five-collection shape in `status.ts` — rather than a local allocation. The user also fixes the threshold in (a). |
| **D13** | Whether `benchmark-compare`'s 23-minute PR tail is in scope | **(a)** Out of scope this run; record the observation only. **(b)** Fold a cadence or scope change in alongside D3. | **(a) out of scope** | Uncovered incidentally while pinning D2 and D3, and it is now the *actual* PR long tail — 23m15s versus `mutation`'s 22 s on run 31945837471. But the brief scopes CI cadence to the snapshot and mutation jobs, and this job is `continue-on-error` today. Surfaced so the user can pull it in deliberately rather than have it folded in silently. |
| **D14** | Guard against `docs/perf/baseline.json` re-staling | **(a)** None; regenerate on demand, as today. **(b)** A `validate` check that fails when a symbol named in `baseline.json` has zero occurrences in `src/`. **(c)** A CI job that regenerates and diffs. | **(a) none** | The artifact went stale for a month unnoticed, so (b) is tempting and cheap — but a profile frame name is not required to be a live symbol (V8 emits `<anonymous>`, minifier artefacts, and pattern-keyed regular-expression entries), so the check would false-positive and get muted. (c) cannot work: profile shares are machine-dependent and would never diff clean. Recommending (a), with the staleness recorded as a known limitation. |

---

## Test strategy

### W2 — `ObjectId.from` (the only item with a faithfulness stake)

The `domain` mutation bucket breaks at **99** and coverage is gated at 100 %, so the example
tests carry the mutation-killing load and the property test proves the grammar.

**Extend** `test/unit/domain/objects/object-id.test.ts` — the existing file; do not create a
parallel one. Conventions: `describe('Given …')` > `describe('When …')` > `it('Then …')`, AAA
body, `sut` names the function under test (`ObjectId.from`), never the result.

*Boundary examples — one per mutable comparison, each isolated.* The predicate has four
comparisons (`>= 48`, `<= 57`, `>= 97`, `<= 102`) plus the length disjunction
(`=== 40 || === 64`). Every boundary and every off-by-one neighbour needs its own test, driven
by a single-character substitution into an otherwise-valid 40-character id:

| Substituted character | Code | Expected |
|---|---|---|
| `/` | 0x2F | reject — below `0` |
| `0` | 0x30 | accept |
| `9` | 0x39 | accept |
| `:` | 0x3A | reject — above `9` |
| `` ` `` | 0x60 | reject — below `a` |
| `a` | 0x61 | accept |
| `f` | 0x66 | accept |
| `g` | 0x67 | reject — above `f` |
| `A`, `F` | — | reject — the `[0-9a-f]` class is lowercase-only |

Plus lengths 39 / 40 / 41 / 63 / 64 / 65 and `''`, and the two trailing-whitespace cases
(`…\n`, `…\r`) that the pinned matrix shows JavaScript rejects.

*Guard clauses need isolated tests*, per repo convention: the length check and the code-unit
check must each be triggered alone — a 39-character string containing a `g` proves neither
guard individually.

*Error assertions must be specific.* Never `toThrow(TsgitError)`. Use try/catch and assert
`err.data` directly: `{ code: 'INVALID_OBJECT_ID', value: <the exact input> }`. `StringLiteral`
mutants on the code, and any accidental mutation of `value`, survive a type-only check.

*Property test.* `object-id.properties.test.ts` beside the example file. This is a lens-3 fit —
a total function over an algebraic grammar, which must never throw for any input in the safe
subset and must classify every input — not a round-trip and not a compositional matcher. The
property: **the new validator agrees with the pair of original regular
expressions on every input.** The oracle is those two regex literals inlined into the test — an
independent oracle, not a copy of the production loop, so this is a genuine property and not a
tautology. Generators must be biased toward the boundary, because uniform random strings are
almost never 40 hex characters:

- fast-check's hexadecimal-string arbitrary constrained to exactly 40, and to exactly 64
  (the valid shapes);
- those same strings with one character replaced by an arbitrary code point (character
  near-misses);
- those same strings with a prefix or suffix appended (length near-misses);
- `fc.string()` unconstrained (the diffuse negative space);
- a binary/code-unit string arbitrary, to cover lone surrogates.

`numRuns: 200` — cheap predicate, tier-1 budget. Never commit a seed.

*Additivity:* the property test is added **alongside** the example tests, never in place of
them. The examples document the literal accepted alphabet; the property proves the grammar.

### W3 — `status` churn

Behaviour-preserving by construction. If the fix lands on `ancestorsOf`, the existing unit tests
for the ignore evaluator and for `isIgnored` are the regression net; add table-driven examples
for the ancestor sequence itself (`''`, `a`, `a/b`, `a/b/c`, `a//b`, and leading/trailing `/`)
asserting the exact array, root-first — that is the contract both callers depend on.

`ancestorsOf` is a lens-4 fit (counting invariant): a `*.properties.test.ts` sibling asserting
that the result length equals the count of `/` in the path, and that each element is a strict
prefix of the path ending at a `/` boundary, is cheap and kills the loop-bound mutants the
current Stryker directives *suppress*. Preferring a real property over a re-proven suppression
is the better discharge of R5.

### W4 / W5 — cache bounds

Both are behaviour-preserving, so the tests assert **invariance**, not new behaviour:

- W4 — a walk over a fixture with more commits than the cap returns the identical
  `CommitHeader` sequence as before, and `commitHeader` issues no `ctx.fs` call after the graph
  is loaded (assert with a counting `FileSystem` fake; the existing `Context` test doubles
  already support this).
- W5 — the full fsck integration suite is the net: findings, order and exit code are the
  contract. Add a case covering the projection's edge, namely a repository with a large blob
  whose bytes must *not* be retained — asserted by the memory workload rather than by a unit
  test, because memory is not unit-testable. That is what W7 exists for.
- Neither is a parser, matcher or round-trip pair, so no property test is owed. Stating that
  explicitly, per the repo's "surface the gap or note why the lenses don't fit" rule.

### W6 / W8 — config and harness

No test artifacts. W6's proof is the timing matrix (cold / warm-unchanged / warm-after-one-edit)
plus a green `npm run validate` **and** a green `npm run build` — the latter exercises the
rollup and typedoc path that must *not* inherit `incremental`. W8's proof is the ≥3-round
alternating wall-clock comparison plus an unchanged pass/fail verdict across the whole suite.

### Interop

No interop test is owed. Faithfulness here binds an internal refusal (`INVALID_OBJECT_ID`),
which real `git` has no counterpart for — there is no external tool behaviour to pin beyond the
JavaScript-engine matrix already recorded above, and that matrix belongs in the unit test, not
in `test/integration/*-interop.test.ts`.

---

## Out of scope

Verbatim from the brief's own out-of-scope list — reviewed healthy, do not touch:

- Delta-chain resolution.
- Loose-oid probing.
- Tree/commit single-pass parsing.
- Commit-walk prefetch.
- Pre-commit hook scoping.
- Startup / import cost.
- Type-level complexity — no project references; the 8.7 s is volume-bound and `incremental` is
  the cheap slice.
- Sync zlib in `node-compressor` — correct for small-object workloads.
- Internal `export *` barrels — zero live bundle cost under rollup.

Added by this design:

- **The per-command split itself**, if D1 lands as "build it" — see **D5**; it gets its own run.
- **`benchmark-compare`'s 23-minute PR tail** — see **D13**; observed, recorded, not acted on.
- **Any change to the `gh-pages` branch** — it is the benchmark data branch, not a website; D3
  changes only *how often* the snapshot job writes to it.
- **`ObjectId.fromRaw`** — its trusted-path skip is already proven vacuous
  (`object-id.ts:21-24`) and stays as-is (R2).
- **The other 11 `/^[0-9a-f]{40}$/` literals** in `src/` — none is on a profiled hot path, so
  converting them would be churn without an oracle.
