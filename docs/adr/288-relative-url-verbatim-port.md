# ADR-288: Relative submodule-URL resolution is a verbatim port of git's `relative_url`

## Status

Accepted (at `7b8a65cd`)

## Context

`init` and `sync` resolve a **relative** `.gitmodules` url (`./sub`, `../sub`,
`../../x`) against the superproject's default-remote url before writing
`submodule.<name>.url` to `.git/config`. git's algorithm (`remote.c:relative_url`
+ `chop_last_dir`, with `connect.c:url_is_local_not_ssh`) has non-obvious edge
behaviour the prime directive requires byte-for-byte:

- `../` pops one path component off the base; `./` keeps it.
- scp syntax (`git@h:a/b/super.git`) pops path components but restores the `:`
  separator once the last `/` is consumed (`chop_last_dir`'s colon return).
- over-popping past the host collapses (`https://h.x/a/super.git` + `../../../../x`
  → `https:/x`), not an error, because the base is non-local (`is_relative = 0`).
- a url that is non-local-not-ssh (`https://…`, `git@h:…`) or absolute (`/abs`)
  is returned **verbatim** — never treated as relative.
- no configured remote url ⇒ the base is the superproject's absolute worktree
  path (git warns; the warning is stderr display, out of scope for the structured
  return).

Two ways to implement:

- **A — reimplement from observed examples.** Risks diverging on an edge not in
  the example set (the scp colon, the over-pop collapse, the `is_relative`
  branch that only triggers when the *base* is itself relative).
- **B — port `relative_url` + `chop_last_dir` + `url_is_local_not_ssh`
  verbatim** into a pure `domain/submodule/relative-url.ts`, structurally
  matching the C control flow, and pin it with an interop table against real
  `git`.

## Decision

Adopt **B**. `domain/submodule/relative-url.ts` is a line-by-line port of the
three git functions (git 2.54.0), exposing `relativeUrl(base, url): string`. The
default-remote **base selection** (`branch.<HEAD>.remote` → `origin` →
worktree-path) stays in the application tier (it reads config + HEAD); the pure
port does only the string algebra. A `relative-url.properties.test.ts` sibling
proves it is total over the ascii-no-NUL url grammar (never throws on the safe
subset), and an interop table pins each documented edge against `git`.

## Consequences

### Positive

- Faithful by construction, not by example coverage — the scp/over-pop/verbatim
  edges fall out of the ported control flow rather than being special-cased.
- Pure + dependency-free → property-testable and reusable verbatim by 24.1b
  (`add`/`update` resolve the same way).

### Negative

- A C idiom (in-place `chop_last_dir` mutation, the `colonsep` flag) is carried
  into TS; expressed as small pure helpers returning the popped base + colon flag
  rather than mutating, so it reads idiomatically while staying behaviourally
  identical.

### Neutral

- The no-remote warning is not reproduced (stderr display, not structured data);
  the resolved url it would annotate is still computed identically.
