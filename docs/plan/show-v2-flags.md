# Plan — `show` v2 flags

Implementation script for `design/show-v2-flags.md` (ADRs 244–248). Slices land
top-to-bottom; each is one atomic commit after a green `npm run validate`. TDD
per slice: Red (failing test, stated reason) → Green (minimal code) → Refactor.
Interop additions extend `test/integration/show-interop.test.ts`; unit tests
live under `test/unit/domain/show/**` and `test/unit/application/commands/`.

Slice order is dependency-driven: option plumbing → independent leaf flags →
date (feeds pretty) → decoration (feeds pretty) → pretty → stat → `-m` →
combined. Each slice keeps `objects`/`bytes` faithful and the default path
byte-unchanged.

---

## Slice 0 — Option model plumbing (ADR-244)

Lay the typed `ShowOptions` fields + a pure resolver, before any behaviour.

- **Red** `show-options.test.ts`: `parseShowOptions({})` → a default resolved
  plan (`format: medium`, `date: default`, `mergeDiff: dense`, no stat/numstat,
  `noPatch: false`); invalid `format: 'nope'` → `invalidOption('format', …)`
  (`{ code: 'INVALID_OPTION', option: 'format', reason }`); invalid
  `date: 'nope'` → `invalidOption('date', …)`. Reuses the existing
  `INVALID_OPTION` factory; assert `.option` + `.reason`.
- **Green** add `internal/show-options.ts` exporting `ResolvedShowPlan` +
  `parseShowOptions`; extend `ShowOptions` with the six fields; wire `show.ts` to
  call it (behaviour still medium-only — every resolved branch but `medium`
  throws `UNSUPPORTED` placeholder until its slice lands, OR is gated so default
  stays identical). Default-path interop unchanged.
- **Refactor** isolate validation helpers; no magic strings.
- Commit `feat(show): resolve typed v2 options`.

> Each later slice flips one `UNSUPPORTED` branch to real behaviour, so the tree
> is always green and the default never regresses.

## Slice 1 — `-s` / `--no-patch` (ADR-244)

- **Red** unit: `show(ctx, head, { noPatch: true })` commit `text` ends after the
  message (`block`, no trailing `\n` for non-merge); `patch` absent. Merge +
  `noPatch` → header+message, no combined, no trailing blank.
- **Green** in `buildCommit`, when `plan.noPatch` skip all diff; `renderCommitBlock`
  already emits `block` when no patch — ensure merge path honours `noPatch`
  (suppress the trailing-blank terminator too).
- **Interop** `-s` on `modify` and on `merge`.
- Commit `feat(show): -s/--no-patch suppresses diff`.

## Slice 2 — `<rev>:<path>` (ADR-245)

- **Red** grammar `rev-parse-grammar.test.ts`: `parseExpression('HEAD:a.txt')` →
  `{ kind: 'tree-path', rev: 'HEAD', path: 'a.txt' }`; `'HEAD:'` → path `''`;
  leading `:0:x` stays `index-stage`. `rev-parse.test.ts`: resolves blob oid;
  missing path → `PATH_NOT_IN_TREE`.
- **Green** add `tree-path` to the grammar (`splitTreePath`: first `:` not at
  index 0, not the `:<stage>:` form); `evaluate` walks tree components
  (`readObject`, peel commit→tree, descend). New error `pathNotInTree` in
  `domain/objects/error.ts` (or commands/error).
- **Interop** `show <root>:a.txt` (blob bytes) and `show <root>:` + `<root>:sub`
  (tree listing).
- Commit `feat(rev-parse): resolve <rev>:<path> tree lookup`.

## Slice 3 — date modes (ADR-247)

- **Red** `date-mode.test.ts` per mode (iso/iso-strict/rfc/short/raw/unix/local/
  default/format) with the `1700000100 +0200` corner + single-digit-day + neg-tz
  + pre-epoch; `relative.test.ts` / `human.test.ts` with injected `now` across
  threshold boundaries. Properties for iso/rfc/strftime round-trip.
- **Green** `domain/show/date/`: `parseDateMode`, `formatDate(mode, ts, tz, now)`,
  `iso.ts`/`rfc.ts`/`local.ts`/`relative.ts`/`human.ts`/`strftime.ts`; keep
  `git-date.ts` as `default`. Thread `plan.date` into the `Date:` line
  (`identity-header.ts` gains a date-mode param) and store `now` (read once in
  `show.ts`, like `revParse`).
- **Interop** absolute modes on `modify` with `-s`. (`relative`/`human` excluded.)
- Commit `feat(show): --date= modes`.

## Slice 4 — decoration (ADR-246)

- **Red** `decoration.test.ts`: ordered labels → `%d` (` (…)`) / `%D` (bare);
  empty → empty; `HEAD -> main` symbolic; `tag:` prefix; ordering HEAD/branch/
  tag/remote. `show-decoration.test.ts` (command-internal): builds `oid→labels`
  from a seeded repo.
- **Green** `domain/show/decorate/decoration.ts` (pure label→string) +
  `internal/show-decoration.ts` (`enumerateRefs` → resolve → group/order).
- **Interop** deferred to Slice 5 (surfaces via `%d`/`%D`/`reference`).
- Commit `feat(show): decoration label rendering`.

## Slice 5 — pretty-format engine (ADR-246)

Sub-steps, each its own commit; all green before moving on.

- **5a custom engine** — `placeholders.test.ts`: every supported `%`-code
  isolated; `%xXX`/`%n`/`%%`; unknown `%z` passthrough; property for literal/
  unknown grammar. `pretty-spec.test.ts`: `format:`/`tformat:`/named dispatch.
  Green: `pretty/pretty-spec.ts` + `pretty/placeholders.ts`. Wire `format:`/
  `tformat:` into `buildCommit`. Interop: representative templates incl. `%d`.
  Commit `feat(show): custom format placeholder engine`.
- **5b named formats** — `named.test.ts` per format (oneline/short/full/fuller/
  raw/reference; medium unchanged). Green: `pretty/named.ts` + `framing.ts`
  (per-format patch separator). Interop: each named format on `modify`.
  Commit `feat(show): named pretty formats`.
- **5c email/mboxrd** — `email.test.ts`: envelope + `Subject: [PATCH]` + body +
  `mboxrd` `>From` quoting. Green: `pretty/email.ts`. Interop: `email` on
  `modify`. Commit `feat(show): email/mboxrd formats`.
- **5d abbrev/oneline flag** — `--oneline` (abbrev) vs `--format=oneline` (full)
  via the `format` string; pin both. Folded into 5b if trivial.

## Slice 6 — `--stat` / `--numstat` (ADR-244)

- **Red** `scale.test.ts` (scale_linear: fits / scales / single-line);
  `diff-stat.test.ts` (name pad, count align, graph, summary pluralisation 0/1/N);
  `numstat.test.ts` (counts, binary `-\t-`).
- **Green** `domain/show/stat/`: `numstat.ts`, `scale.ts`, `diff-stat.ts`.
  `buildCommit` computes the change set once, renders stat/numstat in the patch
  slot (same framing); merge stat behaviour pinned by interop.
- **Interop** `--stat` + `--numstat` on the multi-file `modify` (incl. a
  wide-enough file to exercise scaling).
- Commit `feat(show): --stat/--numstat summaries`.

## Slice 7 — `-m` separate merge diff (ADR-248)

- **Red** unit: merge + `mergeDiff: 'separate'` → `perParent.length === parents`;
  `text` has one `commit <oid> (from <p>)` block per parent with a pairwise
  `diff --git`, blocks blank-line-joined.
- **Green** `internal/show-merge-diff.ts` builds per-parent patches (existing
  trio per parent); `buildCommit` assembles the multi-block `text`.
- **Interop** `-m` on the non-trivial merge.
- Commit `feat(show): -m per-parent merge diff`.

## Slice 8 — combined diff `-c`/`--cc`/default (ADR-248)

The core. Domain-first, then wire.

- **8a combine engine** — `combine.test.ts`: build `sline` flags + lost from
  per-parent line diffs; `interesting`; `make_hunks` (context grow + merge);
  dense single-parent drop; two-parent keep; octopus. Isolated guard tests for
  each flag/lost/dense branch. Green: `domain/show/combined/combine.ts`.
- **8b render** — `render-combined.test.ts`: `diff --cc`/`--combined` header,
  `index <p0>,<p1>..<R>`, `@@@ -… -… +… @@@`, per-parent prefix columns,
  add/delete (`/dev/null`), mode lines. Green: `combined/render-combined.ts`.
- **8c wire default + flags** — replace the merge branch in `buildCommit`:
  compute combined (dense default; `combined` for `-c`); empty → header+blank
  (byte-equal to today). `-c`/`--cc` map in `parseShowOptions`.
- **Interop** default merge (non-trivial), `-c`, `--cc`, octopus; confirm the
  existing trivial-merge case still matches.
- Commit `feat(show): combined merge diff (-c/--cc/default)`.

---

## Cross-cutting

- After every slice: `npm run validate` green before commit; never `--no-verify`;
  no ignore directives; no phase/ADR refs in source/test.
- `objects[i]` stays one-result-per-input; `bytes` keeps `shown_one` dedup.
- New error codes: `INVALID_OPTION` (existing?), `PATH_NOT_IN_TREE`. Confirm
  against `domain/commands/error.ts`; reuse where one fits.
- Property siblings (`*.properties.test.ts`) for: date formatters, placeholder
  engine, strftime — per the four-lens rule.

## Post-implementation (workflow Steps 6–9)

1. Reviews ×3 (typescript / security / tests), fix-all-until-converged.
2. Architecture refactor pass (seeded by the diff) + scoped re-review.
3. Mutation: 0 killable survivors (`stryker run --mutate` per touched file).
4. Docs: README / RUNBOOK / `docs/use/` show page; flip backlog `23.1b` → `[x]`.
5. Push + `gh pr create`; monitor CI; admin squash-merge with `--delete-branch`.
