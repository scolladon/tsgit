---
subjects:
  - src/domain/commands/error.ts
  - src/domain/eol/crlf-conversion.ts
  - src/application/primitives/internal/convert-blob.ts
---
# 952 — The safecrlf refusal carries the path, the loss direction and the line-ending counts

- **Status:** accepted
- **Date:** 2026-10-12
- **Design:** docs/design/eol-conversion.md · **Supersedes/Refines:** refines ADR-249

## Context

With `core.safecrlf=true`, git simulates the add-then-checkout round trip of a converted path and
dies when bytes would be lost: `fatal: CRLF would be replaced by LF in <path>` or
`fatal: LF would be replaced by CRLF in <path>`, exit 128, index untouched (§D1.6 of the design).
A mixed file reports the LF direction: git checks CRLF loss first, then LF loss, one notice per
path. ADR-249 requires the refusal to ship as data a caller can render, never as text. The open
question was how much data.

## Options considered

1. **`{ path, loss }`** — `loss: 'crlf-to-lf' | 'lf-to-crlf'`, exactly what git's message carries
   (designer's recommendation). Pros: minimal, reconstructs both lines. Cons: a caller that wants
   to say how many lines are affected has to re-scan the file.
2. **`{ path, loss }` plus the line-ending counts** — the `crlf` and `loneLf` counts from the text
   statistics the conversion already gathered. Pros: zero extra pass, the data a consumer needs
   to report the change's size. Cons: fields git never prints.
3. **A generic code with a reason string** — `UNSUPPORTED_OPERATION` with rendered text. Cons:
   against ADR-249.

## Decision

**User-ratified — option 2.** The refusal is `EOL_ROUND_TRIP_UNSAFE` with data
`{ path: FilePath, loss: 'crlf-to-lf' | 'lf-to-crlf', crlf: number, loneLf: number }`. `crlf` is the
number of CRLF sequences and `loneLf` the number of LF bytes not preceded by CR in the worktree
bytes, as gathered by the conversion's statistics pass (`gather_stats`); `loss` follows git's
check order (CRLF loss first). The interop suite reconstructs git's two lines from `path` and
`loss` alone. The same payload shape is the notice of ADR-953.

## Consequences

- One `EolRoundTrip` shape serves the error data and the warning notice; the counts come from
  statistics already computed, so the refusal costs no second scan.
- `crlf` and `loneLf` are tsgit-specific fields, documented as such in `docs/use/errors.md`; git
  prints neither.
- The refusal names the first offending path in git's processing order (ADR-954).
