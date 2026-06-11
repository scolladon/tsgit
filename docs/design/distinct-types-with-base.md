# Design — distinct types with a base (re-routing `type-change` to git's per-side rename)

## Problem

24.9f shipped git's `CONFLICT (distinct types)` rename for **both-added** paths
(no base). When the colliding path **has a base** and the two sides diverge to
different kinds, git's ort runs the **same rename machinery** — yet tsgit's
tree merge (`domain/merge/three-way-tree.ts` → `resolveBothPresent`) still
classifies every kind disagreement as a bare take-ours `type-change` conflict:

```ts
if (!isSameKind(our.mode, their.mode) || !isSameKind(base.mode, our.mode)) {
  return typeChangeConflict(path, base, our, their);
}
```

That one disjunction hides three distinct git behaviours, all currently
diverged:

1. **Sides of different kinds (file vs symlink), base present** — git renames
   the regular side to `<path>~<label>` and records each side at its own path
   (the with-base sibling of ADR-311). tsgit keeps ours at `path`, emits
   stages 1/2/3 all at `path`, performs no rename, and skips the
   untracked-rename-target refusal.
2. **Sides of the same regular kind, base of a different kind** — git runs the
   full content-driver stack with the base treated as **absent for content**
   (two-way merge; `union` resolves cleanly) while still recording the base's
   stage-1 entry. tsgit takes ours without consulting the merger.
3. **Sides both symlinks, base of any kind** — git conflicts UU taking ours'
   **symlink** without merging link targets. tsgit either takes ours' target
   bytes and writes them **as a regular file** (kind-changed base), or worse,
   content-merges the targets and writes marker bytes as a file (symlink
   base — the `resolveContentMerge` route).

Empirical pinning also surfaced two latent 24.9f gaps the same code paths own:
the unique-path probe appends suffixes **cumulatively** (`p~HEAD_0_1`) where
git resets to the stem (`p~HEAD_1`), and the sequencer `# Conflicts:` block
lists `conflict.path` where git lists the **recorded** paths.

## Faithfulness evidence (real `git` 2.54.0, ort)

Probed on throwaway repos (`env -i`, isolated `HOME`, `GIT_CONFIG_NOSYSTEM=1`,
signing off, `merge.conflictStyle=merge`). Base commit holds `p`; each side is
a branch commit; merge is `git merge --no-ff -m m B`. Index via
`git ls-files -s`, worktree via `lstat`/`readlink`, porcelain via
`git status --porcelain`.

| # | Scenario (both sides changed unless noted) | git result |
|---|---|---|
| S1 | base=file `base\n`; ours=file `ours\n`; theirs=symlink `target-b` | `CONFLICT (distinct types): p had different types on each side; renamed one of them so each can be recorded somewhere.`, exit 1. Index: `120000 <theirs> 3 p`, `100644 <base> 1 p~HEAD`, `100644 <ours> 2 p~HEAD`. Worktree: `p` → symlink `target-b`, `p~HEAD` file `ours\n`. Status `UA p`, `UD p~HEAD`. MERGE_MSG lists `p`, `p~HEAD` |
| S2 | mirror — ours=symlink `target-a`; theirs=file `theirs\n` | same message. Index: `120000 <ours> 2 p`, `100644 <base> 1 p~B`, `100644 <theirs> 3 p~B`. Worktree: `p` → symlink, `p~B` file. Status `AU p`, `DU p~B` |
| S3 | base=symlink `base-target`; ours=symlink `ours-target`; theirs=file | same message. Index: `120000 <base> 1 p`, `120000 <ours> 2 p`, `100644 <theirs> 3 p~B`. Worktree: `p` → ours' symlink, `p~B` file. Status `UD p`, `UA p~B` |
| S4 | mirror — ours=file; theirs=symlink `theirs-target` | Index: `120000 <base> 1 p`, `120000 <theirs> 3 p`, `100644 <ours> 2 p~HEAD`. Worktree: `p` → theirs' symlink, `p~HEAD` file. Status `DU p`, `AU p~HEAD` |
| S5 | trivial — ours did NOT change `p`; theirs=symlink (and mirror) | clean merge, exit 0; changed side taken (`mode change 100644 => 120000 p`) |
| S6 | S1 via `cherry-pick` | same conflict; rename suffix is the **regular side's** label — ours regular ⇒ `p~HEAD` even under cherry-pick; MERGE_MSG = source subject + `# Conflicts:` block listing `p`, `p~HEAD` |
| P5 | via `revert` where theirs (the reverted-to parent) is the regular side | rename target = `p~parent of 9eddd19 (make p a symlink)` — the ADR-307 theirs label **verbatim**, spaces and parens included, only `/` flattened |
| S7 | untracked file squats `p~HEAD` | refusal, exit 2: `error: The following untracked working tree files would be overwritten by merge:\n\tp~HEAD` — nothing written, HEAD/index untouched |
| S8 | tracked `p~HEAD` exists | rename probes to `p~HEAD_0` (stages 1+2 there) |
| P1 | tracked `p~HEAD` **and** `p~HEAD_0` exist | rename probes to **`p~HEAD_1`** — git resets to the stem and re-appends `_<n>`; it does not append cumulatively |
| S9 | base=symlink; ours=file `shared\nours\n`; theirs=file `shared\ntheirs\n` | `Auto-merging p` + `CONFLICT (content)`, UU. Index: `120000 <base> 1 p` + file stages 2/3. Worktree: per-region markers with the **shared prefix outside** them — the content merge ran with an **empty base** |
| P2 | S9 + `merge=union` | **clean merge**, exit 0: `p` = ours' lines then theirs' lines, stage 0, mode 100644 |
| Q1 | base=symlink; sides identical file bytes, modes 100755 vs 100644 | `CONFLICT (content)`, UU; stage 1 symlink + stages 2/3 sharing the blob, differing in mode; worktree = the bytes with **ours' mode** (755), no markers |
| Q2 | base=symlink; `merge=union`; ours 100755 / theirs 100644 differing text | `Auto-merging p` + `CONFLICT (content)`, UU; worktree = clean union bytes, ours' mode, **no markers** — clean content + mode disagreement stays a conflict (the with-base twin of 24.9f's R3) |
| S9b | base=file; both sides symlinks, differing targets | `CONFLICT (content)`, UU; stages 1 (file) + 2/3 (symlinks) at `p`; worktree keeps **ours' symlink** — no target merge, no markers |
| P3 | base=symlink; both sides symlinks, differing targets | identical shape to S9b (UU, three stages at `p`, ours' symlink kept) |
| Q3 | binary regular file vs symlink, base=file | still `CONFLICT (distinct types)` — content plays no role in the distinct-types route |
| S10 | base=file; ours=file; theirs=**gitlink** | `CONFLICT (distinct types)` "renamed one of them": regular ours → `p~HEAD` (stages 1+2), gitlink keeps `p` (stage 3), worktree `p` = empty dir |
| S11 | base=file; ours=symlink; theirs=**gitlink** | "renamed **both** of them": `p~HEAD` symlink (stage 2), `p~B` gitlink (stage 3), `p` **deleted** from index and worktree (status `D  p`) — the base stage vanishes |
| S12 | theirs branch `feature/x`, theirs regular | rename suffix flattens `/` → `_`: `p~feature_x` (stages 1+3 there) |
| S13 | `p` dirty in the working tree before the merge | refusal, exit 2: `error: Your local changes to the following files would be overwritten by merge:\n\tp` |
| Q4 | control — plain modify/modify content conflict, all stages 100755 | marker file written **mode 755**: git materialises every conflict file with the merged/ours mode, exec bit included |

Derived rules:

- **R1 — with-base distinct types reuses the 24.9f rename.** Both sides
  present and changed, kinds differ, no gitlink ⇒ `distinct-types` conflict:
  the **regular** side's recorded path is `<path>~<flatten(label)>` made
  unique; the symlink keeps `path`. Labels, flattening, probing, single
  per-side stage entries, untracked-target refusal: all identical to ADR-311.
  Content is irrelevant (Q3).
- **R2 — the base stage travels with the kind-matching side.** The stage-1
  entry is recorded at the recorded path of the side whose kind equals the
  base's kind: base file ⇒ with the renamed regular side (S1/S2); base
  symlink ⇒ with the symlink side at `path` (S3/S4). Within scope the base is
  file or symlink and always matches exactly one side. The conflict gains a
  `basePath` recording it.
- **R3 — trivial resolution is the scope boundary.** One side unchanged ⇒
  clean take-the-changed-side (S5) — already shipped via `entriesEqual`;
  distinct-types fires only when **both** sides changed.
- **R4 — kind-changed base, same-kind regular sides ⇒ base-less content
  merge, base-ful stages.** The path runs the full driver stack with
  `baseId`/`baseMode` **absent from the `ContentMergeContext`** (two-way
  merge, S9), but the emitted conflict keeps `baseId`/`baseMode` so stage 1
  is recorded (git does). Clean content + equal modes ⇒ resolved (P2);
  clean-or-identical content + differing modes ⇒ `content` conflict carrying
  the merged bytes, worktree gets them with ours' mode, no markers (Q1/Q2) —
  the with-base mirror of 24.9f's R2/R3.
- **R5 — symlink pairs are never content-merged.** Both sides symlinks, both
  changed, any base kind ⇒ bare conflict taking ours, stages 1/2/3 at `path`,
  worktree write **symlink-aware** (S9b, P3). This removes the
  marker-bytes-as-file divergence on the P3 route and the
  link-target-as-regular-file bug on the S9b route.
- **R6 — unique-path probing resets to the stem.** `p~HEAD`, `p~HEAD_0`,
  `p~HEAD_1`, … (P1). The shipped cumulative `${candidate}_${n}` produces
  `p~HEAD_0_1` on a double collision — a latent 24.9f divergence fixed here.
- **R7 — `# Conflicts:` lists recorded paths.** The sequencer MERGE_MSG block
  (cherry-pick / revert / rebase) names each conflict's **recorded** paths,
  sorted (S6: `p`, `p~HEAD`) — not `conflict.path`. `merge`'s MERGE_MSG keeps
  no trailer per ADR-028.
- **R8 — gitlink-involved pairs stay out of scope.** git renames per S10/S11
  (including the rename-both shape that drops the base stage and deletes
  `path`); tsgit keeps today's bare take-ours `type-change` for them —
  recorded divergence, consistent with 24.9f's gitlink deferral.
- **R9 — refusal surfaces.** Untracked file at a rename target refuses before
  any write (S7) — the existing 24.9f guard covers it once with-base conflicts
  flow through `distinct-types`. The tracked-dirty refusal (S13) is the
  pre-existing merge-command-wide guard gap (the `applyMergeToWorktree`
  consumers already refuse via `findWouldOverwrite`); it is not widened here.

## Current state

- `src/domain/merge/three-way-tree.ts` — `resolveBothPresent` collapses all
  three behaviours into `typeChangeConflict`; `distinctTypesConflict` /
  `uniquePath` / `flattenLabel` exist but are reachable only from
  `resolveAddAdd`; `uniquePath` probes cumulatively (R6 violation);
  `resolveContentMerge` always passes the real base into the
  `ContentMergeContext`.
- `src/domain/merge/merge-types.ts` — `MergeConflict` has
  `ourPath`/`theirPath` (ADR-311) but nothing records where stage 1 lives.
- `src/domain/diff/index-diff.ts` — `distinctTypesEmissions` emits stage 2 at
  `ourPath` / stage 3 at `theirPath` and **ignores the base**;
  `recordedPaths` (module-private) already returns the per-side paths.
- `src/application/commands/merge.ts` — `materialiseConflictBytes` returns
  ours' **bytes** for `type-change`; `writeConflictToTree` writes them via
  `writeWorkingTreeFile` (regular file — the symlink-bytes-as-file bug); the
  mode-aware branch (`useMode`) fires only for bare `add-add`.
  `collectUntrackedRenameBlockers` + `writeDistinctTypesSides` already
  implement the rename write + refusal. `persistConflictState` has no
  tracked-dirty guard (R9, pre-existing).
- `src/application/primitives/apply-merge-to-worktree.ts` — `conflictBytes` /
  `writeMarkedConflict` have the same take-ours-as-file shape;
  `changedPaths` + `findWouldOverwrite` already cover both recorded paths and
  the dirty/untracked refusals for the apply consumers.
- `src/application/primitives/internal/write-distinct-types-sides.ts` —
  symlink-aware dual-path writer; needs no change (the base is never
  materialised).
- `src/application/primitives/build-content-merger.ts` — reads the base blob
  iff `baseId` is present in the context; R4's base-less routing needs zero
  change here.
- `src/application/commands/cherry-pick.ts:361`, `revert.ts:193`,
  `rebase.ts:343/1059/1081` — `conflictMergeMsg(draft, conflicts.map((c) => c.path))`
  (R7 violation, latent since 24.9f for no-base distinct types).

## Proposed design

### Data shape (`domain/merge/merge-types.ts`)

`MergeConflict` gains one field:

```ts
/** Recorded path of the base's stage-1 entry; populated only on `distinct-types` conflicts that have a base. */
readonly basePath?: FilePath;
```

A with-base `distinct-types` conflict carries `baseId`/`baseMode` (already
optional) + `basePath` per R2. No-base conflicts are unchanged — `baseId`
absence keeps discriminating the add/add shape (ADR-310 spirit).

### Classification (`domain/merge/three-way-tree.ts`)

`resolveBothPresent` gains `labels` + `reserved` (threaded from `resolvePath`,
same values `resolveAddAdd` gets) and replaces the single kind-mismatch
disjunction with:

| ours kind | theirs kind | base kind | route |
|---|---|---|---|
| regular | symlink (either order) | any non-gitlink | `distinct-types` with base fields (R1+R2) |
| differs from theirs | — | — (gitlink anywhere in the pair) | `type-change` as today (R8) |
| symlink | symlink | any | bare take-ours `content` conflict, no merger call (R5, ADR-319) |
| regular | regular | kind differs | `resolveContentMerge` with a **base-less context** but base-ful conflict/stage fields (R4) |
| regular | regular | regular | existing route, untouched |
| gitlink | gitlink | gitlink | `gitlinkConflict`, untouched |
| gitlink | gitlink | non-gitlink | `type-change` as today (R8) |

- `distinctTypesConflict` is extended to accept the optional base entry and
  compute `basePath` by kind-match (base kind === regular ⇒ the renamed
  regular side's path; base kind === symlink ⇒ `path`).
- `uniquePath` probing resets to the stem per R6 (`` `${stem}_${n}` `` with
  `stem` fixed at the first candidate), fixing the latent 24.9f divergence in
  the same helper the no-base route uses.
- R4 builds a `ContentMergeContext` **without** `baseId`/`baseMode` (so
  `buildContentMerger` reads no base blob and `mergeContent` runs the
  two-way merge) while the conflict and the resolved-mode logic use the real
  base entry only for stage emission — never to tie-break the mode (Q1/Q2:
  differing side modes under a kind-changed base stay a conflict; the
  worktree carries ours' mode via the existing `conflictContent` +
  per-side-stage shape). Mode rule: equal side modes ⇒ that mode (resolved
  when content is clean); differing side modes ⇒ conflict even on clean
  content, `contentVerdict: 'clean'`-style merged bytes in `conflictContent`.
- R5 builds a bare conflict (no `conflictContent`, no `contentVerdict`) with
  all three stage fields, typed **`'content'`** (ADR-319) — matching git's
  `CONFLICT (content)`/`UU` family. Consumers reconstructing displays must
  handle the bare (no-`conflictContent`) `content` shape.

R4's clean-content/mode-conflict case carries **`contentVerdict: 'clean'`**
on its `'content'`-typed conflict per ADR-320, which amends ADR-310's
"add-add only" clause (symmetry with 24.9f, cheap display reconstruction).

### Stage emission (`domain/diff/index-diff.ts`)

`distinctTypesEmissions` additionally emits
`{ id: baseId, mode: baseMode, stage: 1, path: basePath }` when all three are
present. Ordering inside `conflictsToIndexEntries` already handles same-path
stage runs (S1's `p~HEAD` carries stages 1+2 — the first distinct-types
recorded path with two stages; the existing comparator sorts it, but the two
Stryker-equivalence comments claiming "distinct-types: one stage per path"
become **false** and must be re-derived or deleted). `recordedPaths` gains
nothing — `basePath` always equals `ourPath` or `theirPath`, so the
duplicate-path uniqueness keys are unchanged.

### Worktree writes (`merge.ts`, `apply-merge-to-worktree.ts`)

- Distinct-types conflicts (now also with-base) keep routing to
  `writeDistinctTypesSides` — dual recorded paths, symlink-aware, base never
  written. No change to the writer.
- Conflict writes become **mode-aware repo-wide** (ADR-321): in both
  `writeConflictToTree` (merge) and `writeMarkedConflict` (apply), `useMode`
  becomes `conflict.ourMode !== undefined` — for every conflict type, bare or
  `conflictContent`-bearing.
  - Bare take-ours conflicts — R5 symlink pairs, gitlink-involved
    `type-change` whose ours side is a symlink — re-create ours' **kind**
    (mode 120000 ⇒ `fs.symlink`) instead of dumping bytes into a regular
    file.
  - Marker-bytes (`conflictContent`) writes carry the resolved/ours mode, so
    the **exec bit** survives conflict materialisation (Q1/Q2 here, and the
    pre-existing repo-wide Q4-control gap for any content conflict on an
    executable file — fixed in the same rule rather than deferred).
  - `modify-delete` keeps its survivor logic (it can carry a theirs-only
    survivor; its present side is by definition the unchanged kind on disk).
  - Interop assertions pin worktree **bytes, kinds, and modes** (Q1/Q2/Q4).
- Equivalence comments tied to "take-ours always reproduces bytes already on
  disk" (`conflictBytes`, `outcomeChangesOurs`) must be re-derived: with a
  base, `path`'s content **changes side** (S1: ours' file is replaced by
  theirs' symlink), so several previously-equivalent mutants become killable.

### Refusal surfaces

- `collectUntrackedRenameBlockers` (merge) and `findWouldOverwrite` (apply)
  already key off `distinct-types` recorded paths; with-base conflicts
  inherit S7's refusal with no code change. Interop pins it.
- S13 (tracked-dirty `p`) is refused on the apply consumers today and **not**
  on the merge command (pre-existing, conflict-wide, not distinct-types
  specific) — deferred to a backlog follow-up rather than widened here.

### Sequencer MERGE_MSG (R7)

Export a recorded-paths mapper (promote `index-diff.ts`'s private
`recordedPaths`, or a sibling in `domain/merge`) and switch the five
`conflictMergeMsg(draft, conflicts.map((c) => c.path))` call sites
(cherry-pick ×1, revert ×1, rebase ×3) to the sorted recorded paths. This
retroactively fixes the same gap for 24.9f's no-base distinct types.
`merge.ts` stays trailer-less per ADR-028.

### Consumers

`cherry-pick` / `revert` / `rebase` / `stash` inherit everything through
`applyMergeToWorktree` + `buildContentMerger`; labels are already threaded
(ADR-307). S6/P5 pin the inherited suffixes. `mergeTreesToTree`
(stash `--index`) keeps returning `conflict` without reinstating the index —
no change.

## Out of scope

- **Gitlink-involved pairs** (S10/S11) — bare `type-change` take-ours as
  today; git's rename-one and rename-both shapes are recorded above so the
  deferral is an informed one (submodule merging is outside v1's surface).
- **Delete vs kind-change pairs** (one side absent) — stay on the existing
  `modify-delete` route untouched; this item's scope is both-sides-present
  (deliberately unpinned).
- **Merge-command tracked-dirty refusal** (S13) — pre-existing gap for every
  conflict type; backlog follow-up, not part of this change.
- **Display strings** (`CONFLICT (distinct types)`, `Auto-merging`, refusal
  prose) — consumer's job per ADR-249; the structured fields (`type`,
  recorded paths, stages, `conflictContent`) suffice to reconstruct them.
- **`merge` MERGE_MSG trailer** — ADR-028 divergence stands.
- **Recursive/inner merges** (`call_depth > 0` takes the base version in ort)
  — tsgit v1 has no recursive merge; nothing to mirror.

## Decisions

Ratified:

1. **Conflict type for with-base distinct types** — reuse `'distinct-types'`
   with optional base fields; `baseId` discriminates the with-base shape
   (ADR-318).
2. **`basePath` as an explicit field** — classification computes the
   kind-match placement once; stage emission and consumers read it directly
   (ADR-318).
3. **R5 symlink-pair conflict type** — **`'content'`**, matching git's
   display family; `content` conflicts may now be bare (no `conflictContent`)
   (ADR-319).
4. **R5 reach** — **both base kinds** (S9b and P3); one guard, removes the
   symlink-target content-merge divergence in the same change (ADR-319).
5. **`contentVerdict` on R4's `'content'` conflicts** — carry `'clean'` for
   the clean-content/mode-conflict case; amends ADR-310's "add-add only"
   clause (ADR-320).
6. **Mode-aware conflict writes repo-wide** — `useMode` is "ours' mode
   whenever defined" for every conflict write, bare or marker-bytes; fixes
   the symlink-bytes-as-file bug **and** the pre-existing exec-bit gap in one
   rule (ADR-321).

ADR-311 (rename mechanics, labels, refusal), ADR-307 (labels), ADR-028
(MERGE_MSG), ADR-249 (structured output) bind the rest as cited inline.

## Tests

- **Interop (`test/integration/distinct-types-with-base-interop.test.ts`)** —
  twin git/tsgit repos per the `add-add-content-interop` harness, one case per
  evidence row in scope: S1–S4 (worktree kinds/bytes + `lsStage` parity,
  both side orders × both base kinds), S5 trivial boundary (clean), S6
  cherry-pick + P5 revert suffixes, S7 untracked refusal (nothing written),
  S8/P1 probing (`_0`, then `_1` on double collision), S9 base-less markers,
  P2 union clean, Q1/Q2 mode conflicts (worktree **bytes + modes** + stages,
  per ADR-321) and the Q4 exec-bit control (755 marker file on a plain
  content conflict), S9b/P3 symlink pairs (ours' symlink in the worktree,
  three stages), S12 flattening. Stage bytes compared via `lsStage`; worktree
  via `lstat`/`readlink` + content.
- **Unit (`three-way-tree.test.ts`)** — routing table row by row: with-base
  file/symlink pairs build `distinct-types` with `basePath` per kind-match
  (all four side/base permutations); gitlink pairs keep `type-change`;
  symlink pairs bypass the merger (bare conflict, all stage fields); R4 calls
  the merger with `baseId === undefined` while the conflict keeps
  `baseId`/`baseMode`; clean+equal-modes resolves; clean+differing-modes
  conflicts (`'content'` + `contentVerdict: 'clean'`); symlink pairs typed
  `'content'`; `uniquePath` double-collision probes `_1` (kills the
  cumulative variant); existing no-base cases stay green.
- **Unit (`index-diff.test.ts`)** — stage-1 emission at `basePath`;
  two-stage runs at one recorded path sort 1-before-2; re-derived comparator
  expectations.
- **Unit (materialisers)** — generalised `useMode` (ADR-321): bare conflicts
  with symlink ours write a symlink (both writers); `conflictContent`-bearing
  conflicts write with ours'/resolved mode (exec bit preserved);
  `writeDistinctTypesSides` untouched (existing tests stand).
- **Unit (sequencer)** — `conflictMergeMsg` call sites receive sorted
  recorded paths (cherry-pick/revert/rebase state tests).
- **Property lens check (per CLAUDE.md)** — the four lenses were applied:
  no parse/serialize pair, no rule aggregator, and the routing table is a
  small-enum sweep (explicitly listed as a non-fit). The one candidate is
  `uniquePath` (idempotence/counting lens): for an arbitrary reserved set and
  label, the result is not in the set and equals `stem` or `stem_<n>` with
  minimal `n` — a small `three-way-tree.properties.test.ts` ships iff the
  helper is exported for direct testing; otherwise the P1 example sweep
  covers the grammar (single helper, bounded loop). Recommended: ship the
  property (the probing bug P1 caught is exactly grammar-shaped).
- **Existing suites** — `add-add-content-interop` (no-base behaviour
  byte-identical except the probing fix), `merge-conflict-interop`,
  `merge-driver-interop`, cherry-pick/revert/rebase/stash interop stay green.

## Risks

- **Stage runs at a renamed path** — S1's `p~HEAD` is the first recorded path
  carrying two stages (1+2); the `conflictsToIndexEntries` comparator already
  orders it, but two Stryker-equivalence justifications assert the opposite
  invariant and must be re-derived, not blindly kept.
- **Reclassification blast radius** — paths that today yield `type-change`
  silently start yielding `distinct-types` / merger routes; any consumer
  matching `type === 'type-change'` (status mapping uses the *diff* change
  type, not the conflict type — verified) must be re-audited during review.
- **`resolveBothPresent` signature growth** (labels + reserved) touches its
  only caller (`resolvePath`) — mechanical, but the reserved-set threading
  must reuse the same set instance `resolveAddAdd` mutates, or two conflicts
  could probe the same target.
- **Probing fix changes shipped 24.9f behaviour** on double collisions —
  strictly a faithfulness fix (P1), but it alters an observable output;
  release note it.
- **Equivalence-comment re-derivation** in `apply-merge-to-worktree.ts` /
  `merge.ts`: with-base distinct types invalidate the "take-ours reproduces
  on-disk bytes" claims; stale claims would hide real mutants.
