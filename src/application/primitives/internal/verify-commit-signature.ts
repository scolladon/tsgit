/**
 * git's `check_signature`: verify a detached commit signature by running the
 * system verifier (`gpg`, `gpgsm`, `ssh-keygen`) through `ctx.command`, by
 * argv with no shell between, its stderr captured through a pipe. The
 * signature is staged in a transient file, created exclusively, because the
 * verifiers read it by path; the file is removed on every exit. Its name is
 * git's `.git_vtag_tmpXXXXXX`, but its place is not: git creates it in
 * `$TMPDIR`, tsgit in the git dir, the only place its `FileSystem` reaches —
 * so a read-only git dir refuses verification that git performs.
 *
 * @writes
 *   surface: verifyBuffer
 *   kind:    equivalent-under-readback
 *   format:  detached-signature-buffer
 */
import type { CommandRunner } from '../../../ports/command-runner.js';
import type { Context } from '../../../ports/context.js';
import type { ParsedConfig } from '../config-read.js';
import { getSpawnCwd } from '../path-layout.js';
import { DEFAULT_OPENPGP_PROGRAM, DEFAULT_SSH_PROGRAM } from '../sign-payload.js';
import { removeIgnoringMissing, stageTempFile } from './stage-temp-file.js';

/**
 * The stem of git's `mks_tempfile_t(".git_vtag_tmpXXXXXX")`, staged under the
 * git dir rather than `$TMPDIR`.
 */
const VERIFY_BUFFER_STEM = '.git_vtag_tmp';
const DEFAULT_X509_PROGRAM = 'gpgsm';
const SHELL_NOT_EXECUTABLE = 126;
const SHELL_NOT_FOUND = 127;
const GNUPG_PREFIX = '[GNUPG:] ';
const VALIDSIG_PRIMARY_FIELD = 9;
const DECODER = new TextDecoder();
const NO_PRINCIPAL_NOTICE = 'No principal matched.\n';
const SSH_USAGE_MARKER = 'usage:';
const SSH_GOOD_FOR = 'Good "git" signature for ';
const SSH_GOOD_WITH = 'Good "git" signature with ';
const SSH_GOOD_PREFIX = 'Good';

export type SignatureResult = 'G' | 'B' | 'E' | 'X' | 'Y' | 'R' | 'N';
export type SignatureTrust = 'undefined' | 'never' | 'marginal' | 'fully' | 'ultimate';

/** git's `signature_check`: the raw verifier outcome, before any display mapping. */
export interface SignatureVerdict {
  readonly result: SignatureResult;
  readonly trust: SignatureTrust;
  readonly signer: string;
  readonly key: string;
  readonly fingerprint: string;
  readonly primaryKeyFingerprint: string;
  /** The verifier's diagnostic output (git's `sigc->output`). */
  readonly output: string;
}

export interface VerifyCommitSignatureInput {
  /** The signed bytes (the commit minus its signature header). */
  readonly payload: Uint8Array;
  /** The armored detached signature. */
  readonly signature: string;
  readonly gpg?: ParsedConfig['gpg'];
}

const NOT_VERIFIED: SignatureVerdict = {
  result: 'N',
  trust: 'undefined',
  signer: '',
  key: '',
  fingerprint: '',
  primaryKeyFingerprint: '',
  output: '',
};

const STATUS_RESULTS: Readonly<Record<string, SignatureResult>> = {
  GOODSIG: 'G',
  BADSIG: 'B',
  ERRSIG: 'E',
  EXPSIG: 'X',
  EXPKEYSIG: 'Y',
  REVKEYSIG: 'R',
};

const STATUS_TRUSTS: Readonly<Record<string, SignatureTrust>> = {
  TRUST_UNDEFINED: 'undefined',
  TRUST_NEVER: 'never',
  TRUST_MARGINAL: 'marginal',
  TRUST_FULLY: 'fully',
  TRUST_ULTIMATE: 'ultimate',
};

const KEY_ONLY_STATUSES: ReadonlySet<string> = new Set(['ERRSIG']);

interface ToolRun {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

type RunTool = (
  program: string,
  args: ReadonlyArray<string>,
  stdin?: Uint8Array,
) => Promise<ToolRun>;

const CANNOT_EXEC: ToolRun = { exitCode: -1, stdout: '', stderr: '' };

const spawnOrNothing = async (
  ctx: Context,
  runner: CommandRunner,
  [command, args]: readonly [string, ReadonlyArray<string>],
  stdin: Uint8Array | undefined,
) => {
  try {
    return await runner.run({
      command,
      args,
      stderr: 'capture',
      cwd: getSpawnCwd(ctx.layout),
      env: { GIT_DIR: ctx.layout.gitDir },
      ...(stdin !== undefined ? { stdin } : {}),
      ...(ctx.signal !== undefined ? { signal: ctx.signal } : {}),
    });
  } catch (error) {
    if (ctx.signal?.aborted === true) throw error;
    return undefined;
  }
};

const isCannotExec = (exitCode: number): boolean =>
  exitCode === SHELL_NOT_FOUND || exitCode === SHELL_NOT_EXECUTABLE;

const EMPTY = new Uint8Array(0);

/**
 * An aborted runner resolves with the signal exit rather than rejecting, so the
 * signal is checked around every spawn: a cancelled verification stops at once
 * instead of spawning its next verifier and reporting a bad signature.
 */
const makeRunTool =
  (ctx: Context, runner: CommandRunner): RunTool =>
  async (program, args, stdin) => {
    ctx.signal?.throwIfAborted();
    const result = await spawnOrNothing(ctx, runner, [program, args], stdin);
    ctx.signal?.throwIfAborted();
    if (result === undefined || isCannotExec(result.exitCode)) return CANNOT_EXEC;
    return {
      exitCode: result.exitCode,
      stdout: DECODER.decode(result.stdout ?? EMPTY),
      stderr: DECODER.decode(result.stderr ?? EMPTY),
    };
  };

const splitFirst = (text: string, separator: string): readonly [string, string] => {
  const at = text.indexOf(separator);
  return at < 0 ? [text, ''] : [text.slice(0, at), text.slice(at + separator.length)];
};

const applyStatusLine = (verdict: SignatureVerdict, line: string): SignatureVerdict => {
  if (!line.startsWith(GNUPG_PREFIX)) return verdict;
  const [keyword, rest] = splitFirst(line.slice(GNUPG_PREFIX.length), ' ');
  const result = STATUS_RESULTS[keyword];
  if (result !== undefined) {
    const [key, signer] = splitFirst(rest, ' ');
    return { ...verdict, result, key, signer: KEY_ONLY_STATUSES.has(keyword) ? '' : signer };
  }
  const trust = STATUS_TRUSTS[keyword];
  if (trust !== undefined) return { ...verdict, trust };
  if (keyword !== 'VALIDSIG') return verdict;
  const fields = rest.split(' ');
  return {
    ...verdict,
    fingerprint: splitFirst(rest, ' ')[0],
    primaryKeyFingerprint: fields[VALIDSIG_PRIMARY_FIELD] ?? '',
  };
};

/** git's `parse_gpg_output`: later status lines override earlier ones. */
const parseGpgStatus = (status: string, output: string): SignatureVerdict =>
  status.split('\n').reduce(applyStatusLine, { ...NOT_VERIFIED, output });

const verifyWithGpgFamily = async (
  run: RunTool,
  program: string,
  sigPath: string,
  payload: Uint8Array,
): Promise<SignatureVerdict> => {
  const tool = await run(
    program,
    ['--keyid-format=long', '--status-fd=1', '--verify', sigPath, '-'],
    payload,
  );
  return parseGpgStatus(tool.stdout, tool.stderr);
};

const BAD_SSH: SignatureVerdict = { ...NOT_VERIFIED, result: 'B', trust: 'never' };

/** git's `parse_ssh_output`: "Good "git" signature [for <principal>] with <algo> key <fingerprint>". */
const parseSshOutput = (output: string): SignatureVerdict => {
  const [line] = splitFirst(output, '\n');
  const withPrincipal = line.startsWith(SSH_GOOD_FOR);
  if (!withPrincipal && !line.startsWith(SSH_GOOD_WITH)) return { ...BAD_SSH, output };
  const body = line.slice((withPrincipal ? SSH_GOOD_FOR : SSH_GOOD_WITH).length);
  const [signer, keyPart] = withPrincipal ? splitFirst(body, ' with ') : ['', body];
  const [, fingerprint] = splitFirst(keyPart, ' key ');
  return {
    ...NOT_VERIFIED,
    result: 'G',
    trust: withPrincipal ? 'fully' : 'undefined',
    signer,
    key: fingerprint,
    fingerprint,
    output,
  };
};

const sshVerifyArgs = (
  sigPath: string,
  allowed: string,
  principal: string,
  revocation?: string,
): ReadonlyArray<string> => [
  ...['-Y', 'verify', '-n', 'git', '-f', allowed, '-I', principal, '-s', sigPath],
  ...(revocation !== undefined ? ['-r', revocation] : []),
];

const verifyPrincipals = async (
  run: RunTool,
  program: string,
  principals: readonly string[],
  buildArgs: (principal: string) => ReadonlyArray<string>,
  payload: Uint8Array,
): Promise<ToolRun> => {
  let last: ToolRun = CANNOT_EXEC;
  for (const principal of principals) {
    last = await run(program, buildArgs(principal), payload);
    if (last.exitCode === 0 && last.stdout.startsWith(SSH_GOOD_PREFIX)) break;
  }
  return last;
};

const verifyWithoutPrincipal = async (
  run: RunTool,
  program: string,
  sigPath: string,
  payload: Uint8Array,
  principalsStderr: string,
): Promise<SignatureVerdict> => {
  const tool = await run(program, ['-Y', 'check-novalidate', '-n', 'git', '-s', sigPath], payload);
  if (tool.exitCode !== 0) return parseSshOutput(tool.stdout + tool.stderr);
  const verdict = parseSshOutput(
    tool.stdout + principalsStderr + NO_PRINCIPAL_NOTICE + tool.stderr,
  );
  return { ...verdict, signer: '', trust: 'undefined' };
};

const verifyWithSsh = async (
  run: RunTool,
  gpg: NonNullable<ParsedConfig['gpg']>['ssh'],
  sigPath: string,
  payload: Uint8Array,
): Promise<SignatureVerdict> => {
  const allowed = gpg?.allowedSignersFile;
  if (allowed === undefined) return NOT_VERIFIED;
  const program = gpg?.program ?? DEFAULT_SSH_PROGRAM;
  const found = await run(program, ['-Y', 'find-principals', '-f', allowed, '-s', sigPath]);
  if (found.exitCode !== 0 && found.stderr.includes(SSH_USAGE_MARKER)) return NOT_VERIFIED;
  const principals = found.exitCode === 0 ? found.stdout.split('\n').filter((p) => p !== '') : [];
  if (principals.length === 0) {
    return verifyWithoutPrincipal(run, program, sigPath, payload, found.stderr);
  }
  const verified = await verifyPrincipals(
    run,
    program,
    principals,
    (principal) => sshVerifyArgs(sigPath, allowed, principal, gpg?.revocationFile),
    payload,
  );
  return parseSshOutput(verified.stdout + verified.stderr);
};

type SignatureFormat = 'openpgp' | 'x509' | 'ssh';

const SIGNATURE_MARKERS: ReadonlyArray<readonly [string, SignatureFormat]> = [
  ['-----BEGIN PGP SIGNATURE-----', 'openpgp'],
  ['-----BEGIN PGP MESSAGE-----', 'openpgp'],
  ['-----BEGIN SIGNED MESSAGE-----', 'x509'],
  ['-----BEGIN SSH SIGNATURE-----', 'ssh'],
];

const detectFormat = (signature: string): SignatureFormat | undefined =>
  SIGNATURE_MARKERS.find(([marker]) => signature.startsWith(marker))?.[1];

const dispatch = (
  run: RunTool,
  format: SignatureFormat,
  input: VerifyCommitSignatureInput,
  sigPath: string,
): Promise<SignatureVerdict> => {
  if (format === 'ssh') return verifyWithSsh(run, input.gpg?.ssh, sigPath, input.payload);
  const program =
    format === 'x509' ? DEFAULT_X509_PROGRAM : (input.gpg?.program ?? DEFAULT_OPENPGP_PROGRAM);
  return verifyWithGpgFamily(run, program, sigPath, input.payload);
};

/**
 * Without a `CommandRunner` (browser) or a recognisable signature the verdict
 * is git's unsigned/cannot-exec outcome: `N`, empty fields, `undefined` trust.
 * The signature is staged under the git dir, where git uses `$TMPDIR`: a git
 * dir that refuses the write refuses verification.
 */
export const verifyCommitSignature = async (
  ctx: Context,
  input: VerifyCommitSignatureInput,
): Promise<SignatureVerdict> => {
  const runner = ctx.command;
  const format = detectFormat(input.signature);
  if (runner === undefined || format === undefined) return NOT_VERIFIED;
  const sigPath = await stageTempFile(
    ctx,
    `${ctx.layout.gitDir}/${VERIFY_BUFFER_STEM}`,
    new TextEncoder().encode(input.signature),
  );
  try {
    return await dispatch(makeRunTool(ctx, runner), format, input, sigPath);
  } finally {
    await removeIgnoringMissing(ctx, sigPath);
  }
};
