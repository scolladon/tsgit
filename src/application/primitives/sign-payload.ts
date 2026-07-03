import { TsgitError } from '../../domain/error.js';
import type { CommandRunner } from '../../ports/command-runner.js';
import type { Context } from '../../ports/context.js';

const DEFAULT_OPENPGP_PROGRAM = 'gpg';
const DEFAULT_SSH_PROGRAM = 'ssh-keygen';
const SSH_SIGNING_BUFFER_PATH_SUFFIX = 'GIT_SIGNING_BUFFER';

const EMPTY = new Uint8Array(0);
const DECODER = new TextDecoder();

const ARMOR_PATTERN =
  /-----BEGIN (?:PGP|SSH) SIGNATURE-----[\s\S]*-----END (?:PGP|SSH) SIGNATURE-----/;

export type SignPayloadResult =
  | { readonly ok: true; readonly armor: string }
  | { readonly ok: false; readonly reason: 'off-node' | 'unsupported-format' | 'signer-failed' };

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

const isFileNotFound = (error: unknown): boolean =>
  error instanceof TsgitError && error.data.code === 'FILE_NOT_FOUND';

const removeIgnoringMissing = async (ctx: Context, path: string): Promise<void> => {
  try {
    await ctx.fs.rm(path);
  } catch (error) {
    if (!isFileNotFound(error)) throw error;
  }
};

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
    command: `${program} --status-fd=2 -bsau ${req.selector}`,
    cwd: ctx.layout.workDir,
    env: { GIT_DIR: ctx.layout.gitDir },
    stdin: payload,
    ...(ctx.signal !== undefined ? { signal: ctx.signal } : {}),
  });
  const armor = DECODER.decode(result.stdout ?? EMPTY);
  return result.exitCode === 0 && isWellFormedArmor(armor)
    ? { ok: true, armor }
    : { ok: false, reason: 'signer-failed' };
};

const signWithSsh = async (
  ctx: Context,
  runner: CommandRunner,
  payload: Uint8Array,
  req: SignRequest,
): Promise<SignPayloadResult> => {
  const program = req.program ?? DEFAULT_SSH_PROGRAM;
  const tmp = `${ctx.layout.gitDir}/${SSH_SIGNING_BUFFER_PATH_SUFFIX}`;
  const sigPath = `${tmp}.sig`;
  await ctx.fs.write(tmp, payload);
  try {
    const result = await runner.run({
      command: `${program} -Y sign -n git -f ${req.selector} ${tmp}`,
      cwd: ctx.layout.workDir,
      env: { GIT_DIR: ctx.layout.gitDir },
      ...(ctx.signal !== undefined ? { signal: ctx.signal } : {}),
    });
    if (result.exitCode !== 0) {
      return { ok: false, reason: 'signer-failed' };
    }
    const armor = await readArmorIfPresent(ctx, sigPath);
    return armor !== undefined && isWellFormedArmor(armor)
      ? { ok: true, armor }
      : { ok: false, reason: 'signer-failed' };
  } finally {
    await removeIgnoringMissing(ctx, tmp);
    await removeIgnoringMissing(ctx, sigPath);
  }
};

/**
 * Pure(ish) signing primitive delegating to the system signer through
 * `ctx.command` — no new port. `gpg` runs stdin→stdout; `ssh-keygen` writes
 * the payload to a temp file and reads the armor back from `<file>.sig`.
 * Requesting `x509` and running with no `ctx.command` both refuse with a
 * typed reason before any spawn or temp-file write. Success requires exit 0
 * AND a well-formed armor block on the signer's output; anything else is a
 * typed `signer-failed` refusal — never a partial or silent result.
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
