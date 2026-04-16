# Plan: Phase 4 — Ports & Adapters

Implements [design/ports-and-adapters.md](../design/ports-and-adapters.md).
Covers [backlog](../BACKLOG.md) items 4.1–4.9.
Incorporates [ADR-004](../adr/004-adapter-error-in-domain.md).

### Backlog → Step Mapping

| Backlog Item | Description | Steps |
|---|---|---|
| **4.1** | `FileSystem` port interface | 1 |
| **4.2** | `HttpTransport` port interface | 4 |
| **4.3** | `HashService` port interface | 2 |
| **4.4** | `Compressor` port interface | 3 |
| **4.5** | `ProgressReporter` port interface | 5 |
| **4.6** | `Context` type | 6 |
| **4.7** | Node adapter | 11 |
| **4.8** | Browser adapter | 12 |
| **4.9** | Memory adapter | 10 |
| — | Error types (AdapterError in domain) | 0 |
| — | Contract test suites | 7, 8, 9 |
| — | Barrel exports + validation | 13 |

---

## Workflow

Each step follows TDD: write test (red) → implement (green) → refactor.
After every green step run: `npm run check:types && npm run test:unit && npm run check:architecture`

**Commit strategy:** One commit per completed step. Message format: `feat(ports): add <module>`, `feat(adapters): add <module>`, `feat(domain): extend error union with AdapterError`. Feature branch with worktree — never commit to main.

## Prerequisites (before step 0)

1. Directories already exist: `src/ports/`, `src/adapters/{node,browser,memory}/`
2. **Coverage config currently only includes `src/domain/**/*.ts`** (vitest.config.ts:23) — Step 0 must extend this to include `src/ports/**/*.ts` and `src/adapters/**/*.ts`
3. Existing dependency-cruiser rule enforces `domain/ ✗→ ports|adapters` and `ports/ ✗→ adapters/`
4. Add new dependency-cruiser rule `ports-cannot-import-application` (step 0)
5. Update `cspell.json` as needed for new terms (OPFS, realpath, basename, etc.)
6. **`package.json` already has `./adapters/{node,browser,memory}` exports** (already populated — verify in Step 13)
7. **Rollup config already produces CJS + ESM for adapter entry points** — verify in Step 13
8. **`@types/node` must be installed as devDependency** — verify `package.json` has it. Phase 1–3 domain code has zero `node:` imports (hexagonal architecture preserves this), so this is the first phase where Node type definitions are required. Without it, Step 11 Node adapter (`node:fs/promises`, `node:crypto`, `node:zlib`, `node:http`) will fail `npm run check:types`.
9. **Browser adapter type strategy** — tsconfig.json currently has `"lib": ["ES2022"]` with no DOM. Step 12 will require one of:
   - Add `"DOM"` to lib globally (widens project-wide globals — may conflict with Node types in Node adapter)
   - Add `/// <reference lib="dom" />` triple-slash references to each browser adapter source file only
   - Declare local ambient types (`declare global` block) for `FileSystemDirectoryHandle`, `FileSystemFileHandle`, `FileSystemSyncAccessHandle` in `src/adapters/browser/browser-types.d.ts`
   **Recommended:** triple-slash `/// <reference lib="dom" />` per-file — localizes DOM types to browser adapter only. Document choice in Step 12.

## File Conventions

- Source: `src/ports/*.ts`, `src/adapters/{node,browser,memory}/*.ts`
- Tests: `test/unit/ports/*.ts`, `test/unit/adapters/{node,browser,memory}/*.ts`
- Contract tests: `test/unit/ports/*.contract.ts`
- File names: kebab-case
- Import extensions: `.js`
- Test format: Given/When/Then titles, AAA body, `sut` variable
- **Import paths:**
  - Ports import domain types and error factories from `../../domain/index.js` (via barrel, not direct file path)
  - Adapters import port interfaces from `../../ports/index.js` and domain types from `../../domain/index.js`
  - Contract test files import port interfaces from `../../../src/ports/index.js`
  - Adapter tests import contract functions from `../../../ports/*.contract.js`

### Contract File Convention

Files at `test/unit/ports/*.contract.ts` are plain modules, NOT test files. Vitest picks up only `*.test.ts` files. Contract files are imported by `.test.ts` files and use `describe`/`it`/`expect` from vitest's global registry — which requires explicit imports. Each contract file has its own explicit imports — vitest globals do not propagate across files.

```typescript
// test/unit/ports/file-system.contract.ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FileSystem } from '../../../src/ports/index.js';
import { TsgitError } from '../../../src/domain/index.js';

export interface FileSystemContractEnv {
  readonly fs: FileSystem;
  readonly rootDir: string;                       // absolute root (for sibling-bypass tests)
  readonly getRootDirSibling: () => Promise<string>;  // returns a path resolving to sibling of rootDir
  readonly getExistingInRoot: () => Promise<string>;  // returns a path to a pre-created file in root (for rename-dst test)
  readonly cleanup?: () => Promise<void>;
}

export function fileSystemContractTests(
  createSut: () => Promise<FileSystemContractEnv>
): void {
  describe('FileSystem contract', () => {
    let env: FileSystemContractEnv;

    beforeEach(async () => {
      env = await createSut();
    });

    afterEach(async () => {
      await env.cleanup?.();
    });

    // ... tests access env.fs, env.rootDir, env.getRootDirSibling(), env.getExistingInRoot()
  });
}
```

All 5 `.contract.ts` files follow this pattern (imports + exported function).

## Key Design Decisions Applied

- **`AdapterError` in `domain/error.ts`** (not `ports/error.ts`) — maintains zero-exception inward dependency rule (ADR-004)
- **Port methods accept `string` paths** — not branded `FilePath` (§16.1)
- **Incremental hashing via `Hasher`** — avoids buffer concatenation for header+content
- **Context threaded through all operations** — no per-function DI
- **Memory adapter is first-class** — primary test adapter with defensive copying
- **Path containment enforced in contract** — realpath + startsWith(root + '/')
- **Security-critical behaviors in contract tests** — not separate

---

## Step 0: Prerequisites & Error Types

**Modify:** `src/domain/error.ts` (add `AdapterError` union + factories + `basename` helper)
**Modify:** `src/domain/index.ts` (export new factories)
**Modify:** Four existing exhaustiveness tests (add AdapterError codes):
- `test/unit/domain/objects/error.test.ts` (lines 146-167)
- `test/unit/domain/storage/error.test.ts` (lines 80-101)
- `test/unit/domain/refs/error.test.ts` (lines 55-76)
- `test/unit/domain/git-index/error.test.ts` (lines 59-80)
**Modify:** `.dependency-cruiser.cjs` (add `ports-cannot-import-application` rule)
**Modify:** `cspell.json` (add new terms)
**Create:** `test/unit/domain/error.test.ts` (AdapterError tests)

### ADR-004 Note: Why AdapterError Lives in `domain/error.ts` Directly

Unlike Phase 2/3 sub-errors (`domain/storage/error.ts`, `domain/refs/error.ts`, `domain/git-index/error.ts`), `AdapterError` is defined directly in `domain/error.ts`. Rationale: there is no `domain/adapter/` submodule — adapters belong to `src/adapters/`, not domain. Error codes describe a contract (what can go wrong at the boundary); contracts belong to the domain. Ports and adapters import error types from domain.

### Actions:

1. Extend `src/domain/error.ts` — **IMPORTANT: atomic commit** (all-or-nothing to avoid transient broken builds):
   - **Step 1a (safe refactor, can commit alone):** Add `default: { const _exhaustive: never = data; return String(_exhaustive); }` to the current `extractDetail` switch. With the existing 15 cases, `data` narrows to `never` at the default branch — TypeScript accepts this as a no-op refactor. `noImplicitReturns` passes.
   - **Step 1b (atomic — union widening + 10 production cases + 10 test cases in ONE edit):** This is a single atomic commit that includes ALL of:
     (a) Widen `TsgitErrorData` to include `AdapterError`
     (b) Add all 10 switch cases to `extractDetail` in `src/domain/error.ts`
     (c) Append 10 new case labels to EACH of the 4 existing exhaustiveness test switches (`objects/`, `storage/`, `refs/`, `git-index/`) — these tests also have `default: { const _exhaustive: never = data; ... }` patterns that break when `data` narrows to 10 un-handled variants.
     Doing ANY subset of (a)/(b)/(c) alone leaves the build red between commits. Sub-Action 3 below describes (c) in detail — both must be in the same commit as Step 1b.
   - Add `AdapterError` discriminated union (10 variants per design §8.1)
   - Add factory functions: `fileNotFound(path)`, `fileExists(path)`, `notADirectory(path)`, `permissionDenied(path)`, `unsupportedOperation(operation, reason)`, `hashFailed(reason)`, `compressFailed(reason)`, `decompressFailed(reason)`, `httpError(statusCode, reason)`, `networkError(reason)`
   - Add `basename(path: string): string` helper:
     ```typescript
     function basename(path: string): string {
       const segments = path.split(/[/\\]/);
       for (let i = segments.length - 1; i >= 0; i--) {
         if (segments[i] !== '') return segments[i];
       }
       return path;
     }
     ```
   - Widen `TsgitErrorData` to include `AdapterError`
   - Extend `extractDetail` switch with the 10 new cases per design §8.2:
     - `FILE_NOT_FOUND`: `'file not found: ' + basename(data.path)`
     - `FILE_EXISTS`: `'file already exists: ' + basename(data.path)`
     - `NOT_A_DIRECTORY`: `'not a directory: ' + basename(data.path)`
     - `PERMISSION_DENIED`: `'permission denied: ' + basename(data.path)`
     - `UNSUPPORTED_OPERATION`: `'unsupported operation: ' + data.operation + ': ' + data.reason`
     - `HASH_FAILED`: `'hash computation failed: ' + data.reason`
     - `COMPRESS_FAILED`: `'compression failed: ' + data.reason`
     - `DECOMPRESS_FAILED`: `'decompression failed: ' + data.reason`
     - `HTTP_ERROR`: `'HTTP ' + data.statusCode + ': ' + data.reason`
     - `NETWORK_ERROR`: `'network error: ' + data.reason`
   - (The `default` branch is already added in Step 1a above.)

2. Update `src/domain/index.ts`:
   - **Current state (verified):** `TsgitError` IS already transitively exported via `src/domain/objects/error.ts` line 3 (`export { TsgitError } from '../error.js'`) → `src/domain/objects/index.ts` → `src/domain/index.ts` via `export * from './objects/index.js'`. **Do NOT add another `export { TsgitError }` in `domain/index.ts` — it would cause a duplicate export error.** Contract tests can import `TsgitError` from `../../../src/domain/index.js` with no changes.
   - Export the 10 new factory functions by name (direct `export { fileNotFound, fileExists, ... } from './error.js'`).
   - **Do NOT export `basename`** from the barrel. `basename` is an internal helper — the basename unit tests import it directly from the submodule: `import { basename } from '../../../src/domain/error.js'` (bypassing the barrel). This keeps `basename` truly internal to the domain — no `stripInternal` gymnastics needed and no name-clash risk for consumers using `import * as tsgit`.

3. Update the 4 existing exhaustiveness tests — **convert single-sut tests to array-iteration pattern** so new branches are actually executed (prevents dead-code mutants):
   - `test/unit/domain/objects/error.test.ts` (line 131): title `'Then all cases are handleable'`, already iterates `errors` array. Action: append 10 AdapterError factory-constructed errors to the array (lines 133-141) AND append 10 case labels to the switch (lines 147-161). Title unchanged.
   - `test/unit/domain/storage/error.test.ts` (line 74): currently single-sut switch. **Convert to array iteration:** change title to `'Then all 25 cases handleable'`, replace single `sut` with an `errors: ReadonlyArray<TsgitError>` array containing one factory call per case (25 total — 15 existing + 10 new), and wrap switch in `for (const error of errors) { const data = error.data; switch (data.code) { ... } }`. Without iteration, new case labels are dead code.
   - `test/unit/domain/refs/error.test.ts` (line 49): same conversion as storage.
   - `test/unit/domain/git-index/error.test.ts` (line 53): same conversion as storage.
   - The 10 new case labels to append in every switch: `'FILE_NOT_FOUND'`, `'FILE_EXISTS'`, `'NOT_A_DIRECTORY'`, `'PERMISSION_DENIED'`, `'UNSUPPORTED_OPERATION'`, `'HASH_FAILED'`, `'COMPRESS_FAILED'`, `'DECOMPRESS_FAILED'`, `'HTTP_ERROR'`, `'NETWORK_ERROR'`.

4. Update `.dependency-cruiser.cjs` — add expanded rule (per Round 3 L10):
   ```javascript
   {
     name: 'ports-cannot-import-application',
     comment: 'Port interfaces must not depend on application, operators, transport, or repository',
     severity: 'error',
     from: { path: '^src/ports/' },
     to: { path: '^src/(application|operators|transport|repository\\.ts)' },
   }
   ```

5. Update `cspell.json` — add terms: `OPFS`, `realpath`, `basename`, `EEXIST`, `ENOTDIR`, `ECONNREFUSED`, `ETIMEDOUT`, `ENOTFOUND`, `EACCES`, `EPERM`, `ELOOP`, `EMFILE`, `ctimeMs`, `mtimeMs`, `ctimeNs`, `mtimeNs`, `deflateSync`, `inflateSync`, `lstat`, `TOCTOU`, `SSRF`, `subarray`, `mktemp`, `Readable`, `SubtleCrypto`, `checkContainment`, `realpathNearestExisting`, `stripInternal`. Scan plan + design files for any remaining unfamiliar terms before committing.

6. Update `vitest.config.ts`:
   - Change coverage `include` from `['src/domain/**/*.ts']` to:
     ```typescript
     include: [
       'src/domain/**/*.ts',
       'src/ports/**/*.ts',
       'src/adapters/node/**/*.ts',
       'src/adapters/memory/**/*.ts',
     ],
     ```
     **Critically, `src/adapters/browser/**/*.ts` is EXCLUDED from coverage** — browser adapter is type-check only in Phase 4 (runtime tests deferred to Phase 11 Playwright). Including it would force 0% coverage on existing browser files, failing the 100% threshold.
   - The existing `exclude: ['src/**/index.ts', 'src/**/*.d.ts']` already covers all new barrel files (`src/ports/index.ts`, `src/adapters/{node,memory}/index.ts`, etc.) — no changes needed to `exclude`.
   - Verify test `include` glob `test/unit/**/*.test.ts` does NOT pick up `.contract.ts` files (correct — they're imported, not run directly).

7. Create `test/unit/domain/error.test.ts`:
   - Imports (note: `basename` imported directly from submodule, others from barrel):
     ```typescript
     import { fileNotFound, fileExists, notADirectory, permissionDenied,
              unsupportedOperation, hashFailed, compressFailed, decompressFailed,
              httpError, networkError, TsgitError } from '../../../src/domain/index.js';
     import { basename } from '../../../src/domain/error.js';  // internal helper — direct import
     ```
   - 10 tests for each AdapterError factory: construct with data → assert `code` matches, `data` fields correct, `error.message` contains sanitized output
   - 8+ tests for `basename` helper (mutation-resistant set — each tests a different structural aspect):
     - Empty path `''` → returns `''`
     - Root-only `/` → returns `/` (fallback)
     - Multi-root `//` → returns `/` (fallback)
     - Single segment `'foo'` → returns `'foo'`
     - Unix path `'/a/b/c.txt'` → returns `'c.txt'`
     - Windows path `'C:\\a\\b\\c.txt'` → returns `'c.txt'`
     - Mixed separators `'/a\\b/c.txt'` → returns `'c.txt'`
     - Trailing slash `'/a/b/'` → returns `'b'`
     - Trailing backslash `'C:\\a\\b\\'` → returns `'b'`
   - 4 path-sanitization tests (one per path-bearing code `FILE_NOT_FOUND`, `FILE_EXISTS`, `NOT_A_DIRECTORY`, `PERMISSION_DENIED`): construct with absolute path `'/etc/passwd/secret.txt'`, assert `error.message` contains `'secret.txt'` only (NOT full path), assert `error.data.path === '/etc/passwd/secret.txt'` (full path preserved for programmatic access)

### Verify:

```bash
npm run check:types && npm run test:unit && npm run check:architecture
```

---

## Step 1: `FileSystem` Port Interface

**Create:** `src/ports/file-system.ts`
**Test:** Compilation only

### Types to define:

- `FileStat` — all 13 fields per design §4.1 (including optional `ctimeNs`/`mtimeNs` bigints)
- `DirEntry` — 4 fields per design §4.1
- `FileSystem` interface — 16 methods per design §4.1:
  - `read`, `readSlice`, `readUtf8`
  - `write`, `writeExclusive`, `writeUtf8`
  - `exists`, `stat`, `lstat`, `readdir`, `mkdir`, `rm`, `rename`
  - `readlink`, `symlink`, `chmod`

No runtime logic. Contract behavior tested in step 7 via contract tests.

---

## Step 2: `HashService` Port Interface

**Create:** `src/ports/hash-service.ts`

### Types to define:

- `Hasher` interface — 3 methods (update, digest, digestHex)
- `HashService` interface — 5 members (hash, hashHex, createHasher, algorithm, digestLength)

---

## Step 3: `Compressor` Port Interface

**Create:** `src/ports/compressor.ts`

### Types to define:

- `Compressor` interface — 3 methods (deflate, inflate, createInflateStream)

---

## Step 4: `HttpTransport` Port Interface

**Create:** `src/ports/http-transport.ts`

### Types to define:

- `HttpRequest` interface (url, method, headers, body?, signal?)
- `HttpResponse` interface (statusCode, headers — must be lowercase keys, body)
- `HttpTransport` interface — 1 method (request)

---

## Step 5: `ProgressReporter` Port Interface + No-op + Contract

**Create:** `src/ports/progress-reporter.ts`
**Create:** `test/unit/ports/progress-reporter.contract.ts`
**Test:** `test/unit/ports/progress-reporter.test.ts` (runs contract against `noopProgressReporter`)

### Types + runtime:

- `ProgressPhase` string literal union (6 values)
- `ProgressEvent` interface (phase, loaded, total?)
- `ProgressReporter` interface — 1 method (report)
- `noopProgressReporter: ProgressReporter` — const implementing no-op

### Contract function (in `.contract.ts`):

```typescript
import { describe, expect, it } from 'vitest';
import type { ProgressReporter } from '../../../src/ports/index.js';

export function progressReporterContractTests(
  createSut: () => Promise<ProgressReporter>
): void {
  describe('ProgressReporter contract', () => {
    it('Given progress event, When report, Then does not throw', async () => { ... });
    it('Given 1000 sequential events, When reporting, Then all accepted without error', async () => { ... });
  });
}
```

### Test file (in `.test.ts`):

```typescript
import { progressReporterContractTests } from './progress-reporter.contract.js';
import { noopProgressReporter } from '../../src/ports/index.js';

progressReporterContractTests(async () => noopProgressReporter);
```

ProgressReporter is trivial enough that its contract lives in Step 5 alongside the port definition — no cross-step dependency.

---

## Step 6: `Context` Type

**Create:** `src/ports/context.ts`
**Test:** `test/unit/ports/context.test.ts`

### Types + runtime:

- `RepositoryConfig` interface (workDir, gitDir, bare)
- `Context` interface (fs, hash, compressor, transport, progress, config, signal?)
- `createContext(parts): Context` — `Object.freeze()` the assembled context

### Test:

```
Given distinct sentinel ports, When creating context, Then ctx.fs === sentinelFs (no swap)
Given distinct sentinel ports, When creating context, Then ctx.hash === sentinelHash
Given distinct sentinel ports, When creating context, Then ctx.compressor === sentinelCompressor
Given distinct sentinel ports, When creating context, Then ctx.transport === sentinelTransport
Given distinct sentinel ports, When creating context, Then ctx.progress === sentinelProgress
Given config, When reading ctx.config, Then all fields match input
Given created context, When attempting mutation (Object.assign(ctx, {...})), Then throws (frozen)
Given context with signal, When reading ctx.signal, Then correct AbortSignal returned
Given context without signal, When reading ctx.signal, Then undefined
```

Each port-wiring test uses a distinct sentinel (dummy object) per port so that a mutant swapping two fields is caught (e.g., if `fs` and `compressor` are accidentally swapped in the factory).

---

## Step 7: FileSystem Contract Tests

**Create:** `test/unit/ports/file-system.contract.ts`

Exports a function `fileSystemContractTests(createFs, cleanup?)` that runs all 37 tests from design §15.2:

### Basic I/O (tests 1-9, 12-17, 26-28):
- Read/write roundtrip (bytes + UTF-8)
- FILE_NOT_FOUND on missing paths
- Exists true/false
- Stat size, isFile, isDirectory
- Write creates parent dirs, overwrites
- Empty file creation
- rm removes, throws FILE_NOT_FOUND
- Rename moves file, atomically replaces target
- readdir lists, empty dir returns [], non-dir throws NOT_A_DIRECTORY. **Empty-dir test MUST create a fresh subdirectory via `fs.mkdir('/repo/fresh-empty')` then call `fs.readdir('/repo/fresh-empty')` → `[]`** — do NOT readdir the root, because the wrapper pre-seeds `existing.txt` there.

### Security matrix (tests 10-11, 36 — EXPANDED via parameterized helper):

Design §15.2 lists 3 representative tests; the contract MUST iterate over all path-accepting methods to catch mutants that skip containment in a single method.

**Parameterized approach — define once, run for every method:**

```typescript
// Inside fileSystemContractTests, inside describe('FileSystem contract', ...):
// env provides fs, rootDir, getRootDirSibling, getExistingInRoot, cleanup (FileSystemContractEnv).

// Define all path-accepting call sites with their invocation patterns.
// For rename, we use env.getExistingInRoot() to get a valid in-root path for the
// parameter that is NOT being tested — ensuring the CONTAINMENT FAILURE we
// trigger is on the parameter under test, not accidentally on the other one.
interface PathCall {
  readonly name: string;
  readonly invoke: (env: FileSystemContractEnv, path: string) => Promise<unknown>;
}

const pathCalls: ReadonlyArray<PathCall> = [
  { name: 'read',           invoke: (e, p) => e.fs.read(p) },
  { name: 'readSlice',      invoke: (e, p) => e.fs.readSlice(p, 0, 1) },
  { name: 'readUtf8',       invoke: (e, p) => e.fs.readUtf8(p) },
  { name: 'write',          invoke: (e, p) => e.fs.write(p, new Uint8Array()) },
  { name: 'writeExclusive', invoke: (e, p) => e.fs.writeExclusive(p, new Uint8Array()) },
  { name: 'writeUtf8',      invoke: (e, p) => e.fs.writeUtf8(p, '') },
  { name: 'exists',         invoke: (e, p) => e.fs.exists(p) },
  { name: 'stat',           invoke: (e, p) => e.fs.stat(p) },
  { name: 'lstat',          invoke: (e, p) => e.fs.lstat(p) },
  { name: 'readdir',        invoke: (e, p) => e.fs.readdir(p) },
  { name: 'mkdir',          invoke: (e, p) => e.fs.mkdir(p) },
  { name: 'rm',             invoke: (e, p) => e.fs.rm(p) },
  { name: 'rename-src',     invoke: async (e, p) => {
      const validDst = await e.getExistingInRoot();  // valid in-root path for dst
      return e.fs.rename(p, validDst + '-renamed');
  } },
  { name: 'rename-dst',     invoke: async (e, p) => {
      const validSrc = await e.getExistingInRoot();  // valid in-root source file
      return e.fs.rename(validSrc, p);
  } },
  { name: 'readlink',       invoke: (e, p) => e.fs.readlink(p) },
  { name: 'symlink',        invoke: (e, p) => e.fs.symlink('target', p) },
  { name: 'chmod',          invoke: (e, p) => e.fs.chmod(p, 0o644) },
];

for (const { name, invoke } of pathCalls) {
  it(`Given ${name} with .. traversal escaping root, Then throws PERMISSION_DENIED`, async () => {
    try {
      await invoke(env, '../outside-root');
      expect.fail('expected PERMISSION_DENIED');
    } catch (err) {
      expect(err).toBeInstanceOf(TsgitError);
      expect((err as TsgitError).data.code).toBe('PERMISSION_DENIED');
    }
  });

  it(`Given ${name} with sibling-directory path, Then throws PERMISSION_DENIED`, async () => {
    const sibling = await env.getRootDirSibling();
    try {
      await invoke(env, sibling);
      expect.fail('expected PERMISSION_DENIED');
    } catch (err) {
      expect(err).toBeInstanceOf(TsgitError);
      expect((err as TsgitError).data.code).toBe('PERMISSION_DENIED');
    }
  });
}
```

This produces **34 security tests** (17 methods × 2 bypass variants).

**Critical for rename-dst correctness:** Both `rename-src` and `rename-dst` use `env.getExistingInRoot()` to provide a valid in-root path for the parameter NOT being tested. Otherwise, a test like `rename('../outside', 'dst')` would fail containment on `'dst'` (which resolves to cwd-relative = usually escapes too), masking whether `'../outside'` was actually checked. This design change ensures the failure is attributable to the parameter we're testing.

**Fixtures required:**
- `getRootDirSibling(fs)` — adapter-specific helper returning an absolute path resolving to a sibling directory of `rootDir`. For Memory: constructs a path in the same normalized namespace. For Node: computes `path.dirname(rootDir) + path.basename(rootDir) + '-evil/x'`, actually creates that sibling directory on disk so `readdir`/`stat` don't fail with ENOENT before containment check.
- The helper must be part of `createSut()` return or injected separately.

**Node-only additional security tests** (in adapter-specific file, not contract):
- `Given symlink inside root pointing outside root, When read through symlink, Then throws PERMISSION_DENIED` (tests realpath resolution)
- `Given pre-existing symlink at write target, When write, Then throws PERMISSION_DENIED` (creation-mode leaf symlink check)

**Note on `exists` semantics:** Per design §4.1 and §15.2, `exists` on an escaping path throws `PERMISSION_DENIED`. It does NOT silently return `false`. The implementation uses a two-step check (resolved-string containment first, then realpath) to ensure PERMISSION_DENIED takes priority over FILE_NOT_FOUND for missing escaping paths.

**Note on methods needing pre-existing fixtures (Node adapter ONLY):**

For Node, containment uses `realpath` which requires the target to exist for read-mode methods. For Memory, containment is pure string-based (via normalized path vs `rootDir` prefix check), no fixture needed — the escape is rejected BEFORE any Map lookup. The `getRootDirSibling()` helper handles this:

- **Node `getRootDirSibling()`:** returns a path to a real file created in a sibling temp dir (`rootDir + '-evil/file.txt'`). Required so that `realpath` can resolve the path before containment check rejects it.
- **Memory `getRootDirSibling()`:** returns any string matching the escape pattern (e.g., `'/repo-evil/x'`). String-check rejects before Map lookup.

Methods like `readSlice`, `read`, `stat`, `readdir`, `rm`, `readlink` on Node need the sibling to exist. On Memory, string containment always rejects first.

For `exists`: the two-step impl (string check THEN realpath) ensures escaping paths throw `PERMISSION_DENIED` without needing them to exist. This is consistent across adapters.

### Exclusive write (tests 19-20):
- `writeExclusive` on existing file → FILE_EXISTS
- `writeExclusive` on non-existent → creates file

### Random access (tests 21-25, 32-34):
- `readSlice(0, 3)` → first 3 bytes
- `readSlice(5, 3)` → bytes at offset 5
- `readSlice(offset === fileSize, 5)` → empty array (boundary)
- `readSlice(offset > fileSize, 5)` → empty array (past EOF)
- `readSlice(-1, 5)` → throws `PERMISSION_DENIED` (per design §4.1 — unusual but explicit)
- `readSlice(0, -1)` → throws `PERMISSION_DENIED`
- `readSlice` on missing file → FILE_NOT_FOUND
- `readSlice(8, 5)` on 10-byte file → 2 bytes (partial at EOF)
- `readSlice(0, 0)` → empty array
- `readSlice(5, 0)` → empty array (zero length at valid offset)

### Directory & special (tests 29-31, 35, 37, 38):
- mkdir on existing file path → throws
- Symlink: lstat detects, stat follows
- writeUtf8 creates parent dirs
- rm on non-empty directory → throws
- **Permissive symlink target documentation:** `Given symlink(target='../../../escape', path=valid-in-root)`, Then SUCCEEDS (port does NOT validate target). This test explicitly documents the security contract: `symlink` targets are NOT validated at the port level — app-layer (Phase 9 checkout) MUST validate. A future implementer adding target validation would break this test, forcing them to read the comment explaining why the port is intentionally permissive.

**Shared test infrastructure:** see the "Contract File Convention" section earlier for the authoritative signature (`FileSystemContractEnv` + `fileSystemContractTests`).

---

## Step 8: HashService + Compressor Contract Tests

**Create:** `test/unit/ports/hash-service.contract.ts`
**Create:** `test/unit/ports/compressor.contract.ts`

### Contract function signatures:

```typescript
// hash-service.contract.ts
export function hashServiceContractTests(
  createSut: () => Promise<HashService>
): void {
  describe('HashService contract', () => { /* 9 tests */ });
}

// compressor.contract.ts
export function compressorContractTests(
  createSut: () => Promise<Compressor>
): void {
  describe('Compressor contract', () => { /* 5 tests */ });
}
```

### HashService Contract (9 tests from design §15.2):

- Known input → expected SHA-1 digest (e.g., 'hello' → 'aaf4c61d...')
- `hashHex` → expected hex string
- Empty input → 'da39a3ee5e6b4b0d3255bfef95601890afd80709'
- Determinism: same input twice → identical
- `algorithm` is 'sha1' or 'sha256'
- `digestLength` matches algorithm (20 or 32)
- Hasher: two-part input → matches one-shot hash
- Hasher: update after digest → throws HASH_FAILED
- Hasher: digest after digest → throws HASH_FAILED

### Compressor Contract (5 tests):

- Roundtrip: data → deflate → inflate = data
- Empty data roundtrip
- Large data (64KB) roundtrip
- Corrupt data → inflate throws DECOMPRESS_FAILED
- Stream inflate via `createInflateStream` → same as one-shot inflate

---

## Step 9: HttpTransport Contract Tests

**Create:** `test/unit/ports/http-transport.contract.ts`

### Contract function signature:

```typescript
// http-transport.contract.ts
import { beforeEach, describe, expect, it } from 'vitest';
import type { HttpTransport } from '../../../src/ports/index.js';

interface MockSetup {
  readonly method: 'GET' | 'POST';
  readonly url: string;
  readonly response: { statusCode: number; headers: Record<string, string>; body: Uint8Array };
}

export function httpTransportContractTests(
  createSut: () => Promise<{
    sut: HttpTransport;
    setupMock: (mock: MockSetup) => string;  // returns the concrete URL to use
    clearMocks: () => void;
  }>
): void {
  describe('HttpTransport contract', () => {
    let sut: HttpTransport;
    let setupMock: (mock: MockSetup) => string;
    let clearMocks: () => void;

    beforeEach(async () => {
      ({ sut, setupMock, clearMocks } = await createSut());
      clearMocks();
    });

    // tests call `const url = setupMock({...})` then invoke sut.request({ url, ... })
  });
}
```

**Contract lifecycle:** `createSut` returns the adapter plus `setupMock` and `clearMocks` callbacks. The contract calls `clearMocks` in `beforeEach` to ensure per-test isolation (no handler accumulation). Each test that needs mock data calls `setupMock` before invoking the transport.

### HttpTransport Contract (3 tests):

- Mock response → correct statusCode
- Response headers → all keys lowercase (normalization contract)
- HTTP (non-HTTPS) URL on secure adapter → throws NETWORK_ERROR

(ProgressReporter contract is defined in Step 5, not here — trivial enough to live with the port.)

---

## Step 10: Memory Adapter

**Create:** `src/adapters/memory/memory-file-system.ts`
**Create:** `src/adapters/memory/memory-hash-service.ts`
**Create:** `src/adapters/memory/memory-compressor.ts`
**Create:** `src/adapters/memory/memory-http-transport.ts`
**Create:** `src/adapters/memory/memory-adapter.ts`
**Test:** `test/unit/adapters/memory/memory-file-system.test.ts` (contract + memory-specific)
**Test:** `test/unit/adapters/memory/memory-hash-service.test.ts` (contract)
**Test:** `test/unit/adapters/memory/memory-compressor.test.ts` (contract)
**Test:** `test/unit/adapters/memory/memory-http-transport.test.ts` (contract + mock)
**Test:** `test/unit/adapters/memory/memory-adapter.test.ts` (factory)

### Memory FileSystem:

**State:**
- `files: Map<string, Uint8Array>` — normalized path → bytes
- `directories: Set<string>` — normalized dir paths
- `symlinks: Map<string, string>` — path → target
- `times: Map<string, { ctimeMs: number; mtimeMs: number }>` — synthetic timestamps
- `rootDir: string` — absolute root

**No `modes` map in state.** Memory adapter's `chmod` is a true no-op (after containment check). Tracking mode would be dead code (no test observes it, would produce equivalent mutants). If future code needs mode persistence, add it then.

**Constructor signature:**
```typescript
interface MemoryFileSystemOptions {
  readonly rootDir: string;
  readonly files?: Readonly<Record<string, Uint8Array>>;
}
class MemoryFileSystem {
  constructor(options: MemoryFileSystemOptions);
}
```

`MemoryFileSystemOptions` differs from `MemoryAdapterOptions` (design §6): `MemoryAdapterOptions` is the outer factory option consumed by `createMemoryContext`; `MemoryFileSystemOptions` is the per-adapter option. `createMemoryContext` adapts between them by injecting its default `rootDir = '/repo'`.

**Pre-seeded file keys MUST be absolute paths within `rootDir`.** Keys outside `rootDir` throw `PERMISSION_DENIED` at construction time (applying the containment check eagerly).

**Constructor body:**
- Deep-clones `options.files` entries into the `files` Map: `for (const [k, v] of Object.entries(options.files ?? {})) { const norm = normalize(k); assertContained(norm); files.set(norm, v.slice()); }`
- Caller retains their input — mutations to their buffer do not affect the adapter.

**Methods:**
- **Path normalization:** Internal helper resolves `.`/`..`, strips trailing slashes, checks containment (`path === root || path.startsWith(root + '/')`)
- **Defensive copying:** `write` stores `data.slice()`, `read` returns `stored.slice()`
- **`writeExclusive`:** `if (files.has(path)) throw FILE_EXISTS; files.set(path, data.slice())`
- **`readSlice`:** Validates offset/length >= 0; returns `data.slice(offset, offset + length)`; EOF handling per contract
- **`readdir`:** Derives entries from Map key prefixes at one level of nesting
- **`mkdir`:** Adds path + all parents to directories Set
- **`rename`:** Delete + insert on all three maps (files, times, symlinks) — if any of them contains the old path, rename the entry. Missing any map (especially `symlinks`) would leave dangling entries after rename.
- **`chmod`:** Containment check first (escaping paths → PERMISSION_DENIED). For contained paths: true no-op (OPFS/memory lack permission models; tracking mode would be dead code with no observing test).
- **Symlinks:** Full support via symlinks map

### Memory HashService:

- Constructor accepts `algorithm: 'sha1' | 'sha256'` (default 'sha1')
- Runtime check `globalThis.crypto?.subtle` availability at construction → throws HASH_FAILED if missing
- `algorithm` property mirrors constructor arg
- `digestLength` is `20` for sha1, `32` for sha256
- Algorithm string for `SubtleCrypto.digest` is `'SHA-1'` or `'SHA-256'` respectively
- `hash(data)` → `new Uint8Array(await crypto.subtle.digest(algo, data))`
- `hashHex(data)` → bytes → hex via `bytesToHex` (domain helper)
- `createHasher()` → object with `chunks: Uint8Array[]`, `consumed: boolean` flag
  - `update(data)`: if `consumed`, throw `HASH_FAILED('cannot update after digest')`. Else push `data.slice()` to chunks (defensive copy).
  - `digest()`: if `consumed`, throw. **Set `consumed = true` SYNCHRONOUSLY before the `await`** — this ensures any concurrent `update()` / `digest()` calls scheduled during the await immediately see consumed state. Then concat chunks, await `crypto.subtle.digest(algo, concatenated)`, return `new Uint8Array(result)`. Order matters:
    ```typescript
    async digest(): Promise<Uint8Array> {
      if (this.consumed) throw hashFailed('cannot digest after digest');
      this.consumed = true;                       // SYNC state transition FIRST
      const concatenated = concat(this.chunks);
      const result = await crypto.subtle.digest(algo, concatenated);  // async work AFTER
      return new Uint8Array(result);
    }
    ```
  - `digestHex()`: delegate to `digest()` then hex encode.

### Memory Compressor:

- Runtime check `CompressionStream`/`DecompressionStream` availability
- `deflate(data)`: create `CompressionStream('deflate')`, pipe through, collect chunks
- `inflate(data)`: create `DecompressionStream('deflate')`, same pattern, catch errors → throw DECOMPRESS_FAILED
- `createInflateStream`: return `new DecompressionStream('deflate')` (which IS a TransformStream)

### Memory HttpTransport:

- State: `Map<string, HttpResponse>` keyed by `${method}:${url}`
- `request(req)`: look up key, throw NETWORK_ERROR if not found
- `addMockResponse(mock: MockSetup): void` — public test-setup API
- `clearMocks(): void` — clear all registered mocks (for per-test isolation)

**Port surface vs class surface:** `HttpTransport` port interface has ONLY `{ request }`. `addMockResponse` and `clearMocks` are **class-specific methods** on `MemoryHttpTransport` — they are NOT on the port interface. Production code receives the interface type `HttpTransport` and cannot call these. Test code works with the class type directly and calls them freely. This pattern is standard for test doubles.

**Header normalization at request time:** `request(req)` MUST return a response with ALL header keys lowercased — regardless of case used in `addMockResponse`. This ensures contract parity with the Node adapter (which receives pre-lowercased headers from Node's http module). Contract test #2 (`all keys lowercase`) depends on this.

### `createMemoryContext(options?)`:

```typescript
function createMemoryContext(options: MemoryAdapterOptions = {}): Context {
  const fs = new MemoryFileSystem({ rootDir: '/repo', files: options.files });
  const hash = new MemoryHashService(options.algorithm ?? 'sha1');
  const compressor = new MemoryCompressor();
  const transport = new MemoryHttpTransport();
  const progress = noopProgressReporter;
  const config: RepositoryConfig = {
    workDir: '/repo',
    gitDir: '/repo/.git',
    bare: false,
  };
  return Object.freeze({ fs, hash, compressor, transport, progress, config, signal: options.signal });
}
```

### Tests:

Each adapter test imports its contract and runs it, providing a full `FileSystemContractEnv`:
```typescript
// test/unit/adapters/memory/memory-file-system.test.ts
import { fileSystemContractTests } from '../../../ports/file-system.contract.js';

describe('MemoryFileSystem', () => {
  fileSystemContractTests(async () => {
    const fs = new MemoryFileSystem({ rootDir: '/repo' });
    // Pre-seed a file for rename-dst test
    await fs.write('/repo/existing.txt', new Uint8Array([1, 2, 3]));
    return {
      fs,
      rootDir: '/repo',
      getRootDirSibling: async () => '/repo-evil/x',  // no fixture needed — memory rejects at string check
      getExistingInRoot: async () => '/repo/existing.txt',
    };
  });

  // Memory-specific tests:
  it('Given pre-seeded files, When reading, Then returns seeded bytes');
  it('Given two memory contexts, When mutating one, Then other unaffected');
  it('Given write then mutate input buffer, When reading, Then stored bytes unchanged (defensive copy)');
  it('Given read result, When mutating, Then stored bytes unchanged (defensive copy)');
  it('Given pre-seeded file then mutate source buffer, When reading, Then seeded bytes unchanged');
});

// test/unit/adapters/memory/memory-hash-service.test.ts
import { hashServiceContractTests } from '../../../ports/hash-service.contract.js';

describe('MemoryHashService', () => {
  hashServiceContractTests(async () => new MemoryHashService('sha1'));
  // Memory-specific:
  it('Given SHA-256 algorithm, When hashing, Then returns 32-byte digest');
  it('Given crypto.subtle unavailable, When constructing, Then throws HASH_FAILED');
});

// test/unit/adapters/memory/memory-compressor.test.ts
import { compressorContractTests } from '../../../ports/compressor.contract.js';

describe('MemoryCompressor', () => {
  compressorContractTests(async () => new MemoryCompressor());
});

// test/unit/adapters/memory/memory-http-transport.test.ts
import { httpTransportContractTests } from '../../../ports/http-transport.contract.js';

describe('MemoryHttpTransport', () => {
  httpTransportContractTests(async () => {
    const sut = new MemoryHttpTransport();
    return {
      sut,
      setupMock: (mock) => { sut.addMockResponse(mock); return mock.url; },  // memory uses URL as-is
      clearMocks: () => sut.clearMocks(),
    };
  });

  // Memory-specific:
  it('Given unregistered URL, When requesting, Then throws NETWORK_ERROR');
});
```

---

## Step 11: Node Adapter

**Create:** `src/adapters/node/node-file-system.ts`
**Create:** `src/adapters/node/node-hash-service.ts`
**Create:** `src/adapters/node/node-compressor.ts`
**Create:** `src/adapters/node/node-http-transport.ts`
**Create:** `src/adapters/node/node-adapter.ts`
**Test:** `test/unit/adapters/node/node-file-system.test.ts` (contract, temp dirs)
**Test:** `test/unit/adapters/node/node-hash-service.test.ts` (contract)
**Test:** `test/unit/adapters/node/node-compressor.test.ts` (contract)
**Test:** `test/unit/adapters/node/node-http-transport.test.ts` (contract + `http.createServer` fixture)
**Test:** `test/unit/adapters/node/node-adapter.test.ts` (factory)

### Node FileSystem:

**State:** `rootDir: string` (absolute, resolved)

**Path containment (`checkContainment`):**

Strategy depends on operation type:
- **Read operations** (`read`, `readSlice`, `readUtf8`, `stat`, `readdir`, `readlink`, `rm`): realpath the full path (follows symlinks), check containment on the resolved target.
- **`lstat`** (does NOT follow symlinks): realpath the parent directory, assert input path's resolved form is contained (does not follow a symlink at the leaf).
- **Creation operations** (`write`, `writeExclusive`, `writeUtf8`, `mkdir`, `symlink`, `chmod`): realpath the parent directory, append basename, check containment. ADDITIONALLY: if a symlink exists at the target leaf (detected via `lstat` on the full path, success + `isSymbolicLink === true`), reject with `PERMISSION_DENIED` — prevents writing through a pre-existing symlink that escapes root.

**Note on platform separator:** Design §4.1 writes `rootDir + '/'`. Implementation MUST use `nodePath.sep` (which is `/` on POSIX, `\` on Windows). This is a deliberate deviation from the design text — the design's `/` is a simplification; the implementation is platform-correct.

**Note on error mapping:** All errors escaping `checkContainment` MUST be `TsgitError` — never a raw Node `ErrnoException`. Map at the boundary.

**Note on path relativity (CROSS-ADAPTER CONTRACT):** All `FileSystem` port methods accept EITHER absolute paths OR paths relative to `rootDir`. Relative paths are resolved against `rootDir`, NOT against `process.cwd()`. This ensures the same input produces the same result across Node and Memory adapters. The security matrix tests pass `'../outside-root'` — this resolves to `nodePath.join(rootDir, '../outside-root')` = parent of `rootDir`, which is outside root → `PERMISSION_DENIED`.

**Helper locations (module-scope in `src/adapters/node/node-file-system.ts`, not exported):**

- `toAbsolute(path, rootDir)` — 2-line helper, used by `checkContainment` and `exists`:
  ```typescript
  function toAbsolute(path: string, rootDir: string): string {
    return nodePath.isAbsolute(path) ? path : nodePath.join(rootDir, path);
  }
  ```

- `realpathNearestExisting(absolute)` — walks UP the resolved path to find the nearest existing ancestor, then reconstructs the full path. Used by `checkContainment` for creation/lstat modes. Enables `write('a/b/c/d.txt')` where parents don't yet exist (preserving the "creates parent directories" contract) while still catching symlink escapes in any existing ancestor.
  ```typescript
  async function realpathNearestExisting(absolute: string): Promise<string> {
    const segments = absolute.split(nodePath.sep).filter(Boolean);
    for (let i = segments.length; i >= 0; i--) {
      const candidate = (nodePath.sep + segments.slice(0, i).join(nodePath.sep)) || nodePath.sep;
      try {
        const real = await fsPromises.realpath(candidate);
        const tail = segments.slice(i).join(nodePath.sep);
        return tail ? nodePath.join(real, tail) : real;
      } catch (err) {
        if (isErrnoException(err) && err.code === 'ENOENT') continue;
        throw err;
      }
    }
    return absolute;  // unreachable if root exists
  }
  ```

Both helpers are **module-private** (not exported). They are tested transitively via `checkContainment` contract tests — no separate unit tests required.

**Windows note:** `realpathNearestExisting` uses `nodePath.sep` throughout. On Windows, drive letters (`C:`) remain as the first segment after `.split('\\').filter(Boolean)`, and walking up beyond the drive root is platform-defined. Phase 4 targets POSIX first; Windows-specific edge cases are tracked for v2.

```typescript
async checkContainment(path: string, mode: 'read' | 'lstat' | 'creation'): Promise<string> {
  // Normalize to absolute path, resolving relative paths against rootDir (not CWD)
  const resolved = nodePath.resolve(toAbsolute(path, this.rootDir));

  const check = (abs: string): void => {
    if (abs !== this.rootDir && !abs.startsWith(this.rootDir + nodePath.sep)) {
      throw permissionDenied(path);
    }
  };

  try {
    let real: string;
    if (mode === 'read') {
      // READ MODE: String-containment check FIRST — rejects escaping paths with PERMISSION_DENIED
      // BEFORE realpath, so escape takes priority over FILE_NOT_FOUND. Same pattern as `exists`.
      check(resolved);
      // Then full realpath to follow symlinks and catch symlink-escape
      real = await fsPromises.realpath(resolved);
    } else if (mode === 'lstat') {
      // LSTAT MODE: do NOT follow the leaf symlink (would defeat the purpose of lstat).
      // realpath the PARENT ONLY, then reattach basename unchanged.
      const parent = await fsPromises.realpath(nodePath.dirname(resolved));
      real = nodePath.join(parent, nodePath.basename(resolved));
    } else {
      // CREATION MODE: walk up to nearest existing ancestor (parents may not yet exist), reattach tail
      real = await realpathNearestExisting(resolved);

      // Reject if a pre-existing symlink at leaf would redirect writes outside root
      try {
        const leafStat = await fsPromises.lstat(real);
        if (leafStat.isSymbolicLink()) throw permissionDenied(path);
      } catch (err) {
        if (err instanceof TsgitError) throw err;
        if (!isErrnoException(err) || err.code !== 'ENOENT') {
          throw mapErrno(err, path);
        }
        // ENOENT = target doesn't exist yet — fine for creation
      }
    }
    check(real);
    return real;
  } catch (err) {
    if (err instanceof TsgitError) throw err;
    if (isErrnoException(err)) {
      if (err.code === 'ENOENT') {
        // Read mode: file/path missing → FILE_NOT_FOUND
        // lstat mode: symlink missing → FILE_NOT_FOUND
        // Creation mode: shouldn't reach here (walk-up handles missing ancestors)
        throw fileNotFound(path);
      }
      throw mapErrno(err, path);
    }
    throw err;
  }
}

// Maps Node errno to AdapterError. NEVER passes raw err.message (leaks paths).
// Unknown codes return the err.code string only (e.g., 'ELOOP', 'EMFILE'), never the full message.
function mapErrno(err: NodeJS.ErrnoException, path: string): TsgitError {
  switch (err.code) {
    case 'ENOENT': return fileNotFound(path);
    case 'EEXIST': return fileExists(path);
    case 'ENOTDIR': return notADirectory(path);
    case 'EACCES': case 'EPERM': return permissionDenied(path);
    default: return unsupportedOperation('filesystem', err.code ?? 'UNKNOWN');
  }
}
```

**Security note on `mapErrno` default:** Must NEVER pass `err.message` — raw Node errno messages include absolute file paths (e.g., `"ELOOP: too many levels of symbolic links, lstat '/etc/secret.conf'"`). Using `err.code` alone (`'ELOOP'`) contains no paths.

**Methods:**
- `read`: containment check (read mode) → `fsPromises.readFile(path)`
- `readSlice`: validate offset/length >= 0 → open → allocate via `Buffer.alloc(length)` (zero-initialized; NOT `allocUnsafe` which could leak other process memory on partial reads) → `fileHandle.read(buffer, 0, length, offset)` in try/finally (closes handle even on abort) → return `Uint8Array.from(buffer.subarray(0, bytesRead))` (defensive COPY so caller cannot access unread-buffer bytes via `.buffer`)
- `readUtf8`: containment → `readFile(path, 'utf-8')`
- `write`: containment (creation) → `mkdir -p` parent → `writeFile(path, data)`
- `writeExclusive`: containment (creation) → `mkdir -p` parent (matches `write` pattern, avoiding ENOENT TOCTOU) → `writeFile(path, data, { flag: 'wx' })`. On EEXIST → FILE_EXISTS. On ENOTDIR (parent exists as a file) → propagate as `NOT_A_DIRECTORY`.
- `writeUtf8`: same as write but utf-8
- `exists`: **Two-step check to prevent FILE_NOT_FOUND masking PERMISSION_DENIED**:
  1. First: resolved-string containment check (no realpath, no file access). Rejects escaping paths WITHOUT needing them to exist.
  2. Second: if contained, check if file exists via full realpath + access. Returns true/false.
  ```typescript
  async exists(path: string): Promise<boolean> {
    // Normalize relative paths against rootDir (not CWD) — consistent with checkContainment
    const absolute = toAbsolute(path, this.rootDir);
    const resolved = nodePath.resolve(absolute);

    // Cheap string containment check — rejects escapes BEFORE any filesystem access.
    // This takes priority over FILE_NOT_FOUND for missing escaping paths.
    if (resolved !== this.rootDir && !resolved.startsWith(this.rootDir + nodePath.sep)) {
      throw permissionDenied(path);
    }
    // Path claims to be within root. Verify file exists AND check for symlink escape.
    try {
      const real = await fsPromises.realpath(resolved);
      if (real !== this.rootDir && !real.startsWith(this.rootDir + nodePath.sep)) {
        throw permissionDenied(path);  // symlink target escapes
      }
      return true;
    } catch (err) {
      if (err instanceof TsgitError) throw err;
      if (isErrnoException(err) && err.code === 'ENOENT') return false;
      throw mapErrno(err, path);
    }
  }
  ```
  This pattern ensures escape-and-missing paths throw `PERMISSION_DENIED` (per contract test 10/11 for `exists`), while contained-but-missing paths return `false` (per contract test 5).
- `stat`: containment → `stat(path, { bigint: true })` → map to FileStat with ctimeNs/mtimeNs
- `lstat`: similar but uses `lstat` and does NOT do realpath (returns stats of symlink itself). Still checks input path containment.
- `readdir`: containment → `readdir(path, { withFileTypes: true })` → map to DirEntry
- `mkdir`: containment (creation) → `mkdir(path, { recursive: true })`
- `rm`: containment → `rm(path)` (no recursive flag, throws on non-empty dir)
- `rename`: `checkContainment(src, 'read')` (src must exist — if not, FILE_NOT_FOUND) → `checkContainment(dst, 'creation')` (dst need not exist, but its parent must be inside root; also catches pre-existing symlink at dst leaf) → `fsPromises.rename(src, dst)`. Check src FIRST so that escaping src throws PERMISSION_DENIED before any dst work. **Note:** `checkContainment`'s returned path is used ONLY for the containment check — `fs.rename` receives the ORIGINAL src/dst arguments, so renaming a symlink renames the link itself (standard POSIX semantics), not its realpath target.
- `readlink`: containment → `readlink(path)`
- `symlink`: containment on path (creation) → `mkdir -p` parent → `symlink(target, path)` (target NOT validated — app-layer responsibility)
- `chmod`: containment → `chmod(path, mode)`

**Error mapping:** `ENOENT` → FILE_NOT_FOUND, `EEXIST` → FILE_EXISTS, `ENOTDIR` → NOT_A_DIRECTORY, `EACCES`/`EPERM` → PERMISSION_DENIED

### Node HashService:

- `hash(data)`: `Promise.resolve(crypto.createHash(algorithm).update(data).digest())` → `new Uint8Array(buffer)`
- `hashHex(data)`: same but `.digest('hex')` → `Promise.resolve(hex)`
- `createHasher()`: Wraps `crypto.createHash(algorithm)` with consumed tracking. `update` sync. `digest`/`digestHex` wrapped in `Promise.resolve()`.

### Node Compressor:

- `deflate(data)`: `Promise.resolve(new Uint8Array(zlib.deflateSync(data)))`
- `inflate(data)`: try `Promise.resolve(new Uint8Array(zlib.inflateSync(data)))` catch → DECOMPRESS_FAILED
- `createInflateStream()`: `Readable.toWeb` composition — wrap `zlib.createInflate()` as TransformStream

### Node HttpTransport:

- Constructor accepts `allowInsecureHttp: boolean`
- `request(req)`:
  1. Parse URL, check protocol (reject `http:` if !allowInsecureHttp → NETWORK_ERROR `'HTTPS required — set allowInsecureHttp to allow plaintext HTTP'`)
  2. Use `node:https` (or `node:http` if allowInsecureHttp)
  3. MUST NOT set `rejectUnauthorized: false`
  4. Forward `req.signal` for abort
  5. Sanitize errors: `ENOTFOUND` → 'DNS resolution failed', `ECONNREFUSED` → 'Connection refused', `ETIMEDOUT` → 'Connection timed out'
  6. Response: lowercase all header keys, body as `ReadableStream<Uint8Array>` via `Readable.toWeb()`

### `createNodeContext(options)`:

```typescript
function createNodeContext(options: NodeAdapterOptions): Context {
  const workDir = nodePath.resolve(options.workDir);
  const gitDir = options.gitDir ? nodePath.resolve(options.gitDir) : nodePath.join(workDir, '.git');
  const fs = new NodeFileSystem(workDir);
  // ... wire all ports
  return Object.freeze({ ... });
}
```

### Tests:

Node adapter tests use temp directories via `fs.mkdtemp(os.tmpdir() + '/tsgit-')`. Contract tests run against real FS.

### Node FS contract test wrapper

```typescript
// test/unit/adapters/node/node-file-system.test.ts
describe('NodeFileSystem', () => {
  fileSystemContractTests(async () => {
    const rootDir = await fsPromises.mkdtemp(nodePath.join(os.tmpdir(), 'tsgit-'));
    const siblingDir = rootDir + '-evil';
    await fsPromises.mkdir(siblingDir, { recursive: true });
    await fsPromises.writeFile(nodePath.join(siblingDir, 'file.txt'), '');
    const existingFile = nodePath.join(rootDir, 'existing.txt');
    await fsPromises.writeFile(existingFile, Buffer.from([1, 2, 3]));

    const fs = new NodeFileSystem(rootDir);
    return {
      fs,
      rootDir,
      getRootDirSibling: async () => nodePath.join(siblingDir, 'file.txt'),
      getExistingInRoot: async () => existingFile,
      cleanup: async () => {
        await fsPromises.rm(rootDir, { recursive: true, force: true });
        await fsPromises.rm(siblingDir, { recursive: true, force: true });
      },
    };
  });
```

For path containment tests requiring symlinks outside root:
- Create sibling temp dir (done above)
- Create symlink inside root pointing to sibling
- Assert operations through symlink throw PERMISSION_DENIED
- Pre-existing symlink at write target: create symlink, then attempt `write` → PERMISSION_DENIED

**Node HttpTransport tests** use a local `http.createServer()` fixture with per-test handler reset:

```typescript
describe('NodeHttpTransport', () => {
  let server: http.Server;
  let port: number;
  let handlers: Map<string, MockHandler>;  // key: `${method} ${pathname}`

  beforeAll(async () => {
    handlers = new Map();
    server = http.createServer((req, res) => {
      const key = `${req.method} ${new URL(req.url ?? '/', 'http://localhost').pathname}`;
      const handler = handlers.get(key);
      if (handler) { handler(req, res); } else { res.statusCode = 404; res.end(); }
    });
    await new Promise<void>(r => server.listen(0, () => {
      port = (server.address() as AddressInfo).port;
      r();
    }));
  });

  afterAll(async () => { await new Promise(r => server.close(r)); });

  httpTransportContractTests(async () => {
    const sut = new NodeHttpTransport({ allowInsecureHttp: true });  // allow http: for local testing
    return {
      sut,
      setupMock: (mock) => {
        // Rewrite mock URL to inject the dynamic port
        const url = new URL(mock.url);
        const key = `${mock.method} ${url.pathname}`;
        handlers.set(key, (req, res) => {
          res.statusCode = mock.response.statusCode;
          for (const [k, v] of Object.entries(mock.response.headers)) res.setHeader(k, v);
          res.end(Buffer.from(mock.response.body));
        });
        // Return the rewritten URL for the test to use
        return `http://localhost:${port}${url.pathname}`;
      },
      clearMocks: () => handlers.clear(),
    };
  });

  // Node-specific:
  it('Given http:// URL with allowInsecureHttp=false, When requesting, Then throws NETWORK_ERROR');
  it('Given ENOTFOUND, When requesting, Then NETWORK_ERROR reason is sanitized (no hostname leak)');
  it('Given ECONNREFUSED, When requesting, Then NETWORK_ERROR reason is "Connection refused"');
});
```

**Contract `setupMock` contract:** Returns the concrete URL to use (since Memory adapter uses URLs as-is, but Node must inject a dynamic port). Memory's `setupMock` simply returns `mock.url` unchanged; Node rewrites with the ephemeral port.

**Isolation:** `clearMocks` is called in `beforeEach` inside the contract function. This prevents handlers from accumulating between tests.

---

## Step 12: Browser Adapter

**Create:** `src/adapters/browser/browser-file-system.ts`
**Create:** `src/adapters/browser/browser-hash-service.ts`
**Create:** `src/adapters/browser/browser-compressor.ts`
**Create:** `src/adapters/browser/browser-http-transport.ts`
**Create:** `src/adapters/browser/browser-adapter.ts`
**Test:** Type-check only. Runtime E2E deferred to Phase 11 (Playwright).

### DOM types strategy:

Each browser adapter source file starts with:
```typescript
/// <reference lib="dom" />
```
This localizes DOM types (`FileSystemDirectoryHandle`, `CompressionStream`, `fetch`, `crypto.subtle`) to browser adapter files without widening project-wide globals. Prevents DOM types from polluting Node adapter source files (where accidentally using `Blob` instead of `Buffer` would be a bug that we want the type system to catch).

### Implementation:

- **FileSystem:** OPFS via `FileSystemDirectoryHandle` passed as `rootHandle` option
  - Path resolution walks nested directory handles; containment is enforced by path normalization (rejecting `..` that escape the rootHandle namespace)
  - All path-accepting methods MUST check containment BEFORE their operation (even no-ops like `chmod`)
  - `readSlice` uses `Blob.slice(offset, offset + length).arrayBuffer()`
  - `writeExclusive` uses two-step existence check (getFileHandle with create:false then create:true)
  - Symlink ops throw UNSUPPORTED_OPERATION
  - `chmod` validates containment (escape → PERMISSION_DENIED), then no-op (OPFS has no permission model)
- **HashService:** `crypto.subtle.digest('SHA-1'/'SHA-256')`, accumulate-then-digest Hasher
- **Compressor:** CompressionStream/DecompressionStream
- **HttpTransport:** `fetch()` with signal, lowercase headers from `Headers` iteration

### No runtime tests:

Type-check only. Full testing via Playwright in Phase 11.

### Verify:

```bash
npm run check:types   # Must compile — no runtime tests
```

---

## Step 13: Barrel Exports & Final Verification

**Create:** `src/ports/index.ts` (replaces `export {}`)
**Modify:** `src/adapters/index.ts`, `src/adapters/{node,browser,memory}/index.ts`

### Actions:

1. `src/ports/index.ts` — export:
   - Types: `FileStat`, `DirEntry`, `FileSystem`, `Hasher`, `HashService`, `Compressor`, `HttpRequest`, `HttpResponse`, `HttpTransport`, `ProgressPhase`, `ProgressEvent`, `ProgressReporter`, `RepositoryConfig`, `Context`
   - Values: `noopProgressReporter`, `createContext`

2. `src/adapters/node/index.ts` — export `createNodeContext`, `NodeAdapterOptions`, individual adapter classes

3. `src/adapters/browser/index.ts` — export `createBrowserContext`, `BrowserAdapterOptions`, individual adapter classes

4. `src/adapters/memory/index.ts` — export `createMemoryContext`, `MemoryAdapterOptions`, individual adapter classes

5. `src/adapters/index.ts` — minimal re-export barrel (optional)

6. Update `knip.json` entry points — add:
   - `src/ports/index.ts`
   - `src/adapters/node/index.ts`
   - `src/adapters/browser/index.ts`
   - `src/adapters/memory/index.ts`
   - `src/adapters/index.ts`

7. **Verify** `package.json` `exports` field — `./adapters/{node,browser,memory}` entries are already populated (see `package.json` lines 37-51). Confirm build pipeline produces `dist/{esm,cjs,types}/adapters/*/index.*` as declared. No new exports to add.

8. **Verify** `rollup.config.ts` adapter entry points are present. Already declared — confirm build succeeds.

9. Run `attw` to verify types-export correctness across import conditions.

### Verify:

```bash
npm run validate   # Full quality gate
```

---

## Step 14: Mutation Testing & Branch Finalization

**Not a code step** — finalization per CLAUDE.md §5.

1. Run `npm run test:coverage` — verify 100% line/branch/function/statement coverage on all new ports and memory/Node adapters
2. Run `npx stryker run` — fix surviving mutants, accept only provably equivalent ones
3. Run 4× parallel reviews: code review, security review, performance review, test review
4. Update docs:
   - `BACKLOG.md` — mark 4.1–4.9 as `[x]`
   - `docs/design/ports-and-adapters.md` — update status to "Implemented (at <sha>)"
   - `docs/adr/004-adapter-error-in-domain.md` — update status to "Accepted (at <sha>)"
5. Squash-and-merge to main
6. Cleanup: delete feature branch and worktree

---

## Dependency Graph

```
Step 0  (errors + setup)
  │
  ├──────┬──────┬──────┬──────┐
  ▼      ▼      ▼      ▼      ▼
Step 1  Step 2  Step 3  Step 4  Step 5
(FS)    (Hash)  (Comp)  (HTTP)  (Prog)
  │      │      │      │      │
  └──────┴──────┴──────┴──────┤
                              │
         ┌───────────┬────────┼─────────────┐
         ▼           ▼        ▼             ▼
      Step 6      Step 7    Step 8       Step 9
      (Context)   (FS       (Hash+Comp   (HTTP+Progress
                  contract)  contracts)   contracts)
         │           │        │             │
         └───────────┴────────┴─────────────┤
                              │
              ┌───────────────┼───────────────┐
              ▼               ▼               ▼
          Step 10         Step 11         Step 12
          (Memory)        (Node)          (Browser)
              │               │               │
              └───────────────┴───────────────┘
                              │
                              ▼
                        Step 13 (barrels + validate)
                              │
                              ▼
                        Step 14 (mutations + finalize)
```

**Parallelizable groups:**
- After step 0: steps 1–5 (all port interfaces) are fully independent
- After steps 1–5: steps 6, 7, 8, 9 are all independent — Context (step 6) depends on all port types; contracts (steps 7, 8, 9) depend only on their respective ports
- After contracts and Context: steps 10, 11, 12 (adapters) are fully independent — can run in parallel across worktrees if needed
- Step 13 depends on all prior steps

---

## Test Coverage Plan

| Component | Base Contract | Security Matrix | Adapter-specific | Coverage target |
|---|---|---|---|---|
| FileSystem port types | — | — | — | Type-check only |
| Hash/Compressor/HTTP types | — | — | — | Type-check only |
| Memory FS | 37 base | ~34 (17 methods × 2) | 5+ | 100% |
| Memory Hash | 9 | — | 2+ | 100% |
| Memory Compressor | 5 | — | 1+ | 100% |
| Memory HTTP | 3 | — | 1+ | 100% |
| Memory adapter factory | — | — | 4 | 100% |
| Node FS | 37 base | ~34 | 5+ (symlink attacks, realpath TOCTOU acknowledged) | 100% |
| Node Hash | 9 | — | 1 | 100% |
| Node Compressor | 5 | — | 1 | 100% |
| Node HTTP | 3 | — | 3+ (error sanitization, http fixture) | 100% |
| Node adapter factory | — | — | 3 | 100% |
| Browser adapter | — | — | Type-check only | Phase 11 |
| Context + noop | — | — | 4 | 100% |
| AdapterError | — | — | 10 variants + 5 basename + 4 sanitization | 100% |
| ProgressReporter | 2 | — | — | 100% |

**Total net-new tests:** ~300+ test cases across ~25 files (security matrix duplicates across Memory and Node adapters; contract tests are written once but executed per-adapter). Exact count tracked during implementation; 300 is a floor.

**Mutation testing:** All new files must achieve 0 surviving non-equivalent mutants. Stryker runs on final pass before merge.

---

## Notes for Implementers

- **`crypto.subtle` / `CompressionStream` runtime checks:** At construction time for memory/browser adapters. Throw HASH_FAILED / COMPRESS_FAILED with clear messages for unavailable APIs.
- **Error factories:** Use the factories from `domain/error.ts`, never construct `TsgitError` directly with raw objects.
- **Path normalization:** Memory adapter must normalize paths identically for all operations — inconsistent normalization is a common source of bugs (e.g., `foo/` vs `foo` treated differently).
- **Windows line endings:** Node adapter tests on Windows may see `\r\n` in text files. Use `readFile`/`writeFile` with explicit encoding; never assume LF.
- **Abort signal propagation:** Context signal must be passed through to HttpTransport. FS operations don't accept signals directly (they're fast) — the application layer checks `signal.aborted` between operations.
- **Test isolation:** Each Node FS contract test creates its own temp dir. No shared state across tests.
- **Realpath TOCTOU:** The `fs.realpath` + containment check has a TOCTOU window. Accept this limitation for v1 and document.
- **Stream mutation testing:** `createInflateStream`, `CompressionStream`/`DecompressionStream` — streaming APIs are hard to achieve 100% branch coverage (abort handling, backpressure). Stryker may produce equivalent mutants on stream transforms. Document rationale if accepting.
- **Design step numbers vs plan step numbers:**

  | Design §17 | Plan Step | Notes |
  |---|---|---|
  | Step 0 (errors) | Step 0 | Same |
  | Steps 1–5 (ports) | Steps 1–5 | Same |
  | Step 6 (Context) | Step 6 | Same |
  | Step 7 (contracts FS/H/C) | Steps 7 + 8 | Plan splits: 7 = FS contract, 8 = Hash + Comp contracts |
  | Step 8 (contracts HTTP/Prog) | Step 5 (Progress) + Step 9 (HTTP) | ProgressReporter contract moved to Step 5 (trivial) |
  | Step 9 (Memory) | Step 10 | Renumbered due to split |
  | Step 10 (Node) | Step 11 | Renumbered |
  | Step 11 (Browser) | Step 12 | Renumbered |
  | Step 12 (barrels + validate) | Step 13 | Renumbered |
  | (no design step) | Step 14 | Mutation testing + finalize (CLAUDE.md §5) |
- **Node HTTP test port isolation:** Use `server.listen(0)` to get an ephemeral port. Don't hardcode ports.
- **Signal cancellation tests:** Create an `AbortController`, pass signal, abort mid-operation, assert correct cleanup (handle closed, stream cancelled). Limited in scope for v1 — focus on HTTP signal propagation.
