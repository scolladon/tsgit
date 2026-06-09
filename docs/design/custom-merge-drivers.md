# Design — Custom merge drivers (`.gitattributes` `merge=<driver>`)

## Goal

Make the three-way content merge that underlies `merge` / `cherry-pick` / `revert` /
`rebase` / `stash` honour git's per-path **merge driver** selection:

1. **`.gitattributes` `merge=<driver>` resolution** — parse `.gitattributes` (net-new;
   only `.gitignore` exists today) and resolve the `merge` attribute for a path.
2. **`[merge "<driver>"]` driver invocation** — when the resolved driver names a
   configured external command, run it (shell, temp files, placeholder substitution,
   exit-code → clean/conflict) instead of the built-in line merge.

Layered **over** the existing `domain/merge/` content merge — the built-in path stays the
default; drivers are an opt-in override on the `ContentMerger` seam already threaded
through `mergeTrees`.

Faithfulness (prime directive): the merged blob bytes, conflict markers, index stages, and
worktree state must match canonical `git` byte-for-byte for the same `.gitattributes` +
`[merge]` config, pinned by a cross-tool interop test.

## Background — the existing seam

`domain/merge/three-way-tree.ts` already abstracts content merging behind a `ContentMerger`
callback:

```ts
export type ContentMerger = (
  ctx: ContentMergeContext,   // { path, baseId, ourId, theirId, …modes }
  base, ours, theirs,         // unused placeholders — the closure reads blobs via ids
) => Promise<ContentMergeResult> | ContentMergeResult;
```

`mergeTrees` calls it once per path that needs a content merge (both sides modified
differently, same kind, non-gitlink). The result is `{status:'clean', bytes|id}` or
`{status:'conflict', markedBytes, conflictType}`.

Today **two** near-identical `buildContentMerger(ctx)` closures construct this callback:

- `commands/merge.ts` (its own, used via `mergeTrees` directly).
- `primitives/apply-merge-to-worktree.ts` (used by cherry-pick / revert / rebase / stash).

Both read the three blobs (capped at `MAX_CONFLICT_OUTPUT_BYTES`) and call
`mergeContent(base, ours, theirs)`. **The merge-driver dispatch belongs exactly here** — at
the single point where a path's three blobs are about to be line-merged. Consolidating the
two closures into one shared, driver-aware primitive is therefore part of this feature
(not a deferred refactor): it is the enabling change.

## Architecture

```
domain/attributes/                      (net-new, pure)
  parse-gitattributes.ts   parseGitattributes(text) → AttributesFile
  attribute-value.ts       AttributeValue = true | false | 'unspecified' | { set: string }
  resolve-attribute.ts     resolveAttribute(sources, path, name) → AttributeValue
  macros.ts                built-in `binary` macro + user [attr] expansion
  driver-command.ts        substituteDriverPlaceholders(template, {O,A,B,L,P}) → string
  index.ts

ports/
  command-runner.ts        (net-new) CommandRunner — run a shell command line

adapters/node/
  node-command-runner.ts   (net-new) sh -c via node:child_process

application/primitives/
  internal/read-gitattributes.ts   load + parse the attribute sources (mirrors read-gitignore)
  resolve-merge-driver.ts          (path → MergeDriverChoice) over attributes + config
  build-content-merger.ts          (net-new shared) the driver-aware ContentMerger factory
                                    — replaces both buildContentMerger closures
  run-merge-driver.ts              orchestrate temp files (via ctx.fs) + CommandRunner

application/primitives/config-read.ts   ParsedConfig gains `merge: Map<name,{name,driver,recursive}>`
```

**Dependency rule** honoured: `domain/attributes` is pure (depends only on `domain/pathspec`
for glob compile, like `domain/ignore`). The `CommandRunner` port sits between application
and adapters. The primitive orchestrates I/O; the domain stays byte-pure.

## Sub-dependency 1 — `.gitattributes` parsing (net-new)

Git's attribute line grammar (`gitattributes(5)`):

```
<pattern> <attr1> <attr2> ...
[attr]<macroname> <attr1> <attr2> ...    # macro definition
```

- **Pattern** uses `.gitignore` glob syntax (fnmatch, leading `/` anchor, `**`, trailing `/`
  for dir-only) **but negation (`!`) is forbidden**. A pattern may be `"…"`-quoted (C-style
  escapes) when it contains spaces.
- **Attribute token** forms: `name` (set → `true`), `-name` (unset → `false`), `!name`
  (unspecified → explicitly remove), `name=value` (set to string).
- **Comment / blank** lines (`#`, whitespace-only) are skipped.
- **Macro**: `[attr]binary` etc. A macro expands to its listed attributes when matched. The
  one built-in macro is `binary = -diff -merge -text`. Macros are only valid in the top-level
  `.gitattributes` / `info/attributes` / global file (we honour them wherever they appear,
  matching git's leniency, but only the built-in `binary` is auto-registered).

We reuse `domain/pathspec` `compileGlob` for pattern matching — same engine `.gitignore`
uses. The parser stores **all** attribute tokens generically (a `Map<name, AttributeValue>`
per rule) so future consumers (diff drivers, filters, `text`/`eol`) extend without a
re-parse; **this feature only reads the `merge` attribute.**

### Attribute resolution & precedence

For a path `P`, git consults sources highest-precedence first; within a file the **last**
matching line wins for a given attribute; the first source that assigns the attribute wins:

1. `$GIT_DIR/info/attributes` (highest)
2. `.gitattributes` in `P`'s directory, then each parent up to the worktree root (closer =
   higher)
3. global `core.attributesFile` (lowest)
4. built-in macros

(System-wide `/etc/gitattributes` is a documented non-goal — tsgit has no system config
layer anywhere.) Merge reads the **worktree** `.gitattributes` (the checked-out version),
matching git and reusing the exact source model `read-gitignore` already implements.

Resolution returns one of: `true` (set), `false` (unset), `'unspecified'`, `{ set: value }`.

## Sub-dependency 2 — `[merge "<driver>"]` config

`config-read.ts` `ParsedConfig` gains:

```ts
readonly merge?: ReadonlyMap<string, {
  readonly name?: string;     // human label ("merge.<d>.name") — used only for messages
  readonly driver?: string;   // the command line with %O %A %B %L %P
  readonly recursive?: string;// driver to use for the recursive inner merge
}>;
```

Parsed via the existing `dispatchSection` / `mergeXxx` pattern (subsection = driver name,
case-insensitive keys).

## Driver resolution (`resolve-merge-driver.ts`)

Given the resolved `merge` attribute value for a path:

| `merge` attribute        | choice                                                          |
|--------------------------|-----------------------------------------------------------------|
| `'unspecified'` / `true` | **built-in text** → `mergeContent` (default)                    |
| `false` (or via `binary` macro) | **binary** → take `ours`, declare conflict (git's `-merge`) |
| `{ set: 'text' }`        | built-in text                                                   |
| `{ set: 'binary' }`      | binary (take ours, conflict)                                    |
| `{ set: 'union' }`       | **deferred** (ADR-303) → falls back to built-in text for now    |
| `{ set: 'name' }` with `[merge "name"].driver` | **external command**                      |
| `{ set: 'name' }` no `driver` configured | fall back to built-in text (git's behaviour)    |

Per ADR-303, this feature ships `text` + `binary` + external `driver=<command>`. `union` is
deferred to a backlog follow-up tied to the per-region merge rework (tsgit's content merge
can only produce whole-file conflict granularity today, so a byte-exact `union` for
overlapping regions needs that rework first). Sources, precedence and macros follow ADR-302;
the `CommandRunner` port + temp-file orchestration follow ADR-304.

The `binary` outcome maps onto the existing `{status:'conflict', conflictType:'binary',
markedBytes: ours}` that `mergeContent` already emits for binary content — so the
`apply-merge-to-worktree` / `merge` conflict materialisation paths are unchanged.

## External driver invocation

When the choice is an external command:

1. Read base/ours/theirs blob bytes (already done by the content-merger closure).
2. `run-merge-driver.ts` writes them to temp files under `${gitDir}` via `ctx.fs`
   (sandbox-safe; the real subprocess can read them because node's `ctx.fs` writes real
   files). `%A` starts as the `ours` bytes (git's convention — the driver edits it in place).
3. `substituteDriverPlaceholders(template, {O,A,B,L,P})` (pure) builds the final command
   string. `%L` = conflict marker size (default **7**; the `conflict-marker-size` attribute /
   `merge.conflictMarkerSize` config are a documented follow-up). `%P` = the repo-relative
   pathname. `%%` → `%`. Raw substitution (git does not shell-quote — faithful).
4. `ctx.command.run({ command, cwd: workDir, env: { GIT_DIR }, signal })` runs `sh -c
   "<command>"`.
5. Read `%A` back → result bytes. `exitCode === 0` → `{status:'clean', bytes}`;
   non-zero → `{status:'conflict', conflictType:'content', markedBytes}` (git: non-zero means
   the driver left conflict markers it could not resolve). Delete temp files.

**No runner wired** (memory / browser): fall back to built-in text merge — the hooks-inert
precedent (ADR-068/299). A documented environment limitation, ADR'd.

### `CommandRunner` port

```ts
export interface CommandRequest {
  readonly command: string;            // shell command line, run via `sh -c`
  readonly cwd: string;
  readonly env: Readonly<Record<string,string>>;
  readonly signal?: AbortSignal;
}
export type CommandResult = { readonly exitCode: number };  // drivers communicate via %A, not stdout
export interface CommandRunner { readonly run: (r: CommandRequest) => Promise<CommandResult>; }
```

Optional on `Context` (`ctx.command?`). Node adapter wires `NodeCommandRunner` (mirrors
`NodeHookRunner`: injectable `spawn`, `cwd`, env, abort-kill, never rejects on non-zero
exit). Generic shape (shell exec) keeps file I/O on the `FileSystem` port and is reusable by
later external-tool features; temp-file orchestration lives in the primitive and is testable
with the memory adapter + a fake runner.

## Consolidating the two `buildContentMerger`

`primitives/build-content-merger.ts` exports the single driver-aware factory. Behaviour for a
path with no `merge` attribute and no matching driver is **identical** to today's
`mergeContent(base, ours, theirs)` — so `merge.ts` and `apply-merge-to-worktree.ts` both
delegate to it with zero behaviour change on the default path. Attribute/config reads are
cached per `Context` (like `readConfig`) so a multi-file merge parses `.gitattributes` once.

## Faithfulness pins

- `merge-driver-interop` (twin git/tsgit): a repo with `.gitattributes` `merge=custom`, a
  `[merge "custom"] driver = <script>` that produces a deterministic result, asserting blob
  bytes + index + worktree parity for clean (exit 0) and conflict (exit ≠ 0); plus
  `*.bin -merge` (binary take-ours conflict) and a `merge=text` no-op.
- `gitattributes` parsing pinned by example + property tests (round-trip / matcher
  invariants per the property-test lenses: parser + compositional matcher).
- Cross-adapter parity unchanged (memory falls back to built-in — documented divergence,
  asserted as such, not as git-parity).

## Test plan

- `domain/attributes/`: `parse-gitattributes.test.ts` + `.properties.test.ts`
  (round-trip + matcher invariants), `resolve-attribute.test.ts` (precedence, last-match,
  macros), `driver-command.test.ts` (placeholder substitution incl. `%%`, missing
  placeholders).
- `ports/command-runner.contract.ts` + memory fake.
- `adapters/node/node-command-runner.test.ts` (injected spawn — exit code, abort, env).
- `primitives/resolve-merge-driver.test.ts`, `run-merge-driver.test.ts` (temp-file
  lifecycle via memory fs + fake runner), `build-content-merger.test.ts` (default-path
  equivalence + each dispatch branch).
- `commands/merge.test.ts` / cherry-pick / revert / stash: a `merge=` driver case each (or a
  shared helper) proving the seam is live through every consumer.
- `test/integration/merge-driver-interop.test.ts` (real git).

GWT/AAA, `sut`, 100% coverage, 0 killable mutants. Error assertions specific (code + data).

## Out of scope (documented non-goals / follow-ups)

- **`union` built-in driver** — deferred (ADR-303); backlog follow-up tied to the per-region
  merge rework so it lands byte-exact. Falls back to text until then.
- `conflict-marker-size` attribute / `merge.conflictMarkerSize` config (`%L` fixed at 7).
- Label placeholders `%S %X %Y`.
- `recursive` driver selection (tsgit merges against a single base; parsed but inert —
  documented).
- Diff drivers, filters (`clean`/`smudge`), `text`/`eol`/`working-tree-encoding`
  attributes — the parser stores them generically but no consumer reads them yet.
- **System-wide `/etc/gitattributes`** — parked (ADR-302); tsgit has no system-config layer
  anywhere. A backlog parking-lot item, revisited only on community traction.
- Server-side / browser driver execution (no `CommandRunner` ⇒ built-in fallback).
