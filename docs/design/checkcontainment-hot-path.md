# Design — checkContainment + object-lookup hot path: gate the settled-promise await, hoist the per-call closure, cache the lstat-mode parent realpath, drop the wasted per-object loose probe

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
> once per directory; **plus** baseline finding (5): the wasted per-object
> `exists(looseObjectPath)` on packed-repo history walks (`exists` self-share 0.18
> in log/describe/name-rev) — fold `exists`+`read` into a single try-`read`
> (5a, faithfulness-neutral, always ships) and reorder `resolveObject` pack-first
> (5b, the big packed-repo win, **gated on a user/ADR decision because git is
> empirically loose-first** — see the pinned matrix). Findings (1)/(3)/(5a) are
> behaviour-preserving; (5b) changes one already-divergent corruption corner and
> needs sign-off. Pure internal/primitive refactor — NOT a healthy-repo-observable
> change; the faithfulness pin is the existing suite staying green with unchanged
> assertions, plus a re-profile showing the self-share drop, with the improved
> `docs/perf/baseline.{json,md}` re-committed.
> Status: draft → self-reviewed ×3 → decisions ratified (DC-1→B widen, DC-2→B
> ship, DC-3→A commit baseline, DC-4→no refactor ADR, DC-6→EXPAND exists-share)
> → revised against decisions (Lever B + finding (3) + finding (5); git
> object-order pinned loose-first; DC-7/DC-8 opened for the reorder)

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

**Honest share accounting.** Finding (3) therefore addresses the `status`
`lstat`/`resolveForMode` shares (the lstat-heavy working-tree scan) — the biggest
concrete redundancy. It does **not** reduce the `exists` self-share (0.18 in
describe/name-rev/log): `exists` follows the leaf and cannot be parent-cached
safely. The `exists` frame's own *settled-await microtask* is removed by Lever A
(that part of its share drops), but its *realpath-follow* cost is irreducible
without weakening containment, so we do **not** claim an `exists` realpath-share
drop from finding (3). Read-mode object reads (loose object `read`) likewise keep
their leaf-follow realpath. This is the realistic boundary of safe batching.

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

### Finding (5) — the wasted per-object `exists` on packed-repo history walks (SHIPS — ratified DC-6 → EXPAND)

**The redundancy.** `resolveObject` (`src/application/primitives/object-resolver.ts`
L36) resolves **every** object loose-first:

```ts
const loose = await tryLoose(ctx, id);   // exists(looseObjectPath) THEN read
if (loose !== undefined) { … return … }
const hit = await registry.lookup(id);   // in-memory pack index (cheap) — only on loose-miss
```

and `tryLoose` (L148–153) is a **check-then-read**:

```ts
const path = looseObjectPath(commonGitDir(ctx), id);
if (!(await ctx.fs.exists(path))) return undefined;   // full realpath + dual-root containment; ENOENTs for packed objects
const compressed = await ctx.fs.read(path);           // ANOTHER full realpath + containment + open
return ctx.compressor.inflate(compressed);
```

On a **packed** repo (the common case: clone, then all history in packs), a walk
that reads thousands of commits+trees (log / describe / name-rev) issues one
wasted `exists(looseObjectPath)` per object — a `realpath` that ENOENTs plus the
dual-root containment check — before falling through to the pack index. That
wasted per-object `exists` is the `exists` self-share **0.18** in log / describe /
name-rev. `looseCompressedBytes` (L160–167) carries the same `exists`-then-`read`
double-probe for the loose-hit path.

**Sibling callers — the codebase is already inconsistent.** Two of the three
existence-probe sites are loose-first, one is already pack-first:

| Caller | File / line | Order today |
|--------|-------------|-------------|
| `resolveObject` | `object-resolver.ts` L36 | **loose-first** |
| `objectExistsLocally` | `commands/fetch-missing.ts` L56 | **loose-first** |
| `hasObject` | `has-object.ts` L14 | **pack-first** (already) |

So `hasObject` already probes the pack index before the loose `exists` — the
reorder makes the other two *consistent with an existing sibling*, not novel.

#### Empirical git object-lookup order — PINNED (loose-first)

Per `.claude/workflow/faithfulness.md`, pinned against **git 2.55.0** in two
independent `mktemp` throwaways (scrubbed `GIT_*`, isolated `HOME`,
`GIT_CONFIG_NOSYSTEM=1`, signing off — cleaned up after):

```
Setup:   commit a blob, `git repack -a` (object now BOTH loose AND packed).
Probe:   make the LOOSE copy writable, overwrite it with non-zlib garbage,
         `git cat-file -p <blob>`  (packed copy still valid).

Result (reproduced twice, deterministic):
  stderr: error: inflate: data stream error (incorrect header check)
  stdout: <the real blob content>
  exit:   0
```

**Reading:** git attempts the **loose** object first (hence the inflate error on
the corrupt loose copy), then **falls back to the pack** and returns the valid
content with exit 0. So canonical git's content-read precedence is
**loose-first-then-pack** (git's `oid_object_info_extended` consults
`loose_object_info` before the packed stores, with reprepare/fallback). The
`hasObject`-style *existence* probe order is not separately observable via
`cat-file`, but the content path is what governs `resolveObject`, and it is
loose-first.

#### Consequence for the reorder — it is NOT a blind faithful win

Because git is **loose-first**, reordering `resolveObject` to `registry.lookup(id)`
**pack-first** changes the store-precedence in the one corner where loose and pack
**disagree**: an object present as a **corrupt/unreadable loose** file *and* a
**valid packed** copy. There the observable differs:

- **git (loose-first):** tries loose → fails → warns → returns the packed content,
  **exit 0**.
- **A pack-first tsgit:** finds the object in the pack index first → returns the
  packed content → **never touches the corrupt loose file** → succeeds silently
  (no warning).

Both return the **same bytes** (content-addressed), so the *object* is
byte-identical; the divergence is only whether the corrupt-loose shadow is
*observed*. **Additional pinned fact about tsgit today:** tsgit's current
loose-first path does **not** match git in this corner either — `tryLoose` reads
the corrupt loose file and `ctx.compressor.inflate` **throws**, and that error
**propagates out of `resolveObject`** (there is no loose→pack fallback on an
inflate failure). So:

| Scenario (corrupt loose + valid pack) | git 2.55 | tsgit **today** / **5a-only** (loose-first, no fallback) | tsgit **5b pack-first** (proposed) |
|---|---|---|---|
| Returned bytes when resolvable | packed content, exit 0, warning | **throws** (inflate error propagates) | packed content, no warning |
| Faithful to git? | — | **NO** (already divergent — errors where git succeeds) | **NO** (succeeds silently where git warns) — but *closer*: succeeds like git |

(5a keeps loose-first, so 5a-only behaves like "today" in this corner — it still
throws; 5a's `read` fold does not add a loose→pack fallback. Only 5b changes the
corner, by never reading the loose file for a packed object.)

So neither today's code nor pack-first is byte-faithful in this corruption corner
— **tsgit is already divergent here**, and there is no existing ADR sanctioning
either behaviour (the healthy repo, which is all the goldens exercise, is
order-invariant because the bytes are identical). This reframes the decision:
reordering does not *introduce* a divergence into faithful code; it *changes one
already-divergent corner* from "throws" to "silently succeeds with correct bytes"
(arguably *less* surprising than today, and closer to git's exit-0, though without
git's warning). This is precisely why the ordering choice is a **decision
candidate for the user + an ADR** (DC-8), not a designer call.

#### The two levers for finding (5)

**Lever 5a — fold `exists`+`read` → single try-`read` (SHIPS regardless; faithfulness-neutral).**
Replace the check-then-read in `tryLoose` and `looseCompressedBytes` with a
single `read` that catches **exactly** the not-found code:

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
  return ctx.compressor.inflate(compressed);
}
```

Pinned: `ctx.fs.read` on a missing path throws `fileNotFound(path)` (code
`FILE_NOT_FOUND`) — `read` → `runFs` → `mapErrno` ENOENT arm → `fileNotFound`
(node-file-system.ts L137/L779, verified). So the catch is **precise** (one code,
return `undefined`), not a blanket swallow — every other error (EACCES,
PERMISSION_DENIED, inflate errors from the later `inflate` call which is outside
the try) propagates unchanged. This is exactly git's "just open the loose file and
handle ENOENT" idiom. It removes the double realpath+containment for objects that
**are** loose, and — critically — it removes the standalone `exists` frame
entirely (the `read`'s own containment is the single probe). **Faithfulness- and
security-neutral**: same bytes, same errors (bar the removed redundant probe),
same containment (the `read` still checks). Ships independent of the ordering
decision.

Note Lever 5a **alone** does NOT fix the packed-repo hot case: for a packed
object the single `read` still ENOENTs (one containment+realpath) before the pack
fallback — it halves the loose-miss cost (one probe instead of two) but a wasted
probe remains. The packed-repo `exists`-share collapse needs the reorder (5b).

**Lever 5b — reorder `resolveObject` pack-first (the big packed-repo win; gated on DC-8).**
Move `registry.lookup(id)` **before** `tryLoose`. For a packed object the
in-memory pack index answers immediately and the loose probe is **never issued** —
eliminating the wasted per-object `exists`/`read` for the entire history walk.
This is the lever that actually drops the `exists` 0.18 share on log/describe/
name-rev. But per the pin it changes the corruption-corner precedence (table
above), so it requires **user sign-off + an ADR** (DC-8). If ratified, apply the
**same reorder** to `objectExistsLocally` (fetch-missing.ts L56) for consistency
with the (already pack-first) `hasObject`, so all three sibling probes agree.

**Lever 5c — trusted-internal-path fast-path in the node adapter (NOT proposed; documented + rejected for this PR).**
Skipping realpath+containment for paths lexically under the canonical gitDir
(library-constructed, never user input) would remove the containment cost itself.
It **carves a hole in the "every FS op is containment-checked" invariant** — a
security-boundary change. Per the coordinator's steer (prefer 5a+5b over 5c) and
because 5a+5b address the hot share without touching the security invariant,
**5c is not proposed** here. If a future profile shows containment *itself*
(not the redundant probe) dominating even after 5a+5b, 5c returns as its own
security-reviewed proposal with a precisely-defined trust boundary. Recorded as
rejected-for-now, not designed.

**Lever 5d — object-existence caching (REJECTED — does not address the hot case).**
Positive-only caching of loose existence (git objects are immutable/append-only,
so "exists loose" is stable; negatives are not cacheable — an object may be
written mid-command). **Rejected:** the hot case is a **packed** repo where
objects are **never loose**, so caching *positive loose existence* yields zero
hits on the walk — it does not touch the 0.18 share. Documented as rejected for
not addressing the packed common case.

#### Faithfulness pin for finding (5)

- **Healthy repo (all existing goldens):** order-invariant — content-addressing
  makes loose and packed bytes identical, so 5a and 5b return byte-identical
  objects and `objectNotFound` on the same missing oids. The existing
  read-object / object-storage / per-command interop suites stay green with
  **unchanged assertions** — that is the pin.
- **Corruption corner:** pinned above; tsgit is already divergent; DC-8 decides
  whether pack-first (silent success, git-like exit 0, no warning) is the accepted
  behaviour and records it in an ADR. No *new* interop golden is added for the
  corrupt-shadow corner unless the ADR chooses to pin the new behaviour explicitly
  (recommended if 5b ships — a `test/integration/*-interop.test.ts` that builds a
  corrupt-loose + valid-pack object and asserts tsgit returns the packed bytes,
  documenting the *intentional* divergence from git's warning).

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
  (the lstat arm) (finding 3).
- `tryLoose` and `looseCompressedBytes` (`object-resolver.ts`) lose their `exists`
  probe, folding to try-`read`-catch-`FILE_NOT_FOUND` (finding 5a). No signature
  change; internal only.
- **If DC-8 ratifies 5b:** `resolveObject` reorders `registry.lookup` before
  `tryLoose`, and `objectExistsLocally` (fetch-missing.ts) reorders to pack-first
  to match the already-pack-first `hasObject`. Internal ordering; no public
  surface. Also updates `object-resolver.ts`'s module docstring ("loose-first-
  then-pack" → "pack-first-then-loose").

## Behaviour preservation — the pin is the existing suite, unchanged

Contract A applies to **Levers A, B, finding (3), and finding (5a)** — all internal
FS-adapter / object-resolver refactors that are **not git-observable on a healthy
repo**: no new real-git interop golden is needed for them; the pin is the existing
behavioural suite staying green with **unchanged assertions**. If any of these
required editing an existing behavioural assertion, it would not be
behaviour-preserving and would be rejected — none do.

**Finding (5b) is the one exception** and is explicitly carved out of the
"behaviour-preserving" umbrella: it changes the object-lookup precedence in the
corrupt-loose+valid-pack corner (pinned in finding (5)'s matrix), is gated on user
sign-off (DC-7) + an ADR (DC-8), and — if it ships — adds **one new** interop
golden for the intentional divergence rather than editing an existing assertion.
Every *healthy-repo* assertion stays unchanged even with 5b.

### Exact guarding test files (must stay green, assertions unchanged)

| File | What it guards on `checkContainment` / `exists` |
|------|--------------------------------------------------|
| `test/unit/adapters/node/node-file-system.test.ts` | Real-FS containment security: symlink-escape → `PERMISSION_DENIED` (L73–91), symlink-swap escape (L99–117), lstat-mode escaped-parent (L125–142), rename-escape via absolute path (L349–369), `rootDir===resolved` short-circuit (L288), FILE_NOT_FOUND vs PERMISSION_DENIED distinction (L249). |
| `test/unit/adapters/node/node-file-system-injected.test.ts` | DI-mocked `fsOps.realpath` call-**count** pins: creation LRU (L58–), non-ENOENT parent → PERMISSION_DENIED (L150–175), missing-parent slow walk-up call count = 4 (L181–212), rmRecursive cache-clear count = 3 (L216–248). These count `realpath` invocations — the direct observable of Lever A *and* finding (3)'s cache behaviour (see mutation plan). |
| `test/integration/checkout-replace-symlink-with-file-interop.test.ts` | The one path-containment-adjacent interop test; exercises symlink→file replacement through the adapter. Stays green unchanged. |
| read-object / object-storage unit + interop suites (`object-resolver`, `read-object` consumers) | Finding (5): every object read (loose-hit, packed-hit, missing→`objectNotFound`) on a **healthy** repo returns byte-identical results under 5a's fold and 5b's reorder. Stays green with unchanged assertions. |

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
| Object bytes returned (healthy repo) identical under any store order | yes | yes | finding (5): content-addressed; read-object/object-storage interop unchanged |
| `objectNotFound` on the same missing oids | yes | yes | finding (5a) catches only `FILE_NOT_FOUND`→undefined; miss still throws `objectNotFound` |
| Loose read errors (non-ENOENT) propagate unchanged | yes | yes | finding (5a) precise catch; every other error rethrown |
| Corrupt-loose + valid-pack shadow behaviour | divergent today (throws) | changes with 5b (see matrix) | DC-8 / ADR decides; optional new interop golden |
| Transient-ENOENT rootDir retries | yes | yes | rejection arm clears sentinel (L384–385), guard re-awaits |
| Concurrent first-call de-dup | yes | yes | shared `canonicalRootPromise` (unchanged) |
| Error object identity / codes / messages | yes | yes | catch arms untouched; Stryker-disable comments intact |

Should any downstream reviewer want a belt-and-braces git cross-check, the
existing per-command interop/e2e suites already exercise these adapters end to
end; no new golden is warranted for the healthy path (see DC-4). The **one**
place a new interop golden may be warranted is the corrupt-shadow corner **iff 5b
ships** — see finding (5)'s faithfulness pin and DC-8.

## Perf pinning plan

Mechanism: `npm run profile <cmd>` (26.3 / PR #224; `tooling/profile.ts` +
`tooling/profile-registry.ts`). Every hot command below is already in the
registry and re-profilable.

**Commands to re-profile** (the baseline's `checkContainment`-heavy set plus the
lstat-heavy `status`), with current self-share and expected direction:

| Command | Kind | `checkContainment` self | `exists` self | `lstat`/`resolveForMode` self | Expected after A+B+3+5 |
|---------|------|-------|-------|-------|-------|
| diff | read | 0.36 | 0.05 | — | `checkContainment`+`check` ↓ |
| name-rev | read | 0.26 | 0.18 | — | `checkContainment`+`check` ↓; **`exists` collapses (5b, packed walk)** |
| blame | read | 0.24 | — | — | `checkContainment`+`check` ↓ |
| describe | read | 0.18 | 0.18 | — | `checkContainment`+`check` ↓; **`exists` collapses (5b)** |
| show | read | 0.13 | 0.01 | — | `checkContainment`+`check` ↓ |
| status | read | 0.12 | — | `lstat` 0.25 / `resolveForMode` 0.14 | `checkContainment`+`check` ↓ **and** `lstat`/`resolveForMode` ↓ (finding 3) |
| merge | write | 0.16 | 0.13 | — | ↓ (command partition) |
| log | read | 0.09 | 0.18 | — | `checkContainment`+`check` ↓; **`exists` collapses (5b)** |

Direction, not magnitude, is the gate (shares are self-relative and host-portable,
ADR-475). Four expected shifts:

1. **Lever A** removes the guaranteed microtask from `checkContainment`, `exists`,
   `symlink` → those self-shares drop, share moves onto genuine work frames.
2. **Lever B** removes the per-call closure alloc → the `check` frame's self-share
   drops (folded into the named predicate / call sites).
3. **Finding (3)** dedupes the lstat-mode parent realpath → `status`'s `lstat` /
   `resolveForMode` self-shares drop as N same-directory realpaths collapse to 1.
4. **Finding (5)** removes the wasted per-object loose probe on packed-repo walks:
   **5a** folds `exists`+`read` (removes the standalone `exists` frame on
   loose-hits and halves loose-miss cost); **5b** (if ratified) reorders pack-first
   so a **packed** object never issues the loose probe at all → the `exists` 0.18
   share on log/describe/name-rev **collapses** (the DAG is fully packed).

**Honest caveat on the `exists` share:** the 0.18 `exists` share collapses **only
if 5b (pack-first reorder) ships** — that is the lever that stops issuing the loose
probe for packed objects. If DC-8 keeps loose-first, only **5a** applies: the
standalone `exists` frame is removed (folded into `read`), but a per-object
loose-`read` that ENOENTs still runs before the pack fallback, so the share
*shrinks* (one probe not two) rather than *collapses*. Lever A additionally removes
`exists`'s microtask component regardless. State clearly in the PR body which of
these landed, tied to the DC-8 outcome.

**Baseline handling — RATIFIED (DC-3 → Option A): regenerate + commit**
`docs/perf/baseline.json` (+ sibling `docs/perf/baseline.md`) in this PR as the
new post-optimisation reference; quote before/after `checkContainment`, `check`,
`lstat`, `resolveForMode` (and the partial `exists`) shares in the PR body. ADR-475
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

**Finding (5a) — the precise catch.** The fold `try { read } catch (err) { if
(err instanceof TsgitError && err.data.code === 'FILE_NOT_FOUND') return
undefined; throw err }` has three mutation-critical pieces:
- **`code === 'FILE_NOT_FOUND'` StringLiteral mutant** (→`""`): would make the
  catch never match → a missing loose object throws instead of returning
  `undefined` → the pack fallback is never reached → `objectNotFound` for a
  *packed* object. Killed by a test: a **packed-only** object (no loose file)
  resolves successfully — proves the ENOENT is caught and the fallthrough reached.
- **`instanceof TsgitError` / `&&`→`||` mutant:** would broaden the catch to
  swallow non-TsgitError or non-FILE_NOT_FOUND errors → a corrupt-permission
  (PERMISSION_DENIED) or other errno would be wrongly turned into `undefined`.
  Killed by a test injecting a `fs.read` that throws PERMISSION_DENIED for the
  loose path → `resolveObject` must **propagate** it, not return undefined / fall
  to pack. (Per contract: no swallowed errors.)
- **`return undefined` → `throw` / drop:** killed by the packed-only resolve test
  above (loose-miss must yield undefined to reach the pack).

Assert against `TsgitError.data.code` directly (try/catch, not `toThrow(Class)`)
per the mutation-resistant-patterns rule.

**Finding (5b) — the reorder (if ratified).** Mutation targets: the two lookups'
*order* is not directly a Stryker operator, but the observable is which store is
consulted. Kill with DI/injected-registry tests: (a) a **packed-only** object
resolves with **zero** loose `exists`/`read` calls (spy on `ctx.fs`) — proves
pack-first short-circuits the loose probe (the perf-behavioural pin, and it kills a
mutant that reverts to loose-first); (b) a **loose-only** object still resolves
(pack-miss → loose fallback); (c) missing-in-both → `objectNotFound`. If 5b ships,
the **corrupt-loose + valid-pack** interop golden (per the ADR) asserts the packed
bytes are returned — the mutation-hard pin for the intentional divergence.

## Non-goals / explicitly deferred

This PR ships baseline findings **(1) checkContainment** (Levers A + B), **(3)
lstat-mode parent-realpath batching**, and **(5) the packed-repo `exists`-share**
(5a always; 5b gated on DC-8). The remaining 26.3 findings stay out of scope and
become follow-up backlog entries — **only these two now**:

- **(2) TREESAME pruning** — deferred (separate walk-pruning concern).
- **(4) tree walk / parse** — deferred.

Also documented but **not** in this PR:

- **Lever 5c (trusted-internal-path fast-path)** — security-boundary change,
  not proposed (5a+5b address the share without it); returns only if a future
  profile shows containment *itself* dominating, as its own security-reviewed
  proposal (see finding (5)).
- **`status` `readdir`-coalesce** for the *working-tree* `exists`/`lstat` batching
  at the command layer — a distinct, larger `status` redesign; deferred (this PR's
  finding (3) covers the safe adapter-level lstat-parent cache; the command-layer
  coalesce is its own item).
- Browser/memory adapters — carry neither the node canonicalisation nor the
  creation-cache template; untouched.

## Decision candidates

DC-1, DC-2, DC-3, DC-4, DC-6 are **ratified** at the decisions gate (recorded for
the audit trail). **DC-5 (cache shape)** was opened by the earlier widening and is
**still open** (recommendation stated). **DC-7 and DC-8 are NEW** — opened by the
finding (5) reorder — and left for the gate + user. ★ marks the ones the user must
sign off (the pinned git order makes the reorder a behaviour-precedence decision,
not a designer call).

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

### DC-4 — ADR need (refactor + finding 3) — **RATIFIED → no refactor ADR; finding (5b) reorder handled separately in DC-8**

No standalone ADR for the Lever A/B/finding-3/finding-5a refactor (all
behaviour-preserving on healthy repos, no git divergence, no public-contract
change). ADR-475 already establishes the baseline-as-moving-reference policy, so
committing an updated baseline is *using* that policy, not new policy — no ADR for
DC-3 either. **The finding (5b) pack-first reorder is the exception** — it changes
an observable precedence and gets its own ADR question in **DC-8** (the earlier
"no ADR" verdict covered only the cache reuse + the healthy-path refactor).

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
reduction in **this** PR rather than defer it. Finding (5) (5a always; 5b per DC-8)
is therefore in scope. (Superseded the prior draft's "defer" recommendation.) The
distinct **`status` `readdir`-coalesce** for the *working-tree* exists/lstat batch
stays a separate follow-up — finding (5) is about the *object-store* loose probe on
history walks, a different code path from the working-tree scan.

### DC-7 ★ — **NEW** — Object-lookup ordering: reorder pack-first (5b) vs keep loose-first + 5a only

Empirically pinned (git 2.55.0, matrix above): **git is loose-first-then-pack**.
So this is a behaviour-precedence choice, for the user:

- **Option A (recommended):** **reorder `resolveObject` (and `objectExistsLocally`)
  pack-first (ship 5b)** alongside 5a. Rationale: (i) it is the only lever that
  actually collapses the 0.18 `exists` share on packed-repo walks (the stated goal
  of the expanded scope); (ii) on **healthy** repos it is byte-identical to git
  (content-addressed) and to `hasObject`, which is *already* pack-first — so this
  makes the three sibling probes consistent; (iii) in the corrupt-loose+valid-pack
  corner tsgit is **already divergent today** (it throws where git warns-and-
  succeeds), so 5b does not break faithful code — it moves an already-broken corner
  to "silently returns the correct packed bytes" (exit-0 like git, minus git's
  warning), which is recorded via DC-8's ADR + an optional interop golden.
- **Option B:** **keep loose-first; ship 5a only.** Matches git's *store
  precedence* exactly (loose-first) and touches nothing observable, but leaves the
  0.18 `exists` share largely intact on packed repos (5a only halves the loose-miss
  probe, does not eliminate it) — i.e. it does **not** deliver the expanded scope's
  goal. Choose this if preserving git's exact loose-first precedence (even in the
  corruption corner) outweighs the perf win.
- **Recommendation: Option A (reorder pack-first, ship 5b)** — the divergence is
  confined to an already-divergent corruption corner, the healthy path is identical,
  it aligns with the existing pack-first `hasObject`, and it is the only option that
  meets the ratified EXPAND goal. Pin the intentional divergence via DC-8's ADR +
  a corrupt-shadow interop golden.

### DC-8 ★ — **NEW** — ADR for the pack-first reorder (only relevant if DC-7 → Option A)

- **Option A (recommended if DC-7=A):** **write a short ADR** recording the
  object-lookup precedence decision: "tsgit resolves objects **pack-first** (unlike
  git's loose-first) for the packed-repo hot path; healthy repos are byte-identical;
  the sole observable difference is the corrupt-loose+valid-pack corner, where tsgit
  returns the valid packed bytes silently (git warns then returns them). This is an
  intentional, ADR-sanctioned divergence, pinned by a corrupt-shadow interop test."
  This is a genuine behaviour-precedence decision with a consequence (the corruption
  corner) — exactly what an ADR is for, and it converts tsgit's *current unrecorded*
  divergence into a *documented, tested* one. Note the prime directive (CLAUDE.md):
  git-faithfulness holds "unless an ADR explicitly diverges and says why" — so 5b
  **requires** this ADR to be legitimate.
- **Option B:** no ADR; rely on the design doc + PR body. Rejected as recommendation
  — a divergence from git's observable behaviour without an ADR violates the prime
  directive's "unless an ADR explicitly diverges" clause.
- **Recommendation: Option A (write the ADR)** if DC-7 ratifies the reorder;
  N/A if DC-7 keeps loose-first (5a alone is behaviour-preserving and needs no ADR).

### Lever 5c note (★ if ever proposed) — trusted-internal-path fast-path

Not proposed in this PR (5a+5b address the share without carving a hole in the
"every FS op is containment-checked" invariant). Recorded so the gate knows it was
considered and consciously set aside. **If** a future profile shows containment
*itself* dominating after 5a+5b, 5c returns as a standalone proposal requiring
**explicit user sign-off + a security-review focus**, with the trust boundary
defined precisely (only paths lexically under the canonical gitDir, library-
constructed, never derived from user input) — the coordinator routes it to the
security dimension. Flagged here, not designed.
