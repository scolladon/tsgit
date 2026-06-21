# ADR-402: render a type-change patch as delete + add blocks (file↔symlink)

## Status

Accepted

- **Date:** 2026-06-21
- **Design:** [design/diff-faithfulness-odds-ends.md](../design/diff-faithfulness-odds-ends.md) §2
- **Refines:** [ADR-226](226-git-faithfulness-prime-directive.md) (git-faithfulness), [ADR-249](249-describe-structured-data-only.md) (structured output)
- **Relates to:** [ADR-399](399-type-change-already-faithful-pin-only.md) (type-change structural emission is faithful)

## Context

The Part 2 audit ([ADR-399](399-type-change-already-faithful-pin-only.md)) confirmed
tsgit emits the `type-change` **structured** datum faithfully on every surface, and
concluded Part 2 was pin-only. That audit checked the structured emission and the
`--raw`/`--name-status` reconstruction — it did **not** check **patch** rendering.

Adding the type-change interop pin (the `reconstructPatch` arm) exposed a real
divergence. `src/domain/diff/patch-serializer.ts` rendered a type-change through the
same path as a `modify` (`renderModifyOrTypeChangeBlock` → `renderSameKindBlock` →
`modePreamble`), producing a single `diff --git` block with `old mode <o>` /
`new mode <n>` headers and a content hunk.

Real git (verified, git 2.54.0, mktemp throwaway) renders a type-change as **two**
`diff --git` blocks at the same path:

```
diff --git a/f b/f
deleted file mode 100644
index <old>..0000000
--- a/f
+++ /dev/null
@@ -1,2 +0,0 @@
-<old content>
diff --git a/f b/f
new file mode 120000
index 0000000..<new>
--- /dev/null
+++ b/f
@@ -0,0 +1 @@
+<new content>
```

(The `old mode` / `new mode` single-block form is git's rendering for a pure **mode**
change — same kind, e.g. `100644`→`100755` — not a type change.)

A pre-existing unit test (`patch-serializer.test.ts`, the `type-change` case) had
pinned the **wrong** single-block output — it asserted tsgit's internal rendering
without a real-`git` cross-check, which is how the divergence went unnoticed. The
interop pin (which compares to live `git`) caught it.

## Decision

Render a `type-change` patch block as a **delete block** (old path/mode/id + old
content as a full deletion) immediately followed by an **add block** (new
path/mode/id + new content as a full addition), reusing the existing
`renderDeleteBlock`/`renderAddBlock` (and their binary variants) — exactly git's
two-block form. Type-change is split out of `renderModifyOrTypeChangeBlock`; the
`modify` path is unchanged.

Correct the pre-existing unit test to the two-block git output, and re-add the
`reconstructPatch` type-change pins (file↔symlink, both directions) to the interop
suite so the patch bytes are pinned against live `git`, not against tsgit's own prior
(wrong) output.

**Scope boundary — gitlink/submodule side is OUT of scope.** git renders the gitlink
side of a type-change as a synthetic `+Subproject commit <40-hex>` line (submodule
diff rendering), because a gitlink has no blob to read. Reproducing that is submodule
patch rendering — a separate, larger feature (tsgit has no submodule-diff content
synthesis). This fix covers type-changes whose **both** sides are real blobs
(file/symlink); gitlink-involved type-changes keep their **structural** pins
(`--raw`/`--name-status` `T`) from [ADR-399](399-type-change-already-faithful-pin-only.md)
and are NOT pinned at the patch-bytes level here.

## Consequences

### Positive

- Type-change patches are byte-faithful to git across every patch-rendering surface
  (`diff`, `show`, `log -p`, `format-patch`, and patch-id-derived consumers) — a
  strictly-positive correction, since all of them emitted the wrong block before.
- The interop pin now guards the patch bytes against live git, closing the gap that
  let a non-faithful unit assertion stand.

### Negative

- A wider blast radius than the planned pin-only Part 2: the shared serializer changes
  and any consumer that produced the old type-change patch (incl. patch-id) shifts to
  the faithful form. Accepted — it is the prime directive applied at its natural
  touch-point.

### Neutral

- Gitlink type-change patch rendering (`Subproject commit`) remains unimplemented and
  unpinned at the patch level; its structural faithfulness is unchanged.
