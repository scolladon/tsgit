# ADR-003: Error Extension Strategy — Layered Union with Shared TsgitError

## Status

Proposed

## Context

Phase 1 introduced `TsgitError` in `domain/objects/error.ts` with a `data: DomainObjectError` field — a closed discriminated union of 7 error codes. The `extractDetail` helper uses an exhaustive `switch` over `data.code`, and TypeScript verifies that every code is handled at compile time.

Phase 2 (Object Storage) adds `StorageError` with 4 new error codes. Future phases (refs, index, diff, merge, transport) will each add their own error variants. The error system must scale without:

1. **Losing compile-time exhaustiveness checking** — the most valuable property of the current design.
2. **Creating circular imports** between domain sub-modules.
3. **Requiring modification of existing phase modules** each time a new phase is added.

Three approaches were considered:

**Option A — Widen union in `domain/objects/error.ts`:** Update `TsgitError` to accept `DomainObjectError | StorageError`. Requires `domain/objects/error.ts` to import `StorageError` from `domain/storage/error.ts`, creating a dependency from Phase 1 code on Phase 2 code. Every new phase adds another import — `domain/objects/error.ts` becomes a coupling magnet.

**Option B — Open base type `{ readonly code: string }`:** Make `TsgitError` accept any `{ readonly code: string }`. No imports needed. But TypeScript cannot exhaustively check `switch (e.data.code)` because the type is an open string. The existing `extractDetail` function breaks (non-exhaustive switch, unsafe property access). Tests asserting exhaustive narrowing must be deleted. This abandons the strongest compile-time guarantee.

**Option C — Layered union with shared `TsgitError` at `domain/error.ts`:** Extract `TsgitError` to `domain/error.ts`. Each phase module exports its error union type. `domain/error.ts` aggregates them into `TsgitErrorData = DomainObjectError | StorageError | ...` and types `TsgitError.data` as `TsgitErrorData`. Exhaustive switch checking preserved. No circular imports.

## Decision

Use **Option C**: extract `TsgitError` to `domain/error.ts` with a layered aggregate union.

### File structure after Phase 2:

```
src/domain/
├── error.ts                 # TsgitError class + TsgitErrorData aggregate + extractDetail
├── objects/
│   └── error.ts             # DomainObjectError union + factory functions
└── storage/
    └── error.ts             # StorageError union + factory functions
```

### Dependency direction:

```
domain/error.ts  ─── imports DomainObjectError from ──→  domain/objects/error.ts
       │
       └──── imports StorageError from ──→  domain/storage/error.ts
```

Both `domain/objects/error.ts` and `domain/storage/error.ts` import `TsgitError` from `domain/error.ts` for their factory functions. Neither imports the other. `domain/error.ts` imports the union type (not the factories) from both.

### Adding a new phase:

1. Create `domain/<phase>/error.ts` with the phase's error union type + factory functions.
2. Add the union type to `TsgitErrorData` in `domain/error.ts`.
3. Add cases to `extractDetail` in `domain/error.ts`.
4. Existing code and tests are unaffected.

## Consequences

### Positive

- **Exhaustive switch checking preserved.** `TsgitErrorData` is a closed union — TypeScript enforces that all codes are handled.
- **No runtime circular imports.** `domain/error.ts` uses `import type` for the union types from phase modules (erased at compile time by `verbatimModuleSyntax`). Phase modules use runtime imports for `TsgitError` from `domain/error.ts`. The emitted JavaScript has strictly unidirectional dependencies: children → parent.
- **Existing Phase 1 code minimally impacted.** `domain/objects/error.ts` only changes its import path for `TsgitError` (from local class to import from `domain/error.ts`). All factory function signatures remain identical.
- **Single catch site.** Callers catch `TsgitError` and `switch (e.data.code)` across all phases with full type narrowing.

### Negative

- **`domain/error.ts` grows with each phase.** It must import every phase's error union and add it to `TsgitErrorData`. This is a deliberate coupling point — the aggregate union is the single source of truth for all error codes.
- **`extractDetail` grows with each phase.** New switch cases must be added. This is the cost of exhaustiveness — the compiler forces the update, which is the desired behavior.
- **Refactoring Phase 1.** `TsgitError` must be moved from `domain/objects/error.ts` to `domain/error.ts`. Tests that import `TsgitError` from the barrel are unaffected (barrel re-exports). Tests that import directly from `domain/objects/error.ts` need path updates.
- **Source-level type cycle requires dependency-cruiser configuration.** At the TypeScript source level, `domain/error.ts` has bidirectional `import type` dependencies with phase error modules. These are erased at runtime and safe, but the dependency-cruiser `no-circular` rule must exclude `type-only` dependency types (`dependencyTypesNot: ['type-only']`) to avoid false positives. This is a one-time config change.

### Neutral

- The `TsgitError` class itself is unchanged — same constructor, same `name`, same `data` property. Only the location moves.
- The barrel export at `domain/objects/index.ts` continues to re-export `TsgitError` for backward compatibility.
