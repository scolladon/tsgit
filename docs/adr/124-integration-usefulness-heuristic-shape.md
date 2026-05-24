# ADR-124: Integration-usefulness heuristic emits three finding classes

## Status

Accepted (at `9b109c1fecccf317fc4b017127fe6bedf849b26c`)

## Context

Phase 19.4 adds an `integrationProof` heuristic to `tooling/audit-test-pyramid.ts`. The heuristic can fail in three different ways:

- **Missing**: a file has no `@proves` block, an incomplete one, or values that fail the grammar ([ADR-121](121-integration-proves-header-grammar.md)).
- **Duplicate**: two files share a `(surface, bucket)` pair without the platform-only exemption ([ADR-123](123-integration-duplicate-detection.md)).
- **Misplaced**: the file's directory doesn't match the bucket's directory rule ([ADR-122](122-integration-bucket-taxonomy.md), §5.3 of the design).

Two structural choices for the heuristic output:

1. **One finding array** — every failure becomes a row in `integrationProof: [{ path, reason, ... }]`, with `reason` discriminating the class.
2. **Three named arrays** — `integrationProof: { missing, duplicate, misplaced }`, each a separate list.

Option 1 is simpler to render in JSON; option 2 makes the markdown report scannable (three sub-sections) and lets reviewers attack one class at a time.

The existing heuristics in the audit are single-array (`overMocked`, `underAsserted`, etc.). 19.4 is the first heuristic with structurally distinct failure modes, so it sets the precedent for the next phase if a similar shape arrives.

## Decision

Three named arrays. `outcome.findings.integrationProof = { missing, duplicate, misplaced }`. Each array's element type is specific to the class:

- `missing[].{ path, reason, detail? }`
- `duplicate[].{ surface, bucket, paths }`
- `misplaced[].{ path, bucket, expected }`

Gating: a single boolean `gating.integrationProof` covers all three classes. A finding in any class with the boolean set to `true` exits the audit with code 1. There is no per-class gating — the three classes are independent symptoms of the same underlying invariant.

## Consequences

### Positive

- **Each class has its own resolution playbook.** "Missing header → add three lines"; "Duplicate → merge or split surface"; "Misplaced → move the file or rebucket". Splitting the output makes the playbook visible.
- **The render layer doesn't need to discriminate by `reason`.** Three sub-tables in markdown; three keys in JSON; one assertion per class in the audit's own integration test.
- **Future heuristics can adopt the same shape.** If 19.5a adds a `surfaceCoverage` heuristic, it can split its findings the same way (`{ unitOnly, integrationOnly, fullyCovered }`) without inventing a new pattern.

### Negative

- **More fields to keep in sync.** The schema, the parser, the detector, the renderer, and the audit's own integration test all encode the three-class structure. A new class would touch all five — but the precedent (`overMocked`) shows that adding fields is mechanical.
- **No per-class gating.** A team that wants to merge the sweep before all `duplicate` findings are resolved cannot leave `missing` gated and `duplicate` warn-only. Mitigation: that scenario is what `gating.integrationProof: false` covers globally; per-class gating is YAGNI today.

### Neutral

- **Element shapes are class-specific.** `missing` carries a `reason` enum; `duplicate` carries `paths` plural and no individual `path`; `misplaced` carries `expected`. JSON consumers must branch on the class — that's the intent.
