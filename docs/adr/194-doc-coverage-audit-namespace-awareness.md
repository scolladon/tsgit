# ADR-194: doc-coverage audit learns namespaces; browser-surface deferred

## Status

Accepted (at `2a54c19`)

## Context

The harness audits parse `repository.ts` with
`TIER1_RE = /^ {2}readonly (\w+):\s*BindCtx</`. A namespace line
(`readonly remote: commands.RemoteNamespace;`) does not match `BindCtx<`,
so a namespaced command falls **off** both audits:

- `tooling/check-doc-coverage.ts` — requires a `docs/use/commands/<name>.md`
  page + index row per bound command.
- `tooling/audit-browser-surface.ts` — requires browser/parity call-site
  coverage per bound command.

20.6 already exposed this silently: `repo.config` is a namespace, so
`config.md` exists but is **not** audit-enforced, and `config` carries no
browser/parity coverage. Migrating `remote`/`branch`/`tag`/`sparseCheckout`
to namespaces would drop four more commands from both audits — eroding the
guarantees Phase 19 built.

Three responses were considered:

- **A: extend doc-coverage only; defer browser-surface.** Teach
  doc-coverage to also match `readonly (\w+): commands.\w+Namespace`. Safe —
  all five pages (`config`, `remote`, `branch`, `tag`, `sparse-checkout`)
  exist, so it passes immediately and retroactively re-covers `config`.
  Leave browser-surface on the config precedent (namespaces invisible),
  document the gap, and file a follow-up backlog item.
- **B: do nothing.** All five namespaces stay invisible to both audits,
  matching 20.6 exactly. Smallest change; widest silent gap.
- **C: extend both audits now.** Also teach browser-surface about
  namespaces + dotted `repo.X.verb(` call sites. This pulls `config` into
  browser-surface, which has no parity/browser coverage — forcing a new
  config scenario or a config allowlist entry. Scope creep into 20.6
  territory.

## Decision

Adopt **A**.

- Extend `check-doc-coverage.ts` (and its sibling `audit-browser-surface.ts`
  parser if shared) to recognise `readonly (\w+): commands.\w+Namespace` as
  a tier-1 command name, so the four migrated families **and** `config` are
  doc-coverage-enforced.
- Leave `audit-browser-surface.ts` call-site detection unchanged: namespaced
  commands remain outside the browser-surface gate for now (the config
  precedent). Document the gap in the design doc and the PR body — no silent
  cap.
- File a follow-up backlog item to teach `audit-browser-surface.ts` about
  namespaces (dotted `repo.X.verb(` call sites) and bring `config` +
  the four families under the browser gate, with whatever new
  scenarios/allowlist entries that requires.

## Consequences

### Positive

- **doc-coverage gap closed** for all five CRUD namespaces, including the
  pre-existing `config` blind spot.
- **No scope creep** — browser-surface config coverage is deferred to its
  own item rather than smuggled into a "mechanical" migration.
- **Honest about the remaining gap** — explicitly documented + tracked,
  not silent.

### Negative

- **browser-surface still namespace-blind** until the follow-up lands; the
  four families' browser/parity tests run but are not gate-enforced.
  Mitigated: the tests still exist and execute in CI; the gap is tracked.

### Neutral

- The doc-coverage regex extension is additive — flat `BindCtx<…>` commands
  keep matching exactly as before.
