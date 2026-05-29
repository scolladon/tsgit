# `config`

Nested-namespace porcelain for reading and writing git config across all four canonical scopes: `system`, `global`, `local`, `worktree`. Mirrors `git config` semantics; values are quoted on write so `#`, `;`, embedded `"`, leading/trailing whitespace, and `\n` survive a round-trip.

## Signature

```ts
repo.config: {
  readonly get: (input: { key: string; scope?: ConfigScope }) =>
    Promise<{ key: ConfigKey; value: string; scope: ConfigScope } |
            { key: ConfigKey; value: undefined }>;
  readonly getAll: (input: { key: string; scope?: ConfigScope }) =>
    Promise<{ key: ConfigKey; values: ReadonlyArray<{ value: string; scope: ConfigScope }> }>;
  readonly getRegexp: (input: { keyPattern: RegExp; valuePattern?: RegExp; scope?: ConfigScope }) =>
    Promise<{ entries: ReadonlyArray<{ key: ConfigKey; value: string; scope: ConfigScope }> }>;
  readonly list: (input?: { scope?: ConfigScope }) =>
    Promise<{ entries: ReadonlyArray<{ key: ConfigKey; value: string; scope: ConfigScope }> }>;
  readonly set: (input: { key: string; value: string; scope?: ConfigScope }) =>
    Promise<{ key: ConfigKey; value: string; scope: ConfigScope }>;
  readonly unset: (input: { key: string; scope?: ConfigScope }) =>
    Promise<{ key: ConfigKey; scope: ConfigScope; removed: true; previousValue: string } |
            { key: ConfigKey; scope: ConfigScope; removed: false }>;
  readonly unsetAll: (input: { key: string; scope?: ConfigScope }) =>
    Promise<{ key: ConfigKey; scope: ConfigScope; removed: number }>;
  readonly renameSection: (input: { oldName: string; newName: string; scope?: ConfigScope }) =>
    Promise<{ oldName: string; newName: string; scope: ConfigScope }>;
  readonly removeSection: (input: { name: string; scope?: ConfigScope }) =>
    Promise<{ name: string; scope: ConfigScope }>;
};

type ConfigScope = 'system' | 'global' | 'local' | 'worktree';
```

## Examples

```ts
// read a single value
const { value } = await repo.config.get({ key: 'user.email' });

// read across all scopes (precedence: system → global → local → worktree)
const allEmails = await repo.config.getAll({ key: 'user.email' });

// scope-filtered read
const localOnly = await repo.config.get({ key: 'user.name', scope: 'local' });

// write
await repo.config.set({ key: 'user.email', value: 'me@example.com' });

// idempotent removal
const r = await repo.config.unset({ key: 'user.signingkey' });
// r.removed is true (with previousValue) or false (with no previousValue)

// regex-filtered enumeration
const urls = await repo.config.getRegexp({ keyPattern: /^remote\..*\.url$/ });

// full-scope dump
const everything = await repo.config.list();
```

## Behaviour notes

- **Scope default:** writes target `local` unless `scope` is set. Reads merge across all active scopes when `scope` is omitted.
- **Multi-valued keys:** `get` and `set` throw `CONFIG_MULTIPLE_VALUES` when the key has more than one entry in the active scope set. Use `getAll` / `unsetAll` for multi-valued keys.
- **Idempotent `unset`:** a missing key produces `{ removed: false }`, not an error (diverges from `git config --unset` exit-5).
- **Regex flavour:** `getRegexp` uses native JavaScript `RegExp`; not POSIX-ERE (ADR-185).
- **Worktree scope:** gated on `[extensions] worktreeConfig = true` in `local`; otherwise throws `CONFIG_SCOPE_NOT_AVAILABLE`.
- **Browser adapter:** `global` and `system` scopes throw `CONFIG_SCOPE_NOT_AVAILABLE` with `reason: 'browser-adapter'`.
- **Quote-on-write:** values containing `#`, `;`, leading/trailing whitespace, embedded `"`, `\`, or `\n` are wrapped in `"…"` with `\\` / `\"` / `\\n` escapes (ADR-186). NUL and CR are rejected with `CONFIG_VALUE_INVALID`.

## Errors

- `CONFIG_KEY_INVALID` — `key` failed `parseConfigKey` validation.
- `CONFIG_VALUE_INVALID` — `value` contains a banned control character (NUL or CR).
- `CONFIG_MULTIPLE_VALUES` — single-value operation (`get` / `set` / `unset`) on a multi-valued key.
- `CONFIG_SECTION_NOT_FOUND` — `renameSection` / `removeSection` target missing.
- `CONFIG_SCOPE_NOT_AVAILABLE` — `worktree` scope without the extension, or `global`/`system` on the browser adapter.
- `CONFIG_SYSTEM_PATH_UNRESOLVED` — platform-specific system-config path could not be resolved.
- `NOT_A_REPOSITORY` — `ctx` does not target a repository.

## Design + ADRs

- `docs/design/phase-20-6-config-porcelain.md`
- `docs/adr/181-nested-namespace-porcelain.md` (surface shape)
- `docs/adr/182-config-all-scopes-v1.md` (scopes)
- `docs/adr/183-config-get-multi-valued-throws.md`
- `docs/adr/184-config-unset-idempotent.md`
- `docs/adr/185-config-getregexp-javascript-regex.md`
- `docs/adr/186-config-write-quote-on-write.md`
- `docs/adr/187-config-primitives-keep-writers-add-readers.md`
- `docs/adr/188-config-text-helper-rename.md`
