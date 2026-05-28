# Plan — Phase 20.3 Diff Patch-Text Output

Derived from `docs/design/phase-20-3-diff-patch-format.md` and ADRs
166–169. Slices are ordered so each one rests on a green tree and
ships as an atomic commit.

Test conventions: Given/When/Then split across describe/it; AAA body
comments; `sut` for the system under test. Mutation discipline per
CLAUDE.md — every guard tested in isolation, every error assertion
narrowed to `.data.code`/`.data.reason`.

## Slice 1 — Domain serializer scaffolding (pure types + no-op `renderPatch`)

**Why first:** the entire domain surface lands before the application
wiring. Keeps the diff small and lets the application layer compose on
a stable, fully-tested base.

1. **RED** — `test/unit/domain/diff/patch-serializer.test.ts`:
   - `Given an empty PatchFile[], When renderPatch, Then returns ''`.
   - Failing import of `renderPatch` from
     `../../../../src/domain/diff/patch-serializer.js`.
2. **GREEN** — create
   `src/domain/diff/patch-serializer.ts` exporting:
   - `interface PatchFile { change: DiffChange; oldContent?: Uint8Array; newContent?: Uint8Array }`
   - `interface PatchOptions { contextLines?: number; pathPrefix?: { old: string; new: string } }`
   - `function renderPatch(files, opts?): string` — initial body
     returns `''`.
   - Export from `src/domain/diff/index.ts`.
3. **Validate** — `npm run validate` clean. Atomic commit:
   `feat(domain/diff): patch serializer scaffolding`.

## Slice 2 — Add / Delete file headers

Lands the simplest two file-classes end-to-end: the header lines, the
short-OID computation, the empty-file edge cases, and one trivial
single-line hunk per class. Hunk-grouping (Slice 5) builds on this.

1. **RED** — extend `patch-serializer.test.ts` with the following
   describe blocks (each holds 4–6 `it` cases):
   - `Given a single-line add file change, When renderPatch, Then
     emits the canonical add header + @@ -0,0 +1,1 @@ + +<line>`.
   - `Given an empty add file change, When renderPatch, Then emits
     the add header only (no @@, no body)`.
   - `Given a single-line delete file change, When renderPatch, Then
     emits the canonical delete header + @@ -1,1 +0,0 @@ + -<line>`.
   - `Given an empty delete file change, When renderPatch, Then emits
     the delete header only`.
   - `Given an add with content lacking trailing LF, When renderPatch,
     Then emits the \ No newline at end of file marker after the last
     + line`.
   - `Given an add with multi-line content, When renderPatch, Then
     emits @@ -0,0 +1,<N> @@ with N + lines`.
2. **GREEN** — implement `renderAddBlock(file, opts)` and
   `renderDeleteBlock(file, opts)` inside `patch-serializer.ts`.
   Helpers:
   - `shortOid(id: ObjectId): string` → first 7 chars.
   - `renderFileHeader({ oldPath, newPath, prefix }) → string` → emits
     `diff --git a/X b/Y` line (with `pathPrefix.old`/`new`).
   - `splitContentLines(bytes: Uint8Array): { lines: string[]; hasTrailingNewline: boolean }`
     using `splitLines` from `line-diff.ts` + `TextDecoder`.
3. **Validate** — `npm run validate` clean. Atomic commit:
   `feat(domain/diff): add/delete patch blocks`.

## Slice 3 — Modify (same mode), no-newline marker, hunk grouping

The serializer's central engine. Ships the hunk grouper (touching
runs merge, gaps > 2*context split), the per-side cursor arithmetic,
and the `\ No newline at end of file` placement.

1. **RED** — new describe blocks under `patch-serializer.test.ts`:
   - Single-line modify (one delete + one insert, no context).
   - Modify in the middle of a 10-line file with default 3-line
     context — assert exact `@@ -<a>,<b> +<c>,<d> @@` + 3 lines of
     context on each side.
   - Two changes separated by 1 equal line → coalesce into one hunk.
   - Two changes separated by 7 equal lines (> 2*3) → split into two
     hunks.
   - `contextLines: 0` shrinks every hunk to its bare edit.
   - Negative `contextLines` throws (TODO: pick error code from
     existing `TsgitError` channel; reuse `invalidDiffInput` or add a
     sibling).
   - Modify on a file whose last line lacks `\n` (either side) →
     `\ No newline at end of file` marker after the relevant side.
   - Modify on a file whose last line lacks `\n` on BOTH sides → two
     markers, one after the last `-` line, one after the last `+`
     line.
2. **GREEN** — implement:
   - `expandHunks(lineDiff, contextLines)`:  walks `LineDiff.hunks`,
     buffers per-side cursors, emits `OutputHunk` array `{ oldStart,
     oldLen, newStart, newLen, body: Line[] }` where `Line = {kind:
     'context'|'delete'|'insert', text: string, hasTrailingNewline:
     boolean}`.
   - `formatHunkHeader({ oldStart, oldLen, newStart, newLen })` →
     `@@ -A,B +C,D @@` with `,1` suffix elided (matches git).
   - `renderModifyBlock(file, opts)` — calls `expandHunks`, formats
     header, walks body lines, emits the no-newline marker
     immediately after the last `-` or `+` line of a side whose
     content lacks `\n`.
   - Validation in `renderPatch`: `if (opts?.contextLines !== undefined
     && (!Number.isInteger(opts.contextLines) || opts.contextLines < 0))
     throw invalidDiffInput(\`contextLines must be a non-negative integer; got ${opts.contextLines}\`);`.
     Existing `invalidDiffInput(reason: string)` factory already
     covers this — no extension to `domain/diff/error.ts` needed.
3. **Validate** — `npm run validate` clean. Atomic commit:
   `feat(domain/diff): modify blocks + hunk grouping + no-newline marker`.

## Slice 4 — Mode change, type change, binary, rename

Ships the remaining canonical headers from ADR-168.

1. **RED** — describe blocks:
   - Mode change only (content identical): emits `old mode` /
     `new mode` / `index` (no `<mode>` suffix), no `--- a` / `+++ b`,
     no hunks.
   - Mode change + content change: emits `old mode` / `new mode` /
     `index` + `--- a` / `+++ b` + hunks.
   - Type change regular → symlink: emits `old mode 100644` / `new
     mode 120000` / `index` + `--- a` / `+++ b` + body where new line
     is the symlink target.
   - Pure rename (exact-id): emits `similarity index 100%` +
     `rename from` + `rename to`; no `index`, no `---`, no `+++`, no
     hunks.
   - Binary modify: emits `Binary files a/X and b/X differ`; no `--- a`
     / `+++ b` / hunks.
   - Binary add: `Binary files /dev/null and b/X differ`.
   - Binary delete: `Binary files a/X and /dev/null differ`.
2. **GREEN** — extend `renderModifyBlock` to branch on:
   - `change.type === 'rename'` → `renderRenameBlock`.
   - `change.type === 'type-change'` → mode-change preamble +
     content body.
   - `isBinary(oldContent) || isBinary(newContent)` → binary block.
   - `oldMode !== newMode` (from change discriminants) → mode-change
     preamble.
   - `oldId === newId` with `oldMode !== newMode` (a `modify` change
     emitted by `classifySamePath` purely because the mode flipped) →
     mode-change preamble + `index` line only; no `--- a` / `+++ b` /
     hunks. The hunk body is empty because the content is
     byte-identical.
3. **Validate** — `npm run validate` clean. Atomic commit:
   `feat(domain/diff): mode/rename/type-change/binary patch blocks`.

## Slice 5 — Property-based tests

Per CLAUDE.md property-test policy. Two properties.

1. **RED** — new file
   `test/unit/domain/diff/patch-serializer.properties.test.ts`:
   - **Property A (hunk-header arithmetic):** for any
     `(oldContent, newContent)` from an arbitrary pair of small
     ASCII line streams, every hunk's `oldLen` equals the count of
     `context + delete` body lines and `newLen` equals
     `context + insert` body lines.
   - **Property B (round-trip via re-parse):** the in-test re-parser
     counts ` ` / `-` / `+` line-prefixes in the emitted body; the
     totals match the `LineDiff` edit counts for the same input
     pair.
   - `numRuns`: 100 each (medium complexity).
   - Arbitraries reuse the existing `test/unit/domain/diff/arbitraries.ts`
     line-stream generators (add a `Uint8Array` line-pair arb if
     missing).
2. **GREEN** — properties pass on the implementation from Slices 1–4
   (no new production code; properties are a safety net).
3. **Validate** — `npm run validate` clean. Atomic commit:
   `test(domain/diff): property-based patch serializer tests`.

## Slice 6 — Application wiring: `repo.diff({ format: 'patch' })`

Bridges `TreeDiff` → `PatchFile[]` and exposes the textual surface.

1. **RED** — `test/unit/application/commands/diff.test.ts`:
   - `Given two commits with a modified file, When diff({ format:
     'patch' }), Then PatchResult.text contains the canonical diff
     and PatchResult.diff carries the structured changes`.
   - `Given default (no format), Then returns TreeDiff (existing test
     remains green)`.
   - `Given format: 'patch' and detectRenames: true, Then a renamed
     file emits the rename block`.
   - `Given format: 'patch' and pathPrefix: { old: '', new: '' },
     Then headers use bare paths`.
   - `Given format: 'patch' and contextLines: 0, Then hunks have no
     surrounding context`.
   - `Given format: 'patch' and a deleted file, Then the deleted-file
     block appears`.
   - `Given format: 'patch' and an added binary file, Then the
     "Binary files /dev/null and b/X differ" line appears`.
2. **GREEN** — extend `src/application/commands/diff.ts`:
   - Add `DiffOptions.format / contextLines / pathPrefix`.
   - Overload declarations (existing `export const diff = async ...`
     becomes `export function`):
     ```ts
     export function diff(ctx: Context, opts?: DiffOptions & { format?: 'tree' }): Promise<TreeDiff>;
     export function diff(ctx: Context, opts: DiffOptions & { format: 'patch' }): Promise<PatchResult>;
     export async function diff(ctx: Context, opts: DiffOptions = {}): Promise<DiffResult> { ... }
     ```
     The runtime body is one function; the two leading declarations
     are TypeScript-only overload signatures. Tests must cover both
     narrowing paths (`format` absent vs `'patch'`) to lock the
     overload mapping.
   - Implementation: compute `TreeDiff` (existing path). If `format
     === 'patch'`, materialise `PatchFile[]` by walking changes and
     loading blob bytes via `readObject` + `parseBlobContent`. Call
     `renderPatch(files, { contextLines, pathPrefix })`. Return
     `{ format: 'patch', text, diff: tree }`.
   - Export `PatchResult` from `commands/index.ts`.
   - Update `src/repository.ts`: change `Repository['diff']` from
     `BindCtx<typeof commands.diff>` to a hand-written overloaded
     function type (per design §4.2a).
3. **Validate** — `npm run validate` clean. Atomic commit:
   `feat(diff): patch-text output via format: 'patch'`.

## Slice 7 — Integration parity test (Memory adapter)

End-to-end on the memory adapter; goldens are inlined as template
literals (no `git` subprocess required — the unit-level interop test
in Slice 8 covers that).

1. **RED** — `test/integration/diff-patch.test.ts`:
   - `Given a memory repo with one committed file modified across two
     commits, When repo.diff({ from, to, format: 'patch' }), Then
     text matches an inlined golden patch`.
   - `Given an added file then a renamed file, When diff with
     detectRenames + format: 'patch', Then the rename block appears
     and the added file's block follows in path-sort order`.
   - File header `@proves: diff:patch:format` (per
     `phase-19-4-integration-test-usefulness-audit.md`).
2. **GREEN** — integration test passes on the application wiring
   from Slice 6. No new production code expected.
3. **Validate** — `npm run validate` clean. Atomic commit:
   `test(integration): diff patch-format end-to-end`.

## Slice 8 — Interop check (`git diff` golden comparison)

Confirms byte-identical output for representative shapes. Reuses the
existing interop suite infrastructure if it applies; otherwise a
new test in `test/interop/diff-patch.interop.test.ts` skips when
`git` is unavailable on the runner.

1. **RED** — write the test that shells out to `git diff` (in a
   throwaway tmpdir repo) on three shapes — single-file modify,
   delete + add, binary add — and asserts byte-equality with
   `renderPatch`'s output.
2. **GREEN** — fix any divergence found. Most likely targets: hunk
   header `,1` elision; `\ No newline at end of file` placement;
   binary header phrasing.
3. **Validate** — `npm run validate` clean. Atomic commit:
   `test(interop): diff patch byte-parity with git`.

## Slice 9 — Docs refresh

1. Update `docs/use/commands/diff.md`:
   - Document `format`, `contextLines`, `pathPrefix`.
   - Update the example block with a `format: 'patch'` snippet.
   - Drop the "roadmap Phase 20.3" line at the top.
2. Update `docs/use/recipes.md` with a "Render a patch" recipe.
3. Update `docs/understand/architecture.md` if the diff layering
   diagram lists the domain modules (add `patch-serializer`).
4. Update `docs/BACKLOG.md`: flip 20.3 to `[x]`, add the ADR/design
   references in the same row format as 20.2.
5. Update top-level `README.md` only if it lists per-command
   capabilities (most likely not).
6. Atomic commit: `docs(diff): patch-format API reference + backlog`.

## Slice 10 — Three review passes + mutation kill

Per CLAUDE.md step 6 and 7.

1. **Review pass 1** — parallel: `code-reviewer` + `security-reviewer`
   + `test-review` + perf eyeball.
   - Triage findings into `critical` (block) / `high` (fix in pass) /
     `info` (defer or document).
   - Fix all critical + high; commit fixups (atomic, conventional).
2. **Review pass 2** — re-run all four reviewers on the post-fix
   diff. New findings can arise from fix patches.
3. **Review pass 3** — final pass.
4. **Mutation kill** — `stryker run` scoped to the changed files
   (`src/domain/diff/patch-serializer.ts` + `src/application/commands/diff.ts`).
   - Target zero surviving mutants.
   - Document any provably-equivalent mutants inline with
     `// equivalent-mutant: <why>` (no central catalogue per
     project memory).
5. **Final validation** — `npm run validate` clean across the full
   harness. Atomic commit (only if mutation-kill produced fixes):
   `test(diff): kill patch-serializer mutants`.

## Slice 11 — Push + PR

Per CLAUDE.md step 8.

1. Confirm branch is up-to-date with `origin/main`.
2. `git push -u origin feat/20-3-diff-patch-format`.
3. Open PR with conventional title, summary covering the design
   highlights, test plan, and ADR cross-references.
4. Wait for CI green; do NOT merge (user squash-merges).

## Step ordering rationale

- Slices 1–5 land entirely inside `src/domain/diff/` — no application
  changes, no command churn. CI gates are minimal.
- Slice 6 changes the public surface; landing it on top of a
  fully-tested domain means a single review focus area.
- Slices 7–8 prove correctness against the existing harness and
  upstream git, in that order: memory parity first (no shell needed),
  then byte-parity with `git diff`.
- Slice 9 ships docs in the same PR per the cross-cutting
  "Per-PR docs" invariant.
- Slice 10 enforces the three-review-pass + mutation discipline; one
  bundled `validate` run at the end confirms the harness.

## Risks

- Hunk-grouping arithmetic is a fertile mutation target. Mitigation:
  Slice 5's property-based tests + Slice 8's `git diff` byte-parity
  goldens.
- `parseBlobContent` may not exist as a callable in the application
  layer — if `readObject` returns a parsed `GitObject` directly we use
  `obj.data` from the blob discriminant. To be confirmed in Slice 6.
- `RenameChange` carries a single `id` per ADR-168 — but if a future
  rename-detect introduces `oldMode !== newMode`, the serializer must
  emit `old mode`/`new mode`. The slice 4 implementation handles this
  defensively even though the current type can't express it (a
  type-level TODO is fine).
