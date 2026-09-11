---
subjects:
  - src/application/commands/reflog.ts
supersedes:
  - adr: "064"
    scope: "the expire reachability rule and its fully-faithful claim"
---
# 857 — `reflog expire` follows git's reachability rule

- **Status:** accepted
- **Date:** 2026-09-11
- **Design:** docs/design/session-caches-per-command-floor.md (D8, DC-7) · **Supersedes/Refines:** supersedes ADR-064 in scope

## Context

`reflog expire` was recorded as fully faithful, with the keep rule
`reachable(entry.newId) ? ts >= expireCut : ts >= expireUnreachableCut` over a reachable set built
by walking every ref tip. Pinned against git 2.55.0, that rule is not git's, in four separate
ways:

- Git expires `timestamp < expire_total` **unconditionally**, with no reachability question asked.
- The unreachable clock tests **both** the old and the new object id, not the new one alone.
- Reachability is measured from **the ref's own tip** (`UE_NORMAL`); every tip is used only for
  `HEAD` (`UE_HEAD`), and a log whose ref does not resolve to a commit expires by clock alone
  (`UE_ALWAYS`).
- The mark walk is **bounded** at `expire_total`: commits older than that are kept as a frontier
  and never expanded, so an old commit is reachable only if it is itself on the frontier.

The measured divergence: on `refs/heads/main` at tip A, with `A→B` in its log and B reachable only
from `side`, `--expire=never --expire-unreachable=now` makes git keep one entry and tsgit keep
three. `--expire=now --expire-unreachable=never` makes git expire an unreachable-tip entry that
tsgit keeps.

Git also skips the walk entirely when `expire_unreachable <= expire_total`, because reachability
cannot then change any verdict. The brief framed that skip as the performance fix on its own; it
is a consequence of git's rule, not a substitute for it, and on the default clocks — 90 days
against 30 days — the two are never equal, so the skip alone would buy nothing.

## Options considered

1. **Implement git's model in this change** (recommended, chosen) — pros: the faithful mechanism
   *is* the fast one (one tip, bounded walk); the code is being touched anyway; three divergences
   in refusal-adjacent output close. Cons: an observable behaviour change in which reflog entries
   survive an expire.
2. **Perf-only: skip the walk when the two cutoffs are equal** — pros: smallest diff. Cons: buys
   nothing on default clocks and leaves all three divergences.
3. **Perf-only now, git's model as a separate item** — cons: defers a faithfulness fix out of the
   change that has the file open.

## Decision

**Option 1.** `reflog expire` implements git's model. The expiry kind is resolved per ref:
`HEAD` marks from every tip; another ref peels its own tip to a commit and marks from that alone;
a ref that does not resolve to a commit, or a run where the unreachable cutoff is not later than
the total cutoff, expires by clock alone with no walk. An entry expires when its timestamp is
below the total cutoff, or when it is below the unreachable cutoff and either its old or its new
object id is unreachable — a null id or a non-commit counting as reachable, so it is kept. The
mark walk is lazy and date-bounded, expanding a commit only while its committer date is at or
above the total cutoff and extending from the frontier before answering a query.

tsgit's existing cutoff resolution already maps `never` and `all`/`now` to the infinities that
make git's `expire_unreachable <= expire_total` comparison behave identically, so no cutoff
parsing changes.

## Consequences

Which reflog entries survive an expire changes, in the direction of git, in the three pinned
cases. Seven interop pins against real git cover the matrix and become part of the suite.

The walk reuses the graph-first commit-metadata reader introduced with the closure work, so no
new traversal seam appears; the performance win — one tip instead of all tips, and a bounded walk
instead of a full one — falls out of the faithful shape rather than being engineered separately.

Carried forward from ADR-064: the one-command discriminated `action` shape, the `show` /
`exists` / `delete` / `expire` split, approxidate cutoff parsing with the 90-day and 30-day
defaults, and `delete --rewrite`'s old-to-new chain repair. Superseded from ADR-064: the expire
reachability rule quoted above, the all-tips reachable set, and the claim that `expire` is fully
faithful.

Out of scope and still open: `expire` uses constants where git reads `gc.reflogExpire` and
`gc.reflogExpireUnreachable`. That is a pre-existing configuration gap, not part of the
reachability rule, and is untouched here. A single-ref expire of a log whose ref no longer
resolves also answers differently from git, which refuses it; tsgit's file probe finds the log.
