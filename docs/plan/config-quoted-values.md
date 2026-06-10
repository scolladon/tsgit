# Plan — git-config quoted-value (un)escaping

Implements `design/config-quoted-values.md` (ADRs 308–309). Four TDD slices, one atomic commit each. Sequencing: reader before writer so the existing write→parse round-trip property stays green at every commit (the old writer's output is valid input for the new parser).

## Slice 1 — reader: faithful value grammar + `CONFIG_PARSE_ERROR`

Commit: `feat(config): git-faithful quoted-value parsing with CONFIG_PARSE_ERROR refusal`

**Red** — `test/unit/application/primitives/config-read.test.ts`, new GWT blocks driving `parseIniSections` (and `readConfig` for cache/rejection behaviour):

1. Quoting: `"a b"` → `a b`; toggling `a" b "c` → `a b c`; `""` → empty; `#`/`;` literal inside quotes; quoted trailing space survives (`"a "` → `a `).
2. Escapes in and out of quotes: `\n` → LF, `\t` → TAB, `\b` → BS, `\"` → `"`, `\\` → `\`.
3. Whitespace: leading skipped; interior runs preserved verbatim (`a   b`); trailing trimmed; CRLF line ending trimmed (`ab<CR><LF>` → `ab`); quoted CR preserved; interior CR preserved; VT/FF never skipped/trimmed (`<VT>a`, `a<VT>`, `a<FF>` verbatim).
4. Trim-latch resets: `a ""` → `a ` (quote toggle); `a \t` → `a <TAB>` (escape append).
5. Continuations: `a\<LF>   b` → `a   b` (continuation leading ws preserved); `a\\<LF>` → `a\` (escaped backslash ≠ continuation); `"a\<LF>b"` → `ab` (inside quotes); `a\` on the final line → `a` (EOF fakes EOL, no error); a section header after a continued value still parses (nextLine bookkeeping).
6. Comments: `a # c` → `a`; comment before `=` swallows the line (`# x = y`, `ab#cd = x` produce no entry — today's leniency preserved).
7. Refusal (try/catch, assert `.data.code === 'CONFIG_PARSE_ERROR'`, `.data.line`, `.data.source`): unknown escape `a\x` (line 2); unclosed quote `"a`; correct physical line when the bad value follows continuations/sections; `source` present iff passed to `parseIniSections(text, source)`; `readConfig` rejects (and re-rejects from cache) when `${gitDir}/config` is malformed — source is the config path.
8. Unchanged leniency: valueless keys, orphan entries, malformed headers still skipped.
9. Scoped reads inherit the refusal: verify `safeReadScopeOrSkip` (config-scoped-read) swallows only missing-file errors so `CONFIG_PARSE_ERROR` propagates from any scope — add a scoped-read test with a malformed local config.

Sweep existing tests that encoded the verbatim behaviour (quoted values kept with quotes, continuation ws dropped) and update them to the faithful expectation. `update-config.properties.test.ts`: delete the inline `unquoteValue`, compare parsed value directly to the input.

**Green** — `src/application/primitives/config-read.ts`:

- Add `{ code: 'CONFIG_PARSE_ERROR'; line: number; source?: string }` to `CommandError` + `configParseError(line, source?)` factory in `src/domain/commands/error.ts` (pattern: `configValueInvalid`).
- Rework `parseIniSections(text, source?)`: physical-line loop with index; blank/comment-line skip; header path unchanged (`stripInlineComment` retained for headers); kv path = pre-`=` comment check (`indexOfUnquoted` cut before `eqAt` → skip), key slice/trim, then `parseConfigValue(lines, lineIdx, colStart)` → `{ value, nextLineIdx }` implementing the design's state machine (quote flag, comment flag, trim latch, escape decode incl. continuation, GIT_SPACE whitespace set). Delete `joinContinuations`.
- Decompose into <20-line helpers (e.g. escape decode, whitespace step) — pure functions, no shared mutable state beyond the local accumulator.

**Refactor** — fold `indexOfUnquoted`'s escape-skip with the new decoder where sensible; run `npx vitest run test/unit/application/primitives/config-read.test.ts`, then `npm run validate`.

## Slice 2 — writer: `write_pair` byte parity + NUL-only rejection

Commit: `feat(config): adopt git write_pair quoting grammar, accept CR and control bytes`

**Red** — `test/unit/application/primitives/update-config.test.ts` (+ any porcelain test asserting CR/control rejection):

1. Quote triggers: leading space, trailing space, `;`, `#`, CR each quote; combo case `a; b"c\d ` → `"a; b\"c\\d "`.
2. Non-triggers: `"`, `\`, LF, TAB, leading/trailing TAB written **unquoted** with escapes (`a"b` → `a\"b`, `a\b` → `a\\b`, `a<LF>b` → `a\nb`, `a<TAB>b` → `a\tb`, `<TAB>a` → `\ta`).
3. CR written raw inside quotes (`a<CR>b` → `"a<CR>b"`); C0/DEL written raw unquoted.
4. Acceptance: CR / `\x01` / DEL values accepted end-to-end (`setConfigEntry`); NUL still throws `CONFIG_VALUE_INVALID` with position data.
5. Read-back: every case above re-parsed via `parseIniSections` equals the original (example-level round-trip).

**Green** — `src/application/primitives/update-config.ts`: `needsQuote` (space-edges/`;`/`#`/CR), `renderValue` (unconditional escapes, `\` first), `rejectValueControlChars` + `assertValueSafe` → NUL-only. Update affected doc comments (they describe the superseded grammar).

Run the unit file, then `npm run validate`.

## Slice 3 — properties: round-trip over the full NUL-free domain

Commit: `test(config): quoted-value grammar round-trip properties`

`update-config.properties.test.ts` (round-trip-pair lens, ADR-134–136 conventions):

1. Widen the generator: full-unicode `fc.string()` plus injected specials (CR, TAB, LF, `"`, `\`, `;`, `#`, C0, DEL), filtered of NUL only; drop the "assertValueSafe-survivable subset" map.
2. Property A (numRuns 200): `render → parseIniSections` yields exactly the input value.
3. Property B (numRuns 200): parse is total on render's output (never throws) — distinct assertion so a thrown `CONFIG_PARSE_ERROR` is distinguishable from a value mismatch.

Run file + `npm run validate`.

## Slice 4 — interop: byte/read/refusal parity vs real git

Commit: `test(interop): config quoted-value write, read, and refusal parity`

Extend `test/integration/config-interop.test.ts` (light file; keep per-case repos via existing helpers, scrubbed env):

1. **Write parity** — for the value matrix (`;`, `#`, leading/trailing space, `"`, `\`, LF, TAB, CR, `\x01`, combo): `git config --file` and tsgit `setConfigEntryInText`-driven write produce **byte-identical** files from the same starting text, and `git config --file --get` returns the original value from the tsgit-written file.
2. **Read parity** — a hand-written exotic file (quote toggling, `\b`, continuation with leading ws, escaped-backslash-at-EOL, CRLF, VT) → tsgit `getConfigValue` equals `git config --get` byte-for-byte per key.
3. **Refusal parity** — unknown escape and unclosed quote: git exits non-zero with `bad config line N`; tsgit throws `CONFIG_PARSE_ERROR` with the same `N` (extract N from git's stderr, compare).

Run file + `npm run validate`.

## Post-slice phases (workflow steps 6–9)

Reviews ×3 → architecture pass (candidates to *consider*: `parseConfigValue` extraction to `domain/config/`? — only if purity boundary argues for it; `indexOfUnquoted` duplication) → mutation (`./node_modules/.bin/stryker run --mutate src/application/primitives/config-read.ts --mutate src/application/primitives/update-config.ts` per local-scoping note) → docs (`docs/use`/`understand` config pages if they describe the old grammar; README untouched — no new command), BACKLOG: flip 24.9c `[x]` with summary, add follow-ups **24.9g** (subsection-name (un)escaping in headers) and **24.9h** (valueless keys ⇒ boolean true) after 24.9f in dependency order.
