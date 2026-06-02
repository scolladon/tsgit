# Design — `show` v2 flags

> Deferred follow-up to 23.1 (documented in `show-object-output.md` §1.1). Six
> additive flag-groups on the existing `ShowResult` / `ShowOptions` shape — no
> breaking change. Every format below was observed against canonical `git show`
> (scrubbed `GIT_*`, signing off) and is pinned by extending `show-interop`.

## 0. Major finding that reframes scope

`git show <merge>` does **not** default to "no patch". It defaults to a **dense
combined diff** (`--cc`). 23.1's claim — "merge commits show no patch (git's
default)" — held only because its interop fixture used a *trivial* merge whose
combined diff is empty. On a merge that actually combined changes from both
sides, current `show` emits the wrong bytes (header + trailing blank, no diff;
git emits a `diff --cc`). So combined-diff support is **not purely additive** —
it closes a latent default-merge faithfulness bug. The empty-combined-diff case
still renders exactly the current "trailing blank, no patch" output, so the
existing trivial-merge interop case keeps passing.

## 1. Scope (six flag-groups, all in this PR)

| group | flags | summary |
|---|---|---|
| suppress | `-s` / `--no-patch` | render header + message only |
| pretty | `--format` / `--pretty=<fmt>` | named formats + custom `format:`/`tformat:` placeholder engine + `email`/`mboxrd` + decoration |
| diffstat | `--stat[=<w>,<nw>,<count>]` / `--numstat` | diffstat / numeric stat in place of the patch |
| path | `<rev>:<path>` | read a blob/tree by path inside a tree-ish |
| merge-diff | `-m` / `-c` / `--cc` | per-parent / combined / dense-combined merge diffs; **dense is the merge default** |
| date | `--date=<mode>` | alternate date rendering for `Date:` + `%ad`/`%cd` |

ADR-decided breadth (ADRs 244–249): full combined diff incl. octopus,
`relative`/`human` dates (now-dependent — structural tests only), and the
`email`/`mboxrd` formats plus `%d`/`%D` decoration.

## 2. Public API (additive)

```ts
export type MergeDiffMode = 'none' | 'separate' | 'combined' | 'dense';

export interface ShowStatOptions {
  /** Total render width (git's terminal width). Default 80. */
  readonly width?: number;
  /** Max filename column width before truncation. Default derived. */
  readonly nameWidth?: number;
  /** Cap on listed files (`--stat=<w>,<nw>,<count>`). */
  readonly count?: number;
}

export interface ShowOptions {
  readonly contextLines?: number;              // existing
  /** `-s` / `--no-patch`: suppress all diff output. */
  readonly noPatch?: boolean;
  /** `--pretty` / `--format`: named (`oneline`…`mboxrd`) or `format:`/`tformat:`. Default `medium`. */
  readonly format?: string;
  /** `--date=<mode>`: see §8. Default `default`. */
  readonly date?: string;
  /** `--stat`: `true` for default width, or width overrides. */
  readonly stat?: boolean | ShowStatOptions;
  /** `--numstat`. */
  readonly numstat?: boolean;
  /** `-m`/`-c`/`--cc`. Default `dense` (git's `show` default for merges). */
  readonly mergeDiff?: MergeDiffMode;
}
```

All fields optional → zero breaking change. `ShowResult` gains optional
structured carriers without altering existing ones:

- `ShowCommitResult` gains `stat?: DiffStat`, `numstat?: ReadonlyArray<NumstatEntry>`,
  and for merges a `combined?: CombinedDiff` / `perParent?: ReadonlyArray<PatchResult>`.
  `patch` stays (single-parent / `-m` first parent). `text` remains the
  self-contained rendered block in the requested format.
- New `ShowBlobResult` / `ShowTreeResult` already cover `<rev>:<path>`.

Option strings (`format`, `date`) are validated at the command boundary
(input-validation rule); unknown values raise typed errors (§9), never silent
divergence.

## 3. Architecture

Dependency rule preserved (`repository → commands → primitives → domain`). All
rendering is pure `domain/show/`; the command orchestrates.

```
src/domain/show/
  date/
    git-date.ts        formatGitDate → the `default`/`normal` mode (existing, kept)
    date-mode.ts       parseDateMode(spec); formatDate(mode, ts, tz, now)
    iso.ts             iso / iso-strict / short / raw / unix
    rfc.ts             rfc2822 (also reused by email `Date:` + `%aD`)
    local.ts           local (host TZ; no offset suffix)
    relative.ts        show_date_relative(ts, now)        ← now-dependent
    human.ts           show_date_human(ts, tz, now)       ← now-dependent
    strftime.ts        minimal strftime for `--date=format:` / `%ad`-format
  pretty/
    pretty-spec.ts     parsePretty(spec): Named | Custom{ template, terminator }
    named.ts           oneline/short/medium/full/fuller/raw/reference headers
    placeholders.ts    expandFormat(template, fields): the `%`-engine
    email.ts           email / mboxrd header (`From … Mon Sep 17 …`, Subject)
    framing.ts         per-format patch separator (oneline vs medium vs format:)
  stat/
    diff-stat.ts       renderStat(entries, opts): aligned `name | N +++--`
    numstat.ts         renderNumstat(entries)
    scale.ts           git scale_linear graph-width computation
  combined/
    combine.ts         combineDiff(result, parents[]): sline flags + lost + hunks + dense prune
    render-combined.ts renderCombined(file, mode): `diff --cc`/`--combined`, `@@@` hunks
  decorate/
    decoration.ts      formatDecoration(labels, style): `%d`/`%D`/reference
  render-commit.ts     (existing; delegates header to pretty, tail to framing)
  render-tag.ts, render-tree.ts, message-indent.ts, identity-header.ts (existing)
  show-stream.ts       (existing; `-m` emits a node sequence per merge)
  index.ts

src/application/commands/show.ts                    (orchestration, expanded)
src/application/commands/internal/show-options.ts   parse/validate ShowOptions → resolved plan
src/application/commands/internal/show-decoration.ts oid→labels map via enumerateRefs
src/application/commands/internal/show-merge-diff.ts per-parent + combined assembly
src/application/commands/internal/rev-parse-grammar.ts  (extended: tree-path)
```

### 3.1 Reused machinery

- **Line diffs for combined** — `diffLines` (`domain/diff/line-diff.ts`) per
  parent vs result; flags/lost derived from its hunks. No new diff engine.
- **Per-parent `-m` patch** — the existing `diffTrees → materialisePatchFiles
  → renderPatch` trio, once per parent.
- **Decoration** — `enumerateRefs` + `resolveRef` build the oid→labels map.
- **`<rev>:<path>`** — a new grammar branch resolved in `revParse` by walking
  tree entries; reuses `readObject`.

## 4. `-s` / `--no-patch` (§ADR-244)

`git show -s <commit>` prints the header + indented message and **nothing
else** — for a non-merge, exactly the no-patch `block` (no trailing blank); for
a merge, the same (the combined diff is suppressed, not the trailing-blank
terminator — `-s` drops the terminator too). Observed:

```
commit <oid>\nAuthor: …\nDate:   …\n\n    modify a.txt\n
```

`noPatch` short-circuits every diff computation (`stat`/`numstat`/patch/
combined all suppressed). Interacts with `--format`: `-s --format=oneline`
prints just the oneline header.

## 5. `<rev>:<path>` (§ADR-245)

New grammar kind `tree-path`: a non-leading `:` splits `<tree-ish>:<path>`
(distinct from the leading-colon `:<stage>:<path>` index form). Resolution:
`revParse` the left side to a commit/tree, peel a commit to its tree, then walk
`path` components through tree entries to the addressed blob/tree oid. Empty
path (`<rev>:`) → the tree itself. `show` then renders the resolved object as a
blob/tree; the tree header echoes the **verbatim input** (`tree HEAD:sub`).

```
git show HEAD:a.txt   →  raw blob bytes
git show HEAD:        →  tree <input>\n\n<names>
```

Additive: these expressions previously failed `revParse`
(`OBJECT_NOT_FOUND`), so resolving them is non-breaking and faithful (git
resolves them everywhere). New error `PATH_NOT_IN_TREE` when a component is
absent.

## 6. Pretty formats (§ADR-246, §ADR-248)

`parsePretty(spec)` → a named format or a custom template. Patch (when shown)
**follows the header**, framed per §7.

### 6.1 Named formats

| name | header |
|---|---|
| `oneline` | `<full-oid> <subject>` (one line; `--oneline` = abbrev oid) |
| `short` | `commit <oid>` / `Author:` / blank / 4-space subject **only** |
| `medium` (default) | existing block (Author + Date + full message) |
| `full` | adds `Commit:` line (committer), no dates |
| `fuller` | `Author:`/`AuthorDate:`/`Commit:`/`CommitDate:` (aligned), full message |
| `raw` | `commit <oid>` then verbatim `tree`/`parent`/`author`/`committer` header lines, then 4-space message |
| `reference` | `<abbrev> (<subject>, <short-date>)` |
| `email`/`mboxrd` | `From <oid> Mon Sep 17 00:00:00 2001` / `From:` / `Date: <rfc2822>` / `Subject: [PATCH] <subject>` / blank / body |

`email` Subject is `[PATCH] <subject>` for a single object (`[PATCH n/m]` would
need a series count — single-object `show` always emits `[PATCH]`; documented).
`mboxrd` differs only by `>`-quoting body lines matching `^>*From `.

### 6.2 Custom `format:` / `tformat:`

Placeholder engine over the commit fields. Supported (faithful):

- **hashes** `%H %h %T %t %P %p` (full/abbrev commit, tree, parents)
- **author** `%an %ae %ad %aD %ai %aI %at %as %ar %ah`
- **committer** `%cn %ce %cd %cD %ci %cI %ct %cs %cr %ch`
- **message** `%s` (subject) `%f` (sanitized subject) `%b` (body) `%B` (raw) `%e` (encoding)
- **decoration** `%d %D` (§6.3)
- **literals** `%n` (newline) `%%` (percent) `%xXX` (hex byte)
- **unknown** `%?` → passed through verbatim (git's behaviour: `%z` → `%z`)

`%ad`/`%cd` honour `--date=`; `%aD`=rfc2822, `%ai`=iso, `%aI`=iso-strict,
`%at`=unix, `%as`=short, `%ar`=relative. `format:` emits no trailing terminator
(separator-style); `tformat:` terminates each entry with `\n` (§7).

### 6.3 Decoration `%d` / `%D`

Build an `oid → labels` map from `enumerateRefs`: resolve each ref, group by
target oid. Label order matches git: `HEAD` (as `HEAD -> <branch>` when symbolic
and the branch is also listed), local branches, tags (`tag: <name>`), remotes.
`%d` = ` (<labels>)` (leading space, parens) — empty when no labels; `%D` =
`<labels>` (bare). `show` does not decorate the default header (only `%d`/`%D`/
`reference` surface it).

## 7. Patch framing per format (observed)

After the header, before the first `diff`/stat line:

| format | separator |
|---|---|
| `medium`/`short`/`full`/`fuller`/`raw`/`reference`/`email`/`tformat:` | one blank line |
| `oneline` | none (header newline then `diff` directly) |
| `format:` | header's terminating `\n` then `diff` directly (no blank) |

A `framing.ts` lookup keyed by the resolved format kind encapsulates this; it
also governs the stat/numstat tail (same separator as the patch).

## 8. Date modes (§ADR-247)

`parseDateMode(spec)` then `formatDate`:

| mode | example |
|---|---|
| `default`/`normal` | `Wed Nov 15 00:15:00 2023 +0200` (existing `formatGitDate`) |
| `iso`/`iso8601` | `2023-11-15 00:15:00 +0200` |
| `iso-strict`/`iso8601-strict` | `2023-11-15T00:15:00+02:00` |
| `rfc`/`rfc2822` | `Wed, 15 Nov 2023 00:15:00 +0200` |
| `short` | `2023-11-15` |
| `raw` | `1700000100 +0200` |
| `unix` | `1700000100` |
| `local` | `Tue Nov 14 22:15:00 2023` (host TZ, **no** offset) |
| `human` | `Nov 15 2023` (now-dependent) |
| `relative` | `2 years, 7 months ago` (now-dependent) |
| `format:<strftime>` | per `strftime.ts` |

`default`/`iso`/`iso-strict`/`rfc`/`short`/`raw`/`unix`/`format:` use the
identity's stored offset → deterministic → pinned by interop. `local` uses the
host TZ (JS `Date` local components) → pinned with a fixed `TZ` in interop.
`relative`/`human` read the current time internally (like `revParse`'s
`@{date}`) → faithful to git's algorithm but **not** byte-pinnable; covered by
deterministic structural unit tests with an injected `now`.

## 9. `--stat` / `--numstat`

`--numstat`: `<added>\t<deleted>\t<path>\n` per file; binary → `-\t-\t<path>`.
`--stat`: aligned table + summary:

```
 a.txt   |  2 +-
 big.txt | 60 ++++…----…
 new.txt |  1 +
 3 files changed, 32 insertions(+), 31 deletions(-)
```

- name column: leading space, padded to the longest path.
- count column: right-aligned to the widest count's digit width.
- graph: `+`×ins `-`×del, scaled by `scale.ts` when total exceeds the available
  width (git's `scale_linear`, default total width 80). When it fits, 1 char per
  changed line.
- summary: ` N files changed, X insertions(+), Y deletions(-)` (each clause
  dropped when zero; faithful pluralisation).

Stat/numstat replace the patch (`-p` not implied); they occupy the patch's slot
with the same framing (§7). Both reuse the `-m`/combined change set for merges
(git stats the first parent by default unless combined).

## 10. Merge diffs (§ADR-249)

`mergeDiff` resolves to: `none` (`-s`), `separate` (`-m`), `combined` (`-c`),
`dense` (`--cc`, **default**). Non-merge commits ignore the mode (single
pairwise diff).

### 10.1 `-m` separate

One full commit block per parent, header
`commit <oid> (from <full-parent-oid>)`, the `Merge:` line repeated, then a
pairwise `diff --git` (result tree vs that parent's tree). Blocks are joined by
a single blank line **inside** the commit result's `text` — the stream still
emits one node per input rev (one `ShowCommitResult`, `perParent` carrying the
per-parent patches), so `show-stream.ts` is unchanged and the commit-dedup key
stays the single oid.

### 10.2 `-c` / `--cc` combined (the core algorithm)

Port of `combine-diff.c`:

1. For each parent `i`, line-diff `Pi` vs result `R` (`diffLines`). Insertions
   in `R` set `sline[r].flag |= (1<<i)`; deletions attach a `lost` line tagged
   with parent `i` at the result position.
2. `interesting(sline) = (flag & all) || lost` (any parent changed, or a parent
   lost a line here).
3. `make_hunks`: grow `context` (3) lines around interesting slines; merge
   adjacent hunks.
4. **dense (`--cc`)**: drop a hunk whose every change (added result lines +
   lost lines) is attributable to a **single** parent — i.e. the merge took
   that hunk verbatim from one side. A file identical to any parent yields only
   single-parent hunks → entirely dropped (the trivial-merge "no patch").
5. Render per surviving file: `diff --cc <path>` (`--combined` for `-c`),
   optional mode lines, `index <p0>,<p1>..<R>` (abbrev 7), `--- a/` / `+++ b/`,
   then `@@@ -<p0> -<p1> +<R> @@@` hunks. Each content line carries `N`
   per-parent prefix columns: ` ` (context for that parent), `-` (lost from that
   parent), `+` (added relative to that parent). `@` count = `N+1`.

Empty combined diff (every file dropped) → header + trailing blank, byte-equal
to today's trivial-merge output. Octopus (`N≥3`) generalises by `all =
(1<<N)-1` and `N` prefix columns.

### 10.3 Object-id abbreviation

`%h`/`%t`/`%p`, the `oneline`/`reference` oids, `Merge:`, the combined `index`
line, and the patch `index` line all abbreviate to a **fixed 7 chars**
(`OID_ABBREV_LENGTH`, the established project constant). Canonical git's abbrev
is dynamic (shortest unique prefix, floor 7) and grows on large repos; the
interop fixtures are small enough that the unique prefix is always 7, so fixed-7
is byte-faithful there and consistent with the existing `Merge:`/patch-index
rendering. A dynamic-abbrev follow-up is out of scope (documented divergence,
ADR-244 boundary).

### 10.4 `reference` / `local` specifics

`reference` renders `%h (%s, %ad)` with `%ad` in **short** date form; the exact
author-vs-committer choice and date mode are pinned by interop. `local` shows
the instant in the **host** timezone with no `±ZZZZ` suffix; the interop case
fixes `TZ` so both git and tsgit observe the same zone (verified in the date
slice — falls back to a structural test if Node's runtime `TZ` is not honoured).

## 11. Error handling

- `assertRepository(ctx)` first.
- Unknown `format` named value → `INVALID_OPTION` (`{ code, option: 'format', value }`).
- Unknown `--date` mode → `INVALID_OPTION` (`option: 'date'`).
- `<rev>:<path>` component absent → `PATH_NOT_IN_TREE` (`{ code, rev, path }`).
- A non-tree-ish left of `:` → propagates `revParse`'s typed error.
- No new error code where an existing one fits (rev resolution reuses the
  current surface).

## 12. Object Calisthenics / style

- Branded `ObjectId`/`FileMode`/`FilePath` cross every boundary.
- Each renderer is a small pure function; the combined-diff state machine builds
  fresh arrays (no input mutation); exhaustive `switch` on the format/mode union,
  no `default` fall-through.
- Option parsing is one pure `parseShowOptions` → a resolved discriminated plan
  the command consumes; no primitive option strings leak past the boundary.

## 13. Test strategy

### 13.1 Unit (example + property)

- **date** — example tests per mode (corners: single-digit day, negative tz,
  pre-epoch, `local` with fixed TZ); `iso`/`rfc`/`strftime` are total functions
  over the timestamp grammar → property tests (`*.properties.test.ts`,
  round-trip-ish: re-parse to the same wall-clock). `relative`/`human` with an
  injected `now` → deterministic example tests over the threshold boundaries.
- **placeholders** — the `%`-engine is a *compositional* string transform: every
  placeholder isolated; `%xXX`/`%n`/`%%` literals; unknown `%z` passthrough;
  property test for the unknown-passthrough + literal grammar (lens 2/3).
- **stat/scale** — `scale_linear` boundary cases (fits / scales / single-line)
  each isolated; pluralisation (0/1/N) isolated.
- **combine** — the sline/flag/hunk machine: per-parent add, per-parent lost,
  dense single-parent drop, two-parent keep, octopus; isolated guard tests.
- **framing** — the per-format separator matrix.
- **named/email/reference** — example test per header format.

### 13.2 Integration (memory adapter)

`show.test.ts` extended: each option end-to-end on `objects` + `bytes`, default
unchanged, error propagation for bad `format`/`date`, `<rev>:<path>` blob+tree.

### 13.3 Cross-tool interop (`show-interop.test.ts`)

The faithfulness gate — `decode(show(ctx, rev, opts).bytes)` byte-equals
`git show <flags> <rev>` for: `-s`; each named format; representative
`format:`/`tformat:` templates incl. `%xXX`/unknown; decoration (`%d`/`%D` on a
ref-pointed commit); `--stat`/`--numstat` (multi-file, scaled); `<rev>:<path>`
blob + `<rev>:` tree; `-m`/`-c`/`--cc` on a **non-trivial** merge (combining
both sides) and an octopus; the absolute `--date=` modes. `relative`/`human` are
**not** in interop (now-dependent) — structural unit tests only, with the
divergence documented.

### 13.4 Coverage / mutation

100% line/branch/function/statement; 0 killable mutants. Error assertions on
`.data.code` + `.option`/`.value`; guard clauses isolated; combined-diff
flag-mask arithmetic and stat-scale boundaries tested independently to kill
arithmetic/relational mutants. Parsers/renderers carry `*.properties.test.ts`
siblings where the four lenses fit (date formatters, placeholder engine,
strftime).
