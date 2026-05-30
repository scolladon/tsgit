# ADR-205: Porcelain interop scope — `mv`, `add`, `rm`, `reset`

## Status

Accepted (at `03616689bbf3be151314a6e06c6bab85248aa8d0`)

## Context

The faithfulness interop harness (ADR-204) could land covering only `mv` — the
command that surfaced the gap — or retrofit the other index/working-tree
porcelain in the same PR. `commit` is already pinned
(`commit-message-interop.test.ts`); network porcelain
(`clone`/`fetch`/`pull`/`push`) lives in a different bucket
(`network/*-http-backend.test.ts`).

The candidate retrofit set is the state-mutating, non-network porcelain whose
faithfulness is currently only cross-adapter:

- `mv` — index + working-tree rename (the surfaced gap).
- `add` — stage paths into the index.
- `rm` — remove paths from index (and working tree unless `--cached`).
- `reset` — move HEAD and (per mode) rebuild index / materialise working tree.

Options considered:

- **Just `mv` + the reusable harness.** Tight PR; other porcelain follow the
  pattern as they are next touched.
- **`mv` + retrofit `add` / `rm` / `reset`.** Broader real-git coverage now;
  larger PR touching four command modules and four interop tests.

## Decision

**Retrofit `add`, `rm`, and `reset` alongside `mv` in this PR.** Each gets a
`@writes` surface tag (ADR-204) and a dedicated `<cmd>-interop.test.ts` pinning
it to canonical `git`:

- `mv-interop` — rename, into-dir, directory subtree, force, unstaged-edit
  travels, plus refusals.
- `add-interop` — new file, subdirectory pathspec, re-stage after edit.
- `rm-interop` — tracked removal, `--cached`, plus an untracked refusal.
- `reset-interop` — `--soft` / `--mixed` / `--hard` against a pinned seed
  commit (identical SHA on both sides via pinned author/committer identity).

`index-interop.test.ts` stays the **index format** proof (surface `index`); it
uses `add` as a vehicle but is not retargeted — `add`'s command behaviour gets
its own test.

## Consequences

### Positive

- The four most-used state-mutating porcelain are pinned to canonical git now,
  not just cross-adapter.
- Establishes the per-surface `<cmd>-interop.test.ts` convention the harness
  reuses for future porcelain.

### Negative

- Larger PR; `add-interop` overlaps `index-interop`'s staging path (different
  intent: command behaviour vs index byte format).
- `reset-interop` needs a committed seed (pinned identity) where the others
  only need staging — more setup in that one file.

### Neutral

- `stash` (21.3) and the history-rewriting porcelain (22.x) are out of scope;
  they adopt the same pattern when they land.
