# ADR-111: Ban bare-class `.toThrow(Class)` / `.toThrowError(Class)`

## Status

Accepted (at `36975ef`)

## Context

CLAUDE.md prescribes specific error assertions:

> **Error assertions must be specific:** Never use `toThrow(ErrorClass)`
> alone — always assert the error's data (code, reason, value).
> StringLiteral mutants survive generic type-only checks.

Concretely, `.toThrow(TsgitError)` survives a mutation that changes the
error's `data.code` value, because vitest's `toThrow` accepts the class
match without inspecting payload. The project's `TsgitError` carries a
typed discriminated `data` field; tests that only assert on the class
miss the bulk of the behavioural contract.

The detector must catch the bare-class form without rejecting the legal
shapes:

- `.toThrow('string')` — string substring match (already specific).
- `.toThrow(/regex/)` — regex match (already specific).
- `.toThrow({ message: '...' })` — partial object match (already
  specific).
- `.toThrow(expect.objectContaining({ data: { code: 'X' } }))` — the
  recommended fix shape.
- `try { sut(); } catch (e) { expect(e.data.code).toBe('X') }` — also
  recommended.

## Decision

Match `.toThrow(Identifier)` / `.toThrowError(Identifier)` where the only
argument is a PascalCase identifier (`[A-Z]\w*`). The full regex:

```
\.toThrow(?:Error)?\s*\(\s*([A-Z]\w*)\s*\)
```

The capture group surfaces the offending class name in the finding.

PascalCase-only is deliberate:

- Lowercase identifiers (`.toThrow(expected)`, `.toThrow(message)`) may
  be runtime strings — exempting them avoids false positives.
- `new SomeError(...)` is exempted by the `\s*\)` anchor (the `(` after
  the class name breaks the match).
- `SomeError.message`, `SomeError as any` — same; trailing tokens break
  the match.

## Consequences

### Positive

- **Targets the exact mutation gap CLAUDE.md calls out.** Once gated,
  the convention is mechanically enforced.
- **Specific enough to be safe** — only PascalCase + bare identifier
  matches, which is unambiguously the broken pattern.
- **Self-documenting findings** — the report names the class so the
  developer sees what to replace.

### Negative

- **Detection is purely lexical.** A test that captures the class in a
  variable first (`const Err = TsgitError; expect(fn).toThrow(Err)`)
  bypasses the check. Accepted: vanishingly rare in practice, and the
  fix is to inline + add data assertion anyway.
- **Cleanup work scales with the number of existing violations.** The
  19.3 PR includes the cleanup commits; if the count is unexpectedly
  large the design is revisited.

### Neutral

- The rule does not require a specific assertion shape — it just bans
  the broken one. Developers pick whichever data-assertion form fits
  the test (try/catch, `expect.objectContaining`, string match, etc.).
