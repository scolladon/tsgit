# Design — Cosmetic-output sweep (`show` + `diff`)

## Goal

Enforce the **"structured output, not cosmetics"** rule (CLAUDE.md, ADR-249) across
the pre-rule command surface. The library returns **data**; representing it (date
formats, layout, abbreviation, unified-diff text, stat graphs) is the caller's job.
A command surface must not carry options whose only purpose is to steer rendered
text, nor return a pre-rendered line / `bytes`.

This is the sweep ADR-249 promised (it named `23.2a` and deferred superseding
ADR-240 to it). It is **breaking** → groups into a major version bump.

## Audit

Every tier-1 inspection command was audited for (a) options that exist only to
steer rendered text and (b) pre-rendered return fields.

| Command | Verdict | Cosmetic surface found |
|---|---|---|
| `log` | **complies** | none — `LogEntry` is pure data; all options are data selectors |
| `reflog` | **complies** | none — `selector` is an addressable `ref@{N}` key, not a rendered line |
| `status` | **complies** | none — `ChangeEntry` is pure data |
| `cat-file` | **complies** | none — `CatFileBatchEntry` carries a structured `GitObject` |
| `diff` | **offender** | `PatchResult.text` (rendered), `format`, `contextLines`, `pathPrefix` |
| `show` | **offender** | `text` on every result, `bytes` on output, and `format` / `date` / `stat` / `numstat` / `noPatch` / `mergeDiff` options + the whole `domain/show/*` subsystem |

So the sweep touches **`show` and `diff` only**; the other four are already compliant.

There is **no `--abbrev` output flag** to remove — the `abbrev` references in `src`
are all oid-*prefix input* resolution (rev-parse / `resolveOidPrefix`), which is
data resolution and stays.

## Decisions (settled with the owner)

1. **Scope / version** — sweep `show` + `diff` in **one breaking PR** (major bump),
   ahead of the rest of v3. Rationale: shrinking the rendered surface now limits
   what every later inspection command (`blame`, `shortlog`, …) must carry. This ADR
   also records `show`'s structured-only surface (dropping `bytes` / `text` and the
   `format` / `date` / `stat` / `numstat` / `noPatch` framing options) as the direct
   application of ADR-249's rule to `show`. → ADR-250.
2. **`diff` → `TreeDiff` only** — `diff()` returns the structured `TreeDiff`; the
   `PatchResult` wrapper, the rendered `text`, and the `format` / `contextLines` /
   `pathPrefix` options leave the command surface. `renderPatch` /
   `materialisePatchFiles` **stay in `src`** — `rebase` writes
   `.git/rebase-merge/patch` with `renderPatch` and `patch-id` hashes with it; they
   are simply no longer reachable through a command's return value. → ADR-251.
3. **`withStat` opt-in counts** — per-file line counts (`added` / `deleted` /
   `binary`) attach via a single `withStat` **data selector**, uniform across
   `diff()`, `show`'s `patch`, and each merge `perParent[i]`. Absent by default → no
   blob reads, the tree-level fast path is unchanged. `withStat` chooses *which
   fields exist*, so it is allowed under ADR-249 (it is not a text knob). → ADR-252.
4. **Counts live on `DiffChange`** — the counts are optional fields on each change
   inside the `TreeDiff`, not a separate `StatEntry[]` array and not a separate
   result type. No `--stat` / `--numstat` graph or width on the surface. The
   *counting* logic moves into the diff layer; the graph *rendering* moves to tests.
   → ADR-252 (same ADR as the selector).
5. **Merges → `perParent`** — a single-parent / root commit carries
   `patch?: TreeDiff`; a merge carries `perParent: ReadonlyArray<TreeDiff>` (one diff
   per parent). git's textual combined diff (`--cc`) has no structured form and is
   reconstructed in the interop test only. Chosen over a unified `parents[]` (which
   taxes every caller with array-indexing + a root edge case and duplicates
   `CommitData.parents`) and over "no patch on merges" (which forces extra `diff()`
   round-trips). → ADR-253.

> Five decisions, ADRs 250–253 (decision 3+4 share the counts ADR-252; merge shape
> is ADR-253). Numbering is finalised in the plan once written.

## Target surface

### `diff`

```ts
// before
diff(ctx, { format: 'patch', contextLines, pathPrefix, … }) -> PatchResult { format, text, diff }
diff(ctx, opts)                                              -> TreeDiff

// after
diff(ctx, opts?) -> TreeDiff
interface DiffOptions {
  readonly from?: string;
  readonly to?: string;
  readonly detectRenames?: boolean;
  readonly recursive?: boolean;
  readonly withStat?: boolean;   // NEW — opt-in line counts on each change
  // removed: format, contextLines, pathPrefix
}
```

`DiffFormat`, `PatchResult` leave the `diff` command surface.

### `DiffChange` (counts enrichment)

```ts
// tree-level (default; no blob reads) — unchanged shape
ModifyChange = { type:'modify', path, oldId, newId, oldMode, newMode }

// withStat: true — counts populated on each change
ModifyChange = { type:'modify', path, oldId, newId, oldMode, newMode,
                 added, deleted, binary }
```

Counts are modelled so the typed presence matches the request (`withStat:true`
overload yields a change variant with counts guaranteed; default yields the
tree-level variant). The exact typing (always-optional fields vs. an overload-keyed
variant) is finalised in the plan; the *surface* decision — counts on the change,
gated by `withStat` — is fixed.

### `show`

```ts
// after
show(ctx, rev: string,            opts?: ShowOptions) -> ShowResult
show(ctx, revs: ReadonlyArray<…>, opts?: ShowOptions) -> ReadonlyArray<ShowResult>

interface ShowOptions { readonly withStat?: boolean; }   // only remaining option

type ShowResult =
  | { kind:'commit'; id; commit: CommitData; patch?: TreeDiff }              // 0–1 parent
  | { kind:'commit'; id; commit: CommitData; perParent: ReadonlyArray<TreeDiff> } // merge
  | { kind:'tag';    id; tag: TagData; target: ShowResult }
  | { kind:'tree';   id; entries: ReadonlyArray<ShowTreeEntry> }
  | { kind:'blob';   id; content: Uint8Array };
```

Removed: `text` on every variant, `bytes` on the output, the `ShowOutput` wrapper,
`stat` (folded into `withStat` counts on the diff), `perParent: PatchResult[]`
(now `TreeDiff[]`), and `ShowOptions.{ format, date, stat, numstat, noPatch,
mergeDiff }` + `ShowStatOptions` + `MergeDiffMode`. Multi-rev input returns one
result per rev in order, **no stream de-duplication** (ADR-241's de-dup is a
rendering artifact; the caller de-dups when rendering).

`show`'s diffs keep rename detection on by default (ADR-242 — a data behavior, not
cosmetic) and stay recursive. The `<rev>:<path>` rev-parse grammar (ADR-245) is
data resolution and is untouched.

## What moves where

| Code | Fate |
|---|---|
| `domain/show/*` (21 files: pretty, date, decoration, combined-diff, diff-stat **graph**, render-commit/tag/tree, show-stream, identity-header, message-indent, safe-path, strftime, git-date) | **Deleted from `src`**, reconstruction relocated to a test-side module |
| `application/commands/internal/show-{options,combined,decoration}.ts` | **Deleted** |
| `diff-stat` **counting** (`buildStatEntries` core) | **Moves into the diff layer** to feed `withStat` |
| `renderPatch`, `materialisePatchFiles` | **Stay in `src`** — internal consumers (`rebase` write-surface, `patch-id`); no longer command-reachable |
| `domain/diff/patch-serializer` (`PatchOptions`, `PatchPathPrefix`) | Stays for `renderPatch`; `PatchPathPrefix` drops from the public command surface |

## Faithfulness strategy (the prime directive still binds the bytes — in tests)

ADR-226's prime directive binds git's observable **bytes**; ADR-249 clarifies that
for human-readable stdout the binding is pinned **in the interop test**, not on the
library surface. So:

- **`diff` parity** (`diff-patch-git-parity`, `diff-patch`): reconstruct the patch
  from the returned `TreeDiff` via `materialisePatchFiles` + `renderPatch` (both
  still in `src`), then compare to live `git diff` + the frozen golden. The
  assertion moves from `sut.text` to `renderPatch(materialise(sut.changes))`.
- **`show` parity** (`show-interop`): a new test-side reconstruction module
  (the relocated *default* renderers — `render-commit` / `render-tag` /
  `render-tree` / `identity-header` / `git-date` / `message-indent` /
  `show-stream`) rebuilds git's **default** `git show` stream from the structured
  `ShowResult`, then compares to live `git show`; merges are pinned against `git
  show -m` (one block per parent), mirroring `perParent`. The removed features
  (`--pretty` / `--date` / `--stat` / `-c`/`--cc` / decoration) leave no library
  bytes to pin, so their rendering code **and** tests are deleted, not relocated —
  reconstructing them would only test the reconstruction's own oracle.

The default `git show` output is reproducible from the structured fields, which is
the completeness proof; nothing the library still emits loses its byte-pin.

## Consumer / barrel impact

- `repository.ts` — `show` / `diff` bindings: return types change; `ShowOutput`
  gone. `withStat` threads through.
- `application/commands/index.ts`, `src/index.ts` — drop `ShowOutput`,
  `ShowStatOptions`, `MergeDiffMode`, `DiffFormat`, `PatchResult` (and `PatchPathPrefix`
  if currently re-exported) from the public surface; `ShowResult` reshaped.
- `reports/api.json` — regenerated (large typedoc-id churn is expected; prepush
  `check:doc-typedoc` gate requires committing it).
- Docs — `docs/use/commands/show.md`, `…/diff.md`, `docs/understand/design-decisions.md`
  (ADR index), README "structured output" framing.

## ADRs superseded

- ADR-240 (`show` `bytes`/`text`) — **superseded** by ADR-250.
- ADR-241 (`show` multi-rev de-dup + separators) — the *rendering* half superseded
  (de-dup relocates to the interop reconstruction); structured output returns one
  result per input rev.
- ADRs 244–248 (`show` v2 flags: pretty, date, stat, combined, rev:path framing) —
  the *rendering* halves superseded; the data-resolution halves (e.g. `<rev>:<path>`
  grammar) retained. Recorded per-ADR.
- ADRs 166–169 (`diff` patch format) + ADR-243 (recursive flag's patch coupling) —
  the rendered-`text` exposure superseded by ADR-251; the recursive `TreeDiff`
  behavior retained.

## Risks / mitigations

- **Large relocation** (~1400 LOC `domain/show` → test). Mechanical; mitigated by
  doing it as its own atomic commit after the structured surface lands, with the
  interop suite proving byte-parity throughout.
- **`withStat` typing** (optional-fields vs overload variant) — settle in the plan;
  prefer the overload variant so `withStat:true` callers get counts without `?`
  narrowing, mirroring today's `format:'patch'` overload.
- **Mutation on the new counting path** — the relocated counting logic needs its own
  unit + mutation coverage in the diff layer (the show-side tests previously covered
  it through `buildStatEntries`).

## Slice preview (detail in `docs/plan/cosmetic-output-sweep.md`)

1. `withStat` counts on `DiffChange` + diff-layer counting (domain + primitive).
2. `diff` command → `TreeDiff` only; relocate diff patch parity to reconstruct.
3. `show` command → structured-only union + `perParent`; `withStat` thread-through.
4. Delete `domain/show/*` + show internals; relocate show byte reconstruction into
   the interop test module.
5. Barrel / `repository.ts` / `api.json` surface updates.
6. Docs refresh + BACKLOG flip.
