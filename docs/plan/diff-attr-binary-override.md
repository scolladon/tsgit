# Plan — `diff` / `binary` attribute binary-vs-text display override

> Source: design doc `docs/design/diff-attr-binary-override.md` · ADRs `409, 410`
> The plan is the implementation script AND the knowledge handoff. Part agents start
> with zero context: whatever a part block omits is paid later as agent rediscovery.
> Every cited file/symbol/line below was verified on this worktree with Serena.
> `plan-lint.sh` enforces the `## Part N` / `### Context` / `### TDD steps` / `### Gate` /
> `### Commit` schema.

## Sizing rules

- Every part costs a full agent lifecycle (spin-up, zero-context rebuild, gate) — it must
  earn it. No standalone test-only parts for feature code: every unit / interop test folds
  into the part whose code it exercises (TDD: RED test + GREEN code in one part).
- Sequential parts share one working tree and build on landed predecessors. Order:
  domain numstat surface → domain patch surface → application resolver → application wiring
  + off-node decoupling + interop. The two pure-domain leaves (Parts 1, 2) carry no upstream
  dep on each other but both touch the public diff barrel; Parts 3–4 build on them.

## Public-surface decision (decided up front — CORRECTS the design's §6 claim)

The design §6 / ADR-409 assert these threading symbols are **internal, no api.json delta**.
**That is wrong** and the probe proves it: `src/public-types.ts:32` does
`export type * from './domain/diff/index.js'`, so the entire `domain/diff` barrel
(`src/domain/diff/index.ts` — re-exports `PatchFile`, `StatFields`, `StatFieldsOptions`,
`StatDiffChange`) is re-exported through the package entry (`src/index.ts:'export * from
public-types'`). Confirmed in the committed artefact: `reports/api.json` already contains
`PatchFile` (9×), `StatFieldsOptions` (9×), `StatFields` (12×), and the `PatchFile.newContent`
field. Therefore:

- **`StatFieldsOptions` gains `numstatBinaryOverride?` (Part 1) → PUBLIC → api.json delta YES.**
- **`PatchFile` gains `patchBinaryOverride?` + `numstatBinaryOverride?` (Part 2) → PUBLIC →
  api.json delta YES.**
- `StatFields` is unchanged (still `{ added, deleted, binary }`) — its *computation* changes,
  no field added, no delta from `StatFields` itself.
- `resolveBinaryOverride` + its `BinaryOverridePair` type (Part 3): **INTERNAL** — new
  `src/application/primitives/resolve-binary-override.ts`, NOT added to any barrel
  (`src/application/primitives/index.ts`), NOT in `public-types.ts`; imported directly by
  `materialise-patch-files.ts`. Mirrors the `resolve-textconv-driver` precedent exactly
  (confirmed absent from both barrels). No api.json delta.

**api.json is a prepush gate (`check:doc-typedoc`), not a validate gate.** Parts 1 and 2 each
add a public field, so each MUST pre-pay `npm run docs:json` and commit the regenerated
`reports/api.json` IN-PART so every commit is self-consistent (the huge typedoc-id diff is
normal). The part gate below does NOT run `docs:json`; regenerate and `git add reports/api.json`
as the final GREEN/REFACTOR step of Parts 1 and 2.

## Property-test decision (four-lens, per CLAUDE.md)

`resolveBinaryOverride` (Part 3) is a **total function over the attribute grammar** (lens 3).
But its entire input domain is the 4-state `AttributeValue` enum × two booleans
(`textconvConfigured`, `rawIsBinary`) — a tiny finite set. CLAUDE.md is explicit: "Functions
whose only inputs are a small enum (3–10 values) — a parameterised example sweep does the same
job clearer" and design §5 reaffirms "input is a 4-value enum, so property generators add no
value". A property test here would re-enumerate the same handful of cases the example sweep
already pins, with worse readability. **No `*.properties.test.ts` sibling is included.** The
full mapping table is covered by isolated example cases in Part 3.

---

## Part 1 — domain: numstat binary override in `computeStatFields`

### Context

- File: `src/domain/diff/stat-fields.ts`. Target symbol: `computeStatFields` (a `Constant`
  arrow `export const computeStatFields = (old, next, options?) => StatFields`, lines 75–93)
  and the options interface `StatFieldsOptions` (lines 27–30, currently `{ lineKey?, ignoreBlankLines? }`).
- Add ONE optional field to `StatFieldsOptions`:
  ```ts
  /** Override the binary-vs-text decision for the numstat surface. `'binary'` ⇒
   *  `{ added: 0, deleted: 0, binary: true }`; `'text'` ⇒ count lines even over NUL;
   *  `undefined` ⇒ today's `isBinary` content-sniff. */
  readonly numstatBinaryOverride?: 'binary' | 'text';
  ```
- Rewrite the binary short-circuit at lines 80–82. Today:
  ```ts
  if (isBinary(old) || isBinary(next)) {
    return { added: 0, deleted: 0, binary: true };
  }
  ```
  New behaviour — the override short-circuits BOTH `isBinary` sub-signals (NUL window scan AND
  the line-length / line-count caps inside `isBinary`):
  - `numstatBinaryOverride === 'binary'` ⇒ return `{ added: 0, deleted: 0, binary: true }`
    WITHOUT calling `isBinary` (force binary even over purely textual content — B-cases).
  - `numstatBinaryOverride === 'text'` ⇒ SKIP the `isBinary` guard entirely and fall through
    to the line-diff counting path (force text even over NUL content — T-cases). The NUL byte
    must survive into `diffLines`; do not re-sniff.
  - `numstatBinaryOverride === undefined` ⇒ today's `if (isBinary(old) || isBinary(next))`
    path, byte-identical (the regression boundary).
  Keep the existing `diffLines` / `hunkContributesTo{Added,Deleted}` body (lines 83–92)
  untouched for the text path.
- `isBinary` import stays (line 2); it is still called on the `undefined` path. Do not remove it.
- DEPENDENCY RULE: `domain/diff` stays pure — the new param is a plain enum, no `Context`, no
  provider, no raw bytes. This is ADR-409's D-SHAPE (c) numstat half.
- PUBLIC SURFACE: `StatFieldsOptions` is re-exported through `public-types.ts:32`
  (`export type * from './domain/diff/index.js'`) and present in `reports/api.json` (9×).
  Adding `numstatBinaryOverride?` changes the surface → regenerate `reports/api.json` IN-PART.
- Test file: `test/unit/domain/diff/stat-fields.test.ts` (extend — 13.4 KB; top-level
  `describe('computeStatFields')` at line 8; existing binary-side cases at lines 64–91 are the
  shape to mirror, asserting all three fields `{ added, deleted, binary }`). Add ISOLATED guard
  tests (mutation-resistant — the override must short-circuit independent of content):
  - `numstatBinaryOverride: 'binary'` over PURELY TEXTUAL old+new (e.g. `'a\n'` → `'b\n'`):
    assert `{ added: 0, deleted: 0, binary: true }` (all three fields). This kills the
    "forgot to short-circuit on text content" mutant.
  - `numstatBinaryOverride: 'text'` over old/new each containing a NUL byte
    (e.g. `Uint8Array` `[0x61, 0x00, 0x0a]` → `[0x62, 0x00, 0x0a]`): assert real counts
    (`{ added: 1, deleted: 1, binary: false }`) — proves the `isBinary` guard is skipped and
    the NUL-bearing lines are counted.
  - `numstatBinaryOverride: undefined` (regression) over NUL content ⇒ `{ 0, 0, binary: true }`
    (today's sniff still fires); and `undefined` over text ⇒ real counts.
  - Combine with an existing `lineKey`/`ignoreBlankLines` option in ONE `'text'` case to prove
    the override does not disturb the normalization path (override resolves binary mode only).

### TDD steps

- RED: add the four `stat-fields.test.ts` cases above. Fails: `StatFieldsOptions` has no
  `numstatBinaryOverride` field (type error in test) and `computeStatFields` ignores it
  (`'binary'` over text counts lines; `'text'` over NUL short-circuits to binary).
- GREEN: add the `numstatBinaryOverride?` field to `StatFieldsOptions`; rewrite the lines 80–82
  guard to consult it before falling back to `isBinary`.
- REFACTOR: if the guard grows past ~6 lines, extract a tiny
  `numstatIsBinary(old, next, override): boolean` returning `override === 'binary'` when set,
  `override === undefined && (isBinary(old) || isBinary(next))` otherwise — keeping the `'text'`
  branch as the early skip. Then regenerate the public surface: `npm run docs:json` and
  `git add reports/api.json`.

### Gate

`npx vitest run test/unit/domain/diff/stat-fields.test.ts && npm run check:types && ./node_modules/.bin/biome check src/domain/diff/stat-fields.ts test/unit/domain/diff/stat-fields.test.ts reports/api.json`

### Commit

`feat(diff): numstat binary override in computeStatFields`

---

## Part 2 — domain: patch binary override across the 6 `isBinary` decision sites

### Context

- File: `src/domain/diff/patch-serializer.ts`. The patch surface decides binary-vs-text at
  **7 `isBinary(...)` calls across 6 decision functions** (verified — `grep -nF 'isBinary('`):
  | # | Line | Function | call |
  |---|---|---|---|
  | 1 | 514 | `renderSameKindBlock` (modify text-path guard) | `!isBinary(oldBytes) && !isBinary(newBytes)` |
  | 2 | 553 | `renderBrokenModifyBlock` (binary body branch) | `isBinary(oldBytes) || isBinary(newBytes)` |
  | 3 | 608 | `renderTypeChangeBlock` (delete side) | `isBinary(oldBytes)` |
  | 4 | 611 | `renderTypeChangeBlock` (add side) | `isBinary(newBytes)` |
  | 5 | 643 | `renderTwoPathBody` (rename/copy) | `isBinary(oldBytes) || isBinary(newBytes)` |
  | 6 | 741 | `renderFile` (add arm) | `isBinary(newBytes)` |
  | 7 | 746 | `renderFile` (delete arm) | `isBinary(oldBytes)` |
  NOTE: the design says "6 decision functions"; site 553 lives in `renderBrokenModifyBlock`
  (the broken-modify path) and site 514 in `renderSameKindBlock` — count them both. There are
  **7 calls** total; all must consult the override.
- Add TWO optional fields to `PatchFile` (interface at lines 15–19, currently
  `{ change, oldContent?, newContent? }`):
  ```ts
  /** Override the binary-vs-text decision for the PATCH surface. `'binary'` ⇒ render the
   *  `Binary files … differ` / binary-body branch; `'text'` ⇒ force the text-hunk branch
   *  even over NUL content; `undefined` ⇒ today's `isBinary` content-sniff. */
  readonly patchBinaryOverride?: 'binary' | 'text';
  /** Override the numstat decision (consumed by computeStatFields via diff-trees, NOT by
   *  this serializer). Carried on PatchFile so a single resolve pass attaches both. */
  readonly numstatBinaryOverride?: 'binary' | 'text';
  ```
  `numstatBinaryOverride` is a passive carrier here — patch-serializer never reads it; it is
  read in Part 4 by `diff-trees.applyLinePassAndStat`. Declaring both fields together keeps the
  public-surface change to one api.json regen and matches ADR-409's "PatchFile carries both".
- Introduce ONE private helper near the top of the file (after the `isBinary` import, line 11):
  ```ts
  /** Resolve the binary verdict for one side, honouring an optional patch override. */
  const sideIsBinary = (bytes: Uint8Array, override: 'binary' | 'text' | undefined): boolean =>
    override === undefined ? isBinary(bytes) : override === 'binary';
  ```
  Then thread a `patchBinaryOverride: 'binary' | 'text' | undefined` parameter from `renderFile`
  (which holds `file: PatchFile`, lines 732–768) DOWN into each decision function and replace
  every `isBinary(x)` listed above with `sideIsBinary(x, patchBinaryOverride)`:
  - `renderFile` (line 732): read `const override = file.patchBinaryOverride;` once. Replace
    line 741 (`isBinary(newBytes)`) and line 746 (`isBinary(oldBytes)`) with `sideIsBinary(...,
    override)`. Pass `override` into `renderModifyBlock`, `renderTypeChangeBlock`,
    `renderRenameBlock`, `renderCopyBlock`.
  - `renderModifyBlock` (line 560) → forward `override` to `renderBrokenModifyBlock` (line 536)
    and `renderSameKindBlock` (line 506); both gain a trailing `override` param.
  - `renderSameKindBlock` (line 506): replace line 514 guard; the `'text'` override forces the
    text branch (skip binary even over NUL), `'binary'` forces the binary-body branch. Mind the
    existing `common.oldId !== common.newId` predicate at line 514 and the `common.oldId ===
    common.newId` mode-only short-circuit at line 526 — the override only changes the
    binary-vs-text choice, NOT the id-equality logic. So the guard becomes
    `common.oldId !== common.newId && !sideIsBinary(oldBytes, override) && !sideIsBinary(newBytes, override)`.
  - `renderBrokenModifyBlock` (line 536): replace line 553.
  - `renderTypeChangeBlock` (line 588): gains `override` param; replace lines 608 + 611
    (delete side reads `override`, add side reads `override` — both sides of a type-change share
    the one path's resolved override, per design §3.1 "rename/type-change key off the single
    primaryPath").
  - `renderTwoPathBody` (line 633) ← `renderTwoPathBlock` (line 663, holds `file: PatchFile`) →
    `renderRenameBlock`/`renderCopyBlock`: thread `override` (read `file.patchBinaryOverride`
    inside `renderTwoPathBlock` and pass to `renderTwoPathBody`); replace line 643.
- `renderAddBinary` / `renderDeleteBinary` / `renderBinaryBody` / `renderAddBlock` /
  `renderDeleteBlock` / `renderTextBody` themselves are NOT touched — they are the leaf
  renderers the decision sites dispatch to; the override only changes WHICH leaf is chosen.
- `renderPatch` (lines 790–807) is unchanged — it iterates files and calls `renderFile(file, …)`
  which now reads `file.patchBinaryOverride` internally. No signature change to `renderPatch`.
- DEPENDENCY RULE: pure-domain enum threading only; no `Context`, no raw-byte numstat decision
  enters here. ADR-409 D-SHAPE (c) patch half.
- PUBLIC SURFACE: `PatchFile` is re-exported via `public-types.ts:32` and present in
  `reports/api.json` (9×, plus the `newContent` field). Adding two fields changes the surface →
  regenerate `reports/api.json` IN-PART.
- Test file: `test/unit/domain/diff/patch-serializer.test.ts` (extend — 77.6 KB; top-level
  `describe('patch-serializer')`-style tree). Build `PatchFile` fixtures with each `change.type`
  and assert the chosen branch via `renderPatch([file])`. ISOLATED tests, one decision site per
  test (mutation-resistant — each `isBinary` call needs its own kill):
  - `modify`, purely-textual old≠new bytes, `patchBinaryOverride: 'binary'` ⇒ output contains
    `Binary files a/<p> and b/<p> differ`, NO `@@` hunk header (site 514 + 553/527 forced).
  - `modify`, NUL-bearing old/new (`[0x61,0x00,0x0a]` → `[0x62,0x00,0x0a]`),
    `patchBinaryOverride: 'text'` ⇒ output contains a `@@ -1 +1 @@` hunk AND the raw NUL byte
    survives verbatim in a `-`/`+` body line (assert on the rendered string's char code 0x00).
  - `modify`, `patchBinaryOverride: undefined` over NUL content ⇒ `Binary files … differ`
    (today's sniff — regression).
  - `add`, textual bytes, `'binary'` ⇒ `Binary files /dev/null and b/<p> differ` (site 741).
  - `delete`, textual bytes, `'binary'` ⇒ `Binary files a/<p> and /dev/null differ` (site 746).
  - `type-change`, textual sides, `'binary'` ⇒ both the delete block AND the add block render as
    binary (`Binary files …`) (sites 608 + 611).
  - `rename`/`copy` with similarity < 100% and textual content, `'binary'` ⇒
    `Binary files … differ` in the two-path body (site 643).
  - broken `modify` (`change.broken` set), textual content, `'binary'` ⇒ `Binary files … differ`
    after the `dissimilarity index` line (site 553).
  - For at least the `modify` `'text'` case, assert the NUL byte is present in the patch — this
    is the T2 faithfulness fact the domain must reproduce.

### TDD steps

- RED: add the per-site `patch-serializer.test.ts` cases. Fails: `PatchFile` has no
  `patchBinaryOverride` field (type error) and each decision site ignores it (`'binary'` over
  text still renders a text hunk; `'text'` over NUL still renders `Binary files`).
- GREEN: add the two `PatchFile` fields; add `sideIsBinary`; thread `patchBinaryOverride` from
  `renderFile` (and `renderTwoPathBlock`) through the 6 decision functions, replacing all 7
  `isBinary` calls.
- REFACTOR: keep each touched function ≤ 20 lines; the threaded param is a single extra arg per
  function. Then regenerate the public surface: `npm run docs:json` and `git add reports/api.json`.

### Gate

`npx vitest run test/unit/domain/diff/patch-serializer.test.ts && npm run check:types && ./node_modules/.bin/biome check src/domain/diff/patch-serializer.ts test/unit/domain/diff/patch-serializer.test.ts reports/api.json`

### Commit

`feat(diff): patch binary override across the six decision sites`

---

## Part 3 — application: `resolve-binary-override` primitive (internal)

### Context

- NEW file: `src/application/primitives/resolve-binary-override.ts` (internal — NOT barrel-
  exported, NOT in `public-types.ts`; mirrors `resolve-textconv-driver.ts` which is also
  unbarrelled). Sibling to `src/application/primitives/resolve-textconv-driver.ts` (read it as
  the structural template: lines 1–46 — `AttributeValue` import from
  `../../domain/attributes/index.js`, `resolveAttribute`, the `choiceFromDiffValue` shape).
- Define the INTERNAL result type and pure resolver. The numstat raw-blob decision (ADR-409
  D-NAMED b) is collapsed to a boolean BEFORE entering this function — the application layer
  (Part 4) computes `isBinary(raw)` and passes the verdict, so NO raw bytes enter here:
  ```ts
  export interface BinaryOverridePair {
    readonly patch?: 'binary' | 'text';
    readonly numstat?: 'binary' | 'text';
  }

  /** Map a resolved `diff` AttributeValue to the (patch, numstat) override pair.
   *  `textconvConfigured` = a `[diff "<name>"].textconv` exists for the named driver;
   *  `rawIsBinary` = `isBinary(rawBlobBytes)` computed in the application layer. */
  export const resolveBinaryOverride = (
    value: AttributeValue,
    named: { readonly textconvConfigured: boolean; readonly rawIsBinary: boolean },
  ): BinaryOverridePair => { … };
  ```
- The mapping (ADR-409 Decision table / design §3.3) — `undefined` means "today's content-sniff":
  | resolved `diff` | patch | numstat |
  |---|---|---|
  | `false` (`-diff`, incl. `binary` macro) | `'binary'` | `'binary'` |
  | `true` (bare `diff`) | `'text'` | `'text'` |
  | `{ set: name }` + `textconvConfigured` | `'text'` | `rawIsBinary ? 'binary' : 'text'` |
  | `{ set: name }`, NOT `textconvConfigured` | `undefined` | `undefined` |
  | `'unspecified'` | `undefined` | `undefined` |
  Implementation: branch on `value === false` → `{ patch: 'binary', numstat: 'binary' }`;
  `value === true` → `{ patch: 'text', numstat: 'text' }`; `value === 'unspecified'` → `{}`
  (both undefined). For the `{ set }` object case, branch on `named.textconvConfigured`:
  configured → `{ patch: 'text', numstat: named.rawIsBinary ? 'binary' : 'text' }`; not
  configured → `{}`. Return `{}` (not `{ patch: undefined, numstat: undefined }`) for the
  no-override cases so callers read `pair.patch` / `pair.numstat` as `undefined`.
- The `binary` macro (`src/domain/attributes/macros.ts` `BUILTIN_MACROS`, `binary = -diff
  -merge -text`) already expands `diff` to `false` inside `resolveAttribute` — this resolver
  sees only the resolved `false`, so `-diff` and the `binary` macro map identically (the B1/Bmacro
  rows). No macro handling needed here.
- This resolver is a PURE function over `AttributeValue` — it takes no `Context`, no provider,
  no bytes (the caller pre-resolves the attribute and the raw-binary verdict). This keeps it a
  trivially-testable total function and keeps the raw bytes in the application layer (ADR-409:
  "no raw bytes enter the pure domain" — they do not enter this primitive's logic either).
- Test file: `test/unit/application/primitives/resolve-binary-override.test.ts` (NEW). It does
  NOT need a `Context` or provider — call `resolveBinaryOverride(value, named)` directly with
  literal `AttributeValue`s. ISOLATED example sweep over every mapping row (mutation-resistant —
  assert the exact `{ patch, numstat }` pair, never a truthy check):
  - `false` ⇒ `{ patch: 'binary', numstat: 'binary' }`.
  - `true` ⇒ `{ patch: 'text', numstat: 'text' }`.
  - `'unspecified'` ⇒ `{}` (both undefined — assert `pair.patch === undefined &&
    pair.numstat === undefined`).
  - `{ set: 'up' }` + `{ textconvConfigured: true, rawIsBinary: false }` ⇒
    `{ patch: 'text', numstat: 'text' }` (N1 — clean text raw blob).
  - `{ set: 'up' }` + `{ textconvConfigured: true, rawIsBinary: true }` ⇒
    `{ patch: 'text', numstat: 'binary' }` — **the N3/N3s kill**: patch forced text (textconv
    output), numstat tracks the RAW blob's binary verdict. This single case proves the
    raw-vs-transformed asymmetry that forced ADR-409 D-NAMED (b).
  - `{ set: 'up' }` + `{ textconvConfigured: false, rawIsBinary: true }` ⇒ `{}`
    (named-but-unconfigured ⇒ raw content-sniff fallback, no override — N4).
  - `{ set: 'up' }` + `{ textconvConfigured: false, rawIsBinary: false }` ⇒ `{}`.
  Each row a separate `it` under its own `Given`/`When` so a mutant flipping one arm cannot
  hide behind another row's assertion.

### TDD steps

- RED: add `resolve-binary-override.test.ts` covering all mapping rows. Fails: module does not
  exist (`resolve-binary-override.ts` missing — import error).
- GREEN: create `resolve-binary-override.ts` with `BinaryOverridePair` + `resolveBinaryOverride`
  implementing the table.
- REFACTOR: keep the function ≤ 20 lines with early returns per `value` arm; no nesting > 2.

### Gate

`npx vitest run test/unit/application/primitives/resolve-binary-override.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/primitives/resolve-binary-override.ts test/unit/application/primitives/resolve-binary-override.test.ts`

### Commit

`feat(primitives): resolve-binary-override attribute mapping`

---

## Part 4 — application: wire overrides into materialise + diff-trees, decouple runner guard, interop

### Context

This is the integration part: attach both overrides to `PatchFile` in the SAME per-path pass
that resolves textconv, decouple the provider build from `ctx.command` (ADR-410), feed
`numstatBinaryOverride` into `computeStatFields`, and pin every faithfulness row against real git.

**Chokepoint A — `src/application/primitives/materialise-patch-files.ts`.** New imports this part
adds (current imports verified, lines 1–12 — `isGitlink`/`PatchFile` already from the diff barrel,
`buildAttributeProvider` already imported): add `isBinary` from `../../domain/diff/index.js`;
`type AttributeValue` + `resolveAttribute` from `../../domain/attributes/index.js`; `readConfig`
from `./config-read.js`; `resolveBinaryOverride` from `./resolve-binary-override.js`. Full current
shape read; key facts:
- `materialisePatchFiles` (lines 90–105) builds the lazy `TextconvConfig` (lines 96–102) gated
  on `options?.applyTextconv === true && ctx.command !== undefined`, then maps each change via
  `materialiseOne(ctx, c, config)`.
- `maybeTextconv` (lines 61–76) is the ONLY place the resolved `diff` attribute is consulted
  today — it calls `config.getProvider()` then `resolveTextconvDriver(ctx, provider, filePath)`
  with `filePath = primaryPath(change)` (line 71). It runs PER SIDE (called up to twice per file
  — old + new — see lines 119/132/157/158/162–168), so a naive add would resolve the attribute
  twice. The override must be resolved ONCE per path and attached to the returned `PatchFile`.

The wiring (per design §3.2 — one `sourcesForPath` lookup drives BOTH textconv and the overrides):
1. **Decouple the runner guard (ADR-410 / D-OPTIN b).** Today the provider build is gated on
   `applyTextconv === true && ctx.command !== undefined`. Split the gate: build the provider
   whenever `options?.applyTextconv === true` (it needs only `FileSystem`, available on every
   adapter); keep the `runner` (textconv EXECUTION) gated on `ctx.command !== undefined`.
   Concretely, replace the single `config` with: a `getProvider` lazy thunk available whenever
   `applyTextconv === true` (regardless of `ctx.command`), and a `runner: CommandRunner |
   undefined` that is `ctx.command` (only used by `applyTextconv` execution). When
   `applyTextconv` is unset, NO provider is built and NO override is resolved (content-stable
   boundary — R4 preserved; `patch-id`/`range-diff`/`rebase` pass no opt-in, see callers below).
2. **Resolve the override once per path.** Add a new per-path step that, when the provider is
   available, does ONE `provider.sourcesForPath(filePath)` call (filePath = `primaryPath(change)`)
   and from its `{ sources, macros }`:
   - `const value = resolveAttribute(sources, filePath, 'diff', macros)` (import from
     `../../domain/attributes/index.js`).
   - determine `textconvConfigured`: for a `{ set: name }` value, `(await readConfig(ctx))
     .diff?.get(name)?.textconv` is a non-empty string. (Reuse `readConfig` from
     `./config-read.js`; it is per-`Context` cached.) For non-object values this is `false`.
   - compute `rawIsBinary` from the RAW blob bytes — the bytes read by `readBlob`/`resolveSide`,
     BEFORE textconv transforms them. The rule is **`isBinary(oldRaw) || isBinary(newRaw)`** —
     the SAME "either side trips" semantic `computeStatFields` already uses (stat-fields.ts
     line 80) and git's numstat (`diff_filespec_is_binary` on either filespec). Use whichever raw
     sides exist for the change: both for modify/type-change/rename-copy-with-content, the single
     present side for add/delete (the absent side is empty ⇒ `isBinary(empty) === false`, so the
     `||` reduces to the present side). CRITICAL ORDERING (design §3.2 step 2, load-bearing):
     `rawIsBinary` must be computed from the raw bytes and passed to the resolver *before*
     `maybeTextconv` replaces `{old,new}Content` with transformed bytes — otherwise the numstat
     decision would wrongly sniff the post-textconv output (the N3s divergence ADR-409 forbids).
     `rawIsBinary` is read by the resolver ONLY for the `{set}+textconv` row; `false`/`true`/
     unconfigured/unspecified ignore it, so its value is irrelevant on those paths.
   - `const pair = resolveBinaryOverride(value, { textconvConfigured, rawIsBinary })` (Part 3).
   - return the `PatchFile` with `patchBinaryOverride: pair.patch` and
     `numstatBinaryOverride: pair.numstat` attached (omit the fields when `undefined` so the
     no-attribute path stays byte-identical to today — spread conditionally, e.g.
     `...(pair.patch !== undefined ? { patchBinaryOverride: pair.patch } : {})`).
3. **Share the single `sourcesForPath` call with textconv.** Today `maybeTextconv` calls
   `resolveTextconvDriver` (which itself calls `sourcesForPath` + `resolveAttribute`). To honour
   design §3.2's "one lookup drives both" and the materialise-patch-files test's
   "one `sourcesForPath` call per path" assertion, restructure `materialiseOne` so the per-path
   `diff` attribute is resolved ONCE: resolve `{ sources, macros }` and `value` at the top of
   `materialiseOne` (when the provider is available and the side is non-gitlink), derive BOTH the
   textconv choice (reuse `choiceFromDiffValue` logic OR call `resolveTextconvDriver` — but that
   re-does the lookup; prefer exposing the resolved `value` and computing textconv from it) AND
   the override pair from that one resolution. Minimal viable shape: add a helper
   `resolvePerPathDiffAttr(ctx, provider, change)` returning `{ value, sources, macros }`; call
   it once per file; feed `value` to both the textconv path and `resolveBinaryOverride`. Keep
   `maybeTextconv`'s gitlink skip (line 69 — `isGitlink(mode)` returns raw, no override) and the
   "old/new id match" mode-only short-circuit (lines 154–161) intact.
   - GITLINK: synthesized `Subproject commit` sides (lines 117/130/143 and `synthesizeGitlink`)
     get NO override — return as today. git does not apply `diff` attribute binary override to
     gitlinks (mirrors the textconv gitlink skip).
   - PURE-RENAME short-circuit (line 143, `similarity.score === MAX_SCORE` returns `{ change }`
     with no content): no content ⇒ no override needed; leave as-is.

**Chokepoint B — `src/application/primitives/diff-trees.ts` `applyLinePassAndStat` (lines 91–111).**
- Line 99 already calls `materialisePatchFiles(ctx, diff.changes, { applyTextconv: true })`.
- Lines 102–106 call `computeStatFields(file.oldContent ?? EMPTY, file.newContent ?? EMPTY,
  statOptionsFor(...))`. Feed `file.numstatBinaryOverride` into the options: extend
  `statOptionsFor` (lines 72–82) to take the override and include `numstatBinaryOverride` in the
  returned `StatFieldsOptions`, OR merge it at the call site:
  `computeStatFields(old, next, { ...statOptionsFor(...), numstatBinaryOverride: file.numstatBinaryOverride })`.
  Preferred: thread it through `statOptionsFor(lineKey, lineKeyActive, ignoreBlankLines,
  numstatBinaryOverride)` so the option object is built in one place; when all inputs are absent
  it must still return `undefined` (preserve the existing `undefined` fast-path so the
  no-attribute, no-whitespace numstat stays byte-identical — only add the override field when it
  is defined).
- `shouldDrop` (lines 119–121) consistency: it drops a `modify` only when
  `stats.added === 0 && stats.deleted === 0 && !stats.binary`. With `numstatBinaryOverride:
  'binary'`, `computeStatFields` returns `binary: true` ⇒ `shouldDrop` returns false (never
  dropped — correct, B-cases are real binary changes). With `'text'` over content that yields
  zero real hunks, `stats.binary` is false and counts are 0 ⇒ still drops correctly (a forced-
  text modify with no textual change is genuinely empty). Add a unit assertion for BOTH.

**Off-node decoupling proof (ADR-410).** After step 1, a memory/browser context (no `ctx.command`)
with `applyTextconv: true` builds the provider and resolves `-diff`/bare `diff` overrides
in-process — only textconv EXECUTION is skipped (no runner). The cross-adapter test below pins it.

**Callers that must stay byte-identical (R4 boundary — verified):**
- `src/application/primitives/patch-id.ts:59` — `materialisePatchFiles(ctx, diff.changes)` (no
  opt-in) ⇒ no provider, no override; `renderPatch` at line 60 sees `patchBinaryOverride ===
  undefined` ⇒ content-sniff (stable patch-id).
- `src/application/commands/range-diff.ts:74` — no opt-in ⇒ no override.
- `src/application/commands/rebase.ts:301` — no opt-in ⇒ `renderPatch` at line 304 content-sniffs
  (stable `.git/rebase-merge/patch`).
Do NOT change these call sites.

**Unit test files:**
- `test/unit/application/primitives/materialise-patch-files.test.ts` (extend — 29.4 KB; existing
  fake `CommandRunner` fixtures at lines 477+; `materialisePatchFiles` describe line 63,
  `materialiseOne` line 154). Use the memory adapter + a spy/fake provider or seed
  `.gitattributes` + `.git/config` (the `resolve-textconv-driver.test.ts` `seed(ctx, attrs,
  config)` helper at lines 14–22 is the template — writes `${workDir}/.gitattributes` and
  `${gitDir}/config`). ISOLATED cases:
  - `*.bin -diff` attribute, textual content, `applyTextconv: true`, NO `ctx.command`
    (memory) ⇒ returned `PatchFile` has `patchBinaryOverride === 'binary'` AND
    `numstatBinaryOverride === 'binary'` — proves the DECOUPLED guard (override resolved with no
    runner — the ADR-410 off-node kill).
  - bare `diff` attribute, NUL content, `applyTextconv: true` ⇒
    `{ patch: 'text', numstat: 'text' }` on the `PatchFile`.
  - `diff=up` + `[diff "up"].textconv` configured + a runner, RAW blob containing NUL but
    textconv output clean ⇒ `patchBinaryOverride === 'text'` AND `numstatBinaryOverride ===
    'binary'` (the N3s raw-blob asymmetry at the chokepoint — assert the override was computed
    from RAW bytes before transform).
  - NO `applyTextconv` opt-in (content-stable call) ⇒ EVERY returned `PatchFile` has
    `patchBinaryOverride === undefined && numstatBinaryOverride === undefined`, and assert NO
    provider was built (spy `buildAttributeProvider` is never called / `sourcesForPath` not
    invoked). This pins R4 + the "no provider when no opt-in" cost guarantee.
  - one path resolves the attribute via a SINGLE `sourcesForPath` call even though both old and
    new sides are materialised (spy the provider's `sourcesForPath`, assert call count === 1 per
    path) — proves textconv + override share one lookup.
- `test/unit/application/primitives/diff-trees.test.ts` (extend — 41.0 KB; `describe('diffTrees')`
  line 24). Memory adapter + seeded `.gitattributes`. ISOLATED:
  - `*.f -diff` over textual modify, `withStat: true` ⇒ the resulting `StatDiffChange` has
    `binary === true`, `added === 0`, `deleted === 0` (numstat override reached
    `computeStatFields`).
  - bare `diff` over NUL modify, `withStat: true` ⇒ `binary === false` with real counts.
  - `shouldDrop` consistency: `-diff` forced-binary modify is NOT dropped under a `lineKeyActive`
    pass; a bare-`diff` forced-text modify with zero real hunks IS dropped.

**Interop test (faithfulness proof) — `test/integration/diff-attr-binary-interop.test.ts` (NEW).**
- Structural template: `test/integration/diff-textconv-interop.test.ts` (read in full). Reuse its
  exact harness: `SETUP_TIMEOUT = 60_000`, `describe.skipIf(!GIT_AVAILABLE)`, ONE shared
  `beforeAll` repo built with `runGit`/`git` from `interop-helpers.js` (scrubbed `GIT_*`,
  isolated `HOME`, `GIT_CONFIG_NOSYSTEM=1`, signing off, `--no-ext-diff`), `dateEnv` for
  deterministic commits, `afterAll` rm. Copy the `nameStatusFrom`, `statChangePath`,
  `hasSameModes`, and `numstatRowsFrom` helpers (lines 44–77) — `numstatRowsFrom` ALREADY reads
  `c.binary` so the numstat override flows through automatically once Part 4 lands. Reconstruct
  patches via the shared `reconstructPatch(ctx, treeDiff)` helper
  (`test/integration/diff-reconstruct.ts` — already routes through
  `materialisePatchFiles({ applyTextconv: true })` + `renderPatch`, so it picks up
  `patchBinaryOverride` with zero changes to the helper).
- `.gitattributes` for the fixture: `f -diff` (or a per-file scheme), a bare-`diff` file, a
  `*.bin binary` macro file, a `diff=up` named-driver file with `diff.up.textconv` configured
  (portable `#!/bin/sh\nLC_ALL=C tr a-z A-Z < "$1"\n` script, chmod 0755 — copy lines 113–122),
  and a NUL-stripping textconv driver (`tr -d '\\000'`) for N3s. Commit pairs per row.
- Rows to pin (design §3.4 / §5) — for each, reconstruct/compute from structured fields and
  compare byte-for-byte to peer git:
  - **B1**: `f -diff`, textual modify ⇒ peer `git diff` shows `Binary files a/f and b/f differ`;
    `reconstructPatch` equals it. **Bn**: peer `--numstat` ⇒ `-\t-\tf`; `numstatRowsFrom(diff(…,
    withStat))` equals it.
  - **Ba**: `-diff` add of textual content ⇒ `Binary files /dev/null and b/<p> differ`.
    **Bd**: `-diff` delete ⇒ `Binary files a/<p> and /dev/null differ`.
  - **Bmacro**: `*.bin binary` macro over TEXTUAL content ⇒ binary patch + `-\t-` (macro ⇒
    `-diff` ⇒ identical to B1).
  - **T2**: bare `diff`, NUL-in-line-1 content modify ⇒ full text hunk with the NUL byte verbatim
    (`reconstructPatch` byte-equals peer `git diff`). **T2n**: `--numstat` ⇒ `1\t1\tf`.
  - **N1**: `diff=up` + textconv, CLEAN text ⇒ patch text hunk (uppercased) byte-equals peer
    `git diff --textconv`; numstat `1\t1` (cross-check with #195 — should already pass, pins
    no-regression).
  - **N3**: `diff=up` + textconv, NUL-KEEPING raw blob ⇒ patch is a text hunk over textconv
    output; numstat `-\t-` (raw blob is binary). Assert both against peer.
  - **N3s**: `diff=up` + NUL-STRIPPING textconv, raw blob has NUL ⇒ patch is a CLEAN text hunk
    (NUL stripped by textconv); numstat `-\t-` (raw blob still binary). **The D-NAMED (b)
    faithfulness kill** — assert numstat is `-\t-` matching peer git, NOT `n\tm`.
  - **N4**: `diff=unk` with no `[diff "unk"]` section, NUL content modify ⇒ patch `Binary files
    differ` (raw content-sniff fallback, no override); numstat `-\t-`.
  - **R**: any B1/T2/N3 ⇒ `git diff --raw --abbrev=40` raw tree OIDs equal `change.oldId`/
    `change.newId` (override never touches OIDs — ADR-249; copy the T6/R2 assertion at
    diff-textconv lines 231–253).
- **`diff-textconv-interop.test.ts` T-BIN stays green** (regression boundary): the existing
  T-BIN case (binary macro over NUL content — attribute and content agree) must still pass
  unchanged. Run it in this part's gate to confirm the override does not break the agree-case.

**Cross-adapter test (ADR-410 decoupled guard, no real git).**
- Structural template: `test/integration/filter-driver-parity.test.ts` (read lines 1–70 —
  `createMemoryContext`, `createNodeContext`, commit a `.gitattributes`, then diff). Add a memory-
  adapter scenario (NO runner): commit `.gitattributes` with `f -diff` + a bare-`diff` file +
  textual content, run `diff(ctx, { from, to })` and `diff(ctx, { from, to, withStat: true })`.
  Assert the memory adapter (no `ctx.command`) STILL honours the override — `-diff` file's
  `StatDiffChange.binary === true` and its reconstructed patch shows `Binary files … differ`;
  bare-`diff` file over NUL shows a text hunk. This is the ADR-410 distinction: unlike #195's
  filter drivers (inert off-node), the pure binary override is LIVE off-node. Prefer extending
  `filter-driver-parity.test.ts` with a dedicated `describe('Given a -diff / bare diff attribute
  on a runner-less memory adapter')` block; if it does not fit cleanly, add
  `test/integration/diff-attr-binary-parity.test.ts` (memory only, no git needed).

GWT/AAA conventions, `sut` for the system under test, 100% coverage, 0 killable mutants;
error/value assertions specific (assert the exact enum + counts, never truthy); each `isBinary`
short-circuit guard tested per-side per the mutation-resistant guard-clause rule.

### TDD steps

- RED: add the `materialise-patch-files.test.ts` cases (decoupled-guard no-runner override,
  raw-blob N3s asymmetry, no-opt-in ⇒ no override + no provider, single `sourcesForPath`),
  `diff-trees.test.ts` cases (numstat override reaches `computeStatFields`, `shouldDrop`
  consistency), the new `diff-attr-binary-interop.test.ts` rows, and the cross-adapter memory
  case. Fails: `materialiseOne` never resolves the override / `PatchFile` overrides undefined;
  provider gated on `ctx.command` so memory returns no override; numstat ignores the override.
- GREEN: decouple the provider build from `ctx.command` (gate on `applyTextconv` only; keep
  runner gated); resolve the `diff` attribute ONCE per path; compute `textconvConfigured` +
  `rawIsBinary`; call `resolveBinaryOverride`; attach both overrides to the `PatchFile`; thread
  `numstatBinaryOverride` into `computeStatFields` via `statOptionsFor` in `applyLinePassAndStat`.
- REFACTOR: extract the per-path `resolvePerPathDiffAttr` helper so `materialiseOne` stays
  ≤ 20 lines and textconv + override share one `sourcesForPath` call; keep the gitlink and
  mode-only short-circuits intact.

### Gate

`npx vitest run test/unit/application/primitives/materialise-patch-files.test.ts test/unit/application/primitives/diff-trees.test.ts test/integration/diff-attr-binary-interop.test.ts test/integration/diff-textconv-interop.test.ts test/integration/filter-driver-parity.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/primitives/materialise-patch-files.ts src/application/primitives/diff-trees.ts test/unit/application/primitives/materialise-patch-files.test.ts test/unit/application/primitives/diff-trees.test.ts test/integration/diff-attr-binary-interop.test.ts test/integration/filter-driver-parity.test.ts`

### Commit

`feat(diff): honour diff/binary attribute binary-vs-text decision`
