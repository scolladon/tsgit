# ADR-1170: a filing bar separates the backlog from a divergence ledger

## Status

Accepted (at `64760891`)

## Context

[ADR-226](226-git-faithfulness-prime-directive.md) makes byte-for-byte git faithfulness the
prime directive, and later decisions carried it into fault surfaces: corrupt objects,
unreadable directories, control bytes in messages. Every craft run pins its change against
real git, four reviewers probe the cases next to it, and mutation testing reaches latent
paths. Each proven gap outside the change's perimeter becomes a backlog entry.

That loop files more than it closes. The last three filing runs:

| PR | shipped | filed |
|---|---|---|
| #335 | #311, 31.8 | 32.45, 32.46, 32.47 |
| #336 | 32.18 | 32.48, 32.49, 32.50 |
| #337 | 32.19 | 32.51, 32.52, 32.53, 32.54, 32.55 |

Seven of those nine open entries are corrupt-input, message-only or spike rows, the bottom of
the release-order rank rule. None came from a user. At this rate the backlog has no end:
git's behaviour on damaged or adversarial input is unbounded, so a directive that schedules
every such row cannot be finished.

## Decision

A proven divergence enters `docs/BACKLOG.md` only when it is **at or above the filing bar**:

1. a failure a user reported;
2. a consumer-facing API bug (a call that cannot be expressed, or a result whose shape or
   order differs from git's data);
3. data integrity: tsgit writes, deletes or leaves on-disk state that git would not;
4. a wrong result or a refusal mismatch **on a well-formed repository** with an input a
   caller plausibly sends;
5. a measured performance cost on a common caller path (status, add, commit, checkout, log,
   diff, merge, rebase, fetch, clone, push).

Everything else that is proven goes to `docs/known-divergences.md`, one entry with its proof,
grouped by class: corrupt, forged or unreadable input; message only; rare configuration and
edge input; performance off the hot path; feature gaps. The ledger is not scheduled.

- **Net-zero cap.** A run files at most as many backlog entries as it closes. Rows over the
  cap go to the ledger, lowest rank first.
- **Way back.** A ledger row returns to the backlog when a user reports it. When a change
  already touches its code, it is folded into that change instead.
- **Faithfulness is unchanged for new work.** A change still matches git on every path it
  touches, fault surfaces included. The bar decides only what gets *scheduled* as separate
  work, not how a change behaves.
- **A ledger row is not an ADR-226 divergence.** It records a known gap; it does not
  sanction one. Fixing it needs no new ADR.

The bar is applied once to the open backlog (2026-11-10): 21 entries and 10 sub-rows move to
the ledger. It is enforced from then on by the impact-triage phase context
`.claude/workflow/filing-bar.md`.

## Consequences

### Positive

- The backlog becomes finite. The estimate falls from about 40–47 sessions to about 25–32.
- Every proven gap stays written down with its proof, so nothing is lost or re-discovered.

### Negative

- tsgit's behaviour on corrupt or adversarial input is now documented, not guaranteed. A
  caller that relies on git's exact refusal for a damaged repository may see a different
  error code.
- Judging "well-formed" and "plausible input" is a call the triager makes; a wrong call
  sends a real defect to the ledger until a user reports it.

### Neutral

- The release-order table and its Stop hook are unchanged; moved ids leave the table with
  their entries.
