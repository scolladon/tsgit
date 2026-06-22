# Design — gitlink/submodule PATCH rendering ("Subproject commit") — all diff kinds

> Brief: make tsgit render the PATCH of any diff whose one side is a gitlink
> (mode `160000`) byte-faithfully to real git. git renders the gitlink side as the
> synthetic submodule line `Subproject commit <40-hex-oid>` (no blob hunk), because
> a gitlink oid is a COMMIT, not a blob. This LIFTS the scope boundary
> [ADR-402](../adr/402-type-change-patch-render-delete-add.md) explicitly deferred.
>
> **Scope (ratified [ADR-404](../adr/404-gitlink-patch-rendering-all-diff-kinds.md)):**
> the original brief named gitlink **type-change** only. ADRs 403–404 widened it to
> **all four gitlink diff kinds — add, delete, modify, and type-change** — because
> `materialiseOne` calls `readBlob` on every arm, so the commit-oid throw hits a pure
> gitlink ADD (a submodule first appears) and a pure gitlink DELETE (a submodule is
> removed) identically to a type-change/modify. A submodule add is the most common
> submodule diff of all. The fix ([ADR-403](../adr/403-synthesize-gitlink-subproject-line-in-materialise.md))
> is **per-side and change-kind-agnostic**: every `materialiseOne` arm that would
> `readBlob` a gitlink-mode side synthesizes `Subproject commit <oid>\n` instead.
> Status: draft → self-reviewed ×3 → accepted → **revised against ADRs 403–404**

## Context

[ADR-402](../adr/402-type-change-patch-render-delete-add.md) made **file↔symlink**
type-change patches byte-faithful to git: git renders a type-change as **two**
`diff --git` blocks at the same path — a full `deleted file mode <old>` block for
the old kind followed by a full `new file mode <new>` block for the new kind — and
tsgit now composes `renderDeleteBlock` + `renderAddBlock`
(`src/domain/diff/patch-serializer.ts:588` `renderTypeChangeBlock`) to match.

ADR-402 drew a **scope boundary** (its "gitlink/submodule side OUT scope" section):
the gitlink side of a diff was deferred because tsgit has no submodule-content
synthesis. The hydration primitive `materialiseOne`
(`src/application/primitives/materialise-patch-files.ts:20`) calls `readBlob`
(`src/application/primitives/read-blob.ts:7`) on **every arm** — `add` (newId),
`delete` (oldId), `rename`/`copy` (both, when inexact), `modify`/`type-change` (both) —
and a gitlink oid is a **commit**, so `readBlob` throws
`unexpectedObjectType('blob', 'commit', id)`. The deferred boundary is documented in
[design/diff-faithfulness-odds-ends.md](./diff-faithfulness-odds-ends.md) §2.5 ("The
gitlink side renders as git's synthetic `Subproject commit <oid>` … OUT of scope") and
§5 ("Reproducing submodule patch rendering — a separate, larger feature").

This feature lifts **exactly** that boundary, across **all four reachable change
kinds** that carry a gitlink-mode side: a pure gitlink **add** (`new file mode
160000` + `+Subproject commit <oid>`), a pure gitlink **delete** (`deleted file mode
160000`), a gitlink↔gitlink **modify** (a pointer bump, single `index a..b 160000`
block), and a file/symlink↔gitlink **type-change** (the two-block delete+add form). The
synthesis mechanism is identical on every arm — synthesize `Subproject commit <oid>\n`
for any gitlink-mode side regardless of change kind (ADR-403/404). The
**structural** gitlink `T` pins from [ADR-399](../adr/399-type-change-already-faithful-pin-only.md)
(`--raw`/`--name-status` `T` for the type-change leaf-kind pairs, both directions)
already exist in `test/integration/diff-type-change-interop.test.ts` and **must keep
passing unchanged**; this feature ADDS the matching structural `A`/`D`/`M` pins for the
new add/delete/modify kinds, plus the PATCH-byte faithfulness arm on top of all of them.

Subsystems this touches:

| Subsystem | File:symbol | Role here |
|---|---|---|
| patch serializer (domain) | `src/domain/diff/patch-serializer.ts` `renderTypeChangeBlock` (`:588`), `renderDeleteBlock` (`:401`), `renderAddBlock` (`:382`), `renderModifyBlock` (`:560`) → `renderSameKindBlock` (`:506`) → `modePreamble` (`:438`), `renderPatch`, `splitContentLines`, `shortOid` | the library's ONE sanctioned patch-bytes producer (ADR-402); composes add / delete / modify / two-block type-change |
| blob hydration (primitive) | `src/application/primitives/materialise-patch-files.ts` `materialiseOne` (`:20`) | hydrates **every** change kind via `readBlob` — `add`, `delete`, `rename`/`copy`, `modify`, `type-change`; the gitlink side of ANY arm must NOT read a blob |
| diff change shape (domain) | `src/domain/diff/diff-change.ts` `AddChange` (`:6`), `DeleteChange` (`:13`), `ModifyChange` (`:20`), `TypeChangeChange` (`:42`) | each already carries the relevant `*Id`/`*Mode`; the gitlink oid + `160000` are already present on every shape |
| mode kind (domain) | `src/domain/diff/mode-kind.ts` `kindOf` (`:6`) | `gitlink = 160000` (`FILE_MODE.GITLINK`, `src/domain/objects/file-mode.ts:8`); the per-side guard is `kindOf(mode) === 'gitlink'` |
| rename detection (primitive) | `src/application/primitives/detect-similarity-renames.ts` `partitionLeftovers` (`:337`), `hydrateIds` (`:36`), `runInexactPass` (`:428`); `src/domain/diff/rename-detect.ts` `detectRenames` (`:87`), `tryFoldAdd` (`:64`) | inexact rename/copy reads blob bytes to score similarity — a gitlink has no readable content; § Design determines whether a gitlink can ever be a rename/copy candidate |
| interop pins | `test/integration/diff-type-change-interop.test.ts` | builds the four type-change gitlink directions via `--cacheinfo 160000` with `--raw`/`--name-status` arms; gains `reconstructPatch` arms for those + new ADD / DELETE / MODIFY arms |

Cross-cutting constraints (tsgit prime directives — non-negotiable):

| Source | Binding constraint on this design |
|---|---|
| [ADR-226](../adr/226-git-faithfulness-prime-directive.md) / CLAUDE.md (git-faithfulness) | Replicate git's observable DATA + patch bytes byte-for-byte. Pinned against real `git 2.54.0`, scrubbed `GIT_*`, `GIT_CONFIG_NOSYSTEM=1`, signing off, isolated `HOME`, throwaway `mktemp -d` repo, `--no-ext-diff` on every scripted `git diff`. Each pinned behaviour becomes a cross-tool interop test in `test/integration/*-interop.test.ts`. |
| [ADR-249](../adr/249-describe-structured-data-only.md) (structured-data-only) | The library returns FIELDS, never rendered text. The `Subproject commit <oid>` line is git's DISPLAY, reconstructed FROM the structured `TreeDiff` fields inside the interop test. **Nuance (§ Design):** `renderPatch` is the ONE sanctioned patch-bytes producer (ADR-402 already renders patch text there); the synthetic line belongs in it exactly as the add/delete/modify blocks do — completing an existing faithful producer, NOT a new rendering knob. |
| [ADR-403](../adr/403-synthesize-gitlink-subproject-line-in-materialise.md) (synthesis mechanism) | The gitlink side of ANY change kind is hydrated by synthesizing the literal bytes `Subproject commit <oid>\n` in `materialiseOne` — never via `readBlob` — whenever that side's mode is a gitlink. The domain serializer is unchanged. The submodule string is a single named constant in the primitive. |
| [ADR-404](../adr/404-gitlink-patch-rendering-all-diff-kinds.md) (all-kinds scope) | Gitlink patch rendering covers **add, delete, modify, and type-change**. The synthesis is change-kind-agnostic — a per-side gitlink check on each arm of `materialiseOne`, not a per-kind special case. Each kind is pinned against live git and guarded by a unit test. |
| CLAUDE.md (architecture) | Hexagonal: `repository → commands → primitives → domain`. Domain stays platform-free; `materialise-patch-files` is a primitive (application tier) and may not leak into the domain. Object Calisthenics, branded types, FP-first, immutable. |
| Sibling design docs | Format/depth follows `docs/design/diff-faithfulness-odds-ends.md` and `docs/design/whitespace-diff-options.md`. |

The empirical pins below were all run in `mktemp -d` throwaways with the faithfulness
procedure (`.claude/workflow/faithfulness.md`); none touched the worktree's `.git`.

## Requirements

What must be true when this ships:

1. `renderPatch` emits byte-faithful patch text for **every gitlink diff kind**:
   - a pure gitlink **add** (path absent in old tree, `160000` in new): a single
     `new file mode 160000` block with body `+Subproject commit <oid>`;
   - a pure gitlink **delete** (`160000` in old, absent in new): a single
     `deleted file mode 160000` block with body `-Subproject commit <oid>`;
   - a gitlink↔gitlink **modify** (`160000`→`160000`, distinct oids): a single
     `index <a>..<b> 160000` block with a `-1/+1` `Subproject commit` hunk;
   - a file/symlink↔gitlink **type-change** for all four directions: file→gitlink
     (`100644`→`160000`), gitlink→file (`160000`→`100644`), symlink→gitlink
     (`120000`→`160000`), gitlink→symlink (`160000`→`120000`) — the two-block
     delete+add form — matching the §"Faithfulness baseline" matrix.
2. Every gitlink-mode side renders with body `Subproject commit <40-hex-oid>` with a
   **trailing newline** (no `\ No newline at end of file` marker), `<mode> = 160000`,
   and the `index` line carrying the gitlink-oid 7-prefix (and `..0000000` for delete /
   `0000000..` for add).
3. `materialiseOne` carries any gitlink side through WITHOUT a `readBlob` call — the
   gitlink oid is already on the change; no commit object is read. The check is
   per-side (`kindOf(oldMode/newMode) === 'gitlink'`) on every arm, change-kind-agnostic.
4. The non-gitlink side of each type-change/modify keeps its existing faithful
   rendering (real blob content; symlink side keeps its `\ No newline` marker per the pin).
5. The structural gitlink `T` pins from ADR-399 keep passing **unchanged**, and this
   feature adds the matching `A`/`D`/`M` `--raw`/`--name-status` structural pins — all
   purely additive (no existing pin changes).
6. The rename/copy arm is correct: a gitlink can be at most an **exact same-oid**
   rename (which `materialiseOne` short-circuits with no `readBlob`); git never
   produces an **inexact** (content-scored) gitlink rename/copy — § Design § "rename/copy
   arm" pins this and states whether a defensive guard is required.
7. Blast-radius consumers (`patch-id`, `range-diff`, `rebase`) compose any gitlink
   patch correctly through the shared `materialisePatchFiles` → `renderPatch` path;
   patch-id stays stable (the `Subproject commit` line survives canonicalisation;
   §"Blast radius").
8. No new rendering knob is added (ADR-249); the synthetic line is produced inside
   the existing `renderPatch`, and the interop test reconstructs git's display from
   the structured fields.
9. Domain stays platform-free; the gitlink-content synthesis lives in the
   application-tier primitive, not the domain serializer.

## Design

### The shape of git's gitlink patch across all four kinds (the load-bearing fact)

The PIN matrix (§"Faithfulness baseline") shows git renders a gitlink side **identically
regardless of change kind** — the *only* gitlink-specific content is the body line
`Subproject commit <40-hex-oid>` (newline-terminated, no marker), `<mode> = 160000`, and
an `index` line carrying the gitlink commit oid abbreviated to git's default 7 chars.
The block SHAPE is whatever the change kind already dictates in the serializer:

- **add** → a single `renderAddBlock`: `new file mode 160000` + `@@ -0,0 +1 @@` +
  `+Subproject commit <oid>`.
- **delete** → a single `renderDeleteBlock`: `deleted file mode 160000` + `@@ -1 +0,0 @@`
  + `-Subproject commit <oid>`.
- **modify** (gitlink→gitlink) → a single `renderModifyBlock` → `renderSameKindBlock`:
  `index <a>..<b> 160000` (the `modePreamble` equal-modes form) + `@@ -1 +1 @@` +
  `-Subproject commit <oid1>` / `+Subproject commit <oid2>`.
- **type-change** → the two-block `renderTypeChangeBlock` (delete block + add block),
  the gitlink side being one of those two blocks (its add OR delete half is byte-equal
  to the standalone gitlink add/delete pin).

The pure-add and pure-delete pins are **byte-identical** to the corresponding single
blocks of the already-pinned type-change two-block form (confirmed empirically — §
"Faithfulness baseline" — the only difference is the path name): a gitlink add IS the
new-file block of a `…→160000` type-change; a gitlink delete IS the deleted-file block
of a `160000→…` type-change. This is *why* one synthesis mechanism covers all kinds.

This is the pivotal observation: **the existing `renderAddBlock`/`renderDeleteBlock`/
`renderModifyBlock` already produce byte-perfect output for the gitlink side**, provided
they are handed the synthetic content `Subproject commit <oid>\n` as that side's bytes.
They read the mode from `change.*Mode` (already `160000`), the abbrev from
`shortOid(change.*Id)` (already the gitlink oid), and the body from
`splitContentLines(content)`. `splitContentLines` of `Subproject commit <oid>\n`
yields one line with `hasTrailingNewline = true` ⇒ `@@ -0,0 +1 @@` (add) / `@@ -1 +0,0 @@`
(delete) / `@@ -1 +1 @@` (modify) and a single `+`/`-` line with **no** no-newline marker
— exactly the pin. The serializer change is **zero**; the real work is **synthesizing
the gitlink-side content in the hydration primitive on whichever arm reads it**.

### Where the synthetic content is born — `materialiseOne` (primitive tier), per-side on every arm

The gitlink oid is a commit; `readBlob` cannot read it. The fix is **uniform and
change-kind-agnostic** (ADR-403/404): on **every arm** of `materialiseOne`, for each
side it would otherwise `readBlob`, check whether that side's mode is a gitlink
(`kindOf(mode) === 'gitlink'`) and, if so, **synthesize** that side's content as
`Subproject commit <oid>\n` (UTF-8 bytes) instead of reading a blob. Concretely, per arm:

| Arm | Reads today | Side(s) to guard | Synthesized when gitlink |
|---|---|---|---|
| `add` | `readBlob(change.newId)` → `newContent` | new side | `newContent = Subproject commit <newId>\n` |
| `delete` | `readBlob(change.oldId)` → `oldContent` | old side | `oldContent = Subproject commit <oldId>\n` |
| `modify` / `type-change` | `readBlob(oldId)` + `readBlob(newId)` (short-circuits when ids equal) | each side independently | gitlink side → `Subproject commit <oid>\n`; non-gitlink side → real blob |
| `rename` / `copy` | none (exact, `score === MAX_SCORE`) or both (inexact) | see § "rename/copy arm" | exact gitlink rename reads nothing; inexact gitlink rename is **unreachable** (git never produces one) |

This is a **per-side check applied to each arm**, NOT a per-kind special case — the
simplest, most uniform shape (ADR-404 § Consequences). A `TypeChangeChange` has at most
one gitlink side (the other is always a real blob, because two gitlink sides would be a
`modify`, not a type-change); a `modify` may have the gitlink on either or both sides
(a gitlink→gitlink bump has both); an `add`/`delete` has its single side gitlink.

This keeps the platform-free domain serializer ignorant of submodules: it just renders
bytes; the *meaning* of those bytes (a submodule pointer) is resolved in the application
tier — faithful to git's own architecture, where the synthetic line is produced by
submodule-aware diff code, not by the generic patch formatter.

The synthetic string is git's literal display form: the ASCII bytes
`Subproject commit ` + the 40-hex oid + `\n`. This is a **constant template**, the
only submodule-specific knowledge the primitive needs; it is the application-tier
analogue of git's `show_submodule_summary` "fast-path" one-line form.

### The rename/copy arm — can a gitlink ever be a rename/copy candidate?

This arm is the one that does NOT trivially fall out of the per-side guard, so it is
resolved here explicitly (not left ambiguous). **Empirically pinned** against real git
(§"Faithfulness baseline" R-pins) and reasoned from the detection code
(`detect-similarity-renames.ts`, `rename-detect.ts`):

- **Exact (same-oid) gitlink rename IS reachable and needs no guard.** git folds a
  gitlink moved between paths with the *same* commit oid as `R100` (pinned:
  `:160000 160000 <oid> <oid> R100 old new`). tsgit's `detectRenames`/`tryFoldAdd`
  folds same-oid add+delete into a `RenameChange` **mode-agnostically** (it keys on
  `add.newId === del.oldId`, never reading bytes), producing a rename with both modes
  `160000`. In `materialiseOne` this hits `change.similarity.score === MAX_SCORE` ⇒
  `return { change }` — **no `readBlob`, no body to synthesize** (`renderPatch` emits a
  header-only `rename from/to` block with `similarity index 100%`, no hunk). So the
  per-side guard is **not needed** on this path: it is already byte-safe.
- **Inexact (content-scored) gitlink rename/copy is UNREACHABLE — git never produces
  one.** Pinned: with `-M` and even `-C --find-copies-harder`, two gitlinks with
  *different* oids at old/new paths are reported as separate `A`/`D`, never `R`/`C`
  (git's diffcore-rename excludes `S_ISGITLINK` entries from the similarity matrix
  because a gitlink has no readable content to score). For tsgit to be faithful it must
  match this. Critically, an inexact gitlink rename can therefore never legitimately
  reach `materialiseOne`'s inexact arm: to score one, the **upstream**
  `detect-similarity-renames.ts` (`hydrateIds` → `readBlob`) would have to read the
  gitlink commit oid first and would throw `unexpectedObjectType` *before*
  `materialiseOne` runs.

**Determination:** the per-side gitlink guard on `materialiseOne`'s rename/copy arm is
**not required for faithfulness** — the exact arm reads nothing, and the inexact arm is
never reached with a gitlink. Adding a defensive guard there would be dead code (no test
could reach it without first constructing an inexact gitlink rename that git itself
never emits and tsgit's detection would reject upstream). The design therefore scopes the
synthesis to the `add` / `delete` / `modify` / `type-change` arms only and **does not**
touch the rename/copy arm. The separate latent question — that tsgit's *opt-in*
`detect-similarity-renames.ts` would throw if a gitlink ever entered its inexact matrix,
rather than faithfully excluding gitlinks like git does — is a **distinct, pre-existing
path** (rename detection defaults OFF; no current test combines `detectRenames` with a
gitlink) and is out of scope for this feature (§"Out of scope"; § Decision candidates
notes whether it warrants escalation).

### The serializer touch-point — no change (ADR-403 decision)

ADR-403 ratified the synthesis-in-primitive mechanism (Decision candidate D1/D2 below,
adopted-as-recommended). The two equally-faithful options were:

- **(A) No serializer change.** If `materialiseOne` puts `Subproject commit <oid>\n`
  on the gitlink side, the existing `renderAddBlock`/`renderDeleteBlock`/
  `renderModifyBlock` (and `renderTypeChangeBlock`'s composition of the first two)
  already render it byte-perfectly across all kinds (the mode and oid are already on
  the change; the body comes from the synthesized content). The serializer needs
  **zero** edits. This is the minimal-diff option.
- **(B) A dedicated `renderGitlinkBlock` in the serializer** that emits the synthetic
  line from the change's oid directly, without the primitive synthesizing content.
  This pushes submodule knowledge (`Subproject commit` template) INTO the domain
  serializer — a platform-free layer that should not know what a submodule is.
  Rejected on architecture grounds.

**ADR-403 adopted (A)**: the synthesis lives in the primitive (application tier, where
submodule semantics belong), and the domain serializer stays a pure bytes renderer. The
candidate is recorded under § Decision candidates as RATIFIED, not open.

### Why this is NOT a new rendering knob (ADR-249 nuance — stated explicitly)

ADR-249 forbids options whose only job is to steer rendered text. The
`Subproject commit <oid>` line is **not** such a knob:

- `renderPatch` is the library's ONE sanctioned patch-bytes producer. ADR-402 already
  renders type-change patch text there (the delete+add blocks). The gitlink body is
  the **completion** of that same faithful producer — the missing case ADR-402
  explicitly deferred, now across add/delete/modify/type-change — not a new option,
  flag, or format string. There is no `--submodule=<mode>`-style surface; the diff
  `command` still returns structured `TreeDiff` data only.
- The library still emits FIELDS: each change shape (`AddChange`, `DeleteChange`,
  `ModifyChange`, `TypeChangeChange`) carries the relevant `*Id`/`*Mode` (the gitlink
  oid and `160000`). The interop test reconstructs git's `Subproject commit` display
  FROM those fields (via `reconstructPatch`, the same `renderPatch` the library uses
  internally for rebase's `.git/rebase-merge/patch` and patch-id) — faithfulness is
  reconstructed from structured data, exactly as ADR-249 requires.

The doc states this distinction so a reviewer does not mistake the synthetic line for
a forbidden display knob.

### Blast radius — `patch-id`, `range-diff`, `rebase`

All three consume the domain `renderPatch` through the shared `materialisePatchFiles`
hydration:

| Consumer | File:symbol | Path | Impact |
|---|---|---|---|
| patch-id | `src/application/primitives/patch-id.ts:51` `computePatchId` (`:59` materialise, `:60` render) | `diffTrees(recursive) → materialisePatchFiles → renderPatch` | a commit that introduces/removes/bumps a gitlink (add/delete/modify) or type-changes one now hydrates + renders without throwing; the `Subproject commit` line SURVIVES `canonicalise` (`:37`, which strips only `@@ ` and `index ` lines then strips whitespace) — so two commits introducing the same submodule pointer collide, distinct ones don't. **No patch-id code change needed.** |
| rebase | `src/application/commands/rebase.ts:295` `renderCommitPatch` (`:301` materialise, `:304` render) | same shared path | a failed pick whose diff adds/removes/bumps or type-changes a gitlink renders `.git/rebase-merge/patch` faithfully instead of throwing. **No rebase code change needed.** |
| range-diff | `src/application/commands/range-diff.ts:67` `hydrate` (`:74` materialise) | `diffTrees → materialisePatchFiles → renderPatch` (diff-of-diffs) | composes transitively; the inner per-commit patch now renders the gitlink side for any kind. **No range-diff code change needed.** |

The blast-radius conclusion: once `materialiseOne` synthesizes the gitlink side on
every arm and `renderPatch` renders it (option A), **all three consumers are fixed
transitively** for every gitlink change kind by the single primitive change — none
needs its own source edit. The most common real-repo case a submodule consumer hits is
a gitlink **add** (introducing a submodule) and a gitlink↔gitlink **modify** (a pointer
bump) — both now flow through patch-id/rebase/range-diff faithfully where before they
threw. Whether each consumer needs its own *test* arm is a test-strategy question
(§"Test strategy"): patch-id stability across a submodule pointer change is the one
consumer-specific invariant worth an explicit unit pin, because canonicalisation
interacts with the synthetic line; rebase and range-diff are covered by the interop
arms + their existing suites.

### Edge behaviour pinned and handled

- **No `\ No newline` marker on the gitlink side.** The synthetic content ends in
  `\n`, so `splitContentLines` reports `hasTrailingNewline = true` and the marker is
  omitted — matching every pin (the ADD/DELETE/MODIFY and D1/D2 gitlink bodies have no
  marker; the symlink side in D3/D4 DOES, because a symlink target blob has no trailing
  newline).
- **Abbrev = git default 7.** The `index` line uses `shortOid` (7 chars), which is
  git's default. `--abbrev=<n>` / `--full-index` are rendering knobs (ADR-249) and are
  out of scope; default-7 is the only faithful target. (Pinned: `--abbrev=12` and
  `--full-index` change the gitlink abbrev exactly as they change a blob abbrev, so no
  gitlink-specific abbrev logic exists.)
- **Per-kind side multiplicity.** A `TypeChangeChange` has **at most one** gitlink side
  (`kindOf(160000) == kindOf(160000)` ⇒ `isSameKind` ⇒ a `modify`, never a
  `type-change`; the other side is always a real file/symlink blob). A `ModifyChange`
  **may have both** sides gitlink (a gitlink→gitlink pointer bump — the common case) or,
  in principle, neither/one (but a one-gitlink-side change of differing kinds is a
  type-change, so a modify with a gitlink has it on BOTH sides). An `AddChange` /
  `DeleteChange` has exactly its single side gitlink. The synthesis being
  **per-side-conditional** handles all of these uniformly: each side is checked and
  synthesized or read independently — no arm needs to know how many gitlink sides it has.
- **Mode/oid come from the change, content from synthesis.** The block header
  (`new file mode 160000` / `deleted file mode 160000` / `index <a>..<b> 160000`) and the
  `index` abbrev derive from `change.*Mode`/`*Id` already on the structured change —
  the synthesis supplies ONLY the body bytes. This is why option (A) needs no
  serializer edit for any kind.
- **The synthetic content takes the TEXT path, never "Binary files differ".**
  `renderAddBlock`/`renderDeleteBlock`/`renderSameKindBlock`/`renderTypeChangeBlock`
  branch each side on `isBinary` (`src/domain/diff/line-diff.ts:75` =
  `hasNulInWindow || exceedsLineCaps`). The synthetic `Subproject commit <oid>\n` is
  ~60 ASCII bytes, one short line, no NUL ⇒ `isBinary` returns false ⇒ the text path
  renders the `Subproject commit` body — matching every pin (none shows a binary line).
  This is a guaranteed property of the fixed template, not an input-dependent risk.

## Faithfulness baseline (empirical pin matrix)

Real `git version 2.54.0`, scrubbed `GIT_*`, `GIT_CONFIG_NOSYSTEM=1`, isolated
`HOME`, signing off, throwaway `mktemp -d` repo, `git diff --no-ext-diff --no-color`.
Gitlinks built via `git update-index --add --cacheinfo 160000,<oid>,<path>` (no real
submodule needed; the oid is arbitrary 40-hex `111…1` / `222…2`). The pure add/delete
fixtures use an empty base commit + `commit-tree` so the gitlink path is absent on one
side. Bytes captured via a Python `repr` dump (exact trailing newlines and
`\ No newline` markers preserved).

The matrix spans **all four reachable gitlink change kinds** — add (A1), delete (DEL1),
modify (M, gitlink↔gitlink pointer bump), and type-change (D1–D4, the two-block
delete+add form, same as ADR-402 file↔symlink) — plus the rename/copy R-pins (R1/R2)
that establish the rename/copy determination (§ Design § "rename/copy arm").

### A1 — pure gitlink ADD (path absent → `160000`), path `sub`

```
diff --git a/sub b/sub
new file mode 160000
index 0000000..1111111
--- /dev/null
+++ b/sub
@@ -0,0 +1 @@
+Subproject commit 1111111111111111111111111111111111111111
```

`repr`: `b'diff --git a/sub b/sub\nnew file mode 160000\nindex 0000000..1111111\n--- /dev/null\n+++ b/sub\n@@ -0,0 +1 @@\n+Subproject commit 1111111111111111111111111111111111111111\n'`
— a SINGLE add block, body newline-terminated, **no** `\ No newline` marker.
`git diff --name-status` → `A\tsub`; `git diff-tree -r --raw` →
`:000000 160000 000…0 111…1 A\tsub`.

**Byte-equality confirmation (Requirement 1):** the A1 block is byte-identical to D1's
*new-file (add) block* (lines `new file mode 160000` … `+Subproject commit …`) modulo the
path name (`sub` vs `fg`). A pure gitlink add IS the add half of a `…→160000`
type-change. Confirmed by direct comparison of the two `repr` dumps — not assumed.

### DEL1 — pure gitlink DELETE (`160000` → absent), path `sub`

```
diff --git a/sub b/sub
deleted file mode 160000
index 1111111..0000000
--- a/sub
+++ /dev/null
@@ -1 +0,0 @@
-Subproject commit 1111111111111111111111111111111111111111
```

`repr`: `b'diff --git a/sub b/sub\ndeleted file mode 160000\nindex 1111111..0000000\n--- a/sub\n+++ /dev/null\n@@ -1 +0,0 @@\n-Subproject commit 1111111111111111111111111111111111111111\n'`
— a SINGLE delete block, body newline-terminated, **no** marker.
`git diff --name-status` → `D\tsub`; `git diff-tree -r --raw` →
`:160000 000000 111…1 000…0 D\tsub`.

**Byte-equality confirmation (Requirement 1):** the DEL1 block is byte-identical to D2's
*deleted-file (delete) block* (lines `deleted file mode 160000` … `-Subproject commit …`)
modulo the path name (`sub` vs `gf`). A pure gitlink delete IS the delete half of a
`160000→…` type-change. Confirmed by direct comparison of the two `repr` dumps.

### Type-change directions (the two-block delete+add form)

### D1 — file → gitlink (`100644` → `160000`), path `fg`

```
diff --git a/fg b/fg
deleted file mode 100644
index 00cb5bc..0000000
--- a/fg
+++ /dev/null
@@ -1 +0,0 @@
-regular content
diff --git a/fg b/fg
new file mode 160000
index 0000000..1111111
--- /dev/null
+++ b/fg
@@ -0,0 +1 @@
+Subproject commit 1111111111111111111111111111111111111111
```

### D2 — gitlink → file (`160000` → `100644`), path `gf`

```
diff --git a/gf b/gf
deleted file mode 160000
index 1111111..0000000
--- a/gf
+++ /dev/null
@@ -1 +0,0 @@
-Subproject commit 1111111111111111111111111111111111111111
diff --git a/gf b/gf
new file mode 100644
index 0000000..00cb5bc
--- /dev/null
+++ b/gf
@@ -0,0 +1 @@
+regular content
```

### D3 — symlink → gitlink (`120000` → `160000`), path `sg`

```
diff --git a/sg b/sg
deleted file mode 120000
index 1de5659..0000000
--- a/sg
+++ /dev/null
@@ -1 +0,0 @@
-target
\ No newline at end of file
diff --git a/sg b/sg
new file mode 160000
index 0000000..1111111
--- /dev/null
+++ b/sg
@@ -0,0 +1 @@
+Subproject commit 1111111111111111111111111111111111111111
```

### D4 — gitlink → symlink (`160000` → `120000`), path `gs`

```
diff --git a/gs b/gs
deleted file mode 160000
index 1111111..0000000
--- a/gs
+++ /dev/null
@@ -1 +0,0 @@
-Subproject commit 1111111111111111111111111111111111111111
diff --git a/gs b/gs
new file mode 120000
index 0000000..1de5659
--- /dev/null
+++ b/gs
@@ -0,0 +1 @@
+target
\ No newline at end of file
```

### Per-component matrix (extracted from all pins)

| Component | gitlink-side value | Derivation in tsgit |
|---|---|---|
| `diff --git` header | `diff --git a/<p> b/<p>` (same path) | existing `diffGitHeader` |
| add-block mode line | `new file mode 160000` | `renderAddBlock` from `change.newMode` |
| delete-block mode line | `deleted file mode 160000` | `renderDeleteBlock` from `change.oldMode` |
| modify index line (both sides gitlink) | `index <a7>..<b7> 160000` | `modePreamble` equal-modes form |
| add `index` line | `index 0000000..<gitlink7>` (`0000000..1111111`) | `shortOid(change.newId)` (default abbrev 7) |
| delete `index` line | `index <gitlink7>..0000000` (`1111111..0000000`) | `shortOid(change.oldId)` |
| body hunk header (add) | `@@ -0,0 +1 @@` | `formatHunkHeader(0,0,1,1)` |
| body hunk header (delete) | `@@ -1 +0,0 @@` | `formatHunkHeader(1,1,0,0)` |
| body hunk header (modify) | `@@ -1 +1 @@` | one-line ↔ one-line hunk |
| body line | `+`/`-Subproject commit <40-hex>` | synthesized content `Subproject commit <oid>\n` |
| no-newline marker | **ABSENT** on every gitlink side | synthesized content ends in `\n` ⇒ `hasTrailingNewline = true` |
| `\ No newline` marker on the OTHER side (type-change) | present iff that side's blob has no trailing `\n` (symlink target: yes; `regular content\n`: no) | existing `splitContentLines` |

### M — MODIFY pin (gitlink → gitlink pointer bump — IN SCOPE per ADR-404)

A pure submodule pointer bump (`160000`→`160000`, different oids) is a `modify`, and
git renders it as a SINGLE block with a `-1/+1` hunk:

```
diff --git a/sm b/sm
index 1111111..2222222 160000
--- a/sm
+++ b/sm
@@ -1 +1 @@
-Subproject commit 1111111111111111111111111111111111111111
+Subproject commit 2222222222222222222222222222222222222222
```

`git diff --name-status` → `M\tsm`; `git diff-tree -r --raw` →
`:160000 160000 111…1 222…2 M\tsm`. This flows through tsgit's `renderModifyBlock` →
`renderSameKindBlock` → `modePreamble` (which emits `index <a>..<b> 160000` for equal
modes — exactly the pin). The blocker was that `materialiseOne`'s both-sides arm calls
`readBlob` on BOTH gitlink oids and throws — the **same** failure as the type-change.
The per-side synthesis (synthesize `Subproject commit <oid>\n` for any gitlink-mode side)
fixes it: here both sides are gitlink, so both are synthesized and the non-gitlink
`readBlob` is never reached. **ADR-404 brings this into scope** (it is the second-most
common submodule diff after add).

### R-pins — rename/copy determination (gitlink as rename/copy candidate)

These pins establish the § Design § "rename/copy arm" determination — they record what
git does, NOT bytes tsgit must render (tsgit must MATCH git's classification):

- **R1 — same-oid gitlink rename IS detected (exact, no content read).** A gitlink with
  the *same* commit oid moved `old`→`new`, `git diff -M`:
  ```
  diff --git a/old b/new
  similarity index 100%
  rename from old
  rename to new
  ```
  `--name-status -M` → `R100\told\tnew`; `diff-tree -r -M --raw` →
  `:160000 160000 111…1 111…1 R100\told\tnew`. (Header-only — no `Subproject commit`
  body, because an exact rename emits no hunk.)
- **R2 — different-oid gitlinks are NOT detected as rename/copy.** With `-M` *and*
  `-C --find-copies-harder`, two gitlinks of *different* oids at `old`/`new2` stay
  `A\tnew2` / `D\told` — git's diffcore-rename excludes `S_ISGITLINK` from the
  content-similarity matrix. There is no inexact gitlink rename for tsgit to render or
  for `materialiseOne` to hydrate.

## Decision candidates

**All load-bearing candidates this feature raised are now RATIFIED** — no open decision
remains for the ADR phase. ADRs 226/249 fix faithfulness and the structured-data rule;
ADR-399 fixed the structural gitlink pins; ADR-402 fixed the file↔symlink patch form and
deferred the gitlink side. **[ADR-403](../adr/403-synthesize-gitlink-subproject-line-in-materialise.md)
ratified the synthesis MECHANISM** (D1/D2/D5 below — adopted-as-recommended) and
**[ADR-404](../adr/404-gitlink-patch-rendering-all-diff-kinds.md) ratified the
ALL-KINDS scope** (D3 — user-ratified, widening type-change-only to add/delete/modify/
type-change). The table is retained as the rationale record; the "Status" column marks
each as settled.

| # | Choice | Status | Settled outcome + why |
|---|---|---|---|
| **D1** | How `materialiseOne` represents a gitlink side | **RATIFIED — ADR-403** | (a) synthesize the side's content as the literal bytes `Subproject commit <oid>\n` (no marker on `PatchFile`/`DiffChange`). Keeps the domain serializer a pure bytes renderer, needs ZERO serializer change (D2), minimal diff. Alternatives (b) `{ gitlink, oid }` marker on `PatchFile` / (c) oid+`kind` enum on `PatchFile` were rejected — both push submodule semantics into the platform-free domain. |
| **D2** | Where the `Subproject commit <oid>` line is produced in the serializer | **RATIFIED — ADR-403** | (a) NOWHERE new — `renderAddBlock`/`renderDeleteBlock`/`renderModifyBlock` already render it from D1's synthesized content across all kinds. Alternatives (b) a `renderGitlinkBlock` / (c) a gitlink-flag parameter were rejected — both leak the `Subproject commit` template into the domain. |
| **D3** | Which gitlink change kinds are in scope | **RATIFIED — ADR-404 (user)** | **ALL FOUR** — add, delete, modify, type-change. The synthesis fix is per-side and identical across kinds; `materialiseOne` calls `readBlob` on every arm, so the commit-oid throw hits a pure gitlink add (the most common submodule diff) and delete just as it hits modify/type-change. Type-change-only (the literal brief) and type-change+modify were rejected — both ship a primitive that still crashes on introducing a submodule. (Supersedes the previous draft's "modify only if D3 ratifies" recommendation, which is now folded into this all-kinds outcome.) |
| **D4** | Where the gitlink PATCH pins live, and which arms | **RATIFIED — ADR-404 (with D3)** | (a) extend `test/integration/diff-type-change-interop.test.ts` with `reconstructPatch` arms for the four type-change directions **plus new ADD / DELETE / gitlink↔gitlink MODIFY arms**, + domain unit pins in `patch-serializer.test.ts` and primitive pins in `materialise-patch-files.test.ts`. The interop file already builds the gitlink directions and wires `reconstructPatch`; the cheap mutation-resistant guard is the domain/primitive unit pin. Interop-only / unit-only were rejected (no fast unit guard / no live-git cross-check). |
| **D5** | The exact synthetic content template | **RATIFIED — ADR-403** | (a) `Subproject commit <40-hex>\n` (the literal git fast-path form, pinned) as a single named constant in the primitive. Parameterising the format / reusing git's verbose `--submodule=log` summary were rejected (invented flexibility / a different opt-in rendering, out of scope). |

**No NEW open decision candidate surfaced** during this revision's code exploration.
One adjacent observation was evaluated and deliberately NOT escalated as a candidate
(see § Out of scope): tsgit's *opt-in* `detect-similarity-renames.ts` would throw if a
gitlink ever entered its inexact-rename matrix, rather than faithfully excluding gitlinks
the way git's diffcore-rename does (R2 pin). This is a **pre-existing, separate latent
path** outside this feature's `materialiseOne`+`renderPatch` surface — rename detection
defaults OFF, no current test combines it with a gitlink, and git's own exclusion means
the correct fix is a faithfulness pin on the *detection* primitive, not a decision this
feature must make. It is recorded as a follow-up note, not a load-bearing choice for the
ADR conversation.

## Test strategy

**Interop — extend `test/integration/diff-type-change-interop.test.ts`** (the
existing file already builds the four gitlink type-change directions via
`--cacheinfo 160000`, imports `reconstructPatch` from `./diff-reconstruct`, and pins
`--raw`/`--name-status` `T` for them; the file↔symlink arms already have the
`reconstructPatch` arm — the gitlink directions do NOT). Add, per the existing
GWT/AAA/`sut` conventions:

- **Type-change (the four existing directions).** For each of file→gitlink,
  gitlink→file, symlink→gitlink, gitlink→symlink: a `Then reconstructPatch emits
  delete+add blocks matching git diff patch bytes` arm — `diff(ctx, {from, to})` →
  `reconstructPatch(ctx, treeDiff)` → `expect(result).toBe(peer)` where
  `peer = gitDiff(dir, from, to)`. Mirrors the existing file↔symlink arms, pinned
  against LIVE git plus the §"Faithfulness baseline" D1–D4 goldens.
- **Pure gitlink ADD (new — A1 pin).** A commit pair `<empty/absent>` → `160000` at a
  path: a `reconstructPatch` arm pinning the single `new file mode 160000` block +
  `+Subproject commit <oid>` (A1), plus `--name-status A` / `--raw A` structural arms.
  Built via an empty base commit + `update-index --cacheinfo` (the existing
  `doCommit` helper supports this — no real submodule needed).
- **Pure gitlink DELETE (new — DEL1 pin).** The reverse commit pair `160000` →
  `<absent>`: a `reconstructPatch` arm pinning the single `deleted file mode 160000`
  block + `-Subproject commit <oid>` (DEL1), plus `--name-status D` / `--raw D`.
- **gitlink↔gitlink MODIFY (new — M pin, in scope per ADR-404).** A commit pair
  `160000` oid1 → `160000` oid2 at one path: a `reconstructPatch` arm pinning the
  single-block `index <a>..<b> 160000` + `-1/+1 Subproject commit` form (M), plus
  `--name-status M` / `--raw M`.
- The existing `--raw`/`--name-status` `T` arms for the gitlink type-change directions
  stay **unchanged** (regression guard that ADR-399's structural pins still pass); the
  new `A`/`D`/`M` structural arms extend that same guard set.

**Unit — `test/unit/domain/diff/patch-serializer.test.ts`** (the cheap
mutation-resistant guard; the file already has file↔symlink and binary type-change
patch tests at lines 639–745). Add blocks for each gitlink kind: `Given an add of a
gitlink`, `Given a delete of a gitlink`, `Given a gitlink→gitlink modify`, and the
four type-change directions (`Given a type change from regular to gitlink` and
symmetric / symlink↔gitlink). Each constructs a `PatchFile` whose gitlink side carries
the synthesized content `Subproject commit <oid>\n` and asserts `renderPatch([file])`
equals the exact bytes from the §"Faithfulness baseline" matrix (A1 / DEL1 / M /
D1–D4). Isolated, specific assertions (full byte string, not a substring) — the
`Subproject commit ` template, the `160000` mode, the 7-char gitlink abbrev, the
`-1/+1` modify hunk header, and the ABSENCE of the no-newline marker on every gitlink
side are the StringLiteral/Conditional mutation hot spots; assert each exact line.

**Unit — `test/unit/application/primitives/materialise-patch-files.test.ts`** (the
synthesis is the new code; the file already has a `Given a type-change change`
block at line 180). Add a `Given a <kind> with a gitlink side` block per arm — `add`
(new side gitlink), `delete` (old side gitlink), `modify` gitlink↔gitlink (both sides
gitlink), and `type-change` (gitlink-as-old / gitlink-as-new) — asserting
`materialiseOne` returns each gitlink side's content as `Subproject commit <oid>\n`
(UTF-8) and any non-gitlink side as the real blob, and that NO `readBlob` is attempted
on the gitlink oid (a commit that, if read, would throw `unexpectedObjectType`).
Isolated guard tests: one per arm AND, for modify/type-change, one per side
(gitlink-as-old vs gitlink-as-new) — the per-arm and per-side `kindOf(...) === 'gitlink'`
checks are separate Conditional mutation targets, one test per branch. Include a
`Given an exact same-oid gitlink rename` case asserting the rename/copy arm
short-circuits (`score === MAX_SCORE` ⇒ `{ change }`, no `readBlob`, no synthesis) — the
§ "rename/copy arm" determination's positive half.

**Unit — `test/unit/application/primitives/patch-id.test.ts`** (blast-radius pin for
the one consumer-specific invariant). Add a guard that two commits introducing the
SAME submodule pointer (same path, same gitlink oid, same kind) yield the SAME
patch-id, and that a different gitlink oid yields a DIFFERENT patch-id — proving the
`Subproject commit` line survives `canonicalise` (it is not `@@ `/`index `-prefixed)
and participates in the equivalence key. Exercise it on a gitlink **add** (the common
case) and/or a gitlink↔gitlink **modify**; rebase and range-diff are covered
transitively by the interop arms + their existing suites (no consumer-specific
invariant beyond "doesn't throw, renders faithfully", which the shared path proves).

**Property tests:** not applicable. This is not a parse/serialize round-trip, a
compositional matcher, a total function over a grammar, nor an idempotence/counting
invariant (per CLAUDE.md's four lenses). The synthesis is a single template
substitution and the serializer change is a fixed-shape block; parameterised example
tests over the kinds × directions are the clearer guard. No `*.properties.test.ts`
sibling.

**Faithfulness procedure for all interop:** `describe.skipIf(!GIT_AVAILABLE)`, one
shared `beforeAll` repo + 60s timeout (per the interop load→validate flake note),
scrubbed `GIT_*`, isolated `HOME`, `GIT_CONFIG_NOSYSTEM=1`, signing off, `--no-ext-diff`
— all already in place in the existing file.

## Out of scope

- **Real submodule content / `git diff --submodule=log` (verbose) rendering** — git
  has an opt-in `--submodule=<log|short|diff>` family that renders a submodule's commit
  log or a recursive diff. This feature pins ONLY the default one-line
  `Subproject commit <oid>` form (`--submodule=short`, git's default). The verbose
  forms need real submodule traversal tsgit does not have — a separate, larger feature.
- **An `--abbrev=<n>` / `--full-index` knob for the gitlink index line** — those are
  rendering knobs (ADR-249) with no structured surface; default-7 (`shortOid`) is the
  only faithful target and the library ships oids as fields.
- **Submodule status / `git submodule` porcelain** — unrelated; this is purely the
  diff PATCH rendering of a gitlink-mode entry.
- **Changing structured diff emission (`add`/`delete`/`modify`/`type-change`)** — the
  domain already emits all four kinds faithfully on every surface (ADR-399 et al.); no
  `tree-diff.ts`/`index-diff.ts`/`status.ts` change. This feature touches only the
  patch-RENDER and the hydration primitive.
- **Inexact rename/copy detection over gitlinks** (`detect-similarity-renames.ts`). git
  excludes `S_ISGITLINK` from its similarity matrix (R2 pin); tsgit's opt-in rename
  detection does not yet, so if a gitlink ever entered the inexact matrix it would throw
  on the commit-oid `readBlob` instead of faithfully leaving the gitlink as `A`/`D`. That
  path is **outside this feature's `materialiseOne`+`renderPatch` surface**: rename
  detection defaults OFF, no current test combines it with a gitlink, and the exact
  same-oid rename (R1) — the only gitlink rename git produces — already flows correctly
  (no `readBlob`, no synthesis). Recorded as a **follow-up**: a faithfulness pin +
  gitlink-exclusion on the detection primitive, a distinct change from this one.
- **NOT out of scope (now IN scope, ADR-404):** gitlink **add**, gitlink **delete**, and
  gitlink↔gitlink **modify** patch rendering — all three are covered by the per-side
  synthesis alongside type-change. (The previous draft listed modify as conditional and
  did not list add/delete; ADRs 403–404 fold all of them in.)

