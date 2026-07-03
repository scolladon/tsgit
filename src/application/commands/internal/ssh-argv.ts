import type { Service } from '../../../domain/protocol/index.js';
import { sqQuote } from '../../primitives/internal/shell-quote.js';
import { combineUserHost, type RemoteUrl } from './remote-url.js';

type SshRemoteUrl = Extract<RemoteUrl, { kind: 'ssh' }>;

const PORT_FLAG = '-p';

export { sqQuote };

/**
 * Assemble the argv passed to the resolved ssh program: `baseArgs` from
 * ssh-command resolution, the port flag (only when the URL carries an
 * explicit port — OpenSSH-only argv, no client-variant detection), the host
 * token, and the sq-quoted remote command as a single argv element. No
 * protocol-version option is ever emitted — this transport speaks v0/v1 only.
 */
export const buildSshArgs = (input: {
  readonly service: Service;
  readonly parsed: SshRemoteUrl;
  readonly baseArgs: ReadonlyArray<string>;
}): ReadonlyArray<string> => [
  ...input.baseArgs,
  ...portFlag(input.parsed.port),
  combineUserHost(input.parsed.user, input.parsed.host),
  remoteCommand(input.service, input.parsed.path),
];

const portFlag = (port: number | undefined): ReadonlyArray<string> =>
  port === undefined ? [] : [PORT_FLAG, String(port)];

const remoteCommand = (service: Service, path: string): string => `${service} ${sqQuote(path)}`;
