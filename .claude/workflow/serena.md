# Serena — code navigation/editing mandate (global context)

This file is read by the session at the branch phase AND injected verbatim into every
forge agent invocation. Serena's activation and the merge-phase prune
(`serena-prune.sh`) are a matched pair: every worktree that gets activated gets pruned.

## Session — branch phase (and standalone runs, against the checkout root)

- Immediately after creating the worktree, activate Serena on it:
  `mcp__serena__activate_project` with the ABSOLUTE worktree path
  (`/abs/path/tsgit-<slug>`). Serena's LSP roots at the activated project, so
  cross-file navigation/rename reflect the worktree's own edits; the harness LSP tool
  is single-rooted at the main repo and sees only stale declarations for worktree
  files.
- **Stale-activation recovery:** `activate_project` throwing FileNotFoundError on a
  previously-deleted sibling worktree means Serena cached the dead project. Recover:
  `mkdir` the missing path as a placeholder → activate the project you actually want →
  remove the placeholder.

## Agents — all of you

- Serena is **ALREADY ACTIVATED** on this worktree. Do NOT call `activate_project`.
- Serena symbol/LSP tools are the DEFAULT for all TypeScript reading, navigation, and
  editing — test files included: `find_symbol`, `find_referencing_symbols`,
  `get_symbols_overview`, `rename_symbol`, `insert_after_symbol`,
  `replace_symbol_body`, `replace_content`. Run `get_diagnostics_for_file` after each
  source edit.
- Fall back to harness `Edit`/`Write` only when Serena can't express the change; use
  `Read`/`Grep` only for non-code files (markdown, JSON, generated artefacts) or a
  quick literal scan. Bash is for git/npm only.
- **`replace_symbol_body` gotcha:** replacing a TS `export const` arrow function can
  double the `export const` prefix (TS1389). Omit the prefix in the new body, and
  diagnose the file after the edit.
- Serena/LSP diagnostics are advisory; the ground truth is `npm run check:types` and
  `npm run validate`. Ignore lagging cross-root diagnostics when the type-check is
  green.
