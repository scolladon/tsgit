# Design — gitlink/submodule type-change PATCH rendering ("Subproject commit")

> Brief: make tsgit render the PATCH of a type-change whose one side is a gitlink
> (mode `160000`) byte-faithfully to real git. git renders the gitlink side as the
> synthetic submodule line `Subproject commit <40-hex-oid>` (no blob hunk), because
> a gitlink oid is a COMMIT, not a blob. This LIFTS the scope boundary
> [ADR-402](../adr/402-type-change-patch-render-delete-add.md) explicitly deferred.
> Status: draft → self-reviewed ×3 → accepted

## Context

[ADR-402](../adr/402-type-change-patch-render-delete-add.md) made **file↔symlink**
type-change patches byte-faithful to git: git renders a type-change as **two**
`diff --git` blocks at the same path — a full `deleted file mode <old>` block for
the old kind followed by a full `new file mode <new>` block for the new kind — and
tsgit now composes `renderDeleteBlock` + `renderAddBlock`
(`src/domain/diff/patch-serializer.ts:588` `renderTypeChangeBlock`) to match.

ADR-402 drew a **scope boundary** (its "gitlink/submodule side OUT scope" section):
the gitlink side of a type-change was deferred because tsgit has no submodule-content
synthesis. The hydration primitive `materialiseOne`
(`src/application/primitives/materialise-patch-files.ts:20`) calls `readBlob`
(`src/application/primitives/read-blob.ts:7`) on both sides of a type-change, and a
gitlink oid is a **commit**, so `readBlob` throws
`unexpectedObjectType('blob', 'commit', id)`. The deferred boundary is documented in
[design/diff-faithfulness-odds-ends.md](./diff-faithfulness-odds-ends.md) §2.5 ("The
gitlink side renders as git's synthetic `Subproject commit <oid>` … OUT of scope") and
§5 ("Reproducing submodule patch rendering — a separate, larger feature").

This feature lifts **exactly** that boundary, and only that boundary. The
**structural** gitlink pins from [ADR-399](../adr/399-type-change-already-faithful-pin-only.md)
— `--raw`/`--name-status` `T` lines for all three leaf-kind pairs, both directions —
already exist in `test/integration/diff-type-change-interop.test.ts` and **must keep
passing unchanged**; this design adds the PATCH-byte faithfulness arm on top of them.

Subsystems this touches:

| Subsystem | File:symbol | Role here |
|---|---|---|
| patch serializer (domain) | `src/domain/diff/patch-serializer.ts` `renderTypeChangeBlock` (`:588`), `renderDeleteBlock` (`:400`), `renderAddBlock` (`:381`), `renderFile` (`:732`), `renderPatch` (`:789`), `splitContentLines` (`:87`), `shortOid` (`:103`) | the library's ONE sanctioned patch-bytes producer (ADR-402); composes the two blocks |
| blob hydration (primitive) | `src/application/primitives/materialise-patch-files.ts` `materialiseOne` (`:20`) | hydrates both sides of a type-change via `readBlob`; the gitlink side must NOT read a blob |
| diff change shape (domain) | `src/domain/diff/diff-change.ts` `TypeChangeChange` (`:42`) | already carries `oldId`/`newId`/`oldMode`/`newMode`; the gitlink oid is already present |
| mode kind (domain) | `src/domain/diff/mode-kind.ts` `kindOf` (`:6`) | `gitlink = 160000` (`FILE_MODE.GITLINK`, `src/domain/objects/file-mode.ts:8`) |
| interop pins | `test/integration/diff-type-change-interop.test.ts` | already builds all four gitlink directions via `--cacheinfo 160000`; has `--raw`/`--name-status` arms but NO `reconstructPatch` arm for them |

Cross-cutting constraints (tsgit prime directives — non-negotiable):

| Source | Binding constraint on this design |
|---|---|
| [ADR-226](../adr/226-git-faithfulness-prime-directive.md) / CLAUDE.md (git-faithfulness) | Replicate git's observable DATA + patch bytes byte-for-byte. Pinned against real `git 2.54.0`, scrubbed `GIT_*`, `GIT_CONFIG_NOSYSTEM=1`, signing off, isolated `HOME`, throwaway `mktemp -d` repo, `--no-ext-diff` on every scripted `git diff`. Each pinned behaviour becomes a cross-tool interop test in `test/integration/*-interop.test.ts`. |
| [ADR-249](../adr/249-describe-structured-data-only.md) (structured-data-only) | The library returns FIELDS, never rendered text. The `Subproject commit <oid>` line is git's DISPLAY, reconstructed FROM the structured `TreeDiff` fields inside the interop test. **Nuance (§ Design):** `renderPatch` is the ONE sanctioned patch-bytes producer (ADR-402 already renders patch text there); the synthetic line belongs in it exactly as the delete/add blocks do — completing an existing faithful producer, NOT a new rendering knob. |
| CLAUDE.md (architecture) | Hexagonal: `repository → commands → primitives → domain`. Domain stays platform-free; `materialise-patch-files` is a primitive (application tier) and may not leak into the domain. Object Calisthenics, branded types, FP-first, immutable. |
| Sibling design docs | Format/depth follows `docs/design/diff-faithfulness-odds-ends.md` and `docs/design/whitespace-diff-options.md`. |

The empirical pins below were all run in `mktemp -d` throwaways with the faithfulness
procedure (`.claude/workflow/faithfulness.md`); none touched the worktree's `.git`.

## Requirements

What must be true when this ships:

1. `renderPatch` emits byte-faithful patch text for a type-change whose **one** side
   is a gitlink, for all four reachable directions: file→gitlink (`100644`→`160000`),
   gitlink→file (`160000`→`100644`), symlink→gitlink (`120000`→`160000`),
   gitlink→symlink (`160000`→`120000`) — matching the §"Faithfulness baseline" matrix.
2. The gitlink side renders as a normal delete/add block whose body is the single
   line `Subproject commit <40-hex-oid>` with a **trailing newline** (no
   `\ No newline at end of file` marker), `<mode> = 160000`, and
   `index <gitlink-oid-7-prefix>..0000000` (delete) / `index 0000000..<7-prefix>`
   (add).
3. `materialiseOne` carries a gitlink side through WITHOUT a `readBlob` call — the
   gitlink oid is already on the `TypeChangeChange`; no commit object is read.
4. The non-gitlink side of each type-change keeps its existing faithful rendering
   (real blob content; symlink side keeps its `\ No newline` marker per the pin).
5. The structural gitlink pins from ADR-399 (`--raw`/`--name-status` `T`) keep
   passing **unchanged** — this is purely additive.
6. Blast-radius consumers (`patch-id`, `range-diff`, `rebase`) compose a gitlink
   type-change patch correctly through the shared `materialisePatchFiles` →
   `renderPatch` path; patch-id stays stable (the `Subproject commit` line survives
   canonicalisation; §"Blast radius").
7. No new rendering knob is added (ADR-249); the synthetic line is produced inside
   the existing `renderPatch`, and the interop test reconstructs git's display from
   the structured fields.
8. Domain stays platform-free; the gitlink-content synthesis lives in the
   application-tier primitive, not the domain serializer.

## Design

### The shape of git's gitlink type-change patch (the load-bearing fact)

The PIN (§"Faithfulness baseline") shows git renders a gitlink type-change as the
**same two-block delete+add form** ADR-402 already established for file↔symlink —
NOT a combined block. The *only* difference from a file↔symlink type-change is what
appears on the gitlink side:

- the block header carries `<mode> = 160000` (already the change's `oldMode`/`newMode`);
- the `index` line carries the **gitlink commit oid** abbreviated to git's default
  7 chars (already `shortOid(change.oldId/newId)`);
- the body is a single line `Subproject commit <40-hex-oid>`, **newline-terminated**
  (no `\ No newline` marker — the synthetic content is treated as `…<oid>\n`).

This is the pivotal observation: **the existing `renderDeleteBlock`/`renderAddBlock`
already produce byte-perfect output for the gitlink side**, provided they are handed
the synthetic content `Subproject commit <oid>\n` as that side's bytes. They read the
mode from `change.oldMode`/`change.newMode` (already `160000`), the abbrev from
`shortOid(change.oldId/newId)` (already the gitlink oid), and the body from
`splitContentLines(content)`. `splitContentLines` of `Subproject commit <oid>\n`
yields one line with `hasTrailingNewline = true` ⇒ `@@ -1 +0,0 @@` / `@@ -0,0 +1 @@`
and a single `-`/`+` line with **no** no-newline marker — exactly the pin. The
serializer change, if any, is therefore minimal; the real work is **synthesizing the
gitlink-side content in the hydration primitive**.

### Where the synthetic content is born — `materialiseOne` (primitive tier)

The gitlink oid is a commit; `readBlob` cannot read it. `materialiseOne` must detect a
gitlink side (`kindOf(change.oldMode) === 'gitlink'` / `kindOf(change.newMode) ===
'gitlink'`) and, instead of `readBlob`, **synthesize** that side's `PatchFile`
content as `Subproject commit <oid>\n` (UTF-8 bytes). The other side is hydrated as
today (`readBlob` for a file/symlink side). This keeps the platform-free domain
serializer ignorant of submodules: it just renders bytes; the *meaning* of those
bytes (a submodule pointer) is resolved in the application tier — faithful to git's
own architecture, where the synthetic line is produced by submodule-aware diff code,
not by the generic patch formatter.

The synthetic string is git's literal display form: the ASCII bytes
`Subproject commit ` + the 40-hex oid + `\n`. This is a **constant template**, the
only submodule-specific knowledge the primitive needs; it is the application-tier
analogue of git's `show_submodule_summary` "fast-path" one-line form.

`gitlink→gitlink` MODIFY (a pure submodule pointer bump, NOT a type-change) flows
through the *same* `materialiseOne` both-sides arm and would hit the same `readBlob`
failure today — see Decision candidate 3 and the §"Faithfulness baseline" MODIFY pin.
Whether this design also closes that path is a scope decision for the ADR phase, but
the synthesis mechanism is identical (synthesize `Subproject commit <oid>\n` for any
gitlink-mode side, type-change or modify).

### The two candidate serializer touch-points (Decision candidate 2)

Two equally-faithful ways to reach the byte-perfect output, given the synthesized
content:

- **(A) No serializer change.** If `materialiseOne` puts `Subproject commit <oid>\n`
  on the gitlink side, `renderTypeChangeBlock`'s existing `renderDeleteBlock`/
  `renderAddBlock` composition already renders it byte-perfectly (the mode and oid are
  already on the change; the body comes from the synthesized content). The serializer
  needs **zero** edits for the type-change patch. This is the minimal-diff option and
  is the recommendation.
- **(B) A dedicated `renderGitlinkBlock` in the serializer** that emits the synthetic
  line from the change's oid directly, without the primitive synthesizing content.
  This pushes submodule knowledge (`Subproject commit` template) INTO the domain
  serializer — a platform-free layer that should not know what a submodule is.
  Rejected on architecture grounds.

The design recommends **(A)**: the synthesis lives in the primitive (application tier,
where submodule semantics belong), and the domain serializer stays a pure bytes
renderer. This is captured as Decision candidate 2 for the ADR conversation.

### Why this is NOT a new rendering knob (ADR-249 nuance — stated explicitly)

ADR-249 forbids options whose only job is to steer rendered text. The
`Subproject commit <oid>` line is **not** such a knob:

- `renderPatch` is the library's ONE sanctioned patch-bytes producer. ADR-402 already
  renders type-change patch text there (the delete+add blocks). The gitlink body is
  the **completion** of that same faithful producer — the missing case ADR-402
  explicitly deferred — not a new option, flag, or format string. There is no
  `--submodule=<mode>`-style surface; the diff `command` still returns structured
  `TreeDiff` data only.
- The library still emits FIELDS: the `TypeChangeChange` carries `oldId`/`newId`/
  `oldMode`/`newMode` (the gitlink oid and `160000`). The interop test reconstructs
  git's `Subproject commit` display FROM those fields (via `reconstructPatch`, the
  same `renderPatch` the library uses internally for rebase's
  `.git/rebase-merge/patch` and patch-id) — faithfulness is reconstructed from
  structured data, exactly as ADR-249 requires.

The doc states this distinction so a reviewer does not mistake the synthetic line for
a forbidden display knob.

### Blast radius — `patch-id`, `range-diff`, `rebase`

All three consume the domain `renderPatch` through the shared `materialisePatchFiles`
hydration:

| Consumer | File:symbol | Path | Impact |
|---|---|---|---|
| patch-id | `src/application/primitives/patch-id.ts:51` `computePatchId` (`:59` materialise, `:60` render) | `diffTrees(recursive) → materialisePatchFiles → renderPatch` | a commit that introduces a gitlink type-change now hydrates + renders without throwing; the `Subproject commit` line SURVIVES `canonicalise` (`:37`, which strips only `@@ ` and `index ` lines then strips whitespace) — so two commits introducing the same submodule type-change collide, distinct ones don't. **No patch-id code change needed.** |
| rebase | `src/application/commands/rebase.ts:295` `renderCommitPatch` (`:301` materialise, `:304` render) | same shared path | a failed pick whose diff includes a gitlink type-change renders `.git/rebase-merge/patch` faithfully instead of throwing. **No rebase code change needed.** |
| range-diff | `src/application/commands/range-diff.ts:67` `hydrate` (`:74` materialise) | `diffTrees → materialisePatchFiles → renderPatch` (diff-of-diffs) | composes transitively; the inner per-commit patch now renders the gitlink side. **No range-diff code change needed.** |

The blast-radius conclusion: once `materialiseOne` synthesizes the gitlink side and
`renderPatch` renders it (option A), **all three consumers are fixed transitively** by
the single primitive change — none needs its own source edit. Whether each needs its
own *test* arm is a test-strategy question (§"Test strategy"): patch-id stability
across a submodule type-change is the one consumer-specific invariant worth an
explicit unit pin, because canonicalisation interacts with the synthetic line; rebase
and range-diff are covered by the type-change interop + their existing suites.

### Edge behaviour pinned and handled

- **No `\ No newline` marker on the gitlink side.** The synthetic content ends in
  `\n`, so `splitContentLines` reports `hasTrailingNewline = true` and the marker is
  omitted — matching the pin (D1/D2 gitlink bodies have no marker; the symlink side in
  D3/D4 DOES, because a symlink target blob has no trailing newline).
- **Abbrev = git default 7.** The `index` line uses `shortOid` (7 chars), which is
  git's default. `--abbrev=<n>` / `--full-index` are rendering knobs (ADR-249) and are
  out of scope; default-7 is the only faithful target. (Pinned: `--abbrev=12` and
  `--full-index` change the gitlink abbrev exactly as they change a blob abbrev, so no
  gitlink-specific abbrev logic exists.)
- **Both-sides-gitlink is impossible for a type-change.** `kindOf(160000) ==
  kindOf(160000)` ⇒ `isSameKind` ⇒ a `modify`, never a `type-change`. So a
  `TypeChangeChange` has at most ONE gitlink side; the other is always a real
  file/symlink blob. The synthesis is per-side-conditional, never both.
- **Mode/oid come from the change, content from synthesis.** The block header
  (`deleted file mode 160000` / `new file mode 160000`) and the `index` abbrev derive
  from `change.oldMode`/`newMode`/`oldId`/`newId` already on the structured change —
  the synthesis supplies ONLY the body bytes. This is why option (A) needs no
  serializer edit.
- **The synthetic content takes the TEXT path, never "Binary files differ".**
  `renderTypeChangeBlock` branches each side on `isBinary` (`src/domain/diff/line-diff.ts:75`
  = `hasNulInWindow || exceedsLineCaps`). The synthetic `Subproject commit <oid>\n` is
  ~60 ASCII bytes, one short line, no NUL ⇒ `isBinary` returns false ⇒ the text
  `renderDeleteBlock`/`renderAddBlock` path renders the `Subproject commit` body —
  matching the pin (D1–D4 all show a text body, never a binary line). This is a
  guaranteed property of the fixed template, not an input-dependent risk.

## Faithfulness baseline (empirical pin matrix)

Real `git version 2.54.0`, scrubbed `GIT_*`, `GIT_CONFIG_NOSYSTEM=1`, isolated
`HOME`, signing off, throwaway `mktemp -d` repo, `git diff --no-ext-diff --no-color`.
Gitlinks built via `git update-index --add --cacheinfo 160000,<oid>,<path>` (no real
submodule needed; the oid is arbitrary 40-hex `111…1`). Bytes captured via a Python
`repr` dump (exact trailing newlines and `\ No newline` markers preserved).

**It is the two-block delete+add form** (same as ADR-402 file↔symlink), confirmed by
the pin — NOT a combined block. Per-direction full bytes:

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

### Per-component matrix (extracted from the four pins)

| Component | gitlink-side value | Derivation in tsgit |
|---|---|---|
| `diff --git` header | `diff --git a/<p> b/<p>` (same path both blocks) | existing `diffGitHeader` |
| delete-block mode line | `deleted file mode 160000` | `renderDeleteBlock` from `change.oldMode` |
| add-block mode line | `new file mode 160000` | `renderAddBlock` from `change.newMode` |
| delete `index` line | `index <gitlink7>..0000000` (`1111111..0000000`) | `shortOid(change.oldId)` (default abbrev 7) |
| add `index` line | `index 0000000..<gitlink7>` (`0000000..1111111`) | `shortOid(change.newId)` |
| body hunk header (delete) | `@@ -1 +0,0 @@` | `formatHunkHeader(1,1,0,0)` from a 1-line body |
| body hunk header (add) | `@@ -0,0 +1 @@` | `formatHunkHeader(0,0,1,1)` |
| body line | `-Subproject commit <40-hex>` / `+Subproject commit <40-hex>` | synthesized content `Subproject commit <oid>\n` |
| no-newline marker | **ABSENT** on the gitlink side | synthesized content ends in `\n` ⇒ `hasTrailingNewline = true` |
| `\ No newline` marker on the OTHER side | present iff that side's blob has no trailing `\n` (symlink target: yes; `regular content\n`: no) | existing `splitContentLines` |

### MODIFY pin (gitlink → gitlink, NOT a type-change — Decision candidate 3)

A pure submodule pointer bump (`160000`→`160000`, different oid) is a `modify`, and
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

`git diff --name-status` → `M sm`; `git diff-tree -r` →
`:160000 160000 111…1 222…2 M sm`. This flows through tsgit's `renderModifyBlock` →
`renderSameKindBlock` → `modePreamble` (which emits `index <a>..<b> 160000` for equal
modes — exactly the pin). The ONLY blocker is that `materialiseOne`'s both-sides arm
calls `readBlob` on the gitlink oids and throws — the **same** failure as the
type-change. So the synthesis mechanism (synthesize `Subproject commit <oid>\n` for
any gitlink-mode side) fixes BOTH paths identically. The pin is recorded here so the
ADR phase can decide whether to bring the modify path into scope (Decision
candidate 3); the brief is type-change-only.

## Decision candidates

ADRs 226/249 fix faithfulness and the structured-data rule; ADR-399 fixed the
structural gitlink pins; ADR-402 fixed the file↔symlink patch form and explicitly
deferred the gitlink side. The load-bearing choices THIS feature introduces are below —
each ≤3 options with a recommendation. The designer does NOT decide these; the user
ratifies them in the ADR phase.

| # | Choice | Alternatives (≤3) | Recommendation | Why |
|---|---|---|---|---|
| **D1** | How `materialiseOne` represents a gitlink side | (a) synthesize the side's `PatchFile` content as the literal bytes `Subproject commit <oid>\n` (no marker on `PatchFile`/`DiffChange`); (b) add a `{ gitlink: true, oid }` marker field to the materialised `PatchFile` and let the serializer synthesize the line; (c) carry the oid + a `kind` enum on `PatchFile` and branch in the serializer | **(a)** synthesize content bytes in the primitive | Keeps the domain serializer a pure bytes renderer (no submodule knowledge), needs ZERO serializer change (option D2-A), and is the minimal diff. (b)/(c) push submodule semantics into the platform-free domain layer and widen `PatchFile`, contradicting the architecture rule; (a) localises the one submodule-specific constant (`Subproject commit ` template) to the application tier where git itself produces it. |
| **D2** | Where the `Subproject commit <oid>` line is produced in the serializer | (a) NOWHERE new — `renderDeleteBlock`/`renderAddBlock` already render it from D1's synthesized content; (b) a dedicated `renderGitlinkBlock` in the serializer that emits the line from the change's oid; (c) a parameter on `renderTypeChangeBlock` that branches each side on a gitlink flag | **(a)** no serializer change | Paired with D1-(a), the existing blocks are byte-perfect (mode + abbrev come from the change, body from synthesized content). (b) duplicates delete/add logic AND puts the `Subproject commit` template in the domain (architecture violation); (c) adds a flag the serializer must interpret, also leaking submodule semantics into the domain. (a) is provably equivalent to git by the pin and keeps the change a one-primitive edit. |
| **D3** | Is gitlink↔gitlink MODIFY (pure pointer bump, not a type-change) in scope for this feature? | (a) OUT of scope — type-change only (the brief's literal scope); pin the modify as a known follow-up; (b) IN scope — the synthesis fix is identical and closes a second `readBlob`-throw path in the same primitive edit; (c) IN scope AND add the modify interop arm | **(b)** include the modify in scope | The modify hits the EXACT same `materialiseOne` both-sides `readBlob` failure (§MODIFY pin), and the synthesis (`Subproject commit <oid>\n` for any gitlink-mode side) fixes it with zero extra serializer work — `renderModifyBlock`/`modePreamble` already emit the pinned single-block form. Leaving it out ships a primitive that throws on a submodule pointer bump (a far more common real-repo case than a submodule type-change), which the consumer with submodules WILL hit. (a) defers a near-free fix; (c) is (b) plus a test arm — fold the test decision into D4. |
| **D4** | Where do the gitlink PATCH pins live, and which arms | (a) extend `test/integration/diff-type-change-interop.test.ts` with a `reconstructPatch` arm for the four gitlink directions (mirroring the existing file↔symlink arms) + a domain unit test in `patch-serializer.test.ts` for the gitlink-side block; (b) interop only; (c) unit only | **(a)** interop `reconstructPatch` arm + a serializer/primitive unit pin | The interop file already builds all four gitlink directions and has the `reconstructPatch` helper wired for file↔symlink — adding the gitlink patch arm is the natural, single-purpose home and pins against LIVE git. The cheap mutation-resistant guard is a domain unit test that the synthesized `Subproject commit <oid>\n` content renders the exact delete/add block bytes (catches a serializer regression without spawning git). If D3-(b), add a gitlink→gitlink modify interop arm too. (b) leaves the serializer/primitive change without a fast unit guard (mutation risk on the synthesis template); (c) never cross-checks against real git. |
| **D5** | The exact synthetic content template | (a) `Subproject commit <40-hex>\n` (the literal git fast-path form, pinned); (b) parameterise the prefix/format; (c) reuse a shared constant with git's verbose submodule summary | **(a)** the literal pinned template, as a named constant | The pin shows git's one-line form is EXACTLY `Subproject commit <40-hex-oid>\n` with a trailing newline and no marker. (b) invents flexibility nothing needs (ADR-249-adjacent); (c) git's verbose `git diff --submodule=log` form is a DIFFERENT, opt-in rendering (a separate feature, out of scope). A single named constant (e.g. `SUBPROJECT_LINE_PREFIX = 'Subproject commit '`) in the primitive captures the one submodule-specific string. |

## Test strategy

**Interop — extend `test/integration/diff-type-change-interop.test.ts`** (the
existing file already builds all four gitlink directions via `--cacheinfo 160000`,
imports `reconstructPatch` from `./diff-reconstruct`, and pins `--raw`/`--name-status`
`T` for them; the file↔symlink arms already have the `reconstructPatch` arm — the
gitlink directions do NOT). Add, per the existing GWT/AAA/`sut` conventions:

- For each of the four directions (file→gitlink, gitlink→file, symlink→gitlink,
  gitlink→symlink): a `Then reconstructPatch emits delete+add blocks matching git
  diff patch bytes` arm — `diff(ctx, {from, to})` → `reconstructPatch(ctx, treeDiff)`
  → `expect(result).toBe(peer)` where `peer = gitDiff(dir, from, to)`. This mirrors
  the existing file↔symlink arms (lines 267–278, 327–338) exactly, and pins against
  LIVE git plus the frozen golden the §"Faithfulness baseline" matrix records.
- The existing `--raw`/`--name-status` `T` arms for the gitlink directions stay
  **unchanged** (regression guard that ADR-399's structural pins still pass).
- If Decision candidate 3 lands as IN scope: a `gitlink → gitlink modify` commit pair
  (`160000` oid1 → `160000` oid2) with a `reconstructPatch` arm pinning the
  single-block `index <a>..<b> 160000` + `-1/+1 Subproject commit` form (§MODIFY pin),
  plus `--name-status M` / `--raw M`.

**Unit — `test/unit/domain/diff/patch-serializer.test.ts`** (the cheap
mutation-resistant guard; the file already has file↔symlink and binary type-change
patch tests at lines 639–745). Add a `Given a type change from regular to gitlink`
(and the symmetric gitlink→regular, and symlink↔gitlink) block: construct a
`PatchFile` whose gitlink side carries the synthesized content
`Subproject commit <oid>\n` and assert `renderPatch([file])` equals the exact
delete+add bytes from the §"Faithfulness baseline" matrix. Isolated, specific
assertions (full byte string, not a substring) — the `Subproject commit ` template,
the `160000` mode, the 7-char gitlink abbrev, and the ABSENCE of the no-newline marker
on the gitlink side are the StringLiteral/Conditional mutation hot spots; assert each
exact line.

**Unit — `test/unit/application/primitives/materialise-patch-files.test.ts`** (the
synthesis is the new code; the file already has a `Given a type-change change`
block at line 180). Add a `Given a type-change with a gitlink side` block (both
directions) asserting `materialiseOne` returns the gitlink side's content as
`Subproject commit <oid>\n` (UTF-8) and the other side as the real blob — and that NO
`readBlob` is attempted on the gitlink oid (a commit that, if read, would throw
`unexpectedObjectType`). Isolated guard tests: gitlink-as-old vs gitlink-as-new, each
proving the synthesized bytes and the non-gitlink side independently (the
`kindOf(oldMode)` / `kindOf(newMode)` branches are separate Conditional mutation
targets — one test per branch). If D3 lands: a `gitlink → gitlink modify` case proving
both sides synthesize without a `readBlob`.

**Unit — `test/unit/application/primitives/patch-id.test.ts`** (blast-radius pin for
the one consumer-specific invariant). Add a guard that two commits introducing the
SAME submodule type-change (same path, same gitlink oid, same other-side content)
yield the SAME patch-id, and that a different gitlink oid yields a DIFFERENT patch-id —
proving the `Subproject commit` line survives `canonicalise` (it is not `@@ `/`index `
-prefixed) and participates in the equivalence key. rebase and range-diff are covered
transitively by the type-change interop + their existing suites (no consumer-specific
invariant beyond "doesn't throw, renders faithfully", which the shared path already
proves).

**Property tests:** not applicable. This is not a parse/serialize round-trip, a
compositional matcher, a total function over a grammar, nor an idempotence/counting
invariant (per CLAUDE.md's four lenses). The synthesis is a single template
substitution and the serializer change is a fixed-shape block; parameterised example
tests over the four directions are the clearer guard. No `*.properties.test.ts`
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
- **Changing `type-change` structured emission** — the domain already emits
  `type-change` faithfully on every surface (ADR-399); no `tree-diff.ts`/
  `index-diff.ts`/`status.ts` change. This feature touches only the patch-RENDER and
  the hydration primitive.
- **gitlink↔gitlink MODIFY** — IN scope only if Decision candidate 3 ratifies it;
  otherwise it stays a documented near-free follow-up (the §MODIFY pin is recorded so
  the fix is a one-line primitive change whenever it lands).
```

