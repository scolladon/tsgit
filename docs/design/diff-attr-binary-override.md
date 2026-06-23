# Design — `diff` / `binary` attribute as the diff binary-vs-text display override

> Brief: make tsgit's binary-vs-text **display** decision in diff honour the
> `diff` / `binary` `.gitattributes` attribute, not just content-sniffing. Today
> the decision is purely a NUL-byte scan (`isBinary`), so tsgit and git **diverge**
> whenever the attribute overrides the content heuristic: `-diff` (and the `binary`
> macro) force "Binary files … differ" over textual content; bare `diff` forces a
> text hunk over NUL-containing content. Mirrors how
> [#195](../design/lfs-filter-driver-port.md) made the **textconv** side
> attribute-aware: resolve in the application layer (reusing #195's
> `AttributeProvider`), thread an optional override into the pure domain diff
> functions, keep the no-attribute path byte- and cost-identical to today. Lifts the
> **binary** part of the `text`/`eol`/`binary` parking note in
> [`lfs-filter-driver-port.md` §6](lfs-filter-driver-port.md).
> Status: draft → self-reviewed ×3 → **decision candidates open** (§4 drives the ADR phase).

This design has no requirements phase upstream; §1.1 supplies a short brief. It
follows the house format of its direct precedent
[`lfs-filter-driver-port.md`](lfs-filter-driver-port.md) (#195 — the feature this
one composes with) and the diff-faithfulness siblings
([`diff-faithfulness-odds-ends.md`](diff-faithfulness-odds-ends.md),
[`whitespace-diff-options.md`](whitespace-diff-options.md)): problem → current state
→ faithfulness baseline (pinned matrix) → proposed change → test/interop plan →
decision candidates → out of scope.

## 0. Cross-cutting constraints (tsgit prime directives — non-negotiable)

| Source | Binding constraint on this design |
|---|---|
| ADR-226 / CLAUDE.md (git-faithfulness) | Replicate canonical git's observable DATA + on-disk state byte-for-byte: the `diff`/`binary` attribute's effect on the binary-vs-text decision must reproduce git's `Binary files … differ` / numstat `-\t-` / text-hunk choice for the same `.gitattributes`. Pinned against real `git 2.54.0` (§3.4), scrubbed `GIT_*`, `GIT_CONFIG_NOSYSTEM=1`, isolated `HOME`, signing off, `mktemp -d` throwaway, `--no-ext-diff` on every scripted `git diff`. Every pinned behaviour becomes a cross-tool interop test in `test/integration/*-interop.test.ts`. |
| ADR-249 (structured-data-only) | The library ships the structured `binary: boolean` (already on `StatFields`) and `PatchFile` content; it emits **no** rendered `Binary files … differ` line or `-\t-` row. The override changes how `binary`/the patch's binary branch is **computed**, never adds a rendering knob. The interop test reconstructs git's display from the structured fields and compares to real `git`. The `--raw`/`--name-status`/`index`-line OIDs stay the **raw** tree OIDs, untouched by the attribute (§3.4 row R). |
| CLAUDE.md (architecture) | Hexagonal: `repository → commands → primitives → domain`. `src/domain/diff/` is **pure** — no `Context`, no `AttributeProvider`, cannot resolve attributes. The override is **resolved in the application layer** (`materialise-patch-files.ts`, reusing #195's provider) and **threaded into** the domain diff functions as an optional value, exactly as #195 threaded textconv content. Domain stays platform-free. |
| Performance / regression boundary | The default path (no `diff`/`binary` attribute, or no provider/runner) must be **byte- and cost-identical** to today: no attribute read forced onto a diff that has no attribute. The override is `undefined` on that path and every domain function falls back to today's `isBinary` content-sniff. |

All empirical pins in §3.4 were run in `mktemp -d` throwaways with the faithfulness
procedure (`.claude/workflow/faithfulness.md`); none touched the worktree's `.git`
(verified intact after: `git config --get remote.origin.url` →
`git@github.com:scolladon/tsgit.git`).

## 1. Context

### 1.1 Problem (self-supplied brief)

git's binary-vs-text **display** decision in diff is **not** purely content-sniffing
— it honours the `diff` attribute first:

- `-diff` (set false; and the built-in `binary` macro `= -diff -merge -text`) forces
  the path to be treated **binary** for diff: git prints `Binary files a/F and b/F
  differ` and numstat `-\t-`, **even when the content is purely textual** (no NUL).
- bare `diff` (set true) forces the path to be treated **text**: git prints a real
  text hunk and counts lines, **even when the content has NUL bytes**.
- `diff=<name>` (a named userdiff driver) makes the **patch** a text hunk (and, with
  a configured `[diff "<name>"].textconv`, diffs the transformed bytes — #195),
  while the **numstat / `--stat`** binary decision stays on the **raw** content
  (a surprising asymmetry, pinned §3.4 rows N3/N3s, decision candidate **D-NAMED**).
- unspecified (no rule) → content sniff (NUL → binary) — **today's behaviour**, the
  regression boundary.

tsgit's binary decision is **purely** `isBinary(bytes)` (a NUL-byte window scan plus
line-length caps) at three domain sites (§1.2). It never reads the `diff` attribute,
so tsgit and git diverge in every non-unspecified row above. This feature makes the
decision attribute-aware, mirroring #195's textconv threading exactly.

[#195](lfs-filter-driver-port.md) made the **textconv** half of the `diff` attribute
live (it transforms the diffed bytes); it left the **binary-decision** half of the
same attribute parked — `lfs-filter-driver-port.md §6` lists "`text`/`eol`/…
attributes" parked, and the `binary` macro's `-diff` is noted as interacting
(`§3.6`). This feature is that deferred consumer for the binary half.

### 1.2 Current state (verified)

The three domain sites where the binary-vs-text decision is made today, all gating on
**content only** via `isBinary`:

| Site | File:symbol | Today | This feature |
|---|---|---|---|
| Binary predicate | `domain/diff/line-diff.ts` `isBinary(bytes)` (`hasNulInWindow` + `exceedsLineCaps`) | The **only** binary signal. NUL in first `BINARY_DETECTION_BYTES` (8000) or a line ≥ `MAX_LINE_BYTES` / ≥ `MAX_LINES` ⇒ binary. | **Keep as the fallback.** A new override short-circuits it when set; `undefined` ⇒ call it unchanged. |
| Numstat short-circuit | `domain/diff/stat-fields.ts` `computeStatFields(old, next, options?)` line 80: `if (isBinary(old) \|\| isBinary(next)) return { added: 0, deleted: 0, binary: true }` | numstat `-\t-` gated on **content** of both sides. | Accept an optional override; `'binary'` ⇒ short-circuit to `binary:true`; `'text'` ⇒ skip the `isBinary` short-circuit and count lines; `undefined` ⇒ today. |
| Patch binary branch | `domain/diff/patch-serializer.ts` — `renderSameKindBlock` (l.514), `renderTwoPathBody` (l.643), `renderBrokenModifyBlock` (l.553), `renderTypeChangeBlock` (l.608 + l.611, two calls — old/new tested independently), `renderFile` add (l.741) / delete (l.746) | "Binary files … differ" vs text hunk gated on `isBinary` across **6 decision functions** (7 `isBinary` calls). | Accept a per-file override; `'binary'` ⇒ force the `renderBinaryBody`/`renderAddBinary`/`renderDeleteBinary` branch; `'text'` ⇒ force the text-hunk branch; `undefined` ⇒ today's `isBinary`. |

The application-layer wiring #195 already built — the single resolve point this
feature reuses:

| Asset | File:symbol | Status for this feature |
|---|---|---|
| `.gitattributes` resolve | `domain/attributes/` (`resolveAttribute(sources, path, 'diff', macros)`, `AttributeValue` four-state `true`/`false`/`'unspecified'`/`{set}`, `macros.ts` `BUILTIN_MACROS` `binary = -diff -merge -text`) | **Reuse verbatim.** `resolveAttribute` for `'diff'` already yields the four-state value; the `binary` macro already expands to `diff:false`. The binary-override resolver maps that value to `'binary'`/`'text'`/`undefined` (§3.3). |
| Attribute provider | `primitives/internal/read-gitattributes.ts` `buildAttributeProvider(ctx)` → `sourcesForPath(path)` | **Reuse the SAME instance** #195 builds in `materialisePatchFiles`. Do **not** build a second provider — resolve the binary-override in the **same** per-path lookup that already resolves textconv (§3.2). |
| Textconv resolver | `primitives/resolve-textconv-driver.ts` `resolveTextconvDriver(ctx, provider, path) → TextconvChoice` over `resolveAttribute(…, 'diff', …)` | **Sibling / compose.** The new resolver reads the **same** `diff` attribute value. §3.2 shows it can share `provider.sourcesForPath(path)` to avoid a second lookup. |
| Diff content chokepoint | `primitives/materialise-patch-files.ts` `materialisePatchFiles(ctx, changes, { applyTextconv })` → `PatchFile{change, oldContent?, newContent?}` | **Hook point.** The single place #195 resolves the provider + `diff` attribute per path and transforms content. The binary-override is resolved here in the **same** `maybeTextconv` per-path pass and attached to the `PatchFile` (§3.2, decision candidate **D-SHAPE**). |
| Numstat + drop chokepoint | `primitives/diff-trees.ts` `applyLinePassAndStat` (l.99–110): `materialisePatchFiles(ctx, diff.changes, { applyTextconv: true })` then `computeStatFields(file.oldContent, file.newContent, statOptionsFor(…))` per file | **Single numstat call site.** The override attached to each `PatchFile` (§3.2) feeds `computeStatFields` here. `shouldDrop` (whitespace drop) reads `stats.binary` — the override must reach it consistently. |
| Patch reconstruction (interop) | `test/integration/diff-reconstruct.ts` `reconstructPatch(ctx, treeDiff, opts?)` = `renderPatch(materialisePatchFiles(ctx, changes, { applyTextconv: true }), opts)` | **The display reconstructor (ADR-249).** Once `PatchFile` carries the override and `renderPatch` honours it, the interop test reconstructs git's binary/text choice from the structured data. |
| Content-stable callers (must NOT get the override) | `primitives/patch-id.ts` l.59–60, `commands/range-diff.ts` l.74, `commands/rebase.ts` l.301 — all call `materialisePatchFiles(ctx, changes)` **without** `applyTextconv` | **Boundary.** These need content-stable raw bytes (patch-id stability, rebase `.git/rebase-merge/patch`). They must **not** receive a binary-override either — the override rides the **same opt-in** as textconv (`applyTextconv: true`), so it is absent on these paths by construction (§3.2, R4). |

`isBinary` is also exported through the domain diff barrel and used by `patch-id.ts`
(content-stable) — **unchanged**; the override never touches `isBinary` itself, only
who calls it and whether a caller short-circuits it.

### 1.3 Constraining decisions (FIXED — not re-litigated)

| Source | Decision this design must honour |
|---|---|
| ADR-302 | `.gitattributes` source model, precedence, macros, `AttributeValue` four-state — reuse verbatim. The `binary` macro is `-diff -merge -text`. |
| ADR-406 / ADR-407 / ADR-408 (#195) | The active-driver port: `diff=<name>` textconv resolution + the `AttributeProvider` build in `materialisePatchFiles`, the off-node inert fallback (no `ctx.command` ⇒ no attribute read). This feature **composes with** that resolution, reusing the same provider; it does **not** re-open it. |
| ADR-249 | Library emits structured data; display (`Binary files … differ`, `-\t-`) is reconstructed in the interop test. The `binary` boolean already exists on `StatFields`; this feature changes its computation, adds no field. |
| ADR-398 | The no-driver / no-attribute baseline (content-sniff) is the faithful target and the regression boundary the override must not silently cross. |

## 2. Requirements

What must be true when this ships (verifiable statements). All firm for v1:

1. A path resolving `diff` to **`false`** (`-diff`, incl. via the `binary` macro)
   shows **`Binary files … differ`** in the patch and **`-\t-`** in numstat **even
   when both sides are purely textual** (no NUL), byte-identical to git — for
   modify, add, delete, and broken-modify shapes (§3.4 rows B1/Ba/Bd/Bn).
2. A path resolving `diff` to **`true`** (bare `diff`) shows a **real text hunk** and
   **counts lines** (numstat `n\tm`) **even when a side has NUL bytes**, byte-identical
   to git — the NUL byte survives verbatim in the patch text (§3.4 rows T2/T2n).
3. A path with **`diff=<name>`** and a configured `[diff "<name>"].textconv`
   composes with #195: the **patch** is a text hunk over the **textconv-transformed**
   bytes (#195's behaviour, unchanged); the **numstat** binary decision is git's —
   pinned **divergent** from the patch over NUL content (§3.4 rows N3/N3s,
   decision candidate **D-NAMED**).
4. A path with **`diff=<name>`** and **no** `[diff "<name>"].textconv` (or empty)
   falls back to the **raw content-sniff** on both surfaces — a text hunk + line
   counts over clean content, `Binary files … differ` + `-\t-` over NUL content —
   byte-identical to git (§3.4 row N4), composing with #195's T2 fallback (no override
   applied).
5. The override resolution rides the **same opt-in** as #195's textconv
   (`applyTextconv: true`): the display paths (`diff`/`show`/`log -p`, numstat) get
   it; the **content-stable** paths (patch-id, range-diff, rebase patch file) do
   **not** — their binary decision stays the pure content-sniff (R4-boundary, §3.2).
6. The structured `TreeDiff.changes` membership, change `type`, and `--raw`/`index`-line
   **OIDs** are the **raw tree** values — the override affects only the
   patch-binary-branch + numstat `binary`, never OIDs (§3.4 row R).
7. **Default path (no `diff`/`binary` attribute, or no provider/runner) is byte- and
   cost-identical to today:** the override is `undefined`, every domain site calls
   `isBinary` exactly as before, no attribute is read. The ADR-408 inert fallback
   (no `ctx.command`) yields `undefined` override ⇒ content-sniff (§3.3).
8. Every pinned row (§3.4) is a cross-tool `*-interop` test; the existing
   `diff-textconv-interop.test.ts` T-BIN case (binary macro over **NUL** content,
   where attribute and content agree) stays green.

## 3. Design

### 3.1 Shape: an optional tri-state override threaded from the application layer

The domain stays pure. A single optional value — call it `binaryOverride` (decision
candidate **D-SHAPE** picks the exact type) — is resolved **once per changed path** in
the application layer and threaded into the two domain decision surfaces:

```
domain/diff/                              (pure — gains an optional parameter only)
  line-diff.ts        isBinary(bytes)                    UNCHANGED (the fallback)
  stat-fields.ts      computeStatFields(old, next, options?)
                        options gains  binaryOverride?: 'binary' | 'text'
                        'binary' ⇒ { added:0, deleted:0, binary:true }
                        'text'   ⇒ skip the isBinary short-circuit, count lines
                        undefined⇒ today's `isBinary(old) || isBinary(next)`
  patch-serializer.ts PatchFile gains  binaryOverride?: 'binary' | 'text'
                        each of the 6 isBinary call sites consults the override first

application/primitives/
  resolve-binary-override.ts   NEW — (ctx?, provider, path) → 'binary' | 'text' | undefined
                               over resolveAttribute(…, 'diff', …); sibling of resolve-textconv-driver
  materialise-patch-files.ts   resolves the override in the SAME per-path pass that
                               resolves textconv (reuse the one provider), attaches it to PatchFile
  diff-trees.ts                applyLinePassAndStat feeds PatchFile.binaryOverride into computeStatFields
```

**Dependency rule** honoured exactly as #195: `domain/diff` gains a plain optional
enum parameter (no `Context`, no provider); the application layer computes it from the
attribute provider; ports/adapters untouched. This mirrors how #195 fed *transformed
content* into the same domain functions — here we feed a *decision* instead of content,
because the binary decision (unlike textconv) is not expressible as a byte transform
(`-diff` over textual content cannot be made "look binary" by transforming bytes; it is
a pure display-mode flag).

Two precision points:

- **The override short-circuits BOTH `isBinary` sub-signals** (the NUL window scan
  **and** the line-length / line-count caps `exceedsLineCaps`): `'text'` forces a real
  line diff even on a NUL-bearing or cap-exceeding blob (git does too when `diff` is
  set); `'binary'` forces the binary branch even on small clean text. The caps are a
  tsgit safety bound, not a git concept — a `'text'`-forced cap-exceeding blob still
  diffs (git would attempt it under `diff`); the existing `diffLines` `wholeFileFallback`
  (`degraded`) still protects against pathological memory, so the override does not
  remove that guard, only the `isBinary` *display* short-circuit.
- **Path used to resolve the attribute** is `primaryPath(change)` — the **new** path
  for rename/copy/add, the path for modify/type-change, the old path for delete —
  exactly the path #195 already feeds `resolveTextconvDriver`. Both halves of the
  `diff` attribute resolve against the same single path, so a rename's binary decision
  follows the destination's `.gitattributes` rule (consistent with #195; git's own
  rename diff also keys the userdiff driver off the destination path).

### 3.2 The single resolve point — reuse #195's provider, ride its opt-in

`materialisePatchFiles` (`materialise-patch-files.ts`) already, under
`options.applyTextconv === true && ctx.command !== undefined`, builds a lazily-memoised
`AttributeProvider` (`getProvider: () => (providerPromise ??= buildAttributeProvider(ctx))`)
and, in `maybeTextconv`, calls `provider.sourcesForPath(filePath)` →
`resolveTextconvDriver`. The binary-override is resolved in the **same** per-path pass:

1. `maybeTextconv` (or a renamed `maybePerPathDiffAttr`) already holds the resolved
   `diff` attribute value for the path via `resolveAttribute(sources, path, 'diff', macros)`
   (today only inside `resolveTextconvDriver`). Expose that one lookup so **both** the
   textconv choice **and** the binary-override are derived from **one**
   `sourcesForPath(path)` call — no second provider, no second resolve.
2. The resolved override (`'binary'` | `'text'` | `undefined`) is attached to the
   returned `PatchFile` (`{ change, oldContent?, newContent?, binaryOverride? }`).
3. Everything downstream reads it: `renderPatch`/`renderFile` (patch text), and
   `applyLinePassAndStat` → `computeStatFields` (numstat + the whitespace `shouldDrop`).

**Riding the opt-in (R4 boundary).** The override is computed **only** when
`options.applyTextconv === true` (the display opt-in) — the same condition that gates
textconv. The content-stable callers (`patch-id.ts`, `range-diff.ts`, `rebase.ts`)
call `materialisePatchFiles(ctx, changes)` with **no** options, so `binaryOverride`
is `undefined` on every `PatchFile` they get, and `renderPatch`/any stat there sees the
pure content-sniff — patch-id and rebase patch bytes are unchanged. (This is why the
override is **not** a separate `materialisePatchFiles` option: coupling it to
`applyTextconv` makes the content-stable boundary automatic and impossible to mis-wire.
Decision candidate **D-OPTIN** records the alternative of a separate flag.)

**Off-node / inert fallback (R7) — and a deliberate conservatism to flag.** When
`ctx.command === undefined` (memory/browser), the existing #195 guard skips the provider
build, so `binaryOverride` is `undefined` everywhere ⇒ content-sniff. This matches
#195's inert fallback precisely and yields no throw.

But note an **asymmetry with #195's rationale**: textconv genuinely needs a
`CommandRunner` (it spawns a process), so gating it on `ctx.command !== undefined` is
load-bearing for #195. The **binary override**, by contrast, is a pure in-process
decision over the resolved attribute — `-diff` / bare `diff` spawn **nothing**, so they
*could* be honoured off-node by building the provider whenever the display opt-in is
requested, **regardless** of a runner. Tying the override to `ctx.command !== undefined`
is therefore a **deliberate simplification** (one guard, mirrors #195, keeps the
default path's cost story identical) that is **more conservative than faithfulness
strictly requires**: in the browser, a `*.bin -diff` textual file would show a text hunk
where node-with-a-runner shows `Binary files … differ`. That is a real (if narrow)
off-node divergence from git. Whether to accept it (recommended — mirror #195, browser
is a no-driver environment by ADR-398/408) or to decouple the override's guard from the
runner (honour `-diff`/`diff` off-node, gate only textconv on the runner) is folded into
decision candidate **D-OPTIN**.

### 3.3 Attribute → override mapping (the crux — pinned §3.4)

`resolve-binary-override.ts` maps the resolved `diff` `AttributeValue` to an override.
The mapping is **surface-dependent** because of the pinned numstat/patch asymmetry for
named drivers (§3.4 N3). The recommended model treats the **patch** and **numstat**
override mappings as follows:

| resolved `diff` value | patch binary-override | numstat binary-override | git behaviour pinned |
|---|---|---|---|
| `false` (`-diff`, incl. `binary` macro) | **`'binary'`** | **`'binary'`** | force binary both surfaces (§3.4 B1/Bn) |
| `true` (bare `diff`) | **`'text'`** | **`'text'`** | force text both surfaces (§3.4 T2/T2n) |
| `{ set: 'name' }`, `textconv` configured | **`'text'`** (textconv content feeds a text hunk even when NUL-retaining) | **`undefined`** (content-sniff on RAW bytes ⇒ `-\t-` over NUL) | patch=text via textconv; numstat=binary over NUL (§3.4 N3/N3s) — **D-NAMED** |
| `{ set: 'name' }`, no/empty `textconv` | **`undefined`** (raw content-sniff: text hunk over clean, `Binary files` over NUL) | **`undefined`** (content-sniff on raw) | patch + numstat both content-sniff the raw fallback (§3.4 N4) |
| `'unspecified'` (no rule) | **`undefined`** | **`undefined`** | content-sniff — today's behaviour |

Note the two named-driver rows differ: a **configured** `textconv` forces the patch to
text (N3 — git shows a hunk even when the transformed bytes keep NUL), but a
**named-but-unconfigured** driver does **not** force the patch — it content-sniffs the
**raw** fallback (N4: text hunk over clean content, `Binary files … differ` over NUL).
So the patch `'text'` override is needed **only** when a `textconv` is actually
configured.

The asymmetry (named-configured: patch `'text'` but numstat `undefined`) is the
single most load-bearing pinned fact and the reason for decision candidate
**D-NAMED**. Two observations make it tractable:

- **Patch side for named drivers needs no new override in the common case.** When a
  `textconv` is configured, #195 already replaces `PatchFile.{old,new}Content` with the
  transformed bytes; if the transformed bytes are clean text, `renderPatch`'s existing
  `isBinary` already chooses the text branch. The override `'text'` is only needed when
  the transformed bytes **still contain NUL** yet git shows a text hunk anyway (§3.4
  N3s, the `tr a-z A-Z`-keeps-NUL case). **D-NAMED** decides whether v1 forces patch
  `'text'` for every named driver (faithful to N3s) or relies on the transformed-bytes
  sniff (simpler, diverges only on the NUL-retaining-textconv edge).
- **Numstat side for named drivers is ALREADY what tsgit produces.** tsgit's
  `computeStatFields` receives the **transformed** bytes (via `applyLinePassAndStat`'s
  `materialisePatchFiles({applyTextconv:true})`). For `diff=name` over NUL where the
  textconv keeps NUL, the transformed bytes trip `isBinary` ⇒ `-\t-` — matching git's
  numstat (§3.4 N3). So `undefined` (content-sniff on the transformed bytes) is the
  faithful numstat override for named drivers, requiring **no change** on that surface.
  The risk is a NUL-**stripping** textconv (§3.4 N3-strip): transformed bytes are clean
  ⇒ tsgit numstat would count lines, but git numstat shows `-\t-` (it sniffs the RAW
  blob, not the transformed). **D-NAMED** must decide whether v1 reproduces this
  raw-vs-transformed numstat divergence (requires numstat to sniff RAW bytes, not the
  transformed ones #195 hands it — a deeper change) or accepts it as a documented edge.

Because the override differs per surface only for the named-driver rows, **D-SHAPE**
also covers whether the `PatchFile` carries **one** override (and the numstat path
derives its own) or **two** (`patchBinaryOverride` / `numstatBinaryOverride`).

### 3.4 Pinned faithfulness matrix (real `git 2.54.0`, mktemp throwaway)

Scrubbed `GIT_*`, `GIT_CONFIG_NOSYSTEM=1`, isolated `HOME`, signing off,
`--no-ext-diff`, `merge.conflictStyle=merge`. Textconv driver is a trivial portable
`LC_ALL=C tr a-z A-Z` script. **The pin decides the model.**

#### `-diff` / `binary` macro — force BINARY (decision-candidate-free: maps to `'binary'`)

| # | Setup | `git` result | Load-bearing fact |
|---|---|---|---|
| **B1** | `.gitattributes` `f -diff`; commit `hello world\nsecond line`, then `hello there\nsecond line` (**no NUL**); `git diff HEAD~1 HEAD` | `diff --git a/f b/f` / `index f0e9ea9..703f9bc 100644` / **`Binary files a/f and b/f differ`** | `-diff` forces binary display over **purely textual** content. `isBinary(content)` would say text — the attribute overrides it. |
| **Bn** | same | `--numstat` → **`-\t-\tf`** | numstat `-\t-` forced by `-diff` over textual content. |
| **B-tc** | same + `git diff --textconv` | **identical** to B1 (`Binary files … differ`) | `--textconv` does **not** revive a `-diff` path — no driver runs, binary stands. (#195's `resolveTextconvDriver` already returns `none` for `-diff`.) |
| **Ba** | `f -diff`; **add** textual `alpha\nbeta` | `new file mode 100644` / `index 0000000..fbbee86` / **`Binary files /dev/null and b/f differ`**; numstat `-\t-` | add-side: one-sided binary line `/dev/null and b/F`. |
| **Bd** | `f -diff`; **delete** the textual file | `deleted file mode 100644` / `index fbbee86..0000000` / **`Binary files a/f and /dev/null differ`**; numstat `-\t-` | delete-side: one-sided binary line `a/F and /dev/null`. |
| **Bmacro** | `*.bin binary` (macro) over **NUL** content modify | `Binary files … differ`; numstat `-\t-` | the `binary` macro (`-diff -merge -text`) ⇒ `diff:false` ⇒ identical to `-diff`. Here content **agrees** (NUL present) — this is the existing T-BIN interop case (stays green, R8). |

#### bare `diff` — force TEXT (decision-candidate-free: maps to `'text'`)

| # | Setup | `git` result | Load-bearing fact |
|---|---|---|---|
| **T2** | `.gitattributes` `f diff`; commit `line one\0zero\nline two`, then `line ONE\0zero\nline two` (**NUL in line 1**); `git diff HEAD~1 HEAD` | full text hunk: `@@ -1,2 +1,2 @@` / `-line one\0zero` / `+line ONE\0zero` / ` line two` — **the NUL byte (`\0`) is emitted verbatim in the patch** | bare `diff` forces a **text hunk over NUL content**. `isBinary` would say binary — the attribute overrides it. The NUL survives in the patch bytes. |
| **T2n** | same | `--numstat` → **`1\t1\tf`** | numstat counts lines over NUL content when `diff` is set. |

#### `diff=<name>` named driver — patch/numstat ASYMMETRY (decision candidate **D-NAMED**)

| # | Setup | `git` result | Load-bearing fact |
|---|---|---|---|
| **N1** | `f diff=up`, `diff.up.textconv=<uppercase>`; **clean text** `hello\nkeep` → `world\nkeep`; **default** `git diff` (no `--textconv` flag) | text hunk `-HELLO` / `+WORLD` / ` KEEP`; numstat `1\t1` | a configured `diff=name` runs textconv on **default** `git diff` (the `--textconv` flag is irrelevant when the attribute names a driver). Patch + numstat both text. (#195 territory — unchanged.) |
| **N3** | `f diff=up`, `diff.up.textconv=<uppercase, keeps NUL>`; **NUL content** `hello\0nul\nkeep` → `world\0nul\nkeep`; default `git diff` | **patch**: text hunk `-HELLO\0NUL` / `+WORLD\0NUL` (textconv ran, NUL retained, **text hunk shown**); **numstat**: **`-\t-`**; **`--stat`**: `Bin 0 -> N bytes` | **THE ASYMMETRY.** Named driver ⇒ patch is a text hunk (textconv output) **even with NUL retained**, but numstat/`--stat` show **binary** (`diff_filespec_is_binary` sniffs the **raw** blob; a userdiff name does not clear it for numstat). |
| **N3s** | as N3 but textconv **strips NUL** (`tr -d '\0' \| tr a-z A-Z`) | **patch**: text hunk `-HELLOX` / `+WORLDX` (clean); **numstat**: **`-\t-`** (still binary!) | numstat is **`-\t-`** regardless of whether the textconv output has NUL — it is decided on the **raw** blob, not the transformed bytes. tsgit (which sniffs transformed bytes) would say **text** here ⇒ a divergence **D-NAMED** must rule on. |
| **N4** | `f diff=unk` with **no** `[diff "unk"]` section; **NUL content** modify | **patch**: `Binary files … differ`; numstat `-\t-` | a named-but-**unconfigured** driver over NUL ⇒ patch falls back to the raw content-sniff (NUL ⇒ binary). Compose with #195 T2 (raw fallback). (Over **clean** content, N4 would show a raw text hunk — #195 T2.) |

#### Structured-data invariance (ADR-249)

| # | Setup | `git` result | Load-bearing fact |
|---|---|---|---|
| **R** | any of B1/T2/N3 | `git diff --raw --abbrev=40` shows the **raw tree OIDs** unchanged (`:100644 100644 f0e9ea9… 703f9bc… M f`) | the `diff` attribute (binary override or textconv) never enters `--raw`/`--name-status`/`index`-line OIDs — structured data is raw (ADR-249). |

**Divergence summary (today vs git), the bugs this fixes:**

| Case | git | tsgit today | After |
|---|---|---|---|
| `-diff`, textual content | `Binary files differ` / `-\t-` | text hunk / `n\tm` (sniffs content=text) | binary (override `'binary'`) |
| bare `diff`, NUL content | text hunk / `1\t1` | `Binary files differ` / `-\t-` (sniffs content=binary) | text (override `'text'`) |
| `diff=name` (NUL-keeping textconv), patch | text hunk | `Binary files differ` (sniffs transformed=NUL) | text hunk (override `'text'` — D-NAMED) |
| `diff=name` (NUL-stripping textconv), numstat | `-\t-` (raw sniff) | `n\tm` (sniffs transformed=clean) | D-NAMED edge |

### 3.5 Precedence / composition with #195 textconv (unambiguous)

Stated as the binding contract the application layer implements:

- **`-diff`** (incl. `binary` macro) ⇒ binary display both surfaces; **no textconv**
  (#195's `resolveTextconvDriver` already returns `none` for `diff:false`).
- **bare `diff`** ⇒ text display both surfaces; **no textconv** (no named driver;
  #195 returns `none` for `diff:true`).
- **`diff=name` + configured `textconv`** ⇒ patch text (over the transformed bytes,
  forced text even when NUL-retaining — N3); numstat content-sniffs the raw blob
  (D-NAMED).
- **`diff=name` + no/empty `textconv`** ⇒ patch + numstat both content-sniff the raw
  fallback (#195 T2): text hunk over clean content, `Binary files differ` over NUL (N4).
  No override applied (`undefined`).
- **unspecified** ⇒ content-sniff both surfaces (today).

A single `resolveAttribute(sources, path, 'diff', macros)` lookup yields the value that
drives **both** the textconv choice (#195) **and** the binary-override (this feature),
so the two are guaranteed consistent and computed from one `sourcesForPath` pass (§3.2).

### 3.6 Security

No new trust surface. This feature reads `.gitattributes` (already read by #195 and the
merge driver) and resolves an attribute to an enum — it spawns **nothing new**.
Textconv spawning is #195's established boundary (ADR-407); the binary-override is a
pure in-process decision with no command execution. The `binary`-macro / `-diff` path
spawns no driver at all.

## 4. Decision candidates — for the ADR conversation (≤3 options each; do not decide here)

ADRs 226/249/302/406/407/408 fix faithfulness, structured-data, the attribute model,
and #195's textconv port. The load-bearing choices **this** feature introduces:

| # | Choice | Alternatives (≤3) | Recommendation |
|---|---|---|---|
| **D-SHAPE** | The override type threaded into `computeStatFields` + `PatchFile` | (a) **one** optional tri-state `binaryOverride?: 'binary' \| 'text'` on both `StatFieldsOptions` and `PatchFile` (`undefined` ⇒ today's sniff); (b) a **boolean** `forceBinary?: boolean` (loses the `'text'`-force-over-NUL case — insufficient for bare `diff`); (c) a **richer descriptor** `{ mode: 'binary' \| 'text' \| 'auto' }` per surface (patch vs numstat) to carry the D-NAMED asymmetry explicitly | **(a)** — the minimal faithful shape; matches the four-state attribute collapsed to the two display modes git actually has, plus `undefined`. If D-NAMED needs per-surface divergence, extend to (c)'s two fields (`patchBinaryOverride` / numstat derives its own) — but keep one enum, not a struct. |
| **D-NAMED** | How `diff=<name>` maps to the **numstat** binary decision, given the pinned raw-vs-transformed asymmetry (N3/N3s) | (a) **numstat = content-sniff on the transformed bytes** (`undefined` override; **no change** to the numstat path) — faithful for NUL-**keeping** textconv (N3), **diverges** for NUL-**stripping** textconv (N3s: git `-\t-` on raw, tsgit `n\tm` on transformed); (b) **numstat sniffs the RAW blob** for named-driver paths (thread the raw bytes separately so `computeStatFields` sees raw, not transformed) — faithful for N3 **and** N3s, but a deeper change to `applyLinePassAndStat`; (c) **force numstat `'binary'`** whenever `diff=name` is active (git only does this when the raw blob is binary — would diverge for `diff=name` over clean text, N1 numstat `1\t1`) | **(a) for v1**, documenting the N3s NUL-stripping-textconv edge as a known divergence (a textconv that strips NUL is exotic; the common `diff=name` cases — clean text N1, NUL-keeping N3 — are faithful). Escalate (b) to the user: it is the fully-faithful option but costs a raw-bytes side-channel through the numstat path. **This row needs the user's explicit sign-off — it is the surprising pinned behaviour.** |
| **D-OPTIN** | How the override is gated so (i) content-stable callers never get it, and (ii) the off-node guard is set | (a) **ride #195's `applyTextconv: true` opt-in, gated `&& ctx.command !== undefined`** — content-stable callers (patch-id/range-diff/rebase) pass no options ⇒ never get it; off-node ⇒ inert content-sniff (mirrors #195); (b) ride `applyTextconv` for the content-stable boundary **but decouple the runner guard** — build the provider for the override whenever the display opt-in is set, even with no `CommandRunner`, so `-diff`/bare-`diff` are honoured off-node (only textconv stays runner-gated); (c) a **separate** `materialisePatchFiles` option `resolveBinaryAttr?: boolean` decoupled from textconv | **(a)** — simplest; the binary override and textconv are two halves of the **same** `diff` resolution, so gating them together reuses the one provider/lookup (§3.2), makes the content-stable boundary automatic, and keeps cross-adapter parity (memory ≡ node-with-no-runner) trivially true. (b) is **strictly more faithful off-node** (honours `-diff`/`diff` in the browser) at the cost of building the provider off-node and breaking the simple memory≡no-runner parity — surface to the user alongside §3.2's conservatism note. (c) duplicates the provider build. |
| **D-ADR** | ADR set for the ADR phase | (a) **one** ADR — "diff binary-vs-text display override threaded from the application layer, mirroring #195's textconv ADR-407" — deciding D-SHAPE + D-OPTIN + the §3.3 mapping including the D-NAMED resolution; (b) **two** ADRs — one for the threading mechanism (D-SHAPE/D-OPTIN), one for the named-driver numstat asymmetry (D-NAMED) given its divergence stakes; (c) fold into a #195 follow-up ADR amendment | **(a)** — one ADR, next free number **409** (highest existing is 408). The mechanism is a direct mirror of ADR-407's threading; the only genuinely contentious sub-decision is D-NAMED, which the single ADR records as its consequential edge. Propose **ADR-409** title: *"diff binary-decision override threaded from the application layer"*. If the user wants D-NAMED isolated, split to **ADR-409** (threading) + **ADR-410** (named-driver numstat faithfulness). |

## 5. Test strategy

Mirrors #195's test plan (`lfs-filter-driver-port.md §5`) and the diff-faithfulness
interop discipline.

**Unit (domain — pure, no Context):**
- `stat-fields.test.ts` — `computeStatFields` with each override: `'binary'` ⇒
  `{0,0,true}` over textual content (isolated guard, assert all three fields);
  `'text'` ⇒ counts lines over NUL content (the short-circuit is skipped); `undefined`
  ⇒ today's `isBinary` short-circuit (regression). Isolated per-branch tests
  (mutation-resistant: the `isBinary(old) || isBinary(next)` guard needs each side
  triggered alone, per CLAUDE.md guard-clause rule).
- `patch-serializer.test.ts` — `renderPatch`/`renderFile` with `PatchFile.binaryOverride`
  at each of the 6 decision functions (modify same-kind, two-path rename/copy,
  broken-modify, type-change delete+add — both sides, add, delete): `'binary'` forces the
  `Binary files … differ` branch over textual content; `'text'` forces the text-hunk
  branch over NUL content (NUL survives in the rendered bytes); `undefined` ⇒ today.
  Assert exact rendered bytes (not just "contains Binary").

**Property (per CLAUDE.md lens — compositional matcher):** `resolve-binary-override`
is a total function over the `AttributeValue` algebra (4 inputs → 3 outputs). A small
**parameterised example sweep** (not fast-check) covers it — the input is a 4-value
enum, so property generators add no value (CLAUDE.md "small enum ⇒ parameterised sweep").

**Unit (application):**
- `resolve-binary-override.test.ts` — every §3.3 row: `false`/`binary`-macro ⇒
  `'binary'`; `true` ⇒ `'text'`; `{set:name}` ⇒ patch `'text'` / numstat per D-NAMED;
  `'unspecified'` ⇒ `undefined`. Reuse a fake `AttributeProvider`. Isolated per-branch.
- `materialise-patch-files.test.ts` — the override is attached to `PatchFile` only when
  `applyTextconv: true` (R4): assert content-stable call (no options) yields
  `binaryOverride === undefined` on every file; assert the override and textconv come
  from **one** `sourcesForPath` call (spy the provider — called once per path).
- `diff-trees.test.ts` — `applyLinePassAndStat` threads `PatchFile.binaryOverride` into
  `computeStatFields`; `shouldDrop` consistency (a `'text'`-forced path with zero real
  hunks still drops correctly; a `'binary'`-forced path never drops — `stats.binary`).
- `ctx.command` absent ⇒ override `undefined` everywhere (R7 inert fallback).

**Interop (real git — the only faithfulness proof):**
- **`test/integration/diff-attr-binary-interop.test.ts`** (new; twin real-`git` vs
  tsgit; `describe.skipIf(!GIT_AVAILABLE)`; one shared `beforeAll` repo; 60s timeout
  per the interop load→validate flake note; full isolation discipline): pin **B1/Bn**
  (`-diff` textual ⇒ binary patch + `-\t-` numstat), **Ba/Bd** (add/delete one-sided
  binary lines), **Bmacro** (binary macro), **T2/T2n** (bare `diff` over NUL ⇒ text
  hunk with NUL verbatim + `1\t1`), **N1** (`diff=name` clean text — #195 cross-check),
  **N3/N3s** (the named-driver patch/numstat asymmetry — the D-NAMED rows; assert per
  the chosen D-NAMED option), **N4** (named-unconfigured fallback), **R** (raw OIDs
  unchanged). Reconstruct git's patch via the shared `diff-reconstruct.ts`
  `reconstructPatch` helper; reconstruct numstat via the existing `numstatRowsFrom`
  shape (it already reads `c.binary`).
- **`diff-textconv-interop.test.ts` stays green** — its T-BIN case (binary macro over
  **NUL** content, attribute and content agree) is the regression boundary that proves
  the override does not break the agree-case; add an assertion there if the override
  changes the code path it exercises.

GWT/AAA, `sut`, 100% coverage, 0 killable mutants; error assertions specific
(value + the override enum, not `toThrow(Class)`); no `isBinary` short-circuit guard
left untested per-side.

## 6. Out of scope (state explicitly)

- **IN:** the `diff`/`binary` attribute's effect on the binary-vs-text **display**
  decision in diff + numstat (patch `Binary files … differ` line, numstat `-\t-`
  short-circuit), and its correct composition with #195's textconv.
- **`text` / `eol` / `autocrlf` / `working-tree-encoding`** line-ending normalisation —
  still parked exactly as `lfs-filter-driver-port.md §6` parks it. tsgit has zero
  line-ending transformation today; this feature lifts only the **binary** part of the
  `text`/`eol`/`binary` parking note, not the eol part.
- **`--stat` cosmetic graph** (`Bin 0 -> N bytes`, bar widths) — the caller renders it
  from the structured `binary` boolean + blob sizes (ADR-249); the library emits no
  `--stat` text. `--stat`'s binary decision tracks numstat's `binary` field, so it
  follows D-NAMED automatically.
- **`diff=name` numstat raw-vs-transformed faithfulness (N3s)** — if D-NAMED picks
  option (a), the NUL-stripping-textconv numstat edge is a documented divergence, not a
  v1 surface. Option (b) brings it in scope.
- **`grep`/`blame`/`merge` binary decisions** — other commands also consult `isBinary`;
  this feature touches only the **diff/numstat** display path. Other consumers of the
  attribute are separate features.
- **Public API surface** — confirmed **no api.json delta**: the threading parameter
  lives on internal functions (`computeStatFields`, `renderPatch`, `PatchFile`,
  `StatFieldsOptions`) that are **not** re-exported through `src/index.ts` (verified:
  absent from `application/commands/index.ts` and `public-types.ts`). The public
  `StatFields.binary` boolean already exists — this feature changes its **computation**,
  adds no field. If D-SHAPE (c) or a public command option were chosen instead, that
  would be flagged as an api.json-touching decision — it is not, under the recommended
  shape.
