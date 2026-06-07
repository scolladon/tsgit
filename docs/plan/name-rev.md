# Implementation plan — `name-rev` + `describe --contains`

Per-slice TDD (Red → Green → Refactor). Each slice = one atomic commit. Gate
every commit on `npm run check:types` + `npx vitest run <files>`; run the **full**
`npm run validate` once the facade is wired (slice 6, the first green-able point)
and again before push. Branch commits squash-merge, so transient knip
unused-export warnings between bottom-up slices are expected until slice 6.

Algorithm reference: `docs/design/name-rev.md`. ADRs 283 (structured path), 284
(describe --contains overload + refuse-bad-combo), 285 (ref-glob dialect).

Conventions: GWT describe/it tree, AAA body, `sut`, 100% coverage, 0 killable
mutants, no ignore directives, no phase/ADR refs in source. Property siblings
where the four lenses fit (comparator, total-function matcher, render round-trip).

---

## Slice 1 — domain: selection comparator + types

**Files:** `src/domain/name-rev/types.ts`, `src/domain/name-rev/is-better-name.ts`,
`test/unit/domain/name-rev/is-better-name.test.ts`,
`test/unit/domain/name-rev/is-better-name.properties.test.ts`,
`test/unit/domain/name-rev/arbitraries.ts`.

`types.ts`:
```ts
export type NameRevStep =
  | { readonly kind: 'ancestor'; readonly count: number }
  | { readonly kind: 'parent'; readonly number: number };

export interface RevName {
  readonly ref: RefName;
  readonly tagDeref: boolean;
  readonly fromTag: boolean;
  readonly taggerDate: number;
  readonly generation: number;
  readonly distance: number;
  readonly steps: ReadonlyArray<NameRevStep>;
}
```

`is-better-name.ts` — `isBetterName(existing: RevName, incoming: RevName): boolean`
implementing the empirically-pinned order (ADR-283/design §2.2):
1. `existing.fromTag !== incoming.fromTag` → `incoming.fromTag`
2. else if `existing.distance !== incoming.distance` → `existing.distance > incoming.distance`
3. else → `existing.taggerDate > incoming.taggerDate`

**Red → Green tests (each guard isolated, mutation-resistant):**
- tag beats non-tag (existing non-tag, incoming tag → true); reverse (existing
  tag, incoming non-tag → false) — proves guard 1 both directions.
- same tag-ness, incoming nearer → true; incoming farther → false — guard 2 both
  directions.
- equal distance, incoming older taggerDate → true; newer → false — guard 3 both.
- full tie (equal fromTag, distance, taggerDate) → false (keep existing).
- guard precedence: incoming is a *farther* tag vs nearer non-tag existing → true
  (tag wins despite larger distance — proves guard 1 precedes guard 2).

**Property** (`is-better-name.properties.test.ts`, case 2 comparator): a tag
always beats a non-tag for any distances; for equal tag-ness the relation is a
strict weak order on `(distance, taggerDate)` — `isBetterName(a,a) === false`
(irreflexive); not both `isBetterName(a,b)` and `isBetterName(b,a)` (asymmetric).
numRuns 100. Generators in `arbitraries.ts` (a `RevName` arbitrary).

Commit: `feat(name-rev): selection comparator`

---

## Slice 2 — domain: structured-path step builders

**Files:** `src/domain/name-rev/step.ts`,
`test/unit/domain/name-rev/step.test.ts`,
`test/unit/domain/name-rev/step.properties.test.ts`.

Three pure helpers producing the next `RevName` for a parent + the projection:
```ts
firstParentName(name: RevName): RevName        // generation+1, distance+1, steps unchanged
mergeParentName(name: RevName, parentNumber: number): RevName
  // steps = [...steps, ...(generation>0 ? [{kind:'ancestor',count:generation}] : []), {kind:'parent',number:parentNumber}]
  // generation = 0, distance = distance + MERGE_TRAVERSAL_WEIGHT (65535)
foldSteps(name: RevName): ReadonlyArray<NameRevStep>
  // generation>0 ? [...steps, {kind:'ancestor',count:generation}] : steps
```
`MERGE_TRAVERSAL_WEIGHT = 65535` is a named constant here.

**Tests:**
- firstParentName bumps generation + distance by 1, leaves steps/ref/tagDeref/
  fromTag/taggerDate untouched (assert each field).
- mergeParentName with `generation > 0`: appends `{ancestor, generation}` then
  `{parent, n}`, resets generation 0, distance += 65535.
- mergeParentName with `generation === 0`: appends only `{parent, n}` (no leading
  ancestor) — isolated test (kills the `generation>0` guard mutant).
- foldSteps with generation 0 → steps verbatim; with generation > 0 → trailing
  ancestor appended — two isolated tests.
- distance constant: assert `+= 65535` exactly (literal), not just `> distance`.

**Property** (`step.properties.test.ts`, case 1 round-trip): for an arbitrary
`RevName`, rendering `foldSteps(name)` to the `~`/`^` token string and re-parsing
(test-owned parser) recovers the same step sequence. numRuns 200.

Commit: `feat(name-rev): structured path step builders`

---

## Slice 3 — domain: ref-pattern fnmatch + filter + barrel

**Files:** `src/domain/name-rev/ref-pattern.ts`, `src/domain/name-rev/index.ts`,
`test/unit/domain/name-rev/ref-pattern.test.ts`,
`test/unit/domain/name-rev/ref-pattern.properties.test.ts`.

```ts
matchRefGlob(pattern: string, ref: string): boolean   // fnmatch: * -> .*, ? -> ., both cross /, anchored both ends
interface RefFilter { qualifies(ref: string): boolean }
buildRefFilter(opts: { tags: boolean; refs: ReadonlyArray<string>; exclude: ReadonlyArray<string> }): RefFilter
  // qualifies = ref !== 'HEAD'
  //   && (!tags || ref.startsWith('refs/tags/'))
  //   && (refs.length === 0 || refs.some(p => matchRefGlob(p, ref)))
  //   && !exclude.some(p => matchRefGlob(p, ref))
```
`index.ts` re-exports the domain pieces (internal barrel — **not** added to the
objects barrel or api.json entry points).

**Tests (each guard isolated):**
- `matchRefGlob`: `*` crosses `/` (`refs/tags/*` matches `refs/tags/rel/v1`);
  `?` matches one char incl `/`; literal matches iff equal; anchored (no partial
  — `tags/*` does NOT match `refs/tags/x`); regex metachars in the ref/pattern
  are escaped (`.` is literal: `v1.0` pattern does not match `v1x0`).
- `buildRefFilter`: HEAD excluded; tags-only gate (non-tag dropped when tags);
  empty refs → all included; include must match; exclude drops; exclude wins over
  include. Each as its own test.

**Property** (`ref-pattern.properties.test.ts`, case 3 total function): never
throws on any printable-ASCII pattern/ref; an all-`*` pattern matches every ref;
a metachar-free literal matches iff `pattern === ref`. numRuns 100/50.

Commit: `feat(name-rev): ref-pattern fnmatch matcher`

---

## Slice 4 — command: `nameRev`

**Files:** `src/application/commands/internal/name-rev-options.ts`,
`src/application/commands/name-rev.ts`, export in
`src/application/commands/index.ts`,
`test/unit/application/commands/name-rev.test.ts`.

`name-rev-options.ts` — `parseNameRevOptions(opts): ResolvedNameRevPlan`
normalising `tags` boolean and `refs`/`exclude` (`string | string[] | undefined`
→ `string[]`, reusing the `toPatterns` shape from `describe-options.ts`).

`name-rev.ts`:
```ts
export interface NameRevOptions { tags?; refs?; exclude? }
export interface NameRevResult { oid; ref; tagDeref; steps }   // ADR-283
export const nameRev = async (ctx, rev = 'HEAD', opts = {}): Promise<NameRevResult> => {
  await assertRepository(ctx);
  const target = await resolveCommit(ctx, rev);              // full grammar, peels tags
  const plan = parseNameRevOptions(opts);
  const filter = buildRefFilter(plan);
  const refs = [...await enumerateRefs(ctx)].filter(filter.qualifies).sort();
  const revNames = new Map<ObjectId, RevName>();
  for (const ref of refs) await walkRef(ctx, ref, revNames);  // §2.3 flood with accept-gate
  const name = revNames.get(target);
  return name === undefined
    ? { oid: target, ref: undefined, tagDeref: false, steps: [] }
    : { oid: target, ref: name.ref, tagDeref: name.tagDeref, steps: foldSteps(name) };
};
```
`walkRef`: peel the ref to its tip commit (reuse a local `peelToCommit` mirroring
`describe.ts` — commit oid + annotated flag + outermost tagger date; skip
unresolvable / non-commit refs), seed the tip `RevName`, `accept` it (continue
only if accepted), then the LIFO stack flood: pop → read commit (`readObject`) →
for each parent build `firstParentName`/`mergeParentName` → `accept(parent)` →
reverse-push accepted parents. `accept(oid, cand)` = write + return true iff slot
empty or `isBetterName(existing, cand)`.

**Tests** (`name-rev.test.ts`) — build fixtures with in-memory repo helpers:
- annotated-tag tip → `tagDeref: true`, `steps: []`.
- lightweight-tag tip → `tagDeref: false`, `steps: []`.
- branch tip → `ref` is the branch, `steps: []`.
- first-parent ancestor (n back) → `steps: [{ancestor:n}]`.
- merged side commit → `steps: [{ancestor:m},{parent:2}]` and one deeper
  → `[...,{ancestor:k}]` (the `~m^2~k` shape).
- tag beats nearer branch (selection); near tag beats far tag; equal-distance
  older-tag tie-break — each its own test (drive `isBetterName` through the walk).
- `tags: true` and the only containing ref is a branch → `ref: undefined`.
- `refs` include filter; `exclude` filter — isolated.
- unnameable (no containing ref) → `ref: undefined`, `steps: []`.
- default `rev` = HEAD (omit arg).
- ref that fails to peel to a commit is skipped (guard test).

Commit: `feat(name-rev): name a commit by the nearest containing ref`

---

## Slice 5 — `describe --contains`

**Files:** `src/domain/commands/error.ts` (+ `CANNOT_DESCRIBE` variant + factory),
`src/domain/error.ts` (+ message), `src/application/commands/describe.ts`
(contains branch + overload), `src/application/commands/internal/describe-options.ts`
(reject ancestor-only options with `contains`),
`test/unit/application/commands/describe.test.ts` (+ contains cases),
plus the error's own test location.

- Add `CANNOT_DESCRIBE { oid }` to the `CommandError` union + `cannotDescribe(oid)`
  factory + the `domain/error.ts` message (git: `cannot describe '<oid>'`).
- `describe-options.ts`: when `opts.contains`, throw `INVALID_OPTION` if any of
  `candidates`/`exactMatch`/`firstParent`/`dirty`/`broken` is set (ADR-284);
  otherwise produce a `contains` plan flag + mapped name-rev inputs.
- `describe.ts` — the command returns the union `Promise<DescribeResult |
  NameRevResult>` (the static contains-narrowing lives in the **facade** binding,
  the `show`/`diff` pattern — slice 6; verify `show.ts`'s exact shape first); at
  the top, if `plan.contains` delegate:
  ```ts
  const refsPrefix = plan.all ? (p) => p : (p) => `refs/tags/${p}`;
  const r = await nameRev(ctx, rev, {
    tags: !plan.all,
    refs: plan.include.map(refsPrefix),
    exclude: plan.exclude.map(refsPrefix),
  });
  if (r.ref === undefined && !plan.always) throw cannotDescribe(r.oid);
  return r;
  ```

**Tests:**
- contains default → delegates, returns `NameRevResult` (tag-only naming).
- contains + `all` → all refs considered.
- contains + `match`/`exclude` → mapped to `refs/tags/<pat>` (assert via a repo
  where the pattern includes/excludes a specific tag).
- contains, unnameable, no `always` → `CANNOT_DESCRIBE` (try/catch + `.data.oid`).
- contains + `always`, unnameable → result with `ref: undefined`.
- contains + each ancestor-only option → `INVALID_OPTION` (isolated per option).
- non-contains describe still returns `DescribeResult` (regression).

Commit: `feat(describe): --contains via name-rev delegation`

---

## Slice 6 — facade wiring + docs + api.json  (first full-validate-green point)

**Files:** `src/repository.ts` (interface `nameRev` field + binding;
hand-written overloaded `describe` binding like `show`/`diff`),
`test/unit/repository/repository.test.ts` (add `'nameRev'` to the key-set),
`docs/use/commands/name-rev.md`, `docs/use/commands/README.md` (row + `36 → 37`),
`README.md` (`36 → 37`), `reports/api.json` (regen via `npm run docs:json`).

- `repository.ts`: `readonly nameRev: BindCtx<typeof commands.nameRev>;`
  alphabetised; replace the plain `describe` interface field + binding with the
  hand-written overloaded pair (`{ contains: true }` → `NameRevResult`, else →
  `DescribeResult`), mirroring `show`/`diff`.
- `name-rev.md` doc page mirroring `describe.md` (structured result, the caller
  render helper from design §3, the `describe --contains` delegation note).

Run **`npm run validate`** here — fix doc-coverage / exports / dead-code /
architecture / coverage findings until green. Regenerate `reports/api.json`.

Commit: `feat(name-rev): bind on repository facade + docs`

---

## Slice 7 — interop (cross-tool parity vs real git)

**Files:** `test/integration/name-rev-interop.test.ts`, extend
`test/integration/describe-interop.test.ts` with contains cases.

One git-built repo (pinned dates, signing off): linear + a `--no-ff` merge,
annotated + lightweight tags, a branch, a remote ref. Test-only `render` +
`shortName` helpers (the two strip rules, §1.2) reconstruct git's line. Assert
equality with `git name-rev` / `--tags` / `--refs` / `--exclude` for: annotated
`^0`, lightweight, branch, `~n`, `~m^2~k`, tag-vs-branch + tag-vs-tag selection,
and `undefined`. `describe-interop`: reconstruct `git describe --contains` /
`--all` / `--match`; assert **co-refusal** on an unnameable commit.

Scrub `GIT_*`; compute goldens with signing off (faithfulness harness rules).

Commit: `test(name-rev): cross-tool interop parity`

---

## Slice 8 — parity scenario (node / memory / browser)

**Files:** `test/parity/scenarios/name-rev.scenario.ts` + register in the parity
scenario index.

A small linear+merge history asserting the same `NameRevResult` across adapters.

Commit: `test(name-rev): cross-adapter parity scenario`

---

## Slice 9 — backlog

**Files:** `docs/BACKLOG.md` — flip `23.8` `[ ] → [x]` with the shipped summary;
add `26.2b` (name-rev date-cutoff perf follow-up) in dependency order under
Phase 26.

Commit: `docs(backlog): mark 23.8 done, log 26.2b cutoff follow-up`

---

## Then: workflow Steps 6–9

- **Review ×3** (typescript / security / tests) — fix-all-until-converged.
- **Architecture refactor** — candidate: extract the two-consumer `peelToCommit`
  (describe + name-rev) into a shared internal helper; re-review scoped.
- **Mutation** — `stryker run --mutate` on each touched file; 0 killable.
- **Docs refresh + PR** — README/RUNBOOK/CONTRIBUTING as needed; push; `gh pr create`.
