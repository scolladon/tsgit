# ADR-126: Sweep policy — append, do not rewrite, the existing JSDoc

## Status

Accepted (at `9b109c1fecccf317fc4b017127fe6bedf849b26c`)

## Context

Every integration test file under `test/integration/**` already opens with a `/**` JSDoc block — many describe what the file proves in human terms (e.g. "Closes the 0%-coverage gap on `src/index.node.ts`"). 19.4's sweep PR has to add the `@proves` structured block to every one of these 21 files. Two policy options:

1. **Rewrite the JSDoc** — produce a canonical block per file with the prose tightened, then the `@proves` directive at the bottom. Pro: uniform style. Con: the diff conflates a tooling change (the directive) with prose edits, multiplying review effort; the rewrites are inherently subjective.
2. **Append-only** — keep every existing prose block exactly as-is, append the `@proves` directive and three keys. Pro: minimal diff per file; reviewer sees only the new lines. Con: the prose remains heterogeneous; reviewers who want it uniform have to do a follow-up pass.

The project's stated value (CLAUDE.md → "Edits: diff-minded, not full-file rewrites") tilts toward option 2.

## Decision

Append-only sweep. For each of the 21 files:

- Leave the existing prose verbatim.
- If the existing JSDoc has a closing `*/` on its own line, insert a blank `*` separator, then the `@proves` block, then keep the existing `*/`.
- The bucket and surface for each file are fixed in §10 of `docs/design/phase-19-4-integration-test-usefulness-audit.md` so the sweep PR doesn't relitigate them.

The audit's parser tolerates any amount of free-form prose before or after the `@proves` block, so the append-only approach produces parser-valid files without further normalisation.

## Consequences

### Positive

- **Minimal diff.** Each file's diff is roughly five added lines. The PR is reviewable in one sitting.
- **Tooling change and prose change are separable.** A future PR that wants to standardise prose can land independently with its own scope.
- **Lower regression risk.** The audit's parser is exercised against twenty-one different existing JSDoc shapes from the start, increasing confidence the parser handles real-world variance.

### Negative

- **Prose stays heterogeneous.** Some files say "Integration test —", some "Integration —", some open with a paragraph. Reviewers who want uniformity must do follow-up work. Accepted: the variance does not affect the audit, and the structured `@proves` block carries every fact the audit needs.

### Neutral

- **Surface and bucket values are decided in the design, not the sweep.** This ADR governs *how* the sweep edits files; the table in the design governs *what* it writes. The split keeps both documents focused.
