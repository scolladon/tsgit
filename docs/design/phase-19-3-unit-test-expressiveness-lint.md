# Phase 19.3 — Unit-test expressiveness lint

Wave 0 continuation. 19.2 stood up the report-only test-pyramid audit; 19.3
turns the same machinery into a **gate** on the four discipline rules the
project already enforces by hand:

1. `Given <ctx>, When <act>, Then <expected>` titles.
2. AAA body comments (`// Arrange`, optional `// Act`, `// Assert`).
3. `sut` naming for the system under test (no synonym aliases).
4. Ban `.toThrow(Class)` / `.toThrowError(Class)` without a data assertion.

19.3 also promotes the **under-asserted unit** heuristic from 19.2 to gating —
that promotion is the path 19.2 explicitly handed forward (§2, ADR-104). The
**over-mocked integration** heuristic stays report-only; its promotion ships
with 19.4.

## 1. Goals

1. **Gate the four new heuristics on every PR.** Exit non-zero on any finding.
2. **Promote under-asserted unit (19.2) to gating** in the same step.
3. **Reuse the 19.2 scanner.** Extract the `scanItBlocks` helper from
   `detect-under-asserted.ts` into a shared module so the new detectors
   compose on the same brace/paren parser.
4. **Single manifest.** Extend `test-pyramid-budgets.json` rather than add a
   second budget file — one source of truth (ADR matches 19.2 §6.2).
5. **Clean up violations in the same PR.** Per 19.2 §5.3 ("no suppression
   mechanism"), heuristic findings are fixed in the test, not silenced.

## 2. Non-goals

- **No new tier or scope expansion.** 19.3 only inspects `test/unit/**`. The
  integration and e2e tiers keep their 19.2 treatment.
- **No promotion of `overMockedIntegration` to gating.** That's 19.4's job
  (the BACKLOG explicitly partitions the two gates).
- **No AST parser.** Per ADR-097 the project favours a regex/brace scanner;
  the same line holds here. Switch to TypeScript's compiler API only if the
  heuristic catalogue grows past five distinct checks.
- **No allowlist / suppression mechanism.** If a finding is wrong, fix the
  heuristic. If it's right, fix the test. Same posture as the doc-link
  checker (ADR-095) and 19.2 (§5.3).
- **No discovery of new vitest test forms.** `it`, `test`, plus `.skip`,
  `.todo`, `.fails`, `.each` modifiers — same set 19.2 already handles.
- **No runtime / mutation-testing changes.** Scripts stay excluded from
  Stryker per ADR-108.

## 3. Heuristic — GWT title format

### 3.1 Rule

Every non-skipped `it(...)` / `test(...)` block in `test/unit/**/*.test.ts`
MUST carry a title matching:

```
^Given .+?, When .+?, Then .+$
```

Comma-separated, all three clauses present, case-sensitive. `.skip` /
`.todo` / `.fails` blocks are still validated — title expressiveness is
independent of run status.

### 3.2 Edge cases

- **`it.each([...])('title', body)`** — the literal template string is the
  title. The same regex applies. Row labels embedded as `$0`/`$key`
  placeholders are part of the literal and don't affect the match.
- **Template literals** — backtick-quoted titles are honoured by the same
  regex (the scanner already extracts string contents in 19.2).
- **No title (call shape `it(() => ...)`)** — flagged as a separate finding
  with title rendered as `<missing>`; the convention is that every test has
  a literal title.
- **Property-based tests** (`'Property: ...'`) — same rule. Convert to GWT.
  Project count today is < 5 such titles; trivial to migrate.
- **Commas inside clauses** (`'Given a, b, c, When …, Then …'`) — the
  reluctant `.+?` quantifiers match the shortest prefix before each
  literal `, When ` / `, Then `. False negatives only occur if a clause
  itself contains the literal sub-string `, When ` or `, Then ` (rare;
  accepted).

### 3.3 Detector

`scripts/test-pyramid/detect-bad-title.ts` — pure function over the parsed
`ItBlock` list. Emits `BadTitleFinding { path, line, title, reason }` where
`reason` is one of `'missing'`, `'malformed'`.

## 4. Heuristic — AAA body comments

### 4.1 Rule

Every non-skipped unit `it()` body MUST contain the line-comment markers
`// Arrange` and `// Assert`. `// Act` is recommended but **not required**
(some assertions act on the SUT in the same expression, e.g.
`expect(Object.isFrozen(sut))`).

### 4.2 Regex

Per marker: `(?:^|\n)\s*\/\/\s*(Arrange|Act|Assert)\b` — anchored at line
start (`\s*` swallows indentation), `\b` permits trailing prose
(`// Assert — covers all three`) but rejects compound words
(`// Assertion`). Comments may appear in any order; what matters is
presence, not sequencing. (Order is enforced socially by the project; a
machine check that a test follows the natural Arrange → Act → Assert flow
is brittle without true control-flow analysis.)

Block-comment markers (`/* Arrange */`) are not honoured. The project's
codebase uses `//` exclusively for AAA labels; constraining to one form
keeps the regex tight. Documented limitation.

### 4.3 Detector

`scripts/test-pyramid/detect-missing-aaa.ts` — emits
`MissingAaaFinding { path, line, title, missing: ('Arrange' | 'Assert')[] }`.
`missing` lists the absent markers so the report tells the developer exactly
what to add.

## 5. Heuristic — `sut` naming

### 5.1 Rule

In a unit `it()` body, declaring a variable with a banned SUT synonym is a
finding. Banned synonyms:

```
subject, objectUnderTest, systemUnderTest, cut
```

`sut` itself is allowed (it's the convention). Other names (`actual`,
`result`, `expected`, `sink`, fixture names) are **not** banned — they're
collaborators or assertions, not the SUT. The rule is a deny-list, not an
allow-list: the project's history of test names is too varied to
exhaustively enumerate everything that may legitimately appear, but the
four banned names are unambiguous SUT synonyms.

### 5.2 Regex

`\b(?:const|let|var)\s+(subject|objectUnderTest|systemUnderTest|cut)\b`

Anchored at declaration sites. Reading a variable named `subject` from a
test helper is *not* flagged (the convention applies to the test author's
own declarations).

Destructuring forms (`const { subject } = ...`) — out of scope. If a
collaborator returns an object with a `subject` key the test author can use
it directly; the heuristic only catches *new* declarations. Documented as a
known false negative.

### 5.3 Detector

`scripts/test-pyramid/detect-banned-sut-name.ts` — emits
`BannedSutFinding { path, line, title, alias }`.

## 6. Heuristic — bare-class `toThrow`

### 6.1 Rule

In any unit test body, the pattern
`.toThrow(Identifier)` or `.toThrowError(Identifier)` where `Identifier`
starts with an uppercase letter (PascalCase = class) is a finding. The fix
is to assert on error data instead:

- `.toThrow('expected message')` — string match.
- `.toThrow(/expected pattern/)` — regex match.
- `.toThrow(expect.objectContaining({ data: { code: 'X' } }))` — data match.
- `try { sut() } catch (e) { expect(e.data.code).toBe('X') }` — try/catch.

### 6.2 Regex

`\.toThrow(?:Error)?\s*\(\s*([A-Z]\w*)\s*\)`

Capture group is the bare class identifier. Surfaced in the finding so the
developer sees which assertion to fix.

Allowed forms (matched-but-not-flagged): string literal, regex literal,
object literal, `expect.<matcher>(...)` chained call, identifier wrapped in
something else (`new Foo()`, `Foo.message`, etc.). The regex only matches
when the *only* argument is a bare identifier — anything before the closing
`)` other than whitespace falls outside the pattern.

### 6.3 Detector

`scripts/test-pyramid/detect-bare-class-throw.ts` — emits
`BareClassThrowFinding { path, line, identifier }`.

## 7. Manifest extension

`test-pyramid-budgets.json` gains a `expressiveness` object inside
`heuristics`:

```json
{
  "tiers": [ /* unchanged */ ],
  "heuristics": {
    "overMockedIntegration": { /* unchanged — still report-only */ },
    "underAssertedUnit":     { /* unchanged shape — now gating */ },
    "gwtTitle":              { "tier": "unit", "regex": "^Given .+?, When .+?, Then .+$" },
    "aaaBody":               { "tier": "unit", "required": ["Arrange", "Assert"] },
    "sutNaming":             { "tier": "unit", "banned": ["subject", "objectUnderTest", "systemUnderTest", "cut"] },
    "bareClassToThrow":      { "tier": "unit", "regex": "\\.toThrow(?:Error)?\\s*\\(\\s*([A-Z]\\w*)\\s*\\)" }
  },
  "gating": {
    "underAssertedUnit": true,
    "gwtTitle":          true,
    "aaaBody":           true,
    "sutNaming":         true,
    "bareClassToThrow":  true,
    "overMockedIntegration": false
  }
}
```

The `gating` object is the single switch that controls exit code. Each
heuristic key gates independently. A heuristic missing from `gating`
defaults to **false** (report-only) so adding a heuristic doesn't silently
gate.

JSON Schema (`scripts/test-pyramid-budgets-schema.json`) updated to match.
Runtime validation in `parse-manifest.ts` extended to validate the new
shapes — same hand-rolled checker pattern as 19.2.

## 8. Tooling

### 8.1 Script — `scripts/audit-test-pyramid.ts`

The existing entry point gains a new pass: after `runAudit` builds the
`AuditOutcome`, the runner computes `gatingExitCode` from the manifest's
`gating` map intersected with the populated finding arrays. Exit is `0`
when no gating heuristic produced findings, `1` otherwise (including
manifest / filesystem errors, which already exit `1` today — no
distinguishing code is introduced).

A new CLI flag `--report-only` forces exit `0` regardless of findings —
useful for local exploratory runs and during the cleanup commit sequence.

### 8.2 Module structure

```
scripts/
  audit-test-pyramid.ts                    # entry, extended runner
  test-pyramid/
    classify-test-file.ts                  # (unchanged)
    count-tier-files.ts                    # (unchanged)
    detect-over-mocked.ts                  # (unchanged)
    detect-under-asserted.ts               # body extracted to scan-it-blocks
    scan-it-blocks.ts                      # (new) shared paren/brace scanner
    detect-bad-title.ts                    # (new)
    detect-missing-aaa.ts                  # (new)
    detect-banned-sut-name.ts              # (new)
    detect-bare-class-throw.ts             # (new)
    parse-manifest.ts                      # (extended)
    render-report.ts                       # (extended — new finding sections)
    types.ts                               # (extended — new finding shapes)
test-pyramid-budgets.json                  # (extended)
scripts/test-pyramid-budgets-schema.json   # (extended)
```

Each new detector is < 80 lines, pure, independently unit-testable.

### 8.3 Wireit + CI

No new wireit task — `check:test-pyramid` already exists and is wired into
`validate`. The existing `files` glob covers the new modules. The CI job
inherits the new exit-code behaviour automatically; the workflow YAML stays
unchanged.

## 9. Testing strategy

Unit tests live under `test/unit/scripts/test-pyramid/`. Each new detector
gets its own file, with cases covering:

- **`detect-bad-title.test.ts`** — well-formed GWT, missing `When`, missing
  `Then`, lowercase `given`, missing title (arrow-only `it`), `.each`
  template literal, multi-line opener, `.skip` / `.todo` (still validated).
- **`detect-missing-aaa.test.ts`** — both markers present, only `// Arrange`,
  only `// Assert`, both missing, marker inside a string literal (false
  positive accepted under regex-only — documented), trailing prose
  (`// Assert — covers ...`), markers with extra indentation.
- **`detect-banned-sut-name.test.ts`** — each of the four banned synonyms,
  `sut` itself (no finding), destructured `const { subject }` (no finding,
  documented limitation), banned name appearing only as a property access
  (no finding).
- **`detect-bare-class-throw.test.ts`** — `.toThrow(Foo)`, `.toThrowError(Foo)`,
  `.toThrow('msg')` (no finding), `.toThrow(/re/)` (no finding),
  `.toThrow(expect.objectContaining(...))` (no finding), `.toThrow(new Foo())`
  (no finding — the heuristic catches *bare* class refs, not constructions).

`scan-it-blocks` keeps the existing test coverage from
`detect-under-asserted.test.ts` (which gets a rename to
`scan-it-blocks.test.ts` plus a thinner `detect-under-asserted.test.ts`
focused on assertion counting).

`parse-manifest.test.ts` extended for the new heuristic shapes and the
`gating` object.

`audit-test-pyramid.test.ts` integration test extended with:
- A fixture that triggers each new heuristic; assert exit code = `1` and
  finding sections present in markdown / JSON outputs.
- `--report-only` flag forces exit `0`.

Coverage target: 100% lines/branches/functions/statements on every new file
under `scripts/test-pyramid/**`. Mutation: scripts excluded per ADR-108
(same posture as 19.2).

## 10. Repository cleanup (in this PR)

Ordering matters. The cleanup commits land first; the gating-flip commit
lands last. Each cleanup commit keeps CI green because gating is still off
until the final commit.

1. **Implementation commits** (TDD): tests + detectors + scanner extraction
   + manifest schema + extended audit runner — gating switches all
   default-off so existing violations don't blow up CI mid-PR.
2. **Cleanup commits** (one per heuristic): convert non-GWT titles, add
   missing AAA markers, rename SUT synonyms, replace bare-class `toThrow`,
   add assertions to under-asserted blocks.
3. **Gate-flip commit**: set `gating.gwtTitle`, `gating.aaaBody`,
   `gating.sutNaming`, `gating.bareClassToThrow`, `gating.underAssertedUnit`
   to `true` in `test-pyramid-budgets.json`. CI on this commit must be
   green; if it isn't, a previous cleanup commit missed a case.

Empirical baseline (to be confirmed during step 5) — the project follows
these conventions by hand already, so cleanup is expected to be small
(≈10–50 tests touched). If the count exceeds ~100 the design is
revisited (regex too aggressive, or a follow-up ADR justifying a
ratchet allowlist).

## 11. Risks & mitigations

| Risk | Mitigation |
|---|---|
| Regex over-flags titles that legitimately deviate (e.g. a future "Property: …" testing tier). | The escape valve is the title literal — rewrite the title. Tier-specific patterns are deferred to 19.4 / property-test phase 19.6. |
| AAA marker matching inside string literals or template literals produces a false negative. | Acceptable: line-anchored `^\s*//` won't match string-internal `//` unless followed by `Arrange|Act|Assert` at line start. Documented as a known false negative. |
| Destructuring (`const { subject } = ...`) bypasses the sut-naming check. | Documented as a known false negative; rare in this project's style. Promote to declaration-aware scan if it becomes load-bearing. |
| `.toThrow(IdentifierLowercase)` (a string variable, e.g. `.toThrow(expected)`) bypasses the bare-class check. | Intentional: lowercase identifiers may be a runtime string the test computed. The rule targets PascalCase only to stay specific. |
| Exit-code change in `audit-test-pyramid.ts` breaks downstream consumers. | The only consumer is the wireit chain, which already handles non-zero exit. The new flag `--report-only` preserves the old behaviour for ad-hoc invocations. |
| Cleanup PR balloons in size. | Atomic commits per heuristic let reviewers paginate. If a heuristic produces > 100 findings the design is revisited (regex too aggressive, or a new ADR justifying an allowlist). |
| AAA markers in lowercase (`// arrange`) won't match. | Intentional — CLAUDE.md prescribes `Arrange / Act / Assert` (capitalised). Case-sensitivity keeps the rule unambiguous; if a test uses lowercase, fix it. |

## 12. Acceptance criteria

- `npm run check:test-pyramid` exits **1** when any gated heuristic produces
  findings; **0** when clean; **0** with `--report-only` regardless.
- All four new heuristics + the promoted `underAssertedUnit` are wired and
  gating on the branch.
- Reports (`reports/test-pyramid.{json,md}`) include sections for each new
  finding type.
- Repository cleanup commits land before the lint flips to gating in
  `validate` (i.e. tree is clean on green CI).
- ADRs 109–113 recorded for each user-shaped choice (see §13).
- README, CONTRIBUTING, and `docs/understand/testing.md` reference the new
  rules.
- `docs/BACKLOG.md` 19.3 flipped `[ ]` → `[x]` inside this PR's commits.
- Three review passes performed, harness green, mutants killed in the
  application-bucket (script tooling excluded per ADR-108).

## 13. ADRs to record

Design-shaping decisions that warrant an ADR before implementation lands
(same precedent as 19.2 ADRs 104–108 which captured design choices, not
verbatim user inputs):

- **ADR-109** — gating posture: per-heuristic `gating` map, default-off,
  19.2's `underAssertedUnit` promoted to gating, `overMockedIntegration`
  stays report-only.
- **ADR-110** — `sut` naming enforced via deny-list of four synonyms, not
  an allow-list.
- **ADR-111** — bare-class `toThrow` ban; PascalCase-identifier-only match
  to keep the rule specific.
- **ADR-112** — AAA marker grammar (line-anchored `//`, `Arrange` and
  `Assert` required, `Act` optional, case-sensitive).
- **ADR-113** — GWT title regex (comma-separated, three clauses, no
  property-test escape hatch; convert non-GWT titles in the same PR).

Each ADR captures context, decision, alternatives considered, and
consequences in the same shape as ADRs 104–108.

## 14. Decisions deferred / out of scope

- **PR-comment posting** — still an artifact-only flow. The 19.2 deferral
  carries forward.
- **Per-`it()` block tier weighting** — same as 19.2; file-count is the
  budgeting granularity for ratio purposes.
- **AST parser switch** — staying on regex/brace for parity with the rest
  of `scripts/test-pyramid/**`. Six checks (two from 19.2 + four from
  19.3) is still tractable. Revisit when 19.4 adds further heuristics or
  when a heuristic genuinely requires control-flow analysis.
- **`overMockedIntegration` gating** — owned by 19.4.
