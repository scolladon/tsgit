# Plan — Valueless config keys

Implements `docs/design/config-valueless-keys.md` (ADR-314, ADR-315). Slices are sequential — each is one atomic commit, `npm run validate` green before every commit. Test conventions: GWT describe/it split, AAA with section comments, `sut` = unit under test, error assertions via try/catch on `.data` fields (never bare `toThrow(Class)`).

Reference pins (git 2.54, already verified — reproduce inside interop tests, never trust memory): see the design doc's tables.

## Slice 1 — `feat(config): tokenize valueless keys as null entries`

**Files:** `src/application/primitives/config-read.ts`, type-ripple consumers (`internal/config-key.ts`, `config-scoped-read.ts`, `../commands/config.ts`, `parse-gitmodules.ts`, `../commands/internal/sequencer-state.ts`), tests in `test/unit/application/primitives/config-read.test.ts`.

**RED** — add to `config-read.test.ts` (new `describe` blocks, follow the file's existing GWT style):

1. Given `[a]\n\tkey\n`, When `parseIniSections`, Then one entry `{ key: 'key', value: null }`.
2. Accepted variants, each its own test: `key   ` (trailing spaces), `key\t`, `key\r` as final char (CRLF file), `   key` (leading ws), `With-CAPS` (key case preserved, value null), EOF-terminated `[a]\nkey` (no trailing newline).
3. Refusal matrix — separate test per line, asserting `CONFIG_PARSE_ERROR` with exact `.data.line` (1-based physical line) AND `.data.source` via try/catch: `key ; c`, `key # c`, `bad!key`, `9key`, `-key`, `under_score`, `key\r ` (CR not at EOL), `ab#cd = x` (comment swallows the `=` → line lands on the no-`=` path → refused like git).
4. Leniency preserved — separate tests: orphan valid key before any section → no entry, no throw; `[a] key` (header + same-line key, line-wise unparseable) → skipped, no throw; full-line comments / blank lines unchanged.
5. Bool semantics through `readConfig` (memory adapter): `[core]\nbare` → `core.bare === true`; `[core]\nsparsecheckout` → `true`; `[core]\nlogallrefupdates` → `true`; contrast `bare =` (empty value) → `false`.
6. ADR-315 absent semantics: `[user]\nname\nemail = e` → `user` undefined (name skipped, pair incomplete); `[remote "o"]\nurl\nfetch` → remote `o` has no `url`, no `fetch` entries; `[merge "d"]\ndriver` → driver undefined; `[submodule "s"]\nactive` → `active === true` (bool field, faithful).

Run `npx vitest run test/unit/application/primitives/config-read.test.ts` — new tests fail (entries skipped today / no throw).

**GREEN** — minimal implementation:

- Widen `IniSection.entries[].value` and `SectionBuilder` to `string | null`.
- In `parseIniSections`, replace the `eqAt === -1 → skip` branch: if the line's first non-space char is `[` (i.e. `parseSectionHeader` already returned `not-header`), keep the lenient skip; otherwise match the valueless grammar — named constant, `^[ \t\r]*([a-zA-Z][a-zA-Z0-9-]*)[ \t]*\r?$` — on the **raw** line. Match + open section → push `{ key, value: null }` (key from the capture, case preserved); match + no section → skip; no match → `throw configParseError(lineIdx + 1, source)`.
- `parseGitBoolean(value: string | null)` → `value === null ? true : TRUE_VALUES.has(...)`; `parseLogAllRefUpdates` guards `null` before `.toLowerCase()` (null → `parseGitBoolean`).
- Merge functions: string-typed assignments skip `null` (`if (value === null) continue` or per-key guard); bool fields flow through `parseGitBoolean`; `fetch` skips `null`.
- Type ripple (mechanical, behavior pinned in later slices): `collectValues`/`collectScopedValues` value type; `getConfigValue`/`getAllConfigValues` present-arm `value: string | null`; `commands/config.ts` `ConfigEntryView.value`, `ConfigGetResult`, `ConfigGetAllResult`, `ConfigUnsetResult.previousValue` widen; `configGetRegexp` value pattern tests `entry.value ?? ''`; `parse-gitmodules` `mergeKey` skips `null`; `sequencer-state` `hasTrueKey` → `e.value !== null && e.value.toLowerCase() === 'true'` (state files are tsgit-written; never valueless).
- Update doc comments: `parseIniSections` (valueless grammar + refusal), `IniSection` (null meaning), the widened public surfaces (`null` = present-valueless vs `undefined` = absent).

**Gate:** `npm run validate`. If `check:doc-typedoc` requires it, regenerate `reports/api.json` and include it in the commit. Existing tests that assumed silent skip of no-`=` lines: fix the *tests* only if they pinned the divergence itself; any other failure is a bug in the slice.

## Slice 2 — `test(config): valueless porcelain read coverage`

**Files:** `test/unit/application/primitives/config-scoped-read.test.ts` (or wherever `getConfigValue` tests live — discover first), `test/unit/application/commands/config.test.ts` equivalent.

Test-first additions (they should pass against slice 1 — they pin behavior and kill mutants; if any fails, slice 1 has a bug to fix here):

1. `getConfigValue` on a valueless key → `{ value: null, scope }` (distinct from absent → `{ value: undefined }` — assert both cases side by side).
2. `getAllConfigValues` mixing valued + valueless occurrences → values array carries `null` in file order.
3. `configList` / `configGetRegexp` surface `value: null`.
4. `configGetRegexp` value-pattern: `/^$/` matches a valueless entry; `/val/` does not (pinned: NULL matches as `''`).
5. Multiplicity: `configGet` on a key with one valued + one valueless occurrence throws `CONFIG_MULTIPLE_VALUES` (count includes valueless).

Commit. (`npm run validate` first, as always.)

## Slice 3 — `feat(config): write surgery over valueless entries`

**Files:** `src/application/primitives/update-config.ts`, `test/unit/application/primitives/update-config.test.ts`.

**RED:**

1. `setConfigEntryInText('[a]\n\tkey\n', 'a', undefined, 'key', 'replaced')` → `[a]\n\tkey = replaced\n` (byte-exact, pinned).
2. Case-insensitive: set of `KEY` replaces valueless `key` line.
3. `removeConfigEntry` removes the valueless line, preserves neighbours byte-for-byte.
4. `appendConfigEntry` inserts after the LAST matching line when that line is valueless.
5. `configUnset` (command) on a valueless entry → `{ removed: true, previousValue: null }`.
6. `configSet` multiplicity guard counts valueless occurrences (`CONFIG_MULTIPLE_VALUES`).
7. Guard test: a valueless line for a *different* key is not matched (`isKeyLine` precision); a line inside a later section is not matched (existing section-stop behavior still holds with valueless lines present).

**GREEN:** `isKeyLine` gains the valueless arm — when the line has no `=`: `line.trim().toLowerCase() === key.toLowerCase()`. (Files reaching set/unset surgery already passed `parseIniSectionsForWrite`, so a `key ; c` junk line can't reach the matcher on those paths; rename/remove-section don't use `isKeyLine`.) Update the `isKeyLine` doc comment.

Gate + commit.

## Slice 4 — `test(interop): valueless config keys vs git`

**Files:** `test/integration/config-interop.test.ts` (follow its existing helper/beforeAll patterns; scrubbed `GIT_*` env per repo convention; 60s timeouts where the file does).

Twin git/tsgit scenarios:

1. **Read parity:** file with `[a]\n\tkey\n\tempty =\n\tother = v\n` — reconstruct `git config --list --local` output from tsgit's `configList` structured entries (`null` → bare `key` line, `''` → `key=`) and compare byte-for-byte with real git's stdout.
2. **Bool semantics:** repo with `[core]\nbare` appended — `git rev-parse --is-bare-repository` → `true`; tsgit `configGet('core.bare')` → `value: null`; tsgit's `readConfig`-driven bare detection agrees (use whatever tsgit surface the file already uses for repo-state parity, or assert via `parseGitBoolean` reconstruction `null → true`).
3. **Refusal parity:** for each bad-line fixture (`key ; c`, `key # c`, `bad!key`, `9key`, `under_score`), real git exits 128 with `bad config line N in file F` — extract `N` from stderr; tsgit read throws `CONFIG_PARSE_ERROR` with `.data.line === N` and matching source.
4. **Write parity:** three twin files — git runs `git config --file f a.key replaced` / `--unset a.key` / `--rename-section a b`; tsgit runs the equivalent (`configSet`/`configUnset`/`configRenameSection` against a repo whose local config holds the same bytes, or the `*InText` primitives against the same input where the file's existing patterns do so); resulting bytes identical.
5. **get-regexp parity:** valueless + valued entries; compare tsgit `configGetRegexp` reconstruction against `git config --get-regexp` stdout, including a value-pattern variant (`'^$'`).

Gate + commit.

## Slice 5 — `test(properties): valueless key grammar`

**Files:** `test/unit/application/primitives/config-read.properties.test.ts` (create as sibling if absent — check first; shared generators go in the directory's `arbitraries.ts` if one exists, else a local arbitrary), and/or extend `update-config.properties.test.ts` for the writer property.

1. **Round-trip/grammar totality (numRuns 200):** for an arbitrary valid key (`[a-zA-Z][a-zA-Z0-9-]{0,30}`), `parseIniSections('[s]\n\t' + key + '\n')` yields exactly one entry `{ key, value: null }`.
2. **Negative grammar (numRuns 50):** arbitrary valid key + one char drawn from the refused class (`!`, `_`, `.`, `;` `#` after a space, etc.) appended inside the line → throws `CONFIG_PARSE_ERROR` with line 2.
3. **Writer preservation (numRuns 100):** a config text containing an arbitrary valueless entry + a `set` on an *unrelated* key → the valueless line survives byte-for-byte.

Gate + commit. Never commit a seed.

## Slice 6 — handled in the workflow's docs phase (not a subagent slice)

Backlog flip `[ ] 24.9h` → `[x]` with the summary line + follow-up entries (same-line header/`=`-path key grammar; orphan sectionless keys; per-use-site `missing value` parity — added in dependency order after 24.9k); README/docs touch; PR.

## Risk notes for implementers

- **Stryker regex mutants:** the valueless grammar regex will be mutated. The accepted-variants tests (leading/trailing ws, CRLF, single-char key `a`, key with digits/dashes `k9-x`) plus the per-char refusal matrix are what kills them — keep each in its own `it`.
- **Do not** touch `effectiveEqualsIndex`, `stripInlineComment`, `parseSectionHeader` — the new branch composes after them.
- **No ignore directives**, no phase/ADR/backlog references in source or tests.
- The repo signs commits but this session commits with `--no-gpg-sign`; agents should do the same.
