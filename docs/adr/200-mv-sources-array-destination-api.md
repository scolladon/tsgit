# ADR-200: `mv` takes an explicit `(sources[], destination)` signature

## Status

Accepted (at `a7e54c4`)

## Context

`git mv` is variadic on the CLI: `git mv <src>... <dest>`, where the final
positional argument is the destination and every preceding one is a source.
The tsgit library needs a typed signature for `mv(ctx, …)`. Three shapes were
considered:

1. `(sources: ReadonlyArray<string>, destination: string)` — explicit split.
2. `(source: string | ReadonlyArray<string>, destination: string)` — overloaded
   to make the single-rename case read `mv('a.txt', 'b.txt')`.
3. `(paths: ReadonlyArray<string>)` — trailing element is the destination,
   mirroring the CLI's positional parsing.

Forces: the repo's command surface already uses
`ReadonlyArray<string>` for multi-path commands (`rm`, `add`), and on a
two-argument `(old, new)` form for renames (`branch.rename`, `remote.rename`,
`config.renameSection`). Object Calisthenics in this codebase discourages
primitive unions and positional ambiguity.

## Decision

Ship `mv(ctx, sources: ReadonlyArray<string>, destination: string, opts?)`.
`sources` is always an array (a single rename is `mv(['a.txt'], 'b.txt')`);
`destination` is a separate, always-present argument. The facade binds it as
`repo.mv(sources, destination, opts?)`.

## Consequences

### Positive

- Uniform with `rm`/`add` (`ReadonlyArray<string>` paths) and the established
  `(from, to)` rename precedent — one mental model across the command surface.
- No positional ambiguity: the destination can never be mistaken for a source,
  eliminating the trailing-element off-by-one class of bugs.
- No primitive union to narrow; the type is unambiguous and Calisthenics-clean.

### Negative

- The most common case — a single-file rename — is slightly more verbose
  (`mv(['a.txt'], 'b.txt')` rather than `mv('a.txt', 'b.txt')`).

### Neutral

- Diverges from the literal CLI positional grammar; acceptable because tsgit is
  a library API, not a CLI argv parser, and every other multi-path command
  already makes the same trade.
