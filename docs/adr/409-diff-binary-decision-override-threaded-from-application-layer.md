# 409 — diff binary-vs-text decision: per-surface override threaded from the application layer

- **Status:** accepted
- **Date:** 2026-06-23
- **Design:** docs/design/diff-attr-binary-override.md · **Relates:** ADR-407 (textconv threading — mirrored), ADR-302 (attribute resolution / macros), ADR-249 (structured-data-only), ADR-398 (no-driver baseline), ADR-410 (off-node decoupling of this override)
- **Decision class:** D-NAMED user-ratified; D-SHAPE user-ratified (forced by D-NAMED)

## Context

`src/domain/diff/` is **pure** — it decides binary-vs-text purely by content-sniff
(`isBinary`, a NUL-window scan + line-length caps) at three sites: the `computeStatFields`
numstat short-circuit and the six `isBinary` decision functions in `patch-serializer.ts`.
The `diff`/`binary` `.gitattributes` attribute is a tri-state **override** on that decision
(pinned against real `git 2.54.0`, design §3.4): `-diff` (and the `binary` macro
`-diff -merge -text`) forces **binary** even over textual content; bare `diff` forces
**text** even over NUL content; `diff=<name>` forces the **patch** to a text hunk over the
textconv output while the **numstat / `--stat`** decision is taken on the **raw** blob.

Two coupled choices: the override **shape** threaded into the pure domain (D-SHAPE), and how
`diff=<name>` maps to the **numstat** decision given git's pinned raw-vs-transformed
asymmetry (D-NAMED).

## Options considered

**D-NAMED** (numstat for a named driver): (a) sniff the **transformed** bytes (no change to
the numstat path) — faithful for clean text and NUL-keeping textconv, **diverges** only for a
NUL-stripping textconv; (b) sniff the **raw** blob — faithful for every named-driver case;
(c) force `'binary'` for any `diff=<name>` — diverges over clean text.

**D-SHAPE** (override type): (a) **one** tri-state `binaryOverride?: 'binary' | 'text'` on both
`StatFieldsOptions` and `PatchFile`; (b) a boolean `forceBinary?` — loses the text-force-over-NUL
case; (c) **per-surface** overrides (patch decision vs numstat decision carried independently).

## Decision

- **D-NAMED (user-ratified): (b) the numstat decision is taken on the RAW blob**, matching
  git (`diff_filespec_is_binary` sniffs the raw blob regardless of any userdiff name/textconv).
  The application layer — which holds **both** the raw and the textconv-transformed bytes at the
  single per-path resolve point — computes the numstat binary decision from the **raw** bytes and
  passes it down as a resolved override **enum**; no raw bytes enter the pure domain. Zero
  divergence across clean-text, NUL-keeping, and NUL-stripping textconv. Chosen over (a) because
  the prime directive (ADR-226) forbids divergence absent a documented exception, and the user
  declined to carve one.
- **D-SHAPE (user-ratified, forced by D-NAMED b): (c) per-surface override.** Because git's two
  surfaces genuinely disagree for named drivers, the **patch** decision and the **numstat**
  decision each carry their own `'binary' | 'text' | undefined`. `PatchFile` carries both; the
  six `isBinary` sites in `patch-serializer.ts` consult the patch override; `computeStatFields`'
  options carry the numstat override. (a) cannot express the per-surface disagreement; (b) cannot
  force text over NUL.

**Resolved attribute → (patch, numstat) override mapping** (the contract the application-layer
resolver implements; `undefined` ⇒ today's content-sniff):

| resolved `diff` | patch override | numstat override |
|---|---|---|
| `false` (`-diff`, incl. `binary` macro) | `'binary'` | `'binary'` |
| `true` (bare `diff`) | `'text'` | `'text'` |
| `{ set: name }` + configured `textconv` | `'text'` (textconv output as a text hunk even when NUL-retaining) | raw-blob decision: `isBinary(raw)` ⇒ `'binary'` else `'text'` |
| `{ set: name }`, no/empty `textconv` | `undefined` | `undefined` (raw == content; content-sniff already sees raw) |
| `'unspecified'` (no rule) | `undefined` | `undefined` |

## Consequences

- `domain/diff` gains optional per-surface override parameters — plain enums, **no** `Context`,
  no attribute provider. The domain stays platform-free; the dependency rule is honoured exactly
  as ADR-407 threaded transformed *content* — here we thread a *decision* instead, because the
  binary mode is not expressible as a byte transform.
- **Default path is byte- and cost-identical to today:** no `diff`/`binary` attribute ⇒ both
  overrides `undefined` ⇒ every site calls `isBinary` exactly as before; no attribute read forced
  onto a diff that has none.
- The override is resolved **once per path** in `materialise-patch-files.ts`, reusing #195's
  `AttributeProvider` (one `sourcesForPath` lookup drives both the textconv choice and this
  override — guaranteed consistent).
- The public `StatFields.binary` boolean's **computation** changes. The new optional override
  fields land on the **public** `PatchFile` and `StatFieldsOptions` types — both reach the package
  surface via `public-types.ts`'s `export type * from './domain/diff/index.js'` wildcard (confirmed
  in `reports/api.json`) — so there **is** an `api.json` delta, regenerated (`npm run docs:json`)
  and committed in the parts that add the fields (the `check:doc-typedoc` prepush gate). The
  internal `resolveBinaryOverride` primitive is unbarrelled — no delta from it.
- Each pinned row (design §3.4) becomes a cross-tool `*-interop` test reconstructing git's
  `Binary files … differ` / `-\t-` / text-hunk from the structured fields (ADR-249); the library
  emits no rendered display string.
