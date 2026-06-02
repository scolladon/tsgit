# Design — `show` (formatted object output)

> Phase 23.1. Faithful `git show` for commit / tag / tree / blob objects: a
> Tier-1 `repo.show(...)` command returning structured per-object results
> **plus** the byte-faithful rendered stream `git show` would print.

## 1. Scope

`git show <object>…` resolves each revision to an object and renders it by
type. v1 covers the four object kinds and the multi-revision arg list:

- **commit** — `commit <oid>` header, optional `Merge:` line, `Author:` /
  `Date:` (author identity, author timezone), the 4-space-indented message,
  and (for non-merge commits) the unified-diff patch against the first parent
  (root commits diff against the empty tree).
- **tag** (annotated) — `tag <name>` header, optional `Tagger:` / `Date:`, the
  **verbatim** (un-indented) message, then the recursively-shown target object.
- **tree** — `tree <input-rev>` header, blank line, the immediate entry names
  (sorted, `/` suffix for sub-trees). Non-recursive.
- **blob** — the raw content bytes, verbatim.

Default revision is `HEAD`. Multiple revisions render in input order with
git's `shown_one` separator semantics (§5). A `contextLines` option threads
into every commit patch.

### 1.1 Deferred (not v1)

`-s` / `--no-patch`, `--format` / `--pretty`, `--stat` / `--numstat`,
`<rev>:<path>` blob lookup, combined merge diffs (`-c` / `-m` / `--cc`),
alternate `--date=` modes, and `--follow`. Each is an additive option on the
same return shape — none forces a breaking change later.

## 2. Faithfulness spec (verified against real `git`)

All formats below were observed against canonical `git show` with scrubbed
`GIT_*` and signing off, and are pinned by cross-tool interop (§9).

### 2.1 Date format (default `medium` / `DATE_NORMAL`)

```
<WeekDay> <Mon> <D> <HH>:<MM>:<SS> <YYYY> <±ZZZZ>
e.g.  Wed Nov 15 00:13:20 2023 +0200
```

- `WeekDay` / `Mon`: English three-letter abbreviations.
- `D`: day-of-month, **unpadded** (`2`, not `02` or ` 2`).
- `HH:MM:SS`: zero-padded to two digits.
- `YYYY`: full year.
- `±ZZZZ`: the identity's stored `timezoneOffset` string, verbatim, preceded
  by one space.
- Wall-clock components are the **UTC components of `timestamp + tzOffset`** —
  the time is shown in the identity's own zone, independent of the host clock.

### 2.2 Commit block

```
commit <full-oid>\n
[Merge: <p1-abbrev> <p2-abbrev> …\n]      ← only when parents.length ≥ 2
Author: <author.name> <author.email>\n
Date:   <gitDate(author)>\n
\n
<indented message>\n
[\n<patch>]                               ← only when NOT a merge AND patch ≠ ∅
```

- The header uses the **resolved oid** (not the input rev string).
- `Merge:` lists every parent's abbreviated oid (7 chars, matching the patch
  serializer's `OID_ABBREV_LENGTH`), space-separated.
- **Merge commits show no patch** (git's default). Non-merge commits show the
  patch against `parents[0]`'s tree; root commits (no parents) against the
  empty tree.
- **Indented message** — each message line is prefixed with four spaces;
  leading and trailing blank lines (whitespace-only, git's `is_blank_line`)
  are stripped; interior blank lines are kept and become `····` (four spaces).
- An empty patch (no tree changes) emits no `\n<patch>` tail; the block ends
  after the message.

### 2.3 Tag block (annotated)

```
tag <tag.tagName>\n                       ← stored tag name, NOT the input rev
[Tagger: <tagger.name> <tagger.email>\n
Date:   <gitDate(tagger)>\n]              ← only when a tagger is present
\n
<verbatim message>\n                      ← NOT indented
```

The tagged object is rendered **separately**, joined by the `shown_one`
separator (§5) — it is not part of the tag block text. Tag → tag → commit
nesting falls out of the recursive walk.

### 2.4 Tree listing

```
tree <input-rev-verbatim>\n               ← echoes the user's rev string
\n
<name>[/]\n …                             ← stored sorted order; `/` iff mode 040000
```

Only immediate children, names only (no mode, no oid). The header echoes the
**input revision string verbatim** (`tree HEAD^{tree}`, `tree <oid>`, …) — the
sole place `show` surfaces the caller's input rather than a resolved value.

### 2.5 Blob

Raw `content` bytes, verbatim. No header, no trailing manipulation.

## 3. Public API

```ts
export type ShowInput = string | ReadonlyArray<string>;

export interface ShowOptions {
  /** Context lines bracketing each hunk in commit patches. Default 3. */
  readonly contextLines?: number;
}

export interface ShowTreeEntry {
  readonly name: string;
  readonly mode: FileMode;
  readonly id: ObjectId;
}

export type ShowResult =
  | ShowCommitResult
  | ShowTagResult
  | ShowTreeResult
  | ShowBlobResult;

export interface ShowCommitResult {
  readonly kind: 'commit';
  readonly id: ObjectId;
  readonly commit: CommitData;
  readonly patch?: PatchResult;   // omitted for merge commits
  readonly text: string;          // self-contained `git show <commit>` block
}

export interface ShowTagResult {
  readonly kind: 'tag';
  readonly id: ObjectId;
  readonly tag: TagData;
  readonly target: ShowResult;    // recursively-shown tagged object
  readonly text: string;          // tag block ONLY (header + message)
}

export interface ShowTreeResult {
  readonly kind: 'tree';
  readonly id: ObjectId;
  readonly entries: ReadonlyArray<ShowTreeEntry>;
  readonly text: string;          // `tree <input>\n\n<names>`
}

export interface ShowBlobResult {
  readonly kind: 'blob';
  readonly id: ObjectId;
  readonly content: Uint8Array;
}

export interface ShowOutput {
  /** One result per input rev, in input order. */
  readonly objects: ReadonlyArray<ShowResult>;
  /** Byte-faithful `git show <input…>` stream (§5). */
  readonly bytes: Uint8Array;
}

export function show(ctx: Context, input?: ShowInput, opts?: ShowOptions): Promise<ShowOutput>;
```

Bound on the facade as `repo.show(input?, opts?)`.

**Why `text` (string) per object _and_ `bytes` (Uint8Array) at the top.** The
text-oriented kinds (commit / tree / tag block) expose an ergonomic `string`;
the blob exposes raw `content`. `bytes` is the authoritative deliverable — the
exact stream `git show` prints — and is the only shape that can faithfully
carry binary blobs and the multi-object join. Mirrors `diff`'s `{ text, diff }`
dual return (ADR-240).

**`objects` is per-arg; `bytes` is deduped.** `objects[i]` always corresponds
to `input[i]` (every arg gets a structured result). `bytes` applies git's
commit de-duplication and separators (§5), so a commit listed twice appears
twice in `objects` but is rendered once in `bytes` (ADR-241).

## 4. Architecture

Dependency rule preserved (`repository → commands → primitives → domain`).

```
src/domain/show/                         ← NEW pure rendering subsystem
  git-date.ts        formatGitDate(timestamp, tzOffset): string
  render-commit.ts   renderCommitBlock(parts): string
  render-tag.ts      renderTagBlock(tag): string
  render-tree.ts     renderTreeListing(inputName, entries): string
  show-stream.ts     renderShowStream(results): Uint8Array   (shown_one machine)
  message-indent.ts  indentMessage(message): string
  index.ts

src/application/commands/show.ts          ← NEW Tier-1 command (orchestration)
```

- **`domain/show/`** is pure (no platform deps), the display analogue of
  `domain/diff/`. The date formatter lives here because later Phase 23 readers
  (`describe`, `blame`, `shortlog`, `whatchanged`) format dates the same way;
  promotion stays a no-op import change if they need it (YAGNI — not shared
  pre-emptively beyond `show`).
- **`commands/show.ts`** resolves revs, reads objects, builds each
  `ShowResult` (computing commit patches, recursing into tag targets), and
  composes `bytes` via `renderShowStream`.

### 4.1 Reused machinery (no new primitives)

- **Revision resolution** — `revParse(ctx, rev)` (the full grammar:
  `HEAD~2`, `HEAD^{tree}`, `v1.0`, abbreviated oids). It does **not** auto-peel
  annotated tags, so a tag ref resolves to the tag object — exactly what
  `show` needs to render the `tag` header. Command→command reuse mirrors
  `pull` → `fetch`/`merge`.
- **Object reads** — `readObject(ctx, oid)`.
- **Commit patch** — `diffTrees(ctx, parentTree?, commitTree, { detectRenames: true })`
  → `materialisePatchFiles` → `renderPatch(files, { contextLines })`. The
  existing `diff` command already wires this trio; `show` reuses it with
  rename detection **on** (git's `diff.renames` default — ADR-242) and the
  caller's `contextLines`.

## 5. Stream composition — the `shown_one` state machine

`renderShowStream(results)` walks the top-level results with two pieces of
state, faithfully reproducing `builtin/log.c`'s `cmd_show` separator logic:

```
shownOne = false
shownCommits = ∅
for each top-level result → emit(result):

  emit(commit):
    if commit.id ∈ shownCommits: return            ← git's SHOWN-flag dedup
    if shownOne: append '\n'                        ← inter-entry separator
    append encode(commit.text); shownOne = true; shownCommits.add(commit.id)

  emit(tree):
    if shownOne: append '\n'
    append encode(tree.text); shownOne = true

  emit(blob):
    append blob.content                             ← never reads/sets shownOne

  emit(tag):
    if shownOne: append '\n'
    append encode(tag.text); shownOne = true
    emit(tag.target)                                ← target inherits shownOne ⇒ its own '\n'
```

Verified rules (all observed against real git):

- The `\n` separator is emitted **before** each commit / tree / tag entry once
  anything has already been shown — never after the last, never for the first.
- **Blobs** neither emit nor consume the separator (raw dump); a commit
  following a blob gets **no** separator.
- The **tag → target** blank line is the same `shown_one` separator (the tag
  sets `shownOne`, the target consumes it) — no special-case code.
- **Commits de-duplicate** by oid across the whole arg list (and tag targets,
  since they share the recursion) — `git show A B A` shows `A` once. Blobs,
  trees, and tags are **not** deduped.

## 6. Date math (pure)

```
offsetSeconds = sign · (HH·3600 + MM·60)      from `±HHMM`
local         = new Date((timestamp + offsetSeconds) · 1000)
components    = local.getUTC{Day,Month,Date,Hours,Minutes,Seconds,FullYear}
```

The timezone string itself is the identity's stored `timezoneOffset` (already
validated `^[+-]\d{4}$` by `parseIdentity`), printed verbatim. Negative /
pre-epoch timestamps are handled natively by `Date`.

## 7. Error handling

- `assertRepository(ctx)` first (every Tier-1 command).
- Unresolvable revs propagate `revParse`'s `REVPARSE_UNRESOLVED` /
  `OBJECT_NOT_FOUND` / `AMBIGUOUS_OID_PREFIX` — faithful failure surface.
- A malformed object propagates the object parser's typed error
  (`INVALID_COMMIT` / `INVALID_TAG` / `INVALID_TREE_ENTRY`).
- No new error codes: every refusal `show` can hit already exists.

## 8. Object Calisthenics / style

- Branded `ObjectId` / `FileMode` cross every boundary; no primitive oids.
- Each renderer is a small pure function (<20 lines); early returns; no
  mutation of inputs (the `shown_one` walk builds a fresh byte array).
- The discriminated union is `readonly` throughout; dispatch is exhaustive
  `switch (kind)` with no `default` fall-through.

## 9. Test strategy

### 9.1 Unit (example + property)

- `git-date.properties.test.ts` — the formatter is a **total function over a
  grammar** (lens 3) and a **round-trip-ish projection**: property — for any
  safe `(timestamp, ±HHMM)`, output matches `^<WeekDay> <Mon> \d{1,2} \d2:\d2:\d2 \d{4} ±HHMM$`
  and re-parses to the same wall-clock components. Example tests pin the
  literal `Wed Nov 15 00:13:20 2023 +0200` corners (single-digit day, negative
  tz, pre-epoch).
- `message-indent` — example tests for {subject-only, subject+body,
  leading-blank, trailing-blank, all-blank, interior-blank, CRLF}; the
  leading/trailing-strip + interior-keep rules each isolated.
- `render-commit` / `render-tag` / `render-tree` — example tests per format,
  including merge (`Merge:` + no patch), root (empty-tree patch), no-tagger
  tag, sub-tree `/` suffix.
- `show-stream` — the separator matrix as isolated tests: commit→commit,
  blob→commit (no sep), tree→commit (sep), blob→blob (raw), tag→target,
  commit dedup (`A B A`).

### 9.2 Integration (memory adapter)

`show.test.ts` — `repo.show()` end-to-end per kind, `objects` structure +
`bytes`, default-HEAD, multi-rev, `contextLines` passthrough, error
propagation for a bad rev.

### 9.3 Cross-tool interop (`test/integration/show-interop.test.ts`)

The faithfulness gate. Build fixtures with real `git` (scrubbed env, signing
off), then assert `repo.show(rev).bytes` **byte-equals** `git show <rev>`:
commit (subject+body), root commit, merge commit, annotated tag, lightweight
tag (renders as commit), tree (by `^{tree}` and by raw oid), blob,
multi-rev (`A B`), tag→commit, rename patch (`similarity index` /
`rename from` / `rename to`), and the `contextLines` patch. Mutation-resistant:
assert the exact bytes, not just structural shape.

### 9.4 Coverage / mutation

100% line/branch/function/statement; 0 killable mutants. Error assertions on
`.data.code`; guard clauses isolated; date-component edges tested
independently to kill arithmetic / string-literal mutants.
