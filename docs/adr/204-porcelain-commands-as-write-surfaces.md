# ADR-204: Model write porcelain as `@writes` surfaces

## Status

Accepted (at `03616689bbf3be151314a6e06c6bab85248aa8d0`)

## Context

`audit-write-surfaces` guards faithfulness by coupling every `@writes` byte-format
declared in `src/` to a `cross-tool-interop` test that pins it to canonical
`git`. Today only **format-defining** modules carry `@writes` (commit object,
index DIRC, loose/packed ref, packfile, …).

Composite **porcelain** commands — `mv`, `add`, `rm`, `reset` — define no new
on-disk format; they compose existing primitives. Their faithfulness to git is
only checked **cross-adapter** (Node ≡ Memory ≡ Browser), against a tsgit-computed
golden. A divergence from canonical `git` can therefore ship undetected — exactly
what `mv` exposed (its parity golden was "verified out-of-band").

Adding a `cross-tool-interop` test for `mv` trips the audit: a test naming an
`interopSurface:` that no `@writes` tag declares is reported as **orphan
coverage**. So the audit must learn that porcelain commands are also
faithfulness surfaces — or the new tests can't be tracked.

Options considered:

- **A — Convention-only, no tag.** Ship the harness + tests; leave the commands
  untracked by the audit. Smallest change, but relies on humans remembering to
  add interop tests for future porcelain — the very failure mode the work targets.
- **B — Reuse `@writes` on the command module.** Tag each porcelain command
  (`src/application/commands/<cmd>.ts`) with a `@writes` block. The existing
  audit immediately reports it covered. No new tooling; widens `@writes` to mean
  "a write surface that must be pinned to git", whether a byte format or a
  composite command.
- **C — New `@faithful` porcelain tag + audit extension.** Separate taxonomy
  (`@writes` = byte format, `@faithful` = porcelain state) with its own parser,
  collector, and report fields. Cleaner conceptually, materially more tooling.

## Decision

**Option B.** Porcelain commands are declared as `@writes` surfaces on their
command module:

```ts
/**
 * Move/rename tracked paths… faithful to `git mv`.
 *
 * @writes
 *   surface: mv
 *   kind:    equivalent-under-readback
 *   format:  git-index-tree-state
 */
```

- `surface` = the command name (`mv`, `add`, `rm`, `reset`).
- `kind` = `equivalent-under-readback` — the resulting index + tree read back via
  `git ls-files --stage` / `git write-tree` match git; raw index bytes differ by
  per-host stat-cache.
- `format` = `git-index-tree-state` — the composite readback state. Not a new
  byte format; that is the defining trait of a porcelain surface.

The audit is reused unchanged. `@writes` semantics widen from "this module
defines a byte format" to "this module owns a write surface that must be pinned
to canonical git".

## Consequences

### Positive

- Future porcelain (`stash`, `cherry-pick`, …) is machine-tracked: ship the
  command without a `cross-tool-interop` test and the audit reports a gap.
- Zero new tooling; one taxonomy for contributors to learn.

### Negative

- `@writes` is overloaded — a reader must know a surface can be a composite
  command, not only a byte format. Mitigated by the module JSDoc wording
  ("faithful to `git <cmd>`") and this ADR.
- `format` for porcelain is a state label, not a real wire format, so the
  `format:` field is less literal for these surfaces.

### Neutral

- Format labels are not required unique; multiple porcelain surfaces share
  `git-index-tree-state`.
- The audit stays warn-only (ADR-139); a missing porcelain interop test warns,
  it does not block.
