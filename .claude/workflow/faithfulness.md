# Git-faithfulness — empirical pinning procedure (design + implement context)

Prime directive (CLAUDE.md, ADR-226): replicate canonical git's observable behaviour byte-for-byte unless an ADR diverges. NEVER describe git behaviour from memory — pin it against the real binary and record the matrix. Interop-test slices obey the same isolation (hence implement context too).

## Pinning procedure

- **Probes that WRITE git state go in a `mktemp -d` throwaway** (`git init` there, isolated `HOME`, `GIT_CONFIG_NOSYSTEM=1`, `GIT_*` scrubbed; config probes use `git config --file <tmpfile>`), NEVER in the working directory — a worktree shares its `.git/config` with the main checkout and every sibling via the common dir, so a write there silently CLOBBERS them all (a designer once wiped it to a bare `[user]`, breaking every worktree with `missing value for 'user.name'`). Read-only probes in place are fine. After any git-touching agent, the session spot-checks: `git config --get remote.origin.url` + `git status`. (Distinct from `GIT_DIR` env leakage.)
- Run real `git` controlled: **scrub all `GIT_*`** (spawned git inherits `GIT_DIR` from hooks → wrong repo; `-C <path>` does NOT override it), isolate `HOME`, **signing OFF** for goldens.
- If `.git/config` needs rebuilding, tsgit's `origin` is the SSH remote `git@github.com:scolladon/tsgit.git` (not the https URL `package.json` shows).
- **conflictStyle trap:** the dev's global git sets `merge.conflictStyle=diff3`; when comparing conflict-marker bytes, pin the peer `-c merge.conflictStyle=merge` (or scrub global config).
- Record the matrix (command → exact bytes/exit code/state files) in the design doc; each pinned behaviour becomes a cross-tool interop test in `test/integration/*-interop.test.ts` (parity tests are cross-adapter only — they do NOT prove faithfulness; only the interop harness does).
- Structured-output (ADR-249): faithfulness binds the DATA and on-disk state, not rendered stdout — pin display by reconstructing git's output from the structured fields inside the interop test.
