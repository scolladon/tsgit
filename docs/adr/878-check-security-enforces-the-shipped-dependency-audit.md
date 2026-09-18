---
subjects:
  - package.json
---
# 878 — `check:security` enforces the shipped-dependency audit

- **Status:** accepted
- **Date:** 2026-09-18
- **Design:** none (gate defect found while running the 31.2 phase boundary) · **Supersedes/Refines:** none

## Context

`check:security` was `npm audit --audit-level=high || true`. The trailing `|| true` made the
gate incapable of failing: the CI job at `.github/workflows/ci.yml:123` ran it on every pull
request and reported success unconditionally.

It was not reporting success over a clean tree. On the 31.2 branch the same audit finds **8
vulnerabilities, 7 of them high**, every one reached through `@cloudflare/vitest-pool-workers`
→ `miniflare` / `wrangler`. Those are `devDependencies`: they build and run the Workers test
project and never reach a consumer.

The distinction matters because `package.json` declares **no `dependencies` and no
`peerDependencies`**. Everything tsgit ships is its own compiled output, so the audit that
actually describes consumer risk is the production-scoped one — and that one reports zero
vulnerabilities today.

Removing `|| true` outright would have pinned the gate to the dev-tooling treadmill: chasing a
`wrangler` or `miniflare` major to clear an advisory that cannot reach a consumer, against a
package already carrying a `check:deps` exception (ADR-796) for its release cadence.

A second, independent reason the gate was silent is environmental. An `allow-scripts` entry in a
developer's user-level `~/.npmrc` makes `npm` refuse any **project-scoped** invocation with
`EALLOWSCRIPTS` — including `npm audit` run from inside an npm script, though a direct `npm
audit` in the same directory succeeds. The old `|| true` hid that too.

That entry cannot simply be removed. A globally installed tool unrelated to this repository may
legitimately need its postinstall to run — a package that ships a small launcher stub and swaps
in a platform binary during postinstall is broken by skipping it, silently, on every update.
And npm offers no config scope that covers global installs only: its chain is
cli > env > project > user > global > builtin, so any file that permits the global case also
reaches project-scoped commands. An `allowScripts` field in the project's own `package.json`
does not suppress the error either. Both were measured. A developer keeping that entry is
therefore a state this gate has to tolerate rather than fight.

## Decision

Split the audit by scope, enforce only the half that describes shipped risk, and enforce it
only where it can actually run:

```
if [ -n "$CI" ]; then npm audit --omit=dev --audit-level=high; fi && (npm audit --audit-level=high || true)
```

- The **guarded** command is the gate. It covers what consumers install and fails the build on a
  high-or-worse advisory. It passes today.
- The **trailing** command keeps the full dev-inclusive audit visible in the job log without
  blocking, so a dev-tooling advisory is still seen and can be scheduled rather than ignored.
- The `$CI` guard keeps `npm run validate` green on a workstation whose npm configuration cannot
  run a project-scoped audit at all. Enforcing there would have turned every local validate red
  for a reason that has nothing to do with dependency risk.

The parenthesised form is deliberate: writing `a && b || true` would let the `|| true` swallow a
failure of `a` as well, reinstating exactly the defect being fixed. `if … fi` propagates the
audit's exit status, so a failing audit still short-circuits the `&&`.

## Consequences

- A high-severity advisory in anything tsgit ships now turns CI red. With zero runtime
  dependencies that is a narrow surface, which is the point: the gate is small and true rather
  than broad and inert.
- Dev-dependency advisories do not block a pull request. They stay printed in the job log, and
  `check:deps` remains the mechanism that moves those versions.
- If tsgit ever takes a runtime dependency, this gate starts guarding it with no further change.
