# ADR-033: `.gitignore` evaluation honours four sources

## Status

Accepted (at `8cd131f`)

## Context

Git's ignore evaluation composes rules from multiple files. v1's §14.3
must pick which sources to honour for the initial ship. Candidate
sources, in evaluation order (last match wins):

1. `core.excludesFile` from git config (global excludes; defaults to
   `$XDG_CONFIG_HOME/git/ignore` ≈ `~/.config/git/ignore`).
2. `.git/info/exclude` (per-clone excludes that don't ship with the
   repo).
3. Repo-root `.gitignore` (the most familiar source).
4. Nested `.gitignore` files in subdirectories.

The minimum viable answer is option 3 alone — that covers the common
case. The maximum is all four. The trade-off is loader complexity vs.
real-world parity with Git.

A reduced scope (e.g. only #3) would force users with legitimate
patterns under `.git/info/exclude` or `core.excludesFile` to migrate
those into the repo-tracked `.gitignore`, surprising anyone porting
from an existing checkout.

## Decision

Honour all four sources. Evaluation order matches Git's: global →
info/exclude → repo-root → nested. Within each ruleset, last-matching
rule wins (per existing `domain/ignore/match.ts`). Across the stack,
deeper levels override shallower (i.e. a nested `.gitignore` can
negate a parent rule via `!pattern`).

Bounded reads cap each file at `MAX_GITIGNORE_BYTES = 1 MiB` —
mirrors the pattern from §13.8 / §14.1 ([ADR-036](036-gitignore-bounded-read.md)).

## Consequences

### Positive

- One-shot parity with git's default behaviour — no migration friction
  for users coming from an existing checkout.
- The matcher-stack abstraction needed for nested `.gitignore` makes
  global + info/exclude trivial to add on the same path.

### Negative

- More loaders to maintain (four versus one). Mitigated by sharing a
  `loadAndParse` helper.
- Global excludes need home-directory resolution → see
  [ADR-034](034-homedir-injection.md) for how the layout port surfaces it.

### Neutral

- The order is significant for negation semantics. The implementation
  pins it via a stack data structure, not implicit insertion order.
