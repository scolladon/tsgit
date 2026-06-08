# ADR-289: Submodule clone→worktree substrate reuses `clone` + a new `materializeWorktreeFromHead` primitive

## Status

Accepted (at `6adba128c25b`)

## Context

The submodule network verbs (`add`/`update`) must clone a remote into a **nested**
gitdir (`.git/modules/<name>`) and **materialise** a working tree at `<path>`.
tsgit's top-level `clone` fetches a pack + propagates refs + writes config, but
deliberately **does not materialise a working tree** (clone.ts: "Working-tree
materialization is out of scope here"). So the missing capability is "clone, then
check out HEAD into the worktree", isolated to the submodule layout.

Three ways to build it:

1. Run the existing `clone` on a child `Context` (gitDir `.git/modules/<name>`),
   then a small new primitive materialises HEAD's tree into the worktree.
2. Extract a unified `cloneWorktree` primitive shared by both submodule verbs and
   a future top-level clone-with-worktree.
3. Give top-level `clone` a worktree now, and have submodules reuse it.

## Decision

Option 1. `add`/`update` run `clone(childCtx, { url })` unchanged, then call a new
Tier-2 primitive **`materializeWorktreeFromHead(childCtx)`** that resolves `HEAD`
→ commit → tree, runs `materializeTree`, and commits the module's index under its
own lock — updating **no** ref and writing **no** reflog (git's clone checkout is
silent beyond the `clone: from` entry). `update`'s detached checkout reuses the
existing `checkout` command. The child `Context` is built by a new
`deriveSubmoduleCloneContext` (sibling of 24.1a's `deriveSubmoduleContext`, minus
the HEAD-exists guard, over a shared private builder).

## Consequences

### Positive

- Top-level `clone`'s faithfulness goldens stay green — zero behaviour change to an
  existing command.
- Maximal reuse: clone's ref propagation + `[remote]`/`[branch]` config + reflog
  are exactly the module gitdir's needs; only `core.worktree` + the `.git` gitfile
  are submodule-specific add-ons.
- `materializeWorktreeFromHead` is a clean, independently-testable primitive with a
  genuine second consumer today (`add` and `update`'s clone-if-missing path).

### Negative

- `update`'s clone-then-checkout-detach materialises twice in the divergent case;
  accepted (a content no-op when pinned == clone HEAD).

### Neutral

- A future top-level clone-with-worktree (24.x) can adopt `materializeWorktreeFromHead`
  — introduced now only because `add`/`update` are its first consumers (rule of two),
  not speculatively.
