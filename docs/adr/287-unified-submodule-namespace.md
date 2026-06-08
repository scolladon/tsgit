# ADR-287: Unified `repo.submodule` namespace; remove flat `repo.submodules`

## Status

Accepted (at `7b8a65cd`)

## Context

The submodule read side shipped (17.5, ADR-083) as a flat, action-discriminated
command: `repo.submodules({ action: 'list' })` returning `{ kind: 'list',
entries }`. ADR-083 anticipated future verbs (`status`, `summary`) via the
`action`/`kind` discriminator.

Meanwhile the four other multi-verb CRUD families — `remote`, `branch`, `tag`,
`sparseCheckout` — were migrated (ADR-181 / ADR-192) to a **nested namespace**:
`repo.<family>.<verb>(input)` with per-verb concrete **input** and **result**
types and **no** discriminator. ADR-192 explicitly scoped `submodules` (and
`reflog`) **out** of that migration, since ADR-181 named only those four.

24.1a adds three write verbs (`init`/`sync`/`deinit`). Two surface shapes are
available:

- **A — keep `repo.submodules` flat for `list`, add a separate
  `repo.submodule.{init,sync,deinit}` namespace for writes.** Non-breaking, but
  splits the submodule surface across a plural flat command and a singular
  namespace — two entry points for one git noun.
- **B — fold `list` + the three writes into one `repo.submodule` namespace
  (`list`/`init`/`sync`/`deinit`), removing `repo.submodules`.** One structure,
  identical to `remote`/`branch`/`tag`/`sparseCheckout`; maps 1:1 onto `git
  submodule <verb>`. **Breaking** for `repo.submodules` + its result `kind`.
- **C — three flat commands `repo.submodule{Init,Sync,Deinit}`.** Diverges from
  the established multi-verb Namespace idiom entirely.

## Decision

Adopt **B** (user decision). Introduce a `SubmoduleNamespace`
(`repo.submodule.list/init/sync/deinit`) with per-verb concrete result types and
no discriminator, mirroring `commands/remote.ts` + `internal/remote-namespace.ts`
exactly. **Remove** `repo.submodules`; the migrated `list` drops its `kind:
'list'` discriminator (`SubmoduleListResult = { entries }`). The
`repo.primitives.walkSubmodules` primitive is unchanged — `list` still
materialises it.

This applies to `submodule` the same per-verb migration ADR-192 applied to the
other four families; it is the migration ADR-192 deferred for this family.

## Consequences

### Positive

- One CRUD structure across all five families; `git submodule <verb>` maps 1:1
  onto `repo.submodule.<verb>`.
- No discriminated-union narrowing at call sites; each verb's return is exactly
  its payload (ADR-192 parity).
- The plural/singular (`submodules` list vs `submodule` verbs) split that option
  A would create never exists.

### Negative

- **Breaking**: `repo.submodules({ action: 'list' })` → `repo.submodule.list()`,
  and the result loses `kind: 'list'`. Updates `repo.submodules` callers, the
  parity scenario, `repository.test` bound-key set, `reports/api.json`, the
  README command count, and the `docs/use/commands/submodules.md` page.

### Neutral

- ADR-083's "room for `status`/`summary`" is honoured better by the namespace
  (add a method) than by growing the `action` union.
- `reflog` (still discriminated) remains out of scope, as in ADR-192.
