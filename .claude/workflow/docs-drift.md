# Docs drift — affected-page floor for tsgit (documentation-phase context)

The repo runs a `docs-pr-gate` bot that comments on PRs whose
`src/application/{commands,primitives}` changes lack a matching `docs/use/*` update
(informational today, blocking soon). Preempt it during the documentation phase
instead of reacting to the comment after the PR opens.

## The mapping (mirror of the bot's expectation)

- `src/application/commands/<name>.ts` changed → `docs/use/commands/<name>.md` updated,
  or a row update in `docs/use/commands/README.md`.
- `src/application/primitives/<name>.ts` changed → `docs/use/primitives/<name>.md`
  updated, or a row update in `docs/use/primitives/README.md`.
- `src/application/primitives/index.ts` (barrel — including type-only re-exports) →
  `docs/use/primitives/index.md` or a `docs/use/primitives/README.md` update.
- Fully-internal building blocks (unexported ≠ public surface) belong in
  `docs/use/primitives/internals.md`, never a standalone page.

## Procedure

1. During the documentation phase, diff the branch against `main` and apply the
   mapping above to every touched file; treat each hit as an affected page (union
   with the phase's judgment probe).
2. A hit that is intentionally code-only (type-only refactor, internal-only signature
   change) is skipped WITH a written line in the run record naming the file and why —
   never silently.
3. After the PR opens, read the `docs-pr-gate` comment; anything it lists that the
   phase did not already cover is fixed before merge (a `docs(<scope>): …` commit),
   or justified in the run record per rule 2.
