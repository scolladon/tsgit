# Design — commit message `stripspace` normalization

## Goal

Make the `commit` porcelain produce commit-object SHAs **byte-identical to
canonical git**. Today the porcelain trims the message with `raw.trim()`, which
removes the trailing newline entirely. git instead runs `stripspace`
(`--cleanup=whitespace`, the default when a message is supplied via `-m`), which
guarantees exactly one trailing `\n`, strips per-line trailing whitespace,
collapses consecutive blank lines, and drops leading/trailing blank lines. The
serializer appends the message verbatim (`commit.ts` → `${headerText}\n\n${message}`),
so a message without a trailing `\n` yields a non-faithful commit id.

The `createCommit` primitive stays byte-verbatim — it is the low-level escape
hatch and is already faithful when handed a normalized message. The gap lives
entirely in the porcelain seam.

## Scope

In scope:

- A pure domain function `stripspace(message: string): string` faithful to
  git's `strbuf_stripspace` with no comment prefix (the `-m` / `whitespace`
  cleanup mode).
- Route the `commit` porcelain through it by replacing `raw.trim()` inside the
  single existing chokepoint `sanitizeMessage`. This transitively fixes the
  merge-commit message and the `commit-msg` hook re-sanitize path, since both
  already call `sanitizeMessage`.
- A focused interop test proving the porcelain commit id now equals real `git`.
- Regenerate every commit-id golden that shifts (parity scenarios + any pinned
  literals), verifying representative ones against real git.

Out of scope (deferred):

- A user-facing `--cleanup=<mode>` option (`verbatim` / `strip` / `scissors`).
  The backlog asks only that the porcelain *apply* normalization so SHAs match;
  YAGNI — add the option when a backlog item needs it.
- Comment-line stripping (`#`). git's `-m` path uses `whitespace` mode, which
  does **not** strip comments. `stripspace` here takes no comment prefix.
- The general write-porcelain interop harness (the next PR — covers `mv`,
  tree-level + working-tree faithfulness, multiple surfaces).

## git `stripspace` semantics (verified empirically)

Confirmed against `git stripspace` and `git commit -m` on this machine:

| input (`printf`)      | `git stripspace` output |
|-----------------------|-------------------------|
| `a  \nb\t`            | `a\nb\n`                |
| `a\n\n\nb`            | `a\n\nb\n` (blanks -> 1)|
| `\n\na\n\n`           | `a\n` (lead/trail drop) |
| `first`               | `first\n` (add newline) |
| `   \n\n  ` (all-ws)  | `` (empty, no newline)  |
| `#c\nreal`            | `#c\nreal\n` (no strip) |

`git commit -m 'subject line  ' -m '' -m 'body   '` stores message bytes
`subject line\n\nbody\n` in the commit object — exactly `stripspace` of the
`\n\n`-joined `-m` arguments.

### Algorithm (faithful port of `strbuf_stripspace`)

For each line (split on `\n`):

1. `cleanup(line)` — strip **trailing** ASCII whitespace (`\t\n\v\f\r` + space).
   Since we already split on `\n`, this trims trailing space / tab / `\v` / `\f`
   / `\r` (so `\r\n` line endings collapse to `\n`).
2. If the cleaned line is **non-empty**: if a blank line is pending *and* content
   has already been emitted, emit a single separator blank line first; reset the
   pending flag; emit the content.
3. If the cleaned line is **empty**: mark a blank pending (do not emit yet).

Trailing pending blanks are never flushed (dropped). Leading blanks never flush
because no content has been emitted (`emitted === false`). The result is empty
when no content survives, otherwise every emitted content line is `\n`-terminated
— so the output ends with exactly one `\n`.

```ts
const TRAILING_WS = /[ \t\v\f\r]+$/;

export const stripspace = (message: string): string => {
  const out: string[] = [];
  let blankPending = false;
  for (const line of message.split('\n')) {
    const cleaned = line.replace(TRAILING_WS, '');
    if (cleaned.length === 0) {
      blankPending = true;
      continue;
    }
    if (blankPending && out.length > 0) out.push('');
    blankPending = false;
    out.push(cleaned);
  }
  if (out.length === 0) return '';
  return `${out.join('\n')}\n`;
};
```

`split('\n')` on a `\n`-terminated input yields a trailing `''` segment, which
the algorithm treats as a (dropped) trailing blank — matching git. On a
non-`\n`-terminated input the final segment is real content and gets a `\n`
appended — matching git's "add newline" behavior.

## Module structure / file layout

```
src/domain/objects/
  commit-message.ts            # NEW — pure stripspace(message): string
  index.ts                     # + export { stripspace }

src/application/commands/internal/
  commit-message.ts            # sanitizeMessage now calls stripspace(raw)

test/unit/domain/objects/
  commit-message.test.ts            # NEW — example tests (literal git encodings)
  commit-message.properties.test.ts # NEW — idempotence + output invariants
  arbitraries.ts                     # NEW — message arbitrary (or reuse if present)

test/unit/application/commands/internal/
  commit-message.test.ts       # UPDATE — sanitizeMessage returns \n-terminated

test/integration/
  commit-message-interop.test.ts  # NEW — porcelain commit id == real git
```

`sanitizeMessage` after the change:

```ts
export const sanitizeMessage = (raw: string, opts: { readonly allowEmpty: boolean }): string => {
  const cleaned = stripspace(raw);
  if (cleaned === '' && !opts.allowEmpty) throw emptyCommitMessage();
  return cleaned;
};
```

The empty-message guard is **unchanged for ASCII inputs**: `stripspace(raw) === ''`
iff `raw.trim() === ''` whenever the message contains only ASCII whitespace, so
the `EMPTY_COMMIT_MESSAGE` / `--allow-empty-message` tests stay intact and only
the returned value gains the trailing `\n`. The one intentional divergence is
**more** faithful to git: `raw.trim()` is Unicode-aware and would reject a
message of only non-breaking spaces (`U+00A0`) as empty, whereas git's
`isspace` is ASCII-only and keeps such bytes as content. `stripspace` matches
git — a `U+00A0`-only message normalizes to a single-line commit, not empty.

## Function signatures and contracts

- `stripspace(message: string): string` — total, pure, no throws. Returns `''`
  or a string ending in exactly one `\n`, with no per-line trailing whitespace,
  no leading/trailing blank lines, and no consecutive blank lines. Idempotent:
  `stripspace(stripspace(x)) === stripspace(x)`.
- `sanitizeMessage(raw, { allowEmpty })` — unchanged signature; now normalizes
  via `stripspace` before the empty-policy check; still throws
  `EMPTY_COMMIT_MESSAGE` when empty and not allowed.

## Transitive faithfulness across callers

`sanitizeMessage` is the only normalization seam; its three callers all gain
faithful normalization for free:

| caller | effect |
|---|---|
| `commit.ts` (`resolveCommitMessage`) | commit-object message gains single trailing `\n`; SHA now matches git |
| `merge.ts` (merge commit + `MERGE_MSG`) | merge-commit message normalized; `MERGE_MSG` written normalized — re-sanitize at continue is a no-op by idempotence |
| `commit-hooks.ts` (`applyCommitMsgHook`) | hook-rewritten message re-normalized, matching git's post-hook cleanup |

`createCommit` (primitive) is intentionally **not** routed through `stripspace`
— it stays the verbatim low-level writer.

## Testing strategy

1. **Domain example tests** (`commit-message.test.ts`) — one isolated test per
   git behavior: trailing-ws strip, blank-line collapse, leading-blank drop,
   trailing-blank drop, add-trailing-newline, all-whitespace -> empty,
   comment-preserved, CRLF -> LF, already-normalized round-trip, empty string.
   Each documents the literal git encoding (mirrors the verified table).
2. **Domain property tests** (`commit-message.properties.test.ts`, per ADRs
   134–136) — `numRuns` tiers:
   - **Idempotence** (200): `stripspace(stripspace(x)) === stripspace(x)`.
   - **Output invariants** (100): result is `''` or ends with exactly one `\n`;
     no line has trailing ASCII whitespace; no leading/trailing blank line; no
     two consecutive blank lines.
   - **Total function** (100): never throws over the arbitrary message grammar
     (ASCII incl. whitespace + newlines; lens 3).
   Per-family generator in `arbitraries.ts` (messages built from lines of
   ASCII + interspersed blank lines + trailing-whitespace noise).
3. **`sanitizeMessage` unit tests** — update return-value expectations to the
   `\n`-terminated form; keep both empty-message guard tests (throw when empty &
   not allowed; pass when `allowEmpty`).
4. **Porcelain interop** (`commit-message-interop.test.ts`) — drive
   `repo.commit` via `openRepository` and `git commit -m` on a peer from an
   identical staged state; assert **commit-object SHA equality** across message
   shapes: trailing whitespace, internal blank runs, no trailing newline,
   multi-paragraph. Peer commits with `commit.gpgsign=false`,
   `-c commit.cleanup=whitespace` (pins the comparison to the mode tsgit
   implements, independent of the host's global `commit.cleanup`), and pinned
   `GIT_AUTHOR_*`/`GIT_COMMITTER_*` dates matching the explicit identity passed
   to `repo.commit` (the GPG/date determinism discipline from the interop
   helpers). This is the faithfulness proof for this PR.
5. **Golden regeneration** — implement the fix, run unit + integration + parity
   suites, and regenerate each shifted commit-id literal. Representative goldens
   (the parity seed commit) are recomputed against **real git** (signing off) so
   the regenerated value is proven faithful, not merely self-consistent.

## Mutation resistance

`stripspace` branches: empty-line vs content, `blankPending && out.length > 0`
(both operands need isolated tests), `out.length === 0` final guard, the
trailing-`\n` join. The example tests isolate each (leading-blank-only triggers
`out.length === 0` path before content; internal-blank triggers the
separator-emit with content present; all-whitespace triggers the empty return).
The property invariants pin the structural guarantees. Each guard operand gets a
dedicated example so StringLiteral / ConditionalExpression / EqualityOperator
mutants die individually.

## Key decisions (rationale + alternatives)

- **Normalize in the porcelain seam, not the primitive.** `sanitizeMessage` is
  the single chokepoint and already the policy layer (empty-message guard).
  `createCommit` must stay verbatim for advanced callers who pre-normalize.
  *Alternative rejected:* normalize inside `createCommit` — would break the
  verbatim contract and the existing primitive interop test.
- **`whitespace` cleanup (no comment strip), unconditional.** Faithful to
  `git commit -m`. *Alternative deferred:* expose `--cleanup=<mode>` — YAGNI,
  no backlog driver.
- **`stripspace` in `domain/objects`.** Pure git-grammar transform, zero
  platform deps, co-located with `commit.ts`; property-testable in isolation.
  *Alternative rejected:* keep it in `application/internal` — it is git
  semantics, not application policy.
- **Single-seam edit.** Replacing `trim()` inside `sanitizeMessage` fixes
  commit + merge + hook paths together; idempotence makes the MERGE_MSG
  write-then-re-sanitize safe. *Alternative rejected:* edit each caller — more
  diff, more drift risk.
