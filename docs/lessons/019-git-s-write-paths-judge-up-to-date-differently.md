---
subjects:
  - src/application/primitives/internal/stale-entries.ts
  - test/integration/checkout-leading-symlink-interop.test.ts
phases: [design, implementation, review]
kind: gotcha
trigger: one up-to-date judge is shared across reset, forced checkout and path restore
evidence:
  - src/application/primitives/internal/stale-entries.ts
  - test/integration/checkout-leading-symlink-interop.test.ts
source: { run: forced-checkout-same-commit, phase: review, date: 2026-10-26 }
status: active
supersedes: []
last-verified: 2026-10-26
---
# 019 — git's write paths judge "up to date" differently

## Context

Every `forceRewriteAll` caller moved to one stale-only judge, modelled on git's `oneway_merge`.
That rule lstats the path through its leading symbolic links. `reset --hard` and `checkout -f`
use it, so both keep a symlinked directory whose target's stat matches. Path restore
(`checkout -- p`) runs `checkout_entry` instead. Its `check_path` treats any path beyond a
symlinked leading component as missing, so git replaces the link with a directory. With the
shared judge, path restore kept the link. Only the security reviewer's probe caught it.

## Lesson

"Is this entry up to date?" has no single answer in git. The answer depends on the caller's
code path (`oneway_merge`, `checkout_entry`, `refresh_index`), and those differ at leading
symlinks.

## How to apply

When one stale or up-to-date judge serves several commands, name git's routine behind each
caller.
Pin a leading-symlink row for each caller family, not only for the first.
Give the judge an explicit rule parameter, and never infer the rule from the caller's options.

## Evidence

- `src/application/primitives/internal/stale-entries.ts`, `StaleRule`: `'oneway'` versus
  `'checkoutEntry'`.
- `test/integration/checkout-leading-symlink-interop.test.ts`, the path-restore rows
  (`checkout -- .` and `checkout HEAD -- .`) beside the `checkout -f HEAD` and `reset --hard HEAD`
  rows that keep the link.
