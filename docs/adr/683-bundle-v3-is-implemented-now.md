# 683 — Bundle v3 is implemented now

- **Status:** accepted
- **Date:** 2026-08-19
- **Design:** docs/design/sha256-object-format.md (candidate D7) · **Refines:** ADR-681

## Context

git writes `# v3 git bundle` with an `@object-format=sha256` capability header for SHA-256
repositories. tsgit's bundle reader and writer are v2-only. With ADR-681 making tsgit able to
create and write SHA-256 repositories, a v2-only bundle path would be the one command that
silently emits an artefact no git can read.

## Options considered

1. **Implement bundle v3 now** — read and write the v3 header with `@object-format`, so
   `bundleCreate` / `bundleVerify` / `bundleListHeads` work on SHA-256 repositories.
2. **Defer with a precise point-of-use refusal** (design recommendation) — bundle commands on a
   SHA-256 repository refuse, naming bundle v3 — pros: honest and safe / cons: a capability gap
   inside a format the change otherwise fully supports, and a new backlog entry.
3. **Defer and write v2 at 64 hex** — the design calls this the only wrong answer, and it is:
   a well-formed-looking bundle that no git can read.

## Decision

**Option 1 — ratified by the user.**

The bundle reader and writer gain the v3 header grammar and the `@object-format` capability. No
deferral, and no backlog follow-up is created.

## Consequences

- `parse-bundle-header.ts`'s `/^[0-9a-f]{40}$/` is one of the width-implicit sites ADR-694's
  sweep must generalise; the v3 work and the width sweep meet here.
- **Correction, measured after ratification and before merge.** This ADR's premise that "v3 is
  emitted only when the object format requires it" is **incomplete**. Measured on git 2.55.0,
  there are **three** independent v3 triggers:
  1. the repository's object format is SHA-256 (and `--version=2` is then refused outright:
     `fatal: cannot write bundle version 2 with algorithm sha256`, exit 128);
  2. a `@filter` capability is present — this forces v3 **even on a SHA-1 repository** (ADR-702);
  3. an explicit `--version=3`, which git accepts on a SHA-1 repository, writing
     `@object-format=sha1` (ADR-701).

  So v2 remains the *default* for an unfiltered SHA-1 repository, not the invariant format for
  one. Read support accepts both versions regardless.
- The bundle interop rows gain a SHA-256 twin: tsgit-created v3 bundle verified by real git, and
  a git-created v3 bundle read by tsgit.
