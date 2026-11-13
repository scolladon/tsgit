# Design — `grep` honours the `diff` attribute for its binary verdict

> Brief: backlog 32.56. `grep` decides binary vs text by content sniff only and ignores the
> `.gitattributes` `diff` attribute (`binary`, `-diff`, bare `diff`, `diff=<driver>`).
> Status: draft → self-reviewed ×3

## Context

`scanBlob` (`src/application/commands/grep.ts:157`) takes `(matcher, bytes)` and branches on
`isBinary(bytes)` (`src/domain/diff/line-diff.ts:94`, NUL in the first 8000 bytes). Every
target funnels into it: the working tree and index through `scanCandidate` (`grep.ts:181`),
a tree-ish through `grepRev` → `enumerateTree` → `grepCandidates`, a blob through
`grepBlob` (`grep.ts:176`). No code path in `grep.ts` reads an attribute.

The attribute machinery exists and is used by `add`, `status`, `diff`, `checkout`, `stash`,
`rm` and `blame`:

| Piece | Where | Shape |
|---|---|---|
| `AttributeProvider` | `src/application/primitives/internal/read-gitattributes.ts` | `sourcesForPath(path) → { sources, macros }` |
| `buildCheckinAttributeProvider(ctx, index?)` | same file | work tree first, index blob as fallback per directory |
| `buildAttributeProvider(ctx, direction?)` | same file | no direction ⇒ work tree only (none in a bare repo) |
| `resolveAttribute(sources, path, name, macros)` | `src/domain/attributes/resolve-attribute.ts` | `true \| false \| 'unspecified' \| { set }` |
| `BinaryOverride`, `sideIsBinary(bytes, override)` | `src/domain/diff/binary-decision.ts` | `'binary' \| 'text' \| undefined` (undefined ⇒ sniff) |
| `resolveDriverBinary(ctx, value)` | `src/application/primitives/internal/resolve-similarity-content-kind.ts:50` | `config.diff.get(name)?.binary` |
| `resolveBinaryOverride(value, named)` | `src/application/primitives/resolve-binary-override.ts` | diff's patch/numstat pair, textconv-aware |
| `config.diff` | `src/application/primitives/config-read.ts:1394` | `Map<name, { textconv?, cachetextconv?, binary? }>`, one entry per `[diff "<name>"]` section, `binary = auto` ⇒ field absent |

Re-pinned on main `4a7baf86` before design (lesson 033). `scanBlob`, `isBinary`,
`AttributeProvider` and `resolveAttribute` sit where the brief says. A temporary probe test
(not committed) ran tsgit's `grep` over git-built repositories. tsgit's output was identical
for all nine attribute states: two line hits on `f1`, `binaryMatch: true` on `f2`. The
defect reproduces.

The probes also correct the brief in two places (lesson 033: the corrected behaviour is
recorded here):

1. **A blob target is not always attribute-free.** git keeps the path a rev names
   (`get_oid_with_context`'s `oc.path`). `HEAD:f1`, `:f1`, `:0:f1`, `HEAD^{tree}:f1`,
   `HEAD:./f1` and `HEAD~0:f1` all honour `f1 binary`. Only a rev with no path keeps the
   pure sniff: a bare or abbreviated oid, `<oid>^{blob}`, or a tag of a blob.
2. **A tree target is not always attribute-bearing.** git checks attributes only when the
   rev dereferences to a **commit**: `HEAD`, `main`, a commit oid, a tag of a commit. A
   **tree** object is grepped with the sniff only: `HEAD^{tree}`, a tree oid, a tag of a
   tree, `HEAD:` and `HEAD:sub`.

And one part of the brief is incomplete. Attributes are never read from the grepped rev's
tree. Every target reads the work-tree `.gitattributes`, `info/attributes` and
`core.attributesFile`. The index blob is a fallback only for targets that load the index:
`--cached`, the work tree, and `:path`. A bare repository reads neither the work tree nor
the index.

## Requirements

1. The `diff` attribute decides a blob's binary verdict before the content sniff does.
   - `-diff`, `binary`, or a macro that expands to `-diff`: binary.
   - Bare `diff` (or a macro that sets it): text, even with a NUL.
   - `diff=<name>`: the driver's `diff.<name>.binary` when it is set. The sniff decides
     when the driver exists but its `binary` is unset or `auto`.
   - Unspecified, `!diff`, or `diff=<name>` naming no driver: the `default` driver's
     `diff.default.binary` when it is set, otherwise the sniff (Decision 4).
2. Targets that consult the attribute, and the path each one uses:
   - working tree: the index entry path;
   - `'index'`: the index entry path;
   - a `{ treeish }` that dereferences to a commit (tags followed): the in-tree path;
   - a `{ treeish }` blob rev that carries a path (`rev:path`, `:path`, `:N:path`): that
     path, normalised the way `resolveRelativePath` already normalises it (`./`, `../`
     against `ctx.cwd`).
3. Targets that do not consult the attribute: a `{ treeish }` that dereferences to a tree
   object, and a blob rev with no path. They still take the `default` driver:
   `diff.default.binary` decides, else the sniff (corrected in review; pinned:
   `diff.default.binary=true` ⇒ `Binary file HEAD^{tree}:f1 matches`, `Binary file HEAD::f1
   matches`, `Binary file <oid> matches`; `=false` greps a NUL blob as text on the same
   targets — the matrix's default-driver rows already showed it for a path-less blob).
4. Attribute sources, highest first: `info/attributes`, the per-directory
   `.gitattributes` (work-tree file, then the index blob when the work-tree file is
   absent), then `core.attributesFile`.
   - The index fallback applies to `--cached`, the work tree, and a `:path` / `:N:path`
     blob rev. These are the targets that load the index (rows C and E).
   - Any other rev target reads the work-tree file only.
   - In a bare repository, only `info/attributes` and `core.attributesFile` are read,
     never the index. A repository that is not bare reads the index copy even without a
     work tree (corrected in review; pinned: `core.bare=false`, `GIT_DIR` only,
     `grep --cached` with an index-only `f1 binary` ⇒ `Binary file f1 matches`).
   - The rev's own tree is never read. `attr.tree` and `--attr-source` are not implemented in tsgit
   (ledger row 31.9) and stay out.
5. A forced verdict feeds the existing machinery unchanged:
   - forced binary: `hits: []`, `binaryMatch` and `binaryMatchCount` from the
     invert-aware line count (ADR-1174, ADR-1176);
   - forced text: a normal line scan, NUL bytes kept in `line`.
6. `textconv` never changes `grep`'s verdict. git greps without `--textconv` by default,
   and tsgit has no such option.
7. Unchanged: every refusal and its order (rev, then pathspec, then peel). No attribute is
   read before the rev and the pathspec have resolved. Other unchanged parts: the mode
   filter, pathspec filtering, `GrepResult` shape, the 8000-byte NUL sniff.

## Design

### Pinned matrix — git 2.56.0 (scrubbed `GIT_*`, isolated `HOME`, `GIT_CONFIG_NOSYSTEM=1`, `mktemp -d` throwaways)

Fixture unless stated: `f1 = "a NEEDLE\nb\nNEEDLE c\n"` (oid `296dd9f…`), `f2 = "x
NEEDLE\0y\n"` (oid `594b27d…`). The attribute line is `* <state>` in a committed
`.gitattributes` that is also in the index and the work tree. Pattern `NEEDLE`, `-n`.
`B(x)` is `Binary file x matches`. `T(x)` is the text lines `x:1:a NEEDLE`, `x:3:NEEDLE c`
for f1, or `x:1:x NEEDLE\0y` for f2. "ours" is tsgit at `4a7baf86`.

**Attribute state × target (git):**

```
state                          HEAD          --cached / wt   HEAD:f1   HEAD:f2   :f1     oid(f1)   oid(f2)
(none)                         T f1, B f2    T f1, B f2      T         B         T       T         B
* binary                       B f1, B f2    B f1, B f2      B         B         B       T         B
* -diff                        B f1, B f2    B f1, B f2      B         B         B       T         B
[attr]bin -diff + * bin        B f1, B f2    B f1, B f2      B         B         B       T         B
* diff                         T f1, T f2    T f1, T f2      T         T         T       T         B
[attr]txt diff + * txt         T f1, T f2    T f1, T f2      T         T         T       T         B
* !diff                        T f1, B f2    T f1, B f2      T         B         T       T         B
* diff=drv (no config)         T f1, B f2    T f1, B f2      T         B         T       T         B
* diff=drv  drv.binary=true    B f1, B f2    B f1, B f2      B         B         B       T         B
* diff=drv  drv.binary=false   T f1, T f2    T f1, T f2      T         T         T       T         B
* diff=drv  drv.textconv=cat   T f1, B f2    T f1, B f2      T         B         T       T         B   (textconv ignored)
* diff=drv  textconv=cat, binary=false   T f1, T f2   T f1, T f2   T   T   T     T         B
* diff=drv  drv.xfuncname=x    T f1, B f2    T f1, B f2      T         B         T       T         B
* diff=drv  drv.binary=auto    T f1 (+ default.binary=true)   pinned on text f1 only: auto is not true, and not routed to the default driver
* -text / * text               T f1, B f2    T f1, B f2      T         B         T       T         B   (text attr irrelevant)
* diff=default (no config)     T f1, B f2    T f1, B f2      T         B         T       T         B
ours (every state above)       T f1, B f2    T f1, B f2      T         B         T       T         B
```

**The `default` driver (git):**

```
(none)          + diff.default.binary=true    B f1 on HEAD/--cached/wt/HEAD:f1/:f1, and B oid(f1)   (path-less blob too)
(none) NUL f2   + diff.default.binary=false   T f2 on HEAD, and T oid(f2)
f1 diff=ghost   + diff.default.binary=true    B f1 everywhere    (unknown driver ⇒ default driver)
f1 diff=drv, drv.xfuncname=x + default=true   T f1               (driver exists, binary unset ⇒ sniff)
f1 -diff        + diff.default.binary=false   B f1               (-diff wins)
f1 diff         + diff.default.binary=true    T f1               (bare diff wins)
f3 diff=cpp     + diff.default.binary=true    T f3               (builtin driver exists ⇒ sniff)
f3 diff=cpp, diff.cpp.binary=true             B f3
g diff=emp, [diff "emp"] header with no keys + default=true   B g   (an empty section defines no driver)
diff=CPP / diff=Python + default=true         B                   (driver names are case-sensitive)
diff=drv, drv.binary=maybe                    fatal: bad boolean config value 'maybe' for 'diff.drv.binary'  128
                                              (ours: eager check at src/application/primitives/internal/repo-state.ts:292; not re-pinned for grep)
ours: diff.default.binary is never read; `diff` ignores it too (IMPACT line in the hand-off)
```

Builtin userdiff driver names (git 2.56.0), found by `diff=<name>` + `diff.default.binary=true`
and a sniff-text verdict: `ada bash cpp csharp css dts elixir fortran fountain golang
html java kotlin markdown matlab pascal perl php python r ruby rust scheme swift tex`, plus
the BibTeX and Objective-C drivers. Those two are spelt in git as the lower-case `bib…` name
and the four-letter Objective-C abbreviation. The implementation re-runs this pin to confirm both
spellings and adds them to `cspell.json`; this doc omits them to keep the spell gate green
without touching another file. Not builtin (default driver): `c go js sh lua zig
typescript CPP Python`.
`default` is the default driver itself.

**Which object kinds consult attributes (git, `f1 binary` + `f2 binary` committed, `sub/f2 = "NEEDLE s\n"`):**

```
HEAD / main / <commit oid> / ct (tag→commit)   B f1, B sub/f2              attributes read
HEAD^{tree} / <tree oid> / tt (tag→tree) / ltt  T f1, T sub/f2             no attributes
HEAD:  (root tree)                              T                          no attributes
HEAD:sub   (sub/.gitattributes 'f2 binary')     HEAD:sub:f2:1:NEEDLE s     no attributes
HEAD:sub   (root '/f2 binary' or 'sub/f2 binary') T                        no attributes (not a path-rebase)
HEAD:sub/f2 / HEAD^{tree}:sub/f2 / :sub/f2 / :0:sub/f2   B                 blob rev path = sub/f2
HEAD:./f1 / HEAD~0:f1 / :f1                     B                          path = f1
bt (annotated tag→blob) / lt (lightweight) / <oid>^{blob}   T              no path
cwd=sub: HEAD:./f2 (sub/.gitattributes 'f2 binary')         B              path = sub/f2
```

**Which sources are read (git, `f1` text content, `f1 binary` placed as stated):**

```
case                                              HEAD   --cached  wt   HEAD:f1   :f1
A  HEAD tree only (index + wt .gitattributes empty)  T      T        T    T         T     rev tree never read
B  HEAD + index; wt file present but empty           T      T        T    T         T     wt file wins over index
C  HEAD + index; wt file deleted                     T      B        B    T         B     index fallback only once the index is loaded (note)
D  untracked wt file only                            B      B        B    B         B
E  index only (staged, wt file deleted)              T      B        B    T         B
F  .git/info/attributes                              B      B        B    B         B
G  core.attributesFile                               B      B        B    B         B
H  nested sub/.gitattributes 'f2 binary'             B sub/f2 (HEAD), T (HEAD:sub), B (HEAD:sub/f2)
S  bare clone, committed attr                        T              —    T               no work tree, no index
S  bare clone + info/attributes                      B
S  bare clone + index (read-tree HEAD), --cached     T      T              T         T     index never read in a bare repo
T  -c attr.tree=<rev> / --attr-source=<rev> / GIT_ATTR_SOURCE   B          (tsgit: not implemented, ledger 31.9)
```

Note on rows C and E: `HEAD` and `HEAD:f1` print `T`, while `--cached`, the work tree and
`:f1` print `B`. The index fallback applies only once git has loaded the index, and a rev
target loads it only when its syntax reads the index. Proof, row C repeated twice, then
varied:

```
git grep NEEDLE HEAD            T   (run 1 and run 2)
git grep NEEDLE HEAD :f1        B HEAD:f1, B :f1     (`:f1` loads the index before any grep runs)
git grep NEEDLE :f1 HEAD        B :f1, B HEAD:f1
git grep NEEDLE HEAD^{tree}:f1  T
```

So the index fallback applies to `--cached`, the work tree, and a `:path` / `:N:path`
rev. Any other rev target reads the work-tree file, then `info/attributes` and
`core.attributesFile`. tsgit takes one target per call, so the multi-rev rows only
explain the mechanism. Decision 1 covers it.

**Options under a forced verdict (git; `f1 binary`, `f2 binary` on `sub/f2`):**

```
-c NEEDLE HEAD                 HEAD:f1:2  HEAD:sub/f2:1        count = returned lines (binaryMatchCount)
-l NEEDLE HEAD                 HEAD:f1  HEAD:sub/f2
-L NEEDLE HEAD                 HEAD:.gitattributes
-o NEEDLE HEAD                 B f1, B sub/f2                    (-o does not unlock lines)
-v NEEDLE HEAD                 .gitattributes lines, B f1        sub/f2 (all lines match) not reported
-c -v NEEDLE HEAD              HEAD:.gitattributes:2  HEAD:f1:1
-w EED HEAD                    exit 1
-a -n NEEDLE HEAD              T f1, T sub/f2                    -a overrides the attribute
--textconv -n NEEDLE HEAD      B f1, B sub/f2
-I NEEDLE HEAD                 exit 1                            binary skipped
big (108011 B, NEEDLE only on line 9001) `big binary`   B big, -c big:1   whole buffer scanned
nul = "x\0y\nNEEDLE 2\nz NEEDLE\n" `nul diff`           T nul:2, nul:3, -c 2, -v -c 1
```

tsgit's surface exposes `invert` and `wholeWord`. `-c`, `-l`, `-L` and `-o` are caller
projections (`docs/use/commands/grep.md`). `-a`, `-I` and `--textconv` are not exposed
(Decision 6).

Probe scripts (throwaway, not committed): `matrix.sh` (state × target), `src.sh`
(sources, object kinds, default driver), `p3.sh`–`p7.sh` (options, window, bare, attr
source, builtin names, bare + index). tsgit side: a temporary
`test/integration/` probe file running `grep` and `diff` over git-built repos, deleted
after the run.

### Change

**1. Verdict — `src/domain/diff/userdiff-binary.ts` (new, pure; Decision 4 option a).**
git's `userdiff_find_by_path` plus `grep_source_load_driver`, as data in and verdict out:

```ts
/** git 2.56 builtin userdiff drivers: `diff=<name>` finds one even with no config. */
const BUILTIN_DRIVERS: ReadonlySet<string> = new Set([
  'ada', 'bash', /* BibTeX */ 'cpp', 'csharp', 'css', 'dts', 'elixir', 'fortran', 'fountain',
  'golang', 'html', 'java', 'kotlin', 'markdown', 'matlab', /* Objective-C */ 'pascal', 'perl',
  'php', 'python', 'r', 'ruby', 'rust', 'scheme', 'swift', 'tex',
]); // 27 names: the two placeholders are the pinned spellings (see the matrix note)
const DEFAULT_DRIVER = 'default';

export interface DiffDriverBinary { readonly binary?: boolean }
export type DiffDrivers = ReadonlyMap<string, DiffDriverBinary> | undefined;

const tristate = (binary: boolean | undefined): BinaryOverride | undefined =>
  binary === undefined ? undefined : binary ? 'binary' : 'text';

const isDriver = (drivers: DiffDrivers, name: string): boolean =>
  drivers?.has(name) === true || BUILTIN_DRIVERS.has(name);

/** The `diff` attribute's verdict for a path; `undefined` leaves it to the NUL sniff. */
export const userdiffBinaryOverride = (
  value: AttributeValue,
  drivers: DiffDrivers,
): BinaryOverride | undefined => {
  if (value === false) return 'binary';
  if (value === true) return 'text';
  const named = typeof value === 'object' && isDriver(drivers, value.set) ? value.set : DEFAULT_DRIVER;
  return tristate(drivers?.get(named)?.binary);
};
```

The function reads `config.diff`, which already carries `binary` with `auto` mapped to
absent. A `[diff "x"]` section with no keys still creates a map entry, but git creates no
driver for it (pinned). That residual applies only under `diff.default.binary` and is
recorded in the ledger (Decision 4).

**2. Per-path resolver — `src/application/commands/internal/grep-binary-override.ts` (new).**

```ts
export type GrepBinaryOverrideOf = (path: FilePath) => Promise<BinaryOverride | undefined>;

/** The index a target loaded, when it loaded one: git's attribute fallback reads only a loaded index. */
export type LoadedIndex = { readonly entries: ReadonlyArray<IndexEntry> } | undefined;

const providerFor = (ctx: Context, index: LoadedIndex): Promise<AttributeProvider> =>
  ctx.layout.workDir === undefined || index === undefined
    ? buildAttributeProvider(ctx)
    : buildCheckinAttributeProvider(ctx, index);

export const grepBinaryOverrideReader = (ctx: Context, index: LoadedIndex): GrepBinaryOverrideOf => {
  const provider = lazily(() => providerFor(ctx, index));
  const drivers = lazily(async () => (await readConfig(ctx)).diff);
  return async (path) => {
    const { sources, macros } = await (await provider()).sourcesForPath(path);
    return userdiffBinaryOverride(resolveAttribute(sources, path, 'diff', macros), await drivers());
  };
};
```

`buildAttributeProvider(ctx)` with no direction reads the work tree only. In a bare
repository that leaves `info/attributes` and `core.attributesFile` alone (pin S), and a
rev target never sees the index (rows C and E). Callers:

- the work-tree and `'index'` targets pass the index object their enumerator already read;
- a `:path` / `:N:path` blob rev reads the index (`readIndex`) and passes it;
- every other rev target passes `undefined`.

The check-in provider is never used without a work tree, so a bare repository's index
stays unread, as in git.

The build is lazy, which keeps each refusal ahead of any attribute read (requirement 7). A
target with no candidates never builds the provider.

**3. Object kind — `src/application/primitives/internal/peel.ts`.** `peelToTreeOrBlob`
already tells the two tree cases apart internally: a tree reached by the tag walk, or
`rootTreeOf` a commit. Widen the kind (Decision 3 option a):

```ts
export type SearchableKind = 'commit-tree' | 'tree' | 'blob';
// tree reached by the tag walk → 'tree'; commit → { kind: 'commit-tree', id: rootTreeOf(...) }
```

Only `grep.ts` and `peel.test.ts` use `peelToTreeOrBlob` (verified with grep). Not public
API.

**4. Blob-rev path — `src/application/commands/rev-parse.ts` (Decision 2 option a).** git's
`oc.path`. `evaluate` already holds the path at its `tree-path` and `index-stage` branches:
`resolveRelativePath(ctx, expr.path)`. Extract `evaluateWithPath` returning
`{ id, named?: RevisionPath }`, and keep
`evaluate = (...) => evaluateWithPath(...).then(r => r.id)`. Then export the following. It
runs the same difference-sides read as `resolveRevision` first, so range refusals do not
move.

```ts
/** The path a rev named, and whether naming it read the index (`:path`, `:N:path`). */
export interface RevisionPath { readonly path: FilePath; readonly fromIndex: boolean }
/** `resolveRevision` plus git's object-context path, when the name carried one. */
export const resolveRevisionWithPath = (ctx, expression): Promise<{ id: ObjectId; named?: RevisionPath }>;
```

`named` is set in two places. On the `tree-path` branch it is set with `fromIndex: false`,
when the split is used: a whole-name read through `mayReadWhole` sets nothing. On
`index-stage` it is set with `fromIndex: true`. It is never set for an empty path, because
`HEAD:` is a tree. `resolveReference` (`resolve-rev.ts:21`) returns `{ id, named? }` from
it, and `requireReference` runs on `id` as today. `resolveRevision` keeps its signature and
callers.

**5. `grep.ts` threading (Decision 5 option a).**

- `scanBlob(matcher, bytes, override?: BinaryOverride)` branches on
  `sideIsBinary(bytes, override)` (`binary-decision.ts`), not `isBinary(bytes)`.
- `scanCandidate(matcher, candidate, overrideOf?)` resolves `overrideOf(candidate.path)`
  before the load. `grepCandidates` takes the optional `overrideOf`.
- `grep()`: the work-tree and `'index'` branches read the index once (`readIndex`). They
  pass it to `enumerateWorkingTree` / `enumerateIndex`, which today call `readIndex`
  themselves (`grep.ts:88`, `grep.ts:108`), and to `grepBinaryOverrideReader(ctx, index)`.
- `grepRev`: a `commit-tree` root passes `grepBinaryOverrideReader(ctx, undefined)`, and a
  `tree` root passes none (sniff). A `blob` root with `named` passes
  `await grepBinaryOverrideReader(ctx, named.fromIndex ? await readIndex(ctx) : undefined)(named.path)`.
  A `blob` root without `named` passes `undefined`.
- The 64 KiB window (Decision 6): with option b, `countReturnedLines` scans the whole
  buffer when `override === 'binary'`, and keeps the window when the sniff decided.

```ts
const binaryWindow = (bytes: Uint8Array, override: BinaryOverride | undefined): Uint8Array =>
  override === 'binary' ? bytes : bytes.subarray(0, MAX_LINE_BYTES);
```

Every function stays under 20 lines. The `Candidate` interface is unchanged.

### Cost

- One provider per `grep` call, built on the first candidate. Directory stacks are cached
  per directory (`createDirectoryStacks`). The work is the same per-path
  `resolveAttribute` that `status` and `add` already pay on every tracked path.
- `readConfig` runs once per call (lazy, and already cached by `config-read`).
- A tree target whose rev is a tree object, and a path-less blob, build nothing.
- With Decision 6 option b, a forced-binary blob is scanned like a text blob (line by line,
  whole buffer). That is the same cost as with no attribute.
- Bundle: the 27-name set and the new function add a few hundred bytes. The size caps
  had less than 100 B of headroom after #309. The implementation phase must run
  `check:size` early. If the gate is red, Decision 4 falls back to option b.

### Doc surfaces

- `docs/use/commands/grep.md`, Behaviour, "Binary blobs" bullet. Add the attribute rule:
  `-diff`/`binary` forces binary, bare `diff` forces text, a driver's
  `diff.<name>.binary`, then `diff.default.binary`, then the sniff. Add which targets read
  it: work tree, index, a commit rev, a blob rev with a path. Add which do not: a tree
  rev, a path-less blob. Add that sources are the work tree then the index, never the
  rev's tree, and that a bare repository reads only `info/attributes` and
  `core.attributesFile`.
- `docs/use/commands/grep.md`, Divergences. With Decision 6 option b, the 64 KiB bullet
  says "a blob the NUL sniff marks binary". Add the `attr.tree` / `--attr-source`
  pointer to ledger row 31.9. With Decision 4, add the empty-`[diff "x"]` residual.
- `docs/known-divergences.md`: the empty-section row (and the HEAD-before-index row if
  Decision 1 takes option a).
- JSDoc on `GrepBlobResult.binaryMatch`: "binary by attribute or by sniff".
- `reports/api.json`: regenerated by `docs:json` at pre-push. No public type changes.

## Decision candidates

| # | Choice | Alternatives (≤3) | Recommendation | Why |
|---|---|---|---|---|
| 1 | Attribute source per target | **a** check-in provider (work tree, index fallback) for every target. Without a work tree, `buildAttributeProvider(ctx)` (info + global only). Rows C/E (a rev target ignores the index fallback) are recorded in the ledger. **b** the index fallback only for targets that load the index (`'index'`, work tree, `:path` / `:N:path` revs). Other revs, and every target without a work tree, use `buildAttributeProvider(ctx)`. **c** read the rev's own tree for a commit target (the brief's implication) | **b** | Pins A–G and S refute c: git never reads the rev's tree. b is one conditional (`providerFor`) and matches every pinned row, including the proven load-order rows (`HEAD` T, `HEAD :f1` B). a leaves a reproducible wrong result on a well-formed repo: a work-tree `.gitattributes` deleted while its index copy stays staged. |
| 2 | Path for a blob rev (`HEAD:f1`) | **a** `resolveRevisionWithPath` in `rev-parse.ts` (extract `evaluateWithPath`; `resolveReference` returns `{id, path?}`). **b** grep re-parses the rev with `parseExpression` and an exported `resolveRelativePath`. **c** no attribute for any blob target (the brief) | **a** | c diverges on 7 pinned rows (`HEAD:f1`, `:f1`, `:0:f1`, `HEAD^{tree}:f1`, `HEAD:./f1`, `HEAD~0:f1`, `HEAD:sub/f2`). b duplicates the `mayReadWhole` split rule and can disagree with what the resolver did. a returns the path the resolver actually used. |
| 3 | Tell a commit's tree from a tree object | **a** widen `SearchableKind` to `'commit-tree' \| 'tree' \| 'blob'` in `peelToTreeOrBlob`. **b** a separate boolean `viaCommit` on `SearchableObject`. **c** grep inspects `named`'s type through the `ObjectTypeTable` itself | **a** | The kind already splits at that exact branch. b lets two fields contradict each other (`kind:'blob', viaCommit:true`). c duplicates the tag-walk policy in a command (the reason ADR-1173 put it in `peel.ts`). |
| 4 | Driver semantics beyond `-diff`/`diff` | **a** full userdiff: a named driver if configured or builtin (27 names), else the `default` driver's `diff.default.binary`. The empty-section residual goes to the ledger. **b** the brief plus `diff.<name>.binary` only (`resolveBinaryOverride(…).patch` with `resolveDriverBinary`, as `diff --binary` does), with `diff.default.binary` recorded in the ledger. **c** a, and also switch `diff`'s readers to the shared function | **a** | ADR-1170: "a change still matches git on every path it touches". a is pure, table-driven and property-testable. b leaves the pinned `diff.default.binary` rows wrong. c is scope inflation: `diff` is outside the perimeter (IMPACT line). If `check:size` is red, b. |
| 5 | Threading the verdict | **a** `scanBlob(matcher, bytes, override?)` plus an `overrideOf(path)` reader passed to `grepCandidates`. `Candidate` is unchanged. **b** add `override` to `Candidate`, resolved eagerly in each enumerator. **c** two scan functions (`scanText`/`scanBinary`) chosen by the caller | **a** | One branch point (`sideIsBinary`), shared with diff's semantics. b resolves attributes for candidates the pathspec then drops. c duplicates the hit or count result assembly. |
| 6 | 64 KiB window when the attribute forces binary | **a** keep the window; the documented divergence widens to forced-binary text files. **b** whole-buffer scan when `override === 'binary'`; the window stays for NUL-sniffed blobs. **c** whole buffer for every binary blob (drops the ADR-1174 safety bound) | **b** | Pinned: `big binary`, with a match at byte ~108 KB, prints `B big`. A `-diff` lock file or minified bundle over 64 KiB is a plausible input, and a would miss its matches. A forced-binary file has text-shaped lines, the same work the text path already does uncapped. The safety bound still covers the NUL-blob case it was written for. |
| 7 | New surface (`-a`/`--text`, `-I`, `--textconv`) | **a** none. **b** add `text?: boolean` (`-a`, data mode). **c** add `text` and `textconv` | **a** | Not needed for faithfulness: git's default (no flag) is what this change matches, and `textconv` is ignored without `--textconv` (pinned). YAGNI. A caller has not asked for it. |

## Test strategy

**Unit — domain** (`test/unit/domain/diff/userdiff-binary.test.ts`, new; `sut =
userdiffBinaryOverride`; GWT describe/it split, AAA). `it.each` rows:

| value | drivers | expected | Kills |
|---|---|---|---|
| `false` | any, incl. `default.binary=false` | `'binary'` | unset branch |
| `true` | `default.binary=true` | `'text'` | set branch |
| `'unspecified'` | none | `undefined` | default lookup when no map |
| `'unspecified'` | `default.binary=true` / `false` | `'binary'` / `'text'` | default driver ignored |
| `{set:'drv'}` | `drv.binary=true` / `false` / `{}` | `'binary'` / `'text'` / `undefined` | named tristate |
| `{set:'drv'}` | `{}` for drv + `default.binary=true` | `undefined` | configured driver falls to default |
| `{set:'ghost'}` | `default.binary=true` | `'binary'` | unknown name not routed to default |
| `{set:'cpp'}` | `default.binary=true` | `undefined` | builtin set missing |
| `{set:'cpp'}` | `cpp.binary=true` | `'binary'` | config over builtin |
| `{set:'CPP'}` | `default.binary=true` | `'binary'` | case-insensitive lookup |
| each of the 27 builtin names (`it.each`) | `default.binary=true` | `undefined` | per-name StringLiteral mutants |

Property sibling (`userdiff-binary.properties.test.ts`): lens 2, an oracle against an
independent table. For any `value` and any drivers map, a forced value (`true`/`false`)
ignores the map, and the result for `'unspecified'` equals the result for
`{set:<name not builtin and not in map>}`.

**Unit — command** (`test/unit/application/commands/grep.test.ts`; helpers `seedRepo`,
`writeAndStage`, `commitAll`, `asBareContext`; config written to
`${ctx.layout.gitDir}/config` and then `__resetConfigCacheForTests()`, as in
`add.test.ts:2705`; `sut = grep`). New `describe('Given a diff attribute')`:

| Given / When | Then | Kills |
|---|---|---|
| `f1 binary`, targets HEAD / `'index'` / work tree (`it.each`) | `f1`: `hits []`, `binaryMatch true`, `binaryMatchCount 2` | reader not passed per target |
| `f2 diff` (NUL), same three targets | `f2`: hits `[1]`, `binaryMatch false` | forced text ignored |
| `f1 binary`, target `HEAD^{tree}` | `f1` text hits | tree root given a reader |
| `f1 binary`, blob `HEAD:f1` / `:f1` | `blob.binaryMatch true` | blob path dropped |
| `f1 binary`, blob `<oid>` and annotated tag of blob | `blob` text hits | path-less blob given a reader |
| `f1 binary`, `invert` | `f1` reported, count 1 | override bypasses invert-aware count |
| `big binary` (> 64 KiB, match past the window) | `binaryMatch true`, count 1 | window kept under forced binary (Decision 6 b) |
| NUL blob over 64 KiB, match past the window, no attribute | not reported (window kept) | window dropped for sniff |
| work-tree `.gitattributes` empty, index copy says binary | text | index preferred over work tree |
| work-tree file deleted, index says binary, `'index'` target / `:f1` blob rev | binary | index fallback missing |
| same, target `HEAD` / `HEAD:f1` | text | index fallback used for a rev that never loaded the index |
| bare (`asBareContext`), committed `f1 binary` | text; with `info/attributes` binary | bare reads work tree or index |
| `diff=drv` + `drv.binary=true` in config | binary | config not read |
| `diff.default.binary=true`, no attribute | binary | default driver not wired |

`peel.test.ts`: rows for `commit-tree` (commit, tag→commit) and `tree` (tree, tag→tree).
Rev-parse unit rows for `resolveRevisionWithPath`:

| rev | `named` |
|---|---|
| `HEAD:f1` | `{f1, fromIndex:false}` |
| `:f1` / `:0:f1` | `{f1, fromIndex:true}` |
| `HEAD:./f1` with `cwd` in `sub` | `{sub/f1, …}` |
| `HEAD:` / `<oid>` / `tag^{}` | absent |

**Interop** (`test/integration/grep-interop.test.ts`). A new top-level
`describe('Given a diff attribute')` with its **own** git-built repo in `beforeAll`. Adding
a `.gitattributes` to the shared fixture would change existing `-v`/`-L` rows. Files:
`bin.txt` (text, `binary`), `neg.txt` (`-diff`), `diffed.dat` (NUL, `diff`), `macro.txt`
(`[attr]bin -diff` + `bin`), `unset.dat` (NUL, `!diff`), `strict.txt` (`diff=strict`,
`diff.strict.binary=true`), `loose.dat` (NUL, `diff=loose`, `binary=false`), `cpp.txt`
(`diff=cpp`), `ghost.txt` (`diff=ghost`, with `diff.default.binary=true` set in a
dedicated `it` that re-reads the config), `sub/nested.txt` (`sub/.gitattributes`), and
`big.txt` (`binary`, match past 64 KiB). Each row runs real `git grep -n -F NEEDLE <target>`.
It rebuilds `B(label)` from `binaryMatch` and `label:n:text` from `hits`, then asserts
line-for-line equality. Targets: `HEAD`, `--cached`, work tree, `HEAD^{tree}`, `HEAD:sub`,
tag of commit, `HEAD:bin.txt`, `:bin.txt`, `<bin.txt oid>`. `-c` and `-v` rows reuse
`countOf`. Source rows in separate small repos: HEAD-tree-only attribute (A), a deleted
work-tree file with the index copy (C/E, `--cached` and `HEAD` both), and a bare clone
with and without `info/attributes` (S). Expected values always come from real git.

**Mutation scope:** `userdiff-binary.ts` (its own suites), `grep-binary-override.ts` →
`grep.test.ts`, `grep.ts` → `grep.test.ts`, `peel.ts` → `peel.test.ts`, `rev-parse.ts`
(touched function only) → `rev-parse.test.ts` narrowed to the new rows.

## Out of scope

- `attr.tree`, `--attr-source`, `GIT_ATTR_SOURCE`: pinned to apply to `grep`, not
  implemented anywhere in tsgit (ledger 31.9).
- `-a`, `-I`, `--textconv` (Decision 7).
- `diff` / `diff-tree` honouring `diff.default.binary` and the builtin driver names (IMPACT
  line in the hand-off).
- `core.ignorecase` attribute matching (git matched `f_Cpp` rules case-insensitively on
  macOS during probing). This change does not touch the provider's matching.
- Several targets per call (`GrepOptions.target` is single).
