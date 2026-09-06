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

## The Windows leg — parts 6 to 9

> Source: design `docs/design/memory-write-exclusive-directory.md` §5, §6, §8a–§8i, R41–R50 ·
> ADRs 820, 821, 822, 823, 824, 825.
> Parts 1–5 above are **implemented and merged into this branch**. Nothing above is renumbered,
> re-scoped or re-run. *Sizing rules*, *Notation*, *Docs this plan does NOT touch*, *Repo-wide
> facts every part needs* and PC-1…PC-3 all still bind. The five entries below are **additions**
> to those preamble sections, verified against the worktree at `ef3f985b`.

| Preamble section | What the Windows leg adds or corrects |
|---|---|
| *Notation — the errno this plan may not spell* | The real six-letter errno name **is now in `cspell.json`** (`:288`, between `"effectful"` and `"EISDIR"`) — Part 1 put it there. So **no dictionary chore exists in this leg**: the design confirms the Windows arm introduces no new literal (it delegates the inside-source arrangement to the platform, which reports the same errno). This document keeps writing `INVALID-ARGUMENT`; test and source code spell the real name, and `check:spelling` is already clean on it |
| *Docs this plan does NOT touch* | Three more **docs-phase** surfaces, off-limits to every part below: `docs/design/ports-and-adapters.md:45` (the false "Windows `fs.rename` does replace" claim), its §7.1 node bullet list (no `rename` bullet), and `docs/understand/architecture.md:134`. `src/ports/file-system.ts` and `tooling/verify-tarball.sh` are **not** docs — they are source and tooling, and they belong to Part 6 |
| *`reports/api.json`* | **Measured, not assumed.** `typedoc.json` sets `excludeInternal: true`, so neither the fourth `PathPolicy` flag nor the renamed creation-leaf classifier moves the report: `honoursNoFollow` and `interpretCreationLstat` appear **0 times** in `reports/api.json` today, and `PathPolicy` appears exactly **twice**, both as a bare `{"name":"PathPolicy"}` type reference on `NodeFileSystem`'s constructor parameter, which adding a field does not change. The **only** api.json mover in this leg is the port JSDoc (**R47**) — Part 6 |
| *Two size gates, not one* | `validate` depends on **both** `check:size` (`size-limit` over `dist/**`, gzipped JS, so JSDoc prose is invisible to it) **and** `check:tarball` (`bash tooling/verify-tarball.sh --quick`, the 906 KiB packed cap with **415 B** of headroom, where `.d.ts` + `.d.cts` prose counts **twice**). Only Parts 6 and 7 change `src/`, so only they can move either number |
| *Audits that are **not** tripped* | `check:write-surfaces` reads `@writes` JSDoc tags and there are **none** in `src/adapters/node/**` or `src/ports/**` — measured, zero hits. `check:duplicates` is `jscpd src/` and never scans `test/`, so a helper copied from one test file into another is not gated. No new public export, no new error code, no new Tier-1 command: none of `check:doc-coverage`, `check:browser-surface`, the `Repository` facade or `src/domain/error.ts` moves |
| *Phase gate* | *"`npm run validate` … run once by the orchestrator after Part 5"* now reads **after Part 9**. No part below runs it — Part 9 included, even though it is the part with the least local signal |

### The cut — four more parts, and why

**Part 6** is the emulation itself: the gate flag, `planRename`, and the port JSDoc that describes
them. It is one behaviour, one ADR cluster (820 / 822 / 823 / 825) and one commit; splitting the
flag from its only reader would ship a dead capability.

**Part 7** is a different method (`writeExclusive`), a different ADR (R44 / §8f), a different
shared helper (`interpretCreationLstat` and its two callers) and a different failure mode — the
raw platform call *creates a file through a dangling link* rather than reporting the wrong code.
It rewrites five already-committed unit rows in a third file, two of which flip verdict. Folding it
into Part 6 would make one commit that changes two unrelated syscall families.

**Part 8** is the legitimate standalone the sizing rules allow: **zero `src/` delta**. It tightens
assertions on already-landed behaviour and spans two files owned by two *different* earlier parts
(Part 3's contract helper, Part 1's posix-only file), so it cannot fold into either — and its own
effect is invisible on this host (§Gate).

**Part 9** is a new file in a tier that **cannot execute on darwin** and has its own CI job. It has
no local pass/fail signal at all, which is exactly why it is not merged into a part whose gate is
supposed to mean something.

Order is forced by two edges only: Part 8's strict codes and Part 9's rows both describe behaviour
Part 6 and Part 7 create, so both follow them. Parts 6 and 7 are mutually independent; 6 goes first
because it is the larger surface and carries the port JSDoc the whole leg is described by.

**The six shared files `plan-lint` will warn about, and why each stays split.**
`src/adapters/node/node-file-system.ts` and `test/unit/adapters/node/node-file-system-injected.test.ts`
are in Parts 6 and 7 — same file, two unrelated syscall families (`rename`'s kind rules,
`writeExclusive`'s leaf verdict) that share nothing but a class. `src/ports/file-system.ts` and
`reports/api.json` are in Parts 4, 6 and 7 by PC-1's standing rule that the contract moves with the
behaviour it describes (Part 7 only *asserts* a clean report — see its Gate).
`test/unit/ports/file-system.contract.ts` is in Parts 4 and 8, and
`test/integration/posix-only/node-fs-write-rename-refusals.test.ts` in Parts 1 and 8, because Part 8
is a strictness pass **over** what those parts wrote — merging it into either would put half of one
ADR in each.

### Public-vs-internal for the Windows leg, decided up front

| New symbol | Verdict | Gates tripped (pre-paid in the owning part) |
|---|---|---|
| `PathPolicy.honoursRenameKinds`, `PathPolicyCapabilities.honoursRenameKinds` (Part 6) | **internal.** `PathPolicy` is `@internal` and not re-exported from `src/adapters/node/index.ts`; `PathPolicyCapabilities` and `makePolicy` are module-private with **zero** import sites | none — `reports/api.json` does not move (measured above) |
| `NodeFileSystem.planRename`, `NodeFileSystem.lstatOrMissing` (Part 6) | **internal** — `private` methods | none |
| `type RenamePlan` (Part 6) | **internal** — module-private type alias in `node-file-system.ts`, **not exported** (an unused export is a `check:dead-code` / knip finding) | none |
| `isCreationLeafSymlink` (Part 7) | **internal** — replaces the equally `@internal` `interpretCreationLstat`, exported only so its unit rows can call it, never barrelled | none — `excludeInternal` keeps both out of api.json |
| `NodeFileSystem.creationLeafIsSymlink`, `NodeFileSystem.assertExclusiveCreateLeaf` (Part 7) | **internal** — `private` methods | none |
| `assertDirectoryNotEmpty` (Part 8) | **test-internal** — module-private in `file-system.contract.ts`, beside `assertNotADirectory` (`:93`) | none |
| `dataFor` helper in `node-file-system-injected.test.ts` (Part 6) and in the new win-only file (Part 9) | **test-internal** — a copy of the posix-only file's `:52–60` helper | none; `jscpd` never scans `test/` |
| `test/integration/win-only/node-fs-windows-rename-refusals.test.ts` (Part 9) | **test file** | `@proves` header (report-only), tier heuristics (gated) |

**The one public surface that moves is the port JSDoc** on the already-public `FileSystem`
interface — comment text only, no signature, no new member. It regenerates `reports/api.json` in
Part 6, per PC-1's rule.

### Decision candidates — the Windows leg

Every design-level choice is pre-decided by ADRs 820–825 and the design's own candidate section.
The five below are **plan-mechanics** choices this extension had to make, plus one **design
correction** the pre-chewing turned up. Each carries a recommendation; the recommendation is what
Parts 6–9 implement.

| # | Choice | Options | Recommendation |
|---|---|---|---|
| **DC-W1** 🔴 | §8d's `planRename` opens with `normalizeForCompare(realSrc) === normalizeForCompare(realDst) → 'rename-only'` and *then* `pathContains(realSrc, realDst) → 'rename-only'`. **The first line is dead code:** `pathContains` (`node-file-system.ts:175–183`) → `pathContainsNormalized` (`:191–199`) normalises **both** sides with the same `policy.normalizeForCompare` and returns `true` on equality (`if (c === normalizedParent) return true;`) before its `+ sep` prefix test. Every input the first line catches, the second catches too, with the same verdict | (1) **drop** the explicit self-rename compare; keep `pathContains` and carry §8d point 3's reasoning into a comment on it; (2) keep both lines as written and accept a branch no input can isolate — two mutants (`ConditionalExpression`, `EqualityOperator`) that only a `Stryker disable … equivalent` directive could answer, which this plan otherwise adds none of; (3) keep the explicit compare and narrow `pathContains`'s use to a strict-inside test, making the two genuinely disjoint — a behaviour change to a shared predicate `resolveWrite` already depends on | **(1)**. The repo's own rule is *"watch for dead code in guards … remove them rather than writing impossible tests"*. The behaviour is identical, the syscall budget is identical (0 either way), and DI row 2 keeps its meaning — it now pins `pathContains`'s equality arm instead of a redundant line above it |
| **DC-W2** | Where the R47 port JSDoc and its `reports/api.json` regeneration land | (1) **Part 6**, in the commit that creates the behaviour the sentences describe; (2) a sixth, docs-of-source part after Part 9 — one more agent lifecycle for a comment edit; (3) Part 9, next to the rows that prove it | **(1)**, which is PC-1 applied unchanged: *"an atomic commit that changes behaviour without changing the contract that describes it is exactly the shape that let this bug exist"* |
| **DC-W3** | Where `tooling/verify-tarball.sh`'s cap raise lands, given 415 B of headroom | (1) a **second, separate `chore(tarball):` commit inside the first part whose clean-build measurement exceeds the cap** — Part 6 measures first, Part 7 re-measures if Part 6 stayed under; (2) a standalone part; (3) raise it pre-emptively in Part 6 without measuring | **(1)**. The design calls it an implementation-phase chore of one commit; a whole part for a one-line constant plus a paragraph does not earn an agent lifecycle, and (3) breaks the script's own convention, which is that every raise records a **measured** figure and its attribution |
| **DC-W4** | How the DI rows isolate the two `isSymbolicLink()` disjuncts. For a **real** `Stats`, `isDirectory()` and `isSymbolicLink()` are never both true, so `source.isSymbolicLink()` and `destination.isSymbolicLink()` never change a verdict on a real filesystem and their mutants survive every realistic input | (1) fabricate a stat reporting **both** true in DI rows 5 and 11 — the only input that isolates each disjunct, and the arrangement §8d point 5 is defending against (a platform whose `lstat` reports a directory reparse point as a directory); (2) drop the two `isSymbolicLink()` tests and rely on `!isDirectory()` — loses the defence §8d point 5 exists for; (3) keep them and accept two survivors | **(1)**, which is what §8h(a)'s own wording already asks for: row 5 says *"the symlink test, not the directory test, decides it"* and row 11 says *"the second disjunct, alone"*. Neither sentence is satisfiable with a realistic stat, so the fabrication is the design's intent made explicit |
| **DC-W5** | Whether Part 8 (strict contract rows + the N15 pair) is its own part | (1) **its own part** — zero `src/` delta, two files owned by two different earlier parts, and a gate that is honest about proving nothing on this host; (2) fold into Part 6 — makes one commit carry an emulation, a port contract and a suite-wide strictness change; (3) split it — contract rows into Part 6, the N15 pair into Part 9 | **(1)**. Option 3 is rejected outright: the N15 pair is a **POSIX** row about a linux/darwin split and has nothing to do with the win-only tier |
| **DC-W6** | The ordering assertion for `rmdir` before `rename` (§8h(a) row 14) has **no precedent in this repo** — `mock.invocationCallOrder`, `toHaveBeenNthCalledWith` and every order-log idiom return zero hits across `test/` | (1) `expect(rmdirSpy.mock.invocationCallOrder[0]).toBeLessThan(renameSpy.mock.invocationCallOrder[0])` — vitest's own shared monotonic counter, no new machinery; (2) a hand-rolled `const order: string[] = []` pushed from each fake — explicit but re-implements what vitest already records; (3) assert only *that both were called* and let the win-only replace row prove the order end-to-end — leaves the order unpinned on the mutation runner | **(1)**. It is the mechanism §8h(a) names, and the row must capture named spies rather than reading `fakeFsOps`'s defaults, because the builder hands back no handles |

---

## Part 6 — The node adapter enforces POSIX rename kind rules where the platform does not

### Context

**What this part is.** The node adapter's `rename` gains an explicit pre-rename kind check on any
platform whose own `rename` does not enforce POSIX `rename(2)`'s kind rules, gated on a **fourth**
`PathPolicy` capability flag. It implements design **§8d**, **§8e** and **§6**, requirements
**R37–R43**, **R47**, **R48**, **R49**, **R50**, and ADRs **820**, **822**, **823**, **825**.
It is the part that makes the two red shared-contract rows pass on Windows (**R45**).

**Why the emulation, in one line, for the agent that starts cold.** On `windows-latest` the
composed `NodeFileSystem.rename` today **replaces a regular file with a directory source** (a
silent data loss) and **refuses every directory destination** with `PERMISSION_DENIED`, including
the empty one POSIX replaces. Real `git` behaves like POSIX on Windows because its own compat
layer emulates exactly these rules in user space. Do not re-derive any of this: the matrices are
probed and the ADRs are accepted.

**Files.**

| Action | Path | What |
|---|---|---|
| edit | `src/adapters/node/path-policy.ts` | the fourth flag on `PathPolicy` (`:57–85`) and on `PathPolicyCapabilities` (`:173–177`); `posixPolicy: true` (`:222–226`), `windowsPolicy: false` (`:227–231`); the two "three flags" sentences in the prose (`:12`, `:169`) become "four" |
| edit | `src/repository/portable-posix-policy.ts` | `honoursRenameKinds: true` in the hand-written literal (after `:29`) — the **only** enumerating `PathPolicy` literal outside `path-policy.ts` in the whole repo |
| edit | `src/adapters/node/node-file-system.ts` | `type RenamePlan`, `planRename`, `lstatOrMissing`, and `rename`'s `try/finally` (`:745–759`) |
| edit | `src/ports/file-system.ts` | the three **R47** sentences, verbatim from design §6 — `rename` (`:129–145`) and `atomicRename` (`:148–158`) |
| regenerate | `reports/api.json` | `npm run docs:json`, committed **in this commit** |
| edit | `test/unit/adapters/node/node-file-system-injected.test.ts` | DI rows 1–16 plus the two additions below |
| edit | `test/unit/adapters/node/path-policy.test.ts` | the two capability-triple pins (`:366–382`, `:386–402`) become quadruples, titles included |
| maybe edit | `tooling/verify-tarball.sh` | the cap raise — **a second commit**, only if the measurement says so (DC-W3) |

**`tsc` blast radius of the fourth flag — measured, and it is small.** Exactly **three** object
literals in the repo enumerate the fields and will fail to compile: the two capability arguments in
`path-policy.ts` and `portablePosixPolicy`. **Zero** in `test/`, `tooling/` or the benches. The four
test spreads — `node-file-system-injected.test.ts:301`, `:1039`, `:1859`, `:2406`
(`{ ...windowsPolicy, … }` / `{ ...posixPolicy, … }`) — carry the new field automatically and need
no edit. `makePolicy` needs no edit either: it already does `...capabilities` (`:212`).

Two near-misses that compile but must still be touched:

- `path-policy.test.ts:366–382` and `:386–402` build a plain three-key `result` object from
  property reads and `toStrictEqual` it against a three-key literal; their `describe` titles name
  the three flags. They keep compiling and **silently stop covering the new flag** — extend both to
  four keys and rename both titles. This is where `posixPolicy: true` / `windowsPolicy: false`
  (**R48**) is pinned.
- `path-policy.test.ts:413`'s `hypotheticalCapabilities` is un-annotated and only ever feeds
  `normalizeForCompareWithCapabilities`, whose parameter is a two-key `Pick`. Safe — **do not**
  widen that `Pick`.

**The current `rename` (`node-file-system.ts:745–759`), verbatim, is what you are editing:**

```ts
rename = async (src: string, dst: string): Promise<void> => {
  const realSrc = await this.resolveWrite(src);
  const realDst = await this.resolveWrite(dst);
  await runFs(async () => {
    await this.fsOps.mkdir(this.pathPolicy.dirname(realDst), { recursive: true });
    await this.fsOps.rename(realSrc, realDst);
  }, src);
  this.parentRealpathCache.clear();
};
```

**The target shape** — design §8d, with DC-W1's dead first line removed:

```ts
rename = async (src: string, dst: string): Promise<void> => {
  const realSrc = await this.resolveWrite(src);
  const realDst = await this.resolveWrite(dst);
  try {
    await runFs(async () => {
      const plan = await this.planRename(realSrc, realDst, src);
      await this.fsOps.mkdir(this.pathPolicy.dirname(realDst), { recursive: true });
      if (plan === 'replace-directory') await this.fsOps.rmdir(realDst);
      await this.fsOps.rename(realSrc, realDst);
    }, src);
  } finally {
    this.parentRealpathCache.clear();
  }
};

private async planRename(realSrc: string, realDst: string, reported: string): Promise<RenamePlan> {
  if (this.pathPolicy.honoursRenameKinds) return 'rename-only';
  // Returns true on normalised equality as well as strict containment, so a
  // case-differing self-rename delegates here rather than falling through to
  // the kind checks and newly refusing a non-empty directory.
  if (pathContains(realSrc, realDst, this.pathPolicy)) return 'rename-only';
  const source = await this.lstatOrMissing(realSrc);
  if (source === undefined || !source.isDirectory() || source.isSymbolicLink()) {
    return 'rename-only';
  }
  const destination = await this.lstatOrMissing(realDst);
  if (destination === undefined) return 'rename-only';
  if (!destination.isDirectory() || destination.isSymbolicLink()) {
    throw notADirectory(reported);
  }
  return 'replace-directory';
}

/** "Is there an entry here" — never "what is it". Swallows nothing but absence. */
private async lstatOrMissing(real: string): Promise<fs.Stats | undefined> {
  try {
    return await this.fsOps.lstat(real);
  } catch (err) {
    if (isErrnoException(err) && (err.code === 'ENOENT' || err.code === 'ENOTDIR')) {
      return undefined;
    }
    throw err;
  }
}
```

`fs.Stats` is already in scope — the file imports `* as fs from 'node:fs'` (`:1`) — and
`fsOps.lstat` with no options resolves to it. `RenamePlan` is a module-private
`type RenamePlan = 'rename-only' | 'replace-directory';` beside the file's other module-level
types; do **not** export it.

**Nine points from §8d that the code must keep true, condensed — each has a DI row below.**

1. **The refusals are raised inside `runFs` and pass through it untouched.** `runFs` (`:254`)
   rethrows anything `isErrnoException` (`:140`, `err instanceof Error && 'code' in err`) rejects.
   `TsgitError` (`domain/error.ts:84–90`) carries its code at `data.code` and has **no** own
   `code`, so a `notADirectory(reported)` thrown inside the callback reaches the caller verbatim.
   Being inside `runFs` is also what gives the probes' own stray errnos the `src` anchoring every
   other error in this operation already has.
2. **The gate is the first line and short-circuits to nothing** — zero syscalls, zero allocations
   on every POSIX host (**R41**).
3. **Containment is tested through `pathContains(realSrc, realDst, this.pathPolicy)`** — the
   adapter's own normalised prefix test (`:175`), already case- and separator-correct. Call it
   **through the policy object**; never lift `normalizeForCompare` into a local binding. No
   hand-written policy in the repo uses ordinary methods today (all are arrow properties), so this
   is a forward-looking rule, not a live bug — keep it anyway.
4. **The containment test comes before every kind test and *delegates*.** Windows already reports
   the invalid-argument errno for the inside-source family, which is the answer ADR-817 chose for
   memory. Refusing here would re-code that family and — the destructive one — take the replace arm
   on a destination *inside* the source, removing an existing empty directory before a rename that
   fails anyway.
5. **Symlinks are never followed on either side.** Both probes are `lstat`, and both arms test
   `isSymbolicLink()` explicitly. See DC-W4 for how the two disjuncts get isolated.
6. **`lstatOrMissing` answers "is there an entry here" and swallows nothing.** `ENOENT` **and**
   `ENOTDIR` mean *no entry at this path* → `undefined`; every other errno propagates through
   `runFs`; a non-errno throwable re-bubbles untouched. `ENOTDIR` is deliberate: it is the
   ancestor-blocked case, where "missing" delegates to the `mkdir -p` and the `rename` that already
   produce today's measured codes, so the emulation cannot move an ancestor-fault row (**R49**).
   Mirror `isSymlinkLeaf`'s existing ENOENT-only swallow (`:856–875`) in shape; whether the two
   share one helper is a **refactor-phase** call, not this part's.
7. **The plan runs before the `mkdir -p`, and the ordering is provably immaterial** — the one
   refusal the plan raises requires the destination to exist, which requires its parent to exist,
   which makes the `mkdir -p` a no-op on exactly that arm.
8. **The replace arm is `rmdir` then `rename`, and the emptiness verdict is the platform's**
   (ADR-825, **R50**). The `rmdir` runs inside the operation's existing `runFs(…, src)`, so
   `mapErrno`'s `ENOTEMPTY` arm (`:225–229`) returns `directoryNotEmpty(src)` and an `EACCES`
   returns `permissionDenied(src)`. **`readdir` is never called, on any branch.**
9. **Atomicity is scoped, not dropped** (ADR-823) — which is what the third R47 sentence says.

**The three R47 sentences are fixed text; copy them, do not re-phrase.** They are written out
verbatim in design §6 ("The three sentences the Windows leg adds — R47, verbatim"). Sentence 1
replaces the clause beginning *"On the node and memory adapters:"* which starts mid-line at
`src/ports/file-system.ts:134`; sentence 2 replaces the ancestor-chain parenthesis at `:140–141`
(*"(node: `dst`; memory: the blocking ancestor)"*); sentence 3 replaces `atomicRename`'s
`:156–157` (*"Inherits every `rename` refusal above by delegation, and stays atomic because the
guard is pure inspection with no `await` between it and the mutation."*). `writeExclusive`'s JSDoc
(`:75–94`) needs **no edit** — re-read `:76–78` to confirm it still names *"a symbolic link,
including a dangling one"*; §8f is what makes that true on Windows, in Part 7.

**`reports/api.json` regenerates in this commit.** `check:doc-typedoc` is
`git diff --exit-code -- reports/api.json` and runs at **prepush**, not in `validate` — a green
cached `validate` followed by a rejected push is the exact failure this pre-pays.

**The DI suite — where the rows go and how they are built.**
`test/unit/adapters/node/node-file-system-injected.test.ts` (3 618 lines) is the **mutation gate**
for everything above: Stryker's runner is linux, so without an injected `windowsPolicy` every
mutant in `planRename` is an unreachable-code survivor. Coverage is the same story —
`src/adapters/node/**` is at 100 % line/branch/function/statement (`vitest.config.ts:80–95`), and
these rows are the only thing that reaches the emulating arm on this host.

- Builder, `:33–57`: `fakeFsOps(overrides)` — every method is a `vi.fn()`; `realpath`, `open`,
  `lstat`, `stat`, `readdir`, `readFile`, `readlink` **reject `ENOENT` by default**, while
  `writeFile`, `mkdir`, `rm`, `rmdir`, `rename`, `symlink`, `chmod` **resolve `undefined`**. So
  "source `lstat` rejects `ENOENT`" is the *default*, and any row that wants a handle on `rmdir` or
  `rename` must pass its own named spy through `overrides`.
- Errno factories at `:22–31`: `enoent()`, `eacces()`, `enotdir()`, `eloop()`, all
  `Object.assign(new Error(msg), { code: 'XXX' })`. One-off codes are declared inside the `it`
  (`:1029` does this for `EIO`) — follow that for the invalid-argument errno and for `ENOTEMPTY`.
- The single most common arrange line, and required in **every** row here:
  `realpath: vi.fn().mockImplementation(async (input: string) => input)`.
- Construction: `const sut = new NodeFileSystem(rootDir, windowsPolicy, fsOps);` (`:2431`) with
  `rootDir = 'C:\\Root'`; the POSIX rows use `'/root'` and `posixPolicy` (`:1546`).
- Stat fabrication has **no shared factory** — rows inline the predicates they read, e.g.
  `lstat: vi.fn().mockResolvedValue({ isDirectory: () => false, isSymbolicLink: () => false })`
  (`:1595–1597`). Use the minimal two-predicate literal; the full bigint literal at `:60–72` is
  only needed where `mapStat` runs.
- Nesting: `describe('<subject> (DI)')` > `describe('Given …')` > `describe('When …')` >
  `it('Then …')`, AAA section comments in every body, `sut` bound to the `NodeFileSystem`.
- **Home for the new rows:** the rename-semantics rows go beside
  `describe('NodeFileSystem.rename — parent-realpath cache invalidation soundness (DI)')` (`:1759`,
  rows at `:1770` and `:1802`); the `atomicRename` row's only existing sibling is `:1635–1654`.
- ⚠️ **`data.path` is asserted nowhere in this file today** (`data.code` appears 32 times, `.path`
  zero) and `TsgitError['data']` is a discriminated union, so `(caught as TsgitError).data.path`
  does **not** type-check. Add the posix-only file's narrowing helper
  (`node-fs-write-rename-refusals.test.ts:51–60`) verbatim beside the errno factories:

```ts
/** Asserts `err` is a `TsgitError` carrying `code`, and returns its data narrowed to that variant. */
function dataFor<Code extends TsgitError['data']['code']>(
  err: unknown,
  code: Code,
): Extract<TsgitError['data'], { code: Code }> {
  expect(err).toBeInstanceOf(TsgitError);
  const { data } = err as TsgitError;
  expect(data.code).toBe(code);
  return data as Extract<TsgitError['data'], { code: Code }>;
}
```

**The rows — design §8h(a) 1–16, plus two this plan adds.** Every path expectation is `src` as the
**caller supplied it**, never `realSrc`. Where the design names the mutant a row kills, it is
repeated here; that naming is the point of one row per branch.

| # | Given (`windowsPolicy` unless stated) | Then | Kills |
|---|---|---|---|
| 1 | `posixPolicy`, a directory source over a regular-file destination | `rename` called once; `lstat` and `rmdir` **never** called | the forced-**false** `honoursRenameKinds` gate |
| **1b** *(added, cheap)* | `posixPolicy`, a directory source, a directory destination, `fsOps.rmdir` resolving | `rmdir` **never** called and `rename` called once | the gate on the **replace** arm specifically — row 1 only proves the gate on the refuse arm, and a mutant that returns `'replace-directory'` for a POSIX host destroys an empty destination before delegating |
| 2 | `src` and `dst` differing only in case | delegates; `lstat` **never** called | the forced-**false** containment escape (without it a case-differing self-rename of a non-empty directory would newly refuse `DIRECTORY_NOT_EMPTY`) |
| 3 | `dst` inside `src`, `dst` an existing empty directory, `fsOps.rename` rejecting the `INVALID-ARGUMENT` errno | `UNSUPPORTED_OPERATION`, `operation: 'filesystem'`, `reason` = that errno; `lstat` and `rmdir` **never** called | the "refuse instead of delegate" mutation of the containment arm — the row that proves the arm does not destroy an existing `dst` inside `src` |
| 4 | a regular-file source (`isDirectory:false`, `isSymbolicLink:false`), any destination | exactly **one** `lstat`; `rmdir` never called | `!source.isDirectory()` **alone** |
| 5 | a source stat reporting **both** `isDirectory: () => true` and `isSymbolicLink: () => true`, over a directory destination | delegates after **one** `lstat`; `rmdir` and the destination probe never fire | `source.isSymbolicLink()` **alone** (DC-W4 — the only input that isolates it) |
| 6 | source `lstat` rejecting `ENOENT` | delegates; the platform's own `rename` reports it | `source === undefined` **alone** |
| 7 | a directory source, destination `lstat` rejecting `ENOENT` | delegates; `rmdir` never called | the `destination === undefined` early return |
| 8 | a directory source, destination `lstat` rejecting `ENOTDIR` | delegates — the ancestor-blocked case keeps today's code | the `ENOTDIR` disjunct of `lstatOrMissing`, **alone** |
| **8b** *(added)* | a directory source, destination `lstat` rejecting a **non-errno** throwable (`new RangeError('weird')`) | that exact object propagates (`expect(caught).toBe(original)`); `rmdir` and `rename` never called | the `isErrnoException(err) &&` term of `lstatOrMissing` — otherwise an unreached false branch under the 100 % branch gate |
| 9 | a directory source, destination `lstat` rejecting `EACCES` | `PERMISSION_DENIED` carrying **src**; `rename` never called | "the probe swallows nothing" |
| 10 | a directory source, a **regular-file** destination | `NOT_A_DIRECTORY` carrying **src**; `rmdir` and `rename` never called | `!destination.isDirectory()` **alone** |
| 11 | a directory source, a destination stat reporting **both** `isDirectory: () => true` and `isSymbolicLink: () => true` | idem | `destination.isSymbolicLink()` **alone** (DC-W4) |
| 12 | a directory source, a directory destination, `fsOps.rmdir` rejecting `ENOTEMPTY` | `DIRECTORY_NOT_EMPTY` carrying **src**; `rename` never called | that the refusal comes from `mapErrno`, not from a hand-written verdict |
| 13 | the same, `fsOps.rmdir` rejecting `EACCES` | `PERMISSION_DENIED` carrying **src**; `rename` never called | **R50**'s *"every other `rmdir` errno passes through the same map"* — one code path, not two |
| 14 | a directory source, a directory destination, `fsOps.rmdir` resolving | `rmdir(realDst)` **then** `rename(realSrc, realDst)`, in that order, and `readdir` **never called on any arm** | ADR-825's removal of the emptiness probe; a future re-introduction of a `readdir` fails a row instead of passing silently |
| 15 | row 14's arrangement with `fsOps.rename` rejecting | the error surfaces **and** a following call re-issues `realpath` for the same parent | **R43** — the `finally`, which a mutant that deletes the cache clear or restores the old post-`runFs` placement would otherwise survive |
| 16 | `atomicRename` on row 10's arrangement | the same `NOT_A_DIRECTORY` | delegation, not a second guard |

Row 14's order assertion, verbatim (DC-W6; no precedent exists in this repo — this is the form):

```ts
expect(rmdirSpy.mock.invocationCallOrder[0]).toBeLessThan(renameSpy.mock.invocationCallOrder[0]);
```

Row 15's cache proof follows the existing shape at `:1635–1654` (*"realpath(dirname) is invoked
twice total"*): with an identity `realpath` spy, `rename` resolves `src` and `dst` whose parents are
both `rootDir`, so `realpath(rootDir)` is issued **once**; a follow-up write-surface call on the
same parent issues it **again** only if the cache was cleared. Count with the file's own idiom
(`realpathSpy.mock.calls.filter(([arg]) => arg === rootDir).length`, `:1553–1556`).

**What must NOT change on Windows** (**R49**, ADR-822): the file-onto-directory rows keep
`PERMISSION_DENIED`, the inside-source family keeps the invalid-argument errno, and the two
ancestor-fault oddities keep their Windows shapes — `NOT_A_DIRECTORY` carrying **src** where POSIX
carries `dst`, and `FILE_NOT_FOUND` where POSIX says `NOT_A_DIRECTORY`. `lstatOrMissing`'s
`ENOTDIR` arm is the whole reason those stay put. Part 9 pins them.

**Escalate, do not improvise**, `{ part, reason, ≤3 options }`, if: a row in the table disagrees
with the adapter after the change; the fourth flag's addition breaks a file this context does not
name; or the port JSDoc edit produces an `api.json` diff that is not comment text.

### TDD steps

- **RED 1 — the destructive row.** Write DI row 10 first (`windowsPolicy`, directory source,
  regular-file destination → `NOT_A_DIRECTORY` carrying src, `rename` never called). It compiles
  today (`windowsPolicy` already exists) and **fails on behaviour**: nothing is thrown, `caught` is
  `undefined`, and `rename` *was* called. That failure is the bug this part exists for.
- **RED 2 — the over-refusal row.** Add row 12 (`rmdir` rejecting `ENOTEMPTY` →
  `DIRECTORY_NOT_EMPTY` carrying src). Fails today: no `rmdir` is ever issued, so the fake's
  rejection is never reached and the rename resolves.
- **RED 3 — the replace arm.** Add row 14. Fails today: `rmdir` is never called, so
  `invocationCallOrder[0]` is `undefined` and the ordering assertion throws.
- **RED 4 — the cache.** Add row 15. Fails today: the clear sits **after** `runFs`, so a rejected
  rename skips it and the follow-up call reads the cached parent — `realpath` is issued once, not
  twice.
- **GREEN.** In one pass, because the flag and its reader are one change: add
  `honoursRenameKinds` to `PathPolicy` and `PathPolicyCapabilities`; set it on `posixPolicy`,
  `windowsPolicy` and `portablePosixPolicy`; add `type RenamePlan`, `lstatOrMissing` and
  `planRename`; rewrite `rename` with the `try/finally` and the `plan === 'replace-directory'`
  line. `npx tsc --noEmit -p tsconfig.json` names every literal that needs the field — that
  compiler error **is** the migration, and there are exactly three.
- **Branch and mutation rows, after green.** Add rows 1, 1b, 2, 3, 4, 5, 6, 7, 8, 8b, 9, 11, 13 and
  16. These are not RED-able against the old code in any meaningful sense — a call-count
  assertion fails on the old code by counting zero, which is not the defect — so write them
  deliberately as branch and mutant coverage and say so in no code comment (no provenance refs).
  Run the file after each small group; never write fourteen rows and run once.
- **The capability pins.** Extend `path-policy.test.ts:366–402`'s two triples to quadruples and
  their titles with them. These are the rows that pin **R48**'s `true`/`false` split.
- **The port JSDoc.** Copy design §6's three sentences verbatim into `src/ports/file-system.ts`,
  then `npm run docs:json` and stage `reports/api.json` **in this commit**. Confirm the diff is
  comment text only — if a signature moved, stop and escalate.
- **REFACTOR.** `lstatOrMissing` and `isSymlinkLeaf` (`:856`) now share a shape. Do **not** merge
  them here: the design defers it to the refactor phase, and `isSymlinkLeaf` carries an
  equivalent-mutant proof that would have to be re-proved against the merged structure.
- **Measure the size gates last** (DC-W3): `rm -rf dist .wireit`, then `npm run check:tarball`, and
  read the `OK: tarball … verified at N bytes.` or `FAIL: … is N bytes (cap …)` line. If it FAILs,
  raise `SIZE_CAP` at `tooling/verify-tarball.sh:94` to the smallest whole KiB **strictly above**
  the measured pack and append a new paragraph to the header block that ends at `:93`, in the same
  grammar as the eight raises above it: the old and new KiB, the measured byte count, the bytes
  over, and the attribution (the rename kind check and its two probes, the fourth capability flag,
  and the port JSDoc — which every `.d.ts` **and** `.d.cts` carries verbatim, which is why prose
  costs about 1.3 KB per edit here). That is a **separate second commit**,
  `chore(tarball): raise the published size cap for the rename kind emulation`. If it passes, ship
  nothing and let Part 7 re-measure. Also run `npm run check:size` — a second, independent budget
  (`size-limit` over gzipped `dist/**`), which JSDoc does not move but new adapter code does.

### Gate

```
npx vitest run test/unit/adapters/node/node-file-system-injected.test.ts test/unit/adapters/node/path-policy.test.ts test/unit/adapters/node/node-file-system.test.ts
npx vitest run --project unit
npm run check:types
npx tsc --noEmit -p tsconfig.json
./node_modules/.bin/biome check src/adapters/node/path-policy.ts src/adapters/node/node-file-system.ts src/repository/portable-posix-policy.ts src/ports/file-system.ts test/unit/adapters/node/node-file-system-injected.test.ts test/unit/adapters/node/path-policy.test.ts
npm run check:spelling
npx cspell --no-progress src/adapters/node/path-policy.ts src/adapters/node/node-file-system.ts src/ports/file-system.ts test/unit/adapters/node/node-file-system-injected.test.ts
npm run docs:json && git diff --stat -- reports/api.json
npm run test:posix-integration
rm -rf dist .wireit && npm run check:tarball && npm run check:size
```

`npx vitest run --project unit` is the one that matters — the fourth flag and the port JSDoc reach
files this part does not name, and the whole-project run is what proves nothing else moved. Run
every command bare, never through a pipe, and read `echo $?`; `npm run check:types` and
`npm run check:spelling` are wireit-cached and `Ran 0 scripts and skipped 1` reads exactly like a
pass. `npm run test:posix-integration` re-runs Part 1's file, which characterises the **POSIX**
arm this part must leave untouched — a change there is a regression, not a new truth.
`npm run docs:json` **must** show a diff here; a *clean* report means the JSDoc edit did not land.
⚠️ `test/unit/ports/file-system.contract.ts` is **not** a `*.test.ts` file and must never be passed
to `vitest run` as a filter — it collects zero tests and exits non-zero. Its drivers are
`node-file-system.test.ts` and `memory-file-system.test.ts`, and `--project unit` runs both.
`rm -rf dist .wireit` before the two size commands is not optional: a stale chunk has produced a
false reading in this repo before.

### Commit

```
fix(node-fs): enforce POSIX rename kind rules where the platform does not
```

---

## Part 7 — Exclusive create refuses a symlink leaf with FILE_EXISTS on every platform

### Context

**What this part is.** `writeExclusive` over a symlink leaf — live **or** dangling — refuses with
`FILE_EXISTS` on every platform, including one whose `open(2)` ignores `O_NOFOLLOW`. The four
non-exclusive write surfaces and `chmod` keep `PERMISSION_DENIED`. It implements design **§8f**,
requirement **R44**, and the second half of **R47** (which needs no JSDoc edit — see below). No
port signature and no `reports/api.json` movement.

**Why it is a correctness fix, not a code-rename.** Measured on `windows-latest`: the raw syscall
underneath the adapter, `fs.open(path, 'wx')`, **succeeds over a dangling symlink and creates the
link's target** — anywhere the link points, including outside the containment root. On ubuntu and
darwin the same call reports `EEXIST`. So the adapter's pre-open `lstat` on the
`honoursNoFollow: false` arm is what *stops the write*, not merely what names the error; it must
keep firing for a dangling link, and *"drop the guard and let the platform's `EEXIST` answer"* is
not available. Real `git` forces `EEXIST` for a reparse point under `O_CREAT|O_EXCL` in its own
compat layer for exactly this reason, and refuses a live **or** dangling symlink at `index.lock`
with *"File exists."* on all three operating systems.

**Files.**

| Action | Path | What |
|---|---|---|
| edit | `src/adapters/node/node-file-system.ts` | `interpretCreationLstat` (`:304–324`) → `isCreationLeafSymlink`; `assertLeafSafeToWrite` (`:906–915`) and the new `creationLeafIsSymlink` / `assertExclusiveCreateLeaf`; `writeExclusive` (`:656–663`) swaps its one call |
| edit | `test/unit/adapters/node/node-file-system.test.ts` | the import at `:8` and the five rows at `:1130–1215` |
| edit | `test/unit/adapters/node/node-file-system-injected.test.ts` | DI rows 17–20 |

**The current call graph, verbatim where it matters.** `writeExclusive` (`:656`) is
`resolveWrite(path)` → `assertWritableLeaf(real, path)` → `runFs(mkdir -p; writeFile(real, data,
{ flag: WRITE_EXCLUSIVE_FLAGS }))`. `assertWritableLeaf` (`:924–928`) runs
`assertLeafSafeToWrite` **only** when `!this.pathPolicy.honoursNoFollow`. `assertLeafSafeToWrite`
(`:906–915`) `lstat`s the leaf into a `{ ok, isSymlink } | { ok: false, err }` record and hands it
to the exported `interpretCreationLstat` (`:304–324`), whose symlink arm throws
`permissionDenied(path)` **before any syscall touches the leaf**. `chmod` (`:787`) calls
`assertLeafSafeToWrite` directly, on every platform.

**The target shape** — design §8f, names included:

```ts
/** @internal — a classifier: same three cases, same errno handling, same non-errno re-bubble. */
export function isCreationLeafSymlink(
  result:
    | { readonly ok: true; readonly isSymlink: boolean }
    | { readonly ok: false; readonly err: unknown },
  path: string,
): boolean;

/** lstat the creation leaf and classify it. Unconditional; callers gate on the policy. */
// today's `assertLeafSafeToWrite` body, with only its last line changed
private async creationLeafIsSymlink(real: string, path: string): Promise<boolean> {
  let result: { ok: true; isSymlink: boolean } | { ok: false; err: unknown };
  try {
    const leafStat = await this.fsOps.lstat(real);
    result = { ok: true, isSymlink: leafStat.isSymbolicLink() };
  } catch (err) {
    result = { ok: false, err };
  }
  return isCreationLeafSymlink(result, path);
}

// unchanged meaning — chmod's caller, on every platform
private async assertLeafSafeToWrite(real: string, path: string): Promise<void> {
  if (await this.creationLeafIsSymlink(real, path)) throw permissionDenied(path);
}

// unchanged — write / writeUtf8 / writeStream / appendUtf8
private async assertWritableLeaf(real: string, path: string): Promise<void> {
  if (!this.pathPolicy.honoursNoFollow) await this.assertLeafSafeToWrite(real, path);
}

// new — writeExclusive only
private async assertExclusiveCreateLeaf(real: string, path: string): Promise<void> {
  if (this.pathPolicy.honoursNoFollow) return;          // O_EXCL already answers EEXIST
  if (await this.creationLeafIsSymlink(real, path)) throw fileExists(path);
}
```

**"Pure classifier" is precise, not loose.** `isCreationLeafSymlink` still **throws** on a
non-`ENOENT` errno (through `mapErrno`) and still re-bubbles a non-errno throwable untouched. What
changes is only the symlink verdict: it *reports* instead of *deciding*, and each caller names its
own refusal. Three properties make this the right shape rather than threading a verdict parameter
through two layers: the error is named at the call site that knows its surface, the exported helper
becomes a value-returning function its unit rows can assert on directly, and **the one caller that
runs on every platform — `assertLeafSafeToWrite` — does not change meaning.**

⚠️ **Do not confuse `creationLeafIsSymlink` with `isSymlinkLeaf` (`:856–875`).** Both `lstat` a
leaf; the second belongs to `openWithNoFollow`, carries its own equivalent-mutant proof in a
comment, and is **not touched by this part**. Adding a second private method with a similar name is
deliberate — merging them is a refactor-phase question, and merging would falsify that proof.

**The five existing rows at `node-file-system.test.ts:1130–1215`, and exactly what moves.** They
sit under `describe('interpretCreationLstat')` (`:1130`) in the 3-level Given/When/Then shape, each
body a `try/catch` into `let caught: unknown`. Rename the describe, the import at `:8`, and the
five call sites; then:

| Row | Today | After |
|---|---|---|
| `Given ok=true with isSymlink=false` (`:1131`) | `expect(caught).toBeUndefined()` | binds the result and asserts `expect(result).toBe(false)` |
| `Given ok=true with isSymlink=true` (`:1151`) | *"Then throws PERMISSION_DENIED"* | *"Then reports a symlink leaf"* — `expect(result).toBe(true)` |
| `Given ok=false with ENOENT error` (`:1167`) | `expect(caught).toBeUndefined()` | `expect(result).toBe(false)` |
| `Given ok=false with EACCES` (`:1185`) | throws `PERMISSION_DENIED` | **unchanged** — the errno arm is untouched |
| `Given ok=false with non-errno throwable` (`:1201`) | `expect(caught).toBe(original)` | **unchanged** |

The first three lose their `try/catch` scaffolding; the last two keep theirs. Keep the AAA section
comments and the existing `Given` wording where the arrangement did not move — the file's comment
at `:1136–1139` explaining why `try/catch` beats `not.toThrow()` applies only to the rows that
still catch, so it moves with them.

⚠️ **One stale reference outside those rows:** an explanatory comment at
`node-file-system-injected.test.ts:2224` names `interpretCreationLstat` in prose. Update the name;
`command grep -n interpretCreationLstat src test` finds every site (there are exactly nine today,
across three files).

**The four DI rows — design §8h(a) 17–20**, in
`test/unit/adapters/node/node-file-system-injected.test.ts`. Their natural home is
`describe('NodeFileSystem — W2 leaf no-follow composition (DI)')` (`:2250`), whose `Given a
contained target` (`:2258`) already holds `When write is called` (`:2259`), `When writeUtf8`
(`:2280`), `When writeExclusive is called` (`:2302`, the single existing row) and `When appendUtf8`
(`:2323`); the suite-local flag constants `WRITE_CREATE_FLAGS` / `WRITE_EXCLUSIVE_FLAGS` /
`APPEND_FLAGS` are at `:2251–2256`. The Windows symlink pair at `:2419–2469` is the shape to copy
for the lstat fake: `const lstat = vi.fn().mockResolvedValue({ isSymbolicLink: () => true });`.

| # | Given | Then | Kills |
|---|---|---|---|
| 17 | `windowsPolicy`, `writeExclusive`, a symlink leaf | `FILE_EXISTS` carrying the **requested** path; `writeFile` **never** called | the verdict swap itself |
| 18 | `windowsPolicy`, `writeExclusive`, a non-symlink leaf | `writeFile` called with `{ flag: WRITE_EXCLUSIVE_FLAGS }` | the "always refuse" mutant |
| 19 | `windowsPolicy`, `write`, a symlink leaf | still `PERMISSION_DENIED` | the pair that must not collapse — this is the row that fails if `assertLeafSafeToWrite` is given the new verdict by mistake |
| 20 | `posixPolicy`, `writeExclusive` over a symlink leaf, with the fake `writeFile` rejecting `EEXIST` | `FILE_EXISTS` **and `lstat` never called at all** | the forced-**false** `honoursNoFollow` gate in the new assert, which is outcome-equivalent on POSIX and observable only by call count |

Row 19 already has a near-twin at `:2419–2447` (`write` + Windows symlink leaf →
`PERMISSION_DENIED`, `writeFile` not called). Extend or neighbour it rather than duplicating it
wholesale, and keep its assertion that the refusal happens **before** any write.

**Coverage note.** `assertExclusiveCreateLeaf` has two branches (`honoursNoFollow` true → return;
false → classify) and `creationLeafIsSymlink` inherits `assertLeafSafeToWrite`'s existing coverage.
Rows 17/18 take the false arm, row 20 the true arm — both are needed for the 100 % branch gate on
`src/adapters/node/**`.

**Escalate, do not improvise**, if `chmod`'s or the four non-exclusive surfaces' behaviour moves in
any row, or if a POSIX row's error code changes: this part must be a no-op on POSIX for every
surface except the error *name* on the exclusive path, which POSIX already produced.

### TDD steps

- **RED 1.** DI row 17: `windowsPolicy`, `writeExclusive`, `lstat` reporting a symlink leaf.
  Compiles today, fails on the code — `caught.data.code` is `PERMISSION_DENIED`, not `FILE_EXISTS`.
- **RED 2.** DI row 20: `posixPolicy`, `writeExclusive` over a symlink leaf with `writeFile`
  rejecting `EEXIST`, asserting `FILE_EXISTS` **and `lstat` never called**. Passes on the code and
  the call count today (POSIX already skips the guard) — it is the mutant killer for the new gate,
  so write it, watch it pass, and keep it. State this honestly rather than pretending a RED.
- **RED 3.** Flip the existing `Given ok=true with isSymlink=true` row (`:1151`) to expect a
  returned `true`. Fails today: the function returns `void` and throws.
- **GREEN.** Rename `interpretCreationLstat` → `isCreationLeafSymlink` and change its symlink arm
  from `throw permissionDenied(path)` to `return true` (and its two no-op arms to `return false`);
  add `creationLeafIsSymlink`; rewrite `assertLeafSafeToWrite` as the one-line `if (…) throw
  permissionDenied(path)`; add `assertExclusiveCreateLeaf`; swap `writeExclusive`'s call. Update
  the import at `node-file-system.test.ts:8` and the prose at `injected:2224`.
- **Then** rows 18 and 19, and the two remaining flipped rows (`:1131`, `:1167`).
- **REFACTOR.** Nothing merges into anything: `assertWritableLeaf` and `assertExclusiveCreateLeaf`
  read the same flag with opposite polarity on purpose, and collapsing them into one
  verdict-parameterised helper is precisely the shape §8f rejects.
- **Re-measure the two size gates** if Part 6 did not already raise the cap (DC-W3): `rm -rf dist
  .wireit`, `npm run check:tarball`, `npm run check:size`. This part adds roughly two small methods
  and no JSDoc, so it is the less likely of the two to trip it — but 415 B is 415 B, and the
  measurement is cheap next to a red push.

### Gate

```
npx vitest run test/unit/adapters/node/node-file-system.test.ts test/unit/adapters/node/node-file-system-injected.test.ts
npx vitest run --project unit
npm run check:types
npx tsc --noEmit -p tsconfig.json
./node_modules/.bin/biome check src/adapters/node/node-file-system.ts test/unit/adapters/node/node-file-system.test.ts test/unit/adapters/node/node-file-system-injected.test.ts
npm run check:spelling
npx cspell --no-progress src/adapters/node/node-file-system.ts test/unit/adapters/node/node-file-system.test.ts test/unit/adapters/node/node-file-system-injected.test.ts
npm run test:posix-integration
npm run docs:json && git diff --stat -- reports/api.json
rm -rf dist .wireit && npm run check:tarball && npm run check:size
```

`npm run docs:json` must show **no** diff here: this part changes no doc comment on a published
symbol, and `interpretCreationLstat` is `@internal` (typedoc's `excludeInternal` is on, and the
name appears zero times in `reports/api.json` today). A diff means the rename escaped into the
public surface — investigate before committing. `npm run test:posix-integration` re-runs the
symlink write rows Part 1 pinned; `write` over a live or dangling symlink must still be
`PERMISSION_DENIED` on POSIX.

### Commit

```
fix(node-fs): refuse a symlink leaf on exclusive create with FILE_EXISTS
```

---

## Part 8 — The shared contract asserts exact refusal codes, and the root-rename row names its axis

### Context

**This part changes no production code.** It converts four tolerant cross-adapter rows into strict
ones and fixes one latently-red POSIX row. It implements design **§8h(c)**, **§8h(d)**, **§5**,
requirements **R25** and **R46**, and ADRs **824** and **821**. It must run **after** Parts 6 and 7,
because two of the four codes only became true on Windows there.

🔴 **Be honest about what this part proves locally: almost nothing.** On darwin every one of these
rows already passes with the exact code, on **both** drivers — that is precisely why the tolerance
was hiding a wrong code rather than a missing one. The strictness has two real effects and both are
**CI-only**: a Windows regression in Part 6's emulation now turns a *shared* row red on every push
instead of staying confined to the `win-integration` job, and the root-rename pair stops the
`posix-integration` **ubuntu** cell from going red the moment Part 6 turns the unit job green.
Do not manufacture a local RED; do run the deliberate assertion-bite probe below.

**Files.**

| Action | Path | What |
|---|---|---|
| edit | `test/unit/ports/file-system.contract.ts` | add `assertDirectoryNotEmpty`; re-point four call sites; delete `assertRefusedWithoutCode` with its comment |
| edit | `test/integration/posix-only/node-fs-write-rename-refusals.test.ts` | the root-rename row at `:287–300` becomes an enumerated pair with non-destructiveness and an axis comment |

**The helper edit, exactly.** `file-system.contract.ts` is 1 101 lines; all five assertion helpers
are **module-private** (`:78`, `:83`, `:88`, `:93`, `:105`) and nothing outside the file references
them. Add the new sibling in the same three-line shape, after `assertNotADirectory` closes at
`:96`:

```ts
function assertDirectoryNotEmpty(err: unknown): void {
  expect(err).toBeInstanceOf(TsgitError);
  expect((err as TsgitError).data.code).toBe('DIRECTORY_NOT_EMPTY');
}
```

Then re-point the four call sites and delete `assertRefusedWithoutCode` — **lines 97–107
inclusive**, the blank separator, the six-line JSDoc (`:98–104`) and the three-line body
(`:105–107`). An uncalled helper is dead code, and `tsconfig.json`'s `noUnusedLocals` will say so
anyway.

| Row (1-level `it`) | Assertion line | Today | After | Why that code |
|---|---|---|---|---|
| *Given a directory at the target path, When write, Then it refuses and the directory is intact* (`:260–281`) | `:277` | `assertRefusedWithoutCode` | **`assertPermissionDenied`** | node agrees on all three OS; memory produces it from Part 3's leaf guard |
| *Given a directory at the destination, When rename, Then it refuses and neither side moves* (`:423–444`) | `:441` | idem | **`assertPermissionDenied`** | a non-directory source onto a directory destination — node agrees on all three OS |
| *Given a directory source and a file destination, When rename, Then it refuses and neither side moves* (`:446–468`) | `:465` | idem | **`assertNotADirectory`** | the row Windows used to **replace**; Part 6 refuses it |
| *Given a directory source and a non-empty directory destination, When rename, Then it refuses and neither tree merges* (`:470–492`) | `:487` | idem | **`assertDirectoryNotEmpty`** | the row Windows used to refuse with the *wrong* code; Part 6 re-codes it |

**Nothing else in those four rows moves** — not the arrangement, not the non-destructiveness
assertions each already carries inline (`:278–280`, `:442–443`, `:466–467`, `:488–491`), not the
titles. And **no row is added, moved or removed**: the two rows the design calls `:446` and `:494`
keep their arrangements and assertions verbatim (**R45**); `:494` is the positive
empty-directory-replacement row and is not touched at all.

**The tolerant `mkdir` row stays tolerant** — it is now at **`:762–781`**, not `:567` as the design
says, and it is a genuine adapter disagreement (node `FILE_EXISTS` from its own `mkdir -p`'s
`EEXIST`, memory `NOT_A_DIRECTORY` from `addDirectoryRecursive`). Leave it. Its `:775–780` is the
**enumerated-pair shape** the posix-only fix copies:

```ts
      // Assert — exact code is platform-dependent (…)
      expect(caught).toBeInstanceOf(TsgitError);
      const code = (caught as TsgitError).data.code;
      expect(['FILE_EXISTS', 'NOT_A_DIRECTORY']).toContain(code);
```

The second tolerant precedent (*Given non-empty directory, When rm, Then throws a TsgitError*,
`:871–887`) is instance-only and also stays: different method, genuinely disagreeing adapters.

**The posix-only row, exactly.** `test/integration/posix-only/node-fs-write-rename-refusals.test.ts`
is 636 lines, 2-level Given/When → Then, with `env` from a `beforeEach`-built `mkdtemp` +
`realpath` root (`:26–39`, `:65–71`) and two local helpers: `captureError` (`:42–49`) and
`dataFor<Code>` (`:52–60`). The target block is `:287–300`:

```ts
  describe('Given a file renamed onto the containment root, When rename', () => {
    it('Then throws PERMISSION_DENIED', async () => {
      // Arrange
      const sut = env.fs;
      const src = nodePath.join(env.rootDir, 'r4-file');
      await fsPromises.writeFile(src, 'r4');

      // Act
      const caught = await captureError(() => sut.rename(src, env.rootDir));

      // Assert
      expect(dataFor(caught, 'PERMISSION_DENIED').path).toBe(src);
    });
  });
```

**Why it is red on ubuntu and not here:** darwin answers `EISDIR` → `PERMISSION_DENIED`, ubuntu
answers `ENOTEMPTY` → `DIRECTORY_NOT_EMPTY`. Both are legal `rename(2)` outcomes; POSIX does not
order the two checks. The axis is **not** emptiness — a file onto a *sibling* non-empty directory is
`PERMISSION_DENIED` on both, and a *directory* onto an ancestor is `DIRECTORY_NOT_EMPTY` on both.
The only splitting arrangement is a **non-directory source whose destination is one of its own
ancestors**. This was measured red by a direct ubuntu run of the file: 32 rows pass, this one fails
with `expected 'DIRECTORY_NOT_EMPTY' to be 'PERMISSION_DENIED'`, and nothing else moves. The row has
never executed on that cell because `posix-integration` `needs: [changes, unit-tests]` and
`unit-tests` has been red on the three Windows cells.

**The rewrite** (ADR-821, **R46**): retitle to name both codes, assert the enumerated pair plus
non-destructiveness, and carry a comment naming the axis so the next reader does not "fix" it back
to one code. ⚠️ **`dataFor` cannot be reused** — it hard-pins one code (`expect(data.code).toBe(code)`)
— so this row uses the contract file's manual shape instead, and it will be the **first**
`toContain`-style enumerated assertion in this file. Non-destructiveness: the source still reads
back its bytes, and the root still lists it. Two in-file precedents for an explanatory `// Arrange —`
comment sit at `:494–497` and `:515–518`; the sibling row that already expects
`DIRECTORY_NOT_EMPTY` for a *directory* source onto the root is at `:410–424`, and the three
`PERMISSION_DENIED` sibling rows are at `:233–248`, `:250–266`, `:268–285` — none of them changes.

**Do not** add a `process.platform` branch (a conditional oracle inside a test, with a new arm for
every future POSIX platform) and **do not** swap the arrangement for a sibling non-empty directory
— that loses the containment-root arrangement this whole design exists to close. Both alternatives
were weighed and rejected in ADR-821.

**Escalate** if any of the four contract rows fails on either driver on darwin after the swap. That
would mean Part 6 or an earlier part produced a different code than the design's table, and the fix
is in the adapter, not in the assertion.

### TDD steps

- **RED (proof-of-bite, not committed).** Before swapping a call site, temporarily change the new
  `assertDirectoryNotEmpty`'s expected code to `'FILE_EXISTS'` and run the contract suite: the
  directory-onto-non-empty-directory row must fail on **both** drivers. Revert immediately. This is
  how a strictness change earns a red — the row itself cannot produce one on this host.
- **GREEN, one call site at a time.** Add the helper, swap `:277`, run; swap `:441`, run; swap
  `:465`, run; swap `:487`, run. Four separate runs, because a wrong expectation on one row is
  invisible under three greens.
- **Delete `assertRefusedWithoutCode`** only after the last call site is gone, then re-run:
  `noUnusedLocals` and the suite must both be clean. Its `:97–107` is a *today* number — inserting
  the new sibling above it shifts every line below by the size of that block, so match on the
  helper's name and its JSDoc text, not on the line range.
- **The posix-only row.** Rewrite `:287–300`, run `npm run test:posix-integration` on darwin, and
  confirm it still passes — on this host it takes the `PERMISSION_DENIED` half of the pair, so a
  local green proves the row compiles and the arrangement is unchanged, and **nothing about the
  ubuntu half**. Say so; do not claim the fix is verified until the CI cell reports.
- **REFACTOR.** None available and none wanted: the four assertion helpers are three lines each by
  design and a shared parameterised asserter would make each row's expectation harder to read at
  the call site, which is the only place it matters.

### Gate

```
npx vitest run test/unit/adapters/memory/memory-file-system.test.ts test/unit/adapters/node/node-file-system.test.ts
npx vitest run --project unit
npm run test:posix-integration
npm run check:types
npx tsc --noEmit -p tsconfig.json
./node_modules/.bin/biome check test/unit/ports/file-system.contract.ts test/integration/posix-only/node-fs-write-rename-refusals.test.ts
npm run check:spelling
npx cspell --no-progress test/unit/ports/file-system.contract.ts test/integration/posix-only/node-fs-write-rename-refusals.test.ts
node --experimental-strip-types tooling/audit-test-pyramid.ts
```

The contract file is **not** a `*.test.ts` and must never be passed to `vitest run` as a filter —
it collects zero tests and exits non-zero. It is driven by **both** adapters, and those two driver
files are what the first line runs: `memory-file-system.test.ts:7–24` and
`node-file-system.test.ts:63–96` — running either alone proves half the change. The
`--project unit` run covers both. `reports/api.json` cannot move here (no `src/` delta) and no size
gate is affected.

### Commit

```
test(fs-contract): assert exact codes on write and rename refusals
```

---

## Part 9 — Pin the emulated rename rules against real NTFS in a win-only suite

### Context

**This part changes no production code and cannot be executed on this host.** It creates the
real-filesystem Windows mirror of Part 1's posix-only file: the strict codes through the *composed*
adapter against a real NTFS volume, which is the only place Part 6's and Part 7's emulation meets
the platform it was written for. It implements design **§8h(b)**, requirements **R44**, **R49**,
**R50**, and ADR **822**.

**Files.**

| Action | Path | What |
|---|---|---|
| create | `test/integration/win-only/node-fs-windows-rename-refusals.test.ts` | the whole part |

**Where the file lives and who runs it.** `vitest.config.ts:61–66` defines the `win-integration`
project as `include: ['test/integration/win-only/**/*.test.ts']`; the `integration` project
**explicitly excludes** that directory (`:47`). `package.json`'s `test:win-integration` is
`vitest run --project win-integration` (depends on `check:types`). CI runs it in its own
single-runner `win-integration` job on `windows-latest` (`ci.yml:417–433`, `needs: [changes,
unit-tests]`). `npm run validate` does **not** depend on it. The directory holds exactly two files
today — `node-fs-windows-real.test.ts` (103 lines, the pattern) and
`openrepository-windows-paths.test.ts`.

🔴 **The honest local gate: type-check, lint and spelling only.** Running
`npx vitest run --project win-integration <file>` on darwin does **not** skip it — the tier has no
platform guard; placement plus the CI job *is* the guard, exactly as the sibling file's own header
says. On darwin the file will **execute and fail**, at minimum on the two ancestor-fault rows that
are deliberately pinned in their **Windows** shapes (`NOT_A_DIRECTORY` carrying **src** where POSIX
carries `dst`; `FILE_NOT_FOUND` where POSIX says `NOT_A_DIRECTORY`). That failure is the file being
correct, not broken. **A local run reporting "0 tests" or "skipped" would be the real problem** — it
would mean the file is not in the project's include glob. The executing gate is CI's
`win-integration` job: push early, read that job, and do not merge on a run where it has not
executed.

**Header — the directory's convention, from `node-fs-windows-real.test.ts:1–11`:** a block comment
saying *why the case is platform-bound*, then a `@proves` block:

```
 * @proves
 *   surface: nodeFs.windowsRenameRefusals
 *   bucket:  platform-only
 *   unique:  <one sentence, 12–200 chars — e.g. the POSIX rename kind rules the node adapter emulates on NTFS>
```

`surface` must match `^[a-z][a-zA-Z0-9.-]{1,40}$`; `bucket: platform-only` is one of the seven
allowed buckets and its `directoryRules` admit `win-only/`. The `integrationProof` heuristic is
**report-only** — write it correctly anyway.

**Tier constraints that *are* gated:** `gwtTitle`, `aaaBody`, `sutNaming`, `sutBindsResult`,
`bareClassToThrow`, `emptyAaaSection` and `underAssertedUnit`. `overMockedIntegration` has a
threshold of **0** — **no `vi.mock` / `vi.fn` / `vi.spyOn` / `vi.stubGlobal` / `vi.stubEnv`
anywhere in the file**, and `vitest`'s import is `{ describe, expect, it }` only.

**Fixture.** The sibling win-only file builds its root **inline per `it`** with a `try/finally`
cleanup and no `realpath`. This file does **not** copy that: it uses the `beforeEach`/`afterEach`
`makeFs()` shape of its posix-only mirror (`node-fs-write-rename-refusals.test.ts:26–39`,
`:62–71`), with `mkdtemp` **followed by `realpath`**, because these rows plant multi-entry
arrangements and assert `data.path` against paths built from the root — and 8.3 short-name
reconciliation is already pinned by the neighbouring file, so it is not what these rows are about.
Copy `captureError` (`:42–49`) and `dataFor<Code>` (`:52–60`) from that same file verbatim;
`check:duplicates` is `jscpd src/` and never scans `test/`.

**Symlink rows are guarded by the directory's own probe.** Copy `canCreateSymlinks()` from
`node-fs-windows-real.test.ts:20–40` verbatim (it makes its own `mkdtemp` probe root, tries one
`fsPromises.symlink`, and cleans up), and guard every symlink row with the honest skip at
`:69–76` — `it('Then …', async ({ skip }) => { if (!(await canCreateSymlinks())) { skip(); return; } … })`,
with `skip` destructured from the test context, never imported. Symlink creation **did** succeed on
the hosted `windows-latest` runner when the matrices were probed, so the skip should not fire — it
exists so a runner image change shows as *skipped*, not as silently green.

⚠️ **Every path expectation in this file is built with `node:path`.** The adapter reports **joined**
paths and `pathPolicy.join` is `path.win32.join` there, so a `/`-spelled literal fails against a
correct implementation. Any predicate on `readlink` output normalises separators before matching
(**R49**).

**The rows. Copy these expected codes — do not re-derive them.** Every refusal asserts
`caught instanceof TsgitError` **and** `data.code`, and `data.path` where the variant carries one;
`UNSUPPORTED_OPERATION` carries `operation` and `reason` and **no `path`**.

*Refusals (`data.path` = **`src`** unless the row says otherwise):*

| `src` | `dst` | Code | Also assert |
|---|---|---|---|
| empty directory | regular file | `NOT_A_DIRECTORY` | the destination file's bytes are byte-identical |
| directory with a child | regular file | `NOT_A_DIRECTORY` | the child is still under `src` |
| directory | symlink | `NOT_A_DIRECTORY` | the link's target is intact |
| empty directory | non-empty directory | `DIRECTORY_NOT_EMPTY` | neither tree merged |
| directory with a child | non-empty directory | `DIRECTORY_NOT_EMPTY` | each tree holds exactly its own child |
| directory | its own **parent** | `DIRECTORY_NOT_EMPTY` | nothing moved |
| directory with a child | the containment **root** | `DIRECTORY_NOT_EMPTY` | nothing moved |
| file | empty directory | `PERMISSION_DENIED` | unchanged behaviour, pinned so a regression shows |
| file | directory with children | `PERMISSION_DENIED` | idem |
| symlink | empty directory | `PERMISSION_DENIED` | idem |
| file | the containment **root** | `PERMISSION_DENIED` | **the Windows shape — a single code here**, unlike the POSIX file's enumerated pair (Part 8): Windows and darwin agree, ubuntu is the outlier |
| directory | a path **inside itself** that is absent | `UNSUPPORTED_OPERATION`, `operation: 'filesystem'`, `reason` = `INVALID-ARGUMENT`, **no `path`** | — |
| directory | a path inside itself that is an existing **directory** | same | and the inner directory still exists — the row that proves the containment arm delegated instead of taking the replace arm |
| directory | a path inside itself that is an existing **file** | same | the file's bytes intact |
| the containment **root** | a fresh name inside it | same | — |
| file | dst whose **grandparent** is a regular file | `NOT_A_DIRECTORY`, `data.path` = **`src`** 🔴 | the first Windows-shaped oddity — the POSIX sibling carries `dst` on this arrangement |
| src whose **immediate parent** is a regular file | fresh name | **`FILE_NOT_FOUND`** 🔴 | the second Windows-shaped oddity — POSIX refuses `NOT_A_DIRECTORY`; **only the code differs**, the path is the same one the POSIX sibling carries |

⚠️ **For those last two rows, take the `data.path` expectation from the committed POSIX row, not
from a table.** Part 1's file already pins all three ancestor-fault arrangements, and their titles
say what they anchor on: *"Given a file renamed onto a destination whose **immediate parent** is a
regular file … Then throws `FILE_EXISTS` anchored on `src`"* (unchanged on Windows — do **not** add
a win-only row for it, §8d says it keeps its shape), *"… whose **grandparent** is a regular file …
Then throws `NOT_A_DIRECTORY` anchored on `dst`"* (the code stays, the anchor flips to **`src`** on
Windows), and *"Given a **source** whose immediate parent is a regular file renamed onto a fresh
name … Then throws `NOT_A_DIRECTORY` anchored on `src`"* (the anchor is what §8a leaves alone, the
**code** becomes `FILE_NOT_FOUND`). §8a's probe table writes that last row's path in the harness's
own notation, which does not line up with the committed row's — so mirror the **committed** row's
path expression through `node:path`, change only the one field §8a says changes, and **escalate**
`{ part, reason, ≤3 options }` if the `win-integration` job reports a third shape. Do not guess
between two disagreeing tables.

*Positives (assert the outcome, no code):*

| `src` | `dst` | Outcome |
|---|---|---|
| directory with a child | **empty** directory | succeeds — the child is reachable under `dst`, `src` is gone. **This is the row the whole leg exists for** |
| regular file | itself | succeeds, bytes unchanged |
| directory with children | itself | succeeds, every child still reachable |
| directory | a fresh name | succeeds, the whole subtree moves |
| empty directory | a fresh name | succeeds |

*Exclusive create and the non-exclusive pair — the two verdicts pinned apart on the platform where
they used to differ (**R44**):*

| Arrangement | Code | Also assert |
|---|---|---|
| `writeExclusive` over a **live** symlink | `FILE_EXISTS`, `path` = requested | the link still points where it did |
| `writeExclusive` over a **dangling** symlink | `FILE_EXISTS`, `path` = requested | 🔴 **the link's target is still absent** — the half the platform's own exclusive open gets wrong (it would follow the link and create the target) |
| `write` over a **live** symlink | `PERMISSION_DENIED`, `path` = requested | — |
| `write` over a **dangling** symlink | `PERMISSION_DENIED`, `path` = requested | the target is still absent |

Plant a dangling link exactly as the posix-only file does:
`fsPromises.symlink(nodePath.join(rootDir, 'missing-target'), link)`.

**If a row disagrees with this table on the `win-integration` job**, that is a matrix disagreement
or an emulation defect, not a test bug. Escalate `{ part, reason, ≤3 options }`. Do **not** weaken
an assertion, do **not** delete a row, and do **not** "fix" the two Windows-shaped oddities into
their POSIX shapes — pinning them as they are is the whole of **R49**.

### TDD steps

This part characterises behaviour created two parts earlier on a platform this host is not, so its
RED/GREEN cycle lives on CI. Locally the loop is compile-and-read.

- **RED (CI, and it is the point of the part).** The refusal rows for a directory source onto a
  file, a symlink and a non-empty directory, and the empty-directory positive, are **exactly** the
  arrangements that were red or wrongly-coded on `windows-latest` before Part 6. If the
  `win-integration` job is green on the first push, re-read the job log and confirm the file
  actually ran (row count, not just exit code) before believing it.
- **Write the file in blocks and type-check after each** — refusals first, then positives, then the
  exclusive-create and write pair. `npx tsc --noEmit -p tsconfig.json` is the only mechanical
  feedback available on darwin, and it does catch the two real local failure modes: a `data.path`
  read without narrowing (use `dataFor`) and a wrong helper import path (`../../../src/...`).
- **Prove the header parses:** `node --experimental-strip-types tooling/audit-test-pyramid.ts` and
  read the `integrationProof` line in its report — it is report-only, so the exit code says
  nothing.
- **Do not run the file locally to "check it works."** It will fail on the two Windows-shaped
  ancestor rows by construction (§Context). If you run it anyway to inspect, expect exactly those
  failures and treat any *other* failure as information worth escalating.
- **REFACTOR.** Group by occupant with a `describe('Given …')` per arrangement family and a shared
  `beforeEach`-built root, as the posix-only file does. Do not collapse rows whose oracle shape
  differs — the `UNSUPPORTED_OPERATION` rows assert different fields from the path-carrying ones and
  stay separate.

### Gate

```
npm run check:types
npx tsc --noEmit -p tsconfig.json
./node_modules/.bin/biome check test/integration/win-only/node-fs-windows-rename-refusals.test.ts
npm run check:spelling
npx cspell --no-progress test/integration/win-only/node-fs-windows-rename-refusals.test.ts
node --experimental-strip-types tooling/audit-test-pyramid.ts
npm run check:filesystem
```

**That is the whole local gate, and it is a compile gate.** There is no `npx vitest run` line here
on purpose: on darwin the only outcomes are "fails as designed" or "0 tests collected", and neither
is a pass. `check:filesystem` is `ls-lint` — the new file name must be kebab-case, which is the one
mechanical thing a *new file* can get wrong here. `npm run validate` is **not** part of any part's
gate; it is the orchestrator's phase gate after this part, and it does not run this file either.
The executing gate is CI's `win-integration` job on `windows-latest`.

### Commit

```
test(node-fs): pin the emulated rename kind rules against real NTFS
```

---

## After the last part — the orchestrator's checks

These cover the **whole** PR: Parts 1–5 (the memory and browser adapters) and Parts 6–9 (the
Windows leg).

1. **`npm run validate`**, run **bare** into a file, exit code read from that file — never through
   a pipe. It gates `test:coverage` (100 % on `src/domain/**`, `src/ports/**`,
   `src/adapters/node/**`, `src/adapters/memory/**`, `src/operators/**`), `check:test-pyramid`,
   `check:duplicates`, `check:dead-code`, `check:architecture`, `check:spelling`, `check:size`,
   `check:tarball` and the rest. Note the coverage set now includes `src/adapters/node/**`: every
   branch of `planRename`, `lstatOrMissing` and `assertExclusiveCreateLeaf` is reached **only**
   through the DI rows of Parts 6 and 7.
2. **`npm run test:posix-integration`** — not in `validate`. It runs Part 1's file with Part 8's
   root-rename fix. A green run on darwin proves the file compiles and the darwin half of the
   enumerated pair; the **ubuntu** half is CI-only and is the half that was actually broken.
3. **`npm run test:e2e`** — not in `validate`; the browser tier's only proof (Part 5). Requires
   `npm run build` first and `npx playwright install` as a prerequisite.
4. **`npm run docs:json && git diff --exit-code -- reports/api.json`** — the prepush gate local
   `validate` does not run. Parts 2, 3, 4 and 6 each regenerated it; this is the check that the
   committed report matches the final tree.
5. **Both size budgets, from a clean build.** `rm -rf dist .wireit`, then `npm run build`, then
   `npm run check:tarball` and `npm run check:size`. A stale chunk has produced a false failure
   here before. If the cap was raised, confirm the paragraph in `tooling/verify-tarball.sh`'s
   header records the **measured** figure, not an estimate.
6. **`npm outdated`** is re-measured before the full gate (eight excepted packages,
   `.claude/workflow.md`).
7. **Read the CI matrix before merging — three jobs carry proof this host cannot produce.**
   - the **three `windows-latest` unit cells**: the two shared contract rows that were red are the
     reason the Windows leg exists, and Part 8's four newly-strict rows now run there too. A red
     row here is a defect in Part 6 or Part 7, never a licence to loosen an assertion.
   - the **`posix-integration` ubuntu cell**: it has *never executed* Part 1's file, because the job
     `needs: unit-tests` and that job has been red. Part 8's enumerated pair is what makes it pass.
      Confirm the job ran, not merely that it is not red.
   - the **`win-integration` job**: Part 9's file exists only for this job. Confirm it collected
     rows, not zero.
8. **The mutation gate is unit-only and runs on linux**, so every mutant in the Windows arm is
   killable only through Parts 6 and 7's DI rows. A survivor there is a real survivor and gets a
   kill test — this plan sanctions **no** `Stryker disable` directive anywhere in the leg, and the
   two equivalences it did find (DC-W1's dead line, DC-W4's unisolatable disjuncts) are answered by
   deleting the line and by fabricating the stat, not by suppressing the mutant.
