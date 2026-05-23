# Get started — Browser

You'll have a working tsgit handle backed by [OPFS](https://web.dev/articles/origin-private-file-system) inside a browser tab in under a minute.

## Prerequisites

- A modern browser: Chrome 102+, Firefox 111+, Safari 17.4+ (any browser shipping the [Origin Private File System](https://developer.mozilla.org/docs/Web/API/File_System_API/Origin_private_file_system) API).
- A secure context — `https://` or `http://localhost`.
- A bundler that respects the `browser` export condition (Vite, esbuild, Webpack 5+, Rollup, Parcel — all defaults).

## Install

```bash
npm install @scolladon/tsgit
```

The package's `"exports"` resolves the browser entry automatically when your bundler runs under the `browser` condition.

## Open a repository

The browser has no `process.cwd()` equivalent, so you must supply an OPFS `FileSystemDirectoryHandle`:

```ts
import { openRepository } from '@scolladon/tsgit/auto/browser';

const rootHandle = await navigator.storage.getDirectory();
const repo = await openRepository({ rootHandle });
```

`getDirectory()` returns the OPFS root for the page's origin. Each origin gets its own sandbox; nothing escapes it.

## Clone a remote

```ts
const result = await repo.clone({
  url: 'https://github.com/owner/repo.git',
  filter: 'blob:none',   // partial clone — recommended in the browser to bound storage
});
await repo.checkout({ target: result.head });
```

Smart-HTTP runs over `fetch`. The same SSRF / TLS guards as Node apply; the OPFS sandbox limits writes to the origin's private filesystem.

## Subdirectory layout

If you want the repo in a sub-folder of OPFS (e.g. side-by-side with other app state), pass a child handle:

```ts
const root = await navigator.storage.getDirectory();
const repoRoot = await root.getDirectoryHandle('repo', { create: true });
const repo = await openRepository({ rootHandle: repoRoot });
```

Optionally override the in-OPFS `.git` directory name with `gitDirName` (useful on hosts that disallow dot-prefixed names):

```ts
await openRepository({ rootHandle, gitDirName: 'git' });
```

## What works in the browser

- Every command and primitive that doesn't depend on Node-only APIs
- Partial clone with transparent lazy-fetch
- Sparse checkout
- Reflog, submodule walk, `cat-file` batch

## What doesn't

- **Hooks.** The browser adapter has no hook runner; `pre-commit` / `commit-msg` / `pre-push` are inert.
- **Native filesystem access outside OPFS.** All writes stay inside the origin's sandbox.

## Cleanup

```ts
await repo.dispose();
```

The OPFS adapter releases its handles on dispose. The OPFS bytes themselves persist across page loads — clear them via `navigator.storage.estimate()` + delete operations on the directory if you want a fresh start.

## What's next

| Want to… | Read |
|---|---|
| Run tsgit in Node | [Node quickstart](node.md) |
| Use the in-memory adapter for tests | [In-memory adapter](memory.md) |
| Migrate from `isomorphic-git` | [Migration guide](migrate-from-isomorphic-git.md) |
| See every command available | [Commands reference](../use/commands/) |
| Compose your own walks | [Primitives reference](../use/primitives/) |
| See real-world flows (clone + checkout, partial clone, hooks, …) | [Recipes](../use/recipes.md) |
| Understand OPFS quirks vs Node `fs` | [Architecture](../understand/architecture.md) · [security](../understand/security.md) |
