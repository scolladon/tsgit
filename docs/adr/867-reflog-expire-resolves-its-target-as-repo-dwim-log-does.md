---
subjects:
  - src/application/commands/reflog.ts
  - src/application/primitives/resolve-ref.ts
  - src/domain/refs/ref-candidates.ts
---
# 867 — `reflog expire` resolves its target as git's `repo_dwim_log` does, and does nothing without one

- **Status:** accepted
- **Date:** 2026-09-14
- **Design:** docs/design/session-caches-faithfulness-addendum.md (E, DC-E1, DC-E2) · **Supersedes/Refines:** refines ADR-857 (its open single-ref item) and ADR-859

## Context

A single-ref `reflog expire` in tsgit probes for the log file under the name exactly as passed,
peels the tip with a peel that throws on a missing object, and checks the repo-settings class
before it looks at the target. With no ref and no `all`, it expires `HEAD`. Measured against the
worktree source:

- `expire refs/heads/gone` — the ref deleted, its log kept — rewrites the log;
- `expire refs/heads/dangling`, a ref holding the id of a missing object, throws `OBJECT_NOT_FOUND`;
- `expire side` refuses `REFLOG_NOT_FOUND`;
- `expire` with no ref expires `HEAD`.

git resolves each argument with `repo_dwim_log` (`builtin/reflog.c:282-297`, `refs.c:840-879`): for
each `ref_rev_parse_rules` candidate, the name must resolve for reading — following symrefs; a
missing terminal ref, an invalid name or unparseable content fails, and the object is never read —
and then the candidate's own log wins, else, for a symref, the log of the ref it resolves to; the
first hit wins. No hit prints `reflog could not be found: '<argument>'`. Pinned against git 2.55.0
(design matrix E1–E16, O-a–O-f):

- a gone ref with its log kept, a dangling symref, an unborn `HEAD`, an invalid name, and a loose ref
  with unparseable content all refuse (E1, E5, E8, E12, E13);
- a short name resolves by DWIM (E4); a symref without its own log, and `HEAD` without its own log,
  expire the target's log (E6b, E7);
- a tip naming a missing object expires by clock: `lookup_commit_reference_gently` returns `NULL`,
  which is `UE_ALWAYS` (E14, E15);
- with no ref and no `--all`, nothing is expired (E10);
- the repo-settings class is reached only after the target resolves: a malformed class with an
  unresolvable ref reports `could not be found` (O-a, O-b), and with no ref at all exits 0 (O-d);
  flags still precede the class (O-c).

## Options considered

How far target resolution transcribes `repo_dwim_log` (DC-E1):

1. **In full:** `ref_rev_parse_rules` DWIM, must resolve, own log else the symref target's log
   (recommended, chosen) — pros: one function in git, and `refCandidates` already transcribes the
   rules; for a full refname the first rule is the name itself, so every call that works today
   resolves the same log. Cons: more resolution I/O for a short name that misses.
2. **The name as passed, must resolve, own log else the target's log** (no DWIM) — cons: `expire
   side` keeps refusing where git succeeds.
3. **The name as passed, must resolve, own log only** — cons: additionally keeps E6b and E7
   refusing.

`expire` with no ref and no `all` (DC-E2):

1. **A no-op returning `{ removed: 0, kept: 0 }`, the class not reached** (recommended, chosen) —
   pros: the pinned behaviour (E10, O-d), no public type change. Cons: a caller relying on the
   `HEAD` default loses it silently.
2. **Keep expiring `HEAD`**, recorded as a divergence — cons: silently does work git does not do.
3. **Type-level: the expire arm requires `ref` or `all: true`** — pros: fails at compile time.
   Cons: an API break with no git counterpart.

## Decision

**DC-E1 option 1 and DC-E2 option 1.**

For its argument, `reflog expire` walks `refCandidates` in order. A candidate that is not a safe
refname is skipped with no I/O. A candidate is otherwise resolved for reading through its symref
chain to a terminal name — `undefined` for a missing terminal ref or unparseable content, while
cycle and depth refusals still propagate — and, when it resolves, its own log is taken if it exists,
else the terminal ref's log when the candidate is a symref. The first hit is the target; with none,
the command refuses `REFLOG_NOT_FOUND { ref }` with the argument as passed, which is what git
prints. Resolution never reads an object: the chain's `found` outcome carries the terminal name.

The expiry kind uses the file's gentle peel: a tip that names a missing object, or does not resolve
to a commit, expires by clock (`UE_ALWAYS`).

The repo-settings class check moves inside `expire`, after target resolution: an unresolvable
target refuses `REFLOG_NOT_FOUND` ahead of a malformed class, a resolvable one reaches the class,
and zero targets never reach it. With no ref and no `all`, `expire` returns `{ removed: 0, kept: 0
}`. Configuration and flag refusals keep their place ahead of both (ADR-866), and each target's
cutoffs are looked up by its resolved refname.

## Consequences

Observable changes: a gone ref, a dangling symref, an unborn `HEAD`, an invalid name and an
unparseable loose ref refuse `REFLOG_NOT_FOUND`; a short name, a symref without its own log and
`HEAD` without its own log expire the resolved log; a missing tip object expires by clock; no ref
and no `all` is a no-op. The 5.0 migration note names the lost `HEAD` default. The reflog interop
test gains E1, E4, E6b, E7, E8, E10, E15, O-a and O-d.

ADR-859's placement of the class for this verb changes from before the command to after target
resolution, matching O-a–O-f; every other verb's placement is unchanged.

Residuals, recorded:

- **One ref per call.** git takes several and keeps expiring after one refuses (E9); tsgit's API
  takes one.
- **`reflog delete` and `reflog show` target resolution** carry the same `repo_dwim_log` and
  revision-parsing differences (E1d, E1e) and are not changed here.
- **`core.warnAmbiguousRefs`** changes whether git keeps counting candidates after the first hit,
  never which log it chooses; not modelled.
