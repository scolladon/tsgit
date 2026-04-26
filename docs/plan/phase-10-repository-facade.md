# Plan: Phase 10 — Repository Facade

Implements [design/repository-facade.md](../design/repository-facade.md).
Covers [backlog](../BACKLOG.md) items 10.1–10.3.

### Review Notes

**Round 3 — applied** (third self-review pass, manual structural sanity check):

- All step substep numbers (0(a)/0(b)/0(c)/0(d)/0(e), 1.1–1.3, 2.1–2.2, 3.0–3.7, 4.1–4.2, 5.1–5.8, 6.1–6.4) verified gap-free.
- All `Step 0.X` references rewritten to `Step 0(x)` notation throughout.
- Phase 9 prereq verification step (0(e)) added — explicit fail-fast check before Step 1.
- Variant count cross-check: 27 (Phase 9) + 3 (Phase 10) = 30 `CommandError` variants total in `extractDetail` after Step 0(b).
- No remaining TODO / TBD markers in spec body.

---

**Round 2 — applied** (second self-review pass — focused on Round 1's collision fixes):

- Step 0 split into 5 substep commits (0(a) engines, 0(b) errors, 0(c) renames, 0(d) disposeAdapters, 0(e) prereq check) — Round 1 introduced the split; Round 2 propagated all "Step 0.X" references to the new "Step 0(x)" notation.
- Cross-section search confirms no orphan references.

---

**Round 1 — applied** (single self-review pass + tool-assisted external reviewer):

- **Hard prerequisite restated.** Phase 10 cannot be implemented until Phase 9 is on main. Step 0 explicitly checks for: `wrapLoggerSanitizer` and `sanitize()` (Phase 9 §4.7), the 27-variant `domain/commands/error.ts`, the 3 Phase 7-amendment primitives (`mergeBase`, `writeSymbolicRef`, `getRepoRoot`), and `test/unit/domain/exhaustiveness.ts`. If any is missing, Phase 9 implementation is incomplete and Phase 10 must wait.
- **`ProgressReporter` naming collision resolved.** The existing port at `src/ports/progress-reporter.ts` (with `report(event)` shape) is RENAMED to `ProgressEventEmitter` to avoid colliding with the new facade-tier `ProgressReporter` (`start/update/end` shape). Step 0(c) lands the rename + an updated barrel re-export. Existing primitives that consume the port (search shows none in current code, but verify) are migrated.
- **`RepositoryConfig` naming collision resolved.** The existing port-tier `RepositoryConfig` at `src/ports/context.ts` (with `{ workDir, gitDir, bare }`) is RENAMED to `RepositoryLayout`. The new facade-tier type (with `{ user, auth, parallelism, ... }`) takes the `RepositoryConfig` name. Step 0(c) lands the rename (alongside the ProgressReporter rename — same commit).
- **Inline `consoleProgress` body simplified.** Step 1.3 — removed self-canceling `wrapLoggerSanitizer({ log: () => {} })` snippet; replaced with explicit calls to `sanitize` + ANSI-strip + HTML-escape helpers spec'd in their own substep.
- **Step 3 inline helpers spec'd.** §3.0 (new) declares `composeAdapters`, `wrapFsValidator`, `wrapTransportValidator`, `defaultCwd`, `deepFreeze`, `validateOptions` with signatures + locations. The factories `repositoryDisposed`, `invalidOption`, `adapterUnavailable` come from Step 0(b).
- **`unsafeRawAdapters` flag scope clarified.** §3.6 — when `true`, NONE of the four adapters are wrapped (fs / transport / hash / compressor). Test scenarios cover all four.
- **Step 0 split.** Engines bump (+ CI matrix update) is now Step 0(a); error scaffold is Step 0(b); naming collisions are Step 0(c); disposeAdapters is Step 0(d). Mirrors Phase 8 §0(a)/§0(b) pattern.
- **Step 4 `recordingProgress` location.** Added to `test/unit/transport/fixtures.ts` (NEW addition; was incorrectly described as "extending"). Test fixture is part of Step 4's deliverables.
- **Math fix.** `Object.keys(repo).length === 19` (16 commands + `primitives` + `ctx` + `dispose` = 19, not 18). Step 3.7 corrected.
- **Step 4 mutation-resistance directive.** §4.2 explicit: granularity boundary triples (e.g., 99/100/101 for "every 100"), exact `toBe(<op-string>)` for op names, isolated-guard tests for each progress site.
- **`vitest.config.ts` listed in Step 5 wiring** — was missing.
- **Progress operation count.** Design §6.2 lists 9 OPS for 9 commands (was 10 — design counts `clone:discover`, `clone:write-objects`, `clone:checkout-files` as 3 ops in 1 command; aggregated by command in this plan's table for substep planning).

---

## Backlog → Step Mapping

| Backlog | Description | Step |
|---|---|---|
| — | Step 0(a): engines bump + CI matrix; (b) error scaffold (3 variants); (c) ProgressReporter + RepositoryConfig collision rename; (d) `disposeAdapters` helper | 0 |
| — | `progress.ts` — `ProgressReporter` interface, `noopProgress`, `consoleProgress` | 1 |
| **10.2** | `adapter-detect.ts` + 3 runtime shims (`index.node.ts`, `index.browser.ts`, `index.default.ts`) | 2 |
| **10.1** | `repository.ts` — `openRepository(opts)` factory, `Repository` shape, binding logic, `dispose()` state machine | 3 |
| **10.3** | Wire progress reporting into the 9 commands listed in design §6.2 | 4 |
| — | Wiring: `package.json` exports + conditions, `rollup.config.ts` runtime entries, `.size-limit.json`, `.dependency-cruiser.cjs`, `knip.json`, `src/index.ts` | 5 |
| — | Mutation testing + 3× parallel reviews + squash-merge | 6 |

---

## Workflow

Each step follows TDD: write test (red) → implement (green) → refactor.
After every green step, run: `npm run check:types && npm run test:unit && npm run check:architecture`.

**Commit strategy.** One commit per substep (e.g., `2.1`, `2.2`) when the step is large; one commit per step when small.

- Step 0 → `feat(domain): bump engines + add Phase 10 error variants + disposeAdapters helper`.
- Step 1 → `feat: add ProgressReporter and built-in reporters`.
- Step 2 → `feat: add adapter-detect + runtime shims`.
- Step 3 → `feat: add openRepository facade`.
- Step 4 → `feat(commands): wire progress reporting into long-running commands` (touches 9 commands; consider splitting into 3 substeps).
- Step 5 → `chore: wire Phase 10 facade exports`.
- Step 6 squash-merge message: `feat: add phase 10 — repository facade`.

**Branch strategy.** Implement on `feat/phase-10-facade` (or worktree). Plan + design land directly on main. Implementation goes on a branch and squash-merges.

**Engines bump.** Step 0 lands the engines bump. After this commit, CI matrix MUST drop Node 18/19/20.0–20.2 (else build will fail on `AbortSignal.any`). Note this is a breaking change requiring a major-version bump (per design §11).

---

## Prerequisites (before Step 0)

1. **Design doc merged.** `docs/design/repository-facade.md` is on main. ✓ this commit.
2. **Phases 1–9 complete.** Phase 10 imports from every prior layer.
3. **`.size-limit.json` `Facade` entry.** Cap 3 kB gzipped, lands in Step 5.
4. **`package.json` exports.** Runtime conditional exports (`./node`, `./browser`, `./default`) + `./auto/{node,browser,memory}` subpaths added in Step 5.
5. **`.dependency-cruiser.cjs`.** New rule `repository-can-only-be-imported-by-index` added in Step 5.
6. **`knip.json`.** Add `src/index.ts`, `src/index.node.ts`, `src/index.browser.ts`, `src/index.default.ts`, `src/repository.ts`, `src/adapter-detect.ts`, `src/progress.ts` to `entry`.
7. **`cspell` lexicon.** Spelling additions per step. Verify with `npm run check:spelling`.

---

## File Conventions

Inherited from Phase 9:

- Source files under `src/` (top-level for the facade — `repository.ts`, `adapter-detect.ts`, `progress.ts`, `index.ts`, `index.node.ts`, `index.browser.ts`, `index.default.ts`).
- Test files under `test/unit/` matching the source layout (`repository.test.ts`, `adapter-detect.test.ts`, `progress.test.ts`, `facade-integration.test.ts`).
- Kebab-case files. `.js` import suffix. Type-only imports for non-runtime references.
- **Test format:** Given/When/Then titles, AAA bodies, `sut`. Error assertions use `try/catch` + `.data.code` + payload. `toBe(<exact string>)` for messages.
- **Mutation-resistant assertions** (CLAUDE.md): isolated guard tests, boundary triples, exact-match strings.

---

## Design Decisions (applied in this plan)

- **Step 0 lands the engines bump + error scaffold + disposeAdapters helper as ONE commit.** All three are prerequisites for the rest of Phase 10.
- **Step 2 (adapter detection) lands BEFORE Step 3 (facade)** — the facade calls `detectAdapter()` at construction.
- **Step 4 (progress wiring) is a Phase 9 amendment in spirit** — it modifies 9 existing command files. Implementer can split into 3 substep commits (clone+fetch+push, checkout+merge, status — see Step 4 below).
- **Step 5 (wiring) is LAST** — it adds `package.json` exports that reference files created in Steps 2 + 3.
- **Step 6 (mutation + reviews + merge) is the merge gate.**

---

## Step 0: Prerequisites

**Design:** §1 (engines), §8.3 (errors), §10.1 (disposeAdapters), §6 (ProgressReporter naming), §4.2 (RepositoryConfig naming).

Four substeps, each its own commit (mirrors Phase 8 §0).

### 0(a) Engines bump

**Modify:** `package.json` (engines), CI config (matrix).

`package.json` `"engines": { "node": ">=20.3.0" }`. CI matrix drops Node 18/19/20.0–20.2; keeps 20.3+, 22.

**Tests.** A trivial CI sanity test — no unit-test changes; `npm run validate` must pass on the surviving Node versions.

**Commit.** `chore: bump engines to >=20.3.0 (Phase 10 requires AbortSignal.any)`.

### 0(b) Error scaffold

Three new `CommandError` variants per design §8.3 — same content as the original Step 0(b) below, now its own commit.

**Modify:** `src/domain/commands/error.ts`, `src/domain/error.ts`, related test files.

#### Three new `CommandError` variants

```typescript
// add to src/domain/commands/error.ts
| { readonly code: 'INVALID_OPTION'; readonly option: string; readonly reason: string }
| { readonly code: 'REPOSITORY_DISPOSED' }
| { readonly code: 'ADAPTER_UNAVAILABLE'; readonly runtime: 'node' | 'browser' | 'memory'; readonly reason: string }
```

Three factory functions (one per variant). Three `extractDetail` arms in `domain/error.ts`:

| Code | Detail format |
|---|---|
| `INVALID_OPTION` | `invalid option: ${option} — ${sanitize(reason)}` |
| `REPOSITORY_DISPOSED` | `repository has been disposed; create a new one with openRepository()` |
| `ADAPTER_UNAVAILABLE` | `adapter unavailable for runtime ${runtime}: ${sanitize(reason)}` |

**Tests** in `test/unit/domain/commands/error.test.ts` (extend existing):

```
- 3 factory-data tests (one per variant; assert .data shape).
- 3 extractDetail message-format tests with EXACT toBe(...).
- For INVALID_OPTION with reason containing CRLF: assert escaped via \xNN (sanitize ran).
```

Update the shared exhaustiveness helper at `test/unit/domain/exhaustiveness.ts` (created in Phase 9 Step 1.7) to include the 3 new cases.

**Commit.** `feat(domain): add Phase 10 error variants and extractDetail arms`.

### 0(c) Naming collision rename + Context port extension

**Modify:** `src/ports/progress-reporter.ts` → rename type `ProgressReporter` to `ProgressEventEmitter`; barrel updated. Modify `src/ports/context.ts` → (1) rename existing port-tier type `RepositoryConfig` (with `{ workDir, gitDir, bare }`) to `RepositoryLayout`, (2) add a NEW `RepositoryConfig` type for the facade-tier shape (`{ user, auth, parallelism, upstreamRef, allowInsecure, allowPrivateNetworks, maxResponseBytes, maxObjectsPerPack, detectRenames, breakStaleLockMs, dnsResolver, maxDnsResults }`), (3) add fields on `Context`:

```typescript
export interface Context {
  // existing
  readonly fs: FileSystem;
  readonly hash: HashService;
  readonly compressor: Compressor;
  readonly transport: HttpTransport;
  readonly progress: ProgressEventEmitter;          // renamed (was: ProgressReporter)
  readonly hashConfig: HashConfig;
  readonly deltaCache: LruCache<Uint8Array>;
  readonly signal?: AbortSignal;
  // renamed: was `config: RepositoryConfig (old shape)`
  readonly layout: RepositoryLayout;
  // NEW (Phase 10 additions)
  readonly cwd: string;                             // user-supplied working directory (may be sub-dir of layout.workDir)
  readonly config?: RepositoryConfig;               // facade-tier config; optional (omitted when openRepository is bypassed)
  readonly logger?: Logger;                         // sanitized logger; optional
}
```

**Migrate every primitive and command.** Replace `ctx.config.gitDir` → `ctx.layout.gitDir`, `ctx.config.workDir` → `ctx.layout.workDir`, `ctx.config.bare` → `ctx.layout.bare` across `src/application/**`. Verify with grep: zero remaining `ctx.config.gitDir` / `ctx.config.workDir` / `ctx.config.bare` after the migration. The new `ctx.config` (facade-tier) is consulted only by network-pipeline / SSRF / parallelism sites — not by layout-aware primitives.

**Update `ProgressEventEmitter` consumers (if any).** Current grep shows no command consumes the `progress` port directly; verify before commit.

**Tests.** Run `npm run check:types` — must pass after the rename. Existing port-contract tests at `test/unit/ports/progress-reporter.contract.ts` and `test/unit/ports/context.test.ts` adjust to the new names. Each migrated primitive's tests must continue passing without scenario change — the rename is mechanical.

**Verify.** `npm run check:types && npm run test:unit && npm run check:architecture` all green.

**Commit.** `refactor(ports): split RepositoryConfig into Layout+Config, extend Context with cwd/logger, rename ProgressReporter→ProgressEventEmitter (Phase 10 prep)`.

### 0(d) `disposeAdapters(ctx)` helper

```typescript
// src/dispose-adapters.ts
export const disposeAdapters = async (ctx: Context): Promise<void> => {
  await Promise.all([
    'fs', 'transport', 'compressor', 'hash',
  ].map(async (key) => {
    const port = (ctx as Record<string, unknown>)[key];
    if (port && typeof (port as { dispose?: () => Promise<void> }).dispose === 'function') {
      try {
        await (port as { dispose: () => Promise<void> }).dispose();
      } catch (err) {
        // best-effort cleanup: log via the (already sanitized) ctx.logger if present, never rethrow
        ctx.logger?.warn?.('disposeAdapters: port dispose threw', { port: key, err: String(err) });
      }
    }
  }));
};
```

**Tests** in `test/unit/dispose-adapters.test.ts`:

```
Given a ctx with ports that lack dispose, When disposeAdapters, Then resolves without error.
Given a ctx with one port that has dispose, When disposeAdapters, Then that dispose is called once.
Given a ctx with multiple disposable ports, When disposeAdapters, Then ALL are called (no early bail).
Given a port whose dispose throws, When disposeAdapters, Then the error is swallowed (other ports still disposed).
Given two concurrent calls, When disposeAdapters runs twice, Then both resolve (no shared mutable state).
```

**Commit.** `feat: add disposeAdapters helper`.

### 0(e) Validate Phase 9 prereqs

Before proceeding to Step 1, verify the following Phase 9 deliverables exist on main:

- `src/domain/commands/error.ts` exports 27 `CommandError` variants on Phase 9 main; this prereq check verifies that baseline. After Step 0(b), the count must be exactly 30 (27 + 3); the post-0(b) count check is asserted in the exhaustiveness test updated by Step 0(b).
- `src/application/primitives/index.ts` exports `mergeBase`, `writeSymbolicRef`, `getRepoRoot` (Phase 9 Step 0 amendment).
- `src/application/commands/internal/network-pipeline.ts` exports `wrapLoggerSanitizer` and `withDefaults`.
- `test/unit/domain/exhaustiveness.ts` exists.

If any is missing, halt and complete Phase 9 first.

---

## Step 1: `progress.ts`

**Design:** §6.

**Create:** `src/progress.ts`, `test/unit/progress.test.ts`.

### 1.1 `ProgressReporter` interface

```typescript
export interface ProgressReporter {
  readonly start: (op: string, total?: number) => void;
  readonly update: (op: string, current: number, total?: number, text?: string) => void;
  readonly end: (op: string) => void;
}

export const noopProgress: ProgressReporter;
export const consoleProgress: (sink: (line: string) => void) => ProgressReporter;
```

### 1.2 `noopProgress` implementation

Three no-op functions. Frozen object.

**Tests:**

```
Given noopProgress, When start/update/end called with any arguments, Then return void without side effects.
Given noopProgress, When called repeatedly, Then no allocations beyond the singleton (verify via WeakMap identity).
Given Object.isFrozen(noopProgress), Then true.
```

### 1.3 `consoleProgress` implementation

```typescript
export const consoleProgress = (sink: (line: string) => void): ProgressReporter => {
  const safeSink = (line: string): void => {
    try { sink(line); } catch { /* swallow — reporter must never throw */ }
  };
  const safe = (text: string): string => {
    let result = sanitize(text);                 // \xNN escapes for non-printable (Phase 9 §4.7)
    result = result.replace(/\x1b\[[0-9;]*m/g, ''); // strip ANSI escapes
    result = result.replace(/[<>&"']/g, (c) => `&#${c.charCodeAt(0)};`); // HTML entity escape
    return result;
  };
  const safeOp = (op: string): string => safe(op); // op MAY originate from sideband; sanitize symmetrically.
  return {
    start: (op, total) => safeSink(`${safeOp(op)}: start${total !== undefined ? `/${total}` : ''}`),
    update: (op, current, total, text) => safeSink(`${safeOp(op)}: ${current}${total !== undefined ? `/${total}` : ''}${text ? ` ${safe(text)}` : ''}`),
    end: (op) => safeSink(`${safeOp(op)}: done`),
  };
};
```

`safeSink` is local to `consoleProgress` — wraps every `sink(...)` call in `try/catch` so a throwing sink never crashes the reporter. `safeOp` runs the same sanitizer on `op` so sideband-sourced op strings (e.g., the `text` arg from `fetch:negotiate`) cannot inject control characters into the formatted line.

**Tests:**

```
Given consoleProgress(sink) and sink is a recording mock, When start('clone:write-objects', 250), Then sink received 'clone:write-objects: start/250'.
Given consoleProgress and update(op, 100, 250), Then sink received 'op: 100/250'.
Given consoleProgress and update(op, 50, undefined, 'progress text'), Then sink received 'op: 50 progress text'.
Given consoleProgress and update(op, 1, 1, 'evil\x1b[31mtext'), Then sink received the text WITHOUT the ANSI escape.
Given consoleProgress and update(op, 1, 1, '<script>alert(1)</script>'), Then sink received HTML-entity-escaped output.
Given consoleProgress and update(op, 1, 1, 'helloworld'), Then BEL byte (0x07) is hex-escaped.
Given consoleProgress and a sink that throws, When start/update/end called, Then no exception escapes the reporter.
```

**Commit.** `feat: add ProgressReporter interface and built-in reporters`

---

## Step 2: `adapter-detect.ts` + runtime shims

**Design:** §5.1.

**Create:** `src/adapter-detect.ts`, `src/index.node.ts`, `src/index.browser.ts`, `src/index.default.ts`, `test/unit/adapter-detect.test.ts`.

### 2.1 `src/adapter-detect.ts`

This file is referenced from the runtime shims. Each shim provides a runtime-specific `detectAdapter()`. The file at `src/adapter-detect.ts` itself is just the type interface + a runtime-detection helper.

```typescript
export interface AdapterSet {
  readonly fs: FileSystem;
  readonly hash: HashService;
  readonly compressor: Compressor;
  readonly transport: HttpTransport;
}

const isNode = (): boolean =>
  typeof process !== 'undefined' &&
  Object.hasOwn(process, 'versions') &&
  Object.hasOwn(process.versions ?? {}, 'node');

const isBrowser = (): boolean =>
  typeof window !== 'undefined' &&
  typeof navigator !== 'undefined';

export const detectRuntime = (): 'node' | 'browser' | 'memory' => {
  if (isNode()) return 'node';
  if (isBrowser()) return 'browser';
  return 'memory';
};

// Each runtime shim exports its own detectAdapter() that returns the
// pre-bound AdapterSet for that runtime.
```

**Tests** in `test/unit/adapter-detect.test.ts`:

```
isNode:
  Given typeof process is 'object' AND process.versions.node is set, When isNode, Then true.
  Given typeof process is 'undefined', When isNode, Then false.
  Given attacker pollutes Object.prototype.versions = { node: 'x' }, When isNode, Then false (Object.hasOwn rejects inherited).

isBrowser:
  Given typeof window is 'object' AND typeof navigator is 'object', When isBrowser, Then true.
  Given window is undefined, When isBrowser, Then false.
  Given attacker pollutes Object.prototype.window = {}, When isBrowser, Then false (typeof check rejects undefined-direct + pollution-safe).

detectRuntime:
  Given Node environment, When detectRuntime, Then 'node'.
  Given browser-like environment (mocked window+navigator, no process), When detectRuntime, Then 'browser'.
  Given neither, When detectRuntime, Then 'memory'.
```

Tests use `vi.stubGlobal('process', ...)` and `vi.stubGlobal('window', ...)` to fake each runtime.

### 2.2 Runtime shims

```typescript
// src/index.node.ts
import { createNodeAdapters } from './adapters/node/index.js';
import { openRepository as openRepositoryCore, type OpenRepositoryOptions, type Repository } from './repository.js';

export const detectAdapter = (): AdapterSet => createNodeAdapters();

export const openRepository = async (opts?: OpenRepositoryOptions): Promise<Repository> => {
  const detected = detectAdapter();
  return openRepositoryCore({
    ...opts,
    fs: opts?.fs ?? detected.fs,
    hash: opts?.hash ?? detected.hash,
    compressor: opts?.compressor ?? detected.compressor,
    transport: opts?.transport ?? detected.transport,
  });
};

// re-exports
export type { OpenRepositoryOptions, Repository } from './repository.js';
export type { ProgressReporter } from './progress.js';
export { noopProgress, consoleProgress } from './progress.js';
```

Same shape for `index.browser.ts` and `index.default.ts` (the latter uses memory adapter).

**Tests** in `test/unit/facade-integration.test.ts`:

```
Given the memory shim, When openRepository({ cwd: '/repo' }), Then returns a Repository whose ctx.fs is a MemoryFileSystem.
Given init → add → commit → status round-trip, When run via the shim, Then the chain succeeds end-to-end.
```

**Commit.** `feat: add adapter-detect + runtime shims`

---

## Step 3: `repository.ts` — `openRepository` factory

**Design:** §4 (Repository, OpenRepositoryOptions, RepositoryConfig, signal composition), §8 (validation, dispose).

**Create:** `src/repository.ts`, `test/unit/repository.test.ts`.

### 3.0 Inline helper signatures (created within `repository.ts`)

These helpers are local to `repository.ts`; not exported.

| Helper | Signature | Purpose |
|---|---|---|
| `composeAdapters` | `(opts: OpenRepositoryOptions) => AdapterSet` | Merges user-supplied overrides with `detectAdapter()`. |
| `wrapFsValidator` | `(fs: FileSystem, cwd: string) => FileSystem` | Wraps user-supplied FS to re-apply Phase 9 §4.6 path-confinement. `cwd` is the resolved working directory (post-`defaultCwd()`); deeper repo-root resolution happens lazily inside the wrapped methods via `getRepoRoot`. |
| `wrapTransportValidator` | `(transport: HttpTransport, config: RepositoryConfig \| undefined) => HttpTransport` | Wraps user-supplied transport to re-apply Phase 9 §4.8 SSRF guards. Takes `config` directly (not `ctx`) — called BEFORE `ctx` is constructed. |
| `defaultCwd` | `() => string` | Returns `process.cwd()` on Node, `'/'` on browser/memory. Uses the prototype-pollution-safe `isNode()` from Step 2. |
| `deepFreeze` | `<T>(value: T) => Readonly<T>` | Recursive `Object.freeze` over plain-object values; functions and frozen objects pass through. |
| `validateOptions` | `(opts: OpenRepositoryOptions) => void` | Checks each field per design §8.1; throws `INVALID_OPTION`. |

**Tests** in `test/unit/repository.test.ts` (extend the §3.x tests already planned):

```
composeAdapters: 4 rows of overrides + 4 rows from detect — 8 cases.
wrapFsValidator: 1 case — realpath returning escape; 1 case — happy path passes through.
wrapTransportValidator: 1 case — request to private IP rejected; 1 case — public IP passes.
deepFreeze: 3 cases — flat object, nested object, array.
validateOptions: see §3.2 below (already enumerated).
```

### 3.1 Construction

```typescript
export const openRepository = async (opts: OpenRepositoryOptions = {}): Promise<Repository> => {
  validateOptions(opts);
  const detected = composeAdapters(opts);   // user overrides + detected
  const cwd = opts.cwd ?? defaultCwd();
  const adapters = opts.unsafeRawAdapters === true
    ? detected
    : {
        ...detected,
        fs: wrapFsValidator(detected.fs, cwd),
        transport: wrapTransportValidator(detected.transport, opts.config),
        // hash and compressor pass through — see design §4.1 trust model.
      };
  const safeLogger = opts.logger ? wrapLoggerSanitizer(opts.logger) : undefined;
  const config = opts.config ? deepFreeze(opts.config) : undefined;
  const controller = new AbortController();
  const signal = opts.signal !== undefined
    ? AbortSignal.any([controller.signal, opts.signal])
    : controller.signal;

  // Resolve repo layout from cwd. `findLayout` walks up from cwd looking for `.git`;
  // when none found and `opts.allowCreate === true` (init/clone path), defaults to
  // `{ workDir: cwd, gitDir: cwd + '/.git', bare: false }`. Otherwise throws REPOSITORY_NOT_FOUND.
  const layout = await findLayout(adapters.fs, cwd, opts);
  const ctx: Context = createContext({
    cwd,
    fs: adapters.fs,
    hash: adapters.hash,
    compressor: adapters.compressor,
    transport: adapters.transport,
    logger: safeLogger,
    progress: opts.progress ?? noopProgress,
    layout,
    config,
    hashConfig: defaultHashConfig(layout),       // sha1 vs sha256 — read from .git/config or derived
    deltaCache: createDeltaCache(),              // shared LRU per Phase 7 contract
    signal,
  });

  let state: 'OPEN' | 'DISPOSING' | 'DISPOSED' = 'OPEN';
  let disposePromise: Promise<void> | undefined;

  const dispose = async (): Promise<void> => {
    if (state === 'DISPOSED') return;
    if (disposePromise !== undefined) return disposePromise;
    state = 'DISPOSING';
    controller.abort();                                // synchronous: ctx.signal.aborted = true ATOMICALLY (no async gap)
    disposePromise = (async () => {
      // Defer to a macrotask boundary (NOT just a microtask) — Node.js I/O callbacks queue at
      // event-loop iteration, not microtask drain. setImmediate gives in-flight readFile/etc.
      // a real chance to observe ctx.signal.aborted and unwind via try/finally.
      await new Promise<void>((resolve) => setImmediate(resolve));
      await disposeAdapters(ctx);
      state = 'DISPOSED';
    })();
    return disposePromise;
  };

  // Atomic gate: `controller.abort()` flips `ctx.signal.aborted` synchronously inside `dispose()`.
  // Reading `ctx.signal.aborted` is therefore a single atomic check — no TOCTOU window between
  // the state read and command dispatch. `state !== 'OPEN'` is the secondary check for the
  // narrow race where dispose was called and signal abort was observed (REPOSITORY_DISPOSED).
  const guarded = <T>(fn: () => T): T => {
    if (ctx.signal!.aborted || state !== 'OPEN') throw repositoryDisposed();
    return fn();
  };

  return Object.freeze({
    init: (opts) => guarded(() => initCommand(ctx, opts)),
    add: (paths, addOpts) => guarded(() => addCommand(composeSignal(ctx, addOpts), paths, addOpts)),
    // ... 14 more commands ...
    primitives: Object.freeze({
      readObject: (id, ropts) => guarded(() => readObjectPrim(ctx, id, ropts)),
      // ... 14 more primitives ...
    }),
    ctx,
    dispose,
  });
};

const composeSignal = (ctx: Context, opts?: { signal?: AbortSignal }): Context => {
  if (opts?.signal === undefined) return ctx;
  return { ...ctx, signal: AbortSignal.any([ctx.signal, opts.signal]) };
};
```

### 3.2 Validation tests (§8.1)

```
Given opts.cwd = 'relative/path', When openRepository, Then throws INVALID_OPTION with .data.option === 'cwd'.
Given opts.cwd = '/abs/path', Then resolves.
Given opts.config.parallelism = 0, Then throws INVALID_OPTION with sanitized reason.
Given opts.config.parallelism = 33, Then throws INVALID_OPTION.
Given opts.config.parallelism = 1 (boundary), Then resolves.
Given opts.config.parallelism = 32 (boundary), Then resolves.
Given opts.config.maxResponseBytes = 1023, Then throws INVALID_OPTION.
Given opts.config.maxResponseBytes = 1024 (boundary), Then resolves.
Given opts.config.breakStaleLockMs = -1, Then throws INVALID_OPTION with .data.option === 'breakStaleLockMs' and sanitized .data.reason.
Given opts.config.maxObjectsPerPack = 0, Then throws INVALID_OPTION with .data.option === 'maxObjectsPerPack' and sanitized .data.reason.
Given opts.config.maxDnsResults = 0, Then throws INVALID_OPTION with .data.option === 'maxDnsResults'.
Given opts.config.maxDnsResults = 1 (boundary), Then resolves.
Given opts.config.maxDnsResults = 64 (default), Then resolves; resolver returning 65 entries triggers DNS_RESULT_LIMIT_EXCEEDED before SSRF check (asserted via separate test).
Given opts.config.dnsResolver passed as non-function via `as unknown as Function` cast, When openRepository, Then throws INVALID_OPTION at the runtime guard (TypeScript blocks the unsafe shape at compile time; the runtime guard is the second line of defense).
```

### 3.3 Frozen ctx tests (§4.6)

```
Given returned repo, When Object.isFrozen(repo), Then true.
Given returned repo, When Object.isFrozen(repo.ctx), Then true.
Given returned repo, When opts.config was provided, Then Object.isFrozen(repo.ctx.config) AND every nested object on config is frozen (deepFreeze).
Given attempt to repo.ctx.logger = differentLogger in strict mode, Then TypeError.
```

### 3.4 Signal composition tests (§4.4)

```
Given opts.signal aborts, When repo.add() is in-flight, Then add's ctx.signal.aborted becomes true.
Given per-call opts.signal aborts, When repo.add(paths, { signal: perCall }) is in-flight, Then add's ctx.signal.aborted becomes true (composed via AbortSignal.any).
Given both opts.signal and per-call signal abort, Then ctx.signal aborts (either source).
Given no per-call signal, When repo.add() is invoked, Then ctx is passed through as-is (no allocation; verify via reference equality).
Given ctx.signal is already aborted AND a per-call signal is provided, When composeSignal runs, Then returns ctx.signal directly (no AbortSignal.any allocation; verify via reference equality and a spy on AbortSignal.any).
```

### 3.5 Dispose state machine (§8.2.1)

```
Given a fresh repo, When dispose() is called, Then resolves; state becomes DISPOSED.
Given a disposed repo, When repo.add(...) is called, Then throws REPOSITORY_DISPOSED.
Given a disposed repo, When dispose() is called again, Then resolves (idempotent — no double abort).
Given two concurrent dispose() calls, When both are awaited, Then both resolve and the underlying disposeAdapters runs ONCE (verify via `vi.spyOn(disposeAdaptersModule, 'disposeAdapters')` registered in `test/unit/repository.test.ts` — assert `.mock.calls.length === 1`).
Given user-signal aborts (NOT dispose), When the signal fires, Then ctx.signal becomes aborted but state remains OPEN — dispose() must still be called explicitly to transition to DISPOSED. Verify state via observable behavior (a subsequent repo.add resolves with OPERATION_ABORTED, not REPOSITORY_DISPOSED).
Given an in-flight repo.status() and dispose() is called, Then status's ctx.signal.aborted becomes true; status rejects with OPERATION_ABORTED.
Given dispose() is called before any command, When repo.init() is called immediately after, Then throws REPOSITORY_DISPOSED.
```

### 3.6 Adapter validator wrapping (§5.2.1)

```
Given opts.fs whose realpath returns '/etc/passwd', When repo.add(['foo']), Then throws PATHSPEC_OUTSIDE_REPO (wrapping fired).
Given the same with opts.unsafeRawAdapters = true, When repo.add(['foo']), Then the lying realpath is trusted (test that the inner FS receives the call).
Given opts.transport with no SSRF guard, When repo.clone('http://10.0.0.1/'), Then throws BLOCKED_HOST (wrapping fired).
Given the same with unsafeRawAdapters: true, Then the request reaches the (mock) transport.
Given opts.hash supplied, When repo runs, Then the user-supplied hash is invoked verbatim (NOT wrapped) regardless of unsafeRawAdapters value (verify with a spy on the user-supplied hash — same call count for both flag values).
Given opts.compressor supplied, When repo runs, Then the user-supplied compressor is invoked verbatim (NOT wrapped) regardless of unsafeRawAdapters value.
```

### 3.7 Repository binding integrity

```
Given returned repo, When Object.keys(repo).sort(), Then deepEqual to the explicit list ['add','branch','checkout','clone','commit','ctx','diff','dispose','fetch','init','log','merge','primitives','push','reset','revParse','rm','status','tag'] (19 entries — kills mutants that add or rename a key without changing the count).
Given returned repo, When Object.keys(repo.primitives).sort(), Then deepEqual to ['createCommit','diffTrees','getRepoRoot','mergeBase','readBlob','readIndex','readObject','readTree','resolveRef','updateRef','walkCommits','walkTree','writeObject','writeSymbolicRef','writeTree'] (15 entries).
Given returned repo, When typeof repo.add, Then 'function'.
Given returned repo, When typeof repo.primitives.readObject, Then 'function'.
Given returned repo, Then repo.dispose is a function and repo.ctx is the frozen Context.
```

**Commit.** `feat: add openRepository facade with binding logic and dispose state machine`

---

## Step 4: Wire progress reporting into 9 commands

**Design:** §6.2 operations table.

This step modifies existing Phase 9 command files. Per design §6.2, 9 operations report progress:

| Command file | Operation | Start total | Update granularity |
|---|---|---|---|
| `clone.ts` | `clone:discover` | undefined | not used (sideband only) |
| `clone.ts` | `clone:write-objects` | object count from pack header | every 100 objects |
| `clone.ts` | `clone:checkout-files` | file count | every 100 files |
| `fetch.ts` | `fetch:negotiate` | undefined | sideband progress text |
| `fetch.ts` | `fetch:write-objects` | object count | every 100 objects |
| `push.ts` | `push:enumerate-objects` | undefined | every 100 objects walked |
| `push.ts` | `push:upload` | total bytes | every 65536 bytes |
| `checkout.ts` | `checkout:materialize` | file count | every 100 files |
| `merge.ts` | `merge:write-files` | file count | every 100 files |
| `status.ts` | `status:scan` | undefined | every 100 lstat calls |

Each command:

1. Reads `ctx.progress` (which defaults to `noopProgress`).
2. Calls `progress.start(op, total)` before the loop / RPC.
3. Calls `progress.update(op, current, total, text?)` at the documented granularity.
4. Calls `progress.end(op)` in a `finally` block (so failure paths still emit `end`).

### 4.1 Substep commits (3 to keep diffs small)

- `feat(commands): wire progress for clone + fetch + push`
- `feat(commands): wire progress for checkout + merge`
- `feat(commands): wire progress for status`

### 4.2 Tests

**Mutation-resistance directives.**

- Op-name strings (`'clone:write-objects'`, etc.) MUST be asserted via `.toBe(<exact string>)` — not `toContain`. StringLiteral mutants on these names should be killed.
- Granularity boundaries get the standard triple: 99 / 100 / 101 objects → expect (1 update at end), (1 update at 100), (1 update at 100 + final at 101).
- Each progress site (start / update / end) is asserted in an isolated test (one assertion per site to kill statement-removal mutants).
- The `try/finally` `end()` is tested in BOTH success and failure paths separately.

For each operation, add tests that use `recordingProgress(): { reporter; events: [] }`:

```
Given clone of 250 objects, When packBody is drained, Then events match the §6.2.1 sequence:
  [{kind:'start', op:'clone:write-objects', total:250},
   {kind:'update', op:'clone:write-objects', current:100, total:250},
   {kind:'update', op:'clone:write-objects', current:200, total:250},
   {kind:'update', op:'clone:write-objects', current:250, total:250},
   {kind:'end', op:'clone:write-objects'}]

Given a failing clone (network error), When dispose runs, Then the open progress operation still receives 'end'.

Given fetch:negotiate with sideband progress text, When the server emits text, Then update is called with the text argument; the text is sanitized.

Given push:upload of 200 KiB, When uploaded, Then update fires at 65536, 131072, 196608, then 204800 final (granularity 65536 bytes — boundary triple at 65535 / 65536 / 65537 in a separate test isolates the threshold and kills `<` vs `<=` mutants).

Given a custom progress reporter that throws, When clone runs, Then the throw is swallowed (try/catch around every reporter call).
```

`recordingProgress()` lives in `test/unit/transport/fixtures.ts` (extending the Phase 8 fixtures).

**Commit.** Three substep commits as listed in §4.1.

---

## Step 5: Wiring

**Modify:** `package.json`, `rollup.config.ts`, `.size-limit.json`, `.dependency-cruiser.cjs`, `knip.json`, `vitest.config.ts`, `src/index.ts`.

### 5.1 `package.json` exports

Add the conditional-resolution entries per design §7.1:

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
  /* ... existing entries unchanged ... */
}
```

### 5.2 `rollup.config.ts`

Add 4 entries: `index.node`, `index.browser`, `index.default`, `repository` (the shared core).

### 5.3 `.size-limit.json`

```json
{ "name": "Facade", "path": "dist/esm/index.node.js", "limit": "3 kB", "gzip": true }
```

### 5.4 `.dependency-cruiser.cjs`

```javascript
{
  name: 'repository-can-only-be-imported-by-index',
  severity: 'error',
  from: { pathNot: '^(src/index\\.(ts|node\\.ts|browser\\.ts|default\\.ts)$|test/)' },
  to:   { path: '^src/repository\\.ts$' },
}
```

### 5.5 `knip.json`

Add `src/index.ts`, `src/index.node.ts`, `src/index.browser.ts`, `src/index.default.ts`, `src/repository.ts`, `src/adapter-detect.ts`, `src/progress.ts`, `src/dispose-adapters.ts` to the `entry` array.

### 5.6 `vitest.config.ts`

Add a `setupFiles` alias used by `test/unit/adapter-detect.test.ts` for runtime-detection mocks (`vi.stubGlobal('process', …)` etc.). Reference: design §10.1.1.

### 5.7 `src/index.ts`

```typescript
// Default-runtime entry — re-exports the openRepository factory and types.
// Each runtime shim (index.node.ts, index.browser.ts, index.default.ts) imports
// from this file and pre-binds the runtime-correct adapter set.
export { openRepository } from './repository.js';
export type { Repository, OpenRepositoryOptions, RepositoryConfig } from './repository.js';
export type { ProgressReporter } from './progress.js';
export { noopProgress, consoleProgress } from './progress.js';
export type { AdapterSet } from './adapter-detect.js';
// Both helpers are exported. `detectAdapter` is the runtime-bound factory each shim provides;
// `detectRuntime` is the prototype-pollution-safe runtime classifier (see Step 2.1).
export { detectAdapter } from './adapter-detect.js';
export { detectRuntime } from './adapter-detect.js';
// Concrete type re-exports for users (no ellipsis):
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

### 5.8 Verify

```bash
npm run build
npm run check:size       # Facade ≤ 3 kB
npm run check:exports    # arethetypeswrong passes for ./auto/* and root entry
npm run check:architecture
npm run check:dead-code
node --input-type=module -e "import('./dist/esm/index.node.js').then(m => console.log(Object.keys(m).sort()))"
# Expect: openRepository, detectRuntime, noopProgress, consoleProgress, plus type re-exports.
```

**Commit.** `chore: wire Phase 10 facade exports`

---

## Step 6: Mutation testing + 3× parallel reviews + merge

### 6.1 Mutation testing

```
mutate: [
  "src/repository.ts",
  "src/adapter-detect.ts",
  "src/progress.ts",
  "src/dispose-adapters.ts",
  "src/index.node.ts",
  "src/index.browser.ts",
  "src/index.default.ts",
]
```

Targets per design §9.2:

| Module | Score |
|---|---|
| `adapter-detect.ts` | ≥ 95% |
| `progress.ts` | ≥ 95% |
| `repository.ts` | ≥ 90% |
| `dispose-adapters.ts` | ≥ 95% |

### 6.2 Parallel reviews

3 parallel agents:
1. **`code-reviewer`** — quality, idiomatic TypeScript.
2. **`security-reviewer`** — adapter validator wrapping, deep-freeze, prototype-pollution defense, dispose-related TOCTOU.
3. **`test-review`** — mutation resistance for the binding logic, fixture reuse with Phase 9.

Address all CRITICAL + HIGH findings before merge.

### 6.3 Documentation updates

- `README.md` — add a top-level "Quick start" section with `openRepository` example.
- `docs/design/repository-facade.md` — promote Status from `Draft` to `Implemented (<YYYY-MM-DD>)`. Add Round 4 review notes (mutation score, surprises).

### 6.4 Merge

- Squash-merge the implementation branch into main.
- Squash commit message: `feat: add phase 10 — repository facade`.
- Delete the implementation branch.
- Update `docs/BACKLOG.md`: items 10.1–10.3 from `[ ]` → `[x]`. Bump the Progress line: `Phases 0–10 complete. Phase 11 (Polish & Launch) is next.`

**Final commit.** Squash message above.

---

## Dependency Graph

| Step | Prerequisites | Could parallel with |
|---|---|---|
| 0 (engines + errors + disposeAdapters) | none — Phase 9 already on main | — |
| 1 (progress.ts) | 0 (sanitize helper from Phase 9 already exists) | 2 |
| 2 (adapter-detect + shims) | 0 | 1 |
| 3 (repository.ts) | 1, 2, 0 | — |
| 4 (progress wiring in commands) | 3 | — |
| 5 (wiring) | 2, 3 | — |
| 6 (mutation + reviews + merge) | all prior | — |

**Critical path:** `0 → 2 → 3 → 4 → 5 → 6` (6 hops).

**Sequential implementation order:** `0 → 1 → 2.1 → 2.2 → 3.1 → 3.2 → 3.3 → 3.4 → 3.5 → 3.6 → 3.7 → 4.1 → 4.2 → 5 → 6`.

---

## Post-Plan — next phase

Merge of `feat/phase-10-facade` to main starts Phase 11 (Polish & Launch):

- Benchmark suite (log, readBlob, status, clone vs isomorphic-git).
- Cross-platform E2E tests (Ubuntu, macOS, Windows × Node 20.3 / 22).
- Browser E2E tests (Chrome, Firefox, Safari via Playwright).
- TypeDoc API documentation.
- npm publish dry run, verify with arethetypeswrong.
- GitHub repo setup (branch protection, secrets, gh-pages).
- v1.0.0 release.

The Phase 11 design lands on main BEFORE its implementation branch is opened (Phase 6/7/8/9/10 precedent).
