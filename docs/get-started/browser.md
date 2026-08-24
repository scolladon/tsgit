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

## No build step (CDN)

No bundler, no install step: the package also ships a single-file, minified ESM bundle, and the CDN root URLs resolve straight to it — one request, the whole library.

```html
<script type="module">
  import { openRepository } from 'https://unpkg.com/@scolladon/tsgit@3/dist/browser/tsgit.js';

  const rootHandle = await navigator.storage.getDirectory();
  const repo = await openRepository({ rootHandle });
</script>
```

The jsDelivr equivalent:

```html
<script type="module">
  import { openRepository } from 'https://cdn.jsdelivr.net/npm/@scolladon/tsgit@3/dist/browser/tsgit.js';
</script>
```

`@3` floats to the latest 3.x release. For production, replace `@3` with the exact version you tested against so the URL is immutable and a future release can't silently re-resolve it.

The bundle exposes the same names as `@scolladon/tsgit/auto/browser` — `openRepository`, the runtime detectors, the branded-type constructors, the diff/merge constants — and deliberately not the browser adapter classes or the transport middleware. Use the bundler path above if you need those.

| | Bundler | CDN (no build) |
|---|---|---|
| Install step | `npm install` | a URL |
| Requests for tsgit code | resolved by your bundler | 1 |
| Payload | tree-shaken to your imports | the whole library |
| Dependency dedupe | yes, with your app's deps | no |
| Debuggable source | yes | minified only — the bundle ships no sourcemap by design |

## Open a repository

The browser has no `process.cwd()` equivalent, so you must supply an OPFS `FileSystemDirectoryHandle`:

```ts
import { openRepository } from '@scolladon/tsgit/auto/browser';

const rootHandle = await navigator.storage.getDirectory();
const repo = await openRepository({ rootHandle });
```

`getDirectory()` returns the OPFS root for the page's origin. Each origin gets its own sandbox; nothing escapes it.

An existing repository's hash algorithm (SHA-1 or SHA-256) is detected automatically from its own `extensions.objectFormat` — pass `algorithm` only when there is no repository yet to detect a format from (`init` into a fresh OPFS root):

```ts
const repo = await openRepository({ rootHandle, algorithm: 'sha256' });
await repo.init();
```

## Clone a remote

```ts
const result = await repo.clone({
  url: 'https://github.com/owner/repo.git',
  filter: 'blob:none',   // partial clone — recommended in the browser to bound storage
});
await repo.checkout({ rev: result.head });
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

That entry can be a directory or a `gitdir:` pointer file — e.g. a submodule's gitfile pointing at an external admin directory. tsgit resolves the pointer the same way the Node adapter does, splitting shared vs per-worktree paths via `commonDir`; a pointer that resolves outside the OPFS root surfaces the adapter's own containment error rather than a special case.

## Bare repositories and explicit layout

The browser has no discovery walk — OPFS's root is `/`, so `dirname('/') === '/'` terminates on the first step (ADR-538). `gitDir` and `workDir` therefore don't skip a walk the way they do on Node/Memory; instead `gitDir` **overrides the fixed entry itself** (superseding `gitDirName` when both are given), and `workDir` names a working tree elsewhere in the sandbox. Relative values resolve against the root work dir, the same "relative resolves against cwd" rule the Node/Memory adapters follow.

`commonDir` rides the same fixed-entry resolution: it overrides whichever common dir the fixed entry would otherwise resolve — the file-derived value, or a `gitdir:` pointer's own `commondir` — and a relative value resolves against the root work dir the same way `gitDir`/`workDir` do. Unlike `ceilingDirs` below, `commonDir` **does** take effect here: there's no walk to skip, but the fixed entry itself still honours the override.

```ts
// Bare repository — no working tree
const bare = await openRepository({ rootHandle, gitDir: 'repo.git', bare: true });

// Explicit work tree alongside the gitdir
const repo = await openRepository({ rootHandle, gitDir: 'repo.git', workDir: 'work' });

// Common dir shared with another checkout
const linked = await openRepository({ rootHandle, gitDir: 'checkout/.git', commonDir: 'shared/.git' });
```

`ceilingDirs` exists on the option type (inherited from the core `OpenRepositoryOptions`) but has no effect here — with no walk to bound, there's nothing for a ceiling to stop.

`algorithm` disagreeing with a repository's own declared `extensions.objectFormat` — or with a caller-supplied `hash` adapter's algorithm — throws `OBJECT_FORMAT_CONFLICT`. See [errors](../use/errors.md#repository-state).

## Repository trust

`trust`, `trustedDirectories`, and `bareRepositories` all exist on the option type but are inert here — every repository the browser opens is trusted, unconditionally:

- The ownership-trust gate is an **optional** adapter capability ([Node get-started](node.md#bare-repositories-and-explicit-layout)), and the browser adapter doesn't implement it — OPFS is sandboxed per origin, so no foreign-owned repository can exist inside it.
- `bareRepositories: 'explicit'` refuses a gitdir *the discovery walk* reached under a name other than `.git`. The browser has no walk (see above) — the fixed entry always resolves on the same route a normal discovery would use, never the walk-only bare route the refusal keys on — so the condition can never fire, regardless of the option.

See [Repository trust](../understand/security.md#repository-trust) for what the gate closes on adapters that do implement it.

## What works in the browser

- Every command and primitive that doesn't depend on Node-only APIs
- Partial clone with transparent lazy-fetch
- Sparse checkout
- Reflog, submodule walk, `cat-file` batch

## What doesn't

- **Hooks.** The browser adapter has no hook runner; `pre-commit` / `commit-msg` / `pre-push` are inert.
- **SSH remotes.** The browser wires no `SshTransport`; `ssh://` and scp-like remotes throw `ADAPTER_UNAVAILABLE` — see [errors](../use/errors.md) and [Node get-started](node.md#ssh-remotes) for what Node supports.
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
