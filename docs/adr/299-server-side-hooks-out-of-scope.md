# ADR-299: Server-side hooks are out of scope (no receive-pack server)

## Status

Accepted (at `b3c53efa`)

## Context

Backlog 24.8 ("Hook coverage parity") lists, alongside the six client-side
lifecycle hooks, **server-side hooks** — `pre-receive`, `update`,
`post-receive`, `post-update` (and `push-to-checkout`). These hooks fire inside
`git receive-pack` **on the receiving end of a push**: the server validates and
applies the pushed ref updates and runs these hooks around that.

tsgit is a **git client library**. Its `push` command speaks smart-HTTP v1 to a
*remote* `git-receive-pack` (it builds the pack and POSTs ref updates); it does
**not** implement a receive-pack *server*. There is therefore no point in tsgit's
code where a server-side hook could fire — the receive-pack process, and the
hooks it would run, live on the other side of the wire, outside tsgit entirely.

Three options were weighed:

1. **Out of scope.** Ship the six client-side hooks; document that server-side
   hooks have no firing site because tsgit has no server.
2. **Stub the union literals now.** Add the four names to `HookName` for a
   "complete" type surface, with no firing site.
3. **Build a minimal receive-pack server** so the hooks can fire.

## Decision

**Option 1 — out of scope** (the user's selection). 24.8 delivers the six
client-side lifecycle hooks (`prepare-commit-msg`, `post-commit`, `post-merge`,
`post-checkout`, `pre-rebase`, `post-rewrite`). Server-side hooks are documented
as having no firing site in a client library and are not added to the `HookName`
union.

Option 2 is YAGNI: a public union literal that nothing can ever invoke is dead
surface — it would imply a capability tsgit does not have and could never be
exercised by a test, leaving a permanent coverage hole or a meaningless stub.
Option 3 is a whole separate feature (a server is Phase-25-transport-scale work
with its own ADRs), not a hook-coverage item.

## Consequences

### Positive

- 24.8 stays bounded and faithful: every shipped hook has a real firing site and
  a real cross-tool parity test against canonical `git`.
- The `HookName` union contains only names tsgit actually fires — no dead
  literals, no unreachable branches.

### Negative

- "Hook coverage parity" is parity for the **client** surface only. A user
  cannot run server-side hooks through tsgit — but tsgit is not a server, so
  there is nothing to run them against.

### Neutral

- If a receive-pack server is ever built, adding its hooks is the same
  additive move 24.8 itself makes for the client hooks (extend the union, insert
  the call at the new firing site) — ADR-300's pattern, no rework.
