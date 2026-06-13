# Plan — missing-value-refusal-parity

> Source: design doc `docs/design/missing-value-refusal-parity.md` · ADRs `327-329`
> Handoff note: each slice below is self-contained — a slice agent starts with ZERO prior
> context. Every `### Context` block names exact file paths, symbol name-paths, current
> signatures, the test files + describe/it blocks to extend, and the pinned bytes the slice
> must reproduce. Do not re-derive git behaviour: the matrix in the design doc §"Pinned git
> behaviour" is authoritative and already verified against git 2.54. Do NOT run
> `git config <key> <value>` or write any `.git/config` under the repo's common-dir — a
> stray write corrupts every sibling worktree (interop tests write the valueless line by
> file write into an isolated tmpdir only).

## Sizing rules

- No standalone test-only slices: fold each slice's tests into the slice whose code they
  exercise. Slice 1 ships the primitive + its unit tests; slices 2 and 3 ship a wiring change
  + unit tests + an interop test together.
- Sequential slices share one working tree and build on each other: slice 2 wires the
  `findFirstValuelessEntry` primitive + `configMissingValue` factory that slice 1 lands;
  slice 3 reuses both at the remote-URL sites. Land each as one atomic conventional commit
  on a green `npm run validate` (never `--no-verify`).

## Slice 1 — config-missing-value substrate (error variant + `findFirstValuelessEntry` primitive)

### Context

This slice adds the structured-error shape (ADR-328) and the cold-path detection primitive
(ADR-327). No consumer is wired yet — slices 2 and 3 do that. `ParsedConfig`/`IniSection`
stay UNCHANGED (ADR-315 D4 preserved); the porcelain read path is untouched.

**File 1 — `src/domain/commands/error.ts`** (add the variant + factory):

- The `CommandError` discriminated union is one big `type CommandError = … | … ;` (L7–191).
  Add a new arm. The structural precedent to mirror is `CONFIG_PARSE_ERROR` at L116–121:
  ```ts
  | {
      readonly code: 'CONFIG_PARSE_ERROR';
      readonly line: number;
      readonly source?: string;
      readonly partialSectionName?: string;
    }
  ```
  Add (place it immediately after the `CONFIG_PARSE_ERROR` arm, before `CONFIG_MULTIPLE_VALUES`):
  ```ts
  | {
      readonly code: 'CONFIG_MISSING_VALUE';
      readonly key: string;
      readonly source: string;
      readonly line: number;
    }
  ```
  All three data fields are REQUIRED (unlike `CONFIG_PARSE_ERROR`'s optional `source`) — per
  ADR-328 the factory always has key + resolved path + 1-based line.
- The factory precedent is `configParseError` at L419–429 (uses conditional spreads because
  its `source`/`partialSectionName` are optional). Add the new factory near the other
  `config*` factories (e.g. after `configParseError`, before `configInvalidFile` at L437). All
  fields required ⇒ no conditional spread needed:
  ```ts
  /**
   * A string-typed config key is present-but-valueless (git's internal NULL) at the
   * 1-based `line` of `source`. `key` is the fully-qualified config key
   * (`'user.name'`, `'remote.origin.url'`). Lets a caller reconstruct git's two-line
   * `missing value for '<key>'` / `bad config variable '<key>' … at line <N>` refusal.
   */
  export const configMissingValue = (key: string, source: string, line: number): TsgitError =>
    new TsgitError({ code: 'CONFIG_MISSING_VALUE', key, source, line });
  ```
  Note: `key` here is a fully-qualified config key built by the primitive (not raw user
  input), so it does NOT need `sanitizeForDisplay` — keep it verbatim. (`configParseError`
  carries no key and does not sanitize either; the sanitized factories are the ones that
  embed untrusted user strings.)
- The error module is re-exported through `src/domain/index.ts` and `src/domain/commands/error.ts`
  is imported by both `config-read.ts` (L1 `import { configParseError } from '../../domain/commands/error.js'`)
  and the command files. Slice 2/3 import `configMissingValue` from `'../../domain/commands/error.js'`
  (commands) or `'../../domain/index.js'` (matching each file's existing import style — see
  fetch.ts L20 / push.ts L23 which import `remoteNotConfigured` from `'../../domain/index.js'`).

**File 2 — `src/application/primitives/config-read.ts`** (add the primitive):

- Already imports `commonGitDir` from `'./path-layout.js'` (L4) and has a module-private
  `readRawConfig(ctx, path): Promise<string | undefined>` (L91–98) that swallows
  `FILE_NOT_FOUND` → `undefined`. Reuse it — do NOT re-implement file reading.
- `tokenizeConfig(text, source?)` (exported, L196) returns `ReadonlyArray<ConfigToken>`. The
  relevant token shapes (L125–143):
  - `{ kind: 'header'; section: string; subsection: string | undefined; line; hasComment }`
  - `{ kind: 'entry'; key: string; value: string | null; startLine: number; endLine }` —
    `value === null` is the valueless (no-`=`) case; `startLine` is 0-based.
- Add the primitive (place it near `loadConfig`/`readRawConfig`, after `readRawConfig`):
  ```ts
  export interface ValuelessEntry {
    readonly key: string;     // fully-qualified incl. subsection: 'user.name' / 'remote.origin.url'
    readonly source: string;  // tsgit's resolved absolute config path
    readonly line: number;    // 1-based
  }

  /**
   * Cold-path detection (ADR-327): re-tokenize the repo-local config and return the
   * FIRST valueless (`value === null`) entry, by config-file line, whose key (case-
   * insensitive) is one of `keys` and which sits under `[<section> "<subsection>"]`
   * (subsection `undefined` ⇒ the section with no subsection). Returns the fully-qualified
   * key, the absolute config path, and the 1-based line, or `undefined` when no such
   * entry exists (key absent or valued). Runs ONLY on a command's refusal path. Leaves
   * `ParsedConfig`/`IniSection` untouched (ADR-315 D4).
   */
  export const findFirstValuelessEntry = async (
    ctx: Context,
    section: string,
    subsection: string | undefined,
    keys: ReadonlyArray<string>,
  ): Promise<ValuelessEntry | undefined> => { … }
  ```
  Implementation shape:
  - `const path = `${commonGitDir(ctx)}/config``; `const raw = await readRawConfig(ctx, path);`
    `if (raw === undefined) return undefined;`
  - `const tokens = tokenizeConfig(raw, path);` (passing `path` as `source` keeps a
    `CONFIG_PARSE_ERROR` thrown here labelled consistently — the file is well-formed on the
    refusal path, but a malformed-elsewhere file would already have failed the earlier
    `readConfig`; re-tokenizing is bounded and side-effect-free).
  - Walk tokens tracking the current section/subsection from each `header` token. The match
    predicate for `section`/`subsection`: git config section names are case-insensitive but
    subsection names are case-SENSITIVE — compare `section` lower-cased, `subsection` verbatim
    (mirror `dispatchSection` in this same file, which matches `sec.section === 'user'` on the
    already-lowercased parsed section and `sec.subsection` verbatim). Keep it simple and
    correct: lower-case both the token's section and the `section` arg for comparison;
    compare `subsection` with `===` (both already in the form the tokenizer yields).
  - Iterate in token order (= file order). The FIRST `entry` token under a matching header
    whose `value === null` AND whose `key.toLowerCase()` is in the lower-cased `keys` set wins.
    Return the **fully-qualified** key including the subsection when one is present, so the
    `key` field equals git's reported key verbatim (ADR-328): build it as
    `subsection === undefined ? `${section}.${loweredKey}` : `${section}.${subsection}.${loweredKey}``.
    Caller passes canonical lower-cased keys (`['name','email']` / `['url']`) and canonical
    `section` (`'user'`/`'remote'`), so this yields `'user.name'` and `'remote.origin.url'`
    directly — no consumer-side reconstruction. Return
    `{ key: <qualified>, source: path, line: token.startLine + 1 }`.
  - No match → `undefined`.
  - Keep the function ≤20 lines via small helpers (e.g. a `matchesSection` predicate and a
    `keySet = new Set(keys.map(k => k.toLowerCase()))`); early-return on the first hit.
- Export it from the primitives barrel **`src/application/primitives/index.ts`** (L12–13
  currently re-export the config-read surface):
  ```ts
  export type { IniSection, ParsedConfig } from './config-read.js';
  export { invalidateConfigCache, parseIniSections, readConfig } from './config-read.js';
  ```
  Add `findFirstValuelessEntry` to the value export and `ValuelessEntry` to the type export.
  (No `api.json` regen needed unless `findFirstValuelessEntry` becomes a PUBLIC export through
  `src/index.ts`; it is a primitive consumed internally by slices 2/3 — keep it out of the
  top-level public barrel. If the prepush `check:doc-typedoc` gate flags an unreferenced
  primitive export, that is fine; the barrel re-export is the convention used by every sibling
  primitive.)

**Test file — `test/unit/application/primitives/config-read.test.ts`** (extend):

- Imports at L1–11 already pull `__resetConfigCacheForTests, tokenizeConfig, readConfig,
  parseIniSections` from config-read and `createMemoryContext` from the memory adapter. Add
  `findFirstValuelessEntry` (and `type ValuelessEntry` if asserting the shape) to that import.
- Seed helper (L22–24): `const seed = async (ctx, content) => ctx.fs.writeUtf8(`${ctx.layout.gitDir}/config`, content)`.
  The memory adapter leaves `commonDir` undefined, so `commonGitDir(ctx)` === `ctx.layout.gitDir`
  — the primitive reads exactly the file `seed` writes. There is a `beforeEach(__resetConfigCacheForTests)`
  at L27–29 inside `describe('primitives/config-read')`; `findFirstValuelessEntry` does not use
  the `readConfig` cache, but keep the reset to stay consistent. Use a FRESH `createMemoryContext()`
  per test (or reuse the file's pattern of one ctx per `it`).
- Add a new `describe('Given a config with valueless/valued entries', () => { describe('When findFirstValuelessEntry', …) })`
  block. Follow the file's GWT/AAA/`sut` style (`sut` is the function under test — name the
  awaited result `result`, not `sut`). All assertions on the returned object's fields
  INDIVIDUALLY (mutation-resistant): `result?.key`, `result?.line`, `result?.source`.

### TDD steps

RED (write failing tests first; expected failure = `findFirstValuelessEntry` does not exist /
the `CONFIG_MISSING_VALUE` variant does not compile):

1. `error.ts`: there is an existing error-factory test surface — confirm whether
   `test/unit/domain/commands/error.test.ts` exists; if it does, add a test
   `Given a missing-value refusal, When configMissingValue('user.name', '/abs/.git/config', 2),
   Then data is { code:'CONFIG_MISSING_VALUE', key, source, line }` asserting each `.data`
   field individually. If no such per-factory test file exists, the factory is exercised
   transitively by slices 2/3 and by the type-check; still assert the variant compiles by
   referencing it in the primitive test. (Expected RED: `configMissingValue` is not exported.)
2. Primitive — valueless found among target keys (single key, valueless):
   seed `'[user]\n\tname\n\temail = a@b.c\n'`; `findFirstValuelessEntry(ctx,'user',undefined,['name','email'])`
   → `{ key:'user.name', line:2, source: `${ctx.layout.gitDir}/config` }`. Assert each field.
   (Expected RED: function undefined.)
3. Primitive — valued only → `undefined`: seed `'[user]\n\tname = Ada\n\temail = a@b.c\n'`
   → returns `undefined`.
4. Primitive — key absent (no matching key lines) → `undefined`: seed `'[user]\n\temail = a@b.c\n'`
   with `keys=['name']` → `undefined`; and seed `''` (empty/missing config) → `undefined`.
5. Primitive — file-order across multiple keys (valued name, valueless email):
   seed `'[user]\n\tname = Ada\n\temail\n'` → `{ key:'user.email', line:3 }`.
6. Primitive — both valueless, name earlier: seed `'[user]\n\tname\n\temail\n'`
   → `{ key:'user.name', line:2 }`.
7. Primitive — both valueless, email earlier (the discriminator): seed `'[user]\n\temail\n\tname\n'`
   → `{ key:'user.email', line:2 }`. This pins file-position order (kills a fixed-name-first mutant).
8. Primitive — case-insensitive key match: seed `'[user]\n\tNAME\n'` with `keys=['name']`
   → `{ key:'user.name', line:2 }` (returned key is canonical lower-case).
9. Primitive — header scoping (wrong section): seed `'[other]\n\tname\n[user]\n\temail = a@b.c\n'`
   with `keys=['name','email']` → `undefined` (the valueless `name` under `[other]` is NOT
   matched; `email` is valued). Then a positive scoping test: seed
   `'[other]\n\tname\n[user]\n\tname\n'` → `{ key:'user.name', line:4 }`.
10. Primitive — subsection scoping (remote-shaped, anticipates slice 3):
    seed `'[remote "origin"]\n\turl\n'`; `findFirstValuelessEntry(ctx,'remote','origin',['url'])`
    → `{ key:'remote.origin.url', line:2 }` — the primitive composes the FULL qualified key
    including the subsection (ADR-328: `key` equals git's reported key, so slice 3 passes
    `found.key` straight through, no reconstruction). **Decision pinned for slice 3:** the
    primitive owns subsection composition; assert `key === 'remote.origin.url'` here so slice 3
    builds on the proven contract. Also: `findFirstValuelessEntry(ctx,'remote','other',['url'])`
    on the same seed → `undefined` (subsection mismatch, case-sensitive).

GREEN: add the `CONFIG_MISSING_VALUE` variant + `configMissingValue` factory in `error.ts`;
implement `findFirstValuelessEntry` + `ValuelessEntry` in `config-read.ts`; add barrel exports.

REFACTOR: extract the section-match predicate and the key-set membership into named helpers
(<20-line function, no nesting >2, early returns). Confirm no `null` leaks into the public
return (only `ValuelessEntry | undefined`). Confirm `readConfig`'s behaviour is unchanged.

### Gate

`npx vitest run test/unit/application/primitives/config-read.test.ts && npm run check:types && npx biome check src/domain/commands/error.ts src/application/primitives/config-read.ts src/application/primitives/index.ts test/unit/application/primitives/config-read.test.ts`

(If a `test/unit/domain/commands/error.test.ts` was extended in step 1, add it to the vitest
+ biome file lists.)

### Commit

`feat(config): detect valueless string-config entries via cold-path re-read`

## Slice 2 — identity refusal (wire the guard at commit + current-identity)

### Context

Wire `findFirstValuelessEntry` + `configMissingValue` (both landed in slice 1) on the COLD
path of the two identity resolution sites — only where today's `AUTHOR_UNCONFIGURED` would
fire. The pure `resolveAuthor`/`resolveCommitter` (`internal/commit-message.ts`) keep throwing
`AUTHOR_UNCONFIGURED` for the truly-absent case and keep their SYNCHRONOUS signatures — do NOT
make them async (ADR-329 / requirement 3: absent ≠ valueless).

**New file — `src/application/commands/internal/identity-config.ts`** (the shared async guard):

- Single home for the guard so both `commit.ts` and `current-identity.ts` import one symbol
  (DRY; avoids duplicating the detection). `current-identity.ts` already imports from
  `../../primitives/config-read.js`, so importing the primitive here introduces no cycle.
  ```ts
  import { configMissingValue } from '../../../domain/commands/error.js';
  import type { Context } from '../../../ports/context.js';
  import { findFirstValuelessEntry } from '../../primitives/config-read.js';

  /**
   * Refuse with `CONFIG_MISSING_VALUE` when `[user] name`/`email` is present-but-valueless,
   * reporting the FIRST such entry by config-file line (ADR-327 file-position order). Call
   * ONLY on the cold path — where the identity is otherwise unresolved — so a valued
   * config still resolves normally and the absent case still falls through to
   * `AUTHOR_UNCONFIGURED`.
   */
  export const assertUserNotValueless = async (ctx: Context): Promise<void> => {
    const found = await findFirstValuelessEntry(ctx, 'user', undefined, ['name', 'email']);
    if (found !== undefined) throw configMissingValue(found.key, found.source, found.line);
  };
  ```
  The returned `found.key` is already `'user.name'` / `'user.email'` (slice 1 contract:
  `<section>.<key>` for a section with no subsection) — pass it straight through.

**Wire site 1 — `src/application/commands/commit.ts`**:

- Current flow (L91–95):
  ```ts
  const resolved = await resolveCommitMessage(ctx, opts, resolvingPending);
  const config = await readConfig(ctx);
  const configUser = toAuthor(config.user);            // L93
  const author = resolveAuthor(buildResolverInput(opts.author, configUser));   // L94 — throws AUTHOR_UNCONFIGURED
  const committer = resolveCommitter(buildCommitterInput(opts.committer, author, configUser)); // L95
  ```
  `toAuthor` (L257–267) returns `undefined` when `config.user === undefined` — which is BOTH
  the absent and the valueless case (ADR-315 D4 erased them to the same state). Insert the
  guard so it fires only when an explicit author was NOT supplied AND config identity is
  missing (the cold path). Place it AFTER L93 (`configUser` computed) and BEFORE L94
  (`resolveAuthor`):
  ```ts
  const configUser = toAuthor(config.user);
  if (opts.author === undefined && configUser === undefined) {
    await assertUserNotValueless(ctx);
  }
  const author = resolveAuthor(buildResolverInput(opts.author, configUser));
  ```
  Rationale for the `opts.author === undefined` clause: when an explicit `opts.author` is
  passed, `resolveAuthor` returns it without ever consulting config, so git would never read
  `user.*` — guarding there would be a spurious refusal. (Committer: git's identity refusal
  trips on the author read first; `opts.committer` falling back to the resolved author means a
  valueless `user.*` is already caught by the author-path guard. Keep the single guard on the
  author cold path — do NOT add a second guard at the committer site; that would be redundant
  and could double-throw.)
- Add the import alongside the existing `internal/*` imports (the file already imports from
  `./internal/commit-message.js` at L26–31):
  `import { assertUserNotValueless } from './internal/identity-config.js';`

**Wire site 2 — `src/application/commands/internal/current-identity.ts`**:

- Current body (L11–24): `const config = await readConfig(ctx); const user = config.user;`
  builds `configUser` when `user !== undefined`, else passes `{}` to `resolveCommitter` (which
  throws `AUTHOR_UNCONFIGURED`). Insert the guard on the cold path — when `user === undefined`:
  ```ts
  const config = await readConfig(ctx);
  const user = config.user;
  if (user === undefined) await assertUserNotValueless(ctx);
  const configUser = user !== undefined ? { … } : undefined;
  return resolveCommitter(configUser !== undefined ? { configUser } : {});
  ```
  Add `import { assertUserNotValueless } from './identity-config.js';` (sibling file, same dir).
  This covers cherry-pick / rebase / revert / merge, which all resolve identity through
  `resolveCurrentIdentity` (ADR-329).

**Unit test files to extend:**

- `test/unit/application/commands/commit.test.ts` — existing structure: `seed()` (L24–32)
  `init`s a memory ctx + stages `{'a.txt':'a'}`; `expectError(fn, code)` (L34) catches a
  `TsgitError` and asserts `.data.code`. The AUTHOR_UNCONFIGURED test lives at L221–230
  (`describe('Given no author and no config user') > … > it('Then throws AUTHOR_UNCONFIGURED')`
  → `await expectError(() => commit(ctx, { message: 'x' }), 'AUTHOR_UNCONFIGURED')`). The
  config-`[user]` happy path is at L429–455 (writes `'[user]\n  name = Grace\n  email = grace@example.com\n'`
  then `__resetConfigCacheForTests()` then commits). Config is seeded via
  `ctx.fs.writeUtf8(`${ctx.layout.gitDir}/config`, …)`. **`expectError` only checks the code —
  for the new cases assert key + line + source INDIVIDUALLY via a direct try/catch**, since
  `CONFIG_MISSING_VALUE` carries data that must be mutation-pinned. Import `__resetConfigCacheForTests`
  is already at L7.
- `test/unit/application/commands/internal/current-identity.test.ts` — structure: `seed()`
  (L9–14) `init`s ctx + `__resetConfigCacheForTests()`; existing tests write config via
  `ctx.fs.appendUtf8(`${ctx.layout.gitDir}/config`, '\n[user]\n\tname = Ada\n\temail = a@x\n')`
  then `__resetConfigCacheForTests()`. AUTHOR_UNCONFIGURED test at L40–58 (try/catch →
  `caught?.data.code === 'AUTHOR_UNCONFIGURED'`). Note: `init` writes a `[core]` preamble to
  `.git/config`, so a valueless `[user]` line appended after it will NOT be at line 2 — use
  `ctx.fs.writeUtf8` to REPLACE the whole config with a fixture whose line numbers you control
  (e.g. `'[user]\n\tname\n\temail = a@x\n'` ⇒ valueless `name` at line 2), then
  `__resetConfigCacheForTests()`. `findFirstValuelessEntry` reads the raw file directly, so the
  cache reset matters only for the `readConfig` call that precedes the guard.

**Interop test — `test/integration/missing-value-refusal-interop.test.ts`** (new file):

- Model on `test/integration/config-interop.test.ts` (node adapter + `interop-helpers.ts`)
  and `test/integration/commit-message-interop.test.ts` (real `commit` via `openRepository`
  from `'../../src/index.node.js'`, with `GIT_AUTHOR_*`/`GIT_COMMITTER_*` in a scrubbed env).
  Helpers available from `./interop-helpers.js`: `GIT_AVAILABLE`, `runGit`, `runGitEnv`,
  `tryRunGit`, `makePeerPair`, `initBothRepos`, `git`. Use `describe.skipIf(!GIT_AVAILABLE)`.
- For commit interop, create an isolated tmpdir repo (do NOT use the worktree). Pattern:
  `const ours = await realpath(await mkdtemp(path.join(os.tmpdir(), 'tsgit-missing-value-ours-')));`,
  `runGit(['init','-q','-b','main', ours])`, stage a file (`runGit(['-C',ours,'add','.'])` after
  writing a worktree file), then OVERWRITE `<ours>/.git/config` with the valueless fixture via
  `writeFile` (git's CLI cannot emit a valueless entry — file write is mandatory).
- The fixture must control line numbers. `git init` writes a `[core]` preamble; to pin
  `user.name` at a known line, write a FULL config replacing the file, e.g.
  ```
  [core]
  \trepositoryformatversion = 0
  [user]
  \tname
  \temail = a@b.c
  ```
  → valueless `user.name` at line 4. Compute the expected line from the fixture (do not
  hard-code blindly — derive from the fixture string), OR keep a minimal `[user]`-first fixture
  if git tolerates a missing `[core]` (it does for a non-bare repo with files); simplest robust
  choice: write the full fixture above and assert `line === 4`.
- Twin assertions:
  1. Real git refuses: `const g = tryRunGit(['-C', ours, 'commit', '-m', 'x'], { env: COMMIT_ENV });`
     `expect(g.ok).toBe(false);` exit 128 (execFileSync surfaces non-zero as a throw → `tryRunGit`
     captures `stderr`). Parse git's two lines from `g.stderr`:
     `error: missing value for 'user.name'` and
     `fatal: bad config variable 'user.name' in file '<F>' at line <N>`.
  2. tsgit refuses: open the SAME repo via `openRepository`, run `commit`, catch the
     `TsgitError`; assert `.data.code === 'CONFIG_MISSING_VALUE'` and each field individually:
     `data.key === 'user.name'`, `data.line === 4`, `data.source` ends with `/config`
     (absolute path — ADR-328).
  3. Reconstruct git's two lines from tsgit's `{key, source, line}` and compare to git's
     stderr lines, applying the **path-token normalization** (ADR-328 / conclusion #5): the
     `key` and `line` segments compare verbatim; for the `file '<F>'` token, normalize tsgit's
     absolute `source` to git's repo-relative form (git prints `.git/config` relative to the
     repo) — e.g. strip the `ours` prefix from tsgit's `source` to get `.git/config`, or
     compare on the basename/suffix. Build:
     `error: missing value for '${data.key}'` (verbatim match against git line 1) and
     `fatal: bad config variable '${data.key}' in file '<normalizedF>' at line ${data.line}`
     (match git line 2 after normalizing both files' `file '…'` token).
  4. `git config --list` (or `--get user.name`) on the SAME file SUCCEEDS in both — proves
     requirement 4 (the refusal is at the consumer, not the read). For tsgit, call `configList`
     or `getConfigValue` (as config-interop.test.ts does) and assert it does NOT throw; for git
     `tryRunGit(['config','--file', `${ours}/.git/config`,'--list'])` → `ok === true`.
  5. Absent identity is a DISTINCT outcome (requirement 3 / no regression): write a fixture
     with NO `[user]` section; real git auto-commits (`tryRunGit(...commit...)` → exit 0 with a
     "configured automatically" warning — assert `g2.ok === true`); tsgit `commit` throws
     `AUTHOR_UNCONFIGURED` — assert `.data.code === 'AUTHOR_UNCONFIGURED'`, explicitly NOT
     `'CONFIG_MISSING_VALUE'`. (Documents the pre-existing absent-case divergence without
     regressing it. Use scrubbed env per `runGitEnv()`; signing off — `initBothRepos` already
     sets a clean identity, but here we are deliberately leaving identity unconfigured, so ensure
     `GIT_CONFIG_NOSYSTEM=1` and an isolated `HOME` so the developer's global `[user]` does not
     leak in and make git resolve identity from global. Set `HOME` to a tmpdir and add
     `GIT_CONFIG_NOSYSTEM: '1'` to the env, matching the design's interop-env discipline.)
- Add the `@proves` doc-comment block at the top of the file mirroring config-interop.test.ts
  (surface: commit/config; bucket: cross-tool-interop; unique: valueless identity refusal
  two-line reconstruction + absent-case distinctness; interopSurface: config).

**Property tests — DO NOT APPLY.** This is a command-surface refusal (a fixed name-vs-email-vs-
absent decision), not a parser/round-trip, matcher/aggregator, total-function-over-grammar, or
idempotence/counting invariant. State this in the slice; add no `*.properties.test.ts` sibling.

### TDD steps

RED (failing first):

1. commit unit — valueless `user.name` (email valued): seed via `seed()`, then
   `ctx.fs.writeUtf8(config, '[user]\n\tname\n\temail = a@b.c\n')` + `__resetConfigCacheForTests()`;
   try/catch `commit(ctx,{message:'x'})`; assert `data.code==='CONFIG_MISSING_VALUE'`,
   `data.key==='user.name'`, `data.line===2`, `data.source` ends with `/config`. Each field a
   separate assertion. (Expected RED: commit currently throws `AUTHOR_UNCONFIGURED`.)
2. commit unit — valued name + valueless email: config `'[user]\n\tname = Ada\n\temail\n'`
   → `data.key==='user.email'`, `data.line===3`.
3. commit unit — both valueless, name earlier (`'[user]\n\tname\n\temail\n'`) →
   `user.name`, line 2. (Separate test isolating the ordering guard.)
4. commit unit — both valueless, email earlier (`'[user]\n\temail\n\tname\n'`) →
   `user.email`, line 2. The DISCRIMINATOR test (kills fixed-name-first mutant).
5. commit unit — both absent (no `[user]`) → still `AUTHOR_UNCONFIGURED`: keep/extend the
   existing L221–230 test; add an explicit assertion that the code is NOT `CONFIG_MISSING_VALUE`.
6. commit unit — explicit `opts.author` with a valueless `user.name` in config → SUCCEEDS (no
   refusal): config `'[user]\n\tname\n'`, `commit(ctx,{message:'x', author})` resolves (proves
   the `opts.author === undefined` guard clause; kills a mutant that drops the clause).
7. commit unit — both valued → succeeds (extend/keep L429–455).
8. current-identity unit — mirror cases 1–5 against `resolveCurrentIdentity(ctx)`:
   valueless name → `{key:'user.name',line:2}`; valued name + valueless email →
   `{key:'user.email',line:3}`; both valueless email-earlier → `user.email` line 2
   (discriminator); both absent → `AUTHOR_UNCONFIGURED` (the existing L40–58 test). Seed config
   with `ctx.fs.writeUtf8` (REPLACE, not append — line-number control) + `__resetConfigCacheForTests()`.
9. interop — the five twin assertions above (git refuses 128 + two lines; tsgit
   `CONFIG_MISSING_VALUE` with reconstructed-equal lines after path normalization; `--list`
   succeeds in both; absent → git auto-commits / tsgit `AUTHOR_UNCONFIGURED`, not
   `CONFIG_MISSING_VALUE`).

GREEN: add `internal/identity-config.ts`; wire the guard at `commit.ts` (after `configUser`,
before `resolveAuthor`, gated on `opts.author === undefined && configUser === undefined`) and
in `current-identity.ts` (when `user === undefined`).

REFACTOR: ensure `resolveAuthor`/`resolveCommitter` signatures stay synchronous and unchanged;
the guard is the only new async hop. Confirm no double-throw on the committer path. Keep
`assertUserNotValueless` ≤20 lines, early-return.

### Gate

`npx vitest run test/unit/application/commands/commit.test.ts test/unit/application/commands/internal/current-identity.test.ts test/integration/missing-value-refusal-interop.test.ts && npm run check:types && npx biome check src/application/commands/internal/identity-config.ts src/application/commands/commit.ts src/application/commands/internal/current-identity.ts test/unit/application/commands/commit.test.ts test/unit/application/commands/internal/current-identity.test.ts test/integration/missing-value-refusal-interop.test.ts`

### Commit

`feat(commit): refuse valueless user identity with git's missing-value message`

## Slice 3 — remote-URL refusal (wire the guard at fetch + push)

### Context

Reuse the slice-1 primitive + the slice-2 error factory at the two remote-URL resolution
sites (ADR-329). Call `findFirstValuelessEntry(ctx, 'remote', remoteName, ['url'])` — the
primitive composes the fully-qualified key INCLUDING the subsection (slice 1 step 10
contract), so `found.key` is already `'remote.<remoteName>.url'`. Pass it straight through:
`throw configMissingValue(found.key, found.source, found.line)` — no reconstruction.

> **Decision for the slice agent (do not re-open):** the primitive owns subsection composition
> (it receives `subsection` and returns `<section>.<subsection>.<key>` when present), so the
> consumer passes `found.key` verbatim. This is the contract slice 1 step 10 pinned.

**Wire site 1 — `src/application/commands/fetch.ts`**, `resolveRemoteUrl` (L134–150):

- Current:
  ```ts
  const config = await readConfig(ctx);
  const remote = config.remote?.get(remoteName);
  // An absent OR empty url means the remote is not usably configured.
  if (remote?.url === undefined || remote.url === '') throw remoteNotConfigured(remoteName); // L141
  ```
  A valueless `remote.<n>.url` lands here as `undefined` (ADR-315 D4 erased it). Insert the
  valueless check BEFORE the `remoteNotConfigured` throw, on the same unusable-url cold path:
  ```ts
  if (remote?.url === undefined || remote.url === '') {
    const found = await findFirstValuelessEntry(ctx, 'remote', remoteName, ['url']);
    if (found !== undefined) throw configMissingValue(found.key, found.source, found.line);
    throw remoteNotConfigured(remoteName);
  }
  ```
  Imports: `findFirstValuelessEntry` from `'../primitives/config-read.js'` (the file already
  imports `readConfig` from there at L31 — add to that import); `configMissingValue` from
  `'../../domain/index.js'` (the file imports `remoteNotConfigured` from there at L20 — add to
  that import). Keep `resolveRemoteUrl`'s helper structure ≤20 lines; extract a small
  `valuelessRemoteUrlOr(ctx, remoteName)` helper if the inlined block pushes it over.
  Note the pinned matrix only covers `url`; `pushUrl` is out of scope for fetch (fetch reads
  `url` only).

**Wire site 2 — `src/application/commands/push.ts`**, `resolveRemoteUrl` (L147–157):

- Current:
  ```ts
  const config = await readConfig(ctx);
  const remote = config.remote?.get(remoteName);
  const url = remote?.pushUrl ?? remote?.url;   // L154
  if (url === undefined) throw remoteNotConfigured(remoteName); // L155
  ```
  push resolves `pushUrl ?? url`. The pinned matrix only covers a valueless `url`, so refuse on
  a valueless `url` (the design explicitly scopes this — `pushurl` valueless is not in the
  matrix). Insert before the `remoteNotConfigured` throw:
  ```ts
  const url = remote?.pushUrl ?? remote?.url;
  if (url === undefined) {
    const found = await findFirstValuelessEntry(ctx, 'remote', remoteName, ['url']);
    if (found !== undefined) throw configMissingValue(found.key, found.source, found.line);
    throw remoteNotConfigured(remoteName);
  }
  ```
  Imports: `findFirstValuelessEntry` from `'../primitives/config-read.js'` (push imports
  `readConfig` — confirm/extend that import); `configMissingValue` from `'../../domain/index.js'`
  (push imports `remoteNotConfigured` from there at L23 — add it). The `REMOTE_NAME_RE` guard
  (L148) runs before the config read and is unaffected.
  Note: a valueless `url` PLUS a present `pushUrl` resolves `url` from `pushUrl` and never
  throws — that is correct (git would use pushurl). The guard only fires when BOTH are unusable,
  i.e. the same condition as today's `remoteNotConfigured`.

**Unit test files to extend:**

- `test/unit/application/commands/fetch.test.ts` — `writeOriginConfig` helper at L124–129
  writes `'[remote "origin"]\n  url = https://example.com/r.git\n'` to `${ctx.layout.gitDir}/config`.
  REMOTE_NOT_CONFIGURED test at L168–189 (`describe('Given no remote configured') > … >
  it('Then throws REMOTE_NOT_CONFIGURED')`): `createMemoryContext()` + `seedRepo(ctx, {})` +
  try/catch `fetch(ctx)` → `data.code === 'REMOTE_NOT_CONFIGURED'`. `TsgitError` already
  imported. Add a `writeValuelessUrlConfig` analogue that writes
  `'[remote "origin"]\n\turl\n'` (valueless url at line 2). `fetch(ctx)` defaults remote to
  `origin` (confirm in the file's happy-path tests, which call `fetch(ctx)` after
  `writeOriginConfig`).
- `test/unit/application/commands/push.test.ts` — `writeOriginConfig` at L143–148 (same
  shape). REMOTE_NOT_CONFIGURED test at L247–264. `pushurl`-overrides-url test at L266+ shows
  the pushurl fixture shape. Use the same `'[remote "origin"]\n\turl\n'` valueless fixture;
  `push(ctx)` defaults remote to `origin`. (For push, also keep an absent-url test asserting
  `REMOTE_NOT_CONFIGURED` is unchanged.)

**Interop test — extend `test/integration/missing-value-refusal-interop.test.ts`** (the file
slice 2 created): add a remote-URL group. For each of `git fetch origin` and
`git push origin main`:
- Isolated tmpdir repo; write `<ours>/.git/config` with a valueless `remote.origin.url`
  fixture (full config controlling line numbers, e.g. `[remote "origin"]` at a known line,
  `\turl` valueless on the next). git's CLI cannot emit a valueless url — file write mandatory.
- Real git: `tryRunGit(['-C', ours, 'fetch', 'origin'])` / `['push','origin','main']` (scrubbed
  env, `GIT_CONFIG_NOSYSTEM=1`, isolated HOME) → exit 128, stderr two lines
  `error: missing value for 'remote.origin.url'` + `fatal: bad config variable 'remote.origin.url' in file '<F>' at line <N>`.
- tsgit: open via `openRepository`, run `fetch` / `push`, catch `CONFIG_MISSING_VALUE`; assert
  `data.key === 'remote.origin.url'`, `data.line === <N>`, `data.source` ends with `/config`,
  each individually. Reconstruct both lines from `{key,source,line}` with the same path-token
  normalization as slice 2 and compare to git's stderr.
- Absent url → still `REMOTE_NOT_CONFIGURED` distinctness assertion (write a remote section
  without a `url` line, or no remote section): tsgit throws `REMOTE_NOT_CONFIGURED`, explicitly
  NOT `CONFIG_MISSING_VALUE`. (git fetch/push with absent remote → its own "No such remote" /
  "does not appear to be a git repository" error; the assertion of interest is tsgit's distinct
  refusal, mirroring the absent-identity distinctness from slice 2.)
- push/fetch reach the network only AFTER url resolution, so the refusal fires before any
  transport — no transport stub needed (the failure is at `resolveRemoteUrl`). Confirm the
  facade does not require a live remote to reach the config read (it does not — resolution is
  step 1 of both flows).

**Property tests — DO NOT APPLY** (same rationale as slice 2; state it, add none).

### TDD steps

RED (failing first):

1. fetch unit — valueless `remote.origin.url`: `createMemoryContext()` + `seedRepo(ctx,{})` +
   write `'[remote "origin"]\n\turl\n'` + `__resetConfigCacheForTests()`; try/catch `fetch(ctx)`;
   assert `data.code==='CONFIG_MISSING_VALUE'`, `data.key==='remote.origin.url'`, `data.line===2`,
   `data.source` ends with `/config`. (Expected RED: fetch throws `REMOTE_NOT_CONFIGURED`.)
2. fetch unit — absent url → still `REMOTE_NOT_CONFIGURED` (extend/keep L168–189); assert the
   code is NOT `CONFIG_MISSING_VALUE`.
3. push unit — valueless `remote.origin.url` → `CONFIG_MISSING_VALUE` with
   `key==='remote.origin.url'`, `line===2`, `source` ends with `/config`.
4. push unit — absent url → still `REMOTE_NOT_CONFIGURED` (extend/keep L247–264); NOT
   `CONFIG_MISSING_VALUE`.
5. push unit — valueless `url` but a valued `pushUrl` present → SUCCEEDS past url resolution
   (no refusal): fixture `'[remote "origin"]\n\turl\n\tpushurl = https://example.com/r.git\n'`;
   push resolves the pushurl and proceeds (proves the guard only fires when BOTH are unusable;
   reuse the file's pushurl happy-path harness so the network step is stubbed).
6. interop — fetch valueless url: git refuses 128 + two lines for `remote.origin.url`; tsgit
   `CONFIG_MISSING_VALUE` with reconstructed-equal lines (path normalized); absent →
   `REMOTE_NOT_CONFIGURED` distinct.
7. interop — push valueless url: same twin shape for `git push origin main`.

GREEN: wire the valueless check before `remoteNotConfigured` in both `fetch.ts` and `push.ts`
`resolveRemoteUrl`, passing `found.key` (already the fully-qualified `remote.<name>.url`) straight to `configMissingValue`.

REFACTOR: factor the shared compose-and-throw into a tiny helper if `resolveRemoteUrl` exceeds
20 lines in either file (e.g. a local `throwIfValuelessRemoteUrl(ctx, remoteName)` returning
`void` and throwing, called on the unusable-url branch); keep early returns, no nesting >2.
Confirm `pushUrl`-present + valueless `url` still resolves (no refusal). Confirm `fetch` reads
only `url` (no `pushUrl` involvement).

### Gate

`npx vitest run test/unit/application/commands/fetch.test.ts test/unit/application/commands/push.test.ts test/integration/missing-value-refusal-interop.test.ts && npm run check:types && npx biome check src/application/commands/fetch.ts src/application/commands/push.ts test/unit/application/commands/fetch.test.ts test/unit/application/commands/push.test.ts test/integration/missing-value-refusal-interop.test.ts`

### Commit

`feat(remote): refuse valueless remote url on fetch and push with git's message`
