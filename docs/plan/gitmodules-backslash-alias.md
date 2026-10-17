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
