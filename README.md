# tsgit

[![CI](https://github.com/scolladon/tsgit/actions/workflows/ci.yml/badge.svg)](https://github.com/scolladon/tsgit/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@scolladon/tsgit)](https://www.npmjs.com/package/@scolladon/tsgit)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

**Lightning-fast git, pure TypeScript, everywhere.**

Pure TypeScript git — Node.js and the browser. Zero native deps. Zero WASM. Stable v1, semver-tracked — see [BACKLOG](docs/BACKLOG.md) for the roadmap.

## Install

```bash
npm install @scolladon/tsgit
```

## 60-second quickstart

```ts
import { openRepository } from '@scolladon/tsgit';

const repo = await openRepository({ cwd: process.cwd() });
const commits = await repo.log({ limit: 10 });
const { changes } = await repo.status();
await repo.dispose();
```

| Runtime | Import |
|---|---|
| Node.js | `@scolladon/tsgit` |
| Browser (OPFS) | `@scolladon/tsgit/auto/browser` |
| In-memory (tests) | `@scolladon/tsgit/auto/memory` |

→ [Full quickstart per runtime](docs/get-started/)

## One composition

Partial clone + transparent lazy-fetch on read + AsyncIterable streaming:

```ts
import { openRepository } from '@scolladon/tsgit';
import { pipe, filter, take } from '@scolladon/tsgit/operators';

const repo = await openRepository({ cwd: '/tmp/blobless' });
await repo.clone({ url: 'https://github.com/owner/repo.git', filter: 'blob:none' });

// Walk recent commits by author — blobs fetched only when actually read.
const recent = pipe(
  repo.primitives.walkCommits({ from: 'HEAD' }),
  filter(c => c.data.author.name === 'Alice'),
  take(5),
);
for await (const commit of recent) console.log(commit.data.message);
```

→ [More recipes](docs/use/recipes.md)

## Capabilities

**Foundations**
- Zero runtime dependencies — no transitive surface
- Pure TypeScript — no native code, no WASM, no `git` binary required
- Cross-runtime — Node 22+ · Browser (OPFS) · in-memory
- Tree-shakeable — `sideEffects: false`; each primitive is an independent entry
- CJS + ESM dual-publish, verified by `arethetypeswrong`

**Surface**
- 20+ AsyncIterable primitives — walkers, object readers/writers, ref store, ignore matcher
- Operator toolkit — `pipe`, `filter`, `map`, `flatMap`, `take`, `find`, `groupBy`, `toArray`

**Quality**
- 100% line/branch/function/statement coverage; mutation-tested every PR (per-OS nightly)
- Type-safe — branded `ObjectId`/`RefName`/`FilePath`, discriminated-union errors, no `any`
- Cross-platform CI — Ubuntu × macOS × Windows × Node 22/24; browser E2E on Chromium/Firefox/WebKit

→ [Commands](docs/use/commands/) · [primitives](docs/use/primitives/) · [recipes](docs/use/recipes.md)

## Why tsgit

What we optimize for, with current numbers.

**Design goals**
- Predictable lifetime — open once, validate once, abort cleanly
- Small bundle — Node entry under 60 KB gz (size-limit-enforced)
- Cross-runtime parity — same surface on every supported runtime
- Type safety — branded domain types, no `any`
- Reliability — 100% coverage, mutation-tested

**Current measured performance** (`darwin-arm64`, Node 22)

| Scenario | Median |
|---|---|
| `status:dirty-25-files` | 1.56 ms |
| `status:clean` | 1.95 ms |
| `clone:small-repo` | 39.5 ms |
| `readBlob:warm-cache` | 0.107 ms |
| `readBlob:cold-cache` | 0.162 ms |
| `log:walk-50-commits` | 6.4 ms |

Full results: [`reports/benchmarks/summary.md`](reports/benchmarks/summary.md).

→ [Performance methodology, targets, comparisons](docs/understand/performance.md)

## Documentation

- 📖 [Get started](docs/get-started/) — Node, browser, memory, migration from isomorphic-git
- 🛠️ [Use it](docs/use/) — commands, primitives, recipes, errors
- 🧠 [Understand it](docs/understand/) — architecture, design decisions, performance, security

## Contribute

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE)
