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
| **Ports** | `src/ports/` | Interfaces only: `FileSystem`, `HashService`, `Compressor`, `HttpTransport`, `SshTransport`, `ProgressReporter`, `HookRunner`, `PromisorRemote`, plus a `Context` record aggregating them all. |
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
| **Git-faithfulness (prime directive)** | Replicate canonical git's observable behaviour byte-for-byte — object SHAs, ref & reflog contents, on-disk state files, refusal conditions, message formats — unless an ADR explicitly diverges. See [Git-faithfulness](#git-faithfulness) below and [ADR-226](../adr/226-git-faithfulness-prime-directive.md). |
| **FP-first** | Pure functions, immutable data, function composition. |
| **Hexagonal** | Domain isolated from infrastructure via ports. |
| **Object Calisthenics for the domain** | Branded types for domain concepts; no primitives crossing boundaries. |
| **KISS** | Simple over clever. Profile first, optimise second. |
| **YAGNI** | Smallest useful API. No speculative features. |
| **Composition over reimplementation** | New commands MUST build on existing primitives. |

## Git-faithfulness

The prime directive ([ADR-226](../adr/226-git-faithfulness-prime-directive.md)):
tsgit replicates canonical git's **observable behaviour byte-for-byte** — object
SHAs, ref & reflog contents, on-disk state files (`sequencer/`, `MERGE_HEAD`,
`CHERRY_PICK_HEAD`, …), refusal conditions, and message formats — **unless an ADR
explicitly diverges and says why.**

It is enforced mechanically, not by review opinion — a divergence fails the build:

- **Cross-tool interop** (`test/integration/*-interop.test.ts`) invokes real `git`
  and asserts byte-parity ([ADR-137](../adr/137-interop-real-git-over-snapshot.md)).
- **Cross-adapter parity goldens** use the 40-hex commit id as the load-bearing
  signal ([ADR-128](../adr/128-golden-commit-id-as-parity-signal.md)).
- **The write-surface audit** forces every write surface to ship interop coverage
  ([ADR-204](../adr/204-porcelain-commands-as-write-surfaces.md)).

When in doubt, verify against real `git` (scrubbed `GIT_*`, isolated `HOME`,
`GIT_CONFIG_NOSYSTEM`, signing off) rather than guessing its behaviour. A deliberate divergence is permitted only when it
carries its own ADR recording what diverges and why
([ADR-206](../adr/206-log-message-returns-raw-body-with-trailing-newline.md) is the
template: a conscious, documented, interop-pinned divergence).

## Context

Every command and primitive takes a `Context` — a frozen record that carries:

- The adapter set (`fs`, `hash`, `compressor`, `transport`)
- The repository layout (`workDir`, `gitDir`, `bare`, `homeDir`)
- The progress reporter and `AbortSignal`
- The hash configuration (SHA-1 today; SHA-256 reserved for v4)
- The delta cache (LRU, configurable)
- The promisor remote (partial-clone lazy-fetch)
- Optionally the hook runner, config logger, and (Node only) an SSH transport

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

## Cross-adapter parity (test layer)

Every adapter implements the same `Repository` facade, but only end-to-end
byte-identical equality across them proves they truly agree. Phase 19.5
adds a cross-adapter parity test layer: each `test/parity/scenarios/*.scenario.ts`
declares one `Scenario<TResult>` (inputs + golden `expected` + a `run(repo,
inputs)` body), and three drivers — Node (`test/parity/node.test.ts`),
Memory (`test/parity/memory.test.ts`), and Browser/OPFS (`test/browser/parity.spec.ts`)
— run the scenario against their adapter and assert against the same
`expected`. The golden's 40-hex `commit.id` is the load-bearing signal
([ADR-128](../adr/128-golden-commit-id-as-parity-signal.md)): a single
non-deterministic byte anywhere in object serialization, hash framing, or
author-identity encoding mutates the SHA-1 and the assertion fails.

A determinism lint (`npm run check:parity-fixtures`) bans `Date.now()` /
`Math.random` / unpinned `new Date(...)` inside scenario files so the
constants stay reproducible across runs and runners. The Browser driver
crosses the `page.evaluate` boundary by name lookup against
`window.__tsgitParity`, populated by a small bundled module
([ADR-127](../adr/127-parity-scenarios-bundled-not-serialized.md)).

Phase 19.5a closes the loop with a **browser-surface coverage audit**
(`npm run check:browser-surface`): it parses `src/repository.ts` for
every bound command / primitive, scans `test/browser/*.spec.ts` and
`test/parity/scenarios/*.ts` for `repo.<name>(` and
`repo.primitives.<name>(` call sites, and exits non-zero if any name is
neither covered nor named in the
`tooling/audit-browser-surface.allowlist.json` exemption file. The gate
is blocking ([ADR-132](../adr/132-browser-surface-audit-blocking-gate.md)):
binary signal, no warn-only grace period. The opening allowlist holds
the four transport commands (`clone` / `fetch` / `push` /
`fetchMissing` — exercised by the network integration suite, not the
browser parity surface) and `runHook` (structurally Node-only;
[ADR-133](../adr/133-transport-and-runHook-exemptions.md)).

The audit is **namespace-aware**: nested-namespace commands bound as
`readonly X: commands.XNamespace` (`config`, `remote`, `branch`, `tag`,
`sparseCheckout`, `stash`) are parsed as tier-1 commands, and dotted
`repo.<namespace>.<verb>(` call sites count as coverage at namespace
granularity — one verb call covers the namespace, mirroring how the
doc-coverage audit maps one page per namespace. `config` carries a
dedicated parity scenario rather than an allowlist entry, because
local-scope config is fully browser-capable
([ADR-195](../adr/195-config-parity-scenario-over-allowlist.md)).

Property-based tests sit alongside the example-based suite as
`*.properties.test.ts` siblings co-located with per-family
`arbitraries.ts` (added in Phase 19.6 across `header`, `file-mode`,
`index-parser`, `compile-pathspec`/`match-pathspec` and
`parse-gitignore`/`matcher-stack`). Properties are additive — they
never replace example tests ([ADR-136](../adr/136-properties-additive-not-replacing-examples.md)) —
and use a tiered `numRuns` budget (200/100/50, [ADR-135](../adr/135-tiered-numruns-budget.md)).

## ADRs

For the receipts behind each major design choice, see [`design-decisions.md`](design-decisions.md) — a curated, subsystem-grouped index of the [ADR collection](../adr/).
