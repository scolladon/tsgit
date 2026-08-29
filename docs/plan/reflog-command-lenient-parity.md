# Plan — reflog command lenient parity

> Source: design doc `docs/design/reflog-command-lenient-parity.md` · ADRs `737–746`
> The plan is the implementation script AND the knowledge handoff. Part agents start
> with zero context: whatever a part block omits is paid later as agent rediscovery.
> `plan-lint.sh` enforces the schema below — the plan phase cannot close without it.

## Sizing rules

Six parts, strictly sequential in one working tree — each builds on the previous one.
No test-only parts: every part carries production code plus the tests that exercise it,
landing as one atomic conventional commit.

The interop suite `test/integration/reflog-interop.test.ts` is **born in Part 3** (the
first part that makes a user-facing read lenient) and **grown by Parts 4, 5, 6**. No part
commits an interop expectation for behaviour a later part delivers. Case-to-part map:

| interop case (design §Test strategy) | lands in |
|---|---|
| 1 read parity ✅ rows, 2 ❌ divergence rows, 3 accepted-line rows, 4 numbering, 10a `stash list` | Part 3 |
| 5 `delete` rewrite bytes, 7 `expire` rewrite ×3, 8 degenerate files, 9 `--all`, 10b `stash drop` bytes | Part 4 |
| 6 out-of-range `delete` (both fixtures) | Part 5 |
| 10c `branch -m` byte preservation | Part 6 |

Rows 23 (zero timestamp) and 25 (unterminated final line) join case 1's **parity**
assertions because Part 1 already closed them — that is why Part 1 comes first.

**Files named by more than one part — why they are not merged**

| file | parts | why separate |
|---|---|---|
| `src/application/commands/reflog.ts` | 3, 4, 5 | Three independent decisions on three different functions: the *read* swap (`runShow`/`runDelete`/`runExpire`), `runExpire`'s deleted write guard, and `runDelete`'s removed throw sites plus the published `ReflogResult` change. Merging them would put one commit behind three separate interop oracles and make a revert all-or-nothing. |
| `src/application/primitives/ref-store.ts` | 2, 4, 6 | Three different seam concerns: the lenient read verb, the rewrite serializer + atomic replace, the move verb. Part 4's and Part 6's work does not exist as a concept until their ADRs' preconditions are met by earlier parts. |
| `src/domain/reflog/reflog-format.ts` | 1, 4 | Part 1 changes the **parsers** (the read contract); Part 4 adds the **rewrite serializer** (the write contract). The serializer cannot land in Part 1 — an export with no consumer trips knip (`check:dead-code`), and its consumer is Part 4's `applyReflogReplace`. |
| `src/application/commands/branch.ts` | 3, 6 | Part 3 names it only to say **do not touch it** (it is the one reader leniency cannot fix). The single edit is Part 6's. |
| `src/application/commands/internal/fsck/roots.ts` | 2, 3 | Part 3 names it only to say **do not touch it** (fsck's arms stay strict by decision). The single edit is Part 2's. |
| `test/integration/reflog-writers.test.ts` | 3, 4 | Never edited. Both parts run it as a regression guard on the **append** byte format, which must stay byte-identical throughout. |

**Cross-cutting facts every part needs**

- Coverage (`vitest.config.ts` `coverage.include`) gates `src/domain/**`, `src/ports/**`,
  `src/adapters/node|memory/**`, `src/operators/**` at 100 %. `src/application/**` is
  **not** coverage-gated — but Stryker mutates all of `src/`, so application-layer
  assertions still have to kill mutants.
- Error assertions: always `try`/`catch` + `expect((err as TsgitError).data).toEqual({...})`.
  Never bare `toThrow(TsgitError)`. `reflog-format.test.ts` already exposes the helper
  `expectInvalidReflogEntry(act, expectedReason)` (L32–42) — reuse it.
- Test titles: `describe('Given …')` > `describe('When …')` > `it('Then …')`, AAA body
  with `// Arrange` / `// Act` / `// Assert` comments. `sut` names the **function under
  test**, never the result (the result goes in `result`). When extending an established
  describe block, follow that file's existing arrangement rather than churning its
  untouched neighbours.
- No provenance refs (ADR/phase/backlog numbers) in source or test code. Explain the
  *behaviour* and cite "git 2.55.0, measured" instead.
- No suppression directives. The one pre-existing Stryker directive in scope is
  `reflog-format.ts` L83 — Part 1 owns re-proving it (never carrying it forward blind).
- `getRefStore(ctx)` memoises per **Context object identity** in a `WeakMap`
  (`ref-store.ts` L244–253). When a caller derives a Context (`{ ...ctx, … }`,
  `deriveWorktreeContext`), every subsequent read/write must go through
  `getRefStore(derivedCtx)` — reading back through the original `ctx` is the known
  fanout-cache trap that yields intermittent `OBJECT_NOT_FOUND`.
- Verification probes that spawn real `git` or mutate state run in a `mktemp -d`
  throwaway, never in the worktree.

---

## Part 1 — Reflog parser predicates: torn final line + zero timestamp

### Context

**Decision source.** ADR-741 (both parsers drop an unterminated final line — a
*file-level* rule on the split, not a per-line predicate, so strict and lenient keep
agreeing about every file) and ADR-742 (`parseReflogLine` refuses a zero timestamp,
`parseIdentity` untouched). Design §1a rows 23 and 25, §2(f).

**File to change:** `src/domain/reflog/reflog-format.ts` (116 lines). Current shape:

- `serializeReflogLine(entry: ReflogEntry, hexLength: 40 | 64): string` — L26–38. Two
  guards today: `CONTROL_CHARS.test(entry.message)` → `invalidReflogEntry('message contains a line break')`;
  oid width mismatch → `invalidReflogEntry('object id does not match the repository oid width')`.
  Emits `${meta}\n` when `message === ''`, else `${meta}\t${message}\n` (git's **append**
  rule — do NOT change it; Part 4 adds the separate rewrite serializer).
- `parseReflogLine(line, hexLength): ReflogEntry` — L41–58. Order: tab split → offsets
  (`newIdStart = hexLength + 1`, `newIdEnd = newIdStart + hexLength`, `identityStart = newIdEnd + 1`)
  → separator check → `parseOid` ×2 → `parseReflogIdentity`.
  Private helpers `parseOid` (L101–107, reason `'invalid object id'`) and
  `parseReflogIdentity` (L109–115, reason `'invalid identity'`) at file bottom.
- `parseReflog(text, hexLength)` — L61–66: `text.split('\n').filter(l => l !== '').map(parseReflogLine)`.
- `parseReflogLenient(text, hexLength)` — L80–92: `for (const line of text.split('\n'))`,
  `if (line === '') continue;` guarded by the Stryker directive on **L83**, then
  `try { entries.push(parseReflogLine(...)) } catch { /* skipped */ }`.

**What to build.**

1. A private file-level split helper in the same module, e.g.

   ```ts
   /** git requires every reflog line to end with LF: a final line with no
    *  terminator is a torn write and is not an entry (measured, git 2.55.0). */
   const splitReflogLines = (text: string): readonly string[] => {
     const lastTerminator = text.lastIndexOf('\n');
     return lastTerminator === -1 ? [] : text.slice(0, lastTerminator).split('\n');
   };
   ```

   Both `parseReflog` and `parseReflogLenient` consume it in place of `text.split('\n')`.
   Verified against every pinned row: `''` → `[]`; `'garbage'` (no LF) → `[]` (row 25);
   `'a\n'` → `['a']`; `'a\n\n'` → `['a','']` (row 17, blank filtered/skipped);
   `'a\r\nb\r\n'` → `['a\r','b\r']` (row 18 — the `\r` stays on the message, which is
   what git does).

2. `parseReflogLine`: after `const identity = parseReflogIdentity(...)`, add the isolated
   guard `if (identity.timestamp === 0) throw invalidReflogEntry('zero timestamp');`.
   `parseIdentity` (`src/domain/objects/author-identity.ts`) is **not** touched — rows
   20–22 stay divergent by decision.

3. `serializeReflogLine`: the writer-side half of ADR-742 is decided by the round-trip
   property, not by taste. Expected outcome (state it in the commit only if it holds):
   the property fails at timestamp 0, so the writer gains a **third** guard, appended
   after the oid-width check:
   `if (entry.identity.timestamp === 0) throw invalidReflogEntry('timestamp must be non-zero');`
   Distinct reason string from the parser's so the two are separately assertable.
   Production reflog writes go through `resolveReflogIdentity`
   (`src/application/primitives/reflog-identity.ts`), which sets
   `timestamp: Math.floor(Date.now() / 1000)` — this guard is defensive, unreachable
   from any shipped write path, hence a domain unit test is its only coverage.

4. **Re-prove the L83 Stryker directive.** It reads:
   `// Stryker disable next-line ConditionalExpression,StringLiteral: equivalent — an empty 'line' always fails parseReflogLine's meta[hexLength] !== FIELD_SEPARATOR check (undefined !== ' ') and is caught below exactly like any other malformed line, so skipping this guard changes nothing observable.`
   The loop's producer changes from `text.split('\n')` to `splitReflogLines(text)`. Re-derive
   the proof **against the new shape** and re-word the comment to name the new helper —
   do not paste the old wording. Expected: the proof still holds (it depends only on
   `parseReflogLine('')` throwing and the `catch` swallowing it, both unchanged; empty
   lines are still reachable from `'a\n\n'`). If the re-derivation fails, **delete the
   directive** and add a test that kills the mutant. Never carry it forward unexamined.

**Test files.**

- `test/unit/domain/reflog/reflog-format.test.ts` (587 lines) — extend. Existing constants
  at the top: `OID_A`/`OID_B` (`ObjectId.from('a'.repeat(40))`), `IDENTITY`
  (timestamp `1716240000`, tz `'+0000'`), `ENTRY`, and the helper
  `expectInvalidReflogEntry`. Existing describes to extend: `serializeReflogLine` (L45),
  `parseReflogLine` (L153), `parseReflog` (L358), `parseReflogLenient` (L400+).
  **Delete** the trailing inline `describe('reflog line round-trip property', …)` block
  (L~552–587) — repo convention keeps property tests in a `.properties.test.ts` sibling,
  never mixed into the example file. Its arbitraries move to the new `arbitraries.ts`.
- **New** `test/unit/domain/reflog/reflog-format.properties.test.ts`.
- **New** `test/unit/domain/reflog/arbitraries.ts` — per-family generators for this
  directory. **Generate the hex alphabet from a numeric range**
  (`fc.integer({ min: 0, max: 15 }).map(n => n.toString(16))`), never a literal
  `'0123456789abcdef'` string: the security scan (CKV_SECRET_6) flags alphabet literals
  in test arbitraries.

**Blast-radius check to run before declaring GREEN:** no shipped path serializes a
zero-timestamp reflog entry, and no fixture writes a reflog file without a trailing LF —
but the whole reflog/branch/stash/rev-parse unit surface must be re-run, not assumed
(see the Gate).

### TDD steps

**RED 1 — torn final line, lenient parser.**
`describe('Given a reflog file whose final line has no terminating LF')` >
`describe('When parseReflogLenient parses it')` >
`it('Then the unterminated entry is absent and the terminated ones survive')`.
Arrange two serialized entries then a third serialized line with its trailing `\n`
stripped. Assert the result `toEqual([first, second])` — the surviving **entries**, not a
length. Fails today: the third entry is returned.

**RED 2 — torn final line, strict parser.**
Same fixture, `parseReflog`. `it('Then the unterminated entry is dropped rather than throwing')`.
Fails today: it parses the third entry and returns three.

**RED 3 — a file that is one unterminated line only.**
`parseReflog('garbage line', 40)` and `parseReflogLenient('garbage line', 40)` both
`toEqual([])`. Isolated from RED 1/2 so the `lastIndexOf === -1` arm is proven alone.
Fails today: strict throws, lenient returns `[]` for the wrong reason.

**GREEN 1** — add `splitReflogLines` and route both parsers through it. Re-word the L83
directive per the re-proof above.

**RED 4 — zero timestamp refused by the line parser (isolated).**
`describe('Given a reflog line whose timestamp is zero')` >
`describe('When parsing')` >
`it('Then throws INVALID_REFLOG_ENTRY with the zero-timestamp reason')`.
Build the raw line by hand (`${oid} ${oid} Ada <ada@example.com> 0 +0000\tcommit: x`) —
not through `serializeReflogLine`, which will refuse it after GREEN 3.
Assert via `expectInvalidReflogEntry(..., 'zero timestamp')`.

**RED 5 — the neighbouring guard, isolated.** A *non-numeric* timestamp
(`… ada@example.com> not-a-number +0200`) still throws with reason `'invalid identity'`.
Separate test so neither guard proves the other (mutation-resistance requirement).

**GREEN 2** — add the `identity.timestamp === 0` guard to `parseReflogLine`.

**RED 6 — the three properties.** Create `arbitraries.ts` + `reflog-format.properties.test.ts`:

- *Lens 3 — total function.* `describe('Given an arbitrary ASCII text with no NUL')` >
  `describe('When parseReflogLenient parses it')` > `it('Then it never throws')`.
  Arbitrary: `fc.string()` restricted to printable ASCII plus `\n`/`\t`/`\r`, no NUL;
  it must generate texts **with and without** a terminating LF (e.g.
  `fc.tuple(body, fc.boolean()).map(([b, lf]) => (lf ? `${b}\n` : b))`). `numRuns: 100`.
- *Lens 4 — counting invariant.* Generate an **array of candidate lines** (a mix of
  serialized-valid and generated-garbage), join with `'\n'` and terminate with a final
  `'\n'` so the torn-line rule is a no-op here. Assert
  `parseReflogLenient(text, 40).length === lines.filter(accepts).length`, where
  `accepts(line)` is `try { parseReflogLine(line, 40); return true } catch { return false }`.
  The oracle calls the *per-line* function — it does not re-implement the loop.
  `numRuns: 100`.
- *Lens 1 — round trip, the ADR-742 arbiter.* Arbitrary entries whose timestamp
  **can be 0** (`fc.oneof(fc.constant(0), fc.integer({ min: 1, max: 4_000_000_000 }))` —
  an explicit constant, so the zero case is guaranteed, not left to fast-check's
  boundary bias). Assert: `serializeReflogLine` either **refuses with the zero-timestamp
  reason and only for timestamp 0**, or produces a line the strict `parseReflog`
  recovers exactly:

  ```
  let line: string;
  try { line = serializeReflogLine(entry, 40); }
  catch (err) {
    expect((err as TsgitError).data).toEqual({ code: 'INVALID_REFLOG_ENTRY', reason: 'timestamp must be non-zero' });
    expect(entry.identity.timestamp).toBe(0);
    return;
  }
  expect(parseReflog(line, 40)).toEqual([entry]);
  ```

  `numRuns: 200`. Identity name/email arbitraries carry forward the existing constraints
  from the deleted inline block: no `\n`, `\r`, `<`, `>`, and `s.trim() === s`; messages
  exclude CR/LF and framing whitespace.
  **This property is the decider**: run it *before* GREEN 3 and record what it does. It
  fails at timestamp 0 (the serializer emits `… 0 +0000`, which `parseReflogLine` now
  rejects) — that failure is the mandate for the writer-side guard. If it unexpectedly
  passes, the writer guard does **not** ship and RED 7 is dropped.

**RED 7 — writer refuses a zero timestamp (isolated example).**
`describe('Given an entry whose identity timestamp is zero')` >
`describe('When serializing')` > `it('Then throws INVALID_REFLOG_ENTRY')`, asserting
`.data` reason `'timestamp must be non-zero'`. Domain coverage is 100 %-gated, so this
guard needs its own line-covering test.

**GREEN 3** — add the `serializeReflogLine` zero-timestamp guard.

**REFACTOR** — keep `splitReflogLines` a single expression under 20 lines with an
intent-only doc comment (why the LF is load-bearing, never what the code does). Confirm
the three existing `parseReflog`/`parseReflogLenient` blank-line and trailing-blank-line
tests still assert the same entries. Re-read the re-worded L83 directive one final time
against the shipped loop.

### Gate

```
npx vitest run test/unit/domain/reflog test/unit/application/primitives/reflog-store.test.ts test/unit/application/primitives/ref-store.test.ts test/unit/application/commands/reflog.test.ts test/unit/application/commands/branch.test.ts test/unit/application/commands/stash.test.ts test/unit/application/commands/rev-parse.test.ts test/unit/application/commands/maintenance.test.ts test/integration/reflog-writers.test.ts \
  && npm run check:types \
  && ./node_modules/.bin/biome check src/domain/reflog/reflog-format.ts test/unit/domain/reflog/reflog-format.test.ts test/unit/domain/reflog/reflog-format.properties.test.ts test/unit/domain/reflog/arbitraries.ts
```

### Commit

```
fix(reflog): drop an unterminated final line and refuse a zero timestamp
```

---

## Part 2 — One lenient read seam: `RefStore.readReflogLenient`

### Context

**Decision source.** ADR-737 (the lenient read is a `RefStore` seam verb with a
`reflog-store.ts` dispatcher; `fsck/roots.ts` deletes its private helper; the
`MAX_REFLOG_BYTES` cap still throws) and ADR-738 (reftable aliases its structural read).
Design §2(a) including the two call-out blocks, and §5.

**The duplicate to delete.** `src/application/commands/internal/fsck/roots.ts` L163–185:
a private `readReflogLenient(ctx, ref)` that rebuilds the exists/stat/cap preamble against
`reflogPath(perWorktreeRefDir(ctx, ref), ref)` and calls `parseReflogLenient`. Its doc
comment (L163–176) carries the rationale for the cap refusal — **move that reasoning onto
the new files-backend method**, it is the only place it is written down.

**Latent defect this closes (must be pinned by a failing-baseline test, not assumed).**
The reftable backend stores reflogs *in the stack*, never under `.git/logs/`
(`reftable-ref-store.ts` L275–290 reads `stack.logs(name)`). So under a reftable repo
gc's retention walk finds reflog names via the backend-aware `listReflogs` and then reads
**zero entries** for each — an object reachable only from a reflog is not rooted and
`gc --prune` deletes it silently.

**Files to change.**

1. `src/application/primitives/ref-store.ts`
   - Add to the `RefStore` interface (L46–130), directly after `readReflog` (L104–105):
     `readReflogLenient(name: RefName): Promise<readonly ReflogEntry[]>;` with a doc
     comment stating: same contract as `readReflog` except a line that does not parse is
     skipped instead of failing the whole file; the `MAX_REFLOG_BYTES` cap still throws
     (an over-cap reflog that silently rooted nothing is the silent-data-loss shape
     leniency must not create); every I/O fault still propagates.
   - Files backend `createFilesRefStore` (L345–817): `readReflog` is L610–619. Add a
     sibling `readReflogLenient` sharing the preamble. Extract the shared part so there is
     one exists/stat/cap implementation, e.g.

     ```ts
     /** `name`'s reflog text, or undefined when the file is absent. Refuses an over-cap file. */
     async function readReflogText(name: RefName): Promise<string | undefined> {
       const path = reflogPath(refDir(name), name);
       if (!(await ctx.fs.exists(path))) return undefined;
       const stat = await ctx.fs.stat(path);
       if (stat.size > MAX_REFLOG_BYTES) {
         throw invalidReflogEntry(`reflog file exceeds ${MAX_REFLOG_BYTES} bytes`);
       }
       return ctx.fs.readUtf8(path);
     }
     ```

     then `readReflog` = `parseReflog(text ?? '', hexLength)` and `readReflogLenient` =
     `parseReflogLenient(text ?? '', hexLength)`. Keep both returning `[]` for an absent
     file. Import `parseReflogLenient` from `'../../domain/reflog/reflog-format.js'`
     (L8 already imports `parseReflog, serializeReflogLine` from there).
   - Add `readReflogLenient` to the returned object literal (L806–816).
2. `src/application/primitives/reftable-ref-store.ts` — add `readReflogLenient` next to
   `readReflog` (L275–290) as an **alias of the structural read**, with the reasoning in
   its doc comment: reftable log records are length-prefixed binary inside a block, so a
   damaged record damages the block, not one entry; `readReflog` already skips
   non-`entry` records (L279); there is no oracle for an invented per-record tolerance.
   Add it to the returned object (L357–367).
3. `src/application/primitives/reflog-store.ts` — add the dispatcher next to `readReflog`
   (L24–27):

   ```ts
   /** `ref`'s reflog, oldest-first, skipping any line that does not parse. `[]` when absent. */
   export async function readReflogLenient(ctx: Context, ref: RefName): Promise<ReadonlyArray<ReflogEntry>> {
     return getRefStore(ctx).readReflogLenient(ref);
   }
   ```

4. `src/application/commands/internal/fsck/roots.ts`
   - Delete the private helper (L163–185); import `readReflogLenient` from
     `'../../../primitives/reflog-store.js'` (L18 already imports `listReflogs, readReflog`
     from there).
   - `addReflogRoots` (L198–212) keeps both arms exactly as they are — only the helper
     identity changes. fsck's non-strict arm stays strict (`readReflog`) by decision.
   - `addNonCurrentWorktreeRoots` (L398–408) calls the helper with a **per-worktree
     derived `Context`**. The dispatcher routes through `getRefStore(thatCtx)`, which is
     the correct derived-Context discipline — pass the derived ctx straight through, never
     re-read via the parent. `deriveWorktreeContext` inherits `layout.refStorage`
     (`internal/worktree-context.ts`), so the derived read is backend-correct.
   - **Prune the imports the helper leaves behind**: `parseReflogLenient` (L8),
     `invalidReflogEntry` (L6), `MAX_REFLOG_BYTES` (L20), and `reflogPath` (L16 — check
     whether `perWorktreeRefDir`/`commonGitDir` are still used elsewhere in the file
     before touching that line). Biome fails on an unused import.

**Public-surface decision: `readReflogLenient` (dispatcher) is PUBLIC.** It joins the
primitives barrel exactly as `readReflog` does. Gates to pre-pay **in this part**:

- `src/application/primitives/index.ts` L70–77 — add `readReflogLenient` to the
  `reflog-store.js` export block, alphabetical (between `readReflog` and `reflogExists`).
- `test/unit/application/primitives/index.test.ts` — **two** name lists
  (`it('Then all primitives are exposed as functions')` L7, and
  `it('Then only expected public surface is exposed')` L101). Add the name to both.
- `test/unit/api-surface/primitives-binding-surface.test.ts` — the export is `ctx`-first
  and is not bound on `repo.primitives`, so add an `EXCLUDED_PRIMITIVES` entry
  (alphabetically after the `readReflog` entry at L105–109) with a real reason, e.g.
  *"internal reflog-store primitive reused by reflog/rev-parse/stash/snapshot-factory/fsck-roots"*.
- `reports/api.json` — regenerate with `npm run docs:json` and **commit it** in this part.
  Staleness is caught by `check:doc-typedoc` at **prepush**, not by `validate`; the diff
  is large (typedoc ids) and that is normal.
- `RefStore` itself is **not** in `reports/api.json` (verified: zero occurrences), so the
  interface method alone would not move it — the barrel export is what does.

**Test files.**

- `test/unit/application/primitives/ref-store.test.ts` — files backend.
- `test/unit/application/primitives/reftable-ref-store.test.ts` — the alias. Existing
  reflog describes at L274 (`readReflog` over a stack), L467 (fully-tombstoned log),
  L539 (unknown ref). Fixtures come from
  `test/unit/application/primitives/reftable-fixtures.ts`: `withReftableStorage(ctx)`,
  `writeReftableFiles(ctx, dir, tables)`, `commonReftableDir(ctx)`.
- `test/unit/application/primitives/reflog-store.test.ts` (374 lines) — the dispatcher.
  Existing helpers to reuse: `entry(overrides)` (L31), `lineOfSize(bytes)` (L44 — builds a
  syntactically valid line of an exact byte length, used by the existing over-cap tests at
  L130 and L156), `OID_A`/`OID_B`, `HEAD`, `BRANCH`, `asWorktreeChild(ctx)` (L53).
- `test/unit/application/commands/maintenance.test.ts` — the reftable gc regression. The
  existing reflog-retention neighbours are at L1243 (malformed line in one reflog),
  L1297 (malformed line in the same file), L1342 (size cap), L1393 (EACCES). gc is driven
  as `await maintenance(ctx, { tasks: ['gc'] })` with `appendConfig(ctx, '\n[gc]\n\tpruneExpire = now\n')`.
- `test/unit/application/commands/fsck.test.ts` — re-run; the file paths read are
  unchanged (`reflogPath(perWorktreeRefDir(...))` in both old and new code), so the
  existing `readUtf8`/`stat` spies keep matching.

### TDD steps

**RED 1 — reftable gc retention regression (failing baseline, the defect ADR-737 closes).**
`describe('Given a reftable-backed repository where a commit is reachable only from a reflog')` >
`describe('When gc runs with prune=now')` > `it('Then the commit survives')`.
Arrange: `withReftableStorage` on a memory ctx, seed a commit, write an orphan commit
object, then record it into the stack via
`getRefStore(ctx).applyRefUpdates([{ kind: 'set', name: 'refs/heads/other', id: tip, reflog: { oldId: orphanCommitId, newId: tip, message: 'reset: moving to …' } }])`.
Act: `maintenance(ctx, { tasks: ['gc'] })`. Assert `readObject(ctx, orphanCommitId)`
resolves to a commit. **Fails today** — the private helper reads `.git/logs/**`, finds
nothing under reftable, and gc prunes the orphan.
*Fallback if the gc pipeline refuses a reftable repo outright* (verify before assuming it
runs; the existing reftable coverage is ref-store-level, not gc-level): pin the same
regression one level down by importing `collectRetentionRoots` from
`src/application/commands/internal/fsck/roots.js` and asserting the reflog-derived oid is
in the returned root set. That is still a failing baseline for the same defect — do **not**
downgrade it to a confirmation test written after the fix.

**RED 2 — files backend `readReflogLenient` skips a bad line.**
`describe('Given a files-backed reflog with a garbage line between two valid entries')` >
`describe('When readReflogLenient runs')` > `it('Then both valid entries are returned')`.
Assert the entries array, never a length. Fails: the method does not exist.

**RED 3 — the cap still refuses (isolated).** A reflog file one byte over
`MAX_REFLOG_BYTES` (build with `lineOfSize`) → `readReflogLenient` throws
`INVALID_REFLOG_ENTRY` with reason `` `reflog file exceeds ${MAX_REFLOG_BYTES} bytes` ``,
asserted via `try`/`catch` on `.data`. A **separate** test from RED 2 so each guard is
proven alone.

**RED 4 — absent file (isolated).** `readReflogLenient` on a ref with no reflog →
`toEqual([])`.

**RED 5 — reftable alias.** On a stack carrying a reflog for `refs/heads/main`,
`readReflogLenient` returns the same entries as `readReflog`, in the same oldest-first
order. Add the fully-tombstoned-log case too (`toEqual([])`), so the alias is proven over
the tombstone-shadowing path, not just the happy path.

**RED 6 — the dispatcher.** In `reflog-store.test.ts`, a new
`describe('readReflogLenient')` block mirroring the existing `readReflog` block:
absent file → `[]`; malformed line → survivors; over-cap → throws with the cap reason
(three isolated tests).

**GREEN** — implement in this order: files backend (extract `readReflogText`, add the
method, add it to the returned object) → reftable alias → dispatcher → barrel → the two
api-surface tests → `roots.ts` swap and import prune.

**RED 7 — the derived-Context path stays correct.** The existing linked-worktree retention
test (`maintenance.test.ts` L687, *"a commit reachable only from a linked worktree's own
HEAD reflog"*) already covers `addNonCurrentWorktreeRoots`. Re-run it; it must stay green
without modification. If it goes red, the derived Context is not being carried into
`getRefStore` — fix the call, never the test.

**REFACTOR** — the doc comment that justified the cap refusal now lives on the files
backend method; delete the stale prose from `roots.ts` rather than leaving an orphaned
paragraph. Confirm `addReflogRoots`'s two arms still read exactly as before.

Then regenerate `reports/api.json` (`npm run docs:json`) and stage it with the code.

### Gate

```
npx vitest run test/unit/application/primitives/ref-store.test.ts test/unit/application/primitives/reftable-ref-store.test.ts test/unit/application/primitives/reflog-store.test.ts test/unit/application/primitives/index.test.ts test/unit/api-surface/primitives-binding-surface.test.ts test/unit/application/commands/maintenance.test.ts test/unit/application/commands/fsck.test.ts \
  && npm run check:types \
  && ./node_modules/.bin/biome check src/application/primitives/ref-store.ts src/application/primitives/reftable-ref-store.ts src/application/primitives/reflog-store.ts src/application/primitives/index.ts src/application/commands/internal/fsck/roots.ts test/unit/application/primitives/ref-store.test.ts test/unit/application/primitives/reftable-ref-store.test.ts test/unit/application/primitives/reflog-store.test.ts test/unit/application/primitives/index.test.ts test/unit/api-surface/primitives-binding-surface.test.ts test/unit/application/commands/maintenance.test.ts
```

### Commit

```
fix(reflog): read reflogs leniently through a ref-store seam verb
```

---

## Part 3 — Every pinned reader goes lenient, and the interop suite is born

### Context

**Decision source.** ADR-739 (the lenient read replaces the strict one in
`commands/reflog.ts`, `commands/rev-parse.ts`, all three `stash-ref.ts` sites and
`snapshot-factory.ts`; `branch.ts` is ADR-740's, Part 6; fsck's arms are untouched).
Design §2(b), §3, and interop cases 1–4 + 10a.

**Nothing about these readers changes shape.** `runShow`'s newest-first mapping,
`runDelete`'s `length - 1 - index`, `runExpire`'s filter, `pickByIndex`'s
`entries[length - 1 - n]` and the stash selectors all keep operating on the surviving
array — which is exactly what git's `@{n}` numbering does (it counts only survivors).
Only the *read function* changes.

**Exact edits — swap `readReflog` for `readReflogLenient` (Part 2's dispatcher) at:**

| file | import line | call sites |
|---|---|---|
| `src/application/commands/reflog.ts` | L17 `import { listReflogs, readReflog } from '../primitives/reflog-store.js';` | L78 (`runShow`), L110 (`runDelete`), L163 (`runExpire`) |
| `src/application/commands/rev-parse.ts` | L22 `import { listReflogs, readReflog } from '../primitives/reflog-store.js';` | L86 (`resolveReflogBase`) |
| `src/application/primitives/stash-ref.ts` | L24 `import { readReflog } from './reflog-store.js';` | L44 (`readStashStack`), L54 (`resolveStashEntry`), L88 (`dropStashEntry`) |
| `src/application/primitives/snapshot/snapshot-factory.ts` | L17 `import { readReflog } from '../reflog-store.js';` | L169 (`stashEntry`) |

After the swap, `readReflog` may be an unused import in some of these files — prune it
(biome fails otherwise). `listReflogs` stays.

**Do NOT touch** `src/application/commands/internal/fsck/roots.ts` L207 (fsck's
non-strict arm keeps `readReflog`) or `src/application/commands/branch.ts`.

**New file: `test/integration/reflog-interop.test.ts`.** Header, matching
`test/integration/reflog-writers.test.ts` L1–11 exactly in shape:

```
/**
 * Integration — the reflog malformed-line parity matrix, driven against
 * canonical git. …
 *
 * @proves
 *   surface:        reflog
 *   bucket:         cross-tool-interop
 *   unique:         per-line reflog tolerance and rewrite bytes against canonical git
 *   interopSurface: reflog
 */
```

Claiming `interopSurface: reflog` a second time is safe — the audit's
`Coverage.coveredBy` is a list (`tooling/audit-write-surfaces/compute-gaps.ts`), so this
file and `reflog-writers.test.ts` aggregate rather than conflict.

**Interop harness facts (`test/integration/interop-helpers.ts`, 298 lines).**

- `GIT_AVAILABLE` (L149) — gate every describe with it.
- `git(dir, ...args)` (L200) and `runGit(args, { env })` (L91) already run with all
  `GIT_*` scrubbed, `HOME`/`XDG_CONFIG_HOME` pointed at a non-existent dir and
  `GIT_CONFIG_NOSYSTEM=1` (`buildSafeEnv`, L53–81).
- `tryRunGitWithExit(args)` (L257) → `{ stdout, stderr, exitCode }`, never throws — use it
  for git's `only has 3 entries` refusal and for the exit-0-with-empty-stderr assertions.
- `disableAutoMaintenance(dir)` (L221) — call it on the base repo.
- `makePeerPair` / `initBothRepos` are for two-repo transport tests; **not** needed here.
  Use `mkdtemp(path.join(os.tmpdir(), 'tsgit-reflog-interop-'))` directly.
- tsgit side: `createNodeContext({ workDir: dir })` from
  `src/adapters/node/node-adapter.js` (the shape every interop test uses, e.g.
  `bisect-midpoint-interop.test.ts` L99).

**Suite shape (design §Test strategy).** One shared `beforeAll` that builds the
four-commit base repo on `main` with real git, with an **explicit 60 s hook timeout**
(`beforeAll(async () => { … }, 60_000)`) — the 10 s default flakes under full-`validate`
concurrency. Per-case twins are copied from that base and corrupted identically on both
sides. Signing off per repo (`git -c commit.gpgsign=false …` or repo config);
`merge.conflictStyle` is irrelevant here and must **not** be pinned.

**Per-Context fanout-cache trap.** Every case writes objects/refs with real `git`
subprocesses *before* tsgit reads. Build the `Context` with `createNodeContext` **after**
those git writes, once per case — never reuse a Context created before the corruption was
applied.

**Cases this part lands** (rows are design §1a / §1b). Every case here is **read-only**:
`reflog delete` / `expire` / `stash drop` still write with the pre-change serializer and
the conditional guard until Parts 4–5, so **no case in this part may assert post-write
bytes**.

- **Case 1 — read parity, the ✅ rows.** For each agreeing class (rows 1–18) plus rows 23
  and 25 (closed by Part 1): `git reflog show main` vs tsgit
  `reflog(ctx, { action: 'show', ref: 'refs/heads/main' })` agree on the surviving
  entries — same set, same order, same `@{n}` numbering. Display parity is proven by
  **reconstructing** git's `<abbrev> <ref>@{n}: <message>` line from `ReflogShowEntry`
  fields; the library emits no rendered line.
- **Case 2 — the ❌ rows, asserted as live divergences.** Rows 19 (NUL in message: git
  truncates at the NUL, tsgit keeps it), 20 (no opening `<`: git keeps, tsgit rejects), 21
  (`>` in the name: git skips, tsgit keeps), 22 (no space after `>`: git skips, tsgit
  keeps), 24 (negative timestamp: git reads `18446744073709551611`, tsgit reads `-5`).
  Each asserts **both** sides' actual behaviour, so a future change to either surfaces.
  Do **not** fold these into case 1's sweep — a blind "every refusing class" loop would
  be red on exactly these five.
- **Case 3 — accepted-line parity.** Rows 16 (tab-less empty message — reachable through
  git's own `update-ref` with no `-m`), 17 (trailing blank line), 18 (CRLF, `\r` trailing
  the message) survive on both sides with identical fields.
- **Case 4 — numbering.** `git rev-parse main@{n}` vs tsgit `revParse('main@{n}')` for
  `n = 0..3` over the corrupted fixture, including the boundary: git refuses `main@{3}`
  with `fatal: log for 'main' only has 3 entries` and exit 128 (via `tryRunGitWithExit`),
  tsgit throws `REFLOG_ENTRY_OUT_OF_RANGE` (assert `.data` via `try`/`catch`).
  **Record in a test comment**, so a later reader does not "fix" this into a no-op:
  git's stderr `gap` / `only goes back to` warnings are rendering and are deliberately
  not matched; and the out-of-range *delete* no-op (Part 5) does not reach here —
  `rev-parse` refuses on both sides.
- **Case 10a — `stash list` parity.** A corrupted `.git/logs/refs/stash`: `git stash list`
  and tsgit's stash-stack read agree on the surviving entries. Only the *read* half here —
  `stash drop`'s rewrite bytes land in Part 4.

**Unit tests to add/extend alongside.**

- `test/unit/application/commands/reflog.test.ts` — `runShow` numbering over a corrupted
  log: seed the file raw (`ctx.fs.writeUtf8(`${ctx.layout.gitDir}/logs/HEAD`, …)`) with a
  garbage line mid-file and assert the `@{n}` selectors and entries of the survivors.
  Existing helpers at the top of that file: `entry(overrides)` (L33), `identityAt(ts)`
  (L26), `writeCommit(ctx, parents, ts)` (L41), `seedRepo` from `./fixtures.js`,
  `HEAD`/`BRANCH`/`OID_X`/`OID_Y`/`OID_Z`.
- `test/unit/application/commands/rev-parse.test.ts` — `HEAD@{1}` resolves across a
  malformed line, counting survivors.
- `test/unit/application/primitives/stash-ref.test.ts` — `readStashStack` /
  `resolveStashEntry` skip a malformed line; the selector indices count survivors.
- `test/unit/application/primitives/snapshot/snapshot-factory.test.ts` (and
  `stash-snapshot.test.ts` if it drives `stashEntry`) — `stashEntry` indexes the surviving
  array.

### TDD steps

**RED 1** — unit: `reflog show` over a corrupted log returns the survivors with
`@{0..n-1}` selectors. Fails today (`INVALID_REFLOG_ENTRY`).

**RED 2** — unit: `rev-parse HEAD@{1}` over a corrupted log resolves to the second-newest
**surviving** entry's `newId`. Fails today.

**RED 3** — unit: `readStashStack` over a corrupted `refs/stash` log lists the survivors
with contiguous `stash@{i}` selectors; `resolveStashEntry(ctx, 1)` returns the matching
`newId`. Fails today.

**RED 4** — unit: `stashEntry` at index 1 over a corrupted log resolves the surviving W
commit. Fails today.

**GREEN 1** — swap the eight call sites, prune unused imports.

**RED 5** — create `test/integration/reflog-interop.test.ts` with the header, the shared
`beforeAll` base repo (60 s timeout), the per-case twin helper, and cases 1, 2, 3, 4, 10a.
Run it: cases 1/3/4/10a fail before GREEN 1 and pass after; case 2's divergence assertions
must be written against the **measured** behaviour on both sides and pass immediately —
if a divergence row passes trivially, the assertion is not pinning anything, so assert the
concrete field values (message bytes for row 19, the parsed timestamp value for row 24,
the survivor count and identities for 20–22).

**REFACTOR** — factor the twin-repo setup and the "corrupt line N of the log" mutation into
two small local helpers so each case reads as arrange/act/assert. Keep the reconstruction
of git's `reflog show` line in one local function used by every parity case.

### Gate

```
npx vitest run test/unit/application/commands/reflog.test.ts test/unit/application/commands/rev-parse.test.ts test/unit/application/primitives/stash-ref.test.ts test/unit/application/primitives/snapshot test/unit/application/commands/stash.test.ts test/integration/reflog-interop.test.ts test/integration/reflog-writers.test.ts \
  && npm run check:types \
  && ./node_modules/.bin/biome check src/application/commands/reflog.ts src/application/commands/rev-parse.ts src/application/primitives/stash-ref.ts src/application/primitives/snapshot/snapshot-factory.ts test/integration/reflog-interop.test.ts test/unit/application/commands/reflog.test.ts test/unit/application/commands/rev-parse.test.ts test/unit/application/primitives/stash-ref.test.ts
```

### Commit

```
fix(reflog): read every pinned reflog consumer leniently
```

---

## Part 4 — The rewrite contract: unconditional expire, always-TAB serializer, atomic replace

### Context

**Decision source.** ADR-743 (`runExpire` rewrites unconditionally; the implementation
must first confirm the reflog replace write is atomic) and ADR-745 (`applyReflogReplace`
uses a rewrite-specific serialization that always emits the message TAB;
`serializeReflogLine`'s append rule untouched). Design §1d, §2(c), §2(g), interop cases 5,
7, 8, 9, 10b.

**Why the guard must go.** `runExpire` (`src/application/commands/reflog.ts` L146–176)
writes only when `survivors.length !== stored.length` (L169) — two *parsed* counts. After
Part 3, a file whose only defect is a malformed line yields equal counts and **no write**,
so the corruption stays on disk where git purges it (measured: `--expire=never` expires
nothing and still rewrites, 4 lines → 3). A clean rewrite is byte-identical in content, so
the extra write is unobservable in content — only inode/mtime move.

**The two git writers, two rules (§1d, measured).** git's append writer
(`log_ref_write_fd`) omits the TAB for an empty message; git's expire/delete **rewrite**
writer always emits it — the same tab-less entry gains a trailing TAB after
`reflog expire --expire=never`. `serializeReflogLine` implements the append rule and is
pinned by `test/integration/reflog-writers.test.ts`; do not change it.

**Atomicity confirmation (ADR-743's precondition — the answer is "no, it is not").**
`applyReflogReplace` (`src/application/primitives/ref-store.ts` L600–608) currently does a
bare `ctx.fs.writeUtf8`. git locks and renames. The shared helper already exists:
`atomicWriteFile(ctx, path, content: Uint8Array, onLocked: (lockPath) => TsgitError)` in
`src/application/primitives/atomic-write.ts` — it `writeExclusive`s `<path>.lock`
(`lockSuffix` from `path-layout.ts` L116 = `'.lock'`), renames it onto `path`, and cleans
the lock up on failure. `refLocked(name)` (`src/domain/refs/error.ts` L78) is the right
refusal factory: the reflog rewrite is a ref-scoped lock. `TEXT_ENCODER` already exists at
`ref-store.ts` L44.
The lock path (`logs/<ref>.lock`) never collides with the ref lock (`refs/heads/<x>.lock`)
that `applySet` takes in the same `applyRefUpdates` batch — checked against
`stash-ref.ts` L108–111 and `reflog.ts` L124–126.

**Files to change.**

1. `src/domain/reflog/reflog-format.ts` — add, next to `serializeReflogLine`:

   ```ts
   /**
    * Serialize one entry as git's expire/delete REWRITE writer does. Identical
    * to the append form except the message TAB is always emitted, even for an
    * empty message — measured against git 2.55.0, where a tab-less entry gains
    * a trailing TAB after `reflog expire --expire=never`. Two git writers, two
    * rules; the append writer's own rule stays in `serializeReflogLine`.
    */
   export function serializeReflogRewriteLine(entry: ReflogEntry, hexLength: 40 | 64): string
   ```

   Share the guards and the meta construction with `serializeReflogLine` (extract a
   private `reflogLineMeta(entry, hexLength)` that runs the three refusals and returns
   `` `${oldId} ${newId} ${identity}` ``) so the "two paths must stay in sync for every
   other field" cost is structural, not a copy. **Internal export, not barrelled**: it is
   consumed only by `ref-store.ts`, which already imports directly from
   `'../../domain/reflog/reflog-format.js'` (L8) — do **not** add it to
   `src/domain/reflog/index.ts`, and therefore `reports/api.json` does not move for it.
   It must land in this part, not earlier: an export with no consumer trips knip
   (`check:dead-code`).
2. `src/application/primitives/ref-store.ts` — `applyReflogReplace` (L600–608): map through
   `serializeReflogRewriteLine`, and write through
   `atomicWriteFile(ctx, reflogPath(refDir(update.name), update.name), TEXT_ENCODER.encode(text), () => refLocked(update.name))`.
   Two imports must be **widened**, not added as new lines: L26
   `import { atomicWriteRef } from './atomic-write.js'` gains `atomicWriteFile`, and the
   L9–14 `'../../domain/refs/error.js'` block (currently `type ReftableCheck`,
   `refChainTooDeep`, `refNotFound`, `refUpdateConflict`) gains `refLocked`.
3. `src/application/commands/reflog.ts` — `runExpire`: delete the
   `if (survivors.length !== stored.length)` guard (L169) so `applyRefUpdates` runs once
   per target per run (one per reflog under `--all`). `removed`/`kept` accounting is
   unchanged.

**Test files and the exact tests that must be inverted.**

- `test/unit/application/commands/reflog.test.ts` L987–1026,
  `describe('Given no entry is stale enough to prune')` >
  `it('Then the reflog file is not rewritten')` — **invert it**. Note its spy is on
  `ctx.fs.writeUtf8`, which no longer sees the write once the replace goes through
  `atomicWriteFile`. Rewrite the observation as a spy on **`ctx.fs.rename`** asserting the
  destination `${ctx.layout.gitDir}/logs/HEAD` was renamed onto (the lock-then-rename pair
  is the proof the write happened). Keep the result assertion
  `{ kind: 'expire', removed: 0, kept: 2 }` and the surviving-entry assertion.
- Add the stronger, spy-free observation for the purge: seed a **raw corrupted** reflog
  file with `ctx.fs.writeUtf8`, run `reflog(ctx, { action: 'expire', ref: 'HEAD', expire: 'never' })`,
  then read the raw file text back and assert the malformed line is **gone** and the valid
  lines remain. This is the assertion that kills a mutant reinstating the conditional
  write, and it needs no spy.
- `test/unit/domain/reflog/reflog-format.test.ts` — new `describe('serializeReflogRewriteLine')`:
  an empty message produces `…+0000\t\n` (trailing TAB before the LF); a non-empty message
  produces bytes identical to `serializeReflogLine`; the three refusals (line break in the
  message, oid width, zero timestamp) still fire with their reasons.
- `test/unit/domain/reflog/reflog-format.properties.test.ts` — append the ADR-745 half of
  lens 1: the rewrite serializer's output round-trips through the same strict `parseReflog`
  (`parseReflog(entries.map(e => serializeReflogRewriteLine(e, 40)).join(''), 40)` ≡
  `entries`), reusing the existing non-zero-timestamp arbitrary. `numRuns: 200`.
- `test/unit/application/primitives/ref-store.test.ts` — atomicity: with
  `${gitDir}/logs/HEAD.lock` already present, an `applyRefUpdates([{ kind: 'reflogReplace', … }])`
  refuses with `REF_LOCKED` (assert `.data` via `try`/`catch`); without the lock, the
  bytes land and no `.lock` file remains.
- `test/unit/application/commands/stash.test.ts` / `stash-ref.test.ts` — `dropStashEntry`
  routes through the same `reflogReplace`; re-run and adjust any byte expectation that
  assumed the append serializer.
- `test/integration/reflog-writers.test.ts` — the **append** bytes it pins must stay
  byte-identical. If it goes red, the change leaked into `serializeReflogLine`.

**Interop cases to add to `test/integration/reflog-interop.test.ts`:**

- **Case 5 — `delete` rewrite.** `git reflog delete main@{1}` vs tsgit
  `reflog({ action: 'delete', ref: 'refs/heads/main', index: 1 })` on identical corrupted
  twins; compare the resulting `.git/logs/refs/heads/main` **bytes**. This proves both the
  surviving set and the §1d re-serialization, always-TAB included. Add the `--rewrite`
  variant (chain repair across survivors). Use an **in-range** index only — the
  out-of-range no-op is Part 5's case 6 and still throws at this commit.
- **Case 7 — `expire` rewrite.** `--expire=never` (nothing expires, file still purged
  4 → 3), `--expire=90.days.ago` (same), `--expire=now` (file truncated to **0 bytes**,
  file still present). Byte comparison each time. This is the case ADR-743 exists for.
- **Case 8 — degenerate files (§1c).** Every-line-corrupt, 0-byte, absent-file,
  absent-ref: assert both the returned data and the refusal/exit shape. Record in-test the
  two rows where tsgit deliberately differs — `expire` on an absent reflog (git
  `error: reflog could not be found`, exit 255; tsgit treats it as empty) and
  `reflog show` on a name with no ref at all (git `fatal: ambiguous argument`, exit 128;
  tsgit returns an empty result). Both are pre-existing, out of scope, and asserted as
  divergences rather than skipped.
- **Case 9 — `--all`.** `git reflog expire --expire=never --all` vs tsgit's, asserting the
  same purge is applied to `.git/logs/HEAD`.
- **Case 10b — `stash drop` bytes.** `git stash drop stash@{1}` vs tsgit's on a corrupted
  `refs/stash` log: the entry is dropped, the chain repaired, the malformed line purged,
  and the two files compared byte for byte. git's six repeated stderr gap warnings are
  rendering and are **not** matched — say so in a test comment.

### TDD steps

**RED 1** — domain: `serializeReflogRewriteLine` with an empty message emits the trailing
TAB. Fails: the function does not exist.

**RED 2** — domain: `serializeReflogRewriteLine` with a non-empty message is byte-identical
to `serializeReflogLine`. Isolated from RED 1.

**RED 3** — domain: each of the three refusals fires from the rewrite serializer too
(three isolated tests asserting `.data` reasons).

**GREEN 1** — extract `reflogLineMeta`, add `serializeReflogRewriteLine`.

**RED 4** — `ref-store.test.ts`: `reflogReplace` refuses with `REF_LOCKED` when
`logs/HEAD.lock` exists. Fails today (a bare `writeUtf8` ignores the lock).

**RED 5** — `ref-store.test.ts`: after a `reflogReplace` of an entry with an **empty
message**, the on-disk bytes end with `\t\n`. Fails today (append rule, no TAB).

**GREEN 2** — route `applyReflogReplace` through `serializeReflogRewriteLine` +
`atomicWriteFile`.

**RED 6** — `reflog.test.ts`: expire with `expire: 'never'` on a raw corrupted log purges
the malformed line from disk. Fails today (equal parsed counts → no write).

**RED 7** — `reflog.test.ts`: the inverted "nothing expires" test — the reflog file **is**
rewritten (rename spy) and the entries are unchanged.

**GREEN 3** — delete the `survivors.length !== stored.length` guard.

**RED 8** — append interop cases 5, 7, 8, 9, 10b. Each byte comparison is written against
the twin repos; run once before GREEN 2/3 to confirm they are red for the right reason.

**REFACTOR** — check `runExpire` still reads as one loop with no leftover count-comparison
dead code, and that the doc comment on `applyReflogReplace` now says *why* it locks (git
locks and renames; the rewrite runs on every expire, so a torn write would be routine).

### Gate

```
npx vitest run test/unit/domain/reflog test/unit/application/primitives/ref-store.test.ts test/unit/application/primitives/stash-ref.test.ts test/unit/application/commands/reflog.test.ts test/unit/application/commands/stash.test.ts test/unit/application/commands/branch.test.ts test/integration/reflog-interop.test.ts test/integration/reflog-writers.test.ts test/parity \
  && npm run check:types \
  && ./node_modules/.bin/biome check src/domain/reflog/reflog-format.ts src/application/primitives/ref-store.ts src/application/commands/reflog.ts test/unit/domain/reflog/reflog-format.test.ts test/unit/domain/reflog/reflog-format.properties.test.ts test/unit/application/primitives/ref-store.test.ts test/unit/application/commands/reflog.test.ts test/integration/reflog-interop.test.ts
```

### Commit

```
fix(reflog): rewrite reflogs unconditionally with git's rewrite serializer
```

---

## Part 5 — Out-of-range `reflog delete` is a silent no-op

### Context

**Decision source.** ADR-744 — **the one decision ratified against the design's own
recommendation**. `git reflog delete main@{99}` exits 0 silently; on a corrupt file it
still rewrites and purges the malformed lines, on a clean file it leaves the content
unchanged. tsgit throws `REFLOG_ENTRY_OUT_OF_RANGE`. The user ruled for faithfulness.
Design §2(d), §4, interop case 6. ADR-746 forbids any skipped-line counter — writing
unconditionally is precisely what removes the need for one.

**Current code — `src/application/commands/reflog.ts` L104–128 (`runDelete`).**

```ts
const ref = resolveUserRef(opts.ref);
if (!(await hasReflog(ctx, ref))) throw reflogNotFound(ref);          // L109 — UNCHANGED
const stored = await readReflogLenient(ctx, ref);                      // L110 (lenient since Part 3)
if (!Number.isInteger(opts.index) || opts.index < 0) {                 // L113 — throw site 1, REMOVE
  throw reflogEntryOutOfRange(ref, opts.index, stored.length);
}
const target = stored.length - 1 - opts.index;
if (target < 0) {                                                      // L119 — throw site 2, REMOVE
  throw reflogEntryOutOfRange(ref, opts.index, stored.length);
}
const removed = stored[target] as ReflogEntry;
const survivors = repairChain(stored, target, opts.rewrite === true);
await getRefStore(ctx).applyRefUpdates([{ kind: 'reflogReplace', name: ref, entries: survivors }]);
return { kind: 'delete', removed };
```

**Target shape.** Both guards stop throwing and instead select "nothing to remove". The
`reflogReplace` write happens on **every** call — with the survivors when an entry was
dropped, with the full surviving set when it was not. So a corrupt file is purged either
way and a clean file comes back content-identical.

```ts
/**
 * The file-order position `index` names, counting newest-first — or undefined
 * when it names no entry at all. git's own out-of-range delete is a silent
 * no-op, so this is a selection, not a refusal. Three independent ways to
 * miss: a non-integer index, a negative one, and one past the oldest entry.
 */
const selectTarget = (length: number, index: number): number | undefined => {
  if (!Number.isInteger(index) || index < 0) return undefined;
  const position = length - 1 - index;
  return position < 0 ? undefined : position;
};
```

```ts
const target = selectTarget(stored.length, opts.index);
const survivors = target === undefined ? stored : repairChain(stored, target, opts.rewrite === true);
await getRefStore(ctx).applyRefUpdates([{ kind: 'reflogReplace', name: ref, entries: survivors }]);
if (target === undefined) return { kind: 'delete' };
return { kind: 'delete', removed: stored[target] as ReflogEntry };
```

Return the two arms as **two literals**, not one literal with a conditional spread — the
absent-`removed` case must genuinely omit the key, and a conditional spread is exactly
the mutant class where `toEqual` on the result is blind (see the write assertions below).
`selectTarget` keeps the three miss conditions *separately reachable* so the per-guard
unit tests can each fail alone.

**Published type change.** `ReflogResult`'s `delete` arm (L48–56):
`| { readonly kind: 'delete'; readonly removed?: ReflogEntry }`. Document on the field that
an absent `removed` means the index named no entry — git's own silent no-op — and that the
reflog is still rewritten. `ReflogResult` appears **nine times** in `reports/api.json`, so
this part **must** regenerate it (`npm run docs:json`) and commit it. `check:doc-typedoc`
catches staleness at **prepush**, not at `validate`.

**Import prune.** `reflogEntryOutOfRange` (L11) becomes unused in `reflog.ts` — remove it
from that import. The factory and the `REFLOG_ENTRY_OUT_OF_RANGE` code **stay live and
exported** in `src/domain/reflog/error.ts` L20–24: `rev-parse`'s `pickByIndex`
(`rev-parse.ts` L153) is still its caller, and git refuses there too
(`fatal: log for 'main' only has 3 entries`, exit 128). **This is not a dead-code
removal** — do not delete the factory, the union member, or its tests.

**`reflogNotFound` is untouched** (L109, via `hasReflog`): git errors on a missing reflog
too (`error: reflog could not be found`, exit 255). ADR-744 narrows the no-op to the
*index* only.

**Existing tests that must be converted** — all in
`test/unit/application/commands/reflog.test.ts`, inside `describe('delete')` (L215):

| lines | current title | becomes |
|---|---|---|
| L405–431 | index past the last entry → throws with requested/available | resolves with `removed` absent |
| L433–458 | negative index → throws | resolves with `removed` absent |
| L459–484 | empty reflog file, index 0 → throws | resolves with `removed` absent |
| L486–513 | NaN index → throws | resolves with `removed` absent |
| L515–541 | fractional index 1.5 → throws | resolves with `removed` absent |

Keep them as **five isolated tests** — one per guard the old code had, so removing one
guard cannot be covered by another. The `REFLOG_NOT_FOUND` test just above them (ending
L403) stays untouched.

**The two non-overlapping assertions ADR-744 needs** (the throw used to prove both at
once):

1. *The result* — each of the five resolves, does not throw, and its `removed` is absent.
   Narrow first (`if (result.kind !== 'delete') expect.fail('expected a delete result');`),
   then assert **key presence**: `expect('removed' in result).toBe(false)`. Not `toEqual`
   — a mutant that writes `removed: undefined` is invisible to it.
2. *The write* — on a **corrupted** log an out-of-range delete still rewrites: seed the raw
   file with a garbage line, run the delete, read the raw bytes back and assert the
   garbage line is gone and the valid lines remain. On a **clean** log, spy `ctx.fs.rename`
   and assert `${gitDir}/logs/HEAD` was renamed onto while the content is unchanged. The
   returned result is identical whether or not the write happened, so this is the **only**
   observation that kills a mutant deleting the write.

**Interop case 6** — a parity case, not a divergence case:

- *corrupt fixture*: `git reflog delete main@{3}` and `main@{99}` exit **0** with empty
  stderr and leave a file purged of the malformed line (via `tryRunGitWithExit`); tsgit's
  `reflog({ action: 'delete', ref: 'refs/heads/main', index: 3 })` **resolves** — no throw
  — with `removed` absent, and leaves the same bytes. Assert the exit code, the empty
  stderr, the resolved result shape, and a byte comparison of the two files.
- *clean fixture*: `main@{4}`, `main@{99}` and a negative index exit 0 on both sides and
  leave the file **content-identical** to its pre-command bytes. Compare **content**, not
  `stat` — git's own clean rewrite changes the inode (measured), so an mtime/inode
  assertion would pin noise.
- This case is the only interop assertion that catches a regression back to the typed
  throw. An "it did not throw" assertion alone would survive a mutant returning the wrong
  result or skipping the write, so assert the shape *and* the bytes.

### TDD steps

**RED 1–5** — convert the five throw tests one at a time, each asserting: the call
resolves; `result.kind === 'delete'`; `expect('removed' in result).toBe(false)`. Each fails
today with `REFLOG_ENTRY_OUT_OF_RANGE`.

**RED 6** — the corrupt-log purge: raw-seed `logs/HEAD` with a garbage line among valid
ones, `reflog({ action: 'delete', ref: 'HEAD', index: 99 })`, then read the raw file and
assert the garbage line is gone. Fails today (throws before any write).

**RED 7** — the clean-log write: `ctx.fs.rename` spy shows `logs/HEAD` was rewritten, and a
subsequent `show` returns the identical entry list. Fails today.

**RED 8** — the in-range path is unchanged: re-run the existing `delete index 1` /
`index 0` / `rewrite=true` tests. They must stay green with `removed` **present**; add one
assertion that `'removed' in result` is `true` there, so the optional field is proven in
both directions.

**GREEN** — rewrite `runDelete` to the target shape; widen `ReflogResult`'s `delete` arm;
prune the `reflogEntryOutOfRange` import.

**RED 9** — append interop case 6 (both fixtures) to
`test/integration/reflog-interop.test.ts`.

**REFACTOR** — keep `runDelete` under 20 lines with early returns and no nesting past one
level; if the range computation needs a name, extract a pure
`selectTarget(stored.length, index): number | undefined` helper so each guard stays
individually reachable. Re-run `test/unit/application/commands/rev-parse.test.ts` to
confirm `REFLOG_ENTRY_OUT_OF_RANGE` is still raised there.

Then regenerate `reports/api.json` (`npm run docs:json`) and stage it with the code.

### Gate

```
npx vitest run test/unit/application/commands/reflog.test.ts test/unit/application/commands/rev-parse.test.ts test/unit/application/primitives/index.test.ts test/unit/repository test/integration/reflog-interop.test.ts \
  && npm run check:types \
  && ./node_modules/.bin/biome check src/application/commands/reflog.ts test/unit/application/commands/reflog.test.ts test/integration/reflog-interop.test.ts
```

### Commit

```
fix(reflog): make an out-of-range reflog delete a silent no-op
```

---

## Part 6 — `branch -m` moves the reflog through a `moveReflog` verb

### Context

**Decision source.** ADR-740 — `git branch -m` moves the reflog file byte-for-byte
(measured: a malformed line survives verbatim under the new name, then the rename entry is
appended, 4 lines → 5). tsgit's `branchRename` does read → concatenate → re-serialize, so
**no parse tolerance reproduces git**: a strict read refuses a rename git performs, and a
lenient read silently drops a line git preserves. That is why `branch.ts` is absent from
Part 3's list — it *loses* its read rather than converting it. Design §2(e), §3 (last
row), interop case 10c.

**Current code — `src/application/commands/branch.ts` L157–202 (`branchRename`).**

```ts
const id = await resolveRef(ctx, from);
const reflogMessage = branchRenamed(from, to);
const movedLog = await readReflog(ctx, from);                             // L167 — REMOVE
const store = getRefStore(ctx);
try {
  await store.applyRefUpdates([{ kind: 'set', name: to, id,
    ...(input.force === true ? {} : { expected: 'absent' as const }),
    reflog: { oldId: id, newId: id, message: reflogMessage } }]);         // L173–181
} catch (err) { /* REF_UPDATE_CONFLICT → branchExists(to) */ }
if (movedLog.length > 0) {
  await store.applyRefUpdates([{ kind: 'reflogReplace', name: to,
    entries: [...movedLog, ...(await readReflog(ctx, to))] }]);           // L190–194 — REMOVE
}
await updateRef(ctx, from, zeroOid(ctx.hashConfig), { delete: true });    // L196
// HEAD re-point when HEAD was symbolic to `from`
```

**Target sequence — and why this order.**

1. `applyRefUpdates([{ kind: 'set', name: to, id, ...(force ? {} : { expected: 'absent' }) }])`
   — **without** the `reflog` field. This keeps the CAS conflict detection first, so the
   existing `branchExists` behaviour and its mutant-killing test
   (`branch.test.ts` L482+, *"kills `force === true ? {} : { expected: 'absent' }` mutants"*)
   are untouched.
2. `await store.moveReflog(from, to)` — `to`'s reflog becomes `from`'s prior reflog
   byte-for-byte (or is removed when `from` had none), and `from` has no reflog left.
3. `applyRefUpdates([{ kind: 'reflogOnly', name: to, reflog: { oldId: id, newId: id, message: reflogMessage } }])`
   — appends the rename entry through the ordinary append serializer, exactly as before.
   The rename entry notes the rename without moving the value, so old/new are both the
   resolved tip.
4. `updateRef(ctx, from, zeroOid(ctx.hashConfig), { delete: true })` — unchanged; its
   reflog tombstone is now a no-op because step 2 already moved the file.

Steps 2+3 reproduce git's own order (`rename(2)` the log, then log the rename), and the
loggability gate lands in the right place for free: `recordRefUpdate.isLoggable`
(`src/application/primitives/record-ref-update.ts` L49–53) returns true when the reflog
**file already exists**, else falls back to `shouldAutocreateReflog`. So after step 2 a
moved log always accepts the append, and a `from` with no log under
`core.logallrefupdates=false` still yields **no** reflog for `to` — which is exactly what
`branch.test.ts` L271–296 pins.

**New seam verb — public-surface decision: `moveReflog` is INTERNAL to the seam.**
It is a `RefStore` interface method with **no** `reflog-store.ts` dispatcher (`branch.ts`
already holds the store via `getRefStore(ctx)`) and **no** barrel export. `RefStore` does
not appear in `reports/api.json` (verified: zero occurrences), so this part does **not**
move the published surface. Still run `npm run docs:json` at the end and commit the file
only if it actually changed.

**Contract to write into the interface doc comment:** after `moveReflog(from, to)`, `to`'s
reflog is exactly what `from`'s was — byte-for-byte on the files backend, so a malformed
line survives verbatim — and `from` has no reflog. When `from` had none, `to`'s existing
reflog is **removed** (git's rename deletes the destination ref and its log first). This
last clause is a deliberate behaviour change on a forced rename: the current
read-concat-rewrite *appends* `to`'s prior history, which git does not do.

**Implementations.**

- Files (`src/application/primitives/ref-store.ts`, inside `createFilesRefStore`, next to
  `removeReflogFile` L592–598 and `applyReflogReplace`):

  ```ts
  async function moveReflog(from: RefName, to: RefName): Promise<void> {
    const src = reflogPath(refDir(from), from);
    if (!(await ctx.fs.exists(src))) {
      await removeReflogFile(to);
      return;
    }
    await ctx.fs.rename(src, reflogPath(refDir(to), to));
  }
  ```

  `ctx.fs.rename` creates the destination's parent directories and overwrites an existing
  destination on both the node adapter (`node-file-system.ts` `rename`, which `mkdir`s
  `dirname(realDst)` recursively before `fsOps.rename`) and the memory adapter
  (`memory-file-system.ts` L246–275, which `ensureParentDirs(dst)` and deletes the
  destination before re-keying). Browser/OPFS emulates rename as read+write+rm — still
  byte-preserving. Add `moveReflog` to the returned object literal (L806–816).
- Reftable (`src/application/primitives/reftable-ref-store.ts`): there is no file to
  rename, so re-key the log records through the existing transaction machinery —

  ```ts
  async function moveReflog(from: RefName, to: RefName): Promise<void> {
    const entries = await readReflog(from);
    await applyReftableUpdates(ctx, [
      { kind: 'reflogReplace', name: to, entries },
      { kind: 'reflogReplace', name: from, entries: [] },
    ]);
  }
  ```

  `applyReflogReplaceRecords` (`reftable-transaction.ts` L516–536) already tombstones every
  existing record for the name and re-emits `entries` oldest→newest at fresh indices; an
  empty `entries` is therefore a pure tombstone. Log records are structured, so re-emitting
  the decoded entries *is* the byte-preserving move for this backend — there is no
  malformed-line analogue to lose. One extra table per rename (two transactions instead of
  one, since the rename entry appends separately) is an internal storage detail; the
  stack's own compaction handles it. Add it to the returned object (L357–367).

**Test files.**

- `test/unit/application/primitives/ref-store.test.ts` — files backend `moveReflog`.
- `test/unit/application/primitives/reftable-ref-store.test.ts` — reftable `moveReflog`.
  Fixtures: `withReftableStorage`, `writeReftableFiles`, `commonReftableDir` from
  `test/unit/application/primitives/reftable-fixtures.ts`.
- `test/unit/application/commands/branch.test.ts` — the rename describes at L196
  (*"the new ref reflog is [...source-history, rename-entry] and the source reflog is gone"*),
  L218 (*"the rename entry carries the current tip as both oldId and newId"*), L240
  (reftable-backed rename), L271 (*"the renamed branch gets no empty reflog file"* — must
  stay green **unmodified**), L300 (HEAD unchanged), L482 (the force/CAS mutant killer).
  A `--force` rename onto a branch that already has a reflog now **replaces** rather than
  concatenates — find or add that case and pin the new, git-faithful expectation.
- `test/integration/reflog-writers.test.ts` L110–130 — the `branchRename` case asserting
  `[history…, rename entry]` on the target and `[]` on the source. It must stay green:
  the move produces the same result for a clean log.

**Interop case 10c** — `git branch -m main renamed` vs tsgit's `branchRename` on identical
corrupted twins: the malformed line survives **byte-for-byte** under the new name on both
sides, the appended rename entry matches, and `.git/logs/refs/heads/main` is gone. This
byte assertion is what distinguishes a real move from a lenient parse-and-rewrite, which
would drop that line.

### TDD steps

**RED 1** — files backend: `moveReflog` moves a reflog containing a **malformed line**
verbatim. Arrange by writing the raw file with `ctx.fs.writeUtf8` (two valid lines plus a
garbage line), act, then assert the destination's raw text is **string-identical** to the
source's original text and the source path no longer exists. Fails: the method does not
exist.

**RED 2** — files backend, isolated: when `from` has **no** reflog but `to` does, `to`'s
reflog is removed. This is the guard's own test, separate from RED 1.

**RED 3** — reftable backend: `moveReflog` re-keys the records — `readReflog(to)` returns
`from`'s entries in the same oldest-first order, and `readReflog(from)` returns `[]`.

**GREEN 1** — add the interface method, both implementations, and both returned objects.

**RED 4** — `branch.test.ts`: renaming a branch whose reflog contains a malformed line
succeeds, and the target's reflog file still contains that line verbatim followed by the
rename entry. Fails today: `readReflog` at L167 throws (or, after a naive lenient swap,
silently drops the line).

**RED 5** — `branch.test.ts`: a `--force` rename onto an existing branch with its own
reflog leaves the target's reflog equal to the **source's**, not a concatenation. Pins the
deliberate behaviour change.

**GREEN 2** — rewrite `branchRename` to the four-step sequence. `branch.ts` L17
(`import { readReflog } from '../primitives/reflog-store.js';`) becomes its only reader —
delete the whole import line once both reads are gone, or biome fails.

**RED 6** — append interop case 10c.

**REFACTOR** — `branchRename` stays under 20 lines: keep the `try`/`catch` around step 1
only (it is the `REF_UPDATE_CONFLICT` → `branchExists` translation) and let steps 2–4 run
straight-line. Document on the function *why* the ref write precedes the log move (the CAS
is the conflict detector; git checks and refuses before touching anything, and the window
between them is the same race git has).

Run `npm run docs:json`; commit `reports/api.json` only if it changed.

### Gate

```
npx vitest run test/unit/application/primitives/ref-store.test.ts test/unit/application/primitives/reftable-ref-store.test.ts test/unit/application/primitives/reftable-transaction.test.ts test/unit/application/commands/branch.test.ts test/integration/reflog-writers.test.ts test/integration/reflog-interop.test.ts test/integration/reftable-ref-storage-interop.test.ts \
  && npm run check:types \
  && ./node_modules/.bin/biome check src/application/primitives/ref-store.ts src/application/primitives/reftable-ref-store.ts src/application/commands/branch.ts test/unit/application/primitives/ref-store.test.ts test/unit/application/primitives/reftable-ref-store.test.ts test/unit/application/commands/branch.test.ts test/integration/reflog-interop.test.ts
```

### Commit

```
fix(branch): move the reflog on rename instead of re-serializing it
```

---

## Phase gate

After Part 6, the whole change must pass `npm run validate`. Watch specifically:

- `check:doc-typedoc` runs at **prepush**, not in `validate` — confirm `reports/api.json`
  is committed and `git diff --exit-code -- reports/api.json` is clean after a fresh
  `npm run docs:json`.
- `check:write-surfaces` — `test/integration/reflog-interop.test.ts` must carry the
  `@proves` header with `bucket: cross-tool-interop` and `interopSurface: reflog`.
- `check:test-pyramid` — one new integration file against percentage-based budgets in
  `test-pyramid-budgets.json`; no budget edit expected.
- `check:spelling` — the cspell dictionary misses some British `-ising`/`-ised` forms; the
  commit hook can pass where full `validate` fails.
- `docs/use/commands/reflog.md` exists and describes the `delete` result. The **docs
  phase** owns updating it for the absent-`removed` no-op; no part edits it.

Mutation (the mutation phase, scoped per `.claude/workflow/mutation.md`) covers
`src/domain/reflog/`, `src/application/primitives/ref-store.ts`, `reflog-store.ts`,
`stash-ref.ts`, `src/application/commands/reflog.ts`, `rev-parse.ts` and `branch.ts`.
Known hot spots, all already answered by the tests above: the re-proved `parseReflogLenient`
empty-line directive (Part 1); boundary mutants on `length - 1 - index` in `runDelete`,
`pickByIndex` and the stash selectors; the deleted expire guard, killed only by the
`--expire=never` byte comparison; and `runDelete`'s removed write, killed only by the
corrupt-log purge assertion and the rename spy.
