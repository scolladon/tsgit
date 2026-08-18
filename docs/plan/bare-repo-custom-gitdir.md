# Plan — Bare repositories and explicit layout arguments

> Source: design doc `docs/design/bare-repo-custom-gitdir.md` · ADRs 653–664
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

### Partition rationale — read this before starting any part

Four parts, strictly ordered. Part 3 is deliberately the largest and **must not be split
further**: making `RepositoryLayout.workDir` optional breaks ~52 read sites across 28
source files at once; the only sanctioned resolution for those sites is the new
`requireWorkTree` gate (ADR-653/654); and that gate's `workDir === undefined` branch is
unreachable-and-untestable until Stage-2/3 resolution actually produces a work-tree-less
layout. Type break, gate, sweep and resolution are mutually required for a green
boundary — any cut between them lands a red `npm run validate` or a knowingly-unfaithful
intermediate state (e.g. `blame` refusing in a bare repo where git blames HEAD).

Interop scenarios A–Q ride with the behaviour they pin, never as a trailing test-only
part: Part 3 creates `test/integration/bare-repo-custom-gitdir-interop.test.ts` with
scenarios A, B, C, F, G, H, I, K, N, O, P; Part 4 extends the same file with D, E, J, L,
M, Q.

#### Facts measured during planning — do not re-derive

- **`src/application/primitives/internal/config-ini.ts` is at 100 % stmt / 99.44 % branch
  / 100 % func / 100 % line** today (measured with
  `npx vitest run --project unit --coverage --coverage.include='src/application/primitives/internal/config-ini.ts'`).
  The single uncovered branch is **line 268**, the `: undefined` arm of
  `malformedPartialName`. `src/application/**` is **outside** the coverage include list
  (`vitest.config.ts:82-88` includes only `src/domain/**`, `src/ports/**`,
  `src/adapters/node/**`, `src/adapters/memory/**`, `src/operators/**`), so moving this
  file into `src/domain/config/` puts it under the **100 % threshold** for the first
  time, and into the **`domain` mutation bucket** (`mutation-budgets.json`: high 100 /
  low 100 / break 99) instead of `application` (break 95). Part 1 must close that branch.
- **`test-pyramid-budgets.json` has NO per-file registry.** Its keys are
  `$schema`, `tiers`, `heuristics`, `gating`, `excludePaths`. The integration tier is a
  *ratio* band (`target 15`, `warnBelow 10`, `warnAbove 25`). Measured file counts today:
  unit 595, integration 124, e2e 6, parity 2, runtime-parity 5, perf 1 → integration is
  16.9 %; adding one integration file gives 17.0 %. **No manifest edit is required or
  possible** — do not hunt for an entry that does not exist.
- **`check:doc-coverage` and `check:browser-surface` both extract facade members with
  `/^ {2}readonly (\w+):\s*BindCtx</gm` and `/^ {2}readonly (\w+):\s*commands\.\w+Namespace/gm`**
  (`tooling/check-doc-coverage.ts:17,21`, `tooling/audit-browser-surface.ts:26,32`).
  `readonly layout: RepositoryLayout;` matches neither, so the new facade field trips
  **no** doc-coverage page requirement and **no** browser-surface parity requirement.
- **`check:write-surfaces` is warn-only in `validate`** (no `--blocking` flag in the
  wireit command). `interopSurface: layout` will be reported as orphan coverage exactly
  the way the existing `interopSurface: worktree` claim is
  (`test/integration/linked-worktree-discovery-interop.test.ts:15`) — that is the
  established, accepted shape. What IS mandatory:
  `tooling/audit-write-surfaces/parse-interop-surface.ts` **requires** an
  `interopSurface:` line on any `bucket: cross-tool-interop` test.
- **`src/application/commands/diff.ts` has no working-tree-comparing shape.** Measured:
  `DiffOptions` carries only `from?: string` / `to?: string`
  (`diff.ts:11-12`), both resolved through `resolveTreeish` (`diff.ts:54-55`), and
  `DiffTreesInput = Tree | ObjectId | undefined`
  (`src/application/primitives/types.ts:246`). tsgit's `diff` is tree↔tree only; working
  tree vs index lives in `status.ts`. **Design §6's `diff.ts` sweep row is therefore a
  no-op** — `diff` stays ungated, which is the faithful answer for the shapes tsgit can
  express (git's `diff --cached` and `diff <tree> <tree>` both exit 0 in a bare repo per
  §1f; git's worktree-comparing `diff` / `diff HEAD` have no tsgit counterpart). Pin it
  with a positive interop row, do not invent an option.
- **The parity tier cannot express a bare layout.** `test/parity/node.test.ts:43` and
  `test/parity/memory.test.ts:29` construct the `Repository` themselves
  (`openRepository({ cwd: tmpDir })` / `openRepository({ files })`) and `Scenario`
  (`test/parity/scenarios/types.ts`) has no open-override hook; the browser driver
  additionally hardcodes `openRepository({ rootHandle })` inside the page bundle
  (`test/browser/parity.spec.ts:28-32`). Adding a bare parity scenario would require a
  cross-driver harness change including the Playwright bundle. The design's
  cross-adapter proof is therefore delivered at the **unit** tier against the real
  sandboxed shims: `test/unit/repository/memory-shim-discovery.test.ts` (drives the real
  memory `openRepository` over a seeded `MemoryFileSystem`) and
  `test/unit/index.browser.test.ts` (drives the real browser shim + `resolveFixedEntryLayout`).
  **Do not add a `test/parity/scenarios/*.scenario.ts` file.**
- **`src/application/commands/internal/repo-state.ts` is a 16-line deprecated re-export
  shim** over `src/application/primitives/internal/repo-state.ts`. It re-exports
  `assertNotBare` and `isBare` — both deleted in Part 3, so the shim's export list must
  shrink with them.
- **`stash.ts` imports repo-state from `../primitives/internal/repo-state.js`** (line
  30-36), not `./internal/`. So do `remote.ts:16`, `revert.ts:42`, `cherry-pick.ts:41`,
  `rebase.ts:52`. Every other swept command uses `./internal/repo-state.js`.

#### Cross-cutting rules for every part

- No provenance refs (phase / ADR / backlog / design-section numbers) anywhere in source
  or test code. Comments explain *why*, never *which document*.
- No suppression directives (`@ts-ignore`, `biome-ignore`, `v8 ignore`, `stryker-disable`)
  without explicit user approval. Existing `Stryker disable next-line` comments carried
  along by a pure file move stay as-is — but re-verify each proof still holds against the
  moved structure before keeping it.
- Test conventions: `describe('Given …')` > `describe('When …')` > `it('Then …')`;
  Arrange/Act/Assert section comments; the function under test is bound to `sut`, its
  return value to `result` (never `sut = await someCall()` unless the name is on
  `test-pyramid-budgets.json` → `heuristics.sutBindsResult.allowlist`).
- Error assertions assert `err.data` payloads (code + fields), never `toThrow(Class)`
  alone. Each guard clause gets its own isolated test.
- Real-`git` probes, if any are needed, run in a `mktemp -d` throwaway with `env -i`,
  isolated `HOME`, `GIT_CONFIG_NOSYSTEM=1`, every `GIT_*` scrubbed, signing off — never
  in the worktree, which shares `.git/config` with the main checkout. Prefer reading the
  design's §1 tables: every row is already measured against git 2.55.0.
- After any part that adds or moves a `src/` module, `check:size` / `check:tarball` can
  read stale: `rm -rf dist .wireit` and rebuild before trusting a size failure.
- Any part whose diff changes the published type surface runs `npm run docs:json` and
  commits `reports/api.json`. `validate` does **not** catch a stale api.json — the
  **prepush** hook does.

## Part 1 — Relocate the pure git-config grammar into the domain tier

### Context

**Why:** Stage-2 layout resolution (Part 3) lives in `src/repository/` and must parse
`<commonDir>/config` with the *same* grammar the command tier uses. The hexagonal rule is
`repository → commands → primitives → domain`, so `src/repository/` may not import
`src/application/primitives/internal/`. ADR-655 relocates the pure grammar to
`src/domain/config/`. This part is a **behaviour-preserving move plus the coverage debt
the move creates** — no semantic change whatsoever.

**Move:**
`src/application/primitives/internal/config-ini.ts` (807 lines) →
`src/domain/config/config-ini.ts`.

The file is already pure: its **only** non-local import is
`import { configParseError } from '../../../domain/commands/error.js';` (line 11), which
becomes `'../commands/error.js'` after the move. It has zero application-tier
dependencies, so nothing inverts.

**Exports it carries (all must survive the move byte-identically):**
`IniSection` (24), `ConfigToken` (38), `tokenizeConfig` (134), `tokenizeConfigLines` (142),
`skipGitSpace` (271), `parseIniSections` (298), `parseIniSectionsFromTokens` (307),
`SectionHeaderParse` (494), `HeaderPrefixScan` (594), `scanHeaderPrefix` (609),
`parseGitInt` (750), `GIT_C_INT_MAX` (786), `GIT_C_INT_MIN` (787), `parseGitBoolean` (796).

**Importers to rewrite (exactly three files, five import statements — measured):**
- `src/application/primitives/config-read.ts` lines 3, 11, 22, 28
- `src/application/primitives/config-scoped-read.ts` line 6
- `src/application/primitives/internal/config-scope.ts` lines 9, 10

**Do NOT add a barrel.** ADR-655 and design §10 keep the relocated grammar internal —
no `src/domain/config/index.ts`, no entry in `src/domain/index.ts`, no
`src/public-types.ts` change. Direct file imports are the established domain norm
(`src/ports/context.ts` imports `../domain/storage/lru-cache.js` directly). A new unused
barrel would also trip `check:dead-code` (knip).

**The coverage debt this move creates (the one non-mechanical piece):**
`vitest.config.ts:82-88` includes `src/domain/**/*.ts` in coverage with 100 %
line/branch/function/statement thresholds. Today the file sits at 99.44 % branch with a
single uncovered arm:

```ts
// src/application/primitives/internal/config-ini.ts:267-269
/** Partial name carried by a malformed parse, for the refusal message. */
const malformedPartialName = (parse: SectionHeaderParse): string | undefined =>
  parse.kind === 'malformed' ? parse.partialName : undefined;
```

Its sole caller is line 228, inside `emitHeaderLine`'s chained-header loop:

```ts
// lines 226-230
while (line[contentStart] === '[') {
  pushHeaderToken(tokens, current, lineIdx, false);
  current = scanHeaderPrefix(line, contentStart);
  if (current.parse.kind !== 'header') {
    throw configParseError(lineIdx + 1, source, malformedPartialName(current.parse));
  }
```

`SectionHeaderParse` has three kinds — `'header'`, `'malformed'`, `'not-header'` — so
inside that guard the parse is either `'malformed'` (covered today) or `'not-header'`
(**the uncovered arm**). `scanHeaderPrefix` (`:609`) returns `NOT_HEADER_SCAN` for a
**plain** bracket span that has no closing `]` (`scanPlainHeaderPrefix:659`) or whose
inner name fails `PLAIN_SECTION_NAME = /^[A-Za-z0-9.-]+$/` (`:661`); it returns
`'malformed'` only for a bad **quoted** subsection. Concrete closing inputs, therefore —
git chains headers on one line (`[a][b]`):

| input to `tokenizeConfig` | parse kind at line 228 | partial name |
|---|---|---|
| `'[a][b c]\n'` | `'not-header'` (inner name has a space) | `undefined` ← **closes the branch** |
| `'[a][b\n'` | `'not-header'` (no closing `]`) | `undefined` ← same arm |
| `'[a][b "x\n'` | `'malformed'` (unterminated quoted subsection) | the partial name (already covered) |

Assert the thrown `err.data` (`code: 'CONFIG_PARSE_ERROR'`, `line`, `source`, and the
partial-name field present vs absent) — the presence/absence contrast between rows 1 and
3 is what kills the mutant that swaps the ternary arms. Verify with the same scoped
coverage command before committing.

Note the file also moves from the `application` mutation bucket (break 95) into the
`domain` bucket (`mutation-budgets.json`: high 100 / low 100 / **break 99**). The
mutation phase runs later, but write the new tests mutation-resistant now: assert
`err.data` (`code`, `line`, `source`, and the partial-name field) rather than error
classes, and give each guard its own test.

**No existing test imports `config-ini` directly** (measured: `grep -rln "config-ini" test/`
returns nothing). Its coverage arrives through
`test/unit/application/primitives/config-read.test.ts`,
`config-read.properties.test.ts`, `parse-git-int.test.ts`,
`config-int.properties.test.ts`, `commondir-config.test.ts`, `update-config.test.ts` and
siblings — none of those files' import paths change, so none of them need editing.

**New test file:** `test/unit/domain/config/config-ini.test.ts` (mirror-path convention).
Keep it narrow: it exists to pin the grammar's own contract directly and to close the
line-268 branch, not to duplicate the existing indirect suites.

**Do not split the file.** It is 807 lines — over the soft 800-line style budget on
`main` already. A pure relocation must stay diff-reviewable; splitting is a
refactor-phase concern and this part does not regress the number.

**Gates this part touches:** `check:architecture` (dependency-cruiser over `src/` — the
move must not create an outward domain import), `test:coverage` (the new 100 % scope),
`check:filesystem` (ls-lint kebab-case — `config-ini.ts` is already compliant),
`check:dead-code` (knip — no orphan file left behind at the old path).

### TDD steps

1. **RED** — add `test/unit/domain/config/config-ini.test.ts` importing from
   `../../../../src/domain/config/config-ini.js`. Cover, each in its own
   Given/When/Then triple: (a) `tokenizeConfig` over a well-formed
   `[section "sub"]` + entry produces the header + entry tokens with correct `line` and
   `hasComment`; (b) `tokenizeConfig('[a][b "x\n')` throws `CONFIG_PARSE_ERROR` carrying
   the partial name in `data`; (c) `tokenizeConfig('[a][b c]\n')` throws
   `CONFIG_PARSE_ERROR` with **no** partial name — the uncovered arm; (d)
   `parseGitBoolean(null)` is `{ ok: true, value: true }` and `parseGitBoolean('banana')`
   is `{ ok: false }`.
   Expected failure: `Cannot find module '.../src/domain/config/config-ini.js'` — the
   file does not exist yet.
2. **GREEN** — `git mv src/application/primitives/internal/config-ini.ts
   src/domain/config/config-ini.ts`; fix its own import of `configParseError` to
   `../commands/error.js`; rewrite the five import statements in the three importer
   files listed above. Run `npm run check:types`.
3. **REFACTOR** — re-read each `Stryker disable next-line` comment carried into the new
   file and confirm its equivalence proof still describes the code it now anchors on
   (directives anchor on the expression line, and a move can shift what a line means).
   Delete none, rewrite any whose wording no longer matches.
4. **VERIFY COVERAGE** — run
   `npx vitest run --project unit --coverage --coverage.include='src/domain/config/config-ini.ts' --coverage.thresholds.100=false --coverage.reporter=text`
   and confirm 100 / 100 / 100 / 100. Iterate on step 1 until it is.
5. **VERIFY SURFACE** — `npm run docs:json`; commit `reports/api.json` only if it changed.

### Gate

```
npx vitest run test/unit/domain/config/config-ini.test.ts test/unit/application/primitives/config-read.test.ts test/unit/application/primitives/config-read.properties.test.ts test/unit/application/primitives/parse-git-int.test.ts test/unit/application/primitives/config-int.properties.test.ts test/unit/application/primitives/commondir-config.test.ts test/unit/application/primitives/update-config.test.ts && npm run check:types && ./node_modules/.bin/biome check src/domain/config/config-ini.ts src/application/primitives/config-read.ts src/application/primitives/config-scoped-read.ts src/application/primitives/internal/config-scope.ts test/unit/domain/config/config-ini.test.ts
```

Then `npm run check:architecture` and the scoped coverage command from step 4.

### Commit

```
refactor: relocate the pure git-config grammar into the domain tier
```

## Part 2 — Parse `HEAD` content when discovery decides a directory is a git directory

### Context

**Why:** Part 3 makes *any* directory a discovery candidate at every walk level, so a
directory holding three innocuous entries named `HEAD`, `objects/`, `refs/` would shadow
an enclosing repository. Today's predicate only `stat`s `HEAD`. ADR-659 closes that: parse
the content. Landing it **before** Part 3 keeps the security-relevant narrowing separable
and independently reviewable.

**Current predicate — `src/repository/find-layout.ts:162-174`:**

```ts
const isGitDirectory = async (
  probe: LayoutProbe,
  gitDir: string,
  commonDir: string,
  pathPolicy: PathPolicy,
): Promise<boolean> => {
  const head = await probe.stat(pathPolicy.join(gitDir, 'HEAD'));
  if (head?.isFile !== true) return false;
  const objects = await probe.stat(pathPolicy.join(commonDir, 'objects'));
  if (objects?.isDirectory !== true) return false;
  const refs = await probe.stat(pathPolicy.join(commonDir, 'refs'));
  return refs?.isDirectory === true;
};
```

Its doc comment (lines 154-161) states the stat-only rationale explicitly and **must be
rewritten** to describe the new predicate and the one residual divergence.

**New module: `src/domain/repository/head-ref.ts`** — beside `src/domain/repository/error.ts`.
Pure, no I/O, no ports. Export a total function:

```ts
export const isValidHeadContent = (content: string): boolean => …
```

(Name it for what it answers; do not call it `parseHeadRef` unless it actually returns a
parsed value — it does not need to.) The grammar, from design §1b, pinned against git
2.55.0 — reproduce these rows exactly, do not re-probe git:

| `HEAD` content | verdict |
|---|---|
| `ref: refs/heads/main\n` | valid |
| `ref: refs/heads/main` (no trailing newline) | valid |
| `ref:refs/heads/main\n` (no space) | valid |
| `ref:` + several spaces + `refs/heads/main\n` | valid |
| `ref: refs/heads/../evil\n` | **valid** — the refname is NOT format-checked |
| 40 lowercase hex chars | valid (detached, SHA-1 width) |
| 64 lowercase hex chars | valid (detached, SHA-256 width) |
| `ref: main\n` (single level, no `refs/` prefix) | **invalid** |
| 40 non-hex chars | **invalid** |
| empty | **invalid** |

Rule, stated once in the module doc comment: content is valid iff it parses as a hex
object id of width 40 or 64, **or** it begins `ref:` and the first whitespace-delimited
token after that prefix begins `refs/`.

**Residual, deliberate divergence to record in the module doc comment (why, not which
document):** git also accepts a `HEAD` that is a *symlink whose link text* begins `refs/`
even when the target does not exist; `LayoutProbe` exposes only `stat` (following) and
`readUtf8`, so tsgit rejects that shape. A `HEAD` symlink to an existing valid target is
still accepted, because `stat` follows and `readUtf8` reads through.

**Wiring in `find-layout.ts`:** keep the `stat` (it still rejects a `HEAD` *directory* —
design §1b row) then add a `readUtf8` + `isValidHeadContent` check before the
`objects`/`refs` probes. `probe.readUtf8` returning `undefined` (absent / unreadable /
containment-denied — the documented port contract, `src/ports/layout-probe.ts:24-28`)
means "not a git directory", i.e. `return false`. Cap the read the way the gitfile reads
are capped: `head.size > GITFILE_MAX_BYTES` (the existing const at
`find-layout.ts:77`, 65536) → `return false` (**not** a throw — this branch is a
candidate check, not a commitment; throwing would turn a hostile planted file into a
hard stop, which is the opposite of what the skip-and-climb contract wants).

**Ordering matters for cost:** `stat` first (cheap, rejects directories and absence),
then `readUtf8`, then `objects`, then `refs`. Do not reorder.

**Blast radius on existing tests — sweep before assuming green.** Any fixture that seeds a
`HEAD` file with content the new predicate rejects will flip from "repo found" to "walk
climbs past". `test/unit/repository/find-layout.test.ts:15-20`'s `makeGitDir` helper
already writes `'ref: refs/heads/main\n'` (valid). Grep the repo for other seeds:
`grep -rn "HEAD'" test/unit/repository/ test/unit/index.browser.test.ts` and
`grep -rln "'/repo/.git/HEAD'\|/HEAD'," test/` — fix any that seed empty or junk HEAD,
and add a deliberate junk-HEAD row proving the new refusal.

**Test files:**
- `test/unit/domain/repository/head-ref.test.ts` (new) — every table row above as its own
  Given/When/Then triple. Each rejection gets an isolated test (guard-clause rule).
- `test/unit/domain/repository/head-ref.properties.test.ts` (new). Design §Test strategy
  names `test/unit/domain/config/head-ref.properties.test.ts`; that path is inconsistent
  with the module's home — use the **mirror path** of the source file, which is the
  repo's mechanical convention. Three properties, per design:
  - totality: never throws on arbitrary printable-ASCII content ≤ 4 KiB — `numRuns: 100`;
  - `isValidHeadContent('ref: ' + refname)` is true for arbitrary refnames beginning
    `refs/` — `numRuns: 200`;
  - `isValidHeadContent(hex(n))` is true iff `n ∈ {40, 64}` — `numRuns: 200` (the
    hash-width lens).
  Generators go in `test/unit/domain/repository/arbitraries.ts` (new). Model it on
  `test/unit/repository/arbitraries.ts`, which builds character sets from **integer
  ranges** rather than string literals — a base64/hex alphabet written as a literal
  trips the `CKV_SECRET_6` scan in `check:security`. Never commit a seed.
- `test/unit/repository/find-layout.test.ts` (extend) — a directory with
  `objects/` + `refs/` + `HEAD` containing `garbage` is **not** a repo (walk climbs past);
  a `HEAD` holding 64 hex chars **is**; a `HEAD` directory is not.

**Coverage:** `src/domain/**` is in the 100 % include list, so `head-ref.ts` needs full
line/branch/function coverage from the unit test — the property test does not count
toward the threshold in a useful way. `src/repository/find-layout.ts` is **outside** the
coverage scope but **inside** the `application` mutation bucket (break 95).

### TDD steps

1. **RED** — `test/unit/domain/repository/head-ref.test.ts` against
   `src/domain/repository/head-ref.js`. Expected failure: module not found.
2. **GREEN** — implement `isValidHeadContent` in `src/domain/repository/head-ref.ts`.
   Small functions, early returns, no nesting > 2, named constants for the two hash
   widths and the `ref:` prefix.
3. **RED** — `test/unit/repository/find-layout.test.ts`: add the junk-`HEAD` row asserting
   `findLayout` returns `undefined`. Expected failure: it currently returns a layout,
   because `isGitDirectory` only `stat`s.
4. **GREEN** — rewire `isGitDirectory` (read + validate + size cap) and rewrite its doc
   comment.
5. **RED** — add `head-ref.properties.test.ts` + `arbitraries.ts`. Expected failure on
   any grammar hole the examples missed; shrink to the counterexample and fix the source,
   not the property.
6. **REFACTOR** — sweep every remaining `HEAD` seed in the test tree (command above) and
   fix any that the narrowed predicate now rejects; confirm the full unit project is green.

### Gate

```
npx vitest run test/unit/domain/repository/head-ref.test.ts test/unit/domain/repository/head-ref.properties.test.ts test/unit/repository/find-layout.test.ts test/unit/repository/memory-shim-discovery.test.ts test/unit/index.browser.test.ts && npm run check:types && ./node_modules/.bin/biome check src/domain/repository/head-ref.ts src/repository/find-layout.ts test/unit/domain/repository/head-ref.test.ts test/unit/domain/repository/head-ref.properties.test.ts test/unit/domain/repository/arbitraries.ts test/unit/repository/find-layout.test.ts
```

Then the scoped coverage check on `src/domain/repository/head-ref.ts`.

### Commit

```
feat: validate HEAD content when discovery decides a directory is a git directory
```

## Part 3 — Work-tree-less repositories: cwd-is-gitdir discovery, config-driven work tree, and the work-tree gate

### Context

This is the largest part and the only one that must land whole. It delivers requirements
R1–R4b, R6, R7, R10 (read direction), R11, R12, R13 and ADRs 653, 654, 656, 660, 661, 662,
664. Explicit `gitDir` / `workDir` / `bare` / `ceilingDirs` arguments are **Part 4** — this
part changes only the discovery-driven routes.

#### 3.1 The layout shape (ADR-653)

`src/ports/context.ts:21-44` — `RepositoryLayout`:

```ts
export interface RepositoryLayout {
  /** Absolute path to the working tree. Absent when the repository has none. */
  readonly workDir?: string;              // was: readonly workDir: string;
  readonly gitDir: string;
  readonly commonDir?: string;
  readonly bare: boolean;
  readonly workTreeConfigBogus?: boolean; // NEW
  readonly homeDir?: string;
}
```

`src/repository.ts:127-138` — `RepositoryLayoutInput` mirrors it: `workDir?: string`,
plus `workTreeConfigBogus?: boolean`.

`src/ports/context.ts:178-180` — `createContext`:
`cwd: parts.cwd ?? parts.layout.workDir ?? parts.layout.gitDir`. This matches git, whose
`--show-prefix` is empty and `--is-inside-git-dir` is `true` in exactly that shape. The
`Context.cwd` doc comment at `:109` ("Defaults to layout.workDir when not set by the
facade") states the old rule and must be updated with it.

**Helpers `resolve-layout.ts` needs from `find-layout.ts` are currently non-exported** —
export them (or lift them into a shared module) rather than duplicating:
`resolveCommonDir` (`:136`) and `GITFILE_MAX_BYTES` (`:77`). `resolvePointer` (`:89`) is
needed by Part 4; leave it alone here.

**New export from `find-layout.ts` for the walk**, so `resolveLayout` can see the route:

```ts
export type WalkRoute = 'DISCOVERED' | 'BARE_DIR';
export interface WalkOutcome {
  readonly gitDir: string;
  readonly commonDir?: string;
  readonly route: WalkRoute;
  /** The directory holding the `.git` entry. Present only for `DISCOVERED`. */
  readonly origin?: string;
}
```

`findLayout`'s current `RepositoryLayoutInput | undefined` return is no longer the right
shape (it hardcodes `workDir` and `bare: false` at `:120-128`). Replace it with the walk
returning `WalkOutcome | undefined` and let `resolveLayout` build the layout; keep
`layoutFromGitfile` exported — `fixed-entry-layout.ts` still calls it.

The project runs `exactOptionalPropertyTypes: true` — never write
`workDir: undefined`; omit the key (the established pattern at `find-layout.ts:124-127`).

#### 3.2 Stage 2 — `readRepositoryFormat` (new, ADR-661/664)

New file `src/repository/read-repository-format.ts`. Signature:

```ts
export const readRepositoryFormat = async (
  probe: LayoutProbe,
  gitDir: string,
  commonDir: string,
  pathPolicy: PathPolicy,
): Promise<RepositoryFormat> => …

export interface RepositoryFormat {
  readonly bare: boolean | 'malformed' | undefined;
  readonly worktree: string | null | undefined;   // null = present-but-valueless
  readonly worktreeConfig: boolean;
}
```

Scope, exactly: read `<commonDir>/config`; if `extensions.worktreeConfig` is true there,
**also** read `<gitDir>/config.worktree` and let its `core.bare` / `core.worktree` win.
**No** global, **no** system, **no** `include.path` expansion. Extract only `core.bare`,
`core.worktree`, `extensions.*`. Everything else in the file is ignored here and
validated later by the existing two-tier gates on first command.

Parse with the Part-1-relocated grammar: `tokenizeConfig` + `parseIniSectionsFromTokens`
+ `parseGitBoolean` from `src/domain/config/config-ini.js`. Section and key matching is
case-insensitive on the git side; follow what `parseIniSections` already yields (see how
`src/application/primitives/internal/config-scope.ts` consumes `IniSection`).

Reuse `LayoutProbe.readUtf8` and cap the read with the same 65536-byte limit
`find-layout.ts:77` uses (`GITFILE_MAX_BYTES` — export it from `find-layout.ts` or lift
it into a shared module; do not duplicate the literal).

Layering note so nobody panics at review: `src/repository/` importing
`src/domain/config/config-ini.js` is domain-ward and allowed (`find-layout.ts:2-5`
already imports from `src/domain/`), and `import type { PathPolicy } from
'../adapters/node/path-policy.js'` is the one explicitly permitted adapter import for
this tier (`find-layout.ts:1` already does it).

Absent config file ⇒ `{ bare: undefined, worktree: undefined, worktreeConfig: false }`.

**This read is deliberately NOT cached into the Context config cache**
(`config-read.ts:151-201`'s `WeakMap<Context, …>`): it happens before a Context exists,
reads a different key subset, and sharing state would couple `openRepository`'s failure
modes to the command-tier cache. One extra `readUtf8` of a sub-kilobyte file per open.

**Refusal timing (ADR-664):** `bare === 'malformed'` → throw
`configBadBooleanValue(key, source, value)`; `worktree === null` → throw
`configMissingValue(key, source, line)`. Both at **open time**, from Stage 2, not at
first command. Factories: `src/domain/commands/error.ts:548` (`configMissingValue`) and
`:587` (`configBadBooleanValue`). Payload shapes are unchanged from what
`assertDiscoveryBooleansValid` throws today, so the existing interop assertions keep
their `data` expectations and only move their call site.

#### 3.3 Stage 1 + 3 — `resolveLayout` (new)

New file `src/repository/resolve-layout.ts`. This part implements the **discovery**
routes only (`DISCOVERED`, `BARE_DIR`); Part 4 adds `EXPLICIT`. Write the route union
now so Part 4 only fills an arm.

Walk change in `src/repository/find-layout.ts` — one addition per level, ordered so the
common path costs nothing extra (design §2, R12):

```
walk(probe, cwd, policy):
  current := policy.resolve(cwd)
  loop:
    candidate := policy.join(current, '.git')
    st := probe.stat(candidate)
    if st is directory: if layoutFor(...) defined → (that gitDir, DISCOVERED, current)
    else if st is file: → gitfile branch (hard stop or DISCOVERED)   # unchanged
    #  ── new: is `current` itself a git directory? ──
    if probe.stat(join(current,'HEAD')) is a file:                   # cheap gate first
      if isGitDirectory(probe, current, resolveCommonDir(current)):
        return (current, BARE_DIR, undefined)
    parent := policy.dirname(current)
    if parent === current: return NOT_FOUND
    current := parent
```

**Cost contract (R12):** a level with no `.git` costs 1 `stat` today, 2 after. A level
that holds a valid `.git` short-circuits **before** the new probe and is unchanged.
Only a level that actually holds a `HEAD` *file* goes on to `commondir` + `objects` +
`refs`. Do **not** inline `isGitDirectory` ahead of the cheap `HEAD` stat — that would
cost three extra stats per level on every walk.

Stage 3 precedence (design §1c, each row wins over the rows below):

| # | condition | work tree |
|---|---|---|
| R1c-2 | `core.bare` is true | **none**; if `core.worktree` is also set, `workTreeConfigBogus = true` |
| R1c-3 | `core.worktree` set, absolute | `policy.resolve(value)` |
| R1c-4 | `core.worktree` set, relative | `canonicalise(policy.resolve(policy.join(gitDir, value)))` — physical, ADR-660 |
| R1c-6 | route `DISCOVERED`, nothing above | the directory holding the `.git` entry |
| R1c-7 | route `BARE_DIR`, nothing above | **none** |

(R1c-1 `opts.workDir` and R1c-5 `route = EXPLICIT` are Part 4.)

Stage 4 — the derived answer:

```
bare := bareCfg !== false  AND  workDir is none
```

`bareCfg` **unset** (no `core.bare` key at all) is **truthy** here — git's
`is_bare_repository_cfg` defaults to `-1`, not `0`. This is design §1d row 5 and it is
the single most-likely-to-be-got-wrong line in the part. Four-row truth table in the
unit tests.

**Relative `core.worktree` is resolved physically (ADR-660):** git `chdir`s to the
gitDir, `chdir`s to the value, then takes `getcwd()`. On node that means realpath after
resolving; sandboxed adapters stay lexical (the existing ADR-537 split). A symlinked
work tree therefore resolves to its real path.

**Leniency is required, not optional:** layout resolution must accept a `gitDir` that is
not yet a repository — `assertRepository` refuses at first command, and that is the only
way `init`/`clone` can bootstrap into an empty directory. The walk routes keep today's
semantics: `.git` directory = candidate (skip and climb if invalid), `.git` file =
commitment (resolve or throw).

#### 3.4 The work-tree gate (ADR-654/656)

`src/domain/repository/error.ts` — widen the union and add two factories beside the
existing three:

```ts
export type RepositoryError =
  | { readonly code: 'NOT_A_REPOSITORY';         readonly path: FilePath }
  | { readonly code: 'BARE_REPOSITORY';          readonly operation: string }
  | { readonly code: 'WORK_TREE_REQUIRED';       readonly operation: string }   // new
  | { readonly code: 'WORK_TREE_CONFIG_INVALID'; readonly gitDir: string }      // new
  | { readonly code: 'ALREADY_INITIALIZED';      readonly path: FilePath };
```

`BARE_REPOSITORY` is **kept** and narrowed to its one faithful use (`reset --mixed`) —
deleting a published code is a breaking change for callers already catching it.

`src/application/primitives/internal/repo-state.ts` — the gate, replacing
`assertNotBare` (`:218`) and `isBare` (`:209`), both **deleted**:

```ts
/** git's `setup_work_tree()`: refuse when the work-tree config is bogus, then when
 *  there is no work tree. Returns the work tree so callers stop reading it unguarded. */
export const requireWorkTree = (ctx: Context, operation: string): string => {
  if (ctx.layout.workTreeConfigBogus === true) throw workTreeConfigInvalid(ctx.layout.gitDir);
  const workDir = ctx.layout.workDir;
  if (workDir === undefined) throw workTreeRequired(operation);
  return workDir;
};
```

**Synchronous** — the layout is already resolved, so unlike `assertNotBare` it costs no
config read and needs no `await`. It keeps `assertNotBare`'s **position** in each command
(immediately after `assertOperationalRepository`), so config-validity still refuses
before work-tree absence, matching git.

**Synchronous-throw hazard — check this at every call site.** Replacing an `await`ed
call with a synchronous one changes *how* the error escapes for any function that returns
a promise **without** being `async`: the throw becomes synchronous and bypasses the
promise, breaking `.catch()`-shaped callers. Every swept site is inside an `async`
function **except** `submoduleSync` (`submodule.ts:752-755`), which is a plain arrow
delegating to `syncLevel`. Gate that one **inside `syncLevel`** (right after its
`assertOperationalRepository(ctx)` at `:294`), not in `submoduleSync`. The recursive
re-gate on child contexts is harmless: a submodule Context always has a work tree.
Audit every call site — the 28 repoints in table A plus the new rows in table B — for
this shape before editing.

`isBare(ctx)` is deleted rather than re-pointed: with `layout.bare` correct at open time,
a second config-derived answer that can disagree with it is the very defect this change
removes. Also drop `assertNotBare` and `isBare` from the re-export list in the deprecated
shim `src/application/commands/internal/repo-state.ts`.

#### 3.5 Surface gates for the two new error codes — pre-pay these in-part

Both codes are **public** (`RepositoryError` is part of the published type closure).

1. `src/domain/repository/error.ts` — union member + factory (`workTreeRequired`,
   `workTreeConfigInvalid`).
2. `src/domain/error.ts` — two `extractDetail` arms beside `case 'BARE_REPOSITORY':`
   (line 301). Wording follows git's conditions as data, not git's rendered bytes:
   e.g. `` `operation requires a working tree: ${data.operation}` `` shape for
   `WORK_TREE_REQUIRED` and a gitDir-naming form for `WORK_TREE_CONFIG_INVALID` — pick
   one and pin it exactly in the test below.
3. `test/unit/domain/exhaustiveness.ts` — two new `case` labels (the file's own doc
   comment says widening the union only requires editing it here). Missing this is a
   **compile error**, so it cannot be forgotten.
4. `test/unit/domain/repository/error.test.ts` — add factory-data cases **and**
   `extractDetail` exact-message rows to the existing `cases` table (the file already has
   both blocks; extend, do not restructure).
5. `npm run docs:json`, commit `reports/api.json` — the union widens and
   `RepositoryLayout.workDir` becomes optional, so api.json goes stale. `validate` will
   **not** tell you; the prepush hook will.

`docs/use/errors.md` gains two rows — that is the documentation phase's job, not this
part's; there is no validate gate on it.

#### 3.6 The full sweep — every site, pre-inventoried

**A. Repoint `assertNotBare` → `requireWorkTree` (28 call sites, 16 modules).** Same
position, drop the `await`:

| module:line | operation string |
|---|---|
| `add.ts:98` | `'add'` |
| `checkout.ts:310` | `'checkout'` |
| `commit.ts:100` | `'commit'` |
| `mv.ts:99` | `'mv'` |
| `rm.ts:69` | `'rm'` |
| `merge.ts:164` | `'merge'` |
| `abort-merge.ts:33` | `MERGE_ABORT` |
| `continue-merge.ts:35` | `'merge --continue'` |
| `cherry-pick.ts:431,536,589,623` | `CHERRY_PICK`, `CHERRY_PICK_CONTINUE`, `CHERRY_PICK_SKIP`, `CHERRY_PICK_ABORT` |
| `revert.ts:415,494,540,566` | `REVERT`, `REVERT_CONTINUE`, `REVERT_SKIP`, `REVERT_ABORT` |
| `rebase.ts:453,528,569,595` | `'rebase'`, `'rebase --continue'`, `'rebase --skip'`, `'rebase --abort'` |
| `pull.ts:96` | `'pull'` |
| `sparse-checkout.ts:71` | `'sparse-checkout'` |
| `stash.ts:196,297,429` | `'stash'`, `'stash drop'`, `'stash apply'` |
| `submodule.ts:634,757` | `'submodule add'`, `'submodule update'` |
| `reset.ts:64` | `'reset --hard'` (see row B4) |

All import from `./internal/repo-state.js` except `stash.ts` (line 30-36) and
`revert.ts:42` / `cherry-pick.ts:41` / `rebase.ts:52`, which import from
`../primitives/internal/repo-state.js`.

**B. New and conditional gates (design §6, corrected by measurement):**

| # | module | change |
|---|---|---|
| B1 | `status.ts` — signature `status(ctx)`, assertion at `:128` | **+** `requireWorkTree(ctx, 'status')` right after `assertOperationalRepository(ctx)` |
| B2 | `grep.ts` — `GrepOptions.target?: 'index' \| { treeish: string }` (`:56`), assertion at `:171` | **+ conditional**: gate only when `opts.target === undefined`. `'index'` and tree targets stay open (git: `grep --cached` and `grep <pat> HEAD` succeed in a bare repo) |
| B3 | `blame.ts` — `BlameOptions.worktree?: boolean` (`:47`), assertion at `:122`, worktree branch at `:129-132` | **+ conditional**: gate only when `opts.worktree === true` **and** `ctx.layout.bare === false`. In a bare repo git blames HEAD instead of refusing |
| B4 | `reset.ts:63-65` — `ResetMode = 'soft' \| 'mixed' \| 'hard'` (`:33`) | `'hard'` → `requireWorkTree`; **+** `'mixed'` → `throw bareRepository('reset --mixed')` when `ctx.layout.bare`; `'soft'` stays ungated. This closes a real index-write gap: `rebuildIndexFromCommit` acquires the index lock at `:99` and would create `<bare-gitdir>/index`, which git never does |
| B5 | `describe.ts` — `dirty?` (`:63`), `broken?` (`:65`), assertion `:103`, `computeDirty` call `:107` | **+ conditional**: `dirty` refuses; `broken` does **not** (git returns `<desc>-broken`, exit 0) — map `broken` to `broken: true` in the result without a work tree |
| B6 | `stash.ts:282-285` (`stashList`) | **+** gate — git refuses `stash list` in a bare repo |
| B7 | `stash.ts:483-491` (`stashPop`) | **+** gate before the `stashApply` delegation at `:487` |
| B8 | `submodule.ts` `submoduleInit:210`, `syncLevel:294` (**not** `submoduleSync` — see the synchronous-throw hazard), `submoduleDeinit:388`, `submoduleList:440` | **+** gates — all four are ungated today and read `.gitmodules` from `workDir` |
| B9 | `diff.ts` | **no change** — measured tree↔tree only (see the partition-rationale note). Pin the non-refusal with an interop row |
| B10 | `clone.ts:82-84` | the not-empty probe already reads `ctx.layout.gitDir`; only the error payload reads `workDir` → `workDir ?? gitDir` (a bare clone's target *is* the gitDir) |

**C. Compiler-forced `layout.workDir` reads — 52 sites, 28 files.** Three resolutions,
by category:

*C1 — root / fallback semantics → `workDir ?? gitDir`:*
- `src/ports/context.ts:179` (`createContext` cwd default)
- `src/application/primitives/internal/repo-state.ts:88` (`notARepository(...)` payload)
- `src/application/primitives/internal/repo-state.ts:91` (root selection —
  `ctx.layout.bare ? gitDir : workDir` becomes `workDir ?? gitDir`; provably identical
  today and correct for the work-tree-less-non-bare shape `bare` alone gets wrong)
- `src/application/primitives/path-layout.ts:16` (`getRepoRoot`)
- `src/application/commands/clone.ts:83`
- `src/application/commands/submodule.ts:155` (URL fallback)
- `src/repository/layout-roots.ts:20` (drop the `workDir` candidate when absent)
- `src/index.node.ts:111` (`makeWorktreeFs` root list — drop absent `workDir`)

*C2 — spawn cwd / hooks dir → `workDir ?? gitDir` (NOT work-tree reads; a child process
needs a working directory, and git's bare hooks run with `PWD=<bare.git>`):*
- `src/application/primitives/apply-textconv.ts:33`
- `src/application/primitives/sign-payload.ts:74`, `:98`
- `src/application/primitives/run-hook.ts:43` (relative `core.hooksPath` join), `:73`
  (`HookRequest.workDir`)

*C3 — genuine work-tree reads → take the value from `requireWorkTree(ctx, <op>)`.* These
are reached only after the gate has proved a work tree exists; the chokepoints call the
gate themselves and use its return value, so the compiler enforces the audit instead of a
reviewer. Chokepoints (few, by design):

| file:line | symbol |
|---|---|
| `commands/internal/working-tree.ts:20` | `repoPath` |
| `commands/internal/apply-sparse-checkout.ts:199` | `workdir` local |
| `primitives/materialize-tree.ts:248` | `workdir` field |
| `primitives/walk-working-tree.ts:204,210` | walk root + per-path join |
| `primitives/compare-working-tree-entry.ts:138` | `absPath` |
| `primitives/internal/write-working-tree-file.ts:79,103,150,168,172` | five joins |
| `primitives/snapshot/workdir-entry.ts:77` | `absPath` |
| `primitives/internal/symlinked-leading-path.ts:56,100` | two joins |
| `primitives/find-would-overwrite.ts:78` | `lstat` join |
| `primitives/internal/read-gitignore.ts:20` | `.gitignore` path |
| `primitives/internal/read-gitattributes.ts:26` | `.gitattributes` path |
| `primitives/internal/submodule-context.ts:17` | child `workDir` |

Per-command reads: `add.ts:182,418,497,514`; `blame.ts:179` (`readWorkingFile`, reached
only on the `opts.worktree` path); `grep.ts:75` (working-tree enumeration only);
`mv.ts:332` (`workPath`); `stash.ts:125,164,372`; `status.ts:365`;
`submodule.ts:99,369,522,551,556,591`.

**D. Child Contexts keep `bare: false`** — do not "fix" these:
`src/application/primitives/internal/worktree-context.ts:45` and
`src/application/primitives/internal/submodule-context.ts:24`. A linked worktree and a
submodule working directory both *have* work trees, and design §1d row 4 confirms a
linked worktree of a bare repo is **not** bare.

**E. `list-worktrees.ts:73-77`** — `mainEntry` already emits `bare: true` from
`ctx.layout.bare`; with `bare` finally correct this settles the main-entry flag from
inside a linked worktree of a bare repo (interop scenario N). No code change expected;
confirm with the scenario.

#### 3.7 Shim wiring

**Node — `src/index.node.ts:175-192` `resolveNodeLayout`.** Route through `resolveLayout`
(walk + Stage 2 + Stage 3). Keep the not-found fallback at `:180`
(`{ workDir: cwd, gitDir: join(cwd, '.git'), bare: false }`) — it is what lets
`repo.init()` / `repo.clone()` bootstrap into an empty directory, and it stays non-bare
with a work tree because a fresh `init()` there is a non-bare repository. It is now
reached only when neither a `.git` entry nor a cwd-is-gitdir was found, which is exactly
git's `fatal: not a git repository` case.

Canonicalisation (ADR-537): the shim already realpaths `cwd`, `gitDir` and `commonDir`
via `canonicalize` (`index.node.ts:~150`). It must **additionally realpath a resolved
`workDir`** — required, not cosmetic: git resolves `core.worktree` physically and
`NodeFileSystem` compares realpaths, so a lexical `workDir` under a symlinked ancestor
(the macOS `/var → /private/var` case) yields a spurious `PERMISSION_DENIED`. Fold the
new realpath's outcome into the returned `canonical` flag exactly as `gitDir` and
`commonDir` are folded in — a `canonical: true` claim over a path that did not actually
resolve is a containment bug.

**Memory — `src/index.default.ts:58-62`.** Same shared resolution. Layouts must stay
inside `rootDir`; a `gitDir` / `workDir` outside it reads as "absent" through the
`LayoutProbe` absence/containment-denial contract, so resolution fails cleanly rather
than escaping.

**Browser — `src/repository/fixed-entry-layout.ts`.** No walk. Keep resolving the fixed
`/{gitDirName}` entry, then run the **same Stage 2 + Stage 3** so `core.bare` /
`core.worktree` behave identically. Its current signature takes a positional
`bare: boolean` (`:22`) and its doc comment asserts "discovery never decides bare-ness" —
both change; take the resolved-layout shape instead so both shims share one Stage 3.
`ROOT_WORK_DIR = '/'` means a browser bare repo has `gitDir === '/'`; the `joinPath`
helper already special-cases the trailing slash
(`src/application/primitives/internal/join-working-tree-path.ts:7`).

**The browser shim's `opts.bare ?? false` at `index.browser.ts:53` must go.** That
hard-coded `false` is precisely the ADR-663 semantics break: `bare: undefined` now means
"take the answer from config + layout", **not** `false`. Pass `opts.bare` through
undefined-preserving (`exactOptionalPropertyTypes` — omit the key rather than passing
`undefined`). `opts.bare` on `OpenBrowserRepositoryOptions` (`:38`) keeps its name; its
meaning becomes "the argument tier wins over the config tier".

The shims are also where `openRepository`'s layout options are **consumed** — the core
(`repository.ts`) only reads `fallback.layout`. Note the resulting ordering hazard:
`validateOptions(opts)` runs in the core at `:383`, i.e. **after** the shim has already
resolved a layout from those values. Have each shim call the exported
`validateOptions(opts)` (`src/repository/validate-options.ts`) **before** resolving the
layout; it is pure and idempotent, so the core's second call costs nothing. Part 4 adds
the fields that make this matter (`gitDir: ''` would otherwise resolve a wrong layout
before the refusal), but doing it here keeps the two parts' shim edits from colliding.

#### 3.8 Containment (R11)

`layoutRootsOf` (`src/repository/layout-roots.ts:19-28`) builds candidates from
`[workDir, gitDir, commonDir ?? gitDir]`. With `workDir` absent the list starts at
`gitDir` and minimisation is unchanged:
- bare repo → `[gitDir]` (one root, one prefix comparison per FS call);
- bare linked-worktree host → `[gitDir, commonDir]`;
- normal repo → `[workDir]`, **bit-identical to today** (R12).

`test/unit/repository/layout-roots.test.ts` (extend): absent `workDir` ⇒ `[gitDir]`.

#### 3.9 Tests

**New unit files:**
- `test/unit/repository/resolve-layout.test.ts` — every Stage-3 precedence row as an
  isolated case, each guard triggered independently (`core.bare` alone; `core.bare` +
  `core.worktree`; `core.worktree` alone absolute; relative; neither, on each discovery
  route). The Stage-4 formula gets its own four-row truth table, **including the
  `core.bare` absent ⇒ bare row**. Use `MemoryFileSystem` + `portablePosixPolicy` +
  `fileSystemLayoutProbe`, the pattern `find-layout.test.ts` already uses.
- `test/unit/repository/read-repository-format.test.ts` — the scope table (local
  honoured; `config.worktree` honoured under the extension, ignored without it;
  `include.path` **not** followed), the two value-grammar refusals with payload
  assertions, absent file ⇒ empty result, oversized file ⇒ capped.
**Extend, do not create, the gate's unit home:**
`test/unit/application/commands/internal/repo-state.test.ts` **already exists** — it is
where `assertNotBare` / `isBare` are tested today, so their deletion lands there and
`requireWorkTree` replaces them in the same file. Three Contexts: (i) a work tree →
returns the path; (ii) none → `WORK_TREE_REQUIRED` with the `operation` payload; (iii)
none + `workTreeConfigBogus` → `WORK_TREE_CONFIG_INVALID` with the `gitDir` payload. Each
guard tested in isolation (a Context that trips both must not be the only proof of
either); assert `err.data`, never the class.

**Extended unit files:**
- `test/unit/repository/find-layout.test.ts` — cwd is a valid gitdir (`gitDir === cwd`,
  route `BARE_DIR`, no `workDir`); cwd is a valid gitdir **and** holds a valid `.git/`
  (the `.git` directory wins); a valid gitdir one level up; a bare-shaped dir nested
  inside a work tree shadows the enclosing repo; cwd has an invalid `.git/` and is itself
  a valid gitdir (the `.git` branch skips, the cwd branch resolves); **a level with no
  `HEAD` costs exactly one extra `stat`** — assert through a counting `LayoutProbe` stub
  (this is the R12 cost contract, and it is the only mechanical guard against someone
  reordering the probes).
- `test/unit/repository/layout-roots.test.ts` — absent `workDir`.
- `test/unit/repository/memory-shim-discovery.test.ts` — a memory FS seeded with a bare
  layout wholly inside `/repo` (`/repo/HEAD`, `/repo/objects/…`, `/repo/refs/…`, config
  with `bare = true`) opens with `gitDir === '/repo'`, no `workDir`, `bare === true`.
  This is the memory half of the cross-adapter proof.
- `test/unit/index.browser.test.ts` — the browser half: `resolveFixedEntryLayout` over a
  stub FS whose `/config` says `bare = true` yields no `workDir`; and a
  `core.worktree` value is honoured. Extend the existing
  `describe('fixed-entry layout resolution (the browser shim path)')` block (`:155`).
- `test/unit/domain/exhaustiveness.ts`, `test/unit/domain/repository/error.test.ts` —
  per §3.5.
- `test/unit/repository/repository.test.ts` — check whether its facade surface snapshot
  (`Object.keys(sut)` assertion) is affected; the `layout` facade field lands in Part 4,
  so it should not be here — confirm rather than assume.

**Moved assertions (ADR-664) — `test/integration/config-boolean-interop.test.ts`:**
- `describe('Given X11 — core.bare = maybe (T1)')` (`:115`) — both its `it`s currently
  route through the local `withRepo` helper (`:47`), which calls `openRepository` and
  *then* the command. With open-time refusal the throw happens at `openRepository`, so
  `withRepo` never returns. Restructure these two tests to capture the throw from
  `openRepository({ cwd: ours })` directly. **The asserted `data` is unchanged**
  (`code: 'CONFIG_BAD_BOOLEAN_VALUE'`, `key: 'core.bare'`, `value: 'maybe'`), and the git
  side is untouched.
- `describe('Given a T2 key on an earlier line than a malformed T1 key')` (`:163`) —
  same move; its ordering guarantee (`core.bare` named before `core.sparseCheckout`)
  **survives**, because open precedes first command.
- `describe('Given X12 — core.sparseCheckout = maybe (T2)')` (`:184`) — **unchanged**.
  `core.sparseCheckout` is the eager `[core]` tier, not the layout tier; open still
  succeeds and `repo.status()` still throws.
- `describe('Given X14 — core.bare = 2 (accepted integer)')` (`:276`) — timing is
  unchanged (open succeeds; `2` is a valid boolean meaning true) but the **code changes**:
  `repo.add(['nope.txt'])` now throws `WORK_TREE_REQUIRED`, not `BARE_REPOSITORY`. Update
  the assertion and the `it` title; the git-side assertion
  (`'this operation must be run in a work tree'`) already matches the new code's meaning
  exactly, which is the point.

**New interop file — `test/integration/bare-repo-custom-gitdir-interop.test.ts`:**

Docblock (mandatory shape — `parse-interop-surface.ts` requires `interopSurface:` on a
`cross-tool-interop` bucket):

```
 * @proves
 *   surface:        openRepository
 *   bucket:         cross-tool-interop
 *   unique:         bare and work-tree-less layout resolution and refusals match canonical git
 *   interopSurface: layout
```

Harness rules — copy them from `test/integration/linked-worktree-discovery-interop.test.ts`,
which is the closest sibling:
- `describe.skipIf(!GIT_AVAILABLE)`; all git through `interop-helpers.ts`
  (`git`, `runGit`, `runGitEnv`, `tryRunGitWithExit`);
- **one shared `beforeAll(fn, 60_000)` per scenario group** — git-spawning setup blows the
  default hook timeout;
- every tmpdir `realpath`-resolved (`realpath(await mkdtemp(...))`);
- a **fresh `openRepository` after any git-side write** — the per-Context loose-object
  fanout cache is only invalidated by tsgit's own `writeObject`;
- the layout oracle is
  `git rev-parse --path-format=absolute --git-dir --git-common-dir` plus
  `--is-bare-repository`; §1g's display forms are reconstructed **in the test**, never
  emitted by the library.

Two fixture hazards this suite must respect:
1. **Racy-clean is second-resolution.** Any scenario pinning stat-clean vs stat-dirty
   status output must let the mtime settle **more than one second** after the last write
   before asserting — git's racy-clean guard has `USE_NSEC` off.
2. **`interop-helpers.ts:59` sets `GIT_CEILING_DIRECTORIES = os.tmpdir()`.** Because a
   ceiling must be a *strict* ancestor, a fixture placed directly **at** `os.tmpdir()`
   would be excluded from git's own walk while tsgit finds it. `mkdtemp` already
   guarantees one level below — keep it that way.

Scenarios in **this** part (D, E, J, L, M, Q are Part 4):

| # | scenario | assertions |
|---|---|---|
| A | `git clone --bare`, tsgit opens by `cwd` | `layout.gitDir`/`commonDir`/`bare` match git; `log`, `revParse`, `catFile`, `branch.list`, `tag.list` agree with git |
| B | cwd = `<bare>/refs` | resolves the enclosing bare repo, same pair as A — the measured wrong-repo defect |
| C | cwd = `<normal>/.git` | `bare === false`, **no** `workDir`; `status`/`add` refuse while git prints the work-tree fatal; `log` works in both |
| F | `core.worktree` — absolute, relative, through a symlink, on the discovery routes | `layout.workDir` matches `git rev-parse --show-toplevel`; the relative-failure row co-refuses |
| G | `core.bare` + `core.worktree` together | tsgit throws `WORK_TREE_CONFIG_INVALID`; `tryRunGitWithExit` shows git's exit 128 and the invalid-config line; both still answer `--is-bare-repository` = `true` |
| H | the §1f refusal matrix, twinned — **the exhaustive one** | for every row: tsgit's code + `data` vs git's exit code and first stderr line, **including the rows that must NOT refuse**. tsgit has no `ls-files` command — do not invent one; the non-refusing surfaces that exist on the facade are `log`, `show`, `revList`, `revParse`, `catFile`, `diff` (tree↔tree, per B9), `grep({ target: 'index' })`, `grep({ target: { treeish } })`, `blame` (no `worktree`), `describe`, `describe({ broken: true })`, `reset({ mode: 'soft' })`, `archive`, `fsck`, `branch.list`, `tag.list`, `reflog`, `notes.*`, `config.*`, `bundle.*`, `worktree.list` |
| I | `reset --mixed` in a bare repo | tsgit `BARE_REPOSITORY { operation: 'reset --mixed' }`; git exit 128 with the mixed-reset line; **and `<bare>/index` is not created by either** |
| K | round-trip read→write | `git init --bare` → tsgit `fetch` into it and `push` into it; `git log` on the bare side sees the pushed commits |
| N | linked worktree of a bare repo | from inside it: `bare === false`, `gitDir` = `<bare>/worktrees/<n>`, `commonDir` = `<bare>`; `worktree.list` marks the **main** entry `bare: true`, matching `git worktree list --porcelain` |
| O | `config.worktree` under `extensions.worktreeConfig` | `core.worktree` and `core.bare` from `config.worktree` are honoured, matching git |
| P | value-grammar refusals | `core.bare = banana` and valueless `core.worktree`: co-refusal with git, tsgit naming the key in `data`, **asserted at the `openRepository` call** |

**Coverage note:** `src/repository/**` and `src/application/**` are **outside** the
coverage include list, so `resolve-layout.ts`, `read-repository-format.ts` and the swept
commands carry no line-coverage threshold — but they **are** in the `application`
mutation bucket (break 95), so write the unit tests mutation-resistant now.
`src/ports/context.ts` and `src/domain/repository/error.ts` **are** in the 100 % coverage
scope: `createContext`'s new three-way `??` chain needs a test per branch, and its home
is the existing `test/unit/ports/context.test.ts` — extend it with a layout that has no
`workDir` (cwd falls back to `gitDir`) alongside the two branches it already covers.

**Test-heuristic gates apply to the integration tier too.** `test-pyramid-budgets.json`
turns `gwtTitle`, `aaaBody`, `sutNaming`, `bareClassToThrow`, `emptyAaaSection`,
`sutBindsResult` and `underAssertedUnit` on for `unit` **and** `integration`. The new
interop file must therefore carry Given/When/Then describe nesting, `Arrange` + `Assert`
section comments in every `it`, no `toThrow(SomeClass)`, no empty AAA section, at least
one assertion per test, and must not bind a call result to `sut` (bind it to `result`;
`openRepository` is on the `sutBindsResult` allowlist, so `const sut = await
openRepository(...)` is permitted).

### TDD steps

1. **RED** — `test/unit/domain/repository/error.test.ts`: factory-data and
   `extractDetail` rows for `WORK_TREE_REQUIRED` and `WORK_TREE_CONFIG_INVALID`.
   Expected failure: the factories do not exist (module has no such export).
2. **GREEN** — widen `RepositoryError`, add the two factories, add the two `extractDetail`
   arms, add the two `case` labels to `test/unit/domain/exhaustiveness.ts` (a compile
   error until you do).
3. **RED** — `test/unit/repository/read-repository-format.test.ts`. Expected failure:
   `Cannot find module '.../read-repository-format.js'`.
4. **GREEN** — implement `src/repository/read-repository-format.ts` over
   `src/domain/config/config-ini.js`.
5. **RED** — `test/unit/repository/find-layout.test.ts` cwd-is-gitdir rows + the
   counting-probe cost row. Expected failure: the walk never asks whether `current` is
   itself a git directory, so it climbs to the root and returns `undefined`.
6. **GREEN** — add the per-level cwd-is-gitdir branch (cheap `HEAD` stat first) and the
   route/origin return shape.
7. **RED** — `test/unit/repository/resolve-layout.test.ts`: the full Stage-3 precedence
   table and the Stage-4 truth table, starting with the `core.bare` **absent** ⇒ bare row.
   Expected failure: module missing.
8. **GREEN** — implement `src/repository/resolve-layout.ts` (Stages 1–4, discovery routes).
9. **RED** — extend `test/unit/application/commands/internal/repo-state.test.ts` with the
   three `requireWorkTree` Contexts and delete its `assertNotBare` / `isBare` blocks.
   Expected failure: `requireWorkTree` does not exist, and the layout type does not
   permit an absent `workDir`.
10. **GREEN** — flip `RepositoryLayout.workDir` to optional, add `workTreeConfigBogus?`,
    mirror both on `RepositoryLayoutInput`, update `createContext`'s cwd default, add
    `requireWorkTree`, delete `isBare` and `assertNotBare` (and their re-exports in the
    deprecated shim). **`npm run check:types` now reports ~50 errors — that list is the
    sweep's worklist.** Work it category by category: C1, then C2, then C3, then the A
    repoints, then the B rows.
11. **RED** — extend `test/unit/repository/layout-roots.test.ts`,
    `memory-shim-discovery.test.ts` and `test/unit/index.browser.test.ts` for the absent
    `workDir` shapes. **GREEN** — `layout-roots.ts`, `index.default.ts`,
    `fixed-entry-layout.ts`.
12. **GREEN** — wire `resolveNodeLayout` (`index.node.ts`) including the new `workDir`
    realpath and its contribution to the `canonical` flag.
13. **RED→GREEN** — move the X11 / tie-break assertions and update X14 in
    `test/integration/config-boolean-interop.test.ts`.
14. **RED→GREEN** — write
    `test/integration/bare-repo-custom-gitdir-interop.test.ts` scenarios A, B, C, F, G,
    H, I, K, N, O, P. Reconstruct every expected byte from the design's §1 tables; the
    suite runs real git as the oracle, so each row is a genuine co-assertion, not a
    transcription.
15. **REFACTOR** — re-read the swept command modules for smells the sweep introduced
    (functions grown past 20 lines, nesting past 2, a `workDir ?? gitDir` repeated where a
    named helper belongs). Confirm the gate call sits immediately after
    `assertOperationalRepository` in every module.
16. **VERIFY SURFACE** — `npm run docs:json`; commit `reports/api.json`.
17. **VERIFY** — `npm run validate`. If `check:size` or `check:tarball` fails,
    `rm -rf dist .wireit` and re-run before believing it.

### Gate

```
npx vitest run test/unit/repository/ test/unit/domain/repository/ test/unit/ports/context.test.ts test/unit/index.browser.test.ts test/unit/application/commands/internal/repo-state.test.ts test/unit/application/primitives/internal/ test/integration/config-boolean-interop.test.ts test/integration/bare-repo-custom-gitdir-interop.test.ts test/integration/linked-worktree-discovery-interop.test.ts test/integration/node-shim.test.ts && npm run check:types && ./node_modules/.bin/biome check src/ports/context.ts src/repository.ts src/repository/resolve-layout.ts src/repository/read-repository-format.ts src/repository/find-layout.ts src/repository/layout-roots.ts src/repository/fixed-entry-layout.ts src/domain/repository/error.ts src/domain/error.ts src/index.node.ts src/index.default.ts src/application/commands/ src/application/primitives/ test/unit/repository/ test/unit/domain/repository/ test/unit/domain/exhaustiveness.ts test/unit/application/commands/internal/repo-state.test.ts test/integration/bare-repo-custom-gitdir-interop.test.ts
```

Then the full `npm run validate`.

### Commit

```
feat: open repositories with no working tree and refuse work-tree commands the way git does
```

## Part 4 — Explicit layout arguments and the resolved-layout read surface

### Context

Delivers R5, R8, R9, R10 (write direction) and ADRs 657, 658, 662, 663. Everything here
builds on Part 3's `resolveLayout`, which already has a route union with an `EXPLICIT` arm
to fill.

#### 4.1 Option surface — `src/repository.ts:76-118`

```ts
export interface OpenRepositoryOptions {
  readonly cwd?: string;
  /** Explicit git directory. Relative values resolve against `cwd`.
   *  Supplying it skips discovery entirely. */
  readonly gitDir?: string;
  /** Explicit working tree. Relative values resolve against `cwd`.
   *  Overrides `core.bare` and `core.worktree`. */
  readonly workDir?: string;
  /** Force bareness. `true` behaves as `core.bare = true`; `false` as
   *  `core.bare = false`. Omit to take the answer from config + layout. */
  readonly bare?: boolean;
  /** Absolute directories bounding the discovery walk. Ignored when `gitDir`
   *  is supplied (no walk happens). */
  readonly ceilingDirs?: ReadonlyArray<string>;
  // … existing fields unchanged
}
```

Document each field on the interface — these are public and typedoc-visible.

#### 4.2 Validation — `src/repository/validate-options.ts`

`ValidatableOptions` (`:9-12`) gains the four fields; it stays a structural subset of
`OpenRepositoryOptions`. Follow the file's established style exactly: one `validateX` per
field, each an isolated `if`, all raising `invalidOption(option, reason)`
(`src/domain/commands/error.ts:450`). The file's own doc comment (`:23-28`) states the
mutation-resistance directives — boundaries in isolated triples, each guard its own `if`.

| field | rule | `reason` |
|---|---|---|
| `gitDir` | non-empty string | `must not be empty` |
| `workDir` | non-empty string | `must not be empty` |
| `ceilingDirs` | every entry non-empty | `entries must not be empty` |
| `ceilingDirs` | every entry absolute | `entries must be absolute paths` |

`gitDir` / `workDir` are deliberately **not** required to be absolute — git accepts
`--git-dir=bare.git` and resolves it against cwd, which `validateOptions` already
requires to be absolute (`:30-32`). `ceilingDirs` **is** absolute-only (ADR-657): git
silently ignores non-absolute entries, and an argument that silently does nothing is
worse than a refusal. Reuse the existing `isAbsolutePath` helper (`:48-49`), which is
already drive-letter / UNC aware.

`test/unit/repository/validate-options.test.ts` (extend): the four validators, boundaries
in isolated triples per the file's directives.

#### 4.3 Stage 1 — the explicit route

Fill the `EXPLICIT` arm in `src/repository/resolve-layout.ts`:

```
entry   := policy.resolve(policy.join(cwd, opts.gitDir))   # relative → against cwd
gitDir  := probe.stat(entry) is a file
             ? resolvePointer(probe, entry, dirname(entry), policy)  # gitfile grammar
             : entry                                                 # LENIENT: may not exist
route   := EXPLICIT
origin  := undefined
```

Two measured edges that constrain this (design §1c explicit-edge table):
- **A missing or empty-directory `gitDir` must RESOLVE, not throw.** git is equally
  lenient: `git --git-dir=<empty dir> log` refuses while `git --git-dir=<empty dir> init`
  **succeeds**. `assertRepository` refuses at first command; `init`/`clone` bootstrap into
  it. This is the row that makes `init({ bare: true })` reachable (ADR-662).
- **An explicit `gitDir` that is a regular *file* is read as a gitfile pointer** — git
  says `fatal: invalid gitfile format: <path>`. Route it through the same
  `resolvePointer` the walk's file branch uses (`find-layout.ts:89-105`), inheriting its
  refusals (`GITFILE_INVALID_FORMAT`, `GITFILE_NO_PATH`). `resolvePointer` is
  **non-exported** today — export it from `find-layout.ts` rather than re-implementing
  the pointer grammar in `resolve-layout.ts`.

Stage 3 gains the two rows Part 3 left out:

| # | condition | work tree |
|---|---|---|
| R1c-1 | `opts.workDir` given | `policy.resolve(policy.join(cwd, opts.workDir))`, **verbatim; may not exist** — git's `--show-toplevel` prints a missing work tree (exit 0); only `setup_work_tree` refuses (exit 128) |
| R1c-5 | route `EXPLICIT`, nothing above | **the cwd** |

R1c-5 is the load-bearing surprise: `--git-dir=<bare4.git>` with no `core.bare` gives a
work tree **at cwd**, while `cd bare4.git` on the *same fixture* gives none. Bareness is
not a property of the directory shape — the **route** decides whether a work tree is
defaulted at all.

`bareCfg := opts.bare ?? fmt.bare` — the argument tier wins outright (ADR-663), matching
the precedence every other row already follows.

#### 4.4 Ceiling stop (R8, ADR-657)

New pure module `src/repository/ceiling-stop.ts` — a named file, not a private helper, so
the §1h table can be unit-tested directly rather than only through the walk:

```
longestStrictAncestor(ceilings, resolvedCwd, policy) -> string | undefined
```

Computed **once, before the loop**, not per level. Compared through the same `PathPolicy`
the walk uses (drive-letter / UNC aware). Requires a **strict** ancestor: equality is a
no-op. Because it is strict it can never equal the initial `current`, so **cwd is always
examined** — the `current === ceilStop` test at the loop head can only fire on a later
iteration. That is what makes the "ceiling == cwd" and "ceiling == cwd == repo root" rows
no-ops rather than refusals.

Rows to pin (design §1h, cwd `$T/normal/deep/deeper`, repo at `$T/normal`):

| ceiling | repo found? |
|---|---|
| none | yes |
| `$T` (above the repo) | yes |
| `$T/normal` (the repo root itself) | **no** |
| `$T/normal/deep` (intermediate) | **no** |
| `$T/normal/deep/deeper` (== cwd) | **yes** — no-op |
| below cwd | yes — irrelevant entries ignored |
| multiple entries, one of which is a strict ancestor | no |
| cwd == repo root, ceiling == repo root | **yes** — strict-ancestor rule |

Colon splitting and the `:`-prefix symlink toggle are env-string parsing artefacts with
no representation in an array argument — do **not** implement them. Entries are
realpath'd on node and resolved lexically on sandboxed adapters, matching git's default.
Symlink row: with cwd `$T/link/deep` (`$T/link → $T/real`, repo at `$T/real`), a ceiling
of either `$T/link` or `$T/real` stops the walk, because the entry is realpath'd and cwd
is compared physically.

`ceilingDirs` lives on the core `OpenRepositoryOptions` and is validated there, but the
browser never walks, so it has no effect on that runtime. It is **not** added to
`OpenBrowserRepositoryOptions` — the browser shim strips its own fields and forwards the
rest (`index.browser.ts:70-77`), so an unused core field costs nothing while an option
that visibly does nothing would be a documented lie.

**Where the four options are consumed:** the shims, not the core — `openRepository` in
`repository.ts` only reads `fallback.layout`. `OpenNodeRepositoryOptions`,
`OpenMemoryRepositoryOptions` and `OpenBrowserRepositoryOptions` all `extends
OpenRepositoryOptions`, so they inherit the fields for free. Each shim must **not** strip
them in its `...coreOpts` destructuring (they are core, not runtime-only) and must call
`validateOptions(opts)` before resolving the layout — Part 3 already established that
ordering; do not regress it. Pin it with a test that `openRepository({ gitDir: '' })`
throws `INVALID_OPTION { option: 'gitDir' }` rather than resolving a layout at cwd.

#### 4.5 The layout read surface (ADR-658)

`src/repository.ts` — `Repository` gains one field, attached beside `ctx` at the end of
the returned object (currently `ctx, dispose,` at `:758-760`):

```ts
  /** The resolved physical layout. Same object as `ctx.layout`; surfaced directly
   *  so callers do not reach through `ctx`. */
  readonly layout: RepositoryLayout;
```

It is the **same object** as `ctx.layout`, not a copy — one source of truth. Reading it
never throws.

`Object.freeze(ctx)` (`repository.ts:452`) is **shallow**, so the layout is not currently
frozen. Run it through the existing `deepFreeze` (`src/repository/deep-freeze.ts`, already
used for `opts.config` at `:415`) so a caller cannot mutate the object every primitive
reads. Note `deepFreeze` short-circuits on already-frozen objects, and
`worktree-context.ts` / `submodule-context.ts` already `Object.freeze` their child
layouts — both facts are compatible, no double-freeze cost.

`revParse` is deliberately left alone. Its signature is
`(ctx, expression: string) => Promise<ObjectId>`
(`src/application/commands/rev-parse.ts:32-36`) — a revision resolver with no options
type. Do not bolt structural queries onto it.

**No surface gate fires on this field:** `check:doc-coverage` and
`check:browser-surface` both match only `BindCtx<` and `commands.*Namespace` members
(measured — see the partition rationale), so no `docs/use/commands/layout.md` and no
parity-scenario invocation are required. **`reports/api.json` does go stale** — regenerate.

`test/unit/repository/repository.test.ts` gates the facade surface **twice** — both must
be updated in this part, not discovered at the phase-boundary validate:
- `:237` — `expect(Object.keys(sut).sort()).toEqual([…])`, the sorted surface snapshot.
  Insert `'layout'` in sort order.
- `:349` — `const nonFunctionKeys = new Set(['ctx', 'primitives', 'snapshot', ...namespaceKeys]);`
  followed by a loop asserting every other key is `typeof === 'function'`. `layout` is a
  **data** field, so it must join that set or the loop fails.

The reconstruction table — what the interop test computes from `repo.layout` +
`repo.ctx.cwd`, never from a library-rendered string:

| git query | reconstructed from |
|---|---|
| `--path-format=absolute --git-dir` | `layout.gitDir` — asserted **directly**, the unambiguous oracle |
| `--path-format=absolute --git-common-dir` | `layout.commonDir ?? layout.gitDir` |
| `--absolute-git-dir` | `layout.gitDir` (already realpath'd on node) |
| `--git-dir` (display form) | `.` when `cwd === gitDir`; `.git` when `gitDir === cwd + '/.git'`; the caller's `opts.gitDir` **verbatim** when supplied; else `gitDir` |
| `--is-bare-repository` | `layout.bare` |
| `--show-toplevel` | `layout.workDir`, the caller reconstructing git's refusal when absent |
| `--is-inside-work-tree` | `layout.workDir !== undefined && cwd is inside it` |
| `--is-inside-git-dir` | `cwd is inside layout.gitDir` |
| `--show-prefix` | `cwd` relative to `layout.workDir`, `''` when outside or absent |
| `--show-cdup` | inverse of `--show-prefix`; `layout.workDir` itself when cwd is outside it |

`--is-inside-git-dir` and `--is-inside-work-tree` are **cwd-relative, not layout
properties**: with an explicit gitDir and cwd outside it, `--is-inside-git-dir` is `false`
even for the same directory that reads `true` under discovery. Both are derived in the
test, never stored.

#### 4.6 Browser coherence

`OpenBrowserRepositoryOptions` (`src/index.browser.ts:36-42`) gains `gitDir?: string` and
`workDir?: string` with the same meaning, threaded through `resolveFixedEntryLayout`.
`bare?: boolean` already exists. Strip the new fields in the destructuring at `:70-77`
only if they are browser-only — they are **not** (`gitDir`/`workDir` are core options), so
forward them.

#### 4.7 Tests

**Extended:**
- `test/unit/repository/validate-options.test.ts` — the four validators (§4.2).
- `test/unit/repository/resolve-layout.test.ts` — the explicit route: `opts.workDir`
  alone; explicit `gitDir` with nothing else ⇒ work tree at cwd; explicit `gitDir` +
  `workDir`; `opts.bare` overriding `core.bare` in both directions; a **missing** gitDir
  and an **empty-directory** gitDir both **resolve** while `assertRepository` on the
  resulting Context refuses; a gitDir naming a *file* resolves through the gitfile
  grammar and inherits its refusals; `opts.workDir` with no `gitDir` and no repository
  anywhere still returns the not-found fallback.
- `test/unit/repository/find-layout.test.ts` — "walk reaches the root with a ceiling set
  ⇒ `undefined`", and one row per discovery outcome proving the stop is actually wired
  into the loop head (not just computed).

**New:**
- `test/unit/repository/ceiling-stop.test.ts` — the full §1h table above as isolated
  Given/When/Then triples against `longestStrictAncestor` directly, including the
  symlink rows and the multi-entry "longest strict ancestor wins" row. This is where the
  strict-vs-non-strict boundary mutant is killed; do not rely on the walk-level test.
- `test/unit/repository/repository.test.ts` — the surface snapshot + a
  `repo.layout === repo.ctx.layout` identity assertion + a frozen-layout assertion.
- `test/unit/index.browser.test.ts` — `gitDir` / `workDir` threading through the browser
  shim.
- `test/integration/node-shim.test.ts` — open a `git init --bare` directory by `cwd` and
  assert the raw adapter root set is `[gitDir]`; open with explicit `gitDir` + `workDir`
  in **disjoint** subtrees and assert both roots are present and that a path *between*
  them is refused (this is the R11 no-common-ancestor rule, and it is the one containment
  regression a reviewer cannot catch by reading).

**Interop — extend `test/integration/bare-repo-custom-gitdir-interop.test.ts`** (same
file, same docblock, new scenario groups; each group keeps its own
`beforeAll(fn, 60_000)`):

| # | scenario | assertions |
|---|---|---|
| D | explicit `gitDir` from an unrelated cwd, no `workDir` | work tree defaults to **cwd**; `status` output matches `git --git-dir=… status --porcelain` |
| E | explicit `gitDir` + `workDir` against a bare repo | `bare === false`; `status` matches git (respect the >1 s racy-clean settle) |
| J | round-trip write→read | tsgit `init({ bare: true })` / `clone({ bare: true })` into a Context opened as `openRepository({ cwd: d, gitDir: d, bare: true })` → `git rev-parse --is-bare-repository` = `true`, `git log` reads it, config bytes match the pinned `init --bare` shape (`[core] bare = true`, `logallrefupdates` absent, `repositoryformatversion = 0`, no `index`); then `openRepository({ cwd })` reopens it |
| L | `ceilingDirs` | the §1h rows, each twinned against `GIT_CEILING_DIRECTORIES`, including the strict-ancestor no-op and the symlinked-ceiling row. **Pass the ceilings explicitly to BOTH tools** rather than relying on the helper's ambient `GIT_CEILING_DIRECTORIES` |
| M | `rev-parse` reconstruction | for each §1g cwd, reconstruct all nine queries from `repo.layout` + `repo.ctx.cwd` and compare byte-for-byte with git |
| Q | explicit-gitDir edges | missing gitDir / empty-dir gitDir: tsgit resolves but `log` refuses while `init` **succeeds**, matching git's three rows; gitDir naming a regular file co-refuses with the gitfile-format refusal; `workDir` alone with no repository co-refuses |

Scenario J is where ADR-662 is proved: `init`/`clone` keep writing at `ctx.layout.gitDir`
and never relocate it; the caller opens with `gitDir` + `bare` to get a bare-shaped
Context.

### TDD steps

1. **RED** — `test/unit/repository/validate-options.test.ts`: the four validators,
   boundaries in isolated triples. Expected failure: no validation runs, so the invalid
   values are accepted.
2. **GREEN** — extend `ValidatableOptions` and `validateOptions`; add the four fields to
   `OpenRepositoryOptions` with doc comments.
3. **RED** — `test/unit/repository/resolve-layout.test.ts` explicit-route rows. Expected
   failure: the `EXPLICIT` arm is unimplemented / `opts` fields are ignored.
4. **GREEN** — fill Stage 1's explicit branch and Stage 3's R1c-1 / R1c-5 rows, plus
   `bareCfg := opts.bare ?? fmt.bare`.
5. **RED** — `test/unit/repository/find-layout.test.ts` ceiling rows. Expected failure:
   the walk has no ceiling parameter and climbs past every entry.
6. **GREEN** — implement `longestStrictAncestor` and the loop-head stop; thread
   `ceilingDirs` from `openRepository` → shim → `resolveLayout` → walk. Realpath the
   entries on node, lexical elsewhere.
7. **RED** — `test/unit/repository/repository.test.ts`: `repo.layout` identity + frozen +
   updated surface snapshot. Expected failure: `layout` is not a facade field.
8. **GREEN** — add `readonly layout: RepositoryLayout` to the `Repository` interface and
   the returned object; `deepFreeze` the layout.
9. **RED→GREEN** — browser threading (`index.browser.ts`, `fixed-entry-layout.ts`) with
   `test/unit/index.browser.test.ts`.
10. **RED→GREEN** — `test/integration/node-shim.test.ts` bare-root-set and disjoint-roots
    containment rows.
11. **RED→GREEN** — interop scenarios D, E, J, L, M, Q.
12. **REFACTOR** — collapse any duplication the two Stage-1 routes introduced; confirm
    `resolve-layout.ts` functions stay under 20 lines with no nesting past 2.
13. **VERIFY SURFACE** — `npm run docs:json`; **commit `reports/api.json`** (four new
    public options + a new facade field — this is the part where a stale api.json is
    guaranteed).
14. **VERIFY** — `npm run validate`, then confirm the integration tier ratio is still in
    band (`npm run check:test-pyramid`; measured headroom: 17.0 % against a 10–25 % band).

### Gate

```
npx vitest run test/unit/repository/ test/unit/index.browser.test.ts test/integration/node-shim.test.ts test/integration/bare-repo-custom-gitdir-interop.test.ts test/integration/linked-worktree-discovery-interop.test.ts && npm run check:types && ./node_modules/.bin/biome check src/repository.ts src/repository/validate-options.ts src/repository/resolve-layout.ts src/repository/find-layout.ts src/repository/ceiling-stop.ts src/repository/fixed-entry-layout.ts src/index.node.ts src/index.browser.ts src/index.default.ts test/unit/repository/ test/unit/index.browser.test.ts test/integration/node-shim.test.ts test/integration/bare-repo-custom-gitdir-interop.test.ts
```

Then the full `npm run validate`.

### Commit

```
feat: accept explicit gitDir, workDir, bare and ceiling arguments and expose the resolved layout
```
