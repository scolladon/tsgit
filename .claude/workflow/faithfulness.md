# Git-faithfulness — empirical pinning procedure (design + implement context)

The prime directive (CLAUDE.md, ADR-226): replicate canonical git's observable
behaviour byte-for-byte unless an ADR explicitly diverges. Designs NEVER describe git
behaviour from memory — they pin it against the real binary and record the matrix.
Slices that write interop tests obey the same isolation rules (hence this is implement
context too).

## Pinning procedure

- **Isolate any probe that WRITES git state in a `mktemp -d` throwaway repo**
  (`git init` there, `HOME` isolated, `GIT_CONFIG_NOSYSTEM=1`, `GIT_*` scrubbed; for
  config probes use `git config --file <tmpfile>`), NEVER in the working directory.
  A worktree shares its `.git/config` with the main checkout and every sibling worktree
  via the common dir, so a `git config <k> <v>` (or any `.git/config` write) there
  silently CLOBBERS all of them — a designer once wiped the shared config to a bare
  `[user]` section, breaking every worktree (`missing value for 'user.name'`).
  Read-only probes in place are fine; writes go to the throwaway. After any agent that
  touched git, the session spot-checks integrity: `git config --get remote.origin.url`
  + `git status`. This is a direct-write hazard, distinct from `GIT_DIR` env leakage.
- Run real `git` in a controlled environment: **scrub all `GIT_*` env vars** (spawned
  git inherits `GIT_DIR` from hooks and silently writes to the wrong repo; `-C <path>`
  does NOT override `GIT_DIR`), isolate `HOME` so global config can't leak, and turn
  **signing OFF** when computing goldens.
- **If `.git/config` ever needs rebuilding**, tsgit's `origin` is the SSH remote
  `git@github.com:scolladon/tsgit.git` (NOT the https URL `package.json` shows).
- **conflictStyle trap:** the developer's global git config sets
  `merge.conflictStyle=diff3`. When comparing conflict-marker bytes, pin the peer with
  `-c merge.conflictStyle=merge` (or scrub global config entirely).
- Record the pinned matrix (command → exact bytes/exit code/state files) in the design
  doc's Design section. Each pinned behaviour becomes a cross-tool interop test in
  `test/integration/*-interop.test.ts` (parity tests are cross-adapter only — they do
  NOT prove faithfulness; only the interop harness does).
- Structured-output rule (ADR-249): faithfulness binds the DATA and on-disk state, not
  rendered stdout. Pin display behaviour by reconstructing git's output from the
  structured fields inside the interop test.
