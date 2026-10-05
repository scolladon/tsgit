/**
 * Cross-tool interop — push under `report-status-v2`. A receiver whose
 * `proc-receive` hook takes `refs/for/<branch>` (the AGit flow) answers one
 * command with `option` lines naming the refs it really stored, and git
 * reports and tracks each of those under its own name and ids. tsgit pushes to
 * a peer served by `git http-backend`, git to a twin over a local path, each
 * from its own clone, both peers running the same hook.
 *
 * @proves
 *   surface:        push
 *   bucket:         cross-tool-interop
 *   unique:         push reports and tracks the refs a proc-receive hook rewrites, as git does
 */
import { chmodSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createNodeContext } from '../../src/adapters/node/node-adapter.js';
import { push } from '../../src/application/commands/push.js';
import { backendTransport } from './http-backend-transport.js';
import { GIT_AVAILABLE, git, runGit } from './interop-helpers.js';

const PEER_URL = 'https://example.com/peer.git';
const EXECUTABLE = 0o755;
/**
 * Stores every `refs/for/<b>` command as `refs/heads/topic` and reports it
 * twice — the second time as `refs/heads/other`, force-updated, with no ids.
 */
const PROC_RECEIVE_HOOK = [
  '#!/usr/bin/env node',
  "import { execFileSync } from 'node:child_process';",
  "import { readSync, writeSync } from 'node:fs';",
  'const readExact = (n) => {',
  '  const buf = Buffer.alloc(n);',
  '  for (let got = 0; got < n; ) {',
  '    const r = readSync(0, buf, got, n - got, null);',
  "    if (r === 0) throw new Error('eof');",
  '    got += r;',
  '  }',
  '  return buf;',
  '};',
  'const readPkt = () => {',
  '  const len = Number.parseInt(readExact(4).toString(), 16);',
  "  return len === 0 ? null : readExact(len - 4).toString().replace(/\\n$/, '');",
  '};',
  'const pkt = (s) => {',
  '  const b = Buffer.from(s + "\\n");',
  "  writeSync(1, (b.length + 4).toString(16).padStart(4, '0'));",
  '  writeSync(1, b);',
  '};',
  'while (readPkt() !== null);',
  'pkt("version=1\\0");',
  "writeSync(1, '0000');",
  'const cmds = [];',
  "for (let l = readPkt(); l !== null; l = readPkt()) cmds.push(l.split(' '));",
  'for (const [oldId, newId, ref] of cmds) {',
  "  execFileSync('git', ['update-ref', 'refs/heads/topic', newId]);",
  '  pkt("ok " + ref);',
  "  pkt('option refname refs/heads/topic');",
  '  pkt("option old-oid " + oldId);',
  '  pkt("option new-oid " + newId);',
  '  pkt("ok " + ref);',
  "  pkt('option refname refs/heads/other');",
  "  pkt('option forced-update');",
  '}',
  "writeSync(1, '0000');",
  '',
].join('\n');

let root: string;

beforeAll(() => {
  if (!GIT_AVAILABLE) return;
  root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'tsgit-interop-push-v2-')));
});

afterAll(() => {
  if (root !== undefined) rmSync(root, { recursive: true, force: true });
});

/** A bare peer per tool running the hook, and a clone per tool one commit ahead of it. */
const setUp = (): { readonly ours: string; readonly theirs: string; readonly peerRoot: string } => {
  const base = path.join(root, 'base');
  runGit(['init', '-q', '-b', 'main', base]);
  runGit(['-C', base, 'commit', '-q', '--allow-empty', '-m', 'a']);
  const peerRoot = path.join(root, 'peer');
  for (const bare of ['peer.git', 'twin.git']) {
    const peer = path.join(peerRoot, bare);
    runGit(['clone', '-q', '--bare', base, peer]);
    runGit(['-C', peer, 'config', 'receive.procReceiveRefs', 'refs/for']);
    const hook = path.join(peer, 'hooks', 'proc-receive');
    writeFileSync(hook, PROC_RECEIVE_HOOK);
    chmodSync(hook, EXECUTABLE);
  }
  runGit(['-C', path.join(peerRoot, 'peer.git'), 'config', 'http.receivepack', 'true']);
  const ours = path.join(root, 'ours');
  const theirs = path.join(root, 'theirs');
  for (const [dir, url] of [
    [ours, PEER_URL],
    [theirs, path.join(peerRoot, 'twin.git')],
  ] as const) {
    runGit(['clone', '-q', base, dir]);
    runGit(['-C', dir, 'config', 'remote.origin.url', url]);
    runGit(['-C', dir, 'commit', '-q', '--allow-empty', '-m', 'b']);
  }
  return { ours, theirs, peerRoot };
};

/** The clone's tracking refs, its own tip written as `TIP` so two clones compare. */
const trackingRefs = (dir: string): string => {
  const tip = git(dir, 'rev-parse', 'HEAD').trim();
  return git(dir, 'for-each-ref', '--format=%(refname) %(objectname)', 'refs/remotes').replaceAll(
    tip,
    'TIP',
  );
};

/** The destination of each ref `git push --porcelain` reports pushed. */
const porcelainRefs = (porcelain: string): ReadonlyArray<string | undefined> =>
  porcelain
    .split('\n')
    .filter((line) => line.startsWith('*'))
    .map((line) => line.split('\t')[1]?.split(':')[1]);

describe.skipIf(!GIT_AVAILABLE)('push report-status-v2 interop', () => {
  describe('Given peers whose proc-receive hook rewrites refs/for/main into two refs', () => {
    describe('When both tools push HEAD to refs/for/main', () => {
      it('Then the reported refs and the tracking refs agree', async () => {
        // Arrange
        const { ours, theirs, peerRoot } = setUp();
        const ctx = {
          ...createNodeContext({ workDir: ours }),
          transport: backendTransport(peerRoot),
        };
        const ourTip = git(ours, 'rev-parse', 'HEAD').trim();
        const sut = push;

        // Act
        const result = await sut(ctx, { remote: 'origin', refspecs: ['HEAD:refs/for/main'] });

        // Assert
        const porcelain = git(theirs, 'push', '--porcelain', 'origin', 'HEAD:refs/for/main');
        expect(result.pushedRefs.map((ref) => ref.name)).toEqual(porcelainRefs(porcelain));
        expect(result.pushedRefs.map((ref) => [ref.newId, ref.forcedUpdate])).toEqual([
          [ourTip, undefined],
          [ourTip, true],
        ]);
        expect(trackingRefs(ours)).toBe(trackingRefs(theirs));
      });
    });
  });
});
