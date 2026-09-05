# Plan — the memory and browser adapters refuse an occupied name on every write surface

> Source: design doc `docs/design/memory-write-exclusive-directory.md` · ADRs 810, 811, 812,
> 813, 814, 815, 816, 817, 818, 819
> The plan is the implementation script AND the knowledge handoff. Part agents start
> with zero context: whatever a part block omits is paid later as agent rediscovery.
> `plan-lint.sh` enforces the schema below — the plan phase cannot close without it.

## How to read the design doc

The design is **settled**: its own decision-candidate section raises none, and ADRs 810–819
ratify every choice. Where the design body and an ADR disagree, the ADR wins — they do not
disagree anywhere here. Do **not** re-derive the matrices in §1a–§1f; they were probed on
2026-09-05 against the composed adapter classes and are the oracle this plan copies from.

Six things the design states loosely, wrongly, or not at all. Each is resolved here — do not
re-litigate them:

| Design says | What this plan implements, and why |
|---|---|
| §3e: the string mutant on `` `${src}/` `` "is killed by the N10 *parent* row — with the slash dropped, `'/repo'.startsWith('/repo')` is true and N10 would flip" | **Wrong arithmetic.** For the parent arrangement (`src = /repo/a/b`, `dst = /repo/a`) dropping the slash gives `'/repo/a'.startsWith('/repo/a/b')` → still `false`, so N10 does not flip and does not kill it. The mutant Stryker actually emits for a template literal is *replacement by the empty string*, making `dst.startsWith('')` **always true** — killed by any **positive directory rename** (fresh destination, empty-destination replace, `src === dst`). Part 4 therefore requires those positive rows *and* a **prefix-boundary sibling** row (`src = /repo/a`, `dst = /repo/ab`, which must **succeed**) as the semantic pin. The N10 parent row still ships — it proves the parent arrangement is `DIRECTORY_NOT_EMPTY`, not the inside-source refusal — it is simply not the mutant killer |
| §Documentation surfaces: "`cspell.json` … lands in the implementation commit that introduces the literal" | The literal first appears in **Part 1's posix-only test file**, not in the memory adapter — `check:spelling` covers `test/**/*.ts`. So the dictionary word ships in **Part 1** |
| §Test strategy quotes `memory-file-system.ts:186` as the `readdir` proof and `:291` as the `renameDirectory` remap proof | Verified against the worktree: **:186** (`readdir` files/dirs disjoint), **:204**, **:213**, **:291**, **:343**, **:352**, **:359**, **:392**, **:497**, **:515**, **:544**, **:553**. All twelve match the design's verdict table; none needs an edit. Line numbers **drift** as parts add code — a `Stryker disable next-line` directive anchors on the line that follows it, so it stays correct as long as it stays glued to its expression |
| §5 / §Gates: "`npx tsc --noEmit -p tsconfig.json`" as the uncached type check | `check:types` actually runs `tsc --noEmit -p tsconfig.typecheck.json`, which is `tsconfig.json` **plus** an incremental build-info cache. Both cover the same file set (`src/**`, `test/**`, `tooling/**`). Use `tsconfig.json` — it is the stricter, uncached form |
| §Test strategy: "a dynamic `import('/dist/esm/adapters/browser/index.js')` inside `page.evaluate`" | **A literal specifier does not type-check.** Measured with this repo's `tsc`: the literal form raises **TS2307 "Cannot find module '/dist/esm/adapters/browser/index.js'"**; binding the specifier to a `const` first and importing *that* is clean (exit 0). Part 5 carries the exact shape |
| Nothing in the design says where the port JSDoc rewrite pays its **`reports/api.json`** cost | `check:doc-typedoc` is literally `git diff --exit-code -- reports/api.json` with `docs:json` as its dependency, and `docs:json`'s inputs include `src/**/*.ts`. The `writeExclusive` JSDoc text is embedded in `reports/api.json` **five times** today (`grep -c "exclusive create"`). Every part that edits `src/ports/file-system.ts` therefore **regenerates and commits `reports/api.json` in the same commit** — otherwise `validate` is green and the push hook rejects |

---

## Sizing rules

- Every part costs a full agent lifecycle (spin-up, zero-context rebuild, gate) — it
  must earn it. No standalone test-only parts for FEATURE code: coverage/interop/property
  tests fold into the implementation part whose code they exercise. EXCEPTION:
  test-infra-only and docs-only parts (tooling config, test helpers, fixtures,
  harness/ADV/property suites, docs/prose) with no `src/` delta ARE standalone — they
  have no implementation part to fold into.
- A part that would be a pure test pass over already-landed code merges into its
  neighbour.

**The cut: five parts, and why.** Three of them are one guard each on the memory adapter —
`writeExclusive`, `write`, `rename` — because each is a distinct method, a distinct ADR, a
distinct describe block and a distinct set of shared-contract rows, and because a contract row
landing before the guard it exercises is red on the memory driver. Every guard's tests ride in
the guard's own part; there is **no standalone test part for feature code**.

Part 1 (the posix-only node pin) is the one legitimate standalone: it has **zero `src/` delta**
— it characterises the *unchanged* node adapter — it spans both the `write` and the `rename`
matrices so it cannot be folded into either guard's part, and it owns a gate (`npm run
test:posix-integration`) that neither `validate` nor `test:integration` runs. It goes **first**
so a disagreement with §1d/§1e surfaces before three parts encode a wrong code, and because it
is the part that introduces the errno string literal and therefore owns the dictionary word.

Part 5 (browser) is separate because it is outside both the coverage gate and the mutation gate,
its only proof is Playwright, and its gate needs a **build first**.

---

## Public-vs-internal, decided up front

| New symbol | Verdict | Gates tripped (pre-paid in the owning part) |
|---|---|---|
| `MemoryFileSystem.occupied(normalized)` (Part 2) | **internal** — `private` method, no export | none |
| `MemoryFileSystem.assertRenamable(src, dst, reported)`, `MemoryFileSystem.renameLeaf(src, dst)` (Part 4) | **internal** — `private` methods | none |
| The module-level `const` holding POSIX's invalid-argument errno name in `memory-file-system.ts` (Part 4) | **internal** — module-private, **not exported** | `cspell.json` word — already paid in Part 1 |
| `isTypeMismatch(err)`, `isNotFoundRejection(err)` in `browser-file-system.ts` (Part 5) | **internal** — module-level, **not exported**, siblings of the existing `isFileNotFound` (`:295`) | none |
| `assertRefusedWithoutCode(err)` in `test/unit/ports/file-system.contract.ts` (Part 3) | **test-internal** — module-private helper beside `assertNotADirectory` (`:93`) | none |
| `test/integration/posix-only/node-fs-write-rename-refusals.test.ts` (Part 1) | **test file** | `@proves` header (report-only), tier heuristics (gated) |

**No new public export, no new Tier-1 command, no new error code, no new union member.**
`BrowserFileSystem` is *already* a public export (`src/adapters/browser/index.ts:3`). So none of
`check:doc-coverage`, `check:browser-surface`, the `Repository` facade, the sorted
`Object.keys(sut)` snapshot in `test/unit/repository/repository.test.ts`, the "N Tier-1 commands"
README line, nor `src/domain/error.ts`'s exhaustiveness switches is touched. `FILE_EXISTS`,
`PERMISSION_DENIED`, `NOT_A_DIRECTORY`, `DIRECTORY_NOT_EMPTY`, `FILE_NOT_FOUND` and
`UNSUPPORTED_OPERATION` are all reused verbatim.

**`reports/api.json` moves in exactly three parts — 2, 3 and 4** — each because it edits a
JSDoc comment on the published `FileSystem` port interface. Parts 1 and 5 regenerate it too and
expect **no diff**; a diff there means something leaked into the public surface.

---

## Notation — the errno this plan may not spell

POSIX's **invalid-argument errno** is written `INVALID-ARGUMENT` throughout this plan, exactly as
the design writes it. Its real six-letter `E`-prefixed name is **not** in `cspell.json`, and this
plan commit is scoped to a single file, so the stand-in survives here.

**How the implementer gets the real spelling, mechanically:**

```
node -p "const e=require('os').constants.errno; Object.keys(e).filter(k=>e[k]===22)"
```

It is also the exact `reason` string a real `NodeFileSystem.rename` of a directory into itself
throws — Part 1 observes it directly. `mapErrno` (`src/adapters/node/node-file-system.ts:218–247`)
has **no case** for it, so it falls to the `default` arm (`:244–245`),
`unsupportedOperation('filesystem', err.code ?? 'UNKNOWN')`, which forwards the raw errno name
verbatim.

**The dictionary insertion (Part 1).** `cspell.json`'s word list is case-insensitively
alphabetical and interleaves cases. Today `cspell.json:287` is `"effectful"` and `:288` is
`"EISDIR"`. The errno name sorts **between them**. Insert exactly one line there.
**Never re-sort the file. Never a `cspell:disable` comment.**

---

## Docs this plan does NOT touch

These are the **documentation phase's** surfaces. No part below may edit them; a part that does
is out of bounds.

- `docs/design/ports-and-adapters.md:561` (the `writeExclusive` line that codified the bug),
  `:565` (the `rename` line), and the memory bullet list (which has no `write` bullet at all).
- `docs/use/errors.md:41` (`DIRECTORY_NOT_EMPTY`), `:42` (`FILE_EXISTS`), `:44`
  (`NOT_A_DIRECTORY`), `:46` (`PERMISSION_DENIED`).
- `docs/get-started/memory.md`, `docs/understand/architecture.md:132–133`.
- `docs/BACKLOG.md` — **no tick**: this is not a backlog item.

The **port JSDoc** in `src/ports/file-system.ts` is *not* in that list — it is source, it is
covered by ADR-813 / R11 / R26, and it belongs to Parts 2, 3 and 4.

---

## Repo-wide facts every part needs

- **Part gate** (each part runs it before committing, from the manifest's `gates.part`):
  `npx vitest run <touched-tests> && npm run check:types && ./node_modules/.bin/biome check <touched-files> && npm run check:spelling`
- ⚠️ `npm run check:types` and `npm run check:spelling` are **wireit-cached**;
  `Ran 0 scripts and skipped 1` reads exactly like a pass and has put commits on red here.
  Always **also** run the bare forms: `npx tsc --noEmit -p tsconfig.json` and
  `npx cspell --no-progress <touched-files>`.
- ⚠️ **Never read a gate through a pipe.** `… | tail` reports exit 0 on a red run. Run gates
  bare into a file and `echo $?`; if you background a gate, write the *real* exit code into the
  log and read it from there — a wrapper's exit code has lied twice in this repo.
- ⚠️ **Confirm a scripted edit landed.** A `replace`-style edit anchored on verbatim statement
  text can abort *after* biome re-wrapped the line, leaving the file unchanged while the tool
  reports success. Run `git diff --stat` and eyeball the hunk before trusting any gate.
- **Phase gate**: `npm run validate`, run **once by the orchestrator after Part 5** — never
  inside a part.
- **Coverage** (`vitest.config.ts:80–90`) gates `src/domain/**`, `src/ports/**`,
  `src/adapters/node/**`, `src/adapters/memory/**`, `src/operators/**` at **100 %**
  line/branch/function/statement. `src/adapters/browser/**` is **not** in `coverage.include`.
  Stryker mutates all of `src/` **except** `src/adapters/browser/**` (`stryker.config.mjs`). So
  Parts 2–4 are coverage-gated *and* mutated; Part 5 has **Playwright as its only proof**.
- **Guard terms need isolated tests.** For `if (A || B)`, write one test that trips **A alone**
  and one that trips **B alone**. A single test tripping both proves neither term — this is the
  highest-yield real-survivor class in this repo. Same for each `&&` term: one case where that
  term alone is the false one.
- **Test conventions.** `describe('Given …')` > `describe('When …')` > `it('Then …')` in
  `test/unit/adapters/memory/memory-file-system.test.ts` and
  `test/integration/posix-only/**`; the **1-level** `it('Given …, When …, Then …')` form in
  `test/unit/ports/file-system.contract.ts` and `test/browser/*.spec.ts`. AAA body with
  `// Arrange` / `// Act` / `// Assert` section comments. The thing under test is bound to
  `sut` — never the result (the result goes in `result`). Error assertions use **try/catch +
  `data.code` / `data.path`**, never a bare `toThrow(Class)` (mechanically gated).
- **`check:test-pyramid` gates** on `underAssertedUnit`, `gwtTitle`, `aaaBody`, `sutNaming`,
  `sutBindsResult`, `bareClassToThrow`, `emptyAaaSection` (`test-pyramid-budgets.json` →
  `gating`). `integrationProof` and `overMockedIntegration` are **report-only** — but the house
  convention still holds: a new integration file carries a `@proves` header and no `vi.*`.
- **`reports/api.json` is a PREPUSH gate, not a validate gate.** `check:doc-typedoc` is
  `git diff --exit-code -- reports/api.json`, `docs:json` is
  `typedoc --json reports/api.json --disableSources …` with inputs `src/**/*.ts`, `typedoc.json`,
  `tsconfig.build.json`, `README.md`. Changing a doc comment on a published symbol makes it
  stale. **Parts 2, 3, 4: run `npm run docs:json` and commit `reports/api.json`.**
- **`check:duplicates` is `jscpd src/`** — it never scans `test/`, and its floor is
  `minLines: 5` / `minTokens: 50`, so a pair of three-line predicates is safe.
  `check:dead-code` is `knip`; `check:architecture` is `depcruise` with `no-circular`.
- **No provenance refs in code or tests** — no `§`, `Phase`, `ADR-`, `R14`, `W9`, `N11b`
  markers in any `src/` or `test/` file, and none in a commit message. Those tokens live in
  this plan and in `docs/` only. Comments explain *why*, in their own words.
- **No suppression directives.** No `@ts-ignore`, `v8 ignore`, `biome-ignore`,
  `stryker-disable`. A `// Stryker disable next-line <Mutator>: equivalent — <proof>` comment is
  the one sanctioned form, only for a **proven** equivalent re-proved against *this* code.
  **This plan adds none.** Any survivor on a new guard is a real survivor and gets a kill test.
- **`command grep`, never bare `grep`** — bare grep is hook-rewritten to a proxy that truncates
  at ~200 results with no warning.
- **`tsconfig.json` sets `noUnusedLocals` and `noUnusedParameters`.** Deleting a test-side
  override means deleting the `const original…` binding it captured, or `tsc` goes red.
- **A "pre-existing" claim is verified against `main`**, never against an earlier commit on this
  branch.

---

## Decision candidates

Every design-level choice is pre-decided by ADRs 810–819; the design's own candidate section
raises none. These three are **plan-mechanics** choices this plan had to make. Each carries a
recommendation; the recommendation is what the parts below implement.

| # | Choice | Options | Recommendation |
|---|---|---|---|
| **PC-1** | Where the port JSDoc rewrite and its `reports/api.json` regeneration land | (1) each guard part edits the JSDoc for the surface it changes and regenerates `api.json` — three regenerations, three small comment-only diffs, each commit self-consistent; (2) one combined port-JSDoc edit in Part 4 — one regeneration, but Parts 2 and 3 ship a guard whose port contract still says the opposite; (3) a sixth docs-only part after Part 4 — one regeneration, one extra agent lifecycle for a comment edit | **(1)**. A comment-only typedoc diff is small (no id renumbering), and an atomic commit that changes behaviour without changing the contract that describes it is exactly the shape that let this bug exist |
| **PC-2** | Where the posix-only node pin sits in the sequence | (1) **first** — a §1d/§1e disagreement surfaces before three parts encode a wrong code, and it carries the dictionary word the later parts need; (2) last — `validate` is clean before a suite `validate` never runs is added; (3) split by surface, write rows into Part 3 and rename rows into Part 4 | **(1)**. Option 3 is rejected outright: it is one file, one `@proves` header, one shared temp-root fixture |
| **PC-3** | `writeStream` over a directory drains its async source **before** the `write` guard refuses; node refuses before draining | (1) leave it — the guard lives only in `write`, exactly as the design's §1d note prescribes ("a single guard at the top of `write` covers all four"); (2) add the same guard at the top of `writeStream` before the drain loop, matching node's ordering; (3) leave the behaviour and pin the divergence with a memory unit row so it cannot move silently | **(1)**. No requirement asserts drain ordering, no production caller passes a side-effecting generator, and (2) duplicates a guard the design deliberately placed once. Recorded here so a reviewer does not read the omission as an oversight |

---

## Part 1 — Pin the node adapter's write and rename refusal codes in a posix-only suite

### Context

**This part changes no production code.** It characterises the **unchanged** node adapter so the
three memory guards that follow have a verified oracle, and so the two `data.path` anchoring
oddities this design deliberately does not fix cannot move silently. `src/adapters/node/**` is
**out of scope** — if a row disagrees, escalate, never "fix" the adapter.

**Files.**

| Action | Path | What |
|---|---|---|
| create | `test/integration/posix-only/node-fs-write-rename-refusals.test.ts` | the whole part |
| edit | `cspell.json` | **one line**, inserted between `"effectful"` (`:287`) and `"EISDIR"` (`:288`) |

**Why this file lives where it does.** `vitest.config.ts:41–52` — the `integration` project
**explicitly excludes** `test/integration/posix-only/**`; `:54–60` defines a separate
`posix-integration` project including exactly that directory. So neither `npm run validate` nor
`npm run test:integration` runs this file: **it must be run explicitly**. Its CI home is the
`posix-integration` job. The naming convention in that directory is `node-fs-<subject>.test.ts`
(`node-fs-locked-directory`, `node-fs-mode-bits`, `node-fs-real-symlinks`).

**File header — copy this grammar from `node-fs-mode-bits.test.ts:1–14`:** a block comment saying
*why the case is platform-bound*, then a `@proves` block:

```
 * @proves
 *   surface: nodeFs.writeRenameRefusals
 *   bucket:  platform-only
 *   unique:  <one sentence, 12–200 chars, e.g. POSIX errno mapping for directory- and symlink-occupant write and rename refusals through NodeFileSystem>
```

`surface` must match `^[a-z][a-zA-Z0-9.-]{1,40}$`; `bucket: platform-only` is one of the seven
allowed buckets and its `directoryRules` allow `posix-only/`. The heuristic is **report-only**
(`test-pyramid-budgets.json` → `gating.integrationProof: false`) — write it correctly anyway.

**Fixture shape — copy `node-fs-real-symlinks.test.ts:22–46` exactly:**

```ts
const makeFs = async (): Promise<{ fs: NodeFileSystem; rootDir: string; cleanup: () => Promise<void> }> => {
  const tempRoot = await fsPromises.mkdtemp(nodePath.join(os.tmpdir(), 'tsgit-<slug>-'));
  const rootDir = await fsPromises.realpath(tempRoot);   // macOS os.tmpdir() is a symlink — the realpath is load-bearing
  const fs = new NodeFileSystem(rootDir);
  return { fs, rootDir, cleanup: async () => fsPromises.rm(rootDir, { recursive: true, force: true }) };
};
```

with `beforeEach` / `afterEach` around it. Bind `const sut = env.fs;` inside each `it` — that is
the shape `node-fs-mode-bits.test.ts:28` uses and `sutBindsResult` already passes on it.
**No `vi.mock` / `vi.fn` / `vi.spyOn` / `vi.stubGlobal` / `vi.stubEnv` anywhere in the file.**
Plant occupants with raw `node:fs/promises` (`mkdir`, `writeFile`, `symlink`) — that is how the
neighbour file does it and it keeps the adapter as the only thing under test.

**Imports the file needs:** `node:fs/promises` as `fsPromises`, `node:os`, `node:path` as
`nodePath`, `{ afterEach, beforeEach, describe, expect, it }` from `vitest`,
`{ NodeFileSystem }` from `../../../src/adapters/node/node-file-system.js`, `{ TsgitError }`
from `../../../src/domain/index.js`.

**The rows. Copy these expected codes — do not re-derive them.** Every refusal asserts
`caught instanceof TsgitError` **and** `data.code` **and** `data.path` where the variant carries
one. `UNSUPPORTED_OPERATION` carries `operation` and `reason` and **no `path`**.

*Write surface (`data.path` = the requested path on every row):*

| Arrangement | Code |
|---|---|
| `write` over an **empty directory** at the leaf | `PERMISSION_DENIED` |
| `write` over a **directory with children** | `PERMISSION_DENIED` |
| `write` where the leaf **is** `rootDir` | `PERMISSION_DENIED` |
| `writeUtf8` over a directory | `PERMISSION_DENIED` |
| `writeStream` over a directory | `PERMISSION_DENIED` |
| `appendUtf8` over a directory | `PERMISSION_DENIED` |
| `write` over a **live symlink** leaf | `PERMISSION_DENIED` |
| `write` over a **dangling symlink** leaf | `PERMISSION_DENIED` |
| `write` with a regular file at the **immediate parent** | `FILE_EXISTS` |
| `write` with a regular file at the **grandparent** | `NOT_A_DIRECTORY` |

The last two are the depth split the design keeps rather than fixes: the adapter's own
`mkdir -p` yields `EEXIST` at depth 1 and `ENOTDIR` deeper. Pin both so a future refactor cannot
move them silently.

`writeStream` needs an async source; the one-shot idiom is
`(async function* () { yield new Uint8Array([1]); })()` — the same shape
`test/unit/ports/file-system.contract.ts:41–49` uses. Plant a **dangling** symlink with
`fsPromises.symlink(nodePath.join(rootDir, 'missing-target'), link)`, exactly as
`node-fs-real-symlinks.test.ts:54` does.

*Rename surface (`data.path` = **`src`** on every refusal unless the row says otherwise):*

| `src` | `dst` | Code |
|---|---|---|
| file | empty directory | `PERMISSION_DENIED` |
| file | directory with children | `PERMISSION_DENIED` |
| symlink | empty directory | `PERMISSION_DENIED` |
| file | the containment **root** | `PERMISSION_DENIED` |
| empty directory | regular file | `NOT_A_DIRECTORY` |
| directory with children | regular file | `NOT_A_DIRECTORY` |
| directory | **symlink** | `NOT_A_DIRECTORY` |
| empty directory | directory with children | `DIRECTORY_NOT_EMPTY` |
| directory with children | directory with children | `DIRECTORY_NOT_EMPTY` |
| directory | its own **parent** | `DIRECTORY_NOT_EMPTY` |
| directory with children | the containment **root** | `DIRECTORY_NOT_EMPTY` |
| absent | anything | `FILE_NOT_FOUND` |
| directory | a path **inside itself** that is **absent** | `UNSUPPORTED_OPERATION`, `operation: 'filesystem'`, `reason` = `INVALID-ARGUMENT`, **no `path`** |
| directory | a path **inside itself** that is an **existing directory** | same |
| the containment **root** | a fresh name inside it | same |
| file | dst whose **immediate parent** is a regular file | `FILE_EXISTS`, `data.path` = **`src`** — the anchoring oddity, pinned deliberately |
| file | dst whose **grandparent** is a regular file | `NOT_A_DIRECTORY`, `data.path` = **`dst`** — the second anchoring oddity |
| src whose **immediate parent** is a regular file | fresh name | `NOT_A_DIRECTORY`, `data.path` = `src` |

*Positive rename rows (assert the outcome, no code):*

| `src` | `dst` | Outcome |
|---|---|---|
| directory with children | **empty** directory | succeeds, replacing — every child lands under `dst`, none remains under `src` |
| regular file | **itself** (`src === dst`) | succeeds, no-op — bytes unchanged |
| directory with children | **itself** | succeeds, no-op — every child still reachable |
| directory with children incl. a nested subtree | fresh name | succeeds — whole subtree moves |
| empty directory | fresh name | succeeds |

**One row is deliberately excluded, and must NOT be added: `dst` inside `src` where `dst`
already exists as a regular file or a symlink.** darwin reports `ENOTDIR` there and linux reports
`INVALID-ARGUMENT`; this job runs on **both** ubuntu and macos. It is pinned memory-side only, in
Part 4.

**The dictionary word.** The `INVALID-ARGUMENT` rows put the errno string literal into a
`test/**/*.ts` file, and `check:spelling` is
`cspell "src/**/*.ts" "test/**/*.ts" "docs/**/*.md" "*.md"`. So `cspell.json` gains that one word
**in this commit** — inserted between `"effectful"` and `"EISDIR"`, file not re-sorted.

**If a row disagrees with the table above**, that is a matrix disagreement, not a test bug.
Escalate `{ part, reason, ≤3 options }`. Do **not** weaken the assertion, do **not** touch
`src/adapters/node/**`, do **not** delete the row.

### TDD steps

This part pins **pre-existing** behaviour, so a case that goes green on its first run is the
signal working, not a skipped RED. Two genuine reds exist and both must be observed.

- **RED (genuine) — spelling.** Write the two `INVALID-ARGUMENT` rename cases with the real errno
  literal first. Run `npx cspell --no-progress test/integration/posix-only/node-fs-write-rename-refusals.test.ts`.
  It fails on the unknown word. **GREEN:** insert the single line into `cspell.json` between
  `"effectful"` and `"EISDIR"`; re-run; clean. Never re-sort, never a disable comment.
- **RED (genuine) — the proof header.** Run `node --experimental-strip-types tooling/audit-test-pyramid.ts`
  before adding the `@proves` block and read the `integrationProof` line in its report (it is
  report-only, so it will not fail the run — read the report, do not rely on the exit code).
  **GREEN:** add the header in `node-fs-mode-bits.test.ts:10–14`'s grammar; the line clears.
- **Characterisation, one block at a time.** Add the write-surface rows first, run them, then the
  rename refusal rows, then the rename positive rows. Run after each block — never write all
  forty and run once, or a disagreement is buried under a pile of green.
- **REFACTOR.** Collapse nothing that changes an oracle shape. The `PERMISSION_DENIED` write rows
  differ only in the occupant, so a `describe('Given …')` per occupant with a shared
  `beforeEach`-built root is the right structure; the `UNSUPPORTED_OPERATION` rows assert
  different fields and stay separate. Keep AAA section comments in every `it`.

### Gate

```
npx vitest run --project posix-integration test/integration/posix-only/node-fs-write-rename-refusals.test.ts
npm run test:posix-integration
npm run check:types
npx tsc --noEmit -p tsconfig.json
./node_modules/.bin/biome check test/integration/posix-only/node-fs-write-rename-refusals.test.ts cspell.json
npm run check:spelling
npx cspell --no-progress test/integration/posix-only/node-fs-write-rename-refusals.test.ts cspell.json
node --experimental-strip-types tooling/audit-test-pyramid.ts
```

`npm run test:posix-integration` is `vitest run --project posix-integration` (wireit, depends on
`check:types`) — the whole-project run is the one that matters, the single-file form is the fast
loop. Run every command bare, never through a pipe, and read `echo $?`.

### Commit

```
test(node-fs): pin write and rename refusal codes in a posix-only suite
```

---

## Part 2 — The memory adapter's exclusive create refuses any occupant

### Context

**The bug.** `MemoryFileSystem.writeExclusive` (`src/adapters/memory/memory-file-system.ts:106–114`)
tests only two of its three namespaces:

```ts
writeExclusive = async (path: string, data: Uint8Array): Promise<void> => {
  const normalized = this.resolve(path);
  if (this.files.has(normalized) || this.symlinks.has(normalized)) {
    throw fileExists(path);
  }
  this.ensureParentDirs(normalized);
  this.files.set(normalized, data.slice());
  this.touch(normalized);
};
```

A **directory** at `path` is overwritten with a file entry and the call returns success. The node
adapter throws `FILE_EXISTS` there, and so does canonical git (`Unable to create '…': File exists`,
byte-identical for a file occupant and a directory occupant alike).

**Files.**

| Action | Path | What |
|---|---|---|
| edit | `src/adapters/memory/memory-file-system.ts` | extract `private occupied()`; use it in `writeExclusive` (`:106`) and `symlink` (`:321–333`) |
| edit | `src/ports/file-system.ts` | the `writeExclusive` JSDoc, `:66–80` |
| edit | `reports/api.json` | regenerated — `npm run docs:json` |
| edit | `test/unit/adapters/memory/memory-file-system.test.ts` | 5 rows into `describe('writeExclusive contract')` (`:795`); retitle the false describe at `:811` |
| edit | `test/unit/ports/file-system.contract.ts` | 2 strict rows beside `:389` / `:403` |
| edit | `test/unit/application/primitives/internal/write-pack-artifacts.test.ts` | drop one override at `:909–916`, rewrite the comment at `:892–899` |

**The fix (verbatim from the design).** `symlink` (`:321–333`) is the in-house precedent — it
already tests all three namespaces. Extract the shared predicate as a `private` method and have
both call sites `throw fileExists(path)` on it:

```ts
private occupied(normalized: string): boolean {
  return (
    this.files.has(normalized) ||
    this.symlinks.has(normalized) ||
    this.directories.has(normalized)
  );
}
```

**`exists` (`:132–139`) is NOT folded in**, even though it computes a textually identical
disjunction. It answers a different question and the two answers already come apart on the node
adapter: node's `exists` follows symlinks and returns `false` for a **dangling** symlink, while
`writeExclusive` refuses one with `FILE_EXISTS`. Sharing a helper would cement a coincidence as
intent. **Leave `exists` exactly as it is.**

**Memory unit rows** — `test/unit/adapters/memory/memory-file-system.test.ts`, into the existing
`describe('writeExclusive contract')` at `:795` (a direct child of `describe('MemoryFileSystem')`),
house 3-level GWT split, `sut` = the adapter instance, try/catch + `data.code` **and** `data.path`:

| Given | When | Then |
|---|---|---|
| an **empty directory** occupies the target path | `writeExclusive` | throws `FILE_EXISTS` carrying the requested path |
| a **directory holding a child file** occupies the target path | `writeExclusive` | throws `FILE_EXISTS`; the child still reads back byte-for-byte and `lstat` still reports a directory |
| the target path **is the adapter's root** (`/repo`) | `writeExclusive` | throws `FILE_EXISTS`, and a later write elsewhere in the tree still succeeds |
| a **regular file** occupies the target path | `writeExclusive` | throws `FILE_EXISTS` |
| a **symlink** occupies the target path | `writeExclusive` | throws `FILE_EXISTS` |

The last two **pass today** — they are the isolated single-occupant cases for the `files` and
`symlinks` terms of `occupied()`, without which those terms can be mutated to `false` undetected.
The first three are the new red. The existing `Given a path whose parent directory does not
exist` case at `:796` is the negative (all three terms false) — keep it.

**The root case matters most.** `rootDir` is seeded into `directories` at construction
(`:46`), so today `writeExclusive('/repo', …)` succeeds, `files.has('/repo')` becomes true, and
`addDirectoryRecursive` (`:421–435`) then throws `NOT_A_DIRECTORY` on its first iteration for
**every subsequent write anywhere in the repository** — one call bricks the instance. The
"a later write elsewhere still succeeds" assertion is what proves the brick is gone.

**Retitle, do not rewrite.** `describe('Given the memory fs has no real symlinks')` (`:811–824`)
is false — the memory adapter has had symlinks since before this change. Its body proves **parent
auto-creation** (`writeExclusive('/repo/a/b/c.bin')` then `exists` is `true`). Retitle the
describe and the `it` to say that. Do not change the body.

**Shared contract rows** — `test/unit/ports/file-system.contract.ts`, **1-level**
`it('Given …, When …, Then …')` style, run by **both** drivers (memory: `rootDir: '/repo'`;
node: a real `mkdtemp` root). Place them beside
`Given existing file, When writeExclusive, Then throws FILE_EXISTS` (`:389`) and
`Given non-existent path, When writeExclusive, Then creates file` (`:403`):

| Row | Strictness |
|---|---|
| `Given an existing directory, When writeExclusive, Then throws FILE_EXISTS` | **strict** — reuse `assertFileExists` (`:88`) |
| `Given a file at a grandparent path segment, When writeExclusive, Then throws NOT_A_DIRECTORY` | **strict on the code** — reuse `assertNotADirectory` (`:93`), which asserts no `data.path` |

Both are Windows-safe: `EEXIST` from `O_EXCL` is universal (the existing strict
`writeExclusive`-over-a-file row already passes the `windows-latest` unit cell), and the
grandparent row is `mkdir -p`'s `ENOTDIR`. **Depth ≥ 2 only** — put an in-file comment saying the
**depth-1** case is adapter-dependent (node reports `FILE_EXISTS`, memory reports
`NOT_A_DIRECTORY` carrying the ancestor) and is deliberately not a row. The grandparent row passes
on **both** drivers today; it is a characterisation row that must not regress.

No addition to the `pathCalls` security table (`:34–76`) — `writeExclusive` is already row `:39`.

**The tolerant `mkdir` row at `:567` stays tolerant — do not "tighten" it to match the new strict
rows.** It asserts `mkdir` over a *regular file*, where node gives `FILE_EXISTS` (its `mkdir -p`
sees `EEXIST`) and memory gives `NOT_A_DIRECTORY` from `addDirectoryRecursive`. The two adapters
genuinely disagree there; the enumerated-pair tolerance is load-bearing, and it is a different
method and a different occupant shape from every row above.

**The retired test-side patch.** `test/unit/application/primitives/internal/write-pack-artifacts.test.ts`,
`describe('Given a directory occupying the .idx sibling name')` at `:889–937`:

- **Delete** the `writeExclusive` override at `:913–916` **and** the
  `const originalWriteExclusive = ctx.fs.writeExclusive.bind(ctx.fs);` binding at `:909` — with
  `noUnusedLocals` on, leaving the binding is a `tsc` error.
- **Keep** the `stat` size fake at `:917–920` and its `originalStat` binding at `:910`. Forcing the
  directory's reported size to equal the index's length is what makes `isFile` the *sole*
  discriminator, and that is the point of the case.
- **Rewrite** the Arrange comment at `:892–899`. It currently ends *"…the memory adapter only
  checks files/symlinks — so `writeExclusive` is patched here to reject the same way a correct
  adapter (or a real one) would"* — the exact sentence this change retires. The new comment says
  *why* the stat fake is still there (size coincidence, `isFile` as the only discriminator), in
  the implementer's own words, with **no** provenance ref.
- **Change nothing else in that file.** Every other `writeExclusive` override or spy stays:
  `:343–348` and `:981–986` inject **non-`FILE_EXISTS`** failures pinning the rethrow branch;
  `:479–485`, `:523–529`, `:602–608` are `vi.spyOn` call-order and argument pins. `TsgitError` is
  still imported and used at 14 other sites — do not touch the import.

**Port JSDoc (`src/ports/file-system.ts:66–80`).** Rewrite the summary so occupancy reads as
*anything at `path`* — a regular file, a directory (empty or not), or a symbolic link including a
dangling one — not *"the file already exists"*. Keep the two existing contract-obligation bullets
(parent-directory creation with the retry-once clause; the symlink-safe ancestor check) verbatim,
and add **one** ancestor-obligation line: a non-directory at an ancestor segment refuses, and the
**depth-1** code is adapter-dependent (node `FILE_EXISTS`, memory `NOT_A_DIRECTORY` carrying the
ancestor) while depth ≥ 2 is `NOT_A_DIRECTORY` on both. No provenance refs.

⚠️ **This JSDoc is embedded in `reports/api.json` five times.** Run `npm run docs:json` and commit
`reports/api.json` **in this commit**.

### TDD steps

- **RED 1** — memory row: an **empty directory** occupies the target path → expect `FILE_EXISTS`.
  Fails today because `writeExclusive` returns normally, so `caught` stays `undefined` and
  `expect(caught).toBeInstanceOf(TsgitError)` reports *received undefined*.
- **RED 2** — memory row: a **directory holding a child file** occupies the path. Same failure,
  plus the child's bytes and the `lstat` kind assertions.
- **RED 3** — memory row: the path **is `/repo`**. Same failure; the "a later write elsewhere still
  succeeds" assertion additionally fails *after* the guard lands if the guard is placed after
  `ensureParentDirs` — it must be the first thing after `resolve`.
- **RED 4 / 5** — memory rows: a **regular file**, then a **symlink**, occupies the path. These
  **pass on the first run**; they are the isolated single-occupant proofs for the two pre-existing
  terms of `occupied()`. Write them anyway and confirm they are green.
- **RED 6** — contract row `Given an existing directory, When writeExclusive, Then throws
  FILE_EXISTS`. Red on the `MemoryFileSystem` driver, green on the `NodeFileSystem` driver — run
  `npx vitest run test/unit/adapters/memory/memory-file-system.test.ts test/unit/adapters/node/node-file-system.test.ts`
  and confirm exactly that split.
- **RED 7** — contract row `Given a file at a grandparent path segment, When writeExclusive, Then
  throws NOT_A_DIRECTORY`. Green on both drivers immediately — characterisation.
- **RED 8** — `write-pack-artifacts.test.ts`: delete the `writeExclusive` override and its
  binding. `Given a directory occupying the .idx sibling name` now goes red: without the guard the
  real adapter writes the index over the directory and no mismatch is raised.
- **GREEN** — add `private occupied(normalized: string): boolean` to `MemoryFileSystem`; replace
  `writeExclusive`'s two-term condition and `symlink`'s three-term condition with
  `if (this.occupied(normalized)) throw fileExists(path);`. Nothing else in either method moves —
  the guard stays **before** `ensureParentDirs`. Re-run: RED 1, 2, 3, 6 and 8 turn green; every
  existing `symlink` test (`:162` `Given symlink over existing file` and the readdir/rm/openWithNoFollow
  symlink cases) stays green.
- **REFACTOR** — retitle `:811`'s describe and `it`; rewrite the `write-pack-artifacts.test.ts`
  Arrange comment; rewrite the port `writeExclusive` JSDoc; `npm run docs:json`; stage
  `reports/api.json`.
- **Coverage check before committing.** `occupied()`'s three-term disjunction needs all four
  short-circuit paths exercised — file / symlink / directory / none. RED 1, 4, 5 and the existing
  `:796` case give exactly that. Run
  `npx vitest run --coverage.enabled --coverage.include='src/adapters/memory/**' test/unit/adapters/memory/memory-file-system.test.ts`
  if in doubt.

### Gate

```
npx vitest run test/unit/adapters/memory/memory-file-system.test.ts test/unit/adapters/node/node-file-system.test.ts test/unit/application/primitives/internal/write-pack-artifacts.test.ts
npm run check:types
npx tsc --noEmit -p tsconfig.json
./node_modules/.bin/biome check src/adapters/memory/memory-file-system.ts src/ports/file-system.ts test/unit/adapters/memory/memory-file-system.test.ts test/unit/ports/file-system.contract.ts test/unit/application/primitives/internal/write-pack-artifacts.test.ts
npm run check:spelling
npx cspell --no-progress src/adapters/memory/memory-file-system.ts src/ports/file-system.ts test/unit/adapters/memory/memory-file-system.test.ts test/unit/ports/file-system.contract.ts test/unit/application/primitives/internal/write-pack-artifacts.test.ts
npm run docs:json && git diff --stat -- reports/api.json
```

`test/unit/ports/file-system.contract.ts` has no `.test.ts` suffix — it is driven by the two
adapter suites, so run **both** of them; running only the memory suite hides a node-side red.
`reports/api.json` **must** show a diff after `docs:json` here (the JSDoc changed) — stage it.

### Commit

```
fix(memory-fs): refuse an exclusive create over any occupant
```

---

## Part 3 — The memory adapter's non-exclusive write refuses a directory or a symlink leaf

### Context

**The bug.** `MemoryFileSystem.write` (`src/adapters/memory/memory-file-system.ts:86–91`) has no
leaf guard at all:

```ts
write = async (path: string, data: Uint8Array): Promise<void> => {
  const normalized = this.resolve(path);
  this.ensureParentDirs(normalized);
  this.files.set(normalized, data.slice());
  this.touch(normalized);
};
```

Over a **directory** the key lands in `files` *and* `directories`; over a **symlink** it lands in
`files` *and* `symlinks` — `lstat` still says symlink, `read` returns the new bytes, `readlink`
returns the old target. Node refuses both: `EISDIR` from `open` on a directory and `ELOOP` from
`O_NOFOLLOW` on a symlink, and `mapErrno` (`node-file-system.ts:234–243`) sends **both** to
`permissionDenied` through two adjacent arms.

**Four surfaces, one guard.** `writeStream` (`:93–104`) and `writeUtf8` (`:116–118`) both end in
`await this.write(...)`; `appendUtf8` (`:120–123`) calls `readExistingUtf8` (`:125–130`) — a pure
`files.get` + `TextDecoder` that mutates nothing and decodes `undefined` to `''` — then
`writeUtf8`. So one guard at the top of `write` covers all four, and `appendUtf8`'s observable is
a clean refusal with no partial read and no partial write.

**Files.**

| Action | Path | What |
|---|---|---|
| edit | `src/adapters/memory/memory-file-system.ts` | one guard at the top of `write` (`:86`) |
| edit | `src/ports/file-system.ts` | `write` (`:60`), `writeStream` (`:63`), `writeUtf8` (`:82`), `appendUtf8` (`:85–89`) JSDoc |
| edit | `reports/api.json` | regenerated |
| edit | `test/unit/adapters/memory/memory-file-system.test.ts` | a new `describe` block, sibling of `writeExclusive contract` (`:795`) |
| edit | `test/unit/ports/file-system.contract.ts` | 1 tolerant row + 1 new local helper |

**The fix (verbatim from the design).**

```ts
write = async (path: string, data: Uint8Array): Promise<void> => {
  const normalized = this.resolve(path);
  // node: EISDIR for a directory leaf, ELOOP for a symlink leaf under O_NOFOLLOW —
  // mapErrno sends both to PERMISSION_DENIED.
  if (this.directories.has(normalized) || this.symlinks.has(normalized)) {
    throw permissionDenied(path);
  }
  this.ensureParentDirs(normalized);
  this.files.set(normalized, data.slice());
  this.touch(normalized);
};
```

`permissionDenied` is already imported (`:6`). `rootDir` is in `directories` from construction, so
the root case needs **no third clause**.

**The guard sits before `ensureParentDirs` — that ordering is load-bearing.** When a regular file
blocks an *ancestor* segment, the leaf itself is in no namespace, the guard falls through, and
`addDirectoryRecursive` throws `NOT_A_DIRECTORY` carrying the **ancestor** — unchanged, and the
existing case at `test/unit/adapters/memory/memory-file-system.test.ts:452–472`
(`Given write path whose parent segment is an existing file`) must stay green. **Do not** touch
that case; it is the proof the new leaf guard does not shadow the ancestor report.

**Both disjuncts produce the same code, and that is deliberate — do not "tidy" it into one term.**
The in-house precedent is one method away: `openWithNoFollow` (`:375–385`) refuses a symlink leaf
with exactly `permissionDenied`, citing `O_NOFOLLOW`.

**Three places that look like they need the same guard and do not — do not add one:**

- **`writeStream` (`:93–104`).** It drains its async source *before* delegating to `write`, so the
  refusal arrives after the generator has run, where node refuses before reading anything. That
  ordering difference is deliberate (PC-3 above): no requirement asserts drain ordering, no
  production caller passes a side-effecting generator, and a second copy of the guard is exactly
  the duplication the design placed it once to avoid. **Leave `writeStream` and `writeUtf8` as
  pure delegations.**
- **`appendUtf8` (`:120–123`).** `readExistingUtf8` (`:125–130`) is a pure `files.get` +
  `TextDecoder` that mutates nothing and decodes `undefined` to `''`, so the observable is a clean
  refusal with no partial read. **No pre-check needed.**
- **The `FileHandle` returned by `openWithNoFollow` (`:387–407`).** Its `write` callback does
  `files.set(normalized, …)` directly, bypassing this guard — and that is safe, not a hole:
  `openWithNoFollow` (`:375–385`) already refuses a symlink leaf and requires
  `files.has(normalized)` before handing the handle out, so the key it writes **already exists in
  `files`** and it creates none.

**Memory unit rows** — a new `describe` block, sibling of `describe('writeExclusive contract')`
(`:795`) inside `describe('MemoryFileSystem')`. Every row plants **one** occupant, never two, so
each disjunct is tripped alone:

| Given | When | Then |
|---|---|---|
| an **empty directory** occupies the target path | `write` | throws `PERMISSION_DENIED` carrying the requested path; `lstat` still reports a directory |
| a **directory holding a child file** occupies the target path | `write` | throws `PERMISSION_DENIED`; `readdir` still lists the child and the child reads back byte-identical |
| the target path **is the adapter's root** | `write` | throws `PERMISSION_DENIED`, and a later write elsewhere still succeeds |
| an empty directory occupies the target path | `writeUtf8` | throws `PERMISSION_DENIED` |
| an empty directory occupies the target path | `writeStream` | throws `PERMISSION_DENIED` |
| a directory holding a child occupies the target path | `appendUtf8` | throws `PERMISSION_DENIED`, and the child is unchanged — nothing was read or written first |
| a **regular file** occupies the target path | `write` | overwrites, and reads back the new bytes |
| a **symlink to an existing file** occupies the target path | `write` | throws `PERMISSION_DENIED` carrying the requested path; `readlink` still returns the original target and the target file's bytes are unchanged |
| a **dangling symlink** occupies the target path | `write` | throws `PERMISSION_DENIED`; `readlink` still returns the original target |
| a symlink occupies the target path | `writeUtf8` | throws `PERMISSION_DENIED` |
| a symlink occupies the target path | `writeStream` | throws `PERMISSION_DENIED` |
| a symlink occupies the target path | `appendUtf8` | throws `PERMISSION_DENIED`, and `readlink` is unchanged |

The `regular file → overwrites` row is the **negative** that kills the always-throw mutants; the
three delegating surfaces get **one directory case and one symlink case each**, because a single
test tripping both disjuncts proves neither.

Planting a dangling symlink: `await sut.symlink('/repo/missing-target', '/repo/link')` — the
memory adapter's `symlink` (`:321–333`) does not require the target to exist.

**Shared contract row** — `test/unit/ports/file-system.contract.ts`, 1-level style:

> `Given a directory at the target path, When write, Then it refuses and the directory is intact`

**Strictness: instance + non-destructiveness, no code.** The unit project runs on the
`windows-latest` matrix cell (`.github/workflows/ci.yml:257`) and libuv's directory-open mapping
there was **not** probed. The `:676` row (`Given non-empty directory, When rm, Then throws a
TsgitError`) is the precedent — instance only. Add a module-private helper beside the four
existing ones (`assertFileNotFound` `:78`, `assertPermissionDenied` `:83`, `assertFileExists`
`:88`, `assertNotADirectory` `:93`):

```ts
function assertRefusedWithoutCode(err: unknown): void {
  expect(err).toBeInstanceOf(TsgitError);
}
```

The non-destructiveness assertions go **inline in the row** (`readdir(dir)` still lists the child,
and the child reads back byte-identical), because what "intact" means differs per arrangement.
The exact `PERMISSION_DENIED` code is proven strictly on the **memory** side (memory has no
platform) and on the **node** side in Part 1's posix-only file. No code goes unasserted anywhere;
only *where* the node assertion lives moves.

**No contract row for the symlink-leaf write.** Symlink creation is itself gated on Windows, and
the contract file gates symlink behaviour per adapter through the `symlinkReadEscape` capability
hook — a row that happens to agree without such a declaration would over-constrain a future
adapter. Memory unit rows plus Part 1's posix-only rows are the whole proof.

**Port JSDoc (`src/ports/file-system.ts`).** `write`'s summary is *"Write bytes to file, creating
parent directories as needed. **Overwrites if exists.**"* — the same narrow reading, one method
over. Rewrite `write` (`:60`), `writeStream` (`:63`), `writeUtf8` (`:82`) and `appendUtf8`
(`:85–89`) so each says: overwrites a **regular file**; refuses a **directory or a symbolic link**
at the leaf with `PERMISSION_DENIED`. Keep `writeStream`'s "Writes bytes verbatim" and
`appendUtf8`'s `O_APPEND` atomicity note. No provenance refs.

⚠️ Run `npm run docs:json` and commit `reports/api.json`.

**Regression posture.** The design's empirical sweep instrumented `MemoryFileSystem` to *record,
not refuse* every call the new guards would newly reject, across 15 831 unit tests, 15 929
unit + parity tests and 2 369 parity + integration + posix-integration tests: **zero hits** for
both write-onto-directory and write-onto-symlink. If a pre-existing test goes red here, it is a
real defect that sweep did not reach — investigate it, do not weaken the guard.

### TDD steps

- **RED 1** — directory-only row: an empty directory occupies the path → `write` → expect
  `PERMISSION_DENIED`. Fails today: the write succeeds, `caught` is `undefined`.
- **RED 2** — symlink-only row: a symlink to an existing file occupies the path → `write` →
  expect `PERMISSION_DENIED`, `readlink` unchanged, the target's bytes unchanged. Fails today,
  and the `readlink`/target assertions document the corruption being closed.
  **RED 1 and RED 2 must be separate tests.** One fixture cannot hold both (the namespaces are
  disjoint), and one test planting only a directory leaves the `symlinks` term free to be mutated
  to `false` undetected.
- **RED 3** — the directory-with-children row, the root row, the dangling-symlink row.
- **RED 4** — the six delegating rows: `writeUtf8` / `writeStream` / `appendUtf8`, one directory
  case and one symlink case each. All six fail today.
- **RED 5** — the negative row: a regular file occupies the path → `write` overwrites and reads
  back the new bytes. **Passes on the first run** — it is the always-throw mutant killer.
- **RED 6** — contract row `Given a directory at the target path, When write, Then it refuses and
  the directory is intact`, using the new `assertRefusedWithoutCode` helper plus inline
  non-destructiveness assertions. Red on the memory driver, green on the node driver.
- **GREEN** — add the two-term guard at the top of `write`, **after** `resolve` and **before**
  `ensureParentDirs`. Re-run: every red turns green; `:452–472`
  (`Given write path whose parent segment is an existing file`) stays green.
- **REFACTOR** — rewrite the four port JSDoc entries; `npm run docs:json`; stage
  `reports/api.json`.
- **Before committing**, run the full memory + node adapter suites and the contract's two drivers
  together — the contract file has no `.test.ts` suffix and is only reachable through them.

### Gate

```
npx vitest run test/unit/adapters/memory/memory-file-system.test.ts test/unit/adapters/node/node-file-system.test.ts
npm run check:types
npx tsc --noEmit -p tsconfig.json
./node_modules/.bin/biome check src/adapters/memory/memory-file-system.ts src/ports/file-system.ts test/unit/adapters/memory/memory-file-system.test.ts test/unit/ports/file-system.contract.ts
npm run check:spelling
npx cspell --no-progress src/adapters/memory/memory-file-system.ts src/ports/file-system.ts test/unit/adapters/memory/memory-file-system.test.ts test/unit/ports/file-system.contract.ts
npm run docs:json && git diff --stat -- reports/api.json
```

### Commit

```
fix(memory-fs): refuse a non-exclusive write over a directory or symlink leaf
```

---

## Part 4 — The memory adapter's rename refuses what a POSIX rename refuses

### Context

**The bug.** `MemoryFileSystem.rename` (`src/adapters/memory/memory-file-system.ts:246–275`)
deletes `files[dst]`, `symlinks[dst]` and `times[dst]` **before** consulting anything about `dst`,
and never consults `directories[dst]` at all. `renameDirectory` (`:289–310`) re-keys the subtree
without consulting `dst` either. Today, on the memory adapter: a file renamed onto a directory
lands its key on the directory key; a directory renamed onto a file re-keys its children *under a
regular file*; two directories silently **merge**; and a directory renamed into **itself**
vanishes from `directories` while its children remain — `lstat(src)` throws `FILE_NOT_FOUND` yet
`readdir(src/inner)` still works. Renaming the **root** into itself silently re-keys the entire
repository one level deeper.

**Files.**

| Action | Path | What |
|---|---|---|
| edit | `src/adapters/memory/memory-file-system.ts` | `assertRenamable` + `renameLeaf` + the new `rename` body + one module-level `const` |
| edit | `src/ports/file-system.ts` | `rename` (`:109–114`) and `atomicRename` (`:116–125`) JSDoc |
| edit | `reports/api.json` | regenerated |
| edit | `test/unit/adapters/memory/memory-file-system.test.ts` | a new `describe` block, sibling of `writeExclusive contract` (`:795`) |
| edit | `test/unit/ports/file-system.contract.ts` | 3 tolerant refusal rows + 3 positive rows |

**The fix (verbatim from the design). The clause order is load-bearing — implement it exactly:**

```ts
private assertRenamable(src: string, dst: string, reported: string): void {
  const srcIsDirectory = this.directories.has(src);
  if (!srcIsDirectory && !this.files.has(src) && !this.symlinks.has(src)) {
    throw fileNotFound(reported);
  }
  if (src === dst) return;
  if (!srcIsDirectory) {
    if (this.directories.has(dst)) throw permissionDenied(reported);
    return;
  }
  if (dst.startsWith(`${src}/`)) {
    throw unsupportedOperation('filesystem', INVALID_ARGUMENT);
  }
  if (!this.directories.has(dst)) {
    if (this.files.has(dst) || this.symlinks.has(dst)) {
      throw notADirectory(reported);
    }
    return;
  }
  if (this.hasChildren(dst)) throw directoryNotEmpty(reported);
}
```

```ts
rename = async (src: string, dst: string): Promise<void> => {
  const normalizedSrc = this.resolve(src);
  const normalizedDst = this.resolve(dst);
  this.assertRenamable(normalizedSrc, normalizedDst, src);
  if (normalizedSrc === normalizedDst) return;
  if (this.directories.has(normalizedSrc)) {
    this.renameDirectory(normalizedSrc, normalizedDst);
    return;
  }
  this.renameLeaf(normalizedSrc, normalizedDst);
};
```

`renameLeaf` is today's leaf body (`:258–274`) **minus** the now-unreachable
`throw fileNotFound(src)` arm (`:256`) — dead code is a non-negotiable. The `as Timestamps` cast
at `:258–260` and its comment survive unchanged: a file or symlink at `src` still implies a
timestamp. **Keep all three destination deletes** (`files`, `symlinks`, `times`) inside
`renameLeaf`: renaming a file onto a **symlink** is allowed on node too — the link is replaced,
its target untouched — so those deletes are correct, not a gap. Dropping any of them to
"simplify" after the guard lands reopens exactly the collision the guard exists to prevent.

`INVALID_ARGUMENT` is a **module-level, non-exported** `const` in `memory-file-system.ts` holding
POSIX's invalid-argument errno name — the literal `mapErrno`'s `default` arm forwards. Naming it
once keeps the magic value out of the guard. The dictionary word was added in Part 1; **do not
add it again and do not re-sort `cspell.json`**.

Every factory the guard needs is already imported (`memory-file-system.ts:1–8`):
`directoryNotEmpty`, `fileExists`, `fileNotFound`, `notADirectory`, `permissionDenied`,
`unsupportedOperation`. `hasChildren` already exists as a private method (`:488–501`) and is
exactly the predicate node's `ENOTEMPTY` expresses.

**Why each ordering rule exists:**

1. **Source existence first.** `rename(absent, anything)` is `ENOENT` on POSIX regardless of `dst`.
2. **`src === dst` second.** Node succeeds on `rename(dir, dir)` even for a *non-empty* directory.
   Without this escape the non-empty clause below would newly refuse it — the sharpest regression
   this change can introduce.
3. **The inside-source clause above the destination-kind check.** Placed there it reproduces
   **linux**; placed below it reproduces **darwin**. linux is the CI platform that gates every
   merge. The cost, taken knowingly: this error variant carries **no `path`**.
4. **The whole guard before any mutation.** Non-destructiveness holds only because
   `assertRenamable` runs before the destination deletes.

`dst.startsWith(`${src}/`)` is **inside**, not **ancestor**: renaming a directory onto its own
**parent** is `DIRECTORY_NOT_EMPTY`, and it correctly falls through, because a parent is not
inside its child.

**`rm` (`:220–244`), `rmRecursive` (`:339–346`) and `mkdir` (`:211–218`) need nothing, and are
not touched.** `rm` already tests the three namespaces in order and already throws
`DIRECTORY_NOT_EMPTY` for a non-empty directory; it and `rmRecursive` only ever *remove* keys.
`mkdir` does create keys, but `addDirectoryRecursive` (`:421–435`) re-tests
`files.has(current) || symlinks.has(current)` at **every** segment and throws `NOT_A_DIRECTORY`
rather than adding a colliding directory key.

**`renameDirectory` needs no change, and must not get one.** After the guard it can only ever be
entered with `dst` absent or an **empty** directory. For the empty-destination replace, the `dst`
key is already in `directories`, the remap loop re-adds it (a `Set` no-op), and `moves(this.times)`
overwrites its timestamp — probed identical to node's result. **Do not add a
`directories.delete(dst)`.** Doing so would move the `Stryker disable next-line` directive at
`:291` off its expression, which anchors on the line that follows it.

**A leaf source with a destination inside it needs no clause.**
`rename('/repo/f.txt', '/repo/f.txt/x')` takes the `!srcIsDirectory` branch and returns, then
`renameLeaf`'s `ensureParentDirs` hits `addDirectoryRecursive('/repo/f.txt')`, which finds the key
in `files` and throws `NOT_A_DIRECTORY` carrying the ancestor. That is the ancestor family one
method over — already ratified, already out of scope.

**The root needs no clause either.** `rootDir` is seeded into `directories` at construction, so
`srcIsDirectory` is true; `resolve` (`:409–415`) refuses anything not equal to `rootDir` or under
`${rootDir}/`; `x === rootDir` is caught by the `src === dst` escape one line above; everything
else starts with `${rootDir}/` and trips the inside-source clause. This rests on the file's
existing assumption that `rootDir` is not `/`, already stated at `parentOf` (`:535–541`).

**Memory unit rows** — a new `describe` block, sibling of `writeExclusive contract` (`:795`),
one arrangement per case so each guard clause is tripped alone. `data.path` is the **raw `src`**
on every refusal except the `UNSUPPORTED_OPERATION` rows, which carry `operation` and `reason` and
**no `path`**:

| Given | When | Then |
|---|---|---|
| a file at src, an **empty directory** at dst | `rename` | `PERMISSION_DENIED` carrying **src**; both keep their kinds |
| a file at src, a **directory with children** at dst | `rename` | `PERMISSION_DENIED` carrying src; dst's child still reads back byte-identical |
| a **symlink** at src, a directory at dst | `rename` | `PERMISSION_DENIED` carrying src; `readlink(src)` unchanged |
| a file at src, dst = the adapter's **root** | `rename` | `PERMISSION_DENIED`, and a later write still succeeds |
| a **directory** at src, a **regular file** at dst | `rename` | `NOT_A_DIRECTORY` carrying src; src's children are still listed under src |
| a directory at src, a **symlink** at dst | `rename` | `NOT_A_DIRECTORY` carrying src; `readlink(dst)` unchanged |
| a directory at src, a **non-empty directory** at dst | `rename` | `DIRECTORY_NOT_EMPTY` carrying src; both trees intact, neither merged |
| an **empty** directory at src, a non-empty directory at dst | `rename` | `DIRECTORY_NOT_EMPTY` carrying src |
| a directory at src, dst = src's own **parent** | `rename` | `DIRECTORY_NOT_EMPTY` carrying src — **not** the inside-source code, because a parent is not inside its child |
| a directory with children at src, an **empty directory** at dst | `rename` | succeeds; every child reachable under dst, none under src |
| a **regular file**, src === dst | `rename` | resolves; the bytes are unchanged |
| a **non-empty directory**, src === dst | `rename` | resolves; every child still reachable |
| a directory at `/repo/a`, dst the **sibling** `/repo/ab` | `rename` | succeeds — the prefix-boundary pin: `/repo/ab` is not inside `/repo/a` |
| a file at src, a directory at dst | `atomicRename` | `PERMISSION_DENIED` carrying src — proves the delegation, not a second guard |
| absent src | `rename` | `FILE_NOT_FOUND` carrying src — **the existing case at `:431–450`, retained unchanged** |
| a directory at src, an **absent** dst inside src | `rename` | `UNSUPPORTED_OPERATION`, `operation === 'filesystem'`, `reason` = `INVALID-ARGUMENT`; src's subtree intact |
| a directory at src, an **existing non-empty directory** dst inside src | `rename` | same error; both levels intact — proves the clause wins over the non-empty check |
| a directory at src, an **existing regular file** dst inside src | `rename` | same error, and the file is unchanged — proves the clause sits **above** the kind check. **Memory-only**: darwin and linux disagree here, so it is never a contract row and is pinned nowhere on the node side |
| a directory at src, an **existing symlink** dst inside src | `rename` | same error; `readlink(dst)` unchanged |
| src = the adapter's **root**, dst inside it | `rename` | same error; `lstat(rootDir)` still reports a directory, and a later write anywhere still succeeds |
| a directory at src, dst a **deep** path inside src whose mid segment is absent | `rename` | same error — the clause is a prefix test, not a lookup |

**Mutation posture — the positive rows are as load-bearing as the refusals.** The template-literal
mutant Stryker emits for `` `${src}/` `` replaces it with the **empty string**, making
`dst.startsWith('')` always true; only a **positive directory rename** kills it (fresh name,
empty-destination replace, `src === dst`, the prefix-boundary sibling). `assertRenamable`'s early
returns are `BlockStatement` and `ConditionalExpression` targets in their own right, so every
"force the guard to always throw" mutant dies on those same rows. The existing directory-rename
cases at `:250–312` — including the two prefix-boundary siblings at `:274` and `:294` — all target
a **fresh** destination and must stay green; they are the happy paths the guard must not break.
Each `&&` term of the source-existence check needs its own single-false case: a directory source
(the positive rename rows), a file source (the refusal rows), a symlink source (the existing case
at `:232–249`), and all-three-false (the retained `:431` case).

**Shared contract rows** — `test/unit/ports/file-system.contract.ts`, 1-level style, beside the
two rename rows at `:357` / `:373`. Refusal rows use the `assertRefusedWithoutCode` helper Part 3
added; positive rows assert the outcome:

| Row | Strictness |
|---|---|
| `Given a directory at the destination, When rename, Then it refuses and neither side moves` | instance + `read(src)` unchanged, `readdir(dst)` unchanged |
| `Given a directory source and a file destination, When rename, Then it refuses and neither side moves` | instance + the destination file's bytes unchanged, the source's children still under the source |
| `Given a directory source and a non-empty directory destination, When rename, Then it refuses and neither tree merges` | instance + each tree still holds exactly its own child |
| `Given a directory source and an empty directory destination, When rename, Then the subtree lands at the destination` | **positive row, outcome asserted** |
| `Given src === dst for a file, When rename, Then it resolves and the entry is unchanged` | **positive row** |
| `Given src === dst for a non-empty directory, When rename, Then it resolves and every child is still reachable` | **positive row** |

⚠️ **Windows exposure — read this before "fixing" a red.** The unit project runs on
`windows-latest`, and `MoveFileEx`'s replace-existing flag is documented **not** to replace
directories. The two rows most likely to go red on that cell are the **empty-directory-destination
positive row** and the **`src === dst` non-empty-directory positive row**. They stay in the
contract suite anyway, because a positive row has **no tolerant form** — "it succeeds or it throws
something" asserts nothing. If either goes red on the Windows cell, that is a **recorded decision
to escalate**, not a licence to loosen a memory-side assertion or to delete the row.

The three refusal rows carry no code precisely because Windows was not probed; their exact codes
are proven strictly on the memory side here and on the node side in Part 1's posix-only file.
No addition to the `pathCalls` table (`:34–76`) — `rename-src` (`:58`) and `rename-dst` (`:65`)
are already rows.

**No contract row** for: the symlink-source / symlink-destination rename pairs (the file gates
symlink behaviour per adapter through a capability hook), or the inside-source family (its
`reason` is a node errno name and would over-constrain any adapter that has no errnos).

**Port JSDoc.** `rename` (`:109–114`) gains, in one sentence each: the kind matrix (a
non-directory source refuses a directory destination with `PERMISSION_DENIED`; a directory source
refuses a non-directory destination with `NOT_A_DIRECTORY` and a non-empty directory destination
with `DIRECTORY_NOT_EMPTY`; an empty directory destination is replaced; `src === dst` is a no-op),
the `data.path === src` anchoring rule on every refusal, and the destination-inside-source refusal
with its `UNSUPPORTED_OPERATION` shape and absent `path`. `atomicRename` (`:116–125`) keeps its
existing optionality paragraph and gains one line: it inherits every `rename` refusal by
delegation and stays atomic, because the guard is pure inspection with no `await`. No provenance
refs.

⚠️ Run `npm run docs:json` and commit `reports/api.json`.

**Stryker equivalence proofs — re-read, keep, do not edit.** All twelve directives in
`memory-file-system.ts` (`:186`, `:204`, `:213`, `:291`, `:343`, `:352`, `:359`, `:392`, `:497`,
`:515`, `:544`, `:553`) survive this change with their wording intact. The disjointness premises
at `:186`, `:352`, `:359` and `:515` become **unconditionally** true rather than
conditional-on-a-bug-not-being-hit — the sentences are about the disjointness, not about which
method enforces it, so they still match the code they annotate. Re-read each against the new code
and confirm; **add no new directive**. Any survivor on the new guard is a real survivor and gets a
kill test.

**Regression posture.** The design's empirical sweep recorded **zero** hits for rename-leaf-onto-
directory, rename-directory-onto-leaf, rename-directory-onto-non-empty-directory and
rename-destination-inside-source across the whole unit, parity, integration and posix-integration
corpus. The only production caller that could point `rename` at a directory is
`src/application/commands/internal/working-tree.ts:138`, and it cannot: `moveNode` recurses into a
directory and only ever calls `ctx.fs.rename` on a **leaf**.

### TDD steps

- **RED 1** — the four `PERMISSION_DENIED` rows (file→empty dir, file→dir-with-children,
  symlink→dir, file→root). All fail today: the rename **succeeds** and corrupts.
- **RED 2** — the three `NOT_A_DIRECTORY` rows (dir→file empty, dir→file with children,
  dir→symlink). All fail today.
- **RED 3** — the three `DIRECTORY_NOT_EMPTY` rows (dir→non-empty dir, empty dir→non-empty dir,
  dir→its own parent). All fail today — memory silently merges.
- **RED 4** — the six inside-source rows (absent dst, existing non-empty dir dst, existing file
  dst, existing symlink dst, root→inside, deep dst with an absent mid segment). All fail today.
  Assert `operation` and `reason`, and **do not** assert a `path` field — that variant has none.
- **RED 5** — the `atomicRename` delegation row. Fails today.
- **RED 6** — the positive rows: empty-destination replace, `src === dst` for a file, `src === dst`
  for a non-empty directory, the `/repo/a` → `/repo/ab` prefix-boundary sibling. **All four pass on
  the first run.** Write them anyway: they are the mutant killers for the guard's early returns
  and for the trailing slash, and the `src === dst` non-empty-directory row is the specific
  regression the guard could introduce.
- **RED 7** — the six contract rows. The three refusal rows are red on the memory driver and green
  on the node driver; the three positive rows are green on both.
- **GREEN** — add the module-level `const`, `private assertRenamable`, `private renameLeaf`, and
  rewrite `rename`'s body. Delete the now-unreachable `throw fileNotFound(src)`. Do **not** touch
  `renameDirectory`, `atomicRename`, `rm`, `rmRecursive` or `mkdir`. Re-run: every red turns green;
  the existing rename cases at `:232–249`, `:250–312` and `:431–450` stay green.
- **REFACTOR** — rewrite the `rename` / `atomicRename` port JSDoc; re-read the twelve Stryker
  directives against the new code and confirm each still matches its expression (none should need
  an edit); `npm run docs:json`; stage `reports/api.json`.
- **Before committing**, run the whole memory suite plus the node suite so both contract drivers
  execute, and confirm `git diff --stat` shows the `memory-file-system.ts` hunks you intended.

### Gate

```
npx vitest run test/unit/adapters/memory/memory-file-system.test.ts test/unit/adapters/node/node-file-system.test.ts
npm run check:types
npx tsc --noEmit -p tsconfig.json
./node_modules/.bin/biome check src/adapters/memory/memory-file-system.ts src/ports/file-system.ts test/unit/adapters/memory/memory-file-system.test.ts test/unit/ports/file-system.contract.ts
npm run check:spelling
npx cspell --no-progress src/adapters/memory/memory-file-system.ts src/ports/file-system.ts test/unit/adapters/memory/memory-file-system.test.ts test/unit/ports/file-system.contract.ts
npm run docs:json && git diff --stat -- reports/api.json
```

### Commit

```
fix(memory-fs): refuse a rename whose destination kind or containment forbids it
```

---

## Part 5 — The browser adapter maps a directory occupant to a refusal on all three write surfaces

### Context

**Two defects, one shared predicate.** `src/adapters/browser/browser-file-system.ts`:

1. `assertDoesNotExist` (`:273–286`) catches **every** non-`TsgitError` rejection and `return`s,
   reading a `TypeMismatchError` as *"absent, safe to create"*. Control then reaches
   `dir.getFileHandle(leaf, { create: true })` (`:64`), which rejects with `TypeMismatchError`
   again — and **that one escapes unmapped**. A caller sees a bare `DOMException`;
   `errorDataCode(err)` returns `undefined`, so `writeOrKeepArtifact` rethrows instead of raising
   its own refusal.
2. `resolveFileHandle` (`:226–237`) maps every non-`TsgitError` rejection to `fileNotFound(path)`.
   A directory at the leaf therefore surfaces as `FILE_NOT_FOUND` where node and the memory target
   say `PERMISSION_DENIED`. Nothing is written — `createWritable()` is never reached — and
   `rename` (`:153–162`) fails at its `write(dst, …)` step so `rm(src)` never runs. The browser
   adapter never corrupts; it reports the wrong code, in contract.

**The pinned OPFS rejections** (measured on chromium and firefox, 2026-09-05 — do not re-derive
from the spec):

| Call | Occupant | Rejection name |
|---|---|---|
| `getFileHandle(n, { create: true })` | **directory** | `TypeMismatchError` |
| `getFileHandle(n, { create: false })` | **directory** | `TypeMismatchError` |
| `getDirectoryHandle(n, { create: true/false })` | **regular file** | `TypeMismatchError` |
| `getFileHandle` / `getDirectoryHandle`, `create: false` | absent | `NotFoundError` |
| `removeEntry(n)` without `recursive` | **non-empty directory** | `InvalidModificationError` |

`err instanceof DOMException` and `err instanceof Error` were both `true` on both engines
(prototype chain `DOMException → Error`), and every refusal was **non-destructive**.

**Files.**

| Action | Path | What |
|---|---|---|
| edit | `src/adapters/browser/browser-file-system.ts` | 2 module-level predicates + `assertDoesNotExist` + one `catch` arm in `resolveFileHandle` |
| edit | `test/browser/opfs-roundtrip.spec.ts` | a second `test.describe` with 3 cases |

**The fix — module-level, beside the existing `isFileNotFound` (`:295–297`), not exported:**

```ts
function isTypeMismatch(err: unknown): boolean {
  return err instanceof Error && err.name === 'TypeMismatchError';
}

function isNotFoundRejection(err: unknown): boolean {
  return err instanceof Error && err.name === 'NotFoundError';
}
```

Shaped exactly like the node adapter's `isErrnoException` (`node-file-system.ts:140–142`) — the
house idiom for narrowing an `unknown` rejection with no cast and no `any`. Keying on `name`
rather than `instanceof DOMException` is deliberate: realm-independent, no DOM global needed at
runtime, and it cannot collide with a `TsgitError`, whose `name` is the literal `'TsgitError'`.

**(a) `assertDoesNotExist` (`:273–286`).** After: a `TypeMismatchError` becomes `fileExists(path)`;
a `NotFoundError` still `return`s (absent, proceed); **every other rejection propagates** instead
of being read as absence. The `err instanceof TsgitError` rethrow stays first.

One residual, stated so it is not mistaken for an oversight: an *unexpected* rejection — a
permission or quota failure — now leaves `writeExclusive` as a raw `DOMException`. That is the
right way round. The alternative is what the code does today: silently reading a permission
failure as *"absent, safe to create"* and then writing. Nothing is discarded, so it is not a
swallowed error.

**(b) `resolveFileHandle` (`:226–237`).** The `catch` gains **one** arm, gated on `create`:

```ts
try {
  return await dir.getFileHandle(leaf, { create });
} catch (err) {
  if (err instanceof TsgitError) throw err;
  // A directory at the leaf rejects with TypeMismatchError whether or not `create` is set.
  // Only the writing arm may report it as a refusal: stat/exists read FILE_NOT_FOUND here
  // as "not a file, try a directory handle" and fall back.
  if (create && isTypeMismatch(err)) throw permissionDenied(path);
  throw fileNotFound(path);
}
```

⚠️ **The `create` gate is not optional.** `getFileHandle` rejects with `TypeMismatchError` at
`create: false` too. `stat` (`:99–109`), `exists` (`:82–97`) and `chmod` (`:172–180`) all catch
exactly `FILE_NOT_FOUND` and fall back to `resolveDirHandle`; a helper-wide re-map would make all
three **rethrow** on every directory — a strictly worse bug than the one being fixed. Six of the
nine callers pass `create: false` (`read` `:22`, `readSlice` `:29`, `readUtf8` `:37`, `exists`
`:84`, `stat` `:101`, `chmod` `:175`); only `write` (`:43`), `writeStream` (`:50`) and
`appendUtf8` (`:75`) pass `true` — with `writeUtf8` (`:70`) and `rename` (`:160`) reaching it
through `write`.

**Ancestor faults keep their current mapping, structurally.** `walkToParent(segments, true)`
(`:255–271`) calls `getDirectoryHandle(segment, { create: true })`, which rejects with the **same**
`TypeMismatchError` when a regular file blocks an ancestor — but `walkToParent` has its **own**
`catch` converting it to `fileNotFound(segments.join('/'))`, and `resolveFileHandle` awaits
`walkToParent` **outside** its `try` block. The new arm therefore only ever sees rejections from
the single leaf `getFileHandle` call. **Do not move the `walkToParent` call inside the `try`** —
that would silently break it, which is why one Playwright step observes it.

**`permissionDenied`, `fileExists`, `fileNotFound` and `TsgitError` are all already imported**
(`:2–8`). `writeExclusive` (`:58–68`) does **not** use `resolveFileHandle` — it walks and probes by
hand, which is why (a) needs its own change.

**Out of scope, and stated so the asymmetry is not read as a half-applied fix.** `rename` with a
directory **source** still reports `FILE_NOT_FOUND` (it travels the untouched `create: false`
path), where node succeeds for a fresh destination. Making that correct means implementing
recursive copy-then-remove on OPFS — a capability change, not an error-mapping change, and the
current behaviour refuses rather than corrupts. Browser `rm` on a non-empty directory
(`InvalidModificationError` → `FILE_NOT_FOUND`) is the same class, a third method, also out of
scope.

**The Playwright cases** — `test/browser/opfs-roundtrip.spec.ts`, in a **second** `test.describe`
(the existing one is *OPFS round-trip*, a single init→add→commit→status case).

⚠️ **The new describe must repeat the webkit skip.** A `test.skip` on one describe does **not**
reach a sibling, and Playwright's headless WebKit does not expose
`navigator.storage.getDirectory`:

```ts
test.skip(({ browserName }) => browserName === 'webkit', 'OPFS not exposed in Playwright WebKit');
```

⚠️ **How the page gets a `BrowserFileSystem`, and the exact TypeScript hazard.** Inside
`page.evaluate`, bind the specifier to a `const` **first** — a literal specifier is resolved by
`tsc` and raises **TS2307 `Cannot find module '/dist/esm/adapters/browser/index.js'`** (measured
with this repo's compiler; the `const`-bound form is clean):

```ts
// Local typing aid for the surface these three cases drive — not a shared contract;
// the real class lives in src/. Declare it beside the spec's other page-boundary types.
interface OpfsFs {
  mkdir(path: string): Promise<void>;
  write(path: string, data: Uint8Array): Promise<void>;
  writeExclusive(path: string, data: Uint8Array): Promise<void>;
  read(path: string): Promise<Uint8Array>;
  readdir(path: string): Promise<ReadonlyArray<{ name: string }>>;
  rename(src: string, dst: string): Promise<void>;
  stat(path: string): Promise<{ isDirectory: boolean }>;
  exists(path: string): Promise<boolean>;
}

const MODULE_PATH = '/dist/esm/adapters/browser/index.js';
const mod = (await import(MODULE_PATH)) as {
  BrowserFileSystem: new (rootHandle: FileSystemDirectoryHandle) => OpfsFs;
};
const sut = new mod.BrowserFileSystem(await navigator.storage.getDirectory());
```

Note the constructor takes the **handle directly** (`browser-file-system.ts:19`), not a
`BrowserFileSystemOptions` object, despite that interface being exported. The module is already
served and in the page's module cache — `test/browser/index.html:12–16` imports from it — so
**no harness edit is needed**, and none may be made: all six specs in `test/browser/` load that
page.

**Plant occupants through the adapter's own `mkdir` / `write`**, not raw
`navigator.storage.getDirectory()` handles — that is what the contract suite does
(`file-system.contract.ts:676–680` plants with `env.fs.mkdir`) and `mkdir` is not the method under
test in any of the three cases. `resetOpfs` in the `readyPage` fixture (`test/browser/fixtures.ts:29–54`)
guarantees an empty root per test, so no cleanup is needed.

**Assertions cross the boundary as plain data.** `page.evaluate` returns structured-cloneable
values only — never a `TsgitError` instance, whose class identity and `data` field do not survive
serialisation. Pluck `{ code, path }` off `err.data` **inside** the page, return it alongside the
non-destructiveness observations, and assert on the Node side. Titles use the file's existing
1-level `Given …, When …, Then …` form; import `{ expect, test }` from `./fixtures.js` as the
existing describe does.

| # | Given → When → Then | Steps |
|---|---|---|
| 1 | `Given a directory occupying the target path, When writeExclusive, Then it throws FILE_EXISTS against real OPFS` | the code and the requested path; the directory and its child still there afterwards |
| 2 | `Given a directory occupying the target path, When write, Then it throws PERMISSION_DENIED against real OPFS` | (a) the code and the requested path; (b) non-destructiveness — `readdir` still lists the child and the child's bytes are unchanged; (c) **the mappings that must not move** — `stat(dir).isDirectory` is still `true` and `exists(dir)` is still `true`, and a `write` under a path whose ancestor segment is a regular file still reports `FILE_NOT_FOUND`, not `PERMISSION_DENIED` |
| 3 | `Given a file source and a directory destination, When rename, Then it throws PERMISSION_DENIED and the source survives` | the code and the requested path; `read(src)` returns the original bytes — `rm(src)` never ran; the destination directory's child is unchanged |

**Case 2 step (c) is where the fix's real risk lives**, and it is not redundant: the `create: false`
mapping is what `stat` and `exists` fall back through, and the existing round-trip case already
depends on it — `init` probes for `.git` through `exists`, which reaches
`resolveFileHandle(path, false)` on a directory on every run. Step (c) makes that dependency
explicit so a future reader cannot delete it. It is also the isolated proof of the `create` term
of the new `create && isTypeMismatch(err)` conjunction; case 2(a) proves the other term.

**This part is outside both automated safety nets.** `src/adapters/browser/**` is not in
`vitest.config.ts`'s `coverage.include` and is excluded from `stryker.config.mjs`'s `mutate`. The
three Playwright cases are the **only** proof, which is why each asserts a code **plus** a
non-destructiveness observation rather than the loose fact of throwing.

**The unit gate cannot see this change at all.** `npm run validate` does not run Playwright. The
part gate therefore carries a **full browser-tier smoke** (`npm run test:e2e`, whose wireit entry
depends on `build` **and** `build:parity`), not just the targeted spec: `test/browser/parity.spec.ts`
runs the whole scenario registry against real OPFS, and it is the only thing that can observe a
scenario whose success path travels the changed arm. No browser spec asserts an error code today
(`command grep -rn "FILE_NOT_FOUND\|PERMISSION_DENIED\|FILE_EXISTS" test/browser/` returns
nothing), so the exposure is behavioural, not assertional.

### TDD steps

- **BUILD FIRST.** `npm run build`. A bare `npx playwright test` bypasses wireit's build
  dependency and serves a **stale `dist/`**, and every spec then times out uniformly — a failure
  mode that looks like a broken test and is not. `npx playwright install` is a prerequisite
  (local Playwright is 1.62.1 with chromium, firefox and webkit installed).
- **RED 1** — Playwright case 1. Plant a directory at the target through `sut.mkdir`, write a
  child through `sut.write`, then call `sut.writeExclusive`. Today the rejection escapes as a bare
  `DOMException`: `err.data` is `undefined`, so the returned `code` is `undefined` rather than
  `FILE_EXISTS`.
- **RED 2** — Playwright case 2, all three step groups. Today step (a) returns `FILE_NOT_FOUND`
  instead of `PERMISSION_DENIED`; steps (b) and (c) **pass** today and must still pass after the
  fix — (c) is the regression guard, not a new behaviour.
- **RED 3** — Playwright case 3. Today the returned code is `FILE_NOT_FOUND`; the source-survives
  assertions pass today and must still pass.
- Run the reds with
  `npx playwright test test/browser/opfs-roundtrip.spec.ts --project=chromium --project=firefox`
  and confirm the failures are the **code mismatches described above**, not timeouts. A uniform
  timeout means the build step was skipped.
- **GREEN** — add `isTypeMismatch` and `isNotFoundRejection` beside `isFileNotFound`; narrow
  `assertDoesNotExist`'s catch; add the `create`-gated arm to `resolveFileHandle`. Re-run the two
  projects: all three cases green.
- **REFACTOR / smoke** — run the **whole** browser tier, `npm run test:e2e`. All six spec files
  must stay green on chromium and firefox; webkit skips the OPFS describes as before. A red here
  is the real signal this part exists to produce.

### Gate

```
npm run build
npx playwright test test/browser/opfs-roundtrip.spec.ts --project=chromium --project=firefox
npm run test:e2e
npm run check:types
npx tsc --noEmit -p tsconfig.json
./node_modules/.bin/biome check src/adapters/browser/browser-file-system.ts test/browser/opfs-roundtrip.spec.ts
npm run check:spelling
npx cspell --no-progress src/adapters/browser/browser-file-system.ts test/browser/opfs-roundtrip.spec.ts
npm run docs:json && git diff --stat -- reports/api.json
```

`npm run build` **first** — the two Playwright commands serve `dist/`. `npm run docs:json` here
must show **no** diff: this part adds no public symbol and changes no doc comment on one. If it
does show a diff, something leaked into the public surface — investigate before committing, then
commit the regenerated file.

### Commit

```
fix(browser-fs): map a directory occupant to a refusal on write, rename and exclusive create
```

---

## After the last part — the orchestrator's checks

1. `npm run validate`, run **bare** into a file, exit code read from that file. It gates
   `test:coverage` (100 % on `src/adapters/memory/**`), `check:test-pyramid`, `check:duplicates`,
   `check:dead-code`, `check:architecture`, `check:spelling` and the rest.
2. `npm run test:posix-integration` — **not** in `validate`.
3. `npm run test:e2e` — **not** in `validate`.
4. `npm run docs:json && git diff --exit-code -- reports/api.json` — the prepush gate that local
   `validate` does not run.
5. `npm outdated` is re-measured before the full gate (eight excepted packages,
   `.claude/workflow.md`).
6. The **Windows leg** is CI-only. Under the tolerant-row design the refusal rows are Windows-safe
   by construction; the exposure is the two **positive** rows named in Part 4 — the
   empty-directory-destination replace and `src === dst` for a non-empty directory. A red there is
   a decision to escalate, never a licence to loosen a memory-side assertion.
