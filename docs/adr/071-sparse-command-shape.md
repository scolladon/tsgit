# ADR-071: `repo.sparseCheckout` is one discriminated-action command with full git parity

## Status

Accepted (at `c85927a`)

## Context

git's `git sparse-checkout` is a command with subcommands: `list`, `set`,
`add`, `reapply`, `disable` (and a deprecated `init`). tsgit must decide how
much of that surface `repo.sparseCheckout(...)` exposes. The decision —
confirmed with the repository owner — is between the full subcommand set and a
minimal `list`/`set`/`disable` core.

The repository already has a precedent for multi-mode commands: `reflog` and
`branch` are single tier-1 commands with a discriminated `action` field.

## Decision

Expose the **full git-parity** subcommand set as **one** tier-1 command with a
discriminated `action`, mirroring `reflog`:

```ts
type SparseCheckoutAction =
  | { action: 'list' }
  | { action: 'set'; patterns: ReadonlyArray<string>; cone?: boolean; force?: boolean }
  | { action: 'add'; patterns: ReadonlyArray<string>; force?: boolean }
  | { action: 'reapply'; force?: boolean }
  | { action: 'disable'; force?: boolean };
```

- `list` — current patterns (directories in cone mode, raw patterns in
  non-cone).
- `set` — replace patterns, enable sparse checkout, apply.
- `add` — append patterns to the existing set, apply.
- `reapply` — re-evaluate the on-disk patterns against the working tree
  (after a manual file edit, or to recover from a deferred-integration drift).
- `disable` — re-materialise the full tree, clear `core.sparseCheckout`; the
  pattern file is kept on disk.

`init` is **not** surfaced — git deprecated it in favour of `set`.

All five actions share one apply engine (`applySparseCheckout`), so `add` and
`reapply` cost little beyond `set` and `disable`.

## Consequences

### Positive

- Exact parity with `git sparse-checkout` — no surprises for users who know
  git.
- `reapply` gives users a one-call recovery path for the documented
  `reset`/`merge` deferral (ADR-073) and for hand-edited pattern files.
- One command, one barrel export, one facade binding — consistent with
  `reflog`/`branch`.

### Negative

- Five actions to implement, test to 100 % coverage, and mutation-harden —
  more than a `set`-only minimum.

### Neutral

- The discriminated-union `action` shape is the established pattern; the
  result is a discriminated `{ kind: 'list' | 'applied' }` union, as `reflog`
  returns a discriminated result.
