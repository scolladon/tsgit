# ADR-122: Integration-test bucket taxonomy

## Status

Accepted (at `9b109c1fecccf317fc4b017127fe6bedf849b26c`)

## Context

Phase 19.4 forces every integration test to declare a bucket — the single justification for the file's existence at the integration tier rather than at the unit tier. The bucket value drives duplicate detection ([ADR-123](123-integration-duplicate-detection.md)) and bucket-directory placement ([ADR-124](124-integration-usefulness-heuristic-shape.md)).

The current 21 integration files fall into roughly these flavours (manual survey):

- Real Node `fs` against a tmpdir (`submodules.test.ts`).
- Real HTTP socket against `git-http-backend` (`network/*`).
- Real subprocess (`posix-only/node-hook*.test.ts`).
- Round-trip against canonical `git` (`reflog-writers.test.ts`).
- POSIX/NTFS-bound behaviour (`posix-only/node-fs-*`, `win-only/*`).
- End-to-end through the memory adapter (`adapter-domain-interop`, `add-all`, `gitignore-end-to-end`, `sparse-*`).
- Code path the unit suite can't reach (`node-shim.test.ts`).

A flatter taxonomy (e.g. "real-IO" vs "memory") would collapse these flavours and lose discriminating power. A richer taxonomy (more than ten buckets) would invite bucket-bikeshedding for every new file.

## Decision

Seven buckets, exhaustive and disjoint:

| Bucket | What only this tier can prove |
|---|---|
| `real-fs` | Real Node `fs` semantics against a tmpdir, OS-agnostic behaviour. |
| `real-http` | Real HTTP socket against canonical `git-http-backend`. |
| `real-process` | Real `child_process.spawn` against canonical `git` or hook binary. |
| `cross-tool-interop` | Bytes on disk round-trip against canonical `git`. |
| `platform-only` | Behaviour exists on one OS only (POSIX permissions, NTFS junctions, etc). |
| `multi-adapter-parity` | End-to-end command flow through the memory adapter locking domain/adapter composition. |
| `coverage-gap` | Code path the unit suite cannot reach (e.g. the Node runtime shim that constructs adapters). |

`real-fs` and `multi-adapter-parity` look superficially close but mean opposite things: the first proves OS interop, the second proves *our* composition. The two are kept disjoint for duplicate detection.

`cross-tool-interop` and `platform-only` likewise look close to `real-fs`/`real-http` but mean different things: interop with the canonical tool / behaviour-bound-to-one-OS is the *reason* the file exists, distinct from the I/O surface it uses.

The bucket enum is data-driven (`test-pyramid-budgets.json#heuristics.integrationProof.buckets`). Adding a bucket later is a manifest change + audit re-run; no code change.

## Consequences

### Positive

- **Every reviewer sees the same justification model.** A new integration test gets bucketed during code review, not "let's figure it out later".
- **Disjoint buckets enable duplicate detection.** Two files claiming `(clone, real-http)` are duplicates; two files claiming `(clone, real-http)` and `(clone, cross-tool-interop)` are not (the first proves we speak HTTP, the second proves we write bytes the canonical tool reads). The audit can mechanise this only because the buckets don't overlap.
- **Coverage-gap is named, not hidden.** `node-shim.test.ts` exists for one reason — it's the only path that exercises the runtime adapter wiring. Calling that bucket out by name prevents "let's add more shim tests" requests; the bucket size is the gap size.

### Negative

- **A future test may justifiably belong in two buckets.** `reflog-writers.test.ts` is both real-fs (writes to tmpdir) and cross-tool-interop (cross-checks with `git`). The grammar forces one primary justification; the secondary lives in the prose. ADR-122 can be revised later if multi-bucket tests become common.
- **Seven buckets is more vocabulary than a binary "real-IO vs memory" split.** Mitigated by the fact that every existing file naturally claims exactly one bucket — the discrimination is real, not invented.

### Neutral

- **Bucket boundaries between `real-fs` and `multi-adapter-parity` require judgment.** The distinction is "are we proving the OS interop or our own composition?" — that's a question the test author can usually answer; if not, the prose can carry the rationale. Future ADRs can sharpen the boundary.
