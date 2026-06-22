# Design — filter / clean-smudge / textconv driver port (active-driver faithfulness across diff + add + checkout)

> Brief: give tsgit a driver port so it reproduces git's diff, add, **and**
> checkout when a `filter=<name>` / `diff=<name>` `.gitattributes` mapping selects a
> configured driver — the case git substitutes **driver-produced** content (smudged
> file, cleaned blob, or textconv output) for the raw committed bytes. Motivating
> case git-lfs (`filter=lfs diff=lfs`); the port is general (any driver). Lifts the
> boundary [ADR-398](../adr/398-lfs-pointer-diff-no-filter-baseline.md) declared out
> of scope.
> Status: draft → self-reviewed ×3 → accepted → **scope-fold revision against
> [ADR-406](../adr/406-active-driver-v1-all-three-surfaces.md) /
> [ADR-407](../adr/407-driver-execution-extended-commandrunner.md) /
> [ADR-408](../adr/408-off-node-driver-inert-fallback.md)** (v1 now spans all three
> surfaces; the textconv design and its pinned T-matrix are unchanged, clean/smudge
> is now firm with a freshly re-pinned F-matrix).

This design has no requirements phase upstream; §1.1 supplies a short brief. It
follows the house format of the sibling driver-port doc
[`custom-merge-drivers.md`](custom-merge-drivers.md) (the closest precedent — it
built the exact machinery this feature extends) and the recent
[`whitespace-diff-options.md`](whitespace-diff-options.md) /
[`diff-faithfulness-odds-ends.md`](diff-faithfulness-odds-ends.md) format: problem
→ current state → faithfulness baseline (pinned matrix) → proposed change →
test/interop plan → decision candidates → out of scope.

## 0. Cross-cutting constraints (tsgit prime directives — non-negotiable)

| Source | Binding constraint on this design |
|---|---|
| ADR-226 / CLAUDE.md (git-faithfulness) | Replicate canonical git's observable DATA + on-disk state byte-for-byte: a textconv/clean/smudge driver must reproduce git's diff bytes, committed blob OIDs, and working-tree bytes for the same `.gitattributes` + driver config. Pinned against real `git 2.54.0`, scrubbed `GIT_*`, `GIT_CONFIG_NOSYSTEM=1`, isolated `HOME`, signing off, `mktemp -d` throwaway, `--no-ext-diff` on every scripted `git diff`. Every pinned behaviour becomes a cross-tool interop test in `test/integration/*-interop.test.ts`. |
| ADR-249 (structured-data-only) | The port yields **content bytes** the diff/checkout/add surfaces consume; it carries **no rendering knobs**. Faithfulness binds the data: textconv reshapes the patch hunks + numstat counts (data), never a pre-rendered line; the `--raw`/`--name-status`/`index`-line OIDs stay the **raw** committed OIDs (pinned §3.4) and are emitted from the structured `DiffChange`, unaffected by the driver. |
| CLAUDE.md (architecture) | Hexagonal: `repository → commands → primitives → domain`. The driver **port interface** lives in `src/ports`; process-spawn in `src/adapters/node`; the domain stays platform-free. Reuse the existing `CommandRunner` port (ADR-304) and `domain/attributes` (ADR-302) rather than inventing parallel machinery. |
| Security (mirror, do not widen) | Spawning a git-config-specified driver command is the **same trust model** as the merge-driver (ADR-304) and lifecycle hooks (ADR-300): whoever can write `.git/config` can already run arbitrary commands. This feature mirrors that boundary exactly — no new trust surface (§3.7). |

All empirical pins below were run in `mktemp -d` throwaways with the faithfulness
procedure (`.claude/workflow/faithfulness.md`); none touched the worktree's `.git`.

## 1. Context

### 1.1 Problem (self-supplied brief)

git's diff over a path with an **active** `diff=<name>` textconv driver does **not**
diff the committed bytes — it diffs the driver's **textconv output** of both sides.
Likewise, with an active `filter=<name>` clean/smudge driver, the committed blob is
the **cleaned** bytes and the working-tree file is the **smudged** bytes, and git
applies clean to the working-tree side before comparing it to a cleaned blob. tsgit
has **no filter/diff driver port**, so it can only diff/checkout/add the raw bytes —
faithful only when no driver is active (the [ADR-398](../adr/398-lfs-pointer-diff-no-filter-baseline.md)
baseline). The git-lfs case (`filter=lfs diff=lfs`) is the motivating instance; the
port is general (any configured driver), so it is designed against a trivial test
driver (uppercase via `tr`), not against git-lfs specifically.

The boundary [ADR-398](../adr/398-lfs-pointer-diff-no-filter-baseline.md) declared
the active-driver case out of scope **for lack of this port**; line 60 of
[`custom-merge-drivers.md`](custom-merge-drivers.md) parked "Diff drivers, filters
(`clean`/`smudge`), `text`/`eol` attributes — the parser stores them generically
but no consumer reads them yet." This feature is that deferred consumer.

### 1.2 Current state (verified)

The 24.9 merge-driver feature (ADRs 302–304) already built **every piece of
infrastructure** this port needs; nothing is consulted for `filter`/`diff` yet:

| Asset | File:symbol | Status for this feature |
|---|---|---|
| `.gitattributes` parse + resolve | `domain/attributes/` (`parseGitattributes`, `resolveAttribute`, `AttributeValue`, `macros.ts`) | **Reuse as-is.** The parser stores **all** attribute tokens generically (a `Map<name, AttributeValue>` per rule), so `filter=`/`diff=` resolve with no re-parse (`custom-merge-drivers.md` line 102). The built-in `binary` macro is `-diff -merge -text` (`macros.ts`) — `-diff` interacts (§3.6). |
| Attribute provider | `primitives/internal/read-gitattributes.ts` `buildAttributeProvider(ctx)` → `sourcesForPath(path)` | **Reuse.** Precedence-ordered sources + macro registry, per-`Context` cached. Today only `build-content-merger.ts` calls it; this feature adds diff/checkout/add callers. |
| Driver resolver pattern | `primitives/resolve-merge-driver.ts` `resolvePathMergeSpec` → `MergeDriverChoice` (`'text'`/`'union'`/`'binary'`/`'external'{command,name}`) | **Mirror.** New `resolve-textconv-driver.ts` / `resolve-filter-driver.ts` follow this exact shape: resolve the attribute, consult the config section, return a driver choice. |
| External-process port | `ports/command-runner.ts` `CommandRunner` (`run(CommandRequest)→CommandResult{exitCode}`), optional on `Context` (`ctx.command?`) | **Extend (ADR-407, decided).** `CommandRequest` (`command`/`cwd`/`env`/`signal`) gains optional `stdin?: Uint8Array`; `CommandResult` (today only `exitCode`, because a **merge** driver communicates via its `%A` output file) gains optional captured `stdout?: Uint8Array`. textconv reads stdout; clean/smudge feed stdin and read stdout (§3.4 T-EXEC/F-EXEC, §3.5). |
| Process spawn (node) | `adapters/node/node-command-runner.ts` `NodeCommandRunner` (`sh -c` / `cmd /c`, env merge, abort-kill, `stdio:'ignore'`) | **Extend (ADR-407, decided).** Change `stdio:'ignore'` to pipe stdin + capture stdout; write `request.stdin`, accumulate stdout into `result.stdout`. The merge-driver caller passes no `stdin` and ignores `stdout` — byte-unchanged (§3.5). |
| Driver orchestration | `primitives/run-merge-driver.ts` (temp files under `gitDir` via `ctx.fs`, `substituteDriverPlaceholders`, run, read `%A` back, cleanup in `finally`) | **Mirror.** New `run-filter-driver.ts` runs clean/smudge over the extended port — **no temp file** (stdin→stdout, F-EXEC); `apply-textconv` keeps the temp-file lifecycle for textconv's `argv[1]` file (T-EXEC) + `finally` cleanup. |
| Placeholder substitution | `domain/attributes/driver-command.ts` `substituteDriverPlaceholders(template, {O,A,B,L,P,S,X,Y})` | **Reuse for merge only — not extended.** The pinned contracts (T-EXEC, F-EXEC) show textconv takes the blob as `argv[1]` and clean/smudge take content on stdin; **neither uses a `%`-placeholder**, so no new placeholder set is added (§3.1). |
| Config sections | `config-read.ts` `ParsedConfig.merge?: Map<name,{name,driver,recursive}>` (parsed via `dispatchSection`/`mergeMergeDriver`) | **Extend.** Add `filter?: Map<name,{clean,smudge,process,required}>` and `diff?: Map<name,{textconv,cachetextconv}>` arms. Confirmed: **no** `[filter "…"]`/`[diff "…"]` parsing exists today (clean grep). |
| Diff content chokepoint | `primitives/materialise-patch-files.ts` `materialisePatchFiles` / `materialiseOne` → `PatchFile{oldContent,newContent}` | **Hook point for textconv.** This is the **single** place both diff surfaces (`buildEdits` patch hunks + `computeStatFields` numstat) get their `Uint8Array` content (`diff-trees.ts:99`). A textconv applied per side here reaches both with one transform. |
| Checkout write chokepoint | `primitives/apply-changeset.ts` `writeBlobToWorkingTree` → `streamBlob(ctx,id)` + `writeWorkingTreeEntryStream` (regular) / `readBlob` + `writeWorkingTreeEntry` (symlink) | **Hook point for smudge.** Committed bytes → working tree on checkout. `streamBlob` (commit c661f52d) is the streaming write path. |
| Add hash chokepoint | `commands/add.ts` `stageFromStat` → `readContent(ctx,path)` then `writeObject(ctx,{type:'blob',content})` | **Hook point for clean.** Working-tree bytes → committed blob. The clean filter hooks **between `readContent` and `writeObject`**. |
| **No** content transformation today | grep: zero hits for `smudge`/`clean`/`eol`/`crlf`/`autocrlf`/`textconv` codepaths; `text` attribute parsed but **dormant** | **Bounds scope:** no eol/autocrlf/working-tree-encoding to compose with — the v1 surface is greenfield plumbing, no backward-compat burden. |

`domain/protocol/object-filter.ts` is **unrelated** (partial-clone `--filter=<spec>`
wire filters) — not part of this feature.

### 1.3 Constraining decisions (FIXED — not re-litigated)

| Source | Decision this design must honour |
|---|---|
| ADR-302 | `.gitattributes` source model, precedence, macros, `AttributeValue` four-state — reuse verbatim. |
| ADR-303 | Driver resolution returns a discriminated choice (built-in vs external); a named-but-unconfigured driver falls back to built-in (git's behaviour). |
| ADR-304 | `CommandRunner` port + temp-file orchestration; **no runner wired (memory/browser) ⇒ fall back** (here: fall back to the no-driver / raw-bytes behaviour). |
| ADR-398 | The no-driver baseline (incl. declared-but-inert `diff=lfs`) is the faithful target tsgit produces today and the regression boundary this port must not silently cross (`lfs-pointer-interop.test.ts`). |
| ADR-249 | Driver output is content bytes; OIDs / `--raw` / `--name-status` stay raw (§3.4). |
| **ADR-406** (D-SCOPE, ratified) | **v1 spans all three surfaces** — textconv@diff + clean@add + smudge@checkout — and reproduces git's `required` failure semantics exactly (F3/F4) plus the F1 worktree-diff clean re-application. `cachetextconv` (D-CACHE) and `.process` stay out (§6). The user overrode the designer's textconv-only recommendation. |
| **ADR-407** (D-EXEC + D-PORTBOUND, ratified) | **Separate** textconv (`diff=`) and filter (`clean/smudge`) resolvers/primitives, each mirroring `resolve-merge-driver`, sharing **one** `CommandRunner` port. **Extend** that port (D-EXEC, ratified): `run` accepts optional `stdin?: Uint8Array`; `CommandResult` gains optional captured `stdout?: Uint8Array`; `NodeCommandRunner` captures stdout. The merge-driver caller is byte-unchanged. This **resolves §3.5 to option (a)** — the (b) file-based recommendation is dead. |
| **ADR-408** (D-ADAPTER, ratified) | memory/browser (and node-with-no-runner) **fall back to the no-driver baseline** for all three surfaces: textconv yields raw bytes, filter yields identity clean/smudge. Inert, git-faithful to a no-driver environment. No throw. |

## 2. Requirements

What must be true when this ships (verifiable statements). All are **firm for v1**:
ADR-406 ratified that v1 spans all three surfaces, so the earlier D-SCOPE partition is
gone. **R1–R5** cover textconv@diff; **R6–R10** cover clean/smudge@add/checkout
(now firm, not conditional); **R11–R12** bind everything.

**Firm for v1 — textconv (diff):**

1. A path with an active `diff=<name>` driver whose `[diff "<name>"].textconv`
   command is configured produces a `git diff` patch + numstat **byte-identical to
   real git** — the textconv output of **both** sides is diffed (§3.4 T1/T1n).
2. The structured `TreeDiff.changes` membership, the change `type`, and the
   `--raw`/`index`-line **OIDs** are the **raw committed** values — textconv affects
   only the patch hunks + numstat, never the OIDs (§3.4 T6).
3. A named `diff=<name>` whose `[diff "<name>"]` section has **no** `textconv` key
   (or an empty one) falls back to the raw text diff (the committed bytes) —
   byte-identical to git (§3.4 T2); this is the
   [ADR-398](../adr/398-lfs-pointer-diff-no-filter-baseline.md) declared-but-inert
   boundary, now reached through the live port. A path resolving `diff` to `-diff`
   (incl. via the `binary` macro) takes **no** textconv (§3.6).
4. Textconv runs **only on sides that exist** — an `add` transforms the new side
   only, a `delete` the old side only; gitlink sides are excluded (§3.4 T-ADD, §3.2).
5. `diff=` (textconv) is **independent** of `filter=`: a path with only `diff=` is
   committed/checked-out **raw** yet diffed via textconv (§3.4 T5).

**Firm for v1 — clean/smudge (add / checkout) (R6–R10):**

6. Committing a path with an active `filter=<name>` `clean` stores the **cleaned**
   bytes as the blob; checking it out with `smudge` writes the **smudged** bytes —
   both byte-identical to git (§3.4 F1).
7. `git diff` of working-tree-vs-HEAD applies **clean** to the working-tree side, so a
   smudged-then-unmodified file shows **no diff** (§3.4 F1) — the index/working-tree
   diff surfaces consume the cleaned bytes.
8. `clean`-only (no `smudge`) makes smudge the **identity** — checkout writes the blob
   bytes verbatim (§3.4 F2).
9. `filter.<name>.required = true` with a **failing** clean is **fatal** (refuse the
   stage, nonzero); `required` absent/false with a failing clean stores the **raw**
   bytes and succeeds (git warns, exit 0) (§3.4 F3/F4).
10. `filter=` (clean/smudge) is independent of `diff=`: a path with only `filter=` is
    cleaned/smudged yet diffed **without** textconv (§3.4 T5, symmetric).

**Binds every variant (R11–R12):**

11. With no `CommandRunner` wired (memory/browser) or no `filter=`/`diff=` attribute,
    the surfaces fall back to the **no-driver / raw-bytes** behaviour — faithful to
    "no active driver" ([ADR-398](../adr/398-lfs-pointer-diff-no-filter-baseline.md)).
    For diff this means the patch differs from a driver-active git run but is exactly
    a **no-driver** git run — a valid, asserted environment boundary, not corruption.
    The default path (no attribute / no driver) is **byte- and cost-identical** to
    today: no attribute read is forced onto a diff/checkout/add with no driver (§3.3).
12. Every pinned behaviour (§3.4) is a cross-tool `*-interop` test (twin real-`git` vs
    tsgit), and the [ADR-398](../adr/398-lfs-pointer-diff-no-filter-baseline.md)
    no-driver baseline (`lfs-pointer-interop.test.ts`) stays green (regression boundary).

## 3. Design

### 3.1 Two mechanisms, two resolvers, one extended execution port

git has **two distinct attribute mechanisms** that this feature spans. ADR-407
(D-PORTBOUND) ratified **separate** resolvers/primitives for each, both sharing the
**one** `CommandRunner` port:

- **`diff=<name>` → `[diff "<name>"].textconv`** — a **read-side, diff-only**
  transform. Applied to **both** blob sides at diff time; never alters committed or
  working-tree bytes (§3.4 T5). Caching via `[diff "<name>"].cachetextconv` (§3.4 T7).
- **`filter=<name>` → `[filter "<name>"].clean` / `.smudge` / `.process`** — a
  **write-side** transform pair. `clean` runs on **add/stage** (worktree → blob);
  `smudge` runs on **checkout** (blob → worktree). `required` governs failure
  semantics (§3.4 F3/F4).

They are independent (R5 / R10). git-lfs configures **both** on the same path
(`filter=lfs diff=lfs`), which is why the brief names it — but the mechanisms are
orthogonal and the design treats them as such.

The shape mirrors `resolve-merge-driver.ts` for **each** mechanism (both resolvers are
firm v1 — ADR-406):

```
domain/attributes/                          (reuse + minimal extend)
  driver-command.ts        textconv/clean/smudge take NO placeholder (no %-substitution);
                           the merge placeholder set (%O %A %B …) is reused only by the merge path.

config-read.ts             ParsedConfig gains:
  diff?:   Map<name, { textconv?: string; cachetextconv?: boolean }>
  filter?: Map<name, { clean?: string; smudge?: string; process?: string; required?: boolean }>

ports/
  command-runner.ts        EXTEND (ADR-407, decided): CommandRequest gains `stdin?: Uint8Array`;
                           CommandResult gains captured `stdout?: Uint8Array`. (§3.5)

application/primitives/
  resolve-textconv-driver.ts   (path → TextconvChoice) over `diff` attribute + config
  resolve-filter-driver.ts     (path → FilterChoice)   over `filter` attribute + config
  run-filter-driver.ts         orchestrate clean/smudge over the extended port (stdin → stdout capture)
  apply-textconv.ts            transform a side's content for the diff path (hooks materialise-patch-files)
```

**Dependency rule** honoured exactly as `custom-merge-drivers.md`: `domain/attributes`
stays pure; the `CommandRunner` port sits between application and adapters; the
primitive orchestrates I/O; the domain stays byte-pure. The placeholder set
(`substituteDriverPlaceholders`) is **not** extended — the pinned stdio contract
(§3.4 T-EXEC, F-EXEC) shows textconv takes the blob as `argv[1]` and clean/smudge take
content on **stdin**; neither uses a `%f`-style placeholder, so no domain extension is
needed beyond the config arms.

### 3.2 Textconv (diff) — the chokepoint and the data flow

The single chokepoint where **both** the patch hunks and the numstat counts get
their content is `materialisePatchFiles` (`diff-trees.ts:99` →
`applyLinePassAndStat` feeds `computeStatFields`; the serializer's `buildEdits`
consumes the same `PatchFile.{oldContent,newContent}`). A textconv applied **per
side inside / right after `materialiseOne`** reaches both surfaces with **one**
transform per side:

1. `diff` resolves a `TextconvDriver` per changed path via
   `resolve-textconv-driver.ts` (attribute `diff=<name>` → `[diff "<name>"].textconv`).
2. For a path with an active textconv, `materialiseOne`'s `oldContent`/`newContent`
   are each replaced by `applyTextconv(ctx, side)` — the driver run over that side's
   raw blob bytes, output captured from stdout (§3.5).
3. Everything downstream (`computeStatFields` → `diffLines`, the serializer) sees the
   **transformed** bytes and produces git-faithful hunks + counts.
4. The structured `DiffChange` (its OIDs, mode, type, name-status) is **untouched**
   — it is computed from the tree OIDs before content materialisation, so the
   `--raw`/`index`-line OIDs stay raw (§3.4 T6, Requirement 2).

The textconv runs **only for sides that exist**: an `add` runs it on the new side
only, a `delete` on the old side only (§3.4 T-ADD). The `materialiseOne` arms already
load "only the relevant side" for add/delete — the textconv composes onto each arm.

**Binary / gitlink:** textconv applies to whatever bytes the side carries; a gitlink
side is the synthetic `Subproject commit <oid>` line (`materialise-patch-files.ts`),
and git does not run textconv on gitlinks — the design excludes gitlink sides from
textconv (mirrors §3.6 of `diff-faithfulness-odds-ends`'s gitlink handling). Binary
detection runs on the **transformed** bytes (git diffs textconv output as text, so a
textconv that produces text turns a "binary" blob diffable — git's documented use).

### 3.2a Clean (add) — the chokepoint and the data flow

The write-side `clean` filter runs when working-tree bytes become a committed blob. The
single chokepoint is `commands/add.ts` `stageFromStat`, **between `readContent(ctx,
path, fresh)` (line 343) and `writeObject(ctx, { type: 'blob', content: bytes })` (line
344)** — `bytes` is the only place the worktree content passes through before it is
hashed and stored, and both `add` modes (literal-path `stageOne`/`stageFromStat` and
walk-and-filter `processWalkEntry` → `stageFromStat`) funnel through this one function,
so a single hook reaches every staging path.

1. `add` builds the `AttributeProvider` (`buildAttributeProvider`, per-`Context` cached)
   and resolves `filter=<name>` for the path via `resolve-filter-driver.ts` → a
   `FilterChoice` — **only** under the default-path guard (§3.3): a `CommandRunner` is
   present AND a `filter` attribute resolves. Symlink staging (`readContent`'s symlink
   arm) is **not** filtered — git filters file content, not link targets.
2. For a path with an active `clean`, `run-filter-driver` runs the clean command with
   `request.stdin = bytes` (the worktree bytes) and captures `result.stdout` = the
   **cleaned** bytes (F-EXEC). Those cleaned bytes — not the raw `bytes` — are passed to
   `writeObject`, so the committed blob OID is the OID of the cleaned content (F1).
3. **`required` branch (F3/F4, pinned):** when the clean command exits non-zero,
   - `required === true` ⇒ **fatal**: refuse the stage by throwing a structured
     `TsgitError` whose data reproduces git's refusal (the clean-filter-failed
     condition; the command surface maps it to exit 128). Nothing is staged (F3:
     `a.y` absent from `ls-files`). The throw aborts the whole `add` under the index
     lock — no partial index, consistent with `stageFromStat`'s existing
     `operationAborted` throw on a TOCTOU type-flip.
   - `required` absent/false ⇒ **graceful fallback**: the raw `bytes` are staged
     unchanged and the call **succeeds** (F4: exit 0, `cat-file` shows un-cleaned
     `Hello World`). git emits a warning to stderr (two `error:` lines, F4); the
     library surfaces no display string (ADR-249) — the structured result reports the
     successful raw-byte stage.

The default path (no `filter` attribute / no runner) is byte- and cost-identical to
today: `stageFromStat` reads, hashes, and stores the raw worktree bytes exactly as
before — the filter resolution is skipped entirely (§3.3).

### 3.2b Smudge (checkout) — the chokepoint, identity case, and streamBlob composition

The write-side `smudge` filter runs when a committed blob becomes a working-tree file.
The chokepoint is `primitives/apply-changeset.ts` `writeBlobToWorkingTree` (line 159),
the one function every checkout `add`/`update` entry routes through (via `applyEntry`).
Today its regular-file arm streams: `streamBlob(ctx, id)` → `writeWorkingTreeEntryStream`
(line 174); the symlink arm reads the full blob and writes it; the gitlink arm writes an
empty file.

1. `apply-changeset` builds the `AttributeProvider` and resolves `filter=<name>` per
   path via `resolve-filter-driver.ts`, under the §3.3 guard. Gitlink and symlink modes
   are **not** smudged (git smudges regular file content only — the synthetic gitlink
   placeholder and the symlink target stay verbatim, matching the existing arms).
2. **No smudge driver (clean-only or no filter) ⇒ identity (F2):** the regular-file arm
   is **unchanged** — `streamBlob` → `writeWorkingTreeEntryStream` writes the blob bytes
   verbatim. This preserves the streaming write path (commit c661f52d) for the common
   case and is exactly git's identity-smudge (F2: clean-only checkout writes the blob
   bytes byte-for-byte).
3. **Active smudge driver ⇒ run smudge, write the smudged bytes:** the smudge contract
   is one-shot `stdin → stdout` (F-EXEC), so it **cannot** compose with `streamBlob`'s
   lazy `AsyncIterable` without the driver buffering its whole input regardless. The
   faithful, simplest composition is **capture-then-write**: materialise the blob bytes
   (a buffered read — `readBlob`, the same source the smudge driver would consume), run
   `run-filter-driver` with `request.stdin = blobBytes`, capture `result.stdout` =
   smudged bytes, and write them via the **non-streaming** `writeWorkingTreeEntry`
   (the same primitive the symlink arm already uses). The smudged content does **not**
   stream — streaming is retained only for the identity path (step 2). This is stated
   here as the decided composition: smudge is buffered, identity stays streamed.

So `writeBlobToWorkingTree` grows one branch: regular-file + active smudge → buffered
smudge-then-write; everything else (regular-file no-smudge, symlink, gitlink) is
untouched.

### 3.2c F1 — the worktree-diff clean re-application

git's working-tree-vs-HEAD (and index-vs-worktree) diff applies **clean** to the
worktree side before comparing it to the cleaned blob, so a smudged-then-unmodified
file shows **no diff** (F1, pinned: after `checkout` of a smudged file, `git status` is
clean and `git diff` is empty). The hook is the **worktree-side content materialisation
of the index/worktree diff** — wherever the diff reads the working-tree file's bytes to
hash or compare them, it must route those bytes through `clean` (same
`resolve-filter-driver` + `run-filter-driver`, §3.2a) before the comparison, exactly as
`stageFromStat` does at add time. Concretely: the dirty-check / worktree-blob-hash path
(`apply-changeset.ts` `blobMatches` hashes raw worktree bytes today; the working-tree
diff's content read is the symmetric surface) cleans the worktree bytes first, so the
hash it compares against the cleaned blob OID matches and the path reports unmodified.
Without this, a checked-out (smudged) file would diff against its own cleaned blob and
show a spurious change on every status/diff. This is firm v1 (R7) and is asserted in the
interop round-trip (§5, F1).

### 3.3 The default-path guard (no forced attribute read)

R11 forbids a perf regression on the common diff/add/checkout. The guard is the same
on **all three** surfaces (textconv@diff, clean@add, smudge@checkout): each builds the
`AttributeProvider` and resolves its attribute (`diff=`/`filter=`) **only when**
(a) a `CommandRunner` is present (`ctx.command !== undefined`) AND (b) `.gitattributes`
exists / resolves the relevant attribute for the path. With no driver wired or no
attribute, the OID-only / raw-content fast path is **byte-identical and
cost-identical** to today: `materialiseOne` returns raw blob bytes, `stageFromStat`
stores raw worktree bytes, `writeBlobToWorkingTree` keeps its `streamBlob` streaming
write. The provider is per-`Context` cached (like `readConfig`), so a multi-file diff /
multi-file add / multi-file checkout parses `.gitattributes` once. This mirrors
`build-content-merger`'s lazy provider init (`build-content-merger.ts:48`). This guard
is **also** the ADR-408 inert-fallback mechanism: when `ctx.command` is undefined
(memory/browser, or node with no runner), condition (a) fails and every surface takes
the raw-bytes path — no throw (§3.7).

### 3.4 Pinned faithfulness matrix (real `git 2.54.0`, mktemp throwaway)

Scrubbed `GIT_*`, `GIT_CONFIG_NOSYSTEM=1`, isolated `HOME`, signing off,
`--no-ext-diff`. Drivers are trivial portable scripts (uppercase/lowercase via
`LC_ALL=C tr`), **not** git-lfs — git-lfs is not required to pin the model (per the
brief). **The pin decides the model.**

#### Textconv (`diff=<name>` → `[diff "<name>"].textconv`)

| # | Setup | `git` result | Load-bearing fact |
|---|---|---|---|
| **T1** | `diff.upper.textconv=<uppercase>`, `.gitattributes` `a.x diff=upper`; commit `hello world\nsecond line`, then `hello there\nsecond line`. `git diff --no-ext-diff HEAD~1 HEAD` | patch hunk shows `-HELLO WORLD` / `+HELLO THERE` and context ` SECOND LINE`; `index f0e9ea9..703f9bc 100644` (raw OIDs) | textconv applied to **BOTH** sides before the line diff; the `index` line carries the **raw** committed OIDs, not transformed. |
| T1n | same | `--numstat` → `1\t1\ta.x` | numstat counts computed over the **transformed** sides (same as the patch). |
| **T2** | `.gitattributes` `a.x diff=upper` but **NO** `[diff "upper"]` section configured | patch shows raw `-hello world` / `+hello there` (lowercase committed bytes) | a named-but-unconfigured textconv **falls back to the raw text diff** — this is the [ADR-398](../adr/398-lfs-pointer-diff-no-filter-baseline.md) declared-but-inert boundary, now reached via the live resolver. |
| T2e | `-c diff.upper.textconv=''` (named, **empty** value) | `fatal: unable to read files to diff` (git tries to run the empty command and fails) | an **empty** textconv value is an error in git, distinct from an absent section (T2). The resolver must treat empty-string `textconv` as "configured but invalid" only if git does; safest is to treat absent-or-empty as fallback (pin both, prefer fallback — see §3.5 note). |
| **T-ADD** | `g.x` newly added under `diff=upper`; diff that introduces it | driver invoked **once** (new side only); patch is an all-`+` block of the uppercased new content | textconv runs only on sides that exist; add → one call, delete → one call. |
| **T-EXEC** | log the driver argv | `CALLED argc=1 arg1=[<tmpdir>/git-blob-XXXX/a.x]` | textconv contract: git writes the blob to a **temp file**, passes its **path as `argv[1]`**, reads the driver's **stdout**. (Differs from merge-driver's in-place `%A` edit.) |
| **T7** | `diff.upper.cachetextconv=true`; run the same diff twice | first run: 2 driver calls; **second run: 0 calls** | git caches textconv output keyed by blob OID (a notes-ref cache under `.git`). Caching is an **optimization**, observationally transparent (same bytes); v1 may **ignore** `cachetextconv` and always run the driver (D-CACHE). |
| **T6** | `git diff --no-ext-diff --raw HEAD~2 HEAD~1` under active textconv | `:100644 100644 72943a1 f761ec1 M a.x` (raw OIDs) | textconv does **not** enter `--raw`/`--name-status`/OIDs — structured data is raw; only the patch/numstat are transformed (ADR-249-clean). |

#### Clean / smudge (`filter=<name>` → `[filter "<name>"].clean`/`.smudge`)

| # | Setup | `git` result | Load-bearing fact |
|---|---|---|---|
| **F1** | `filter.myf.clean=<uppercase>`, `filter.myf.smudge=<lowercase>`, `.gitattributes` `*.y filter=myf`; author `Hello World`, `git add` + commit | committed blob (`cat-file`) = `HELLO WORLD` (**cleaned**); `rm a.y; git checkout -- a.y` → worktree = `hello world` (**smudged**); `git diff` after = **no diff** | clean runs at add (worktree→blob); smudge at checkout (blob→worktree); `git diff` of worktree-vs-HEAD **re-applies clean** to the worktree side before comparing to the cleaned blob ⇒ no diff. |
| **F2** | `filter.c.clean` set, **no** `smudge`; commit then `rm` + checkout | committed blob = `HELLO`; worktree after checkout = `HELLO` (verbatim blob bytes) | absent `smudge` ⇒ smudge is the **identity**; checkout writes the blob bytes unchanged. |
| **F3** | `filter.f.clean='false'` (always fails) + `filter.f.required=true`; `git add a.y` | stderr (3 lines): `error: external filter 'false' failed 1` / `error: external filter 'false' failed` / `fatal: a.y: clean filter 'f' failed`; **exit 128**; `ls-files` shows `a.y` **not** staged | `required=true` + clean failure is **fatal** — refuse the stage. Re-pinned 2026-06-22: the fatal line is the third line, distinct from the two `error:` warnings. |
| **F4** | same but `required` absent (default false) | stderr (2 lines): `error: external filter 'false' failed 1` / `error: external filter 'false' failed`; **no `fatal:` line**; **exit 0**; `cat-file :a.y` shows the **raw** bytes `Hello World` (un-cleaned) staged | `required` absent/false + clean failure ⇒ git **warns, stores raw bytes, succeeds** (graceful fallback). Re-pinned 2026-06-22: only the two `error:` warnings, no fatal; raw bytes confirmed via `cat-file`. |
| **T5/F5** | `.gitattributes` `*.z diff=d` **only** (no `filter=`); `diff.d.textconv=<uppercase>`; commit `hello`, then `world` | committed blobs are **raw** (`cat-file` → `world`); `git diff` shows textconv-uppercased both sides | `diff=` and `filter=` are **independent**: `diff=` alone never cleans the committed bytes; it only transforms at diff time. (Symmetric: `filter=` alone cleans/smudges but diffs raw.) |
| **F6** | `filter.smudge-req.clean=<uppercase>`, `filter.smudge-req.smudge=<fail>`, `filter.smudge-req.required=true`; commit `hello filter` (blob = `HELLO FILTER`, UPPERCASE via clean); `rm f6.sr; git checkout -- f6.sr` | stderr (3 lines): `error: external filter '<fail>' failed 1` / `error: external filter '<fail>' failed` / `fatal: f6.sr: smudge filter smudge-req failed`; **exit 128**; `f6.sr` **absent** from the working tree | `required=true` + smudge failure is **fatal** at checkout: git refuses to write the file, exits 128. Symmetric to F3 (clean). Firm-pinned 2026-06-22 in mktemp throwaway (isolated HOME, GIT_CONFIG_NOSYSTEM=1, scrubbed GIT_*, signing off). |
| **F7** | same filter config but **`required` absent** (`filter.smudge-opt`); commit `hello smudge opt` (blob = `HELLO SMUDGE OPT`); `rm f7.so; git checkout -- f7.so` | stderr (2 lines): `error: external filter '<fail>' failed 1` / `error: external filter '<fail>' failed`; **no `fatal:` line**; **exit 0**; `f7.so` present with **raw blob bytes** `HELLO SMUDGE OPT` (no smudge transform applied) | `required` absent + smudge failure ⇒ git warns, writes the raw blob bytes (the committed UPPERCASE content), succeeds. Symmetric to F4 (clean). Firm-pinned 2026-06-22. |
| **F-EXEC** | log clean's and smudge's argv; `git add` then `rm`+`checkout` | both drivers see `argc=0 args=[]`; content arrives on **stdin**, result read from **stdout** | clean/smudge contract (re-pinned 2026-06-22): **no temp-file arg** — pure `stdin → stdout`. Contrast textconv (`argv[1]` file + stdout, T-EXEC) and the merge driver (in-place `%A` file). This is the contract `run-filter-driver` reproduces via the extended `CommandRunner` (`stdin` in, `stdout` captured). |

The clean/smudge contract (driver invocation, pinned F-EXEC): git pipes content on
**stdin** and reads the result from **stdout** for both `clean` and `smudge` (the
driver is invoked with **no** arguments — no temp-file path, unlike textconv's
`argv[1]`, and unlike the merge driver's in-place `%A`). This is exactly the shape the
extended `CommandRunner` carries (§3.5): `run({ …, stdin })` feeds the child's stdin,
`CommandResult.stdout` captures the child's stdout. The `.process` long-running protocol
is a separate, more complex contract (out of v1 scope — §6).

### 3.5 Driver execution — the extended `CommandRunner` port (ADR-407, decided)

The existing `CommandRunner.run` surfaces only `exitCode` (a merge driver writes its
output **file** `%A`). textconv and clean/smudge communicate via **stdout** (textconv:
`argv[1]` file in, stdout out) or **stdin→stdout** (clean/smudge: stdin in, stdout
out — pinned F-EXEC). ADR-407 ratified **extending the one `CommandRunner` port**
rather than the file-based-orchestration alternative (the design's earlier (b)
recommendation is **withdrawn**):

The port gains two optional fields, both purely additive:

```ts
interface CommandRequest {
  readonly command: string;
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly signal?: AbortSignal;
  readonly stdin?: Uint8Array;        // NEW — bytes fed to the child's stdin (clean/smudge input)
}

interface CommandResult {
  readonly exitCode: number;
  readonly stdout?: Uint8Array;       // NEW — bytes captured from the child's stdout
}
```

`NodeCommandRunner` changes its spawn from `stdio: 'ignore'` to a stdio that **pipes
stdin and captures stdout** (stderr may stay inherited/ignored — only stdout carries
the driver result; F3/F4's stderr warnings are git's own, not the driver port's
concern). It writes `request.stdin` to the child's stdin when present, accumulates the
child's stdout into a `Uint8Array`, and returns it as `result.stdout`. The abort/kill
and env-merge behaviour is unchanged.

**The merge-driver caller is byte-unchanged.** `run-merge-driver.ts` passes no `stdin`
and ignores `result.stdout` — it keeps reading its `%A` output file as today
(`runner.run({ command, cwd, env, signal })` → reads `aPath` back). One port now
carries **two output conventions**, selected by the caller: merge reads its file;
textconv/filter read `result.stdout`. This dual convention is documented here and in
ADR-407 so reviewers do not mistake it for a leak.

- **textconv** (`apply-textconv`): write the side's blob bytes to a temp file under
  `gitDir` (mirroring `run-merge-driver`'s temp-file lifecycle + `finally` cleanup),
  build the command with that path as `argv[1]`, run with **no** `stdin`, read the
  transformed side from `result.stdout` (T-EXEC).
- **clean/smudge** (`run-filter-driver`): **no** temp file — pass the worktree/blob
  bytes as `request.stdin`, read the cleaned/smudged bytes from `result.stdout`
  (F-EXEC). This is strictly simpler than textconv (no temp file at all).

Note on T2e (textconv resolver semantics): the resolver treats an **absent
`[diff "<name>"]` section OR an absent `textconv` key** as "fall back to raw diff"
(T2). An **empty-string** `textconv` value is a misconfiguration git fatally errors on
(T2e); v1 treats empty-string as fallback (T2), not reproducing git's fatal — a minor
edge folded into the resolver semantics, not a separate decision (§6).

### 3.6 Attribute resolution, precedence, and `-diff`/`binary` interplay

Resolution reuses `buildAttributeProvider(ctx)` / `sourcesForPath(path)` and
`resolveAttribute(sources, path, 'diff'|'filter', macros)` **verbatim** for **both**
mechanisms (ADR-302 precedence: `info/attributes` → per-dir `.gitattributes`
deepest-first → root → global `core.attributesFile`; last-match-wins within a file) —
the same provider `build-content-merger.ts` already consumes for `merge`. All three
surfaces (diff, add, checkout) build the provider; the §3.3 default-path guard means a
diff/add/checkout with no runner and no relevant attribute forces **no** attribute read.
The `diff` mapping:

| resolved `diff` attribute value | TextconvChoice |
|---|---|
| `'unspecified'` (no rule) | none — raw diff (today's behaviour) |
| `true` (`diff`) / `false` (`-diff`) | built-in: `-diff` marks the path **binary** for diff (no textconv); `diff` is the default text diff. No textconv either way. |
| `{ set: 'name' }` with `[diff "name"].textconv` configured | **external textconv** |
| `{ set: 'name' }` no `textconv` (or empty) | none — raw diff (T2 fallback) |

The symmetric `filter` mapping (clean/smudge), resolved the same way:

| resolved `filter` attribute value | FilterChoice |
|---|---|
| `'unspecified'` (no rule) / `false` (`-filter`) | identity — raw clean + identity smudge (today's behaviour) |
| `{ set: 'name' }` with `[filter "name"].clean`/`.smudge` configured | **external** clean (add) / smudge (checkout); a missing `smudge` ⇒ identity smudge (F2); a missing `clean` ⇒ identity clean |
| `{ set: 'name' }` no `[filter "name"]` section | identity — no clean/smudge (the ADR-408 inert / unconfigured case) |

The built-in `binary` macro expands to `-diff -merge -text` (`macros.ts`): a path
marked `binary` resolves `diff` to `false` (`-diff`), which suppresses the text diff
entirely (git shows `Binary files differ`) — the textconv path is **not** taken. This
interplay is pinned (the `binary` macro already exists and is tested for merge; the
diff side needs a pin that `-diff` ⇒ no textconv). The `binary` macro does **not**
touch `filter` (it sets `-diff -merge -text`, not `-filter`), so a `binary` path with a
`filter=` mapping is still cleaned/smudged — consistent with git.

### 3.7 Security — mirror the merge-driver / hook trust boundary, do not widen

Running a `[diff].textconv` / `[filter].clean` command is exactly the merge-driver
(ADR-304) and hook (ADR-300) trust model: the command comes from `.git/config`
(repository config, not `.gitattributes`, which only names the driver). Whoever can
write `.git/config` can already run arbitrary commands via hooks or a merge driver.
This feature:

- spawns through the **same** `CommandRunner` port and `NodeCommandRunner` (`sh -c`,
  env merge, abort-kill) — no new spawn surface. The ADR-407 port extension (`stdin`
  in, `stdout` capture) is an additive I/O channel on the **same** spawn, not a new
  capability — clean/smudge feed bytes to and read bytes from a process the trust model
  already permits;
- runs **only** when both the attribute names a driver **and** the config defines its
  command — a `.gitattributes` `diff=lfs`/`filter=lfs` from an untrusted repo with
  **no** `[diff "lfs"]`/`[filter "lfs"]` in the local config runs **nothing** (T2 /
  the filter unconfigured case) — the attribute alone is inert, exactly as git;
- adds **no** auto-discovery of system/global drivers beyond what `readConfig`
  already exposes.

No trust boundary is widened. The doc states this so the security review does not
mistake driver execution for a new attack surface — it is the established one.

### 3.7a Off-node / no-runner inert fallback for all three surfaces (ADR-408)

ADR-408 ratified the inert fallback: when no `CommandRunner` is wired (memory/browser,
or node with none configured), **all three** surfaces fall back to the no-driver
baseline — **textconv yields raw bytes** (the diff diffs the committed bytes as text),
**clean yields identity** (add stores the raw worktree bytes), **smudge yields
identity** (checkout writes the blob bytes verbatim via the unchanged `streamBlob`
path). This is mechanically the §3.3 guard: `ctx.command === undefined` fails condition
(a), so the attribute is never resolved and the raw-bytes path is taken on every
surface. No throw — a repo declaring `diff=lfs`/`filter=lfs` is fully usable in the
browser, exactly ADR-398's declared-but-inert boundary and consistent with the
merge-driver (ADR-304) and hook (ADR-300) fallback precedents. Cross-adapter parity
asserts **inert ≡ node-with-no-driver** (§5); it does **not** prove faithfulness — only
the node interop harness (real driver) does.

### 3.8 v1 scope — all three surfaces (ADR-406, ratified)

This feature spans three surfaces × two mechanisms, and **v1 ships all three**:
textconv@diff (`materialise-patch-files` chokepoint, §3.2), clean@add (`stageFromStat`
chokepoint, §3.2a), and smudge@checkout (`writeBlobToWorkingTree` chokepoint, §3.2b),
including the F1 worktree-diff clean re-application (§3.2c) and git's exact `required`
failure semantics (F3/F4). The designer's original recommendation was a minimal
textconv-only v1 with clean/smudge deferred; the user overrode it (ADR-406) for a
complete active-driver story in one feature. `cachetextconv` (D-CACHE) and the
`.process` long-running protocol remain out (§6).

## 4. Decision candidates — RESOLVED (ratified in the ADR phase)

ADRs 226/249/302/303/304/398 fix faithfulness, structured-data, the attribute model,
driver resolution, the `CommandRunner` port, and the no-driver baseline. The
load-bearing choices **this** feature introduced are below. **All six are now resolved**
by [ADR-406](../adr/406-active-driver-v1-all-three-surfaces.md) /
[ADR-407](../adr/407-driver-execution-extended-commandrunner.md) /
[ADR-408](../adr/408-off-node-driver-inert-fallback.md); the table is retained
(annotated) so the plan phase reads the chosen option, not re-litigated. The
"Recommendation" column records the designer's original pick — **two were overridden**
(D-SCOPE, D-EXEC), flagged below.

| # | Choice | Alternatives (≤3) | Designer's recommendation | Resolution (ADR) |
|---|---|---|---|---|
| **D-SCOPE** | Which surfaces ship in v1 | (a) **textconv-diff only** (checkout-smudge + add-clean deferred); (b) textconv-diff **+** clean/smudge (all three surfaces); (c) clean/smudge only (no textconv) | (a) | **RESOLVED → (b)** ([ADR-406](../adr/406-active-driver-v1-all-three-surfaces.md)). User **overrode** the textconv-only recommendation: v1 spans all three surfaces, reproducing F1 (worktree-diff clean re-application) and F3/F4 (`required` semantics). |
| **D-PORTBOUND** | One combined driver port vs separate | (a) **separate** resolvers/primitives for textconv (`diff=`) and filter (`clean/smudge`), sharing the one `CommandRunner` port; (b) one combined "content driver" port abstracting both; (c) fold both into the existing merge-driver primitive | (a) | **RESOLVED → (a)** ([ADR-407](../adr/407-driver-execution-extended-commandrunner.md), adopted-as-recommended). Separate `resolve-textconv-driver` + `resolve-filter-driver`, both sharing the one `CommandRunner` port. |
| **D-EXEC** | How the driver's stdout/stdin is bridged | (a) **extend `CommandRunner`** with `stdin?`/`stdout` capture (`CommandResult` gains `stdout?`); (b) **file-based orchestration** in a new `run-filter-driver` primitive (temp files + shell redirect, port unchanged); (c) a **new** dedicated `FilterRunner` port | (b) | **RESOLVED → (a)** ([ADR-407](../adr/407-driver-execution-extended-commandrunner.md), user-ratified). User **overrode** the file-based recommendation: extend the port (`stdin?` on the request, `stdout?` on `CommandResult`); `NodeCommandRunner` captures stdout; merge-driver caller byte-unchanged. The (b) recommendation is dead (§3.5). |
| **D-ADAPTER** | What memory/browser adapters do for drivers | (a) **inert / fall back** to no-driver raw bytes (mirror merge-driver ADR-304: no `CommandRunner` ⇒ built-in); (b) an **in-process JS function registry** (`Map<name, (bytes)=>bytes>`) the memory/browser adapter can populate; (c) **throw** when a driver is named but unrunnable | (a) | **RESOLVED → (a)** ([ADR-408](../adr/408-off-node-driver-inert-fallback.md)). Inert fallback for all three surfaces (textconv raw, clean/smudge identity); no throw. The JS-function registry (b) is a documented follow-up. |
| **D-CACHE** | Honour `[diff].cachetextconv` | (a) **ignore** it in v1 (always run the driver; output is identical, T7 is an optimization); (b) **implement** the OID-keyed cache (git's notes-ref cache under `.git`) | (a) | **RESOLVED → (a)** (out of scope per [ADR-406](../adr/406-active-driver-v1-all-three-surfaces.md) Consequences; §6). T7 pins caching as observationally transparent (same bytes, fewer calls); v1 always runs the driver. The notes-ref cache is a separable perf concern with zero data difference. |
| **D-REQUIRED** | `filter.<name>.required` failure semantics | (a) **reproduce git exactly**: `required=true`+fail ⇒ fatal refuse (F3); absent/false+fail ⇒ warn + store raw + succeed (F4); (b) always fatal on any clean failure; (c) always store-raw on failure | **(a)** | **RESOLVED → (a)** ([ADR-406](../adr/406-active-driver-v1-all-three-surfaces.md): "reproduce git's `required` failure semantics exactly"). F3/F4 are pinned, divergent behaviours git users depend on (lfs sets `required=true`); (b)/(c) diverge. Now firm v1 — D-SCOPE includes filter (§3.2a). |

## 5. Test strategy

Mirrors the merge-driver test plan (`custom-merge-drivers.md` §Test plan) and the
interop discipline of `lfs-pointer-interop` / `merge-driver-interop`.

All clean/smudge tests below are **firm v1** (ADR-406) — none is gated on D-SCOPE.

**Unit (primitives):**
- `resolve-textconv-driver.test.ts` — every row of the §3.6 `diff` mapping: `diff=name`
  + configured `textconv` ⇒ external; named-but-unconfigured ⇒ none (T2); `-diff` /
  `binary` macro ⇒ none (no textconv); empty-string `textconv` ⇒ none. Precedence +
  last-match reused from `resolve-attribute` (already covered). Isolated guard tests
  per branch (mutation-resistant: assert the exact choice, not a truthy).
- `resolve-filter-driver.test.ts` — every row of the §3.6 `filter` mapping: `filter=name`
  + configured `clean`/`smudge` ⇒ external; missing `smudge` ⇒ identity smudge (F2);
  missing `clean` ⇒ identity clean; named-but-unconfigured section ⇒ identity;
  `-filter` / unspecified ⇒ identity. Isolated guard tests per branch.
- `apply-textconv.test.ts` (or the textconv arm of `materialise-patch-files.test.ts`)
  — both-sides transform; add (new side only) / delete (old side only); gitlink side
  excluded; default path (no driver) returns raw content byte-identical.
- `run-filter-driver.test.ts` — clean/smudge over the **extended** `CommandRunner`
  (D-EXEC=(a)) via a fake runner: feeds `stdin`, reads `result.stdout`; exit-0 clean
  and smudge paths; the `required`-true non-zero ⇒ structured throw branch (F3); the
  `required`-absent non-zero ⇒ raw-bytes return branch (F4); abort signal threads
  through. Error assertions specific (code + the `required`/exit data, not
  `toThrow(Class)`).

**Unit (command + write-side chokepoints):**
- `add.test.ts` / `stageFromStat` — the clean hook (§3.2a): active clean stores the
  cleaned blob OID; `required`-true clean failure throws the structured exit-128
  refusal with nothing staged (F3, isolated guard); `required`-absent clean failure
  stages the raw bytes and succeeds (F4); symlink staging is **not** filtered;
  `ctx.command` absent ⇒ raw stage (fallback, R11).
- `apply-changeset.test.ts` / `writeBlobToWorkingTree` — the smudge hook (§3.2b):
  active smudge writes the smudged bytes via the buffered capture-then-write branch;
  no-smudge keeps the `streamBlob` streaming write verbatim (F2 identity); gitlink and
  symlink arms unchanged; `ctx.command` absent ⇒ identity (R11). The F1 worktree-side
  clean re-application of the dirty-check / worktree-hash path (§3.2c) is unit-covered
  here (cleaned worktree bytes hash equal to the cleaned blob OID ⇒ unmodified).
- `diff.test.ts` — a `diff=` textconv case threads from `DiffOptions` through the
  primitive; default options unchanged (regression). `ctx.command` absent ⇒ raw diff
  (fallback, R11).

**Unit (adapter):**
- `node-command-runner.test.ts` — the new `stdin`-feed + `stdout`-capture branches
  (injected spawn): a request with `stdin` writes it to the child; `result.stdout`
  carries the captured bytes; a request **without** `stdin` (the merge-driver shape)
  still resolves with `exitCode` and `stdout === undefined` ignorable — proving the
  merge caller is byte-unchanged.

**Interop (real git — the only faithfulness proof):**
- **`test/integration/diff-textconv-interop.test.ts`** (new, twin real-`git` vs
  tsgit; `describe.skipIf(!GIT_AVAILABLE)`; one shared `beforeAll` repo; 60s timeout
  per the interop load→validate flake note; scrubbed `GIT_*`, isolated `HOME`,
  `GIT_CONFIG_NOSYSTEM=1`, signing off, `--no-ext-diff`): pin T1 (both-sides
  transform + raw `index` OIDs), T1n (numstat), T2 (named-but-unconfigured fallback),
  T-ADD (add side only), T5 (`diff=`-only is committed raw + diffed via textconv), T6
  (`--raw` OIDs raw), and the `binary`-macro ⇒ no-textconv interplay (§3.6).
  Reconstruct git's patch via the shared `diff-reconstruct.ts` `reconstructPatch`
  helper + a frozen golden, mirroring `diff-recursive-interop`.
- **`test/integration/filter-clean-smudge-interop.test.ts`** (new, firm v1; twin
  real-`git` vs tsgit; same isolation discipline): pin **F1** (clean@add stores the
  cleaned blob — assert committed-blob **OID** parity vs git + `cat-file` UPPERCASE;
  smudge@checkout writes lowercase **worktree bytes**; `git diff`/status shows **no
  diff** after checkout — the worktree-side clean re-application), **F2** (clean-only ⇒
  identity smudge, verbatim blob bytes), **F3** (`required=true` + failing clean ⇒
  fatal, exit 128, nothing staged — reconstruct git's refusal from the structured error
  per ADR-249, do not byte-match stderr), **F4** (`required` absent ⇒ exit 0, raw bytes
  staged — assert the raw blob OID), **F6** (`required=true` + failing smudge at checkout
  ⇒ fatal, exit 128, file NOT written — structured `SMUDGE_FILTER_FAILED` error with
  `.data.filter`/`.data.exitCode`, file absent asserted; symmetric to F3 for checkout),
  **F7** (`required` absent + failing smudge ⇒ exit 0, raw blob bytes written — worktree
  content equals the committed UPPERCASE blob, parity between git and tsgit; symmetric
  to F4 for checkout), and **F-EXEC** (the stdin→stdout contract via a logging driver).
  If this file's `beforeAll` grows heavy (it spawns git for add + checkout + diff per
  case), use `SETUP_TIMEOUT=120_000` — the gitlink interop file precedent from #194 (the
  interop load→validate flake note).
- **`lfs-pointer-interop.test.ts` stays green** — the
  [ADR-398](../adr/398-lfs-pointer-diff-no-filter-baseline.md) no-driver baseline is
  the regression boundary; assert the declared-but-inert `diff=lfs`-with-no-driver
  case still shows pointer text (now that a live resolver exists, this proves the
  resolver falls back rather than crashes).
- **Cross-adapter parity** (memory ≡ node-with-no-driver, ADR-408) — assert the inert
  fallback for all three surfaces: a memory repo declaring `filter=lfs diff=lfs` with
  no runner diffs raw, stages raw, checks out verbatim — identical to node with
  `ctx.command` undefined. Parity is cross-adapter only; it does **not** prove
  faithfulness (the interop files above do).

GWT/AAA, `sut`, 100% coverage, 0 killable mutants; error assertions specific (code +
data, per the mutation-resistant patterns).

## 6. Out of scope

(clean/smudge@add/checkout is **in** v1 — ADR-406; it is no longer listed here.)

- **`[filter].process` long-running protocol** — git's packet-line `process` filter
  (a persistent driver subprocess speaking the filter protocol) is a separate, more
  complex contract than the `clean`/`smudge` one-shot commands v1 ships; explicitly
  out of v1 (ADR-406 Consequences). Falls back to `clean`/`smudge` (git's own fallback
  when `process` is absent), which is exactly what v1 implements.
- **`[diff].cachetextconv`** — pinned observationally transparent (T7); v1 ignores it
  (always runs the driver). The OID-keyed notes-ref cache is a separable perf concern
  with zero data difference (D-CACHE).
- **`text`/`eol`/`working-tree-encoding`/`autocrlf` attributes** — git's built-in
  line-ending normalization is adjacent to clean/smudge but a distinct feature; tsgit
  has **zero** content transformation today (§1.2), so there is no eol path to
  compose with. Parked exactly as `custom-merge-drivers.md` parked it.
- **An in-process JS driver registry for memory/browser** (D-ADAPTER option b) — an
  attractive future ergonomic (browser textconv via a JS function), but it invents a
  second driver-execution model and a non-git data shape; deferred. Memory/browser
  fall back to no-driver raw bytes (faithful to [ADR-398](../adr/398-lfs-pointer-diff-no-filter-baseline.md)).
- **git-lfs as an installed driver** — the port is general and pinned against a
  trivial test driver; it does **not** bundle, detect, or special-case git-lfs. A
  real `filter=lfs diff=lfs` with the git-lfs binary installed works through the
  generic port (the user configures `[filter "lfs"]`/`[diff "lfs"]` as git-lfs does),
  but pinning against the actual git-lfs binary in CI is not required and not done.
- **Reproducing git's `fatal: unable to read files to diff`** for an empty-string
  `textconv` value (T2e) — v1 treats absent-or-empty as fallback (T2); reproducing
  git's fatal-on-empty is a low-value edge folded into the resolver semantics, not a
  separate surface.
