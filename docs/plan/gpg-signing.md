# Plan — GPG signing (produce side)

> Source: design doc `docs/design/gpg-signing.md` · ADRs `442, 443, 444, 445, 446, 447, 448, 449`
> The plan is the implementation script AND the knowledge handoff. Part agents start
> with zero context: whatever a part block omits is paid later as agent rediscovery.
> `plan-lint.sh` enforces the schema below — the plan phase cannot close without it.

## Sizing rules (applied here)

- 7 parts. Dependency order: **config → signer → commit signing → annotated tag → tag
  body-append + signing → push-cert domain framing → push-cert command integration.**
- The design sketched 6 parts and folded the whole push certificate into one. **Split
  push into Part 6 (pure-domain byte framing: `buildSignedReceivePackRequest` /
  `buildPushCertPayload` / `push-cert` capability) and Part 7 (command integration:
  mode tri-state, nonce parse, refusal/if-asked, capability wiring, interop).** Reason:
  the domain framing carries the byte-exact P.1/P.2 pins (opener-with-no-LF, no-caps
  ref lines, blank-line pkts, `push-cert-end`, flush, pusher-selector rule) with heavy
  unit tests, and the command integration carries an orthogonal tri-state resolution +
  three refusal/fallback branches + the interop capture harness. Together they are far
  past a reviewable single commit; each half is a cohesive atomic commit that builds on
  the other in the shared tree (Part 6 exports the framing, Part 7 wires it — the same
  shape as `buildReceivePackRequest`→`push`).
- No standalone test-only parts. Every part ships `src/` delta with its tests folded in.
  The tag round-trip **property** suite folds into Part 5 (the serializer it exercises).

### Cross-cutting facts every part must respect (pre-chewed once)

- **CommandRunner port** (`src/ports/command-runner.ts`): `run({ command, cwd, env,
  signal?, stdin? }) => Promise<{ exitCode; stdout? }>`. **Never rejects on non-zero
  exit.** Optional on `Context` as `ctx.command?` (`src/ports/context.ts`). Wired only in
  the **node** shim (`NodeCommandRunner`, `src/index.node.ts`); **absent** on browser +
  memory adapters ⇒ `ctx.command === undefined` off-node (ADR-447 hinge).
- **Two invocation precedents to mirror** — `src/application/primitives/run-filter-driver.ts`
  (stdin→stdout, no temp file — the **openpgp** contract) and
  `src/application/primitives/apply-textconv.ts` (payload to a temp file under
  `ctx.layout.gitDir` named `TEXTCONV_INPUT_<token>`, path as an argv arg, result read
  back, `finally` cleanup — the **ssh** contract). Both thread
  `...(ctx.signal !== undefined ? { signal: ctx.signal } : {})`, use `cwd: ctx.layout.workDir`
  and `env: { GIT_DIR: ctx.layout.gitDir }`, and return a discriminated `{ ok: true; … } |
  { ok: false; … }`.
- **Error taxonomy**: new codes are members of `CommandError`
  (`src/domain/commands/error.ts`) with a factory beside `cleanFilterFailed`; each new
  code needs a `case` in the **single exhaustiveness switch** `extractDetail`
  (`src/domain/error.ts`, the `default: { const _exhaustive: never = data }` guard finds a
  missing case at compile). There is **no whole-set snapshot test**; the gate is that
  `extractDetail` is 100%-branch-covered, so every new `case` needs a `.message` test and
  the factory needs a `.data` test (pattern: `test/unit/domain/error.test.ts` describe
  `cleanFilterFailed error`, and `test/unit/domain/commands/error.test.ts`). Assert
  `.data.code` **and** every payload field (mutation-resistant; `toThrow(Class)` alone is
  banned).
- **api.json is a prepush gate** (`check:doc-typedoc`), not a validate gate. Any change to
  a **public** option/type reachable from the `Repository` facade (`CommitOptions`,
  `PushOptions`, `TagCreateInput`) makes `reports/api.json` stale. Parts 3, 4, 5, 7 must
  run `npm run docs:json` and **commit** the regenerated `reports/api.json` in-slice (the
  huge typedoc-id diff is normal). Parts 1/2/6 touch internal-only symbols — run
  `npm run docs:json` and commit only if it shows a diff.
- **No new Tier-1 command** ⇒ **no** barrel/facade/`repository.test` surface-snapshot/
  `doc-coverage`/`audit-browser-surface` gates. Signing adds *options* to existing
  commands and a new *path* to `tag.create`; those flow through the `BindCtx` facade
  automatically. `docs/use/commands/{commit,tag,push}.md` prose updates are the **docs
  phase**, not a code part.
- **Interop harness** (`test/integration/interop-helpers.ts`): `runGit(args,{env})`,
  `runGitBytes`, `SAFE_ENV`/`runGitEnv()` (all `GIT_*` scrubbed, `GIT_CONFIG_NOSYSTEM=1`,
  isolated `HOME`), `GIT_AVAILABLE` (skip guard), `makePeerPair(slug)`,
  `initBothRepos(peer,ours)`, `git(dir,...args)`, `tryRunGit` (no-throw, for co-refusal).
  Node context in tests: `createNodeContext({ workDir, command: true|false, hooks: false })`
  — `command:false` = no runner (off-node parity); `command:true` = real
  `NodeCommandRunner`. Signing interop adds a **mktemp `GNUPGHOME`** + a generated
  unprotected key, plus `hasGpg()`/`hasSshKeygen()` skip guards. Non-deterministic
  signatures ⇒ pin **byte-exact object/wire structure with a deterministic canned signer**
  installed via `gpg.program`/`gpg.ssh.program`; use real gpg only for **structural**
  assertions. One shared `beforeAll` repo + **60s** timeout (heavy git-spawn interop
  times out hooks otherwise). Reconstruct git's stderr from the structured error (ADR-249)
  — never byte-match stderr.
- **Retrieval note**: Serena MCP is not connected in this tree; trust `npm run check:types`
  / `npm run validate` over harness LSP. State-mutating git probes run in a `mktemp -d`,
  never the worktree.

---

## Part 1 — Signing config keys

### Context

Parse the seven signing config keys. All are **new** — `readConfig`
(`src/application/primitives/config-read.ts`) today parses only `[user] name/email`,
`[core]`, `[remote]`, `[branch]`, `[submodule]`, `[merge]`, `[diff]`, `[filter]`,
`[extensions]`.

Files + exact seams:
- `src/application/primitives/config-read.ts`:
  - **Public `ParsedConfig`** interface (lines 10–67). Add:
    ```
    readonly user?: { readonly name?: string; readonly email?: string; readonly signingKey?: string };
    readonly commit?: { readonly gpgSign?: boolean };
    readonly tag?: { readonly gpgSign?: boolean };
    readonly push?: { readonly gpgSign?: 'true' | 'false' | 'if-asked' };
    readonly gpg?: { readonly format?: 'openpgp' | 'ssh' | 'x509'; readonly program?: string; readonly ssh?: { readonly program?: string } };
    ```
    **Decision (public-surface):** these are **internal** — `readConfig` is a primitive,
    not re-exported from the package entry. No barrel/facade gate. Run `npm run docs:json`;
    commit `reports/api.json` only if it diffs.
  - **`MutableParsedConfig`** (line ~976) — add matching mutable buckets.
  - **`dispatchSection`** (line ~1006) — add `else if (sec.section === 'commit') mergeCommit(...)`,
    `'tag' → mergeTag`, `'push' → mergePush`, `'gpg' → mergeGpg` (no subsection).
  - **`dispatchSubsection`** (line ~996) — add `if (sec.section === 'gpg') mergeGpgSsh(acc, name, sec)`
    for `[gpg "ssh"] program` (subsection `ssh`, key `program`).
  - **`mergeUser`** (line ~1108) — add the `signingkey` key arm (git key `user.signingKey`,
    case-insensitive ⇒ compare lowercased `'signingkey'`; string-typed ⇒ skip `null`).
  - New `merge*` helpers mirroring `mergeCore`/`mergeUser`: booleans via `parseGitBoolean`
    (already imported); `push.gpgSign` is git's **tri-state** — `if-asked` literal (case
    -insensitive) else `parseGitBoolean(value) ? 'true' : 'false'`; `gpg.format` accepts the
    three literals verbatim (unknown value ⇒ treat as absent, lenient like other enums).
  - **`finalize`** (line ~1355) — currently emits `out.user` only when **both** name+email
    present (line ~1370). Change to emit `out.user` when `(name && email)` **OR**
    `signingKey` present, spreading each field only when defined; **also relax the local `out`
    type inside `finalize`** (currently `user?: { name: string; email: string }`) to
    `{ name?; email?; signingKey? }`. Add `finalize` projection for `commit`/`tag`/`push`/`gpg`
    (emit only when populated, like `finalizeCore`).
- **`ParsedConfig.user` ripple** (name/email now optional in the type). The compiler
  (`check:types`) flags exactly these consumers — fix each to preserve today's behaviour
  ("user counts as identity only when BOTH name+email present"; a `signingKey`-only user
  is **not** an identity):
  - `src/application/primitives/reflog-identity.ts` (~line 18, `const user = config.user`).
  - `src/application/commands/internal/current-identity.ts` (~line 14).
  - `src/application/commands/commit.ts` `toAuthor` (~line 262) — param type becomes
    `{ name?; email?; signingKey? } | undefined`; guard `if (user === undefined ||
    user.name === undefined || user.email === undefined) return undefined;`.
  - `src/application/commands/merge.ts` (~lines 712–715, reads `config.user.name/email`).

Test file: `test/unit/application/primitives/config-read.test.ts` (extend). Interop:
fold a light parity check into `test/integration/config-signing-interop.test.ts` (new) —
`git config` writes each key, `readConfig` surfaces the same value (proves we parse what
git writes).

### TDD steps

- **RED** (unit, `config-read.test.ts`):
  - `Given a config with [user] signingKey = ABCD1234, When readConfig, Then user.signingKey is 'ABCD1234'` — fails: key unparsed (`user.signingKey` undefined).
  - `Given [user] signingKey with no name/email, When readConfig, Then user is { signingKey } and user.name is undefined` — fails: `finalize` drops user without name+email.
  - `Given [commit] gpgsign = true, When readConfig, Then commit.gpgSign is true` — fails: section unparsed.
  - `Given [commit] gpgsign = false, When readConfig, Then commit.gpgSign is false` (isolated from the true-case).
  - `Given [tag] gpgSign = true, When readConfig, Then tag.gpgSign is true`.
  - `Given [push] gpgSign = true, When readConfig, Then push.gpgSign is 'true'`.
  - `Given [push] gpgSign = if-asked, When readConfig, Then push.gpgSign is 'if-asked'` (tri-state — isolated case; and a `false` case).
  - `Given [gpg] format = ssh, When readConfig, Then gpg.format is 'ssh'` (+ `openpgp`, `x509` isolated cases).
  - `Given [gpg] program = /usr/bin/gpg2, When readConfig, Then gpg.program is '/usr/bin/gpg2'`.
  - `Given [gpg "ssh"] program = /usr/bin/ssh-keygen, When readConfig, Then gpg.ssh.program is '/usr/bin/ssh-keygen'`.
  - `Given a config with none of the signing keys, When readConfig, Then commit/tag/push/gpg are all undefined` (default ≡ today).
  - `Given [user] name+email but no signingKey, When readConfig, Then user is { name, email } and signingKey undefined` (proves the ripple preserved the identity gate).
- **RED** (interop, `config-signing-interop.test.ts`, `skipIf(!GIT_AVAILABLE)`): `git config user.signingKey/commit.gpgsign/gpg.format/gpg.ssh.program`, assert `readConfig` returns identical values.
- **GREEN**: add `MutableParsedConfig` buckets, `merge*` helpers, `dispatchSection`/`dispatchSubsection` arms, `mergeUser.signingkey`, `finalize` projections + user-emit relaxation; fix the four identity consumers.
- **REFACTOR**: keep each `merge*` <20 lines; factor the enum/tri-state parse into named helpers; ensure equivalent-mutant suppressions only where provably equivalent.

### Gate

`npx vitest run test/unit/application/primitives/config-read.test.ts test/integration/config-signing-interop.test.ts test/unit/application/commands/commit.test.ts test/unit/application/commands/merge.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/primitives/config-read.ts src/application/primitives/reflog-identity.ts src/application/commands/internal/current-identity.ts src/application/commands/commit.ts src/application/commands/merge.ts test/unit/application/primitives/config-read.test.ts test/integration/config-signing-interop.test.ts`

### Commit

`feat: parse signing config keys (user.signingKey, commit/tag/push gpgSign, gpg.format/program)`

---

## Part 2 — `signPayload` signing primitive over CommandRunner

### Context

The pure application primitive that delegates to the system signer (ADR-442 — **no new
port**). Reused unchanged by commit (Part 3), tag (Part 5), push (Part 7).

Files:
- `src/application/primitives/sign-payload.ts` (**new**). Signature (planner refinement —
  keep signPayload spawn-only; config/selector resolution stays in the caller so the
  primitive is a pure-ish function over `ctx.command`/`ctx.fs`, matching the
  filter/textconv split):
  ```
  export type SignPayloadResult =
    | { readonly ok: true; readonly armor: string }
    | { readonly ok: false; readonly reason: 'off-node' | 'unsupported-format' | 'signer-failed' };

  export interface SignRequest {
    readonly format: 'openpgp' | 'ssh' | 'x509';
    readonly program?: string;   // gpg.program / gpg.ssh.program; default applied per family
    readonly selector: string;   // resolved -u value (openpgp) / -f key-file path (ssh)
  }
  export const signPayload = (ctx: Context, payload: Uint8Array, req: SignRequest): Promise<SignPayloadResult>
  ```
  Behaviour (pinned X-matrix, design §Design):
  - `ctx.command === undefined` ⇒ `{ ok: false, reason: 'off-node' }` — **before any spawn** (ADR-447).
  - `format === 'x509'` ⇒ `{ ok: false, reason: 'unsupported-format' }` — **no spawn** (ADR-443).
  - `openpgp` (mirror `run-filter-driver.ts`): `runner.run({ command: `${program ?? 'gpg'} --status-fd=2 -bsau ${selector}`, stdin: payload, cwd: workDir, env: { GIT_DIR: gitDir }, signal? })`; `armor = decode(result.stdout ?? empty)`.
  - `ssh` (mirror `apply-textconv.ts`): write `payload` to `${gitDir}/GIT_SIGNING_BUFFER_<token>`; `runner.run({ command: `${program ?? 'ssh-keygen'} -Y sign -n git -f ${selector} ${tmp}`, cwd, env, signal? })`; read `${tmp}.sig` via `ctx.fs.read`; `finally`-cleanup **both** `tmp` and `tmp.sig` (`ctx.fs.rm`, ignore-missing).
  - **Success detection (ADR-446)**: `exitCode === 0` **AND** the output is a well-formed armor block — `-----BEGIN <PGP|SSH> SIGNATURE-----` … `-----END <…> SIGNATURE-----` (a pure `isWellFormedArmor(text)` helper). Else ⇒ `{ ok: false, reason: 'signer-failed' }`. `CommandRunner` is **not** widened for stderr/`SIG_CREATED`.
- A pure selector resolver, same file or `src/application/primitives/internal/signing-selector.ts`:
  ```
  export const resolveSigningSelector = (o: { signingKey?: string; keyOverride?: string; fallbackIdent: string }): string
  ```
  = `keyOverride ?? signingKey ?? fallbackIdent`. This is the **openpgp `-u` value** and the
  push-cert **`pusher`** selector (design X-matrix + P.2: the identical
  `user.signingKey`-else-committer-ident rule, one helper, used by Parts 3/5/7).
  `fallbackIdent` is the identity **string** `Name <email>` (NO timestamp — `serializeIdentity`
  is wrong here; build `` `${id.name} <${id.email}>` ``). **The ident fallback is openpgp-only.**
  For the **ssh `-f` key file**, `SignRequest.selector = keyOverride ?? signingKey` (a key-file
  path; there is NO ident fallback — an ssh sign with no key surfaces as `signer-failed`). The
  caller picks which selector to pass into `SignRequest` based on `format`.
- Export `signPayload`, `SignPayloadResult`, `SignRequest`, `resolveSigningSelector` from
  the **primitives barrel** `src/application/primitives/index.ts` (internal; sits beside
  the existing `export { createCommit } from './create-commit.js'`).
- Test double: `MemoryCommandRunner` (`src/adapters/memory/memory-command-runner.ts`)
  records `calls` but its `run` returns **exit code only** (no stdout). For the openpgp
  path (stdout-bearing), add a tiny inline `CommandRunner` stub returning `{ exitCode,
  stdout }` in the test (place a reusable `stubCommandRunner({ exitCode?, stdout?, onRun?
  })` in `test/unit/application/primitives/helpers/stub-command-runner.ts` — reused by
  Part 7). For the ssh path use a memory `ctx.fs` whose stub `behaviour` writes `${tmp}.sig`.

Test file: `test/unit/application/primitives/sign-payload.test.ts` (new). No interop here
(pure primitive; real-signer interop lands in Parts 3/5/7).

### TDD steps

- **RED** (`sign-payload.test.ts`, over the stub runner + memory fs):
  - `Given format openpgp and a runner returning exit 0 with a PGP armor on stdout, When signPayload, Then result is { ok: true, armor } and the armor round-trips` — fails: module absent.
  - `Given format openpgp, When signPayload, Then the runner command is '<program> --status-fd=2 -bsau <selector>' and stdin equals the payload bytes` (assert `runner.calls[0].command` + `.stdin`).
  - `Given gpg.program set, When signPayload openpgp, Then the command uses that program not 'gpg'`; and `Given no program, Then it defaults to 'gpg'` (isolated).
  - `Given format ssh, When signPayload, Then payload is written to a temp file, ssh-keygen argv is '-Y sign -n git -f <selector> <tmp>', <tmp>.sig is read as the armor, and both temp files are removed` (assert fs writes/reads + cleanup).
  - `Given format ssh and no gpg.ssh.program, Then the program defaults to 'ssh-keygen'`.
  - `Given ctx.command undefined, When signPayload (any format), Then result is { ok: false, reason: 'off-node' } and no spawn/temp-file occurred` — **isolated** guard test (ADR-447).
  - `Given format x509, When signPayload, Then result is { ok: false, reason: 'unsupported-format' } and the runner is never called` — **isolated** guard (ADR-443).
  - `Given a runner returning a non-zero exit, When signPayload, Then result is { ok: false, reason: 'signer-failed' }` — **isolated**.
  - `Given a runner returning exit 0 but stdout without a well-formed armor, When signPayload, Then result is { ok: false, reason: 'signer-failed' }` — **isolated** (ADR-446 armor check).
  - `Given a ssh runner that fails after writing no .sig, When signPayload, Then result is { ok: false } and temp files are still cleaned up` (finally path).
  - `Given ctx.signal set, When signPayload, Then the runner request carries that signal` (abort threading).
  - `resolveSigningSelector`: `Given keyOverride, Then returns it`; `Given no override but signingKey, Then returns signingKey`; `Given neither, Then returns fallbackIdent` (three isolated cases).
- **GREEN**: implement `signPayload` + `isWellFormedArmor` + `resolveSigningSelector`; barrel-export.
- **REFACTOR**: extract the openpgp and ssh arms into named helpers (<20 lines each); no swallowed errors in the `finally` cleanup (rm ignore-missing only).

### Gate

`npx vitest run test/unit/application/primitives/sign-payload.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/primitives/sign-payload.ts src/application/primitives/index.ts test/unit/application/primitives/sign-payload.test.ts test/unit/application/primitives/helpers/stub-command-runner.ts`

### Commit

`feat: signPayload primitive — gpg/ssh signing over CommandRunner with typed refusal`

---

## Part 3 — Commit signing (`-S` / commit.gpgsign) + narrow injection guard

### Context

Wire signing into `commit` and fix the guard that currently rejects every real armor.

Files + seams:
- `src/application/primitives/validators.ts`:
  - Today `hasHeaderInjectionChars` (lines 61–65) rejects NUL, CR, `\n\n`, leading/trailing
    `\n` — the last three reject **every genuine armor** (blank line after `-----BEGIN…` +
    trailing `\n`). ADR-445 narrows **only the signature field**.
  - Add a new predicate `hasSignatureInjectionChars(value): boolean` = `value.includes('\0')
    || value.includes('\r')` (NUL/CR only). Keep `hasHeaderInjectionChars` unchanged for
    `extraHeaders`. Reuse the existing `REASON_GPG_SIGNATURE_INJECTION` constant (line ~38).
- `src/application/primitives/create-commit.ts` (line 32): switch the `input.gpgSignature`
  check from `hasHeaderInjectionChars` to `hasSignatureInjectionChars`. The `extraHeaders`
  loop (lines 35–43) keeps `hasHeaderInjectionChars`. The `gpgsig` continuation header is
  already emitted by `serializeCommitContent` (`src/domain/objects/commit.ts:131-133`) via
  `formatContinuationHeader` — no domain change needed.
- `src/application/commands/commit.ts`:
  - `CommitOptions` (line 46) gains `readonly sign?: boolean` (git tri-state: `undefined`=use
    config, `true`=`-S`, `false`=`--no-gpg-sign`) and `readonly signKey?: string`
    (`-S<keyid>` override). **Public** (facade arg) ⇒ regenerate `reports/api.json`.
  - `config` is already read at line 93. Compute `wantSign = opts.sign ?? (config.commit?.gpgSign === true)`.
  - Insert the signed flow **before** `createCommit` (line 131): (1) `payload =
    serializeCommitContent({ ...commitData, gpgSignature: undefined })` (design C-pin:
    payload ≡ unsigned object bytes); (2) `format = config.gpg?.format ?? 'openpgp'`,
    `program = format === 'ssh' ? config.gpg?.ssh?.program : config.gpg?.program`. Selector:
    for `openpgp` = `resolveSigningSelector({ signingKey: config.user?.signingKey, keyOverride:
    opts.signKey, fallbackIdent: `${committer.name} <${committer.email}>` })` — the `-u`
    fallback is the **committer identity string** `Name <email>`, no timestamp (design X-matrix
    pin); for `ssh` = `opts.signKey ?? config.user?.signingKey` (the `-f` key file);
    (3) `sig = await signPayload(ctx, payload, { format, program, selector })`; on `!sig.ok`
    **throw** `signingFailed(sig.reason, format)` (nothing written — `writeObject` never
    runs); (4) call `createCommit(ctx, { ...commitData, gpgSignature: sig.armor })`.
- New error code (**public surface** — `TsgitError.data.code` is user-reachable):
  - `src/domain/commands/error.ts`: add union member `{ readonly code: 'SIGNING_FAILED';
    readonly reason: 'off-node' | 'unsupported-format' | 'signer-failed'; readonly format?:
    'openpgp' | 'ssh' | 'x509' }` + factory `signingFailed(reason, format?)`.
  - `src/domain/error.ts` `extractDetail`: add a `case 'SIGNING_FAILED'` returning a
    faithful message (git prints `gpg failed to sign the data`), e.g.
    `` `gpg failed to sign the data (${data.reason}${data.format ? `, format=${data.format}` : ''})` ``
    — the exhaustiveness `never` guard forces this case.

Byte-pins (design C-matrix, git 2.55.0): signed commit = `gpgsig` continuation header
immediately after `committer`, continuation lines space-prefixed, armor interior blank line
→ lone ` `; SHA computed **over the signed object**. Signed **payload** = the object
**without** `gpgsig` ≡ `serializeCommitContent(unsigned CommitData)`. SSH commits use the
**same** header placement, only the armor header differs.

Tests: `test/unit/application/primitives/validators.test.ts` (guard), a commit-signing unit
test in `test/unit/application/commands/commit.test.ts` (extend), error factory/message
tests in `test/unit/domain/commands/error.test.ts` + `test/unit/domain/error.test.ts`, and
`test/integration/commit-signing-interop.test.ts` (new).

### TDD steps

- **RED** (guard, `validators.test.ts`) — isolated per char class (ADR-445):
  - `Given a value containing NUL, When hasSignatureInjectionChars, Then true`.
  - `Given a value containing CR, When hasSignatureInjectionChars, Then true`.
  - `Given a genuine PGP armor (blank line after BEGIN + trailing newline), When hasSignatureInjectionChars, Then false` (the case the old guard wrongly rejected).
  - `Given a value with interior \n\n but no NUL/CR, When hasSignatureInjectionChars, Then false` (proves the narrowing dropped the \n\n rule for the signature field).
- **RED** (error, `error.test.ts`):
  - `Given signingFailed('signer-failed','openpgp'), When reading .data, Then code SIGNING_FAILED, reason 'signer-failed', format 'openpgp'`.
  - `Given signingFailed('off-node'), When reading .message, Then it names the reason` (+ a distinct `unsupported-format` case).
- **RED** (commit, `commit.test.ts`, stub runner returning a canned armor):
  - `Given commit with sign true and a canned signer, When commit, Then createCommit received gpgSignature and the payload fed to the signer had no gpgsig header` (assert `signPayload` input bytes ≡ `serializeCommitContent(unsigned)`).
  - `Given commit.gpgSign true in config and sign undefined, When commit, Then the commit is signed`.
  - `Given commit.gpgSign true but sign explicitly false, When commit, Then the commit is unsigned` (isolated tri-state — `--no-gpg-sign` overrides config).
  - `Given signKey override, When commit, Then the signer selector is that key not user.signingKey`.
  - `Given a signer that fails (reason signer-failed), When commit, Then it throws SIGNING_FAILED and HEAD is unchanged (no object/ref/reflog)` — atomic refusal (F1).
  - `Given no ctx.command and sign requested, When commit, Then it throws SIGNING_FAILED reason 'off-node' and nothing is written` (ADR-447 parity, memory/command:false).
- **RED** (interop, `commit-signing-interop.test.ts`, `skipIf(!GIT_AVAILABLE || !hasGpg)`, mktemp GNUPGHOME + generated key, shared `beforeAll`, 60s):
  - Deterministic canned-signer pin: install the **same** canned signer for both peers via `gpg.program=<recorder>`; tsgit `commit -S` and `git commit -S` produce a **byte-identical** commit object + identical SHA (compare `git cat-file commit`).
  - Payload pin: the recorder captures stdin; assert it equals the unsigned object bytes (no `gpgsig`).
  - SSH format pin: with `gpg.format=ssh`, the object still uses the `gpgsig` header, armor header `-----BEGIN SSH SIGNATURE-----`.
  - Real-gpg structural pin: with real gpg, the produced object parses (`git verify-commit` sees a signature; assert structure, not a frozen SHA).
  - Failure co-refusal: a failing signer ⇒ tsgit throws SIGNING_FAILED and `git commit -S` also exits non-zero with nothing committed (`tryRunGit`; reconstruct stderr from the structured error, don't byte-match).
- **GREEN**: add the guard predicate, switch `create-commit.ts`, add `CommitOptions` fields + signed flow, add the error code/factory/`extractDetail` case.
- **REFACTOR**: extract the "resolve signer inputs from config" block into a small named helper (shared shape with Part 5/7); keep `commit` early-returns clean.

### Gate

`npx vitest run test/unit/application/primitives/validators.test.ts test/unit/application/commands/commit.test.ts test/unit/domain/commands/error.test.ts test/unit/domain/error.test.ts test/integration/commit-signing-interop.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/primitives/validators.ts src/application/primitives/create-commit.ts src/application/commands/commit.ts src/domain/commands/error.ts src/domain/error.ts` (then `npm run docs:json` + commit `reports/api.json`)

### Commit

`feat: signed commits (-S / commit.gpgsign) with narrowed injection guard`

---

## Part 4 — Annotated tag creation (`tag -a`, unsigned)

### Context

Build the annotated-tag creation machinery that signing requires (ADR-449). Today
`tagCreate` (`src/application/commands/tag.ts:63`) writes **only** a lightweight tag
(`updateRef` straight to the target OID). There is **no** tag-object write anywhere in the
application tier.

Files + seams:
- `src/application/primitives/create-tag.ts` (**new**, mirrors `create-commit.ts`): builds a
  `Tag` domain object (`src/domain/objects/tag.ts` `TagData`: object/objectType/tagName/
  tagger/message/extraHeaders) and `writeObject`s it. Validate the tag name (domain
  `serializeTagContent` already rejects empty/`\n`/`\0`) and roundtrip the tagger via
  `serializeIdentity`. Returns the tag object `ObjectId`. Export from the primitives barrel.
- `src/domain/objects/tag.ts`: `serializeTagContent` (line 128) already emits the unsigned
  annotated payload correctly (`object\ntype\ntag\ntagger\n\n<message>`). **Do not** touch
  the `gpgsig` branch here — that is Part 5. Part 4 only exercises the unsigned path.
- `src/application/commands/tag.ts`:
  - `TagCreateInput` (line 25) gains `readonly annotate?: boolean` (`-a`), `readonly message?:
    string` (`-m`). **Public** (facade arg) ⇒ regenerate `reports/api.json`.
  - `tagCreate` (line 63): resolve `wantAnnotated = input.annotate === true || input.message
    !== undefined`. When annotated: resolve the tagged object's **type** (read the target
    object to get `commit|tree|blob|tag`), resolve the **tagger** from `config.user`
    (name/email + `Math.floor(Date.now()/1000)` + tz — mirror `commit.ts` `toAuthor`/
    `resolveCommitter`; reuse `readConfig`), call `createTag`, then `updateRef` to the **tag
    object OID** (not the target). Keep the existing lightweight path (lines 66–84) unchanged
    when `!wantAnnotated`. Preserve the `TAG_EXISTS` mapping (lines 78–83) and `force`/
    `expected: 'absent'` CAS.
- The `bindTagNamespace` binder (`src/application/commands/internal/tag-namespace.ts`) passes
  `TagCreateInput` straight through — no binder change.

Byte-pins (design T-matrix upper half, git 2.55.0): unsigned annotated tag =
`object <sha>\ntype <type>\ntag <name>\ntagger <ident> <ts> <tz>\n\n<message>\n` inside a
`tag` loose object; SHA over those bytes; `refs/tags/<name>` points at the **tag object**.

Tests: `test/unit/application/commands/tag.test.ts` (extend), `test/unit/domain/objects/
tag.test.ts` (unsigned annotated serialize already covered — add if a gap),
`test/integration/tag-annotated-interop.test.ts` (new).

### TDD steps

- **RED** (`tag.test.ts`):
  - `Given tagCreate with annotate true, message 'v1', target HEAD, When create, Then refs/tags/<name> points at a written tag object (not the commit) and the object type is 'tag'`.
  - `Given tagCreate with message set and annotate unset, When create, Then it is annotated` (message implies `-a`).
  - `Given tagCreate with neither annotate nor message, When create, Then it stays lightweight (ref → target OID, no tag object written)` — proves the default path unchanged.
  - `Given tagCreate annotated with no configured user, When create, Then it throws the author-unconfigured refusal` (tagger identity required — faithful).
  - `Given an existing tag and force false, When annotated create, Then TAG_EXISTS` (CAS preserved).
- **RED** (interop, `tag-annotated-interop.test.ts`, `skipIf(!GIT_AVAILABLE)`, shared `beforeAll`, 60s):
  - `git tag -a -m v1` and tsgit annotated create over the **same** target/tagger/message produce a **byte-identical tag object + identical SHA** (compare `git cat-file tag`); use a fixed tagger date via config/env so the bytes match.
  - `git tag <name>` (lightweight) and tsgit lightweight create still yield a ref pointing at the target (regression pin for the unchanged path).
- **GREEN**: add `create-tag.ts`, `TagCreateInput` fields, the annotated branch in `tagCreate`, tagger/type resolution.
- **REFACTOR**: extract tagger resolution + target-type read into named helpers (<20 lines); keep `tagCreate` early-returns.

### Gate

`npx vitest run test/unit/application/commands/tag.test.ts test/unit/domain/objects/tag.test.ts test/integration/tag-annotated-interop.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/primitives/create-tag.ts src/application/primitives/index.ts src/application/commands/tag.ts test/unit/application/commands/tag.test.ts test/integration/tag-annotated-interop.test.ts` (then `npm run docs:json` + commit `reports/api.json`)

### Commit

`feat: annotated tag creation (tag -a / -m)`

---

## Part 5 — Tag body-append serialize/parse (round-trip) + tag signing (`tag -s`)

### Context

Fix the tag faithfulness trap (ADR-448) and add tag signing (ADR-449). Today
`serializeTagContent` (`src/domain/objects/tag.ts:143-145`) emits `gpgsig` as a
**continuation header** — **wrong for tags**: git **appends** the armor to the message
**body**. `parseTagContent` (line 44) reads it back as a header via
`parseTagOptionalHeaders` → `parseOptionalHeaderBlock` (`encoding.ts:98`, `gpgsig` branch).

Files + seams:
- `src/domain/objects/tag.ts`:
  - `serializeTagContent` (line 128): **remove** the `data.gpgSignature !== undefined ⇒
    formatContinuationHeader('gpgsig', …)` branch (lines 143–145). When `gpgSignature` is
    set, build `` `${headerText}\n\n${data.message}${data.gpgSignature}` `` — i.e. **append**
    the armor after the message (design T-pin: payload ends `…message\n`, final object =
    payload + armor; the armor itself carries its leading/trailing newlines). When unset,
    behaviour is unchanged (Part 4's path).
  - `parseTagContent` (line 44) / `parseTagOptionalHeaders` (line 109): stop routing `gpgsig`
    through `parseOptionalHeaderBlock`. Instead **peel** a trailing armor block off the
    message: if the message contains a `-----BEGIN <PGP|SSH> SIGNATURE-----` … `-----END
    <…> SIGNATURE-----` block at the end, split it into `gpgSignature` and the preceding
    message. Add a pure `peelTagSignature(message): { message; gpgSignature? }`. Keep
    `extraHeaders` parsing intact (tags can still carry non-gpgsig extra headers).
  - Confirm `parseOptionalHeaderBlock`'s `gpgsig` branch is now unreachable **for tags**;
    it is still used by commit parsing (`src/domain/objects/commit.ts`) — **do not** change
    `encoding.ts` (commits legitimately use the `gpgsig` header).
- `src/application/primitives/create-tag.ts` (from Part 4): accept an optional
  `gpgSignature` and pass it into the `Tag` built for `writeObject`.
- `src/application/commands/tag.ts`:
  - `TagCreateInput` gains `readonly sign?: boolean` (`-s`) and `readonly signKey?: string`.
    **Public** ⇒ regenerate `reports/api.json`. `-s` **implies** annotated.
  - `tagCreate`: `wantSign = input.sign ?? (config.tag?.gpgSign === true)` **and** annotated;
    signing forces `wantAnnotated`. Signed flow: (1) build the **unsigned annotated payload**
    (`serializeTagContent` of the unsigned `TagData`, ending `…message\n`); (2) resolve
    format/program/selector exactly as Part 3 — openpgp `-u` fallback = the **tagger identity
    string** `` `${tagger.name} <${tagger.email}>` `` (no timestamp); ssh `-f` =
    `input.signKey ?? config.user?.signingKey`; (3) `sig = await signPayload(ctx, payload,
    {...})`; `!sig.ok` ⇒ **throw**
    `signingFailed(sig.reason, format)` (no object, no ref); (4) `createTag(ctx, {
    ...tagData, gpgSignature: sig.armor })`, then `updateRef` to the tag OID.
- **Property test** (ADR-448 + property mandate — this is a parser/serializer round-trip
  pair): `test/unit/domain/objects/tag.properties.test.ts` (**new**) with a shared
  `test/unit/domain/objects/arbitraries.ts` (create or extend). `fast-check` generators for
  a signed `TagData` (arbitrary object id, type, tag name sans `\n`/`\0`, tagger, message,
  armor block). Properties: `parse(serialize(x)) ≡ x` (**numRuns 200** — cheap round-trip),
  and the count invariant `one appended armor ↔ one peeled signature` (**numRuns 100**).
  `Given` reads "Given an arbitrary signed tag". Never delete the literal example test.

Byte-pins (design T-matrix, git 2.55.0): final object last 30 bytes =
`…-----END PGP SIGNATURE-----\n`; signed payload = unsigned object ending `<message>\n`;
SSH tags append identically.

Tests: `test/unit/domain/objects/tag.test.ts` (example T-pins), `tag.properties.test.ts`
(round-trip), `test/unit/application/commands/tag.test.ts` (signing), `test/integration/
tag-signing-interop.test.ts` (new).

### TDD steps

- **RED** (domain example, `tag.test.ts`):
  - `Given a TagData with a PGP armor gpgSignature, When serializeTagContent, Then the armor is appended after the message body (no gpgsig header) and the last bytes are '-----END PGP SIGNATURE-----\n'` — fails: current code emits a `gpgsig` header.
  - `Given a serialized signed tag, When parseTagContent, Then gpgSignature is the peeled armor and message excludes it`.
  - `Given a serialized signed tag with an SSH armor, Then serialize appends / parse peels identically`.
  - `Given an unsigned annotated tag, When serialize/parse, Then no signature and message intact` (regression — Part 4 path unchanged).
- **RED** (property, `tag.properties.test.ts`):
  - `Given an arbitrary signed tag, When parse(serialize(x)), Then it equals x` (numRuns 200).
  - `Given an arbitrary signed tag, When counting, Then exactly one appended armor maps to one peeled signature` (numRuns 100).
- **RED** (command, `tag.test.ts`, canned signer):
  - `Given tag with sign true and a canned signer, When create, Then the tag object appends the armor to the body and the ref points at it`.
  - `Given tag.gpgSign true and sign undefined, When annotated create, Then it is signed`; `Given tag.gpgSign true but sign false, Then unsigned` (isolated tri-state).
  - `Given a plain lightweight tag with tag.gpgSign true, When create, Then it stays lightweight and unsigned` (tag.gpgSign only signs annotated).
  - `Given a signer that fails, When signed tag create, Then it throws SIGNING_FAILED and neither a tag object nor a ref is written` — atomic (F2).
  - `Given no ctx.command and sign requested, Then SIGNING_FAILED reason 'off-node', nothing written` (ADR-447).
- **RED** (interop, `tag-signing-interop.test.ts`, `skipIf(!GIT_AVAILABLE || !hasGpg)`, mktemp GNUPGHOME, shared `beforeAll`, 60s):
  - Canned-signer byte pin: `git tag -s` and tsgit signed tag over identical inputs produce a **byte-identical tag object + SHA** (`git cat-file tag`); armor appended to body.
  - Payload pin: recorder stdin equals the unsigned tag object ending `message\n`.
  - Real-gpg structural pin (`git verify-tag` sees a signature; assert structure).
  - Failure co-refusal vs `git tag -s` (nothing written both sides).
- **GREEN**: redesign serialize/parse (append/peel), thread `gpgSignature` through `create-tag`, add `TagCreateInput` fields + signed flow.
- **REFACTOR**: `peelTagSignature` pure + <20 lines; dedupe the format/program/selector resolution with Part 3's helper.

### Gate

`npx vitest run test/unit/domain/objects/tag.test.ts test/unit/domain/objects/tag.properties.test.ts test/unit/application/commands/tag.test.ts test/integration/tag-signing-interop.test.ts && npm run check:types && ./node_modules/.bin/biome check src/domain/objects/tag.ts src/application/primitives/create-tag.ts src/application/commands/tag.ts test/unit/domain/objects/tag.test.ts test/unit/domain/objects/tag.properties.test.ts test/unit/domain/objects/arbitraries.ts` (then `npm run docs:json` + commit `reports/api.json`)

### Commit

`feat: signed tags — append armor to body (tag -s / tag.gpgSign)`

---

## Part 6 — Push certificate domain framing (pure)

### Context

The pure, byte-exact P.1/P.2 framing for signed push (ADR-444). No command wiring here
(Part 7). Mirrors `buildReceivePackRequest` (`src/domain/protocol/receive-pack.ts:37`).

Files + seams:
- `src/domain/protocol/receive-pack.ts`:
  - Current `updateLine(update, caps)` (line 32) emits `<old> <new> <name>\0<caps>\n` on the
    first ref and `…\n` on the rest. In a **signed** cert the ref-update lines carry **NO**
    caps tail — the caps ride the opener. Add a **no-caps** variant (or call `updateLine`
    with `[]`) for cert ref lines.
  - Add `buildSignedReceivePackRequest(req: SignedReceivePackRequest): Uint8Array`. Input
    carries the negotiated caps, the ref updates, the **armor** string, the cert header
    fields (version/pusher/pushee/nonce), and the packfile. It frames, **each line as its
    own pkt-line via `encodePktLine`** (`src/domain/protocol/pkt-line.ts:36`):
    1. **Opener** `push-cert\0 <caps joined by space>` — **NO trailing LF** (design P.1
       load-bearing: NUL then a **leading space** then negotiated caps incl. a bare
       `push-cert` token).
    2. `certificate version 0.1\n`
    3. `pusher <selector> <ts> <tz>\n`
    4. `pushee <pushee-url>\n`
    5. `nonce <nonce>\n`
    6. blank line — an `\n`-only pkt (`0005`).
    7. one `<old> <new> <refname>\n` per ref — **no caps tail**.
    8. the armor **body, one pkt-line per line** (interior blank line = `\n`-only pkt).
    9. `push-cert-end\n`.
    10. `FLUSH_PKT` (`0000`), then the packfile bytes appended raw.
  - Add pure `buildPushCertPayload({ pusher, pushee, nonce, updates }): Uint8Array` — the
    **signed payload** = cert lines #2–#7 as **raw text, no pkt framing**, inclusive of every
    trailing `\n` (design P.2). `pusher` is the full pusher-line value `<selector> <ts> <tz>`
    (a single string) so the payload and the framing emit **identical** bytes for that line
    — the caller passes the same `pusher` string to both builders:
    ```
    certificate version 0.1\n
    pusher <selector> <ts> <tz>\n
    pushee <pushee-url>\n
    nonce <nonce>\n
    \n
    <old> <new> <refname>\n
    ```
    The armor and the `push-cert\0…` opener are **not** in the payload.
  - Export both from the protocol barrel `src/domain/protocol/index.ts` (beside
    `buildReceivePackRequest`, lines ~50–54) and re-export the request/payload input types.
- `src/domain/protocol/capabilities.ts`: add a `PUSH_CERT = 'push-cert'` token constant.
  Do **not** add it to `CLIENT_CAPABILITIES_PUSH` (line 17) — it is conditional (only when
  signing), added in Part 7's `selectPushCapabilities`. `parseCapabilities`/
  `negotiateCapabilities`/`keyOf` already handle `push-cert=<nonce>` (splits on `=`), so the
  server-advertised `push-cert=<nonce>` de-dupes by key `push-cert` — verify with a test.

Byte-pins: design §P.1 (the annotated example with `005e`/`001c`/`002d`/`003e`/`0005`/`0066`
lengths) and §P.2. **The opener has no LF; ref lines have no caps tail; blank + armor-interior
blanks are `0005` LF-only pkts; `push-cert-end\n` then flush then pack.**

Tests: `test/unit/domain/protocol/receive-pack.test.ts` (extend) + `test/unit/domain/
protocol/capabilities.test.ts` (extend). Pure unit — no interop here.

### TDD steps

- **RED** (`receive-pack.test.ts`):
  - `Given a signed request with one ref and negotiated caps, When buildSignedReceivePackRequest, Then the first pkt is 'push-cert\0 <caps>' with a leading space and NO trailing LF` (decode the pkt, assert exact bytes incl. the `\0` and no `\n`).
  - `Given the same, Then the ref-update pkt is '<old> <new> <refname>\n' with NO \0-caps tail` (contrast with `buildReceivePackRequest` where ref#0 carries caps).
  - `Given the cert, Then the blank line and the armor interior blank are each a 5-byte LF-only pkt ('0005')`.
  - `Given a two-line armor, Then each armor line is its own pkt-line in order`.
  - `Given the cert, Then it is terminated by a 'push-cert-end\n' pkt then a flush-pkt '0000' then the packfile bytes` (assert tail ordering + pack appended).
  - `Given the full P.1 example inputs, Then the framed bytes equal the pinned length-prefixed sequence` (the design's `005e…0000` golden).
  - `buildPushCertPayload`: `Given pusher/pushee/nonce/one update, When build, Then the bytes equal the P.2 raw-text block including every trailing \n and excluding the armor/opener`.
  - `Given a key-id pusher selector vs a Name <email> selector, Then the payload pusher line reflects each verbatim` (both P.2 selector cases).
- **RED** (`capabilities.test.ts`):
  - `Given a server cap tail containing 'push-cert=<nonce>', When parseCapabilities, Then the token is preserved and de-dupes under key 'push-cert'`.
  - `Given client wants including a bare 'push-cert' and a server advertising 'push-cert=<nonce>', When negotiateCapabilities, Then the negotiated set contains the server's 'push-cert=<nonce>' token` (used by Part 7 to strip → bare).
- **GREEN**: implement `buildSignedReceivePackRequest`, `buildPushCertPayload`, the no-caps ref line, the `PUSH_CERT` constant; barrel-export.
- **REFACTOR**: extract the pkt-line assembly into small named builders (<20 lines); use `encodePktLine` for lines and hand-assemble the flush+pack tail like `buildReceivePackRequest`.

### Gate

`npx vitest run test/unit/domain/protocol/receive-pack.test.ts test/unit/domain/protocol/capabilities.test.ts && npm run check:types && ./node_modules/.bin/biome check src/domain/protocol/receive-pack.ts src/domain/protocol/capabilities.ts src/domain/protocol/index.ts test/unit/domain/protocol/receive-pack.test.ts test/unit/domain/protocol/capabilities.test.ts`

### Commit

`feat: push-cert wire framing — buildSignedReceivePackRequest + buildPushCertPayload`

---

## Part 7 — Push certificate command integration (`push --signed` / push.gpgSign)

### Context

Wire signed push into the `push` command (ADR-444): mode tri-state, nonce parse, negotiation
refusal / if-asked fallback, capability wiring, and the send-seam swap. Reuses `signPayload`
(Part 2) and the Part 6 framing unchanged.

Files + seams:
- `src/application/commands/push.ts`:
  - `PushOptions` (line 50) gains `readonly signed?: 'yes' | 'no' | 'if-asked'` (git's
    `--signed` / `--no-signed` / `--signed=if-asked`). **Public** (facade arg) ⇒ regenerate
    `reports/api.json`. Effective mode = `opts.signed ?? mapConfig(config.push?.gpgSign) ??
    'no'` where `'true'→'yes'`, `'false'→'no'`, `'if-asked'→'if-asked'`.
  - `sendUpdates` (line 296) is the seam. Today: `capabilities =
    selectPushCapabilities(adv.capabilities)` (line 311) → `buildReceivePackRequest({ updates,
    capabilities, packfile })` (line 312) → `session.exchange` (line 317). Insert before
    building the request:
    - **Nonce parse**: find the advertised token starting with `push-cert=` in
      `adv.capabilities` (already parsed by `parseCapabilities` via `parseAdvertisedRefs`);
      `nonce = token.slice('push-cert='.length)`; `advertised = nonce !== undefined`.
    - **Mode resolution / refusal (P.3)**: if mode `'yes'` and `!advertised` ⇒ **throw**
      `signedPushUnsupported(remoteName)` (git: `the receiving end does not support --signed
      push`); nothing sent. If mode `'if-asked'` and `!advertised` ⇒ fall through to the
      existing **unsigned** `buildReceivePackRequest` path. Off-node (`ctx.command ===
      undefined`) with mode `≠ 'no'` ⇒ **throw** `signingFailed('off-node')` (ADR-447).
    - **Capability wiring**: when signing, `selectPushCapabilities` must add a **bare**
      `push-cert` to `clientWants` (only when the server advertised it). Extend
      `src/application/commands/internal/receive-pack-client.ts:33` — accept a
      `signing: boolean` flag; when true, append `'push-cert'` to `CLIENT_CAPABILITIES_PUSH`
      before intersecting. The opener sends the **bare** token (nonce stripped) — the
      negotiated `push-cert=<nonce>` must be reduced to `push-cert` for the opener caps.
    - **Envelope + payload**: `pusher-selector = resolveSigningSelector({ signingKey:
      config.user?.signingKey, keyOverride: undefined, fallbackIdent: `${name} <${email}>` })`
      (P.2 rule — same helper as Parts 3/5; the `pusher` cert line records this selector, and
      it is also the openpgp `-u`; for ssh signing the `-f` key file is
      `config.user?.signingKey`); the pusher line's `<ts> <tz>` are computed once and shared by
      `buildPushCertPayload` and `buildSignedReceivePackRequest`; `pushee =` the remote URL after
      `transport_anonymize_url` (strip any `user:pass@` userinfo; plain path/https verbatim
      — add a pure `anonymizeUrl(url)`); `updates = movers.map(toRefUpdate)`; `payload =
      buildPushCertPayload({ pusher, pushee, nonce, updates })`; `sig = await signPayload(ctx,
      payload, { format, program, selector: pusher })`; `!sig.ok` ⇒ **throw**
      `signingFailed(sig.reason, format)`; `requestBody = buildSignedReceivePackRequest({
      updates, capabilities: negotiatedCaps, armor: sig.armor, version/pusher/pushee/nonce,
      packfile: pack.bytes })` — **replacing** the `buildReceivePackRequest` call at line 312
      when signing.
    - **Send/report**: `session.exchange` (line 317) + `parseReceivePackResponse` unchanged —
      HTTP + `ssh://` both carry the cert (`session.exchange` is transport-agnostic).
- New error code (**public**): `src/domain/commands/error.ts` add `{ readonly code:
  'SIGNED_PUSH_UNSUPPORTED'; readonly remote: string }` + factory `signedPushUnsupported(remote)`;
  `src/domain/error.ts` `extractDetail` add `case 'SIGNED_PUSH_UNSUPPORTED'` ⇒
  `the receiving end does not support --signed push` (git's exact phrase). Exhaustiveness
  `never` guard forces the case.
- **Advertisement parse**: confirm `push-cert=<nonce>` survives into `adv.capabilities`
  (`parseAdvertisedRefs` → `parseCapabilities`). No change expected (Part 6 verified the
  token de-dupes); add a test at the push seam.

Byte-pins: design §P.0 (nonce advertisement shape `push-cert=<unix-ts>-<40-hex-hmac>`) and
§P.3 (the refusal / if-asked table). Interop capture via a `--receive-pack` wrapper that
`tee`s stdin + a bare server with `receive.certNonceSeed` set.

Tests: `test/unit/application/commands/push.test.ts` (extend, over a fake `GitServiceSession`
+ stub runner from Part 2), error factory/message tests, `test/integration/push-signed-
interop.test.ts` (new).

### TDD steps

- **RED** (`push.test.ts`, fake session advertising caps ± `push-cert=<nonce>`):
  - `Given push signed 'yes' and a server advertising push-cert=<nonce>, When push, Then the request body is a signed cert whose pusher/pushee/nonce match and whose opener caps include a bare 'push-cert'` (assert `session.exchange` received `buildSignedReceivePackRequest` bytes; nonce echoed verbatim).
  - `Given push signed 'yes' and a server NOT advertising push-cert, When push, Then it throws SIGNED_PUSH_UNSUPPORTED and nothing is exchanged` — isolated refusal (P.3).
  - `Given push signed 'if-asked' and no push-cert advertised, When push, Then it sends a NORMAL unsigned request (buildReceivePackRequest) and succeeds` — isolated fallback (P.3).
  - `Given push signed 'if-asked' and push-cert advertised, Then it sends a signed cert`.
  - `Given push.gpgSign 'true' in config and signed unset, Then mode resolves to 'yes'`; `Given push.gpgSign 'if-asked', Then 'if-asked'`; `Given neither, Then 'no'` (isolated tri-state mapping).
  - `Given --no-signed (signed 'no') with push.gpgSign true, Then unsigned` (per-invocation override).
  - `Given signing requested with user.signingKey set, Then the pusher line uses the key id; Given unset, Then it uses Name <email>` (both P.2 selector cases).
  - `Given a remote URL with user:pass@ userinfo, When building pushee, Then the credentials are stripped` (anonymizeUrl).
  - `Given a signer that fails during signed push, Then it throws SIGNING_FAILED and nothing is exchanged`.
  - `Given no ctx.command and mode 'yes', Then SIGNING_FAILED reason 'off-node', nothing exchanged` (ADR-447; and mode 'no' off-node still pushes unsigned).
- **RED** (error, `error.test.ts`): `Given signedPushUnsupported('origin'), Then .data is { code: 'SIGNED_PUSH_UNSUPPORTED', remote: 'origin' } and .message contains 'the receiving end does not support --signed push'`.
- **RED** (interop, `push-signed-interop.test.ts`, `skipIf(!GIT_AVAILABLE || !hasGpg)`, bare server with `receive.certNonceSeed`, `--receive-pack` capture wrapper, canned signer, shared `beforeAll`, 60s):
  - Capture the cert bytes tsgit sends and assert the P.1 framing (opener no-LF, no-caps ref lines, `0005` blanks, `push-cert-end`, flush before pack) and that the echoed nonce equals the advertised one.
  - Signed payload pin: the canned recorder's stdin equals P.2 for the pushed ref.
  - Pusher-selector both cases (signingKey set / unset).
  - Refusal: against a server with the seed **unset**, `--signed` (mode 'yes') refuses and sends nothing — co-refusal with `git push --signed` (`tryRunGit`); `--signed=if-asked` falls back to an accepted unsigned push (ref updated).
- **GREEN**: add `PushOptions.signed`, mode resolution, nonce parse, refusal/if-asked branches, `selectPushCapabilities(signing)` flag + bare-token opener, envelope build + `signPayload` + send-seam swap, `anonymizeUrl`, the error code/factory/`extractDetail` case.
- **REFACTOR**: extract mode-resolution and signer-input resolution into named helpers; keep `sendUpdates` readable with early returns; dedupe the format/program/selector helper shared with Parts 3/5.

### Gate

`npx vitest run test/unit/application/commands/push.test.ts test/unit/application/commands/internal/receive-pack-client.test.ts test/unit/domain/commands/error.test.ts test/unit/domain/error.test.ts test/integration/push-signed-interop.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/commands/push.ts src/application/commands/internal/receive-pack-client.ts src/domain/commands/error.ts src/domain/error.ts test/unit/application/commands/push.test.ts test/integration/push-signed-interop.test.ts` (then `npm run docs:json` + commit `reports/api.json`)

### Commit

`feat: signed push — push certificate (push --signed / push.gpgSign)`
