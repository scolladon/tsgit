import { TsgitError } from '../../domain/error.js';
import type { CommandRunner } from '../../ports/command-runner.js';
import type { Context } from '../../ports/context.js';
import { removeIgnoringMissing, stageTempFile } from './internal/stage-temp-file.js';
import { getSpawnCwd } from './path-layout.js';

export const DEFAULT_OPENPGP_PROGRAM = 'gpg';
export const DEFAULT_SSH_PROGRAM = 'ssh-keygen';
/** git's `mks_tempfile_t(".git_signing_buffer_tmpXXXXXX")` stem. */
const SSH_SIGNING_BUFFER_STEM = '.git_signing_buffer_tmp';

const EMPTY = new Uint8Array(0);
const DECODER = new TextDecoder();

/** The status line gpg writes once it has made a signature — git refuses to sign without it. */
const SIG_CREATED = '[GNUPG:] SIG_CREATED ';

const ARMOR_PATTERN =
  /-----BEGIN (?:PGP|SSH) SIGNATURE-----[\s\S]*-----END (?:PGP|SSH) SIGNATURE-----/;

export type SignPayloadResult =
  | { readonly ok: true; readonly armor: string }
  | { readonly ok: false; readonly reason: 'off-node' | 'unsupported-format' }
  | {
      readonly ok: false;
      readonly reason: 'signer-failed';
      /** The signer's captured stderr — what git prints with its refusal. */
      readonly output: string;
    };

export interface SignRequest {
  readonly format: 'openpgp' | 'ssh' | 'x509';
  /** `gpg.program` / `gpg.ssh.program`; a family-specific default applies when absent. */
  readonly program?: string;
  /** Resolved `-u` value (openpgp) / `-f` key-file path (ssh). */
  readonly selector: string;
}

export interface ResolveSigningSelectorInput {
  readonly signingKey?: string;
  readonly keyOverride?: string;
  readonly fallbackIdent: string;
}

/**
 * Resolves the openpgp `-u` selector / the push-cert `pusher` selector —
 * the identical `user.signingKey`-else-ident rule shared by commit, tag, and
 * push-cert signing. The ssh `-f` key-file selector has NO ident fallback and
 * is resolved by the caller directly (`keyOverride ?? signingKey`), not here.
 */
export const resolveSigningSelector = (input: ResolveSigningSelectorInput): string =>
  input.keyOverride ?? input.signingKey ?? input.fallbackIdent;

const isWellFormedArmor = (text: string): boolean => ARMOR_PATTERN.test(text);

/** git's `sign_buffer_gpg` test: a `SIG_CREATED` status line opening the status or following a newline. */
const reportsSignatureCreated = (status: string): boolean =>
  status.startsWith(SIG_CREATED) || status.includes(`\n${SIG_CREATED}`);

const signerFailed = (stderr: Uint8Array | undefined): SignPayloadResult => ({
  ok: false,
  reason: 'signer-failed',
  output: DECODER.decode(stderr ?? EMPTY),
});

const isFileNotFound = (error: unknown): boolean =>
  error instanceof TsgitError && error.data.code === 'FILE_NOT_FOUND';

const readArmorIfPresent = async (ctx: Context, path: string): Promise<string | undefined> => {
  try {
    return DECODER.decode(await ctx.fs.read(path));
  } catch (error) {
    if (isFileNotFound(error)) return undefined;
    throw error;
  }
};

const signWithOpenpgp = async (
  ctx: Context,
  runner: CommandRunner,
  payload: Uint8Array,
  req: SignRequest,
): Promise<SignPayloadResult> => {
  const program = req.program ?? DEFAULT_OPENPGP_PROGRAM;
  const result = await runner.run({
    command: program,
    args: ['--status-fd=2', '-bsau', req.selector],
    cwd: getSpawnCwd(ctx.layout),
    env: { GIT_DIR: ctx.layout.gitDir },
    stdin: payload,
    stderr: 'capture',
    ...(ctx.signal !== undefined ? { signal: ctx.signal } : {}),
  });
  const armor = DECODER.decode(result.stdout ?? EMPTY);
  const signed =
    result.exitCode === 0 &&
    reportsSignatureCreated(DECODER.decode(result.stderr ?? EMPTY)) &&
    isWellFormedArmor(armor);
  return signed ? { ok: true, armor } : signerFailed(result.stderr);
};

const signWithSsh = async (
  ctx: Context,
  runner: CommandRunner,
  payload: Uint8Array,
  req: SignRequest,
): Promise<SignPayloadResult> => {
  const program = req.program ?? DEFAULT_SSH_PROGRAM;
  const tmp = await stageTempFile(ctx, `${ctx.layout.gitDir}/${SSH_SIGNING_BUFFER_STEM}`, payload);
  const sigPath = `${tmp}.sig`;
  try {
    const result = await runner.run({
      command: program,
      args: ['-Y', 'sign', '-n', 'git', '-f', req.selector, tmp],
      cwd: getSpawnCwd(ctx.layout),
      env: { GIT_DIR: ctx.layout.gitDir },
      stderr: 'capture',
      ...(ctx.signal !== undefined ? { signal: ctx.signal } : {}),
    });
    if (result.exitCode !== 0) return signerFailed(result.stderr);
    const armor = await readArmorIfPresent(ctx, sigPath);
    return armor !== undefined && isWellFormedArmor(armor)
      ? { ok: true, armor }
      : signerFailed(result.stderr);
  } finally {
    await removeIgnoringMissing(ctx, tmp);
    await removeIgnoringMissing(ctx, sigPath);
  }
};

/**
 * Pure(ish) signing primitive delegating to the system signer through
 * `ctx.command`, by argv with no shell between, as git does. `gpg` runs
 * stdin→stdout; `ssh-keygen` reads the payload from an exclusively created
 * temp file and writes the armor beside it, to `<file>.sig`.
 * Requesting `x509` and running with no `ctx.command` both refuse with a
 * typed reason before any spawn or temp-file write. Success requires exit 0,
 * a well-formed armor block on the signer's output and — for gpg — a
 * `SIG_CREATED` status line; anything else is a typed `signer-failed` refusal
 * carrying the signer's stderr — never a partial or silent result. As in git,
 * the signer's stderr is captured: hidden on success, returned on refusal.
 */
export const signPayload = async (
  ctx: Context,
  payload: Uint8Array,
  req: SignRequest,
): Promise<SignPayloadResult> => {
  const runner = ctx.command;
  if (runner === undefined) {
    return { ok: false, reason: 'off-node' };
  }
  if (req.format === 'x509') {
    return { ok: false, reason: 'unsupported-format' };
  }
  return req.format === 'ssh'
    ? signWithSsh(ctx, runner, payload, req)
    : signWithOpenpgp(ctx, runner, payload, req);
};
