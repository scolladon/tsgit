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
> Status: draft → self-reviewed ×3 → decision candidates → **ratified by [ADR-409](../adr/409-diff-binary-decision-override-threaded-from-application-layer.md) + [ADR-410](../adr/410-binary-attribute-override-honoured-off-node.md)** (§4 is the resolved decision trail).

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
| Performance / regression boundary | The default path (no `diff`/`binary` attribute) must be **byte- and cost-identical** to today: a path with no attribute resolves to `unspecified` ⇒ both overrides `undefined` ⇒ every domain function falls back to today's `isBinary` content-sniff. Content-stable callers (no `applyTextconv` opt-in) build no provider at all (ADR-410). |

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
  (pinned §3.4 rows N3/N3s). tsgit reproduces this raw-blob numstat decision faithfully —
  the application layer holds the raw bytes and threads the decision down (ratified
  **D-NAMED = (b)**, ADR-409); N3s is faithful, not a divergence.
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
| Diff content chokepoint | `primitives/materialise-patch-files.ts` `materialisePatchFiles(ctx, changes, { applyTextconv })` → `PatchFile{change, oldContent?, newContent?, patchBinaryOverride?, numstatBinaryOverride?}` | **Hook point.** The single place #195 resolves the provider + `diff` attribute per path and transforms content. **Both** binary overrides are resolved here in the **same** `maybeTextconv` per-path pass and attached to the `PatchFile`; the numstat side is `isBinary(raw)` over the raw bytes still in hand before textconv replaces them (§3.2; resolved D-SHAPE (c) / D-NAMED (b), ADR-409). |
| Numstat + drop chokepoint | `primitives/diff-trees.ts` `applyLinePassAndStat` (l.99–110): `materialisePatchFiles(ctx, diff.changes, { applyTextconv: true })` then `computeStatFields(file.oldContent, file.newContent, statOptionsFor(…))` per file | **Single numstat call site.** The `numstatBinaryOverride` attached to each `PatchFile` (§3.2) feeds `computeStatFields` here. `shouldDrop` (whitespace drop) reads `stats.binary` — the override must reach it consistently. |
| Patch reconstruction (interop) | `test/integration/diff-reconstruct.ts` `reconstructPatch(ctx, treeDiff, opts?)` = `renderPatch(materialisePatchFiles(ctx, changes, { applyTextconv: true }), opts)` | **The display reconstructor (ADR-249).** Once `PatchFile` carries `patchBinaryOverride` and `renderPatch` honours it, the interop test reconstructs git's binary/text choice from the structured data. |
| Content-stable callers (must NOT get the override) | `primitives/patch-id.ts` l.59–60, `commands/range-diff.ts` l.74, `commands/rebase.ts` l.301 — all call `materialisePatchFiles(ctx, changes)` **without** `applyTextconv` | **Boundary.** These need content-stable raw bytes (patch-id stability, rebase `.git/rebase-merge/patch`). They must **not** receive either override — both ride the **same opt-in** as textconv (`applyTextconv: true`), so they are absent on these paths by construction (§3.2, R4). The opt-in (not the runner) is the boundary (ADR-410). |

`isBinary` is also exported through the domain diff barrel and used by `patch-id.ts`
(content-stable) — **unchanged**; the override never touches `isBinary` itself, only
who calls it and whether a caller short-circuits it.

### 1.3 Constraining decisions (FIXED — not re-litigated)

| Source | Decision this design must honour |
|---|---|
| ADR-302 | `.gitattributes` source model, precedence, macros, `AttributeValue` four-state — reuse verbatim. The `binary` macro is `-diff -merge -text`. |
| ADR-406 / ADR-407 / ADR-408 (#195) | The active-driver port: `diff=<name>` textconv resolution + the `AttributeProvider` build in `materialisePatchFiles`. This feature **composes with** that resolution, reusing the same provider; it does **not** re-open it. **[ADR-410](../adr/410-binary-attribute-override-honoured-off-node.md) refines ADR-408**: the provider build is decoupled from the runner guard (built whenever `applyTextconv: true`, regardless of `ctx.command`); only textconv *execution* stays runner-gated. ADR-408's inert fallback still covers the spawning textconv driver. |
| ADR-249 | Library emits structured data; display (`Binary files … differ`, `-\t-`) is reconstructed in the interop test. The `binary` boolean already exists on `StatFields`; this feature changes its computation, adds no field. |
| ADR-398 | The no-driver / no-attribute baseline (content-sniff) is the faithful target and the regression boundary the override must not silently cross. |
| **[ADR-409](../adr/409-diff-binary-decision-override-threaded-from-application-layer.md)** (this feature) | The override is **per-surface** (patch decision and numstat decision carried independently on `PatchFile`; `computeStatFields` options carry the numstat override). The named-driver **numstat** decision is taken on the **RAW** blob in the application layer (which holds both raw and transformed bytes at the single resolve point) and passed down as a resolved enum — **fully faithful**, no divergence. |
| **[ADR-410](../adr/410-binary-attribute-override-honoured-off-node.md)** (this feature) | The provider build is decoupled from `ctx.command`; `-diff` / bare `diff` / the raw-numstat decision are honoured off-node (memory/browser) too. The content-stable boundary stays the `applyTextconv` opt-in. |

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
   bytes (#195's behaviour, unchanged); the **numstat** binary decision is taken on the
   **RAW** (pre-textconv) blob, exactly like git (`diff_filespec_is_binary` sniffs the
   raw blob) — **fully faithful** across clean-text, NUL-keeping, and NUL-stripping
   textconv (§3.4 rows N3 **and N3s**, ratified **D-NAMED = (b)** per ADR-409).
4. A path with **`diff=<name>`** and **no** `[diff "<name>"].textconv` (or empty)
   falls back to the **raw content-sniff** on both surfaces — a text hunk + line
   counts over clean content, `Binary files … differ` + `-\t-` over NUL content —
   byte-identical to git (§3.4 row N4): no override applied (raw == content), composing
   with #195's T2 fallback.
5. The override resolution rides the **same opt-in** as #195's textconv
   (`applyTextconv: true`): the display paths (`diff`/`show`/`log -p`, numstat) get
   it; the **content-stable** paths (patch-id, range-diff, rebase patch file) do
   **not** — their binary decision stays the pure content-sniff (R4-boundary, §3.2).
6. The structured `TreeDiff.changes` membership, change `type`, and `--raw`/`index`-line
   **OIDs** are the **raw tree** values — the override affects only the
   patch-binary-branch + numstat `binary`, never OIDs (§3.4 row R).
7. **`-diff` / bare `diff` (and the raw-blob numstat decision) are honoured off-node**
   (memory / browser / node-without-runner), byte-identical to node-with-a-runner and
   to real git: the provider build is **decoupled** from `ctx.command` (built whenever
   `applyTextconv: true`), and only textconv *execution* stays runner-gated (ratified
   **D-OPTIN = (b)** per ADR-410). The `diff=<name>` textconv driver still no-ops
   off-node (ADR-408, refined), and the override then applies faithfully to the raw
   bytes it leaves behind.
8. **Default path (no `diff`/`binary` attribute) is byte- and cost-identical to today:**
   both overrides are `undefined`, every domain site calls `isBinary` exactly as before,
   no attribute is read (§3.3). Content-stable callers (no opt-in) build no provider at
   all.
9. Every pinned row (§3.4) is a cross-tool `*-interop` test; the existing
   `diff-textconv-interop.test.ts` T-BIN case (binary macro over **NUL** content,
   where attribute and content agree) stays green.

## 3. Design

### 3.1 Shape: per-surface overrides threaded from the application layer (ratified D-SHAPE = (c), ADR-409)

The domain stays pure. Because git's two diff surfaces **genuinely disagree** for named
drivers (the patch follows the textconv output, the numstat follows the raw blob — §3.4
N3/N3s), the patch decision and the numstat decision each carry their **own** optional
override. Both are resolved **once per changed path** in the application layer and
threaded into the two domain decision surfaces independently:

```
domain/diff/                              (pure — gains optional parameters only)
  line-diff.ts        isBinary(bytes)                    UNCHANGED (the fallback)
  stat-fields.ts      computeStatFields(old, next, options?)
                        options gains  numstatBinaryOverride?: 'binary' | 'text'
                        'binary' ⇒ { added:0, deleted:0, binary:true }
                        'text'   ⇒ skip the isBinary short-circuit, count lines
                        undefined⇒ today's `isBinary(old) || isBinary(next)`
  patch-serializer.ts PatchFile gains  patchBinaryOverride?: 'binary' | 'text'
                        each of the 6 isBinary call sites consults the PATCH override first

application/primitives/
  resolve-binary-override.ts   NEW — (provider, path) → { patch, numstat } each 'binary' | 'text' | undefined
                               over resolveAttribute(…, 'diff', …); sibling of resolve-textconv-driver.
                               For a configured named driver the numstat side is isBinary(raw) (the raw
                               blob the app layer already holds), computed BEFORE textconv transforms it
  materialise-patch-files.ts   resolves both overrides in the SAME per-path pass that
                               resolves textconv (reuse the one provider), attaches them to PatchFile
  diff-trees.ts                applyLinePassAndStat feeds PatchFile.numstatBinaryOverride into computeStatFields
```

**Why two fields, not one.** A single tri-state field (the pre-ADR recommendation)
cannot express the per-surface disagreement: for `diff=<name>` + configured textconv over
NUL-keeping content git wants `patch = text` but `numstat = binary` (raw-blob decision).
ADR-409 ratified **(c) per-surface override**; `PatchFile` carries both, the 6 patch-serializer
sites read `patchBinaryOverride`, and `computeStatFields` reads `numstatBinaryOverride`.

**Dependency rule** honoured exactly as #195: `domain/diff` gains plain optional
enum parameters (no `Context`, no provider, **no raw bytes** — the numstat raw-blob
decision is collapsed to an enum *in the application layer*, which holds both raw and
transformed bytes at the single resolve point); the application layer computes both
overrides from the attribute provider; ports/adapters untouched. This mirrors how #195
fed *transformed content* into the same domain functions — here we feed a *decision*
instead of content, because the binary decision (unlike textconv) is not expressible as
a byte transform (`-diff` over textual content cannot be made "look binary" by
transforming bytes; it is a pure display-mode flag).

Two precision points:

- **Each override short-circuits BOTH `isBinary` sub-signals** (the NUL window scan
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

`materialisePatchFiles` (`materialise-patch-files.ts`) already, under the display opt-in,
builds a lazily-memoised `AttributeProvider`
(`getProvider: () => (providerPromise ??= buildAttributeProvider(ctx))`) and, in
`maybeTextconv`, calls `provider.sourcesForPath(filePath)` → `resolveTextconvDriver`. Both
binary overrides are resolved in the **same** per-path pass:

1. `maybeTextconv` (or a renamed `maybePerPathDiffAttr`) already holds the resolved
   `diff` attribute value for the path via `resolveAttribute(sources, path, 'diff', macros)`
   (today only inside `resolveTextconvDriver`). Expose that one lookup so **both** the
   textconv choice **and** the binary overrides are derived from **one**
   `sourcesForPath(path)` call — no second provider, no second resolve.
2. The resolved overrides are attached to the returned `PatchFile`
   (`{ change, oldContent?, newContent?, patchBinaryOverride?, numstatBinaryOverride? }`).
   For a configured named driver the numstat side is `isBinary(raw)` over the raw blob —
   computed here, where the raw bytes are still in hand, *before* textconv replaces
   `{old,new}Content` with the transformed bytes.
3. Everything downstream reads them: `renderPatch`/`renderFile` consult `patchBinaryOverride`
   (patch text), and `applyLinePassAndStat` → `computeStatFields` consult
   `numstatBinaryOverride` (numstat + the whitespace `shouldDrop`).

**Riding the opt-in (R4 boundary).** Both overrides are computed **only** when
`options.applyTextconv === true` (the display opt-in) — the same condition that gates
textconv. The content-stable callers (`patch-id.ts`, `range-diff.ts`, `rebase.ts`)
call `materialisePatchFiles(ctx, changes)` with **no** opt-in, so **no provider is built
at all** and both overrides are `undefined` on every `PatchFile` they get;
`renderPatch`/any stat there sees the pure content-sniff — patch-id and rebase patch
bytes are unchanged. The content-stable boundary **is** the opt-in flag (not the runner);
this is exactly why the override is **not** a separate `materialisePatchFiles` option —
coupling it to `applyTextconv` makes the content-stable boundary automatic and impossible
to mis-wire.

**Off-node: the runner guard is decoupled (ratified D-OPTIN = (b), ADR-410).** The
provider build is gated on the **display opt-in only** (`applyTextconv: true`),
**not** on `ctx.command`. The `AttributeProvider` needs only the `FileSystem` port —
available on every adapter — so it is built and the binary overrides are resolved
**in-process on memory / browser / node-without-runner alike**. `-diff`, bare `diff`,
and the raw-blob numstat decision spawn **nothing**, so they are git-faithful off-node:
a `*.bin -diff` textual file shows `Binary files … differ` in the browser exactly as on
node. **Only textconv *driver execution* stays runner-gated** — a `diff=<name>` textconv
driver still no-ops off-node (ADR-407/408 unchanged for the spawning part), leaving raw
bytes to which the ADR-409 override then applies faithfully.

This **refines ADR-408's inert fallback** rather than contradicting it: the inert
fallback still scopes to the **spawning textconv driver**; the pure binary override is
intentionally **live** off-node. The cross-adapter parity claim is correspondingly
refined — memory ≡ node-without-runner still agree with **each other**, and now **both
match real git** for the override (all honour `-diff`/bare `diff` identically), rather
than all falling back to content-sniff. Cost is a single `.gitattributes` read on the
off-node display path where #195 skipped it — bounded by the same opt-in (display paths
only) and the same single lazily-memoised provider build.

### 3.3 Attribute → override mapping (the crux — pinned §3.4)

`resolve-binary-override.ts` maps the resolved `diff` `AttributeValue` to a **per-surface**
override pair `{ patch, numstat }`. This is the **ratified ADR-409 mapping** — the named-driver
**numstat** side is the **RAW-blob** decision (`isBinary(raw)`) computed in the application
layer, exactly like git, so there is **no divergence** (N3 *and* N3s are faithful):

| resolved `diff` value | patch override | numstat override | git behaviour pinned |
|---|---|---|---|
| `false` (`-diff`, incl. `binary` macro) | **`'binary'`** | **`'binary'`** | force binary both surfaces (§3.4 B1/Bn) |
| `true` (bare `diff`) | **`'text'`** | **`'text'`** | force text both surfaces (§3.4 T2/T2n) |
| `{ set: 'name' }`, `textconv` configured | **`'text'`** (textconv output feeds a text hunk even when NUL-retaining) | **`isBinary(raw) ? 'binary' : 'text'`** — the **RAW-blob** decision | patch=text via textconv; numstat tracks the raw blob exactly like git (§3.4 N3 **and N3s**) |
| `{ set: 'name' }`, no/empty `textconv` | **`undefined`** (raw == content; content-sniff: text hunk over clean, `Binary files` over NUL) | **`undefined`** (raw == content; content-sniff already sees raw) | patch + numstat both content-sniff the raw fallback (§3.4 N4) |
| `'unspecified'` (no rule) | **`undefined`** | **`undefined`** | content-sniff — today's behaviour |

The named-configured rows are where the two surfaces **genuinely disagree** and the reason
ADR-409 ratified **D-NAMED = (b)** (sniff the raw blob) and the **per-surface** D-SHAPE = (c).
Two observations make the implementation tractable:

- **Patch side.** When a `textconv` is configured, #195 already replaces
  `PatchFile.{old,new}Content` with the transformed bytes; if they are clean text,
  `renderPatch`'s existing `isBinary` already chooses the text branch. The explicit `'text'`
  patch override is needed for the case where the transformed bytes **still contain NUL** yet
  git shows a text hunk anyway (§3.4 N3, the `tr a-z A-Z`-keeps-NUL case). Forcing `'text'`
  unconditionally for a configured named driver is faithful and simpler than re-deriving the
  sub-case, so the mapping always emits patch `'text'` for configured named drivers.
- **Numstat side — the RAW-blob decision (the crux, now FAITHFUL).** git's
  `diff_filespec_is_binary` sniffs the **raw** blob regardless of any userdiff name/textconv.
  The application layer holds **both** the raw and the transformed bytes at the single resolve
  point, so it computes `isBinary(raw)` there and threads the resulting enum down. This is
  faithful for **all** named-driver cases — clean text (N1 ⇒ raw clean ⇒ `'text'` ⇒ `n\tm`),
  NUL-keeping textconv (N3 ⇒ raw has NUL ⇒ `'binary'` ⇒ `-\t-`), **and NUL-stripping textconv
  (N3s ⇒ raw has NUL ⇒ `'binary'` ⇒ `-\t-`)**. The N3s row that the earlier draft parked as a
  documented divergence is now **resolved**: passing the raw-blob decision (not sniffing the
  transformed bytes #195 hands the domain) makes numstat match git on every named-driver path.
  No raw bytes cross into the pure domain — only the resolved enum does.

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

#### `diff=<name>` named driver — patch/numstat ASYMMETRY (ratified **D-NAMED = (b)**, numstat sniffs the RAW blob — faithful)

| # | Setup | `git` result | Load-bearing fact |
|---|---|---|---|
| **N1** | `f diff=up`, `diff.up.textconv=<uppercase>`; **clean text** `hello\nkeep` → `world\nkeep`; **default** `git diff` (no `--textconv` flag) | text hunk `-HELLO` / `+WORLD` / ` KEEP`; numstat `1\t1` | a configured `diff=name` runs textconv on **default** `git diff` (the `--textconv` flag is irrelevant when the attribute names a driver). Patch + numstat both text. (#195 territory — unchanged.) |
| **N3** | `f diff=up`, `diff.up.textconv=<uppercase, keeps NUL>`; **NUL content** `hello\0nul\nkeep` → `world\0nul\nkeep`; default `git diff` | **patch**: text hunk `-HELLO\0NUL` / `+WORLD\0NUL` (textconv ran, NUL retained, **text hunk shown**); **numstat**: **`-\t-`**; **`--stat`**: `Bin 0 -> N bytes` | **THE ASYMMETRY.** Named driver ⇒ patch is a text hunk (textconv output) **even with NUL retained**, but numstat/`--stat` show **binary** (`diff_filespec_is_binary` sniffs the **raw** blob; a userdiff name does not clear it for numstat). |
| **N3s** | as N3 but textconv **strips NUL** (`tr -d '\0' \| tr a-z A-Z`) | **patch**: text hunk `-HELLOX` / `+WORLDX` (clean); **numstat**: **`-\t-`** (still binary!) | numstat is **`-\t-`** regardless of whether the textconv output has NUL — it is decided on the **raw** blob, not the transformed bytes. tsgit threads `isBinary(raw)` from the app layer (ratified D-NAMED (b)) ⇒ **`-\t-`** ⇒ **FAITHFUL** (no longer a divergence). |
| **N4** | `f diff=unk` with **no** `[diff "unk"]` section; **NUL content** modify | **patch**: `Binary files … differ`; numstat `-\t-` | a named-but-**unconfigured** driver over NUL ⇒ patch falls back to the raw content-sniff (NUL ⇒ binary). Compose with #195 T2 (raw fallback). (Over **clean** content, N4 would show a raw text hunk — #195 T2.) |

#### Structured-data invariance (ADR-249)

| # | Setup | `git` result | Load-bearing fact |
|---|---|---|---|
| **R** | any of B1/T2/N3 | `git diff --raw --abbrev=40` shows the **raw tree OIDs** unchanged (`:100644 100644 f0e9ea9… 703f9bc… M f`) | the `diff` attribute (binary override or textconv) never enters `--raw`/`--name-status`/`index`-line OIDs — structured data is raw (ADR-249). |

**Divergence summary (today vs git), the bugs this fixes:**

| Case | git | tsgit today | After |
|---|---|---|---|
| `-diff`, textual content | `Binary files differ` / `-\t-` | text hunk / `n\tm` (sniffs content=text) | binary (patch+numstat override `'binary'`) — **faithful** |
| bare `diff`, NUL content | text hunk / `1\t1` | `Binary files differ` / `-\t-` (sniffs content=binary) | text (patch+numstat override `'text'`) — **faithful** |
| `diff=name` (NUL-keeping textconv), patch | text hunk | `Binary files differ` (sniffs transformed=NUL) | text hunk (patch override `'text'`) — **faithful** |
| `diff=name` (NUL-keeping textconv), numstat | `-\t-` (raw sniff) | `-\t-` (sniffs transformed=NUL) | `-\t-` (numstat override `isBinary(raw)='binary'`) — **faithful** |
| `diff=name` (NUL-**stripping** textconv), numstat | `-\t-` (raw sniff) | `n\tm` (sniffs transformed=clean) | `-\t-` (numstat override `isBinary(raw)='binary'`) — **RESOLVED, faithful** (ratified D-NAMED (b)) |

### 3.5 Precedence / composition with #195 textconv (unambiguous)

Stated as the binding contract the application layer implements:

- **`-diff`** (incl. `binary` macro) ⇒ binary display both surfaces; **no textconv**
  (#195's `resolveTextconvDriver` already returns `none` for `diff:false`).
- **bare `diff`** ⇒ text display both surfaces; **no textconv** (no named driver;
  #195 returns `none` for `diff:true`).
- **`diff=name` + configured `textconv`** ⇒ patch override `'text'` (over the transformed
  bytes, forced text even when NUL-retaining — N3); numstat override is the **raw-blob**
  decision `isBinary(raw) ? 'binary' : 'text'`, computed in the app layer (ratified
  D-NAMED (b)) — faithful for N3 and N3s.
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

## 4. Decision trail — RESOLVED by the ADR conversation

> This section is the resolved decision trail. The candidates below were taken to the ADR
> conversation; the user **ratified** the outcomes recorded in
> [ADR-409](../adr/409-diff-binary-decision-override-threaded-from-application-layer.md) and
> [ADR-410](../adr/410-binary-attribute-override-honoured-off-node.md). Each row records the
> alternatives weighed and the ratified choice — which in two cases **deviates** from the
> draft's recommendation (D-SHAPE, D-NAMED) toward fuller faithfulness.

ADRs 226/249/302/406/407/408 fix faithfulness, structured-data, the attribute model,
and #195's textconv port. The load-bearing choices **this** feature introduced:

| # | Choice | Alternatives weighed (≤3) | **Ratified outcome** |
|---|---|---|---|
| **D-SHAPE** | The override type threaded into `computeStatFields` + `PatchFile` | (a) **one** optional tri-state `binaryOverride?: 'binary' \| 'text'` on both `StatFieldsOptions` and `PatchFile`; (b) a **boolean** `forceBinary?` (loses the `'text'`-force-over-NUL case); (c) **per-surface** overrides (patch vs numstat carried independently) | **RESOLVED → (c) per-surface override** ([ADR-409](../adr/409-diff-binary-decision-override-threaded-from-application-layer.md)). Forced by D-NAMED (b): git's two surfaces genuinely disagree for named drivers, so `PatchFile` carries **both** `patchBinaryOverride` and `numstatBinaryOverride`; the 6 patch-serializer sites read the patch override, `computeStatFields` reads the numstat override. (a) cannot express the disagreement; (b) cannot force text over NUL. **Deviates from the draft recommendation of (a).** |
| **D-NAMED** | How `diff=<name>` maps to the **numstat** binary decision, given the pinned raw-vs-transformed asymmetry (N3/N3s) | (a) **sniff the transformed bytes** (no change to the numstat path) — faithful for clean text + NUL-keeping textconv, **diverges** only for NUL-stripping textconv (N3s); (b) **sniff the RAW blob** — faithful for **every** named-driver case; (c) **force `'binary'`** for any `diff=name` — diverges over clean text (N1) | **RESOLVED → (b) sniff the RAW blob** ([ADR-409](../adr/409-diff-binary-decision-override-threaded-from-application-layer.md)). The application layer holds both raw and transformed bytes at the single resolve point; it computes `isBinary(raw)` and threads the resulting enum down — **no raw bytes enter the pure domain**. Faithful across clean-text (N1), NUL-keeping (N3), **and NUL-stripping (N3s)** textconv. **N3s is now faithful, not a divergence.** **Deviates from the draft recommendation of (a)** — the prime directive (ADR-226) forbids divergence absent a documented exception, and the user declined to carve one. |
| **D-OPTIN** | How the override is gated so (i) content-stable callers never get it, and (ii) the off-node guard is set | (a) **runner-gated** — ride #195's `applyTextconv: true && ctx.command !== undefined` (off-node ⇒ inert content-sniff, mirrors #195; a narrow off-node divergence); (b) **decouple the runner guard** — build the provider whenever the display opt-in is set, keep only textconv *execution* runner-gated, so `-diff`/bare `diff` are honoured off-node; (c) a **separate** `resolveBinaryAttr?` option | **RESOLVED → (b) decouple the runner guard** ([ADR-410](../adr/410-binary-attribute-override-honoured-off-node.md)). The provider needs only `FileSystem`; `-diff`/bare `diff`/the raw-numstat decision are pure and honoured on node, in-memory, and browser alike. The content-stable boundary stays the `applyTextconv` opt-in (R4 preserved); only textconv *execution* stays runner-gated (ADR-408 refined, scoped to the spawning driver). **Matches draft option (b), deviating from the draft recommendation of (a).** |
| **D-ADR** | ADR set for the ADR phase | (a) **one** ADR deciding D-SHAPE + D-OPTIN + the §3.3 mapping; (b) **two** ADRs — one for threading (D-SHAPE/D-NAMED), one for the off-node gating (D-OPTIN); (c) fold into a #195 follow-up amendment | **RESOLVED → (b) two ADRs**: [ADR-409](../adr/409-diff-binary-decision-override-threaded-from-application-layer.md) (per-surface override + raw-blob numstat threading — D-SHAPE/D-NAMED) and [ADR-410](../adr/410-binary-attribute-override-honoured-off-node.md) (off-node decoupling — D-OPTIN). Split because the off-node faithfulness decision (refining ADR-408) is independently load-bearing and deserves its own record. |

## 5. Test strategy

Mirrors #195's test plan (`lfs-filter-driver-port.md §5`) and the diff-faithfulness
interop discipline.

**Unit (domain — pure, no Context):**
- `stat-fields.test.ts` — `computeStatFields` with each `numstatBinaryOverride`: `'binary'` ⇒
  `{0,0,true}` over textual content (isolated guard, assert all three fields);
  `'text'` ⇒ counts lines over NUL content (the short-circuit is skipped); `undefined`
  ⇒ today's `isBinary` short-circuit (regression). Isolated per-branch tests
  (mutation-resistant: the `isBinary(old) || isBinary(next)` guard needs each side
  triggered alone, per CLAUDE.md guard-clause rule).
- `patch-serializer.test.ts` — `renderPatch`/`renderFile` with `PatchFile.patchBinaryOverride`
  at each of the 6 decision functions (modify same-kind, two-path rename/copy,
  broken-modify, type-change delete+add — both sides, add, delete): `'binary'` forces the
  `Binary files … differ` branch over textual content; `'text'` forces the text-hunk
  branch over NUL content (NUL survives in the rendered bytes); `undefined` ⇒ today.
  Assert exact rendered bytes (not just "contains Binary"). The patch sites read the
  **patch** override only — a test fixes `patchBinaryOverride='text'` alongside
  `numstatBinaryOverride='binary'` (the N3 shape) and asserts the patch renders a text hunk
  while the numstat field is untouched (proves the two surfaces are independent).

**Property (per CLAUDE.md lens — compositional matcher):** `resolve-binary-override`
is a total function over the `AttributeValue` algebra (4 inputs → a `{patch,numstat}` pair).
A small **parameterised example sweep** (not fast-check) covers it — the input is a 4-value
enum, so property generators add no value (CLAUDE.md "small enum ⇒ parameterised sweep").

**Unit (application):**
- `resolve-binary-override.test.ts` — every §3.3 row, asserting the **pair**: `false`/`binary`-macro
  ⇒ `{patch:'binary', numstat:'binary'}`; `true` ⇒ `{patch:'text', numstat:'text'}`;
  `{set:name}` + configured textconv ⇒ `{patch:'text', numstat: isBinary(raw)?'binary':'text'}`
  — the **raw-blob** numstat path: a NUL-stripping-textconv fixture (clean transformed bytes,
  NUL **raw** blob) must yield `numstat:'binary'` (the N3s kill); `{set:name}` no textconv ⇒
  `{undefined, undefined}`; `'unspecified'` ⇒ `{undefined, undefined}`. Reuse a fake
  `AttributeProvider`. Isolated per-branch.
- `materialise-patch-files.test.ts` — both overrides are attached to `PatchFile` only when
  `applyTextconv: true` (R4): assert a content-stable call (no opt-in) builds **no provider**
  and yields `patchBinaryOverride === undefined && numstatBinaryOverride === undefined` on every
  file; assert the overrides and textconv come from **one** `sourcesForPath` call (spy the
  provider — called once per path); assert the numstat override is computed from the **raw**
  bytes *before* textconv replaces `{old,new}Content`.
- `diff-trees.test.ts` — `applyLinePassAndStat` threads `PatchFile.numstatBinaryOverride` into
  `computeStatFields`; `shouldDrop` consistency (a `'text'`-forced path with zero real
  hunks still drops correctly; a `'binary'`-forced path never drops — `stats.binary`).

**Cross-adapter (the decoupled guard — ADR-410):**
- `-diff` / bare `diff` are honoured **off-node** with no `CommandRunner`: a memory- (and
  browser-, in the e2e suite) adapter repo with `f -diff` over textual content renders the
  binary patch + `-\t-` numstat — identical to node-without-runner **and** to real git,
  **not** the content-sniff fallback. This is the live assertion that the provider is built on
  the opt-in, not the runner.
- A `diff=<name>` textconv driver still no-ops off-node (ADR-408 refined): the override applies
  to the raw bytes the inert driver leaves behind, so the numstat raw-blob decision is still
  faithful with no runner.

**Interop (real git — the only faithfulness proof):**
- **`test/integration/diff-attr-binary-interop.test.ts`** (new; twin real-`git` vs
  tsgit; `describe.skipIf(!GIT_AVAILABLE)`; one shared `beforeAll` repo; 60s timeout
  per the interop load→validate flake note; full isolation discipline): pin **B1/Bn**
  (`-diff` textual ⇒ binary patch + `-\t-` numstat), **Ba/Bd** (add/delete one-sided
  binary lines), **Bmacro** (binary macro), **T2/T2n** (bare `diff` over NUL ⇒ text
  hunk with NUL verbatim + `1\t1`), **N1** (`diff=name` clean text — #195 cross-check),
  **N3** (NUL-keeping textconv ⇒ patch text hunk + numstat `-\t-`), **N3s** (NUL-stripping
  textconv ⇒ patch clean text hunk + numstat **`-\t-`** — assert the **faithful** raw-blob
  numstat, the ratified D-NAMED (b) row), **N4** (named-unconfigured fallback), **R** (raw OIDs
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
- **IN:** the `diff=name` numstat **raw-vs-transformed** faithfulness (N3s) — now in scope
  and **faithful** via the ratified raw-blob decision (D-NAMED (b), ADR-409). No longer a v1
  divergence.
- **IN:** `-diff` / bare `diff` honoured **off-node** (memory/browser) via the decoupled
  runner guard (D-OPTIN (b), ADR-410).
- **`text` / `eol` / `autocrlf` / `working-tree-encoding`** line-ending normalisation —
  still parked exactly as `lfs-filter-driver-port.md §6` parks it. tsgit has zero
  line-ending transformation today; this feature lifts only the **binary** part of the
  `text`/`eol`/`binary` parking note, not the eol part.
- **`--stat` cosmetic graph** (`Bin 0 -> N bytes`, bar widths) — the caller renders it
  from the structured `binary` boolean + blob sizes (ADR-249); the library emits no
  `--stat` text. `--stat`'s binary decision tracks numstat's `binary` field, so it
  follows the ratified raw-blob numstat decision (D-NAMED (b)) automatically.
- **`grep`/`blame`/`merge` binary decisions** — other commands also consult `isBinary`;
  this feature touches only the **diff/numstat** display path. Other consumers of the
  attribute are separate features.
- **Public API surface** — confirmed **no api.json delta** even under the ratified
  per-surface D-SHAPE (c): the **two** threading fields live on internal functions /
  types (`computeStatFields` / `StatFieldsOptions` gains `numstatBinaryOverride`;
  `PatchFile` gains `patchBinaryOverride` + `numstatBinaryOverride`; `renderPatch`) that
  are **not** re-exported through `src/index.ts` (verified: absent from
  `application/commands/index.ts` and `public-types.ts`). The public `StatFields.binary`
  boolean already exists — this feature changes its **computation**, adds no field.
