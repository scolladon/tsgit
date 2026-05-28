# Design — Phase 20.6 `config` Porcelain

**Status:** Draft (target: Accepted at `<sha-after-merge>`).

Backlog: **20.6** — _"`config` porcelain on `repo.*` (read/write
user-facing); promote primitive-tier `setConfigEntry`."_

ADRs (accepted at `ab51e0a`):

- **ADR-181** — nested-namespace porcelain (`repo.config.get(...)`,
  `repo.config.set(...)`, …). Supersedes ADR-175 for new CRUD families;
  backlog 20.8 migrates `repo.remote`/`branch`/`tag`/`sparseCheckout`.
- **ADR-182** — ship all four scopes (`local`/`global`/`system`/`worktree`)
  in v1. Adds `FileSystem` capabilities (`homedir`, `xdgConfigHome`,
  `systemConfigPath`), a precedence resolver, and browser-adapter
  degradation for `global`/`system`.
- **ADR-183** — `get` throws `CONFIG_MULTIPLE_VALUES` on multi-valued
  keys; callers use `getAll`.
- **ADR-184** — `unset`/`unsetAll` are idempotent; absent-key calls
  return `{ removed: false }` / `{ removed: 0 }`.
- **ADR-185** — `getRegexp` accepts native `RegExp` instances with JS
  regex semantics; POSIX-ERE divergence is documented.
- **ADR-186** — writer accepts values with `#`/`;`/leading-whitespace/
  embedded `"`/embedded `\` and quotes on write. Centralised in
  `update-config.ts::renderEntry`; both primitive and porcelain
  inherit. Phase 20.5 `repo.remote` refspec writes inherit correctness.
- **ADR-187** — keep `setConfigEntry` exported AND add the new reader
  family (`getConfigValue`, `getAllConfigValues`, `readConfigSections`)
  plus the matching unset/rename/remove primitives. Primitive tier and
  porcelain tier share identical contracts.

## 1. Goal & Non-goals

### 1.1 Goal

Land Tier-1 porcelain for the user-facing half of `git config` as a
nested namespace on `repo.config`, covering all four standard scopes
(`local` / `global` / `system` / `worktree`) with the canonical-git
precedence rule (`system → global → local → worktree`).

The namespace exposes nine methods:

1. **`get`** — read a single scalar entry (with originating scope).
   Throws `CONFIG_MULTIPLE_VALUES` on multi-valued keys (ADR-183).
2. **`getAll`** — read every occurrence of a key as an ordered array.
3. **`getRegexp`** — read every entry whose fully-qualified key matches
   a `RegExp`; optionally filter on the value with a second `RegExp`.
4. **`set`** — write (or overwrite) the single value of a key. Throws
   `CONFIG_MULTIPLE_VALUES` when the key is already multi-valued in
   the targeted scope.
5. **`unset`** — remove the single value of a key. Idempotent
   (ADR-184). Throws `CONFIG_MULTIPLE_VALUES` when ambiguous.
6. **`unsetAll`** — remove every occurrence of a key. Idempotent.
7. **`list`** — enumerate every entry across active scopes, tagged
   with originating scope.
8. **`renameSection`** — rename a `[section "<old>"]` to
   `[section "<new>"]`.
9. **`removeSection`** — drop an entire `[section "<name>"]` block.

`repo.config` is the only new bound name; the namespace itself is an
object literal of bound methods (ADR-181).

The primitive tier (`src/application/primitives/`) gains a matching
reader family alongside the existing writer family (ADR-187), so a
primitive-only caller (e.g. a CLI tool driving `Context` directly) has
the full read/write surface without the porcelain envelope.

### 1.2 Why now

Three downstream gaps make 20.6 a prerequisite:

- **Phase 21.1 (`pull`)** reads `branch.<X>.merge` and
  `branch.<X>.remote` to resolve upstream — already wired internally,
  but a programmatic caller composing primitives has no public read
  path. `repo.config.get({ key: 'branch.main.remote' })` closes it.
- **Phase 21.3 (`stash`)** writes `stash.<key>` entries (`stash.useBuiltin`
  is the canonical knob); without a read surface tsgit can't honour its
  own config knobs from user code.
- **CI/automation users** want a single porcelain to set `user.name`/
  `user.email` (across whichever scope the caller targets) without
  learning the primitive layer. Today they have to call
  `repo.ctx.fs.writeUtf8` against `${gitDir}/config` (or build a
  primitive composition by hand) — both are pit-of-failure paths.

It also closes a self-referential v2 gap: tsgit has writers
(`updateConfigEntries`, `updateConfigOperations`) but no public
**reader** that surfaces a single value by key. `readConfig` returns
the known-section shape (`core`/`user`/`remote`/`branch`/`extensions`)
and DROPS every other entry — there is no public path to read
`gpg.program` or `commit.gpgsign` out of `.git/config`. 20.6 fixes this
by adding the raw read primitives the porcelain rides on.

### 1.3 Non-goals (do NOT ship in 20.6)

Each deferral surfaces as an explicit ADR slot in §13 (the
"decisions reached" section) or, where appropriate, as an item on
`docs/BACKLOG.md` for a later phase.

- **`--show-origin`** — reading the originating file path (`.git/config`
  vs `~/.gitconfig` vs `/etc/gitconfig`) is deferred. The
  `{ value, scope }` envelope already subsumes `--show-scope` (the
  scope label is enough to disambiguate; the absolute path can be
  computed from `ctx` if a future caller needs it).
- **`[include]` / `includeIf` evaluation** — conditional includes
  evaluate against a worktree's branch/remote at read time; tsgit's
  `parseIniSections` doesn't honour them, and adding the resolver
  pulls in a non-trivial chunk of canonical git's machinery. Reads do
  NOT follow include directives in v1 (ADR-182).
- **`--edit` (`$EDITOR`-spawn)** — plain-text editing belongs to a CLI,
  not a library port. Out forever.
- **`--type` / typed accessors (`bool`/`int`/`bool-or-int`/`path`/
  `expiry-date`)** — v1 returns raw strings; callers coerce in
  user-land. The structured `ParsedConfig` already coerces `core.bare`
  etc. for the keys it knows about — we don't try to bridge the two.
- **`--default <value>` fallback** — trivial in user-land
  (`(await repo.config.get(...)).value ?? 'fallback'`); no need to
  bake it in.
- **`--fixed-value` (literal-match `--unset` against a multi-valued
  key)** — the equivalent in tsgit is `getRegexp` + `unsetAll` +
  re-set. Defer until a real caller surfaces.
- **`credential.*` interpretation** — reading the bytes is in scope;
  evaluating credential helpers is not.
- **Signed-int parsing in `[branch.<N>.merge]` / etc.** — v1 stays
  string-typed.
- **Built-from-source `$(prefix)/etc/gitconfig` discovery** —
  `systemConfigPath()` returns `/etc/gitconfig` (POSIX) or
  `%ProgramData%\Git\config` (Windows). Custom-prefix probes are a
  documented limitation (ADR-182 §Decision).
- **Atomic lock file (`config.lock`)** — canonical git writes via
  `.git/config.lock` then renames. tsgit's existing
  `updateConfigOperations` does a read-modify-write `writeUtf8` without
  a lock (ADR-074 accepted the trade-off). v1 inherits this; a future
  refactor lands in `update-config.ts` and benefits every config writer
  uniformly.

The ADR-175 deprecation (action-discriminator on `repo.remote` /
`branch` / `tag` / `sparseCheckout`) is **NOT** part of this phase —
backlog item 20.8 migrates those surfaces to the nested-namespace
shape. Until 20.8 lands, `repo.config.get(...)` (nested) and
`repo.remote({ kind: 'add', ... })` (discriminator) ship side-by-side.

## 2. Public API

```typescript
// src/application/commands/config.ts (porcelain) +
// src/application/commands/internal/config-namespace.ts (assembly)

/** Fully-qualified git config key: `<section>(.<subsection>)?.<name>`. */
export type ConfigKey = string & { readonly __brand: 'ConfigKey' };

/** One of the four canonical git config scopes. */
export type ConfigScope = 'system' | 'global' | 'local' | 'worktree';

/** One physical `<key> = <value>` line in some config file. */
export interface ConfigEntryView {
  readonly key: ConfigKey;
  readonly value: string;
  readonly scope: ConfigScope;
}

// Per-method input shapes.
export interface ConfigGetInput {
  readonly key: string;
  readonly scope?: ConfigScope; // omit for merged read
}
export interface ConfigGetAllInput {
  readonly key: string;
  readonly scope?: ConfigScope;
}
export interface ConfigGetRegexpInput {
  readonly keyPattern: RegExp;
  readonly valuePattern?: RegExp;
  readonly scope?: ConfigScope;
}
export interface ConfigSetInput {
  readonly key: string;
  readonly value: string;
  readonly scope?: ConfigScope; // default: 'local'
}
export interface ConfigUnsetInput {
  readonly key: string;
  readonly scope?: ConfigScope; // default: 'local'
}
export interface ConfigListInput {
  readonly scope?: ConfigScope;
}
export interface ConfigRenameSectionInput {
  readonly oldName: string;
  readonly newName: string;
  readonly scope?: ConfigScope;
}
export interface ConfigRemoveSectionInput {
  readonly name: string;
  readonly scope?: ConfigScope;
}

// Per-method result shapes. Each is concrete — no discriminated union.
export interface ConfigGetResult {
  readonly key: ConfigKey;
  readonly value: string;
  readonly scope: ConfigScope;
}
export interface ConfigGetMissingResult {
  readonly key: ConfigKey;
  readonly value: undefined;
}
export interface ConfigGetAllResult {
  readonly key: ConfigKey;
  readonly values: ReadonlyArray<{ readonly value: string; readonly scope: ConfigScope }>;
}
export interface ConfigGetRegexpResult {
  readonly entries: ReadonlyArray<ConfigEntryView>;
}
export interface ConfigSetResult {
  readonly key: ConfigKey;
  readonly value: string;
  readonly scope: ConfigScope;
}
export interface ConfigUnsetResult {
  readonly key: ConfigKey;
  readonly scope: ConfigScope;
  readonly removed: boolean;
  readonly previousValue?: string;
}
export interface ConfigUnsetAllResult {
  readonly key: ConfigKey;
  readonly scope: ConfigScope;
  readonly removed: number;
}
export interface ConfigListResult {
  readonly entries: ReadonlyArray<ConfigEntryView>;
}
export interface ConfigRenameSectionResult {
  readonly oldName: string;
  readonly newName: string;
  readonly scope: ConfigScope;
}
export interface ConfigRemoveSectionResult {
  readonly name: string;
  readonly scope: ConfigScope;
}

// Bound namespace shape.
export interface ConfigNamespace {
  readonly get: (input: ConfigGetInput) => Promise<ConfigGetResult | ConfigGetMissingResult>;
  readonly set: (input: ConfigSetInput) => Promise<ConfigSetResult>;
  readonly unset: (input: ConfigUnsetInput) => Promise<ConfigUnsetResult>;
  readonly unsetAll: (input: ConfigUnsetInput) => Promise<ConfigUnsetAllResult>;
  readonly list: (input?: ConfigListInput) => Promise<ConfigListResult>;
  readonly getAll: (input: ConfigGetAllInput) => Promise<ConfigGetAllResult>;
  readonly getRegexp: (input: ConfigGetRegexpInput) => Promise<ConfigGetRegexpResult>;
  readonly renameSection: (input: ConfigRenameSectionInput) => Promise<ConfigRenameSectionResult>;
  readonly removeSection: (input: ConfigRemoveSectionInput) => Promise<ConfigRemoveSectionResult>;
}

export const bindConfigNamespace = (ctx: Context, guard: () => void): ConfigNamespace;
```

Bound on the repository as a nested namespace (ADR-181):

```typescript
await repo.config.get({ key: 'user.email' });
await repo.config.get({ key: 'user.email', scope: 'global' });
await repo.config.getAll({ key: 'remote.origin.fetch' });
await repo.config.getRegexp({ keyPattern: /^remote\..*\.url$/ });
await repo.config.set({ key: 'user.email', value: 'me@example.com' });
await repo.config.set({ key: 'pager.log', value: 'less -R # paginate' });
await repo.config.unset({ key: 'user.email' });
await repo.config.unsetAll({ key: 'remote.origin.fetch' });
await repo.config.list();
await repo.config.list({ scope: 'global' });
await repo.config.renameSection({ oldName: 'remote.origin', newName: 'remote.upstream' });
await repo.config.removeSection({ name: 'remote.origin' });
```

### 2.1 Namespace assembly

`Repository.config` is bound by calling `bindConfigNamespace(ctx, guard)`
inside the `openRepository` factory. The namespace is an
`Object.freeze`-d literal whose properties wrap each underlying command
with the `guard()` + `ctx`-binding currently used for flat methods
(`abortMerge`, `add`, …). Specifically:

```typescript
const config = bindConfigNamespace(ctx, guard);
// where bindConfigNamespace returns:
//   Object.freeze({
//     get:     (i) => { guard(); return commands.configGet(ctx, i); },
//     set:     (i) => { guard(); return commands.configSet(ctx, i); },
//     ... one property per method ...
//   })
```

The `Repository` interface gains `readonly config: ConfigNamespace`,
slotted alphabetically alongside the other tier-1 commands.

### 2.2 Why a `ConfigKey` brand?

The brand surfaces in result types (`get.key`, `set.key`, `unset.key`,
`unsetAll.key`, `list.entries[].key`, `getRegexp.entries[].key`) but
NOT in inputs (`input.key` is plain `string`). Rationale:

- Inputs come from user code; forcing a brand cast at every call site
  is ergonomic poison.
- Outputs come from `parseConfigKey` (§7) — guaranteed to satisfy
  the brand contract.

The brand prevents a result-shaped `key` from being passed as a remote
name / ref name / file path at the type level (these have their own
brands). It is purely a domain marker — no runtime check beyond
`parseConfigKey`.

### 2.3 Why a `ConfigScope` brand?

`ConfigScope` is a plain string literal union (`'system' | 'global' |
'local' | 'worktree'`), not a branded string. The four values exhaust
the type; TypeScript's exhaustiveness check is sufficient and a brand
adds no safety on top.

### 2.4 Error model

Six new domain codes land alongside the existing `INVALID_OPTION`
(reused for value-side control-character rejection — see §6):

```typescript
| { readonly code: 'CONFIG_KEY_INVALID';
    readonly key: string;
    readonly reason: 'empty-section' | 'missing-name' | 'bad-character';
    readonly position?: number }
| { readonly code: 'CONFIG_VALUE_INVALID';
    readonly key: string;
    readonly reason: 'control-character';
    readonly position: number }
| { readonly code: 'CONFIG_MULTIPLE_VALUES';
    readonly key: string;
    readonly count: number;
    readonly scope?: ConfigScope; // present when the multi-value condition was scope-filtered
    readonly requested: 'read' | 'overwrite' | 'remove' }
| { readonly code: 'CONFIG_SECTION_NOT_FOUND';
    readonly name: string;
    readonly scope: ConfigScope }
| { readonly code: 'CONFIG_SCOPE_NOT_AVAILABLE';
    readonly scope: ConfigScope;
    readonly reason: 'browser-adapter' | 'worktree-extension-unset' }
| { readonly code: 'CONFIG_SYSTEM_PATH_UNRESOLVED' }
```

Factory functions follow the same pattern as `remoteExists`.

Notes:

- `CONFIG_KEY_NOT_FOUND` is **NOT** part of the error model. `unset`
  on an absent key returns `{ removed: false }` (ADR-184); `get` on an
  absent key returns `{ value: undefined }`.
- The `requested` discriminator on `CONFIG_MULTIPLE_VALUES` lets a
  caller distinguish "you tried to read an ambiguous value" from "you
  tried to overwrite it" from "you tried to unset it" — different
  recovery paths.
- `CONFIG_SECTION_NOT_FOUND` is thrown by `renameSection` and
  `removeSection` when the targeted section does not exist in the
  targeted scope.
- `CONFIG_SCOPE_NOT_AVAILABLE`:
  - `'browser-adapter'` — calling `get`/`set`/etc. with
    `scope: 'global'` or `scope: 'system'` on a browser repo whose
    `FileSystem` adapter throws `FS_OPERATION_NOT_SUPPORTED` from
    `homedir()` / `systemConfigPath()`.
  - `'worktree-extension-unset'` — accessing `scope: 'worktree'` when
    `extensions.worktreeConfig` is not `true` in the local scope.
- `CONFIG_SYSTEM_PATH_UNRESOLVED` — `systemConfigPath()` succeeded but
  returned no valid candidate (e.g. neither `/etc/gitconfig` nor a
  build-time prefix path exists and the platform discovery yielded
  empty). Distinct from `'browser-adapter'` so the caller can react
  differently.

## 3. Method catalogue

Each method takes its own typed input and returns its own typed
result. No `kind` discriminator anywhere.

### 3.1 `get { key, scope? }`

```
1. assertRepository(ctx);
2. const parsed = parseConfigKey(key);            // throws CONFIG_KEY_INVALID
3. const sections = await readScopedSections(ctx, scope);
4. const matches = collectScopedValues(sections, parsed); // ordered by scope precedence
5. if (matches.length === 0) return { key: key as ConfigKey, value: undefined };
6. if (matches.length > 1) throw configMultipleValues(key, matches.length, 'read', scope);
7. const only = matches[0];                       // length === 1 — single occurrence in the consulted scope set
8. return { key: key as ConfigKey, value: only.value, scope: only.scope };
```

- `scope` omitted → merge `system` + `global` + `local` +
  `worktree` (when active), respecting precedence.
- `scope` provided → only that scope is consulted.
- Missing key → `{ value: undefined }`. The caller writes
  `(await ...).value ?? 'fallback'` without an exception flow.
- Multi-valued key → `CONFIG_MULTIPLE_VALUES` with `count` carrying
  the total occurrences across the consulted scope(s). Silent picking
  is the footgun ADR-183 explicitly rules out.

### 3.2 `getAll { key, scope? }`

```
1. assertRepository(ctx);
2. const parsed = parseConfigKey(key);
3. const sections = await readScopedSections(ctx, scope);
4. const matches = collectScopedValues(sections, parsed);
5. return {
     key: key as ConfigKey,
     values: matches.map(({ value, scope }) => ({ value, scope })),
   };
```

- Order: lower-precedence scope first (system → global → local →
  worktree), and within a scope physical file order. Mirrors
  `git config --get-all`'s precedence walk.
- Empty array for missing key.

### 3.3 `getRegexp { keyPattern, valuePattern?, scope? }`

```
1. assertRepository(ctx);
2. const sections = await readScopedSections(ctx, scope);
3. const entries: ConfigEntryView[] = [];
4. for (const { scope: s, section } of sections) {
5.   for (const { key, value } of section.entries) {
6.     const fq = qualifyKey(section, key);
7.     if (!keyPattern.test(fq)) continue;
8.     if (valuePattern !== undefined && !valuePattern.test(value)) continue;
9.     entries.push({ key: fq as ConfigKey, value, scope: s });
10.  }
11. }
12. return { entries };
```

- **JavaScript regex semantics, native `RegExp` input** (ADR-185).
  POSIX-ERE features (`[:alnum:]`, BRE `\(`/`\)`, line-anchored `^$`
  by default) are not supported. JS-only features (lookbehind, named
  capture, `\d`/`\w`, `i`/`m`/`g`/`u` flags) ARE supported. The
  divergence is documented in the tsdoc and the design doc.
- **No ReDoS guard.** The `RegExp` instance is the caller's; tsgit
  trusts it (ADR-185 §Consequences/Negative). The threat model is "the
  caller shoots themselves in the foot," not adversarial input — the
  pattern never crosses a network or transport boundary.
- Fully-qualified key for matching: `<section>.<subsection>.<name>`
  (or `<section>.<name>` when there is no subsection).
- Entries in scope-precedence order, physical order within scope.

### 3.4 `set { key, value, scope? }`

```
1. assertRepository(ctx);
2. const parsed = parseConfigKey(key);
3. assertValueSafe(value);                        // throws CONFIG_VALUE_INVALID
4. const targetScope = scope ?? 'local';
5. const sections = await readSingleScopeSections(ctx, targetScope);
6. const matches = collectValues(sections, parsed);
7. if (matches.length > 1) throw configMultipleValues(key, matches.length, 'overwrite', targetScope);
8. await setConfigEntry({ ctx, key, value, scope: targetScope });
9. return { key: key as ConfigKey, value, scope: targetScope };
```

- **`scope` defaults to `'local'`** — the canonical-git default for
  writes. `system` writes typically require elevated privileges; the
  caller is responsible for catching `EACCES`.
- **`setConfigEntry` writes the value through the quoting writer**
  (ADR-186). The primitive applies the quoting grammar automatically
  for values containing `#`/`;`/leading-whitespace/embedded `"`/
  embedded `\`; the porcelain does NOT pre-quote.
- **Multi-valued guard.** Same precedent as `get`; throws
  `CONFIG_MULTIPLE_VALUES` with `requested: 'overwrite'`.
- **No `--add` semantics on `set`.** Canonical git's `git config --add`
  always appends; the 20.6 surface has no `add` method (the composition
  is `unsetAll` + a sequence of `set` calls; see §13.2 Q.5 deferral).

### 3.5 `unset { key, scope? }`

```
1. assertRepository(ctx);
2. const parsed = parseConfigKey(key);
3. const targetScope = scope ?? 'local';
4. const sections = await readSingleScopeSections(ctx, targetScope);
5. const matches = collectValues(sections, parsed);
6. if (matches.length > 1) throw configMultipleValues(key, matches.length, 'remove', targetScope);
7. if (matches.length === 0) {
8.   return { key: key as ConfigKey, scope: targetScope, removed: false };
9. }
10. const previousValue = matches[0].value;
11. await unsetConfigEntry({ ctx, key, scope: targetScope });
12. return { key: key as ConfigKey, scope: targetScope, removed: true, previousValue };
```

- **Idempotent on absent key** (ADR-184) — returns `{ removed: false }`.
- **`previousValue` populated only when `removed: true`** — the typed
  result envelope carries the answer for callers who care.
- **Multi-valued guard.** Same precedent — `requested: 'remove'`.

### 3.6 `unsetAll { key, scope? }`

```
1. assertRepository(ctx);
2. const parsed = parseConfigKey(key);
3. const targetScope = scope ?? 'local';
4. const sections = await readSingleScopeSections(ctx, targetScope);
5. const matches = collectValues(sections, parsed);
6. if (matches.length === 0) {
7.   return { key: key as ConfigKey, scope: targetScope, removed: 0 };
8. }
9. await unsetAllConfigEntries({ ctx, key, scope: targetScope });
10. return { key: key as ConfigKey, scope: targetScope, removed: matches.length };
```

- **`removed: number` instead of `boolean`** so the caller distinguishes
  "removed three duplicate entries" from "removed one canonical entry".
- **Idempotent** — `removed: 0` for absent keys.

### 3.7 `list { scope? }`

```
1. assertRepository(ctx);
2. const sections = await readScopedSections(ctx, scope);
3. const entries: ConfigEntryView[] = [];
4. for (const { scope: s, section } of sections) {
5.   for (const { key, value } of section.entries) {
6.     entries.push({ key: qualifyKey(section, key) as ConfigKey, value, scope: s });
7.   }
8. }
9. return { entries };
```

- `scope` omitted → merged scopes in precedence order.
- `scope` provided → that scope only.
- Physical order preserved within each scope's file; scopes ordered
  system → global → local → worktree. Matches `git config --list`.
- Includes every section — `core`, `user`, `remote`, `branch`,
  `extensions`, and every section the structured `readConfig` drops
  (`gpg`, `commit`, `pull`, custom `[foo]`, …).

### 3.8 `renameSection { oldName, newName, scope? }`

```
1. assertRepository(ctx);
2. const targetScope = scope ?? 'local';
3. await renameConfigSection({ ctx, oldName, newName, scope: targetScope });
   // primitive throws CONFIG_SECTION_NOT_FOUND when oldName is absent
4. return { oldName, newName, scope: targetScope };
```

- Reuses the existing `renameConfigSection` primitive (gains a
  `scope` parameter — see §8).
- Section names follow the canonical-git `[section "<subsection>"]`
  form; passed as the dotted key form (`remote.origin` → renames
  `[remote "origin"]` block).

### 3.9 `removeSection { name, scope? }`

```
1. assertRepository(ctx);
2. const targetScope = scope ?? 'local';
3. await removeConfigSection({ ctx, name, scope: targetScope });
   // primitive throws CONFIG_SECTION_NOT_FOUND when name is absent
4. return { name, scope: targetScope };
```

- Reuses `removeConfigSection` primitive.

## 4. Scopes

ADR-182 ships all four canonical-git scopes in v1.

### 4.1 Scope paths

| Scope | Path resolution |
|---|---|
| `system` | `FileSystem.systemConfigPath()` returns the platform default: `/etc/gitconfig` on POSIX, `%ProgramData%\Git\config` on Windows. Custom `$(prefix)/etc/gitconfig` (built-from-source git installs) is NOT probed in v1 — documented limitation. |
| `global` | First existing file of: `$XDG_CONFIG_HOME/git/config` (or `~/.config/git/config` when `$XDG_CONFIG_HOME` is unset), then `~/.gitconfig`. Both are READ in precedence (XDG first per canonical git); writes go to the first one that exists, or `~/.gitconfig` if neither exists (canonical-git default). |
| `local` | `${ctx.layout.gitDir}/config`. Same path the existing `readConfig` consults today. |
| `worktree` | `${ctx.layout.gitDir}/config.worktree` — but only when `extensions.worktreeConfig = true` in the local scope. Otherwise the worktree scope is invisible (reads skip it; writes throw `CONFIG_SCOPE_NOT_AVAILABLE` with `reason: 'worktree-extension-unset'`). |

### 4.2 Read precedence

Merged reads (`scope` omitted) consult scopes in this order:
**system → global → local → worktree**. When the same fully-qualified
key appears in multiple scopes, the later scope wins for `get` (which
returns the single resolved value) and the entries are returned in
precedence order for `getAll`/`list`/`getRegexp`.

The merge happens in a new pure helper, `mergeConfigsByScope`, which
takes a `ReadonlyArray<{ scope: ConfigScope; sections: ReadonlyArray<IniSection> }>`
and returns the same shape — collapsing missing scopes (e.g.
`worktree` when the extension is unset) and respecting the
multi-valued semantics required by `getAll`.

The porcelain's per-method pseudocode (§3) refers to two helpers:

- `readScopedSections(ctx, scope?)` — when `scope` is omitted, fans
  out to the active scopes and returns the merged
  `ReadonlyArray<{ scope; section }>` in precedence order; when
  `scope` is provided, returns the single-scope sections (still
  wrapped with the scope label for uniform downstream handling).
- `readSingleScopeSections(ctx, scope)` — convenience wrapper around
  `readConfigSections({ ctx, scope })`; returns the plain
  `ReadonlyArray<IniSection>` for the targeted scope only. Used by
  write methods that target one specific scope.

Both wrap the underlying `readConfigSections({ ctx, scope? })`
primitive (§9.2) and live in
`src/application/commands/internal/config-scope.ts` alongside
`mergeConfigsByScope` and `resolveScopePath`.

### 4.3 Write routing

Writes target a single scope (`scope` parameter; default `'local'`).
The writer (`setConfigEntry` + family) gains a `scope` parameter
(ADR-187); the parameter routes the read-modify-write loop to the
correct file.

`system` writes typically require elevated privileges. tsgit does
NOT check up-front (an `EACCES` from the platform is more accurate
than a probe); the caller catches and handles.

### 4.4 New `FileSystem` adapter capabilities

ADR-182 adds three methods to the `FileSystem` port:

```typescript
export interface FileSystem {
  // ... existing methods unchanged ...

  /**
   * Resolve the current user's home directory.
   * - Node adapter: `os.homedir()`.
   * - Memory adapter: returns the configured fake-home path (default '/home/user').
   * - Browser adapter: throws FS_OPERATION_NOT_SUPPORTED.
   */
  readonly homedir: () => string;

  /**
   * Resolve `$XDG_CONFIG_HOME` (with `~/.config` fallback).
   * - Node adapter: reads `process.env.XDG_CONFIG_HOME` or falls back to `${homedir()}/.config`.
   * - Memory adapter: returns the configured fake-XDG path.
   * - Browser adapter: throws FS_OPERATION_NOT_SUPPORTED.
   */
  readonly xdgConfigHome: () => string;

  /**
   * Resolve the platform's system-wide git config path.
   * - Node POSIX: `/etc/gitconfig`.
   * - Node Windows: `process.env.ProgramData + '\\Git\\config'`.
   * - Memory adapter: returns the configured fake-system path.
   * - Browser adapter: throws FS_OPERATION_NOT_SUPPORTED.
   */
  readonly systemConfigPath: () => string;
}
```

All three are synchronous (no I/O — pure path resolution from
environment / OS hints). The browser adapter throws
`FS_OPERATION_NOT_SUPPORTED` (an existing error code on the
`FileSystem` port).

### 4.5 Browser-adapter degradation

The browser adapter cannot reach `homedir()` or `systemConfigPath()`.
Calls to `repo.config.get({ scope: 'global' })` (and the same with
`scope: 'system'`) catch the underlying `FS_OPERATION_NOT_SUPPORTED`
and re-throw `CONFIG_SCOPE_NOT_AVAILABLE` with
`reason: 'browser-adapter'`.

`local` and `worktree` scopes remain fully functional in the browser
(both live under `ctx.layout.gitDir`, which the browser adapter
already serves).

Merged reads (`scope` omitted) in the browser degrade gracefully:
unreachable scopes are silently skipped. This matches canonical git's
behaviour when `~/.gitconfig` is absent (the read just sees fewer
files), at the cost of a one-line tsdoc note: "browser reads omit
global/system scopes silently."

### 4.6 `worktree` scope gating

The `worktree` scope is only consulted when `extensions.worktreeConfig
= true` in the local config (canonical-git behaviour). Absent the
extension:

- Merged reads skip the `worktree` scope.
- Explicit `scope: 'worktree'` reads/writes throw
  `CONFIG_SCOPE_NOT_AVAILABLE` with `reason: 'worktree-extension-unset'`.

## 5. Type coercion

V1 returns raw strings; no typed accessors. Carried over unchanged
from the original design. Future phases may add `getBool`/`getInt`/
`getPath` etc. as separate methods; the current `value: string` shape
stays additively compatible.

## 6. Value validation

Pre-write validation on `set` (throws before the lock is taken so
state never deviates from `parse → check → write`):

- `parseConfigKey(key)` — see §7. Throws `CONFIG_KEY_INVALID`.
- `assertValueSafe(value)` — throws `CONFIG_VALUE_INVALID` with
  `reason: 'control-character'` and the 0-based position of the
  offending byte when the value contains a control character OTHER
  THAN `\n` and `\t`. `\0`, `\r`, `\x01`-`\x08`, `\x0B`, `\x0C`,
  `\x0E`-`\x1F`, `\x7F` are rejected.

Characters that are **ACCEPTED** at the porcelain layer per ADR-186
(quoted on write by the writer):

- `#` — inline-comment delimiter; quoted when present.
- `;` — inline-comment delimiter; quoted when present.
- Leading whitespace (space/tab) — quoted; preserved verbatim on
  read-back.
- Trailing whitespace (space/tab) — same.
- Embedded `"` — escaped as `\"` inside the quoted value.
- Embedded `\` — escaped as `\\` inside the quoted value.
- `\n` — escaped as the two-character sequence `\n` inside the quoted
  value (the writer never emits a raw newline inside a value).
- `\t` — accepted verbatim (inside or outside quotes); preserved.

The slash rule that protects remote names does **not** apply to
config keys: `gpg.format` and `gpg.<key>.program` must work; `/` is
not a valid character in section/name per canonical git's parser
(`[A-Za-z0-9-]+`), so it never appears in legitimate input. The
parser rejects it via the `[A-Za-z0-9-]+` rule with
`reason: 'bad-character'`.

## 7. Key syntax and parsing

`parseConfigKey` mirrors canonical git's `git_config_parse_key`:

- `<section>.<name>` — two-part form, no subsection.
- `<section>.<subsection>.<name>` — three-part form. The middle
  segment is the subsection, taken verbatim between the first and
  the last `.`. So `remote.my.fork.url` parses as
  `section='remote'`, `subsection='my.fork'`, `name='url'`. Canonical
  git's parser matches this rule.

Key syntax rules:

- **Section name:** `[A-Za-z0-9-]+` (canonical git), case-insensitive
  (lower-cased internally for matching).
- **Name (trailing `<name>` segment):** `[A-Za-z0-9-]+` starting with
  a letter, per canonical git's `git_config_parse_key_1`.
  Lower-cased for matching.
- **Subsection:** any byte except `\n`, `\r`, `\0`, `"`, `\`, `]` —
  matches the existing `rejectSubsection` guard in `update-config.ts`.
  Case-sensitive.
- No subsection AND no name → `CONFIG_KEY_INVALID` with
  `reason: 'missing-name'`.
- Empty section → `reason: 'empty-section'`.
- Forbidden character in section/name → `reason: 'bad-character'`
  and `position: <0-based index>`.

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
line, render the canonical fully-qualified key for `list`/`getRegexp`
output. Lower-cases the section + name; preserves the subsection
verbatim (case-sensitive).

## 8. File format faithfulness & writer changes

The line-surgery family already preserves:

- **Comments** (`#` and `;` — `stripInlineComment` honours them on
  read; writes never touch them).
- **Indentation** — `renderEntry` emits `\t<key> = <value>` (tab),
  matching canonical git's `git config --add`.
- **Section order** — `parseIniSections` walks in file order;
  `setConfigEntry` inserts new sections at the END of the file
  (matching canonical git's "create-at-end" behaviour on first write).
- **Empty sections** — `removeConfigEntry` leaves a section header
  with no entries (canonical git does the same; `removeSection`
  cleans the section header too).
- **Multi-line / backslash continuations** — `parseIniSections`
  joins them on read. Writes emit single-line values (canonical git
  wraps long values lazily; we never wrap — see §13.2 Q.7 deferral).

### 8.1 Quoting on write (ADR-186)

`renderEntry` in `update-config.ts` gains a quoting layer:

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
```

`renderEntry` becomes `\t<key> = ${renderValue(value)}` instead of
`\t<key> = ${value}`. The change is centralised; every config writer
(porcelain + primitive + Phase 20.5 `repo.remote`) inherits.

The reader (`parseIniSections`) already understands the quoting
grammar — no reader change needed beyond a round-trip test pass.

## 9. Domain ↔ application split

### 9.1 Layers

- **`src/domain/commands/config-key.ts`** — pure syntactic parse of a
  raw key into `ParsedConfigKey`. No Context, no I/O. The
  `domain/refs/ref-validation.ts` precedent.
- **`src/application/commands/internal/config-key.ts`** —
  case-folding rules, `qualifyKey`, and two collectors:
  - `collectValues(sections, parsed)` — returns
    `ReadonlyArray<{ value: string }>` from a single-scope section
    array (used by write methods that target one scope).
  - `collectScopedValues(scopedSections, parsed)` — returns
    `ReadonlyArray<{ value: string; scope: ConfigScope }>` from a
    merged scope array (used by read methods that need precedence).

  Depends on `IniSection` from
  `src/application/primitives/config-read.ts`.
- **`src/application/commands/internal/config-scope.ts`** — scope
  resolution (`resolveScopePath(ctx, scope)`), merge helper
  (`mergeConfigsByScope`), worktree-extension gate, browser-adapter
  degradation wrapper.
- **`src/application/primitives/config-read.ts`** — every reader
  (existing `readConfig` + new `readConfigSections` / `getConfigValue` /
  `getAllConfigValues`). The application-layer access-point. All
  readers gain an optional `scope?: ConfigScope` parameter.
- **`src/application/primitives/update-config.ts`** — every writer
  (existing `setConfigEntry` + new `unsetConfigEntry` /
  `unsetAllConfigEntries`; existing `renameConfigSection` /
  `removeConfigSection` gain `scope?`). The `renderEntry` quoting
  refactor lives here (§8.1).
- **`src/application/commands/config.ts`** — Tier-1 dispatcher per
  method (`configGet`, `configSet`, …). One file per method, or one
  file with all nine methods — TBD in the plan phase (lean towards
  one file: `config.ts` exports nine `config<Verb>` functions, similar
  to how `remote.ts` exports one). The namespace assembly
  (`bindConfigNamespace`) lives in `internal/config-namespace.ts`.

### 9.2 Primitive exports (per ADR-187)

**Naming context.** The existing `update-config.ts` already exports
`setConfigEntry`, `removeConfigEntry`, `removeConfigSection`,
`renameConfigSection`, and `appendConfigEntry` as **pure text-transform
functions** (`(text, section, subsection, key, value) → newText`),
alongside the Context-aware orchestrators `updateConfigEntries`,
`updateConfigOperations`, `updateCoreConfig`, `setCoreConfigEntry`.

ADR-187 names the public primitive surface using the names
`setConfigEntry` / `unsetConfigEntry` / etc. but specifies their
signature as `{ ctx, key, value, scope? }` — i.e. Context-aware,
async, performing I/O. This collides with the existing pure functions
of the same name.

#### 9.2.1 Naming convention — `*InText` suffix (ADR-188)

ADR-188 resolves the collision: the existing pure text-transform
helpers gain an `*InText` suffix; the unsuffixed names are freed for
the new Context-aware I/O primitives.

**Convention.** `*InText` suffix = pure synchronous text-transform
(`(text, …) → newText`, no I/O). Unsuffixed = Context-aware async
I/O-performing primitive (`({ ctx, …, scope? }) → Promise<…>`).

**Rename table (cross-ref ADR-188).**

| Old name (pure text-transform) | New name (pure text-transform) | New name (I/O, ADR-187) |
|---|---|---|
| `setConfigEntry` | `setConfigEntryInText` | `setConfigEntry` |
| `setCoreConfigEntry` | `setCoreConfigEntryInText` | (no I/O peer — composes `setConfigEntry`) |
| `renameConfigSection` | `renameConfigSectionInText` | `renameConfigSection` |
| `removeConfigSection` | `removeConfigSectionInText` | `removeConfigSection` |
| `applyConfigOp` | `applyConfigOpInText` | (no I/O peer — orchestrator only) |

Implementation notes:

- The orchestrator currently lives as the file-private helper
  `applyOperation` (line 343 of `update-config.ts`). The
  `applyConfigOpInText` row in the table covers that symbol; the
  rename slice promotes it (or its replacement) to a clear
  `applyConfigOpInText` name and exports it for callers that hold
  text and want the dispatch.
- `removeConfigEntry` and `appendConfigEntry` are also pure
  text-transform helpers defined in `update-config.ts` but NOT
  re-exported through `primitives/index.ts` today. They follow the
  same convention if/when promoted (`removeConfigEntryInText`,
  `appendConfigEntryInText`); no action required in this phase
  beyond the rename slice (§14 slice 6a) keeping the convention
  consistent for any helper it touches.
- The new Context-aware `setConfigEntry({ ctx, key, value, scope? })`
  composes `setConfigEntryInText` after reading the targeted scope's
  file; the I/O primitive owns the I/O, the `*InText` helper owns
  the textual surgery.

Post-rename, the primitive index exports:

```typescript
// Renamed pure text-transform helpers (ADR-188):
export {
  setConfigEntryInText,       // RENAMED from setConfigEntry
  setCoreConfigEntryInText,   // RENAMED from setCoreConfigEntry
  renameConfigSectionInText,  // RENAMED from renameConfigSection (was internal-only)
  removeConfigSectionInText,  // RENAMED from removeConfigSection (was internal-only)
  applyConfigOpInText,        // RENAMED from applyOperation (was internal-only); now exported
} from './update-config.js';

// New Context-aware I/O primitives matching the porcelain surface
// (names freed by ADR-188):
export {
  setConfigEntry,             // NEW — { ctx, key, value, scope? }; uses the quoting writer
  unsetConfigEntry,           // NEW — { ctx, key, scope? }; idempotent
  unsetAllConfigEntries,      // NEW — { ctx, key, scope? }; idempotent
  renameConfigSection,        // NEW — { ctx, oldName, newName, scope? }
  removeConfigSection,        // NEW — { ctx, sectionName, scope? }
} from './update-config.js';

// New readers:
export {
  getConfigValue,             // NEW — { ctx, key, scope? }
  getAllConfigValues,         // NEW — { ctx, key, scope? }
  readConfigSections,         // NEW — { ctx, scope? }
} from './config-read.js';
```

Plus the existing exports (`invalidateConfigCache`, `readConfig`,
`updateConfigEntries`, `updateConfigOperations`, `updateCoreConfig`,
the `ConfigEntry` type) remain unchanged.

The new Context-aware `setConfigEntry({ ctx, key, value, scope? })`:
1. parses `key` via `parseConfigKey`,
2. routes the file path via `resolveScopePath(ctx, scope ?? 'local')`,
3. read-modify-writes the file via the pure text-transform layer
   (which now emits quoted values per ADR-186),
4. invalidates the per-Context per-scope cache.

### 9.3 Repository binding

`Repository.config` joins the alphabetised tier-1 list:

```typescript
readonly config: ConfigNamespace;
```

bound in `openRepository` via:

```typescript
const repo: Repository = Object.freeze({
  // ... other tier-1 bindings unchanged ...
  config: bindConfigNamespace(ctx, guard),
  // ... primitives.* and snapshot unchanged ...
});
```

`src/application/commands/index.ts` re-exports:

```typescript
export {
  type ConfigEntryView,
  type ConfigKey,
  type ConfigNamespace,
  type ConfigScope,
  // ... per-method input + result types ...
  bindConfigNamespace,
  configGet,
  configSet,
  configUnset,
  configUnsetAll,
  configList,
  configGetAll,
  configGetRegexp,
  configRenameSection,
  configRemoveSection,
} from './config.js';
```

## 10. Testing strategy

### 10.1 Existing test files extended

- `test/unit/application/primitives/config-read.test.ts` — extended:
  new `getConfigValue` / `getAllConfigValues` / `readConfigSections`
  cases per scope; cache-hit on second call; cache-miss after
  `invalidateConfigCache`.
- `test/unit/application/primitives/update-config.test.ts` —
  extended: `unsetConfigEntry` / `unsetAllConfigEntries` per scope;
  `renameConfigSection` / `removeConfigSection` per scope; the
  quoting writer round-trips for `#` / `;` / leading-whitespace /
  embedded `"` / embedded `\` / embedded `\n`.

### 10.2 New unit test files

- `test/unit/application/commands/config.test.ts` — per-method GWT
  cases (one file covering all nine methods).
- `test/unit/application/commands/internal/config-key.test.ts` —
  parser/qualifier/collectValues cases.
- `test/unit/application/commands/internal/config-key.properties.test.ts`
  — property-based round-trip and idempotence on `parseConfigKey`/
  `qualifyKey`/`collectValues`.
- `test/unit/application/commands/internal/config-scope.test.ts` —
  `resolveScopePath` per scope and per adapter; `mergeConfigsByScope`
  precedence; browser-adapter degradation; worktree-extension gate.
- `test/unit/domain/commands/config-key.test.ts` — pure-domain parse
  rules (no Context).

### 10.3 Adapter test extensions

- `test/unit/adapters/node/file-system.test.ts` — extended:
  `homedir()`, `xdgConfigHome()` (with and without
  `$XDG_CONFIG_HOME`), `systemConfigPath()` per platform.
- `test/unit/adapters/browser/file-system.test.ts` — extended: each
  of the three new methods throws `FS_OPERATION_NOT_SUPPORTED`.
- `test/unit/adapters/memory/file-system.test.ts` — extended:
  configurable fake-home / fake-XDG / fake-system paths.

### 10.4 Integration tests

- `test/integration/config-lifecycle.test.ts` — end-to-end without a
  network:
  - "Given a fresh repo, When `set → get → set → unset → list` run
    in sequence in `local` scope, Then the final config matches the
    expected end state."
  - "Given a `set` in `global` scope, When the resulting file is
    read by canonical-git as a subprocess, Then the value matches."
  - "Given an `extensions.worktreeConfig = true` setup, When
    `set({ scope: 'worktree' })` is followed by
    `get({ scope: 'worktree' })`, Then the round-trip succeeds."
  - "Given a value containing `#`, When `set` writes it and `get`
    reads it back, Then the value round-trips byte-exact."

### 10.5 Parity tests

- `test/parity/scenarios/config-crud.scenario.ts` — drives the nine
  methods through Node + Memory + Browser/OPFS via the existing
  harness. Captures load-bearing goldens:
  - the final `.git/config` text after `set → unset → unsetAll`
    (line-surgery preservation);
  - the merged-read result after writing the same key to two scopes
    (precedence rule).

Per the `feedback_isolate_git_subprocess_env` project memory, every
parity test that spawns canonical git scrubs `GIT_*` env vars before
the call.

### 10.6 Parity vs `git config` per scope

Dedicated parity tests verify the four-scope precedence against
canonical git:

- "Given the same key written to `system` and `local`, When `get`
  runs without `scope`, Then the value matches `git config --get`
  (local wins)."
- "Given a key only in `global`, When `get` runs without `scope`,
  Then the value matches `git config --get`."
- "Given a key in `worktree` and `local` with
  `extensions.worktreeConfig = true`, When `get` runs without
  `scope`, Then the value matches `git config --get` (worktree wins)."

### 10.7 Property tests

The four-lens check from CLAUDE.md applies:

1. **Round-trip pair.** `parseConfigKey(qualifyKey(parseConfigKey(x)))
   === parseConfigKey(x)` for every key in the safe subset.
   `numRuns: 200`.
2. **Compositional matcher / aggregator.** `collectValues` over a
   freshly generated sections array: appending a matching entry
   increments the returned array length by one; appending a
   non-matching entry leaves it unchanged. `numRuns: 100`.
3. **Total function.** `parseConfigKey` rejects no input in the
   declared safe subset (`[a-zA-Z0-9-]+\.[a-zA-Z0-9-]+`) — never
   throws. `numRuns: 100`.
4. **Idempotence.** Two calls to `parseConfigKey` on the same input
   return deeply-equal results. `numRuns: 50`.

Writer-side property test (new):

5. **Quoting round-trip.** For every value in the
   `assertValueSafe`-survivable subset (ASCII printable + `\t` + `\n`,
   length ≤ 1024), `parseIniSections(renderEntry(key, value))`
   reads back exactly `value`. `numRuns: 200`. Property file:
   `test/unit/application/primitives/update-config.properties.test.ts`.

Property tests live in `*.properties.test.ts` next to the example
tests, with shared `arbitraries.ts` if the generator base grows.

### 10.8 Mutation

Stryker on:

- `src/application/commands/config.ts`
- `src/application/commands/internal/config-key.ts`
- `src/application/commands/internal/config-scope.ts`
- `src/application/commands/internal/config-namespace.ts`
- `src/domain/commands/config-key.ts`
- New exports inside `src/application/primitives/config-read.ts`.
- The `renderEntry` quoting refactor inside
  `src/application/primitives/update-config.ts`.

Target: 0 new killable survivors. Per CLAUDE.md "Mutation-Resistant
Test Patterns":

- Error assertions are specific — `try/catch` + `.data.code` +
  `.data.reason` for every thrown error (never bare
  `toThrow(TsgitError)`).
- Per-character validator tests live one-per-character so the
  StringLiteral mutants on the regex are killed individually.
- `removed: number` is asserted as the exact count (not `>= 1`) so
  the `n` → `n + 1` mutant is killed.
- `count` on `CONFIG_MULTIPLE_VALUES` is asserted as the exact
  occurrence count for the same reason.
- The `requested` discriminator on `CONFIG_MULTIPLE_VALUES` is
  asserted per call site (read / overwrite / remove).
- The `scope` field on every result envelope is asserted explicitly.

### 10.9 Browser-surface coverage

Phase 19.5a gates `repo.*` names against parity scenarios + allowlist.
`repo.config` is the new name; the bundled `config-crud.scenario.ts`
closes the gap. The browser-adapter degradation tests
(`global`/`system` scope → `CONFIG_SCOPE_NOT_AVAILABLE`) live in the
scenario as well. No allowlist entry needed.

## 11. Performance posture

- `get`/`getAll`/`getRegexp`/`list` cost one
  `readScopedSections(ctx, scope?)` call (which fans out to the
  active scopes — at most four file reads, each individually cached)
  plus a linear walk through the sections. O(N) over the total entry
  count.
- `set`/`unset`/`unsetAll` each cost one read + one line-surgical
  write via the relevant writer primitive against the targeted scope.
- The per-scope cache HIT path is one `WeakMap` lookup per scope —
  same constant cost as `readConfig` today. Each scope has its own
  cache key on the same per-Context `WeakMap`.

No new bench scenario this phase; Phase 26 will measure if `list`
becomes a hot path (it shouldn't — config files are tiny).

## 12. Security posture

- **Key syntax rejection** (§7) — no path-like, no control char, no
  quote-busting subsection. The line-surgery family already
  forbids the writer-side characters; the porcelain forbids the same
  set at the reader side via `parseConfigKey`.
- **Value safety** — `\0` / `\r` / `\x01`-`\x08` / `\x0B` / `\x0C` /
  `\x0E`-`\x1F` / `\x7F` rejected at the porcelain layer
  (`assertValueSafe`) before any I/O. `\n` and `\t` accepted and
  quoted on write (ADR-186).
- **Regex** — caller-supplied `RegExp` instances are trusted; no
  ReDoS guard (ADR-185 §Negative). The threat model is "the caller
  shoots themselves in the foot," not adversarial input — the pattern
  never crosses a network or transport boundary.
- **File traversal** — touched files are limited to the four scope
  paths resolved by the FS adapter:
  - `local` / `worktree`: under the existing `ctx.layout.gitDir`
    containment.
  - `global` / `system`: outside the workdir-rooted FS validator's
    allowed prefix. The validator MUST be extended to allow the four
    scope paths specifically (see §14 slice 16 — implementation note).
- **Privilege** — `system` writes typically require elevated
  privileges. tsgit does NOT probe up-front; the platform error
  (`EACCES`) surfaces as the platform's structured error code.
- **No new auth, no new transport, no new env reads beyond
  `$XDG_CONFIG_HOME` and `$ProgramData` (both already conventional).**

## 13. Decisions reached & deferrals

### 13.1 Load-bearing decisions (locked by ADR)

| Question | Decision | ADR |
|---|---|---|
| Surface shape (action discriminator vs flat methods vs nested namespace) | Nested namespace — `repo.config.get(...)` | ADR-181 |
| Scope handling in v1 | All four scopes (`local`/`global`/`system`/`worktree`) | ADR-182 |
| `get` on multi-valued key | Throw `CONFIG_MULTIPLE_VALUES`; use `getAll` for ambiguity | ADR-183 |
| `unset` on absent key | Idempotent — return `{ removed: false }` | ADR-184 |
| `getRegexp` regex semantics | Native JS `RegExp`; POSIX-ERE divergence documented | ADR-185 |
| `set` of values containing `#` / `;` / leading-ws | Accept and quote on write (writer extension) | ADR-186 |
| Primitive promotion | Keep writers exported; add reader family alongside | ADR-187 |

### 13.2 Adopted-default deferrals (no ADR — recorded here)

| ID | Question | Decision | Rationale |
|---|---|---|---|
| Q.5 | Should there be a separate `add` action? | No — composition is `unsetAll` + `set`. | The use case (programmatically assemble a multi-valued list) lands inside `repo.remote` for `fetch` refspecs, which is the only multi-valued key v1 ships at the porcelain layer. Cherry-picking `add` without a driving use case invites surface bloat. |
| Q.7 | Long-line wrapping on write (canonical git wraps at ~76 chars)? | No — single-line writes, never wrap. | Single-line writes round-trip cleanly through every parser; wrapping is a write-side aesthetic that can land additively. |
| Q.9 | Should `list` support a `nameOnly` flag? | No — single shape (`entries: ConfigEntryView[]`). | `entries.map(e => e.key)` is trivial in user-land; the flag adds API surface for no real saving. |
| Q.10 | Should `getRegexp` use one combined regex or two predicates? | Two predicates (`keyPattern` + `valuePattern`). | Two predicates are clearer than one and the cost is identical (both are `O(entries × pattern.length)`). Canonical git also takes the key+value as separate args. |
| Q.12 | Porcelain-side value validation vs writer-side? | Q.8 supersedes — the writer refactor lands in v1 (ADR-186), so the porcelain-vs-writer split is moot. The single layer of value validation (`assertValueSafe` rejecting non-`\n`-non-`\t` control characters) lives in the porcelain; the writer's quoting handles every other corner. | One validation pass per concern (control chars at porcelain, quoting at writer). |

## 14. Implementation slice list (preview for Phase 4)

The plan-phase doc spells these out as ordered TDD slices; each
slice is one atomic commit. The sketch below is intentionally
coarse — the plan-phase subagent will detail it.

1. **`FileSystem` adapter capabilities** —
   `homedir()` / `xdgConfigHome()` / `systemConfigPath()` on the
   port; Node + browser + memory implementations + tests.
2. **Domain key parser** —
   `src/domain/commands/config-key.ts` + pure-domain tests + property
   tests.
3. **Application key helpers** —
   `src/application/commands/internal/config-key.ts`
   (`qualifyKey`, `collectValues`) + tests.
4. **New error codes** — extend `domain/commands/error.ts` with
   `CONFIG_KEY_INVALID` / `CONFIG_VALUE_INVALID` /
   `CONFIG_MULTIPLE_VALUES` / `CONFIG_SECTION_NOT_FOUND` /
   `CONFIG_SCOPE_NOT_AVAILABLE` / `CONFIG_SYSTEM_PATH_UNRESOLVED`
   and their factories.
5. **Scope resolver** —
   `src/application/commands/internal/config-scope.ts`
   (`resolveScopePath`, `mergeConfigsByScope`, worktree-extension
   gate, browser-adapter degradation wrapper) + tests.
6. **Writer quoting refactor** — extend `renderEntry` in
   `update-config.ts` per ADR-186 + round-trip property tests.
   Existing writers inherit; Phase 20.5 `repo.remote` parity tests
   should pass unchanged.
6a. **Text-helper rename (`*InText` suffix) — ADR-188.** Mechanical
   rename of the pure text-transform helpers in `update-config.ts`
   plus their re-exports and call sites, freeing the unsuffixed names
   for the new I/O primitives in slices 8–9. Per §9.2.1:
   - `setConfigEntry` → `setConfigEntryInText`
   - `setCoreConfigEntry` → `setCoreConfigEntryInText`
   - `renameConfigSection` → `renameConfigSectionInText`
   - `removeConfigSection` → `removeConfigSectionInText`
   - `applyOperation` (file-private orchestrator) → `applyConfigOpInText`
     (promoted and exported)

   Internal callers (`updateConfigEntries`, `updateConfigOperations`,
   `updateCoreConfig`, Phase 20.5 `repo.remote` composition, tests)
   update mechanically. Re-exports in
   `src/application/primitives/index.ts` rename in step. No
   behavioural change; existing tests continue to pass under the new
   names. This slice MUST land before slices 8–9 so the I/O primitives
   can take the freed names.
7. **Primitive readers** — extend
   `src/application/primitives/config-read.ts` with
   `readConfigSections` + `getConfigValue` + `getAllConfigValues`
   (each accepting an optional `scope?`). Per-scope cache wiring.
   Tests for each.
8. **New I/O `setConfigEntry` primitive** — introduce the
   Context-aware async `setConfigEntry({ ctx, key, value, scope? })`
   in `update-config.ts` (name freed by slice 6a). Internally composes
   `setConfigEntryInText`; routes the read-modify-write loop to the
   resolved scope path. Tests for each scope.
9. **New I/O primitives** — `unsetConfigEntry` /
   `unsetAllConfigEntries` in `update-config.ts`; new Context-aware
   `renameConfigSection` and `removeConfigSection` (names freed by
   slice 6a; each composes the matching `*InText` helper and accepts
   `scope?`). Tests.
10. **Porcelain read methods** — `configGet` / `configGetAll` /
    `configGetRegexp` / `configList` in
    `src/application/commands/config.ts`. Tests.
11. **Porcelain write methods** — `configSet` / `configUnset` /
    `configUnsetAll` / `configRenameSection` / `configRemoveSection`.
    Tests.
12. **Namespace assembly** — `bindConfigNamespace` in
    `internal/config-namespace.ts`. Tests.
13. **`Repository` interface + factory binding** — add
    `readonly config: ConfigNamespace`; bind in `openRepository`.
14. **Integration + parity** —
    `test/integration/config-lifecycle.test.ts` +
    `test/parity/scenarios/config-crud.scenario.ts` +
    per-scope parity tests with canonical git.
15. **Browser-adapter degradation tests** — verify
    `CONFIG_SCOPE_NOT_AVAILABLE` for `global`/`system` scope methods.
16. **FS validator extension** — ensure the
    `wrapFsValidator` allows the four scope paths (or whitelists
    `homedir()` / `systemConfigPath()` returns) — security audit
    point.
17. **Docs (handled by the PR-phase subagent)** —
    `docs/use/commands/`, `docs/use/recipes.md`, README/RUNBOOK,
    BACKLOG flip.

## 15. Self-review log

### Pass 1 → Pass 2 (original draft)

- §3 split the result envelope per action so `get.value` is `string |
  undefined`, `getAll.values` is `string[]`, and the unset family
  carries `removed: boolean | number`. Result-per-action matches
  the Phase 20.5 `RemoteResult` precedent.
- §4.4–§4.6 added the multi-valued guard explicitly for `set` and
  `unset` (not just `get`).
- §4.8 added the dotted-subsection parsing rule
  (`remote.my.fork.url`) with a worked example.
- §5.2 spelled out the new primitive readers as their own subsection.

### Pass 2 → Pass 3 (original draft)

- Surfaced the `#`/`;`/leading-whitespace writer bug as an open
  question; added per-method test cases; expanded the open-questions
  list from 6 to 12 to cover every load-bearing decision.

### Pass 3 → Pass 4 (original draft)

- Technical-accuracy corrections (regex helper file path; consolidated
  test-folder layout; corrected cross-references; fixed
  `readConfigSections(ctx)` reference; restored `requested`
  discriminator on `configMultipleValues` factory calls).

### Pass 5 — revision against ADRs 181–187

This pass is a substantial rewrite, not a delta. The ADR set
materially changed three load-bearing decisions (surface shape,
scope coverage, writer-vs-porcelain value handling) plus the
primitive surface — affecting nearly every section.

Sections rewritten:

- §1 (goal + non-goals) — restructured around the nine-method
  namespace; non-goals updated to remove `global`/`system`/`worktree`
  (now in scope) and clarify ADR-175 deprecation lands in 20.8.
- §2 (public API) — replaced the action-discriminator with the
  nested namespace; added `scope?` to every input; added per-method
  result types with originating scope on reads; expanded error model
  to six codes; introduced `bindConfigNamespace` and namespace
  assembly mechanism.
- §3 (method catalogue) — rewrote every method's pseudocode against
  the nested-namespace shape; added `scope` handling per method;
  added `renameSection` and `removeSection` as first-class methods
  (per ADR-187 and the original action catalogue).
- §4 (scopes) — completely new section covering scope paths, read
  precedence, write routing, FS adapter capabilities, browser
  degradation, worktree gating.
- §6 (value validation) — updated for ADR-186: control chars
  rejected, but `#`/`;`/leading-ws/embedded `"`/embedded `\` accepted
  and quoted on write.
- §7 (key syntax) — unchanged in substance; renumbered.
- §8 (file format + writer changes) — added §8.1 quoting layer per
  ADR-186.
- §9 (domain ↔ application split) — added the `config-scope.ts`
  internal module; updated the primitive export list per ADR-187
  (added `unsetConfigEntry`/`unsetAllConfigEntries`; promoted
  `renameConfigSection`/`removeConfigSection`); updated the porcelain
  wiring to reflect the nested namespace.
- §10 (testing) — added per-scope parity tests, browser-adapter
  degradation tests, precedence-resolver tests, quoting round-trip
  property tests; updated mutation target list.
- §11 (performance) — updated to reflect per-scope caching (up to
  four file reads per merged `readScopedSections`).
- §12 (security) — added the cross-scope FS-validator extension as
  a security audit point; dropped the ReDoS guard discussion (now
  ADR-185 trust contract).
- §13 (open questions) — replaced with "decisions reached"; the 7
  load-bearing decisions cross-reference ADRs 181-187, and the 5
  adopted-default deferrals (Q.5/Q.7/Q.9/Q.10/Q.12) are recorded
  with one-line rationales.
- §14 (slice list) — expanded from 11 to 17 slices covering the
  FS adapter additions, scope resolver, writer quoting refactor,
  the new primitives, the per-scope parity tests, and the FS
  validator extension.

### Pass 6 (convergence check)

- Cross-checked every "this method takes `scope?`" claim against
  §2's per-input declarations — consistent.
- Cross-checked every error code referenced in §3 against the §2.4
  error model — `CONFIG_MULTIPLE_VALUES` carries the optional
  `scope?` field per ADR-183 §Decision; `CONFIG_VALUE_INVALID`
  documented in §6; `CONFIG_SECTION_NOT_FOUND` declared as thrown
  by the primitive (matching §3.8 / §3.9 pseudocode).
- Verified that the `previousValue` field on `ConfigUnsetResult` is
  declared optional (`previousValue?: string`) — present only when
  `removed: true`, matching the §3.5 pseudocode.
- Verified that `unsetAllConfigEntries` returns the count via the
  primitive's contract (the porcelain just passes through the
  computed `matches.length`); §10.8 mutation tests assert the exact
  count.
- Verified that `bindConfigNamespace` takes `guard` as a parameter
  alongside `ctx` — necessary because every method must call
  `guard()` before proceeding (matching the existing flat-method
  pattern in `openRepository`).
- Confirmed `renameConfigSection` and `removeConfigSection` already
  exist as functions in `update-config.ts` (per §9.2 note); the
  promotion is a re-export + `scope?` parameter, not net-new code.
- Confirmed `system` write privilege handling is documented as
  caller-responsibility, not tsgit-probed (matching ADR-182
  §Negative).

No new diffs in this pass. Converged.

### Pass 7 — absorbed ADR-188 (text-helper `*InText` rename)

- §9.2 — replaced the "OPEN — naming resolution" escalation
  sub-section with §9.2.1 "Naming convention — `*InText` suffix
  (ADR-188)" that locks the rename table and the convention
  (`*InText` = pure text-transform; unsuffixed = I/O primitive).
  Cross-referenced ADR-188.
- §9.2 — updated the post-rename primitive index export block to
  list both the renamed `*InText` helpers and the new I/O primitives
  under their now-free names.
- §14 — inserted slice 6a (text-helper rename), positioned BEFORE
  slices 8–9 (which now introduce the new I/O `setConfigEntry` and
  the other I/O primitives under the freed names). Slices 8–9
  rephrased to reflect that they own the new I/O surface, not an
  audit of the (now-renamed) text-transform helper.

Symbol verification (against `update-config.ts` at `ab51e0a`): the
five rows in the rename table cover `setConfigEntry`,
`setCoreConfigEntry`, `renameConfigSection`, `removeConfigSection`,
and the file-private `applyOperation` orchestrator (renamed and
promoted to `applyConfigOpInText`). `removeConfigEntry` and
`appendConfigEntry` are also pure text-transform helpers in the
same file but are not currently re-exported from `primitives/index.ts`
and are not in scope for this phase; §9.2.1 notes the convention
applies to them if/when promoted.

No further passes anticipated — the absorption is mechanical and
the convention is locked by ADR-188.
