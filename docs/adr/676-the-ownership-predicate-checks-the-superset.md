# 676 — The ownership predicate checks the superset of layout paths

- **Status:** accepted
- **Date:** 2026-08-19
- **Design:** docs/design/ownership-trust-gate.md (candidate D8)

## Context

Which path git itself `stat`s is **not measurable** here. `GIT_TEST_ASSUME_DIFFERENT_OWNER`
forces every candidate path to fail at once, and this machine has neither `chown` nor
password-less `sudo`. Only two things are pinned: which single path git **names** in the
refusal, and which single path the allowlist **keys on** — both the discovery repository path.

One measured row makes the choice matter. A `.git` **gitfile** in a directory you own may point
at a gitdir someone else owns, and git was measured admitting exactly that pairing when the work
tree is allowlisted — while the `hooks/` and `config` that actually execute live in the foreign
gitdir.

## Options considered

1. **The discovery repository path only** — exactly what is measured as named and keyed — pros:
   strictly no invented behaviour / cons: leaves the owned-gitfile/foreign-gitdir shape
   unguarded, which is the shape that matters most.
2. **`gitDir` + `commonDir` + the discovery repository path** (design recommendation) — pros:
   a superset; cannot admit anything the others admit / cons: may *over*-refuse a shape git
   permits — a risk with no observable either, for the same reason.
3. **`gitDir` + `commonDir` only** — guards the metadata that decides code execution but not the
   work tree whose content commands read and write.

## Decision

**Option 2 — ratified by the user.**

The predicate is applied to the deduplicated union of `gitDir`, `commonDir` and the discovery
repository path. For a normal repository `commonDir` equals `gitDir` and the repository path is
their parent, so it is two `stat`s, not three.

The refusal still **names** the single repository path git names, and the allowlist still **keys
on** that one path — those are measured and are not changed by widening what is checked.

## Consequences

- tsgit may refuse a shape git permits. That is accepted deliberately, in the direction of
  over-refusing rather than under-refusing, and it is unobservable in the interop suite for the
  same reason it was unmeasurable.
- Cost is at most three `stat` calls per `openRepository`, deduplicated to two in the common
  case, and zero per command.
- If a Windows or container-hosted measurement later observes git's actual choice, this ADR is the
  place that records why tsgit did not wait for it.
