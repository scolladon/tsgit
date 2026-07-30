# 545 — `.git/shallow` parser: strict git-faithful grammar plus an entry cap

- **Status:** accepted
- **Date:** 2026-07-30
- **Design:** docs/design/shallow-boundary-commit-walk.md · **Supersedes/Refines:** refines 226; corrects the tolerant-parse claim shipped with the fetch-side reader

## Context

`readShallow`'s doc comment claims git tolerates malformed lines; pins D9–D12 refute it —
git dies `fatal: bad shallow line` on any line whose first 40 chars are not hex, while
*accepting* trailing junk after 40 hex (D6) and uppercase hex (D7). tsgit is wrong in
both directions (skips what git refuses; rejects what git accepts). Separately, the
threat model found no bound on shallow entries a hostile server can persist via fetch —
only the 512 MiB body cap (~10⁷ entries) — which every subsequent walk then loads.

## Options considered

1. **Strict git-faithful grammar + entry/size cap + structured refusal code** (designer's
   recommendation) — pros: byte-faithful refusals, one reader owns the grammar, natural
   home for the DoS cap / cons: behaviour change on the public `readShallow`; the cap is
   a deliberate divergence (git has none).
2. **Strict, no cap** — pros: pure git parity / cons: leaves the unbounded-set
   threat-model gap open.
3. **Keep tolerant-skip, fix the comment** — pros: no behaviour change / cons: silently
   walking a history git refuses to report is a data divergence under ADR-226.

## Decision

User-ratified: **option 1**. The parser refuses (structured code, e.g.
`SHALLOW_FILE_MALFORMED`) any line whose first 40 characters are not hex, accepts
trailing content after a valid 40-hex prefix and uppercase hex, and enforces a
documented entry-count/size cap sized in the spirit of `MAX_ADVERTISED_REFS`. Both fetch
and walk paths use this one reader.

## Consequences

`readShallow` becomes strict — a behaviour change on an existing public export, shipped
with property tests over the grammar (round-trip + totality on the safe subset + negative
refusals). The cap is the one documented divergence from git in this change and exists as
a DoS mitigation; exceeding it refuses loudly rather than degrading.
