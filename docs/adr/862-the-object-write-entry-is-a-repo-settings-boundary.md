---
subjects:
  - src/application/primitives/write-object.ts
  - src/application/primitives/internal/repo-settings-gate.ts
---
# 862 — The object-write entry is a repo-settings boundary

- **Status:** accepted
- **Date:** 2026-09-12
- **Design:** docs/design/session-caches-per-command-floor.md (NDC-4) · **Supersedes/Refines:** refines ADR-859, ADR-850

## Context

ADR-859 placed the repo-settings class at the object-store, index and commit-graph **read**
boundaries. The investigation behind it assumed the write path was covered for free — that
`writeObject` and `writeTree` enter the store and would therefore refuse like everything else.

A later pin shows they do not: `writeObject` reads config and writes a loose file without touching
the pack registry. Git's `hash-object -w` and `write-tree` both die on a malformed value, and
`notes add` on a repository with no notes ref dies with nothing written, so tsgit's write path runs
where git's dies.

That leaves the class's coverage asymmetric — reads structural, writes per-verb — and forces a
transcribed call onto `notes.add` to paper over it.

## Options considered

1. **Make the object-write entry a boundary** (recommended, chosen) — `assertRepoSettingsValid` as
   `writeObject`'s first statement. Pros: parity with `hash-object -w` and `write-tree`; every
   Tier-1 object write covered structurally; `notes.add` needs no transcribed call. Cons: a Tier-2
   primitive can now refuse on config.
2. **Record it as a Tier-2 residual** — pros: ADR-859's letter, and primitives keep a contract free
   of config refusals. Cons: the write path diverges from git, and `notes.add` keeps a per-verb call
   that exists only to cover a structural gap.
3. **Defer the Tier-2 write primitives to their own entry** — cons: leaves a known divergence
   shipping and files a follow-up where the default is that the work rides here.

## Decision

**Option 1.** The object-write entry joins the read boundaries: `assertRepoSettingsValid(ctx)` is
`writeObject`'s first statement, through the same session-memoised fast path, costing one probe per
object write on a settled session.

`notes.add`'s transcribed call is therefore **not written** — the same disposition ADR-860 produced
for `branch.create`, and for the same reason: once the verb reaches a boundary for its own
structural reason, transcribing git's call as well is redundancy, not fidelity.

## Consequences

**A Tier-2 primitive can now refuse on a malformed repo-settings value.** That is a deliberate
narrowing of the primitive contract, and it qualifies ADR-850's statement that a primitive-only
session keeps per-read freshness with no gate: object *writes* now validate this one class whether
or not a gate has run. Reads are unchanged. The qualification is documented on the primitives page
rather than left for a consumer to discover from a refusal.

The "first touch precedes first write" audit shrinks to ref writes and working-tree writes, because
every object write is now covered structurally.

`updateRef`'s own missing type verification remains recorded and unfixed — a different refusal on a
different primitive, noted so the ref-write boundary question starts from a record rather than a
rediscovery.
