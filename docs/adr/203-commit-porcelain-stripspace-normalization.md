# ADR-203: Commit porcelain applies git `stripspace` message normalization

## Status

Accepted (at `17d0a0a`)

## Context

The `commit` porcelain normalizes its message with `raw.trim()` before handing
it to the `createCommit` primitive, which serializes the message verbatim
(`${headerText}\n\n${message}`). `trim()` removes the trailing newline entirely,
so the committed object lacks the single trailing `\n` that canonical git always
writes. Result: **every** non-empty commit through the porcelain produces a
commit-object SHA that diverges from `git commit` for the same inputs.

git normalizes commit messages with `stripspace`. When a message is supplied via
`-m` (no editor), the cleanup mode is `whitespace`: strip per-line trailing
whitespace, collapse consecutive blank lines to one, drop leading/trailing blank
lines, and guarantee exactly one trailing `\n` (comment lines are **not**
stripped in this mode). The `createCommit` primitive is already faithful when
handed a `\n`-terminated message — the gap is entirely in the porcelain.

This was surfaced while implementing `mv` (the porcelain-faithfulness blind spot)
and is the precondition for the write-porcelain interop harness: that harness
can only assert commit-object SHA equality once the porcelain is faithful.
Sequencing decision (taken with the user): land this normalization fix as its
own PR **before** the harness PR, so the harness is born green and immediately
guards the fix.

## Decision

Add a pure domain function `stripspace(message: string): string` in
`src/domain/objects/commit-message.ts`, a faithful port of git's
`strbuf_stripspace` with no comment prefix (the `whitespace` cleanup mode). Route
the `commit` porcelain through it by replacing `raw.trim()` inside the single
existing chokepoint `sanitizeMessage` (`application/commands/internal/`). Because
`sanitizeMessage` is also called by `merge` (merge-commit message + `MERGE_MSG`)
and by the `commit-msg` hook re-sanitize path, all porcelain commit messages
become faithful in one edit; `stripspace`'s idempotence makes the
write-then-re-sanitize of `MERGE_MSG` a no-op.

Normalization is **unconditional** — no user-facing `--cleanup=<mode>` option.
The `createCommit` primitive stays byte-verbatim (the low-level escape hatch).

Commit-id goldens that shift (parity scenarios and any pinned literals) are
regenerated; representative goldens are recomputed against real git (signing
off) so they are proven faithful, not merely self-consistent.

### Alternatives considered

- **Normalize inside `createCommit`.** Rejected — breaks the primitive's
  verbatim contract and the existing commit-object interop test, which relies on
  passing a pre-normalized `\n`-terminated message.
- **Expose `--cleanup=<mode>` (`verbatim`/`strip`/`scissors`).** Deferred —
  YAGNI; the backlog asks only that the porcelain apply normalization so SHAs
  match. Add the option when a backlog item needs it.
- **Keep `stripspace` in `application/internal` next to `sanitizeMessage`.**
  Rejected — message normalization is pure git grammar (domain), not
  application policy; co-locating with `commit.ts` in `domain/objects` keeps it
  property-testable in isolation and reusable.
- **Keep `trim()`.** Rejected — unfaithful; the entire point is SHA parity with
  canonical git.

## Consequences

### Positive

- `commit` (and merge-commit) object SHAs now match canonical git byte-for-byte.
- Single normalization seam — commit, merge, and hook paths fixed together.
- `stripspace` is pure, total, idempotent, and property-tested in the domain.
- Unblocks the write-porcelain interop harness to assert commit-object SHA.

### Negative

- Commit-id goldens across the suite must be regenerated in this PR.
- A second normalization pass over an already-clean message is wasted work
  (negligible; idempotence keeps it correct).

### Neutral

- The empty-message guard is unchanged for ASCII inputs. For non-ASCII
  whitespace (e.g. `U+00A0`-only messages) the new behavior matches git's
  ASCII-only `isspace` (content preserved) rather than `trim()`'s Unicode-aware
  emptiness — a more-faithful edge that was previously rejected as empty.
- `createCommit` remains the verbatim writer for callers that pre-normalize.
