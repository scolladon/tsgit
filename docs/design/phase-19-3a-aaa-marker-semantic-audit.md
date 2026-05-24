# Phase 19.3a — AAA-marker semantic audit

Pass-2 review of 19.3 found ~388 unit `it()` bodies in which the autofix
landed `// Arrange` directly followed by `// Assert` (or `// Act`) with **no
intermediate statement**. The markers satisfy `aaaBody` but carry no signal
— the section between two adjacent markers is empty.

Direct triage of the current main branch confirms the scope is larger than
the original estimate:

| Pattern | Count | Shape |
|---|---:|---|
| `Arrange → Assert` followed by a single statement | 264 | `// Arrange`<br>`// Assert`<br>`expect(act(...)).toBe(...)` |
| `Arrange → Act` (Act marker carries the SUT) | 116 | `// Arrange`<br>`// Act`<br>`const sut = ...` |
| `Arrange → Assert` followed by multiple statements | 138 | `// Arrange`<br>`// Assert`<br>`expect(...)` (multi) |
| **Total empty-`Arrange` sections** | **518** in 60 files | |

This phase teaches the lint to detect the pattern (gate forward) **and**
sweeps the existing offenders (cleanup back) in the same PR — same playbook
as 19.3 itself (implementation → cleanup → gate-flip).

## 1. Goals

1. **Detect empty AAA sections.** A section is "empty" when the lines
   between two AAA markers (or between a marker and end-of-body) contain
   no statement-bearing line. New gated heuristic `emptyAaaSection`.
2. **Sweep the 518 existing offenders.** Three rewrite recipes depending
   on the pattern (see §6). Atomic commits per directory keep the diff
   reviewable.
3. **Gate forward.** Flip `gating.emptyAaaSection` to `true` in the same
   PR so future regressions fail CI.
4. **Reuse the existing scanner.** Compose on `scanItBlocks`; no new
   parser, no AST switch (ADR-097 line holds).
5. **Single manifest.** Extend `test-pyramid-budgets.json` and its schema;
   no second budget file.
6. **No suppressions.** Same posture as 19.2 §5.3 / 19.3 §2: violations
   are fixed, never silenced.

## 2. Non-goals

- **No retirement of `aaaBody`.** Empty-section is a *semantic* check;
  `aaaBody` stays as the *presence* check. Two independent heuristics, two
  independent gates.
- **No reordering enforcement.** Per ADR-112 the project does not check
  marker order; this phase doesn't either.
- **No new tier or scope expansion.** Same `test/unit/**` scope.
- **No allowlist / suppression mechanism.** Same line as 19.3 §2.
- **No AST parser.** Stays regex/brace per ADR-097. Seven checks
  (six from 19.3 + one from 19.3a) is still well within the ceiling we
  agreed to revisit at.
- **No `scanItBlocks` change.** 19.3b owns `skipIf` / `runIf` support;
  19.3a does not pre-empt it.

## 3. Heuristic — empty AAA section

### 3.1 Rule

For every non-skipped unit `it()` / `test()` body, every AAA marker that
**is** present MUST be followed by at least one statement-bearing line
before the next marker (or end-of-body). A *statement-bearing line* is a
non-empty line whose first non-whitespace character is **not** `//` and
**not** a closing `}`, `)`, or `]`.

In plain English: a marker followed only by another marker, blank lines,
comments, or the test's closing punctuation is an empty section.

### 3.2 Why "marker that IS present"

`aaaBody` already enforces which markers are *required* (Arrange + Assert
by default, ADR-112). `emptyAaaSection` only inspects what's present. If
`// Act` is absent, no Act-section emptiness check fires — Act-folded-into-
assertion (ADR-112 §Decision) remains idiomatic.

Conversely, if `// Act` IS written but the section is empty, that's a
finding — the author put the marker there on purpose, so it should have
content.

### 3.3 Edge cases

- **Trailing prose on the marker line itself.** `// Arrange — sets up
  fixtures` is still the marker line; prose doesn't count as the section.
  The section starts on the *next* line.
- **End-of-body marker** (`// Assert\n});`). Closing punctuation is not a
  statement-bearing line; this is empty. Flagged.
- **Block comment between markers** (`// Arrange\n/* note */\n// Assert`).
  Block-comment lines are treated the same as line comments — not
  statement-bearing. Flagged. (Block-comment-only fixtures are vanishingly
  rare and the desired fix is the same: add a statement or drop the
  marker.)
- **Marker inside a string literal**. Same false-negative posture as
  ADR-112 — the line-anchored regex doesn't see string-internal `//`
  unless it's at line start (which would be extraordinarily contrived).
- **Compound markers** (`// Arrange + Act`). The line matches *both*
  markers per `detect-missing-aaa`. For section accounting, treat the
  compound as a single marker line; the next section starts on the line
  after.
- **`.skip` / `.todo` / `.fails`** — exempt, same as `aaaBody`.
- **Integration / e2e** — out of scope. Heuristic is `tier: unit`.

### 3.4 Algorithm

```
For each unit it() body:
  markers = lines matched by /^\s*\/\/\s*(Arrange|Act|Assert)\b/
  For i = 0 .. markers.length - 1:
    sectionStart = markers[i].line + 1
    sectionEnd   = (markers[i+1]?.line ?? bodyEnd) - 1
    if no statement-bearing line in body[sectionStart..sectionEnd]:
      emit finding { path, line: markers[i].line, marker, title }
```

The finding includes which marker introduces the empty section so the
report tells the developer exactly what to fix.

### 3.5 Detector

`tooling/test-pyramid/detect-empty-aaa-section.ts` — pure function over
`SourceFile[]`. Emits
`EmptyAaaSectionFinding { path, line, title, marker: AaaMarker }`. The
`marker` field names which AAA marker introduces the empty section so the
markdown / JSON report says "Arrange section is empty at line N" rather
than the generic "AAA finding". Pattern mirrors the five sibling
detectors (sort by `path` then `line`; line ties broken by `Arrange`
before `Act` before `Assert` so a body with two empty sections renders
deterministically).

### 3.6 Why a separate detector, not an extension of `detect-missing-aaa`

- **Independent gating.** Operators may want to gate `aaaBody` (presence)
  without gating `emptyAaaSection` (semantic) during ramp.
- **Single-responsibility per file.** Same convention as the other six
  detectors — each file owns one heuristic, one finding shape.
- **Independent regex.** `detect-missing-aaa` checks "is this marker
  present anywhere in the body?"; `emptyAaaSection` checks the *spans
  between* markers. Different shape, different file.

## 4. Manifest extension

`test-pyramid-budgets.json` gains a single heuristic entry plus a gating
key:

```json
{
  "heuristics": {
    "emptyAaaSection": { "tier": "unit" }
  },
  "gating": {
    "emptyAaaSection": true
  }
}
```

No regex, no threshold — the rule is structural (between-marker span,
statement-bearing line). Schema (`tooling/test-pyramid-budgets-schema.json`)
gains the matching entries. `parse-manifest.ts` adds `EmptyAaaSection
Heuristic` + `parseEmptyAaaSection`, extends `requiredHeuristicKeys`,
extends `GATING_KEYS`.

`makeManifest` fixture (`tooling/test/unit/test-pyramid/manifest-fixture.ts`)
adds the new heuristic with `gating.emptyAaaSection: false` default and an
override hook for tests that want to gate it on.

## 5. Tooling integration

### 5.1 Script (`tooling/audit-test-pyramid.ts`)

- Import `detectEmptyAaaSection`.
- Extend `AuditFindings` with `emptyAaaSection: ReadonlyArray<...>`.
- Extend `FINDING_KEY_BY_GATING` with
  `emptyAaaSection: 'emptyAaaSection'`.
- Wire into `runAudit.outcome.findings`.

No CLI changes. `--report-only` semantics unchanged.

### 5.2 Module structure

```
tooling/test-pyramid/
  detect-empty-aaa-section.ts   # NEW
  parse-manifest.ts             # extended
  render-report.ts              # extended (+1 finding section)
  types.ts                      # unchanged (SourceFile only)
```

Detector size budget: < 80 lines (in line with the existing five).

### 5.3 Wireit + CI

No new task. `check:test-pyramid` already exists and is wired into
`validate`. Its `files` glob covers the new detector. CI inherits the gate
flip automatically.

## 6. Sweep policy

Three patterns map to three rewrites. Each is mechanical; an automated
sweep is acceptable provided every diff is reviewed in a small atomic
commit.

### 6.1 Pattern A — single-statement after Assert

**Shape:**
```ts
// Arrange
// Assert
expect(callTheThing(...)).toBe(expected);
```

**Fix:** extract the SUT into Arrange, leaving the assertion under
Assert.
```ts
// Arrange
const sut = callTheThing(...);

// Assert
expect(sut).toBe(expected);
```

**Rationale:** the test gains a named SUT, the Arrange section becomes
non-empty, and the Assert section reads as a pure assertion. Three lines
becomes five; clarity wins.

**Alternative considered (rejected):** delete both markers. Single-line
tests would lose AAA markers and `aaaBody` would flag them. The fix would
violate the *presence* rule to satisfy the *empty* rule — a regression in
discipline. Always extract.

### 6.2 Pattern B — `Arrange → Act → const sut`

**Shape:**
```ts
// Arrange
// Act
const sut = describeError(new Error('boom'));

// Assert
expect(sut).toBe('boom');
```

**Fix:** drop the `// Act` marker. The SUT extraction belongs under
Arrange when there's no separate setup; ADR-112 says Act is optional.
```ts
// Arrange
const sut = describeError(new Error('boom'));

// Assert
expect(sut).toBe('boom');
```

**Rationale:** the Act marker added no signal — it sat on an empty
section. Removing it leaves a clean Arrange / Assert pair, which is the
project's dominant idiom (per ADR-112 motivation).

### 6.3 Pattern C — multi-statement after Assert

**Shape:**
```ts
// Arrange
// Assert
const sut = callTheThing(...);
expect(sut.code).toBe('X');
expect(sut.reason).toContain('Y');
```

**Fix:** hoist the SUT extraction into Arrange, keep the `expect()`s
under Assert.
```ts
// Arrange
const sut = callTheThing(...);

// Assert
expect(sut.code).toBe('X');
expect(sut.reason).toContain('Y');
```

**Rationale:** same as A; the SUT extraction is setup, not assertion.

### 6.4 Sweep mechanics

- One commit per directory under `test/unit/` (≈ 15–20 commits). Atomic,
  bisectable.
- Each commit message: `test(unit/<dir>): extract sut from empty-AAA
  sections`.
- Sweep is human-driven (with an optional codemod script as scaffolding).
  Even with a codemod, each commit is reviewed before landing — empty-
  section sweeps occasionally surface a test that should really collapse
  or change shape, and only a human spots that.
- The gate flip is the final commit, after every sweep commit has landed
  and CI is green.

## 7. Testing strategy

Unit tests at `tooling/test/unit/test-pyramid/detect-empty-aaa-section.test.ts`:

| Case | Expectation |
|---|---|
| Arrange + Assert, both non-empty | no finding |
| Arrange empty, Assert one statement | finding on Arrange marker |
| Arrange one statement, Assert empty (closing brace next) | finding on Assert marker |
| Arrange empty, Act one statement, Assert one statement | finding on Arrange marker only |
| Arrange empty, Assert empty (no statements at all) | findings on both Arrange and Assert markers |
| Compound `// Arrange + Act` followed by statement | no finding (single marker line, statement under it) |
| Marker followed only by another marker | finding (empty section) |
| Marker followed only by block-comment line then marker | finding (block comment is not statement-bearing) |
| Marker followed only by a closing brace | finding (closing punctuation is not statement-bearing) |
| `.skip` body with empty sections | no finding (skip exempt) |
| Integration tier file with empty sections | no finding (heuristic scoped to unit) |
| Multiple findings across files | sorted by `path` then `line` |

`scan-it-blocks.test.ts` — untouched.

`parse-manifest.test.ts` — extended:
- `emptyAaaSection` is a required heuristic key.
- Gating key `emptyAaaSection` accepted; unknown keys still rejected.
- Manifest fixture default for the new heuristic + gating.

`render-report.test.ts` — extended:
- New finding section in markdown.
- New finding key in JSON.
- Empty-array case renders `_none_`.

`audit-test-pyramid.test.ts` integration — extended:
- Fixture: a unit file with `// Arrange\n// Assert\nexpect(...);` triggers
  the heuristic.
- Gated on → exit code 1, stderr contains `emptyAaaSection`.
- `--report-only` forces exit 0.

Coverage target: 100% lines/branches/functions/statements on the new
detector. Mutation: scripts excluded per ADR-108 (same posture as 19.3).

## 8. Repository cleanup (in this PR)

Same ordering pattern as 19.3 §10:

1. **Implementation commits** — detector + scanner reuse + manifest schema
   + audit runner wiring + tests. Gating switches default-off so existing
   violations don't blow up CI mid-PR. Coverage gate stays green by the
   end of these commits because every new file is fully covered.
2. **Cleanup commits** — one per directory under `test/unit/` (≈ 15–20).
   Each commit applies the §6 sweep policy to that directory. CI on every
   commit is green because the gate is still off.
3. **Gate-flip commit** — set `gating.emptyAaaSection` to `true` in
   `test-pyramid-budgets.json`. CI on this commit must be green; if it
   isn't, a sweep commit missed a case (rewrite, re-stage, re-commit).

The empirical baseline (518 across 60 files) is large enough that the
sweep is the bulk of the PR. Reviewers can paginate one directory at a
time.

## 9. Risks & mitigations

| Risk | Mitigation |
|---|---|
| Sweep accidentally changes test semantics (e.g. extracts a SUT that captures a closure variable differently). | TDD: tests must still pass after each commit. `npm run test:unit` runs in the validation chain per commit. |
| "Statement-bearing line" misclassifies a multi-line construct (e.g. a chained call where the first line is `const sut =` and continuations follow). | The first line *is* statement-bearing (`const sut =`), so the section is non-empty. Continuation lines are irrelevant to the check. |
| Closing `}` on its own line followed by a marker is flagged as in-section. | Algorithm only inspects lines *between* markers, not the marker line itself or what precedes the first marker. Closing braces inside a marker section are correctly treated as non-statement-bearing. |
| Sweep balloons reviewer fatigue. | One commit per directory, conventional-commit subjects, short bodies. Reviewer reads one diff at a time. If the sweep exceeds 30 commits, design is revisited (codemod the recipes more aggressively). |
| Detector misses a legitimate single-line test pattern the project relies on. | The §3.3 edge-case enumeration plus the integration test exercise the common shapes. If a missed pattern surfaces during sweep, the design returns to step 1 (extend the rule before flipping the gate). |
| Codemod (if used) makes errors not caught by tests. | Sweeps are human-reviewed per commit. The codemod is scaffolding, not a substitute for review. |
| 19.3b ships and adds `skipIf` / `runIf` support, surfacing more empty-section findings. | Sweep covers what's there today; the gate catches regressions. New findings post-19.3b are addressed in that PR. |

## 10. Acceptance criteria

- `npm run check:test-pyramid` exits **1** when `emptyAaaSection` is
  gated and any unit body has an empty AAA section.
- The detector is wired in `audit-test-pyramid.ts`, the manifest schema
  is extended, and `makeManifest` carries the new heuristic.
- All 518 existing empty-section offenders are rewritten under one of
  the three §6 recipes; no `// Arrange\n// Assert` pair with no
  intermediate statement remains in `test/unit/**`.
- Cleanup commits land before the gate flip; tree is clean on green CI
  at every commit.
- Three review passes performed, harness green, mutants killed in the
  application-bucket (script tooling excluded per ADR-108).
- ADRs 114–116 recorded for the user-shaped choices (see §11).
- `CONTRIBUTING.md` (the "Gating" subsection of "Testing-pyramid audit")
  mentions the new rule alongside the other five expressiveness heuristics.
  No README change (README does not yet enumerate the lints). No
  `docs/understand/testing.md` page exists today; no new page is created
  here either.
- `docs/BACKLOG.md` 19.3a flipped `[ ]` → `[x]` inside this PR's commits.

## 11. ADRs to record

Design-shaping decisions that warrant an ADR before implementation lands
(same precedent as 19.3 ADRs 109–113):

- **ADR-114** — hybrid posture: detect *and* sweep in the same PR (option
  (a) + option (b) from the BACKLOG, not one or the other). Captures why
  the BACKLOG's `or` resolves to `and` in practice.
- **ADR-115** — empty-section grammar: "statement-bearing line" definition
  (non-empty, first non-whitespace not `//`, not closing bracket), only
  markers present are checked, compound markers treated as a single
  marker line.
- **ADR-116** — sweep policy: extract `sut` for Pattern A and C, drop
  `// Act` for Pattern B. Document the alternative (delete markers) and
  why it was rejected.

## 12. Decisions deferred / out of scope

- **Codemod tooling for the sweep.** Helpful but not required; if a
  reviewer prefers manual fixes per commit, that's fine. Either way the
  diff per commit is small and reviewed.
- **Reordering enforcement.** Same as ADR-112: out of scope without true
  control-flow analysis.
- **`scanItBlocks` two-stage call support** (`skipIf` / `runIf`) — owned
  by 19.3b.
- **Empty-section detection for integration tests.** Out of scope; if
  19.4's integration audit promotes `overMockedIntegration` to gating and
  surfaces a related semantic gap, address it there.
