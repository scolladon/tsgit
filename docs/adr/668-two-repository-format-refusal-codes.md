# 668 — Two repository-format refusal codes

- **Status:** accepted
- **Date:** 2026-08-19
- **Design:** docs/design/repository-format-acceptance-gate.md (candidate D3) · **Refines:** ADR-249, ADR-654

## Context

The acceptance surface has three refusal conditions. One — a version literal git's integer
grammar rejects — is already `CONFIG_BAD_NUMERIC_VALUE` with a matching `reason` enum, because
`parseGitInt` reproduces every measured literal (`0x1` → 1, `0777` → 511, `1k` → 1024, `08` →
`invalid unit`, both int64 bounds). The remaining two are the version ceiling
(`version > 1`) and the extension arm, which has two measured shapes selected by version:
unknown-at-v1 and v1-only-at-v0.

ADR-667 narrows *when* the unknown arm fires without removing it: since every name git knows is
accepted, it now fires only for names git itself rejects too — which makes it a pure
faithfulness surface rather than a divergence.

Per ADR-249 the payload carries fields only; the interop test reconstructs git's `fatal:` line.

## Options considered

1. **One code** — `REPOSITORY_FORMAT_UNSUPPORTED { version, extensions }`, an empty
   `extensions` meaning the version arm — pros: one code / cons: an "empty array means the
   other case" sentinel, which the house style calls primitive obsession.
2. **Two codes** — `REPOSITORY_FORMAT_VERSION_UNSUPPORTED { version }` and
   `REPOSITORY_EXTENSIONS_UNSUPPORTED { version, extensions }` (design recommendation) —
   pros: every payload total, every reconstruction branch-free / cons: two members.
3. **Three codes**, one per git message — pros: one-to-one with git's text / cons: a third
   code for one condition rendered two ways by a field the payload already carries.

## Decision

**Option 2 — adopted as recommended (no user judgment).**

It matches the ADR-654 precedent: two work-tree refusal codes, split because git renders two
distinct `fatal:` lines for two distinct conditions rather than two renderings of one. A caller
switches on "the version is too new" versus "an extension is unsupported here" — the branch a
caller acts on.

The **parsed** version integer is carried, never the literal: `1k` must reconstruct as
`found 1024`. Extension names are carried as the lower-cased key with the subsection preserved
verbatim, joined by `.`, matching the convention `CONFIG_BAD_BOOLEAN_VALUE` already documents
for its `key` field. Singular versus plural is derivable from list length, so it is a rendering
concern, not a payload one.

## Consequences

- Two union members and factories in `src/domain/repository/error.ts`, two arms in
  `extractDetail`, two rows in `docs/use/errors.md`, and a regenerated `reports/api.json`.
- The rendered detail names the version and the count plus the first offender while the payload
  carries every name, keeping config-supplied text bounded in the rendered string.
- Point-of-use refusals introduced by ADR-667 are a separate family and do not reuse these codes.
