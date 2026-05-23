# ADR-097: API coverage parser — regex over TypeScript AST

## Status

Accepted (at `5cb6a6b`)

## Context

The Phase 18.3 API coverage script parses `src/repository.ts` to enumerate `repo.<command>` and `repo.primitives.<primitive>` bindings (ADR-096). Two implementation strategies were considered:

1. **TypeScript Compiler API** — load `typescript`, parse `src/repository.ts` into a `SourceFile`, walk `InterfaceDeclaration` nodes, extract `PropertySignature` names.
2. **Anchored regex** — match a narrow shape (`^  readonly (\w+): BindCtx<`) against the file's text.

## Decision

Use an **anchored regex**.

The regex relies on two stable shape properties of `src/repository.ts`:

- Every Tier-1 binding is declared as `  readonly <name>: BindCtx<typeof commands.<name>>;` — 2-space leading indent, `readonly` keyword, `BindCtx<` type wrapper.
- Every Tier-2 binding is declared as `    readonly <name>: BindCtx<typeof primitives.<name>>;` — 4-space indent inside the nested `primitives: { ... }` block.

The script uses two regexes:

```ts
const commandRe = /^  readonly (\w+):\s*BindCtx</gm;
const primitiveRe = /^    readonly (\w+):\s*BindCtx</gm;
```

Both regexes are filtered to exclude the names `primitives`, `ctx`, `dispose` (top-level slots that are not commands).

## Consequences

### Positive

- **Zero runtime cost.** No need to load `typescript` (which knip would then ignore-list); the script runs in milliseconds.
- **No TypeScript-as-runtime-dependency.** TypeScript is a devDependency for the build; the coverage script shouldn't reach into it as a parser library.
- **Easy to read.** The regex documents the assumption ("every binding follows the `readonly <name>: BindCtx<` shape") in one line. Anyone debugging the script reads the regex and understands the contract immediately.

### Negative

- **Coupled to file formatting.** A change to the `Repository` interface's shape (renaming `BindCtx`, switching to a different binding pattern, removing `readonly`) would silently make the regex match zero names. Mitigated by a unit test that asserts the parser returns the *expected count* on the real `src/repository.ts` — a regression would fail the test before it reached CI's docs check.
- **Brittle to reformatting.** Biome currently formats the file with 2-space indent; if we ever flipped to tabs or 4-space, the regex would need updating. The cost is one regex change, gated by the same unit test.

### Neutral

- If the surface grows beyond what regex can cleanly describe (e.g. nested unions, conditional types, method signatures instead of property signatures), we revisit and pull in `typescript` as a script-time dependency. Today's surface doesn't justify it.
- The TypeScript-AST alternative remains a one-evening swap if needed. This is not a load-bearing decision.
