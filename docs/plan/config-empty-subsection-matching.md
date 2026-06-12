# Implementation plan — config section identity & addressing (`[s]` ≠ `[s ""]`, raw section ops, empty section name)

Implements `docs/design/config-empty-subsection-matching.md` under ADRs 322–326 (all accepted).
Four slices, dependency-ordered, one atomic commit each. Every slice is executed by a
zero-context agent that sees only its slice text — each slice block below is self-contained.

## Ground rules (restate in every slice's head; they bind every slice)

- **TDD**: write the RED test first, watch it fail for the stated reason, then the minimal GREEN change, then refactor.
- **Test conventions**: `describe('Given <context>')` > `describe('When <action>')` > `it('Then <expected>')` (2-level `Given …, When …` shortcut allowed for a single expectation). AAA bodies with `// Arrange` / `// Act` / `// Assert` section comments. `sut` names the unit under test (the function), `result` the output. Byte-exact full-string assertions (`toBe` on the whole file text, never `toContain` for new tests).
- **Mutation-resistant patterns**: error assertions go through try/catch + direct `.data` assertions (code AND payload fields), never bare `toThrow(Class)`. Each guard condition gets its own isolating test. Each direction of an identity comparison gets its own test.
- **Property tests** live in `*.properties.test.ts` siblings; per-family generators in the sibling `arbitraries.ts`. Tiered `numRuns`: 200 round-trip, 100 invariant/totality. Never commit a seed. Properties are additive — never delete an example test when adding a property.
- **Never** use `@ts-ignore`, `v8 ignore`, `stryker-disable`, `biome-ignore`, or any suppression directive. **No phase/ADR/backlog references inside source or test code** (commit is the join point).
- **Interop tests** spawn real git only through `runGit`/`tryRunGit` from `test/integration/interop-helpers.js` (they already scrub `GIT_*` env — never spawn git directly).
- **Environment warning**: `node_modules` holds a temporarily downgraded vitest for an unrelated experiment. Do **NOT** run `npm install` / `npm ci` / `npm update`. Running `npx vitest run …` is fine.
- **Gate before commit** (targeted, per slice): the slice's listed `npx vitest run …` files, `npm run check:types`, `npx biome check <touched files>`. Commit only on green. Never `--no-verify`.

## Slice map

| # | Title | Depends on | Commit message |
| --- | --- | --- | --- |
| 1 | Key grammar — empty section name in `parseConfigKey` | — | `feat(config): parse empty-section keys with a subsection` |
| 2 | Exact subsection identity in entry writes (`matchesTarget`) | 1 | `fix(config): exact empty-subsection identity in entry writes` |
| 3 | Raw old-name matching + section-op `InText` reshape | — (∥ 1) | `feat(config): raw byte-exact old-name matching for section text surgery` |
| 4 | New-name grammar + porcelain section ops + interop matrix | 3 | `feat(config): git name grammar for section ops` |

Slices 1 and 3 are genuinely parallelizable (disjoint files/symbols). Slice 2 requires 1
(empty-name writes flow through the widened key parser). Slice 4 requires 3. Slices 2 and 3
both edit `test/unit/application/primitives/update-config.test.ts` — run them sequentially
(2 before 3) to avoid merge friction.

---

## Slice 1 — Key grammar: empty section name in `parseConfigKey`

### Context (everything you need; verify with the listed paths, do not re-derive)

- **Production file**: `src/domain/commands/config-key.ts`, symbol `parseConfigKey` (lines 57–89). Current head:

  ```ts
  parseConfigKey = (raw: string): ParsedConfigKey => {
    const firstDot = raw.indexOf('.');
    if (firstDot === -1) {
      throw configKeyInvalid(raw, 'missing-name');
    }
    const sectionRaw = raw.slice(0, firstDot);
    if (sectionRaw.length === 0) {
      throw configKeyInvalid(raw, 'empty-section');   // ← refusal fires BEFORE subsection determination
    }
    const lastDot = raw.lastIndexOf('.');
    ...
  ```

  Helper in the same file: `findInvalidIdentifierIndex(text)` — note it indexes `text[0] as string`; calling it with `''` only "passes" by regex-coercion accident. The fix must **skip** identifier validation explicitly when the section part is empty, not rely on that accident.
- **Tests**: `test/unit/domain/commands/config-key.test.ts` — the `'.name'` → `empty-section` pin sits at lines ~123–144 and **must survive unchanged**; the `'user.'` → `missing-name` pin follows it. Property sibling: `test/unit/domain/commands/config-key.properties.test.ts` (has `arbSafeSection`/`arbSafeKey` local generators, totality + idempotence properties, numRuns 100/50).
- **Downstream readiness (no changes needed, pinned by the design)**: `collectValues`/`matchesSectionHeader` (`src/application/primitives/internal/config-key.ts`) compare `''` sections correctly; `qualifyKey` renders `..k`/`.x.k`; `dispatchSection` ignores the `''` family; writers render `[ ""]`/`[ "x"]`.

### Pinned git behaviour this slice encodes (quoted from the design matrix, git 2.54.0)

| Input | Result |
| --- | --- |
| `..k` | parses — git: `git config --file empty ..k v` writes `[ ""]\n\tk = v\n`, exit 0 |
| `.x.k` | parses — git writes `[ "x"]\n\tk = v\n` |
| `.k` | refused — git: `error: key does not contain a section: .k` (GET exit 1, SET exit 2) |
| `..9k` | refused — git: `error: invalid key: ..9k` (variable-name grammar still applies) |
| `[ "X"]k=e` + GET `.X.k` / `.x.k` | `e` / silent — subsection stays case-sensitive |

### TDD steps

1. **RED** `config-key.test.ts` — `describe('Given a double-dot key ..k')` > `When parsed` > `it('Then returns section "", subsection "" and the name')`: `expect(parseConfigKey('..k')).toEqual({ section: '', subsection: '', name: 'k' })`. Fails today with `CONFIG_KEY_INVALID` reason `'empty-section'`.
2. **RED** — `Given a leading-dot key .x.k` > `Then returns section "", subsection "x"`: `toEqual({ section: '', subsection: 'x', name: 'k' })`. Same failure reason.
3. **RED** — `Given a leading-dot key with an upper-case subsection .X.k` > `Then the subsection case is preserved`: `toEqual({ section: '', subsection: 'X', name: 'k' })` (and name lower-cased: add `'..K'` → `name: 'k'` as its own test).
4. **RED** — `Given a double-dot key with an invalid name ..9k` > `Then throws CONFIG_KEY_INVALID with reason "bad-character" at index 2`: try/catch, assert `caught?.data` equals `{ code: 'CONFIG_KEY_INVALID', key: '..9k', reason: 'bad-character', index: 2 }` (verify the exact data shape against the existing `bad-character` tests in the same file and mirror it).
5. **Confirm survivors** (no edits): the `'.name'` → `'empty-section'` and `'user.'` → `'missing-name'` pins still pass after GREEN.
6. **GREEN** — reorder `parseConfigKey`: keep the `firstDot === -1` → `missing-name` check; compute `lastDot`, `nameRaw`, and `subsection` (`firstDot === lastDot ? undefined : raw.slice(firstDot + 1, lastDot)`) **before** any section refusal; then refuse `'empty-section'` only when `sectionRaw === '' && subsection === undefined`; then the `nameRaw === ''` → `'missing-name'` check; then identifier validation, **skipping the section identifier check when `sectionRaw === ''`** (explicit `sectionRaw.length > 0 &&` guard); name and subsection checks unchanged. Keep `section: sectionRaw.toLowerCase()`.
7. **RED (property, lens 3 widening)** `config-key.properties.test.ts` — extend the safe domain: `Given an arbitrary key with an empty section and a subsection` > `Then parseConfigKey never throws (totality)` — generator `` fc.tuple(arbSafeSection(), arbSafeSection()).map(([sub, name]) => `.${sub}.${name}`) `` plus the `..${name}` form; assert the parse returns `section: ''` and parsing twice yields deeply-equal results (idempotence). numRuns 100.
8. **Refactor note**: keep `parseConfigKey` under 20 lines of logic by extracting the refusal guards into tiny local helpers if needed; doc-comment update on the function (two accepted grammars become three — mention the empty-section-with-subsection form; no ADR refs in code).

### Gate & commit

- `npx vitest run test/unit/domain/commands/config-key.test.ts test/unit/domain/commands/config-key.properties.test.ts`
- `npm run check:types` ; `npx biome check src/domain/commands/config-key.ts test/unit/domain/commands/`
- Commit: `feat(config): parse empty-section keys with a subsection`

---

## Slice 2 — Exact subsection identity in entry writes (`matchesTarget`)

Assumes slice 1 landed (`parseConfigKey('..k')` parses).

### Context

- **Production file**: `src/application/primitives/update-config.ts`. The single production change is `matchesTarget` (lines 139–146). Current body (quote — the conflation arm is lines 142–144):

  ```ts
  const matchesTarget = (header: HeaderToken, target: SectionTarget): boolean => {
    if (header.section.toLowerCase() !== target.sectionLc) return false;
    if (target.subsection === undefined) {
      return header.subsection === undefined || header.subsection === '';
    }
    return header.subsection === target.subsection;
  };
  ```

  `SectionTarget` is `{ sectionLc: string; subsection: string | undefined }`, built by `makeTarget(section, subsection)` (lines 120–123). The section check stays **case-insensitive** (pinned correct for entry writes: git rewrites `[S]` in place for `s.k`).
- **Downstream (inherits the fix, zero signature changes)**: `findEntry`, `insertionLine` (new-key placement: end of the **last** matching block), `setConfigEntryInText(text, section, subsection, key, value)` (line 293), `appendConfigEntry(text, section, subsection, key, value)` (line 603), `removeConfigEntry(text, section, subsection, key)` (line 407), `applyConfigOpInText`, `setCoreConfigEntryInText(text, key, value)` (line 329, = `setConfigEntryInText(text, 'core', undefined, key, value)`), and the I/O wrappers `setConfigEntry({ctx, key, value, scope})` / `unsetConfigEntry({ctx, key, scope})` (lines 732/759 — `unsetConfigEntry` counts via the exact `collectValues` then cuts via `removeConfigEntry`; today counter and surgery disagree).
- **Test file**: `test/unit/application/primitives/update-config.test.ts`. The pinned-divergence test to **flip** is at lines 190–205: `describe('Given an explicitly empty `[core ""]` header')` — currently expects `setCoreConfigEntryInText('[core ""]\n\tbare = false\n', 'sparseCheckout', 'true')` to return `'[core ""]\n\tbare = false\n\tsparseCheckout = true\n'`. New expectation (git-pinned): `'[core ""]\n\tbare = false\n[core]\n\tsparseCheckout = true\n'` — rewrite the Given/Then titles and the arrange comment to describe the distinct-section behaviour.
- **Properties**: `test/unit/application/primitives/update-config.properties.test.ts` + shared `test/unit/application/primitives/arbitraries.ts`. In `arbitraries.ts`: `subsectionName()` (line 52, already includes `''`), `arbSubsectionOrNone()` (line 108 — currently `undefined` or 1–4 alnum chars; extend to also emit `''`), `arbHeader()` (line ~168 — renders `[a ""]` automatically once `''` flows through, because it renders `[${section} "${subsection}"]` whenever `subsection !== undefined`), `configFileWithTarget()` (line 205).
- **Interop file**: `test/integration/config-interop.test.ts`. Conventions: top-level `describe.skipIf(!GIT_AVAILABLE)('config interop', …)` with `beforeEach` `makePeerPair('config')` + `initBothRepos(pair.peer, pair.ours)`, `afterEach` `pair.dispose()`. Local helpers **inside** that describe (new tests must sit after them, ~line 983+): `twinConfigPaths(p)` → `{ oursConfigPath, peerConfigPath }` (= `<repo>/.git/config`), `seedTwinConfigs(pair, bytes)` (writes the same bytes to both), `readTwinConfigs(pair)`. git runs via `runGit(args, options?)` / `tryRunGit(args)` from `./interop-helpers.js` (`runGit(['config', '--file', peerConfigPath, …])`; `tryRunGit` returns `{ ok, stdout, stderr }`). tsgit side: `createNodeContext({ workDir: pair.ours })` + primitives (`setConfigEntry`, `unsetConfigEntry`, `updateConfigEntries`) or commands (`configSet`, `configUnset`, `configUnsetAll`, `configList`, `configGetRegexp` — already imported at the top of the file). Heavy git-spawning tests take a `60_000` timeout as the third `it` argument. Assert with byte compares of `readTwinConfigs` outputs (whole-file `toBe` — both sides were seeded identically, so no extract helper needed for these fixtures).

### Pinned bytes this slice must reproduce (quote of the design matrices; fixtures verbatim)

Fixtures: `both.conf` = `[s]\n\tk = a\n[s ""]\n\tk = b\n` ; `rev.conf` = same blocks reversed; `empty-only.conf` = `[s ""]\n\tk = b\n` ; `plain-only.conf` = `[s]\n\tk = a\n` ; `name-mix.conf` = `[ ""]\n\tk = e\n[s]\n\tk = a\n[s ""]\n\tk = b\n`.

| Operation | Resulting bytes / result |
| --- | --- |
| set `s.k v` on `both.conf` | `[s]\n\tk = v\n[s ""]\n\tk = b\n` |
| set `s..k v` on `both.conf` | `[s]\n\tk = a\n[s ""]\n\tk = v\n` |
| set `s.k v` on `rev.conf` | `[s ""]\n\tk = b\n[s]\n\tk = v\n` |
| set `s..k v` on `rev.conf` | `[s ""]\n\tk = v\n[s]\n\tk = a\n` |
| set `s.k v` on `empty-only.conf` | `[s ""]\n\tk = b\n[s]\n\tk = v\n` (NEW `[s]` appended) |
| set `s..k v` on `plain-only.conf` | `[s]\n\tk = a\n[s ""]\n\tk = v\n` (NEW `[s ""]` appended) |
| set `s..k v` on empty file | `[s ""]\n\tk = v\n` |
| add (append) `s..k v2` after that | `[s ""]\n\tk = v\n\tk = v2\n` |
| add `s.k x` on `empty-only.conf` | `[s ""]\n\tk = b\n[s]\n\tk = x\n` |
| set `s.k v` on `[S]\n\tk = a\n` | `[S]\n\tk = v\n` (case-insensitive in-place) |
| unset `s.k` on `both.conf` | `[s ""]\n\tk = b\n` (entry removed, emptied `[s]` pruned) |
| unset `s..k` on `both.conf` | `[s]\n\tk = a\n` |
| unset `s.k` on `empty-only.conf` | file unchanged (git exit 5; tsgit: silent no-op) |
| unset-all `s.k` on `[s]k=a · [s ""]k=b · [s]k=c` | `[s ""]\n\tk = b\n` |
| unset-all `s..k` on `[s ""]k=a · [s ""]k=b · [s]k=c` | `[s]\n\tk = c\n` |
| GET `s.k`/`s..k` on `both.conf` and `rev.conf` | `a` / `b`, order-independent; `s.k` on `empty-only.conf` → silent, exit 1 ↔ tsgit `value: undefined` |
| `--list` on `both.conf` | keys render `s.k=a` and `s..k=b` ; on `name-mix.conf`: `..k=e`, `s.k=a`, `s..k=b` |
| set `..k v` on empty file | `[ ""]\n\tk = v\n` ; `.x.k v` → `[ "x"]\n\tk = v\n` |
| set `..k` on `plain-only.conf` | `[s]…` then NEW `[ ""]` appended at end |
| set `s.k` on `[ ""]`-only file | `[ ""]…` then NEW `[s]` appended |
| unset-all `..k` (sole block) | block cleared and pruned — 0-byte file |
| unset `.x.k` on `[ "x"]k=a · [ ""]k=e` | only `[ "x"]` removed/pruned |

### TDD steps

1. **RED (unit, replace matrix — four direction-isolated tests)** in `update-config.test.ts` under the `setConfigEntryInText` describe: one test per row 1–4 above, `sut = setConfigEntryInText`, args `(text, 's', undefined, 'k', 'v')` vs `(text, 's', '', 'k', 'v')`, full-string `toBe` on the pinned bytes. Expected failures: only the `undefined`-query rows against `[s ""]`-first/`[s ""]`-only text fail today (row 3 — the conflation arm rewrites `[s ""]` on `rev.conf`); the `''`-query rows (2, 4) already hit `matchesTarget`'s exact arm and pass — keep them as direction pins (they kill `===`-operand mutants).
2. **RED (unit, guard isolation)**: `empty-only` text + `undefined` target → row 5 bytes (appends a NEW `[s]`; fails today — the conflation arm edits `[s ""]` in place); `plain-only` text + `''` target → row 6 bytes (passes today, kept as the mirror pin). Each its own test — together with step 1 they isolate both cross-pairs (`undefined`-query-vs-`''`-header and `''`-query-vs-`undefined`-header).
3. **RED (unit, insert + append)**: new key `n` with both forms present lands at end of the `[s]` block (`[s]\n\tk = a\n\tn = v\n[s ""]\n\tk = b\n`); same matrix through `appendConfigEntry` (rows 7–9 shapes, plus the in-`[s ""]` append `(text, 's', '', …)`).
4. **RED (unit, unset)** through `removeConfigEntry`: the two three-block rows (unset-all rows above — `removeConfigEntry` removes every matching span, so the three-block fixtures pin it directly); plus `(both.conf, 's', undefined, 'k')` → `[s ""]\n\tk = b\n`.
5. **Flip** the `[core ""]` test (lines 190–205) to the new pinned bytes (see Context).
6. **RED (unit, consistency — divergence 3)**: memory-context I/O test: seed `.git/config` with `both.conf` bytes, `await unsetConfigEntry({ ctx, key: 's.k' })` → file is exactly `[s ""]\n\tk = b\n` (no over-delete, no `CONFIG_MULTIPLE_VALUES`). Companion guard test: seed `[s]\n\tk = a\n\tk = c\n[s ""]\n\tk = b\n`, expect try/catch `data` `{ code: 'CONFIG_MULTIPLE_VALUES', key: 's.k', count: 2, requested: 'remove', scope: 'local' }`.
7. **RED (unit, empty-name writes)** via the I/O wrappers (memory context): `setConfigEntry({ctx, key: '..k', value: 'v'})` from scratch → file `[ ""]\n\tk = v\n`; `'.x.k'` → `[ "x"]\n\tk = v\n`; set `..k` on `plain-only` seed → appended at end; unset prune-to-empty row.
8. **GREEN**: in `matchesTarget`, delete the `target.subsection === undefined` conflation arm and its doc comment; the function becomes the section check + `return header.subsection === target.subsection;`. Nothing else changes. All RED tests pass; full `update-config.test.ts` run must be green (no other test pins the conflation — verified during planning).
9. **RED (property, lens 2)** in `update-config.properties.test.ts`: `Given an arbitrary identity pair drawn from {undefined, '', sub}` > `When setConfigEntryInText targets identity A` > `Then every byte of the identity-B block is unchanged (and the A block is modified)`. Build a two-block file `[s<A>]\nk = x\n[s<B>]\nk = y\n` from a generator of **distinct** identity pairs (add a small `subsectionIdentity()` arbitrary to `arbitraries.ts`: `fc.constantFrom(undefined, '', …)` ∪ `subsectionName()` non-empty draws, filtered to distinct pairs); assert the B block substring is byte-identical pre/post. numRuns 100. **Caution on widening `arbSubsectionOrNone()` to emit `''`**: the existing surgery-preservation properties use the identity-agnostic `findValue` oracle (matches by section only) — with exact identity, a file holding `[a ""]` plus an `undefined`-targeted write would make that oracle pick the wrong block. Only extend `arbSubsectionOrNone()` if the affected oracles are first made identity-aware; otherwise leave it unchanged and rely on the dedicated identity-pair property (do **not** weaken an oracle to make a generator extension pass).
10. **RED→GREEN (interop)** in `config-interop.test.ts` (new Given blocks after the twin helpers): twin every row of the pinned table above — seed both configs, run `git config --file <peerConfigPath> …` (use `--add` for append rows, `--unset`/`--unset-all` for unset rows; for GET rows compare `tryRunGit` stdout/exit against tsgit's structured `value`), run the tsgit twin on `ours` (`setConfigEntry`/`unsetConfigEntry`/`unsetAllConfigEntries`/`configSet` + `getConfigValue`), and `expect(oursConfig).toBe(peerConfig)`. Group rows per fixture (one `it` per fixture family is acceptable; keep each assertion byte-exact). Include the `--list` key-shape reconstruction on `name-mix.conf` (`configList` structured entries re-rendered as `key=value` lines must byte-equal git's `--local --list` filtered to the seeded keys — follow the existing get-regexp reconstruction test at ~line 863 as a template). `60_000` timeouts.
11. **Refactor note**: if the matrix tests bloat one describe, split per-operation describes (`replace` / `insert` / `append` / `unset`); keep fixtures as shared `const` strings at the top of each describe.

### Gate & commit

- `npx vitest run test/unit/application/primitives/update-config.test.ts test/unit/application/primitives/update-config.properties.test.ts test/integration/config-interop.test.ts`
- `npm run check:types` ; `npx biome check src/application/primitives/update-config.ts test/unit/application/primitives/ test/integration/config-interop.test.ts`
- Commit: `fix(config): exact empty-subsection identity in entry writes`

---

## Slice 3 — Raw old-name matching + section-op `InText` reshape

Independent of slices 1–2 in production code (touches the line-based matcher family only),
but run it after slice 2 (same unit-test file). Porcelain keeps its current name grammar in
this slice (that moves in slice 4); only matching semantics and the `InText` signatures change here.

### Context

- **Production file**: `src/application/primitives/update-config.ts`. Symbols and current bodies:
  - `matchesSection` (lines 40–48) — DELETE. Current body (the conflation arm + lowercasing both go):

    ```ts
    const matchesSection = (line: string, section: string, subsection: string | undefined): boolean => {
      const header = parseSectionHeader(line.trim());
      if (header.kind !== 'header') return false;
      if (header.section.toLowerCase() !== section.toLowerCase()) return false;
      if (subsection === undefined) {
        return header.subsection === undefined || header.subsection === '';
      }
      return header.subsection === subsection;
    };
    ```

  - `findSectionHeader(lines, section, subsection)` (lines 102–111) — re-sign to `(lines: ReadonlyArray<string>, oldName: string): number`, looping with the new raw predicate.
  - `removeConfigSectionInText(text, section, subsection)` (lines 449–470) — re-sign to `(text: string, oldName: string): string` (ADR-326 shape). Drop the `rejectSection`/`rejectSubsection` calls (the old name is only compared, never written — git never validates it); keep the line-skipping loop and `withTrailingNewlineRestored` exactly as is, with `skipping = matchesRawSectionName(line, oldName)`.
  - `renameConfigSectionInText(text, section, fromSubsection, toSubsection)` (lines 479–494) — re-sign to `(text: string, oldName: string, to: NewSectionName): string` where `NewSectionName` is a new exported interface `{ readonly section: string; readonly subsection?: string }`. Keep write-side guards: `rejectSection(to.section)` and, when `to.subsection !== undefined`, `rejectSubsection(to.subsection)` (LF/NUL refusal — deliberate divergence from git's self-corrupting foot-gun). Matching lines map to `renderSectionHeader(to.section, to.subsection)`.
  - NEW:

    ```ts
    export const rawSectionName = (header: {
      readonly section: string;
      readonly subsection?: string;
    }): string =>
      header.subsection === undefined ? header.section : `${header.section}.${header.subsection}`;
    ```

    and a module-local `matchesRawSectionName(line: string, oldName: string): boolean` = `parseSectionHeader(line.trim())` is a header AND `rawSectionName(header) === oldName` (byte-for-byte, case-sensitive — `parseSectionHeader` already returns the section verbatim and the subsection **unescaped**, which is exactly git's reduction).
  - `applyConfigOpInText` (lines ~581–595): the two section arms currently read `removeConfigSectionInText(text, op.section, op.subsection)` and `renameConfigSectionInText(text, op.section, op.from, op.to)`. Adapt the **call sites only** — `ConfigOperation` keeps its shape (in-tree callers `src/application/commands/remote.ts:187,261` and `src/application/commands/submodule.ts:395` pass structured `{section, subsection}` / `{section, from, to}`):

    ```ts
    if (op.kind === 'removeSection') {
      return removeConfigSectionInText(
        text,
        op.subsection === undefined ? op.section : `${op.section}.${op.subsection}`,
      );
    }
    return renameConfigSectionInText(text, `${op.section}.${op.from}`, {
      section: op.section,
      subsection: op.to,
    });
    ```

  - Porcelain `renameConfigSection` (lines 849–886) / `removeConfigSection` (lines 893–915): keep `parseSectionName` + the family guard **in this slice** (deleted in slice 4); only re-plumb the calls so the build stays green: existence check becomes `findSectionHeader(text.split('\n'), oldName)` (the raw input string the caller passed — `oldName` / `sectionName`), surgery becomes `renameConfigSectionInText(text, oldName, { section: newParts.section, subsection: newParts.subsection })` / `removeConfigSectionInText(text, sectionName)`. Net porcelain behaviour change in this slice: section-op matching becomes byte-exact/case-sensitive and `[s]` ≠ `[s ""]` (no existing test pins the old case-insensitivity — verified during planning).
- **Note on strict TS**: the repo compiles under strict settings — build the `NewSectionName` object conditionally rather than assigning `subsection: undefined` explicitly if `exactOptionalPropertyTypes` complains; `npm run check:types` is the arbiter.
- **Tests to reshape** in `test/unit/application/primitives/update-config.test.ts` (mechanical signature rewrites, expectations unchanged unless stated):
  - `removeConfigSectionInText` describe (lines 1935–2142): calls like `sut(text, 'remote', 'origin')` become `sut(text, 'remote.origin')`; `sut(text, 'core', undefined)` becomes `sut(text, 'core')`. The bracket-name validation test (~line 2050: `removeConfigSectionInText('', 'core]\n[evil', undefined)` → `INVALID_OPTION`) is **re-shaped, not deleted**: with raw matching the name simply matches nothing — assert the text comes back byte-identical (`sut('[core]\n\ta = b\n', 'core]\n[evil')` → unchanged).
  - `renameConfigSectionInText` describe (lines 2179–2350): `sut(text, 'remote', 'old', 'new')` becomes `sut(text, 'remote.old', { section: 'remote', subsection: 'new' })`.
  - `removeConfigSectionInText (subsectioned N3)` describe (lines 2351–2371): `sut(text, 'b', 's')` → `sut(text, 'b.s')`.
  - `updateConfigOperations` describe (line 2506+) and the porcelain I/O / malformed-header describes (3121–3275, 3447–3560): op shapes and porcelain inputs are unchanged — these must stay green untouched.

### Pinned raw-name reductions this slice must reproduce (quoted from the design)

> each header is reduced to its raw dotted name (`[s]` → `s`, `[s "x"]` → `s.x`, `[s ""]` → `s.`, `[ ""]` → `.`, `[ "x"]` → `.x`, deprecated `[s.X]` → `s.X`) and compared **byte-for-byte** with the input

| Row | Result |
| --- | --- |
| remove `s` on `[s]k=a · [s ""]k=b` | only `[s]` removed → `[s ""]\n\tk = b\n` |
| remove `s.` on the same | only `[s ""]` removed → `[s]\n\tk = a\n` |
| remove `s.""` on the same | matches nothing (the two-quote-char subsection) |
| remove `s` on `[S]k=a` | matches nothing (case-sensitive) |
| `s.X` matches deprecated `[s.X]k=a`; `s.x` does not | raw header bytes |
| remove `a.b` on `[a.b]k=p · [a "b"]k=q` | **both** blocks removed |
| rename `a.b.` on `[a "b."]k=p · [a.b ""]k=q` | both headers rewritten (ambiguity generalizes) |
| remove `s` on `[s]k=a · [s "x"]k=b · [s]k=c` | BOTH `[s]` blocks removed, `[s "x"]` kept |
| rename `s` → `{t}` on the same | both `[s]` blocks become `[t]` |
| `.` matches `[ ""]`; `.x` matches `[ "x"]` | empty-name family |
| `[s     ""]` (whitespace before the quote) | raw name is still `s.` (pre-quote run is not identity) |
| `[s "a\"b"]` | raw name is `s.a"b` (subsection unescaped before joining) |
| rename `s` → `{section:'s', subsection:''}` on `[s]k=a` | header becomes `[s ""]` (duplicate-with-empty allowed) |
| rename `s.x` → `{section:'t'}` on `[s "x"]k=a` | `[t]\n\tk = a\n` (cross-family at the primitive level) |

### TDD steps

1. **RED (unit)** — new tests against the **new** signatures for every row of the table above (one `it` per row, byte-exact `toBe` on whole-file output; `sut = removeConfigSectionInText` or `renameConfigSectionInText`). They fail to compile (signature mismatch) or fail on the old conflating/case-insensitive behaviour until GREEN.
2. **RED (unit, guards)** — `renameConfigSectionInText('', 'x', { section: 'bad]name' })` → try/catch `INVALID_OPTION` with `reason: 'section must not contain a newline, NUL, bracket, quote, or backslash'`; `renameConfigSectionInText('', 'x', { section: 't', subsection: 'a\nb' })` → `INVALID_OPTION` with `reason: 'subsection must not contain a newline or NUL'` (the LF-refusal divergence pin, unit-level).
3. **RED (unit, batch ops)** — `applyConfigOpInText` with `{ kind: 'removeSection', section: 's' }` (no subsection) on `[s]k=a · [s ""]k=b` removes only `[s]`; `{ kind: 'renameSection', section: 'remote', from: 'old', to: 'new' }` keeps its existing pinned behaviour (existing tests).
4. **GREEN** — implement `rawSectionName` + `matchesRawSectionName`; re-sign `findSectionHeader`, `removeConfigSectionInText`, `renameConfigSectionInText` (add `NewSectionName`); delete `matchesSection`; adapt `applyConfigOpInText` and the two porcelain bodies as quoted in Context. Mechanically reshape the existing test call sites listed in Context.
5. **RED (property, lens 1)** in `update-config.properties.test.ts`: `Given an arbitrary header identity` (section from a safe pool ∪ `''`-with-subsection; subsection from `{undefined, ''} ∪ subsectionName()` — `undefined` only when section non-empty) > `When rendered, re-parsed and reduced` > `Then rawSectionName(parseSectionHeader(renderSectionHeader(section, subsection))) === dotted name` — where the dotted name is built the same way (section alone when the subsection is absent, else section + `.` + subsection). Import `parseSectionHeader` from `config-read.js` and `rawSectionName`/`renderSectionHeader` from the module; restrict the subsection generator to LF/NUL-free (that is `subsectionName()`'s domain). Second clause in the same property family: addressing a two-block file by that dotted name with `removeConfigSectionInText` removes exactly that block and leaves the sibling block's bytes intact. numRuns 200.
6. **api.json**: the re-signed primitives are module exports (not re-exported by the public barrels), so the public report may not move — still run `npm run docs:json` (the script that regenerates `reports/api.json`; it is also gated pre-push by `check:doc-typedoc`) and commit `reports/api.json` in this slice **if it changed**.
7. **Refactor note**: `removeConfigSectionInText` no longer validates anything — fold its doc comment update in (documenting raw-name semantics and the `a.b` ambiguity, per the design's "documented on the primitives"; plain prose, no ADR refs).

### Gate & commit

- `npx vitest run test/unit/application/primitives/update-config.test.ts test/unit/application/primitives/update-config.properties.test.ts`
- `npm run check:types` ; `npx biome check src/application/primitives/update-config.ts test/unit/application/primitives/`
- Commit: `feat(config): raw byte-exact old-name matching for section text surgery`

---

## Slice 4 — New-name grammar, porcelain section ops, interop matrix

Assumes slice 3 landed (raw matching + reshaped `InText` primitives).

### Context

- **Production file**: `src/application/primitives/update-config.ts`.
  - DELETE `parseSectionName` (lines 821–840 post-slice-3 drift — locate by symbol name) **and its docstring** (the lines above it falsely claiming canonical git cannot rename top-level sections). Its `INVALID_OPTION` message `section name must be of the form "<section>.<subsection>": ${name}` disappears with it (no test pins it — verified during planning).
  - DELETE the family guard in `renameConfigSection` (the `oldParts.section.toLowerCase() !== newParts.section.toLowerCase()` block throwing `cannot rename across section families: …`).
  - NEW `export const parseNewSectionName = (name: string): NewSectionName` (reuse slice 3's `NewSectionName`):
    - `name === ''` → throw `invalidOption('config', 'invalid section name: ' + name)` — rendered with a template literal in code; `invalidOption` lives at `src/domain/commands/error.ts:345`, shape `{ code: 'INVALID_OPTION', option, reason }`.
    - `dot = name.indexOf('.')`; section part = `dot === -1 ? name : name.slice(0, dot)`; every character of the section part must match `/[a-zA-Z0-9-]/` (an **empty** section part is allowed only when a dot follows) — else the same `invalid section name: ${name}` refusal.
    - no dot → `{ section: name }` (subsection absent); dot → `{ section: before, subsection: name.slice(dot + 1) }` (rest may be `''` for `'t.'`, may contain further dots — first-dot split only). Case preserved.
  - `renameConfigSection` (current body quoted in slice 3 context) becomes: `const to = parseNewSectionName(newName);` (validate before any I/O) → `if (to.subsection !== undefined) rejectSubsection(to.subsection);` → resolve path/text → raw existence check `findSectionHeader(text.split('\n'), oldName) === -1` → `throw configSectionNotFound(oldName, targetScope)` (`error.ts:452`, data `{ code: 'CONFIG_SECTION_NOT_FOUND', name, scope }` — carries the **raw input verbatim**: `'s.'`, `'.'`, `'bad!name'`, `''`) → `renameConfigSectionInText(text, oldName, to)` → write + cache invalidation (unchanged).
  - `removeConfigSection`: drop the `parseSectionName` call entirely; existence via `findSectionHeader(text.split('\n'), sectionName)`; surgery `removeConfigSectionInText(text, sectionName)`; `configSectionNotFound(sectionName, targetScope)` on miss. The old name is **never validated** (a `'bad!name'` input is a lookup miss, not a grammar error — pinned).
- **Tests that FLIP** in `test/unit/application/primitives/update-config.test.ts` (locate by the quoted titles; line refs are pre-slice-3 anchors):
  - ~3172–3189: rename across families currently expects `INVALID_OPTION` → now succeeds; rewrite to pin the cross-family outcome bytes.
  - ~3193–3207 `Given oldName with no subsection (just "user"), When renameConfigSection runs` → currently `INVALID_OPTION`; now: with no `[user]` block seeded, expect try/catch `data` `{ code: 'CONFIG_SECTION_NOT_FOUND', name: 'user', scope: 'local' }`; add the success twin (seed `[user]\n\tname = Ada\n`, rename `user` → `team`, file becomes `[team]\n\tname = Ada\n`).
  - ~3254–3268 `Given a malformed sectionName (no dot), When removeConfigSection runs` → currently `INVALID_OPTION`; now `CONFIG_SECTION_NOT_FOUND` with `name: 'remote'` (fixture has only `[remote "origin"]`, whose raw name is `remote.origin`).
- **Porcelain command layer** (no signature changes): `configRenameSection` / `configRemoveSection` in `src/application/commands/config.ts` (lines 237/262) pass `input.oldName`/`input.name` through — untouched.
- **Interop file**: `test/integration/config-interop.test.ts` — same conventions as slice 2's context block (twin helpers at ~line 940–983, `tryRunGit`, `60_000` timeouts, new Givens after the helpers). tsgit side uses `renameConfigSection`/`removeConfigSection` primitives or `configRenameSectionCmd`/`configRemoveSection` commands (already imported). For refusal rows compare `tryRunGit(...).ok === false` + `stderr` match (`/no such section/`, `/invalid section name/`) against tsgit's try/catch `.data` (code + `name` + `scope`, or `option` + `reason`).

### Pinned matrices this slice must reproduce (quoted verbatim from the design)

New-name grammar (`--rename-section s <new>` unless stated):

| New name | Result | Exit |
| --- | --- | --- |
| `t.a.b` | `[t "a.b"]` — first-dot split | 0 |
| `1num` | `[1num]` — digit-leading accepted | 0 |
| `t-x` | `[t-x]` | 0 |
| `t_x` | `error: invalid section name: t_x` | 255 |
| `bad!name` | `error: invalid section name: bad!name` | 255 |
| `''` | `error: invalid section name: ` | 255 |
| `t.bad!sub` | `[t "bad!sub"]` — subsection free after the first dot | 0 |
| `t.with"quote` | `[t "with\"quote"]` — quote escaped in the header | 0 |
| `T.Y` | `[T "Y"]` — case preserved | 0 |
| old `'bad!name'` → `t` | `fatal: no such section: bad!name` — OLD name never validated | 128 |

Section-op addressing (`both.conf` = `[s]\n\tk = a\n[s ""]\n\tk = b\n`; `mix.conf` = `[s]\n\tk = a\n[s "x"]\n\tk = b\n[s ""]\n\tk = c\n`; `name-mix.conf` = `[ ""]\n\tk = e\n[s]\n\tk = a\n[s ""]\n\tk = b\n`):

| Command | Result | Exit |
| --- | --- | --- |
| `--remove-section s` on `both.conf` | `[s ""]\n\tk = b\n` | 0 |
| `--remove-section s.` on `both.conf` | `[s]\n\tk = a\n` | 0 |
| `--remove-section 's.""'` on `both.conf` | `fatal: no such section: s.""` | 128 |
| `--remove-section s.` on `plain-only.conf` | `fatal: no such section: s.` | 128 |
| `--remove-section s` on `empty-only.conf` | `fatal: no such section: s` | 128 |
| `--rename-section s t` on `both.conf` | `[t]…[s ""]…` | 0 |
| `--rename-section s. t.` on `both.conf` | `[s]…[t ""]…` | 0 |
| `--rename-section s. t` on `both.conf` | `[s]…[t]…` | 0 |
| `--rename-section s s.` on `both.conf` | `[s ""]…[s ""]…` (duplicate headers allowed) | 0 |
| `--rename-section s.x s.` on `[s "x"]k=a` | `[s ""]\n\tk = a\n` | 0 |
| `--rename-section s t` on `mix.conf` | `[t]…[s "x"]…[s ""]…` | 0 |
| `--remove-section s` on `mix.conf` | `[s "x"]…[s ""]…` | 0 |
| `--rename-section s.x t.y` on `mix.conf` | `[s]…[t "y"]…[s ""]…` | 0 |
| `--rename-section s.x t` on `mix.conf` | `[s]…[t]…[s ""]…` | 0 |
| `--rename-section s t.y` on `mix.conf` | `[t "y"]…[s "x"]…[s ""]…` | 0 |
| `--rename-section s t` on `[s]k=a · [s "x"]k=b · [s]k=c` | BOTH `[s]` blocks become `[t]` | 0 |
| `--rename-section t.y u` (old absent, valid) | `fatal: no such section: t.y` | 128 |
| `--rename-section s t` on `[S]k=a` | `fatal: no such section: s` | 128 |
| `--rename-section s.x t` on `[s "X"]k=a` | `fatal` ; `s.X` succeeds | 128 / 0 |
| `--rename-section s.x t` on deprecated `[s.X]k=a` | `fatal` ; `s.X` succeeds | 128 / 0 |
| `--remove-section a.b` on `[a.b]k=p · [a "b"]k=q` | both blocks removed | 0 |
| `--remove-section .` on `name-mix.conf` | only `[ ""]` removed | 0 |
| `--remove-section .` when absent | `fatal: no such section: .` | 128 |
| `--rename-section . t` on `name-mix.conf` | `[t]…` | 0 |
| `--rename-section . t.` | `[t ""]…` | 0 |
| `--rename-section . .x` | `[ "x"]…` | 0 |
| `--rename-section . s.x` | `[s "x"]…` | 0 |
| `--rename-section s .` on `name-mix.conf` | `[s]` becomes a second `[ ""]` block | 0 |
| `--rename-section s.x .` on `[s "x"]k=a` | `[ ""]\n\tk = a\n` | 0 |
| `--rename-section .x t` / `--remove-section .x` on `[ "x"]k=e` | `[t]` / removed | 0 |
| `--remove-section ''` | `fatal: no such section: ` (lookup miss, not grammar) | 128 |

ADR-325 exclusion: the literal-LF new-subsection row (`--rename-section s "t.a\nb"` — git writes the newline raw and corrupts its own file) is **excluded from the interop matrix**; tsgit refuses it (porcelain unit test below). Exit codes 255/128 are caller rendering (ADR-249) — only the refusal *condition* and message *data* are pinned.

### TDD steps

1. **RED (unit, new-name grammar sweep)** — one test per row of the first table through `parseNewSectionName`: accepted rows assert the exact `{ section, subsection? }` shape (`'t.a.b'` → `{ section: 't', subsection: 'a.b' }`, `'t.'` → `{ section: 't', subsection: '' }`, `'.x'` → `{ section: '', subsection: 'x' }`, `'.'` → `{ section: '', subsection: '' }`, `'T.Y'` → `{ section: 'T', subsection: 'Y' }`, `'1num'`, `'t-x'`, `'t.bad!sub'`, `'t.with"quote'`); refused rows (`''`, `'t_x'`, `'bad!name'`) each in their own test via try/catch asserting `data` `{ code: 'INVALID_OPTION', option: 'config', reason: 'invalid section name: t_x' }` (full reason string per row). Add per-boundary charset tests (e.g. `'t!x.y'` refused — bad char before the first dot; `'tz.y'` accepted) so Stryker cannot survive on the range checks.
2. **RED (unit, porcelain)** — memory-context I/O tests for: trailing-dot rename/remove on a both-form seed (pinned bytes rows 1–2 and 6–8 of the second table); plain-name ops with subsectioned siblings (`mix.conf` rows); cross-family all four direction pairs + `s.x → t.y`; multi-block plain rename; `.`/`.x` rows on `name-mix.conf`; `CONFIG_SECTION_NOT_FOUND` data (`code` + `name` carrying the raw input + `scope`) for: case mismatch (`s` vs `[S]`), `'s.""'`, `'s.'` on plain-only, `''`, `'bad!name'`-as-old-name; the ADR-325 refusal: `renameConfigSection({ ctx, oldName: 's', newName: 't.a\nb' })` → try/catch `INVALID_OPTION` with `reason: 'subsection must not contain a newline or NUL'`, and assert the config file was not touched (refusal before I/O).
3. **Flip** the three pinned porcelain tests listed in Context (cross-family, plain old name, no-dot remove).
4. **GREEN** — add `parseNewSectionName`; rewire `renameConfigSection`/`removeConfigSection` as specified; delete `parseSectionName`, its docstring, and the family guard. Full unit file green.
5. **RED (property, lens 3)** in `update-config.properties.test.ts`: `Given an arbitrary ASCII no-NUL name` > `When parseNewSectionName runs` > `Then it either returns a header-rendering-safe name or throws exactly INVALID_OPTION` — partition property: if every char before the first dot matches `[a-zA-Z0-9-]` and the name is non-empty, the parse succeeds and `renderSectionHeader(result.section, result.subsection)` does not throw; otherwise the thrown error is a `TsgitError` whose `data.code === 'INVALID_OPTION'` and `data.reason` starts with `invalid section name: `. Generator: `fc.string({ unit: printable-ASCII-no-NUL, maxLength: 64 })` biased with `.`/`-`/`_`/`!` specials (local arbitrary in the properties file, or extend `arbitraries.ts` if reused). Exclude LF/NUL-bearing *subsections* from the render clause (or route them to the refusal clause via `rejectSubsection` semantics — keep the oracle an invariant, not a re-implementation: assert the *partition*, not the exact split index). numRuns 100.
6. **RED→GREEN (interop)** — twin every row of both tables (minus the LF row) in `config-interop.test.ts`: seed both configs via `seedTwinConfigs`, drive git with `tryRunGit(['config', '--file', peerConfigPath, '--rename-section'|'--remove-section', …])`, drive tsgit with `renameConfigSection`/`removeConfigSection` on `ours`, byte-compare `readTwinConfigs` outputs for success rows; for refusal rows assert `gitResult.ok === false` + `stderr` pattern AND the tsgit error `.data` (code/name/scope or option/reason). Group rows by fixture into a handful of `it`s with `60_000` timeouts (model on the existing `--rename-section` Givens at lines ~551 and ~837 of the file).
7. **api.json check** — `parseSectionName` was not publicly exported, so no diff is expected, but run `npm run docs:json` and commit `reports/api.json` if it moved (pre-push `check:doc-typedoc` gates it).
8. **Refactor note** — after the deletions, scan `update-config.ts` for now-unused imports/helpers (`invalidOption` stays — used by the guards; `findSectionHeader` may now have a single caller pair — fine). Doc comments on the two porcelain functions get the raw-name addressing semantics (trailing-dot form, `a.b` ambiguity) in plain prose.

### Gate & commit

- `npx vitest run test/unit/application/primitives/update-config.test.ts test/unit/application/primitives/update-config.properties.test.ts test/integration/config-interop.test.ts`
- `npm run check:types` ; `npx biome check src/application/primitives/update-config.ts test/unit/application/primitives/ test/integration/config-interop.test.ts`
- Commit: `feat(config): git name grammar for section ops`

---

## Post-slice expectations (session-owned, not slice work)

- Mutation: the production diff deletes the conflation arms and the family guard, shrinking the prior surviving-mutant surface. The direction-isolated unit fixtures kill the remaining `===` mutants; `parseNewSectionName` charset boundaries are covered per-boundary (slice 4 step 1). Possible equivalent search-offset mutants in homogeneous multi-block fixtures are documented inline (`// equivalent-mutant: <why>`) only if provably equivalent.
- The flipped tests (slice 2 step 5, slice 4 step 3) are the documented behaviour breaks (design Risks) — converging with canonical git.
- Backlog edits (24.9k close, 24.9n absorption) and docs/PR are owned by the session per the workflow, not by any slice.
