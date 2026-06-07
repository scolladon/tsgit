# Design — `shortlog` (per-author commit summary)

## Goal

Tier-1 `repo.shortlog(opts?)` — git's `git shortlog`: walk the reachable commits
from a revision and group them by author (or committer) identity, summarising
each group's commits. **Structured data only** (ADR-249): per-author groups of
`{ id, email, subject }`, with the group keyed by the identity's name; the
`-e` / `-n` / `-s` renderings are caller projections. A thin consumer of the
read model (`walkCommitsByDate`, 23.4b) plus a faithful subject projection.

## Faithfulness research (verified against real `git`)

All semantics below were confirmed against canonical `git shortlog` with scrubbed
`GIT_*` env and `--cleanup=verbatim` to isolate exact message bytes. They are the
binding contract; the design merely records them.

1. **Grouping key = the identity *name*, not name+email.** `git shortlog`
   (default) merges every commit whose author *name* matches, regardless of
   email — `Alice <a@x>` and `Alice <b@x>` form one `Alice (n)` group. The
   `-e` flag *re-groups* by name+email (it is **not** a pure rendering toggle).
   Case- and byte-sensitive: `Alice` and `alice` are distinct groups.
2. **`-e` is reconstructable from the structured data.** Because every commit in
   a name-group carries its own `email`, a caller renders `-e` by re-partitioning
   each name-group by email and byte-sorting the resulting `Name <email>`
   sub-groups. No information is lost by keying on name + per-entry email
   (the backlog's chosen representation).
3. **Group order = byte-wise ascending by name** (`strcmp` on UTF-8 bytes, git's
   `string_list` default). Verified: `Alice` < `Bob` < `alice` (upper before
   lower); `Zed` < `Été` (0x5A < 0xC3). **Not** JS default sort (UTF-16 code
   units) → must use the domain `compareBytes` over a UTF-8 encoding.
4. **Within-group order = oldest first**, which is the *exact reverse* of the
   default `git log` walk (newest committer-date first). Verified on a branch+
   merge history where topo ≠ date: the group lists commits in the reverse of
   `walkCommitsByDate`'s emission order.
5. **Merges are included** (no `--no-merges` by default), like `git log`.
6. **Subject = git's cleaned oneline**, a strict superset of `%s`:
   `format_subject(message)` → trim leading ASCII ws → if it starts with the
   literal `[PATCH`, drop through the first `]` → trim leading ASCII ws. Verified
   byte-for-byte across 9 cases:
   - `[PATCH] x` → `x`; `[PATCH v2] x` → `x`; `[PATCHwork] y] z` → `y] z`
     (strip to **first** `]`); `[PATCHv2]x] w` → `x] w`.
   - `[BUGFIX] x` → unchanged (only the literal `[PATCH` prefix triggers);
     `[patch] x` → unchanged (case-sensitive); `[PATCH no-close` → unchanged
     (no `]` before end-of-line).
   - `[PATCH]\n\nbody` → `''` (blank line ends the subject before any content);
     `[PATCH]\nbody` → `body`; `[PATCH]   \n  next` → `next`.
7. **`format_subject` (git `%s`) skips *leading* blank lines** then folds the
   leading paragraph to one space-joined line (per-line trailing ws stripped,
   continuation-line leading ws preserved, stop at the first blank line after
   content). Verified: `\nx` → `x`, `\n\ny` → `y`, `   \nz` → `z`.
8. **Unborn HEAD refuses** — `git shortlog HEAD` errors on an unborn branch; the
   library inherits this via `resolveCommit('HEAD')` (same as `log`).

## Surfacing latent bug: `foldSubject`

The existing `domain/objects/commit-message.ts` `foldSubject` is documented as
git's `%s`/`format_subject`, but it **breaks on the first blank line** rather
than skipping *leading* blanks — so `foldSubject('\nx')` returns `''` where git
`%s` returns `x` (research §7). This divergence is currently masked because
`foldSubject` has **zero `src` consumers** (only test oracles); committed messages
are pre-`stripspace`d so leading blanks never reach it. `shortlog` is its **first
production consumer**, and it must be faithful. The fix (skip leading blank lines,
then fold, then stop at the next blank) is therefore in-scope here, with no
production blast radius, and strictly *more* faithful. Its example test for the
leading-blank case is corrected; the `history-interop` oracle (built from
real-committed, pre-stripped messages) stays green.

## Architecture

Hexagonal, mirroring `describe` / `blame`:

```
src/
├── domain/
│   ├── objects/commit-message.ts     # MODIFY: faithful foldSubject (leading-blank skip)
│   └── shortlog/                      # NEW pure subsystem
│       ├── clean-subject.ts          # cleanShortlogSubject(message): git insert_one_record subject
│       ├── group.ts                  # groupShortlog(entries): name-group, oldest-first, byte-sort
│       └── index.ts                  # barrel (internal — not on public api.json)
└── application/commands/
    └── shortlog.ts                   # NEW Tier-1: resolve → walkCommitsByDate → project → group
```

**Dependency rule preserved:** the command orchestrates I/O (resolve + walk);
the domain does the pure projection (subject cleaning) and aggregation
(grouping/sorting). Nothing crosses the hexagon inward.

### Domain — `cleanShortlogSubject(message: string): string`

Pure port of git's `insert_one_record` subject path (research §6/§7):

```
s = foldSubject(message)        // faithful git %s
s = trimLeadingAsciiWs(s)       // git's first isspace skip
if s starts with "[PATCH":
    j = s.indexOf("]")          // s is single-line, so no eol guard needed
    if j !== -1: s = s.slice(j + 1)
s = trimLeadingAsciiWs(s)       // git's second isspace skip
return s
```

`trimLeadingAsciiWs` strips leading bytes in git's ASCII `isspace`
(`[ \t\n\v\f\r]`) — Unicode-blind (no `String.trimStart`), mirroring the existing
trailing-ws regex in `commit-message.ts`.

### Domain — `groupShortlog(entries: ReadonlyArray<ShortlogEntry>): ReadonlyArray<ShortlogGroup>`

`entries` arrive in **walk order** (newest first). Pure aggregation:

- Bucket by `entry.name` into an insertion-ordered map (first appearance wins the
  slot; preserves which names exist).
- Each bucket accumulates `{ id, email, subject }` in walk order, then is
  **reversed** → oldest first (research §4).
- Emit groups **byte-sorted ascending by name** via `compareBytes` over a UTF-8
  `TextEncoder` (research §3).

`ShortlogEntry = { name, email, id, subject }` is the domain-internal input
record (the chosen identity already selected by the command).

### Application — `shortlog(ctx, opts?)`

```
await assertRepository(ctx)
startId = await resolveCommit(ctx, opts.rev ?? 'HEAD')          // full grammar, like log
exclude = await Promise.all((opts.excluding ?? []).map(r => resolveCommit(ctx, r)))
entries = []
for await (c of walkCommitsByDate(ctx, { from: [startId], until: exclude })):
    ident = opts.by === 'committer' ? c.data.committer : c.data.author
    entries.push({ name: ident.name, email: ident.email, id: c.id,
                   subject: cleanShortlogSubject(c.data.message) })
return groupShortlog(entries)
```

CQS: a pure query, no writes. Aborts honoured by the walk.

## Public surface

```ts
repo.shortlog(opts?: ShortlogOptions): Promise<ReadonlyArray<ShortlogGroup>>;

interface ShortlogOptions {
  readonly rev?: string;                       // commit-ish, full grammar; default 'HEAD'
  readonly excluding?: ReadonlyArray<string>;  // negative range stops (git's A..B / ^X)
  readonly by?: 'author' | 'committer';        // grouping identity; default 'author'
}

interface ShortlogCommit {
  readonly id: ObjectId;
  readonly email: string;   // the chosen identity's email (per commit)
  readonly subject: string; // git's cleaned shortlog oneline
}

interface ShortlogGroup {
  readonly name: string;                            // the chosen identity's name
  readonly commits: ReadonlyArray<ShortlogCommit>;  // oldest first
}
```

**Caller projections** (not library concerns, ADR-249):
- `-s` (summary): `group.commits.length`.
- `-n` (numbered): re-sort groups by `commits.length` desc.
- `-e` (email): re-partition each group by `commit.email`, byte-sort the
  `name <email>` sub-groups.

### Open decisions (→ ADR conversation)

- **D1 — subject fidelity** (research §6 + `foldSubject` fix): reproduce git's
  full cleaning (incl `[PATCH` stripping) as the entry's `subject`, vs. return a
  rawer subject. *Recommend:* full faithful cleaning — it is shortlog's defining
  datum; a caller cannot re-derive git's `[PATCH` rule.
- **D2 — grouping representation**: key on name + per-entry email (reconstructs
  default *and* `-e`), vs. key on full `name <email>` (default reconstructed by
  merge), vs. flat list. *Recommend:* name-keyed (the backlog's choice; §1/§2).
- **D3 — range support (`excluding`)**: include now (faithful `git shortlog
  A..B`), vs. YAGNI-defer to a follow-up. *Recommend:* include — it is a 2-line
  pass-through to `walkCommitsByDate`'s `until` and a real git capability, not
  speculative.
- **D4 — identity selector shape**: `by: 'author' | 'committer'` enum, vs.
  `committer: boolean`. *Recommend:* the enum (mirrors `log`'s `order`; avoids a
  boolean param; extensible).

## Surface gates (per the Tier-1 checklist)

- `src/application/commands/shortlog.ts` + barrel export in `commands/index.ts`.
- `repository.ts`: `Repository.shortlog` field + bound method.
- `test/unit/repository/repository.test.ts`: add `'shortlog'` to the top-level
  key-set assertion.
- `domain/shortlog/` unit + property tests; `commit-message` test update.
- `test/integration/shortlog-interop.test.ts`: reconstruct `git shortlog`
  (default, `-e`, `-c`, `[PATCH]`, merge) byte-for-byte from the structured data.
- `test/parity/scenarios/shortlog.scenario.ts` + registry: cross-adapter
  (node/memory/browser) parity.
- Docs: `docs/use/commands/shortlog.md`, index `README.md` (33 → 34 entries),
  root `README.md` count (33 → 34 Tier-1), `reports/api.json` regen.
- `docs/BACKLOG.md`: flip `23.5` `[ ]` → `[x]`.

## Testing strategy

- **GWT/AAA, `sut`, 100% coverage, 0 surviving mutants** (per CLAUDE.md).
- **`cleanShortlogSubject`** — example tests for each research §6/§7 case;
  property test (lens 1/3 — total function over ASCII messages: never throws,
  output is single-line, idempotent under re-clean).
- **`groupShortlog`** — example tests (single author, multi-author byte-sort,
  same-name-diff-email merge, within-group reversal); property tests (lens 2 —
  compositional aggregator: empty → empty; group count = distinct names; every
  group non-empty; byte-sorted; per-group order is the reverse of input order).
- **`foldSubject`** — corrected leading-blank example + new leading-blank cases;
  existing property tests stay (idempotence, no-newline, prefix).
- **Interop** — `shortlog-interop.test.ts` builds repos with real git
  (deterministic dates, signing off) and reconstructs `git shortlog` /
  `-e` / `-c` output from the structured groups, asserting byte-equality.
- **Mutation-resistant**: specific error assertions; isolated guard tests for
  the `[PATCH` prefix branch and the `]`-found branch; byte-sort proven with a
  case that JS default sort would order differently (e.g. `Zed` vs `Été`).

## Non-goals (deferred, git-faithful divergences noted)

- **`.mailmap` canonicalisation** — no mailmap support anywhere yet
  (cross-cutting follow-up, per backlog).
- **Rendering flags** (`-e`/`-n`/`-s`/`-w` wrap) — caller projections (ADR-249).
- **`--no-merges` / `--max-count` / committish file args** — YAGNI; the core
  walk + grouping is the deliverable.
```
