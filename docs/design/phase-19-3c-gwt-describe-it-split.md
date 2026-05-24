# Phase 19.3c — GWT describe/it split

Promote the GWT clauses out of the `it()` title into the surrounding
`describe()` hierarchy. Today every leaf reads:

```ts
it('Given a SUT in state X, When we call op(arg), Then result is Y', …)
it('Given a SUT in state X, When we call op(arg), Then it does not throw', …)
```

The `Given … When …` prefix is *re-typed at every leaf*. Reading a file
means re-parsing the same context six or eight times to spot the unique
`Then` clause. Test-runner output reads as a wall of duplicated prefixes.

New convention — the same eight tests become:

```ts
describe('Given a SUT in state X', () => {
  describe('When we call op(arg)', () => {
    it('Then result is Y', …);
    it('Then it does not throw', …);
  });
});
```

The Given/When live where they belong — on the *group* — and the leaf
carries only the Then. Reading the file becomes scanning the spec
hierarchy; the runner output mirrors that hierarchy.

## 1. Goals

1. **Lift Given/When into `describe()` blocks.** `it()` titles carry
   only the `Then` clause.
2. **Group leaves by shared Given+When.** Sibling `it()`s under one
   `describe('When …')` differ only in expectation.
3. **Update the `gwtTitle` heuristic** to validate the describe→it path,
   not the leaf title alone.
4. **Sweep all 4,323 existing `it()` titles** across 219 unit-test files
   in the same PR — same playbook as 19.3 / 19.3a (implement → cleanup
   → gate-flip).
5. **No new heuristic key.** The semantic is "GWT title shape is
   enforced"; we keep `gwtTitle` and replace its rule.
6. **CI hygiene companion change.** Add a `cancel-on-merge` workflow so
   in-flight feature-branch CI runs are cancelled when the PR merges
   (the new-commit cancellation is already wired via
   `cancel-in-progress: true` on every workflow that should ride a
   single ref).

## 2. Non-goals

- **No retirement of any other heuristic.** `aaaBody`, `sutNaming`,
  `bareClassToThrow`, `emptyAaaSection`, `underAssertedUnit` are
  untouched.
- **No AST switch.** Stays regex/brace per ADR-097. We add a second
  scanner pass for `describe()` openers, mirroring the existing
  paren/brace walker.
- **No new tier or new gating key.** Same `tier: unit`, same gating
  flag (`gating.gwtTitle` stays `true`).
- **No suppression mechanism.** Same posture as 19.3.
- **No retroactive change to integration/e2e titles.** Scope stays
  `test/unit/**` (+ `tooling/test/unit/**`).
- **`skipIf` / `runIf` two-stage form** stays a 19.3b follow-up; this
  phase does not preempt it.

## 3. Heuristic — GWT describe/it split

### 3.1 Accepted shapes

For every unit `it()`/`test()` block, the title and its `describe()`
ancestors must match **one** of the two shapes below.

**3-level (preferred)** — Given and When split across two describe
ancestors:

```
describe('Given <context>')
  describe('When <action>')
    it('Then <expected>')
```

**2-level** — Given and When folded into one describe (single
expectation under one When):

```
describe('Given <context>, When <action>')
  it('Then <expected>')
```

The leaf `it()` title MUST start with `Then `. The closest GWT-bearing
`describe()` ancestor MUST start with `Given ` or with the combined
form `Given …, When …`. If the closest GWT ancestor is `Given …` only
(no `When`), the next ancestor up MUST start with `When `.

### 3.2 Non-GWT ancestors are transparent

A `describe()` that does not start with `Given ` or `When ` (e.g.
`describe('moduleName')` or `describe('subjectName')`) does not block
the rule and does not satisfy it — the rule walks past it. This keeps
the door open for an outer module-name describe wrapping GWT groups,
which several files already use (`describe('noopProgress', () => { it(…)
})`).

A `describe()` that starts with `When ` while no `Given ` ancestor
exists above it is malformed and surfaces as a finding (`reason:
'missing-given'`).

### 3.3 Reasons

| Reason | Trigger |
|---|---|
| `missing` | `it()` has no literal title |
| `then-missing` | leaf title does not start with `Then ` |
| `when-missing` | no `Given …, When …` ancestor and no `describe('When …')` ancestor |
| `given-missing` | a `When …` describe ancestor exists but no `Given …` above it |
| `legacy-it-gwt` | leaf title still matches the old `Given …, When …, Then …` shape — caught explicitly so the sweep can flip it |
| `nested-gwt` | a GWT describe ancestor sits *inside* another GWT describe of the same clause (two nested `Given …` or two nested `When …`) — author error |

`then-missing` + `when-missing` together cover the "plain `it('does
X')`" case (both fire); we surface the more actionable one
(`then-missing`) for that report row.

### 3.4 Skipped tests

`.skip` / `.todo` / `.fails` blocks are still validated — same posture
as 19.3 (ADR-113 §Decision bullet 4).

## 4. Algorithm

### 4.1 Scanner extension — `scanDescribeBlocks`

A new pass alongside `scanItBlocks`. Same paren/brace walker, same
title-literal extractor, same skip-modifier set. For each `describe()`
opener, emit `{ line, title, openIdx, closeIdx }`.

`scanItBlocks` remains unchanged; we read its existing
`{ line, title, body, isSkipped }` records and *join* against the
describe records by source-offset containment.

### 4.2 Ancestor-path resolution

For each `it()` record, find the chain of `describe()` records whose
`(openIdx, closeIdx)` span strictly contains the `it()` opener offset.
Order the chain **closest-first** (`path[0]` is the immediate parent,
`path[N-1]` is the outermost ancestor). Build the GWT sub-path by
keeping only entries whose title starts with `Given ` or `When `
(case-sensitive, single trailing space). Non-GWT describes are
skipped.

### 4.3 Validation

Apply the rules in §3.1–§3.3 to each `it()` record. The filtered GWT
sub-path uses the closest-first ordering established in §4.2.

1. **Empty literal** → `missing`. Stop.
2. **`Then ` prefix on the leaf** — if absent, fall back: if title
   matches the legacy `^Given .+?, When .+?, Then .+$` regex, emit
   `legacy-it-gwt`; else emit `then-missing`. Stop in either branch.
3. **GWT ancestors** — read the filtered sub-path:
   - empty → `when-missing`.
   - 1 entry — `path[0]` matches `^Given .+?, When .+$` → OK;
     `path[0]` matches `^When .+$` only → `given-missing`;
     `path[0]` matches `^Given .+$` only → `when-missing`.
   - 2 entries — `path[0]` must match `^When .+$` and `path[1]` must
     match `^Given .+$`. Any other arrangement (e.g. closest = Given,
     outer = When) → `nested-gwt`.
   - ≥3 entries — `nested-gwt` (a third clause means a Given or a
     When is duplicated up the chain; the author error is the same).

### 4.4 Findings shape

```ts
export interface BadTitleFinding {
  readonly path: string;
  readonly line: number;
  readonly title: string;       // leaf it() title
  readonly ancestors: ReadonlyArray<string>; // GWT-only describe ancestors, outer→inner
  readonly reason: BadTitleReason;
}
```

Sort by `(path, line)` — unchanged from 19.3.

## 5. Manifest

The `gwtTitle` heuristic block in `test-pyramid-budgets.json` switches
shape:

```jsonc
"gwtTitle": {
  "tier": "unit",
  "describeWhen": "^When .+$",
  "describeGiven": "^Given .+$",
  "describeCombined": "^Given .+?, When .+$",
  "itThen": "^Then .+$",
  "legacyItGwt": "^Given .+?, When .+?, Then .+$"
}
```

Five string patterns replace the single `regex`. `legacyItGwt` is
used only to flag legacy titles distinctly during the sweep window —
it stays in the manifest so the rule's intent is auditable.
`compileRegex` calls produce stateless `RegExp` objects per ADR-113
(no `g` flag).

`parse-manifest.ts` validates all five fields and compiles them. The
schema file (`tooling/test-pyramid-budgets-schema.json`) lists them as
required.

## 6. Codemod — one-shot sweep

`tooling/codemod-gwt-describe-split.ts`. CLI entry point:

```
node --experimental-strip-types tooling/codemod-gwt-describe-split.ts \
  [--root <repo-root>] [--glob <pattern>] [--check]
```

`--check` exits non-zero if any file would be rewritten — used by the
audit's own self-test fixture, not CI.

### 6.1 Algorithm per file

1. Run `scanItBlocks` + `scanDescribeBlocks` to map the current
   structure.
2. For each top-level `describe()` (or top-level `it()` group when no
   describe exists), partition the `it()` children by shared
   `(Given, When)` extracted from the **old** title regex.
3. For each partition, emit a new `describe('Given …', () => {
   describe('When …', () => { it('Then …', …); … }); })` block.
   The codemod always emits the **3-level** form for consistency;
   the 2-level shortcut is accepted by the heuristic (§3.1) but is
   never produced by the codemod. Hand-edits may collapse to 2-level
   when readability benefits.
4. Preserve all non-`it()` content (imports, helpers, `beforeEach`,
   nested non-GWT describes) verbatim; only the `it()` titles and
   their enclosing braces change.
5. Re-emit the file with the new structure, preserving original
   indentation step (two spaces).

### 6.2 Safety rails

- The codemod **never** rewrites a file whose `it()` titles don't
  match the legacy `^Given .+?, When .+?, Then .+$` shape — those land
  on the human as findings.
- A `--dry-run` mode prints the diff per file without writing.
- The codemod runs **once** in the implementation commit, then is
  deleted in the cleanup commit. It does not ship.

### 6.3 Residue

A residue of files that exercise edge cases the codemod cannot rewrite
(table-driven `it.each`, interpolated titles, `it.skipIf(…)('Given
…')`, etc.) get hand-fixed in a follow-up commit on the same PR. Pre-
sweep estimate: ≤ 15 files (~1% of the population).

## 7. CI hygiene companion

### 7.1 Existing state

Every `cancel-in-progress: true` workflow (ci, bench, pkg-pr-new,
weekly-reports) already cancels a previous run when a new commit
arrives on the same ref. The gap is *merge*: when a PR is merged, its
feature branch's last CI run keeps spinning until it self-completes.
Wasted minutes; reviewers see stale red/green.

### 7.2 New workflow — `.github/workflows/cancel-on-merge.yml`

```yaml
name: cancel-on-merge
on:
  pull_request:
    types: [closed]

permissions:
  actions: write

jobs:
  cancel:
    if: github.event.pull_request.merged == true
    runs-on: ubuntu-latest
    steps:
      - uses: actions/github-script@v8
        with:
          script: |
            const { owner, repo } = context.repo;
            const sha = context.payload.pull_request.head.sha;
            const runs = await github.paginate(
              github.rest.actions.listWorkflowRunsForRepo,
              { owner, repo, head_sha: sha, status: 'in_progress' }
            );
            for (const run of runs) {
              await github.rest.actions.cancelWorkflowRun({
                owner, repo, run_id: run.id,
              });
            }
```

`actions: write` is the minimum permission. `pull_request: closed` +
`merged === true` is the standard merge filter (close-without-merge
events do not trigger cancellation — those usually mean the author
wants the run output as a record).

The workflow runs in the **target** repo (the merge destination), so
it needs no fork-PR contortions. Cancellation against the merged-PR
head SHA targets only the runs that became irrelevant the moment the
PR squash-merged.

## 8. Test strategy

### 8.1 Unit tests — heuristic

- `scanDescribeBlocks` — title extraction, nesting, skip modifiers,
  malformed input (matches `scanItBlocks` coverage).
- `detectBadTitle` (rewritten) — one fixture per reason in §3.3; one
  fixture per accepted shape in §3.1; one fixture proving the
  module-describe transparency rule.
- `parseManifest` — new field validation, missing-field errors.

### 8.2 Unit tests — codemod

- Round-trip fixtures: legacy input → expected output for each
  recipe.
- `--check` exit code.
- Non-rewritable file passes through unchanged.

### 8.3 Integration test — audit

Existing `audit-test-pyramid.test.ts` keeps a synthetic fixture pinned
to the manifest contract. Update the fixture to assert the new
findings shape.

### 8.4 Sweep verification

After the codemod runs, the test suite still passes:
`npm run test:unit`, `npm run validate`, `stryker run` (diff-scoped).

## 9. Mutation posture

Same posture as 19.3. Equivalent mutants documented inline. Targets:
the new scanner pass (mirrors 19.3 baseline), the rewritten detector
(higher branch density — one branch per reason).

## 10. Open questions

- **Order of clauses in 2-level describes.** Decision: combined form
  is `'Given X, When Y'` — same comma + space + capital separator as
  the legacy `it()` title. Documented in ADR-117.
- **Should the codemod ship?** No. It's a one-shot. Same line as the
  19.3a sweep.

## 11. ADRs

- **ADR-117** — GWT-clause partitioning between `describe` and `it`
  (this design's core convention decision).
- **ADR-118** — Two-pass scanner (`scanItBlocks` + `scanDescribeBlocks`)
  with offset-containment join, keeping regex/brace per ADR-097.
- **ADR-119** — Cancel-on-merge workflow scope (only on PR-close where
  `merged === true`; no close-without-merge cancellation).
