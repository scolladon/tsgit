---
subjects:
  - src/application/commands/fetch.ts
  - src/application/commands/pull.ts
---
# 944 — Fetch reports rejected ref updates per ref, as push does

- **Status:** accepted
- **Date:** 2026-10-05
- **Design:** docs/design/alternates-object-lookup.md · **Supersedes/Refines:** refines ADR-942, ADR-226

## Context

git's `update_local_ref` refuses a non-fast-forward update whose refspec lacks `+`
(`! [rejected] … (non-fast-forward)`) and an update that would move an existing tag
(`! [rejected] … (would clobber existing tag)`). It still updates every other ref and writes
`FETCH_HEAD`, then exits 1; `git pull` stops before merging. tsgit wrote every update, forced or not.

## Options considered

1. **Per-ref result, as push (ADR-942):** each update reports `status` and a structured `rejection`;
   fetch resolves; pull refuses before merging when any update was rejected.
2. **Throw after the side effects:** fetch throws `FETCH_REJECTED { rejected, result }`.
3. **Both.**

## Decision

**Option 1, adopted under ADR-226 and the user-ratified precedent of ADR-942** (push's per-ref,
structured rejections). A `FetchUpdate` gains `status: 'ok' | 'rejected'` and
`rejection?: 'non-fast-forward' | 'would-clobber-existing-tag'`. Fetch performs every other side
effect git performs and resolves; `pull` refuses with `FETCH_REJECTED` (carrying the rejected
updates) before merging, as git's pull stops on fetch's exit 1.

## Consequences

- Breaking public change (`!`): `FetchUpdate` shape and the new `FETCH_REJECTED` code;
  `reports/api.json`, `docs/use/commands/fetch.md` and `pull.md` updated.
- Refspec parsing carries the `+` force flag through to the ref map.
- Interop rows rebuild git's `! [rejected]` lines from the structured result and compare refs,
  `FETCH_HEAD` and reflogs.
