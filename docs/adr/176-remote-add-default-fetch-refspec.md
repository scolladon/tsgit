# ADR-176: `remote add` writes the canonical default fetch refspec

## Status

Proposed

## Context

`git remote add <name> <url>` writes the canonical fetch refspec
`+refs/heads/*:refs/remotes/<name>/*` by default, mirroring what
`clone` writes for `origin`. tsgit's Phase 20.5 `remote add` faces the
same choice:

- **A: write the canonical default unconditionally** unless the caller
  passes `fetch: <custom>`. Matches canonical git.
- **B: leave `fetch` out and require an explicit refspec** every time.
- **C: write nothing at all** and treat fetch refspec as a separate
  concern owned by `git config`.

Without a fetch refspec, `repo.fetch({ remote: name })` cannot infer
where to write tracking refs and would either fail with a cryptic
error or silently write nothing — both bad. Option C punts the
problem onto the next user without solving it.

We also have to decide whether `add` validates the user-supplied
custom refspec.

## Decision

`remote add` writes `+refs/heads/*:refs/remotes/<name>/*` as the
default fetch refspec when the caller does not supply one. When the
caller passes `fetch: <custom>`, `add` validates it with the existing
`parseRefspec` (the same path `fetch`/`push` use) and writes the
literal string the caller passed.

The `url` field is written verbatim. The only `url` validation in
`add` is the control-character ban shared with the rest of the
config-write surface (`\n` / `\r` / `\0` would let line surgery splice
a forged section into `.git/config`). Scheme / SSRF validation
remains at the consumption site (`clone`/`fetch`/`push`).

## Consequences

### Positive

- **Canonical git parity.** A user moving from `git` to `tsgit` gets
  the same `.git/config` shape for free.
- **`fetch({ remote: name })` works on day one.** The default refspec
  is the one `fetch` already consumes; no orphan-config state.
- **Custom refspec is honoured.** Power users who want a different
  layout (e.g. mirroring tags) pass `fetch: '<spec>'` and bypass the
  default. The `parseRefspec` validation rejects malformed inputs
  early with `REFSPEC_INVALID`.
- **URL validation stays at the boundary.** `add` is a config write;
  `clone`/`fetch`/`push` already validate the URL when they actually
  contact the remote. Validating twice (once syntactically at write,
  once for SSRF at fetch) would force `add` to mock a DNS resolver,
  which is the wrong dependency for a pure config-mutation verb.

### Negative

- **A misspelled URL is silently accepted at write time.** Discoverable
  at first `fetch`/`push`. Canonical git matches this behaviour; we
  match it.
- **Custom refspec validation runs at write, not at fetch.** A user
  who edits `.git/config` by hand can still produce a broken refspec
  that `fetch` rejects later — but that's an existing risk
  unrelated to 20.5.

### Neutral

- The decision is reversible: a follow-up could harden URL validation
  in `add` (e.g. require https://) without changing the default
  refspec or the parsed result shape.

## Alternatives considered

- **B (no default)** — rejected. Punts an unsolved problem onto every
  caller. The canonical refspec is the right default for 99% of cases;
  forcing every user to retype it is friction without benefit.
- **C (config left untouched)** — rejected for the same reason: it
  produces a broken remote that `fetch` cannot consume.
