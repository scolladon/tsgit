# Plan — unify the commit-subject (first-line) projection

Behaviour-preserving. Read `docs/design/commit-subject-line.md` first. Name decided:
`subjectLine`. One pure helper in `domain/objects/commit-message.ts`, **not**
barrel-exported (internal); the four projection sites route through it.

## Slice A — add `subjectLine` + tests (TDD)

Commit: `feat(commit-message): subjectLine — first line of a commit message`

> `feat` not `refactor`: this commit introduces a new domain function with its own
> tests. The consumer rewrites (behaviour-preserving) are the `refactor` slices B–C.

### A.1 — Red: example tests
Add a `subjectLine` describe block to `test/unit/domain/objects/commit-message.test.ts`
(import `subjectLine`; 2-level GWT, AAA, `sut`):
- `'subject\n\nbody'` → `'subject'`
- `'solo'` (no `\n`) → `'solo'`
- `''` → `''`
- `'\nx'` (leading newline) → `''`
- `'a\r\nb'` (CRLF) → `'a\r'` (bytes before `\n`; CR retained — documents literal git subject)
- `'a\n'` (trailing newline) → `'a'`

Run `npx vitest run test/unit/domain/objects/commit-message.test.ts` → fails
(`subjectLine` not exported). **Red.**

### A.2 — Green: the helper
Add to `src/domain/objects/commit-message.ts` (with a doc comment; `indexOf`/`slice`
form — no `as string` cast). Do **not** add to `domain/objects/index.ts`.
Re-run the test file → passes. **Green.**

### A.3 — Property tests
Add a `subjectLine properties` block to
`test/unit/domain/objects/commit-message.properties.test.ts` (reuse
`arbCommitMessage`): idempotence (numRuns 200), result has no `\n` (200), result is
a prefix of the input (200). Run the properties file → passes.

### A.4 — Validate + commit
`npm run validate` → green (verify `git diff reports/api.json` is empty — the
helper is not barrel-exported, so the doc surface is unchanged; if it is NOT empty,
STOP and reassess the no-barrel assumption). Commit slice A.

## Slice B — route the history-rewrite consumers

Commit: `refactor(history-rewrite): use the shared subjectLine helper`

- `history-rewrite.ts` — delete the `subjectOf` export (keep `readCommitData` /
  `treeOf` / `requireSymbolicHead`).
- `history-rewrite.test.ts` — remove the `subjectOf` describe block (coverage
  relocated to commit-message tests in slice A).
- `cherry-pick.ts` / `revert.ts` / `rebase.ts` — drop `subjectOf` from the
  `./internal/history-rewrite.js` import; add
  `import { subjectLine } from '../../domain/objects/commit-message.js';`;
  rename the call expressions `subjectOf(` → `subjectLine(` in each file.
- `npm run validate` → green. Commit.

## Slice C — route stash + the two inline sites

Commit: `refactor(commit-message): route stash, revert, commit through subjectLine`

- `stash-message.ts` — delete the `subjectOf` export (keep the branch-label +
  message builders); remove its `subjectOf` test if one exists.
- `stash.ts` — drop `subjectOf` from the `./internal/stash-message.js` import; add
  the `subjectLine` domain import; `subjectOf(` → `subjectLine(`.
- `revert-state.ts` — replace `cData.message.split('\n')[0] as string` with
  `subjectLine(cData.message)`; add the domain import.
- `commit.ts` — replace `message.split('\n')[0] as string` (and drop the
  `// split always yields…` comment) with `subjectLine(message)`; add the import.
- `npm run validate` → green. Commit.

> B/C ordering note: each command file's existing unit + interop suite is the
> behaviour pin and stays green per commit. No duplication-count gate concern here
> (jscpd minTokens 50 never flagged these one-liners), so slices are grouped by
> subsystem for review clarity rather than by a monotonic-duplication constraint.

## Step 6–8 (workflow, not slices)

- **Review ×3** — typescript / security / tests over `git diff main...HEAD`.
- **Architecture pass** — confirm no *other* first-line/body-split duplication
  remains after the four sites collapse (the sweep in design already found all
  four); likely a no-op with written justification.
- **Mutation** — `stryker run --mutate src/domain/objects/commit-message.ts`; the
  new survivors would be on `subjectLine`'s `=== -1` / `slice` — pinned by the
  empty/leading-newline/multi-line example cases.

## Step 9 — docs + backlog

- Flip `docs/BACKLOG.md` 22.3b `[ ]` → `[x]` with a one-line outcome (4 sites
  unified, not 2; `subjectLine` in `commit-message.ts`, internal).
- No README/RUNBOOK/CONTRIBUTING/get-started change — internal refactor, no public
  surface (api.json unchanged, helper not Repository-bound).
