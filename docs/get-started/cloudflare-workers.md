# Get started — Cloudflare Workers

`workerd` (Cloudflare's edge runtime) has no filesystem. The Memory
adapter — which uses an in-process `Map` for its FS layer — is the
runtime story for Workers users. Every command and primitive that
works against the Memory adapter works inside a Worker; the matrix
proves the parity holds via the `parity-workers` CI job.

## Prerequisites

- A Cloudflare account (Workers free tier is sufficient)
- `wrangler` for local dev (`npm install -D wrangler`)
- Compatibility date `2024-09-23` or newer; flag `nodejs_compat` enabled

## Install

```bash
npm install @scolladon/tsgit
```

## wrangler.jsonc

```jsonc
{
  "name": "my-worker",
  "main": "src/worker.ts",
  "compatibility_date": "2024-12-01",
  "compatibility_flags": ["nodejs_compat"]
}
```

## Open an in-memory repo per request

```ts
import { openRepository } from '@scolladon/tsgit/auto/memory';

export default {
  async fetch(request: Request): Promise<Response> {
    const repo = await openRepository({
      files: { '/repo/README.md': new TextEncoder().encode('hello\n') },
    });

    await repo.init();
    await repo.add('README.md');
    const head = await repo.commit({
      message: 'initial commit',
      author: { name: 'edge', email: 'edge@example.com', timestamp: Math.floor(Date.now() / 1000), timezoneOffset: '+0000' },
    });

    await repo.dispose();
    return new Response(JSON.stringify({ commit: head.id }), {
      headers: { 'content-type': 'application/json' },
    });
  },
};
```

Every Worker invocation gets its own in-memory repo; dispose at the end
of the request so the runtime can reclaim the memory.

## What does NOT work inside Workers

- The Node adapter (`@scolladon/tsgit/auto/node`) requires `node:fs` —
  not available in `workerd`. Use `@scolladon/tsgit/auto/memory`.
- The Browser adapter (OPFS) — browser-only API. Use Memory.
- Local hook execution (`runHook`) — needs a child process, not
  available in Workers.

## Persistence

The Memory adapter is in-process and dies with the request. If you
need persistence, surface the repo through a Cloudflare binding (R2 for
loose objects + packs, KV for refs, etc.) by composing tsgit's
primitives — that's a separate phase; for read-only catalogues or
ephemeral build pipelines the in-process Memory adapter is enough.

## Parity with Node + Browser

The runtime-parity matrix (CI job `parity-workers`) runs the same ten
scenarios that exercise the Memory adapter on Node and Browser. A
Workers regression — for example a `Uint8Array` semantic that diverges
from V8 — fails the matrix at PR time.
