# Plan — Phase 20.6 `config` Porcelain

Drives the implementation of `repo.config.*` per
`docs/design/phase-20-6-config-porcelain.md` and ADRs 181–188.

Each slice lists the test cases to write first (Red), the minimal code
to make them green (Green), the refactor pass (Refactor), the
verification commands, and the conventional commit message. Steps are
ordered so each commit lands a self-contained, reviewable unit.

Slices follow the design's §14 ordering with §9.2.1's rename
(slice 1) lifted to the front so the freed names are available to
every later writer slice.

Conventions for the whole plan:

- **Test titles** — `describe('Given <context>') > describe('When
  <action>') > it('Then <expected>')` GWT, AAA body, `sut` variable.
- **Error assertions** — `try/catch` + `.data.code` + `.data.reason`
  on every thrown error; never bare `toThrow(TsgitError)` (mutation
  hygiene per CLAUDE.md).
- **Guard isolation** — one test per banned character / per error
  reason so the StringLiteral mutants on regex/literal predicates die
  individually.
- **No phase / ADR refs in code or test names** — the commit message
  is the join point (per `feedback_no_phase_refs_in_code`).
- **Be git-faithful** — every behaviour mirrors canonical `git config`
  unless an ADR explicitly diverges.
- **No `any`**, immutable data, small functions, early returns, kebab-
  case filenames, 100% line/branch/function/statement coverage.
- **Property tests** live in sibling `*.properties.test.ts` files (not
  mixed into the example file).

Cross-slice escalation: the design narrative uses
`FS_OPERATION_NOT_SUPPORTED` as the FS-port error code, but the
existing codebase uses `UNSUPPORTED_OPERATION` (`src/domain/error.ts`,
factory `unsupportedOperation`). The plan adopts the existing code
`UNSUPPORTED_OPERATION`; the scope wrapper (§slice 5) catches that
and re-throws `CONFIG_SCOPE_NOT_AVAILABLE { reason:
'browser-adapter' }`. Same semantics, name aligned with the
codebase — no ADR amendment needed.

## Slice 0 — Pre-flight

- [x] Worktree on `feat/config-porcelain`.
- [x] Design + ADRs committed (`ee22833` design absorbing ADRs
  181–188).

## Slice 1 — Text-helper `*InText` rename (ADR-188)

**Dependencies:** none.
**Parallel-safe?** No — every later writer slice depends on the freed
unsuffixed names.
**Why first:** all later I/O primitives (slices 8–9) take the
unsuffixed names. Renaming first means slices 8–9 add net-new
exports rather than reshuffling identifiers under change.

### Files to modify

- `src/application/primitives/update-config.ts`
- `src/application/primitives/index.ts`
- `test/unit/application/primitives/update-config.test.ts`
- `test/unit/application/primitives/index.test.ts`

### Rename table

| Old name | New name | Exported today? |
|---|---|---|
| `setConfigEntry` (pure text) | `setConfigEntryInText` | yes — public surface change |
| `setCoreConfigEntry` (pure text) | `setCoreConfigEntryInText` | yes — public surface change |
| `renameConfigSection` (pure text) | `renameConfigSectionInText` | no — internal-only; file-local rename + freeing the name for slice 9c's I/O primitive |
| `removeConfigSection` (pure text) | `removeConfigSectionInText` | no — internal-only; file-local rename + freeing the name for slice 9d's I/O primitive |
| `applyOperation` (file-private orchestrator) | `applyConfigOpInText` | no — promoted + exported in this slice per ADR-188 §9.2.1 |

`removeConfigEntry` and `appendConfigEntry` are also pure text-
transforms but NOT re-exported from `primitives/index.ts`;
they stay file-private under their existing names. The naming
convention applies to them if/when promoted; no rename in this slice.

### Red

Update existing imports in test files; the existing test bodies stay
green under the new symbol names. No new tests in this slice — the
rename is purely mechanical and the existing coverage protects against
regressions.

### Green

1. Rename the five symbols in `update-config.ts`. Keep the `export`
   keyword on `setConfigEntry` → `setConfigEntryInText` and
   `setCoreConfigEntry` → `setCoreConfigEntryInText`. Add `export`
   to the renamed `applyConfigOpInText`. The `renameConfigSection`
   and `removeConfigSection` symbols stay file-private (no `export`
   change) — the rename only frees the name for slices 9c/9d.
2. Update internal call sites inside `update-config.ts`:
   - `setCoreConfigEntryInText` now delegates to
     `setConfigEntryInText`.
   - `updateConfigEntries` folds with `setConfigEntryInText`.
   - `applyConfigOpInText` dispatches to the suffixed names.
3. Update `src/application/primitives/index.ts` exports to use the
   `*InText` names for the two already-exported ones; add
   `applyConfigOpInText` to the export list.
4. Update test imports in both test files. The test file already
   imports `renameConfigSection` and `removeConfigSection` directly
   from `'../../../../src/application/primitives/update-config.js'`
   (per `grep` of the test file); update those imports to the
   suffixed names. The `index.test.ts` ALLOWED_EXPORTS list updates
   in step.

### Refactor

- Confirm no remaining reference to the old unsuffixed names outside
  test files that test the rename itself.
- The legacy comment "kept for legacy callers" on
  `setCoreConfigEntryInText` stays; the function is unchanged in
  behaviour.

### Verification

- `npm run check` (Biome — no new warnings).
- `npm run check:types` (TypeScript strict — no errors).
- `npm run test:unit -- test/unit/application/primitives/update-config.test.ts test/unit/application/primitives/index.test.ts` — all green.

### Commit

`refactor(config): rename pure text-transform helpers with *InText suffix`

### Mutation-resistance notes

None — pure rename, no behavioural change.

## Slice 2 — Writer quoting in `renderEntry` (ADR-186)

**Dependencies:** Slice 1 (consumes `setConfigEntryInText` under its
new name).
**Parallel-safe?** No — slices 7–9 read back values via the writer
and must observe the quoting grammar.

### Files to modify

- `src/application/primitives/update-config.ts` (extend `renderEntry`
  + add a `renderValue` helper).
- `test/unit/application/primitives/update-config.test.ts` (new
  describe blocks).
- `test/unit/application/primitives/update-config.properties.test.ts`
  (NEW) — round-trip property tests.

### Red — example tests

New describe `Given a value that needs quoting`:

- "Given a value containing `#`, When `setConfigEntryInText` runs,
  Then the rendered line is `\tkey = "value-with-#"`."
- One test per quote-triggering character: `;` / leading space /
  leading tab / trailing space / trailing tab / embedded `"` /
  embedded `\` / embedded `\n`.
- "Given a plain alphanumeric value, When rendered, Then the line is
  `\tkey = value` (no quotes, identical to current behaviour)."
- "Given a value containing `\t` only (no other trigger), When
  rendered, Then the value is emitted verbatim (no quotes)."
- "Given a quoted value round-tripped through `parseIniSections`, Then
  the parsed value equals the original input." Repeat for every
  trigger character.

Negation case (defence in depth):

- "Given a value with embedded `\n` AND embedded `\\`, When rendered,
  Then the output reads as `\"<escaped>\"` and round-trips via
  `parseIniSections` byte-exact on the value."

### Red — property test sibling file

`update-config.properties.test.ts`:

- `Given an arbitrary value in the assertValueSafe-survivable subset
  (ASCII printable + \t + \n, length ≤ 1024)`,
  `When the value is rendered into a config text via
  setConfigEntryInText and re-parsed via parseIniSections`,
  `Then the round-tripped value equals the original.`
  `numRuns: 200`.

Arbitrary: `fc.string({ maxLength: 1024 })` filtered to the allowed
control set; characters outside `[\x20-\x7e\t\n]` are discarded.

### Green

In `update-config.ts`:

```typescript
const needsQuote = (value: string): boolean =>
  value.includes('#') ||
  value.includes(';') ||
  /^[ \t]/.test(value) ||
  /[ \t]$/.test(value) ||
  value.includes('"') ||
  value.includes('\\') ||
  value.includes('\n');

const renderValue = (value: string): string => {
  if (!needsQuote(value)) return value;
  const escaped = value
    .replaceAll('\\', '\\\\')
    .replaceAll('"', '\\"')
    .replaceAll('\n', '\\n');
  return `"${escaped}"`;
};

const renderEntry = (key: string, value: string): string =>
  `\t${key} = ${renderValue(value)}`;
```

### Refactor

- Inline-comment `needsQuote` to explain each trigger (`why`, not
  `what`).
- `renderValue` should be ≤ 10 lines; pull `escape()` out if it grows.

### Verification

- `npm run validate` (full pipeline).
- Phase 20.5 `repo.remote` tests stay green — the quoting writer is
  centralised so refspec writes inherit quoting without code change.

### Commit

`feat(config): quote values containing #/;/whitespace/quotes/backslash`

### Mutation-resistance notes

- Each trigger character has its own example test — the StringLiteral
  mutants on `needsQuote`'s string literals die individually.
- The round-trip property test catches any escape-order bug
  (e.g. quoting `"` before `\\` would double-escape).
- Assert the exact rendered line — `toBe(string)` not
  `toContain('value')`.

## Slice 3 — Branded `ConfigKey` and `ConfigScope` + domain key parser

**Dependencies:** none (pure domain).
**Parallel-safe?** Yes with slices 1–2.

### Files to create

- `src/domain/commands/config-key.ts` (NEW)
- `test/unit/domain/commands/config-key.test.ts` (NEW)
- `test/unit/domain/commands/config-key.properties.test.ts` (NEW)

### Files to modify

- `src/domain/commands/index.ts` (re-export `parseConfigKey`,
  `ParsedConfigKey`, `ConfigKey`, `ConfigScope`).

### Red — example tests

`describe('parseConfigKey')`:

- "Given `user.name`, When parsed, Then `{ section: 'user',
  subsection: undefined, name: 'name' }`."
- "Given `USER.NAME`, When parsed, Then the section and name are
  lower-cased."
- "Given `remote.origin.url`, When parsed, Then `{ section: 'remote',
  subsection: 'origin', name: 'url' }`."
- "Given `remote.my.fork.url`, When parsed, Then `{ section:
  'remote', subsection: 'my.fork', name: 'url' }` (subsection takes
  everything between first and last `.`)."
- "Given a subsection containing `Case`, When parsed, Then the
  subsection is preserved case-sensitively while the section and name
  are lower-cased."
- One test per `CONFIG_KEY_INVALID` reason (isolated):
  - "Given `''`, Then throws with `reason: 'empty-section'`."
  - "Given `user`, Then throws with `reason: 'missing-name'`."
  - "Given `'.name'`, Then throws with `reason: 'empty-section'`."
  - "Given `'user.'`, Then throws with `reason: 'missing-name'`."
  - "Given `'1user.name'` (name must start with letter), Then throws
    with `reason: 'bad-character'` and `position: 0`."
  - "Given `'user.1name'`, Then throws with `reason: 'bad-character'`
    and `position: <index of 1>`."
  - One test per forbidden section/name character (`!`, ` `, `/`,
    etc.) — isolated.
  - "Given `'user.x_name'` (`_` not allowed), Then throws with
    `reason: 'bad-character'`."

Use `try/catch` + `.data.code` + `.data.reason` + `.data.position`
assertions (mutation hygiene).

### Red — property tests

`config-key.properties.test.ts` — four-lens checks per CLAUDE.md:

- **Total function:** `Given any key from the safe subset
  ([a-z][a-z0-9-]*\.[a-z][a-z0-9-]*) of length ≤ 32`, `When
  parseConfigKey runs`, `Then it returns without throwing.`
  `numRuns: 100`.
- **Idempotence:** `Given the same key string`, `When parseConfigKey
  is called twice`, `Then the two results are deeply equal.`
  `numRuns: 50`.
- **Round-trip (paired with qualifyKey from slice 4 — see note
  below).** *Defer this property to slice 4.* The slice-3 property
  test only covers parser totality + idempotence.

### Green

`src/domain/commands/config-key.ts`:

```typescript
export type ConfigKey = string & { readonly __brand: 'ConfigKey' };
export type ConfigScope = 'system' | 'global' | 'local' | 'worktree';

export interface ParsedConfigKey {
  readonly section: string;        // lower-cased
  readonly subsection: string | undefined;
  readonly name: string;           // lower-cased
}

export const parseConfigKey = (raw: string): ParsedConfigKey => {
  // ... see §7 of the design
};
```

Implementation steps:
1. Locate first and last `.` in `raw`.
2. Three branches: zero `.` → `missing-name`; one `.` → two-part
   form; ≥ 2 `.` → three-part form with `subsection` between first
   and last.
3. Validate section / name via `[a-zA-Z0-9-]+` (name must start with
   a letter); validate subsection via the existing
   `rejectSubsection` rule (no `\n`/`\r`/`\0`/`"`/`\\`/`]`).
4. Throw `CONFIG_KEY_INVALID` factories — added in slice 4.

**Sequencing note for slice 3:** the error code factory
(`configKeyInvalid`) lands in slice 4. Order: write slice 4 first
OR temporarily throw a placeholder `TsgitError` and convert in slice
4. Cleaner: **swap slice 3 and slice 4 ordering** — see "Slice
ordering recap" at the end of this doc. The plan as written keeps
slice 3 first by inlining a tiny inline factory inside the parser
file until slice 4 lands; slice 4 then refactors the parser to call
the proper factories. Both slices land in the same PR so the
intermediate state never reaches main.

### Refactor

- Extract `validateIdentifier(text, kind, startsWithLetter)` helper
  shared by the section / name validators.
- Each branch returns early — keep nesting ≤ 1.

### Verification

- `npm run check`, `npm run check:types`, `npm run test:unit -- test/unit/domain/commands/config-key`.

### Commit

`feat(config): branded ConfigKey/ConfigScope and parseConfigKey`

### Mutation-resistance notes

- The `letter` predicate (`/^[a-zA-Z]/`) regex is high-mutation:
  isolate it with one test per character class (lowercase letter,
  uppercase letter, digit, hyphen at start).
- Assert `position` as an exact number — the off-by-one mutant
  (`i` vs `i + 1`) dies.
- `parseConfigKey('user.name').subsection` MUST be `undefined`
  (not `''`) — assert with `toBeUndefined()`.

## Slice 4 — New domain error codes + factories

**Dependencies:** Slice 3 (the parser throws these).
**Parallel-safe?** No — slice 3 imports from these factories at the
final state.

### Files to modify

- `src/domain/commands/error.ts` (add 6 new codes + factories)
- `test/unit/domain/commands/error.test.ts` (extend)
- `src/domain/commands/index.ts` (re-export factories if not via
  wildcard)

### Red

For each new code, mirror the existing `remoteExists`/
`remoteNameInvalid` pattern in `error.test.ts`:

- `configKeyInvalid(key, reason, position?)` — assert
  `{ code: 'CONFIG_KEY_INVALID', key, reason, position? }` round-
  trip. Three cases per reason (`empty-section`, `missing-name`,
  `bad-character` with `position`).
- `configValueInvalid(key, position)` — assert
  `{ code: 'CONFIG_VALUE_INVALID', key, reason:
  'control-character', position }` round-trip.
- `configMultipleValues(key, count, requested, scope?)` — assert
  every field. Three sub-cases per `requested` value
  (`'read' | 'overwrite' | 'remove'`). Tests with and without the
  optional `scope`.
- `configSectionNotFound(name, scope)` — round-trip.
- `configScopeNotAvailable(scope, reason)` — round-trip; two
  sub-cases per `reason` (`'browser-adapter' | 'worktree-extension-
  unset'`).
- `configSystemPathUnresolved()` — round-trip.
- One test per factory's message format (extend the existing
  `formatError`/`displayMessage` test suite if present).

`key` / `name` factories MUST sanitise via `sanitizeForDisplay` —
assert that a `\x07` in the input renders as `\x07` in the error
data (matches the existing `remoteNameInvalid` test).

### Green

Add the six union arms to `CommandError`:

```typescript
| { readonly code: 'CONFIG_KEY_INVALID'; readonly key: string;
    readonly reason: 'empty-section' | 'missing-name' | 'bad-character';
    readonly position?: number }
| { readonly code: 'CONFIG_VALUE_INVALID'; readonly key: string;
    readonly reason: 'control-character'; readonly position: number }
| { readonly code: 'CONFIG_MULTIPLE_VALUES'; readonly key: string;
    readonly count: number; readonly scope?: ConfigScope;
    readonly requested: 'read' | 'overwrite' | 'remove' }
| { readonly code: 'CONFIG_SECTION_NOT_FOUND'; readonly name: string;
    readonly scope: ConfigScope }
| { readonly code: 'CONFIG_SCOPE_NOT_AVAILABLE'; readonly scope: ConfigScope;
    readonly reason: 'browser-adapter' | 'worktree-extension-unset' }
| { readonly code: 'CONFIG_SYSTEM_PATH_UNRESOLVED' }
```

Factory functions:

```typescript
export const configKeyInvalid = (
  key: string,
  reason: 'empty-section' | 'missing-name' | 'bad-character',
  position?: number,
): TsgitError =>
  new TsgitError(
    position === undefined
      ? { code: 'CONFIG_KEY_INVALID', key: sanitizeForDisplay(key), reason }
      : { code: 'CONFIG_KEY_INVALID', key: sanitizeForDisplay(key), reason, position },
  );

export const configValueInvalid = (key: string, position: number): TsgitError =>
  new TsgitError({
    code: 'CONFIG_VALUE_INVALID',
    key: sanitizeForDisplay(key),
    reason: 'control-character',
    position,
  });

// ... and so on for the other four ...
```

Import `ConfigScope` from `src/domain/commands/config-key.ts`.

### Refactor

- Convert slice-3's inline parser factory to call the new
  `configKeyInvalid` factory; delete the placeholder.

### Verification

- `npm run validate`.

### Commit

`feat(error): config domain error codes (KEY_INVALID, VALUE_INVALID, MULTIPLE_VALUES, SECTION_NOT_FOUND, SCOPE_NOT_AVAILABLE, SYSTEM_PATH_UNRESOLVED)`

### Mutation-resistance notes

- Assert each `reason` literal with an exact `toBe('<literal>')`,
  one per test case — kills the StringLiteral mutants.
- For the `position?: number` optional, write a test pair: with
  `position` and without. Asserting `position` is missing must use
  `expect(err.data).not.toHaveProperty('position')` rather than
  `expect(err.data.position).toBeUndefined()` — the latter survives
  the `if (position === undefined)` branch mutation.
- `count` (number) and `scope?` assertions use exact values.

## Slice 5 — `FileSystem` adapter capabilities (ADR-182)

**Dependencies:** none (port + adapters only).
**Parallel-safe?** Yes with slices 1–4.

### Files to modify

- `src/ports/file-system.ts` (add three methods to the interface)
- `src/adapters/node/node-file-system.ts` (implement)
- `src/adapters/browser/browser-file-system.ts` (throw
  `UNSUPPORTED_OPERATION`)
- `src/adapters/memory/memory-file-system.ts` (implement with
  injectable fakes)
- `src/repository/wrap-fs-validator.ts` (forward the three new
  methods un-validated — they return path strings, they don't take
  paths; they MUST NOT be path-guarded since they predate path
  validation)
- `test/unit/adapters/node/node-file-system.test.ts` (extend)
- `test/unit/adapters/browser/browser-file-system.test.ts` (extend)
- `test/unit/adapters/memory/memory-file-system.test.ts` (extend)

### Red — per adapter

Node adapter:
- "Given a process with `$HOME=/u/ada`, When `homedir()` runs, Then
  it returns `/u/ada`." (Use `os.homedir()`.)
- "Given `$XDG_CONFIG_HOME=/cfg`, When `xdgConfigHome()` runs, Then
  it returns `/cfg`." Restore env in `afterEach`.
- "Given `$XDG_CONFIG_HOME` unset, When `xdgConfigHome()` runs, Then
  it returns `<homedir>/.config`."
- "Given `process.platform === 'win32'` and
  `$ProgramData=C:\ProgramData`, When `systemConfigPath()` runs,
  Then it returns `C:\ProgramData\Git\config`." (Mock `process` or
  use `vi.stubGlobal`.)
- "Given `process.platform === 'linux'`, When `systemConfigPath()`
  runs, Then it returns `/etc/gitconfig`."

Browser adapter:
- "Given the browser adapter, When `homedir()` runs, Then throws
  `UNSUPPORTED_OPERATION` with `operation: 'homedir'` and
  `reason: 'browser adapter has no concept of a home directory'` (or
  equivalent — mirror the existing browser unsupported-op messages)."
- Same for `xdgConfigHome()` and `systemConfigPath()`.

Memory adapter:
- "Given a memory adapter constructed with `home: '/home/test'`,
  When `homedir()` runs, Then it returns `/home/test`."
- "Given a memory adapter constructed with no override, When
  `homedir()` runs, Then it returns the default `/home/user`."
- Same shape for `xdgConfigHome` and `systemConfigPath` with their
  defaults.

### Green

Port (`src/ports/file-system.ts`):

```typescript
export interface FileSystem {
  // ... existing methods unchanged ...
  readonly homedir: () => string;
  readonly xdgConfigHome: () => string;
  readonly systemConfigPath: () => string;
}
```

Node adapter:

```typescript
homedir: () => os.homedir(),
xdgConfigHome: () => process.env.XDG_CONFIG_HOME ?? `${os.homedir()}/.config`,
systemConfigPath: () => process.platform === 'win32'
  ? `${process.env.ProgramData ?? 'C:\\ProgramData'}\\Git\\config`
  : '/etc/gitconfig',
```

Browser adapter:

```typescript
homedir: () => { throw unsupportedOperation('homedir', 'browser adapter has no home directory'); },
xdgConfigHome: () => { throw unsupportedOperation('xdgConfigHome', 'browser adapter has no XDG config home'); },
systemConfigPath: () => { throw unsupportedOperation('systemConfigPath', 'browser adapter has no system config path'); },
```

Memory adapter — add `home?`, `xdg?`, `systemConfig?` to the
constructor options; default to `'/home/user'`, `'/home/user/.config'`,
`'/etc/gitconfig'`.

`wrapFsValidator`: forward the three new methods un-validated:

```typescript
homedir: () => fs.homedir(),
xdgConfigHome: () => fs.xdgConfigHome(),
systemConfigPath: () => fs.systemConfigPath(),
```

### Refactor

- Extract `process.platform === 'win32'` into a `isWindows()` helper
  inside the node adapter file (only if used twice).
- Memory adapter: store defaults as named constants
  (`DEFAULT_HOME = '/home/user'` etc.).

### Verification

- `npm run validate`.
- Cross-platform note: the win32 test uses `vi.stubEnv('platform',
  'win32')` or equivalent; the POSIX test runs natively on CI.

### Commit

`feat(fs): adapter capabilities — homedir/xdgConfigHome/systemConfigPath`

### Mutation-resistance notes

- Each platform branch needs its own test (POSIX, Windows). Asserting
  the path is a literal string (not `toContain`) kills the
  StringLiteral mutants in the path templates.
- Assert the env-fallback path explicitly (with AND without
  `$XDG_CONFIG_HOME` set) — kills the `??` mutant.
- Browser-adapter throws are caught via `try/catch` + `.data.code` +
  `.data.operation` (the `unsupportedOperation` factory carries both).

## Slice 6 — Scope resolver (`config-scope.ts`)

**Dependencies:** Slices 3, 4, 5.
**Parallel-safe?** No — slice 7's readers consume `resolveScopePath`
and the merge helpers.

### Files to create

- `src/application/commands/internal/config-scope.ts` (NEW)
- `src/application/commands/internal/config-key.ts` (NEW — holds
  `qualifyKey` + the two collectors per design §9.1; co-located with
  the scope helpers so the application-layer config plumbing lives in
  one folder)
- `test/unit/application/commands/internal/config-scope.test.ts`
  (NEW)
- `test/unit/application/commands/internal/config-scope.properties.test.ts`
  (NEW)
- `test/unit/application/commands/internal/config-key.test.ts` (NEW)

### Public API (`config-scope.ts`)

```typescript
export const resolveScopePath = (
  ctx: Context,
  scope: ConfigScope,
): Promise<string>;
// throws CONFIG_SCOPE_NOT_AVAILABLE or CONFIG_SYSTEM_PATH_UNRESOLVED
// (async because `worktree` reads the local config to check the
// extension flag; the other scopes are pure path computation but
// the function is uniformly async for caller simplicity).

export const mergeConfigsByScope = (
  scoped: ReadonlyArray<{
    readonly scope: ConfigScope;
    readonly sections: ReadonlyArray<IniSection>;
  }>,
): ReadonlyArray<{
  readonly scope: ConfigScope;
  readonly section: IniSection;
}>;

export const isWorktreeScopeActive = (ctx: Context) => Promise<boolean>;
// reads local config; returns extensions.worktreeConfig === true.
```

### Public API (`config-key.ts`)

```typescript
export const qualifyKey = (
  section: IniSection,
  rawName: string,
): string;
// renders <section>(.<subsection>)?.<name>; lower-cases section/name,
// preserves subsection verbatim.

export const collectValues = (
  sections: ReadonlyArray<IniSection>,
  parsed: ParsedConfigKey,
): ReadonlyArray<{ readonly value: string }>;

export const collectScopedValues = (
  scopedSections: ReadonlyArray<{ scope: ConfigScope; section: IniSection }>,
  parsed: ParsedConfigKey,
): ReadonlyArray<{ readonly value: string; readonly scope: ConfigScope }>;
```

Tests for `qualifyKey` / `collectValues` / `collectScopedValues`
live in `config-key.test.ts`:

- "Given a section without subsection, When `qualifyKey` runs, Then
  `<section>.<name>` (lower-cased)."
- "Given a section with subsection `My.Fork`, Then the subsection
  case is preserved."
- "Given `parsed: user.name`, When `collectValues` walks a sections
  array with two `name = …` entries under `[user]`, Then returns two
  `{ value }` entries in physical order."
- "Given `parsed: remote.origin.fetch`, When `collectScopedValues`
  walks a scoped sections array with one match in `global` and two
  in `local`, Then returns three entries in scope-precedence × physical
  order."
- "Given `parsed` matching no entries, Then returns empty."
- Case-folding: "Given `parsed.section = 'user'` and a section
  header `[USER]`, Then the match still finds it."
- "Given a subsection mismatch (`[remote \"origin\"]` vs
  `parsed.subsection = 'upstream'`), Then no match."

`mergeConfigsByScope` produces a flat `{ scope, section }[]` in
scope-precedence order (system → global → local → worktree), with
physical-file order preserved within each scope.

`resolveScopePath` per scope:
- `local` → `${ctx.layout.gitDir}/config`.
- `worktree` → `${ctx.layout.gitDir}/config.worktree` IFF
  `extensions.worktreeConfig === true` in `local`; else throws
  `configScopeNotAvailable('worktree', 'worktree-extension-unset')`.
- `global` → first existing of `${xdg}/git/config`,
  `${home}/.gitconfig`; if neither exists, returns
  `${home}/.gitconfig` (the canonical-git write target). Adapter
  errors (`UNSUPPORTED_OPERATION` from `homedir()` /
  `xdgConfigHome()`) are caught and re-thrown as
  `configScopeNotAvailable('global', 'browser-adapter')`.
- `system` → `systemConfigPath()`; adapter errors re-thrown as
  `configScopeNotAvailable('system', 'browser-adapter')`. If the
  path is empty / unresolvable (future-proof for the deferred
  `$(prefix)` discovery), throws `configSystemPathUnresolved()`.

### Red — example tests for `resolveScopePath`

One test per scope × one per adapter exception path:
- `local` → returns `${gitDir}/config`.
- `worktree` with `extensions.worktreeConfig = true` → returns
  `${gitDir}/config.worktree`.
- `worktree` without the extension → throws
  `configScopeNotAvailable` with `reason: 'worktree-extension-unset'`
  (try/catch + data assertion).
- `global` with `$XDG_CONFIG_HOME=/x` and the file present → returns
  `/x/git/config`.
- `global` with no env, file present at `~/.gitconfig` → returns
  `~/.gitconfig`.
- `global` with neither file present → returns `~/.gitconfig` (write
  target).
- `global` against a browser adapter → throws
  `configScopeNotAvailable` with `reason: 'browser-adapter'`.
- `system` POSIX → returns `/etc/gitconfig`.
- `system` against a browser adapter → throws
  `configScopeNotAvailable` with `reason: 'browser-adapter'`.

### Red — example tests for `mergeConfigsByScope`

- "Given empty input, Then returns empty array."
- "Given only `local` sections, Then returns the same sections
  tagged with `scope: 'local'`."
- "Given `local` and `global` sections with no overlapping keys,
  Then returns global first then local, in physical order."
- "Given `system`, `global`, `local`, `worktree`, Then the output
  preserves the four-scope precedence order."
- "Given a section appearing in two scopes, Then both copies are
  present and tagged with their respective scopes (no merging at
  this layer; the porcelain handles last-writer-wins later)."

### Red — example tests for `isWorktreeScopeActive`

- "Given a local config with `[extensions] worktreeConfig = true`,
  Then returns `true`."
- "Given a local config without that key, Then returns `false`."
- "Given a missing local config file, Then returns `false`."

### Red — property tests (`config-scope.properties.test.ts`)

Per CLAUDE.md case 2 (compositional matcher):

- `Given an arbitrary array of { scope, sections }`, `When
  mergeConfigsByScope runs`, `Then the output length equals the sum
  of input section counts.` `numRuns: 100`.
- `Given the same input twice`, `When mergeConfigsByScope runs`,
  `Then both outputs are deeply equal.` (idempotence) `numRuns: 50`.
- `Given an input augmented with one extra { scope, [section] }`,
  `When mergeConfigsByScope runs`, `Then the output is the previous
  output plus exactly one entry at the position dictated by scope
  precedence.` `numRuns: 100`.

### Green

Standard. `resolveScopePath` uses `try/catch` around adapter calls
to convert `UNSUPPORTED_OPERATION` → `CONFIG_SCOPE_NOT_AVAILABLE`.

### Refactor

- Extract the precedence ordering into a `SCOPE_ORDER:
  readonly ConfigScope[] = ['system', 'global', 'local', 'worktree']`
  constant.
- Use it in both `mergeConfigsByScope` and any later precedence
  walk.

### Verification

- `npm run validate`.

### Commit

`feat(config): scope path resolver + precedence merge helper`

### Mutation-resistance notes

- The four-scope precedence ordering is a magic ordering: assert
  with an explicit array of scopes (not a `toContain` chain).
- The browser-adapter degradation tests need isolated cases per
  scope — write three tests, one each for `global`, `system`,
  and (potentially) `homedir`-dependent paths.
- The `??` fallback in `resolveScopePath('global')` (first existing
  → write-target default) needs a test for both branches.

## Slice 7 — Primitive readers (`config-read.ts` extension)

**Dependencies:** Slices 3, 4, 6.
**Parallel-safe?** No — slice 8 composes `readConfigSections`.

### Files to modify

- `src/application/primitives/config-read.ts` (extend)
- `src/application/primitives/index.ts` (re-export new readers)
- `test/unit/application/primitives/config-read.test.ts` (extend)

### New exports

```typescript
export const readConfigSections = ({
  ctx,
  scope,
}: { ctx: Context; scope?: ConfigScope }): Promise<ReadonlyArray<IniSection>>;

export const getConfigValue = ({
  ctx,
  key,
  scope,
}: { ctx: Context; key: string; scope?: ConfigScope }): Promise<
  { readonly key: ConfigKey; readonly value: string; readonly scope: ConfigScope } |
  { readonly key: ConfigKey; readonly value: undefined }
>;

export const getAllConfigValues = ({
  ctx,
  key,
  scope,
}: { ctx: Context; key: string; scope?: ConfigScope }): Promise<{
  readonly key: ConfigKey;
  readonly values: ReadonlyArray<{ readonly value: string; readonly scope: ConfigScope }>;
}>;
```

Cache: extend the existing per-`Context` WeakMap to a per-scope key:

```typescript
let sectionsCache: WeakMap<Context, Map<ConfigScope, Promise<ReadonlyArray<IniSection>>>> = new WeakMap();
```

`invalidateConfigCache` keeps its existing signature (drops the
whole context entry); add `invalidateConfigCacheForScope(ctx, scope)`
later if a finer invalidation is needed — slice 8 may add it. For
slice 7, drop the whole context's cache entry on write (status quo).

### Red

`readConfigSections`:
- "Given a `local` scope and a `.git/config` with two sections, Then
  the returned array has two entries (no merging)."
- "Given an omitted `scope`, Then returns sections merged across the
  four active scopes via `mergeConfigsByScope`." (Construct fake
  global / system / worktree files via the memory adapter.)
- "Given a `worktree` scope WITHOUT `extensions.worktreeConfig =
  true`, Then throws `configScopeNotAvailable` with `reason:
  'worktree-extension-unset'`." (Same for explicit `global` /
  `system` in a browser context.)
- Cache test: "Given two consecutive `readConfigSections({ ctx,
  scope: 'local' })` calls, Then only one `fs.readUtf8` happens."
  (Spy on the adapter.)
- "Given a `setConfigEntry`-equivalent write that calls
  `invalidateConfigCache(ctx)`, When `readConfigSections` is called
  again, Then a second `fs.readUtf8` happens (cache miss)."

`getConfigValue`:
- "Given `user.name` present once in `local`, Then returns `{ key,
  value, scope: 'local' }`."
- "Given `user.name` absent, Then returns `{ key, value: undefined }`."
- "Given `user.name` appearing twice in `local`, Then throws
  `configMultipleValues` with `requested: 'read'`, `count: 2`,
  `scope: 'local'`."
- "Given `user.name` in both `global` and `local` (no `scope`
  argument), Then throws `configMultipleValues` with `count: 2` and
  no `scope` (merged read across two scopes)." (Pattern: caller MUST
  use `getAll` to disambiguate.)
- "Given `user.name = 'Ada'` in `local`, value contains `#` (quoted
  on write per slice 2), When `getConfigValue` reads it, Then the
  returned `value` is the unquoted original string."

`getAllConfigValues`:
- "Given `remote.origin.fetch` appearing three times in `local`, Then
  returns `values: [{value: A, scope: local}, {value: B, scope:
  local}, {value: C, scope: local}]` in physical order."
- "Given the same key in `global` and `local`, Then `values` is
  `[{value: G, scope: 'global'}, {value: L, scope: 'local'}]` in
  precedence order."
- "Given a missing key, Then `values` is empty."

### Green

- `readConfigSections({ ctx, scope })` — when `scope` is provided,
  reads the single file via `resolveScopePath` and returns
  `parseIniSections` of it. When `scope` is omitted, fans out to
  the four scopes (skipping unavailable ones silently for browser-
  adapter cases), then `mergeConfigsByScope`.
- `getConfigValue` — `parseConfigKey(key)`, build the scoped
  sections via `readConfigSections`, call `collectScopedValues`
  (from slice 6's `internal/config-key.ts`). If length > 1 throw
  `configMultipleValues`; if length 0 return `{ key, value:
  undefined }`; else return the single match `{ key, value, scope }`.
- `getAllConfigValues` — same walk, return all matches as `values`.

The collector / qualifier helpers are provided by slice 6's
`src/application/commands/internal/config-key.ts`. Slice 7 imports
them; no duplication.

### Refactor

- Inline-doc the cache semantics on the new readers.
- The merged-read path silently skips browser-adapter-unavailable
  scopes; the per-scope-call path raises. Document the asymmetry in
  one tsdoc paragraph.

### Verification

- `npm run validate`.

### Commit

`feat(config): readConfigSections / getConfigValue / getAllConfigValues primitives`

### Mutation-resistance notes

- The cache-hit assertion uses a spy on `fs.readUtf8` and asserts
  the exact call count (`toHaveBeenCalledTimes(1)`); kills the
  cache-bypass mutants.
- The multi-value branch needs its own test per scope set
  (single-scope, merged) so the `scope` field assertion kills the
  `scope?: ConfigScope` optional-field mutants.
- Assert the `value` field is the unquoted string after the writer
  round-trip — the trivial mutant that returns the raw line text
  dies.

## Slice 8 — New I/O `setConfigEntry` primitive

**Dependencies:** Slices 1, 2, 3, 4, 5, 6, 7.
**Parallel-safe?** No — slice 9 composes the same I/O pattern.

### Files to modify

- `src/application/primitives/update-config.ts` (add
  `setConfigEntry` under the freed name)
- `src/application/primitives/index.ts` (re-export)
- `test/unit/application/primitives/update-config.test.ts` (extend)

### New export

```typescript
export const setConfigEntry = async ({
  ctx,
  key,
  value,
  scope,
}: {
  readonly ctx: Context;
  readonly key: string;
  readonly value: string;
  readonly scope?: ConfigScope;
}): Promise<void>;
```

Implementation:
1. `parseConfigKey(key)` — throws `CONFIG_KEY_INVALID`.
2. `assertValueSafe(value)` — new helper in `update-config.ts` that
   rejects control chars (`\0`, `\r`, `\x01–\x08`, `\x0B`, `\x0C`,
   `\x0E–\x1F`, `\x7F`) with `configValueInvalid(key, position)`.
   `\n` and `\t` are allowed; the writer's quoting handles them.
3. `targetScope = scope ?? 'local'`.
4. `path = resolveScopePath(ctx, targetScope)`.
5. Read-modify-write: read text (missing → `''`), compose
   `setConfigEntryInText(text, parsed.section, parsed.subsection,
   parsed.name, value)`, write back, `invalidateConfigCache(ctx)`.

### Red

- "Given a missing config file and `scope: 'local'`, When
  `setConfigEntry({ ctx, key: 'user.name', value: 'Ada' })` runs,
  Then `.git/config` contains `[user]\n\tname = Ada\n`."
- "Given an existing `user.name = Ada`, When `setConfigEntry` runs
  with `value: 'Bob'`, Then the value is `Bob` (no duplicate line)."
- "Given a value containing `#`, When `setConfigEntry` runs, Then
  the on-disk text matches the quoted writer output."
- "Given `scope: 'global'` on a node adapter, When the call runs,
  Then the targeted file is the one returned by
  `resolveScopePath(ctx, 'global')`." (Use the memory adapter's
  fake home.)
- "Given an invalid key (one test per `CONFIG_KEY_INVALID` reason),
  Then throws before any I/O happens." (Assert via spy that
  `fs.writeUtf8` was NOT called.)
- "Given a value with `\\0`, Then throws `configValueInvalid` with
  `position: <index of \\0>` and NO I/O happens."
- One test per banned control char (`\0`, `\r`, `\x01`-`\x08`,
  `\x0B`, `\x0C`, `\x0E`-`\x1F`, `\x7F`) — isolated.
- "Given `value: 'has\\nnewline'`, Then the call SUCCEEDS (writer
  quotes the value)."
- "Given `value: 'has\\ttab'`, Then the call SUCCEEDS verbatim."
- "Given a successful call, When `readConfig(ctx)` runs immediately
  after, Then the cache miss makes a fresh read." (Cache
  invalidation.)
- "Given a `worktree` scope without `extensions.worktreeConfig`,
  Then throws `configScopeNotAvailable` and NO I/O happens."

### Green

Standard.

### Refactor

- Extract the read-modify-write loop into a private helper that
  slice 9 reuses (`readModifyWrite(ctx, scope, transform)`).

### Verification

- `npm run validate`.

### Commit

`feat(config): setConfigEntry I/O primitive with scope routing`

### Mutation-resistance notes

- Each banned control char gets its own test — kills the regex
  literal mutants.
- The "no I/O on rejected input" assertions use a spy; assert
  `toHaveBeenCalledTimes(0)` exactly.
- Assert the `position` field on `CONFIG_VALUE_INVALID` is the exact
  index of the offending char (off-by-one mutant dies).

## Slice 9 — Remaining I/O primitives

**Dependencies:** Slice 8 (reuses the read-modify-write helper).
**Parallel-safe?** Sub-slices 9a–9d are parallel-safe with each
other (independent functions); ship them in one commit for
review-locality.

### Files to modify

- `src/application/primitives/update-config.ts`
- `src/application/primitives/index.ts`
- `test/unit/application/primitives/update-config.test.ts`

### Sub-slices

#### 9a — `unsetConfigEntry`

```typescript
export const unsetConfigEntry = async ({
  ctx, key, scope,
}: { readonly ctx: Context; readonly key: string; readonly scope?: ConfigScope }): Promise<void>;
```

Idempotent (ADR-184): no-op when key absent. The porcelain (slice 11)
returns the boolean `{ removed }` envelope; the primitive just does
the write (or skips it).

Tests:
- "Given `user.name` present and one call, Then the key line is
  gone."
- "Given `user.name` absent, Then the file text is unchanged AND no
  write happens (cache stays valid)." Spy assertion.
- "Given the key appearing twice (multi-valued) in the targeted
  scope, Then the primitive throws `configMultipleValues` with
  `requested: 'remove'`." (Mirrors the porcelain guard — the
  primitive enforces it to keep contracts identical per ADR-187.)
- "Given an invalid key, Then throws `CONFIG_KEY_INVALID`."

#### 9b — `unsetAllConfigEntries`

```typescript
export const unsetAllConfigEntries = async ({ ctx, key, scope }: ...): Promise<void>;
```

Composes the existing `removeConfigEntry` pure helper (which
already removes every occurrence, per its existing tests).

Tests:
- "Given `remote.origin.fetch` appearing three times, Then all three
  lines are gone."
- "Given the key absent, Then no I/O happens (idempotent)."
- "Given an invalid key, Then throws `CONFIG_KEY_INVALID`."

#### 9c — `renameConfigSection` (I/O wrapper)

```typescript
export const renameConfigSection = async ({
  ctx, oldName, newName, scope,
}: { ctx: Context; oldName: string; newName: string; scope?: ConfigScope }): Promise<void>;
```

`oldName` / `newName` are dotted forms (`'remote.origin'`).
Implementation: split on first `.` into `section` + `subsection`;
compose `renameConfigSectionInText`.

Tests:
- "Given `[remote \"origin\"]` block, When called with
  `oldName: 'remote.origin'`, `newName: 'remote.upstream'`, Then
  the section header is renamed."
- "Given a missing section, Then throws `configSectionNotFound`
  with the targeted scope."
- "Given `oldName` lacking a subsection (e.g. `'user'`), Then throws
  `INVALID_OPTION` (subsection rename is the only supported form;
  renaming a top-level section without subsection is a different
  use case that v1 doesn't expose)." Cross-check with canonical git
  behaviour — `git config --rename-section` rejects this.
- "Given a `newName` with a different section family (e.g.
  `oldName: 'remote.origin'`, `newName: 'branch.main'`), Then
  throws `INVALID_OPTION` (rename within the same section family
  only)." This guard exists in the existing pure helper; mirror at
  the I/O layer.

#### 9d — `removeConfigSection` (I/O wrapper)

```typescript
export const removeConfigSection = async ({
  ctx, sectionName, scope,
}: { ctx: Context; sectionName: string; scope?: ConfigScope }): Promise<void>;
```

`sectionName` dotted (`'remote.origin'`). Split → compose
`removeConfigSectionInText`.

Tests:
- "Given the section present, Then the block is removed."
- "Given the section absent, Then throws `configSectionNotFound`."
- One test per `INVALID_OPTION` reason on a malformed `sectionName`.

### Refactor

- Each sub-slice composes the slice-8 `readModifyWrite` helper.
- Extract the dotted-name → `{ section, subsection }` parse into a
  small helper (`parseSectionName(name)`) used by 9c and 9d.

### Verification

- `npm run validate`.

### Commit

`feat(config): I/O primitives — unset, unsetAll, renameSection, removeSection`

### Mutation-resistance notes

- The "missing key" branch in `unsetConfigEntry` is an early return
  with no write; spy on `fs.writeUtf8` to assert zero calls. The
  trivial mutant that always writes dies.
- The "wrong section family" guard in `renameConfigSection` needs a
  test per direction (`branch` → `remote`, `remote` → `branch`, ...).
- The `configSectionNotFound` factory's `scope` field is asserted
  per scope.

## Slice 10 — Porcelain read methods

**Dependencies:** Slices 3, 4, 6, 7.
**Parallel-safe?** Yes with slice 11 (read vs write); ship in one
commit for review-locality. The slice can ship before slice 11 if a
faster review cycle is preferred.

### Files to create

- `src/application/commands/config.ts` (NEW — exports all nine
  porcelain methods + types; see §9.1 of the design)
- `test/unit/application/commands/config.test.ts` (NEW)

### Public surface (read half)

```typescript
export const configGet = (ctx: Context, input: ConfigGetInput):
  Promise<ConfigGetResult | ConfigGetMissingResult>;

export const configGetAll = (ctx: Context, input: ConfigGetAllInput):
  Promise<ConfigGetAllResult>;

export const configGetRegexp = (ctx: Context, input: ConfigGetRegexpInput):
  Promise<ConfigGetRegexpResult>;

export const configList = (ctx: Context, input?: ConfigListInput):
  Promise<ConfigListResult>;
```

Each calls `assertRepository(ctx)` first, then composes the
primitive readers from slice 7.

### Red

For each method, GWT cases per §3 of the design:

`configGet`:
- "Given `user.name = Ada` in `local`, When `configGet({ key:
  'user.name' })` runs, Then `{ key, value: 'Ada', scope: 'local' }`."
- "Given the key absent, Then `{ key, value: undefined }` (no
  `scope` field)."
- "Given the key appearing twice in `local`, Then throws
  `configMultipleValues` with `requested: 'read'`, `count: 2`,
  `scope: 'local'`."
- "Given `scope: 'global'` on the input, Then only the global file
  is consulted (local values are ignored)."
- "Given a non-repository context, Then throws `NOT_A_REPOSITORY`."

`configGetAll`:
- "Given three `fetch` lines, Then `values` has length 3 in physical
  order."
- "Given the key in `global` and `local`, Then `values` is in
  precedence order (`global` first)."
- "Given the key absent, Then `values` is empty."

`configGetRegexp`:
- "Given `keyPattern: /^remote\\..*\\.url$/`, Then only matching
  entries are returned."
- "Given a `valuePattern: /^https:/`, Then both filters apply (AND)."
- "Given no matches, Then `entries` is empty."
- "Given a `RegExp` with the `i` flag, Then matching is case-
  insensitive (JS semantics — ADR-185)."

`configList`:
- "Given no scope, Then every entry across all active scopes is
  returned in precedence × physical order."
- "Given `scope: 'local'`, Then only local entries (in physical
  order)."
- "Given entries in sections the structured `readConfig` drops (e.g.
  `[gpg]`), Then they ARE returned (the porcelain doesn't filter)."

### Green

Each porcelain method:
1. `assertRepository(ctx)`.
2. Parse / validate inputs.
3. Compose the primitive reader.
4. Map / filter / transform per the design's §3 pseudocode.
5. Return the typed result envelope.

### Refactor

- `configGetRegexp` and `configList` call `qualifyKey` from slice 6's
  `internal/config-key.ts` directly — no extraction needed.

### Verification

- `npm run validate`.

### Commit

`feat(config): porcelain readers — get, getAll, getRegexp, list`

### Mutation-resistance notes

- Each method's `assertRepository` guard needs a test — kills the
  "drop the guard" mutant.
- The `requested: 'read'` literal on `configMultipleValues` is
  asserted exactly.
- `configList` returns entries in a specific order — assert the
  full array (not `toContain`).

## Slice 11 — Porcelain write methods

**Dependencies:** Slices 3, 4, 6, 7, 8, 9.
**Parallel-safe?** Yes with slice 10.

### Files to modify

- `src/application/commands/config.ts` (add five write methods)
- `test/unit/application/commands/config.test.ts` (extend)

### Public surface (write half)

```typescript
export const configSet = (ctx, input): Promise<ConfigSetResult>;
export const configUnset = (ctx, input): Promise<ConfigUnsetResult>;
export const configUnsetAll = (ctx, input): Promise<ConfigUnsetAllResult>;
export const configRenameSection = (ctx, input): Promise<ConfigRenameSectionResult>;
export const configRemoveSection = (ctx, input): Promise<ConfigRemoveSectionResult>;
```

### Red

`configSet`:
- "Given a fresh repo, When `configSet({ key: 'user.email',
  value: 'me@x.com' })` runs, Then `.git/config` has the entry and
  the result is `{ key, value, scope: 'local' }`."
- "Given an existing key, Then the value is overwritten and the
  result reflects the new value."
- "Given the key appearing twice in the targeted scope, Then throws
  `configMultipleValues` with `requested: 'overwrite'`, `count: 2`."
- "Given `scope: 'global'`, Then the result's `scope` field is
  `'global'`."
- "Given an invalid key, Then throws `configKeyInvalid`."
- "Given a value with `\\0`, Then throws `configValueInvalid`."
- "Given a value containing `#`, Then the call succeeds (writer
  quotes)."

`configUnset`:
- "Given the key present, Then the result is `{ key, scope:
  'local', removed: true, previousValue: '<old>' }`."
- "Given the key absent, Then `{ key, scope: 'local', removed:
  false }` (no `previousValue` field — assert with
  `not.toHaveProperty`)."
- "Given the key appearing twice, Then throws
  `configMultipleValues` with `requested: 'remove'`."

`configUnsetAll`:
- "Given the key absent, Then `{ removed: 0 }`."
- "Given the key appearing once, Then `{ removed: 1 }`."
- "Given the key appearing three times, Then `{ removed: 3 }` and
  the file no longer contains the key."

`configRenameSection`:
- "Given the section present, Then `{ oldName, newName, scope }`."
- "Given the section absent, Then throws `configSectionNotFound`."

`configRemoveSection`:
- "Given the section present, Then `{ name, scope }` and the file
  no longer contains the block."
- "Given the section absent, Then throws `configSectionNotFound`."

### Green

Each method:
1. `assertRepository(ctx)`.
2. Parse / validate inputs.
3. Compute the `targetScope = scope ?? 'local'`.
4. Pre-flight read for multi-valued guard / previous-value capture
   (only on `set` / `unset`).
5. Call the I/O primitive.
6. Return the typed result envelope.

### Refactor

- Extract the "pre-flight read of the single scope" pattern into a
  helper used by `set` and `unset` — `readSingleScopeSections(ctx,
  scope)` (lives in `internal/config-scope.ts`).

### Verification

- `npm run validate`.

### Commit

`feat(config): porcelain writers — set, unset, unsetAll, renameSection, removeSection`

### Mutation-resistance notes

- `removed: 0` vs `removed: 1` vs `removed: 3` — three separate
  tests asserting the exact number. Kills the `n` → `n + 1` mutant.
- `previousValue` presence/absence — use `not.toHaveProperty` for
  the absent case.
- Each `requested` discriminator literal is asserted in its own
  test.

## Slice 12 — Namespace assembly (`bindConfigNamespace`)

**Dependencies:** Slices 10, 11.
**Parallel-safe?** No — slice 13 binds the namespace into
`openRepository`.

### Files to create

- `src/application/commands/internal/config-namespace.ts` (NEW)
- `test/unit/application/commands/internal/config-namespace.test.ts`
  (NEW)

### Public API

```typescript
export interface ConfigNamespace {
  readonly get: (input: ConfigGetInput) => Promise<...>;
  readonly set: (input: ConfigSetInput) => Promise<...>;
  // ... nine methods total ...
}

export const bindConfigNamespace = (
  ctx: Context,
  guard: () => void,
): ConfigNamespace;
```

Implementation: returns `Object.freeze({...})` where each property
wraps `guard()` + the corresponding `commands.config<Verb>(ctx, ...)`
call (mirrors the flat-method binding pattern in `repository.ts`).

### Red

- "Given a bound namespace, When `get` is called, Then it calls
  `guard()` then forwards to `configGet(ctx, input)`." (Spy on
  both.)
- One test per method confirming the same: guard + forward.
- "Given a disposed ctx (guard throws `REPOSITORY_DISPOSED`), When
  any method is called, Then the underlying command is NOT called."
  Spy assertion.
- "Given the returned namespace, Then it is frozen
  (`Object.isFrozen` returns `true`)."

### Green

Standard binding pattern.

### Refactor

- Use a tiny helper (`bindGuarded(guard, fn)`) to avoid repetition
  if it fits.

### Verification

- `npm run validate`.

### Commit

`feat(config): bindConfigNamespace assembly`

### Mutation-resistance notes

- Each method's "guard called before forward" needs its own test;
  the `guard()`-before-`return` order matters and the inverse
  mutant must die.
- `Object.isFrozen` assertion kills the "skip freeze" mutant.

## Slice 13 — `Repository` interface + factory binding

**Dependencies:** Slice 12.
**Parallel-safe?** No — slice 14 onwards depends on the bound name.

### Files to modify

- `src/repository.ts` (add `readonly config: ConfigNamespace` to
  the interface; bind in the factory)
- `src/application/commands/index.ts` (re-export the porcelain
  types + functions + `bindConfigNamespace`)
- `src/index.ts` (already re-exports `./application/commands/index.js`
  via `export *` — no change needed unless we need to expose
  primitives readers, which slice 7 handles via the
  `application/primitives/index.ts` re-exports already picked up by
  `src/index.ts`'s primitives section)
- `test/unit/repository.test.ts` (extend — add a "given a fresh
  repo, then `repo.config.get / set / list / ...` are present and
  callable" suite)

### Red

- "Given `await openRepository(...)`, Then `repo.config` is a
  frozen object with nine methods."
- "Given a disposed repo, When `repo.config.get(...)` runs, Then
  throws `REPOSITORY_DISPOSED`."
- "Given a fresh repo, When `repo.config.set` then `repo.config.get`
  runs, Then the get returns the set value."

### Green

Add to the interface (slotted alphabetically, between `commit` and
`continueMerge`):

```typescript
readonly config: commands.ConfigNamespace;
```

Bind in the factory:

```typescript
config: commands.bindConfigNamespace(ctx, guard),
```

(no `as Repository['config']` cast needed — the binding helper
returns the exact `ConfigNamespace` shape.)

### Refactor

- Update the JSDoc on the `Repository` interface to mention the
  config namespace.

### Verification

- `npm run validate`.

### Commit

`feat(config): Repository.config namespace binding`

### Mutation-resistance notes

- The "disposed → throws" test on EACH method kills the "drop the
  guard from one method" mutant (since `bindConfigNamespace`
  applies the guard via a per-method wrapper).

## Slice 14 — Integration tests

**Dependencies:** Slice 13.
**Parallel-safe?** Yes with slices 15 / 16 (independent test
files).

### Files to create

- `test/integration/config-lifecycle.test.ts` (NEW)

### Tests

- **End-to-end `local` round-trip:** "Given a fresh repo, When
  `set → get → set → unsetAll → list` run in sequence, Then the
  final config matches the expected end state and intermediate
  values are observable per call."
- **`global` scope round-trip via memory adapter:** "Given a
  fake-home memory adapter and `scope: 'global'`, When `set` runs,
  Then the file at `xdgConfigHome()/git/config` (or
  `homedir()/.gitconfig`) contains the entry."
- **`worktree` scope with extension enabled:** "Given a `local`
  config with `extensions.worktreeConfig = true`, When `set({
  scope: 'worktree' })` then `get({ scope: 'worktree' })` runs,
  Then the round-trip succeeds."
- **`worktree` without extension:** "Given a local config WITHOUT
  the extension, When `set({ scope: 'worktree' })` runs, Then
  throws `configScopeNotAvailable` with `reason:
  'worktree-extension-unset'`."
- **Quoted-value round-trip:** "Given a value containing `#`, When
  `set` writes and `get` reads, Then the value round-trips byte-
  exact."
- **Precedence:** "Given the same key in `global` and `local` (via
  memory adapter), When `get` runs without `scope`, Then `local`
  wins."

### Verification

- `npm run validate`.

### Commit

`test(integration): config lifecycle — set/get/list/unset across scopes`

## Slice 15 — Parity tests vs canonical `git config`

**Dependencies:** Slice 13.
**Parallel-safe?** Yes with slice 14.

### Files to create

- `test/integration/config-porcelain-interop.test.ts` (NEW) — drives
  the porcelain against a real `git config` subprocess in a tmp
  repo.
- `test/parity/scenarios/config-crud.scenario.ts` (NEW) — exercises
  the porcelain across Node + Memory + Browser/OPFS via the
  existing `Scenario` harness (model the file on
  `remote-crud.scenario.ts`).
- `test/parity/scenarios/index.ts` (extend — register the new
  scenario).

### Interop test cases

Use the existing `interop-helpers.ts` (`makePeerPair`, `runGit`,
`GIT_AVAILABLE`). The env-isolation pattern (`feedback_isolate_git_subprocess_env`)
already lives in `runGit`.

- "Given tsgit `set` for `user.email`, When canonical `git config
  --local --get user.email` runs, Then the values match."
- "Given canonical `git config --local user.signingkey K`, When
  tsgit `get({ key: 'user.signingkey' })` runs, Then the value is
  `K`."
- "Given tsgit `unsetAll` for `remote.origin.fetch` and three
  pre-existing entries, When canonical `git config --local --get-all
  remote.origin.fetch` runs, Then it returns empty."
- "Given tsgit `renameSection({ oldName: 'remote.origin', newName:
  'remote.upstream' })`, When canonical `git config --local
  --get-regexp '^remote\\.upstream\\.'` runs, Then it returns the
  renamed entries."
- "Given tsgit `removeSection({ name: 'remote.origin' })`, When
  canonical `git config --local --get-regexp '^remote\\.origin\\.'`
  runs, Then it returns nothing."
- Per-scope precedence: "Given tsgit `set` in `local` and
  canonical-git `set` in `global` (a fake home dir via env),
  When tsgit `get` with no scope runs, Then `local` wins."

Documented-divergence note (in the test file's tsdoc):
`getRegexp` semantics differ from canonical `git config --get-regexp`
because tsgit uses native JS `RegExp` (POSIX ERE divergence per
ADR-185). The parity tests use patterns expressible in both grammars
(e.g. `^remote\\.origin\\.`); patterns that exercise the divergence
(`[:alnum:]`, BRE `\(...\)`) are NOT in scope.

### Scenario file

Model on `remote-crud.scenario.ts`:

```typescript
interface ConfigCrudResult {
  readonly afterSetLocal: string;     // value read back
  readonly afterUnsetMissing: boolean; // removed: false
  readonly afterUnsetPresent: boolean; // removed: true
  readonly afterUnsetAll: number;     // removed: N
  readonly listAfterAll: ReadonlyArray<string>; // keys in order
}
```

The scenario runs:
1. `set user.name = Ada` → assert local file present.
2. `set user.email = ada@x.com` → list contains both.
3. `set remote.origin.url = X`, repeated `set ... fetch = ...`
   thrice via `unsetAll + set` pattern to verify the
   multi-value handling.
4. `unset` a missing key (idempotent — assert `removed: false`).
5. `unset` a present key.
6. `unsetAll` the three fetch lines.
7. `removeSection` the `remote.origin` block.
8. Final `list` is empty modulo `user.*`.

### Verification

- `npm run validate`.
- Run the scenario across the three adapters (the harness does this
  automatically once registered).

### Commit

`test(parity): config CRUD scenario + canonical-git interop`

## Slice 16 — Browser-adapter degradation tests

**Dependencies:** Slices 5, 6, 13.
**Parallel-safe?** Yes with slices 14 / 15.

### Files to create

- `test/integration/config-browser-degradation.test.ts` (NEW)

OR fold into the existing browser test surface
(`test/browser/`) — pick the location that matches Phase 19.5a's
browser parity gating.

### Tests

- "Given a browser-adapter repo, When `repo.config.get({ scope:
  'global' })` runs, Then throws `configScopeNotAvailable` with
  `reason: 'browser-adapter'`."
- Same for `scope: 'system'`.
- Same for `set`, `unset`, `unsetAll`, `renameSection`,
  `removeSection`, `list`, `getAll`, `getRegexp` with `scope:
  'global'` and `scope: 'system'`.
- "Given a browser-adapter repo, When `repo.config.get({ key:
  'user.name' })` runs WITHOUT a `scope` argument, Then the merged
  read succeeds (silently skips `global`/`system`) and returns
  whatever is in `local`."
- "Given a browser-adapter repo, When `repo.config.set({ key:
  'user.name', value: 'X' })` runs (no scope → defaults to
  `local`), Then the call SUCCEEDS (local scope is always
  available in browser)."

### Verification

- `npm run validate`.

### Commit

`test(config): browser-adapter scope degradation`

## Slice 17 — FS validator extension

**Dependencies:** Slice 5 (the three new methods) + Slice 6 (the
scope resolver returns external paths).
**Parallel-safe?** No — must land BEFORE slice 13's Repository
binding can actually serve `global`/`system` reads/writes through
the validated FS.

### Files to modify

- `src/repository/wrap-fs-validator.ts` (extend to allow paths
  under `homedir()` and `systemConfigPath()`)
- `test/unit/repository/wrap-fs-validator.test.ts` (extend)

### Approach

The current validator confines every path to a single root
(`workDir`). Config global/system reads need paths OUTSIDE that
root.

Pick one of:

**Option A: per-call whitelist.** The validator gains a method
`allowExternalPath(absolutePath)` that the scope resolver calls
before each `fs.readUtf8`/`writeUtf8`. The whitelist is checked
in `guard()` — if `path` matches an allowed external path
verbatim (NOT a prefix), the path passes. The list is cleared on
each call (one-shot whitelist) to keep the trust window tight.

**Option B: multi-root.** The validator accepts an array of
allowed roots at construction time; the resolver passes
`homedir()` + `systemConfigPath()` at facade-creation. Issue:
the values aren't known at facade-creation because they come from
the FS adapter, which is the same object being wrapped — chicken
and egg.

**Option C: tag the FS adapter with a `config` capability.** The
validator gains a `forConfigOnly` method that returns a parallel
FS instance with the four scope paths pre-allowed; the scope
resolver uses that capability handle exclusively.

**Recommendation: Option C** — cleanest separation, keeps the
single-root invariant for every other code path, and matches the
ports/adapters style (a capability surfaces as a typed method, not
runtime state).

**Escalation candidate:** if the orchestrator + reviewer disagree
on A/B/C, surface as an ADR. Default (this plan): Option C unless
a reviewer in slice 6 of the review cycle prefers A.

### Red

- "Given a config-capability FS, When `readUtf8('${homedir()}/.gitconfig')`
  is called, Then it succeeds." (Memory adapter.)
- "Given a config-capability FS, When `readUtf8('/etc/passwd')` is
  called, Then it throws `pathspecOutsideRepo`." (No broad
  whitelisting — only the four scope paths.)
- "Given the standard (non-config) wrapped FS, When `readUtf8`
  against `homedir()` is called, Then it throws
  `pathspecOutsideRepo`." (Capability isolation.)

### Green

Implement per the chosen option.

### Verification

- `npm run validate`.

### Commit

`feat(repository): FS validator capability for config scope paths`

### Mutation-resistance notes

- The "allowed scope paths only" check needs per-scope tests
  (`global`, `system`, `worktree`-derived path) so the allowlist
  mutants die individually.
- Capability isolation test (standard FS rejects, config FS accepts)
  is mandatory — kills the "expand allowlist to standard FS" mutant.

## Slice 18 — Public exports verification

**Dependencies:** Slices 7, 13.
**Parallel-safe?** No (last code slice).

### Files to verify

- `src/application/primitives/index.ts` — exports the four renamed
  `*InText` helpers + `applyConfigOpInText` + the new readers
  (`readConfigSections`, `getConfigValue`, `getAllConfigValues`)
  + the new I/O primitives (`setConfigEntry`, `unsetConfigEntry`,
  `unsetAllConfigEntries`, `renameConfigSection`,
  `removeConfigSection`).
- `src/application/commands/index.ts` — exports the porcelain
  functions (`configGet`, `configSet`, ..., nine total) + the
  types (`ConfigKey`, `ConfigScope`, `ConfigEntryView`,
  `ConfigNamespace`, all input + result types) +
  `bindConfigNamespace`.
- `src/index.ts` — pulls in the above via the existing `export *`
  re-exports; verify no missing surface (the
  `test/unit/application/primitives/index.test.ts` ALLOWED_EXPORTS
  test catches missing or extra exports — extend it).

### Files to modify

- `test/unit/application/primitives/index.test.ts` — extend the
  allowed-exports list with the new names; sort + dedupe per
  existing convention.
- (Optional) `test/unit/application/commands/index.test.ts` — same
  shape if it exists; otherwise rely on
  `tooling/audit-browser-surface.ts` (per Phase 19.5a) to gate the
  surface.

### Red

- "Given the primitives index, Then exports include `setConfigEntry`,
  `unsetConfigEntry`, ... (one per new export)." Extend the existing
  `ALLOWED_EXPORTS` test.

### Green

Update the constant.

### Verification

- `npm run validate`.

### Commit

`feat(config): public export surface (primitives + porcelain)`

## Dependencies between slices

```
Slice 1 (rename)
  └── Slice 2 (writer quoting)
        ├── (parallel) Slice 3 (domain key parser)
        │     └── Slice 4 (errors)
        ├── Slice 5 (FS adapter caps)
        │     └── Slice 6 (scope resolver)
        │           └── Slice 7 (primitive readers)
        │                 └── Slice 8 (setConfigEntry I/O)
        │                       └── Slice 9 (unset/rename/remove I/O)
        │                             ├── Slice 10 (porcelain readers)
        │                             └── Slice 11 (porcelain writers)
        │                                   └── Slice 12 (namespace bind)
        │                                         └── Slice 17 (FS validator capability)
        │                                               └── Slice 13 (Repository binding)
        │                                                     ├── Slice 14 (integration)
        │                                                     ├── Slice 15 (parity + scenarios)
        │                                                     ├── Slice 16 (browser degradation)
        │                                                     └── Slice 18 (public exports)
```

Parallel-safe groupings (once the prerequisite slice lands):
- Slices 3+4 can ship in parallel with slice 5.
- Slices 10 and 11 are independent of each other (read vs write).
- Slices 14, 15, 16, 18 are independent test slices.

Sequencing constraints worth flagging to the orchestrator:
- **Slice 1 MUST land first.** Slices 8/9 depend on the freed names.
- **Slice 4 follows slice 3 in the same PR**, since slice 3's parser
  uses the slice-4 error factories (the plan keeps slice 3 first by
  inlining a placeholder factory; slice 4 swaps in the real one
  before review).
- **Slice 17 MUST land before slice 13.** Otherwise `global` /
  `system` reads will trip the path validator at runtime even though
  the unit tests pass.
- **Slice 9c's `INVALID_OPTION` checks must mirror the existing
  pure-text helper's checks** (cross-section rename rejection) — if
  the existing pure helper doesn't perform that check, surface as a
  finding for the existing primitive (slice 9c either adds the
  check at the I/O layer or escalates).

## Slice ordering recap (post-self-review)

Per the §slice-3 sequencing note, the parser and the errors are
co-located in one PR. The plan's commit order is:
1. Rename
2. Writer quoting
3. Domain parser (uses temporary inline factory)
4. Domain errors (refactor parser to use them)
5. FS adapter caps
6. Scope resolver (includes `collectValues` / `collectScopedValues`
   helpers)
7. Primitive readers
8. `setConfigEntry` I/O
9. Other I/O primitives
10. Porcelain readers
11. Porcelain writers
12. Namespace assembly
13. FS validator capability (per the constraint above this MUST
    land before Repository binding)
14. Repository binding
15. Integration tests
16. Parity tests + scenarios
17. Browser degradation tests
18. Public exports

(Slices 13 and 17 swap order vs the design's §14 list; the rationale
is the runtime validator constraint surfaced during planning.)

## Self-review log

### Pass 1 → Pass 2

- Slice 1 (rename) lifted to position 1 per the design's §14 slice
  6a sequencing note. The original §14 listed it as 6a; planning
  it as slice 1 means slices 8/9 (I/O primitives) ship under the
  freed names from day one — no rename churn under change.
- The `FS_OPERATION_NOT_SUPPORTED` vs `UNSUPPORTED_OPERATION`
  discrepancy between the design narrative and the codebase
  surfaced and is documented in the front-matter (uses existing
  `UNSUPPORTED_OPERATION`).
- Slice 3 / 4 sequencing note added: parser file needs the factory
  before it can throw; the two slices ship in one PR with a
  placeholder factory in slice 3 then refactored in slice 4.
- Slice 6 absorbed `collectValues` / `collectScopedValues` from
  the design's §9.1 — keeps them next to the scope resolver
  instead of duplicating across `internal/config-key.ts` and
  `config-read.ts`.
- Slice 17 (FS validator) lifted ahead of slice 13 (Repository
  binding) because the runtime validator will reject external
  scope paths until extended.

### Pass 2 → Pass 3

- Each slice's "Files to modify" lists absolute file paths under
  `src/` and `test/` — implementation subagent can act without
  re-reading the design.
- Mutation-resistance notes carry one-per-character isolation
  guidance on every regex / literal predicate (writer quoting,
  control-character validation, scope precedence ordering).
- Slice 12's `Object.isFrozen` assertion added — prevents the
  trivial "drop the freeze" mutant.
- Slice 17's three-options (A/B/C) decision is documented with a
  recommendation (Option C) and an escalation candidate — the
  implementation subagent has a default but knows to escalate if
  a reviewer pushes back.

### Pass 3 → converged

No further diffs. Stop.
