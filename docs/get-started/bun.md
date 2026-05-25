# Get started — Bun

tsgit ships as a regular npm package and Bun installs it via `bun add`.
Bun's Node-compatibility surface covers every Node builtin the Node
adapter uses, so commands that work in Node 22+ work in Bun unmodified.

## Prerequisites

- Bun 1.1+ (`bun --version`)
- A directory containing a `.git` folder (or any ancestor of one) —
  same as the Node story

## Install

```bash
bun add @scolladon/tsgit
```

## Open a repository

```ts
import { openRepository } from '@scolladon/tsgit';

const repo = await openRepository({ cwd: process.cwd() });
const commits = await repo.log({ limit: 10 });
const status = await repo.status();
await repo.dispose();
```

`openRepository` walks up from `cwd` for a `.git` directory exactly as
in Node — Bun's `node:fs/promises` polyfill makes the walk transparent.

## Running with `bun run` vs `bun test`

- `bun run script.ts` — production-style execution. Same import
  semantics as Node.
- `bun test` — Bun's built-in Jest-compatible test runner. Imports work
  via `import { describe, expect, test } from 'bun:test'`.

## In-memory mode (no filesystem)

```ts
import { openRepository } from '@scolladon/tsgit/auto/memory';

const repo = await openRepository({
  files: { '/repo/README.md': new TextEncoder().encode('hello\n') },
});
```

Same shape as in Node — the in-memory adapter is fully portable.

## Parity with Node

The runtime-parity matrix (CI job `parity-bun`) runs the exact same ten
scenarios that exercise the Node adapter, against the dist artifact
loaded by Bun. The matrix is blocking — a Bun regression is caught at
PR time.
