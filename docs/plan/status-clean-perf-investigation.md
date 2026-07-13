# Plan — status:clean containment-tax amortisation

> Source: design doc `docs/design/status-clean-perf-investigation.md` · ADRs `485, 486`
> The plan is the implementation script AND the knowledge handoff. Slice agents start
> with zero context: whatever a slice block omits is paid later as agent rediscovery.
> `plan-lint.sh` enforces the schema below — the plan phase cannot close without it.

The diagnosis is complete and recorded in the design (four findings). This plan implements
only the forward-looking work decided in the ADR conversation: **D1 = B** — the provably
verdict-identical containment amortisation (B1 + B2 + B3; B4 and the `policy.resolve` hoist
REJECTED as unfaithful) — confined to `src/adapters/node/node-file-system.ts`; then **D2 = b**
perf-validation + full-baseline refresh, and **D3 = a** docs resolution, as later-phase steps.

## Sizing rules

- Every slice costs a full agent lifecycle (spin-up, zero-context rebuild, gate) — it must
  earn it. No standalone test-only slices: the security-property unit tests, the isolated
  memoisation tests, and the property sibling all fold into the slice whose code they exercise.
- Two code slices: **Slice 1 = B1 + B2** (precompute/dedupe, verdict bit-identical, no
  granularity change) and **Slice 2 = B3** (per-parent verdict cache + its coherence /
  invalidation, a granularity change proven verdict-identical). The cut follows the ADR's own
  B1/B2-vs-B3 boundary: B1/B2 are "materialise-a-constant-once" transforms with no cache
  lifecycle; B3 introduces a new cache with coherence obligations (set-with-realpath, cleared
  on the same events) that must land atomically with its invalidation on `rename`/`rmRecursive`.
  Splitting B1 from B2 would create a slice whose only delta is one deduplicated normalise call
  — too small to earn an agent; they share the same predicate helpers and land together.

## Faithfulness / security bar (binds BOTH code slices)

Path containment is a **tsgit security property, not a git behaviour** — no interop test is
pinned; the proof obligation is a **bit-identical containment verdict for every input on BOTH
`posixPolicy` AND `windowsPolicy`** (`normalizeForCompare` is identity on posix,
`stripWinExtendedPrefix(p).toLowerCase()` on windows). Every code slice is TDD, tests first,
driven through both policies via the file's established DI seam (constructor param 2 =
`PathPolicy`, param 3 = `FsOperations`). `src/adapters/node/**` is in the coverage include
(`vitest.config.ts:72`) → **100% line/branch/function/statement + the mutation budget**; the
security-boundary predicate and the verdict cache must carry **0 surviving mutants**. No
`v8 ignore` / `stryker-disable` / `biome-ignore` without approval; no phase/ADR/backlog refs
in source or test.

## Shared context — the containment hot path (read once, applies to both slices)

**File:** `src/adapters/node/node-file-system.ts` (the ONLY source file changed).

Current signatures / symbol name-paths on the hot path:

- Free fn `pathContainsNormalized(normalizedParent: string, child: string, policy = nativePolicy): boolean`
  (line ~123) — the predicate: `const c = policy.normalizeForCompare(child); if (c === normalizedParent) return true; return c.startsWith(normalizedParent + policy.sep);`.
  Recomputes `normalizedParent + policy.sep` AND `normalizeForCompare(child)` **per call**.
- Free fn `pathContains(parent, child, policy = nativePolicy): boolean` (line ~106) — normalises
  `parent` then delegates. Used by `exists` / `symlink` cold call sites — **keep intact**.
- `NodeFileSystem` fields (line ~318+): `parentRealpathCache = createLruCache<string>(128*1024, 512)`;
  `canonicalRootPromise?: Promise<string>`; `normalizedRootDir?: string`;
  `normalizedCanonicalRoot?: string`.
- `getNormalizedRootDir(): string` (line ~354) — lazy-memoises `normalizeForCompare(rootDir)`.
- `getResolvedNormalizedCanonicalRoot(): string` (line ~374) — returns cached
  `normalizedCanonicalRoot!` (trusts a prior `await getCanonicalRoot()`).
- `getCanonicalRoot(): Promise<string>` (line ~379) — the promise's `.then` sets
  `normalizedCanonicalRoot`; its `.catch` sets **both** `canonicalRootPromise = undefined` AND
  `normalizedCanonicalRoot = undefined` (rejection-clears-cache, for transient-ENOENT retry).
- `isContainedInEitherRoot(abs, normRoot, normCanon): boolean` (private, line ~779) — the
  two-call site: `pathContainsNormalized(normRoot, abs) || pathContainsNormalized(normCanon, abs)`.
  So `abs` is `normalizeForCompare`d **twice** and each root's `+sep` is recomputed per call.
- `resolveForMode(path, resolved, mode, normRoot, normCanon): Promise<string>` (private, line ~747)
  — the **lstat arm**: PRE-check `isContainedInEitherRoot(resolved, …)` (keep per entry),
  then `parent = policy.dirname(resolved)`, `basename = policy.basename(resolved)`,
  `realParent = await cachedParentRealpath(parent)`, `return policy.join(realParent, basename)`.
  The `read` arm does a full-leaf `realpath(resolved)`; the `creation` arm delegates to
  `resolveForCreation`.
- `cachedParentRealpath(parent): Promise<string>` (private, line ~715) — LRU get/set of the
  parent realpath (`this.parentRealpathCache`). **B3 core** extends this.
- `checkContainment(path, mode): Promise<string>` (private, line ~786) — resolves the canonical
  root, reads `normalizedRoot`/`normalizedCanonical`, calls `resolveForMode`, then the **POST-check**
  `isContainedInEitherRoot(real, …)` (unconditional per entry today).
- `rename` (line ~546) and `rmRecursive` (line ~605) both call `this.parentRealpathCache.clear()`.
  `rm` (line ~533) clears **neither** cache (leaf-only removal; parent realpath unchanged) — keep.

**`src/adapters/node/path-policy.ts`** — read-only reference; no change. `posixPolicy` /
`windowsPolicy` exported; `normalizeForCompare` identity (posix) vs
`stripWinExtendedPrefix(p).toLowerCase()` (windows); `sep` `'/'` vs `'\\'`.

**`src/domain/storage/lru-cache.ts`** — `createLruCache<V>(maxBytes, maxEntries)` →
`{ get(key): V|undefined; set(key, value, byteSize); clear(); … }`. Mirror this for a parallel
verdict cache OR fold `{ realParent, contained }` into one value (prefer the folded value — one
`.get`/`.set`/`.clear` keeps realpath + verdict atomically coupled).

**Test file (the DI seam):** `test/unit/adapters/node/node-file-system-injected.test.ts`.
- Imports `NodeFileSystem`, `posixPolicy`, `windowsPolicy`, `TsgitError`, `vi`.
- Helper `fakeFsOps(overrides): FsOperations` (line ~39) — every method rejects ENOENT by
  default; override only what a test exercises. `enoent()` / `eacces()` / `enotdir()` /
  `eloop()` factories at the top. A `fileStat` const (isFile/isDirectory/isSymbolicLink)
  appears in the LRU describe blocks (lines ~59, ~1199) — reuse the shape.
- Patterns to mirror **verbatim** for the new tests:
  - **First-call-vs-hit** (spy the realpath count): `NodeFileSystem — lstat-mode parent-realpath
    LRU (DI)` (line ~1198), `Given two lstats of same-directory siblings … realpath(dirname)
    invoked exactly once` (line ~1213). Use a `realpathSpy = vi.fn(async (i) => i)` and
    `.mock.calls.filter(([arg]) => arg === '/root/sub')`.
  - **rename / rmRecursive invalidation** (twice-total after clear): lines ~1267–1305.
  - **rm does NOT invalidate**: assert the same-parent count stays at 1 across an `rm` between
    two lstats (mirror the invalidation blocks but with `rm` and expect no re-realpath).
  - **normalise-once / cached parent**: `NodeFileSystem — normalised-root cache (DI)` (line
    ~257) wraps `normalizeForCompare` in a `normalizeSpy` on a `{ ...windowsPolicy,
    normalizeForCompare: normalizeSpy }` spread policy and pins the parent-normalise count.
    This is the template for counting predicate work in Slice 1 and the per-parent verdict
    count in Slice 2.
  - **rejection-clears-cache**: `Given the first realpath(rootDir) rejects … retried` (line
    ~344) — the transient-ENOENT template for the canonical `+sep` field.
  - **escape / symlinked-out parent → PERMISSION_DENIED**: `Given in-root path whose realpath
    resolves outside the canonical root` (line ~1100) — realpath returns an outside path;
    assert `(caught as TsgitError).data.code === 'PERMISSION_DENIED'`. For Slice 2 the
    equivalent is a `realpath(parent)` that returns outside root.
- The **property sibling** goes in a NEW file
  `test/unit/adapters/node/node-file-system.properties.test.ts` (no `.properties.test.ts` /
  `arbitraries.ts` exist yet in this dir — create the sibling; keep arbitraries inline unless
  a second property family emerges). Import `fc from 'fast-check'`, and the exported
  `pathContains` / `pathContainsNormalized` as the independent oracle. Mirror the layout of
  `test/unit/adapters/inflate.properties.test.ts` (tiered `numRuns`, `sut` const, GWT titles).
- Existing `pathContains` unit tests live in `node-file-system.test.ts` at line ~1095 (the
  `/repo` vs `/repo-evil` prefix-only case) — the property sibling generalises those.

---

## Part 1 — B1 + B2: precompute `+sep` prefixes, single-normalise the child

### Context

Implements **B1** (memoise the two roots' `+ policy.sep` prefixes as sibling instance fields,
mirroring `normalizedRootDir` / `normalizedCanonicalRoot`) and **B2** (normalise the child
**once** per `isContainedInEitherRoot`, retaining BOTH the `=== root` equality arm and the
`startsWith(root + sep)` prefix arm per root). Verdict is **bit-identical** — only *when* /
*how many times* the constant prefixes and the child-normalise are materialised changes.

Files & symbols (from the shared context above):
- `src/adapters/node/node-file-system.ts`:
  - Add two memoised fields beside `normalizedRootDir` / `normalizedCanonicalRoot`:
    `normalizedRootDirWithSep?: string` and `normalizedCanonicalRootWithSep?: string`
    (names illustrative — a decision candidate below covers the exact shape).
  - **B1 raw-root `+sep`:** populate lazily in `getNormalizedRootDir` (or a sibling getter) —
    the raw root is a lifetime constant, same as `normalizedRootDir`.
  - **B1 canonical `+sep`:** populate in `getCanonicalRoot`'s `.then` right where
    `normalizedCanonicalRoot` is set, and **CLEAR it in the `.catch`** on the SAME line as
    `normalizedCanonicalRoot = undefined` (line ~389) — the rejection-clears-cache invariant
    MUST cover the new field or a transient-ENOENT retry serves a stale prefix.
  - **B2:** rewrite `isContainedInEitherRoot(abs, normRoot, normCanon)` (or thread the two
    `+sep` prefixes in) to: `const c = policy.normalizeForCompare(abs);` then per root
    `c === root || c.startsWith(rootWithSep)`. `normRoot`/`normCanon` are already threaded from
    `checkContainment` → `resolveForMode`; the `+sep` forms are read from the new instance
    fields (preferred — matches the existing memoisation pattern) so `isContainedInEitherRoot`'s
    external signature need not grow with extra params.
  - Keep `pathContains` / `pathContainsNormalized` (the free fns) **intact** — `exists`
    (line ~479, ~493) and `symlink` (line ~587) still call `pathContainsNormalized`
    per-call; those are cold call sites, out of B2's scope. B2 rewrites only the private
    `isContainedInEitherRoot` method's internals.
- The two `+sep` fields must stay coherent with their base fields: whatever sets/clears
  `normalizedRootDir` / `normalizedCanonicalRoot` sets/clears the `+sep` sibling in the same place.

**Public-surface decision:** all touched symbols are **internal**. No new exported symbol —
the two new fields are `private`; `isContainedInEitherRoot` is already `private`;
`pathContains`/`pathContainsNormalized` keep their existing `@internal` exports unchanged. **No
surface gate applies** (no barrel entry, no `Repository` facade, no error-union member, no
`docs/use/commands` page, no `reports/api.json` delta). Confirm no export delta before commit:
`git diff --no-ext-diff src/index.ts src/adapters/node/index.ts` (if present) is empty.

### TDD steps

- **RED**
  - In `node-file-system-injected.test.ts`, add a describe group `NodeFileSystem — containment
    prefix precompute (DI)`:
    - `Given many containment checks, When fired in sequence, Then normalizeForCompare runs at
      most once per constant parent AND the child normalises once per isContainedInEitherRoot`
      — wrap the policy in `{ ...posixPolicy, normalizeForCompare: normalizeSpy }` and a second
      case with `windowsPolicy`; drive N `lstat` calls under one parent; assert the per-parent
      normalise count is bounded (2: root + canonical) and the child-normalise count per
      containment check dropped from 2→1 (count `normalizeSpy` calls whose arg is the child).
      Expected failure: today the child normalises twice per `isContainedInEitherRoot`, so the
      count assertion fails.
    - **Both-arms-retained (B2 mutation guard), isolated per arm:**
      - `Given a child equal to the root (posix), When lstat runs on the root itself, Then it is
        contained (=== arm)` — a path resolving exactly to `rootDir`; must not throw.
      - `Given a child strictly under the root, Then contained (startsWith arm)`.
      - `Given a prefix-only sibling '/root-evil' vs root '/root', Then PERMISSION_DENIED` —
        proves the `+sep` prefix (not bare `startsWith(root)`) is compared; assert `.data.code`.
      - Repeat the three under `windowsPolicy` (root `'C:\\Root'`, sibling `'C:\\Root-evil'`,
        case-fold `'c:\\root\\x'`). Expected failure: the group is new; once B2 lands they pass,
        and each independently kills a mutant that drops one arm.
    - **Canonical `+sep` rejection-clears-cache:** mirror line ~344 —
      `Given the first realpath(rootDir) rejects, When a second containment check runs, Then the
      canonical +sep prefix is recomputed (not stale)`. First realpath throws ENOENT, second
      succeeds returning a DIFFERENT canonical root; assert the second call's verdict uses the
      fresh `+sep` (a child contained only by the retried canonical root is admitted).
  - In the NEW `node-file-system.properties.test.ts`:
    - Import `pathContains`, `pathContainsNormalized`, `fc`. `sut = pathContainsNormalized`.
    - Property (case 2, compositional matcher, both policies via `fc.constantFrom(posixPolicy,
      windowsPolicy)`): the **B1/B2 precomputed-prefix path agrees with a from-scratch
      `pathContains`** for arbitrary `(root, child)` pairs — i.e. a local oracle
      `precomputed(rootWithSep, child) = (norm(child) === norm(root)) || norm(child).startsWith(rootWithSep)`
      ≡ `pathContains(root, child, policy)`. Invariants: child === root → contained; child
      strictly under root → contained; prefix-only sibling → NOT contained. `numRuns: 200`
      (cheap round-trip). Expected failure: the file does not exist yet (import/type error).
  - Run `npx vitest run test/unit/adapters/node/node-file-system-injected.test.ts test/unit/adapters/node/node-file-system.properties.test.ts` → RED.
- **GREEN**
  - Add the two `+sep` memoised fields + their set/clear wiring (B1) and rewrite
    `isContainedInEitherRoot` to normalise the child once and test both arms per root against
    the bare root and the precomputed `+sep` (B2), per the Context. Minimal — no B3 yet.
  - Re-run the two files → GREEN.
- **REFACTOR**
  - Extract a tiny private helper if the dual-arm test reads cleaner
    (`containedByRoot(c, root, rootWithSep)`), keeping it a pure inline of the two arms — no
    behaviour change. Ensure the `+sep` fields' set/clear sit exactly beside their base fields
    (single source of truth). Verify `pathContains` free-fn callers untouched.

### Gate

`npx vitest run test/unit/adapters/node/node-file-system-injected.test.ts test/unit/adapters/node/node-file-system.properties.test.ts && npm run check:types && ./node_modules/.bin/biome check src/adapters/node/node-file-system.ts test/unit/adapters/node/node-file-system-injected.test.ts test/unit/adapters/node/node-file-system.properties.test.ts`

### Commit

`perf(node-fs): precompute containment root prefixes and single-normalise the child`

---

## Part 2 — B3: per-parent lstat-arm post-check verdict cache

### Context

Implements **B3** — the headline win. The `checkContainment` POST-check
`isContainedInEitherRoot(real, …)` runs once per entry, but on the flat/shard scan every entry
under one directory shares a parent, so the verdict is redundant N-ways. Proven verdict-identical
for a single clean leaf (design §B3 / ADR-485): `isContainedInEitherRoot(join(realParent,
basename)) ≡ isContainedInEitherRoot(realParent)` on both policies (pure prefix algebra:
`normalize(a + sep + b)` starts with `normalize(a) + sep`; a single clean `basename` adds no
`\\?\` prefix and lowercasing is per-character). So the post-check reduces to **once per parent**,
memoised beside the realpath in `cachedParentRealpath`. Scoped to the **lstat arm ONLY**; the
`read` arm's full-leaf realpath keeps its per-entry post-check (leaf-is-clean invariant does not
hold there).

Builds on Slice 1's fields (already landed). Files & symbols:
- `src/adapters/node/node-file-system.ts`:
  - `cachedParentRealpath(parent)` (line ~715): change the cached value from `string` to a
    folded `{ realParent: string; contained: boolean }` (preferred — one `.get`/`.set`/`.clear`
    keeps realpath + verdict atomically coupled; the parallel-cache option is a decision
    candidate below). The verdict is computed **once, right after the realpath resolves**, via
    `this.isContainedInEitherRoot(realParent, normRoot, normCanon)`. `cachedParentRealpath`
    therefore needs `normRoot` / `normCanon` threaded in (they are already resolved in
    `checkContainment` and passed to `resolveForMode`). `parentRealpathCache`'s generic type
    becomes `createLruCache<{ realParent: string; contained: boolean }>(…)`; the `byteSize`
    passed to `.set` stays `parent.length + realParent.length` (+ a small const for the boolean
    is optional; keep the existing sizing to avoid churn).
  - **`realpathForCreation` (line ~725)** also calls `cachedParentRealpath` (creation mode) and
    only wants `realParent`. Thread `normRoot`/`normCanon` there too (creation's containment is
    checked later in the creation post-check, but the folded value must be populated
    consistently so a subsequent lstat under the same parent finds a valid verdict — compute
    the verdict for creation callers as well, using the same roots `checkContainment` holds).
    Creation callers read `.realParent` and ignore `.contained`.
  - `resolveForMode` lstat arm (line ~760): after `realParent = (await
    cachedParentRealpath(parent, normRoot, normCanon)).realParent`, `return join(realParent,
    basename)` unchanged. It already holds `normRoot`/`normCanon` (params) to pass down.
  - `checkContainment` (line ~786) POST-check: for the **lstat arm**, consult the cached parent
    verdict instead of recomputing `isContainedInEitherRoot(real, …)` per entry — i.e. the
    lstat arm's `resolveForMode` returns a `real` whose containment is the parent's cached
    verdict; a cached `false` must `throw permissionDenied(path)` exactly as the per-entry
    check did (first lstat AND every subsequent one from cache). For `read` / `creation` arms,
    keep the per-entry `isContainedInEitherRoot(real, …)` POST-check unchanged. Structure so the
    skip applies to lstat only. A clean way: `resolveForMode` returns `{ real, contained }` for
    lstat (verdict from cache) and lets `checkContainment` branch on presence; or
    `checkContainment` keys the mode. Pick one (decision candidate below) — the invariant is:
    **lstat post-check served from the per-parent verdict; read/creation post-check per entry.**
  - The lexical **PRE-check** `isContainedInEitherRoot(resolved, …)` in the lstat arm stays
    **per entry** (guards `resolved` escaping lexically before any I/O) — do not touch it.
  - `rename` (line ~546) and `rmRecursive` (line ~605): the folded value means their existing
    single `parentRealpathCache.clear()` already invalidates the verdict — **no new clear
    needed** (if the parallel-cache option is chosen instead, add a second `.clear()` beside
    each). `rm` (line ~533) still clears neither — the parent realpath and hence its containment
    are unchanged by a leaf removal; keep.

**Cache-coherence obligations (part of the SAFE verdict — the refactor is faithful only if all
hold, assert each):** (a) verdict keyed by the same raw `parent` string as the realpath; (b)
set together with the realpath (never divergent); (c) invalidated on the exact same events
(`rename`/`rmRecursive` clear both; `rm` clears neither); (d) PRE-check stays per entry; (e)
read/creation arms keep their per-entry post-check.

**Public-surface decision:** all **internal**. `cachedParentRealpath`, `resolveForMode`,
`checkContainment` are private; the LRU value-type change is private. No exported symbol added
or changed → **no surface gate applies**; no `reports/api.json` delta. The private-method
signature growth (`normRoot`/`normCanon` on `cachedParentRealpath`) is not a public change.

### TDD steps

- **RED** (extend `node-file-system-injected.test.ts`; add a `windowsPolicy` variant to each):
  - **First-call-vs-hit — one verdict per parent, not per entry.** New describe
    `NodeFileSystem — lstat-mode per-parent containment verdict cache (DI)`:
    `Given two lstats under the same parent, When the second fires, Then isContainedInEitherRoot
    on the parent realpath runs exactly once`. Count via a `normalizeForCompare` spy on the
    parent-realpath arg (the verdict computation normalises `realParent`), OR via a realpath
    spy proving the second lstat issues no re-verdict. Mirror line ~1213 (`realpath(dirname)
    invoked exactly once`). Expected failure: today the post-check runs per entry, so the
    parent verdict is computed twice.
  - **Cached `false` still throws — first AND subsequent.** `Given a parent whose realpath
    escapes the root (symlinked-out parent), When lstat fires twice under it, Then BOTH throw
    PERMISSION_DENIED (second from the cached false verdict)`. `realpath('/root/evil')` returns
    `/outside`; two `lstat('/root/evil/a')` / `('/root/evil/b')`; assert
    `(caught as TsgitError).data.code === 'PERMISSION_DENIED'` on both (assert `.data.code`, not
    the class — mutation resistance). Mirror line ~1100. Expected failure: no verdict cache yet
    (behaviour is per-entry; still throws — so this case ALSO needs the count assertion that the
    second throw came from cache, i.e. `isContainedInEitherRoot`/its normalise ran once — that
    part fails pre-B3).
  - **Invalidation — rename / rmRecursive recompute; rm does not.** Three isolated cases
    (mirror lines ~1267–1305):
    - `Given an lstat populated the verdict, When rename then a same-parent lstat fires, Then
      the verdict is recomputed` (parent verdict count = 2 total). Set the realpath mock to
      return a NEWLY-escaping realpath after rename so a stale-served verdict would give the
      WRONG answer (contained → then not) — proves invalidation is correctness, not just a
      counter.
    - Same for `rmRecursive`.
    - `Given an lstat populated the verdict, When rm (leaf) then a same-parent lstat fires, Then
      the verdict is NOT recomputed` (count stays 1) — proves `rm` correctly leaves both caches.
  - **read/creation arms untouched (B3 must not leak the lstat skip).** `Given a read whose leaf
    realpath escapes the root, When read fires twice, Then EACH throws PERMISSION_DENIED per
    entry (full-leaf realpath, no parent-verdict shortcut)`; and a creation case whose leaf
    symlinks out still refuses per entry. Assert `.data.code`.
  - **Property sibling (extend `node-file-system.properties.test.ts`):** add the **B3
    join-algebra** property (case 2, both policies): for an arbitrary `realParent` (contained or
    not) and an arbitrary **single clean `basename`** (a generated component with no separator,
    no `.`/`..`), a local dual-root oracle satisfies `contained(join(realParent, basename)) ===
    contained(realParent)`, where `contained(x) = pathContains(root, x) || pathContains(canon,
    x)` and `join = realParent + sep + basename`. Generate `basename` from a character set that
    excludes the policy `sep` and the strings `.` / `..`. `numRuns: 100` (invariant property).
    This independently proves the granularity change preserved every verdict. Expected failure:
    property file compiles but the new property is new; it passes only once B3's join-equivalence
    holds — and since the oracle is the pure algebra (not the SUT), a B3 that mis-derived the
    parent key would diverge here.
  - Run `npx vitest run test/unit/adapters/node/node-file-system-injected.test.ts test/unit/adapters/node/node-file-system.properties.test.ts` → RED.
- **GREEN**
  - Fold the LRU value to `{ realParent, contained }`; compute the verdict in
    `cachedParentRealpath` right after the realpath resolves (thread `normRoot`/`normCanon` into
    it and into `realpathForCreation`'s call); serve the lstat-arm post-check from the cached
    verdict in `checkContainment`/`resolveForMode`; keep read/creation per-entry; keep the
    lstat PRE-check per entry. `rename`/`rmRecursive`'s existing `.clear()` covers the folded
    value; `rm` unchanged.
  - Re-run the two files → GREEN.
- **REFACTOR**
  - Tidy the `resolveForMode` / `checkContainment` seam so the "lstat uses parent verdict,
    read/creation use per-entry post-check" split reads in one place (a documented branch, not
    scattered). Confirm the folded value keeps realpath + verdict atomically coupled (one
    `.get`/`.set`/`.clear`). No behaviour change. Update the `parentRealpathCache` JSDoc
    (line ~300) to note it now also carries the per-parent lstat-arm containment verdict and the
    same invalidation rule.

### Gate

`npx vitest run test/unit/adapters/node/node-file-system-injected.test.ts test/unit/adapters/node/node-file-system.properties.test.ts && npm run check:types && ./node_modules/.bin/biome check src/adapters/node/node-file-system.ts test/unit/adapters/node/node-file-system-injected.test.ts test/unit/adapters/node/node-file-system.properties.test.ts`

### Commit

`perf(node-fs): cache the lstat-arm containment verdict per parent directory`

---

## Phase-boundary gate (after Slice 2, before review)

`npm run validate` — full quality gate: 100% coverage on `src/adapters/node/**`, types,
biome, all suites green. Never commit on red. (The mutation net over the predicate + verdict
cache is run in the craft mutation phase, not here — Stryker line-range scoped to the diff per
`.claude/workflow/mutation.md`; the security-boundary comparisons and the verdict cache must
carry 0 surviving mutants.)

## Non-TDD follow-up steps (later craft phases — listed so the plan is complete; NOT code slices)

These are **not** Red/Green slices. They are gated on both code slices being green and land in
the perf-validation and documentation phases per the manifest.

1. **Perf validation — same-host before/after `status` bench (PR-body artifact, D2 = b / ADR-486).**
   On one host, bench `status:clean` at the branch base vs the branch tip
   (`vitest bench … status.bench.ts -t clean`, tsgit `min` floor, ≥2 rounds). Record the
   **host-relative ratio** in the PR body — it is load-independent (both sides pay the same
   contention). Do **NOT** commit these numbers (session-load-biased, non-citable). This is the
   win's evidence, not a gating test (bench files are excluded from coverage).
2. **Full profile baseline refresh (committed, D2 = b / ADR-486).** Regenerate the committed
   `docs/perf/baseline.json` + `docs/perf/baseline.md` via a **full `npm run profile`** (ALL
   commands) so the baseline reflects the optimised `resolveForMode` / `checkContainment`
   self-shares. **NEVER** `npm run profile status` — a status-only run writes a status-ONLY
   `Baseline.commands` that deletes every other command's section (no baseline-drift CI gate
   catches it). Commit the expected self-share shift (noise on the rest), not a whole-file rewrite.
3. **Docs resolution (D3 = a / ADR-485) — documentation phase.** Resolve the follow-up note at
   `docs/understand/performance.md:53`: replace the "tracked as a follow-up" sentence with the
   confirmed finding (no regression; 26.4 already improved status; the gap is the containment
   tax, further amortised here); keep the honest "Why status:clean … are currently slower"
   framing; edit the `status:clean` **number only if a fresh CI-nightly measurement materially
   moves it** (the published `0.67×` is CI-nightly-sourced per ADR-483 — do not overwrite it
   with a local number).
4. **Backlog tick (documentation phase).** Flip `docs/BACKLOG.md` `26.7a` `[ ]` → `[x]` with the
   manifest suffix only (`· ADRs 485–486 · design/status-clean-perf-investigation.md`). No
   phase/ADR/backlog refs in source, test, or the commit subject — the squash commit and PR body
   are the permanent record.

## Decision candidates (planner does NOT decide these — they are implementation-shape choices left to the implementer, each pre-decided by the design where noted)

The load-bearing *design* choices (D1 = B, D2 = b, D3 = a; B4 / `resolve`-hoist rejected) are
already decided by ADRs 485/486. The following are **narrow implementation-shape choices** the
implementer picks in-slice; each has a recommendation and none changes the verdict:

| # | Choice | Alternatives (≤3) | Recommendation |
|---|---|---|---|
| **I1** | B3 cache value shape | (a) Fold `{ realParent, contained }` into the existing `parentRealpathCache` value. (b) A parallel `createLruCache<boolean>` sized/keyed identically. | **(a) folded** — one `.get`/`.set`/`.clear` keeps realpath + verdict atomically coupled and makes `rename`/`rmRecursive`'s existing single `.clear()` invalidate both for free (the design's stated preference). |
| **I2** | How the lstat-arm post-check consults the verdict | (a) `resolveForMode` returns `{ real, contained }` for lstat; `checkContainment` throws on `contained === false`, skips its own `isContainedInEitherRoot` for lstat. (b) `checkContainment` re-reads the parent verdict from the cache by key. | **(a)** — `resolveForMode` already computed the parent verdict via `cachedParentRealpath`; returning it avoids a second cache lookup and keeps the read/creation arms' per-entry post-check on the untouched path. |
| **I3** | B1 `+sep` field naming / where the raw-root `+sep` is populated | (a) Lazy in `getNormalizedRootDir` (sibling field, populated on first use). (b) Eager in the constructor. | **(a) lazy** — mirrors the existing `normalizedRootDir` memoisation exactly (constructor stays side-effect-free; the canonical `+sep` MUST be lazy anyway since it depends on an async realpath). |

## Self-review — convergence log

- **Pass 1 (contradictions):** Confirmed the lint keys on `## Slice` (not `## Part`) — headers
  use `## Slice N`. Confirmed no test-only slice: the property sibling and isolated memoisation
  tests fold into the slice whose code they exercise (Slice 1 gets B1/B2 tests + the from-scratch
  property; Slice 2 gets B3 tests + the join-algebra property). Confirmed the perf bench + baseline
  + docs + backlog are explicitly marked NON-code follow-ups, not slices (per the partitioning
  guidance).
- **Pass 2 (unstated assumptions):** Pinned the exact rejection-clears-cache obligation for the
  canonical `+sep` field (B1) to the SAME `.catch` line as `normalizedCanonicalRoot = undefined`
  (line ~389) — a missed clear is a stale-prefix security bug, so it has its own RED test.
  Pinned that `realpathForCreation` also calls `cachedParentRealpath` and must thread the roots
  (else the folded value is half-populated for a parent first touched by a write then lstat-ed).
  Pinned `rm` clears NEITHER cache as an explicit invariant with its own test (mutation guard —
  a mutant that adds a spurious clear to `rm` is killed).
- **Pass 3 (missing edge behaviour):** Added isolated per-arm B2 tests (`===` arm, `startsWith`
  arm, prefix-only sibling) each independently, per the mutation-resistant-guard rule — one test
  triggering both arms would not prove each. Added the both-policies obligation to every RED
  entry (posix + windows). Added the read/creation-arms-untouched B3 test so the lstat skip
  cannot leak. Confirmed the property oracle is the pure prefix algebra / `pathContains`
  free-fn — an INDEPENDENT oracle, not a re-implementation of the private SUT (no tautology).
  Converged.
