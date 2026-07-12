# Plan — checkContainment + object-lookup hot path: gate the settled-promise await, hoist the per-call closure, cache the lstat-mode parent realpath, cheapen the loose existence probe

> **Shipped outcome:** Parts 1–3 (Lever A, Lever B, Finding 3) + the baseline regen shipped. Parts 4/5f (the object-store loose-probe `exists`→`lstat` switch + the `existsContained` port method) were implemented then **reverted** — see the design doc's "Shipped outcome" note for the inherent-cold-read-cost rationale. This plan is retained as the implementation record.
> Source: design doc `docs/design/checkcontainment-hot-path.md` (commit 652a3813, narrowed by 2d376e5) · NO ADR (DC-4 → all shipping work behaviour-preserving, no git-precedence divergence; DC-8 N/A — reorder rejected).
> The plan is the implementation script AND the knowledge handoff. Part agents start
> with zero context: whatever a part block omits is paid later as agent rediscovery.
> `plan-lint.sh` enforces the schema below — the plan phase cannot close without it.

## Sizing rules

- Every part costs a full agent lifecycle (spin-up, zero-context rebuild, gate) — it
  must earn it. No standalone test-only parts for FEATURE code: coverage/interop/property
  tests fold into the implementation part whose code they exercise. EXCEPTION:
  test-infra-only and docs-only parts (tooling config, test helpers, fixtures,
  harness/property suites, docs/prose) with no `src/` delta ARE standalone.
- Part 5 (baseline regen) is a docs/perf-artifact-only part with no `src/` delta — a
  legitimate standalone under the exception (it regenerates a committed profiling artifact;
  there is no implementation code for it to fold into).

## Orientation (whole-change map — every part shares this)

Four behaviour-preserving perf levers on the node FS adapter's containment gate and the
object-resolver's loose probe. NO SHA/ref/reflog/state-file/output change; git's
**loose-first** object precedence is PRESERVED (DC-7 — the pack-first reorder is REJECTED,
not deferred). All four are internal (private adapter methods, a private-field rename, a
private primitive's internals):

- **Lever A** — gate the settled-promise `await this.getCanonicalRoot()` behind
  `if (this.normalizedCanonicalRoot === undefined)` at all **three** execution sites.
- **Lever B** — hoist the per-call `check` closure in `checkContainment` to a private
  predicate `isContainedInEitherRoot`; DROP `resolveForMode`'s `check` callback param,
  passing the two normalised roots (+ `path`) instead.
- **Finding 3** — cache the lstat-mode parent realpath in the existing LRU (renamed
  `creationParentCache` → `parentRealpathCache`); raise the cache to
  `createLruCache(128 * 1024, 512)` (DC-9 ratified).
- **Finding 5a+5e** — in `object-resolver.ts` `tryLoose` / `looseCompressedBytes`: fold
  `exists`+`read` into one flow catching EXACTLY `FILE_NOT_FOUND` (5a), and switch the
  presence probe from `ctx.fs.exists` to `ctx.fs.lstat` (5e, reusing finding-3's fanout-dir
  cache). `hasObject` / `objectExistsLocally` STAY on `ctx.fs.exists` (session narrowing).

**Public-surface decision (up front — VERIFIED):** ZERO new public surface. Every touched
symbol is internal:
- `checkContainment`, `resolveForMode`, `resolveForCreation`, `realpathForCreation`,
  `getResolvedNormalizedCanonicalRoot`, `getCanonicalRoot`, `isContainedInEitherRoot` (new)
  — all **private** methods of `NodeFileSystem`.
- `parentRealpathCache` (renamed from `creationParentCache`) — a **private readonly** field.
- `exists`, `read`, `lstat` — `FileSystem` port methods, signatures **UNCHANGED** (only their
  internal bodies / gating change).
- `tryLoose` (module-private), `looseCompressedBytes` (exported but internal, relative-import
  only — consumed by readObject) — internals change, **signatures unchanged**.

Consequence: **no surface gates apply** (the surface-gates checklist — barrel / facade /
`repository.test` keys / README count / browser-scenario / doc-coverage — is for NEW public
symbols; none exist here). `NodeFileSystem` IS barrel-exported (`src/adapters/node/index.ts`
L8) but its **public signature is unchanged**, so `reports/api.json` is unaffected;
`check:doc-typedoc` (the prepush api.json gate) will NOT regenerate a different report.
Every part's gate is the fast triad; the full `validate` + `test:integration` + `docs:json`
staleness check runs once at the phase boundary (orchestrator), not per-part. If, contrary
to this analysis, `check:doc-typedoc` reports a diff at prepush, that is a signal a public
signature leaked — STOP and escalate, do not commit a regenerated api.json.

**Part order & why (sequential, one shared worktree — each builds on the last):**
1. **Lever A** — the settled-await guard at all three sites. Smallest, isolated, touches
   `checkContainment` / `exists` / `symlink`. Lands first so Part 2's closure-hoist edits
   land on the already-guarded `checkContainment` body (no re-churn of the same lines).
2. **Lever B** — the closure→predicate hoist + `resolveForMode` signature narrowing. Touches
   `checkContainment` (again) and `resolveForMode`. Sequenced AFTER A so the two edits to
   `checkContainment` compose cleanly (A adds the guard; B replaces the closure). Folding
   A+B into one part was considered and REJECTED: they are independent levers with distinct
   mutation targets and distinct first-class kill tests; separate atomic commits keep the
   review + mutation attribution clean, and the design treats them as separate levers.
3. **Finding 3** — the cache rename (`creationParentCache` → `parentRealpathCache`) + resize
   (`128 * 1024, 512`) + the lstat-arm caching. Depends on B: the lstat arm's containment
   guard is now the Part-2 predicate form (`resolveForMode` no longer takes `check`), so the
   lstat-arm rewrite lands on B's signature. The rename must land cleanly here so Part 4 can
   consume the renamed, resized, lstat-caching field.
4. **Finding 5a+5e** — `tryLoose` / `looseCompressedBytes` probe switch. Depends on Part 3:
   5e's `ctx.fs.lstat` probe RIDES finding-3's fanout-dir cache; without Part 3 the lstat
   probe would re-realpath the fanout dir per object (no win) and the DC-9 resize would be
   absent. Object-resolver + node-adapter tests fold in here.
5. **Baseline regen** — re-run `npm run profile <cmd>` for the hot commands, confirm the
   self-share DROPs vs the committed baseline (direction is the gate, ADR-475), commit the
   regenerated `docs/perf/baseline.{json,md}`. Docs/perf-artifact-only, no `src/` delta.

**Phase-level obligations (NOT per-part gates — do not create parts for these):**
- **Behaviour pin (all parts):** the EXISTING suites stay green with UNCHANGED assertions.
  Named guards: `test/unit/adapters/node/node-file-system.test.ts` (real-FS containment
  security — symlink-escape/swap/lstat-escaped-parent → PERMISSION_DENIED),
  `node-file-system-injected.test.ts` (injected `fsOps.realpath` call-COUNT tests — the
  direct observable for Lever A + finding 3), `object-resolver` / `read-object` unit suites
  + object-storage/read interop (5a+5e byte-identical resolution). If any part needs to EDIT
  an existing behavioural assertion, it is NOT behaviour-preserving → STOP and escalate.
- **Perf pin (Part 5):** re-profile the hot set; `checkContainment` / `check` / `lstat` /
  `resolveForMode` / `exists` self-shares must DROP. Direction, not magnitude (ADR-475);
  `generatedOn` banner is metadata, never compared.
- **Mutation (gates the PR at the mutation phase, not a part gate):** the design's mutation
  plan is authoritative and carried into each part's TDD steps below. The two `Stryker
  disable next-line` equivalent-mutant comments on `checkContainment`'s catch arms
  (node-file-system.ts, the `TsgitError` early-rethrow and the ENOENT short-circuit) carry
  forward **verbatim** — no part touches the catch block; do not renumber/reword/move them.
  The `getResolvedNormalizedCanonicalRoot` `biome-ignore lint/style/noNonNullAssertion` is
  pre-existing and stays.
- **Coverage:** node-adapter + object-resolver code is covered by unit tests; every new
  branch (the guard, the predicate disjuncts, the lstat-cache get/set/miss, the precise
  catch) MUST be exercised by a test in its part — no suppressions.

**Line numbers are point-in-time (verified against current HEAD).** Earlier parts shift
later parts' line numbers within `node-file-system.ts`; navigate by SYMBOL name-path
(Serena `find_symbol`), treat line numbers as orientation only.

## Decision candidates

**None open.** Every load-bearing choice is pre-decided and NOT to be re-opened by the
implementer:
- Scope (DC-1 → widen), approach (DC-2 → Lever A + Lever B), baseline (DC-3 → regenerate +
  commit), no-ADR (DC-4), exists-share in scope (DC-6 → EXPAND), loose-first preserved
  (DC-7 → STAY FAITHFUL, reorder rejected; DC-8 N/A) — all ratified at the decisions gate.
- **DC-5 → Option A** (RATIFIED): reuse the ONE `parentRealpathCache` for creation + lstat
  (renamed from `creationParentCache`); the cached value is mode-independent.
- **DC-9 → Option A** (RATIFIED by session): raise to `createLruCache(128 * 1024, 512)`
  (maxEntries 64→512 > 256 fanout dirs; byte cap 64KiB→128KiB).
- **No new public surface** (ratified by invocation): all changes are private methods / a
  private-field rename / a private primitive's internals; the `FileSystem` port is
  unchanged; `reports/api.json` unaffected; surface-gates checklist does NOT apply.

If the implementer hits a choice the design did not settle, ESCALATE
`{ unit, reason, ≤3 options }` — do not decide it in-part.

---

## Part 1 — Lever A: gate the settled-promise await at all three sites

### Context

**File:** `src/adapters/node/node-file-system.ts` → `class NodeFileSystem`.

The instance already memoises the canonical root: `getCanonicalRoot()` (private, ~L374-389)
sets `this.normalizedCanonicalRoot` in its `.then` success arm and clears BOTH
`canonicalRootPromise` and `normalizedCanonicalRoot` in its `.catch` arm (so a transient
ENOENT retries). `getResolvedNormalizedCanonicalRoot()` (~L370-372) synchronously reads
`this.normalizedCanonicalRoot!` (non-null assertion, pre-existing `biome-ignore`), trusting
that the caller `await`ed `getCanonicalRoot()` first. The field
`private normalizedCanonicalRoot: string | undefined = undefined` (~L338) is the resolved
sentinel this lever pivots on.

**The three execution sites of `await this.getCanonicalRoot();`** (verified — the two
other textual hits are JSDoc, not code):

1. **`checkContainment(path, mode)`** (private async, ~L741-782): the `await
   this.getCanonicalRoot();` sits between `const resolved = this.pathPolicy.resolve(...)`
   and `const normalizedRoot = this.getNormalizedRootDir();`.
2. **`exists = async (path) => {...}`** (public arrow, ~L459-492): `await
   this.getCanonicalRoot();` on ~L461, right after `const resolved = ...`.
3. **`symlink = async (target, path) => {...}`** (public arrow, ~L550-581): inside the
   `if (this.pathPolicy.isAbsolute(target)) {` branch (~L557), `await
   this.getCanonicalRoot();` on ~L567, after `const resolvedTarget = await
   realpathNearestExisting(...)`.

**The change (identical at all three sites):** replace the unconditional
```ts
await this.getCanonicalRoot();
```
with the guarded form
```ts
if (this.normalizedCanonicalRoot === undefined) {
  await this.getCanonicalRoot();
}
```
Nothing else in the three methods changes. `checkContainment` / `exists` / `symlink` stay
`async` (they await other work later), so callers are unchanged. After first resolution the
field is defined, the `if` is false, and the call runs synchronously through to the next FS
op — no microtask suspension.

**Correctness (carry into review, do NOT re-derive):** (a) field defined → skip await,
getter still safe; field undefined → await, `.then` sets the field before the awaited
promise settles → getter safe — the identical post-condition the unconditional await
established. (b) No new first-call race: `getCanonicalRoot` de-dups concurrent first calls
behind the shared `canonicalRootPromise`. (c) Rejection retry preserved: the `.catch` resets
the sentinel to `undefined`, so the next call's guard is true and re-awaits.

**Test file to extend:** `test/unit/adapters/node/node-file-system-injected.test.ts`
(DI-mocked `fsOps`). Existing patterns to mirror (READ them):
- `fakeFsOps(overrides)` (~L38-56) — a fake `FsOperations` where every method rejects ENOENT
  by default; override only what a test exercises. `realpath` is a `vi.fn()`.
- `new NodeFileSystem(rootDir, posixPolicy, fsOps)` — construct with injected fsOps.
- Count observable: `realpathSpy.mock.calls.filter(([arg]) => arg === '<path>').length`
  (see the "two writes into the same parent" test ~L73-96).
- Error observable: try/catch + `expect((caught as TsgitError).data.code).toBe('...')`.
- `const realpathSpy = vi.fn().mockImplementation(async (input) => input)` — identity
  realpath (so any in-root path passes containment) or a per-input map that returns `rootDir`
  for `rootDir` and controls the rest.

### TDD steps

- RED — three first-call kill tests (one per site; each site is an independent mutation
  location, so a `checkContainment` test does NOT kill an `exists` or `symlink` mutant):
  1. *Given a fresh adapter, When the first FS op is a `read` (→`checkContainment`), Then it
     resolves the canonical root before checking containment.* Arrange a fresh
     `NodeFileSystem` with a `realpathSpy` that returns `rootDir` for `rootDir` and identity
     otherwise; seed a readable in-root leaf (`readFile` override returns bytes). Act: `await
     sut.read('<in-root leaf>')`. Assert: the call succeeds (no throw) AND
     `realpathSpy` was called with `rootDir` (`realpathSpy.mock.calls.some(([a]) => a ===
     rootDir)` is true) — proving the first op resolved the canonical root. The `→false`
     (never-await) mutant leaves `normalizedCanonicalRoot` undefined on the first call →
     `getResolvedNormalizedCanonicalRoot()!` reads undefined → the containment verdict is
     wrong / throws → this test fails. KILLED.
  2. *Given a fresh adapter, When the first FS op is `exists`, Then it resolves the canonical
     root before checking containment.* Same shape, `await sut.exists('<in-root leaf>')`
     returns `true`; assert `realpath(rootDir)` was issued and the result is `true`.
  3. *Given a fresh adapter, When the first FS op is `symlink` with an ABSOLUTE in-root
     target, Then it resolves the canonical root before validating the target.* Arrange
     `realpath`/`realpathNearestExisting` inputs so the absolute target resolves inside
     `rootDir`; `await sut.symlink('<abs in-root target>', '<in-root link path>')` succeeds
     and `fsOps.symlink` was called. Assert `realpath(rootDir)` was issued. (The absolute-
     target branch is the only path that reaches `getCanonicalRoot` in `symlink`.)
  Run `npx vitest run test/unit/adapters/node/node-file-system-injected.test.ts` against the
  UNCHANGED source FIRST to confirm these pass today (they pin existing correct behaviour) —
  they are the mutation net, not a red-then-green feature. If writing them exposes a needed
  arrange detail, adjust; they must be green on unchanged source and stay green after.
- GREEN — apply the guarded `if (this.normalizedCanonicalRoot === undefined) { await
  this.getCanonicalRoot(); }` at all three sites (Serena `replace_symbol_body` on
  `checkContainment` / `exists` / `symlink`, or a scoped `Edit` of each `await
  this.getCanonicalRoot();` line — note the three occurrences are identical text, so a
  single `replace_all` Edit of the bare line is the tightest change; verify exactly three
  replacements). Re-run the injected suite + the whole node-adapter suite → green.
- REFACTOR — none needed (three-line guard, no extraction). Run
  `get_diagnostics_for_file` on `node-file-system.ts`; confirm no new diagnostics.

**Mutation notes (into the mutation phase, not this gate):** the `→true` (always-await)
mutant is a **documented EQUIVALENT** mutant (timing-only, same output, same call counts) —
it survives and needs the equivalent-mutant justification, NOT a contrived test. The
`→false` (never-await) and `=== undefined`→`!== undefined` mutants are KILLED by the three
first-call tests above (one per site).

### Pins

- **Behavior:** the whole `node-file-system.test.ts` + `node-file-system-injected.test.ts`
  suites stay green with UNCHANGED assertions (containment/symlink-escape → PERMISSION_DENIED;
  the injected `fsOps.realpath` count tests — 4, 3, once-per-parent — are IDENTICAL before
  and after, Lever A changes microtask scheduling, not realpath call counts).
- **Perf:** deferred to Part 5 (cannot re-profile until all levers land); this part's
  contribution is the `checkContainment` / `exists` / `symlink` microtask removal.

### Gate

`npx vitest run test/unit/adapters/node/node-file-system-injected.test.ts test/unit/adapters/node/node-file-system.test.ts && npm run check:types && ./node_modules/.bin/biome check src/adapters/node/node-file-system.ts test/unit/adapters/node/node-file-system-injected.test.ts`

### Commit

`perf: gate the settled canonical-root await on the node fs containment hot path`

---

## Part 2 — Lever B: hoist the per-call check closure to a private predicate; drop resolveForMode's callback param

### Context

**File:** `src/adapters/node/node-file-system.ts` → `class NodeFileSystem`.

Today `checkContainment` (~L741-782, now carrying Part 1's guard) allocates a fresh `check`
closure per call:
```ts
const check = (abs: string): void => {
  if (
    !pathContainsNormalized(normalizedRoot, abs, this.pathPolicy) &&
    !pathContainsNormalized(normalizedCanonical, abs, this.pathPolicy)
  ) {
    throw permissionDenied(path);
  }
};
```
and passes it to `resolveForMode(path, resolved, mode, check)`; `resolveForMode` (~L719-739)
invokes `check(resolved)` in its `read` arm (~L726) and its `lstat` arm (~L732), and
`checkContainment` calls `check(real)` post-resolution (~L773).

**The change (three coordinated edits — behaviour-preserving by De Morgan):**

1. **Add a private predicate** (no capture — all inputs explicit):
   ```ts
   private isContainedInEitherRoot(abs: string, normRoot: string, normCanon: string): boolean {
     return (
       pathContainsNormalized(normRoot, abs, this.pathPolicy) ||
       pathContainsNormalized(normCanon, abs, this.pathPolicy)
     );
   }
   ```
   This is the exact boolean the closure negated: closure throws on `!A && !B` ⇔
   `!(A || B)` ⇔ predicate returns `false`. Insert it near the other private helpers
   (`get_symbols_overview` to place it; e.g. after `resolveForMode` or beside
   `getResolvedNormalizedCanonicalRoot`).

2. **Narrow `resolveForMode`'s signature** — DROP `check: (abs: string) => void`, add the
   two normalised roots (+ keep `path`, already present):
   ```ts
   private async resolveForMode(
     path: string,
     resolved: string,
     mode: ContainmentMode,
     normRoot: string,
     normCanon: string,
   ): Promise<string> {
   ```
   In the `read` arm replace `check(resolved);` with:
   ```ts
   if (!this.isContainedInEitherRoot(resolved, normRoot, normCanon)) throw permissionDenied(path);
   ```
   Same in the `lstat` arm (the `check(resolved)` before the parent realpath). The `creation`
   arm (`return this.resolveForCreation(path, resolved)`) is unchanged — it never called
   `check`.

3. **Update `checkContainment`** — delete the `const check = ...` closure; call
   `resolveForMode(path, resolved, mode, normalizedRoot, normalizedCanonical)`; replace the
   post-resolution `check(real)` with:
   ```ts
   if (!this.isContainedInEitherRoot(real, normalizedRoot, normalizedCanonical)) {
     throw permissionDenied(path);
   }
   ```
   The `try/catch` block (with the two `Stryker disable` equivalent comments) is UNCHANGED —
   only the closure and the two `check(...)` invocations inside the `try` change.

**Do NOT touch:** `exists` and `symlink`'s absolute-target branch — they have their OWN
inline dual-root checks (not the `check` closure, not `resolveForMode`), and the design
scopes Lever B to `checkContainment` + `resolveForMode` only. Leave their inline
`!pathContainsNormalized(...) && !pathContainsNormalized(...)` guards exactly as they are.

**Behaviour preservation:** throw sites are identical in count and location (each former
`check(x)` → a guarded `permissionDenied(path)` throw on the same `x`); same error, same
`path`; dual-root OR semantics unchanged; no new I/O, no new microtask.

**Test file to extend:** `test/unit/adapters/node/node-file-system-injected.test.ts` for the
per-disjunct isolation tests; the real-FS `node-file-system.test.ts` escape tests already
cover the "outside BOTH roots → throw" case (`||`→`&&` and the both-null path).

### TDD steps

- RED — two isolated per-disjunct tests (the "guard clauses need isolated tests" rule; these
  kill `||`→`&&` and each disjunct-drop). Both use injected `posixPolicy` + `fsOps` so the
  raw-root and canonical-root strings can diverge:
  1. *Given a path contained by the RAW root only (canonical differs), When containment
     runs, Then it PASSES (no throw).* Arrange so `getNormalizedRootDir()` (raw) contains the
     resolved path but the canonical root does not — inject a `realpath(rootDir)` that
     returns a DIFFERENT canonical directory than `rootDir`, and a leaf under the raw
     `rootDir`. Act: `await sut.read('<leaf under raw root>')` (or `lstat`). Assert: succeeds
     (bytes / stat returned). Dropping the RAW disjunct (`pathContainsNormalized(normRoot,
     ...)`→`false`) would make this throw → KILLED.
  2. *Given a path contained by the CANONICAL root only (raw differs), When containment runs,
     Then it PASSES.* Mirror image: the resolved real path lands under the canonical root but
     not under the raw rootDir string. Act + assert succeeds. Dropping the CANONICAL disjunct
     → throw → KILLED. `||`→`&&` would demand containment in BOTH → both tests throw → KILLED
     by either.
  (The existing "outside both roots → PERMISSION_DENIED" tests in `node-file-system.test.ts`
  L73-142 cover the third leg. Run those first on unchanged source to confirm green.)
  Run `npx vitest run` on the injected file against UNCHANGED source — tests 1/2 should pass
  today (they pin existing dual-root behaviour). They are the safety net for the refactor.
- GREEN — apply the three coordinated edits (predicate add; `resolveForMode` signature +
  two arm-guards; `checkContainment` closure delete + two guarded throws). Use Serena
  `insert_after_symbol` for the predicate, `replace_symbol_body` for `resolveForMode` and
  `checkContainment`. Re-run the injected + real-FS node-adapter suites → green.
- REFACTOR — confirm the predicate is <20 lines, no nesting >2, early-return shape; confirm
  no `any`; run `get_diagnostics_for_file`. Confirm the two `Stryker disable` comments are
  byte-identical to before (they must not have moved into the closure region — the closure
  is gone; the comments live on the catch arms, untouched).

**Mutation notes:** `isContainedInEitherRoot`'s `||` (→`&&`) and each
`pathContainsNormalized` disjunct (→`false`) are new mutation targets, killed by the two
isolated per-disjunct tests above + the existing escape tests. This is a coverage
IMPROVEMENT over the inline closure (a named method is mechanically simpler to target).

### Pins

- **Behavior:** De Morgan makes the predicate the exact boolean the closure computed — the
  throw sites are identical in count/location/error. The `node-file-system.test.ts` escape
  suite (symlink/absolute/short-name → PERMISSION_DENIED) + the injected dual-root tests stay
  green with UNCHANGED assertions. The two `Stryker disable` catch-arm comments are unmoved.
- **Perf:** deferred to Part 5; this part's contribution is the per-call `check`-closure
  allocation removal.

### Gate

`npx vitest run test/unit/adapters/node/node-file-system-injected.test.ts test/unit/adapters/node/node-file-system.test.ts && npm run check:types && ./node_modules/.bin/biome check src/adapters/node/node-file-system.ts test/unit/adapters/node/node-file-system-injected.test.ts`

### Commit

`refactor: hoist the containment check closure to a shared predicate`

---

## Part 3 — Finding 3: cache the lstat-mode parent realpath (rename + resize the shared LRU)

### Context

**File:** `src/adapters/node/node-file-system.ts` → `class NodeFileSystem`.

Today the lstat arm of `resolveForMode` (now in Part-2 predicate form) re-realpaths the same
parent directory once per entry — for N files in the same directory, `realpath(dirname)`
runs N times on the identical string. The creation mode already caches this; extend the
identical template to the lstat arm.

**The field** (~L314, with JSDoc ~L300-313):
```ts
private readonly creationParentCache = createLruCache<string>(64 * 1024, 64);
```
`createLruCache<V>(maxSizeBytes, maxEntries)` (verified signature —
`src/domain/storage/lru-cache.ts` L19). Its `get(key)` returns `V | undefined`,
`set(key, value, byteSize)` requires a positive byteSize, `clear()` empties it.

**Changes:**

1. **Rename + resize the field** (DC-5 → reuse ONE cache for creation+lstat; DC-9 → resize):
   ```ts
   private readonly parentRealpathCache = createLruCache<string>(128 * 1024, 512);
   ```
   maxEntries 64→512 (must exceed the 256 object fanout dirs so a full-history walk — via
   Part 4's lstat probe — does not thrash), byte cap 64KiB→128KiB (dual-use headroom:
   working-tree dirs + 256 fanout dirs). Rename EVERY reference (Serena `rename_symbol` on
   the field is cleanest; else `Edit replace_all` of `creationParentCache` →
   `parentRealpathCache`). Current references (verified — all in `node-file-system.ts`):
   - L314 declaration, L543 `rename` `clear()`, L604 `rmRecursive` `clear()`,
     L699 `get` (in `realpathForCreation`), L707 `set` (in `realpathForCreation`).
   Update the field's JSDoc to say it caches parent realpaths for BOTH creation and lstat
   modes (the value is mode-independent).

2. **Add caching to the lstat arm** of `resolveForMode`, mirroring `realpathForCreation`
   (~L692-717) exactly. Current lstat arm (Part-2 form):
   ```ts
   if (mode === 'lstat') {
     if (!this.isContainedInEitherRoot(resolved, normRoot, normCanon)) throw permissionDenied(path);
     const parent = await this.fsOps.realpath(this.pathPolicy.dirname(resolved)); // UNCACHED today
     return this.pathPolicy.join(parent, this.pathPolicy.basename(resolved));
   }
   ```
   Becomes:
   ```ts
   if (mode === 'lstat') {
     if (!this.isContainedInEitherRoot(resolved, normRoot, normCanon)) throw permissionDenied(path);
     const parent = this.pathPolicy.dirname(resolved);
     const cached = this.parentRealpathCache.get(parent);
     const realParent = cached ?? (await this.fsOps.realpath(parent));
     if (cached === undefined) {
       this.parentRealpathCache.set(parent, realParent, parent.length + realParent.length);
     }
     return this.pathPolicy.join(realParent, this.pathPolicy.basename(resolved));
   }
   ```
   The containment guard fires BEFORE the realpath I/O (fail-fast on out-of-tree input),
   exactly as today. `realpath(parent)` may throw ENOENT for a nonexistent parent → it
   propagates to `checkContainment`'s catch → `fileNotFound`, and is NOT cached on throw
   (the `set` only runs on a cache miss AFTER a successful realpath) — identical to
   `realpathForCreation`'s ENOENT-not-cached discipline. Keep the byteSize as
   `parent.length + realParent.length` (matches the creation `set`).

**Invalidation is UNCHANGED** — the two `clear()` sites (`rename` ~L543, `rmRecursive`
~L604) now clear the lstat entries too (same cache). No new invalidation site; NONE removed.
The leaf is NEVER cached (only the parent directory realpath), so the per-access leaf
re-stat is preserved (the caller `compareWorkingTreeDelta` re-lstats the leaf every call).
This inherits `creationParentCache`'s already-shipped, already-mutation-proven TOCTOU
envelope (parent-directory realpath cached under git's directory-stability assumption;
invalidated by the two structural mutators).

**Test file to extend:** `test/unit/adapters/node/node-file-system-injected.test.ts`. Mirror
the existing creation LRU tests (READ them):
- "two writes into the same parent → `realpath(parent)` invoked exactly once" (~L73-96) — the
  hit template.
- "write whose parent does not exist → slow walk-up, nothing cached" (~L181+) — the
  ENOENT-not-cached template.
- The rmRecursive cache-clear count test (search the file for `rmRecursive` + a
  `realpath` call-count assertion) — the invalidation template.
Model observable: `realpathSpy.mock.calls.filter(([arg]) => arg === '<dir>').length`.

### TDD steps

- RED — four lstat-cache injected tests (all assert `fsOps.realpath` call counts):
  1. *Given two lstats of same-directory siblings on a fresh adapter, When the second fires,
     Then `realpath(dirname)` is invoked exactly once.* Arrange `realpathSpy` identity;
     `lstat` override returns a BigInt-field `FileStat` — the adapter calls
     `fsOps.lstat(real, { bigint: true })` then `mapStat(...)`, so reuse the existing
     `fileStat` fake at the top of the DI describe (~L59-72: `ctimeMs`/`mtimeMs`/`ino`/`mode`
     as `BigInt`, `isFile`/`isDirectory`/`isSymbolicLink` predicates). Act: `await
     sut.lstat('/root/sub/a')` then `await sut.lstat('/root/sub/b')`. Assert:
     `realpathSpy.mock.calls.filter(([a]) => a === '/root/sub').length === 1`. Kills a mutant
     dropping the `get` or `set`.
  2. *Given two lstats in DIFFERENT directories, When both fire, Then `realpath` is invoked
     for each distinct dirname (no false sharing).* `lstat('/root/x/a')` + `lstat('/root/y/a')`
     → each dirname realpath'd once (filter counts of `/root/x` and `/root/y` both === 1).
     Kills a wrong-key / over-share mutant.
  3. *Given an lstat populates the cache, When `rmRecursive` (or `rename`) then a same-dir
     lstat fires, Then `realpath(dirname)` is invoked twice total.* `lstat('/root/sub/a')` →
     `rmRecursive('/root/sub')` (clears) → `lstat('/root/sub/b')` → filter count of
     `/root/sub` === 2. Kills a mutant dropping the `clear()` (would stay at 1). Do BOTH a
     `rmRecursive` variant and a `rename` variant (each `clear()` site is its own mutation
     location).
  4. *Given an lstat whose parent is ENOENT, When it fires, Then nothing is cached* (a later
     same-parent lstat re-attempts). Arrange `realpath(dirname)` to throw ENOENT; `await
     sut.lstat(...)` throws FILE_NOT_FOUND; a second same-parent lstat re-issues
     `realpath(dirname)` → count === 2. Kills a mutant that caches on the throw path.
  Run these against the CURRENT (Part-2) source FIRST — tests 1-3 should FAIL (no lstat
  caching yet → realpath called per lstat), confirming RED. Test 4 (ENOENT-not-cached)
  passes today (uncached anyway) but pins the invariant post-change.
- GREEN — rename+resize the field (all 5 references), add the lstat-arm caching block.
  Re-run the injected suite + the whole node-adapter suite (real-FS lstat-escape tests must
  stay green — the containment guard still fires before the realpath). → green.
- REFACTOR — confirm the lstat arm is <20 lines / nesting ≤2; the field JSDoc reflects the
  broadened role; `get_diagnostics_for_file` clean. Confirm the real-FS "in-root directory
  symlink pointing outside root → lstat of child → PERMISSION_DENIED" test still passes (the
  cache does NOT weaken the escaped-parent check — the guard runs on `resolved` before the
  realpath, and an escaped real parent still fails the caller's fresh re-stat / this guard).

**Mutation notes:** the four call-count tests ride the established creation-LRU observable.
The lstat-arm `get`/`set`/miss branch + the `cached === undefined` guard are the new decision
points, all killed above. `createLruCache` internals are already mutation-proven.

### Pins

- **Behavior:** the field rename is mechanical (same object, broader role); invalidation is
  UNCHANGED (the two `clear()` sites now also clear lstat entries). The real-FS lstat-escape
  test ("in-root directory symlink pointing outside root → lstat of child → PERMISSION_DENIED")
  stays green — the containment guard runs on `resolved` BEFORE the (now cached) parent
  realpath, and the leaf is never cached (per-access re-stat preserved). All existing
  assertions unchanged.
- **Perf:** deferred to Part 5; this part's contribution is `status`'s
  `lstat` / `resolveForMode` self-share drop (N same-dir realpaths → 1) and the fanout-dir
  cache Part 4 rides.

### Gate

`npx vitest run test/unit/adapters/node/node-file-system-injected.test.ts test/unit/adapters/node/node-file-system.test.ts && npm run check:types && ./node_modules/.bin/biome check src/adapters/node/node-file-system.ts test/unit/adapters/node/node-file-system-injected.test.ts`

### Commit

`perf: cache the lstat-mode parent realpath on the node fs adapter`

---

## Part 4 — Finding 5a+5e: fold the loose probe into one lstat-based flow (reuse the fanout-dir cache)

### Context

**Files:**
- `src/application/primitives/object-resolver.ts` → `tryLoose` (module-private, ~L147-152)
  and `looseCompressedBytes` (exported internal, ~L159-166). `looseCompressedBytes` has real
  consumers — `stream-blob.ts` (~L43) and `fsck/content-validation.ts` (~L36) — so its
  regression net includes their suites (stream-blob + fsck), which must stay green unchanged.
- (READ-only reference) `src/application/primitives/path-layout.ts` → `looseObjectPath` (~L33):
  `` `${gitDir}/objects/${computeLooseObjectPath(id)}` `` — so `dirname(looseObjectPath)` is
  the fanout dir `${gitDir}/objects/xx` (one of 256), which Part 3's `parentRealpathCache`
  now caches when reached via an lstat-mode containment check.
- (READ-only reference) `src/domain/error.ts` → `fileNotFound(path)` (~L110) constructs
  `new TsgitError({ code: 'FILE_NOT_FOUND', path })`; `TsgitError` has `readonly data`
  (constructor ~L79). `mapErrno`'s ENOENT arm (node-file-system.ts ~L136) returns
  `fileNotFound(path)`, so `ctx.fs.read` / `ctx.fs.lstat` on a missing path throws a
  `TsgitError` with `data.code === 'FILE_NOT_FOUND'` (verified).

Today both functions are check-then-read:
```ts
async function tryLoose(ctx, id) {
  const path = looseObjectPath(commonGitDir(ctx), id);
  if (!(await ctx.fs.exists(path))) return undefined;
  const compressed = await ctx.fs.read(path);
  return ctx.compressor.inflate(compressed);
}
export async function looseCompressedBytes(ctx, id) {
  const path = looseObjectPath(commonGitDir(ctx), id);
  if (!(await ctx.fs.exists(path))) return undefined;
  return ctx.fs.read(path);
}
```

**The change — `tryLoose`** (5a fold + 5e lstat probe):
```ts
async function tryLoose(ctx: Context, id: ObjectId): Promise<Uint8Array | undefined> {
  const path = looseObjectPath(commonGitDir(ctx), id);
  try {
    await ctx.fs.lstat(path); // presence probe: lstat-mode containment caches realpath(fanout dir), no leaf follow
  } catch (err) {
    if (err instanceof TsgitError && err.data.code === 'FILE_NOT_FOUND') return undefined;
    throw err; // every other error (PERMISSION_DENIED, EACCES, EIO) propagates UNCHANGED
  }
  const compressed = await ctx.fs.read(path); // read-mode: follows the leaf, re-checks containment (TOCTOU fresh)
  return ctx.compressor.inflate(compressed); // OUTSIDE the try: corrupt-loose inflate error still propagates, as today
}
```
- The `lstat` return value is unused (presence-only) — bind it to nothing / a discard, or
  keep it minimal; do NOT reintroduce an `exists`. Import `TsgitError` (from
  `../../domain/error.js`) if not already imported in this file — VERIFY the existing imports
  (`operationAborted` is already imported from `../../domain/error.js`, so extend that
  import).
- `inflate` stays OUTSIDE the try so a corrupt-loose object still throws exactly as today.
- The catch is PRECISE: `FILE_NOT_FOUND` only → `undefined` (fall through to pack). Every
  other error rethrown. No `.catch(()=>undefined)`. No swallowed errors.

**The change — `looseCompressedBytes`** (same 5a+5e, no inflate):
```ts
export async function looseCompressedBytes(ctx: Context, id: ObjectId): Promise<Uint8Array | undefined> {
  const path = looseObjectPath(commonGitDir(ctx), id);
  try {
    await ctx.fs.lstat(path);
  } catch (err) {
    if (err instanceof TsgitError && err.data.code === 'FILE_NOT_FOUND') return undefined;
    throw err;
  }
  return ctx.fs.read(path);
}
```

**Precedence UNCHANGED:** `resolveObject` (~L28) still calls `tryLoose` first (loose-first);
only the probe MECHANISM changes. On the packed common case only the `lstat` runs (throws
FILE_NOT_FOUND → `undefined` → pack fallback).

**DO NOT TOUCH** (session narrowing — verified): `hasObject` (`has-object.ts` L16) and
`objectExistsLocally` (`fetch-missing.ts` L56) stay on `ctx.fs.exists`. Switching them is a
behaviour CHANGE in the escaping-symlink corner and they are not hot frames. Strict
behaviour-preservation wins. Do not edit those files.

**Case walk (case (c) is the crux, carry into review):**
- (a) normal loose object: `lstat` succeeds → read+inflate → identical bytes.
- (b) packed object (no loose file): `lstat` ENOENTs → FILE_NOT_FOUND → `undefined` → pack —
  identical to `exists`=false → pack.
- (c) loose path is a symlink escaping root (pathological, git never writes this): `lstat`
  does NOT follow the leaf → `realpath(fanout dir)` is inside `.git` → probe SUCCEEDS →
  `ctx.fs.read(path)` (read-mode, FOLLOWS) resolves outside root → throws PERMISSION_DENIED
  at the READ. Same `TsgitError`, same code, same `path` as today (which threw at the
  `exists` probe) — only the throw POINT moves probe→read. The FILE_NOT_FOUND-only catch
  does NOT swallow it. This is guaranteed by the existing real-FS read-through-escaping-
  symlink → PERMISSION_DENIED test in `node-file-system.test.ts` (~L71-95).

**Test files to extend:**
- `test/unit/application/primitives/object-resolver.test.ts` — the primary. Harness (READ
  it): `buildSeededContext({ objects: [...] })` from `./fixtures.js` seeds loose objects into
  a memory fs; `stubRegistry(ctx, hits)` provides pack hits; `resolveObject(ctx, registry,
  id, verifyHash, maxBytes?)` is the entry. For the escaping-symlink / error-propagation
  cases, override `ctx.fs` with a stub whose `lstat`/`read` throws a crafted `TsgitError` —
  e.g. `const ctx2 = { ...ctx, fs: { ...ctx.fs, lstat: async () => { throw new
  TsgitError({ code: 'PERMISSION_DENIED', path }); } } }`. (`instrumentedContext(base)` in
  `fixtures.js` shows the `{...base, fs: wrappedFs}` override shape.)
- `test/unit/adapters/node/node-file-system-injected.test.ts` — for the fanout-cache-reuse
  count test (the perf-behavioural pin), because the `fsOps.realpath` call-count observable
  lives in the NODE adapter, not the memory fs the object-resolver tests use. See test 6.

### TDD steps

- RED — object-resolver unit tests (fold in here; against current `exists`-based source most
  will FAIL until GREEN):
  1. *Given a packed-only object (no loose copy), When resolveObject runs, Then it resolves
     via the pack.* Seed the object ONLY into the pack (via `stubRegistry` + a synthetic pack;
     mirror an existing packed-resolve test in the file), no loose copy. The memory fs
     `lstat` on the absent loose path throws FILE_NOT_FOUND → probe returns `undefined` →
     pack fallback → correct `GitObject`. This proves the not-found is caught and the
     fallthrough reached (kills the `code === 'FILE_NOT_FOUND'` StringLiteral →`""` mutant
     and the `return undefined`→throw mutant). MUST pass post-change.
  2. *Given a loose object, When resolveObject runs, Then it resolves via loose* (byte-
     identical) — an existing loose-resolve test likely already exists; ensure one covers the
     lstat-probe-then-read path. Precedence-preservation pin.
  3. *Given a missing object (neither loose nor packed), When resolveObject runs, Then it
     throws `objectNotFound`.* `lstat`→FILE_NOT_FOUND→undefined→pack miss→`objectNotFound`.
     Assert via try/catch on `.data` (an existing not-found test may cover this — keep it
     green).
  4. *Given a corrupt loose object (present but non-inflatable), When resolveObject runs, Then
     the inflate error propagates* (not swallowed) — seed a loose path with garbage bytes;
     `lstat` succeeds, `read` succeeds, `inflate` throws → propagates. Proves inflate is
     OUTSIDE the try. (An existing corrupt-loose test may cover this.)
  5. *Given the loose probe throws a NON-FILE_NOT_FOUND error (e.g. PERMISSION_DENIED), When
     resolveObject runs, Then it PROPAGATES* (does not return undefined / fall to pack).
     Override `ctx.fs.lstat` to throw `new TsgitError({ code: 'PERMISSION_DENIED', path })`;
     assert `resolveObject` rejects with `.data.code === 'PERMISSION_DENIED'` via try/catch.
     This is the FIRST-CLASS isolated test for the precise catch (kills the `instanceof
     TsgitError`-drop and `&&`→`||` mutants that would broaden the catch). Also add a variant
     where the subsequent `read` throws PERMISSION_DENIED (case (c) shape) → propagates.
  Run `npx vitest run test/unit/application/primitives/object-resolver.test.ts` — new tests
  1/5 fail against the `exists`-based source (RED), confirming they exercise the change.
- GREEN — rewrite `tryLoose` and `looseCompressedBytes` to the lstat-probe + precise-catch
  form (Serena `replace_symbol_body`); extend the `../../domain/error.js` import with
  `TsgitError`. Re-run the object-resolver suite + `read-object.test.ts` → green.
- RED (test 6, node-adapter cache-reuse — the perf-behavioural pin, folds in here):
  6. *Given a walk resolving N packed objects spread across ≤256 fanout dirs, When each loose
     probe fires an lstat, Then `realpath(fanout dir)` is invoked at most once per distinct
     fanout dir* — NOT once per object. In `node-file-system-injected.test.ts`, construct a
     `NodeFileSystem` and issue `sut.lstat` for many loose-object paths sharing a fanout dir
     (e.g. `/root/objects/ab/<hex1>`, `/root/objects/ab/<hex2>`, ...); assert
     `realpathSpy.mock.calls.filter(([a]) => a === '/root/objects/ab').length === 1`. This
     proves 5e rides Part 3's `parentRealpathCache`. Also assert (DC-9 regression guard): with
     MORE than the OLD cap (64) but within the NEW cap (512) distinct fanout dirs, an already-
     seen dir is NOT re-realpath'd within the window (spread lstats across e.g. 300 fanout
     dirs, re-touch dir #1, assert its realpath count stays 1). This kills a mutant that
     reverts the resize (300 > 64 would evict dir #1 and re-realpath it). NOTE: this test
     exercises the ADAPTER's lstat caching directly (it does not import object-resolver) — it
     is the truthful home for the `fsOps.realpath` observable. Run → it should already PASS on
     Part-3 source for the ≤512 case; if the resize regressed it would fail the 300-dir leg.
- REFACTOR — both functions <20 lines, early returns, no nesting >2; no `any`; confirm
  `hasObject`/`objectExistsLocally` files are UNTOUCHED (git diff shows only
  `object-resolver.ts` + the two test files). `get_diagnostics_for_file` on
  `object-resolver.ts`.

**Mutation notes:** `code === 'FILE_NOT_FOUND'` StringLiteral (killed by test 1),
`instanceof TsgitError` / `&&`→`||` broadening (killed by test 5), `return undefined`→throw
(killed by test 1), the lstat-probe presence semantics + precedence (tests 2/3), the
cache-reuse + DC-9 resize (test 6). Assert against `TsgitError.data.code` via try/catch, not
`toThrow(Class)`.

### Pins

- **Behavior:** every object read on a HEALTHY repo (loose-hit, packed-hit,
  missing→`objectNotFound`, corrupt-loose→throws) is byte-identical under 5a+5e — the probe
  mechanism changes, the resolution decision + returned bytes do not; loose-first precedence
  is preserved. The `object-resolver` / `read-object` unit suites + the object-storage/read
  interop suites + the `looseCompressedBytes` consumers (`stream-blob`, `fsck`) stay green
  with UNCHANGED assertions. The only observable delta is the pathological escaping-symlink
  corner (throw point moves probe→read, same PERMISSION_DENIED code/path), pinned by the new
  defensive tests, not by editing any existing assertion. `hasObject` /
  `objectExistsLocally` are UNTOUCHED (byte-identical to today).
- **Perf:** deferred to Part 5; this part's contribution is the `exists` self-share drop on
  `name-rev` / `describe` / `log` (per-object uncached full-path realpath → ≤256 cached
  fanout-dir realpaths + a cheap lstat).

### Gate

`npx vitest run test/unit/application/primitives/object-resolver.test.ts test/unit/application/primitives/read-object.test.ts test/unit/adapters/node/node-file-system-injected.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/primitives/object-resolver.ts test/unit/application/primitives/object-resolver.test.ts test/unit/adapters/node/node-file-system-injected.test.ts`

(The `looseCompressedBytes` consumer suites — `stream-blob` + `fsck/content-validation` — are
NOT re-inflated per-part; they run in the phase-boundary `npm run test:unit` /
`test:integration`. If a targeted local check is wanted, add their test files to the vitest
run — they must stay green with unchanged assertions.)

### Commit

`perf: cheapen the loose object probe with a cached lstat presence check`

---

## Part 5 — Regenerate and commit the profiling baseline

### Context

Docs/perf-artifact-only part — NO `src/` delta. This is the perf pin.

**Files:** `docs/perf/baseline.json` + `docs/perf/baseline.md` (both exist and are committed;
they are the ADR-475 moving optimisation-license + regression reference the CI perf gate
diffs against).

**Mechanism:** `npm run profile <cmd>` (`tooling/profile.ts` + `tooling/profile-registry.ts`;
the script is `npm run build:profile && node --experimental-strip-types tooling/profile.ts`).
Every hot command below is already in the registry and re-profilable.

**Commands to re-profile** (the baseline's `checkContainment`-heavy set + lstat-heavy
`status`; per the design's perf table): `diff`, `name-rev`, `blame`, `describe`, `show`,
`status`, `merge`, `log`.

**Expected direction (the gate — direction not magnitude, ADR-475):**
- Lever A: `checkContainment` / `exists` / `symlink` self-shares DROP (microtask removed).
- Lever B: the `check` frame's self-share DROPs (closure→named predicate / call sites).
- Finding 3: `status`'s `lstat` / `resolveForMode` self-shares DROP (N same-dir realpaths
  collapse to 1).
- Finding 5a+5e: `exists` self-share DROPs on `name-rev` / `describe` / `log` (the per-object
  uncached full-path realpath becomes ≤256 cached fanout-dir realpaths + a cheap lstat) —
  gated on the DC-9 resize (landed in Part 3).

`generatedOn` banner is metadata — NEVER compared.

### TDD steps

- This part has no unit tests (it regenerates a profiling artifact). The "test" is the
  re-profile confirming the self-share direction:
  1. Run `npm run profile diff name-rev blame describe show status merge log` (or the
     registry's invocation form — check `tooling/profile.ts` for whether it takes a command
     list or is run per-command; follow the committed usage). Profiling is timing-heavy and
     this sandbox reaps long-running bash — run it DETACHED (nohup + disown + poll) if it
     exceeds the foreground budget, per the repo's interop/Stryker detachment convention.
  2. Confirm `checkContainment` / `check` / `lstat` / `resolveForMode` / `exists` self-shares
     moved DOWN vs the CURRENT committed `docs/perf/baseline.json` (compare the relevant
     frames; direction is the gate). If any expected frame did NOT drop, that is a BLOCKER —
     escalate `{ unit: Part 5, reason: <frame> self-share did not drop as designed, options:
     [re-run to rule out noise / investigate the lever's landing / accept-and-document if the
     frame is dominated by an unrelated cost] }`. Do not silently commit a non-improving
     baseline.
  3. Regenerate `docs/perf/baseline.{json,md}` from the profiling output (the same mechanism
     that produced the committed baseline — `tooling/profile.ts` writes them; do not hand-
     edit numbers).
- No REFACTOR.

### Gate

`git --no-ext-diff diff --stat docs/perf/baseline.json docs/perf/baseline.md` (confirm both
regenerated) and a manual read of the before/after `checkContainment` / `check` / `lstat` /
`resolveForMode` / `exists` shares confirming the DROP direction. (No vitest/type/biome gate:
this part changes only the two `docs/perf/` artifacts, no `src/` or test code.)

### Commit

`chore(profile): regenerate the perf baseline after the containment hot-path optimisations`
