# Design — perf-review remediation

> Brief: act on the 2026-08-16 structured TypeScript performance review of `main` — three
> user-owned decisions (per-command export surface, mutation job placement, benchmark-snapshot
> cadence) and seven measured work items (stale perf baseline, `ObjectId.from` hex validation,
> `status` GC churn, commit-graph header-cache bound, fsck object-cache bound + bench-memory
> coverage, `tsc` incremental + CI cache, vitest pool/prepush pilot).
> Status: draft → self-reviewed ×3 → accepted → **revised against ADR-640 … ADR-652**
>
> All 14 decision candidates are settled (ADR-640 … ADR-652; D1 and D5 fold into ADR-640).
> Two ratifications deviate from the design's recommendation and add work: the per-command
> export surface is **built in this change** (ADR-640, **W9**), and the two heavy PR jobs are
> **label-gated** (ADR-641 + ADR-651, **W10**). `benchmark-snapshot` is untouched (ADR-642).

---

## Context

### Where this comes from

The source is a structured perf review of `main@46c6bd1c` run on 2026-08-16, with fresh V8
profiles taken through the repo's own `tooling/profile.ts` child mode. This worktree is cut
from that same commit, so every anchor below was re-verified in place; drift from the brief's
anchors is called out where it exists.

This is a **remediation** change, not a feature: it touches four source files, two tooling
files (`bench-memory.ts`, `verify-tarball.sh`), five config files (`tsconfig.typecheck.json`,
`package.json`, `rollup.config.ts`, `.size-limit.json`, `.github/workflows/ci.yml`) and one
committed artifact. There is no new public command, no new error code, no new on-disk format.
After ADR-640 there **is** a new published export surface — 49 per-command subpaths plus the
`./commands` barrel — but no new *symbol*: every entry is an existing module already re-exported
through the built barrel. The run has no backlog id (the input is a spec file), so no
`docs/BACKLOG.md` tick is owed.

### Work-item labels

The brief's seven items map to eight labels here (its item 5 bundles two separable edits); the
ADR phase added two more, W9 and W10:

| Label | Brief item / source |
|---|---|
| W1 | regenerate the committed perf baseline |
| W2 | `ObjectId.from` hex validation |
| W3 | `status` allocation churn — investigate, then fix |
| W4 | bound the commit-graph header cache |
| W5 | bound fsck's object cache *(item 5, first half)* |
| W6 | `tsc` incremental + CI cache |
| W7 | bench-memory coverage for both cache bounds *(item 5, second half)* |
| W8 | vitest pool / prepush pilot |
| **W9** | **build the per-command export surface** — ADR-640 (+ folded D5), ADR-643, ADR-644 |
| **W10** | **label-gate the two heavy PR jobs** — ADR-641, ADR-651 |

### What constrains it

| Constraint | Source | Effect on this design |
|---|---|---|
| Git-faithfulness is the prime directive | `CLAUDE.md`, ADR-226 | The `ObjectId.from` rewrite must keep the accept/reject set and the `invalidObjectId` error data **byte-identical**. No other item touches a refusal path. |
| Coverage 100 % on `src/domain/**`, `src/ports/**`, `src/adapters/{node,memory}/**`, `src/operators/**` | `vitest.config.ts:80-98` | Only `src/domain/objects/object-id.ts` falls inside the gated set. The three application-layer edits are outside coverage but inside Stryker. |
| Mutation budgets | `mutation-budgets.json` | `domain` bucket: break **99**, low/high **100**. `application` bucket: break **95**, low **98**. The new validator lands in `domain` — the strictest bucket. |
| Equivalent-mutant proofs are structure-specific | prior-run learning | `ignore-evaluator.ts` and `object-cache.ts` carry `// Stryker disable next-line … equivalent` proofs written against the **current** data structures. Any rewrite invalidates them; they must be re-proven against the new shape or removed, never carried forward. |
| No suppression directives | `CLAUDE.md` | No `v8 ignore` / `stryker-disable` / `biome-ignore` added. Existing proven-equivalent Stryker directives may be *revised or removed*, not extended without a fresh proof. |
| Size budgets | `.size-limit.json` | Full library 335 kB gzip (at 186.6 kB today, **284.35 kB after W9's split** — see W9); browser no-build bundle **160 kB gzip and currently 156.04 kB — 97.5 % consumed**. Any byte added to a module reachable from `src/index.browser.ts` spends from a ~3.96 kB reserve. W9 does **not** spend from it: the bundle is byte-identical before and after the split (pinned in W9). |
| Tarball cap | `tooling/verify-tarball.sh` `SIZE_CAP` | 750 KiB compressed, "tight by choice". The published 3.3.0 pack is 736 732 B — **95.9 % consumed**. W9 pushes the pack past it; W9 moves the cap with measured justification. This constraint was not engaged before ADR-640. |
| Structured output, not cosmetics | ADR-249 | Not engaged. W9 publishes new *paths* to existing functions, not new options or rendered text. |
| `check:types` wireit fan-in | `package.json` wireit block | `check:types` is a declared dependency of `build:js`, `test`, `test:unit`, `test:integration`, `test:posix-integration`, `test:win-integration`, `test:parity`, `test:coverage`, `test:mutation`, `test:mutation:pr`, `test:mutation:local`, `test:bench`, `test:perf` — 13 downstream tasks. Anything that speeds `tsc` speeds all of them. |
| CI workflow edits are outside `npm run validate` | — | `validate` never parses `.github/workflows/**`. Verification for those edits (W6's cache steps, W10's label gates) is named in **Verification of CI-only edits** under W6 and restated for W10. |
| The `main` ruleset requires exactly one status check | `gh api repos/scolladon/tsgit/rulesets/16502004` | `required_status_checks` names `build` only, with `strict_required_status_checks_policy: true`. Neither `mutation` nor `benchmark-compare` is a required check, so W10's label gate cannot block a merge. |
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
  header cache and at least one that exercises the fsck object cache. *Amended in review:* the
  fsck bound is nightly-measured; the above-cap header-cache eviction reading is a LOCAL-ONLY
  measurement (the 70k-commit fixture cannot fit the nightly budget), recorded in ADR-645's
  amendment, with the eviction logic itself covered by the `insertBounded` unit tests.

**Performance (each with an oracle, below)**

- **R8** The hex-validation frame's self-share in the `log` profile is strictly lower than
  pre-change, same machine/fixture/iterations. *Amended in review:* the committed baseline
  structurally excludes `RegExp:` digest rows, so the evidence lives in raw `--prof-process`
  digests, recorded in `docs/perf/object-id-validation.md` (before 3.9 % of total ticks;
  after: frame absent).
- **R9** The `status` GC tick share on the profiled `status` workload is strictly lower than
  its pre-change value on the same machine/fixture/iterations, **and** the change is attributed
  to a single named construct by an allocation profile captured *before* any code edit, whose
  top site accounts for **≥10 % of allocated bytes** (ADR-650). If no site clears 10 %, the
  requirement is discharged by the recorded finding and no code change — that is a pass, not a
  miss.
- **R10** Peak memory for the fsck memory workload added in R7 is bounded independently of
  total repository blob bytes — *amended in review:* on this Node/V8 the observing metric is
  `rss` (typed-array backing stores are off-heap; `heapUsed` barely tracks blob bytes), and the
  bound is on the RETAINED peak (a transient O(largest blob) spike remains during the build
  pass, see ADR-646's scope note). Demonstrated by two fixture sizes whose blob content
  differs by ≥4× showing sub-linear peak growth.
- **R11** A warm `npm run check:types` (unchanged sources) completes in under half its cold
  time on the measurement host, and a cold run is not slower than today's.
- **R12** Both pilots (vitest pool, prepush worker caps) either show a wall-clock win on
  `npm run test:unit` / `npm run prepush` measured over ≥3 alternating rounds main-vs-branch,
  or are reverted in the same PR. A pilot that ships must not change any test's pass/fail
  verdict.

**Gates**

- **R13** `npm run validate` is green at every commit. Three of its checks move together under
  W9 and must be observed green on the built artifacts, never assumed:
  `check:size` (browser no-build bundle ≤160 kB gzip — measured byte-identical across the split;
  Full library ≤335 kB gzip — measured 186.61 kB today, **284.35 kB after the split**, 84.9 % of
  the budget), `check:tarball` (whose 750 KiB cap the split exceeds — W9 moves the cap and
  records the measurement), and `check:exports` (R17).
- **R14** `reports/api.json` is generated by typedoc from the **source** entry points listed in
  `typedoc.json`, not from `package.json`'s `exports` map nor from `dist/`. Adding 49 export
  subpaths therefore leaves it byte-identical, and `check:doc-typedoc`
  (`git diff --exit-code -- reports/api.json`) stays green on that account alone. It engages the
  moment W9 adds a public **type** re-export to fix a TS2742 leak (W9 lists the 10 leaked type
  names): any such re-export from a typedoc entry point changes `reports/api.json`, and the
  regenerated report must be committed in the same change.
- **R15** No provenance references (phase / ADR / backlog numbers) in source or test code.

**Published surface (W9)**

- **R16** Every subpath the `exports` map publishes resolves in a packed tarball — the 49
  `./commands/<name>` specifiers, `./commands`, and the pre-existing `./commands/index` — and
  `tooling/verify-tarball.sh` fails if any one of them does not (ADR-644). Verified by the guard
  itself plus an out-of-tree resolution probe on the packed artifact.
- **R17** `check:exports` (attw, `--profile node16`) reports every published entry green for
  `node16` (from CJS **and** from ESM) and `bundler`. A wildcard-only entry reports `(wildcard)`
  and proves nothing — pinned in W9 — so the map carries explicit per-command keys.
- **R18** `tooling/dts-entries.ts` enumerates the split without modification, and
  `tooling/truthful-dts.ts` completes over every enumerated entry.

**CI cadence (W10)**

- **R19** The labels `mutation` and `bench` exist in the repository; an unlabelled PR runs
  **neither** the `mutation` nor the `benchmark-compare` job (both render as `skipping`), and a
  PR carrying a label runs the corresponding job. Verified on this PR itself by applying the
  labels and reading `gh pr checks` in both states. Push-to-`main` behaviour is unchanged, and
  `benchmark-snapshot` is untouched (ADR-642).

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
W9 per-command export surface  (independent of W1-W5; internally ordered — see below)
   rollup entries ──► exports keys ──► size-limit rows ──► verify-tarball guard
W10 label-gate mutation + benchmark-compare (independent; workflow only)
W8 vitest pool / prepush pilot (last, because it perturbs the test harness that every
                                other item's gate runs through)
```

`W1` first is not a preference: the committed baseline is the only pre-change artifact the
`log` and `status` oracles can compare against, and it is currently stale by four merged
perf PRs.

`W9` is independent of W1-W5 — different files, no shared symbol — but is **internally**
ordered, and the order is forced rather than chosen:

- the rollup entries must exist before the `exports` keys name them, or every added key
  resolves to nothing;
- the `exports` keys must exist before ADR-644's `verify-tarball` guard can pass, because the
  guard's whole job is to fail on a subpath that resolves to nothing — landing the guard first
  reddens `check:tarball` for exactly as long as the entries are missing;
- the `.size-limit.json` rows must land with the entries, because `check:size`'s `Full library`
  row measures `dist/esm/**/*.js` and the split moves it by +97.7 kB gzip in one step.

`W10` touches only `.github/workflows/ci.yml` and the repository's label set; it shares no file
with any other item and can land anywhere in the sequence. It is listed before W8 only so the
harness pilot stays last.

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

**No staleness guard is added (ADR-652).** A profile frame name is not required to be a live
symbol — V8 emits `<anonymous>`, minifier artefacts and pattern-keyed regular-expression
entries — so a "every named symbol still exists in `src/`" check would false-positive and get
muted, and a regenerate-and-diff job cannot work because shares are machine-dependent. The
staleness mode is recorded as a known limitation instead: the baseline is trusted only as of its
generation commit, and perf work starts by reading `git log -- docs/perf/baseline.json` against
the perf-relevant merges that followed.

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

**Exit criterion (ADR-650) — top site, at 10 % of allocated bytes.** The allocation profile is
captured first, on the unmodified tree. If its **top** site accounts for **≥10 % of allocated
bytes** on the `status` workload, that one site — and only that one — is fixed and re-measured.
Below 10 %, the churn is diffuse: the outcome is a recorded finding and **no code change**.
Either outcome closes the item. One site, not several, keeps the GC-share oracle attributable to
a single edit; the 10 % floor keeps "investigate, then fix" honest in the other direction.

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
(`lru-cache.ts:56-63`) loops while `currentSize > maxSizeBytes || map.size > maxEntries`.

**Sizing, settled (ADR-645): entry-count, cap 65 536.**
`createLruCache<CommitHeader>(Number.POSITIVE_INFINITY, 65_536)` with `set(id, header, 1)`. Both
of `set`'s guards are satisfied (`byteSize <= 0` throws; `byteSize > maxSizeBytes` silently
drops). `currentSize` degenerates into an insert counter and `maxSize` reports `Infinity`;
neither is read here. `CommitHeader` is small and fixed-shape, so entry count is an honest proxy
for bytes, and 65 536 mirrors `DEFAULT_DELTA_CACHE_ENTRIES` (`src/index.node.ts:32`) so the repo
gains no second magic number. The byte-estimated alternative
(`byteSize ≈ (1 + parents.length) × hashHexLength × 2 + 16`) buys accuracy this shape does not
need, and a two-bound cache adds a knob with no reader.

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

That makes a *structural projection* — not an LRU — the fix, and ADR-646 settles it as one:
replace
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

ADR-646 also declines the further step of folding `buildBlobFilenameMap` into the build pass so
tree-entry *names* are never retained either: it moves fsck's special-filename knowledge into
the cache builder, and is worth doing only if W7's oracle shows tree names are material.

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
wireit `files`. **ADR-647 settles exactly that shape**; no other consumer's input changes.

**wireit interaction — the trap that would silently void the win.** `check:types` declares
`output: []` today. wireit's default `clean: true` **deletes declared outputs before running a
task**: declaring the `.tsbuildinfo` as an output without `clean: false` would delete the cache
on every run and leave `tsc` permanently cold. **ADR-648 leaves it undeclared**: `output: []`
stays, wireit keeps caching task *success* exactly as today, and the cache file simply persists
on disk under its already-gitignored name, invisible to wireit. Declaring it with
`clean: false` would additionally survive branch switches through `.wireit/cache` — a secondary
benefit that introduces a caching semantic to a task that has never had one.

The two caches compose rather than compete: wireit skips `check:types` entirely when its input
hashes are unchanged; the TypeScript cache only pays off on the runs wireit *does* execute —
which is exactly the changed-source case that hurts today.

**CI cache shape (ADR-649).** `actions/cache@v6` (floating major, per constraint) around the
`.tsbuildinfo`, restored before and saved after the type-consuming step, keyed
`${{ runner.os }}-${{ node-version }}-${{ hashFiles('tsconfig*.json','package-lock.json') }}`
plus a source-hash suffix, with a `restore-keys` prefix so a source-only change reuses a
near-miss. `runner.os` in the key is mandatory — a Linux cache file is not valid on Windows —
and it also makes cross-OS reuse impossible by construction, which is why an Ubuntu-only cache
would buy nothing this key does not already provide.

**Clean-run authority (ADR-649).** Exactly one job must remain the cold authority so a stale or
poisoned cache file can never mask a type error. That job is `typecheck`: it is the only job
whose sole purpose is `tsc`, it already gates `build` and `unit-tests` through `needs`, and
running it cold costs ~37 s in CI. It **skips the cache entirely** — never restores, never saves
— so no cache file can reach the one job whose only purpose is the check. Restoring without
saving was rejected for exactly that reason.

**Oracle (R11).** Local: `npm run check:types` timed cold (cache file deleted), warm-unchanged,
and warm-after-one-edit, three alternating rounds each, main vs branch. CI: see below.

**Verification of CI-only edits.** `npm run validate` never reads `.github/workflows/**`. The
verification for W6's workflow edit — and for W10's label gates — is:

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

### W9 — Build the per-command export surface

**Decisions this implements.** ADR-640 (build ~49 per-command entries, **in this change** —
folding candidate D5), ADR-643 (add the missing `./commands` barrel key), ADR-644 (extend
`verify-tarball.sh` to resolve every `exports` subpath). The defect this repairs is pinned under
**D1 evidence** below and is unchanged by the revision: `@scolladon/tsgit/commands/add` throws
`ERR_MODULE_NOT_FOUND` and `@scolladon/tsgit/commands` throws `ERR_PACKAGE_PATH_NOT_EXPORTED` on
3.3.0.

#### Measurement method for every number in this section

The split was built, packed and gated in a throwaway directory — a copy of `src/`,
`tsconfig*.json`, `package.json`, `LICENSE`, `README.md` and `tooling/`, with `node_modules`
symlinked to this worktree and `dist/` redirected out of tree. Nothing was written into the
worktree. Two builds were produced from the repo's **own** `rollup.config.ts` (the only edit
being the output directory and the removal of the visualizer plugin, which writes into
`reports/`): a *base* build with today's 11 entries and a *split* build with 60. The base build
reproduces the published package exactly — 94 files, `unpackedSize` 2 486 119 B, matching
`npm view @scolladon/tsgit@3.3.0 dist.fileCount dist.unpackedSize` — and `npx size-limit` run
against it reports `Full library 186.61 kB`, the number this document already carried. That
agreement is what licenses the split numbers below.

#### The entry set, enumerated

`src/application/commands/*.ts` is **50 modules — 49 commands plus `index.ts`**:

```text
abort-merge  add  archive  blame  branch  bundle-create  bundle-list-heads  bundle-verify
cat-file  checkout  cherry-pick  clone  commit  config  continue-merge  describe  diff
fetch  fetch-missing  fsck  grep  init  log  merge  mv  name-rev  notes  pack-objects
pull  push  range-diff  read-file-at  rebase  reflog  remote  reset  rev-list  rev-parse
revert  rm  shortlog  show  sparse-checkout  stash  status  submodule  tag  whatchanged
worktree
```

`src/application/commands/internal/` is **not** an entry directory — it holds shared helpers and
stays behind the chunk boundary.

#### Rollup mechanics, verified against the config

`rollup.config.ts` exports three configs. `entryPoints` (`:8-20`) feeds **two** of them: config
#1 (`dist/esm` + `dist/cjs`) and config #3 (`dist/types`, `.d.ts` + `.d.cts` through
`rollup-plugin-dts`). Config #2 — the no-build browser bundle — takes `src/index.browser.ts`
alone with `inlineDynamicImports: true` and never reads `entryPoints`, so **the split cannot
touch it**. Confirmed rather than argued: `dist/browser/tsgit.js` is byte-identical across the
two builds, `sha256 a1aac9bb5b39096c502a6660351b6a3c55168f95c8cf0f7fb6bdb87a3114fa64`, and
`size-limit` reports 156.04 kB gzip on both. Per-command entries relieve **bundler-using**
consumers; they do not shrink the CDN bundle by one byte.

That corrects a premise the brief carried into ADR-640's context — "this decision also
structurally caps the browser bundle, which is the only real answer to it sitting at 97.5 % of
budget". It does not. The no-build bundle is one inlined file built from `src/index.browser.ts`,
and nothing about per-command entries reaches it. The 97.5 %-of-budget problem is untouched by
W9 and stays open; the decision stands on the broken-specifier repair, which is reason enough.

Chunking is `preserveModules: false` with `chunkFileNames: 'chunks/[name]-[hash].js'`, so shared
modules hoist into `chunks/`. Measured:

| Metric | base — 11 entries | split — 60 entries |
|---|---|---|
| `dist/esm` files | 27 | 203 |
| of which chunks | 16 | 143 |
| chunks reachable from ≥2 entries | 16 (all) | **143 (all)** — no chunk is private to one entry |
| chunk raw size min / p50 / max | — | 34 B / 900 B / 32.6 kB |
| `dist/esm/**/*.js` raw | 564.04 kB | 717.53 kB (+27 %) |
| `dist/esm/**/*.js` gzip (= `size-limit` *Full library*) | **186.61 kB** | **284.35 kB** (+52 %) |
| `dist/cjs` files | 27 | 203 |
| `dist/types` `.d.ts` / `.d.cts` | 18 / 18 | 85 / 85 |
| `dist/browser/tsgit.js` | 156.04 kB gzip | identical bytes |
| rollup wall clock, all three configs | 17.45 s | 17.87 s |

Chunk *sharing* works exactly as the promise assumed — every chunk is reachable from at least
two entries, so the split duplicates no module. The gzip inflation is a **per-file** artefact:
raw bytes grow 27 % while the sum of per-file gzip grows 52 %, because 143 small files each pay
their own gzip window and lose cross-file redundancy (the median chunk is 900 raw bytes; the
smallest is 34). `size-limit`'s `Full library` row sums per-file gzip over the glob, so it reads
the inflated number, not the raw one.

Build wall clock is a non-event: +0.42 s (+2.4 %) for 49 more entries across esm, cjs, the
browser bundle and both declaration formats.

#### `.size-limit.json` — what the rows can actually measure

The repo installs **`@size-limit/file`** (`package.json:826`) and no bundler preset. That preset
measures **the named file's own bytes**, gzipped — it does not follow imports. Pinned: with the
split built, `size-limit` reports `Core (main entry) 7.51 kB` for `dist/esm/index.js`, a file
whose transitive chunk closure is 244 kB. Today's per-entry rows are therefore already
entry-file measurements, which is why `Core` sits at 5.56 kB against a 50 kB limit.

That is the honest answer to the design-doc promise of "1.5 kB gzipped each". Two different
numbers wear that name:

| What is measured | 49 commands: min / p50 / p90 / max |
|---|---|
| **entry file only** — what a `.size-limit.json` row can enforce | 0.27 / 1.33 / 3.93 / **7.79 kB** gzip |
| **entry + its transitive chunk closure** — what a consumer actually downloads | 7.21 / 51.95 / 84.86 / **136.90 kB** gzip |

So: the 1.5 kB figure is roughly right for the *entry file* of a *median* command, and wrong for
every consumer-facing reading of it. `commands.md:1435`'s "importing only `tsgit/commands/init`
ships ~1.5 kB instead of ~20 kB" does not survive measurement — `init` is the cheapest command in
the set and its closure is **7.21 kB**; `submodule`'s is 136.90 kB. The split is still worth
building — it is the difference between a broken specifier and a working one, and a bundler
consumer of `commands/init` pulls 5 files instead of 180 — but the sizing claim must be restated
in the numbers above rather than repeated. Recorded here for the documentation phase; no
`commands.md` edit is owed by this design.

Budgets are therefore sized from the measured entry bytes with ~25 % headroom, in four tiers so
the config gains four constants rather than 49 bespoke ones:

| Budget | Commands (measured entry gzip, kB) |
|---|---|
| **1.5 kB** (21) | show 1.16, whatchanged 1.15, fetch-missing 1.07, worktree 1.07, shortlog 0.99, abort-merge 0.99, pack-objects 0.99, rev-list 0.97, diff 0.97, archive 0.88, log 0.88, continue-merge 0.85, config 0.82, bundle-verify 0.79, status 0.68, read-file-at 0.56, name-rev 0.47, cat-file 0.45, rev-parse 0.42, init 0.29, bundle-list-heads 0.27 |
| **3 kB** (16) | fetch 2.35, add 2.34, grep 2.14, bundle-create 2.14, checkout 2.07, sparse-checkout 2.05, remote 1.82, pull 1.80, clone 1.73, notes 1.71, mv 1.65, tag 1.39, rm 1.33, reset 1.31, reflog 1.24, branch 1.22 |
| **6 kB** (9) | range-diff 4.06, push 4.05, merge 3.93, cherry-pick 3.60, revert 3.51, stash 3.37, describe 2.84, blame 2.51, commit 2.40 |
| **10 kB** (3) | fsck 7.79, rebase 7.62, submodule 4.88 |

Plus one row for the barrel — `dist/esm/commands/index.js`, measured 3.76 kB, budget **6 kB** —
which has no row today at all. That is not the `28 kB` "Commands (barrel)" cap of
`commands.md:194`: that figure was a closure-style estimate (unique code plus shared
`internal/*` chunks counted once), and `@size-limit/file` cannot express it. A single glob row
over `dist/esm/commands/*.js` was rejected too: it sums, so one command doubling in size hides
behind 48 unchanged ones.

**What of the promise text becomes true.** `commands.md:1425` promises "17 export entries: one
barrel and one per command" — after this change the map carries **51** (49 commands, the barrel,
the retained wildcard), because the command set grew from 16 to 49 since that text was written.
`:1433`'s build wiring becomes literally true. `:1435`'s and `:194`'s per-command *byte* claims
do not, for the reason measured above. Those pages are point-in-time records by this repo's
convention, so this design owes them no edit; the numbers here are what the documentation phase
should quote if it decides to refresh them.

The `Full library` row stays at 335 kB and stays green at 284.35 kB — but its reserve falls from
148 kB to **50.6 kB**, which is the number the next bundle-touching change inherits.

#### `exports` map — explicit keys, because a wildcard proves nothing

Pinned with `attw --pack . --profile node16` (the exact `check:exports` command) against the
split build: for `"./commands/*"` attw prints

```text
"@scolladon/tsgit/commands/*"
node16 (from CJS): (wildcard)
node16 (from ESM): (wildcard)
bundler:           (wildcard)
```

— it enumerates `exports` **keys** literally and validates nothing behind a pattern. That is
true before and after the split, and it is why the broken wildcard shipped past a green
`check:exports` in the first place. ADR-640 requires attw coverage for the new entries, so the
map carries explicit keys:

- 49 `"./commands/<name>"` keys, each with the same `import`/`require` × `types`/`default`
  shape as the existing subpath entries;
- `"./commands"` → `dist/*/commands/index.*` (ADR-643);
- `"./commands/*"` **retained** as the catch-all, which is what keeps `./commands/index` — the
  one specifier that resolves on 3.3.0 — working, so nothing is retracted and the semver note
  under D1 evidence is moot.

Explicit keys and the retained wildcard do not fight: Node resolves the most specific match
first. Pinned in a throwaway package on Node v22.22.3 — `exports` carrying both `"./x/*"` and
`"./x/a"` resolves `./x/a` to the explicit target and `./x/b` through the pattern.

With the 61-key map and the split `dist/`, attw reports **61 entries, all green** for
`node16 (from CJS)`, `node16 (from ESM)` and `bundler` (`node10` is ignored by profile, as
today), exit 0, 7.63 s — against 2.54 s for the 11-key map. That is R17's oracle.

#### `tooling/dts-entries.ts` — auto-pickup, confirmed by running it

`getPublishedEntries` walks the `exports` map, expands wildcard subpaths against the files
present under `dist/`, and de-duplicates. Run against the probe root: **20 published entry pairs
on the base build, 118 on the split** — 18 non-command pairs plus 50 command modules × 2 formats,
where the base build's `commands/` directory held only `index`. The count is the same whether the
map reaches those files through the wildcard or through the explicit keys, because the
de-duplication is keyed on the `(dtsPath, runtimePath)` pair. No edit to the module was needed.

`tooling/truthful-dts.ts`, which imports every enumerated entry at build time and rewrites leaked
value exports, completes over all 118 in **0.79 s** and exits 0 — so the last step of `build:js`
absorbs the split without change either.

#### The one thing the split breaks: declaration sharing

`rollup-plugin-dts` warns when an entry's declarations reference a type that lives in a shared
declaration chunk with no public re-export — the TS2742 hazard for downstream consumers. The base
build emits 6 such warnings (the three adapter entries × 2 formats, pre-existing). The split
emits **30**: the same 6, plus 18 new ones across 9 entries × 2 formats:

| Entry | Leaked type names |
|---|---|
| `commands/merge` | `ConflictType`, `IndexEntry`, `MergeConflict`, `MergeOutcome`, `SparseMatcher` |
| `commands/config` | `ConfigKey`, `ConfigScope` |
| `commands/cherry-pick`, `commands/rebase`, `commands/revert`, `commands/stash` | `ConflictType` |
| `commands/reflog` | `ReflogEntry` |
| `commands/add` | `AttributeProvider` |
| `primitives/index` | `ConfigKey`, `ConfigScope`, `IndexEntry`, `ReflogEntry`, `SparseMatcher`, `TreeEntry` |

Two facts to hold together. First, `primitives/index` is in that list and is **not** a new entry
— its declarations are clean today; the split changes how `rollup-plugin-dts` partitions shared
declaration chunks, and a type that was public-by-accident stops being so. Second, these are
warnings: rollup exits 0, `truthful-dts` exits 0 and attw is green, so **no gate is red**. The
consequence is a worse published type surface, not a broken build.

The remedy the warning itself names is to re-export the 10 named types from a public entry. That
is the path on which **R14 engages**: `reports/api.json` is produced by typedoc from the source
entry points in `typedoc.json` — which already include `src/application/commands/index.ts` — so
the 49 new export subpaths change it by exactly nothing, while adding a public type re-export
changes it immediately and the regenerated report must be committed in the same change
(`check:doc-typedoc` is `git diff --exit-code -- reports/api.json`).

#### The tarball cap — the one blocker, measured

`tooling/verify-tarball.sh` caps the packed tarball at `SIZE_CAP = 750 KiB` (768 000 B),
described in the script as "tight by choice: a change that meaningfully grows any of the three
fires the guard for a considered review rather than an automatic bump". It fires.

| Pack | Files | Bytes | vs 768 000 B cap |
|---|---|---|---|
| published `@scolladon/tsgit@3.3.0` (registry) | 94 | 736 732 | 95.9 % |
| probe, base build | 94 | 753 783 | 98.1 % |
| **probe, split build** | **580** | **864 106** | **112.5 % — FAIL** |

The probe packs 2.3 % heavier than the registry tarball (npm/gzip version skew, tar metadata),
so the honest projection for the real split pack is 864 106 × (736 732 / 753 783) ≈ **844 500 B
≈ 825 KiB** — still ~10 % over. The cap must move for ADR-640 to ship. Applying the script's own
convention (cap ≈ 14 % above the honest floor, which is what produced 750 from 656) gives
**940 KiB**; the comment block must be rewritten with the new floor, its composition (dual
runtime + dual declarations, now across 60 entries and 143 chunks) and these measurements, so the
next reader sees why it moved. This is the considered review the guard exists to force, and it is
the one W9 side effect that loosens an existing repo-wide guard rather than tightening one.

#### `verify-tarball.sh` — the resolution guard (ADR-644)

The guard enumerates the `exports` map inside the packed tarball, expands any wildcard against
the packed `dist/`, resolves every concrete specifier and fails on a miss. Two mechanics matter.
It must run against the **packed** tree, not the worktree's `dist/`, or it re-verifies files that
`files: ["dist","LICENSE","README.md"]` might not ship. And it must resolve through Node's own
resolver rather than by path arithmetic — the defect it guards against is a *resolution* failure,
and the D1 evidence probe (a throwaway directory with the package symlinked into
`node_modules/`) is the shape to reuse. The guard and the explicit keys land together; landing
the guard first would redden `check:tarball` until the entries exist.

#### Gate interactions, gathered

| Gate | Effect |
|---|---|
| `check:size` | `Full library` 186.61 → 284.35 kB against a 335 kB limit (green, reserve 50.6 kB); 50 new rows; browser bundle unchanged |
| `check:tarball` / `verify:tarball` | **red until `SIZE_CAP` moves** (measured above); gains the resolution guard |
| `check:exports` | 11 → 61 attw entries, all green; runtime 2.54 → 7.63 s |
| `check:doc-typedoc` | unchanged by the entries; engages only if a public type re-export lands |
| `build:js` | +0.42 s rollup; `truthful-dts` now imports 118 entries in 0.79 s |
| `check:filesystem` (ls-lint) | no new source file — every entry is an existing kebab-case module |
| `check:architecture` | no new import edge; the split is a build-time partition |
| coverage / mutation | no `src/**` edit, so neither moves |

---

### W10 — Label-gate the two heavy PR jobs

**Decisions this implements.** ADR-641 (`mutation` runs only on a PR carrying a `mutation`
label) and ADR-651 (`benchmark-compare` runs only on a PR carrying a `bench` label). The two
labels are deliberately distinct so each heavy job toggles independently. ADR-641 chose the label
gate **instead of** the `timeout-minutes` guard this design originally recommended, so no timeout
is added. ADR-642 leaves `benchmark-snapshot` alone; the D3 evidence below stays as record.

**Anchors (verified).**

```text
.github/workflows/ci.yml:283-285   mutation:          if: github.event_name == 'pull_request'
                                                      needs: [unit-tests]
.github/workflows/ci.yml:525-527   benchmark-compare: if: github.event_name == 'pull_request'
                                                          && needs.changes.outputs.code == 'true'
                                                      needs: [changes, unit-tests]
.github/workflows/ci.yml:3-7       on: push[main] + pull_request[main]   ← no `types:` key
.github/workflows/ci.yml:9-11      concurrency: ci-${{ github.ref }}, cancel-in-progress: true
```

**The `if:` shape.** One conjunct added to each existing condition, nothing else:

```yaml
mutation:
  if: >-
    github.event_name == 'pull_request' &&
    contains(github.event.pull_request.labels.*.name, 'mutation')

benchmark-compare:
  if: >-
    github.event_name == 'pull_request' &&
    needs.changes.outputs.code == 'true' &&
    contains(github.event.pull_request.labels.*.name, 'bench')
```

`github.event.pull_request` carries the PR object as of the event, whose `labels` is an array of
objects with a `name` — the object-filter form `labels.*.name` yields the name list and
`contains` tests it. On a `push` event that context is absent, the filter yields nothing and
`contains` is false; both jobs already carry the `github.event_name == 'pull_request'` conjunct,
so push behaviour is unchanged twice over. `benchmark-snapshot` (`if: github.event_name ==
'push'`) is not touched.

The `mutation` job's **inner** skip — `compute-mutation-scope.sh` setting `skip=true` when the
diff touches no `src/` file — is orthogonal and stays exactly as it is. The label decides whether
the job runs; the scope script decides whether a running job does work.

**`needs:` edges — counted, not assumed.** Every `needs:` in `ci.yml`, read off the file:
`typecheck`/`dead-code`/`duplicates`/`architecture` → `changes`;
`doc-links`/`doc-coverage`/`doc-typedoc`/`test-pyramid-audit` → `lint, typecheck`;
`build`/`unit-tests` → `changes, lint, typecheck`;
`integration`/`posix-integration`/`win-integration`/`parity-tests` → `changes, unit-tests`;
`parity-deno`/`parity-bun`/`parity-workers` → `changes, build`; `e2e` → `changes, integration`;
`mutation` → `unit-tests`; `benchmark-snapshot` → `unit-tests`;
`benchmark-compare` → `changes, unit-tests`.

**No job declares `needs:` on `mutation` or on `benchmark-compare`.** Both are leaves, so a
skip propagates to nothing — there is no `if: always()` aggregator downstream to reason about,
and the "a skipped job blocks the jobs that need it" failure mode does not arise. `cancel-on-merge.yml`
is likewise unaffected: it cancels *in-progress runs* for the merged head SHA
(`listWorkflowRunsForRepo` filtered `status: 'in_progress'`), and a skipped job is not a run.

**How a skip reads to the merge policy — pinned.** The `main` branch has no legacy branch
protection (`/branches/main/protection` → 404 *Branch not protected*); the policy is repository
ruleset `main` (id 16502004, `enforcement: active`), whose `required_status_checks` rule names
exactly one context: **`build`**, with `strict_required_status_checks_policy: true`. Neither
label-gated job is a required check, so gating them cannot block or unblock a merge. The
operator-facing view is `gh pr checks`, which renders a job-level skip as `skipping` and does not
count it as a failure — measured on PR #275, where `benchmark-snapshot` (push-only, therefore
always skipped on a PR) prints exactly that row today and `gh pr checks` still exits 0. A
label-gated `mutation` will look precisely like `benchmark-snapshot` looks now.

**The labels do not exist yet.** `gh label list` returns twelve labels: the nine GitHub defaults
(`bug`, `documentation`, `duplicate`, `enhancement`, `good first issue`, `help wanted`,
`invalid`, `question`, `wontfix`), `dependencies`, and the two the release bot manages. Neither
`mutation` nor `bench` is present. Creating both — `gh label create mutation`, `gh label create
bench` — is part of W10, and it is not optional bookkeeping: a `contains()` against a label
nobody can apply is permanently false, which would silently retire both jobs rather than gate
them.

**Re-run behaviour — the operational consequence.** `on.pull_request` declares no `types:`, so
the default trigger set applies: `opened`, `synchronize`, `reopened`. A `labeled` event is not in
that set, and re-running an existing run replays that run's original event payload — including
its label list as it stood then. **Adding a label to an already-open PR therefore does not, by
itself, produce a run in which the gated job appears.** The label takes effect on the next
`synchronize` (any push to the PR branch) or on `reopened`. Operationally: apply the label at
open time when the signal is wanted, or push after labelling; a close→reopen is the cheapest
forcing move on a PR with nothing left to push.

Adding `labeled` to `types:` would remove that friction and is deliberately not part of this
change: the workflow's concurrency group is `ci-${{ github.ref }}` with `cancel-in-progress:
true`, so a label event arriving mid-run would cancel the entire in-flight matrix and restart it
— trading a documented two-step for an unpredictable one. Recorded so the trade is visible if
the friction turns out to bite.

**Oracle (R19).** Verified on this PR itself, in three readings of `gh pr checks`:

1. unlabelled — neither `mutation` nor `benchmark-compare` appears as a running job; both read
   `skipping`, alongside the `benchmark-snapshot` row that already does;
2. after applying both labels **and pushing** — both jobs run;
3. `gh api repos/scolladon/tsgit/actions/runs/<id>/jobs` for the labelled run, showing each
   job's `conclusion` and duration, so the recovered PR wall clock is an absolute number
   (reference points from the D2/D13 evidence below: `mutation` 22 s–47 m, `benchmark-compare`
   23 m 15 s on run 31945837471).

Step 2 is also the empirical confirmation of the re-run behaviour described above: if the job
appears without a push, the payload-replay reasoning was wrong and this section is corrected in
place rather than left standing.

**Verification of the workflow edit** is the same three-step ladder given under W6 — megalinter's
YAML syntax check (which catches malformed YAML and nothing semantic), a green CI run on the PR,
and post-merge run timings.

---

### The three decision-gated items — pinned evidence

All three are now decided (ADR-640/643/644, ADR-641/651, ADR-642). The evidence that grounded
the ADR conversation is kept verbatim below as the record behind those decisions — including the
D3 measurements, which argued for a cadence change the user declined.

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
split up automatically — that piece is pre-built. ADR-640 took that branch; W9 carries the
measured version of every one of these estimates, and corrects two of them (attw covers explicit
keys only, and the entry count is 60 rather than 49+11 because the barrel joins them).

`check:exports` (attw) does **not** currently catch either failure: it validates the entries it
can resolve and says nothing about a wildcard with no matching files. ADR-644 adds the guard that
does (W9).

**Semver note.** Removing `"./commands/*"` from `exports` would also remove the one specifier
under it that resolves today, `@scolladon/tsgit/commands/index` — undocumented, but working on
3.3.0, so a retraction would be a breaking change to the published surface under a strict reading
of semver. ADR-640 builds instead of retracting and ADR-643 adds `"./commands"`, and W9 keeps the
wildcard alongside the explicit keys, so nothing that resolves today stops resolving: the note is
recorded as the hazard that was avoided, not one that is live.

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
`mutation`.

**How this decided.** The refutation held, and the user still gated the job — for a different
reason than the brief's: the repo's merge policy already treats `mutation` as informational (the
local diff-scoped Stryker run plus triage is the real gate), so on most PRs the job spends a
runner for tens of minutes on a signal nobody waits for (ADR-641). The incidental
`benchmark-compare` observation was pulled into scope by the same conversation and gated the same
way (ADR-651). Both are implemented in W10; no `timeout-minutes` guard is added.

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

**How this decided.** The user kept the per-merge cadence (ADR-642): one bisectable trend point
per merge is worth the 12-18 minute tail, and the two observed failures stay visible rather than
being silenced by `continue-on-error`. **Nothing in this change edits `benchmark-snapshot`** —
no cadence change, no job move, no `bench.yml` fold-in. The measurements above are kept as the
record of what that granularity costs, so the next reader does not re-measure it. Note the
interaction with W10: after ADR-651, `benchmark-compare` no longer runs on an unlabelled PR, so
on those PRs the *only* benchmark signal on the merge path is this per-merge snapshot — which is
part of why keeping it matters more now than it did when the evidence was taken.

---

## Decision candidates — all 14 settled

**D1-D3 were the brief's own three user decisions; D4-D14 were further load-bearing choices
uncovered while designing. Every one is now decided and recorded as an ADR** — thirteen ADRs for
fourteen candidates, because D5 (own run vs this PR) is folded into ADR-640's ratification. The
table below is kept as the record of what was on the table; the **Outcome** column is what binds
this design, and it wins over the Recommendation column wherever the two disagree.

| # | Outcome | ADR |
|---|---|---|
| D1 | Build ~49 per-command entries — **deviates** from the recommendation to retract | [ADR-640](../adr/640-per-command-export-surface-is-built-in-this-change.md) |
| D2 | Gate the PR `mutation` job behind a `mutation` label — **deviates** from "keep as-is + timeout guard" | [ADR-641](../adr/641-pr-mutation-job-is-label-gated.md) |
| D3 | `benchmark-snapshot` stays per-merge — **deviates** from the recommendation to go nightly | [ADR-642](../adr/642-benchmark-snapshot-stays-per-merge.md) |
| D4 | Add the `"./commands"` barrel subpath — as recommended | [ADR-643](../adr/643-commands-barrel-subpath-is-exported.md) |
| D5 | The split rides **this** PR — folded into D1's ratification, **deviates** from "own run" | [ADR-640](../adr/640-per-command-export-surface-is-built-in-this-change.md) |
| D6 | `verify-tarball.sh` resolves every `exports` subpath — as recommended | [ADR-644](../adr/644-verify-tarball-resolves-every-exports-subpath.md) |
| D7 | Header cache entry-capped at 65 536 — as recommended | [ADR-645](../adr/645-commit-graph-header-cache-is-entry-capped.md) |
| D8 | fsck cache stores a structural projection — as recommended | [ADR-646](../adr/646-fsck-object-cache-stores-a-structural-projection.md) |
| D9 | Dedicated `tsconfig.typecheck.json` — as recommended | [ADR-647](../adr/647-typecheck-owns-a-dedicated-incremental-tsconfig.md) |
| D10 | `.tsbuildinfo` stays an undeclared wireit output — as recommended | [ADR-648](../adr/648-tsbuildinfo-is-not-a-declared-wireit-output.md) |
| D11 | Cache key + `typecheck` skips the cache entirely — as recommended | [ADR-649](../adr/649-ci-tsbuildinfo-cache-keying-and-cold-authority.md) |
| D12 | Top allocation site only, at a **10 %** threshold — recommendation adopted, threshold set by the user | [ADR-650](../adr/650-status-churn-fix-gate-is-top-site-at-ten-percent.md) |
| D13 | `benchmark-compare` label-gated behind `bench` — **deviates** from "out of scope, record only" | [ADR-651](../adr/651-benchmark-compare-is-label-gated.md) |
| D14 | No staleness guard for the perf baseline — as recommended | [ADR-652](../adr/652-no-staleness-guard-for-the-perf-baseline.md) |

Four ratifications deviate from the design's recommendation (D1/D5, D2, D3, D13). Three of them
add work — **W9** (D1, D5, D4, D6) and **W10** (D2, D13) — and one removes it: D3 means
`benchmark-snapshot` is not touched at all.

The original candidate table follows unedited, as the record of the alternatives each ADR chose
between. Read it as history: where a Recommendation below differs from the Outcome above, the
Outcome is what ships.

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

### W9 — the published surface

No unit test is owed: W9 adds no `src/**` code, so there is nothing to drive Red-Green with, and
a unit test asserting the *content* of `package.json` would assert the diff back at itself. The
verification is executable and lives in the harness the change extends:

- **The resolution guard is the test (R16).** `verify-tarball.sh` resolves every `exports`
  subpath — 49 command keys, `./commands`, `./commands/index` through the retained wildcard, and
  the 10 pre-existing entries — against the **packed** tarball, from an out-of-tree consumer
  directory with the package symlinked into `node_modules/`. It fails on the first miss. Its own
  negative proof is cheap and should be taken once during implementation: delete one built entry
  file, confirm the guard goes red, restore it. A guard nobody has seen fail is a guard nobody
  has tested.
- **`check:exports` is the type-side test (R17).** 61 attw entries, all green for
  `node16 (from CJS)`, `node16 (from ESM)` and `bundler`; a `(wildcard)` line anywhere in the
  output for a command subpath means the explicit keys did not land.
- **`check:size` is the budget test (R13).** 50 new rows must be green on the real build, and
  the `Full library` row must be **observed**, not assumed — the split moves it by +97.7 kB in
  one commit.
- **`check:tarball` is the packaging test (R13).** Expected red until `SIZE_CAP` moves; the new
  cap must be justified in the script's comment by the measured pack, not rounded up until green.
- **The declaration warnings are read, not ignored.** The rollup build's
  `still references private shared type exports` warnings are counted before and after (6 → 30);
  any change in that set is a change to the published type surface and is reported with the
  implementation, together with `reports/api.json`'s state (R14).

### W10 — the CI gates

No test artifacts and no local proof: GitHub expression evaluation cannot be exercised on this
machine, and `npm run validate` never parses `.github/workflows/**`. The verification is the
three-reading oracle in the W10 section, executed on this PR (R19) — unlabelled, labelled +
pushed, and the per-job timing pull — plus megalinter's YAML syntax check. Both label-creation
commands are part of the change, and the unlabelled reading is worthless unless the labels exist
at the time it is taken.

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

Added by this design, and re-scoped by the ADRs:

- **`benchmark-snapshot`, in every respect** — cadence, placement, `continue-on-error`. ADR-642
  keeps it per-merge; no line of that job changes. Its measured 12-18 minute solo tail stays as
  recorded evidence.
- **A `timeout-minutes` guard on `mutation`** — ADR-641 chose the label gate *instead*, so no
  timeout is added. Reopening it would need a runaway run the label gate did not prevent.
- **Adding `labeled` to the workflow's `pull_request` `types:`** — W10 records why (the
  cancel-in-progress concurrency group would restart the whole matrix on a label event) and
  accepts the two-step instead.
- **Any change to the `gh-pages` branch** — it is the benchmark data branch, not a website, and
  after ADR-642 nothing in this change writes to it differently.
- **Folding `buildBlobFilenameMap` into fsck's cache build pass** — ADR-646 declines it unless
  W7's oracle shows tree-entry names are material.
- **Re-exporting the 10 leaked declaration types from a public entry** — W9 measures and names
  them; whether to publish them is a public-API question with an `api.json` consequence, and it
  is not forced by any red gate here. Raised with the implementation, not decided by this design.
- **`typedoc.json`'s entry points** — the 49 command modules are already documented through the
  barrel entry, so the split adds no typedoc entry and no `reports/api.json` churn (R14).
- **`ObjectId.fromRaw`** — its trusted-path skip is already proven vacuous
  (`object-id.ts:21-24`) and stays as-is (R2).
- **The other 11 `/^[0-9a-f]{40}$/` literals** in `src/` — none is on a profiled hot path, so
  converting them would be churn without an oracle.

**No longer out of scope** (both were, in the accepted draft): the per-command split is **in**
(ADR-640 → W9), and `benchmark-compare`'s 23-minute PR tail is **in** (ADR-651 → W10).
