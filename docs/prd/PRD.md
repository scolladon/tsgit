# PRD: tsgit — A Lightning-Fast, Portable TypeScript Git Library

## 1. Vision

**tsgit** is a pure TypeScript git implementation designed to be the fastest portable git library available. It runs identically on Node.js (Windows, macOS, Linux), browsers, and edge runtimes — with zero native dependencies, zero WASM, and zero compromises on developer experience.

---

## 2. Problem Statement

The current landscape of JavaScript/TypeScript git libraries forces developers to choose between trade-offs:

| Library | Performance | Browser | DX | Lightweight | Maintained |
|---|---|---|---|---|---|
| **isomorphic-git** | Slow (6-100x vs native) | Yes | Moderate | No (4.78 MB) | Yes |
| **wasm-git** | Near-native | Yes (complex setup) | Poor | No (large WASM binary) | Yes |
| **simple-git** | Native (shells out) | No | Good | Yes (965 kB) | Yes |
| **nodegit** | Native (libgit2 bindings) | No | Moderate | No (native deps) | Dead |

**No library delivers all four: speed + portability + lightweight + great DX.**

### Key Pain Points

1. **isomorphic-git is slow**: Pure JS SHA-1, recursive delta resolution without intermediate caching, O(n) packfile lookups (pre-fix), sequential file operations during checkout. 6x slower on `log`, up to 100x slower on `readBlob` vs native.
2. **Bundle size bloat**: isomorphic-git ships 4.78 MB unpacked. For browser apps, every KB matters.
3. **Poor testability**: Most git libraries expose imperative APIs that are hard to mock, stub, or compose in test harnesses.
4. **Type safety gaps**: Runtime errors instead of compile-time guarantees. Weak typing on object models.
5. **No streaming**: Most implementations buffer entire packfiles or objects in memory.

---

## 3. Goals & Non-Goals

### Goals

| Priority | Goal | Success Metric |
|---|---|---|
| **P0** | Lightning-fast performance | 3-5x faster than isomorphic-git on core operations (clone, log, status, checkout) |
| **P0** | Cross-platform portability | Runs on Node.js (Win/Mac/Linux), all modern browsers, Deno, Bun, Cloudflare Workers |
| **P0** | Lightweight | < 50 kB gzipped for core module; full library < 150 kB gzipped |
| **P1** | Outstanding DX | Type-safe API, easy mocking, composable, zero-config defaults |
| **P1** | Well-architected | SOLID, FP-first, Object Calisthenics for domain, immutable data structures |
| **P1** | Tree-shakeable | Only pay for what you import |
| **P2** | Extensible | Plugin system for custom backends, transports, and hash algorithms |

### Non-Goals (v1)

- SSH transport (HTTP(S) smart protocol only in v1)
- Submodule support
- Worktree support
- Git LFS
- `git rebase` / interactive history rewriting
- `git bisect`, `git stash`, `git gc`
- Shallow clone / partial clone (stretch goal)
- Wire protocol v2 (stretch goal)

### v2 Roadmap

v2 targets full git command coverage:

| Feature | Description |
|---|---|
| SSH transport | Full SSH protocol support for clone/fetch/push |
| Submodules | `submodule init`, `update`, `sync`, recursive operations |
| Worktrees | Multiple working trees from a single repository |
| Git LFS | Large file storage with pointer files and smudge/clean filters |
| Rebase | Interactive rebase, cherry-pick, squash, fixup |
| Full command coverage | `bisect`, `stash`, `gc`, `reflog`, `blame`, `cherry-pick`, `revert`, `reset`, `clean`, `archive` |
| Wire protocol v2 | Improved negotiation, `packfile-uris` for lazy fetching |
| Shallow/partial clone | `--depth`, `--filter=blob:none`, sparse checkout |

---

## 4. Target Users

1. **Web application developers** building browser-based IDEs, CMS tools, or collaborative editors that need git operations client-side.
2. **DevTool authors** building CLI tools, CI/CD pipelines, or automation scripts in TypeScript.
3. **Library authors** embedding git functionality into larger frameworks (e.g., static site generators, deployment tools).
4. **Educators & researchers** who need a readable, well-documented git implementation.

---

## 5. Architecture Overview

### 5.1 Design Principles

| Principle | Application |
|---|---|
| **FP-first** | All data transformations are pure functions. Pipelines composed via function composition. No shared mutable state. |
| **Immutable data** | All domain objects (Commit, Tree, Blob, Tag, Ref) are readonly. Mutations produce new instances. |
| **Ports & Adapters** | Core logic depends on abstract ports (FileSystem, HttpTransport, HashService). Adapters provided per platform. |
| **Object Calisthenics** | Domain value objects: `ObjectId`, `RefName`, `FilePath`, `FileMode`. No primitives crossing boundaries. |
| **KISS** | Simple, obvious implementations over clever optimizations. Profile first, optimize second. |
| **YAGNI** | Ship the smallest useful API. No speculative features. |
| **DRY** | Shared codepaths for loose/packed object access. Single serialization/deserialization pipeline. |
| **SINE (Single Interface, No Extension)** | Each port has exactly one interface. No interface inheritance hierarchies. |

### 5.2 Hexagonal Architecture

The domain is at the center, fully isolated from infrastructure. Ports define the contracts; adapters implement them per platform.

```
                        ┌─────────────────────┐
                        │    Driving Side      │
                        │  (Primary Adapters)  │
                        │                     │
                        │  Public API surface  │
                        │  (pure functions)    │
                        └────────┬────────────┘
                                 │
                    ┌────────────▼────────────┐
                    │      Driving Ports       │
                    │  (Use Case interfaces)   │
                    │                          │
                    │  CloneUseCase            │
                    │  LogUseCase              │
                    │  StatusUseCase           │
                    │  CommitUseCase ...       │
                    └────────────┬─────────────┘
                                 │
              ┌──────────────────▼──────────────────┐
              │            DOMAIN CORE               │
              │                                      │
              │  Value Objects:                       │
              │    ObjectId, RefName, FilePath,       │
              │    FileMode, AuthorIdentity           │
              │                                      │
              │  Entities:                            │
              │    GitObject (Blob|Tree|Commit|Tag)   │
              │                                      │
              │  Domain Services:                     │
              │    ObjectParser, DeltaResolver,       │
              │    TreeDiffer, MergeEngine,           │
              │    PackfileReader, IndexParser        │
              │                                      │
              │  Zero dependencies on infrastructure  │
              └──────────────────┬──────────────────┘
                                 │
                    ┌────────────▼─────────────┐
                    │      Driven Ports         │
                    │  (SPI — interfaces only)  │
                    │                           │
                    │  FileSystem               │
                    │  HttpTransport            │
                    │  HashService              │
                    │  Compressor               │
                    │  ObjectStore              │
                    │  RefStore                 │
                    │  IndexStore               │
                    └────────────┬──────────────┘
                                 │
              ┌──────────────────▼──────────────────┐
              │         Driven Side                  │
              │       (Secondary Adapters)           │
              │                                      │
              │  Node:    node-fs, node-http,         │
              │           node-hash, node-zlib        │
              │  Browser: opfs-fs, fetch-http,        │
              │           webcrypto-hash, decompress  │
              │  Memory:  memory-fs, mock-http        │
              │           (first-class test adapter)  │
              └──────────────────────────────────────┘
```

**Key invariant:** The domain core has zero `import` statements pointing outward. All infrastructure flows through ports. This makes the domain testable with the memory adapter alone — no filesystem, no network, no platform APIs.

### 5.3 Module Structure (Hexagonal + Tiered Application Layer)

```
src/
├── domain/                    # DOMAIN CORE — zero outward dependencies
│   ├── objects/               #   Value objects + parsers/serializers
│   │   ├── blob.ts
│   │   ├── tree.ts
│   │   ├── commit.ts
│   │   ├── tag.ts
│   │   └── git-object.ts      #   Discriminated union type
│   ├── pack/                  #   Packfile reader/writer, delta resolver
│   ├── refs/                  #   Ref resolution, symbolic refs
│   ├── index/                 #   Git index parser/writer
│   ├── diff/                  #   Tree diff algorithm
│   └── merge/                 #   Three-way merge engine
│
├── application/               # USE CASES — orchestrate domain via ports
│   ├── commands/              #   Tier 1 use cases (high-level)
│   │   ├── clone.ts
│   │   ├── fetch.ts
│   │   ├── push.ts
│   │   ├── log.ts
│   │   ├── status.ts
│   │   ├── checkout.ts
│   │   ├── commit.ts
│   │   ├── add.ts
│   │   ├── branch.ts
│   │   ├── tag.ts
│   │   ├── merge.ts
│   │   ├── diff.ts
│   │   └── init.ts
│   └── primitives/            #   Tier 2 use cases (low-level, composable)
│       ├── read-object.ts
│       ├── write-object.ts
│       ├── read-tree.ts
│       ├── write-tree.ts
│       ├── read-blob.ts
│       ├── walk-commits.ts
│       ├── walk-tree.ts
│       ├── resolve-ref.ts
│       ├── update-ref.ts
│       ├── read-index.ts
│       ├── create-commit.ts
│       └── diff-trees.ts
│
├── ports/                     # INTERFACES — the hexagonal boundary
│   ├── file-system.ts
│   ├── http-transport.ts
│   ├── hash-service.ts
│   ├── compressor.ts
│   └── progress-reporter.ts
│
├── adapters/                  # DRIVEN (secondary) adapters
│   ├── node/                  #   Node.js: fs, crypto, zlib, http
│   ├── browser/               #   Browser: OPFS, SubtleCrypto, fetch
│   └── memory/                #   Test: in-memory everything
│
├── operators/                 # AsyncIterable composition toolkit
│   ├── pipe.ts
│   ├── filter.ts
│   ├── map.ts
│   ├── flat-map.ts
│   ├── take.ts
│   ├── find.ts
│   ├── to-array.ts
│   └── group-by.ts
│
├── transport/                 # Transport middleware (composable)
│   ├── with-retry.ts
│   ├── with-auth.ts
│   └── with-logging.ts
│
├── repository.ts              # DRIVING (primary) adapter — Tier 1 facade
│                              #   openRepository() returns frozen record
│                              #   of closures over context, built from
│                              #   application/commands/*
│
└── index.ts                   # Public re-exports
```

**Dependency rule (one-way, inward only):**

```
repository.ts → application/commands/ → application/primitives/ → domain/
                                    ↘                           ↗
                                      ports/ ← adapters/

operators/  → zero deps (pure AsyncIterable utils)
transport/  → ports/http-transport.ts only
```

**Consumer import paths:**

```typescript
import { openRepository } from 'tsgit'                    // Tier 1
import { walkCommits, readTree } from 'tsgit/primitives'   // Tier 2
import { pipe, filter, take } from 'tsgit/operators'       // Tier 2
import { withRetry, withAuth } from 'tsgit/transport'      // Middleware
import { nodeAdapter } from 'tsgit/adapters/node'          // Platform
import { memoryAdapter } from 'tsgit/adapters/memory'      // Testing
```

### 5.4 Entry Points (Package Exports)

Maps internal `src/` paths to consumer-friendly import paths.

```json
{
  "exports": {
    ".": {
      "import": "./dist/esm/index.js",
      "require": "./dist/cjs/index.js",
      "types": "./dist/types/index.d.ts"
    },
    "./primitives": {
      "import": "./dist/esm/application/primitives/index.js",
      "types": "./dist/types/application/primitives/index.d.ts"
    },
    "./primitives/*": {
      "import": "./dist/esm/application/primitives/*.js",
      "types": "./dist/types/application/primitives/*.d.ts"
    },
    "./commands/*": {
      "import": "./dist/esm/application/commands/*.js",
      "types": "./dist/types/application/commands/*.d.ts"
    },
    "./operators": {
      "import": "./dist/esm/operators/index.js",
      "types": "./dist/types/operators/index.d.ts"
    },
    "./transport": {
      "import": "./dist/esm/transport/index.js",
      "types": "./dist/types/transport/index.d.ts"
    },
    "./adapters/node": {
      "import": "./dist/esm/adapters/node/index.js",
      "types": "./dist/types/adapters/node/index.d.ts"
    },
    "./adapters/browser": {
      "import": "./dist/esm/adapters/browser/index.js",
      "types": "./dist/types/adapters/browser/index.d.ts"
    },
    "./adapters/memory": {
      "import": "./dist/esm/adapters/memory/index.js",
      "types": "./dist/types/adapters/memory/index.d.ts"
    }
  }
}
```

---

## 6. Performance Strategy

### 6.1 Competitive Targets

| Operation | isomorphic-git | tsgit target | Method |
|---|---|---|---|
| `log` (3k commits) | ~1,200 ms | < 300 ms | Streaming commit walk, zero-copy parsing |
| `readBlob` (613 files) | ~13,400 ms | < 1,500 ms | Fanout binary search, delta base cache |
| `status` (1k files) | ~800 ms | < 200 ms | Stat-cache validation, parallel hashing |
| `clone` (medium repo) | baseline | 2-3x faster | Streaming packfile indexing, parallel object writes |

### 6.2 Performance-Critical Design Decisions

#### 6.2.1 Fanout Table Binary Search for Pack Index

The `.idx` v2 format has a 256-entry fanout table mapping the first byte of a SHA to a cumulative object count. This narrows binary search to 1/256th of the sorted SHA list before touching any SHA entries — O(log(n/256)) with excellent cache locality.

```
Fanout[0x4a] = 1200  → objects with SHA starting 0x00..0x49
Fanout[0x4b] = 1250  → objects with SHA starting 0x4a: entries 1200..1249
Binary search within 50 entries instead of full table.
```

tsgit will implement this correctly from day one. isomorphic-git initially used `Array.includes()` for O(n) lookup.

#### 6.2.2 Delta Base Cache (LRU)

Deep delta chains require resolving every base object. Without caching, the same base is decompressed repeatedly — O(depth * decompression_cost) per object.

tsgit will maintain a configurable LRU cache of resolved base objects, bounded by memory (default 64 MB, configurable).

#### 6.2.3 Zero-Copy Parsing

Git objects have a simple binary format. Instead of copying byte ranges into new buffers, tsgit will parse objects using `DataView` over the original `ArrayBuffer`, returning typed views (slices) that reference the original memory.

#### 6.2.4 Streaming Inflate

Instead of buffering entire packfiles in memory, tsgit will use streaming decompression:
- **Node.js**: `zlib.createInflate()` stream
- **Browser**: `DecompressionStream` (native, zero-dependency)
- **Fallback**: Minimal pako-compatible inflate for older browsers

#### 6.2.5 Stat-Cache for Working Tree

The git index stores `ctime`, `mtime`, `dev`, `ino`, `uid`, `gid`, `size` per entry. tsgit will use these to skip re-hashing unmodified files during `status` — matching native git behavior.

#### 6.2.6 Platform-Optimized Hashing

| Platform | SHA-1 Strategy |
|---|---|
| Node.js | `crypto.createHash('sha1')` (OpenSSL, hardware-accelerated) |
| Browser | `SubtleCrypto.digest('SHA-1')` (async, hardware-accelerated) |
| Fallback | Minimal pure-TS SHA-1 for environments without WebCrypto |

The `HashService` port abstracts this, allowing future SHA-256 support without API changes.

#### 6.2.7 Parallel I/O

Where possible, tsgit will parallelize I/O operations:
- Parallel file hashing during `status`
- Parallel object writes during `checkout`
- Parallel ref reads during branch listing

Concurrency is bounded by a configurable semaphore (default: 50 concurrent I/O ops).

---

## 7. Developer Experience

### 7.1 Two-Tier API Design

The API has two tiers, serving different use cases. The high-level API is built from the low-level primitives — not a separate codebase.

```
┌─────────────────────────────────────────────────────┐
│  Tier 1: Repository Object (90% use case)            │
│  Ergonomic, discoverable, IDE-friendly               │
│  repo.log(), repo.status(), repo.clone()             │
├─────────────────────────────────────────────────────┤
│  Tier 2: Composable Primitives (power users)         │
│  AsyncIterable-based, pipeable, lazy, tree-shakeable │
│  readObject, writeObject, walkCommits, walkTree,     │
│  readTree, writeTree, updateRef, readIndex           │
└─────────────────────────────────────────────────────┘
```

#### Tier 1: Repository Object — Ergonomic Default

```typescript
import { openRepository } from 'tsgit'
import { nodeAdapter } from 'tsgit/adapters/node'

const repo = openRepository({ adapter: nodeAdapter, dir: '/path/to/repo' })

// Clean, discoverable — IDE autocomplete shows every command
const commits = await repo.log({ depth: 10 })
const changes = await repo.status()
await repo.add({ filepath: 'hello.txt' })
await repo.commit({ message: 'initial' })
await repo.push({ remote: 'origin' })
```

The repository object is a frozen record of closures over the context — FP in implementation, OOP in ergonomics. No class, no prototype chain, no `this` binding issues.

#### Tier 2: Composable Primitives — Power & Composition

Standalone pure functions, independently importable, tree-shakeable. These are the building blocks the Tier 1 API is itself built from.

```typescript
import { walkCommits, readTree, readBlob } from 'tsgit/primitives'
import { log } from 'tsgit/commands/log'
```

### 7.2 Composition Use Cases

#### 7.2.1 Streaming Pipelines (Lazy AsyncIterables)

Operations return `AsyncIterable` where possible — each step pulls only what it needs. On a repo with 50k commits, a filtered query might touch 200.

```typescript
import { openRepository } from 'tsgit'
import { pipe, filter, flatMap, take } from 'tsgit/operators'

const repo = openRepository({ adapter: nodeAdapter, dir: '.' })

// "Show me the last 20 diffs by Alice in src/ from last month"
// Never loads all commits into memory
const diffs = repo.log()
  |> filter(byAuthor('alice'))
  |> filter(byDateRange(lastMonth))
  |> flatMap(toDiffs)
  |> filter(byPath('src/'))
  |> take(20)

for await (const diff of diffs) {
  console.log(diff.path, diff.hunks.length)
}
```

#### 7.2.2 Workflow Composition (Build Higher-Level Ops from Primitives)

```typescript
import { fetch, merge, rebase, add, commit, push } from 'tsgit/commands'

// pull = fetch + merge
const pull = async (repo, remote) => {
  const fetchResult = await fetch(repo.context, { remote })
  return merge(repo.context, { ref: fetchResult.remoteRef })
}

// deploy = add all + commit + push
const deploy = async (repo, message) => {
  await add(repo.context, { filepath: '.' })
  await commit(repo.context, { message })
  await push(repo.context, { remote: 'origin' })
}

// Users build domain-specific workflows from the same primitives
// the high-level API uses
```

#### 7.2.3 Git as Content-Addressable Database

For CMS tools, browser-based editors, config stores — pure object operations without touching the working tree.

```typescript
import { readTree, writeTree, createCommit, updateRef, resolveRef }
  from 'tsgit/primitives'

// Read a page, edit it, commit — no checkout, no index
const tree = await readTree(repo.context, { ref: 'main' })
const newTree = updateTreeEntry(tree, 'content/blog/post.md', newContent)
const newTreeId = await writeTree(repo.context, newTree)
const commitId = await createCommit(repo.context, {
  tree: newTreeId,
  parents: [await resolveRef(repo.context, 'main')],
  message: 'Update blog post'
})
await updateRef(repo.context, 'main', commitId)
```

#### 7.2.4 Custom Walkers / Traversals

```typescript
import { walkCommits, walkTree } from 'tsgit/primitives'
import { pipe, filter, map, toArray } from 'tsgit/operators'

// Find all TypeScript files in a tree
const tsFiles = walkTree(repo.context, { ref: 'main' })
  |> filter(entry => entry.path.endsWith('.ts'))
  |> map(entry => ({ path: entry.path, id: entry.id }))
  |> toArray

// Custom bisect: find the commit that introduced a bug
const culprit = walkCommits(repo.context, { from: 'main', to: 'v1.0.0' })
  |> find(async (commit) => {
    const blob = await readBlob(repo.context, { ref: commit.id, path: 'config.json' })
    const config = JSON.parse(decode(blob.content))
    return config.featureFlag === true
  })
```

#### 7.2.5 Middleware / Transport Composition

```typescript
import { openRepository } from 'tsgit'
import { fetchTransport } from 'tsgit/adapters/browser'
import { withRetry, withAuth, withLogging } from 'tsgit/transport'

// Compose transport middleware — every fetch/push/clone gets retry, auth, logging
const transport = pipe(
  fetchTransport,
  withRetry({ attempts: 3, backoff: 'exponential' }),
  withAuth({ type: 'bearer', token: process.env.GIT_TOKEN }),
  withLogging(logger)
)

const repo = openRepository({ adapter: browserAdapter, dir: '/', transport })
```

#### 7.2.6 Diff Transformers

```typescript
// Custom code review tool
const review = repo.diff({ from: 'main', to: 'feature' })
  |> filter(excludePaths(['package-lock.json', '*.generated.ts']))
  |> map(annotateWithBlame(repo))
  |> groupBy(diff => diff.author)

// Migration checker: detect breaking API changes
const breaking = repo.diff({ from: lastRelease, to: 'HEAD' })
  |> filter(byPath('src/api/**'))
  |> flatMap(detectBreakingChanges)
```

### 7.3 Type-Safe Object Model

```typescript
// Discriminated unions for git objects
type GitObject =
  | { readonly type: 'blob';   readonly id: ObjectId; readonly content: Uint8Array }
  | { readonly type: 'tree';   readonly id: ObjectId; readonly entries: ReadonlyArray<TreeEntry> }
  | { readonly type: 'commit'; readonly id: ObjectId; readonly data: CommitData }
  | { readonly type: 'tag';    readonly id: ObjectId; readonly data: TagData }

// Value objects with compile-time safety
type ObjectId = string & { readonly __brand: unique symbol }
type RefName = string & { readonly __brand: unique symbol }
type FilePath = string & { readonly __brand: unique symbol }

// Exhaustive matching — TypeScript enforces all cases handled
function describe(obj: GitObject): string {
  switch (obj.type) {
    case 'blob':   return `blob ${obj.content.byteLength} bytes`
    case 'tree':   return `tree ${obj.entries.length} entries`
    case 'commit': return `commit by ${obj.data.author.name}`
    case 'tag':    return `tag ${obj.data.tagName}`
  }
}
```

### 7.4 Testing & Mocking

The hexagonal architecture makes tsgit trivially testable at every level.

```typescript
import { openRepository } from 'tsgit'
import { memoryAdapter } from 'tsgit/adapters/memory'

// In-memory — no filesystem, no setup, no cleanup
const repo = openRepository({ adapter: memoryAdapter })

await repo.init()
await repo.writeFile('hello.txt', 'world')
await repo.add({ filepath: 'hello.txt' })
const changes = await repo.status()
// Assert against changes
```

```typescript
// Mock a single port — replace only the transport layer
const mockTransport = createMockTransport({
  'https://github.com/user/repo.git': fixturePackfile
})
const repo = openRepository({
  adapter: memoryAdapter,
  transport: mockTransport
})
await repo.clone({ url: 'https://github.com/user/repo.git' })
```

**Testing guarantees:**
- `memory` adapter is first-class, not an afterthought
- All ports are interfaces — mockable individually
- Repository object and primitives share the same context — test at any level
- No hidden global state, no singletons, no `process.cwd()` surprises

### 7.5 Progress Reporting

```typescript
const result = await repo.clone({
  url: 'https://github.com/user/repo',
  onProgress: (phase, loaded, total) => {
    console.log(`${phase}: ${loaded}/${total}`)
  }
})
```

### 7.6 Error Model

Typed, structured errors with full context — pattern-matchable:

```typescript
type TsgitError =
  | { readonly code: 'OBJECT_NOT_FOUND'; readonly objectId: ObjectId }
  | { readonly code: 'REF_NOT_FOUND'; readonly refName: RefName }
  | { readonly code: 'MERGE_CONFLICT'; readonly conflicts: ReadonlyArray<FilePath> }
  | { readonly code: 'NETWORK_ERROR'; readonly url: string; readonly cause: Error }
  | { readonly code: 'CORRUPT_OBJECT'; readonly objectId: ObjectId; readonly reason: string }

// Pattern matching on errors
const result = await repo.checkout({ ref: 'main' })
if (result.isErr()) {
  switch (result.error.code) {
    case 'MERGE_CONFLICT':
      console.log('Conflicts in:', result.error.conflicts)
      break
    case 'REF_NOT_FOUND':
      console.log('Branch not found:', result.error.refName)
      break
  }
}
```

---

## 8. Port Definitions

### 8.1 FileSystem Port

```typescript
interface FileSystem {
  readonly read: (path: FilePath) => Promise<Uint8Array>
  readonly write: (path: FilePath, data: Uint8Array) => Promise<void>
  readonly exists: (path: FilePath) => Promise<boolean>
  readonly stat: (path: FilePath) => Promise<FileStat>
  readonly readdir: (path: FilePath) => Promise<ReadonlyArray<DirEntry>>
  readonly mkdir: (path: FilePath) => Promise<void>
  readonly rm: (path: FilePath) => Promise<void>
  readonly rename: (src: FilePath, dst: FilePath) => Promise<void>
}
```

### 8.2 HttpTransport Port

```typescript
interface HttpTransport {
  readonly request: (req: HttpRequest) => Promise<HttpResponse>
}

interface HttpRequest {
  readonly url: string
  readonly method: 'GET' | 'POST'
  readonly headers: Readonly<Record<string, string>>
  readonly body?: ReadableStream<Uint8Array> | Uint8Array
  readonly onProgress?: ProgressCallback
}

interface HttpResponse {
  readonly statusCode: number
  readonly headers: Readonly<Record<string, string>>
  readonly body: ReadableStream<Uint8Array>
}
```

### 8.3 HashService Port

```typescript
interface HashService {
  readonly hash: (data: Uint8Array) => Promise<Uint8Array>
  readonly algorithm: 'sha1' | 'sha256'
  readonly digestLength: number  // 20 for sha1, 32 for sha256
}
```

### 8.4 Compressor Port

```typescript
interface Compressor {
  readonly deflate: (data: Uint8Array) => Promise<Uint8Array>
  readonly inflate: (data: Uint8Array) => Promise<Uint8Array>
  readonly inflateStream: (stream: ReadableStream<Uint8Array>) => ReadableStream<Uint8Array>
}
```

---

## 9. Cross-Platform Adapter Matrix

| Port | Node.js | Browser | Memory (Test) |
|---|---|---|---|
| FileSystem | `node:fs/promises` | OPFS + Worker | In-memory Map |
| HttpTransport | `node:http`/`node:https` | `fetch` | Mock responses |
| HashService | `node:crypto` | `SubtleCrypto` | `SubtleCrypto` |
| Compressor | `node:zlib` | `DecompressionStream` | `DecompressionStream` |

---

## 10. v1 Feature Scope

### 10.1 Core Operations (P0)

| Command | Description |
|---|---|
| `init` | Initialize a new repository |
| `clone` | Clone a remote repository via HTTP(S) smart protocol |
| `fetch` | Fetch refs and objects from remote |
| `push` | Push refs and objects to remote |
| `add` | Stage files to the index |
| `commit` | Create a commit from the current index |
| `status` | Compare working tree, index, and HEAD |
| `log` | Walk commit history |
| `checkout` | Switch branches or restore working tree files |
| `branch` | List, create, delete branches |
| `tag` | List, create, delete tags |
| `diff` | Diff working tree, index, or commits |
| `merge` | Three-way merge with conflict detection |

### 10.2 Core Internals (P0)

| Component | Description |
|---|---|
| Object parser/serializer | Blob, Tree, Commit, Tag — binary format |
| Packfile reader | v2 pack format with delta resolution |
| Packfile writer | For push/clone operations |
| Pack index reader | v2 idx format with fanout table |
| Index reader/writer | Git index v2 format |
| Ref resolution | Symbolic refs, packed-refs, peeling |
| Smart HTTP protocol | v1 (v2 as stretch goal) |
| Delta resolution | OBJ_REF_DELTA and OBJ_OFS_DELTA |

### 10.3 Out of Scope (v1)

See [section 3 — Non-Goals & v2 Roadmap](#non-goals-v1) for the full list.

---

## 11. Engineering Harness (DevOps & Quality)

Every feature must pass the full harness before merge. No exceptions.

### 11.1 Testing Strategy — Test Pyramid

```
          ╱╲
         ╱  ╲          E2E / Functional Tests
        ╱    ╲         Cross-platform: Ubuntu, macOS, Windows
       ╱      ╲        Cross-runtime: Node 18/20/22, Chrome, Firefox, Safari
      ╱────────╲       Playwright for browser, vitest for Node
     ╱          ╲
    ╱  Integr.   ╲    Integration Tests
   ╱              ╲    Real git repos, roundtrip correctness,
  ╱                ╲   interop with canonical git (clone/push/verify)
 ╱──────────────────╲
╱                    ╲  Unit Tests
╱    Unit Tests       ╲ Every parser, serializer, domain object,
╱                      ╲ primitive, command — isolated with memory adapter
╱────────────────────────╲
```

| Layer | Tool | Scope | Target |
|---|---|---|---|
| **Unit** | Vitest | Domain, primitives, commands (memory adapter) | 100% coverage on every KPI (line, branch, function, statement) |
| **Integration** | Vitest | Real repos, cross-adapter (node + browser), roundtrip tests | Canonical git interop |
| **E2E / Functional** | Vitest + Playwright | Full workflows (clone → edit → commit → push) across OS and runtimes | Ubuntu, macOS, Windows × Node 18/20/22 × Chrome, Firefox, Safari |

Test behavior, not implementation, black box, not white box.

**Coverage KPIs — all must be 100%:**

| KPI | Tool | Gate |
|---|---|---|
| Line coverage | `vitest --coverage` (v8) | 100% |
| Branch coverage | `vitest --coverage` (v8) | 100% |
| Function coverage | `vitest --coverage` (v8) | 100% |
| Statement coverage | `vitest --coverage` (v8) | 100% |

### 11.2 Mutation Testing

| Metric | Tool | Gate |
|---|---|---|
| Mutation score | Stryker | Target: 100% (aim for 0 surviving mutants) |

Stryker runs against the full unit test suite. Any surviving mutant indicates a test that asserts existence but not correctness. Fix the test, not the threshold.

**Configuration:**
- Mutator: TypeScript
- Test runner: Vitest
- Reporter: HTML + dashboard
- Thresholds: `{ high: 100, low: 95, break: 90 }`
- Runs on CI for every PR

### 11.3 Performance Testing

| Aspect | Tool | Gate |
|---|---|---|
| Benchmark suite | `vitest bench` | No regression > 5% vs baseline |
| Comparison | Benchmark against isomorphic-git | 3-5x faster on core operations |
| Memory profiling | Node.js `--max-old-space-size` monitoring | < 2x data size |
| Bundle size | Custom size-limit script | See bundle budget below |

**Benchmark operations (run on every PR):**

| Operation | Repository | Baseline (isomorphic-git) | Gate |
|---|---|---|---|
| `log` (3k commits) | medium test repo | ~1,200 ms | < 300 ms |
| `readBlob` (613 files) | medium test repo | ~13,400 ms | < 1,500 ms |
| `status` (1k files) | medium test repo | ~800 ms | < 200 ms |
| `clone` | medium test repo | baseline | 2-3x faster |

**Bundle size budget:**

| Entry Point | Max Gzipped Size |
|---|---|
| `tsgit/commands/log` (single command) | < 15 kB |
| `tsgit` (core, no adapters) | < 50 kB |
| `tsgit` + node adapter | < 60 kB |
| `tsgit` + browser adapter | < 60 kB |
| Full library | < 150 kB |

### 11.4 Static Analysis & Linting

| Concern | Tool | Scope |
|---|---|---|
| **Linting** | Biome | All TypeScript files — enforces consistent style, catches bugs |
| **Formatting** | Biome | All files — deterministic formatting, no style debates |
| **Type checking** | `tsc --noEmit` | Full project — strict mode, no `any` escapes |
| **Dead code / unused exports** | Knip | Detect unused files, exports, dependencies, types |
| **Duplicate code** | jscpd | Detect copy-paste across modules |
| **File system structure** | ls-lint | Enforce naming conventions per directory (kebab-case for files, etc.) |
| **Commit messages** | commitlint | Conventional commits format (`feat:`, `fix:`, `refactor:`, etc.) |
| **Dependency freshness** | `npm outdated` | Flag outdated dependencies on CI |

**ls-lint configuration (example):**

```yaml
ls:
  src/domain:
    .ts: kebab-case
  src/application:
    .ts: kebab-case
  src/adapters:
    .ts: kebab-case
  src/operators:
    .ts: kebab-case
  test:
    .test.ts: kebab-case
```

**Biome configuration highlights:**
- Strict TypeScript rules
- No `any` without justification
- Sorted imports
- Consistent quote style
- No unused variables/imports

### 11.5 Git Hooks (Husky + lint-staged)

Pre-commit and commit-msg hooks enforce quality at the developer's machine, before code reaches CI.

```
pre-commit (via husky + lint-staged):
  ┌─────────────────────────────────┐
  │ For each staged file:           │
  │  1. biome check --write         │  ← Format + lint (auto-fix)
  │  2. tsc --noEmit                │  ← Type check
  │  3. vitest related --run        │  ← Run tests related to changed files
  │  4. knip                        │  ← Check for dead code
  └─────────────────────────────────┘

commit-msg (via husky + commitlint):
  ┌─────────────────────────────────┐
  │ Validate commit message format  │
  │ Conventional Commits enforced   │
  │ e.g. feat: add packfile reader  │
  └─────────────────────────────────┘
```

**lint-staged configuration:**

```json
{
  "*.ts": [
    "biome check --write",
    "vitest related --run"
  ]
}
```

### 11.6 CI Pipeline

Every PR triggers the full pipeline. No merge without green.

```
┌─────────────────────────────────────────────────────────────┐
│                        CI Pipeline                           │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  Stage 1: Static Analysis (parallel)                         │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌───────────────┐   │
│  │ biome    │ │ tsc      │ │ knip     │ │ ls-lint       │   │
│  │ lint +   │ │ --noEmit │ │ dead     │ │ file naming   │   │
│  │ format   │ │ strict   │ │ code     │ │ conventions   │   │
│  └──────────┘ └──────────┘ └──────────┘ └───────────────┘   │
│  ┌──────────┐ ┌──────────┐ ┌───────────────┐                │
│  │ jscpd    │ │ npm      │ │ commitlint    │                │
│  │ dupes    │ │ outdated │ │ PR commits    │                │
│  └──────────┘ └──────────┘ └───────────────┘                │
│                                                              │
│  Stage 2: Unit Tests (parallel matrix)                       │
│  ┌──────────────────────────────────────────────────────┐    │
│  │ vitest --coverage (100% line/branch/function/stmt)   │    │
│  │ Matrix: Node 18, 20, 22 × Ubuntu, macOS, Windows    │    │
│  └──────────────────────────────────────────────────────┘    │
│                                                              │
│  Stage 3: Mutation Testing                                   │
│  ┌──────────────────────────────────────────────────────┐    │
│  │ Stryker (target: 0 surviving mutants)                │    │
│  └──────────────────────────────────────────────────────┘    │
│                                                              │
│  Stage 4: Integration Tests                                  │
│  ┌──────────────────────────────────────────────────────┐    │
│  │ Real git repos, roundtrip tests, canonical git       │    │
│  │ interop (clone from GitHub, push back, verify)       │    │
│  └──────────────────────────────────────────────────────┘    │
│                                                              │
│  Stage 5: E2E / Functional Tests (parallel matrix)           │
│  ┌──────────────────────────────────────────────────────┐    │
│  │ Playwright: Chrome, Firefox, Safari                  │    │
│  │ Node E2E: Ubuntu, macOS, Windows × Node 18, 20, 22  │    │
│  │ Full workflows: clone → edit → commit → push         │    │
│  └──────────────────────────────────────────────────────┘    │
│                                                              │
│  Stage 6: Performance (parallel)                             │
│  ┌──────────────────┐ ┌────────────────────────────────┐    │
│  │ vitest bench     │ │ Bundle size check              │    │
│  │ vs baseline +    │ │ (size-limit, per entry point)  │    │
│  │ vs isomorphic-git│ │                                │    │
│  └──────────────────┘ └────────────────────────────────┘    │
│                                                              │
│  Stage 7: AI Agent Reviews (parallel)                        │
│  ┌─────────────┐ ┌─────────────┐ ┌──────────┐ ┌─────────┐  │
│  │ security-   │ │ profiling-  │ │ test-    │ │ code-   │  │
│  │ reviewer    │ │ driven-     │ │ review   │ │ reviewer│  │
│  │             │ │ optimization│ │          │ │         │  │
│  │ OWASP Top10 │ │ perf check  │ │ test     │ │ clean   │  │
│  │ secrets     │ │ hotspots    │ │ quality  │ │ code    │  │
│  │ injection   │ │ memory      │ │ coverage │ │ SOLID   │  │
│  └─────────────┘ └─────────────┘ └──────────┘ └─────────┘  │
│                                                              │
├─────────────────────────────────────────────────────────────┤
│  All stages green → PR mergeable                             │
└─────────────────────────────────────────────────────────────┘
```

### 11.7 AI Agent Reviews (Post-Build)

After every feature implementation, four specialized agents run in parallel:

| Agent | Focus | Blocks Merge? |
|---|---|---|
| **security-reviewer** | OWASP Top 10, hardcoded secrets, injection, unsafe crypto, credential leaks | Yes — CRITICAL/HIGH findings block |
| **profiling-driven-optimization** | CPU hotspots, memory allocation, algorithmic complexity, bundle size impact | Yes — regressions block |
| **test-review** | Test quality, missing edge cases, assertion strength, test isolation, flaky test detection | Yes — gaps in critical paths block |
| **code-reviewer** | Clean code, SOLID, FP patterns, Object Calisthenics, DRY, naming, dead code | Yes — CRITICAL findings block |

These agents review the diff, not the entire codebase — fast, focused, actionable.

### 11.8 Correctness Requirements

- 100% compatibility with repositories created by canonical git
- Roundtrip tests: parse → serialize → parse produces identical results
- Interop tests: clone from GitHub/GitLab, push back, verify with canonical git
- Cross-platform: identical behavior on Ubuntu, macOS, Windows
- Cross-runtime: identical results on Node 18/20/22, Chrome, Firefox, Safari

---

## 12. Technical Risks & Mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Pure-TS SHA-1 too slow on fallback path | Performance regression on old browsers | Use `SubtleCrypto` as primary; pure-TS only as last resort. Batch small objects. |
| `SubtleCrypto.digest` async overhead | Many small hashes create microtask pressure | Batch hashing: concatenate small objects, hash together, split results. |
| Browser OPFS not universally supported | Reduced browser compatibility | Fallback chain: OPFS → IndexedDB → in-memory. Detect at runtime. |
| Packfile delta chains too deep | Stack overflow or memory pressure | Iterative (not recursive) delta resolution with bounded LRU cache. |
| `DecompressionStream` not available | No native zlib in older browsers | Tiny embedded inflate (~3 kB) as fallback. |
| Git protocol edge cases | Correctness bugs | Extensive test suite against canonical git; use git test repositories from official test suite. |

---

## 13. Success Criteria

### v1.0 Launch Criteria

- [ ] All P0 commands implemented and tested
- [ ] 3x faster than isomorphic-git on `log`, `status`, `readBlob`, `clone`
- [ ] Works in Node.js 18+, Chrome 90+, Firefox 100+, Safari 15.4+
- [ ] Full library < 150 kB gzipped
- [ ] 100% test coverage (line, branch, function, statement)
- [ ] 0 surviving Stryker mutants on domain + primitives
- [ ] Full engineering harness green (see section 11)
- [ ] Zero runtime dependencies
- [ ] Published to npm with full TypeScript types
- [ ] Correct CJS/ESM dual publish (verified by arethetypeswrong)
- [ ] README with quick-start for Node.js and browser
- [ ] Benchmark suite with CI integration

### Post-Launch Metrics

- npm weekly downloads (target: 1k in first 3 months)
- GitHub stars (target: 500 in first 6 months)
- Zero critical bugs open for > 7 days
- Community contributions within 6 months

---

## 14. Competitive Analysis — Where They Fail, Where We Shine

### 14.1 Weakness Matrix

| Dimension | isomorphic-git | simple-git | wasm-git | nodegit |
|---|---|---|---|---|
| **Performance** | 6-100x slower than native | Fast (shells out), but per-op process spawn overhead (50-100ms on Windows) | Near-native, but cold-start penalty from WASM instantiation | Native, but 5-10 min install compile time |
| **Architecture** | 73 thin API wrappers → 73 command impls (DRY violation); 3 failed extensibility models; no rebase/interactive ops | String-parsing git CLI output (unstable API); CQS violations in chained API; env() override bug | C-style `callMain()` shim over libgit2; no JS/TS abstraction layer | OOP mirror of C libgit2; Law of Demeter violations through deep object chains |
| **DX / Types** | `fs`/`dir` boilerplate on every call; CJS/ESM masquerade (#2024); broken quick-start (#2268); leaked internal errors (#2216) | ESM `not callable` (#804); broken enum exports (#704); `@ts-ignore` routinely needed; stderr swallowed | No TypeScript types at all; Emscripten error codes instead of JS exceptions; 50 total commits | `@types/nodegit` has incorrect return types, missing exports; installation requires Visual Studio/Python |
| **Testability** | No repository context object; cache is opt-in, not default; must pass `fs` to every mock | Requires git binary installed; no in-memory mode; process spawn makes unit tests slow | Requires Worker shim for Jest/Vitest; no mock layer | Native binary makes test isolation nearly impossible |
| **Lightweight** | 4.78 MB unpacked; tree-shaking theoretical (clone pulls entire subsystem); LightningFS adds ~100 kB | 450 kB but requires system git binary; not bundleable for non-Node | 5-15 MB WASM binary; Asyncify inflates further | Compiles libgit2 from C++ at install |
| **Portability** | iOS SHA failures (#1760, open 2+ years); index v3 unsupported (#2215); 5+ open checksum bugs; binary file false-positive diffs (#362) | Node-only; Windows drive letter bugs (#962); Program Files paths rejected (#1031); quote inconsistencies (#1077); no browser/edge/Deno | Requires COOP/COEP headers (blocks GitHub Pages); SharedArrayBuffer mandatory; OPFS Chrome 102+ only | Dead (last release 2020); no Node 18+ prebuilts; Windows MSVC required |

### 14.2 Deep Dive — Where Each Competitor Falls Short

#### isomorphic-git — The Closest Competitor

**Performance (the critical gap):**
- `log` on 3k commits: 1.2s vs simple-git's 0.2s — 6x slower (#446)
- `readBlob` across 613 files: 13.4s vs nodegit's 132ms — 100x slower (#1841)
- v1.7.5 regression: `readObject` went from 2ms → 225ms per call — 50x slowdown (#1251)
- Pack files loaded entirely into RAM instead of streaming (#291)
- Cache is opt-in — every `status()` re-reads the index from disk by default
- Delta chains resolved recursively in pure JS, no intermediate memoization

**Architecture (design debt):**
- Manual DI (`{ fs, dir }` on every call) — "less aesthetic and more verbose" (author's own words)
- Cycled through 3 extensibility models: global plugins → plugin sets → plain callbacks
- Issue #2231 proposes a full 2.0 API rethink — "we need to plan the API, starting from examples"
- No `merge-base`, no `rebase`, no interactive history operations

**DX (rough edges):**
- CJS/ESM dual-publish flagged as "masquerading as ESM" by arethetypeswrong.github.io (#2024)
- `commit()` crashes with uncaught `TypeError` on empty `.git/HEAD` (#2287)
- Security: basic-auth credentials leak into GitLab merge commit messages (#2247)
- Quick-start guide broken since v1.35 migration to ZenFS (#2268)

**Portability (fragile binary parsing):**
- 5+ open index checksum bugs across platforms (#2201, #2224, #2230, #2240, #2292) — systematic, not isolated
- iOS SHA failures open for 2+ years (#1760)
- Git index v3 unsupported — hard failure on newer git repos (#2215)
- CI broken — migration from Azure DevOps to GitHub Actions incomplete (#2266)

#### simple-git — Node-Only Wrapper

**Hard portability wall:** No browser, no Deno, no edge runtimes. Requires `git` binary in `PATH`.

**Windows is a minefield:**
- Drive letter `:` parsed as git revision separator — breaks `E:\path\to\file.ts` (#962)
- Default Git for Windows install path (`C:\Program Files\...`) rejected by regex (#1031)
- `checkIgnore()` returns extra quotes on Windows only (#1077)

**Architectural fragility:**
- Parses git's human-readable porcelain output via regex — not a stable API. Binary rename parsing fails (#885).
- `env()` replaces entire environment instead of merging — design-level bug (#1017)
- Zombie processes accumulate after remote operations on Alpine (#1062)

#### wasm-git — Too Raw, Too Constrained

**DX is poor:** C-style `callMain(['clone', url, dir])` — no idiomatic JS/TS API, no types, no structured errors.

**Browser constraints:** Requires `Cross-Origin-Opener-Policy` + `Cross-Origin-Embedder-Policy` headers. GitHub Pages cannot set these. SharedArrayBuffer mandatory for the OPFS variant.

**Bundle weight:** WASM binaries are 5-15 MB uncompressed. Not viable for web apps caring about load time.

#### nodegit — Dead Project

Last release: **v0.27.0, July 2020** — 6 years ago. 343 open issues, 21 open PRs, zero maintainer activity. No prebuilt binaries for Node 18+. Major projects (Azure SDK Tools, Adobe, Antora) have publicly migrated away.

### 14.3 Where tsgit Shines

```
                         Fast
                          │
              ┌───────────┼───────────┐
              │           │           │
              │     ┌─────┴─────┐     │
              │     │   tsgit   │     │
              │     └─────┬─────┘     │
              │           │           │
  Heavy ──────┼───────────┼───────────┼────── Lightweight
              │           │           │
              │           │           │
              │           │           │
              └───────────┼───────────┘
                          │
                         Slow

  Legend: tsgit targets the upper-right quadrant
          (fast + lightweight) that NO current library occupies.
```

| Dimension | Competitor Weakness | tsgit Advantage |
|---|---|---|
| **Performance** | isomorphic-git: 6-100x slow. simple-git: per-op process spawn. wasm-git: cold-start penalty. | Fanout binary search, LRU delta cache, zero-copy DataView parsing, streaming inflate, stat-cache, parallel I/O. Target: 3-5x faster than isomorphic-git. |
| **Architecture** | isomorphic-git: manual DI boilerplate, 3 failed extensibility models. simple-git: string-parsing unstable output. wasm-git: C-style shim. | FP-first with immutable data. Hexagonal architecture (ports & adapters). Object Calisthenics for domain. Single context object — create once, pass everywhere. |
| **DX / Types** | isomorphic-git: CJS/ESM masquerade, leaked errors, broken quick-start. simple-git: `@ts-ignore` needed. wasm-git: no types at all. | Branded types (`ObjectId`, `RefName`). Discriminated unions for all git objects. Exhaustive error codes. Correct CJS/ESM dual publish from day one. |
| **Testability** | isomorphic-git: no context object, opt-in cache. simple-git: requires git binary. wasm-git: Worker shim needed. | First-class `memory` adapter. All ports are interfaces — mockable individually. Pure functions — no global state, no singletons. |
| **Lightweight** | isomorphic-git: 4.78 MB, poor effective tree-shaking. wasm-git: 5-15 MB WASM. | Target < 150 kB gzipped full library. Real tree-shaking — each command is an independent entry point with minimal transitive deps. Zero runtime dependencies. |
| **Portability** | isomorphic-git: iOS SHA bugs, index checksum failures. simple-git: Node-only. wasm-git: COOP/COEP headers required. nodegit: dead. | Platform-optimized adapters (Node `crypto` / browser `SubtleCrypto`). Correct binary parsing with comprehensive roundtrip tests. OPFS with IndexedDB fallback — no special headers required. |

---

## 15. Naming & Branding

- **Package name**: `ts-git`
- **Tagline**: "Lightning-fast git, pure TypeScript, everywhere."
- **License**: MIT
