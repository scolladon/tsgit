---
subjects:
  - src/application/commands/status.ts
---
# 962 — `GIT_OPTIONAL_LOCKS` is honoured through the context env

- **Status:** accepted
- **Date:** 2026-10-14
- **Design:** docs/design/status-refresh-index-extensions.md · **Supersedes/Refines:** refines ADR-958

## Context

git's `use_optional_locks()` reads `GIT_OPTIONAL_LOCKS` with its boolean grammar: a false value
suppresses the optional lock (pins P4, P9), and an unparsable value is fatal (exit 128, `bad boolean
environment value`). IDE integrations set it to keep background `status` calls from writing.

## Options considered

1. **Honour it through `ctx.env`** — false wins over `refresh: true`; an invalid value refuses `status`
   with structured data (recommended).
2. **Ignore it** — the option only.
3. **Honour it, treat an invalid value as unset.**

## Decision

**Adopted-as-recommended (no user judgment) — option 1.** `status` reads `GIT_OPTIONAL_LOCKS` through
`ctx.env` with git's boolean grammar. A false value disables the refresh write even when
`refresh: true` is passed. An invalid value refuses `status` with structured data naming the variable
and the value. Aligns with ADR-226.

## Consequences

- A tsgit embedded under `GIT_OPTIONAL_LOCKS=0` writes no more than git would.
