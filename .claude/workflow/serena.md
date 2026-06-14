# Serena — code navigation/editing mandate (global context)

Injected verbatim into every forge agent AND read by the session at the branch phase. Activation and the merge-phase prune (`serena-prune.sh`) are a matched pair — every activated worktree gets pruned.

## Session — branch phase (and standalone runs, against the checkout root)

- After creating the worktree, `mcp__serena__activate_project` with its ABSOLUTE path. Serena's LSP roots at the activated project, so navigation/rename reflect the worktree's own edits; the harness LSP is single-rooted at the main repo and sees stale declarations for worktree files.
- **Stale-activation recovery:** `activate_project` throwing FileNotFoundError on a deleted sibling worktree means Serena cached a dead project. Fix: `mkdir` the missing path → activate the one you want → remove the placeholder.

## Agents — all of you

- Serena is **ALREADY ACTIVATED** here. Do NOT call `activate_project`.
- Serena symbol/LSP tools are the DEFAULT for all TypeScript read/navigate/edit (test files too): `find_symbol`, `find_referencing_symbols`, `get_symbols_overview`, `rename_symbol`, `insert_after_symbol`, `replace_symbol_body`, `replace_content`. Run `get_diagnostics_for_file` after each source edit.
- Fall back to `Edit`/`Write` only when Serena can't express the change; `Read`/`Grep` only for non-code files (markdown, JSON, generated artefacts) or a quick literal scan; Bash for git/npm only.
- **`replace_symbol_body` gotcha:** replacing a TS `export const` arrow can double the `export const` prefix (TS1389) — omit the prefix in the new body, diagnose after.
- Diagnostics are advisory; ground truth is `npm run check:types` / `npm run validate`. Ignore lagging cross-root diagnostics when the type-check is green.
