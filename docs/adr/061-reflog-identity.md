# ADR-061: Reflog identity resolution and fallback

## Status

Accepted (at `1e5f20b`)

## Context

Every reflog line carries a committer identity — `Name <email> <unix-ts>
<tz>`. tsgit resolves the commit/tag identity from `[user]` in `.git/config`,
and `commit` throws `AUTHOR_UNCONFIGURED` when neither an explicit identity nor
`user.*` is available.

A ref update, however, must **not** fail for lack of identity. `git commit`
on a machine with no `user.name` set still writes a reflog entry — git
synthesizes an identity (system `username@hostname`, marked implicit) rather
than aborting the ref move.

tsgit cannot reproduce git's fallback verbatim: `username@hostname` requires
the host OS user and hostname, which the browser and memory adapters do not
have. Identity resolution also lives in a primitive (`recordRefUpdate`), which
cannot reach into platform APIs.

## Decision

`resolveReflogIdentity(ctx)`:

- reads `[user]` from `.git/config`; when `user.name` / `user.email` are set,
  the reflog identity matches git **exactly** (those values + a fresh
  timestamp and timezone offset);
- when `user.*` is unset, returns a fixed **portable fallback** —
  `name = 'tsgit'`, `email = 'tsgit@localhost'`;
- **never throws** — reflog logging cannot abort a ref update.

## Consequences

### Positive

- Ref updates never fail for an unconfigured identity — git-faithful in the
  property that matters most.
- Portable across all three adapters (Node, browser, memory); no platform
  identity probing in a primitive.
- The normal case (`user.*` configured) is byte-identical to git.

### Negative

- The fallback identity diverges from git's `username@hostname`. A reflog
  produced on an unconfigured tsgit repo shows `tsgit <tsgit@localhost>` where
  git would show the OS user. This is a deliberate, documented divergence —
  the only one in the reflog feature — accepted because git's fallback is not
  portable.

### Neutral

- Reflog identity is the *committer* identity (config `user.*`), independent of
  any per-commit `author`/`committer` override passed to the `commit` command.
