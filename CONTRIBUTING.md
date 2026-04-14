# Contributing to tsgit

## Development Workflow

1. Create a branch from `main`
2. Write tests first (TDD: Red → Green → Refactor)
3. Implement the feature
4. Run `npm run validate` to verify all quality gates
5. Commit using conventional commits
6. Open a PR

## Test Conventions

All tests in this project **must** follow these conventions.

### Test Title Format: Given / When / Then

Every test title describes the context, action, and expected outcome:

```typescript
it('Given <context>, When <action>, Then <expected result>', () => {
  // ...
});
```

Examples:
- `'Given empty repository, When initializing, Then .git directory is created'`
- `'Given packed object, When reading by id, Then content matches original'`
- `'Given two conflicting trees, When merging, Then conflicts are reported'`

### Test Body Format: AAA (Arrange / Act / Assert)

Every test body is structured in three sections with comments:

```typescript
it('Given empty cart, When adding item, Then cart contains one item', () => {
  // Arrange
  const sut = new Cart();
  const item = createItem('widget');

  // Act
  sut.add(item);

  // Assert
  expect(sut.count).toBe(1);
});
```

### System Under Test: `sut`

The variable being tested **must** be named `sut` (System Under Test):

```typescript
it('Given a commit object, When serializing, Then output matches git format', () => {
  // Arrange
  const sut = createCommit({
    tree: treeId,
    parents: [parentId],
    message: 'initial',
  });

  // Act
  const result = serializeCommit(sut);

  // Assert
  expect(result).toEqual(expectedBytes);
});
```

### Test Organization

```
test/
├── unit/           # Isolated tests, memory adapter, fast
├── integration/    # Real repos, cross-adapter, canonical git interop
└── e2e/            # Full workflows across platforms/browsers
```

### Coverage Requirements

| KPI | Threshold |
|---|---|
| Line coverage | 100% |
| Branch coverage | 100% |
| Function coverage | 100% |
| Statement coverage | 100% |
| Mutation score | Target: 100% (break threshold: 90%) |

## Commit Messages

Follow [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>: <description>

<optional body>
```

Types: `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`, `revert`

Examples:
- `feat: add packfile reader with delta resolution`
- `fix: correct fanout table binary search off-by-one`
- `refactor: extract tree diff into dedicated domain service`
- `test: add roundtrip tests for commit serialization`

## Code Style

- **Immutability** — All domain objects are `readonly`. Mutations produce new instances.
- **FP-first** — Pure functions, function composition, no shared mutable state.
- **Object Calisthenics** — Branded types for domain concepts. No primitive obsession.
- **Small functions** — Single responsibility. Early returns over nesting.
- **No `any`** — biome enforces `noExplicitAny`. Use `unknown` + type narrowing.
- **Kebab-case files** — Enforced by ls-lint. All `.ts` files in `src/` and `test/` are kebab-case.

## Architecture Rules

1. **Domain has zero outward imports** — `src/domain/` never imports from `application/`, `ports/`, or `adapters/`
2. **Commands use primitives** — `application/commands/` is built from `application/primitives/`
3. **Ports are interfaces only** — `src/ports/` contains no implementations
4. **Adapters implement ports** — Each adapter in `src/adapters/` implements the port interfaces

## Quality Gates

Before any PR can merge, all of these must pass:

- [ ] `npm run check` — biome lint + format
- [ ] `npm run check:types` — tsc strict compilation
- [ ] `npm run check:dead-code` — knip (no unused code)
- [ ] `npm run check:duplicates` — jscpd (no copy-paste)
- [ ] `npm run check:filesystem` — ls-lint (naming conventions)
- [ ] `npm run test:coverage` — 100% on all KPIs
- [ ] `npm run test:mutation` — Stryker (target 0 survivors)
- [ ] CI pipeline green (7 stages)
