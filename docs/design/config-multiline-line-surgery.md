# Design — Line-surgery writer vs multi-line entries

## Goal

Close the multi-line faithfulness gap in the targeted config writer (backlog 24.9i, surfaced by 24.9c):

- The line surgery in `src/application/primitives/update-config.ts` classifies each **physical line** independently (`isKeyLine`, `isSectionHeader`, `matchesSection`). An entry whose value spans backslash-continuation lines (`key = a\` ⏎ `␣␣␣b`) is one *logical* entry to the reader (`parseConfigValue` consumes the tail via `nextLineIdx`) but several unrelated lines to the writer: replace rewrites the first line and orphans the tail, unset removes the first line and leaves the tail, append inserts between head and tail, and a tail whose text *looks like* a `key =` line or a `[header]` is misclassified outright.
- tsgit never writes such entries itself (`renderValue` escapes LF to `\n`, `update-config.ts:91`), so this only bites on files written by other tools — but `.git/config` is on-disk state under the prime directive (ADR-226): every write operation must produce the bytes canonical git would.

Pinning git's behaviour also exposed two **pre-existing single-line write divergences** in the same functions (new-key insertion point; empty-section removal on unset) that the span-aware rewrite must take a position on — see the Decision candidates.

## git's exact behaviour (pinned against git 2.54.0)

All pinned empirically via `git config --file` with a scrubbed environment (`env -i`, isolated `HOME`, `GIT_CONFIG_NOSYSTEM=1`). Notation: `⏎` = LF, `⇥` = TAB, `␣` = significant space, `\` = one literal backslash byte. Case ids are referenced throughout the doc and the test plan.

### Set / unset / unset-all / add — parser-event-driven, span-AWARE

| id | input bytes | command | output bytes | pinned rule |
| --- | --- | --- | --- | --- |
| A | `[a]⏎⇥key = one\⏎␣␣␣two⏎⇥other = x⏎` | `a.key newval` | `[a]⏎⇥key = newval⏎⇥other = x⏎` | replace removes **all** physical lines of the old entry; canonical `⇥key = value` lands at the entry's first-line position |
| A2 | `[a]⏎⇥key = one\⏎␣␣␣two\⏎␣␣␣three⏎⇥other = x⏎` | `a.key newval` | `[a]⏎⇥key = newval⏎⇥other = x⏎` | chained continuations (tail ending in `\`) are all part of the span |
| B | `[a]⏎⇥key = one\⏎␣␣␣two⏎⇥other = x⏎` | `--unset a.key` | `[a]⏎⇥other = x⏎` | unset removes the whole span |
| E1 | `[a]⏎⇥key = "one\⏎␣␣␣two"⏎⇥other = x⏎` | `a.key newval` (read: `one␣␣␣two`) | `[a]⏎⇥key = newval⏎⇥other = x⏎` | continuation inside a quote span behaves identically |
| E2 | `[a]⏎⇥key = one # c\⏎⇥next = x⏎` | read `a.key`/`a.next`; then `a.key newval` | reads `one` / `x`; `[a]⏎⇥key = newval⏎⇥next = x⏎` | `\` at EOL **inside a comment** is NOT a continuation; the entry span is one line (the same-line trailing comment is consumed by the replace) |
| F | `[a]⏎⇥key = one\⏎␣␣␣two⏎⇥mid = m⏎⇥key = three⏎⇥key = four\⏎␣␣␣five⏎` | `--unset-all a.key` | `[a]⏎⇥mid = m⏎` | every occurrence's full span removed, single- and multi-line alike |
| K | `[a]⏎⇥note = first\⏎⇥url = fake⏎⇥url = real⏎` | `--get-all a.url`; then `a.url NEW` | reads `real` only; `[a]⏎⇥note = first\⏎⇥url = fake⏎⇥url = NEW⏎` | a tail that *looks like* a `key =` line is value content — never matched, never rewritten |
| L | `[a]⏎⇥note = v\⏎[x]⏎⇥key = old⏎` | read `a.key`; then `a.key NEW` | reads `old`; `[a]⏎⇥note = v\⏎[x]⏎⇥key = NEW⏎` | a tail that *looks like* a section header is value content on the set path — `[a]` continues past it, `key` is found and replaced in place |
| L2 | same as L | `--unset a.key` | `[a]⏎⇥note = v\⏎[x]⏎` | same, unset removes only the real entry line |
| H1 | `[a]⏎⇥key = one\⏎␣␣␣two⏎⇥key = solo⏎` | `--unset a.key 'one.*two'` (read `--get-all`: `one␣␣␣two`, `solo`) | `[a]⏎⇥key = solo⏎` | value patterns match the **joined** value; the whole span of the match is removed |
| H2 | `[a]⏎⇥key = one\⏎␣␣␣two⏎` | `--unset a.key 'nomatch'` | exit 5, file untouched | |

### New-entry insertion point — end of the LAST matching block

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

Reference flows (scrubbed `git init` + porcelain): `git remote add o <url>` writes `url` then `fetch`; `git config branch.x.remote` + `branch.x.merge` writes `remote` then `merge` — i.e. insertion order is preserved because each new key lands at the end of the section.

### Empty-section removal on unset / unset-all

| id | input bytes | command | output bytes | pinned rule |
| --- | --- | --- | --- | --- |
| D | `[a]⏎⇥key = one\⏎␣␣␣two⏎[b]⏎⇥k = v⏎` | `--unset a.key` | `[b]⏎⇥k = v⏎` | removing the only entry removes the **section header too** |
| D2 | `[a]⏎⇥key = one⏎[b]⏎⇥k = v⏎` | `--unset a.key` | `[b]⏎⇥k = v⏎` | same for a single-line entry |
| D3 | `[b]⏎⇥k = v⏎[a]⏎⇥key = one\⏎␣␣␣two⏎` | `--unset a.key` | `[b]⏎⇥k = v⏎` | same when the section is last in the file |
| D4 | `[a]⏎⇥# keep me⏎⇥key = one\⏎␣␣␣two⏎[b]⏎⇥k = v⏎` | `--unset a.key` | `[a]⏎⇥# keep me⏎[b]⏎⇥k = v⏎` | a **comment** in the block keeps the header (and the comment) |
| D6 | `[a]⏎⇥key = one⏎⏎[b]⏎⇥k = v⏎` | `--unset a.key` | `[b]⏎⇥k = v⏎` | **blank** lines do not protect the header — they are removed with it |
| D8 | `[a]⏎⇥key = one⏎⏎# c⏎[b]⏎⇥k = v⏎` | `--unset a.key` | `[a]⏎⏎# c⏎[b]⏎⇥k = v⏎` | comment present → header, blank, and comment all kept |
| D10 | `[a] # note⏎⇥key = one⏎[b]⏎⇥k = v⏎` | `--unset a.key` | `[a] # note⏎[b]⏎⇥k = v⏎` | an inline comment **on the header line** also keeps the header |
| D5 | `[a]⏎⇥key = x⏎⇥key = y\⏎␣␣␣tail⏎[b]⏎⇥k = v⏎` | `--unset-all a.key` | `[b]⏎⇥k = v⏎` | `--unset-all` applies the same rule |
| D9 | `[a]⏎⇥key = x⏎[b]⏎⇥k = v⏎[a]⏎⇥other = y⏎` | `--unset a.key` | `[b]⏎⇥k = v⏎[a]⏎⇥other = y⏎` | the rule is per **block** (header occurrence), not per logical section |

Distilled rule: after removing the matched entry spans, a block whose remaining lines contain **no entries and no comments** (header-line inline comments count) is removed entirely, **including its blank lines**; otherwise every surviving byte is kept.

### Rename-section / remove-section — line-based, span-UNAWARE

git's `--rename-section` / `--remove-section` machinery reads physical lines and treats any line whose content parses as a section heading as one — **including a continuation tail**. This is the same split ADR-313 pinned for refusal shapes; it extends to span handling:

| id | input bytes | command | output bytes | pinned rule |
| --- | --- | --- | --- | --- |
| G1 | `[a]⏎⇥key = one\⏎␣␣␣two⏎[b]⏎⇥k = v⏎` | `--rename-section a c` | `[c]⏎⇥key = one\⏎␣␣␣two⏎[b]⏎⇥k = v⏎` | body lines (incl. tails) pass through verbatim |
| G2 | same as G1 | `--remove-section a` | `[b]⏎⇥k = v⏎` | whole block dropped, tail included (no header-lookalike inside) |
| G3 | `[a]⏎⇥key = one\⏎[b]⏎⇥k = v⏎` (reader: `a.key` = `one[b]`, `a.k` = `v`) | `--remove-section a` | `[b]⏎⇥k = v⏎` | the tail `[b]` is **mistaken for a header**: removal stops there, git keeps lines the reader says belong to `[a]` |
| G4 | `[a]⏎⇥key = one\⏎[b]⏎[b]⏎⇥k = v⏎` | `--rename-section b c` | `[a]⏎⇥key = one\⏎[c]⏎[c]⏎⇥k = v⏎` | the tail `[b]` is **renamed** — git rewrites value content (the joined value changes from `one[b]` to `one[c]`) |
| G5 | `[a]⏎⇥key = one\⏎[b]⏎⇥inside-tail = t⏎[b]⏎⇥k = v⏎[d]⏎⇥e = f⏎` (reader: `a.key` = `one[b]`) | `--remove-section b` | `[a]⏎⇥key = one\⏎[d]⏎⇥e = f⏎` | both lookalike blocks removed — including the tail line, corrupting `a.key`'s value (now `one[d]`) |
| N1 | `[a]⏎⇥key = one\⏎[b "s"]⏎[b "s"]⏎⇥k = v⏎` | `--rename-section b.s b.t` | `[a]⏎⇥key = one\⏎[b "t"]⏎[b "t"]⏎⇥k = v⏎` | subsectioned variant of G4 — the lookalike tail is renamed too |
| N2 | `[a "s"]⏎⇥key = one\⏎␣␣␣two⏎[b]⏎⇥k = v⏎` | `--rename-section a.s a.t` | `[a "t"]⏎⇥key = one\⏎␣␣␣two⏎[b]⏎⇥k = v⏎` | subsectioned variant of G1 — body tails pass through |
| N3 | `[a]⏎⇥key = one\⏎[b "s"]⏎⇥inside = t⏎[b "s"]⏎⇥k = v⏎[d]⏎⇥e = f⏎` | `--remove-section b.s` | `[a]⏎⇥key = one\⏎[d]⏎⇥e = f⏎` | subsectioned variant of G5 — same corruption |

So canonical git is itself span-unaware on these two operations. **tsgit's current line surgery is byte-identical to git's** on every fixture its surface can express — verified by running `removeConfigSectionInText` on G3/G5 (top-level removes) and `renameConfigSectionInText` / `removeConfigSectionInText` on N1/N2/N3 (the subsectioned forms the porcelain reaches; `renameConfigSection` only accepts dotted `<section>.<subsection>` names, `update-config.ts:677–696`, so top-level G1/G4 are git-only pins). Faithfulness requires *keeping* the line-based machinery, not "fixing" it. The backlog entry's suspicion that 24.9g's line surgery shares the bug is answered: it shares the behaviour **with git**, which makes it correct.

## Current state — what each tsgit write op does today

Verified by executing the current functions on the pinned fixtures (probe outputs, worktree at branch tip):

| case | tsgit today (`update-config.ts`) | vs git | class |
| --- | --- | --- | --- |
| A replace | `[a]⏎⇥key = newval⏎␣␣␣two⏎⇥other = x⏎` — orphan tail (`replaceLine` at `setConfigEntryInText`, lines 234–236 replaces one line) | ✗ | **multi-line bug** |
| B unset | `[a]⏎␣␣␣two⏎⇥other = x⏎` — orphan tail (`removeConfigEntry` line 269 skips only `isKeyLine` lines) | ✗ | **multi-line bug** |
| J2 append | `[remote "o"]⏎⇥fetch = A\⏎⇥fetch = B⏎␣␣␣tail⏎` — inserted **between head and tail** (`findLastKeyInSection`, lines 468–480, returns the first physical line of the last match) | ✗ | **multi-line bug** |
| K tail-as-key | replaces the tail `⇥url = fake` (value content!) instead of the real `url = real` entry — `isKeyLine` (line 62) matches the tail | ✗ | **multi-line bug** |
| L tail-as-header | `findKeyInSection` (lines 132–143) stops at the `[x]` tail (`isSectionHeader`, line 46) → key "absent" → duplicate `key` inserted after the header | ✗ | **multi-line bug** |
| C / I1–I4 / J placement | new key inserted **right after the header** (`insertAfter(lines, headerIndex, …)`, line 237; `appendConfigEntry` falls back to `headerIndex` and otherwise chains after the last same-key line, lines 457–458), and `findSectionHeader` (line 116) picks the **first** matching block | ✗ | **pre-existing single-line divergence** |
| D/D2–D10 empty section | header always kept (`removeConfigEntry` only drops key lines) | ✗ | **pre-existing single-line divergence** |
| G3/G5/N1–N3 rename/remove | byte-identical to git (line-based on both sides) | ✓ | faithful — keep |
| E2 comment-`\` | reader already correct (`stepValueChar` returns before the `\` check when `inComment`, `config-read.ts:305`) | ✓ | n/a (reader) |

The placement divergence is not theoretical: tsgit's own flows already emit reversed sections. `applyConfigOpInText({set url}, {appendEntry fetch})` (the `remote add` path in `commands/remote.ts`) produces `[remote "o"]⏎⇥fetch = …⏎⇥url = u⏎` where git writes `url` then `fetch`; sequential `branch.x.remote` + `branch.x.merge` sets produce `merge` before `remote`. No current interop fixture sets a *new* key into a section that already has entries, which is why this never failed.

Read surfaces are unaffected: `parseIniSections` (`config-read.ts:174`) walks values span-aware through `parseConfigValue` (`config-read.ts:276`), whose `ParsedValue.nextLineIdx` (`config-read.ts:261–265`) is exactly the writer's missing knowledge. `collectValues`-driven checks (`unsetConfigEntry` multiplicity, `previousValue` on the porcelain unset, `configGetRegexp` with `valuePattern`) all sit on the parsed entries and are already correct. There is no value-pattern **unset** surface in tsgit (`valuePattern` exists only on `configGetRegexp`, `commands/config.ts:74`), so H1/H2 are pinned for the record only.

## Design

### Shared structural tokenizer in `config-read.ts`

Make the spans the parser already computes available to the writer, instead of letting the writer re-classify lines with its own (wrong) grammar. One new exported, non-barrel function plus a token type:

```ts
/** Physical-line classification of git-config text; the writer's surgery unit. */
export type ConfigToken =
  | {
      readonly kind: 'header';
      readonly section: string;
      readonly subsection: string | undefined;
      readonly line: number;
      /** Header line carries an inline `#`/`;` comment (blocks empty-section pruning, D10). */
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

`tokenizeConfig` is the existing `parseIniSections` loop with the section-folding removed: same header three-state handling (ADR-312, `parseSectionHeader`), same valueless-key grammar (24.9h, `processValuelessLine` semantics), same `parseConfigValue` value grammar and `CONFIG_PARSE_ERROR` / `partialSectionName` refusals (ADR-308/313). `parseIniSections` is then re-expressed as a fold over `tokenizeConfig` — one tokenizer, two consumers, zero behaviour change on the read side (the existing read-surface tests pin this). Today's conflation of blank and comment-only lines (both skipped via `stripInlineComment(line).trim() === ''`, `config-read.ts:181–186`) is split into the two token kinds because the empty-block rule needs the distinction (D6 vs D8); the fold treats both as skip, so `IniSection` output is untouched.

`parseConfigValue` itself stays private — the writer consumes tokens, not the value grammar.

### Writer surgery on token spans (`update-config.ts`)

All four span-aware operations are rebuilt on `tokenizeConfig`; the file is still manipulated as a `lines` array, but every classification question is answered by tokens:

- **Replace** (`setConfigEntryInText`, existing key): find the first matching `entry` token in any matching block (M: first match wins) and splice `[startLine, endLine)` with the rendered `⇥key = value` line (A, A2, E1, K, L).
- **Insert new** (`setConfigEntryInText` absent key, and `appendConfigEntry` always): insertion line = `endLine` of the last `entry` token of the **last** matching block, or `headerLine + 1` when that block has no entries (C, I1–I4, J, J2; the "last block is empty while an earlier one isn't" corner composes I3+I4 and is pinned in interop when the tests land). `findLastKeyInSection` and the per-key chaining disappear; insertion-order preservation for repeated appends comes free from end-of-section placement. Section absent → append `[header]⏎entry⏎` at EOF, unchanged (`setConfigEntryInText` lines 229–232).
- **Remove** (`removeConfigEntry`, serving `unsetConfigEntry`, `unsetAllConfigEntries`, and the `removeEntry` op): drop the full `[startLine, endLine)` span of every matching entry (B, F), then apply the **empty-block rule** per affected block: if the block now contains no `entry` tokens and no `comment` tokens and its header token has `hasComment: false`, drop the header line and the block's `blank` lines too (D, D2–D6, D9, D10 keep/D8 keep). Trailing-newline preservation follows the same care `removeConfigSectionInText` already takes (lines 304–311).
- **Block matching** reuses the parsed `section`/`subsection` carried on `header` tokens with today's `matchesSection` semantics (case-insensitive section, case-sensitive subsection, `undefined` matching `''` — the 24.9k conflation stays as-is).

Current vs proposed internal signatures:

```ts
// SectionTarget below = { section: string; subsection: string | undefined },
// matched with today's matchesSection semantics.

// current (update-config.ts)
const isKeyLine = (line: string, key: string): boolean;                                  // line 62 — retired
const findKeyInSection = (lines: ReadonlyArray<string>, headerIndex: number, key: string): number;      // line 132 — retired
const findLastKeyInSection = (lines: ReadonlyArray<string>, headerIndex: number, key: string): number;  // line 468 — retired

// proposed
const findEntry = (tokens: ReadonlyArray<ConfigToken>, target: SectionTarget, key: string): EntryToken | undefined;
const insertionLine = (tokens: ReadonlyArray<ConfigToken>, target: SectionTarget): number | undefined;   // end of LAST matching block
const removeEntrySpans = (lines: ReadonlyArray<string>, tokens: ReadonlyArray<ConfigToken>, target: SectionTarget, key: string): ReadonlyArray<string>; // span removal + empty-block pruning
```

The set/unset/append paths already parse-first (`parseIniSectionsForWrite`, lines 539–555, per ADR-313), so `tokenizeConfig` succeeding is guaranteed on every input that reaches surgery; the pure `*InText` functions call it directly and inherit the same refusals when used standalone.

### Rename-section / remove-section — deliberately unchanged

`renameConfigSectionInText` (line 321), `removeConfigSectionInText` (line 284), and the line-based existence checks in `renameConfigSection` / `removeConfigSection` (lines 730, 764) keep their physical-line machinery: git's own implementation is line-based and span-unaware (G3–G5), and tsgit's current output is byte-identical to git's on every pinned fixture, including the value-corrupting ones. Making them span-aware would be a faithfulness regression. The G-cases are added to the unit and interop suites to pin this *as intended behaviour* so a future "fix" can't sneak in.

## Affected call sites

| caller | path | effect of the change |
| --- | --- | --- |
| `setConfigEntry` → `setConfigEntryInText` | porcelain `configSet`, many commands | span-correct replace; new keys land at section end (byte change vs today for existing sections) |
| `updateConfigEntries` / `updateCoreConfig` | init/clone/submodule flows | same |
| `applyConfigOpInText` `set`/`appendEntry`/`removeEntry` | `commands/remote.ts`, `commands/submodule.ts` | `remote add` now writes `url` before `fetch` (matches git); removals prune emptied blocks |
| `unsetConfigEntry` / `unsetAllConfigEntries` | porcelain `configUnset`/`configUnsetAll` | span removal + empty-block pruning (byte change: header no longer lingers) |
| `renameConfigSection*` / `removeConfigSection*` | porcelain + `remote rm` | no change (pinned faithful) |
| `parseIniSections` consumers (config reads, scoped reads, `.gitmodules`, sequencer state) | read side | no behaviour change; internal re-expression over `tokenizeConfig` |
| `reports/api.json` | public surface | unchanged — `tokenizeConfig` is internal (not barrel-exported), writer signatures keep their shapes |

Existing unit fixtures that pin the after-header insertion (`update-config.test.ts`) and header-survives-unset bytes are updated to the git-faithful expectation.

## Test plan

- **Unit (`update-config.test.ts`)** — one example test per matrix row: A, A2, B, E1, E2 (writer side), F, K, L, L2 (span integrity); C, I1–I4, J, J2, M (insertion point / first-match replace); D, D2–D6, D8–D10 (empty-block rule, each guard isolated: entry-remains, comment-remains, header-inline-comment, blank-only, per-block, unset-all); G2/G3/G5 via `removeConfigSectionInText` and N1/N2/N3 via `renameConfigSectionInText`/`removeConfigSectionInText` (rename/remove unchanged — pinned as faithful with a comment pointing at this design; top-level G1/G4 renames are outside tsgit's dotted-name surface). Error-shape tests keep asserting `.data` via try/catch (mutation-resistant).
- **Unit (`config-read.test.ts`)** — `tokenizeConfig`: span boundaries (`startLine`/`endLine`) for single-line, two-line, chained, quoted-continuation, and comment-`\` entries; `blank` vs `comment` classification; `hasComment` on header lines; refusal parity with `parseIniSections` (same `CONFIG_PARSE_ERROR` line numbers / `partialSectionName`); `parseIniSections` output unchanged over the existing corpus.
- **Interop (`test/integration/config-interop.test.ts`, extended)** — twin files (hand-written multi-line fixtures, since neither tool writes them): byte parity for set (A), unset (B), unset-all (F), `--add` vs `appendEntry` op (J, J2), set-new-key placement (I1, I2, I4), empty-block pruning (D, D4, D8), tail-as-key (K), tail-as-header on the set path (L); rename/remove-section on the subsectioned N1/N2/N3 fixtures (span-unaware parity — both tools "corrupt" identically; the porcelain takes dotted names, so the top-level G fixtures stay unit-level); `remote add` flow vs `git remote add` section bytes.
- **Property (`update-config.properties.test.ts`, extended — lens 2/4, surgery-preservation invariants, numRuns 100)** — generator: a config file assembled from arbitrary blocks of single- and multi-line entries (continuation tails drawn to include key-lookalike and header-lookalike shapes), comments and blanks. Properties, all through `parseIniSections` as the independently-tested oracle:
  - after `setConfigEntryInText(t, …k, v)`: `k` reads back as `v`, and every **other** entry's parsed value is unchanged;
  - after `removeConfigEntry(t, …k)`: `k` is absent, every other entry unchanged;
  - surgery never orphans a tail: re-tokenizing the output yields no entry whose key is outside the input's key set plus the operated key (catches K/L-style misclassification and A/B-style orphan tails re-parsing as junk);
  - round-trip stability: operating on a key absent from the file leaves all existing entries' parsed values intact.
  - The existing render/parse round-trip properties (24.9c) are untouched; generators join the file's existing arbitrary helpers.
- **Mutation** — standard target: 0 killable survivors on the touched files; the per-guard empty-block tests exist precisely to kill the condition mutants.

## Out of scope (follow-ups, kept as-is)

- **24.9m char-wise parser parity** — same-line `[a] key = v` constructs, `=`-path key grammar; the tokenizer stays line-anchored exactly as today.
- **24.9k `[s ""]` vs `[s]` matching** — `matchesSection`'s conflation is preserved verbatim in the token-based matcher.
- **Value-pattern unset** (`--unset section.key <pattern>`) — pinned (H1/H2: pattern matches the joined value, whole span removed) but tsgit has no such surface; recorded for whenever one is added.
- **Replacement formatting of exotically-indented originals** — git's set always emits canonical `⇥key = value` at the span position (A, K, L); whether git preserves anything subtler about original indentation elsewhere is untested and unchanged.
- **Sectionless (orphan) keys** — tokens before the first header belong to no block and are ignored by surgery, same as today's reader leniency (24.9h D6).

## Decision candidates (open — not pre-decided by existing ADRs)

git's pinned behaviour fully determines the **target bytes** for every operation; the open choices are *scope*, not shape:

1. **Fold the new-key insertion-point fix (end of last matching block: C, I1–I4, J, J2) into this item, or split it?**
   Options: (a) fold here — the span rewrite must pick an insertion line anyway, and only git's is faithful; fixes today's reversed `remote`/`branch` sections in tsgit-written files; (b) keep after-header insertion and fix only span integrity — leaves a known byte divergence and needs a contradictory "insert after header but skip tails" rule; (c) separate backlog item + ADR. **Recommendation: (a)** — (b) is more code for less faithfulness.
2. **Fold empty-section removal on unset/unset-all (D-series) in, or split it?**
   Options: (a) fold here — the brief's pinned matrix explicitly asks for it, the rule is small and per-block, and it rides the same `removeConfigEntry` rewrite; (b) backlog follow-up, keep headers lingering. **Recommendation: (a)**.
3. **Pin rename/remove-section span-unawareness as intended (no code change), or diverge to span-aware?**
   Git itself mangles G4/G5; the prime directive (ADR-226) plus ADR-313's line-based precedent make replication the default — divergence would need its own ADR with a rationale for corrupting *differently* from git. **Recommendation: replicate (no change), pin with G-case tests.** Listed only because the backlog entry assumed the opposite ("do they have the same bug?" — they do, and so does git).

(The tokenizer shape — shared `tokenizeConfig` vs exporting `parseConfigValue` raw — is an internal, non-load-bearing choice; the design picks the tokenizer so the writer never re-implements grammar.)
