# tsgit

[![CI](https://github.com/scolladon/tsgit/actions/workflows/ci.yml/badge.svg)](https://github.com/scolladon/tsgit/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/tsgit)](https://www.npmjs.com/package/tsgit)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

Lightning-fast git, pure TypeScript, everywhere.

A pure TypeScript git implementation designed to be the fastest portable git library available. Runs identically on Node.js (Windows, macOS, Linux), browsers, and edge runtimes — with zero native dependencies, zero WASM, and zero compromises on developer experience.

## Status

**Phases 1–7 complete.** Domain (objects, storage, refs, index), hexagonal boundary (ports + adapters), diff/merge, AsyncIterable operators, and the Tier-2 primitives (`readObject`, `writeObject`, `readTree`, `writeTree`, `readBlob`, `walkCommits`, `walkTree`, `resolveRef`, `updateRef`, `readIndex`, `createCommit`, `diffTrees`) are implemented with 100% test coverage and mutation-verified test quality. Phase 8 (Transport) is next.

| Phase | Scope | Status |
|---|---|---|
| 1 | Domain — Object Model (blob, tree, commit, tag, refs) | ✅ |
| 2 | Domain — Object Storage (loose objects, packfiles, delta) | ✅ |
| 3 | Domain — Refs & Index (loose refs, packed-refs, git index v2) | ✅ |
| 4 | Ports & Adapters (FileSystem, HashService, Compressor, HttpTransport, ProgressReporter — Node + Browser/OPFS + Memory) | ✅ |
| 5 | Domain — Diff & Merge | ✅ |
| 6 | Operators (AsyncIterable composition) | ✅ |
| 7 | Primitives (Tier 2 API) | ✅ |
| 8 | Transport (Smart HTTP + middleware) | ⏳ |
| 9 | Commands (Tier 1 API) | ⏳ |
| 10 | Repository facade | ⏳ |
| 11 | Polish & Launch | ⏳ |

## Features

- **Lightning fast** — 3-5x faster than isomorphic-git via fanout binary search, LRU delta cache, zero-copy parsing, streaming inflate
- **Portable** — Runs on Node.js 18+, Chrome 90+, Firefox 100+, Safari 15.4+, Deno, Bun, Cloudflare Workers
- **Lightweight** — < 150 kB gzipped full library. Zero runtime dependencies. Tree-shakeable.
- **Two-tier API** — Ergonomic repository object for common operations + composable AsyncIterable primitives for power users
- **Type-safe** — Branded types, discriminated unions, exhaustive error codes. No `any`.
- **Testable** — First-class in-memory adapter. All ports are mockable. Pure functions throughout.

## Installation

```bash
npm install tsgit
```

## Quick Start

### Node.js

```typescript
import { openRepository } from 'tsgit';
import { nodeAdapter } from 'tsgit/adapters/node';

const repo = openRepository({ adapter: nodeAdapter, dir: '.' });

const commits = await repo.log({ depth: 10 });
const changes = await repo.status();
```

### Browser

```typescript
import { openRepository } from 'tsgit';
import { browserAdapter } from 'tsgit/adapters/browser';

const repo = openRepository({ adapter: browserAdapter, dir: '/' });

await repo.clone({ url: 'https://github.com/user/repo' });
```

### Composable Primitives

```typescript
import { walkCommits } from 'tsgit/primitives';
import { pipe, filter, take } from 'tsgit/operators';

const recentByAlice = walkCommits(ctx, { from: 'main' })
  |> filter(c => c.data.author.name === 'Alice')
  |> take(5);

for await (const commit of recentByAlice) {
  console.log(commit.data.message);
}
```

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
