# Design — status:clean performance investigation (containment tax vs regression)

> Brief (backlog 26.7a, surfaced by the 26.7 competitor-comparison measurement, 2026-07-13):
> On a clean CI runner tsgit's `status:clean` measures **0.67×** isomorphic-git (tsgit
> slower), where the stale pre-Phase-26 baseline (#65, macOS M3) recorded **1.10×** (tsgit
> faster). `status` is tsgit's `lstat`-heavy path — it does an extra path-containment check
> (a security property iso-git skips), the same gate 26.4 optimised (`checkContainment` +
> the `parentRealpathCache`). 26.7 traced the shift to that documented containment tax + a
> cross-OS/stale baseline, **not** a confirmed regression, but did not run the definitive
> test. This investigation runs it: a **same-host historical bench** (current `main` vs a
> pre-26.4 commit on one machine, ratio load-independent) plus a **`status` profile**
> (`npm run profile status`) to attribute the cost. Question: is the gap the containment
> tax alone or a genuine regression — and if the tax is heavier than necessary on the
> clean-tree scan, amortise it (verify 26.4's parent-realpath LRU covers the full
> working-tree scan path). Should land before 26.5 locks the final numbers.
> Status: draft → self-reviewed ×3 → **ADR conversation resolved: D1 = B, D2 = b, D3 = a**
> (ADRs 485+ pending) → re-reviewed ×3.

This is a **diagnosis-first** design. The two definitive tests the backlog names have
already been run; their raw results are captured below and the findings are stated as
conclusions. The forward-looking part, decided in the ADR conversation, is a
**provably behaviour-preserving Candidate B amortisation** of the containment hot path
(B1 + B2 + B3; B4 and the `policy.resolve` hoist rejected as unfaithful), a same-host
before/after bench plus a full committed-baseline refresh, and the docs/backlog surface that
resolves the 26.7 follow-up note.

## Findings — the diagnosis is complete

### Finding 1 — no regression. 26.4 *improved* status; the shift is a cross-OS / stale-baseline artifact.

**Same-host historical bench.** `5820c789` (PR #225, "optimise the node fs containment hot
path") is the 26.4 commit that added `parentRealpathCache` + await-gate + closure hoist to
`checkContainment`. Current `main` (`f5829c96`) was benched against a detached worktree at
`5820c789~1` = `6f52886f` (#224, pre-containment-opt) **on the same host**. The bench
harness (`status.bench.ts` / `bench-dsl.ts` / `vitest.bench.config.ts`) is byte-identical
across the range — only `fixtures.ts` grew additively and `setupSmallRepo` is unchanged —
so this is apples-to-apples. `vitest bench … status.bench.ts -t clean`, tsgit `min` (the
floor is the least-noise estimator), two rounds:

| ref | tsgit min (ms) | tsgit mean (ms) | iso-git min (ms) |
|---|---|---|---|
| main (`f5829c96`) | 4.65 / 4.59 | 5.42 / 7.87 | ~2.3 |
| pre-26.4 (`6f52886f`) | 5.34 / 5.91 | 6.14 / 8.10 | ~2.3 |

iso-git's floor (~2.3 ms) is constant across both refs → same-host validity confirmed
(the pinned dependency's code cannot change, so a constant iso-git number proves the two
tsgit runs saw the same machine conditions). **Main's `status:clean` floor is ~13–22%
FASTER than pre-26.4** across both rounds. 26.4's containment optimisation *improved*
status; it did not regress it.

The absolute numbers here are session-load-biased (measured on macOS under interactive
load — the exact bias `performance.md` documents, where iso-git itself runs 1.2–2.4×
slower under load). They are **not citable** and are not committed. Only the **ratio**
(main vs pre-26.4, load-independent because both ran on the same host in the same session)
and the **direction** are load-bearing. The published 0.67× lives on the CI nightly runner
(`linux-x64` / AMD EPYC 7763); the stale 1.10× came from macOS M3 (#65). The
0.67×-vs-1.10× shift is therefore a **cross-OS / stale-baseline artifact** (syscall-heavy
`lstat` ratios shift by OS and by measurement host), not code drift on `main`.

### Finding 2 — the gap vs iso-git IS the containment tax (46% of status self-time), not the syscall or the diff.

**`npm run profile status`.** V8 CPU self-shares on the 20k-file `MEDIUM_FIXTURE` clean
scan (captured, then reverted — see the baseline-artifact constraint in D2; this table is
transcribed from the capture, not committed):

| frame | self-share |
|---|---|
| `resolveForMode` | **0.26** |
| `checkContainment` | **0.20** |
| `compareWorkingTreeDelta` (the real status diff) | 0.09 |
| `lstat` (fsOps wrapper) | 0.08 |
| `loadCappedUtf8` | 0.06 |
| `guard` | 0.04 |

The pure-JS containment path — `resolveForMode` (0.26) + `checkContainment` (0.20) — is
**46% of status self-time**. That is the machinery iso-git skips entirely: it is neither
the `lstat` syscall (0.08) nor the actual working-tree diff (`compareWorkingTreeDelta`
0.09). This is the tax, and it dominates the frame. The gap vs iso-git on `status:clean`
is the containment security property, paid per working-tree entry, exactly as
`performance.md` frames it.

### Finding 3 — 26.4's parent-realpath LRU fully covers the working-tree scan path; no thrash at bench scales.

Traced through `src/adapters/node/node-file-system.ts`: the status scan's `lstat` flows
`lstat()` → `checkContainment(path, 'lstat')` → `resolveForMode` lstat-arm →
`cachedParentRealpath(parent)` (LRU keyed by the raw parent dir,
`parentRealpathCache = createLruCache(128 * 1024, 512)`) → post-check. So the scan path
**does** use the 26.4 LRU (the backlog's "verify 26.4's parent-realpath LRU covers the
full working-tree scan path" — confirmed):

- `status:clean` fixture (`setupSmallRepo({ commits: 50 })`) is **flat** (`f0000.txt` …
  `f0049.txt`, all in `cwd`) → **1 parent dir** → 1 realpath + 49 LRU hits.
- `MEDIUM_FIXTURE` is sharded `d${⌊i/512⌋}/f${i}.dat`, `SHARD_SIZE = 512` → **~40 parent
  dirs** for 20k files → 40 ≪ the 512-entry LRU.

The LRU fully covers the working-tree scan at both bench scales; there is no thrash. The
only regime that would thrash is a pathological tree with **>512 distinct parent
directories** — a documented cache bound, unexercised by any bench and out of scope for
the clean-flat scenario this item targets.

### Finding 4 — the tax is "heavier than necessary": redundant per-lstat work is amortisable.

On POSIX (linux CI + tsgit-treats-macOS-as-case-sensitive → `posixPolicy`),
`normalizeForCompare` is **identity** (`path-policy.ts`: `caseInsensitive ?
…toLowerCase() : path`). So the tax is **not** case-folding — it is `nodePath` string ops
and redundant allocations per lstat. The remaining redundancy, read from the live code:

- `checkContainment` (node-file-system.ts) **already** normalises both roots once per call
  (`getNormalizedRootDir` / `getResolvedNormalizedCanonicalRoot`) and threads
  `normRoot`/`normCanon` into `resolveForMode`. That part is already amortised — 26.4 did
  it. This design does **not** re-litigate it.
- But `pathContainsNormalized(normalizedParent, child)` still recomputes
  `normalizedParent + policy.sep` **on every call**, and calls `normalizeForCompare(child)`
  **on every call**. `isContainedInEitherRoot(abs, normRoot, normCanon)` calls
  `pathContainsNormalized` twice (once per root), so **the child is normalised twice** and
  the two roots' `+ sep` forms are recomputed per invocation.
- The lstat hot path invokes `isContainedInEitherRoot` **twice** per lstat — the
  `resolveForMode` lstat-arm pre-check and the `checkContainment` post-check — so per
  lstat: **4× `normalizedParent + sep` string concats + 4× `normalizeForCompare(child)`**,
  where `normRoot`/`normCanon` are constants for the adapter lifetime and (on POSIX) the
  child normalise is identity but the two concats are not.

That redundant work lands directly on the 46% frame. It is amortisable **without changing
any containment verdict** — the decision is a set of `startsWith(root + sep)` /
equality tests whose inputs are unchanged; only *when* and *how many times* the constant
prefixes are materialised changes.

## Faithfulness / security constraint (binding on any amortisation)

Path containment is a **tsgit security property, not a git behaviour** (see
`docs/understand/security.md` — "Path containment"). No ADR currently diverges from
git-faithfulness here because there is nothing git-observable to diverge from: the
containment check is a tsgit security addition governed by the **security model**, not by
byte-parity with the git CLI. Consequences for this design:

- Any amortisation MUST be **provably behaviour-identical**: the same containment verdict
  (`return real` vs `throw permissionDenied`) for **every** input, on **both** POSIX and
  Windows (`posixPolicy` and `windowsPolicy`, since `normalizeForCompare` differs between
  them — identity vs `stripWinExtendedPrefix(...).toLowerCase()`).
- This is a **security-boundary hot path**, not ordinary code. Two shapes of amortisation
  appear below, each with the same bar: **B1/B2** are "precompute-a-constant /
  dedupe-a-redundant-normalise" — the compared inputs are bit-identical, only materialised
  once. **B3** changes the *granularity* at which the verdict is computed (once per parent
  instead of once per entry) — allowed **only** because the per-parent verdict is **proven
  verdict-identical** to the per-entry one for a single clean leaf (see B3), not because it
  is cheaper. Any cut whose verdict is not provably identical on **both** policies is
  REJECTED (see B4 and the `policy.resolve` note).
- No interop test / faithfulness matrix is pinned by this item: it asserts no
  git-observable behaviour. The proof obligation is the **security-property unit + mutation
  net** already guarding `checkContainment` / `pathContains` / `isContainedInEitherRoot` /
  `cachedParentRealpath` (the `checkcontainment-hot-path.md` design's test surface), extended
  to cover the B1/B2 precomputed-prefix path **and the B3 per-parent verdict cache**
  (first-call-vs-hit, cached-`false`-still-throws, invalidation, read/creation arms
  untouched) on both policies. The repo's stance favours shipping a hot-path perf win in-PR
  when it is guarded by the test net (per the hot-path-perf preference); the win must
  additionally be validated by a same-host before/after `status` bench.

## Design — Candidate B amortisation (D1 = B, decided)

**Decided: D1 = B** — A's two minimal cuts as the baseline, PLUS a deeper per-entry
reduction. Because every cut here sits on the security-boundary containment path, each is
stated with an explicit **faithfulness verdict — SAFE (ship) or REJECTED (unfaithful)** —
proven against the live `resolveForMode` / `checkContainment` code and required to hold on
**both** `posixPolicy` and `windowsPolicy`. The change is confined to
`src/adapters/node/node-file-system.ts` and does not alter what the security prefix-check
compares — only *when* and *how many times* the constants are materialised, and *at what
granularity* the verdict is computed.

### B baseline — A's two cuts (SAFE, ship)

**B1 — precompute the `+ sep` root prefixes once (SAFE).** The roots are constant for the
adapter lifetime; the adapter already memoises `normalizedRootDir` /
`normalizedCanonicalRoot`. Add their `+ policy.sep` forms as sibling memoised fields (the
canonical one populated/cleared on the exact `getCanonicalRoot()` success/rejection arms
that already govern `normalizedCanonicalRoot`) so the per-call `normalizedParent +
policy.sep` concat inside the predicate is not recomputed on the hot path. **Verdict SAFE:**
string concat of two lifetime-constants; the compared prefix bytes are identical.

**B2 — single-normalise the child per `isContainedInEitherRoot` (SAFE).** Today the child
is `normalizeForCompare`d once inside each of the two `pathContainsNormalized` calls.
Normalise the child **once** in `isContainedInEitherRoot`, then run — for each root — the
same two arms: the **equality arm** against the bare normalised root (`c === normRoot`)
**and** the **prefix arm** against the precomputed `normRoot + sep`. Both arms are retained
per root (dropping the `===` arm would deny a child that IS the root). **Verdict SAFE:**
`normalizeForCompare` is a pure function of the child; calling it once vs twice yields the
identical value on both policies.

### B deeper cut — per-parent containment-verdict cache (SAFE, the headline win)

**B3 — amortise the lstat-arm POST-check verdict per parent directory (SAFE).** This is the
real deeper win and the reason D1 = B. The `checkContainment` post-check
`isContainedInEitherRoot(real, …)` runs once per entry, but on the flat/shard scan every
entry under one directory shares a parent, so the post-check verdict is redundant N-ways.

Proof it reduces to a per-parent verdict. On the lstat arm, `real = policy.join(realParent,
basename)` where:
- `resolved = policy.resolve(toAbsolute(path, rootDir))` — already fully resolved: no `.` /
  `..` segments, native separators (the `checkContainment` comment pins this).
- `basename = policy.basename(resolved)` — a **single clean trailing component** (no
  separator, no `..`, because `resolved` was `policy.resolve`d and the lstat-arm PRE-check
  `isContainedInEitherRoot(resolved)` already passed).
- `realParent = realpath(dirname(resolved))` — the OS-resolved parent, symlinks on the
  parent chain followed. The leaf is deliberately **not** followed (lstat semantics); a
  symlink leaf is handled by `lstat`, never by containment.

The load-bearing invariant is that **`basename` is a single clean component** — no
separator, no `.`/`..` — because `resolved` was `policy.resolve`d (which eliminates every
`.`/`..`, so `policy.basename(resolved)` is a plain final component and can never be `..`).
Given that, `policy.join(realParent, basename)` = `realParent + sep + basename` with no
`join`-normalisation surprises (`realpath` output carries no trailing separator except a
bare fs root, which is never a repo `rootDir`). Containment is `c === root ||
c.startsWith(root + sep)`, so for a single clean leaf:
- If `realParent` is contained (`realParent === root` or `realParent.startsWith(root+sep)`),
  then `realParent + sep + basename` still `startsWith(root + sep)` → **contained**.
- If `realParent` is NOT contained, `realParent + sep + basename` cannot `startsWith(root +
  sep)` (it did not before appending a deeper segment) and cannot equal `root` (it is
  strictly longer) → **not contained**.
- **Degenerate empty-leaf case** (`basename === ''`, only for a bare-root `resolved`):
  `join(realParent, '')` = `realParent`, so `real === realParent` and the equivalence is
  trivial. No divergence.

So `isContainedInEitherRoot(join(realParent, basename))` ≡ `isContainedInEitherRoot(realParent)`
for a single clean leaf — **verdict-identical on both policies** (the argument is pure
prefix algebra over `normalizeForCompare`, which distributes over the constant separator
join: `normalize(a + sep + b)` starts with `normalize(a) + sep` on both the identity and the
`toLowerCase`+strip policy, because a single clean leaf adds no `\\?\` prefix and lowercasing
is per-character). The security-critical case — a **parent that symlinks OUT** of the root —
is caught unchanged: `realParent` is then not contained → cached `false` → `permissionDenied`,
exactly as the per-entry post-check threw. Therefore the post-check verdict can be computed
**once per parent** and memoised beside the existing `parentRealpathCache` realpath value: N
files under one shard dir → **1 containment check, not N**, pairing exactly with 26.4's
per-parent realpath cache.

**Cache-coherence obligations (part of the SAFE verdict — the refactor is only faithful if
all hold):**
- The per-parent verdict is keyed by the **same raw parent key** `parentRealpathCache` uses
  (the pre-realpath `parent` string), and is populated in `cachedParentRealpath` right after
  the realpath resolves — so a cached realpath and a cached verdict are always set together
  and never diverge.
- It is invalidated on the **exact same events** as `parentRealpathCache`: `rename` and
  `rmRecursive` call `parentRealpathCache.clear()`; the verdict cache clears in the same
  place (a parent's realpath — hence its containment — can change under a rename). `rm`
  leaves both untouched (it only removes leaves; the parent realpath is unchanged), which
  stays correct.
- The PRE-check (`isContainedInEitherRoot(resolved)` on `resolved`, the pre-realpath lexical
  form) is **unchanged** — it guards against `resolved` escaping lexically and must still run
  per entry (it is cheap after B1/B2 and defends the fail-fast the comment describes). Only
  the POST-check (on the realpath'd `real`) is amortised per parent.
- The `read` arm is **not** touched by B3: it does a full `realpath(resolved)` of the leaf
  (not `join(realParent, basename)`), so the leaf-is-clean invariant does not hold there and
  its per-entry post-check stays. B3 is scoped to the `lstat` arm — which is the status
  scan's path.

### B micro-cut — dirname/basename single split (REJECTED)

**B4 — replace `policy.dirname(resolved)` + `policy.basename(resolved)` with one
last-separator split (REJECTED).** A hand-rolled last-`sep` split does **not** reproduce
`nodePath.dirname`/`basename` semantics across edge cases — trailing separators, a root-only
path (`dirname('/') === '/'`, `basename('/') === ''`), Windows drive/UNC roots
(`dirname('C:\\') === 'C:\\'`), and repeated separators. Getting the parent key subtly wrong
would silently desync it from `parentRealpathCache`'s key (which uses `policy.dirname`),
splitting the cache and — worse on the security path — could hand the post-check a
mis-derived parent. **Verdict REJECTED:** the micro-saving (one string scan per entry) is
not worth re-deriving battle-tested path semantics on a security boundary; keep
`policy.dirname` / `policy.basename`. B3 already delivers the per-parent win without it.

### The per-entry `policy.resolve(toAbsolute(...))` is REQUIRED (not a cut)

**Skipping or caching `resolved = policy.resolve(toAbsolute(path, rootDir))` is REJECTED.**
The `checkContainment` comment pins why it must run per entry: `policy.resolve` normalises
embedded `..` / `.` segments **and** foreign separators (a `/` in Windows input), and the
adapter is **contractually allowed** to receive mixed-separator, `..`-bearing input. It is
the step that makes the lexical PRE-check compare like-for-like and neutralises `..`
traversal before any I/O — the first line of the containment defence. It is per-`path` (not
per-parent) and cannot be hoisted or cached without weakening the escape check. **Verdict
REJECTED as a cut — it is load-bearing security, kept as-is.**

### Pre-chewed context blocks (every symbol the plan will touch, D1 = B)

**`src/adapters/node/node-file-system.ts`** — the containment hot path.
- `pathContainsNormalized(normalizedParent, child, policy)` — the predicate that
  recomputes `normalizedParent + policy.sep` and `normalizeForCompare(child)` per call.
  This is the leaf to specialise: either add a variant that takes a **pre-`+sep`ed** parent
  and a **pre-normalised** child, or fold the two-root comparison into
  `isContainedInEitherRoot` directly. Keep `pathContainsNormalized` and its public sibling
  `pathContains` (used by `exists` / `symlink`) intact for those cold call sites.
- `isContainedInEitherRoot(abs, normRoot, normCanon)` (private method) — the two-call site.
  Normalise `abs` once here; compare against the two precomputed `+ sep` prefixes.
- `checkContainment(path, mode)` — reads `normalizedRoot` / `normalizedCanonical` via
  `getNormalizedRootDir()` / `getResolvedNormalizedCanonicalRoot()` and passes them to
  `resolveForMode`; the pre-`+sep` prefixes are threaded the same way (constructor-cached
  fields or a per-call precompute at this boundary).
- `resolveForMode(path, resolved, mode, normRoot, normCanon)` — the lstat-arm. It runs the
  PRE-check (`isContainedInEitherRoot(resolved)`, kept per entry), then
  `parent = dirname(resolved)`, `basename = basename(resolved)`,
  `realParent = cachedParentRealpath(parent)`, `return join(realParent, basename)`. **B3**:
  the lstat-arm becomes the site where the per-parent post-check verdict is consulted/set —
  it already holds `parent`, `realParent`, and the `normRoot`/`normCanon` it was passed.
  Signature grows only if the `+sep` prefixes are threaded as parameters rather than read
  from instance fields (prefer instance fields — matches the existing memoisation pattern).
- `cachedParentRealpath(parent)` — **B3 core.** Today: LRU `get`/`set` of the parent
  realpath. Extend to also cache the parent's **containment verdict** (a `boolean` keyed by
  the same raw `parent` string), computed once via `isContainedInEitherRoot(realParent,
  normRoot, normCanon)` right after the realpath resolves and set together with it (never
  divergent). Options: a parallel `createLruCache<boolean>` sized/keyed identically, or fold
  `{ realParent, contained }` into the existing cache's value — prefer the folded value so a
  single `.get`/`.set`/`.clear` keeps them atomically coupled. Because `cachedParentRealpath`
  needs `normRoot`/`normCanon` to compute the verdict, thread them in (they are already
  resolved in `checkContainment` and passed to `resolveForMode`).
- `checkContainment(path, mode)` — the lstat-arm's post-check
  `isContainedInEitherRoot(real, …)` (currently unconditional per entry) becomes: for the
  lstat arm, trust the per-parent verdict B3 cached; for the `read`/`creation` arms, keep the
  per-entry post-check unchanged (their `real` is a full leaf realpath, not
  `join(realParent, basename)`, so the leaf-is-clean invariant does not hold). Structure so
  the post-check is skipped for lstat only when the cached parent verdict is present and
  `true`; a cached `false` throws `permissionDenied` exactly as the per-entry check did.
- `rename` / `rmRecursive` — both call `parentRealpathCache.clear()` today. **B3
  invalidation**: the verdict cache clears in the **same** two places (folded value → one
  `.clear()` already covers both; parallel cache → add a second `.clear()` beside each). `rm`
  touches neither cache (leaf-only removal; parent realpath and containment unchanged) —
  keep that.
- Memoised fields already present as the pattern to mirror for B1/B2: `normalizedRootDir`,
  `normalizedCanonicalRoot`, `getNormalizedRootDir()`,
  `getResolvedNormalizedCanonicalRoot()`, `getCanonicalRoot()` (populates the canonical
  field on its success arm, clears on rejection — a new `+sep` field for the canonical root
  must clear on the same rejection path to keep the transient-ENOENT-retry invariant).

**`src/adapters/node/path-policy.ts`** — read-only reference. `normalizeForCompare` is
identity on `posixPolicy`, `stripWinExtendedPrefix(p).toLowerCase()` on `windowsPolicy`;
`sep` is `'/'` vs `'\\'`. No change here — the amortisation is entirely in the adapter's
use of the policy, not the policy itself.

**Test surface to extend** (the security-property net, both policies):
- The existing containment unit tests (the `checkcontainment-hot-path.md` design's suite +
  `node-file-system` unit / injected tests) — assert the B1/B2 precomputed-prefix path
  returns the identical verdict for the same inputs the pre-refactor code returned, driven
  through both `posixPolicy` and `windowsPolicy` (the injected `PathPolicy` + `FsOperations`
  seam the file already uses for Windows-on-Linux coverage).
- **B3 per-parent verdict cache — isolated tests** (mirror the existing `parentRealpathCache`
  tests): (a) **first-call vs hit** — two lstats under the same parent issue exactly **one**
  `isContainedInEitherRoot` on the parent's realpath (spy/count via the injected
  `FsOperations` + a policy spy); the second is served from the verdict cache. (b) **cached
  `false` still throws** — a parent whose realpath escapes the root (symlinked-out parent via
  the injected fsOps) throws `permissionDenied` on the FIRST lstat and on every subsequent
  lstat under it, from cache — assert the error `.data.code`, not just the type. (c)
  **invalidation** — an lstat (populates the verdict), then `rename` (or `rmRecursive`), then
  an lstat under a now-differently-resolving parent recomputes the verdict rather than
  serving a stale one; and `rm` does **not** invalidate (parent verdict survives). (d)
  **read/creation arms untouched** — a `read` whose leaf symlinks out still throws per entry
  (B3 must not have leaked the lstat-arm skip into the full-realpath arms).
- Property lens (CLAUDE.md case 2, compositional matcher): `isContainedInEitherRoot` is an
  aggregator over the two roots — a `*.properties.test.ts` sibling asserting invariants
  (a child equal to a root is contained; a child strictly under a root is contained; a
  prefix-only sibling `/repo-evil` vs `/repo` is NOT contained; the B1/B2 precomputed-prefix
  path and a from-scratch `pathContains` agree for arbitrary `(root, child)` pairs; **and the
  B3 algebra** — for an arbitrary contained/uncontained `realParent` and an arbitrary
  single clean `basename`, `isContainedInEitherRoot(join(realParent, basename))` equals
  `isContainedInEitherRoot(realParent)` on both policies). This independently proves the
  refactor changed no verdict.

## Requirements

When this item ships:

1. The investigation's four findings are **recorded in this doc** as conclusions backed by
   the captured data (done above), and the 26.7 follow-up note in
   `docs/understand/performance.md` is **resolved** (D3 = a, decided).
2. The **Candidate B** containment amortisation (B1 + B2 + B3; B4 and the `policy.resolve`
   cut REJECTED — D1 = B, decided) lands with a **provably identical containment verdict**
   for every input on **both** `posixPolicy` and `windowsPolicy`, covered by the extended
   security-property unit + property net (including the B3 per-parent verdict cache), and the
   full `npm run validate` gate is green (coverage 100% on `adapters/node`, mutation budget
   held — the security predicate and the verdict cache carry 0 surviving mutants).
3. The perf win is **validated by a same-host before/after `status` bench** recorded in the
   PR body (host-relative numbers, **not** committed to the tree — D2 = b).
4. The committed `docs/perf/baseline.json` / `baseline.md` is **refreshed via a full
   `npm run profile`** (all commands) so it reflects the optimised
   `resolveForMode`/`checkContainment` self-shares — **never** via `npm run profile status`,
   which writes a status-ONLY baseline that would delete every other command's section
   (D2 = b, decided).
5. **No library / command surface change.** The change is confined to
   `src/adapters/node/node-file-system.ts` (internal helpers), its tests, and docs. No
   `openRepository`/command option, no port signature, no public export changes. Containment
   remains a construction-time guarantee (`docs/understand/security.md`).
6. The backlog `26.7a` entry is ticked with the manifest suffix
   (`· ADRs NNN–NNN · design/status-clean-perf-investigation.md`), and this doc's
   provenance (backlog id, surfacing context) stays in the doc body, never in source, test,
   or the commit subject.

## Decision candidates

Every candidate below was a **load-bearing choice not pre-decided by an existing ADR**;
resolved with the user in the ADR conversation. Alternatives are kept for the record; the
**Decided** column is authoritative and drives the plan. (Highest existing ADR is **484**;
next land at **485+**.)

| # | Choice | Alternatives (≤3) | Decided | Why |
|---|---|---|---|---|
| **D1** | **Amortisation scope on the containment hot path** | **(A) Minimal behaviour-preserving refactor** — precompute `normRoot + sep` / `normCanon + sep` as memoised instance fields; normalise the child **once** per `isContainedInEitherRoot`. Confined to the predicate helpers; verdict bit-identical. **(B) A plus deeper per-entry reduction** — additionally amortise the lstat-arm post-check verdict per parent directory (B3), trimming the per-lstat containment recomputation. **(C) Docs-only** — declare the tax inherent, ship no code. | **B** | Finding 2 shows real headroom on a 46% hot-path frame; the repo ships hot-path wins in-PR when guarded by the test net. B ships B1 + B2 (A's cuts) PLUS **B3**, the per-parent post-check verdict cache — the headline win: it is **proven verdict-identical** to the per-entry check for a single clean leaf (`isContainedInEitherRoot(join(realParent, basename)) ≡ isContainedInEitherRoot(realParent)`) on both policies, and pairs with 26.4's per-parent realpath cache (N files/dir → 1 containment check). **B4** (hand-rolled dirname/basename split) and hoisting `policy.resolve` are **REJECTED** as unfaithful — see the Design section's per-cut verdicts. |
| **D2** | **Perf-validation & baseline artifact** | **(a) Same-host before/after `status` bench in the PR body** (host-relative, uncommitted); do **not** regenerate the committed baseline. **(b)** As (a) **plus a full `npm run profile`** refresh of the committed baseline (all commands) so it reflects the optimised `resolveForMode`/`checkContainment` self-shares. **(c) CI-nightly only** — rely on the next `bench.yml` run, commit no local artifact. | **b** | Same-host before/after is the only load-independent way to pin the win (Finding 1's method), AND the committed baseline is refreshed to reflect the optimised frame. The refresh MUST be a **full `npm run profile`** (all commands) — `npm run profile status` writes a status-ONLY `Baseline.commands` that would delete every other command's section (no baseline-drift CI gate exists to catch it). (c) alone can't attribute the move to this change vs runner noise. |
| **D3** | **Docs surface** | **(a)** Resolve `docs/understand/performance.md:53` — replace the "tracked as a follow-up" sentence with the confirmed finding (no regression; 26.4 already improved status; the gap is the containment tax, amortised further by B); keep the honest "Why status:clean … are currently slower" framing and update the `status:clean` line **only if the number materially moves**; tick backlog `26.7a`. **(b)** As (a) but **leave the number** untouched regardless. **(c)** Minimal — tick the backlog only, leave the note standing. | **a** | The follow-up note at `performance.md:53` **is** 26.7a; leaving it unresolved after running the definitive test is dishonest to the reader. (a) closes the loop while respecting the committed-number provenance rule — the published `0.67×` lives on the CI nightly runner and moves only via a nightly refresh, so the doc records the *diagnosis* (tax, not regression) and only edits the number if a fresh nightly measurement moves it. |

> **Resolved D1 = B, D2 = b, D3 = a** in the ADR conversation. ADRs 485+ will capture: the
> containment-amortisation-scope decision (B, with B4 / `policy.resolve` rejected as
> unfaithful), the perf-validation + full-baseline-refresh decision (b), and the
> docs-resolution decision (a).

## Test strategy

- **The security-property net is the gate, not a new interop test.** This item asserts no
  git-observable behaviour, so per the git-faithfulness procedure there is nothing to pin
  as a cross-tool interop test. The proof obligation for D1 = B is that `checkContainment` /
  `isContainedInEitherRoot` / `pathContains(Normalized)` / `cachedParentRealpath` return the
  **identical verdict** for every input after the refactor. Extend the existing containment
  unit + injected tests to drive the B1/B2 precomputed-prefix path AND the B3 per-parent
  verdict cache through **both** `posixPolicy` and `windowsPolicy` (the file's established DI
  seam for Windows-on-Linux coverage).
- **B3 verdict-cache isolated tests** (detailed in the pre-chewed block): first-call-vs-hit
  (one `isContainedInEitherRoot` per parent, not per entry); cached-`false`-still-throws
  (assert `.data.code`, both first and subsequent lstats); invalidation on
  `rename`/`rmRecursive` but NOT `rm`; and read/creation arms keep their per-entry post-check
  (B3 is lstat-arm-only). Each guard clause tested in isolation (per the mutation-resistant
  patterns).
- **Property sibling (CLAUDE.md case 2).** `isContainedInEitherRoot` is a compositional
  matcher over two roots; a `*.properties.test.ts` sibling proves the refactor changed no
  verdict (child == root → contained; child strictly under a root → contained; prefix-only
  sibling `/repo-evil` vs `/repo` → NOT contained; the B1/B2 precomputed-prefix path agrees
  with a from-scratch `pathContains` for arbitrary `(root, child)` pairs; **the B3 algebra** —
  `isContainedInEitherRoot(join(realParent, basename)) ≡ isContainedInEitherRoot(realParent)`
  for arbitrary `realParent` + a single clean `basename`, both policies). Independent oracle,
  not a re-implementation of the SUT.
- **Coverage / mutation.** `adapters/node` is in the covered set (`vitest.config.ts`
  include), so the amortisation carries **100% line/branch/function/statement** and the
  mutation budget — the security-boundary predicate and the verdict cache must not gain a
  surviving mutant. The memoised `+sep` fields need isolated first-call-vs-cached-hit tests
  (mirror the existing `normalizedRootDir` memoisation tests) and, for the canonical-root
  `+sep` field, a rejection-clears-cache test on the transient-ENOENT path.
- **Perf validation is a PR-body artifact; the committed baseline is refreshed via a full
  profile (D2 = b).** The same-host before/after `status` bench is recorded in the PR body as
  host-relative numbers (not a gating test — bench files are excluded from coverage — and not
  committed). Separately, the committed `docs/perf/baseline.json`/`.md` is refreshed by a
  **full `npm run profile`** (all commands) so it reflects the optimised frame; a status-only
  profile is never committed (it would delete every other command's section).

## Out of scope

- **>512-distinct-parent-directory thrash** — a documented `parentRealpathCache` bound
  (Finding 3), unexercised by any bench and irrelevant to the flat `status:clean` scenario;
  resizing or re-keying the LRU is a separate item if a real workload ever hits it.
- **The `readBlob:cold` / `log:walk` losses** — the other two `performance.md` losses are
  separate paths (full-buffer cold read, full commit parse); this item is scoped to
  `status:clean` and its containment tax only.
- **The 26.5 CI regression gate** — locking the final `status:clean` number behind a
  per-scenario `bench:summary` diff is 26.5; this item lands *before* 26.5 so the number it
  locks reflects the diagnosis.
- **B4 (hand-rolled dirname/basename split) and hoisting/caching `policy.resolve`** — both
  REJECTED as unfaithful in the Design section (nodePath edge-case semantics; `..`/foreign-
  separator normalisation is load-bearing security). B3 delivers the deeper win without them.
  (Candidate B *is* in scope — D1 = B — as B1 + B2 + B3.)
- **Committing any status-only `docs/perf/baseline.json`/`.md`** — a status-only
  `npm run profile status` would delete every other command's baseline section; the committed
  baseline is refreshed only by a **full `npm run profile`** (D2 = b, in scope as a
  deliberate refresh step — the status-only variant is what stays out).
- **A committed absolute `status:clean` number from a local host** — local numbers are
  session-load-biased and non-citable; the published number is the CI nightly artifact.
