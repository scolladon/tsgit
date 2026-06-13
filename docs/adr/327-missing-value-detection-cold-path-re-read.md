# ADR-327: Valueless string-config refusal detects via a cold-path raw re-read, not `ParsedConfig` threading

## Status

Accepted (at `f72d2177`)

## Context

git dies lazily when a string-typed config key holds a NULL (valueless) value, at the **use** site that reads it (`error: missing value for 'user.name'` + `fatal: bad config variable …`), while porcelain reads succeed. tsgit's `readConfig` eagerly merges into `ParsedConfig`, and ADR-315 (D4) scoped valueless string fields to be **skipped** — so both *absent* and *valueless* collapse to `undefined`, and no line/source provenance survives for a faithful refusal.

To refuse with git's shape, a consuming command must learn (a) that the key is present-but-null and (b) its 1-based line + source file. Two mechanisms were weighed:

1. **Re-read raw tokens** on the refusal path — a helper re-tokenizes the local config and returns the first valueless entry (by line) among the target keys.
2. **Thread a present-but-null marker** through `ParsedConfig` — widen `IniSection` (+ line) and the merged string fields to a provenance shape so consumers branch on it.

`IniSection` is shared with `.gitmodules` parsing; `ParsedConfig` is the public merged-config type feeding every command and `reports/api.json`.

## Decision

Detect via mechanism 1. A new application primitive `findFirstValuelessEntry(ctx, section, subsection, keys)` re-tokenizes the repo-local config (`${commonGitDir}/config`, via the existing `tokenizeConfig`, whose `entry` tokens already carry `startLine`) and returns `{ key, source, line }` for the **first valueless entry by config-file line** among `keys`, or `undefined` (key absent or valued). It runs **only on the refusal path** — when the field is unset, i.e. the path that today throws `AUTHOR_UNCONFIGURED`/`REMOTE_NOT_CONFIGURED`. `ParsedConfig` and `IniSection` are **unchanged**; ADR-315 D4 stays intact (`readConfig` remains a clean value projection).

The file-line scan order reproduces git's per-entry config-callback ordering (pinned: the refusal trips on the first valueless `user.*` entry by line, not by a fixed name-before-email read order).

## Consequences

### Positive

- `ParsedConfig`/`IniSection`/`api.json` untouched; no public-type ripple, no `.gitmodules` collateral. ADR-315 D4 preserved (valueless = absent on the merged view; the raw `null` stays visible on the porcelain read per ADR-314).
- CQS-clean: the effective-value query (`readConfig`) and the diagnostic-provenance query (`findFirstValuelessEntry`) stay separate.
- An **enabler** for the deferred breadth (ADR-329): each new refusal site is one additive call with a different `(section, keys)` — no schema change.
- Mirrors git's own architecture (lazy per-accessor validation over a clean config store) — the faithfulness anchor.

### Negative

- A second tokenize pass on the cold path (only when identity/remote is unset). Bounded and consistent within a `Context` (the config does not change mid-command); a micro-perf footnote, not a structural cost.

### Neutral

- The helper couples the command to the config tokenizer (`tokenizeConfig` + `commonGitDir`) along the sanctioned `command → primitive` direction; no layering inversion.
- Relies on tsgit's config being a single local file (`readConfig` is local-only), so the re-read has one deterministic source/line.
