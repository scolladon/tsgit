# Design — add/add content merge (empty-base content merge for both-added paths)

## Problem

When both sides of a 3-way merge **add the same path** (no entry in the merge
base), canonical git runs the **content merge against an empty base**: the
working tree receives a per-region merged file (markers only around the truly
conflicting regions, shared lines outside them), the index gets stages 2/3, and
the conflict is reported as `add/add`. With a `union` driver (or a clean
external driver) the path resolves **cleanly**.

tsgit's tree-level merge (`domain/merge/three-way-tree.ts` → `resolveAddAdd`)
never consults the content merger for a both-added path: differing entries
yield a bare `add-add` conflict with no `conflictContent`, and both worktree
materialisers (`merge.ts#materialiseConflictBytes`,
`apply-merge-to-worktree.ts#conflictBytes`) fall back to writing **ours**
verbatim. Stages 2/3 already match git; the working-tree bytes and the
clean-resolution cases do not.

The content engine is already capable: `mergeContent` handles
`base === undefined` (24.9a), and `buildContentMerger` already skips the base
blob read when `baseId` is absent. Only the tree-level routing is missing.

## Faithfulness evidence (real `git`, v2.x ort)

Probed on twin repos (scrubbed `GIT_*`, signing off, `conflictStyle=merge`);
each row is pinned by interop in this PR.

| Case (both sides add `f`) | git result |
|---|---|
| Text, shared prefix `a b` + tails `X` / `Y` | `CONFLICT (add/add)`; worktree = `a b <<<… X === Y >>>…`; stages 2/3 only |
| Text, ours `a b` ⊂ theirs `a b c` | conflict; markers wrap an **empty ours region** vs `c` |
| Identical bytes, modes 100644 vs 100755 | `CONFLICT (add/add)`; worktree = the (clean) merged content, **no markers**, ours' mode; stages 2/3 share the id, differ in mode |
| Binary, differing | `warning: Cannot merge binary files` + `CONFLICT (add/add)`; worktree keeps **ours** bytes |
| `merge=union`, differing text | **clean merge** (exit 0): ours' lines then theirs' lines, stage 0 |
| File vs symlink | `CONFLICT (distinct types)`; git **renames** ours to `f~HEAD` — *out of scope, see below* |

Derived rules:

- **R1 — route through the content merger.** A both-added path whose entries
  differ runs the path's resolved merge driver with `base = undefined`
  (`baseId`/`baseMode` absent from the `ContentMergeContext`). This reuses the
  whole driver stack — `.gitattributes` resolution, `conflict-marker-size`,
  labels, union favor, external drivers, binary detection — with zero new
  content-level code.
- **R2 — clean content + equal modes ⇒ resolved.** The path resolves cleanly
  (`resolved-merged` bytes, or `resolved-known` when the driver returns a known
  id). This is how `merge=union` add/add becomes a clean merge, matching git.
- **R3 — clean content + differing modes ⇒ still a conflict.** Git keeps the
  `add/add` conflict on a mode disagreement even when the content merges
  cleanly; the worktree gets the merged bytes (no markers). The conflict
  carries `conflictContent` = the clean merged bytes.
- **R4 — conflicting content ⇒ `add-add` conflict with `conflictContent`.**
  The marked bytes (or the binary take-ours bytes) land in `conflictContent`;
  the materialisers write them. The conflict **type stays `'add-add'`** — the
  tree-level shape (no stage 1) is the datum git itself derives its
  `CONFLICT (add/add)` label from; the content-level detail (`content` vs
  `binary`) is recoverable by the consumer from the stage blobs. *(ADR
  candidate — see Decisions.)*
- **R5 — stage entries are unchanged.** `conflictStageEmissions` already emits
  stages 2/3 only when `baseId` is absent; current stage parity with git is
  preserved bit-for-bit.
- **R6 — kind guard.** Only same-kind, non-gitlink pairs content-merge
  (mirrors `resolveBothPresent`'s guards). File-vs-symlink and
  gitlink-vs-gitlink both-added paths keep today's bare `add-add` conflict.
  Git's `distinct types` rename-to-`path~HEAD` handling is a separate
  merge-ort behaviour, deferred as a backlog follow-up. *(ADR candidate.)*

## Change inventory

All changes are behind existing surfaces — no Tier-1 API change, no new port,
no new module.

1. **`domain/merge/three-way-tree.ts`**
   - `resolveAddAdd` gains the `contentMerger` parameter (callers: only
     `resolvePath`) and becomes async on the differing-entries path.
   - Differing entries: kind guard (R6) → bare conflict; else run the merger
     with a base-less `ContentMergeContext` and map the result per R2–R4.
   - The oversize-output guards mirror `resolveContentMerge`
     (`MAX_CONFLICT_OUTPUT_BYTES` on both clean and marked bytes).
   - Mode for a clean resolution = the shared mode (equal by R2's gate).

2. **`application/commands/merge.ts` — `materialiseConflictBytes`**
   - `add-add` branch: prefer `conflict.conflictContent` when present; the
     ours-fallback remains for the kind-guard conflicts (R6) that carry no
     content.

3. **`application/primitives/apply-merge-to-worktree.ts` — `conflictBytes`**
   - First branch generalises from `type === 'content' && conflictContent`
     to `conflictContent !== undefined` (now populated for `content` *and*
     `add-add`). The take-ours fallback remains for R6 conflicts.
   - The function-header equivalence notes and the Stryker-disable
     justifications tied to "add-add always rewrites ours" are now **false**
     and must be re-derived or deleted (the mutants become killable —
     a marker-bearing add/add materialisation observably differs from ours).

4. **Consumers (`cherry-pick` / `revert` / `rebase` / `stash`)** inherit the
   behaviour through `applyMergeToWorktree` / `buildContentMerger` with no
   code change — same as 24.9a/24.9b.

## Out of scope

- **Distinct-types add/add** (file vs symlink): git renames ours to
  `path~HEAD` and stages it at the renamed path. Deferred — new backlog entry
  (sibling of 24.9f), since it is a structurally different conflict shape
  (path renaming), not a content-merge routing fix.
- **Worktree file mode on conflict writes** (chmod of a marker file when ours
  is executable) — pre-existing behaviour, untouched.
- Display strings (`CONFLICT (add/add)`, `Auto-merging`, binary warning) —
  consumer's job per ADR-249; the structured fields suffice to reconstruct
  them.

## Decisions (for the ADR conversation)

1. **Conflict `type` for a content-merged add/add** — keep `'add-add'`
   (recommended; preserves the tree-shape datum, matches the existing enum and
   git's own classification-by-stage-shape) vs propagate the content merger's
   `'content'`/`'binary'` vs add a secondary field.
2. **Distinct-types deferral** — keep bare take-ours `add-add` for differing
   kinds and log a backlog follow-up (recommended) vs implement git's
   `~HEAD` rename in this pass.

## Tests

- **Unit (`three-way-tree.test.ts`)** — differing both-added entries invoke
  the merger with `baseId === undefined`; clean+equal-modes → resolved;
  clean+mode-mismatch → `add-add` conflict with clean `conflictContent`;
  conflicting → `add-add` with marked `conflictContent`; kind-mismatch and
  gitlink pairs bypass the merger entirely; oversize clean/marked outputs
  refuse with `invalidMergeInput`.
- **Unit (materialisers)** — `materialiseConflictBytes` / `conflictBytes`
  prefer `conflictContent` for `add-add`, fall back to ours without it.
- **Interop (`add-add-content-interop.test.ts`)** — twin git/tsgit repos, one
  case per evidence row: text per-region markers + stages, empty-ours region,
  mode-only conflict (clean bytes + stage modes), binary take-ours, union
  clean (merged bytes + stage 0). Working tree compared byte-for-byte; stages
  via `lsStage`.
- **Existing suites** — `merge-conflict-interop` (modify/modify) and
  `merge-driver-interop` must stay green (no behaviour change for based
  paths).

## Risks

- The `apply-merge-to-worktree` equivalence-comment re-derivation must be done
  carefully: stale "equivalent" claims would hide real mutants. Each touched
  `Stryker disable` is either deleted (mutant now killable, killed by a new
  test) or re-justified against the new behaviour.
- `resolveAddAdd` becoming async is absorbed by `resolvePath`'s existing
  `Promise` handling; no caller change.
