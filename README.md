# tsgit

[![CI](https://github.com/scolladon/tsgit/actions/workflows/ci.yml/badge.svg)](https://github.com/scolladon/tsgit/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/tsgit)](https://www.npmjs.com/package/tsgit)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

Lightning-fast git, pure TypeScript, everywhere.

A pure TypeScript git implementation designed to be the fastest portable git library available. Runs identically on Node.js (Windows, macOS, Linux), browsers, and edge runtimes — with zero native dependencies, zero WASM, and zero compromises on developer experience.

## Status

**Phase 1 (Domain Object Model) is complete.** All git object types (blob, tree, commit, tag) have full parse/serialize support with branded types, discriminated unions, and 100% test coverage. Phase 2 (Object Storage) is next.

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

- **Domain** — Pure git objects, parsers, serializers. Zero outward dependencies.
- **Application** — Commands (Tier 1) built from Primitives (Tier 2).
- **Ports** — Interfaces for FileSystem, HttpTransport, HashService, Compressor.
- **Adapters** — Node.js, Browser (OPFS), Memory (testing).

See [docs/prd/PRD.md](docs/prd/PRD.md) for the full product requirements document.

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
