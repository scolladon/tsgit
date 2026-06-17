# ADR-354: Int-typed valueless config refusal — `CONFIG_BAD_NUMERIC_VALUE`, a distinct shape riding the eager-broad gate with cross-class file-line ordering

## Status

Accepted (2026-06-17)

- **Design:** `docs/design/int-config-valueless-refusal.md`
- **Refines:** ADR-329 (closes the deferred int-typed refusal); **parallels** ADR-328 (the string `CONFIG_MISSING_VALUE` shape), ADR-327 (the cold-path detection enabler), ADR-346 (the eager-broad `[core]` gate)
- **Depends on:** ADR-353 (the int key this refuses on)

## Context

git's int-typed valueless death is a **different observable shape** from the string-typed `missing value` death pinned by ADR-328. For a valueless `core.loosecompression` (git 2.54.0, `od -c`, exit 128):

```
fatal: bad numeric config value '' for 'core.loosecompression' in file .git/config: invalid unit
```

It is a **single** `fatal:` line (no `error:` prefix), the file token is **unquoted**, and there is **no `at line N`** — versus the string shape's two lines, quoted file token, and `at line`. The prime directive (refusal conditions are byte-for-byte faithful; ADR-249: the library emits the structured data, the interop test reconstructs the line) therefore requires its **own error code**, not an overload of `CONFIG_MISSING_VALUE`.

Pinned facts that shape the gate:

- A valueless `core.loosecompression`/`core.compression` dies in git's `git_default_config` at config load — the **same** eager-broad operational surface (`status`, `log`, `branch`, `tag`, `for-each-ref`, `cat-file`, `show`, `rev-parse`, `add`) that 24.9r's gate already covers, and is bypassed by the same config porcelain (`config --list`/`--get`/`--get-regexp` succeed, the key visible as `value: null`).
- When a valueless **string** `[core]` key and a valueless **int** `[core]` key co-exist, git reports whichever is **earlier by config-file line**, across both classes (pinned: order A `excludesfile` then `loosecompression` → the string shape; order B `loosecompression` then `excludesfile` → the int shape). Both share `git_default_config`'s per-entry callback, so file-line order — not key class — decides.

## Options considered

**Error code (decision 2):**

1. **`CONFIG_BAD_NUMERIC_VALUE { key, source, value, reason }`** (designer's recommendation) — pros: carries every byte the interop test reconstructs (`value` and `reason` vary across git's int suffixes), mirrors git's message fields 1:1, room for the deferred third reason; cons: a third config error code.
2. **`CONFIG_BAD_NUMERIC_VALUE { key, source }` only** (hardcode `value:''`, `reason:'invalid unit'`) — pros: minimal; cons: cannot represent `out of range` / non-empty values, forcing a reshape later.
3. **Extend `CONFIG_MISSING_VALUE` with a `numeric?` discriminator** — pros: no new code; cons: conflates two genuinely different git messages (line count, prefix, file-token quoting, presence of `line`); the int shape has no `line` field — a structural mismatch.

**Cross-class ordering (decision 6):**

1. **A new union-aware finder** — pros: conceptually clean; cons: a second primitive paralleling the proven `findFirstValuelessEntry` for a rare case.
2. **Two finder calls + `line` compare** (designer's recommendation) — pros: zero new primitive, reuses `findFirstValuelessEntry`, mutation-friendly; cons: two cold-path scans.
3. **Fixed string-then-int order** — pros: simplest; cons: a real refusal-condition divergence (order B would report the wrong key) — the prime directive forbids it.

## Decision

**Error code = option 1.** A new domain `CommandError` variant `CONFIG_BAD_NUMERIC_VALUE { code, key, source, value, reason }` with factory `configBadNumericValue(...)` in `domain/commands/error.ts`, rendered in `domain/error.ts` as:

```
bad numeric config value '<value>' for '<key>' in file <source>: <reason>
```

— **unquoted** file token, **no** `at line`. `reason ∈ { 'invalid unit', 'out of range' }` (a future `'bad zlib compression level'` would extend the union when ADR-353's deferred range-check lands). For the valueless case `value` is `''` and `reason` is `'invalid unit'`.

**Detection reuses ADR-327's enabler.** A sibling int guard finds the first valueless int entry via the existing `findFirstValuelessEntry` (identical NULL detection) and throws `configBadNumericValue(found.key, found.source, '', 'invalid unit')`. The valueless case keeps merging as absent at read time (ADR-315 D4 unchanged) — the refusal is **not** at merge time (porcelain must survive); it rides the eager gate.

**Cross-class ordering = option 2.** The int keyset must **not** be added to the string `assertNoValuelessConfig(...,['excludesfile','attributesfile'])` call (it would throw the wrong, string-shaped error), and a fixed string-then-int call order would always report the string key (wrong under order B). The gate runs the string finder and the int finder over their respective keysets and throws the shape of whichever first-valueless entry has the **lower config-file line** — reproducing git's per-entry callback order. Wired into the eager-broad `[core]` gate (`repo-state.ts`) next to the existing `assertNoValuelessCorePaths`.

## Consequences

### Positive

- Faithful int-typed valueless refusal on exactly git's operational surface; closes ADR-329's int deferral.
- The two refusal shapes (string `CONFIG_MISSING_VALUE`, int `CONFIG_BAD_NUMERIC_VALUE`) coexist under `[core]` without bleeding, in git's file-line order.
- Pure-additive on the proven 24.9r eager gate and ADR-327 finder — no schema change, no `ParsedConfig`/porcelain ripple.

### Negative

- A third config error code (`CONFIG_BAD_NUMERIC_VALUE`), and two cold-path finder scans when both key classes are present (bounded — config is `Context`-stable mid-command).

### Neutral

- Valued-but-invalid int refusal is split by scope: the parser surfaces `out of range` (ADR-353), but no consumer triggers it until a follow-up; the consumer-specific `bad zlib compression level` death is deferred (ADR-353). The valueless `invalid unit` case — 24.9s's named requirement — is delivered in full.
- The int key stays `value: null` on the porcelain read surface (ADR-314); `config --get`/`--list`/`--get-regexp` are unaffected.
