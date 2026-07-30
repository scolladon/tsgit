# Plan — Linked-worktree discovery

> Source: design doc `docs/design/linked-worktree-discovery.md` · ADRs 532–540
> The plan is the implementation script AND the knowledge handoff. Part agents start
> with zero context: whatever a part block omits is paid later as agent rediscovery.

## How to read this plan

- Six parts, strictly sequential, one atomic conventional commit each. Parts share
  one working tree; each builds on the previous one's landed code.
- Every part is TDD: **RED** (test first + the exact failure reason expected) →
  **GREEN** (minimal code) → **REFACTOR**.
- Serena is already activated on this worktree. Use `find_symbol` /
  `find_referencing_symbols` / `replace_symbol_body` as the default for every
  TypeScript read/navigate/edit (test files too); `Read`/`Grep` only for markdown,
  JSON and generated artefacts. `get_diagnostics_for_file` after each source edit —
  advisory only, ground truth is `npm run check:types`.
- **Prime directive:** every behaviour below is pinned against real `git` 2.55.0 in
  the design's §1 matrix, plus the two extra rows measured while writing this plan
  (Part 5 context). Never recall git behaviour — if a row is missing, measure it in a
  `mktemp -d` throwaway with `HOME` isolated, `GIT_CONFIG_NOSYSTEM=1`, every `GIT_*`
  scrubbed and signing off. Never probe inside this worktree.
- **No suppression directives** (`@ts-ignore`, `v8 ignore`, `stryker-disable` for
  anything not *provably* equivalent, `biome-ignore`). **No provenance refs**
  (ADR/phase/backlog numbers) inside `src/` or `test/` code — the commit is the join
  point.
- Blocked? Escalate `{ part, reason, ≤3 options }`. Never spin, never guess, never
  silently drop scope.

## Shared background every part needs

**The gap.** `openRepository({ cwd })` walks up looking for a `.git` **directory**
and skips a `.git` **file**. Measured consequences: inside a linked worktree it
throws `NOT_A_DIRECTORY`; inside a submodule working directory it **silently opens
the superproject**. Two symptoms, one root cause.

**The substrate that already exists** (do not rebuild it):

- `RepositoryLayout.commonDir?: string` — `src/ports/context.ts` L33.
- `commonGitDir(ctx)` / `perWorktreeRefDir(ctx, name)` —
  `src/application/primitives/path-layout.ts` L23/L31.
- `isPerWorktreeRef(name)` — `src/domain/refs/per-worktree-ref.ts`.
- `wrapFsValidator(fs, roots: string | ReadonlyArray<string>, allowExternalPaths)` —
  `src/repository/wrap-fs-validator.ts` L53, already multi-root ("contained in ANY
  root"); module-private `isContainedIn` at L181.
- `commonAncestor(paths, policy)` — `src/repository/common-ancestor.ts`.
- `deriveWorktreeContext(ctx, id, absWorktreePath)` —
  `src/application/primitives/internal/worktree-context.ts` L28, already produces a
  `{ gitDir: <admin>, commonDir: <common> }` layout. This is the shape every split
  unit test builds.
- Pointer **writers** — `src/domain/worktree/admin-files.ts`:
  `WORKTREE_COMMONDIR = '../..'`, `worktreeGitfile(absAdminDir) => 'gitdir: ' + absAdminDir`,
  `worktreeGitdirPointer(absWorktreePath) => absWorktreePath + '/.git'`. Each is
  written with a trailing `\n` appended by the caller (`src/application/commands/worktree.ts`
  L163–169). There is **no reader** — Part 1 adds it.

**Existing split unit-test family** (extend it, do not invent a new location):
`test/unit/application/primitives/commondir-config.test.ts`,
`commondir-refs.test.ts`, `commondir-resolution.test.ts`. The local helper pattern
they all use:

```ts
const adminDir = (ctx: Context): string => `${ctx.layout.gitDir}/worktrees/wt`;
const asWorktreeChild = (ctx: Context): Context => ({
  ...ctx,
  layout: { ...ctx.layout, gitDir: adminDir(ctx), commonDir: ctx.layout.gitDir },
});
```

`asWorktreeChild` is already on the `sutBindsResult` allowlist in
`test-pyramid-budgets.json` — reuse the exact name.

**Base fixtures.** `buildSeededContext(parts)` —
`test/unit/application/primitives/fixtures.ts` L38 (memory-backed `Context` via
`createMemoryContext()` from `src/adapters/memory/memory-adapter.ts` L41, layout
`/repo` + `/repo/.git`).

**Gate topology.**

| gate | when it fires | what it catches here |
|---|---|---|
| `npm run check:types` | part gate | `exactOptionalPropertyTypes` on `commonDir`, exhaustiveness `never` |
| `npx vitest run <files>` | part gate | the part's own tests |
| `biome check <files>` | part gate | style / `any` / kebab-case |
| `npm run validate` | phase boundary | coverage 100% on `src/domain/**`, `src/ports/**`, `src/adapters/{node,memory}/**`, `src/operators/**`; `check:dead-code` (knip); `check:architecture` (depcruise); `check:test-pyramid`; `check:write-surfaces`; `check:spelling` |
| `npm run prepush` | push (later phase) | `check:doc-typedoc` = `git diff --exit-code -- reports/api.json` |

**Coverage vs mutation scope — they differ, know which applies:**

- Coverage (`vitest.config.ts` L69–75) includes only `src/domain/**`, `src/ports/**`,
  `src/adapters/node/**`, `src/adapters/memory/**`, `src/operators/**` at **100%**.
  `src/repository*`, `src/application/**` and `src/index.*.ts` are **outside** it.
- Stryker mutates **all** of `src/`. Budgets (`mutation-budgets.json`): `domain`
  break 99; `application` (`src/application/**`, `src/repository.ts`,
  `src/repository/**`) break 95; `infra` (`src/ports/**`) break 90. `src/index.*.ts`
  is in no bucket.
- Net: `src/domain/worktree/gitfile.ts` needs 100% coverage **and** near-perfect
  mutation kill. `src/repository/find-layout.ts` and
  `src/repository/file-system-layout-probe.ts` need mutation kill but are not
  coverage-gated — write the tests anyway, mutants are the real gate.

**Surface-gate decision, up front.** New symbols and their verdicts:

| symbol | verdict | gates it trips |
|---|---|---|
| `parseGitfilePointer`, `parseCommondir`, `GitfilePointer`, `CommondirValue` (`src/domain/worktree/gitfile.ts`) | **internal** | none — consumed inside `src/`; no `domain/worktree/index.ts` barrel exists |
| `GITFILE_INVALID_FORMAT`, `GITFILE_NO_PATH` + factories (`src/domain/worktree/error.ts`) | **public** (reachable in `TsgitError.data`) | `src/domain/error.ts` `extractDetail` switch; `test/unit/domain/exhaustiveness.ts` switch; `reports/api.json` |
| `LayoutProbe` (`src/ports/layout-probe.ts`) | **internal** — deliberately NOT added to `src/ports/index.ts` (ADR-535, design §8) | none |
| `fileSystemLayoutProbe` (`src/repository/file-system-layout-probe.ts`) | **internal** | none |
| `RepositoryLayoutInput.commonDir` (`src/repository.ts` L127) | `@internal` interface, but it is an exported declaration | `reports/api.json` |
| `layoutRootsOf` (`src/repository/layout-roots.ts`) | **internal** | none |

No new Tier-1 command ⇒ **no** barrel/facade/`check:doc-coverage`/README-count gate
fires. `check:browser-surface` is unaffected (no new `repo.<cmd>`).
`reports/api.json` is regenerated in **Part 3** (`npm run docs:json`) and verified in
**Part 6** — the huge typedoc-id diff is normal and expected. In **any** part: if
`npm run docs:json` produces a diff, commit it with that part; a cached-green
`validate` can still precede a red `prepush`.

**Two behaviours are deliberately UNCHANGED** (design §2) — do not "fix" them in any
part:

1. Discovery **never** sets `bare: true`. The caller supplies `bare` explicitly
   (`src/index.browser.ts` takes `opts.bare`); bare-repo discovery is out of scope.
   `findLayout` always returns `bare: false`, and a shim that has its own `bare`
   input must override the returned value with it.
2. A `cwd` that does **not yet exist** still walks up from its resolved form, so
   `openRepository` + `init`/`clone` against a not-yet-created directory keeps
   working exactly as today (`src/index.node.ts` L52's
   `realpath(...).catch(() => nodePath.resolve(cwd))` fallback).

**Interop-test discipline** (Parts 3–5 all touch
`test/integration/linked-worktree-discovery-interop.test.ts`):

- Every `git` invocation goes through `test/integration/interop-helpers.ts`
  (`git`, `runGit`, `runGitEnv`, `tryRunGitWithExit`, `makePeerPair`,
  `GIT_AVAILABLE`) — it scrubs `GIT_*`, isolates `HOME`, sets
  `GIT_CONFIG_NOSYSTEM=1` and `XDG_CONFIG_HOME`. Never spawn git directly.
- `describe.skipIf(!GIT_AVAILABLE)`.
- One shared `beforeAll(fn, 60_000)` per scenario group — the 60 s timeout is
  mandatory, git-spawning setup hooks time out under `validate`'s concurrency.
- `realpath()` every tmpdir before use: the node adapter confines by realpath and
  macOS symlinks `/var` → `/private/var`.
- Build a **fresh** `openRepository` after any git-subprocess write — the per-Context
  loose-object fanout cache is only invalidated by tsgit's own `writeObject`.
- Compare against `git rev-parse --path-format=absolute --git-dir --git-common-dir`
  (verified available on 2.55.0) so the main-worktree relative `.git` never leaks
  into an assertion.
- A green run that exits 1 with `Serialized Error: EPIPE` from
  `filter-clean-smudge-interop.test.ts` is a known unrelated flake — re-run
  `npm run test:integration`, do not "fix" it.

---

## Part 1 — Gitfile & commondir grammar + the two refusal codes

### Context

**Create** `src/domain/worktree/gitfile.ts` — pure, no I/O, no path algebra
(ADR-536). It sits beside its serializer `admin-files.ts`, which is what makes the
round-trip property test possible.

Target API (discriminated unions, so callers switch rather than null-check):

```ts
export type GitfilePointer =
  | { readonly kind: 'ok'; readonly path: string }
  | { readonly kind: 'invalid-format' }
  | { readonly kind: 'no-path' };

export type CommondirValue =
  | { readonly kind: 'ok'; readonly path: string }
  | { readonly kind: 'empty' };

export const parseGitfilePointer = (content: string): GitfilePointer => …
export const parseCommondir = (content: string): CommondirValue => …
```

**Pinned byte grammar this part encodes** (design §1e — `<worktree>/.git`):

| input | verdict |
|---|---|
| `gitdir: <abs>\n` | `ok`, path `<abs>` |
| `gitdir: ../main/.git/worktrees/wt\n` | `ok`, path kept verbatim (resolution is Part 2's job) |
| `gitdir: <abs>` (no trailing newline) | `ok` |
| `gitdir: <path>  \r\n` (trailing spaces) | `ok`, path **keeps the spaces** — only `\n`/`\r` are stripped |
| `  gitdir: <path>\n` (leading whitespace) | `invalid-format` |
| `gitdir:<path>\n` (no space) | `invalid-format` |
| `gitdir: \n` (empty path) | `no-path` |
| `hello world\n` | `invalid-format` |
| `gitdir: <path>\nextra junk\n` | `ok`, path is `<path>\nextra junk` — git does **not** split at the first newline |

Rule, stated once: require the exact 8-byte prefix `` `gitdir: ` `` at index 0; strip
**trailing** `\n`/`\r` characters only (e.g. `content.replace(/[\r\n]+$/, '')`); the
remainder is the path verbatim; length 0 ⇒ `no-path`.

**Pinned byte grammar** (design §1f — `<gitdir>/commondir`):

| input | verdict |
|---|---|
| `../..\n` | `ok`, path `../..` |
| `../..` (no trailing newline) | `ok` |
| `<abs>\n` | `ok`, path `<abs>` |
| `../..  \n` (trailing spaces) | `ok`, spaces kept |
| `\n` or `''` | `empty` |

Same trailing-`\r\n` strip; no prefix; length 0 ⇒ `empty`. **File absent** is not
this parser's concern — that maps to `commonDir := gitDir` in Part 2.

**Edit** `src/domain/worktree/error.ts` — the union today is
`WORKTREE_PATH_EXISTS | BRANCH_CHECKED_OUT | WORKTREE_LOCKED | WORKTREE_DIRTY | NOT_A_WORKTREE`,
each with a factory. Add, following the exact same shape:

```ts
| { readonly code: 'GITFILE_INVALID_FORMAT'; readonly path: string }
| { readonly code: 'GITFILE_NO_PATH'; readonly path: string }

export const gitfileInvalidFormat = (path: string): TsgitError => …
export const gitfileNoPath = (path: string): TsgitError => …
```

Two distinct codes, not one code with a `reason` field (ADR-539): a shared code with
a string discriminant survives `StringLiteral` mutants that distinct codes kill.

**Edit** `src/domain/error.ts` `extractDetail` — add two `case` arms next to the
existing `NOT_A_WORKTREE` arm (≈L…, the worktree block). Mirror git's wording and use
the **full** path (the worktree family already does; only the adapter family uses
`basename`):

```
case 'GITFILE_INVALID_FORMAT': return `invalid gitfile format: ${data.path}`;
case 'GITFILE_NO_PATH':        return `no path in gitfile: ${data.path}`;
```

**Edit** `test/unit/domain/exhaustiveness.ts` — add both codes to the shared switch
(fall-through `case` labels next to `NOT_A_WORKTREE` at L182). Skipping this fails
`check:types` with the `never` assignment, not at runtime.

**Check** `test/unit/domain/error.test.ts` — it has an `extractDetail message
formatting` describe block. Determine whether it asserts every code's message; if it
does, add the two arms there too. Do not guess — open the file.

**Test files to create:**

- `test/unit/domain/worktree/gitfile.test.ts` — every row of both tables above, each
  asserting the union **variant and its payload**. Guard clauses in **isolation**
  (a separate test for "no prefix" and a separate one for "prefix, empty remainder" —
  one test hitting both does not prove either guard alone).
- `test/unit/domain/worktree/arbitraries.ts` — shared generators.
- `test/unit/domain/worktree/gitfile.properties.test.ts` — property tests.

Existing peer to copy the file-header + AAA style from:
`test/unit/domain/worktree/error.test.ts` and
`test/unit/repository/common-ancestor.properties.test.ts` (property style,
`fc.assert(fc.property(...))`, `numRuns` as a named const).

**Property lenses that fire** (CLAUDE.md lens 1 = round-trip pair, lens 3 =
totality):

1. `parseGitfilePointer(worktreeGitfile(p) + '\n') ≡ { kind: 'ok', path: p }` for
   arbitrary non-empty `p` containing no `\r`/`\n` — **200 runs**.
2. `parseCommondir(v + '\n') ≡ { kind: 'ok', path: v }` on the same family — **200 runs**.
3. Totality: `parseGitfilePointer` returns a variant (never throws) for arbitrary
   printable-ASCII content — **100 runs**.

Never commit a seed.

**Trap — checkov CKV_SECRET_6.** MegaLinter flags high-entropy literal character-set
strings in test arbitraries as "secrets" and blocks CI. Build character sets from
`fc.integer({ min, max }).map(String.fromCharCode)` **ranges** (see
`test/unit/repository/arbitraries.ts` `arbSegmentChar`), never from a literal
alphabet string.

**Trap — coverage.** `src/domain/**` is coverage-gated at 100% line/branch/function/
statement. Every arm of both parsers must be hit by an example test; the property
tests do not count toward branch reachability guarantees.

### TDD steps

1. **RED** `test/unit/domain/worktree/gitfile.test.ts` — one `describe('Given …')` >
   `describe('When parseGitfilePointer runs')` > `it('Then …')` per row of the §1e
   table, asserting `result` deep-equals the expected variant. Fails: *Cannot find
   module '../../../../src/domain/worktree/gitfile.js'*.
2. **RED** same file, `parseCommondir` rows from §1f. Same failure.
3. **GREEN** create `src/domain/worktree/gitfile.ts` with both parsers. Keep each
   function < 20 lines, early returns, named constants for the prefix and its length.
4. **RED** `test/unit/domain/worktree/error.test.ts` — extend with
   `gitfileInvalidFormat('/wt/.git')` and `gitfileNoPath('/wt/.git')`, asserting
   `result.data` deep-equals `{ code, path }` (data assertion, never bare
   `toThrow(TsgitError)`). Fails: *has no exported member*.
5. **GREEN** add the two union members + factories to
   `src/domain/worktree/error.ts`. `npm run check:types` now fails on the
   non-exhaustive `extractDetail` switch and the test exhaustiveness switch — that is
   the expected intermediate red.
6. **GREEN** add the two `case` arms to `src/domain/error.ts` `extractDetail` and to
   `test/unit/domain/exhaustiveness.ts`; add message assertions to
   `test/unit/domain/error.test.ts` if that file enumerates messages.
7. **RED → GREEN** `test/unit/domain/worktree/arbitraries.ts` +
   `gitfile.properties.test.ts` with the three properties above. Property 1 imports
   `worktreeGitfile` from `src/domain/worktree/admin-files.js` — the round-trip must
   go through the real serializer, never a re-implementation.
8. **REFACTOR** extract the shared trailing-CRLF strip into one module-private
   helper used by both parsers (DRY without leaking it to the module surface).
   Re-run the gate.

### Gate

```
npx vitest run test/unit/domain/worktree/gitfile.test.ts test/unit/domain/worktree/gitfile.properties.test.ts test/unit/domain/worktree/error.test.ts test/unit/domain/error.test.ts && npm run check:types && ./node_modules/.bin/biome check src/domain/worktree/gitfile.ts src/domain/worktree/error.ts src/domain/error.ts test/unit/domain/worktree/ test/unit/domain/error.test.ts test/unit/domain/exhaustiveness.ts
```

### Commit

```
feat(worktree): parse the gitdir pointer and commondir grammars
```

---

## Part 2 — `LayoutProbe` port + probe adapter + pointer-aware discovery walk

### Context

**Current state.** `src/repository/find-layout.ts` today:

```ts
export const findLayout = async (
  fs: FileSystem,
  cwd: string,
  pathPolicy: PathPolicy,
): Promise<RepositoryLayoutInput | undefined>
```

It walks up, `fs.stat(candidate).catch(() => undefined)`, returns
`{ workDir, gitDir, bare: false }` on `stat?.isDirectory === true`, otherwise climbs
until `pathPolicy.dirname(current) === current`. It is **imported by nothing in
`src/`** — its only consumer is `test/unit/repository/find-layout.test.ts`. The
production copy is `discoverLayout` in `src/index.node.ts` L112–126 (deleted in
Part 3). Changing this signature therefore breaks no production code.

**Create** `src/ports/layout-probe.ts` (ADR-535):

```ts
export interface LayoutProbe {
  /** `undefined` ⇒ the path is absent (or unreachable in a sandboxed adapter). */
  readonly stat: (
    path: string,
  ) => Promise<{ readonly isDirectory: boolean; readonly isFile: boolean } | undefined>;
  /** `undefined` ⇒ the file is absent. */
  readonly readUtf8: (path: string) => Promise<string | undefined>;
}
```

**Do NOT** add it to `src/ports/index.ts` — it stays internal so the published type
surface does not grow (design §8). knip is satisfied because the export is consumed
inside `src/` (and by the vitest-plugin test entry points).

**Create** `src/repository/file-system-layout-probe.ts`:

```ts
export const fileSystemLayoutProbe = (fs: FileSystem): LayoutProbe => ({ … })
```

Both methods catch and map to `undefined`. This is the **single, documented,
tested** place where a path-confined adapter's `PERMISSION_DENIED`
(`MemoryFileSystem.resolve` throws it for anything outside `rootDir` —
`src/adapters/memory/memory-file-system.ts` L397–403) reads as "absent", which is
what lets the walk terminate at a sandbox boundary instead of exploding. ADR-535
states this verbatim. The JSDoc must say **why** (it is the port's contract, not a
swallowed error) so the "no swallowed exceptions" guardrail is met by documentation
plus a test, not by silence.

**Rewrite** `src/repository/find-layout.ts` to the design §2 algorithm. New
signature — `probe` replaces `fs`:

```ts
export const findLayout = async (
  probe: LayoutProbe,
  cwd: string,
  pathPolicy: PathPolicy,
): Promise<RepositoryLayoutInput | undefined>
```

Algorithm (keep every helper < 20 lines, early returns, nesting ≤ 2):

```
findLayout(probe, cwd, policy):
  current := policy.resolve(cwd)
  loop:
    candidate := policy.join(current, '.git')
    st := probe.stat(candidate)                    // stat, NOT lstat — a .git symlink
                                                   // to a real gitdir behaves as a dir
    if st?.isDirectory:
      layout := layoutFor(probe, current, candidate, policy)
      if layout !== undefined: return layout       // a directory is a CANDIDATE
    else if st?.isFile:
      gitDir := resolvePointer(probe, candidate, current, policy)   // throws — hard stop
      layout := layoutFor(probe, current, gitDir, policy)
      if layout === undefined: throw notARepository(current as FilePath)
      return layout                                // a file is a COMMITMENT
    parent := policy.dirname(current)
    if parent === current: return undefined
    current := parent

resolvePointer(probe, gitfilePath, baseDir, policy):
  raw := probe.readUtf8(gitfilePath)
  if raw === undefined: throw gitfileInvalidFormat(gitfilePath)
  parsed := parseGitfilePointer(raw)
  if parsed.kind === 'invalid-format': throw gitfileInvalidFormat(gitfilePath)
  if parsed.kind === 'no-path':        throw gitfileNoPath(gitfilePath)
  return policy.isAbsolute(parsed.path)
    ? policy.resolve(parsed.path)
    : policy.resolve(policy.join(baseDir, parsed.path))

layoutFor(probe, workDir, gitDir, policy):
  commonDir := resolveCommonDir(probe, gitDir, policy)
  if !isGitDirectory(probe, gitDir, commonDir): return undefined
  return { workDir, gitDir, bare: false, ...(commonDir !== gitDir ? { commonDir } : {}) }

resolveCommonDir(probe, gitDir, policy):
  p := policy.join(gitDir, 'commondir')
  raw := probe.readUtf8(p)
  if raw === undefined: return gitDir                     // file ABSENT ⇒ commonDir = gitDir
  value := parseCommondir(raw)
  if value.kind === 'empty': throw gitfileInvalidFormat(p)
  return policy.isAbsolute(value.path)
    ? policy.resolve(value.path)
    : policy.resolve(policy.join(gitDir, value.path))

isGitDirectory(probe, gitDir, commonDir):                 // git's is_git_directory, narrowed
  probe.stat(`${gitDir}/HEAD`)            !== undefined
  && probe.stat(`${commonDir}/objects`)?.isDirectory === true
  && probe.stat(`${commonDir}/refs`)?.isDirectory    === true
```

**Three decisions baked into that pseudo-code — do not "simplify" them away:**

1. **ADR-533 (hard stop).** An unusable `.git` *file* is fatal even with a valid
   repository one level up. This is the fix for the silent-superproject bug.
2. **ADR-534 (`is_git_directory` on both branches).** An invalid `.git` *directory*
   is **skipped** and the walk continues (git's measured behaviour, §1g row 3).
   tsgit checks only that `HEAD` **exists** (ref parsing is unavailable at discovery
   time); a `.git` dir with a malformed `HEAD` is accepted here and rejected later by
   `assertRepository` (`src/application/primitives/internal/repo-state.ts` L45) with
   its own structured error — never by walking up.
3. `commonDir` is **omitted** when it equals `gitDir` — `exactOptionalPropertyTypes`
   forbids `{ commonDir: undefined }`, and omission is what makes existing repos
   byte-identical (`commonGitDir(ctx)` already falls back to `gitDir`).

**Two `readUtf8`-returns-`undefined` branches that deliberately differ** — pin both:

- gitfile: the path was already `stat`ed as a **file**, so `undefined` means
  unreadable ⇒ `gitfileInvalidFormat`. Never a walk-up (ADR-533's hard stop must
  survive an I/O failure).
- `commondir`: probed optimistically, `undefined` means **absent** ⇒
  `commonDir := gitDir`. This is design §1f's last row and is exactly what makes a
  submodule gitdir and a `--separate-git-dir` gitdir valid.

**Also export from `find-layout.ts`** a reusable
`layoutFromGitfile(probe, workDir, gitfilePath, policy)` (the file branch's body:
`resolvePointer` → `layoutFor` → throw-or-return). Part 6's browser shim consumes it
so the pointer logic has exactly one implementation (R9). Keeping the extraction in
this part means Part 6 adds no grammar code.

**Extend / rewrite** `test/unit/repository/find-layout.test.ts`. Existing tests and
what happens to them:

| current | disposition |
|---|---|
| L13–27 "cwd contains a `.git` directory" (fixture: bare `mkdir /repo/.git`) | **updated**, not deleted — fixture gains `HEAD`, `objects/`, `refs/` (ADR-534) |
| L29–43 "cwd is a sub-directory of a repo" | fixture gains the same three |
| L45–59 "no `.git` anywhere up the tree" | unchanged, still `undefined` |
| L62–82 "an fs whose `exists()` always throws" | **relocated** to the new `test/unit/repository/file-system-layout-probe.test.ts` — this is where the absent-vs-`PERMISSION_DENIED` narrowing now lives. Relocated, never dropped |
| L84–103 "`.git` that exists but is a file … does NOT return that layout" | **inverted** to "resolves the pointer". Its stale equivalent-mutant comment about `if (found)` must go with it |

New cases (design's test-strategy table) — build them over `MemoryFileSystem({ rootDir: '/repo' })`
+ `posixPolicy` + `fileSystemLayoutProbe`, or a hand-rolled stub `LayoutProbe` where
a shape the memory FS cannot express is needed:

| case | expectation |
|---|---|
| `.git` dir with `objects` + `refs` + `HEAD` | `{ workDir, gitDir, bare: false }`, **no** `commonDir` key |
| `.git` dir missing `objects` | skipped, walk continues |
| `.git` dir missing `refs` | skipped, walk continues (**separate test** — isolated guard) |
| `.git` dir missing `HEAD` | skipped, walk continues (**separate test**) |
| `.git` file, absolute pointer, admin dir with `commondir: ../..` | `commonDir` set, `gitDir` = admin dir |
| `.git` file, **relative** pointer | resolved against the dir holding the file, normalised — assert no `..` survives in the result |
| `.git` file, target has no `commondir` | `commonDir` key absent |
| `.git` file, `commondir` absolute | used verbatim (after `resolve`) |
| `.git` file, malformed content, valid repo one level up | throws `GITFILE_INVALID_FORMAT` with `data.path` = the gitfile path; the outer repo is **not** returned |
| `.git` file, `gitdir: \n` | throws `GITFILE_NO_PATH` (**separate test**) |
| `.git` file, target missing / lacks `objects`+`refs` | throws `NOT_A_REPOSITORY` with `data.path` = the **worktree** dir the caller named |
| `.git` file whose `commondir` is empty | throws `GITFILE_INVALID_FORMAT` with `data.path` = the **commondir** path |
| `.git` file, `readUtf8` returns `undefined` (stub probe) | throws `GITFILE_INVALID_FORMAT` |
| walk from a sub-directory of a worktree | same layout as from its root |
| nothing found up to root | `undefined` |

Assert error **data**, never a bare `toThrow(TsgitError)` — use try/catch +
`expect(err.data).toEqual({ code, path })`, per the mutation-resistant conventions.

**Trap — `MemoryFileSystem` rejects `rootDir: '/'`.** Root every fixture at
`/repo` and keep the whole tree beneath it. Directories are created implicitly by
writes, so `mkdir('/repo/.git/objects')` + `mkdir('/repo/.git/refs')` (or a file
inside each) is how you make them exist as directories.

**Trap — mutation.** `find-layout.ts` is in the `application` bucket (break 95).
Every boolean guard in `isGitDirectory` needs its own isolated test (three of them);
the `parent === current` root-termination and the `commonDir !== gitDir` omission
both need a killing test.

### TDD steps

1. **RED** `test/unit/repository/file-system-layout-probe.test.ts` — relocate the
   throwing-adapter case: a stub `FileSystem` whose `stat`/`readUtf8` reject; assert
   `fileSystemLayoutProbe(fs).stat(p)` resolves to `undefined` and
   `.readUtf8(p)` resolves to `undefined`. Plus a `MemoryFileSystem({rootDir:'/repo'})`
   case: `.stat('/outside')` ⇒ `undefined` (the `PERMISSION_DENIED` narrowing).
   Fails: module not found.
2. **GREEN** create `src/ports/layout-probe.ts` + `src/repository/file-system-layout-probe.ts`.
3. **RED** rewrite `test/unit/repository/find-layout.test.ts` to the table above,
   calling `findLayout(fileSystemLayoutProbe(fs), cwd, posixPolicy)`. Fails: current
   `findLayout` takes a `FileSystem`, ignores `.git` files, and does not validate
   directories — expect `TypeError`/wrong-shape/`undefined` mismatches.
4. **GREEN** rewrite `src/repository/find-layout.ts` per the pseudo-code, importing
   `parseGitfilePointer`/`parseCommondir` from `src/domain/worktree/gitfile.js`,
   `gitfileInvalidFormat`/`gitfileNoPath` from `src/domain/worktree/error.js`, and
   `notARepository` from `src/domain/repository/error.js`.
5. **REFACTOR** extract `layoutFromGitfile` for Part 6's browser reuse; verify each
   helper stays < 20 lines and the module keeps its `PathPolicy` type-only import
   from `adapters/node/path-policy.js` (the precedent `check:architecture` allows).
6. Re-run the gate; run `npm run check:dead-code` to confirm knip still sees both new
   modules as reachable.

### Gate

```
npx vitest run test/unit/repository/find-layout.test.ts test/unit/repository/file-system-layout-probe.test.ts && npm run check:types && ./node_modules/.bin/biome check src/ports/layout-probe.ts src/repository/find-layout.ts src/repository/file-system-layout-probe.ts test/unit/repository/find-layout.test.ts test/unit/repository/file-system-layout-probe.test.ts
```

### Commit

```
feat(repository): resolve gitdir pointers in the discovery walk
```

---

## Part 3 — Facade layout plumbing, node-shim discovery, interop discovery pairs

### Context

This is the part that makes `openRepository({ cwd: <linked worktree> })` work on
node. Four source edits plus the interop file.

**1. `src/repository.ts` L127–132** — `RepositoryLayoutInput` gains the field that
mirrors `RepositoryLayout` (`src/ports/context.ts` L33):

```ts
export interface RepositoryLayoutInput {
  readonly workDir: string;
  readonly gitDir: string;
  readonly bare: boolean;
  readonly commonDir?: string;   // ← new
  readonly homeDir?: string;
}
```

Retire the stale doc comment above it that says discovery "is deferred to a
follow-up".

**2. `src/repository.ts` L403** — today:

```ts
// The facade opens a main/normal repo (linked-worktree discovery is deferred,
// ADR-296), so its common dir is the gitDir.
const commonDir = fallback.layout.gitDir;
```

becomes `const commonDir = fallback.layout.commonDir ?? fallback.layout.gitDir;`
with that comment retired (it is now false).

**3. `src/repository.ts` L383–394** — the single-root wrap:

```ts
fs: wrapFsValidator(detected.fs, fallback.layout.workDir, computeConfigScopePaths(detected.fs)),
```

becomes a multi-root wrap over the **containment-minimised** root set.
`wrapFsValidator` already accepts `roots: string | ReadonlyArray<string>` and admits
a path contained in **any** root (L53–68).

**Create** `src/repository/layout-roots.ts`:

```ts
export const layoutRootsOf = (layout: RepositoryLayoutInput): ReadonlyArray<string> => …
```

- Input order: `[workDir, gitDir, commonDir ?? gitDir]`.
- Dedupe, then drop any root already contained in another; preserve first-seen order
  so `workDir` stays first (the guard's hot path).
- Reuse the containment predicate rather than re-deriving it: **export**
  `isContainedIn` from `src/repository/wrap-fs-validator.ts` (currently
  module-private at L181) and import it here. knip's `ignoreExportsUsedInFile: true`
  means the new export is not flagged.
- `layout-roots.ts` does `import type { RepositoryLayoutInput } from '../repository.js'`
  while `repository.ts` imports `layout-roots.js` at runtime. That is **not** a cycle
  — the type import is erased. `src/repository/find-layout.ts` already does exactly
  this; do not restructure to "avoid" it.

Minimisation is **not cosmetic**: `guard()` runs on every path-taking FS call, and a
normal repo would otherwise pay two extra prefix comparisons forever. Required
outcomes:

| layout | `layoutRootsOf` |
|---|---|
| normal repo `/r` + `/r/.git`, no `commonDir` | `['/r']` — bit-identical to today |
| main worktree of a bare repo | `[workDir]` after minimisation (or `[gitDir]` when `gitDir` is not under `workDir`) |
| linked worktree `/wt` + `/main/.git/worktrees/wt` + `/main/.git` | `['/wt', '/main/.git']` |
| hand-written absolute `commondir` in an unrelated subtree | all three retained |

**4. `src/repository.ts` L406** — `worktreeFs`'s `const roots = [...paths, commonDir]`
becomes `[...paths, ...layoutRoots]`, so a worktree child Context reaches the admin
dir even in the unrelated-subtree case. `layoutRoots` already contains `commonDir`,
so the `const commonDir` binding at L403 may become unused once both call sites move
— biome's unused-variable rule will say so. Either drop it or keep it only if it is
still read; do not silence the rule.

**5. `src/index.node.ts`** — the biggest edit.

- **Delete** `discoverLayout` (L106–126) entirely.
- Add a raw-`node:fs/promises` `LayoutProbe`. It must stay raw: the walk climbs
  above `cwd`, which the bounded `NodeFileSystem` would reject — that is exactly what
  the existing L54–58 comment documents. Add `readFile` to the existing
  `import { realpath, stat } from 'node:fs/promises'`.

  ```ts
  const nodeLayoutProbe: LayoutProbe = {
    stat: async (p) => {
      const s = await stat(p).catch(() => undefined);
      return s === undefined ? undefined : { isDirectory: s.isDirectory(), isFile: s.isFile() };
    },
    readUtf8: (p) => readFile(p, 'utf8').catch(() => undefined),
  };
  ```

- Replace the `discoverLayout(resolvedCwd)` call with
  `findLayout(nodeLayoutProbe, resolvedCwd, nativePolicy)`; the `?? { workDir: resolvedCwd,
  gitDir: nodePath.join(resolvedCwd, '.git'), bare: false }` fallback stays **exactly
  as-is** — `openRepository` + `init`/`clone` against a not-yet-existing directory
  must keep working (that is why L52 falls back to `nodePath.resolve` when `realpath`
  throws).
- **Canonicalise (ADR-537).** `realpath` the discovered `gitDir` and `commonDir` with
  the same `.catch(() => path)` fallback L52 uses. `workDir` needs none — it is
  derived by walking up from an already-realpathed `cwd`, and ancestors of a realpath
  are real. Without this, `commonAncestor` runs on unresolved paths while
  `NodeFileSystem` compares resolved ones → spurious `PATHSPEC_OUTSIDE_REPO` /
  `PERMISSION_DENIED` on every symlinked repo (the macOS `/var` → `/private/var`
  case, which the interop tmpdirs hit on every run).
- **L62** `const fs = new NodeFileSystem(layout.workDir);` becomes
  `new NodeFileSystem(commonAncestor([...layoutRootsOf(layout)], nativePolicy), nativePolicy)`.
  The raw adapter must be **wide enough**; the multi-root validator in the facade is
  the real gate. For a normal repo `commonAncestor(['/r'])` **is** `/r` — unchanged.
  `NodeFileSystem`'s constructor is `(rootDir, pathPolicy = nativePolicy, fsOps = realFsOps)`.

  **Security note, state it in the JSDoc so the review pass does not re-open it:**
  for a linked worktree the raw adapter's root can be broad (the common ancestor of
  the worktree and the repo). This is not a new pattern — `makeWorktreeFs` (L89–93)
  has done exactly this since ADR-298, and `wrapFsValidator`'s multi-root guard is
  the boundary that narrows it back to `layoutRoots`. The only way to reach the raw
  broad-rooted adapter is `unsafeRawAdapters: true`, which is an explicit,
  pre-existing caller opt-out.
- **L89–93 `makeWorktreeFs` needs NO change** — it is already called with the
  facade's full root list and roots itself at their common ancestor.

Cross-volume Windows worktrees stay the documented ADR-495 limitation:
`commonAncestor` returns the first input, so the operation fails **closed** with
`PATHSPEC_OUTSIDE_REPO` rather than silently reading the wrong tree. Do not widen it.

**Tests:**

- **Create** `test/unit/repository/layout-roots.test.ts` — the four rows of the
  minimisation table, plus the dedupe path and the order-preservation assertion.
  `src/repository/**` is in the `application` mutation bucket (break 95): each
  drop-decision needs an isolated killing test.
- **Extend** `test/unit/repository/repository.test.ts` — `commonDir` flows from
  `fallback.layout` to `ctx.layout`; the wrapped `fs` admits a path under
  `commonDir` and still rejects a path outside every root. This file also carries the
  sorted `Object.keys(sut)` facade-surface snapshot — it is **not** affected (no new
  `Repository` method).
- **Extend** `test/integration/node-shim.test.ts` — after `repo.worktree.add`,
  `openRepository({ cwd: <worktree> })` and assert
  `ctx.layout.{workDir,gitDir,commonDir}` against the realpathed expectations, and
  that the layout for a plain repo still has **no** `commonDir` key. Existing setup:
  `mkdtemp(path.join(os.tmpdir(), 'tsgit-it-'))` in `beforeEach`, `realpath` before
  every path comparison.
- **Create** `test/integration/linked-worktree-discovery-interop.test.ts` with the
  header:

  ```
  /**
   * <one-paragraph description>
   *
   * @proves
   *   surface:        openRepository
   *   bucket:         cross-tool-interop
   *   unique:         linked-worktree, submodule and separate-git-dir discovery matches git rev-parse
   *   interopSurface: worktree
   */
  ```

  `unique` must be 12–200 chars; `surface` must match `^[a-z][a-zA-Z0-9.-]{1,40}$`;
  `cross-tool-interop` files must live at `test/integration/` root (not a
  subdirectory). `interopSurface: worktree` is already declared by a `@writes` tag in
  `src/application/commands/worktree.ts`; `test/integration/worktree-interop.test.ts`
  also claims it — duplicate claims are allowed by `computeGaps`, but run
  `npm run check:write-surfaces` in-part to confirm.

  Scenarios landing **in this part** (B, C, I land in Parts 4–5):

  | # | scenario | assertions |
  |---|---|---|
  | A | `git worktree add ../wt HEAD~1`, tsgit opens `wt` | `layout.gitDir` / `layout.commonDir` equal `git -C wt rev-parse --path-format=absolute --git-dir --git-common-dir`; `revParse('HEAD')`, `log` oids, `status`, `diff` match git from the same cwd |
  | D | cwd is `<wt>/sub/dir` | identical layout pair to A |
  | E | submodule working directory | `revParse('HEAD')` equals `git -C main/sub rev-parse HEAD`, **not** the superproject's — this is the silent-wrong-repo regression |
  | F | `git init --separate-git-dir` | `layout.commonDir` is **absent** (⇒ equals `gitDir`); `gitDir` equals git's `--git-dir`; HEAD matches |
  | G | refusals, co-pinned | malformed / no-path / dangling `.git` file inside an outer repo: tsgit throws the structured code with the right `data.path`, **and** `tryRunGitWithExit` shows exit 128; neither tool falls back to the enclosing repo |
  | H | round-trip | `repo.worktree.add` then `openRepository` at the created path; git and tsgit agree on `--git-dir`/`--git-common-dir` |

  Scope A's read assertions to `revParse` / `log` / `status` / `diff`.
  **Do not** assert `branch.list` / `tag.list` / `worktree.list` here — those sites
  are still `ctx.layout.gitDir` until Parts 4–5 and would red this part.

**Pinned rows these scenarios encode** (design §1a/§1b):

| file | exact bytes |
|---|---|
| `$T/wt/.git` | `gitdir: $T/main/.git/worktrees/wt\n` (absolute) |
| `$T/main/.git/worktrees/wt/commondir` | `../..\n` |
| `$T/main/.git/worktrees/wt/gitdir` | `$T/wt/.git\n` |

| cwd | `--git-dir` | `--git-common-dir` |
|---|---|---|
| `$T/wt` and `$T/wt/sub/dir` | `$T/main/.git/worktrees/wt` | `$T/main/.git` |
| `$T/separate` | `$T/separate-dir` | `$T/separate-dir` |

**Surface gates to pre-pay in this part:**

- `reports/api.json` — `RepositoryLayoutInput` changed. Run `npm run docs:json` and
  commit the regenerated file. `check:doc-typedoc` is a **prepush** gate, so a green
  local `validate` can still precede a red push; pre-pay it here.
- `npm run check:test-pyramid` — a new integration file shifts the tier ratio
  (`integration` target 15, `warnAbove` 25). Run it; edit `test-pyramid-budgets.json`
  **only if** it actually warns or fails. Do not preemptively edit the budgets.
- `npm run check:write-surfaces` — confirm the new `interopSurface` claim is accepted.

**Trap — ADR-534 fallout on existing fixtures.** This part is where `findLayout` goes
live in production, so ADR-534's directory validation starts biting for the first
time: a `.git` directory lacking `objects/` or `refs/` is now skipped. Any existing
fixture that fakes a repo with a bare `mkdir .git` will start walking past it. Run
`npm run test:unit`, `npm run test:integration` **and** `npm run test:parity` before
committing; fix the fixtures (add `objects/`, `refs/`, `HEAD`), never the predicate.

**Trap — sync-git deadlock.** Never use the sync `git`/`runGit` helpers for anything
that crosses an in-process HTTP round trip. Nothing in this part does, but the
sandbox also reaps long-running bash: run `npm run test:integration` detached
(`nohup … &`, poll) if it approaches the timeout.

### TDD steps

1. **RED** `test/unit/repository/layout-roots.test.ts` — the four minimisation rows +
   dedupe + order. Fails: module not found.
2. **GREEN** export `isContainedIn` from `src/repository/wrap-fs-validator.ts`;
   create `src/repository/layout-roots.ts`.
3. **RED** extend `test/unit/repository/repository.test.ts` — a `fallback.layout`
   carrying `commonDir` yields `ctx.layout.commonDir`, and the wrapped `fs` reads a
   path under `commonDir` without throwing. Fails: `commonDir` is not on
   `RepositoryLayoutInput` (type error) and the validator is single-root.
4. **GREEN** apply the four `src/repository.ts` edits.
5. **RED** extend `test/integration/node-shim.test.ts` with the worktree-discovery
   case. Fails: `NOT_A_DIRECTORY` at `<wt>/.git/HEAD` — the exact measured symptom.
6. **GREEN** rewrite `src/index.node.ts`: delete `discoverLayout`, add the raw probe,
   call `findLayout`, realpath `gitDir`/`commonDir`, root `NodeFileSystem` at
   `commonAncestor(layoutRootsOf(layout))`.
7. **RED → GREEN** create the interop file with scenarios A, D, E, F, G, H. Each
   scenario group gets its own `beforeAll(fn, 60_000)`; open a **fresh**
   `openRepository` after every git-side write.
8. **REFACTOR** confirm `openRepository` stays readable — extract the layout
   discovery + canonicalisation into one named helper in `index.node.ts` rather than
   inlining it into the option-stripping flow.
9. `npm run docs:json` and stage `reports/api.json`. Run `npm run check:test-pyramid`
   and `npm run check:write-surfaces`.

### Gate

```
npx vitest run test/unit/repository/layout-roots.test.ts test/unit/repository/repository.test.ts test/integration/node-shim.test.ts test/integration/linked-worktree-discovery-interop.test.ts && npm run check:types && ./node_modules/.bin/biome check src/repository.ts src/repository/layout-roots.ts src/repository/wrap-fs-validator.ts src/index.node.ts test/unit/repository/layout-roots.test.ts test/unit/repository/repository.test.ts test/integration/node-shim.test.ts test/integration/linked-worktree-discovery-interop.test.ts
```

### Commit

```
feat(repository): discover a linked worktree layout from the node shim
```

---

## Part 4 — Shared-dir (⇒ common) conformance sweep

### Context

With a `commonDir !== gitDir` Context now reachable through the public facade, every
remaining `ctx.layout.gitDir` site is observable. ADR-532 rules that the **whole**
sweep lands with discovery — a partial split is a silent-corruption trap
(`repo.commit()` from a worktree would write objects into `<admin>/objects/` that no
git and no other worktree can see).

This part does the **shared** half. Part 5 does the per-worktree half.

**Authoritative split** — `git rev-parse --git-path <p>` from `$T/wt`, design §1c.
Everything in this table's right column resolves to the **common dir** `C`:

```
objects, objects/pack, objects/info/commit-graph, packed-refs, config, shallow,
refs/heads/*, refs/tags/*, refs/remotes/*, refs/stash, logs/refs/**,
info/exclude, info/attributes, hooks/*, worktrees
```

Two rows contradict a naive reading and are **already correct** — do not touch them:
`info/sparse-checkout` is **per-worktree** while the rest of `info/` is shared, and
`logs/HEAD` is **per-worktree** while the rest of `logs/` is shared.

**End-to-end confirmation** (design §1d — `git commit` / `branch` / `config --local` /
`stash` run from `$T/packed-wt`):

| artefact | landed in |
|---|---|
| new loose objects | `$T/packed/.git/objects` — `$T/packed/.git/worktrees/packed-wt/objects` is **never created** |
| `refs/heads/feature`, `refs/heads/wt-made-branch`, `refs/stash` | `$T/packed/.git/refs/…` |
| `logs/refs/heads/feature` | `$T/packed/.git/logs/…` |
| `config` key | `$T/packed/.git/config` — no admin `config` |
| `logs/HEAD` | `$T/packed/.git/worktrees/packed-wt/logs/HEAD` |

**Sites to change — every one is `ctx.layout.gitDir` ⇒ `commonGitDir(ctx)`** (import
from `src/application/primitives/path-layout.js`; the barrel
`src/application/primitives/index.ts` L53 only re-exports `getRepoRoot` and
`sparseCheckoutPath`, so import from the module directly, as the read layer already
does):

| file:line | current expression |
|---|---|
| `src/application/primitives/write-object.ts:38,39` | `objectsDir(ctx.layout.gitDir, prefix)`, `looseObjectPath(ctx.layout.gitDir, computed)` |
| `src/application/primitives/fetch-pack.ts:515` | `` `${ctx.layout.gitDir}/objects/pack` `` → use `packsDir(commonGitDir(ctx))` |
| `src/application/commands/fetch-missing.ts:56` | `looseObjectPath(ctx.layout.gitDir, id)` |
| `src/application/primitives/update-config.ts:425` | `` `${ctx.layout.gitDir}/config` `` (`updateConfigEntries`) |
| `src/application/primitives/update-config.ts:556` | `` `${ctx.layout.gitDir}/config` `` (`updateConfigOperations`) |
| `src/application/primitives/shallow-file.ts:32,33` | `shallowPath`, `shallowLockPath` |
| `src/application/primitives/run-hook.ts:35,37` | hooks-dir fallback + the empty-`hooksPath` sentinel |
| `src/application/commands/branch.ts:65` | `` `${ctx.layout.gitDir}/refs/heads` `` (`branchList`) |
| `src/application/commands/tag.ts:67` | `` `${ctx.layout.gitDir}/refs/tags` `` (`tagList`) |
| `src/application/commands/fetch.ts:297` | `` `${ctx.layout.gitDir}/${dir}` `` over `['refs/remotes/<remote>', 'refs/tags']` |
| `src/application/commands/fetch.ts:405` | `` `${ctx.layout.gitDir}/refs/remotes/${remoteName}` `` (`prune`) |
| `src/application/primitives/stash-ref.ts:52` | `looseRefPath(ctx.layout.gitDir, STASH_REF)` |

**`run-hook.ts` needs a signature-safe helper.** `resolveHooksDir(hooksPath: string | undefined,
layout: RepositoryLayout)` takes a **layout**, not a `Context`, so it cannot call
`commonGitDir(ctx)`. Add to `src/application/primitives/path-layout.ts`:

```ts
export const commonDirOf = (layout: RepositoryLayout): string => layout.commonDir ?? layout.gitDir;
export const commonGitDir = (ctx: Context): string => commonDirOf(ctx.layout);
```

so there is exactly one fallback expression in the codebase. `resolveHooksDir` then
uses `commonDirOf(layout)` for both L35 and L37. Extend
`test/unit/application/primitives/path-layout.test.ts` (which already covers
`commonGitDir`) with `commonDirOf`'s two arms so the new function is not left to the
call-site tests alone.

**`run-hook.ts` L73 must NOT change.** Design §1i, measured: a `post-commit` hook
placed in the **common** `hooks/` dir fired on a commit made in `$T/wt` with
`GIT_DIR=$T/main/.git/worktrees/wt` (the **per-worktree** gitdir) and
`GIT_COMMON_DIR` unset. Hook **lookup** is shared; hook **`GIT_DIR`** is
per-worktree. L73 is already correct.

**`fetch.ts:297` carries a stale equivalent-mutant comment** (L290–294) explaining
that an empty template head yields `${gitDir}/origin`. After the change it yields
`${commonDir}/origin`. Re-verify the equivalence argument by hand against the new
expression and rewrite the comment to match — a carried-forward proof that no longer
describes the code is worse than none.

**Sites deliberately left alone** (each pinned per-worktree in §1c) — listing them so
the sweep is provably complete and a reviewer does not re-open them:
`read-index.ts:21`, `internal/index-lock.ts:48,49`, `caching-index-resolver.ts:142`,
`read-sparse-checkout.ts:34`, `write-sparse-checkout.ts:21,22`,
`internal/repo-state.ts:46,120,172`, `internal/merge-state.ts:19–21`,
`internal/cherry-pick-state.ts:12`, `internal/revert-state.ts:17`,
`internal/rebase-state.ts:96,98`, `internal/sequencer-state.ts:40`,
`internal/commit-hooks.ts:39`, `snapshot/snapshot-factory.ts:87`,
`apply-textconv.ts:28,34`, `sign-payload.ts:75,92,99`,
`commands/submodule.ts:313` + `internal/submodule-context.ts:16,50` (`modules/` is
per-worktree — confirmed end-to-end: `git submodule add` from `$T/packed-wt` created
`$T/packed/.git/worktrees/packed-wt/modules/sub`), `checkout.ts:134`,
`commit.ts:233`, `walk-submodules.ts:49,76`. `clone.ts`, `init.ts` and
`internal/bootstrap.ts` also keep `gitDir` — both create a fresh repository where
`commonDir === gitDir`.

**Tests.**

- **Create** `test/unit/application/primitives/commondir-writes.test.ts`, joining the
  existing `commondir-*.test.ts` family. Use `buildSeededContext()` +
  the `asWorktreeChild` helper shape shown in the shared background. One
  `describe('Given …') > describe('When …') > it('Then …')` per site, asserting the
  path actually touched — e.g. after `writeObject(childCtx, …)`, the object exists
  under `<common>/objects/**` and **not** under `<admin>/objects/**`. Assert **both**
  halves: presence in common and absence in admin. The absence half is what kills the
  mutant that reverts the change.
- Where an existing unit test already covers the site, extend that file instead of
  duplicating: `write-object.test.ts`, `fetch-pack.test.ts`, `update-config.test.ts`,
  `shallow-file.test.ts`, `run-hook.test.ts`, `stash-ref.test.ts`,
  `commands/branch.test.ts`, `commands/tag.test.ts`, `commands/fetch.test.ts`,
  `commands/fetch-missing.test.ts`. Prefer the shared `commondir-writes.test.ts` for
  the split assertion and keep the existing files' scope unchanged.
- **Extend** `test/integration/linked-worktree-discovery-interop.test.ts` with:

  | # | scenario | assertions |
  |---|---|---|
  | B | packed refs + commit-graph: `git pack-refs --all`, `git commit-graph write --reachable`, `git repack -adq`; worktree on a packed branch | branches/tags resolve from the common `packed-refs`; walk results match `git rev-list`; `<admin>/objects` **never exists** |
  | C | writes from the worktree Context — `commit`, `branch.create`, `tag.create`, `config.set`, `stash.push` | new objects / refs / reflogs / config land in the **common** dir and **not** the admin dir (§1d table); `HEAD`, `index`, `ORIG_HEAD` land in the admin dir; git reads the result (`git -C wt log`, `git -C main show-ref`, `git -C wt status`) |

  Scenario C is the ADR-532 proof — without it the sweep is unpinned.
  Scenario B's `branch.list` assertion is now live (`branch.ts:65` landed here);
  `tag.list` likewise.

**Trap — `run-hook` + `readConfig`.** `resolveHooksDir` is also reached with a
`core.hooksPath` set. Only the two **fallback** expressions change; the `~/`,
absolute and workDir-relative arms are untouched.

**Trap — `update-config` cache.** Both writers call `invalidateConfigCache(ctx)`.
Reads already resolve from the common dir (`config-read.ts:157`) and `repo.config.*`
already routes through `resolveScopePath` (`internal/config-scope.ts:72`). These two
writers are the stale path used by `remote.{add,remove,rename,setUrl}`, `clone` and
`submodule` — assert one of those command paths end-to-end in scenario C.

### TDD steps

1. **RED** `test/unit/application/primitives/commondir-writes.test.ts` — object
   write, pack write, config write, shallow write, hooks-dir fallback, stash-ref
   write, `branchList` / `tagList` directory, fetch loose-dirs, fetch prune,
   `fetch-missing` loose probe. Each fails by finding the artefact under
   `<admin>/…` instead of `<common>/…`.
2. **GREEN** add `commonDirOf` to `path-layout.ts` and redefine `commonGitDir` on top
   of it; apply the 12 call-site edits in the table.
3. **REFACTOR** rewrite the `fetch.ts` L290–294 equivalent-mutant comment against the
   new expression; re-verify the argument by hand.
4. **RED → GREEN** extend the interop file with scenarios B and C. Remember the fresh
   `openRepository` after every git-side write and the 60 s `beforeAll`.
5. Run `npx vitest run test/unit/application` for the whole primitives+commands unit
   surface — several existing tests build a Context with `commonDir` absent and must
   stay byte-identical (the `commonDir ?? gitDir` fallback makes this mechanical).

### Gate

```
npx vitest run test/unit/application/primitives/commondir-writes.test.ts test/unit/application/primitives/write-object.test.ts test/unit/application/primitives/fetch-pack.test.ts test/unit/application/primitives/update-config.test.ts test/unit/application/primitives/shallow-file.test.ts test/unit/application/primitives/run-hook.test.ts test/unit/application/primitives/stash-ref.test.ts test/unit/application/commands/branch.test.ts test/unit/application/commands/tag.test.ts test/unit/application/commands/fetch.test.ts test/unit/application/commands/fetch-missing.test.ts test/integration/linked-worktree-discovery-interop.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/primitives/path-layout.ts src/application/primitives/write-object.ts src/application/primitives/fetch-pack.ts src/application/primitives/update-config.ts src/application/primitives/shallow-file.ts src/application/primitives/run-hook.ts src/application/primitives/stash-ref.ts src/application/commands/branch.ts src/application/commands/tag.ts src/application/commands/fetch.ts src/application/commands/fetch-missing.ts test/unit/application/ test/integration/linked-worktree-discovery-interop.test.ts
```

### Commit

```
fix(worktree): route shared-dir reads and writes to the common git dir
```

---

## Part 5 — Per-worktree refs, reflog/ref enumeration union, main-worktree entry

### Context

The per-worktree half of the ADR-532 sweep, plus the two union sites and ADR-540.

**Authoritative split** — everything here resolves to the worktree's **own** gitdir
`A` (design §1c left column):

```
HEAD, index, index.lock, ORIG_HEAD, MERGE_HEAD, CHERRY_PICK_HEAD, REVERT_HEAD,
BISECT_HEAD, REBASE_HEAD, FETCH_HEAD, AUTO_MERGE, COMMIT_EDITMSG, MERGE_MSG,
SQUASH_MSG, rebase-merge, rebase-apply, sequencer, BISECT_LOG, BISECT_START,
logs/HEAD, refs/bisect/*, refs/worktree/*, refs/rewritten/*, config.worktree,
info/sparse-checkout, modules, description
```

`perWorktreeRefDir(ctx, name)` (`src/application/primitives/path-layout.ts` L31)
already encodes exactly this for refs, delegating to
`isPerWorktreeRef` (`src/domain/refs/per-worktree-ref.ts`). Use it — never re-derive
the predicate.

**Sites to change — `ctx.layout.gitDir` ⇒ `perWorktreeRefDir(ctx, <name>)`:**

| file:line | current expression | note |
|---|---|---|
| `src/application/primitives/update-ref.ts:26` | `looseRefPath(ctx.layout.gitDir, name)` | `ref-store.writeLoose`/`removeLoose` already use `perWorktreeRefDir`; only this direct path is stale |
| `src/application/primitives/write-symbolic-ref.ts:35` | `looseRefPath(ctx.layout.gitDir, validatedName)` | |
| `src/application/commands/branch.ts:131` | `` `${ctx.layout.gitDir}/${name}` `` (`branchDelete` existence probe) | |
| `src/application/commands/tag.ts:208` | `` `${ctx.layout.gitDir}/${name}` `` (`tagDelete` existence probe) | |
| `src/application/commands/checkout.ts:91` | `` `${ctx.layout.gitDir}/${branchRef}` `` | L134's `HEAD` write **stays** `gitDir` |
| `src/application/commands/fetch.ts:384` | `` `${ctx.layout.gitDir}/${name}` `` (`readExistingRef`) | `FETCH_HEAD` is per-worktree, `refs/remotes/*` shared — one helper, both answers, which is exactly what `perWorktreeRefDir` gives |

**Union sites — not a simple substitution:**

- `src/application/primitives/enumerate-refs.ts:27` (`collectLooseRefs`) — walk
  **both** `` `${commonGitDir(ctx)}/refs` `` and `` `${ctx.layout.gitDir}/refs` ``,
  deduped, skipping a root that does not exist. The worktree's own `refs/` holds
  `refs/bisect|worktree|rewritten`. Dedupe must collapse the two walks when
  `gitDir === commonDir` (the normal-repo case) so the existing behaviour is
  byte-identical. L14's `HEAD` existence probe **stays** `ctx.layout.gitDir`.
- `src/application/primitives/reflog-store.ts:55` (`listReflogs`) — union of
  `logsDir(ctx.layout.gitDir)` and `logsDir(commonGitDir(ctx))`, deduped when equal.
  `writeReflog`/`deleteReflog` (L41, L47) already use `perWorktreeRefDir` — leave
  them.

**ADR-540 — `list-worktrees.ts` `mainEntry` (L57–66).** Today:

```ts
const mainEntry = async (ctx: Context): Promise<WorktreeEntry> => {
  const path = ctx.layout.workDir as FilePath;
  …
};
```

The main worktree's path must be derived from the **common dir**: strip a trailing
`/.git`; if there is no such suffix, use the common-dir path itself. The file already
holds `const GIT_SUFFIX = '/.git'` and the identical strip in `linkedEntry` (L79–81)
— extract one shared helper and use it in both places (DRY, and it gives the strip a
single mutation target).

**Measured rows this part pins** (canonical git 2.55.0, measured in a `mktemp -d`
throwaway while writing this plan — these extend design §1h):

| invocation | first `worktree` line |
|---|---|
| `git worktree list --porcelain` from a **linked** worktree of a normal repo | the main worktree path (`$T/main`) |
| `git worktree list --porcelain` from `$T/separate-wt` (linked, separate-git-dir) | `$T/separate-dir` — the **gitdir**, not the working tree |
| `git worktree list --porcelain` from `$T/separate` (the **main** worktree itself, separate-git-dir) | `$T/separate-dir` — **also the gitdir** |
| `git worktree list --porcelain` from a worktree of a bare repo | `$T/bare.git` + a `bare` line |

The third row resolves the one open question ADR-540 left implicit. Its "provable
no-op for every existing shape" claim is **slightly loose**: for a
`--separate-git-dir` main worktree, tsgit today reports the working tree
(`$T/separate`) while git reports the gitdir (`$T/separate-dir`). The derivation is
therefore not a no-op there — it **fixes a pre-existing divergence**, in the
direction the prime directive demands. Implement ADR-540 option (a) unchanged
(always derive; no `commonDir !== gitDir` guard) and pin all four rows in interop
scenario I. No escalation needed; this note exists so a reviewer does not read the
behaviour change as a regression.

For a normal repo the derivation is genuinely a no-op: `/r/.git` → `/r` = `workDir`.
For a bare repo `commonDir` has no `/.git` suffix, so the path is the gitdir itself —
matching row 4. The `main: true` flag follows the derived path.

**Scope fence on `bare`.** `mainEntry` decides `bare` from `ctx.layout.bare`. Opened
from a **linked worktree of a bare repo**, `layout.bare` is `false` (the worktree has
a working tree), so tsgit would report `bare: false` for the main entry where git
prints a `bare` line. Deciding otherwise needs `core.bare` from the common config —
and **`core.bare` config-driven layout overrides and bare-repo discovery are
explicitly Out of scope** in the design. So: derive the **path** per ADR-540 in every
shape (including bare), leave the **`bare` flag** exactly as it is, and do **not**
add a bare-repo-worktree interop scenario. Row 4 above is recorded as git's rule for
the future work, not as a target of this change. The bare shape is covered at the
**unit** tier only, with `ctx.layout.bare === true` (a bare repo opened directly),
which is the existing `mainEntry` bare branch.

**Tests.**

- **Create** `test/unit/application/primitives/commondir-per-worktree-refs.test.ts`
  in the existing `commondir-*` family. Per site, with the `asWorktreeChild` shape:
  - `updateRef(childCtx, 'refs/heads/x', oid, {})` writes under `<common>/refs/heads/x`;
    `updateRef(childCtx, 'refs/bisect/bad', …)` writes under `<admin>/refs/bisect/bad`.
    Two tests, both directions — one alone leaves a mutant alive.
  - Same both-directions pattern for `writeSymbolicRef`, `branchDelete`, `tagDelete`,
    `checkout`'s branch probe, `fetch`'s `readExistingRef` (`FETCH_HEAD` ⇒ admin,
    `refs/remotes/o/main` ⇒ common).
- **Extend** `test/unit/application/primitives/enumerate-refs.test.ts` — a child
  Context with a shared `refs/heads/main` in the common dir and a `refs/bisect/bad`
  in the admin dir returns **both**, once each; and a plain Context
  (`gitDir === commonDir`) returns each ref exactly once (the dedup proof).
- **Extend** `test/unit/application/primitives/reflog-store.test.ts` — same union +
  dedup shape for `listReflogs`.
- **Extend** `test/unit/application/primitives/list-worktrees.test.ts` — four separate
  `Given` blocks: normal repo (path unchanged = `workDir` — the no-op proof), bare
  repo (`ctx.layout.bare === true`, path = the gitdir, `bare: true` unchanged),
  separate-git-dir main (path becomes the gitdir — the divergence fix), and a child
  Context opened at a linked worktree (main entry is the derived main path,
  `main: true`, listed first). The file already has `seedMainHead` / `seedAdmin`
  helpers at L10–29 — extend them.
- **Extend** `test/integration/linked-worktree-discovery-interop.test.ts` with:

  | # | scenario | assertions |
  |---|---|---|
  | I | `worktree.list` from inside a linked worktree | entries match `git worktree list --porcelain` parsed into structured fields: main first, main path derived from the common dir. Cover the **normal** and **separate-git-dir** shapes; the bare shape is excluded per the scope fence above |

  Per ADR-249 the library returns structured data — reconstruct git's porcelain
  lines **inside the test** from the entries and compare; never assert a rendered
  string produced by the library.

**Trap — `updateRef` deletes.** `updateRef(…, { delete: true })` routes through
`deleteRef(store, name)` + `deleteReflog(ctx, name)`, both already
`perWorktreeRefDir`-aware. Only the `refPath` computed at L26 is stale — changing it
must not double-handle the delete branch.

**Trap — `enumerate-refs` recursion.** `walkLooseRefs` builds names from a `prefix`.
Running it twice with the same `'refs'` prefix over two roots is correct; the dedupe
happens in the caller's `Set<RefName>` in `enumerateRefs`. Do not dedupe inside the
walker.

**Trap — equivalent-mutant comments in `list-worktrees.ts`.** `byPath` carries two
`Stryker disable next-line` proofs keyed to distinct worktree paths. Extracting the
`/.git` strip does not touch them, but re-read them after the edit: a data-structure
or ordering change silently falsifies a carried-forward proof.

### TDD steps

1. **RED** `commondir-per-worktree-refs.test.ts` — both directions for each of the
   six substitution sites. Each fails by finding the ref under the wrong dir.
2. **GREEN** apply the six `perWorktreeRefDir` substitutions.
3. **RED** extend `enumerate-refs.test.ts` and `reflog-store.test.ts` with the
   union + dedup cases. Fail: the admin-dir entries are missing.
4. **GREEN** implement both unions with existence-guarded roots and caller-side dedup.
5. **RED** extend `list-worktrees.test.ts` with the four measured shapes. The
   separate-git-dir and linked-worktree cases fail on the current `workDir` path.
6. **GREEN** extract the `/.git`-strip helper and derive `mainEntry`'s path from
   `commonGitDir(ctx)`.
7. **RED → GREEN** interop scenario I across the normal / bare / separate-git-dir
   shapes.
8. **REFACTOR** confirm `mainEntry` and `linkedEntry` share exactly one strip helper
   and that `list-worktrees.ts` stays under the function-size limit.

### Gate

```
npx vitest run test/unit/application/primitives/commondir-per-worktree-refs.test.ts test/unit/application/primitives/enumerate-refs.test.ts test/unit/application/primitives/reflog-store.test.ts test/unit/application/primitives/list-worktrees.test.ts test/unit/application/primitives/update-ref.test.ts test/unit/application/primitives/write-symbolic-ref.test.ts test/unit/application/commands/branch.test.ts test/unit/application/commands/tag.test.ts test/unit/application/commands/checkout.test.ts test/unit/application/commands/fetch.test.ts test/integration/linked-worktree-discovery-interop.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/primitives/update-ref.ts src/application/primitives/write-symbolic-ref.ts src/application/primitives/enumerate-refs.ts src/application/primitives/reflog-store.ts src/application/primitives/list-worktrees.ts src/application/commands/branch.ts src/application/commands/tag.ts src/application/commands/checkout.ts src/application/commands/fetch.ts test/unit/application/ test/integration/linked-worktree-discovery-interop.test.ts
```

### Commit

```
fix(worktree): split per-worktree refs, reflogs and the main worktree entry
```

---

## Part 6 — Memory + browser shim discovery, parity coverage, final surface gates

### Context

ADR-538: the walk runs in **node + memory**; the **browser** resolves its fixed
`/{gitDirName}` entry pointer-aware, without a walk. A walk-up in OPFS terminates on
its first iteration (`dirname('/') === '/'`), so running it there is dead code with a
live cost.

**1. `src/index.default.ts` (memory).** Today the shim hardcodes
`layout: { workDir: '/repo', gitDir: '/repo/.git', bare: false }` and never
discovers. Change to:

```ts
const fs = new MemoryFileSystem(fsOptions);
const cwd = opts.cwd ?? DEFAULT_WORK_DIR;
const layout =
  (await findLayout(fileSystemLayoutProbe(fs), cwd, posixPolicy)) ??
  { workDir: DEFAULT_WORK_DIR, gitDir: DEFAULT_GIT_DIR, bare: false };
```

- `posixPolicy` from `src/adapters/node/path-policy.js` — the memory FS is POSIX-only
  by design, and `src/repository/` may `import type`/import from
  `adapters/node/path-policy.js` (the precedent `find-layout.ts` and
  `common-ancestor.ts` already set; `check:architecture` allows it).
- The `fs` is constructed **before** discovery and is `/repo`-bounded — that is
  intentional: it makes discovery honour the sandbox (R11).
- The seed (`opts.files`) is applied at construction, so discovery sees it.
- Behaviour for a fresh memory repo is **unchanged**: no `.git` ⇒ `findLayout`
  returns `undefined` ⇒ the hardcoded fallback. Verify this explicitly.
- The forwarded `cwd` stays `openRepositoryCore({ cwd: DEFAULT_WORK_DIR, ...coreOpts }, fallback)`
  — do not change the option-stripping shape.

**2. `src/index.browser.ts`.** Today:

```ts
layout: { workDir: ROOT_WORK_DIR, gitDir: `${ROOT_WORK_DIR}${gitDirName}`, bare: opts.bare ?? false },
```

with `ROOT_WORK_DIR = '/'`. Change to: build the `BrowserFileSystem`, probe
`` `${ROOT_WORK_DIR}${gitDirName}` `` through `fileSystemLayoutProbe(fs)`; when the
entry is a **file**, call `layoutFromGitfile(probe, ROOT_WORK_DIR, entryPath, posixPolicy)`
(the helper Part 2 extracted) and use its result; otherwise keep today's literal
layout untouched. `layoutFromGitfile` returns `bare: false` unconditionally, so the
shim must **override** it with `opts.bare ?? false` — discovery never decides `bare`.

- **Do not** change `ROOT_WORK_DIR`. It is `'/'` and slash-terminated by design; the
  "workDir never ends with `/`" assumption is **false** for the browser, and
  collapsing the join changes OPFS paths (`//p` → `/p`) and breaks slash-structure
  code like `dirname`.
- `worktreeFs` is absent in the browser (ADR-298), so worktrees stay under the OPFS
  root. No change there.
- The browser shim is exercised only by `test/browser/*.spec.ts` (playwright, run in
  CI; `validate` excludes `test:e2e`). Keep the change minimal and type-safe; do not
  add a browser spec unless the existing parity spec already covers the path.

**3. Sandbox-escape semantics — decided, do not re-litigate.** ADR-535 (accepted)
puts the blanket "unreachable reads as absent" narrowing inside
`fileSystemLayoutProbe`, once. Consequence: a pointer resolving **outside** a
sandboxed adapter's root (`gitdir: /outside` in a `/repo`-rooted memory FS) makes
`isGitDirectory` fail, so discovery **hard-stops** with
`NOT_A_REPOSITORY { path: <the worktree dir the caller named> }` — never a walk-up,
which is the invariant that matters (ADR-533). The design's §7 prose ("surfaces the
adapter's own `PERMISSION_DENIED`") describes every **post-open** operation, where
the bounded `fs` does surface it; at discovery time the ADR governs. Pin the
hard-stop with a test and flag the §7 wording for the docs phase.

**4. Tests.**

- **Create** `test/unit/repository/memory-shim-discovery.test.ts` — imports
  `openRepository` from `src/index.default.ts` and seeds a worktree-shaped tree
  **wholly inside `/repo`** via the `files` option:

  ```
  /repo/.git/HEAD                        'ref: refs/heads/main\n'
  /repo/.git/refs/heads/main             '<oid>\n'            (makes refs/ a directory)
  /repo/.git/objects/info/packs          ''                   (makes objects/ a directory)
  /repo/.git/worktrees/wt/HEAD           'ref: refs/heads/wt\n'
  /repo/.git/worktrees/wt/commondir      '../..\n'
  /repo/.git/worktrees/wt/gitdir         '/repo/wt/.git\n'
  /repo/wt/.git                          'gitdir: /repo/.git/worktrees/wt\n'
  ```

  Then `openRepository({ cwd: '/repo/wt', files })` and assert
  `ctx.layout.gitDir === '/repo/.git/worktrees/wt'` and
  `ctx.layout.commonDir === '/repo/.git'`. Companion cases: a plain `/repo` seed
  still yields `{ workDir: '/repo', gitDir: '/repo/.git' }` with **no** `commonDir`;
  an empty FS still yields the hardcoded fallback; a
  `gitdir: /outside/admin\n` pointer throws `NOT_A_REPOSITORY` with
  `data.path === '/repo/wt'`.

  (Placed under `test/unit/` because `src/index.default.ts` is outside the coverage
  include list and has no integration home; it is a real behavioural test of the
  shim, not test infra.)

- **Extend** `test/parity/scenarios/worktree.scenario.ts` — after
  `repo.worktree.add({ path: 'wt' })`, add fields that prove the common-dir routing
  is adapter-independent. The scenario compares `run()`'s return against a **static**
  `expected` golden via `toEqual`, so do **not** put an oid in the golden: derive the
  relation inside `run()` and put a boolean in `expected`. E.g. capture the seed
  commit oid from `repo.commit()` and return
  `{ …, headsResolveToSeed: list.entries.every((e) => e.head === seedOid) }` with
  `expected.headsResolveToSeed: true`. Absolute paths stay excluded (adapter-specific).
  The scenario type is `Scenario<T>` from `test/parity/scenarios/types.ts`; the
  scenario is already registered in `test/parity/scenarios/index.ts` — no registration
  change needed. The **browser** driver (`test/browser/parity.spec.ts`, via
  `test/browser/parity-scenarios.bundle.ts`) asserts the same golden, so anything
  added must hold there too. Run `npm run check:parity-fixtures` after touching it.

**5. Final surface gates for the whole feature** (run all of these in this part):

- `npm run docs:json && git diff --exit-code -- reports/api.json` — should be clean if
  Part 3 regenerated correctly; if it moved, commit the update here.
- `npm run check:test-pyramid` — the tier ratio settles after the last test file
  lands. Edit `test-pyramid-budgets.json` only if it warns or fails.
- `npm run check:write-surfaces` — the interop file's `interopSurface: worktree`
  claim.
- `npm run check:dead-code` (knip) — `LayoutProbe`, `fileSystemLayoutProbe`,
  `layoutRootsOf`, `layoutFromGitfile` and both parsers must all be reachable.
- `npm run check:architecture` (depcruise) — no new upward edge; `src/repository/`'s
  import of `adapters/node/path-policy.js` follows the existing precedent.
- `npm run check:spelling` — the cspell dictionary has gaps on some British `-ising`
  forms; a full `validate` catches what the commit hook may not.
- `npm run validate` as the phase gate.

**Trap — deps + lockfile.** Do **not** run bare `npm install` in this worktree: it
replaces the symlinked `node_modules` and leaves main stale. If a dependency bump is
needed, use `npx npm@10 install --package-lock-only` (a macOS full regen drops the
linux native binaries and reds CI's clean `npm ci`).

**Trap — `check:size` false alarm.** A full-library size failure can come from stale
hashed chunks in the wireit cache. `rm -rf dist .wireit && npm run build` before
believing it.

### TDD steps

1. **RED** `test/unit/repository/memory-shim-discovery.test.ts` — the four cases
   above. The worktree case fails today because the memory shim hardcodes
   `/repo` + `/repo/.git`.
2. **GREEN** wire `findLayout(fileSystemLayoutProbe(fs), cwd, posixPolicy)` into
   `src/index.default.ts` with the hardcoded fallback preserved.
3. **RED → GREEN** browser shim: make `src/index.browser.ts` probe its fixed
   `/{gitDirName}` entry and, on a file, resolve via `layoutFromGitfile`. Prove it
   through `npm run check:types` plus the existing browser parity spec; do not
   duplicate the pointer grammar.
4. **RED → GREEN** extend `test/parity/scenarios/worktree.scenario.ts` with the
   structured head/flag assertions; update `expected`; run
   `npx vitest run test/parity` (node + memory drivers) so both agree on the golden.
5. **REFACTOR** re-read the three shims side by side: each must call exactly one
   shared discovery entry point (`findLayout` or `layoutFromGitfile`) — zero
   duplicated grammar or path algebra (R9).
6. Run the full gate battery listed above, then `npm run validate`.

### Gate

```
npx vitest run test/unit/repository/memory-shim-discovery.test.ts test/parity && npm run check:types && ./node_modules/.bin/biome check src/index.default.ts src/index.browser.ts test/unit/repository/memory-shim-discovery.test.ts test/parity/scenarios/worktree.scenario.ts
```

### Commit

```
feat(worktree): resolve gitdir pointers in the memory and browser shims
```
