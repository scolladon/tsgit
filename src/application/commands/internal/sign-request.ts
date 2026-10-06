import { signingFailed } from '../../../domain/commands/error.js';
import type { Commit, CommitData } from '../../../domain/objects/commit.js';
import {
  type AuthorIdentity,
  type ObjectId,
  serializeCommitContent,
} from '../../../domain/objects/index.js';
import type { Context } from '../../../ports/context.js';
import type { ParsedConfig } from '../../primitives/config-read.js';
import {
  resolveSigningSelector,
  type SignRequest,
  signPayload,
} from '../../primitives/sign-payload.js';

/**
 * Resolve the signer invocation from config — the openpgp `-u` selector
 * falls back through override → `user.signingKey` → the identity string;
 * the ssh `-f` key-file selector has no ident fallback. Shared by commit and
 * tag signing, which both delegate to the same `gpg.*` / `user.signingKey`
 * config regardless of the object being signed.
 */
export const resolveSignRequest = (
  config: ParsedConfig,
  identity: AuthorIdentity,
  signKey: string | undefined,
): SignRequest => {
  const format = config.gpg?.format ?? 'openpgp';
  const program = format === 'ssh' ? config.gpg?.ssh?.program : config.gpg?.program;
  const selector =
    format === 'ssh'
      ? (signKey ?? config.user?.signingKey ?? '')
      : resolveSigningSelector({
          ...(config.user?.signingKey !== undefined ? { signingKey: config.user.signingKey } : {}),
          ...(signKey !== undefined ? { keyOverride: signKey } : {}),
          fallbackIdent: `${identity.name} <${identity.email}>`,
        });
  return { format, selector, ...(program !== undefined ? { program } : {}) };
};

/**
 * Sign `payload` through `signPayload`, mapping any refusal to the faithful
 * `SIGNING_FAILED` error — off-node omits the format (no signer was ever
 * attempted), any other refusal reports the format that was attempted.
 * Callers must not proceed to write an object when this throws.
 */
export const signOrThrow = async (
  ctx: Context,
  payload: Uint8Array,
  request: SignRequest,
): Promise<string> => {
  const result = await signPayload(ctx, payload, request);
  if (!result.ok) {
    throw result.reason === 'off-node'
      ? signingFailed(result.reason)
      : signingFailed(result.reason, request.format);
  }
  return result.armor;
};

/**
 * Sign the unsigned commit payload (the commit object without a `gpgsig`
 * header) as its committer. Throws `SIGNING_FAILED` atomically on any signer
 * refusal — the caller must not write the commit when this throws.
 */
export const signCommitData = async (
  ctx: Context,
  config: ParsedConfig,
  data: CommitData,
  signKey: string | undefined,
): Promise<string> => {
  const request = resolveSignRequest(config, data.committer, signKey);
  const unsigned: Commit = { type: 'commit', id: '' as ObjectId, data };
  const armor = await signOrThrow(ctx, serializeCommitContent(unsigned), request);
  // Signers end their armor with a newline the gpgsig header encoder would read as an extra line.
  return armor.endsWith('\n') ? armor.slice(0, -1) : armor;
};
