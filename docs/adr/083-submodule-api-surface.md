# ADR-083: Submodules are a tier-1 command over a tier-2 walk primitive

## Status

Accepted (at `2ad72af`)

## Context

`docs/BACKLOG.md` 17.5 reads: "Submodule walk (recurse into `.gitmodules`,
expose as `repo.submodules` iterator)." The word "iterator" suggests
`repo.submodules` could be a bare `AsyncIterable` property the caller
`for await`s directly.

Every other member of the `Repository` facade — all 18 commands and all 16
primitives — is a *bound function*. A bare iterable property would be the lone
exception: it could not carry options (`ref`, `recursive`), it would be
evaluated lazily in a way inconsistent with the rest of the surface, and it
would not pass through the `guard()` disposed-state check the facade applies
uniformly by wrapping each call.

The codebase already has the precedent for "a streamable thing exposed
nicely": `walkCommits` is a tier-2 primitive returning `AsyncIterable<Commit>`;
`log` is a tier-1 command that consumes it and returns a materialised
`ReadonlyArray<LogEntry>`. The primitive streams; the command materialises;
both are functions; both are on the facade (the primitive under
`repo.primitives`).

## Decision

Ship the pair, mirroring `log` / `walkCommits`:

- `walkSubmodules(ctx, options?)` — tier-2 primitive,
  `AsyncIterable<SubmoduleEntry>`. The streaming form, on
  `repo.primitives.walkSubmodules`.
- `submodules(ctx, opts?)` — tier-1 command, `Promise<SubmodulesResult>` where
  `SubmodulesResult = { kind: 'list'; entries: ReadonlyArray<SubmoduleEntry> }`.
  The materialised form, on `repo.submodules`.

The command takes a discriminated `SubmodulesAction` with a single
`action?: 'list'` member and a `kind`-tagged result — the same shape as
`reflog` and `sparseCheckout` — so future verbs (`status`, `summary`) can be
added without a breaking signature change.

`repo.submodules` is therefore a function, not an iterator. The "iterator" the
backlog names is `repo.primitives.walkSubmodules`.

## Consequences

### Positive

- The facade stays uniform: every member is a guarded bound function.
- A reviewer who knows `log`/`walkCommits` already knows this shape.
- Callers who want bounded memory and early-exit get the primitive iterator;
  callers who want a simple list get the command. Neither is forced on the
  other.
- The `action`/`kind` envelope leaves headroom for `submodule status`-style
  verbs later.

### Negative

- Two public symbols for one feature, plus the slight wording mismatch with
  the backlog line (resolved by this ADR).

### Neutral

- `SubmoduleEntry` is defined once (in the primitive tier's `types.ts`) and
  re-exported by the command, so both surfaces share one type.
</content>
</invoke>
