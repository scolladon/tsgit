# ADR-199: `merge.resolveTarget` resolves gitrevisions ref-DWIM (shared with rev-parse)

## Status

Accepted (at `1dbd41e`)

## Context

Stock `git merge <commit-ish>` accepts any ref the gitrevisions DWIM rules
resolve: `git merge origin/main`, `git merge v1.0`, `git merge refs/...`.
tsgit's `merge.resolveTarget` resolves only a 40-hex OID or `refs/heads/<x>`, so
`repo.merge({ target: 'origin/main' })` fails (it probes
`refs/heads/origin/main`). When resolving how `pull` feeds the fetched tip into
`merge` (ADR-197), the directive was "most faithful to git behaviour (principle
of least surprise)". Beyond pull's internal OID passthrough, that least-surprise
expectation extends to **direct** `merge` callers: a user passing `origin/main`
should get git's behaviour.

`rev-parse` already implements the gitrevisions ref-DWIM ladder (`refCandidates`:
verbatim → `refs/heads/<base>` → `refs/tags/<base>` → `refs/remotes/<base>`), and
`resolveRef(.., { peel: true })` already peels annotated tags to their commit.

## Decision

Broaden `merge.resolveTarget` to resolve the gitrevisions ref-DWIM ladder,
reusing rev-parse's candidate sequence:

- Extract rev-parse's private `refCandidates` into a shared pure helper
  `src/domain/refs/ref-candidates.ts`; import it in both `rev-parse.ts` and
  `merge.ts` (one resolution order across tsgit, no duplication).
- `resolveTarget`: 40-hex → OID unchanged; else try each candidate via
  `resolveRef(ctx, candidate, { peel: true })`, first success wins; else
  `REF_NOT_FOUND`.
- Tag peeling lets `merge('annotated-tag')` merge the tagged commit; a
  tree/blob target still fails downstream in `getTree`
  (`UNEXPECTED_OBJECT_TYPE`).

Bounded: the 40-hex direct path is unchanged; revision **operators** (`~`, `^`,
`@{…}`) remain `rev-parse`-only (a caller wanting those resolves via `revParse`
first).

## Consequences

### Positive

- `repo.merge({ target: 'origin/main' })` / tag names now behave like
  `git merge <commit-ish>` — least surprise for direct callers.
- DRY + consistent: one ref-DWIM ladder shared by `merge` and `rev-parse`.
- `pull`'s composition is unaffected — it still passes a resolved OID (ADR-197).

### Negative

- Behaviour change for a bare name that collides with a same-named tag: it now
  resolves the tag (peeled) per the shared ladder rather than only the branch.
  No existing fixture has colliding tag/branch names; the new behaviour is the
  git-faithful one.
- One extra `readObject` on the happy path (the peel step) for named targets.

### Neutral

- The shared ladder keeps rev-parse's existing order (heads before tags), a
  minor, pre-existing deviation from strict gitrevisions tag/head precedence,
  retained for tsgit-internal consistency rather than re-litigated here.
- Revision operators remain out of scope for `merge` targets.
