---
subjects:
  - src/repository/resolve-layout.ts
---
# 716 — the found-nothing bootstrap ignores `commonDir`

- **Status:** accepted
- **Date:** 2026-08-24
- **Design:** docs/design/common-dir-open-option.md (candidate D8)

## Context

When discovery finds no repository, `syntheticFallbackLayout` builds the layout
`init`/`clone` will create into. Measured on git 2.55.0: `git init` under
`GIT_COMMON_DIR` exits 0 and writes an **unopenable** split — `refs/` in the gitdir,
`objects/` in the common dir, both halves invalid to both tools thereafter. git has no
working "bootstrap into a split layout" behaviour to be faithful to.

## Options considered

1. **Ignore `commonDir` on the bootstrap path** (design recommendation) — pros: matches
   the bootstrap's existing "reads nothing, trusts nothing" doctrine; leaves the door open
   for a designed split-init surface / cons: the argument is silently inert on this one
   path (stated in the JSDoc).
2. **Honour it** so `init` creates a split layout — cons: invents behaviour git does not
   have, and the obvious invention is silently broken for interop.
3. **Refuse the combination** with `INVALID_OPTION` — cons: refuses a call the ignore
   option serves harmlessly, and adds a refusal condition for a case no caller has asked
   for.

## Decision

**Option 1 — ratified by the user, as recommended.**

The found-nothing bootstrap ignores `commonDir`, as it already ignores everything outside
`{workDir, bare}`. `init`/`clone` create a normal repository at `cwd`.

## Consequences

- The option's JSDoc states the inertness on the bootstrap path.
- A designed `init`-into-a-split-layout surface, if ever wanted, is its own backlog entry
  and its own decision — this ADR does not foreclose it, it only refuses to invent it.
