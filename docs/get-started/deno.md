# Get started — Deno

tsgit ships as a regular npm package and Deno consumes it through the
`npm:` specifier. The Node-compatibility surface in Deno 2.x covers
every Node builtin the Node adapter relies on (`node:fs/promises`,
`node:crypto`, `node:zlib`, `node:path`, `node:http(s)`), so all the
commands that work in Node 22+ work in Deno without modification.

## Prerequisites

- Deno 2.x (`deno --version`)
- A directory containing a `.git` folder (or any ancestor of one) — same
  as the Node story

## Import

```ts
import { openRepository } from 'npm:@scolladon/tsgit';
```

The `npm:` specifier resolves the published package, downloads it on
first run, and caches it in `~/.cache/deno/` for subsequent runs.

## Open a repository

```ts
const repo = await openRepository({ cwd: Deno.cwd() });
const commits = await repo.log({ limit: 10 });
const status = await repo.status();
console.log(`on ${status.branch}, ${status.workingTreeChanges.length} unstaged`);
await repo.dispose();
```

`openRepository` walks up from `cwd` for a `.git` directory exactly like
in Node — Deno's `node:fs` polyfill makes that walk transparent.

## Permissions

Deno's security model requires explicit permission grants. The minimum
set tsgit needs:

```bash
deno run --allow-read --allow-write --allow-env your-script.ts
```

- `--allow-read` — read repo objects, refs, working-tree files.
- `--allow-write` — write objects, refs, index updates.
- `--allow-env` — `process.env` reads for git config defaults
  (`GIT_AUTHOR_NAME`, etc.).

Add `--allow-net` if you use `clone` / `fetch` / `push` over HTTP.

## In-memory mode (no filesystem)

If you prefer the Memory adapter — for tests, ephemeral repos, or
sandboxed Deno workers — import the auto/memory entry:

```ts
import { openRepository } from 'npm:@scolladon/tsgit/auto/memory';
const repo = await openRepository({
  files: { '/repo/README.md': new TextEncoder().encode('hello\n') },
});
```

No filesystem permissions required; everything lives in an in-process
`Map`.

## Parity with Node

The runtime-parity matrix (CI job `parity-deno`) runs the exact same
ten scenarios that exercise the Node adapter, against the dist artifact
loaded by Deno. The matrix is blocking — a Deno regression is caught at
PR time. See [CONTRIBUTING.md](../../CONTRIBUTING.md#running-test-subsets)
for how to validate locally.
