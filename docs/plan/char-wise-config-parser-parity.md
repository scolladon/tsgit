# Plan — Char-wise config parser parity

> Source: design doc `docs/design/char-wise-config-parser-parity.md` · ADRs 330, 331, 332, 333, 334
> The plan is the implementation script AND the knowledge handoff. Slice agents start
> with zero context: whatever a slice block omits is paid later as agent rediscovery.
> `plan-lint.sh` enforces the schema below — the plan phase cannot close without it.

Three sequential vertical slices, one atomic commit each, sharing one working tree: **(1)** the read path (unified `scanKey` + `scanHeaderPrefix` + same-line entry tokenization + orphan recording, with its unit/property/read-interop rows); **(2)** the entry-surgery writer split (set/unset shared-line split and prune, with writer unit + write interop); **(3)** the section-ops move to the token stream (rename/remove same-line + raw-tail + leniency, with section-op unit + interop). Count = 3 because the three buckets stack on one shared tokenizer change (slice 1 lands the tokenizer + token-model field; slices 2 and 3 each consume it on a distinct write surface), and each surface stands alone at its gate — splitting further would create test-only or non-green slices.

## Sizing rules

- Every slice costs a full agent lifecycle (spin-up, zero-context rebuild, gate) — it
  must earn it. No standalone test-only slices: coverage/interop/property tests fold
  into the implementation slice whose code they exercise.
- A slice that would be a pure test pass over already-landed code merges into its
  neighbour.

## Conventions (apply to every slice)

- Test titles: `describe('Given …')` > `describe('When …')` > `it('Then …')` (2-level shortcut allowed when one expectation under the When). AAA body with `// Arrange` / `// Act` / `// Assert` comments. SUT variable named `sut` (the function/object under test, never the result — result goes in `result`).
- Error assertions: try/catch, then assert `.data.code` / `.data.line` / `.data.source` directly. Never bare `toThrow(Class)` (leaves StringLiteral mutants). Guard clauses get an isolated per-condition test.
- No provenance refs (no `§`/`Phase`/`ADR-NNN`/backlog tokens) in any source or test code, comments included. The commit is the join point.
- Use Serena symbol tools to read/navigate/edit (`find_symbol`, `find_referencing_symbols`, `replace_symbol_body`, `insert_after_symbol`); run `get_diagnostics_for_file` after each source edit. Diagnostics are advisory — ground truth is the slice gate.
- Reference pins (git 2.54, already verified in the design's Buckets 1–5 — reproduce inside the interop tests, never trust memory).

## Public-surface note (decided up front — no gate trips)

`ConfigToken` (slice 1 adds an optional same-line marker to its `entry` arm) and `SectionHeaderParse` are exported from `config-read.ts` but are **internal**: the primitives barrel `src/application/primitives/index.ts` re-exports `IniSection`/`ParsedConfig`/`ValuelessEntry` and the config functions, but **not** `ConfigToken` or `SectionHeaderParse` (verified: both appear 0 times in `reports/api.json`, and `typedoc.json` resolves only barrel entry points). `scanKey` and `scanHeaderPrefix` are new **internal** symbols (slice 1 keeps them un-barreled — only `config-read.ts` and the writer's `tokenizeConfigLines` consumer touch the token stream, never `scanKey` directly). Net: **no `reports/api.json` change is required and no `npm run docs:json` regen is owed at any slice or at the phase boundary.** Reuses `CONFIG_PARSE_ERROR` (no new error code); no new Tier-1 command. The optional marker on `ConfigToken.entry` keeps every existing `update-config.ts` consumer compiling unchanged.

---

## Slice 1 — read path: unified key scanner, same-line header entries, orphan recording

### Context

**Goal bytes (design Bucket 1/2/3).** After this slice, the read path reproduces:
- B1a `[a] key = v⏎` → `a.key = v`; B1c `[a]key=v⏎` → `a.key = v`; B1f `[a]⇥key = v⏎` → `a.key = v`; B1g `[a "s"] key = v⏎` → `a.s.key = v`; B1k `[a]key⏎` / B1b `[a] key⏎` → `a.key` valueless (`value: null`); B1l `[a] key=⏎` → `a.key = ''`; B1m `[a] key = v⏎⇥k2 = v2⏎` → both entries; B1n `[a] key = a=b⏎` → value `a=b`; B1o `[a]  key  =  v⏎` → trimmed; B1p `[a] key = one\⏎␣␣two⏎` → continuation `one␣␣two`; B1q `[a] key = v\r⏎` → CRLF; B1e `[a] # c⏎` → header only, no entry.
- B1h `[a] bad!key = v⏎` / B1r `[a] foo bar = v⏎` / B1s `[a] foo.dot = v⏎` → `CONFIG_PARSE_ERROR` line 1.
- B2a `orphan = v⏎` → recorded `orphan` (bare key, no dot) under `('', undefined)`; B2b `orphan⏎` → recorded valueless; B2c `orphan = v⏎[a]⏎⇥k = w⏎` → both; B2d `bad!orphan = v⏎` / B2e `9orphan = v⏎` → `CONFIG_PARSE_ERROR` line 1.
- B3-ok1 `⇥k = v` / B3-ok2 `⇥k   = v` / B3-ok3 `⇥k⇥= v` (under `[a]`, line 2) → `a.k = v`; B3a `⇥bad!key = v` / B3c `⇥under_score` / B3d `⇥9key` / B3e `⇥-key` / B3f `⇥key.dot` / B3g `⇥key@at` / B3j `⇥key x = v` → `CONFIG_PARSE_ERROR` line 2.
- D3 preservation (each its own test): `ab#cd = x`, `ab;cd = x`, `ab # cd = x`, `key#=v` → refuse; `#whole = line` → comment (no entry); `k = v # trailing` → records `a.k = v`.

**Files / symbols to touch:**
- `src/application/primitives/config-read.ts`:
  - `tokenizeConfigLines` (lines ~256–308) — the line-classifier. Today: per line it strips inline comment, trims, calls `parseSectionHeader(trimmed)`; on `header` pushes a header token and `lineIdx += 1`; else computes `effectiveEqualsIndex(line)` and routes to `classifyValuelessLine` (no `=`) or slices `line.slice(0, eqAt).trim()` as the key and `parseConfigValue(lines, lineIdx, eqAt+1, source)` for the value. **Rework:** when `parseSectionHeader` (over the **raw** line via the new `scanHeaderPrefix`) returns `header`, push the header token, then skip GIT_SPACE from `endOffset`, and if non-comment content remains run `scanKey` + `parseConfigValue` on the remainder to emit a **second** same-line `entry` token (or a same-line valueless `entry`, or nothing if the next non-space char is `#`/`;`). The non-header, non-blank path runs the unified `scanKey` over the raw line from its first non-space column.
  - NEW `scanKey(line, start, source, lineIdx)` — one scanner replacing `VALUELESS_KEY_RE` (line 208), `classifyValuelessLine` (216–232), `effectiveEqualsIndex` (347–357), and the unvalidated `line.slice(0, eqAt).trim()` path. Grammar: `s[start]` must be `[a-zA-Z]` (else parse error); consume `[a-zA-Z0-9-]*` into key; skip space/TAB only; then EOL-or-`\r`-at-EOL → valueless (`value: null`); `=` → `value = parseConfigValue(lines, lineIdx, eqCol+1, source)`; anything else (incl. mid-key `#`/`;`) → parse error. Return shape carries `{ key, value, nextLineIdx }` so the caller advances `lineIdx` for continuations.
  - NEW `scanHeaderPrefix(rawLine)` → `{ parse: SectionHeaderParse, endOffset: number }` (ADR-334). Reuse `scanQuotedSpan` (577–604) for the quoted-subsection branch — it already finds the closing `]`; expose the offset it discards. For the plain `[section]` branch, `endOffset` is the index just past the `]` that closes the bracket span. `parseSectionHeader` (545–557) keeps its trimmed-input contract unchanged (matchers in `update-config-sections.ts` still call it). `scanHeaderPrefix` runs over the raw line; on `not-header`/`malformed` the tokenizer keeps today's behavior (malformed → `configParseError(.., partialName)`; not-header → fall to the key path).
  - `ConfigToken` (177–195) `entry` arm — add **optional** `sharesHeaderLine?: true` and `startCol?: number` (ADR-330 D1(a)): a same-line entry's `[startLine, endLine)` still names physical lines; `startCol` marks where the entry begins on the shared header line. Plain entries omit both (writer ignores absent fields → existing consumers compile unchanged).
  - `parseIniSections` (328–340) — open an implicit orphan `SectionBuilder` (`section: ''`, `subsection: undefined`, `entries: []`) from file start so key tokens before the first header accumulate into it (ADR-333 D4). Keep the `token.key !== ''` guard. Push the orphan builder into `sections` only if it gathered entries (so a header-only file is unchanged). A real `[...]` header still opens a new builder.
- `src/application/primitives/internal/config-key.ts` `qualifyKey` (lines 9–14) — orphan special-case: when `section.section === '' && section.subsection === undefined`, return the bare lowered `rawName` (no leading dot); leave `[ ""]` (`'', ''`) → `.name` and `[ "x"]` → `.x.name` exactly as today.

**Reuse (no change):** `parseConfigValue` (405–422) is already the char-wise value grammar — same-line and continuation values reuse it verbatim. `GIT_SPACE` (373) is the space set for the post-`]` and post-key skips. `configParseError(line, source, partialName?)` is the only error constructor (`src/domain/commands/error.ts:425`). `parseConfigKey` (`src/domain/commands/config-key.ts:62`) already throws `CONFIG_KEY_INVALID 'missing-name'` on a dotless key — orphan unaddressability falls out free, no change.

**Consumers that inherit (verify, do not edit unless types ripple):** `commands/config.ts` `configList` (117–134) / `configGetRegexp` (88–107) iterate `section.entries` via `qualifyKey` → orphan keys surface as bare keys automatically. `parse-gitmodules.ts` reuses `parseIniSections`. `config-scoped-read.ts` reuses the tokenizer.

**Tests to extend:**
- Unit `test/unit/application/primitives/config-read.test.ts` (~3500 lines, GWT split). **Two existing tests pin the OLD orphan-drop behavior and MUST be rewritten** (not deleted):
  - `describe('parseIniSections — leniency preserved')` > `'Given a valid valueless key before any section (orphan)…'` (line ~3011) — today asserts `'key\n[a]\n\tv = ok\n'` → only the `[a]` section. Rewrite: the orphan `key` now records under `{ section: '', subsection: undefined, entries: [{ key: 'key', value: null }] }`, **plus** the `[a]` section. Update the `toEqual` accordingly.
  - `'Given an orphan entry before any header, When tokenizeConfig'` (line ~3442) — today asserts `'key = v\n[a]\n'` → `parseIniSections` yields only `[a]` (empty). The **token stream is unchanged** (orphan entry token then header token — keep that assertion), but the `parseIniSections` `toEqual` now includes the orphan section `{ section: '', subsection: undefined, entries: [{ key: 'key', value: 'v' }] }` before `[a]`.
  - The `readConfig` lenient-orphan test at line ~494 (`'orphan = value\n[core]\n  bare = true\n'` → `core.bare === true`) stays green: orphan recording does not feed `dispatchSection` (`''` never matches a typed section), so `core` is unaffected — assert it still passes, do not change it.
- Property `test/unit/application/primitives/config-read.properties.test.ts` (existing valueless-grammar props at top; `parseIniSections` imported). Add: Lens-1 round-trip (numRuns 200) — for an arbitrary header identity + valid key + safe value, `parseIniSections('${headerText} ${key} = ${value}\n')` (same-line) records `header.key = value`; no-`=` form records `value: null`. Lens-3 totality (numRuns 100) — `scanKey` over the ASCII-no-NUL key-char boundary either records `{key, value}`/valueless or throws exactly `CONFIG_PARSE_ERROR` (assert `err.data.code`), never anything else; partition over the first-char-alpha vs alnum-dash boundary. Reuse `arbHeaderIdentity` / `arbConfigKey` from `test/unit/application/primitives/arbitraries.ts` (lines 89, 340); add `arbSafeValue`-equivalent if not already exported (it is module-private — add a local or export it). Lens-4 idempotence — `parseIniSections(rerender(parseIniSections(x))) ≡ parseIniSections(x)` stability across same-line/orphan inputs (a small `rerender` that emits `[s]⏎⇥key = v` / bare orphan).
- Interop `test/integration/config-interop.test.ts` (`describe.skipIf(!GIT_AVAILABLE)('config interop')`, `beforeEach` makes `pair = await makePeerPair('config')`; each `it` carries `60_000`). Read/refusal twins for this slice (model on the existing valueless `--list -z` reconstruction block ~675 and the `VALUELESS_REFUSAL_MATRIX` block ~744):
  - Same-line read parity: write `[a] key = v⏎` (and B1b/B1c/B1g/B1m/B1l) to `pair.ours/.git/config`, reconstruct `configList` stdout (`value === null ? '${key}\n' : '${key}=${value}\n'`), compare byte-for-byte to `git config --file <ours> --list` (via `tryRunGit`). Reuse `parseGitConfigList` only if comparing maps; the existing block compares reconstructed `--list` text directly.
  - Orphan read parity: `orphan = v⏎` and `orphan⏎` → reconstructed `configList` matches git's `orphan=v\n` / `orphan\n` (bare key, no dot). Orphan unaddressability: `git config --file <ours> --get orphan` exits 1 with `key does not contain a section`; tsgit `getConfigValue({key:'orphan'})` (or `parseConfigKey('orphan')`) throws `CONFIG_KEY_INVALID` (assert `.data.code` and `.data.reason === 'missing-name'`).
  - Refusal parity (extend or add a matrix like `VALUELESS_REFUSAL_MATRIX`): B1h/B1r/B1s on line 1, B3a/B3c/B3d/B3e/B3f/B3g/B3j on line 2, B2d/B2e on line 1 — both git (`bad config line N`, non-zero exit) and tsgit (`CONFIG_PARSE_ERROR`, `.data.line === N`) refuse with the same 1-based line.

### TDD steps

- **RED** (config-read.test.ts, new GWT blocks + the two rewrites above):
  1. Tokenizer same-line: each of B1a/B1b/B1c/B1f/B1g/B1k/B1l/B1m/B1n/B1o/B1p/B1q/B1e its own `it` asserting the token stream (header token + same-line `entry`/valueless `entry`/none) and, where it adds signal, the `parseIniSections` section result. Expected failure: today `tokenizeConfig('[a] key = v\n')` emits one entry keyed `[a] key` and `parseIniSections` drops it.
  2. Same-line continuation span (B1p): `endLine > startLine + 1`, value `one␣␣two`. Fails today (whole line is one entry token, no continuation).
  3. Key grammar refusals — each refused form (B1h/B1r/B1s, B3a/B3c/B3d/B3e/B3f/B3g/B3j) its own `it` with try/catch asserting `.data.code === 'CONFIG_PARSE_ERROR'`, `.data.line`, `.data.source`. Today the `=`-path **accepts** these (returns a garbage-key entry) — RED.
  4. Key grammar accepted — B3-ok1/2/3, `[a]key=v`, valueless `key`, trailing-space `key   `, CRLF `key\r` each assert the recorded `{key, value}`.
  5. Orphan: B2a/B2b record under `('', undefined)`; B2c orphan + section; rewrite the two old-behavior tests (lines ~3011, ~3442); `qualifyKey` orphan→bare vs `[ ""]`→`.key` vs `[ "x"]`→`.x.key` (regression guard, three `it`s under one Given). B2d/B2e malformed orphan refuse (try/catch, `.data.line === 1`).
  6. D3 forms — six `it`s: `ab#cd = x`, `ab;cd = x`, `ab # cd = x`, `key#=v` refuse (try/catch `.data.code`); `#whole = line` is a comment token; `k = v # trailing` records `a.k = v`.
  7. Guard isolation (mutation hotspots): first-char-not-alpha refusal; post-key space-skip accepts `k   =` and `k\t=`; `=`-vs-EOL-vs-other branch each triggered alone; `scanHeaderPrefix` `endOffset` arithmetic — assert the same-line entry's `startCol` lands past `]` for `[a]key` (offset 3) and `[a "s"]key` (offset past the closing quote+`]`).
  - properties.test.ts: the Lens-1/3/4 props above — fail until the scanner/tokenizer land.
  - config-interop.test.ts: the read/refusal/orphan twins — fail until the read path lands.
- **GREEN** (config-read.ts, config-key.ts):
  1. Write `scanKey` (returns `{ key, value: string|null, nextLineIdx }`), then `scanHeaderPrefix` (reuse `scanQuotedSpan`, return `{ parse, endOffset }`).
  2. Rework `tokenizeConfigLines`: replace the `effectiveEqualsIndex`/`classifyValuelessLine`/`line.slice` block with `scanKey` over the raw line; after a `header` from `scanHeaderPrefix`, skip GIT_SPACE from `endOffset`, peek for `#`/`;` (emit nothing), else `scanKey` the remainder and push a `sharesHeaderLine: true` entry (with `startCol`). Advance `lineIdx` by the scanner's `nextLineIdx`.
  3. Add the optional `sharesHeaderLine`/`startCol` fields to `ConfigToken.entry`.
  4. `parseIniSections`: open the orphan builder; push it only if non-empty.
  5. `qualifyKey` orphan branch.
  6. Delete `VALUELESS_KEY_RE`, `classifyValuelessLine`, `effectiveEqualsIndex` once nothing references them (check `find_referencing_symbols`; `findFirstValuelessEntry` reads `token.value`/`token.key` only — unaffected). `indexOfUnquoted`/`stripInlineComment` stay (value-side + header trimming).
  7. Update the doc comments on `tokenizeConfigLines`, `parseIniSections`, `ConfigToken`, `qualifyKey` (why: same-line scan, orphan recording, the marker) — no provenance refs.
- **REFACTOR:** extract the post-`]` skip + same-line-entry emit into a small named helper if `tokenizeConfigLines` exceeds ~20 lines or nests >2; keep `scanKey` and `scanHeaderPrefix` each a single-purpose function with early returns; name the offset/column constants. Re-run guard-isolation tests.

### Gate
`npx vitest run test/unit/application/primitives/config-read.test.ts test/unit/application/primitives/config-read.properties.test.ts test/integration/config-interop.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/primitives/config-read.ts src/application/primitives/internal/config-key.ts test/unit/application/primitives/config-read.test.ts test/unit/application/primitives/config-read.properties.test.ts test/integration/config-interop.test.ts`

### Commit
`feat(config): parse same-line header entries, orphan keys, and one key scanner`

---

## Slice 2 — writer: entry-surgery split on the shared header line

### Context

**Goal bytes (design Bucket 4 entry rows).** `setConfigEntryInText` / `removeConfigEntry` now reproduce:
- W1 `[a] key = v⏎` + `a.key x2` → `[a]⏎⇥key = x2⏎` (replace splits the header).
- W3 `[a] key⏎` (valueless) + `a.key x2` → `[a]⏎⇥key = x2⏎`.
- W5 `[a] key = v⏎` + `a.other y` (NEW key) → `[a] key = v⏎⇥other = y⏎` (no split; appends at section end, header line verbatim).
- W6 `[a] key = v⏎⇥k2 = w⏎` + `a.key x2` → `[a]⏎⇥key = x2⏎⇥k2 = w⏎`.
- W2 `[a] key = v⏎` + `--unset a.key` → empty file (prune).
- W4 `[a] key⏎` + `--unset a.key` → empty.
- W7 `[a] key = v⏎⇥k2 = w⏎` + `--unset a.k2` → `[a] key = v⏎` (other key unset, same-line head verbatim).
- W7c `[a] key = v⏎⇥# keep⏎` + `--unset a.key` → `[a]⏎⇥# keep⏎` (same-line entry removed, comment survives → split header onto its own line, keep the comment).
- W7d `[a] key = v⏎⇥k2 = w⏎` + `--unset a.key` → `[a]⏎⇥k2 = w⏎` (same-line entry removed, surviving entry → split header).
- R6 `[a] key = 1⏎[a] key = 2⏎` + `--unset-all a.key` → empty.

**Files / symbols to touch:**
- `src/application/primitives/update-config.ts`:
  - `setConfigEntryInText` (169–204) — the replace branch (185–197) splices `[existing.startLine, existing.endLine)` with `renderEntry(key, value)`. **Add the shared-line branch:** when the matched `existing` entry token carries `sharesHeaderLine` (the new field from slice 1), the spliced replacement must re-emit the header first: replace `[startLine, endLine)` with `renderSectionHeader(headerSection, headerSubsection)` + LF + `renderEntry(key, value)` (producing W1's `[a]⏎⇥key = x2`). The header identity comes from the header token immediately preceding the entry — find it in the token stream (the entry's `startLine === header.line`). The new-key path (198–203, `insertionLine` + `spliceEntryAt`) needs **no change**: `insertionLine` already returns `headerLine + 1` for a same-line-only block, so W5 appends after the header line, header verbatim (verify with a test, do not edit).
  - `removeConfigEntry` (284–316) + helpers `buildTokenBlocks` (216–231), `matchingEntrySpans` (234–239), `blockHasProtectingContent` (245–249), `blockExclusions` (256–261), `spanExclusions` (267–270). Today: a block whose matched spans are removed is either pruned whole (`blockExclusions`, when `!blockHasProtectingContent`) or has just its matched spans excluded (`spanExclusions`). **Add the shared-line keep branch:** when the **removed** entry shares the header's physical line AND the block survives (has protecting content — comment or other entry), excluding the entry's line would also delete the header. Instead, the kept output must re-emit `renderSectionHeader(...)` alone on the header line, then the surviving body verbatim (W7c/W7d). When the same-line entry is the only content and nothing protects the block, the whole physical line (header + entry) is excluded → prune (W2/W4). When a *non-same-line* key is unset and the same-line head is not the removed entry, the head line is untouched (W7). Implementation sketch: in the per-block reduce, detect "the matched span starts on the header line" via `sharesHeaderLine`; if the block survives, emit a header-replacement edit (rewrite the header line to `renderSectionHeader(...)`) instead of a plain line-exclusion, and exclude only the trailing portion / following body the entry occupied. Keep `excluded` semantics for non-shared removals.

**Reuse (no change):** `renderEntry` / `renderSectionHeader` (`internal/config-write-shared.ts:38,50`). `makeTarget` / `matchesTarget` / `findEntry` / `insertionLine` / `spliceEntryAt`. The token stream now carries same-line entries from slice 1 — `findEntry` already matches them (it matches on `token.key`), and `existing.startLine`/`endLine`/`sharesHeaderLine` drive the split. `parseIniSectionsForWrite` parse-first refusal is unchanged (set/unset still refuse a file with a bad `=`-key, faithful — git's set/unset parse first).

**Tests to extend:**
- Unit `test/unit/application/primitives/update-config.test.ts` (GWT split; existing blocks like `'Given a [core] section with the key present'` ~line 37). Add a `describe('Given a same-line header+entry block')` family: each of W1/W3/W5/W6/W7/W7c/W7d/W2/W4/R6 a byte-exact full-string `toBe` on `setConfigEntryInText` / `removeConfigEntry` output. Guard isolation: a same-line block where a non-matching key is unset (head verbatim, W7) vs the matching same-line key unset with a surviving comment (split, W7c) — two separate tests so each branch is proven alone.
- Property `test/unit/application/primitives/update-config.properties.test.ts` (existing surgery-preservation props; `configFileWithTarget` from `arbitraries.ts:205`). Add `configFileWithSameLineBlock` to `arbitraries.ts` (a `[s] key = v` head form alongside the normal block) and extend `configFileWithTarget` to optionally emit a same-line head. Lens-2 (numRuns 100): setting/unsetting a same-line key leaves every **other** entry's parsed value unchanged (oracle = `parseIniSections`, independently tested in slice 1) — the existing `update-config.properties.test.ts:358` "no orphan key in output" invariant extends to same-line inputs.
- Interop `test/integration/config-interop.test.ts` — write-parity twins (model on the existing valueless set/unset twins ~785 and the multi-line surgery twins ~990; use `seedTwinConfigs` + `readTwinConfigs` + an `extractFromA`-style slice). For W1/W3/W5/W6/W7/W7c/W7d/W2/W4/R6: seed identical bytes into both repos, run the matching `git config --file <peer> …` op (`tryRunGit`) and the matching tsgit command (`configSet` / `configUnset` / `configUnsetAll`), assert the `[a]`-onward bytes are identical. **Pitfall:** scrub `GIT_*` (the helpers already do) and pin the peer with `-c merge.conflictStyle=merge` only if comparing conflict markers — N/A here, but keep `tryRunGit`'s isolated env.

### TDD steps

- **RED:** add the W-row unit tests (each a byte-exact `toBe`) and the same-line interop twins. Expected failure: today `setConfigEntryInText('[a] key = v⏎', 'a', undefined, 'key', 'x2')` appends a second `[a]` (`[a] key = v⏎[a]⏎⇥key = x2⏎`) instead of splitting; `removeConfigEntry` on W7c/W7d either no-ops or deletes the header. Property: the same-line surgery-preservation prop fails because the split branch is missing.
- **GREEN:**
  1. `setConfigEntryInText` replace branch: when `existing.sharesHeaderLine`, find the preceding header token, and build the replacement as `renderSectionHeader(...)` + `'\n'` + `renderEntry(...)`; otherwise unchanged. Keep the EOF-LF-termination rule (`end === lines.length` → append `''`).
  2. `removeConfigEntry`: add the shared-line-survives branch (rewrite header line to `renderSectionHeader(...)`, keep surviving body) vs the prune branch (whole line excluded). Thread the header identity through `buildTokenBlocks`'s `TokenBlock.header` (already present).
  3. Update doc comments on the two functions (why the split / re-emit) — no provenance refs.
- **REFACTOR:** extract the "re-emit header + rendered entry" composition into a named helper shared by the replace and the remove-survives branches if both grow past the size budget; early-return the non-shared paths first to keep nesting ≤2.

### Gate
`npx vitest run test/unit/application/primitives/update-config.test.ts test/unit/application/primitives/update-config.properties.test.ts test/integration/config-interop.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/primitives/update-config.ts test/unit/application/primitives/update-config.test.ts test/unit/application/primitives/update-config.properties.test.ts test/unit/application/primitives/arbitraries.ts test/integration/config-interop.test.ts`

### Commit
`feat(config): split the shared header line on same-line entry set and unset`

---

## Slice 3 — section ops: rename/remove on the token stream, same-line aware, lenient

### Context

**Goal bytes (design Bucket 4 section rows + Bucket 5 leniency).** `renameConfigSectionInText` / `removeConfigSectionInText` now reproduce:
- W8 `[a] key = v⏎` + `--rename-section a b` → `[b]⏎⇥key = v⏎` (header split, entry on its own line).
- R1 `[a] key = v⏎⇥k2 = w⏎` + rename → `[b]⏎⇥key = v⏎⇥k2 = w⏎`.
- N3 `[a] key⏎` + rename → `[b]⏎⇥key⏎` (valueless preserved verbatim after split).
- N4 `[a]  ⏎⇥k = v⏎` + rename → `[b]⏎⇥k = v⏎` (trailing spaces after `]` dropped; re-emit from section end).
- C1 `[a]   key=v⏎` + rename → `[b]⏎⇥key=v⏎` (entry tail copied **raw** — `key=v`, not re-rendered; only the `]`→key gap normalises to `⏎⇥`).
- C2 `[a] key = v ; cmt⏎` + rename → `[b]⏎⇥key = v ; cmt⏎` (trailing comment copied raw in the tail).
- C7 `[a] key = one\⏎␣␣two⏎` + rename → `[b]⏎⇥key = one\⏎␣␣two⏎` (continuation tail survives the split).
- W9 `[a] key = v⏎` + `--remove-section a` → empty.
- C3 `[a] key = v⏎⇥k2=w⏎[c]⏎⇥k3=x⏎` + `--remove-section a` → `[c]` block verbatim (compare to git's actual output, which preserves `[c]`'s original bytes).
- C5 `[a] k1 = v1⏎[b] k2 = v2⏎` + `--remove-section a` → `[b] k2 = v2⏎` (only `[a]`'s same-line block removed; `[b]`'s same-line form kept verbatim, **not** rewritten).
- W11 `o = 1⏎[a]⏎⇥k = v⏎` + `a.k x2` → `o = 1⏎[a]⏎⇥k = x2⏎` (orphan line above a section preserved; entry surgery still works — this is a slice-2 regression guard, fold the test here or in slice 2).
- N7 `o = 1⏎[a]⏎⇥k = v⏎` + `--remove-section a` → `o = 1⏎` (orphan preserved, `[a]` removed).
- Bucket 5 leniency (no key/value validation — `copy_or_rename` is event-driven for offsets only): D2a `[a]⏎⇥bad!key = v⏎[b]⏎⇥k = w⏎` + `--rename-section b c` → `[a]⏎⇥bad!key = v⏎[c]⏎⇥k = w⏎` (bad-key block verbatim, succeeds exit 0); D2b same + `--remove-section b` → `[a]⏎⇥bad!key = v⏎`; D2c same + `--rename-section a c` → renames the bad-key block itself, verbatim tail; D2d `[a]⏎⇥k = "unclosed⏎[b]⏎⇥k = w⏎` + `--remove-section b` → `[a]⏎⇥k = "unclosed⏎` (malformed value, verbatim).

**Files / symbols to touch:**
- `src/application/primitives/update-config-sections.ts`:
  - `removeConfigSectionInText` (114–129) — today line-based: walks `text.split('\n')`, uses `isSectionHeader(line)` (54–57, `startsWith('[') && endsWith(']')`) and `matchesRawSectionName(line, oldName)` (47–51, parses `line.trim()` via `parseSectionHeader`). **Move to the token stream:** tokenize via `tokenizeConfigLines(lines, text.endsWith('\n'))` (import from `config-read.js`), group into blocks (reuse `update-config.ts`'s `buildTokenBlocks` shape or inline an equivalent header→body grouping), match a header block by `rawSectionName(header)` vs `oldName` (byte-exact, case-sensitive — `rawSectionName` already imported here), and drop the matched block's full physical-line span (header line through the last body token's `endLine`). A same-line header block's span starts at the header line. Non-matching blocks (incl. same-line `[b] k2 = v2`, C5) are copied byte-for-byte. Orphan lines before the first header (N7's `o = 1`) are outside every block → preserved. **No `scanKey` validation** — the tokenizer throws on a bad `=`-key, so for the leniency rows (D2a–D2d) the section op must **not** route through the throwing tokenizer for the non-matched blocks. Resolution: tokenizing D2a (`bad!key`) would throw. So section ops must find header lines and block spans **without** running the key scanner on bodies — use `scanHeaderPrefix` (slice 1) per physical line to recognise headers + offsets, and treat everything between headers as opaque verbatim bytes (do not tokenize bodies). This keeps leniency (D2a–D2d) and gains same-line header recognition.
  - `renameConfigSectionInText` (141–155) — today `lines.map`: rewrites a matching header line to `renderSectionHeader(to.section, to.subsection)`, body untouched. **Rework on the same header-recognition pass:** for a matching header, if it is a **plain** header line (no same-line content) emit `renderSectionHeader(to)` and copy the body verbatim (today's behavior, preserved). If it is a **same-line** header (`scanHeaderPrefix` reports content after `endOffset`), emit `renderSectionHeader(to)` + `'\n\t'` + the **raw** remaining bytes of the original line from the first non-space char after `endOffset` (C1: `key=v` copied raw; only the `]`→key gap normalises to `⏎⇥`), then the body verbatim. N4's trailing-spaces-only-after-`]` case emits just `renderSectionHeader(to)` (no entry, re-emit from section end). C7's continuation tail and C2's trailing comment are part of the raw tail / following body and survive. Keep `rejectSection`/`rejectEmptyPlainSection`/`rejectSubsection` guards (146–148). Matching stays `rawSectionName` byte-exact.
  - `findSectionHeader` (81–86) / `isSectionHeader` (54–57) / `matchesRawSectionName` (47–51) — `findSectionHeader` is used by the `renameConfigSection`/`removeConfigSection` async wrappers (218–253) for the existence check; it can stay line-based **only if** it recognises same-line headers. Switch its per-line check to `scanHeaderPrefix(line).parse` (recognises `[a] key = v` as a header) so the existence check no longer no-ops on same-line headers; keep `rawSectionName` matching. `isSectionHeader` (the `endsWith(']')` test) is superseded by header recognition via `scanHeaderPrefix` — replace its use in `removeConfigSectionInText` with the header-recognition pass; remove `isSectionHeader` if nothing else references it (check `find_referencing_symbols`).
- `src/application/primitives/update-config.ts` `applyConfigOpInText` (402–426) — `removeSection`/`renameSection` ops delegate to the section functions via `rawSectionName`; no change beyond the section functions themselves. Verify the W11 entry-surgery-over-orphan case routes through slice 2's `setConfigEntryInText` correctly (orphan line preserved).

**Reuse (no change):** `rawSectionName` (36–40), `parseSectionHeader` (matchers), `renderSectionHeader`, `withTrailingNewlineRestored` (63–75, trailing-LF cleanup on remove), `parseNewSectionName` (166–179), the async wrappers `renameConfigSection`/`removeConfigSection` (202–258) and their `configSectionNotFound` miss path. The slice-2 `setConfigEntryInText` split is unchanged.

**Tests to extend:**
- Unit `test/unit/application/primitives/update-config.test.ts` — the section-op functions `renameConfigSectionInText` / `removeConfigSectionInText` are imported and tested here (no dedicated `update-config-sections.test.ts` file exists; existing section-op blocks include `'Given an empty section name with no subsection'` ~line 577, `'Given no matching section'` ~600, `'Given a subsection'` ~613). Add byte-exact `toBe` tests for W8/R1/N3/N4/C1/C2/C7/W9/C3/C5/N7/W11 and the D2a–D2d leniency rows (rename/remove succeed unchanged on bad-key/bad-value files — assert the output bytes and that **no** throw occurs). Guard isolation: a matching same-line header splits (W8) vs a non-matching same-line header copied verbatim (C5) — two tests. A bad-`=`-key block left untouched by a rename of a **different** block (D2a) proves leniency independently of the split.
- Interop `test/integration/config-interop.test.ts` — section-op twins (model on the existing rename twin ~832). For W8/R1/N3/N4/C1/C2/C7/W9/C3/C5/N7 and D2a–D2d: seed identical bytes into both repos, run `git config --file <peer> --rename-section …` / `--remove-section …` (`tryRunGit`) and the matching tsgit `configRenameSection` / `configRemoveSection` (or the primitive `renameConfigSection`/`removeConfigSection`), assert the relevant section bytes are identical. For D2a–D2d assert both succeed (git exit 0, tsgit no throw) and bytes match.

### TDD steps

- **RED:** add the W8/R1/N3/N4/C1/C2/C7/W9/C3/C5/N7/W11 and D2a–D2d unit tests (byte-exact `toBe` / no-throw) and the section-op interop twins. Expected failure: today `renameConfigSectionInText('[a] key = v⏎', 'a', {section:'b'})` and `removeConfigSectionInText('[a] key = v⏎', 'a')` **no-op** (the line is recognised by `isSectionHeader` as a header but the same-line entry is not split, and on rename only the header text up to the line is replaced while `[a] key = v` does not satisfy `endsWith(']')` so it is not even recognised). The leniency rows pass today (line-based, never tokenizes) — keep them green after the move.
- **GREEN:**
  1. Implement the header-recognition pass over physical lines using `scanHeaderPrefix` (no body tokenization → leniency preserved). Group blocks as header line + verbatim body lines until the next recognised header.
  2. `removeConfigSectionInText`: drop matched blocks (header line + verbatim body), copy the rest byte-for-byte, preserve pre-header orphan lines, apply `withTrailingNewlineRestored`.
  3. `renameConfigSectionInText`: for a matched header, split same-line content (`renderSectionHeader(to)` + `\n\t` + raw tail) or emit the plain header; copy body verbatim; non-matched headers untouched.
  4. `findSectionHeader`: recognise same-line headers via `scanHeaderPrefix`. Remove `isSectionHeader` if unreferenced.
  5. Update doc comments (why: token-stream / header-recognition move, raw-tail copy, leniency) — no provenance refs.
- **REFACTOR:** factor the shared header-recognition + block-grouping pass into one named helper used by both rename and remove; early-return non-matching headers; keep each function within the size budget. Re-run the leniency and split guard-isolation tests.

### Gate
`npx vitest run test/unit/application/primitives/update-config.test.ts test/integration/config-interop.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/primitives/update-config-sections.ts src/application/primitives/update-config.ts test/unit/application/primitives/update-config.test.ts test/integration/config-interop.test.ts`

### Commit
`feat(config): move section rename and remove onto the token stream`

---

## Phase-boundary gate

Before push: `npm run validate` green (full unit + property + interop + types + biome + 100% coverage on touched files + mutation budget on the config buckets). **No `reports/api.json` regen is owed** — `ConfigToken` / `SectionHeaderParse` / `scanKey` / `scanHeaderPrefix` are all internal (not in the primitives barrel, absent from `reports/api.json`, typedoc resolves only barrel entry points), so the `check:doc-typedoc` prepush gate does not change. Confirm with `git status` that `reports/api.json` is unmodified; if a stray regen appears, it signals an accidental public export — investigate before committing.
