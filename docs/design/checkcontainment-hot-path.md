# Design — checkContainment + object-lookup hot path: gate the settled-promise await, hoist the per-call closure, cache the lstat-mode parent realpath, cheapen the loose existence probe (faithful, loose-first preserved)

> Brief: `checkContainment` is the single hottest cross-cutting frame in the
> committed profile baseline (`docs/perf/baseline.json` / `.md`) — self-share
> **0.36 diff, 0.26 name-rev, 0.24 blame, 0.18 describe, 0.16 merge, 0.13 show,
> 0.12 status**. It is the security gate on **every** node FS op (17 call sites).
> Its remaining per-call self-cost, after root-normalisation was already
> amortised, is (1) a guaranteed microtask suspension from `await
> this.getCanonicalRoot()` on an **already-settled** promise, and (2) a per-call
> closure allocation for `check`. This PR ships **both** (Lever A + Lever B),
> **plus** baseline finding (3): the `lstat`-mode arm of `resolveForMode`
> re-`realpath`s the same parent directory once per entry (N same-directory files
> in `status` ⇒ N identical parent realpaths) — extend the existing
> `creationParentCache` template to the lstat mode so the parent realpath is paid
> once per directory; **plus** baseline finding (5): the wasted per-object loose
> `exists(looseObjectPath)` on packed-repo history walks (`exists` self-share 0.18
> in log/describe/name-rev, an uncached full-path `realpath`-follow per object) —
> keeping git's **loose-first** precedence (DC-7 → STAY FAITHFUL, the pack-first
> reorder is REJECTED), make the same probe cheaper: fold `exists`+`read` into one
> try-`read` (5a) and switch the loose existence probe from `exists` to an
> `lstat`-based probe (5e) that **reuses finding-3's fanout-dir realpath cache** —
> `dirname(looseObjectPath)` is one of only 256 fanout dirs, so the per-object
> uncached `realpath` collapses to a cached `realpath(fanout dir)` + a cheap
> `lstat`. **All of findings (1)/(3)/(5) are now behaviour-preserving** — precedence
> untouched, no git divergence, no new ADR. The one caveat is a shared-cache size
> bump (DC-9). Pure internal/primitive refactor — NOT a git-observable change; the
> faithfulness pin is the existing suite staying green with unchanged assertions
> (plus new defensive tests for the pathological symlinked-loose corner), a
> re-profile showing the self-share drop, and the improved
> `docs/perf/baseline.{json,md}` re-committed.
> Status: draft → self-reviewed ×3 → decisions ratified (DC-1→B widen, DC-2→B
> ship, DC-3→A commit baseline, DC-4→no refactor ADR, DC-6→EXPAND exists-share,
> DC-7→STAY FAITHFUL / reorder rejected, DC-8→N/A) → revised (finding (5) reshaped
> to the faithful cheaper-probe; DC-9 opened for the cache-size bump)

## Context

`src/adapters/node/node-file-system.ts` → `class NodeFileSystem` (lines
292–802). `checkContainment(path, mode)` (lines 742–783) is the security gate
invoked by every FS op that touches a caller-supplied path:

- **17 call sites** via `checkContainment`: `read`, `readSlice`, `readUtf8`,
  `write`, `writeStream`, `writeExclusive`, `writeUtf8`, `appendUtf8`, `stat`,
  `lstat`, `readdir`, `mkdir`, `rm`/`rmRecursive`, `rename`, `readlink`,
  `symlink`, `chmod`, `openWithNoFollow`.
- **`exists` (lines 460–493) is an 18th, near-identical inline copy** of the
  same preamble (`await this.getCanonicalRoot()` → `getNormalizedRootDir()` →
  `getResolvedNormalizedCanonicalRoot()`) — it does its own realpath + dual-root
  containment check rather than call `checkContainment`. It is **also** a top
  baseline frame (0.18 in describe / name-rev / log). Lever A applies to it
  verbatim; this design fixes both frames.
- **`symlink`'s absolute-target validation branch (lines 558–576) is a third,
  identical inline copy** of the same preamble (`await this.getCanonicalRoot()` →
  two cached getters → dual-root `pathContainsNormalized`). It fires only when
  `symlink(target, path)` receives an **absolute** target (checkout materialising
  an absolute symlink) — a low-frequency path, so it is **not** a top baseline
  frame, but it is the same settled-await pattern. Lever A applies verbatim; the
  design fixes it too for consistency (three identical sites, all three gated —
  not two-of-three, which would be an odd asymmetry a reviewer would flag).

So there are **exactly three** `await this.getCanonicalRoot()` execution sites
(verified: L462 `exists`, L567 `symlink`, L760 `checkContainment`; the two other
textual hits at L359/L363 are JSDoc, not code). Lever A gates all three.

### The per-call body of `checkContainment` (lines 742–783)

```ts
private async checkContainment(path: string, mode: ContainmentMode): Promise<string> {
  const resolved = this.pathPolicy.resolve(toAbsolute(path, this.rootDir, this.pathPolicy)); // (1) genuine per-path work
  await this.getCanonicalRoot();                                                             // (2) microtask on a settled promise
  const normalizedRoot = this.getNormalizedRootDir();                                        // (3) cached getter (cheap)
  const normalizedCanonical = this.getResolvedNormalizedCanonicalRoot();                     // (3) cached getter (cheap)
  const check = (abs: string): void => {                                                     // (4) closure alloc per call
    if (
      !pathContainsNormalized(normalizedRoot, abs, this.pathPolicy) &&
      !pathContainsNormalized(normalizedCanonical, abs, this.pathPolicy)
    ) {
      throw permissionDenied(path);
    }
  };
  try {
    const real = await this.resolveForMode(path, resolved, mode, check);                     // (5) realpath I/O lives HERE (separate frame)
    check(real);
    return real;
  } catch (err) {
    if (err instanceof TsgitError) throw err;                                                // Stryker-disable equivalent (L776)
    if (isErrnoException(err) && err.code === 'ENOENT') throw fileNotFound(path);            // Stryker-disable equivalent (L778)
    if (isErrnoException(err)) throw mapErrno(err, path);
    throw err;
  }
}
```

Where the per-call self-cost lives, decomposed:

| # | Line | Cost | Genuine per-call? |
|---|------|------|-------------------|
| 1 | `pathPolicy.resolve(toAbsolute(...))` | string normalisation of *this* path | **yes** — irreducible, distinct input every call |
| 2 | `await this.getCanonicalRoot()` | one microtask suspension, guaranteed, on a settled promise | **no** — the target is instance-stable after first resolution |
| 3 | `getNormalizedRootDir()` / `getResolvedNormalizedCanonicalRoot()` | field read + one lazy memoise on first ever call | **no** — already amortised |
| 4 | `const check = (abs) => {…}` | closure allocation capturing `normalizedRoot`, `normalizedCanonical`, `this.pathPolicy`, `path` | **no** — only `path` is per-call, and only for the error message |
| 5 | `resolveForMode` → `realpath` | the actual FS syscall | **yes** — but it is a *separate profile frame* (`resolveForMode` / `realpath`), NOT `checkContainment` self |

So the two levers below target #2 and #4. #1 and #5 are irreducible and #5 is
not even attributed to this frame's self-share.

### Existing caching infra (already in place — do NOT rebuild)

The root-normalisation amortisation is done (lines 300–390):

- `normalizedRootDir` — memoised `normalizeForCompare(rootDir)`, lazy (L350–355).
- `canonicalRootPromise` — one shared `realpath(rootDir)` promise; **cleared on
  rejection** so a transient ENOENT retries (L375–390).
- `normalizedCanonicalRoot` — set in the promise's success arm, cleared on its
  rejection arm (L380 / L385). **This field is the resolved sentinel** the whole
  design pivots on.
- `getResolvedNormalizedCanonicalRoot()` (L370–373) — synchronous, reads
  `normalizedCanonicalRoot!` (non-null assertion), trusting the "caller just did
  `await getCanonicalRoot()`" invariant. Its JSDoc already states the discipline.
- `creationParentCache` — LRU for creation-mode parent realpaths (L314),
  unrelated to this change.

So root-normalisation is already amortised. The remaining self-cost is exactly
the guaranteed microtask (#2) + the closure alloc (#4).

## The crux — why the await on a settled promise still costs

`await p` where `p` is already resolved does **not** run synchronously: per the
ES spec, `await` always schedules a microtask and yields the current job. So
even though `getCanonicalRoot()` returns the already-settled
`canonicalRootPromise` from the second call onward, every `checkContainment` call
still pays one guaranteed event-loop microtask turn. Across a command that issues
thousands of FS ops (a diff / name-rev / blame walk), that is thousands of
avoidable suspensions — and the profiler attributes the resumption bookkeeping to
this frame's self time, which is precisely why `checkContainment` tops the chart
on the I/O-heavy read commands.

The existing `getResolvedNormalizedCanonicalRoot()` already documents that a
synchronous read is *safe once the field is set* — it uses `!` and leans on the
call-site discipline. The insight for Lever A: **the field itself is the
observable "already resolved" signal**, so the `await` can be skipped when the
field is set, keeping the exact same post-condition (`normalizedCanonicalRoot`
defined) that the `!` getter already trusts.

## Approach

### Lever A — gate the settled-promise await (PRIMARY, recommended)

Replace the unconditional `await this.getCanonicalRoot();` at all **three**
execution sites — L760 (`checkContainment`), L462 (`exists`), L567 (`symlink`
absolute-target branch) — with a guarded await:

```ts
if (this.normalizedCanonicalRoot === undefined) {
  await this.getCanonicalRoot();
}
```

After the first successful resolution, `normalizedCanonicalRoot` is defined, the
`if` is false, and the call runs **synchronously through to `resolveForMode`** —
no microtask suspension. The `checkContainment` method stays `async` (it awaits
`resolveForMode`), so callers are unchanged.

**Correctness argument (the three verification questions from the brief):**

1. **Preserves the `getResolvedNormalizedCanonicalRoot()` `!` invariant?** Yes.
   The getter requires `normalizedCanonicalRoot` to be defined at read time. Two
   cases:
   - Field already defined → we skip the await, field stays defined → getter
     safe.
   - Field `undefined` → we `await this.getCanonicalRoot()`. On success its
     `.then` arm sets `normalizedCanonicalRoot` **before the awaited promise
     settles** (the assignment is inside the `then` callback that produces the
     resolution value), so by the time control returns past the `await` the
     field is defined → getter safe. This is the *identical* post-condition the
     current unconditional `await` already establishes; the guard only elides the
     await when the post-condition is *already* true. The invariant is
     unweakened.
2. **First-call concurrency race?** No new race. `getCanonicalRoot()` already
   de-duplicates concurrent first calls behind one shared `canonicalRootPromise`
   (L376). Two concurrent first `checkContainment` calls both see
   `normalizedCanonicalRoot === undefined`, both call `getCanonicalRoot()`, and
   both await the *same* promise — exactly today's behaviour. The guard does not
   introduce a check-then-act window on a mutable-in-flight value: it reads the
   field, and the only writer is the shared promise's settled arms. Worst case a
   second concurrent first-caller redundantly enters the `if` and awaits the same
   shared promise — a no-op, not a race.
3. **Rejection / retry path preserved?** Yes. On `realpath(rootDir)` rejection,
   `getCanonicalRoot`'s `.catch` clears **both** `canonicalRootPromise` and
   `normalizedCanonicalRoot` back to `undefined` (L384–385) and rethrows. So
   after a transient ENOENT the field is `undefined` again → the next call's
   guard is true → it re-awaits and retries. Identical to today. The guard reads
   the same sentinel the rejection arm resets, so retry semantics are exactly
   preserved.

**TOCTOU unchanged (Lever A).** Lever A touches only the *root canonicalisation*
await (instance-stable data), never the per-path realpath in
`resolveForMode`/`exists`. Every op still re-realpaths its own path every call, so
a symlink swapped between two ops is still re-checked — the security re-stat is
untouched. (Finding (3) *does* dedupe one narrow piece of this — the lstat-mode
*parent-directory* realpath — but never the leaf; its TOCTOU envelope is argued
separately in the finding (3) section and matches the already-shipped creation
cache.)

Applies identically to `exists` (L462) and to the `symlink` absolute-target
branch (L567): same `normalizedCanonicalRoot` sentinel, same three-part argument.
Both those sites also read `getResolvedNormalizedCanonicalRoot()` immediately
after, so the "field defined ⇒ getter safe" post-condition is what each relies on
— identical to `checkContainment`.

### Lever B — hoist the per-call `check` closure (SHIPS — ratified DC-2 → Option B)

The `check` closure (L763–770) is allocated fresh on every call. It captures
three instance-stable values (`normalizedRoot`, `normalizedCanonical`,
`this.pathPolicy`) and one per-call value (`path` — used only to build the
`permissionDenied(path)` error). The `check` frame is separately attributed in
the baseline (`check` self 0.23 rev-parse, 0.08 merge, 0.01 diff/name-rev/
describe), so the allocation + call is a real, measurable frame — not noise.

**Chosen shape — B(i): an instance predicate, throw at the call sites.**

Add a pure private predicate that takes the containment inputs explicitly (no
capture):

```ts
private isContainedInEitherRoot(abs: string, normRoot: string, normCanon: string): boolean {
  return (
    pathContainsNormalized(normRoot, abs, this.pathPolicy) ||
    pathContainsNormalized(normCanon, abs, this.pathPolicy)
  );
}
```

`checkContainment` throws on `false` at each check point, replacing the closure.
The obstacle the prior draft flagged — `resolveForMode(path, resolved, mode,
check)` takes `check: (abs) => void` and invokes it internally in the `read`
(L727) and `lstat` (L735) arms — is resolved by **making the containment guard
`resolveForMode`'s own responsibility**: `resolveForMode` receives the two
normalised roots (`normRoot`, `normCanon`) plus `path` and calls
`this.isContainedInEitherRoot(...)` directly, throwing `permissionDenied(path)`
on `false`. This deletes the callback parameter entirely (a *narrower* signature,
not a wider one) — `resolveForMode(path, resolved, mode, normRoot, normCanon)` —
and both arms call the shared predicate. `checkContainment`'s own post-resolution
check (`check(real)` at L773) becomes a direct
`if (!this.isContainedInEitherRoot(real, normRoot, normCanon)) throw
permissionDenied(path);`.

**Behaviour-preserving.** The predicate is the exact boolean the closure
computed (`!A && !B` throwing ⇔ `!(A || B)` throwing ⇔ `A || B` false throwing) —
De Morgan, same verdict, same `permissionDenied(path)` error with the same
`path`. The throw sites are identical in count and location (each former
`check(x)` becomes a guarded throw on the same `x`). No new I/O, no new microtask.
The dual-root OR semantics and short-name/canonical handling are untouched.

**Mutation note.** The predicate's `||` and each `pathContainsNormalized`
argument are now first-class mutation targets. The existing containment tests
(symlink escape, absolute escape, short-name dual-root) already exercise both
disjuncts; separate isolated tests for each disjunct (one path contained by raw
root only, one by canonical root only) kill the `||`→`&&` and disjunct-drop
mutants — mirroring the "guard clauses need isolated tests" rule. This is
mechanically simpler to kill than the closure was (a named method vs an inline
capture), which is a coverage *improvement*, not a risk.

### Lever C — memoise checkContainment(path,mode)→real across a command (REJECTED)

Caching the realpath + security decision per `(path, mode)` for a command's path
set. **Rejected on two independent grounds:**

1. **Not TOCTOU-faithful.** A memoised realpath+decision would skip the re-stat
   on a path deleted or symlink-swapped mid-command. Real git re-stats every
   access; caching the decision would let a path that was safe at first touch be
   trusted after an attacker swapped it for a symlink escape. That violates
   contract A (TOCTOU byte-identical) and the security semantics. Non-starter.
2. **Wrong frame anyway.** The realpath cost lives in `resolveForMode` /
   `exists`'s own `realpath` call — a *separate* profile frame. Memoising it would
   not reduce `checkContainment`'s **self** share (which is the microtask +
   string work), so it fails the perf pin's stated target even if it were safe.

Documented as rejected; not deferred (it is unsafe, not merely out of scope).

### Finding (3) — cache the lstat-mode parent realpath (SHIPS — ratified DC-1 → Option B)

**The redundancy.** `status` scans the working tree via
`scanWorkingTree` (`src/application/commands/status.ts` L167) →
`compareWorkingTreeDelta` (`src/application/primitives/compare-working-tree-entry.ts`
L84: `await ctx.fs.lstat(absPath)`), one adapter `lstat` per tracked file. Each
adapter `lstat` → `checkContainment(path, 'lstat')` → `resolveForMode`'s **lstat
arm** (L730–737):

```ts
if (mode === 'lstat') {
  check(resolved);
  const parent = await this.fsOps.realpath(this.pathPolicy.dirname(resolved)); // UNCACHED
  return this.pathPolicy.join(parent, this.pathPolicy.basename(resolved));
}
```

For N files in the **same directory**, `realpath(dirname)` runs N times on the
**identical** parent string. This is the `lstat` self-share 0.25 and
`resolveForMode` self-share 0.14 in `status`. The fix is to memoise the parent
realpath — the *exact same* optimisation `creationParentCache` already does for
creation mode.

**Why this is safe where read/exists caching is NOT.** The lstat arm
deliberately does **not** realpath the leaf — it realpaths the *parent* and joins
the raw basename, because `lstat` must not follow a leaf symlink (git lstats the
link itself). So caching the *parent* realpath changes nothing about leaf
handling: the leaf is never followed either way, and the leaf is still `lstat`'d
fresh by the caller (`compareWorkingTreeDelta` L84) on every call. Contrast the
**read arm** (L728) and **`exists`** (L468): both call
`realpath(RESOLVED-full-path)`, which **follows the leaf symlink** — and the
containment check *depends on* the followed leaf to catch a leaf-symlink escape
(a leaf `evil → /etc/passwd` inside root must resolve to `/etc/passwd` and fail
containment). Parent-caching read/exists would stop following the leaf, so a
malicious leaf symlink would pass containment against the cached-parent path →
**a security regression**. Therefore:

- **lstat-mode parent realpath: SAFE to cache** (leaf never followed; parent is a
  stable directory realpath under git's directory-stability assumption).
- **read/exists-mode: NOT safe to parent-cache** — the leaf follow is
  load-bearing for containment. Left as-is.

**Honest share accounting (finding 3 scope).** Finding (3) addresses the `status`
`lstat`/`resolveForMode` shares (the lstat-heavy working-tree scan) — the biggest
concrete redundancy. Within **finding (3) alone** it does **not** reduce the
`exists` self-share (0.18 in describe/name-rev/log): `exists` follows the leaf and
so its *own* `realpath` cannot be parent-cached without weakening containment. The
`exists` frame's *settled-await microtask* is removed by Lever A, but finding (3)
does not touch its realpath-follow. **Finding (5e) is what reduces the `exists`
share** — not by caching `exists`'s follow, but by switching the *object-store
callers* off `exists` entirely onto an `lstat`-based probe (safe there because the
loose probe never needs the leaf followed at probe time — the subsequent `read`
does the follow). So the two findings compose: finding (3) builds the fanout-dir
cache; finding (5e) routes the object-store probe through it. Read-mode object
*reads* (the actual `read` of a loose object) still keep their leaf-follow realpath
— that is the genuine, irreducible containment cost, unchanged.

**Cache shape (recommend: reuse the single `creationParentCache`, renamed to its
now-broader role).** The existing LRU (`createLruCache<string>`, L314) already
holds `parent → realParent`. lstat-mode wants the identical mapping. The cleanest
shape is to **reuse the one cache** for both creation and lstat modes — the value
(a parent's realpath) is mode-independent, so a parent realpath'd for a write and
later lstat'd shares one entry (a bonus hit). Rename it `parentRealpathCache` to
reflect the broadened role. The alternatives (a second dedicated lstat cache; a
`(parent, mode-class)`-keyed unified cache) add a field or a composite key for no
semantic gain, since the cached value is the same string regardless of mode.
Surfaced as DC-5.

**The lstat-arm change** mirrors `realpathForCreation` (L693–718) exactly:

```ts
if (mode === 'lstat') {
  // containment guard (Lever B form) on `resolved`
  const parent = this.pathPolicy.dirname(resolved);
  const cached = this.parentRealpathCache.get(parent);
  const realParent = cached ?? await this.fsOps.realpath(parent);
  if (cached === undefined) {
    this.parentRealpathCache.set(parent, realParent, parent.length + realParent.length);
  }
  return this.pathPolicy.join(realParent, this.pathPolicy.basename(resolved));
}
```

(The `realpath` here can throw ENOENT for a nonexistent parent; the lstat arm
already lets that propagate to `checkContainment`'s catch → `fileNotFound`. A
miss is **not** cached on throw — identical to `realpathForCreation`'s
ENOENT-not-cached discipline, so a directory that appears mid-command is not
frozen "absent".)

**Invalidation contract (MUST match `creationParentCache` exactly).** The cache
is cleared by the two mutators that can change a parent's realpath:
`rmRecursive` (L604 `this.creationParentCache.clear()`) and `rename` (L543). Since
finding (3) reuses that same cache, those clears already cover the lstat entries —
no new invalidation site is needed, and none may be *removed*. The leaf stat is
**never** cached (only the parent directory realpath), so the TOCTOU re-stat of
the leaf is preserved: every `lstat` call re-issues the caller's fresh leaf stat,
matching git's per-access re-stat. This is faithful under git's standing
assumption that the worktree directory structure is stable for a command's
duration — the identical assumption `creationParentCache` already relies on.

**TOCTOU precisely.** What is cached: a *directory* realpath (stable per git's
assumption, invalidated on the two structural mutators). What is NOT cached: any
leaf stat / leaf realpath / containment decision. So a leaf swapped between two
`lstat`s is still seen freshly; a parent *directory* swapped is covered because
the swap goes through `rename`/`rmRecursive` (which clear the cache) — a raw
external `mv` of the parent outside the adapter is outside git's stability
assumption and outside `creationParentCache`'s existing guarantee too, so finding
(3) inherits exactly the creation cache's (already-shipped, already-mutation-
proven) TOCTOU envelope, not a weaker one.

### Finding (5) — the wasted per-object loose `exists` on packed-repo history walks (SHIPS — ratified DC-6 → EXPAND, DC-7 → STAY FAITHFUL)

**The redundancy.** `resolveObject` (`src/application/primitives/object-resolver.ts`
L36) resolves **every** object loose-first, and `tryLoose` (L148–153) is a
**check-then-read**:

```ts
const path = looseObjectPath(commonGitDir(ctx), id);
if (!(await ctx.fs.exists(path))) return undefined;   // exists = realpath-FOLLOW + dual-root containment; ENOENTs for packed objects
const compressed = await ctx.fs.read(path);           // ANOTHER full realpath + containment + open
return ctx.compressor.inflate(compressed);
```

On a **packed** repo (the common case: clone, then all history in packs), a walk
that reads thousands of commits+trees (log / describe / name-rev) issues one
wasted `exists(looseObjectPath)` per object. Critically, `exists` (node-file-system
L460–493) resolves via `realpath(RESOLVED-full-path)` — an **uncached full-path
realpath that follows the leaf** — per object. That per-object uncached `realpath`
is the `exists` self-share **0.18** in log / describe / name-rev. `looseCompressedBytes`
(L160–167) carries the same `exists`-then-`read` double-probe on the loose-hit path.

**DC-7 resolution — STAY FAITHFUL (loose-first preserved).** The user rejected the
pack-first reorder: git's object-lookup precedence is **loose-first** (pinned below),
and tsgit keeps it. So the win must come **without** changing precedence — make the
*same* loose-first probe **cheaper**, not reorder it. The pack-first reorder (former
Lever 5b) is **REJECTED**; DC-8 (its ADR) is **N/A**; there is **no git-precedence
divergence** and therefore **no ADR needed** for the exists-share.

#### Empirical git object-lookup order — PINNED (loose-first) — retained for the record

Per `.claude/workflow/faithfulness.md`, pinned against **git 2.55.0** in two
independent `mktemp` throwaways (scrubbed `GIT_*`, isolated `HOME`,
`GIT_CONFIG_NOSYSTEM=1`, signing off — cleaned up after):

```
Setup:   commit a blob, `git repack -a` (object now BOTH loose AND packed).
Probe:   make the LOOSE copy writable, overwrite it with non-zlib garbage,
         `git cat-file -p <blob>`  (packed copy still valid).
Result (reproduced twice, deterministic):
  stderr: error: inflate: data stream error (incorrect header check)   ← tried LOOSE first
  stdout: <the real blob content>                                       ← fell back to PACK
  exit:   0
```

git attempts the **loose** object first, then falls back to the pack — canonical
precedence is **loose-first-then-pack** (`oid_object_info_extended` →
`loose_object_info` before packed stores). tsgit keeps this order (DC-7). This
matrix is retained because it is the *reason* we do not reorder.

#### The shipping fix — two behaviour-preserving levers, precedence untouched

**Lever 5a — fold `exists`+`read` → single try-`read` (faithfulness-neutral).**
Replace the check-then-read in `tryLoose` and `looseCompressedBytes` with a single
`read` catching **exactly** the not-found code:

```ts
async function tryLoose(ctx, id) {
  const path = looseObjectPath(commonGitDir(ctx), id);
  let compressed: Uint8Array;
  try {
    compressed = await ctx.fs.read(path);
  } catch (err) {
    if (err instanceof TsgitError && err.data.code === 'FILE_NOT_FOUND') return undefined;
    throw err;                                    // every other error propagates UNCHANGED
  }
  return ctx.compressor.inflate(compressed);       // outside the try: a corrupt-loose inflate error still propagates (today's behaviour, unchanged)
}
```

Pinned: `ctx.fs.read` on a missing path throws `fileNotFound(path)` (code
`FILE_NOT_FOUND`) — `read` → `runFs` → `mapErrno` ENOENT arm → `fileNotFound`
(node-file-system.ts L137, and `mapErrno`'s ENOENT arm L779, verified). So the
catch is **precise** (one code → `undefined`), not a blanket `.catch(()=>undefined)`
— every other error (EACCES, PERMISSION_DENIED, EIO) propagates unchanged, and the
`inflate` call sits **outside** the try so a corrupt-loose object still throws
exactly as today. Removes the double realpath+containment on the loose-hit path.

**Lever 5e — switch the loose EXISTENCE probe from `exists` to an `lstat`-based
probe that reuses finding-3's `parentRealpathCache` (the packed-repo win, faithful).**
This is the lever that drops the 0.18 share **without** reordering. For a packed
object `tryLoose` still probes loose first — but the probe changes from `exists`
(uncached full-path `realpath`-follow) to `lstat` (lstat-mode containment =
`realpath(dirname)` + join basename, **no leaf follow**). And `dirname` of a loose
path is the **fanout dir** `${gitDir}/objects/${xx}` (confirmed: `looseObjectPath`
= `${gitDir}/objects/${id[0:2]}/${id[2:]}`), of which there are only **256**
(`00`..`ff`). Finding (3) now **caches** `realpath(fanout dir)` in
`parentRealpathCache`, so during a walk the per-object cost drops from an
uncached full-path `realpath` to a **cached** `realpath(fanout dir)` (≤256 misses
total, then all hits) plus a cheap `fsOps.lstat` syscall per object:

```ts
async function tryLoose(ctx, id) {
  const path = looseObjectPath(commonGitDir(ctx), id);
  let stat: FileStat;
  try {
    stat = await ctx.fs.lstat(path);              // lstat-mode: realpath(fanout dir) CACHED by finding 3, no leaf follow
  } catch (err) {
    if (err instanceof TsgitError && err.data.code === 'FILE_NOT_FOUND') return undefined;
    throw err;                                    // permissionDenied / EIO / EACCES propagate UNCHANGED
  }
  // presence confirmed (loose-first precedence preserved); now read the bytes:
  const compressed = await ctx.fs.read(path);     // read-mode: follows the leaf, re-checks containment (TOCTOU fresh)
  return ctx.compressor.inflate(compressed);
}
```

The precedence is **identical** (still probe loose before pack — a loose object is
still preferred over the packed copy, matching git). Only the *probe mechanism*
gets cheaper. `looseCompressedBytes` takes the same treatment. Note 5a and 5e
combine: 5e is "probe with lstat instead of exists", 5a is "don't double-probe" —
the final `tryLoose` does **one** `lstat` presence probe (cached-realpath cheap) +,
on a hit, **one** `read`. On the packed common case only the `lstat` runs (throws
`FILE_NOT_FOUND`, falls to pack).

##### Behaviour-preservation of `exists`→`lstat` as the loose existence probe — the case walk

The observable that must stay byte-identical is: (i) whether the probe leads to
"use the loose object" vs "fall through to pack", and (ii) the error on the
pathological escape case.

| Case | `exists` probe (today) | `lstat` probe (5e) | Same observable? |
|------|------------------------|--------------------|------------------|
| **(a) normal loose object** (regular file at the loose path) | `realpath` succeeds, contained → `true` → read+inflate | `lstat` succeeds (regular file) → read+inflate | **yes** — both use the loose object, identical bytes |
| **(b) packed object** (no loose file) | `realpath` ENOENTs → `exists` returns `false` → `undefined` → pack | `lstat` ENOENTs → `checkContainment` catch → `fileNotFound` → 5e catch → `undefined` → pack | **yes** — both fall to pack |
| **(c) loose path is a symlink whose target escapes root** (pathological; git never writes this) | `exists` `realpath`-**follows** the leaf → resolves outside root → containment `false` → **throws `PERMISSION_DENIED` at the probe** (`tryLoose` does not catch it → propagates) | `lstat` does **not** follow the leaf → `realpath(fanout dir)` is inside root → probe **succeeds** ("present") → then `ctx.fs.read(path)` (read-mode, **follows**) resolves outside root → **throws `PERMISSION_DENIED` at the read** | **yes** — same `TsgitError`, same `PERMISSION_DENIED` code, same `path`; only the *throw point* differs (probe vs read). The 5e catch is `FILE_NOT_FOUND`-only, so it does **not** swallow the probe-side PERMISSION_DENIED either — and the read-side one is what today's code would surface. |

**Case (c) is the crux and it holds.** Proof it is not a counterexample: the
existing real-FS test `node-file-system.test.ts` L71–95 ("Given symlink in root
pointing outside root / When reading through it / Then throws PERMISSION_DENIED")
**already guarantees** that `ctx.fs.read` through an escaping symlink throws
`PERMISSION_DENIED`. So in case (c) the 5e path reaches that exact tested throw.
The only difference from today is *which* FS call raises it (the read, not the
existence probe) — the surfaced error object (`code`, `path`) is identical, and
nothing in `resolveObject`/`tryLoose` inspects the throw *origin*. No swallow: the
5e catch matches only `FILE_NOT_FOUND`; a PERMISSION_DENIED from either the probe
(if `lstat`'s parent somehow escaped — it can't, the fanout dir is inside `.git`)
or the read propagates unchanged.

##### Why ADR-343 is the established precedent (and it transfers)

ADR-343 ("Fold the untracked overwrite guard … with an lstat presence probe",
accepted 2026-06-15) switched an untracked-**presence** probe from `ctx.fs.exists`
to `ctx.fs.lstat` for exactly this reason: `fs.exists` **follows** the leaf and so
mis-answers on a symlink, whereas `lstat` reports *presence without follow*. That
is the same substitution proposed here (existence probe: `exists`→`lstat`).

**Verified transfer — the semantics line up, not just the API.** ADR-343's driver
was **DG1**: a *dangling* untracked symlink must still count as "present" (git's
untracked probe is `lstat`-based), and `fs.exists` regressed that by following the
(broken) link and returning `false`. For the object-store probe the concern is the
**mirror image** — a symlinked-loose object whose target *escapes root*: here
`exists` does not under-report, it *throws PERMISSION_DENIED at the probe*. In both
cases the fix is identical (probe presence with `lstat`, don't follow the leaf) and
the *direction* is safe:

- ADR-343 case (dangling link): `exists`=false (wrong) → `lstat`=present (right,
  git-faithful). The switch **fixes** an under-report.
- Object-store case (a) normal loose: both agree "present" — no change.
- Object-store case (c) escaping symlink: `exists`=throws-at-probe →
  `lstat`=present-then-read-throws — **same final error**, so the switch is
  **neutral** (not a regression, not a fix — the pathological case observably
  unchanged).

So ADR-343's reasoning (lstat = presence-without-follow, git-faithful) applies
directly, and the one place the object-store probe differs from ADR-343's untracked
probe (escaping vs dangling target) is precisely the case walk's case (c), which is
shown neutral above. No new divergence; ADR-343 is a genuine precedent, not a
name-drop. (Because the switch is *behaviour-preserving* here — unlike ADR-343,
which was a faithfulness *fix* — the object-store switch needs **no** ADR of its
own; it is a performance-only mechanism change under an unchanged precedence.)

##### The win is real given finding (3)'s cache — with a size caveat

`dirname(looseObjectPath(id))` = `${gitDir}/objects/${id[0:2]}` — a fanout dir.
There are exactly **256** fanout dirs. During a history walk the objects read are
spread across these 256 dirs, and every same-fanout probe after the first is a
`parentRealpathCache` **hit** → `realpath` runs ≤256 times total instead of once
per object (thousands). Combined with 5a's fold, the per-object loose probe becomes:
one `fsOps.lstat` syscall + a cached-string join — the uncached full-path `realpath`
that was the 0.18 share is gone.

**Cache-size caveat (recommendation).** `parentRealpathCache` is
`createLruCache(64 * 1024, 64)` — `maxEntries = 64` (node-file-system.ts L314,
`createLruCache` signature `(maxSizeBytes, maxEntries)` verified). **64 < 256
fanout dirs.** If a walk touches more than 64 distinct fanout dirs (large repos
routinely touch all 256), the LRU **thrashes**: fanout entries evict each other and
the realpath is re-paid, blunting the win. **Recommendation: raise `maxEntries` to
≥ 256** (e.g. `createLruCache(64 * 1024, 512)`) so all 256 fanout dirs plus the
handful of creation-mode parents coexist. The byte budget (64 KiB) already
comfortably holds ~300 short `${gitDir}/objects/xx` strings (each ~40–60 bytes →
~18 KiB), so only the entry cap needs raising; keep the byte cap as the real
ceiling. Surfaced as **DC-9** (it is a shared-cache tuning that interacts with
finding 3). Without the bump the win still exists on smaller repos and on the
common case where a walk clusters in few fanout dirs, but the bump makes it robust
for full-history walks.

**Lever 5c — trusted-internal-path fast-path (NOT proposed; documented + rejected).**
Skipping realpath+containment for paths lexically under the canonical gitDir would
remove the containment cost itself but **carves a hole in the "every FS op is
containment-checked" invariant** — a security-boundary change. 5a+5e address the
share without it, so 5c is **not proposed**. Returns only if a future profile shows
containment *itself* dominating after 5a+5e, as its own security-reviewed proposal
with a precisely-defined trust boundary (only paths lexically under the canonical
gitDir, library-constructed, never user-derived) — requiring explicit user sign-off.

**Lever 5d — object-existence caching (REJECTED — does not address the hot case).**
Positive-only caching of loose existence yields zero hits on the **packed** common
case (packed objects are never loose), so it does not touch the 0.18 share.
Rejected.

#### Sibling probes — the same `exists`→`lstat` switch generalises (precedence unchanged in each)

All three sibling probes probe a **loose object path** with `ctx.fs.exists`, so the
same switch applies to each — **only the probe mechanism changes; each keeps its
own precedence**:

| Caller | File / line | Precedence (UNCHANGED) | Probe today | Probe after |
|--------|-------------|------------------------|-------------|-------------|
| `resolveObject`/`tryLoose` | `object-resolver.ts` L148 | loose-first | `exists(loosePath)` then read | `lstat(loosePath)` presence + read (5a+5e) |
| `hasObject` | `has-object.ts` L16 | **pack-first** (already) | `exists(loosePath)` (after pack miss) | **unchanged — kept on `exists`** (see session narrowing) |
| `objectExistsLocally` | `commands/fetch-missing.ts` L56 | loose-first | `exists(loosePath)` then pack | **unchanged — kept on `exists`** (see session narrowing) |

**Session narrowing (supersedes the original all-three proposal) — switch `tryLoose`
ONLY; leave `hasObject`/`objectExistsLocally` on `exists`.** The two sibling probes
are **pure presence probes** (they return a boolean / fall to pack; they never read
the bytes), so — unlike `tryLoose`, where the subsequent `read` re-throws — an
`exists`→`lstat` switch there is **not** behaviour-preserving in case (c): the
escaping-symlink observable would change from "throws `PERMISSION_DENIED`" to
"reports present" (no subsequent read to re-throw). That answer is arguably *more*
git-faithful (git's presence probe is `lstat`-based), but it is a **behaviour
change**, and this PR's binding contract is **behaviour-preserving**. Decisively:
the 0.18 `exists` self-share lives entirely in the **history-walk read path**
(`resolveObject`/`tryLoose` in log/describe/name-rev) — `hasObject` and
`objectExistsLocally` are fetch/negotiation probes, **not** hot frames — so
switching them buys ~no perf while spending strict behaviour-preservation on a
pathological corner. They are therefore **left on `exists`** (strictly
behaviour-preserving, precedence untouched). The `exists`→`lstat` *faithfulness*
improvement for pure-presence probes is a separate, behaviour-changing concern noted
for a possible future faithfulness item — out of scope for this behaviour-preserving
perf PR. Only `tryLoose`/`looseCompressedBytes` switch (5a+5e), where the switch is
provably behaviour-preserving via the following read.

#### Faithfulness pin for finding (5)

- **Healthy repo (all existing goldens):** every object read (loose-hit,
  packed-hit, missing→`objectNotFound`) is byte-identical under 5a+5e — the probe
  mechanism changes but the resolution decision and returned bytes do not. The
  existing read-object / object-storage / per-command interop suites stay green with
  **unchanged assertions** — the pin.
- **Escaping-symlink corner (pathological):** `resolveObject`/`tryLoose` throws the
  same `PERMISSION_DENIED` (case (c) above, guaranteed by the existing read test) —
  behaviour-preserving. `hasObject`/`objectExistsLocally` are **unchanged** (kept on
  `exists`), so their escaping-symlink behaviour is byte-identical to today. **No** ADR,
  **no** git-precedence divergence, **no** behaviour change anywhere in the PR.

### What does NOT change

- Method signatures of the 18 public FS ops — unchanged.
- The dual-root (`raw` OR `canonical`) containment *logic* and its verdict — the
  closure→predicate hoist (Lever B) is a mechanical refactor of *where* the
  boolean is computed, not *what* it computes.
- The `permissionDenied` / `fileNotFound` / `mapErrno` mapping and the two
  `Stryker disable` equivalent comments on the catch arms (L776, L778) —
  untouched.
- The leaf-follow behaviour of read/exists mode — untouched (finding (3) is
  lstat-mode only).
- `creationParentCache`'s invalidation sites (`rmRecursive` L604, `rename` L543) —
  reused, not removed; the rename may be the only textual change (`creationParent`
  → `parentRealpath`).

**What DOES change (signatures + primitive internals):**
- `resolveForMode`'s callback parameter `check: (abs) => void` is **removed** and
  replaced by the two normalised-root strings (Lever B) — a private internal
  method, no public surface.
- `creationParentCache` field renamed `parentRealpathCache`, gains a second reader
  (the lstat arm) (finding 3), and its `maxEntries` raised 64→≥256 (finding 5e /
  DC-9) so the 256 fanout dirs do not thrash.
- `tryLoose` and `looseCompressedBytes` (`object-resolver.ts`) lose their `exists`
  probe: the loose **presence** probe switches to `ctx.fs.lstat` (5e), folded with
  the read via one `FILE_NOT_FOUND`-catch (5a). No signature change; internal only.
- `hasObject` (`has-object.ts`) and `objectExistsLocally` (`fetch-missing.ts`)
  switch their loose presence probe `ctx.fs.exists`→`ctx.fs.lstat` (5e). Precedence
  unchanged in each (pack-first stays pack-first; loose-first stays loose-first).
- **Precedence and store order are NOT changed** — the pack-first reorder is
  rejected (DC-7). `object-resolver.ts`'s "loose-first-then-pack" docstring stays.

## Behaviour preservation — the pin is the existing suite, unchanged

Contract A applies to **all shipping work — Levers A, B, finding (3), finding (5a)
and finding (5e)** — every one an internal FS-adapter / object-resolver refactor
that is **not git-observable on a healthy repo**, with git's loose-first object
precedence preserved. No new real-git interop golden is needed; the pin is the
existing behavioural suite staying green with **unchanged assertions**. If any of
these required editing an existing behavioural assertion it would not be
behaviour-preserving and would be rejected — none do.

The **only** observable deltas are in the pathological escaping-symlink-loose-object
corner (git never writes such a file): `resolveObject` throws the same
`PERMISSION_DENIED` (throw point moves probe→read, error identical), and
`hasObject`/`objectExistsLocally` move from "throws" to "reports present" — the
*more* git-faithful `lstat` presence answer. These have no existing golden and are
pinned by **new defensive unit tests** (mutation plan), not by editing any existing
assertion. There is **no** git-precedence divergence and **no** ADR (DC-7 kept
loose-first; DC-8 N/A).

### Exact guarding test files (must stay green, assertions unchanged)

| File | What it guards on `checkContainment` / `exists` |
|------|--------------------------------------------------|
| `test/unit/adapters/node/node-file-system.test.ts` | Real-FS containment security: symlink-escape → `PERMISSION_DENIED` (L73–91), symlink-swap escape (L99–117), lstat-mode escaped-parent (L125–142), rename-escape via absolute path (L349–369), `rootDir===resolved` short-circuit (L288), FILE_NOT_FOUND vs PERMISSION_DENIED distinction (L249). |
| `test/unit/adapters/node/node-file-system-injected.test.ts` | DI-mocked `fsOps.realpath` call-**count** pins: creation LRU (L58–), non-ENOENT parent → PERMISSION_DENIED (L150–175), missing-parent slow walk-up call count = 4 (L181–212), rmRecursive cache-clear count = 3 (L216–248). These count `realpath` invocations — the direct observable of Lever A *and* finding (3)'s cache behaviour (see mutation plan). |
| `test/integration/checkout-replace-symlink-with-file-interop.test.ts` | The one path-containment-adjacent interop test; exercises symlink→file replacement through the adapter. Stays green unchanged. |
| read-object / object-storage unit + interop suites (`object-resolver`, `read-object` consumers) | Finding (5): every object read (loose-hit, packed-hit, missing→`objectNotFound`) on a **healthy** repo returns byte-identical results under 5a's fold and 5e's probe switch — precedence unchanged. Stays green with unchanged assertions. |
| `node-file-system.test.ts` L71–95 (escaping-symlink read → `PERMISSION_DENIED`) | Finding (5e) case (c): after the `lstat` probe reports present, the subsequent `read` through an escaping symlink throws `PERMISSION_DENIED` — this existing test guarantees the throw, unchanged. |

Additionally the whole `npm run test:unit` + `npm run test:integration` suites
(every command that drives the adapter) must stay green with zero assertion edits.
The existing containment tests double as the Lever B safety net: the closure→
predicate hoist is behaviour-preserving iff every escape test still throws
`PERMISSION_DENIED` with the same code, unchanged.

### First-call vs later-call realpath(rootDir) count — the observable of Lever A

`getCanonicalRoot` calls `fsOps.realpath(this.rootDir)` **exactly once** ever (it
is memoised behind `canonicalRootPromise`). Lever A does not change *how many*
times `realpath(rootDir)` runs — it changes *whether a microtask is scheduled*
when the field is already set. The `realpath`-call-count invariant is therefore
**identical** before and after: the injected tests' counts (4, 3, once-per-parent)
must be unchanged. A mutant that broke the guard (e.g. always-await, or
never-await) would either (a) leave counts identical but change timing — not
directly killable by count — or (b) if it dropped the await entirely on the first
call, read `normalizedCanonicalRoot!` before it is set and throw/return wrong,
which IS killable. See the mutation plan.

## Faithfulness pinning matrix

No new git-behaviour to pin (internal refactor). The matrix here is the
**invariant-preservation** matrix rather than a git-bytes matrix:

| Property | Before | After (A+B+3+5) | Pinned by |
|----------|--------|------------------|-----------|
| `PERMISSION_DENIED` on every escape (symlink / absolute / short-name) | yes | yes | `node-file-system.test.ts` L73–369 (unchanged) |
| `FILE_NOT_FOUND` vs `PERMISSION_DENIED` split | yes | yes | `node-file-system.test.ts` L249 (unchanged) |
| `realpath(rootDir)` runs exactly once per adapter lifetime | yes | yes | memoisation intact; injected count tests |
| Dual-root OR verdict (closure vs predicate) | yes | yes | Lever B: escape tests + new per-disjunct isolated tests |
| Leaf symlink still followed in read/exists mode (containment catches leaf escape) | yes | yes | finding (3) leaves read/exists untouched; symlink-escape test L73 |
| lstat leaf NOT followed; leaf re-stat'd fresh every call (TOCTOU) | yes | yes | finding (3) caches parent only; leaf stat by caller unchanged |
| lstat-parent realpath deduped per directory, invalidated on rename/rmRecursive | (n/a) | yes | new injected call-count tests (mirror creation LRU L58/L216) |
| Per-path realpath re-run every op (read/exists TOCTOU) | yes | yes | read/exists arms untouched |
| Object bytes returned (healthy repo) identical; loose-first precedence preserved | yes | yes | finding (5): probe mechanism only; read-object/object-storage interop unchanged |
| `objectNotFound` on the same missing oids | yes | yes | finding (5): probe returns undefined on `FILE_NOT_FOUND` → pack → miss still throws `objectNotFound` |
| Loose read/probe errors (non-ENOENT) propagate unchanged | yes | yes | finding (5) precise `FILE_NOT_FOUND`-only catch; every other error rethrown |
| Escaping-symlink loose object → `resolveObject` throws `PERMISSION_DENIED` | yes (at probe) | yes (at read) | finding (5e) case (c): same code/path, throw point moves probe→read; existing L71–95 read test |
| Escaping-symlink loose path → `hasObject`/`objectExistsLocally` presence | throws today | reports present (git-faithful `lstat`) | new defensive unit test; pathological, no golden, more faithful |
| Corrupt-loose + valid-pack shadow behaviour | divergent today (throws) | **unchanged** (still throws — loose-first kept, no reorder) | 5a's inflate stays outside the try; precedence untouched |
| Transient-ENOENT rootDir retries | yes | yes | rejection arm clears sentinel (L384–385), guard re-awaits |
| Concurrent first-call de-dup | yes | yes | shared `canonicalRootPromise` (unchanged) |
| Error object identity / codes / messages | yes | yes | catch arms untouched; Stryker-disable comments intact |

No new git interop golden is warranted: finding (5) preserves git's loose-first
precedence and is byte-identical on healthy repos; the only observable deltas are
in the pathological escaping-symlink corner (no existing golden, and the new
`hasObject`/`objectExistsLocally` answer is the *more* git-faithful one), pinned by
new defensive **unit** tests, not interop goldens (see DC-4).

## Perf pinning plan

Mechanism: `npm run profile <cmd>` (26.3 / PR #224; `tooling/profile.ts` +
`tooling/profile-registry.ts`). Every hot command below is already in the
registry and re-profilable.

**Commands to re-profile** (the baseline's `checkContainment`-heavy set plus the
lstat-heavy `status`), with current self-share and expected direction:

| Command | Kind | `checkContainment` self | `exists` self | `lstat`/`resolveForMode` self | Expected after A+B+3+5 |
|---------|------|-------|-------|-------|-------|
| diff | read | 0.36 | 0.05 | — | `checkContainment`+`check` ↓ |
| name-rev | read | 0.26 | 0.18 | — | `checkContainment`+`check` ↓; **`exists` ↓↓ (5e cached probe)** |
| blame | read | 0.24 | — | — | `checkContainment`+`check` ↓ |
| describe | read | 0.18 | 0.18 | — | `checkContainment`+`check` ↓; **`exists` ↓↓ (5e)** |
| show | read | 0.13 | 0.01 | — | `checkContainment`+`check` ↓ |
| status | read | 0.12 | — | `lstat` 0.25 / `resolveForMode` 0.14 | `checkContainment`+`check` ↓ **and** `lstat`/`resolveForMode` ↓ (finding 3) |
| merge | write | 0.16 | 0.13 | — | ↓ (command partition) |
| log | read | 0.09 | 0.18 | — | `checkContainment`+`check` ↓; **`exists` ↓↓ (5e)** |

Direction, not magnitude, is the gate (shares are self-relative and host-portable,
ADR-475). Four expected shifts:

1. **Lever A** removes the guaranteed microtask from `checkContainment`, `exists`,
   `symlink` → those self-shares drop, share moves onto genuine work frames.
2. **Lever B** removes the per-call closure alloc → the `check` frame's self-share
   drops (folded into the named predicate / call sites).
3. **Finding (3)** dedupes the lstat-mode parent realpath → `status`'s `lstat` /
   `resolveForMode` self-shares drop as N same-directory realpaths collapse to 1.
4. **Finding (5)** removes the wasted per-object loose-probe cost on packed-repo
   walks **without reordering** (loose-first kept): **5a** folds `exists`+`read`
   into one probe path, and **5e** switches that probe from an *uncached full-path
   `realpath`-follow* (`exists`) to a *cached `realpath(fanout dir)` + cheap `lstat`*
   (`lstat`-mode, reusing finding (3)'s cache). The **mechanism** of the drop: the
   per-object uncached `realpath` that was the 0.18 `exists` share becomes ≤256
   fanout-dir realpaths (cached after first touch) — so the `exists` self-share
   drops on log/describe/name-rev because the expensive per-object realpath is gone,
   **not** because the probe stops firing (it still fires, loose-first).

**Honest caveat on the `exists` share:** the drop is real and needs **no reorder**,
but it is **gated on the cache-size bump (DC-9)**: with `maxEntries=64 < 256` fanout
dirs, a full-history walk **thrashes** the LRU and re-pays the fanout realpath,
blunting the win. With the bump to ≥256 the 256 fanout realpaths are paid once each
and the share collapses toward the residual `lstat` syscall cost. If DC-9 is
declined, the win degrades to "cheaper on walks that cluster in few fanout dirs" —
state the landed cache size in the PR body alongside the measured `exists` share.
Lever A additionally removes `exists`'s microtask component regardless.

**Baseline handling — RATIFIED (DC-3 → Option A): regenerate + commit**
`docs/perf/baseline.json` (+ sibling `docs/perf/baseline.md`) in this PR as the
new post-optimisation reference; quote before/after `checkContainment`, `check`,
`lstat`, `resolveForMode`, and `exists` shares in the PR body (note whether the
DC-9 cache bump landed, since the `exists` drop depends on it). ADR-475
established the committed baseline as the moving optimisation-license + regression
reference the 26.5 CI gate diffs against; 26.4 spends that license, so the artifact
advances. `generatedOn` banner stays metadata, never compared (ADR-475).

## Mutation plan

The file carries two `Stryker disable next-line` equivalent-mutant proofs on
`checkContainment`'s catch arms (L776 TsgitError early-rethrow, L778 ENOENT
short-circuit). **These proofs are structure-specific to the current catch
arms and MUST NOT be disturbed** — Lever A does not touch the catch block, so
they carry forward verbatim. Do not renumber, reword, or move them.

The new code is the guard `if (this.normalizedCanonicalRoot === undefined) {
await this.getCanonicalRoot(); }` at the three sites (L760, L462, L567). Each is
an independent mutation location, so each needs its own first-call kill test (a
mutant on `exists`'s guard is not killed by a `checkContainment` test and vice
versa; `symlink`'s guard needs a first-op-is-`symlink`-with-absolute-target
test). Stryker mutants to consider and how each is killed:

- **`ConditionalExpression` → `true` (always await).** Behaviourally
  indistinguishable from today on a settled promise (same result, extra
  microtask) — a **timing-only** difference with no functional observable. This
  is a genuine **equivalent mutant** and will survive; it needs a documented
  equivalent-mutant justification, NOT a contrived test. Reason: forcing the
  await when the field is set only re-schedules a microtask that resolves to the
  same value and leaves the same post-condition — no output, no call-count, no
  error changes.
- **`ConditionalExpression` → `false` (never await).** On the **first** call the
  field is `undefined`, the await is skipped, and `getResolvedNormalizedCanonicalRoot()`
  reads `normalizedCanonicalRoot!` while it is `undefined` → the first
  containment check compares against `undefined` and mis-decides (or the `!`
  masks it and `pathContainsNormalized` receives `undefined`, producing a wrong
  verdict / throw). **Killable** by a test whose adapter's very first FS op is a
  `checkContainment`/`exists` call with a mocked `realpath(rootDir)` that would
  otherwise populate the field — the first-call must still succeed. This is the
  test the plan must add: *"Given a fresh adapter, When the first FS op runs,
  Then it awaits canonical-root resolution before checking containment."*
  Observable via the injected `fsOps.realpath` spy: the first op must call
  `realpath(rootDir)` and succeed; skipping the await surfaces as a first-call
  failure or a `realpath(rootDir)` never issued.
- **`EqualityOperator` / `ConditionalExpression` on `=== undefined`.** Flipping
  to `!== undefined` inverts the guard → same as "never await first call" on the
  first call → killed by the same first-call test.

Make the gate observable/killable via the **injected `fsOps.realpath` call
sequence on a fresh adapter** — the existing, mutation-proven mechanism in
`node-file-system-injected.test.ts`. Timing (microtask counting) is deliberately
NOT asserted; the functional first-call-correctness assertion kills the meaningful
mutants, and the always-await mutant is accepted as provably equivalent.

**Lever B — predicate mutants.** `isContainedInEitherRoot`'s `||` (→`&&`) and
each `pathContainsNormalized` disjunct (→`false`) are new mutation targets. Kill
with **isolated per-disjunct tests** (per the "guard clauses need isolated tests"
rule): (a) a path contained by the **raw** root only (canonical differs, e.g.
8.3-shortname divergence) must pass — kills "drop the raw disjunct"; (b) a path
contained by the **canonical** root only must pass — kills "drop the canonical
disjunct"; (c) a path outside **both** must throw `PERMISSION_DENIED` — kills
`||`→`&&` (which would demand containment in both). The existing escape tests
cover (c); (a)/(b) are the additions.

**Finding (3) — cache mutants.** The lstat-arm cache reuses `createLruCache`
(already mutation-proven for creation mode), so the *cache internals* are covered.
The new decision points are the lstat-arm `get`/`set`/miss branch. Mirror the
existing creation call-count tests (L58 LRU-hit, L216 rmRecursive-clear):
- **Hit test:** two `lstat`s of **same-directory** siblings on a fresh adapter →
  `realpath(dirname)` called **once** (second is a cache hit). Kills a mutant that
  skips the `get` (would call realpath twice) or skips the `set` (same).
- **Miss/distinct-dir test:** two `lstat`s in **different** directories →
  `realpath` called **twice** (no false sharing). Kills a mutant that keys the
  cache wrong or over-shares.
- **Invalidation test:** `lstat` (populates) → `rmRecursive` or `rename` (clears)
  → `lstat` same dir → `realpath(dirname)` called **twice total** across the
  sequence. Kills a mutant that drops the `clear()` (would stay at once) — this is
  the exact shape of the existing L216 rmRecursive count=3 test, extended to the
  lstat entry.
- **ENOENT-not-cached test:** `lstat` of a path whose parent is ENOENT does not
  populate the cache (mirror L181 slow-walk-nothing-cached), so a later
  same-parent call re-attempts. Kills a mutant that caches on the throw path.

These all assert `fsOps.realpath` call counts — the same observable the creation
cache tests already pin, so finding (3) rides the established, mutation-hard
harness rather than inventing new assertions.

**Finding (5a + 5e) — the precise catch on the `lstat` probe.** The probe becomes
`try { stat = await ctx.fs.lstat(path) } catch (err) { if (err instanceof
TsgitError && err.data.code === 'FILE_NOT_FOUND') return undefined; throw err }`
followed, on success, by the `read`. Mutation-critical pieces:
- **`code === 'FILE_NOT_FOUND'` StringLiteral mutant** (→`""`): the catch never
  matches → a missing loose object throws instead of returning `undefined` → the
  pack fallback is never reached → `objectNotFound` for a *packed* object. Killed
  by a test: a **packed-only** object (`ctx.fs.lstat` ENOENT→`FILE_NOT_FOUND`)
  resolves successfully via the pack — proves the not-found is caught and the
  fallthrough reached.
- **`instanceof TsgitError` / `&&`→`||` mutant:** broadens the catch to swallow
  non-`FILE_NOT_FOUND` errors. Killed by a test injecting a `ctx.fs.lstat` (or the
  subsequent `read`) that throws `PERMISSION_DENIED` for the loose path →
  `resolveObject` must **propagate** it, not return `undefined`/fall to pack. (No
  swallowed errors.)
- **`return undefined` → `throw`/drop:** killed by the packed-only resolve test
  (loose-miss must yield `undefined` to reach the pack).

**Finding (5e) — the `exists`→`lstat` probe switch itself.** The observable is the
probe *mechanism* under an unchanged precedence. Kill with DI/injected-`ctx.fs`
tests:
- (a) **loose-only** object resolves via loose (probe present → read) — proves the
  loose-first precedence is preserved and the `lstat` probe correctly reports
  present. A mutant that reverted `lstat`→`exists` still passes this (both work on a
  regular file), so this test is about *precedence preservation*, not the switch.
- (b) **case (c) — escaping-symlink loose object:** `resolveObject` must throw
  `PERMISSION_DENIED` (via the subsequent read), and the injected `ctx.fs.lstat`
  must be called with the loose path and **not** follow the leaf (the probe
  succeeds; the read raises). Assert `TsgitError.data.code === 'PERMISSION_DENIED'`
  via try/catch. Kills a mutant that reverts to `exists` **only if** the error
  identity differs — since both surface PERMISSION_DENIED, this test primarily pins
  that the switch did not *change* the surfaced error (the behaviour-preservation
  claim), which is the load-bearing assertion.
- (c) **`hasObject`/`objectExistsLocally` presence on the escaping-symlink loose
  path:** must **report present** (`true` / not-missing) under the `lstat` probe —
  the new git-faithful answer. Kills a mutant reverting to `exists` (which would
  throw / report absent). This is the one place the switch changes an observable,
  so it gets a dedicated defensive test.
- (d) **cache reuse (the perf-behavioural pin):** a walk resolving N packed objects
  spread across ≤256 fanout dirs issues `realpath(fanout dir)` **at most once per
  distinct fanout dir** (spy on `fsOps.realpath`), not once per object — proves 5e
  actually rides finding (3)'s `parentRealpathCache`. Kills a mutant that bypasses
  the cache (would show N realpaths). This test also **regression-guards DC-9**:
  run it with > `maxEntries` distinct fanout dirs and assert no re-realpath of an
  already-seen dir within the LRU window.

Assert against `TsgitError.data.code` directly (try/catch, not `toThrow(Class)`)
per the mutation-resistant-patterns rule.

## Non-goals / explicitly deferred

This PR ships baseline findings **(1) checkContainment** (Levers A + B), **(3)
lstat-mode parent-realpath batching**, and **(5) the packed-repo `exists`-share**
(5a + 5e, both behaviour-preserving, loose-first preserved). The remaining 26.3
findings stay out of scope and become follow-up backlog entries — **only these two
now**:

- **(2) TREESAME pruning** — deferred (separate walk-pruning concern).
- **(4) tree walk / parse** — deferred.

Also documented but **not** in this PR:

- **Pack-first reorder (former Lever 5b)** — **REJECTED** (DC-7 → stay faithful to
  git's loose-first precedence). Not deferred — rejected; not revisited.
- **Lever 5c (trusted-internal-path fast-path)** — security-boundary change, not
  proposed (5a+5e address the share without it); returns only if a future profile
  shows containment *itself* dominating, as its own security-reviewed proposal
  (see finding (5)).
- **`status` `readdir`-coalesce** for the *working-tree* `exists`/`lstat` batching
  at the command layer — a distinct, larger `status` redesign; deferred (this PR's
  finding (3) covers the safe adapter-level lstat-parent cache; the command-layer
  coalesce is its own item).
- Browser/memory adapters — carry neither the node canonicalisation nor the
  creation-cache template; untouched.

## Decision candidates

DC-1, DC-2, DC-3, DC-4, DC-6, DC-7 are **ratified** at the decisions gate (recorded
for the audit trail); **DC-8 is now N/A** (its reorder was rejected by DC-7).
**DC-5 (cache shape)** and **DC-9 (cache-size bump)** are the remaining open items —
recommendations stated. With DC-7 resolved to stay faithful, the entire PR is
behaviour-preserving and there are **no more ★ user-sign-off items** on the object
path (DC-9 is a routine tuning call).

### DC-1 — Scope — **RATIFIED → Option B (widen)**

Ship finding (1) `checkContainment` **and** finding (3) lstat-mode parent-realpath
batching this PR. Findings (2) TREESAME and (4) tree walk/parse remain follow-up
backlog entries. (The prior draft recommended Option A / checkContainment-only;
the user widened.)

### DC-2 — Approach — **RATIFIED → Option B (Lever A + Lever B)**

Ship **both** Lever A (gate the settled-promise await at all three sites) **and**
Lever B (hoist the `check` closure to the `isContainedInEitherRoot` predicate,
narrowing `resolveForMode`'s signature by dropping the callback). Lever C
(whole-decision memoisation) stays rejected (TOCTOU-unfaithful, wrong frame). (The
prior draft recommended deferring B; the user included it.)

### DC-3 — Baseline — **RATIFIED → Option A (regenerate + commit)**

Regenerate and commit `docs/perf/baseline.{json,md}` reflecting the
post-optimisation shares; quote before/after in the PR body. `generatedOn` banner
stays metadata (ADR-475).

### DC-4 — ADR need — **RATIFIED → no ADR anywhere in this PR**

No standalone ADR for **any** shipping work (Levers A/B, finding (3), finding (5a),
finding (5e)) — all behaviour-preserving, no git-precedence divergence, no
public-contract change. ADR-475 already establishes the baseline-as-moving-reference
policy, so committing an updated baseline is *using* that policy, not new policy — no
ADR for DC-3 either. The one thing that *would* have needed an ADR — the pack-first
reorder — was **rejected** (DC-7), so DC-8 is N/A. The `exists`→`lstat` probe switch
(finding 5e) rides the **existing** ADR-343 precedent (verified to transfer), so it
needs no ADR of its own.

**Re-assessment (finding (3) caching policy): no new ADR.** Finding (3) does
**not** introduce a new cache *with a new invalidation contract* — it **extends an
existing, already-shipped cache** (`creationParentCache`) to a second read mode,
reusing its *exact* invalidation contract (cleared by `rmRecursive` + `rename`)
and its exact TOCTOU envelope (parent-directory realpath cached; leaf never
cached; stable-directory assumption). No new policy is being decided — the policy
(parent-realpath caching under git's directory-stability assumption, invalidated
on structural mutators) was already decided when `creationParentCache` shipped.
An ADR records a *choice between alternatives with consequences*; here the only
genuine choice is the **cache shape** (one cache vs two vs composite key), which is
a design-doc-level implementation detail surfaced as DC-5, not an
architecture-level policy. If the gate *disagrees* and considers "widening a
security-adjacent cache's read surface" policy-bearing, a ≤1-paragraph ADR noting
"lstat-mode reuses the creation parent cache; leaf-follow modes deliberately
excluded for containment safety" would suffice — but the recommendation is that
the design doc's finding-(3) section already carries that reasoning and no ADR is
warranted.

### DC-5 — **NEW** — Cache shape for the lstat-mode parent realpath

- **Option A (recommended):** **reuse the single `creationParentCache`**, renamed
  `parentRealpathCache`, for both creation and lstat modes. The cached value (a
  parent's realpath) is mode-independent, so entries are shared (a parent
  realpath'd for a write and later lstat'd is one entry — a free cross-mode hit),
  and the existing `clear()` invalidation already covers both. Smallest diff,
  no new field, no composite key.
- **Option B:** a **separate dedicated `lstatParentCache`** field alongside the
  creation one. Keeps the two modes' caches independent (easier to reason about in
  isolation) but duplicates the field, the size budget, and every invalidation
  `clear()` call — and loses the cross-mode hit for no semantic gain.
- **Option C:** a **unified cache keyed by `(parent, modeClass)`**. Most explicit,
  but the value is identical across modes so the mode in the key is dead
  discrimination — pure overhead.
- **Recommendation: Option A.** The value is mode-independent; one cache is the
  honest model.

### DC-6 — exists-share scope — **RATIFIED → EXPAND (ship in this PR)**

The user accepted "higher risk, larger diff" and chose to ship the `exists`-share
reduction in **this** PR rather than defer it. Finding (5) (5a + 5e) is in scope.
The distinct **`status` `readdir`-coalesce** for the *working-tree* exists/lstat
batch stays a separate follow-up — finding (5) is about the *object-store* loose
probe on history walks, a different code path from the working-tree scan.

### DC-7 ★ — Object-lookup ordering — **RATIFIED → STAY FAITHFUL (loose-first; reorder REJECTED)**

Empirically pinned (git 2.55.0, matrix in finding (5)): **git is
loose-first-then-pack**. The user chose to **preserve git's loose-first
precedence** and **reject** the pack-first reorder. So the exists-share win is
delivered **without** any precedence change: **5a** (fold the check-then-read) +
**5e** (switch the loose *presence* probe from `exists`'s uncached full-path
`realpath`-follow to an `lstat`-based probe reusing finding-3's fanout-dir realpath
cache). This keeps the same loose-first probe order and makes it cheaper — zero
git-precedence divergence, no corruption-corner change, no ADR. (Superseded the
prior draft's Option-A/reorder recommendation.)

### DC-8 — ADR for the reorder — **N/A (reorder rejected by DC-7)**

The reorder is not happening, so its ADR is moot. The remaining exists-share work
(5a + 5e) is behaviour-preserving under an unchanged precedence and needs **no**
ADR — consistent with DC-4's verdict for the rest of the refactor. ADR-343 is cited
as the *established precedent* for the `exists`→`lstat` presence-probe substitution
(verified to transfer — see finding (5)), which is what lets 5e ship without a new
ADR.

### DC-9 — **NEW (open)** — `parentRealpathCache` size: keep `maxEntries=64` vs raise to ≥256

Finding (5e) makes the loose probe hit `parentRealpathCache` for the **256** object
fanout dirs. The cache is `createLruCache(64 * 1024, 64)` — `maxEntries=64 < 256`,
so a full-history walk **thrashes** the fanout entries and re-pays the realpath,
blunting the win.

- **Option A (recommended):** **raise `maxEntries` to ≥256** (e.g.
  `createLruCache(64 * 1024, 512)` for headroom over the 256 fanout dirs + a few
  creation-mode parents). The 64 KiB byte cap already holds ~300 short
  `${gitDir}/objects/xx` strings (~18 KiB), so only the entry cap needs raising;
  the byte cap stays the real ceiling. Delivers the finding-5e win robustly on
  full-history walks.
- **Option B:** **keep `maxEntries=64`.** No tuning churn, but the fanout dirs
  thrash on large walks and the exists-share win degrades to "cheaper only when the
  walk clusters in ≤64 fanout dirs". Undersells the ratified EXPAND goal.
- **Option C:** decouple — a **separate** larger cache dedicated to the object
  fanout dirs, leaving the creation/lstat cache at 64. More surface, and it forfeits
  the cross-mode sharing DC-5 Option A chose; no benefit over simply raising the one
  cache's entry cap.
- **Recommendation: Option A** (raise to ≥256). It is the cheap enabler that makes
  finding (5e) actually collapse the share on real walks. Interacts with DC-5
  (Option A single cache) — the bump applies to that one shared `parentRealpathCache`.

### Lever 5c note (★ if ever proposed) — trusted-internal-path fast-path

Not proposed in this PR (5a+5e address the share without carving a hole in the
"every FS op is containment-checked" invariant). Recorded so the gate knows it was
considered and consciously set aside. **If** a future profile shows containment
*itself* dominating after 5a+5e, 5c returns as a standalone proposal requiring
**explicit user sign-off + a security-review focus**, with the trust boundary
defined precisely (only paths lexically under the canonical gitDir, library-
constructed, never derived from user input) — the coordinator routes it to the
security dimension. Flagged here, not designed.
