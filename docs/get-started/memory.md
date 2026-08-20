# Get started — In-memory

The in-memory adapter is a first-class test fixture, not a fallback. Same surface as Node and Browser, no filesystem, deterministic, fast — the one exception is SSH remotes: only Node wires an `SshTransport`, so `ssh://` and scp-like remotes throw `ADAPTER_UNAVAILABLE` here too, same as Browser. Use it for unit tests that need a real repo without touching disk.

## Prerequisites

- Node 22+ (the in-memory adapter is platform-agnostic, but you'll typically run it under a Node test runner).
- A test runner of your choice (vitest, jest, mocha, node's built-in).

## Install

```bash
npm install @scolladon/tsgit
```

## Open a repository

```ts
import { openRepository } from '@scolladon/tsgit/auto/memory';

const repo = await openRepository({
  files: {
    '/repo/README.md': new TextEncoder().encode('# hello\n'),
    '/repo/src/index.ts': new TextEncoder().encode('export const x = 1;\n'),
  },
});

await repo.init();
```

The `files` map seeds the working tree before `init`. Keys are absolute POSIX paths under any root you choose (here `/repo`); values are `Uint8Array`. Defensive copies are made on read and write, so caller mutations cannot corrupt stored state.

`openRepository({ cwd, files })` discovers the layout the same way the Node adapter does: it walks up from `cwd` (default `/repo`) for a `.git` entry — or checks whether `cwd` itself is a git directory — and resolves gitfile pointers, so a `files` map that seeds a worktree-shaped tree (e.g. a `.git` file at `/repo/wt/.git` pointing at an admin dir under `/repo/.git/worktrees/wt`) opens correctly from `cwd: '/repo/wt'` — as long as every resolved path stays inside `rootDir`.

## Bare repositories and explicit layout

The memory adapter honours the same `gitDir` / `workDir` / `bare` / `ceilingDirs` options as Node, forwarded lexically (no realpath step — the sandboxed filesystem has no symlinks to resolve). A `gitDir` / `workDir` / ceiling entry that resolves outside `rootDir` reads as absent rather than escaping the sandbox.

```ts
// gitDir === cwd so init writes a layout with no work tree
const bare = await openRepository({ cwd: '/repo/bare.git', gitDir: '/repo/bare.git', bare: true });
await bare.init({ bare: true });

const bounded = await openRepository({ cwd: '/repo/nested/deep', ceilingDirs: ['/repo/nested'] });
```

## Repository trust

`trust` and `trustedDirectories` exist on the option type but are inert here: the ownership-trust gate is an **optional** adapter capability ([Node get-started](node.md#bare-repositories-and-explicit-layout)), and the memory adapter doesn't implement it — its filesystem is an in-process `Map` with no owner model, so no foreign-owned repository can exist. Every repository the memory adapter opens is trusted regardless of what `trust` is set to.

`bareRepositories: 'explicit'` is **not** inert — unlike the browser's fixed entry, the memory adapter runs the same discovery walk as Node, so the walk-reached-a-gitdir-under-another-name condition that option keys on is real here too. See [Repository trust](../understand/security.md#repository-trust) for what the gate closes on adapters that do implement the ownership half.

## Exercise the API

```ts
await repo.add([], { all: true });
await repo.commit({
  message: 'initial',
  author: { name: 'Test', email: 'test@example.com', timestamp: 0, timezoneOffset: '+0000' },
});

const { entries } = await repo.primitives.walkSubmodules({ recursive: true });
const log = await repo.log();
```

Because `timestamp` is caller-provided (we never call `new Date()`), the resulting commit oids are deterministic — your test can assert on them.

## Why this exists

- **Unit tests for code that uses tsgit.** Mock-free; you exercise the real library against a real repo.
- **Property-based tests.** Generate random commits and assert invariants.
- **Cross-runtime parity proofs.** Run the same scenario against Node, Browser (via Playwright), and Memory adapters and assert byte-identical results.

## Example — a parametrised test

```ts
// vitest example
import { describe, it, expect } from 'vitest';
import { openRepository } from '@scolladon/tsgit/auto/memory';

describe('Given a fresh repo, When committing a file, Then HEAD points at the commit', () => {
  it('matches the expected oid', async () => {
    // Arrange
    const sut = await openRepository({
      files: { '/repo/a.txt': new TextEncoder().encode('a\n') },
    });
    await sut.init();
    await sut.add(['a.txt']);

    // Act
    const result = await sut.commit({
      message: 'first',
      author: { name: 'Alice', email: 'a@b', timestamp: 0, timezoneOffset: '+0000' },
    });

    // Assert
    const head = await sut.revParse('HEAD');
    expect(head).toBe(result.id);

    await sut.dispose();
  });
});
```

## What's next

| Want to… | Read |
|---|---|
| Run tsgit in Node | [Node quickstart](node.md) |
| Run tsgit in the browser | [Browser quickstart](browser.md) |
| Migrate from `isomorphic-git` | [Migration guide](migrate-from-isomorphic-git.md) |
| See every command available | [Commands reference](../use/commands/) |
| Compose your own walks | [Primitives reference](../use/primitives/) |
