# ADR-014: Push Refspec Scope — Explicit List, No Globs

## Status

Accepted (at `d7ecbac`)

## Context

`PushOptions.refspecs?: ReadonlyArray<string>` accepts strings in
git-refspec syntax. The grammar canonical git supports is broad:

```
[+]<src>:<dst>           # standard
[+]:<dst>                # delete <dst>
[+]<src>                 # src:src
[+]<src>:                # invalid (push)
[+]refs/heads/*:refs/heads/*   # glob — push all branches
[+]refs/heads/*:refs/remotes/old/*   # rename glob
HEAD                     # symbolic
@{u}                     # upstream tracking
```

Plus interaction with `branch.<name>.merge` for default push, and
`push.default = simple|current|matching|nothing` for refspec inference
when the user supplies none.

The full grammar is a parser of non-trivial size (~400 LOC with edge
cases). v1's job is to make the common case work and the uncommon case
explicit, not to ship a feature-complete refspec engine.

## Decision

Phase 12.3 accepts the following refspec forms:

| Form | Meaning |
|------|---------|
| `<src>:<dst>` | push local `<src>` to remote `<dst>` |
| `+<src>:<dst>` | force-push local `<src>` to remote `<dst>` |
| `:<dst>` | delete remote `<dst>` |
| `<branch>` | shorthand for `refs/heads/<branch>:refs/heads/<branch>` |
| `+<branch>` | force shorthand |
| `HEAD` | resolve `.git/HEAD` symref; fail if detached |

Where `<src>` and `<dst>` are fully-qualified ref names
(`refs/heads/...`, `refs/tags/...`) OR short forms that resolve under
`refs/heads/`. A short form `<dst>` does NOT resolve under `refs/tags/`
or `refs/remotes/` — that would mask user intent.

Globs (`*` in src or dst), `@{u}`, `branch.<name>.merge` lookup, and
`push.default` inference are **deferred**.

When the user supplies no `refspecs`:
- If `HEAD` is symbolic to `refs/heads/<branch>`: default is
  `refs/heads/<branch>:refs/heads/<branch>`.
- If `HEAD` is detached: throw `INVALID_OPTION` with reason
  `'no-default-refspec'`.

## Consequences

### Positive

- **Parser is ~70 LOC.** Six branches, each pinned by its own test.
  Easy to mutation-test.
- **Common case fits.** `push({ refspecs: ['main'] })` and `push({
  refspecs: ['main:main', ':old-feature'] })` are both expressible and
  obvious.
- **Explicit > inferred.** Phase 12.3 does not consult `push.default` or
  `branch.<name>.merge`. The user types what they want to push; the
  library does not guess. Surprise-free for the API caller.
- **Glob deferral is upgrade-compatible.** A future refspec parser
  recognising `refs/heads/*` is purely additive — existing call sites
  do not change.

### Negative

- **Mirror push (`refs/heads/*:refs/heads/*`) requires explicit
  enumeration in v1.** Callers can compute the local branch list
  themselves and supply N refspecs.
- **No `branch.<name>.merge` default.** Users coming from canonical git
  who rely on `git push` "doing the right thing" must learn to pass
  `refspecs: ['main']` (or equivalent) once. Compensated by clearer
  errors.

### Neutral

- **`HEAD` only valid as a source token.** `HEAD:refs/heads/staging`
  works; `refs/heads/staging:HEAD` does not (canonical git also rejects
  it). Aligned with upstream.
- **Tag refspecs work today.** `refs/tags/v1.0:refs/tags/v1.0` is fine
  under the rules above. Annotated tag traversal happens during
  `enumeratePushObjects`.

### Alternatives considered

- **Full grammar in one shot.** Would land ~400 LOC of parser plus the
  configuration plumbing for `push.default`. Untestable as a single
  unit without splitting into smaller PRs. Rejected for scope.
- **Glob support as part of 12.3.** Could be ~50 LOC if dst patterns
  must match src. Rejected because it interacts with `enumeratePushObjects`
  (which would need a multi-want input shape). Defer until the
  enumeration primitive has stabilised in v1.x.
