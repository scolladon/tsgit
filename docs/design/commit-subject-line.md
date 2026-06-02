# Design — unify the commit-subject (first-line) projection

## Goal

Behaviour-preserving consolidation surfaced by 22.3a's architecture pass. The
projection "the subject of a commit = the first line of its message" is hand-rolled
in **four** places, two as named `subjectOf` helpers and two inline:

| site | form |
|------|------|
| `application/commands/internal/history-rewrite.ts` `subjectOf` | `message.split('\n')[0] as string` |
| `application/commands/internal/stash-message.ts` `subjectOf` | `indexOf('\n')` + `slice` |
| `application/commands/internal/revert-state.ts` (`revertMessage`) | `cData.message.split('\n')[0] as string` |
| `application/commands/commit.ts` (reflog subject) | `message.split('\n')[0] as string` |

22.3b named only the two `subjectOf` helpers, but a completeness sweep
(`grep "split('\n')[0]"` / `indexOf('\n')`) found the two inline copies of the
*same* projection. Unifying all four is the honest, complete version of the task —
the first-line projection is exactly the feature's concern — and the two inline
sites are squarely inside its blast radius, not scope-creep.

Extract one pure domain helper, route all four sites through it, delete the two
local `subjectOf` helpers and the two inline expressions. No SHA / ref / reflog /
message / on-disk change: every site already computes the first line, and the new
helper returns the byte-identical result (verified against the existing command
suites + the empty-message edge).

## The two implementations are equivalent

- `message.split('\n')[0]` — splits the whole string, returns element 0. Needs an
  `as string` cast because `[0]` is `string | undefined` under
  `noUncheckedIndexedAccess` (yet `split` always yields ≥1 element).
- `indexOf('\n')` + `slice(0, nl)` (or the whole string when `nl === -1`) — no
  array allocation, no cast, naturally typed `string`.

For inputs with no `\n` both return the input; for `'a\nb'` both return `'a'`; for
`''` both return `''` (`''.split('\n')[0] === ''`; `''.indexOf('\n') === -1` →
whole string `''`). The unified helper adopts the **`indexOf`/`slice`** form: it
avoids the throwaway array and the `as string` cast, so the production code carries
no cast hack.

## Decision

A pure function in `src/domain/objects/commit-message.ts` — the existing home of
commit-message text operations (`stripspace`). It is **not** added to the
`domain/objects/index.ts` barrel: that barrel feeds `domain/index.ts`, a typedoc
entry point, so barrel-exporting would put the helper in the published `api.json`
surface and the doc gate. The helper is internal; the four consumers import it
directly from `commit-message.js` (the codebase already imports domain symbols by
file, e.g. `CommitData` from `commit.js`). Net public-API change: **none**
(`reports/api.json` unchanged), mirroring 22.3a.

```ts
/** A commit's subject: the first line of its message (everything before the
 *  first newline, or the whole string when single-line). Empty → empty. */
export const subjectLine = (message: string): string => {
  const newline = message.indexOf('\n');
  return newline === -1 ? message : message.slice(0, newline);
};
```

**Name — `subjectLine`** (recommended). git calls a commit's first line its
*subject*; all four call-sites assign the result to a `subject`. `subjectLine`
reads cohesively in `commit-message.ts` ("the subject line of a commit message")
and at every call-site (`subject: subjectLine(cData.message)`). The 22.3b backlog
gestured at the more generic `firstLine`; that is the alternative (see ADR
conversation). The *home* (`commit-message.ts`) and *internal-ness* (no barrel)
are not in question — only the identifier.

### Consumers (route through the helper, drop the local copies)

- `history-rewrite.ts` — delete its `subjectOf` export (keep `readCommitData` /
  `treeOf` / `requireSymbolicHead`). Its importers — `cherry-pick.ts`,
  `revert.ts`, `rebase.ts` — drop `subjectOf` from the `history-rewrite` import and
  import `subjectLine` from `../../domain/objects/commit-message.js`.
- `stash-message.ts` — delete its `subjectOf` export (keep the branch-label +
  message builders). Its importer `stash.ts` imports `subjectLine` from the domain
  module instead.
- `revert-state.ts` (`revertMessage`) — replace the inline expression with
  `subjectLine(cData.message)`.
- `commit.ts` — replace the inline expression (and drop its now-redundant
  `// split always yields…` cast comment) with `subjectLine(message)`.

Call-sites keep their local `subject` variable name; only the right-hand side
changes. `git diff main...HEAD` over the command suites stays green (behaviour pin).

## Alternatives considered

1. **`firstLine` in `commit-message.ts`** — matches the backlog wording; generic
   name. Rejected as the recommendation because the domain meaning is uniformly
   "commit subject" and git's own term is *subject*; surfaced to the user (Step 3).
2. **A new generic `domain/text.ts` string util** — over-engineering for one
   one-liner with a single domain meaning (YAGNI); no other generic string helper
   exists to anchor such a module. Rejected.
3. **Barrel-export via `domain/objects/index.ts`** — would bloat the public
   `api.json` surface and trigger the doc gate for an internal helper. Rejected in
   favour of a direct file import (keeps the API minimal).
4. **Leave the two inline sites, unify only the two `subjectOf` helpers** — leaves
   the identical projection duplicated in `revert-state.ts` / `commit.ts`; a
   half-done consolidation. Rejected — they are in scope and trivially folded.

## Out of scope (bounded blast radius)

- `stripspace`, `quoteSubject`, and other commit-message operations are unrelated
  to the first-line projection and untouched.
- No other "first N lines" / body-vs-subject splitting exists today; if one
  appears later, `commit-message.ts` is the home — not pre-built now (YAGNI).

## Testing

`subjectLine` is a pure domain function → tested in the existing
`commit-message` test files (same module, same conventions).

**Example tests** (`commit-message.test.ts`, 2-level GWT shortcut + AAA + `sut`):
multi-line → first line; single-line (no `\n`) → unchanged; empty → `''`; leading
newline (`'\nx'`) → `''`; CRLF (`'a\r\nb'`) → `'a\r'` (git's subject is bytes
before `\n`, CR retained — documents the literal behaviour the four sites already
have); trailing newline (`'a\n'`) → `'a'`.

**Property tests** (`commit-message.properties.test.ts`, reuse `arbCommitMessage`):
lens 4 (idempotence) fits a projection — ship a sibling block:
- idempotence: `subjectLine(subjectLine(m)) === subjectLine(m)` (numRuns 200);
- result contains no `\n` (numRuns 200);
- result is a prefix of the input (`m.startsWith(subjectLine(m))`) (numRuns 200).

These invariants are independent of the impl (not a tautological re-implementation),
so they are legitimate per the property-test guidance.

**Behaviour pins:** the existing `cherry-pick` / `revert` / `rebase` / `stash` /
`commit` unit + interop suites exercise every routed call-site; they stay unchanged
and green. The `subjectOf` describe block in `history-rewrite.test.ts` is removed
(the function moved); if `stash-message` has a `subjectOf` test, it is removed too —
coverage is relocated to the `commit-message` tests, no behaviour lost.

Coverage stays 100%; mutation target 0 killable survivors on `subjectLine` (the
`indexOf`/`slice`/`=== -1` branches are each pinned by the example sweep).

## Files touched

- `src/domain/objects/commit-message.ts` — **add** `subjectLine`.
- `src/application/commands/internal/history-rewrite.ts` — remove `subjectOf`.
- `src/application/commands/internal/stash-message.ts` — remove `subjectOf`.
- `src/application/commands/cherry-pick.ts` / `revert.ts` / `rebase.ts` /
  `stash.ts` — swap the import to `subjectLine`.
- `src/application/commands/internal/revert-state.ts` / `commit.ts` — replace the
  inline expression with `subjectLine`.
- `test/unit/domain/objects/commit-message.test.ts` — `subjectLine` example tests.
- `test/unit/domain/objects/commit-message.properties.test.ts` — `subjectLine`
  property block.
- `test/unit/application/commands/internal/history-rewrite.test.ts` (and
  `stash-message` test if present) — remove the relocated `subjectOf` block.
- `docs/BACKLOG.md` — flip 22.3b `[ ]` → `[x]`.
