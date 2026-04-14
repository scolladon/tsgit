# tsgit — Project Instructions

## What is this?

A pure TypeScript git library. Lightning-fast, portable (Node.js + browser), zero dependencies.

## Architecture

Hexagonal architecture with tiered application layer:

```
src/
├── domain/           # Pure core — zero outward deps
├── application/
│   ├── commands/     # Tier 1 — high-level use cases (clone, log, status...)
│   └── primitives/   # Tier 2 — low-level composable ops (readObject, walkCommits...)
├── ports/            # Interfaces only (FileSystem, HttpTransport, HashService, Compressor)
├── adapters/         # Platform implementations (node, browser, memory)
├── operators/        # AsyncIterable composition (pipe, filter, map, take...)
├── transport/        # Transport middleware (retry, auth, logging)
├── repository.ts     # Tier 1 facade — openRepository()
└── index.ts
```

**Dependency rule:** `repository → commands → primitives → domain`. Ports sit between application and adapters. Domain never imports outward.

## Key Commands

```bash
npm run validate      # Full quality gate — run before committing
npm run check         # Biome lint + format
npm run check:types   # TypeScript strict check
npm run test:unit     # Unit tests
npm run test:coverage # 100% coverage enforcement
npm run test:mutation # Stryker mutation testing
npm run build         # Compile to dist/
```

## Test Conventions

- **Titles:** `Given <context>, When <action>, Then <expected>`
- **Body:** AAA — Arrange / Act / Assert with section comments
- **Variable:** System under test is always named `sut`
- **Coverage:** 100% line, branch, function, statement
- **Mutations:** Target 0 surviving mutants

## Code Style

- FP-first: pure functions, immutable data, composition
- Object Calisthenics for domain: branded types (ObjectId, RefName, FilePath), no primitives crossing boundaries
- No `any` — biome enforces this. Use `unknown` + narrowing.
- Kebab-case files — enforced by ls-lint
- Small functions (<20 lines), early returns, no deep nesting
- Immutability — never mutate, always create new

## Domain Invariants

- All git objects are `readonly` discriminated unions
- ObjectId, RefName, FilePath are branded string types
- Domain code has zero platform dependencies
- Commands are built from primitives (same building blocks users get)

## Performance Priorities

1. Fanout binary search for pack index
2. LRU delta base cache
3. Zero-copy DataView parsing
4. Streaming inflate (no full-buffer)
5. Stat-cache for working tree
6. Platform-optimized hashing (SubtleCrypto / node:crypto)
7. Parallel I/O with bounded concurrency

## Development Workflow (MANDATORY)

Every feature follows this sequence. No exceptions. No skipping steps.

### 1. Design (`docs/design/`)

Before any code, create a design document in `docs/design/`. The design covers:
- TypeScript types and interfaces
- Binary/wire format details (if applicable)
- Function signatures and contracts
- Module structure and file layout
- Testing strategy (unit, property-based, interop)
- Key design decisions with rationale

### 2. ADR (`docs/adr/`) — when choosing between alternatives

If the design requires choosing between multiple valid approaches, create an ADR **before** deciding:
- Use the template at `docs/adr/000-template.md`
- Number sequentially: `docs/adr/NNN-title.md`
- Include the current main SHA in the Status section: `Accepted (at <sha>)`
- Document context, decision, and consequences (positive, negative, neutral)

### 3. Plan (`docs/plan/`)

Create an implementation plan that breaks the design into TDD steps:
- Ordered list of files to create/modify
- Each step: what to test first, what to implement, what to verify
- Dependencies between steps

### 4. Implement (TDD)

Follow the plan step by step:
- **Red**: Write the test first. It must fail.
- **Green**: Write minimal code to pass the test.
- **Refactor**: Clean up while keeping tests green.
- Run `npm run validate` before committing.

### 5. Track progress

Update `docs/BACKLOG.md` after each completed item:
- `[ ]` → `[~]` when starting
- `[~]` → `[x]` when done

### Workflow summary

```
BACKLOG.md → design/ → (adr/ if needed) → plan/ → implement (TDD) → BACKLOG.md ✓
```

**Never skip design. Never code without a plan. Never choose without an ADR.**

## Docs

- `docs/BACKLOG.md` — V1 roadmap and progress tracker
- `docs/prd/` — Product requirements
- `docs/design/` — Technical design documents (one per phase/subsystem)
- `docs/plan/` — Implementation plans (step-by-step TDD sequences)
- `docs/adr/` — Architecture decision records (when choosing between alternatives)
- `docs/spike/` — Technical spike findings (research before design)
