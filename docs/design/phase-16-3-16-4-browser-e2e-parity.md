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
  `page.evaluate()`. Only structured-clonable values cross the Node↔browser
  boundary; the `repo` object returned by `openRepository` holds functions and
  cannot be returned from one `evaluate()` and reused in the next.
- **OPFS persists within a page.** OPFS is origin-scoped and survives across
  `evaluate()` calls on the same page. The `resetOpfs` fixture wipes it once
  before each test, so steps within a test share a single evolving OPFS root.
- **WebKit gap.** Playwright's headless WebKit does not expose
  `navigator.storage.getDirectory`. Every OPFS-dependent test skips on
  `webkit` (existing pattern — `opfs-roundtrip.spec.ts`, `hash-interop.spec.ts`).
- **`FileSystemDirectoryHandle` is re-obtainable.** `navigator.storage
  .getDirectory()` returns the same persistent root on every call, so a repo
  can be re-opened freely.

## 3. Design

### 3.1 Per-step pattern (16.4)

Each git operation becomes one Playwright `test.step()` wrapping one
`page.evaluate()`. The evaluate re-opens the repo
(`openRepository({ rootHandle })`), performs **one** operation, returns that
operation's structured result, and disposes the repo in a `finally`. The test
body asserts the step's result before the next step runs.

`opfs-roundtrip.spec.ts` is rewritten to four steps:

| Step | Operation | Asserted |
|------|-----------|----------|
| `init` | `repo.init()` | `InitResult.initialBranch === 'refs/heads/main'` |
| `add` | `repo.add(['a.txt'])` | `AddResult.added` contains `a.txt` |
| `commit` | `repo.commit({ message, author })` | `id` is 40-hex; `branch === 'refs/heads/main'` |
| `status` | `repo.status()` | `clean === true`; `branch === 'refs/heads/main'`; no index/working-tree changes |

The working file `a.txt` is written as plain Arrange (one `evaluate`, not a
step) before the steps, since it is harness setup, not a git operation.

Why re-open the repo per step rather than thread one instance through:

- A function-valued `repo` cannot survive the `evaluate` boundary — re-opening
  is *required*, not a stylistic choice.
- Each command in the repo facade reads and writes its `.git` state from the
  filesystem (there is no correctness-bearing in-memory index shared across
  commands), so re-opening is behaviour-equivalent to one long-lived session
  **and** additionally proves cross-session persistence: every step reads the
  `.git` bytes the previous step flushed to OPFS.
- Playwright stops a test at the first failed `expect`, so a broken `init`
  does not cascade into misleading `add`/`commit` noise — the report names the
  failing step.

### 3.2 Surface-parity scenarios (16.3)

A new `surface-parity.spec.ts` adds four `test.describe` blocks, one per
command, each guarded by the `webkit` OPFS skip:

- **`log`** — seed one commit, then write a *distinct* second file and
  `add`+`commit` again (a changed tree, else `commit` throws
  `NOTHING_TO_COMMIT`); call `log()` and assert two entries in
  reverse-chronological (first-parent) order, that messages match, and that
  the newest entry's `parents` contains the older id.
- **`branch`** — seed one commit, then a `create` → `list` → `delete`
  sequence as three `test.step`s: create returns the new ref; list shows it
  with `current: false` alongside `refs/heads/main` as `current: true`;
  delete removes it and a follow-up list no longer contains it.
- **`checkout`** — seed `a.txt = "v1"` on `main`; create branch `feature`,
  checkout `feature`, overwrite `a.txt = "v2"`, add+commit; checkout `main`
  and assert the working file reads `v1`; checkout `feature` and assert `v2`.
  Each checkout + read is its own step.
- **`tag`** — seed one commit, then `create` → `list` → `delete` as three
  steps, mirroring the `branch` flow against `refs/tags/`.

### 3.3 Shared seeding helper — `fixtures.ts`

`fixtures.ts` gains one Node-side helper, `seedRepo(page)`, alongside the
existing `waitForTsgitReady` / `resetOpfs`. It runs a single self-contained
`page.evaluate()` that writes `a.txt`, opens the repo, runs
`init`→`add`→`commit`, disposes, and returns `{ commitId, branch }`. The
`log`, `branch`, and `tag` scenarios call it for their common prerequisite;
`checkout` seeds inline because it needs a specific file content (`v1`).

`seedRepo` is the only shared helper: it is a *Node-side* function (it calls
`page.evaluate`), so it serializes cleanly. No helper is shared *into* an
`evaluate` callback — Playwright serializes callbacks to source, so a callback
must be self-contained. Each spec therefore self-declares the
`window.__tsgit` typings it uses, matching the existing three spec files
(`opfs-roundtrip`, `hash-interop`, `decompression-stream` already each declare
their own). Keeping that pattern avoids coupling some specs to `fixtures.ts`
type exports while leaving others independent; the ~15 lines of repeated
interface declarations are accepted for a consistent, decoupled suite.

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
  (docs), `check:filesystem` (new kebab-case spec), and the new test files
  under `test/browser/`. Mutation testing has no changed `src/` surface.

## 6. Key design decisions

- **Per-step = `test.step()` + one `evaluate()` per step, repo re-opened.**
  Re-opening is mandatory (functions cannot cross the boundary) and is
  behaviour-equivalent to a long-lived session while adding persistence
  coverage. Rejected: a single `evaluate()` returning a step-result record —
  it would keep failures inside one opaque Playwright assertion and miss the
  trace-viewer step timeline.
- **One `surface-parity.spec.ts`, four `describe` blocks** — the four
  commands are one cohesive "ref & history surface" scenario; one file keeps
  the suite at four spec files. Rejected: four `log/branch/checkout/tag.spec
  .ts` files — finer-grained than the existing capability-named layout.
- **Self-declared window typings per spec** — matches all three existing
  spec files; avoids partial coupling to `fixtures.ts` type exports.
