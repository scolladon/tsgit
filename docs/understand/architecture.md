# Architecture

This document explains what tsgit is built out of and why the layers look the way they do. The bottom line first: tsgit uses **hexagonal architecture** (ports & adapters) with a **tiered application layer**, immutable data, and pure-function composition.

## Dependency rule

```
repository → application/commands → application/primitives → domain
                                  ↘                        ↗
                                    ports ← adapters
```

Dependencies flow one way, inward. The domain core has zero `import` statements pointing outward. Adapters live at the periphery — they depend on ports, never the other way around.

## Layers

| Layer | Location | Responsibility |
|---|---|---|
| **Domain** | `src/domain/` | Git objects (blob / tree / commit / tag), refs, git-index v2/v3, packfile storage, delta resolution. Pure, zero outward deps. Branded types (`ObjectId`, `RefName`, `FilePath`, `FileMode`) enforce domain invariants. |
| **Application** | `src/application/` | Use cases. Commands (Tier 1) orchestrate primitives (Tier 2). |
| **Ports** | `src/ports/` | Interfaces only: `FileSystem`, `HashService`, `Compressor`, `HttpTransport`, `ProgressReporter`, `HookRunner`, `PromisorRemote`, plus a `Context` record aggregating them all. |
| **Adapters** | `src/adapters/` | Platform implementations: `Node.js` (real filesystem with realpath-based path containment), `Browser` (OPFS + SubtleCrypto + fetch), `Memory` (first-class test fixture with defensive copying). |

## Tiered API

| Tier | Purpose | Entry point |
|---|---|---|
| **Tier 1 — Repository** | Ergonomic, discoverable, IDE-friendly | `import { openRepository } from '@scolladon/tsgit'` |
| **Tier 2 — Primitives** | Composable, lazy, tree-shakeable building blocks | `import { walkCommits } from '@scolladon/tsgit/primitives'` |

Commands are built from primitives. Users compose the same primitives into custom workflows.

See [`../use/commands/`](../use/commands/) and [`../use/primitives/`](../use/primitives/) for the surface.

## Design principles

| Principle | Application |
|---|---|
| **FP-first** | Pure functions, immutable data, function composition. |
| **Hexagonal** | Domain isolated from infrastructure via ports. |
| **Object Calisthenics for the domain** | Branded types for domain concepts; no primitives crossing boundaries. |
| **KISS** | Simple over clever. Profile first, optimize second. |
| **YAGNI** | Smallest useful API. No speculative features. |
| **Composition over reimplementation** | New commands MUST build on existing primitives. |

## Context

Every command and primitive takes a `Context` — a frozen record that carries:

- The adapter set (`fs`, `hash`, `compressor`, `transport`)
- The repository layout (`workDir`, `gitDir`, `bare`, `homeDir`)
- The progress reporter and `AbortSignal`
- The hash configuration (SHA-1 today; SHA-256 reserved for v4)
- The delta cache (LRU, configurable)
- The promisor remote (partial-clone lazy-fetch)
- Optionally the hook runner and config logger

`openRepository` constructs one `Context`, validates every option once, and binds every command to it. Subsequent calls inherit the configured state — no per-call `{ fs, dir }` re-derivation.

## Subsystems

| Subsystem | Location | What lives here |
|---|---|---|
| **Domain: objects** | `src/domain/objects/` | Blob, tree, commit, tag parsers + serializers; branded value objects. |
| **Domain: storage** | `src/domain/objects-storage/` | Loose objects, packfiles (v2), delta resolution (`OBJ_REF_DELTA` / `OBJ_OFS_DELTA`). |
| **Domain: refs** | `src/domain/refs/` | Loose refs, packed-refs, symbolic refs, peeling. |
| **Domain: index** | `src/domain/git-index/` | Git index v2/v3 parser (v3 carries skip-worktree / intent-to-add). |
| **Domain: diff & merge** | `src/domain/diff-and-merge/` | Tree comparison, three-way merge, conflict representation. |
| **Domain: reflog** | `src/domain/reflog/` | Append-only per-ref logs; `@{N}` / `@{date}` resolution (approxidate subset). |
| **Domain: sparse** | `src/domain/sparse/` | Cone / non-cone pattern parsing, matching, serialization. |
| **Hooks** | `src/ports/hook-runner.ts`, `src/adapters/node/node-hook-runner.ts` | `pre-commit` / `commit-msg` / `pre-push` script execution. |
| **Partial clone** | `src/domain/protocol/object-filter.ts`, `src/application/commands/fetch-missing.ts` | `--filter` parsing, promisor remote port, lazy-fetch on read. |
| **Submodules** | `src/application/primitives/walk-submodules.ts`, `src/application/commands/submodules.ts` | Tree-ish gitlink walk + `.gitmodules` join, recursive into absorbed nested gitdirs. |
| **Cat-file batch** | `src/application/primitives/cat-file-batch.ts`, `src/application/commands/cat-file.ts` | Streaming `git cat-file --batch` equivalent. |
| **Ports** | `src/ports/` | Interfaces for I/O and platform abstraction. |
| **Adapters** | `src/adapters/{node,browser,memory}/` | Platform implementations. |
| **Primitives** | `src/application/primitives/` | Tier-2 composable low-level operations. |
| **Commands** | `src/application/commands/` | Tier-1 high-level use cases. |

## Performance strategy

See [`performance.md`](performance.md) for measured numbers. The strategy:

1. Fanout binary search for pack index lookups.
2. LRU delta base cache (16 MiB default).
3. Zero-copy parsing via `DataView`.
4. Streaming inflate (native `DecompressionStream` / `node:zlib`).
5. Stat-cache for working tree (skip re-hashing unmodified files).
6. Platform-optimised hashing (`SubtleCrypto` / `node:crypto`).
7. Parallel I/O with bounded concurrency.

## Security properties

See [`security.md`](security.md) for the full table. Highlights:

- **Path containment** — every path resolves to a location inside the adapter's root. Escapes via `..`, sibling-directory string tricks, or symlinks pointing outside the root all throw `PERMISSION_DENIED`.
- **Lock files** — `writeExclusive` (`{ flag: 'wx' }`) provides atomic create-or-fail. Used by ref / index update primitives.
- **TLS enforcement** — `http://` rejected by default; opt-in via `allowInsecureHttp`. Certificate validation never disabled.
- **Defensive copying** in the Memory adapter — every read / write clones the `Uint8Array`.
- **Symlink loop protection** — Memory adapter caps at 40 hops (POSIX `SYMLOOP_MAX`).

## ADRs

For the receipts behind each major design choice, see [`design-decisions.md`](design-decisions.md) — a curated, subsystem-grouped index of the [ADR collection](../adr/).
