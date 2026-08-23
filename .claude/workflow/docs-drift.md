# Docs drift — affected-page floor for tsgit (documentation AND integrate context)

The repo runs a `docs-pr-gate` bot that comments on PRs whose
`src/application/{commands,primitives}` changes lack a matching `docs/use/*` update
(informational today, blocking soon). Preempt it during the documentation phase, then
VERIFY against the actual comment at integrate — the bot cannot comment before the PR
exists, so preemption alone is never proof.

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
3. **At integrate, treat the `docs-pr-gate` comment as a CI signal, not a suggestion.**
   Read it explicitly (`gh pr view <n> --json comments`) alongside `gh pr checks` — a
   green check list does NOT mean the gate is satisfied, because the gate reports through
   a comment rather than a check today. For every entry it lists, either land a
   `docs(<scope>): …` fix before merge or record why it is intentionally code-only per
   rule 2. Never merge with an unexamined entry: the gate turns blocking without notice,
   and an entry left unread is a defect the next PR inherits.

## Triage shortcut (apply before writing anything)

The gate lists files, not gaps. Split its list first:

- **Barrel-exported** (`src/application/primitives/index.ts` re-exports it) → public
  surface → a `docs/use/primitives/<name>.md` page or a README row. Note some modules
  export several symbols documented under their own page names (`path-layout.ts` →
  `common-git-dir.md`, `get-repo-root.md`, …); those are already covered.
- **Not barrel-exported** → internal → an `internals.md` entry, never a standalone page.
- **Behaviour unchanged** (a re-route through a seam, a pure refactor) → the existing
  entry needs a minimal correction, not a rewrite.

An entry is a TRUE gap when the subsystem it names has no `internals.md` entry at all,
or when an existing page now states something the branch made untrue.
