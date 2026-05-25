# ADR-140: `@writes` JSDoc tag grammar

## Status

Accepted (at `69fb435`)

## Context

19.7's audit needs a single source of truth for "this code path
emits Git-on-disk bytes." Two shapes were considered:

1. **External manifest** — `tooling/audit-write-surfaces.manifest.json`
   lists every expected write surface with its location. Audit
   cross-references manifest entries against `cross-tool-interop`
   tests.
2. **In-source JSDoc tag** — each src file that emits bytes carries
   a `@writes` block in its module header; audit scans src for
   tags.

The manifest approach centralises the declaration but lets the
manifest and the code drift independently. A new writer module
landing without a manifest update would silently bypass the audit.

The in-source tag co-locates the declaration with the code that
needs it. Adding a writer requires adding the tag in the same file
— a missed tag is a visible omission in code review (a function
that obviously writes bytes but doesn't carry the tag is a
question reviewers naturally ask).

19.4's `@proves` already established the in-source-JSDoc pattern
and its parser discipline. Reusing the same shape minimises
contributor learning curve.

## Decision

Each src file that emits Git-on-disk bytes carries a file-header
JSDoc block with a `@writes` directive of the shape:

```
@writes
  surface: <kebab-or-camelCase identifier>
  kind:    byte-identical | equivalent-under-readback | readback-only
  format:  <kebab-case format name, free-form, 4–40 chars>
```

Grammar rules:

- `surface` matches `^[a-z][a-zA-Z0-9.-]{1,40}$` — same regex as
  19.4's `@proves surface:` (ADR-121). Surface names are
  interchangeable between the two audits.
- `kind` is one of the three enum values; the audit rejects
  anything else.
- `format` is free-form for traceability (e.g. `git-tree-object`,
  `pack-index-v2`, `git-config-text`). Lowercase, kebab-case,
  4–40 chars. Not validated against any taxonomy.
- A file carries at most one `@writes` block. A file that emits
  two formats must split (good factoring) or pick the primary
  (one-line `@writes`, paramaterised tests cover the variants —
  see `index` covering v2 + v3).
- The block lives within the first JSDoc of the file (parser
  scans up to the first `*/`). Files without `@writes` are
  ignored.

The audit's `parseWritesTags` walks `src/**/*.ts` excluding
`*.test.ts`, `*.spec.ts`, `*.properties.test.ts`, and `index.ts`
re-export barrels.

## Consequences

### Positive

- A new writer module that lands without a `@writes` tag is
  invisible to the audit only if it also doesn't add an interop
  test that *claims* coverage — the latter is visible in review.
  In practice, the two are added together.
- Renaming a surface is a textual rename across two files (the
  src `@writes surface:` and the test `interopSurface:`), grep-
  friendly.
- The 19.4 parser doesn't need to know about `@writes` — the two
  audits share a regex shape but not code paths. Each audit owns
  its own grammar.

### Negative

- The "one `@writes` per file" rule forces a writer that splits
  formats per code branch to either factor the file or accept a
  single surface name. The `index` writer (v2 + v3) is the
  borderline case today, resolved by single `index` surface +
  parameterised test. If a future module genuinely emits two
  unrelated formats, factoring is the better resolution anyway.
- The tag only declares the emitting module, not the specific
  function. A file with multiple exports that all write the same
  surface needs only one tag; a file with multiple exports that
  write different surfaces is the multi-format case above.

### Neutral

- The audit's parser is pure string manipulation (no AST). Mirrors
  19.4's `parseProvesHeader` shape per ADR-097.
- The `format` field has no validation today. If a typo or
  abbreviation rot accumulates, a follow-up ADR can introduce a
  controlled vocabulary; today the free-form field is enough.
