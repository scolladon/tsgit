/**
 * Cross-tool interop — the capability list push's first command line carries.
 * git's send-pack asks only for what it uses: `report-status`,
 * `side-band-64k`, `quiet` with no progress to show, `atomic` when asked,
 * `object-format` and `agent` when the server advertises them — never
 * `ofs-delta` or `delete-refs`, which only steer its own choices. tsgit pushes
 * to a peer served by `git http-backend`, its request captured on the way;
 * git pushes to a twin peer over a local path with `GIT_TRACE_PACKET` on.
 * git's `report-status-v2` is read as `report-status`: tsgit parses only the
 * v1 report, which a peer without a proc-receive hook answers identically.
 *
 * @proves
 *   surface:        push
 *   bucket:         cross-tool-interop
 *   unique:         push's command line requests exactly the capabilities git's send-pack requests
 */
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createNodeContext } from '../../src/adapters/node/node-adapter.js';
import { push } from '../../src/application/commands/push.js';
import type { HttpTransport } from '../../src/ports/http-transport.js';
import { backendTransport } from './http-backend-transport.js';
import { GIT_AVAILABLE, runGit, runGitEnv, tryRunGitWithExit } from './interop-helpers.js';

const PEER_URL = 'https://example.com/peer.git';
const AGENT_VALUE = /^agent=.*/;
const NUL = '\0';
const REPORT_STATUS_V2 = 'report-status-v2';

let root: string;

beforeAll(() => {
  if (!GIT_AVAILABLE) return;
  root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'tsgit-interop-push-caps-')));
});

afterAll(() => {
  if (root !== undefined) rmSync(root, { recursive: true, force: true });
});

/** The capabilities after the NUL of a request's first pkt-line, agent values masked. */
const capabilitiesOf = (firstLine: string): readonly string[] =>
  (firstLine.split(NUL)[1] ?? '')
    .trim()
    .split(' ')
    .map((capability) => capability.replace(AGENT_VALUE, 'agent=*'));

/** A transport that records the first command line of every receive-pack POST. */
const capturing = (inner: HttpTransport, lines: string[]): HttpTransport => ({
  request: async (req) => {
    if (req.method === 'POST' && req.url.endsWith('git-receive-pack') && req.body !== undefined) {
      const length = Number.parseInt(new TextDecoder().decode(req.body.subarray(0, 4)), 16);
      lines.push(new TextDecoder().decode(req.body.subarray(4, length)));
    }
    return inner.request(req);
  },
});

/** A repository with one commit on `main` and a bare peer for each tool. */
const setUp = (slug: string): { readonly dir: string; readonly peerRoot: string } => {
  const dir = path.join(root, slug);
  runGit(['init', '-q', '-b', 'main', dir]);
  runGit(['-C', dir, 'commit', '-q', '--allow-empty', '-m', 'a']);
  runGit(['-C', dir, 'remote', 'add', 'origin', PEER_URL]);
  const peerRoot = path.join(root, `${slug}-peer`);
  for (const bare of ['peer.git', 'twin.git']) {
    runGit(['init', '-q', '--bare', '-b', 'main', path.join(peerRoot, bare)]);
  }
  runGit(['-C', path.join(peerRoot, 'peer.git'), 'config', 'http.receivepack', 'true']);
  return { dir, peerRoot };
};

describe.skipIf(!GIT_AVAILABLE)('push capabilities interop', () => {
  describe.each([
    { label: 'a plain push', gitArgs: [], atomic: false },
    { label: 'an atomic push', gitArgs: ['--atomic'], atomic: true },
  ] as const)(
    'Given $label to a peer advertising every capability git does',
    ({ gitArgs, atomic }) => {
      describe('When both tools push main', () => {
        it("Then tsgit's command line requests exactly git's capabilities", async () => {
          // Arrange
          const { dir, peerRoot } = setUp(`push-caps-${atomic}`);
          const twin = path.join(peerRoot, 'twin.git');
          const traced = tryRunGitWithExit(['-C', dir, 'push', ...gitArgs, twin, 'main'], {
            env: { ...runGitEnv(), GIT_TRACE_PACKET: '1' },
          });
          const gitLine = traced.stderr.split('\n').find((line) => line.includes('push> '));
          const lines: string[] = [];
          const ctx = createNodeContext({ workDir: dir });
          const transport = capturing(backendTransport(peerRoot), lines);
          const sut = push;

          // Act
          await sut({ ...ctx, transport }, { remote: 'origin', refspecs: ['main'], atomic });

          // Assert
          // git asks for report-status-v2 where the peer offers it; tsgit reads only
          // the v1 report, which the peer answers identically unless a
          // proc-receive hook rewrites refs.
          const gitCapabilities = capabilitiesOf((gitLine ?? '').replace(/\\0/, NUL)).map(
            (capability) => (capability === REPORT_STATUS_V2 ? 'report-status' : capability),
          );
          expect(traced.exitCode).toBe(0);
          expect(lines.map(capabilitiesOf)).toEqual([gitCapabilities]);
        });
      });
    },
  );
});
