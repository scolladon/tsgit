---
subjects:
  - src/application/commands/rev-parse.ts
---
# 940 — revParse returns git's ordered revision list

- **Status:** accepted
- **Date:** 2026-10-04
- **Design:** docs/design/alternates-object-lookup.md · **Supersedes/Refines:** refines ADR-249, ADR-226

## Context

`git rev-parse` prints one line per revision it resolves. A plain name prints one object. Range and
parent forms print several, in git's order, with excluded ones marked `^`:

- `A..B` prints `B` then `^A`;
- `A...B` prints `B`, `A`, then `^<merge base>` for each base, newest first;
- `X^@` prints X's parents;
- `X^!` prints `X` then `^<parent>` for each parent;
- `X^-n` prints `X` then `^<nth parent>`.

tsgit's public `revParse` returned a single `ObjectId` and refused every one of these forms, which
is `git rev-parse --verify` behaviour, not plain `git rev-parse`.

## Options considered

1. **Keep `revParse` single-object; add a separate list API.** Not breaking.
2. **`revParse` returns a union** — `{ kind: 'object', id } | { kind: 'range', include, exclude }`.
3. **`revParse` always returns the ordered list** — `readonly { id, negated }[]`, git's stdout as data.

## Decision

**User-ratified — option 3.** `revParse` returns `readonly RevParseEntry[]`, where
`RevParseEntry = { readonly id: ObjectId; readonly negated: boolean }`, in exactly the order git
prints. A plain name returns one entry. This is data, not rendering (ADR-249): the `^` prefix git
prints becomes `negated: true`; callers render it.

## Consequences

- Breaking public change (`feat(rev-parse)!`); `reports/api.json` and the `docs/use` page are updated.
- Internal callers that need one object move to the internal single-object evaluator, so they keep
  git's per-command semantics (`--verify`-style readers keep refusing ranges where git refuses).
- Interop rows rebuild git's stdout from the entries (`negated ? '^' + id : id`) and compare it
  byte-for-byte for ranges, symmetric ranges and `^@` / `^!` / `^-n`.
