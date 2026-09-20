---
subjects:
  - src/domain/reflog/expire-policy.ts
  - src/domain/refs/ref-glob.ts
  - src/domain/commands/error.ts
  - src/application/primitives/config-read.ts
  - src/application/commands/reflog.ts
---
# 866 — `reflog expire` honours `gc.reflogExpire`, `gc.reflogExpireUnreachable` and `gc.<pattern>.*`

- **Status:** accepted
- **Date:** 2026-09-14
- **Design:** docs/design/session-caches-faithfulness-addendum.md (D, DC-D2, DC-D3) · **Supersedes/Refines:** refines ADR-857 (its open configuration item) and ADR-226

## Context

`reflog expire` resolves one pair of cutoffs from two constants and applies it to every target;
`gc.reflogExpire`, `gc.reflogExpireUnreachable` and `gc.<pattern>.reflogExpire*` are read nowhere,
and `refs/stash` expires on the constants. ADR-857 recorded this as open.

git reads the keys in `reflog_expire_config` (`reflog.c:35-80`), collects pattern entries in
`find_cfg_ent` (`:17-33`) and applies them per ref in `reflog_expire_options_set_refname`
(`:98-133`); `builtin/reflog.c:216` parses configuration before `:221` parses the options. Pinned
against git 2.55.0 (design matrix D0–D23):

- **Per slot, an explicit flag wins** (D4, D5); with both flags given the configuration is ignored
  for values (D5b).
- **A matching pattern entry supplies both slots and hides the global keys** (D6d, D6e). Its unset
  slot is **never**, not the global default (D6, D6b) — long-standing, not a v2.50.0 change.
- **The first matching pattern in configuration order wins** (D8, D8b); the same pattern text in two
  sections merges into one entry (D8c). Patterns match the full refname with `wildmatch(pattern,
  ref, 0)`, so `*` crosses `/` (D8d–D8g), and `HEAD` is matched too (D13b).
- **`refs/stash` never expires** unless a pattern or an explicit flag says otherwise (D12–D12d).
- **Values use `parse_expiry_date`:** `false`/`never`, `now`/`all`, approxidate, `@<epoch>`
  (D9–D9e).
- **An invalid value refuses on any line, not only the last** (D10d, D10e), on a pattern that does
  not match the ref (D10f), and with both flags given (D10g); valid duplicates are last-wins (D10h,
  D10i). A valueless key refuses `missing value` (D10b). git's two lines name the value, the key
  (lowercased, subsection verbatim), the file and the line.
- **Configuration is parsed before the flags** (D15), before target resolution (D14) and before the
  repo-settings class (D20, D21). Only `reflog expire` reads these keys; `reflog show`, `delete`,
  `exists` and `status` ignore a bogus value (D16–D19).
- git honours every configuration scope (D11c, D11d).

Honouring the keys is a refusal-condition and data gap under ADR-226, not an option. Two choices
remained: what the invalid-value refusal carries, and which matcher applies the patterns.

## Options considered

Refusal data for an unparseable value (DC-D2):

1. **Extend `CONFIG_BAD_DATE_VALUE` with optional `key`, `source` and `line`** (recommended, chosen)
   — present for configuration-file sources; `gc.pruneExpire`, resolved from a plain string, keeps
   `{ value }`. Pros: git's two lines reconstruct from the data; additive. Cons: the API report and
   the errors row change.
2. **Reuse `CONFIG_BAD_DATE_VALUE { value }` as it is** — cons: git's lines cannot be reconstructed.
3. **A new `CONFIG_INVALID_DATE_VALUE { key, source, value, line }`** — cons: a second code for the
   same refusal class.

Pattern matcher (DC-D3):

1. **Promote `name-rev`'s matcher to a shared `domain/refs/ref-glob.ts` with bracket expressions and
   backslash escapes, `name-rev` re-pointed** (recommended, chosen) — pros: both callers are
   `wildmatch(pattern, refname, 0)` in git; one residual closes in two commands and one dialect
   remains. Cons: about 0.5 KiB more runtime than option 2.
2. **Reuse `name-rev`'s `matchRefGlob` (`*` and `?` only)** and record `[…]` and `\` as a residual —
   pros: smallest tarball. Cons: keeps a known dialect gap in both commands.
3. **A dedicated matcher inside the policy module** — cons: duplicates a dialect.

## Decision

**DC-D2 option 1 and DC-D3 option 1.**

A pure domain module, `domain/reflog/expire-policy.ts`, builds the policy from the configuration
entries, the explicit flags, the defaults (ADR-865) and a date parser bound to one `now`. It
validates every entry in file order and throws on the first invalid one. Its `cutoffsFor(ref)`
resolves each slot in git's order: an explicit flag; else the first pattern entry, by first
appearance with same-text entries merged, whose glob matches the full refname, an unset slot being
never; else never for `refs/stash`; else the last valid `[gc]` value; else the default.

`config-read.ts` supplies the entries through a token walk that records, for each
`gc[.<pattern>].reflogExpire[Unreachable]` line, the pattern verbatim, the slot, the raw value or
its absence, the key, the source and the 1-based line; it parses no values. A valueless key refuses
`CONFIG_MISSING_VALUE { key, source, line }`; an unparseable one refuses `CONFIG_BAD_DATE_VALUE {
value, key, source, line }`.

`reflog expire` reads and validates the configuration first, then resolves its flags (an invalid
flag still refuses `REVPARSE_UNRESOLVED`), then resolves its targets (ADR-867), then reaches the
repo-settings class, and asks the policy for each target's cutoffs by the resolved refname. The
other verbs do not read these keys.

## Consequences

Observable changes: configured expiry is honoured; `refs/stash` no longer expires on the defaults;
a malformed key refuses `reflog expire` before anything is rewritten. `CONFIG_BAD_DATE_VALUE`
gains three optional fields, so the API report is regenerated and the errors page documents both
refusal rows. Pinned by a new reflog-expire configuration interop test with entries dated in whole
days relative to the test's clock, one-hour margins keeping git's clock and tsgit's on the same
side of every boundary.

`name-rev --refs` and `--exclude` patterns containing `[…]` or `\` now match as git's `wildmatch`
does instead of literally — a move toward git in a second command.

Residuals, recorded:

- **Local-only scope.** `readConfig` reads the repository's own configuration only (ADR-637,
  carried by ADR-859), so global, system and `-c` values are not honoured (D11c, D11d).
- **Ordering against the eager gate.** A malformed streaming `[core]` class is still reported before
  a malformed `gc.reflogExpire*` value regardless of line order, where git's `reflog_expire_config`
  falls back to `git_default_config` in file order — the same shape as ADR-859's residual.
- **`gc` runs no reflog expire** in tsgit; git's `gc` does. Unchanged.
- **`--expire=bogus`** still refuses `REVPARSE_UNRESOLVED` where git prints `invalid timestamp`
  (D22). Unchanged.
