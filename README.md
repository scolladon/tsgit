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
const { clean, branch, indexChanges, workingTreeChanges } = await repo.status();
await repo.dispose();
```

| Runtime | Import |
|---|---|
| Node.js | `@scolladon/tsgit` |
| Browser (OPFS) | `@scolladon/tsgit/auto/browser` |
| In-memory (tests) | `@scolladon/tsgit/auto/memory` |

→ [Full quickstart per runtime](docs/get-started/) · [recipes — partial clone, sparse checkout, hooks, …](docs/use/recipes.md)

## Capabilities

- Zero runtime dependencies — no transitive surface
- Pure TypeScript — no native code, no WASM, no `git` binary required
- Cross-runtime — Node 22+ · Browser (OPFS) · in-memory
- Tree-shakeable — `sideEffects: false`; each primitive is an independent entry
- CJS + ESM dual-publish, verified by `arethetypeswrong`
- 21 Tier-1 commands · 20+ AsyncIterable primitives · operator toolkit (`pipe`, `filter`, `map`, …)
- Type-safe — branded `ObjectId`/`RefName`/`FilePath`, discriminated-union errors, no `any`
- AbortSignal lifetime — `repo.dispose()` cancels in-flight work

→ [Commands](docs/use/commands/) · [primitives](docs/use/primitives/) · [errors](docs/use/errors.md)

## Documentation

- 📖 [Get started](docs/get-started/) — Node, browser, memory, migration from isomorphic-git
- 🛠️ [Use it](docs/use/) — commands, primitives, recipes, errors
- 🧠 [Understand it](docs/understand/) — architecture, design decisions, performance, security

## Contribute

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE)
