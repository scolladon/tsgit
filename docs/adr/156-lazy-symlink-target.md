# ADR-156: Lazy symlink target via readLink()

## Status

Accepted (at `1c35bc3`)

## Context

A `WorkdirEntry` with `kind: 'symlink'` may need its target resolved. Two
options for exposing it:

1. **Sync field** — read once on enumeration, cache the target string on the
   entry. `entry.target: string`.
2. **Async method** — `entry.readLink(): Promise<string>`. Throws if
   `kind !== 'symlink'`. Performs a `readlink` syscall on each call (or once,
   cached on the entry).

Option 1 pays a `readlink` syscall on every enumerated symlink whether the
consumer needs the target or not. On a tree with many symlinks (common in
`node_modules`, dotfiles, system configuration), this is wasted I/O.

Option 2 defers the syscall to the consumer's `await` — pay for what you
actually need.

## Decision

Lazy. `WorkdirEntry.readLink(): Promise<string>` — async method. Throws
`UnsupportedOperation` (or equivalent typed error) if `kind !== 'symlink'`.
The result is cached on the entry after first call (a single allocation
guard, no race risk because entries are single-iteration).

## Consequences

### Positive

- No `readlink` syscall on entries the consumer doesn't inspect.
- Consumers that DO need the target pay one syscall per target, batchable
  via a hypothetical `loadSymlinkTarget()` operator if needed (not in 20.1).
- Consistent with the "I/O is visible" principle (ADR-154). `entry.readLink()`
  reads as I/O; sync `entry.target` would hide it.

### Negative

- Two-step access for consumers that need the target. They typed `await`
  already; negligible.
- Type-narrowing required: `if (entry.kind === 'symlink') await entry.readLink()`.
  Mitigated: `kind` is a discriminator; TS narrows naturally.

### Neutral

- Symlinks in tree/index snapshots carry their target as the blob content
  (git encodes them that way); `entry.read()` is the equivalent there. Not
  affected by this ADR.
