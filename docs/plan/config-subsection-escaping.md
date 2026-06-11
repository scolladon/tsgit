# Plan — Subsection-name (un)escaping in section headers

Implements `docs/design/config-subsection-escaping.md` (ADRs 312–313). Five sequential slices, one commit each, TDD per slice (Red → Green → Refactor), `npm run validate` green before every commit. No phase/ADR/backlog references in source or tests. All git behaviours referenced below are pinned in the design doc's tables — copy expectations from there, never guess.

Slices share one worktree and build on each other — execute strictly in order. Slice 1 changes a shape consumed by `update-config.ts`; its compile fix is part of slice 1.

---

## Slice 1 — Reader: strict quoted-subsection grammar + escape decoding

**Files:** `src/application/primitives/config-read.ts`, `src/domain/commands/error.ts`, `src/application/primitives/update-config.ts` (compile-only), `test/unit/application/primitives/config-read.test.ts`.

**Red** — add to `config-read.test.ts` (drive through the exported `parseIniSections`, as the existing header tests do). New describe blocks (GWT split, AAA, `sut`):

1. Decoding (each its own Given/When/Then):
   - `[s "a\"b"]` → subsection `a"b`
   - `[s "a\\b"]` → subsection `a\b`
   - `[s "a\tb"]` (backslash + letter t) → subsection `atb` (no named escapes — `\c` → `c`)
   - `[s "a]b"]` → subsection `a]b` (literal `]` inside quotes)
   - `[s "a#b"]` → subsection `a#b`; `[s "a;b"]` → `a;b`
   - `[s "a\rb"]` (raw CR) → subsection `a\rb`
   - `[s\t"a"]` (TAB before quote) → subsection `a`
   - `[s "a"] # trailing comment` → subsection `a`
   - `[s ""]` → subsection `''` (empty string, not undefined)
2. Refusals — each form throws `CONFIG_PARSE_ERROR`; assert via try/catch on `err.data`: `code`, `line` (1-based physical), `source` (pass a source label), and `partialSectionName` (separate isolated tests per guard, mutation-resistant):
   - `[s "a" x]` → partial `s.a`
   - `[s "a" ]` → partial `s.a`
   - `[s"a"]` (no space before quote) → partial `s`
   - `["a"]` → partial `''`
   - `[s "a]` (unclosed) → partial `s.a]`
   - `[s "a\"b]` (escaped quote then unclosed) → partial `s.a"b]`
   - `[s "ab\` at end of line → partial `s.ab`
   - `[S "a" x]` (uppercase section) → partial `s.a` (section lowercased)
   - a malformed header on line 3 of a multi-line file → `line: 3`
3. Flip the existing expectations that pin the old verbatim/lenient behaviour — at minimum: the `[remote "..."] header with an unterminated subsection quote` test (~line 943, skip → throws) and the `backslash-escaped quote inside a quoted subsection` test (~line 2059, verbatim `a\"#b` → decoded `a"#b`). Sweep the whole file for any other conflicting expectation and flip it to the design table's pinned value — never invent an expectation not in the table.

Run `npx vitest run test/unit/application/primitives/config-read.test.ts` — new tests must fail because subsections come back verbatim/skipped (state the observed failure before going green).

**Green:**

- `src/domain/commands/error.ts`: extend the `CONFIG_PARSE_ERROR` variant with `readonly partialSectionName?: string`; `configParseError(line, source?, partialSectionName?)` includes it only when defined (match the existing conditional-spread style).
- `config-read.ts`: replace `parseSectionHeader`'s body with the three-state union from the design:
  ```ts
  export type SectionHeaderParse =
    | { readonly kind: 'header'; readonly section: string; readonly subsection: string | undefined }
    | { readonly kind: 'malformed'; readonly partialName: string }
    | { readonly kind: 'not-header' };
  ```
  Rules (design §Reader): not `[…]`-shaped → `not-header`; no `"` in inner → today's subsectionless path (`not-header` when inner empty); quote present → strict scan over the **untrimmed** inner: GIT_SPACE (space/TAB/CR) required immediately before the opening quote, `\` + char → char appended (dangling `\` → malformed), unescaped `"` closes, the close must be inner's last char. `partialName` = lowercased trimmed section part, plus `.` + decoded-subsection-so-far once the quote was entered (unclosed spans accumulate to end of inner; the dangling backslash is dropped).
- `parseIniSections`: `header` → open section; `malformed` → `throw configParseError(lineIdx + 1, source, partialName)`; `not-header` → existing fall-through.
- `update-config.ts` `matchesSection`: adapt to the union — only `kind: 'header'` matches (behaviour change for malformed headers arrives in slice 3; here it's compile-correctness).
- Keep functions <20 lines — extract the quoted-scan helper(s); immutable accumulation where natural.

**Refactor + gate:** `npm run validate` (the error-union change regenerates `reports/api.json` — commit it if the gate rewrites it).

**Commit:** `feat(config): git-faithful subsection-name decoding with strict quoted-header grammar`

---

## Slice 2 — Writer: escape subsections on render, accept git's charset

**Files:** `src/application/primitives/update-config.ts`, `src/domain/commands/config-key.ts`, `test/unit/application/primitives/update-config.test.ts`, `test/unit/domain/commands/config-key.test.ts`.

**Red:**

1. `update-config.test.ts` — via `setConfigEntryInText('', 's', <sub>, 'k', 'v')`:
   - subsection `a"b` → text contains `[s "a\"b"]`
   - subsection `a\b` → `[s "a\\b"]`
   - subsection `a\"b` (backslash then quote) → `[s "a\\\"b"]` (escape order: `\` first)
   - subsection `a]b` → `[s "a]b"]` (raw)
   - subsection `a\rb` → raw CR inside quotes
   - round-trip: render then `parseIniSections` → same subsection (example-level; the property comes in slice 4)
   - matching: text already holding `[s "a\"b"]\n\tk = v\n`, set `k2` under subsection `a"b` → lands in that section, no duplicate header (same for `renameConfigSectionInText` to an escaped target)
   - LF and NUL subsections still throw — assert `err.data` code + the reason text (isolated tests per char)
   - flip the existing `subsection containing a quote` rejection test (~line 654) to the accepted/escaped expectation; same for backslash/bracket rejections.
2. `config-key.test.ts` — `parseConfigKey('remote.a"b.url')` → subsection `a"b`; backslash and `]` variants; LF (`'remote.a\nb.url'`) and NUL still `bad-character` with the correct `position`; CR now accepted.

**Green:** `renderSectionHeader` escapes the subsection (`\` → `\\` then `"` → `\"`); `rejectSubsection` rejects only LF and NUL (update its message; keep `rejectControlChars` for keys untouched); `SUBSECTION_FORBIDDEN` → `/[\n\0]/`.

**Gate + commit:** `feat(config): escape subsection names on write and accept git's subsection charset`

---

## Slice 3 — Write-path refusal map (per-operation, mirroring git)

**Files:** `src/domain/commands/error.ts`, `src/application/primitives/update-config.ts`, `test/unit/application/primitives/update-config.test.ts`.

**Red** (memory adapter contexts, as existing `setConfigEntry` tests do):

1. `setConfigEntry` onto a config whose text holds `[s "a" x]` → throws `CONFIG_INVALID_FILE` with `data.sectionName === 's.a'` and `data.source` = the config path (try/catch, assert both fields).
2. Same file via `unsetConfigEntry` / `unsetAllConfigEntries` → same refusal (these currently throw `CONFIG_PARSE_ERROR` through their existing parse — the shape must change).
3. `setConfigEntry` onto a config with a malformed **value** (`k = "x` unclosed) → still `CONFIG_PARSE_ERROR { line }` (read shape; isolated from case 1).
4. `updateConfigEntries` / `updateConfigOperations` onto the bad-header file → `CONFIG_INVALID_FILE`.
5. `renameConfigSection` on a file containing a malformed header **plus** a well-formed `[t]` section, renaming `t.q`-style source `t` → **succeeds**, malformed line preserved byte-for-byte, `[t]` renamed.
6. `removeConfigSection` equally lenient; also lenient on a bad-**value** file (this flips today's behaviour — the existing parse-first tests for rename/remove, if any assert throwing, get rewritten).
7. Rename whose source is the malformed header itself (`s.a`) → `CONFIG_SECTION_NOT_FOUND`.

**Green:**

- `error.ts`: new variant `{ readonly code: 'CONFIG_INVALID_FILE'; readonly sectionName: string; readonly source: string }` + `configInvalidFile(sectionName, source)` factory.
- `update-config.ts`: a small `assertWritableConfigText(text, path)` helper — runs `parseIniSections(text, path)`; catches `CONFIG_PARSE_ERROR` carrying `partialSectionName` and rethrows `configInvalidFile(partialSectionName, path)`; everything else propagates. Call it from `readModifyWriteScopedConfig`, `updateConfigEntries`, `updateConfigOperations`, and the unset paths (their existing `parseIniSections` call sites adopt the same translation — avoid double-parsing where the sections are already needed: wrap that one call).
- `renameConfigSection` / `removeConfigSection`: drop `parseIniSections` + `sectionExists`; existence = `findSectionHeader(text.split('\n'), section, subsection) !== -1`. `CONFIG_SECTION_NOT_FOUND` unchanged when absent.

**Gate + commit:** `feat(config): mirror git's per-operation write refusals on malformed config files`

---

## Slice 4 — Property tests (round-trip pair lens)

**Files:** `test/unit/application/primitives/update-config.properties.test.ts`, `test/unit/application/primitives/arbitraries.ts`.

- Arbitrary in `arbitraries.ts`: `subsectionName` — full-unicode strings excluding `\n` and `\0` (mirror the existing value-arbitrary construction; include `"`/`\`/`]`/CR-heavy weighting if the existing pattern does so for values).
- Property 1 (numRuns 200): for arbitrary subsection `s`, `setConfigEntryInText('', 'test', s, 'k', 'v')` → `parseIniSections` yields exactly one section with `section === 'test'` and `subsection ≡ s` (render/parse round-trip).
- Property 2 (numRuns 200): render output never throws on parse (totality of the strict grammar over the writer's image).
- GWT titles ("Given an arbitrary subsection name…"), AAA, `sut`; no seed committed.

**Gate + commit:** `test(config): subsection name round-trip properties`

---

## Slice 5 — Interop vs canonical git

**File:** `test/integration/config-interop.test.ts` (same harness: `makePeerPair`, `runGit`/`tryRunGit`, `--local` scoping; heavy git-spawning → reuse the file's existing beforeEach repo pair, keep timeouts as configured).

1. **Write parity matrix** — for subsections `a"b`, `a\b`, `a]b`, `a#b`, `a b`, `a\rb`, combo `a"b\c]d`: tsgit `setConfigEntry({ key: 'test.<sub>.v' })` … using `parseConfigKey`-accepted dotted keys is awkward for exotic chars — call the text-level writer through `setConfigEntry` only where the dotted-key grammar allows, otherwise drive `updateConfigEntries` (section/subsection split explicitly); peer side `runGit(['config', '--local', 'test.<sub>.v', 'v'])` (argv passes raw bytes). Byte-compare from the first `[test ` occurrence onward (generalise `extractTestSection` to accept the subsectioned header); then `git config --local --get` reads tsgit's file back.
2. **Read parity** — hand-write `[test "a\tb"]` / `[test "a\"b"]` / `[test "a]b"]` bodies; per key, tsgit `getConfigValue` equals git (`test.atb.k` etc.).
3. **Refusal parity (read)** — each malformed form on a known line → git stderr `bad config line N`, tsgit `CONFIG_PARSE_ERROR` same `N` (follow the existing malformed-value test pattern).
4. **Refusal parity (write)** — bad-header file: `git config --local x.y z` exits non-zero with `invalid section name '<partial>'`; parse the quoted partial from stderr and assert tsgit's `CONFIG_INVALID_FILE.sectionName` equals it. Bad-value file: both report the read shape (`bad config line N` / `CONFIG_PARSE_ERROR`).
5. **Leniency parity** — malformed-header + `[t]` file: `git config --rename-section t u` succeeds; tsgit `renameConfigSection` produces byte-identical output. Malformed source → git `no such section` / tsgit `CONFIG_SECTION_NOT_FOUND`.
6. **Match parity** — repo with `[test "a\"b"]`: both tools set a second key; byte-identical sections, no duplicated header.

**Gate + commit:** `test(interop): subsection header grammar parity vs canonical git`

---

## Post-slice phases (session-run)

- Review ×3 (typescript / security / tests) on `git diff main...HEAD`.
- Architecture refactor pass (seeded by this diff) + scoped re-review.
- Mutation: `./node_modules/.bin/stryker run --mutate src/application/primitives/config-read.ts --mutate src/application/primitives/update-config.ts --mutate src/domain/commands/config-key.ts` (local scoping per repo practice; full tree intractable).
- Docs: `docs/BACKLOG.md` 24.9g → `[x]` with summary line + new follow-up entry for the `[s ""]`-vs-`[s]` matching divergence; doc-coverage page for config if its grammar notes mention subsections; README untouched (no new command).
- PR + CI + admin squash-merge per workflow.
