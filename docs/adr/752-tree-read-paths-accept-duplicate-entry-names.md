---
subjects:
  - src/domain/objects/tree.ts
  - src/application/primitives/internal/resolve-tree-path.ts
  - src/application/primitives/internal/flatten-raw.ts
  - src/domain/fsck/validate-tree.ts
supersedes:
  - adr: "723"
    scope: "the duplicate-entry-name refusal on read paths and the unpinned premise it rested on"
---
# 752 — Tree read paths accept duplicate entry names

- **Status:** accepted
- **Date:** 2026-08-30
- **Design:** docs/design/tree-entry-byte-sensitivity.md (D5) · **Supersedes/Refines:** supersedes ADR-723 (read-path refusal only)

## Context

ADR-723 kept a duplicate-entry-name refusal on the cursor descent to preserve
`parseTreeContent`'s behaviour, and recorded the premise it could not check: "Whether
git itself refuses duplicate names outside `fsck`/`mktree` is unpinned — no probe was
run." It invited exactly this re-litigation: "If a future probe pins git's actual
duplicate-name behaviour on read surfaces, option 2 may be revisited with that pin."

That probe has now been run twice independently against git 2.55.0, over a
hand-built tree carrying two `a` entries with different blob ids:

| surface | behaviour |
|---|---|
| `git ls-tree` | lists **both** entries |
| `git rev-parse <tree>:a` | resolves the **first** |
| `git read-tree` + `git ls-files -s` | keeps the **last** |
| `git diff-tree` | emits **both** as additions |
| `git fsck` | the **only** refuser — `duplicateEntries: contains duplicate file entries` |

So tsgit's read-path refusal is a divergence: git accepts these trees everywhere except
fsck, and answers with a defined per-surface tie-break.

## Options considered

1. **Keep the refusals, re-keyed on raw bytes** (designer's recommendation) — pros: fixes the false-duplicate bug without changing what tsgit refuses; ADR-723 stands / cons: preserves a now-pinned divergence by choice.
2. **Drop the refusal from the read paths, matching git** — pros: faithful; each surface gains git's actual tie-break / cons: a refusal-set change layered on a byte-sensitivity change, needing per-surface first-wins/last-wins rules.
3. **Drop it from the descent only, keep it in `parseTreeContent`** — cons: splits behaviour across two read paths again, which is the shape this work exists to remove.

## Decision

**Ratified by the user: option 2.** Tree read paths accept duplicate entry names.
Path descent resolves **first**-wins; worktree materialisation and index construction
keep **last**-wins; `fsck` remains the sole detector and continues to report a duplicate
finding. `Tree.entries` is an ordered array and may legitimately contain two entries
sharing a name.

**Superseded from ADR-723:** the duplicate-entry-name refusal on read paths — both the
per-directory `Set` re-implemented in the cursor descent and `parseTreeContent`'s own
`names` set — together with the unpinned premise that git's behaviour here was unknown.

**Carried forward from ADR-723:** the ruling that the cursor's own unconditional scan
stays minimal and that name-shape validation is re-implemented per consumer rather than
inside `TreeCursor`; the finding that the raw merge-join deliberately carries neither
check; and the entire mode-tier addendum, which ADR-754 acts on rather than reverses.

## Consequences

### Positive

- Three read surfaces stop refusing trees git reads, and each now answers the way git answers.
- The refusal survives where git puts it, so `fsck` remains the tool that reports the fault.

### Negative

- Callers that relied on `parseTreeContent` refusing a duplicate-bearing tree no longer get that guarantee; they get git's tie-break instead. The interop suite pins first-wins and last-wins per surface in place of the old co-refusal rows.

### Neutral

- Under ADR-749 a duplicate-bearing `Tree` is not a collapse: entries carry their own `nameBytes` and the array preserves both.
