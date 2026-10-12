# Design — EOL conversion (`core.autocrlf` / `core.eol` / `core.safecrlf`, `text` / `eol` / `crlf` / `ident` attributes, renormalization)

> Brief: implement git's `convert.c` text-conversion layer — CRLF↔LF conversion driven by
> `core.autocrlf`, `core.eol` and the `text` / `eol` / legacy `crlf` attributes (`text=auto`
> included), the `core.safecrlf` round-trip guard, `ident` keyword collapse/expansion, and
> renormalization (`add --renormalize`, `merge -X renormalize`, `merge.renormalize`) — on every
> route git converts, byte-for-byte against git 2.55.0. Lifts the `-X renormalize` refusal.
> Backlog 32.6.
> Status: draft → self-reviewed ×3 → accepted (ADRs 950–957)

## Context

### Binding constraints

| Source | Constraint on this design |
|---|---|
| ADR-226 / CLAUDE.md (git-faithfulness) | Conversion changes blob bytes, hence object ids, on add and checkout. Every rule below is transcribed from the pinned matrix (§D1), not from memory. Where git disagrees with itself (two `ident` expanders, §D1.9) both behaviours are reproduced. |
| ADR-249 (structured data only) | The `core.safecrlf` warning and refusal ship as data (code + fields), never as rendered text; the interop test reconstructs git's line from the fields (§D3.7). |
| ADR-302 (attribute resolution) | `text`, `eol`, `crlf`, `ident`, `filter` resolve through the existing `domain/attributes` resolver and macro registry (`binary` = `-diff -merge -text`). |
| ADR-406 / 407 / 408 (filter drivers) | The clean/smudge pipeline is the host of the new steps (§D2). Driver execution and the off-node inert fallback are unchanged; EOL and `ident` steps need no `CommandRunner`. |
| ADR-637 / ADR-850 | `core.autocrlf` / `core.eol` / `core.safecrlf` / `merge.renormalize` are read repository-local through `readConfig(ctx)`, once per command. Global-config reads are backlog 32.7. |
| ADR-928 / 930 / 931 / 932 | The streamed checkout writer follows git's stream order and leaves git's empty file on a refused open. Conversions git streams keep that path; conversions git runs in core leave no file (pinned §D1.11). |
| ADR-933 | `archive` reads attributes from the archived tree; conversion runs before `export-subst` (git `archive.c:107-109`). |
| ADR-945 / 947 | Merge `-X` parsing and ort's rename detection are the host of the renormalize option. |
| ADR-949 | The racy-clean smudge compares through the clean conversion; with conversion the comparison must convert (pinned §D1.13). |
| ADR-950 – ADR-957 (this feature's decisions, user-ratified) | The design implements them: one composed conversion primitive (950, §D2–§D3.3); direction-taking attribute providers (951, §D3.4); the safecrlf refusal `{ path, loss, crlf, loneLf }` (952, §D3.7) and notices of the same shape on the command result (953); conversion + object writes serialised in index order under `core.safecrlf=true` (954, §D3.7); `ident` with both of git's expanders (955, §D1.9); full renormalize scope (956, §D3.8); an adapter-supplied native line ending (957, §D3.6). Rulings per candidate in §Decision candidates. |

All pins below ran in `mktemp -d` throwaways, never in this worktree.

### What exists today (verified in the tree)

| Asset | File : symbol | Status for this feature |
|---|---|---|
| Attribute parse/resolve | `src/domain/attributes/{parse-gitattributes,resolve-attribute,macros,attribute-value}.ts` — `resolveAttribute(sources, path, name, macros)`, `AttributeValue = true \| false \| 'unspecified' \| { set: string }` | Reuse as is. `text`, `eol`, `crlf`, `ident` already parse generically. |
| Attribute provider | `src/application/primitives/internal/read-gitattributes.ts` — `AttributeProvider.sourcesForPath`, `buildAttributeProvider(ctx)` (worktree `DirReader` only), `buildTreeAttributeProvider(ctx, tree)`, `maybeBuildAttributeProvider(ctx)` (returns `undefined` with no `ctx.command` and no required filter) | **Change.** Gains git's check-in / checkout directions (index fallback / index first, §D3.4); the runner gate goes (conversion needs no runner). |
| Filter choice | `src/application/primitives/resolve-filter-driver.ts` — `FilterChoice`, `resolveFilterDriver(ctx, provider, path, { eagerSectionValidation })`, `streamsThroughFilter(choice)` | Reuse inside the new resolver. |
| Clean / smudge steps | `src/application/primitives/internal/apply-clean-filter.ts` `applyCleanFilter(ctx, runner, path, bytes, choice)`; `internal/apply-smudge-filter.ts` `applySmudgeFilter(ctx, runner, target, choice)`, `SmudgeTarget`, `CheckoutMetadata`, `smudgesInCore(choice)`; `internal/clean-order.ts` (`admitClean`/`releaseClean`, index-order sequencing) | Reuse as the first (to-git) / last (to-worktree) step of the composed pipeline. |
| Add hashing | `src/application/commands/add.ts` — `stageFromStat` → `cleanConversion(ctx, path, isSymbolicLink, provider)` → `CleanConversion { streams, apply }` (≈ lines 690-730); provider from `maybeBuildAttributeProvider` (line 132) | Route: to-git, safecrlf armed. |
| Worktree comparison | `src/application/primitives/compare-working-tree-entry.ts` — `cleanWorktreeBytes` (lines 73-83), `compareWorkingTreeDelta(ctx, entry, provider?, indexMtime?)`, `compareWorkingTreeEntry`, `streamsThroughDriver` | Route: to-git, safecrlf off. Consumed by `status.ts:188`, `rm.ts:160`, `stash.ts:150`, `internal/clean-work-tree.ts:59`, `find-would-overwrite.ts:109`, `internal/smudge-racily-clean.ts:117`. |
| Stash W-tree capture | `src/application/commands/stash.ts` `hashFileAt` (lines 123-135) — reads raw bytes and `hashBlob(..., { write: true })` with **no** clean step today | Route: to-git, safecrlf armed (git refuses `stash`, §D1.6). |
| Blame worktree side | `src/application/commands/blame.ts` `readWorkingFile` (lines 255-266) — raw bytes | Route: to-git, safecrlf off (§D1.13). |
| Checkout writes | `src/application/primitives/apply-changeset.ts` `writeBlobToWorkingTree` (lines 224-264; smudge in core when `smudgesInCore`, else `writeWorkingTreeEntryStream`), `createLazyProvider` (line 532) | Route: to-worktree. Hosts switch, reset --hard, clone, sparse apply, worktree add, path restore — via `materialize-tree.ts:249` and `internal/apply-sparse-checkout.ts:207`. |
| Streamed write | `src/application/primitives/internal/write-working-tree-file.ts` — `writeStreamedBlob(ctx, fullPath, id, mode?)`, `writeServedBlob`, `openServedBlob`, `createEmptyOutput`, `writeWorkingTreeEntryStream`, `writeWorkingTreeFileStream` | Gains an optional chunk transform (§D3.3). |
| Merge-family writes | `src/application/commands/merge.ts` lines 1758-1808 (`writeWorkingTreeFileStream`, `writeWorkingTreeFile`, `writeConflictToTree` → `writeWorkingTreeEntry`); `src/application/primitives/apply-merge-to-worktree.ts` `writeMarkedConflict` (line 159) and `writeChangedOutcome` (lines 186-205); `internal/write-distinct-types-sides.ts`; `stash.ts:445` | Route: to-worktree. **Neither conversion nor smudge runs here today.** |
| Archive | `src/application/commands/archive.ts` `createAttributeCheck` (tree provider), `readEntryContent` (`readInCore` then `subst.expandFile`) | Route: to-worktree, in core, tree attributes. |
| Content merge | `src/application/primitives/build-content-merger.ts` `buildContentMerger` (provider line 82; `resolvePathMergeSpec` line 105); `src/domain/merge/three-way-tree.ts` `ContentMerger`, `modifyDeleteConflict`, `resolveContentMerge` | Renormalize seam (§D3.8). |
| `-X renormalize` refusal | `src/domain/merge/strategy-options.ts:139-140` (`unsupportedOperation('merge', '-Xrenormalize')`); documented at `src/application/commands/merge.ts:227-228` | Lifted. |
| Typed config | `src/application/primitives/config-read.ts` — `ParsedConfig.core` (lines 55-105), `applyCoreEntry`, `CORE_BOOLEAN_FIELDS`, `parseLogAllRefUpdates` tri-state precedent, `findFirstInvalidLogAllRefUpdates` (line ≈2709); `src/application/primitives/internal/repo-state.ts` `assertEagerConfigValid` (every-command gate, lines ≈228-260); `internal/merge-rename-config.ts` `readConflictStyle` | Extend. |
| Runtime tag | `src/ports/context.ts` `Context.runtime: 'node' \| 'browser' \| 'memory'` | No OS line ending is exposed today; the platform adapter supplies it (ADR-957, §D3.6). |
| EOL / ident code | `grep -rni 'autocrlf\|safecrlf\|core\.eol'` over `src/` → no hits; `ident` only in signing/pretty code | Greenfield. Today an `ident` path stores `$Id: … $` verbatim where git stores `$Id$` (§D1.9). |

tsgit's `diff` command is tree-to-tree only (`src/application/commands/diff.ts` imports only `diffTrees`) — git converts no tree blob there (§D1.13), so `diff`, `diff-trees`, `materialise-patch-files`, `apply-textconv`, `diff-binary-weighing`, `resolve-similarity-content-kind`, `resolve-merge-driver`, `cat-file`, `read-file-at`, `show` and `grep` stay untouched. tsgit has no `apply`, `hash-object`, `checkout-index`, `restore`, `commit -a` or worktree `diff` command; their git rows are recorded for completeness only.

### Pinning harness

Every probe runs with git 2.55.0 in a fresh `mktemp -d` repo:

```sh
g() { env -i PATH="<git-2.55.0>/bin:/usr/bin:/bin" HOME=<tmp>/home GIT_CONFIG_NOSYSTEM=1 \
        GIT_CEILING_DIRECTORIES=<tmp> \
        git -c user.name=t -c user.email=t@t -c init.defaultBranch=main -c commit.gpgsign=false "$@"; }
enc() { LC_ALL=C tr '\r\n\000' 'RN0'; }      # bytes shown as text: CR→R, LF→N, NUL→0
                                              # (a few long outputs below use C escapes instead)
$ g version
git version 2.55.0
```

Fixtures (`printf` bodies): `LF`=`a\nb\n`, `CRLF`=`a\r\nb\r\n`, `MIXED`=`a\r\nb\n`,
`NUL`=`a\0\r\nb\r\n`, `LONE-CR`=`a\rb\r\n`. Attributes are written to `.git/info/attributes`
as `* <attr>` unless a probe is about `.gitattributes` placement. Configuration is passed as
`-c core.autocrlf=<v> -c core.eol=<v>` (omitted for `unset`); tsgit's interop tests write the
same values to the repository config (ADR-637), which git reads identically.
`core.eol=native` is `lf` on the probing host (macOS). tsgit's native line ending is
adapter-supplied (ADR-957): Node `crlf` on win32, `lf` elsewhere; browser and memory `lf` — so
every pin below binds every non-Windows cell, and a Windows Node cell pins its `native` /
unset-`core.eol` rows per platform.

## Requirements

- **R1** Blob ids written by `add` (literal, bulk, `--renormalize`) and by `stash push` equal git's for every cell of the add matrix (§D1.1), the edge fixtures (§D1.3), the binary heuristic (§D1.4) and the index-CRLF rule (§D1.5).
- **R2** Worktree bytes written by every to-worktree route (§D3.5 table) equal git's for every cell of the checkout matrix (§D1.2) and §D1.3.
- **R3** `status` / `rm` / clean-work-tree / would-overwrite / racy smudge / blame classify a converted worktree file exactly as git does (clean when its converted bytes hash to the index id, §D1.13).
- **R4** `core.safecrlf=true` refuses with structured data on exactly the routes git dies on (add, add-family bulk, stash push), naming git's first offending path and leaving exactly git's loose objects behind (ADR-954); `warn` (git's default) surfaces a structured notice on exactly the routes git warns on; `false` is silent; status, blame, checkout, archive and renormalization never warn or refuse (§D1.6).
- **R5** `ident` collapses on to-git and expands on to-worktree with the hash width of the repository (40 / 64 hex), reproducing both of git's expanders on their respective routes (§D1.9).
- **R6** Steps compose in git's order: to-git = filter clean → CRLF → ident; to-worktree = ident → CRLF → filter smudge (§D1.10).
- **R7** Attributes resolve from git's source per route: check-in (worktree, index fallback), checkout (result index, worktree fallback), tree (archive), merged `.gitattributes` with git's conflicted-file rule (renormalize) (§D1.7, §D1.12).
- **R8** Conversions git streams on checkout stay streamed (a refused open leaves git's empty file); conversions git runs in core stay in core (no file left) (§D1.11).
- **R9** `merge -X renormalize`, `-X no-renormalize` and `merge.renormalize` produce git's clean merges, conflicts and modify/delete resolutions; `merge.renormalize` also applies to cherry-pick, revert, rebase, stash apply and pull (§D1.12).
- **R10** Invalid `core.autocrlf` / `core.safecrlf` refuse every command with `CONFIG_BAD_BOOLEAN_VALUE`; invalid `core.eol` is silently unset; invalid `merge.renormalize` refuses merge-family commands only (§D1.8).
- **R11** No-conversion fast path: with `core.autocrlf` unset/false and no `text`/`eol`/`crlf`/`ident`/`filter` attribute engaged, the add, compare and checkout paths make no extra copy of blob bytes and the streamed checkout stays untransformed.
- **R12** Symlinks and gitlinks are never converted; empty blobs are never converted.

## Design

### D1. Pinned behaviour (git 2.55.0)

#### D1.1 Add matrix — blob bytes per `core.autocrlf` × `core.eol` × attribute

Probe (one fresh repo per cell, all five fixtures added together):

```sh
d=$(mktemp -d); g init -q $d; <write fixtures>; [ attr ] && echo "* <attr>" > $d/.git/info/attributes
(cd $d && g <cfg> add lf crlf mixed nul lone-cr 2>&1 >/dev/null)   # count 'warning' lines, exit code
(cd $d && g cat-file blob :<f> | enc)
```

Cell code = five characters for `[LF, CRLF, MIXED, NUL, LONE-CR]`: `=` blob equals the worktree
bytes, `L` blob has every CR-before-LF removed (a lone CR stays: `LONE-CR` → `aRbN`, `NUL` → `a0NbN`).
`wN` = number of `warning:` lines (default `core.safecrlf` is `warn`). Every cell exited 0.

| autocrlf | eol | none | `text` | `-text` | `text=auto` | `eol=lf` | `eol=crlf` | `binary` |
|---|---|---|---|---|---|---|---|---|
| unset | unset | `=====` w0 | `=LLLL` w4 | `=====` w0 | `=LL==` w2 | `=LLLL` w4 | `=LLLL` w2 | `=====` w0 |
| unset | lf | `=====` w0 | `=LLLL` w4 | `=====` w0 | `=LL==` w2 | `=LLLL` w4 | `=LLLL` w2 | `=====` w0 |
| unset | crlf | `=====` w0 | `=LLLL` w2 | `=====` w0 | `=LL==` w2 | `=LLLL` w4 | `=LLLL` w2 | `=====` w0 |
| unset | native | `=====` w0 | `=LLLL` w4 | `=====` w0 | `=LL==` w2 | `=LLLL` w4 | `=LLLL` w2 | `=====` w0 |
| false | unset | `=====` w0 | `=LLLL` w4 | `=====` w0 | `=LL==` w2 | `=LLLL` w4 | `=LLLL` w2 | `=====` w0 |
| false | lf | `=====` w0 | `=LLLL` w4 | `=====` w0 | `=LL==` w2 | `=LLLL` w4 | `=LLLL` w2 | `=====` w0 |
| false | crlf | `=====` w0 | `=LLLL` w2 | `=====` w0 | `=LL==` w2 | `=LLLL` w4 | `=LLLL` w2 | `=====` w0 |
| false | native | `=====` w0 | `=LLLL` w4 | `=====` w0 | `=LL==` w2 | `=LLLL` w4 | `=LLLL` w2 | `=====` w0 |
| true | unset | `=LL==` w2 | `=LLLL` w2 | `=====` w0 | `=LL==` w2 | `=LLLL` w4 | `=LLLL` w2 | `=====` w0 |
| true | lf | `=LL==` w2 | `=LLLL` w2 | `=====` w0 | `=LL==` w2 | `=LLLL` w4 | `=LLLL` w2 | `=====` w0 |
| true | crlf | `=LL==` w2 | `=LLLL` w2 | `=====` w0 | `=LL==` w2 | `=LLLL` w4 | `=LLLL` w2 | `=====` w0 |
| true | native | `=LL==` w2 | `=LLLL` w2 | `=====` w0 | `=LL==` w2 | `=LLLL` w4 | `=LLLL` w2 | `=====` w0 |
| input | unset | `=LL==` w2 | `=LLLL` w4 | `=====` w0 | `=LL==` w2 | `=LLLL` w4 | `=LLLL` w2 | `=====` w0 |
| input | lf | `=LL==` w2 | `=LLLL` w4 | `=====` w0 | `=LL==` w2 | `=LLLL` w4 | `=LLLL` w2 | `=====` w0 |
| input | crlf | `=LL==` w2 | `=LLLL` w4 | `=====` w0 | `=LL==` w2 | `=LLLL` w4 | `=LLLL` w2 | `=====` w0 |
| input | native | `=LL==` w2 | `=LLLL` w4 | `=====` w0 | `=LL==` w2 | `=LLLL` w4 | `=LLLL` w2 | `=====` w0 |

Read-outs: blob bytes never depend on `core.eol` (only the warning count does, through the
simulated checkout); `text` / `eol=*` convert even NUL and lone-CR content; `text=auto` and the
autocrlf default skip content git classes binary (NUL, lone CR); an `eol` attribute alone implies
`text`; `-text` and `binary` never convert.

#### D1.2 Checkout matrix — worktree bytes

Probe: one repo, the five fixtures committed raw (no attributes); per cell write
`.git/info/attributes`, `rm` the files, `g <cfg> checkout -- lf crlf mixed nul lone-cr`, `enc` each
file. `=` worktree equals the blob, `C` every LF not preceded by CR became CRLF.

| autocrlf | eol | none | `text` | `-text` | `text=auto` | `eol=lf` | `eol=crlf` | `binary` |
|---|---|---|---|---|---|---|---|---|
| unset / false | unset, lf, native | `=====` | `=====` | `=====` | `=====` | `=====` | `C=C==` | `=====` |
| unset / false | crlf | `=====` | `C=C==` | `=====` | `C====` | `=====` | `C=C==` | `=====` |
| true | any | `C====` | `C=C==` | `=====` | `C====` | `=====` | `C=C==` | `=====` |
| input | any | `=====` | `=====` | `=====` | `=====` | `=====` | `C=C==` | `=====` |

(Each grouped row was observed identically for every member; the raw 16-row output is kept by the
interop suite as its table.) `MIXED` converts under `text` / `eol=crlf` but not under `text=auto` /
autocrlf: the "any CR or CRLF present → leave it" rule. `NUL` / `LONE-CR` carry no lone LF, so §D1.3
adds fixtures that do.

#### D1.3 Edge fixtures

Checkout, `core.autocrlf=true`, blobs committed raw: `nul-lf`=`a\0\nb\n`, `lone-cr-lf`=`a\rb\n`,
`trail-cr`=`a\r`, `no-eol`=`a\nb`, `empty`=``.

```
attr=[none]               nul-lf=a0NbN    lone-cr-lf=aRbN   trail-cr=aR no-eol=aRNb empty=0
attr=[text]               nul-lf=a0RNbRN  lone-cr-lf=aRbRN  trail-cr=aR no-eol=aRNb empty=0
attr=[text=auto]          nul-lf=a0NbN    lone-cr-lf=aRbN   trail-cr=aR no-eol=aRNb empty=0
attr=[eol=crlf]           nul-lf=a0RNbRN  lone-cr-lf=aRbRN  trail-cr=aR no-eol=aRNb empty=0
attr=[text=auto eol=crlf] nul-lf=a0NbN    lone-cr-lf=aRbN   trail-cr=aR no-eol=aRNb empty=0
attr=[-text eol=crlf]     nul-lf=a0NbN    lone-cr-lf=aRbN   trail-cr=aR no-eol=aNb  empty=0
attr=[crlf]               nul-lf=a0RNbRN  lone-cr-lf=aRbRN  trail-cr=aR no-eol=aRNb empty=0
attr=[-crlf]              nul-lf=a0NbN    lone-cr-lf=aRbN   trail-cr=aR no-eol=aNb  empty=0
attr=[text=foo]           nul-lf=a0NbN    lone-cr-lf=aRbN   trail-cr=aR no-eol=aRNb empty=0
```

Add, autocrlf unset: `crlf`=`a\r\nb\r\n`, `mixed`=`a\r\nb\n`, `lone-cr`=`a\rb\r\n`, `trail-cr`=`a\r`,
`crlf-no-eol`=`a\r\nb`.

```
attr=[crlf]               crlf=aNbN   mixed=aNbN   lone-cr=aRbN   trail-cr=aR crlf-no-eol=aNb
attr=[-crlf]              crlf=aRNbRN mixed=aRNbN  lone-cr=aRbRN  trail-cr=aR crlf-no-eol=aRNb
attr=[crlf=input]         crlf=aNbN   mixed=aNbN   lone-cr=aRbN   trail-cr=aR crlf-no-eol=aNb
attr=[text=input]         crlf=aNbN   mixed=aNbN   lone-cr=aRbN   trail-cr=aR crlf-no-eol=aNb
attr=[text=foo]           crlf=aRNbRN mixed=aRNbN  lone-cr=aRbRN  trail-cr=aR crlf-no-eol=aRNb
attr=[text=foo crlf]      crlf=aNbN   mixed=aNbN   lone-cr=aRbN   trail-cr=aR crlf-no-eol=aNb
attr=[text=auto eol=lf]   crlf=aNbN   mixed=aNbN   lone-cr=aRbRN  trail-cr=aR crlf-no-eol=aNb
attr=[text=auto eol=crlf] crlf=aNbN   mixed=aNbN   lone-cr=aRbRN  trail-cr=aR crlf-no-eol=aNb
attr=[-text eol=crlf]     crlf=aRNbRN mixed=aRNbN  lone-cr=aRbRN  trail-cr=aR crlf-no-eol=aRNb
attr=[binary text]        crlf=aNbN   mixed=aNbN   lone-cr=aRbN   trail-cr=aR crlf-no-eol=aNb
```

Read-outs: the legacy `crlf` attribute is consulted only when `text` is unspecified or an
unrecognised value (`text=foo crlf` converts, `text=foo` alone does not); `text=input` and
`crlf=input` mean "LF in the repository, no CRLF on checkout"; a `-text` / `binary` path ignores
`eol`; a later `text` re-enables conversion after the `binary` macro (`binary text` converts); a
trailing lone CR is never touched; a last line without LF converts its CRLF.

Empty blob under `text eol=crlf` with `core.safecrlf=true`: `rc=0 oid=e69de29bb2d1d6434b8b29ae775ad8c2e48c5391`.

Symlinks, attribute `* text eol=crlf ident`, target `a\r\nb\n$Id$`: `blob=[aRNbN$Id$]`, and after
`checkout -- l` the link target reads back unchanged (`readlink`) — never converted.

#### D1.4 Binary heuristic (`text=auto`, add)

```
nul-far    = 9000×'a' + "\0\r\n"           wt=9003 blob=9003   (NUL past byte 8000: still binary)
r127      = 127×'a' + "\x01\r\n"          wt=130  blob=130    (binary)
r128      = 128×'a' + "\x01\r\n"          wt=131  blob=130    (text: converted)
r128eof   = 128×'a' + "\x01\r\n\x1a"      wt=132  blob=131    (trailing ^Z not counted)
r128x2eof = 128×'a' + "\x01\x01\r\n\x1a"  wt=133  blob=133    (binary)
ctl       = "\x1b\t\b\x0c" + "x\r\n"      wt=7    blob=6      (ESC, HT, BS, FF count printable)
```

So git's conversion classifier scans the **whole** buffer (unlike diff's first-8000-bytes test):
binary iff any lone CR, any NUL, or `(printable >> 7) < non-printable`, where CRLF / lone LF are
counted apart, DEL and controls other than BS/HT/ESC/FF are non-printable, bytes ≥ 0x80 are
printable, and one trailing `0x1A` is discounted. (Transcribes `convert.c` `gather_stats` /
`convert_is_binary`; this pin is its proof.)

#### D1.5 "CRLF already in the index" rule

Committed raw `a\r\nb\r\n`, then attribute set, worktree rewritten to `a\r\nb\r\nc\r\n`, `g add f`:

```
attr=[text=auto]           blob=aRNbRNcRN
cfg=[core.autocrlf=true]   blob=aRNbRNcRN
cfg=[core.autocrlf=input]  blob=aRNbRNcRN
attr=[text]                blob=aNbNcN       (+ warning: CRLF will be replaced by LF)
attr=[text=auto eol=crlf]  blob=aRNbRNcRN
attr=[text=auto] add --renormalize  blob=aNbNcN
```

Under the `auto` family only, a path whose index blob is text and contains a CRLF is not
normalised; `--renormalize` ignores the rule. `status` relies on the same rule: index CRLF + new
`text=auto` + untouched worktree → `status=[]` (clean), and `add --renormalize .` then stages `M  f`.

#### D1.6 `core.safecrlf`

Add, per value and direction (`lf`/`mixed` under `-c core.autocrlf=true`; `crlf` under
`-c core.autocrlf=input`; `crlf-attr` with `crlf-attr eol=lf`):

```
safecrlf=unset|warn file=lf       rc=0   idx=1 out=[warning: in the working copy of 'lf', LF will be replaced by CRLF the next time Git touches it]
safecrlf=unset|warn file=crlf     rc=0   idx=1 out=[warning: in the working copy of 'crlf', CRLF will be replaced by LF the next time Git touches it]
safecrlf=unset|warn file=mixed    rc=0   idx=1 out=[warning: in the working copy of 'mixed', LF will be replaced by CRLF the next time Git touches it]
safecrlf=unset|warn file=crlf-attr rc=0   idx=1 out=[warning: in the working copy of 'crlf-attr', CRLF will be replaced by LF the next time Git touches it]
safecrlf=false      (all four)    rc=0   idx=1 out=[]
safecrlf=true  file=lf            rc=128 idx=0 out=[fatal: LF would be replaced by CRLF in lf]
safecrlf=true  file=crlf          rc=128 idx=0 out=[fatal: CRLF would be replaced by LF in crlf]
safecrlf=true  file=mixed         rc=128 idx=0 out=[fatal: LF would be replaced by CRLF in mixed]
safecrlf=true  file=crlf-attr      rc=128 idx=0 out=[fatal: CRLF would be replaced by LF in crlf-attr]
```

`MIXED` reports the LF direction: git checks CRLF-loss first, then LF-loss, one notice per path.
Partial failure — `g -c core.safecrlf=true -c core.autocrlf=true add a1 b2 c3` with `a1`, `c3` CRLF
and `b2` LF: `rc=128 out=[fatal: LF would be replaced by CRLF in b2] ls=[] objects=1` — the index is
untouched, `a1`'s blob (hashed before) stays in the object store, `c3` is never hashed.

Per route, `core.safecrlf=true -c core.autocrlf=true`, worktree LF edit of a committed LF file:

```
status --porcelain   rc=0   out=[ M f]                                   (no warning, no refusal)
diff --stat          rc=0   out=[warning: in the working copy of 'f', LF will be replaced by CRLF ...]  (die downgraded to warn; no tsgit route)
hash-object f        rc=0   out=[de980441c3ab03a8c07dda1ad27b8a11f39deb1e]
hash-object -w f     rc=128 out=[fatal: LF would be replaced by CRLF in f]
commit -qam two      rc=128 out=[fatal: LF would be replaced by CRLF in f]
stash                rc=1   out=[fatal: LF would be replaced by CRLF in f|Cannot save the current worktree state]
stash (warn default) rc=0   out=[warning: in the working copy of 'f', LF will be replaced by CRLF ...|Saved working directory ...]
blame -s f           rc=0   3 lines, no warning
checkout -- f        rc=0   out=[] wt=[aRNbRN]
add --renormalize .  rc=0   out=[] blob=[aNbN]   (CRLF blob, text=auto: renormalization never checks)
merge -X renormalize rc=0   out=[Auto-merging f]
```

So the round-trip check runs only when a to-git conversion **writes an object** (add, stash push,
hash-object -w, commit -a), never on renormalization, comparison, blame or any to-worktree
route; `diff` of the worktree downgrades `true` to a warning (no tsgit route). An empty file
never trips it (§D1.3); a file the `auto` family classes binary never trips it: the `text=auto` column of §D1.1 counts w2 — `CRLF` and `MIXED` warn, the binary
`NUL` and `LONE-CR` do not, while the `text` column (no binary test) counts w4.

#### D1.7 Attribute sources per command

```
# commit introducing '*.txt eol=crlf' and an f.txt change, then `checkout main; checkout side`
switch: f.txt=[aRNbRNcRN]                                          # new .gitattributes from the target index
# index .gitattributes '*.txt eol=crlf', worktree .gitattributes '*.txt eol=lf', rm f.txt, then:
checkout -- f.txt          f.txt=[aNbN]                            # worktree wins
restore f.txt              f.txt=[aNbN]
checkout HEAD -- f.txt     f.txt=[aNbN]
checkout-index -f f.txt    f.txt=[aNbN]
reset -q --hard            f.txt=[aRNbRN]                          # index wins
checkout -q -f HEAD        f.txt=[aRNbRN]
# .gitattributes deleted from the worktree, still in the index:
checkout -- f.txt          f.txt=[aRNbRN]                          # index fallback
add f.txt ('*.txt text' only in index, CRLF worktree)  blob=[aNbN]
# worktree '*.txt text', index '*.txt -text':
add f.txt                  blob=[aNbN]                             # worktree wins
# untracked worktree '*.txt eol=crlf', nothing in index, rm f.txt, reset --hard:
f.txt=[aRNbRN]                                                     # worktree fallback
# archive: tree '*.txt eol=crlf', worktree rewritten to '*.txt -text -ident':
f.txt=[aRNbRN]                                                     # tree wins, worktree ignored
# archive: '*.dat eol=crlf' in .git/info/attributes only:   g.dat=[aRNbRN]
# archive: no attribute, -c core.autocrlf=true:              g.dat=[aRNbRN]  (tar and zip)
```

Three directions (git `attr.c` `read_attr`): **check-in** (worktree `.gitattributes`, else the index
blob) — add, status-family comparison, stash push, blame, path-restore checkouts; **checkout**
(result-index blob, else worktree) — every `unpack_trees` write: switch, reset --hard, merge
family, clone, sparse apply; **tree** — archive. `info/attributes` and `core.attributesFile` apply
in all three.

#### D1.8 Configuration grammar

```
cfg=[core.autocrlf=foo]   rev-parse|status|add  rc=128 fatal: bad boolean config value 'foo' for 'core.autocrlf'
cfg=[core.safecrlf=foo]   rev-parse|status|add  rc=128 fatal: bad boolean config value 'foo' for 'core.safecrlf'
cfg=[core.eol=foo]        rev-parse|status|add  rc=0   (treated as unset)
cfg=[core.autocrlf=]      rc=0 (false)          cfg=[core.autocrlf] (no value) add → LF→CRLF warning (true)
cfg=[core.autocrlf=INPUT] rc=0 (input; case-insensitive)   cfg=[core.safecrlf=WARN] rc=0
cfg=[core.eol=CRLF]       rc=0 (crlf; case-insensitive)
cfg=[merge.renormalize=foo] merge rc=128 fatal: bad boolean config value 'foo' for 'merge.renormalize'
                            status rc=0, stash list rc=0
```

#### D1.9 `ident`

Add then `checkout -- <f>` with `* ident` (sha1 repo):

```
a: blob=[x $Id$ yN]            wt=[x $Id: 08a4620a27060eb3dbee93734f82d9146bfd1b4d $ yN]
b: '$Id: deadbeef $'   blob=[$Id$N]   wt=[$Id: 055c8729cdcc372500a08db659c045e16c4409fb $N]
c: '$Id:garbage$'      blob=[$Id$N]   (collapsed)
d: '$Id: has space x $' blob=[$Id$N]  (collapse ignores spaces)
e: '$Id: nl\n$ $Id$'   blob kept;     wt=[$Id: nlN$ $Id: 6633b04e… $N]   (keyword never spans a LF)
f: 'a\0$Id$'           wt=[a0$Id: 721b31ef… $N]                          (binary content expands too)
g: '$Id$$Id$'          wt=[$Id: c068c19e… $$Id: c068c19e… $N]
h: '$Id\n'             untouched
status=[]                                                        (expanded worktree reads clean)
sha256 repo: wt=[$Id: 746298a10ca2cb9f978433b2e3ccb0dc69fe53a9838ef2ed765be6d8b780a98d $N]
```

The expansion is `$Id: <hex of the blob id> $` at the repository's hash width.

Foreign idents, committed raw then checked out under `* ident`: `wt=[$Id: has space x $N$Id: 690f… $N…]`
and `status=[ M a]` — an `$Id: … $` with an inner space is kept on checkout but still collapses on
add, so the file reads modified (git's own asymmetry, reproduced).

**git has two expanders that disagree.** Blob `$$Id$\n$Id:a b$\n$Id: a\tb $\n$Id$Id$\n`
(`9f31f98b…`), `checkout -- f`:

```
attr=[ident]            wt=[$$Id$N$Id: <oid> $N$Id: aTb $N$Id: <oid> $Id$N]          # streamed
attr=[ident eol=crlf]   wt=[$$Id$RN$Id: <oid> $RN$Id: aTb $RN$Id: <oid> $Id$RN]      # streamed
attr=[ident -text]      wt=[$$Id$N$Id: <oid> $N$Id: aTb $N$Id: <oid> $Id$N]          # streamed
attr=[ident text=auto]  wt=[$$Id: <oid> $N$Id:a b$N$Id: <oid> $N$Id: <oid> $Id$N]    # in core
archive, attr=[ident]   =[$$Id: <oid> $N$Id:a b$N$Id: <oid> $N$Id: <oid> $Id$N]      # in core
```

The in-core expander (`ident_to_worktree`) expands `$$Id$` and keeps `$Id:a b$` (foreign: a 0x20
byte anywhere in the value except its first and last byte) but replaces `$Id: a\tb $`; the streamed one (`ident_filter`)
treats the `$` of `$$` as consumed, replaces `$Id:a b$` (foreign only after a literal `$Id: `) and
keeps `$Id: a\tb $` (any `isspace` not followed by `$`). Upstream inconsistency, recorded here and
reproduced route by route (§D3.3).

#### D1.10 Order of operations

Attributes `* text ident filter=t`, `filter.t.clean = printf 'Z\r\n$Id: q $\r\n'; cat`,
`filter.t.smudge = LC_ALL=C tr 'R$\r' 'r#R'`, worktree `aR\r\nb\r\n` (the `R` is a literal letter):

```
blob=[ZN$Id$NaRNbN]                                                   # clean output → CRLF→LF → ident collapse
checkout -c core.autocrlf=true: wt=[ZRN#Id: 1f9175cd3f40aaaab30f6537f3cd516f273bad9f #RNarRNbRN]
```

The smudge filter received CRs and an expanded `$Id: <blob oid> $` (shown as `#`), so ident and
CRLF ran before it; the clean output's CRLF and `$Id: q $` were normalised, so they ran after
clean. `convert_to_git` = clean → (encoding) → CRLF → ident; `convert_to_working_tree` = ident →
CRLF → (encoding) → smudge. The expansion hashes the blob (the pre-CRLF bytes), i.e. it is the
index entry's id.

#### D1.11 Streaming vs in core

Checkout of a corrupted loose blob (`printf 'garbage-not-zlib' > <loose object>`), `checkout -- f`:

```
attr=[none]       rc=128 exists=yes size=0
attr=[eol=crlf]   rc=128 exists=yes size=0     # streamed with an LF→CRLF stream filter
attr=[ident]      rc=128 exists=yes size=0     # streamed with the ident stream filter
attr=[-text]      rc=128 exists=yes size=0
attr=[text=auto]  rc=128 exists=no  out=[error: inflate: …|error: unable to unpack 422c2b7… header]   # in core
```

`core.bigFileThreshold=10`, `add f` (19-byte LF file):

```
attr=[none] packs=1 loose=0    attr=[-text] packs=1 loose=0
attr=[text=auto] packs=0 loose=1   attr=[text] packs=0 loose=1   attr=[ident] packs=0 loose=1   attr=[eol=lf] packs=0 loose=1
cfg=[core.autocrlf=true] packs=0
```

So on checkout git streams unless the class is in core: a filter driver naming
`process`/`smudge`/`clean` (existing `smudgesInCore`), or a CRLF action of the `auto` /
`auto-crlf` kind (stats needed before the first byte). `ident`, `text`→CRLF, `eol=crlf` stream.
On add, any engaged CRLF action or `ident` forces the in-core hash (git's `would_convert_to_git`)
— tsgit's add is in core already, so blob ids agree (the pack-vs-loose difference of the
unconverted big-file case predates this feature and is out of scope).

#### D1.12 Renormalization

Base `f`=`a\r\nb\r\nc\r\n`; `side` adds `* text=auto`, renormalizes and edits line 1 (`A\nb\nc\n`);
`main` edits line 3 in CRLF (`a\r\nb\r\nC\r\n`):

```
merge side                         rc=1 CONFLICT (content): Merge conflict in f
merge -X renormalize side          rc=0 f=[ANbNCN] blob=[ANbNCN]  (24938456d42b76634c499d30bb6db8c59df815ec)
-c merge.renormalize=true merge    rc=0 blob=[ANbNCN]
-c merge.renormalize=true merge -X no-renormalize   rc=1
-c merge.renormalize=true cherry-pick side          rc=0 blob=[ANbNCN]
cherry-pick -X renormalize side    rc=0 blob=[ANbNCN]
cherry-pick side                   rc=1
-c merge.renormalize=true rebase side               rc=0 blob=[ANbNCN]
rebase side                        rc=1
# revert of a CRLF edit across a renormalizing commit; stash apply of a CRLF edit onto it:
revert --no-edit HEAD~1            rc=1     -c merge.renormalize=true: rc=0 blob=[ANbNcN]
stash apply                        rc=1     -c merge.renormalize=true: rc=0 wt=[ANbNCN]
# no attributes, -c core.autocrlf=true, same history without .gitattributes:
merge -X renormalize               rc=0 blob=[ANbNCN] wt=[A\r\nb\r\nC\r\n]
# modify/delete: side only renormalizes f, main deletes it
merge side                         rc=1 CONFLICT (modify/delete): f deleted in HEAD and modified in side. …
merge -X renormalize side          rc=0 ls=[.gitattributes k]   (no conflict, f stays deleted)
```

Attribute source for the renormalization is the merged `.gitattributes`:

```
.gitattributes added by one side only (above)                     → that version (clean merge)
base text=auto, ours '-text #o', theirs '-text #t' (conflict)     → f merges (f-stages=1): base governs
no base, ours -text, theirs text=auto (add/add conflict)          → f conflicts (3 stages)
no base, ours text=auto, theirs -text                             → f merges: ours governs
base '* -text', ours line 1 → '* text=auto', theirs edits line 5   → .gitattributes merges cleanly to
   '* text=auto…' yet f conflicts (3 stages): the base still governs
```

So: when `.gitattributes` resolved without a content merge, its result governs; when it needed a
content merge (clean or not), the base version governs when present, else ours (merge-ort places
base/ours/theirs at index stages 0/1/2 of its attribute index and the lookup takes the lowest
stage present). Upstream quirk, reproduced.

`add --renormalize`: skips skip-worktree entries (sparse cone `in`: `in=[aN] out=[aRN]`, `S out/f`),
stages modified tracked files at their renormalized bytes (`m=[aNbNzN]`), never adds untracked
paths (`u` not staged), leaves the worktree untouched (`wt-t=[aRNbRN]`).

#### D1.13 Other routes

```
autocrlf=true, LF blob checked out (wt=[aRNbRN]), touched after 1.1 s:
  status=[] diff=[]   and without autocrlf: status=[ M f]
index CRLF, autocrlf=true, worktree CRLF touched: status=[]
index LF, attr 'text eol=crlf', worktree LF touched: status=[]
stash under autocrlf=true, worktree a\r\nb\r\nc\r\n:
  after stash wt=[aRNbRN] stash-blob=[aNbNcN]; after pop wt=[aRNbRNcRN] status=[ M f]
merge under autocrlf=true: conflict wt=[<<<<<<< HEAD\r\ny\r\n=======\r\nx\r\n>>>>>>> s\r\nb\r\n]
                           clean-merged wt=[xRNbRNyRN] blob=[xNbNyN]
blame -s f, autocrlf=true, worktree CRLF: [^c73e67d 1) aN^c73e67d 2) bN00000000 3) cN]  (converted)
blame -s f, no conversion:                [00000000 1) aRN00000000 2) bRN00000000 3) cRN]
grep -h -e b f, autocrlf=true:            [bRN]   (worktree read raw: no conversion)
tree diff / cat-file / show with '* eol=crlf': [ aN bN+cN] / [aNbNcN] / [aNbNcN]  (no conversion)
racy smudge: autocrlf=true checkout -- f, then update-index --really-refresh + status
  with  -c core.autocrlf=true: size=6 (kept)   without: size=0 (smudged)
autocrlf=true (repo config), f checked out CRLF, reset -q --mixed HEAD~1:
  ls-files --debug size=0  status=[ M f]
```

### D2. Layering — where conversion sits

```
                    to-git (add, stash push, compare, blame)          to-worktree (checkout family, merge writes, archive)
worktree bytes ──► [filter clean] ─► [CRLF→LF] ─► [ident collapse] ─► blob
blob ───────────► [ident expand] ─► [LF→CRLF] ─► [filter smudge] ─► worktree bytes
                   └──────────── src/domain/eol (pure) ─────────────┘   └ existing apply-*-filter (runner)
```

- **Domain (pure, no I/O)** — new `src/domain/eol/`: byte statistics, the binary classifier, the
  CRLF-action resolution (git's `convert_attrs` + `text_eol_is_crlf` + `output_eol`), the two
  CRLF converters, the safecrlf simulation, the `ident` scanners (collapse, in-core expand,
  streamed expand) and the LF→CRLF stream transform. Byte-level on `Uint8Array` only (never a
  text decoder); a converted result is a freshly allocated array of exact size, an unchanged input is returned as the same reference, never a `subarray` view of a
  larger buffer.
- **Primitive** — new `src/application/primitives/internal/convert-blob.ts` composing the steps in
  git's order around the existing `applyCleanFilter` / `applySmudgeFilter`, plus
  `src/application/primitives/resolve-conversion.ts` resolving one path's whole conversion
  (filter choice + CRLF action + ident) from a single `sourcesForPath` lookup. Every call site that
  today calls `resolveFilterDriver` + `applyCleanFilter` / `applySmudgeFilter` calls these instead.
- **Call sites** — the routes of §D3.5 only.

This placement is ratified by ADR-950 (DC-1 option (a)).

### D3. Data shapes and signatures

#### D3.1 Domain (`src/domain/eol/`)

```ts
// text-stats.ts — gather_stats / convert_is_binary
export interface TextStats {
  readonly nul: number; readonly loneCr: number; readonly loneLf: number; readonly crlf: number;
  readonly printable: number; readonly nonPrintable: number;
}
export const gatherTextStats = (bytes: Uint8Array): TextStats;
export const isBinaryText = (stats: TextStats): boolean;

// crlf-action.ts — convert_attrs + text_eol_is_crlf + output_eol
export type AutoCrlf = boolean | 'input';
export type CoreEol = 'lf' | 'crlf' | 'native';            // undefined = unset
export type LineEnding = 'lf' | 'crlf';
export type CrlfAction =
  | 'binary' | 'text-input' | 'text-crlf' | 'auto' | 'auto-input' | 'auto-crlf';
export interface EolSettings {
  readonly autoCrlf: AutoCrlf;                               // default false
  readonly coreEol?: CoreEol;
  readonly safeCrlf: boolean | 'warn';                    // default 'warn' (git's default)
  readonly nativeEol: LineEnding;                            // adapter-supplied (ADR-957): Node win32 → crlf, else lf
}
export interface ConversionAttributes {                      // raw resolved values
  readonly text: AttributeValue; readonly crlf: AttributeValue; readonly eol: AttributeValue;
}
export const resolveCrlfAction = (attrs: ConversionAttributes, settings: EolSettings): CrlfAction;
export const outputLineEnding = (action: CrlfAction, settings: EolSettings): LineEnding | undefined;

// crlf-conversion.ts — crlf_to_git / crlf_to_worktree / check_global_conv_flags_eol
export type RoundTripLoss = 'crlf-to-lf' | 'lf-to-crlf';
export interface CrlfToGitInput {
  readonly bytes: Uint8Array;
  readonly action: CrlfAction;
  readonly settings: EolSettings;
  readonly renormalize: boolean;
  /** Read lazily: only an `auto*` action with CRLF present consults the index blob. */
  readonly indexHasCrlf: () => Promise<boolean>;
}
/** A lossy simulated round trip, with the counts of the same stats pass (ADR-952). */
export interface LineEndingLoss {
  readonly loss: RoundTripLoss;
  readonly crlf: number;                                     // TextStats.crlf of the CRLF step's input
  readonly loneLf: number;                                   // TextStats.loneLf of the CRLF step's input
}
/** The refusal / notice payload (ADRs 952, 953): one shape for both. */
export interface EolRoundTrip extends LineEndingLoss { readonly path: FilePath }
export interface CrlfToGitResult {
  readonly bytes: Uint8Array;                                // same reference when unchanged
  readonly roundTrip?: LineEndingLoss;                       // simulated add+checkout loss, if any
}
export const crlfToGit = (input: CrlfToGitInput): Promise<CrlfToGitResult>;
export const crlfToWorkingTree = (bytes: Uint8Array, action: CrlfAction, settings: EolSettings): Uint8Array;
export const createLfToCrlfTransform = (): ChunkTransform;   // lf_to_crlf_filter (held CR across chunks)

// ident.ts — count_ident / ident_to_git / ident_to_worktree / ident_filter
export const identToGit = (bytes: Uint8Array): Uint8Array;
export const identToWorkingTree = (bytes: Uint8Array, oidHex: string): Uint8Array;      // in core
export const createIdentTransform = (oidHex: string): ChunkTransform;                   // streamed
export interface ChunkTransform {
  readonly push: (chunk: Uint8Array) => ReadonlyArray<Uint8Array>;
  readonly flush: () => ReadonlyArray<Uint8Array>;
}
```

`resolveCrlfAction` transcription (pinned by §D1.1–§D1.3):

| step | rule |
|---|---|
| 1 | `fromValue(text)`: `true`→`text`, `false`→`binary`, `{set:'input'}`→`text-input`, `{set:'auto'}`→`auto`, anything else (incl. `unspecified`, `{set:'foo'}`) → undefined |
| 2 | undefined → `fromValue(crlf)` (legacy attribute) |
| 3 | unless `binary`: `eol=lf` turns `auto`→`auto-input`, else →`text-input`; `eol=crlf` turns `auto`→`auto-crlf`, else →`text-crlf` (an `eol` value other than `lf`/`crlf` is ignored) |
| 4 | `text` → `text-crlf` when `autoCrlf === true`, `text-input` when `'input'`, else `text-crlf` iff `coreEol === 'crlf'` or (`coreEol` undefined and `nativeEol === 'crlf'`) or (`coreEol === 'native'` and `nativeEol === 'crlf'`) |
| 5 | still undefined → `binary` when `autoCrlf === false`, `auto-crlf` when `true`, `auto-input` when `'input'` |

`outputLineEnding`: `binary` → none; `text-crlf`, `auto-crlf` → crlf; `text-input`, `auto-input` →
lf; `auto` → the step-4 rule. `crlfToGit`: `binary` or empty → unchanged, no loss; stats; for
`auto*` a binary classification returns unchanged **before** the loss check; convert iff
`crlf > 0` and not (`auto*` and not renormalize and `indexHasCrlf()`); the loss is the
simulated add-then-checkout (`CRLF` lost first, else `LF` lost), reported as `roundTrip` with
`crlf` / `loneLf` copied from the `TextStats` this step already gathered over its input (the
worktree bytes after any clean filter) — no second scan. `roundTrip` carries the payload's own
field names, so `convertToGit` builds the refusal or notice as `{ path, ...roundTrip }`. `auto*`
strips every CR (a lone CR is impossible past the binary check), the others strip only a CR followed by LF.
`crlfToWorkingTree`: no-op unless output is crlf and the blob has a lone LF; `auto*` additionally
requires no CR/CRLF and a non-binary classification; converts every LF not preceded by CR.

#### D3.2 Resolved conversion (primitive)

```ts
// src/application/primitives/resolve-conversion.ts
export interface Conversion {
  readonly filter: FilterChoice;
  readonly crlf: CrlfAction;
  readonly ident: boolean;
}
export const IDENTITY_CONVERSION: Conversion;               // filter identity, 'binary', false
export const resolveConversion = (
  ctx: Context, provider: AttributeProvider, path: FilePath, settings: EolSettings,
  options?: { readonly eagerSectionValidation?: boolean },
): Promise<Conversion>;
export const isIdentityConversion = (c: Conversion): boolean;
/** git's classify_conv_attrs: in core when a driver names a command, or the CRLF action is auto/auto-crlf. */
export const convertsInCore = (c: Conversion): boolean;
```

`resolveConversion` performs one `sourcesForPath` call and resolves `filter`, `text`, `crlf`,
`eol`, `ident` from it (today's `resolveFilterDriver` resolves `filter` from its own lookup; the
`filter` part is extracted so the eager `[filter "<d>"].required` validation is unchanged). A path
whose `sources` is empty skips attribute matching entirely.

#### D3.3 Composed steps

```ts
// src/application/primitives/internal/convert-blob.ts
export type ConversionRoute = 'write' | 'compare' | 'renormalize';   // selects safecrlf + index rule
export interface ToGitRequest {
  readonly path: FilePath; readonly bytes: Uint8Array; readonly conversion: Conversion;
  readonly route: ConversionRoute;
  readonly settings: EolSettings;
  readonly indexBlob?: ObjectId;                              // stage-0 entry, for the index-CRLF rule
}
export interface ToGitResult {
  readonly bytes: Uint8Array;
  readonly notice?: EolNotice;                                // route 'write' + safeCrlf 'warn' only (ADR-953)
}
export const convertToGit = (ctx: Context, request: ToGitRequest): Promise<ToGitResult>;

export interface ToWorkingTreeRequest {
  readonly target: SmudgeTarget;                              // path, blob id, bytes, metadata
  readonly conversion: Conversion;
  readonly settings: EolSettings;
  readonly normalizing?: boolean;                             // renormalize_buffer: skip CRLF unless a smudge/process driver
}
export const convertToWorkingTree = (ctx: Context, request: ToWorkingTreeRequest): Promise<Uint8Array>;
/** The streamed checkout's transform: ident (streamed expander) then LF→CRLF; undefined = write raw. */
export const workingTreeStreamTransform = (c: Conversion, blob: ObjectId, settings: EolSettings): ChunkTransform | undefined;
```

`convertToGit` = `applyCleanFilter` → `crlfToGit` → `identToGit`; route `write` arms safecrlf
from `CrlfToGitResult.roundTrip` — `true` throws `eolRoundTripUnsafe({ path, ...roundTrip })`,
`warn` returns `notice: { path, ...roundTrip }`, `false` drops it (ADRs 952, 953) — `compare` and
`renormalize` never do; `renormalize` ignores the index-CRLF rule. `convertToGit` itself does not
sequence paths: the index-order gate under `core.safecrlf=true` is the caller's (§D3.7, ADR-954). `convertToWorkingTree` = `identToWorkingTree` (in-core expander) →
`crlfToWorkingTree` → `applySmudgeFilter`. `renormalizeBuffer(ctx, path, bytes, conversion)` =
`convertToWorkingTree({ normalizing: true })` then `convertToGit({ route: 'renormalize' })`
(git `renormalize_buffer`).

Streamed checkout: `writeStreamedBlob(ctx, fullPath, id, mode?, transform?)` — the transform is
applied to the served chunks inside `writeServedBlob`, after `openServedBlob`, so the ADR-931/932
empty-file refusal is unchanged (§D1.11 pins that `eol=crlf` / `ident` refusals leave the empty
file). The in-core class is routed exactly like today's `smudgesInCore` branch: `readBlob` →
`convertToWorkingTree` → `writeWorkingTreeEntry` (a refused read leaves no file, §D1.11
`text=auto`). Memory: streamed transforms hold one byte (LF→CRLF) or one keyword up to the next
`$`/LF (ident), as git does; the in-core class holds the whole blob, as git does.

#### D3.4 Attribute providers by direction (ADR-951)

```ts
// src/application/primitives/internal/read-gitattributes.ts
export type AttributeDirection =
  | { readonly kind: 'worktree-first'; readonly index: IndexBlobLookup }       // worktree, else index blob
  | { readonly kind: 'index-first'; readonly index: IndexBlobLookup }      // result-index blob, else worktree
  | { readonly kind: 'index-only'; readonly index: IndexBlobLookup }         // renormalize's merged attribute index
  | { readonly kind: 'tree'; readonly tree: ObjectId };                 // archive (existing tree reader)
export type IndexBlobLookup = (path: FilePath) => ObjectId | undefined;
export const buildAttributeProvider = (ctx: Context, direction?: AttributeDirection): Promise<AttributeProvider>;
```

The `DirReader` for `worktree-first` tries the worktree file and falls back to the index blob for
`<dir>/.gitattributes`; `index-first` the reverse; `index-only` reads only the lookup. Omitting the
direction keeps today's worktree-only reader for the existing non-conversion consumers
(`build-content-merger` driver lookup, `diff-trees`, `materialise-patch-files`, similarity), which
this design does not re-point. The checkout lookup is the **result** index: current stage-0
entries overlaid with the changeset writes minus its deletes (`applyChangeset` has both). The
merge renormalize lookup follows §D1.12 (result id when `.gitattributes` resolved without a
content merge, else base id, else ours id). For the merge-family **writes** the lookup is the merge
result (ort checks out its result tree, then records conflicts); which blob a content-conflicted
`.gitattributes` contributes there (the marker-bearing result blob or a stage) is **not pinned** by
this design — P7 pins it against git before coding. A bare repository keeps `workDir === undefined` →
no worktree source, unchanged.

`maybeBuildAttributeProvider` goes: every converting route builds its provider lazily, once per
command (git reads attributes on every conversion). The runner gate stays only where it decided
filter execution (the filter step itself still no-ops without a runner, ADR-408).

#### D3.5 Routes

| Route (tsgit site) | git | Direction | Attribute source | safecrlf | Streaming |
|---|---|---|---|---|---|
| `add` literal + bulk — `add.ts` `cleanConversion` / `stageFromStat` | `index_path` + write | to-git | check-in; index lookup = the locked prior index | armed (`write`); `true`: convert + object write strictly in index order, one path at a time, stop at the first loss (ADR-954) — literal `stageLiterals` is serial already, bulk gates through `clean-order.ts` (§D3.7); `warn` / `false`: concurrency unchanged | in core (as today) |
| `add --renormalize` (new `AddOptions.renormalize`) — tracked stage-0 regular/symlink entries, skip-worktree skipped, no untracked | `renormalize_tracked_files` | to-git | check-in | never | in core |
| `status`, `rm`, clean-work-tree, `findWouldOverwrite`, `isWorkingTreeDirty`, stash dirty probe — `compareWorkingTreeDelta` → `cleanWorktreeBytes` | `ce_compare_data` (`index_fd`, no write) | to-git | check-in; index lookup = the entry's own id | never (`compare`) | in core |
| racy-clean smudge — `smudge-racily-clean.ts` via `compareWorkingTreeDelta` | `ce_smudge_racily_clean_entry` | to-git | check-in | never | in core |
| `stash push` W-tree — `stash.ts` `hashFileAt` | `index_path` + write | to-git | check-in | armed (`write`): `true` refuses the push, converting + writing in index order and stopping at the first loss (ADR-954) — `projectWorkingTree` hashes serially in index order already | in core |
| `blame` worktree side — `blame.ts` `readWorkingFile` | `fake_working_tree_commit` | to-git | check-in | never | in core |
| switch, reset --hard, clone, worktree add, sparse apply, path restore — `apply-changeset.ts` `writeBlobToWorkingTree` via `materializeTree` / `applySparseCheckout` | `checkout_entry` | to-worktree | checkout (switch/reset/clone/sparse/worktree), check-in (path restore: `checkout [<rev>] -- <p>`) | — | stream unless `convertsInCore` |
| merge, cherry-pick, revert, rebase, pull, stash apply/pop outcome writes — `merge.ts` 1758-1808, `apply-merge-to-worktree.ts` `writeChangedOutcome` / `writeMarkedConflict`, `write-distinct-types-sides.ts`, `stash.ts:445` | `unpack_trees` → `checkout_entry` | to-worktree (conflict-marker bytes too) | checkout (result index) | — | by class, as git checks the merged blob out: `convertsInCore` → in-core steps; otherwise the stream transform (streamed `ident` expander, LF→CRLF) run over the in-memory merged / conflict bytes |
| `archive` — `archive.ts` `readEntryContent`, before `subst.expandFile` | `convert_to_working_tree` | to-worktree | tree (+ info, + `core.attributesFile`) | — | always in core (in-core `ident` expander) |
| merge renormalize — `build-content-merger.ts` before `resolvePathMergeSpec`; `three-way-tree.ts` modify/delete | `ll_merge` `normalize_file`, `blob_unchanged` | both (`renormalize_buffer`) | index (merged `.gitattributes`, §D1.12) | never | in core |

Adopted under ADR-226 (pinned, not a candidate): the merge-family writes gain the smudge filter
along with conversion, because both are `convert_to_working_tree` in git — today those writes run
neither (code fact, table above). Symlinks (`FILE_MODE.SYMLINK`) and gitlinks bypass every route
(existing guards in `add.ts` `cleanConversion`, `compareWorkingTreeDelta`, `writeBlobToWorkingTree`
are kept and extended to the merge-family writes).

#### D3.6 Configuration

`ParsedConfig.core` gains `autoCrlf?: boolean | 'input'`, `eol?: CoreEol`, `safeCrlf?: boolean | 'warn'`
(lenient parse; `input` / `warn` / `lf` / `crlf` / `native` case-insensitive; empty value = false;
valueless = true; unknown `eol` = unset). `assertEagerConfigValid` gains
`findFirstInvalidAutoCrlf` / `findFirstInvalidSafeCrlf`, mirroring `findFirstInvalidLogAllRefUpdates`
(tri-state `accepts`), so a bad value refuses every command with `CONFIG_BAD_BOOLEAN_VALUE` in
file order (§D1.8). `merge.renormalize` is read beside `readConflictStyle` in
`internal/merge-rename-config.ts` (`readMergeRenormalize`), refusing merge-family commands only.
`EolSettings` is built once per command from `readConfig(ctx)` (ADR-850) plus the native line
ending, a `Context` value each platform adapter supplies (ADR-957): `node-adapter.ts` `crlf` on
win32, else `lf` (injectable in the adapter's options for tests of the win32 arm);
`browser-adapter.ts` and `memory-adapter.ts` `lf`. Never computed in application or domain code,
never a public option; consumed only where git consults `EOL_NATIVE` (§D3.1 step 4, `core.eol=native`).

#### D3.7 safecrlf data and ordering (ADRs 952, 953, 954)

```ts
// src/domain/commands/error.ts — EolRoundTrip / LineEndingLoss from src/domain/eol (§D3.1)
| { readonly code: 'EOL_ROUND_TRIP_UNSAFE'; readonly path: FilePath; readonly loss: RoundTripLoss;
    readonly crlf: number; readonly loneLf: number }
export const eolRoundTripUnsafe = (roundTrip: EolRoundTrip): TsgitError;
// notice (core.safecrlf=warn, git's default) — the same shape (ADR-953)
export type EolNotice = EolRoundTrip;
// src/application/commands/add.ts, stash.ts
AddResult.eolNotices: ReadonlyArray<EolNotice>                    // new field
StashPushResult ({ kind: 'saved' }).eolNotices: ReadonlyArray<EolNotice>
```

`crlf` is the number of CRLF sequences and `loneLf` the number of LF bytes not preceded by CR in
the CRLF step's input (`gatherTextStats`); git prints neither (tsgit-specific fields, ADR-952).
Notices are listed in index order — bulk add collects them from `stagedOutcomes` (walk order), not
from completion order; `false` yields `[]`, `add --renormalize` yields `[]` by construction, and no
route writes them to `ctx.logger` (ADR-953).

Reconstruction in the interop test: `loss === 'crlf-to-lf'` → `fatal: CRLF would be replaced by LF in <path>` /
`warning: in the working copy of '<path>', CRLF will be replaced by LF the next time Git touches it`;
`'lf-to-crlf'` → the LF/CRLF-swapped lines (§D1.6). The refusal is the first offending path in
git's processing order.

**Ordering under `core.safecrlf=true` (ADR-954).** git converts and writes one path at a time in
index order and dies at the first loss, leaving the blobs written before it (§D1.6: `objects=1`,
`a1` written, `c3` never hashed). tsgit today:

- literal add — `addLiteralOnly` → `stageLiterals` awaits `stageOne` per path over
  `[...validated].sort(comparePaths)`: serial in index order, the first throw ends the loop. No
  sequencing change.
- `stash push` — `projectWorkingTree` iterates `index.entries` awaiting `hashFileAt` per path:
  serial in index order. No sequencing change.
- bulk add — `addByPathspec` → `stageIgnoredWalk` and `addAll`, both through `stageWalkedEntries`
  → `dispatchInCleanOrder`: `withCleanOrder(ctx, …)` opens the sequence; `dispatchWalkEntry`
  calls `order.enlist(path)` in walk order, runs `stage` under `limiterFor(ctx, 'ioBound')` (FIFO)
  and `order.release(path)` in `.finally`. Only the filter run is gated: `applyCleanFilter` →
  `runInOrder` brackets the driver with `admitClean(ctx, path)` / `releaseClean(ctx, path)`.
  Reads, CRLF, hashing and `writeObject` run concurrently.

Change — bulk add only, only when `EolSettings.safeCrlf === true`:

```ts
// src/application/primitives/internal/clean-order.ts
export type OrderSpan = 'clean' | 'write';                        // 'clean' = today's behaviour
export const withCleanOrder = <T>(ctx: Context, body: (order: CleanOrder) => Promise<T>, span?: OrderSpan): Promise<T>;
/** Resolves once `path` may convert and write: at once unless a 'write' span is open; rejects once it halted. */
export const admitWrite = (ctx: Context, path: FilePath): Promise<void>;
export interface CleanOrder {
  enlist(path: FilePath): void;
  release(path: FilePath): void;
  /** 'write' span: `path` failed — every later waiter and later admitWrite rejects with `error`. */
  halt(path: FilePath, error: unknown): void;
}
```

- `dispatchInCleanOrder` opens the span `'write'` when `safeCrlf === true`, else `'clean'`.
- `writeCleanedBlob` awaits `admitWrite(ctx, path)` after `readContent` and before conversion; the
  turn is held through `writeObject` and handed on by `dispatchWalkEntry`'s existing
  `order.release(path)` once `stageFromStat` settles. Reads still overlap under the limiter
  (unobservable); conversion, hashing and the object write do not.
- Under `'write'`, `releaseClean` is a no-op — the filter step must not hand the turn on before
  the blob is written; `admitClean` resolves at once for the path already admitted.
- A failed stage under `'write'` calls `order.halt(path, error)` instead of `release`: every path
  enlisted after it rejects with that same error before converting, so no later blob is written;
  `stagedOutcomes` already surfaces the earliest-walked failure, i.e. git's path. Paths enlisted
  before it are unaffected (they were released before it was admitted).
- Under `'clean'` (`warn`, `false`) `admitWrite` resolves at once and `halt` is never called:
  today's concurrency is unchanged.

#### D3.8 Renormalize in merges (ADR-956)

- `parseOrtStrategyOptions` returns `renormalize?: boolean` in `OrtStrategyOptions` instead of
  throwing; `merge.renormalize` supplies the default; `-X` wins (§D1.12 `no-renormalize`).
  Consumers without `-X` (cherry-pick, revert, rebase, stash apply, pull) read the config only.
- `buildContentMerger`: when renormalizing, the three sides pass through `renormalizeBuffer`
  **before** driver dispatch (git normalizes in `ll_merge` before reading the `merge` attribute),
  so external, union and binary drivers all see normalized bytes. The merged result is written as
  is (no second to-git pass) and reaches the worktree through the to-worktree route (§D1.12
  `wt=[A\r\nb\r\nC\r\n]` under autocrlf=true).
- `three-way-tree.ts`: a new optional async `BlobUnchanged` callback beside `ContentMerger`
  (`(path, base, side) => Promise<boolean>`): modes equal and (ids equal or renormalized bytes
  equal) turns a modify/delete into a clean delete unless a rename is involved (git keeps
  rename/delete conflicted).

#### D3.9 Fast path and cost

- **Config gate** — `EolSettings` + `autoCrlf === false` and a path whose `sources` is empty →
  `IDENTITY_CONVERSION` without attribute matching.
- **Identity conversion** — `convertToGit` / `convertToWorkingTree` return the input reference;
  the streamed checkout receives no transform and keeps today's zero-copy chunk path; the add
  path keeps `writeObject` on the bytes read.
- **Index-CRLF probe** — read only for `auto*` actions with `crlf > 0` (git reads it on every
  `auto*` add; skipping when there is no CRLF is unobservable: no conversion either way).
- **Added cost on unconverted repos** — one lazily built provider per converting command (reads
  `info/attributes`, root `.gitattributes`, `core.attributesFile`, then one cached read per
  directory touched). Contexts without a runner pay this where they paid nothing before (git pays
  it always). `bench:ab` on the status, add and checkout benches measures it in implementation.
- **Large blobs** — conversion of `add` / compare is in core (git forces in core on conversion,
  §D1.11); `MAX_WORKING_TREE_BLOB_BYTES` caps still apply before conversion. `core.bigFileThreshold`
  is not consulted by conversion.
- **`core.safecrlf=true`** — bulk add converts and writes one path at a time in index order,
  whether or not any path converts, as ADR-954 words it (§D3.7); R11's no-copy fast path is unaffected; literal add and `stash push` are serial already. The cost lands only on that
  non-default setting: under `warn` (git's default) and `false` the writes stay concurrent, and the
  `bench:ab` runs above use the default.

#### D3.10 Edge behaviour checklist (each pinned above)

Mixed EOL (§D1.1–2), lone CR (§D1.3–4), CRLF on a last line without LF (§D1.3 `crlf-no-eol`, `no-eol`),
trailing lone CR (`trail-cr`), empty blob (§D1.3), a path both `ident` and `text` (§D1.10),
symlinks never converted (§D1.3), gitlinks never written as files (existing `writeBlobToWorkingTree`
guard), the `binary` macro and `binary text` override (§D1.3), `text` on an index blob with NUL
converts on checkout (§D1.3 `nul-lf`), racy-clean smudge compares converted bytes (§D1.13),
skip-worktree entries skipped by `--renormalize` and never written by checkout (§D1.12), a
foreign `$Id: … $` reads modified (§D1.9), sha256 ident width (§D1.9).

#### D3.11 Documentation phase

`docs/use/commands/{add,checkout,merge,status,diff,archive,stash}.md` (conversion, `--renormalize`,
`-X renormalize`, `merge.renormalize`, notices), `docs/use/commands/{cherry-pick,revert,rebase,reset,blame}.md`
(`merge.renormalize` / conversion notes), `docs/use/errors.md` (`EOL_ROUND_TRIP_UNSAFE` with `path` / `loss`
and the tsgit-specific `crlf` / `loneLf` counts git never prints, the bad boolean refusals; the
`add` and `stash` pages document `eolNotices`, the reconstruction of git's lines, and the
index-order writes under `core.safecrlf=true`), `docs/use/primitives/internals.md` (`convertToGit` / `convertToWorkingTree`,
attribute directions).

#### D3.12 Implementation parts (pre-chewed)

| Part | Scope | Context block |
|---|---|---|
| P1 text stats + CRLF action | `src/domain/eol/{text-stats,crlf-action,crlf-conversion,lf-to-crlf-transform,index}.ts` | Signatures §D3.1; rules §D3.1 table; fixtures §D1.1–§D1.5; property siblings `*.properties.test.ts` (§Test strategy). No imports outside `src/domain`. `AttributeValue` from `src/domain/attributes/attribute-value.ts`. |
| P2 ident | `src/domain/eol/{ident,ident-transform}.ts` | Both expanders, collapse, sha1/sha256 width (`oidHex` length from caller); fixtures §D1.9 incl. the divergence blob. |
| P3 config | `config-read.ts` `ParsedConfig.core`, `applyCoreEntry`; new finders beside `findFirstInvalidLogAllRefUpdates`; `repo-state.ts` `assertEagerConfigValid`; `internal/merge-rename-config.ts` `readMergeRenormalize`; native line ending per ADR-957: a `Context` value supplied by `src/adapters/node/node-adapter.ts` (win32 → `crlf`, else `lf`, injectable via its options), `src/adapters/browser/browser-adapter.ts` and `src/adapters/memory/memory-adapter.ts` (`lf`), threaded like `Context.runtime` (`src/ports/context.ts`, `src/repository/compose-adapters.ts`) | Pins §D1.8; tests extend `test/unit/application/primitives/config-read*.test.ts` and the eager-gate suite. |
| P4 attribute directions | `internal/read-gitattributes.ts` `buildAttributeProviderFrom`, `DirReader`, `workTreeDirReader`, `treeDirReader`; remove `maybeBuildAttributeProvider` callers' runner gate | Pins §D1.7, §D1.12; index blob read through `readBlob` with the existing `assertDeclaredSizeWithinCap` / `MAX_GITATTRIBUTES_BYTES` guard. |
| P5 resolve + compose | `resolve-conversion.ts`, `internal/convert-blob.ts`; `write-working-tree-file.ts` `writeStreamedBlob`/`writeServedBlob` gain `transform?` | Reuse `applyCleanFilter`, `applySmudgeFilter`, `smudgesInCore`, `SmudgeTarget`; pins §D1.10, §D1.11. |
| P6 to-git routes | `add.ts` (`cleanConversion`, new `renormalize` option), `compare-working-tree-entry.ts` (`cleanWorktreeBytes`), `stash.ts` (`hashFileAt`, `projectWorkingTree`), `blame.ts` (`readWorkingFile`), result shapes for notices (`AddResult.eolNotices`, `StashPushResult` `saved`.`eolNotices`, ADR-953), the `core.safecrlf=true` index-order gate (ADR-954) in `internal/clean-order.ts` | Pins §D1.1, §D1.5, §D1.6, §D1.12 (`--renormalize`), §D1.13. Sequencing host (§D3.7): `clean-order.ts` `withCleanOrder`, `CleanOrder.enlist`/`release`, `admitClean`/`releaseClean` — today `admitClean`/`releaseClean` are called only by `apply-clean-filter.ts` `runInOrder`, and `withCleanOrder` by `add.ts` `dispatchInCleanOrder` and `status.ts` (compare route, stays `'clean'`); add.ts reaches it through `stageWalkedEntries` (← `stageIgnoredWalk`, `addAll`) → `dispatchInCleanOrder` → `dispatchWalkEntry` (`enlist`, `limiterFor(ctx, 'ioBound')`, `.finally(release)`); `admitWrite` lands in `writeCleanedBlob` between `readContent` and the conversion. Literal `stageLiterals` and stash `projectWorkingTree` are serial already. Adjacent stat guard to check first: `statOnlyVerdict` reports `modified` on any `fileSize` ≠ worktree size, while git falls back to a content compare when the recorded size is 0 (`ie_modified`); with conversion the worktree size differs from the blob size, so any route recording a 0 or blob-sized `fileSize` must be proven against git (`autocrlf=true`, `reset --mixed`, then `status`; git leaves `size: 0` there, §D1.13-style probe). |
| P7 to-worktree routes | `apply-changeset.ts` (`writeBlobToWorkingTree`, `createLazyProvider`, direction option), `materialize-tree.ts`, `merge.ts` 1758-1808, `apply-merge-to-worktree.ts`, `write-distinct-types-sides.ts`, `stash.ts:445`, `archive.ts` `readEntryContent` | Pins §D1.2, §D1.3, §D1.7, §D1.9 (route-specific expander), §D1.11, §D1.13. |
| P8 renormalize merges | `strategy-options.ts` (lift lines 139-140; `Parsed.renormalize` → `OrtStrategyOptions.renormalize`), `merge.ts` doc lines 227-228, `build-content-merger.ts`, `three-way-tree.ts` (`BlobUnchanged`), cherry-pick / revert / rebase / stash / pull wiring of `merge.renormalize` | Pins §D1.12. |

## Decision candidates

Adopted under ADR-226 without a candidate (git settles them, pinned in §D1): every conversion rule
of §D1.1–§D1.5 incl. the legacy `crlf` attribute and `text=input`; git's step order (§D1.10);
the three attribute directions and the renormalize attribute rule (§D1.7, §D1.12); streaming vs
in-core per class with git's two `ident` expanders (§D1.9, §D1.11); safecrlf armed only on
object-writing to-git routes (§D1.6); config grammar and refusal scope (§D1.8); merge-family
writes gaining conversion **and** smudge (§D3.5); racy smudge and blame converting (§D1.13).

Every candidate below was ruled by the user (ADRs 950–957); the Ruling column records the option
taken. Two rulings deviate from the recommendation (DC-3a, DC-3c) and are folded into §D3.1,
§D3.3, §D3.5, §D3.7, §D3.9, P6 and §Test strategy.

| # | Choice | Alternatives (≤3) | Recommendation | Why | Ruling |
|---|---|---|---|---|---|
| DC-1 | Where conversion sits (user point 1) | (a) generalise the existing clean/smudge pipeline into `convertToGit` / `convertToWorkingTree` primitives over pure `src/domain/eol` steps, replacing the filter calls at every site; (b) a separate EOL primitive called next to the filter step at each site; (c) a port-level `FileSystem` decorator converting on read/write | (a) | git's order interleaves filter, CRLF and ident (§D1.10) and the stream/in-core class depends on all three (§D1.11) — one resolver and one composer keep that in one place. (b) duplicates ordering at ~12 sites. (c) cannot see attributes, the index blob or the blob id (ident, index-CRLF rule) and would convert `.git/` reads. | option (a) — ADR-950 |
| DC-2 | Attribute-source API (user point 2; the behaviour itself is pinned, §D1.7) | (a) one `buildAttributeProvider(ctx, direction)` with `worktree-first` / `index-first` / `index-only` / `tree`; (b) four named factories; (c) keep the worktree-only provider for checkout writes (diverges: §D1.7 `switch` and `reset --hard` rows) | (a) | One factory and one `DirReader` composition; existing callers without a direction keep today's reader. (c) breaks the switch-introduces-`.gitattributes` case (§D1.7) and leaves smudge filters on the same worktree-only source. | option (a) — ADR-951 |
| DC-3a | safecrlf refusal data (user point 3) | (a) `EOL_ROUND_TRIP_UNSAFE { path, loss: 'crlf-to-lf' \| 'lf-to-crlf' }`; (b) (a) plus counts of the line endings that would change (`crlf` / `loneLf` from the stats); (c) reuse a generic code (`UNSUPPORTED_OPERATION`) with a reason string | (a) | Exactly what git's message carries; both directions reconstruct git's text (§D3.7). (b) adds data git never exposes (YAGNI, cheap to add later). (c) is a rendered reason, against ADR-249. | option (b) — ADR-952 — deviates from recommendation |
| DC-3b | safecrlf `warn` channel (git's default, so it fires on ordinary adds) | (a) structured notices on the command result (`AddResult.eolNotices` and the stash-push result); (b) `ctx.logger?.warn?.(message, { code, path, loss })` like the rename-limit warning; (c) both | (a) | Data on the result is ADR-249's shape and testable without a logger; (b) is the house precedent for informational text but makes the data optional and unordered; (c) duplicates. | option (a) — ADR-953 |
| DC-3c | Objects written before a `safecrlf=true` refusal | (a) refuse with the first offending path in index order and accept that other paths' blobs written concurrently may differ from git's set (all unreachable); (b) run conversion + write in index order whenever `core.safecrlf=true`, reproducing git's exact object set (§D1.6 `objects=1`) | (a) | The refusal data, index and refs match git exactly; only unreachable loose objects can differ, and (b) serialises every add under `safecrlf=true`. | option (b) — ADR-954 — deviates from recommendation |
| DC-4 | `ident` in the first run (user point 4) | (a) in scope: collapse, both expanders, sha1/sha256; (b) collapse only (blob ids right), expansion later; (c) out of scope: refuse with `UNSUPPORTED_OPERATION` when `ident` engages | (a) | Today an `ident` path already gets a wrong blob id (stores `$Id: … $` verbatim, §D1.9); the scanners are small pure functions with property tests, and the stream transform slot exists for LF→CRLF anyway. (b) leaves worktrees unexpanded and `status` disagreeing with git. | option (a) — ADR-955 |
| DC-5 | Renormalize scope (user point 5) | (a) full git: `-X renormalize` / `no-renormalize` on merge, `merge.renormalize` on every merge-ort consumer, normalization before driver dispatch, modify/delete `blob_unchanged`, `add --renormalize`; (b) `merge -X renormalize` + `add --renormalize` only, config later; (c) (a) without the modify/delete rule | (a) | All of it is pinned (§D1.12) and shares one `renormalizeBuffer`; (b) leaves cherry-pick / rebase with `merge.renormalize=true` conflicting where git merges cleanly; (c) leaves a pinned modify/delete divergence. | option (a) — ADR-956 |
| DC-6 | Native line ending (`core.eol=native`, and `core.eol` unset under `text`) where git's compile-time choice has no equivalent | (a) adapter-supplied: Node adapter `process.platform === 'win32'` → crlf else lf; browser and memory → lf; (b) always lf (git on Linux/macOS); (c) an `openRepository` option defaulting to (a) | (a) | Matches the git a user would run beside tsgit on each OS (Git for Windows compiles native CRLF); the browser has no OS line ending, and lf matches the in-repo form. (c) adds a knob nobody asked for (YAGNI); it can be layered on (a) later. | option (a) — ADR-957 |

## Test strategy

**Unit (`test/unit/**`, mirroring `src/`, GWT titles, AAA, `sut`)**
- `domain/eol/text-stats.test.ts` — the §D1.4 fixtures verbatim (`nul-far`, `r127`, `r128`, `r128eof`, `r128x2eof`, `ctl`), DEL, bytes ≥ 0x80, empty.
- `domain/eol/crlf-action.test.ts` — the step table of §D3.1 cell by cell (every row of §D1.1 / §D1.2 reduces to one action), legacy `crlf`, `text=input`, `text=foo`, `-text eol=crlf`, `binary text`, `native` under both `nativeEol` values.
- `domain/eol/crlf-conversion.test.ts` — §D1.1–§D1.3 byte cells, `roundTrip` asserted field by field per fixture — `MIXED` under `auto-crlf` → `{ loss: 'lf-to-crlf', crlf: 1, loneLf: 1 }`, `LF` under `auto-crlf` → `{ loss: 'lf-to-crlf', crlf: 0, loneLf: 2 }`, `CRLF` under `auto-input` → `{ loss: 'crlf-to-lf', crlf: 2, loneLf: 0 }` — binary-before-loss, empty never checked, `renormalize` bypassing `indexHasCrlf`, `indexHasCrlf` not called when `crlf === 0` (spy on the thunk).
- `domain/eol/ident.test.ts` — §D1.9 rows a–h, the divergence blob through both expanders, 40 and 64 hex.
- `application/primitives/internal/convert-blob.test.ts` — step order with a fake clean/smudge choice (§D1.10 bytes), route → safecrlf matrix (§D1.6) with the error data and the notice asserted field by field (`path`, `loss`, `crlf`, `loneLf`; try/catch on `.data`), `false` → no notice, identity returns the same reference (`toBe`).
- `application/primitives/internal/clean-order.test.ts` — `'write'` span: `admitWrite` admits in enlist order, `releaseClean` is a no-op, `halt` rejects every later waiter and later `admitWrite` with the halting error and leaves earlier paths untouched; `'clean'` span: `admitWrite` resolves at once.
- `application/commands/add-clean-order.test.ts` (extend; reuse `seedRepo`, the `withSlowLstat` proxy pattern) — bulk add of `a1` (CRLF), `b2` (LF), `c3` (CRLF) under `autocrlf=true`, `a1`'s read slowed: with `safeCrlf: true` a spy on loose-object writes (a `ctx.fs` proxy over `objects/`) records `a1`'s blob only — no write issued for `c3` — and the refusal is `b2`'s; with `safeCrlf: 'warn'` a deferred first write is still pending when the next write starts (writes stay concurrent) and `eolNotices` is `[{ path: 'b2', loss: 'lf-to-crlf', crlf: 0, loneLf: 2 }]`.
- `application/primitives/resolve-conversion.test.ts`, `read-gitattributes.test.ts` (direction fallbacks on the memory adapter), `write-working-tree-file.test.ts` (transform applied, refusal still leaves the empty file), `apply-changeset.test.ts` (in-core vs streamed per class), `strategy-options.test.ts` (no refusal; `-X` over config), `three-way-tree.test.ts` (`BlobUnchanged`), `config-read` + eager-gate tests for §D1.8.
- Opt-in wiring observable only through a real repo gets a unit-level spy on the captured argument (e.g. `writeStreamedBlob` receives a transform for `eol=crlf`, none for identity), so the mutation gate sees it.

**Property siblings** (`.claude/workflow/property-testing.md`):
- `crlf-conversion.properties.test.ts` — round trip: for non-binary text without lone CR, `crlfToGit(crlfToWorkingTree(x, text-crlf))` = `x` with LF only (200 runs); `crlfToGit` output never contains CRLF for `text-*`; idempotence of both directions; `createLfToCrlfTransform` over any chunking equals `crlfToWorkingTree(..., 'text-crlf')` (chunk-boundary lens, 100 runs).
- `text-stats.properties.test.ts` — counts partition the input length (`printable + nonPrintable + 2·crlf + loneCr + loneLf` = length, minus one when the last byte is `0x1A`).
- `ident.properties.test.ts` — `identToGit(identToWorkingTree(x, oid))` = `identToGit(x)`; streamed expander over any chunking equals itself unchunked (100 runs); the in-core / streamed difference is pinned by examples only (generators would rediscover the documented divergence).

**Interop** — `test/integration/eol-conversion-interop.test.ts` (scrubbed env via `runGit` / `runGitBytes` from `test/integration/interop-helpers.ts`, repo config instead of `-c`, `merge.conflictStyle=merge` pinned):
- `add` matrix (§D1.1, 16 × 7 × 5 blob ids) and checkout matrix (§D1.2, full 16 rows) driven as tables, both tools, compared byte for byte (`ls-files -s`, file bytes).
- §D1.3 edges, §D1.4 heuristic, §D1.5 index rule, §D1.6 safecrlf (git's lines reconstructed from `path` + `loss`; `crlf` / `loneLf` cross-checked against counts computed from the fixture bytes in the test; after the `a1` / `b2` / `c3` refusal — literal `add a1 b2 c3` and bulk `add .` — the index **and** the loose-object set, count and ids, equal git's: `objects=1`, `a1`'s blob, no `c3` blob; `stash push` under `safecrlf=true` compared to git's loose blobs the same way — ADR-954's scope; the full loose-object set of a refused `stash push` (trees, commits) is not pinned in §D1.6, so P6 pins it against git before coding and raises any non-blob difference as a finding), §D1.7 attribute sources per command, §D1.9 ident incl. sha256 and the divergence blob on checkout vs archive, §D1.10 order (with a `tr`-based filter, node only), §D1.11 corrupt-object residue (`eol=crlf` / `ident` leave the empty file, `text=auto` none), §D1.12 renormalize merge / cherry-pick / rebase / modify-delete / conflicted `.gitattributes`, §D1.13 status, stash, archive (tar and zip), blame, racy smudge (> 1 s settle sleeps: git's racy guard is second-resolution).
- Fixtures: the five matrix fixtures plus `nul-lf`, `lone-cr-lf`, `trail-cr`, `no-eol`, `crlf-no-eol`, the §D1.4 heuristic files, the §D1.6 `a1` / `b2` / `c3` partial-failure trio, the §D1.9 ident blobs, and the §D1.12 two-branch histories, built by a shared `buildEolFixtures(dir)` in the suite.
- Existing suites extended, not duplicated: `filter-clean-smudge-interop.test.ts` (filter + text order), `stash-interop.test.ts`, `archive-interop.test.ts`, `status-racy-clean-interop.test.ts`, `merge-driver-interop.test.ts` (renormalize before an external driver).

**Benches** — `bench:ab` on add, status and checkout before/after on a repo with no attributes (R11) and with `* text=auto`.

## Out of scope

- `working-tree-encoding` and `core.checkRoundtripEncoding` — iconv transcoding, separate backlog item; the step slot exists in the composed order.
- Global / system config for `core.autocrlf` / `core.eol` / `core.safecrlf` — backlog 32.7 (ADR-637 repository-local reads).
- `ls-files --eol` / `git check-attr` reporting — no such tsgit surfaces.
- `core.whitespace` / `apply --whitespace` — unrelated whitespace policy.
- `git apply` / `am` conversion — tsgit has no `apply` command.
- `git diff --no-index` and worktree `git diff` (the die→warn downgrade, §D1.6) — tsgit's `diff` is tree-to-tree only.
- `hash-object`, `checkout-index`, `restore`, `commit -a` — no tsgit command; their pins document git's route split only.
- The pack-vs-loose write of unconverted files above `core.bigFileThreshold` on `add` (§D1.11 `none` row) — a pre-existing gap independent of conversion.
- `attr.tree` / `--attr-source` and bare-repository attribute reads — unchanged (ADR-302 notes).
- Delayed (`delay`-capability) process-filter checkout — unchanged filter scope.
