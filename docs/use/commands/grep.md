# `grep`

Search tracked content for a pattern — git's `git grep`, with one deliberate
divergence: **the pattern is a JavaScript `RegExp`, not git's POSIX grammar**
(see Divergences). Returns **structured data only**: per matching path, the
matching lines with 1-based line numbers, the raw line bytes, and byte-offset
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
interface GrepPathResult {
  readonly path: FilePath;
  readonly hits: ReadonlyArray<GrepLineHit>;
  readonly binaryMatch: boolean;   // binary blob contained a match; hits empty
}
interface GrepResult {
  readonly paths: ReadonlyArray<GrepPathResult>; // only paths with a hit or binaryMatch
}
```

## Options

| Field | Type | Default | Meaning |
|---|---|---|---|
| `patterns` | `ReadonlyArray<RegExp \| { fixed: string }>` | (required, ≥1) | Patterns to search. A `RegExp` searches by JS regex (flags ride on it: `i` for case-insensitive, `s`, `m`); a `{ fixed }` searches a literal substring. Multiple patterns are **OR-combined** (git's `-e … -e …`). |
| `wholeWord` | `boolean` | `false` | git's `-w` — a match counts only when the byte before its start and the byte at its end are non-word bytes (`[A-Za-z0-9_]`). Applied to both regex and fixed forms. |
| `invert` | `boolean` | `false` | git's `-v` — return the lines that do **not** match. Inverted line hits carry empty `spans`. |
| `target` | `'index' \| { treeish }` | working tree | Absent ⇒ the **working tree** (tracked files, working-tree content). `'index'` ⇒ the staged content (git's `--cached`). `{ treeish: 'HEAD' }` ⇒ a committed tree/commit (full rev grammar). |
| `paths` | `ReadonlyArray<string>` | (all) | Pathspec limiter — only enumerated paths matching the pathspec are searched. |

## Behaviour

- **Targets.** The default (working-tree) target enumerates **tracked** files (the
  index, stage 0) and reads their **working-tree** content, so unstaged
  modifications are visible; untracked and ignored files are not searched.
  `'index'` reads staged blob content; `{ treeish }` reads a committed tree.
- **Searchable content.** Only regular and executable file blobs are searched;
  **symlinks and gitlinks (submodules) are skipped** on every target — matching
  `git grep`. A tracked file absent from the working tree is silently skipped.
- **Binary blobs.** A binary blob (NUL in the first 8 KiB, or over-long lines) is
  not line-scanned; if it contains a match the path is reported with
  `binaryMatch: true` and empty `hits` (git's `Binary file X matches`, exit 0).
- **Line numbering** is 1-based; `line` carries the raw bytes including the
  trailing LF that `splitLines` preserves.
- **Match spans** are **byte offsets** into `line` — `line.subarray(start, end)`
  is exactly the matched bytes.

### Caller projections (the library ships data, not rendering)

- **`path:line:text`** — for each `hit`, `${path}:${hit.lineNumber}:${decode(hit.line)}`.
- **`-c` (count):** `result.paths.map(p => ({ path: p.path, count: p.binaryMatch ? 1 : p.hits.length }))`.
- **`-l` (name-only):** `result.paths.map(p => p.path)`.
- **`Binary file X matches`:** emit for each `p` with `p.binaryMatch === true`.

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
  whose only match lies beyond the first 64 KiB is not reported as `binaryMatch`. This
  bounds the work a caller `RegExp` can do over an unbounded binary blob (the text path
  is already bounded per line). Binary blobs are an incidental search target, so the
  window is a deliberate safety bound.

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

// Lines NOT matching any pattern.
await repo.grep({ patterns: [/^\s*\/\//], invert: true });
```

## Throws

- `INVALID_OPTION` — `patterns` is empty (`option: 'patterns'`), or a `RegExp`
  carries the `u` flag (`option: 'pattern'`, unsupported over byte content).
- `OBJECT_NOT_FOUND` / `REVPARSE_UNRESOLVED` — a `{ treeish }` target cannot be
  resolved.

## See also

- Primitives: [`readBlob`](../primitives/read-blob.md) · [`walkTree`](../primitives/walk-tree.md) · [`readIndex`](../primitives/read-index.md)
- Related commands: [`diff`](diff.md) · [`log`](log.md) · [`show`](show.md)
- ADRs: 395 (JavaScript `RegExp` grammar) · 396 (v1 command surface) · 397 (byte-offset bridge)
