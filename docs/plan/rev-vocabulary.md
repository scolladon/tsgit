# Plan — `rev` vocabulary

Behaviour-preserving rename pass (ADR-266). Each slice renames one command's
commit-ish parameter, updates **all** consumers (`repository.ts`, internal
callers, tests, that command's doc page), runs `npm run validate`, and lands as
one atomic commit. The **type-checker is the completeness oracle**: a renamed
field that misses a consumer fails `check:types`.

`reports/api.json` is regenerated **once** at the end (slice 7) — it is not part
of `validate`, only of the pre-push gate.

Commit-type convention: an **option-field** rename is breaking (`refactor(x)!:`);
a **positional-parameter** rename is *not* breaking for callers (positional args
are name-agnostic in TS), so `refactor(x):` without `!`.

---

## Slice 1 — `log`: `LogOptions.from` → `rev`

- **Edit** `src/application/commands/log.ts`: `from?` → `rev?` in `LogOptions`;
  `opts.from ?? 'HEAD'` → `opts.rev ?? 'HEAD'`; update the JSDoc ("starting from
  `rev`"). Internal `resolveStart(ctx, from)` helper param may stay (local) —
  rename to `rev` for clarity.
- **Consumers**: `repository.ts` `log` is `BindCtx<typeof commands.log>` (auto)
  with a passthrough body — no change.
- **Tests**: `test/unit/application/commands/log.test.ts` — `{ from: … }` →
  `{ rev: … }` (5 sites). (`reflog-writers.test.ts`'s `branchRename({ from, to })`
  is a different command — leave.)
- **Docs**: `docs/use/commands/log.md` — `repo.log({ from: … })` → `{ rev: … }`.
- **Verify** `npx vitest run test/unit/application/commands/log.test.ts` green;
  `npm run validate`.
- **Commit**: `refactor(log)!: rev replaces from option`

## Slice 2 — `reset`: `ResetOptions.target` → `rev`

- **Edit** `src/application/commands/reset.ts`: `target` → `rev` in
  `ResetOptions`; `opts.target` → `opts.rev` (the `resolveTarget` call **and**
  the reflog message `reset: moving to ${opts.rev}` — value byte-identical, only
  the field carrying it renames); JSDoc ("reset … to `rev`"). Internal
  `resolveTarget(ctx, target)` helper param may stay local or rename.
- **Tests**: `reset.test.ts` (≈40 sites), `test/integration/reset-interop.test.ts`,
  `test/integration/sparse-reset-merge.test.ts`,
  `test/parity/scenarios/reset-rm-reflog.scenario.ts` — `target:` → `rev:`.
- **Verify** reset unit + `reset-interop` green; `npm run validate` (interop
  reflog parity must stay byte-equal — the behaviour anchor).
- **Commit**: `refactor(reset)!: rev replaces target option`

## Slice 3 — `merge`: `MergeRunInput.target` → `rev` (+ `pull`'s internal call)

- **Edit** `src/application/commands/merge.ts`: `target` → `rev` in
  `MergeRunInput` (the **type name stays** `MergeRunInput`); every `input.target`
  in `mergeRun`; JSDoc/code comments referencing the `target` field.
- **Edit** `src/application/commands/pull.ts`: the internal
  `mergeRun(ctx, { target: tip, … })` → `{ rev: tip, … }`. (pull's *own* public
  `branch` is slice 6.)
- **Check** `continue-merge.ts` / `abort-merge.ts` for any `MergeRunInput`
  construction (compiler-driven).
- **Tests**: `merge.test.ts`, `continue-merge.test.ts` (`mergeRun({ target })`),
  `repository.test.ts:471` (`merge.run({ target })`),
  `merge-state-machine.test.ts`, `merge-abort-interop.test.ts`, parity
  `merge-abort` / `merge-ff` / `merge-continue` scenarios — `target:` → `rev:`.
- **Docs**: `docs/use/commands/merge.md`,
  `docs/get-started/migrate-from-isomorphic-git.md` — `merge.run({ target })` →
  `{ rev }`.
- **Verify** merge unit + integration + parity green; `npm run validate`.
- **Commit**: `refactor(merge)!: rev replaces target input field`

## Slice 4 — `describe`: positional `input` → `rev`

- **Edit** `src/application/commands/describe.ts`: signature
  `describe(ctx, input?, opts?)` → `describe(ctx, rev?, opts?)`; `input !==
  undefined` → `rev !== undefined`; `input ?? DEFAULT_REV` → `rev ?? DEFAULT_REV`.
- **Consumers**: `repository.ts` describe body arg `((input, describeOpts) => …)`
  → `((rev, describeOpts) => …)` for clarity (local name; type via `BindCtx`).
- **Tests**: all `describe` callers are positional — **no call-site changes**.
- **Verify** `describe.test.ts` green; `npm run validate`.
- **Commit**: `refactor(describe): rev names the positional commit-ish`

## Slice 5 — `show`: positional `input` (`ShowInput`) → `rev`

- **Edit** `src/application/commands/show.ts`: rename the positional `input` →
  `rev` across all four overloads **and** the implementation signature
  (`input: ShowInput = DEFAULT_REV` → `rev: ShowInput = DEFAULT_REV`). The
  implementation body branches `typeof rev === 'string'`; the existing
  `for (const rev of input)` loop is renamed to iterate the parameter without
  shadowing (`for (const r of rev) … buildForRev(ctx, r, …)`). **`ShowInput` type
  name stays** (it describes *what* show accepts, not the parameter's name).
- **Consumers**: `repository.ts` hand-written `show` binding overloads spell the
  positional `input:` → `rev:` (4 overload lines).
- **Tests**: all `show` callers are positional — **no call-site changes**.
- **Verify** `show.test.ts` + `show` interop/parity green; `npm run validate`.
- **Commit**: `refactor(show): rev names the positional commit-ish`

## Slice 6 — `pull`: `PullOptions.branch` → `ref` (ADR-266)

- **Edit** `src/application/commands/pull.ts`: `branch?` → `ref?` in
  `PullOptions`; `opts.branch ?? shortMergeRef(tracking?.merge)` → `opts.ref ??
  …`; JSDoc ("Short branch name to merge" stays accurate as the doc text). The
  internal `Upstream.branch` field, the `resolveUpstream` local `branch`, and the
  `noUpstreamConfigured(branch)` error **keep** their `branch` spelling — they
  hold a resolved branch name, off the public options surface.
- **Consumers**: `repository.ts` pull is `BindCtx` + passthrough — no change.
- **Tests**: `test/unit/application/commands/pull.test.ts` — `{ branch: … }` →
  `{ ref: … }` (3 sites).
- **Docs**: `docs/use/commands/pull.md`,
  `docs/get-started/migrate-from-isomorphic-git.md` — `pull({ …, branch })` →
  `{ …, ref }`.
- **Check** browser `surface-parity.spec.ts` for any declared `pull`/option
  shape with `branch` (update if present).
- **Verify** `pull.test.ts` green; `npm run validate`.
- **Commit**: `refactor(pull)!: ref replaces branch option`

## Slice 7 — regenerate `api.json`

- **Run** `npm run docs:json` (regenerates `reports/api.json` with the renamed
  parameters).
- **Verify** `git diff reports/api.json` shows only the rename churn (renamed
  parameter/field names; expected large typedoc-id diff is fine per project
  convention).
- **Verify** `npm run prepush` green (= `validate` + `check:doc-typedoc`).
- **Commit**: `docs(api): regenerate api.json for rev/ref vocabulary`

---

## Slice 8 — `checkout`: `CheckoutSwitchOptions.target` → `rev` (folded in)

Added by user directive (handle the remaining commit-ish param here, not as a
follow-up). The **switch** option only; the path-restore variant is untouched.

- **Edit** `src/application/commands/checkout.ts`: `target` → `rev` in
  `CheckoutSwitchOptions`; the `isSwitch` discriminator (`'rev' in opts &&
  opts.rev !== undefined`); the `opts.rev` accesses; the `resolveSwitchOid` param;
  the validation refusals (`invalidOption('rev', 'either rev or paths must be
  provided')` + `'cannot be combined with rev'`). `head.target` and the local
  `target` tree var stay (different concepts).
- **Tests**: `checkout.test.ts` (call sites + error-assertion strings + comments),
  `surface-parity.spec.ts` (decl + calls), and the `checkout({ target })` call
  sites in the ~20 command/integration/scenario tests that set up fixtures
  (`tag`'s `target:` preserved).
- **Docs**: `checkout.md`, `recipes.md`, `clone.md`, `browser.md`, migrate guide.
- **Commit**: `refactor(checkout)!: rev replaces target switch option`

## Out of scope (do **not** touch)

- `tag`'s `target` (object reference — broader than a commit-ish), `diff`'s
  `from`/`to` (genuine range — the reserved vocabulary), `branch.rename`'s
  `from`/`to` (a name pair), `revert`/`cherryPick`/`rebase` `revisions` arrays and
  their `*RunInput` bag naming. (See design § scope boundaries.)

## Review / refactor / mutation (Steps 6–8)

- **Reviews ×3** over `git diff main...HEAD`: types (rename completeness,
  no stray `target`/`from`/`branch` left on the eight surfaces), security (n/a —
  no new input handling; confirm), tests (every renamed field's call sites moved,
  GWT/AAA intact, no behaviour test deleted).
- **Architecture pass**: expected **no-op** — a rename does not introduce
  duplication or misplaced responsibility. Emit the written justification; if a
  shared `rev`-resolution helper looks warranted, weigh against the existing
  `resolveCommitIsh` / per-command resolvers (likely YAGNI). Re-review scoped to
  any refactor diff.
- **Mutation** (Step 8): re-run; logic untouched ⇒ scores hold. A new survivor
  signals a mechanical slip, not a gap.

## Step 9 — backlog + docs

- Flip `docs/BACKLOG.md` `23.4e` `[ ]` → `[x]` with a faithful summary line.
- Confirm README / RUNBOOK / CONTRIBUTING need no change (no command added).
