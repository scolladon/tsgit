# Design — git-config quoted-value (un)escaping

## Goal

Close the faithfulness gap in the shared git-config parser and writer (backlog 24.9c, surfaced by 24.9 when a merge-driver command containing `;` was mangled on read-back):

- **Reader** — `parseKeyValue` currently returns the value text verbatim: surrounding quotes are not stripped, `\n`/`\t`/`\b`/`\"`/`\\` escapes are not decoded, continuation handling diverges from git on two inputs (leading whitespace of a continuation line is dropped; a trailing *escaped* backslash `\\` is misread as a continuation).
- **Writer** — `renderValue` round-trips through tsgit's own reader-to-be, but its bytes diverge from canonical git's `write_pair`: tsgit quotes for `"`/`\`/LF/TAB where git escapes them *unquoted*, git escapes TAB (`\t`) which tsgit doesn't, and git quotes (and accepts) CR-containing values which tsgit rejects.

Both halves of one grammar; fixing them together restores `parse(render(v)) ≡ v` *and* byte-for-byte on-disk parity (`.git/config` is on-disk state under the prime directive, ADR-226).

## git's exact behaviour (pinned against git 2.54.0)

All pinned empirically via `git config --file` with a scrubbed environment (`env -i`, isolated `HOME`).

### Value parsing (`parse_value`)

| Input (after `=`) | Result | Note |
| --- | --- | --- |
| `"a b"` | `a b` | quotes stripped |
| `a" b "c` | `a b c` | quote spans toggle and concatenate |
| `a\tb` (escape) | `a<TAB>b` | escapes decode inside *and* outside quotes |
| `a\\b` | `a\b` | |
| `a\"b` | `a"b` | |
| `a\bb` | `a<BS>b` | `\b` = backspace |
| `"a\nb"` | `a<LF>b` | |
| `a # c` | `a` | unquoted `#`/`;` starts a comment; trailing ws trimmed |
| `"a # c"` | `a # c` | `#`/`;` literal inside quotes |
| `a   b` | `a   b` | interior whitespace preserved verbatim |
| `   a` | `a` | leading whitespace skipped |
| `a\<LF>   b` | `a   b` | continuation: backslash-LF consumed, continuation line's leading ws is *interior* (preserved) |
| `a\\<LF>` | `a\` | escaped backslash at EOL is NOT a continuation |
| `a ""` | `a ` | quote toggle resets the trailing-whitespace trim |
| `a \t` | `a <TAB>` | escape append resets the trailing-whitespace trim |
| `"a\<LF>b"` | `ab` | continuation works inside a quote span |
| `a\<EOF>` | `a` | continuation at EOF ends the value (no error) |
| `ab<CR><LF>` | `ab` | trailing CR is line-ending whitespace (trimmed) |
| `"ab<CR>"` | `ab<CR>` | quoted CR preserved |
| `ab<CR>c` | `ab<CR>c` | interior CR preserved |
| `a<0x01>b`, `a<DEL>b` | verbatim | raw control bytes pass through |
| `a\x` | **fatal: bad config line N in file F** | unknown escape |
| `"a` (unclosed) | **fatal: bad config line N in file F** | quote span cannot cross a raw LF |
| (empty) / `""` | `` (empty string) | |

### Value writing (`write_pair`)

- **Quote** the value (wrap in `"…"`) iff: first char is a **space**, last char is a **space**, or the value contains `;`, `#`, or `CR`. (TAB never triggers quoting — it is escaped instead. `"`/`\`/LF never trigger quoting either.)
- **Escape always**, quoted or not: `\` → `\\`, `"` → `\"`, LF → `\n`, TAB → `\t`. CR and all other control bytes are written **raw**.
- git accepts any value byte except NUL (argv-impossible) — including CR, C0 controls, DEL.

Examples: `a;b` → `"a;b"` · `a"b` → `a\"b` (unquoted) · `a<TAB>b` → `a\tb` (unquoted) · `<TAB>a` → `\ta` (unquoted — tab is escaped, so no trimming risk) · `a<CR>b` → `"a<CR>b"` (raw CR inside quotes).

## Current state

- `src/application/primitives/config-read.ts` — `parseIniSections` is the single shared tokenizer (config, scoped config, `.gitmodules` per ADR-086, sequencer-state). Pipeline: `joinContinuations` (global, line-level) → `stripInlineComment` (quote-aware) → `parseSectionHeader` | `parseKeyValue` (verbatim value, `.trim()`).
- `src/application/primitives/update-config.ts` — `needsQuote` / `renderValue` (ADR-186 grammar), `rejectValueControlChars` (bans CR + NUL), `assertValueSafe` (bans all C0 except TAB/LF, plus DEL).
- No production unquoter exists anywhere; `update-config.properties.test.ts` carries a private test-only `unquoteValue` whose comment wrongly claims a porcelain unquoter exists.
- ADR-186 asserted "the reader already understands the quoting grammar — no reader change needed"; that was incorrect and is amended by this work.

## Design

### Reader — char-wise value parser mirroring `parse_value`

Restructure `parseIniSections` to iterate **physical lines by index** (no more global `joinContinuations`):

1. Leading-trimmed line starts with `#`/`;` or is blank → skip.
2. Header line (after `stripInlineComment(line).trim()`, as today) → `parseSectionHeader`, unchanged.
3. Otherwise locate `eqAt = line.indexOf('=')`. If absent, or an unquoted `#`/`;` occurs before `eqAt` (the comment swallows the `=`) → skip the line (preserves today's leniency for valueless keys and degenerate keys).
4. Key = `line.slice(0, eqAt).trim()` (unchanged; empty → skip).
5. Value = `parseConfigValue(lines, lineIdx, eqAt + 1)` → `{ value, nextLineIdx }` — a state machine over characters that may consume following physical lines via continuations:
   - flags: `inQuotes`, `inComment`; accumulator `out`; `trimLen` (length of `out` before the current trailing unquoted-whitespace run, git's trailing-trim mechanism).
   - end of physical line: `inQuotes` → **parse error**; otherwise truncate `out` to `trimLen` when a trailing run is open, and finish.
   - `inComment` → skip char.
   - whitespace (` `, TAB, CR, VT, FF — C `isspace` minus LF) outside quotes: skipped while `out` is empty, otherwise appended with `trimLen` latched at the run start.
   - `;`/`#` outside quotes → `inComment = true`.
   - `\` → look at next char: end-of-line → continuation (advance to next physical line — works inside quote spans too; on the *last* line the value simply ends, git fakes an EOL at EOF); `n` → LF; `t` → TAB; `b` → BS; `\` and `"` → themselves; anything else → **parse error**. An escape append resets `trimLen` even when the decoded char is whitespace (`a \t` → `a <TAB>`, pinned).
   - `"` → toggle `inQuotes` **and reset `trimLen`** (`a ""` → `a `, pinned).
   - any other literal char appended resets `trimLen`.
6. Parse error → throw `CONFIG_PARSE_ERROR` (structured: `{ code, line }`, 1-based physical line of the failure; an optional `source` label parameter on `parseIniSections` lets callers attach the file path). git's refusal (`fatal: bad config line N in file F`) is reconstructed by the consumer per ADR-249. *(Pending ADR — see open decisions.)*

`stripInlineComment`/`indexOfUnquoted` remain for header lines and pre-`=` comment detection. Non-value malformations (orphan keys, malformed headers, valueless keys) keep today's lenient skip — widening refusal parity to the whole grammar is a separate follow-up.

Everything downstream inherits the fix with zero signature changes: `readConfig`, `config-scoped-read` (`getConfigValue`/`getAllConfigValues`), `collectValues` (config porcelain `get`), `parse-gitmodules`, sequencer-state.

`readConfig`'s per-`Context` cache may now cache a rejected promise; that is correct — git equally fails every command until the file is fixed, and any config write invalidates the cache.

### Writer — adopt `write_pair` byte-for-byte (amends ADR-186)

In `update-config.ts`:

- `needsQuote(value)` → `value.startsWith(' ') || value.endsWith(' ') || value.includes(';') || value.includes('#') || value.includes('\r')`.
- `renderValue(value)` → escape **unconditionally** (`\`→`\\` first, then `"`→`\"`, LF→`\n`, TAB→`\t`), then wrap in quotes iff `needsQuote`. CR and other control bytes pass through raw.
- `rejectValueControlChars` → reject **NUL only** (CR is now representable; git accepts it).
- `assertValueSafe` → reject **NUL only** (git accepts raw C0/DEL; rejecting them was writer-capability defence that no longer applies).

Key/section/subsection validation (`rejectControlChars`, `rejectSubsection`, `rejectSection`) is untouched — header grammar is out of scope.

### Round-trip invariant

For every NUL-free string `v`: `parseConfigValue(renderValue(v)) ≡ v`, and the rendered bytes equal git's. The test-only `unquoteValue` in `update-config.properties.test.ts` is deleted; the property asserts directly through `parseIniSections`.

## Test plan

- **Unit (example)** — `config-read.test.ts`: every row of the pinned-behaviour table above (quotes, toggling, each escape, comments in/out of quotes, leading/interior/trailing whitespace, continuation with preserved leading ws, escaped-backslash-at-EOL non-continuation, CRLF trim, quoted CR, empty/`""`); parse-error cases assert `code`/`line` data via try/catch (mutation-resistant). `update-config.test.ts`: each quote-trigger and non-trigger, each escape, CR acceptance, NUL rejection data.
- **Property** (`*.properties.test.ts` siblings, per the four lenses — this is a parse/serialize round-trip pair):
  - `parse(render(v)) ≡ v` over NUL-free strings (numRuns 200, replaces the inline-unquoter property).
  - render is total and parse never throws on render's output (totality, numRuns 200).
  - generators in the shared `arbitraries.ts` pattern of the directory.
- **Interop** (`test/integration/config-interop.test.ts`, extended):
  - *Write parity*: for a matrix of special values (`;`, `#`, leading/trailing space, `"`, `\`, LF, TAB, CR, combo), tsgit `setConfigEntry` and `git config` produce **byte-identical** config files (twin repos), and `git config --get` reads tsgit's file back to the original value.
  - *Read parity*: a git-written (and a hand-written exotic: quote-toggling, continuation, `\b`) config file → tsgit `getConfigValue` equals `git config --get` output.
  - *Refusal parity*: a bad config line (unknown escape / unclosed quote) → git exits non-zero with `bad config line N`, tsgit throws `CONFIG_PARSE_ERROR` with the same `N`.

## Out of scope (follow-ups, kept lenient/as-is)

- **Subsection-name (un)escaping** — `[s "a\"b"]` headers: git decodes `\c` → `c` in subsection names and escapes `"`/`\` on write; tsgit slices between first/last quote and refuses to write such names. → new backlog entry (24.9g).
- **Valueless keys** — `key` with no `=` is boolean true in git; tsgit skips the line. → new backlog entry (24.9h).
- **Whole-grammar refusal parity** — git also dies on malformed headers/keys; tsgit stays lenient there.
- **`include` / `includeIf`** — no include machinery exists in tsgit; unchanged.

## Open decisions (ADR conversation)

1. **Malformed value: throw vs lenient skip.** git refuses to run *any* command on `bad config line N`. Recommended: faithful — throw structured `CONFIG_PARSE_ERROR { line, source? }` from the shared parser (refusal conditions bind under ADR-226). Alternative: keep tsgit's lenient skip-the-line (diverges; would need its own ADR).
2. **Amending ADR-186.** The writer grammar above contradicts accepted ADR-186 (quote-set and escape-set). Mandated by the prime directive, but recorded as a superseding ADR.
