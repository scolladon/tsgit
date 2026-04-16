# Design: Ports & Adapters

**Status: Proposed** — Phase 4 of the [backlog](../BACKLOG.md).

### Review Notes

Changes from architecture and security reviews (Rounds 1 + 2):

- **`AdapterError` moved to `domain/error.ts`** — error codes define a contract; contracts belong to the domain. Ports import error types _from_ domain, not the reverse. Zero dependency-cruiser violations.
- **`readSlice` added to FileSystem** — random-access reads for packfile entries. Without this, Phase 7 `readObject` would buffer entire multi-hundred-MB packfiles.
- **`writeExclusive` added to FileSystem** — exclusive-create for lock files. Eliminates TOCTOU race in ref/index updates.
- **Incremental hashing added to HashService** — `createHasher()` returns a `Hasher` with `update`/`digest`. Avoids buffer concatenation for `header + content` in the hot path.
- **`chmod` added to FileSystem** — required for checkout of executable files (`100755`).
- **Path containment enforced in contract** — contract tests require adapters to reject paths escaping the root. Node/browser adapters resolve paths and check containment.
- **Symlink target validation documented** — application layer (Phase 7+ checkout) must reject absolute or `..`-containing symlink targets.
- **TLS enforcement via `allowInsecureHttp` option** — Node adapter defaults to HTTPS-only. Browser `fetch` validates TLS natively.
- **`FileStat` gains optional nanosecond timestamps** — `ctimeNs`/`mtimeNs` bigint fields for sub-millisecond stat cache accuracy on Node.
- **`AbortSignal` added to Context** — enables cancellation of long-running operations (clone, fetch, walkCommits).
- **Browser adapter returns `0o100644` for mode** — not `0` — consistent with memory adapter.
- **`TransformStream` type availability addressed** — `@types/node` >= 18 provides it globally; verified.
- **`extractDetail` sanitizes paths** — `Error.message` shows basename only; full path in `error.data.path`.

Changes from Round 2 reviews:

- **Path containment uses trailing-slash check** — `path === rootDir || path.startsWith(rootDir + '/')` to prevent sibling-directory bypass (e.g., `/repo-evil` escaping `/repo`).
- **Node adapter calls `fs.realpath()` before containment check** — prevents symlink-following bypass where a symlink inside root points outside.
- **`readSlice` preconditions documented** — `offset >= 0`, `length >= 0`. Adapters throw on negative values. Out-of-bounds reads return a shorter slice. `length = 0` returns empty array.
- **Path containment covers all path parameters** — `rename(src, dst)` checks BOTH paths. `stat` applies realpath+containment to the symlink-resolved target. Write operations (`write`, `writeExclusive`, `mkdir`, `symlink`) call `realpath` on the nearest existing ancestor, not the non-existent target.
- **`writeExclusive` creates parent directories** — same as `write`. `ENOENT` from `fs.writeFile({flag:'wx'})` triggers `mkdir -p` then retry.
- **`extractDetail` exhaustiveness guard** — `default: never` pattern added to catch future additions.
- **`normalizeFileMode` conversion corrected** — `stat.mode` (number) must be converted to octal string: `normalizeFileMode(stat.mode.toString(8))`.
- **Memory adapter defensively copies `Uint8Array`** — `write` stores `data.slice()`, `read` returns `stored.slice()`. Prevents aliasing bugs where caller mutation corrupts stored data.
- **`Hasher` consumed after `digest`** — calling `update` after `digest`/`digestHex` throws `HASH_FAILED`.
- **`HttpResponse.headers` keys must be lowercase** — contract requirement. Adapters normalize. Prevents cross-platform header access inconsistency.
- **SSRF not mitigated at port level** — documented as application-layer responsibility. `clone`/`fetch` (Phase 9) must validate remote URLs before calling transport.
- **`NETWORK_ERROR.reason` sanitized in Node adapter** — generic messages (`'Connection failed'`, `'DNS resolution failed'`) instead of raw OS errors containing hostnames/IPs.
- **Browser `readSlice` uses `Blob.slice()`** — `file.slice(offset, offset + length).arrayBuffer()` instead of loading entire file. O(length) memory, not O(fileSize).
- **`extractDetail` fully specified** — platform-agnostic `basename` (split on `/` and `\`, take last segment). All 10 `AdapterError` switch cases documented.
- **`FileStat` → `StatData` conversion documented** — explicit conversion function for Phase 7. Degradation behavior on platforms without nanosecond support specified.
- **Checksum handling documented** — `readIndex`/`writeIndex` and pack-index checksum verification/appending are Phase 7 responsibilities using `HashService`.
- **Git config parsing deferred** — `readUtf8` provides I/O capability; config parser is Phase 10 (repository facade).
- **Temp file naming** — application-layer concern using `writeExclusive` with generated names. No port-level `mktemp`.
- **Dependency-cruiser rule added** — `ports-cannot-import-application` enforces `ports/ ✗→ application/`.
- **`TransformStream`/`ReadableStream` type availability** — `@types/node` >= 18 provides globals. Emitted `.d.ts` files use these. Consumers need either `@types/node` or `DOM` types. Documented in §18.
- **`rename` atomically replaces target** — contract specifies POSIX behavior. Node adapter on Windows uses `fs.rename` (which does replace on modern Windows + NTFS).
- **`writeExclusive` is bytes-only** — application layer uses `TextEncoder` for text-based lock files. No `writeExclusiveUtf8`.
- **Browser `writeExclusive` multi-tab limitation** — documented. True locking requires `createSyncAccessHandle()` in Worker context.
- **`readSlice` file handle leak prevention** — Node adapter must use `try/finally` to close handle regardless of abort signal state.
- **No decompression size limit in v1** — documented as known limitation. Application-layer `maxObjectSize` config recommended for hosting services.

---

## 1. Overview

Phase 4 defines the hexagonal boundary between the pure domain layer (Phases 1–3) and the outside world. The boundary consists of:

1. **Port interfaces** — abstract contracts that application-layer code programs against
2. **Adapters** — platform-specific implementations of those ports
3. **Context** — a frozen record aggregating all ports + repository config, threaded through every application-layer call

The SINE principle (Single Interface, No Extension) applies: each port is one flat interface. No inheritance hierarchies, no optional methods.

**Scope boundary:** This phase defines the _interfaces_ and their _implementations_. Application-layer code that _uses_ the ports (primitives, commands) is Phase 7+.

---

## 2. Module Structure

```
src/
├── ports/
│   ├── file-system.ts          # FileSystem port interface + FileStat, DirEntry
│   ├── hash-service.ts         # HashService + Hasher port interfaces
│   ├── compressor.ts           # Compressor port interface
│   ├── http-transport.ts       # HttpTransport port interface + request/response types
│   ├── progress-reporter.ts    # ProgressReporter port interface + event types
│   ├── context.ts              # Context type aggregating all ports + config
│   └── index.ts                # Barrel export
├── adapters/
│   ├── node/
│   │   ├── node-file-system.ts
│   │   ├── node-hash-service.ts
│   │   ├── node-compressor.ts
│   │   ├── node-http-transport.ts
│   │   ├── node-adapter.ts     # Factory: createNodeContext()
│   │   └── index.ts
│   ├── browser/
│   │   ├── browser-file-system.ts
│   │   ├── browser-hash-service.ts
│   │   ├── browser-compressor.ts
│   │   ├── browser-http-transport.ts
│   │   ├── browser-adapter.ts  # Factory: createBrowserContext()
│   │   └── index.ts
│   ├── memory/
│   │   ├── memory-file-system.ts
│   │   ├── memory-hash-service.ts
│   │   ├── memory-compressor.ts
│   │   ├── memory-http-transport.ts
│   │   ├── memory-adapter.ts   # Factory: createMemoryContext()
│   │   └── index.ts
│   └── index.ts
```

---

## 3. Dependency Rules

```
ports/ → domain/ (imports error types + branded types from domain)
ports/ ✗→ adapters/       (ports never import implementations)
ports/ ✗→ application/    (ports are lower than application)

adapters/ → ports/         (adapters implement port interfaces)
adapters/ → domain/        (adapters use branded types and throw TsgitError)
adapters/node/ → node:*    (Node.js builtins)
adapters/browser/ → web APIs (OPFS, SubtleCrypto, fetch, DecompressionStream)
adapters/memory/ → (nothing external)

domain/ ✗→ ports/          (domain never imports outward — enforced by dependency-cruiser)
domain/ ✗→ adapters/       (domain never imports outward)
```

**Import convention:** Ports import domain types from `../../domain/index.js` or submodules. Adapters import port interfaces from `../../ports/index.js` and domain types from `../../domain/index.js`.

**Key invariant:** The dependency-cruiser rule `domain-cannot-import-outward` has _zero exceptions_. Not even type-only imports. All types that `domain/error.ts` needs are defined _within_ `domain/`.

---

## 4. Port Interfaces

### 4.1 FileSystem

The FileSystem port abstracts all file and directory operations. It is the most complex port because git's storage model (loose objects, packfiles, refs, index) requires diverse file operations including random access.

```typescript
/** Metadata returned by stat operations. */
interface FileStat {
  readonly ctimeMs: number;
  readonly mtimeMs: number;
  readonly dev: number;
  readonly ino: number;
  readonly mode: number;
  readonly uid: number;
  readonly gid: number;
  readonly size: number;
  readonly isFile: boolean;
  readonly isDirectory: boolean;
  readonly isSymbolicLink: boolean;
  /** Nanosecond-precision ctime. Populated by Node adapter (fs.stat({ bigint: true })). Undefined on platforms without ns support. */
  readonly ctimeNs?: bigint;
  /** Nanosecond-precision mtime. Populated by Node adapter. Undefined on platforms without ns support. */
  readonly mtimeNs?: bigint;
}

/** A single entry from a directory listing. */
interface DirEntry {
  readonly name: string;
  readonly isFile: boolean;
  readonly isDirectory: boolean;
  readonly isSymbolicLink: boolean;
}

interface FileSystem {
  /** Read entire file as bytes. Throws FILE_NOT_FOUND if not found. */
  readonly read: (path: string) => Promise<Uint8Array>;

  /** Read a byte slice from a file at the given offset. Throws FILE_NOT_FOUND if not found. */
  readonly readSlice: (path: string, offset: number, length: number) => Promise<Uint8Array>;

  /** Read entire file as UTF-8 string. Throws FILE_NOT_FOUND if not found. */
  readonly readUtf8: (path: string) => Promise<string>;

  /** Write bytes to file, creating parent directories as needed. Overwrites if exists. */
  readonly write: (path: string, data: Uint8Array) => Promise<void>;

  /** Write bytes to file. Fails with FILE_EXISTS if the file already exists (exclusive create). */
  readonly writeExclusive: (path: string, data: Uint8Array) => Promise<void>;

  /** Write UTF-8 string to file, creating parent directories as needed. */
  readonly writeUtf8: (path: string, content: string) => Promise<void>;

  /** Check if path exists. */
  readonly exists: (path: string) => Promise<boolean>;

  /** Get file/directory metadata. Throws FILE_NOT_FOUND if not found. Follows symlinks. */
  readonly stat: (path: string) => Promise<FileStat>;

  /** Get file/directory metadata. Throws FILE_NOT_FOUND if not found. Does NOT follow symlinks. */
  readonly lstat: (path: string) => Promise<FileStat>;

  /** List directory entries. Throws NOT_A_DIRECTORY if not a directory. */
  readonly readdir: (path: string) => Promise<ReadonlyArray<DirEntry>>;

  /** Create directory and all parents. No-op if already exists. */
  readonly mkdir: (path: string) => Promise<void>;

  /** Remove file or empty directory. Throws FILE_NOT_FOUND if not found. */
  readonly rm: (path: string) => Promise<void>;

  /** Atomically rename. Both paths must be on the same filesystem. */
  readonly rename: (src: string, dst: string) => Promise<void>;

  /** Read the target of a symbolic link. Throws FILE_NOT_FOUND if not a symlink. */
  readonly readlink: (path: string) => Promise<string>;

  /** Create a symbolic link. Creates parent directories as needed. */
  readonly symlink: (target: string, path: string) => Promise<void>;

  /** Set file permissions. No-op on platforms without permission support (OPFS). */
  readonly chmod: (path: string, mode: number) => Promise<void>;
}
```

**Design decisions — FileSystem:**

- **`string` paths, not `FilePath`:** Port methods accept `string` because the application layer constructs full filesystem paths by joining `Context.gitDir` with domain-computed relative paths (like `computeLooseObjectPath`). The branded `FilePath` type is for _git-internal_ paths (tree entry paths, index entry paths), not OS filesystem paths. Mixing them would be a type error. Phase 7 should introduce a `joinPath` utility to formalize the pattern.
- **`readSlice(path, offset, length)`:** Packfiles can be hundreds of MB. `readObject` (Phase 7) needs to read a pack entry at a specific byte offset (returned by `lookupPackIndex`). Without `readSlice`, the application layer would buffer entire packfiles. Maps to `fs.read(fd, buffer, 0, length, offset)` on Node, `FileSystemSyncAccessHandle.read(buffer, { at: offset })` on OPFS, subarray slice in memory.
- **`writeExclusive`:** Required for git's lock file protocol. `updateRef` writes to `refs/heads/main.lock`, then renames to `refs/heads/main`. The write must fail if `.lock` already exists (concurrent modification detection). `exists` + `write` is a TOCTOU race. Maps to `fs.writeFile(path, data, { flag: 'wx' })` on Node.
- **`chmod`:** Git tracks file mode `100755` (executable). `checkout` (Phase 9) needs to set file permissions. Maps to `fs.chmod` on Node. No-op on OPFS (no permission model) and memory adapter.
- **`readUtf8` / `writeUtf8`:** Loose refs and packed-refs are text files. Dedicated methods avoid manual `TextEncoder`/`TextDecoder` at every call site.
- **`lstat`:** Required for detecting symlinks in the working tree (git's `status` needs to know if a path is a symlink).
- **`readlink` / `symlink`:** Git supports symlink file modes (`120000`). Status and checkout need to read/create symlinks.
- **`FileStat.mode` is `number`:** Raw OS file mode (e.g., `0o100644`). The application layer normalizes to `FileMode` before passing to domain functions.
- **`FileStat` millisecond + optional nanosecond timestamps:** `ctimeMs`/`mtimeMs` match `Date.now()` convention. Optional `ctimeNs`/`mtimeNs` bigint fields provide sub-millisecond precision when the platform supports it (Node's `fs.stat({ bigint: true })`). The application-layer conversion prefers nanosecond fields when present. Without them, `isStatClean` could produce false positives within the same millisecond.
- **`mkdir` creates parents:** Equivalent to `mkdir -p`. Loose object writes need `objects/ab/` to exist.
- **No recursive remove:** `rm` removes a single file or empty directory. Recursive deletion is an application-layer concern built from `readdir` + `rm`.

**Path containment security contract:**

All adapters MUST enforce that resolved paths remain within the adapter's root directory. Specifically:

1. The adapter stores an absolute `rootDir` at construction time (from `workDir` or `gitDir`).
2. Every method that accepts a `path` parameter resolves it to an absolute path. For methods with multiple path parameters (`rename(src, dst)`), ALL parameters are checked independently.
3. The containment check is: `resolved === rootDir || resolved.startsWith(rootDir + '/')`. The trailing `/` prevents sibling-directory bypass (e.g., `/repo-evil` escaping `/repo`).
4. **Node adapter — read operations:** Calls `fs.realpath()` on the resolved path before the containment check. This prevents symlink-following bypass. There is a TOCTOU gap, but this is the best available mitigation.
5. **Node adapter — creation operations** (`write`, `writeExclusive`, `writeUtf8`, `mkdir`, `symlink`): The target path does not yet exist, so `fs.realpath()` would fail. Instead, call `fs.realpath()` on the nearest existing ancestor directory, append the remaining path segments, then apply the containment check. This prevents attacks where a symlink in an existing ancestor resolves outside root.
6. **Node adapter — `stat` (follows symlinks):** The containment check applies to the final resolved target (after symlink resolution), not just the input path. `fs.realpath(inputPath)` gives the real path; containment check on that. If the symlink target is outside root, throw `PERMISSION_DENIED`.
7. Paths that escape the root throw `PERMISSION_DENIED`.
8. Contract tests enforce:
   - `Given path with .. traversal escaping root, When any FileSystem method is called, Then throws PERMISSION_DENIED`
   - `Given path resolving to sibling directory of root, When any method is called, Then throws PERMISSION_DENIED`
   - `Given rename where dst escapes root, When rename, Then throws PERMISSION_DENIED`

The memory adapter enforces containment by normalizing paths (resolve `.`/`..`, strip trailing slashes) and then applying the `startsWith(root + '/')` check.

**`readSlice` preconditions:**

- `offset` MUST be >= 0. Adapters throw `PERMISSION_DENIED` on negative offset.
- `length` MUST be >= 0. Adapters throw `PERMISSION_DENIED` on negative length.
- `length = 0` MUST return an empty `Uint8Array` and MUST NOT throw (regardless of offset, as long as offset >= 0 and file exists).
- If `offset + length > fileSize`, behavior is: return the bytes available from `offset` to end-of-file (shorter slice). This matches POSIX `read()` semantics.
- If `offset >= fileSize`, return empty `Uint8Array`.
- Node adapter MUST use `try/finally` to close file handles regardless of abort signal state, preventing handle leaks.

**Symlink target security precondition:**

The `symlink` method creates a symlink with an arbitrary target string. The FileSystem port does NOT validate symlink targets — this is an application-layer responsibility. The `checkout` command (Phase 9) MUST reject symlink targets that:
- Are absolute paths
- Contain `..` components
- Resolve outside the working tree

This mirrors git's `safe.symlinks` protection. A malicious repository could contain a tree entry with mode `120000` pointing to `../../../etc/passwd`. Without application-layer validation, `stat` following such a symlink could exfiltrate arbitrary files.

### 4.2 HashService

```typescript
/** Incremental hash computation context. Single-use: consumed after digest. */
interface Hasher {
  /** Feed data into the hash. Can be called multiple times before digest. Throws HASH_FAILED if called after digest/digestHex. */
  readonly update: (data: Uint8Array) => void;
  /** Finalize and return the raw digest bytes. Consumes the hasher — no further update/digest calls allowed. */
  readonly digest: () => Promise<Uint8Array>;
  /** Finalize and return the hex-encoded digest. Consumes the hasher — no further update/digest calls allowed. */
  readonly digestHex: () => Promise<string>;
}

interface HashService {
  /** Compute the digest of data in one shot. Returns raw bytes (20 for SHA-1, 32 for SHA-256). */
  readonly hash: (data: Uint8Array) => Promise<Uint8Array>;

  /** Compute the hex-encoded digest of data in one shot. */
  readonly hashHex: (data: Uint8Array) => Promise<string>;

  /** Create an incremental hasher for streaming hash computation. */
  readonly createHasher: () => Hasher;

  /** The hash algorithm name. */
  readonly algorithm: 'sha1' | 'sha256';

  /** Digest length in bytes (20 for SHA-1, 32 for SHA-256). */
  readonly digestLength: 20 | 32;
}
```

**Design decisions — HashService:**

- **`createHasher()` for incremental hashing:** Git objects are hashed as `<type> <size>\0<content>`. Without incremental hashing, `writeObject` must allocate a new buffer concatenating header + content just for hashing. For a 100MB blob, this doubles memory usage. `createHasher` allows: `hasher.update(header); hasher.update(content); await hasher.digest()`. Also required for packfile/pack-index checksums where the entire serialized output must be hashed.
- **`Hasher.update` is synchronous:** The `update` method accumulates data. Only `digest` is async (because `SubtleCrypto.digest` is async on browsers). On Node, `crypto.createHash` is fully sync — the async wrapper is only on `digest`.
- **`SubtleCrypto` doesn't support incremental hashing natively:** The browser/memory adapter's `Hasher` implementation accumulates chunks in an array and concatenates them at `digest()` time. This is suboptimal for very large objects in browsers, but acceptable for v1 since the primary large-object use case (packfiles) runs server-side or via Node. A future optimization could use a pure-TS SHA-1 implementation for true streaming in browsers.
- **`hashHex` convenience method:** Object IDs are always hex-encoded. Having it on the port avoids `bytesToHex(await hash(data))` at every call site.
- **`algorithm` and `digestLength` as properties:** Static for the lifetime of a context. The application layer bridges to domain `HashConfig`: `{ digestLength: ctx.hash.digestLength, hexLength: ctx.hash.digestLength * 2 } as HashConfig`.
- **Async `hash`/`digest`:** Both `node:crypto.createHash` (sync) and `SubtleCrypto.digest` (async) exist. The async signature accommodates both. Node adapters wrap sync calls in `Promise.resolve()`.

### 4.3 Compressor

```typescript
interface Compressor {
  /** Deflate (compress) data using zlib deflate format. */
  readonly deflate: (data: Uint8Array) => Promise<Uint8Array>;

  /** Inflate (decompress) zlib-compressed data. */
  readonly inflate: (data: Uint8Array) => Promise<Uint8Array>;

  /**
   * Create a streaming inflate transform.
   * Returns a TransformStream that inflates chunks incrementally.
   * Used for large packfile entries to avoid buffering entire objects.
   */
  readonly createInflateStream: () => TransformStream<Uint8Array, Uint8Array>;
}
```

**Design decisions — Compressor:**

- **`createInflateStream` returns `TransformStream`:** `TransformStream` is a Web Streams API standard available in Node 18+ (global, no import needed) and all modern browsers. It composes naturally with `ReadableStream.pipeThrough()`. `@types/node` >= 18 provides the global type.
- **zlib deflate format (not raw deflate, not gzip):** Git uses zlib-wrapped deflate (RFC 1950) for loose objects and packfile entries. The correct `CompressionStream`/`DecompressionStream` format string is `'deflate'` (which is zlib-wrapped in the spec).
- **No compression level parameter:** Git uses default compression (level 6). If needed later, it can be added to `Context.config` without changing the port interface.

### 4.4 HttpTransport

```typescript
interface HttpRequest {
  readonly url: string;
  readonly method: 'GET' | 'POST';
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: Uint8Array;
  /** Optional abort signal for request cancellation. */
  readonly signal?: AbortSignal;
}

interface HttpResponse {
  readonly statusCode: number;
  /** Response headers. All keys MUST be lowercased by the adapter. */
  readonly headers: Readonly<Record<string, string>>;
  readonly body: ReadableStream<Uint8Array>;
}

interface HttpTransport {
  /** Send an HTTP request and return the response. */
  readonly request: (req: HttpRequest) => Promise<HttpResponse>;
}
```

**Design decisions — HttpTransport:**

- **`Uint8Array` body (not `ReadableStream`):** Git smart HTTP protocol sends fully-buffered request bodies (packfile negotiation payloads are small; even push payloads must be fully constructed). Streaming request bodies via `ReadableStream` is not universally supported in browsers (Chrome 105+, no Firefox/Safari as of 2025). `Uint8Array` is pragmatically correct for v1. Streaming request bodies can be a v2 optimization for very large pushes.
- **`signal` on request:** Enables cancellation of in-flight HTTP requests. Passed through from `Context.signal`. Adapters forward to `fetch({ signal })` or `http.request` abort handling.
- **Minimal interface:** Transport middleware (retry, auth, logging) wraps `HttpTransport` with the same interface. A single `request` method makes middleware composition trivial.
- **No `onProgress` on request:** Progress reporting for HTTP transfers is handled at the application layer by wrapping the response `ReadableStream` with a progress-reporting transform.

**TLS security contract:**

Adapters MUST enforce HTTPS by default:

1. The Node adapter factory accepts `allowInsecureHttp?: boolean` (defaults to `false`).
2. When `allowInsecureHttp` is `false`, the Node adapter rejects requests with `http:` protocol by throwing `NETWORK_ERROR` with reason `'HTTPS required — set allowInsecureHttp to allow plaintext HTTP'`.
3. The browser adapter uses `fetch()`, which validates TLS certificates natively. No additional enforcement needed (browsers block mixed content by default).
4. TLS certificate validation MUST NOT be disabled. The Node adapter MUST NOT set `rejectUnauthorized: false`.
5. Contract test: `Given an HTTP (non-HTTPS) URL, When requesting with secure adapter, Then throws NETWORK_ERROR`.

### 4.5 ProgressReporter

```typescript
/** The phase of a git operation producing progress events. */
type ProgressPhase =
  | 'counting'
  | 'compressing'
  | 'receiving'
  | 'resolving'
  | 'checking-out'
  | 'writing';

interface ProgressEvent {
  readonly phase: ProgressPhase;
  readonly loaded: number;
  /** Total count, if known. Undefined for indeterminate progress. */
  readonly total?: number;
}

interface ProgressReporter {
  /** Report progress. Implementations should be tolerant of high call frequency. */
  readonly report: (event: ProgressEvent) => void;
}
```

**Design decisions — ProgressReporter:**

- **Synchronous `report`:** Progress events are fire-and-forget. Synchronous keeps the hot path fast.
- **`ProgressPhase` as string literal union:** Extensible without breaking consumers.
- **Optional `total`:** Some operations don't know the total upfront. Consumers must handle indeterminate progress.

---

## 5. Context Type

The `Context` type aggregates all ports and repository configuration into a single immutable record. Every application-layer function (primitive, command) accepts `Context` as its first parameter.

```typescript
interface RepositoryConfig {
  /** Absolute path to the repository root (working tree). */
  readonly workDir: string;
  /** Absolute path to the .git directory (usually `${workDir}/.git`, but may differ for bare repos or worktrees). */
  readonly gitDir: string;
  /** Whether this is a bare repository. */
  readonly bare: boolean;
}

interface Context {
  readonly fs: FileSystem;
  readonly hash: HashService;
  readonly compressor: Compressor;
  readonly transport: HttpTransport;
  readonly progress: ProgressReporter;
  readonly config: RepositoryConfig;
  /** Optional abort signal for cancelling long-running operations. */
  readonly signal?: AbortSignal;
}
```

**Design decisions — Context:**

- **Frozen record, not class:** `Object.freeze()` at creation time. No methods, no state, no mutation. Pure data.
- **All ports required:** No optional ports. The memory adapter provides no-op/mock implementations for ports not needed in a given scenario. This eliminates null checks.
- **`signal` is optional:** Not all operations need cancellation. When present, long-running operations (clone, fetch, walkCommits) check `signal.aborted` between iterations and pass `signal` to HTTP requests. When absent, operations run to completion.
- **`workDir` vs `gitDir`:** Bare repositories have no working tree (`workDir === gitDir`). Linked worktrees have `gitDir` pointing to `.git/worktrees/<name>`. The distinction matters for ref resolution and index location.
- **`RepositoryConfig` is separate from ports:** Config is data; ports are capabilities.
- **No `HashConfig` in Context:** `HashService.algorithm` and `HashService.digestLength` provide the same information. The application layer bridges: `{ digestLength: ctx.hash.digestLength, hexLength: (ctx.hash.digestLength * 2) as 40 | 64 } as HashConfig`.

---

## 6. Adapter Factory Pattern

Each platform provides a factory function that creates all ports for that platform.

```typescript
/** Options for creating a Node.js adapter. */
interface NodeAdapterOptions {
  readonly workDir: string;
  readonly gitDir?: string;         // defaults to `${workDir}/.git`
  readonly bare?: boolean;          // defaults to false
  readonly allowInsecureHttp?: boolean;  // defaults to false (HTTPS only)
  readonly signal?: AbortSignal;
}

/** Options for creating a browser adapter. */
interface BrowserAdapterOptions {
  readonly rootHandle: FileSystemDirectoryHandle;
  readonly gitDirName?: string;     // defaults to '.git'
  readonly bare?: boolean;
  readonly signal?: AbortSignal;
}

/** Options for creating a memory adapter (testing). */
interface MemoryAdapterOptions {
  readonly files?: Readonly<Record<string, Uint8Array>>;
  readonly algorithm?: 'sha1' | 'sha256';  // defaults to 'sha1'
  readonly signal?: AbortSignal;
}

function createNodeContext(options: NodeAdapterOptions): Context;
function createBrowserContext(options: BrowserAdapterOptions): Context;
function createMemoryContext(options?: MemoryAdapterOptions): Context;
```

**Design decisions — factories:**

- **`create*Context` returns full `Context`:** Not individual adapters. All ports wired, context frozen.
- **Options are platform-specific:** Node needs filesystem paths. Browser needs OPFS directory handle. Memory needs nothing (or optional pre-seeded data).
- **Individual adapter exports:** Each port implementation is also exported individually for advanced users who want to mix adapters (e.g., Node filesystem + custom transport).
- **`allowInsecureHttp` on Node only:** Browser `fetch` handles TLS natively. Memory adapter doesn't do real HTTP. Only the Node adapter needs the escape hatch.

---

## 7. Adapter Implementations

### 7.1 Node Adapter

| Port | Implementation |
|---|---|
| FileSystem | `node:fs/promises` — `readFile`, `writeFile`, `stat`, `lstat`, `readdir`, `mkdir`, `rm`, `rename`, `readlink`, `symlink`, `chmod`. Random access via `fs.open` + `fileHandle.read`. |
| HashService | `node:crypto` — `createHash('sha1')` / `createHash('sha256')`. Sync operations wrapped in `Promise.resolve()`. `createHasher` wraps `crypto.createHash`. |
| Compressor | `node:zlib` — `deflateSync` / `inflateSync` with `Promise.resolve()` wrapper. `createInflateStream` wraps `zlib.createInflate()` as a `TransformStream`. |
| HttpTransport | `node:http` / `node:https` — `http.request()` with response body as `ReadableStream` via `Readable.toWeb()`. |

**Node adapter specifics:**
- **Path containment:** Factory resolves `workDir` to absolute via `path.resolve()`. Every method resolves its path argument to absolute, calls `fs.realpath()` to resolve symlinks, then checks `resolved === rootDir || resolved.startsWith(rootDir + '/')`. Throws `PERMISSION_DENIED` on violation.
- **`readSlice`:** Opens file with `fs.open`, reads at offset via `fileHandle.read(buffer, 0, length, offset)`, closes handle in `finally` block. Validates `offset >= 0` and `length >= 0`.
- **`writeExclusive`:** Creates parent directories first (like `write`), then uses `fs.writeFile(path, data, { flag: 'wx' })`. `EEXIST` → `FILE_EXISTS`. If initial `writeFile` fails with `ENOENT` (parent missing), calls `mkdir -p` on parent then retries `writeFile`.
- **`chmod`:** Uses `fs.chmod(path, mode)`.
- **`stat`/`lstat`:** Uses `{ bigint: true }` to populate `ctimeNs`/`mtimeNs` fields. Maps `fs.Stats` to `FileStat`.
- **`mkdir`:** Uses `{ recursive: true }`.
- **`readdir`:** Uses `{ withFileTypes: true }` for `DirEntry` fields.
- **`write`/`writeUtf8`:** Calls `mkdir` on parent directory before writing.
- **Error mapping:** `ENOENT` → `FILE_NOT_FOUND`, `EEXIST` → `FILE_EXISTS`, `ENOTDIR` → `NOT_A_DIRECTORY`, `EACCES`/`EPERM` → `PERMISSION_DENIED`.
- **Hash computation:** Sync (`crypto.createHash` is faster for small inputs). `createHasher` returns a wrapper around `crypto.Hash` with `update` (sync, maps directly) and `digest`/`digestHex` (wrapped in `Promise.resolve()`).
- **HTTP TLS enforcement:** When `allowInsecureHttp` is false (default), rejects `http:` URLs with `NETWORK_ERROR`. Never sets `rejectUnauthorized: false`.
- **Network error sanitization:** Raw OS error messages (containing internal hostnames, IPs, port numbers) are replaced with generic reasons: `ENOTFOUND` → `'DNS resolution failed'`, `ECONNREFUSED` → `'Connection refused'`, `ETIMEDOUT` → `'Connection timed out'`. The original error code is preserved in `error.data.reason` for programmatic use. This prevents accidental leakage of internal network topology.
- **SSRF not mitigated:** The transport port does NOT filter target addresses (private IPs, loopback, link-local). SSRF protection is an application-layer responsibility — `clone` and `fetch` (Phase 9) must validate remote URLs before calling `transport.request()`. This is documented as a security precondition.

### 7.2 Browser Adapter

| Port | Implementation |
|---|---|
| FileSystem | OPFS via `FileSystemDirectoryHandle` / `FileSystemFileHandle` |
| HashService | `SubtleCrypto.digest('SHA-1')` / `SubtleCrypto.digest('SHA-256')` — natively async |
| Compressor | `CompressionStream('deflate')` / `DecompressionStream('deflate')` |
| HttpTransport | `fetch()` with `response.body` as `ReadableStream` |

**Browser adapter specifics:**
- **Path containment:** All paths are relative to the `rootHandle`. Directory traversal is impossible by OPFS design — handles are sandboxed per-origin and there is no `..` navigation.
- **`readSlice`:** In Worker context: `FileSystemSyncAccessHandle.read(buffer, { at: offset })`. On main thread: `fileHandle.getFile()` then `file.slice(offset, offset + length).arrayBuffer()` — the browser lazy-reads just the requested range from OPFS, O(length) memory not O(fileSize).
- **`writeExclusive`:** Calls `getFileHandle(name, { create: false })` first (throws `NotFoundError` if absent, confirming no collision), then `getFileHandle(name, { create: true })`. OPFS lacks native `O_CREAT|O_EXCL` semantics, so this is best-effort. In Worker context, `createSyncAccessHandle()` provides true exclusive locking. **Multi-tab limitation:** OPFS is per-origin, not per-tab. Two tabs can race on the existence check. This is acceptable for v1 — concurrent multi-tab git operations are not a supported use case.
- **`FileStat`:** `ctimeMs`/`mtimeMs` from file metadata (if available), `size` from `getSize()`, `isFile`/`isDirectory` from handle type. `dev`/`ino`/`uid`/`gid` = 0. `mode` = `0o100644` (consistent synthetic value). `ctimeNs`/`mtimeNs` = undefined (OPFS has no ns precision).
- **`readdir`:** Iterates `FileSystemDirectoryHandle` entries.
- **`mkdir`:** Creates nested directory handles via `getDirectoryHandle(name, { create: true })`.
- **Symlink operations (`readlink`, `symlink`):** Throw `UNSUPPORTED_OPERATION` — OPFS does not support symlinks.
- **`chmod`:** No-op — OPFS has no permission model.
- **HashService `createHasher`:** Accumulates chunks in array, concatenates at `digest()`, passes to `SubtleCrypto.digest()`.
- **Note:** Cloudflare Workers blocks `SubtleCrypto.digest('SHA-1')`. A Cloudflare adapter would need a pure-TS SHA-1 fallback or a separate adapter. This is a known limitation, not addressed in v1.

### 7.3 Memory Adapter

| Port | Implementation |
|---|---|
| FileSystem | `Map<string, Uint8Array>` for files, `Set<string>` for directories. Path-based lookup. |
| HashService | `globalThis.crypto.subtle.digest()` (available in Node 18+ and all browsers) |
| Compressor | `CompressionStream` / `DecompressionStream` (available in Node 18+ and all browsers) |
| HttpTransport | Configurable mock: `Map<string, HttpResponse>` keyed by URL+method |

**Memory adapter specifics:**
- **First-class, not afterthought:** The memory adapter is the primary test adapter. All domain and application tests use it.
- **Path containment:** Normalizes paths (resolve `.`/`..`, strip trailing slashes). Checks paths don't escape root after normalization.
- **`readSlice`:** Retrieves `Uint8Array` from map, returns `data.slice(offset, offset + length)` (defensive copy).
- **`writeExclusive`:** Checks `Map.has(path)` — throws `FILE_EXISTS` if present. Single-threaded JS means no TOCTOU race.
- **`FileStat`:** Synthetic values — `ctimeMs`/`mtimeMs` from write timestamp, `size` from data length, `mode` = `0o100644`, `dev`/`ino`/`uid`/`gid` = 0. `ctimeNs`/`mtimeNs` = undefined.
- **`readdir`:** Derives entries from Map key prefixes matching `${dirPath}/` (one level deep).
- **`mkdir`:** Adds path and all parents to directories Set.
- **`rename`:** Delete old key + insert new key (not atomic, but single-threaded JS is safe).
- **`chmod`:** No-op (mode metadata not tracked in memory adapter).
- **Symlinks:** Stored in a separate `Map<string, string>` (path → target). `readlink` looks up the map. `symlink` writes to it.
- **Pre-seeded files:** `createMemoryContext({ files: { 'path': bytes } })` populates the map at construction.
- **Defensive copying:** `write` stores `data.slice()` (not the original reference). `read` returns `stored.slice()`. This prevents aliasing bugs where caller mutation corrupts stored data. Pre-seeded files are also cloned at construction time.
- **Isolation:** Each `createMemoryContext()` creates fresh Maps. No shared state between contexts.
- **`crypto.subtle` availability:** Available in Node 18+ globally. Runtime check: if `globalThis.crypto?.subtle` is undefined, throw `HASH_FAILED` with a clear message. In some embedded Node environments, `--no-experimental-global-webcrypto` may suppress it.
- **`CompressionStream`/`DecompressionStream`:** Available in Node 18+ globally. Runtime check at construction time.
- **Mock HTTP:** `Map<string, HttpResponse>` keyed by `${method}:${url}`. `request` looks up the map, throws `NETWORK_ERROR` if not found. `addMockResponse(method, url, response)` for test setup.

---

## 8. Error Types

### 8.1 Error Type Ownership — Domain Defines All Error Codes

**Key decision:** `AdapterError` is defined in `src/domain/error.ts`, NOT in `src/ports/`. Error codes define a contract — contracts belong to the domain. The domain defines what can go wrong; ports and adapters produce those errors.

This maintains the zero-exception inward dependency rule: the domain never imports from ports. Ports and adapters import error types from the domain.

```typescript
// domain/error.ts (updated)
type AdapterError =
  | { readonly code: 'FILE_NOT_FOUND'; readonly path: string }
  | { readonly code: 'FILE_EXISTS'; readonly path: string }
  | { readonly code: 'NOT_A_DIRECTORY'; readonly path: string }
  | { readonly code: 'PERMISSION_DENIED'; readonly path: string }
  | { readonly code: 'UNSUPPORTED_OPERATION'; readonly operation: string; readonly reason: string }
  | { readonly code: 'HASH_FAILED'; readonly reason: string }
  | { readonly code: 'COMPRESS_FAILED'; readonly reason: string }
  | { readonly code: 'DECOMPRESS_FAILED'; readonly reason: string }
  | { readonly code: 'HTTP_ERROR'; readonly statusCode: number; readonly reason: string }
  | { readonly code: 'NETWORK_ERROR'; readonly reason: string };

type TsgitErrorData = DomainObjectError | StorageError | RefsError | IndexError | AdapterError;
```

Factory functions for each error variant are also in `domain/error.ts`. Adapters import them: `import { fileNotFound, TsgitError } from '../../domain/index.js'`.

### 8.2 `extractDetail` Switch Cases

The `extractDetail` function in `domain/error.ts` gains 10 new switch cases. A platform-agnostic `basename` helper (pure string manipulation — split on both `/` and `\`, return last non-empty segment) is defined in `domain/error.ts`:

```typescript
function basename(path: string): string {
  const segments = path.split(/[/\\]/);
  for (let i = segments.length - 1; i >= 0; i--) {
    if (segments[i] !== '') return segments[i];
  }
  return path;
}
```

New `extractDetail` cases:

| Code | `extractDetail` output |
|---|---|
| `FILE_NOT_FOUND` | `'file not found: <basename(path)>'` |
| `FILE_EXISTS` | `'file already exists: <basename(path)>'` |
| `NOT_A_DIRECTORY` | `'not a directory: <basename(path)>'` |
| `PERMISSION_DENIED` | `'permission denied: <basename(path)>'` |
| `UNSUPPORTED_OPERATION` | `'unsupported operation: <operation>: <reason>'` |
| `HASH_FAILED` | `'hash computation failed: <reason>'` |
| `COMPRESS_FAILED` | `'compression failed: <reason>'` |
| `DECOMPRESS_FAILED` | `'decompression failed: <reason>'` |
| `HTTP_ERROR` | `'HTTP <statusCode>: <reason>'` |
| `NETWORK_ERROR` | `'network error: <reason>'` |

**Security:** Path-containing errors use `basename(path)` to prevent accidental leakage of absolute filesystem paths via `error.message`. The full path remains accessible via `error.data.path` for programmatic use. Network error reasons are pre-sanitized by the adapter (see §7.1).

**Exhaustiveness guard:** The `extractDetail` switch MUST include a `default` case that triggers a compile-time error if any `TsgitErrorData` variant is unhandled:

```typescript
default: {
  const _exhaustive: never = data;
  return String(_exhaustive);
}
```

This prevents future error codes from silently producing `undefined` messages.

---

## 9. No-Op Implementations

Default no-op implementations for ports that may not be needed in all contexts:

```typescript
// ports/progress-reporter.ts
const noopProgressReporter: ProgressReporter = {
  report: () => {},
};

// Used by createMemoryContext() default and available for any context
// that doesn't need progress reporting.
```

The memory adapter's `HttpTransport` throws `NETWORK_ERROR` on any `request()` — not a no-op, but a clear failure for operations that shouldn't need network access.

---

## 10. `FileStat` → `StatData` Conversion (Phase 7)

The domain's `StatData` (from `domain/git-index/index-entry.ts`) uses seconds + nanoseconds pairs. The port's `FileStat` uses milliseconds + optional nanosecond bigints. Phase 7's `status` primitive will bridge them:

```typescript
function fileStatToStatData(stat: FileStat): StatData {
  // Prefer nanosecond fields when available (Node adapter)
  if (stat.ctimeNs !== undefined && stat.mtimeNs !== undefined) {
    return {
      ctimeSeconds: Number(stat.ctimeNs / 1_000_000_000n),
      ctimeNanoseconds: Number(stat.ctimeNs % 1_000_000_000n),
      mtimeSeconds: Number(stat.mtimeNs / 1_000_000_000n),
      mtimeNanoseconds: Number(stat.mtimeNs % 1_000_000_000n),
      dev: stat.dev, ino: stat.ino,
      mode: normalizeFileMode(stat.mode.toString(8)),  // number → octal string → FileMode
      uid: stat.uid, gid: stat.gid,
      fileSize: stat.size,
    };
  }
  // Fallback: millisecond precision (browser, memory adapters)
  return {
    ctimeSeconds: Math.floor(stat.ctimeMs / 1000),
    ctimeNanoseconds: Math.round((stat.ctimeMs % 1000) * 1_000_000),
    mtimeSeconds: Math.floor(stat.mtimeMs / 1000),
    mtimeNanoseconds: Math.round((stat.mtimeMs % 1000) * 1_000_000),
    dev: stat.dev, ino: stat.ino,
    mode: normalizeFileMode(stat.mode),
    uid: stat.uid, gid: stat.gid,
    fileSize: stat.size,
  };
}
```

**Precision degradation:** On platforms without nanosecond support (browser, memory), `isStatClean` may produce false negatives (file appears changed when it hasn't) if the index was written by canonical git with nanosecond precision. The application layer handles this by re-hashing the file when stat differs — this is correct behavior (conservative, not dangerous).

---

## 11. Checksum Handling (Phase 7)

Several domain serializers produce bytes without trailing checksums:

| Serializer | Output | Checksum needed |
|---|---|---|
| `serializeIndex` | Index bytes without trailing 20-byte SHA-1 | `readIndex` must verify; `writeIndex` must append |
| `serializePackIndex` | Pack index bytes with pack checksum but without the index's own trailing SHA-1 | Phase 7 must hash and append |
| `serializePackfile` | Packfile bytes without trailing 20-byte SHA-1 | Phase 7 must hash and append |

The pattern for all three:
1. Call domain serializer to get bytes
2. Hash the bytes using `HashService.hash()` or `Hasher`
3. Concatenate bytes + hash digest
4. Write via `FileSystem.write()`

For verification on read:
1. Read file via `FileSystem.read()`
2. Hash `bytes.subarray(0, bytes.length - digestLength)`
3. Compare against `bytes.subarray(bytes.length - digestLength)`
4. On mismatch, throw error (corrupt file)

This is an application-layer concern (Phase 7 primitives), not a port concern. The ports provide `HashService` and `FileSystem` — the application layer composes them.

---

## 12. Git Config Parsing (Deferred)

Git config parsing (`.git/config` — INI-like format with sections, subsections, and multi-valued keys) is not part of Phase 4. The `readUtf8` method on `FileSystem` provides the I/O capability.

- `core.bare`, `core.filemode`, `remote.origin.url`, `branch.main.remote` — all require config parsing
- Config parser will be a new domain module (Phase 10, repository facade) or an earlier phase if needed
- `RepositoryConfig` fields (`workDir`, `gitDir`, `bare`) are set at context creation time by the factory. In Phase 10, `openRepository` will read `.git/config` to auto-discover these values.

---

## 13. Temp File Naming (Phase 7+)

During `clone` and `fetch`, the application layer receives packfiles over HTTP and must:
1. Write pack data to a temp file (e.g., `.git/objects/pack/tmp_pack_XXXXX`)
2. Generate the `.idx` file
3. Rename both to their final names (based on pack checksum)

Temp file naming is an application-layer concern. The recommended pattern:
- Generate a name: `tmp_pack_${Date.now()}_${crypto.randomUUID().slice(0,8)}`
- Use `writeExclusive` to create (retry on `FILE_EXISTS` collision)
- On failure or abort, `rm` the temp file in a `finally` block

No port-level `mktemp` is needed.

---

## 14. Lock File Protocol

Git uses a write-then-rename pattern for safe ref and index updates:

1. Write to `<path>.lock` using `writeExclusive` (fails if `.lock` exists — concurrent modification detected)
2. `rename` the `.lock` file to the final path (atomic on POSIX, near-atomic on Windows)
3. On failure, `rm` the `.lock` file

The `FileSystem` port provides all three primitives (`writeExclusive`, `rename`, `rm`). The lock protocol itself is an application-layer concern (Phase 7 `updateRef` and `writeIndex` primitives), not a port method.

**Memory adapter note:** `rename` in the memory adapter is delete + insert. This is safe under JavaScript's single-threaded execution model. Concurrent async operations on the same memory adapter could interleave between the delete and insert, but this is acceptable for tests — production multi-process scenarios use the Node adapter where `rename` is atomic.

---

## 15. Testing Strategy

### 15.1 Port Interface Contract Tests

Each port interface gets a **contract test suite** — a set of tests that any adapter must pass. The contract tests are written as functions that accept an adapter factory:

```typescript
// test/unit/ports/file-system.contract.ts
export function fileSystemContractTests(
  createFs: () => Promise<FileSystem>,
  cleanup?: () => Promise<void>
): void {
  describe('FileSystem contract', () => {
    it('Given written file, When reading, Then returns same bytes', ...);
    it('Given non-existent path, When reading, Then throws FILE_NOT_FOUND', ...);
    it('Given path with .. escaping root, When reading, Then throws PERMISSION_DENIED', ...);
    // ... all contract tests
  });
}
```

Each adapter test file calls the contract:

```typescript
// test/unit/adapters/memory/memory-file-system.test.ts
import { fileSystemContractTests } from '../../ports/file-system.contract.js';
fileSystemContractTests(() => createMemoryFileSystem());
```

### 15.2 Full Contract Test Specification

**FileSystem contract tests:**

| # | Test | Expected |
|---|---|---|
| 1 | `Given written file, When reading, Then returns same bytes` | Roundtrip fidelity |
| 2 | `Given written UTF-8 file, When readUtf8, Then returns same string` | UTF-8 roundtrip |
| 3 | `Given non-existent path, When reading, Then throws FILE_NOT_FOUND` | Error |
| 4 | `Given non-existent path, When stat, Then throws FILE_NOT_FOUND` | Error |
| 5 | `Given non-existent path, When exists, Then returns false` | false |
| 6 | `Given existing file, When exists, Then returns true` | true |
| 7 | `Given written file, When stat, Then size matches data length` | Correct size |
| 8 | `Given written file, When stat, Then isFile is true` | Type detection |
| 9 | `Given directory, When stat, Then isDirectory is true` | Type detection |
| 10 | `Given path with .. traversal escaping root, When any method, Then throws PERMISSION_DENIED` | Security |
| 11 | `Given path resolving to sibling directory of root, When any method, Then throws PERMISSION_DENIED` | Security |
| 12 | `Given nested path, When write, Then creates parent directories` | mkdir -p |
| 13 | `Given existing file, When write, Then overwrites` | Overwrite |
| 14 | `Given empty Uint8Array, When write then read, Then returns empty array` | Empty file (git empty blob) |
| 15 | `Given file, When rm, Then file no longer exists` | Removal |
| 16 | `Given non-existent path, When rm, Then throws FILE_NOT_FOUND` | Error |
| 17 | `Given file, When rename, Then old path gone, new path exists with same data` | Move |
| 18 | `Given rename to existing file, When rename, Then atomically replaces target` | POSIX atomic replace |
| 19 | `Given existing file, When writeExclusive, Then throws FILE_EXISTS` | Exclusive create |
| 20 | `Given non-existent file, When writeExclusive, Then creates file` | Create-new |
| 21 | `Given file with known content, When readSlice(0, 3), Then returns first 3 bytes` | Random access |
| 22 | `Given file with known content, When readSlice(5, 3), Then returns bytes at offset 5` | Random access |
| 23 | `Given readSlice with offset beyond EOF, When reading, Then returns empty array` | EOF handling |
| 24 | `Given readSlice with negative offset, When reading, Then throws` | Precondition |
| 25 | `Given non-existent file, When readSlice, Then throws FILE_NOT_FOUND` | Error |
| 26 | `Given directory with files, When readdir, Then returns all entries` | Listing |
| 27 | `Given empty directory, When readdir, Then returns empty array` | Empty listing |
| 28 | `Given non-directory path, When readdir, Then throws NOT_A_DIRECTORY` | Error |
| 29 | `Given mkdir on existing file path, When mkdir, Then throws` | File/dir conflict |
| 30 | `Given symlink, When lstat, Then isSymbolicLink is true` | Symlink detection |
| 31 | `Given symlink, When stat, Then follows symlink (returns target stat)` | Symlink following |
| 32 | `Given file of 10 bytes, When readSlice(8, 5), Then returns 2 bytes` | Partial read at EOF |
| 33 | `Given readSlice with negative length, When reading, Then throws` | Precondition |
| 34 | `Given readSlice(0, 0), When reading, Then returns empty array` | Zero-length read |
| 35 | `Given nested path, When writeUtf8, Then creates parent directories` | mkdir -p for UTF-8 |
| 36 | `Given rename where dst escapes root, When rename, Then throws PERMISSION_DENIED` | Security |
| 37 | `Given non-empty directory, When rm, Then throws` | Non-empty dir |

**HashService contract tests:**

| # | Test | Expected |
|---|---|---|
| 1 | `Given known input, When hash, Then returns expected SHA-1 digest` | Correctness |
| 2 | `Given known input, When hashHex, Then returns expected hex string` | Hex encoding |
| 3 | `Given empty input, When hash, Then returns SHA-1 of empty (da39a3ee...)` | Empty input |
| 4 | `Given same input twice, When hashing, Then returns identical results` | Determinism |
| 5 | `Given algorithm property, When reading, Then is 'sha1' or 'sha256'` | Property |
| 6 | `Given digestLength, When reading, Then matches algorithm (20 or 32)` | Property |
| 7 | `Given two-part input via Hasher, When digest, Then matches one-shot hash` | Incremental equivalence |
| 8 | `Given Hasher after digest called, When update, Then throws HASH_FAILED` | Consumed state |
| 9 | `Given Hasher after digest called, When digest again, Then throws HASH_FAILED` | Double-digest |

**Compressor contract tests:**

| # | Test | Expected |
|---|---|---|
| 1 | `Given data, When deflate then inflate, Then roundtrips` | Roundtrip |
| 2 | `Given empty data, When deflate then inflate, Then roundtrips` | Empty input |
| 3 | `Given large data (64KB), When deflate then inflate, Then roundtrips` | Large input |
| 4 | `Given corrupt data, When inflate, Then throws DECOMPRESS_FAILED` | Error |
| 5 | `Given data, When inflate via createInflateStream, Then same as inflate` | Stream equivalence |

**HttpTransport contract tests:**

| # | Test | Expected |
|---|---|---|
| 1 | `Given mock response, When requesting, Then returns correct statusCode` | Basic operation |
| 2 | `Given response with headers, When reading, Then all keys are lowercase` | Header normalization |
| 3 | `Given HTTP (non-HTTPS) URL with secure adapter, When requesting, Then throws NETWORK_ERROR` | TLS enforcement |

**ProgressReporter contract tests:**

| # | Test | Expected |
|---|---|---|
| 1 | `Given progress event, When report, Then does not throw` | No-throw |
| 2 | `Given noopProgressReporter, When report, Then does not throw` | No-op works |

### 15.3 Test Scope per Item

| Component | Test Type | What to Test |
|---|---|---|
| Port types | Compilation only | Types compile, branded types accepted |
| Contract tests | Unit | All behaviors including security invariants |
| Memory adapter | Unit (contract) | All contracts pass, pre-seeded files, isolation |
| Node adapter | Integration | Real filesystem I/O, real crypto, real zlib (temp dirs) |
| Browser adapter | E2E (Playwright) | OPFS, SubtleCrypto, fetch — deferred to Phase 11 |
| Context factory | Unit | All ports wired, context is frozen, signal threaded |

### 15.4 Coverage Targets

- 100% line, branch, function, statement coverage for ports and memory adapter
- Node adapter: tested via contract tests against real filesystem (in temp directories)
- Browser adapter: deferred to Phase 11 (E2E)

### 15.5 Memory Adapter as Primary Test Adapter

All application-layer tests (Phases 5–10) will use `createMemoryContext()`. This means:
- No filesystem setup/teardown
- No temp directory management
- Deterministic, fast, parallelizable
- Pre-seed any git repository state via the `files` map

---

## 16. Key Design Decisions

### 16.1 `string` Paths vs `FilePath` in Port Methods

**Decision:** Port methods accept `string` paths, not `FilePath`.

**Why:** `FilePath` is a domain concept for _git-internal_ paths (tree entries, index entries — always forward-slash, relative to repo root). OS filesystem paths are platform-specific. Mixing them would be unsound. Phase 7 should introduce a `joinPath` utility to formalize path construction.

### 16.2 Error Codes Owned by Domain

**Decision:** `AdapterError` is defined in `src/domain/error.ts`. Ports and adapters import error types _from_ domain.

**Why:** Error codes define a contract — what can go wrong at the boundary. Contracts belong to the domain. This maintains the zero-exception inward dependency rule: the dependency-cruiser `domain-cannot-import-outward` rule has no exceptions. Ports throw `TsgitError` with domain-defined error codes.

See [ADR-004](../adr/004-adapter-error-in-domain.md) for full rationale.

### 16.3 All Ports Required in Context

**Decision:** No optional ports. Memory adapter provides no-op/mock implementations.

**Why:** Optional ports mean null checks everywhere. The memory adapter is cheap — a mock `HttpTransport` that throws on `request()` is trivial.

### 16.4 Sync Node Operations Wrapped in Promise

**Decision:** Node's sync `crypto.createHash` and `zlib.deflateSync` are wrapped in `Promise.resolve()`.

**Why:** The port interface is async (to accommodate browser APIs). Node sync operations are faster for small inputs. `Promise.resolve()` adds negligible overhead (microtask).

### 16.5 `TransformStream` for Streaming Inflate

**Decision:** `createInflateStream()` returns a `TransformStream`, not a custom interface.

**Why:** `TransformStream` is a Web Streams API standard, available in Node 18+ and all modern browsers. `@types/node` >= 18 provides the global `TransformStream` type without needing `"DOM"` in tsconfig lib.

### 16.6 OPFS Limitations Accepted

**Decision:** Browser adapter has known limitations (no symlinks, limited stat fields, no chmod).

**Why:** OPFS is the only universally available filesystem API in browsers. The adapter throws `UNSUPPORTED_OPERATION` for unsupported operations and returns consistent synthetic values (mode `0o100644`) for stat fields.

### 16.7 Single Context vs Per-Function DI

**Decision:** A single `Context` object is threaded through all primitives and commands, rather than declaring per-function dependencies.

**Why:** Simpler call sites (one parameter), easier to create and pass around. The downside — `resolveRef` receives `HttpTransport` it never uses — is mitigated by the memory adapter providing cheap no-ops. 12+ primitives and 13 commands would have verbose signatures with per-function DI. If tree-shaking analysis (Phase 11) reveals bundle size issues, the ports can be separated later without changing the public API (the `openRepository` facade hides Context from end users).

---

## 17. Implementation Order

```
Step 0: Error types (AdapterError in domain/error.ts)
  │
  ├───────────┬──────────────┬──────────────┬──────────────┐
  ▼           ▼              ▼              ▼              ▼
Step 1      Step 2         Step 3         Step 4         Step 5
FileSystem  HashService    Compressor     HttpTransport  ProgressReporter
(port)      + Hasher       (port)         (port)         (port + noop)
            (port)
  │           │              │              │              │
  └─────┬─────┴──────┬───────┴──────┬───────┘              │
        ▼            ▼              ▼                       │
      Step 6       Step 7        Step 8                    │
      Context      Contract      Contract                  │
      type         tests (FS,    tests (HTTP,              │
                   Hash, Comp)   Progress)                 │
        │            │              │                       │
        └────────────┴──────────────┴───────────────────────┘
                              │
               ┌──────────────┼──────────────┐
               ▼              ▼              ▼
            Step 9         Step 10        Step 11
            Memory         Node           Browser
            adapter        adapter        adapter
               │              │              │
               └──────────────┴──────────────┘
                              │
                              ▼
                         Step 12
                    Barrel exports + validate
```

**Parallelizable groups:**
- After step 0: steps 1–5 (all port interfaces) are independent
- After all ports: steps 6–8 (context + contracts) can run in parallel
- After context + contracts: steps 9–11 (adapters) are independent
- Step 12 depends on all prior steps

---

## 18. File Conventions

- **Source files:** `src/ports/*.ts`, `src/adapters/{node,browser,memory}/*.ts`
- **Test files:** `test/unit/ports/*.ts`, `test/unit/adapters/{node,browser,memory}/*.ts`
- **Contract tests:** `test/unit/ports/*.contract.ts`
- **File names:** kebab-case (enforced by ls-lint)
- **Import extensions:** All imports use `.js` extension
- **Test format:** Given/When/Then titles, AAA body, `sut` variable
- **Type availability:** Port interfaces use `TransformStream<T,U>` and `ReadableStream<T>` types provided by `@types/node` >= 18 globally. Library consumers who import port interfaces in a browser-only project need either `@types/node` or `"DOM"` in their tsconfig `lib`. This is a standard requirement for libraries using Web Streams types.

---

## 19. Dependency-Cruiser Updates

Add this rule to `.dependency-cruiser.cjs` during Step 0:

```javascript
{
  name: 'ports-cannot-import-application',
  comment: 'Port interfaces must not depend on application layer code',
  severity: 'error',
  from: { path: '^src/ports/' },
  to: { path: '^src/application/' },
}
```

This enforces the constraint stated in §3: `ports/ ✗→ application/`.

---

## 20. Known Limitations (v1)

| Limitation | Impact | Mitigation |
|---|---|---|
| No decompression size limit | Decompression bomb could OOM the process | Application-layer `maxObjectSize` config recommended for hosting services |
| Browser `Hasher` accumulates chunks | Peak memory = 2x input size at `digest()` | Acceptable for v1; pure-TS SHA-1 or WASM for v2 streaming |
| OPFS `writeExclusive` not truly exclusive | Multi-tab race condition possible | Single-tab usage assumed; Worker `createSyncAccessHandle` for true locking |
| SSRF not filtered at transport level | Malicious remote URLs could target internal services | Application-layer URL validation required in Phase 9 |
| Cloudflare Workers blocks `SubtleCrypto.digest('SHA-1')` | Cannot use memory/browser adapter on Workers | Separate adapter with pure-TS SHA-1 for Workers |
| `FileStat` millisecond precision on browser/memory | `isStatClean` produces false negatives | Conservative: re-hashes file when stat differs |

---

## 21. PRD Alignment

The PRD (sections 8–9) defines preliminary port interfaces that this design refines. Differences:

| PRD | This Design | Rationale |
|---|---|---|
| `FilePath` in FileSystem | `string` | OS paths ≠ git-internal paths (§16.1) |
| `inflateStream(stream)` | `createInflateStream()` | Returns `TransformStream` for composability |
| `digestLength: number` | `digestLength: 20 \| 32` | More precise typing |
| No `hashHex` | Added `hashHex` | Convenience for ObjectId construction |
| `ReadableStream \| Uint8Array` body | `Uint8Array` only | Streaming bodies not widely supported (§4.4) |
| No incremental hash | `createHasher()` | Avoids buffer concatenation (§4.2) |
| No `readSlice` | Added `readSlice` | Random access for packfiles (§4.1) |
| No `writeExclusive` | Added `writeExclusive` | Lock file protocol (§14) |
| No `chmod` | Added `chmod` | Executable file checkout (§4.1) |
| No `AbortSignal` | Added in Context + HttpRequest | Cancellation support (§5) |

The PRD sections 8.1–8.4 should be updated to reference this design as the authoritative specification.
