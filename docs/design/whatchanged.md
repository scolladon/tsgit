# Design — `whatchanged` (log walk with raw structured changes)

## Goal

Ship the Tier-1 `whatchanged` command — git's `git whatchanged`: walk the
commits reachable from a revision and pair each one with the **raw structured
changes** it introduced. Like every Phase-23 inspection command it returns
**structured data only** (ADR-249): per-commit the `log` projection (oids,
identities, message) plus a `TreeDiff` of the changes against the first parent
(root: against the empty tree). The `--raw` line rendering (`:<mode> <mode>
<sha> <sha> <status>\t<path>`), oid abbreviation, and date formatting are
caller concerns — the library emits no line.

## Faithfulness research (verified against real `git` 2.54.0)

`git whatchanged` is, in modern git, an exact alias for `git log --raw
--no-merges`. The CLI is deprecated (refuses without `--i-still-use-this`), but
its **observable data behaviour** is stable and is what we replicate:

1. **Merges are excluded from the output.** `git rev-list --count HEAD` = 4 vs
   `--count --no-merges HEAD` = 3 on a one-merge history; `whatchanged` emits the
   three non-merge commits only. The merge is still *traversed* for reachability
   (both parents followed) — it is an output filter, not a walk cut. This is a
   **data** decision (which commits are in the result set), not a cosmetic one.
2. **Per-commit diff is against the first parent**, recursive, with the full path
   shown (`:100644 100644 … M\tdir/file`). A root commit diffs against the empty
   tree (`:000000 100644 0000000 <sha> A\tfile`).
3. **Rename detection is ON by default** (`diff.renames` defaults true): a pure
   rename renders `R100\told\tnew`, not `D` + `A`. Verified: the `R100` line
   appears with no `-M` flag; `-c diff.renames=false` flips it back to `D`+`A`.
   This matches `show`'s hardcoded-on rename detection (ADR-242), and diverges
   from `diff`'s opt-in.
4. **Empty commits are emitted** with an empty change set (header, no `:` lines).
5. **`-n <limit>` counts emitted (post-`--no-merges`) commits.**
6. **Default walk order = `git log` order** — every reachable commit across all
   parents, newest committer-date first (the read model `walkCommitsByDate`,
   ADR-261/273). `--first-parent` follows only the first parent.

The raw `sha` field is abbreviated to `core.abbrev`; `--abbrev=40` forces full
40-hex oids, which lets the interop test reconstruct the raw lines from the
structured full `ObjectId`s deterministically.

## Architecture

Hexagonal, Tier-1 command composed from existing primitives — **no new domain
code, no new primitive**. The command is a thin projection that:

1. `assertRepository(ctx)`.
2. Resolves `rev` (default `HEAD`) and each `excluding` entry through the shared
   `resolveCommit` (full rev grammar; unborn HEAD / unresolvable → refuses,
   identical to `log`).
3. Selects the walk by `order`: `walkCommitsByDate` (default) or `walkCommits`
   first-parent — the exact pair `log` already chooses between.
4. For each walked commit: **skip merges** (`parents.length >= 2`); for a
   non-merge, diff its tree against the first parent's tree (root → empty) via
   the existing `diffTrees` primitive with `{ recursive: true, detectRenames:
   true }` — the same call `show.buildCommit` makes for a single-parent commit.
5. Projects the `log` fields + `changes` into a `WhatchangedEntry`; honours
   `before` (skip `committer.timestamp >= before`) and `limit` (break after N
   emitted entries) with the same post-filter counting semantics as `log`.

The per-commit "changes a commit introduced vs its first parent" diff is the
same logic `show` already runs privately (`diffParentToTree`). With `whatchanged`
as the second consumer, the architecture pass (workflow Step 7) extracts that
into a shared internal helper both commands call (DRY, behaviour-preserving).

### Application — `whatchanged(ctx, opts?)`

```ts
export const whatchanged = async (
  ctx: Context,
  opts: WhatchangedOptions = {},
): Promise<ReadonlyArray<WhatchangedEntry>> => { … }
```

## Public surface

```ts
repo.whatchanged(opts?: WhatchangedOptions): Promise<ReadonlyArray<WhatchangedEntry>>;

interface WhatchangedOptions {
  readonly rev?: string;                       // commit-ish start, full grammar; default 'HEAD'
  readonly order?: LogOrder;                   // 'date' (default) | 'first-parent'
  readonly limit?: number;                     // git -n; counts emitted (non-merge) entries
  readonly excluding?: ReadonlyArray<string>;  // negative range stops (git's A..B / ^X)
  readonly before?: Date;                      // only commits with committer.timestamp < before
}

interface WhatchangedEntry extends LogEntry {   // id, tree, parents, author, committer, message
  readonly changes: TreeDiff;                   // raw changes vs first parent (root: vs empty tree)
}
```

`LogOrder` / `LogEntry` are reused from `log` (the commit projection stays in
lockstep with `log` by construction). `TreeDiff` is the existing
`domain/diff` structure, identical to what `diff`/`show` return.

### Open decisions (→ ADR conversation)

1. **Command vs `log` option** — ship a distinct `whatchanged` command (git's
   command surface; the backlog item) **or** fold it into `log({ withChanges })`.
   _Recommendation: separate command._ Matches git's surface and the per-command
   precedent (`shortlog`, `range-diff`), keeps `log`'s lean projection
   un-muddied, and the no-merges default is a different result set than `log`.
2. **Merge handling** — exclude merges only (git default, single `changes` per
   entry) **or** also offer an opt-in that includes merges with **per-parent**
   changes (git `-m`, mirroring `show`'s `perParent`). _Recommendation:
   exclude-only for v1._ Covers the defining behaviour; `-m`/`-c` merge diffs are
   already reachable through `show`, and adding them widens `changes` to a union.
3. **Entry shape** — `WhatchangedEntry extends LogEntry` + `changes`
   (recommended; keeps the commit fields identical to `log`) **or** reuse
   `show`'s `ShowCommitResult` union **or** a nested `{ commit, changes }`.

## Surface gates (per the Tier-1 checklist)

- `src/application/commands/whatchanged.ts` + barrel export
  (`commands/index.ts`) → flows to the public API via `src/index.ts`'s
  `export *`.
- `repository.ts`: interface field + facade binding (sorted last, after `tag`).
- `repository.test.ts`: add `'whatchanged'` to the facade key-set assertion.
- `reports/api.json`: regenerated (new public command + types).
- `docs/use/commands/whatchanged.md` + a row in `docs/use/commands/README.md`
  (doc-coverage gate, `tooling/check-doc-coverage.ts`); bump the "35 entries" →
  "36" count there and in `README.md`.
- `test/integration/whatchanged-interop.test.ts`: reconstruct `git log --raw
  --no-merges --abbrev=40` from the structured entries; byte-equal vs real git.
- `test/parity/scenarios/whatchanged.scenario.ts` (+ index registration):
  cross-adapter (node / memory / browser).
- `docs/BACKLOG.md`: flip `23.7` to `[x]`.

## Testing strategy

- **Unit** (`whatchanged.test.ts`): GWT/AAA, `sut`, 100% line/branch/function +
  0 surviving mutants. Cases: default walk pairs each non-merge commit with its
  first-parent changes; root commit diffs vs empty tree; merge commit excluded
  but its non-merge ancestors present; rename surfaces as a single `rename`
  change (detection on); empty commit yields empty `changes`; `limit` counts
  emitted entries (a merge in the window does not consume a slot); `before`
  filter; `excluding` range; `order: 'first-parent'`; unresolvable `rev` /
  `excluding` refuse with the same error as `log`. Each guard (merge skip,
  before, limit) gets an isolated test (mutation-resistant).
- **Interop**: one git-built repo (renames, a merge, a root, an empty commit);
  reconstruct the raw lines and assert byte-equality with `git log --raw
  --no-merges --abbrev=40`, plus a `--first-parent` case.
- **Parity scenario**: a small linear+branch history asserting the same entries
  on node / memory / browser.

## Non-goals (deferred, git-faithful divergences noted)

- **`-m` / `-c` merge diffs** (per-parent / combined) — out of v1 (pending the
  ADR decision); already available via `show`.
- **Pathspec filtering** (`whatchanged -- <path>`) and the history simplification
  it triggers — no command takes a pathspec walk filter yet.
- **`withStat` / `--numstat`** — `whatchanged`'s identity is the *raw* format;
  callers wanting counts re-diff with `show`/`diff`'s `withStat`.
- **`--no-renames` toggle** — renames are hardcoded on (faithful default), like
  `show`.
- **`--follow`** rename-following across the walk.
```
