# Phase 16.3 / 16.4 — Browser E2E surface parity & per-step round-trip

Design for two Phase 16 test-quality items:

- **16.3** Extend `test/browser/` to exercise `log`, `branch`, `checkout`,
  `tag` against OPFS (a Phase 11 test-review gap).
- **16.4** Split the `opfs-roundtrip` mega-scenario into per-step assertions
  so a failure names the exact git operation that broke.

## 1. Context

`test/browser/` currently holds three Playwright spec files:

| File | Proves |
|------|--------|
| `opfs-roundtrip.spec.ts` | `init`→`add`→`commit`→`status` against the OPFS `FileSystem` port |
| `hash-interop.spec.ts` | `BrowserHashService` SHA-1 parity + `readBlob`/`writeObject` round-trip |
| `decompression-stream.spec.ts` | `BrowserCompressor` deflate/inflate via `DecompressionStream` |

The commands `log`, `branch`, `checkout`, `tag` are 100% unit-tested on the
Node adapter but never run in a real browser. The browser E2E suite exists to
prove each command *composed with the browser adapters* (the OPFS `FileSystem`
port, `BrowserHashService`, `BrowserCompressor`) behaves correctly in a real
engine — so the four uncovered commands are a genuine surface gap.

`opfs-roundtrip.spec.ts` runs all four operations inside a single
`page.evaluate()` and asserts only the final aggregate (`clean`, `branch`,
`commitId`). When it fails, the message is `expect(clean).toBe(true)` —
it does not say whether `init`, `add`, `commit`, or `status` was at fault.

## 2. Constraints

- **The `evaluate` boundary.** Browser test code runs inside
  `page.evaluate()`. Only structured-cloneable values cross the Node↔browser
  boundary; the `repo` object returned by `openRepository` holds functions and
  cannot be returned from one `evaluate()` and reused in the next. Playwright
  serializes an `evaluate` callback to source, so each callback must be
  self-contained — no closing over Node-side imports or helpers.
- **OPFS persists within a page.** OPFS is origin-scoped and survives across
  `evaluate()` calls on the same page. The `resetOpfs` fixture wipes it once
  before each test, so successive `evaluate()`s within a test share a single
  evolving OPFS root.
- **WebKit gap.** Playwright's headless WebKit does not expose
  `navigator.storage.getDirectory`. Every OPFS-dependent test skips on
  `webkit` (existing pattern — `opfs-roundtrip.spec.ts`, `hash-interop.spec.ts`).
- **`FileSystemDirectoryHandle` is re-obtainable.** `navigator.storage
  .getDirectory()` returns the same persistent root on every call, so a repo
  can be re-opened freely.

## 3. Design

### 3.1 Per-operation assertions (16.4)

The round-trip scenario runs in **one** `page.evaluate()` that performs every
operation and returns a result object keyed by operation —
`{ init, add, commit, status }`, each holding that operation's own return
value. The test body then asserts each slice under its own Playwright
`test.step()`, so the report and trace name the operation.

`opfs-roundtrip.spec.ts` is rewritten so the body reads:

| `test.step` | Asserts on the result slice |
|-------------|-----------------------------|
| `init` | `init.initialBranch === 'main'` (short name); `init.bare === false` |
| `add` | `add.added` contains `a.txt` |
| `commit` | `commit.id` is 40-hex; `commit.branch === 'refs/heads/main'` |
| `status` | `status.clean === true`; `status.branch === 'refs/heads/main'`; `indexChanges` and `workingTreeChanges` both empty |

Why one `evaluate()` returning a keyed result, rather than one `evaluate()`
per operation:

- The `repo` object cannot cross the `evaluate` boundary, so a
  per-operation split would have to **re-open the repo inside every step** —
  multiplying the `openRepository`/`try`/`finally dispose` boilerplate ~20×
  across the two new spec files. One `evaluate()` per scenario keeps that
  boilerplate to a single occurrence, matching the existing three spec files.
- The literal ask of 16.4 is *per-step **assertions*** for sharper failure
  messages. A keyed result delivers exactly that: `init` and `commit` are
  asserted independently, each under a named `test.step`. The current code's
  single trailing `expect(clean).toBe(true)` is what loses the attribution —
  not the single `evaluate()`.
- Failure attribution is preserved both ways: if an operation **throws**, the
  `evaluate()` rejects with that operation's own typed `TsgitError`
  (e.g. `NOTHING_TO_COMMIT`) — already a sharp message; if an operation
  **returns a wrong value**, the matching `test.step` is the one that fails.

### 3.2 Surface-parity scenarios (16.3)

A new `surface-parity.spec.ts` adds four `test.describe` blocks, one per
command, each guarded by the `webkit` OPFS skip. Each test seeds its baseline,
then runs the command(s) under test in a single `evaluate()` returning a keyed
result, asserted per-operation under `test.step()`:

- **`log`** — `seedRepo` (one commit); a second `evaluate` writes a distinct
  `b.txt` and `add`+`commit`s it (a changed tree, else `commit` throws
  `NOTHING_TO_COMMIT`); a third `evaluate` calls `log()`. Assert two entries
  in reverse-chronological (first-parent) order, messages match, and the
  newest entry's `parents` contains the older `id`.
- **`branch`** — `seedRepo`; one `evaluate` runs `create` → `list` →
  `delete` → `list`, returning all four results. `test.step`s assert: create
  returns `refs/heads/feature`; the first list has `feature` (`current:
  false`) beside `main` (`current: true`); delete returns `feature`; the
  second list no longer contains it.
- **`checkout`** — one `evaluate`: seed `a.txt = "v1"` (init/add/commit);
  create `feature`, checkout it, overwrite `a.txt = "v2"`, add+commit;
  checkout `main` and read `a.txt`; checkout `feature` and read `a.txt`.
  Returns `{ onMain, onFeature }`. `test.step`s assert `onMain === "v1"` and
  `onFeature === "v2"` — proving checkout materializes each branch's tree.
- **`tag`** — `seedRepo`; one `evaluate` runs `create` → `list` → `delete`
  → `list`, mirroring the `branch` flow against `refs/tags/`.

### 3.3 Shared seeding helper — `fixtures.ts`

`fixtures.ts` gains one Node-side helper, `seedRepo(page)`, alongside the
existing `waitForTsgitReady` / `resetOpfs`. It runs a single self-contained
`page.evaluate()` that writes `a.txt`, opens the repo, runs
`init`→`add`→`commit`, disposes, and returns `{ commitId, branch }`. The
`log`, `branch`, and `tag` scenarios call it for their common one-commit
baseline; `checkout` seeds inline because it needs specific file content
(`v1`). `seedRepo` is a *Node-side* function (it calls `page.evaluate`), so
it composes cleanly — it is not a callback shared *into* an `evaluate`.

Each spec self-declares the `window.__tsgit` typings it uses, matching the
existing three spec files (each already declares its own). Keeping that
pattern avoids coupling some specs to `fixtures.ts` type exports while
leaving others independent; the small repetition of interface declarations
is accepted for a consistent, decoupled suite.

## 4. Out of scope

- `index.html` harness — `openRepository` already returns the full repo
  facade (`log`/`branch`/`checkout`/`tag` included); no new global is needed.
- `playwright.config.ts`, CI `e2e` job, `package.json` `test:e2e` `files`
  globs — all match `test/browser/**/*.spec.ts`; new specs are auto-discovered.
- Refactoring `hash-interop.spec.ts` / `decompression-stream.spec.ts` — not
  touched, so their local typings are left as-is (minimal diff).
- `merge`, `clone`, `fetch`, `push` browser coverage — beyond the four
  commands 16.3 names; transport-dependent scenarios are a separate concern.

## 5. Testing strategy

- The specs *are* the tests: Playwright across `chromium`, `firefox`,
  `webkit`. OPFS scenarios skip on `webkit` (engine gap, not a tsgit gap).
- `npm run test:e2e` builds `dist/` first (wireit `dependencies: ["build"]`),
  then runs Playwright; the harness `index.html` imports the built bundle.
- No `src/` change — `npm run validate` is exercised only by `check:spelling`
  (docs), `check:filesystem` (the new kebab-case spec), and the new test
  files under `test/browser/`. Mutation testing has no changed `src/` surface.

## 6. Key design decisions

- **One `evaluate()` per scenario, keyed result, `test.step`-wrapped
  assertions.** Delivers 16.4's per-step assertions and the trace-step
  timeline without re-opening the repo per operation — which would multiply
  the open/dispose boilerplate ~20× and contradict the existing suite's
  one-`evaluate`-per-scenario shape. Rejected: re-open-per-step, for that
  duplication cost; rejected: a single trailing aggregate assertion (the
  status quo), for the opaque failure message it produces.
- **One `surface-parity.spec.ts`, four `describe` blocks** — the four
  commands are one cohesive "ref & history surface" scenario; one file keeps
  the suite at four spec files. Rejected: four `log/branch/checkout/tag.spec
  .ts` files — finer-grained than the existing capability-named layout.
- **`seedRepo` is the only shared helper, and only Node-side** — it removes
  the one-commit seeding duplication across `log`/`branch`/`tag` without
  smuggling a callback across the `evaluate` boundary.
- **Self-declared window typings per spec** — matches all three existing
  spec files; avoids partial coupling to `fixtures.ts` type exports.
