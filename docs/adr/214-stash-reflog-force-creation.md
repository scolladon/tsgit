# ADR-214: `refs/stash` reflog is force-created by the stash primitive

## Status

Accepted (at `5fa805d6`)

## Context

The stash stack **is** the `refs/stash` reflog. But `shouldAutocreateReflog`
(`domain/reflog/should-log.ts`) only auto-creates a reflog for `HEAD`,
`refs/heads/`, `refs/remotes/`, and `refs/notes/` — **not** `refs/stash`. So a
plain `updateRef('refs/stash', …)` would write the ref but, on the first push,
`recordRefUpdate`'s gate is closed and the reflog entry is silently dropped —
destroying the stack before it exists. git sidesteps this by passing the
reflog-creation flag explicitly when it writes `refs/stash`.

## Decision

The `stash-ref` primitive writes `refs/stash` **and** force-appends the reflog
entry directly (resolving identity exactly as `recordRefUpdate` does;
`oldId` = current ref value or `ZERO_OID`), bypassing the `shouldAutocreateReflog`
gate. The shared gate in `should-log.ts` is left **unchanged** — no
stash-specific special-casing leaks into the general reflog policy.

`drop` likewise mutates the stack by rewriting the reflog file directly
(`writeReflog(survivors)`) plus repointing/deleting the loose ref — it must
**not** route through `updateRef`, which would append a spurious entry instead of
rewriting.

## Consequences

### Positive

- The stack is reliably created on the first push and faithfully rewritten on
  drop; `list` always sees every entry.
- The general autocreate policy stays honest; `core.logAllRefUpdates` semantics
  for ordinary refs are untouched.

### Negative

- The stash primitive duplicates a little of `recordRefUpdate`'s
  identity-resolution + sanitisation logic to append unconditionally.

### Neutral

- Coupled-HEAD logging (`logCoupledHead`) is irrelevant for `refs/stash` (HEAD
  never points at it), so the bespoke writer omits it.

## Alternatives considered

1. **Add `refs/stash` to `DEFAULT_LOGGABLE_PREFIXES`** — rejected: pollutes the
   shared gate with a stash-specific rule and would (incorrectly) make
   `core.logAllRefUpdates=false` still skip it, unlike git's explicit force.
2. **`updateRef` then patch the reflog** — rejected: relies on the gate it must
   bypass; brittle and order-dependent.
