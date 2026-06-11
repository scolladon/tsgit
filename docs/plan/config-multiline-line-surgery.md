# Plan — Line-surgery writer vs multi-line entries (backlog 24.9i)

Implementation script for [docs/design/config-multiline-line-surgery.md](../design/config-multiline-line-surgery.md),
per accepted [ADR-316](../adr/316-span-aware-config-entry-surgery.md) and
[ADR-317](../adr/317-section-surgery-stays-line-based.md). All three design decision
candidates are resolved as recommended: fold the insertion-point fix, fold empty-block
pruning, keep rename/remove-section line-based and pin it.

Branch: `feat/config-multiline-line-surgery` (worktree `tsgit-config-multiline-line-surgery`).

Every slice below is executed by a zero-context agent that sees only this plan and the
design doc. Each slice block therefore carries its full context: exact files, symbols,
current code shape, pinned bytes (quoted verbatim from the design matrix), the existing
tests that will break, and the TDD sequence ending in one atomic commit.

---

## Ground rules (every slice)

- **TDD**: RED (write the listed failing tests first, run them, watch them fail) → GREEN
  (minimal implementation) → REFACTOR (dedupe, naming, doc comments). GWT describe/it
  split (`describe('Given …') > describe('When …') > it('Then …')`, 2-level shortcut
  allowed for single expectations), AAA bodies with section comments, `sut` names the
  function under test, results go in `result`.
- **Slice gate** (run before committing, all must pass):
  - `npx vitest run <touched test files>` (each slice lists its exact set)
  - `npm run check:types`
  - `npx biome check <touched src+test files>`
  - The full `npm run validate` runs once at the phase boundary, NOT per slice.
- **Never** commit on a red gate; never `--no-verify`; never add any ignore directive
  (`@ts-ignore`, `biome-ignore`, `v8 ignore`, `Stryker disable`, …). Pre-existing
  `Stryker disable` / `equivalent-mutant` comments on UNCHANGED code stay as they are;
  do not add new ones. One existing disable is invalidated by S1 — see S1's notes.
- **No design/ADR/phase/backlog references in source or test code** — not in comments,
  not in test titles. The matrix case ids (A, I3, D8, …) used in this plan are
  plan-internal shorthand; test titles must describe the behaviour instead. This plan
  records the id → test-title mapping.
- **`reports/api.json` must NOT change.** `tokenizeConfig` / `ConfigToken` are exported
  from `src/application/primitives/config-read.ts` but must NOT be added to
  `src/application/primitives/index.ts` (nor any other barrel) — same precedent as the
  already-non-barrel `parseSectionHeader`. No public signature changes anywhere. If
  `check:types`, knip, or the prepush typedoc check reports `api.json` churn, something
  is wrong — stop and re-check the barrel.
- Line numbers cited below are at the branch tip before any slice lands; after slice 1
  they drift — anchor by symbol name, not line.

## Slice overview

| id | title | commit message |
| --- | --- | --- |
| S1 | Structural tokenizer in `config-read.ts`; `parseIniSections` re-expressed as a fold | `feat(config): line-span tokenizer shared by reader and writer` |
| S2 | Span-aware set/append + end-of-last-block insertion; un-reverse the submodule op workarounds | `feat(config): span-aware set and append with end-of-section insertion` |
| S3 | Span-aware remove + empty-block pruning | `feat(config): span-aware unset with empty-section pruning` |
| S4 | Interop twins, property invariants, rename/remove-section faithfulness pins | `test(config): interop and property pins for span-aware config surgery` |

Sequential; each depends on the previous. S2 and S3 both rewrite
`update-config.ts` but touch disjoint functions (set/append vs remove), so they are
split to keep each agent's diff reviewable; S4 is the cross-tool/grammar verification
slice exercising S1–S3's code (and pinning the deliberately unchanged section surgery).

---

## S1 — Structural tokenizer (`tokenizeConfig`) in `config-read.ts`

**Goal**: expose the spans the reader already computes as a physical-line token stream,
and re-express `parseIniSections` as a fold over it. Zero behaviour change on the read
side — the existing 3 200-line `config-read.test.ts` suite plus
`config-read.properties.test.ts` are the parity pin and must stay green untouched.

### Files

- `src/application/primitives/config-read.ts` — add `ConfigToken`, `tokenizeConfig`;
  rewrite `parseIniSections` body as a fold. Nothing else in the file changes.
- `test/unit/application/primitives/config-read.test.ts` — new top-level
  `describe('primitives/config-read tokenizeConfig', …)` block (the file's outer
  wrapper is `describe('primitives/config-read', …)` at line 24; add the new block as a
  sibling top-level describe at the end of the file, where `setConfigEntry (I/O)`-style
  siblings already live in `update-config.test.ts`).

### Current code shape (verified at tip)

In `config-read.ts`:

- `parseIniSections` (line 174, exported): loop over `text.split('\n')`; per line —
  `stripInlineComment(line).trim()`; skip `''` (lines 181–186, with a
  `Stryker disable next-line` comment at 182 that must move with the logic);
  `parseSectionHeader(trimmed)` three-state (`header` → push new `SectionBuilder`,
  `malformed` → `throw configParseError(lineIdx + 1, source, header.partialName)`);
  `effectiveEqualsIndex(line)` (line 218) `=== -1` → `processValuelessLine(line,
  trimmed, lineIdx, current, source)` (line 143: `trimmed.startsWith('[')` → lenient
  skip; else `VALUELESS_KEY_RE` (line 135) match → push `{ key: match[1], value: null }`
  when `current !== undefined`; else `throw configParseError(lineIdx + 1, source)`);
  otherwise `key = line.slice(0, eqAt).trim()`, `parsed = parseConfigValue(lines,
  lineIdx, eqAt + 1, source)` (line 276), push `{ key, value: parsed.value }` only when
  `current !== undefined && key !== ''`, then `lineIdx = parsed.nextLineIdx`.
- `parseConfigValue` returns `ParsedValue` (lines 262–265):
  `{ readonly value: string; readonly nextLineIdx: number }` — `nextLineIdx` is
  exclusive; backslash-at-EOL continuations advance the cursor across physical lines
  (`consumeEscape`, line 332); a `\` inside a comment is NOT a continuation
  (`stepValueChar` returns at line 305 before the `\\` check when `inComment`); a
  continuation on the final line ends the value with `nextLineIdx === lines.length`.
- `stripInlineComment` (line 367) is quote-aware via `indexOfUnquoted` (line 377).
- `parseSectionHeader` (line 416, exported) / `SectionHeaderParse` (line 399, exported).
- `IniSection` (line 111, exported) / `SectionBuilder` (line 118, private).

### New code

```ts
/** Physical-line classification of git-config text; the writer's surgery unit. */
export type ConfigToken =
  | {
      readonly kind: 'header';
      readonly section: string;
      readonly subsection: string | undefined;
      readonly line: number;
      /** Header line carries an unquoted inline `#`/`;` comment (blocks empty-section pruning). */
      readonly hasComment: boolean;
    }
  | {
      readonly kind: 'entry';
      readonly key: string;
      readonly value: string | null;
      readonly startLine: number;
      /** Exclusive — `parseConfigValue`'s `nextLineIdx`; `startLine + 1` for single-line entries. */
      readonly endLine: number;
    }
  | { readonly kind: 'comment'; readonly line: number }
  | { readonly kind: 'blank'; readonly line: number };

export const tokenizeConfig = (text: string, source?: string): ReadonlyArray<ConfigToken>;
```

Tokenizer algorithm — a verbatim relocation of today's `parseIniSections` loop, with
classification emitted instead of folded (any divergence here is a read-side regression):

1. `lines = text.split('\n')`. When `text.endsWith('\n')`, the final `''` element is
   the **file terminator** and emits no token: iterate `lineIdx` while
   `lineIdx < (text.endsWith('\n') ? lines.length - 1 : lines.length)`. Pass the FULL
   `lines` array to `parseConfigValue` so a continuation can still consume the
   terminator line exactly as today (the entry's `endLine` may then equal
   `lines.length` — the writer clamps, see S2).
2. Per line: `stripped = stripInlineComment(line)`, `trimmed = stripped.trim()`.
   - `trimmed === ''` → emit `{ kind: 'blank', line }` when `line.trim() === ''`
     (whitespace-only), else `{ kind: 'comment', line }` (the line stripped to nothing
     because of a `#`/`;` cut). This splits today's conflated skip into the two kinds
     the empty-block rule needs; the fold treats both as skip so `IniSection` output is
     untouched.
   - `parseSectionHeader(trimmed)`: `header` → emit
     `{ kind: 'header', section, subsection, line, hasComment: stripped !== line }`
     (`stripInlineComment` is quote-aware, so `[s "a#b"]` → `hasComment: false`,
     `[a] # note` → `true`); `malformed` → `throw configParseError(lineIdx + 1, source,
     header.partialName)`.
   - `effectiveEqualsIndex(line) === -1` → mirror `processValuelessLine` exactly:
     `trimmed.startsWith('[')` → emit `{ kind: 'comment', line }` (the lenient
     not-header skip; classified as comment so the writer treats it as opaque,
     prune-protecting content); else `VALUELESS_KEY_RE.exec(line)` match → emit
     `{ kind: 'entry', key: match[1], value: null, startLine: lineIdx,
     endLine: lineIdx + 1 }`; no match → `throw configParseError(lineIdx + 1, source)`.
   - Otherwise: `key = line.slice(0, eqAt).trim()`;
     `parsed = parseConfigValue(lines, lineIdx, eqAt + 1, source)`; emit
     `{ kind: 'entry', key, value: parsed.value, startLine: lineIdx,
     endLine: parsed.nextLineIdx }` — **emit even when `key === ''`** (every physical
     line must be classified for the writer); advance `lineIdx = parsed.nextLineIdx`.

`parseIniSections` becomes the fold (public signature unchanged):

```ts
export const parseIniSections = (text: string, source?: string): ReadonlyArray<IniSection> => {
  const sections: SectionBuilder[] = [];
  let current: SectionBuilder | undefined;
  for (const token of tokenizeConfig(text, source)) {
    if (token.kind === 'header') {
      current = { section: token.section, subsection: token.subsection, entries: [] };
      sections.push(current);
    } else if (token.kind === 'entry' && current !== undefined && token.key !== '') {
      current.entries.push({ key: token.key, value: token.value });
    }
  }
  return sections;
};
```

Note the fold's `token.key !== ''` guard replicates today's behaviour for BOTH entry
shapes: valueless entries always have a non-empty key (regex-guaranteed), valued
entries with an empty key (` = v`) are parsed-but-not-pushed today (line 205) and must
stay so. Keep `parseIniSections`'s doc comment (lines 157–173) — it documents the
grammar, which is unchanged. Stryker-comment handling: the
`Stryker disable next-line ConditionalExpression,StringLiteral` at line 182 annotates
the blank-skip branch as equivalent — in the tokenizer that branch becomes observable
(blank vs comment tokens, killed by test 8 below), so DELETE that comment rather than
relocating it; every other existing disable (`effectiveEqualsIndex`,
`stripInlineComment`, `indexOfUnquoted`, `parseSectionHeader`, `finalize`) annotates
code this slice does not modify and stays put. Do not add new ones.
`parseConfigValue`, `processValuelessLine`,
`VALUELESS_KEY_RE` etc. stay private; `processValuelessLine` may be inlined into the
tokenizer or kept — prefer whichever leaves zero dead code (knip/`check:dead-code`
runs at the phase boundary).

### RED — new tokenizer tests (`config-read.test.ts`)

All assert full token arrays with `toEqual` (kills line-index mutants). Suggested
Given/When/Then titles; inputs are exact byte strings.

1. `'[a]\n\tkey = v\n'` → `[{header a, line 0, hasComment false}, {entry key, 'v', start 1, end 2}]`.
2. Two-line continuation `'[a]\n\tkey = one\\\n   two\n'` → entry `{key, 'one   two', start 1, end 3}`.
3. Chained continuation `'[a]\n\tkey = one\\\n   two\\\n   three\n'` → entry end 4.
4. Quoted continuation `'[a]\n\tkey = "one\\\n   two"\n'` → entry `{key, 'one   two', start 1, end 3}`.
5. Comment-masked backslash `'[a]\n\tkey = one # c\\\n\tnext = x\n'` → `key` entry `{value 'one', start 1, end 2}` and `next` entry `{value 'x', start 2, end 3}` (a `\` inside a comment is not a continuation).
6. Tail that looks like a key `'[a]\n\tnote = first\\\n\turl = fake\n\turl = real\n'` → tokens: header, `note` entry `[1,3)`, `url` entry `[3,4)` — exactly one `url` entry.
7. Tail that looks like a header `'[a]\n\tnote = v\\\n[x]\n\tkey = old\n'` → ONE header token (`a`); `note` spans `[1,3)`; `key` entry `[3,4)`.
8. Blank vs comment: `'[a]\n\n# c\n   ; c\n   \n'` → blank(1), comment(2), comment(3), blank(4).
9. Header inline comment: `'[a] # note\n'` → `hasComment: true`; `'[a]\n'` → `false`; `'[a "x#y"]\n'` → `false` (quoted `#`).
10. Lenient not-header body line `'[a]\n\t[half\n'` → `[header, comment(1)]`.
11. Valueless entry `'[a]\n\tkey\n'` → entry `{key, value null, start 1, end 2}`.
12. Empty-key entry `'[a]\n\t= v\n'` → entry `{key '', value 'v', start 1, end 2}`; AND `parseIniSections` of the same text yields `[a]` with zero entries (fold parity).
13. Orphan entry before any header `'key = v\n[a]\n'` → `[entry(key,start 0,end 1), header(line 1)]`; `parseIniSections` yields only `[a]` with no entries.
14. Terminator handling: `'[a]\n'` → exactly one token; `'[a]\n\n'` → header + one blank(1).
15. Continuation consuming EOF terminator `'[a]\n\tk = v\\\n'` → entry `{k, 'v', start 1, end 3}` (endLine === split length — pin the exclusive-end contract at EOF).
16. Refusal parity (try/catch + `.data` asserts, mutation-resistant — never bare `toThrow`):
    - `'[s "a" x]\n\tk = v\n'` → `CONFIG_PARSE_ERROR`, `data.line === 1`, `data.partialSectionName === 's.a'` (verified: `configParseError` in `src/domain/commands/error.ts:419` sets `code`, `line`, optional `source`, optional `partialSectionName`).
    - `'[a]\nbad!key\n'` → `CONFIG_PARSE_ERROR`, `data.line === 2`.
    - `'[a]\nk = "unclosed\n'` → `CONFIG_PARSE_ERROR`, `data.line === 2`.
    - Each with `source` provided → `data.source` carried (parity with `parseIniSections`, which the same inputs must also throw from — one parameterised pass over both functions is acceptable).

### GREEN / REFACTOR

Implement as specified; refactor for <20-line functions (the per-line classification
naturally extracts into a `classifyLine`-style helper — keep it private). Run the FULL
config-read suites to prove read parity.

### Gate

```
npx vitest run test/unit/application/primitives/config-read.test.ts test/unit/application/primitives/config-read.properties.test.ts test/unit/application/primitives/update-config.test.ts test/unit/application/primitives/update-config.properties.test.ts
npm run check:types
npx biome check src/application/primitives/config-read.ts test/unit/application/primitives/config-read.test.ts
```

(`update-config` suites included because its write paths consume `parseIniSections` via
`parseIniSectionsForWrite` — they must be untouched and green.)

### Commit

```
git add -A && git commit -m "feat(config): line-span tokenizer shared by reader and writer"
```

---

## S2 — Span-aware set/append with end-of-last-block insertion

**Goal**: rebuild `setConfigEntryInText` and `appendConfigEntry` on `tokenizeConfig`;
retire `findKeyInSection` / `findLastKeyInSection`; new keys land at the end of the
LAST matching block; existing keys are replaced in their full span at first match.
Remove the two submodule `.reverse()` workarounds and swap `submoduleAdd`'s op order so
all existing pinned bytes are preserved.

### Files

- `src/application/primitives/update-config.ts`
- `src/application/commands/submodule.ts`
- `test/unit/application/primitives/update-config.test.ts`
- (verify-only, no edits expected) `test/unit/application/commands/submodule-add.test.ts`,
  `submodule-write.test.ts`, `submodule-update.test.ts`, `remote.test.ts`,
  `clone.test.ts`, `config.test.ts`, `pull.test.ts`

### Current code shape (verified at tip, `update-config.ts`)

- `setConfigEntryInText` (line 216, exported, in the public barrel — signature
  `(text: string, section: string, subsection: string | undefined, key: string,
  value: string): string` MUST NOT change): validations (`rejectSection`,
  `rejectControlChars('key', …)`, `rejectValueControlChars`, `rejectSubsection`) →
  `lines = text.split('\n')` → `findSectionHeader` (line 116) → absent: append
  `[header]\n\tkey = value\n` with prefix-newline fix (lines 229–232) → present:
  `findKeyInSection` (line 132; scans from `headerIndex + 1`, stops at
  `isSectionHeader` (line 46), matches via `isKeyLine` (line 62)) → found:
  `replaceLine(lines, keyIndex, renderEntry(key, value))` (lines 234–236) → absent:
  `insertAfter(lines, headerIndex, renderEntry(key, value))` (line 237).
- `appendConfigEntry` (line 440, exported via `applyConfigOpInText`'s barrel; same
  validations; absent-section path lines 453–455 identical shape to set's; present:
  `findLastKeyInSection` (line 468) returns the LAST `isKeyLine` match or
  `headerIndex`, then `insertAfter`).
- `renderEntry` (line 101): `` `\t${key} = ${renderValue(value)}` `` — canonical
  emission, unchanged. `renderValue` (line 91) escapes `\` `"` LF TAB and quotes per
  `needsQuote` — unchanged.
- `matchesSection` (line 35): trims the line, `parseSectionHeader`, case-insensitive
  section, case-sensitive subsection, `subsection === undefined` matches `undefined`
  OR `''` — these semantics must be preserved verbatim in the token-based matcher.
- `parseIniSectionsForWrite` (line 539): all I/O callers (`updateConfigEntries` 351,
  `updateConfigOperations` 487, `readModifyWriteScopedConfig` 563, `unsetConfigEntry`
  616, `unsetAllConfigEntries` 649) parse-first and translate header malformations to
  `CONFIG_INVALID_FILE`; so on those paths `tokenizeConfig` inside the `*InText`
  functions can only succeed. Standalone `*InText` calls (e.g.
  `applyConfigOpInText` on `.gitmodules` text from `submodule.ts`) now inherit raw
  `CONFIG_PARSE_ERROR` refusals — previously they silently applied line surgery to
  malformed text. This is intended (git refuses malformed files on any write).
- `isSectionHeader`, `matchesSection`, `findSectionHeader`, `replaceLine`,
  `insertAfter` are still used by the (unchanged) rename/remove-section machinery and
  by S3's interim state — do NOT delete them here. `isKeyLine` is still used by
  `removeConfigEntry` until S3. Delete `findKeyInSection` and `findLastKeyInSection`
  in this slice (their only callers are rewritten here).

In `submodule.ts`:

- `registerOps` (lines 151–172): builds `[set active, set url, set update?]` then
  `return [...ordered].reverse()` — a workaround for after-header insertion whose
  comment (lines 151–156) documents exactly that. **Remove the reverse, return
  `ordered`,** and rewrite the comment (git's order `active`, `url`, `update` now falls
  out of end-of-section insertion directly).
- `writeGitmodulesEntry` (lines 494–514): folds
  `[set path, set url, set branch?]` via `for (const op of [...ordered].reverse())
  text = applyConfigOpInText(text, op)` — **fold `ordered` forward instead** and
  rewrite the comment (lines 494–498).
- `submoduleAdd` (lines 634–637): `updateConfigOperations(ctx, [setSubmoduleOp(name,
  'active', 'true'), setSubmoduleOp(name, 'url', resolved)])` — this one is NOT
  reversed, so today's after-header insertion produces `url` BEFORE `active`, which is
  the byte order pinned by `submodule-add.test.ts:106`
  (`section.indexOf('url =') < section.indexOf('active =')`). **Swap the ops to
  `[set url, set active]`** so the pinned bytes are preserved under end-of-section
  insertion.
- `remote.ts` `remoteAdd` (ops at 142–151: `set url`, `set fetch`) and `clone.ts`
  `writeCloneConfig` (164–191: `url`, `fetch`, then `branch` `remote`, `merge`) need
  **no change** — their forward order becomes the git-faithful byte order
  automatically (this fixes today's reversed `fetch`-before-`url` /
  `merge`-before-`remote` sections; their tests use `toContain`, so they stay green).

### New internal shape (`update-config.ts`, all private)

```ts
interface SectionTarget {
  readonly section: string;
  readonly subsection: string | undefined;
}
type EntryToken = Extract<ConfigToken, { kind: 'entry' }>;
type HeaderToken = Extract<ConfigToken, { kind: 'header' }>;

/** matchesSection semantics on a header token (ci section, cs subsection, undefined ⇔ ''). */
const matchesTarget = (header: HeaderToken, target: SectionTarget): boolean;

/** First entry token (line order) whose ci key matches, inside any matching block. */
const findEntry = (
  tokens: ReadonlyArray<ConfigToken>,
  target: SectionTarget,
  key: string,
): EntryToken | undefined;

/**
 * Insertion line for a new key: end of the LAST matching block — the last entry
 * token's endLine, or headerLine + 1 when that block has no entries. undefined
 * when no block matches.
 */
const insertionLine = (
  tokens: ReadonlyArray<ConfigToken>,
  target: SectionTarget,
): number | undefined;
```

Import `tokenizeConfig` and `ConfigToken` from `./config-read.js` (extend the existing
import at line 23).

`setConfigEntryInText` rewrite (validations and the absent-section branch, lines
223–232, stay byte-identical):

```ts
const lines = text.split('\n');
const tokens = tokenizeConfig(text);
const target = { section, subsection };
const existing = findEntry(tokens, target, key);
if (existing !== undefined) {
  const end = Math.min(existing.endLine, lines.length);
  const out = [...lines.slice(0, existing.startLine), renderEntry(key, value), ...lines.slice(end)];
  return withTrailingNewlineRestored(lines, out).join('\n');
}
const at = insertionLine(tokens, target);
if (at === undefined) { /* current absent-section append, unchanged */ }
return spliceEntryAt(lines, at, renderEntry(key, value), text).join('\n');
```

Insertion mechanics (`spliceEntryAt` or inline — keep functions <20 lines):

- Clamp: `const max = text.endsWith('\n') ? lines.length - 1 : lines.length;
  const idx = Math.min(at, max);` — the clamp matters in two places: (a) the normal
  end-of-file section (pinned row C: the entry must land BEFORE the terminator `''`
  element so the file keeps a single trailing LF); (b) the unpinned corner where a
  continuation consumed the terminator (`endLine === lines.length` for a file ending
  `\\\n`).
- Insert: `[...lines.slice(0, idx), entry, ...lines.slice(idx)]`.
- Missing-EOF-newline: when `idx === lines.length` (file did NOT end with `\n` and the
  insertion lands at EOF), append a final `''` element so the written entry is
  LF-terminated — git terminates every entry it writes and repairs a missing EOF
  newline before appending. Mid-file insertions into such a file do NOT gain a trailing
  LF. (S4 pins this empirically; if real git disagrees, S4 adjusts — the rule is
  localised to this one branch.)
- `withTrailingNewlineRestored(originalLines, out)`: when
  `originalLines[originalLines.length - 1] === ''` and the last element of `out` is not
  `''` and `out.length > 0`, push `''` — the same restoration
  `removeConfigSectionInText` performs at lines 304–311. Extract it as a shared private
  helper now and have `removeConfigSectionInText` use it too (behaviour-preserving; its
  unit tests at `update-config.test.ts:1350–1488` pin that).

`appendConfigEntry` rewrite: identical structure — validations and absent-section
branch (lines 447–455) unchanged; present-section branch is exactly the
`insertionLine` + `spliceEntryAt` path (no `findEntry`; `--add` never replaces).
Delete `findLastKeyInSection`.

Doc comments to update in this slice: `setConfigEntryInText` jsdoc (lines 207–215,
"inserted right after the header" → end of the last matching block, full-span
replacement at first match), `appendConfigEntry` jsdoc (lines 433–439), the
`appendEntry` `ConfigOperation` variant jsdoc (lines 392–397).

### Pinned behaviour bytes (verbatim design-matrix rows this slice implements)

Set / replace (span-aware):

| id | input bytes | command | output bytes | pinned rule |
| --- | --- | --- | --- | --- |
| A | `[a]⏎⇥key = one\⏎␣␣␣two⏎⇥other = x⏎` | `a.key newval` | `[a]⏎⇥key = newval⏎⇥other = x⏎` | replace removes **all** physical lines of the old entry; canonical `⇥key = value` lands at the entry's first-line position |
| A2 | `[a]⏎⇥key = one\⏎␣␣␣two\⏎␣␣␣three⏎⇥other = x⏎` | `a.key newval` | `[a]⏎⇥key = newval⏎⇥other = x⏎` | chained continuations (tail ending in `\`) are all part of the span |
| E1 | `[a]⏎⇥key = "one\⏎␣␣␣two"⏎⇥other = x⏎` | `a.key newval` (read: `one␣␣␣two`) | `[a]⏎⇥key = newval⏎⇥other = x⏎` | continuation inside a quote span behaves identically |
| E2 | `[a]⏎⇥key = one # c\⏎⇥next = x⏎` | read `a.key`/`a.next`; then `a.key newval` | reads `one` / `x`; `[a]⏎⇥key = newval⏎⇥next = x⏎` | `\` at EOL **inside a comment** is NOT a continuation; the entry span is one line (the same-line trailing comment is consumed by the replace) |
| K | `[a]⏎⇥note = first\⏎⇥url = fake⏎⇥url = real⏎` | `--get-all a.url`; then `a.url NEW` | reads `real` only; `[a]⏎⇥note = first\⏎⇥url = fake⏎⇥url = NEW⏎` | a tail that *looks like* a `key =` line is value content — never matched, never rewritten |
| L | `[a]⏎⇥note = v\⏎[x]⏎⇥key = old⏎` | read `a.key`; then `a.key NEW` | reads `old`; `[a]⏎⇥note = v\⏎[x]⏎⇥key = NEW⏎` | a tail that *looks like* a section header is value content on the set path — `[a]` continues past it, `key` is found and replaced in place |

New-entry insertion point — end of the LAST matching block:

| id | input bytes | command | output bytes | pinned rule |
| --- | --- | --- | --- | --- |
| C | `[a]⏎⇥key = one\⏎␣␣␣two⏎` | `a.other val` | `[a]⏎⇥key = one\⏎␣␣␣two⏎⇥other = val⏎` | a new key goes **after the multi-line tail** (after the section's last entry span) |
| I1 | `[a]⏎⇥key = one⏎[b]⏎⇥k = v⏎` | `a.other val` | `[a]⏎⇥key = one⏎⇥other = val⏎[b]⏎⇥k = v⏎` | insertion is at the **end of the section** (after its last entry), not after the header |
| I2 | `[a]⏎⇥key = one⏎⏎# trailing comment⏎[b]⏎⇥k = v⏎` | `a.other val` | `[a]⏎⇥key = one⏎⇥other = val⏎⏎# trailing comment⏎[b]⏎⇥k = v⏎` | insertion is after the last **entry**, before trailing blank/comment lines |
| I3 | `[a]⏎[b]⏎⇥k = v⏎` | `a.other val` | `[a]⏎⇥other = val⏎[b]⏎⇥k = v⏎` | empty section: right after the header |
| I4 | `[a]⏎⇥k1 = x⏎[b]⏎⇥k = v⏎[a]⏎⇥k2 = y⏎` | `a.new val` | `[a]⏎⇥k1 = x⏎[b]⏎⇥k = v⏎[a]⏎⇥k2 = y⏎⇥new = val⏎` | duplicate section blocks: the **last** matching block receives the new key |
| M | `[a]⏎⇥key = x⏎[b]⏎⇥k = v⏎[a]⏎⇥other = y⏎` | `a.key NEW` | `[a]⏎⇥key = NEW⏎[b]⏎⇥k = v⏎[a]⏎⇥other = y⏎` | …but an **existing** key is replaced where it lives (first match) |
| J | `[remote "o"]⏎⇥url = u⏎⇥fetch = A⏎⇥push = p⏎` | `--add remote.o.fetch B` | `[remote "o"]⏎⇥url = u⏎⇥fetch = A⏎⇥push = p⏎⇥fetch = B⏎` | `--add` uses the same end-of-section point — NOT "after the last same-key line" |
| J2 | `[remote "o"]⏎⇥fetch = A\⏎␣␣␣tail⏎` | `--add remote.o.fetch B` | `[remote "o"]⏎⇥fetch = A\⏎␣␣␣tail⏎⇥fetch = B⏎` | end-of-section is after the multi-line tail |

(Notation: `⏎` = LF, `⇥` = TAB, `␣` = significant space, `\` = one literal backslash byte.)

Unpinned corners — deterministic choices this slice implements (do not improvise
beyond them): comment-only block → insert at `headerLine + 1` (consistent with I3);
continuation-at-EOF (`endLine === lines.length`) → clamp per above; missing EOF
newline + EOF insertion → append terminator. None of these may change pinned rows.

### RED — new tests (`update-config.test.ts`)

One example test per matrix row above, byte-exact `toBe` on the full output string.
Set rows under the existing `describe('setConfigEntryInText', …)` block; J/J2 under
`describe('appendConfigEntry', …)`. Suggested Then-titles (no case ids in code):

- A: `Then every physical line of the spanned entry is replaced by one canonical line`
- A2: `Then chained continuation lines are all replaced`
- E1: `Then a quoted continuation span is replaced whole`
- E2: `Then a backslash inside a trailing comment does not extend the replaced span`
- K: `Then a continuation tail that looks like a key line is never matched`
- L: `Then a continuation tail that looks like a section header does not end the section`
- C: `Then a new key is inserted after the multi-line tail of the last entry`
- I1: `Then a new key is inserted at the end of the section, not after the header`
- I2: `Then a new key is inserted after the last entry, before trailing blank and comment lines`
- I3: `Then a new key in an empty section is inserted right after the header`
- I4: `Then the last duplicate section block receives the new key`
- M: `Then an existing key is replaced in the first block where it lives`
- J: `Then the appended entry lands at the end of the section, after unrelated keys`
- J2: `Then the appended entry lands after the multi-line tail`
- standalone refusal: `Given text with an unclosed value quote, When setConfigEntryInText runs standalone, Then CONFIG_PARSE_ERROR carries the 1-based line` (try/catch, assert `.data.code` and `.data.line` — pins that the pure function inherits the tokenizer's refusals).
- missing-EOF-newline corner: `Given a section at EOF without a trailing newline, When a new key is inserted, Then the file gains a single trailing newline` — input `'[a]\n\tk = v'`, set `a.new` → `'[a]\n\tk = v\n\tnew = x\n'`.

### Existing tests that BREAK — update deliberately (new expected bytes)

In `test/unit/application/primitives/update-config.test.ts` (cited by current
describe > it titles; retitle where the old title states the old rule):

1. `setCoreConfigEntryInText > Given a [core] section without the key > … > Then the key is inserted right after the header` (line 52) → expect `'[core]\n\tbare = false\n\tsparseCheckout = true\n'`; retitle to `Then the key is inserted at the end of the section`.
2. `Given a key only present under a section after [core] > … > Then it is inserted under [core], not matched in the later section` (line 147) → `'[core]\n\tbare = false\n\tsparseCheckout = true\n[other]\n\tsparseCheckout = false\n'`.
3. `Given an explicitly empty `[core ""]` header > … > Then it is treated as the [core] section` (line 183) → `'[core ""]\n\tbare = false\n\tsparseCheckout = true\n'`.
4. `Given a [core] body line lacking '=' whose text would key-match after dropping its last char > … > Then the '='-less line is not mistaken for the key` (line 199) → `'[core]\n\tsparseCheckoutX\n\tsparseCheckout = true\n'`.
5. `Given a [core] header line with surrounding whitespace > … > Then it is still recognized as [core]` (line 216) → `'  [core]  \n\tbare = false\n\tsparseCheckout = true\n'`.
6. `Given a key under a later section whose header is indented > … > Then the section scan stops at the trimmed header (does not reach into it)` (line 231) → `'[core]\n\tbare = false\n\tsparseCheckout = true\n  [other]  \n\tsparseCheckout = false\n'`.
7. `setConfigEntryInText > Given an existing section without the key > … > Then the key is inserted after the header` (line 576) → `'[remote "origin"]\n\turl = https://e/r.git\n\tpromisor = true\n'`; retitle.
8. `Given a valueless line for a DIFFERENT key in the same section > … > Then the valueless line for the other key is not matched` (line 1152) → `'[a]\n\tother\n\tkey = v\n'`.
9. `Given a valueless line for the key in a LATER section > … > Then the later section valueless line is not matched (section-stop)` (line 1167) → `'[a]\n\tother = v\n\tkey = w\n[b]\n\tkey\n'`.
10. `appendConfigEntry > Given an existing section with NO prior matching key > … > Then the entry is inserted directly after the header` (line 1672) → `'[remote "r"]\n\turl = u\n\tfetch = A\n'`; retitle to `Then the entry is inserted at the end of the section`.
11. `Given a section is followed by another section > … > Then a matching key in the LATER section is NOT considered` (line 1687) → `'[remote "r"]\n\turl = u\n\tfetch = A\n[remote "other"]\n\tfetch = X\n'`.

Tests that look adjacent but must stay green UNCHANGED (regression sentinels):
`Given a [core] section with the key present` (line 37), `Given other sections,
comments and blank lines around [core]` (line 128), all `setCoreConfigEntryInText`
absent-section/append rows (lines 67–105), all renderValue/quoting rows, the valueless
replace rows (lines 1122, 1137), `appendConfigEntry > Given an existing section with
one prior entry for the key` (line 1657 — entry already last, end-of-section gives the
same bytes), `Given a valueless entry as the only prior occurrence` (line 1736),
`updateConfigOperations > Given two appendEntry ops … Then on-disk order matches the
call order` (line 1841), and the whole `update-config.properties.test.ts` file.

In command suites, the byte pins that must stay green WITHOUT edits — they pass only
if the `submodule.ts` changes land in this slice:

- `submodule-add.test.ts:106` — `.git/config` section `url =` before `active =`
  (requires the `submoduleAdd` op swap).
- `submodule-add.test.ts:92` / `:251` — `.gitmodules` exact bytes
  `[submodule "libs/sub"]\n\tpath = …\n\turl = …(\n\tbranch = dev)\n` (requires the
  `writeGitmodulesEntry` forward fold).
- `submodule-write.test.ts:63` — config contains
  `'[submodule "libs/a"]\n\tactive = true\n\turl = https://h.x/g/a\n'` and `:83` —
  `'\turl = https://h.x/g/a\n\tupdate = rebase\n'` (requires the `registerOps`
  un-reverse).
- `submodule-update.test.ts:102` / `submodule-sync-recursive.test.ts` fixtures — seeded
  inputs only, unaffected.

### Gate

```
npx vitest run test/unit/application/primitives/update-config.test.ts test/unit/application/primitives/update-config.properties.test.ts test/unit/application/primitives/config-read.test.ts test/unit/application/commands/submodule-add.test.ts test/unit/application/commands/submodule-write.test.ts test/unit/application/commands/submodule-update.test.ts test/unit/application/commands/submodule-sync-recursive.test.ts test/unit/application/commands/submodule.test.ts test/unit/application/commands/remote.test.ts test/unit/application/commands/clone.test.ts test/unit/application/commands/config.test.ts test/unit/application/commands/pull.test.ts
npm run check:types
npx biome check src/application/primitives/update-config.ts src/application/commands/submodule.ts test/unit/application/primitives/update-config.test.ts
```

### Commit

```
git add -A && git commit -m "feat(config): span-aware set and append with end-of-section insertion"
```

---

## S3 — Span-aware remove with empty-block pruning

**Goal**: rebuild `removeConfigEntry` on tokens — full-span removal of every matching
entry plus git's empty-block rule — and retire `isKeyLine`.

### Files

- `src/application/primitives/update-config.ts`
- `test/unit/application/primitives/update-config.test.ts`
- (verify-only) `test/unit/application/commands/remote.test.ts`, `config.test.ts`,
  `submodule-write.test.ts`

### Current code shape

`removeConfigEntry` (line 251 at tip; exported, serves `unsetConfigEntry`,
`unsetAllConfigEntries`, and the `removeEntry` op in `applyConfigOpInText`): after the
same validations, walks lines with an `inTarget` flag — `isSectionHeader` lines toggle
`inTarget = matchesSection(...)` and are always kept; `inTarget && isKeyLine(line,
key)` lines are skipped; everything else kept; `out.join('\n')`. Signature
`(text, section, subsection, key): string` MUST NOT change (it is barrel-public via
`applyConfigOpInText` and direct export).

`unsetConfigEntry` (line 616) / `unsetAllConfigEntries` (line 649) do
`parseIniSectionsForWrite` + `collectValues` multiplicity checks BEFORE calling
`removeConfigEntry` — unchanged; only their doc comments need a sentence about
pruning. Their no-match paths return before any I/O (idempotence tests pin this).

### Rewrite

```ts
const lines = text.split('\n');
const tokens = tokenizeConfig(text);
// group tokens into blocks: a header token + every following token up to the next
// header; tokens before the first header form a preamble that is never modified.
// For each block whose header matches the target:
//   - collect the [startLine, endLine) spans of entries whose ci key matches;
//   - if >= 1 span collected AND the block retains no other entry tokens AND no
//     comment tokens AND header.hasComment === false → drop the header line and the
//     block's blank lines too (the whole block);
//   - else drop only the collected spans (clamped to lines.length).
// Rebuild kept lines; restore the trailing terminator with the shared
// withTrailingNewlineRestored helper from S2.
```

Decision details (mirror the design's distilled rule exactly — quote: *"after removing
the matched entry spans, a block whose remaining lines contain **no entries and no
comments** (header-line inline comments count) is removed entirely, **including its
blank lines**; otherwise every surviving byte is kept"*):

- Pruning applies ONLY to blocks from which at least one span was removed — a matching
  block that never contained the key, or an already-empty unrelated block elsewhere in
  the file, is byte-preserved (per-block rule, D9).
- Lenient `[`-lines tokenized as `comment` protect their block (conservative, opaque
  content is never deleted).
- Entry tokens with `key === ''` count as entries (they protect the block and are
  never matched — keys are validated non-empty upstream).
- Delete `isKeyLine` (its last caller is gone). `isSectionHeader` / `matchesSection` /
  `findSectionHeader` / `replaceLine` / `insertAfter` remain for the untouched
  rename/remove-section machinery (`insertAfter` may become S2-dead — if knip flags
  it, delete it in whichever slice orphans it).
- Update doc comments: `removeConfigEntry` jsdoc (lines 244–250) — span removal +
  empty-block pruning; one sentence each on `unsetConfigEntry` /
  `unsetAllConfigEntries` / the `removeEntry` op variant.

Known byte-shift WITHOUT test churn: `remoteRename` on a remote whose section holds
only `fetch` keys — `removeEntry fetch` now prunes the emptied block and the following
`appendEntry` recreates the section at EOF. This matches git's own
`--unset-all` + `--add` sequence; `remote.test.ts` asserts via `toContain`/`indexOf`
and stays green.

### Pinned behaviour bytes (verbatim design-matrix rows this slice implements)

| id | input bytes | command | output bytes | pinned rule |
| --- | --- | --- | --- | --- |
| B | `[a]⏎⇥key = one\⏎␣␣␣two⏎⇥other = x⏎` | `--unset a.key` | `[a]⏎⇥other = x⏎` | unset removes the whole span |
| F | `[a]⏎⇥key = one\⏎␣␣␣two⏎⇥mid = m⏎⇥key = three⏎⇥key = four\⏎␣␣␣five⏎` | `--unset-all a.key` | `[a]⏎⇥mid = m⏎` | every occurrence's full span removed, single- and multi-line alike |
| L2 | `[a]⏎⇥note = v\⏎[x]⏎⇥key = old⏎` | `--unset a.key` | `[a]⏎⇥note = v\⏎[x]⏎` | a tail that looks like a header is value content; unset removes only the real entry line |
| D | `[a]⏎⇥key = one\⏎␣␣␣two⏎[b]⏎⇥k = v⏎` | `--unset a.key` | `[b]⏎⇥k = v⏎` | removing the only entry removes the **section header too** |
| D2 | `[a]⏎⇥key = one⏎[b]⏎⇥k = v⏎` | `--unset a.key` | `[b]⏎⇥k = v⏎` | same for a single-line entry |
| D3 | `[b]⏎⇥k = v⏎[a]⏎⇥key = one\⏎␣␣␣two⏎` | `--unset a.key` | `[b]⏎⇥k = v⏎` | same when the section is last in the file |
| D4 | `[a]⏎⇥# keep me⏎⇥key = one\⏎␣␣␣two⏎[b]⏎⇥k = v⏎` | `--unset a.key` | `[a]⏎⇥# keep me⏎[b]⏎⇥k = v⏎` | a **comment** in the block keeps the header (and the comment) |
| D6 | `[a]⏎⇥key = one⏎⏎[b]⏎⇥k = v⏎` | `--unset a.key` | `[b]⏎⇥k = v⏎` | **blank** lines do not protect the header — they are removed with it |
| D8 | `[a]⏎⇥key = one⏎⏎# c⏎[b]⏎⇥k = v⏎` | `--unset a.key` | `[a]⏎⏎# c⏎[b]⏎⇥k = v⏎` | comment present → header, blank, and comment all kept |
| D10 | `[a] # note⏎⇥key = one⏎[b]⏎⇥k = v⏎` | `--unset a.key` | `[a] # note⏎[b]⏎⇥k = v⏎` | an inline comment **on the header line** also keeps the header |
| D5 | `[a]⏎⇥key = x⏎⇥key = y\⏎␣␣␣tail⏎[b]⏎⇥k = v⏎` | `--unset-all a.key` | `[b]⏎⇥k = v⏎` | `--unset-all` applies the same rule |
| D9 | `[a]⏎⇥key = x⏎[b]⏎⇥k = v⏎[a]⏎⇥other = y⏎` | `--unset a.key` | `[b]⏎⇥k = v⏎[a]⏎⇥other = y⏎` | the rule is per **block** (header occurrence), not per logical section |

### RED — new tests (`update-config.test.ts`, under `describe('removeConfigEntry', …)`)

One byte-exact test per row above (B, F, L2, D, D2, D3, D4, D5, D6, D8, D9, D10) —
each empty-block guard isolated so condition mutants die one by one. Suggested
Then-titles: B `Then the whole continuation span is removed`; F `Then every
occurrence's full span is removed`; L2 `Then only the real entry line is removed, the
lookalike header tail stays`; D `Then a block emptied of its only entry loses its
header too`; D2 `…single-line entry…`; D3 `Then the emptied last block of the file is
removed and the trailing newline preserved`; D4 `Then a comment line in the block keeps
the header`; D5 `Then unset-all prunes the emptied block`; D6 `Then blank lines do not
protect the header and are removed with it`; D8 `Then a comment keeps the header and
its blank lines`; D9 `Then only the emptied block is pruned, a later same-name block
survives`; D10 `Then an inline comment on the header line keeps the header`.

Plus two guard sentinels:

- `Given an unrelated section that is already empty, When removeConfigEntry targets a
  key elsewhere, Then the already-empty block is preserved byte-for-byte` — input
  `'[empty]\n[a]\n\tkey = v\n\tother = x\n'`, remove `a.key` →
  `'[empty]\n[a]\n\tother = x\n'`.
- `Given a lenient bracket body line as the only survivor, When removeConfigEntry
  empties the entries, Then the header is kept` — input `'[a]\n\t[half\n\tkey = v\n'`,
  remove `a.key` → `'[a]\n\t[half\n'` (opaque content protects the block).

### Existing tests that BREAK — update deliberately

1. `removeConfigEntry > Given the same key in two different sections > … > Then the
   other section is preserved byte-for-byte` (line 1291): expected was
   `'[remote "origin"]\n[remote "upstream"]\n\turl = U\n'` → becomes
   `'[remote "upstream"]\n\turl = U\n'` (the emptied origin block is pruned). Retitle:
   `Then the emptied section is pruned and the other section preserved byte-for-byte`.
2. `removeConfigEntry > Given a key match with different casing > … > Then the key is
   matched case-insensitively (git semantics)` (line 1306): expected was
   `'[remote "origin"]\n'` → becomes `''` (sole entry of sole block; file becomes
   empty — S4 confirms against real git).

Stay green unchanged (sentinels): lines 1231 (`url` removed, `fetch` remains — no
prune), 1246/1261 (no-op byte-identical), 1276 (occurrences removed, `url` remains),
1319 (other-section key untouched), 1336 (valueless removal, neighbours preserved),
the whole `removeConfigSectionInText` / `renameConfigSectionInText` blocks
(1350–1652 — unchanged machinery), `unsetConfigEntry (I/O)` / `unsetAllConfigEntries
(I/O)` blocks (2255–2363 — `not.toContain` + idempotence assertions),
`remote.test.ts` removeEntry flows (`not.toContain`), `config.test.ts`
configUnset/configUnsetAll rows.

### Gate

```
npx vitest run test/unit/application/primitives/update-config.test.ts test/unit/application/primitives/update-config.properties.test.ts test/unit/application/commands/remote.test.ts test/unit/application/commands/config.test.ts test/unit/application/commands/submodule-write.test.ts
npx vitest run test/unit/application
npm run check:types
npx biome check src/application/primitives/update-config.ts test/unit/application/primitives/update-config.test.ts
```

(The full `test/unit/application` sweep catches ripple from the writer behaviour
change anywhere a test seeds a config and asserts bytes — the writer rewrite is now
complete, so this is the cheap point to catch stragglers.)

### Commit

```
git add -A && git commit -m "feat(config): span-aware unset with empty-section pruning"
```

---

## S4 — Interop twins, property invariants, section-surgery pins

**Goal**: pin S1–S3 against real git byte-for-byte; prove the surgery grammar with
properties; pin rename/remove-section span-UNAWARENESS as intended behaviour (no
production code change expected — if an interop twin diverges, fix the writer
minimally and note it).

### Files

- `test/integration/config-interop.test.ts` (extend)
- `test/unit/application/primitives/update-config.properties.test.ts` (extend)
- `test/unit/application/primitives/arbitraries.ts` (extend — shared per-family
  generators live here, per the property-test layout conventions)
- `test/unit/application/primitives/update-config.test.ts` (G/N unit pins)

### Interop scaffolding that already exists (use it, don't reinvent)

`test/integration/interop-helpers.ts` (NOTE: `.ts`, not `.js`): `runGit` (spawns git
with ALL `GIT_*` env scrubbed + `GIT_CEILING_DIRECTORIES` — mandatory for every git
spawn), `tryRunGit`, `makePeerPair(slug)` → `{ peer, ours, dispose }`, `initBothRepos`.
`config-interop.test.ts` already has the twin-file pattern (see its
`Given twin repos with a valueless entry` block at line ~793): write identical
`startingBytes` (prefixed with `'[core]\n\trepositoryformatversion = 0\n'` to keep the
repo valid) to both `<peer>/.git/config` and `<ours>/.git/config` via `writeFile`; run
`tryRunGit(['config', '--file', peerConfigPath, …])` on the peer; run the tsgit
porcelain (`configSet` / `configUnset` / `configUnsetAll` / `configRenameSection` /
`configRemoveSection` from `src/application/commands/config.js`, or
`updateConfigOperations` for the `appendEntry` op) on `ours` via
`createNodeContext({ workDir: pair.ours })`; compare with the section extractors —
`extractASection` (line 666) exists; add tiny siblings as needed (e.g.
`extractFrom(content, '[remote "o"]')`). The suite is `describe.skipIf(!GIT_AVAILABLE)`
and each `it` carries a `60_000` timeout — keep both. Heavy git-spawning tests share
`beforeEach` repos; do not add per-test `git init` beyond the existing pattern.

### Interop twins to add (byte parity, one `it` per row)

Multi-line surgery and placement — fixtures are the verbatim matrix rows quoted in S2/S3
(hand-written, since neither tool writes continuation entries):

1. Set replace across a span (row A) — git `config --file <peer> a.key newval` vs
   tsgit `configSet`; compare `[a]`-onward bytes.
2. Unset removes the span (row B).
3. Unset-all removes every span (row F) — tsgit `configUnsetAll`.
4. `--add` end-of-section (row J) and after a multi-line tail (row J2) — peer:
   `git config --file <peer> --add remote.o.fetch B`; ours:
   `updateConfigOperations(ctx, [{ kind: 'appendEntry', section: 'remote',
   subsection: 'o', key: 'fetch', value: 'B' }])`.
5. New-key placement rows I1, I2, I4 — tsgit `configSet` of `a.other` / `a.new` —
   plus the composed corner the design calls out (last matching block empty while an
   earlier one has entries): starting bytes
   `'[core]\n\trepositoryformatversion = 0\n[a]\n\tk1 = x\n[b]\n\tk = v\n[a]\n'`,
   set `a.new` on both tools and byte-compare (expected: the new key lands right
   after the LAST `[a]` header, per the end-of-last-block rule).
6. Empty-block pruning rows D, D4, D8 — tsgit `configUnset`; also the sole-section
   variant: starting bytes `'[core]\n\trepositoryformatversion = 0\n[a]\n\tkey = v\n'`,
   unset `a.key` → both tools must agree the `[a]` block vanishes entirely (confirms
   S3's empty-string unit expectation in situ).
7. Tail-as-key (row K) and tail-as-header on the set path (row L).
8. Missing-EOF-newline insertion (S2's chosen corner): starting bytes
   `'[core]\n\trepositoryformatversion = 0\n[a]\n\tk = v'` (no trailing LF), set
   `a.other` on both — byte compare pins git's add-missing-newline behaviour. If git
   disagrees with S2's choice, adjust the single `idx === lines.length` branch in
   `update-config.ts` to match and update S2's corner unit test.
9. `remote add` flow: `git -C <peer> remote add o https://e.com/r.git` vs tsgit
   `remoteAdd` (from `src/application/commands/remote.js`) — compare the
   `[remote "o"]`-onward bytes (pins `url` before `fetch` end-to-end).

Rename/remove-section span-unawareness (ADR-317 — both tools must "corrupt"
identically; porcelain takes dotted `<section>.<subsection>` names, so only the
subsectioned N-rows are reachable here):

| id | input bytes | command | output bytes | pinned rule |
| --- | --- | --- | --- | --- |
| N1 | `[a]⏎⇥key = one\⏎[b "s"]⏎[b "s"]⏎⇥k = v⏎` | `--rename-section b.s b.t` | `[a]⏎⇥key = one\⏎[b "t"]⏎[b "t"]⏎⇥k = v⏎` | the lookalike tail is renamed too |
| N2 | `[a "s"]⏎⇥key = one\⏎␣␣␣two⏎[b]⏎⇥k = v⏎` | `--rename-section a.s a.t` | `[a "t"]⏎⇥key = one\⏎␣␣␣two⏎[b]⏎⇥k = v⏎` | body tails pass through |
| N3 | `[a]⏎⇥key = one\⏎[b "s"]⏎⇥inside = t⏎[b "s"]⏎⇥k = v⏎[d]⏎⇥e = f⏎` | `--remove-section b.s` | `[a]⏎⇥key = one\⏎[d]⏎⇥e = f⏎` | same corruption as the top-level remove |

10. N1/N2 via `configRenameSection`, N3 via `configRemoveSection`, each against
    `git config --file <peer> --rename-section/--remove-section` — full-file byte
    compare from the first fixture header onward.

### G-case unit pins (`update-config.test.ts`, in the existing
`removeConfigSectionInText` describe)

Top-level fixtures (outside the dotted porcelain surface — unit-level only, per the
design):

| id | input bytes | command | output bytes | pinned rule |
| --- | --- | --- | --- | --- |
| G2 | `[a]⏎⇥key = one\⏎␣␣␣two⏎[b]⏎⇥k = v⏎` | `--remove-section a` | `[b]⏎⇥k = v⏎` | whole block dropped, tail included (no header-lookalike inside) |
| G3 | `[a]⏎⇥key = one\⏎[b]⏎⇥k = v⏎` (reader: `a.key` = `one[b]`, `a.k` = `v`) | `--remove-section a` | `[b]⏎⇥k = v⏎` | the tail `[b]` is **mistaken for a header**: removal stops there, git keeps lines the reader says belong to `[a]` |
| G5 | `[a]⏎⇥key = one\⏎[b]⏎⇥inside-tail = t⏎[b]⏎⇥k = v⏎[d]⏎⇥e = f⏎` (reader: `a.key` = `one[b]`) | `--remove-section b` | `[a]⏎⇥key = one\⏎[d]⏎⇥e = f⏎` | both lookalike blocks removed — including the tail line, corrupting `a.key`'s value (now `one[d]`) |

Three byte-exact tests calling `removeConfigSectionInText(text, 'a'|'b', undefined)`,
plus N1/N2-shaped unit tests through `renameConfigSectionInText` and an N3-shaped one
through `removeConfigSectionInText`. Test comments must state the intent behaviourally
("canonical git's section machinery is line-based: a continuation tail that parses as
a header is renamed/removed; replicating that byte-for-byte is intended") — **no doc
or ADR references in the code**.

### Property extensions (`update-config.properties.test.ts` — lens 2/4 surgery-preservation invariants, `numRuns: 100`)

Generators in `arbitraries.ts` (exported, kebab-named consts; reuse `subsectionName`
patterns; keep alphabets grammar-safe so `tokenizeConfig` is total over generated
files — values from printable ASCII without `\`, `"`, `#`, `;`, leading/trailing
space; keys per the existing `arbConfigKey` shape):

- `configEntryBlock()`: arbitrary of one block — header `[s]`/`[s "sub"]` (sections
  drawn from a small pool, e.g. `a`/`b`/`zed`, so duplicate-block cases occur;
  subsections alnum) + 0–4 body items drawn from: single-line valued entry, valueless
  entry, multi-line entry (head line value ending in one `\`, then 1–2 tail lines from
  {`␣␣␣cont`, `\tfake = x` key-lookalike, `[lookalike]` header-lookalike}, with the
  non-final tails optionally ending in `\` for chains and the final tail never ending
  in `\`), comment line (`# …`/`; …`), blank line.
- `configFile()`: 1–4 blocks concatenated, always LF-terminated.

Properties, all using `parseIniSections` as the independently-tested oracle (existing
render/parse round-trip properties in the file stay untouched):

1. After `setConfigEntryInText(file, s, sub, k, v)`: reading the output, the first
   `(s, sub, k)` value equals `v`, and every entry OTHER than `(s ci, sub, k ci)`
   entries is unchanged in order and value (compare the section-wise entry lists with
   the operated key filtered out of both sides — set replaces only the first
   occurrence, so same-key duplicates are excluded from the comparison rather than
   asserted).
2. After `removeConfigEntry(file, s, sub, k)`: no `(s, sub, k ci)` entry remains; every
   other entry is unchanged in order and value (pruning never touches parsed entries).
3. No orphan tails: `tokenizeConfig` of either operation's output yields no entry
   whose ci key is outside the input's ci key set plus the operated key (catches
   K/L-style misclassification and A/B-style orphan tails re-parsing as junk).
4. Absent-key stability: `setConfigEntryInText` (and `removeConfigEntry`) targeting a
   key absent from the file leaves every existing entry's parsed value intact.

Properties draw `(s, sub)` from the generator's own pool so hits and misses both occur;
use `fc.pre` sparingly. Never commit a seed.

### Gate

```
npx vitest run test/integration/config-interop.test.ts test/unit/application/primitives/update-config.properties.test.ts test/unit/application/primitives/update-config.test.ts
npm run check:types
npx biome check test/integration/config-interop.test.ts test/unit/application/primitives/update-config.properties.test.ts test/unit/application/primitives/arbitraries.ts test/unit/application/primitives/update-config.test.ts
```

(Interop requires a real `git` on PATH; the suite self-skips otherwise — run it on a
machine with git, which is the normal dev environment here.)

### Commit

```
git add -A && git commit -m "test(config): interop and property pins for span-aware config surgery"
```

---

## Phase boundary (orchestrator, after S4)

- `npm run validate` — full quality gate (coverage, knip dead-code, duplicates,
  ls-lint, typedoc/api.json drift). Expect zero `reports/api.json` diff.
- Review ×3 / refactor / mutation phases per the workflow; the per-guard D-series
  tests and full-token `toEqual` assertions exist precisely to kill condition and
  index mutants in `tokenizeConfig` / `findEntry` / `insertionLine` / the pruning
  guards.

## Plan-time discoveries (diverging from or extending the design doc)

1. **Two `.reverse()` compensations + one implicit-order dependency in
   `submodule.ts`** (the design's call-site table lists `commands/submodule.ts` only
   generically): `registerOps` (lines 151–172) and `writeGitmodulesEntry` (lines
   494–514) reverse their op lists to compensate for after-header insertion — both
   must fold forward once S2 lands; `submoduleAdd` (lines 634–637) issues
   `[set active, set url]` UN-reversed and relies on the reversal to produce the
   pinned `url`-before-`active` bytes — it must swap to `[set url, set active]`.
   All three are folded into S2 so its gate stays green.
2. **Interop helpers live in `interop-helpers.ts`** (TypeScript), not
   `interop-helpers.js`.
3. **Three unpinned corners** the design doesn't decide get deterministic choices
   (S2): comment-only block inserts at `headerLine + 1`; continuation-at-EOF spans
   clamp to the lines array; insertion at EOF of a file missing its trailing LF
   appends one (pinned empirically in S4 interop #8 with a localized fallback plan).
4. **`remoteRename` on a fetch-only remote section** now prunes-then-recreates the
   section at EOF — behaviourally identical to git's `--unset-all` + `--add`
   sequence; no test churn (assertions are `toContain`-based).
5. All design line anchors and current-behaviour claims checked against the worktree —
   accurate. The design's `ConfigToken` shape is implementable as written; the only
   additions are the `key === ''` entry-token rule, the comment-classification of
   lenient `[`-lines, and the file-terminator rule, all read-parity-neutral.
