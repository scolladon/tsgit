# 670 — The ownership gate is POSIX-only; Windows is a named gap

- **Status:** accepted
- **Date:** 2026-08-19
- **Design:** docs/design/ownership-trust-gate.md (candidate D2) · **Refines:** ADR-226

## Context

`process.getuid()` is undefined on Windows. git-for-windows does not skip the check there — it
uses a file-security-descriptor owner check (`GetNamedSecurityInfo`-class). That behaviour
**could not be measured**: no Windows host was available to this run, and the prime directive
forbids designing external behaviour from memory.

CI runs the unit matrix on `windows-latest`, so the choice is observable in this repository's
own test fleet.

## Options considered

1. **POSIX-only** — the node shim wires the capability only when `process.getuid` exists;
   Windows repositories are trusted, and the gap is recorded (design recommendation) — pros:
   names the gap instead of inventing behaviour / cons: Windows callers get no gate.
2. **Implement a Windows owner check** — pros: closes the gap / cons: needs a native call that
   tsgit's zero-dependency, browser-portable constraint rules out, and would be written against
   unmeasured behaviour.
3. **Treat Windows as untrusted-unless-allowlisted** — pros: fails safe / cons: inverts the
   default on a platform where nothing can ever be allowlisted correctly, breaking every
   Windows caller and the `windows-latest` matrix.

## Decision

**Option 1 — adopted as recommended (no user judgment).**

The ownership predicate is wired only where `process.getuid` exists. On Windows the capability
is omitted, so by ADR-669 every repository is trusted. This is a divergence from git, and it is
recorded as a gap that a future Windows-hosted measurement can close — not as a behaviour
invented to fill it.

## Consequences

- `docs/understand/security.md` must state the platform gap explicitly under repository trust,
  and the ADR is the referenced record.
- The `windows-latest` unit matrix exercises the capability-omitted path, which is the same path
  the sandbox adapters take.
- Closing this needs a measurement, not a design: someone with a Windows host must pin
  git-for-windows' refusal bytes and its owner predicate first.
