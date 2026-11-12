# `grep`

Search tracked content for a pattern — git's `git grep`, with one deliberate
divergence: **the pattern is a JavaScript `RegExp`, not git's POSIX grammar**
(see Divergences). Returns **structured data only**: per matching path (or, for a
blob target, the blob's match), the matching lines with 1-based line numbers, the raw line bytes, and byte-offset
match spans. The rendered `path:line:text`, the `-c` count, the `-l` name list,
and the `Binary file … matches` line are caller projections.

## Signature

```ts
repo.grep(opts: GrepOptions): Promise<GrepResult>;

interface GrepFixedPattern {
  readonly fixed: string;          // literal substring search (git's -F)
}
type GrepPattern = RegExp | GrepFixedPattern;

interface GrepOptions {
  readonly patterns: ReadonlyArray<GrepPattern>;        // ≥1 required; OR-combined
  readonly wholeWord?: boolean;                          // git's -w
  readonly invert?: boolean;                             // git's -v
  readonly target?: 'index' | { readonly treeish: string }; // absent ⇒ working tree
  readonly paths?: ReadonlyArray<string>;               // pathspec limiter
}

interface MatchSpan {
  readonly start: number;          // byte offset into the line (inclusive)
  readonly end: number;            // byte offset into the line (exclusive)
}
interface GrepLineHit {
  readonly lineNumber: number;     // 1-based (git's -n)
  readonly line: Uint8Array;       // raw line bytes (trailing LF kept)
  readonly spans: ReadonlyArray<MatchSpan>; // empty under invert
}
interface GrepBlobResult {
  readonly hits: ReadonlyArray<GrepLineHit>;
  readonly binaryMatch: boolean;   // binary blob, some line of its first 64 KiB returned by the matcher; hits empty
  readonly binaryMatchCount: number; // binary blob: lines of its first 64 KiB the matcher returns; 0 for text
}
interface GrepPathResult extends GrepBlobResult {
  readonly path: FilePath;
}
interface GrepResult {
  readonly paths: ReadonlyArray<GrepPathResult>; // only paths with a hit or binaryMatch; always empty for a blob target
  readonly blob?: GrepBlobResult;                // blob target only; absent when it did not match
}
```

## Options

| Field | Type | Default | Meaning |
|---|---|---|---|
| `patterns` | `ReadonlyArray<RegExp \| { fixed: string }>` | (required, ≥1) | Patterns to search. A `RegExp` searches by JS regex (flags ride on it: `i` for case-insensitive, `s`, `m`); a `{ fixed }` searches a literal substring. Multiple patterns are **OR-combined** (git's `-e … -e …`). |
| `wholeWord` | `boolean` | `false` | git's `-w` — a match counts only when the byte before its start and the byte at its end are non-word bytes (`[A-Za-z0-9_]`). Applied to both regex and fixed forms. |
| `invert` | `boolean` | `false` | git's `-v` — return the lines that do **not** match. Inverted line hits carry empty `spans`. |
| `target` | `'index' \| { treeish }` | working tree | Absent ⇒ the **working tree** (tracked files, working-tree content). `'index'` ⇒ the staged content (git's `--cached`). `{ treeish: 'HEAD' }` ⇒ a commit, tree, or blob (full rev grammar); the key stays `treeish` even for a blob. |
| `paths` | `ReadonlyArray<string>` | (all) | Pathspec limiter — only enumerated paths matching the pathspec are searched. Same syntax as [`add`](add.md#pathspec-syntax): git's pathspec glob, where `*` and `?` cross `/`; on a POSIX host a `\` is a matching escape. |

## Behaviour

- **Targets.** The default (working-tree) target enumerates **tracked** files (the
  index, stage 0) and reads their **working-tree** content, so unstaged
  modifications are visible; untracked and ignored files are not searched.
  `'index'` reads staged blob content; `{ treeish }` reads a committed tree.
- **Blob target.** A `{ treeish }` rev that resolves to a blob (`oid`, `rev:path`,
  `:path`, `:0:path`, `<oid>^{blob}`, a tag — nested or lightweight — of a blob,
  `tag^{}`) greps that blob. The result has `paths: []` and a `blob` field, absent
  when nothing matched. `paths` (the pathspec) is validated, so its refusals hold,
  but never applied. Any blob mode is grepped, a symlink's target string included.
  Once a commit is reached, everything past it must end on a tree: a commit whose
  tree header leads to a blob (directly, through a tag, or through another commit)
  is refused on that commit's id, as git's `unable to read tree (<commit>)`.
- **Refusal order.** For a `{ treeish }` target git resolves the rev and parses the
  object it names, then the pathspec, then peels the object. A rev that does not
  resolve, or names a missing object, outranks a pathspec outside the repository;
  a failure while peeling (a tag whose target is missing, a commit whose tree is
  missing or is a blob) does not.
- **Work-tree requirement is target-dependent.** Only the default (working-tree)
  target needs a work tree — it refuses `WORK_TREE_REQUIRED` when the repository
  has none (bare, or opened without one). `'index'` and `{ treeish }` (tree or blob)
  stay open in a bare repository, matching git's `grep --cached` and `grep <pattern> HEAD`.
- **Searchable content.** On tree, index and working-tree targets only regular and
  executable file blobs are searched; **symlinks and gitlinks (submodules) are
  skipped** — matching `git grep`. The mode filter does not apply to a blob target. A tracked file absent from the working tree is silently skipped.
- **Binary blobs.** A binary blob (NUL in the first 8 KiB — git's own rule, no
  line-length or line-count heuristic) is not line-scanned; it is reported with
  `binaryMatch: true` and empty `hits` (git's `Binary file X matches`, exit 0) when
  the matcher returns some line of its first 64 KiB. Under `invert` a returned line
  is a non-matching one, so a binary blob whose every line matches is not reported;
  an anchored pattern sees each line, not the whole window.
- **Line numbering** is 1-based; `line` carries the raw bytes including the
  trailing LF that `splitLines` preserves.
- **Match spans** are **byte offsets** into `line` — `line.subarray(start, end)`
  is exactly the matched bytes.

### Caller projections (the library ships data, not rendering)

- **Label.** The `rev` as typed for a blob target; `${rev}:${path}` for a tree target.
- **`path:line:text`** — tree: for each `hit`, `${rev}:${path}:${hit.lineNumber}:${decode(hit.line)}`;
  blob: `${rev}:${hit.lineNumber}:${decode(hit.line)}` for each `hit` of `result.blob`.
- **`-c` (count):** with `count = m => m.binaryMatch ? m.binaryMatchCount : m.hits.length`,
  `result.paths.map(p => ({ path: p.path, count: count(p) }))`;
  blob: `result.blob && { label: rev, count: count(result.blob) }`. git counts the
  returned lines of a binary blob too, not 1 (within the first 64 KiB — see Divergences).
- **`-l` (name-only):** `result.paths.map(p => p.path)`; blob: `result.blob ? [rev] : []`.
- **`Binary file X matches`:** emit for each `p` with `p.binaryMatch === true`;
  blob: `Binary file ${rev} matches` when `result.blob?.binaryMatch`.

### Divergences (documented)

- **Pattern grammar is JavaScript `RegExp`, not git's POSIX BRE/ERE** (ADR-395).
  This is a conscious divergence from the prime directive: a `RegExp` is the
  idiomatic, type-honest input for a JS library, and a caller wanting git's POSIX
  grammar translates it themselves. `a+` means "one or more `a`" here (JS), not
  the literal `a+` of git's default BRE. PCRE (`-P`) and the POSIX modes are not
  offered in v1. Everything *other* than the grammar — which paths/lines each
  target exposes, binary handling, line numbering — stays byte-faithful to git and
  is pinned by the cross-tool interop suite.
- **Matching is byte-oriented** (ADR-397): the line is viewed as Latin-1 so
  `RegExp` indices are byte offsets; `.` matches one byte, and a `u`-flagged
  `RegExp` is rejected (it asserts code-point semantics the byte view cannot
  honour). A line is matched **without its trailing newline** (like git), so `$`
  anchors at end-of-line; a `\r` before the LF is kept (CRLF: `$` sits after `\r`).
- **Case-folding under the `i` flag is V8's Unicode folding**, not git's
  byte/locale folding — high-byte case matches may differ from `git grep -i`.
- **An empty fixed pattern `{ fixed: '' }` matches nothing**, whereas `git grep -F ''`
  matches every line. The empty-pattern case is degenerate; the command rejects an
  empty `patterns` array but treats an empty literal as a no-match.
- **Binary-match presence inspects only the first 64 KiB** of a binary blob: a blob
  whose only match lies beyond the first 64 KiB is not reported as `binaryMatch`,
  and `binaryMatchCount` counts only the window's returned lines, so a binary blob
  with returned lines past 64 KiB counts lower than `git grep -c`.
  Under `invert`, a window boundary cutting through a matching line can return the
  cut fragment as a non-matching line, so the blob may be reported where git's
  unbounded scan would not. This
  bounds the work a caller `RegExp` can do over an unbounded binary blob (the text path
  is already bounded per line). Binary blobs are an incidental search target, so the
  window is a deliberate safety bound.

## Performance

- **A `RegExp` pattern runs over the full bytes of every text line, uncapped.**
  A pathological backtracking pattern searched against one very long,
  non-matching line is quadratic in the line's byte length: measured with
  `.*foo.*bar`, a 64 KiB line takes ≈4.2 s and a 256 KiB line ≈70.4 s to
  search. This is not a tsgit-specific gap — `git grep` runs the same class of
  pattern through its own regex engine and pays the same backtracking cost on
  pathological input, so bounding it here would be a divergence from git, not
  a fix. A caller searching very long, untrusted, or otherwise unbounded lines
  with an attacker-influenced `RegExp` should validate the pattern or cap
  input size itself.
- **Fixed-string patterns (`{ fixed: '...' }`) are immune.** They match
  directly on the line's raw bytes — no decode to a JS string, no `RegExp`,
  no backtracking — so their cost is linear in the line length regardless of
  pattern shape. Prefer `{ fixed }` over an equivalent literal `RegExp` when
  searching content whose length or pattern origin you don't control.
- **A single line whose bytes exceed the JS engine's maximum string length**
  (~512 MiB) cannot be decoded to run a `RegExp` at all; `GREP_LINE_TOO_LONG`
  is thrown in its place rather than letting a bare engine `RangeError`
  escape. Fixed-string patterns never decode, so they are unaffected.

## Examples

```ts
// Find a literal call across the working tree.
const result = await repo.grep({ patterns: [{ fixed: 'readBlob(' }] });
for (const p of result.paths) {
  for (const h of p.hits) {
    console.log(`${p.path}:${h.lineNumber}:${new TextDecoder().decode(h.line)}`);
  }
}

// Case-insensitive regex, whole-word, in the staged content.
await repo.grep({
  patterns: [/todo/i],
  wholeWord: true,
  target: 'index',
});

// Search a committed tree, limited to a subtree.
await repo.grep({
  patterns: [/export function/],
  target: { treeish: 'HEAD' },
  paths: ['src/'],
});

// Search one blob: `result.blob` is absent when it does not match.
const { blob } = await repo.grep({
  patterns: [{ fixed: 'name' }],
  target: { treeish: 'HEAD:package.json' },
});
if (blob) console.log(blob.hits.map(h => h.lineNumber));

// Lines NOT matching any pattern.
await repo.grep({ patterns: [/^\s*\/\//], invert: true });
```

## Throws

- `INVALID_OPTION` — `patterns` is empty (`option: 'patterns'`), or a `RegExp`
  carries the `u` flag (`option: 'pattern'`, unsupported over byte content).
  Checked **after** the repository gate and the repo-settings check below,
  matching git: `git grep` with no pattern in a repository carrying a
  malformed `[core]` entry reports the config fault, because git parses
  config at startup before it validates arguments.
- `NOT_A_REPOSITORY` — outside a git repository.
- `WORK_TREE_REQUIRED` — the default (working-tree) target against a repository with no work tree (bare, or opened without one). Not raised for `'index'` or `{ treeish }` targets.
- `CONFIG_BAD_ZLIB_LEVEL` / `CONFIG_MISSING_VALUE` / `CONFIG_BAD_BOOLEAN_VALUE` — an invalid streaming-class `[core]` entry, reached through the eager operational gate every operational command reads (see [`errors.md`](../errors.md)).
- `CONFIG_BAD_NUMERIC_VALUE` — a malformed `core.maxTreeDepth` or `core.deltaBaseCacheLimit` — the repo-settings class, checked by an explicit call right after the gate and **before** the pattern-empty check above (so an empty-pattern call still reports the config fault, matching git, even though `grep` would otherwise reach this class structurally only once it walks the tree). See [`internals.md`](../primitives/internals.md#assertreposettingsvalid).
- `OBJECT_NOT_FOUND` — a `{ treeish }` target names a missing object, including a
  gitlink path (`HEAD:<submodule>`) or an index path (`:path`, `:<n>:path`) with no
  entry (`id` is the rev as spelt, as git's `unable to parse object: <name>`); also a
  commit whose tree header leads to a blob or a missing object (`id` is that commit).
  A malformed tag or commit inside a commit's tree chain refuses with its own parse
  code (`INVALID_TAG` / `INVALID_COMMIT`) rather than git's header-only read.
- `PATH_NOT_IN_TREE` — a `rev:path` target names no entry.
- `REVPARSE_UNRESOLVED` — a `{ treeish }` rev cannot be resolved.
- `GREP_LINE_TOO_LONG` — a single line's bytes exceed the JS engine's maximum
  string length and cannot be decoded to run a `RegExp` pattern (`length` /
  `limit` name the offending byte count and the decode ceiling). Only regex
  patterns can trigger this; `{ fixed }` patterns match on raw bytes and never
  decode.

## See also

- Primitives: [`readBlob`](../primitives/read-blob.md) · [`walkTree`](../primitives/walk-tree.md) · [`readIndex`](../primitives/read-index.md)
- Related commands: [`diff`](diff.md) · [`log`](log.md) · [`show`](show.md)
- ADRs: 395 (JavaScript `RegExp` grammar) · 396 (v1 command surface) · 397 (byte-offset bridge) · 1171 (blob result field) · 1172 (pathspec with a blob target) · 1173 (peel to tree or blob) · 1174 (line-wise binary verdict) · 1175 (`treeish` key kept) · 1176 (binary line count)
