<!-- cspell:ignore backticked handback pgrep uptime dowild wildmatch casefold ignorecase alnum cntrl xdigit fspathncmp nowildcardlen nodir endswith mustbedir ctype isupper islower toupper tolower strchr uchar STARSTAR pyc pyo pyd pyx abX bX Bb Dd Cc swp sw Thumbs typedoc noncone -->
# Plan — wildmatch-bracket-class

> Source: design doc `docs/design/wildmatch-bracket-class.md` · ADRs 1248, 1249, 1250, 1251, 1252, 1253, 1254, 1255, 1256, 1257, 1258 and DOCTRINE D-1…D-6 (every candidate settled as recommended)
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
- A part should land in ~100 tool calls. More than ~5 RED→GREEN cycles, or more than 6
  files in its `### Context` block, is two parts. What counts is a backticked path:
  backtick the files the part CREATES or EDITS, and write read-only reference paths in
  plain text.

## Planning facts (read once; every part relies on them)

- **Implementers have no MCP tools.** Every symbol below is named with its file and current
  signature; use Read/Grep/Edit.
- **One RED per function, run it red before writing its code.** Never batch REDs across
  functions, never write GREEN first. A row that already passes at its step is a GUARD.
- **Test shape** (CLAUDE.md): `describe('Given …')` > `describe('When …')` > `it('Then …')`,
  AAA comments, the system under test is `sut`. Under an ignorecase twin
  `describe.each(['false', 'true'])('Given core.ignorecase is %s')` the rows are When/Then only
  (lesson 045). Error/abort rows assert the verdict for the path spelled like the pattern.
- **No suppression directives.** The existing `// Stryker disable next-line` lines in
  src/domain/refs/ref-glob.ts move verbatim with the code they guard (Part 2) or disappear with
  it; never add a new one. A new equivalent mutant gets an inline prose comment with its proof,
  or the redundant guard is removed.
- **No provenance refs** (ADR/part/backlog numbers, matrix IDs such as "C51") in src or test
  code. Test titles describe the behaviour; matrix IDs live only in this plan.
- **vitest binary.** Use `./node_modules/.bin/vitest`; the rtk hook rewrites `npx vitest …` into a
  whole-suite run. Any command whose output may exceed ~100 lines writes to a scratch file; read
  back only the lines that matter.
- **Never write git state in the worktree.** Interop tests build repos under `mkdtemp`
  (os.tmpdir); probes run in a `mktemp -d` throwaway.
- **Size caps.** Parts never touch `.size-limit.json`. A part whose only red is a size cap
  reports it in its handback instead of contorting code (the session raises it after review).
- **Public surface.** Every new export in this plan is **internal**: `src/domain/glob/wildmatch.ts`
  is imported by module path, never added to src/domain/index.ts or any barrel. The one public
  drift is `parseGitignore`/`tokenizeIgnoreLine`/`IgnoreRule`/`TokenizedIgnoreLine`, which the
  `@scolladon/tsgit/domain` entry exports and reports/api.json records: Part 6 changes the
  signature of `parseGitignore` (an optional argument) and two doc comments, so Part 6 runs
  `npm run docs:json` and commits reports/api.json. `IsIgnoredMatchSource.pattern` keeps its type
  and its doc comment ("Raw pattern text") — the value becomes what the comment already says,
  so no api.json drift there. `parseGitattributes`, `AttributeRule`, `compileGlob`,
  `CompileGlobOptions` and the ref-glob exports are absent from api.json (internal).
- **Breaking mark.** None (ADR-1257). Part commits use plain `fix`/`perf`/`refactor`/`test`/`docs`.

### git's rule, condensed (design §"dowild — the ordered list"; identical in git 2.56.0/2.56.1)

Top level, per pattern byte `p_ch` with text byte `t_ch`:
T0 text exhausted and `p_ch != '*'` → no match · T1 `WM_CASEFOLD`: lower `t_ch` and `p_ch` read at
the loop top only (never the byte after `\`, never a set member) · T2 `\x` → literal `x`, not
lowered; a trailing lone `\` matches nothing · T3 default `t_ch == p_ch` · T4 `?` one byte, not
`/` under WM_PATHNAME · T5a whole-component `**` then `/` → zero dirs or a run crossing `/` ·
T5b whole-component `**` at end → any run · T5c whole-component `**` then `\/` → a run crossing
`/`, no zero-dir shortcut · T5d any other `*` run → run of non-`/` bytes · T6 `[` → B-list, never
`/` under WM_PATHNAME · T7 pattern end → text exhausted.

Inside `[`: B1 first byte `!`/`^` negates (elsewhere a plain member) · B2 the first member may be
`]` · B3 pattern ends before the closing `]` → the WHOLE pattern matches nothing · B4 `\x` literal
`x`, never lowered, seeds a range; `\` at the end → B3 · B5 `-` with a previous member and a next
byte that is not `]` → range `prev..hi` (`hi` may be `\x`); under fold also tries `toupper(t_ch)`
when `t_ch` is lower; resets the seed · B6a `[:` with no `]` after → B3 · B6b `[:` whose first
following `]` has no `:` right before it (or `[:]`) → `[` is a plain member, scanning resumes
right after that `[` · B6c `[:name:]` with one of alnum alpha blank cntrl digit graph lower print
punct space upper xdigit → git's ASCII `sane_ctype` test; `[:upper:]` also admits lower under
fold; resets the seed · B6d any other name (`foo`, empty, `DIGIT`) → B3 · B7 any other byte →
plain member compared with the (lowered) `t_ch`, never lowered itself · B8 `]` after the first
member closes · B9 verdict = matched XOR negated; under WM_PATHNAME `/` never matches. Class
tables: `space` = SP HT LF CR (not VT/FF); `punct` holds `_` and `~`; `cntrl` = 0x00–0x1F and 0x7F.

### Probe and fixture traps (interop parts)

- `git check-ignore -- ':x'` parses a leading `:` as pathspec magic: a path starting with `:` is
  an **attributes-only** path.
- `git check-ignore` reports a path under an ignored directory as ignored, `isIgnored` does not
  walk ancestors (a deferred gap): never use a path one of whose ancestor directories the pattern
  matches.
- `.` / `..` name directories: never a path.
- Control-character paths (HT, VT, FF, 0x01) only as `check-attr`/`check-ignore` arguments,
  never as files.
- APFS cannot hold two case variants of one name: sparse rows never need both on disk.
- Set `core.ignorecase` explicitly (`git config core.ignorecase <v>`) in **every** repo before
  either tool reads it — macOS `git init` writes `true`, Linux writes `false`.
- A row holding any path git for Windows cannot pass or hold (`\ * ? : " < > |`, a control
  character, a trailing `.` or space) skips on win32 through one predicate
  `isWindowsHostilePath(path)` applied to the row's paths (`it.skipIf`).

## Decision candidates

Choices the design and ADRs leave open. The plan follows each recommendation; the session
ratifies or overrides before Part 1 spawns.

| # | Choice | Alternatives (≤3) | Recommendation | Why |
|---|---|---|---|---|
| PC-1 | When the ignore-match bench lands | A: Part 1, before any matcher change · B: with the perf rows after the consumers · C: with the `compileGlob` rebuild | A | `npm run bench:ab` needs the bench file in both refs, so main cannot be the base of ADR-1255's "≤ 10 % over main" gate. A bench commit whose matcher equals main's is that base. B and C leave no comparable base |
| PC-2 | What the bench measures | A: domain level — `parseGitignore` once, then `matchInStack` over 20 200 in-memory entries · B: `isIgnored` over a disk fixture · C: `status` over a fixture repo | A | ADR-1255 gates the matcher. A excludes fs and config noise and needs no fixture generator. B and C measure I/O the change does not touch |
| PC-3 | Where the `compileGlob` module header is rewritten | A: Part 5, which rewrites the module · B: the docs part, as the brief lists | A | The header says "`[…]` and `\` are matched verbatim". It is false from Part 5 on. The docs part only checks it |
| PC-4 | Interop suite shape | A: one repo per (pattern, twin), batched `check-ignore -z` / `check-attr -z` over all its paths · B: one repo per (pattern, path), as in the double-star suite | A | About 70 patterns × 2 twins × up to 7 paths. A spawns ~4 git processes per pattern and twin, B ~3 per path. Same verdicts, and `-z` survives control-character paths |
| PC-5 | Windows-hostile interop rows | A: same file, rows skipped on win32 by a predicate · B: a posix-only sibling file | A | `npm run validate` skips the posix-integration project (known), so B would never run locally |
| PC-6 | B6a guard in `parseClassAttempt` once the `]` index is precomputed | A: remove it (the B6b/B6d path already aborts) · B: keep it with an inline equivalent-mutant proof | A | The repo's equivalent-mutant policy: remove a redundant guard rather than annotate it. Part 3's GUARD rows pin the verdict |
| PC-7 | `caseFold` argument of the internal loaders | A: optional `{ readonly caseFold?: boolean } = {}`, as `compileSparseRule` and `parseNonCone` take it · B: required | A | One convention across the seam, and the existing loader suites keep their two-argument calls. The evaluator and provider always pass it |

## Part 1 — Ignore-match bench (test-infra, no `src/` delta; R12, ADR-1255)

### Context

Files this part creates:
- `test/bench/ignore-match.bench.ts` (new)

Why first (PC-1): Part 5 runs `npm run bench:ab -- <this part's sha> HEAD 3 ignore-match.bench.ts`.
`bench:ab` (tooling/bench-ab.ts) needs the bench file in both refs, and at this commit the matcher
is still main's.

Model (read-only): test/bench/status-sparse.bench.ts. `benchScenario(given, whenThen, build)`
comes from test/bench/support/bench-dsl.ts. `build` returns `{ sut }`; `baseline` is optional and
omitted here (tsgit-only). There is no fixture and no teardown: everything is in memory. Each
scenario's key is `<given>, <whenThen> > tsgit`. Keep the three titles stable, because `bench:ab`
matches rows by key across refs. The `bench` key is not registered in docs/perf/hot-paths.json:
the CI hot set stays unchanged, as for status-sparse.

Imports (from src):
- `parseGitignore(text: string): IgnoreRuleset` and `matchInStack(stack: ReadonlyArray<IgnoreLevel>, path: FilePath, isDir: boolean): MatchResult`, both from src/domain/ignore/index.js;
- the `IgnoreLevel` type `{ basedir: FilePath | ''; rules: IgnoreRuleset; kind? }`;
- the `FilePath` type from src/domain/objects/object-id.js.

Shape (all module-level constants, built by pure functions):
- ENTRIES: 200 directories, each an `isDir: true` entry, plus 100 files per directory (20 000
  files, `isDir: false`). Directory d is "pkg(d mod 20)/mod(d)". File f in it is "file(f).(ext)",
  with ext cycling over ts, js, log, pyc, o, md, json, txt, tmp, cache by `(d + f) mod 10`.
- RULES_PLAIN: exactly the 40 lines in TDD step 1. Every one is class-free, and main is faithful
  on all of them.
- RULES_CLASS: the 40 lines of step 1, with 12 lines replaced by the class lines of step 1.
- RULES_FLOOR: RULES_CLASS with every bracket expression replaced by `?`. Use
  `line.replace(/\[[^\]]+\]/g, '?')`; no class line holds `]` as a member. It has the same token
  count, and every set becomes a one-byte test.
- One level per rule set: `{ basedir: '', rules: parseGitignore(lines.join('\n')) }`, parsed
  once per scenario. Parsing is outside `sut`.
- `sut` loops over ENTRIES and calls `matchInStack([level], path, isDir)`. Keep each verdict in a
  local counter, so the work cannot be dropped as dead.

### TDD steps

1. Write the bench. A bench is not a RED/GREEN unit: its check is that it runs. Rules:
   - RULES_PLAIN (40):
     `*.log` `*.tmp` `*.swp` `*.bak` `*.orig` `*.class` `*.o` `*.so` `*.dll` `*.exe` `*.pyc`
     `*.pyo` `*.cache` `*.map` `*.lock` `node_modules/` `dist/` `build/` `coverage/` `.env`
     `.DS_Store` `Thumbs.db` `/out` `/tmp` `/vendor` `target/` `docs/_build/` `pkg1*/gen/`
     `mod1*/` `file9*.md` `**/generated` `**/snapshots/**` `src/**/*.gen.ts`
     `pkg1/**/file1?.json` `pkg2/mod2?/` `*-debug.log` `*~` `.idea/` `.vscode/` `logs/**`.
   - Lines RULES_CLASS replaces, in order:
     `*.pyc`→`*.py[cod]`, `*.o`→`*.[oa]`, `*.swp`→`*.s[wv]p`, `build/`→`build[0-9]/`,
     `dist/`→`dist[0-9]/`, `file9*.md`→`file[0-9][0-9].md`, `mod1*/`→`mod[13579]*/`,
     `*.cache`→`*.[Cc]ache`, `pkg1*/gen/`→`pkg[!0]/gen/`, `*.bak`→`*.[bB]ak`,
     `*.lock`→`*.loc[a-k]`, `Thumbs.db`→`Thumbs.d[ab]`. Every fragment a set splits off is a dictionary word or shorter than four letters, so `check:spelling` passes without any ignore comment.
2. Name the three scenarios:
   - `Given 20000 walked paths and 40 ignore rules without bracket sets`;
   - `Given 20000 walked paths and 40 ignore rules with bracket sets`;
   - `Given 20000 walked paths and 40 ignore rules whose bracket sets are one-byte wildcards`.
   Each takes the whenThen `When every path is matched, Then measure tsgit alone`.
3. GUARD: run `./node_modules/.bin/vitest bench --run --config vitest.bench.config.ts test/bench/ignore-match.bench.ts > <scratch>/bench.txt 2>&1`. It completes and all three rows report a mean; read back only the summary rows.
4. REFACTOR: keep each function under 20 lines, and name the magic numbers (`DIRECTORY_COUNT`, `FILES_PER_DIRECTORY`).

### Gate

`./node_modules/.bin/vitest bench --run --config vitest.bench.config.ts test/bench/ignore-match.bench.ts && npm run check:types && ./node_modules/.bin/biome check test/bench/ignore-match.bench.ts && npm run check:spelling`

### Commit

`test(bench): measure ignore matching with and without bracket sets`

## Part 2 — Move the wildmatch core out of ref-glob (behaviour-preserving; ADR-1248)

### Context

Files this part edits or creates:
- `src/domain/glob/wildmatch.ts` (new, internal: imported by module path, never barrelled)
- `src/domain/refs/ref-glob.ts`
- `test/unit/domain/glob/wildmatch.test.ts` (new, the eponymous suite that a narrowed Stryker
  bucket runs for wildmatch.ts)

This is a pure move. src/domain/refs/ref-glob.ts today (387 lines) holds the whole of git's
`dowild` over UTF-8 bytes:
- the token type: `RefGlobToken` = `star` | `segment` | `dirs` | `match { test: ByteTest }`;
- the bracket grammar: `BracketAtom`, `CLASS_TESTS`, `bracketTest`, `MemberResult`,
  `parseClassAttempt`, `parseMember`, `parseBracket`;
- the dialects: `Dialect`, `REF_DIALECT`, `PATHNAME_DIALECT`, `isWholeSegmentRun`,
  `pathnameStarRun`;
- the tokenizer: `scanStarRun`, `scanEscape`, `scanToken`,
  `tokenize(bytes: Uint8Array, dialect: Dialect): ReadonlyArray<RefGlobToken> | undefined`;
- the DP: `stepStar`, `stepSegment`, `stepDirs`, `stepToken`, `stepMatch`,
  `matchTokens(tokens, text: Uint8Array): boolean` (two swapping rows with an early exit);
- the wrappers: `compileBytesWith(pattern, dialect)` and `compileWith(pattern, dialect)`.

Its exports, which stay with **identical signatures and behaviour**:
- `compileRefGlobBytes(pattern: string): (text: Uint8Array) => boolean`
- `compileRefGlob(pattern: string): (ref: string) => boolean`
- `compilePathnameGlob(pattern: string): (text: string) => boolean`
- `matchRefGlob(pattern: string, ref: string): boolean`

Importers (unchanged): src/domain/pathspec/wildcard.ts, src/domain/reflog/expire-policy.ts,
src/domain/describe/match.ts, src/domain/name-rev/ref-pattern.ts and
src/application/commands/internal/merge-message.ts.

Target:
- wildmatch.ts takes everything above except the four exports and the two wrappers. It exports
  only what ref-glob.ts imports:
  - `interface WildmatchFlags { readonly pathname: boolean }` (`caseFold` joins in Part 4);
  - `type WildmatchToken` (the renamed `RefGlobToken`);
  - `tokenizeWildmatch(pattern: Uint8Array, flags: WildmatchFlags): ReadonlyArray<WildmatchToken> | undefined`,
    which picks `PATHNAME_DIALECT` when `flags.pathname` and `REF_DIALECT` otherwise
    (`undefined` = git would abort, so the pattern matches nothing);
  - `matchWildmatch(tokens: ReadonlyArray<WildmatchToken>, text: Uint8Array): boolean` (today's
    `matchTokens`).
  Its only import is `decode` from ../objects/encoding.js. Dependency direction is refs → glob;
  nothing in glob imports outward.
- ref-glob.ts keeps its module doc, trimmed to the two dialects with a pointer to the core, plus
  `compileBytesWith`/`compileWith` rewritten over `tokenizeWildmatch(encode(pattern), flags)` /
  `matchWildmatch`, and the four exports.
- Move every comment verbatim with its code: the inline "Equivalent mutant" notes and the
  existing `// Stryker disable next-line` lines. They are re-checked in Parts 3–4.

Test models (read-only): test/unit/domain/refs/ref-glob.test.ts and
test/unit/domain/refs/ref-glob.properties.test.ts exercise only the four exports and must pass
**unchanged**. The new suite builds a helper `const wildmatch = (pattern: string, text: string, flags: WildmatchFlags) => …`
over `encode` (src/domain/objects/encoding.ts). The helper returns `false` when
`tokenizeWildmatch` returns `undefined`; otherwise it returns
`matchWildmatch(tokens, encode(text))`.

### TDD steps

1. GUARD `wildmatch.test.ts`, under `Given the flags-0 dialect` and `Given the WM_PATHNAME dialect`. Each row passes because the code moved unchanged:
   - flags 0: `a*b` vs `a/x/b` → true; `?` vs `/` → true;
   - pathname: `a*b` vs `a/x/b` → false; `?` vs `/` → false; `**/b` vs `b` → true and vs `x/y/b` → true; `**\/b` vs `b` → false and vs `x/b` → true;
   - escapes and sets: `\*` vs `*` → true and vs `x` → false; `[a-c]` vs `b` → true and vs `d` → false;
   - abort, `tokenizeWildmatch` returns `undefined` for: `a\`, `[a`, `[[:foo:]]`, `[[:digit:]`.
2. Do the move (GREEN is "still green"): `./node_modules/.bin/vitest run test/unit/domain/refs` stays green with zero test edits.
3. REFACTOR: functions under 20 lines (`parseBracket` is the long one; leave its shape for Part 3), and run `npm run check:test-pyramid`.

### Gate

`./node_modules/.bin/vitest run test/unit/domain/glob/wildmatch.test.ts test/unit/domain/refs/ref-glob.test.ts test/unit/domain/refs/ref-glob.properties.test.ts test/unit/domain/pathspec/wildcard.test.ts test/unit/domain/describe/match.test.ts test/unit/domain/name-rev/ref-pattern.test.ts test/unit/domain/reflog/expire-policy.test.ts && npm run check:types && ./node_modules/.bin/biome check src/domain/glob/wildmatch.ts src/domain/refs/ref-glob.ts test/unit/domain/glob/wildmatch.test.ts && npm run check:spelling && npm run check:test-pyramid`

### Commit

`refactor(glob): move the wildmatch core out of ref-glob into a shared module`

## Part 3 — Linear `[:` lookahead, byte tokens and 256-entry set tables (R5, R3 core, ADR-1254)

### Context

Files this part edits:
- `src/domain/glob/wildmatch.ts`
- `test/unit/domain/glob/wildmatch.test.ts`
- `test/perf/domain/refs/ref-glob.perf.test.ts`

Current code (after Part 2):
- `parseClassAttempt(bytes, i)` scans `j` from `i + 2` to the next `]`: O(n) per `[:`, so
  O(n²) per pattern. On main, `'[' + '[:'.repeat(n) + 'x]'` compiles in 21/70/281 ms for
  n = 5k/10k/20k, a factor of 4 per doubling. At n = 100 000 that is several seconds.
- Tokens are `match { test: ByteTest }` closures. `bracketTest(negated, atoms)` returns a closure
  that runs `atoms.some(…)` per text byte, and `dialect.single` wraps it to refuse `/` under
  WM_PATHNAME.

Target (design §2 "Token model", ADR-1254):
- `WildmatchToken` = `star` | `segment` | `dirs` | `{ kind: 'byte'; value: number }` |
  `{ kind: 'set'; table: Uint8Array }`. `stepMatch` splits into `stepByte`
  (`text[j] === value`) and `stepSet` (`table[text[j]] === 1`). Each keeps the
  `next[j + 1] === 1` gate and the existing loop-bound note.
- `?` is a set token: all 256 entries 1, except `'/'` under pathname. Build the two tables once,
  as module constants, with a pure builder; never write them after.
- A bracket expression compiles to one table built by
  `buildSetTable(atoms: ReadonlyArray<BracketAtom>, negated: boolean, flags: WildmatchFlags): Uint8Array`:
  `table[x] = (anyAtomAdmits(x) !== negated) && !(flags.pathname && x === SLASH)` for x in
  0..255. Its cost is O(atoms + 256) per set, at compile time. `BracketAtom` stays the parse
  result (`byte` | `range` | `class`). `bracketTest` and `Dialect.single` disappear.
- Linear lookahead: `tokenizeWildmatch` computes `closeAfter` once per pattern, an `Int32Array`
  of length n + 1 where `closeAfter[i]` is the index of the first `]` at or after `i`, and `n`
  means "none". Fill it backwards in one pass. Pass it down to `parseBracket`, `parseMember` and
  `parseClassAttempt`. `parseClassAttempt` reads `j = closeAfter[min(i + 2, n)]`.
  - B6a (`j === n`): abort, as today.
  - B6b (`j - i - 3 < 0` or `bytes[j - 1] !== ':'`): plain `[` member, resume at `i + 1`, as today.
  - B6c / B6d: decode the name and look it up, as today.
  PC-6: delete the separate `if (j >= bytes.length) return undefined` guard and its two
  equivalent-mutant comments (including the `Stryker disable` line above it). With
  `j === n`, either `bytes[n - 1] === ':'` and the empty or unknown name aborts, or the `[`
  becomes a plain member and the unterminated set aborts in `parseBracket`. The verdict is the
  same; GUARD rows C32 and C51 pin it.
- Re-check each moved equivalent-mutant note against the new code. A note whose code is gone
  goes with it. The range low-bound note in `bracketTest` moves to `buildSetTable` and stays
  true until Part 4.

Perf model (read-only): test/perf/domain/pathspec/compile-glob.perf.test.ts. It runs in its own
config, vitest.perf.config.ts (`npm run test:perf`), never in the unit project.

### TDD steps

1. RED perf, test/perf/domain/refs/ref-glob.perf.test.ts: `Given a bracket set holding 100000 class openers` > `When compiled` > `Then it compiles in under 1000 ms and matches its members`.
   - Arrange `const pattern = '[' + '[:'.repeat(100_000) + 'x]'`. Act: time `compileRefGlob(pattern)`.
   - Assert `elapsedMs < 1000`, `sut('x') === true`, `sut(':') === true`, `sut('y') === false`.
   - It fails on the elapsed time: the O(n²) scan takes seconds. Run it with `./node_modules/.bin/vitest run --config vitest.perf.config.ts test/perf/domain/refs/ref-glob.perf.test.ts`.
2. GREEN: `closeAfter`, threaded through the bracket parser.
3. GUARD `wildmatch.test.ts`, one `describe` per B-branch under `Given the WM_PATHNAME dialect`. They pass, because only the representation changes:
   - B1: C1 `[!a]` (`a`→false, `b`→true, `!`→true), C2 `[^a]` (`^`→true), C3 `[a!]` (`!`→true, `b`→false);
   - B2: C5 `[]a]` (`]`→true, `b`→false), C6 `[!]a]` (`]`→false, `b`→true), C9 `[]-a]` (`]` `^` `a`→true; `-` `b`→false);
   - B3: C24 `[a\]`, C29 `[]`, C30 `[!]`, C31 `*[` → `tokenizeWildmatch` returns `undefined`;
   - B4: C18 `[\]]` (`]`→true, `\`→false), C21 `[a-\c]` (`b`→true, `\`→false);
   - B5: C11 `[c-a]` (`c`→true, `a` `b`→false), C14 `[a-c-e]` (`b` `-` `e`→true, `d`→false), C15 `x[--0]` (`x.` `x-`→true, `x,` `x1`→false);
   - B6a: C32 `[[:digit:]` → `undefined`;
   - B6b: C51 `[[:alpha]` (`[` `a` `p` `:`→true, `x`→false), C53 `[[:]]` (`[]` `:]`→true, `[` `]`→false), and the lookahead row `[[:a]b:]]` (`ab:]]` `[b:]]` `:b:]]`→true; `xb:]]` `b`→false);
   - B6c: C40 `[[:space:]]` (SP, HT→true; VT, FF→false), C42 `[[:punct:]]` (`_` `~`→true), C46 `[[:cntrl:]]` (0x01, 0x7F→true, `a`→false), C49 `[[:digit:]-z]` (`5` `-` `z`→true, `a`→false), C50 `[a-[:digit:]]` (`a]` `d]`→true, `5` `5]`→false);
   - B6d: C33 `[[:foo:]]`, C34 `[[::]]`, C35 `[[:DIGIT:]]` → `undefined`;
   - B9: C61 `a[/]b` vs `a/b`→false, C62 `x/a[!b]c` vs `x/a/c`→false. Under flags 0, `[/]` vs `/` → true and `?` vs `/` → true;
   - Bytes: Y1 `[é]` vs `é`→false, Y3 `[!a][!a]` vs `é`→true, Q3 `??` vs `é`→true, Q2 `?` vs `é`→false.
4. GREEN (representation): byte and set tokens, `buildSetTable`, the `?` tables, `stepByte`/`stepSet`. Steps 1–3 stay green.
5. REFACTOR: functions under 20 lines; `parseBracket` keeps one loop. Run `npm run check:test-pyramid`.

### Gate

`./node_modules/.bin/vitest run test/unit/domain/glob/wildmatch.test.ts test/unit/domain/refs/ref-glob.test.ts test/unit/domain/refs/ref-glob.properties.test.ts test/unit/domain/pathspec/wildcard.test.ts test/unit/domain/describe/match.test.ts test/unit/domain/name-rev/ref-pattern.test.ts test/unit/domain/reflog/expire-policy.test.ts && ./node_modules/.bin/vitest run --config vitest.perf.config.ts test/perf/domain/refs/ref-glob.perf.test.ts && npm run check:types && ./node_modules/.bin/biome check src/domain/glob/wildmatch.ts test/unit/domain/glob/wildmatch.test.ts test/perf/domain/refs/ref-glob.perf.test.ts && npm run check:spelling && npm run check:test-pyramid`

### Commit

`perf(glob): compile bracket sets to byte tables with a linear class lookahead`

## Part 4 — `WM_CASEFOLD` in the core (R2, ADR-1251)

### Context

Files this part edits:
- `src/domain/glob/wildmatch.ts`
- `src/domain/refs/ref-glob.ts` (passes `caseFold: false` in both flag literals; behaviour unchanged)
  — it is listed again after Part 2 only because the new required flag breaks its two flag
  literals at the type level; merging Parts 2 and 4 would put a behaviour change in the pure move
- `test/unit/domain/glob/wildmatch.test.ts`

Target (design §3):
- `WildmatchFlags` gains `readonly caseFold: boolean`. Contract, in the doc comment of
  `matchWildmatch`: under `caseFold` the caller hands in text already ASCII-lowered. compileGlob
  folds the path string once, with `asciiLower` (src/domain/pretty/ascii.ts), because its fast
  paths need the folded text too.
- Compile-time rules under `caseFold`:
  - a plain (T3) byte token is lowered when it is `A`–`Z` (T1);
  - an escaped byte (`\x`, T2) is **not** lowered;
  - a set member (B4/B7) is **not** lowered;
  - a range admits `x` when `inRange(lo, hi, x) || (isLower(x) && inRange(lo, hi, upper(x)))`;
  - `[:upper:]` admits `isLower(x)` too;
  - negation applies after all of these, and the pathname `/` exclusion last.
- Use **one** `inRange(lo, hi, byte)` helper for both range arms. F12 `[A-A]` vs `a` then kills
  the low-bound mutant, so delete the range low-bound equivalent-mutant note. Re-check each
  remaining moved note against the fold rows; keep only those that still hold.
- In the test helper, lower `text` with `asciiLower` before encoding when `flags.caseFold`.

### TDD steps

1. RED `wildmatch.test.ts`, `Given caseFold` > `When a plain pattern letter differs in case`: L1 `A` vs `a`→true, L2 `a*B` vs `axb`→true. They fail because the literal `A`/`B` byte is compared without lowering.
2. GREEN: lower plain byte tokens.
3. RED, same Given > `When a range or a class meets a lowered letter`: F3 `[A-Z]` vs `a`→true, F5 `[X-c]` vs `Y`→true and vs `y`→true (and `d`→false), F12 `[A-A]` vs `a`→true, F8 `[[:upper:]]` vs `a`→true. They fail because the table holds `A`–`Z` only, while the folded text is lower.
4. GREEN: range retry and `[:upper:]` under fold.
5. GUARD, same Given (each passes because the helper lowers the text and nothing in the pattern is lowered):
   - E12 `\a` vs `A`→true; E13 `\A` vs `A`→false and vs `a`→false;
   - F1 `[A]` vs `a`→false and vs `A`→false; F2 `[a]` vs `A`→true; F4 `[a-z]` vs `A`→true;
   - F6 `[!A]` vs `A`→true; F7 `[!b]` vs `B`→false; F9 `[[:lower:]]` vs `A`→true;
   - F10 `x[A]` vs `xA`→false; F11 `*.PY[CO]` vs `m.PYC`→false and vs `m.pyc`→false.
   Under `caseFold: false`, F1 `[A]` vs `A`→true and F3 `[A-Z]` vs `a`→false.
6. REFACTOR, then run `npm run check:test-pyramid`.

### Gate

`./node_modules/.bin/vitest run test/unit/domain/glob/wildmatch.test.ts test/unit/domain/refs/ref-glob.test.ts test/unit/domain/refs/ref-glob.properties.test.ts test/unit/domain/pathspec/wildcard.test.ts test/unit/domain/describe/match.test.ts test/unit/domain/name-rev/ref-pattern.test.ts test/unit/domain/reflog/expire-policy.test.ts && npm run check:types && ./node_modules/.bin/biome check src/domain/glob/wildmatch.ts src/domain/refs/ref-glob.ts test/unit/domain/glob/wildmatch.test.ts && npm run check:spelling && npm run check:test-pyramid`

### Commit

`fix(glob): fold case in the wildmatch core as WM_CASEFOLD does`

## Part 5 — `compileGlob` on the core: anchoring, git's three fast paths, bytes, abort (R1–R5, R10, ADRs 1252/1253)

### Context

Files this part edits:
- `src/domain/pathspec/compile-glob.ts` (rewritten, including its module header — PC-3)
- `src/domain/glob/wildmatch.ts` (export `LEADING_DIRECTORIES`, the `dirs` token)
- `test/unit/domain/pathspec/compile-glob.test.ts`
- `test/perf/domain/pathspec/compile-glob.perf.test.ts`

Current code: `compileGlob(pattern: string, options: CompileGlobOptions): GlobMatcher`, with
`CompileGlobOptions { readonly anchored: boolean; readonly caseFold?: boolean }` and
`GlobMatcher { test(path: string): boolean }`. Both interfaces keep their exact shape, and
consumers are untouched. Delete the internals: `GlobToken`, `PREFIX_TOKEN`, `endOfStarRun`,
`isWholeComponent`, `scanPathnameStar`, `scanToken`, `tokenize`, `stepLiteral`, `stepSingle`,
`stepStar`, `stepStarStar`, `stepStarSlash`, `stepToken`, `baseLayer`, `matchTokens`,
`literalPrefixOf`, `carriesPrefix`, `matchesLiteral`, `matcherFor`. Their `Stryker disable`
lines go with them.

Target (design §5):
```ts
export const compileGlob = (pattern: string, options: CompileGlobOptions): GlobMatcher => {
  const caseFold = options.caseFold === true;
  const tokens = tokenizeWildmatch(encode(pattern), { pathname: true, caseFold });
  if (tokens === undefined) return NEVER;            // abort beats every fast path (R4)
  const program = options.anchored ? tokens : [LEADING_DIRECTORIES, ...tokens];
  const shortcut = shortcutOf(pattern, options.anchored, caseFold);
  return { test: (path) => { const text = caseFold ? asciiLower(path) : path;
    return shortcut(text) ?? matchWildmatch(program, encodeEscaped(text)); } };
};
```
- `simpleLength(pattern)`: index of the first `*`, `?`, `[` or `\`, or the length when there
  is none (git's `simple_length`).
- `shortcutOf` returns `(text) => boolean | undefined`, where `undefined` means "run the DP".
  It is decided once, on the pattern **text**; `lit`, `rest` and the prefix are folded with
  `asciiLower` under `caseFold`:
  1. pure literal (`simpleLength === length`): final, `text === lit || (!anchored && text.endsWith('/' + lit))`;
  2. ENDSWITH (`!anchored && pattern[0] === '*'` and `simpleLength(pattern.slice(1)) === length - 1`): final, `text.endsWith(rest)` with `rest = pattern.slice(1)`;
  3. literal prefix (`simpleLength > 0`): `false` unless `text.startsWith(prefix) || (!anchored && text.includes('/' + prefix))`, else `undefined`;
  4. otherwise always `undefined`.
- Each guard of ENDSWITH (unanchored, leading `*`, no special in the rest) gets an isolated row.
- `NEVER` is a module-level `{ test: () => false }`.
- Imports: `encode` and `encodeEscaped` from ../objects/encoding.js, `asciiLower` from
  ../pretty/ascii.js, and `tokenizeWildmatch`/`matchWildmatch`/`LEADING_DIRECTORIES` from
  ../glob/wildmatch.js.
- New module header: the gitignore-family dialect is wildmatch with WM_PATHNAME. It reads `[…]`
  classes and `\` escapes, matches `?` and sets byte-wise, folds as WM_CASEFOLD, and runs git's
  three fast paths. Keep the existing pointer lines verbatim, and add no new ADR or design
  reference (no provenance refs in src).

Existing tests that FLIP in compile-glob.test.ts (edit them in this part):
- The describe "Given a `[abc]` pattern" > "When compiled in v1" > "Then the brackets are
  escaped (literal match — character classes not supported)". Rewrite it as "Given a [abc]
  pattern" > "When compiled" > "Then it is a bracket set": `a`→true, `[abc]`→false.
- `Given a pattern led by a literal run` > row `['a\\*', true, 'a\\x', true]`. The expectation
  becomes false; add the row `['a\\*', true, 'a*', true]`.
- `equivalence with the original regex compiler` > `Given a literal-led pattern and a path over the same small alphabet`.
  Drop `'\\'` from `arbLead` and `arbText`: the regex oracle reads `\` literally. The first
  property (alphabet `a b / * ? .`) stays as is, a GUARD.

Rows that stay GUARD: `Given caseFold` (`B/f`, `*.TXT`, `?/F`, `src`, `É` vs `é` false), every
`**` row, and `Given a pattern led by a literal run` except its flipped `a\*` row.

Other suites that call `compileGlob` and must stay green (grep found no `[`/`\`/case-sensitive
rows in them): test/unit/domain/ignore, test/unit/domain/attributes, test/unit/domain/sparse,
test/integration/glob-double-star-interop.test.ts and
test/integration/sparse-checkout-ignorecase-interop.test.ts. An unexplained red in one of them
is a blocker, not a fix.

Bench gate (ADR-1255; PC-1). Commit first, then measure.
- Check the machine is quiet: `uptime`, and no foreign `stryker`/`vitest` process (`pgrep -fl stryker`).
- Run `npm run bench:ab -- <Part 1 sha> HEAD 3 ignore-match.bench.ts > <scratch>/ab.txt 2>&1`
  and read the comparison rows.
- Gate 1: the "without bracket sets" row is ≤ 10 % over the Part 1 base.
- Gate 2: on the HEAD side, the "with bracket sets" median is ≤ 1.25 × the "one-byte wildcards"
  median.
- A failure of either gate is a blocker handback `{ unit: Part 5, reason: <gate, numbers>, options }`.
  The options are ADR-1252's fallback (a bytes entry on `GlobMatcher`, so `lastMatch`,
  `ruleMatches` and `verdictOf` encode once per path), or a targeted fix with its profile.

### TDD steps

Rows give pattern, anchored (consumers anchor exactly the patterns holding `/`), caseFold, path → expected. Steps 1–5 all target `compileGlob` and each fails against the current code for the reason given; write and run each red before step 6.

1. RED `Given a bracket expression`:
   - C58 `[ab]` unanchored: `a` `b` `d/a`→true, `c` `[ab]`→false;
   - the flipped `[abc]` row;
   - C56 `*.py[cod]` unanchored: `m.pyc` `d/m.pyc`→true, `m.py[cod]`→false;
   - C60 `[ab]c` unanchored vs `x/ac`→true.
   They fail because the current code matches `[` literally.
2. RED `Given a pattern git aborts on` > `When tested against the path spelled like it` > `Then it is refused`: C25 `[a` vs `[a`; C24 `[a\]` vs `[a\]`; C32 `[[:digit:]` vs `[[:digit:]`; C33 `[[:foo:]]` vs `[[:foo:]]`; E6 `a\` vs `a\` → all false. They fail because each is a pure literal today and matches itself.
3. RED `Given an escape`:
   - E1 `\[a]`: `[a]`→true, `a`→false; E2 `\*`: `*`→true, `x`→false; E4 `\\`: `\`→true, `\\`→false;
   - E11 `a\/b` anchored vs `a/b`→true; S1 `**\/b` anchored: `b`→false, `x/b` `x/y/b`→true; S2 `a/**\/b` anchored: `a/b`→false, `a/x/b`→true;
   - the flipped `a\*` rows.
   They fail because `\` is a literal byte today.
4. RED `Given a multi-byte path`: Q2 `?` vs `é`→false; Q3 `??` vs `é`→true; Y3 `[!a][!a]` vs `é`→true; `[!a]` vs `'\uDC80'`→true (a lone escaped byte is one byte). They fail because `?` consumes one UTF-16 unit today. GUARD in the same Given: `??` vs `'\uDC80'`→false; Y1 `[é]` vs `é`→false.
5. RED `Given caseFold`: E12 `\a` vs `A`→true; F3 `[A-Z]` vs `a`→true; F8 `[[:upper:]]` vs `a`→true. They fail because the current code lowers the whole pattern and reads `[`/`\` literally. GUARD in the same Given: E13 `\A` vs `A`→false, F1 `[A]` vs `A`→false, F7 `[!b]` vs `B`→false, L4 `Dir/f` anchored vs `DIR/F`→true.
6. GREEN: the rebuild (tokens, program, `NEVER`, fold, `encodeEscaped`, the DP call), with `shortcutOf` returning `() => undefined`. Steps 1–5 go green.
7. GUARD `Given git's fast paths`, one row per guard. They pass against the DP-only code of step 6 and pin what the shortcut must not change:
   - ENDSWITH must not fire: `*a[b]` unanchored vs `xab`→true and vs `xa[b]`→false; `*a\b` vs `xab`→true and vs `xa\b`→false; `*a?` vs `yab`→true;
   - ENDSWITH: `*.log` unanchored: `x.log` `d/x.log`→true, `x.log/y`→false; `*.log` **anchored** vs `d/x.log`→false; `*.LOG` caseFold vs `x.log`→true;
   - prefix: `\*x` anchored vs `*x`→true; `[ab]c` unanchored vs `x/ac`→true; `?x` vs `ax`→true; `d/[ab]c` anchored vs `x/d/ac`→false; `zz/*.c` unanchored vs `xzz/a.c`→false;
   - pure literal: L1 `A` caseFold vs `a`→true; `src` unanchored vs `a/src`→true and vs `a-src`→false.
8. GREEN (performance, no verdict change): `simpleLength` and `shortcutOf`. Steps 1–7 stay green.
9. GUARD perf (compile-glob.perf.test.ts). Both pass, because the core has been linear since Part 3:
   - `Given an adversarial [a-z]* run` > `When matched against 10000 a` > `Then it returns false within 1000 ms`, with pattern `'[a-z]*'.repeat(64) + 'b'`, anchored;
   - `Given a bracket set holding 100000 class openers` > `When compiled` > `Then it compiles within 1000 ms`, with `compileGlob('[' + '[:'.repeat(100_000) + 'x]', { anchored: true })` and `.test('x') === true`.
10. REFACTOR: functions under 20 lines, the module header; run `npm run check:test-pyramid`.
11. Commit, then run the bench gate in Context.

### Gate

`./node_modules/.bin/vitest run test/unit/domain/pathspec test/unit/domain/glob test/unit/domain/ignore test/unit/domain/attributes test/unit/domain/sparse test/integration/glob-double-star-interop.test.ts test/integration/sparse-checkout-ignorecase-interop.test.ts && ./node_modules/.bin/vitest run --config vitest.perf.config.ts test/perf/domain/pathspec/compile-glob.perf.test.ts && npm run check:types && ./node_modules/.bin/biome check src/domain/pathspec/compile-glob.ts src/domain/glob/wildmatch.ts test/unit/domain/pathspec/compile-glob.test.ts test/perf/domain/pathspec/compile-glob.perf.test.ts && npm run check:spelling && npm run check:test-pyramid`

### Commit

`fix(ignore): match gitignore-family globs on the wildmatch core with git's fast paths`

## Part 6 — `.gitignore` and sparse keep escapes; a rule reports its pattern as written (G-a, G-b; R6, R7; ADRs 1249/1250)

### Context

Files this part edits or creates:
- `src/domain/ignore/parse-gitignore.ts`
- `test/unit/domain/ignore/parse-gitignore.test.ts`
- `test/unit/domain/sparse/non-cone.test.ts`
- `test/integration/glob-bracket-class-interop.test.ts` (new; the sparse rows; Parts 7 and 8 extend it)
- `reports/api.json` (regenerated by `npm run docs:json`)

Current code (parse-gitignore.ts):
- `unescapePattern(s)` = `s.replace(/\\(.)/g, '$1')`.
- `tokenizeIgnoreLine(rawLine: string): TokenizedIgnoreLine | undefined` returns
  `cleanPattern: unescapePattern(stripped)`.
- `parseGitignore(text: string): IgnoreRuleset` sets
  `pattern: unescapePattern(stripTrailingSpaces(rawLine))` and
  `compiled: compileGlob(cleanPattern, { anchored })`.
- `!`, `#` and the trailing `/` are detected on the raw trimmed line (keep that, as git's
  `parse_path_pattern` does). Anchoring is `includes('/')` on the raw body, so `a\/b` is anchored
  (E11) and `**\/b` is anchored (S1).

Target:
- Delete `unescapePattern`; `cleanPattern: stripped`, escapes kept. Update the
  `TokenizedIgnoreLine.cleanPattern` doc to "negation, trailing `/` and leading `/` removed;
  escapes kept for the matcher".
- `pattern: stripTrailingSpaces(rawLine)`, the line as written after git's trailing-space trim.
  Update the `IgnoreRule.pattern` doc to say so.
- `parseGitignore(text: string, options: { readonly caseFold?: boolean } = {}): IgnoreRuleset`
  passes `caseFold: options.caseFold === true` to `compileGlob`. Use an inline anonymous type:
  no new exported symbol.
- Sparse: src/domain/sparse/non-cone.ts (`compileSparseRule(tokenized, source, { caseFold })`)
  and src/domain/sparse/parse-sparse-checkout.ts inherit the change through
  `tokenizeIgnoreLine`. Nothing to edit there.
- Public surface: these symbols ship in the @scolladon/tsgit/domain entry. Run `npm run docs:json` after
  GREEN and commit reports/api.json in this part. Its typedoc-id churn is normal. The optional
  argument is additive: no breaking mark (ADR-1257).

Existing tests that FLIP in parse-gitignore.test.ts (edit them in this part):
1. `parseGitignore` > `Given a line with a trailing space, escaped or not` > `When parsed` > `Then an escaped trailing space is preserved`: expected `'foo '` becomes `'foo\\ '`.
2. Same describe > `Then a bare escaped space (length-2 line) is preserved`: expected `' '` becomes `'\\ '`.
3. `parseGitignore` > `Given an escaped # at line start` > `When parsed` > `Then yields a literal-# rule (not a comment)`: `pattern` becomes `'\\#literal'`. Add `compiled.test('#literal') === true`.
4. `tokenizeIgnoreLine` > `Given an escaped pattern` > `When tokenized` > `Then the escape is removed from cleanPattern`: retitle to `Then the escape is kept in cleanPattern`; expected `'\\#literal'`.
test/unit/domain/ignore/parse-gitignore.properties.test.ts (re-parse idempotence over
`rule.pattern`) stays green as a GUARD: the generators hold no escapes.

Interop file (new), modelled on test/integration/glob-double-star-interop.test.ts (read-only):
- an `@proves` header with surface `globBracketClass`, bucket `cross-tool-interop`, interopSurface `globBracketClass`, and a one-line unique claim;
- `describe.skipIf(!GIT_AVAILABLE)`, with a mkdtemp root removed in `afterAll`;
- helpers from test/integration/interop-helpers.ts: `GIT_AVAILABLE`, `git(dir, ...args)`,
  `runGit(args, { input?, env? })` and `tryRunGitWithExit(args)` → `{ stdout, stderr, exitCode }`;
- tsgit side: `sparseCheckoutSet(createNodeContext({ workDir }), { patterns, cone: false })` from
  src/application/commands/sparse-checkout.ts.
- Outer `describe.each(['false', 'true'])('Given core.ignorecase is %s')`, then
  `describe('When non-cone sparse patterns are applied to a committed tree')`, then
  `it.each(SPARSE_ROWS)('Then … materialises the same files as git')`.
- Seed peer and ours alike. Run `git init -q -b main`, write the files, run `git config
  core.ignorecase <v>`, add, and commit with `-c user.name=… -c user.email=…`. Then run `git -C
  peer sparse-checkout set --no-cone <patterns…>` against tsgit on ours, and compare the
  `existsSync` listing of the row's files.
- Define `isWindowsHostilePath` here; Parts 7/8 reuse it. A row with a hostile file skips on
  win32 through `it.skipIf`.

### TDD steps

1. RED parse-gitignore.test.ts `Given a line written with escapes` > `When parsed` > `Then the rule reports the line as written`:
   - P1 `!e\[x]`→`!e\[x]`; `f\[ab]/`→`f\[ab]/`; `/g[h]`→`/g[h]` (GUARD: no escape);
   - P2 `\#a`→`\#a`; `c\ `→`c\ `; `d\*`→`d\*`; `g\\h   `→`g\\h`;
   - plus flips 1–3.
   They fail because `pattern` is unescaped.
2. GREEN: `pattern: stripTrailingSpaces(rawLine)`.
3. RED `tokenizeIgnoreLine` > `Given an escaped body` > `When tokenized` > `Then cleanPattern keeps the escape`:
   - `\#a`→`\#a`; `\!a`→`\!a` (negated false); `\*`→`\*`; `a\ `→`a\ `;
   - plus flip 4.
   RED parse-gitignore.test.ts `Given an escaped wildcard` > `When matched` > `Then the escape reaches the matcher`:
   - E2 `\*` vs `x`→false and vs `*`→true; E3 `\?` vs `x`→false; E10 `d/\*` vs `d/x`→false;
   - S1 `**\/b` vs `b`→false; E1 `\[a]` vs `[a]`→true and vs `a`→false.
   They fail because the unescape turns `\*` into a wildcard and `\[a]` into a class.
   RED non-cone.test.ts `Given an escaped sparse rule` > `When compiled`:
   - SP8 `\*` vs `x`→false and vs `*`→true;
   - SP7 `\[a]` vs `[a]`→true and vs `a`→false.
   They fail for the same reason.
   GUARD there: SP12 `a\` vs `a\`→false (the abort landed in Part 5).
4. GREEN: delete `unescapePattern`.
5. RED `Given a folded rule set` > `When parseGitignore runs with caseFold` > `Then *.LOG ignores x.log`. It fails because the option is not passed. GUARD: without the option, `*.LOG` vs `x.log` → false.
6. GREEN: the `options` argument.
7. GUARD interop sparse rows, both twins. Each lists patterns, then files, then the files git keeps:
   - SP1 `/t` `br[a]/` over `t` `bra/i` `br[a]/h` → `t` `bra/i`;
   - SP2 `[ab]` over `a` `b` `c` → `a` `b`;
   - SP3 `d/[!a]` over `d/a` `d/b` → `d/b`;
   - SP4 `[A]x` over `Ax` `bx` → `Ax` (false), none (true);
   - SP5 `[a]x` over `Ax` `bx` → none (false), `Ax` (true);
   - SP6 `[A-Z]x` over `ax` `bx` `5x` → none (false), `ax` `bx` (true);
   - SP7 `\[a]` over `[a]` `a` → `[a]`;
   - SP8 `\*` over `*` `x` → `*` (win32 skip);
   - SP9 `x[[:digit:]]` over `x5` `xa` → `x5`;
   - SP10 `[a` over `[a` `a` → none;
   - SP11 `?` over `é` `e` → `e`;
   - SP12 `a\` over `a\` `a` → none (win32 skip);
   - SP13 `*.LOG` over `x.log` `y.txt` → none (false), `x.log` (true).
   They pass after step 4; on main SP1–SP3, SP6–SP12 fail. The assertion compares with live git, not with the list.
8. `npm run docs:json`, then `npm run check:doc-typedoc` (green). Commit reports/api.json in this part.
9. REFACTOR, then run `npm run check:test-pyramid`.

### Gate

`./node_modules/.bin/vitest run test/unit/domain/ignore test/unit/domain/sparse test/integration/glob-bracket-class-interop.test.ts test/integration/glob-double-star-interop.test.ts test/integration/sparse-checkout-worktree-config-interop.test.ts test/integration/sparse-checkout-ignorecase-interop.test.ts test/integration/gitignore-end-to-end.test.ts && npm run check:types && ./node_modules/.bin/biome check src/domain/ignore/parse-gitignore.ts test/unit/domain/ignore/parse-gitignore.test.ts test/unit/domain/sparse/non-cone.test.ts test/integration/glob-bracket-class-interop.test.ts && npm run check:spelling && npm run check:test-pyramid && npm run check:doc-typedoc`

### Commit

`fix(ignore): keep pattern escapes for the matcher and report rules as written`

## Part 7 — Ignore rules fold under `core.ignorecase` (G-c ignore half; R8, R11 ignore rows; ADR-1251)

### Context

Files this part edits:
- `src/application/primitives/internal/read-gitignore.ts`
- `src/application/primitives/internal/ignore-evaluator.ts`
- `test/unit/application/primitives/is-ignored.test.ts`
- `test/unit/application/commands/internal/build-ignore-evaluator.test.ts`
- `test/integration/glob-bracket-class-interop.test.ts` (adds the ignore rows)

Current code:
- read-gitignore.ts (internal; re-exported by the deprecated shim
  src/application/commands/internal/read-gitignore.ts, unchanged):
  - `readGitignore(ctx, dir: FilePath | ''): Promise<IgnoreRuleset | undefined>`;
  - `readInfoExclude(ctx)`;
  - `readGlobalExcludes(ctx)`, which already calls `readConfig(ctx)` for `core.excludesFile`;
  - private `loadAndParse(ctx, path)` → `parseGitignore(text)`.
- ignore-evaluator.ts:
  - `buildIgnoreEvaluator(ctx): Promise<IgnoreEvaluator>` (`{ base, loadDirRules }`) reads global,
    info, then root, and caches `loadDirRules(dir)`;
  - `buildRepoIgnorePredicate(ctx)` builds on it;
  - src/application/primitives/is-ignored.ts `isIgnored` calls `buildIgnoreEvaluator`. Nothing
    else parses ignore files.

Target (DC-I, PC-7):
- `readGitignore(ctx, dir, options: { readonly caseFold?: boolean } = {})`,
  `readInfoExclude(ctx, options = {})` and `readGlobalExcludes(ctx, options = {})` pass `options`
  through `loadAndParse(ctx, path, options)` to `parseGitignore(text, options)`.
- `buildIgnoreEvaluator` reads `const caseFold = (await readConfig(ctx)).core?.ignoreCase === true`
  **once**, before the three reads. It passes `{ caseFold }` to all three and closes over it in
  `loadDirRules`. Import `readConfig` from ../config-read.js.
- Base-directory comparison (`relativize` in src/domain/ignore/matcher-stack.ts) stays
  case-exact (design §7.3).

Fixtures (read-only models):
- is-ignored.test.ts `seedRepo(homeDir?)` and `afterEach(() => __resetConfigCacheForTests())`.
  Write the config through `ctx.fs.writeUtf8` at the gitDir's config file, content
  `[core]\n\tignorecase = true\n`.
- Global excludes need `createMemoryContext({ homeDir })` plus `excludesFile = ~/global` in the
  same `[core]`.
- build-ignore-evaluator.test.ts shows the counting `Proxy` over `ctx.fs` (`readUtf8`).

Interop (extend the Part 6 file):
- In the same twin `describe.each`, add `describe('When a .gitignore rule is checked')` with
  `it.each(CASES)('Then %s matches git check-ignore')`.
- Per (case, twin), one repo: `git init -q`, `git config core.ignorecase <v>`, and a
  `.gitignore` holding the pattern line.
- git: `tryRunGitWithExit(['-C', repo, 'check-ignore', '-z', '--no-index', '--', ...paths])`.
  Exit 0 or 1 (1 = none ignored; anything else throws). The ignored set is the NUL-split
  stdout.
- tsgit: `isIgnored(createNodeContext({ workDir: repo }), paths.map(…))`; the set is the
  `ignored` ones.
- Compare the two sets. No file is written for a path. The CASES table goes in this part; Part 8
  reuses it.
- A P-row: `.gitignore` lines `!e\[x]`, `f\[ab]/`, `/g[h]`, `\#a`, `c\ `, `d\*`, `g\\h   `.
  Create the directory `f[ab]` on disk; the path is checked with `isDirectory: true`, and git
  sees the existing directory. git: `check-ignore -v -z --no-index -- 'f[ab]' gh '#a' 'c ' 'd*'`,
  read as NUL-separated `<source> <line> <pattern> <path>` quads. tsgit: rebuild
  `.gitignore`/`source.line`/`source.pattern` for each match and compare the triples (ADR-249).
  `g\\h` matches the path `g\h`: add it to the path list. The P-row skips on win32 (hostile paths).

### TDD steps

1. RED is-ignored.test.ts `Given core.ignorecase true and a root .gitignore holding *.LOG` > `When isIgnored checks x.log` > `Then it is ignored by *.LOG` (`source.pattern === '*.LOG'`). It fails because the rules are parsed case-exact.
2. GREEN: `buildIgnoreEvaluator` reads the config and passes `{ caseFold }` to `readGitignore(ctx, '')`.
3. RED `describe.each` over the three other sources — `info/exclude` holding `A`, global excludes holding `A`, `sub/.gitignore` holding `A` — `When isIgnored checks a` (or `sub/a`) `Then it is ignored`. They fail because only the root read receives `caseFold` after step 2. GUARD rows: `core.ignorecase false`, and unset → `*.LOG` vs `x.log` not ignored.
4. GREEN: thread `options` through the three readers and `loadDirRules`.
5. GUARD build-ignore-evaluator.test.ts `Given core.ignorecase true and a root *.log` > `When buildRepoIgnorePredicate tests X.LOG` > `Then it is ignored`. It passes because the predicate builds on the evaluator of step 4; it pins the walk path.
6. GUARD build-ignore-evaluator.test.ts `Given a built evaluator` > `When loadDirRules loads sub` > `Then the config is not read again`. Count `readUtf8`/`stat` calls whose path ends in `/config` through the Proxy: 0. This pins DC-I.
7. GUARD interop ignore rows, both twins. They pass after step 4; on main most fail. Each row is ID, pattern, paths; mark attributes-only paths `attrOnly` (used in Part 8):
   - T2: E1 `\[a]`: `[a]` `a` · E2 `\*`: `*` `x` · E6 `a\`: `a` `a\` · E7 `\!a`: `!a` `a` · E11 `a\/b`: `a/b` · E12 `\a`: `a` `A` · E13 `\A`: `a` `A`
   - T3: L1 `A`: `a` `A` · L3 `*.LOG`: `x.log` `x.LOG` · L4 `Dir/f`: `dir/f` `Dir/f` `DIR/F`
   - T4: Q2 `?`: `é` `e` · Q3 `??`: `é` `ee`
   - T5c: S1 `**\/b`: `b` `x/b` `x/y/b` · S2 `a/**\/b`: `a/b` `a/x/b` `a/x/y/b` · T5d: S5 `a/[b]**/c`: `a/bc` `a/b/x/c` `a/bX/c` `a/b/c`
   - B1: C1 `[!a]`: `a` `b` `!` · C2 `[^a]`: `a` `b` `^` · C3 `[a!]`: `a` `!` `b`
   - B2: C5 `[]a]`: `]` `a` `b` · C6 `[!]a]`: `]` `a` `b` · C9 `[]-a]`: `]` `^` `a` `-` `b`
   - B3: C25 `[a`: `[a` `a` · C31 `*[`: `a[` `[` `x` · C24 `[a\]`: `a` `\` `a]` `[a\]`
   - B4: C18 `[\]]`: `]` `\` `a` · C20 `[a\-c]`: `a` `-` `c` `b` · C21 `[a-\c]`: `b` `c` `\` `d`
   - B5: C10 `[a-c]`: `a` `b` `c` `d` `-` · C11 `[c-a]`: `c` `a` `b` · C12 `[a-]`: `a` `-` `b` · C14 `[a-c-e]`: `b` `-` `e` `d` · C15 `x[--0]`: `x.` `x-` `x,` `x1`
   - B6a: C32 `[[:digit:]`: `5` `[[:digit:]`
   - B6b: C51 `[[:alpha]`: `[` `a` `p` `x`, attrOnly `:` · C53 `[[:]]`: `[]` `[` `]`, attrOnly `:]`
   - B6c: C36 `[[:digit:]]`: `5` `a` `[` · C40 `[[:space:]]`: SP HT VT FF `a` · C42 `[[:punct:]]`: `!` `_` `~` `a` `5` · C49 `[[:digit:]-z]`: `5` `-` `z` `a` · C50 `[a-[:digit:]]`: `a]` `d]` `5` `5]`, attrOnly `:]`
   - B6d: C33 `[[:foo:]]`: `a` `f` `[[:foo:]]` · C34 `[[::]]`: `[` `[[::]]`, attrOnly `:`
   - B7: C56 `*.py[cod]`: `m.pyc` `m.pyo` `m.pyd` `d/m.pyc` `m.py` `m.pyx` `m.py[cod]` · C58 `[ab]`: `a` `b` `d/a` `c` `[ab]` · C60 `[ab]c`: `x/ac` `cc`
   - B9: C61 `a[/]b`: `a/b` · C62 `x/a[!b]c`: `x/a/c` `x/adc` `x/abc` · C63 `a[b/c]d`: `abd` `acd` `a/d`
   - Fold: F1 `[A]`: `a` `A` · F3 `[A-Z]`: `a` `A` `5` · F5 `[X-c]`: `a` `A` `Y` `y` `d` · F6 `[!A]`: `a` `A` `b` · F7 `[!b]`: `B` `b` `c` · F8 `[[:upper:]]`: `A` `a` `5` · F10 `x[A]`: `xa` `xA` `Xa` · F12 `[A-A]`: `a` `A`
   - Bytes: Y1 `[é]`: `é` `e` · Y3 `[!a][!a]`: `é` `bb`
   Every path list obeys the traps: no `:`-led ignore path, no path under a directory the pattern matches, no `.`/`..`, control characters only as arguments.
8. GUARD interop P-row (`check-ignore -v` triples), both twins.
9. REFACTOR, then run `npm run check:test-pyramid`.

### Gate

`./node_modules/.bin/vitest run test/unit/application/primitives/is-ignored.test.ts test/unit/application/commands/internal/build-ignore-evaluator.test.ts test/unit/application/commands/internal/read-gitignore.test.ts test/integration/glob-bracket-class-interop.test.ts test/integration/gitignore-end-to-end.test.ts test/integration/add-ignored-report-interop.test.ts test/integration/add-tracked-under-ignore-interop.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/primitives/internal/read-gitignore.ts src/application/primitives/internal/ignore-evaluator.ts test/unit/application/primitives/is-ignored.test.ts test/unit/application/commands/internal/build-ignore-evaluator.test.ts test/integration/glob-bracket-class-interop.test.ts && npm run check:spelling && npm run check:test-pyramid`

### Commit

`fix(ignore): fold ignore patterns under core.ignorecase as git does`

## Part 8 — Attributes: escapes, negative patterns dropped, fold under `core.ignorecase` (G-a/G-c attribute half, G-e; R6, R8, R9; ADRs 1251/1256)

### Context

Files this part edits:
- `src/domain/attributes/parse-gitattributes.ts`
- `test/unit/domain/attributes/parse-gitattributes.test.ts`
- `src/application/primitives/internal/read-gitattributes.ts`
- `test/unit/application/primitives/internal/read-gitattributes.test.ts`
- `test/integration/glob-bracket-class-interop.test.ts` (adds the attribute rows)

Current code:
- parse-gitattributes.ts (internal, absent from api.json):
  - `parseGitattributes(text: string): ParsedAttributes` trims each line, skips blanks, `#`
    lines and `[attr]` macros, then runs `readPattern(line)` (C-unquotes a leading `"…"`) and
    `buildRule(pattern, rest, lineNumber)`;
  - `buildRule` calls `derivePattern(pattern)` → `{ anchored, directoryOnly, body }` and
    `compileGlob(body, { anchored })`.
  - Escapes already reach `compileGlob` untouched, so since Part 5 `\[a]`, `\!b` and `a\` behave
    as git's.
- read-gitattributes.ts:
  - private `loadAndParse(ctx, path)`, `parseBlobAttributes(ctx, id)`,
    `type DirReader = (ctx, dir: FilePath | '') => Promise<ParsedAttributes | undefined>`,
    `workTreeDirReader`, `treeDirReader(tree)`, `indexDirReader(lookup)`,
    `firstOf(primary, fallback)`, `dirReaderFor(direction)`, `readInfo(ctx)`, `readGlobal(ctx)`
    (already calls `readConfig`), and `buildAttributeProviderFrom(ctx, readDir)`;
  - exported: `buildAttributeProvider(ctx, direction?)` and
    `buildCheckinAttributeProvider(ctx, index?)`.

Target:
- `parseGitattributes(text: string, options: { readonly caseFold?: boolean } = {})`.
  `buildRule(pattern, rest, lineNumber, options)` passes `caseFold: options.caseFold === true`.
  Pass an options object, not a boolean argument.
- A rule whose pattern, after `readPattern`, starts with `!` is skipped silently (DC-F/ADR-1256:
  no diagnostic). This covers the quoted form `"!a"`. Macros are unaffected.
  `AttributeRule.pattern` keeps its meaning.
- read-gitattributes.ts: `buildAttributeProviderFrom` reads
  `const caseFold = (await readConfig(ctx)).core?.ignoreCase === true` once and builds
  `options = { caseFold }`. It hands `options` to `readInfo(ctx, options)`,
  `readGlobal(ctx, options)` and `readDir(ctx, dir, options)`. `DirReader` gains the third
  parameter, so every reader and `firstOf` forward it to `loadAndParse(ctx, path, options)` /
  `parseBlobAttributes(ctx, id, options)` → `parseGitattributes(text, options)`.
- `relativeTo` in src/domain/attributes/resolve-attribute.ts stays case-exact.

Fixtures (read-only): in read-gitattributes.test.ts:
- `seed(ctx, path, content)`, `merge(ctx, path)`;
- `putBlob(ctx, content)`, `putTree(ctx, entries)`, `buildTreeAttributeProvider(ctx, tree)`;
- `lookupOf(files)` for the index directions;
- the info/attributes and `attributesFile = /repo/global-attrs` blocks;
- the `vi.spyOn(ctx.fs, 'readUtf8')` read-count pattern ("each directory read once").
Config goes in at the memory repo's config file (gitDir, then config) as `[core]\n\tignorecase = true\n`.

Interop (extend the Part 6 file):
- Add `describe('When a .gitattributes rule is resolved')` with
  `it.each(CASES)('Then %s matches git check-attr')`, reusing Part 7's CASES.
- Paths: the case's paths plus its `attrOnly` paths.
- git: `runGit(['-C', repo, 'check-attr', '-z', 'probe', '--', ...paths])`, read as NUL-separated
  `<path> <attr> <value>` triples.
- tsgit: `buildAttributeProvider(createNodeContext({ workDir: repo }))`, then
  `resolveAttribute(sources, path, 'probe', macros)` per path, mapped `true → 'set'`. Compare
  the maps.
- N-rows (attributes only):
  - N1: `.gitattributes` line `!a probe`; paths `!a`, `a` → git `unspecified` for both;
  - N2: line `\!b probe`; path `!b` → `set`.

### TDD steps

1. RED parse-gitattributes.test.ts `Given a negative pattern line` > `When parsed` > `Then the line yields no rule`: `!a foo`, and the quoted `"!a" foo`. Both give `rules.length === 0`. They fail because the rule is kept. GUARD rows: `\!b foo` → one rule with `compiled.test('!b') === true`; `[attr]m foo` → one macro.
2. GREEN: the skip.
3. RED `Given caseFold` > `When *.TXT text is parsed` > `Then it matches a.txt`. It fails because the option is ignored. GUARD rows: without the option → false; E13 `\A` with caseFold vs `A` → false.
4. GREEN: the `options` argument.
5. RED read-gitattributes.test.ts `describe.each` over the sources: root `.gitattributes`, `a/.gitattributes`, info/attributes, `core.attributesFile`, the tree direction (`putBlob` + `putTree`) and the index-first direction (`lookupOf`). Each is `Given core.ignorecase true and *.TXT merge=x in <source>` > `When merge is resolved for a.txt` (or `a/a.txt`) > `Then it is { set: 'x' }`. They fail because the providers parse case-exact. GUARD row: `core.ignorecase false` → `unspecified`.
6. GREEN: read once, then thread `options`.
7. GUARD `Given a built provider` > `When sourcesForPath loads a nested directory` > `Then the config is not read again`. Spy on `readUtf8` and `stat` for paths ending in `/config`: 0.
8. GUARD interop attribute rows and N1/N2, both twins. They pass after step 6; on main, E-, C- and fold rows fail.
9. REFACTOR, then run `npm run check:test-pyramid`.

### Gate

`./node_modules/.bin/vitest run test/unit/domain/attributes test/unit/application/primitives/internal/read-gitattributes.test.ts test/unit/application/primitives/internal/renormalize-attributes.test.ts test/integration/glob-bracket-class-interop.test.ts test/integration/diff-attr-binary-interop.test.ts test/integration/eol-conversion-interop.test.ts && npm run check:types && ./node_modules/.bin/biome check src/domain/attributes/parse-gitattributes.ts test/unit/domain/attributes/parse-gitattributes.test.ts src/application/primitives/internal/read-gitattributes.ts test/unit/application/primitives/internal/read-gitattributes.test.ts test/integration/glob-bracket-class-interop.test.ts && npm run check:spelling && npm run check:test-pyramid`

### Commit

`fix(attributes): skip negative patterns and fold case under core.ignorecase as git does`

## Part 9 — Class-grammar properties against a recursive `dowild` reference (test-infra; ADR-1258, R10)

### Context

Files this part edits or creates:
- `test/unit/domain/pathspec/dowild-reference.ts` (new; test-side, never shipped)
- `test/unit/domain/pathspec/arbitraries.ts`
- `test/unit/domain/pathspec/compile-glob.properties.test.ts`

No `src/` delta is planned. A counterexample is a defect the change's own tests exposed: fix it
in src/domain/glob/wildmatch.ts or src/domain/pathspec/compile-glob.ts in this part, with a
unit row in that module's eponymous suite. If the fix contradicts the design, hand back a
blocker instead.

Reference (an independent algorithm: git's backtracking recursion, not the DP). It works over
`Uint8Array` pattern `P` and text `T`, with flags `{ pathname: true, caseFold }`. Return codes are
`MATCH | NOMATCH | ABORT_ALL | ABORT_TO_STARSTAR`; `referenceWildmatch` returns
`dowild(0, 0) === MATCH`. Port this loop:

```
dowild(p, t):
  for (; p < P.length; p++, t++):
    pc = P[p]
    if t >= T.length and pc != '*': return ABORT_ALL
    tc = T[t]; if fold and isUpper(tc): tc = lower(tc); if fold and isUpper(pc): pc = lower(pc)
    switch pc:
      '\\': p++; pc = P[p]  (undefined past the end) ; if tc != pc return NOMATCH; continue
      '?': if tc == '/' return NOMATCH; continue
      '*': run = count of consecutive '*' from p; prev = P[p-1]; p += run   (p now past the run)
           if run >= 2 and (p-run == 0 or prev == '/') and (p == len or P[p] == '/' or (P[p] == '\\' and P[p+1] == '/')):
              if P[p] == '/' and dowild(p+1, t) == MATCH: return MATCH
              matchSlash = true
           else: matchSlash = false
           if p == len: return (!matchSlash and T.slice(t) holds '/') ? ABORT_TO_STARSTAR : MATCH
           if !matchSlash and P[p] == '/': s = T.indexOf('/', t); if s < 0 return ABORT_ALL; t = s; break  (the loop's p++/t++ consume both slashes)
           loop: if t >= T.length break
                 r = dowild(p, t); if r != NOMATCH: { if !matchSlash or r != ABORT_TO_STARSTAR: return r }
                 else if !matchSlash and T[t] == '/': return ABORT_TO_STARSTAR
                 t++
           return ABORT_ALL
      '[': p++; negated = P[p] in {'!','^'}; if negated p++; prev = 0; matched = false
           do:
             pc = P[p]; if pc undefined: return ABORT_ALL
             if pc == '\\': p++; pc = P[p]; if undefined return ABORT_ALL; if tc == pc matched = true
             elif pc == '-' and prev != 0 and P[p+1] defined and P[p+1] != ']':
               p++; hi = P[p]; if hi == '\\': p++; hi = P[p]; if undefined return ABORT_ALL
               if prev <= tc <= hi: matched = true
               elif fold and isLower(tc) and prev <= upper(tc) <= hi: matched = true
               pc = 0
             elif pc == '[' and P[p+1] == ':':
               s = p + 2; j = first index >= s with P[j] == ']' ; if none return ABORT_ALL
               if j - s - 1 < 0 or P[j-1] != ':': p = s - 2 (back on '['); pc = '['; if tc == '[' matched = true
               else: name = P[s .. j-2]; known twelve names → test (upper: isUpper(tc) or (fold and isLower(tc))); unknown → return ABORT_ALL
                     p = j; pc = 0
             elif tc == pc: matched = true
             prev = pc; p++
           while P[p] != ']'     (the first member is read before this test: B2)
           if matched == negated or tc == '/': return NOMATCH
           continue
      default: if tc != pc return NOMATCH
  return t >= T.length ? MATCH : NOMATCH
```
- Class tests: git's ASCII `sane_ctype`, as `CLASS_TESTS` in src/domain/glob/wildmatch.ts
  defines them. Write them independently: space = SP HT LF CR; punct = graph and not alnum.
- The literal fast-forward of git's star loop is a pruning step: omit it.

Generators to add to arbitraries.ts (keep the existing exports; `arbGlobBody`/`arbEscapedPath`
are already used by compile-pathspec.properties.test.ts):
- `arbFoldGlobBody()`: arrays of at most 8 units from `[`, `]`, `!`, `^`, `-`, `:`, `\`, `*`,
  `?`, `/`, `a`, `A`, `b`, `B`, `[:upper:]`, `[:alpha:]`;
- `arbFoldPath()`: at most 6 units from `a`, `A`, `b`, `B`, `/`, `-`, `]`, `[`, `!`, `:`, `é`;
- `arbBracketMembers()`: a well-formed set body that never starts with `!`, `^` or `]` and
  holds no `\` or `/`, from members `a`, `b`, `c`, `A`, `0`, `9`, `a-c`, `[:digit:]`;
- `arbUnbracketedBody()`: like `arbGlobBody`, without `\`.

Existing properties kept as is (GUARD):
- `Given caseFold over a small alphabet` > `When the path has its ASCII case flipped`;
- `When the exact matcher accepts a path`. Its generator stays `[aAbB/*?]`: the property is
  false once `[` or `\` join the alphabet (F1, E13).

### TDD steps

1. Write `dowild-reference.ts`. GUARD sanity block in compile-glob.properties.test.ts, `Given the reference dowild port` > `When run on pinned rows` > `Then it returns git's verdict`, using `it.each`:
   - C5 `[]a]` `]`→true; C9 `[]-a]` `^`→true and `-`→false; C11 `[c-a]` `a`→false; C14 `[a-c-e]` `-`→true;
   - C24 `[a\]` `[a\]`→false; C51 `[[:alpha]` `p`→true; C53 `[[:]]` `[]`→true;
   - E6 `a\` `a\`→false; S1 `**\/b` `b`→false and `x/b`→true;
   - with fold: E13 `\A` `A`→false; F1 `[A]` `A`→false; F12 `[A-A]` `a`→true.
   A wrong reference shows here first.
2. GUARD property, lens 3 (100 runs): any printable-ASCII pattern over the alphabet `[]!^-:\*?/aAbB` and a path compile with either flag and return a boolean.
3. GUARD property, lens 1 (200 runs): for a literal path `p` from `arbFoldPath` (non-empty), escaping every character (`\` before each) gives an anchored pattern that, with caseFold false, matches `p` and rejects `p + 'x'`. caseFold stays false because an escaped byte is never lowered (E13).
4. GUARD property, invariant (100 runs): with `S` from `arbBracketMembers` and a middle `c` any printable ASCII byte except `/`, `compileGlob('x[' + S + ']y')` and `compileGlob('x[!' + S + ']y')` disagree on `'x' + c + 'y'`, for each caseFold value. Under fold the table is still complemented by negation, so the XOR holds.
5. GUARD property, negative (50 runs): for any `arbUnbracketedBody()` pattern `P` and path, `compileGlob(P + '[', { anchored, caseFold })` accepts nothing.
6. GUARD property, the DC-H oracle (100 runs): for `arbFoldGlobBody()` patterns and `arbFoldPath()` paths, under both caseFold values, `compileGlob(pattern, { anchored: true, caseFold }).test(path) === referenceWildmatch(encode(pattern), encodeEscaped(path), { caseFold })`.
   Any counterexample shrinks to a concrete row. Add that row to the module's unit suite, fix, and re-run.
7. Run `npm run check:test-pyramid`.

### Gate

`./node_modules/.bin/vitest run test/unit/domain/pathspec test/unit/domain/glob && npm run check:types && ./node_modules/.bin/biome check test/unit/domain/pathspec/dowild-reference.ts test/unit/domain/pathspec/arbitraries.ts test/unit/domain/pathspec/compile-glob.properties.test.ts && npm run check:spelling && npm run check:test-pyramid`

### Commit

`test(glob): property-test the class grammar against a recursive dowild reference`

## Part 10 — Docs: the ignore-family dialect (docs-only, design §9)

### Context

Files this part edits:
- `docs/design/compile-glob-redos.md`
- `docs/use/commands/add.md`
- `docs/use/commands/sparse-checkout.md`
- `docs/use/primitives/is-ignored.md`

What changes:
- compile-glob-redos.md, §"Out of scope", the bullet "Character classes (`[abc]`), …": add an
  inline note that classes are no longer out of scope, superseded by
  docs/design/wildmatch-bracket-class.md. At §4, around the line "Confirms the existing
  character classes are literal in v1 behaviour", add a superseded note with the same pointer.
  Do not rewrite the historical text.
- add.md, the pathspec paragraph, last sentence "gitignore, gitattributes and sparse patterns
  keep their own dialect.": name that dialect. It is git's wildmatch with WM_PATHNAME: `[…]`
  classes, `\` escapes, a byte-wise `?`, and ASCII case folding under `core.ignorecase`.
- sparse-checkout.md, the "Non-cone mode" bullet: the same dialect line.
- is-ignored.md, §Behaviour, two bullets:
  - `source.pattern` is the rule line as written, after git's trailing-space trim, with `!`, `/`
    and `\` escapes kept, as `git check-ignore -v` prints it;
  - matching honours `core.ignorecase`.
- The compile-glob.ts module header was rewritten in Part 5. Grep it for "verbatim": it must be
  gone. The backlog tick and known-divergences stay out (the session handles the backlog;
  known-divergences has no entry for these gaps).

### TDD steps

1. Edit the four pages, keeping the diff small.
2. GUARD: `grep -n 'matched verbatim' src/domain/pathspec/compile-glob.ts` prints nothing.
3. GUARD: `npm run check:spelling` and `npm run check:doc-coverage` are green.

### Gate

`npm run check:spelling && npm run check:doc-coverage`

### Commit

`docs(ignore): document the wildmatch dialect of ignore, attribute and sparse patterns`

## Requirement → part map

| Req | Part(s) |
|---|---|
| R1 | 5 (core verdicts in compileGlob), 6 (sparse rows), 7 (ignore rows), 8 (attribute rows) |
| R2 | 3 (B-list tables), 4 (WM_CASEFOLD), 5 (WM_PATHNAME through compileGlob) |
| R3 | 3 (byte and set tokens), 5 (`encodeEscaped` path bytes, lone-byte rows) |
| R4 | 2 (core abort moved), 5 (abort beats every fast path) |
| R5 | 3 (linear lookahead + ref-glob compile bound), 5 (compile and match bound rows) |
| R6 | 6 (`.gitignore`, sparse), 8 (`.gitattributes`) |
| R7 | 6 (unit), 7 (`check-ignore -v` interop triples) |
| R8 | 7 (four ignore sources), 8 (attribute sources, every direction) |
| R9 | 8 |
| R10 | 5 (fast-path rows), 9 (reference oracle) |
| R11 | 6 (SP1–SP13), 7 (ignore rows), 8 (attribute rows, N1/N2) |
| R12 | 1 (bench), 5 (bench gates) |
| Docs (design §9) | 5 (module header), 10 |
