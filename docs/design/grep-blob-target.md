# Design — `grep` of a blob target

> Brief: backlog 32.1 row D10, blob-target half — `git grep <pat> <rev>` where `<rev>`
> resolves to a blob greps that blob; tsgit throws `OBJECT_NOT_FOUND` for an object that
> exists. The mistyped-tag half of D10 is in `docs/known-divergences.md` and is out of scope.
> Status: draft → self-reviewed ×2

## Context

`grep` (`src/application/commands/grep.ts`) resolves a `{ treeish }` target in
`enumerateCandidates` (lines 106–139):

```ts
const treeId = await resolveTreeish(ctx, target.treeish);
for await (const { path, id, mode } of walkTree(ctx, treeId, { recursive: true })) {
  if (!isSearchableMode(mode)) continue;
  ...
}
```

`resolveTreeish` (`src/application/commands/internal/resolve-rev.ts:21`) is
`peel(ctx, undefined, await resolveRevision(ctx, rev), 'tree')`. `peel`
(`src/application/primitives/internal/peel.ts`) walks tag → object and commit → tree through
`hopToward`. A blob has no hop, so the walk ends `reached` on the blob. The type check
`reached.type === target` then fails and `peel` throws `objectNotFound(<blob oid>)`. The
blob exists. The error says it does not.

git's `cmd_grep` parses each rev with `parse_object_or_die`. `grep_objects` runs
`deref_tag` on it, and `grep_object` dispatches on the dereferenced type. A blob goes to
`grep_oid`, labelled with the rev **as typed**. A commit or tree is read as a tree and
walked with base `<rev>:`. The matrix below pins both behaviours.

`resolveTreeish` has one caller: `grep`. `peel` is also used by `rev-parse`, `archive`,
`write-commit-graph` and `resolve-rev` (`resolveCommit`, `peelToTree` → `diff`). Those
callers want an exact kind and stay unchanged.

Re-pinned on main `f307051d` before design (lesson 033): the brief's symbols
(`enumerateCandidates`, `resolveTreeish`, `peel`) are where it says, and the
`OBJECT_NOT_FOUND` throw reproduces for every blob shape below.

## Requirements

1. A `{ treeish }` target that resolves to a blob, through any rev grammar, greps that
   blob's bytes. The grammar covers a bare or abbreviated oid, `rev:path`, `:path`,
   `:0:path`, `<oid>^{blob}`, an annotated tag of a blob, a tag of a tag of a blob, a
   lightweight tag of a blob, and `tag^{}`.
2. The blob result carries no path. Under ADR-249 the caller rebuilds git's label from the
   rev it passed. For a blob target the label is the rev string with no path component.
   For a tree target it stays `<rev>:<in-tree path>`, unchanged.
3. The mode filter (`isSearchableMode`) does not apply to a blob target. A symlink's blob
   reached through `rev:path` is grepped (its target string), and so is an executable's.
4. The pathspec is resolved and validated, so it refuses exactly as today. It never
   filters a blob target.
5. Binary detection, `wholeWord`, `invert`, line numbering and spans run through the same
   `scanBlob` as every other target. Decision 4 settles one exception.
6. A blob target needs no work tree: it works in a bare repository.
7. Unchanged: a tree, commit, tag-of-tree or tag-of-commit target, every refusal
   (`PATH_NOT_IN_TREE`, `REVPARSE_UNRESOLVED`, `OBJECT_NOT_FOUND` for a missing object or
   a gitlink), and the working-tree and `'index'` targets.

## Design

### Pinned matrix — git 2.56.0 (scrubbed `GIT_*`, isolated `HOME`, `GIT_CONFIG_NOSYSTEM=1`, `mktemp -d` throwaway)

Fixture: `f1 = "a NEEDLE\nb\nNEEDLE c\n"`, `sub/f2 = "NEEDLE sub\n"`,
`bin.dat = "bin\0NEEDLE\n"`, `word = "xNEEDLEx\n"`, `empty` (0 bytes),
`link -> NEEDLE-target` (symlink), `exe = "run NEEDLE\n"` (100755), and `gl`, a gitlink to
`1111…1111` (absent). Tags: `blob-tag` (annotated → blob f1), `tag-of-tag` (annotated →
blob-tag), `light` (lightweight → blob f1), `tree-tag` (annotated → root tree). "ours" is
tsgit at `f307051d`. Pattern `NEEDLE`, `-n` unless stated.

```
target                      git (stdout / exit)                                  ours (f307051d)
<f1-oid>                    <f1-oid>:1:a NEEDLE  <f1-oid>:3:NEEDLE c   0         THROW OBJECT_NOT_FOUND{id:<f1-oid>}
<f1-oid-short> (296dd9f)    296dd9f:1:a NEEDLE   296dd9f:3:NEEDLE c    0         THROW (same)
HEAD:f1                     HEAD:f1:1:a NEEDLE   HEAD:f1:3:NEEDLE c    0         THROW (same)
HEAD:./f1                   HEAD:./f1:1:a NEEDLE …                     0         THROW (same)
HEAD^{tree}:f1              HEAD^{tree}:f1:1:a NEEDLE …                0         THROW (same)
:f1                         :f1:1:a NEEDLE …                           0         THROW (same)
:0:f1                       :0:f1:1:a NEEDLE …                         0         THROW (same)
HEAD:sub/f2                 HEAD:sub/f2:1:NEEDLE sub                   0         THROW (same, sub/f2 oid)
blob-tag                     blob-tag:1:a NEEDLE …                       0         THROW
tag-of-tag                      tag-of-tag:1:a NEEDLE …                        0         THROW
light                       light:1:a NEEDLE …                         0         THROW
<f1-oid>^{blob}             <f1-oid>^{blob}:1:a NEEDLE …               0         THROW
blob-tag^{}                  blob-tag^{}:1:a NEEDLE …                    0         THROW
<loose unreachable blob>    <oid>:1:loose NEEDLE                       0         THROW
HEAD:bin.dat                Binary file HEAD:bin.dat matches           0         THROW
HEAD:link                   HEAD:link:1:NEEDLE-target                  0         THROW   (symlink blob IS grepped)
HEAD:exe                    HEAD:exe:1:run NEEDLE                      0         THROW
HEAD:empty                  (none)                                     1         THROW
HEAD:word   -w              (none)                                     1         THROW
HEAD:word                   HEAD:word:1:xNEEDLEx                       0         THROW
HEAD:f1     -v              HEAD:f1:2:b                                0         THROW
HEAD:f1     -l              HEAD:f1                                    0         THROW
<f1-oid>    -l              <f1-oid>                                   0         THROW
blob-tag     -c              blob-tag:2                                  0         THROW
HEAD:bin.dat -c             HEAD:bin.dat:1                             0         THROW
HEAD:bin.dat -l             HEAD:bin.dat                               0         THROW
HEAD:f1     (pattern ZZZ)   (none)                                     1         THROW
bare repo: HEAD:f1          HEAD:f1:1:a NEEDLE …                       0         (same THROW path)
bare repo: blob-tag          blob-tag:1:a NEEDLE …                       0         (same THROW path)
```

Pathspec against a blob target:

```
HEAD:f1 -- f1               HEAD:f1:1:a NEEDLE …                       0         THROW
HEAD:f1 -- nomatch          HEAD:f1:1:a NEEDLE …                       0   (pathspec ignored)
HEAD:f1 -- 'sub/*'          HEAD:f1:1:a NEEDLE …                       0   (pathspec ignored)
HEAD:f1 HEAD -- 'sub/*'     HEAD:f1:… (unfiltered) + HEAD:sub/f2:1:…   0   (filters the tree target only)
HEAD:f1 -- ../outside       fatal: … is outside repository …           128       THROW PATHSPEC_OUTSIDE_REPO{path:'../outside'}   (both refuse)
HEAD:nope -- ../outside     fatal: unable to resolve revision: HEAD:nope 128     PATH_NOT_IN_TREE (review: rev before pathspec)
<missing-oid> -- ../outside fatal: unable to parse object: <oid>        128       OBJECT_NOT_FOUND (review: rev before pathspec)
<commit with tree=blob>     fatal: unable to read tree (<blob>)        128       OBJECT_NOT_FOUND{id:<blob>} (review)
-c HEAD:twice.bin           HEAD:twice.bin:2 (bin\0NEEDLE\nNEEDLE\n)   0         binaryMatchCount 2 (review, ADR-1176)
```

Tree targets and refusals (no change; pinned as controls):

```
HEAD:sub                    HEAD:sub:f2:1:NEEDLE sub                   0         [["f2",[1],false]]
HEAD:sub -- f2              HEAD:sub:f2:1:NEEDLE sub                   0         (pathspec is relative to the tree)
HEAD:sub -- sub/f2          (none)                                     1
tree-tag                     tree-tag:f1:1:… tree-tag:sub/f2:1:…          0         [["f1",[1,3],false],["sub/f2",[1],false]]
HEAD:nope                   fatal: path 'nope' does not exist in 'HEAD'   128    THROW PATH_NOT_IN_TREE{rev:'HEAD',path:'nope'}
HEAD:gl (gitlink, absent)   fatal: unable to parse object: HEAD:gl     128       THROW OBJECT_NOT_FOUND{id:1111…}
0000…0000                   fatal: unable to parse object: 0000…       128       THROW OBJECT_NOT_FOUND{id:0000…}
<f1-oid>^{tree}             error: … expected tree type, but the object dereferences to blob type; fatal … 128   (rev grammar refusal, unchanged)
```

Several targets in one git call (`HEAD:f1 blob-tag`, `HEAD HEAD:f1`) emit each target's
block in argument order. tsgit takes one target per call, so this does not apply.

Probe scripts (throwaway dirs): the session's `mk.sh` plus this phase's `mk2.sh` (gitlink,
symlink, exe, empty, `-w`, pathspec, index-path revs, bare), `mk3.sh` (pathspec refusals,
tag-of-tree, loose blob, attributes) and `mk4.sh` (binary × `-v`). tsgit side: `jiti` over
`src/` with `createNodeContext` on the same repo.

### Change

**1. Peel to "tree or blob" — `src/application/primitives/internal/peel.ts`.** The
existing walk already stops on a blob: `hopToward(obj, 'tree')` returns `undefined` for a
blob. Only the final type check refuses it. Split the walk from the check and add one
export next to `peel`:

```ts
export type SearchableKind = 'tree' | 'blob';
export interface SearchableObject { readonly kind: SearchableKind; readonly id: ObjectId }

/**
 * git grep's object dispatch (`deref_tag`, then a commit read as its tree): annotated
 * tags followed to any depth, a commit to its root tree, a tree or blob kept as is.
 */
export const peelToTreeOrBlob = async (ctx, table, id): Promise<SearchableObject> => {
  const walk = await walkTowardTree(ctx, table, id);   // shared with peel(…, 'tree')
  const reached = walk.result;
  if (reached?.type === 'tree' || reached?.type === 'blob') return { kind: reached.type, id: walk.id };
  throw objectNotFound(walk.id);
};
```

`walkTowardTree` is the private extraction of `peel`'s first three lines, with `read`,
`nextHop` and `walkPeelChain`. It throws `objectNotFound(id)` on a non-`reached` end, as
`peel` does now. `peel` keeps its exact behaviour and signature. Decision 3 compares this
with the alternatives.

**2. Resolver — `src/application/commands/internal/resolve-rev.ts`.** Replace
`resolveTreeish`, whose only caller is `grep`. Leaving it would be dead code:

```ts
/** Resolve `rev` to what `grep` searches: its tree (commit → tree, tags followed) or a blob. */
export const resolveTreeOrBlob = async (ctx: Context, rev: string): Promise<SearchableObject> =>
  peelToTreeOrBlob(ctx, undefined, await resolveRevision(ctx, rev));
```

Update the module header comment (`log`, `diff` → add `grep`).

**3. `grep.ts`.**

- Order is unchanged: the pathspec is resolved before the rev, as today. After that,
  `grep` resolves a `{ treeish }` target once through `resolveTreeOrBlob`. A tree root
  goes to `enumerateTree(ctx, treeId)`, which is today's walk loop moved out of
  `enumerateCandidates`, unchanged. A blob root never becomes a `Candidate`, because a
  `Candidate` carries a `FilePath`. `scanBlob` runs on the blob directly, the pathspec is
  not applied (it was still resolved, so `../outside` still refuses), and the result is
  `{ paths: [], blob }`, the shape Decision 1 recommends. Each function stays under 20
  lines. The working-tree and `'index'` branches of `enumerateCandidates` are untouched.
- `scanBlob` drops its `path` parameter and returns the path-free match
  (`GrepBlobResult | undefined`). The tree, index and working-tree callers wrap it with
  `{ path, ...match }`. This keeps one scan for every target.
- `isSearchableMode` is not consulted for a blob target (requirement 3). There is no mode:
  git's `grep_object` greps any blob.

**4. Public types (Decision 1, recommended option a).**

```ts
export interface GrepBlobResult {
  readonly hits: ReadonlyArray<GrepLineHit>;
  readonly binaryMatch: boolean;
}
export interface GrepPathResult extends GrepBlobResult {
  readonly path: FilePath;
}
export interface GrepResult {
  /** Tree-ish, index and working-tree targets: only paths with ≥1 hit or binaryMatch:true. Always empty for a blob target. */
  readonly paths: ReadonlyArray<GrepPathResult>;
  /** Blob target only: the blob's match, absent when it did not match (git exit 1). */
  readonly blob?: GrepBlobResult;
}
```

The change is additive. `GrepPathResult` keeps the same fields, and `GrepResult` gains one
optional field. It is not a breaking change. `GrepOptions.target` keeps the
`{ treeish }` key (Decision 5). Its JSDoc becomes "`{ treeish }` ⇒ a committed tree, or a
blob when the rev resolves to one".

Caller projection (documented in `docs/use/commands/grep.md`; the library renders nothing):

```ts
const label = (rev: string, p?: GrepPathResult) => (p === undefined ? rev : `${rev}:${p.path}`);
// blob:  result.blob?.hits.map(h => `${rev}:${h.lineNumber}:${text(h.line)}`)
// -l:    result.blob ? [rev] : result.paths.map(p => label(rev, p))
// -c:    result.blob ? `${rev}:${result.blob.binaryMatch ? 1 : result.blob.hits.length}` : …
// bin:   result.blob?.binaryMatch ⇒ `Binary file ${rev} matches`
```

### Binary verdict under `invert` and anchors (Decision 4: fold or not)

The blob matrix's binary rows run through `scanBlob`'s binary branch (grep.ts:147–158).
That branch has two defects, found by this phase's probes. They affect **every** target
today, and the blob target would inherit both:

```
fixture: all-match.dat="bin\0NEEDLE\n"  mixed.dat="bin\0NEEDLE\nother\n"  nomatch.dat="bin\0x\n"
git grep -v NEEDLE HEAD        → Binary file HEAD:mixed.dat matches / Binary file HEAD:nomatch.dat matches, exit 0
tsgit invert, target HEAD      → [["all-match.dat",0,true],["mixed.dat",0,true]]          (all-match wrong, nomatch missing)

fixture: anchored.dat="bin\0x\nNEEDLE y\n"
git grep -E '^NEEDLE' HEAD     → Binary file HEAD:anchored.dat matches, exit 0
tsgit /^NEEDLE/, target HEAD   → []                                                      (window probed as one line)
```

The probes fit a line-by-line scan of the binary buffer with the same invert-aware
verdict used for text: `Binary file … matches` appears once any line is returned. tsgit instead
probes the first 64 KiB as a single "line" with a separate non-inverted matcher
(`binaryProbeMatcher`, grep.ts:191–195). The code comment says presence is independent of
`-v`, which the probe above refutes. The unit row at
`test/unit/application/commands/grep.test.ts:438` pins the wrong behaviour.

If folded (option a), the binary verdict becomes "some line of the bounded window is
`returned` by `matcher`". The window is `splitLines(bytes.subarray(0, MAX_LINE_BYTES))`,
the matcher is the same invert-aware one, and the scan stops at the first returned line.
`binaryProbeMatcher` is removed. The documented 64 KiB bound stays. A new residual is
recorded in the grep doc's Divergences: under `invert`, a window cut through a matching
line can return that cut line.

### Cost

A blob target reads one object header in `peel` (`isBlobByHeader`) and the blob body once
in `scanBlob`. There is no tree walk. Tree targets are unchanged. Folding Decision 4
replaces one window probe with an early-exit line loop over the same 64 KiB.

### Doc surfaces

- `docs/use/commands/grep.md`: update the Signature block with `GrepBlobResult` and
  `GrepResult.blob`. The Options `target` row reads "commit, tree, or blob". Behaviour
  gains a blob-target bullet: no path, pathspec validated but not applied, any blob mode
  grepped, bare repo OK. Caller projections gain the blob label rule. Throws: drop the
  implication that a blob rev is unresolvable. If Decision 4 folds, rewrite the
  binary-under-invert sentence.
- JSDoc on `GrepResult`, `GrepBlobResult`, `GrepOptions.target`.
- `reports/api.json`: regenerated by `docs:json` (pre-push), not hand-edited.

## Decision candidates

| # | Choice | Alternatives (≤3) | Recommendation | Why |
|---|---|---|---|---|
| 1 | Result shape for a blob target (ADR-249: no rendered label) | **a** add optional `GrepResult.blob?: GrepBlobResult` (`{hits, binaryMatch}`), `GrepPathResult extends GrepBlobResult`; `paths: []` for a blob · **b** make `GrepPathResult.path` optional (`path?: FilePath`), the blob as one path-less entry · **c** discriminated `GrepResult = {kind:'paths', paths} \| {kind:'blob', match?}` | **a** | Additive, so a is a non-breaking `fix`; b and c are breaking (`fix!`, major). b widens a field every consumer reads to `FilePath \| undefined`, which breaks strict TS callers. c is the most type-honest but forces a major for a bug fix. The label needs no datum: the caller holds the rev (git labels by the rev as typed, not the oid). |
| 2 | Pathspec with a blob target | **a** resolve and validate as today (refusals kept), never apply it · **b** apply it to the rev's `:path` component when there is one · **c** skip resolution for a blob target | **a** | Pinned: `HEAD:f1 -- nomatch` still matches, and `HEAD:f1 -- ../outside` refuses 128. b diverges, and c drops a refusal git makes. |
| 3 | Where the tree-or-blob dispatch lives | **a** `peelToTreeOrBlob` in `peel.ts` sharing `peel`'s walk + `resolveTreeOrBlob` in `resolve-rev.ts` replacing `resolveTreeish` · **b** `grep.ts` resolves the rev and inspects the object type itself · **c** widen `peel`'s `target` to a set of kinds (`peel(ctx, t, id, ['tree','blob'])`) | **a** | Keeps the peel policy in the one peel module and the command thin (tiers respected). b duplicates the tag/commit hop policy in a command. c changes a signature shared by `rev-parse`, `archive`, `write-commit-graph` and `diff`, all of which want one exact kind. |
| 4 | Binary verdict under `invert` / anchors (proven defect in the shared `scanBlob`, inherited by the blob target) | **a** fold: line-wise verdict over the 64 KiB window with the invert-aware matcher, drop `binaryProbeMatcher`, fix `grep.test.ts:438` and the doc · **b** fold invert only (line-wise only under `invert`), anchor row recorded in the ledger · **c** don't fold: blob target ships with today's binary branch; both defects go to the ledger / backlog at the user's call | **a** | The CLAUDE.md fold rule applies: same file and same scan path, exposed by this change's own probes, and the cost is small. b leaves a second proven gap in the same 10 lines. c ships a new target whose `-v` binary row is wrong on day one. Scope call for the user. |
| 5 | Name of the target option now that it accepts a blob | **a** keep `{ treeish }`, widen its JSDoc · **b** add `{ rev }` and deprecate `{ treeish }` · **c** rename to `{ rev }` (breaking) | **a** | Not breaking, and git's own synopsis says `<tree>…` while it accepts blobs. b doubles the surface with no new capability. c forces a major. |

## Test strategy

**Unit** (`test/unit/application/primitives/internal/peel.test.ts`, existing helpers
`writeObject`, `createMemoryContext`, `init`, `caught`; GWT describe/it split, AAA,
`sut = peelToTreeOrBlob`):

| Given / When | Then | Kills |
|---|---|---|
| a blob id | `{kind:'blob', id}` | blob branch of the type check |
| an annotated tag → tag → blob | `{kind:'blob', id:<blob>}` | tag hop removed |
| a commit | `{kind:'tree', id:<root tree>}` | commit hop removed / kind swapped |
| a tree | `{kind:'tree', id}` | tree branch of the type check |
| a tag naming a missing object | throws; `data` `{code:'OBJECT_NOT_FOUND', id:<missing>}` via try/catch | `reached === undefined` guard |
| a self-naming forged tag | throws `OBJECT_NOT_FOUND{id:<start>}` | non-`reached` end |

A `peel` row also proves `peel(…, 'tree')` on a blob still throws `OBJECT_NOT_FOUND`, so
the extraction does not change `peel`.

**Unit** (`test/unit/application/commands/grep.test.ts`, helpers `seedRepo`,
`writeAndStage`, `commitAll`, `enc`/`dec`, `asBareContext` from `./fixtures.js`, tags via
`writeObject` or `tagCreate` from `src/application/commands/tag.ts`; `sut = grep`). One
`describe('Given a blob target')` block:

| When target | Then | Kills |
|---|---|---|
| `{treeish: <blob oid>}` | `paths: []`; `blob.hits` line numbers `[1,3]`, `binaryMatch: false` | blob branch absent |
| `HEAD:f1`, annotated tag, tag-of-tag, lightweight tag, `<oid>^{blob}`, `tag^{}`, `:f1` (`it.each`) | same `blob` | each grammar shape |
| `HEAD:sub` (tree via `rev:path`) | `paths` `[f2]`, `blob` undefined | kind swapped |
| no line matches | `blob` undefined, `paths: []` | always-defined `blob` |
| binary blob containing pattern | `blob.binaryMatch: true`, `hits: []` | binary path skipped |
| `HEAD:link`, a committed tree holding a `120000` entry written via `writeObject` (pattern on its target string) | `blob` defined | mode filter applied to blob |
| `paths: ['nomatch']` | `blob` still defined | pathspec applied to blob |
| `paths: ['../outside']` | throws `PATHSPEC_OUTSIDE_REPO{path}` | pathspec resolution skipped |
| `invert: true` on `HEAD:f1` | `blob.hits` = `[2]`, spans `[]` | invert not forwarded |
| `wholeWord` on `xNEEDLEx` | `blob` undefined | wholeWord not forwarded |
| bare context (`asBareContext`), blob target | resolves | work-tree gate applied to blob |

If Decision 4 folds: rewrite the `:438` row to git's verdict, and add rows for all-match
(not reported), nomatch-under-invert (reported) and the `^`-anchored second line
(reported). Each row kills a revert to the window probe.

**Interop** (`test/integration/grep-interop.test.ts`; helpers `git`, `runGit`,
`runGitEnv`, `tryRunGitWithExit` from `interop-helpers.ts`; expected values always from
real `git`). In `beforeAll`, after the initial commit, add `git tag -a blob-tag <c.txt
blob>`, `git tag -a tag-of-tag blob-tag` and `git tag light <c.txt blob>` (dated env). New
`describe('Given a blob target')` with `it.each` over rev builders: `<oid>`, `HEAD:c.txt`,
`HEAD:a.txt`, `blob-tag`, `tag-of-tag`, `light`, `<oid>^{blob}`, `blob-tag^{}`, `:c.txt`. Each
row runs `git grep -n -F NEEDLE <rev>` and rebuilds
`${rev}:${lineNumber}:${text}` from `result.blob`, asserting equality line for line. More
rows:

- `HEAD:b.bin`: `Binary file HEAD:b.bin matches` rebuilt from `blob.binaryMatch`.
- `-l` / `-c` on `blob-tag`: `[rev]` / `${rev}:${count}`.
- `-v` on `HEAD:c.txt`.
- `HEAD:c.txt -- nomatch`: git still matches, and so does tsgit with `paths: ['nomatch']`.
- `HEAD:b.txt` (no match): `tryRunGitWithExit` exit 1, and `result.blob` undefined.
- `HEAD:tracked_symlink.txt` with `{ fixed: 'symlink_target' }`.
- If Decision 4 folds: `-v` over a binary blob pair (all-match/nomatch) against the tree
  target.

`assertTargetParity`'s `HEAD:` strip stays tree-only.

**Property tests:** N/A for the blob target. Lens 1 fails (no parse/serialize pair), lens 3
fails (no grammar compiler) and lens 4 fails (no re-parse). Lens 2 fails: dispatch over a
two-valued kind is a small enum that an `it.each` sweep covers. If Decision 4 folds and
the verdict is extracted as a pure function (`src/domain/grep/`), lens 2 fits:
`binaryVerdict(invert) ≡ ∃ line: ¬matchLine(line)` against the independently tested
`buildGrepMatcher`. It goes in a `*.properties.test.ts` sibling of that function's example test. If the
verdict stays inside `grep.ts`, examples only.

**Mutation scope:** `peel.ts`, `resolve-rev.ts`, `grep.ts` with their eponymous suites
(`peel.test.ts`, `grep.test.ts`; `resolve-rev` has no eponymous suite, so walk to
`grep.test.ts`).

## Out of scope

- The mistyped-tag half of D10 (ledger, `docs/known-divergences.md`). A tag whose declared
  type lies is followed by its real type, as today. The blob branch adds no new instance:
  it dispatches on the object read, as the tree branch does.
- Several targets per call (git greps each rev in order): `GrepOptions.target` is single.
- `.gitattributes` `binary`/`-diff` is not consulted by `grep` on any target. See the
  IMPACT note in the hand-off. git uses the `rev:path` path for that lookup. A bare oid
  has no path, so the attribute does not apply to it.
- `diff` with blob revs: `peelToTree` refuses, as `git diff-tree` does. Not touched.
- Magic-pathspec refusal codes (`:(bogus)x` → `PATHSPEC_OUTSIDE_REPO` vs git `Invalid
  pathspec magic`): covered by backlog 32.11b.
