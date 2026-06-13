# Git-faithfulness — empirical pinning procedure (design-phase context)

The prime directive (CLAUDE.md, ADR-226): replicate canonical git's observable
behaviour byte-for-byte unless an ADR explicitly diverges. Designs NEVER describe git
behaviour from memory — they pin it against the real binary and record the matrix.

## Pinning procedure

- Run real `git` in a controlled environment: **scrub all `GIT_*` env vars** (spawned
  git inherits `GIT_DIR` from hooks and silently writes to the wrong repo; `-C <path>`
  does NOT override `GIT_DIR`), isolate `HOME` so global config can't leak, and turn
  **signing OFF** when computing goldens.
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
