# Plan — `.gitmodules` symlink aliases behind a backslash

> Source: design doc `docs/design/gitmodules-backslash-alias.md` · ADRs 1003, 1004, 1005
> The plan is the implementation script AND the knowledge handoff. Part agents start
> with zero context: whatever a part block omits is paid later as agent rediscovery.

## Overview

Two parts, each one atomic `fix` commit, sharing one working tree:

| Part | Delivers | Faithfulness rows it flips |
|---|---|---|
| 1 | `.gitmodules` symlink check ported to git's whole-path NTFS scan + exact dotfile + HFS; unit, property and interop pins | classes A, B, C of the design matrix |
| 2 | `.git` alias scan skips the part after a component-leading `\` | the six ADR-1004 over-refusals |

Parts 3-7 (git for Windows' backslash refusal, ADR-1006) follow in the "Addendum" section
after Part 2's self-review.

Both parts edit `src/domain/path/verify-path.ts` and its unit test on purpose: they fix two
disjoint arms (`.gitmodules` symlink check vs `.git` alias scan) under two ADRs (1003 vs
1004), touch no shared function, and each commit reverts on its own.

**Public surface: none.** Every new symbol is module-private to
`src/domain/path/verify-path.ts` (no `export`). `verifyPath`'s signature, the
`VerifyPathRejection` union, error codes and reason strings are unchanged. No barrel,
facade, `exhaustiveness.ts`, `reports/api.json`, doc-coverage or README gate is
touched. No new rejection reason: every new refusal is the existing
`'gitmodules-not-regular'`, which `validateIndexPath` maps to
`INVALID_INDEX_ENTRY` with reason `'.gitmodules' must not be a symlink`.

### Shared facts (both parts)

- git verdicts below were pinned on git 2.55.0 (scrubbed `GIT_*`, `GIT_CONFIG_NOSYSTEM=1`,
  temp `HOME`, darwin defaults), 3/3 runs identical. The design's matrix plus three rows
  pinned while planning: `x/gitmod~1` refused, `xy.gitmodules` admitted,
  `xy/gitmod~1/z` admitted (all at `120000`).
- The proposed Part 1 algorithm was traced in a scratch script against all 55 rows of the
  matrix below (refused and admitted lists): 55/55 match git.
- Probes run on the base commit (`785fadfc` code), used to shape the interop file:
  - `repo.add` refuses **every** path holding `\` with `PATHSPEC_OUTSIDE_REPO`, through a
    literal pathspec and through the `.` walk (the walk's `validateWalkedEntryPath` and the
    pathspec's `validateWorkingTreePath` in src/domain/working-tree-path.ts reject any
    `\`). git on POSIX stages those paths. The add arm therefore cannot compare backslash
    rows (see decision candidate D7).
  - `repo.reset({ mode: 'mixed', rev })`, `repo.checkout({ rev })` and
    `repo.primitives.readIndex()` all reach `verifyPath` for backslash names: base code
    admits `x\gitmod~1` and `gi7eb~12` on all three, git refuses them at `reset`
    (exit 128).
  - Regular-mode `\.git`, `\git~1`, `\.git:s`: `git reset -q <c>` exit 0, git `ls-files`
    exit 0 on an index holding them; base tsgit refuses on `reset`, `checkout` and
    `readIndex` (`INVALID_INDEX_ENTRY`). `\\.git`, `x\.git`: git reset exit 128, tsgit
    refuses. 3/3 identical.
- On Windows, git treats `\` as a directory separator (`is_dir_sep`), so the pinned
  matrix is POSIX git's. The whole interop file skips on `win32`.
- Commit/test hygiene: no ADR, phase or backlog numbers inside source or test code (that
  includes the interop divergence comment: describe it in words). No suppression
  directives. The existing `// Stryker disable next-line …: equivalent — …` comments are
  pre-approved in-file precedent; do not add new ones (every mutant below has a killer).
- Size caps run with under 100 B headroom. Part 1 deletes two regexes and imports a module
  src/domain/objects/tree.ts already bundles. Run `rm -rf dist .wireit && npm run build && npm run check:size`
  once at the end of each part as a GUARD. If red, escalate with the failing row; do not
  trim unrelated code.

### Pinned matrix (git 2.55, symlink `120000`)

TypeScript literals, ready to paste (`ZWNJ` = `String.fromCodePoint(0x200c)`, already a
constant in the unit test file):

```ts
const GIT_REFUSES = [
  // baseline, already refused today
  '.gitmodules', '.GITMODULES', 'gitmod~1', 'gitmod~1 ', 'GI7EBA~1', 'x\\/gitmod~1', 'x/gitmod~1',
  '.gitmodules/y', '.GITMODULES/y', '.gitmodules:s/y', 'gitmod~1:s/y', `.gitmod${ZWNJ}ules/y`,
  // class A: alias right after a mid-component backslash
  'x\\.gitmodules', 'x\\.GITMODULES', 'x\\gitmod~1', 'x\\GITMOD~1', 'x\\gitmod~4', 'x\\gi7eba~1',
  'x\\.gitmodules.', 'x\\.gitmodules ', 'x\\.gitmodules. .', 'x\\gitmod~1.', 'x\\gitmod~1 ',
  'x\\gitmod~1 . ', 'x\\.gitmodules:s', 'x\\gitmod~1:s', 'x\\.gitmodules:s\\y',
  'a\\b\\.gitmodules', 'y/x\\gitmod~1', 'x\\\\gitmod~1', '\\\\gitmod~1', 'x:\\gitmod~1',
  'x\\g~123456',
  // class C: generic 8.3 fall-back short name
  'gi7eb~12', 'g~123456', '~1234567',
] as const;

const GIT_ADMITS = [
  '.gitmodules\\y', 'x\\.gitmodules\\y', 'x\\gitmod~1\\y', 'x\\.gitmodules/y', 'x\\gitmod~1/y',
  'x\\gitmod~5', `x\\.gitmod${ZWNJ}ules`, 'gi7eba~10', 'gi7eb~1', 'x\\', 'xy.gitmodules',
  // a backslash that opens its component is never tested
  '\\gitmod~1', 'x/\\gitmod~1', '\\.gitmodules',
  // class B: alias followed by '/'
  'gitmod~1/y', 'gi7eba~1/y', '.gitmodules./y', 'gitmod~1./y', 'xy/gitmod~1/z',
] as const;
```

At `100644` git admits every path in both lists.

## Decision candidates

- **D7 — The interop `add` arm and backslash rows.** Base tsgit's `add` refuses any path
  holding `\` with `PATHSPEC_OUTSIDE_REPO` before `verifyPath` runs (probe above). git on
  POSIX stages them. The design's Arm 1 assumed `add` reaches `verifyPath` for every row.
  (a) run the `add` arm only on the backslash-free rows. Backslash rows are pinned through
  `reset`, `checkout` and parsed index, which do reach `verifyPath`.
  (b) run `add` on every row and assert `PATHSPEC_OUTSIDE_REPO` for backslash rows. That
  pins a divergence no ADR records, and the project rule requires an ADR for a divergence.
  (c) lift the working-tree backslash rejection in this branch: out of the 32.25 brief, it
  touches every pathspec caller and needs its own pin.
  **Recommend (a):** it keeps the brief's scope, every backslash row is still pinned on two
  write surfaces plus the read surface, and it asserts no unratified divergence. Part 1 is
  written against (a). If (b) or (c) is chosen, only Part 1's add-arm row filter changes.

## Part 1 — `.gitmodules` symlink check follows git's whole-path NTFS scan

### Context

Files this part edits or creates (all others are read-only):

- `src/domain/path/verify-path.ts`
- `test/unit/domain/path/verify-path.test.ts`
- `test/unit/domain/path/verify-path.properties.test.ts`
- `test/unit/domain/path/arbitraries.ts`
- `test/integration/gitmodules-symlink-alias-interop.test.ts` (new)

**Current code to change** (src/domain/path/verify-path.ts, line numbers at the plan
commit):

- `:1-3` imports: `splitAtSlash` from ../git-index/index-path-key.js;
  `decodePreservingBom, wellFormedSequenceLength` from ../objects/encoding.js;
  `FILE_MODE, type FileMode` from ../objects/file-mode.js. Add `encode` to the
  encoding import, and add an import of matchesNtfsDotgitAlias from ../objects/tree-entry-bytes.js. That module has zero imports (no cycle). Domain to
  domain is allowed by .dependency-cruiser.cjs. It is not barrel-exported, so it stays
  internal.
- `:101-107` `hfsAlias(part, partBytes, target)`: logic unchanged. Its `:103`
  `Stryker disable … ConditionalExpression` justification says "both callers'
  `normalizeAliasCandidate` check already caught" the exact match. After this part the
  .gitmodules caller's exact check is the dotfile comparison. Reword to: "the .git
  caller's `normalizeAliasCandidate` check and the .gitmodules caller's exact-name check
  already caught it". The equivalence still holds because the dotfile check runs before
  `hfsAlias` (short-circuit `||`).
- `:134-138` constants: `ASCII_BACKSLASH = 0x5c` exists. Add `ASCII_SLASH = 0x2f`.
- `:227-237` comment + `GITMOD_NTFS_SHORT_NAME` (`/^gitmod~[1-4]$/`) +
  `GITMOD_NTFS_HASHED_SHORT_NAME` (`/^gi7eba~[1-9]$/`): delete. The comment's
  `gi7eba~<digit>` claim is wrong: the fall-back grammar is generic.
- `:239-256` `matchGitmodulesAliasPart(component, componentBytes?)`: delete. Its doc
  comment falsely claims `validateIndexPath` rejects `\`. path-validator.ts `:63-68`
  states the opposite.
- `:258-272` `hasGitmodulesSymlinkComponent(components, mode, bytes?)` and its CVE
  comment: replace.
- `:280-293` `verifyPath(path: string, mode: FileMode, pathBytes?: Uint8Array):
  VerifyPathRejection | undefined`: signature unchanged, body changes.
- `splitAtStream`, `normalizeAliasCandidate`, `TRAILING_DOT_SPACE`, `GITMODULES` stay:
  the .git arm still uses the first three, and the new dotfile/HFS checks use
  `GITMODULES`.

**Reused matcher** (src/domain/objects/tree-entry-bytes.ts, read-only):
`matchesNtfsDotgitAlias(buf: Uint8Array, start: number, end: number, alias:
DotgitAliasName): boolean` at `:213`. It is a byte port of git's `is_ntfs_dot_generic`:
case-insensitive .gitmodules, `gitmod~[1-4]`, or the fall-back
(`foldsToNtfsFallbackShortName`, `:154`: up to six chars of `gi7eba`, `~`, digit 1-9,
digits to eight chars), then `isNtfsTail` (`:119`: only `.`/` ` up to the end or a `:`;
for `gitmodules`, `/` and `\` FAIL the tail). With `end = bytes.length` it tests "the rest
of the whole path", which is git's scope. Do not use `backslashSegmentStarts` from the
same file: it is fsck's rule and includes a component-leading `\`.

**Target shape** (git's `verify_path_internal` runs the NTFS test at offset 0, after
every `/`, and after every `\` it reads mid-component. A component's first byte is
consumed in the `inside:` block and never tested as a separator):

```ts
const opensComponent = (bytes: Uint8Array, at: number): boolean =>
  at === 0 || bytes[at - 1] === ASCII_SLASH;

const isNtfsRetestPoint = (bytes: Uint8Array, at: number): boolean =>
  bytes[at] === ASCII_SLASH || (bytes[at] === ASCII_BACKSLASH && !opensComponent(bytes, at));

const startsNtfsGitmodulesAlias = (bytes: Uint8Array, start: number): boolean =>
  matchesNtfsDotgitAlias(bytes, start, bytes.length, 'gitmodules');

const hasNtfsGitmodulesAlias = (bytes: Uint8Array): boolean =>
  startsNtfsGitmodulesAlias(bytes, 0) ||
  bytes.some((_, at) => isNtfsRetestPoint(bytes, at) && startsNtfsGitmodulesAlias(bytes, at + 1));

// verify_dotfile: exact .gitmodules per '/' component, ASCII case-fold only.
const namesGitmodulesComponent = (component: string, componentBytes?: Uint8Array): boolean =>
  component.toLowerCase() === GITMODULES || hfsAlias(component, componentBytes, GITMODULES);

const hasGitmodulesSymlinkAlias = (
  pathBytes: Uint8Array,
  components: readonly string[],
  bytes?: readonly Uint8Array[],
): boolean =>
  hasNtfsGitmodulesAlias(pathBytes) ||
  components.some((component, index) => namesGitmodulesComponent(component, bytes?.[index]));

// verifyPath tail, after findComponentRejection:
if (mode !== FILE_MODE.SYMLINK) return undefined;
return hasGitmodulesSymlinkAlias(pathBytes ?? encode(path), components, bytes)
  ? 'gitmodules-not-regular'
  : undefined;
```

- `Uint8Array.prototype.some` replaces an index loop on purpose: it leaves no `<`/`<=`
  bound mutant to defend.
- `encode(path)` runs only on the symlink branch, so the regular-file hot path does not
  allocate.
- Encoding is exact for this arm: the grammar is pure ASCII, and a non-ASCII code unit
  encodes to bytes `>= 0x80` that match no grammar byte.
- `component.toLowerCase()` is exact for .gitmodules: no non-ASCII code unit
  lowercases into one of its letters (Kelvin sign → `k` is not among them, and `İ`
  lowercases to two code units).
- Keep each function under 20 lines, nesting ≤ 2, named constants only.

**Tests to extend:**

- test/unit/domain/path/verify-path.test.ts:
  - Matrix `describe('verifyPath')` > `describe("Given a name from git's pinned
    verify_path matrix")` > `it.each([...])` (`:25-602`). Its .gitmodules rows
    (`:312-480`) all stay valid; do not edit them.
  - Add a new sibling block after `:602`, inside `describe('verifyPath')`:
    `describe("Given a symlink path from git's pinned .gitmodules alias matrix")` with
    three tables over `GIT_REFUSES` / `GIT_ADMITS` (paste the literals above as file-level
    constants): `When verified at 120000` → refused: `'gitmodules-not-regular'`;
    `When verified at 120000` → admitted: `undefined`; `When verified at 100644` (both
    lists) → `undefined`. Use `it.each(GIT_REFUSES)('Then %j is refused …')`, AAA comments,
    and `sut` only if you wrap the call (existing tables call `verifyPath` directly; follow
    the file).
  - Raw-bytes section `describe('verifyPath on raw path bytes')` (`:720`, helpers
    `rawPath(...)` and `viewOf(bytes)`): add `Given a symlink path whose alias follows a
    mid-component backslash` > `When verified with the raw bytes` > `Then x\gitmod~1 is
    gitmodules-not-regular`, built with `rawPath('x\\gitmod~1')`. It covers the
    `pathBytes` side of `??`. The string tables cover `encode`.
- test/unit/domain/path/verify-path.properties.test.ts: header comment lists the lenses
  (Lens 2 "partially fits isDotGitAlias"). Constants `COMPOSITION_NUM_RUNS = 100`.
  Imports `arbComponentPair`, `arbIgnorableCodepoint`, `arbSafeAsciiPath`,
  `arbStringWithIgnorableCodepoint` from ./arbitraries.js.
- test/unit/domain/path/arbitraries.ts: `arbPathComponent()` (1-12 lowercase ASCII
  letters, never a .git/.gitmodules alias), `arbSafeAsciiPath()` (0-6 such components
  joined by `/`, may be `''`). Add here: `arbNtfsGitmodulesAlias()` and
  `arbNtfsGitmodulesShortName()` (spec in TDD step 3).

**Interop harness idiom** (copy from test/integration/git-parity-containment-interop.test.ts,
read-only):

- `@proves` JSDoc header (`:1-20`, keys `surface`, `bucket: cross-tool-interop`,
  `unique`, `interopSurface`).
- Imports `GIT_AVAILABLE`, `git`, `runGit`, `runGitEnv`, `tryRunGitWithExit`,
  `disableAutoMaintenance` from ./interop-helpers.js, and `openRepository` from
  ../../src/index.node.js.
- `COMMIT_ENV` (`:64-72`), `mkRoot` (`:77-78`), `initPeerDir` (`:80-86`, sets
  `core.symlinks=true`), `writeBlobText` (`:126-127`).
- Raw `git mktree` via stdin (`writeTree`, `:159-160`). Plain `mktree` accepts names
  holding `\`, `:` and .gitmodules (probed), so `--literally` is not needed.
- Fixtures are built in `beforeAll(…, SETUP_TIMEOUT)` into a `Map`, `afterAll` disposes
  repos and removes the root. `it.each` rows then assert on the recorded verdicts.
- Wrap the file in `describe.skipIf(!GIT_AVAILABLE || process.platform === 'win32')`
  (precedent: test/integration/filter-clean-smudge-interop.test.ts `:1377`). State the
  reason in a comment: git on Windows reads `\` as a directory separator.
- Give every git call `-c core.protectHFS=true`: git defaults it on only on macOS, and the
  ZWNJ rows need it on Linux CI. `core.protectNTFS` defaults on everywhere.
- Read git's index with `ls-files -z` split on `\0`. Plain `ls-files` C-quotes `\` and
  non-ASCII paths.
- tsgit side: `repo.reset({ mode: 'mixed', rev })`, `repo.checkout({ rev })`,
  `repo.primitives.readIndex()` (returns `GitIndex`, `.entries[].path`), `repo.add([path])`.
  Read the error code as `(err as { data?: { code?: string } }).data?.code`. Expected code
  for every tsgit refusal: `INVALID_INDEX_ENTRY`.

**Interop arms** (rows = `GIT_REFUSES` and `GIT_ADMITS`, each tagged `{ path, gitRefuses }`):

1. **tree → index (`reset`)**, all rows. Per row, in both a git peer and a tsgit repo
   (each seeded with one commit holding seed.txt):
   - build the nested tree for `path` bottom-up with `mktree` (leaf
     `120000 blob <oid>\t<leaf>`, each parent `040000 tree <oid>\t<dir>`), then
     `commit-tree`;
   - git: `reset -q <c>`, exit 128 when refused, 0 when admitted;
   - tsgit: `reset` mixed to the same commit;
   - assert refusal parity with the pinned `gitRefuses`, and that both indexes still list
     only seed.txt on refusal. Between rows, reset both back to the seed commit.
2. **`checkout`**, all rows, a fresh repo pair per row:
   - git: `checkout -q <c>`, exit 1 and HEAD unchanged when refused;
   - tsgit: `checkout` throws `INVALID_INDEX_ENTRY` and HEAD is unchanged (`git(dir,
     'rev-parse', 'HEAD')`);
   - admitted rows: both succeed and `ls-files -z` lists `path`.
3. **`add` of an on-disk symlink**, backslash-free rows only (D7(a)), a fresh repo pair
   per row because APFS folds .gitmodules/`.GITMODULES`:
   - `mkdirSync(dirname, { recursive: true })`, then `symlinkSync('target', leaf)`;
   - git: `add -- <path>`, non-zero exit and absent from `ls-files -z` when refused;
   - tsgit: `repo.add([path])` throws `INVALID_INDEX_ENTRY`, absent from `readIndex`.
4. **parsed index**, all rows:
   - git writes the entry with `-c core.protectNTFS=false -c core.protectHFS=false
     update-index --add --index-info` (stdin `120000 <blob>\t<path>\n`);
   - git `ls-files -z` exits 0 and lists `path` for every row;
   - tsgit `readIndex` throws `INVALID_INDEX_ENTRY` with reason
     `'.gitmodules' must not be a symlink` for refused rows, and reads fine for admitted
     rows.
   - Comment, in words: tsgit validates entries at index read while git does not; this
     row pins that known divergence.

### TDD steps

1. **RED** — verify-path.test.ts, new `.gitmodules` alias matrix block (refused table,
   admitted table, 100644 table). Fails: base code admits the class A rows (no `\` split
   in the gitmodules arm), class C rows (`/^gi7eba~[1-9]$/` is narrower than the fall-back
   grammar) and `x\g~123456`, and refuses class B rows (per-component strip ignores what
   follows `/`). Baseline rows and the 100644 table already pass, inside the same tables.
2. **RED** — verify-path.test.ts raw-bytes row `x\gitmod~1` at `120000` with bytes. Fails:
   base code returns `undefined`.
3. **RED** — arbitraries.ts plus two properties in verify-path.properties.test.ts
   (Lens 2, compositional matcher, `numRuns: COMPOSITION_NUM_RUNS`):
   - `arbNtfsGitmodulesAlias()`: one of `.gitmodules`, `gitmod~[1-4]`, or the fall-back.
     The fall-back is `k ∈ 0..6` leading chars of `gi7eba`, `~`, a digit 1-9, then
     `6 - k` digits 0-9 (exactly eight chars). Each letter gets random ASCII case. Append
     a tail of 0-3 chars from `.`/` ` and an optional `:` plus `arbPathComponent()`.
   - `arbNtfsGitmodulesShortName()`: `gitmod~[1-4]` or the fall-back, random case, with
     the dot/space tail, no stream.
   - Property A: `Given an arbitrary plain component and an arbitrary NTFS .gitmodules
     alias` > `When joined with a backslash and verified as a symlink` > `Then it is
     gitmodules-not-regular`. Oracle: `verifyPath(\`${prefix}\\${alias}\`,
     FILE_MODE.SYMLINK) === 'gitmodules-not-regular'` with `prefix` from
     `arbPathComponent()`. The prefix is never empty, so the backslash never opens the
     component, and plain letters trip no earlier rejection.
   - Property B: `Given an arbitrary NTFS .gitmodules short name and a non-empty safe
     suffix path` > `When the short name is a directory of a symlink` > `Then it is
     accepted`. Oracle: `verifyPath(\`${alias}/${suffix}\`, FILE_MODE.SYMLINK) ===
     undefined`, with `fc.pre(suffix !== '')`.
   - Update the file header: Lens 2 now also covers the `.gitmodules` composition.
   - Fails: A because base code admits `x\gitmod~1`; B because base code refuses
     `gitmod~1/y`.
4. **RED** — test/integration/gitmodules-symlink-alias-interop.test.ts, four arms as in
   Context. Run with git 2.55 on `PATH`. Fails:
   - reset/checkout: class A and C rows (tsgit admits, git refuses);
   - reset/checkout/add: class B rows (tsgit refuses, git admits);
   - add: class C rows (tsgit admits);
   - parsed index: class A and C refused rows (tsgit reads them fine).
   Baseline rows pass.
5. **GREEN** — rewrite the gitmodules arm of verify-path.ts to the target shape. Delete
   both `GITMOD_*` regexes and `matchGitmodulesAliasPart`. Replace
   `hasGitmodulesSymlinkComponent` with `hasGitmodulesSymlinkAlias`. Move the mode gate
   into `verifyPath` as an early return. Steps 1-4 go green.
6. **GUARD** — existing callers' suites, unchanged behaviour for their rows (all use leaf
   `.gitmodules` or regular-mode `gitmod~1`):
   `npx vitest run test/unit/domain/git-index test/unit/application/primitives/build-index-from-tree.test.ts test/unit/application/primitives/apply-changeset.test.ts test/unit/application/primitives/internal/validate-merge-write-paths.test.ts test/unit/domain/objects/tree-entry-bytes.test.ts`.
   The `.gitmodules\xff` and `U+FFFE`-tail raw-bytes rows keep passing through `hfsAlias`.
7. **REFACTOR** — comments state why, never what:
   - one doc comment above the new block: git re-tests the rest of the whole path at
     each component start and after each mid-component `\`; the `.gitmodules` alias must
     be followed only by dots/spaces to the end or a `:`, so `/` ends a match and a
     component-leading `\` is consumed untested;
   - drop every claim that `validateIndexPath` rejects `\`;
   - reword the `hfsAlias` justification (Context);
   - keep the CVE-2018-11235 rationale on the new function;
   - then run the size GUARD from Shared facts.

**Mutation targets** (Stryker on src/domain/path/verify-path.ts, killers from the tables
above):

| Mutant | Killer |
|---|---|
| `opensComponent`: `at === 0` → `false` | `\gitmod~1` admitted |
| `opensComponent`: `bytes[at - 1] === ASCII_SLASH` → `false`; `at - 1` → `at + 1` | `x/\gitmod~1` admitted |
| `isNtfsRetestPoint`: `bytes[at] === ASCII_SLASH` → `false` | `x/gitmod~1` refused (only the after-`/` test catches it) |
| `isNtfsRetestPoint`: `bytes[at] === ASCII_BACKSLASH` → `true` | `xy.gitmodules` admitted (a retest at `y` would match) |
| `isNtfsRetestPoint`: `!opensComponent` → `opensComponent`; backslash arm → `false` | `x\gitmod~1` refused |
| `\|\|` → `&&` inside `isNtfsRetestPoint` | `x\gitmod~1` refused |
| `hasNtfsGitmodulesAlias`: start `0` path → `false`; `\|\|` → `&&` | `gitmod~1` refused |
| `.some` callback `&&` → `\|\|` | `x\` admitted (any separator would refuse) |
| `at + 1` → `at - 1` | `x\gitmod~1` refused |
| `bytes.some` → `bytes.every` | `x\gitmod~1` refused |
| `startsNtfsGitmodulesAlias` alias literal `'gitmodules'` → `""` | `gitmod~1` refused |
| `namesGitmodulesComponent`: `toLowerCase` → `toUpperCase`; `\|\|` → `&&` | `.gitmodules/y` refused (NTFS fails on `/y`; only the dotfile check catches it) |
| `namesGitmodulesComponent`: `===` → `!==` | `gitmod~1/y` admitted (every non-`.gitmodules` component would refuse) |
| `components.some` → `.every`; `bytes?.[index]` → `bytes[index]` | `a/.gitmodules/foo` refused; any string-only symlink row (TypeError) |
| `hasGitmodulesSymlinkAlias` outer `\|\|` → `&&` | `x\gitmod~1` refused (NTFS only) |
| `mode !== FILE_MODE.SYMLINK` → `false` / `true` / `===` | 100644 table (`.gitmodules` admitted); any refused 120000 row |
| `pathBytes ?? encode(path)` → `&&` | any string-only symlink row (`undefined` reaches `.some`, TypeError) |

### Gate

```bash
PATH=$HOME/.local/git-2.55.0/bin:$PATH npx vitest run test/unit/domain/path/verify-path.test.ts test/unit/domain/path/verify-path.properties.test.ts test/integration/gitmodules-symlink-alias-interop.test.ts && npm run check:types && ./node_modules/.bin/biome check src/domain/path/verify-path.ts test/unit/domain/path/verify-path.test.ts test/unit/domain/path/verify-path.properties.test.ts test/unit/domain/path/arbitraries.ts test/integration/gitmodules-symlink-alias-interop.test.ts && npm run check:spelling
```

### Commit

`fix(verify-path): refuse .gitmodules symlink aliases behind a backslash like git`

## Part 2 — `.git` alias scan skips a component-leading backslash

### Context

Files this part edits (all others are read-only):

- `src/domain/path/verify-path.ts`
- `test/unit/domain/path/verify-path.test.ts`
- `test/integration/gitmodules-symlink-alias-interop.test.ts` (created by Part 1)

**Current code to change** (locate by symbol; Part 1 shifted line numbers):

- `matchAliasComponent(component: string, componentBytes?: Uint8Array):
  VerifyPathRejection | undefined`: its loop `for (const part of component.split('\\'))`
  runs `matchNtfsPart(part)` on every part. That includes the part after a backslash
  that opens the component, which git consumes untested. Pinned (git 2.55, `100644`,
  3/3): `\.git`, `\git~1`, `x/\.git`, `\.git\y`, `x/\.git/y`, `\.git:s` admitted;
  `\\.git`, `x\.git` refused (`dotgit-alias`). Base tsgit refuses all eight with
  `dotgit-alias`, `dotgit-ntfs-alias` or `dotgit-ntfs-stream`.
- The comment above it ("git runs the NTFS scan per backslash part …"): add that a
  backslash opening the component opens no part.
- Target:

  ```ts
  // git consumes a component's first byte untested, so a backslash there opens no part
  // of its own; the leading empty part it leaves can never match an alias either.
  const ntfsParts = (component: string): readonly string[] => {
    const parts = component.split('\\');
    return component.startsWith('\\') ? parts.slice(2) : parts;
  };
  ```

  Use `for (const part of ntfsParts(component))` in `matchAliasComponent`. Why this is
  exact: for `\.git` the split is `['', '.git']`. git tests `\.git` at the component
  start (no match, same as `''`) and skips .git. For `\\.git` the split is
  `['', '', '.git']`; `.slice(2)` keeps .git, which git tests after the second `\`.
  `is_ntfs_dotgit` stops at `/`, `\` and `:`, so per-part testing equals git's
  whole-path test for this arm (the .gitmodules arm differs, handled in Part 1).
- The HFS arm is unchanged: `hfsAlias(component, componentBytes, DOTGIT)` on the whole
  component, as git does.
- `isObviouslyNotAnAlias`: unchanged. A component holding `\` already returns `false`
  (`code === ASCII_BACKSLASH`), so no backslash component takes the fast path. The
  `Stryker disable … ConditionalExpression` justification on the fast-path call still
  holds (it admits only backslash-free components), so leave it.
- `isDotGitAlias(component)` shares `matchAliasComponent`, so it now admits `\.git`. Its
  only caller, src/domain/working-tree-path.ts, rejects any input holding `\` in
  `rejectInputShape` (`:69`) before `rejectComponent` calls `isDotGitAlias`, so nothing
  changes there. Add no tests through `isDotGitAlias` or working-tree-path for this:
  `verifyPath` rows reach every new branch. The existing `isDotGitAlias` rows (`abc\.git`
  true) and the property `arbComponentPair` (left part never empty, never starts with `\`)
  stay green.
- **Property sibling: none added.** The inputs are the closed .git alias family
  (.git, `git~1`, stream and dot/space variants) times a leading-backslash count. That
  is the "small enum, use a parameterised example sweep" case in
  .claude/workflow/property-testing.md. An oracle would re-implement `ntfsParts`.
- **Interop extension:** in the Part 1 file, add one `describe` for regular-mode entries
  whose component opens with `\`. Reuse Part 1's tree builder and reset-arm fixture
  helpers (extract them to file-level helpers if Part 1 inlined them).
  - **reset arm:** rows `\.git`, `\git~1`, `x/\.git`, `\.git\y`, `x/\.git/y`, `\.git:s`
    (git admits) and `\\.git`, `x\.git` (git refuses), mode `100644`. Assert refusal
    parity as in Part 1.
  - **parsed-index arm, admitted rows only:** git `update-index --add --index-info`
    (`100644 <blob>\t<path>`, default config), git `ls-files -z` lists it, tsgit
    `readIndex` reads it.
  - Update the file's `@proves` `unique` line to cover both alias arms.

### TDD steps

1. **RED** — verify-path.test.ts: new block `describe("Given a regular path whose component
   opens with a backslash, from git's pinned verify_path matrix")` > `When verified at
   100644`:
   - `\.git`, `\git~1`, `x/\.git`, `\.git\y`, `x/\.git/y`, `\.git:s` → `undefined`;
   - `\\.git`, `x\.git` → `'dotgit-alias'`.
   Fails: base code returns `dotgit-alias` / `dotgit-ntfs-alias` / `dotgit-ntfs-stream`
   for the six admitted rows. The two refused rows already pass in the same table.
2. **RED** — interop `describe` for the same rows (reset arm plus parsed-index admitted
   rows). Fails: tsgit `reset` and `readIndex` throw `INVALID_INDEX_ENTRY` where git
   exits 0.
3. **GREEN** — add `ntfsParts` and use it in `matchAliasComponent`. Steps 1-2 go green.
4. **GUARD** — `npx vitest run test/unit/domain/working-tree-path.test.ts test/unit/domain/path/verify-path.properties.test.ts test/unit/domain/git-index`.
   They pass because working-tree-path rejects `\` before the alias check, and no existing
   row has a component-leading `\`.
5. **REFACTOR** — comments only (Context); size GUARD from Shared facts.

**Mutation targets:**

| Mutant | Killer |
|---|---|
| `component.startsWith('\\')` → `true` | `.git` refused (matrix row `:100`; `['.git'].slice(2)` is empty) |
| → `false`; `.slice(2)` removed | `\.git` admitted |
| `startsWith` → `endsWith` | `\.git` admitted (`endsWith` is false, so `.git` gets tested) |
| `'\\'` → `""` in `startsWith` | `.git` refused (`startsWith('')` is always true) |
| `split('\\')` literal → `""` | existing `a\.git\b` / `.git\config` refused rows |

### Gate

```bash
PATH=$HOME/.local/git-2.55.0/bin:$PATH npx vitest run test/unit/domain/path/verify-path.test.ts test/integration/gitmodules-symlink-alias-interop.test.ts && npm run check:types && ./node_modules/.bin/biome check src/domain/path/verify-path.ts test/unit/domain/path/verify-path.test.ts test/integration/gitmodules-symlink-alias-interop.test.ts && npm run check:spelling
```

### Commit

`fix(verify-path): admit a .git alias behind a component-leading backslash like git`

## Self-review (3 passes, converged)

- **Pass 1 (contradictions):**
  - The design's add arm assumed `repo.add` reaches `verifyPath` for every row. A probe
    disproved it (`PATHSPEC_OUTSIDE_REPO` for any `\`), which led to D7.
  - The design's mutation note credited `y/x\gitmod~1` with the `/` disjunct. That row
    only exercises the `\` disjunct. Added `x/gitmod~1` (pinned refused) as the real
    killer.
- **Pass 2 (unstated assumptions):**
  - A loop `at < bytes.length` leaves an equivalent `<=` mutant, so the plan uses
    `Uint8Array.some`.
  - `ntfsParts` avoids a destructuring default, which would be an equivalent
    StringLiteral mutant.
  - The `isNtfsRetestPoint` `=== ASCII_BACKSLASH → true` mutant needed a two-letter-lead
    row: `xy.gitmodules`, pinned admitted.
  - The interop file needs `protectHFS=true` for the ZWNJ rows on Linux.
  - The interop file skips on win32: git's `is_dir_sep` includes `\` there.
  - The parsed-index divergence comment must not cite the ADR number (hygiene rule).
- **Pass 3 (edge behaviour):**
  - Re-traced the 55 matrix rows through the target shape in a scratch script against the
    real `matchesNtfsDotgitAlias`: 55/55.
  - Checked that `.gitmodules\xff` / `U+FFFE`-tail raw rows still refuse through
    `hfsAlias`.
  - Checked that Part 2 leaves `arbComponentPair` and `isObviouslyNotAnAlias` behaviour
    intact.
  - Confirmed with the D6 probe that the `\\.git` / `x\.git` refusals keep their
    `dotgit-alias` reason.

## Addendum — git for Windows' backslash refusal (Parts 3–7)

> Source: design doc `docs/design/gitmodules-backslash-alias.md`, section "Addendum — git
> for Windows' backslash refusal" (binding) · ADR-1006 (WD1–WD5 all chosen as recommended).

### Why five parts, not two

The addendum touches 21 files (2 domain modules, 1 new selector, 8 application modules,
their unit tests, 1 interop file). The part schema caps a part at 6 created/edited files,
so the work is cut along the call-site map, one boundary family per part. Every part is
one atomic `fix` commit and leaves `npm run check:types` green on its own. The win-only
interop file is not a standalone part (it has no implementation to stand alone from): it
is created in Part 4 with the `reset` arm, whose code Part 4 changes, and Part 6 adds the
`checkout` arm, whose code Part 6 changes.

| Part | Delivers | Sites (file:line at the plan commit) |
|---|---|---|
| 3 | domain: `verifyWindowsPath`, `backslash` reason, `posixIndexPathRules` / `windowsIndexPathRules` | verify-path.ts:277, path-validator.ts:38,97,113 |
| 4 | `indexPathRulesOf(ctx)`; `reset` / `read-tree` boundary; win-only interop (reset + parsed index) | build-index-from-tree.ts:118 |
| 5 | `add`, `mv`, `stash` restore | add.ts:836,1270; mv.ts:343; stash.ts:671 |
| 6 | checkout boundary (+ the `Stryker disable` removal), submodule work dir; interop checkout arm | apply-changeset.ts:317-319; submodule-context.ts:74 |
| 7 | merge whole-set gate | validate-merge-write-paths.ts:27,34,48,51,54,55; merge.ts:1288,1661,1879,1957; apply-merge-to-worktree.ts:454 |

Part 3 edits `verify-path.ts` and its two test files again after Parts 1-2 on purpose:
a separate ADR (1006) and a separate rule (a wrapper beside `verifyPath`), touching no
function Parts 1-2 changed; each commit reverts on its own.

Order is load-bearing: Part 3 before every other (it creates the rules values), Part 4
before 5–7 (it creates `indexPathRulesOf`), Part 4 before 6 (Part 6 extends the interop
file Part 4 creates). Parts 5, 6 and 7 touch disjoint files.

### Shared facts (Parts 3–7)

- **Public surface: none.** Every new symbol is internal:
  - `verifyWindowsPath` (src/domain/path/verify-path.ts), `IndexPathRules`,
    `posixIndexPathRules`, `windowsIndexPathRules` (src/domain/git-index/path-validator.ts)
    and `indexPathRulesOf` (new src/application/primitives/internal/index-path-rules.ts)
    are not re-exported from any barrel (verified: no `verify-path` / `path-validator`
    entry in src/domain/index.ts or src/domain/git-index/index.ts; `internal/` is never
    barrelled). No error code, no union member of a public type, no facade method, no
    command, no doc-coverage surface.
  - `VerifyPathRejection` gains `'backslash'`. It is internal (not in the API report). Its
    only total consumer is `VERIFY_PATH_REASON` in path-validator.ts, which the compiler
    forces. The property file's `VERIFY_PATH_REJECTIONS` set is a hand list for
    `verifyPath`, which never returns `'backslash'`: leave it unchanged (adding it would
    loosen that totality property).
  - Public signatures unchanged: `applyChangeset`, `buildIndexFromTree` derive the rules
    from the `ctx` they already take. Do **not** edit the JSDoc of either public export:
    typedoc embeds it, and an edit makes the API report stale (a prepush gate). If a part
    does change a public JSDoc anyway, it runs `npm run docs:json` and commits the
    regenerated API report in the same commit. Expected: no regeneration in any part.
- **knip** (`check:dead-code`, validate only): it runs the vitest plugin, so exports used
  only by tests count as used. After Part 3, `windowsIndexPathRules` is used only by tests
  until Part 4 lands; this is fine for knip.
- **Size**: the Full library row has about 97 B of headroom and these parts add an
  estimated 150–300 B gzip. **No part edits the size-limit config or runs `check:size` as
  a gate**: the session raises the failing rows in its own `chore(size)` commit after
  Part 7. A red `check:size` inside a part is expected and is not a blocker.
- **Windows context in unit tests**: `{ ...ctx, windowsPathSyntax: true }` over the memory
  adapter (precedent test/unit/application/primitives/object-store.test.ts:949-951). The
  memory fs treats `\` as a plain byte, so any refusal in such a test comes from the rules
  alone. Nothing else in the memory-adapter code paths below reads `windowsPathSyntax`
  (its other readers, via `gitPathSyntaxOf`, are object-store alternates,
  prune-worktrees, misspelt-revision, the node adapter and `openRepository`).
- **Reason string** (exact, asserted everywhere): `'backslash rejected under Windows path syntax'`.
  Every unit test asserts `.data` in full with try/catch (`{ code: 'INVALID_INDEX_ENTRY',
  offset: -1, reason }` where the offset is `NO_PARSER_OFFSET`), never `toThrow(Class)`.
- **Local name**: call the selected value `pathRules`, never `indexRules`: add.ts already
  has an unrelated `indexRules` (`StagingScope.indexRules`, add.ts:173).
- **Call shape**: `const pathRules = indexPathRulesOf(ctx);` then
  `pathRules.validateIndexPath(...)`. Where a helper has no `ctx`, it takes
  `pathRules: IndexPathRules` as its **first** parameter (the `ctx`-first convention).
- **Why no Stryker mutant guards the threading**: replacing `indexPathRulesOf(ctx)` by
  `posixIndexPathRules` is an identifier swap, which Stryker does not generate. The
  per-site Windows twin test is the only proof that the Windows value reaches each call.
  Every threaded site therefore gets one twin (Windows refuses with the reason, nothing
  written) and one posix control (the same path is admitted).
- **win-only interop on darwin**: the file cannot run here (posix git admits what git for
  Windows refuses). Its gates prove it typechecks (`npm run check:types` covers
  `test/**`), lints (`biome check <file>`, which also fails when the file is missing) and
  collects (`npx vitest list --project win-integration <file>` imports it and registers
  every `it`; it exits 0 on a missing file, which is why the biome step names the file).
  The session runs the PR's CI `win-integration` job (`.github/workflows/ci.yml:433`,
  `npm run test:win-integration`, `windows-latest`) and reads the per-row output, not only
  the job status, before integrate. If a row disagrees with the design's matrix, the
  design reopens before merge.
- Hygiene: no ADR, phase or backlog numbers in source or test; no suppression directives
  (the pre-existing `Stryker disable` comments stay, except the one Part 6 removes); no new
  ones.

### Merge-gate coverage (WD3 (a) confirmed)

Every post-gate re-check and removal runs only after a `validateMergeWritePaths` call that
receives the same outcome set, a superset of the conflicts, and the same `changed` set. Part
7 gives that gate the Windows rules, so the re-checks may stay posix.

| Re-check / removal | Only reached through | Preceding gate (same sets) |
|---|---|---|
| merge.ts:1832 `removeChangedOutcome`, :1834 `removeDisplacedFile`, :1863 `outcomeWave.validate`, :1879 `conflictWave.validate`, :1927 `writeOutcomeToTree`, :1957 `writeConflictToTree` | `writeConflictingWorkingTree` (merge.ts:1806); `writeOutcomeToTree` / `writeConflictToTree` have no other src caller than merge.ts:1865 / :1881 | merge.ts:1293 follows merge.ts:1288 in `persistOctopusConflict` (`outcomes`, `changed` identical; `marked` ⊆ `result.conflicts`); merge.ts:1695 (`writeConflictState`, sole caller merge.ts:1639) follows merge.ts:1638 `refuseUnwritableConflicts` → gate merge.ts:1661 (`result.outcomes`, `result.conflicts`, `changed` identical) |
| apply-merge-to-worktree.ts:224 `removeChangedOutcome` (via :309), :251 `removeDisplacedFile` (via :310) | `writeConflictWorktree` (apply-merge-to-worktree.ts:291), sole caller :455 in `materialiseConflict` | apply-merge-to-worktree.ts:454 (`merged.outcomes`, `merged.conflicts`, `changed` identical) |

The removed paths are a subset of what the gate checks: `touched`/`deleted` filter
`status !== 'conflict' && changed.has(path)`, exactly the gate's outcome loop
(validate-merge-write-paths.ts:32-37, `resolved-deleted` checked with the `REGULAR`
stand-in), and `removeDisplacedFile` checks `conflict.path`, which
`validateConflictWritePaths` checks first (:51 or :54). No site escapes; no decision
candidate arises from WD3.

### Decision candidates (addendum)

None. WD1–WD5 are decided (ADR-1006). The WD3 coverage check above holds for every site.
The split into five parts and the interop `checkout` arm (Part 6) are planning choices
inside WD5 (a), not new decisions: the `checkout` arm pins the write that actually
places `.git\hooks\post-checkout` on disk, which the `reset --mixed` arm cannot observe.

## Part 3 — domain: windows index path rules refuse every backslash

### Context

Files this part edits (all others are read-only):

- `src/domain/path/verify-path.ts`
- `src/domain/git-index/path-validator.ts`
- `test/unit/domain/path/verify-path.test.ts`
- `test/unit/domain/path/verify-path.properties.test.ts`
- `test/unit/domain/git-index/path-validator.test.ts`

**Current code** (line numbers at the plan commit):

- verify-path.ts `:6-15` `export type VerifyPathRejection = 'absolute-path' | … |
  'gitmodules-not-regular'`. Append `| 'backslash'`.
- verify-path.ts `:271-291` `verifyPath(path: string, mode: FileMode, pathBytes?:
  Uint8Array): VerifyPathRejection | undefined`. Unchanged. Add after it:

  ```ts
  const BACKSLASH = '\\';

  /** git for Windows' `verify_path`: `\` is a directory separator there, and every one is refused. */
  export const verifyWindowsPath = (
    path: string,
    mode: FileMode,
    pathBytes?: Uint8Array,
  ): VerifyPathRejection | undefined =>
    path.includes(BACKSLASH) ? 'backslash' : verifyPath(path, mode, pathBytes);
  ```

  The `\` test runs first on purpose (WD4): `../a\b` reports `backslash`. A string test is
  exact for a byte path: `\` is ASCII, a lossy view keeps it, and `U+FFFD` never equals it.
  The file already has `ASCII_BACKSLASH = 0x5c` (a byte constant); keep the new string
  constant separate.
- path-validator.ts:
  - `:13` imports `{ type VerifyPathRejection, verifyPath }`; add `verifyWindowsPath`.
  - `:34-48` comment + `VERIFY_PATH_REASON: Record<VerifyPathRejection, string>`. Add
    `backslash: 'backslash rejected under Windows path syntax'` (the compiler forces it).
    Reword the comment: `verifyPath` and `verifyWindowsPath` own every shape.
  - `:50-71` `unsafeReason` doc: its "Everything else — backslash, … is deliberately NOT
    rejected here" stays true for the NUL helper; add one sentence: the posix rules admit
    a backslash, the windows rules refuse it, as git for Windows does.
  - `:73-111` doc + `export const validateIndexPath = (path, offset, mode, pathBytes?):
    void` and `:113-116` `export const validateTreePath = (path: FilePath, mode: FileMode):
    void`. Both bodies move into a factory, verifier injected:

  ```ts
  type PathVerifier = typeof verifyPath;

  /** The index-write path check, under one platform's path syntax. */
  export interface IndexPathRules {
    readonly validateIndexPath: (path: string, offset: number, mode: FileMode, pathBytes?: Uint8Array) => void;
    readonly validateTreePath: (path: FilePath, mode: FileMode) => void;
  }

  const indexPathRulesFor = (verify: PathVerifier): IndexPathRules => {
    const validateIndexPath = (path: string, offset: number, mode: FileMode, pathBytes?: Uint8Array): void => {
      const reason = unsafeReason(path);
      if (reason !== undefined) throw invalidIndexEntry(offset, reason);
      const rejection = verify(path, mode, pathBytes);
      if (rejection !== undefined) throw invalidIndexEntry(offset, VERIFY_PATH_REASON[rejection]);
    };
    const validateTreePath = (path: FilePath, mode: FileMode): void => {
      const { path: view, pathBytes } = indexPathOfEscaped(path);
      validateIndexPath(view, NO_PARSER_OFFSET, mode, pathBytes);
    };
    return { validateIndexPath, validateTreePath };
  };

  /** git's rules on POSIX: parse, write-tree and archive use them on every platform. */
  export const posixIndexPathRules = indexPathRulesFor(verifyPath);
  /** git for Windows' rules: index writes under Windows path syntax. */
  export const windowsIndexPathRules = indexPathRulesFor(verifyWindowsPath);
  export const { validateIndexPath, validateTreePath } = posixIndexPathRules;
  ```

  Keep the existing long JSDoc (rejection list, "reason does not echo the path") above
  the factory's `validateIndexPath`; add `backslash (windows rules only)` to its list.
  `validateIndexPath` / `validateTreePath` keep their names and posix meaning, so the
  three posix callers (src/domain/git-index/index-parser.ts:128,
  src/application/primitives/synthesize-tree-from-index.ts:90,
  src/application/commands/archive.ts:164) and every application caller still compile
  unchanged in this part.
- biome will wrap the long signature lines; let `biome check --write` format.

**Tests to extend:**

- verify-path.test.ts: `describe('verifyPath')` at `:91`, the Part 1/2 blocks at
  `:669`, `:708`, raw bytes `describe('verifyPath on raw path bytes')` at `:854`. Add a
  new top-level `describe('verifyWindowsPath')` after the `verifyPath` block (before
  `describe('isDotGitAlias')` at `:738`), with one `it.each` table that asserts both
  verdicts per row (the posix one documents why the windows rule is needed):

  | path (TS literal) | mode | `verifyPath` | `verifyWindowsPath` |
  |---|---|---|---|
  | `'\\.git\\hooks\\post-checkout'` | REGULAR | `undefined` | `'backslash'` |
  | `'\\.git\\config'` | REGULAR | `undefined` | `'backslash'` |
  | `'x/\\.git\\hooks\\y'` | REGULAR | `undefined` | `'backslash'` |
  | `'x\\y'` | REGULAR | `undefined` | `'backslash'` |
  | `'a\\b\\c'` | REGULAR | `undefined` | `'backslash'` |
  | `'\\gitmod~1'` | SYMLINK | `undefined` | `'backslash'` |
  | `'\\.gitmodules'` | SYMLINK | `undefined` | `'backslash'` |
  | `'x/\\gitmod~1'` | SYMLINK | `undefined` | `'backslash'` |
  | `'x\\gitmod~1'` | SYMLINK | `'gitmodules-not-regular'` | `'backslash'` |
  | `'../a\\b'` | REGULAR | `'dotdot-segment'` | `'backslash'` |
  | `'a/b'` | REGULAR | `undefined` | `undefined` |
  | `'gitmod~1/y'` | SYMLINK | `undefined` | `undefined` |
  | `'.git/x'` | REGULAR | `'dotgit-alias'` | `'dotgit-alias'` |

  Titles: `describe('Given a path from the git for Windows matrix')` >
  `describe('When verified under each path syntax')` > `it.each(ROWS)('Then $path is
  $posix under POSIX and $windows under Windows', …)`; AAA comments, `const sut =
  verifyWindowsPath`.
- verify-path.properties.test.ts (constants `TOTAL_FUNCTION_NUM_RUNS`,
  `COMPOSITION_NUM_RUNS = 100`; `arbFileMode()` at `:61`). Add two properties, Lens 2
  (composition), and one line in the header comment listing them:
  - `Given an arbitrary path holding a backslash and any file mode` > `When verified under
    the Windows rules` > `Then it is backslash`. Arbitrary:
    `fc.tuple(fc.string(), fc.string()).map(([head, tail]) => \`${head}\\${tail}\`)`.
  - `Given an arbitrary path without a backslash and any file mode` > `When verified under
    the Windows rules` > `Then it agrees with verifyPath`. Arbitrary:
    `fc.oneof(fc.string(), arbStringWithIgnorableCodepoint()).filter((path) => !path.includes('\\'))`.
- path-validator.test.ts (helper `catchError` `:12-19`; imports `:3-10`). Import
  `posixIndexPathRules`, `windowsIndexPathRules`. Add `describe('windowsIndexPathRules')`:
  - `validateIndexPath('x\\y', 7, FILE_MODE.REGULAR)` → `{ code: 'INVALID_INDEX_ENTRY',
    offset: 7, reason: 'backslash rejected under Windows path syntax' }` (offset passes
    through);
  - `validateTreePath('\\.git\\config' as FilePath, FILE_MODE.REGULAR)` → same reason,
    `offset: NO_PARSER_OFFSET`;
  - NUL still wins: `validateIndexPath('a\\\0b', 0, REGULAR)` → reason `'NUL byte
    rejected'`;
  - raw bytes reach the verifier: the `.git\xff/x` row of `describe('validateIndexPath
    with raw path bytes')` (`:230-252`) under `windowsIndexPathRules.validateIndexPath`
    → the HFS reason, as posix;
  - `describe('posixIndexPathRules')`: `validateIndexPath('x\\y', 0, REGULAR)` and
    `validateTreePath('\\.git\\config' as FilePath, REGULAR)` do not throw; and
    `validateIndexPath` / `validateTreePath` (the named exports) are
    `posixIndexPathRules`'s members (`toBe`).

### TDD steps

1. **RED** — verify-path.test.ts `verifyWindowsPath` table. Fails: `verifyWindowsPath` is
   not exported yet, so the imported binding is `undefined` and every row throws
   `TypeError: sut is not a function` instead of returning a verdict.
2. **GREEN** — add `'backslash'` to the union, `BACKSLASH`, `verifyWindowsPath`; add the
   `backslash` entry to `VERIFY_PATH_REASON` (check:types forces it). Step 1 green.
3. **GUARD** — the two properties in verify-path.properties.test.ts. They pass once step 2
   exists (written after it; they pin the composition, not new behaviour).
4. **RED** — path-validator.test.ts `windowsIndexPathRules` / `posixIndexPathRules` blocks.
   Fails: neither value is exported yet, so each row throws a `TypeError` reading
   `validateIndexPath` of `undefined` instead of the asserted error data.
5. **GREEN** — `IndexPathRules`, `indexPathRulesFor`, the two values, and the
   destructured `validateIndexPath` / `validateTreePath` exports. Step 4 green.
6. **GUARD** — every existing caller suite, unchanged verdicts (posix rules):
   `npx vitest run test/unit/domain test/unit/application/primitives/build-index-from-tree.test.ts test/unit/application/primitives/apply-changeset.test.ts test/unit/application/primitives/synthesize-tree-from-index.test.ts test/unit/application/primitives/internal/validate-merge-write-paths.test.ts`.
7. **REFACTOR** — comments state why (path-validator header sentence,
   `VERIFY_PATH_REASON` comment, JSDoc list); functions under 20 lines.

**Mutation targets** (Stryker on verify-path.ts and path-validator.ts):

| Mutant | Killer |
|---|---|
| `path.includes(BACKSLASH) ? … : …` → `true` | `a/b` row (`undefined` expected) |
| → `false` | `x\y` row (`'backslash'` expected) |
| `BACKSLASH` `'\\'` → `""` | `a/b` row (`includes('')` is always true) |
| `'backslash'` → `""` | every refused row asserts the literal |
| `verifyPath(path, mode, pathBytes)` arm dropped by a ternary mutant | `.git/x` → `'dotgit-alias'`, `x\gitmod~1` posix column |
| `VERIFY_PATH_REASON.backslash` string → `""` | path-validator `x\y` row asserts the full reason |
| factory: `reason !== undefined` / `rejection !== undefined` (existing mutants, now inside `indexPathRulesFor`) | existing path-validator.test.ts rows, unchanged |
| `windowsIndexPathRules` built from `verifyPath` (not a Stryker mutant; a hand error) | `windowsIndexPathRules` `x\y` row |

### Gate

```bash
PATH=$HOME/.local/git-2.55.0/bin:$PATH npx vitest run test/unit/domain/path/verify-path.test.ts test/unit/domain/path/verify-path.properties.test.ts test/unit/domain/git-index/path-validator.test.ts test/unit/domain/git-index && npm run check:types && ./node_modules/.bin/biome check src/domain/path/verify-path.ts src/domain/git-index/path-validator.ts test/unit/domain/path/verify-path.test.ts test/unit/domain/path/verify-path.properties.test.ts test/unit/domain/git-index/path-validator.test.ts && npm run check:spelling
```

### Commit

`fix(path-validator): add windows index path rules that refuse every backslash`

## Part 4 — reset refuses a backslash path under Windows path syntax

### Context

Files this part creates or edits (all others are read-only):

- `src/application/primitives/internal/index-path-rules.ts` (new)
- `test/unit/application/primitives/internal/index-path-rules.test.ts` (new)
- `src/application/primitives/build-index-from-tree.ts`
- `test/unit/application/primitives/build-index-from-tree.test.ts`
- `test/integration/win-only/backslash-path-windows-interop.test.ts` (new)

**New selector** (mirrors `gitPathSyntaxOf`,
src/application/primitives/internal/git-path-syntax.ts:97-99):

```ts
import {
  type IndexPathRules,
  posixIndexPathRules,
  windowsIndexPathRules,
} from '../../../domain/git-index/path-validator.js';

/** The index path rules of the git build a host emulates: git for Windows' when it says so, POSIX otherwise. */
export const indexPathRulesOf = (host: { readonly windowsPathSyntax?: boolean }): IndexPathRules =>
  host.windowsPathSyntax === true ? windowsIndexPathRules : posixIndexPathRules;
```

The flag comes from `Context.windowsPathSyntax` (src/ports/context.ts:358), set by the node
runtime on Windows (src/index.node.ts:171) and dropped by `openRepository` when the caller
supplies its own fs (src/repository.ts:588-599, `hostHooksFor`), where `\` is a plain byte.

Its test mirrors test/unit/application/primitives/internal/git-path-syntax.test.ts:178-203
(`describe.each` of hosts, `const sut = indexPathRulesOf`): `{ windowsPathSyntax: true }`
→ `toBe(windowsIndexPathRules)`; `{ windowsPathSyntax: false }` and `{}` →
`toBe(posixIndexPathRules)`.

**Site** (build-index-from-tree.ts, line numbers at the plan commit):

- `:32` imports `NO_PARSER_OFFSET, validateIndexPath`; drop `validateIndexPath`, import
  `IndexPathRules` (type) from the domain and `indexPathRulesOf` from
  ./internal/index-path-rules.js.
- `:113-125` `const projectLeaf = (leaf: TargetLeaf, donors, sparse): IndexEntry` with
  `validateIndexPath(leaf.path, NO_PARSER_OFFSET, leaf.mode, leaf.pathBytes)` at `:118`.
  New first parameter `pathRules: IndexPathRules`; call `pathRules.validateIndexPath(…)`
  with the same arguments.
- `:127-136` `export const buildIndexFromTree = async (ctx: Context, opts:
  BuildIndexFromTreeOpts): Promise<ReadonlyArray<IndexEntry>>` (public, signature and
  JSDoc unchanged): `const pathRules = indexPathRulesOf(ctx);` before the `map`, then
  `leaves.map((leaf) => projectLeaf(pathRules, leaf, donors, opts.sparse))`.
- Callers that inherit the rule with no edit: `reset --mixed`
  (src/application/commands/reset.ts:138 `rebuildIndexFromCommit`) and stash
  (src/application/commands/stash.ts:709).

**Unit tests** (build-index-from-tree.test.ts: fixtures `buildSeededContext` from
./fixtures.js, local `writeBlob(ctx, text)` `:26`, `EMPTY_INDEX` `:19`, `writeTree`,
`treeEntry`; refusal idiom at `:761-790`, the `.gitmodules` symlink block): add
`describe('Given a tree leaf named \\.git\\hooks\\post-checkout')` with two `When`s:

- `When buildIndexFromTree runs under Windows path syntax` → caught `.data` equals
  `{ code: 'INVALID_INDEX_ENTRY', offset: -1, reason: 'backslash rejected under Windows path syntax' }`.
  Context `{ ...ctx, windowsPathSyntax: true }`.
- `When buildIndexFromTree runs under POSIX path syntax` → resolves to one entry whose
  `path` is the leaf name (posix control; git on POSIX admits it).

**Interop file** (new; runs only in the `win-integration` vitest project:
vitest.config.ts:75-76 includes test/integration/win-only/**/*.test.ts, the default
projects exclude it at :58). Idiom to mirror:

- win-only header style: test/integration/win-only/openrepository-windows-paths.test.ts
  `:1-22` (the folder dictates the platform: **no `skipIf`**, not even on
  `GIT_AVAILABLE`; this file is the only empirical pin of git for Windows, so it must
  fail, not skip, when git is absent).
- interop idiom: test/integration/gitmodules-symlink-alias-interop.test.ts — `@proves`
  header (`:11-15`), `COMMIT_ENV` (`:51-59`), `gitIn` / `gitOut` (`:153-164`, but **drop
  the `-c core.protectHFS=true`** prefix: it is irrelevant here), `listIndex` (`:167-170`,
  `ls-files -z`), `errorCodeOf` / `errorReasonOf` / `captureError` (`:172-184`),
  `buildLeafCommit` (`:189-199`, `mktree` bottom-up, splits on a slash only, so a `\` name is
  one leaf), `seedCommit` / `buildSeededPair` (`:211-235`), the shared-pair `beforeAll` +
  `rewindShared` `afterEach` (`:243-262`). Copy what you use (test files never import each
  other). `initPeerDir` without `core.symlinks` (no symlink is materialised: reset is
  index-only). Imports from ../interop-helpers.js: `disableAutoMaintenance`, `runGit`,
  `runGitEnv`, `tryRunGitWithExit`; `openRepository` from ../../../src/index.node.js.
- `@proves`: `surface: repo.reset`, `bucket: cross-tool-interop`, `unique: a backslash
  index path is refused on Windows as git for Windows refuses it, and an index already
  holding one still reads`, `interopSurface: reset, update-index, ls-files`. File doc: git
  for Windows reads `\` as a directory separator and its `verify_path` refuses every one
  (with `core.protectNTFS`, the default); tsgit applies that rule under Windows path syntax,
  which the node runtime sets on Windows.
- Rows (file-level constants; TS literals):

  ```ts
  const REFUSED_ROWS = [
    { path: '\\.git\\hooks\\post-checkout', mode: REGULAR_MODE },
    { path: '\\.git\\config', mode: REGULAR_MODE },
    { path: 'x\\y', mode: REGULAR_MODE },
    { path: '\\gitmod~1', mode: SYMLINK_MODE },
  ] as const;
  const ADMITTED_ROWS = [{ path: 'a/b', mode: REGULAR_MODE }] as const;
  ```

- **reset arm** (`describe('Given a tree holding a backslash path')` > `When the tree is
  loaded into the index with reset`), shared pair, rewound after each row:
  - git: `gitIn(peerDir, ['reset', '-q', peerCommit])`, expected exit `128` (refused rows)
    / `0` (admitted);
  - tsgit: `repo.reset({ mode: 'mixed', rev: oursCommit })`; refused rows: code
    `INVALID_INDEX_ENTRY` and reason `'backslash rejected under Windows path syntax'`;
    admitted: no error;
  - both: `listIndex(oursDir)` equals `listIndex(peerDir)`, which is `['seed.txt']` on
    refusal and `[path]` when admitted;
  - both: `existsSync(path.join(dir, '.git', 'hooks', 'post-checkout'))` is `false`.
- **parsed-index arm** (`describe('Given an index git wrote with x\\y staged')` > `When
  tsgit reads it`), fresh pair:
  - write the entry with `gitOut(oursDir, ['-c', 'core.protectNTFS=false', 'update-index',
    '--add', '--index-info'], \`100644 ${blob}\tx\\y\n\`)` (with the switch off, git for
    Windows admits a mid-component `\`);
  - `listIndex(oursDir)` contains `x\y` (git reads it);
  - `(await repo.primitives.readIndex()).entries.map((e) => e.path)` contains `x\y`
    (tsgit's parse keeps the posix rules, as git's `read_index_from` verifies nothing).
- Timeouts: `SETUP_TIMEOUT = 60_000`, `ROW_TIMEOUT = 60_000` (Windows git is slow);
  `afterAll` disposes the repos and `rm`s the root.

### TDD steps

1. **RED** — index-path-rules.test.ts. Fails: the module does not exist, so the file
   errors at import resolution and no row runs.
2. **GREEN** — create index-path-rules.ts. Step 1 green.
3. **RED** — build-index-from-tree.test.ts Windows row. Fails: `buildIndexFromTree` uses
   the posix `validateIndexPath`, which admits `\.git\hooks\post-checkout` (since Part 2),
   so it resolves with one entry instead of throwing.
4. **RED (CI only)** — the interop file. On `windows-latest` the refused rows fail
   against step 3's code: tsgit `reset` admits the four backslash rows (posix rules)
   where git for Windows exits 128. Locally it only collects (Gate). The parsed-index row
   and the `a/b` row pass from the start (GUARD rows inside the same file).
5. **GREEN** — thread `pathRules` through `projectLeaf` / `buildIndexFromTree`. Step 3
   green (step 4 goes green on CI).
6. **GUARD** — `npx vitest run test/unit/application/commands/reset.test.ts test/unit/application/commands/stash.test.ts`
   (posix contexts, verdicts unchanged).
7. **REFACTOR** — doc comment on `indexPathRulesOf` says why (which git build it
   emulates); no other comment changes.

**Mutation targets** (Stryker on index-path-rules.ts and build-index-from-tree.ts):

| Mutant | Killer |
|---|---|
| `host.windowsPathSyntax === true ? … : …` → `true` | `{ windowsPathSyntax: false }` row → posix |
| → `false` | `{ windowsPathSyntax: true }` row → windows |
| `=== true` → `!== true` | `true` row |
| `true` literal → `false` | `false` row (`=== false` picks windows) |
| build-index-from-tree.ts | no new mutable operator (identifier threading); the Windows twin is the proof |

### Gate

```bash
PATH=$HOME/.local/git-2.55.0/bin:$PATH npx vitest run test/unit/application/primitives/internal/index-path-rules.test.ts test/unit/application/primitives/build-index-from-tree.test.ts test/unit/application/commands/reset.test.ts && npx vitest list --project win-integration test/integration/win-only/backslash-path-windows-interop.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/primitives/internal/index-path-rules.ts test/unit/application/primitives/internal/index-path-rules.test.ts src/application/primitives/build-index-from-tree.ts test/unit/application/primitives/build-index-from-tree.test.ts test/integration/win-only/backslash-path-windows-interop.test.ts && npm run check:spelling
```

The `vitest list` step must print the interop file's `it` titles (read them): that proves
it collects. Its rows run only on CI's `win-integration` job; the session reads that job's
row output before integrate (Shared facts).

### Commit

`fix(reset): refuse a backslash path under windows path syntax like git for windows`

## Part 5 — add, mv and stash restore refuse a backslash path under Windows path syntax

### Context

Files this part edits (all others are read-only):

- `src/application/commands/add.ts`
- `test/unit/application/commands/add.test.ts`
- `src/application/commands/mv.ts`
- `test/unit/application/commands/mv.test.ts`
- `src/application/commands/stash.ts`
- `test/unit/application/commands/stash.test.ts`

**Sites** (line numbers at the plan commit; no earlier part edits these files):

- add.ts `:30` imports `NO_PARSER_OFFSET, validateIndexPath`; drop `validateIndexPath`,
  import `indexPathRulesOf` from ../primitives/internal/index-path-rules.js.
  - `:819-839` `renormalizeOne({ ctx, scope, ensurePromisorConfigValid }, previous)`:
    `:836` `validateIndexPath(path, NO_PARSER_OFFSET, mode)` →
    `indexPathRulesOf(ctx).validateIndexPath(path, NO_PARSER_OFFSET, mode)`. Reached by
    `add --renormalize` for every stage-0 index entry the pathspec matches
    (`renormalizeEntries` `:793`, `addRenormalized` `:737`), index-driven: an index entry
    `x\y` reaches it (git's `add --renormalize` re-adds through `add_index_entry`, which
    runs `verify_path`).
  - `:1249-1272` `stageFromStat(ctx, path, kind, …)`: `:1270` same change. **No twin
    test**: every path reaching it passed `validateWorkingTreePath` /
    `validateWalkedEntryPath` (src/domain/working-tree-path.ts:69 rejects any `\` with
    `PATHSPEC_OUTSIDE_REPO`), so a `\` never arrives here; the existing posix tests cover
    the line. Threading it keeps the index-write boundary uniform with git's
    `add_index_entry`.
- mv.ts `:35` same import change.
  - `:336-348` `const applyToIndex = (byPath, planned): void` with `:343`
    `validateIndexPath(moved.path, NO_PARSER_OFFSET, moved.mode)`. New first parameter
    `pathRules: IndexPathRules` (type from src/domain/git-index/path-validator.ts);
    `pathRules.validateIndexPath(…)`.
  - Caller `:137` inside `mv` (has `ctx`): `applyToIndex(indexPathRulesOf(ctx), byPath,
    planned)`. It runs before `renameInWorkingTree` (`:138-140`) and `lock.commit`, so a
    refusal leaves index and worktree untouched. A `\` reaches it through a tracked
    directory member: sources and destination pass `validatePath` (rejects `\`), members
    come from the index (`repath`, `:352`).
- stash.ts `:22` imports `validateTreePath`; replace with `indexPathRulesOf`.
  - `:664-683` `restoreUntracked(ctx, uTree)`: the pre-pass `:670-672` `for (const [path,
    entry] of flat.entries) validateTreePath(path, entry.mode)` →
    `const pathRules = indexPathRulesOf(ctx);` before the loop,
    `pathRules.validateTreePath(path, entry.mode)` inside (git: `read-tree` + `checkout-index`
    of the untracked tree, builtin/stash.c).

**Tests** (each: Windows twin asserting the full reason and nothing written, plus a posix
control admitting the same path; Windows context `{ ...ctx, windowsPathSyntax: true }`):

- add.test.ts — renormalize section `:3167-3480`: helpers `seedFreshRepo(workingTree)`
  (`:53`, raw worktree writes, no `add`), `indexCrlfEntries(ctx, [{ path }])` (`:3181`,
  writes an index whose entries stat the on-disk file), `idsByPath(ctx)` (`:3202`),
  `RENORMALIZE`. Do **not** use `seedCommittedCrlf` (it runs `add`, which refuses `\`).
  New `describe('Given an index entry x\\y on disk')`:
  - `When add renormalize "." runs under Windows path syntax` → `.data` `{ code:
    'INVALID_INDEX_ENTRY', offset: -1, reason: 'backslash rejected under Windows path
    syntax' }`; `idsByPath` before equals after.
  - `When add renormalize "." runs under POSIX path syntax` → resolves; `x\y` still in
    `idsByPath`.
- mv.test.ts — `describe('mv re-validating the moved path')` `:903-924` (helpers
  `seedRows(workingTree, rows)` `:816`, raw writes + hand index; `indexView(ctx)` `:843`;
  `captureError` `:846`; `exists(ctx, path)` `:24`). Add `describe('Given a tracked
  directory d holding x\\y')`, seeded `seedRows({ 'd/x\\y': 'y' }, [{ path: 'd/x\\y' }])`:
  - `When mv d e runs under Windows path syntax` → `.data` matches code + reason;
    `indexView` unchanged; `d/x\y` still exists, `e` does not.
  - `When mv d e runs under POSIX path syntax` → resolves; `indexView` lists `e/x\y`.
- stash.test.ts — `describe('Given an include-untracked stash whose untracked tree carries
  a hostile entry name')` `:884-956` (helpers `setupRepo()` `:74`,
  `pushHostileUntrackedStash(ctx, tree)` `:90`, `writeObject`, `treeEntry`). Add a sibling
  `describe('Given an include-untracked stash whose untracked tree holds x\\y')`, tree
  `[treeEntry(FILE_MODE.REGULAR, 'x\\y', blob)]`:
  - `When apply runs under Windows path syntax` → `.data` `{ code, offset: -1, reason }`
    with the backslash reason; `${workDir}/x\y` absent.
  - `When apply runs under POSIX path syntax` → resolves; `${workDir}/x\y` holds the blob
    text.

### TDD steps

1. **RED** — add.test.ts Windows twin. Fails: `renormalizeOne` uses the posix
   `validateIndexPath`, so `add` resolves and re-stages `x\y`. (The posix control passes
   from the start: GUARD.)
2. **GREEN** — add.ts both sites. Step 1 green.
3. **RED** — mv.test.ts Windows twin. Fails: `applyToIndex` admits `e/x\y`, so `mv`
   resolves and moves it. (Posix control: GUARD.)
4. **GREEN** — mv.ts `applyToIndex(pathRules, …)` and its caller. Step 3 green.
5. **RED** — stash.test.ts Windows twin. Fails: the pre-pass admits `x\y`, so apply
   resolves and writes it. (Posix control: GUARD.)
6. **GREEN** — stash.ts `restoreUntracked`. Step 5 green.
7. **REFACTOR** — none expected beyond import tidying (biome `noUnusedImports`).

**Mutation targets:** no new mutable operator in any of the three files (the change is
an identifier threaded into an existing call). Existing mutants keep their killers. The
twins are the only proof that the Windows value reaches each site (Shared facts).

### Gate

```bash
PATH=$HOME/.local/git-2.55.0/bin:$PATH npx vitest run test/unit/application/commands/add.test.ts test/unit/application/commands/mv.test.ts test/unit/application/commands/stash.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/commands/add.ts test/unit/application/commands/add.test.ts src/application/commands/mv.ts test/unit/application/commands/mv.test.ts src/application/commands/stash.ts test/unit/application/commands/stash.test.ts && npm run check:spelling
```

### Commit

`fix(add): refuse a backslash path in add, mv and stash under windows path syntax`

## Part 6 — checkout and submodule work dirs refuse a backslash path under Windows path syntax

### Context

Files this part edits (all others are read-only):

- `src/application/primitives/apply-changeset.ts`
- `test/unit/application/primitives/apply-changeset.test.ts`
- `src/application/primitives/internal/submodule-context.ts`
- `test/unit/application/primitives/internal/submodule-context.test.ts`
- `test/integration/win-only/backslash-path-windows-interop.test.ts` (created by Part 4)

**Sites** (line numbers at the plan commit; no earlier part edits these two src files):

- apply-changeset.ts `:30` imports `NO_PARSER_OFFSET, validateIndexPath`; drop
  `validateIndexPath`, import `IndexPathRules` (type) and `indexPathRulesOf`.
  - `:310-320` comment + `const validateChangesetEntry = (entry: ChangesetEntry): void`:

    ```ts
    // Stryker disable next-line ConditionalExpression: equivalent — computeChangeset sources a `delete`/`noop` entry's `path` AND `mode` unchanged from the current index … can never newly throw.
    if (entry.kind !== 'add' && entry.kind !== 'update') return;
    validateIndexPath(entry.path, NO_PARSER_OFFSET, entry.mode, entry.pathBytes);
    ```

    **Delete the `Stryker disable` line (`:317`)**: its equivalence argument ("the parse
    already ran this same check") is false once the write rules differ from the parse
    rules. Under the windows rules a `delete` of a parsed `x\y` would newly throw if the
    guard were mutated away, so the mutant is killable and gets a kill test. New first
    parameter `pathRules: IndexPathRules`; `pathRules.validateIndexPath(…)`.
    Reword the comment above (`:310-315`): `add`/`update` paths come from a target-tree
    walk and are checked before any write; `delete`/`noop` are skipped because git does not
    verify a path it removes or leaves in place (unpack-trees verifies only entries it
    adds).
  - `:322-324` `validateChangesetPaths(changeset)` → `(pathRules, changeset)`, passing
    it on.
  - `:808-815` `applyChangesetInScope(ctx, opts, direction)`: `:815`
    `validateChangesetPaths(indexPathRulesOf(ctx), changeset)`. `applyChangeset`'s public
    signature and JSDoc are unchanged. Checkout reaches it through
    src/application/primitives/materialize-tree.ts.
- submodule-context.ts `:1` imports `NO_PARSER_OFFSET, validateIndexPath`; drop
  `validateIndexPath`, import `indexPathRulesOf` from ./index-path-rules.js.
  - `:60-84` `export const deriveSubmoduleContext = async (ctx, name, treeRelPath, visited
    = new Set())` (internal): `:74` →
    `indexPathRulesOf(ctx).validateIndexPath(treeRelPath, NO_PARSER_OFFSET, FILE_MODE.GITLINK)`.
    The path becomes the child's work directory, so under Windows syntax a `\` in it would
    be a separator.

**Tests:**

- apply-changeset.test.ts — helpers `makeAdd(path, id, mode?, opts?)` `:72`,
  `makeDelete(path, previousId, previousMode?, opts?)` `:88`, `makeChangeset(entries)`,
  `writeBlob(ctx, bytes)` `:117`, `WORKDIR = '/repo'` `:55`, `buildSeededContext`; refusal
  idiom `:2343-2372`. Add, next to `describe('Given an add entry named \`.GIT\` …')`:
  - `describe('Given an add entry x\\y')`:
    - `When applyChangeset runs under Windows path syntax` → `.data` `{ code:
      'INVALID_INDEX_ENTRY', offset: -1, reason: 'backslash rejected under Windows path
      syntax' }`; `${WORKDIR}/x\y` absent.
    - `When applyChangeset runs under POSIX path syntax` → resolves; `${WORKDIR}/x\y`
      exists.
  - **Kill test** `describe('Given a delete entry x\\y from a parsed index')` > `When
    applyChangeset runs under Windows path syntax` > `Then it removes the file without
    verifying the path`: write `${WORKDIR}/x\y` with the blob's bytes, `makeDelete('x\\y',
    id)`, `force: true` (skips the dirty probe); assert it resolves and the file is gone.
- submodule-context.test.ts — helper `seedHead(ctx, name)` `:10`, `createMemoryContext`.
  Add `describe('Given a gitlink path x\\y')`:
  - `When the submodule context is derived under Windows path syntax` → try/catch `.data`
    with the backslash reason (offset -1).
  - `When derived under POSIX path syntax` (after `seedHead(ctx, 'm')`) → child
    `layout.workDir` is `${ctx.layout.workDir}/x\y`.
- Interop (Part 4's file) — add a **checkout arm** (`describe('When the commit is checked
  out')` under the same `Given`), a fresh pair per row (`buildSeededPair(root,
  \`co-${index}\`)`), same `REFUSED_ROWS` / `ADMITTED_ROWS`:
  - git `checkout -q <c>`: exit `1` on refused rows (git's unpack-trees error path, the
    same exit the POSIX interop pins), `0` on admitted;
  - tsgit `repo.checkout({ rev })`: code + backslash reason on refused rows;
  - `rev-parse HEAD` unchanged on both sides on refusal, the commit when admitted;
  - `listIndex` equal on both sides;
  - `existsSync(path.join(dir, '.git', 'hooks', 'post-checkout'))` is `false` on both
    sides. This is the threat row: before this part, tsgit's checkout on Windows writes
    `<worktree>\.git\hooks\post-checkout` through the separator.
  - Update the `@proves` `interopSurface` to `reset, checkout, update-index, ls-files`.

### TDD steps

1. **RED** — apply-changeset.test.ts Windows `add` twin. Fails: the posix check admits
   `x\y`, so the file is written. (Posix control: GUARD.)
2. **RED (CI only)** — interop checkout arm. On `windows-latest`, tsgit's checkout admits
   the refused rows and writes the hook file. Locally it only collects.
3. **GREEN** — thread `pathRules` through `validateChangesetEntry` /
   `validateChangesetPaths` / `applyChangesetInScope`; delete the `Stryker disable` line
   and reword the comment. Steps 1 (and 2 on CI) green.
4. **GUARD** — the delete kill test. It passes (the guard skips the delete). It exists to
   kill the `ConditionalExpression` mutant the deleted directive used to hide: with the
   guard forced `false`, the windows rules throw `backslash` on the delete.
5. **RED** — submodule-context.test.ts Windows twin. Fails: the posix check admits `x\y`;
   the call returns `undefined` (no HEAD seeded) instead of throwing. (Posix control:
   GUARD.)
6. **GREEN** — submodule-context.ts `:74`. Step 5 green.
7. **GUARD** — `npx vitest run test/unit/application/commands/checkout.test.ts test/unit/application/primitives/materialize-tree.test.ts test/unit/application/primitives/walk-submodules.test.ts`.
8. **REFACTOR** — comment wording only.

**Mutation targets** (Stryker on apply-changeset.ts, submodule-context.ts):

| Mutant | Killer |
|---|---|
| `entry.kind !== 'add' && entry.kind !== 'update'` → `false` (was suppressed) | delete kill test (windows rules throw on `x\y`) |
| → `true` | existing `.GIT` add refusal (`:2343`) |
| `entry.kind !== 'update'` → `false` | delete kill test |
| `entry.kind !== 'add'` → `true` | existing `.GIT` add refusal |
| `&&` → `\|\|` | existing `.GIT` add refusal (always returns) |
| `'add'` → `""` | existing `.GIT` add refusal |
| `'update'` → `""` | existing `.gitmodules` update refusal (`:2405`) |
| submodule-context.ts | no new mutable operator; the twin is the proof |

### Gate

```bash
PATH=$HOME/.local/git-2.55.0/bin:$PATH npx vitest run test/unit/application/primitives/apply-changeset.test.ts test/unit/application/primitives/internal/submodule-context.test.ts test/unit/application/commands/checkout.test.ts && npx vitest list --project win-integration test/integration/win-only/backslash-path-windows-interop.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/primitives/apply-changeset.ts test/unit/application/primitives/apply-changeset.test.ts src/application/primitives/internal/submodule-context.ts test/unit/application/primitives/internal/submodule-context.test.ts test/integration/win-only/backslash-path-windows-interop.test.ts && npm run check:spelling
```

The `vitest list` output must now show the checkout-arm titles too.

### Commit

`fix(checkout): refuse a backslash path in checkout and submodule paths under windows path syntax`

## Part 7 — the merge write gate refuses a backslash path under Windows path syntax

### Context

Files this part edits (all others are read-only):

- `src/application/primitives/internal/validate-merge-write-paths.ts`
- `test/unit/application/primitives/internal/validate-merge-write-paths.test.ts`
- `src/application/commands/merge.ts`
- `test/unit/application/commands/merge.test.ts`
- `src/application/primitives/apply-merge-to-worktree.ts`
- `test/unit/application/primitives/apply-merge-to-worktree.test.ts`

**Sites** (line numbers at the plan commit; no earlier part edits these files). WD3 (a):
only the gate takes the windows rules; the re-checks and removals behind it stay posix
(coverage proof: "Merge-gate coverage" above).

- validate-merge-write-paths.ts:
  - `:1` imports `validateTreePath`; replace with `type IndexPathRules`.
  - `:27-40` `export const validateMergeWritePaths = (outcomes, conflicts, changed): void`
    → `(pathRules: IndexPathRules, outcomes, conflicts, changed)`; `:34`
    `pathRules.validateTreePath(…)`; `:39` `validateConflictWritePaths(pathRules,
    conflict)`.
  - `:48-56` `export const validateConflictWritePaths = (conflict: MergeConflict): void`
    → `(pathRules: IndexPathRules, conflict)`; `:51`, `:54`, `:55` use
    `pathRules.validateTreePath`.
  - JSDoc `:9-26`: add one sentence: the caller passes its host's rules, so the gate
    refuses a `\` under Windows syntax before any write, removals included.
- merge.ts (`:29` imports `validateTreePath`, keep it for `:1863`, `:1927`; add
  `posixIndexPathRules` to that import and `indexPathRulesOf` from
  ../primitives/internal/index-path-rules.js):
  - `:1288` `persistOctopusConflict` → `validateMergeWritePaths(indexPathRulesOf(ctx),
    outcomes, result.conflicts, changed)`;
  - `:1661` `refuseUnwritableConflicts` → same with `result.outcomes`;
  - `:1879` `conflictWave` and `:1957` `writeConflictToTree` →
    `validateConflictWritePaths(posixIndexPathRules, conflict)` (re-checks behind the gate;
    `writeConflictToTree` is exported for tests, its signature is unchanged).
- apply-merge-to-worktree.ts `:454` `materialiseConflict` →
  `validateMergeWritePaths(indexPathRulesOf(ctx), merged.outcomes, merged.conflicts,
  changed)`. `:224` / `:251` stay posix (`validateTreePath`).

**Tests:**

- validate-merge-write-paths.test.ts (helpers `catchError`, `DUMMY_OID`; 12 existing
  `sut(…)` calls). Pass `posixIndexPathRules` as the new first argument to each existing
  call. Add `describe('Given a backslash path at each write the gate checks')` >
  `When validateMergeWritePaths runs with the Windows rules` > `it.each` (each row reaches
  one internal call; reason asserted in full):
  - `resolved-known` outcome `x\y`, in `changed` (`:34`);
  - `resolved-deleted` outcome `x\y`, in `changed` (`:34`, the removal is gated too);
  - `modify-delete` conflict `x\y`, `ourMode: REGULAR` (`:51`);
  - `file-directory` conflict `x\y`, `theirId`, `theirMode: REGULAR`, no side paths
    (`:54` alone);
  - `distinct-types` conflict `path: 'p'`, `ourPath: 'p'`, `ourMode: REGULAR`,
    `theirPath: 'x\\y'`, `theirMode: SYMLINK` (`:55`).
  Plus `When … runs with the POSIX rules` > the same rows do not throw.
- merge.test.ts:
  - two-head gate (`:1661`): copy `describe('Given theirs adds a hostile path and
    conflicts with ours on another')` (`:2597-2650`) as `describe('Given theirs adds x\\y
    and conflicts with ours on another')`: the hostile entry is
    `treeEntry(FILE_MODE.REGULAR, 'x\\y', …)` at the root of `featureTree`, `sut` runs
    with `{ ...ctx, windowsPathSyntax: true }`; assert `{ code: 'INVALID_INDEX_ENTRY',
    reason: <backslash reason> }`, `file.txt` still `MAIN\n`, `clean.txt` still
    `base-clean\n`, `x\y` absent. Posix control: the same merge on `ctx` resolves with
    `kind: 'conflict'` and writes `x\y`.
  - octopus gate (`:1288`), inside `describe('merge — several heads (octopus)')`
    (`:5621`; helpers `seedConflicting()` `:5873`, `MAIN_M2`, `t`): after
    `seedConflicting()`, move refs/heads/b1 to a commit whose tree is b1's tree plus
    `x\y` (read b1's commit and tree with `readObject`, `writeTree` with the extra
    `treeEntry`, `createCommit` with parent b1, `updateRef`; the octopus merge is in
    memory, src/application/commands/internal/octopus-merge.ts, so the first refusal is
    the gate). `mergeRun({ ...ctx, windowsPathSyntax: true }, { rev: ['b1', 'b2', 'c1'],
    author: t, committer: t })` → backslash reason; HEAD still `MAIN_M2`; no `MERGE_HEAD`;
    `x\y` absent.
- apply-merge-to-worktree.test.ts — copy `describe('Given a conflicting merge where one
  changed path is hostile and a sibling path is clean')` (`:776-835`; helpers
  `treeWith` `:47`, `indexEntry` `:50`, `index` `:70`, `buildSeededContext`) with the
  sub/. content conflict replaced by a root-level `x\y` content conflict, applied with
  `{ ...ctx, windowsPathSyntax: true }`: backslash reason, `clean.txt` not rewritten.
  Posix control: same inputs on `ctx` → `kind: 'conflict'`.

### TDD steps

1. **RED** — validate-merge-write-paths.test.ts Windows table. Fails: the current
   signature is `(outcomes, conflicts, changed)`, so `windowsIndexPathRules` lands in
   `outcomes` and the `for…of` throws `TypeError: … is not iterable` instead of
   `INVALID_INDEX_ENTRY` (vitest strips types, so the rows run; check:types is red until
   step 5).
2. **RED** — merge.test.ts two-head twin. Fails: the gate at merge.ts:1661 uses the posix
   `validateTreePath`, which admits `x\y`, so the merge resolves with `kind: 'conflict'`
   and writes `x\y`. (Posix control: GUARD.)
3. **RED** — merge.test.ts octopus twin. Fails: the gate at merge.ts:1288 admits `x\y`,
   so the octopus stops on its conflict and writes `x\y` and `MERGE_HEAD`.
4. **RED** — apply-merge-to-worktree.test.ts twin. Fails: the gate at
   apply-merge-to-worktree.ts:454 admits `x\y`, so it returns `kind: 'conflict'`.
   (Posix control: GUARD.)
5. **GREEN** — new signatures in validate-merge-write-paths.ts; pass `posixIndexPathRules`
   in the 12 existing test calls; thread `indexPathRulesOf(ctx)` into the three gate
   calls (merge.ts `:1288`, `:1661`; apply-merge-to-worktree.ts `:454`) and
   `posixIndexPathRules` into the two re-check calls (merge.ts `:1879`, `:1957`).
   Steps 1-4 green, check:types green.
6. **GUARD** — `npx vitest run test/unit/application/commands/merge-leading-symlink.test.ts test/unit/application/commands/stash.test.ts test/unit/application/commands/internal`
   (cherry-pick / revert / rebase / stash go through `applyMergeToWorktree`).
7. **REFACTOR** — JSDoc sentence; nothing else.

**Mutation targets:** no new mutable operator (identifier threading). Existing mutants in
validate-merge-write-paths.ts keep their killers through the updated posix calls. The
per-call-site twins are the proof for each of the three gate calls.

### Gate

```bash
PATH=$HOME/.local/git-2.55.0/bin:$PATH npx vitest run test/unit/application/primitives/internal/validate-merge-write-paths.test.ts test/unit/application/commands/merge.test.ts test/unit/application/primitives/apply-merge-to-worktree.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/primitives/internal/validate-merge-write-paths.ts test/unit/application/primitives/internal/validate-merge-write-paths.test.ts src/application/commands/merge.ts test/unit/application/commands/merge.test.ts src/application/primitives/apply-merge-to-worktree.ts test/unit/application/primitives/apply-merge-to-worktree.test.ts && npm run check:spelling
```

### Commit

`fix(merge): refuse a backslash path in the merge write gate under windows path syntax`

## Self-review (addendum, 3 passes, converged)

- **Pass 1 (contradictions):**
  - The brief asked for Parts 3 and 4. 21 files over two parts breaks the 6-file part
    ceiling (`plan-lint` blocks it), so the work is five parts; the interop file is
    folded into the two parts whose code it exercises (no test-only part).
  - The design's add twin assumed `stageFromStat` is reachable with `\`. It is not
    (working-tree-path.ts:69). The reachable add site is `renormalizeOne` (index-driven);
    `stageFromStat` is threaded without a twin, stated in Part 5.
  - The `Stryker disable` at apply-changeset.ts:317 is removed in the part that changes
    the rules there (6), with its kill test, not in the domain part.
- **Pass 2 (unstated assumptions):**
  - `npx vitest list` exits 0 on a missing file (probed), so each interop gate also names
    the file in `biome check`, which fails when it is absent, and asks the implementer to
    read the listed titles.
  - `add.ts` already has `indexRules`: the local is `pathRules`.
  - mv is index-driven (no worktree walk in src/application/commands/mv.ts), so a member
    `d/x\y` reaches `applyToIndex`; `seedRows` / `seedRepo` write raw files without `add`.
  - The octopus merge is in memory (octopus-merge.ts), so the octopus twin isolates the
    gate at merge.ts:1288.
  - knip treats tests as entries (vitest plugin), so test-only use between Parts 3 and 4
    is not dead code.
- **Pass 3 (edge behaviour):**
  - NUL still wins over `\` (`unsafeReason` runs before the verifier): pinned in Part 3.
  - Raw bytes still reach the verifier under the windows rules: pinned with the
    `.git\xff/x` row.
  - WD3 coverage traced through every caller of the six re-check / removal sites
    (table above); the `resolved-deleted` stand-in means a removal of `\.git\config`
    under Windows is refused at the gate, as WD3 (c) was rejected for.
  - Parse, write-tree and archive stay posix (WD1): no part touches
    index-parser.ts:128, synthesize-tree-from-index.ts:90 or archive.ts:164, and the
    interop parsed-index row pins the read on Windows.
