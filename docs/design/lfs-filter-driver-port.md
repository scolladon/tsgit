# Design — filter / clean-smudge / textconv driver port (active-driver diff faithfulness)

> Brief: give tsgit a driver port so it reproduces git's diff (and, optionally,
> checkout / add) when a `filter=<name>` / `diff=<name>` `.gitattributes` mapping
> selects a configured driver — the case git substitutes **driver-produced**
> content (smudged file, cleaned blob, or textconv output) for the raw committed
> bytes. Motivating case git-lfs (`filter=lfs diff=lfs`); the port is general (any
> driver). Lifts the boundary [ADR-398](../adr/398-lfs-pointer-diff-no-filter-baseline.md)
> declared out of scope.
> Status: draft → self-reviewed ×3 → accepted

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
| External-process port | `ports/command-runner.ts` `CommandRunner` (`run(CommandRequest)→CommandResult{exitCode}`), optional on `Context` (`ctx.command?`) | **Reuse.** `CommandRequest` is generic (`command`/`cwd`/`env`/`signal`). One subtlety: it surfaces only `exitCode` because a **merge** driver communicates via its output file. textconv communicates via **stdout** (§3.4) — see D-EXEC for whether to extend the port or orchestrate via temp files (§3.5). |
| Process spawn (node) | `adapters/node/node-command-runner.ts` `NodeCommandRunner` (`sh -c` / `cmd /c`, env merge, abort-kill, `stdio:'ignore'`) | **Reuse / extend.** `stdio:'ignore'` discards stdout; textconv needs stdout captured (§3.5, D-EXEC). |
| Driver orchestration | `primitives/run-merge-driver.ts` (temp files under `gitDir` via `ctx.fs`, `substituteDriverPlaceholders`, run, read `%A` back, cleanup in `finally`) | **Mirror.** New `run-filter-driver.ts` orchestrates a clean/smudge/textconv invocation the same way. |
| Placeholder substitution | `domain/attributes/driver-command.ts` `substituteDriverPlaceholders(template, {O,A,B,L,P,S,X,Y})` | **Reuse / extend.** Merge uses `%O %A %B …`. Filter/textconv use a different placeholder set (`%f` = pathname for clean/smudge `process`); textconv via `[diff].textconv` takes the file as `argv[1]`, no placeholder (§3.4). |
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

## 2. Requirements

What must be true when this ships (verifiable statements). The list is partitioned
because the v1 surface scope is itself a decision (D-SCOPE): **R1–R5** are firm for
the recommended textconv-only v1; **R6–R10** are conditional on D-SCOPE including
clean/smudge (they become firm in that variant's ADR, else they ride the clean/smudge
follow-up); **R11–R12** bind every variant.

**Firm for v1 (textconv-diff):**

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

**Conditional on D-SCOPE including clean/smudge (R6–R10):**

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

### 3.1 Two mechanisms, two resolvers, one execution primitive

git has **two distinct attribute mechanisms** that this feature spans (D-PORTBOUND
is the user's call on how many ports model them):

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

The proposed shape mirrors `resolve-merge-driver.ts` for **each** mechanism:

```
domain/attributes/                          (reuse + minimal extend)
  driver-command.ts        extend DriverPlaceholders / add a filter placeholder set (%f)

config-read.ts             ParsedConfig gains:
  diff?:   Map<name, { textconv?: string; cachetextconv?: boolean }>
  filter?: Map<name, { clean?: string; smudge?: string; process?: string; required?: boolean }>

ports/
  command-runner.ts        reuse; EXTEND to capture stdout (D-EXEC) OR keep file-based (§3.5)

application/primitives/
  resolve-textconv-driver.ts   (path → TextconvChoice) over `diff` attribute + config
  resolve-filter-driver.ts     (path → FilterChoice)   over `filter` attribute + config   [if D-SCOPE includes filter]
  run-filter-driver.ts         orchestrate temp file(s) + CommandRunner + stdout capture
  apply-textconv.ts            transform a side's content for the diff path (hooks materialise-patch-files)
```

**Dependency rule** honoured exactly as `custom-merge-drivers.md`: `domain/attributes`
stays pure; the `CommandRunner` port sits between application and adapters; the
primitive orchestrates I/O; the domain stays byte-pure.

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

### 3.3 The default-path guard (no forced attribute read)

R11 forbids a perf regression on the common diff. The attribute read is
gated: `diff` builds the `AttributeProvider` and resolves `diff=<name>` **only when**
(a) a `CommandRunner` is present (`ctx.command !== undefined`) AND (b) `.gitattributes`
exists / resolves a `diff` attribute for the path. With no driver wired or no
attribute, the OID-only / raw-content fast path is **byte-identical and
cost-identical** to today. The provider is per-`Context` cached (like `readConfig`),
so a multi-file diff parses `.gitattributes` once. This mirrors `build-content-merger`'s
lazy provider init (`build-content-merger.ts:48`).

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
| **F3** | `filter.f.clean='false'` (always fails) + `filter.f.required=true`; `git add a.y` | `error: external filter 'false' failed`; `fatal: a.y: clean filter 'f' failed`; **exit 128**, nothing staged | `required=true` + clean failure is **fatal** — refuse the stage. |
| **F4** | same but `required` absent (default false) | `error: external filter 'false' failed` on stderr, but **exit 0** and the **raw** bytes (`data`) are staged | `required` absent/false + clean failure ⇒ git **warns, stores raw bytes, succeeds** (graceful fallback). |
| **T5/F5** | `.gitattributes` `*.z diff=d` **only** (no `filter=`); `diff.d.textconv=<uppercase>`; commit `hello`, then `world` | committed blobs are **raw** (`cat-file` → `world`); `git diff` shows textconv-uppercased both sides | `diff=` and `filter=` are **independent**: `diff=` alone never cleans the committed bytes; it only transforms at diff time. (Symmetric: `filter=` alone cleans/smudges but diffs raw.) |

The clean/smudge contract (driver invocation): git pipes content on **stdin** and
reads **stdout** for `clean`/`smudge` (no temp-file arg, unlike textconv and unlike
the merge driver's in-place `%A`). The `.process` long-running protocol is a separate,
more complex contract (out of v1 scope — see §5).

### 3.5 Driver execution — port shape (the D-EXEC decision)

The existing `CommandRunner.run` surfaces only `exitCode` (a merge driver writes its
output **file**). textconv and clean/smudge communicate via **stdout** (textconv) or
**stdin→stdout** (clean/smudge). Two ways to bridge (D-EXEC):

- **(a) Extend `CommandRunner`** with optional `stdin?: Uint8Array` input and
  `stdout` capture in `CommandResult` (`{ exitCode; stdout?: Uint8Array }`), and make
  `NodeCommandRunner` capture stdout instead of `stdio:'ignore'`. The merge driver
  keeps ignoring stdout (it reads `%A`); the filter/textconv path reads the captured
  stdout. One port, two output conventions selected by the caller.
- **(b) File-based orchestration in the primitive** (mirror `run-merge-driver`): write
  the input to a temp file under `gitDir`, build a command that redirects the driver's
  stdout to an output temp file (`run-filter-driver` appends `< in > out` or, for
  textconv, passes the temp path as `argv[1]` and redirects stdout to a temp file),
  run via the **unchanged** `CommandRunner`, read the output temp file back. No port
  change; all stdio bridging lives in the shell command the primitive builds.

Recommendation in D-EXEC. (b) keeps the port untouched and confines the change to one
new primitive, at the cost of building a redirect into the command string (git itself
runs the textconv with `argv[1]`=file and captures stdout directly, so (a) is closer
to git's mechanism; (b) is closer to the existing tsgit merge-driver precedent).

Note on T2e: the resolver treats an **absent `[diff "<name>"]` section OR an absent
`textconv` key** as "fall back to raw diff" (T2). An **empty-string** `textconv` value
is a misconfiguration git fatally errors on (T2e) — v1 should also treat empty-string
as fallback (not reproduce git's fatal error), or pin and reproduce the fatal; this is
a minor edge folded into D-EXEC's resolver semantics, not a separate decision.

### 3.6 Attribute resolution, precedence, and `-diff`/`binary` interplay

Resolution reuses `resolveAttribute(sources, path, 'diff'|'filter', macros)` verbatim
(ADR-302 precedence: `info/attributes` → per-dir `.gitattributes` deepest-first →
root → global `core.attributesFile`; last-match-wins within a file). The mapping:

| resolved `diff` attribute value | TextconvChoice |
|---|---|
| `'unspecified'` (no rule) | none — raw diff (today's behaviour) |
| `true` (`diff`) / `false` (`-diff`) | built-in: `-diff` marks the path **binary** for diff (no textconv); `diff` is the default text diff. No textconv either way. |
| `{ set: 'name' }` with `[diff "name"].textconv` configured | **external textconv** |
| `{ set: 'name' }` no `textconv` (or empty) | none — raw diff (T2 fallback) |

The built-in `binary` macro expands to `-diff -merge -text` (`macros.ts`): a path
marked `binary` resolves `diff` to `false` (`-diff`), which suppresses the text diff
entirely (git shows `Binary files differ`) — the textconv path is **not** taken. This
interplay is pinned (the `binary` macro already exists and is tested for merge; the
diff side needs a pin that `-diff` ⇒ no textconv). The symmetric `filter` mapping:
`filter=name` with `[filter "name"].clean`/`.smudge` configured ⇒ external; named but
unconfigured ⇒ identity (no clean/smudge); `-filter` / unspecified ⇒ identity.

### 3.7 Security — mirror the merge-driver / hook trust boundary, do not widen

Running a `[diff].textconv` / `[filter].clean` command is exactly the merge-driver
(ADR-304) and hook (ADR-300) trust model: the command comes from `.git/config`
(repository config, not `.gitattributes`, which only names the driver). Whoever can
write `.git/config` can already run arbitrary commands via hooks or a merge driver.
This feature:

- spawns through the **same** `CommandRunner` port and `NodeCommandRunner` (`sh -c`,
  env merge, abort-kill) — no new spawn surface;
- runs **only** when both the attribute names a driver **and** the config defines its
  command — a `.gitattributes` `diff=lfs` from an untrusted repo with **no**
  `[diff "lfs"]` in the local config runs **nothing** (T2 fallback) — the attribute
  alone is inert, exactly as git;
- adds **no** auto-discovery of system/global drivers beyond what `readConfig`
  already exposes.

No trust boundary is widened. The doc states this so the security review does not
mistake driver execution for a new attack surface — it is the established one.

### 3.8 Phased v1 (the D-SCOPE decision, recommended split)

This is a **large** feature spanning three surfaces × two mechanisms. The coherent
minimal v1 is **textconv-diff only** — it directly closes the brief's named gap
(diff faithfulness when a driver is active), reuses the most infrastructure, touches
**one** chokepoint (`materialise-patch-files`), and needs **no** working-tree write
path. clean/smudge (checkout + add) is a larger, separable slice (two more
chokepoints, the `required` failure semantics, the worktree-diff clean re-application
F1, streaming smudge via `streamBlob`). D-SCOPE is the user's call; §4 lays out v1 =
textconv vs v1 = textconv+filter.

## 4. Decision candidates

ADRs 226/249/302/303/304/398 fix faithfulness, structured-data, the attribute model,
driver resolution, the `CommandRunner` port, and the no-driver baseline. The
load-bearing choices **this** feature introduces are below — each ≤3 options with a
recommendation. The designer does **not** decide these; the user does, in the ADR phase.

| # | Choice | Alternatives (≤3) | Recommendation | Why |
|---|---|---|---|---|
| **D-SCOPE** | Which surfaces ship in v1 | (a) **textconv-diff only** (checkout-smudge + add-clean deferred); (b) textconv-diff **+** clean/smudge (all three surfaces); (c) clean/smudge only (no textconv) | **(a)** | Directly closes the brief's named gap (active-driver **diff** faithfulness) with one chokepoint (`materialise-patch-files`) and no worktree-write path; (b) is a much larger, riskier slice (two more chokepoints + `required` failure semantics + F1 worktree-diff clean re-application + streaming smudge); (c) leaves the brief's diff gap open. v1 = textconv; clean/smudge becomes the immediate follow-up backlog item with its own ADR. |
| **D-PORTBOUND** | One combined driver port vs separate | (a) **separate** resolvers/primitives for textconv (`diff=`) and filter (`clean/smudge`), sharing the one `CommandRunner` port; (b) one combined "content driver" port abstracting both; (c) fold both into the existing merge-driver primitive | **(a)** | textconv (read-side, diff-only, both-sides, stdout) and clean/smudge (write-side, paired, stdin→stdout, `required`) are **genuinely different git mechanisms** (§3.1, pinned independent in T5) — one abstraction would leak both shapes. Separate resolvers mirror `resolve-merge-driver` cleanly; both reuse the single `CommandRunner` port (no third port). (c) conflates merge (three-way, in-place `%A`) with filter (one-way, stdout) — wrong shape. |
| **D-EXEC** | How the driver's stdout/stdin is bridged | (a) **extend `CommandRunner`** with `stdin?`/`stdout` capture (`CommandResult` gains `stdout?`); (b) **file-based orchestration** in a new `run-filter-driver` primitive (temp files + shell redirect, port unchanged); (c) a **new** dedicated `FilterRunner` port | **(b)** | Keeps the `CommandRunner` port untouched (the merge driver keeps `stdio:'ignore'`), confines the change to one primitive mirroring `run-merge-driver`, and is the established tsgit precedent. (a) is closer to git's own mechanism (textconv = `argv[1]` file + stdout capture) and is cleaner if clean/smudge's stdin→stdout (D-SCOPE=b) also lands — reconsider (a) if D-SCOPE includes filter. (c) adds a redundant port for the same "spawn a process" capability. |
| **D-ADAPTER** | What memory/browser adapters do for drivers | (a) **inert / fall back** to no-driver raw bytes (mirror merge-driver ADR-304: no `CommandRunner` ⇒ built-in); (b) an **in-process JS function registry** (`Map<name, (bytes)=>bytes>`) the memory/browser adapter can populate; (c) **throw** when a driver is named but unrunnable | **(a)** | Faithful to "no active driver" ([ADR-398](../adr/398-lfs-pointer-diff-no-filter-baseline.md)) and consistent with the merge-driver and hook precedents — memory/browser already fall back. (b) is an attractive future ergonomic (browser textconv via a JS function) but invents a **second** driver-execution model and a non-git data shape; defer it as a follow-up if demand appears. (c) breaks the established graceful-fallback contract and would make a declared-`diff=lfs` repo unusable in the browser. |
| **D-CACHE** | Honour `[diff].cachetextconv` | (a) **ignore** it in v1 (always run the driver; output is identical, T7 is an optimization); (b) **implement** the OID-keyed cache (git's notes-ref cache under `.git`) | **(a)** | T7 pins caching as **observationally transparent** (same bytes, fewer calls) — ignoring it is byte-faithful, just slower on repeat diffs. Implementing git's notes-ref textconv cache is a sizable separate concern (cache invalidation, on-disk format) with **zero** observable-data difference. Defer; v1 always runs the driver. |
| **D-REQUIRED** | (only if D-SCOPE includes filter) `filter.<name>.required` failure semantics | (a) **reproduce git exactly**: `required=true`+fail ⇒ fatal refuse (F3); absent/false+fail ⇒ warn + store raw + succeed (F4); (b) always fatal on any clean failure; (c) always store-raw on failure | **(a)** | F3/F4 are pinned, divergent behaviours git users depend on (lfs sets `required=true`). (b)/(c) diverge from git. Only relevant if clean/smudge ships in v1 (D-SCOPE=b); otherwise this rides the clean/smudge follow-up ADR. |

## 5. Test strategy

Mirrors the merge-driver test plan (`custom-merge-drivers.md` §Test plan) and the
interop discipline of `lfs-pointer-interop` / `merge-driver-interop`.

**Unit (domain, pure):**
- `domain/attributes/driver-command.test.ts` — extend for the filter/textconv
  placeholder set (`%f` pathname; `%%`; unknown `%x` literal) if a placeholder set is
  added; textconv via `[diff].textconv` takes no placeholder (file is `argv[1]`), so
  the test asserts the resolver builds the right invocation shape.

**Unit (primitives):**
- `resolve-textconv-driver.test.ts` — every row of the §3.6 mapping: `diff=name` +
  configured `textconv` ⇒ external; named-but-unconfigured ⇒ none (T2); `-diff` /
  `binary` macro ⇒ none (no textconv); empty-string `textconv` ⇒ none. Precedence +
  last-match reused from `resolve-attribute` (already covered). Isolated guard tests
  per branch (mutation-resistant: assert the exact choice, not a truthy).
- `apply-textconv.test.ts` (or the textconv arm of `materialise-patch-files.test.ts`)
  — both-sides transform; add (new side only) / delete (old side only); gitlink side
  excluded; default path (no driver) returns raw content byte-identical.
- `run-filter-driver.test.ts` — temp-file / stdout-capture lifecycle via memory fs +
  a fake `CommandRunner`; exit-0 path, abort, cleanup in `finally`.
- (if D-SCOPE=b) `resolve-filter-driver.test.ts`, the clean hook in `add` /
  `stageFromStat`, the smudge hook in `apply-changeset`, and the F3/F4 `required`
  failure branches.

**Unit (command + adapter):**
- `diff.test.ts` — a `diff=` textconv case threads from `DiffOptions` through the
  primitive; default options unchanged (regression). `ctx.command` absent ⇒ raw diff
  (fallback, R11).
- `node-command-runner.test.ts` — if D-EXEC=(a), the stdout-capture branch
  (injected spawn); if D-EXEC=(b), unchanged.

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
- **`lfs-pointer-interop.test.ts` stays green** — the
  [ADR-398](../adr/398-lfs-pointer-diff-no-filter-baseline.md) no-driver baseline is
  the regression boundary; assert the declared-but-inert `diff=lfs`-with-no-driver
  case still shows pointer text (now that a live resolver exists, this proves the
  resolver falls back rather than crashes).
- (if D-SCOPE=b) **`filter-clean-smudge-interop.test.ts`** — F1 (clean+smudge
  round-trip + worktree-diff no-diff), F2 (clean-only identity smudge), F3/F4
  (`required` failure semantics), asserting committed-blob OID + working-tree-bytes
  parity vs git.

GWT/AAA, `sut`, 100% coverage, 0 killable mutants; error assertions specific (code +
data, per the mutation-resistant patterns).

## 6. Out of scope

- **clean/smudge (checkout + add) if D-SCOPE=(a)** — the recommended v1 ships
  textconv-diff only; the write-side filter pair (clean on add, smudge on checkout,
  `required` semantics, worktree-diff clean re-application, streaming smudge via
  `streamBlob`) is the immediate follow-up backlog item with its own ADR. The brief's
  diff gap is closed by textconv alone.
- **`[filter].process` long-running protocol** — git's packet-line `process` filter
  (a persistent driver subprocess speaking the filter protocol) is a separate, more
  complex contract than `clean`/`smudge` one-shot commands; out of v1 even when
  clean/smudge ships. Falls back to `clean`/`smudge` (git's own fallback when
  `process` is absent).
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
