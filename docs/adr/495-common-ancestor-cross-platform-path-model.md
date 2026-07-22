# 495 — `commonAncestor` cross-platform path model (drive letters, mixed separators, UNC)

- **Status:** accepted (user judgment — confirmed the path model, UNC scope, cross-drive fallback, and injection shape)
- **Date:** 2026-07-22
- **Design:** docs/design/common-ancestor-windows-paths.md · **Refines:** [ADR-298](298-worktree-fs-containment-escape.md)

## Context

[ADR-298](298-worktree-fs-containment-escape.md) roots a fresh raw `NodeFileSystem`
at the `commonAncestor` of the repo `workDir` and the linked-worktree paths, wide
enough to reach both before the facade's multi-root validator narrows access back
down. `commonAncestor` (`src/repository/common-ancestor.ts`) computed that ancestor
with hardcoded POSIX separators — `split('/')` on the way in, `` `/${…}` `` on the
way out — with no notion of a drive-letter or UNC root.

On Windows `C:\Users\me\repo` and `C:\Users\me\repo\wt` share no `/`-segment, so
`commonAncestor` collapsed the root to `/`. The raw adapter rooted at `/` then
rejected every real `C:\…` child with `PERMISSION_DENIED` under its own containment
gate — linked-worktree filesystem access was broken on Windows. The
`index.node` "worktreeFs raw adapter root" probe had to be
`it.skipIf(process.platform === 'win32')` to land the mutation sweep.

The codebase already carries the machinery to fix this without new infrastructure:

- **`PathPolicy`** (`src/adapters/node/path-policy.ts`) — `posixPolicy`,
  `windowsPolicy`, `nativePolicy`; exposes `sep`, `caseInsensitive`, `resolve`,
  `rootOf` (`/`, `C:\`, `\\server\share\`), and `normalizeForCompare`
  (case-fold + strip `\\?\` on case-insensitive platforms; identity on POSIX).
  It is the designed way to run platform-specific path logic — and to simulate
  Windows on a POSIX CI host by injecting `windowsPolicy`.
- **Precedent** — `src/repository/find-layout.ts` already takes `pathPolicy:
  PathPolicy` as a required parameter; `.dependency-cruiser.cjs` has no
  `repository/ → adapters/` rule, so threading the policy is boundary-legal.
- **Empirical pin** (`node:path.win32`, available on every host): `rootOf` keeps a
  *foreign* slash (`win32.parse("C:/Users/me/repo").root === "C:/"`) while
  `resolve` normalises it (`win32.resolve("C:/Users/me/repo") === "C:\\Users\\me\\repo"`).
  The raw adapter's containment compares **separator-sensitively**
  (`normalizeForCompare` case-folds but does not touch separators), so the root
  `commonAncestor` returns must be in native-separator canonical form.

Four load-bearing choices had no pre-existing decision.

## Options considered

**(a) Drive-letter / segment comparison & emitted casing.**
1. *(chosen)* Compare case-insensitively via `normalizeForCompare`; emit the first
   input's original casing. 2. Compare case-sensitively. 3. Lowercase the emitted
   root too. — Git treats `C:`/`c:` as one drive; the raw adapter case-folds both
   sides so emitted casing is verdict-neutral; preserving caller casing is
   least-surprising and matches `realpath`.

**(b) Mixed `/` and `\` in inputs.**
1. *(chosen)* Run each input through `policy.resolve` first, then `rootOf` + split on
   `policy.sep`. 2. Split on both separators via regex, rejoin native. 3. Assume
   inputs are already native-sep. — Option 1 is empirically required: `resolve`
   normalises the foreign slash `rootOf` would otherwise preserve, so the emitted
   root matches the exact shape the adapter's own `checkContainment` computes for
   children — separator-mismatch denials are eliminated by construction, reusing an
   existing primitive (no new regex). Option 3 is unsafe against the mixed-sep
   inputs `checkContainment` explicitly tolerates.

**(c) UNC paths (`\\server\share\…`).**
1. *(chosen)* In scope, handled uniformly by `rootOf` (the share is the root),
   unit-tested via `windowsPolicy`, flagged not-live-Windows-verified. 2. Out of
   scope, documented limitation. 3. Detect and throw on UNC. — The `rootOf`-based
   algorithm already treats `\\server\share\` as the volume root, so same-share
   worktrees get a correct ancestor at near-zero cost; different shares fall to (d).

**(d) No common root (different Windows drives / UNC shares).**
1. *(chosen)* Return the resolved **first input** (the repo `workDir`). 2. Throw a
   typed `TsgitError`. 3. Return `rootOf(first)` (bare volume root). — A single-root
   raw adapter inherently cannot reach two volumes, so cross-drive worktrees are an
   out-of-scope documented limitation regardless. Returning `first` keeps the
   function total and the repo subtree reachable (its own directory contains itself
   + children under `containedByPrefix`); the multi-root validator still gates.
   Option 3 is a trap — a **bare volume root contains nothing but itself** under the
   containment check (the trailing `sep` makes it require a `//` / `C:\\` child), the
   exact pathology that broke Windows originally. Option 2 breaks `openRepository`
   for a case the repo side still works in. POSIX never reaches this branch (always
   shares `/`).

**(e) Policy injection shape.**
1. Default param `policy: PathPolicy = nativePolicy` (runtime `nativePolicy` value
   import into `repository/`; zero call-site change). 2. *(chosen)* Required param
   `policy: PathPolicy`; `index.node.ts` threads `nativePolicy` into **both**
   `commonAncestor(…)` and the sibling `new NodeFileSystem(…)`. 3. Default param via
   a port/composition seam. — Option 2 mirrors `find-layout.ts`'s required-param,
   type-only-import precedent, keeps `repository/` free of a runtime adapter edge,
   and makes the coupling — *one policy governs both the root's separator shape and
   the containment comparison* — explicit and desync-proof.

## Decision

`commonAncestor(paths, policy)` takes the `PathPolicy` as a **required parameter**
(e-1→**e-2**, type-only import mirroring `find-layout.ts`). It:

1. runs every input through `policy.resolve` → native-separator canonical form (b-1);
2. takes `policy.rootOf` of the first resolved input; if any input's root differs
   case-insensitively (`normalizeForCompare`), returns the resolved **first input**
   (d-1);
3. otherwise finds the longest common segment prefix, comparing via
   `normalizeForCompare` (a-1, case-insensitive; identity on POSIX), and returns
   `firstRoot + shared.join(policy.sep)`.

UNC roots are handled uniformly by the same `rootOf`-based path (c-1), unit-tested via
`windowsPolicy`. `src/index.node.ts` `makeWorktreeFs` threads `nativePolicy` into both
`commonAncestor` and the sibling `NodeFileSystem`. Under `posixPolicy` every step is
the identity, so the existing POSIX example tests pass byte-unchanged. A
`common-ancestor.properties.test.ts` sibling is added per the repo's property-testing
convention (compositional-aggregator lens), its containment invariant oracled by the
independently-tested `pathContains`.

## Consequences

- Linked worktrees work on Windows exactly as on POSIX; the skipped `index.node`
  raw-adapter probe runs on every platform again, killing the L87 `ArrayDeclaration`
  mutant on Linux, macOS, and Windows alike.
- POSIX behaviour is byte-identical (policy is the identity there); no change to the
  containment logic, the multi-root validator, or ADR-298 — the fix only corrects the
  raw adapter's **root width**, never past it, so the security boundary is untouched.
- **Documented limitations:** cross-volume linked worktrees (`C:\repo` + `D:\wt`)
  cannot be reached by a single-root raw adapter (the repo side stays reachable); UNC
  support is unit-tested against the documented `rootOf` contract, not byte-verified
  on a live Windows/UNC host (none in this environment).
