# Phase 12.4 — Bench: `clone:small-repo` scenario

## 1. Goal

Wire a `clone:small-repo` benchmark into `test/bench/` that compares
`tsgit.clone` against `isomorphic-git.clone` over a real local
`git-http-backend` CGI, so the `reports/benchmarks/summary.md` table
gains one more row and the existing tooling (`npm run bench:summary`)
picks it up with no script changes.

BACKLOG §12.4 acceptance:

> wired into `test/bench/` and the markdown summary, comparing tsgit vs
> isomorphic-git clone time against a fixed local `git-http-backend`
> fixture.

## 2. Constraints (inherited)

- **No new dependencies.** Use vitest `bench`, Node `http`, and the
  same CGI-spawn pattern from `test/integration/network/clone-http-backend.test.ts`.
- **Deterministic fixture.** Re-use the committed 5-commit
  `test/fixtures/clone-source/source.git` — same input both libraries see.
- **Skip gracefully** when `git-http-backend` is unavailable (Windows CI,
  fresh clones that have not run `scripts/regenerate-clone-fixtures.sh`)
  and when running under Stryker's sandbox.
- **Fair timing.** Both libraries do an end-to-end clone into a fresh
  tmpdir; tsgit's `openRepository` + `repo.clone` belong inside the
  timed region because that is the API surface a real consumer uses.
- **Cleanup per iteration.** Each clone must mkdtemp + rm afterwards so
  iteration N+1 sees an empty target.

## 3. Module layout

```
test/bench/
├── fixtures.ts              # existing — extended with no changes here
├── clone-small-repo.bench.ts   # new — the bench file
└── support/
    └── http-backend-server.ts  # new — CGI server lifecycle helper
test/integration/network/clone-http-backend.test.ts  # existing
```

The CGI server helper is **extracted from the existing integration test**
verbatim (`handleRequest`, `writeCgiResponse`, `applyCgiHeaders`,
`findHeaderSeparator`, `findGitExecPath`). It becomes a reusable
primitive: `startGitHttpBackend({ projectRoot }) → { port, close }`.

The integration test then imports the same helper, removing a duplicate
~70-line CGI block.

## 4. File-by-file

### 4.1 `test/bench/support/http-backend-server.ts`

```ts
export interface GitHttpBackend {
  readonly port: number;
  readonly close: () => Promise<void>;
}

export interface StartGitHttpBackendOpts {
  readonly projectRoot: string;
  readonly host?: string;       // default '127.0.0.1'
}

// Boots a CGI HTTP server that spawns `git-http-backend` per request.
// Returns the bound port + a close() that drains the listener.
export const startGitHttpBackend: (
  opts: StartGitHttpBackendOpts,
) => Promise<GitHttpBackend>;

// Returns the discovered `git-http-backend` path, or undefined if
// `git --exec-path` is unavailable or the binary is missing.
export const findGitHttpBackend: () => string | undefined;
```

Implementation = the existing CGI handler + `http.createServer` wiring
lifted out of `clone-http-backend.test.ts`. Listener binds on
`{port: 0}` so each scenario gets a fresh port. The CGI child gets
the same `PATH_INFO / QUERY_STRING / GIT_PROJECT_ROOT` env block.

### 4.2 `test/bench/clone-small-repo.bench.ts`

```ts
import { execFileSync } from 'node:child_process';
import { accessSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';

import * as git from 'isomorphic-git';
import gitHttp from 'isomorphic-git/http/node';
import { afterAll, beforeAll, bench, describe } from 'vitest';

import { openRepository } from '../../src/index.node.js';
import { findGitHttpBackend, startGitHttpBackend } from './support/http-backend-server.js';

const FIXTURE_DIR = path.resolve(import.meta.dirname, '../fixtures/clone-source');
const SOURCE_GIT = path.join(FIXTURE_DIR, 'source.git');
const RUNNING_UNDER_STRYKER = process.cwd().includes('.stryker-tmp');
const GIT_HTTP_BACKEND = findGitHttpBackend();
const FIXTURE_AVAILABLE = (() => { try { accessSync(SOURCE_GIT); return true; } catch { return false; } })();

const SKIP = RUNNING_UNDER_STRYKER
  || GIT_HTTP_BACKEND === undefined
  || !FIXTURE_AVAILABLE;

describe.skipIf(SKIP)('clone:small-repo', async () => {
  let server: { port: number; close: () => Promise<void> };
  const tmpdirs: string[] = [];

  beforeAll(async () => {
    server = await startGitHttpBackend({ projectRoot: FIXTURE_DIR });
  });

  afterAll(async () => {
    await Promise.all(tmpdirs.map((d) => rm(d, { recursive: true, force: true })));
    await server.close();
  });

  const url = () => `http://127.0.0.1:${server.port}/source.git`;

  bench('tsgit', async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), 'tsgit-bench-clone-'));
    tmpdirs.push(cwd);
    const repo = await openRepository({
      cwd, allowInsecureHttp: true,
      config: { allowInsecure: true, allowPrivateNetworks: true, dnsResolver: async () => ['127.0.0.1'] },
    });
    try {
      await repo.clone({
        url: url(), allowInsecure: true, allowPrivateNetworks: true,
        resolver: async () => ['127.0.0.1'],
      });
    } finally {
      await repo.dispose();
    }
  });

  bench('isomorphic-git', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'iso-bench-clone-'));
    tmpdirs.push(dir);
    await git.clone({ fs, http: gitHttp, dir, url: url(), singleBranch: true });
  });
});
```

### 4.3 `test/integration/network/clone-http-backend.test.ts`

Replace the CGI block with `import { startGitHttpBackend, findGitHttpBackend } from '../../bench/support/http-backend-server.js'`. The Stryker-skip
+ fixture-skip logic stays inline because the gate text is
test-specific (`'fixture missing — run scripts/regenerate-clone-fixtures.sh'`).

This is a **pure refactor** with zero behaviour change — the integration
test continues to run against the same CGI handler, only the file it
lives in changed.

### 4.4 `scripts/bench-summarize.ts`

No change. The script enumerates `raw.files.flatMap(f => f.groups)`,
so the new `clone:small-repo` group flows into `summary.md`
automatically once the bench runs.

### 4.5 `reports/benchmarks/summary.md`

Auto-regenerated by `npm run bench:summary`. The PR commits a
hand-run snapshot that includes the new row.

## 5. Skip semantics

| Environment | Skip? | Reason |
|---|---|---|
| Local with `git`, fresh checkout | ✅ run | `git-http-backend` resolved via `git --exec-path` |
| CI Linux / macOS | ✅ run | both have `git-http-backend` |
| CI Windows | ⏭ skip | no `git-http-backend` ships with Git-for-Windows on the runner |
| Stryker sandbox | ⏭ skip | the spawned CGI does not work across `.stryker-tmp` symlinks (same reason the integration test skips) |
| Fixture not regenerated | ⏭ skip | requires `scripts/regenerate-clone-fixtures.sh` |

The skip is via `describe.skipIf(SKIP)` — the same idiom the
integration test uses today. Skipped benches do not appear in
`raw.json`, so `summary.md` will silently omit the row on systems
that cannot produce it. Matches the existing behaviour for other
gated suites.

## 6. Timing fairness

- **Server is shared across iterations.** Boot once in `beforeAll`,
  close once in `afterAll`. Per-iter server startup would add a noisy
  ~50–100 ms baseline to every sample and would not reflect what users
  measure ("clone latency", not "boot a CGI") — see ADR-017.
- **Tmpdir mkdtemp is inside the timed region for both libraries.**
  Both libs have to create a target directory; excluding mkdtemp from
  one but not the other would tilt the comparison.
- **`openRepository` is inside tsgit's bench.** isomorphic-git has no
  "open" step — its single `git.clone` call is the API surface. tsgit's
  `openRepository → repo.clone` is the equivalent surface. Measuring
  only `repo.clone` would understate the consumer-visible cost.
- **`singleBranch: true` on isomorphic-git.** tsgit's `clone` defaults
  to single-branch (only HEAD's ref is fetched). The flag matches our
  default so the libs do equivalent work.

## 7. Testing strategy

A bench is not a test. There is nothing to assert beyond "the file
parses, the bench groups exist". Two safety nets:

1. **Integration test stays green** after the CGI helper is extracted.
   `npm run test:integration` is the regression net for the refactor.
2. **`npm run test:bench` exits 0** locally and on CI's bench job. The
   reduction of bench time is observed in `summary.md`, not in
   pass/fail assertions.

A standalone unit test for `startGitHttpBackend` would mostly test the
existing CGI handler — i.e. test the integration test's infrastructure.
The refactor's correctness is established by the unchanged integration
test passing against the same fixture.

## 8. Open questions / risks

- **Bench variance.** Clone latency is dominated by CGI spawn (~30 ms) +
  pack assembly on the server side (~10 ms for 5 commits) + network
  loopback. Expect ±25% RME on the median. The bench remains useful
  for tracking large regressions; sub-10% differences are noise.
- **Server liveness.** If a bench iteration crashes mid-flight, the
  per-iter `mkdtemp` stays on disk until `afterAll`. Each iter is
  bounded by vitest's 60 s timeout, so a leaked tmpdir is at worst
  one orphan, swept by `afterAll`.
- **isomorphic-git http transport import.** The package exposes
  `isomorphic-git/http/node` as a side-effect-free module — already
  used by every isomorphic-git consumer in the wild. No additional
  dependency.

## 9. Self-review log

### Pass 1 → Pass 2 diffs

- Originally drafted timing inside `repo.clone({ url })` only — moved
  `openRepository` into the timed region for parity with the
  `git.clone` surface.
- Originally proposed mkdtemp + rm per-iter (rm inside the bench).
  Moved rm to `afterAll` so iteration cleanup time is not counted in
  the sample (same convention `read-blob.bench.ts` uses with the
  fixture cleanup).

### Pass 2 → Pass 3 diffs

- Added `singleBranch: true` to isomorphic-git's call — without it the
  lib would also pull packed-refs, skewing the comparison.
- Added the Stryker skip explicitly; without it `stryker run` would
  try to mutate this file and inject a CGI-binding child process into
  every mutant.
- Clarified that the integration-test extraction is **pure refactor**
  and that the regression net is the integration test, not a new
  unit test for the helper.
