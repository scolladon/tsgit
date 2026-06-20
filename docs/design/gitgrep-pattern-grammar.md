# Design — gitGrep pattern grammar

> Brief: build a new Tier-1 `grep` command. The original brief asked for a
> **faithful POSIX BRE/ERE pattern grammar from day one**; the ratified decision
> (ADR-395) instead **diverges the grammar to JavaScript `RegExp`** — a conscious
> fork from the prime directive (ADR-226), scoped to the grammar dimension only. The
> pattern **is** a JS `RegExp` (flags ride on it), with a fixed-string form for
> literal search. There is **no POSIX BRE/ERE engine and no `patternType` enum in
> v1**. Everything outside the grammar — targets, binary handling, line numbering,
> structured output — stays byte-faithful to git and remains interop-pinned. The v1
> command surface (targets / data flags / binary datum / context deferral) is fixed
> by ADR-396, structured-data per ADR-249.
> Status: revised against ADR-395 / ADR-396 → self-reviewed ×3 → decisions resolved

## Context

There is **no `grep` command in tsgit today** — `git grep`, `git ls-files`, and any
content-search surface are absent. Nothing in the codebase compiles a search
pattern, so this design introduces both the command and the matcher.
Because nothing renders `path:line:text`, the command is greenfield with respect
to ADR-249: it ships structured matches from the start, with zero rendering debt
to sweep.

The matcher itself is **not** a new engine — it is V8's `RegExp` (ADR-395). The
design work is therefore (a) the byte-offset bridge from a UTF-16 `RegExp` to byte
spans over a `Uint8Array` line, (b) the option/result shapes, and (c) the
git-faithful target/binary/line-numbering half that stays interop-pinned.

The feature reuses three established subsystems:

**Text primitives (domain tier).** `src/domain/diff/line-diff.ts` exports
`splitLines(bytes: Uint8Array): ReadonlyArray<Uint8Array>` (splits on LF, each line
**keeps** its trailing LF, a final unterminated run is included) and
`isBinary(bytes): boolean` with caps `BINARY_DETECTION_BYTES = 8000`,
`MAX_LINE_BYTES = 65_536`, `MAX_LINES = 100_000`. Both are already re-exported from
`src/domain/diff/index.ts`. git grep skips binary blobs by default; tsgit reuses
`isBinary` for the same decision. These caps are also the **ReDoS ceiling** — see
"ReDoS is the caller's concern" below.

**The pathspec path limiter (application tier).** The `-- <path>` limiter reuses
`src/application/commands/internal/resolve-pathspec.ts` (`resolvePathspec`, budget
`MAX_PATHSPEC_PATTERN_BYTES = 256`) directly. (The earlier design also cited
`compile-glob` as the *content*-matcher ethos to imitate; with the grammar now
delegated to `RegExp`, `compile-glob` is no longer a model for the content matcher
— it remains only the engine behind the pathspec limiter.)

**Target enumeration + blob reading (primitive tier).**
`walkWorkingTree(ctx, options?): AsyncIterable<WalkWorkingTreeEntry>` (entry =
`{ path: FilePath; stat: FileStat }`, ignore-aware, embedded-repo-gated) for the
working-tree target; `walkTree(ctx, treeIdOrObject, options?):
AsyncIterable<WalkTreeEntry>` (recursive, `{ path, id, mode }`) for a `<tree-ish>`;
`readIndex(ctx): Promise<GitIndex>` for `--cached`; `readHeadTree(ctx):
Promise<FlatTree | undefined>` for HEAD; `readBlob(ctx, id, options?):
Promise<Blob>` (`Blob.content: Uint8Array`) to load contents. All five are exported
from `src/application/primitives/index.ts`. The bounded-concurrency fan-out pattern
(`MAX_CONCURRENT_BLOB_LOADS` worker pool) is established in
`src/application/primitives/materialise-patch-files.ts` and `range-diff.ts`.

### Constraining decisions (FIXED — not re-litigated here)

| ADR / rule | Decision this design must implement |
|---|---|
| 395 (grammar diverges to JS `RegExp`) | The pattern **is** a JS `RegExp` for regex search, with a **fixed-string** form for literal search. **No** POSIX BRE/ERE engine, **no** `patternType` enum, **no** `ignoreCase` option (case-fold rides on the `RegExp`'s `i` flag). A conscious divergence from ADR-226, grammar dimension only; reversible by a future `patternType` enum if a consumer ever needs POSIX parity. |
| 396 (v1 command surface) | Targets: working tree (default) + `--cached` + `<tree-ish>`. Data flags: whole-word `-w`, invert `-v`, multi-pattern OR. Case rides on the `RegExp`. Binary = a `binaryMatch` datum, line scan skipped. Context lines `-A`/`-B`/`-C` are **out of v1**. |
| 226 / CLAUDE.md (prime directive) | Replicate git's observable behaviour byte-for-byte for the **non-grammar** half: which blob/line each target exposes, binary skip + `binaryMatch`, 1-based line numbering, structured output. Pin against real `git`, never recall. ADR-395 is the **only** sanctioned divergence and only for grammar. |
| 249 (structured data, not cosmetics) | `grep` returns **structured matches** (path, 1-based line number, raw line bytes, byte-offset spans; counts/name-only *derived* from `hits`, not stored), never a rendered `path:line:text` line. Rendering-only options (`-n`, `--color`, `-h`, `--heading`, `--null`, `-o` formatting) MUST NOT exist on the surface. The `Binary file X matches` text and the `-c`/`-l` layout are reconstructed by the caller from the data. |
| 077 (linear glob matcher) | Applies to the **pathspec limiter** (`resolvePathspec`/`compile-glob`), which stays linear and ReDoS-proof. It does **not** apply to the content matcher: the content `RegExp` is the caller's, and its complexity is the caller's concern (ADR-395). Zero-dependency hard constraint still holds — `RegExp` is a V8 builtin, no npm regex dependency. |

## Requirements

What must be true when this ships:

1. `grep` searches a chosen target and returns **structured** matches per ADR-249:
   for each path, the matching lines with their **line number (1-based)**, the
   **matched line bytes** (raw, with no trailing-LF normalization beyond what
   `splitLines` keeps), and the **byte offset(s)** of each match within the line.
   It never returns a rendered line.
2. The search pattern is a **JavaScript `RegExp`** for regex search OR a
   **fixed-string** form for literal substring search (ADR-395). A caller passing a
   `RegExp` gets JS-`RegExp` semantics; the fixed form is a literal byte search with
   no metacharacter meaning. Multiple patterns **OR-combine** (a line matches if any
   pattern matches; #F4).
3. Case-insensitivity, dotall, multiline, and unicode ride on the `RegExp`'s own
   flags — they are **not** re-exposed as command options. There is **no**
   `ignoreCase` option and **no** `patternType` enum (ADR-395).
4. A match span is reported as **byte offsets** into the raw line `Uint8Array`
   (0-based `start`, exclusive `end`), correct even though `RegExp` is a UTF-16
   engine — pinned in "Byte-offset bridge" below (so `line.slice(start, end)` is the
   matched bytes).
5. Search targets: working tree (default), `--cached` (index blobs), and a
   `<tree-ish>` (commit-or-tree) — all three in v1 (ADR-396, #T1–T4).
6. Binary blobs are **skipped from line-level matching by default** (git's
   default); a binary blob that *contained* a match is recorded as a distinct datum
   (`binaryMatch: true` on the path entry, `hits` empty), so a caller can
   reconstruct git's `Binary file X matches` line without the library emitting it
   (#B1).
7. Data-not-rendering flags are honoured: **whole-word** (`-w`, gated at matcher
   level so it works for both the `RegExp` and the fixed form), **invert** (`-v`,
   lines NOT matching), and **multi-pattern OR** (`-e … -e …`). (ADR-396.)
8. Path limiting via pathspec (`-- <path>...`) reuses `resolvePathspec`.
9. The git-faithful half is pinned by a cross-tool interop test
   (`test/integration/grep-interop.test.ts`) that reconstructs git grep's
   **target/binary/line-numbering** decisions from the structured fields (twin
   real-`git` vs tsgit + frozen golden). **Grammar is NOT pinned against `git
   grep`** — the grammar is JS `RegExp`, and pinning V8 against V8 proves nothing
   (ADR-395).

## Design

### Layering — pure matcher + primitive orchestrator

The feature splits a pure matcher (no I/O) from an I/O orchestrator, mirroring the
diff primitives:

```
grep command (ctx, opts)                         ← application/commands/grep.ts
  │  resolve target (working tree | --cached | <tree-ish>)
  │  resolve pathspec limiter (resolvePathspec)
  │
  ├─ buildGrepMatcher(patterns, { wholeWord, invert })   ← domain/grep/matcher.ts (PURE)
  │     └─ returns GrepMatcher { matchLine(bytes): LineVerdict }   // { returned, spans }
  │        regex form  → regexp.exec / matchAll over the latin1 view, byte spans
  │        fixed form  → Uint8Array byte scan (indexOf loop)
  │
  └─ for each enumerated blob (bounded pool):
        readBlob → isBinary?  yes → record binaryMatch datum (no line scan)
                              no  → splitLines → matcher.matchLine per line → collect GrepLineHit
```

- **Domain (pure, no I/O):** `src/domain/grep/matcher.ts`. `buildGrepMatcher(patterns,
  opts): GrepMatcher` builds a per-line matcher from the supplied patterns (each
  either a `RegExp` or a fixed-string form) plus the matcher-level `wholeWord` /
  `invert` gating. `GrepMatcher.matchLine(line: Uint8Array): LineVerdict` returns a
  **verdict**, not a bare span array, because an empty span array is otherwise
  ambiguous between "no match, drop the line" (non-invert) and "non-match, return the
  line with no spans" (invert). The verdict is `{ returned: boolean; spans:
  ReadonlyArray<MatchSpan> }`: non-invert ⇒ `returned = spans.length > 0`; invert ⇒
  `returned = spans.length === 0` and the returned `spans` is empty. The command layer
  keeps a hit iff `returned` is true and emits `verdict.spans` as the hit's spans.
  There is **no** `compileGrepPattern` / dialect compiler — V8 owns the regex
  compilation (ADR-395).
- **Application / command (I/O orchestrator):** `src/application/commands/grep.ts`
  owns target resolution, the bounded blob-read pool, binary gating, and assembly
  of the structured `GrepResult`. It reuses the existing primitives listed in
  Context — no new I/O primitive is required (a `grep` is read-only enumeration +
  `readBlob`, both already available).

### Byte-offset bridge — UTF-16 `RegExp` over a byte line (the one subtle correctness item)

A JS `RegExp` indexes in **UTF-16 code units**; `MatchSpan` must report **byte
offsets** into the raw line `Uint8Array` (requirement 4). For arbitrary UTF-8 content these
two index spaces differ (a 3-byte `é`-class code point is 1–2 code units), so
`regexp.exec(decodeUtf8(line)).index` is **not** a byte offset.

**Decision (D6, below): decode each line `latin1` (ISO-8859-1) before matching.**
latin1 maps each byte 0x00–0xFF to exactly one UTF-16 code unit (`String.fromCharCode(b)`),
so the decoded string has **one code unit per input byte** and `RegExp` indices are
**byte offsets by construction** — no remapping table needed. The matcher decodes
`line` to a latin1 string once, runs `regexp.exec`/`matchAll` (using the global
flag for all spans on a line), and the `.index`/`.index + match[0].length` it
returns are directly the byte `start`/`end`. The `line: Uint8Array` returned in the
hit stays **raw bytes** — only the matcher's internal view is latin1; the caller
decodes the bytes with whatever encoding it wants.

Consequences and their handling:

- **`.` / `\w` / `\s` / `\b` over multi-byte UTF-8.** Under latin1 each UTF-8
  continuation byte is its own code unit, so `.` matches one *byte* of a multi-byte
  sequence, not one code point, and `\w`/`\b` see raw bytes. This is **byte-oriented
  matching** — the same model `git grep` uses (glibc `regexec` over bytes in a
  non-UTF-8 locale) and the natural model for a byte-faithful content search.
  Callers wanting code-point semantics over UTF-8 own that translation (consistent
  with ADR-395 putting grammar in the caller's hands). Documented, not papered over.
- **The `u` (unicode) `RegExp` flag is incompatible with the latin1-byte view** — a
  `u`-flagged regex asserts code-point semantics the byte view cannot honour. The
  command rejects a `u`-flagged pattern with a structured `INVALID_OPTION`-class
  error (reason: "unicode flag unsupported over byte content"); this is a guarded,
  pinned refusal, not a silent mis-match. (`i`, `m`, `s` ride through unchanged; `g`
  and `y` are normalized by the internal clone below.)
- **The matcher forces the `g` flag internally** for `matchAll`/repeated `exec`
  (cloning the caller's `RegExp` with `flags + 'g'` and `'y'` stripped — sticky
  anchoring would otherwise drop non-leftmost spans), so a non-global caller
  `RegExp` still yields **all** spans on a line, and the caller's own object is never
  mutated and its `lastIndex` is never read or written (immutability — never mutate
  the caller's `RegExp`).

### Matcher-level `-w` and `-v` (work for both forms)

- **whole-word (`-w`)** gates a candidate span: a span at `[start, end)` survives
  only if the byte before `start` is not a word byte and the byte at `end` is not a
  word byte (git's `-w` is a boundary gate on the match, not a `\b` injection — and
  `\b` would be inert in the fixed form anyway). Applied identically to regex-form
  and fixed-form spans, so `-w` works for both (the ADR-396 requirement). Word-byte
  class is git's `[A-Za-z0-9_]` over bytes.
- **invert (`-v`)** flips the per-line verdict: a line is *returned* iff it has **no**
  surviving span. An inverted hit carries the line with an **empty** `spans` array
  (a returned line under `-v` is by definition a non-match). Multi-pattern OR is
  computed *before* inversion — `-v` excludes lines matching **any** pattern.

### Pinned target + binary + line-numbering matrix (the faithful half)

`git grep` over a working tree with a staged-but-uncommitted change `staged_only`,
a working-tree-only unstaged change `wt_only_unstaged`, plus the committed fixture.
Pinned against real `git version 2.54.0`, scrubbed `GIT_*`, `GIT_CONFIG_NOSYSTEM=1`,
isolated `HOME`, signing off, throwaway `mktemp -d` repo. **These cells are
grammar-independent** — they hold for any pattern, so a trivial literal pattern
pins them.

| # | Invocation | git decision | Load-bearing fact |
|---|---|---|---|
| T1 | (default) on `wt_only_unstaged` | matches | default target = **working tree** (unstaged content visible) |
| T2 | `--cached` on `staged_only` | matches | `--cached` = **index** blobs (staged content) |
| T3 | `--cached` on `wt_only_unstaged` | no match | index does not carry the unstaged change |
| T4 | `HEAD` on `staged_only` | no match | `<tree-ish>` = committed tree only |
| L1 | match on line 12 of a multi-line blob | reports line 12 | **1-based** line numbering |
| M1 | one pattern hitting 3 of 5 enumerated paths | 3 path entries, ignore-walk order | multi-path enumeration + ordering |
| B1 | a literal that occurs in a blob with a NUL byte | prints `Binary file b.bin matches`; line scan skipped | binary skipped by default; the *datum* is "blob matched", not a printed line |

`-c` (per-file count) and `-l` (name-only) are **derivable from the structured
result** — `hits.length` (git's `-c` counts matching *lines*, one per line
regardless of how many spans it carries) and `hits.length > 0` reconstruct `-c` and
`-l` without the library shipping those as rendering modes (ADR-249, exactly as the
whitespace design derives the numstat-omit rule rather than adding a `suppressed`
flag). No `matchCount` field is added — it would be redundant denormalization of
`hits`.

### Deliberate divergence — what we do NOT do, and why (ADR-395)

This is the parity we **consciously decline**, recorded so the divergence is
legible, not a spec we implement:

- git grep's **default grammar is POSIX BRE** (`+ ? { } ( ) |` literal unless
  backslash-escaped; `\( \)` group, `\{m,n\}` interval). We do **not** reproduce it —
  the pattern is JS `RegExp`, where `/a+/` is one-or-more, not a literal `a+`. A
  caller wanting BRE's "literal `a+`" must pass the fixed form or escape it as JS.
- git's BRE/ERE carry a **load-bearing GNU-escape asymmetry** (`\b \w \s \< \>`
  honoured in BRE, inert in ERE). We do **not** implement either side; JS `RegExp`
  honours `\b \w \s` uniformly, and that is the documented behaviour.
- `-P` / PCRE, `-E` / ERE, `-F`-as-a-dialect-toggle: there are **no dialects**. One
  regex form (JS `RegExp`) + one literal form (fixed string). A future `patternType`
  enum can add POSIX modes without breaking the v1 surface if a consumer ever needs
  parity (ADR-395 "reversible by extension").

The empirical BRE/ERE/fixed grammar matrix that the *original* design pinned (29
rows of glibc `regcomp` behaviour) is **deleted** — it described an engine we are
not building. It is preserved only in git history and in ADR-395's context section
as the rationale for declining.

### Option + result shapes (ADR-249 + ADR-395)

One flat options interface (ADR-378 style). The pattern input type is the
load-bearing sub-decision **D7** (below); the shape here uses the recommended
`ReadonlyArray<RegExp | GrepFixedPattern>` form.

```ts
/** A literal-substring pattern (git's -F). The bytes are searched verbatim;
 *  no metacharacter is special. Distinct nominal shape so a caller cannot confuse
 *  a literal string with a stringified regex. */
export interface GrepFixedPattern {
  readonly fixed: string;   // matched as UTF-8 bytes against the line
}

export type GrepPattern = RegExp | GrepFixedPattern;

export interface GrepOptions {
  /** Patterns to search for. ≥1 required; multiple OR-combine (git's `-e … -e …`, #F4).
   *  A RegExp ⇒ JS-RegExp search; a GrepFixedPattern ⇒ literal byte search (ADR-395).
   *  A `u`-flagged RegExp is rejected (byte-content incompatibility, see byte-offset bridge). */
  readonly patterns: ReadonlyArray<GrepPattern>;
  /** Whole-word gating (`-w`, #F2) — applied at the matcher level for BOTH the
   *  RegExp and the fixed form (ADR-396). */
  readonly wholeWord?: boolean;
  /** Invert: return lines that do NOT match (`-v`, #F3). */
  readonly invert?: boolean;
  /** Target. Absent ⇒ working tree; `'index'` ⇒ `--cached`; a rev string ⇒ `<tree-ish>`. */
  readonly target?: 'index' | { readonly treeish: string };
  /** Pathspec limiter (`-- <path>...`), via `resolvePathspec`. */
  readonly paths?: ReadonlyArray<string>;
}
```

**Removed vs the original design** (per ADR-395): `patternType` (no dialect enum)
and `ignoreCase` (case-fold rides on the `RegExp`'s `i` flag — a caller writes
`/word/i`, not `{ ignoreCase: true }`). The fixed form has no case option; a
case-insensitive *literal* search is expressed as a `RegExp` of the escaped literal
with `i`, which is the idiomatic JS way and keeps one source of truth for casing.

```ts
export interface MatchSpan {
  readonly start: number;   // BYTE offset of the match within the line (0-based)
  readonly end: number;     // exclusive BYTE offset
}

export interface GrepLineHit {
  readonly lineNumber: number;          // 1-based, git's `-n`
  readonly line: Uint8Array;            // raw returned-line bytes (LF kept by splitLines)
  readonly spans: ReadonlyArray<MatchSpan>;  // match positions; EMPTY under `invert` (a returned line is a non-match)
}

export interface GrepPathResult {
  readonly path: FilePath;
  readonly hits: ReadonlyArray<GrepLineHit>;   // returned lines: matching lines, or non-matching lines under `invert`
  readonly binaryMatch: boolean;        // blob is binary AND contained a match (#B1); hits stays empty
}

export interface GrepResult {
  readonly paths: ReadonlyArray<GrepPathResult>;  // only paths with ≥1 hit (or binaryMatch)
}
```

The result shape is **unchanged** from the original design (ADR-396 leaves it
intact). The caller reconstructs every git rendering from these fields:
`path:line:text` (join `path`, `lineNumber`, decode `line`); `-c` (`hits.length`);
`-l` (`paths.map(p => p.path)`); `Binary file X matches` (`binaryMatch`); `-o`
only-matching (slice `line` by each `MatchSpan`). The library emits **no** display
string. `MatchSpan` byte positions also let a caller do `--color` highlighting it
could not do from a pre-rendered line.

### Invalid-input semantics

There is **no dialect-specific invalid-pattern condition** to pin (no BRE/ERE
engine). The only structured refusals the command raises:

- a `u`-flagged `RegExp` (byte-content incompatibility, above) →
  `invalidOption('pattern', '<reason>')` (helper at
  `src/domain/commands/error.ts:381`);
- `patterns` empty → `invalidOption('patterns', 'at least one pattern required')`;
- an unresolvable `target` treeish → the existing rev-resolution error from the
  primitive layer (not grep-specific).

A *malformed* regex never reaches the matcher — the caller constructs the `RegExp`,
so `new RegExp('(')` throws in **their** code before `grep` is called. The library
does not compile patterns, so there is no compile-error surface of its own beyond
the `u`-flag guard.

### ReDoS is the caller's concern (ADR-395), not a pattern fence

The earlier design proposed a pattern-length/scan fence around a translated
`RegExp`. With ADR-395 that fence is **removed**: the caller supplies their own
`RegExp`, so its complexity (catastrophic backtracking, nested quantifiers) is
**their** responsibility, exactly as it is for any JS code that calls
`userRegexp.test(s)`. The library still bounds the **input it controls** via the
existing diff caps — `MAX_LINE_BYTES = 65_536` (no single line exceeds this; longer
content trips `isBinary` and is skipped) and `isBinary`/`BINARY_DETECTION_BYTES`
(binary blobs are skipped wholesale). There is **no** grep-specific
`MAX_PATTERN_BYTES`; the pathspec limiter keeps its own `MAX_PATHSPEC_PATTERN_BYTES
= 256` (that is the *path* glob, still linear under ADR-077, unaffected).

### Tier-1 surface-gate checklist (the full set this command trips)

1. `src/application/commands/grep.ts` — `grep(ctx, opts: GrepOptions): Promise<GrepResult>`.
2. `src/application/commands/index.ts` — barrel re-export of `grep` + `GrepOptions`,
   `GrepResult`, `GrepPathResult`, `GrepLineHit`, `MatchSpan`, `GrepPattern`,
   `GrepFixedPattern` (insert alphabetically near `range-diff` / before `init`).
3. `src/repository.ts` — facade interface line
   `readonly grep: BindCtx<typeof commands.grep>;` (alphabetical, between `fetchMissing`
   and `init`) + the binding `grep: ((opts) => { guard(); return commands.grep(ctx, opts); }) as Repository['grep'],`
   (mirroring the `rangeDiff` binding at `src/repository.ts:532`).
4. `src/index.ts` — already forwards `./application/commands/index.js` and
   `./public-types.js`; the new types re-export automatically. Confirm no manual edit.
5. `test/unit/repository/repository.test.ts:215` — add `'grep'` to the sorted
   command-key-set assertion (insert between `'fetchMissing'` and `'init'`).
6. `reports/api.json` — regenerate via `npm run check:doc-typedoc` (prepush gate;
   large typedoc-id diff is normal).
7. `test/parity/scenarios/grep.scenario.ts` + register in
   `test/parity/scenarios/index.ts` — cross-adapter (node/memory/browser) scenario,
   shape mirroring `range-diff.scenario.ts` (`Scenario<GrepScenarioResult>` with
   `inputs`, `expected`, `run`). Surfaces closed: `commands: grep`.
8. `README.md:46` — bump the Tier-1 count "38 Tier-1 commands" → "39".
9. `.size-limit.json` / `npm run check:size` — confirm the added bundle weight is
   within budget (rebuild fresh; stale `.wireit` chunk inflation is a known false
   positive — `rm -rf dist .wireit` before trusting a failure). Bundle is *smaller*
   than the original design's transpiler would have been — the matcher is essentially
   `regexp.exec` + a byte scan.
10. Doc-coverage page under `docs/use/commands/` (the doc-maintenance harness gates
    one page per Tier-1 command); authored in the docs phase.

**Primitive reuse list (confirmed exported from `src/application/primitives/index.ts`):**
`walkWorkingTree` (working-tree target), `walkTree` (`<tree-ish>` target),
`readIndex` (`--cached`), `readHeadTree` (HEAD resolution), `readBlob` (contents).
Domain reuse: `splitLines`, `isBinary` (from `src/domain/diff/index.ts`). No new I/O
primitive.

Recent end-to-end references to imitate: `range-diff`, `whatchanged`, `blame`.

## Decision candidates

ADR-395 (grammar diverges to JS `RegExp`) and ADR-396 (v1 surface) are **ratified
and committed** — they resolve the five original load-bearing questions. Marked
below. Two **new** sub-decisions surface from the divergence (the byte-offset bridge
and the exact pattern-input type); both carry a recommendation for the user to
ratify.

| # | Choice | Status / resolution |
|---|---|---|
| D1 | `-P` / PCRE in v1? | **RESOLVED — N/A (ADR-395).** No dialects at all; the grammar is JS `RegExp`. PCRE-style features (lookahead, backref) come from `RegExp` for free where they overlap; there is no separate `'perl'` mode to ship or defer. A future `patternType` enum can add POSIX/PCRE modes if needed. |
| D2 | v1 command scope — targets + flags | **RESOLVED (ADR-396).** Working-tree + `--cached` + `<tree-ish>` targets; `-w` / `-v` / multi-pattern OR data flags; pathspec limiter; binary skip + `binaryMatch`. Case rides on the `RegExp` (no `-i` option). Context lines out of v1. |
| D3 | Grammar engine (BRE/ERE/fixed faithfulness) | **RESOLVED — superseded (ADR-395).** The translation-vs-interpreter-vs-reduced question is moot: the grammar **diverges to JS `RegExp`**, no POSIX engine is built. The matcher is `regexp.exec`/`matchAll` (regex form) + a `Uint8Array` byte scan (fixed form). |
| D4 | Binary-blob match representation | **RESOLVED (ADR-396).** `binaryMatch: boolean` datum, `hits` empty, line scan skipped — git's default; caller reconstructs `Binary file X matches`. |
| D5 | Context lines (`-A`/`-B`/`-C`) in v1? | **RESOLVED (ADR-396).** Out of v1; documented candidate for its own pinned design (overlapping-window merge is observable and earns separate pinning). |
| **D6** | **Byte-offset bridge: how a UTF-16 `RegExp` yields BYTE spans over a `Uint8Array` line** | (a) **latin1-decode the line** (1 byte ↔ 1 code unit ⇒ `RegExp` indices ARE byte offsets); reject `u`-flag; `.` matches a byte (git-like byte matching). (b) UTF-8-decode + maintain a code-unit→byte offset map per line and remap every `.index`. (c) UTF-8-decode and report **code-unit** offsets, documenting that spans are not byte offsets. **Recommendation: (a)** — zero remapping, byte-faithful to git's byte-oriented `regexec`, simplest and fastest; the `u`-flag refusal is a small pinned guard. (b) is correct but adds a per-line offset table and remap cost for no faithfulness gain over (a). (c) violates requirement R4 (spans must be byte offsets so `line.slice(start,end)` is valid). |
| **D7** | **Exact pattern-input type** | (a) **`ReadonlyArray<RegExp \| GrepFixedPattern>`** — a `RegExp` for regex, a `{ fixed: string }` nominal shape for literal; both forms first-class, OR-combined. (b) `RegExp`-only — force callers to escape literals into a `RegExp` themselves (drops the `-F` ergonomic; `RegExp.escape` is not universally available). (c) also accept a bare `string` as a third form — ambiguous (is `"a+"` literal or regex?), reintroducing exactly the confusion ADR-395 closes. **Recommendation: (a)** — matches ADR-395's "input is a `RegExp`, with a fixed-string form for literal search" verbatim; the nominal `{ fixed }` wrapper makes literal-vs-regex unambiguous at the type level (a caller cannot be silently misled). (b) is leaner but loses the literal ergonomic ADR-395 explicitly preserves. (c) is the ambiguity the divergence exists to kill. |

Both D6 and D7 are genuinely load-bearing (one is the single subtle correctness
item; the other is the public option type), so they are surfaced for ratification
rather than decided here. No other open decision remains — the grammar engine,
targets, flags, binary, and context questions are all closed by the two ADRs.

## Test strategy

The test suite **rebalances** to match the divergence: the interop test pins **only
the git-faithful half**; grammar is proven by JS-`RegExp`-vs-invariant property and
example tests, never against `git grep`.

**Unit — `src/domain/grep/matcher.test.ts`** (pure matcher).
- regex form: byte spans from `regexp.exec`/`matchAll` over a latin1 view (single
  span, multiple spans on a line, no match);
- byte-offset correctness over multi-byte UTF-8: `line.slice(span.start, span.end)`
  equals the matched bytes even when earlier bytes were multi-byte (the load-bearing
  D6 correctness item — isolated test);
- `u`-flag refusal: a `u`-flagged `RegExp` throws the structured `INVALID_OPTION`
  error — assert `.data.code` and reason, not just `toThrow`;
- caller-`RegExp` immutability: a non-global caller `RegExp` yields all spans AND its
  `lastIndex` is unchanged after `matchLine` (guards the internal `g`-flag clone);
- fixed form: literal byte match incl. patterns containing regex metacharacters
  (`a+`, `x.y`, `star*lit`) matched **literally** (no metachar meaning);
- `-w` whole-word: boundary gating for both regex and fixed form, isolated tests for
  the left-boundary and right-boundary guards independently (mutation-resistant
  guard-clause discipline);
- `-v` invert: a returned line carries empty `spans`; OR-then-invert order (a line
  matching *any* pattern is excluded);
- multi-pattern OR: union of single-pattern spans, de-duplicated/ordered.

**Unit — `src/domain/grep/matcher.properties.test.ts`** (`fast-check`, ADR-134–136).
The matcher is a **compositional matcher** (lens 2) and the fixed form is a
substring searcher with an independent oracle (lens 2). Drop the original BRE/ERE
GNU-escape-asymmetry properties (no dialects exist). Keep / add — all invariants
that are **NOT** tautological against V8:
- **fixed-mode substring invariant** (kept): `matchLine` finds the fixed pattern iff
  its bytes are a substring of the line — independent oracle `Uint8Array.indexOf`,
  not a copy of the SUT (lens 2). `numRuns` 200 (cheap).
- **invert is the set-complement per line**: for any line + pattern set, the set of
  lines returned under `invert` is exactly the lines with no surviving span under
  non-invert (computed via the non-inverted matcher as the oracle — independent of
  the invert code path). `numRuns` 100.
- **multi-pattern OR is the union**: the span set for `[p, q]` equals the union of
  the span sets for `[p]` and `[q]` (oracle = two single-pattern matchers). `numRuns`
  100.
- **`wholeWord` gating soundness**: every span surviving `-w` has a non-word byte (or
  string edge) on both sides — verified directly against the line bytes, not against
  the matcher's own gate. `numRuns` 100.
- **byte-offset round-trip**: for any returned span, `line.slice(start, end)`
  re-found by the same pattern (the span indexes back into the line correctly — the
  D6 invariant). `numRuns` 100.

These are real invariants, not V8-vs-V8 tautologies (none re-implements
`regexp.exec` as the oracle). Per the repo's property-test rule, the fixed-form
matcher is a matcher/decoder that **must** ship a `*.properties.test.ts` sibling —
it does.

**Unit — `src/application/commands/grep.test.ts`** (mocked enumeration + `readBlob`):
target selection (working tree default / `--cached` / `<tree-ish>` — #T1–T4);
binary blob → `binaryMatch: true`, `hits` empty, no line scan (#B1, D4); pathspec
limiter scopes paths; multiple patterns union (#F4); bounded-pool fan-out preserves
path order (#M1); 1-based line numbering (#L1).

**Unit — `test/unit/repository/repository.test.ts`**: `'grep'` present in the
sorted command-key set.

**Interop — `test/integration/grep-interop.test.ts`** (renamed from
`grep-grammar-interop.test.ts` — "grammar" is now a misnomer, since the interop test
**does not** pin grammar). Twin real-`git` vs tsgit + frozen golden, mirroring
`diff-whitespace-interop`. Pins **only the git-faithful half**:
- **which paths/lines each target exposes** — working tree (#T1) vs `--cached`
  (#T2,T3) vs `HEAD`/`<tree-ish>` (#T4), reconstructing `path:line` from
  `paths[].hits[].lineNumber`;
- **binary** (#B1) — `binaryMatch` reconstructs `Binary file X matches` (exit 0);
- **1-based line numbering** (#L1) and **multi-path enumeration order** (#M1);
- **`-c` / `-l` reconstruction** (#C-derive) from `hits.length` / membership — pin
  the derivation matches git without a rendering mode.

It uses a **trivial literal pattern** for every cell (the cells are
grammar-independent). It does **NOT** pin any regex grammar against `git grep` — the
grammar is JS `RegExp`, and `git grep` runs glibc `regcomp`; comparing them would
either fail (correctly, by divergence) or, for a literal, prove nothing about the
grammar. Stated explicitly in the test header. Compute git goldens with signing
OFF, scrubbed `GIT_*`, `GIT_CONFIG_NOSYSTEM=1`, isolated `HOME`, in a `mktemp -d`
repo. Skips when `git` is absent. (`-c merge.conflictStyle` is N/A here.)

**Parity — `test/parity/scenarios/grep.scenario.ts`**: a single regex-form search
over a seeded blob runs identically on Node, memory, and browser (cross-adapter
only — parity does NOT prove faithfulness; the interop test pins the faithful half).

## Out of scope

- **POSIX BRE/ERE dialects and the `patternType` enum** — the grammar is JS `RegExp`
  (ADR-395). A future `patternType` enum can add faithful POSIX/PCRE modes without
  breaking the v1 surface if a consumer needs git-grammar parity.
- **`-i` / `ignoreCase` as a command option** — case-fold rides on the caller's
  `RegExp` `i` flag (ADR-395); there is no command-level case option.
- **`u` (unicode) `RegExp` flag** — incompatible with the latin1-byte view; rejected
  with a structured error (D6). Code-point-semantic UTF-8 matching is the caller's
  concern.
- **Context lines `-A`/`-B`/`-C`** (ADR-396) — ADR-249 grey area, own pinned design.
- **All rendering-only flags** — `-n`, `-h`/`-H`, `--heading`, `--color`,
  `--null`/`-z`, `-o` *formatting*, `--break`: their data (line numbers, offsets,
  match spans) ships in `GrepResult`; the *layout* is the caller's per ADR-249.
- **`-a` (treat binary as text)** as a v1 flag — the default binary-skip + the
  `binaryMatch` datum ship; an opt-in text-scan flag can follow (ADR-396 keeps the
  door open).
- **`--all-match`, `--and`/`--or`/`--not` boolean trees, `-f <file>`** pattern
  composition — multi-pattern OR ships; the full boolean grammar is a later
  expansion.
- **`git grep` over a `log` history walk / `--no-index`** — the per-blob matcher is
  reusable, but multi-commit / outside-repo search is not this command.
