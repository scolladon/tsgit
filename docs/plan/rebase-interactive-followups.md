# Plan — interactive-rebase faithfulness + robustness follow-ups

TDD, Red→Green→Refactor per slice. `npm run validate` green before every commit.
All work in `src/application/commands/rebase.ts` + its tests. Two independent
slices; Slice 1 (Item 2) is the smaller and has no dependency on Slice 2, so it
lands first.

## Slice 1 — reject empty reword/squash messages upfront (Item 2)

**Red.** Add to `rebase.test.ts`, under a new
`describe('rebaseRun (interactive) — empty reword/squash message')`:

1. `Given a reword whose message cleans to empty` › `When run` › `Then it refuses
   with INVALID_OPTION before any state change`:
   - `seedLinear()`; `rebaseRun({ upstream: base, interactive: [{ action: 'reword',
     oid: c1, message: '   \n  \n' }] })` via `dataReason`.
   - Assert `code === 'INVALID_OPTION'`, `option === 'interactive'`, `reason`
     contains `reword message must not be empty`.
   - Assert HEAD still points at the original branch tip (`mainTipOid` unchanged)
     and no `rebase-merge/` dir exists — proves the throw is pre-state-change.
2. `Given a squash whose inline message cleans to empty` › same shape with
   `[{ action: 'pick', oid: c1 }, { action: 'squash', oid: c2, message: '\n\n' }]`;
   `reason` contains `squash message must not be empty`.
3. (Guard-isolation / regression) `Given a squash with no message` › `Then it
   folds via the template` — assert `kind === 'rebased'` (kills the
   `inst.message !== undefined` → `true` mutant: a template-only squash must not
   be rejected). Reuse / confirm an existing squash-template test if one already
   asserts this; only add if absent.

Run `npx vitest run test/unit/application/commands/rebase.test.ts` → tests 1 & 2
fail (today the empty message escapes as `EMPTY_COMMIT_MESSAGE` mid-replay, with
a detached HEAD).

**Green.** In `planInteractive`, immediately after the existing
`reword`-without-message guard, add:

```ts
if (
  (inst.action === 'reword' || inst.action === 'squash') &&
  inst.message !== undefined &&
  sanitizeMessage(inst.message, { allowEmpty: true }) === ''
) {
  throw invalidOption('interactive', `${inst.action} message must not be empty`);
}
```

(`sanitizeMessage` + `invalidOption` are already imported.) Re-run → green.

**Refactor.** Annotate the two now-equivalent replay guards, replacing the
"knowingly-killable-but-deferred" status:

- `stepReword`: `sanitizeMessage(inst.message ?? cData.message, { allowEmpty:
  false })` — add `// equivalent-mutant (allowEmpty: false → true): planInteractive
  rejects empty reword messages upfront; a resumed reword falls back to the
  commit's own (non-empty) message — never empty here.`
- `meldGroupMember` group-end: `sanitizeMessage(group.inline ?? stripComments(
  template), { allowEmpty: false })` — add `// equivalent-mutant (allowEmpty:
  false → true): an empty squash inline message is rejected upfront; the template
  fallback retains the base commit's non-empty message — never empty here.`

`npm run validate`. Commit: `fix(rebase): reject empty interactive reword/squash
messages before replay`.

## Slice 2 — faithful rebase onto unrelated history (Item 1)

**Red — unit.** Add to `rebase.test.ts` a `seedUnrelated()` helper (mirror the
`merge.test.ts` orphan-root pattern: `writeObject` + `writeTree` + `createCommit`
with `parents: []`, then `updateRef('refs/heads/feature', …)` and `checkout
feature`):

- main: `base.txt`/base, `m1.txt`/m1 (porcelain on `main`).
- feature (orphan): `f0.txt`/f0 root, then `f1.txt` child → tip; `refs/heads/feature`
  → tip; `checkout({ target: 'feature' })`.

`describe('rebaseRun — unrelated histories')` › `When rebased onto the unrelated
upstream` › `Then it replays the whole branch onto upstream (root gets a parent)`:
- `rebaseRun({ upstream: 'main' })`; assert `kind === 'rebased'`.
- Replayed tip: walk to the replayed root; its `parents` length 1 and equals the
  main tip oid; the tip tree contains `base.txt`, `m1.txt`, `f0.txt`, `f1.txt`.
- HEAD reflog: `rebase (start): checkout main`, two `rebase (pick): …`,
  `rebase (finish): returning to refs/heads/feature`.

Run → fails today with `UNSUPPORTED_OPERATION`.

**Green.** In `rebase.ts`:

1. Delete the refusal block:
   ```ts
   if (base === undefined) {
     throw unsupportedOperation('rebase', 'no common ancestor between HEAD and upstream');
   }
   ```
   Remove the now-unused `unsupportedOperation` import if nothing else uses it
   (grep first).
2. Widen `commitsToReplay(ctx, base: ObjectId | undefined, head)`: guard the
   exclusion walk —
   ```ts
   const excluded = new Set<ObjectId>();
   if (base !== undefined) {
     for await (const c of walkCommits(ctx, { from: [base] })) excluded.add(c.id);
   }
   ```
3. Widen `dropCherryEquivalents(ctx, toReplay, base: ObjectId | undefined,
   upstream)` (only passes `base` through to `commitsToReplay`).
4. Widen `InteractivePlan.base: ObjectId | undefined` and `planInteractive(ctx,
   instructions, base: ObjectId | undefined, head)` (only passes `base` through
   to `commitsToReplay`).
5. `rebaseRun`: `base` now flows untouched into both the non-interactive and
   interactive branches (TypeScript confirms the `ObjectId | undefined` thread).

Re-run unit → green.

**Red — interop.** Add to `rebase-interop.test.ts` a `buildUnrelated(dir)`
(`git checkout --orphan feature`; `git rm -rf --cached .` + delete files; commit
fresh f0, f1) and a test `Given two unrelated histories` › `Then tsgit matches
git: same resulting tree, commit count, single-parent tip`: build on both peers,
`git rebase main` on peer + `repo.rebase.run({ upstream: 'main' })` on ours;
assert `writeTreeOf` parity, `commitCount` parity, `headParents === 1` on both.

**Green.** Already green from the source change — run
`npx vitest run test/integration/rebase-interop.test.ts`.

**Refactor.** Re-read the threaded signatures for naming/immutability; the
`commitsToReplay` `equivalent-mutant (until: [])` note still holds with the guard
(when `base` is `undefined`, `excluded` is empty → `until: []` regardless).
`npm run validate`. Commit: `feat(rebase): replay onto unrelated history against
the empty-tree base`.

## Slice 3 — validation gate

`npm run validate` (Biome + types + unit + coverage). Confirm 100% coverage on
the touched file. Resolve any lint/type/coverage gap before the review phase.

## Notes

- No public-API change → no `reports/api.json` regeneration expected (confirm
  `check:doc-typedoc` stays green; the changed signatures are all module-internal).
- No new error codes (`INVALID_OPTION` and the empty-tree path already exist).
- The refusal test is intentionally **never** added (it would re-cement the
  divergence, per the backlog).
