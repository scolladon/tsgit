---
subjects:
  - src/application/commands/reflog.ts
supersedes:
  - adr: "064"
    scope: "the expire reachability rule and its fully-faithful claim"
---
# 857 — `reflog expire` follows git's reachability rule

> **Correction (2026-09-13).** This record's first draft stated that the mark walk is bounded at
> `expire_total` outright — "an old commit is reachable only if it is itself on the frontier" — and
> that `HEAD` marks from "every tip". Both misread `reflog.c`. The bound is laziness that git drops
> on the first miss (`mark_limit = 0`, re-walk to the root), and `HEAD`'s tip set is every ref under
> `refs/`, never `HEAD` itself. Implemented as first written, tsgit expired reflog entries git keeps
> (probe: git kept 3, tsgit kept 1) on the default 90/30-day clocks, and `gc` runs this expire — so
> reflog bytes and subsequently pruned objects both diverged. Two review dimensions caught it
> independently with real-git probes; the R1-R7 matrix could not, because every case used
> `never`/`now` or a parentless frontier commit. The Context and Decision above are corrected; the
> decision itself — follow git's model — is unchanged.

- **Status:** accepted
- **Date:** 2026-09-11
- **Design:** docs/design/session-caches-per-command-floor.md (D8, DC-7) · **Supersedes/Refines:** supersedes ADR-064 in scope

> **Correction (2026-09-14).** This record gives the default clocks as 90 days total and 30 days
> unreachable — in the correction note above, in the Context's paragraph on the walk skip, and in
> the defaults carried forward from ADR-064. Those are git's documented values and the values of git
> up to v2.49.0. Since v2.50.0 git's binary runs with total = 30 days and unreachable = 90 days
> (`reflog.h:25-28`), and ADR-865 moves tsgit to them. Under those clocks the Context's argument that
> the skip "would buy nothing" because the default clocks "are never equal" does not hold: git's test
> is `expire_unreachable <= expire_total`, not equality, and with the unreachable cutoff 90 days back
> and the total cutoff 30 days back it is true, so a default expire skips the walk and expires by
> clock alone. The Decision already implements that case (a run whose unreachable cutoff is not later
> than its total cutoff expires by clock), and the skip remains a consequence of git's rule rather than
> a substitute for it. The note above is also inaccurate in saying `gc` runs this expire: git's `gc`
> runs a reflog expire, tsgit's does not — tsgit's `gc` reads reflogs as retention roots. The
> decision itself — follow git's model — is unchanged.

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
- The mark walk starts **bounded** at `expire_total`, but the bound is an optimisation, not the
  rule: on the first miss `unreachable()` sets `mark_limit = 0`, clears `REACHABLE` across the
  mark list and re-walks the leftover frontier down to the root. Git's verdict is therefore exact
  full-ancestry reachability; the bound only lets it stop early when it already has an answer.

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
`HEAD` marks from every ref tip under `refs/` — `HEAD` itself is never pushed as a tip; another
ref peels its own tip to a commit and marks from that alone;
a ref that does not resolve to a commit, or a run where the unreachable cutoff is not later than
the total cutoff, expires by clock alone with no walk. An entry expires when its timestamp is
below the total cutoff, or when it is below the unreachable cutoff and either its old or its new
object id is unreachable — a null id or a non-commit counting as reachable, so it is kept. The
mark walk is lazy: it expands a commit while its committer date is at or above the total cutoff
and keeps older commits as an unexpanded frontier, but on the first miss it drops the bound,
un-marks the leftover frontier and expands it to the root — so the answer is exact full-ancestry
reachability, as git's is, and the date bound only avoids work when the answer arrives early.

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
