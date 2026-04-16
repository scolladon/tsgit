# Design

## Architecture

tsgit uses **hexagonal architecture** (ports & adapters) with a **tiered application layer**.

### Dependency Rule

```
repository.ts → application/commands/ → application/primitives/ → domain/
                                    ↘                           ↗
                                      ports/ ← adapters/
```

Dependencies flow one way, inward. The domain core has zero `import` statements pointing outward.

### Layers

| Layer | Location | Responsibility |
|---|---|---|
| **Domain** | `src/domain/` | Git objects (blob/tree/commit/tag), refs, git-index v2, packfile storage, delta resolution. Pure, zero outward dependencies. Branded types (`ObjectId`, `RefName`, `FilePath`, `FileMode`) enforce domain invariants. |
| **Application** | `src/application/` | Use cases. Commands (Tier 1) orchestrate primitives (Tier 2). |
| **Ports** | `src/ports/` | Interfaces only: `FileSystem` (16 methods, includes `readSlice` for random-access packfile reads and `writeExclusive` for lock files), `HashService` (with incremental `Hasher`), `Compressor`, `HttpTransport`, `ProgressReporter`, and `Context` (frozen record aggregating all ports + repo config + optional `AbortSignal`). |
| **Adapters** | `src/adapters/` | Platform implementations: `Node.js` (real filesystem with realpath-based path containment, `node:crypto`, `node:zlib`, `node:http`/`node:https` with TLS enforcement), `Browser` (OPFS with sandboxed path resolution, `SubtleCrypto`, `CompressionStream`, `fetch`), `Memory` (first-class test fixture with defensive copying, ELOOP-guarded symlink follow). |

### Two-Tier API

| Tier | Purpose | Entry Point |
|---|---|---|
| **Tier 1: Repository** | Ergonomic, discoverable, IDE-friendly | `import { openRepository } from 'tsgit'` |
| **Tier 2: Primitives** | Composable, lazy, tree-shakeable | `import { walkCommits } from 'tsgit/primitives'` |

Commands are built from primitives. Users can compose the same primitives into custom workflows.

### Design Principles

| Principle | Application |
|---|---|
| **FP-first** | Pure functions, immutable data, function composition |
| **Hexagonal** | Domain isolated from infrastructure via ports |
| **Object Calisthenics** | Branded types for domain concepts (ObjectId, RefName, FilePath) |
| **KISS** | Simple over clever. Profile first, optimize second. |
| **YAGNI** | Smallest useful API. No speculative features. |

### Performance Strategy

1. Fanout binary search for pack index lookups
2. LRU delta base cache (64 MB default)
3. Zero-copy parsing via DataView
4. Streaming inflate (native DecompressionStream / node:zlib)
5. Stat-cache for working tree (skip re-hashing unmodified files)
6. Platform-optimized hashing (SubtleCrypto / node:crypto)
7. Parallel I/O with configurable concurrency

### Security Properties (Phase 4)

Every `FileSystem` adapter enforces the following invariants via contract tests:

| Property | Mechanism |
|---|---|
| **Path containment** | Every path resolves to a location within the adapter's root. Escapes via `..`, sibling-directory string tricks (`/repo-evil` vs `/repo`), or symlinks pointing outside the root all throw `PERMISSION_DENIED`. |
| **Symlink-escape defense (Node)** | `checkContainment` uses `realpath` in 3 modes: read (full realpath), `lstat` (realpath parent only — preserves lstat semantics), creation (`realpathNearestExisting` + leaf symlink check). |
| **Lock file support** | `writeExclusive` (Node: `{ flag: 'wx' }`) provides atomic create-or-fail. Used by Phase 7+ ref/index update primitives. |
| **Error sanitization** | `extractDetail` strips directory components from path-bearing error messages via platform-agnostic `basename`. `NETWORK_ERROR` reason is a static string (never raw errno code). |
| **Defensive copying (Memory)** | Every `read`/`write` clones the `Uint8Array` — caller mutations cannot corrupt stored data. |
| **Symlink loop protection** | Memory adapter's symlink follower caps at 40 hops (POSIX `SYMLOOP_MAX`). |
| **TLS enforcement (Node HTTP)** | `http://` URLs rejected by default; opt-in via `allowInsecureHttp`. Certificate validation never disabled. |

See [docs/design/ports-and-adapters.md](docs/design/ports-and-adapters.md) for the full Phase 4 design and [docs/adr/004-adapter-error-in-domain.md](docs/adr/004-adapter-error-in-domain.md) for the error-ownership decision.

See [docs/prd/PRD.md](docs/prd/PRD.md) for the full architecture and competitive analysis.
