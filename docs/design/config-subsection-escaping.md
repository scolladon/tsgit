# Design — Subsection-name (un)escaping in section headers

## Goal

Close the header-grammar faithfulness gap in the shared git-config tokenizer and writer (backlog 24.9g, surfaced by 24.9c — the value-grammar sibling):

- **Reader** — `parseSectionHeader` slices the subsection between the *first* and *last* `"` verbatim: `[s "a\"b"]` yields `a\"b` instead of git's `a"b`, `[s "a\tb"]` yields `a\tb` instead of `atb`, and a malformed header (`[s "a" x]`, `[s"a"]`, unclosed quote) is either silently mis-parsed or skipped where git refuses the whole file.
- **Writer** — `renderSectionHeader` emits the subsection raw, and `rejectSubsection` / `SUBSECTION_FORBIDDEN` refuse `"`, `\`, `]`, and CR outright; git escapes `"`/`\` and writes `]`/CR raw inside the quotes.

Both halves of one grammar; fixing them together restores `parse(render(s)) ≡ s` for subsection names *and* byte-for-byte on-disk parity (`.git/config` is on-disk state under the prime directive, ADR-226).

## git's exact behaviour (pinned against git 2.54.0)

All pinned empirically via `git config --file` with a scrubbed environment (`env -i`, isolated `HOME`).

### Subsection read (`get_extended_base_var`)

The grammar after `[section`: one-or-more GIT_SPACE chars, then `"`, then chars until an unescaped `"`, then **immediately** `]`. Inside the quotes, `\` followed by any char decodes to that char *verbatim* — unlike the value grammar, there are **no named escapes** (`\t` → `t`, not TAB).

| Input header | Result | Note |
| --- | --- | --- |
| `[s "a\"b"]` | subsection `a"b` | escape decoded |
| `[s "a\\b"]` | subsection `a\b` | |
| `[s "a\tb"]` | subsection `atb` | `\c` → `c` for ALL `c` — no named escapes |
| `[s "a]b"]` | subsection `a]b` | `]` literal inside quotes |
| `[s "a#b"]` | subsection `a#b` | `#`/`;` literal inside quotes |
| `[s "a<CR>b"]` | subsection `a<CR>b` | lone CR is content |
| `[s\t"a"]` | subsection `a` | any GIT_SPACE run between section and quote |
| `[s "a"] # c` | subsection `a` | comment after `]` allowed |
| `[s ""]` | subsection `` (empty) | distinct from `[s]` — `s.k` does NOT match `[s ""]` (pinned; see follow-ups) |
| `[s "a" x]` | **fatal: bad config line N in file F** | anything but `]` after the closing quote |
| `[s "a" ]` | **fatal** | even a space before `]` |
| `[s"a"]` | **fatal** | quote must be preceded by whitespace |
| `[s "a]` (unclosed) | **fatal** | quote span cannot cross a raw LF |
| `[s "a\<LF>` | **fatal** | `\` cannot escape the line ending |

### Subsection write (`write_section`)

- Escape `\` → `\\` and `"` → `\"`. **Nothing else** — `]`, CR, `#`, `;`, spaces are written raw inside the quotes.
- Accepts any subsection byte except LF (`error: invalid key (newline)`) and NUL (argv-impossible). CR is accepted and round-trips (pinned).
- Rename target follows the same escaping: `--rename-section s.x` → `s.a"y\z` writes `[s "a\"y\\z"]` (pinned).

### Write-path refusal on malformed files (pinned)

`git config --file <bad> x.y z` **refuses to write** when the existing file is malformed: a bad value line dies `fatal: bad config line N in file F` (exit 128); a bad header dies `error: invalid section name '…'` + `error: invalid config file F` (exit 3). The refusal *condition* is shared (no write ever lands on a malformed file); the error *shape* differs between git's read and write paths.

## Current state

- `src/application/primitives/config-read.ts` — `parseSectionHeader` (exported, shared with the writer's `matchesSection`): first/last-quote slicing, no decoding, malformed → `undefined` (line silently skipped by `parseIniSections`).
- `src/application/primitives/update-config.ts` — `renderSectionHeader` emits the subsection raw; `rejectSubsection` refuses `"`/`\`/`]` (+ `\n`/`\r`/`\0` via `rejectControlChars`); `setConfigEntryInText` does pure line surgery without parsing the file first (the remove/rename/unset paths *do* parse first via `parseIniSections` and so already inherit value refusals).
- `src/domain/commands/config-key.ts` — `SUBSECTION_FORBIDDEN = /[\n\r\0"\\\]]/` rejects dotted keys like `remote.a"b.url` that git accepts.
- Consumers of `parseIniSections` (all inherit the fix with zero signature changes): `readConfig`, scoped reads, config porcelain `get`/`list`, `.gitmodules` (ADR-086), sequencer state.

## Design

### Reader — char-wise subsection scan in `parseSectionHeader`

`parseSectionHeader` keeps its single `line` argument (the stripped + trimmed header candidate) but its result becomes a three-state discriminated union so the tokenizer can refuse like git without the header parser knowing line numbers. The function is shared with the writer but not barrel-exported, so the shape change is internal (`parseIniSections`'s public signature is untouched):

```ts
type SectionHeaderParse =
  | { readonly kind: 'header'; readonly section: string; readonly subsection: string | undefined }
  | { readonly kind: 'malformed' } // quoted-subsection grammar violated — git refuses the file
  | { readonly kind: 'not-header' };
```

Parsing rules:

1. Not `[…]`-shaped (missing either bracket) → **`not-header`** — preserved leniency, identical to today (whole-header refusal parity stays a follow-up, see Out of scope).
2. No `"` inside the brackets → today's subsectionless path, unchanged (`section` = inner trimmed; empty → `not-header`).
3. A `"` is present → the **strict quoted grammar** (this item's scope):
   - the char immediately before the opening `"` must be GIT_SPACE (space/TAB/CR) — `[s"a"]` and `["a"]` → **`malformed`**;
   - section part = text before the quote, trimmed (unchanged);
   - scan from the opening quote: `\` + any char → that char appended; `\` at end of line → **`malformed`** (git: fatal); unescaped `"` closes the span; line end before the close → **`malformed`**;
   - the char immediately after the closing quote must be the final `]` — anything else, including a space (`[s "a" ]`), → **`malformed`**.

`parseIniSections` maps the three states: `header` → open a section (as today); `malformed` → **throw `CONFIG_PARSE_ERROR { line, source }`** (1-based physical line — same structured refusal as ADR-308's value errors, reconstructable to git's `bad config line N in file F` per ADR-249); `not-header` → fall through to the key/value path (unchanged).

`matchesSection` (writer-side header matching) treats only `kind: 'header'` as a match. It can no longer see a malformed header in practice because every write path now refuses first (below) — but mapping `malformed` → no-match keeps the function total.

Comment stripping is untouched: `stripInlineComment`'s `indexOfUnquoted` is already quote- and backslash-aware, so `[s "a#b"]` survives and `[s "a"] # c` is cut before parsing (both pinned).

### Writer — escape on render, accept what git accepts

In `update-config.ts`:

- `renderSectionHeader(section, subsection)` → subsection escaped as `\` → `\\` first, then `"` → `\"`; everything else raw (git's `write_section`, pinned). Inherited by `setConfigEntryInText`, `appendConfigEntry`, and `renameConfigSectionInText`.
- `rejectSubsection` → reject **LF and NUL only** (git's `invalid key (newline)` + the argv-impossible NUL). `"`, `\`, `]`, and CR become representable; the escaping above (plus the LF ban) keeps header forgery impossible, which was the guard's original job.
- `rejectControlChars` keeps its current shape for **keys**; the subsection call-sites move to the relaxed check.

In `domain/commands/config-key.ts`:

- `SUBSECTION_FORBIDDEN` → `/[\n\0]/`. Dotted keys like `remote.a"b.url`, `merge.a\b.driver` now parse; position data in `CONFIG_KEY_INVALID` is unchanged for the still-rejected chars.

### Write-path refusal — parse before surgery

`setConfigEntry` (and the batch writers `updateConfigEntries` / `updateConfigOperations`) currently line-splice without parsing, so they can "succeed" on a file git refuses to touch. Each read-modify-write path now calls `parseIniSections(text, path)` on the original text before applying the transform — a malformed file (bad value *or* bad quoted-subsection header) throws `CONFIG_PARSE_ERROR` and the file is never written, matching git's refusal *condition*. We diverge deliberately on the error *shape* for writes (git's write path emits `invalid section name` / exit 3; tsgit reuses the one structured `CONFIG_PARSE_ERROR`) — one refusal shape for one grammar, per the ADR.

The unset/rename/remove-section paths already parse first and inherit the new header refusals for free.

### Round-trip invariant

For every LF/NUL-free subsection `s`: `parseSectionHeader(renderSectionHeader(sec, s))` yields `kind: 'header'` with subsection ≡ `s`, and the rendered bytes equal git's.

## Test plan

- **Unit (example)** — `config-read.test.ts`: every row of the pinned table (each escape decode incl. `\t`→`t`, literal `]`/`#`/CR inside quotes, GIT_SPACE before the quote, comment after `]`, empty subsection) plus the malformed forms asserting `CONFIG_PARSE_ERROR` `code`/`line`/`source` data via try/catch (mutation-resistant). Existing tests pinning the old verbatim slice / lenient skip of now-malformed headers are updated to the git-faithful expectation. `update-config.test.ts`: render escaping (`"`, `\`, escape order on `\"` combos), raw `]`/CR emission, relaxed acceptance, LF/NUL still refused with data assertions, write-path refusal on a malformed original, rename-section escaping. `config-key.test.ts`: `remote.a"b.url`-style keys now parse; LF/NUL still `bad-character` with position.
- **Property** (sibling `*.properties.test.ts`, round-trip lens): for arbitrary LF/NUL-free subsection strings, `parse(render(s))` is a `header` whose subsection ≡ `s` (numRuns 200); render output is always strict-grammar-valid (totality). Generators join the directory's existing `arbitraries.ts` pattern.
- **Interop** (`test/integration/config-interop.test.ts`, extended):
  - *Write parity*: for a subsection matrix (`"`, `\`, `]`, CR, `#`, space, combo), tsgit `setConfigEntry` and `git config` produce **byte-identical** files, and `git config --get` reads tsgit's file back.
  - *Read parity*: hand-written exotic headers (`\t` decode, `]` literal, escaped quote) → tsgit equals `git config --list`.
  - *Refusal parity*: each fatal form (`[s "a" x]`, `[s "a" ]`, `[s"a"]`, unclosed, `\`-at-EOL) → git exits non-zero with `bad config line N`; tsgit throws `CONFIG_PARSE_ERROR` with the same `N`. Write-path: both tools refuse to set a key into a malformed file.
  - *Rename parity*: rename to a subsection containing `"`/`\` → byte-identical headers.
  - *Match parity*: setting a second key under an existing escaped header lands in that section (no duplicate header), matching git (pinned).

## Out of scope (follow-ups, kept lenient/as-is)

- **Whole-header refusal parity** — git also dies on `[foo` (no `]`), `[]`, `[s ]` (space, no quote), and non-`iskeychar` section names (`[a@b]`); tsgit keeps the lenient skip for all *unquoted* header malformations. Only the quoted-subsection grammar (this item) refuses.
- **`[s ""]` vs `[s]` matching** — git treats an explicitly empty subsection as distinct from no subsection (`s.k` does not match `[s ""]`, pinned); tsgit's `matchesSection` conflates them. Pre-existing; surfaced to the backlog as its own entry.
- **`[section.subsection]` legacy dotted headers** — git lowercases the dotted subsection form; tsgit parses the whole inner as the section name. Pre-existing, unchanged.
- **Same-line content after `]`** (`[s "a"] k = v`) — char-based git parses it; line-based tsgit doesn't. Pre-existing, unchanged.

## Decisions (resolved)

1. **Malformed quoted-subsection header → throw, git-faithful** ([ADR-312](../adr/312-config-subsection-header-grammar-parity.md)): the strict grammar refuses with structured `CONFIG_PARSE_ERROR { line, source }` exactly where git's reader dies, scoped to headers that contain a `"`; unquoted-header malformations keep the lenient skip (follow-up). Write paths parse before surgery so the refusal condition matches git's; the write-path error *shape* deliberately reuses `CONFIG_PARSE_ERROR` instead of mirroring git's distinct `invalid section name` wording.
