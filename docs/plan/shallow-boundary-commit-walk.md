# Plan — shallow-boundary commit walk (grafted parents)

> Source: design doc `docs/design/shallow-boundary-commit-walk.md` · ADRs 542, 543, 544, 545, 546, 547
> The plan is the implementation script AND the knowledge handoff. Part agents start
> with zero context: whatever a part block omits is paid later as agent rediscovery.
> `plan-lint.sh` enforces the schema below — the plan phase cannot close without it.

## Sizing rules

- Every part costs a full agent lifecycle (spin-up, zero-context rebuild, gate) — it
  must earn it. No standalone test-only parts for FEATURE code: coverage/interop/property
  tests fold into the implementation part whose code they exercise. EXCEPTION:
  test-infra-only and docs-only parts (tooling config, test helpers, fixtures,
  harness/ADV/property suites, docs/prose) with no `src/` delta ARE standalone — they
  have no implementation part to fold into.
- A part that would be a pure test pass over already-landed code merges into its
  neighbour.

## Repo-wide invariants every part must honour

- **Serena is ALREADY ACTIVATED** for this worktree (project `tsgit-shallow-boundary-commit-walk`).
  Do **not** call `activate_project`. Use `find_symbol` / `find_referencing_symbols` /
  `replace_symbol_body` / `insert_after_symbol` as the default for TypeScript navigation
  and editing; `Read`/`Grep` only for markdown/JSON/generated artefacts.
- **No suppression directives** (`@ts-ignore`, `biome-ignore`, `v8 ignore`,
  `stryker-disable` other than a *proven*-equivalent `Stryker disable next-line`
  anchored on the expression line with a written proof).
- **No provenance refs** (ADR numbers, part numbers, backlog ids) inside `src/` or `test/`.
- **Coverage gate is 100% on `src/domain/**`** (`vitest.config.ts` `coverage.include`).
  `src/domain/commit/graft.ts` (Part 2) must be 100% line/branch/function/statement or
  `npm run test:coverage` goes red. `src/application/**` is *not* in the coverage gate
  but *is* in the Stryker mutation set.
- **knip (`npm run check:dead-code`) flags unused `src/` exports** (`project: src/**/*.ts`,
  `ignoreExportsUsedInFile: true`). Never land an exported symbol whose consumer arrives
  in a later part — each part ships its own consumers.
- **dependency-cruiser `no-circular` is `severity: error`** (`.dependency-cruiser.cjs`).
  The parser/memo/writer split below exists precisely to avoid a
  `shallow-file.ts ↔ shallow-set.ts` cycle. Do not collapse it.
- **Test conventions are machine-gated** (`npm run check:test-pyramid`, gating keys
  `gwtTitle`, `aaaBody`, `sutNaming`, `bareClassToThrow`, `emptyAaaSection`,
  `sutBindsResult`, `underAssertedUnit`): `describe('Given …')` > `describe('When …')` >
  `it('Then …')`; every `it` body carries `// Arrange` and `// Assert` comment markers
  and ≥1 `expect`; `sut` names the **function under test**, never a result (results go in
  `result`); never `toThrow(SomeClass)` alone — assert `err.data.code` plus the payload.
- **Interop discipline** (`test/integration/interop-helpers.ts` already implements it):
  `runGit` / `git(dir, …)` spawn git with every `GIT_*` scrubbed, `HOME` pointed at a
  never-created path under `os.tmpdir()`, `GIT_CONFIG_NOSYSTEM=1`, `XDG_CONFIG_HOME`
  redirected — commits sign off by default because no config is readable. `runGitEnv()`
  returns that env for spreading when a test needs deterministic `GIT_AUTHOR_*` /
  `GIT_COMMITTER_*`. `tryRunGitWithExit` returns `{stdout, stderr, exitCode}` without
  throwing — use it for every co-refusal assertion (git `fatal:` ⇒ exit 128).
- **Interop hook timeout**: the default vitest `hookTimeout` is 10 s and git-spawning
  `beforeAll` blocks trip it under `validate` concurrency. Every interop suite here uses
  a **single shared** `beforeAll(async () => { … }, 60_000)`.
- **Per-`Context` caches**: `read-object.ts` `registryCache`, `read-commit-graph.ts`
  `graphCache`/`headerCache`, `internal/loose-oid-cache.ts` `fanoutCache`, and (new here)
  the shallow-set memo are all keyed by `Context`. Any tsgit `Context` used in an interop
  test **must be constructed after the last `git` subprocess write** to that repo.

---

## Part 1 — Strict `.git/shallow` grammar, refusal code, entry cap

### Context

Discharges pinned-matrix rows **D1–D13** and the §7 unbounded-shallow-set threat.
Implements **ADR-545**. No walk behaviour changes in this part.

**Current state — `src/application/primitives/shallow-file.ts` (119 lines).**

```ts
const SHALLOW_FILE = 'shallow';
const SHALLOW_LOCK = 'shallow.lock';
const shallowPath = (ctx: Context): string => `${commonGitDir(ctx)}/${SHALLOW_FILE}`;
const shallowLockPath = (ctx: Context): string => `${commonGitDir(ctx)}/${SHALLOW_LOCK}`;

export const readShallow = async (ctx: Context): Promise<ReadonlySet<ObjectId>>   // lines 44–61
export const updateShallow = async (ctx: Context, updates: ShallowUpdate): Promise<void> // 76–90
const SHA_ANY_RE = /^[0-9a-f]{40}([0-9a-f]{24})?$/i;   // line 63
const isShallowOid = (s: string): boolean => SHA_ANY_RE.test(s);
```

`readShallow` today: splits on `\n`, `.trim()`s each line, `continue`s on blank, `continue`s
on `!isShallowOid(trimmed)`, `out.add(OID.from(trimmed))`. Its doc comment (lines 40–42)
claims *"Malformed lines are tolerated (skipped) — canonical git behaves the same"* — **that
claim is false** and must be deleted.

**Pinned git behaviour to reproduce (design §1 table D).** git reads the file with its
LF-stripping line reader and validates the **first 40 characters** of each line as hex:

| Row | File content | Required result |
|---|---|---|
| D1 | absent | empty set, not shallow |
| D2 | 0 bytes | empty set, **is** shallow (presence, Part 2) — **no refusal** |
| D3 | `<40-hex>\n` | one entry |
| D4 | `<40-hex>` (no trailing LF) | one entry |
| D5 | `<40-hex>\r\n` | one entry (`\r` is trailing junk after the 40-hex prefix) |
| D6 | `<40-hex> trailing junk\n` | one entry — **accepted** (prefix parse) |
| D7 | `<UPPERCASE-40-hex>\n` | one entry — accepted, normalised to lowercase |
| D8 | duplicate + unsorted entries | accepted, set semantics |
| D9 | leading / embedded blank line | **refuse** |
| D10 | trailing blank line at EOF (`<oid>\n\n`) | **refuse** |
| D11 | `not-an-oid\n<oid>\n` | **refuse** |
| D12 | 39-hex short line | **refuse** |
| D13 | oid absent from the object store | inert — one entry, no error |

**Line-splitting rule that satisfies D2/D3/D4/D9/D10 simultaneously** (git's line-reader
semantics; derive it exactly, do not hand-roll a different one):

```
raw === ''                 ⇒ zero lines            (D2: 0-byte file, no refusal)
raw.endsWith('\n')         ⇒ raw.slice(0, -1).split('\n')
otherwise                  ⇒ raw.split('\n')
```

Sanity check the rule before coding: `'\n'` ⇒ `['']` ⇒ one blank line ⇒ refuse (matches
git's `fatal: bad shallow line:` on a lone LF); `'<oid>\n'` ⇒ `['<oid>']`; `'<oid>\n\n'` ⇒
`['<oid>', '']` ⇒ refuse. **Do not `.trim()` the line** — a leading space means the first 40
chars are not hex, which git refuses (this flips the existing
`'Given a .git/shallow with a leading-space oid line'` test, see below).

**Per-line rule:** `line.slice(0, 40)` must match `/^[0-9a-fA-F]{40}$/`; anything after
position 40 is ignored. `ObjectId.from` (`src/domain/objects/object-id.ts:4`) enforces
`/^[0-9a-f]{40}$/` **lowercase-only**, so D7 requires `.toLowerCase()` on the 40-char prefix
before `ObjectId.from`.

**New file — `src/application/primitives/internal/parse-shallow.ts`** (pure, no `Context`,
no I/O). This module exists so both the reader (`shallow-file.ts`) and the per-`Context`
memo (`internal/shallow-set.ts`, Part 2) can share one grammar **without** creating the
`shallow-file.ts ↔ shallow-set.ts` import cycle that `no-circular` rejects.

```ts
export const MAX_SHALLOW_ENTRIES = 500_000;            // mirrors MAX_ADVERTISED_REFS
export const parseShallowFile = (raw: string): ReadonlyArray<ObjectId> => …
```

The cap counts **parsed lines** (duplicates included — de-duplication is the caller's `Set`),
enforced while scanning: refuse the moment the count would exceed it, before allocating
further. It is deliberately *not* a byte cap, because a byte cap would need a `stat` and
requirement 8 budgets exactly **one** filesystem probe per `Context`. Record that reasoning in
the module doc comment together with the existing outer bound (the transport's 512 MiB
`maxResponseBytes`). `MAX_SHALLOW_ENTRIES` is exported for the tests to reference by identity
(killing the magic-number mutant); knip's `ignoreExportsUsedInFile: true` keeps it green
because `parse-shallow.ts` also consumes it.

**No new barrel export.** `parseShallowFile` / `MAX_SHALLOW_ENTRIES` stay internal —
`src/application/primitives/index.ts` line 76 keeps exporting only `readShallow` /
`updateShallow`. If a surface test or `check:dead-code` seems to want the new symbols
barrelled, that is the wrong fix — keep them internal.

**Behaviour change to state in the doc comment:** `updateShallow` reads the current set
through `readShallow` (line 77), so a malformed `.git/shallow` now makes a `fetch`-side
update refuse instead of silently rewriting a file whose content git would have died on.
That is the git-faithful direction (D9–D12 are `fatal`, exit 128).

**New error variant — public surface, pre-pay every gate in this part:**

1. `src/domain/error.ts` — add to the `ApplicationError` union (lines 33–58, alongside
   `INVALID_WALK_INPUT` / `PACK_TOO_LARGE`):
   ```ts
   | { readonly code: 'SHALLOW_FILE_MALFORMED'; readonly reason: string; readonly lineNumber: number }
   ```
   plus a factory next to `invalidWalkInput` (line 145):
   ```ts
   export const shallowFileMalformed = (reason: string, lineNumber: number): TsgitError =>
     new TsgitError({ code: 'SHALLOW_FILE_MALFORMED', reason, lineNumber });
   ```
   **Payload decision (make it, do not re-open):** carry `reason` + 1-based `lineNumber`,
   **never the raw line bytes** — `.git/shallow` content is remote-influenced (a fetch
   persists whatever `shallow` pkt-lines the server sends), and `TsgitError`'s message is
   `` `${code}: ${extractDetail(data)}` ``. The line number locates the offending line
   without echoing attacker-chosen bytes into a log.
2. `src/domain/error.ts` `extractDetail` switch (starts line 161) — add a `case`
   returning something like `` `bad shallow file at line ${data.lineNumber}: ${data.reason}` ``.
   The `default` arm's `never` assignment makes this a compile error if you skip it.
3. `test/unit/domain/exhaustiveness.ts` — add `case 'SHALLOW_FILE_MALFORMED':` to
   `assertExhaustiveSwitch` (the ApplicationError block near `case 'SNAPSHOT_REQUIRED':`,
   line 137). **This is a compile-time gate — skipping it reds `check:types`.**
4. `test/unit/domain/error.test.ts` — add the message-shape assertion alongside the existing
   per-code cases (see the `GITIGNORE_FILE_TOO_LARGE` precedent at lines 743 / 1328).
5. `src/application/primitives/validators.ts` — named reason constants beside
   `REASON_WALK_QUEUE_OVERFLOW` (line 24), referenced by identity from tests so
   StringLiteral mutants die at the declaration:
   ```ts
   export const REASON_SHALLOW_BAD_LINE = 'bad shallow line' as const;
   export const REASON_SHALLOW_TOO_MANY_ENTRIES = 'shallow entry count exceeds bound' as const;
   ```
   (`validators.ts` imports only from `./types.js`; `parse-shallow.ts` importing it is
   acyclic.)
6. `reports/api.json` — regenerate with `npm run docs:json` and commit it. The union is
   re-exported publicly, so `check:doc-typedoc` (a **prepush**, not `validate`, gate) fails
   otherwise. The huge typedoc-id diff is normal.
7. `docs/use/errors.md` — add a row in the application-tier table (the block holding
   `INVALID_WALK_INPUT`, line 203): `` | `SHALLOW_FILE_MALFORMED` | `reason, lineNumber` | … | ``.
8. `docs/understand/security.md` — add a row to the "Object & pack size caps" table
   (lines 79–89): `` | `SHALLOW_FILE_MALFORMED` | 500 000 entries (`MAX_SHALLOW_ENTRIES`) | `.git/shallow` reader. | ``.

**Also in this part — move the path helpers to the layout module** so Part 2's memo can
reuse them without importing `shallow-file.ts`:
`src/application/primitives/path-layout.ts` already exports `commonGitDir(ctx)`,
`packedRefsPath(gitDir)`, `commitGraphPath(gitDir)`, … (all `gitDir`-first). Add:
```ts
export const shallowFilePath = (gitDir: string): string => `${gitDir}/shallow`;
export const shallowLockPath = (gitDir: string): string => `${gitDir}/shallow.lock`;
```
and rewrite `shallow-file.ts`'s two local helpers to call them via `commonGitDir(ctx)`.
Delete the now-dead `SHALLOW_FILE` / `SHALLOW_LOCK` consts and `SHA_ANY_RE` /
`isShallowOid`. `commonGitDir` resolution is already correct for linked worktrees
(pins E1–E3) — do **not** change it.

`updateShallow` (write side, `@writes surface: shallowFile`, byte-identical sorted
LF-terminated output) is **unchanged** in this part.

**Existing unit tests that this part must FLIP (they encode the refuted tolerant claim)** —
`test/unit/application/primitives/shallow-file.test.ts`:
- lines 59–74 `'Given a .git/shallow with only a trailing newline'` (content `'\n'`) —
  currently expects an empty set; must expect a `SHALLOW_FILE_MALFORMED` refusal (D9).
- lines 76–91 `'…with whitespace between oids'` (`<A>\n\n<B>\n`) — currently expects size 2;
  must expect a refusal (D9).
- lines 93–109 `'…with malformed lines (non-oid)'` — currently expects silent skip; must
  expect a refusal naming `lineNumber: 1` (D11).
- lines 174–192 `'…with a leading-space oid line'` — currently expects the trimmed oid to be
  captured; must expect a refusal (git does not trim).
Every other test in that file (missing file, two oids, `readUtf8` error propagation ×2, the
whole `updateShallow` block) stays as-is and must stay green.

**Property tests** (ADR-134 layout: `*.properties.test.ts` sibling, shared `arbitraries.ts`
in the same directory, tiered `numRuns`, **no committed seed**):
- new `test/unit/application/primitives/shallow-file.properties.test.ts`
- extend `test/unit/application/primitives/arbitraries.ts` (already exists, currently holds
  config-subsection and commit-DAG generators) with `arbShallowOid()` (40 lowercase hex),
  `arbShallowOidSet()`, and `arbShallowFileText()` over the safe subset (LF-separated
  40-hex lines, optionally uppercase, optionally with trailing junk after the oid).
  Lens 1 (round-trip) and lens 3 (totality over an algebraic grammar) both apply.

`test/integration/shallow-file-interop.test.ts` (byte-equality of `updateShallow`'s output
against a real `git clone --depth 2`) must stay green untouched — it is the negative control
that the writer did not change.

### TDD steps

1. **RED** — `test/unit/application/primitives/internal/parse-shallow.test.ts` (new).
   `describe('Given a canonical single-oid shallow file') > describe('When parseShallowFile runs') > it('Then it returns that one oid')`.
   `sut = parseShallowFile`. Fails: module does not exist (`Cannot find module`).
2. **GREEN** — create `src/application/primitives/internal/parse-shallow.ts` with the
   line-splitting rule and the 40-hex prefix rule above; export `MAX_SHALLOW_ENTRIES`.
3. **RED** — one isolated test per D-row in the same file: D2 (`''` ⇒ `[]`), D3, D4, D5, D6,
   D7 (uppercase ⇒ lowercase `ObjectId`), D8 (duplicates preserved in the returned array;
   set semantics are the caller's), D9 leading blank, D9 embedded blank, D10 trailing blank,
   D11, D12. Each refusal test uses try/catch and asserts `err.data.code`,
   `err.data.reason === REASON_SHALLOW_BAD_LINE` and the exact `err.data.lineNumber`
   (1-based). Per the "guard clauses need isolated tests" rule, the blank-line disjunct and
   the non-hex disjunct get **separate** tests even though one input could trip both.
   Fails: refusals not implemented / uppercase throws `INVALID_OBJECT_ID`.
4. **GREEN** — add the refusal + lowercase normalisation.
5. **RED** — cap test: `MAX_SHALLOW_ENTRIES + 1` distinct oids ⇒ refusal with
   `reason === REASON_SHALLOW_TOO_MANY_ENTRIES` and `lineNumber === MAX_SHALLOW_ENTRIES + 1`;
   plus an at-the-cap test (`MAX_SHALLOW_ENTRIES` oids ⇒ accepted, length equals the cap) so
   the boundary operator mutant dies. Build the input by string concatenation, not by
   generating 500 001 `ObjectId`s.
6. **GREEN** — enforce the cap during the scan.
7. **RED** — add `SHALLOW_FILE_MALFORMED` cases to `test/unit/domain/error.test.ts`
   (message rendering) and `case 'SHALLOW_FILE_MALFORMED':` to
   `test/unit/domain/exhaustiveness.ts`. Fails: `check:types` — the code is not in the union.
8. **GREEN** — add the union member, the `shallowFileMalformed` factory and the
   `extractDetail` case in `src/domain/error.ts`; add the two `REASON_*` constants in
   `validators.ts`.
9. **RED** — flip the four `shallow-file.test.ts` expectations listed above; add D1 (absent ⇒
   empty set, unchanged) and D13 (an oid with no object present ⇒ still returned). Fails:
   `readShallow` still skips silently.
10. **GREEN** — rewrite `readShallow` to `parseShallowFile(raw)` → `new Set(...)`; keep the
    `FILE_NOT_FOUND` ⇒ empty-set catch and the non-`FILE_NOT_FOUND` rethrow exactly as they
    are (two existing tests pin both). Delete the false doc comment and replace it with the
    strict contract + the "a shallow set is trusted repository state; reachability answers
    are relative to it" note from the design's threat table.
11. **GREEN** — move `shallowFilePath` / `shallowLockPath` into `path-layout.ts`; rewire
    `shallow-file.ts`; delete the dead consts and regex.
12. **RED** — `shallow-file.properties.test.ts` (new) + arbitraries:
    - round-trip, `numRuns: 200`: for an arbitrary oid set `S`,
      `readShallow(ctx)` after `updateShallow(ctx, { shallow: [...S], unshallow: [] })`
      equals `S` (memory adapter; `updateShallow` deletes the file for an empty `S`, so the
      empty case round-trips to the empty set).
    - totality, `numRuns: 100`: over `arbShallowFileText()`, `parseShallowFile` never throws
      and its length equals the generated line count.
    - negative, `numRuns: 50`: any line whose first 40 chars are not hex ⇒
      `SHALLOW_FILE_MALFORMED`.
    Fails until step 10 lands (write it after, run it before committing).
13. **REFACTOR** — keep `parseShallowFile` under 20 lines with early returns (extract a
    `splitShallowLines` and an `oidPrefixOf` helper if needed); no magic numbers (name the
    40 as a const); `readShallow` should read as three lines.
14. **Surface gates (in-slice)** — `npm run docs:json` and commit `reports/api.json`; add the
    `docs/use/errors.md` and `docs/understand/security.md` rows; run `npx cspell` over the
    changed markdown if new words appear.

### Gate

```
npx vitest run test/unit/application/primitives/internal/parse-shallow.test.ts \
  test/unit/application/primitives/shallow-file.test.ts \
  test/unit/application/primitives/shallow-file.properties.test.ts \
  test/unit/domain/error.test.ts \
  test/integration/shallow-file-interop.test.ts \
&& npm run check:types \
&& ./node_modules/.bin/biome check src/application/primitives/internal/parse-shallow.ts src/application/primitives/shallow-file.ts src/application/primitives/path-layout.ts src/application/primitives/validators.ts src/domain/error.ts test/unit/application/primitives/internal/parse-shallow.test.ts test/unit/application/primitives/shallow-file.test.ts test/unit/application/primitives/shallow-file.properties.test.ts test/unit/application/primitives/arbitraries.ts test/unit/domain/error.test.ts test/unit/domain/exhaustiveness.ts
```

### Commit

`fix(shallow): parse .git/shallow with git's strict grammar and an entry cap`

---

## Part 2 — Grafted commit-read tier, per-`Context` shallow set, walk auto-load

### Context

The core fix. Implements **ADR-542** (grafted read tier), **ADR-543** (option becomes an
override), **ADR-546** (per-`Context` memo), **ADR-547** (mask in place, keep the oid).
Discharges requirements 1, 2, 3, 6, 7, 8 and pinned rows **A3, A4, A5, A6, A7, A8, A9, A10,
A14, A15, A16, A17, A19, A23, A25, A26, A28, A29, A31, A33, A34, A38, A39, B1–B7, E1–E3**.
(**A11** `--boundary` and **A22** pathspec-filtered `log` have no tsgit surface — `log` takes
no pathspec and emits no boundary marker per ADR-249 — so they are pinned git-side only, or
skipped; do **not** invent an option for them. **A12/A13, A18, A20, A21, A24, A27, A30, A32,
A35, A36, A37** land in Parts 4–5. **C-rows** land in Part 3.)

**New — `src/domain/commit/graft.ts`** (pure, zero I/O; `src/domain/commit/` currently holds
`binary-heap.ts`, `commit-graph.ts`, `error.ts`, `priority-queue.ts`). Export exactly the two
entry points this part consumes — `applyGraftToData` arrives in Part 4 with **its** consumer,
because knip flags an unused `src/` export:

```ts
export const graftedParents = (
  id: ObjectId,
  parents: ReadonlyArray<ObjectId>,
  shallow: ReadonlySet<ObjectId>,
): ReadonlyArray<ObjectId> => …          // returns `parents` by reference, or NO_PARENTS

export const applyGraft = (commit: Commit, shallow: ReadonlySet<ObjectId>): Commit => …
```

`Commit` is `{ readonly type: 'commit'; readonly id: ObjectId; readonly data: CommitData }`
and `CommitData` is `{ tree, parents, author, committer, message, gpgSignature?, extraHeaders }`
(`src/domain/objects/commit.ts:30–43`). `applyGraft` returns
`{ ...commit, data: { ...commit.data, parents: NO_PARENTS } }` when `id` is a boundary and the
**referentially identical input** otherwise. Guard shape (two disjuncts — each gets its own
isolated test):
`if (shallow.size === 0 || !shallow.has(id)) return <input unchanged>;`
Use a module-level `const NO_PARENTS: ReadonlyArray<ObjectId> = Object.freeze([])` so the
masked path does not allocate per commit. Document the ADR-547 consequence in the module
comment **without naming the ADR**: a masked commit's `id` is the true oid and no longer
equals `hash(data)`, which is safe because no path writes a walked commit back
(`create-commit.ts` builds its own data); any future surface that re-serialises a read commit
must read raw instead.
**This file is inside the 100 % coverage gate** — every branch needs a test.

**New — `src/application/primitives/internal/shallow-set.ts`**, mirroring
`internal/loose-oid-cache.ts`'s `fanoutCache` and `read-commit-graph.ts`'s `graphCache`:

```ts
interface ShallowState { readonly present: boolean; readonly set: ReadonlySet<ObjectId>; }
const shallowCache = new WeakMap<Context, Promise<ShallowState>>();

export const loadShallowSet      = async (ctx: Context): Promise<ReadonlySet<ObjectId>> => (await loadState(ctx)).set;
export const isShallowRepository = async (ctx: Context): Promise<boolean>               => (await loadState(ctx)).present;
export const invalidateShallowSet = (ctx: Context): void => { shallowCache.delete(ctx); };
```

`loadState` memoises the **promise** (not the value), so concurrent grafted reads share one
probe. It performs exactly **one** filesystem call:
`ctx.fs.readUtf8(shallowFilePath(commonGitDir(ctx)))`; success ⇒
`{ present: true, set: new Set(parseShallowFile(raw)) }`; **`FILE_NOT_FOUND` *or*
`NOT_A_DIRECTORY`** ⇒ `{ present: false, set: <shared frozen empty set> }` — mirror
`internal/loose-oid-cache.ts`'s `isMissingFanoutDir` predicate, which treats both codes as
"absent", because a `Context` whose git dir does not exist at all is routine in unit tests and
must not make every walk throw; any other error propagates. This is
requirement 8's single extra probe per `Context`, and it is what makes the two signals
diverge on a 0-byte file (pin D2: `present: true`, empty set) — the case that decides
ADR-544's presence gate over a content gate. A `SHALLOW_FILE_MALFORMED` refusal from the
parser propagates out of both accessors (pin D11: even
`rev-parse --is-shallow-repository` dies on a bad line).
Imports `parseShallowFile` from `./parse-shallow.js` and `shallowFilePath`/`commonGitDir`
from `../path-layout.js` — it must **not** import `shallow-file.ts` (that direction is
`shallow-file.ts → shallow-set.ts` for the invalidation, and the reverse edge would be a
`no-circular` error).

**Changed — `src/application/primitives/shallow-file.ts`**: `updateShallow` calls
`invalidateShallowSet(ctx)` after a successful write **and** after the empty-set delete, so a
`fetch --deepen` / `--unshallow` inside one `Context` is immediately visible.

**Changed — `src/application/primitives/internal/read-commit.ts`** (36 lines). Current:

```ts
export interface ReadCommitOptions {
  readonly verifyHash: boolean;
  readonly ignoreMissing: boolean;
  readonly missing: Set<string>;
}
export const readCommit = async (ctx, id, opts): Promise<Commit | undefined> => {
  try {
    const object = await readObject(ctx, id, { verifyHash: opts.verifyHash });
    return object.type === 'commit' ? object : undefined;
  } catch (error) { … }
};
```

Add `readonly shallow: ReadonlySet<ObjectId>` — **required, not optional**: both call sites
always resolve one, and a defaulted field would silently un-graft a future caller. Apply
`applyGraft(object, opts.shallow)` on the commit branch. Grafting happens **after**
`readObject`, which already verified the hash against the raw bytes, so `verifyHash` is not
weakened. Only two src importers exist (`walk-commits.ts:5`, `commit-date-walk.ts:7`), plus
one **test** importer — `test/unit/application/primitives/internal/commit-date-walk.test.ts:8`
builds a shared `readOpts` literal used at lines 229 and 280, which will fail `check:types`
until it gains `shallow: new Set()`. Fix it in this part.

**Changed — `src/application/primitives/walk-commits.ts`.** Current signature at line 37 is
`function createWalkSession(ctx: Context, options: WalkCommitsOptions): WalkSession` and it
is called synchronously at line 100. It becomes `async` and is `await`ed. Inside:

```ts
shallow: options.shallow ?? await loadShallowSet(ctx),   // replaces `options.shallow ?? new Set<ObjectId>()` (line 46)
```

The resolved set is stored in `WalkState.shallow` (line 24, already
`readonly shallow: ReadonlySet<ObjectId>`) and threaded into the `readCommit` call inside
`createBoundedReader` (lines 49–51). **The seed-priming loop
`for (const seed of state.queue) bodies.start(seed)` (line 54) must stay AFTER the set
resolves** — it now triggers grafted reads. `walkCommits` is already an `async function*`,
so no caller changes. Keep **all three** existing guards untouched:
`resolveFrontierEntry`'s `state.shallow.has(id) ? undefined : await commitHeader(ctx, id)`
(line 76) and `enqueueParents`'s `if (state.shallow.has(commit.id)) return;` (line 142).
They are not dead: a caller passing an explicit override set in a repository with **no**
`.git/shallow` leaves the commit-graph enabled, and line 76 is then the only thing stopping
`commitHeader` from enqueueing a boundary's parents from the graph.

**Changed — `src/application/primitives/internal/commit-date-walk.ts`.** Line 81 is
`const shallow = options.shallow ?? new Set<ObjectId>();` → `?? await loadShallowSet(ctx)`
(the function is already an `async function*`, so the `await` is free). Thread the same value
into the `readCommit` call at line 94. Keep `if (shallow.has(commit.id)) continue;` (line 114).
`walkCommitsByDate` (`walk-commits-by-date.ts`) is a thin projection and needs **no** change.

**Changed — `src/application/primitives/types.ts` (public surface).** Rewrite both JSDoc
blocks — `WalkCommitsOptions.shallow` (≈ lines 121–130) and
`WalkCommitsByDateOptions.shallow` (≈ lines 143–147) — to state the ADR-543 contract without
naming it: *omitted ⇒ the repository's `.git/shallow` set is loaded automatically; supplied
(including an explicit empty `Set`) ⇒ the caller's set wins and no repository state is
consulted; the commit itself is still yielded, only its parents are skipped; a shallow set is
trusted repository state, so reachability answers are relative to it.* The type does **not**
change (source-compatible), but typedoc feeds `reports/api.json`, so **regenerate with
`npm run docs:json` and commit `reports/api.json` in this part** or the prepush
`check:doc-typedoc` gate fails. Also update
`docs/use/primitives/walk-commits.md` and `docs/use/primitives/walk-commits-by-date.md`
(the latter documents `shallow` at lines 18 and 30).

**Auto-load reaches every existing walk caller** — all reviewed and correct or improved:
`log.ts:55–58` (`walkCommits` for `first-parent`, `walkCommitsByDate` otherwise),
`whatchanged.ts:49–51`, `shortlog.ts`, `range-diff.ts`, `describe.ts:376` (`commitDateWalk`),
`cherry-pick.ts:139,143`, `revert.ts:328,332`, `rebase.ts:173,180`, `push.ts:304`
(`ignoreMissing: true`), `reflog.ts:181`, `fetch.ts:271` (have-computation — a shallow client
must not claim `have` for objects it lacks), `enumerate-push-objects.ts:62`,
`enumerate-bundle-objects.ts:144,159`. `ignoreMissing` keeps its independent meaning: masking
narrows what a walk reaches, it does not change how a genuinely missing object is treated. A
**seed** that is itself absent still throws `OBJECT_NOT_FOUND` (pin A19) — grafting masks a
boundary's parents, it never invents a commit.

**Unchanged, deliberately:** `read-object.ts`, `cat-file.ts` / `cat-file-batch.ts` (pins
A8/A9 — the negative control), `create-commit.ts`, `write-object.ts`, `domain/protocol`
fetch-negotiation shallow handling, `stash.ts` / `snapshot-factory.ts`.

**Unit tests to write / extend:**
- new `test/unit/domain/commit/graft.test.ts` (dir exists: `test/unit/domain/commit/`).
  100 % coverage required. Cases: empty set ⇒ **same reference** (`toBe`); non-boundary with a
  non-empty set ⇒ same reference; boundary ⇒ `parents` empty **and** `id`, `tree`, `author`,
  `committer`, `message`, `gpgSignature`, `extraHeaders` untouched **and** the input object
  not mutated; multi-parent boundary ⇒ *all* parents dropped, not just the first;
  `graftedParents` directly for both disjuncts.
- new `test/unit/application/primitives/internal/shallow-set.test.ts` (memory adapter).
  Cases: absent file ⇒ empty set **and** `isShallowRepository === false`; 0-byte file ⇒ empty
  set **and** `isShallowRepository === true` (pin D2 — the divergent-signals case);
  memoisation (wrap `ctx.fs.readUtf8` in a counting stub; N calls to `loadShallowSet` +
  `isShallowRepository` ⇒ exactly **1** read); `invalidateShallowSet` forces a re-read;
  malformed file ⇒ both accessors reject with `SHALLOW_FILE_MALFORMED`;
  `updateShallow` invalidates (write, then observe the new set through the same `Context`).
- extend `test/unit/application/primitives/walk-commits.test.ts` — the existing
  `describe('shallow boundary')` block at line 780 already covers `undefined`, empty, `{tip}`,
  missing-parent, two-seed and parent-of-seed cases with an explicit option. Add:
  auto-load (hand-write `${ctx.layout.gitDir}/shallow` in the memory adapter, pass **no**
  `shallow` option, assert the walk stops at the boundary); explicit `new Set()` override in a
  repo **with** a shallow file (assert the walk does **not** stop — the escape hatch); and the
  reported-parents assertion (`commit.data.parents` is `[]` for the boundary — the yielded
  object is grafted, not just the frontier).
- extend `test/unit/application/primitives/walk-commits-by-date.test.ts` (existing
  `Given shallow={tip}` at line 298) and
  `test/unit/application/primitives/internal/commit-date-walk.test.ts` with the same three
  additions.
- `test/unit/application/commands/log*.test.ts` — add the acceptance case:
  `log({ maxParents: 0 })` on an auto-loaded shallow repo returns the boundary commit
  (requirement 2, pin A3), and `LogEntry.parents` is `[]` for it (pin A6).

**Mutation expectation for the later gating phase** (write the tests with it in mind, do not
add suppressions now): `graft.ts`'s and `shallow-set.ts`'s identity short-circuits are the
likely equivalent-mutant sources — removing `shallow.size === 0` costs only an allocation and
a `Set.has`, so it is observationally equivalent. If mutation confirms that, the fix is a
proof comment anchored **on the expression line** (a `(mutator, line)` pair, never a
whole-guard suppression), and only after hand-verifying the mutant against the actual guard.
The `!shallow.has(id)` disjunct is *not* equivalent and must die to the per-disjunct tests
above.

**Parity scenario (cross-adapter, node/memory/browser).** New
`test/parity/scenarios/shallow-walk.scenario.ts` registered in
`test/parity/scenarios/index.ts` (alphabetical import + `SCENARIOS` entry). Follow
`bisect-midpoint.scenario.ts`'s shape exactly: `Scenario<T>` with `name`, `inputs`
(`{ files: [], author: AUTHOR, message: 'seed' }` from `../fixtures.ts`), a hard-coded
`expected`, and `run: async (repo, inputs) => …`. Build a 3-commit chain with
`repo.primitives.writeObject` + `repo.primitives.createCommit` at fixed timestamps (oids are
then deterministic), write the middle commit's oid into
`` `${repo.ctx.layout.gitDir}/shallow` `` via `repo.ctx.fs.writeUtf8` (with a trailing `\n`),
then collect `repo.primitives.walkCommits({ from: [tip] })` and return the oid list. This
proves the common-dir path resolution and the graft are adapter-independent; it is
explicitly **not** a faithfulness proof. The parity tier budget is `target: 0` with no
`warnAbove`, so adding one scenario cannot trip `check:test-pyramid`.

**Interop suite — new `test/integration/shallow-walk-interop.test.ts`.** Cross-tool
faithfulness is authoritative here. Follow `test/integration/shallow-file-interop.test.ts`'s
shape (imports `createNodeContext` from `../../src/adapters/node/node-adapter.js`, helpers
from `./interop-helpers.js`, `describe.skipIf(!GIT_AVAILABLE)(…)`).

Header (`@proves` grammar is parsed from the **first** JSDoc in the file; buckets are an enum;
`unique` must be 12–200 chars; `cross-tool-interop` must live in `test/integration/` root).
Use a surface name **distinct** from `shallowFile` — that `(surface, bucket)` pair is already
claimed by `shallow-file-interop.test.ts`:

```
/**
 * @proves
 *   surface: shallowWalk
 *   bucket:  cross-tool-interop
 *   unique:  shallow-boundary parent masking matches git rev-list/log on a --depth clone
 */
```

**One shared `beforeAll(async () => { … }, 60_000)`** builds every fixture; `afterAll` removes
the tmpdirs. All commits use `{ ...runGitEnv(), GIT_AUTHOR_NAME/EMAIL/DATE,
GIT_COMMITTER_NAME/EMAIL/DATE }` with **monotonically increasing** dates so date-order is
deterministic. `--depth` is ignored for a plain local path — clone through
`` `file://${bare}` ``, as the existing suite does at line 64.

| Fixture | Build |
|---|---|
| `F1` | bare + source with 5 linear commits `c1..c5` on `main`, pushed; `git clone -q --depth 2 file://<bare> F1` ⇒ objects `{C5,C4}`, `.git/shallow` = `{C4}` |
| `F2` | second clone of the same bare with `--depth 1` ⇒ `.git/shallow` = `{C5}` |
| `F3` | separate bare + source with `base → {side1, main1} → merge`, `--depth 2` clone ⇒ **two** boundaries (`side1`, `main1`), lexicographically sorted, LF-terminated |
| `F6` | `git -C F1 worktree add <path> -b wt` — a linked worktree of the shallow repo (`.git/worktrees/<n>/` holds **no** `shallow`; masking must come from the common dir) |
| `F7a` | third `--depth 2` clone, mutated **inside** its test by `git fetch --deepen 1` |
| `F7b` | fourth `--depth 2` clone, mutated **inside** its test by `git fetch --unshallow` |

Capture the oid list once with `git -C <source> rev-list --reverse main` and keep it in
module scope as `[C1, C2, C3, C4, C5]`.

**Every `createNodeContext({ workDir: … })` is constructed inside its own `it`, after the
last git write to that fixture** — the loose-object fanout cache and the shallow memo are both
per-`Context`. For `F7a`/`F7b` the `git fetch --deepen`/`--unshallow` runs in the `// Arrange`
section and the `Context` is created **after** it.

Row → assertion map for this part (reconstruct git's stdout from tsgit's structured fields
per ADR-249; the library emits no display string):

- **A3** (the defect): `log(ctx, { maxParents: 0 })` ⇒ `[C4]`, compared against
  `git -C F1 rev-list --max-parents=0 HEAD`.
- **A4/A5**: `walkCommits(ctx, { from: [C5] })` ⇒ `[C5, C4]`, count 2, matching
  `git -C F1 rev-list HEAD`; same via `walkCommitsByDate`.
- **A6/A10**: `log(ctx, {})` ⇒ entries whose `${id} ${parents.join(' ')}` reconstruction
  equals `git -C F1 log --format='%H %P'` (the boundary line ends with a bare oid + empty
  parent list).
- **A7**: same as A6 — abbreviation is the caller's concern; assert the full-oid form only.
- **A25**: `log(ctx, { minParents: 1 })` ⇒ `[C5]`.
- **A26**: `log(ctx, { order: 'first-parent', maxParents: 0 })` ⇒ `[C4]`.
- **A14/A16/A17**: `walkCommits(ctx, { from: [C5], until: [C4] })` ⇒ `[C5]`, and
  `log(ctx, { excluding: ['<C4>'] })` ⇒ one entry — matching `git rev-list C4..C5`,
  `--ancestry-path C4..HEAD` and `HEAD --not C4`, all of which yield `C5`.
- **A19**: `walkCommits(ctx, { from: ['<C3>'] })` (a seed that is itself absent) rejects with
  `OBJECT_NOT_FOUND` — grafting masks a *boundary's* parents, it never invents a commit;
  co-assert `tryRunGitWithExit(['-C', F1, 'merge-base', 'HEAD', '<C3>'])` exits 128.
- **A15** (range base beyond the boundary): git refuses
  `rev-list C3..HEAD` with exit 128. Assert git's refusal, then assert whatever tsgit
  actually does for `log(ctx, { excluding: ['<C3>'] })`. **Check first** whether
  `resolveCommit` (`commands/internal/resolve-rev.ts`, called at `log.ts:53`) probes object
  existence for a full 40-hex oid. If it does, assert the co-refusal. If it does **not**,
  tsgit yields `[C5, C4]` with an inert `until` entry — record that as a pre-existing,
  out-of-scope divergence in a test comment and assert the observed behaviour; **do not add
  an existence probe to `excluding` just to close this row** (it is a resolution-layer
  question, not a graft question, and it would cost a read on every `log --not`).
- **A8/A9 (negative control)**: `catFile(ctx, { ids: [C4] })` still reports `C3` as C4's
  parent — proves the graft is traversal-only and object content is untouched. Compare with
  `git -C F1 cat-file -p C4`.
- **A23**: `whatchanged(ctx, {})` — the boundary entry's `changes` diff against the **empty
  tree** (its `parents` is `[]`, so `diffCommitAgainstParent` receives `undefined`); compare
  the added-path set with `git -C F1 log --name-status`.
- **A28/A29**: annotate `v0.4` on `C4` in `F1` inside `beforeAll` —
  `runGit(['-C', F1, 'tag', '-a', 'v0.4', '-m', 'v0.4', C4], { env })` **with the extended
  env**: an annotated tag needs a committer identity, and the isolated `HOME` means there is
  no readable `user.name` / `user.email`, so a bare `runGit` here fails. Then `describe` on
  HEAD and on `C4` matches `git -C F1 describe HEAD` (`v0.4-1-g…`) / `git -C F1 describe <C4>`
  (`v0.4`).
- **A31**: `shortlog(ctx, …)` counts 2 commits for the single author.
- **A33**: bundle creation from `F1` succeeds (exit 0 on the git side; tsgit's
  `enumerateBundleObjects` / bundle command completes without `OBJECT_NOT_FOUND`).
- **A34**: `enumeratePushObjects` terminates at the boundary rather than over-enumerating;
  the refusal is server-side in git (`shallow update not allowed`), so only tsgit's client
  half is asserted.
- **A38**: `git -C F7a fetch --deepen 1` (Arrange) → **new** `Context` → walk count 3 and
  `log({maxParents:0})` ⇒ `[C3]`, matching git.
- **A39**: `git -C F7b fetch --unshallow` (Arrange) → **new** `Context` → `.git/shallow` gone,
  walk count 5, `log({maxParents:0})` ⇒ `[C1]`.
- **B1/B2** on `F2`: `.git/shallow` = `{C5}`; `log` ⇒ one entry with `parents: []`;
  `maxParents: 0` ⇒ `[C5]`.
- **B3–B6** on `F3`: two boundaries; `walkCommits` yields 3 commits; both boundaries report
  `parents: []`; `log({ maxParents: 0 })` ⇒ **both** boundaries.
- **B7** on `F3`: `mergeBase(ctx, [merge, main1])` ⇒ `main1` (inside the available set) —
  this exercises `merge-base` before Part 5 grafts it; if the un-grafted reader throws here,
  move this single assertion to Part 5 rather than grafting early.
- **E1/E2/E3** on `F6`: the linked worktree dir contains **no** `shallow` file, yet a
  `Context` opened on it walks with identical masking to `F1` (the set resolves through
  `commonGitDir`).

### TDD steps

1. **RED** — `test/unit/domain/commit/graft.test.ts`: identity on an empty set (`toBe`
   reference equality). Fails: module missing.
2. **GREEN** — `src/domain/commit/graft.ts` with `NO_PARENTS`, `graftedParents`, `applyGraft`.
3. **RED** — the remaining graft cases (non-boundary identity as its own test; boundary masks
   all parents; every other `CommitData` field preserved; input not mutated; multi-parent).
4. **GREEN** — complete `applyGraft`; verify 100 % branch coverage locally with
   `npx vitest run --coverage test/unit/domain/commit/graft.test.ts` before moving on.
5. **RED** — `test/unit/application/primitives/internal/shallow-set.test.ts`: absent-file and
   0-byte-file cases (both signals asserted separately). Fails: module missing.
6. **GREEN** — `src/application/primitives/internal/shallow-set.ts`.
7. **RED** — memoisation (counting `readUtf8` stub ⇒ exactly 1 call), invalidation, and the
   malformed-file propagation cases. **GREEN** — `invalidateShallowSet`; wire it into
   `updateShallow` (both the write and the delete paths) in
   `src/application/primitives/shallow-file.ts`.
8. **RED** — extend `walk-commits.test.ts` with the auto-load case (memory adapter,
   hand-written `${ctx.layout.gitDir}/shallow`, **no** `shallow` option). Fails: the walk
   still expands the boundary's parents.
9. **GREEN** — add `shallow` to `ReadCommitOptions`, apply `applyGraft` in `readCommit`, make
   `createWalkSession` `async` (`options.shallow ?? await loadShallowSet(ctx)`), `await` it at
   the `walkCommits` call site, and thread the resolved set into `readCommit`. Keep the
   seed-priming loop after the resolution.
10. **RED** — the explicit-`new Set()` override case and the grafted-`parents` assertion on
    the yielded boundary commit. **GREEN** — already satisfied by step 9; if not, the override
    is being unioned instead of replacing — fix the `??`.
11. **RED/GREEN** — repeat 8–10 for `walk-commits-by-date.test.ts` and
    `internal/commit-date-walk.test.ts`; change `commit-date-walk.ts` line 81 and the
    `readCommit` call at line 94.
12. **RED** — the `log({ maxParents: 0 })` acceptance case in the log unit tests.
    **GREEN** — no further src change expected; if it fails, the graft is not reaching
    `walkCommitsByDate`.
13. **RED** — write `test/integration/shallow-walk-interop.test.ts` with the `@proves` header,
    the shared 60 s `beforeAll`, and the row assertions above. Run it; every remaining red
    row must be one of the rows this part owns.
    **GREEN** — fix the src until all owned rows pass. Rows owned by Parts 3–5 must **not**
    be written here.
14. **RED/GREEN** — `test/parity/scenarios/shallow-walk.scenario.ts` + `index.ts`
    registration; `npx vitest run test/parity`.
15. **REFACTOR** — `createWalkSession` stays under 20 lines (extract a
    `resolveShallow(ctx, options)` helper if it grows); no duplicated
    `options.shallow ?? await loadShallowSet(ctx)` logic between the two walks beyond the
    one-line expression; `shallow-set.ts` under 60 lines.
16. **Surface gates (in-slice)** — rewrite both `shallow` JSDoc blocks in
    `src/application/primitives/types.ts`; update `docs/use/primitives/walk-commits.md` and
    `docs/use/primitives/walk-commits-by-date.md`; run `npm run docs:json` and commit
    `reports/api.json`.

### Gate

```
npx vitest run test/unit/domain/commit/graft.test.ts \
  test/unit/application/primitives/internal/shallow-set.test.ts \
  test/unit/application/primitives/walk-commits.test.ts \
  test/unit/application/primitives/walk-commits-by-date.test.ts \
  test/unit/application/primitives/internal/commit-date-walk.test.ts \
  test/unit/application/primitives/shallow-file.test.ts \
  test/unit/application/commands/log.test.ts \
  test/integration/shallow-walk-interop.test.ts \
  test/parity \
&& npm run check:types \
&& ./node_modules/.bin/biome check src/domain/commit/graft.ts src/application/primitives/internal/shallow-set.ts src/application/primitives/internal/read-commit.ts src/application/primitives/walk-commits.ts src/application/primitives/internal/commit-date-walk.ts src/application/primitives/shallow-file.ts src/application/primitives/types.ts test/unit/domain/commit/graft.test.ts test/unit/application/primitives/internal/shallow-set.test.ts test/unit/application/primitives/walk-commits.test.ts test/unit/application/primitives/walk-commits-by-date.test.ts test/unit/application/primitives/internal/commit-date-walk.test.ts test/integration/shallow-walk-interop.test.ts test/parity/scenarios/shallow-walk.scenario.ts test/parity/scenarios/index.ts
```

(All paths above were verified to exist at planning time.)

### Commit

`fix(walk): graft shallow-boundary parents so traversals stop at the cut`

---

## Part 3 — Commit-graph reader disabled by shallow-file presence

### Context

Implements **ADR-544**. Discharges requirement 5 and pinned rows **C1, C2, C3, C5, C6, C7**
(and **C4** git-side only — see the honest caveat below). Depends on Part 2's
`isShallowRepository`.

**Changed — `src/application/primitives/internal/read-commit-graph.ts`.** The module caches a
`Promise<LoadedGraph | undefined>` per `Context` in `graphCache` (line 51) and resolved
headers in `headerCache` (line 56); `commitHeader(ctx, id)` returns `undefined` for any oid the
graph does not cover, and every caller already falls back to a body read — the module never
falls back itself. The change: the `loadGraph` path short-circuits to `undefined` when
`await isShallowRepository(ctx)` is true, **before** any `objects/info/commit-graph` probe, so
`commitHeader` yields nothing and both walks take their existing graph-absent body-read path.
Put the short-circuit where it is memoised with the rest of the graph load (i.e. inside the
function whose promise `graphCache` stores) so the presence probe is not repeated per oid; the
shallow probe is itself memoised per `Context`, so the cost is at most one extra `readUtf8`
that Part 2 already budgeted.

**The gate is file PRESENCE, not set non-emptiness** — pins C6 and C11: an *empty* (0-byte)
shallow file already makes git abandon the graph. This is why `shallow-set.ts` keeps
`present` and `set` as two distinct signals; use `isShallowRepository`, never
`(await loadShallowSet(ctx)).size > 0`.

**Honest scope note for the interop rows.** Pin C4 (graph present, `C3`'s loose object
deleted, **no** shallow ⇒ `git rev-list HEAD` yields 5 commits, exit 0) is git traversing
purely from the graph without reading objects. tsgit's walks always `await` the body
(`resolveFrontierEntry` line 85 / `enqueueCommit` line 150), so tsgit refuses there **today,
before this change** — a pre-existing divergence that this part neither introduces nor
fixes. Assert C4 on the **git side only** and record the divergence in the test's comment
(no ADR/phase ref in the file); do not add a tsgit assertion for it and do not widen scope to
close it. C5/C6/C7 are the rows where tsgit and git agree, and C2/C3 are where masking must
win over an available, graph-known parent.

**Interop fixtures added to the existing `beforeAll` in
`test/integration/shallow-walk-interop.test.ts`** (Part 2 created the file):

- `F4`: **`git init` in place with 5 commits** — *not* a clone. A clone packs its objects, and
  C5 requires deleting a single **loose** object. Commits use the extended env (deterministic
  identities and dates). Then `git -C F4 commit-graph write --reachable`, and **no** shallow
  file. Capture this repo's own `[C1..C5]` with `git -C F4 rev-list --reverse HEAD` — they are
  *different oids* from Part 2's `F1` chain, so keep them in a separate module-scope binding.
- Variants are cheap `fs.cp(F4, <dir>, { recursive: true })` copies of `F4`, then:
  - `F4c2`: write `.git/shallow` = `<C4>\n` (parents still present locally).
  - `F4c3`: write `.git/shallow` = `<C2>\n` (mid-history).
  - `F5-no-shallow`: delete `.git/objects/<C3[0:2]>/<C3[2:]>`, **no** shallow file (the C4 row —
    git-side assertion only).
  - `F5`: same deletion, plus `.git/shallow` = `<C1>\n` (masks nothing real).
  - `F5empty`: same deletion, plus a **0-byte** `.git/shallow`.
  - `F5restored`: 0-byte `.git/shallow`, `C3` **not** deleted.
- Every tsgit `Context` is created inside its `it`, after those file mutations.
- **C2 and C3 are regression rows, not gate discriminators.** After Part 2 they already pass,
  because `resolveFrontierEntry`'s `state.shallow.has(id)` guard skips the boundary's header
  and `enqueueParents` reads an already-grafted parent list. The gate's own discriminator is
  the unit test below (and the 0-byte variant of it). Say so in a test comment so a later
  reader does not mistake C2/C3 for proof of the graph gate.

Row assertions:

- **C1** (`F4`, graph, no shallow): `walkCommits` ⇒ 5 commits; `log({maxParents:0})` ⇒ `[C1]`;
  matches `git -C F4 rev-list HEAD` / `--max-parents=0`.
- **C2** (`F4c2`): `walkCommits` ⇒ `[C5, C4]` **only**; `log({maxParents:0})` ⇒ `[C4]`;
  the boundary's `parents` is `[]` — masking wins over an available, graph-known parent.
- **C3** (`F4c3`): `walkCommits` ⇒ `[C5, C4, C3, C2]`; `log({maxParents:0})` ⇒ `[C2]` —
  masking is applied by oid, independent of object availability.
- **C4** (git side only): `git -C F5-no-shallow rev-list HEAD` exits 0 with 5 lines. Build this
  variant as a copy of `F4` with `C3`'s loose object deleted and **no** shallow file.
- **C5** (`F5`): both refuse — `tryRunGitWithExit` exit 128 (`Failed to traverse parents`);
  tsgit's `walkCommits` rejects with `OBJECT_NOT_FOUND`.
- **C6** (`F5empty`): identical refusal on both sides with an **empty** shallow file — the
  decisive presence-not-content pin.
- **C7** (`F5restored`): `git rev-list --count HEAD` ⇒ 5 and tsgit walks 5 with an empty
  shallow file present.

**Unit test — `test/unit/application/primitives/internal/read-commit-graph.test.ts`** (26 KB,
already covers graph/chain/staleness). Add a suite: a memory-adapter repo with a valid
commit-graph **and** a `${ctx.layout.gitDir}/shallow` file ⇒ `commitHeader` returns
`undefined` for an oid the graph demonstrably covers (assert the same oid resolves to a
header when the shallow file is absent, so the test cannot pass vacuously). Add the 0-byte
variant as its own test — that is the disjunct that separates a presence gate from a
content gate.

### TDD steps

1. **RED** — `read-commit-graph.test.ts`: graph present + shallow file present ⇒
   `commitHeader(ctx, coveredOid)` is `undefined`, paired with a control asserting it is
   defined without the shallow file. Fails: the graph is still consulted.
2. **GREEN** — short-circuit `loadGraph` on `await isShallowRepository(ctx)`.
3. **RED** — the 0-byte-shallow variant of the same test. **GREEN** — already satisfied if the
   gate uses `present`; if it fails, the gate is reading `set.size` — fix it.
4. **RED** — add `F4`, `F4c2`, `F4c3`, `F5`, `F5-no-shallow`, `F5empty`, `F5restored` to the
   interop `beforeAll` and write the C-row assertions. **GREEN** — all rows except C4's tsgit
   half (which is not asserted) pass.
5. **REFACTOR** — keep the short-circuit as a single early return inside the memoised load; no
   duplicated shallow probe per `commitHeader` call. Re-check that `headerCache` cannot serve
   a stale header from before a `Context`-level invalidation (it cannot — both caches are
   populated only through the gated load; state that in a comment if it is non-obvious).

### Gate

```
npx vitest run test/unit/application/primitives/internal/read-commit-graph.test.ts \
  test/integration/shallow-walk-interop.test.ts \
  test/integration/commit-graph-walk-interop.test.ts \
&& npm run check:types \
&& ./node_modules/.bin/biome check src/application/primitives/internal/read-commit-graph.ts test/unit/application/primitives/internal/read-commit-graph.test.ts test/integration/shallow-walk-interop.test.ts
```

### Commit

`fix(commit-graph): ignore the graph when a shallow file is present`

---

## Part 4 — Graft the `CommitData` read tier: replay, blame, show, patch-id

### Context

Second half of **ADR-542**'s breadth, for the sites that read a commit's *data* rather than a
`Commit`. Discharges pinned rows **A24, A27, A35, A36**.

**New export in `src/domain/commit/graft.ts`** (its consumer arrives in this part, so knip
stays green):

```ts
export const applyGraftToData = (
  id: ObjectId,
  data: CommitData,
  shallow: ReadonlySet<ObjectId>,
): CommitData => …    // same identity short-circuit; returns `data` by reference when nothing masks
```

Three entry points exist because the oid arrives differently per tier: `Commit` carries its
own `id` (`applyGraft`), but bare `CommitData` has **no `id` field**, so the caller supplies
the oid it asked for. Both are built on `graftedParents`.

**Changed — `src/application/commands/internal/history-rewrite.ts` (31 lines).** Current:

```ts
export const readCommitData = async (ctx: Context, id: ObjectId): Promise<CommitData> => {
  const obj = await readObject(ctx, id);
  if (obj.type !== 'commit') throw unexpectedObjectType('commit', obj.type, id);
  return obj.data;
};
export const treeOf = async (ctx, commitId) => (await readCommitData(ctx, commitId)).tree;
```

Apply `applyGraftToData(id, obj.data, await loadShallowSet(ctx))` before returning. This one
edit propagates masking to **blame** (`blame.ts:249 processSuspect`, whose boundary flag at
`:293` is exactly `data.parents.length === 0` — pin A27), **cherry-pick**, **revert**,
**rebase** (pins A35/A36 — the replay base tree comes from the masked list), and `treeOf`
→ `internal/commit-diff.ts diffCommitAgainstParent`, with no per-command edit. Non-walk
grafted sites have **no override concept** (ADR-543): they always call `loadShallowSet(ctx)`
directly.

**Changed — `src/application/commands/show.ts`.** `buildForRev` (line 112) does
`buildResult(ctx, await readObject(ctx, await revParse(ctx, rev)), withStat)`; `buildResult`
switches on `obj.type` (line 115). Route the `'commit'` branch through
`applyGraft(obj, await loadShallowSet(ctx))` so `ShowCommitResult.commit.parents` is `[]`
for a boundary and `patch` diffs against the **empty tree** (`diffCommitAgainstParent`
receives `undefined` for `parents[0]`) — pin A24's root-commit shape. Do **not** graft the
`'tag'` / `'tree'` / `'blob'` branches.

**Changed — `src/application/primitives/patch-id.ts`.** Its module-local
`readCommitData` (line 29–33, same shape as history-rewrite's) grafts identically; `patchId`
then diffs the boundary against the empty tree because `cData.parents[0]` is `undefined`
(line 53).

**Untouched, deliberately:** `read-object.ts`, `cat-file.ts` (pins A8/A9 — Part 2 already
asserts the negative control), `create-commit.ts`, `stash.ts` / `snapshot-factory.ts` (they
destructure a *stash* commit's synthetic parents, never a boundary).

**Unit tests:** extend `test/unit/domain/commit/graft.test.ts` with `applyGraftToData`'s two
guard disjuncts and its field-preservation case (100 % coverage gate). Extend the existing
unit suites for `history-rewrite` / `blame` / `show` / `patch-id` (locate them under
`test/unit/application/commands/` and `test/unit/application/primitives/patch-id.test.ts`)
with a memory-adapter shallow repo: blame's boundary flag is set and it does not descend into
the absent parent; `show`'s boundary result carries `parents: []` and a full-add `patch`;
`patchId` on a boundary equals the patch-id of the same tree diffed against the empty tree.

**Interop rows added to `test/integration/shallow-walk-interop.test.ts`** (reuse `F1`; add
nothing to `beforeAll` unless a row needs a writable clone — `revert`/`cherry-pick` mutate the
worktree, so give them their own `fs.cp` copy of `F1` made **inside** the `it`'s Arrange
section, with the `Context` built after the copy):

- **A24**: `show(ctx, <C4>)` ⇒ `commit.parents` is `[]` and the patch adds every file;
  reconstruct and compare with
  `git -C F1 show --no-ext-diff --stat --format='%H p=[%P]' <C4>` (assert the `p=[]` shape and
  the changed-file count, not the rendered stat line).
- **A27**: `blame(ctx, { path: 'f.txt' })` ⇒ the boundary-attributed lines carry the
  boundary flag and commit `C4`; compare the per-line commit attribution with
  `git -C F1 blame --line-porcelain f.txt` (git marks 4 lines `boundary`).
- **A35**: `revert` of `C4` conflicts as a modify/delete against the empty tree — co-assert
  git's `CONFLICT (modify/delete)` via `tryRunGitWithExit` on a sibling copy.
- **A36**: `cherryPick` of `C4` conflicts as add/add — the boundary behaves as a root.
  If tsgit's conflict *shape* legitimately differs from git's rendered message, assert the
  structured refusal/conflict data and the co-refusal (both non-zero), never the message
  bytes.

### TDD steps

1. **RED** — `graft.test.ts`: `applyGraftToData` identity on an empty set; identity for a
   non-boundary id; masking for a boundary id with every other field preserved. Fails: not
   exported.
2. **GREEN** — add `applyGraftToData` to `src/domain/commit/graft.ts`.
3. **RED** — history-rewrite unit test: `readCommitData` on a boundary returns `parents: []`
   in a memory-adapter repo with a hand-written `.git/shallow`. Fails: raw parents returned.
4. **GREEN** — graft in `history-rewrite.readCommitData`.
5. **RED** — blame unit test: boundary flag set, no descent into the absent parent.
   **GREEN** — expected to pass from step 4; if not, blame reads parents elsewhere — find it
   with `find_referencing_symbols` on `readCommitData` and route it.
6. **RED** — show unit test: boundary `parents: []` + empty-tree patch. **GREEN** — graft the
   `'commit'` branch of `buildResult`.
7. **RED** — patch-id unit test: boundary patch-id equals the empty-tree-diff patch-id.
   **GREEN** — graft `patch-id.ts`'s local `readCommitData`.
8. **RED** — interop rows A24, A27, A35, A36. **GREEN** — fix until green.
9. **REFACTOR** — the three grafted readers now share the shape
   `applyGraftToData(id, obj.data, await loadShallowSet(ctx))`; if `patch-id.ts`'s local
   `readCommitData` is now byte-identical to `history-rewrite`'s, import the shared one
   instead of duplicating (check the import direction does not create a cycle:
   `primitives/patch-id.ts → commands/internal/history-rewrite.ts` crosses tiers **upward**
   and is forbidden by the dependency rule — if so, keep the duplicate and say why in a
   comment).

### Gate

```
npx vitest run test/unit/domain/commit/graft.test.ts \
  test/unit/application/commands/internal/history-rewrite.test.ts \
  test/unit/application/commands/blame.test.ts \
  test/unit/application/commands/show.test.ts \
  test/unit/application/primitives/patch-id.test.ts \
  test/integration/shallow-walk-interop.test.ts \
&& npm run check:types \
&& ./node_modules/.bin/biome check src/domain/commit/graft.ts src/application/commands/internal/history-rewrite.ts src/application/commands/show.ts src/application/primitives/patch-id.ts test/unit/domain/commit/graft.test.ts test/integration/shallow-walk-interop.test.ts
```

(All paths above were verified to exist at planning time.)

### Commit

`fix(shallow): graft boundary parents in commit-data reads`

---

## Part 5 — Graft the direct `readObject` parent sites

### Context

Closes **ADR-542**'s breadth. Discharges pinned rows **A12, A13, A18, A19, A20, A21, A30,
A32, A37**. Five mechanical redirects, each reading parents straight from `readObject` today.
All of them are non-walk sites, so all of them call `loadShallowSet(ctx)` directly (no
override concept).

1. **`src/application/commands/rev-parse.ts` — `getNthParent` (lines 182–189)**:
   ```ts
   const getNthParent = async (ctx, id, n) => {
     const obj = await readObject(ctx, id);
     if (obj.type !== 'commit') throw objectNotFound(id);
     const parents = obj.data.parents;
     const parent = parents[n - 1];
     if (parent === undefined) throw objectNotFound(id);
     return parent;
   };
   ```
   Graft `obj` before reading `parents`. Consequence: on a depth-2 clone `HEAD~1` ⇒ `C4`
   (pin A12) and `HEAD~2` / `C4^` now **refuse** with `OBJECT_NOT_FOUND` (pin A13, git exit
   128) instead of today's silent success returning a phantom oid whose object does not
   exist. `applyOperation` (line 172) walks `~n` through repeated `getNthParent(…, 1)`, so
   the refusal propagates correctly for both `^` and `~`.
2. **`src/application/commands/name-rev.ts` — `expandParents` (lines 118–137)**: it reads
   `commit.data.parents` (line 126) and `readObject(ctx, parentOid)` (line 131). Graft the
   commit whose parents are being expanded, and graft each parent commit it pushes onto the
   stack (`seedRef`'s peeled tip too — it feeds the same stack). Pin A30: `name-rev HEAD` on
   a shallow clone still resolves to `main`.
3. **`src/application/primitives/merge-base.ts` — `makeReadCommit` (lines 22–35)**: a
   per-call memoising reader returning `Commit | undefined`. Graft inside the cache-miss
   branch, so every `paint` (line 54) consumer sees masked parents. Pins A18
   (`mergeBase(HEAD, C4)` ⇒ `C4`), A20 (`C4` is an ancestor of `HEAD`), A21
   (`--independent` ⇒ `C5`). A19 (`mergeBase(HEAD, C3)` ⇒ refusal) already holds — the seed
   object is genuinely absent — but assert it so the graft cannot be over-applied into
   inventing a commit. **Note the existing `Stryker disable next-line all: equivalent`
   comment on the cache guard (lines 25–28): re-read its proof after the edit and keep it
   only if it still holds for the grafted read** (a data-shape change can silently falsify a
   carried-forward equivalence proof).
4. **`src/application/primitives/bisect-midpoint.ts` — `readCommitEntry` (lines 15–19)**:
   returns `{ date, parents }` from `obj.data`; graft before projecting. Feeds
   `paintReachable` (line 25) and the memoising walk reader (line 52). Pin A37:
   `git bisect start HEAD C4` works and reports `C5`.
5. **`src/application/commands/internal/fsck/object-cache.ts` — `buildObjectCache`
   (lines 19–34)**: reads every universe object once with `{ verifyHash: false }` and stores
   `GitObject | null`. Graft **commit** objects as they enter the cache. Its two consumers
   (`reachability.buildInEdgeMap` / `processCommit`, and `fsck.ts:40`) then see a boundary
   as a root commit with no out-edge to the absent parent — so no `missingIds` entry, no
   `brokenEdges` entry, exit bitmask 0 (pin A32: `git fsck --strict --no-progress` is clean
   on a shallow clone). Two things to verify with `find_referencing_symbols` **before**
   editing: (a) no consumer of the cache re-hashes the parsed object — content validation
   reads raw bytes in its own pass, so grafting must not weaken hash checking; (b) what
   `processCommit`'s `state.rootCommits.push(id)` (fired when `parents.length === 0`) feeds —
   a boundary now becomes a root commit, and if root commits surface as findings the report
   would gain a spurious entry. `buildInEdgeMap`'s `recordOutEdges` reads the same cached
   objects, so the dangling-vs-unreachable classification is masked consistently.

**Unchanged:** `read-object.ts` and `cat-file*` stay raw — Part 2's A8/A9 assertion is the
standing negative control that this part must not break.

**Unit tests** — one focused suite per site, memory adapter with a hand-written
`${ctx.layout.gitDir}/shallow`:
`test/unit/application/commands/rev-parse.test.ts` (`HEAD~1` resolves, `HEAD~2` refuses with
`OBJECT_NOT_FOUND` — use try/catch and assert `err.data.code` plus the offending oid, never a
bare `toThrow(Class)`), `name-rev.test.ts`, `merge-base.test.ts`, `bisect-midpoint.test.ts`,
`fsck.test.ts` (clean report on a shallow universe). `merge-base.properties.test.ts` already
exists — check that the added graft does not break its DAG properties; if a property now
needs a shallow-free `Context`, say so in the arbitrary, do not weaken the property.

**Interop rows added to `test/integration/shallow-walk-interop.test.ts`** (reuse `F1`, and
`F3` for the merge case):

- **A12/A13**: `revParse(ctx, 'HEAD~1')` ⇒ `C4`; `revParse(ctx, 'HEAD~2')` and
  `revParse(ctx, '<C4>^')` reject; co-assert `tryRunGitWithExit(['-C', F1, 'rev-parse',
  'HEAD~2'])` exits 128.
- **A18/A20/A21**: `mergeBase(ctx, [C5, C4])` ⇒ `[C4]`; ancestry holds; `{ all: … }` /
  independent-set behaviour matches `git merge-base --independent HEAD <C4>` ⇒ `C5`.
- **A19**: `mergeBase(ctx, [C5, C3])` rejects; git exits 128 with
  `fatal: Not a valid commit name`.
- **A30**: `nameRev` on HEAD resolves the same name git prints for `git -C F1 name-rev HEAD`.
- **A32**: `fsck(ctx, { strict: true })` reports no findings and a 0 exit bitmask; co-assert
  `git -C F1 fsck --strict --no-progress` exits 0.
- **A37**: `bisectMidpoint(ctx, { good: C4, bad: C5 })` completes and its structured counts
  are consistent with `git -C F1 bisect start HEAD <C4>` reporting `C5` (reconstruct from the
  structured fields; do not compare git's prose).
- **B7 follow-up**: if Part 2 deferred the `F3` `mergeBase(merge, main1)` assertion, land it
  here.

### TDD steps

1. **RED** — `rev-parse` unit test: `HEAD~1` ⇒ boundary; `HEAD~2` ⇒ `OBJECT_NOT_FOUND` (two
   separate tests). Fails: `HEAD~2` currently *succeeds* and returns a phantom oid.
2. **GREEN** — graft in `getNthParent`.
3. **RED/GREEN** — `merge-base` unit test (boundary is the base; no throw walking past it) →
   graft `makeReadCommit`; re-verify the existing equivalent-mutant comment still holds.
4. **RED/GREEN** — `bisect-midpoint` unit test → graft `readCommitEntry`.
5. **RED/GREEN** — `name-rev` unit test → graft `expandParents` (+ the peeled tip in
   `seedRef`).
6. **RED/GREEN** — `fsck` unit test: a shallow universe reports clean → graft the commit
   objects entering `buildObjectCache`.
7. **RED** — interop rows A12/A13, A18–A21, A30, A32, A37 (and B7 if deferred).
   **GREEN** — fix until green; re-run the whole interop file so Parts 2–4's rows stay green.
8. **REFACTOR** — five sites now repeat `await loadShallowSet(ctx)`; if three or more of them
   sit in the same tier and the repetition is literal, extract a single grafted-read helper
   **only if** it does not cross the `repository → commands → primitives → domain` dependency
   rule; otherwise leave the five call sites explicit and note why.

### Gate

```
npx vitest run test/unit/application/commands/rev-parse.test.ts \
  test/unit/application/commands/name-rev.test.ts \
  test/unit/application/commands/fsck.test.ts \
  test/unit/application/commands/fsck.properties.test.ts \
  test/unit/application/primitives/merge-base.test.ts \
  test/unit/application/primitives/merge-base.properties.test.ts \
  test/unit/application/primitives/bisect-midpoint.test.ts \
  test/integration/shallow-walk-interop.test.ts \
  test/integration/fsck-interop.test.ts \
  test/integration/bisect-midpoint-interop.test.ts \
&& npm run check:types \
&& ./node_modules/.bin/biome check src/application/commands/rev-parse.ts src/application/commands/name-rev.ts src/application/commands/internal/fsck/object-cache.ts src/application/primitives/merge-base.ts src/application/primitives/bisect-midpoint.ts test/integration/shallow-walk-interop.test.ts
```

(All paths above were verified to exist at planning time.)

### Commit

`fix(shallow): graft boundary parents in direct parent readers`
