# ADR-004: Adapter Error Codes Defined in Domain

## Status

Accepted

## Context

Phase 4 introduces port interfaces (FileSystem, HashService, Compressor, HttpTransport) and adapter implementations. Adapters can fail in platform-specific ways: file not found, network error, decompression failure, etc. These failures need a unified error type (`TsgitError`) so library consumers handle all errors consistently.

The question is where to define the `AdapterError` discriminated union:

1. **In `src/ports/error.ts`** — alongside the port interfaces that produce these errors. `domain/error.ts` would import types from `ports/error.ts` to widen `TsgitErrorData`.
2. **In `src/domain/error.ts`** — alongside all other error types. Ports and adapters import error types from the domain.

The existing architecture enforces a strict inward dependency rule via dependency-cruiser:
```
from: '^src/domain/' → to: '^src/(application|ports|adapters|operators|transport)/' → ERROR
```
This rule has zero exceptions. Even type-only imports from domain to ports would violate it.

ADR-003 established the layered union pattern (`TsgitErrorData = DomainObjectError | StorageError | ...`) with all error types defined within `src/domain/`.

## Decision

Define `AdapterError` in `src/domain/error.ts`, following the same pattern as `DomainObjectError`, `StorageError`, `RefsError`, and `IndexError`.

Error codes define a **contract** — they describe what can go wrong at the boundary between the application and the outside world. Contracts belong to the domain, even when the failures originate in infrastructure. The domain doesn't know _how_ a file is read (that's the adapter's job), but it does define _what failure modes exist_ (file not found, permission denied, etc.).

Ports and adapters import error types and factory functions from `domain/error.ts` and throw `TsgitError` instances with the appropriate error code.

## Consequences

### Positive

- Zero-exception dependency rule: `domain/` never imports from `ports/` or `adapters/`
- All error types in one location: `domain/error.ts` is the single source of truth
- Consistent with ADR-003's layered union pattern
- `extractDetail` switch statement remains in one file with all cases

### Negative

- `domain/error.ts` grows larger with 10 new error variants
- Error codes like `NETWORK_ERROR` feel more infrastructure-like than domain-like

### Neutral

- Adapters depend on domain error types — this is the correct dependency direction in hexagonal architecture (outer rings depend on inner rings)
- The same pattern would apply if additional infrastructure error codes are needed in future phases
