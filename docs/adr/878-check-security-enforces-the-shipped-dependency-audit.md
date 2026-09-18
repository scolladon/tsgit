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

A local wrinkle was diagnosed at the same time and is *not* the reason for this decision. An
`allow-scripts` entry in a developer's user-level `~/.npmrc` makes every project-scoped `npm`
invocation fail `EALLOWSCRIPTS`, which the old `|| true` also hid — so the gate was doubly
silent on that machine. That belongs in the developer's npm configuration (pass
`--allow-scripts=<pkg>` on the global install instead), not in this gate.

## Decision

Split the audit by scope and enforce only the half that describes shipped risk:

```
npm audit --omit=dev --audit-level=high && (npm audit --audit-level=high || true)
```

- The **first** command is the gate. It covers what consumers install and fails the build on a
  high-or-worse advisory. It passes today.
- The **second** keeps the full dev-inclusive audit visible in the job log without blocking,
  so a dev-tooling advisory is still seen and can be scheduled rather than ignored.

The parenthesised form is deliberate: writing `a && b || true` would let the `|| true` swallow a
failure of `a` as well, reinstating exactly the defect being fixed.

## Consequences

- A high-severity advisory in anything tsgit ships now turns CI red. With zero runtime
  dependencies that is a narrow surface, which is the point: the gate is small and true rather
  than broad and inert.
- Dev-dependency advisories do not block a pull request. They stay printed in the job log, and
  `check:deps` remains the mechanism that moves those versions.
- If tsgit ever takes a runtime dependency, this gate starts guarding it with no further change.
