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
| **Domain** | `src/domain/` | Git objects, parsers, serializers, delta resolution, merge engine. Pure, zero dependencies. |
| **Application** | `src/application/` | Use cases. Commands (Tier 1) orchestrate primitives (Tier 2). |
| **Ports** | `src/ports/` | Interfaces only. FileSystem, HttpTransport, HashService, Compressor. |
| **Adapters** | `src/adapters/` | Platform implementations: Node.js, Browser, Memory (test). |

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

See [docs/prd/PRD.md](docs/prd/PRD.md) for the full architecture and competitive analysis.
