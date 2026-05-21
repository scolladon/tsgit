# tsgit

[![CI](https://github.com/scolladon/tsgit/actions/workflows/ci.yml/badge.svg)](https://github.com/scolladon/tsgit/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@scolladon/tsgit)](https://www.npmjs.com/package/@scolladon/tsgit)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

Lightning-fast git, pure TypeScript, everywhere.

A pure TypeScript git implementation designed to be the fastest portable git library available. Runs identically on Node.js (Windows, macOS, Linux), browsers, and edge runtimes — with zero native dependencies, zero WASM, and zero compromises on developer experience.

## Status

**v1.0.0-rc — production-ready surface.** All 11 phases (Domain → Repository facade → Polish & Launch) are implemented with 100% line/branch/function/statement coverage and mutation-verified test quality. The pre-publish workflow validates the tarball on every `v*` tag; release-please drives the npm publish.

| Phase | Scope | Status |
|---|---|---|
| 1 | Domain — Object Model (blob, tree, commit, tag, refs) | ✅ |
| 2 | Domain — Object Storage (loose objects, packfiles, delta) | ✅ |
| 3 | Domain — Refs & Index (loose refs, packed-refs, git index v2) | ✅ |
| 4 | Ports & Adapters (FileSystem, HashService, Compressor, HttpTransport, ProgressReporter — Node + Browser/OPFS + Memory) | ✅ |
| 5 | Domain — Diff & Merge | ✅ |
| 6 | Operators (AsyncIterable composition) | ✅ |
| 7 | Primitives (Tier 2 API) | ✅ |
| 8 | Transport (Smart HTTP + middleware) | ✅ |
| 9 | Commands (Tier 1 API) | ✅ |
| 10 | Repository facade | ✅ |
| 11 | Polish & Launch (CI matrix, browser E2E, benchmarks, TypeDoc, MIGRATION) | ✅ |
| 12.1 | Clone — smart-HTTP pack fetch + write-objects loop | ✅ |
| 12.2 | Fetch — ls-refs + want/have negotiation + shallow + prune | ✅ |
| 12.3 | Push — receive-pack negotiation + pack send + force-with-lease | ✅ |
| 12.4 | Bench — `clone:small-repo` vs isomorphic-git over `git-http-backend` | ✅ |
| 13.1 | Working-tree materialisation — `checkout` writes / deletes / chmods files; index + HEAD updated atomically per file | ✅ |
| 13.2 | `reset --mixed` rebuilds `.git/index` from the target commit's tree under `index.lock`; stat-cache preserved for unchanged paths | ✅ |
| 13.3 | `reset --hard` materialises both index and working tree to match the target commit's tree; force-rewrites locally-modified files | ✅ |
| 13.5 | `checkout` acquires `index.lock` before reading the index — closes a known TOCTOU window; path-restore from `'index'` stays lock-free | ✅ |
| 13.6 | `checkout({ paths, source: 'index' })` synthesises a tree from staged entries — restores from index content, honouring divergence from HEAD | ✅ |
| 14.4 | Full Windows support — 8.3 short-name reconciliation in `NodeFileSystem.checkContainment`, `ELOOP`/`EACCES` errno parity, `windows-latest` re-added to the unit-test matrix | ✅ |
| 17.1 | Reflog — `HEAD@{N}` / `<ref>@{N}` syntax, `.git/logs/` append-only per-ref entries, `revParse` resolution, tier-1 `reflog` command (show/exists/delete/expire) | ✅ |

## Features

- **Lightning fast** — 3-5x faster than isomorphic-git via fanout binary search, LRU delta cache, zero-copy parsing, streaming inflate
- **Portable** — Runs on Node.js 18+, Chrome 90+, Firefox 100+, Safari 15.4+, Deno, Bun, Cloudflare Workers
- **Lightweight** — < 200 kB gzipped full library. Zero runtime dependencies. Tree-shakeable.
- **Two-tier API** — Ergonomic repository object for common operations + composable AsyncIterable primitives for power users
- **Type-safe** — Branded types, discriminated unions, exhaustive error codes. No `any`.
- **Testable** — First-class in-memory adapter. All ports are mockable. Pure functions throughout.

## Installation

```bash
npm install @scolladon/tsgit
```

## Quick Start

### Node.js

```typescript
import { openRepository } from '@scolladon/tsgit';

const repo = await openRepository({ cwd: process.cwd() });

const commits = await repo.log();
const changes = await repo.status();

await repo.dispose();
```

`openRepository` is a frozen handle exposing every command and primitive bound
to a single `Context`. The Node entry point auto-detects an existing `.git`
directory by walking up from `cwd`.

### Browser

```typescript
import { openRepository } from '@scolladon/tsgit/auto/browser';

const rootHandle = await navigator.storage.getDirectory();
const repo = await openRepository({ rootHandle });

await repo.init();
```

Browser callers must supply an OPFS `rootHandle` since there is no
`process.cwd()` equivalent.

### In-memory (deterministic / tests)

```typescript
import { openRepository } from '@scolladon/tsgit/auto/memory';

const repo = await openRepository({
  files: { '/repo/seed.txt': new TextEncoder().encode('hello') },
});

await repo.init();
```

### Cloning a remote

```typescript
import { openRepository } from '@scolladon/tsgit';

const repo = await openRepository({
  cwd: '/tmp/my-clone',
  config: {
    dnsResolver: async (host) => (await import('node:dns')).promises.resolve(host),
  },
});

const result = await repo.clone({
  url: 'https://github.com/owner/repo.git',
  resolver: async (host) => (await import('node:dns')).promises.resolve(host),
});

console.log(result.head); // refs/heads/main
console.log(result.fetchedRefs.length); // total refs propagated
```

Phase 12.1 gives you a valid `.git` directory whose `git log` matches the
remote's HEAD line. To materialise the working tree, run
`repo.checkout({ target: result.head })` immediately after — Phase 13.1
writes every blob, sets the executable bit, follows symlinks, and commits a
matching `.git/index` atomically. See
`test/integration/network/clone-http-backend.test.ts` for an end-to-end
example against a local `git-http-backend`.

### Staging files

```typescript
// Literal paths.
await repo.add(['src/foo.ts', 'src/bar.ts']);

// Pathspec globs (Phase 14.2). Any pattern with `*`, `?`, or `**` is a
// glob; everything else is a literal that also matches descendants.
// `!`-prefixed entries exclude. Last-match wins.
await repo.add(['*.ts', '!*.test.ts']);   // every .ts minus tests
await repo.add(['src/**']);               // everything under src/

// Bulk mode — walk the working tree, stage every modified/new file plus
// every untracked file that isn't ignored, drop tracked files missing
// from disk. `paths` MUST be empty when `all: true`.
const result = await repo.add([], { all: true });
console.log(result.added);    // new staged paths (sorted)
console.log(result.modified); // changed paths (sorted)
console.log(result.removed);  // tracked paths gone from disk (sorted)
```

`repo.rm` and `repo.checkout({ paths })` accept the same pathspec
syntax. A literal pattern that matches nothing throws
`PATHSPEC_NO_MATCH`; a glob that matches nothing is a silent no-op
(matches Git's behaviour). Pathspec syntax is `*`, `?`, `**`, and
`!` negation; character classes (`[abc]`) and Git magic prefixes
(`:(top)`, `:(literal)`) are not supported in v1.

Phase 14.1 ships bulk-mode `add --all` walking via the new
`walkWorkingTree` primitive. The host repository's `.git` is skipped, and
embedded clones (directories containing a `.git` child) are not
auto-staged — matches Git's default. Symlinks stage as mode `120000`
with the link target as blob content. Files larger than
`MAX_WORKING_TREE_BLOB_BYTES` (256 MiB) reject with
`WORKING_TREE_FILE_TOO_LARGE` and no partial index commit.

Phase 14.3 wires `.gitignore` evaluation across `add --all` AND `status`:

- **Sources (last match wins):** `core.excludesFile` (from git config,
  `~`-expanded against `ctx.layout.homeDir`) → `.git/info/exclude` →
  repo-root `.gitignore` → nested `.gitignore` per directory.
- **Walk-time pruning:** ignored directories are skipped without
  lstat-ing their contents — big perf win on `node_modules`, `dist`,
  etc.
- **Tracked-but-ignored stays tracked:** a path already in the index
  is preserved across re-adds even if a new ignore rule would match
  it (or its parent directory). Git's invariant.
- **`status` emits `'untracked'`:** non-ignored working-tree files
  not in the index now appear as `{ kind: 'untracked', path }` and
  `status.clean` reflects them.
- **`.gitignore` size cap:** 1 MiB per file (`MAX_GITIGNORE_BYTES`).
  Reject with `GITIGNORE_FILE_TOO_LARGE`.

### Push

```typescript
const result = await repo.push({
  remote: 'origin',
  refspecs: ['refs/heads/main:refs/heads/main'],
  // optional: force-with-lease against the cached remote-tracking ref
  // forceWithLease: 'auto',
});

for (const r of result.pushedRefs) {
  console.log(r.name, r.status, r.reason ?? ''); // 'refs/heads/main' 'ok'
}
```

Phase 12.3 supports `<src>:<dst>`, `+<src>:<dst>`, `:<dst>` (delete), short-form
branch names, and `HEAD` as a source. Force-with-lease accepts either an explicit
`ObjectId` or `'auto'` (resolves to the cached `refs/remotes/<remote>/<branch>`).
A successful push updates the local remote-tracking cache for accepted refs.
See `test/integration/network/push-http-backend.test.ts` for an end-to-end
example.

### Progress reporting

```typescript
import { openRepository, consoleProgress } from '@scolladon/tsgit';

const repo = await openRepository({
  progress: consoleProgress((line) => console.log(line)),
});
```

### Cancellation

```typescript
const controller = new AbortController();
const repo = await openRepository({ signal: controller.signal });
controller.abort(); // every bound method now throws REPOSITORY_DISPOSED
```

### Composable Primitives

```typescript
import { walkCommits } from '@scolladon/tsgit/primitives';
import { pipe, filter, take } from '@scolladon/tsgit/operators';

const recentByAlice = walkCommits(ctx, { from: 'main' })
  |> filter(c => c.data.author.name === 'Alice')
  |> take(5);

for await (const commit of recentByAlice) {
  console.log(commit.data.message);
}
```

### Reflog — Navigate ref history

Every ref movement records an entry in `.git/logs/<ref>` — the reflog. Query it by index or date:

```typescript
// Show the reflog for a branch
const result = await repo.reflog({ ref: 'main' });
for (const entry of result.entries) {
  console.log(`${entry.selector}: ${entry.entry.message}`);
}

// Resolve a ref to its value from N moves ago (or at a specific date)
const commitId = await repo.revParse('main@{2}');     // 2 moves back
const commitId = await repo.revParse('main@{yesterday}'); // at yesterday 00:00 local time

// Delete or expire reflog entries
await repo.reflog({ action: 'delete', ref: 'main', index: 0 });
await repo.reflog({ action: 'expire', all: true, expire: '90.days.ago' });
```

## Benchmarks

Comparison against `isomorphic-git@1.38` on a synthetic 50-commit repo. Numbers
are medians from `vitest bench`; ±RME and full p99 distribution live in
`reports/benchmarks/raw.json`.

| Scenario | tsgit | isomorphic-git | tsgit speedup |
|---|---|---|---|
| `status:clean` | ~1.7 ms | ~4.0 ms | ~2.4× |
| `status:dirty-25-files` | ~1.7 ms | ~3.7 ms | ~2.2× |
| `log:walk-50-commits` | ~6 ms | ~4 ms | ~0.7× |
| `readBlob:warm-cache` | ~0.1 ms | ~0.1 ms | ~1.0× |
| `clone:small-repo` | ~40 ms | ~40 ms | ~1.0× |

Reproduce locally with `npm run bench:summary` (writes `reports/benchmarks/summary.md`).
GitHub Actions runners introduce ±20% variance — trust direction more than
absolute numbers.

## Architecture

Hexagonal architecture with a tiered application layer:

- **Domain** — Pure git objects, parsers, serializers, refs, index. Zero outward dependencies.
- **Application** — Commands (Tier 1) built from Primitives (Tier 2).
- **Ports** — Interfaces for `FileSystem`, `HashService`, `Compressor`, `HttpTransport`, `ProgressReporter` + a `Context` record that threads them through every call.
- **Adapters** — `Node.js` (node:fs/crypto/zlib/http), `Browser` (OPFS + SubtleCrypto + fetch + CompressionStream), `Memory` (first-class test fixture — primary test double for every upstream phase).

See [docs/prd/PRD.md](docs/prd/PRD.md) for the full product requirements document, [docs/design/ports-and-adapters.md](docs/design/ports-and-adapters.md) for the Phase 4 port contracts, and [docs/adr/](docs/adr/) for architecture decisions.

## Development

```bash
npm install
npm run validate     # Run all checks + tests
npm run check        # Lint + format (biome)
npm run check:types  # Type check (tsc)
npm run test:unit    # Unit tests
npm run test:coverage # With 100% coverage enforcement
npm run test:mutation # Mutation testing (stryker)
npm run build        # Compile to dist/
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development guidelines, test conventions, and the PR workflow.

## License

[MIT](LICENSE)
