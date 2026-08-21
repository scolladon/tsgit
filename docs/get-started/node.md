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

`openRepository` walks up from `cwd` looking for a `.git` entry — a directory, or a gitfile pointer to one (a linked worktree, a submodule working directory, or a `--separate-git-dir` layout) — or, failing that, checks whether `cwd` itself **is** a git directory (a bare repository, or the admin dir of a linked worktree) — and binds every command to a frozen [Context](../understand/architecture.md#context). One open call, one validation pass — every subsequent call inherits the resolved layout and the configured adapters. See [`worktree`](../use/commands/worktree.md) for what changes when the resolved layout's `commonDir` differs from `gitDir`.

If you pass `cwd` pointing at a path that doesn't exist yet, tsgit treats it as a future repository root (for example, the target of an upcoming `init` or `clone`).

## Bare repositories and explicit layout

`cd`-ing into a bare repository (or any ancestor of one) opens the same way a normal repository does — there's just no working tree behind it:

```ts
const bare = await openRepository({ cwd: '/srv/repo.git' });
await bare.log({ limit: 10 });   // read commands work fine
await bare.status();             // throws WORK_TREE_REQUIRED — there is no work tree
```

`gitDir`, `workDir`, `bare`, and `ceilingDirs` — the argument equivalents of git's `--git-dir`, `--work-tree`, and `GIT_CEILING_DIRECTORIES` — let a caller pin the layout instead of relying on discovery. None of them read an environment variable; every input is an explicit argument.

An existing repository's hash algorithm (SHA-1 or SHA-256) is detected automatically from its own `extensions.objectFormat` — you never need to pass `algorithm` to open one. Pass it explicitly only when there is no repository yet to detect a format from — `init` or `clone` into a fresh target:

```ts
const repo = await openRepository({ cwd: '/tmp/new-repo', algorithm: 'sha256' });
await repo.init();
```

Passing `algorithm` that disagrees with a repository's own declared format — or with a caller-supplied `hash` adapter's algorithm — throws `OBJECT_FORMAT_CONFLICT` rather than silently mismatching object ids. See [errors](../use/errors.md#repository-state).

```ts
// Explicit gitDir with a work tree elsewhere
const repo = await openRepository({
  cwd: '/tmp/elsewhere',
  gitDir: '/srv/repo.git',
  workDir: '/home/alice/work',
});

// Bound the discovery walk instead of climbing to the filesystem root
const bounded = await openRepository({ cwd: '/tmp/nested/deep', ceilingDirs: ['/tmp/nested'] });
```

`trust`, `trustedDirectories`, and `bareRepositories` gate a repository reached by discovery, the way git's `safe.directory` gates one:

| Option | Default | Purpose |
|---|---|---|
| `trust` | `'ownership'` | Refuse a discovered repository whose metadata isn't owned by the caller. `'always'` disables the check. |
| `trustedDirectories` | none | Absolute directories trusted regardless of ownership. The single entry `'*'` trusts every repository; a trailing `/*` trusts every path strictly below the prefix. |
| `bareRepositories` | `'all'` | `'explicit'` refuses a gitdir that discovery reached under a name other than `.git`. |

```ts
// Trust one shared repository regardless of who owns its files
const shared = await openRepository({
  cwd: '/srv/shared-repo',
  trustedDirectories: ['/srv/shared-repo'],
});
```

That is the recipe for a CI container or a network mount whose checkout uid
doesn't match the process uid: pass `trustedDirectories: ['/srv/checkout']`
for that one path rather than disabling `trust` altogether.

Turning the ownership-trust gate on by default is a **breaking behavioural
change** for discovery-route callers that previously opened a foreign-owned
repository silently. Refused, every surface follows one fixed contract:

| surface | behaviour on a refused repository |
|---|---|
| `openRepository` | resolves; `repo.layout.untrusted === true` |
| `init`, `clone` | bootstrap normally — they run no acceptance tier |
| `repo.config.get`, `.getAll`, `.getRegexp`, `.list` | succeed with an **empty repository scope**; a planted local key reports absent |
| all five `repo.config` write verbs; all six `repo.remote` verbs | refuse with `IMPLICIT_BARE_REPOSITORY`, else `DUBIOUS_OWNERSHIP` |
| everything else | the same refusals |

See [errors](../use/errors.md#repository-state) for the full `DUBIOUS_OWNERSHIP` /
`IMPLICIT_BARE_REPOSITORY` payloads, and [Repository trust](../understand/security.md#repository-trust)
for what the gate closes.

Bootstrapping a fresh bare repository needs `gitDir` equal to `cwd` so the constructed layout has no work tree — `init({ bare: true })` then writes exactly what `git init --bare` writes, and both tsgit and real git can reopen the result:

```ts
const fresh = await openRepository({ cwd: '/tmp/new.git', gitDir: '/tmp/new.git', bare: true });
await fresh.init({ bare: true });
```

`repo.layout` exposes the resolved layout as structured data — `gitDir`, `commonDir`, `workDir` (absent when the repository has none), and `bare`:

```ts
const { workDir, bare } = repo.layout;
if (workDir === undefined) {
  // every work-tree-requiring command (status, add, commit, …) throws WORK_TREE_REQUIRED
}
```

See [errors](../use/errors.md) for the refusal codes a missing or misconfigured work tree can raise.

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

When it resolves, every file descriptor the repository opened — including the persistent pack handles behind concurrent read bursts — has been closed; nothing is left for the garbage collector. That matters on Node 26, which turns a GC-collected open `FileHandle` (the `DEP0137` deprecation on earlier majors) into a fatal error.

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
