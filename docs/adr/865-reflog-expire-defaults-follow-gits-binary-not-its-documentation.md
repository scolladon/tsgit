---
subjects:
  - src/application/commands/reflog.ts
supersedes:
  - adr: "064"
    scope: "the 90-day total and 30-day unreachable expire defaults"
  - adr: "857"
    scope: "the 90-day and 30-day expire defaults it carried forward from ADR-064"
---
# 865 — `reflog expire` defaults follow git's binary (30/90), not git's documentation

- **Status:** accepted
- **Date:** 2026-09-14
- **Design:** docs/design/session-caches-faithfulness-addendum.md (D, DC-D1) · **Supersedes/Refines:** supersedes ADR-064 and ADR-857 in scope; refines ADR-226

## Context

tsgit's `reflog expire` defaults are `90.days.ago` for every entry and `30.days.ago` for unreachable
entries (`reflog.ts:69-70`) — the values git documents, carried forward from ADR-064 by ADR-857.

git 2.55.0 does not run with those values. Pinned (design matrix D0, D1): with no configuration, a
reachable 60-day-old entry expires, so the effective total default is 30 days; with
`gc.reflogExpire = never`, unreachable 60-day-old entries survive, so the effective unreachable
default is 90 days.

The source agrees with the pins. v2.49.0's `builtin/reflog.c:311-312` initialised the unreachable
cutoff to now − 30 days and the total cutoff to now − 90 days. When expire moved into `reflog.c` in
v2.50.0, `reflog.h:25-28` `REFLOG_EXPIRE_OPTIONS_INIT` set total = now − 30 days and unreachable =
now − 90 days; v2.50.0, v2.55.0 and `master` all carry that initialiser.
`Documentation/config/gc.adoc` on `master` still documents 90 days and 30 days. The swap is an
upstream regression: the binary contradicts the documentation it ships with.

Under the swapped values the unreachable cutoff is earlier than the total cutoff, so git's
`expire_unreachable <= expire_total` test holds and a default expire does no reachability walk:
every entry older than 30 days expires, reachable or not (ADR-857's clock-only case).

## Options considered

1. **Follow the binary: total 30 days, unreachable 90 days** (recommended, chosen) — pros: ADR-226
   pins against the binary; the behaviour is in every release since v2.50.0; tsgit and git keep the
   same entries on a default expire. Cons: tsgit expires reachable entries 30 to 90 days old that
   git's documentation promises to keep — exactly what git 2.55 does — and a default expire loses
   its reachability distinction.
2. **Keep the documented 90/30** (today's constants; git up to v2.49.0), recorded as a divergence
   from the pinned binary — pros: keeps the documented contract and today's tsgit behaviour. Cons:
   diverges from real git on every default expire.
3. **Option 2 now, report upstream, switch to whatever upstream ships** — pros: avoids shipping a
   value upstream may revert. Cons: diverges from every git release in circulation until upstream
   acts, and ties a tsgit decision to an external timeline.

## Decision

**Option 1.** With neither a flag nor a configured value for a slot, `reflog expire` uses a total
cutoff of 30 days ago and an unreachable cutoff of 90 days ago.

Faithfulness binds to the binary (ADR-226), including where the binary disagrees with git's own
documentation. This record states the disagreement rather than inheriting either side silently.

**Revisit trigger:** upstream changes `REFLOG_EXPIRE_OPTIONS_INIT`, or changes the documentation to
match it. Either event re-opens this record against the release that carries the change; until
then no tsgit change follows.

## Consequences

A caller relying on the documented defaults loses reflog entries 30 to 90 days old on a default
expire, reachable or not. The 5.0 migration note and the `reflog` command page name the change and
cite the git source locations above, so the difference from git's documentation can be found
rather than discovered.

The defaults apply only to a slot no flag and no `gc.reflogExpire*` key supplies; `refs/stash` does
not take them (ADR-866).

The reflog-expire configuration interop test pins D0 and D1 against git 2.55.0. If a later pinned
git reverts the initialiser those rows fail first, which is how the revisit trigger surfaces.

ADR-857 stated its default clocks as 90 days total and 30 days unreachable; its correction note
points here.
