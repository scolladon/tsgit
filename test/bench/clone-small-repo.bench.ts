/**
 * Bench scenario: full `clone` against a local `git-http-backend` CGI,
 * comparing tsgit (`openRepository → repo.clone → repo.dispose`) against
 * `isomorphic-git.clone`. Both libraries clone the same committed
 * fixture (`test/fixtures/clone-source/source.git`) so the comparison
 * is apples-to-apples.
 *
 * Lifecycle:
 *  - The `http.Server` is booted once in the scenario body and closed in
 *  `afterAll`. Per-iter server boot would dominate the measurement.
 *  - Each iter mkdtemps a fresh target dir; tmpdirs are collected and
 *  rm'd in bulk via `afterAll` so cleanup time does not enter the
 *  sampled distribution.
 *
 * Skip semantics: same gates as the integration test — Stryker sandbox,
 * missing `git-http-backend`, and missing fixture all skip the suite.
 */

import * as fs from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import * as git from 'isomorphic-git';
import gitHttp from 'isomorphic-git/http/node';
import { afterAll } from 'vitest';

import { openRepository } from '../../src/index.node.js';
import { benchScenario } from './support/bench-dsl.js';
import { findGitHttpBackend, startGitHttpBackend } from './support/http-backend-server.js';

const FIXTURE_DIR = path.resolve(import.meta.dirname, '../fixtures/clone-source');
const SOURCE_GIT = path.join(FIXTURE_DIR, 'source.git');

// Stryker sets `STRYKER_MUTANT_ID` for every mutant run. Substring-matching
// the cwd against `.stryker-tmp` is brittle (custom sandbox dirs, CI paths)
// — the env var is the authoritative signal.
const RUNNING_UNDER_STRYKER = process.env.STRYKER_MUTANT_ID !== undefined;
const GIT_HTTP_BACKEND_AVAILABLE = findGitHttpBackend() !== undefined;
const FIXTURE_AVAILABLE = ((): boolean => {
  try {
    fs.accessSync(SOURCE_GIT);
    return true;
  } catch {
    return false;
  }
})();

const SKIP = RUNNING_UNDER_STRYKER || !GIT_HTTP_BACKEND_AVAILABLE || !FIXTURE_AVAILABLE;

benchScenario(
  'Given a local git-http-backend serving a 5-commit repo',
  'When clone() fetches the full pack, Then compare tsgit against isomorphic-git',
  async () => {
    const server = await startGitHttpBackend({ projectRoot: FIXTURE_DIR });
    const url = `http://127.0.0.1:${server.port}/source.git`;
    const tmpdirs: string[] = [];
    afterAll(async () => {
      await Promise.all(tmpdirs.map((d) => rm(d, { recursive: true, force: true })));
      await server.close();
    });

    const sut = async (): Promise<void> => {
      const cwd = await mkdtemp(path.join(os.tmpdir(), 'tsgit-bench-clone-'));
      tmpdirs.push(cwd);
      const repo = await openRepository({
        cwd,
        allowInsecureHttp: true,
        config: {
          allowInsecure: true,
          allowPrivateNetworks: true,
          dnsResolver: async () => ['127.0.0.1'],
        },
      });
      try {
        await repo.clone({ url });
      } finally {
        await repo.dispose();
      }
    };
    return {
      sut,
      baseline: async (): Promise<void> => {
        const dir = await mkdtemp(path.join(os.tmpdir(), 'iso-bench-clone-'));
        tmpdirs.push(dir);
        await git.clone({ fs, http: gitHttp, dir, url, singleBranch: true });
      },
    };
  },
  { skip: SKIP },
);
