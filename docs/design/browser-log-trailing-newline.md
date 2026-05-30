# Design — browser `log` message trailing-`\n` parity

## Goal

Un-red the persistently-failing `e2e (chromium)` / `e2e (firefox)` CI jobs.
`test/browser/surface-parity.spec.ts › log` asserts that `repo.log()` returns
commit messages `['second commit', 'seed commit']`, but the actual readback is
`['second commit\n', 'seed commit\n']`. The fix aligns the browser test
expectation with the real, faithful behavior. No production code changes.

## Root cause (verified, not hypothesized)

The BACKLOG entry framed this as a browser-specific, timing-dependent quirk
("the trailing `\n` survives where Node strips it"). That framing is wrong on
every count. The evidence:

- `repo.log()` is a pure pass-through to `commands.log` (`repository.ts:424`),
  which yields `value.data.message` straight from `walkCommits`.
- The commit-message body is produced by the platform-independent domain parser
  `splitHeaderAndMessage` (`encoding.ts`): `message = text.slice(blankIndex + 2)`
  — the raw bytes after the `\n\n` header separator, **verbatim**, including any
  trailing `\n`. There is no platform branch and no timing dependence; the parse
  is deterministic on Node, OPFS/chromium, OPFS/firefox alike.
- Both the seed commit (`seedRepo`, `fixtures.ts`) and the `'second commit'`
  commit are created through the full `repo.commit` porcelain. Since PR #93
  (`03616689`, commit-message `stripspace` normalization), that porcelain
  guarantees the stored message ends with exactly one `\n`. So the stored object
  body is `second commit\n`, and `repo.log()` faithfully reads it back as
  `'second commit\n'` — on **every** platform.

### The actual regression point

PR #93 is the regression point — not "03616689 and earlier". `git log -L 85,85`
on `test/unit/application/commands/log.test.ts` shows that PR #93 itself flipped
the **Node** unit assertion from `['third', 'second', 'first']` to
`['third\n', 'second\n', 'first\n']` to track the new trailing `\n`. The matching
browser expectation in `surface-parity.spec.ts` (introduced in PR #51, last
touched in PR #89 — both pre-`stripspace`) was **never updated**. So the browser
job went red precisely **at** PR #93 and has stayed red since. webkit is green
only because Playwright's headless WebKit does not expose
`navigator.storage.getDirectory`, so every OPFS scenario `test.skip`s there.

## Decision — fix the test expectation, keep production behavior

`repo.log().message` returns the **raw commit-object body verbatim**, including
the structural trailing `\n` that `stripspace` guarantees. This is the correct,
load-bearing behavior and we keep it:

- **Git-faithful.** The on-disk commit object body genuinely is `second commit\n`
  (`git cat-file commit`). Returning the raw body is the faithful readback;
  stripping would be a porcelain convenience (`git log --format=%s`) layered on
  top, not the message body itself.
- **Ecosystem-consistent.** isomorphic-git — the closest analog to tsgit —
  returns `commit.message` including the trailing `\n`.
- **Already the project's established contract.** The Node `log` unit test
  asserts `'third\n'` and has since PR #93; the `commit`/`createCommit` seam
  (ADR 203) deliberately stores the normalized body and reads it back verbatim.

The alternative — stripping the trailing `\n` inside `repo.log()` and reverting
the Node assertion — was rejected: more invasive, diverges from the raw object
body and from isomorphic-git, and reopens the `stripspace` faithfulness story for
no benefit. Captured as ADR 206.

## Scope

In scope:

- Update the `log` scenario expectation in `test/browser/surface-parity.spec.ts`
  from `['second commit', 'seed commit']` to `['second commit\n', 'seed commit\n']`.
- A one-line comment at the assertion explaining *why* the trailing `\n` is
  expected (raw body, `stripspace`-normalized), so a future reader does not
  "correct" it back.

Out of scope:

- Any change to `repo.log`, `commands.log`, `commit.ts`, `encoding.ts`, or the
  `stripspace`/`sanitizeMessage` seam.
- A `--format=%s`-style subject accessor. YAGNI — no backlog item needs it.
- The other surface-parity scenarios (branch/checkout/tag) — already green.

## Files

| File | Change |
|---|---|
| `test/browser/surface-parity.spec.ts` | `log` expectation → `['second commit\n', 'seed commit\n']` + why-comment |
| `docs/adr/206-*.md` | Record the keep-raw-body decision |
| `docs/BACKLOG.md` | Correct the 21.2d root-cause text; flip `[ ]` → `[x]` |

## Testing strategy

This is an E2E-only correction; there is no unit/property surface to add.

- **Red → Green, local, real browsers.** Before the edit, run the chromium and
  firefox `log` scenario via `npx playwright test` (build + parity bundle are
  prerequisites, already built) and observe the failure asserting
  `'second commit\n' !== 'second commit'`. After the edit, the same run is green.
  webkit stays skipped (OPFS gap) — expected, not a regression.
- **No new unit/property tests.** The Node-side behavior is already pinned by
  `test/unit/application/commands/log.test.ts:85` (`'third\n'`). Adding a unit
  test here would duplicate that pin. The four property-test lenses
  (round-trip / matcher / total-function / counting) do not fit a single
  test-expectation correction with no algebraic structure under change.
- **Mutation.** The change touches no production source and no unit test;
  `stryker run` operates on the unit suite via the vitest-runner, so this change
  introduces zero new mutants. Mutation scope is unchanged.

## Key design decisions

1. **Fix the test, not production** — the readback is already faithful; the test
   was left stale by PR #93. (ADR 206.)
2. **Keep the trailing `\n` in `repo.log().message`** — raw object body,
   matching git and isomorphic-git.
3. **Correct the BACKLOG root-cause text in this PR** — the entry's
   "timing-dependent / Node strips" narrative is false and would mislead.
