# Probe protocol — every throwaway, every agent (review, refactoring, validation context)

A probe is a shell experiment against real `git` in a throwaway directory. One probe once
ran `rm -rf .git/objects/??` in the main checkout after its `cd` failed on an unquoted
variable, and every loose object of the shared store was gone. The rules below are the
minimum that makes that impossible; they bind the session and every agent it spawns.

## Never

- Never run `rm`, `rm -rf`, `git gc`, `git prune`, `git reset`, `git checkout`, `git clean`,
  `git worktree remove` or any other deleting command — anywhere, for any reason. A
  throwaway is left in place; the operating system's temp cleanup owns it.
- Never run a git command with the worktree or the main checkout as its cwd unless it is
  read-only (`git --no-pager log/show/diff --no-ext-diff`, `git cat-file`, `git rev-parse`,
  `git ls-tree`, `git status`). Writes are the session's: one commit per unit of work,
  through the hooks.
- Never run the interactive shell's expansions in a script: zsh does not word-split an
  unquoted variable, so `$E git …` and `cd $R` fail in ways bash would not.

## Always

- `set -euo pipefail` as the first line of every probe script.
- One absolute throwaway: `d=$(mktemp -d) || exit 1`; every `cd` is `cd "$d/…" || exit 1`;
  every variable quoted; every path built from `$d`.
- Run the script with `bash "$script"`, never pasted into the interactive shell.
- Scrubbed environment and a user-only config, so the user's global git settings never
  leak into a pin: `env -i PATH="$PATH" HOME="$d/home" GIT_CONFIG_NOSYSTEM=1
  GIT_CONFIG_GLOBAL="$d/gitconfig"`, `[user]` name and email only,
  `-c commit.gpgsign=false -c gc.auto=0` on every git call.
- Repeat before concluding: a probabilistic outcome sampled once per hypothesis refutes
  every hypothesis; run the same unchanged shape two or three times first.
- Long output goes to a file under the session scratchpad; read back only the lines that
  matter.

## When the store is damaged anyway

Stop every agent. Verify read-only (`git count-objects -v`, `git cat-file -t <sha>`,
`git fsck --connectivity-only`). Tell the user before any recovery; a fetch restores
nothing while a stale tracking ref still claims the missing commit, so stale refs are
deleted before fetching.
