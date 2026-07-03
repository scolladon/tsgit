# Get started — Node.js

You'll have a working tsgit handle reading an existing repository in under a minute. This page covers Node 22+ on Linux, macOS, and Windows.

## Prerequisites

- Node.js 22.22.1 or newer (`node --version`)
- A directory containing a `.git` folder (or any ancestor of one)

## Install

```bash
npm install @scolladon/tsgit
```

Zero runtime dependencies. The package ships ESM and CJS; pick whichever your project uses — `"exports"` resolves the right one automatically.

## Open a repository

```ts
import { openRepository } from '@scolladon/tsgit';

const repo = await openRepository({ cwd: process.cwd() });
```

`openRepository` walks up from `cwd` looking for a `.git` directory and binds every command to a frozen [Context](../understand/architecture.md#context). One open call, one validation pass — every subsequent call inherits the resolved layout and the configured adapters.

If you pass `cwd` pointing at a path that doesn't exist yet, tsgit treats it as a future repository root (for example, the target of an upcoming `init` or `clone`).

## Read

```ts
// Last ten commits on the current branch
const commits = await repo.log({ limit: 10 });

// Working-tree / index / HEAD differences
const { clean, branch, changes, untracked } = await repo.status();
const staged = changes.filter((c) => c.staged !== undefined).length;
console.log(`on ${branch}, ${staged} staged, ${changes.length} changed, ${untracked.length} untracked`);
```

`log` and `status` are both Tier-1 commands. They build on Tier-2 primitives (`walkCommits`, `readIndex`, `walkWorkingTree`); see the [primitives reference](../use/primitives/) when you want to compose your own walks.

## Write

```ts
await repo.add(['README.md']);

await repo.commit({
  message: 'first',
  author: {
    name: 'Alice',
    email: 'alice@example.com',
    timestamp: Math.floor(Date.now() / 1000),
    timezoneOffset: '+0000',
  },
});
```

Note the explicit `timestamp` and `timezoneOffset`. tsgit refuses to call `new Date()` for you — commit hashes are deterministic on the inputs they advertise. If you want "now", compute it at the call site.

## SSH remotes

`clone` / `fetch` / `pull` / `push` accept `ssh://[user@]host[:port]/path` and scp-like `[user@]host:path` remotes alongside `https://`. Node wires an `SshTransport` by default and spawns the system `ssh` binary — key resolution, agent forwarding, and `known_hosts` are entirely delegated to it; tsgit never reads a private key.

Command resolution follows git's order: `GIT_SSH_COMMAND` → `core.sshCommand` → `GIT_SSH` → `ssh` on `PATH`. Argv is built OpenSSH-style only (`-p <port>` for a non-default port); other SSH clients get the same OpenSSH-shaped flags until variant detection lands ([ADR-441](../adr/441-openssh-only-argv-variant-detection-deferred.md)).

There's no per-call opt-out on `openRepository` — SSH is always wired. The lower-level `createNodeContext` (`@scolladon/tsgit/adapters/node`) accepts `{ ssh: false }` to build a context without it.

Browser and the in-memory adapter wire no `SshTransport` — see [Browser](browser.md) / [In-memory](memory.md).

## Cancel and clean up

```ts
await repo.dispose();
```

`dispose()` aborts the internal `AbortSignal`, lets in-flight reads/writes unwind, and tears down the adapters. After it resolves, every bound method throws `REPOSITORY_DISPOSED`.

It's idempotent — safe to call twice, safe to call from a `finally` block, safe to call after an external `AbortController.abort()`:

```ts
const controller = new AbortController();
const repo = await openRepository({ cwd: '.', signal: controller.signal });
try {
  await repo.log({ depth: 10 });
} finally {
  controller.abort();          // signals every in-flight call
  await repo.dispose();        // tears down adapters
}
```

If your code already wraps work in `using`/`await using` (TypeScript 5.2+), `dispose` slots in directly — open an issue if you want the explicit `[Symbol.asyncDispose]` shape exposed.

## What's next

| Want to… | Read |
|---|---|
| Run tsgit in a browser tab | [Browser quickstart](browser.md) |
| Use the in-memory adapter for tests | [In-memory adapter](memory.md) |
| Migrate from `isomorphic-git` | [Migration guide](migrate-from-isomorphic-git.md) |
| See every command available | [Commands reference](../use/commands/) |
| Compose your own walks | [Primitives reference](../use/primitives/) |
| See real-world flows (clone + checkout, partial clone, hooks, …) | [Recipes](../use/recipes.md) |
| Understand why tsgit looks like this | [Architecture](../understand/architecture.md) · [design decisions](../understand/design-decisions.md) |
