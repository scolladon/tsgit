# Plan — `describe` (nearest tag distance)

TDD, one slice = one atomic commit. `npm run validate` green before each commit.
Reads `docs/design/describe-nearest-tag.md` + ADR-249. Structured-only: the
library returns data, never a rendered line, and ships no cosmetic option.

## Slice 1 — domain pure helpers (`domain/describe/`)

`feat(describe): pure name-map + candidate helpers`

Red → Green per file; all pure, no I/O.

1. `types.ts`
   - `DescribeName = { readonly name: string; readonly prio: 0 | 1 | 2; readonly taggerDate: number }`
     (taggerDate `0` for non-annotated).
   - `Candidate = { readonly name: string; readonly commitOid: ObjectId; depth: number; readonly foundOrder: number }`.
2. `ref-name.ts` — `describeName(ref: RefName, all: boolean): string`
   - not `--all`: strip `refs/tags/` (precondition: caller only passes tags).
   - `--all`: strip leading `refs/` (so `refs/heads/main` → `heads/main`,
     `refs/tags/v1` → `tags/v1`); a name without `refs/` prefix returns verbatim.
   - Tests: tag short form; `--all` heads/remotes/tags forms; no-`refs/` passthrough.
3. `replace-name.ts` — `shouldReplaceName(existing: DescribeName, incoming: DescribeName): boolean`
   - `incoming.prio > existing.prio` → true.
   - `incoming.prio < existing.prio` → false.
   - equal prio `=== 2` → `incoming.taggerDate > existing.taggerDate`.
   - equal prio `< 2` → false (keep first).
   - Tests: one per guard, isolated (higher; lower; annotated newer; annotated
     equal→false; annotated older→false; lightweight equal→false).
4. `compare-candidates.ts` — `compareCandidates(a: Candidate, b: Candidate): number`
   - `a.depth - b.depth`, else `a.foundOrder - b.foundOrder`.
   - Tests: depth dominates; foundOrder tie-break; identical → 0.
   - `compare-candidates.properties.test.ts` (case 2): antisymmetric signs, depth
     dominates foundOrder, reflexive 0. `numRuns` 100.
5. `match.ts` — `tagNameMatches(name: string, include: readonly string[], exclude: readonly string[]): boolean`
   - empty `include` ⇒ included; else included iff some include glob matches.
   - excluded iff some exclude glob matches; exclusion wins.
   - Build matchers with `compileGlob(pattern, { anchored: true })`.
   - Tests: include-only, exclude-only, both, empty (identity), `*` not crossing `/`.
   - `match.properties.test.ts` (case 2): empty include = identity; appending a
     matching exclude flips true→false. `numRuns` 100.
6. `index.ts` — barrel re-exporting the five modules. **Internal** — not added to
   `domain/objects/index.ts`, stays out of `api.json`.

## Slice 2 — error codes

`feat(describe): NO_NAMES / NO_ANNOTATED_NAMES / NO_REACHABLE_NAMES / NO_EXACT_MATCH`

1. `domain/commands/error.ts` — add four `CommandError` variants, each
   `{ readonly code: '…'; readonly oid: ObjectId }`, and factory functions
   `noNames(oid)`, `noAnnotatedNames(oid)`, `noReachableNames(oid)`,
   `noExactMatch(oid)`.
2. `domain/error.ts` — add four `case` arms to the message switch:
   - `NO_NAMES` → `No names found, cannot describe ${oid}`
   - `NO_ANNOTATED_NAMES` → `no annotated tags can describe ${oid}; try tags:true`
   - `NO_REACHABLE_NAMES` → `no tags can describe ${oid}`
   - `NO_EXACT_MATCH` → `no tag exactly matches ${oid}`
3. Tests in the error unit suite: each factory's `.data` (code + oid) and rendered
   `.message` (kills `StringLiteral` mutants), per the mutation-resistant rules.

## Slice 3 — options parsing (`internal/describe-options.ts`)

`feat(describe): resolve + validate options`

`ResolvedDescribePlan`:
```ts
{ tags: boolean; all: boolean; maxCandidates: number; always: boolean;
  firstParent: boolean; include: string[]; exclude: string[];
  dirty: boolean; broken: boolean }
```
`parseDescribeOptions(opts, hasExplicitInput): ResolvedDescribePlan`:
- `maxCandidates = exactMatch ? 0 : (candidates ?? 10)`; reject `candidates < 0`
  and `candidates` non-integer with `INVALID_OPTION`.
- normalise `match`/`exclude` (`string | string[] | undefined` → `string[]`).
- `dirty`/`broken` truthy **and** `hasExplicitInput` → `INVALID_OPTION`
  (`option 'dirty' and commit-ishes cannot be used together`).
- Tests: defaults; `exactMatch` → 0; `candidates` override; negative/ non-integer
  candidates refuse; match/exclude normalisation (string vs array); dirty+input
  refuse; broken+input refuse. Each guard isolated.

## Slice 4 — the command (`commands/describe.ts`)

`feat(describe): nearest-tag selection command`

Compose the pieces. Internal functions, all reached through the public `describe`.

1. **`buildNameMap(ctx, plan)`** → `Map<ObjectId, DescribeName>`
   - `enumerateRefs(ctx)`, drop `HEAD`, sort by name.
   - keep `refs/tags/*` always; other refs only when `plan.all`.
   - `resolveDirect(ref)`: skip `symbolic` / `missing` (alias/broken).
   - `readObject(oid)`: `tag` object → peel the tag chain (bounded) to a commit
     (skip if terminal not a commit), taggerDate from the **outermost** tagger;
     `commit` → use directly; else (blob/tree) skip.
   - prio by ref location + object type: ref under `refs/tags/` → `2` if it peeled
     through a tag object, else `1` (lightweight); any other ref (only enumerated
     under `--all`) → `0`. taggerDate `0` unless prio `2`.
   - short name via `describeName(ref, plan.all)`; apply `tagNameMatches`
     (include/exclude) before insertion; dedup per commit via `shouldReplaceName`.
2. **exact short-circuit** — peel `input` (`resolveCommitIsh`) to `T`. If
   `nameMap.get(T)` qualifies (`prio` allowed by `tags`/`all`) → result
   `{ distance: 0, exact: true }`. `maxCandidates === 0` (exactMatch) and no exact
   → `noExactMatch(T)`.
3. **walk** — date-ordered PQ (committer date desc, oid asc on ties; local
   insertion-sort helper mirroring `merge-base`). `seen: Set`, `reach: Map<oid,
   Set<number>>`. Pop loop per design §2.3: collect candidates (cap at
   `maxCandidates`, record `gaveUp`), increment non-reachable candidate depths,
   enqueue parents (`firstParent` ⇒ first only) propagating reach. Memoised commit
   reads (date + parents).
4. **select** — sort candidates by `compareCandidates`; winner = `[0]`. If
   `gaveUp`, finish: re-push `gaveUp`, keep popping, increment winner depth for each
   non-reachable commit (depth stays exact `|winner..target|`).
5. **no candidate** — `plan.always` → `{ tag: undefined, name: '', distance: 0,
   exact: false }`; else map empty → `noNames`; else any lightweight present in
   default mode → `noAnnotatedNames`; else → `noReachableNames`.
6. **dirty** — when `plan.dirty || plan.broken`: `status(ctx)`; `dirty =
   indexChanges.length > 0 || workingTreeChanges.some(c => c.kind !== 'untracked')`.
   Wrap in try/catch when `plan.broken` → on failure `dirty = true`. Always present
   in the result as `dirty: boolean` (false when neither option set).
7. assemble `DescribeResult { tag, name, distance, oid: T, exact, dirty }`.
8. Tests (`describe.test.ts`, memory adapter; annotated tags built via
   `writeObject` of a tag object + `updateRef`): exact; nearest-over-farther;
   `tags` vs default; `all` (branch name, depth-beats-prio); `firstParent` merge;
   same-commit newer-tagger-date win; `always` fallback; `dirty` clean/tracked/
   untracked + custom-input refusal; cap/gaveUp (`candidates: 1` over two tags);
   each refusal via try/catch + `.data`. Branch + mutation coverage in mind.

## Slice 5 — facade + public surface

`feat(describe): expose repo.describe`

1. `commands/index.ts` — `export { describe, type DescribeOptions,
   type DescribeResult } from './describe.js'`.
2. `repository.ts` — `readonly describe: BindCtx<typeof commands.describe>` on the
   `Repository` interface; bound method (`guard(); return commands.describe(ctx,
   input, opts)`).
3. `index.ts` (public) — re-export `DescribeOptions` / `DescribeResult` if the
   public barrel re-exports command types (match `ShowOptions` precedent).
4. Regenerate `reports/api.json` (`npm run` doc-typedoc gate) — commit it.
5. Tests: facade binding returns the result; `guard` throws `REPOSITORY_DISPOSED`
   after `dispose` (mirror an existing facade test).

## Slice 6 — cross-tool interop

`test(describe): cross-tool parity vs git`

`test/integration/describe-interop.test.ts` (gated on `GIT_AVAILABLE`, signing
off, pinned dates; `interop-helpers`). Test-only `render(r)` assembles git's line
from the fields. Assert `render(describe(ctx, rev, opts)) === git('describe', …)`
for: nearest annotated, exact commit, `tags`+lightweight, `all` (branch/remote),
merge default vs `firstParent`, `match`/`exclude`, newer-tagger-date win, `always`
fallback, `dirty` clean→`dirty:false` / tracked-change→`dirty:true` (vs git
`-dirty`). `--long`/`--abbrev` git renderings via the matching caller-side render
variant over the SAME fields. **Co-refusal**: `exactMatch` untagged, no-tags repo,
`dirty`+commit-ish.

## Order

1 → 2 → 3 → 4 → 5 → 6. Slices 1–3 are leaf/pure (parallelisable in principle but
trivial; run in-thread sequentially). Slice 4 depends on 1–3; 5 on 4; 6 on 5.
