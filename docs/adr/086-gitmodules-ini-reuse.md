# ADR-086: `.gitmodules` reuses the `.git/config` INI tokenizer

## Status

Accepted (at `2ad72af`)

## Context

`.gitmodules` is, byte-for-byte, a `.git/config`-format INI file: `[section
"subsection"]` headers, `key = value` entries, `#`/`;` comments, backslash
line continuations, quoted subsections. The `config-read` primitive already
contains a complete, lenient tokenizer for exactly this grammar —
`collectSections` and its helpers (`joinContinuations`, `stripInlineComment`,
`indexOfUnquoted`, `parseSectionHeader`, `parseKeyValue`). That code is at
100% coverage with a tuned set of `// Stryker disable` equivalent-mutant
annotations.

A submodule walk needs to tokenize `.gitmodules`. Options:

- **Re-implement the tokenizer** in a new module. Duplicates ~70 lines of
  fiddly INI parsing; the `jscpd` duplicate-code gate in `npm run validate`
  would flag it; it violates DRY and doubles the maintenance + mutation
  surface.
- **Extract the tokenizer into a new `src/domain/` module** and have both
  `config-read` and the submodule code import it. Cleanest on paper, but it
  churns `config-read.ts` (a well-tested, mutation-tuned file), forces a new
  domain test file to re-establish direct coverage, and relocates the
  `// Stryker disable` annotations — a wide change for a feature that only
  needs to *call* the tokenizer.
- **Export the tokenizer from `config-read` and reuse it.** `config-read` is a
  primitive; the submodule walk is a sibling primitive; `primitive → primitive`
  imports are already routine (`read-tree` imports `read-object`). The pure
  parsing already lives in this primitive — `parseConfigText` is itself a pure
  function housed there — so exporting one more pure function changes nothing
  architecturally.

## Decision

Rename `collectSections` to `parseIniSections`, widen its return type to a
`readonly` public shape, and **export** it together with the section type:

```ts
export interface IniSection {
  readonly section: string;
  readonly subsection: string | undefined;
  readonly entries: ReadonlyArray<{ readonly key: string; readonly value: string }>;
}
export const parseIniSections: (text: string) => ReadonlyArray<IniSection>;
```

`parseConfigText` keeps calling it — behaviour, and the existing `config-read`
test + mutation surface, are unchanged (same code, new name, wider-but-
compatible export). The submodule walk imports `parseIniSections` directly
from `config-read.js`, filters `section === 'submodule'`, and reduces each
section to its `path` / `url` / `branch` keys.

No new `src/domain/` module; `config-read.ts` is the single owner of the
git-config INI grammar.

## Consequences

### Positive

- One tokenizer, one place — no duplication, no `jscpd` finding, DRY upheld.
- Minimal diff: a rename plus an `export`, no relocation of code or
  mutation annotations, no new domain module or test file.
- `.gitmodules` automatically inherits every parsing fix and hardening the
  `.git/config` tokenizer already has or later gains.

### Negative

- A pure parsing function lives in the primitive tier rather than `domain/`.
  Accepted: `parseConfigText` already sets that precedent in this exact file;
  moving it would be a larger, riskier change than the feature warrants.

### Neutral

- `config-read.ts` gains a second public responsibility (a reusable tokenizer
  alongside `readConfig`). The file's name still fits — it remains the
  git-config-format module.
</content>
</invoke>
