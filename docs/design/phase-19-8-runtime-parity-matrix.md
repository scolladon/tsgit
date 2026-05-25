# Phase 19.8 — Runtime parity matrix

Wave 0 (test base) closing piece. 19.5 stood up the cross-adapter parity
contract; 19.5a closed the browser-surface gap; 19.6/19.7 hardened parsers
and write surfaces. 19.8 closes the **runtime axis**: the same scenarios
that run against Node + Browser + Memory adapters today must also run on
**Deno, Bun, and Cloudflare Workers**, against whichever adapters those
runtimes can host. Any divergence is a runtime-parity bug.

When the matrix is green, the README opener restores the original
cross-runtime claim — `Cross-runtime — Node 22+ · Deno · Bun · Cloudflare
Workers · Browser (OPFS) · in-memory` — gated on the new CI jobs staying
green. Until then, the documented claim stays at the 19.5 wording (Node
+ Browser + Memory).

## 1. Goals

1. **Single source of truth per scenario, four host runtimes.** The
   `SCENARIOS` registry shipped in 19.5 is the contract. Deno, Bun, and
   Workers drivers iterate the same registry; the scenario `run` body and
   `expected` golden are byte-for-byte identical to the Node + Memory
   drivers. The runtime is the only variable.
2. **Adapter coverage matches runtime capability.**
   - Deno + Bun — both expose `node:fs`; they run scenarios × Node
     adapter AND scenarios × Memory adapter.
   - Cloudflare Workers — no filesystem; runs scenarios × Memory adapter
     only.
   - Browser already runs scenarios × Browser adapter (Playwright, 19.5).
3. **Matrix-wide gating.** A single runtime failure fails the matrix-wide
   `Cross-runtime` claim. CI gates the README/Capabilities update on every
   matrix cell being green; no `continue-on-error`, no informational
   downgrade.
4. **Tests against built artifacts, not published npm.** Each runtime
   driver consumes `dist/` produced by the existing `build` job. Validating
   the on-disk shape via `dist/` is what catches real consumer-side
   regressions; the `npm:@scolladon/tsgit` specifier is exercised at
   release time via `pre-publish.yml` and is *not* the load-bearing PR
   signal. The README's claim is therefore "the same dist works on these
   runtimes" — which is exactly what we measure.
5. **No new product code.** Pure test + CI infrastructure. `src/` is
   untouched. Stryker is unaffected (no changed `src/` files in this PR).

What 19.8 deliberately does **not** ship:

- Workers HTTP-transport scenarios (no transport scenarios in the registry
  today; that's its own phase).
- A `npm:`-specifier smoke step in PR CI (deferred to release/post-publish
  validation — there is no point exercising the registry tarball before
  it's been published).
- Performance benchmarks on Deno/Bun/Workers (Phase 26).
- WASM/Edge-runtime variants beyond Workers.
- Property tests in additional runtimes (the property suite from 19.6
  stays Vitest-only; properties live in `test/unit/`, not the parity
  drivers).

## 2. Context

### 2.1 Where the parity contract lives today

After 19.5:

```
test/parity/
├── fixtures.ts                       # AUTHOR, MESSAGES, FILES
├── scenarios/
│   ├── index.ts                      # SCENARIOS: ReadonlyArray<Scenario<unknown>>
│   ├── types.ts                      # Scenario<TResult>, ScenarioInputs
│   ├── init-add-commit-status.scenario.ts
│   ├── branch-lifecycle.scenario.ts
│   ├── read-pipeline.scenario.ts
│   ├── refs-pipeline.scenario.ts
│   ├── write-pipeline.scenario.ts
│   ├── diff-pipeline.scenario.ts
│   ├── reset-rm-reflog.scenario.ts
│   ├── merge-ff.scenario.ts
│   ├── sparse-checkout.scenario.ts
│   └── submodules-empty.scenario.ts  (10 scenarios in total)
├── node.test.ts                      # Vitest — Node adapter
└── memory.test.ts                    # Vitest — Memory adapter
test/browser/parity.spec.ts           # Playwright — Browser adapter
```

The contract a driver must satisfy:

1. Stage `scenario.inputs.files` into whichever FS backs the repo.
2. Open a `Repository` via the runtime-appropriate `openRepository(...)`.
3. Call `scenario.run(repo, scenario.inputs)`.
4. Assert the result `toEqual(scenario.expected)`.

That's roughly 50 lines per driver. Steps 1, 3, and 4 are runtime-agnostic;
step 2 is the only place adapter selection lives.

### 2.2 What changes per host runtime

| Runtime | Adapter(s) | Test framework | FS staging | `openRepository` import |
|---|---|---|---|---|
| Node (today) | Node, Memory | Vitest | `node:fs/promises.writeFile` | `src/index.node.ts` / `src/index.default.ts` |
| Browser (today) | Browser | Playwright + bundled scenarios | OPFS (browser-only) | `dist/esm/index.browser.js` via `window.__tsgit` |
| Deno | Node, Memory | `Deno.test` | `node:fs/promises.writeFile` (Deno's Node compat) | `dist/esm/index.node.js` / `dist/esm/index.default.js` |
| Bun | Node, Memory | `bun:test` | `node:fs/promises.writeFile` (Bun's Node compat) | `dist/esm/index.node.js` / `dist/esm/index.default.js` |
| Workers | Memory only | `@cloudflare/vitest-pool-workers` | in-memory dict | `dist/esm/index.default.js` |

The four runtimes share the **same scenario module**. They differ only in
how they execute test bodies and how they import `openRepository`.

### 2.3 Why "dist/" rather than `npm:` specifiers

The backlog line proposes `Deno via npm specifier (npm:@scolladon/tsgit)`.
That specifier resolves to the **published** version on npm, which lags by
at least one PR cycle. For PR CI the question is "does the code on this
branch work?" — which means the built artifacts produced *on this branch*.
The same logic that argues against `npm install @scolladon/tsgit@latest`
in unit tests argues against a `npm:` specifier in matrix CI: it tests
*last week's* code.

Two consequences:

- Deno + Bun drivers import `openRepository` from a relative path into
  `dist/esm/index.node.js` (Node-compat case) or `dist/esm/index.default.js`
  (memory case). Same on-disk artifact end users consume; different load
  path.
- A `npm:`-specifier smoke step is appropriate, but it belongs in
  `pre-publish.yml` (already exists) where it can be run against the
  release candidate's tarball via `npm pack` + a temporary import map.
  19.8 does not duplicate that signal in PR CI.

### 2.4 Why Workers is memory-only

`workerd` (Cloudflare's runtime) has no filesystem. `node:fs` is not
polyfilled in the production Workers runtime; the Node-compat surface in
`workerd` is opt-in via `nodejs_compat` and covers a small whitelist that
does not include `node:fs/promises.writeFile`. Therefore:

- The Memory adapter (which uses an in-process `Map`-backed FS) is the
  only one that runs in `workerd`.
- Scenario inputs stage into the MemoryFileSystem via `openRepository({
  files })` — exactly the path the Memory Vitest driver already takes.
- All 10 current scenarios are eligible (none of them poke at the FS
  outside the `repo` facade); `runHook` is the only built-in that would
  require fs, and the scenarios already do not exercise it (per the
  19.5a allowlist).

## 3. Design

### 3.1 New driver layout

```
test/runtime-parity/
├── deno/
│   ├── deno.json                      # compilerOptions + tasks for tsgit dist
│   ├── parity-node.test.ts            # Deno.test × Node adapter
│   └── parity-memory.test.ts          # Deno.test × Memory adapter
├── bun/
│   ├── bunfig.toml                    # Bun config (preload, etc.)
│   ├── parity-node.test.ts            # bun:test × Node adapter
│   └── parity-memory.test.ts          # bun:test × Memory adapter
└── workers/
    ├── wrangler.jsonc                 # Workers project manifest
    ├── vitest.config.ts               # @cloudflare/vitest-pool-workers
    ├── tsconfig.json                  # Workers DOM lib + node types off
    └── parity-memory.test.ts          # Vitest-in-workerd × Memory adapter
```

Each driver is a near-verbatim port of `test/parity/{node,memory}.test.ts`:
import `SCENARIOS`, iterate, stage, open, run, assert. Implementation
budget: ≤ 60 lines per driver file, including header comment.

### 3.2 Driver contract — shared across runtimes

All five runtime drivers (Node + Memory in Vitest, Deno × 2, Bun × 2,
Workers × 1) share the same five-step body:

```typescript
// pseudocode — actual per-runtime files differ only in
// `openRepository` import + framework primitive (`it` / `Deno.test` /
// `test`).
import { SCENARIOS } from '<relative path to test/parity/scenarios>';
import { openRepository } from '<runtime-appropriate dist path>';

for (const scenario of SCENARIOS) {
  test(`${scenario.name} matches expected golden`, async () => {
    const stage = await stageInputs(scenario.inputs);  // runtime-specific
    const repo = await openRepository(stage.openOptions);
    const actual = await scenario.run(repo, scenario.inputs);
    expect(actual).toEqual(scenario.expected);
  });
}
```

The runtime-specific divergence is **isolated to `stageInputs`** (real fs
vs in-memory) and the `expect` primitive (`vitest`, `@std/expect`,
`bun:test`, or `vitest-pool-workers`). No shared helper file — copying ≤
40 lines per driver is cheaper than building a cross-runtime shim that
itself must be cross-runtime tested.

### 3.3 Scenario import path

Deno and Bun both honour TypeScript `.ts` imports directly (Deno
natively, Bun via its built-in transpiler). The scenario registry already
exports plain TypeScript with zero Node-only imports — every scenario
imports from `../../../src/...` or `../fixtures.ts`, both of which
resolve via relative paths.

Drivers import:

```typescript
// Deno + Bun
import { SCENARIOS } from '../../parity/scenarios/index.ts';
```

For Workers, `@cloudflare/vitest-pool-workers` runs Vitest inside
`workerd` and supports TypeScript transpilation through the same Vite
pipeline. Same import shape.

No bundling step is added. The browser driver still bundles
(`build:parity` recipe) because `page.evaluate` serializes function
source; the other runtimes import the module graph natively.

### 3.4 `openRepository` import per runtime

Deno + Bun import from the **built artifact**, not the source:

```typescript
// parity-node.test.ts (Deno + Bun)
import { openRepository } from '../../../dist/esm/index.node.js';

// parity-memory.test.ts (Deno + Bun + Workers)
import { openRepository } from '../../../dist/esm/index.default.js';
```

Rationale:

- The same artifact end users `npm install` is what the matrix exercises.
- `dist/esm/index.node.js` declares `node:` imports — Deno + Bun's Node
  compat layer resolves those; that compat surface IS what we care about
  proving works.
- `dist/esm/index.default.js` (Memory entry) has zero `node:` imports
  (verified by inspection — only `MemoryFileSystem`, `MemoryHashService`,
  etc., all platform-neutral) and is the canonical "runs anywhere"
  entry. Workers consumes it.

Workers' Vitest pool runs the test file's imports through the
@cloudflare/vitest-pool-workers transformer; it loads `dist/esm/
index.default.js` the same way a user-facing Worker would
`import { openRepository } from '@scolladon/tsgit'`.

### 3.5 CI matrix

Three new jobs join `ci.yml`. They mirror the shape of the existing
`parity-tests` job (Node + Memory in Vitest):

```
parity-deno:
  needs: [changes, build]
  if: needs.changes.outputs.code == 'true'
  runs-on: ubuntu-latest
  steps:
    - actions/checkout@v6
    - actions/download-artifact@v4 (name: dist, path: dist/)
    - denoland/setup-deno@v2 (with: deno-version: v2.x)
    - run: deno test --allow-read --allow-write --allow-env --no-prompt \
             test/runtime-parity/deno/

parity-bun:
  needs: [changes, build]
  if: needs.changes.outputs.code == 'true'
  runs-on: ubuntu-latest
  steps:
    - actions/checkout@v6
    - actions/download-artifact@v4 (name: dist, path: dist/)
    - oven-sh/setup-bun@v2
    - run: bun test test/runtime-parity/bun/

parity-workers:
  needs: [changes, build]
  if: needs.changes.outputs.code == 'true'
  runs-on: ubuntu-latest
  steps:
    - actions/checkout@v6
    - actions/download-artifact@v4 (name: dist, path: dist/)
    - ./.github/actions/setup        # Node + npm — vitest-pool-workers
    - run: npx vitest run \
             --config test/runtime-parity/workers/vitest.config.ts
```

All three depend on `build` (introduces a new download-artifact path —
`build` already uploads `dist/`, retention 7 days). All three gate on
`needs.changes.outputs.code == 'true'` so docs-only PRs skip the matrix
(consistent with ADR-103).

Failures are blocking. There is no `continue-on-error` — a runtime that
drifts from parity is a real regression. (Contrast with `benchmark-compare`,
which is informative because runner noise dominates the signal.)

### 3.6 Local runner recipes

New wireit recipes in `package.json`:

```json
"test:parity:deno":    { "command": "deno test --allow-read --allow-write --allow-env --no-prompt test/runtime-parity/deno/",
                         "dependencies": ["build"],
                         "files": ["dist/**/*.js", "test/runtime-parity/deno/**", "test/parity/**"],
                         "output": [] },
"test:parity:bun":     { "command": "bun test test/runtime-parity/bun/",
                         "dependencies": ["build"],
                         "files": ["dist/**/*.js", "test/runtime-parity/bun/**", "test/parity/**"],
                         "output": [] },
"test:parity:workers": { "command": "vitest run --config test/runtime-parity/workers/vitest.config.ts",
                         "dependencies": ["build"],
                         "files": ["dist/**/*.js", "test/runtime-parity/workers/**", "test/parity/**"],
                         "output": [] }
```

Engineers who have `deno`/`bun` installed locally can run the matrix
single-handedly; those who don't will see CI catch the issue. `npm run
validate` does **not** include the runtime-parity matrix — it stays on
the existing harness (Vitest-based) so contributors with no Deno/Bun/
Workers tooling installed still get a green local validate.

CI is the gate. Documented in `CONTRIBUTING.md`.

### 3.7 Determinism

Scenarios are already deterministic (19.5). The audit
(`tooling/audit-parity-fixtures.ts`) globs `test/parity/scenarios/**`;
that path stays unchanged. The new `test/runtime-parity/**` directory
contains drivers (not scenarios) — drivers are allowed to call platform
primitives like `mkdtemp`, so the audit's glob deliberately does NOT
include them.

This is the same separation as 19.5: scenarios are pure, drivers are
platform code.

### 3.8 README + capabilities update

When the matrix lands green:

```diff
- Cross-runtime — Node 22+ · Browser (OPFS) · in-memory
+ Cross-runtime — Node 22+ · Deno · Bun · Cloudflare Workers · Browser (OPFS) · in-memory
```

Also restore the original "60-second quickstart" matrix to include Deno,
Bun, and Workers usage snippets, and update
`docs/understand/architecture.md` (the existing note "deferred to 19.8
with the Workers runtime parity work").

Update lands in the **same PR** as the matrix becoming green — per the
project's "no docs-later" invariant. If the matrix is red, the README
stays at the 19.5 wording.

## 4. Out of scope

- **Performance signal on Deno/Bun/Workers.** No bench job in 19.8.
- **Publishing a Workers-targeted entry point.** `dist/esm/index.default.js`
  is the entry; no `tsgit/worker` export is added. If demand emerges,
  it's a separate phase.
- **HTTP transport scenarios in Workers.** No transport scenarios exist
  in the parity registry today; the Workers driver wouldn't have anything
  unique to exercise on the transport axis. When transport scenarios
  land, they extend Workers automatically.
- **Per-runtime artifact upload on failure.** All five drivers emit
  Vitest/Deno/Bun standard stdout; the GitHub Actions log captures it.
  No structured failure-record schema is added (matches the 19.5
  decision).
- **A `validate` recipe that runs the matrix.** Contributors without
  Deno/Bun/wrangler installed would have a permanently-red local
  validate. CI is the gate.

## 5. Testing strategy

- **The drivers are the tests.** Each runtime executes the same
  `SCENARIOS` registry; matrix passes iff every scenario passes on every
  runtime cell.
- **No unit tests on the driver files.** The drivers are five-line
  iteration loops; the things they could get wrong (wrong scenario, wrong
  adapter, wrong assertion) are caught immediately by the scenario's
  expected-golden assertion.
- **No mutation testing changes.** Stryker scopes to `src/`; this PR
  doesn't touch `src/`.
- **Local validate signal unchanged.** `npm run validate` continues to
  cover unit + integration + parity (Node + Memory) + e2e (Browser).
  Runtime matrix runs in CI only.

## 6. Key design decisions

| Decision | Rationale | Rejected |
|---|---|---|
| Drivers iterate the existing `SCENARIOS` registry verbatim, no per-runtime fork | Single source of truth = single place to break. Parity is the assertion — if the scenarios diverge per runtime, the parity claim itself becomes meaningless | Per-runtime scenario subsets (e.g. "Workers only runs read-only scenarios") — would mask write-path regressions |
| Test against `dist/`, not `npm:@scolladon/tsgit` | PR CI must exercise the code on this branch, not the latest published release. The on-disk dist is what users `npm install` anyway | `npm:` specifier in PR CI — tests last week's code, not this PR's; slower, indirect |
| Workers gets memory adapter only | `workerd` has no filesystem; the Node adapter cannot work there. The Memory adapter IS the runtime story for Workers users | A `workers` adapter shim using KV/R2 — speculative; ships only when a real consumer asks for it |
| `@cloudflare/vitest-pool-workers` over a hand-rolled `wrangler dev` harness | Officially supported, runs Vitest inside real `workerd`, lets the driver share assertion syntax with the existing parity tests | `wrangler dev` + standalone test harness — duplicates work the pool already does, no clear upside |
| Matrix failures are blocking, no `continue-on-error` | The `Cross-runtime` README claim is load-bearing; an informational signal would let regressions ship | Soft gating — would let a Workers regression land unnoticed; defeats the purpose of the matrix |
| No `validate` integration; CI-only | Contributors without Deno/Bun/wrangler shouldn't see a permanently-red local validate. CI is the universally-available gate | Add to `validate` — forces every contributor to install three runtimes |
| Drivers live in `test/runtime-parity/`, not `test/parity/runtimes/` | Keeps the existing `test/parity/` directory laser-focused on scenarios + adapters parity; runtime drivers are a sibling concern | Nest under `test/parity/` — overloads the existing fixtures lint scope |
| README update lands in the same PR as green matrix | Project's no-docs-later invariant. The README claim is true iff the matrix is green | Defer README update — risks the README lying about an unproved capability |

## 7. ADRs to file

| ADR | Subject |
|-----|---------|
| 141 | Test runtime matrix against `dist/`, not `npm:@scolladon/tsgit` specifier (§2.3, §3.4) |
| 142 | Workers driver uses `@cloudflare/vitest-pool-workers` over a hand-rolled `wrangler dev` harness (§3.1, §3.5) |
| 143 | Workers is memory-adapter-only; Deno/Bun cover Node + Memory; no per-runtime scenario subset (§2.4, §3.1) |
| 144 | Matrix failures are blocking — no `continue-on-error`, no informational downgrade (§3.5) |
| 145 | Runtime drivers live in `test/runtime-parity/`, not nested under `test/parity/` (§3.7) |
| 146 | No bundling step for Deno/Bun/Workers drivers — they import scenarios directly via TS-native paths (§3.3) |
| 147 | Runtime-parity matrix runs in CI only, not in `npm run validate` (§3.6) |
