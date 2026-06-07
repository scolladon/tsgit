# ADR-280: `range-diff` names the two ranges and sides `old` / `new`

## Status

Accepted

## Context

`range-diff` takes two ranges and produces entries that may carry a left and/or a
right commit. Git's CLI forms (`<oldBase>..<oldTip> <newBase>..<newTip>`, the
3-arg `<base> <tip1> <tip2>`, the symmetric `<tip1>...<tip2>`) all reduce to two
`(base, tip)` ranges, and git's mental model + docs call them the **old** and the
**new** version of a series (the columns print old-on-the-left, new-on-the-right).

Naming options for the input ranges and the output entry sides + status enum:

- **`old` / `new`** — faithful to git's vocabulary. `new` is a reserved word but
  is a legal object-property/key in TypeScript (`opts.new`, `entry.new` both
  compile).
- **`before` / `after`** — same semantics, no reserved-word friction.
- **`left` / `right`** — matches the printed columns, but positional rather than
  semantic (loses the "old version vs new version" meaning).

The rev-vocabulary discipline (ADR-266: `rev`/`from`/`to`/`ref`) does not cover
this case — these are two *ranges*, not a single commit-ish or a `from`/`to` diff
pair.

## Decision

Use **`old` / `new`** for both the input ranges (`RangeDiffOptions.old`,
`.new`, each a `{ base, tip }`) and the output sides (`RangeDiffEntry.old?`,
`.new?`), with the status enum `'unchanged' | 'changed' | 'only-old' |
'only-new'` (git's `= ! < >`). The `subject` is the old commit's folded subject
when present, else the new's (git's `oid = a_util ? a : b`).

## Consequences

### Positive

- Faithful to git's documented model; a reader who knows `git range-diff` maps
  `old`/`new` and `= ! < >` directly onto the structured result.
- Symmetric naming across input and output (the `old` range produces `old`
  entries), and the status enum reads self-evidently (`only-old` = dropped).

### Negative

- `new` is a reserved word; `entry.new` / `{ new: … }` are legal but can read
  awkwardly and may trip naive lint configs. Accepted for fidelity; the
  alternative (`before`/`after`) was the fallback only if the keyword proved
  unworkable, which it does not.

### Neutral

- `left`/`right` (the column vocabulary) is rejected as positional; `before`/
  `after` is rejected only because `old`/`new` is the more faithful term.
