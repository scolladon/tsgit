# Plan — Phase 20.5 `remote` CRUD Porcelain

Drives the implementation of `repo.remote(action)` per
`docs/design/phase-20-5-remote-crud-porcelain.md` and ADRs 175–180.

Each step lists the test cases to write first (Red), the minimal code
to make them green (Green), and the verifications to run before
committing. Steps are ordered so each commit lands a self-contained,
reviewable unit.

## Slice 0 — Pre-flight

- [x] Worktree on `feat/remote-crud-porcelain`.
- [x] Design + ADRs committed.

## Slice 1 — Config-writer surgical helpers + `pushurl` parse

Lands the building blocks needed for every later slice. No new
porcelain yet.

### 1.1 — `pushurl` in the config reader

Tests (`test/unit/application/primitives/config-read.test.ts`):

- "Given a `[remote 'origin']` block with `pushurl = X`, When
  `readConfig` runs, Then `remote.get('origin').pushUrl === 'X'`."
- "Given a remote without `pushurl`, When `readConfig` runs, Then
  `pushUrl` is `undefined`."
- "Given `PUSHURL` upper-cased, When `readConfig` runs, Then it's
  picked up case-insensitively."

Implementation:

- `ParsedConfig.remote.<name>` gains `pushUrl?: string` (TS type).
- `mergeRemote` and `finalize` write `pushUrl` when the lower-cased
  key equals `pushurl`.

### 1.2 — `removeConfigEntry`

Tests (`test/unit/application/primitives/update-config.test.ts`):

- "Given a section with the key, When `removeConfigEntry` runs, Then
  the key line is gone and every other byte is preserved."
- "Given a section without the key, When `removeConfigEntry` runs,
  Then the text is byte-identical."
- "Given no matching section, When `removeConfigEntry` runs, Then the
  text is byte-identical."
- "Given the key appearing twice, When `removeConfigEntry` runs, Then
  every occurrence inside the section is removed." (Decision:
  match canonical-git `git config --unset-all` for this helper; the
  caller wants the key gone, not the first instance only.)
- "Given the same key in two different sections, When
  `removeConfigEntry` runs against one section, Then the other
  section is preserved."

Implementation: line-surgery `removeConfigEntry(text, section,
subsection, key)` extends the existing `update-config.ts` style.

### 1.3 — `removeConfigSection`

Tests:

- "Given a section block, When `removeConfigSection` runs, Then the
  header and every line until the next section header are gone."
- "Given a section block followed by another section, When
  `removeConfigSection` runs, Then the following section is preserved
  byte-for-byte."
- "Given no matching section, When `removeConfigSection` runs, Then
  the text is byte-identical."
- "Given the section appearing twice (corrupt config), When
  `removeConfigSection` runs, Then every occurrence is removed."

Implementation: walk lines, skip from a matching header to the next
header or EOF.

### 1.4 — `renameConfigSection`

Tests:

- "Given `[remote 'old']`, When `renameConfigSection(text, 'remote',
  'old', 'new')` runs, Then the header becomes `[remote 'new']` and
  the body is preserved byte-for-byte."
- "Given a section appearing twice (corrupt), When renames run, Then
  every occurrence is renamed."
- "Given no matching section, When rename runs, Then the text is
  byte-identical."
- "Given an unrelated section, When rename runs, Then it's preserved."

### 1.5 — `updateConfigOperations` batch entrypoint

Tests:

- "Given a batch with one `set` and one `removeEntry`, When applied,
  Then both effects land and the cache is invalidated."
- "Given a batch with `removeSection` followed by `set` against the
  same section, When applied, Then the new section is present."
- "Given a batch with `renameSection`, When applied, Then the
  section is renamed."
- "Given an empty batch, When applied, Then the config file is
  unchanged (writeUtf8 still runs — keeps the contract uniform)."

Implementation: a discriminated union `ConfigOperation` folded over
the file text; one `writeUtf8` + one `invalidateConfigCache`.

### 1.6 — Commit

`feat(config): line-surgery helpers and pushurl parse for remote
CRUD`

## Slice 2 — Domain errors

### 2.1 — `REMOTE_EXISTS` and `REMOTE_NAME_INVALID`

Tests (`test/unit/domain/commands/error.test.ts`):

- "Given a `remoteExists(name)` call, Then the error's code is
  `REMOTE_EXISTS` and the remote field round-trips."
- "Given a `remoteNameInvalid(name, reason)` call, Then the error's
  code is `REMOTE_NAME_INVALID` and the fields round-trip."
- Message-formatter cases for both.

Implementation:

- `CommandError` union extended.
- `remoteExists`, `remoteNameInvalid` factory functions.
- `domain/commands/index.ts` re-exports both.

### 2.2 — Commit

`feat(error): REMOTE_EXISTS and REMOTE_NAME_INVALID codes`

## Slice 3 — `remote-config` internal helpers

### 3.1 — `validateRemoteName`

Tests (`test/unit/application/commands/internal/remote-config.test.ts`):

- One per banned character (`\n`, `\r`, `\0`, `"`, `\\`, `]`) — each
  case isolated so a regex-mutant that drops one term dies.
- Empty string rejected.
- Plain ASCII accepted.
- `/`-containing name accepted (canonical-git compatibility).
- Space-containing name accepted (unusual but legal).

### 3.2 — `listBranchReferrers`

Tests:

- "Given no branches, Then returns empty."
- "Given one branch with `remote = <name>`, Then it's returned with
  its `merge` value."
- "Given one branch with `remote = <name>` but no `merge`, Then
  `merge` is `undefined`."
- "Given a branch with `remote = <other>`, Then it's not returned."
- "Given two branches both with `remote = <name>`, Then both come
  back."

### 3.3 — `rewriteDefaultFetchRefspecs`

Tests:

- "Given the canonical `+refs/heads/*:refs/remotes/<from>/*`, When
  rewritten for `<from>` → `<to>`, Then the destination is rewritten
  and the source kept."
- "Given a custom refspec, When rewritten, Then it's preserved
  verbatim."
- "Given a list with one canonical and one custom, When rewritten,
  Then only the canonical entry changes."
- "Given an empty list, When rewritten, Then returns an empty list."

### 3.4 — Commit

`feat(remote): internal helpers — validateRemoteName,
listBranchReferrers, rewriteDefaultFetchRefspecs`

## Slice 4 — `remote.ts` skeleton + `list`

### 4.1 — `remote({ kind: 'list' })`

Tests (`test/unit/application/commands/remote.test.ts`):

- "Given no remotes, Then remotes is empty."
- "Given a single `origin`, Then the entry's url and fetchRefspecs
  match."
- "Given `origin` with `pushurl`, Then `pushUrl` is set."
- "Given multiple remotes, Then they're sorted by name (byte-wise)."
- "Given a non-repo, Then throws `NOT_A_REPOSITORY`."

Implementation:

- `src/application/commands/remote.ts` exports `remote(ctx, action)`.
- `RemoteAction`, `RemoteResult`, `RemoteInfo`, `RemoteShow` types.
- `list` reads `readConfig`, sorts, returns.

### 4.2 — `commands/index.ts` re-exports

The Tier-1 export list grows by `remote` + four types.

### 4.3 — Repository binding

`src/repository.ts` Repository interface and factory gain
`remote: BindCtx<typeof commands.remote>` with the standard `guard()`
glue.

### 4.4 — Commit

`feat(remote): list action + repository binding`

## Slice 5 — `add`

Tests:

- "Given a new name and url, When add runs, Then the config block
  is written with the canonical default fetch refspec and the
  returned `remote` describes it."
- "Given a custom `fetch`, When add runs, Then the custom refspec is
  written verbatim."
- "Given an existing remote name, When add runs, Then throws
  `REMOTE_EXISTS`."
- One test per banned char in the name → `REMOTE_NAME_INVALID`.
- "Given an empty name, Then throws `REMOTE_NAME_INVALID`."
- "Given a url containing a newline, Then throws `INVALID_OPTION`."
- "Given a bare repo, Then add succeeds."
- "Given a malformed `fetch` refspec, Then throws `REFSPEC_INVALID`."

Implementation: surgical use of `updateConfigOperations` with one
`set` op for the url and one `set` op for the fetch refspec.

Commit: `feat(remote): add action`.

## Slice 6 — `remove`

Tests:

- "Given an unknown remote, Then throws `REMOTE_NOT_CONFIGURED`."
- "Given a configured remote with no tracking refs, Then the config
  block is gone and `removedTrackingRefs` is empty."
- "Given a configured remote with two tracking refs, Then both are
  deleted and reported."
- "Given a packed-only tracking ref under the remote, Then throws
  `UNSUPPORTED_OPERATION`."
- "Given a branch with `remote = <name>` and `merge = <ref>`, Then
  both keys are dropped and the branch is in `clearedBranches`."
- "Given a branch with `remote = <name>` and no `merge`, Then only
  `remote` is dropped."
- "Given two branches tracking the same remote, Then both are
  cleared."
- "Given a deleted tracking ref's reflog file, Then the reflog file
  is gone after the action runs."
- "Given an invalid remote name, Then throws `REMOTE_NAME_INVALID`."

Implementation:

- `listTrackingRefs(ctx, name)`: filter `enumerateRefs` to entries
  starting with `refs/remotes/<name>/`. Detect packed-only entries
  by cross-checking `isLoose`.
- `deleteTrackingRefs(ctx, refs)`: `updateRef(ctx, ref, ZERO_OID,
  { delete: true })` per entry. Surfaces `UNSUPPORTED_OPERATION` on
  packed-only.
- Rewrite config with a single `updateConfigOperations` batch:
  one `removeSection` + N `removeEntry` for cleared `remote` /
  `merge` keys.

Commit: `feat(remote): remove action with tracking-ref cleanup`.

## Slice 7 — `rename`

Tests:

- "Given an unknown `from`, Then throws `REMOTE_NOT_CONFIGURED`."
- "Given `to === from`, Then throws `INVALID_OPTION`."
- "Given an existing `to`, Then throws `REMOTE_EXISTS`."
- "Given a canonical default refspec, Then it's rewritten for the
  new name."
- "Given a custom refspec, Then it's preserved verbatim."
- "Given a mixed list (one canonical, one custom), Then only the
  canonical entry is rewritten."
- "Given tracking refs under `refs/remotes/<from>/*`, Then they're
  moved to `refs/remotes/<to>/*` with the same OIDs."
- "Given a branch with `remote = <from>`, Then it now reads `remote
  = <to>`."
- "Given a packed-only tracking ref, Then throws
  `UNSUPPORTED_OPERATION`."
- "Given an invalid `to` name, Then throws `REMOTE_NAME_INVALID`."

Implementation:

- `moveTrackingRefs`: per-ref read, write to new name, delete old
  (reuse `updateRef`).
- Config batch: `renameSection`, set the rewritten refspecs as
  fresh `set` ops (delete + set is simpler than in-place edit),
  set the rewritten `branch.<X>.remote` values.

Commit: `feat(remote): rename action with tracking-ref move`.

## Slice 8 — `setUrl`

Tests:

- "Given an unknown remote, Then throws `REMOTE_NOT_CONFIGURED`."
- "Given a known remote, When `setUrl({url})` runs, Then
  `remote.<n>.url` is the new value and `pushUrl` is unchanged."
- "Given a known remote, When `setUrl({url, push: true})` runs,
  Then `remote.<n>.pushurl` is the new value and `url` is
  unchanged."
- "Given a url with a newline, Then throws `INVALID_OPTION`."
- "Given an invalid remote name, Then throws `REMOTE_NAME_INVALID`."

Implementation: single `updateConfigEntries` write, then
`readConfig` to refresh the result payload.

Commit: `feat(remote): setUrl action with pushurl support`.

## Slice 9 — `push.ts` honours `pushurl`

Tests (`test/unit/application/commands/push.test.ts` extension):

- "Given a remote with `pushurl` set, When `push` runs, Then it
  resolves the push URL from `pushurl`."
- "Given a remote with only `url` set, When `push` runs, Then it
  resolves the push URL from `url` (fallback)."
- "Given a remote with both, When `push` runs, Then `pushurl` wins."

Implementation: `push.ts:resolveRemoteUrl` reads `pushurl ?? url`.
Update the existing `remoteNotConfigured` guard accordingly.

Commit: `feat(push): honour remote.<name>.pushurl`.

## Slice 10 — `show`

Tests:

- "Given an unknown remote, Then throws `REMOTE_NOT_CONFIGURED`."
- "Given a remote with tracking refs and tracking branches, Then
  `trackingRefs` and `trackedBy` reflect them."
- "Given a remote with `pushurl` set, Then `pushUrl` is populated."
- "Given a remote with no tracking refs, Then `trackingRefs` is
  empty."
- "Given a remote with only `branch.<X>.remote` (no `merge`), Then
  `trackedBy[i].merge` is `undefined`."
- "Given an invalid name, Then throws `REMOTE_NAME_INVALID`."

Implementation: read `readConfig`, filter `enumerateRefs` to
`refs/remotes/<name>/*`, resolve each via the ref store.

Commit: `feat(remote): show action (local-only)`.

## Slice 11 — Integration test

`test/integration/remote-lifecycle.test.ts`:

- Round-trip: init → add → list → setUrl → setUrl --push → rename
  → remove → list. Asserts the final config and refs match expected
  empty state.
- `git config --get` cross-tool parity: spawn `git` against the test
  repo (with `GIT_*` env scrubbed per the project's existing test
  hygiene rule, per the auto-memory note) and verify the values
  match what tsgit wrote.

`@proves` surface header: `repo.remote`, bucket `remote-crud`.

Commit: `test(integration): remote lifecycle round-trip`.

## Slice 12 — Parity scenario + browser audit allowlist update

- `test/parity/scenarios/remote-crud.scenario.ts`: a `Scenario<…>`
  exercising add → setUrl → rename → remove. Captures a load-bearing
  golden — e.g. the tracking-ref name before and after rename.
- Add to `test/parity/scenarios/index.ts`.
- Run `tooling/audit-browser-surface.ts` locally — the `remote` name
  on `repo.*` should be covered by the new scenario; no allowlist
  entry needed.

Commit: `test(parity): remote-crud scenario across Node + Memory +
OPFS`.

## Slice 13 — Documentation

- `docs/get-started/<remote-page>.md` — minimal 60-second flow:
  `repo.remote({ kind: 'add', name: 'upstream', url: '…' })` →
  `repo.fetch({ remote: 'upstream' })`.
- `docs/use/remote.md` — every action's signature with examples.
- `docs/understand/remote.md` — how the config + refs are laid out.
- README — add `remote` to the surface list if appropriate.
- `docs/BACKLOG.md` — flip `[ ] 20.5` to `[x] 20.5` with the design
  + ADR references.

Commit: `docs(20.5): remote CRUD porcelain — get-started / use /
understand pages`.

## Slice 14 — Review and harness

- Three review passes (see CLAUDE.md). Parallel: code-reviewer,
  security-reviewer, test-review, perf review.
- `npm run validate` green.
- `stryker run` — kill every survivor or document equivalents
  inline.

## Slice 15 — Push + PR

- `git push -u origin feat/remote-crud-porcelain`.
- `gh pr create` with a thorough body (summary + test plan).
- Squash-merge on green. Worktree cleanup.

## Dependencies between slices

```
Slice 1 (config helpers)
   └── Slice 2 (errors)
         └── Slice 3 (remote-config helpers)
               └── Slice 4 (skeleton + list)
                     ├── Slice 5 (add)
                     ├── Slice 6 (remove)
                     ├── Slice 7 (rename)
                     ├── Slice 8 (setUrl)
                     │     └── Slice 9 (push pushurl)
                     └── Slice 10 (show)
                           └── Slice 11 (integration)
                                 └── Slice 12 (parity)
                                       └── Slice 13 (docs)
                                             └── Slice 14 (review)
                                                   └── Slice 15 (PR)
```

Slices 5–8 and 10 are parallel slices once Slice 4 lands; if agent
teams are run, they can take one each. Slice 9 (`push` extension) is
serially after Slice 8 because the test in Slice 8 only asserts the
config write — Slice 9 makes `push` honour it.

## Self-review log

### Pass 1 → Pass 2

- Slice 6's "deleted reflog file is gone" test added — without it the
  reflog cleanup is implicit on `updateRef`'s delete path and a
  reviewer asks "is the reflog cleaned up?" once. Codify.
- Slice 7's "from === to" case promoted from §4.4 of the design to a
  named test in Slice 7 so the order-of-checks (validate names →
  equality → lookup) is explicit.
- Slice 8 / Slice 9 split — earlier draft folded the `push.ts`
  extension into Slice 8; that conflates two concerns (porcelain
  write surface vs. consumer read surface). Two commits is cleaner.
- Slice 1.5 batch entrypoint added — earlier draft used three
  separate calls (`removeConfigEntry`, `removeConfigSection`,
  `renameConfigSection`) from `remote.ts`, each with its own
  `writeUtf8` round trip. Batching them in one entrypoint matches
  the existing `updateConfigEntries` shape and halves the I/O.

### Pass 2 → Pass 3

- Per-banned-character test cases called out explicitly in Slices
  3.1, 5, 6, 7, 8, 10 — without them, Stryker survives the
  `'"'` → `''` mutants on the validator regex.
- Slice 12's allowlist note added — Phase 19.5a's audit will fail
  CI if `repo.remote` lacks scenario coverage and no allowlist
  entry exists. The bundled scenario is the intended close.
- Slice 11's `git config --get` cross-tool parity test made explicit
  — pointing at the auto-memory test-hygiene rule (`GIT_*` env scrub
  in subprocess spawns) avoids the branch-pollution recovery
  pattern called out there.

### Pass 3 → converged

- Dependency graph added; without it Pass-3 reviewer asks "can these
  ship as parallel agent slices?". Yes for 5/6/7/8/10 once 4 lands.
- Slice 1's "double-key removal" test added (mirrors `--unset-all`).
  An earlier draft only handled single-key; remove of a stray
  duplicate is the safer default given canonical config files
  occasionally do have duplicates (mostly from manual edits).
