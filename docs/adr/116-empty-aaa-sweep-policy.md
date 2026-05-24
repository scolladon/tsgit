# ADR-116: Empty-AAA sweep policy — extract `sut`, drop redundant `// Act`

## Status

Accepted (at `4db24d2`)

## Context

19.3a's sweep covers ~518 empty-section offenders across 60 test files
in 20 directories. The offenders fall into three shapes (counts from
the design's §1 triage table):

- **Pattern A — single statement after Assert** (264 cases):
  `// Arrange\n// Assert\nexpect(act(...)).toBe(...)`
- **Pattern B — Act marker carries the SUT** (116 cases):
  `// Arrange\n// Act\nconst sut = ...\n// Assert\nexpect(sut)...`
- **Pattern C — multi-statement after Assert** (138 cases):
  `// Arrange\n// Assert\nconst sut = ...\nexpect(sut)...`

For each pattern we need a deterministic rewrite recipe so the sweep
is mechanical (and, if needed, codemod-able).

## Decision

### Pattern A — extract `sut` into Arrange

```ts
// before
// Arrange
// Assert
expect(callTheThing(x, y)).toBe(expected);

// after
// Arrange
const sut = callTheThing(x, y);

// Assert
expect(sut).toBe(expected);
```

### Pattern B — drop the `// Act` marker

```ts
// before
// Arrange
// Act
const sut = describeError(new Error('boom'));

// Assert
expect(sut).toBe('boom');

// after
// Arrange
const sut = describeError(new Error('boom'));

// Assert
expect(sut).toBe('boom');
```

### Pattern C — hoist `sut` extraction into Arrange

```ts
// before
// Arrange
// Assert
const sut = callTheThing(x);
expect(sut.code).toBe('X');
expect(sut.reason).toContain('Y');

// after
// Arrange
const sut = callTheThing(x);

// Assert
expect(sut.code).toBe('X');
expect(sut.reason).toContain('Y');
```

### Alternative considered (rejected) — delete markers

For Pattern A, "delete both `// Arrange` and `// Assert`" would also
fix the empty section — there are no markers, so no empty sections.

Rejected because:

- **It violates `aaaBody`** (ADR-112). `aaaBody` requires `// Arrange`
  and `// Assert` on every non-skipped unit body. Deleting markers
  fixes one lint by breaking another — a net regression in discipline.
- **It removes signal.** The marker tells a reader "this is the
  arrangement step." A statement with no marker is anonymous; the test
  is harder to scan.
- **It's inconsistent with the project's posture.** CLAUDE.md
  prescribes the AAA grammar; the lint enforces it. The sweep should
  reinforce the convention, not erode it.

Always extract `sut`, even at the cost of three lines becoming five.

### Sweep mechanics

- **One commit per directory** under `test/unit/`. The commit subject
  follows conventional commits: `test(unit/<dir>): extract sut from
  empty-AAA sections`.
- **Tests must pass per commit.** `npm run test:unit` (or `npm run
  validate` if the scope demands) gates each commit.
- **Codemod is optional scaffolding.** A small script may apply the
  three recipes mechanically; the human reviewer still reads each
  diff. The codemod is a productivity tool, not a substitute for
  judgment.

## Consequences

### Positive

- **Net signal increase.** Every formerly-empty section becomes a
  named SUT extraction; readers see the test's shape at a glance.
- **Three recipes, no judgment calls.** A reviewer (or a codemod) can
  apply the right recipe by inspecting the body.
- **Atomic per-directory commits.** Reviewers paginate; a regression
  in one directory doesn't block the rest.

### Negative

- **Verbosity.** Three-line tests become five-line tests. Accepted —
  the gain in named SUT outweighs the line cost.
- **Pattern B drops the `// Act` marker** which some authors may have
  wanted as a navigation aid. Accepted — ADR-112 already says Act is
  optional; if a maintainer wants it back later, they can add it.
- **Risk of misreading a multi-line construct as a "statement" when
  it's actually a continuation.** Mitigated by per-commit `npm run
  test:unit`.

### Neutral

- The sweep is the bulk of the PR's diff. The implementation +
  gate-flip commits are small; the PR body should call out the
  per-directory commit walk so reviewers know where the substance
  lives.
- If a sweep commit reveals a test that should genuinely change shape
  (not just be reformatted), the sweep stops and the test is handled
  separately. Don't blend semantics changes into a formatting sweep.
