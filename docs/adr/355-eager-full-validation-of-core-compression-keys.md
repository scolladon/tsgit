# ADR-355: Eager full validation of core compression keys (full git parity)

## Status

Accepted (2026-06-17)

- **Design:** `docs/design/int-config-valueless-refusal.md`
- **Supersedes:** the deferred under-refusals recorded in ADR-353 (parser-scope deferral / "deferred-refusal safety guard") and ADR-354 (valueless-only refusal, `reason` enum without the zlib shape)
- **Depends on:** ADR-353 (the int key + `parseGitInt`), ADR-354 (the `CONFIG_BAD_NUMERIC_VALUE` shape)

## Context

ADR-353/354 (decision 4 = b) shipped the int key with the **valueless** refusal only, deferring two consumer-facing divergences as a documented under-refusal: a valued-but-unparseable int and a valid int outside zlib's range were silently treated as the adapter default rather than refused. During the documentation phase the user reversed that deferral (decision 4 → full parity): close both gaps in this change.

git validates `core.loosecompression` and `core.compression` **eagerly** in `git_default_config` (every operational command; `config --get`/`--list` survive), **independently** (an invalid `compression` dies even when `loosecompression` is valid), and dies on the **first failing `[core]` entry by config-file line** — across both the string path-likes and the compression keys. Pinned against git 2.54.0 (mktemp, scrubbed env):

| `core.loosecompression` value | git stderr (first line) | shape |
|---|---|---|
| valueless / `abc` / `1.5` / `5x` | `fatal: bad numeric config value '<v>' for 'core.loosecompression' in file <F>: invalid unit` | `CONFIG_BAD_NUMERIC_VALUE` (value, `invalid unit`) |
| `999999999999999999999999` | `fatal: bad numeric config value '<v>' … : out of range` | `CONFIG_BAD_NUMERIC_VALUE` (value, `out of range`) |
| `10` / `99` / `100` / `-2` | `fatal: bad zlib compression level <N>` | **new** bare shape (no key/file) |
| `-1` / `0` / `9` | exit 0 | valid (honoured) |

## Options considered

1. **Eager full validation, new `CONFIG_BAD_ZLIB_LEVEL { level }` code** (chosen) — pros: byte-for-byte git parity on every shape; the bare `bad zlib compression level` message has no `key`/`source`/`value`, structurally unlike `CONFIG_BAD_NUMERIC_VALUE`, so a distinct code mirrors git's own message split (same argument ADR-354 used vs overloading `CONFIG_MISSING_VALUE`); cons: a fourth config error code.
2. **Fold the zlib level into `CONFIG_BAD_NUMERIC_VALUE` as a third `reason`** — pros: no new code; cons: the message carries no `value`/`key`/`source` token, so the render would have to special-case the reason and emit empty fields — a structural mismatch the discriminated union should not hide.
3. **Keep deferring (status quo)** — rejected by the user.

## Decision

**Option 1.** Add `CONFIG_BAD_ZLIB_LEVEL { code, level }` (factory `configBadZlibLevel`, render `bad zlib compression level ${level}` — no key/file token, matching git's bare message). The eager `[core]` gate (`repo-state.ts`) now performs git's **full** validation of `core.loosecompression`/`core.compression` rather than detecting only valueless entries: for each compression entry in file order it runs `parseGitInt` (valueless `''`/unparseable → `invalid unit`; over int64 → `out of range`) and then the zlib-range check (`level < -1 || level > 9` → `bad zlib compression level`). The gate reports the **first failing `[core]` entry by config-file line** across the string path-likes (valueless → `CONFIG_MISSING_VALUE`) and the compression keys — extending ADR-354's two-class line compare to "first failure wins."

`parseGitInt` is unchanged (already complete for `invalid unit` + `out of range`). The zlib `-1..9` domain is a single shared bound used by both the gate (to refuse) and `write-object`'s honour guard (which stays as a defensive fallback for any non-operational direct primitive path). ADR-353's "deferred-refusal safety guard" framing is superseded: an out-of-zlib value is now **refused** on every operational command, not silently defaulted.

## Consequences

### Positive

- Full byte-for-byte parity with git's `git_default_config` compression-key validation; no remaining documented under-refusal for these keys.
- Mirrors git's message structure: the bare `bad zlib compression level` gets its own code, the numeric-parse shapes keep `CONFIG_BAD_NUMERIC_VALUE`.
- The "first failing `[core]` entry by line" gate is the faithful generalisation of git's per-entry config-callback order.

### Negative

- A fourth config error code (`CONFIG_BAD_ZLIB_LEVEL`); the eager gate now reads compression values (not just detects null), a slightly larger cold-path walk (still over the cached token stream, once per operational command).

### Neutral

- `ParsedConfig.core.looseCompression` still holds the parsed int for valid-parse values; `write-object` continues to honour only the `-1..9` domain (now belt-and-suspenders behind the eager refusal). Porcelain (`config --get`/`--list`) is unaffected — it never invokes the gate.
