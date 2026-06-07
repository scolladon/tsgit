# Plan — `shortlog`

TDD per slice (Red → Green → Refactor), `npm run validate` green before each
atomic commit. Conventions: GWT describe/it, AAA body, `sut`, 100% coverage, 0
killable mutants. No phase/ADR refs in source or test code.

Decisions locked (ADR-277 / ADR-278): full git subject cleaning + `foldSubject`
faithfulness fix; group by name with per-entry email; `by: 'author' |
'committer'` enum; `excluding` range support.

Dependency order: 1 → 2 (needs 1); 3 independent; 4 (needs 2,3); 5 (needs 4);
6,7 (need 4/5); 8 (needs all).

---

## Slice 1 — `foldSubject` faithful leading-blank skip

`src/domain/objects/commit-message.ts`

**Red.** In `test/unit/domain/objects/commit-message.test.ts`, change the existing
`'Given a message starting with a blank line'` case to expect the git-faithful
result, and add cases:
- `'\nbody after a blank subject'` → `'body after a blank subject'`
- `'\n\ndouble leading blank'` → `'double leading blank'`
- `'   \nwhitespace-only first line'` → `'whitespace-only first line'`
- `'  hello\nworld'` → `'  hello world'` (content-line leading ws preserved)
Run `npx vitest run test/unit/domain/objects/commit-message.test.ts` — fails (old
impl returns `''` for leading-blank inputs).

**Green.** In `foldSubject`, replace `if (line === '') break;` with:
```
if (line === '') {
  if (lines.length > 0) break;   // blank after content ends the subject
  continue;                       // leading blank line is skipped
}
```
Update the doc comment to state leading blank lines are skipped (git `%s`).

**Refactor.** None expected. Confirm `commit-message.properties.test.ts`
(idempotence / no-newline / subject-before-body) stays green.

**Mutation note.** Two isolated guard tests: leading blank → skipped (continue
branch), blank after content → stops (break branch). `lines.length > 0` boundary.

Commit: `fix(commit-message): foldSubject skips leading blank lines (git %s)`

---

## Slice 2 — `cleanShortlogSubject`

`src/domain/shortlog/clean-subject.ts` (new)

**Red.** `test/unit/domain/shortlog/clean-subject.test.ts` — one `it` per
verified case (ADR-277): `[PATCH] x`→`x`, `[PATCH v2] x`→`x`,
`[PATCHwork] y] z`→`y] z`, `[PATCHv2]x] w`→`x] w`, `[BUGFIX] x`→`[BUGFIX] x`,
`[patch] x`→`[patch] x`, `[PATCH no-close`→`[PATCH no-close`,
`[PATCH]\n\nbody`→`''`, `[PATCH]\nbody`→`body`, `[PATCH]   \n  next`→`next`,
`[PATCH]`→`''`, plain `subject`→`subject`, multi-line fold `Add\nfeature`→
`Add feature`, leading-blank `\n\n  x`→`x`.

**Green.**
```ts
import { foldSubject } from '../objects/commit-message.js';

const LEADING_ASCII_WHITESPACE = /^[ \t\n\v\f\r]+/;
const PATCH_PREFIX = '[PATCH';

export const cleanShortlogSubject = (message: string): string => {
  const folded = foldSubject(message).replace(LEADING_ASCII_WHITESPACE, '');
  const body = folded.startsWith(PATCH_PREFIX) ? dropToFirstBracket(folded) : folded;
  return body.replace(LEADING_ASCII_WHITESPACE, '');
};

const dropToFirstBracket = (s: string): string => {
  const close = s.indexOf(']');
  return close === -1 ? s : s.slice(close + 1);
};
```

**Refactor.** Keep tidy; small functions.

**Property test** `clean-subject.properties.test.ts` (lens 1/3 — total function
over ASCII messages): never throws; output contains no `\n`; idempotent
(`cleanShortlogSubject(cleanShortlogSubject(x)) === cleanShortlogSubject(x)`);
output never starts with the literal `[PATCH`. `numRuns` 200.

**Mutation note.** Isolated tests for the `startsWith` branch (with/without
`[PATCH`) and the `close === -1` branch (`[PATCH`-no-`]`).

Commit: `feat(shortlog): cleanShortlogSubject (git shortlog oneline)`

---

## Slice 3 — `groupShortlog` + domain barrel

`src/domain/shortlog/group.ts`, `src/domain/shortlog/index.ts` (new)

**Red.** `test/unit/domain/shortlog/group.test.ts`:
- empty input → `[]`.
- single author, 3 commits in walk order (newest-first) → one group, commits
  **oldest-first** (reversed).
- two authors `Bob`, `Alice` interleaved → groups byte-sorted `Alice` then `Bob`.
- same name, two emails → **one** group; each commit keeps its own `email`.
- case sensitivity: `Alice` vs `alice` → two groups, `Alice` before `alice`.
- byte-sort discriminator (kills a JS-default-sort mutant): names
  `'＀z'` and `'\u{10000}z'` → byte order puts `'＀z'` first (UTF-8
  `EF…` < `F0…`), the opposite of JS UTF-16 default sort.

**Green.**
```ts
import { compareBytes } from '../objects/index.js';
import type { ObjectId } from '../objects/index.js';

const nameEncoder = new TextEncoder();

export interface ShortlogEntry {
  readonly name: string;
  readonly email: string;
  readonly id: ObjectId;
  readonly subject: string;
}
export interface ShortlogCommit {
  readonly id: ObjectId;
  readonly email: string;
  readonly subject: string;
}
export interface ShortlogGroup {
  readonly name: string;
  readonly commits: ReadonlyArray<ShortlogCommit>;
}

export const groupShortlog = (
  entries: ReadonlyArray<ShortlogEntry>,
): ReadonlyArray<ShortlogGroup> => {
  const buckets = new Map<string, ShortlogCommit[]>();
  for (const { name, email, id, subject } of entries) {
    const commit: ShortlogCommit = { id, email, subject };
    const bucket = buckets.get(name);
    if (bucket === undefined) buckets.set(name, [commit]);
    else bucket.push(commit);
  }
  return [...buckets.entries()]
    .map(([name, commits]) => ({ name, commits: [...commits].reverse() }))
    .sort((a, b) => compareBytes(nameEncoder.encode(a.name), nameEncoder.encode(b.name)));
};
```
`index.ts` barrel re-exports `cleanShortlogSubject` and the group symbols/types.

**Property test** `group.properties.test.ts` (lens 2 — compositional aggregator):
empty → empty; total commit count preserved; group count = distinct names; every
group non-empty; groups byte-sorted by name; per-group order is the reverse of
input encounter order for that name. `numRuns` 100.

**Mutation note.** `[...commits].reverse()` proven by the oldest-first test;
`compareBytes` proven by the byte-sort discriminator; first-appearance bucket
branch (`undefined` vs push) covered by the two-emails and interleaved tests.

Commit: `feat(shortlog): groupShortlog domain aggregator`

---

## Slice 4 — `shortlog` command + barrel export

`src/application/commands/shortlog.ts` (new); export in `commands/index.ts`.

**Red.** `test/unit/application/commands/shortlog.test.ts` (memory adapter, build
commits with distinct authors/dates like `log.test.ts`):
- default `repo.shortlog()` over a linear history → groups by author name,
  oldest-first, byte-sorted; subjects are cleaned (`[PATCH]` stripped).
- `by: 'committer'` → groups by committer identity.
- `excluding: [rev]` → range narrows the walk.
- `rev` selector (e.g. a tag / `HEAD~1`).
- merge commit is included.
- unborn HEAD / unresolvable `rev` → refuses (assert error `.data.code`).

**Green.**
```ts
import { cleanShortlogSubject } from '../../domain/shortlog/clean-subject.js';
import {
  groupShortlog,
  type ShortlogEntry,
  type ShortlogGroup,
} from '../../domain/shortlog/group.js';
import type { Context } from '../../ports/context.js';
import { walkCommitsByDate } from '../primitives/walk-commits-by-date.js';
import { assertRepository } from './internal/repo-state.js';
import { resolveCommit } from './internal/resolve-rev.js';

export type { ShortlogCommit, ShortlogGroup } from '../../domain/shortlog/index.js';

export type ShortlogBy = 'author' | 'committer';

export interface ShortlogOptions {
  readonly rev?: string;
  readonly excluding?: ReadonlyArray<string>;
  readonly by?: ShortlogBy;
}

export const shortlog = async (
  ctx: Context,
  opts: ShortlogOptions = {},
): Promise<ReadonlyArray<ShortlogGroup>> => {
  await assertRepository(ctx);
  const startId = await resolveCommit(ctx, opts.rev ?? 'HEAD');
  const exclude = await Promise.all((opts.excluding ?? []).map((r) => resolveCommit(ctx, r)));
  const byCommitter = opts.by === 'committer';
  const entries: ShortlogEntry[] = [];
  for await (const commit of walkCommitsByDate(ctx, { from: [startId], until: exclude })) {
    const who = byCommitter ? commit.data.committer : commit.data.author;
    entries.push({
      name: who.name,
      email: who.email,
      id: commit.id,
      subject: cleanShortlogSubject(commit.data.message),
    });
  }
  return groupShortlog(entries);
};
```
Barrel: `export { type ShortlogBy, type ShortlogCommit, type ShortlogGroup, type ShortlogOptions, shortlog } from './shortlog.js';` (alphabetical block placement).

**Mutation note.** Author vs committer (`by === 'committer'`) isolated; `?? 'HEAD'`
default proven by no-arg test; `excluding` empty vs non-empty.

Commit: `feat(shortlog): tier-1 shortlog command`

---

## Slice 5 — repository binding

`src/repository.ts`, `test/unit/repository/repository.test.ts`

**Red.** Add `'shortlog'` to the top-level key-set assertion (alphabetical, after
`rm`). Run repository.test → fails (binding missing).

**Green.**
- Interface: `readonly shortlog: BindCtx<typeof commands.shortlog>;` (after `rm`,
  before `show`).
- Facade object:
  ```ts
  shortlog: ((shortlogOpts) => {
    guard();
    return commands.shortlog(ctx, shortlogOpts);
  }) as Repository['shortlog'],
  ```

**Refactor.** None.

Commit: `feat(shortlog): bind shortlog on the repository facade`

---

## Slice 6 — cross-tool interop

`test/integration/shortlog-interop.test.ts` (model: `describe-interop.test.ts`)

Build repos with real git (deterministic dates, signing off via `runGitEnv`),
run tsgit `shortlog`, **reconstruct** git's output from the structured groups,
assert byte-equality vs real `git shortlog`. Exact line format (`<name>
(<n>):\n      <subject>` per group, blank line between groups, trailing newline)
is pinned by diffing against `runGit('shortlog', …)` during Green.

Cases:
- **default** multi-author repo → reconstruct `git shortlog`.
- **`-e`** → re-partition each group by email, byte-sort `name <email>`
  sub-groups → reconstruct `git shortlog -e`.
- **`-c`** → `by: 'committer'` → reconstruct `git shortlog -c` (distinct
  author/committer identities).
- **`[PATCH]`** subjects (verbatim message via `--cleanup=verbatim` or `commit
  -m`) → subject parity.
- **merge** present → included, oldest-first.
- guard with `GIT_AVAILABLE` skip, `SETUP_TIMEOUT` 60s, repos built in
  `beforeAll`.

Commit: `test(shortlog): cross-tool interop vs git shortlog`

---

## Slice 7 — cross-adapter parity scenario

`test/parity/scenarios/shortlog.scenario.ts` + register in `scenarios/index.ts`

Model: `describe.scenario.ts`. Seed 2 commits by distinct authors, run
`repo.shortlog()`, assert a flattened, adapter-agnostic shape (group names,
counts, first subject). Runs on node/memory/browser.

Commit: `test(shortlog): cross-adapter parity scenario`

---

## Slice 8 — docs, api.json, backlog

- `docs/use/commands/shortlog.md` — page shape (Signature / Options / Behaviour /
  Examples / Throws / See also). Behaviour documents the `-e`/`-n`/`-s` caller
  projections and byte-wise name sort / oldest-first / merges-included.
- `docs/use/commands/README.md` — add the `shortlog` row; bump `33 entries` → `34`.
- `README.md` — bump `33 Tier-1 commands` → `34`.
- `reports/api.json` — regenerate (`npm run` doc-typedoc target) and commit
  (prepush gate); large typedoc-id diff is expected.
- `docs/BACKLOG.md` — flip `23.5` `[ ]` → `[x]` with a one-line outcome summary.

Commit: `docs(shortlog): command page, index, api.json, backlog`

---

## Review & finalize (workflow Steps 6–9)

- Reviews ×3 (typescript / security / tests), fix-all-converge.
- Architecture refactor pass (seeded by the diff): consider consolidating the
  `[...x].reverse()` / encoder patterns or any `foldSubject` reuse opportunity;
  may no-op with written justification. Re-review the refactor diff.
- Mutation: `./node_modules/.bin/stryker run --mutate` on touched files; 0
  killable survivors.
- Final `npm run validate`.
