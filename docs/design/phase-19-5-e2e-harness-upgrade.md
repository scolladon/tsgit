# Phase 19.5 — E2E harness upgrade

Wave 0 (test base) continuation. 19.1–19.4 hardened mutation, pyramid, unit
expressiveness, and integration usefulness. 19.5 turns the same lens on the
**end-to-end** tier: Playwright stays the browser driver, fixtures become
deterministic by construction, traces upload on failure, and — the load-bearing
piece — the same scenarios run against the **Node, Browser, and Memory**
adapters from a single shared source. Any divergence is a parity bug.

## 1. Goals

1. **Single source of truth per E2E scenario.** A scenario is one async
   function over the public `Repository` API. It must run unmodified against
   the Node, Browser, and Memory adapters and produce the same result.
2. **Parity is the assertion.** Each scenario's expected result is a single
   structured object. The three adapter runs assert against the same expected
   object; the scenario passes only if all three agree.
3. **Deterministic fixtures.** Author identity, timestamps, file contents, and
   commit messages are pinned constants. Commit IDs (and therefore tree, blob,
   tag IDs) are reproducible byte-for-byte from one run to the next, on every
   adapter, on every OS, on every runtime.
4. **Traces on failure.** Playwright traces + videos + screenshots are kept on
   failure (already configured) and uploaded as a CI artifact under a
   per-browser-and-os name (already configured). Memory and Node runs emit a
   structured failure record so the same triage muscle works across drivers.
5. **No new product code.** Pure test infrastructure. `src/` is not touched.

What 19.5 deliberately does **not** ship — those land in 19.5a and later
phases:

- A gap audit of which commands lack browser coverage (19.5a).
- Property-based scenarios (19.6).
- Canonical-git interop assertions (19.7).
- Deno / Bun / Workers runtime parity (19.8).

## 2. Context

### 2.1 Where E2E lives today

Four Playwright spec files under `test/browser/`:

| File | Surface |
|------|---------|
| `opfs-roundtrip.spec.ts` | `init`→`add`→`commit`→`status` on OPFS |
| `surface-parity.spec.ts` | `log` / `branch` / `checkout` / `tag` on OPFS |
| `hash-interop.spec.ts` | `BrowserHashService` SHA-1 + `readBlob`/`writeObject` round-trip |
| `decompression-stream.spec.ts` | `BrowserCompressor` deflate/inflate |

Playwright config: chromium / firefox / webkit projects;
`trace: 'retain-on-failure'`, `video: 'retain-on-failure'`,
`screenshot: 'only-on-failure'`. CI uploads `test-results/` as the
`playwright-report-<browser>` artifact (14-day retention) on every run.

Webserver: zero-dep `test/browser/serve.mjs` serving the repo root on
loopback. Bundle entry: `test/browser/index.html` imports
`/dist/esm/index.browser.js` and assigns `window.__tsgit`.

### 2.2 What's missing

- **No Node-side or Memory-side E2E.** Every scenario lives inside a
  `page.evaluate()` callback that closes over the browser-runtime entry. If
  the Node or Memory adapter regresses behavior — e.g. branch creation returns
  a different `id` shape on Memory — no current test catches it; only the
  per-adapter unit tests do, and they prove behavior **of the adapter**, not
  parity **across adapters**.
- **No shared expected-output golden.** Each spec asserts ad-hoc shape
  (`expect(id).toMatch(/^[0-9a-f]{40}$/)`). A commit-ID-level golden across
  adapters would catch any drift in tree serialization, hash framing, or
  parent linkage.
- **Fixtures are deterministic by convention, not by structure.** `AUTHOR` is
  a pinned constant in `test/browser/fixtures.ts`; file content is a pinned
  string literal in each spec. There is no shared registry — adding a fifth
  spec means rediscovering the same constants.
- **Fixture provenance is informal.** Nothing stops a future contributor from
  reaching for `Date.now()` in a fresh spec; the convention is enforced only
  by review.

### 2.3 What "same suite re-runs against the Memory adapter" means

The BACKLOG line:

> Same suite re-runs against the memory adapter for Node × Browser × Memory
> parity proof.

is read as: **one scenario, three runs**, with the scenario, expected output,
and assertion all shared. Per the existing layering rule
(`repository → commands → primitives → domain`), a scenario at the
`Repository` layer is the right unit — it crosses the adapter boundary in
exactly the way users will.

## 3. Design

### 3.1 Scenario shape

A **parity scenario** is a single module that exports three things:

```typescript
// test/parity/scenarios/<name>.scenario.ts
// Type-only imports — erased at runtime; same path works for vitest + rollup.
import type { Repository } from '../../../src/repository.ts';
import type { AuthorIdentity } from '../../../src/domain/objects/author-identity.ts';

export interface ScenarioInputs {
  // Constants the scenario writes into the working tree before `run` opens
  // the repo. The driver is responsible for materialising them into whichever
  // FS backs `repo` (Node temp dir, OPFS root, in-memory `/repo`).
  readonly files: ReadonlyArray<{ path: string; content: string }>;
  readonly author: AuthorIdentity;
  readonly message: string;
}

export interface ScenarioResult {
  readonly init: { initialBranch: string; bare: boolean };
  readonly add: { added: ReadonlyArray<string> };
  readonly commit: { id: string; branch: string | undefined };
  readonly status: {
    clean: boolean;
    branch: string | undefined;
    detached: boolean;
    // Raw arrays (not counts) — for the clean-tree scenarios that ship in
    // 19.5, both are `[]`, which is exact-equality safe across adapters.
    // Scenarios that leave a dirty tree must declare the array shape their
    // expected golden agrees on across all three drivers.
    indexChanges: ReadonlyArray<unknown>;
    workingTreeChanges: ReadonlyArray<unknown>;
  };
}

export const INPUTS: ScenarioInputs;     // UPPER_CASE — matches AUTHOR convention in test/browser/fixtures.ts
export const EXPECTED: ScenarioResult;   // golden, including the 40-hex commit.id
// `run` is given an already-opened `Repository` whose backing FS already
// holds `INPUTS.files`. The driver owns FS staging because each backend
// stages differently (Node = real fs.writeFile, Memory = MemoryFileSystem
// seed, Browser = OPFS writable streams).
export const run: (repo: Repository, inputs: ScenarioInputs) => Promise<ScenarioResult>;
```

The contract:

- `INPUTS` is pure data. Structured-cloneable so it crosses
  `page.evaluate()` without serialization tricks.
- `EXPECTED` is the golden — including the deterministic `commit.id`.
- `run` performs the scenario against any `Repository` and returns a
  `ScenarioResult`. It uses only the public facade — no adapter peeking, no
  direct `ctx.*` access.

Adding a new scenario is one file. The runner discovers it automatically.

### 3.2 Three drivers, one scenario

Each driver is a thin Vitest or Playwright wrapper that:

1. Builds a `Repository` against its target adapter,
2. Loads `inputs`, calls `run(repo, inputs)`,
3. Asserts the return value `toEqual(expected)`.

| Driver | Lives in | Repository source |
|--------|----------|-------------------|
| Node | `test/parity/node.test.ts` | `openRepository({ cwd: tmpDir })` from `tsgit/auto/node` against a per-scenario `node:fs/promises.mkdtemp` directory; cleaned in `afterEach` |
| Memory | `test/parity/memory.test.ts` | `openRepository()` from `tsgit/auto/memory` (`src/index.default.ts`) — fresh in-memory FS rooted at `/repo` per test |
| Browser | `test/browser/parity.spec.ts` | Inside `page.evaluate(...)`, `tsgit.openRepository({ rootHandle })` against a reset OPFS |

The Node + Memory drivers are Vitest projects (new project name: `parity`)
because they share the existing harness, run on the same CI job, and don't
need a browser. The Browser driver stays in `test/browser/` so it joins the
existing Playwright matrix automatically. All three iterate over the same
scenario registry — adding `<name>.scenario.ts` lights up all three drivers
in one PR.

Two adapter-specific compromises stay explicit:

- **OPFS gap on WebKit.** The Browser driver inherits the existing skip
  (`test.skip(browserName === 'webkit', 'OPFS not exposed in Playwright
  WebKit')`); Chromium and Firefox still run.
- **`status` arrays after a fresh commit.** The two scenarios shipped in
  19.5 end with `status()` on a clean tree, so `indexChanges` and
  `workingTreeChanges` are `[]` on all three adapters — exact-equality safe.
  Scenarios that intentionally leave a dirty tree must declare an array
  shape that *all three adapters agree on*; if an adapter reports a
  different shape (e.g. rename detection differs), the scenario is rejected
  at design time and rewritten until it agrees, or split so the divergent
  slice runs only on the affected driver.

### 3.3 Crossing the `page.evaluate` boundary

The Browser driver runs scenarios inside `page.evaluate(fn, args)`, which
serializes `fn` to source. Two ways to expose the scenario function:

**A. Bundle the scenarios into the harness.** Extend `test/browser/index.html`
to import each `<name>.scenario.ts`'s `run` and `inputs` and attach them to
`window.__tsgitParity`. Browser spec body becomes:

```typescript
const actual = await page.evaluate(({ name }) => {
  const tsgit = window.__tsgit;
  const scenario = window.__tsgitParity[name];
  return scenario.run(tsgit.openRepository({ rootHandle: ... }), scenario.inputs);
}, { name: 'init-add-commit-status' });
expect(actual).toEqual(scenario.expected);
```

**B. Serialize the function source on the Node side.** `page.evaluate(run, ...)`
where `run` is `scenario.run`. Cost: the function must be a pure top-level
arrow with no closure over its file; Vitest's transform pipeline doesn't
serialize cleanly past `import.meta.url`-bearing code paths.

Option A is chosen. It mirrors how `window.__tsgit` is exposed today
(`test/browser/index.html` lines 11–32) and keeps the boundary explicit:
scenarios are first-class artifacts the bundle declares, not function bodies
smuggled at runtime. The build cost is one new wireit recipe — `build:parity`
— that drives a small standalone rollup invocation
(`tooling/build-parity-bundle.ts`) reading `test/browser/parity-scenarios.bundle.ts`
(itself a barrel that imports every `.scenario.ts` and registers them on
`window.__tsgitParity`) and emitting `test/browser/parity-scenarios.bundle.js`.
The Playwright `test:e2e` wireit recipe gains `build:parity` as a dependency,
mirroring its existing dependency on `build`. The bundle output is
`.gitignore`d. See ADR-127.

### 3.4 Deterministic fixtures

A single `test/parity/fixtures.ts` exports the canonical author and the
working-tree constants every scenario draws from:

```typescript
export const AUTHOR: AuthorIdentity = {
  name: 'tsgit Parity',
  email: 'parity@tsgit.dev',
  timestamp: 1_700_000_000,
  timezoneOffset: '+0000',
};

export const MESSAGES = {
  seed: 'seed commit',
  second: 'second commit',
} as const;

export const FILES = {
  helloA: { path: 'a.txt', content: 'hello a\n' },
  helloB: { path: 'b.txt', content: 'hello b\n' },
} as const;
```

Scenarios import these constants — no inline literals. Adding a new content
fixture requires editing this file, which is the chokepoint where future
contributors notice the deterministic-only rule.

No clock-pinning helper is needed: `AUTHOR.timestamp` is the only
clock-derived input that ever lands in a commit. tsgit does not read
`Date.now()` inside `createCommit` (verified by inspection — author identity
is supplied explicitly; no other commit field is clock-derived).

Determinism is gated two ways:

- **Lint rule (new).** `tooling/audit-parity-fixtures.ts` runs in CI and
  fails if any file under `test/parity/scenarios/**` (or the fixtures barrel)
  matches `Date.now(`, `Math.random`, `performance.now(`, or a `new Date(`
  constructor that is not invoked with exactly one pinned-string literal
  argument. Same shape as the existing pyramid audits in
  `tooling/test-pyramid/`; exit non-zero on finding.
- **Golden assertion.** Each scenario's `EXPECTED.commit.id` is a 40-hex
  literal. If any driver produces a different ID, the golden mismatch fails.
  This is the strongest determinism signal: a single byte of non-determinism
  changes the SHA-1.

### 3.5 Trace + artifact uniformity

Playwright today: `trace: 'retain-on-failure'` (good),
`video: 'retain-on-failure'` (good), `screenshot: 'only-on-failure'` (good).
CI: `actions/upload-artifact@v7` on the `test-results/` directory under
`playwright-report-<browser>` with 14-day retention (good).

19.5 changes:

- **Per-OS in the Playwright artifact name.** Forward-compatible with 19.8.
  Static `-ubuntu` suffix today (`playwright-report-<browser>-ubuntu`) so
  later jobs that add a matrix don't have to rename the artifact basename
  — they just bump the suffix. Suffix is a literal string, not a
  `${{ matrix.os }}` reference, since 19.5 does not introduce a matrix.
- **New `parity-tests` CI job.** Runs `npm run test:parity` (Vitest project
  `parity` covering Node + Memory drivers) on `ubuntu-latest`, gated on
  `needs.changes.outputs.code == 'true'` (mirrors `integration`). On failure,
  uploads `reports/parity/` (Vitest's JSON reporter output) as the
  `parity-report-node-memory` artifact, 14-day retention. The directory
  always exists (the reporter writes even on success), so a failed step
  doesn't break the upload.

### 3.6 New file tree

```
test/
├── parity/
│   ├── fixtures.ts                       # AUTHOR, MESSAGES, FILES
│   ├── scenarios/
│   │   ├── init-add-commit-status.scenario.ts
│   │   └── branch-lifecycle.scenario.ts
│   ├── node.test.ts                      # Vitest driver — Node adapter
│   └── memory.test.ts                    # Vitest driver — Memory adapter
├── browser/
│   ├── parity.spec.ts                    # Playwright driver — Browser adapter
│   ├── index.html                        # extended to import parity bundle
│   └── parity-scenarios.bundle.ts        # rollup entry exposing window.__tsgitParity
└── ...
tooling/
├── audit-parity-fixtures.ts              # determinism gate
├── build-parity-bundle.ts                # standalone rollup driver (build:parity)
└── test/unit/parity-fixtures/            # detector unit tests, 100% coverage
```

`ScenarioInputs.files[].content` is `string`. Each driver encodes via
`new TextEncoder().encode(content)` when handing bytes to its FS layer — that
keeps the scenario module structured-cloneable across `page.evaluate` and
puts the one place where bytes are produced in the driver, not the scenario.

Two scenarios ship in 19.5: `init-add-commit-status` and `branch-lifecycle`.
Both already exist as ad-hoc specs in `test/browser/` — they are *the*
candidates to migrate, because the Browser side is already proved out. 19.5a
will gap-audit the remaining surface and queue migrations.

The two ad-hoc specs (`opfs-roundtrip.spec.ts`, `surface-parity.spec.ts` —
the `branch` describe) stay in place under 19.5 — the parity scenarios are
*additive*. 19.5a's gap audit will identify which ad-hoc specs are pure
duplicates of a parity scenario and remove them in a follow-up. This keeps
the 19.5 diff focused: scenario infrastructure + two scenarios + audit + CI
wiring, no spec deletions.

## 4. Out of scope

- **More than two scenarios.** The infrastructure is what 19.5 ships;
  filling it is 19.5a + later.
- **Deletion of ad-hoc browser specs.** Defer to 19.5a after the audit.
- **Mutation testing on `test/parity/**`.** The parity scenarios test
  parity, not the SUT; Stryker is unaffected.
- **Failure-record schema for the Node / Memory diff upload.** Land a
  minimal `{ driver, scenarioName, expected, actual }` first. A richer
  schema can come later if triage demands it.

## 5. Testing strategy

- **The drivers are the tests.** `vitest run --project parity` for Node and
  Memory; `npx playwright test` for Browser.
- **Unit tests for `tooling/audit-parity-fixtures.ts`.** Same shape as the
  existing pyramid audit detectors — fixture inputs, expected findings, no
  filesystem reads. Goal: 100% line/branch/function/statement coverage on
  the audit module (matches project bar).
- **No `src/` change.** `npm run validate` exercises only `check:filesystem`
  (kebab-case for the new files), `check:types`, and the new parity drivers.

## 6. Key design decisions

| Decision | Rationale | Rejected |
|---|---|---|
| Scenarios are pure async functions over `Repository`, not adapter-aware | The public facade is the layer users compose; parity at that layer is what matters | Adapter-specific scenarios (mocks the value prop) |
| Three drivers per scenario, each in its own runner | Browser needs Playwright; Node + Memory ride on Vitest projects — splitting matches the existing project layout (`vitest.config.ts:13`) | One mega-runner shoehorning Playwright into Vitest — fights both tools |
| Bundle scenarios into the browser harness via rollup (Option A in §3.3) | Mirrors `window.__tsgit` exposure (`test/browser/index.html:11`); scenarios become first-class build artifacts | Smuggle function source through `page.evaluate(run)` — fragile against the Vitest transform |
| Golden `commit.id` per scenario | A single byte of non-determinism mutates the SHA-1 — the assertion catches what a lint can't | Shape-only assertions (`/^[0-9a-f]{40}$/`) — what the current specs do; can't catch tree-serialization drift |
| Lint gate on `Date.now`/`Math.random`/non-pinned `new Date(` under `test/parity/scenarios/**` | Prevents the determinism rule from rotting; matches the audit-test-pyramid shape | Convention-only enforcement (today's state) — already shown to drift across four specs |
| Two scenarios ship in 19.5, the rest follow with 19.5a | Keeps the harness-upgrade diff tractable; the audit-driven migration is its own review unit | Migrate every ad-hoc spec in this PR — bloats the diff past one-sitting review |
| Ad-hoc browser specs stay in place under 19.5 (additive parity layer) | Decouples *building the harness* from *retiring duplicates*; the audit in 19.5a is the right place to identify which specs are pure duplicates | Delete duplicates in this PR — couples a non-trivial subjective call to the infrastructure PR |

## 7. ADRs to file

| ADR | Subject |
|-----|---------|
| 127 | Scenarios cross `page.evaluate` via bundled `window.__tsgitParity`, not function-source serialization (§3.3) |
| 128 | Golden `commit.id` per scenario as the load-bearing determinism signal (§3.4) |
| 129 | Parity scenarios are additive in 19.5; duplicate ad-hoc specs are retired in 19.5a (§3.6) |
