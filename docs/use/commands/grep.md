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
- **Binary blobs.** A binary blob (NUL in the first 8 KiB — git's own rule, no
  line-length or line-count heuristic) is not line-scanned; if it contains a
  match the path is reported with `binaryMatch: true` and empty `hits` (git's
  `Binary file X matches`, exit 0).
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

// Lines NOT matching any pattern.
await repo.grep({ patterns: [/^\s*\/\//], invert: true });
```

## Throws

- `INVALID_OPTION` — `patterns` is empty (`option: 'patterns'`), or a `RegExp`
  carries the `u` flag (`option: 'pattern'`, unsupported over byte content).
  Checked **after** the repository gate below, matching git: `git grep` with
  no pattern in a repository carrying a malformed `[core]` entry reports the
  config fault, because git parses config at startup before it validates
  arguments.
- `NOT_A_REPOSITORY` — outside a git repository.
- `CONFIG_BAD_NUMERIC_VALUE` / `CONFIG_BAD_ZLIB_LEVEL` / `CONFIG_MISSING_VALUE` / `CONFIG_BAD_BOOLEAN_VALUE` — an invalid `[core]` entry, reached through the same eager operational gate every other operational command reads (see [`errors.md`](../errors.md)); includes an invalid `core.maxTreeDepth`.
- `OBJECT_NOT_FOUND` / `REVPARSE_UNRESOLVED` — a `{ treeish }` target cannot be
  resolved.
- `GREP_LINE_TOO_LONG` — a single line's bytes exceed the JS engine's maximum
  string length and cannot be decoded to run a `RegExp` pattern (`length` /
  `limit` name the offending byte count and the decode ceiling). Only regex
  patterns can trigger this; `{ fixed }` patterns match on raw bytes and never
  decode.

## See also

- Primitives: [`readBlob`](../primitives/read-blob.md) · [`walkTree`](../primitives/walk-tree.md) · [`readIndex`](../primitives/read-index.md)
- Related commands: [`diff`](diff.md) · [`log`](log.md) · [`show`](show.md)
- ADRs: 395 (JavaScript `RegExp` grammar) · 396 (v1 command surface) · 397 (byte-offset bridge)
