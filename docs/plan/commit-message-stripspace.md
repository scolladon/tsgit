# Plan — commit message `stripspace` normalization

TDD per slice. `npm run validate` green before every commit. The behavior fix
and the golden regeneration **must** land in one commit (either alone leaves
`validate` red), so Slice 2 is intentionally atomic-but-chunky.

## Dependency graph

```
Slice 1 (domain stripspace)  ──►  Slice 2 (wire + interop proof + golden regen)
```

Slice 1 is self-contained (new pure code, no behavior change). Slice 2 depends
on Slice 1's exported `stripspace`.

## Slice 1 — domain `stripspace` (pure function)

**Files**

- `src/domain/objects/commit-message.ts` (new)
- `src/domain/objects/index.ts` (+ `export { stripspace }`)
- `test/unit/domain/objects/commit-message.test.ts` (new — example tests)
- `test/unit/domain/objects/commit-message.properties.test.ts` (new)
- `test/unit/domain/objects/arbitraries.ts` (+ `arbCommitMessage`)

**Red** — write `commit-message.test.ts`. One isolated `it` per git behavior
(GWT/AAA, `sut` = `stripspace(input)`), mirroring the empirically verified table:

| case | input | expected |
|---|---|---|
| add trailing newline | `'first'` | `'first\n'` |
| strip trailing ws (space) | `'a  '` | `'a\n'` |
| strip trailing ws (tab) | `'a\t'` | `'a\n'` |
| CRLF -> LF | `'a\r\nb'` | `'a\nb\n'` |
| collapse blank run | `'a\n\n\nb'` | `'a\n\nb\n'` |
| drop leading blanks | `'\n\na'` | `'a\n'` |
| drop trailing blanks | `'a\n\n'` | `'a\n'` |
| keep single blank between paras | `'a\n\nb'` | `'a\n\nb\n'` |
| comment preserved (no prefix) | `'#c\nreal'` | `'#c\nreal\n'` |
| all-whitespace -> empty | `'  \n\n  '` | `''` |
| empty string -> empty | `''` | `''` |
| already normalized round-trips | `'a\n\nb\n'` | `'a\n\nb\n'` |
| non-ascii ws kept (U+00A0) | `'\u00A0'` | `'\u00A0\n'` |
| internal leading ws kept | `'  x'` | `'  x\n'` |

Run `npx vitest run test/unit/domain/objects/commit-message.test.ts` — fails
(module missing).

**Green** — create `commit-message.ts`:

```ts
const TRAILING_WS = /[ \t\v\f\r]+$/;

export const stripspace = (message: string): string => {
  const out: string[] = [];
  let blankPending = false;
  for (const line of message.split('\n')) {
    const cleaned = line.replace(TRAILING_WS, '');
    if (cleaned.length === 0) {
      blankPending = true;
      continue;
    }
    if (blankPending && out.length > 0) out.push('');
    blankPending = false;
    out.push(cleaned);
  }
  if (out.length === 0) return '';
  return `${out.join('\n')}\n`;
};
```

Add `export { stripspace } from './commit-message.js';` to `domain/objects/index.ts`.
Re-run the example test — green.

**Property test** — `commit-message.properties.test.ts` + `arbCommitMessage` in
`arbitraries.ts`:

- **Idempotence** (numRuns 200): `stripspace(stripspace(m)) === stripspace(m)`.
- **Output invariants** (numRuns 100): result is `''` or — when non-empty —
  ends with exactly one `\n`, has no line ending in ASCII trailing whitespace,
  no leading/trailing blank line, no two consecutive blank lines.
- **Total function** (numRuns 100): `stripspace(m)` never throws.

`arbCommitMessage` builds messages from arrays of line-fragments (ASCII content,
empty lines, trailing-whitespace noise, occasional CR) joined with `\n` — broad
enough to exercise collapse/drop/strip paths.

**Verify** `npm run validate` — green. **Commit:**
`feat(domain): stripspace commit-message normalization`.

## Slice 2 — wire porcelain + interop proof + golden regen (atomic)

**Files**

- `src/application/commands/internal/commit-message.ts` (`sanitizeMessage` →
  `stripspace`)
- `test/unit/application/commands/internal/commit-message.test.ts` (update
  return-value expectations to `\n`-terminated)
- `test/integration/commit-message-interop.test.ts` (new — faithfulness proof)
- every test pinning a porcelain/merge commit-id literal that shifts (found by
  running the suite — parity scenarios + any unit/integration literals)

**Red**

1. Write `commit-message-interop.test.ts`. For each message shape
   (`'msg with trailing ws   '`, `'subject\n\n\nbody'`, `'no trailing newline'`,
   `'a\n\nb\n'`), stage an identical file on a tsgit repo (`openRepository`) and
   a peer git repo, commit via `repo.commit({ message, author, committer })` and
   `git -c commit.gpgsign=false -c commit.cleanup=whitespace commit -m <message>`
   with pinned `GIT_AUTHOR_*`/`GIT_COMMITTER_*` matching `author`. Assert
   `repo.commit(...).id === git rev-parse HEAD`. Use `interop-helpers.ts`
   (`runGit`, `runGitEnv`, `makePeerPair`, `GIT_AVAILABLE`, `describe.skipIf`).
   Run it — **fails** (porcelain trims, id diverges). This is the bug, proven
   end-to-end.
2. Update the `sanitizeMessage` unit test return expectations (now
   `\n`-terminated). Run — fails.

**Green**

3. Edit `sanitizeMessage`:

```ts
import { stripspace } from '../../../domain/objects/index.js';

export const sanitizeMessage = (raw: string, opts: { readonly allowEmpty: boolean }): string => {
  const cleaned = stripspace(raw);
  if (cleaned === '' && !opts.allowEmpty) throw emptyCommitMessage();
  return cleaned;
};
```

Re-run interop + sanitizeMessage unit — green.

**Golden regen**

4. Run `npm run test:unit`, `npm run test:integration`, `npm run test:parity`.
   For each failure that is a shifted commit-id / merge-id / `MERGE_MSG` literal,
   update the golden to the new faithful value. The parity seed-commit golden
   (`init-add-commit-status`, `87863a6f…`) is recomputed against **real git**
   (signing off) to confirm the new value equals canonical git, not just the new
   tsgit output. Spot-check one or two others the same way.
5. `npm run validate` — green.

**Commit (atomic):** `feat(commit): faithful stripspace message normalization`.

## Out of scope for this PR

- The general write-porcelain interop harness (`mv`, tree-level + working-tree
  faithfulness, reusable comparison helpers) — the next PR, built on this fix.
- A `--cleanup=<mode>` option — deferred (YAGNI), per ADR-203.

## Review / mutation / docs (workflow phases 6–8)

- Review ×3 (typescript / security / tests) over `git diff main...HEAD`.
- Mutation: `npm run test:mutation` over the touched modules; kill survivors in
  `stripspace` (collapse/drop/strip guards) and `sanitizeMessage`.
- Docs: note message normalization in the relevant `docs/use/` commit page +
  `docs/understand/` faithfulness page if present; flip the `21.2b` BACKLOG
  entry to `[x]`.
