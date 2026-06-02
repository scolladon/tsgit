# Plan — `show` (formatted object output)

TDD, bottom-up: pure `domain/show/` renderers first, then the orchestrating
command, then the facade wiring, then cross-tool interop. Each slice is one
atomic commit; `npm run validate` green before every commit. GWT/AAA, `sut`,
100% coverage, 0 killable mutants.

References: `docs/design/show-object-output.md`, ADR-240/241/242.

---

## Slice 1 — `domain/show/git-date.ts` · `feat(show): git default date formatter`

**Red.** `test/unit/domain/show/git-date.test.ts` + `git-date.properties.test.ts`.
- Example: `formatGitDate(1700000000, '+0200') === 'Wed Nov 15 00:13:20 2023 +0200'`;
  `(…, '+0000') === 'Tue Nov 14 22:13:20 2023 +0000'`; single-digit day
  `formatGitDate(1685700000, '+0000') === 'Fri Jun 2 10:00:00 2023 +0000'`
  (unpadded day); a negative offset; a pre-epoch timestamp.
- Property (`arbitraries.ts`: arbitrary safe timestamp + `±HHMM`): output
  matches `^(Sun|Mon|…|Sat) (Jan|…|Dec) \d{1,2} \d2:\d2:\d2 \d{4} [+-]\d{4}$`
  and the trailing tz equals the input verbatim. `numRuns` 200 (cheap).

**Green.** Pure: parse `±HHMM` → offset seconds; `local = (timestamp+offset)*1000`;
`WEEKDAYS[getUTCDay]`, `MONTHS[getUTCMonth]`, unpadded `getUTCDate`, zero-padded
H/M/S, full year, ` ${tz}`.

**Refactor.** `WEEKDAYS` / `MONTHS` as module `const` arrays.

---

## Slice 2 — `domain/show/message-indent.ts` · `feat(show): commit message indentation`

**Red.** `message-indent.test.ts`: `indentMessage` over
{subject-only, subject+body, leading-blank, trailing-blank-run, all-blank,
interior-blank, CRLF}. Each strip rule isolated:
- `'modify a.txt'` → `'    modify a.txt'`.
- `'initial commit\n\nsecond paragraph of body'` →
  `'    initial commit\n    \n    second paragraph of body'` (interior blank → `····`).
- `'foo\n\n\n'` → `'    foo'` (trailing strip); `'\n\nbar'` → `'    bar'` (leading strip).
- `''` and `'\n\n'` → `''` (all-blank).

**Green.** Split on `\n`; drop leading/trailing whitespace-only lines
(`is_blank_line` = `/^\s*$/`); prefix each kept line with four spaces; join `\n`.
Returns the block WITHOUT surrounding separators (caller frames it).

---

## Slice 3 — `domain/show/render-tree.ts` · `feat(show): tree listing renderer`

**Red.** `render-tree.test.ts`: `renderTreeListing(inputName, entries)`:
- `renderTreeListing('HEAD^{tree}', [a.txt(100644), sub(040000)])` →
  `'tree HEAD^{tree}\n\na.txt\nsub/\n'`.
- Raw-oid name echoed verbatim; `/` only for mode `040000`; symlink/gitlink/exec → no slash.
- Empty tree → `'tree <name>\n\n'`.

**Green.** `` `tree ${inputName}\n\n` `` + `entries.map(e => e.name + (isDirectory(e.mode) ? '/' : '') + '\n').join('')`.
Entries consumed in given (stored sorted) order.

---

## Slice 4 — `domain/show/render-tag.ts` · `feat(show): annotated tag block renderer`

**Red.** `render-tag.test.ts`: `renderTagBlock(tag: TagData)`:
- With tagger → `'tag v1.0\nTagger: A U Thor <author@example.com>\nDate:   <gitDate>\n\nrelease one\n'`
  (message **verbatim**, NOT indented; leading/trailing blank stripped like commits — pin against git in interop).
- No tagger → omits the `Tagger:`/`Date:` lines.
- Header uses `tag.tagName` (stored), not any input.

**Green.** Build lines: `tag ${tagName}`; if tagger → `Tagger: …` + `Date:   ${formatGitDate(tagger)}`;
blank; then the (leading/trailing-stripped) verbatim message + `\n`.

---

## Slice 5 — `domain/show/render-commit.ts` · `feat(show): commit block renderer`

**Red.** `render-commit.test.ts`: `renderCommitBlock({ id, commit, patchText? })`:
- Non-merge, with patch: `commit <oid>\nAuthor: …\nDate:   …\n\n    msg\n\n<patchText>`.
- Merge (≥2 parents): inserts `Merge: <p1-7> <p2-7>\n` after `commit`; **no** patch even if `patchText` given (caller passes none, but the renderer must not append when parents≥2). _Decision: caller is the single gate — renderer appends `patchText` iff provided; merge-suppression lives in the command._ → test that with `patchText` undefined the block ends after the message.
- Empty patch (`patchText` undefined): block ends after the indented message.
- Author/Date use the **author** identity.

**Green.** Lines: `commit ${id}`; if `parents.length ≥ 2` → `Merge: ${parents.map(p=>p.slice(0,7)).join(' ')}`;
`Author: ${name} <${email}>`; `Date:   ${formatGitDate(author)}`; `''`; `indentMessage(message)`.
Join `\n` + `\n`. Then `patchText !== undefined && patchText !== '' ? '\n' + patchText : ''`.

**Refactor.** Extract `renderIdentityHeader(label, identity)` shared by commit
(`Author`) and tag (`Tagger`) → both call `formatGitDate`.

---

## Slice 6 — `domain/show/show-stream.ts` · `feat(show): shown_one stream composer`

**Red.** `show-stream.test.ts`: `renderShowStream(nodes)` over the separator matrix:
- single commit → `encode(text)`.
- commit→commit → `text1 + '\n' + text2` (blank-line separator).
- blob→commit → `content + text` (NO separator).
- tree→commit → separator present.
- blob→blob → raw concat.
- tag node → `tagText + '\n' + render(target)` (target inherits `shownOne`).
- dedup: `[commitA, commitB, commitA]` → A rendered once (`shownCommits`).
- Assert exact `Uint8Array` bytes (decode for readability).

**Green.** `ShowStreamNode` union (domain-local; commit carries `id` for dedup,
tag carries `target`). Stateful walk `{ shownOne, shownCommits:Set }`:
emit per §5. UTF-8 `encode` text nodes; append blob `content` raw; concat via a
growing chunk list → single `Uint8Array`.

---

## Slice 7 — `domain/show/index.ts` · `feat(show): domain show barrel`

Barrel re-exporting `formatGitDate`, `indentMessage`, `renderTreeListing`,
`renderTagBlock`, `renderCommitBlock`, `renderShowStream`, and the
`ShowStreamNode` type. No logic; coverage via consumers.

---

## Slice 8 — `application/commands/show.ts` · `feat(show): show command`

**Red.** `test/unit/application/commands/show.test.ts` (memory adapter, real
objects written via primitives): `show(ctx, input?, opts?)`:
- default `HEAD` → one commit result; `objects[0].kind==='commit'`, `.commit`
  populated, `.patch` present, `.text` self-contained, `bytes` = encode(text).
- tag rev → `kind==='tag'`, `.tag`, `.target.kind==='commit'`, `bytes` =
  tagBlock + `\n` + commit render.
- tree rev (`<oid>` / `HEAD^{tree}`) → entries + header echoes input.
- blob rev → `.content` bytes; `bytes` === content.
- merge commit → `.patch` undefined, `Merge:` line in `.text`, no diff.
- root commit → patch vs empty tree (`new file mode`).
- multi-rev `['v1.0','HEAD']` → 2 `objects`, `bytes` concatenated with separator.
- `contextLines` → wider hunks in the commit patch.
- bad rev → propagates `REVPARSE_UNRESOLVED` (assert `.data.code`).

**Green.** Orchestrate:
1. `assertRepository`.
2. Normalise `input` → `string[]` (default `['HEAD']`).
3. Per rev: `oid = await revParse(ctx, rev)` (no tag auto-peel); `obj = await readObject(ctx, oid)`; `buildResult(rev, obj)`.
4. `buildResult`:
   - blob → `{ kind:'blob', id, content }`.
   - tree → `entries` from `obj.entries`; `text = renderTreeListing(rev, entries)`; `{ kind:'tree', id, entries, text }`.
   - commit → `patch = parents.length<2 ? await commitPatch(ctx, obj.data, opts) : undefined`;
     `text = renderCommitBlock({ id, commit: obj.data, patchText: patch?.text })`;
     `{ kind:'commit', id, commit: obj.data, ...(patch?{patch}:{}) , text }`.
   - tag → `target = await buildResult(rev, await readObject(ctx, obj.data.object))`;
     `text = renderTagBlock(obj.data)`; `{ kind:'tag', id, tag: obj.data, target, text }`.
5. `commitPatch(ctx, commit, opts)`: `parentTree = commit.parents[0] ? (await readObject(ctx, commit.parents[0])).data.tree : undefined`;
   `tree = await diffTrees(ctx, parentTree, commit.tree, { detectRenames:true })`;
   `files = await materialisePatchFiles(ctx, tree.changes)`;
   `text = renderPatch(files, contextLines!==undefined ? { contextLines } : {})`;
   `{ format:'patch', text, diff: tree }`.
6. `bytes = renderShowStream(objects.map(toStreamNode))`.
7. return `{ objects, bytes }`.

`PatchResult` imported from `./diff.js`; `CommitData`/`TagData`/`FileMode`/`ObjectId` from domain.
`toStreamNode` maps each `ShowResult` → `ShowStreamNode` (tag recurses).

**Mutation-resistant.** Isolated guard tests (merge vs non-merge patch gate;
root vs non-root parent-tree branch; tag-recursion); `.data.code` error asserts.

---

## Slice 9 — facade wiring · `feat(show): expose repo.show on the facade`

- `commands/index.ts`: `export … from './show.js'` (`show`, `ShowInput`,
  `ShowOptions`, `ShowResult` + variants, `ShowTreeEntry`, `ShowOutput`).
- `repository.ts`: add `readonly show: BindCtx<typeof commands.show>;` to
  `Repository`; bind `show: ((input, opts) => { guard(); return commands.show(ctx, input, opts); })`.
- Regenerate + commit `reports/api.json` (prepush `check:doc-typedoc` gate).
- Facade test: `repo.show` bound + `guard()` (disposed repo throws `REPOSITORY_DISPOSED`).

---

## Slice 10 — `test/integration/show-interop.test.ts` · `test(show): cross-tool git parity`

The faithfulness gate. `interop-helpers` to build fixtures with real `git`
(scrubbed `GIT_*`, signing off). Assert `(await repo.show(rev)).bytes`
**byte-equals** `git show <rev>` for: commit (subject+body), root commit, merge
commit, annotated tag, lightweight tag (renders as commit), tree (`^{tree}` +
raw oid), blob, multi-rev (`A B`), tag→commit, rename patch
(`similarity index`/`rename from`/`rename to`), `contextLines` (`-U5`).

---

## Slice 11 — docs + backlog · `docs(show): document show; flip 23.1`

- `README.md` — add `show` to the command list/table.
- `docs/use/` page (mirror an existing command page, e.g. `log`/`diff`) — usage,
  return shape, multi-rev, `contextLines`.
- `RUNBOOK.md` / `CONTRIBUTING.md` — only if they enumerate commands.
- `docs/BACKLOG.md` — flip `[ ] **23.1**` → `[x]` with ADR + design refs.

---

## Validation gates (every slice)

`npm run validate` green; never `--no-verify`; no ignore directives; no
phase/ADR refs inside source/test code. After Slice 9, ensure `reports/api.json`
is committed. Mutation (`stryker run --mutate <touched files>`) after the
review + architecture-refactor passes, per the workflow.
