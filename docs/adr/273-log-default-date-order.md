# ADR-273: `log` defaults to git's committer-date all-parents order

## Status

Proposed

## Context

`repo.log()` walks `walkCommits` with `order: 'first-parent'` — it follows only
the first parent of each commit. `git log` with **no** order flag does not: it
walks **every** parent and orders the frontier by **committer timestamp, newest
first** (git's commit-date `prio_queue`, `commit.c:
compare_commits_by_commit_date`). So on any branchy history `repo.log()` silently
omits every merged-in commit that real `git log` shows — a faithfulness divergence
against the prime directive.

23.4b shipped `walkCommitsByDate` for exactly this: "the Core a converged `log`
projects over" (ADR-261). The capstone (ADR-272) wires `log` onto it. The
remaining decisions are the **public option shape**:

- **default order** — adopt git's date/all-parents default (faithful, but a
  breaking output change on branchy histories), or keep first-parent and offer
  date as opt-in (non-faithful default, non-breaking);
- **which orders to expose** — only what is byte-pinnable against real git, or a
  wider set (`topo`, `author-date`).

git's `--first-parent` is itself a faithful, named mode (`git log --first-parent`),
so today's behaviour is not wrong — only mis-defaulted.

## Decision

`log` resolves via the **`revParse` grammar** (peeling to a commit; ADR-272) and
projects over the date walk by default:

```ts
export type LogOrder = 'date' | 'first-parent';

interface LogOptions {
  readonly rev?: string;                       // commit-ish, full grammar; default 'HEAD'
  readonly order?: LogOrder;                   // default 'date'
  readonly excluding?: ReadonlyArray<string>;  // commit-ish stops, full grammar
  readonly limit?: number;
  readonly before?: Date;
}
```

- **Default `order: 'date'`** → `walkCommitsByDate` (all parents, newest
  committer-date first). This is git's default `git log` order. **Breaking**: a
  branchy `repo.log()` now yields the merged-in commits and in date order, not the
  first-parent spine. 23.4 is the agreed breaking window.
- **`order: 'first-parent'`** → `walkCommits` first-parent — today's behaviour,
  preserved as an explicit, faithful (`git log --first-parent`) mode.
- **Exposed set is `'date' | 'first-parent'` only.** Both pin byte-for-byte
  against real git. `topo` / `author-date` are **deferred** (YAGNI): `walkCommits`
  topo's branch-grouping is not obviously byte-faithful to `git log --topo-order`,
  and author-date ordering needs a walk the model does not have. Add either only
  when a faithful golden is feasible.
- `LogEntry` is **unchanged** (raw `message`, no folded `subject` — ADR-249: the
  caller folds via `foldSubject`).

`excluding` and `before` keep their meaning: `excluding` entries resolve through
the same grammar and become the walk's per-oid `until` boundaries (ancestor
*painting* à la git's `^X` remains out of scope, unchanged); `before` stays a
post-walk committer-date skip filter.

## Consequences

### Positive

- `repo.log()` becomes faithful to `git log`'s default for the first time —
  branchy histories included — pinned by a cross-tool `log-interop` golden.
- `log` collapses to a thin projection: resolve via grammar → pick walk → filter
  → project. The bespoke `resolveStart`/`resolveExcluding` (and their swallow +
  equivalent-mutant suppressions) are deleted.
- `~`/`^`/`@{…}`/oid-prefix and annotated-tag peeling now work in `log`
  (`repo.log({ rev: 'HEAD~3' })`, `repo.log({ rev: <annotated-tag> })`).

### Negative

- Breaking output change for any caller relying on the first-parent default; they
  migrate by passing `order: 'first-parent'`. Acceptable in the 23.4 window and
  documented in the PR + README.

### Neutral

- The lazy `walkCommitsByDate` equals strict `git rev-list --date-order` for every
  causally-dated history (ADR-261); the converged `log` does not need strict
  `--date-order`, so it is not built (deferred per ADR-261).
- `order` is a behaviour selector, not a rendering flag, so it is ADR-249-clean.
- `reports/api.json` regenerates for the new `LogOptions` shape + `LogOrder` type.
