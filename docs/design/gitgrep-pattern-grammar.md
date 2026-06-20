# Design — gitGrep pattern grammar

> Brief: build a new Tier-1 `grep` command with a **faithful pattern grammar from
> day one**. git grep's default is POSIX **Basic** Regular Expressions (BRE), with
> `-E` (POSIX ERE), `-F` (fixed strings), and `-P` (PCRE) variants plus the
> `grep.patternType` config. A naive "treat the pattern as `new RegExp(...)`" — the
> trap a downstream consumer hit — is unfaithful for the default mode: JS `RegExp`
> is its own dialect, far from BRE (in BRE `+ ? { } ( ) |` are literal unless
> backslash-escaped). Decide the faithful grammar (translation vs interpreter vs
> reduced v1) and the v1 command surface, all structured-data per ADR-249. Grammar
> pinned empirically against real `git version 2.54.0`, not recalled.
> Status: draft → self-reviewed ×3 → decision candidates open

## Context

There is **no `grep` command in tsgit today** — `git grep`, `git ls-files`, and any
content-search surface are absent. Nothing in the codebase compiles a search
pattern, so this design introduces both the command and the pattern engine.
Because nothing renders `path:line:text`, the command is greenfield with respect
to ADR-249: it ships structured matches from the start, with zero rendering debt
to sweep.

The feature reuses three established subsystems:

**Text primitives (domain tier).** `src/domain/diff/line-diff.ts` exports
`splitLines(bytes: Uint8Array): ReadonlyArray<Uint8Array>` (splits on LF, each line
**keeps** its trailing LF, a final unterminated run is included) and
`isBinary(bytes): boolean` with caps `BINARY_DETECTION_BYTES = 8000`,
`MAX_LINE_BYTES = 65_536`, `MAX_LINES = 100_000`. Both are already re-exported from
`src/domain/diff/index.ts`. git grep skips binary blobs by default; tsgit reuses
`isBinary` for the same decision.

**The linear-matcher discipline (domain tier).** `src/domain/pathspec/compile-glob.ts`
compiles a glob into a pure `GlobMatcher { test(path): boolean }` via a
**backward dynamic program** over a boolean table — `O(tokenCount × pathLength)`,
**no backtracking**, ReDoS-proof (ADR-077, `docs/design/compile-glob-redos.md`).
It deliberately rejected a JS-`RegExp` backend. This is the model the pattern
engine must imitate: compile once into a pure matcher, never let an adversarial
pattern go super-linear. The new engine is content-matching (disjoint from
path-matching) but follows the same shape and the same no-catastrophic-backtracking
bar. The pathspec **path limiter** (`-- <path>`) reuses
`src/application/commands/internal/resolve-pathspec.ts` (`resolvePathspec`, budget
`MAX_PATHSPEC_PATTERN_BYTES = 256`) directly.

**Target enumeration + blob reading (primitive tier).**
`walkWorkingTree(ctx, options?): AsyncIterable<WalkWorkingTreeEntry>` (entry =
`{ path: FilePath; stat: FileStat }`, ignore-aware, embedded-repo-gated) for the
working-tree target; `walkTree(ctx, treeIdOrObject, options?):
AsyncIterable<WalkTreeEntry>` (recursive, `{ path, id, mode }`) for a `<tree-ish>`;
`readIndex(ctx): Promise<GitIndex>` for `--cached`; `readHeadTree(ctx):
Promise<FlatTree | undefined>` for HEAD; `readBlob(ctx, id): Promise<Blob>`
(`Blob.content: Uint8Array`) to load contents. The bounded-concurrency fan-out
pattern (`MAX_CONCURRENT_BLOB_LOADS` worker pool) is established in
`src/application/primitives/materialise-patch-files.ts` and `range-diff.ts`.

### Constraining decisions (FIXED — not re-litigated here)

| ADR / rule | Decision this design must implement |
|---|---|
| 226 / CLAUDE.md (prime directive) | Replicate git grep's observable **matching decisions** (which blob/line at which byte offset is a match, per dialect + flag) byte-for-byte; pin against real `git`, never recall. |
| 249 (structured data, not cosmetics) | `grep` returns **structured matches** (path, line number, byte offsets, matched line bytes; counts are *derived* from `hits`, not a stored field), never a rendered `path:line:text` line. Options whose only job is to steer printed text (`-n`, `--color`, `-h`, `--heading`, `--null`, `-o` formatting) MUST NOT exist on the surface. The `Binary file X matches` text and the `--count`/`-l` *layout* are reconstructed by the caller from the data. |
| 077 (linear glob matcher) | The matcher compiles to a linear, non-backtracking program; no input may make it super-linear; no npm regex dependency (zero-dependency hard constraint). |
| 378 (flat options enum) | Mutually-exclusive modes are one flat string-literal union on the options interface, illegal combos unrepresentable. `patternType?: 'basic' \| 'extended' \| 'fixed'` is the analogue of `ignoreWhitespace?: 'all' \| 'change' \| 'at-eol'`. |
| 382 (config default, wire both) | If a config default for pattern type is in scope, it lands on `RepositoryConfig` as a **programmatic facade default** (NOT git's on-disk `grep.patternType`) and resolves `opts.field ?? config?.field ?? builtin-default`. |

## Requirements

What must be true when this ships:

1. A pattern compiled in **basic** mode reproduces git's POSIX-BRE matching
   decisions byte-for-byte: `+ ? { } ( ) |` are **literal** unless backslash-escaped;
   `\( \)` group, `\{m,n\}` is an interval, `\+ \? \|` are operators; GNU
   word-class/anchor extensions `\b \w \s \< \>` are active (pinned §"Grammar
   matrix" #G1–#G18).
2. **extended** mode reproduces git's POSIX-ERE decisions: `+ ? { } ( ) |` are
   operators; `\+` is a literal plus; and — the load-bearing asymmetry — GNU
   word extensions `\b \w \s \< \>` are **NOT** honoured (they degrade to the
   literal letter / are ignored as anchors), unlike BRE (#G19–#G24).
3. **fixed** mode treats the entire pattern as a literal byte substring — no
   metacharacter is special (#G25–#G27).
4. Pattern-type selection is a flat enum `patternType?: 'basic' | 'extended' |
   'fixed'` defaulting to `'basic'` (git's default). Whether `'perl'` (`-P`) is in
   v1 is **Decision D1**.
5. `grep` searches a chosen target and returns **structured** matches per ADR-249:
   for each path, the matching lines with their **line number (1-based)**, the
   **matched line bytes** (raw, with no trailing-LF normalization beyond what
   `splitLines` keeps), and the **byte offset(s)** of the match within the line.
   It never returns a rendered line.
6. Search targets: working tree (default), `--cached` (index blobs), and a
   `<tree-ish>` (commit-or-tree). Which of these ship in v1 is **Decision D2**.
7. Binary blobs are **skipped from line-level matching by default** (git's
   default); the structured result records that a binary blob *contained* a match
   as a distinct datum (a `binaryMatch` flag on the path entry), so a caller can
   reconstruct git's `Binary file X matches` line without the library emitting it
   (#G28).
8. Core matching flags that are **data, not rendering** are honoured: `-i`
   (case-insensitive), `-w` (whole-word), `-v` (invert — lines NOT matching),
   multiple patterns (`-e` OR-combination). Their exact v1 set is **Decision D2**.
9. Path limiting via pathspec (`-- <path>...`) reuses `resolvePathspec`.
10. Invalid patterns fail with a structured `INVALID_OPTION`-class error carrying
    the dialect and reason — never a silent mismatch or an uncaught throw. The
    *condition* differs by dialect (a leading `*` is literal in BRE but a fatal
    "repetition-operator operand invalid" in ERE, #G29).
11. Every grammar + flag claim above is pinned by a cross-tool interop test
    (`test/integration/grep-grammar-interop.test.ts`) reconstructing git grep's
    behaviour from the structured fields (twin real-`git` vs tsgit + frozen golden).

## Design

### Layering — pure compiler + pure matcher + primitive orchestrator

Mirroring `compile-glob` (pure) + the diff primitives (I/O), the feature splits:

```
grep command (ctx, opts)                         ← application/commands/grep.ts
  │  resolve target (working tree | --cached | <tree-ish>)
  │  resolve pathspec limiter (resolvePathspec)
  │  resolve patternType (opts ?? config ?? 'basic')
  │
  ├─ compileGrepPattern(pattern, { type, ignoreCase, wholeWord })   ← domain/grep/compile-pattern.ts (PURE)
  │     └─ returns GrepMatcher { matchLine(bytes): ReadonlyArray<MatchSpan> }
  │
  └─ for each enumerated blob (bounded pool):
        readBlob → isBinary?  yes → record binaryMatch datum (no line scan)
                              no  → splitLines → matcher.matchLine per line → collect MatchHit
```

- **Domain (pure, no I/O):** `src/domain/grep/compile-pattern.ts`. A
  **dialect-specific compiler** turns the raw pattern into an internal matcher.
  `compileGrepPattern(pattern: string, opts: GrepCompileOptions): GrepMatcher`.
  `GrepMatcher.matchLine(line: Uint8Array): ReadonlyArray<MatchSpan>` reports the
  byte spans matched within one line (empty array = no match). The whole-pattern
  engine choice (translation-to-`RegExp` vs purpose-built interpreter vs reduced)
  is **Decision D3** — that is the central grammar-faithfulness decision.
- **Primitive / command (I/O orchestrator):** `src/application/commands/grep.ts`
  owns target resolution, the bounded blob-read pool, binary gating, and assembly
  of the structured `GrepResult`. It reuses the existing primitives listed in
  Context — no new I/O primitive is required (a `grep` is read-only enumeration +
  `readBlob`, both already available).

### Pinned grammar matrix (the faithfulness core)

Real `git version 2.54.0`, scrubbed `GIT_*`, `GIT_CONFIG_NOSYSTEM=1`, isolated
`HOME`, signing off, throwaway `mktemp -d` repo. `git grep --no-color` over a
fixture containing (one per line): `aaa`, `a+b`, `a+`, `ab`, `aXb`, `foo123bar`,
`word boundary here`, `WORD here`, `a{2,3}`, `aaa{2,3}`, `(group)`, `a|b`, `alt1`,
`x.y`, `xZy`, `star*lit`. **"≡ literal"** = the metachar matches only itself;
**"operator"** = it has regex meaning.

| # | Pattern | Mode | git decision | Load-bearing fact |
|---|---|---|---|---|
| G1 | `a+` | basic | matches `a+b`, `a+` only | BRE `+` is **literal** — the JS-`RegExp` trap exactly |
| G2 | `a\+` | basic | matches every line with ≥1 `a` | BRE `\+` is one-or-more (GNU) |
| G3 | `a{2,3}` | basic | matches `a{2,3}` only | BRE `{ }` **literal** |
| G4 | `a\{2,3\}` | basic | matches `aaa`, `aaa{2,3}` | BRE `\{m,n\}` is an interval |
| G5 | `(group)` | basic | matches `(group)` only | BRE `( )` **literal** |
| G6 | `\(group\)` | basic | matches `(group)` (as a capture of `group`) | BRE `\( \)` group |
| G7 | `a|b` | basic | matches `a|b` only | BRE `|` **literal** |
| G8 | `a\|b` | basic | matches every line with `a` or `b` | BRE `\|` alternation (GNU) |
| G9 | `x.y` | basic | matches `x.y` AND `xZy` | BRE `.` is any-char (operator) |
| G10 | `^aaa` | basic | matches `aaa`, `aaa{2,3}` | `^` anchor active |
| G11 | `ab$` | basic | matches `ab` | `$` anchor active |
| G12 | `*leading` | basic | matches `*leading star` | leading `*` is **literal** in BRE |
| G13 | `[[:digit:]]` | basic | matches `foo123bar`, `a{2,3}`, `aaa{2,3}`, `alt1` | POSIX class supported |
| G14 | `[[:alpha:]]\{3\}` | basic | matches all-alpha-run lines | POSIX class + interval compose |
| G15 | `\bword\b` | basic | matches `word boundary here` | GNU `\b` word boundary in BRE |
| G16 | `\<word\>` | basic | matches `word boundary here` | GNU `\< \>` word edges in BRE |
| G17 | `\w\+` | basic | matches every line (each has a word char) | GNU `\w` word-class in BRE |
| G18 | `word\sboundary` | basic | matches `word boundary here` | GNU `\s` whitespace-class in BRE |
| G19 | `a+` | extended | matches every line with ≥1 `a` | ERE `+` is one-or-more |
| G20 | `a{2,3}` | extended | matches `aaa`, `aaa{2,3}` | ERE `{ }` interval |
| G21 | `(group)` | extended | matches `(group)` (capture) | ERE `( )` group |
| G22 | `a|b` | extended | matches every line with `a` or `b` | ERE `|` alternation |
| G23 | `a\+` | extended | matches `a+b`, `a+` only | ERE `\+` is a **literal** plus |
| G24a | `\bword`, `\<word\>` | extended | **no match** | ERE does **NOT** honour GNU `\b`/`\<`/`\>` anchors |
| G24b | `\w` on `abc_123` (no literal `w`) | extended | **no match** | ERE treats `\w` as **literal `w`**, not a word-class |
| G24c | `word\sboundary` | extended | **no match** | ERE treats `\s` as literal `s`, not whitespace |
| G25 | `a+` | fixed | matches `a+b`, `a+` | `-F` everything literal |
| G26 | `x.y` | fixed | matches `x.y` only (not `xZy`) | `-F` dot literal |
| G27 | `star*lit` | fixed | matches `star*lit` | `-F` star literal |
| G28 | `binary` over a blob with a NUL byte | (any) | prints `Binary file b.bin matches`; line scan skipped | binary skipped by default; the *datum* is "blob matched", not a printed line |
| G29 | `*leading` | extended | `fatal: '*leading': repetition-operator operand invalid` (exit 128) | invalid-pattern condition is **dialect-specific** (literal in BRE, fatal in ERE) |

**The load-bearing asymmetry (G15–G18 vs G24a–G24c).** git's default engine is
glibc `regcomp`. In **BRE** (`REG_NEWLINE`, no `REG_EXTENDED`) the GNU extensions
`\b \w \s \< \>` are honoured. In **ERE** (`REG_EXTENDED`) they are **not** — `\w`
degrades to literal `w`, `\s` to literal `s`, `\b`/`\<`/`\>` match nothing. A
faithful engine must therefore key `\b \w \s \< \>` handling on the dialect, not
emit one mapping for both. JS `RegExp` would honour `\b \w \s` in *both* — so a
single `RegExp` translation that maps these uniformly is unfaithful to ERE.

### Pinned target + flag matrix

`git grep` over a working tree with a staged-but-uncommitted change `staged_only`,
a working-tree-only unstaged change `wt_only_unstaged`, plus the committed
fixture.

| # | Invocation | git decision | Load-bearing fact |
|---|---|---|---|
| T1 | (default) `wt_only_unstaged` | matches | default target = **working tree** (unstaged content visible) |
| T2 | `--cached staged_only` | matches | `--cached` = **index** blobs (staged content) |
| T3 | `--cached wt_only_unstaged` | no match | index does not carry the unstaged change |
| T4 | `HEAD staged_only` | no match | `<tree-ish>` = committed tree only |
| F1 | `-i word` | matches `word boundary here` AND `WORD here` | case-fold is a data decision |
| F2 | `-w word` | matches `word boundary here` (whole word) | word-boundary gating, not substring |
| F-w | `-w word` under basic / extended / fixed | matches the whole-word line in **all three** | `-w` gates at matcher level, NOT via `\b` injection (works where `\b` is inert) |
| F3 | `-v aaa` | every line NOT containing `aaa` | invert is a per-line data decision |
| F4 | `-e alt1 -e xZy` | union of both | multiple patterns OR-combine |
| F5 | `-i -w WORD` | matches both `word`/`WORD` lines | flags compose |
| C1 | `-c a` on `g.txt` | per-file integer count (`g.txt:12`) | count is structured data (matchCount per path) |
| C2 | `-l aaa` | lists `g.txt` | name-only = membership data (path had ≥1 match) |
| P1 | `grep.patternType extended` then `a+` | behaves as ERE | config selects the dialect |

Counts (C1) and name-only (C2) are **derivable from the structured result** —
`hits.length` (git's `-c` counts matching *lines*, one per line regardless of how
many spans it carries) and `hits.length > 0` reconstruct `-c` and `-l` without the
library shipping those as rendering modes (ADR-249, exactly as the whitespace
design derives the numstat-omit rule rather than adding a `suppressed` flag). No
`matchCount` field is added — it would be redundant denormalization of `hits`.

### Option + result shapes (ADR-249)

The option surface is one flat interface (ADR-378 style). The exact target +
flag membership is **Decision D2**; the shape below is the full-v1 (D2(a)) form,
narrowed if D2(b)/(c) is chosen.

```ts
export type GrepPatternType = 'basic' | 'extended' | 'fixed';  // + 'perl' iff D1(a) rejected

export interface GrepOptions {
  /** Patterns to search for. ≥1 required; multiple OR-combine (git's `-e ... -e ...`, #F4). */
  readonly patterns: ReadonlyArray<string>;
  /** Dialect; default `'basic'` (git's default). Resolves opts ?? config ?? 'basic'. */
  readonly patternType?: GrepPatternType;
  /** Case-insensitive (`-i`, #F1). */
  readonly ignoreCase?: boolean;
  /** Whole-word gating (`-w`, #F2) — applied at matcher level in ALL dialects (pinned §F-w). */
  readonly wholeWord?: boolean;
  /** Invert: return lines that do NOT match (`-v`, #F3). */
  readonly invert?: boolean;
  /** Target. Absent ⇒ working tree; `'index'` ⇒ `--cached`; a rev string ⇒ `<tree-ish>`. */
  readonly target?: 'index' | { readonly treeish: string };
  /** Pathspec limiter (`-- <path>...`), via `resolvePathspec`. */
  readonly paths?: ReadonlyArray<string>;
}
```

`-w` is gated at the matcher level (not by injecting `\b` into the pattern) so it
works even in `extended`/`fixed` where `\b` is inert (pinned §F-w: `-w word`
matches the whole-word line under basic, extended, AND fixed).

```ts
export interface MatchSpan {
  readonly start: number;   // byte offset of the match within the line (0-based)
  readonly end: number;     // exclusive
}

export interface GrepLineHit {
  readonly lineNumber: number;          // 1-based, git's `-n`
  readonly line: Uint8Array;            // raw returned-line bytes (LF kept by splitLines)
  readonly spans: ReadonlyArray<MatchSpan>;  // match positions; EMPTY under `invert` (a returned line is a non-match)
}

export interface GrepPathResult {
  readonly path: FilePath;
  readonly hits: ReadonlyArray<GrepLineHit>;   // returned lines: matching lines, or non-matching lines under `invert`
  readonly binaryMatch: boolean;        // blob is binary AND contained a match (#G28); hits stays empty
}

export interface GrepResult {
  readonly paths: ReadonlyArray<GrepPathResult>;  // only paths with ≥1 hit (or binaryMatch)
}
```

The caller reconstructs every git rendering from these fields: `path:line:text`
(join `path`, `lineNumber`, decode `line`); `-c` (`hits.length` or sum of
`spans`); `-l` (`paths.map(p => p.path)`); `Binary file X matches` (`binaryMatch`);
`-o` only-matching (slice `line` by each `MatchSpan`). The library emits **no**
display string. `MatchSpan` positions also let a caller do `--color` highlighting
it could not do from a pre-rendered line.

### Invalid-pattern semantics (#G29)

`compileGrepPattern` validates per dialect and throws a structured error
(`invalidOption('pattern', <dialect+reason>)`, the helper at
`src/domain/commands/error.ts:381`) — never an uncaught engine throw, never a
silent non-match. A leading `*` is accepted (literal) in `basic`/`fixed` but
rejected in `extended` with git's "repetition-operator operand invalid" reason.
The exact error condition per dialect is pinned in the interop test, not recalled.

### Tier-1 surface-gate checklist (the full set this command trips)

1. `src/application/commands/grep.ts` — `grep(ctx, opts: GrepOptions): Promise<GrepResult>`.
2. `src/application/commands/index.ts` — barrel re-export of `grep` + `GrepOptions`,
   `GrepResult`, `GrepPathResult`, `GrepLineHit`, `MatchSpan`, `GrepPatternType`
   (insert alphabetically near `range-diff` / before `init`).
3. `src/repository.ts` — facade interface line
   `readonly grep: BindCtx<typeof commands.grep>;` (alphabetical, between `fetchMissing`
   and `init`) + the binding `grep: ((opts) => { guard(); return commands.grep(ctx, opts); }) as Repository['grep'],`
   (mirroring the `rangeDiff` binding at `src/repository.ts:532`).
4. `src/index.ts` — already forwards `./application/commands/index.js` (line 3) and
   `./public-types.js` (line 15); the new types re-export automatically. Confirm no
   manual edit needed.
5. `test/unit/repository/repository.test.ts:199` — add `'grep'` to the sorted
   command-key-set assertion (currently 41 keys incl. non-command keys; insert
   between `fetchMissing` and `init`).
6. `reports/api.json` — regenerate via `npm run check:doc-typedoc` (prepush gate;
   large typedoc-id diff is normal).
7. `test/parity/scenarios/grep.scenario.ts` + register in
   `test/parity/scenarios/index.ts` — cross-adapter (node/memory/browser) scenario,
   shape mirroring `range-diff.scenario.ts` (`Scenario<GrepScenarioResult>` with
   `inputs`, `expected`, `run`). Surfaces closed: `commands: grep`.
8. `README.md:46` — bump the Tier-1 count "38 Tier-1 commands" → "39".
9. `.size-limit.json` / `npm run check:size` — confirm the added bundle weight is
   within budget (rebuild fresh; stale `.wireit` chunk inflation is a known false
   positive — `rm -rf dist .wireit` before trusting a failure).
10. Doc-coverage page under `docs/use/commands/` (the doc-maintenance harness gates
    one page per Tier-1 command); authored in the docs phase.

Recent end-to-end references to imitate: `range-diff`, `whatchanged`, `blame`.

## Decision candidates

ADRs 226 / 249 / 077 / 378 / 382 fix the prime directive, structured-output rule,
linear-matcher discipline, the flat-enum option style, and the config-default
wiring. The choices below are the **new** load-bearing ones this feature
introduces. ≤3 alternatives each, with a recommendation; the user ratifies in the
ADR phase. **D3 and D2 are the two questions the brief flags as load-bearing.**

| # | Choice | Alternatives (≤3) | Recommendation | Why |
|---|---|---|---|---|
| D1 | Is `-P` / PCRE (`patternType: 'perl'`) in v1? | (a) **defer** — ship `basic`/`extended`/`fixed`; `'perl'` documented as a future enum value (lookahead/backref/`\d` from §G need a real PCRE engine, which is a large zero-dependency build); (b) ship `'perl'` mapped directly to JS `RegExp` (closest dialect, but NOT byte-equal to PCRE — `\d`/Unicode/possessive differ); (c) ship a purpose-built PCRE subset | **(a)** | PCRE is the one dialect where JS `RegExp` is *tempting but wrong* (mapping `-P` to `RegExp` reintroduces the exact unfaithfulness the brief warns against, just for a different mode); the three POSIX dialects are the faithful, fully-pinnable v1; `'perl'` slots into the enum later without breaking the surface. (b) would ship a mode that fails its own interop test on `\d`/Unicode edge cases; (c) is a second engine for a non-default mode — disproportionate now. |
| D2 | v1 command scope — targets + flags | (a) **full faithful v1, one PR**: working-tree + `--cached` + `<tree-ish>` targets; `basic`/`extended`/`fixed` dialects; `-i`/`-w`/`-v`/multi-`-e`; pathspec limiter; binary skip; `grep.patternType` facade config (ADR-382 wiring) — everything that is DATA, excluding only `-P` (D1) and rendering flags; (b) **tiered**: working-tree only + `basic`/`extended`/`fixed` + `-i`/`-w`/`-v` now, defer `--cached`/`<tree-ish>` + config; (c) **minimal**: working-tree + `basic`/`fixed` only, everything else deferred | **(a)** | the repo's working style lands a whole feature in one PR over follow-ups (auto-memory "discuss-follow-ups-first" default); the surface is large but cohesive — targets reuse existing primitives (`walkWorkingTree`/`readIndex`/`walkTree`), flags are per-line data decisions, and the grammar matrix already pins all three dialects, so deferring pieces would only fragment the interop suite. The one defensible deferral is `-P` (D1, its own engine). (b)/(c) split a coherent diffcore-style surface and leave the grammar half-pinned. |
| D3 | **Grammar engine** — how to honour BRE/ERE/fixed byte-faithfully, zero-dependency | (a) **dialect-aware translation layer to JS `RegExp`**: per-dialect metachar tables (BRE: `+?{}()|` literal, `\+\?\{\}\(\)\|` operator; ERE: inverse) + POSIX-class expansion (`[[:digit:]]`→`[0-9]`, `[[:alpha:]]`→`[A-Za-z]`, …) + **dialect-gated** GNU `\b\w\s\<\>` mapping (mapped in BRE, passed through literal in ERE — the §G15–G24 asymmetry) + fixed via literal byte scan; (b) **purpose-built NFA/Thompson interpreter** over bytes, no `RegExp` at all (matches the `compile-glob` ethos most exactly, guarantees linearity, but is a large new engine); (c) **reduced v1**: fixed-string scan + ERE-via-`RegExp` only, BRE deferred (BRE is the *default* and hardest) | **(a)** | (a) reuses the JS engine for the heavy lifting while the **translation table** is what makes it faithful — it is a finite, fully-pinnable transformation (the §G matrix IS the table's test oracle), and the dialect-gated GNU-escape handling is exactly what a naive single-`RegExp` mapping gets wrong. It is zero-dependency. The ReDoS risk JS `RegExp` carries must be bounded (see note) — that is the cost. (b) is the purest fit for ADR-077 and removes ReDoS entirely, but is a from-scratch regex engine for three dialects — large, and most of its value (linearity) can be bought more cheaply (note). (c) defers the **default** dialect — unacceptable: a `grep` whose default mode is unimplemented is not faithful from day one, the brief's core requirement. |
| D4 | Binary-blob match representation | (a) **`binaryMatch: boolean`** datum on the path entry, `hits` empty, line scan skipped (git default) — caller reconstructs `Binary file X matches`; (b) treat binary as text always (git's `-a`) and emit line hits; (c) omit binary blobs from the result entirely | **(a)** | #G28 pins git's default: a binary blob that matches is reported as a *blob-level* fact, not line hits; (a) ships that as structured data faithfully and lets a caller opt into `-a`-style text scanning later via a flag; (b) is git's non-default `-a`, wrong as the default; (c) loses the match signal (git's exit code is 0 — a match occurred). |
| D5 | Context lines (`-A`/`-B`/`-C`) in v1? | (a) **out of v1**, documented candidate — *which* lines are data but the grey area needs its own pinning; (b) ship as a structured `context: { before, after }` on each hit (the line set is data, the rendered `--` separator is not); (c) ship and return rendered context blocks | **(a)** | context lines are a genuine ADR-249 grey area (the line *set* is data, the layout is rendering) and orthogonal to the grammar question this backlog item is scoped to; deferring keeps the v1 surface about *matching* and lets context get its own pinned design. (b) is the eventual faithful shape but expands scope past the brief; (c) violates ADR-249 outright. |

**Note on D3 ReDoS bound.** If (a) is chosen, the JS-`RegExp` backend must be
fenced like every other untrusted-pattern surface in the repo: cap raw pattern
byte length (mirror `MAX_PATHSPEC_PATTERN_BYTES = 256`), cap the per-line scan, and
cap total bytes scanned — so a pathological translated pattern cannot hang the
event loop. This is the residual risk (b) would eliminate; the decision weighs
"reuse a mature engine + bound it" against "write a guaranteed-linear engine." The
user owns that trade-off.

## Test strategy

**Unit — `src/domain/grep/compile-pattern.test.ts`** (pure compiler/matcher).
Per-dialect truth tables drawn straight from the §G matrix:
- basic: `+?{}()|` literal (#G1,G3,G5,G7), `\+\?\{\}\(\)\|` operators (#G2,G4,G6,G8),
  `.` any-char (#G9), anchors (#G10,G11), leading-`*` literal (#G12), POSIX classes
  (#G13,G14), GNU `\b\w\s\<\>` active (#G15–G18);
- extended: `+?{}()|` operators (#G19–G22), `\+` literal (#G23), GNU escapes
  **inactive** (#G24a–c) — isolated guard tests per escape, since the asymmetry is
  the load-bearing bug a single mapping would introduce;
- fixed: everything literal (#G25–G27);
- flags: `-i` case-fold (#F1), `-w` whole-word (#F2,F5), `-v` invert (#F3);
- invalid patterns: leading-`*` accepted in basic, rejected in extended (#G29) —
  assert the structured error `.data.code` and reason, not just `toThrow`.

**Unit — `src/domain/grep/compile-pattern.properties.test.ts`** (`fast-check`,
ADR-134–136). The compiler is a **total function over an algebraic grammar** (lens
3) and the matcher is a **compositional matcher** (lens 2):
- `compileGrepPattern(p, …)` over the ASCII-no-NUL safe subset returns a callable
  matcher for every dialect (never throws on the safe subset — except the
  documented dialect-specific invalid forms, which are excluded from the generator);
- fixed-mode invariant: `matchLine` finds the pattern iff the pattern bytes are a
  substring of the line (independent oracle = `Uint8Array.indexOf`, not a copy of
  the SUT);
- `-i` idempotence: matching under case-fold is invariant to re-casing the pattern.
`numRuns` 100 (composition) / 200 (cheap fixed-mode round-trip). Examples stay
(literal git semantics); the property proves the grammar.

**Unit — `src/application/commands/grep.test.ts`** (mocked enumeration + `readBlob`):
target selection (working tree default / `--cached` / `<tree-ish>` — #T1–T4);
binary blob → `binaryMatch: true`, `hits` empty, no line scan (#G28, D4); pathspec
limiter scopes paths; multiple `-e` union (#F4); bounded-pool fan-out preserves
path order; `patternType` resolves `opts ?? config ?? 'basic'` (ADR-382 precedence
— isolated guard tests per rung: per-call present, config present, both absent).

**Unit — `test/unit/repository/repository.test.ts`**: `'grep'` present in the
sorted command-key set.

**Interop — `test/integration/grep-grammar-interop.test.ts`** (new, twin real-`git`
vs tsgit + frozen golden, mirroring `diff-whitespace-interop` /
`rename-similarity-interop`): build the §G fixture in real `git` and tsgit; for
each dialect × pattern × flag cell, assert tsgit's structured `GrepResult`
reconstructs git's decision:
- **which paths/lines match** (the §G + §T matrix) — reconstruct `path:line` from
  `paths[].hits[].lineNumber`;
- the **BRE/ERE GNU-escape asymmetry** (#G15–G18 match in basic, #G24a–c do NOT in
  extended) — the single most important interop cell;
- **`-c` / `-l` reconstruction** (#C1,C2) from `hits.length` / membership — pin that
  the derivation matches git without a rendering mode;
- **binary** (#G28) — `binaryMatch` reconstructs `Binary file X matches`;
- **targets** (#T1–T4) — working tree vs `--cached` vs `HEAD`;
- **invalid-pattern** (#G29) — dialect-specific error condition.
Compute git goldens with signing OFF, scrubbed `GIT_*`, `GIT_CONFIG_NOSYSTEM=1`,
isolated `HOME`, in a `mktemp -d` repo; pin `-c merge.conflictStyle` is N/A here.
Skips when `git` is absent.

**Parity — `test/parity/scenarios/grep.scenario.ts`**: a single basic-mode search
over a seeded blob runs identically on Node, memory, and browser (cross-adapter
only — parity does NOT prove faithfulness; the interop test does).

## Out of scope

- **`-P` / PCRE** unless D1 chooses otherwise — its own engine, and the one dialect
  where JS `RegExp` is unfaithful; slots into the `patternType` enum later.
- **Context lines `-A`/`-B`/`-C`** (D5) — ADR-249 grey area, own pinned design.
- **All rendering-only flags** — `-n`, `-h`/`-H`, `--heading`, `--color`,
  `--null`/`-z`, `-o` *formatting*, `--break`: their data (line numbers, offsets,
  match spans) ships in `GrepResult`; the *layout* is the caller's per ADR-249.
- **`-a` (treat binary as text)** as a v1 flag — the default binary-skip + the
  `binaryMatch` datum ship; an opt-in text-scan flag can follow (D4 keeps the door
  open).
- **`grep.patternType` read from on-disk `.git/config`** — the `RepositoryConfig`
  key (if D2(a)/ADR-382) is a **programmatic facade default**, not git's on-disk
  config; mapping `.git/config` → facade is a separate concern (same boundary the
  whitespace design drew).
- **`--all-match`, `--and`/`--or`/`--not` boolean trees, `-f <file>`** pattern
  composition — multi-pattern OR (`-e ... -e ...`) ships; the full boolean grammar
  is a later expansion.
- **`git grep` over a `log` history walk / `--no-index`** — the per-blob matcher is
  reusable, but multi-commit / outside-repo search is not this command.
