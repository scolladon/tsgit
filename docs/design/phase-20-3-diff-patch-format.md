# Design — Phase 20.3 Diff Patch-Text Output

**Status:** Draft (target: Accepted at `<sha-after-merge>`).

Backlog: **20.3** — _"Diff patch-text output (`diff({ format: 'patch' })`);
unified-diff serializer in domain."_

ADRs: 166 (serializer in domain) · 167 (API surface: `format` discriminator +
`PatchResult` shape) · 168 (canonical headers: binary / mode / rename /
type-change) · 169 (OID abbreviation = 7 chars, default context = 3).

## 1. Goal

Add a unified-diff (git-compatible) serializer to the domain layer and
expose it through `repo.diff` so a single call can produce both the
structured `TreeDiff` and the canonical patch text that `git diff` emits
on stdout. Two reuse stories drive this:

- **CLI tooling and review UIs** — want canonical patch text byte-for-byte
  identical to `git diff` so existing patch parsers, syntax highlighters,
  and `patch(1)` compatible apply paths work unmodified.
- **`am` / `apply` / `stash apply` (phase 21–22)** — eventually consume the
  same text; landing the canonical serializer first means later phases can
  round-trip through a single grammar instead of forking emitter logic.

The serializer is **pure**: takes parsed inputs (the structured `DiffChange`
list plus loaded blob bytes per side), returns a `string`. It performs no
I/O; loading bytes is the caller's job. Domain stays untouched by
`Context`, `Port`, or `Compressor`.

## 2. Out of scope (does NOT ship in 20.3)

- `--color` / `--color-words`. ANSI escape sequences are an emitter
  concern; we ship raw text. A future `renderColorPatch` may wrap.
- `--stat` / `--shortstat` / `--numstat` / `--dirstat`. These are
  *summaries* of a `TreeDiff`, not patch text. They can ship as separate
  formatters (`format: 'stat' | 'numstat' | ...`) without touching the
  serializer landed here.
- Histogram / patience / minimal diff algorithms. Myers stays; the
  textual envelope is independent of the algorithm.
- Binary patch encoding (`--binary` / git base85). 20.3 emits
  `Binary files a/foo and b/bar differ` and stops, matching git's
  default. ADR-168 captures the trade-off.
- Patch *application* (`am` / `apply`). Consumes the same grammar but is
  Phase 21+ work.
- Combined-diff (`diff --cc` / `diff -c`) for merge commits. Single-parent
  diffs only.
- Index-side (`--cached`/`--staged`) and working-tree-side (`HEAD`
  includes uncommitted) diffs. Today's `diff` command is tree-vs-tree;
  20.3 keeps that contract and only adds the textual envelope.
- Rename-with-edits (`R` + content diff). Today's rename detection is
  exact-id only (`detectRenames` matches identical OIDs); a pure rename
  emits no hunks. Inexact rename detection is its own phase.
- Configuration plumbing for `core.abbrev`, `diff.context`,
  `diff.noprefix`. The serializer accepts options; wiring those options
  to `gitconfig` is out of scope (ADR-169 freezes defaults).

## 3. References

- ADRs: 166, 167, 168, 169.
- Internals reused: `diffLines` (existing Myers in `domain/diff/line-diff.ts`),
  `isBinary` (existing detector, same file), `FILE_MODE` (mode constants),
  `ObjectId` (abbreviation source).
- Existing surface: `src/application/commands/diff.ts` (extended, not
  replaced), `src/domain/diff/index.ts` (new exports added).

## 4. Public API

The discriminator-on-options pattern matches `repo.add({ all: true })`,
`repo.reset({ mode: 'hard' })` — `repo.diff({ format: 'patch' })`:

```ts
// src/application/commands/diff.ts

interface DiffOptions {
  readonly from?: string;
  readonly to?: string;
  readonly detectRenames?: boolean;
  readonly format?: 'tree' | 'patch';                       // default 'tree'
  readonly contextLines?: number;                            // default 3
  readonly pathPrefix?: { readonly old: string; readonly new: string };
}

type DiffResult = TreeDiff | PatchResult;

interface PatchResult {
  readonly format: 'patch';
  readonly text: string;
  readonly diff: TreeDiff;  // structured view bundled for free
}

// TypeScript overload — the discriminator narrows the return type.
function diff(ctx: Context, opts?: DiffOptions & { format?: 'tree' }): Promise<TreeDiff>;
function diff(ctx: Context, opts: DiffOptions & { format: 'patch' }): Promise<PatchResult>;
```

### 4.1 Why bundle `diff` inside `PatchResult`

A typical caller that asks for `patch` text also wants to know *which
files changed* (e.g., to render a tree view alongside the diff). Today
that requires two calls (`diff` + `diff({ format: 'patch' })`). Bundling
the structured view inside the patch result kills the second call and
keeps the consumer holding *one* immutable snapshot rather than two
loosely-synced views. The structured view costs nothing extra — we
already computed it on the way to the text.

### 4.2 Why default to `'tree'`

`repo.diff()` already returns `TreeDiff`. Switching the default would
silently break every existing caller. Explicit opt-in via `format:
'patch'` keeps the upgrade path additive — no SemVer break, no
deprecation cycle, no migration shim.

### 4.2a `BindCtx` interaction

`Repository.diff` is currently typed as `BindCtx<typeof commands.diff>`,
which uses a conditional type to strip the leading `Context` parameter.
Conditional types capture only the **last** overload of an overloaded
function, so `BindCtx<typeof diff>` would silently drop the `format:
'patch'` overload. The fix: replace `BindCtx<typeof commands.diff>` on
`Repository['diff']` with a hand-written overloaded function type that
mirrors the two `diff` overloads minus the `Context` parameter. The
binding stays a thin lambda in `repository.ts`. This change is local —
no other facade methods are affected.

### 4.3 Why `pathPrefix`

`git diff` emits `a/` and `b/` by default but supports
`--no-prefix` (both empty) and `--src-prefix=`/`--dst-prefix=`. Two
prefix strings cover both cases via a single option. Default
`{ old: 'a/', new: 'b/' }` — matches git.

## 5. Domain serializer

New file: `src/domain/diff/patch-serializer.ts`. Pure function over a
prepared input shape:

```ts
// src/domain/diff/patch-serializer.ts

interface PatchFile {
  readonly change: DiffChange;          // the TreeDiff entry
  readonly oldContent?: Uint8Array;     // undefined for 'add' and pure 'rename'
  readonly newContent?: Uint8Array;     // undefined for 'delete' and pure 'rename'
}

interface PatchOptions {
  readonly contextLines?: number;       // default 3
  readonly pathPrefix?: { readonly old: string; readonly new: string };  // default a/, b/
}

function renderPatch(
  files: ReadonlyArray<PatchFile>,
  opts?: PatchOptions,
): string;
```

The application primitive `commands/diff.ts` is responsible for
materialising the `PatchFile[]`:

1. Call `domainDiffTrees` (already exists) → `TreeDiff`.
2. For each `DiffChange`, load the relevant blob bytes via existing
   `readObject` primitive (no new I/O abstractions).
   - `add` → `newContent` only.
   - `delete` → `oldContent` only.
   - `modify` / `type-change` → both.
   - `rename` (exact-id match) → neither; emit the rename header only.
3. Hand off `PatchFile[]` to `renderPatch`.

## 6. Output grammar (canonical)

Per-file blocks separated by `\n`. Every header/body line carries a
trailing `\n` — the document ends with `\n` whenever the last emitted
line was a content line (header, body, or `\ No newline at end of
file` marker). Matches `git diff` exactly.

When a side's last content line lacks a trailing `\n`, the `\ No
newline at end of file` marker is emitted on its own line (with its own
trailing `\n`) immediately after that content line. See §6.8.

### 6.1 Add

```
diff --git a/<newPath> b/<newPath>
new file mode <newMode>
index 0000000..<newShortOid>
--- /dev/null
+++ b/<newPath>
@@ -0,0 +1,<newLen> @@
+<line1>
+<line2>
```

Hunk header for a new file is fixed: `-0,0 +1,<newLen>`. Empty file:
header + `new file mode` + `index 0000000..<oid>` + `--- /dev/null` +
`+++ b/<path>` — no `@@` line, no body. Matches `git diff` (a
`new file mode` block with no hunks for an empty new blob).

### 6.2 Delete

```
diff --git a/<oldPath> b/<oldPath>
deleted file mode <oldMode>
index <oldShortOid>..0000000
--- a/<oldPath>
+++ /dev/null
@@ -1,<oldLen> +0,0 @@
-<line1>
```

Hunk header for a deleted file is fixed: `-1,<oldLen> +0,0`. Empty
file: as above, no `@@` and no body.

### 6.3 Modify (same mode)

```
diff --git a/<path> b/<path>
index <oldShortOid>..<newShortOid> <mode>
--- a/<path>
+++ b/<path>
@@ -<a>,<b> +<c>,<d> @@
 context
-removed
+added
 context
```

Trailing mode token on `index` line: matches `git diff`. For mode
changes that don't change content, it stays on the next variant.

### 6.4 Mode change

```
diff --git a/<path> b/<path>
old mode <oldMode>
new mode <newMode>
index <oldShortOid>..<newShortOid>
```

Note: NO `<mode>` suffix on the `index` line when `old mode`/`new mode`
appear — git emits the mode in those dedicated lines and drops it from
`index`. If content also differs, the `--- a` / `+++ b` / hunks follow
beneath; if only the mode flipped (`oldId === newId`), the block ends
after the `index` line.

### 6.5 Rename (exact-id, similarity 100%)

```
diff --git a/<oldPath> b/<newPath>
similarity index 100%
rename from <oldPath>
rename to <newPath>
```

No `index`, no `---`, no `+++`, no hunks. Matches `git diff -M`'s output
for pure renames. Mode change inside a rename: insert
`old mode`/`new mode` between `similarity` and `rename from`, again
matching git.

### 6.6 Type change (e.g., regular → symlink)

```
diff --git a/<path> b/<path>
old mode 100644
new mode 120000
index <oldShortOid>..<newShortOid>
--- a/<path>
+++ b/<path>
@@ -1,<n> +1,<m> @@
-<old content lines>
+<new content lines>
```

The blob content of a symlink is the target path; the blob content of a
gitlink is the literal 40-hex commit oid (treated as text). Both
participate in the hunk body as ordinary lines. Binary symlink/gitlink
targets are not possible (paths are NUL-free); type-change vs binary is
mutually exclusive in practice.

### 6.7 Binary

Detection: `isBinary(oldContent) || isBinary(newContent)` using the
existing detector. Output:

```
diff --git a/<path> b/<path>
index <oldShortOid>..<newShortOid> <mode>
Binary files a/<path> and b/<path> differ
```

For binary `add`: `--- /dev/null` is omitted; the message becomes
`Binary files /dev/null and b/<path> differ`. Same shape for `delete`
on the other side. ADR-168 captures the trade-off vs `--binary` (full
base85 patch).

### 6.8 No-newline-at-EOF

When a side's last line does NOT end with `\n`, emit
`\ No newline at end of file` immediately after the last line of that
side. Matches `git diff` exactly. Both sides may carry the marker
independently.

## 7. Hunk emission algorithm

Inputs: `oldContent`, `newContent`, `contextLines` (default 3).

`diffLines` takes `(ours, theirs)` and labels hunks `common`,
`ours-only`, `theirs-only`. The serializer maps **ours = old side
(`-`)** and **theirs = new side (`+`)**, which is the existing call
convention in `three-way-content.ts` (the only other caller today).

1. Run `diffLines(oldContent, newContent)` → `LineDiff` (existing).
2. Walk the hunk array and translate each `kind` into `equal`/`delete`/
   `insert` line edits — already done internally by `buildHunks`; we
   project back to the per-line edit stream.
3. Apply the canonical unified-diff hunk-grouping:
   - For each contiguous run of `delete`+`insert` edits, expand `contextLines`
     equal-lines on each side. Adjacent runs whose context windows
     touch or overlap merge into a single hunk.
4. For each output hunk, compute `(oldStart, oldLen, newStart, newLen)`
   from the cursors and emit `@@ -<a>,<b> +<c>,<d> @@`.
   - Single-line hunks omit the `,<len>` suffix when `<len> == 1`
     (matches git; `,1` is implicit).
   - Zero-length sides: `<len> == 0` is emitted as `,0`. The matching
     start is the line *before* the inserted/deleted range — git's
     "zero-length anchor" convention. For a pure insertion at the
     very start of a file: `-0,0 +1,<n>` (start = 0 for the empty old
     side). For a pure deletion that leaves the file empty:
     `-1,<n> +0,0`.
   - Hunks coalesce when their context windows touch — i.e. when the
     gap between two adjacent change runs is `<= 2 * contextLines`
     equal lines, the runs share one hunk header with the equal lines
     emitted as ` <line>` between them.
5. Body lines:
   - `equal` → ` <line>`
   - `delete` → `-<line>`
   - `insert` → `+<line>`
   - Strip the trailing `\n` from each line (it's part of the `splitLines`
     contract — every line bar the last carries its LF). The serializer
     re-emits the LF as the line separator between body lines.

### 7.1 Degraded `LineDiff`

`diffLines` returns `degraded: true` when content exceeds
`MAX_DIFF_LINES` or the iteration budget. In that case `LineDiff` carries
a whole-file ours-only + theirs-only hunk pair. We render this verbatim
(one giant delete hunk followed by one giant insert hunk under a single
`@@` header pair? no — git renders this as a single `@@` covering both
sides with the whole-old-then-whole-new body, matching the degraded
shape). The serializer must reproduce git's exact text for the degraded
case: emit one hunk with `oldLen = oldLines.length`, `newLen =
newLines.length`, body = all old lines as `-` followed by all new lines
as `+`.

## 8. Memory & performance

- Patch text is built into a `string[]` accumulator (one entry per
  emitted line) and joined with `'\n'` at the end. Same pattern as
  `walkCommits`' `formatCommit` output. Avoids quadratic concat costs.
- Bound: `diffLines` already caps total line count at `MAX_DIFF_LINES`
  (50k) per file. A repo with 50 files, each at the cap, peaks at ~2.5M
  output lines = ~250 MB string. Callers diffing such repos already opt
  out of structured diff via `repo.primitives.walkTree`. Real-world
  patches are kilobytes.
- The serializer never reads from disk. Bytes are owned by the
  application-layer caller, which is the existing pattern for
  `readObject` → `parseBlobContent` → `domainDiffTrees`.

## 9. Testing strategy

### 9.1 Unit (`test/unit/domain/diff/patch-serializer.test.ts`)

GWT-organised. One describe block per file-class (add, delete, modify
same mode, mode change, rename, type change, binary, no-newline, empty
new file, empty old file, multi-file mixed).

For each: arrange a hand-crafted `PatchFile[]`, act `renderPatch(...)`,
assert against a frozen golden string. Golden strings live in-file
(template literals with explicit `\n` escapes) so the LF discipline is
visible in the test source.

### 9.2 Property-based (`test/unit/domain/diff/patch-serializer.properties.test.ts`)

Two properties (per the CLAUDE.md property-test policy — case 1
round-trip + case 2 invariant):

- **Hunk-header arithmetic**: for any non-degraded `LineDiff`, the sum
  of context+delete lines per hunk equals `oldLen`, and context+insert
  equals `newLen`. (Invariant.)
- **Round-trip via re-parse**: emit a patch for two arbitrary
  byte-strings; the structural counts (`+` / `-` / ` ` lines) recovered
  by a tiny in-test re-parser match the `LineDiff`'s edit counts.
  (Round-trip without re-implementing the SUT — the in-test re-parser
  counts line prefixes only.)

`numRuns` per CLAUDE.md tier: 100 for the invariant, 100 for the
round-trip (medium complexity).

### 9.3 Integration

`test/integration/diff-patch.test.ts` exercises `repo.diff({ format:
'patch' })` end-to-end against a memory adapter: init → commit → modify
→ diff → assert text equals what `git diff` would produce for the same
inputs. Goldens captured from a `git diff` run on a tmp clone (CI step
in the existing interop suite shape).

### 9.4 Interop (`@writes` surface)

`patch-serializer.ts` does NOT write bytes to disk — it returns a
`string`. It is NOT a write-surface. No `@writes` tag required.

## 10. Mutation hardening

The patch serializer is a high-mutation-density target (string concat,
arithmetic on line counts, branch logic per file-class). Mitigations
already baked in:

- Goldens with `\n` escapes: any string mutation flips the test.
- Per-class unit tests (one `describe` per file-class) isolate each
  branch — a mutant in the binary path can't be killed by the
  modify-path test.
- Hunk-header arithmetic test (§9.2) kills numeric-mutation classes
  (`+` ↔ `-`, `<` ↔ `<=`) on the line-count math.
- Boundary tests: empty file (zero hunks), single-line file (no `,1`
  suffix), single-line removed (zero-length anchor `,0`), no-newline at
  EOF (marker emission), degraded LineDiff (one giant hunk).

Known equivalent-mutant zones to document inline with
`// equivalent-mutant: <why>`:

- The `MyersResult.totalD` field passed through from `diffLines` —
  unused by the serializer (we walk hunks, not edit count); some
  mutants on its read will be equivalent. Verify case-by-case.

## 11. Open questions resolved

- **Q: Return type — string vs Uint8Array?**
  - A: `string`. Patches are textual by spec; if a caller needs bytes
    they `new TextEncoder().encode(text)`. Decoupling the byte-output
    story buys nothing in the v2 surface.
- **Q: Where to put the bridge from `TreeDiff` to `PatchFile[]`?**
  - A: Inside `commands/diff.ts` — it's an application-layer
    responsibility (it loads blobs via `readObject`). A separate
    primitive `diffPatch` is unnecessary; `repo.diff({ format: 'patch'
    })` is the canonical surface.
- **Q: Configurable OID abbreviation?**
  - A: No. 7 chars matches git default; ADR-169 freezes it. A future
    `core.abbrev` plumbing pass can add the option.
- **Q: Configurable context lines?**
  - A: Yes via `contextLines`, default 3. Matches `git diff -U3`.
  - Validation: `contextLines >= 0`. Negative throws `INVALID_OPTION`
    via existing `TsgitError` channel.
- **Q: How do renamed files with mode changes serialize?**
  - A: `similarity index 100%` + `old mode <m1>` + `new mode <m2>` +
    `rename from <p1>` + `rename to <p2>`. Matches git.
- **Q: What about `\r\n` line endings?**
  - A: Treated as opaque content bytes. The `splitLines` contract uses
    LF only as a separator; a `\r` preceding the LF stays in the line
    body, which means CRLF files produce diffs with `\r` characters
    visible at line ends (matches git behaviour absent
    `core.autocrlf`).
- **Q: How are paths with spaces / quotes / non-ASCII bytes rendered
  in the `diff --git`, `--- a/`, `+++ b/`, `rename from/to` headers?**
  - A: 20.3 emits paths verbatim with no quoting. Git's quoting path
    (C-escape + leading/trailing `"`) applies when paths contain
    special chars and `core.quotePath` is true. Most paths are
    ASCII-safe; quoting is a follow-up (tracked alongside the
    `core.abbrev` / `diff.context` config plumbing that ADR-169
    defers). Goldens for non-ASCII paths are marked `// equivalent
    when quoted` until the follow-up lands.

## 12. Risk register

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Output diverges from `git diff` in an obscure corner | medium | high (breaks downstream parsers) | Golden tests + interop test against `git diff` in CI |
| `\ No newline at end of file` marker placement wrong | medium | medium | Dedicated unit tests for both sides; property test asserts marker appears iff content lacks trailing LF |
| Performance regression at degraded-LineDiff boundary | low | medium | Builder pattern + early-exit guard; no quadratic concat |
| Hunk-grouping merges incorrectly (adjacent hunks within `2 * contextLines` should merge into one) | high | medium | Explicit unit tests for both touching and non-touching gaps |
| Type-change with binary blob on one side | low | low | Both branches checked: emit `Binary files differ` body if either side is binary |
