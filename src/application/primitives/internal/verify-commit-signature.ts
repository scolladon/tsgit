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
import { checkAborted } from './retry-after-rescan.js';
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

/** The rows of git's status table that name a signature: the check string (with its trailing space), the result, and whether a signer follows the key. */
const SIGNATURE_STATUSES: ReadonlyArray<readonly [string, SignatureResult, boolean]> = [
  ['GOODSIG ', 'G', true],
  ['BADSIG ', 'B', true],
  ['ERRSIG ', 'E', false],
  ['EXPSIG ', 'X', true],
  ['EXPKEYSIG ', 'Y', true],
  ['REVKEYSIG ', 'R', true],
];

const VALIDSIG_STATUS = 'VALIDSIG ';
const TRUST_STATUS = 'TRUST_';

const TRUST_LEVELS: ReadonlyMap<string, SignatureTrust> = new Map([
  ['UNDEFINED', 'undefined'],
  ['NEVER', 'never'],
  ['MARGINAL', 'marginal'],
  ['FULLY', 'fully'],
  ['ULTIMATE', 'ultimate'],
]);

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
  } catch {
    // An abort that made the spawn throw is raised by the caller's post-spawn `checkAborted`.
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
    checkAborted(ctx);
    const result = await spawnOrNothing(ctx, runner, [program, args], stdin);
    checkAborted(ctx);
    if (result === undefined || isCannotExec(result.exitCode)) return CANNOT_EXEC;
    return {
      exitCode: result.exitCode,
      stdout: DECODER.decode(result.stdout ?? EMPTY),
      stderr: DECODER.decode(result.stderr ?? EMPTY),
    };
  };

const indexOrEnd = (text: string, char: string, from: number): number => {
  const at = text.indexOf(char, from);
  return at < 0 ? text.length : at;
};

/** A cursor into the status text, with what was read so far. */
interface StatusScan {
  readonly verdict: SignatureVerdict;
  readonly signed: boolean;
  readonly at: number;
}

/** git resumes one character past the start of the signer it read, so an empty signer swallows the next line. */
const readSigner = (text: string, keyEnd: number, resume: number): readonly [string, number] => {
  if (text[keyEnd] !== ' ') return ['', resume];
  return [
    text.slice(keyEnd + 1, indexOrEnd(text, '\n', keyEnd + 1)),
    indexOrEnd(text, '\n', keyEnd + 2),
  ];
};

/** git's key read: up to the next space, newlines included. */
const signatureStep = (
  scan: StatusScan,
  text: string,
  from: number,
  [, result, withSigner]: (typeof SIGNATURE_STATUSES)[number],
): StatusScan | undefined => {
  if (scan.signed) return undefined;
  const keyEnd = indexOrEnd(text, ' ', from);
  const [signer, at] = withSigner ? readSigner(text, keyEnd, scan.at) : ['', scan.at];
  const verdict = { ...scan.verdict, result, key: text.slice(from, keyEnd), signer };
  return { verdict, signed: true, at };
};

/** The fingerprint runs to the next space, newlines included; the primary key is whatever follows the ninth space of the line that follows. */
const validSigStep = (scan: StatusScan, text: string, from: number): StatusScan => {
  const fingerprintEnd = indexOrEnd(text, ' ', from);
  const line = text.slice(fingerprintEnd, indexOrEnd(text, '\n', fingerprintEnd));
  const verdict = {
    ...scan.verdict,
    fingerprint: text.slice(from, fingerprintEnd),
    primaryKeyFingerprint: line.split(' ').slice(VALIDSIG_PRIMARY_FIELD).join(' '),
  };
  return { ...scan, verdict };
};

const trustStep = (scan: StatusScan, text: string, from: number): StatusScan | undefined => {
  const end = Math.min(indexOrEnd(text, ' ', from), indexOrEnd(text, '\n', from));
  const trust = TRUST_LEVELS.get(text.slice(from, end));
  return trust === undefined ? undefined : { ...scan, verdict: { ...scan.verdict, trust } };
};

/** One status line at `start`; `undefined` is git's `goto error`. The scan resumes at the next newline unless a signer was read. */
const statusStep = (scan: StatusScan, text: string, start: number): StatusScan | undefined => {
  if (!text.startsWith(GNUPG_PREFIX, start)) {
    return { ...scan, at: indexOrEnd(text, '\n', start + 1) };
  }
  const from = start + GNUPG_PREFIX.length;
  const lineEnd = { ...scan, at: indexOrEnd(text, '\n', from + 1) };
  const signature = SIGNATURE_STATUSES.find(([check]) => text.startsWith(check, from));
  if (signature !== undefined) {
    return signatureStep(lineEnd, text, from + signature[0].length, signature);
  }
  if (text.startsWith(VALIDSIG_STATUS, from)) {
    return validSigStep(lineEnd, text, from + VALIDSIG_STATUS.length);
  }
  if (text.startsWith(TRUST_STATUS, from)) {
    return trustStep(lineEnd, text, from + TRUST_STATUS.length);
  }
  return lineEnd;
};

/** git's `error:` label: a refused status leaves an `E` with nothing but the trust read so far. */
const refused = (verdict: SignatureVerdict): SignatureVerdict => ({
  ...verdict,
  result: 'E',
  key: '',
  signer: '',
  fingerprint: '',
  primaryKeyFingerprint: '',
});

/** git's `parse_gpg_output`: one signature status at most; a malformed or repeated one refuses the lot. */
const parseGpgStatus = (status: string, output: string): SignatureVerdict => {
  let scan: StatusScan = { verdict: { ...NOT_VERIFIED, output }, signed: false, at: 0 };
  while (scan.at < status.length) {
    if (status[scan.at] === '\n') {
      scan = { ...scan, at: scan.at + 1 };
      continue;
    }
    const next = statusStep(scan, status, scan.at);
    if (next === undefined) return refused(scan.verdict);
    scan = next;
  }
  return scan.verdict;
};

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
const SSH_PRINCIPAL_END = ' with ';
const SSH_KEY_MARKER = 'key ';

/** git's own `isspace` leaves out the vertical tab and the form feed. */
const TRAILING_SPACE = /[ \t\r]+$/;

const firstLine = (text: string): string =>
  text.slice(0, indexOrEnd(text, '\n', 0)).replace(TRAILING_SPACE, '');

/** git's `parse_ssh_output`: "Good "git" signature [for <principal>] with <algo> key <fingerprint>". */
const parseSshOutput = (tool: ToolRun): SignatureVerdict => {
  const output = tool.stdout + tool.stderr;
  const line = firstLine(tool.stdout);
  const withPrincipal = line.startsWith(SSH_GOOD_FOR);
  if (!withPrincipal && !line.startsWith(SSH_GOOD_WITH)) return { ...BAD_SSH, output };
  const body = line.slice((withPrincipal ? SSH_GOOD_FOR : SSH_GOOD_WITH).length);
  const principalEnd = body.lastIndexOf(SSH_PRINCIPAL_END);
  if (withPrincipal && principalEnd < 0) return { ...BAD_SSH, output };
  const algorithm = withPrincipal ? body.slice(principalEnd + SSH_PRINCIPAL_END.length) : body;
  const keyAt = algorithm.indexOf(SSH_KEY_MARKER);
  const fingerprint = keyAt < 0 ? '' : algorithm.slice(keyAt + SSH_KEY_MARKER.length);
  return {
    ...NOT_VERIFIED,
    result: fingerprint === '' ? 'B' : 'G',
    trust: withPrincipal ? 'fully' : 'undefined',
    signer: withPrincipal ? body.slice(0, principalEnd) : '',
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
  const verdict = parseSshOutput(tool);
  if (tool.exitCode !== 0) return verdict;
  return { ...verdict, output: tool.stdout + principalsStderr + NO_PRINCIPAL_NOTICE + tool.stderr };
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
  return parseSshOutput(verified);
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
