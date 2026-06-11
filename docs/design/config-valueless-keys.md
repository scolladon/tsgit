# Design — Valueless config keys

## Goal

Close the valueless-key faithfulness gap in the shared git-config tokenizer (backlog 24.9h, surfaced by 24.9c):

- A `key` line with no `=` inside a section is a **boolean-true entry** in git (`[core]` + `bare` ⇒ `core.bare = true`, internal value NULL); tsgit's `parseIniSections` silently skips the line.
- The same no-`=` path also swallows lines git **refuses** (`key ; comment`, `bad!key`, `9key`) — git's `get_value` applies the key grammar before deciding the line is valueless.

Both halves of one grammar (`get_value`'s key scan): record what git records, refuse what git refuses.

## git's exact behaviour (pinned against git 2.54.0)

All pinned empirically via `git config --file` with a scrubbed environment (isolated `HOME`, `GIT_CONFIG_NOSYSTEM=1`).

### The no-`=` line grammar (`get_value`)

After leading whitespace, git collects `iskeychar` chars (alnum + `-`, first char must be alpha — checked by the caller), then skips **only** space/TAB, then requires `\n` (CRLF folds to `\n`) or `=`. Anything else is `fatal: bad config line N in file F`.

| Input line (in `[a]`) | Result | Note |
| --- | --- | --- |
| `key` | `a.key` valueless (value NULL) | |
| `key␠␠␠` / `key⇥` | `a.key` valueless | trailing space/TAB skipped |
| `key\r\n` | `a.key` valueless | CRLF folded |
| `With-CAPS` | `a.with-caps` valueless | key lowercased on read (existing behaviour: preserved + compared case-insensitively) |
| `key ; c` / `key # c` | **fatal bad config line** | comments are NOT legal after a valueless key |
| `key\r␠` | **fatal bad config line** | lone CR after key is not skippable whitespace |
| `bad!key` / `9key` / `-key` / `under_score` | **fatal bad config line** | key grammar: `[a-zA-Z][a-zA-Z0-9-]*` |
| `orphan` (before any section) | accepted: key `orphan`, no section | pre-existing divergence class — tsgit drops sectionless entries (see Scope boundaries) |

### Valueless semantics at the read surfaces

| Surface | git behaviour |
| --- | --- |
| `--list` / `--get-regexp` | renders the bare key with **no `=`** (`core.bare`); an empty-string value renders `x.empty=` — the two are distinct states |
| `--list -z` | `a.key\0` — no `\n` separator before the (absent) value |
| `--get` | exit 0, prints empty line |
| `--type=bool` | valueless → `true`; empty `=` → `false` |
| `--get-regexp <key-pat> <value-pat>` | the NULL value matches value patterns as the **empty string** (`'^$'` matches, `'val'` does not) |
| `--type=int` | `fatal: bad numeric config value '' for 'a.num' in file F: invalid unit` |
| internal string-typed read (e.g. `user.name` during `rev-parse --is-bare-repository` startup) | `error: missing value for 'user.name'` + `fatal: bad config variable 'user.name' in file F at line N` — lazy, at **use** time; `--list` on the same file succeeds |
| `core.bare` valueless | `rev-parse --is-bare-repository` → `true` |

### Write surgery on files containing valueless entries

| Operation | git behaviour (pinned bytes) |
| --- | --- |
| `git config a.key replaced` on `\tkey` | line replaced with `\tkey = replaced` (canonical entry rendering) |
| `git config --unset a.key` on `\tkey` | line removed |
| `git config --rename-section a b` | valueless body lines preserved verbatim |

git's CLI has **no way to write** a valueless entry; writes always emit `key = value`.

## Decisions

### D1 — Representation: `value: string | null` (ADR-314)

`IniSection` entries widen to `{ key: string; value: string | null }` — `null` is git's internal NULL (key present, no `=`). The widening ripples verbatim through every structured read surface: `collectValues` / `collectScopedValues`, `ConfigEntryView.value`, `ConfigGetResult`'s present arm, `ConfigGetAllResult.values[].value`, `ConfigUnsetResult.previousValue`.

`undefined` keeps its existing meaning — **key absent** (`ConfigGetResult`'s absent arm) — so the three states are distinguishable exactly as in git: absent (`undefined`), valueless (`null`), valued (`string`, possibly `''`). `null` survives JSON serialization, which `undefined` would not — load-bearing for a structured-data library (ADR-249: the caller reconstructs `core.bare` vs `core.bare=` from the field).

Alternatives rejected: a discriminated entry union (`{kind:'valued'}/{kind:'valueless'}`) taxes every existing consumer for a two-state field; coercing to `'true'` is unfaithful (breaks `--list` reconstruction and the empty-vs-valueless bool distinction).

### D2 — Grammar enforcement scoped to the no-`=` path

The new key-grammar check (`^[ \t\r]*[a-zA-Z][a-zA-Z0-9-]*[ \t]*\r?$`, the trailing `\r` only as the final char of a CRLF line) applies **only** to lines with no effective `=`. Violations throw `CONFIG_PARSE_ERROR { line, source }` — git's `bad config line N in file F` (same shape as ADR-308 value malformations).

The `=`-path stays lenient (no key validation), and lines whose first non-space char is `[` keep their current three-state header handling (header / malformed-quoted / lenient skip) — **evidence-forced**: git's parser is char-wise, so `[a] key = v` and `[a] key` parse as a header *plus* an entry on one line. A line-wise key validator would refuse those, introducing refusals git doesn't have. Same-line header+entry constructs and `=`-path key grammar stay a known divergence, recorded as a backlog follow-up (with the existing line-wise-vs-char-wise bucket).

Within the non-`[` no-`=` class this grammar is exact: everything it accepts git accepts (valueless entry), everything it refuses git refuses (pinned matrix above).

### D3 — Boolean semantics

`parseGitBoolean` widens to `(value: string | null) => boolean` with `null → true` (git's `git_config_bool(NULL) == 1`). Every bool-typed `ParsedConfig` consumer (`core.bare`, `core.sparseCheckout`, `core.sparseCheckoutCone`, `remote.*.promisor`, `submodule.*.active`) and `parseLogAllRefUpdates` inherit `bare ⇒ true` through it.

### D4 — String-typed `ParsedConfig` fields treat valueless as absent (ADR-315)

git dies lazily at **use** time for string-typed keys (`missing value for 'user.name'`) while `--list` on the same file succeeds. tsgit's `readConfig` merges eagerly into `ParsedConfig`, so faithful per-use refusal would have to thread a missing-value marker through every consumer — feature-sized. Decision: string-typed merge fields (`user.name`, `remote.*.url`, `branch.*.merge`, `merge.*.driver`, …) **skip** a `null` value (field stays unset), so e.g. `commit` with a valueless `user.name` refuses through the existing identity-not-configured path rather than git's exact `missing value` message. Documented divergence + backlog follow-up; the raw `null` stays visible to porcelain readers, so no data is lost. Multi-value `remote.*.fetch` skips `null` likewise. Int-typed config keys: none are merged today (n/a).

### D5 — Writer surgery recognises valueless lines

`isKeyLine` learns the valueless line shape (entire line matches the key, case-insensitively, no `=`) so:

- `set` on an existing valueless entry **replaces** the line with the canonical `\t<key> = <value>` (pinned bytes);
- `unset` / `unset-all` **remove** the line;
- `rename-section` / `remove-section` need no change (body lines pass through / are dropped wholesale).

`collectValues`-driven existence checks (`configUnset` previous-value, multiplicity guards) see valueless entries via D1. The writer gains **no** ability to emit valueless entries (git's CLI cannot; YAGNI) — `ConfigEntry.value` and `setConfigEntry` inputs stay `string`.

### D6 — Sectionless (orphan) keys stay dropped

git accepts a key line before any section header (qualified key has no section). tsgit drops entries when no section is open — pre-existing divergence, orthogonal to valuelessness (it equally affects `orphan = v`). Unchanged here; backlog follow-up. The grammar check still applies to orphan lines (a malformed orphan line refuses, like git); a *valid* orphan key is skipped silently.

## Ripple inventory

| Site | Change |
| --- | --- |
| `config-read.ts` `IniSection`/`SectionBuilder` | `value: string \| null` |
| `config-read.ts` `parseIniSections` | no-`=` branch: grammar check → push `{key, value: null}` / throw `configParseError` |
| `config-read.ts` `parseGitBoolean`, `parseLogAllRefUpdates` | accept `null` (→ `true`; `'always'` impossible for `null`) |
| `config-read.ts` merge functions | string fields: skip `null`; bool fields: flow through `parseGitBoolean` |
| `internal/config-key.ts` `collectValues`/`collectScopedValues` | value type widens |
| `config-scoped-read.ts` `getConfigValue`/`getAllConfigValues` | present-arm `value: string \| null` |
| `commands/config.ts` `ConfigEntryView`, `ConfigGetResult`, `ConfigGetAllResult`, `ConfigUnsetResult.previousValue` | widen to `string \| null` |
| `commands/config.ts` `configGetRegexp` | `valuePattern.test(entry.value ?? '')` (pinned: NULL matches as `''`) |
| `update-config.ts` `isKeyLine` | match valueless lines too |
| `parse-gitmodules.ts` `mergeKey` | string fields skip `null` |
| `commands/internal/sequencer-state.ts` | type-level handling only (tsgit-written files never contain valueless entries) |
| `reports/api.json` | regenerate (public type change) |

## Test plan

- **Unit (`config-read.test.ts` area)** — valueless entry recorded with `null`; trailing ws / CRLF accepted; refusal matrix (`key ; c`, `key # c`, `bad!key`, `9key`, `-key`, `under_score`, `key\r␠`) each asserting `CONFIG_PARSE_ERROR` `.data.line` + `.data.source` individually (mutation-resistant); orphan valid key dropped, orphan junk refused; `[`-prefixed non-header lines keep lenient skip; bool semantics `null → true`, `'' → false`; string merge fields skip `null`.
- **Unit (writer)** — set-on-valueless replaces the line; unset removes it; multiplicity guards count valueless entries; rename keeps them verbatim.
- **Interop (`config-interop.test.ts`)** — twin git/tsgit: `--list` reconstruction from structured entries (bare key vs `key=`); `core.bare` valueless ⇒ both report bare=true; refusal-line parity across the bad-line matrix (same 1-based line numbers); write parity (set-on-valueless, unset-valueless, rename-section) byte-identical files; `--get-regexp` value-pattern-vs-NULL parity.
- **Property (`config-read.properties.test.ts` area)** — lens 1 (round-trip/grammar): for an arbitrary valid key name, `parseIniSections('[s]\n\t<key>\n')` yields one entry with `value: null`; for an arbitrary valid key + junk suffix from the refused-char class, parse refuses; a `set` on an unrelated key preserves valueless lines byte-for-byte (writer property extension).

## Scope boundaries (out)

- Same-line header+entry (`[a] key = v`) and `=`-path key grammar — line-wise-vs-char-wise rework, backlog follow-up.
- Sectionless (orphan) key recording — backlog follow-up (D6).
- Per-use-site `missing value for '<key>'` refusal parity for string-typed internal reads — backlog follow-up (D4).
- Writing valueless entries — git's CLI cannot; not a surface.
