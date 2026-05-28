# Design — Phase 20.6 `config` Porcelain

**Status:** Draft (target: Accepted at `<sha-after-merge>`).

Backlog: **20.6** — _"`config` porcelain on `repo.*` (read/write
user-facing); promote primitive-tier `setConfigEntry`."_

ADRs (proposed, numbered after 180): 181 (single
`repo.config(action)` action-discriminator, mirroring ADR-175) · 182
(scope is `local` only in v1 — `system`/`global`/`worktree` deferred) ·
183 (multi-valued read shape — `get` rejects ambiguity with
`CONFIG_MULTIPLE_VALUES`, callers use `getAll`/`getRegexp`) · 184
(value coercion — v1 ships raw strings only; typed accessors deferred) ·
185 (primitive promotion — `setConfigEntry` family stays exported as a
tier-2 primitive AND the porcelain composes the new
`getConfigValue`/`getAllConfigValues` reads on top of `readConfig` +
`parseIniSections`) · 186 (key syntax — `<section>(.<subsection>)?.<name>`
parsed git-faithfully with case rules per ADR-082 reused unchanged).

## 1. Goal

Land Tier-1 porcelain for the user-facing half of `git config`. Six
actions sit behind one method on `repo.*`, mirroring the Phase 20.5
remote-CRUD shape exactly:

1. **`get <key>`** — read a single scalar entry. Throws
   `CONFIG_MULTIPLE_VALUES` when the key has more than one occurrence in
   the section (the canonical-git behaviour for multi-valued keys like
   `remote.<n>.fetch`).
2. **`getAll <key>`** — read every occurrence of a key as an ordered
   array. Empty array when the key is absent — matches `git config
   --get-all` returning a nonzero exit + nothing on stdout, the shape
   the structured port collapses to `[]`.
3. **`getRegexp <pattern> [valuePattern?]`** — read every entry whose
   fully-qualified key matches the regex; optionally filter on the
   value. Returns an ordered list of `{ key, value }` pairs.
4. **`set <key> <value>`** — replace the single value of `key`.
   Throws `CONFIG_MULTIPLE_VALUES` when the key is already multi-valued
   (canonical git: `error: cannot overwrite multiple values`).
5. **`unset <key>`** — remove the single value of `key`. Same
   ambiguity guard as `set`.
6. **`unsetAll <key>`** — remove every occurrence of `key` from the
   section (or no-op when absent).

Two list-style verbs ride along:

7. **`list`** — enumerate every `{ key, value }` in `.git/config`, in
   the file's physical order (matches `git config --list`).

`repo.config` is the only new bound name; ADR-181 captures the
action-discriminator choice.

`setConfigEntry` (and the rest of the existing `update-config.ts`
family — `setCoreConfigEntry`, `updateConfigEntries`,
`updateCoreConfig`, `updateConfigOperations`, `removeConfigEntry`,
`removeConfigSection`, `renameConfigSection`, `appendConfigEntry`,
`ConfigEntry`, `ConfigOperation`) **stay exported from
`src/application/primitives/index.ts`** and gain a sibling
`getConfigValue` / `getAllConfigValues` reader pair so a primitive-only
caller has both halves of the read/write surface without the porcelain
overhead. This is the same playbook Phase 20.2 used: every porcelain
sits on top of public primitives — never a private one (ADR-185).

### 1.1 Why now

Three downstream gaps make 20.6 a prerequisite:

- **Phase 21.1 (`pull`)** reads `branch.<X>.merge` and
  `branch.<X>.remote` to resolve the upstream — already wired inside
  `fetch`/`push`, but a programmatic caller composing those primitives
  has no public read path. `repo.config({ action: 'get', key:
  'branch.main.remote' })` is the missing public read.
- **Phase 21.3 (`stash`)** writes `stash.<key>` entries (`stash.useBuiltin`
  is the canonical knob); without a read surface tsgit can't even
  honour its own config knobs from user code.
- **CI/automation users** want a single porcelain to set `user.name` /
  `user.email` without learning the primitive layer. Today they have to
  call `repo.ctx.fs.writeUtf8` against `${gitDir}/config` (or build a
  primitive composition by hand) — both are pit-of-failure paths.

It also closes a self-referential v2 gap: tsgit has writers
(`updateConfigEntries`, `updateConfigOperations`) but no public
**reader** that surfaces a single value by key. `readConfig` returns the
known-section shape (`core` / `user` / `remote` / `branch` /
`extensions`) and DROPS every other entry — there is no public path to
read `gpg.program` or `commit.gpgsign` out of `.git/config`. 20.6 fixes
this by adding the raw read primitives the porcelain rides on
(`getConfigValue` / `getAllConfigValues`).

## 2. Out of scope (does NOT ship in 20.6)

Each deferral surfaces as an explicit ADR candidate in §10 so a future
reviewer (or a user demanding the missing verb) has a numbered slot.

- **`--show-origin` / `--show-scope`.** The result envelope intentionally
  omits the origin (which file the value came from) because v1 is
  `local`-only — every value comes from `${gitDir}/config`. Once
  `global` / `system` land the envelope grows additively. ADR-181 §3
  carves it out.
- **`global` / `system` / `worktree` scopes.** v1 reads and writes only
  `${gitDir}/config`. Rationale: every other scope requires a new
  adapter capability (resolve `$XDG_CONFIG_HOME`, locate
  `/etc/gitconfig`, follow `core.worktree` indirection). v1 keeps the
  surface honest with what `readConfig` already supports. ADR-182.
- **`includeIf` / `[include]` directives.** Conditional includes
  evaluate against a worktree's branch/remote at read time; tsgit's
  `parseIniSections` doesn't honour them, and adding the resolver pulls
  in a non-trivial chunk of canonical git's machinery. Deferred.
- **`--edit` (`$EDITOR`-spawn).** Plain-text editing belongs to a CLI,
  not a library port. Out forever.
- **`--type` / typed accessors (`bool` / `int` / `bool-or-int` /
  `path` / `expiry-date`).** v1 returns raw strings; callers coerce in
  user-land. ADR-184. The structured `ParsedConfig` already coerces
  `core.bare` etc. for the keys it knows about — we don't try to
  bridge the two.
- **`renameSection` / `removeSection` as `repo.config` actions.** Both
  are primitive-tier helpers used by `repo.remote`; surfacing them as
  porcelain verbs invites confusion ("when does the user need this?")
  — `repo.remote({ kind: 'rename' })` is the right porcelain entry.
  Defer.
- **`--default <value>` fallback.** Trivial in user-land
  (`(await repo.config({ action: 'get', key })) ?? 'fallback'`); no
  need to bake it in.
- **`--fixed-value` (literal-match `--unset` against a multi-valued
  key).** Used in scripts that filter `remote.<n>.fetch`; the equivalent
  in tsgit is `getRegexp` + `unsetAll` + re-set. Defer until a real
  caller surfaces.
- **`credential.*` interpretation.** Reading the bytes is in scope;
  evaluating credential helpers is not.
- **Atomic lock file (`config.lock`).** Canonical git writes via
  `.git/config.lock` then renames. tsgit's existing
  `updateConfigOperations` does a read-modify-write `writeUtf8` without
  a lock (ADR-074 accepted the trade-off). v1 inherits this. If a future
  audit pushes for it, the lock lands as a uniform refactor in
  `update-config.ts` — affects every config writer at once, not a
  20.6-only concern.

## 3. Surface

```typescript
// src/application/commands/config.ts

/** Fully-qualified git config key: `<section>(.<subsection>)?.<name>`. */
export type ConfigKey = string & { readonly __brand: 'ConfigKey' };

/** One physical `<key> = <value>` line in `.git/config`. */
export interface ConfigEntryView {
  readonly key: ConfigKey;
  readonly value: string;
}

export type ConfigAction =
  | { readonly kind: 'get'; readonly key: string }
  | { readonly kind: 'getAll'; readonly key: string }
  | {
      readonly kind: 'getRegexp';
      readonly keyPattern: string;
      readonly valuePattern?: string;
    }
  | { readonly kind: 'set'; readonly key: string; readonly value: string }
  | { readonly kind: 'unset'; readonly key: string }
  | { readonly kind: 'unsetAll'; readonly key: string }
  | { readonly kind: 'list' };

export type ConfigResult =
  | { readonly kind: 'get'; readonly value: string | undefined }
  | { readonly kind: 'getAll'; readonly values: ReadonlyArray<string> }
  | { readonly kind: 'getRegexp'; readonly entries: ReadonlyArray<ConfigEntryView> }
  | { readonly kind: 'set'; readonly key: ConfigKey; readonly value: string }
  | { readonly kind: 'unset'; readonly key: ConfigKey; readonly removed: boolean }
  | { readonly kind: 'unsetAll'; readonly key: ConfigKey; readonly removed: number }
  | { readonly kind: 'list'; readonly entries: ReadonlyArray<ConfigEntryView> };

export const config = (
  ctx: Context,
  action: ConfigAction,
): Promise<ConfigResult>;
```

Bound on the repository as a single flat method, mirroring `branch`,
`tag`, `sparseCheckout`, and the freshly-landed `remote`:

```typescript
await repo.config({ kind: 'get', key: 'user.email' });
await repo.config({ kind: 'getAll', key: 'remote.origin.fetch' });
await repo.config({ kind: 'getRegexp', keyPattern: '^remote\\..*\\.url$' });
await repo.config({ kind: 'set', key: 'user.email', value: 'me@example.com' });
await repo.config({ kind: 'unset', key: 'user.email' });
await repo.config({ kind: 'unsetAll', key: 'remote.origin.fetch' });
await repo.config({ kind: 'list' });
```

ADR-181 captures the choice. The action-discriminator continues the
established CRUD-family precedent (`branch` / `tag` / `sparseCheckout` /
`remote`); the merge-state-machine flat-method exception (Phase 20.4,
ADR-172) does not apply because `config` IS a CRUD family.

### 3.1 Why a single discriminator and not flat methods?

Considered. Rejected — `config` is the textbook discriminator-shape
case:

- Every action carries a `key` (the only exceptions are `getRegexp`,
  which carries `keyPattern`, and `list`, which carries nothing — the
  same shape `branch.list` and `remote.list` already exhibit).
- Result variants differ structurally per action (`value: string |
  undefined` for `get`; `values: ReadonlyArray<string>` for `getAll`;
  `entries` for `list` and `getRegexp`; `removed: boolean` /
  `removed: number` for the unset family). Optional fields on a unified
  result would force every caller to narrow at the use site anyway.
- The user discoverability cost is identical to `repo.remote` — the
  language server prompts on `repo.config({ kind: '`.

ADR-175's negatives apply unchanged here: a user typing `repo.config.`
sees no completions, the call-site noise of a literal `kind` field, etc.
The trade-off is identical and the precedent stands.

### 3.2 Why a `ConfigKey` brand?

The brand surfaces in result types (`set.key`, `unset.key`,
`unsetAll.key`, `list.entries[].key`, `getRegexp.entries[].key`) but
NOT in inputs (`action.key` is plain `string`). Rationale:

- Inputs come from user code; forcing a brand cast at every call site
  is ergonomic poison.
- Outputs come from `parseConfigKey` (§4.8) — guaranteed to satisfy
  the brand contract.

The brand prevents a result-shaped `key` from being passed as a remote
name / ref name / file path at the type level (these have their own
brands). It is purely a domain marker — no runtime check beyond
`parseConfigKey`.

## 4. Behaviour

### 4.1 `get { key }`

```
1. assertRepository(ctx);
2. const parsed = parseConfigKey(key);            // throws CONFIG_KEY_INVALID
3. const sections = await readConfigSections(ctx);
4. const matches = collectValues(sections, parsed);
5. if (matches.length === 0) return { kind: 'get', value: undefined };
6. if (matches.length > 1) throw configMultipleValues(key, matches.length, 'read');
7. return { kind: 'get', value: matches[0] };
```

- **Missing key → `value: undefined`.** Canonical `git config <key>`
  exits non-zero and prints nothing — the structured port collapses
  to `undefined`. Callers want to write
  `(await repo.config(...)).value ?? default` without an exception
  flow for the common case.
- **Multi-valued key → `CONFIG_MULTIPLE_VALUES`.** Canonical git
  prints `warning: <key> has multiple values` to stderr and exits
  non-zero. We elevate to a structured error — silently returning the
  last value (or the first) is the kind of footgun mutation testing
  catches and ADR-183 explicitly rules out.
- **No I/O beyond `readConfigSections(ctx)`.** The structured
  `readConfig` cache is NOT consulted because `ParsedConfig` is lossy
  (it drops every section the parser doesn't know about — `gpg`,
  `commit`, custom `[foo]`); the porcelain needs the raw ini
  sections. §5.2 captures the new cached
  `readConfigSections(ctx)` reader (sibling of `readConfig`).
- **Section/name case-insensitive; subsection case-sensitive.**
  Same casing rule `update-config.ts::matchesSection` already
  applies on the writer side. `collectValues` (§5.3) implements the
  reader-side equivalent against the parsed
  `ReadonlyArray<IniSection>`; the writer's matcher stays internal
  to `update-config.ts` (it operates on raw text lines, not parsed
  sections, so the two implementations have disjoint shapes — the
  shared rule is the casing semantic, not the function body).

### 4.2 `getAll { key }`

```
1. assertRepository(ctx);
2. const parsed = parseConfigKey(key);
3. const sections = await readConfigSections(ctx);
4. const matches = collectValues(sections, parsed);
5. return { kind: 'getAll', values: matches };
```

- **Ordered.** Physical order in `.git/config` — matches `git config
  --get-all`'s output order. The order is load-bearing for
  multi-valued keys like `remote.<n>.fetch` (where the first refspec
  is the default `+refs/heads/*:refs/remotes/<n>/*` and any subsequent
  entries are user-added).
- **Empty array for missing key.** Symmetric with `get` returning
  `undefined`; no exception for the common case.

### 4.3 `getRegexp { keyPattern, valuePattern? }`

```
1. assertRepository(ctx);
2. const keyRe = compileSafeRegex(keyPattern, 'key');
3. const valueRe = valuePattern !== undefined ? compileSafeRegex(valuePattern, 'value') : undefined;
4. const sections = await readConfigSections(ctx);
5. const entries: ConfigEntryView[] = [];
6. for (const section of sections) {
7.   for (const { key, value } of section.entries) {
8.     const fq = qualifyKey(section, key);          // e.g. 'remote.origin.url'
9.     if (!keyRe.test(fq)) continue;
10.    if (valueRe !== undefined && !valueRe.test(value)) continue;
11.    entries.push({ key: fq as ConfigKey, value });
12.  }
13. }
14. return { kind: 'getRegexp', entries };
```

- **JavaScript regex semantics.** Canonical git uses POSIX extended
  regex (BRE/ERE). Documenting the divergence: tsgit uses JS regex
  (`RegExp`); a user moving canonical-git patterns over MUST adjust
  POSIX-specific escapes. This is the smallest legitimate divergence
  (writing a POSIX regex engine in TS to ship one porcelain verb is
  out of scope — Q.6 surfaces it for ADR judgment).
- **ReDoS guard.** No shared `compileSafeRegex` helper exists today
  (`compilePathspec` solves the problem differently — by emitting a
  provably linear glob matcher, ADR-077, never a `RegExp`). 20.6
  introduces a small `compileSafeRegex(pattern, field)` in
  `src/application/commands/internal/safe-regex.ts` with two simple
  rejections: (a) pattern length > 1024 chars → `'too-long'`;
  (b) `new RegExp(pattern)` throws (malformed source) → `'malformed'`.
  A `'redos'` rejection slot is reserved on the error data shape but
  not yet wired: a worst-case backtracking detector is a non-trivial
  engineering task; the length cap is the v1 mitigation. If a real
  pathological pattern surfaces, the slot already exists for the
  follow-up. Throws `CONFIG_REGEX_INVALID` on rejection.
- **Fully-qualified key for matching.** We test the regex against the
  three-part `<section>.<subsection>.<name>` string (omitting the
  middle for subsection-less sections). This matches canonical git's
  `--get-regexp` behaviour.
- **Entries returned in physical order across all sections.** Same
  rationale as `getAll`.

### 4.4 `set { key, value }`

```
1. assertRepository(ctx);
2. const parsed = parseConfigKey(key);
3. assertValueSafe(value);                      // INVALID_OPTION on \n / \r / \0
4. const sections = await readConfigSections(ctx);
5. const matches = collectValues(sections, parsed);
6. if (matches.length > 1) throw configMultipleValues(key, matches.length, 'overwrite');
7. await updateConfigOperations(ctx, [
8.   { kind: 'set', section: parsed.section, subsection: parsed.subsection,
9.     key: parsed.name, value },
10. ]);
11. return { kind: 'set', key: key as ConfigKey, value };
```

- **Reuses `updateConfigOperations`** — one writer for the whole
  config surface (the same `updateConfigOperations` Phase 20.5 already
  composes for `remote` CRUD). Atomic on disk (single `writeUtf8`),
  invalidates the read cache via the existing `invalidateConfigCache`
  hook.
- **Multi-valued guard.** Canonical git's `git config <key> <value>`
  prints `warning: cannot overwrite multiple values with a single
  value` and exits non-zero. We elevate to `CONFIG_MULTIPLE_VALUES`
  (same code as `get`) with a `requested: 'overwrite'` discriminator
  on the data — see §4.9.
- **No `--add` semantics on `set`.** Canonical git's `git config
  --add <key> <value>` always appends. The 20.6 surface has no `add`
  action — `unsetAll` then a sequence of `set` calls is the closest
  composition. Q.5 in §10 captures the deferral.
- **Value safety.** Newlines / carriage returns / NULs are
  line-surgery hazards (ADR-082 already rejects them inside
  `setConfigEntry`). The porcelain inherits the existing
  `rejectControlChars` guard via the primitive — no new check.

### 4.5 `unset { key }`

```
1. assertRepository(ctx);
2. const parsed = parseConfigKey(key);
3. const sections = await readConfigSections(ctx);
4. const matches = collectValues(sections, parsed);
5. if (matches.length > 1) throw configMultipleValues(key, matches.length, 'remove');
6. if (matches.length === 0) return { kind: 'unset', key: key as ConfigKey, removed: false };
7. await updateConfigOperations(ctx, [
8.   { kind: 'removeEntry', section: parsed.section, subsection: parsed.subsection,
9.     key: parsed.name },
10. ]);
11. return { kind: 'unset', key: key as ConfigKey, removed: true };
```

- **No-op when absent.** Canonical git's `git config --unset
  nonexistent` exits non-zero (code 5). We collapse to a structured
  `removed: false` — the call succeeded structurally, the boolean
  reports the effect. Q.4 in §10 surfaces this for ADR judgment
  (rejected-by-canonical-git-exit-code vs idempotent-tsgit-shape).
- **Multi-valued guard.** Same precedent — canonical git refuses
  `--unset` on a multi-valued key (`warning: <key> has multiple
  values`).

### 4.6 `unsetAll { key }`

```
1. assertRepository(ctx);
2. const parsed = parseConfigKey(key);
3. const sections = await readConfigSections(ctx);
4. const matches = collectValues(sections, parsed);
5. if (matches.length === 0) return { kind: 'unsetAll', key: key as ConfigKey, removed: 0 };
6. await updateConfigOperations(ctx, [
7.   { kind: 'removeEntry', section: parsed.section, subsection: parsed.subsection,
8.     key: parsed.name },
9. ]);
10. return { kind: 'unsetAll', key: key as ConfigKey, removed: matches.length };
```

- **`removeEntry` already removes every occurrence** of the key in the
  matched section — its existing semantics are "git config
  --unset-all"-shaped (see the JSDoc on `removeConfigEntry`).
- **`removed: number` instead of `boolean`** so the caller distinguishes
  "removed three duplicate entries" from "removed one canonical
  entry". Tracked by mutation tests (§6.8).

### 4.7 `list`

```
1. assertRepository(ctx);
2. const sections = await readConfigSections(ctx);
3. const entries: ConfigEntryView[] = [];
4. for (const section of sections) {
5.   for (const { key, value } of section.entries) {
6.     entries.push({ key: qualifyKey(section, key) as ConfigKey, value });
7.   }
8. }
9. return { kind: 'list', entries };
```

- **Physical order preserved.** `parseIniSections` returns sections in
  file order; entries within each section also in file order. Matches
  `git config --list`.
- **Includes every section** — `core`, `user`, `remote`, `branch`,
  `extensions`, and every section the structured `readConfig`
  currently drops (`gpg`, `commit`, `pull`, custom `[foo]`, …).

### 4.8 Key syntax and parsing (`parseConfigKey`)

Mirrors canonical git's `git_config_parse_key`:

- `<section>.<name>` — two-part form, no subsection.
- `<section>.<subsection>.<name>` — three-part form. The middle
  segment is the subsection, taken verbatim between the first and
  the last `.`. So `remote.my.fork.url` parses as
  `section='remote'`, `subsection='my.fork'`, `name='url'`. Canonical
  git's parser matches this rule.

Key syntax rules (ADR-186):

- **Section name:** `[A-Za-z0-9-]+` (canonical git), case-insensitive
  (lower-cased internally for matching).
- **Name (the trailing `<name>` segment):** `[A-Za-z0-9-]+` starting
  with a letter, per canonical git's
  `git_config_parse_key_1`. Lower-cased for matching.
- **Subsection:** any byte except `\n`, `\r`, `\0`, `"`, `\\`, `]` —
  matches the existing `rejectSubsection` guard in `update-config.ts`.
  Case-sensitive (per `update-config.ts::matchesSection`).
- **No subsection AND no name** — throws `CONFIG_KEY_INVALID` with
  `reason: 'missing-name'`.
- **Empty section** — throws with `reason: 'empty-section'`.
- **Forbidden character in section/name** — throws with
  `reason: 'bad-character'` and `position: <0-based index>`.

```typescript
// src/domain/commands/config-key.ts  (NEW — pure domain)
export interface ParsedConfigKey {
  readonly section: string;        // lower-cased
  readonly subsection: string | undefined;
  readonly name: string;           // lower-cased
}

export const parseConfigKey = (raw: string): ParsedConfigKey;
export const qualifyKey = (section: IniSection, rawName: string): string;
```

`qualifyKey` is the inverse — given a parsed section header and a key
line, render the canonical fully-qualified key for `list` / `getRegexp`
output. Lower-cases the section + name; preserves the subsection
verbatim (case-sensitive).

### 4.9 Error model

Three new domain codes land alongside the existing `INVALID_OPTION`
(reused for value-side `\n` / `\r` / `\0` rejection — the same path
`remote.add` uses):

```typescript
| { readonly code: 'CONFIG_KEY_INVALID';
    readonly key: string;
    readonly reason: 'empty-section' | 'missing-name' | 'bad-character';
    readonly position?: number }
| { readonly code: 'CONFIG_MULTIPLE_VALUES';
    readonly key: string;
    readonly count: number;
    readonly requested: 'read' | 'overwrite' | 'remove' }
| { readonly code: 'CONFIG_REGEX_INVALID';
    readonly pattern: string;
    readonly reason: 'too-long' | 'malformed' | 'redos' }
```

Factory functions (`configKeyInvalid`, `configMultipleValues`,
`configRegexInvalid`) follow the same pattern as `remoteExists`.

The `requested` discriminator on `CONFIG_MULTIPLE_VALUES` lets a
caller distinguish "you tried to read an ambiguous value" from "you
tried to overwrite it" from "you tried to unset it" — different recovery
paths.

### 4.10 Validation

Pre-write validation (all three throw before the lock is taken so
state never deviates from `parse → check → write`):

- `parseConfigKey(key)` — see §4.8. Throws `CONFIG_KEY_INVALID`.
- `assertValueSafe(value)` for `set` — throws `INVALID_OPTION` on
  `\n` / `\r` / `\0`. Reuses the existing
  `update-config.ts::rejectControlChars('value', value)` indirectly
  (called by `setConfigEntry`); the porcelain calls the same guard
  early so the error surfaces before any I/O.
- `compileSafeRegex(pattern, field)` for `getRegexp` — see §4.3.
  Throws `CONFIG_REGEX_INVALID`.
- `multi-valued` checks for `get` / `set` / `unset` — see §4.4–§4.6.

The slash rule that protects remote names (§4.7 of Phase 20.5) does
**not** apply to config keys: `gpg.format` and `gpg.<key>.program`
must work; `/` is not a valid character in section / name per
canonical git's parser, so it never appears in legitimate input
anyway. The parser rejects it via the `[A-Za-z0-9-]+` rule with
`reason: 'bad-character'`.

### 4.11 File-format faithfulness

The line-surgery family already preserves:

- **Comments** (`#` and `;` — `stripInlineComment` honours them on
  read; writes never touch them).
- **Indentation** — `renderEntry` emits `\t<key> = <value>` (tab),
  matching canonical git's `git config --add`.
- **Section order** — `parseIniSections` walks in file order;
  `setConfigEntry` inserts new sections at the END of the file
  (matching canonical git's "create-at-end" behaviour on first write).
- **Empty sections** — `removeConfigEntry` leaves a section header
  with no entries (canonical git does the same; the user can clean
  up by hand or via a future `removeSection` porcelain).
- **Multi-line / backslash continuations** — `parseIniSections`
  joins them on read. Writes emit single-line values (canonical git
  wraps long values lazily; we don't — see Q.7 in §10).
- **Quoted values** — currently NOT preserved on write. The
  primitive's `renderEntry` emits the value as a plain `value`
  string. Canonical git quotes values containing `;` / `#` / leading
  whitespace. v1 deliberately doesn't (the
  `assertValueSafe`-survivable subset is `\n`-free / `\r`-free /
  `\0`-free strings; everything else round-trips), but Q.8 in §10
  surfaces a real corner case: a value containing `#` is written
  raw, then read back as a truncated value because `stripInlineComment`
  ate it. This is an existing bug in `update-config.ts`, surfaced now
  that 20.6 ships a public `set`. The doc proposes a v1 fix:
  `assertValueSafe` adds `#` and `;` to the rejection set with a
  documented mitigation (the user should not write those characters
  in a config value); alternatively, the writer learns to quote.

Q.8 carries the open ADR. The conservative bias: **reject** `#` /
`;` / leading whitespace in `set`'s value, document the limit, defer
quoting to a follow-up. Reasoning: rejecting at write is conservative
(no silent corruption); accepting them and quoting only on output
risks a parse-rewrite asymmetry where the user's `set('foo', '#bar')`
disappears on the next `get`.

### 4.12 Concurrency

Same posture as 20.5: no `config.lock`. The read-modify-write
sequence inside `updateConfigOperations` is atomic with respect to a
single-process Context (the existing per-Context single-thread
invariant). Concurrent external writers (e.g. a parallel `git`
subprocess) race last-writer-wins, matching ADR-074 + ADR-082's
documented behaviour.

If a future audit requires `.git/config.lock`, the lock lands inside
`updateConfigOperations` and benefits every config writer
simultaneously (remote CRUD + sparse-checkout writes + 20.6 config
porcelain) — not a 20.6-only concern.

### 4.13 Hooks

None. Canonical git's `git config` runs no hooks.

### 4.14 Reflog

None. Config writes do not advance any ref.

### 4.15 Scope (`local` only in v1)

Every action reads/writes `${gitDir}/config`. No global / system /
worktree path. ADR-182 captures.

A future scope-extension lands additively:

```typescript
// Hypothetical follow-up shape (NOT in v1)
| { readonly kind: 'get'; readonly key: string;
    readonly scope?: 'local' | 'global' | 'system' | 'all' }
```

The current `local`-only behaviour stays the default; the `scope`
option is optional so v1 code keeps compiling. The reader contract
extends to merge multiple files in priority order (system → global
→ local → worktree, matching `git config --get`'s search order).

## 5. Module layout

```
src/application/commands/
├── config.ts                                # NEW — porcelain dispatcher
├── internal/
│   ├── config-key.ts                        # NEW — qualifyKey, collectValues,
│   │                                        #   re-export of parseConfigKey
│   └── safe-regex.ts                        # NEW — compileSafeRegex
├── index.ts                                 # extended: export config

src/domain/commands/
├── config-key.ts                            # NEW — ParsedConfigKey, pure domain
└── error.ts                                 # extended:
                                              #   CONFIG_KEY_INVALID
                                              #   CONFIG_MULTIPLE_VALUES
                                              #   CONFIG_REGEX_INVALID

src/application/primitives/
├── config-read.ts                           # extended:
│                                            #   getConfigValue(ctx, key)
│                                            #   getAllConfigValues(ctx, key)
│                                            #   readConfigSections(ctx) (cached)
└── update-config.ts                         # untouched
                                              #   (`setConfigEntry` family
                                              #    re-exported as-is)

src/repository.ts                            # extended: bind config
src/index.ts                                 # (re-export — unchanged)

test/unit/application/commands/
├── config.test.ts                           # NEW — per-action GWT cases
└── internal/
    ├── config-key.test.ts                   # NEW — parser/qualifier
    ├── config-key.properties.test.ts        # NEW — property-based key parse
    └── safe-regex.test.ts                   # NEW — regex length / syntax guard
test/unit/domain/commands/
└── config-key.test.ts                       # NEW — pure-domain parse rules
test/unit/application/primitives/
└── config-read.test.ts                      # extended: new read primitives
test/integration/
└── config-lifecycle.test.ts                 # NEW — round-trip set→get→list→unset
test/parity/scenarios/
└── config-crud.scenario.ts                  # NEW — Node + Memory + OPFS
```

### 5.1 Why a new module rather than extending an existing one?

- `config.ts` is the natural Tier-1 home — sibling of `branch.ts`,
  `tag.ts`, `remote.ts`. Same one-file-per-CRUD-family pattern.
- `internal/config-key.ts` lives under `commands/internal/` because
  both the porcelain (`config.ts`) and a future scope-extension share
  it; `update-config.ts` already has its own `matchesSection` for the
  reverse direction (line-line surgery), so we don't merge the two.
- The domain key parser (`src/domain/commands/config-key.ts`) is
  separated from the application-layer extractor because it is a pure
  syntactic check — no Context, no I/O. Same precedent
  `domain/refs/ref-validation.ts` already follows.

### 5.2 New primitive readers — `getConfigValue` / `getAllConfigValues` / `readConfigSections`

`readConfig` returns `ParsedConfig` (the structured-but-lossy shape).
20.6 needs a raw read path:

```typescript
// src/application/primitives/config-read.ts (extended)

/**
 * Read every section as a flat array, cached per-Context the same way
 * `readConfig` is. The porcelain composes on top of this.
 */
export const readConfigSections = (
  ctx: Context,
): Promise<ReadonlyArray<IniSection>>;

/**
 * Return the single string value for `key`, or `undefined` when absent.
 * Throws `CONFIG_MULTIPLE_VALUES` when the key has multiple
 * occurrences. Pure read — no porcelain side-effects.
 */
export const getConfigValue = (
  ctx: Context,
  key: string,
): Promise<string | undefined>;

/**
 * Return every value for `key` in physical order. Empty array when
 * absent. Never throws on multi-value.
 */
export const getAllConfigValues = (
  ctx: Context,
  key: string,
): Promise<ReadonlyArray<string>>;
```

Both readers compose on top of `readConfigSections(ctx)` and reuse the
existing per-Context `WeakMap` cache (with a sibling key for the
sections result, so `readConfig` and `readConfigSections` cohabit). The
existing `invalidateConfigCache(ctx)` clears both at once — the writers
in `update-config.ts` keep their existing `invalidateConfigCache` call;
no churn at the writer side.

ADR-185 captures the promotion playbook: the existing
`setConfigEntry` is re-exported unchanged AND the new
`getConfigValue` / `getAllConfigValues` ship alongside it. A
primitive-only caller (e.g. a CLI implementer) gets the full
read/write surface without the porcelain envelope.

### 5.3 `internal/config-key.ts` (application-layer)

Three helpers, all pure:

```typescript
export const parseConfigKey = (raw: string): ParsedConfigKey;
export const qualifyKey = (section: IniSection, rawName: string): string;

/**
 * Collect every value of `parsed.key` from `sections` in physical order.
 * Case-insensitive section/name match, case-sensitive subsection match —
 * the same casing rule `update-config.ts::matchesSection` applies on
 * the writer side (the two functions operate on disjoint inputs:
 * parsed `IniSection` vs. raw text lines; the shared rule is the
 * semantic, not the implementation).
 */
export const collectValues = (
  sections: ReadonlyArray<IniSection>,
  parsed: ParsedConfigKey,
): ReadonlyArray<string>;
```

`parseConfigKey` re-exports the pure-domain function from
`src/domain/commands/config-key.ts` — the application layer adds the
case-folding rules that depend on the application-side matcher
behaviour (and so logically live next to it).

### 5.4 Repository binding

`Repository.config` joins the alphabetised tier-1 list:

```typescript
readonly config: BindCtx<typeof commands.config>;
```

bound in the factory with the standard `guard()` + `commands.config`
glue (same shape `commands.remote` already uses).

`src/application/commands/index.ts` re-exports:

```typescript
export {
  type ConfigAction,
  type ConfigEntryView,
  type ConfigKey,
  type ConfigResult,
  config,
} from './config.js';
```

`src/application/primitives/index.ts` extended:

```typescript
export {
  getConfigValue,
  getAllConfigValues,
  invalidateConfigCache,
  readConfig,
  readConfigSections,
} from './config-read.js';
```

(The `setConfigEntry` family stays exported exactly as today.)

## 6. Testing strategy

### 6.1 Unit — `config.test.ts`

GWT split per existing test conventions, AAA bodies, `sut` variable.
Cases per action below; the per-character key-validator cases live in
`config-key.test.ts` (§6.3).

**`get`:**
- "Given a non-repo, When get runs, Then throws NOT_A_REPOSITORY".
- "Given an absent key, When get runs, Then value is undefined".
- "Given a single-valued key, When get runs, Then value equals the
  stored value".
- "Given a multi-valued key, When get runs, Then throws
  CONFIG_MULTIPLE_VALUES with `count: 2`".
- "Given a key with a subsection (`remote.origin.url`), When get
  runs, Then value matches".
- "Given a key with a dotted subsection (`remote.my.fork.url`), When
  get runs, Then it parses as subsection=`my.fork`".
- "Given a key with mixed case (`USER.email`), When get runs, Then
  it case-insensitively matches `user.email`".

**`getAll`:**
- "Given an absent key, When getAll runs, Then values is empty".
- "Given a key with three occurrences, When getAll runs, Then values
  carries all three in physical order".
- "Given a multi-valued key (`remote.origin.fetch`), When getAll
  runs, Then it returns the refspecs in file order".

**`getRegexp`:**
- "Given no entries, When getRegexp runs, Then entries is empty".
- "Given a `^remote\\..*\\.url$` pattern, When getRegexp runs over a
  three-remote config, Then it returns three entries".
- "Given a `keyPattern` and a `valuePattern`, When getRegexp runs,
  Then only entries matching both are returned".
- "Given a pattern with 2048 characters, When getRegexp runs, Then
  throws CONFIG_REGEX_INVALID with `reason: 'too-long'`".
- "Given a malformed pattern (`[unclosed`), When getRegexp runs, Then
  throws CONFIG_REGEX_INVALID with `reason: 'malformed'`".

**`set`:**
- "Given an absent key, When set runs, Then the entry is written and
  result.value matches".
- "Given an existing single-valued key, When set runs, Then the
  value is replaced (not appended)".
- "Given a multi-valued key, When set runs, Then throws
  CONFIG_MULTIPLE_VALUES with `requested: 'overwrite'`".
- "Given a value containing a newline, When set runs, Then throws
  INVALID_OPTION".
- "Given a value containing `#`, When set runs, Then throws
  INVALID_OPTION" (per the §4.11 conservative cut — Q.8).
- "Given a section-less key (`bare-name`), When set runs, Then
  throws CONFIG_KEY_INVALID with `reason: 'missing-name'`".
- "Given a bare repo, When set runs, Then it succeeds" (config writes
  work in bare repos).

**`unset`:**
- "Given an absent key, When unset runs, Then removed is false".
- "Given a single-valued key, When unset runs, Then the entry is
  gone and removed is true".
- "Given a multi-valued key, When unset runs, Then throws
  CONFIG_MULTIPLE_VALUES with `requested: 'remove'`".

**`unsetAll`:**
- "Given an absent key, When unsetAll runs, Then removed is 0".
- "Given a single-valued key, When unsetAll runs, Then removed is 1".
- "Given a multi-valued key with three entries, When unsetAll runs,
  Then all three are gone and removed is 3".

**`list`:**
- "Given an empty config, When list runs, Then entries is empty".
- "Given a single-key config, When list runs, Then the entry is
  returned with the fully-qualified key".
- "Given multiple sections, When list runs, Then entries come back
  in physical file order".
- "Given a section the structured `readConfig` ignores (`gpg`), When
  list runs, Then it surfaces every entry".

### 6.2 Unit — `config-read.test.ts` extensions

Per CLAUDE.md "Mutation-Resistant Test Patterns":

- `getConfigValue` with single-valued / absent / multi-valued.
- `getAllConfigValues` with empty / 1 / N occurrences.
- `readConfigSections` cache HIT on second call (Context identity),
  cache MISS after `invalidateConfigCache`.

### 6.3 Unit — `config-key.test.ts` (application layer)

- `parseConfigKey('section.name')` → `{ section: 'section', subsection:
  undefined, name: 'name' }`.
- `parseConfigKey('section.SUB.name')` → subsection literal
  `'SUB'` (case-preserved).
- `parseConfigKey('remote.my.fork.url')` → `subsection: 'my.fork'`.
- `parseConfigKey('USER.email')` → lower-cased section AND name.
- Each forbidden character in section or name in isolation throws
  `CONFIG_KEY_INVALID` (mutation-resistance — one test per
  character, kills the StringLiteral mutants on the validator
  regex per CLAUDE.md).
- `parseConfigKey('.name')` → `reason: 'empty-section'`.
- `parseConfigKey('section.')` → `reason: 'missing-name'`.
- `parseConfigKey('')` → `reason: 'empty-section'`.
- `qualifyKey({ section: 'remote', subsection: 'origin' }, 'URL')` →
  `'remote.origin.url'` (lower-cased section AND name, subsection
  case-preserved).
- `collectValues` — empty sections, single match, three matches in
  one section, matches split across two sections with the same
  subsection, no matches because subsection casing differs.

### 6.4 Unit — `domain/commands/config-key.test.ts` (pure domain)

- Pure parse rules without any Context dependency.
- One test per `reason` of `CONFIG_KEY_INVALID`.

### 6.5 Property tests — `config-key.properties.test.ts`

The four-lens check from CLAUDE.md applies:

1. **Round-trip pair.** `parseConfigKey(qualifyKey(parse(x))) === parse(x)`
   for every key in the safe subset (ASCII section + name, subsection
   excluding forbidden chars). Round-trip property at `numRuns: 200`.
2. **Compositional matcher / aggregator.** `collectValues` over a
   freshly generated sections array: appending a matching entry
   increments the returned array length by one; appending a
   non-matching entry leaves it unchanged. `numRuns: 100`.
3. **Total function.** `parseConfigKey` rejects no input in the
   declared safe subset (`[a-zA-Z0-9-]+\.[a-zA-Z0-9-]+`) — never
   throws. `numRuns: 100`.
4. **Idempotence.** Two calls to `parseConfigKey` on the same input
   return deeply-equal results. `numRuns: 50`.

Property tests live in `*.properties.test.ts` next to the example
tests, with shared `arbitraries.ts` if the generator base grows.

### 6.6 Integration — `config-lifecycle.test.ts`

End-to-end without a network:

- "Given a fresh repo, When set → get → set → unset → list run in
  sequence, Then the final config matches the expected end state".
- "Given a set call, When `.git/config` is read back with `git config
  --get` as a subprocess, Then the value matches" (cross-tool
  parity, env scrubbed per `feedback_isolate_git_subprocess_env`).
- "Given a `set` of an existing key, When the resulting file is
  inspected, Then unrelated sections and comments are preserved
  byte-for-byte".

`@proves` surface: `repo.config` — `config-crud` bucket.

### 6.7 Parity — `config-crud.scenario.ts`

Drives the seven actions through a `Scenario<TResult>` that lands on
Node + Memory + Browser/OPFS via the existing harness. Captures one
load-bearing golden: the final `.git/config` text after a
`set` → `unset` → `unsetAll` sequence to lock the line-surgery
preservation.

### 6.8 Mutation

Stryker on:

- `src/application/commands/config.ts`
- `src/application/commands/internal/config-key.ts`
- `src/domain/commands/config-key.ts`
- The new exports inside `src/application/primitives/config-read.ts`
  (`getConfigValue` / `getAllConfigValues` / `readConfigSections`).

Target: 0 new killable survivors. Per CLAUDE.md "Mutation-Resistant
Test Patterns":

- Error assertions are specific — `try/catch` + `.data.code` +
  `.data.reason` for every thrown error (never bare `toThrow(TsgitError)`).
- Per-character validator tests live one-per-character so the
  StringLiteral mutants on the regex are killed individually.
- `removed: number` is asserted as the exact count (not `>= 1`) so
  the `n` → `n + 1` mutant is killed.
- `count` on `CONFIG_MULTIPLE_VALUES` is asserted as the exact
  occurrence count for the same reason.
- The `requested` discriminator on `CONFIG_MULTIPLE_VALUES` is
  asserted per call site (read / overwrite / remove).

### 6.9 Browser-surface coverage

Phase 19.5a gates `repo.*` names against parity scenarios + allowlist.
`repo.config` is the new name; the bundled `config-crud.scenario.ts`
(see §6.7) closes the gap. No allowlist entry needed.

## 7. Performance posture

- `get` / `getAll` / `getRegexp` / `list` all cost a single
  `readConfigSections(ctx)` (cached) plus a linear walk through the
  sections. O(N) over the total entry count. Same shape as
  `readConfig`'s walk.
- `set` / `unset` / `unsetAll` each cost one read + one
  line-surgical write via `updateConfigOperations`. The cache
  invalidation already exists; no new I/O.
- The cache HIT path is one `WeakMap` lookup — same constant cost as
  `readConfig` today. The MISS path is one `readUtf8` +
  `parseIniSections` parse.

No new bench scenario this phase; Phase 26 will measure if `list`
becomes a hot path (it shouldn't — config files are tiny).

## 8. Security posture

- **Key syntax rejection** (§4.8) — no path-like, no control char, no
  quote-busting subsection. The line-surgery family already
  forbids the writer-side characters; the porcelain forbids the same
  set at the reader side via `parseConfigKey`.
- **Value safety** — `\n` / `\r` / `\0` / `#` / `;` / leading
  whitespace rejected at the porcelain layer (`assertValueSafe`)
  before any I/O. The writer's `rejectControlChars('value', value)`
  is the secondary line of defence.
- **Regex ReDoS** — `compileSafeRegex` (length cap + syntax check;
  see §4.3) rejects oversized and malformed patterns. A worst-case
  backtracking detector is deferred — the length cap is the v1
  mitigation; the error shape already has the `'redos'` slot for a
  future tightening.
- **File traversal** — the only file touched is `${gitDir}/config`,
  inside the FS validator's allowed prefix. No new traversal surface.
- **No new auth, no new transport, no new env reads.**

## 9. Domain ↔ application split

- **`src/domain/commands/config-key.ts`** — pure syntactic parse of a
  raw key into `ParsedConfigKey`. No Context, no I/O. The
  `domain/refs/ref-validation.ts` precedent.
- **`src/application/commands/internal/config-key.ts`** —
  case-folding rules, `qualifyKey`, `collectValues`. Depends on
  `IniSection` from `src/application/primitives/config-read.ts`.
- **`src/application/primitives/config-read.ts`** — every reader
  (existing `readConfig` + new `readConfigSections` / `getConfigValue` /
  `getAllConfigValues`). The application-layer access-point.
- **`src/application/primitives/update-config.ts`** — every writer
  (unchanged). Re-exports the full `setConfigEntry` family per
  ADR-185.
- **`src/application/commands/config.ts`** — Tier-1 dispatcher.
  Composes readers + writers, validates inputs, returns the
  discriminated result.

## 10. Open questions (ADR shopping list)

> **Q.1 — Single discriminator vs. flat methods**
> Options: A) `repo.config({ action, ... })` (matches branch / tag /
> sparseCheckout / remote). B) Flat methods (`repo.configGet`,
> `repo.configSet`, …). C) Nested namespace
> (`repo.config.get(...)`).
> Recommended: A — single discriminator.
> Why: CRUD family with closely related inputs (every action carries
> a `key`); Phase 20.5 (`remote`) just established the precedent at
> ADR-175. Mixed precedent would force future CRUD families to
> relitigate.

> **Q.2 — Scope handling in v1 (`local` only)**
> Options: A) Ship `local` only; add `scope` option additively in a
> follow-up. B) Ship `local` + `global` + `system` + `worktree` in
> v1 with a single dispatcher. C) Ship `local` + `worktree` only
> (the two that don't require adapter capabilities for HOMEDIR /
> `/etc/gitconfig`).
> Recommended: A.
> Why: `global` / `system` require new adapter capabilities (HOMEDIR
> resolution, system-path discovery) and a precedence resolver
> (system → global → local → worktree). Both are large enough to
> deserve their own phase. Shipping `local` first matches what
> `readConfig` already supports.

> **Q.3 — `get` on multi-valued key — throw or return all?**
> Options: A) Throw `CONFIG_MULTIPLE_VALUES` (canonical-git aligned).
> B) Return the last value (canonical git's `git config --get`
> behaviour silently picks last). C) Return the first value.
> Recommended: A.
> Why: Silent picking is the kind of footgun mutation testing
> catches. `getAll` is the one-keystroke fix when the caller knows
> the key is multi-valued; making the ambiguity explicit at the type
> level is the safer default.

> **Q.4 — `unset` on absent key — `removed: false` or throw?**
> Options: A) Idempotent — return `removed: false`. B) Throw
> `CONFIG_KEY_NOT_FOUND` (canonical git exit-5 equivalent). C)
> Throw on the first call; `removed: false` on subsequent calls
> (impossible without state).
> Recommended: A.
> Why: Idempotence composes better with automation (the caller wants
> "ensure this is gone" semantics, not "fail noisily if already
> gone"). Canonical-git's exit-5 distinction does not map cleanly to
> a structured return — the typed result envelope is more useful.

> **Q.5 — Should there be an `add` action that always appends?**
> Options: A) Defer (no `add` action; users compose `unsetAll` +
> `set`). B) Ship `add` that appends an entry without disturbing
> existing entries (canonical `git config --add`).
> Recommended: A (defer).
> Why: The composition is two calls; the use case (programmatically
> assemble a multi-valued list) lands inside `repo.remote` for
> `fetch` refspecs, which is the only multi-valued key v1 ships at
> the porcelain layer. Cherry-picking an `add` action without a
> driving use case invites surface bloat.

> **Q.6 — Regex semantics for `getRegexp`: POSIX or JavaScript?**
> Options: A) JavaScript `RegExp` (native; tsgit divergence from
> canonical git). B) Ship a POSIX-ERE translator. C) Reject regex
> entirely; require a glob.
> Recommended: A — JavaScript regex.
> Why: Writing a POSIX engine in TS is a multi-week side quest. The
> divergence is documented in §4.3 + an ADR. Most regex patterns
> are POSIX/PCRE-compatible at the surface level (literal chars,
> `.*`, character classes); the rare incompatibility is opt-in
> visible. C punts the question to users.

> **Q.7 — Long-line wrapping on write (canonical git wraps at ~76
> chars).**
> Options: A) Write single-line values, never wrap. B) Wrap on
> write to match canonical git. C) Wrap only for values exceeding
> a configurable threshold.
> Recommended: A.
> Why: Single-line writes round-trip cleanly through every parser
> (canonical git, `parseIniSections`, third-party tools). Wrapping
> is a write-side aesthetic concern that can land additively; never
> wrapping is the safe default.

> **Q.8 — Inline-comment characters (`#` / `;`) and leading
> whitespace in values.**
> Options: A) Reject at `set` (porcelain-side `assertValueSafe`).
> B) Accept and quote on write (extends `renderEntry` to emit
> `"value"` when the value contains these chars).
> Recommended: A (v1).
> Why: Quoting is a writer-side change with subtle interaction
> rules (canonical git's quoting grammar is more involved than just
> `"..."`). Rejecting at the porcelain is conservative: no silent
> data corruption, clear error message, easy follow-up to relax. Q
> surfaces the existing bug in `update-config.ts` (the writer
> emits raw values today; a value containing `#` round-trips
> incorrectly through the reader). Closing the gap at the porcelain
> layer first lets the writer change land independently.

> **Q.9 — Should `list` also accept `--name-only` shape (return
> keys, not entries)?**
> Options: A) Single shape — `entries: ConfigEntryView[]`. B) Add
> `nameOnly?: boolean` and conditionally return
> `{ keys: ReadonlyArray<ConfigKey> }`.
> Recommended: A.
> Why: A caller wanting only the keys writes `entries.map(e => e.key)`
> trivially. `--name-only` adds API surface for no real saving.

> **Q.10 — `getRegexp` value pattern: filter at the JS layer or
> push into the regex?**
> Options: A) Both `keyPattern` and `valuePattern` are tested as
> separate `RegExp` predicates (current draft). B) A single
> combined regex over `<key> <value>`.
> Recommended: A.
> Why: Two predicates are clearer than one and the cost is identical
> (both are `O(entries × pattern.length)`). Canonical git also
> takes the key+value as separate args.

> **Q.11 — Primitive promotion: keep `setConfigEntry` exported AND
> add new readers, or strip it?**
> Options: A) Keep the writer family exported AND add
> `getConfigValue` / `getAllConfigValues` / `readConfigSections` (the
> Phase 20.2 playbook). B) Strip the writer family ("porcelain
> owns config writes now"). C) Keep writers, but no new readers
> (porcelain handles reads exclusively).
> Recommended: A.
> Why: The Phase 20.5 `remote` porcelain composes the writer family
> heavily; stripping it would break a freshly-shipped consumer.
> Adding the read surface alongside completes the public primitive
> story (read + write available both as primitives and as
> porcelain). Phase 20.2 set this precedent — keep both layers
> usable. ADR-185.

> **Q.12 — Should `set` reject the v1 "writer-bug" characters (`#` /
> `;`/ leading whitespace) at the porcelain layer or at the writer
> layer?**
> Options: A) Porcelain (matches v1 deferral cut). B) Writer
> (centralised — every config write inherits the check).
> Recommended: A (v1) → B (follow-up).
> Why: Porcelain-layer rejection in v1 keeps the writer untouched;
> a future PR migrates the check to the writer once the quoting
> grammar is settled. Two-step delivery avoids coupling 20.6 with a
> writer refactor.

## 11. Out of scope (explicit deferrals, recapped)

Each item maps to a planned future phase or an explicit "not v1"
ADR cut:

- `--show-origin` / `--show-scope` (additive; lands with scope).
- `global` / `system` / `worktree` scopes (Q.2).
- `[include]` / `includeIf` evaluation.
- `--edit` (`$EDITOR`-spawn).
- `--type` typed accessors — raw strings only in v1 (ADR-184).
- `renameSection` / `removeSection` as porcelain verbs (covered by
  `repo.remote` for the `[remote "X"]` use case; surface again only
  if a real caller surfaces).
- `--default <value>` fallback (trivial in user-land).
- `--fixed-value` literal-match for `--unset`.
- `credential.*` helper interpretation.
- `.git/config.lock` atomic write (uniform refactor; lands across
  every writer at once if at all).
- Multi-line value wrap on write (Q.7).
- Quoting on write (Q.8 → Q.12).

## 12. Implementation slice list (preview for Phase 4)

The plan-phase doc spells these out as ordered TDD slices; each
slice is one atomic commit. Sketch:

1. **Domain key parser** —
   `src/domain/commands/config-key.ts` + pure-domain tests. Red:
   `parseConfigKey('section.name')` returns `ParsedConfigKey`.
2. **Application key helpers** —
   `src/application/commands/internal/config-key.ts`
   (`qualifyKey`, `collectValues`) + tests.
3. **New error codes** — extend `domain/commands/error.ts` with
   `CONFIG_KEY_INVALID` / `CONFIG_MULTIPLE_VALUES` /
   `CONFIG_REGEX_INVALID` and their factories.
4. **Primitive readers** — extend
   `src/application/primitives/config-read.ts` with
   `readConfigSections` + `getConfigValue` + `getAllConfigValues`
   (cached). Tests for each.
5. **Regex safety helper** — land
   `src/application/commands/internal/safe-regex.ts` with
   `compileSafeRegex(pattern, field)` (length cap + syntax check;
   ReDoS slot reserved on the error shape, not yet wired) used for
   `getRegexp`. `compilePathspec` is NOT reused — it emits a linear
   glob matcher, not a `RegExp`, so the two surfaces are disjoint.
6. **Porcelain `config.ts`: list / get / getAll / getRegexp** —
   read-only actions land first because they need no writer
   changes.
7. **Porcelain `config.ts`: set / unset / unsetAll** — compose
   `updateConfigOperations` for the writes.
8. **Property tests** — round-trip / idempotence /
   compositional invariants on `parseConfigKey` and
   `collectValues`.
9. **Integration + parity** —
   `test/integration/config-lifecycle.test.ts` +
   `test/parity/scenarios/config-crud.scenario.ts`.
10. **Repository binding + public exports** —
    `src/repository.ts` + `src/application/commands/index.ts` +
    `src/application/primitives/index.ts`.
11. **Docs (PR phase)** — `docs/use/commands/`, `docs/use/recipes.md`,
    README/RUNBOOK, BACKLOG flip.

## 13. Self-review log

### Pass 1 → Pass 2

- §3 split the result envelope per action so `get.value` is `string |
  undefined`, `getAll.values` is `string[]`, and the unset family
  carries `removed: boolean | number`. The earlier pass folded them
  into one shape with optional fields, which lost the type-level
  precision Phase 20.5 just established. Result-discriminator-per-
  action matches `RemoteResult`.
- §4.4–§4.6 added the multi-valued guard explicitly for `set` and
  `unset` (not just `get`). The earlier pass only guarded `get`,
  which would silently overwrite (or unset) multi-valued keys —
  canonical-git divergence and a hard-to-debug failure mode.
- §4.8 added the dotted-subsection parsing rule (`remote.my.fork.url`)
  with a worked example. Canonical git's parser treats the middle
  segment verbatim between first and last `.`; an earlier draft
  missed the corner case.
- §5.2 spelled out the new primitive readers as their own
  subsection; without it the "primitive promotion" claim in the
  backlog was a one-line aspiration.

### Pass 2 → Pass 3

- §4.11 + Q.8 added — surfacing the existing `#` / `;` /
  leading-whitespace value bug in `update-config.ts` as a 20.6
  ADR-shopping-list entry. Without this, a reviewer would
  legitimately ask "why doesn't `set('foo', '#bar')` round-trip?"
  and the design would have no answer. The conservative cut (reject
  at the porcelain, document, fix in writer follow-up) keeps 20.6
  scope-bounded.
- §4.3 added the ReDoS guard and pointed it at the
  `compilePathspec` precedent. The earlier pass treated `getRegexp`
  as "just a regex" — the existing project memory about
  `compile-glob-redos` requires every regex-input porcelain to
  declare its rejection contract.
- §3.2 added — the brand-on-output-not-input asymmetry needed
  documenting; an earlier draft branded inputs too, which would have
  forced cast noise at every call site.
- §6.5 spelled out the four-lens property-testing decision per
  CLAUDE.md (round-trip / compositional / total / idempotence). The
  earlier draft only mentioned "property tests for the parser"
  without the lens map.
- §10 grew from 6 questions to 12. Each new question (Q.7, Q.8, Q.9,
  Q.10, Q.11, Q.12) corresponds to a load-bearing decision a
  reviewer would legitimately push back on; surfacing them in the
  design protects the orchestrator's ADR step from being a fishing
  expedition.

### Pass 3 → converged

- §1 added the third bullet under §1.1 about CI/automation users —
  the original "why now" only covered the `pull` / `stash` reasoning
  but the user-facing argument is the strongest of the three.
- §4.1 added the rationale for NOT using the existing `readConfig`
  cache (it returns the structured-but-lossy shape; the porcelain
  needs raw sections). Without this an attentive reviewer would
  ask "why are we adding a second cache?".
- §5.2 added the `ADR-185` reference inline so the primitive-
  promotion playbook is visible at the layout site.
- §6.8 added explicit Stryker target file list (not just
  "everything") so the plan-phase has an enumerable target.
- §12 added the explicit ordering — read-only actions first
  (slice 6), writes second (slice 7) — so the implementation
  subagent has a TDD-friendly red/green sequence. The earlier
  draft listed slices alphabetically.

### Pass 4 — technical-accuracy corrections

Final pass found three factual gaps relative to the codebase:

- §4.3 — the original "reuses `compileSafeRegex` from
  `compilePathspec`" claim was wrong. `compilePathspec` emits a
  linear glob matcher (ADR-077), never a `RegExp`. Replaced with a
  small NEW helper at `commands/internal/safe-regex.ts` (length cap
  + `new RegExp(pattern)` syntax check, `'redos'` slot reserved on
  the error shape for a future tightening). §5 layout, §12 slice 5
  and §6 test file list updated to match.
- §5 module layout — the test-folder block had a duplicated
  `test/unit/application/commands/` heading. Consolidated, and
  added `safe-regex.test.ts` (which slice 5 needs).
- API examples — call-site examples used `{ action: 'get', … }` but
  the type uses `kind`. Swapped to `{ kind: 'get', … }` to match the
  declared `ConfigAction` shape.
- Cross-references — §4.4 said "see §4.7" for the error model but
  §4.7 is `list`; corrected to §4.9. §4.6 said "Tracked by mutation
  tests (§6.7)" but §6.7 is parity; corrected to §6.8. §3.2 said
  `parseConfigKey (§4.7)` but parser lives in §4.8.
- Algorithm pseudocode — every action's pseudocode said
  `parseIniSections(rawConfigText(ctx))` (a function that doesn't
  exist). Standardised on `await readConfigSections(ctx)` — the new
  cached primitive reader.
- `configMultipleValues` factory calls — pseudocode dropped the
  `requested` discriminator on the throw sites; added it back per
  action (`'read'` / `'overwrite'` / `'remove'`) so the error
  factory's third arg is documented.
- §11 deferral list — "(Q.4 in design family — raw strings only)"
  pointed at the wrong Q; Q.4 is about `unset` semantics, not type
  coercion. Replaced with "ADR-184" which IS the type-coercion ADR.
- §5.1 + §9 — `domain/refs/validate-ref-name.ts` precedent path was
  wrong (no such file); corrected to `domain/refs/ref-validation.ts`.
- §4.1, §5.3 — clarified that `collectValues` and
  `update-config.ts::matchesSection` share the casing semantic but
  not the implementation (the two operate on disjoint inputs:
  parsed `IniSection` vs. raw text lines). The earlier draft implied
  an extraction that isn't necessary.
