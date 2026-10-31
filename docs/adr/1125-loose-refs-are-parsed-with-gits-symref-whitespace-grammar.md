---
subjects:
  - src/domain/refs/loose-ref.ts
  - src/application/primitives/ref-store.ts
  - src/application/primitives/internal/ref-write-chain.ts
---
# 1125 — loose refs are parsed with git's symref whitespace grammar

- **Status:** accepted
- **Date:** 2026-10-30
- **Design:** docs/design/fsck-broken-ref-chain-unreadable.md (D5) · **Supersedes/Refines:** refines ADR-226

## Context

Pinned on git 2.56.0 through `rev-parse --symbolic-full-name` and `fsck`: `ref:refs/heads/main`,
`ref:  refs/heads/main`, `ref:\trefs/heads/main`, `ref: refs/heads/main \n` and
`ref: refs/heads/main\r\n` all resolve (the last two with a `trailingRefContent` warning); a
vertical tab or form feed does not. git strips trailing SP/HT/CR/LF, then reads `ref:` followed by
any run of SP/HT/CR/LF. tsgit's `parseLooseRef` trims `[\r\n]+` and requires `ref: ` with one
space, so those bodies are refused — the refusal mismatch backlog 32.39 recorded for trailing
spaces. Once every listed name gets a pointer (ADR-1123), a body git accepts would turn today's
exit 0 into a spurious exit 2.

## Options considered

1. **Fold the grammar into `parseLooseRef` and the integrity check, for every command**
   (designer's recommendation) — pros: git-faithful on resolution, HEAD and fsck alike; delivers
   32.39 / cons: touches the shared parser.
2. **fsck-only: exclude git-accepted bodies from the broken set** — pros: fsck matches / cons: two
   grammars, and 32.39 stays open.
3. **Leave it** — cons: a new divergence the change itself creates.

## Decision

**Ratified by the user: option 1.** A loose body is read by stripping trailing SP, HT, CR and LF,
then, for a symref, accepting `ref:` followed by any run of those four characters before the
target; an empty target still refuses. The whitespace class is exactly SP, HT, CR, LF. The grammar
binds every reader of a loose body: resolution, HEAD, the write chain's re-read and fsck's
integrity check. Under ADR-1126 the direct-oid arm also accepts what git accepts.

## Consequences

- Backlog 32.39 ships with this change.
- The trailing forms also produce fsck's `trailingRefContent` warning (ADR-1126).
- The parser's property suite gains a whitespace-insensitivity lens.
