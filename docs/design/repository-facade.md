# Design: Repository Facade

**Status: Implemented (2026-04-26)** — Phase 10 of the [backlog](../BACKLOG.md). Mutation score 93.95% on the new modules; surviving mutants in `repository.ts` are documented equivalents (setImmediate-vs-setTimeout fallback, exactOptionalPropertyTypes spread mutations on optional ctx fields, dispose-state guards covered by adjacent `ctx.signal.aborted` check).

### Review Notes

**Round 3 — applied** (third self-review pass — manual structural sanity check):

- All section anchors and substep numbers verified gap-free (1, 2, 3, 3.1, 3.2, 4.1, 4.2, 4.3, 4.3.1, 4.4, 5.1, 5.2, 5.2.1, 6.1–6.4, 6.2.1, 7.1, 7.2, 8.1, 8.2, 8.2.1, 8.3–8.6, 9–12).
- §10.1.1 file-modification table lists 10 rows (1 combined new-shims row covering 3 files + 7 existing-file modifications + 2 domain-file modifications). Cross-checks with §5.1 and §7.1.
- Engines bump documented in three places consistently: §1, §11, Round 2 review note.
- No remaining `polyfill` references outside Round 1's note (`polyfilling` in §11 — accepted spelling).
- All "12 primitives" references converted to "15".
- All `src/index.ts` deletion claims removed.

---

**Round 2 — applied** (second self-review pass):

- **B1 fixed.** `src/index.ts` is NOT deleted. The user-visible entry remains `src/index.ts`; runtime selection happens via `package.json` `"exports"` conditions resolving to `dist/esm/index.<runtime>.js` artifacts that rollup produces from `src/index.ts` + tiny per-runtime shims. §10.1.1 row corrected.
- **B2 fixed.** All polyfill references removed (Round 1 review note already said "removed" but two stale references survived in §4.4 and §10.1).
- **B3 fixed.** `FileSystem.close?()` row removed from §10.1; replaced with the duck-typed `disposeAdapters(ctx)` helper documented in §8.2.
- **H1 fixed.** Primitive count is **15** everywhere: §1 deliverable bullet, §4.3 inline comment, §8.4 mention.
- **H2 fixed.** §11 explicitly flags the engines bump (`>=18` → `>=20.3.0`) as a breaking change requiring a major-version release per semver. Documented as the SOLE breaking change of Phase 10.
- **H3 fixed.** §7.1 `package.json` exports block now includes `./auto/node`, `./auto/browser`, `./auto/memory` keys with the artifacts each resolves to.
- **M1 fixed.** §8.2.1 state-machine label expanded: `(after await disposeAdapters)`.
- **M2 fixed.** §5.2.1 (new) — worked example showing the user-supplied-FS validator rejects paths outside `cwd`.
- **M3 fixed.** §3 explicitly notes that `repository.ts → commands/internal/network-pipeline` does NOT trigger the `commands-cannot-import-each-other` rule (since `repository.ts` is NOT a command).
- **L2 fixed.** §6.4 — `consoleProgress` runs `sanitize(text)` via `wrapLoggerSanitizer` FIRST (strips control bytes / non-printable), THEN strips ANSI escape sequences (`\x1b[...m`) and HTML special characters. Layered, in that order.
- **L3 fixed.** §7.1 root-entry type re-export expanded — concrete list (no ellipsis) covering 37 command-tier names from `application/commands/index.js` plus 5 facade-tier names (`Repository`, `OpenRepositoryOptions`, `RepositoryConfig`, `ProgressReporter`, `AdapterSet`) = 42 total type exports.

---

**Round 1 — applied** (architecture + security + plan-readiness, three independent reviewers):

- **Engines bumped to `>=20.3`.** `AbortSignal.any` ships natively from Node 20.3 and all current browsers. Polyfill removed from §4.4 / §10.1 — was incorrect under the previous `>=18` engines claim, fixed properly by lifting the floor.
- **Adapter detection via conditional exports, NOT dynamic-import.** §5.1 rewritten: `package.json` `"exports"` use `"node"` / `"browser"` conditions to swap `adapter-detect.ts` at resolve time. Bundlers tree-shake correctly because the chosen file imports only one adapter set. `tsgit/auto/node` and `tsgit/auto/browser` sub-paths exist for explicit-bind usage.
- **User-supplied adapters wrapped with security guards.** §4.1 — when `opts.fs` / `opts.transport` are provided, the facade wraps them in a thin validator that re-applies `cwd` confinement (for FS) and SSRF rules (for transport). Document the trust model: "user-supplied adapters are wrapped, not trusted; bypass requires the explicit `unsafeRawAdapters: true` flag".
- **Deep-freeze on config.** §8.6 — `Object.freeze(opts.config)` is replaced with a recursive `deepFreeze(opts.config)` that walks plain-object values. Function-valued fields (`dnsResolver`) have their slot frozen but the closure scope is the user's responsibility (documented).
- **Prototype-pollution-safe runtime detection.** §5.1 — uses `Object.hasOwn(process.versions, 'node')` (or `Object.prototype.hasOwnProperty.call(...)` fallback) instead of optional-chaining over `process.versions.node`.
- **`INVALID_OPTION` payload sanitized.** §8.3 — the `reason` field runs through `sanitize()` (Phase 9 wrapper) and the embedded option value is truncated to 200 bytes with non-printable bytes hex-escaped. Same treatment for `ADAPTER_UNAVAILABLE.reason`.
- **`ctx` is fully frozen.** §8.1 / §8.6 — `Object.freeze(ctx)` (not just `ctx.config`) at construction. The `Repository.ctx` exposed property is read-only at runtime; replacing `ctx.logger` is a no-op in strict mode and a TypeError in non-strict.
- **Disposable port via duck-typing, not `FileSystem.close?()`.** §10.1 — replaced with adapter-agnostic `disposeAdapters(ctx)` that probes each port for an optional `dispose?()` method. Memory adapter is no-op; Node adapter closes any held file handles; browser OPFS adapter is no-op.
- **`dispose()` state machine.** §8.2.1 (new) — explicit `OPEN → DISPOSING → DISPOSED` transitions, idempotent (second call returns same Promise), commands started before dispose complete-or-abort based on `ctx.signal`.
- **Tier discipline.** §3 — facade imports `withDefaults` from `commands/internal/network-pipeline.ts`, NOT directly from `transport/`. Single source of middleware composition.
- **Primitives count reconciled.** §1 / §4.3 — 15 primitives (12 from Phase 7 + `writeSymbolicRef` + `getRepoRoot` + `mergeBase` from Phase 9 amendment).
- **Sideband progress text sanitized for terminal/HTML.** §6.4 — `consoleProgress` strips ANSI escape sequences AND HTML-special characters from the optional `text` argument before emitting.
- **Listener-leak-safe `AbortSignal.any` use.** §4.4 — every per-call composition uses native `AbortSignal.any` (Node 20.3+ guarantees `{ once }` semantics on the cross-listeners; no polyfill needed).
- **TOCTOU on dispose.** §8.2 — explicit ordering: abort first, microtask tick, then call `disposeAdapters`. In-flight ops have one tick to unwind before resource release.
- **`dnsResolver` trust documented.** §4.2 — documented as user-trusted (function reference); when `allowPrivateNetworks: false`, the facade guards against DNS resolutions that fall in blocked ranges regardless of the resolver's output (defense in depth — `internal/url-validate` already does this).
- **Plan-readiness §4.3.1 binding semantics added.** Worked example showing how `ctx` is closure-captured, signal composition, options pass-through.
- **Plan-readiness §6.2.1 progress timing.** Worked example for `clone:write-objects` showing exact `start` / `update` / `end` sequence.
- **Plan-readiness §10.1.1 file modification list.** Concrete table of every existing file modified (`package.json`, `rollup.config.ts`, `.size-limit.json`, `.dependency-cruiser.cjs`, `knip.json`, `vitest.config.ts`, `src/index.ts`).
- **Plan-readiness §11 widening location.** `TsgitErrorData` widening lives in `src/domain/error.ts`; the 3 new variants join `CommandError` at `src/domain/commands/error.ts`.
- **Format string examples.** §8.3 — three worked invocations per variant.

---

## 1. Overview

Phase 10 adds the **public-facing facade**: a single `openRepository()` entry point that wires a `Context` from the running platform (Node or browser) and exposes every Tier-1 command (16) + Tier-2 primitive (15 — 12 Phase 7 + 3 Phase 9 amendments) as bound methods on a frozen record.

This is the surface that `import { openRepository } from 'tsgit'` resolves to. Everything else in the library is reachable through it. Power users who want raw primitives or commands can still `import { readObject } from 'tsgit/primitives'` or `import { init } from 'tsgit/commands/init'` — Phase 10 does NOT replace those exports, only adds a higher-level shorthand.

**Three deliverables (matching backlog 10.1–10.3):**

1. **`openRepository(opts)` factory.** Constructs `ctx`, freezes it, returns a `Repository` record with all 16 commands + 15 primitives bound to that `ctx`.
2. **Adapter auto-detection.** A small `detectAdapter()` helper picks Node, browser, or memory based on the runtime — resolved via `package.json` conditional exports (NOT dynamic-import). User can override.
3. **Progress reporting integration.** A unified `ProgressReporter` interface threaded through long-running commands (clone, fetch, push, checkout) via `ctx.progress`.

**Scope boundary.** Phase 10 does NOT:
- Add new commands or primitives (Phase 9 / Phase 7 own those).
- Change any existing public surface — `tsgit/commands`, `tsgit/primitives`, `tsgit/operators`, `tsgit/transport` keep their Phase 9 / 8 / 7 / 6 shapes.
- Implement hooks, reflog, or sparse-checkout (Phase 11 / v2).
- Ship the CLI (out of scope; tsgit is library-first).

**Cancellation.** `openRepository(opts)` accepts `opts.signal?: AbortSignal` and propagates it as `ctx.signal` to every bound method. Callers can pass a per-call signal that composes with the global one via `AbortSignal.any` (native, Node ≥ 20.3).

**Engines.** `package.json` `"engines"` is bumped to `"node": ">=20.3.0"` (Node 18 EOL was April 2025; 20.3 is the floor for `AbortSignal.any` native support).

**Binary-size constraint.** A new `.size-limit.json` entry `"Facade"` capped at **3 kB gzipped** (estimated 2 kB — the facade is mostly type re-exports + a small factory). Critically, `tsgit` (the root entry) imports `openRepository` AND nothing else by default — using the facade pulls all 16 commands transitively, but users who only want a subset still tree-shake via `tsgit/commands/<name>`.

---

## 2. Module Structure

```
src/
├── repository.ts            # openRepository(opts): Repository — the facade
├── adapter-detect.ts        # detectAdapter(): { fs, hash, compressor, transport }
├── progress.ts              # ProgressReporter interface + helpers
├── index.ts                 # Re-exports openRepository + key types
└── (existing — unchanged)
```

**Test layout:**

```
test/unit/
├── repository.test.ts
├── adapter-detect.test.ts
├── progress.test.ts
└── facade-integration.test.ts   # init → add → commit → status round-trip via the facade
```

All files kebab-case (ls-lint). All imports use `.js` suffix.

---

## 3. Dependency Boundaries

```
repository.ts → application/commands       (every command)
repository.ts → application/commands/internal/network-pipeline  (withDefaults)
repository.ts → application/primitives      (every primitive)
repository.ts → ports/                      (Context construction)
repository.ts → adapters/                   (only via adapter-detect.ts)
repository.ts → progress.ts                 (progress wiring)
repository.ts MUST NOT → transport/         (forbidden — go through commands/internal/network-pipeline)

adapter-detect.ts → adapters/node           (resolved via package.json exports, Node-only build)
adapter-detect.ts → adapters/browser        (resolved via package.json exports, browser-only build)
adapter-detect.ts → adapters/memory         (always available; selected for `default` condition)

progress.ts → (no internal deps)
```

**New dep-cruiser rule:** `repository-can-only-be-imported-by-index` — `src/repository.ts` may only be imported by `src/index.ts` and the runtime-shim files (`src/index.node.ts`, `src/index.browser.ts`, `src/index.default.ts`). Carve-outs for `test/**` so integration tests can exercise the facade. Prevents internal modules from accidentally creating a cycle by importing the facade.

**Note on `commands-cannot-import-each-other` (Phase 9):** that rule applies to files under `src/application/commands/<name>.ts`. `src/repository.ts` is NOT a command and is not constrained by it — no exception needed; the rule's `from` pattern doesn't match.

**Existing rules survive:** commands cannot import each other; primitives cannot import commands; domain cannot import outward. The facade sits at the very top of the dep graph.

### 3.1 Why bound methods, not free functions

`Repository` is `Readonly<Record<string, BoundMethod>>` — every property is a method that has `ctx` baked in via closure. Users write:

```typescript
const repo = await openRepository({ cwd: '/path/to/repo' });
await repo.add(['src/foo.ts']);
const status = await repo.status();
```

instead of

```typescript
import { add, status } from 'tsgit/commands';
const ctx = makeContext({ cwd: '/path/to/repo' });
await add(ctx, ['src/foo.ts']);
const report = await status(ctx);
```

The free-function form remains available for advanced use (e.g., wrapping `ctx` in custom middleware before calling). The bound form is the convenience layer.

### 3.2 Frozen `Repository` record

The returned object is `Object.freeze`d. Adding/removing properties throws in strict mode. This:
- Makes the facade a stable contract that downstream type checkers can rely on.
- Prevents test code from monkey-patching commands (which would break parallel test isolation).
- Pairs with the §8.6 frozen `ctx` to give users a fully-immutable handle.

---

## 4. Types

### 4.1 `OpenRepositoryOptions`

```typescript
export interface OpenRepositoryOptions {
  /** Working directory. Default: process.cwd() on Node; '/' on browser/memory. */
  readonly cwd?: string;

  /**
   * Adapter overrides. Each is optional; missing entries fall back to detectAdapter().
   *
   * Trust model:
   * - `fs` and `transport`: wrapped by validators (path confinement; SSRF guards) unless `unsafeRawAdapters: true`.
   * - `hash` and `compressor`: pass-through — they take primitive bytes, return primitive bytes; no
   *   external resource access surface to validate. `unsafeRawAdapters` does not affect them.
   */
  readonly fs?: FileSystem;
  readonly hash?: HashService;
  readonly compressor?: Compressor;
  readonly transport?: HttpTransport;

  /**
   * Opt out of adapter validator wrapping for `fs` and `transport`. Default `false`.
   * ONLY for trusted callers (test harnesses, lab adapters where the implementer controls the FS).
   * NEVER set true with adapters whose code you do not control.
   *
   * **Concrete consequence:** with `true`, a raw transport receives `ctx.config.auth` credentials
   * unfiltered — SSRF protection is fully disabled and credentials can be exfiltrated to any host
   * the transport reaches. A raw FS can return arbitrary file content for `readFile`, masquerading
   * as repo objects.
   */
  readonly unsafeRawAdapters?: boolean;

  /** Repository config (auth, parallelism, SSRF allowlist, etc.). FROZEN by openRepository. */
  readonly config?: RepositoryConfig;

  /** Logger for transport diagnostics. Sanitized via wrapLoggerSanitizer at construction. */
  readonly logger?: Logger;

  /** Progress reporter for long-running ops. */
  readonly progress?: ProgressReporter;

  /**
   * Abort signal threaded into every bound method's ctx.signal.
   * Per-call signals (passed via command options) are ANDed with this one
   * via AbortSignal.any (see §4.4).
   */
  readonly signal?: AbortSignal;
}
```

### 4.2 `RepositoryConfig`

```typescript
export interface RepositoryConfig {
  readonly user?: AuthorIdentity;
  readonly auth?: AuthConfig;
  readonly parallelism?: number;            // 1..32, default 8
  readonly upstreamRef?: RefName;
  readonly allowInsecure?: boolean;          // default false
  readonly allowPrivateNetworks?: boolean;   // default false
  readonly maxResponseBytes?: number;        // default 10 GiB
  readonly maxObjectsPerPack?: number;       // default 50_000_000
  readonly detectRenames?: boolean;          // default false
  readonly breakStaleLockMs?: number;        // default undefined
  readonly dnsResolver?: (host: string) => Promise<ReadonlyArray<string>>;
  /** Hard cap on `dnsResolver` return-array length to bound resolver-amplification DoS. Default 64. */
  readonly maxDnsResults?: number;
}
```

Identical to the `ctx.config` shape Phase 9 §4.7 documented. The facade is the official source.

`signal` is NOT part of `RepositoryConfig` — it lives on the top-level `OpenRepositoryOptions` (§4.1) and is exposed as `ctx.signal` (§8.4). `config` describes the repository's auth / network / parallelism contract; the abort signal is a per-handle lifecycle concern.

### 4.3 `Repository`

```typescript
export interface Repository {
  // Tier 1 commands (16) — all bound to this ctx
  readonly init: (opts?: InitOptions) => Promise<InitResult>;
  readonly add: (paths: ReadonlyArray<string>, opts?: AddOptions) => Promise<AddResult>;
  readonly rm: (paths: ReadonlyArray<string>, opts?: RmOptions) => Promise<RmResult>;
  readonly reset: (target: string, opts?: ResetOptions) => Promise<ResetResult>;
  readonly commit: (opts: CommitOptions) => Promise<CommitResult>;
  readonly status: (opts?: StatusOptions) => Promise<StatusReport>;
  readonly log: (opts?: LogOptions) => AsyncIterable<LogEntry>;
  readonly diff: (opts?: DiffOptions) => AsyncIterable<DiffEntry>;
  readonly branch: (action: BranchAction) => Promise<BranchResult>;
  readonly tag: (action: TagAction) => Promise<TagResult>;
  readonly checkout: (target: string, opts?: CheckoutOptions) => Promise<CheckoutResult>;
  readonly clone: (url: string, opts?: CloneOptions) => Promise<CloneResult>;
  readonly fetch: (opts?: FetchOptions) => Promise<FetchResult>;
  readonly push: (opts?: PushOptions) => Promise<PushResult>;
  readonly merge: (opts: MergeOptions) => Promise<MergeResult>;
  readonly revParse: (expression: string) => Promise<ObjectId>;

  // Tier 2 primitives (15) — also bound, exposed under .primitives.* to keep
  // the top-level surface focused on user-facing commands
  readonly primitives: {
    readonly readObject: (id: ObjectId, opts?: ReadObjectOptions) => Promise<GitObject>;
    readonly writeObject: (object: GitObject) => Promise<ObjectId>;
    readonly readBlob: (id: ObjectId) => Promise<Blob>;
    readonly readTree: (id: ObjectId) => Promise<Tree>;
    readonly writeTree: (entries: ReadonlyArray<TreeEntry>) => Promise<ObjectId>;
    readonly resolveRef: (name: string, opts?: ResolveRefOptions) => Promise<ObjectId>;
    readonly updateRef: (name: string, newId: ObjectId, opts?: UpdateRefOptions) => Promise<void>;
    readonly writeSymbolicRef: (name: RefName, target: RefName) => Promise<void>;
    readonly readIndex: () => Promise<GitIndex>;
    readonly createCommit: (input: CreateCommitInput) => Promise<ObjectId>;
    readonly walkCommits: (opts: WalkCommitsOptions) => AsyncIterable<Commit>;
    readonly walkTree: (id: ObjectId, opts?: WalkTreeOptions) => AsyncIterable<WalkTreeEntry>;
    readonly diffTrees: (a: TreeOrId, b: TreeOrId, opts?: DiffTreesOptions) => Promise<TreeDiff>;
    readonly mergeBase: (a: ObjectId, b: ObjectId) => Promise<ObjectId | undefined>;
    readonly getRepoRoot: () => Promise<FilePath>;
  };

  /** The frozen Context. Exposed for advanced use (custom middleware, sub-repos). */
  readonly ctx: Context;

  /**
   * Dispose the repository. Releases held resources (currently: open file handles
   * via FileSystem adapter, in-flight transport connections via abort).
   * Idempotent. After dispose, every bound method throws REPOSITORY_DISPOSED.
   */
  readonly dispose: () => Promise<void>;
}
```

`primitives` is a sub-object (not flat on `Repository`) for two reasons: (a) it keeps the top level focused on the 16 user-facing commands so autocomplete is short, and (b) it makes the "primitives are advanced surface" boundary explicit.

### 4.3.1 Binding semantics

Every method on `Repository` is a closure over `ctx` constructed at facade creation time. Reference pattern:

```typescript
const repo: Repository = Object.freeze({
  add: (paths, opts) => {
    // Atomic gate: ctx.signal.aborted is flipped synchronously by dispose() — no read-vs-dispatch window.
    if (ctx.signal.aborted || state !== 'OPEN') throw repositoryDisposed();
    const callCtx = opts?.signal !== undefined && !ctx.signal.aborted
      ? { ...ctx, signal: AbortSignal.any([ctx.signal, opts.signal]) }
      : ctx;
    return addCommand(callCtx, paths, opts);
  },
  // ... 30 more bindings (15 commands + 15 primitives) ...
});
```

- `ctx` is captured by closure; per-call options never re-validate or re-construct `ctx` itself.
- Per-call `opts.signal`, when present, is composed with `ctx.signal` via `AbortSignal.any`. When absent, `ctx` is passed through unchanged (no allocation).
- The bound method preserves all overloads of the underlying free function (TypeScript inference handles this — no manual overload list).
- Result identity matches the free function's contract — `repo.commit(opts)` resolves to the same `CommitResult` as `commit(ctx, opts)`.

### 4.4 Signal composition

When the user passes `opts.signal` to `openRepository` AND a per-call signal to a command (e.g., `repo.status({ signal: perCallSignal })`), the bound method composes them via `AbortSignal.any([globalSignal, perCallSignal])` — aborts on either. If only one is set, that one is used directly (no allocation overhead).

**Already-aborted short-circuit.** If `ctx.signal.aborted === true` at the moment of composition (e.g., the global signal already fired), the facade returns `ctx.signal` unchanged instead of allocating a new `AbortSignal.any` — saves the allocation and avoids registering listeners on the per-call signal that would never fire usefully.

`AbortSignal.any` is native in Node ≥ 20.3 (the engines floor — see §1) and all current browsers; no polyfill is needed.

---

## 5. Adapter Auto-Detection

### 5.1 Conditional exports (NOT dynamic-import)

The Round-1 review showed dynamic-import does not tree-shake reliably across bundlers. Phase 10 uses Node `package.json` `"exports"` conditional resolution instead.

**`src/adapter-detect.ts`** is the file path users see, but the actual module resolved depends on the runtime:

```json
{
  "exports": {
    ".": {
      "node": {
        "import": { "default": "./dist/esm/index.node.js" },
        "require": { "default": "./dist/cjs/index.node.cjs" }
      },
      "browser": {
        "import": { "default": "./dist/esm/index.browser.js" }
      },
      "default": {
        "import": { "default": "./dist/esm/index.default.js" }
      }
    }
  }
}
```

`index.node.js` re-exports `openRepository` wired to `detectAdapter()` that synchronously returns the Node adapter set. `index.browser.js` does the same for the browser. `index.default.js` falls back to the memory adapter.

Each `index.<runtime>.js` is its own rollup entry; the chosen file imports only its own adapter set. Node-only consumers never ship `adapters/browser/*` and vice versa.

**Test-time override.** `tsgit/auto/memory` is an explicit subpath that always returns the memory adapter — used by the integration test suite and by users who want a deterministic baseline regardless of runtime.

```typescript
export interface AdapterSet {
  readonly fs: FileSystem;
  readonly hash: HashService;
  readonly compressor: Compressor;
  readonly transport: HttpTransport;
}

export const detectAdapter = (): AdapterSet;  // synchronous; resolves via conditional exports
```

**Note on resolution layering.** Conditional exports resolve at bundler/build time and are NOT subject to runtime prototype/global pollution — a malicious DOM XSS that injects `window.process = { versions: { node: '20.3.0' } }` BEFORE module load cannot redirect resolution. The `isNode()` helper below is a manual fallback used only when callers bypass `package.json` exports (e.g., importing `tsgit/auto/memory` then asking which runtime is live for telemetry).

**Prototype-pollution-safe runtime check** (used only for the rare manual call site):

```typescript
const isNode = (): boolean =>
  typeof process !== 'undefined' &&
  Object.hasOwn(process, 'versions') &&
  Object.hasOwn(process.versions, 'node');
```

`Object.hasOwn` (available since Node 16.9 / browsers 2021) avoids the prototype-pollution path where an attacker injects `node` onto `Object.prototype`.

**Failure mode.** If a runtime's adapter cannot be loaded (e.g., a Node-only feature missing in a stripped sandbox), the runtime-specific `index.<runtime>.js` throws `ADAPTER_UNAVAILABLE` with `{ runtime, reason }` at module load time. Callers can fall back by importing `tsgit/auto/memory` instead.

### 5.2 Override granularity

`OpenRepositoryOptions` allows partial overrides:

```typescript
const repo = await openRepository({
  cwd: '/repo',
  transport: customTransport,    // overrides only transport
  // fs, hash, compressor → from detectAdapter
});
```

The factory composes the detected set with the explicit overrides, then constructs `ctx`.

**User-supplied adapter trust model.** `opts.fs` / `opts.transport` / `opts.hash` / `opts.compressor` are wrapped by the facade in a thin validator that re-applies the security guards documented in Phase 9 §4.6 (path confinement) and §4.8 (SSRF). Callers who genuinely need raw adapter pass-through (e.g., test harnesses, custom adapters) opt out via `opts.unsafeRawAdapters: true` — explicit, surveyed-as-dangerous, never the default.

### 5.2.1 Adapter-validator worked example

A user passes a custom `fs` whose `realpath` resolves `/repo/foo` to `/etc/passwd`:

```typescript
const evilFs = {
  ...defaultFs,
  realpath: async (_p: string) => '/etc/passwd',
};
const repo = await openRepository({ cwd: '/repo', fs: evilFs });
await repo.add(['foo']);
// → throws PATHSPEC_OUTSIDE_REPO from internal/working-tree.validatePath, NOT a security breach.
```

The validator re-runs `validatePath` against the realpath returned by the user-supplied FS. Even if `evilFs.realpath` lies, the chain `validatePath(realpath('/repo/foo')) → /etc/passwd → not under /repo → reject` fires.

**Threat model — what the wrapper protects.** The validator only re-applies guards on the **path-naming surface** (`realpath`, `stat`, `readFile`, `writeFile`, `readDir`, `lstat`). A malicious FS can still return adversarial **content** for `readFile` (e.g., return a different commit object than asked). Wrapping cannot defend against content-level lies — that trust is delegated to the caller's choice of FS implementation. For untrusted environments, use the runtime-provided `node` / `browser` / `memory` adapters and treat user-supplied `fs` overrides as a privileged capability.

With `opts.unsafeRawAdapters: true`, the wrapping is skipped and `evilFs` is trusted — documented as dangerous and ONLY appropriate for test fixtures or lab adapters where the caller controls the FS implementation.

---

## 6. Progress Reporting

### 6.1 `ProgressReporter` interface

```typescript
export interface ProgressReporter {
  /**
   * Called when a long-running command starts a reportable sub-task.
   * `op` is a stable string identifier (e.g., 'clone:discover', 'clone:write-objects',
   * 'fetch:negotiate', 'push:enumerate-objects', 'checkout:materialize').
   */
  readonly start: (op: string, total?: number) => void;

  /**
   * Called periodically during the sub-task. `current` is the count of items
   * processed; `total` may be undefined when not known in advance (e.g., during
   * sideband progress text).
   */
  readonly update: (op: string, current: number, total?: number, text?: string) => void;

  /** Called when the sub-task completes (success OR failure). */
  readonly end: (op: string) => void;
}
```

The reporter is **synchronous, fire-and-forget** (matches the Phase 8 logger contract). A throwing reporter is wrapped in `try/catch` at every call site by the facade; throws are swallowed.

**`op` sanitization.** The `op` argument is documented as "stable string identifier" supplied by the facade itself from a fixed internal table — NEVER from user or sideband data. Built-in reporters (`consoleProgress`) defensively pass `op` through the same `sanitize()` chain as `text`, so a programming bug that wires a sideband-derived string into `op` cannot inject control characters into the formatted line.

### 6.2 Operations that report progress

| Operation | start total | update granularity |
|---|---|---|
| `clone:discover` | undefined | not used |
| `clone:write-objects` | object count from pack header | every 100 objects |
| `clone:checkout-files` | file count | every 100 files |
| `fetch:write-objects` | object count | every 100 objects |
| `fetch:negotiate` | undefined | sideband progress text |
| `push:enumerate-objects` | undefined | every 100 objects walked |
| `push:upload` | total bytes | every 65536 bytes (64 KiB) |
| `checkout:materialize` | file count | every 100 files |
| `merge:write-files` | file count | every 100 files |
| `status:scan` | undefined | every 100 lstat calls |

Other commands (`init`, `add`, `commit`, `log`, etc.) do not report progress — they're either fast or already async-iterable.

### 6.2.1 Worked example: `clone:write-objects` with 250 objects

```
1. start('clone:write-objects', 250)             // fired before object 1
2. update('clone:write-objects', 100, 250)        // after object 100
3. update('clone:write-objects', 200, 250)        // after object 200
4. update('clone:write-objects', 250, 250)        // after object 250 (final update)
5. end('clone:write-objects')                     // after the last update, in `finally`
```

Invariants:
- `start` fires BEFORE the first item is processed (count semantics: 0 → start → some processing → first update at the chosen granularity).
- `update` granularity rule: emit when `Math.floor(current / G) > Math.floor(previous / G)` **OR** `current === total` (the second clause guarantees the final update fires when `total` is not a multiple of `G`).
- The final `update` always fires at exactly `total` (last few objects don't disappear when total isn't a multiple of 100).
- `end` fires AFTER the last `update` (success path) OR AFTER a `try/catch` swallowed throw (failure path) — never before.

### 6.3 No progress on errors

The reporter's `end(op)` is called on both success and failure paths (via `try/finally`). This guarantees the consumer can always pair a `start` with an `end` and never see an orphan.

### 6.4 Built-in reporters

`progress.ts` exports two convenience reporters:

```typescript
export const noopProgress: ProgressReporter;
  // All methods are no-ops. Default when opts.progress is undefined.

export const consoleProgress = (sink: (line: string) => void): ProgressReporter;
  // Calls sink('<op>: <current>/<total> <text?>') on each update; sink('<op>: done') on end.
  // Sanitizes `text` in three layers: (1) ANSI escape strip (\x1b[...m) — must run on raw ESC bytes
  // BEFORE sanitize hex-escapes them; (2) sanitize (Phase 9 §4.7) — hex-escapes any remaining bytes
  // outside 0x20-0x7E except \n \t; (3) HTML special-character escape (<, >, &, ", '). Layer order is
  // fixed: ANSI strip → sanitize → HTML — once sanitize replaces the ESC byte with the literal '\xNN'
  // text, the ANSI regex can no longer match the sequence as a unit.
```

Users can implement their own (TUI bar, OpenTelemetry span, etc.).

---

## 7. Public Surface

### 7.1 `tsgit` root entry

```typescript
// src/index.ts
export { openRepository } from './repository.js';
export type {
  Repository,
  OpenRepositoryOptions,
  RepositoryConfig,
} from './repository.js';
export type { ProgressReporter } from './progress.js';
export { noopProgress, consoleProgress } from './progress.js';
export { detectAdapter } from './adapter-detect.js';
export type { AdapterSet } from './adapter-detect.js';

// Re-export every public type referenced by Repository methods so users
// don't need a second import to get InitOptions, AddResult, etc.
// Concrete enumeration (no ellipsis) — must match Step 5.6 of the plan.
export type {
  AddOptions, AddResult,
  BranchAction, BranchInfo, BranchResult,
  CheckoutOptions, CheckoutResult,
  CloneOptions, CloneResult,
  CommitOptions, CommitResult,
  CommandError,
  DiffEntry, DiffHunk, DiffMode, DiffOptions,
  FetchOptions, FetchResult,
  FileStatus,
  InitOptions, InitResult,
  LogEntry, LogOptions,
  MergeOptions, MergeResult,
  PushOptions, PushResult,
  ResetMode, ResetOptions, ResetResult,
  RmOptions, RmResult,
  StatusOptions, StatusReport,
  TagAction, TagInfo, TagResult,
} from './application/commands/index.js';
```

`package.json`:

```json
"exports": {
  ".": {
    "node":    { "import": "./dist/esm/index.node.js",    "require": "./dist/cjs/index.node.cjs" },
    "browser": { "import": "./dist/esm/index.browser.js" },
    "default": { "import": "./dist/esm/index.default.js" }
  },
  "./auto/node":    { "import": "./dist/esm/index.node.js" },
  "./auto/browser": { "import": "./dist/esm/index.browser.js" },
  "./auto/memory":  { "import": "./dist/esm/index.default.js" },
  "./commands": { /* unchanged from Phase 9 */ },
  "./commands/*": { /* unchanged */ },
  "./primitives": { /* unchanged */ },
  "./operators": { /* unchanged */ },
  "./transport": { /* unchanged */ },
  "./adapters/node": { /* unchanged */ },
  "./adapters/browser": { /* unchanged */ },
  "./adapters/memory": { /* unchanged */ }
}
```

`./auto/memory` is the explicit "use the memory adapter regardless of runtime" subpath — used by tests and by users who want a deterministic baseline.

### 7.2 Backward compatibility

Phase 10 is purely additive. No existing exports change shape. The Phase 9 `tsgit/commands/<name>` entries remain the tree-shake-friendly choice for users who care about bundle size.

---

## 8. Cross-cutting Concerns

### 8.1 Construction validation

`openRepository(opts)` performs eager validation BEFORE returning the `Repository`:

- `opts.cwd`, when set, MUST be **absolute by adapter convention**. Throws `INVALID_OPTION` with `{ option: 'cwd', reason }`. Per-adapter rules:
  - **Node FS:** `path.isAbsolute(cwd)` (POSIX `'/'`-rooted on macOS/Linux; drive-letter or UNC on Windows).
  - **Browser OPFS / memory FS:** any string starting with `'/'`.
  - The default (`defaultCwd()`) is `process.cwd()` on Node and `'/'` on browser/memory — both pass their respective check trivially.
- `opts.config.parallelism`, when set, MUST be in `[1, 32]`. Throws `INVALID_OPTION`.
- `opts.config.maxResponseBytes`, when set, MUST be ≥ 1024. Throws `INVALID_OPTION`.

`INVALID_OPTION` is a new variant (added to `CommandError` family per §10.1) so the facade does not introduce a new tier-private error union.

### 8.2 Disposal and resource lifecycle

`repo.dispose()` is the explicit cleanup hook. Implementation calls `disposeAdapters(ctx)` which probes each port for an optional `dispose?()` method (duck-typing — no port extension, just an opt-in convention).

`Repository` does NOT implement `Symbol.asyncDispose` in v1 — it's a TC39 stage-3 feature with patchy Node coverage. Phase 11 / v2 may add it.

### 8.2.1 `dispose()` state machine

```
OPEN ──repo.dispose()──▶ DISPOSING ──(after await disposeAdapters)──▶ DISPOSED
   │                          │
   └─repo.X()→ resolve         └─repo.X()→ throws REPOSITORY_DISPOSED
```

- **OPEN** (initial). All bound methods route to commands as normal.
- **DISPOSING** (after `dispose()` is called, before it resolves). The facade flips `ctx.signal.aborted` SYNCHRONOUSLY via `controller.abort()` (atomic, no async gap), then yields to a macrotask boundary to let queued I/O callbacks observe the abort, then calls `disposeAdapters(ctx)`. New calls during this window throw `REPOSITORY_DISPOSED` immediately. (User-visible state collapses to a single `REPOSITORY_DISPOSED` code; DISPOSING is an internal, transient label not surfaced through the error code.)
- **DISPOSED** (after `dispose()` resolves). All bound methods throw `REPOSITORY_DISPOSED`. The state is terminal.

**Atomic dispose check.** Bound methods gate dispatch on `ctx.signal.aborted` (set synchronously by `controller.abort()` inside `dispose()`) — there is NO read-then-dispatch window where a separate state variable could disagree with the signal. The `state` field is consulted only as a secondary check that distinguishes `REPOSITORY_DISPOSED` (post-dispose) from `OPERATION_ABORTED` (signal-only abort).

**Macrotask boundary.** `dispose()` uses `setImmediate` (Node) / `setTimeout(0)` (browser) — NOT `await Promise.resolve()` — to yield before tearing down adapters. A microtask drain does not let queued I/O callbacks (e.g., a `readFile` that already returned to the syscall layer) observe the abort; only an event-loop iteration does.

**Idempotency.** A second `dispose()` call returns the SAME Promise as the first (single in-flight teardown). After resolution, further `dispose()` calls return `Promise.resolve()` immediately (no-op).

**In-flight commands.** Commands started before `dispose()` see `ctx.signal.aborted === true` after the abort step. Per CLAUDE.md `try/finally` discipline (Phase 9 §4.10), they release locks and reject with `OPERATION_ABORTED` — `dispose()` does NOT await individual command completion (the macrotask tick is a fairness gesture; long-running ops can outlive `dispose()` if they don't honor the signal, which is a bug in those commands, not the facade).

### 8.3 Error model

Phase 10 adds 3 new variants (joining `CommandError` per §8.1):

```typescript
| { readonly code: 'INVALID_OPTION'; readonly option: string; readonly reason: string }
| { readonly code: 'REPOSITORY_DISPOSED' }
| { readonly code: 'ADAPTER_UNAVAILABLE'; readonly runtime: 'node' | 'browser' | 'memory'; readonly reason: string }
```

3 variants total. Format strings for `extractDetail`:

| Code | Detail |
|---|---|
| `INVALID_OPTION` | `invalid option: ${option} — ${sanitize(reason)}` |
| `REPOSITORY_DISPOSED` | `repository has been disposed; create a new one with openRepository()` |
| `ADAPTER_UNAVAILABLE` | `adapter unavailable for runtime ${runtime}: ${sanitize(reason)}` |

`INVALID_OPTION.option` is ALWAYS a fixed string literal from the internal validation switch (`'cwd'`, `'parallelism'`, `'maxResponseBytes'`, `'breakStaleLockMs'`, `'maxObjectsPerPack'`, `'dnsResolver'`, `'maxDnsResults'`) — never a user-derived value. The field name is therefore safe to embed unsanitized.

### 8.4 Cancellation

`ctx.signal` is the single composed signal threaded through all 16 commands and 15 primitives. A user-supplied `opts.signal` is preserved as the source; per-call signals (e.g., on `repo.status({ signal: ... })`) are composed via `AbortSignal.any`.

`ctx.signal` MUST exist (never undefined) so downstream code can write `ctx.signal.aborted` without an existence check. When the user provides no signal, the facade creates an internal `AbortController` and exposes its `signal`.

### 8.5 Logger sanitization

`opts.logger`, when provided, is wrapped in `wrapLoggerSanitizer` (Phase 9 §4.7) once at construction. The wrapped logger is what `ctx.logger` exposes — every command and middleware sees sanitized strings without re-wrapping.

### 8.6 Frozen config

`Object.freeze(opts.config)` runs at construction (defensive — also the Phase 10 facade's primary contract). Mutating `opts.config` after `openRepository` returns is undefined behavior; the frozen object throws in strict mode.

**Recursive coverage.** `deepFreeze` walks every plain-object value reachable from `config` — including `config.auth` (credential bag), nested option groups, and any future additions. Function-valued slots (`dnsResolver`, future `auth.getToken()` style closures) are frozen by SLOT only — the facade cannot freeze closure scope; mutations inside the closure remain the caller's responsibility. This carve-out is documented and identical to the `dnsResolver` reference treatment.

---

## 9. Testing Strategy

### 9.1 Layers

| Layer | What | Tools |
|---|---|---|
| Unit | `repository.ts` factory, `adapter-detect`, `progress.ts` reporters | vitest |
| Integration | Full round-trip: init → add → commit → status → log via `repo.*` | vitest with memory adapter |
| Cross-runtime | Same integration test running on Node + browser via Playwright | Phase 11 |

### 9.2 Mutation testing

| Module | Score |
|---|---|
| `adapter-detect.ts` | ≥ 95% (small surface; runtime branch coverage) |
| `progress.ts` | ≥ 95% (sanitization boundary) |
| `repository.ts` | ≥ 90% (the factory's binding logic) |

### 9.3 Test conventions

Inherited from CLAUDE.md: Given/When/Then titles, AAA bodies, `sut`. Error assertions use `try/catch + .data.code + payload`. Boundary triples for caps inherited from Phase 9 (`parallelism`, `maxResponseBytes`).

---

## 10. Phase Ownership

### 10.1 New artifacts and rules

| Artifact | Type | Reason |
|---|---|---|
| `INVALID_OPTION`, `REPOSITORY_DISPOSED`, `ADAPTER_UNAVAILABLE` | `CommandError` extensions | Facade-specific failures |
| `Facade` size-limit entry (3 kB gzip) | `.size-limit.json` | Surface budget |
| `repository-can-only-be-imported-by-index` | dep-cruiser rule | Prevent cycle |

### 10.1.1 Existing-file modification list

| File | Change | Reason |
|---|---|---|
| `package.json` | `"engines"` bumped to `">=20.3.0"`; `"exports"` adds runtime-conditional resolution for the root entry; new sub-paths `./auto/node`, `./auto/browser`, `./auto/memory` | §1, §5.1 |
| `rollup.config.ts` | Add 3 entries: `index.node`, `index.browser`, `index.default`; add 1 entry for `repository.ts` (the shared core) | §5.1 |
| `.size-limit.json` | Add `Facade` entry capped at 3 kB gzip pointing at `dist/esm/index.node.js` (worst-case build); per-runtime entries optional | §1 |
| `.dependency-cruiser.cjs` | Add `repository-can-only-be-imported-by-index` rule (with carve-out for `src/index.*.ts` runtime entries and `test/**`) | §3 |
| `knip.json` | Add `src/index.node.ts`, `src/index.browser.ts`, `src/index.default.ts`, `src/repository.ts` to `entry` array | §5.1 |
| `vitest.config.ts` | Add `setupFiles` alias for the runtime-detection mocks (used by `test/unit/adapter-detect.test.ts`) | §9.3 |
| `src/index.ts` | KEPT — exports `openRepository`, types, helpers. Resolution to runtime-specific code happens via `package.json` exports conditions (not by editing this file). The shim files (`src/index.node.ts` etc.) import from `src/index.ts` and pre-bind `detectAdapter` to the runtime-correct adapter set. | §5.1, §11 |
| `src/index.node.ts`, `src/index.browser.ts`, `src/index.default.ts` (new) | Runtime shims; each imports `openRepository` from `src/index.ts` and pre-binds the adapter set. Selected at resolve time via `package.json` exports conditions. | §5.1 |
| `src/domain/error.ts` | Widen `TsgitErrorData` to include the 3 new variants | §11 |
| `src/domain/commands/error.ts` | Add 3 new `CommandError` variants + factories + `extractDetail` arms | §8.3 |

### 10.2 Delegation

- Phase 9 commands and Phase 7 primitives are consumed verbatim — Phase 10 binds them.
- Phase 8 transport is composed via the `withDefaults` helper from `commands/internal/network-pipeline.ts` — no new transport composition logic.
- Phase 4 ports are consumed via `detectAdapter` + explicit overrides.

### 10.3 Deferred to Phase 11

- Cross-runtime E2E tests (Playwright + real browsers, real Node CLI).
- TypeDoc API documentation generation.
- npm publish flow.
- v1.0.0 release.

### 10.4 v2 deferrals

- `Symbol.asyncDispose` integration.
- A `useRepository` React hook (or framework adapters generally — out of scope; tsgit ships the vanilla API only).
- Dynamic re-detection (e.g., switching transports mid-session). Current model is: dispose + re-open.

---

## 11. Backward Compatibility

**Surface additions (additive, minor-version safe).** The new exports under `tsgit` (the root entry) replace what was previously a `export {}` placeholder. Existing exports under `tsgit/commands`, `tsgit/primitives`, `tsgit/operators`, `tsgit/transport`, `tsgit/adapters/*` retain their Phase 6/7/8/9 shapes exactly.

**`TsgitErrorData` widening (minor-version obligation).** The 3 new error variants widen `TsgitErrorData`. Same minor-version-only obligation applies as Phase 9 §11 — consumers using `switch (e.code)` without a `default:` arm need to add the new cases when upgrading.

**Engines bump (BREAKING — major version required).** `package.json` `"engines"` moves from `">=18"` to `">=20.3.0"`. This drops Node 18 (LTS until April 2025), Node 19, and Node 20.0–20.2. Per semver, this is a breaking change and Phase 10 ships under a major-version bump (`0.x → 1.0` if pre-1.0; `1.x → 2.0` otherwise).

The bump is necessary because `AbortSignal.any` (used by per-call signal composition in §4.4) is native only from Node 20.3 onward. The cost of polyfilling it portably (listener leak risks, edge-case `.reason` propagation) is higher than the cost of dropping older runtimes.

---

## 12. Open Questions

1. **`Repository` memoization.** Should `openRepository(sameOpts)` return the same instance on second call? Default: no — each call constructs a fresh `ctx` + `Repository`. Memoization is a user concern (they hold the reference).
2. **Multi-repo support.** The facade is single-repo. A user wanting multi-repo workflows opens N facades and manages them. No `RepositoryManager` in v1.
3. **Telemetry hooks.** A general "every command emits a structured event" hook would be useful for OpenTelemetry / DataDog / etc. Defer to v2; the `ProgressReporter` covers the most pressing UX need.
4. **Hooks invocation.** Phase 9 design defers hooks to v2; Phase 10's facade is the natural integration point when they arrive. The forward-compat shape (subject to revision in v2) is `hooks?: { [event: string]: ReadonlyArray<(payload: unknown) => Promise<void> | void> }` on `OpenRepositoryOptions` — registered handlers run sequentially in registration order; throws abort the operation. No implementation in v1.

---
