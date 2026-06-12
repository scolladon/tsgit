# `config`

Nested-namespace porcelain for reading and writing git config across all four canonical scopes: `system`, `global`, `local`, `worktree`. Mirrors `git config` semantics byte-for-byte: values are written with git's own `write_pair` quoting/escaping grammar and read with git's full quoted-value grammar (quotes stripped, escapes decoded, continuations honoured), so any NUL-free value survives a round-trip and the on-disk bytes match what canonical git would write.

## Signature

```ts
repo.config: {
  readonly get: (input: { key: string; scope?: ConfigScope }) =>
    Promise<{ key: ConfigKey; value: string | null; scope: ConfigScope } |
            { key: ConfigKey; value: undefined }>;
  readonly getAll: (input: { key: string; scope?: ConfigScope }) =>
    Promise<{ key: ConfigKey; values: ReadonlyArray<{ value: string | null; scope: ConfigScope }> }>;
  readonly getRegexp: (input: { keyPattern: RegExp; valuePattern?: RegExp; scope?: ConfigScope }) =>
    Promise<{ entries: ReadonlyArray<{ key: ConfigKey; value: string | null; scope: ConfigScope }> }>;
  readonly list: (input?: { scope?: ConfigScope }) =>
    Promise<{ entries: ReadonlyArray<{ key: ConfigKey; value: string | null; scope: ConfigScope }> }>;
  readonly set: (input: { key: string; value: string; scope?: ConfigScope }) =>
    Promise<{ key: ConfigKey; value: string; scope: ConfigScope }>;
  readonly unset: (input: { key: string; scope?: ConfigScope }) =>
    Promise<{ key: ConfigKey; scope: ConfigScope; removed: true; previousValue: string | null } |
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
- **Exact subsection identity:** `[s]` and `[s ""]` are distinct sections everywhere. Entry writes targeting `s.k` (subsection `undefined`) never touch `[s ""]` blocks, and vice versa for `s..k` (subsection `''`) — identical to git's identity rule. A write to a missing section appends a new block of the correct form.
- **Empty-section keys:** `parseConfigKey` accepts `..k` → `{section: '', subsection: '', name: 'k'}` and `.x.k` → `{section: '', subsection: 'x', name: 'k'}`, representing the `[ ""]` and `[ "x"]` header families. The subsection-less form `.k` remains refused with `CONFIG_KEY_INVALID` reason `'empty-section'`, matching git's refusal.
- **Section-op old-name matching (raw, byte-exact, case-sensitive):** `removeSection` and `renameSection` match the old name against each header's raw dotted form: `[s]` → `s`, `[s "x"]` → `s.x`, `[s ""]` → `s.`, `[ ""]` → `.`, `[ "x"]` → `.x`. Plain names (no dot) and cross-family renames (`s → t.y`, `s.x → t`, etc.) are all supported. The old name is never validated — a case mismatch or malformed name simply misses all headers (`CONFIG_SECTION_NOT_FOUND`), matching git. All matching blocks are renamed or removed (multi-block support), including git's faithful `a.b` ambiguity: the deprecated `[a.b]` header and `[a "b"]` share the raw name `a.b`, so both match. The error carries the raw input verbatim (ADR-324).
- **Section-op new-name grammar:** the new name is parsed at the **first** dot — section part before, subsection (free-form) after. The section part must contain only alphanumeric / `-` chars; an empty whole name is refused; an empty section part is allowed when a dot follows (e.g. `.x` is valid). Grammar violations throw `INVALID_OPTION` with reason `invalid section name: <name>` (ADR-322). A newline in the new subsection is refused too (`INVALID_OPTION`, reason `subsection must not contain a newline or NUL`) — a deliberate divergence from git, which writes the newline raw and corrupts its own file (ADR-325).
- **Valueless keys (git NULL parity):** a `key` line with no `=` is a present-but-valueless entry — surfaced as `value: null`, distinct from `value: undefined` (key absent) and `''` (empty value after `key =`). Boolean interpretation maps `null` to `true` (`[core]` + `bare` ⇒ bare repository), and `getRegexp`'s `valuePattern` matches a `null` value as the empty string — both exactly like git (ADR-314). A malformed no-`=` line (`key ; c`, `bad!key`, `9key`) throws `CONFIG_PARSE_ERROR` where git dies `bad config line N`. Writes never emit valueless entries (git's CLI cannot either); `set` on a valueless entry replaces the line with canonical `key = value`, `unset` removes it (`previousValue: null`).
- **Worktree scope:** gated on `[extensions] worktreeConfig = true` in `local`; otherwise throws `CONFIG_SCOPE_NOT_AVAILABLE`.
- **Browser adapter:** `global` and `system` scopes throw `CONFIG_SCOPE_NOT_AVAILABLE` with `reason: 'browser-adapter'`.
- **Quote-on-write (git `write_pair` parity):** a value is wrapped in `"…"` iff it starts or ends with a space or contains `;`, `#`, or CR; `\` / `"` / LF / TAB are always escaped (`\\`, `\"`, `\n`, `\t`), quoted or not; CR and other control bytes are written raw (ADR-309, supersedes ADR-186's rules). Only NUL is rejected, with `CONFIG_VALUE_INVALID`.
- **Quoted-value read:** the reader decodes git's full value grammar — surrounding quotes stripped, quote spans concatenated, `\n`/`\t`/`\b`/`\"`/`\\` decoded, unquoted `#`/`;` starting comments, backslash-newline continuations. A malformed value (unknown escape, unclosed quote) throws `CONFIG_PARSE_ERROR` with the 1-based line and file, mirroring git's `fatal: bad config line N in file F` (ADR-308).
- **Subsection names (git `get_extended_base_var` / `write_section` parity):** inside `[section "subsection"]` the reader decodes `\c` → `c` verbatim (no named escapes — `\t` is `t`); `]`, `#`, `;`, and CR are literal inside the quotes. The writer escapes only `\` and `"`; every other byte is written raw. Subsections may contain any byte except LF and NUL. A malformed quoted header (no whitespace before the quote, junk or space between the closing quote and `]`, unclosed quote, `\` at end of line) throws `CONFIG_PARSE_ERROR` exactly where git dies (ADR-312).
- **Writes onto malformed files (per-operation git parity):** `set`/`unset`/`unsetAll` parse the file before any surgery — a malformed quoted header refuses with `CONFIG_INVALID_FILE` (git's `invalid section name '<partial>'` + `invalid config file`), a malformed value with the read-shape `CONFIG_PARSE_ERROR`; nothing is written. `renameSection`/`removeSection` are line-based and lenient like git's `copy_or_rename` machinery — they succeed on malformed files, and a malformed header never matches a source section (ADR-313).

## Errors

- `CONFIG_KEY_INVALID` — `key` failed `parseConfigKey` validation.
- `CONFIG_VALUE_INVALID` — `value` contains NUL (the only byte git's grammar cannot represent).
- `CONFIG_PARSE_ERROR` — a config file contains a malformed value (unknown escape, unclosed quote) or a malformed quoted-subsection header; carries the 1-based `line`, the file as `source`, and (for header malformations) the partially-accumulated `partialSectionName`.
- `CONFIG_INVALID_FILE` — a `set`/`unset` write refused because the file holds a malformed quoted-subsection header; carries `sectionName` (git's `invalid section name` diagnostic) and `source`.
- `CONFIG_MULTIPLE_VALUES` — single-value operation (`get` / `set` / `unset`) on a multi-valued key.
- `CONFIG_SECTION_NOT_FOUND` — `renameSection` / `removeSection` old-name lookup missed all headers (no section header matched the raw dotted old-name); carries the raw input verbatim (e.g. `'s.'`, `'.'`, `'bad!name'`), matching git's `fatal: no such section: <name>` diagnostic.
- `INVALID_OPTION` — `renameSection` new-name validation failed: section-grammar violations carry reason `invalid section name: <name>`; a newline/NUL in the new subsection carries reason `subsection must not contain a newline or NUL`.
- `CONFIG_SCOPE_NOT_AVAILABLE` — `worktree` scope without the extension, or `global`/`system` on the browser adapter.
- `CONFIG_SYSTEM_PATH_UNRESOLVED` — platform-specific system-config path could not be resolved.
- `NOT_A_REPOSITORY` — `ctx` does not target a repository.

## Design + ADRs

- `docs/design/phase-20-6-config-porcelain.md`
- `docs/design/config-empty-subsection-matching.md` (section identity and addressing)
- `docs/adr/181-nested-namespace-porcelain.md` (surface shape)
- `docs/adr/182-config-all-scopes-v1.md` (scopes)
- `docs/adr/183-config-get-multi-valued-throws.md`
- `docs/adr/184-config-unset-idempotent.md`
- `docs/adr/185-config-getregexp-javascript-regex.md`
- `docs/adr/186-config-write-quote-on-write.md`
- `docs/adr/187-config-primitives-keep-writers-add-readers.md`
- `docs/adr/188-config-text-helper-rename.md`
- `docs/adr/308-config-parse-error-refusal.md` (malformed values refuse like git)
- `docs/adr/309-config-value-write-grammar-parity.md` (byte-exact `write_pair` grammar)
- `docs/adr/312-config-subsection-header-grammar-parity.md` (subsection grammar)
- `docs/adr/313-config-write-path-refusal-shapes.md` (write-path refusals)
- `docs/adr/314-valueless-config-key-null-representation.md` (valueless keys are `value: null`)
- `docs/adr/315-valueless-string-config-fields-absent.md` (valueless string-typed internals)
- `docs/adr/322-empty-subsection-section-op-addressing.md` (trailing-dot addressing of `[s ""]`)
- `docs/adr/323-fold-section-addressing-gaps-into-empty-subsection-fix.md` (identity and addressing gaps)
- `docs/adr/324-raw-section-name-matching.md` (byte-exact old-name matching)
- `docs/adr/325-refuse-linefeed-in-new-subsection.md` (LF refusal in new subsection)
- `docs/adr/326-reshape-section-op-intext-primitives.md` (exported section-op primitive signatures)
- `docs/design/config-subsection-escaping.md`
- `docs/design/config-valueless-keys.md`
